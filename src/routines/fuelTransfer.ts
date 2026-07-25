import type { Bot, Routine, RoutineContext } from "../bot.js";
import { mapStore } from "../mapstore.js";
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
  type BattleState,
} from "./common.js";
import {
  getFactionStorageQuantity,
  getFactionStorageLastUpdated,
  updateFactionStorageFromDeposit,
  getFacilityTransferLoadouts,
  isStationCompletedForLoadout,
  saveStationCompletion,
  type FacilityTransferLoadout,
} from "./fuelTransferTracking.js";
import { getFactionStorageCacheByStationOnly } from "../factionStorageCache.js";


const FACTION_STORAGE_API_RATE_LIMIT_MS = 1000;
const factionStorageApiLastCalled: Map<string, number> = new Map();

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
  const shipData = shipResp.result as Record<string, unknown>;
  const modules = Array.isArray(shipData.modules) ? shipData.modules : [];

  for (const mod of modules) {
    const modObj = typeof mod === "object" && mod !== null ? mod as Record<string, unknown> : null;
    const modId = ((modObj?.id as string) || (modObj?.type_id as string) || "").toLowerCase();
    const modName = ((modObj?.name as string) || "").toLowerCase();
    const modSpecial = ((modObj?.special as string) || "").toLowerCase();

    const checkStr = `${modId} ${modName} ${modSpecial}`;
    if (checkStr.includes("cloak")) {
      return true;
    }
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

async function withdrawFromHomeFaction(
  ctx: RoutineContext,
  bot: Bot,
  itemId: string,
  qty: number,
  homeStationId: string
): Promise<{ success: boolean; withdrawnQty: number }> {
  const freeSpace = Math.max(0, (bot.cargoMax || 825) - (bot.cargo || 0));
  const withdrawQty = Math.min(qty, maxItemsForCargo(freeSpace, itemId));
  if (withdrawQty <= 0) return { success: false, withdrawnQty: 0 };

  const beforeQty = bot.inventory.find((i) => i.itemId === itemId)?.quantity || 0;
  const resp = await bot.exec("storage", {
    action: "withdraw",
    target: "faction",
    item_id: itemId,
    quantity: withdrawQty,
    station_id: homeStationId,
  });
  if (resp.error) {
    ctx.log("error", `Withdraw failed: ${resp.error.message}`);
    return { success: false, withdrawnQty: 0 };
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    await ctx.sleep(1000);
    await bot.refreshCargo();
    const afterQty = bot.inventory.find((i) => i.itemId === itemId)?.quantity || 0;
    const withdrawn = Math.max(0, afterQty - beforeQty);
    if (withdrawn > 0) {
      return { success: true, withdrawnQty: withdrawn };
    }
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
      await bot.refreshCargo();
      const afterQty = bot.inventory.find((i) => i.itemId === itemId)?.quantity || 0;
      const deposited = Math.max(0, beforeQty - afterQty);
      if (deposited > 0) {
        logFactionActivity(ctx, "deposit", `Deposited ${deposited}x ${itemId} to ${remoteStationId} (fuel transport)`);
        updateFactionStorageFromDeposit(remoteStationId, bot.faction || "", itemId, deposited, itemName);
        return { success: true, depositedQty: deposited, mode: "faction" };
      }
    }
    ctx.log("warn", `Faction deposit reported success but cargo unchanged for ${itemId}`);
  }

  ctx.log("warn", `Faction deposit failed for ${itemId} to ${remoteStationId}: ${factionResp.error?.message} — trying personal storage`);
  const personalResp = await bot.exec("deposit_items", { item_id: itemId, quantity: qty, station_id: remoteStationId });
  if (!personalResp.error) {
    for (let attempt = 0; attempt < 5; attempt++) {
      await ctx.sleep(1000);
      await bot.refreshCargo();
      const afterQty = bot.inventory.find((i) => i.itemId === itemId)?.quantity || 0;
      const deposited = Math.max(0, beforeQty - afterQty);
      if (deposited > 0) {
        ctx.log("cargo", `Deposited to personal storage at ${remoteStationId}: ${deposited}x ${itemId}`);
        return { success: true, depositedQty: deposited, mode: "personal" };
      }
    }
    ctx.log("warn", `Personal deposit reported success but cargo unchanged for ${itemId}`);
  } else {
    ctx.log("error", `Personal deposit failed for ${itemId}: ${personalResp.error.message}`);
  }
  return { success: false, depositedQty: 0, mode: "failed" };
}

