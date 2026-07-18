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
  sleep,
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
  setItemSize,
  cargoUsedFromInventory,
  maxItemsForCargo,
  enableCloakingIfPossible,
  type BattleState,
} from "./common.js";
import {
  logCargoActivity,
  saveLastSession,
  clearLastSession,
  getLastSession,
  startItemProgress,
  updateItemProgress,
  getItemProgress,
  loadCargoMoverActivity,
  saveCargoMoverActivity,
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
  getItemLocks,
  getAvailableItemQuantity,
  getBotClaimedQuantity,
  canClaimItemQuantity,
  cleanupStaleLocks,
} from "./cargoMoverCoordination.js";
import {
  addInTransitItems,
  removeInTransitItems,
  getInTransitQuantity,
  getInTransitSummary,
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
  totalDelivered?: number;
  totalToDeliver?: number;
  shipLoadoutDestination?: string;
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
  militaryFuelCells: number;
  ignorePiratesWhenCloaked: boolean;
  ignoreBlacklistWhenCloaked: boolean;
  /** Bulk-move sub-routine: move EVERYTHING from the source faction storage to
   *  the destination instead of the hand-picked `items` list. */
  enableBulkMove: boolean;
  /** Skip any source item whose stored quantity exceeds this (it will never fit
   *  at the destination and would just error). Default 500000. */
  bulkIgnoreOver: number;
  /** Transfer ordering: alphabetical, reverse alphabetical, or random. */
  bulkOrder: "alphabetical" | "reverse_alphabetical" | "random";
  /** Seed-base mode: first move a small amount of every item so the destination
   *  has a presence of each, then switch to full moving once all items are present. */
  bulkSeedMode: boolean;
  /** Amount per item to seed during seed-base mode. */
  bulkSeedAmount: number;
}

export function getCargoMoverSettings(username?: string): CargoMoverSettings {
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
      shipLoadoutDestination: item.shipLoadoutDestination as string | undefined,
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
    militaryFuelCells: (t.militaryFuelCells as number) || 10,
    // When cloaked a ship cannot be ambushed, so (default ON) it may ignore
    // pirates and blacklisted systems while cloaked.
    ignorePiratesWhenCloaked: (botOverrides.ignorePiratesWhenCloaked as boolean) ?? (t.ignorePiratesWhenCloaked as boolean) ?? true,
    ignoreBlacklistWhenCloaked: (botOverrides.ignoreBlacklistWhenCloaked as boolean) ?? (t.ignoreBlacklistWhenCloaked as boolean) ?? true,
    enableBulkMove: (t.enableBulkMove as boolean) ?? false,
    bulkIgnoreOver: (t.bulkIgnoreOver as number) || 500000,
    bulkOrder: (t.bulkOrder as "alphabetical" | "reverse_alphabetical" | "random") || "alphabetical",
    bulkSeedMode: (t.bulkSeedMode as boolean) ?? false,
    bulkSeedAmount: (t.bulkSeedAmount as number) || 10,
  };
}

/** Resolve station ID to system ID using mapStore.
 *  Matches on the POI hex id OR the friendly POI/base name (and on the system
 *  part when present) so an unresolved hex id and a friendly name for the same
 *  station both resolve to the same system. */
export function resolveStationSystem(stationId: string): string | null {
  if (!stationId) return null;

  // system|station format: trust the system part when present and resolvable.
  if (stationId.includes('|')) {
    const systemPart = stationId.split('|')[0];
    const sys = mapStore.getSystem(systemPart);
    if (sys) return sys.id;
  }

  const resolved = mapStore.resolveStationIdentity(stationId);
  if (resolved.systemId) return resolved.systemId;

  // Fallback: brute-force scan (handles any representation not yet resolved).
  const allSystems = mapStore.getAllSystems();
  for (const [sysId, sys] of Object.entries(allSystems)) {
    for (const poi of sys.pois) {
      const token = stationId.toLowerCase();
      if (poi.id.toLowerCase() === token ||
          (poi.base_id && poi.base_id.toLowerCase() === token) ||
          (poi.name && poi.name.toLowerCase() === token) ||
          (poi.base_name && poi.base_name.toLowerCase() === token)) {
        return sysId;
      }
    }
  }
  return null;
}

/** True when the bot's current POI matches the configured station reference,
 *  comparing on BOTH the hex POI id and the friendly POI name via mapStore so
 *  an unresolved hex id and a friendly name are never treated as different
 *  stations (which would otherwise make us misroute or lose cargo). */
function botIsAtStation(bot: Bot, stationRef: string): boolean {
  if (!bot.poi) return false;
  if (mapStore.sameStation(bot.poi, stationRef)) return true;
  // Also accept the legacy system|token form where bot.poi is the token half.
  if (stationRef.includes('|') && mapStore.sameStation(bot.poi, stationRef.split('|')[1])) {
    return true;
  }
  return false;
}

/** Resolve a station reference to the POI token to hand to travel/dock. */
function stationTravelTarget(stationRef: string): string {
  return mapStore.resolveStationTarget(stationRef);
}

/** True when an item in this bot's cargo is actually cargo THIS bot is supposed
 *  to be transporting under the current settings — i.e. it is a configured item
 *  whose effective destination matches `settings.destinationStation`, OR it is
 *  recorded in the shared in-transit tracking as this bot's cargo bound for that
 *  destination. Used by the startup recovery + clear-cargo steps so a bot never
 *  mistakes another bot's (or a different movement's) cargo for something to
 *  reroute/misdeliver, and never strands its own transit cargo as "unrelated". */
