/** Cargo Mover routine — hauls specified items from one station to another.
 *
 * This routine:
 * 1. Withdraws items from source station (faction or personal storage)
 * 2. Travels to destination station
 * 3. Deposits items to destination (faction storage, personal storage, or send_gift to a bot)
 *
 * Features:
 * - Advanced detailed logging of all operations
 * - Item quantity locking for multi-bot coordination (3-4 bots can work together)
 * - Persistent activity tracking for interruption recovery
 * - Battle encounter handling with state preservation
 * - Automatic cleanup and resumption after crashes/restarts
 *
 * All configuration is done via the web UI settings.
 */
import type { Bot, Routine, RoutineContext } from "../bot.js";
import { mapStore } from "../mapstore.js";
import { getSystemBlacklist } from "../web/server.js";
import {
  ensureUndocked,
  ensureFueled,
  tryRefuel,
  repairShip,
  navigateToSystem,
  detectAndRecoverFromDeath,
  readSettings,
  writeSettings,
  logFactionActivity,
  checkAndFleeFromBattle,
  checkBattleAfterCommand,
  getBattleStatus,
  fleeFromBattle,
  getItemSize,
  maxItemsForCargo,
  type BattleState,
} from "./common.js";
import {
  logCargoActivity,
  saveLastSession,
  clearLastSession,
  getLastSession,
  startItemProgress,
  updateItemProgress,
  createMovement,
  updateMovement,
  completeMovement,
  failMovement,
  type CargoMovement,
} from "./cargoMoverActivity.js";
import {
  acquireQuantityLock,
  releaseQuantityLock,
  updateDeliveredQuantity,
  updateWithdrawnQuantity,
  updateLockActivity,
  getAvailableItemQuantity,
  getBotClaimedQuantity,
  canClaimItemQuantity,
  cleanupStaleLocks,
} from "./cargoMoverCoordination.js";
import {
  addInTransitItems,
  removeInTransitItems,
  getInTransitQuantity,
  cleanupStaleInTransit,
} from "./cargoMoverInTransit.js";

/** Simple dock function that does NOT call collectFromStorage. */
async function dockAtStation(ctx: RoutineContext): Promise<boolean> {
  const { bot } = ctx;
  if (bot.docked) return true;
  
  const dockResp = await bot.exec("dock");
  if (!dockResp.error || dockResp.error.message.includes("already")) {
    bot.docked = true;
    return true;
  }
  ctx.log("error", `Dock failed: ${dockResp.error.message}`);
  return false;
}

/** Simple undock function. */
async function undockStation(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;
  if (!bot.docked) return;
  
  await bot.exec("undock");
  bot.docked = false;
}

interface CargoMoveItem {
  itemId: string;
  itemName: string;
  quantity: number;
  category?: string;
  storageType?: 'faction' | 'personal';
  sourceBot?: string;
  totalDelivered?: number;  // Track total items delivered for this config
  totalToDeliver?: number;  // Optional target: when totalDelivered reaches this, item is considered complete
}

interface CargoMoverSettings {
  sourceStation: string;
  destinationStation: string;
  destinationStorageType: "faction" | "personal" | "send_gift";
  destinationBotName: string;
  items: CargoMoveItem[];
  personalStorageBot?: string;
  factionStorageBot?: string;
  refuelThreshold: number;
  repairThreshold: number;
}

function getCargoMoverSettings(username?: string): CargoMoverSettings {
  const all = readSettings();
  const general = all.general || {};
  const t = all.cargo_mover || {};
  const botOverrides = username ? (all[username] || {}) : {};

  const rawItems = (t.items as Array<Record<string, unknown>>) || [];
  const items: CargoMoveItem[] = rawItems
    .filter((item) => item.itemId && (item.quantity as number) >= 0)
    .map((item) => ({
      itemId: item.itemId as string,
      itemName: (item.itemName as string) || (item.itemId as string),
      quantity: (item.quantity as number) || 0,
      category: item.category as string | undefined,
      storageType: (item.storageType as 'faction' | 'personal') || 'faction',
      sourceBot: item.sourceBot as string | undefined,
      totalDelivered: item.totalDelivered as number | undefined,
      totalToDeliver: item.totalToDeliver as number | undefined,
    }));

  return {
    sourceStation: (botOverrides.sourceStation as string) ||
      (t.sourceStation as string) ||
      (general.factionStorageStation as string) ||
      "",
    destinationStation: (botOverrides.destinationStation as string) ||
      (t.destinationStation as string) ||
      "",
    destinationStorageType: (t.destinationStorageType as "faction" | "personal" | "send_gift") || "faction",
    destinationBotName: (botOverrides.destinationBotName as string) ||
      (t.destinationBotName as string) ||
      "",
    items,
    personalStorageBot: (t.personalStorageBot as string) || '',
    factionStorageBot: (t.factionStorageBot as string) || '',
    refuelThreshold: (t.refuelThreshold as number) || 50,
    repairThreshold: (t.repairThreshold as number) || 40,
  };
}

/** Resolve station ID to system ID using mapStore. */
export function resolveStationSystem(stationId: string): string | null {
  if (!stationId) return null;

  // Handle system|station format
  let stationPart = stationId;
  let systemPart: string | null = null;
  if (stationId.includes('|')) {
    const parts = stationId.split('|');
    systemPart = parts[0];
    stationPart = parts[1];
  }

  const allSystems = mapStore.getAllSystems();
  for (const [sysId, sys] of Object.entries(allSystems)) {
    // If we have a system part, only check that system
    if (systemPart && sysId !== systemPart) continue;

    for (const poi of sys.pois) {
      if (poi.id === stationPart || poi.base_id === stationPart) {
        return sysId;
      }
    }
  }
  return null;
}

/** Extract station ID from system|station format for travel commands. */
function extractStationId(stationValue: string): string {
  if (stationValue.includes('|')) {
    return stationValue.split('|')[1];
  }
  return stationValue;
}

/** Get current system for mobile stations like mobile_capital or frontier_station. */
export async function getMobileStationSystem(ctx: RoutineContext, stationId: string): Promise<string | null> {
  if (stationId !== "mobile_capital" && stationId !== "frontier_station") return null;

  const { bot } = ctx;

  // Only query when docked to avoid conflicts
  if (!bot.docked) {
    ctx.log("warn", "Cannot query mobile station location while undocked");
    return null;
  }

  const routeResp = await bot.exec("find_route", { target: stationId });
  if (routeResp.error) {
    ctx.log("error", `Failed to find route to ${stationId}: ${routeResp.error.message}`);
    return null;
  }

  const routeData = routeResp.result as any;
  if (!routeData.found) {
    ctx.log("error", `Route to ${stationId} not found`);
    return null;
  }

  return routeData.target_system;
}

interface MoveJob {
  itemId: string;
  itemName: string;
  targetQty: number;
  availableQty: number;
  storageType: 'faction' | 'personal';
  sourceSystem: string;
  sourceStation: string;
  destSystem: string;
  destStation: string;
  jumps: number;
}

function getFreeSpace(bot: Bot): number {
  if (bot.cargoMax <= 0) return 999;
  return Math.max(0, bot.cargoMax - bot.cargo);
}

