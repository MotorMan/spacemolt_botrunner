import type { Bot, Routine, RoutineContext } from "../bot.js";
import { mapStore } from "../mapstore.js";
import { extractShipModules, moduleHaystack } from "../shipmodules.js";
import {
  ensureUndocked,
  ensureFueled,
  tryRefuel,
  repairShip,
  navigateToSystem,
  detectAndRecoverFromDeath,
  readSettings,
  logFactionActivity,
  checkAndFleeFromBattle,
  getBattleStatus,
  getItemSize,
  maxItemsForCargo,
  cargoUsedFromInventory,
  type BattleState,
} from "./common.js";
import {
  getFactionStorageQuantity,
  getFactionStorageLastUpdated,
  updateFactionStorageFromDeposit,
  getFacilityTransferLoadouts,
  isStationCompletedForLoadout,
  saveStationCompletion,
  addLoadoutDeliveredQty,
  type FacilityTransferLoadout,
} from "./fuelTransferTracking.js";
import { getFactionStorageCacheByStationOnly } from "../factionStorageCache.js";
import {
  cleanupStaleLocks as cleanupFtStaleLocks,
  cleanupStaleInTransit as cleanupFtStaleInTransit,
  getAvailableDeliveryQuantity,
  getBotItemLock,
  getBotLocks,
  acquireDeliveryLockAtomic,
  updateDeliveredQuantity,
  releaseDeliveryLock,
  addInTransitItems as addFtInTransitItems,
  removeInTransitItems as removeFtInTransitItems,
  clearInTransitForItem as clearFtInTransitForItem,
} from "./fuelTransferCoordination.js";
import {
  buildLoadoutNeeds,
  loadoutItemIds as collectLoadoutItemIds,
  evaluateLoadoutSatisfaction,
  remainingDepositNeed,
  canSkipAsAlreadyStocked,
  splitForceCredit,
  type FtNeededItem,
  type FtLoadPlanItem,
} from "./fuelTransferPlanning.js";


const FACTION_STORAGE_API_RATE_LIMIT_MS = 1000;
const factionStorageApiLastCalled: Map<string, number> = new Map();
const TRANSFER_FAILURE_COOLDOWN_MS = 60000;
const lastTransferFailure = new Map<string, number>();

async function getRemoteFactionAllItemsRateLimited(bot: Bot, remoteStationId: string): Promise<Record<string, number>> {
  const cache = getFactionStorageCacheByStationOnly(remoteStationId);
  if (cache && Date.now() - cache.lastUpdated < FACTION_STORAGE_API_RATE_LIMIT_MS) {
    const result: Record<string, number> = {};
    for (const entry of cache.entries) {
      result[entry.itemId] = entry.quantity;
    }
    return result;
  }

  const now = Date.now();
  const lastCall = factionStorageApiLastCalled.get(remoteStationId) || 0;
  const timeSinceLastCall = now - lastCall;
  if (timeSinceLastCall < FACTION_STORAGE_API_RATE_LIMIT_MS) {
    const waitTime = FACTION_STORAGE_API_RATE_LIMIT_MS - timeSinceLastCall;
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }
  factionStorageApiLastCalled.set(remoteStationId, Date.now());
  return getRemoteFactionAllItems(bot, remoteStationId);
}

// ── Cloaking module detection and enablement ────────────────────────────────

/**
 * Check if the ship has a cloaking module installed.
 * Cloaking modules have "cloak" in their name, id, or special fields.
 * Returns true if a cloaking module is detected.
 */
async function hasCloakingModule(ctx: RoutineContext): Promise<boolean> {
  const { bot } = ctx;
  const shipResp = await bot.exec("get_ship");
  if (shipResp.error || !shipResp.result) return false;
  const { modules } = extractShipModules(shipResp.result);

  for (const mod of modules) {
    if (moduleHaystack(mod).includes("cloak")) return true;
  }
  return false;
}

/**
 * Enable cloaking on the bot if not already cloaked.
 * This is a one-time command - once enabled, it stays on until fuel runs out.
 * Returns true if cloaking was enabled (or already was), false if no cloak module.
 */
async function enableCloakingIfPossible(ctx: RoutineContext): Promise<boolean> {
  const { bot } = ctx;

  if (bot.isCloaked) {
    ctx.log("fuel", "Bot is already cloaked - no action needed");
    return true;
  }

  const hasCloak = await hasCloakingModule(ctx);
  if (!hasCloak) {
    ctx.log("fuel", "No cloaking module detected - cannot enable cloak");
    return false;
  }

  ctx.log("fuel", "Enabling cloaking module...");
  const resp = await bot.exec("cloak", { enable: true });
  if (resp.error) {
    ctx.log("error", `Failed to enable cloak: ${resp.error.message}`);
    return false;
  }

  ctx.log("fuel", "Cloaking enabled successfully");
  return true;
}


interface TransferStrategy {
  skip: boolean;
  reason: string;
}

function determineTransferStrategy(
  currentQty: number,
  targetQty: number
): TransferStrategy {
  if (currentQty >= targetQty) {
    return { skip: true, reason: "already at target" };
  }

  return { skip: false, reason: "proceeding with transfer" };
}

interface FuelTransportItem {
  itemId: string;
  itemName: string;
  targetQuantity: number;
}

interface FuelTransportSettings {
  stations: string[];
  items: FuelTransportItem[];
  refuelThreshold: number;
  repairThreshold: number;
  autoCloak: boolean;
  homeSystem?: string;
  homeStation?: string;
}

function getActiveLoadouts(): FacilityTransferLoadout[] {
  const allLoadouts = getFacilityTransferLoadouts();
  return Object.values(allLoadouts).filter(l => l.active);
}

/** "station:loadout" pairs whose completion notice was already logged this run. */
const completionNoticeShown = new Set<string>();

/**
 * Decide whether each pending loadout is finished for this station and record
 * the completion.
 */