function isThisBotsTransitCargo(
  itemId: string,
  botUsername: string,
  settings: CargoMoverSettings,
): boolean {
  const lower = itemId.toLowerCase();
  if (lower.includes("fuel") || lower.includes("energy_cell")) return false;

  const effectiveDest = settings.destinationStation;
  const isConfigured = settings.items.some((ci) => {
    if (ci.itemId !== itemId) return false;
    // An item configured with its own per-item destination still counts as
    // "ours" only when that destination is the one we're currently serving.
    const itemDest = ci.shipLoadoutDestination || settings.destinationStation;
    return itemDest === effectiveDest;
  });
  if (isConfigured) return true;

  // Not in our item list — but maybe we legitimately loaded it and it's still
  // tracked as in-transit under our name for this destination.
  const inTransitSelf = getInTransitQuantity(itemId, effectiveDest, botUsername);
  return inTransitSelf > 0;
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

/** Item ids that should NEVER be bulk-moved (operational fuel/energy cells). */
function isBulkSkipItem(itemId: string): boolean {
  const lower = itemId.toLowerCase();
  return (
    lower === "premium_fuel_cell" ||
    lower === "military_fuel_cell" ||
    lower.includes("energy_cell")
  );
}

/** Dynamically-generated packages (`package:*`). They are NOT in the local
 *  catalog and we must NOT inspect them (each inspect is a rate-limited network
 *  command that gets us banned in bulk), so we never load or move them. Their
 *  cargo size is the fixed PACKAGE_CARGO_SIZE constant from common.ts. */
function isPackageItem(itemId: string): boolean {
  return itemId.startsWith("package:");
}

/** Operational cells that must NEVER be deposited at the destination — they
 *  power the ship itself (premium cells, energy cells). Regular `fuel_cell` is
 *  treated as ordinary cargo and delivered normally; `military_fuel_cell` is
 *  deposited only above the user-configured reserve (see fuelDepositQty). */
function isNeverDepositFuelItem(itemId: string): boolean {
  const lower = itemId.toLowerCase();
  return lower === "premium_fuel_cell" || lower.includes("energy_cell");
}

/** How many of an item to deposit at the destination, reserving the ship's
 *  required operational fuel. For military fuel cells we always keep the
 *  user-configured reserve (default 10) aboard for in-transit refueling and
 *  deposit only any excess; everything else deposits in full. */
function fuelDepositQty(itemId: string, quantity: number, reserve: number): number {
  if (itemId === "military_fuel_cell") {
    return Math.max(0, quantity - Math.max(0, reserve));
  }
  return quantity;
}

/** Re-cloak the ship whenever it is undocked and has a cloak module.
 * Returns true if the bot ended up cloaked. The `warnedNoCloak` ref is used to
 * emit the "no module" warning only once per session so the log stays clean. */
async function ensureCloaked(
  ctx: RoutineContext,
  warnedNoCloak: { warned: boolean },
): Promise<boolean> {
  const { bot } = ctx;

  // Cannot cloak while docked — nothing to do right now.
  if (bot.docked) return bot.isCloaked;

  if (bot.isCloaked) {
    logCargoActivity(bot.username, "cloak", "Cloak already active", {
      location: `${bot.system}/${bot.poi}`,
    });
    return true;
  }

  const cloaked = await enableCloakingIfPossible(ctx);
  if (cloaked) {
    logCargoActivity(bot.username, "cloak", "Cloaking enabled (ship has cloak module)", {
      location: `${bot.system}/${bot.poi}`,
    });
  } else if (!warnedNoCloak.warned) {
    warnedNoCloak.warned = true;
    logCargoActivity(bot.username, "cloak", "No cloaking module available — could not cloak", {
      location: `${bot.system}/${bot.poi}`,
    });
  }
  return cloaked;
}

/** Undock and re-cloak (if undocked). Use before any jump/travel so the ship is
 * always cloaked while in transit whenever a cloak module is present. */
async function undockForTravel(
  ctx: RoutineContext,
  warnedNoCloak: { warned: boolean },
): Promise<void> {
  await ensureUndocked(ctx);
  await ensureCloaked(ctx, warnedNoCloak);
}

/** Ensure the bot carries the user-configured number of military fuel cells
 * (default 10). These power in-transit refueling and are NEVER delivered to the
 * destination (fuel cells are excluded from deposits). Loads from faction
 * storage first, then falls back to buying from the market. */
async function ensureMilitaryFuelCells(
  ctx: RoutineContext,
  targetCount: number,
): Promise<number> {
  const { bot } = ctx;
  if (targetCount <= 0) return 0;

  await bot.refreshCargo();
  const have = bot.inventory.find((i) => i.itemId === "military_fuel_cell")?.quantity || 0;
  if (have >= targetCount) {
    ctx.log("cargo", `✅ Already carrying ${have}x military_fuel_cell (target ${targetCount})`);
    return have;
  }

  const needed = targetCount - have;
  ctx.log("cargo", `🔋 Loading ${needed}x military_fuel_cell (have ${have}/${targetCount})...`);
  logCargoActivity(bot.username, "fuel_cells", `Loading ${needed}x military_fuel_cell for trip (have ${have}/${targetCount})`, {
    location: `${bot.system}/${bot.poi}`,
    quantity: needed,
  });

  // Try faction storage first (move faction → station → cargo).
  const inFaction = bot.factionStorage.find((i) => i.itemId === "military_fuel_cell");
  if (inFaction && inFaction.quantity > 0) {
    const qty = Math.min(needed, inFaction.quantity);
    const fResp = await bot.exec("storage", {
      action: "deposit",
      target: "self",
      item_id: "military_fuel_cell",
      quantity: qty,
      source: "faction",
    });
    if (!fResp.error) {
      await bot.refreshStorage();
      const wResp = await bot.exec("withdraw_items", { item_id: "military_fuel_cell", quantity: qty });
      if (!wResp.error) {
        await bot.refreshCargo();
      }
    }
  }

  // Fallback: buy from the market.
  const haveAfterFaction = bot.inventory.find((i) => i.itemId === "military_fuel_cell")?.quantity || 0;
  if (haveAfterFaction < targetCount) {
    const stillNeed = targetCount - haveAfterFaction;
    const buyResp = await bot.exec("buy", { item_id: "military_fuel_cell", quantity: stillNeed });
    if (!buyResp.error) {
      await bot.refreshCargo();
    } else {
      ctx.log("warn", `Could not buy military_fuel_cell from market: ${buyResp.error.message}`);
    }
  }

  const finalHave = bot.inventory.find((i) => i.itemId === "military_fuel_cell")?.quantity || 0;
  if (finalHave >= targetCount) {
    logCargoActivity(bot.username, "fuel_cells", `Military fuel cells loaded to target ${finalHave}/${targetCount}`, {
      location: `${bot.system}/${bot.poi}`,
      quantity: finalHave,
    });
  } else {
    logCargoActivity(bot.username, "fuel_cells", `Only loaded ${finalHave}/${targetCount} military_fuel_cell (source low)`, {
      location: `${bot.system}/${bot.poi}`,
      quantity: finalHave,
    });
  }
  return finalHave;
}

/** Withdraw items from specified storage type into cargo. */
async function withdrawFromStorage(
  ctx: RoutineContext,
  itemId: string,
  quantity: number,
  storageType: 'faction' | 'personal',
): Promise<{ success: boolean; withdrawnQty: number; availableSpace?: number }> {
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
  // Ground-truth free cargo space parsed from a cargo_full error ("only N available").
  // The game's cached bot.cargo can lag a tick; when we see a cargo_full we trust
  // the server's own "available" figure so the caller stops over-probing a full hold.
  let cargoFullAvailable: number | undefined;

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
    let actualQty = Math.min(quantity, inFaction.quantity);

    // Step 1: Move from faction storage to station storage
    let factionResp = await bot.exec("storage", { action: "deposit", target: "self", item_id: itemId, quantity: actualQty, source: "faction" });
    if (factionResp.error) {
      const msg = factionResp.error.message.toLowerCase();
      const invalidQty = msg.includes("invalid_quantity") || msg.includes("must be transferred with quantity");
      if (invalidQty) {
        ctx.log("warn", `Faction transfer requires quantity 1 for ${itemId} — retrying single-unit transfer`);
        factionResp = await bot.exec("storage", { action: "deposit", target: "self", item_id: itemId, quantity: 1, source: "faction" });
        actualQty = 1;
      }
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
    }

    await bot.refreshStorage();

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
      // We do NOT re-attempt the withdraw here — that would be "cheating" by
      // mining the error message for the exact amount to load. Instead we use
      // the error purely to (a) learn the item's true cargo size and (b) learn
      // the server's authoritative free space, then return so the LOAD LOOP can
      // compute the correct quantity on its next pass and load it cleanly. The
      // loop already skips items that won't fit and stops once the hold is full.
      const spaceMatch = wResp.error.message.match(/Need (\d+) but only (\d+) available/);
      if (spaceMatch) {
        const neededSpace = parseInt(spaceMatch[1], 10);
        const availableSpace = parseInt(spaceMatch[2], 10);
        cargoFullAvailable = availableSpace;
        const actualItemSize = neededSpace / Math.max(1, actualQty);
        setItemSize(itemId, actualItemSize);
        ctx.log("cargo", `Cargo full loading ${itemId}: learned size=${actualItemSize.toFixed(1)}, ${availableSpace} space free — load loop will take the exact amount next pass`);
      } else {
        const fallbackMatch = wResp.error.message.match(/only (\d+) available/);
        const availableSpace = fallbackMatch ? parseInt(fallbackMatch[1], 10) : Math.max(1, Math.floor(actualQty / 2));
        cargoFullAvailable = availableSpace;
        ctx.log("cargo", `Cargo full loading ${itemId}: ${availableSpace} space free — load loop will take the exact amount next pass`);
      }
    }
    ctx.log("error", `Withdraw from faction failed: ${wResp.error.message}`);
    logCargoActivity(bot.username, "withdraw_failed", `Failed to withdraw ${itemId} from faction storage: ${wResp.error.message}`, {
      itemId,
      quantity,
      location: `${bot.system}/${bot.poi}`,
      error: wResp.error.message,
    });
    return { success: false, withdrawnQty: 0, availableSpace: cargoFullAvailable };
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
      // Same as the faction branch: do NOT re-attempt the withdraw here. Learn
      // the true size + authoritative free space from the error and let the load
      // loop take the exact amount on its next pass.
      const spaceMatch = wResp.error.message.match(/Need (\d+) but only (\d+) available/);
      if (spaceMatch) {
        const neededSpace = parseInt(spaceMatch[1], 10);
        const availableSpace = parseInt(spaceMatch[2], 10);
        cargoFullAvailable = availableSpace;
        const actualItemSize = neededSpace / Math.max(1, actualQty);
        setItemSize(itemId, actualItemSize);
        ctx.log("cargo", `Cargo full loading ${itemId}: learned size=${actualItemSize.toFixed(1)}, ${availableSpace} space free — load loop will take the exact amount next pass`);
      } else {
        const fallbackMatch = wResp.error.message.match(/only (\d+) available/);
        const availableSpace = fallbackMatch ? parseInt(fallbackMatch[1], 10) : Math.max(1, Math.floor(actualQty / 2));
        cargoFullAvailable = availableSpace;
        ctx.log("cargo", `Cargo full loading ${itemId}: ${availableSpace} space free — load loop will take the exact amount next pass`);
      }
    }
    logCargoActivity(bot.username, "withdraw_failed", `Failed to withdraw ${itemId} from personal storage: ${wResp.error.message}`, {
      itemId,
      quantity,
      location: `${bot.system}/${bot.poi}`,
      error: wResp.error.message,
    });
    return { success: false, withdrawnQty: 0, availableSpace: cargoFullAvailable };
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
    // Read the faction storage of the station we're CURRENTLY docked at. Remote
    // station_id lookups are failing ("Station not found"), so instead of guessing
    // the station id we (re)confirm our location via get_location, then do a
    // plain view_faction_storage with NO station_id — the server resolves that to
    // the current docked station. Both the baseline and the after-deposit
    // verification read the same (current) station, so a successful deposit is
    // verified correctly instead of being read back from the wrong station.
    await bot.refreshLocation();
    await bot.refreshFactionStorage(false, undefined, true);
    const factionBefore = bot.factionStorage.find((i) => i.itemId === itemId)?.quantity || 0;

    const dResp = await bot.exec("faction_deposit_items", { item_id: itemId, quantity });
    if (!dResp.error) {
      // The game server caches faction-storage reads, so a refresh issued
      // immediately after the deposit can still return the pre-deposit snapshot
      // and make a successful deposit look like a silent failure. Give the cache
      // a beat to invalidate, then refresh — retry a few times so transient
      // staleness isn't reported as a failed delivery.
      let actuallyDeposited = 0;
      for (let attempt = 1; attempt <= 3; attempt++) {
        await sleep(1000);
        await bot.refreshLocation();
        await bot.refreshFactionStorage(false, undefined, true);
        const factionAfter = bot.factionStorage.find((i) => i.itemId === itemId)?.quantity || 0;
        actuallyDeposited = Math.max(0, factionAfter - factionBefore);
        if (actuallyDeposited > 0) break;
        ctx.log("warn", `⚠️ Faction storage still unchanged after refresh (attempt ${attempt}/3) for ${itemId} — retrying verification...`);
      }

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

    const factionCapErr = dResp.error.message.toLowerCase().includes("storage_cap_exceeded") ||
      dResp.error.message.toLowerCase().includes("cap reached") ||
      dResp.error.message.toLowerCase().includes("too many") ||
      dResp.error.message.toLowerCase().includes("maximum") ||
      dResp.error.message.toLowerCase().includes("full");
    if (factionCapErr) {
      ctx.log("warn", `⚠️ Faction storage full for ${itemId} — falling back to personal (station) storage deposit`);
      const fallback = await depositToDestination(ctx, itemId, quantity, "personal");
      if (fallback.success) {
        return fallback;
      }
    }

    return { success: false, depositedQty: 0 };
  }

  // Personal storage - use deposit_items command (cargo → personal storage)
  // Check personal storage before deposit for verification
  const personalBefore = bot.storage.find((i) => i.itemId === itemId)?.quantity || 0;

  const dResp = await bot.exec("deposit_items", { item_id: itemId, quantity });
  if (!dResp.error) {
    // Same server-side read caching as faction storage: pause and refresh a
    // few times so a just-completed deposit isn't mistaken for a silent failure.
    let actuallyDeposited = 0;
    for (let attempt = 1; attempt <= 3; attempt++) {
      await sleep(1000);
      await bot.refreshStorage();
      const personalAfter = bot.storage.find((i) => i.itemId === itemId)?.quantity || 0;
      actuallyDeposited = Math.max(0, personalAfter - personalBefore);
      if (actuallyDeposited > 0) break;
      ctx.log("warn", `⚠️ Personal storage still unchanged after refresh (attempt ${attempt}/3) for ${itemId} — retrying verification...`);
    }

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

/**
 * Batch-withdraw a set of items from faction/personal storage into cargo in a
 * SINGLE game action (one tick) instead of one command per item. Uses the
 * unified v2 `storage` command with an `items` array; the server moves every
 * requested stack in one write and reports per-item success. This removes the
 * per-item withdrawal delay that previously dominated the load loop.
 *
 * The actually-moved quantity of each item is computed from a before/after
 * cargo diff (immune to response-shape differences and to the lagging
 * `bot.cargo` cache), so the caller's quantity accounting stays exact even when
 * the hold fills partway through the batch.
 *
 * @returns A map of itemId -> quantity actually moved into cargo.
 */
async function bulkWithdrawFromStorage(
  ctx: RoutineContext,
  requested: Array<{ itemId: string; quantity: number }>,
  storageType: 'faction' | 'personal',
): Promise<Map<string, number>> {
  const { bot } = ctx;
  const valid = requested.filter((r) => r.itemId && r.quantity > 0);
  const moved = new Map<string, number>();
  if (valid.length === 0) return moved;

  const before = new Map(bot.inventory.map((i) => [i.itemId, i.quantity]));

  const resp = await bot.exec("storage", {
    action: "withdraw",
    source: storageType,
    items: valid.map((r) => ({ item_id: r.itemId, quantity: r.quantity })),
  });

  await bot.refreshCargo();
  if (storageType === 'faction') {
    await bot.refreshFactionStorage(false, undefined, true);
  } else {
    await bot.refreshStorage();
  }

  if (resp.error) {
    // A whole-batch failure (e.g. cargo already full, station service issue).
    // Return whatever the cargo diff shows landed; the caller re-checks space
    // and falls back to per-item withdrawal for anything still pending.
    ctx.log("warn", `Bulk withdraw failed: ${resp.error.message} — diffing cargo for partial moves`);
  }

  const after = new Map(bot.inventory.map((i) => [i.itemId, i.quantity]));
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const delta = (after.get(id) || 0) - (before.get(id) || 0);
    if (delta > 0) moved.set(id, delta);
  }
  return moved;
}

/**
 * Batch-deposit a set of cargo items to the destination in a SINGLE game action
 * (one tick) instead of one command per item, using the unified v2 `storage`
 * command with an `items` array. `faction`/`personal` targets go through the
 * `storage` command; `send_gift` still uses the per-item `send_gift` path (the
 * unified storage command does not gift) — see `depositToDestination`.
 *
 * The actually-deposited quantity of each item is computed from a before/after
 * storage diff so the caller's delivered-count accounting stays exact.
 *
 * @returns A map of itemId -> quantity actually deposited.
 */
async function bulkDepositToDestination(
  ctx: RoutineContext,
  items: Array<{ itemId: string; quantity: number }>,
  storageType: "faction" | "personal" | "send_gift",
  destinationBotName?: string,
): Promise<Map<string, number>> {
  const { bot } = ctx;
  const valid = items.filter((r) => r.itemId && r.quantity > 0);
  const deposited = new Map<string, number>();
  if (valid.length === 0) return deposited;

  if (storageType === "send_gift") {
    // Delegate to the per-item gift path (it already verifies each gift left
    // cargo). Aggregate the per-item results.
    for (const it of valid) {
      const res = await depositToDestination(ctx, it.itemId, it.quantity, "send_gift", destinationBotName);
      if (res.success && res.depositedQty > 0) {
        deposited.set(it.itemId, (deposited.get(it.itemId) || 0) + res.depositedQty);
      }
    }
    return deposited;
  }

  const before = new Map<string, number>();
  if (storageType === "faction") {
    await bot.refreshFactionStorage(false, undefined, true);
    for (const i of bot.factionStorage) before.set(i.itemId, i.quantity);
  } else {
    await bot.refreshStorage();
    for (const i of bot.storage) before.set(i.itemId, i.quantity);
  }

  const resp = await bot.exec("storage", {
    action: "deposit",
    target: storageType,
    items: valid.map((r) => ({ item_id: r.itemId, quantity: r.quantity })),
  });

  // Server-side storage reads can lag a tick; pause briefly then refresh so the
  // before/after diff sees the deposit.
  await sleep(1000);
  if (storageType === "faction") {
    await bot.refreshFactionStorage(false, undefined, true);
    for (const i of bot.factionStorage) {
      const b = before.get(i.itemId) || 0;
      const delta = i.quantity - b;
      if (delta > 0) deposited.set(i.itemId, (deposited.get(i.itemId) || 0) + delta);
    }
  } else {
    await bot.refreshStorage();
    for (const i of bot.storage) {
      const b = before.get(i.itemId) || 0;
      const delta = i.quantity - b;
      if (delta > 0) deposited.set(i.itemId, (deposited.get(i.itemId) || 0) + delta);
    }
  }

  if (resp.error) {
    ctx.log("warn", `Bulk deposit failed: ${resp.error.message} — counted ${deposited.size} item type(s) via storage diff`);
  }
  return deposited;
}

