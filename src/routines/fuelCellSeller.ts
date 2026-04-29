/**
 * Fuel Cell Seller routine — travels to non-pirate stations and posts fuel cells for sale.
 *
 * Unlike full traders, this bot:
 * - Always starts at faction home base with MAX fuel cells
 * - Travels to each non-pirate station and creates sell orders
 * - Uses auto-pricing (midpoint between min/max) or manual price
 * - Returns home to restock and repeat
 *
 * Tracks placed orders in data/fcStations.json.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import type { Routine, RoutineContext } from "../bot.js";
import { mapStore } from "../mapstore.js";
import {
  ensureDocked,
  ensureUndocked,
  tryRefuel,
  repairShip,
  ensureFueled,
  navigateToSystem,
  detectAndRecoverFromDeath,
  maxItemsForCargo,
  readSettings,
  isPirateSystem,
  checkAndFleeFromBattle,
  checkBattleAfterCommand,
  travelToStationWithHint,
  type BattleState,
  getBattleStatus,
  fleeFromBattle,
} from "./common.js";

const FUEL_CELL_ITEM_ID = "fuel_cell";
const FUEL_CELL_ITEM_NAME = "Fuel Cell";
const FC_STATIONS_FILE = "data/fcStations.json";

interface FCOrder {
  orderId: string;
  quantity: number;
  remaining: number;
  filledQuantity: number;
  priceEach: number;
  createdAt: string;
}

interface FCStationEntry {
  systemId: string;
  poiId: string;
  poiName: string;
  ordersPlaced: number;
  ordersUnsold: number;
  activeOrders: FCOrder[];
  lastVisit: string | null;
  lastPrice: number | null;
}

interface FCStationsData {
  version: number;
  homeSystem: string;
  homeStation: string;
  stations: FCStationEntry[];
  currentStationIndex: number;
  lastStarted: string;
}

function loadFCStationsData(): FCStationsData {
  try {
    if (!existsSync(FC_STATIONS_FILE)) {
      return {
        version: 1,
        homeSystem: "",
        homeStation: "",
        stations: [],
        currentStationIndex: 0,
        lastStarted: new Date().toISOString(),
      };
    }
    const rawData = readFileSync(FC_STATIONS_FILE, "utf-8");
    const data: FCStationsData = JSON.parse(rawData);
    // Backward compatibility: only keep fields we want, add ordersUnsold and activeOrders if missing
    data.stations = data.stations.map(station => ({
      systemId: station.systemId,
      poiId: station.poiId,
      poiName: station.poiName,
      ordersPlaced: station.ordersPlaced ?? 0,
      ordersUnsold: station.ordersUnsold ?? 0,
      activeOrders: station.activeOrders ?? [],
      lastVisit: station.lastVisit ?? null,
      lastPrice: station.lastPrice ?? null,
    }));
    return data;
  } catch {
    return {
      version: 1,
      homeSystem: "",
      homeStation: "",
      stations: [],
      currentStationIndex: 0,
      lastStarted: new Date().toISOString(),
    };
  }
}

function saveFCStationsData(data: FCStationsData): void {
  writeFileSync(FC_STATIONS_FILE, JSON.stringify(data, null, 2));
}

function getFuelCellSellerSettings(username?: string): {
  homeSystem: string;
  homeStation: string;
  fuelCostPerJump: number;
  refuelThreshold: number;
  repairThreshold: number;
  priceMode: "manual" | "auto";
  baseTargetPrice: number;
  autoMinPrice: number;
  autoMaxPrice: number;
} {
  const all = readSettings();
  const general = (all.general as Record<string, unknown>) || {};
  const t = all.fuel_cell_seller as Record<string, unknown> | undefined;
  const fc = t || {};
  const botOverrides = username ? (all[username] as Record<string, unknown>) : undefined;
  const priceModeVal = (fc.priceMode as string) || "auto";
  const priceMode: "manual" | "auto" = priceModeVal === "manual" ? "manual" : "auto";
  return {
    homeSystem: (botOverrides?.homeSystem as string) || (fc.homeSystem as string) || (general.factionStorageSystem as string) || "sol",
    homeStation: (botOverrides?.homeStation as string) || (fc.homeStation as string) || (general.factionStorageStation as string) || "sol_central",
    fuelCostPerJump: (fc.fuelCostPerJump as number) || 10,
    refuelThreshold: (fc.refuelThreshold as number) || 35,
    repairThreshold: (fc.repairThreshold as number) || 80,
    priceMode,
    baseTargetPrice: (fc.baseTargetPrice as number) || 40,
    autoMinPrice: (fc.autoMinPrice as number) || 30,
    autoMaxPrice: (fc.autoMaxPrice as number) || 50,
  };
}

function estimateFuelCost(fromSystem: string, toSystem: string, costPerJump: number): { jumps: number; cost: number } {
  if (fromSystem === toSystem) return { jumps: 0, cost: 0 };
  const route = mapStore.findRoute(fromSystem, toSystem);
  if (!route) return { jumps: 999, cost: 999 * costPerJump };
  const jumps = route.length - 1;
  return { jumps, cost: jumps * costPerJump };
}

function initializeFCStations(settings: ReturnType<typeof getFuelCellSellerSettings>): FCStationEntry[] {
  const entries: FCStationEntry[] = [];
  const systems = mapStore.getAllSystems();

  for (const [systemId, sys] of Object.entries(systems)) {
    if (isPirateSystem(systemId)) continue;

    for (const poi of sys.pois) {
      if (!poi.has_base) continue;
      if (isPirateSystem(systemId)) continue;

      entries.push({
        systemId,
        poiId: poi.id,
        poiName: poi.name,
        ordersPlaced: 0,
        ordersUnsold: 0,
        activeOrders: [],
        lastVisit: null,
        lastPrice: null,
      });
    }
  }

  return entries;
}

async function getOptimalPrice(
  ctx: RoutineContext,
  marketData: unknown,
  settings: ReturnType<typeof getFuelCellSellerSettings>,
): Promise<number> {
  const { bot } = ctx;

  if (settings.priceMode === "manual") {
    return settings.baseTargetPrice;
  }

  if (!marketData || typeof marketData !== "object") {
    return settings.baseTargetPrice;
  }

  const md = marketData as Record<string, unknown>;
  const items = Array.isArray(md) ? md : Array.isArray(md.items) ? md.items : [];
  const fcItem = items.find(i => (i as Record<string, unknown>).item_id === FUEL_CELL_ITEM_ID);
  if (!fcItem) {
    return settings.baseTargetPrice;
  }

  const fi = fcItem as Record<string, unknown>;
  const bestSell = (fi.best_sell as number) || 0;
  const bestBuy = (fi.best_buy as number) || 0;

  if (bestSell > 0 && bestBuy > 0) {
    const midPrice = Math.round((bestBuy + bestSell) / 2);
    if (midPrice >= settings.autoMinPrice && midPrice <= settings.autoMaxPrice) {
      return midPrice;
    }
  }

  if (bestSell >= settings.autoMinPrice && bestSell <= settings.autoMaxPrice) {
    return bestSell;
  }

  if (bestBuy >= settings.autoMinPrice && bestBuy <= settings.autoMaxPrice) {
    return bestBuy;
  }

  return settings.baseTargetPrice;
}

function getNextStation(
  data: FCStationsData,
  currentIndex: number,
): number {
  const totalStations = data.stations.length;
  if (totalStations === 0) return -1;

  // Prioritize unvisited stations first
  const unvisited = data.stations
    .map((station, idx) => ({ station, idx }))
    .filter(({ station }) => station.ordersPlaced === 0);

  if (unvisited.length > 0) {
    const startIdx = (currentIndex + 1) % totalStations;
    for (let i = 0; i < totalStations; i++) {
      const idx = (startIdx + i) % totalStations;
      if (data.stations[idx].ordersPlaced === 0) {
        return idx;
      }
    }
  }

  // All stations visited: sort by sales volume (ordersPlaced - ordersUnsold) descending
  const stationSales = data.stations.map((station, idx) => ({
    idx,
    sales: station.ordersPlaced - station.ordersUnsold,
    lastVisit: station.lastVisit ? new Date(station.lastVisit).getTime() : 0,
  }));

  // Sort by sales descending, then lastVisit ascending (oldest first)
  stationSales.sort((a, b) => {
    if (b.sales !== a.sales) return b.sales - a.sales;
    return a.lastVisit - b.lastVisit;
  });

  // Find next station in sorted order after currentIndex
  const sortedIndices = stationSales.map(s => s.idx);
  const currentSortedPos = sortedIndices.indexOf(currentIndex);
  const nextSortedPos = (currentSortedPos + 1) % sortedIndices.length;
  return sortedIndices[nextSortedPos];
}

export const fuelCellSellerRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  await bot.refreshStatus();
  const settings = getFuelCellSellerSettings(bot.username);
  const safetyOpts = {
    fuelThresholdPct: settings.refuelThreshold,
    hullThresholdPct: settings.repairThreshold,
  };

  let fcData = loadFCStationsData();

  if (!fcData.homeSystem || fcData.homeSystem !== settings.homeSystem) {
    fcData.homeSystem = settings.homeSystem;
    fcData.homeStation = settings.homeStation;
    fcData.stations = initializeFCStations(settings);
    fcData.currentStationIndex = 0;
    fcData.lastStarted = new Date().toISOString();
    saveFCStationsData(fcData);
  }

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
      await ctx.sleep(30000);
      continue;
    }

    if (await checkAndFleeFromBattle(ctx, "fuelCellSeller")) {
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
        await ctx.sleep(2000); // Brief pause before next check
        continue;
      }
      // Still in battle - continue to next cycle
      await ctx.sleep(2000); // Brief pause before next check
      continue;
    }

    await bot.refreshStatus();
    await bot.refreshCargo();

    const fuelCellItem = bot.inventory.find(i => i.itemId === FUEL_CELL_ITEM_ID);
    let cargoQty = fuelCellItem?.quantity ?? 0;

    const atHomeStation = bot.system === settings.homeSystem && bot.poi === settings.homeStation;

    if (!atHomeStation && cargoQty <= 0) {
      ctx.log("fc", `No cargo and not at home (${bot.system}/${bot.poi}) — returning home to restock`);
      yield "return_home";
      if (bot.system !== settings.homeSystem) {
        await ensureUndocked(ctx);
        const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
        if (!fueled) {
          ctx.log("error", "Cannot refuel for return journey");
          await ctx.sleep(60000);
          continue;
        }
        await navigateToSystem(ctx, settings.homeSystem, safetyOpts);
      }
      if (bot.poi !== settings.homeStation) {
        await ensureUndocked(ctx);
        const travelResp = await bot.exec("travel", { target_poi: settings.homeStation });
        if (travelResp.error) {
          ctx.log("error", `Return travel failed: ${travelResp.error.message}`);
          await ctx.sleep(30000);
          continue;
        }
        bot.poi = settings.homeStation;
      }
      await bot.refreshCargo();
      const postReturnCargo = bot.inventory.find(i => i.itemId === FUEL_CELL_ITEM_ID);
      cargoQty = postReturnCargo?.quantity ?? 0;
      if (cargoQty <= 0) {
        ctx.log("fc", "Arrived home but no cargo — attempting to withdraw from faction storage");
        
        const freeSpace = Math.max(0, (bot.cargoMax || 825) - (bot.cargo || 0));
        const withdrawResp = await bot.exec("faction_withdraw_items", {
          item_id: FUEL_CELL_ITEM_ID,
          quantity: maxItemsForCargo(freeSpace, FUEL_CELL_ITEM_ID),
        });

        if (withdrawResp.error) {
          ctx.log("error", `Withdraw failed: ${withdrawResp.error.message} — waiting for cargo`);
          await ctx.sleep(60000);
          continue;
        }

        await bot.refreshCargo();
        const afterWithdraw = bot.inventory.find(i => i.itemId === FUEL_CELL_ITEM_ID);
        cargoQty = afterWithdraw?.quantity ?? 0;

        if (cargoQty <= 0) {
          ctx.log("fc", "Withdraw returned no cargo — waiting for cargo");
          await ctx.sleep(60000);
          continue;
        }

        ctx.log("fc", `Withdrew ${cargoQty}x fuel cells from faction storage`);
      }
      ctx.log("fc", "Returned home with cargo");
    }

    await ensureDocked(ctx);
    await tryRefuel(ctx);
    await repairShip(ctx);

    await bot.refreshCargo();
    const currentFuelCellCargo = bot.inventory.find(i => i.itemId === FUEL_CELL_ITEM_ID);
    const cargoAfterMaintenance = currentFuelCellCargo?.quantity ?? 0;
    const atHomeStationAfterMaintenance = bot.system === settings.homeSystem && bot.poi === settings.homeStation;

    if (cargoAfterMaintenance <= 0) {
      if (atHomeStationAfterMaintenance) {
        ctx.log("fc", "No cargo at home station — attempting to withdraw from faction storage");
        
        const freeSpace = Math.max(0, (bot.cargoMax || 825) - (bot.cargo || 0));
        const withdrawResp = await bot.exec("faction_withdraw_items", {
          item_id: FUEL_CELL_ITEM_ID,
          quantity: maxItemsForCargo(freeSpace, FUEL_CELL_ITEM_ID),
        });

        if (withdrawResp.error) {
          ctx.log("error", `Withdraw failed: ${withdrawResp.error.message} — waiting for cargo`);
          await ctx.sleep(10000);
          continue;
        }

        await bot.refreshCargo();
        const afterWithdraw = bot.inventory.find(i => i.itemId === FUEL_CELL_ITEM_ID);
        const newCargoQty = afterWithdraw?.quantity ?? 0;

        if (newCargoQty <= 0) {
          ctx.log("fc", "Withdraw returned no cargo — waiting for cargo to become available");
          await ctx.sleep(10000);
          continue;
        }

        ctx.log("fc", `Withdrew ${newCargoQty}x fuel cells from faction storage`);
        cargoQty = newCargoQty;
      } else {
        ctx.log("fc", "Lost cargo during maintenance — returning home to restock");
        continue;
      }
    }

    let targetIdx = getNextStation(fcData, fcData.currentStationIndex);
    if (targetIdx < 0 || fcData.stations.length === 0) {
      ctx.log("fc", "No stations available to visit");
      ctx.log("fc", "Initializing station list from mapStore...");
      fcData.stations = initializeFCStations(settings);
      fcData.currentStationIndex = 0;
      saveFCStationsData(fcData);

      if (fcData.stations.length === 0) {
        ctx.log("fc", "Still no stations — waiting");
        await ctx.sleep(60000);
        continue;
      }

      targetIdx = 0;
    }

    const target = fcData.stations[targetIdx];
    if (!target) {
      targetIdx = (targetIdx + 1) % fcData.stations.length;
      continue;
    }

    // Mobile Capital location may have changed — refresh from mapStore
    if (target.poiId === "mobile_capital") {
      const mcLoc = mapStore.getMobileCapitolLocation();
      if (mcLoc) {
        // Update in-memory and persisted station entry to current location
        target.systemId = mcLoc.systemId;
        fcData.stations[targetIdx].systemId = mcLoc.systemId;
        saveFCStationsData(fcData);
      }
    }

    ctx.log("fc", `Target: ${target.poiName} in ${target.systemId}`);

    await bot.refreshCargo();
    const preTravelCargo = bot.inventory.find(i => i.itemId === FUEL_CELL_ITEM_ID);
    if (!preTravelCargo || preTravelCargo.quantity <= 0) {
      ctx.log("fc", "No cargo before travel — returning home to restock");
      yield "return_home";
      if (bot.system !== settings.homeSystem) {
        await navigateToSystem(ctx, settings.homeSystem, safetyOpts);
      }
      if (bot.poi !== settings.homeStation) {
        await ensureUndocked(ctx);
        await bot.exec("travel", { target_poi: settings.homeStation });
        bot.poi = settings.homeStation;
      }
      continue;
    }

    await ensureUndocked(ctx);

    if (bot.system !== target.systemId) {
      const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
      if (!fueled) {
        ctx.log("error", "Cannot refuel — waiting");
        await ctx.sleep(60000);
        continue;
      }

      ctx.log("travel", `Jumping to ${target.systemId}...`);
      const arrived = await navigateToSystem(ctx, target.systemId, safetyOpts);
      if (!arrived) {
        ctx.log("error", "Failed to reach target system");
        await ctx.sleep(30000);
        continue;
      }
    }

    if (bot.poi !== target.poiId) {
      ctx.log("travel", `Traveling to ${target.poiName}...`);
      const travelResult = await travelToStationWithHint(ctx, target.poiId, target.poiName, target.systemId, {
        fuelThresholdPct: safetyOpts.fuelThresholdPct,
        hullThresholdPct: safetyOpts.hullThresholdPct,
        maxRetries: 3,
      });

      if (!travelResult.success) {
        ctx.log("error", `Travel to ${target.poiName} failed${travelResult.usedHint ? ` after redirect to ${travelResult.hintSystem}` : ''} — skipping station`);
        targetIdx = (targetIdx + 1) % fcData.stations.length;
        fcData.currentStationIndex = targetIdx;
        saveFCStationsData(fcData);
        continue;
      }

      bot.poi = target.poiId;
    }

    yield "dock";
    const dockResp = await bot.exec("dock");

    if (dockResp.error && !dockResp.error.message.includes("already")) {
      ctx.log("error", `Dock failed: ${dockResp.error.message} — skipping station`);
      targetIdx = (targetIdx + 1) % fcData.stations.length;
      fcData.currentStationIndex = targetIdx;
      saveFCStationsData(fcData);
      continue;
    }

    bot.docked = true;
    ctx.log("fc", `Docked at ${target.poiName}`);

    await bot.refreshCargo();
    const inCargo = bot.inventory.find(i => i.itemId === FUEL_CELL_ITEM_ID);
    const availableQty = inCargo?.quantity ?? 0;

    if (availableQty <= 0) {
      ctx.log("fc", "No fuel cells in cargo — returning home");
      yield "return_home";
      await navigateToSystem(ctx, settings.homeSystem, safetyOpts);
      continue;
    }

    // Get current active orders at this station
    let currentStationOrders: FCOrder[] = [];
    const ordersResp = await bot.exec("view_orders", { scope: "personal" });
    if (!ordersResp.error && ordersResp.result) {
      const ordersData = ordersResp.result as Record<string, unknown>;
      const orders = (ordersData.orders as any[]) || [];
      // Filter for fuel_cell sell orders
      const fcOrders = orders.filter(o => o.item_id === FUEL_CELL_ITEM_ID && o.side === "sell");
      currentStationOrders = fcOrders.map(o => ({
        orderId: o.order_id,
        quantity: o.quantity,
        remaining: o.remaining,
        filledQuantity: o.filled_quantity,
        priceEach: o.price_each,
        createdAt: o.created_at,
      }));
    }

    // Calculate current unsold from active orders
    const currentUnsold = currentStationOrders.reduce((sum, o) => sum + o.remaining, 0);

    // Get market data for pricing
    let marketData: unknown = null;
    const marketResp = await bot.exec("view_market", { item_id: FUEL_CELL_ITEM_ID });
    if (!marketResp.error && marketResp.result) {
      marketData = marketResp.result;
    }

    let price: number | null = null;
    if (availableQty > 0) {
      price = await getOptimalPrice(ctx, marketData, settings);
      ctx.log("fc", `Creating sell orders: ${availableQty}x @ ${price}cr each`);
    }

    let ordersPlacedCount = 0;

    if (availableQty > 0) {
      const createResp = await bot.exec("create_sell_order", {
        item_id: FUEL_CELL_ITEM_ID,
        quantity: availableQty,
        price_each: price!,
      });

      if (createResp.error) {
        ctx.log("error", `Create sell order failed: ${createResp.error.message}`);
      } else {
        ctx.log("fc", `Listed ${availableQty}x ${FUEL_CELL_ITEM_NAME} @ ${price!}cr`);

        // Refresh orders after creating new one
        const updatedOrdersResp = await bot.exec("view_orders", { scope: "personal" });
        if (!updatedOrdersResp.error && updatedOrdersResp.result) {
          const updatedOrdersData = updatedOrdersResp.result as Record<string, unknown>;
          const updatedOrders = (updatedOrdersData.orders as any[]) || [];
          const updatedFcOrders = updatedOrders.filter(o => o.item_id === FUEL_CELL_ITEM_ID && o.side === "sell");
          currentStationOrders = updatedFcOrders.map(o => ({
            orderId: o.order_id,
            quantity: o.quantity,
            remaining: o.remaining,
            filledQuantity: o.filled_quantity,
            priceEach: o.price_each,
            createdAt: o.created_at,
          }));
        }

        ordersPlacedCount = availableQty;
      }
    }

    // Update station entry with latest data
    const currentStation = fcData.stations[targetIdx];
    currentStation.ordersPlaced += ordersPlacedCount;
    currentStation.ordersUnsold = currentStationOrders.reduce((sum, o) => sum + o.remaining, 0);
    currentStation.activeOrders = currentStationOrders;
    if (ordersPlacedCount > 0) {
      currentStation.lastPrice = price;
    }
    currentStation.lastVisit = new Date().toISOString();

    fcData.currentStationIndex = targetIdx;
    saveFCStationsData(fcData);

    await bot.refreshCargo();

    yield "return_home";
    ctx.log("travel", `Returning to ${settings.homeSystem}...`);

    if (bot.system !== settings.homeSystem) {
      await ensureUndocked(ctx);

      // Refuel at target station before long journey home - use higher threshold
      const returnThreshold = Math.max(60, settings.refuelThreshold + 20);
      ctx.log("fc", `Pre-return fuel check: ${Math.round((bot.fuel / (bot.maxFuel || 1)) * 100)}%, refueling if below ${returnThreshold}%...`);
      const fueled = await ensureFueled(ctx, returnThreshold);
      if (!fueled) {
        ctx.log("error", "Failed to refuel before return journey");
        await ctx.sleep(30000);
        continue;
      }

      await navigateToSystem(ctx, settings.homeSystem, safetyOpts);
    }

    const checkCargo = bot.inventory.find(i => i.itemId === FUEL_CELL_ITEM_ID);
    if (checkCargo && checkCargo.quantity > 0) {
      ctx.log("fc", `Depositing ${checkCargo.quantity}x remaining fuel cells`);
      await ensureDocked(ctx);
      await bot.exec("faction_deposit_items", {
        item_id: FUEL_CELL_ITEM_ID,
        quantity: checkCargo.quantity,
      });
    }

    targetIdx = (targetIdx + 1) % fcData.stations.length;
    fcData.currentStationIndex = targetIdx;
    saveFCStationsData(fcData);

    ctx.log("fc", `Loop complete. Next station index: ${targetIdx}`);
  }
};