export const fuelTransportRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

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

  const homeSystem = settings.homeSystem || "";
  const homeStationRaw = settings.homeStation || "";
  const homeStation = homeStationRaw.includes("|") ? homeStationRaw.split("|")[1] : homeStationRaw;

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

      await tryRefuel(ctx);
      await repairShip(ctx);
    }

    let allAtTarget = true;
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
      
      const loadoutItems: Map<string, number> = new Map();
      const applicableLoadouts: string[] = [];
      const loadoutItemMap: Map<string, Set<string>> = new Map();
      
      const stationQtyCache = await getRemoteFactionAllItemsRateLimited(bot, remoteStationId);
      if (bot.state !== "running") { ctx.log("system", "Stopping"); return; }
      ctx.log("fuel", `Viewed faction storage at ${remoteStationId}: ${Object.keys(stationQtyCache).length} items found`);

      if (useLoadoutMode) {
        for (const loadout of activeLoadouts) {
          if (isStationCompletedForLoadout(remoteStationId, loadout.name)) {
            ctx.log("fuel", `${remoteStationId}: Already completed for loadout "${loadout.name}" — skipping`);
            continue;
          }

          loadoutItemMap.set(loadout.name, new Set());
          for (const item of loadout.items) {
            const existing = loadoutItems.get(item.itemId) || 0;
            loadoutItems.set(item.itemId, existing + item.targetQuantity);
          }
        }
        
        for (const [itemId, totalTarget] of loadoutItems) {
          const currentQty = stationQtyCache[itemId] || 0;
          ctx.log("fuel", `Checking ${itemId}: current=${currentQty}, totalTarget=${totalTarget}`);
          if (currentQty < totalTarget) {
            for (const loadout of activeLoadouts) {
              if (isStationCompletedForLoadout(remoteStationId, loadout.name)) continue;
              const hasItem = loadout.items.some(i => i.itemId === itemId);
              if (hasItem && !loadoutItemMap.get(loadout.name)!.has(itemId)) {
                loadoutItemMap.get(loadout.name)!.add(itemId);
                if (!applicableLoadouts.includes(loadout.name)) {
                  applicableLoadouts.push(loadout.name);
                }
              }
            }
          }
        }

        if (loadoutItems.size > 0) {
          allAtTarget = false;
          const deliveredItems: { itemId: string; quantity: number }[] = [];
          
          for (const [itemId, targetQty] of loadoutItems) {
            if (bot.state !== "running") { ctx.log("system", "Stopping"); return; }
            const item = settings.items.find(i => i.itemId === itemId) || { itemId, itemName: itemId, targetQuantity: targetQty };
            const result = await processItemTransfer(ctx, bot, item, remoteStationId, destSystem, homeSystem, homeStation, safetyOpts, new Set());
            if (result) deliveredItems.push({ itemId: result.itemId, quantity: result.qty });
          }

          if (deliveredItems.length > 0 && applicableLoadouts.length > 0) {
            const freshQtyCache = await getRemoteFactionAllItemsRateLimited(bot, remoteStationId);
            if (bot.state !== "running") { ctx.log("system", "Stopping"); return; }
            for (const loadoutName of applicableLoadouts) {
              const loadoutItemIds = loadoutItemMap.get(loadoutName)!;
              if (loadoutItemIds.size === 0) continue;
              const loadoutDeliveredItems = deliveredItems.filter(i => loadoutItemIds.has(i.itemId));
              if (loadoutDeliveredItems.length === 0) continue;
              
              const loadout = activeLoadouts.find(l => l.name === loadoutName);
              if (!loadout) continue;
              
              let allItemsAtTarget = true;
              for (const item of loadout.items) {
                const currentQty = freshQtyCache[item.itemId] || 0;
                if (currentQty < item.targetQuantity) {
                  allItemsAtTarget = false;
                  ctx.log("fuel", `${item.itemId}: ${currentQty}/${item.targetQuantity} - not at target`);
                  break;
                }
              }
              
              if (allItemsAtTarget) {
                ctx.log("fuel", `${loadoutName}: ALL ITEMS AT TARGET - saving completion`);
                saveStationCompletion(remoteStationId, loadoutName, loadoutDeliveredItems);
              }
            }
          }
        }
      }

      const processedItemIds = new Set(loadoutItems.keys());
      for (const item of settings.items) {
        if (bot.state !== "running") { ctx.log("system", "Stopping"); return; }
        if (processedItemIds.has(item.itemId)) continue;
        
        const { cachedQty, currentQty } = await getItemStatus(ctx, bot, remoteStationId, item.itemId);
        if (bot.state !== "running") { ctx.log("system", "Stopping"); return; }
        if (currentQty >= item.targetQuantity) {
          ctx.log("fuel", `${remoteStationId}: ${item.itemName} at ${currentQty}/${item.targetQuantity} — ✓`);
          continue;
        }

        const strategy = determineTransferStrategy(currentQty, item.targetQuantity);
        ctx.log("fuel", `${remoteStationId}: ${item.itemName} at ${currentQty}/${item.targetQuantity} — ${strategy.reason}`);
        if (strategy.skip) continue;

        allAtTarget = false;
        await processItemTransfer(ctx, bot, item, remoteStationId, destSystem, homeSystem, homeStation, safetyOpts, new Set());
      }
    }

    if (allAtTarget) {
      ctx.log("fuel", `All stations at target quantities — maintenance pause`);
      yield "maintenance";
      await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
      await ctx.sleep(300000);
      continue;
    }

    await ctx.sleep(5000);
  }
};