function evaluateLoadoutCompletion(
  ctx: RoutineContext,
  remoteStationId: string,
  loadouts: FacilityTransferLoadout[],
  stationQtyCache: Record<string, number>,
  verbose: boolean
): void {
  for (const loadout of loadouts) {
    if (isStationCompletedForLoadout(remoteStationId, loadout.name)) continue;

    const status = evaluateLoadoutSatisfaction(remoteStationId, loadout, stationQtyCache);
    if (status.complete) {
      ctx.log("fuel", `${loadout.name}: ALL ITEMS AT TARGET at ${remoteStationId} — saving completion`);
      saveStationCompletion(
        remoteStationId,
        loadout.name,
        status.progress.map(p => ({ itemId: p.itemId, quantity: p.quantity }))
      );
    } else if (verbose && status.shortfall) {
      const { itemId, have, target, forceFull } = status.shortfall;
      const label = forceFull ? "delivered (full-delivery)" : "at station";
      ctx.log("fuel", `${itemId}: ${have}/${target} ${label} - not at target`);
    }
  }
}

function getFuelTransportSettings(username?: string): FuelTransportSettings {
  const all = readSettings();
  const general = all.general || {};
  const t = all.fuel_transport || {};
  const botOverrides = username ? (all[username] || {}) : {};

  const stations = (botOverrides.stations as string[]) || (t.stations as string[]) || [];
  const rawItems = (t.items as Array<Record<string, unknown>>) || [];
  const items: FuelTransportItem[] = rawItems
    .filter((item) => item.itemId && (item.targetQuantity as number) >= 0)
    .map((item) => ({
      itemId: item.itemId as string,
      itemName: ((item.itemName as string) || (item.itemId as string)),
      targetQuantity: (item.targetQuantity as number) || 0,
    }));

  return {
    stations,
    items,
    refuelThreshold: (t.refuelThreshold as number) || 35,
    repairThreshold: (t.repairThreshold as number) || 40,
    autoCloak: (t.autoCloak as boolean) ?? false,
    homeSystem: (botOverrides.homeSystem as string) || (general.factionStorageSystem as string) || "",
    homeStation: (botOverrides.homeStation as string) || (general.factionStorageStation as string) || "",
  };
}

function resolveStationSystem(stationId: string): string | null {
  if (!stationId) return null;
  let stationPart = stationId;
  let systemPart: string | null = null;
  if (stationId.includes("|")) {
    const parts = stationId.split("|");
    systemPart = parts[0];
    stationPart = parts[1];
  }
  const allSystems = mapStore.getAllSystems();
  for (const [sysId, sys] of Object.entries(allSystems)) {
    if (systemPart && sysId !== systemPart) continue;
    for (const poi of sys.pois) {
      if (poi.id === stationPart || poi.base_id === stationPart) return sysId;
    }
  }
  return null;
}

function extractStationId(stationValue: string): string {
  // Resolve a station reference (e.g. "system|poi" or a friendly name) to the
  // plain hex POI id the server expects for faction storage lookups/deposits.
  // Player faction bases are exposed as hex POI ids, so a remote
  // view_faction_storage / faction_deposit_items must use that id, not a
  // "system|poi" reference or a friendly name.
  return mapStore.resolveStationTarget(stationValue);
}

async function getRemoteFactionQty(bot: Bot, remoteStationId: string, itemId: string): Promise<number> {
  try {
    const resp = await bot.exec("view_faction_storage", { station_id: remoteStationId });
    if (resp.error || !resp.result) return 0;
    const result = resp.result as Record<string, unknown>;
    const items = Array.isArray(result.items) ? result.items : [];
    const found = items.find((i: any) => i.item_id === itemId || i.itemId === itemId);
    return found ? (found.quantity ?? found.qty ?? 0) : 0;
  } catch {
    return 0;
  }
}

async function getRemoteFactionAllItems(bot: Bot, remoteStationId: string): Promise<Record<string, number>> {
  try {
    const resp = await bot.exec("view_faction_storage", { station_id: remoteStationId });
    if (resp.error || !resp.result) return {};
    const result = resp.result as Record<string, unknown>;
    const items = Array.isArray(result.items) ? result.items : [];
    const qtyMap: Record<string, number> = {};
    for (const item of items) {
      const id = item.item_id || item.itemId;
      qtyMap[id] = item.quantity ?? item.qty ?? 0;
    }
    return qtyMap;
  } catch {
    return {};
  }
}

async function getHomeFactionQty(bot: Bot, homeStationId: string, itemId: string): Promise<number> {
  try {
    const resp = await bot.exec("view_faction_storage", { station_id: homeStationId });
    if (resp.error || !resp.result) return 0;
    const result = resp.result as Record<string, unknown>;
    const items = Array.isArray(result.items) ? result.items : [];
    const found = items.find((i: any) => i.item_id === itemId || i.itemId === itemId);
    return found ? (found.quantity ?? found.qty ?? 0) : 0;
  } catch {
    return 0;
  }
}

async function withdrawFromHomePersonalStorage(
  ctx: RoutineContext,
  bot: Bot,
  itemId: string,
  qty: number
): Promise<{ success: boolean; withdrawnQty: number }> {
  await bot.refreshStorage();
  const inStorage = bot.storage.find((i) => i.itemId === itemId);
  const available = inStorage?.quantity || 0;
  const withdrawQty = Math.min(qty, available);
  if (withdrawQty <= 0) return { success: false, withdrawnQty: 0 };

  const beforeQty = bot.inventory.find((i) => i.itemId === itemId)?.quantity || 0;
  const resp = await bot.exec("withdraw_items", { item_id: itemId, quantity: withdrawQty });
  if (resp.error) {
    ctx.log("error", `Personal storage withdraw failed: ${resp.error.message}`);
    return { success: false, withdrawnQty: 0 };
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    await ctx.sleep(1000);
    const afterQty = bot.inventory.find((i) => i.itemId === itemId)?.quantity || 0;
    const withdrawn = Math.max(0, afterQty - beforeQty);
    if (withdrawn > 0) return { success: true, withdrawnQty: withdrawn };
  }

  await bot.refreshCargo();
  const afterQty = bot.inventory.find((i) => i.itemId === itemId)?.quantity || 0;
  const withdrawn = Math.max(0, afterQty - beforeQty);
  if (withdrawn > 0) return { success: true, withdrawnQty: withdrawn };

  ctx.log("warn", `Personal storage withdraw returned success but no items in cargo (${itemId}) — may be cached`);
  return { success: false, withdrawnQty: 0 };
}