/** Withdraw items from specified storage type into cargo. */
async function withdrawFromStorage(
  ctx: RoutineContext,
  itemId: string,
  quantity: number,
  storageType: 'faction' | 'personal',
): Promise<{ success: boolean; withdrawnQty: number }> {
  const { bot } = ctx;

  // Log withdrawal attempt
  logCargoActivity(bot.username, "withdraw_start", `Attempting to withdraw ${quantity}x ${itemId} from ${storageType} storage`, {
    itemId,
    itemName: bot.inventory.find(i => i.itemId === itemId)?.name || itemId,
    quantity,
    location: `${bot.system}/${bot.poi}`,
  });

  // Check how much we have in cargo before withdrawing
  const cargoBefore = bot.inventory.find((i) => i.itemId === itemId)?.quantity || 0;

  if (storageType === 'faction') {
    const inFaction = bot.factionStorage.find((i) => i.itemId === itemId);
    ctx.log("cargo", `Withdraw check: faction has ${inFaction?.quantity || 0}x ${itemId}`);
    if (!inFaction || inFaction.quantity <= 0) {
      ctx.log("error", `Withdraw from faction failed: ${itemId} not available`);
      logCargoActivity(bot.username, "withdraw_failed", `Failed to withdraw ${itemId} from faction storage: not available`, {
        itemId,
        quantity,
        location: `${bot.system}/${bot.poi}`,
        error: "Item not available in faction storage",
      });
      return { success: false, withdrawnQty: 0 };
    }
    const actualQty = Math.min(quantity, inFaction.quantity);

    // Step 1: Move from faction storage to station storage
    const factionResp = await bot.exec("storage", { action: "deposit", target: "self", item_id: itemId, quantity: actualQty, source: "faction" });
    if (factionResp.error) {
      ctx.log("error", `Failed to move ${itemId} from faction to station storage: ${factionResp.error.message}`);
      logCargoActivity(bot.username, "withdraw_failed", `Failed to move ${itemId} from faction storage: ${factionResp.error.message}`, {
        itemId,
        quantity,
        location: `${bot.system}/${bot.poi}`,
        error: factionResp.error.message,
      });
      return { success: false, withdrawnQty: 0 };
    }

    // Refresh station storage to verify the transfer
    await bot.refreshStorage();

    // Step 2: Withdraw from station storage to cargo
    const wResp = await bot.exec("withdraw_items", { item_id: itemId, quantity: actualQty });
    if (!wResp.error) {
      await bot.refreshCargo();
      const cargoAfter = bot.inventory.find((i) => i.itemId === itemId)?.quantity || 0;
      const withdrawn = Math.max(0, cargoAfter - cargoBefore);
      ctx.log("cargo", `Withdraw successful: got ${withdrawn}x ${itemId} from faction storage`);
      logCargoActivity(bot.username, "withdraw_success", `Successfully withdrew ${withdrawn}x ${itemId} from faction storage`, {
        itemId,
        itemName: inFaction.name || itemId,
        quantity: withdrawn,
        location: `${bot.system}/${bot.poi}`,
      });
      return { success: withdrawn > 0, withdrawnQty: withdrawn };
    }
    if (wResp.error.message.includes("cargo_full")) {
      // Try to parse available space from error message
      const match = wResp.error.message.match(/only (\d+) available/);
      const availableSpace = match ? parseInt(match[1], 10) : Math.max(1, Math.floor(actualQty / 2));
      if (availableSpace > 0) {
        // Step 1: Move partial amount from faction to station storage
        const smallFactionResp = await bot.exec("storage", { action: "deposit", target: "self", item_id: itemId, quantity: availableSpace, source: "faction" });
        if (!smallFactionResp.error) {
          // Refresh station storage
          await bot.refreshStorage();
          // Step 2: Withdraw partial amount from station to cargo
          const smallWResp = await bot.exec("withdraw_items", { item_id: itemId, quantity: availableSpace });
          if (!smallWResp.error) {
            await bot.refreshCargo();
            const cargoAfter = bot.inventory.find((i) => i.itemId === itemId)?.quantity || 0;
            const withdrawn = Math.max(0, cargoAfter - cargoBefore);
            ctx.log("cargo", `Withdraw successful (partial): got ${withdrawn}x ${itemId} from faction storage`);
            logCargoActivity(bot.username, "withdraw_success", `Successfully withdrew ${withdrawn}x ${itemId} from faction storage (partial, cargo full)`, {
              itemId,
              itemName: inFaction.name || itemId,
              quantity: withdrawn,
              location: `${bot.system}/${bot.poi}`,
            });
            return { success: withdrawn > 0, withdrawnQty: withdrawn };
          }
        }
      }
    }
    ctx.log("error", `Withdraw from faction failed: ${wResp.error.message}`);
    logCargoActivity(bot.username, "withdraw_failed", `Failed to withdraw ${itemId} from faction storage: ${wResp.error.message}`, {
      itemId,
      quantity,
      location: `${bot.system}/${bot.poi}`,
      error: wResp.error.message,
    });
    return { success: false, withdrawnQty: 0 };
  } else {
    // Personal storage - check current bot's storage
    const inPersonal = bot.storage.find((i) => i.itemId === itemId);
    ctx.log("cargo", `Withdraw check: personal storage has ${inPersonal?.quantity || 0}x ${itemId} (looking for ${quantity})`);
    ctx.log("cargo", `Personal storage contents: ${bot.storage.map(i => `${i.quantity}x ${i.itemId}`).join(", ") || "empty"}`);

    if (!inPersonal || inPersonal.quantity <= 0) {
      ctx.log("error", `Withdraw from personal storage failed: ${itemId} not available in current bot's storage`);
      logCargoActivity(bot.username, "withdraw_failed", `Failed to withdraw ${itemId} from personal storage: not available`, {
        itemId,
        quantity,
        location: `${bot.system}/${bot.poi}`,
        error: "Item not available in personal storage",
      });
      // Check if we might need to use a different bot's storage
      if (bot.storage.length === 0) {
        ctx.log("error", `Current bot's storage is completely empty — items may be in another bot's storage`);
      }
      return { success: false, withdrawnQty: 0 };
    }
    const actualQty = Math.min(quantity, inPersonal.quantity);
    ctx.log("cargo", `Withdrawing ${actualQty}x ${itemId} from personal storage...`);
    // Use withdraw_items command (API v1) instead of storage action=withdraw (API v2)
    const wResp = await bot.exec("withdraw_items", { item_id: itemId, quantity: actualQty });
    if (!wResp.error) {
      await bot.refreshCargo();
      const cargoAfter = bot.inventory.find((i) => i.itemId === itemId)?.quantity || 0;
      const withdrawn = Math.max(0, cargoAfter - cargoBefore);
      ctx.log("cargo", `Withdraw successful: got ${withdrawn}x ${itemId}`);
      logCargoActivity(bot.username, "withdraw_success", `Successfully withdrew ${withdrawn}x ${itemId} from personal storage`, {
        itemId,
        itemName: inPersonal.name || itemId,
        quantity: withdrawn,
        location: `${bot.system}/${bot.poi}`,
      });
      return { success: withdrawn > 0, withdrawnQty: withdrawn };
    }
    ctx.log("error", `Withdraw from personal storage failed: ${wResp.error.message}`);
    if (wResp.error.message.includes("cargo_full")) {
      // Try to parse available space from error message
      const match = wResp.error.message.match(/only (\d+) available/);
      const availableSpace = match ? parseInt(match[1], 10) : Math.max(1, Math.floor(actualQty / 2));
      ctx.log("cargo", `Cargo full error - parsed available space: ${availableSpace}`);
      if (availableSpace > 0) {
        const smallWResp = await bot.exec("withdraw_items", { item_id: itemId, quantity: availableSpace });
        if (!smallWResp.error) {
          await bot.refreshCargo();
          const cargoAfter = bot.inventory.find((i) => i.itemId === itemId)?.quantity || 0;
          const withdrawn = Math.max(0, cargoAfter - cargoBefore);
          ctx.log("cargo", `Withdraw successful (partial): got ${withdrawn}x ${itemId}`);
          logCargoActivity(bot.username, "withdraw_success", `Successfully withdrew ${withdrawn}x ${itemId} from personal storage (partial, cargo full)`, {
            itemId,
            itemName: inPersonal.name || itemId,
            quantity: withdrawn,
            location: `${bot.system}/${bot.poi}`,
          });
          return { success: withdrawn > 0, withdrawnQty: withdrawn };
        }
      }
    }
    logCargoActivity(bot.username, "withdraw_failed", `Failed to withdraw ${itemId} from personal storage: ${wResp.error.message}`, {
      itemId,
      quantity,
      location: `${bot.system}/${bot.poi}`,
      error: wResp.error.message,
    });
    return { success: false, withdrawnQty: 0 };
  }
}