async function processItemTransfer(
  ctx: RoutineContext,
  bot: Bot,
  item: FuelTransportItem,
  remoteStationId: string,
  destSystem: string,
  homeSystem: string,
  homeStation: string,
  safetyOpts: { fuelThresholdPct: number; hullThresholdPct: number },
  processedLoadouts: Set<string>
): Promise<{ deposited: boolean; itemId: string; qty: number } | null> {
  if (bot.state !== "running") return null;
  const { cachedQty, currentQty, hasCache } = await getItemStatus(ctx, bot, remoteStationId, item.itemId);
  if (bot.state !== "running") return null;

  if (currentQty >= item.targetQuantity) {
    ctx.log("fuel", `${remoteStationId}: ${item.itemName} at ${currentQty}/${item.targetQuantity} — ✓`);
    return null;
  }

  const strategy = determineTransferStrategy(currentQty, item.targetQuantity);
  ctx.log("fuel", `${remoteStationId}: ${item.itemName} at ${currentQty}/${item.targetQuantity} — ${strategy.reason}`);

  if (strategy.skip) {
    return null;
  }

  const needed = item.targetQuantity - currentQty;
  ctx.log("fuel", `${remoteStationId}: ${item.itemName} at ${currentQty}/${item.targetQuantity} — need ${needed}`);

  const itemSize = getItemSize(item.itemId);
  const maxCanCarry = Math.floor((bot.cargoMax || 825) / itemSize);
  
  const toWithdraw = Math.min(Math.max(0, needed), maxCanCarry);

  if (toWithdraw <= 0) {
    ctx.log("warn", `Cannot carry any ${item.itemName} (size ${itemSize})`);
    return null;
  }

  await bot.refreshCargo();
  const currentCargoForItem = bot.inventory.find((i) => i.itemId === item.itemId)?.quantity || 0;
  const alreadyHave = currentCargoForItem;

  let withdrawQty = toWithdraw - alreadyHave;
  if (withdrawQty <= 0) {
    ctx.log("fuel", `Already have ${alreadyHave}x ${item.itemName} in cargo — delivering`);
  } else {
    if (bot.system !== homeSystem || bot.poi !== homeStation) {
      ctx.log("fuel", `Navigating to home base ${homeSystem}/${homeStation} for withdraw...`);
      if (bot.system !== homeSystem) {
        await ensureUndocked(ctx);
        if (bot.state !== "running") { ctx.log("system", "Stopping"); return null; }
        const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
        if (!fueled) { await ctx.sleep(30000); return null; }
        const arrived = await navigateToSystem(ctx, homeSystem, safetyOpts);
        if (!arrived || bot.state !== "running") {
          if (bot.state !== "running") { ctx.log("system", "Stopping"); return null; }
          await ctx.sleep(30000); return null;
        }
        ctx.log("fuel", `Arrived at home system ${homeSystem}`);
      }

      if (bot.poi !== homeStation) {
        await ensureUndocked(ctx);
        if (bot.state !== "running") { ctx.log("system", "Stopping"); return null; }
        const tResp = await bot.exec("travel", { target_poi: homeStation });
        if (bot.state !== "running") { ctx.log("system", "Stopping"); return null; }
        if (tResp.error && !tResp.error.message.toLowerCase().includes("already")) {
          ctx.log("error", `Travel to home station failed: ${tResp.error.message}`);
          await ctx.sleep(30000); return null;
        }
        await bot.refreshStatus();
        if (bot.poi !== homeStation) {
          ctx.log("error", `Travel to home station failed: not at target`);
          await ctx.sleep(30000); return null;
        }
      }

      if (!bot.docked) {
        const dockResp = await bot.exec("dock");
        if (dockResp.error && !dockResp.error.message.includes("already")) {
          ctx.log("error", `Dock at home failed: ${dockResp.error.message}`);
          await ctx.sleep(30000); return null;
        }
        bot.docked = true;
      }

      await tryRefuel(ctx);
      await repairShip(ctx);
    }

    ctx.log("fuel", `Withdrawing ${withdrawQty}x ${item.itemName} from home faction storage...`);
    const homeAvailable = await getHomeFactionQty(bot, homeStation, item.itemId);
    const cappedWithdrawQty = Math.min(withdrawQty, homeAvailable);
    if (cappedWithdrawQty <= 0) {
      ctx.log("warn", `${homeStation}: No ${item.itemName} in home faction storage — skipping`);
      return null;
    }
    if (cappedWithdrawQty < withdrawQty) {
      ctx.log("fuel", `${homeStation}: Capping ${item.itemName} withdraw to ${cappedWithdrawQty} (have ${homeAvailable} in storage)`);
    }
    const wr = await withdrawFromHomeFaction(ctx, bot, item.itemId, cappedWithdrawQty, homeStation);
    if (!wr.success) {
      ctx.log("error", `Failed to withdraw ${cappedWithdrawQty}x ${item.itemName} from home`);
      return null;
    }
    ctx.log("fuel", `Withdrew ${wr.withdrawnQty}x ${item.itemName} — departing`);
  }

  const cargoQty = bot.inventory.find((i) => i.itemId === item.itemId)?.quantity || 0;
  if (cargoQty <= 0) {
    ctx.log("error", `No ${item.itemName} in cargo after withdraw — skipping`);
    return null;
  }

  ctx.log("fuel", `Heading to ${destSystem}...`);
  if (bot.system !== destSystem) {
    const arrived = await navigateToSystem(ctx, destSystem, safetyOpts);
    if (!arrived || bot.state !== "running") {
      if (bot.state !== "running") { ctx.log("system", "Stopping"); return null; }
      ctx.log("error", `Failed to reach ${destSystem}`);
      await ctx.sleep(30000); return null;
    }
    ctx.log("fuel", `Arrived at ${destSystem}`);
  }

  if (bot.poi !== remoteStationId) {
    const tResp = await bot.exec("travel", { target_poi: remoteStationId });
    if (tResp.error && !tResp.error.message.toLowerCase().includes("already")) {
      ctx.log("error", `Travel to ${remoteStationId} failed: ${tResp.error.message}`);
      await ctx.sleep(30000); return null;
    }
    if (!tResp.error) bot.poi = remoteStationId;
  }

  const dockResp = await bot.exec("dock");
  if (dockResp.error && !dockResp.error.message.includes("already")) {
    ctx.log("error", `Dock failed: ${dockResp.error.message}`);
    await ctx.sleep(30000); return null;
  }
  bot.docked = true;

  await bot.refreshCargo();
  const cargoForDelivery = bot.inventory.find((i) => i.itemId === item.itemId)?.quantity || 0;
  if (cargoForDelivery <= 0) {
    ctx.log("error", `No ${item.itemName} in cargo to deposit`);
    return null;
  }

  const actualRemoteQty = await getRemoteFactionQty(bot, remoteStationId, item.itemId);
  const needNow = Math.max(0, item.targetQuantity - actualRemoteQty);
  const toDeposit = Math.min(cargoForDelivery, needNow);

  if (toDeposit <= 0) {
    ctx.log("fuel", `${remoteStationId}: ${item.itemName} already at target (${actualRemoteQty}/${item.targetQuantity}) after transit — nothing to deposit`);
    return null;
  }

  ctx.log("fuel", `${remoteStationId}: Depositing ${toDeposit}x ${item.itemName} to ${remoteStationId} (have ${cargoForDelivery}, need ${needNow})...`);
  const depositResult = await depositToRemoteStation(ctx, bot, item.itemId, item.itemName, toDeposit, remoteStationId);

  if (depositResult.success) {
    ctx.log("fuel", `Deposited ${depositResult.depositedQty}x ${item.itemName} to ${remoteStationId} via ${depositResult.mode}`);
  } else {
    ctx.log("error", `Could not deposit ${item.itemName} to ${remoteStationId}`);
  }

  await bot.refreshCargo();
  if (!bot.docked) bot.docked = false;
  
  return depositResult.success ? { deposited: true, itemId: item.itemId, qty: depositResult.depositedQty } : null;
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