async function withdrawFromHomeFaction(
  ctx: RoutineContext,
  bot: Bot,
  itemId: string,
  qty: number,
  homeStationId: string
): Promise<{ success: boolean; withdrawnQty: number }> {
  await bot.refreshCargo();
  const usedCargo = cargoUsedFromInventory(bot);
  const freeSpace = Math.max(0, (bot.cargoMax || 825) - usedCargo);
  const withdrawQty = Math.min(qty, maxItemsForCargo(freeSpace, itemId));
  if (withdrawQty <= 0) return { success: false, withdrawnQty: 0 };

  const beforeQty = bot.inventory.find((i) => i.itemId === itemId)?.quantity || 0;
  const resp = await bot.exec("storage", {
    action: "withdraw",
    target: "faction",
    item_id: itemId,
    quantity: withdrawQty,
  });
  if (resp.error) {
    ctx.log("error", `Withdraw failed: ${resp.error.message}`);
    return { success: false, withdrawnQty: 0 };
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    await ctx.sleep(1000);
    const afterQty = bot.inventory.find((i) => i.itemId === itemId)?.quantity || 0;
    const withdrawn = Math.max(0, afterQty - beforeQty);
    if (withdrawn > 0) {
      return { success: true, withdrawnQty: withdrawn };
    }
  }

  await bot.refreshCargo();
  const afterQty = bot.inventory.find((i) => i.itemId === itemId)?.quantity || 0;
  const withdrawn = Math.max(0, afterQty - beforeQty);
  if (withdrawn > 0) {
    return { success: true, withdrawnQty: withdrawn };
  }

  ctx.log("warn", `Withdraw returned success but no items in cargo (${itemId}) — may be cached`);
  return { success: false, withdrawnQty: 0 };
}

async function depositToRemoteStation(
  ctx: RoutineContext,
  bot: Bot,
  itemId: string,
  itemName: string,
  qty: number,
  remoteStationId: string
): Promise<{ success: boolean; depositedQty: number; mode: "faction" | "personal" | "failed" }> {
  const beforeQty = bot.inventory.find((i) => i.itemId === itemId)?.quantity || 0;
  const factionResp = await bot.exec("faction_deposit_items", { item_id: itemId, quantity: qty, station_id: remoteStationId });
  if (!factionResp.error) {
    for (let attempt = 0; attempt < 5; attempt++) {
      await ctx.sleep(1000);
      const afterQty = bot.inventory.find((i) => i.itemId === itemId)?.quantity || 0;
      const deposited = Math.max(0, beforeQty - afterQty);
      if (deposited > 0) {
        logFactionActivity(ctx, "deposit", `Deposited ${deposited}x ${itemId} to ${remoteStationId} (fuel transport)`);
        updateFactionStorageFromDeposit(remoteStationId, bot.faction || "", itemId, deposited, itemName);
        return { success: true, depositedQty: deposited, mode: "faction" };
      }
    }
    await bot.refreshCargo();
    const afterQty = bot.inventory.find((i) => i.itemId === itemId)?.quantity || 0;
    const deposited = Math.max(0, beforeQty - afterQty);
    if (deposited > 0) {
      logFactionActivity(ctx, "deposit", `Deposited ${deposited}x ${itemId} to ${remoteStationId} (fuel transport)`);
      updateFactionStorageFromDeposit(remoteStationId, bot.faction || "", itemId, deposited, itemName);
      return { success: true, depositedQty: deposited, mode: "faction" };
    }
    ctx.log("warn", `Faction deposit reported success but cargo unchanged for ${itemId}`);
  }

  ctx.log("warn", `Faction deposit failed for ${itemId} to ${remoteStationId}: ${factionResp.error?.message} — trying personal storage`);
  const personalResp = await bot.exec("deposit_items", { item_id: itemId, quantity: qty, station_id: remoteStationId });
  if (!personalResp.error) {
    for (let attempt = 0; attempt < 5; attempt++) {
      await ctx.sleep(1000);
      const afterQty = bot.inventory.find((i) => i.itemId === itemId)?.quantity || 0;
      const deposited = Math.max(0, beforeQty - afterQty);
      if (deposited > 0) {
        ctx.log("cargo", `Deposited to personal storage at ${remoteStationId}: ${deposited}x ${itemId}`);
        return { success: true, depositedQty: deposited, mode: "personal" };
      }
    }
    await bot.refreshCargo();
    const afterQty = bot.inventory.find((i) => i.itemId === itemId)?.quantity || 0;
    const deposited = Math.max(0, beforeQty - afterQty);
    if (deposited > 0) {
      ctx.log("cargo", `Deposited to personal storage at ${remoteStationId}: ${deposited}x ${itemId}`);
      return { success: true, depositedQty: deposited, mode: "personal" };
    }
    ctx.log("warn", `Personal deposit reported success but cargo unchanged for ${itemId}`);
  } else {
    ctx.log("error", `Personal deposit failed for ${itemId}: ${personalResp.error.message}`);
  }
  return { success: false, depositedQty: 0, mode: "failed" };
}

async function depositCargoAtHome(
  ctx: RoutineContext,
  bot: Bot,
  homeStationId: string
): Promise<void> {
  await bot.refreshCargo();
  const items = bot.inventory.filter((i) => (i.quantity || 0) > 0);
  
  for (const item of items) {
    if (bot.state !== "running") return;
    
    const itemId = item.itemId;
    const qty = item.quantity || 0;
    if (qty <= 0) continue;
    
    ctx.log("cargo", `Depositing ${qty}x ${itemId} at home station ${homeStationId}...`);
    const factionResp = await bot.exec("faction_deposit_items", { item_id: itemId, quantity: qty, station_id: homeStationId });
    let deposited = false;
    if (!factionResp.error) {
      ctx.log("cargo", `Deposited ${qty}x ${itemId} to home faction storage`);
      deposited = true;
    }
    
    if (!deposited) {
      ctx.log("warn", `Home faction deposit failed for ${itemId}: ${factionResp.error?.message} — trying personal storage`);
      const personalResp = await bot.exec("deposit_items", { item_id: itemId, quantity: qty, station_id: homeStationId });
      if (!personalResp.error) {
        ctx.log("cargo", `Deposited ${qty}x ${itemId} to home personal storage`);
        deposited = true;
      } else {
        ctx.log("error", `Home deposit failed for ${itemId}: ${personalResp.error?.message}`);
      }
    }

    if (deposited) {
      // The cargo is now back in home storage, so any claim we still hold for
      // it is void. This has to run even when no lock is left (the lock is
      // normally released at the destination), otherwise the leftover
      // in-transit entry survives for 24h and blocks other bots from
      // claiming that quantity — the classic "waiting on others" deadlock.
      const clearedTransit = clearFtInTransitForItem(bot.username, itemId);
      if (clearedTransit > 0) {
        ctx.log("fuel", `Co-op: Cleared ${clearedTransit}x ${itemId} from in-transit tracking (returned to home storage)`);
      }

      const botLocks = getBotLocks(bot.username);
      for (const lock of botLocks) {
        if (lock.itemId === itemId && lock.isActive) {
          releaseDeliveryLock(bot.username, itemId, lock.remoteStationId, "cargo_deposited_at_home");
          ctx.log("fuel", `Co-op: Released lock for ${itemId} to ${lock.remoteStationId} (cargo deposited at home instead)`);
        }
      }
    }
  }
  
  await bot.refreshCargo();
}