/** Deposit items to specified storage type or send as gift. */
async function depositToDestination(
  ctx: RoutineContext,
  itemId: string,
  quantity: number,
  storageType: "faction" | "personal" | "send_gift",
  destinationBotName?: string,
): Promise<{ success: boolean; depositedQty: number }> {
  const { bot } = ctx;

  ctx.log("cargo", `Attempting deposit: ${quantity}x ${itemId} to ${storageType}${destinationBotName ? ` (${destinationBotName})` : ''}`);

  // Log deposit attempt
  logCargoActivity(bot.username, "deposit_start", `Attempting to deposit ${quantity}x ${itemId} to ${storageType}${destinationBotName ? ` (${destinationBotName})` : ''}`, {
    itemId,
    itemName: bot.inventory.find(i => i.itemId === itemId)?.name || itemId,
    quantity,
    location: `${bot.system}/${bot.poi}`,
  });

  if (storageType === "send_gift") {
    if (!destinationBotName) {
      ctx.log("error", "send_gift requires destinationBotName to be set");
      logCargoActivity(bot.username, "deposit_failed", "send_gift failed: destinationBotName not set", {
        itemId,
        quantity,
        location: `${bot.system}/${bot.poi}`,
        error: "destinationBotName not configured",
      });
      return { success: false, depositedQty: 0 };
    }

    // Prevent sending gifts to self — fall back to personal storage deposit
    if (destinationBotName.toLowerCase() === bot.username.toLowerCase()) {
      ctx.log("warn", `⚠️ destinationBotName (${destinationBotName}) is this bot — falling back to personal storage deposit`);
      logCargoActivity(bot.username, "deposit_start", `Self-gift detected for ${quantity}x ${itemId} — falling back to personal storage deposit`, {
        itemId,
        quantity,
        location: `${bot.system}/${bot.poi}`,
      });
      // Fall through to personal storage deposit below
      storageType = "personal";
    } else {
      // Check cargo before sending to verify later
      const cargoBefore = bot.inventory.find((i) => i.itemId === itemId)?.quantity || 0;

      const sResp = await bot.exec("send_gift", {
        item_id: itemId,
        quantity,
        recipient: destinationBotName,
      });

      // Refresh cargo to verify the gift actually went through
      await bot.refreshCargo();
      const cargoAfter = bot.inventory.find((i) => i.itemId === itemId)?.quantity || 0;
      const actuallySent = Math.max(0, cargoBefore - cargoAfter);

      if (!sResp.error && actuallySent > 0) {
        ctx.log("cargo", `✅ Sent gift: ${actuallySent}x ${itemId} to ${destinationBotName}`);
        logCargoActivity(bot.username, "deposit_success", `Sent ${actuallySent}x ${itemId} as gift to ${destinationBotName}`, {
          itemId,
          itemName: bot.inventory.find(i => i.itemId === itemId)?.name || itemId,
          quantity: actuallySent,
          location: `${bot.system}/${bot.poi}`,
        });
        return { success: true, depositedQty: actuallySent };
      }

      // send_gift reported success but items are still in cargo — verify failure
      if (!sResp.error && actuallySent === 0) {
        ctx.log("error", `⚠️ send_gift reported success but ${quantity}x ${itemId} still in cargo — gift likely failed silently`);
        logCargoActivity(bot.username, "deposit_failed", `send_gift reported success but items still in cargo (${quantity}x ${itemId})`, {
          itemId,
          quantity,
          location: `${bot.system}/${bot.poi}`,
          error: "Gift reported success but items not removed from cargo",
        });
        return { success: false, depositedQty: 0 };
      }

      ctx.log("error", `send_gift failed: ${sResp.error?.message || 'unknown error'}`);
      logCargoActivity(bot.username, "deposit_failed", `send_gift failed: ${sResp.error?.message || 'unknown error'}`, {
        itemId,
        quantity,
        location: `${bot.system}/${bot.poi}`,
        error: sResp.error?.message || 'unknown error',
      });
      return { success: false, depositedQty: 0 };
    }
  }

  if (storageType === "faction") {
    // Check faction storage before deposit for verification
    const factionBefore = bot.factionStorage.find((i) => i.itemId === itemId)?.quantity || 0;

    const dResp = await bot.exec("faction_deposit_items", { item_id: itemId, quantity });
    if (!dResp.error) {
      // Refresh faction storage to verify actual deposit
      await bot.refreshFactionStorage();
      const factionAfter = bot.factionStorage.find((i) => i.itemId === itemId)?.quantity || 0;
      const actuallyDeposited = Math.max(0, factionAfter - factionBefore);

      if (actuallyDeposited > 0) {
        logFactionActivity(ctx, "deposit", `Deposited ${actuallyDeposited}x ${itemId} (cargo mover)`);
        ctx.log("cargo", `✅ Deposited to faction storage: ${actuallyDeposited}x ${itemId} (verified)`);
        logCargoActivity(bot.username, "deposit_success", `Deposited ${actuallyDeposited}x ${itemId} to faction storage (verified)`, {
          itemId,
          itemName: bot.inventory.find(i => i.itemId === itemId)?.name || itemId,
          quantity: actuallyDeposited,
          location: `${bot.system}/${bot.poi}`,
        });
        return { success: true, depositedQty: actuallyDeposited };
      } else {
        ctx.log("error", `⚠️ Faction deposit reported success but storage unchanged for ${itemId}`);
        logCargoActivity(bot.username, "deposit_failed", `Faction deposit reported success but storage unchanged (${quantity}x ${itemId})`, {
          itemId,
          quantity,
          location: `${bot.system}/${bot.poi}`,
          error: "Deposit reported success but faction storage unchanged",
        });
        return { success: false, depositedQty: 0 };
      }
    }
    ctx.log("error", `Faction deposit failed: ${dResp.error.message}`);
    logCargoActivity(bot.username, "deposit_failed", `Faction deposit failed: ${dResp.error.message}`, {
      itemId,
      quantity,
      location: `${bot.system}/${bot.poi}`,
      error: dResp.error.message,
    });
    return { success: false, depositedQty: 0 };
  }

  // Personal storage - use deposit_items command (cargo → personal storage)
  // Check personal storage before deposit for verification
  const personalBefore = bot.storage.find((i) => i.itemId === itemId)?.quantity || 0;

  const dResp = await bot.exec("deposit_items", { item_id: itemId, quantity });
  if (!dResp.error) {
    // Refresh personal storage to verify actual deposit
    await bot.refreshStorage();
    const personalAfter = bot.storage.find((i) => i.itemId === itemId)?.quantity || 0;
    const actuallyDeposited = Math.max(0, personalAfter - personalBefore);

    if (actuallyDeposited > 0) {
      ctx.log("cargo", `✅ Deposited to personal storage: ${actuallyDeposited}x ${itemId} (verified)`);
      logCargoActivity(bot.username, "deposit_success", `Deposited ${actuallyDeposited}x ${itemId} to personal storage (verified)`, {
        itemId,
        itemName: bot.inventory.find(i => i.itemId === itemId)?.name || itemId,
        quantity: actuallyDeposited,
        location: `${bot.system}/${bot.poi}`,
      });
      return { success: true, depositedQty: actuallyDeposited };
    } else {
      ctx.log("error", `⚠️ Personal deposit reported success but storage unchanged for ${itemId}`);
      logCargoActivity(bot.username, "deposit_failed", `Personal deposit reported success but storage unchanged (${quantity}x ${itemId})`, {
        itemId,
        quantity,
        location: `${bot.system}/${bot.poi}`,
        error: "Deposit reported success but personal storage unchanged",
      });
      return { success: false, depositedQty: 0 };
    }
  }
  ctx.log("error", `Personal storage deposit failed: ${dResp.error.message}`);
  logCargoActivity(bot.username, "deposit_failed", `Personal storage deposit failed: ${dResp.error.message}`, {
    itemId,
    quantity,
    location: `${bot.system}/${bot.poi}`,
    error: dResp.error.message,
  });
  return { success: false, depositedQty: 0 };
}

function findMoveJobs(
  ctx: RoutineContext,
  settings: CargoMoverSettings,
  sourceSystem: string,
  destSystem: string,
): MoveJob[] {
  const { bot } = ctx;
  const jobs: MoveJob[] = [];

  if (settings.items.length === 0) return jobs;

  ctx.log("cargo", `findMoveJobs: bot.storage has ${bot.storage.length} items, bot.factionStorage has ${bot.factionStorage.length} items`);

  for (const configItem of settings.items) {
    // Skip if item has reached its delivery target (totalDelivered >= totalToDeliver)
    if (configItem.totalToDeliver !== undefined && configItem.totalToDeliver > 0) {
      const delivered = configItem.totalDelivered || 0;
      if (delivered >= configItem.totalToDeliver) {
        ctx.log("cargo", `  ${configItem.itemName}: delivery target reached (${delivered}/${configItem.totalToDeliver}) — skipping`);
        continue;
      }
    }

    const storageType = configItem.storageType || 'faction';
    // Get quantity from configured storage (faction or personal)
    const inStorage = storageType === 'faction'
      ? (bot.factionStorage.find(i => i.itemId === configItem.itemId)?.quantity || 0)
      : (bot.storage.find(i => i.itemId === configItem.itemId)?.quantity || 0);

    // Also count what's already in cargo hold
    const inCargo = bot.inventory.find(i => i.itemId === configItem.itemId)?.quantity || 0;

    // Total available = in storage + already in cargo
    const totalAvailable = inStorage + inCargo;
    
    // Check how much is already claimed by other bots (quantity-based locking)
    let availableQty = getAvailableItemQuantity(
      configItem.itemId,
      totalAvailable,
      bot.username
    );

    // Subtract items already in transit to this destination
    const inTransitQty = getInTransitQuantity(configItem.itemId, settings.destinationStation);
    availableQty = Math.max(0, availableQty - inTransitQty);
    
    const alreadyClaimed = getBotClaimedQuantity(bot.username, configItem.itemId);

    // Calculate effective target considering items already in transit
    const baseTargetQty = configItem.quantity > 0 ? configItem.quantity : availableQty;
    const effectiveTargetQty = Math.max(0, baseTargetQty - inTransitQty);

    ctx.log("cargo", `  ${configItem.itemName}: inStorage=${inStorage}, inCargo=${inCargo}, totalAvailable=${totalAvailable}, availableForBot=${availableQty}, inTransit=${inTransitQty}, effectiveTarget=${effectiveTargetQty}, alreadyClaimed=${alreadyClaimed} (storageType=${storageType})`);

    if (effectiveTargetQty > 0 && availableQty > 0) {
      const blacklist = getSystemBlacklist();
      const route = mapStore.findRoute(sourceSystem, destSystem, blacklist);
      const jumps = route ? route.length - 1 : 999;

      // Limit available quantity to what fits in cargo for this item
      const itemSize = getItemSize(configItem.itemId);
      const maxCarry = Math.floor(bot.cargoMax / itemSize);
      const claimableQty = Math.min(effectiveTargetQty, availableQty, maxCarry);

      jobs.push({
        itemId: configItem.itemId,
        itemName: configItem.itemName,
        targetQty: effectiveTargetQty,
        availableQty: claimableQty,
        storageType,
        sourceSystem,
        sourceStation: settings.sourceStation,
        destSystem,
        destStation: settings.destinationStation,
        jumps,
      });
    } else if (availableQty <= 0 && alreadyClaimed > 0) {
      ctx.log("cargo", `  ${configItem.itemName}: all claimed by other bots, but bot has ${alreadyClaimed}x locked — will continue delivering`);
    } else if (availableQty <= 0) {
      ctx.log("cargo", `  ${configItem.itemName}: no available quantity (all claimed by other bots or empty)`);
    }
  }

  // Limit locked quantity per item to allow multiple bots to work on the same items
  // Reduce maxCarry to allow concurrent access
  jobs.forEach(job => {
    const itemSize = getItemSize(job.itemId);
    const maxCarryConcurrent = Math.floor(bot.cargoMax / itemSize / 2); // Allow 2 bots per item
    job.availableQty = Math.min(job.availableQty, maxCarryConcurrent);
  });

  return jobs;
}

/** Update delivery tracking for items after successful delivery. */
function updateDeliveryTracking(
  ctx: RoutineContext,
  itemIds: string[],
  quantities: number[],
  settings: CargoMoverSettings
): void {
  const { bot } = ctx;
  const all = readSettings();
  const cargoMover = all.cargo_mover || {};
  const items = (cargoMover.items as Array<Record<string, unknown>>) || [];

  let updated = false;
  for (let i = 0; i < itemIds.length; i++) {
    const itemId = itemIds[i];
    const qty = quantities[i];
    const item = items.find((it) => it.itemId === itemId);
    if (item) {
      const current = (item.totalDelivered as number) || 0;
      item.totalDelivered = current + qty;
      updated = true;
      console.log(`[CargoMover] Updated ${itemId}: ${current} -> ${current + qty} delivered`);
    }

    // Update coordination locks
    updateDeliveredQuantity(bot.username, itemId, qty);

    // Update activity tracking
    const progress = updateItemProgress(bot.username, itemId, { delivered: qty });
    if (progress) {
      ctx.log("cargo", `  Progress for ${itemId}: ${progress.totalDelivered}/${progress.targetQuantity} delivered (${progress.isComplete ? 'COMPLETE' : 'in progress'})`);
    }

    // Log the delivery
    logCargoActivity(bot.username, "deposit_success", `Delivered ${qty}x ${itemId} to destination`, {
      itemId,
      quantity: qty,
      location: `${bot.system}/${bot.poi}`,
    });
  }

  if (updated) {
    writeSettings({ cargo_mover: { items } });
  }
}