/** Deliver every deliverable item currently in the hold to the destination.
 *  Used by the graceful-shutdown path so cargo is never abandoned when the
 *  routine is asked to stop. Fuel cells are never deposited (see
 *  isNeverDepositFuelItem / fuelDepositQty). Returns the delivered items. */
async function deliverCargoAboard(
  ctx: RoutineContext,
  settings: CargoMoverSettings,
): Promise<{ itemId: string; quantity: number }[]> {
  const { bot } = ctx;

  await bot.refreshCargo();
  const items = [...bot.inventory];
  const delivered: { itemId: string; quantity: number }[] = [];

  for (const item of items) {
    if (item.quantity <= 0) continue;
    // Premium/energy cells never leave the ship; military cells keep the
    // required reserve aboard and deposit only the excess.
    if (isNeverDepositFuelItem(item.itemId)) continue;
    const depositQty = fuelDepositQty(item.itemId, item.quantity, settings.militaryFuelCells);
    if (depositQty <= 0) {
      ctx.log("cargo", `🔋 Keeping ${item.quantity}x ${item.itemId} aboard (reserve ${settings.militaryFuelCells} required) — not depositing`);
      continue;
    }
    const result = await depositToDestination(
      ctx,
      item.itemId,
      depositQty,
      settings.destinationStorageType,
      settings.destinationBotName,
    );
    if (result.success) {
      ctx.log("cargo", `✅ Delivered ${result.depositedQty}x ${item.name}`);
      delivered.push({ itemId: item.itemId, quantity: result.depositedQty });
    }
  }

  if (delivered.length > 0) {
    const itemIds = delivered.map((d) => d.itemId);
    const quantities = delivered.map((d) => d.quantity);
    updateDeliveryTracking(ctx, itemIds, quantities, settings);
    // Remove delivered items from in-transit tracking.
    removeInTransitItems(bot.username, settings.destinationStation, delivered);
    ctx.log("cargo", `📦 Removed ${delivered.length} item type(s) from in-transit tracking after graceful delivery`);
  }

  return delivered;
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
    // Packages are dynamically generated, not in the catalog, and must never be
    // loaded (no inspect, fixed size) — skip them entirely from planning.
    if (isPackageItem(configItem.itemId)) {
      ctx.log("cargo", `  ${configItem.itemName}: skipping package:* (not cargo-mover eligible)`);
      continue;
    }

    // Delivered progress = max of persisted settings count and activity-log
    // progress (robust across restarts / manual edits).
    const delivered = Math.max(
      configItem.totalDelivered || 0,
      getItemProgress(bot.username, configItem.itemId)?.totalDelivered || 0,
    );

    // Skip if this item's delivery target (if configured) is already met.
    if (configItem.totalToDeliver !== undefined && configItem.totalToDeliver > 0) {
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
    
    // Determine destination station - use shipLoadoutDestination if set, otherwise global destination
    const effectiveDestStation = configItem.shipLoadoutDestination || settings.destinationStation;
    const effectiveDestSystem = resolveStationSystem(effectiveDestStation) || destSystem;
    
    // Check how much is already claimed by other bots (quantity-based locking)
    let availableQty = getAvailableItemQuantity(
      configItem.itemId,
      totalAvailable,
      bot.username
    );

    // Subtract items already in transit to this destination
    const inTransitQty = getInTransitQuantity(configItem.itemId, effectiveDestStation);
    availableQty = Math.max(0, availableQty - inTransitQty);
    
    const alreadyClaimed = getBotClaimedQuantity(bot.username, configItem.itemId);

    // Target = configured quantity (or totalToDeliver if set), minus what's
    // already delivered and what's already in transit. This way we never assume
    // every configured item is still at the source — in-transit items are already
    // loaded (possibly in another mover's hold) and must not be re-moved.
    const deliveryTarget =
      (configItem.totalToDeliver && configItem.totalToDeliver > 0)
        ? configItem.totalToDeliver
        : (configItem.quantity > 0 ? configItem.quantity : 0);
    const baseTargetQty = deliveryTarget > 0 ? deliveryTarget : availableQty;
    const effectiveTargetQty = Math.max(0, baseTargetQty - delivered - inTransitQty);

    ctx.log("cargo", `  ${configItem.itemName}: inStorage=${inStorage}, inCargo=${inCargo}, totalAvailable=${totalAvailable}, availableForBot=${availableQty}, inTransit=${inTransitQty}, delivered=${delivered}, effectiveTarget=${effectiveTargetQty}, alreadyClaimed=${alreadyClaimed} (storageType=${storageType})`);

    if (effectiveTargetQty > 0 && availableQty > 0) {
      const blacklist = (settings.ignoreBlacklistWhenCloaked && ctx.bot.isCloaked) ? [] : getSystemBlacklist();
      const route = mapStore.findRoute(sourceSystem, effectiveDestSystem, blacklist);
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
        destSystem: effectiveDestSystem,
        destStation: effectiveDestStation,
        jumps,
      });
    } else if (availableQty <= 0 && alreadyClaimed > 0) {
      ctx.log("cargo", `  ${configItem.itemName}: all claimed by other bots, but bot has ${alreadyClaimed}x locked — will continue delivering`);
    } else if (availableQty <= 0) {
      ctx.log("cargo", `  ${configItem.itemName}: no available quantity (all claimed by other bots or empty)`);
    }
  }

  // Limit locked quantity per item to allow multiple bots to work on the same
  // items concurrently WITHOUT over-claiming the shared hold. The concurrency
  // divisor is the real number of distinct bots that currently hold an ACTIVE
  // lock on this item (including this bot), not a hardcoded guess. A lone bot
  // therefore gets the FULL hold (divisor 1); two bots split it 50/50, etc.
  // Using a fixed "/2" here when only one bot is running was capping every load
  // at half the hold and hauling only ~half of what fits.
  for (const job of jobs) {
    const itemSize = getItemSize(job.itemId);
    const itemLocks = getItemLocks(job.itemId);
    const concurrentBots = Math.max(1, itemLocks.length);
    const share = Math.floor(bot.cargoMax / itemSize / concurrentBots);
    // The bot that is about to load should always be able to fill its own share;
    // never let the divisor drop an otherwise-full hold below what one bot can carry.
    job.availableQty = Math.min(job.availableQty, Math.max(share, Math.floor(bot.cargoMax / itemSize)));
  }

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

/**
 * Reconcile delivered counts against the DESTINATION's actual faction storage.
 *
 * After a bug corrupted the per-item `totalDelivered` (and in-transit) counts,
 * the source of truth for "what actually arrived" is the destination station's
 * faction storage — it physically holds whatever was delivered. This reads the
 * destination storage (remotely, no travel needed) and sets each configured
 * item's `totalDelivered` to the quantity currently sitting at the destination
 * (capped at the item's delivery target when one is set). It updates both the
 * settings mirror and the activity-progress record so `findMoveJobs` and the
 * dashboard agree.
 *
 * Only meaningful for `faction` destinations (the only ones with a queryable
 * faction storage). For `personal` / `send_gift` destinations there is no
 * single reconcilable store, so this is a no-op and reports 0 reconciled.
 *
 * @returns A summary of what changed, for logging / the API response.
 */
export async function reconcileDeliveredWithDestination(
  ctx: RoutineContext,
  settings: CargoMoverSettings,
): Promise<{ reconciled: number; changed: Array<{ itemId: string; itemName: string; oldDelivered: number; newDelivered: number }>; stationId?: string | null; readError?: string }> {
  const { bot } = ctx;
  if (settings.destinationStorageType !== "faction") {
    ctx.log("cargo", `⚠️ Reconcile skipped: destination storage type is "${settings.destinationStorageType}" (only faction destinations can be reconciled)`);
    return { reconciled: 0, changed: [], stationId: settings.destinationStation, readError: "not a faction destination" };
  }

  // Remote read of the destination's faction storage (no need to travel there).
  //
  // The server's view_faction_storage `station_id` identifies a faction BASE by
  // its base_id (e.g. "7d1f97987d5eb46bf603b8027e1eec8c"), which is exactly
  // what the UI stores in settings.destinationStation. We try several id forms
  // in order until one returns data, so a base_id / poi_id / system|poi
  // reference all work regardless of how the station was configured:
  //   1. the raw configured value (usually the base_id the server wants)
  //   2. mapStore's resolved POI hex id
  // This guarantees we read the REAL destination and never silently fall back
  // to whatever storage the bot last touched.
  const candidates: string[] = [];
  const raw = settings.destinationStation;
  if (raw) {
    candidates.push(raw);
    const resolved = mapStore.resolveStationIdentity(raw);
    if (resolved.matched && resolved.poiId && resolved.poiId !== raw) {
      candidates.push(resolved.poiId);
    }
  }
  // De-dupe while preserving order.
  const triedIds = [...new Set(candidates)];

  let destResp: any = { error: { message: "no station configured" } };
  let usedStationId: string | null = null;
  for (const tryId of triedIds) {
    ctx.log("cargo", `🔄 Reconcile: trying view_faction_storage station_id=${tryId}`);
    const resp = await bot.exec("view_faction_storage", { station_id: tryId });
    if (!resp.error) {
      destResp = resp;
      usedStationId = tryId;
      break;
    }
    ctx.log("cargo", `🔄 Reconcile: station_id=${tryId} failed: ${resp.error.message}`);
  }

  if (destResp.error || !usedStationId) {
    const msg = destResp.error?.message || "unknown error";
    ctx.log("error", `⚠️ Reconcile failed: could not read destination faction storage for any candidate id (${triedIds.join(", ")}): ${msg}`);
    return { reconciled: 0, changed: [], stationId: triedIds[0] || raw, readError: msg };
  }

  ctx.log("cargo", `🔄 Reconcile: READ destination faction storage via station_id=${usedStationId}`);

  const destQty = new Map<string, number>();
  const destResult = (destResp.result as Record<string, unknown>) || {};
  const destItems = (
    Array.isArray(destResult.items) ? destResult.items :
    Array.isArray(destResult.stored_items) ? destResult.stored_items :
    Array.isArray(destResult.faction_items) ? destResult.faction_items :
    Array.isArray(destResult.faction_storage) ? destResult.faction_storage :
    []
  ) as Array<Record<string, unknown>>;
  for (const i of destItems) {
    const id = (((i.item_id as string) || (i.id as string) || "") as string).replace(/ /g, "_").toLowerCase();
    const qty = (i.quantity as number) || (i.count as number) || 0;
    if (id && qty > 0) destQty.set(id, qty);
  }
  ctx.log("cargo", `🔄 Reconcile: destination (${usedStationId}) holds ${destQty.size} item type(s): ${[...destQty.entries()].map(([k, v]) => `${k}=${v}`).join(", ")}`);

  const all = readSettings();
  const cargoMover = all.cargo_mover || {};
  const items = (cargoMover.items as Array<Record<string, unknown>>) || [];
  const changed: Array<{ itemId: string; itemName: string; oldDelivered: number; newDelivered: number }> = [];

  // COMPLETE OVERWRITE: set every configured item's delivered count to exactly
  // what the destination actually holds (capped at any delivery target), and
  // zero out configured items that are not present at the destination. This
  // discards any inflated/stale cumulative counts.
  for (const configItem of settings.items) {
    const actual = destQty.get(configItem.itemId) || 0;
    const cap = (configItem.totalToDeliver && configItem.totalToDeliver > 0)
      ? configItem.totalToDeliver
      : Number.MAX_SAFE_INTEGER;
    const newDelivered = Math.min(actual, cap);

    const oldDelivered = configItem.totalDelivered || 0;

    // Always overwrite the settings mirror.
    const item = items.find((it) => it.itemId === configItem.itemId);
    if (item) item.totalDelivered = newDelivered;

    // Overwrite the activity-progress record so the dashboard + findMoveJobs agree.
    const activity = loadCargoMoverActivity();
    const progress = activity.itemProgress[`${bot.username}:${configItem.itemId}`];
    if (progress) {
      progress.totalDelivered = newDelivered;
      progress.lastUpdatedAt = new Date().toISOString();
      if (progress.targetQuantity > 0 && newDelivered >= progress.targetQuantity) {
        progress.isComplete = true;
      }
      saveCargoMoverActivity(activity);
    }

    if (newDelivered !== oldDelivered) {
      changed.push({
        itemId: configItem.itemId,
        itemName: configItem.itemName,
        oldDelivered,
        newDelivered,
      });
    }
    ctx.log("cargo", `🔄 Reconciled ${configItem.itemName}: delivered ${oldDelivered} → ${newDelivered} (destination holds ${actual})`);
  }

  if (items.length > 0) {
    writeSettings({ cargo_mover: { items } });
  }

  return { reconciled: changed.length, changed, stationId: usedStationId, readError: undefined };
}