export const fuelTransportRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  try {
    while (bot.state !== "running") {
      await ctx.sleep(2000);
    }

    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) {
      await ctx.sleep(30000);
      yield "death_recovery";
      return;
    }

    const battleState: BattleState = {
      inBattle: false,
      battleId: null,
      battleStartTick: null,
      lastHitTick: null,
      isFleeing: false,
      lastFleeTime: undefined,
    };

    if (await checkAndFleeFromBattle(ctx, "fuel_transport")) {
      await ctx.sleep(5000);
      yield "battle_flee";
    }

    await bot.refreshStatus();
    const settings = getFuelTransportSettings(bot.username);
    const safetyOpts = {
      fuelThresholdPct: settings.refuelThreshold,
      hullThresholdPct: settings.repairThreshold,
      autoCloak: settings.autoCloak,
    };

    const homeStationRaw = settings.homeStation || "";
    const homeStation = homeStationRaw.includes("|") ? homeStationRaw.split("|")[1] : homeStationRaw;
    const resolvedHomeSystem = resolveStationSystem(homeStation);
    const homeSystem = resolvedHomeSystem || settings.homeSystem || "";

    if (!homeSystem || !homeStation) {
      ctx.log("error", "Fuel Transport: General > Faction Storage Station must be set");
      yield "config_error";
      await ctx.sleep(60000);
      return;
    }

    if (settings.stations.length === 0) {
      ctx.log("warn", "Fuel Transport: No remote stations configured");
      yield "no_stations";
      await ctx.sleep(60000);
      return;
    }

    ctx.log("fuel", `Fuel Transport started: ${settings.stations.length} stations`);

    const cleanedLocks = cleanupFtStaleLocks();
    if (cleanedLocks > 0) {
      ctx.log("fuel", `Cleaned up ${cleanedLocks} stale co-op locks`);
    }
    const cleanedTransit = cleanupFtStaleInTransit();
    if (cleanedTransit > 0) {
      ctx.log("fuel", `Cleaned up ${cleanedTransit} stale in-transit entries`);
    }

    if (settings.autoCloak) {
      await enableCloakingIfPossible(ctx);
    }

    const activeLoadouts = getActiveLoadouts();
    const useLoadoutMode = activeLoadouts.length > 0;
    if (useLoadoutMode) {
      ctx.log("fuel", `Loadout mode enabled: ${activeLoadouts.length} active loadout(s)`);
    } else if (settings.items.length === 0) {
      ctx.log("warn", "Fuel Transport: No items configured");
      yield "no_items";
      await ctx.sleep(60000);
      return;
    }

    while (bot.state === "running") {
      yield "cycle_start";
      
      if (bot.state !== "running") { ctx.log("system", "Stopping"); return; }

      if (await checkAndFleeFromBattle(ctx, "fuel_transport")) {
        yield "battle_flee";
        await ctx.sleep(5000);
        continue;
      }

      if (bot.isInBattle()) {
        const now = Date.now();
        if (!battleState.lastFleeTime || now - battleState.lastFleeTime > 10000) {
          ctx.log("combat", "PERIODIC CHECK: IN BATTLE! - fleeing!");
          await bot.exec("battle", { action: "stance", stance: "flee" });
          battleState.lastFleeTime = now;
        }
        const bs = await getBattleStatus(ctx);
        if (!bs || !bs.is_participant) {
          battleState.lastFleeTime = undefined;
        }
        await ctx.sleep(2000);
        continue;
      }

      const aliveNow = await detectAndRecoverFromDeath(ctx);
      if (!aliveNow) {
        yield "death_recovery";
        await ctx.sleep(30000);
        continue;
      }

      if (settings.autoCloak && !bot.isCloaked && bot.fuel > 0) {
        ctx.log("fuel", "Cloak status check: bot not cloaked and has fuel — re-enabling cloak");
        await enableCloakingIfPossible(ctx);
      }

      await bot.refreshStatus();
      if (!bot.docked || bot.poi !== homeStation || bot.system !== homeSystem) {
        yield "go_home";
        ctx.log("fuel", `Navigating to home base ${homeSystem}/${homeStation}...`);

        if (bot.system !== homeSystem) {
          await ensureUndocked(ctx);
          if (bot.state !== "running") { ctx.log("system", "Stopping"); return; }
          const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
          if (!fueled) { await ctx.sleep(30000); continue; }
          const arrived = await navigateToSystem(ctx, homeSystem, safetyOpts);
          if (!arrived || bot.state !== "running") {
            if (bot.state !== "running") { ctx.log("system", "Stopping"); return; }
            await ctx.sleep(30000); continue;
          }
          ctx.log("fuel", `Arrived at home system ${homeSystem}`);
        }

        if (bot.poi !== homeStation) {
          await ensureUndocked(ctx);
          if (bot.state !== "running") { ctx.log("system", "Stopping"); return; }
          const tResp = await bot.exec("travel", { target_poi: homeStation });
          if (bot.state !== "running") { ctx.log("system", "Stopping"); return; }
          if (tResp.error) {
            const errMsg = tResp.error.message.toLowerCase();
            if (!errMsg.includes("already")) {
              ctx.log("error", `Travel to home station failed: ${tResp.error.message}`);
              await ctx.sleep(30000); continue;
            }
          } else {
            bot.poi = homeStation;
          }
        }

        if (!bot.docked) {
          yield "dock_home";
          const dockResp = await bot.exec("dock");
          if (dockResp.error && !dockResp.error.message.includes("already")) {
            ctx.log("error", `Dock at home failed: ${dockResp.error.message}`);
            await ctx.sleep(30000); continue;
          }
          bot.docked = true;
        }
      }

      await tryRefuel(ctx, { skipApprovedCheck: true });
      await repairShip(ctx);
      await depositCargoAtHome(ctx, bot, homeStation);

      let allAtTarget = true;
      let stationsOnCooldown = 0;
      let deliveriesAttempted = 0;
      const stationsToService: { station: string; system: string }[] = [];

      for (const station of settings.stations) {
        const sys = resolveStationSystem(station);
        if (!sys) {
          ctx.log("error", `Unknown station: ${station}`);
          continue;
        }
        stationsToService.push({ station, system: sys });
      }

      for (const { station, system: destSystem } of stationsToService) {
        if (bot.state !== "running") { ctx.log("system", "Stopping"); return; }
        
        const remoteStationId = extractStationId(station);

        // A station whose last trip achieved nothing is parked briefly instead
        // of being re-planned every few seconds (that produced the runaway
        // plan → re-verify → abort log spam).
        const failedAt = lastTransferFailure.get(remoteStationId) || 0;
        if (Date.now() - failedAt < TRANSFER_FAILURE_COOLDOWN_MS) {
          stationsOnCooldown++;
          continue;
        }

        const stationQtyCache = await getRemoteFactionAllItemsRateLimited(bot, remoteStationId);
        if (bot.state !== "running") { ctx.log("system", "Stopping"); return; }
        ctx.log("fuel", `Viewed faction storage at ${remoteStationId}: ${Object.keys(stationQtyCache).length} items found`);

        let loadoutItemIds = new Set<string>();

        if (useLoadoutMode) {
          const pendingLoadouts: FacilityTransferLoadout[] = [];
          for (const loadout of activeLoadouts) {
            if (isStationCompletedForLoadout(remoteStationId, loadout.name)) {
              const noticeKey = `${remoteStationId}:${loadout.name}`;
              if (!completionNoticeShown.has(noticeKey)) {
                completionNoticeShown.add(noticeKey);
                ctx.log("fuel", `${remoteStationId}: Already completed for loadout "${loadout.name}" — skipping`);
              }
              continue;
            }
            pendingLoadouts.push(loadout);
          }

          loadoutItemIds = collectLoadoutItemIds(pendingLoadouts);
          const loadoutNeeds = buildLoadoutNeeds(remoteStationId, pendingLoadouts, stationQtyCache, getItemSize);

          // Nothing outstanding? Then the loadout is done — record it now
          // rather than only after a delivery, so a satisfied loadout stops
          // being re-planned every cycle.
          evaluateLoadoutCompletion(ctx, remoteStationId, pendingLoadouts, stationQtyCache, false);

          if (loadoutNeeds.length > 0) {
            allAtTarget = false;
            deliveriesAttempted++;

            const batchResult = await deliverBatchToStation(ctx, bot, loadoutNeeds, remoteStationId, destSystem, homeSystem, homeStation, safetyOpts);
            if (bot.state !== "running") { ctx.log("system", "Stopping"); return; }
            const deliveredAnything = batchResult.some(r => r.deposited && r.qty > 0);
            if (deliveredAnything) {
              lastTransferFailure.delete(remoteStationId);
              const freshQtyCache = await getRemoteFactionAllItemsRateLimited(bot, remoteStationId);
              if (bot.state !== "running") { ctx.log("system", "Stopping"); return; }
              evaluateLoadoutCompletion(ctx, remoteStationId, pendingLoadouts, freshQtyCache, true);
            } else {
              lastTransferFailure.set(remoteStationId, Date.now());
              ctx.log("fuel", `${remoteStationId}: Nothing delivered this trip — pausing this station for ${Math.round(TRANSFER_FAILURE_COOLDOWN_MS / 1000)}s`);
            }
          }
        }

        const neededItems: FtNeededItem[] = [];
        for (const item of settings.items) {
          if (bot.state !== "running") { ctx.log("system", "Stopping"); return; }
          if (loadoutItemIds.has(item.itemId)) continue;
          
          const { cachedQty, currentQty } = await getItemStatus(ctx, bot, remoteStationId, item.itemId);
          if (bot.state !== "running") { ctx.log("system", "Stopping"); return; }
          if (currentQty >= item.targetQuantity) {
            ctx.log("fuel", `${remoteStationId}: ${item.itemName} at ${currentQty}/${item.targetQuantity} — ✓`);
            continue;
          }

          const strategy = determineTransferStrategy(currentQty, item.targetQuantity);
          ctx.log("fuel", `${remoteStationId}: ${item.itemName} at ${currentQty}/${item.targetQuantity} — ${strategy.reason}`);
          if (strategy.skip) continue;

          const coOpAvailable = getAvailableDeliveryQuantity(item.itemId, remoteStationId, item.targetQuantity - currentQty, bot.username);
          if (coOpAvailable <= 0) {
            ctx.log("fuel", `Co-op: ${item.itemName} fully claimed by other bots — skipping`);
            continue;
          }

          neededItems.push({
            itemId: item.itemId,
            itemName: item.itemName,
            needed: item.targetQuantity - currentQty,
            itemSize: getItemSize(item.itemId),
            stationTarget: item.targetQuantity,
            forceQty: 0,
            forceLoadouts: [],
          });
        }
        
        if (neededItems.length > 0) {
          allAtTarget = false;
          deliveriesAttempted++;
          const batchResult = await deliverBatchToStation(ctx, bot, neededItems, remoteStationId, destSystem, homeSystem, homeStation, safetyOpts);
          if (bot.state !== "running") { ctx.log("system", "Stopping"); return; }
          if (batchResult.some(r => r.deposited && r.qty > 0)) {
            lastTransferFailure.delete(remoteStationId);
          } else {
            lastTransferFailure.set(remoteStationId, Date.now());
            ctx.log("fuel", `${remoteStationId}: Nothing delivered this trip — pausing this station for ${Math.round(TRANSFER_FAILURE_COOLDOWN_MS / 1000)}s`);
          }
        }
      }

      if (allAtTarget && stationsOnCooldown === 0) {
        ctx.log("fuel", `All stations at target quantities — maintenance pause`);
        yield "maintenance";
        await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
        await ctx.sleep(300000);
        continue;
      }

      if (deliveriesAttempted === 0) {
        // Every station was either satisfied or on cooldown: idle instead of
        // re-running the whole planning pass (and its API calls) every 5s.
        await ctx.sleep(TRANSFER_FAILURE_COOLDOWN_MS);
        continue;
      }

      await ctx.sleep(5000);
    }
  } finally {
    import("./fuelTransferCoordination.js").then(m => m.shutdownCoordination()).catch(() => {});
  }
};

