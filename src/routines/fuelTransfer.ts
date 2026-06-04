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
  startTrip,
  addTripEvent,
  completeTrip,
  failCurrentTrip,
  getCurrentTrip,
  loadFuelTransferData,
  saveFuelTransferData,
  type FuelTripRecord,
  getFactionStorageQuantity,
  getFactionStorageLastUpdated,
  updateFactionStorageFromDeposit,
  getFacilityTransferLoadouts,
  isStationCompletedForLoadout,
  saveStationCompletion,
  type FacilityTransferLoadout,
} from "./fuelTransferTracking.js";

const FUEL_CELL_ITEM_ID_PREFIXES = ["fuel_cell", "premium_fuel_cell"];

function isFuelCellItem(itemId: string): boolean {
  const lower = itemId.toLowerCase();
  return FUEL_CELL_ITEM_ID_PREFIXES.some(p => lower.includes(p));
}

interface TransferStrategy {
  skip: boolean;
  reason: string;
}

function determineTransferStrategy(
  cachedQty: number,
  currentQty: number,
  targetQty: number
): TransferStrategy {
  if (currentQty >= targetQty) {
    return { skip: true, reason: "already at target" };
  }

  if (cachedQty >= targetQty) {
    return { skip: true, reason: "cache shows at target" };
  }

  if (cachedQty > currentQty) {
    return { skip: false, reason: "cache indicates need, proceeding" };
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
  if (stationValue.includes("|")) return stationValue.split("|")[1];
  return stationValue;
}

async function getRemoteFactionQty(bot: Bot, remoteStationId: string, itemId: string): Promise<number> {
  try {
    const resp = await bot.exec("view_storage", { target: "faction", station_id: remoteStationId });
    if (resp.error || !resp.result) return 0;
    const result = resp.result as Record<string, unknown>;
    const items = Array.isArray(result.items) ? result.items : [];
    const found = items.find((i: any) => i.item_id === itemId);
    return found ? (found.quantity ?? 0) : 0;
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
  };

  const general = readSettings().general || {};
  const homeSystem = (general.factionStorageSystem as string) || "";
  const homeStation = (general.factionStorageStation as string) || "";

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

  if (settings.items.length === 0) {
    ctx.log("warn", "Fuel Transport: No items configured");
    yield "no_items";
    await ctx.sleep(60000);
    return;
  }

ctx.log("fuel", `Fuel Transport started: ${settings.stations.length} stations, ${settings.items.length} items`);

  const activeLoadouts = getActiveLoadouts();
  const useLoadoutMode = activeLoadouts.length > 0;
  if (useLoadoutMode) {
    ctx.log("fuel", `Loadout mode enabled: ${activeLoadouts.length} active loadout(s)`);
  }

  while (bot.state === "running") {
    yield "cycle_start";

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
      const remoteStationId = extractStationId(station);

      if (useLoadoutMode) {
        const loadoutItems: Map<string, number> = new Map();
        const applicableLoadouts: string[] = [];

        for (const loadout of activeLoadouts) {
          if (isStationCompletedForLoadout(remoteStationId, loadout.name)) {
            ctx.log("fuel", `${remoteStationId}: Already completed for loadout "${loadout.name}" — skipping`);
            continue;
          }

          applicableLoadouts.push(loadout.name);
          for (const item of loadout.items) {
            const currentQty = await getRemoteFactionQty(bot, remoteStationId, item.itemId);
            if (currentQty < item.targetQuantity) {
              const existing = loadoutItems.get(item.itemId) || 0;
              loadoutItems.set(item.itemId, Math.max(existing, item.targetQuantity));
            }
          }
        }

        if (loadoutItems.size === 0) {
          ctx.log("fuel", `${remoteStationId}: All active loadouts completed — skipping station`);
          continue;
        }

        allAtTarget = false;
        const deliveredItems: { itemId: string; quantity: number }[] = [];
        
        for (const [itemId, targetQty] of loadoutItems) {
          const item = settings.items.find(i => i.itemId === itemId) || { itemId, itemName: itemId, targetQuantity: targetQty };
          const result = await processItemTransfer(ctx, bot, item, remoteStationId, destSystem, homeSystem, homeStation, safetyOpts, new Set());
          if (result) deliveredItems.push({ itemId: result.itemId, quantity: result.qty });
        }

        if (deliveredItems.length > 0 && applicableLoadouts.length > 0) {
          for (const loadoutName of applicableLoadouts) {
            saveStationCompletion(remoteStationId, loadoutName, deliveredItems);
          }
        }
      } else {
        for (const item of settings.items) {
          const { cachedQty, currentQty } = await getItemStatus(ctx, bot, remoteStationId, item.itemId);
          if (currentQty >= item.targetQuantity) {
            ctx.log("fuel", `${remoteStationId}: ${item.itemName} at ${currentQty}/${item.targetQuantity} — ✓`);
            continue;
          }

          const strategy = determineTransferStrategy(cachedQty, currentQty, item.targetQuantity);
          ctx.log("fuel", `${remoteStationId}: ${item.itemName} at ${currentQty}/${item.targetQuantity} — ${strategy.reason}`);
          if (strategy.skip) continue;

          allAtTarget = false;
          await processItemTransfer(ctx, bot, item, remoteStationId, destSystem, homeSystem, homeStation, safetyOpts, new Set());
        }
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
  const { cachedQty, currentQty, hasCache } = await getItemStatus(ctx, bot, remoteStationId, item.itemId);

  if (currentQty >= item.targetQuantity) {
    ctx.log("fuel", `${remoteStationId}: ${item.itemName} at ${currentQty}/${item.targetQuantity} — ✓`);
    return null;
  }

  const strategy = determineTransferStrategy(cachedQty, currentQty, item.targetQuantity);
  ctx.log("fuel", `${remoteStationId}: ${item.itemName} at ${currentQty}/${item.targetQuantity} — ${strategy.reason}`);

  if (strategy.skip) {
    return null;
  }

  const needed = item.targetQuantity - currentQty;
  ctx.log("fuel", `${remoteStationId}: ${item.itemName} at ${currentQty}/${item.targetQuantity} — need ${needed}`);

  const itemSize = getItemSize(item.itemId);
  const maxCanCarry = Math.floor((bot.cargoMax || 825) / itemSize);
  const toWithdraw = Math.min(needed, maxCanCarry);

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
    const wr = await withdrawFromHomeFaction(ctx, bot, item.itemId, withdrawQty, homeStation);
    if (!wr.success) {
      ctx.log("error", `Failed to withdraw ${withdrawQty}x ${item.itemName} from home`);
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

  ctx.log("fuel", `Depositing ${cargoForDelivery}x ${item.itemName} to ${remoteStationId}...`);
  const depositResult = await depositToRemoteStation(ctx, bot, item.itemId, item.itemName, cargoForDelivery, remoteStationId);

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

  let currentQty: number;
  if (hasCache) {
    currentQty = cachedQty;
    ctx.log("fuel", `Using faction storage cache for ${remoteStationId}: ${itemId} = ${currentQty}`);
  } else {
    currentQty = await getRemoteFactionQty(bot, remoteStationId, itemId);
  }

  return { cachedQty, currentQty, hasCache };
}