/** Build the ordered, filtered list of items to bulk-move from the source
 *  faction storage. Excludes operational fuel/energy cells, and any item whose
 *  stored quantity exceeds `bulkIgnoreOver` (those can never fit at the
 *  destination and would just error out). `destHas` lets seed mode skip items
 *  that already have a presence at the destination. */
function planBulkItems(
  ctx: RoutineContext,
  sourceItems: Array<{ itemId: string; name: string; quantity: number }>,
  settings: CargoMoverSettings,
  destHas: Set<string>,
): Array<{ itemId: string; itemName: string; quantity: number }> {
  const { bot } = ctx;
  let candidates = sourceItems.filter((i) => {
    if (!i.itemId || i.quantity <= 0) return false;
    if (isBulkSkipItem(i.itemId)) return false;
    // Never load dynamically-generated packages — they're not in the catalog
    // and inspecting them to learn their size would spam rate-limited commands
    // and get us banned. They're blocked from the cargo mover entirely.
    if (isPackageItem(i.itemId)) return false;
    // Items that already have a presence at the destination are skipped while
    // seeding — we bring every OTHER item in first, then seed them on a later
    // pass once the rest all have a presence.
    if (settings.bulkSeedMode && destHas.has(i.itemId)) return false;
    if (i.quantity > settings.bulkIgnoreOver) {
      ctx.log("cargo", `  ⏭️ Skipping ${i.name}: ${i.quantity} in storage exceeds ignore-over threshold (${settings.bulkIgnoreOver})`);
      return false;
    }
    return true;
  });

  // During seed mode, cap each item to the seed amount.
  let planned = candidates.map((i) => ({
    itemId: i.itemId,
    itemName: i.name || i.itemId,
    quantity: settings.bulkSeedMode ? Math.min(i.quantity, settings.bulkSeedAmount) : i.quantity,
  }));

  // Apply transfer ordering.
  const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  if (settings.bulkOrder === "alphabetical") {
    planned.sort((a, b) => coll.compare(a.itemName, b.itemName));
  } else if (settings.bulkOrder === "reverse_alphabetical") {
    planned.sort((a, b) => coll.compare(b.itemName, a.itemName));
  } else if (settings.bulkOrder === "random") {
    for (let i = planned.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [planned[i], planned[j]] = [planned[j], planned[i]];
    }
  }

  return planned;
}

/** Bulk-move sub-routine. Moves everything (respecting `bulkIgnoreOver`,
 *  `bulkOrder`, and `bulkSeedMode`) from the source faction storage to the
 *  destination. Runs a single round: load as much as fits, deliver, then return
 *  to source. The main loop calls this repeatedly, so seed mode naturally
 *  progresses (each pass more items gain a destination presence) until the base
 *  is seeded and full moving takes over. */