async function deliverBatchToStation(
  ctx: RoutineContext,
  bot: Bot,
  neededItems: FtNeededItem[],
  remoteStationId: string,
  destSystem: string,
  homeSystem: string,
  homeStation: string,
  safetyOpts: { fuelThresholdPct: number; hullThresholdPct: number }
): Promise<Array<{ deposited: boolean; itemId: string; qty: number }>> {
  const results: Array<{ deposited: boolean; itemId: string; qty: number }> = [];
  const botUsername = bot.username;

  if (bot.system !== homeSystem || bot.poi !== homeStation) {
    ctx.log("fuel", `Navigating to home base ${homeSystem}/${homeStation} for batch withdraw...`);
    if (bot.system !== homeSystem) {
      await ensureUndocked(ctx);
      if (bot.state !== "running") return results;
      const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
      if (!fueled) { await ctx.sleep(30000); return results; }
      const arrived = await navigateToSystem(ctx, homeSystem, safetyOpts);
      if (!arrived || bot.state !== "running") {
        if (bot.state !== "running") return results;
        await ctx.sleep(30000); return results;
      }
      ctx.log("fuel", `Arrived at home system ${homeSystem}`);
    }

    if (bot.poi !== homeStation) {
      await ensureUndocked(ctx);
      if (bot.state !== "running") return results;
      const tResp = await bot.exec("travel", { target_poi: homeStation });
      if (bot.state !== "running") return results;
      if (tResp.error && !tResp.error.message.toLowerCase().includes("already")) {
        ctx.log("error", `Travel to home station failed: ${tResp.error.message}`);
        await ctx.sleep(30000); return results;
      }
      await bot.refreshStatus();
      if (bot.poi !== homeStation) {
        ctx.log("error", `Travel to home station failed: not at target`);
        await ctx.sleep(30000); return results;
      }
    }

    if (!bot.docked) {
      const dockResp = await bot.exec("dock");
      if (dockResp.error && !dockResp.error.message.includes("already")) {
        ctx.log("error", `Dock at home failed: ${dockResp.error.message}`);
        await ctx.sleep(30000); return results;
      }
      bot.docked = true;
    }
  }

  await bot.refreshStatus();
  if (!bot.docked) {
    const dockResp = await bot.exec("dock");
    if (dockResp.error && !dockResp.error.message.includes("already")) {
      ctx.log("error", `Dock at home failed: ${dockResp.error.message}`);
      await ctx.sleep(30000); return results;
    }
    bot.docked = true;
  }

  await tryRefuel(ctx, { skipApprovedCheck: true });

  const loadPlan: FtLoadPlanItem[] = [];
  let plannedUsage = 0;
  
  for (const needed of neededItems) {
    if (bot.state !== "running") break;
    
    const usedCargo = cargoUsedFromInventory(bot);
    const freeSpace = Math.max(0, (bot.cargoMax || 825) - usedCargo - plannedUsage);
    if (freeSpace <= 0) {
      ctx.log("fuel", `Cargo full — stopping load at ${loadPlan.length} item type(s) (${plannedUsage}/${bot.cargoMax || 825} cargo space planned)`);
      break;
    }
    
    const maxCanCarry = maxItemsForCargo(freeSpace, needed.itemId);
    if (maxCanCarry <= 0) continue;
    
    const requestedQty = Math.min(needed.needed, maxCanCarry);
    const cargoLimited = requestedQty < needed.needed;
    
    const lockResult = await acquireDeliveryLockAtomic({
      botUsername,
      itemId: needed.itemId,
      itemName: needed.itemName,
      quantity: requestedQty,
      remoteStationId,
      totalNeed: needed.needed,
    });

    if (!lockResult.success) {
      ctx.log("fuel", `Co-op: ${needed.itemName} ${lockResult.message} — skipping`);
      continue;
    }

    const takeQty = lockResult.lockedQty;
    // Only blame co-op when the coordinator actually shrank our claim; a load
    // capped by our own hold is a cargo limit, not another bot.
    if (takeQty < requestedQty) {
      ctx.log("fuel", `Co-op: Capping ${needed.itemName} batch load to ${takeQty} of ${needed.needed} (others handling rest)`);
    } else if (cargoLimited) {
      ctx.log("fuel", `${needed.itemName}: hauling ${takeQty} of ${needed.needed} this trip (cargo limit — ${needed.needed - takeQty} left for later trips)`);
    }
    
    loadPlan.push({
      itemId: needed.itemId,
      itemName: needed.itemName,
      qty: takeQty,
      source: "faction",
      stationTarget: needed.stationTarget,
      forceQty: needed.forceQty,
      forceLoadouts: needed.forceLoadouts,
    });
    plannedUsage += takeQty * needed.itemSize;
  }

  if (loadPlan.length === 0) {
    ctx.log("fuel", "No items to load after co-op/cargo checks — skipping trip");
    return results;
  }

  const freshQtyCache = await getRemoteFactionAllItemsRateLimited(bot, remoteStationId);
  if (bot.state !== "running") return results;

  const verifiedPlan: FtLoadPlanItem[] = [];
  for (const plan of loadPlan) {
    const currentQty = freshQtyCache[plan.itemId] || 0;
    // Force-full demand is never satisfied by what the station already holds,
    // so only the station top-up portion may be cancelled here.
    if (canSkipAsAlreadyStocked(plan, currentQty)) {
      ctx.log("fuel", `Re-verify: ${remoteStationId} already has ${currentQty}/${plan.stationTarget} ${plan.itemName} — releasing lock and skipping`);
      releaseDeliveryLock(botUsername, plan.itemId, remoteStationId, "already_at_target");
      continue;
    }
    verifiedPlan.push(plan);
  }

  if (verifiedPlan.length === 0) {
    ctx.log("fuel", "All planned items already at target after re-verify — skipping trip");
    return results;
  }

  const finalPlan = verifiedPlan;
  ctx.log("fuel", `Batch loading ${finalPlan.length} item types (${finalPlan.reduce((s, i) => s + i.qty, 0)} total units) at home...`);
  
  const actualLoad: FtLoadPlanItem[] = [];
  
  for (const plan of finalPlan) {
    if (bot.state !== "running") break;
    
    await bot.refreshCargo();
    const usedCargoNow = cargoUsedFromInventory(bot);
    const freeSpaceNow = Math.max(0, (bot.cargoMax || 825) - usedCargoNow);
    if (freeSpaceNow <= 0) {
      ctx.log("fuel", `Cargo full after loading ${actualLoad.length} items — stopping`);
      break;
    }
    
    const maxFitNow = maxItemsForCargo(freeSpaceNow, plan.itemId);
    const adjustedQty = Math.min(plan.qty, maxFitNow);
    if (adjustedQty <= 0) {
      ctx.log("fuel", `No room for ${plan.itemName} (need ${plan.qty}, only ${freeSpaceNow} space) — skipping`);
      continue;
    }
    if (adjustedQty < plan.qty) {
      ctx.log("fuel", `Capping ${plan.itemName} to ${adjustedQty} (cargo limit, was ${plan.qty})`);
    }
    plan.qty = adjustedQty;
    
    const personalAvailable = (bot.storage.find((i) => i.itemId === plan.itemId)?.quantity || 0);
    if (personalAvailable > 0) {
      const personalCap = Math.min(plan.qty, personalAvailable);
      ctx.log("fuel", `Found ${personalAvailable}x ${plan.itemName} in personal storage — trying to withdraw ${personalCap}x...`);
      const pw = await withdrawFromHomePersonalStorage(ctx, bot, plan.itemId, personalCap);
      if (pw.success && pw.withdrawnQty > 0) {
        plan.qty = pw.withdrawnQty;
        plan.source = "personal";
        actualLoad.push({ ...plan });
        ctx.log("fuel", `Withdrew ${pw.withdrawnQty}x ${plan.itemName} from personal storage`);
        continue;
      }
    }
    
    ctx.log("fuel", `Withdrawing ${plan.qty}x ${plan.itemName} from home faction storage...`);
    const homeAvailable = await getHomeFactionQty(bot, homeStation, plan.itemId);
    const factionCap = Math.min(plan.qty, homeAvailable);
    if (factionCap > 0) {
      plan.qty = factionCap;
      plan.source = "faction";
    } else {
      ctx.log("warn", `${homeStation}: No ${plan.itemName} in faction storage (wanted ${plan.qty})`);
      releaseDeliveryLock(botUsername, plan.itemId, remoteStationId, "home_storage_empty");
      plan.qty = 0;
      continue;
    }
    
    let wr: { success: boolean; withdrawnQty: number };
    if (plan.source === "personal") {
      wr = await withdrawFromHomePersonalStorage(ctx, bot, plan.itemId, plan.qty);
    } else {
      wr = await withdrawFromHomeFaction(ctx, bot, plan.itemId, plan.qty, homeStation);
    }
    
    if (!wr.success) {
      ctx.log("error", `Failed to withdraw ${plan.qty}x ${plan.itemName} from ${plan.source} storage`);
      releaseDeliveryLock(botUsername, plan.itemId, remoteStationId, "withdraw_failed");
      plan.qty = 0;
    } else {
      plan.qty = wr.withdrawnQty;
      actualLoad.push({ ...plan });
      ctx.log("fuel", `Withdrew ${wr.withdrawnQty}x ${plan.itemName} from ${plan.source} storage`);
    }
  }
  if (actualLoad.length === 0) {
    ctx.log("warn", "Nothing actually loaded — skipping trip");
    return results;
  }

  for (const plan of actualLoad) {
    const lock = getBotItemLock(botUsername, plan.itemId, remoteStationId);
    if (lock && plan.qty < lock.lockedQuantity) {
      const previous = lock.lockedQuantity;
      lock.lockedQuantity = plan.qty;
      ctx.log("fuel", `Adjusted lock for ${plan.itemName} from ${previous} to ${plan.qty} (${previous - plan.qty} capacity released)`);
    }
  }

  for (const plan of actualLoad) {
    addFtInTransitItems(botUsername, remoteStationId, [
      { itemId: plan.itemId, itemName: plan.itemName, quantity: plan.qty },
    ]);
  }
  ctx.log("fuel", `Co-op: Tracked ${actualLoad.reduce((s, p) => s + p.qty, 0)} units in-transit to ${remoteStationId}`);

  const fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
  if (fuelPct < safetyOpts.fuelThresholdPct) {
    ctx.log("fuel", `Fuel low (${fuelPct}%) before departure — refueling...`);
    await tryRefuel(ctx, { skipApprovedCheck: true });
  }

  ctx.log("fuel", `Heading to ${destSystem} with ${actualLoad.length} item types...`);
  if (bot.system !== destSystem) {
    const arrived = await navigateToSystem(ctx, destSystem, safetyOpts);
    if (!arrived || bot.state !== "running") {
      ctx.log("error", `Failed to reach ${destSystem} — returning items to co-op tracking`);
      for (const plan of actualLoad) {
        removeFtInTransitItems(botUsername, remoteStationId, [{ itemId: plan.itemId, quantity: plan.qty }]);
        releaseDeliveryLock(botUsername, plan.itemId, remoteStationId, "navigation_failed");
      }
      await ctx.sleep(30000);
      return results;
    }
    ctx.log("fuel", `Arrived at ${destSystem}`);
  }

  if (bot.poi !== remoteStationId) {
    const tResp = await bot.exec("travel", { target_poi: remoteStationId });
    if (tResp.error && !tResp.error.message.toLowerCase().includes("already")) {
      ctx.log("error", `Travel to ${remoteStationId} failed: ${tResp.error.message}`);
      for (const plan of actualLoad) {
        removeFtInTransitItems(botUsername, remoteStationId, [{ itemId: plan.itemId, quantity: plan.qty }]);
        releaseDeliveryLock(botUsername, plan.itemId, remoteStationId, "navigation_failed");
      }
      await ctx.sleep(30000);
      return results;
    }
    if (!tResp.error) bot.poi = remoteStationId;
  }

  const dockResp = await bot.exec("dock");
  if (dockResp.error && !dockResp.error.message.includes("already")) {
    ctx.log("error", `Dock at ${remoteStationId} failed: ${dockResp.error.message}`);
    for (const plan of actualLoad) {
      removeFtInTransitItems(botUsername, remoteStationId, [{ itemId: plan.itemId, quantity: plan.qty }]);
      releaseDeliveryLock(botUsername, plan.itemId, remoteStationId, "dock_failed");
    }
    await ctx.sleep(30000);
    return results;
  }
  bot.docked = true;

  await bot.refreshCargo();
  for (const plan of actualLoad) {
    if (bot.state !== "running") break;
    
    const cargoQty = bot.inventory.find((i) => i.itemId === plan.itemId)?.quantity || 0;
    if (cargoQty <= 0) {
      ctx.log("error", `No ${plan.itemName} in cargo to deposit (expected ${plan.qty})`);
      releaseDeliveryLock(botUsername, plan.itemId, remoteStationId, "cargo_missing");
      removeFtInTransitItems(botUsername, remoteStationId, [{ itemId: plan.itemId, quantity: plan.qty }]);
      results.push({ deposited: false, itemId: plan.itemId, qty: 0 });
      continue;
    }

    const currentStationQty = await getRemoteFactionQty(bot, remoteStationId, plan.itemId);
    // Force-full demand must be deposited even when the station is already
    // stocked, so it is added on top of any remaining top-up need.
    const { total: remainingNeed, stationNeed, forceNeed } = remainingDepositNeed(plan, currentStationQty);
    
    if (remainingNeed <= 0) {
      ctx.log("fuel", `${remoteStationId}: ${plan.itemName} already at target (${currentStationQty}/${plan.stationTarget}) — skipping deposit, releasing lock`);
      releaseDeliveryLock(botUsername, plan.itemId, remoteStationId, "already_at_target");
      removeFtInTransitItems(botUsername, remoteStationId, [{ itemId: plan.itemId, quantity: plan.qty }]);
      results.push({ deposited: false, itemId: plan.itemId, qty: 0 });
      continue;
    }
    
    const toDeposit = Math.min(cargoQty, plan.qty, remainingNeed);
    const needLabel = forceNeed > 0
      ? `full-delivery ${forceNeed}${stationNeed > 0 ? ` + top-up ${stationNeed}` : ""}`
      : `need ${remainingNeed}`;
    ctx.log("fuel", `${remoteStationId}: Depositing ${toDeposit}x ${plan.itemName} (${needLabel}, have ${cargoQty})...`);
    const depositResult = await depositToRemoteStation(ctx, bot, plan.itemId, plan.itemName, toDeposit, remoteStationId);

    if (depositResult.success) {
      const actualDeposited = depositResult.depositedQty;
      if (actualDeposited > remainingNeed) {
        ctx.log("warn", `Deposited ${actualDeposited} but only ${remainingNeed} needed — possible overshoot`);
      }
      results.push({ deposited: true, itemId: plan.itemId, qty: actualDeposited });

      // Credit force-full loadouts first: their progress is the only record
      // that these units were ever hauled here.
      for (const credit of splitForceCredit(plan.forceLoadouts, actualDeposited)) {
        const total = addLoadoutDeliveredQty(remoteStationId, credit.loadoutName, plan.itemId, credit.credit, credit.target);
        ctx.log("fuel", `Full-delivery progress: ${credit.loadoutName} ${plan.itemName} ${total}/${credit.target} at ${remoteStationId}`);
      }
      
      updateDeliveredQuantity(botUsername, plan.itemId, remoteStationId, actualDeposited);
      removeFtInTransitItems(botUsername, remoteStationId, [{ itemId: plan.itemId, quantity: actualDeposited }]);
      
      const remainingLock = getBotItemLock(botUsername, plan.itemId, remoteStationId);
      if (remainingLock && remainingLock.deliveredQuantity >= remainingLock.lockedQuantity) {
        // Only release once this trip's whole claim landed; a partial deposit
        // keeps the claim so the leftover cargo stays accounted for (it is
        // released when the remainder is dumped back into home storage).
        releaseDeliveryLock(botUsername, plan.itemId, remoteStationId, "completed");
        ctx.log("fuel", `Co-op: Released lock for ${plan.itemName} to ${remoteStationId} (delivery complete)`);
      }
    } else {
      ctx.log("error", `Could not deposit ${plan.itemName} to ${remoteStationId}`);
      results.push({ deposited: false, itemId: plan.itemId, qty: 0 });
    }
  }

  const fuelPctAfter = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
  if (fuelPctAfter < safetyOpts.fuelThresholdPct) {
    ctx.log("fuel", `Fuel low (${fuelPctAfter}%) after delivery — refueling at ${remoteStationId} before return...`);
    await tryRefuel(ctx, { skipApprovedCheck: true });
    await bot.refreshShip();
    const postRefuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    ctx.log("fuel", `Refueled at ${remoteStationId} — fuel now ${postRefuelPct}%`);
  }

  if (!bot.docked) bot.docked = false;
  
  return results;
}