export const cargoMoverRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  // Cleanup stale locks on startup (15-minute inactivity threshold)
  const cleanedLocks = cleanupStaleLocks();
  if (cleanedLocks > 0) {
    ctx.log("cargo", `Cleaned up ${cleanedLocks} stale coordination locks from previous sessions`);
  }

  // Cleanup stale in-transit items (24-hour threshold)
  const cleanedTransit = cleanupStaleInTransit();
  if (cleanedTransit > 0) {
    ctx.log("cargo", `Cleaned up ${cleanedTransit} stale in-transit items from previous sessions`);
  }

  await bot.refreshStatus();

  // Check for interrupted session recovery
  const lastSession = getLastSession(bot.username);
  if (lastSession) {
    const sessionAge = Date.now() - new Date(lastSession.timestamp).getTime();
    const sessionAgeMinutes = sessionAge / 60000;
    
    if (sessionAgeMinutes < 60) { // Only recover sessions less than 1 hour old
      ctx.log("cargo", `🔄 Found interrupted session from ${sessionAgeMinutes.toFixed(1)} minutes ago`);
      ctx.log("cargo", `   Last action: ${lastSession.lastAction}`);
      ctx.log("cargo", `   Last location: ${lastSession.lastSystem}/${lastSession.lastStation} (docked: ${lastSession.docked})`);
      ctx.log("cargo", `   Trip ${lastSession.currentTrip}, Items: ${lastSession.items.length}`);
      
      logCargoActivity(bot.username, "resume", `Resuming interrupted session from ${sessionAgeMinutes.toFixed(1)}m ago`, {
        location: `${lastSession.lastSystem}/${lastSession.lastStation}`,
      });

      // Clear the session so it doesn't get recovered again
      clearLastSession(bot.username);
      
      // The routine will naturally continue from where it left off
      // thanks to the state tracking below
    } else {
      ctx.log("cargo", `Found old session (${sessionAgeMinutes.toFixed(1)}m ago) — starting fresh`);
      clearLastSession(bot.username);
    }
  }

  // Log session start
  logCargoActivity(bot.username, "session_start", "Cargo mover routine started", {
    location: `${bot.system}/${bot.poi}`,
  });

  // Persistent battle state across cycles
  const battleState: BattleState = {
    inBattle: false,
    battleId: null,
    battleStartTick: null,
    lastHitTick: null,
    isFleeing: false,
    lastFleeTime: undefined,
  };

  while (bot.state === "running") {

    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) {
      logCargoActivity(bot.username, "death_recovery", "Bot died, recovering...", {
        location: `${bot.system}/${bot.poi}`,
      });
      await ctx.sleep(30000);
      continue;
    }

    // Battle check
    if (await checkAndFleeFromBattle(ctx, "cargo_mover")) {
      logCargoActivity(bot.username, "battle_encounter", "Encountered battle, fleeing", {
        location: `${bot.system}/${bot.poi}`,
      });
      await ctx.sleep(5000);
      continue;
    }

    // Periodic battle status check (backup detection in case notifications fail)
    // Check every cycle for fast detection
    if (bot.isInBattle()) {
      const now = Date.now();
      const timeSinceLastFlee = battleState.lastFleeTime ? now - battleState.lastFleeTime : Infinity;
      if (timeSinceLastFlee > 10000) { // Only issue if more than 10 seconds since last flee
        ctx.log("combat", `PERIODIC CHECK: IN BATTLE! - initiating IMMEDIATE flee!`);
        battleState.inBattle = true;
        battleState.isFleeing = false;

        await bot.exec("battle", { action: "stance", stance: "flee" });
        battleState.lastFleeTime = now;
        ctx.log("combat", "Flee stance issued - will re-issue every cycle until disengaged!");
      }
    }

    // If we're in battle, re-issue flee command to ensure we stay in flee stance
    if (battleState.inBattle) {
      const now = Date.now();
      const timeSinceLastFlee = battleState.lastFleeTime ? now - battleState.lastFleeTime : Infinity;
      if (timeSinceLastFlee > 10000) { // Only issue if more than 10 seconds since last flee
        ctx.log("combat", "Re-issuing flee stance (ensuring we stay in flee mode)...");
        const fleeResp = await bot.exec("battle", { action: "stance", stance: "flee" });
        if (fleeResp.error) {
          ctx.log("error", `Flee re-issue failed: ${fleeResp.error.message}`);
        } else {
          battleState.lastFleeTime = now;
        }
      }
      // Check if we've successfully disengaged
      const currentBattleStatus = await getBattleStatus(ctx);
      if (!currentBattleStatus || !currentBattleStatus.is_participant) {
        ctx.log("combat", "Battle cleared - no longer in combat!");
        battleState.inBattle = false;
        battleState.battleId = null;
        battleState.isFleeing = false;
        battleState.lastFleeTime = undefined;
        logCargoActivity(bot.username, "battle_escaped", "Successfully escaped battle", {
          location: `${bot.system}/${bot.poi}`,
        });
        await ctx.sleep(2000); // Brief pause before next check
        continue;
      }
      // Still in battle - continue to next cycle
      await ctx.sleep(2000); // Brief pause before next check
      continue;
    }

    const settings = getCargoMoverSettings(bot.username);
    const safetyOpts = {
      fuelThresholdPct: settings.refuelThreshold,
      hullThresholdPct: settings.repairThreshold,
    };

    ctx.log("cargo", `═══════════════════════════════════════════════════════`);
    ctx.log("cargo", `📦 Cargo Mover Cycle Starting`);
    ctx.log("cargo", `   Source: ${settings.sourceStation}`);
    ctx.log("cargo", `   Destination: ${settings.destinationStation} (${settings.destinationStorageType})`);
    ctx.log("cargo", `   Items to move: ${settings.items.length}`);
    for (const item of settings.items) {
      const delivered = item.totalDelivered || 0;
      const target = item.totalToDeliver || '∞';
      ctx.log("cargo", `     - ${item.itemName}: ${item.quantity || 'all'} from ${item.storageType || 'faction'} [${delivered}/${target} delivered]`);
    }
    ctx.log("cargo", `═══════════════════════════════════════════════════════`);

    if (settings.items.length === 0) {
      ctx.log("error", "No items configured — check Cargo Mover settings");
      logCargoActivity(bot.username, "error", "No items configured in cargo mover settings");
      await ctx.sleep(60000);
      continue;
    }

    if (!settings.sourceStation) {
      ctx.log("error", "No source station configured");
      await ctx.sleep(60000);
      continue;
    }

    if (!settings.destinationStation) {
      ctx.log("error", "No destination station configured");
      await ctx.sleep(60000);
      continue;
    }

    if (settings.destinationStorageType === "send_gift" && !settings.destinationBotName) {
      ctx.log("error", "destinationBotName required for send_gift");
      await ctx.sleep(60000);
      continue;
    }

    const sourceSystem = resolveStationSystem(settings.sourceStation);
    const destSystem = resolveStationSystem(settings.destinationStation);

    if (!sourceSystem) {
      ctx.log("error", `Unknown source station: ${settings.sourceStation}`);
      await ctx.sleep(60000);
      continue;
    }

    if (!destSystem) {
      ctx.log("error", `Unknown destination station: ${settings.destinationStation}`);
      await ctx.sleep(60000);
      continue;
    }

    // ── CARGO DELIVERY RECOVERY ─────────────────────────────────
    // On restart, check if bot has cargo items that need to be delivered.
    // If so, skip directly to delivery instead of going back to source.
    await bot.refreshCargo();
    const cargoItemsToDeliver = bot.inventory.filter(item => {
      const lower = item.itemId.toLowerCase();
      if (lower.includes("fuel") || lower.includes("energy_cell")) return false;
      // Check if this item is one of our configured items
      return settings.items.some(ci => ci.itemId === item.itemId);
    });

    if (cargoItemsToDeliver.length > 0) {
      ctx.log("cargo", `🔄 CARGO RECOVERY: Found ${cargoItemsToDeliver.length} item type(s) in cargo that need delivery`);
      for (const item of cargoItemsToDeliver) {
        ctx.log("cargo", `   - ${item.quantity}x ${item.name}`);
      }
      logCargoActivity(bot.username, "resume", `Recovering ${cargoItemsToDeliver.length} item type(s) from cargo for delivery`, {
        location: `${bot.system}/${bot.poi}`,
        quantity: cargoItemsToDeliver.reduce((sum, i) => sum + i.quantity, 0),
      });

      // Navigate to destination and deliver cargo
      yield "recover_cargo_delivery";

      // Ensure we're undocked and fueled
      await ensureUndocked(ctx);
      if (bot.state !== "running") {
        ctx.log("system", "⛔ Stopping — emergency detected");
        return;
      }

      const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
      if (!fueled) {
        ctx.log("error", "Cannot refuel for cargo delivery");
        logCargoActivity(bot.username, "error", "Cannot refuel for cargo recovery delivery", {
          location: `${bot.system}/${bot.poi}`,
        });
        await ctx.sleep(30000);
        continue;
      }

      // Navigate to destination system if needed
      if (bot.system !== destSystem) {
        ctx.log("travel", `Heading to destination system ${destSystem} to deliver recovered cargo...`);
        logCargoActivity(bot.username, "navigation", `Navigating to destination for cargo recovery delivery`, {
          location: `${bot.system} → ${destSystem}`,
        });
        const arrived = await navigateToSystem(ctx, destSystem, safetyOpts);
        if (!arrived || bot.state !== "running") {
          if (bot.state !== "running") {
            ctx.log("system", "⛔ Stopping — emergency detected");
            return;
          }
          ctx.log("error", `Failed to reach ${destSystem} for cargo delivery`);
          logCargoActivity(bot.username, "error", `Failed to reach destination for cargo recovery`, {
            location: `${bot.system}/${bot.poi}`,
          });
          await ctx.sleep(30000);
          continue;
        }
        ctx.log("cargo", `✅ Arrived at destination system ${destSystem}`);
      }

      // Travel to destination station
      await ensureUndocked(ctx);
      if (bot.state !== "running") {
        ctx.log("system", "⛔ Stopping — emergency detected");
        return;
      }
      if (bot.poi !== extractStationId(settings.destinationStation)) {
        ctx.log("travel", `Traveling to destination station ${settings.destinationStation}...`);
        const tResp = await bot.exec("travel", { target_poi: extractStationId(settings.destinationStation) });
        if (bot.state !== "running") {
          ctx.log("system", "⛔ Stopping — emergency detected");
          return;
        }
        // Check for battle interruption after travel command
        if (await checkBattleAfterCommand(ctx, tResp.notifications, "travel", battleState)) {
          ctx.log("error", "Battle detected during cargo recovery travel - fleeing!");
          logCargoActivity(bot.username, "battle_encounter", "Battle detected during travel to destination (cargo recovery)", {
            location: `${bot.system}/${bot.poi}`,
          });
          await ctx.sleep(5000);
          continue;
        }
        if (tResp.error) {
          const errMsg = tResp.error.message.toLowerCase();
          // CRITICAL: Check for battle interrupt error
          if (tResp.error.code === "battle_interrupt" || errMsg.includes("interrupted by battle") || errMsg.includes("interrupted by combat")) {
            ctx.log("combat", `Travel to destination interrupted by battle! ${tResp.error.message} - fleeing!`);
            logCargoActivity(bot.username, "battle_encounter", "Travel interrupted by battle during cargo recovery", {
              location: `${bot.system}/${bot.poi}`,
              error: tResp.error.message,
            });
            await ctx.sleep(5000);
            continue;
          }
          if (!errMsg.includes("already")) {
            // Check if it's a mobile station that moved
            if (settings.destinationStation === "mobile_capital" && (errMsg.includes("not found") || errMsg.includes("does not exist") || errMsg.includes("not present"))) {
              ctx.log("cargo", "Mobile capital not found at expected location during recovery, querying current system...");
              const currentSystem = await getMobileStationSystem(ctx, "frontier_station");
              if (currentSystem) {
                ctx.log("cargo", `Mobile capital is now in system ${currentSystem}`);
                // Navigate to the new system
                if (bot.system !== currentSystem) {
                  ctx.log("travel", `Navigating to updated mobile capital system ${currentSystem} for recovery...`);
                  const arrived = await navigateToSystem(ctx, currentSystem, safetyOpts);
                  if (!arrived || bot.state !== "running") {
                    if (bot.state !== "running") {
                      ctx.log("system", "⛔ Stopping — emergency detected");
                      return;
                    }
                    ctx.log("error", `Failed to reach updated mobile capital system ${currentSystem} for recovery`);
                    await ctx.sleep(30000);
                    continue;
                  }
                  ctx.log("cargo", `✅ Arrived at updated mobile capital system ${currentSystem} for recovery`);
                }
                // Retry travel to the station
                const retryResp = await bot.exec("travel", { target_poi: extractStationId(settings.destinationStation) });
                if (retryResp.error) {
                  const retryErrMsg = retryResp.error.message.toLowerCase();
                  if (!retryErrMsg.includes("already")) {
                    ctx.log("error", `Still failed to travel to mobile capital after relocation during recovery: ${retryResp.error.message}`);
                    await ctx.sleep(30000);
                    continue;
                  }
                } else {
        bot.poi = extractStationId(settings.destinationStation);
                }
              } else {
                ctx.log("error", "Could not determine current location of mobile capital during recovery");
                await ctx.sleep(30000);
                continue;
              }
            } else {
              ctx.log("error", `Travel to destination failed: ${tResp.error.message}`);
              await ctx.sleep(30000);
              continue;
            }
          }
        } else {
        bot.poi = extractStationId(settings.destinationStation);
        }
      }

      // Dock at destination
      yield "dock_dest";
      if (!await dockAtStation(ctx)) {
        ctx.log("error", "Could not dock at destination for cargo delivery");
        await ctx.sleep(30000);
        continue;
      }
      ctx.log("cargo", `✅ Docked at destination station ${settings.destinationStation}`);

      // Deliver all cargo
      yield "deposit_items";
      await bot.refreshCargo();
      const itemsToDeposit = [...bot.inventory];
      const deliveredItems: { itemId: string; quantity: number }[] = [];

      if (itemsToDeposit.length > 0) {
        ctx.log("cargo", `📦 Delivering recovered cargo to destination...`);
        for (const item of itemsToDeposit) {
          if (item.quantity <= 0) continue;
          const lower = item.itemId.toLowerCase();
          if (lower.includes("fuel") || lower.includes("energy_cell")) continue;

          const depositResult = await depositToDestination(
            ctx,
            item.itemId,
            item.quantity,
            settings.destinationStorageType,
            settings.destinationBotName,
          );
          if (depositResult.success) {
            ctx.log("cargo", `✅ Delivered ${depositResult.depositedQty}x ${item.name}`);
            deliveredItems.push({ itemId: item.itemId, quantity: depositResult.depositedQty });
          }
        }

        // Update delivery tracking
        if (deliveredItems.length > 0) {
          const itemIds = deliveredItems.map((d) => d.itemId);
          const quantities = deliveredItems.map((d) => d.quantity);
          updateDeliveryTracking(ctx, itemIds, quantities, settings);
        }
      }

      ctx.log("cargo", `✅ Cargo recovery complete — delivered ${deliveredItems.length} item type(s)`);
      logCargoActivity(bot.username, "trip_complete", `Cargo recovery delivery complete`, {
        location: `${bot.system}/${bot.poi}`,
        quantity: deliveredItems.reduce((sum, d) => sum + d.quantity, 0),
      });

      // After recovery, continue to next cycle (which will go back to source for more)
      await ctx.sleep(5000);
      continue;
    }

    // Save session state for interruption recovery
    saveLastSession(
      bot.username,
      settings.sourceStation,
      settings.destinationStation,
      settings.items.map(i => ({ itemId: i.itemId, itemName: i.itemName, quantity: i.quantity, storageType: i.storageType || 'faction' })),
      0, // Will be updated as trips progress
      "starting",
      bot.system,
      bot.poi || "",
      bot.docked
    );

    // Navigate to source station only if not already there
    yield "navigate_to_source";

    let justDockedAtSource = false;

    if (bot.system !== sourceSystem) {
      ctx.log("cargo", `🚀 Not at source system (${bot.system} ≠ ${sourceSystem}) — navigating...`);
      logCargoActivity(bot.username, "navigation", `Navigating to source system ${sourceSystem}`, {
        location: `${bot.system} → ${sourceSystem}`,
      });
      
      saveLastSession(bot.username, settings.sourceStation, settings.destinationStation,
        settings.items.map(i => ({ itemId: i.itemId, itemName: i.itemName, quantity: i.quantity, storageType: i.storageType || 'faction' })),
        0, "navigating_to_source", bot.system, bot.poi || "", bot.docked);
      
      await ensureUndocked(ctx);
      if (bot.state !== "running") {
        ctx.log("system", "⛔ Stopping — emergency detected");
        logCargoActivity(bot.username, "interruption", "Emergency detected during navigation to source", {
          location: `${bot.system}/${bot.poi}`,
        });
        return;
      }
      const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
      if (!fueled) {
        ctx.log("error", "Cannot refuel to reach source system");
        logCargoActivity(bot.username, "error", "Cannot refuel to reach source system", {
          location: `${bot.system}/${bot.poi}`,
        });
        await ctx.sleep(30000);
        continue;
      }
      ctx.log("travel", `Heading to source system ${sourceSystem}...`);
      const arrived = await navigateToSystem(ctx, sourceSystem, safetyOpts);
      if (!arrived || bot.state !== "running") {
        if (bot.state !== "running") {
          ctx.log("system", "⛔ Stopping — emergency detected");
          logCargoActivity(bot.username, "interruption", "Emergency detected during navigation", {
            location: `${bot.system}/${bot.poi}`,
          });
          return;
        }
        ctx.log("error", `Failed to reach ${sourceSystem}`);
        logCargoActivity(bot.username, "error", `Failed to reach source system ${sourceSystem}`, {
          location: `${bot.system}/${bot.poi}`,
        });
        await ctx.sleep(30000);
        continue;
      }
      ctx.log("cargo", `✅ Arrived at source system ${sourceSystem}`);
      logCargoActivity(bot.username, "navigation", `Arrived at source system ${sourceSystem}`, {
        location: sourceSystem,
      });
      justDockedAtSource = true;
    }

    // Only travel to and dock at source station if not already there
    if (!bot.docked || bot.poi !== settings.sourceStation) {
      ctx.log("cargo", `🚢 Not docked at source station — docking/traveling...`);
      
      saveLastSession(bot.username, settings.sourceStation, settings.destinationStation,
        settings.items.map(i => ({ itemId: i.itemId, itemName: i.itemName, quantity: i.quantity, storageType: i.storageType || 'faction' })),
        0, "docking_at_source", bot.system, bot.poi || "", bot.docked);
      
      await ensureUndocked(ctx);
      if (bot.state !== "running") {
        ctx.log("system", "⛔ Stopping — emergency detected");
        logCargoActivity(bot.username, "interruption", "Emergency detected during source station approach", {
          location: `${bot.system}/${bot.poi}`,
        });
        return;
      }
    if (bot.poi !== extractStationId(settings.sourceStation)) {
        ctx.log("travel", `Traveling to source station ${settings.sourceStation}...`);
        logCargoActivity(bot.username, "navigation", `Traveling to source station ${settings.sourceStation}`, {
          location: `${bot.system}: ${bot.poi} → ${settings.sourceStation}`,
        });
        const tResp = await bot.exec("travel", { target_poi: extractStationId(settings.sourceStation) });
        if (bot.state !== "running") {
          ctx.log("system", "⛔ Stopping — emergency detected");
          logCargoActivity(bot.username, "interruption", "Emergency detected during travel to source station", {
            location: `${bot.system}/${bot.poi}`,
          });
          return;
        }
        // Check for battle interruption after travel command
        if (await checkBattleAfterCommand(ctx, tResp.notifications, "travel", battleState)) {
          ctx.log("error", "Battle detected during travel to source station - fleeing!");
          logCargoActivity(bot.username, "battle_encounter", "Battle detected during travel to source station", {
            location: `${bot.system}/${bot.poi}`,
          });
          await ctx.sleep(5000);
          continue;
        }
        if (tResp.error) {
          const errMsg = tResp.error.message.toLowerCase();
          // CRITICAL: Check for battle interrupt error
          if (tResp.error.code === "battle_interrupt" || errMsg.includes("interrupted by battle") || errMsg.includes("interrupted by combat")) {
            ctx.log("combat", `Travel to source interrupted by battle! ${tResp.error.message} - fleeing!`);
            logCargoActivity(bot.username, "battle_encounter", "Travel interrupted by battle during travel to source station", {
              location: `${bot.system}/${bot.poi}`,
              error: tResp.error.message,
            });
            await ctx.sleep(5000);
            continue;
          }
          if (!errMsg.includes("already")) {
            ctx.log("error", `Travel to source failed: ${tResp.error.message}`);
            logCargoActivity(bot.username, "error", `Travel to source station failed: ${tResp.error.message}`, {
              location: `${bot.system}/${bot.poi}`,
            });
            await ctx.sleep(30000);
            continue;
          }
        }
        bot.poi = extractStationId(settings.sourceStation);
      }

      yield "dock_source";
      if (!await dockAtStation(ctx)) {
        ctx.log("error", "Could not dock at source");
        logCargoActivity(bot.username, "error", "Could not dock at source station", {
          location: `${bot.system}/${settings.sourceStation}`,
        });
        await ctx.sleep(30000);
        continue;
      }
      ctx.log("cargo", `✅ Docked at source station ${settings.sourceStation}`);
      logCargoActivity(bot.username, "dock", `Docked at source station ${settings.sourceStation}`, {
        location: `${bot.system}/${settings.sourceStation}`,
      });
      justDockedAtSource = true;
    }

    // Only do maintenance if we just docked
    if (justDockedAtSource) {
      yield "maintenance_source";
      ctx.log("cargo", `🔧 Performing maintenance at source station...`);
      await tryRefuel(ctx);
      await repairShip(ctx);
    }

    // Clear unrelated cargo items to FACTION storage (not personal) so other bots can access them
    yield "clear_cargo";
    ctx.log("cargo", `🧹 Clearing unrelated cargo items to faction storage...`);
    await bot.refreshCargo();
    if (bot.inventory.length > 0) {
      const itemsToClear = bot.inventory.filter(item => {
        // Keep fuel/energy cells for operations
        const lower = item.itemId.toLowerCase();
        if (lower.includes("fuel") || lower.includes("energy_cell")) return false;
        // Check if this is one of our configured items to move
        const isConfiguredItem = settings.items.some(ci => ci.itemId === item.itemId);
        // Deposit non-configured items to faction storage so other bots can use them
        return !isConfiguredItem;
      });
      if (itemsToClear.length > 0) {
        const deposited: string[] = [];
        for (const item of itemsToClear) {
          if (item.quantity <= 0) continue;
          // Deposit to faction storage, not personal storage
          const dResp = await bot.exec("faction_deposit_items", { item_id: item.itemId, quantity: item.quantity });
          if (!dResp.error) deposited.push(`${item.quantity}x ${item.name}`);
        }
        if (deposited.length > 0) {
          ctx.log("cargo", `✅ Cleared cargo to faction storage: ${deposited.join(", ")}`);
          logCargoActivity(bot.username, "deposit_success", `Cleared cargo to faction storage: ${deposited.join(", ")}`, {
            location: `${bot.system}/${bot.poi}`,
          });
        }
        await bot.refreshCargo();
      }
    }

    // Refresh storage after clearing cargo to get accurate counts
    // This prevents race conditions where items just deposited aren't counted
    await bot.refreshStorage();
    await bot.refreshFactionStorage();

    yield "find_jobs";
    // Clean up any stale locks from other bots before checking availability
    const staleCleaned = cleanupStaleLocks();
    if (staleCleaned > 0) {
      ctx.log("cargo", `Cleaned up ${staleCleaned} stale locks from other bots`);
    }

    await bot.refreshStatus();
    // Re-find jobs now that storage is updated with cleared items
    let jobs = findMoveJobs(ctx, settings, sourceSystem, destSystem);
    if (jobs.length === 0) {
      ctx.log("info", "No items available to move — waiting 60s");
      logCargoActivity(bot.username, "session_end", "No items available to move, waiting", {
        location: `${bot.system}/${bot.poi}`,
      });
      await ctx.sleep(60000);
      continue;
    }

    ctx.log("cargo", `📋 Found ${jobs.length} item(s) to move (locked quantities limited for concurrent access)`);
    for (const job of jobs) {
      const itemSize = getItemSize(job.itemId);
      const totalCargoNeeded = job.availableQty * itemSize;
      const tripsNeeded = Math.ceil(totalCargoNeeded / bot.cargoMax);
      ctx.log("cargo", `   - ${job.itemName}: ${job.availableQty}x (size: ${itemSize}, cargo: ${totalCargoNeeded}) from ${job.sourceStation} → ${job.destStation} [~${tripsNeeded} trips]`);
    }

    let totalMoved = 0;
    let totalTrips = 0;
    let allJobsCompleted = true;

    // Track remaining quantities for each job
    const jobRemaining = new Map<string, number>();
    for (const job of jobs) {
      jobRemaining.set(job.itemId, job.availableQty);
      
      // Initialize item progress tracking
      startItemProgress(bot.username, job.itemId, job.itemName, job.availableQty, job.storageType);
      
      // Acquire quantity lock for this item (multi-bot coordination)
      const lockResult = acquireQuantityLock({
        botUsername: bot.username,
        itemId: job.itemId,
        itemName: job.itemName,
        quantity: job.availableQty,
        totalAvailable: job.availableQty,
        sourceStation: job.sourceStation,
        destinationStation: job.destStation,
      });
      
      if (lockResult.success) {
        ctx.log("cargo", `🔒 Acquired lock on ${job.itemName}: ${job.availableQty}x (${lockResult.message})`);
        logCargoActivity(bot.username, "lock_acquired", `Locked ${job.availableQty}x ${job.itemName} for moving`, {
          itemId: job.itemId,
          itemName: job.itemName,
          quantity: job.availableQty,
          location: `${bot.system}/${bot.poi}`,
        });
      } else {
        ctx.log("warn", `⚠️ Could not lock ${job.itemName}: ${lockResult.message} — other bots may be competing`);
        logCargoActivity(bot.username, "lock_conflict", `Could not lock ${job.itemName}: ${lockResult.message}`, {
          itemId: job.itemId,
          itemName: job.itemName,
          quantity: job.availableQty,
          location: `${bot.system}/${bot.poi}`,
        });
      }
    }

    // Main loading loop: keep loading until cargo is full or all jobs done
    let currentTrip = totalTrips + 1;
    let consecutiveFailures = 0;
    const maxConsecutiveFailures = jobs.length; // One full pass through all jobs
    
    // Track cargo manually to avoid stale bot.cargo issues
    let cargoUsed = 0;
    const cargoMax = bot.cargoMax;
    
    while (bot.state === "running") {
      await bot.refreshStatus();
      await bot.refreshCargo();
      
      // Use manual cargo tracking for accuracy
      const freeSpace = Math.max(0, cargoMax - cargoUsed);

      // If cargo is full, go deliver
      if (freeSpace <= 0) {
        ctx.log("cargo", `📦 Cargo full (${cargoUsed}/${cargoMax}) — delivering...`);
        break;
      }

      // Try to load from each job that still has items
      let loadedThisIteration = false;
      let failedThisIteration = 0;
      
      for (const job of jobs) {
        const remaining = jobRemaining.get(job.itemId) || 0;
        if (remaining <= 0) continue;

        // Check if cargo is full before attempting withdrawal
        const currentFree = Math.max(0, cargoMax - cargoUsed);
        if (currentFree <= 0) {
          ctx.log("cargo", `📦 Cargo full (${cargoUsed}/${cargoMax}) — stopping loading`);
          loadedThisIteration = true; // Signal to break outer loop
          break;
        }

        ctx.log("cargo", `🔄 Loading loop: ${job.itemName} remaining=${remaining}, freeSpace=${currentFree}, cargo=${cargoUsed}/${cargoMax}`);

        // Calculate how many items fit in cargo space (considering item size)
        const itemSize = getItemSize(job.itemId);
        const maxFitInCargo = Math.floor(currentFree / itemSize);

        // Calculate how much we can actually load (limited by remaining, and cargo capacity)
        const loadQty = Math.min(remaining, maxFitInCargo);
        if (loadQty <= 0) {
          ctx.log("cargo", `Skipping ${job.itemName}: cannot fit any units (size=${itemSize}, freeSpace=${currentFree})`);
          failedThisIteration++;
          continue;
        }

        ctx.log("cargo", `Attempting to withdraw ${loadQty}x ${job.itemName} from ${job.storageType} (item size: ${itemSize}, cargo space: ${currentFree})`);
        yield "withdraw_items";

        // Retry failed withdrawals up to 3 times to handle temporary API issues
        let withdrawResult = { success: false, withdrawnQty: 0 };
        let retryCount = 0;
        const maxRetries = 3;

        while (retryCount < maxRetries) {
          withdrawResult = await withdrawFromStorage(ctx, job.itemId, loadQty, job.storageType);
          ctx.log("cargo", `Withdraw result: success=${withdrawResult.success}, withdrawnQty=${withdrawResult.withdrawnQty}${retryCount > 0 ? ` (retry ${retryCount}/${maxRetries - 1})` : ''}`);

          if (withdrawResult.success && withdrawResult.withdrawnQty > 0) {
            break; // Success
          }

          retryCount++;
          if (retryCount < maxRetries) {
            ctx.log("cargo", `Withdraw failed, retrying in 5 seconds... (${retryCount}/${maxRetries - 1})`);
            await ctx.sleep(5000);
          }
        }

        if (!withdrawResult.success || withdrawResult.withdrawnQty <= 0) {
          ctx.log("error", `Failed to withdraw ${job.itemId} from ${job.storageType} after ${maxRetries} attempts — marking as depleted`);
          // After multiple retries, assume the item is truly unavailable
          failedThisIteration++;
          continue;
        }

        // Reset consecutive failures on success
        consecutiveFailures = 0;

        // Update manual cargo tracker
        const actualCargoUsed = withdrawResult.withdrawnQty * itemSize;
        cargoUsed += actualCargoUsed;

        const newRemaining = remaining - withdrawResult.withdrawnQty;
        jobRemaining.set(job.itemId, newRemaining);
        totalMoved += withdrawResult.withdrawnQty;
        ctx.log("cargo", `✅ Loaded ${withdrawResult.withdrawnQty}x ${job.itemName} (${newRemaining} remaining, cargo: ${cargoUsed}/${cargoMax})`);
        loadedThisIteration = true;

        // Update item progress tracking
        updateItemProgress(bot.username, job.itemId, { withdrawn: withdrawResult.withdrawnQty });

        // Update global withdrawn tracking
        updateWithdrawnQuantity(job.itemId, withdrawResult.withdrawnQty);

        // If we couldn't load the full amount due to cargo space, cargo is nearly full
        if (withdrawResult.withdrawnQty < loadQty) {
          ctx.log("cargo", `⚠️ Partial load: got ${withdrawResult.withdrawnQty} of ${loadQty} requested (cargo nearly full, ${cargoMax - cargoUsed} space left)`);
          // Cargo is essentially full - break to deliver
          loadedThisIteration = true;
          break;
        }
      }

      // If we loaded something, continue to next iteration to fill remaining space
      if (loadedThisIteration) {
        // Check if we should break because cargo is full
        if (cargoMax - cargoUsed <= 0) {
          ctx.log("cargo", `📦 Cargo full (${cargoUsed}/${cargoMax}) after loading — delivering...`);
          break;
        }
        continue;
      }

      // If we failed to load anything from all jobs, we're done
      consecutiveFailures++;
      if (consecutiveFailures >= maxConsecutiveFailures) {
        ctx.log("cargo", `✅ No more items available to load — all jobs completed or depleted`);
        allJobsCompleted = true;
        break;
      }
    }

    // Track loaded items as in-transit before traveling
    const loadedItems = [];
    for (const [itemId, remaining] of jobRemaining) {
      const originalQty = jobs.find(j => j.itemId === itemId)?.availableQty || 0;
      const loadedQty = originalQty - remaining;
      if (loadedQty > 0) {
        const job = jobs.find(j => j.itemId === itemId);
        if (job) {
          loadedItems.push({
            itemId,
            itemName: job.itemName,
            quantity: loadedQty,
          });
        }
      }
    }

    if (loadedItems.length > 0) {
      addInTransitItems(bot.username, settings.destinationStation, loadedItems);
      ctx.log("cargo", `📦 Added ${loadedItems.length} item types to in-transit tracking (${loadedItems.reduce((sum, i) => sum + i.quantity, 0)} total items)`);
    }

    // Now travel to destination and deliver what we loaded
    yield "travel_to_dest";

    saveLastSession(bot.username, settings.sourceStation, settings.destinationStation,
      settings.items.map(i => ({ itemId: i.itemId, itemName: i.itemName, quantity: i.quantity, storageType: i.storageType || 'faction' })),
      currentTrip, "traveling_to_dest", bot.system, bot.poi || "", bot.docked);
    
    ctx.log("cargo", `🚀 Traveling to destination ${destSystem}...`);
    logCargoActivity(bot.username, "navigation", `Traveling to destination system ${destSystem} with cargo`, {
      location: `${bot.system} → ${destSystem}`,
    });
    
    await ensureUndocked(ctx);
    if (bot.state !== "running") {
      ctx.log("system", "⛔ Stopping — emergency detected");
      logCargoActivity(bot.username, "interruption", "Emergency detected before delivery travel", {
        location: `${bot.system}/${bot.poi}`,
      });
      return;
    }
    const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
    if (!fueled) {
      ctx.log("error", "Cannot refuel for delivery");
      logCargoActivity(bot.username, "error", "Cannot refuel for delivery trip", {
        location: `${bot.system}/${bot.poi}`,
      });
      allJobsCompleted = false;
      break;
    }

    if (bot.system !== destSystem) {
      ctx.log("travel", `Heading to ${destSystem}...`);
      const arrived = await navigateToSystem(ctx, destSystem, safetyOpts);
      if (!arrived || bot.state !== "running") {
        if (bot.state !== "running") {
          ctx.log("system", "⛔ Stopping — emergency detected");
          logCargoActivity(bot.username, "interruption", "Emergency detected during delivery navigation", {
            location: `${bot.system}/${bot.poi}`,
          });
          return;
        }
        ctx.log("error", `Failed to reach ${destSystem}`);
        logCargoActivity(bot.username, "error", `Failed to reach destination system ${destSystem}`, {
          location: `${bot.system}/${bot.poi}`,
        });
        allJobsCompleted = false;
        break;
      }
      ctx.log("cargo", `✅ Arrived at destination system ${destSystem}`);
      logCargoActivity(bot.username, "navigation", `Arrived at destination system ${destSystem}`, {
        location: destSystem,
      });
    }

    await ensureUndocked(ctx);
    if (bot.state !== "running") {
      ctx.log("system", "⛔ Stopping — emergency detected");
      logCargoActivity(bot.username, "interruption", "Emergency detected during destination approach", {
        location: `${bot.system}/${bot.poi}`,
      });
      return;
    }
    if (bot.poi !== extractStationId(settings.destinationStation)) {
      ctx.log("travel", `Traveling to ${settings.destinationStation}...`);
      logCargoActivity(bot.username, "navigation", `Traveling to destination station ${settings.destinationStation}`, {
        location: `${bot.system}: ${bot.poi} → ${settings.destinationStation}`,
      });
      const tResp = await bot.exec("travel", { target_poi: extractStationId(settings.destinationStation) });
      if (bot.state !== "running") {
        ctx.log("system", "⛔ Stopping — emergency detected");
        logCargoActivity(bot.username, "interruption", "Emergency detected during travel to destination", {
          location: `${bot.system}/${bot.poi}`,
        });
        return;
      }
      // Check for battle interruption after travel command
      if (await checkBattleAfterCommand(ctx, tResp.notifications, "travel", battleState)) {
        ctx.log("error", "Battle detected during travel to destination - fleeing!");
        logCargoActivity(bot.username, "battle_encounter", "Battle detected during travel to destination with cargo", {
          location: `${bot.system}/${bot.poi}`,
        });
        allJobsCompleted = false;
        await ctx.sleep(5000);
        continue;
      }
      if (tResp.error) {
        const errMsg = tResp.error.message.toLowerCase();
        // CRITICAL: Check for battle interrupt error
        if (tResp.error.code === "battle_interrupt" || errMsg.includes("interrupted by battle") || errMsg.includes("interrupted by combat")) {
          ctx.log("combat", `Travel to destination interrupted by battle! ${tResp.error.message} - fleeing!`);
          logCargoActivity(bot.username, "battle_encounter", "Travel interrupted by battle during cargo delivery", {
            location: `${bot.system}/${bot.poi}`,
            error: tResp.error.message,
          });
          allJobsCompleted = false;
          await ctx.sleep(5000);
          continue;
        }
        if (!errMsg.includes("already")) {
          // Check if it's a mobile station that moved
          if (settings.destinationStation === "mobile_capital" && (errMsg.includes("not found") || errMsg.includes("does not exist") || errMsg.includes("not present"))) {
            ctx.log("cargo", "Mobile capital not found at expected location, querying current system...");
            const currentSystem = await getMobileStationSystem(ctx, "frontier_station");
            if (currentSystem) {
              ctx.log("cargo", `Mobile capital is now in system ${currentSystem}`);
              // Navigate to the new system
              if (bot.system !== currentSystem) {
                ctx.log("travel", `Navigating to updated mobile capital system ${currentSystem}...`);
                const arrived = await navigateToSystem(ctx, currentSystem, safetyOpts);
                if (!arrived || bot.state !== "running") {
                  if (bot.state !== "running") {
                    ctx.log("system", "⛔ Stopping — emergency detected");
                    return;
                  }
                  ctx.log("error", `Failed to reach updated mobile capital system ${currentSystem}`);
                  logCargoActivity(bot.username, "error", `Failed to navigate to updated mobile capital system ${currentSystem}`, {
                    location: `${bot.system}/${bot.poi}`,
                  });
                  allJobsCompleted = false;
                  break;
                }
                ctx.log("cargo", `✅ Arrived at updated mobile capital system ${currentSystem}`);
              }
              // Retry travel to the station
              const retryResp = await bot.exec("travel", { target_poi: extractStationId(settings.destinationStation) });
              if (retryResp.error) {
                const retryErrMsg = retryResp.error.message.toLowerCase();
                if (!retryErrMsg.includes("already")) {
                  ctx.log("error", `Still failed to travel to mobile capital after relocation: ${retryResp.error.message}`);
                  logCargoActivity(bot.username, "error", `Travel to mobile capital failed after relocation: ${retryResp.error.message}`, {
                    location: `${bot.system}/${bot.poi}`,
                  });
                  allJobsCompleted = false;
                  break;
                }
              } else {
          bot.poi = extractStationId(settings.destinationStation);
              }
            } else {
              ctx.log("error", "Could not determine current location of mobile capital");
              logCargoActivity(bot.username, "error", "Could not query current location of mobile capital", {
                location: `${bot.system}/${bot.poi}`,
              });
              allJobsCompleted = false;
              break;
            }
          } else {
            ctx.log("error", `Travel to dest failed: ${tResp.error.message}`);
            logCargoActivity(bot.username, "error", `Travel to destination failed: ${tResp.error.message}`, {
              location: `${bot.system}/${bot.poi}`,
            });
            allJobsCompleted = false;
            break;
          }
        }
      } else {
        bot.poi = extractStationId(settings.destinationStation);
      }
    }

    yield "dock_dest";
    if (!await dockAtStation(ctx)) {
      ctx.log("error", "Could not dock at destination");
      logCargoActivity(bot.username, "error", "Could not dock at destination station", {
        location: `${bot.system}/${settings.destinationStation}`,
      });
      allJobsCompleted = false;
      break;
    }
    ctx.log("cargo", `✅ Docked at destination station ${settings.destinationStation}`);
    logCargoActivity(bot.username, "dock", `Docked at destination station ${settings.destinationStation}`, {
      location: `${bot.system}/${settings.destinationStation}`,
    });

    yield "deposit_items";
    await bot.refreshCargo();
    // Deposit ALL items in cargo to the destination
    const itemsToDeposit = [...bot.inventory];
    const deliveredItems: { itemId: string; quantity: number }[] = [];

    if (itemsToDeposit.length > 0) {
      ctx.log("cargo", `📦 Depositing ${itemsToDeposit.length} item type(s) to destination...`);
      for (const item of itemsToDeposit) {
        if (item.quantity <= 0) continue;
        // Skip fuel/energy cells
        const lower = item.itemId.toLowerCase();
        if (lower.includes("fuel") || lower.includes("energy_cell")) continue;

        const depositResult = await depositToDestination(
          ctx,
          item.itemId,
          item.quantity,
          settings.destinationStorageType,
          settings.destinationBotName,
        );
        if (depositResult.success) {
          ctx.log("cargo", `✅ Delivered ${depositResult.depositedQty}x ${item.name}`);
          deliveredItems.push({ itemId: item.itemId, quantity: depositResult.depositedQty });
        } else {
          ctx.log("error", `❌ Failed to deliver ${item.quantity}x ${item.name}`);
          allJobsCompleted = false;
        }
      }
      totalTrips++;
      currentTrip = totalTrips;

      // Update delivery tracking after successful delivery
      if (deliveredItems.length > 0) {
        const itemIds = deliveredItems.map((d) => d.itemId);
        const quantities = deliveredItems.map((d) => d.quantity);
        updateDeliveryTracking(ctx, itemIds, quantities, settings);

        // Remove delivered items from in-transit tracking
        removeInTransitItems(bot.username, settings.destinationStation, deliveredItems);
        ctx.log("cargo", `📦 Removed ${deliveredItems.length} item types from in-transit tracking (${deliveredItems.reduce((sum, d) => sum + d.quantity, 0)} total items delivered)`);

        // Update trip completion tracking
        for (const itemId of itemIds) {
          updateItemProgress(bot.username, itemId, { tripCompleted: true });
        }
      }
      
      // Log trip completion
      logCargoActivity(bot.username, "trip_complete", `Trip ${totalTrips} complete - delivered ${deliveredItems.length} item type(s)`, {
        location: `${bot.system}/${bot.poi}`,
        quantity: deliveredItems.reduce((sum, d) => sum + d.quantity, 0),
      });
    }

    await bot.refreshCargo();

    // Check if all jobs are complete (no remaining items for any job)
    for (const job of jobs) {
      const remaining = jobRemaining.get(job.itemId) || 0;
      if (remaining > 0) {
        allJobsCompleted = false;
        ctx.log("cargo", `${remaining}x ${job.itemName} still to move`);
      }
    }

    if (totalMoved > 0) {
      ctx.log("cargo", `📊 Moved ${totalMoved} items in ${totalTrips} trip(s)`);
    } else {
      ctx.log("cargo", "No items moved");
    }

    // If all jobs completed successfully, wait longer before restarting
    if (allJobsCompleted && jobs.length > 0) {
      ctx.log("info", "✅ All items moved successfully. Waiting 5 minutes before next cycle...");
      logCargoActivity(bot.username, "session_end", `All items moved successfully - ${totalMoved} items in ${totalTrips} trips`, {
        location: `${bot.system}/${bot.poi}`,
        quantity: totalMoved,
      });
      yield "return_or_wait";
      await dockAtStation(ctx);
      await tryRefuel(ctx);
      await repairShip(ctx);
      
      // Release all locks for completed items
      for (const job of jobs) {
        releaseQuantityLock(bot.username, job.itemId, "completed");
      }
      
      await ctx.sleep(300000);
      continue;
    }

    // Not all jobs completed — return to source station to continue
    ctx.log("cargo", "🔄 Returning to source station to continue moving items...");
    yield "return_to_source";

    // Travel back to source system if needed
    if (bot.system !== sourceSystem) {
      await ensureUndocked(ctx);
      if (bot.state !== "running") {
        ctx.log("system", "⛔ Stopping — emergency detected");
        logCargoActivity(bot.username, "interruption", "Emergency detected during return to source", {
          location: `${bot.system}/${bot.poi}`,
        });
        return;
      }
      const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
      if (!fueled) {
        ctx.log("error", "Cannot refuel to return to source");
        logCargoActivity(bot.username, "error", "Cannot refuel for return to source", {
          location: `${bot.system}/${bot.poi}`,
        });
        await ctx.sleep(30000);
        continue;
      }
      ctx.log("travel", `Heading back to ${sourceSystem}...`);
      logCargoActivity(bot.username, "navigation", `Returning to source system ${sourceSystem}`, {
        location: `${bot.system} → ${sourceSystem}`,
      });
      const arrived = await navigateToSystem(ctx, sourceSystem, safetyOpts);
      if (!arrived || bot.state !== "running") {
        if (bot.state !== "running") {
          ctx.log("system", "⛔ Stopping — emergency detected");
          logCargoActivity(bot.username, "interruption", "Emergency detected during return navigation", {
            location: `${bot.system}/${bot.poi}`,
          });
          return;
        }
        ctx.log("error", `Failed to reach ${sourceSystem}`);
        logCargoActivity(bot.username, "error", `Failed to return to source system ${sourceSystem}`, {
          location: `${bot.system}/${bot.poi}`,
        });
        await ctx.sleep(30000);
        continue;
      }
      ctx.log("cargo", `✅ Returned to source system ${sourceSystem}`);
    }

    // Travel to source station and dock
    await ensureUndocked(ctx);
    if (bot.state !== "running") {
      ctx.log("system", "⛔ Stopping — emergency detected");
      logCargoActivity(bot.username, "interruption", "Emergency detected during return to source station", {
        location: `${bot.system}/${bot.poi}`,
      });
      return;
    }
    if (bot.poi !== extractStationId(settings.sourceStation)) {
      ctx.log("travel", `Traveling back to ${settings.sourceStation}...`);
      logCargoActivity(bot.username, "navigation", `Returning to source station ${settings.sourceStation}`, {
        location: `${bot.system}: ${bot.poi} → ${settings.sourceStation}`,
      });
      const tResp = await bot.exec("travel", { target_poi: extractStationId(settings.sourceStation) });
      if (bot.state !== "running") {
        ctx.log("system", "⛔ Stopping — emergency detected");
        logCargoActivity(bot.username, "interruption", "Emergency detected during return travel", {
          location: `${bot.system}/${bot.poi}`,
        });
        return;
      }
      // Check for battle interruption after travel command
      if (await checkBattleAfterCommand(ctx, tResp.notifications, "travel", battleState)) {
        ctx.log("error", "Battle detected during return travel to source - fleeing!");
        logCargoActivity(bot.username, "battle_encounter", "Battle detected during return travel to source station", {
          location: `${bot.system}/${bot.poi}`,
        });
        await ctx.sleep(5000);
        continue;
      }
      if (tResp.error) {
        const errMsg = tResp.error.message.toLowerCase();
        // CRITICAL: Check for battle interrupt error
        if (tResp.error.code === "battle_interrupt" || errMsg.includes("interrupted by battle") || errMsg.includes("interrupted by combat")) {
          ctx.log("combat", `Return travel to source interrupted by battle! ${tResp.error.message} - fleeing!`);
          logCargoActivity(bot.username, "battle_encounter", "Return travel interrupted by battle to source station", {
            location: `${bot.system}/${bot.poi}`,
            error: tResp.error.message,
          });
          await ctx.sleep(5000);
          continue;
        }
        if (!errMsg.includes("already")) {
          ctx.log("error", `Travel to source failed: ${tResp.error.message}`);
          logCargoActivity(bot.username, "error", `Failed to travel back to source station: ${tResp.error.message}`, {
            location: `${bot.system}/${bot.poi}`,
          });
          await ctx.sleep(30000);
          continue;
        }
      }
      bot.poi = extractStationId(settings.sourceStation);
    }

    if (!await dockAtStation(ctx)) {
      ctx.log("error", "Could not dock at source");
      logCargoActivity(bot.username, "error", "Could not dock at source station for next cycle", {
        location: `${bot.system}/${settings.sourceStation}`,
      });
      await ctx.sleep(30000);
      continue;
    }
    
    ctx.log("cargo", "🔄 Back at source station — continuing operations");
    logCargoActivity(bot.username, "dock", `Docked at source station for next cycle`, {
      location: `${bot.system}/${settings.sourceStation}`,
    });
    
    // Save session state for potential recovery
    saveLastSession(
      bot.username,
      settings.sourceStation,
      settings.destinationStation,
      settings.items.map(i => ({ itemId: i.itemId, itemName: i.itemName, quantity: i.quantity, storageType: i.storageType || 'faction' })),
      currentTrip,
      "back_at_source",
      bot.system,
      bot.poi,
      true
    );
    
    await ctx.sleep(5000);
  }
};