async function runBulkMovePhase(
  ctx: RoutineContext,
  settings: CargoMoverSettings,
  safetyOpts: {
    fuelThresholdPct: number;
    hullThresholdPct: number;
    ignorePiratesWhenCloaked: boolean;
    ignoreBlacklistWhenCloaked: boolean;
  },
  warnedNoCloak: { warned: boolean },
): Promise<void> {
  const { bot } = ctx;
  const mode = settings.bulkSeedMode ? "SEED-BASE" : "FULL";
  ctx.log("cargo", `═══════════════════════════════════════════════════════`);
  ctx.log("cargo", `📦 Bulk Move (${mode}) — order=${settings.bulkOrder}, ignoreOver=${settings.bulkIgnoreOver}`);
  ctx.log("cargo", `   Source: ${settings.sourceStation}`);
  ctx.log("cargo", `   Destination: ${settings.destinationStation} (${settings.destinationStorageType})`);

  const sourceSystem = resolveStationSystem(settings.sourceStation);
  const destSystem = resolveStationSystem(settings.destinationStation);
  if (!sourceSystem) { ctx.log("error", "Bulk move: unknown source station"); await ctx.sleep(60000); return; }
  if (!destSystem) { ctx.log("error", "Bulk move: unknown destination station"); await ctx.sleep(60000); return; }

  // ── Navigate to source & dock ──────────────────────────────
  if (bot.system !== sourceSystem) {
    await undockForTravel(ctx, warnedNoCloak);
    if (bot.state !== "running") return;
    if (!await ensureFueled(ctx, safetyOpts.fuelThresholdPct)) { await ctx.sleep(30000); return; }
    if (!await navigateToSystem(ctx, sourceSystem, safetyOpts)) { await ctx.sleep(30000); return; }
  }
  if (!bot.docked || !botIsAtStation(bot, settings.sourceStation)) {
    await undockForTravel(ctx, warnedNoCloak);
    if (bot.state !== "running") return;
    if (!botIsAtStation(bot, settings.sourceStation)) {
      const tResp = await bot.exec("travel", { target_poi: stationTravelTarget(settings.sourceStation) });
      if (tResp.error && !tResp.error.message.toLowerCase().includes("already")) {
        ctx.log("error", `Bulk move: travel to source failed: ${tResp.error.message}`);
        await ctx.sleep(30000); return;
      }
      if (!tResp.error) bot.poi = stationTravelTarget(settings.sourceStation);
    }
    if (!await dockAtStation(ctx)) { await ctx.sleep(30000); return; }
  }

  // ── Maintenance at source ─────────────────────────────────
  await tryRefuel(ctx);
  await repairShip(ctx);
  // Read the SOURCE station's faction storage explicitly — never fall back to
  // the global general.factionStorageStation (used by cleanup/faction-trader),
  // which is unrelated to this routine's source and would make us plan against
  // the wrong inventory.
  await bot.refreshFactionStorage(false, settings.sourceStation);
  await ensureMilitaryFuelCells(ctx, settings.militaryFuelCells);

  // ── Empty a full hold BEFORE planning/loading ──────────────
  // If the bot starts a bulk-move phase with a (near) full hold — e.g. it was
  // restarted mid-haul or the previous pass didn't deliver — there is no free
  // space to load into, so every load attempt would cargo_full and the phase
  // would bail with "could not load anything". Dump the hold first (faction
  // storage, falling back to personal storage on a per-item cap error) so the
  // load loop always begins with space available.
  await bot.refreshCargo();
  const bulkFullness = bot.cargoMax > 0 ? bot.cargo / bot.cargoMax : 1;
  if (bot.inventory.length > 0 && bulkFullness >= 0.9) {
    ctx.log("cargo", `🧹 Bulk move startup: hold ${Math.round(bulkFullness * 100)}% full — emptying to storage before loading`);
    for (const item of [...bot.inventory]) {
      if (item.quantity <= 0) continue;
      const lower = item.itemId.toLowerCase();
      if (lower.includes("fuel") || lower.includes("energy_cell")) continue;
      const dResp = await bot.exec("faction_deposit_items", { item_id: item.itemId, quantity: item.quantity });
      if (!dResp.error) {
        ctx.log("cargo", `🧹 Bulk startup: emptied ${item.quantity}x ${item.name} to faction storage`);
      } else if (dResp.error.message.toLowerCase().includes("storage_cap_exceeded") || dResp.error.message.toLowerCase().includes("cap reached") || dResp.error.message.toLowerCase().includes("too many") || dResp.error.message.toLowerCase().includes("maximum") || dResp.error.message.toLowerCase().includes("full")) {
        const fb = await bot.exec("deposit_items", { item_id: item.itemId, quantity: item.quantity });
        if (!fb.error) ctx.log("cargo", `🧹 Bulk startup: emptied ${item.quantity}x ${item.name} to personal storage`);
        else ctx.log("error", `Bulk startup: could not empty ${item.name}: ${fb.error.message}`);
      } else {
        ctx.log("error", `Bulk startup: failed to empty ${item.name}: ${dResp.error.message}`);
      }
    }
    await bot.refreshCargo();
  }

  // ── Re-check REMOTE destination faction storage ───────────
  // Read the destination's faction storage so we can see what it already has
  // (and what it doesn't) before we start hauling. This feeds seed mode and the
  // user-facing visibility of the target's inventory.
  const destHas = new Set<string>();
  try {
    await bot.refreshFactionStorage(false, settings.destinationStation);
    const destItems = bot.factionStorage;
    ctx.log("cargo", `🔎 Destination faction storage (${settings.destinationStation}) has ${destItems.length} item type(s):`);
    for (const d of destItems.slice().sort((a, b) => (a.name || a.itemId).localeCompare(b.name || b.itemId))) {
      if (d.quantity > 0) destHas.add(d.itemId);
      ctx.log("cargo", `     - ${d.name || d.itemId}: ${d.quantity}`);
    }
    // Restore the SOURCE station storage into cache for the load step below.
    await bot.refreshFactionStorage(false, settings.sourceStation);
  } catch (e) {
    ctx.log("warn", `Could not read remote destination faction storage: ${e instanceof Error ? e.message : e}`);
    await bot.refreshFactionStorage(false, settings.sourceStation);
  }

  // ── Plan what to move ─────────────────────────────────────
  // Pre-inspect any packages in source storage so their true cargo size is
  // known before planning — packages are not in the catalog and default to
  // size 1, which causes massive overbooking of cargo space.
  const planned = planBulkItems(ctx, bot.factionStorage, settings, destHas);
  if (planned.length === 0) {
    if (settings.bulkSeedMode) {
      // Seed pass found nothing new to bring in — that means every sourced item
      // already has a presence at the destination, so seeding is complete.
      const allPresent = bot.factionStorage
        .filter((i) => i.quantity > 0 && !isBulkSkipItem(i.itemId) && i.quantity <= settings.bulkIgnoreOver)
        .every((i) => destHas.has(i.itemId));
      if (allPresent) {
        ctx.log("cargo", `✅ Seed pass complete — every sourced item now has a presence at the destination. Disabling seed mode and switching to FULL moves.`);
        const all = readSettings();
        const cm = (all.cargo_mover as Record<string, unknown>) || {};
        cm.bulkSeedMode = false;
        writeSettings({ cargo_mover: cm });
      }
    }
    ctx.log("info", "Bulk move: nothing to move right now — waiting 60s");
    await ctx.sleep(60000);
    return;
  }

  ctx.log("cargo", `📋 Bulk move plan: ${planned.length} item type(s)${settings.bulkSeedMode ? ` (seeding ${settings.bulkSeedAmount} each)` : ""}`);
  for (const p of planned) {
    ctx.log("cargo", `     - ${p.itemName}: ${p.quantity}`);
  }

  // ── Load as much as fits into cargo ───────────────────────
  // Pull every planned item from faction storage into cargo in ONE batch action
  // (single tick) instead of one withdrawal per item — the unified `storage`
  // command moves all the requested stacks at once. We cap each item to what
  // fits the hold (by true item size) so the batch never overflows, then
  // reconcile the actual moved quantities from the cargo diff. A single batch
  // can still partially fill the hold; we loop a few passes until the hold is
  // full or every planned item is loaded.
  await bot.refreshCargo();
  const cargoMax = bot.cargoMax;
  let loadedAny = false;

  for (let pass = 0; pass < 6 && bot.state === "running"; pass++) {
    await bot.refreshCargo();
    const cargoUsed = cargoUsedFromInventory(bot);
    const freeSpace = Math.max(0, cargoMax - cargoUsed);
    if (freeSpace <= 0) break;

    // Package IDs are excluded from `planned` (blocked entirely) and resolve to
    // the fixed PACKAGE_CARGO_SIZE, so no inspect/network call is ever needed.
    const batch: Array<{ itemId: string; quantity: number }> = [];
    for (const p of planned) {
      if (p.quantity <= 0) continue;
      const itemSize = getItemSize(p.itemId);
      const maxFit = Math.floor(freeSpace / Math.max(1, itemSize));
      if (maxFit <= 0) continue;
      await bot.refreshFactionStorage(false, settings.sourceStation);
      const inStorage = bot.factionStorage.find((i) => i.itemId === p.itemId)?.quantity || 0;
      const loadQty = Math.min(maxFit, inStorage, p.quantity);
      if (loadQty > 0) batch.push({ itemId: p.itemId, quantity: loadQty });
    }

    if (batch.length === 0) break;

    const moved = await bulkWithdrawFromStorage(ctx, batch, "faction");
    if (moved.size > 0) loadedAny = true;
    for (const [itemId, qty] of moved) {
      const p = planned.find((pp) => pp.itemId === itemId);
      const name = p?.itemName || itemId;
      if (p) p.quantity -= qty;
      ctx.log("cargo", `✅ Loaded ${qty}x ${name} (cargo ${cargoUsedFromInventory(bot)}/${cargoMax})`);
    }
    if (planned.every((p) => p.quantity <= 0)) break;
  }

  if (!loadedAny) {
    ctx.log("info", `Bulk move: could not load anything — waiting 60s`);
    await ctx.sleep(60000);
    return;
  }

  // ── Deliver to destination ────────────────────────────────
  const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
  if (!fueled) { await ctx.sleep(30000); return; }
  await undockForTravel(ctx, warnedNoCloak);
  if (bot.state !== "running") return;
  if (bot.system !== destSystem) {
    if (!await navigateToSystem(ctx, destSystem, safetyOpts)) { await ctx.sleep(30000); return; }
  }
  await undockForTravel(ctx, warnedNoCloak);
  if (bot.state !== "running") return;
  if (!botIsAtStation(bot, settings.destinationStation)) {
    const tResp = await bot.exec("travel", { target_poi: stationTravelTarget(settings.destinationStation) });
    if (tResp.error && !tResp.error.message.toLowerCase().includes("already")) {
      ctx.log("error", `Bulk move: travel to destination failed: ${tResp.error.message}`);
      await ctx.sleep(30000); return;
    }
    if (!tResp.error) bot.poi = stationTravelTarget(settings.destinationStation);
  }
  if (!await dockAtStation(ctx)) { await ctx.sleep(30000); return; }

  await bot.refreshCargo();
  const deliverItems = bot.inventory
    .filter((item) => {
      if (item.quantity <= 0) return false;
      if (isBulkSkipItem(item.itemId)) return false;
      if (isPackageItem(item.itemId)) return false;
      return fuelDepositQty(item.itemId, item.quantity, settings.militaryFuelCells) > 0;
    })
    .map((item) => ({
      itemId: item.itemId,
      quantity: fuelDepositQty(item.itemId, item.quantity, settings.militaryFuelCells),
    }));

  if (deliverItems.length > 0) {
    const deposited = await bulkDepositToDestination(
      ctx,
      deliverItems,
      settings.destinationStorageType,
      settings.destinationBotName,
    );
    ctx.log("cargo", `📦 Bulk move delivered ${deposited.size} item type(s) to destination in one action`);
  }

  await tryRefuel(ctx);
  await ctx.sleep(5000);
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

  // Session-scoped flag so the "no cloak module" warning is only emitted once.
  const warnedNoCloak: { warned: boolean } = { warned: false };

  // Startup: attempt to cloak immediately if we're already undocked (a cloak
  // module, if present, is always enabled). If docked, we'll cloak as soon as
  // we undock to travel.
  if (!bot.docked) {
    await ensureCloaked(ctx, warnedNoCloak);
  }

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

    // ── GRACEFUL SHUTDOWN (return to home / source station) ─────────────
    // Mirrors civilian transport's stopAfterCycle, but the cargo mover must
    // always end parked back at the source ("home") station when it stops.
    // When a stop is requested we finish the current in-flight delivery, then
    // navigate home, dock, and stop. We never abandon cargo and never start a
    // brand-new loading round.
    if (bot.shouldStopAfterCycle()) {
      const gSettings = getCargoMoverSettings(bot.username);
      ctx.log("cargo", "🛑 Graceful shutdown requested — finishing round and returning to source station (home)...");
      logCargoActivity(bot.username, "graceful_stop", "Graceful shutdown requested", {
        location: `${bot.system}/${bot.poi}`,
      });

      // Already docked at home — nothing left to do, stop immediately.
      if (bot.docked && botIsAtStation(bot, gSettings.sourceStation)) {
        bot.clearStopAfterCycle();
        for (const item of gSettings.items) {
          releaseQuantityLock(bot.username, item.itemId, "stopped");
        }
        logCargoActivity(bot.username, "graceful_stop", "Routine stopped at home (source station)", {
          location: `${bot.system}/${bot.poi}`,
        });
        ctx.log("cargo", "🛑 Graceful shutdown — stopped at home (source station)");
        bot.initiateStop();
        return;
      }

      const gSourceSystem = resolveStationSystem(gSettings.sourceStation);
      const gDestSystem = resolveStationSystem(gSettings.destinationStation);

      // Deliver any cargo aboard first (so it is never stranded). Skip this if
      // we're already at the destination — the cargo is (or was) dropped there.
      await bot.refreshCargo();
      const hasCargo = bot.inventory.some((item) => {
        const lower = item.itemId.toLowerCase();
        if (lower.includes("fuel") || lower.includes("energy_cell")) return false;
        return gSettings.items.some((ci) => ci.itemId === item.itemId);
      });

      if (hasCargo && gDestSystem && !botIsAtStation(bot, gSettings.destinationStation)) {
        ctx.log("cargo", "🛑 Graceful shutdown — delivering cargo aboard to destination before returning home...");
        const gSafetyOpts = {
          fuelThresholdPct: gSettings.refuelThreshold,
          hullThresholdPct: gSettings.repairThreshold,
          ignorePiratesWhenCloaked: gSettings.ignorePiratesWhenCloaked,
          ignoreBlacklistWhenCloaked: gSettings.ignoreBlacklistWhenCloaked,
        };
        await undockForTravel(ctx, warnedNoCloak);
        if (bot.state !== "running") {
          ctx.log("system", "⛔ Stopping — emergency detected");
          return;
        }
        const fueled = await ensureFueled(ctx, gSafetyOpts.fuelThresholdPct);
        if (!fueled) {
          ctx.log("error", "Cannot refuel for graceful-shutdown delivery");
          await ctx.sleep(30000);
          continue;
        }
        if (bot.system !== gDestSystem) {
          const arrived = await navigateToSystem(ctx, gDestSystem, gSafetyOpts);
          if (!arrived || bot.state !== "running") {
            if (bot.state !== "running") {
              ctx.log("system", "⛔ Stopping — emergency detected");
              return;
            }
            ctx.log("error", `Failed to reach ${gDestSystem} for graceful-shutdown delivery`);
            await ctx.sleep(30000);
            continue;
          }
        }
        await undockForTravel(ctx, warnedNoCloak);
        if (bot.state !== "running") {
          ctx.log("system", "⛔ Stopping — emergency detected");
          return;
        }
        if (!botIsAtStation(bot, gSettings.destinationStation)) {
          const tResp = await bot.exec("travel", { target_poi: stationTravelTarget(gSettings.destinationStation) });
          if (bot.state !== "running") {
            ctx.log("system", "⛔ Stopping — emergency detected");
            return;
          }
          if (tResp.error && !tResp.error.message.toLowerCase().includes("already")) {
            ctx.log("error", `Travel to destination failed during graceful shutdown: ${tResp.error.message}`);
            await ctx.sleep(30000);
            continue;
          }
          if (!tResp.error) bot.poi = stationTravelTarget(gSettings.destinationStation);
        }
        if (!await dockAtStation(ctx)) {
          ctx.log("error", "Could not dock at destination for graceful-shutdown delivery");
          await ctx.sleep(30000);
          continue;
        }
        await deliverCargoAboard(ctx, gSettings);
        await tryRefuel(ctx);
      }

      // Return home (source station) and dock.
      if (gSourceSystem) {
        ctx.log("cargo", "🛑 Graceful shutdown — returning to source station (home)...");
        await undockForTravel(ctx, warnedNoCloak);
        if (bot.state !== "running") {
          ctx.log("system", "⛔ Stopping — emergency detected");
          return;
        }
        const gSafetyOpts = {
          fuelThresholdPct: gSettings.refuelThreshold,
          hullThresholdPct: gSettings.repairThreshold,
          ignorePiratesWhenCloaked: gSettings.ignorePiratesWhenCloaked,
          ignoreBlacklistWhenCloaked: gSettings.ignoreBlacklistWhenCloaked,
        };
        const fueled = await ensureFueled(ctx, gSafetyOpts.fuelThresholdPct);
        if (!fueled) {
          ctx.log("error", "Cannot refuel for graceful-shutdown return home");
          await ctx.sleep(30000);
          continue;
        }
        if (bot.system !== gSourceSystem) {
          const arrived = await navigateToSystem(ctx, gSourceSystem, gSafetyOpts);
          if (!arrived || bot.state !== "running") {
            if (bot.state !== "running") {
              ctx.log("system", "⛔ Stopping — emergency detected");
              return;
            }
            ctx.log("error", `Failed to reach ${gSourceSystem} for graceful-shutdown return`);
            await ctx.sleep(30000);
            continue;
          }
        }
        await undockForTravel(ctx, warnedNoCloak);
        if (bot.state !== "running") {
          ctx.log("system", "⛔ Stopping — emergency detected");
          return;
        }
        if (!botIsAtStation(bot, gSettings.sourceStation)) {
          const tResp = await bot.exec("travel", { target_poi: stationTravelTarget(gSettings.sourceStation) });
          if (bot.state !== "running") {
            ctx.log("system", "⛔ Stopping — emergency detected");
            return;
          }
          if (tResp.error && !tResp.error.message.toLowerCase().includes("already")) {
            ctx.log("error", `Travel to source failed during graceful shutdown: ${tResp.error.message}`);
            await ctx.sleep(30000);
            continue;
          }
          if (!tResp.error) bot.poi = stationTravelTarget(gSettings.sourceStation);
        }
        if (!await dockAtStation(ctx)) {
          ctx.log("error", "Could not dock at source station for graceful shutdown");
          await ctx.sleep(30000);
          continue;
        }
        await tryRefuel(ctx);
        await repairShip(ctx);
      }

      bot.clearStopAfterCycle();
      for (const item of gSettings.items) {
        releaseQuantityLock(bot.username, item.itemId, "stopped");
      }
      logCargoActivity(bot.username, "graceful_stop", "Routine stopped at home (source station)", {
        location: `${bot.system}/${bot.poi}`,
      });
      ctx.log("cargo", "🛑 Graceful shutdown — stopped at home (source station)");
      bot.initiateStop();
      return;
    }

    const settings = getCargoMoverSettings(bot.username);
    const safetyOpts = {
      fuelThresholdPct: settings.refuelThreshold,
      hullThresholdPct: settings.repairThreshold,
      ignorePiratesWhenCloaked: settings.ignorePiratesWhenCloaked,
      ignoreBlacklistWhenCloaked: settings.ignoreBlacklistWhenCloaked,
    };

    // ── BULK MOVE SUB-ROUTINE ─────────────────────────────────
    // When enabled, move EVERYTHING from the source faction storage to the
    // destination (respecting the ignore-over / order / seed-mode options)
    // instead of the hand-picked items list. Runs each cycle and returns here
    // to loop, so seed mode naturally progresses pass-by-pass.
    if (settings.enableBulkMove) {
      yield "bulk_move";
      await runBulkMovePhase(ctx, settings, safetyOpts, warnedNoCloak);
      continue;
    }

    ctx.log("cargo", `═══════════════════════════════════════════════════════`);
    ctx.log("cargo", `📦 Cargo Mover Cycle Starting`);
    ctx.log("cargo", `   Source: ${settings.sourceStation}`);
    ctx.log("cargo", `   Destination: ${settings.destinationStation} (${settings.destinationStorageType})`);
    ctx.log("cargo", `   Items configured: ${settings.items.length}`);

    // Robust plan accounting: consult the activity log (delivered) and the shared
    // in-transit tracking ("who has what" across all movers) so the routine never
    // assumes every configured item is still sitting at the source. Items already
    // in transit have been withdrawn and are en route / in another bot's hold.
    const inTransitSummary = getInTransitSummary();
    let planInTransit = 0;
    let planDelivered = 0;
    let planRemaining = 0;
    for (const item of settings.items) {
      const effectiveDest = item.shipLoadoutDestination || settings.destinationStation;
      const configured = item.quantity || 0;
      // Delivered = max of persisted settings count and activity-log progress
      // (robust across restarts / manual edits / multiple movers).
      const delivered = Math.max(
        item.totalDelivered || 0,
        getItemProgress(bot.username, item.itemId)?.totalDelivered || 0,
      );
      const inTransitAll = getInTransitQuantity(item.itemId, effectiveDest);
      const inTransitSelf = getInTransitQuantity(item.itemId, effectiveDest, bot.username);
      const inTransitOthers = Math.max(0, inTransitAll - inTransitSelf);

      // "Who has what" breakdown for multi-mover visibility.
      const destEntries = inTransitSummary.itemsByDestination[effectiveDest] || [];
      const byBot = destEntries
        .filter((e) => e.itemId === item.itemId)
        .map((e) => `${e.botUsername}=${e.quantity}`);

      const remaining = configured > 0
        ? Math.max(0, configured - inTransitAll - delivered)
        : null;

      planInTransit += inTransitAll;
      planDelivered += delivered;
      if (remaining !== null) planRemaining += remaining;

      const whoPart = byBot.length > 0
        ? `inTransit: ${byBot.join(", ")}`
        : `inTransit: 0 (you ${inTransitSelf})`;
      const remainPart = remaining === null ? "all (storage-based)" : `${remaining} remaining`;
      ctx.log("cargo", `     - ${item.itemName}: target=${configured || "all"} | delivered=${delivered} | ${whoPart} | ${remainPart}`);
    }
    ctx.log("cargo", `   Plan → inTransit(all movers)=${planInTransit}, delivered=${planDelivered}, remaining-to-move=${planRemaining}`);
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

    // ── STARTUP CARGO DUMP ────────────────────────────────────
    // If the hold is (near) full when a cycle begins, the load loop below would
    // see zero free space, fail to load anything, and just sleep 60s forever
    // ("stuck"). Empty the hold FIRST so every cycle starts clean. This is
    // especially important after a crash/restart where a previous run left the
    // ship loaded. We dump everything except operational fuel/energy cells, and
    // fall back from faction → personal storage when a stack is at the faction
    // cap (the "too many of that item in storage" case). Items that are this
    // bot's own in-transit cargo are left aboard only when the hold is NOT full,
    // so a genuinely full hold always gets emptied regardless of transit flags.
    await bot.refreshCargo();
    const cargoFullness = bot.cargoMax > 0 ? bot.cargo / bot.cargoMax : 1;
    if (bot.docked && bot.inventory.length > 0 && cargoFullness >= 0.9) {
      ctx.log("cargo", `🧹 Startup: hold is ${Math.round(cargoFullness * 100)}% full — emptying cargo to storage before loading`);
      const startupClear = bot.inventory.filter(item => {
        const lower = item.itemId.toLowerCase();
        if (lower.includes("fuel") || lower.includes("energy_cell")) return false;
        // When the hold is full we dump everything (transit flags don't matter —
        // a full hold must be cleared to make progress).
        return true;
      });
      for (const item of startupClear) {
        if (item.quantity <= 0) continue;
        const dResp = await bot.exec("faction_deposit_items", { item_id: item.itemId, quantity: item.quantity });
        if (!dResp.error) {
          ctx.log("cargo", `🧹 Startup: emptied ${item.quantity}x ${item.name} to faction storage`);
        } else if (dResp.error.message.toLowerCase().includes("storage_cap_exceeded") || dResp.error.message.toLowerCase().includes("cap reached") || dResp.error.message.toLowerCase().includes("too many") || dResp.error.message.toLowerCase().includes("maximum") || dResp.error.message.toLowerCase().includes("full")) {
          ctx.log("warn", `⚠️ Startup: faction storage full for ${item.name} — falling back to personal (station) storage`);
          const fb = await bot.exec("deposit_items", { item_id: item.itemId, quantity: item.quantity });
          if (!fb.error) {
            ctx.log("cargo", `🧹 Startup: emptied ${item.quantity}x ${item.name} to personal storage`);
          } else {
            ctx.log("error", `Startup: could not empty ${item.name} to either storage: ${fb.error.message}`);
          }
        } else {
          ctx.log("error", `Startup: failed to empty ${item.name} to faction storage: ${dResp.error.message}`);
        }
      }
      await bot.refreshCargo();
    }

    // ── CARGO DELIVERY RECOVERY ─────────────────────────────────
    // On restart, check if bot has cargo items that need to be delivered.
    // If so, skip directly to delivery instead of going back to source.
    await bot.refreshCargo();
    const cargoItemsToDeliver = bot.inventory.filter(item =>
      isThisBotsTransitCargo(item.itemId, bot.username, settings)
    );

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
      await undockForTravel(ctx, warnedNoCloak);
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
      await undockForTravel(ctx, warnedNoCloak);
      if (bot.state !== "running") {
        ctx.log("system", "⛔ Stopping — emergency detected");
        return;
      }
      if (!botIsAtStation(bot, settings.destinationStation)) {
        ctx.log("travel", `Traveling to destination station ${settings.destinationStation}...`);
        const tResp = await bot.exec("travel", { target_poi: stationTravelTarget(settings.destinationStation) });
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
                const retryResp = await bot.exec("travel", { target_poi: stationTravelTarget(settings.destinationStation) });
                if (retryResp.error) {
                  const retryErrMsg = retryResp.error.message.toLowerCase();
                  if (!retryErrMsg.includes("already")) {
                    ctx.log("error", `Still failed to travel to mobile capital after relocation during recovery: ${retryResp.error.message}`);
                    await ctx.sleep(30000);
                    continue;
                  }
                } else {
        bot.poi = stationTravelTarget(settings.destinationStation);
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
        bot.poi = stationTravelTarget(settings.destinationStation);
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
      logCargoActivity(bot.username, "arrived_destination", `Cargo (recovered) arrived at destination ${settings.destinationStation} — preparing to unload`, {
        location: `${bot.system}/${settings.destinationStation}`,
      });

      // Deliver all cargo
      yield "deposit_items";
      await bot.refreshCargo();
      // Only deliver cargo that is actually ours to transport — never reroute
      // another bot's / another movement's leftovers into our destination.
      const itemsToDeposit = bot.inventory.filter((item) =>
        isThisBotsTransitCargo(item.itemId, bot.username, settings)
      );
      const deliveredItems: { itemId: string; quantity: number }[] = [];

      if (itemsToDeposit.length > 0) {
        ctx.log("cargo", `📦 Delivering recovered cargo to destination...`);
        for (const item of itemsToDeposit) {
          if (item.quantity <= 0) continue;
          // Premium/energy cells never leave the ship; military cells keep the
          // required reserve aboard and deposit only the excess.
          if (isNeverDepositFuelItem(item.itemId)) continue;
          const depositQty = fuelDepositQty(item.itemId, item.quantity, settings.militaryFuelCells);
          if (depositQty <= 0) {
            ctx.log("cargo", `🔋 Keeping ${item.quantity}x ${item.itemId} aboard (reserve ${settings.militaryFuelCells} required) — not depositing`);
            continue;
          }
          if (item.itemId === "military_fuel_cell") {
            ctx.log("cargo", `🔋 Depositing ${depositQty}x military_fuel_cell (keeping reserve ${settings.militaryFuelCells}, carrying ${item.quantity})`);
          }

          const depositResult = await depositToDestination(
            ctx,
            item.itemId,
            depositQty,
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

    // Always run source-station maintenance (refuel + load fuel cells) when we
    // are docked at the source and about to start a load cycle — including the
    // common case where the bot is already sitting docked at "home" when the
    // routine begins. Without this, the ship would load cargo and depart without
    // ever refueling, then run dry partway through a multi-jump trip.
    let justDockedAtSource = bot.docked && botIsAtStation(bot, settings.sourceStation);

    if (bot.system !== sourceSystem) {
      ctx.log("cargo", `🚀 Not at source system (${bot.system} ≠ ${sourceSystem}) — navigating...`);
      logCargoActivity(bot.username, "navigation", `Navigating to source system ${sourceSystem}`, {
        location: `${bot.system} → ${sourceSystem}`,
      });
      
      saveLastSession(bot.username, settings.sourceStation, settings.destinationStation,
        settings.items.map(i => ({ itemId: i.itemId, itemName: i.itemName, quantity: i.quantity, storageType: i.storageType || 'faction' })),
        0, "navigating_to_source", bot.system, bot.poi || "", bot.docked);
      
      await undockForTravel(ctx, warnedNoCloak);
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
    if (!bot.docked || !botIsAtStation(bot, settings.sourceStation)) {
      ctx.log("cargo", `🚢 Not docked at source station — docking/traveling...`);
      
      saveLastSession(bot.username, settings.sourceStation, settings.destinationStation,
        settings.items.map(i => ({ itemId: i.itemId, itemName: i.itemName, quantity: i.quantity, storageType: i.storageType || 'faction' })),
        0, "docking_at_source", bot.system, bot.poi || "", bot.docked);
      
      await undockForTravel(ctx, warnedNoCloak);
      if (bot.state !== "running") {
        ctx.log("system", "⛔ Stopping — emergency detected");
        logCargoActivity(bot.username, "interruption", "Emergency detected during source station approach", {
          location: `${bot.system}/${bot.poi}`,
        });
        return;
      }
    if (!botIsAtStation(bot, settings.sourceStation)) {
        ctx.log("travel", `Traveling to source station ${settings.sourceStation}...`);
        logCargoActivity(bot.username, "navigation", `Traveling to source station ${settings.sourceStation}`, {
          location: `${bot.system}: ${bot.poi} → ${settings.sourceStation}`,
        });
        const tResp = await bot.exec("travel", { target_poi: stationTravelTarget(settings.sourceStation) });
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
        bot.poi = stationTravelTarget(settings.sourceStation);
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
      // Load the user-configured number of military fuel cells for the trip.
      // These are never delivered and power in-transit refueling.
      // Read the SOURCE station's faction storage (not general.factionStorageStation).
      await bot.refreshFactionStorage(false, settings.sourceStation);
      await ensureMilitaryFuelCells(ctx, settings.militaryFuelCells);
    }

    // Clear UNRELATED cargo items to FACTION storage (not personal) so other
    // bots can access them. Only items that are NOT this bot's transit cargo are
    // cleared — cargo we are actually meant to transport (a configured item for
    // this destination, or an item still tracked in-transit under our name) is
    // left aboard so the normal load/deliver loop handles it. This prevents us
    // from stranding legitimately-transporting cargo, or dumping another bot's
    // / another movement's leftovers to the wrong storage.
    yield "clear_cargo";
    ctx.log("cargo", `🧹 Clearing unrelated cargo items to faction storage...`);
    await bot.refreshCargo();
    if (bot.inventory.length > 0) {
      const itemsToClear = bot.inventory.filter(item => {
        const lower = item.itemId.toLowerCase();
        if (lower.includes("fuel") || lower.includes("energy_cell")) return false;
        // Never clear cargo this bot is actually supposed to be transporting.
        return !isThisBotsTransitCargo(item.itemId, bot.username, settings);
      });
      if (itemsToClear.length > 0) {
        const deposited: string[] = [];
        for (const item of itemsToClear) {
          if (item.quantity <= 0) continue;
          // Deposit to faction storage, not personal storage
          const dResp = await bot.exec("faction_deposit_items", { item_id: item.itemId, quantity: item.quantity });
          if (!dResp.error) {
            deposited.push(`${item.quantity}x ${item.name}`);
          } else if (dResp.error.message.toLowerCase().includes("storage_cap_exceeded") || dResp.error.message.toLowerCase().includes("cap reached") || dResp.error.message.toLowerCase().includes("too many") || dResp.error.message.toLowerCase().includes("maximum") || dResp.error.message.toLowerCase().includes("full")) {
            ctx.log("warn", `⚠️ Faction storage full for ${item.name} during clear — falling back to personal (station) storage deposit`);
            const fallbackResp = await bot.exec("deposit_items", { item_id: item.itemId, quantity: item.quantity });
            if (!fallbackResp.error) {
              deposited.push(`${item.quantity}x ${item.name} (station fallback)`);
            } else {
              ctx.log("error", `Fallback station deposit also failed for ${item.name}: ${fallbackResp.error.message}`);
            }
          }
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
    // This prevents race conditions where items just deposited aren't counted.
    // Read the SOURCE station's faction storage (not general.factionStorageStation).
    await bot.refreshStorage();
    await bot.refreshFactionStorage(false, settings.sourceStation);

    yield "find_jobs";
    // Clean up any stale locks from other bots before checking availability
    const staleCleaned = cleanupStaleLocks();
    if (staleCleaned > 0) {
      ctx.log("cargo", `Cleaned up ${staleCleaned} stale locks from other bots`);
    }

    await bot.refreshStatus();

    // NOTE: items resolve their cargo size from the LOCAL catalog (catalog.json)
    // via getItemSize — no network call. Packages (`package:*`) are blocked from
    // loading entirely and use a fixed size, so there is nothing to pre-inspect
    // and we must never issue `inspect` commands (they're rate-limited and would
    // get us banned in bulk).
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
    
    // Track cargo manually to avoid stale bot.cargo issues.
    // Seed with current cargo so pre-loaded items (e.g. military fuel cells)
    // are accounted for and we never overfill the hold.
    let cargoUsed = bot.cargo;
    const cargoMax = bot.cargoMax;
    while (bot.state === "running") {
      await bot.refreshStatus();
      await bot.refreshCargo();

      // Prefer the LIVE cargo reading over the in-memory tracker. The tracker is
      // only used to add loaded quantities; if a load partially succeeds or the
      // game's cache lags, `bot.cargo` is the ground truth for free space.
      cargoUsed = Math.max(cargoUsed, bot.cargo);

      // If cargo is full, go deliver
      if (cargoMax - cargoUsed <= 0) {
        ctx.log("cargo", `📦 Cargo full (${cargoUsed}/${cargoMax}) — delivering...`);
        break;
      }

      // Try to load from each job that still has items. Instead of one
      // withdrawal command per item (one tick each), we gather every job's
      // remaining quantity — capped by how much fits the hold by true item
      // size — and issue a SINGLE batched `storage` withdrawal. The server
      // moves all the requested stacks in one write; we then reconcile the
      // actually-moved quantities (from the cargo diff) with each job's
      // remaining counter and tracking. This removes the per-item tick cost
      // that used to bottleneck the load loop.
      let loadedThisIteration = false;

      // Resolve true sizes from the local catalog (no network call) and cap each
      // job to what fits the current free space. Prefer the LIVE server cargo
      // reading (`bot.cargo`) over the size-multiplied inventory estimate: the
      // server's own "used" value is ground truth and already accounts for
      // everything aboard (e.g. the military fuel cells the bot loaded itself),
      // so a wrong/stale catalog size can never shrink the budget below the real
      // free space and leave the hold half-empty.
      const liveCargoUsed = Math.max(cargoUsedFromInventory(bot), bot.cargo);
      const liveFreeNow = Math.max(0, cargoMax - liveCargoUsed);
      if (liveFreeNow <= 0) {
        ctx.log("cargo", `📦 Cargo full (${liveCargoUsed}/${cargoMax}) — stopping loading`);
        loadedThisIteration = true;
      } else {
        const batch: Array<{ itemId: string; quantity: number; storageType: 'faction' | 'personal' }> = [];
        for (const job of jobs) {
          const remaining = jobRemaining.get(job.itemId) || 0;
          if (remaining <= 0) continue;

          const itemSize = getItemSize(job.itemId);
          // If even ONE unit won't fit, skip this item without a network call —
          // it can never load until cargo is freed.
          if (itemSize > liveFreeNow) {
            ctx.log("cargo", `Skipping ${job.itemName}: one unit (size ${itemSize}) won't fit in ${liveFreeNow} free — skipping until cargo clears`);
            continue;
          }

          const maxFitInCargo = Math.floor(liveFreeNow / Math.max(1, itemSize));
          const loadQty = Math.min(remaining, maxFitInCargo);
          if (loadQty <= 0) {
            ctx.log("cargo", `Skipping ${job.itemName}: cannot fit any units (size=${itemSize}, freeSpace=${liveFreeNow})`);
            continue;
          }

          ctx.log("cargo", `🔄 Batch loading: ${job.itemName} remaining=${remaining}, will load up to ${loadQty} (size ${itemSize}, free ${liveFreeNow})`);
          batch.push({ itemId: job.itemId, quantity: loadQty, storageType: job.storageType });
        }

          if (batch.length > 0) {
            yield "withdraw_items";
            const movedAll = new Map<string, number>();

            // Single item: use the regular per-item storage command rather than
            // the batched `items` form. The batch path is only for 2+ items;
            // a lone item in a batch can hit the same "must be transferred with
            // quantity" / invalid_quantity quirks that the single path already
            // works around, and there is no tick-saving benefit to batching one.
            if (batch.length === 1) {
              const b = batch[0];
              const res = await withdrawFromStorage(ctx, b.itemId, b.quantity, b.storageType);
              if (res.success && res.withdrawnQty > 0) {
                movedAll.set(b.itemId, res.withdrawnQty);
              }
            } else {
              // All jobs in a single routine share the same source storage type, so
              // we can issue one batched withdrawal across the type. (Mixed
              // faction/personal sources are not used together here.)
              const byType = new Map<'faction' | 'personal', Array<{ itemId: string; quantity: number }>>();
              for (const b of batch) {
                if (!byType.has(b.storageType)) byType.set(b.storageType, []);
                byType.get(b.storageType)!.push({ itemId: b.itemId, quantity: b.quantity });
              }

              for (const [storageType, items] of byType) {
                const moved = await bulkWithdrawFromStorage(ctx, items, storageType);
                for (const [itemId, qty] of moved) movedAll.set(itemId, (movedAll.get(itemId) || 0) + qty);
              }
            }

          // Reconcile each job's remaining counter and update tracking exactly
          // as the old per-item path did.
          for (const b of batch) {
            const movedQty = movedAll.get(b.itemId) || 0;
            if (movedQty <= 0) {
              ctx.log("warn", `⚠️ Could not load ${b.itemId} this pass — skipping and continuing`);
              continue;
            }

            consecutiveFailures = 0;
            const remainingBefore = jobRemaining.get(b.itemId) || 0;
            const newRemaining = Math.max(0, remainingBefore - movedQty);
            jobRemaining.set(b.itemId, newRemaining);
            totalMoved += movedQty;
            const job = jobs.find((j) => j.itemId === b.itemId);
            ctx.log("cargo", `✅ Loaded ${movedQty}x ${job?.itemName || b.itemId} (${newRemaining} remaining, cargo: ${cargoUsedFromInventory(bot)}/${cargoMax})`);
            logCargoActivity(bot.username, "cargo_loaded", `Loaded ${movedQty}x ${job?.itemName || b.itemId} into cargo (${newRemaining} remaining to load)`, {
              itemId: b.itemId,
              itemName: job?.itemName || b.itemId,
              quantity: movedQty,
              location: `${bot.system}/${bot.poi}`,
            });
            loadedThisIteration = true;

            updateItemProgress(bot.username, b.itemId, { withdrawn: movedQty });
            updateWithdrawnQuantity(b.itemId, movedQty);

            // If we couldn't load the full amount we asked for, the hold is
            // (nearly) full — stop loading and go deliver.
            if (movedQty < b.quantity) {
              ctx.log("cargo", `⚠️ Partial load: got ${movedQty} of ${b.quantity} requested (cargo nearly full) — delivering`);
              loadedThisIteration = true;
              break;
            }
          }
        }
        // Re-anchor the cargo tracker to the authoritative inventory total so
        // the full-hold check below (and the next pass) use fresh free space.
        cargoUsed = cargoUsedFromInventory(bot);
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

    // ── PRE-DEPARTURE CARGO VERIFICATION ─────────────────────
    // Before we leave the source with "loaded" marked in memory, double-check the
    // hold actually contains what we intended to pick up. A movers-in-motion run
    // is assumed healthy, so a silent under-load (batch cleared the remaining
    // counter but cargo never landed) would otherwise sail off looking fine and
    // only surface later as a stuck / mismatched delivery. Re-read cargo, compare
    // against each job's intended quantity, and re-attempt any shortfalls still
    // available at the source. Only escalate to a red error when we genuinely
    // cannot load (source empty / cargo full / repeated failure) so it shows up
    // in the activity log like the other stalled cases.
    await bot.refreshCargo();
    const verifyStart = Date.now();
    const verifyTimeoutMs = 120000;
    let verifyPass = 0;
    while (Date.now() - verifyStart < verifyTimeoutMs && bot.state === "running") {
      verifyPass++;
      await bot.refreshCargo();
      const cargoNow = new Map(bot.inventory.map((i) => [i.itemId, i.quantity]));
      const shortfalls: Array<{ job: typeof jobs[number]; missing: number; haveInCargo: number }> = [];

      for (const job of jobs) {
        const originalQty = job.availableQty || 0;
        const remainingUnloaded = jobRemaining.get(job.itemId) || 0;
        const intendedLoaded = originalQty - remainingUnloaded;
        if (intendedLoaded <= 0) continue;

        const haveInCargo = cargoNow.get(job.itemId) || 0;
        const missing = intendedLoaded - haveInCargo;
        if (missing > 0) {
          shortfalls.push({ job, missing, haveInCargo });
        }
      }

      if (shortfalls.length === 0) break;

      // Something we meant to load isn't in the hold — try to recover it.
      ctx.log("warn", `⚠️ Pre-departure verify (pass ${verifyPass}): ${shortfalls.length} item type(s) short of intended load — attempting to recover before leaving`);
      logCargoActivity(bot.username, "load_verify", `Cargo verification found ${shortfalls.length} shortfall(s) — re-loading before departure`, {
        location: `${bot.system}/${bot.poi}`,
      });

      const cargoUsedV = cargoUsedFromInventory(bot);
      const freeV = Math.max(0, cargoMax - cargoUsedV);
      if (freeV <= 0) {
        // Hold is genuinely full — whatever is missing simply won't fit. Leave
        // it behind; this is expected (we only carry what fits), not a stall.
        ctx.log("cargo", `📦 Hold full (${cargoUsedV}/${cargoMax}) — cannot recover ${shortfalls.length} shortfall(s); departing with what fits`);
        break;
      }

      let recoveredAny = false;
      for (const s of shortfalls) {
        const itemSize = getItemSize(s.job.itemId);
        const maxFitV = Math.floor(freeV / Math.max(1, itemSize));
        if (maxFitV <= 0) continue;
        const tryQty = Math.min(s.missing, maxFitV);

        let got = 0;
        if (shortfalls.length === 1) {
          // Single remaining shortfall → regular per-item storage command.
          const res = await withdrawFromStorage(ctx, s.job.itemId, tryQty, s.job.storageType);
          got = res.success ? res.withdrawnQty : 0;
        } else {
          const moved = await bulkWithdrawFromStorage(ctx, [{ itemId: s.job.itemId, quantity: tryQty }], s.job.storageType);
          got = moved.get(s.job.itemId) || 0;
        }
        if (got > 0) {
          const before = jobRemaining.get(s.job.itemId) || 0;
          jobRemaining.set(s.job.itemId, Math.max(0, before - got));
          recoveredAny = true;
        }
      }

      if (!recoveredAny) {
        // Couldn't load the missing amounts (source empty / service error).
        // Surface as a red error so it's visible in the activity log, then stop
        // retrying to avoid a tight loop.
        for (const s of shortfalls) {
          const haveInStorageV = s.job.storageType === 'faction'
            ? (bot.factionStorage.find((i) => i.itemId === s.job.itemId)?.quantity || 0)
            : (bot.storage.find((i) => i.itemId === s.job.itemId)?.quantity || 0);
          ctx.log("error", `⚠️ LOAD VERIFY FAILED: ${s.job.itemName} — wanted ${s.job.availableQty}x, only ${s.haveInCargo}x in cargo, ${s.missing}x missing (source has ${haveInStorageV}x). Not departing clean.`);
          logCargoActivity(bot.username, "load_verify_failed", `Could not load ${s.missing}x ${s.job.itemName} (cargo=${s.haveInCargo}, source=${haveInStorageV}) — departure blocked`, {
            itemId: s.job.itemId,
            itemName: s.job.itemName,
            quantity: s.missing,
            location: `${bot.system}/${bot.poi}`,
            error: "Pre-departure cargo verification failed",
          });
        }
        allJobsCompleted = false;
        break;
      }
    }

    if (Date.now() - verifyStart >= verifyTimeoutMs) {
      ctx.log("error", `⚠️ LOAD VERIFY TIMEOUT: could not confirm full load within ${verifyTimeoutMs / 1000}s — departing with whatever is in cargo`);
    } else {
      ctx.log("cargo", `✅ Pre-departure cargo verification passed — hold matches intended load (${cargoUsedFromInventory(bot)}/${cargoMax})`);
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
      const totalInTransit = loadedItems.reduce((sum, i) => sum + i.quantity, 0);
      ctx.log("cargo", `📦 Added ${loadedItems.length} item types to in-transit tracking (${totalInTransit} total items) → ${settings.destinationStation}`);
      // Robust milestone log: cargo has left the source and is now in transit.
      logCargoActivity(bot.username, "in_transit", `Cargo in transit: ${totalInTransit} items heading to ${settings.destinationStation}`, {
        location: `${bot.system}/${bot.poi}`,
        quantity: totalInTransit,
      });
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
    
    // Refuel BEFORE undocking so we top off the tank while still docked at the
    // source/home station (ensureFueled can refuel in place when docked). If we
    // undocked first, the only option would be cargo cells and we could leave
    // home under-fueled.
    const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
    if (!fueled) {
      ctx.log("error", "Cannot refuel for delivery");
      logCargoActivity(bot.username, "error", "Cannot refuel for delivery trip", {
        location: `${bot.system}/${bot.poi}`,
      });
      allJobsCompleted = false;
      break;
    }

    await undockForTravel(ctx, warnedNoCloak);
    if (bot.state !== "running") {
      ctx.log("system", "⛔ Stopping — emergency detected");
      logCargoActivity(bot.username, "interruption", "Emergency detected before delivery travel", {
        location: `${bot.system}/${bot.poi}`,
      });
      return;
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

    await undockForTravel(ctx, warnedNoCloak);
    if (bot.state !== "running") {
      ctx.log("system", "⛔ Stopping — emergency detected");
      logCargoActivity(bot.username, "interruption", "Emergency detected during destination approach", {
        location: `${bot.system}/${bot.poi}`,
      });
      return;
    }
    if (!botIsAtStation(bot, settings.destinationStation)) {
      ctx.log("travel", `Traveling to ${settings.destinationStation}...`);
      logCargoActivity(bot.username, "navigation", `Traveling to destination station ${settings.destinationStation}`, {
        location: `${bot.system}: ${bot.poi} → ${settings.destinationStation}`,
      });
      const tResp = await bot.exec("travel", { target_poi: stationTravelTarget(settings.destinationStation) });
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
          // Check if mobile capital moved and we got location info
          if (settings.destinationStation === "mobile_capital" && errMsg.includes("jump to") && errMsg.includes("to find it")) {
            // Parse the error message like "Jump to First Step to find it."
            const match = tResp.error.message.match(/jump to (.+?) to find it/i);
            if (match) {
              const newSystemName = match[1];
              ctx.log("cargo", `Mobile capital relocated to system: ${newSystemName}`);

              // Update map store with new location
              // We need to get the system ID from the name, or use the name directly
              // For now, we'll query the current location and update the map
              const currentSystem = await getMobileStationSystem(ctx, "frontier_station");
              if (currentSystem) {
                // Update the map store
                mapStore.updateMobileCapitolLocation(currentSystem, newSystemName, "mobile_capital");
                ctx.log("cargo", `Updated map store: mobile capital now in ${newSystemName} (${currentSystem})`);

                // Navigate to the new system
                if (bot.system !== currentSystem) {
                  ctx.log("travel", `Mobile capital moved - navigating to ${newSystemName} (${currentSystem})...`);
                  const arrived = await navigateToSystem(ctx, currentSystem, safetyOpts);
                  if (!arrived || bot.state !== "running") {
                    if (bot.state !== "running") {
                      ctx.log("system", "⛔ Stopping — emergency detected");
                      return;
                    }
                    ctx.log("error", `Failed to reach mobile capital's new system ${currentSystem}`);
                    logCargoActivity(bot.username, "error", `Failed to navigate to mobile capital's new system ${currentSystem}`, {
                      location: `${bot.system}/${bot.poi}`,
                    });
                    allJobsCompleted = false;
                    break;
                  }
                  ctx.log("cargo", `✅ Arrived at mobile capital's new system ${currentSystem}`);
                }

                // Retry travel to the mobile capital
                const retryResp = await bot.exec("travel", { target_poi: stationTravelTarget(settings.destinationStation) });
                if (retryResp.error) {
                  const retryErrMsg = retryResp.error.message.toLowerCase();
                  if (!retryErrMsg.includes("already")) {
                    ctx.log("error", `Still failed to travel to relocated mobile capital: ${retryResp.error.message}`);
                    logCargoActivity(bot.username, "error", `Travel to relocated mobile capital failed: ${retryResp.error.message}`, {
                      location: `${bot.system}/${bot.poi}`,
                    });
                    allJobsCompleted = false;
                    break;
                  }
                } else {
                  bot.poi = stationTravelTarget(settings.destinationStation);
                }
              } else {
                ctx.log("error", "Could not determine mobile capital's new location from error message");
                logCargoActivity(bot.username, "error", "Could not parse mobile capital relocation from error message", {
                  location: `${bot.system}/${bot.poi}`,
                  error: tResp.error.message,
                });
                allJobsCompleted = false;
                break;
              }
            } else {
              ctx.log("error", "Could not parse new system name from mobile capital relocation error");
              logCargoActivity(bot.username, "error", "Could not parse system name from mobile capital relocation error", {
                location: `${bot.system}/${bot.poi}`,
                error: tResp.error.message,
              });
              allJobsCompleted = false;
              break;
            }
          }
          // Check if it's a mobile station that moved (fallback for other cases)
          else if (settings.destinationStation === "mobile_capital" && (errMsg.includes("not found") || errMsg.includes("does not exist") || errMsg.includes("not present"))) {
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
              const retryResp = await bot.exec("travel", { target_poi: stationTravelTarget(settings.destinationStation) });
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
          bot.poi = stationTravelTarget(settings.destinationStation);
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
        bot.poi = stationTravelTarget(settings.destinationStation);
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
    // Robust milestone log: cargo has physically arrived at the destination.
    logCargoActivity(bot.username, "arrived_destination", `Cargo arrived at destination ${settings.destinationStation} — preparing to unload`, {
      location: `${bot.system}/${settings.destinationStation}`,
    });

    yield "deposit_items";

    await bot.refreshCargo();
    // Deposit ALL items in cargo to the destination
    const itemsToDeposit = [...bot.inventory];

    if (itemsToDeposit.length > 0) {
      ctx.log("cargo", `📦 Depositing ${itemsToDeposit.length} item type(s) to destination (batch)...`);

      // Batch every deliverable cargo item into a single `storage` action (one
      // tick) instead of one deposit per item. `bulkDepositToDestination`
      // computes the actually-deposited quantities via a before/after storage
      // diff, equivalent to the previous per-item verification, but far faster.
      const depositList = itemsToDeposit
        .filter((item) => {
          if (item.quantity <= 0) return false;
          // Premium/energy cells never leave the ship; military cells keep the
          // required reserve aboard and deposit only the excess.
          if (isNeverDepositFuelItem(item.itemId)) return false;
          return fuelDepositQty(item.itemId, item.quantity, settings.militaryFuelCells) > 0;
        })
        .map((item) => {
          const depositQty = fuelDepositQty(item.itemId, item.quantity, settings.militaryFuelCells);
          if (item.itemId === "military_fuel_cell") {
            ctx.log("cargo", `🔋 Depositing ${depositQty}x military_fuel_cell (keeping reserve ${settings.militaryFuelCells}, carrying ${item.quantity})`);
          }
          return { itemId: item.itemId, quantity: depositQty };
        });

      // Batch every deliverable cargo item into a single `storage` action (one
      // tick) instead of one deposit per item — but ONLY when there are 2+ items.
      // A single item uses the regular per-item `depositToDestination` command so
      // the batched `items` form is never sent for a lone item.
      const depositedMap = depositList.length === 1
        ? await depositToDestination(
            ctx,
            depositList[0].itemId,
            depositList[0].quantity,
            settings.destinationStorageType,
            settings.destinationBotName,
          ).then((r) => r.success && r.depositedQty > 0
            ? new Map([[depositList[0].itemId, r.depositedQty]])
            : new Map<string, number>())
        : await bulkDepositToDestination(
            ctx,
            depositList,
            settings.destinationStorageType,
            settings.destinationBotName,
          );

      let deliveredItems: { itemId: string; quantity: number }[] = [];
      for (const [itemId, quantity] of depositedMap) {
        deliveredItems.push({ itemId, quantity });
        ctx.log("cargo", `✅ Verified delivery: ${quantity}x ${itemId} arrived at destination`);
      }

      if (deliveredItems.length > 0) {
        ctx.log("cargo", `📊 Verified total delivery: ${deliveredItems.reduce((sum, d) => sum + d.quantity, 0)} items across ${deliveredItems.length} types`);
      }

      totalTrips++;
      currentTrip = totalTrips;

      // Update delivery tracking with VERIFIED quantities
      if (deliveredItems.length > 0) {
        const itemIds = deliveredItems.map((d) => d.itemId);
        const quantities = deliveredItems.map((d) => d.quantity);
        updateDeliveryTracking(ctx, itemIds, quantities, settings);

        // Remove delivered items from in-transit tracking
        removeInTransitItems(bot.username, settings.destinationStation, deliveredItems);
        ctx.log("cargo", `📦 Removed ${deliveredItems.length} item types from in-transit tracking (${deliveredItems.reduce((sum, d) => sum + d.quantity, 0)} verified deliveries)`);

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

    // Refuel at destination to prevent getting stuck on return journey
    await tryRefuel(ctx);

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
      await undockForTravel(ctx, warnedNoCloak);
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
    await undockForTravel(ctx, warnedNoCloak);
    if (bot.state !== "running") {
      ctx.log("system", "⛔ Stopping — emergency detected");
      logCargoActivity(bot.username, "interruption", "Emergency detected during return to source station", {
        location: `${bot.system}/${bot.poi}`,
      });
      return;
    }
    if (!botIsAtStation(bot, settings.sourceStation)) {
      ctx.log("travel", `Traveling back to ${settings.sourceStation}...`);
      logCargoActivity(bot.username, "navigation", `Returning to source station ${settings.sourceStation}`, {
        location: `${bot.system}: ${bot.poi} → ${settings.sourceStation}`,
      });
      const tResp = await bot.exec("travel", { target_poi: stationTravelTarget(settings.sourceStation) });
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
      bot.poi = stationTravelTarget(settings.sourceStation);
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