async function getItemStatus(
  ctx: RoutineContext,
  bot: Bot,
  remoteStationId: string,
  itemId: string
): Promise<{ cachedQty: number; currentQty: number; hasCache: boolean }> {
  const cachedQty = getFactionStorageQuantity(remoteStationId, itemId);
  const cachedLastUpdated = getFactionStorageLastUpdated(remoteStationId);
  const hasCache = cachedLastUpdated > 0;

  const cache = getFactionStorageCacheByStationOnly(remoteStationId);
  if (cache && Date.now() - cache.lastUpdated < FACTION_STORAGE_API_RATE_LIMIT_MS) {
    return { cachedQty, currentQty: cachedQty, hasCache };
  }

  const now = Date.now();
  const lastCall = factionStorageApiLastCalled.get(remoteStationId) || 0;
  const timeSinceLastCall = now - lastCall;
  if (timeSinceLastCall < FACTION_STORAGE_API_RATE_LIMIT_MS) {
    const waitTime = FACTION_STORAGE_API_RATE_LIMIT_MS - timeSinceLastCall;
    await ctx.sleep(waitTime);
  }
  factionStorageApiLastCalled.set(remoteStationId, Date.now());

  const currentQty = await getRemoteFactionQty(bot, remoteStationId, itemId);
  if (bot.state !== "running") return { cachedQty, currentQty, hasCache };
  ctx.log("fuel", `Remote faction storage for ${remoteStationId}: ${itemId} = ${currentQty}`);

  return { cachedQty, currentQty, hasCache };
}
