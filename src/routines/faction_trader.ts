/**
 * Faction Trader routine — liquidates items from faction storage.
 *
 * Unlike the full trader, this routine never buys from markets.
 * It withdraws items from faction storage and sells them at the
 * best known buyer station, then returns home.
 */
import type { Bot, Routine, RoutineContext } from "../bot.js";
import { mapStore } from "../mapstore.js";
import { catalogStore } from "../catalogstore.js";
import { getSystemBlacklist } from "../web/server.js";
import { clearFactionStorageCache } from "../factionStorageCache.js";
import {
  ensureDocked,
  ensureUndocked,
  tryRefuel,
  repairShip,
  ensureFueled,
  navigateToSystem,
  recordMarketData,
  factionDonateProfit,
  logFactionActivity,
  detectAndRecoverFromDeath,
  maxItemsForCargo,
  readSettings,
  writeSettings,
  isPirateSystem,
  checkAndFleeFromBattle,
  checkBattleAfterCommand,
} from "./common.js";
import {
  getActiveSession,
  startTradeSession,
  updateTradeSession,
  completeTradeSession,
  failTradeSession,
  createTradeSession,
  type TradeSession,
} from "./traderActivity.js";
import {
  getBuyOrderLock,
  acquireBuyOrderLock,
  releaseBuyOrderLock,
  cleanupStaleFactionLocks,
  getBuyOrderKey,
} from "./factionTraderCoordination.js";
import {
  type BattleState,
  handleBattleNotifications,
  getBattleStatus,
  fleeFromBattle,
} from "./common.js";

// ── Settings ─────────────────────────────────────────────────

interface TradeItemConfig {
  itemId: string;
  maxSellQty: number;  // 0 = sell all available
  minSellPrice: number; // 0 = use global minSellPrice
  soldQty?: number;     // Track quantity sold (persisted in settings)
}

function getFactionTraderSettings(username?: string): {
  homeSystem: string;
  homeStation: string;
  fuelCostPerJump: number;
  refuelThreshold: number;
  repairThreshold: number;
  minSellPrice: number;
  tradeItems: TradeItemConfig[];
  stationPriority: boolean;
} {
  const all = readSettings();
  const general = all.general || {};
  const t = all.faction_trader || {};
  const botOverrides = username ? (all[username] || {}) : {};

  // Migrate old format (string array) to new format if needed
  let tradeItems: TradeItemConfig[] = [];
  if (Array.isArray(t.tradeItems)) {
    if (t.tradeItems.length > 0 && typeof t.tradeItems[0] === 'string') {
      // Old format: string array
      tradeItems = (t.tradeItems as string[]).map((itemId: string) => ({
        itemId,
        maxSellQty: 0,
        minSellPrice: 0,
        soldQty: 0,
      }));
    } else {
      // New format: object array
      tradeItems = (t.tradeItems as TradeItemConfig[]).map((item: any) => ({
        itemId: item.itemId || '',
        maxSellQty: item.maxSellQty || 0,
        minSellPrice: item.minSellPrice || 0,
        soldQty: item.soldQty || 0,
      })).filter(item => item.itemId);
    }
  }

  return {
    // Use faction storage station from general settings as home, fallback to faction_trader-specific
    homeSystem: (botOverrides.homeSystem as string)
      || (t.homeSystem as string)
      || (general.factionStorageSystem as string) || "",
    homeStation: (botOverrides.homeStation as string)
      || (t.homeStation as string)
      || (general.factionStorageStation as string) || "",
    fuelCostPerJump: (t.fuelCostPerJump as number) || 50,
    refuelThreshold: (t.refuelThreshold as number) || 50,
    repairThreshold: (t.repairThreshold as number) || 40,
    minSellPrice: (t.minSellPrice as number) || 0,
    tradeItems,
    stationPriority: (botOverrides.stationPriority as boolean) || false,
  };
}

/**
 * Fail a faction trade session and release its buy order lock.
 */
async function failFactionSession(botUsername: string, reason: string): Promise<void> {
  const session = getActiveSession(botUsername);
  if (session) {
    releaseBuyOrderLock(
      botUsername,
      session.itemId,
      session.destPoi,
      session.sellPricePerUnit,
      reason
    );
  }
  await failTradeSession(botUsername, reason);
}

/** Verify that a destination POI exists as a valid station with a market. */
function isValidDestination(ctx: RoutineContext, systemId: string, poiId: string): boolean {
  const sys = mapStore.getSystem(systemId);
  if (!sys) {
    ctx.log("error", `Destination system ${systemId} not found in map data`);
    return false;
  }
  const poi = sys.pois.find(p => p.id === poiId);
  if (!poi) {
    ctx.log("error", `Destination POI ${poiId} not found in system ${systemId}`);
    return false;
  }
  if (!poi.has_base) {
    ctx.log("error", `Destination ${poi.name} (${poiId}) in ${systemId} is not a valid station (no dock)`);
    return false;
  }
  if (!poi.market || poi.market.length === 0) {
    ctx.log("error", `Destination ${poi.name} (${poiId}) in ${systemId} has no market data`);
    return false;
  }
  return true;
}

// ── Trade Session Recovery ──────────────────────────────────

/**
 * Check for and recover an incomplete faction trade session.
 * Validates cargo, destination, and market conditions.
 * Returns the recovered session if valid, or null if recovery is not possible.
 */
async function recoverFactionTradeSession(
  ctx: RoutineContext,
  session: TradeSession,
  settings: ReturnType<typeof getFactionTraderSettings>,
): Promise<TradeSession | null> {
  const { bot } = ctx;

  ctx.log("trade", `Found incomplete trade session: ${session.itemName} (${session.state})`);

  // Verify items are still in cargo (for in_transit and beyond)
  if (session.state === "in_transit" || session.state === "at_destination" || session.state === "selling") {
    await bot.refreshCargo();
    const cargoItem = bot.inventory.find(i => i.itemId === session.itemId);
    const cargoQty = cargoItem?.quantity ?? 0;

  if (cargoQty <= 0) {
    ctx.log("error", `Recovery failed: ${session.itemName} no longer in cargo`);
    await failFactionSession(session.botUsername, "Items not in cargo");
    return null;
  }

    if (cargoQty < session.quantityBought) {
      ctx.log("trade", `Recovered with partial cargo: ${cargoQty}/${session.quantityBought}x ${session.itemName}`);
      const updated = await updateTradeSession(session.botUsername, {
        quantityBought: cargoQty,
        sellQuantity: cargoQty,
        notes: (session.notes || "") + ` | Partial recovery: ${cargoQty}/${session.quantityBought}x remaining`,
      });
      if (updated) session = updated;
    }
  }

  // Check if we're at the destination
  if (session.state === "in_transit" || session.state === "at_destination" || session.state === "selling") {
    // Verify the destination buyer still exists and price is still profitable
    const allBuys = mapStore.getAllBuyDemand();
    const destBuyer = allBuys.find(b =>
      b.itemId === session.itemId &&
      b.systemId === session.destSystem &&
      b.poiId === session.destPoi
    );

    if (!destBuyer || destBuyer.quantity <= 0) {
      ctx.log("trade", `Destination buyer gone — finding alternative`);
      // Find alternative buyer
      const alternativeBuyers = allBuys
        .filter(b => b.itemId === session.itemId && b.price > 0)
        .filter(b => settings.minSellPrice === 0 || b.price >= settings.minSellPrice)
        .sort((a, b) => b.price - a.price);

      if (alternativeBuyers.length === 0) {
        ctx.log("error", "No alternative buyers found — abandoning session");
        await failFactionSession(session.botUsername, "No buyers available");
        return null;
      }

      const bestAlt = alternativeBuyers[0];

      // Verify alternative destination is valid
      if (!isValidDestination(ctx, bestAlt.systemId, bestAlt.poiId)) {
        ctx.log("error", `Alternative destination invalid: ${bestAlt.poiName} — abandoning session`);
        await failFactionSession(session.botUsername, "Invalid destination");
        return null;
      }

      ctx.log("trade", `New destination: ${bestAlt.poiName} in ${bestAlt.systemId} (${bestAlt.price}cr/ea)`);
      const updated = await updateTradeSession(session.botUsername, {
        destSystem: bestAlt.systemId,
        destPoi: bestAlt.poiId,
        destPoiName: bestAlt.poiName,
        sellPricePerUnit: bestAlt.price,
        sellQuantity: Math.min(session.sellQuantity, bestAlt.quantity),
        totalJumps: session.jumpsCompleted + estimateFuelCost(bot.system, bestAlt.systemId, settings.fuelCostPerJump).jumps,
        notes: (session.notes || "") + ` | Rerouted to ${bestAlt.poiName}`,
      });
      if (updated) session = updated;
    } else if (destBuyer.price < session.buyPricePerUnit) {
      // For faction trades, buyPricePerUnit is 0 (no purchase cost), so check if price is still > 0
      if (destBuyer.price <= 0) {
        ctx.log("error", `Price dropped to ${destBuyer.price}cr — abandoning`);
        await failFactionSession(session.botUsername, "Price too low");
        return null;
      }
    }
  }

  ctx.log("trade", `Session recovered: ${session.quantityBought}x ${session.itemName} → ${session.destPoiName}`);

  // Reacquire buy order lock for recovered session
  const lockKey = getBuyOrderKey(session.itemId, session.destPoi, session.sellPricePerUnit);
  const existingLock = getBuyOrderLock(session.itemId, session.destPoi, session.sellPricePerUnit);
  
  if (existingLock && existingLock.lockedBy !== bot.username) {
    ctx.log("trade", `Buy order lock held by ${existingLock.lockedBy} — attempting to reacquire`);
    const reacquired = acquireBuyOrderLock({
      botUsername: bot.username,
      itemId: session.itemId,
      itemName: session.itemName,
      destSystem: session.destSystem,
      destPoi: session.destPoi,
      destPoiName: session.destPoiName,
      pricePerUnit: session.sellPricePerUnit,
      quantityCommitted: session.sellQuantity,
      sessionId: session.sessionId,
    });
    if (!reacquired) {
      ctx.log("error", "Failed to reacquire buy order lock — abandoning session");
      await failFactionSession(session.botUsername, "Could not reacquire buy order lock");
      return null;
    }
  } else if (!existingLock) {
    // No lock exists — acquire new one
    const acquired = acquireBuyOrderLock({
      botUsername: bot.username,
      itemId: session.itemId,
      itemName: session.itemName,
      destSystem: session.destSystem,
      destPoi: session.destPoi,
      destPoiName: session.destPoiName,
      pricePerUnit: session.sellPricePerUnit,
      quantityCommitted: session.sellQuantity,
      sessionId: session.sessionId,
    });
    if (!acquired) {
      ctx.log("error", "Failed to acquire buy order lock — abandoning session");
      await failFactionSession(session.botUsername, "Could not acquire buy order lock");
      return null;
    }
  }

  return session;
}

// ── Types ────────────────────────────────────────────────────

interface FactionSellRoute {
  itemId: string;
  itemName: string;
  availableQty: number;
  destSystem: string;
  destPoi: string;
  destPoiName: string;
  sellPrice: number;
  sellQty: number;
  jumps: number;           // one-way jumps to destination
  roundTripJumps: number;  // dest + return home
  totalRevenue: number;
  totalProfit: number;     // revenue minus material cost and round-trip fuel
}

// ── Helpers ──────────────────────────────────────────────────

/** Find the cheapest known market sell price for an item (replacement/acquisition cost). */
function getItemMarketCost(itemId: string): number {
  let cheapest = Infinity;
  const systems = mapStore.getAllSystems();
  for (const sys of Object.values(systems)) {
    // Skip pirate systems
    if (isPirateSystem(sys.id)) continue;
    for (const poi of sys.pois) {
      for (const m of poi.market) {
        if (m.item_id === itemId && m.best_sell !== null && m.best_sell > 0) {
          if (m.best_sell < cheapest) cheapest = m.best_sell;
        }
      }
    }
  }
  return cheapest === Infinity ? 0 : cheapest;
}

/**
 * Calculate optimal sell quantity based on actual buy orders at destination.
 * Calls view_market to get real buy orders with quantities.
 */
async function calculateFactionOptimalSellQuantity(
  ctx: RoutineContext,
  itemId: string,
  itemName: string,
  availableQuantity: number,
  minPricePerUnit: number,
): Promise<{
  sellQty: number;
  expectedRevenue: number;
  priceBreakdown: string;
  weightedAvgPrice: number;
  buyOrders: Array<{ priceEach: number; orderQty: number; qtyToSell: number }>;
}> {
  const { bot } = ctx;

  // Check the market for this specific item
  const marketResp = await bot.exec("view_market", { item_id: itemId });
  if (marketResp.error || !marketResp.result) {
    ctx.log("trade", `view_market failed for ${itemName} — using cached data`);
    return {
      sellQty: availableQuantity,
      expectedRevenue: availableQuantity * minPricePerUnit,
      priceBreakdown: "cached",
      weightedAvgPrice: minPricePerUnit,
      buyOrders: [],
    };
  }

  const marketData = marketResp.result as Record<string, unknown>;
  const items = (
    Array.isArray(marketData) ? marketData :
    Array.isArray((marketData as Record<string, unknown>).items) ? (marketData as Record<string, unknown>).items :
    []
  ) as Array<Record<string, unknown>>;

  const itemMarket = items.find(i => (i.item_id as string) === itemId);
  if (!itemMarket) {
    ctx.log("trade", `No market data for ${itemName} — using cached data`);
    return {
      sellQty: availableQuantity,
      expectedRevenue: availableQuantity * minPricePerUnit,
      priceBreakdown: "cached",
      weightedAvgPrice: minPricePerUnit,
      buyOrders: [],
    };
  }

  const buyOrders = (itemMarket.buy_orders as Array<Record<string, unknown>>) || [];
  if (buyOrders.length === 0) {
    ctx.log("trade", `No buy orders for ${itemName} — cannot sell`);
    return { sellQty: 0, expectedRevenue: 0, priceBreakdown: "no buy orders", weightedAvgPrice: 0, buyOrders: [] };
  }

  // Calculate how many we can sell at or above minimum price
  let remainingToSell = availableQuantity;
  let totalRevenue = 0;
  let totalSold = 0;
  const priceDetails: string[] = [];
const eligibleBuyOrders: Array<{ priceEach: number; orderQty: number; qtyToSell: number }> = [];

  for (const order of buyOrders) {
    if (remainingToSell <= 0) break;

    const priceEach = (order.price_each as number) || 0;
    const orderQty = (order.quantity as number) || 0;

    if (orderQty <= 0 || priceEach <= 0) continue;
    if (priceEach < minPricePerUnit) continue;

    const qtyAtThisPrice = Math.min(remainingToSell, orderQty);
    const revenueAtThisPrice = qtyAtThisPrice * priceEach;

    totalRevenue += revenueAtThisPrice;
    totalSold += qtyAtThisPrice;
    remainingToSell -= qtyAtThisPrice;

    priceDetails.push(`${qtyAtThisPrice}x @ ${priceEach}cr`);
    eligibleBuyOrders.push({
      priceEach,
      orderQty,
      qtyToSell: qtyAtThisPrice,
    });
  }

  const weightedAvgPrice = totalSold > 0 ? totalRevenue / totalSold : 0;
  const priceBreakdown = priceDetails.join(", ");

  if (remainingToSell > 0) {
    ctx.log("trade", `Market check: can sell ${totalSold}/${availableQuantity}x ${itemName} (${priceBreakdown}), holding ${remainingToSell}x`);
  }

  return { sellQty: totalSold, expectedRevenue: totalRevenue, priceBreakdown, weightedAvgPrice, buyOrders: eligibleBuyOrders };
}

/** Free cargo weight (not item count — callers must divide by item size). */
function getFreeSpace(bot: Bot): number {
  if (bot.cargoMax <= 0) return 999;
  return Math.max(0, bot.cargoMax - bot.cargo);
}

/** Estimate fuel cost between two systems using mapStore route data. */
function estimateFuelCost(fromSystem: string, toSystem: string, costPerJump: number = 50): { jumps: number; cost: number } {
  const blacklist = getSystemBlacklist();
  if (fromSystem === toSystem) return { jumps: 0, cost: 0 };
  const route = mapStore.findRoute(fromSystem, toSystem, blacklist);
  if (!route) return { jumps: 999, cost: 999 * costPerJump };
  const jumps = route.length - 1;
  return { jumps, cost: jumps * costPerJump };
}

/** Find sell routes for items currently in faction storage. Factors round-trip fuel cost. */
function findFactionSellRoutes(
  ctx: RoutineContext,
  settings: ReturnType<typeof getFactionTraderSettings>,
  currentSystem: string,
  cargoCapacity: number,
  personalMode: boolean = false,
): FactionSellRoute[] {
  const { bot } = ctx;
  const routes: FactionSellRoute[] = [];

  // Use personal storage in personal mode, faction storage otherwise
  const storage = personalMode ? bot.storage : bot.factionStorage;
  if (storage.length === 0) return routes;

  const allBuys = mapStore.getAllBuyDemand();
  if (allBuys.length === 0) return routes;

  const homeSystem = settings.homeSystem || currentSystem;
  const costPerJump = settings.fuelCostPerJump;

  for (const item of storage) {
    const lower = item.itemId.toLowerCase();
    if (lower.includes("fuel") || lower.includes("energy_cell")) continue;
    if (item.quantity <= 0) continue;

    // Filter by allowed items if configured (case-insensitive match)
    if (settings.tradeItems.length > 0) {
      const itemIdLower = item.itemId.toLowerCase();
      const match = settings.tradeItems.some(t => t.itemId.toLowerCase() === itemIdLower);
      if (!match) continue;
    }

    // Get per-item settings (case-insensitive match)
    const itemIdLower = item.itemId.toLowerCase();
    const itemConfig = settings.tradeItems.find(t => t.itemId.toLowerCase() === itemIdLower);
    const itemMinSellPrice = (itemConfig && itemConfig.minSellPrice > 0) ? itemConfig.minSellPrice : settings.minSellPrice;
    const itemMaxSellQty = itemConfig?.maxSellQty || 0;
    const itemSoldQty = itemConfig?.soldQty || 0;
    const remainingSellQty = itemMaxSellQty > 0 ? Math.max(0, itemMaxSellQty - itemSoldQty) : item.quantity;

    // Skip if we've already sold the max quantity
    if (itemMaxSellQty > 0 && remainingSellQty <= 0) continue;

    // Find best buyer for this item
    const buyers = allBuys
      .filter(b => b.itemId === item.itemId && b.price > 0)
      .sort((a, b) => b.price - a.price);

    // Material cost = cheapest known market price (what this item is worth)
    const materialCost = getItemMarketCost(item.itemId);

    for (const buy of buyers) {
      if (itemMinSellPrice > 0 && buy.price < itemMinSellPrice) continue;

      // Verify destination is a valid station with a market
      if (!isValidDestination(ctx, buy.systemId, buy.poiId)) {
        ctx.log("error", `Skipping corrupt destination: ${buy.poiName} (${buy.systemId})`);
        continue;
      }

      // Check if this buy order is locked by another bot
      const existingLock = getBuyOrderLock(item.itemId, buy.poiId, buy.price);
      if (existingLock) {
        ctx.log("trade", `Skipping buy order at ${buy.poiName} (${buy.price}cr) — locked by ${existingLock.lockedBy}`);
        continue;
      }

      // Round-trip fuel: current → dest + dest → home
      const toDest = estimateFuelCost(currentSystem, buy.systemId, costPerJump);
      const returnHome = estimateFuelCost(buy.systemId, homeSystem, costPerJump);
      if (toDest.jumps >= 999) continue;
      const roundTripJumps = toDest.jumps + (returnHome.jumps < 999 ? returnHome.jumps : 0);
      const roundTripFuel = toDest.cost + (returnHome.jumps < 999 ? returnHome.cost : 0);

      // Calculate quantity to sell, respecting max sell qty
      const maxQty = itemMaxSellQty > 0 ? Math.min(remainingSellQty, item.quantity) : item.quantity;
      const qty = Math.min(maxQty, buy.quantity, maxItemsForCargo(cargoCapacity, item.itemId));
      if (qty <= 0) continue;

      // Skip routes that sell below material cost + round-trip fuel (would lose money)
      const costPerUnit = materialCost + (roundTripJumps > 0 ? roundTripFuel / qty : 0);
      if (materialCost > 0 && buy.price <= costPerUnit) continue;

      const totalProfit = (buy.price - costPerUnit) * qty;

      routes.push({
        itemId: item.itemId,
        itemName: item.name,
        availableQty: item.quantity,
        destSystem: buy.systemId,
        destPoi: buy.poiId,
        destPoiName: buy.poiName,
        sellPrice: buy.price,
        sellQty: qty,
        jumps: toDest.jumps,
        roundTripJumps,
        totalRevenue: qty * buy.price,
        totalProfit,
      });
      break; // best buyer for this item
    }
  }

  // Sort by profit (not raw revenue) to pick the most profitable after fuel
  routes.sort((a, b) => b.totalProfit - a.totalProfit);
  return routes;
}

// ── Main routine ─────────────────────────────────────────────

export const factionTraderRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  await bot.refreshStatus();
  const startSystem = bot.system;

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
    // ── Death recovery ──
    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) { await ctx.sleep(30000); continue; }

    // ── Battle check ──
    if (await checkAndFleeFromBattle(ctx, "faction_trader")) {
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

    // ── Buy order lock cleanup (periodic stale lock cleanup) ──
    const cleanedLocks = cleanupStaleFactionLocks();
    if (cleanedLocks > 0) {
      ctx.log("trade", `Faction coordination: cleaned up ${cleanedLocks} stale buy order lock(s)`);
    }

    // ── Detect faction membership early ──
    // Check if bot is in a faction by attempting to view faction storage
    // Distinguish between "not in faction" and "no faction storage at this station"
    let personalMode = false;
    let factionError: string | null = null;
    if (bot.docked) {
      //const factionResp = await bot.exec("view_storage", { target: "faction" });
      const factionResp = await bot.exec("storage", { action: 'view', target: "faction" }); //fixed by human!
      if (!factionResp.error) {
        // Set faction if not set
        const result = factionResp.result as any;
        if (result.faction_id && !bot.faction) {
          bot.faction = result.faction_id;
        }
      }
      if (factionResp.error) {
        factionError = factionResp.error.message || "";
        // Only use personal mode if bot is truly not in a faction
        personalMode = factionError.includes("not_in_faction") || factionError.includes("not in a faction");
      }
    } else {
      // Not docked - can't check faction storage yet, assume personal mode
      // Will re-check after docking
      personalMode = true;
    }

    // ── Trade session recovery ──
    const activeSession = getActiveSession(bot.username);
    let recoveredSession: TradeSession | null = null;
    // Recover sessions that are either faction routes OR cargo routes (interrupted trades)
    // Also recover any session that has a valid state (even if flags aren't set correctly)
    if (activeSession) {
      const settings = getFactionTraderSettings(bot.username);
      recoveredSession = await recoverFactionTradeSession(ctx, activeSession, settings);
      if (recoveredSession) {
        ctx.log("trade", `Resuming trade session: ${recoveredSession.itemName} (${recoveredSession.state})`);
      }
    }

    const settings = getFactionTraderSettings(bot.username);
    const safetyOpts = {
      fuelThresholdPct: settings.refuelThreshold,
      hullThresholdPct: settings.repairThreshold,
    };
    let recoveredSessionHandled = false;
    let route: FactionSellRoute | null = null;
    let withdrawQty = 0;

    // ── Handle recovered session ──
    // If we have a recovered session that's in transit, at destination, selling, OR in buying state with cargo already loaded
    if (recoveredSession && (recoveredSession.state === "in_transit" || recoveredSession.state === "at_destination" || recoveredSession.state === "selling")) {
      ctx.log("trade", `Recovered session is ${recoveredSession.state} — proceeding directly to destination`);

      // Verify the destination is still valid
      if (!isValidDestination(ctx, recoveredSession.destSystem, recoveredSession.destPoi)) {
        ctx.log("error", `Cannot recover session: destination ${recoveredSession.destPoiName} is invalid`);
        await failFactionSession(bot.username, "Invalid destination in recovered session");
        recoveredSession = null;
      } else {
        // Quick fuel check only if we're at a station
        if (bot.docked) {
          await tryRefuel(ctx);
        }

        // Set up route for immediate execution
        route = {
          itemId: recoveredSession!.itemId,
          itemName: recoveredSession!.itemName,
          availableQty: recoveredSession!.quantityBought,
          destSystem: recoveredSession!.destSystem,
          destPoi: recoveredSession!.destPoi,
          destPoiName: recoveredSession!.destPoiName,
          sellPrice: recoveredSession!.sellPricePerUnit,
          sellQty: recoveredSession!.sellQuantity,
          jumps: recoveredSession!.totalJumps - recoveredSession!.jumpsCompleted,
          roundTripJumps: recoveredSession!.totalJumps,
          totalRevenue: recoveredSession!.expectedRevenue,
          totalProfit: recoveredSession!.expectedProfit,
        };
      withdrawQty = recoveredSession.quantityBought;
      recoveredSessionHandled = true;

      // Skip dock/maintenance and go straight to travel
      await ensureUndocked(ctx);
      const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
      if (!fueled) {
        ctx.log("error", "Cannot refuel for recovered session — will retry next cycle");
        await ctx.sleep(30000);
        continue;
      }

      // Jump directly to destination
      ctx.log("travel", `Resuming route to ${recoveredSession!.destPoiName}...`);
      const arrived = await navigateToSystem(ctx, recoveredSession!.destSystem, {
        ...safetyOpts,
        noJettison: true,
        onJump: async (jumpNum) => {
          const session = getActiveSession(bot.username);
          if (session) {
            await updateTradeSession(bot.username, { jumpsCompleted: jumpNum });
          }
          return true;
        },
      });

      if (!arrived) {
        ctx.log("error", "Failed to reach destination for recovered session — will retry");
        await ensureDocked(ctx);
        await ctx.sleep(60000);
        continue;
      }

      // Arrived at destination - update session state and continue to sell phase
      await updateTradeSession(bot.username, { state: "at_destination" });
      bot.system = recoveredSession!.destSystem;

      // Travel to destination POI and dock
      if (bot.poi !== recoveredSession!.destPoi) {
        ctx.log("travel", `Traveling to ${recoveredSession!.destPoiName}...`);
        const travelResp = await bot.exec("travel", { target_poi: recoveredSession!.destPoi });

        // Check for battle after travel
        if (await checkBattleAfterCommand(ctx, travelResp.notifications, "travel")) {
          ctx.log("combat", "Battle detected during travel - fleeing!");
          await ctx.sleep(5000);
          continue;
        }

        // CRITICAL: Check for battle interrupt error
        if (travelResp.error) {
          const errMsg = travelResp.error.message.toLowerCase();
          if (travelResp.error.code === "battle_interrupt" || errMsg.includes("interrupted by battle") || errMsg.includes("interrupted by combat")) {
            ctx.log("combat", `Travel to destination interrupted by battle! ${travelResp.error.message} - fleeing!`);
            await ctx.sleep(5000);
            continue;
          }
        }

        bot.poi = recoveredSession!.destPoi;

        // Check for pirates at destination
        const nearbyResp = await bot.exec("get_nearby");
        if (nearbyResp.result && typeof nearbyResp.result === "object") {
          const { checkAndFleeFromPirates } = await import("./common.js");
          const fled = await checkAndFleeFromPirates(ctx, nearbyResp.result);
          if (fled) {
            ctx.log("error", "Pirates detected at destination - fled, will retry");
            await ctx.sleep(30000);
            continue;
          }
        }
      }

      await ensureDocked(ctx);
      ctx.log("trade", "Arrived at destination — proceeding to sell trade items");

      // Mark as handled and skip remaining setup phases
      recoveredSessionHandled = true;
      // route, withdrawQty already set - will proceed to sell phase
    }

    // ── Handle recovered session in "buying" state with cargo already loaded ──
    // This happens when the session was created but the bot was interrupted before traveling
    if (!recoveredSessionHandled && recoveredSession && recoveredSession.state === "buying") {
      // Verify the destination is still valid
      if (!isValidDestination(ctx, recoveredSession.destSystem, recoveredSession.destPoi)) {
        ctx.log("error", `Cannot recover session: destination ${recoveredSession.destPoiName} is invalid`);
        await failFactionSession(bot.username, "Invalid destination in recovered session");
        recoveredSession = null;
      } else {
        // Check if cargo is already loaded (from previous interrupted attempt)
        await bot.refreshCargo();
        const cargoItem = bot.inventory.find(i => i.itemId === recoveredSession!.itemId);
        const cargoQty = cargoItem?.quantity ?? 0;

          if (cargoQty > 0) {
            ctx.log("trade", `Recovered session in "buying" state with cargo already loaded: ${cargoQty}x ${recoveredSession!.itemName}`);

            // Set up route from session
            route = {
              itemId: recoveredSession!.itemId,
              itemName: recoveredSession!.itemName,
              availableQty: cargoQty,
              destSystem: recoveredSession!.destSystem,
              destPoi: recoveredSession!.destPoi,
              destPoiName: recoveredSession!.destPoiName,
              sellPrice: recoveredSession!.sellPricePerUnit,
              sellQty: recoveredSession!.sellQuantity,
              jumps: recoveredSession!.totalJumps,
              roundTripJumps: recoveredSession!.totalJumps,
              totalRevenue: recoveredSession!.expectedRevenue,
              totalProfit: recoveredSession!.expectedProfit,
            };
            withdrawQty = cargoQty;
            recoveredSessionHandled = true;

            // Skip dock/maintenance and go straight to travel
            await ensureUndocked(ctx);
            const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
            if (!fueled) {
              ctx.log("error", "Cannot refuel for recovered session — will retry next cycle");
              await ctx.sleep(30000);
              continue;
            }

            // Jump directly to destination
            ctx.log("travel", `Resuming route to ${recoveredSession!.destPoiName}...`);
            const arrived = await navigateToSystem(ctx, recoveredSession!.destSystem, {
              ...safetyOpts,
              noJettison: true,
              onJump: async (jumpNum) => {
                const session = getActiveSession(bot.username);
                if (session) {
                  await updateTradeSession(bot.username, { jumpsCompleted: jumpNum });
                }
                return true;
              },
            });

            if (!arrived) {
              ctx.log("error", "Failed to reach destination for recovered session — will retry");
              await ensureDocked(ctx);
              await ctx.sleep(60000);
              continue;
            }

            // Arrived at destination - update session state and continue to sell phase
            await updateTradeSession(bot.username, { state: "at_destination" });
            bot.system = recoveredSession!.destSystem;

            // Travel to destination POI and dock
            if (bot.poi !== recoveredSession!.destPoi) {
              ctx.log("travel", `Traveling to ${recoveredSession!.destPoiName}...`);
              const travelResp = await bot.exec("travel", { target_poi: recoveredSession!.destPoi });

              // Check for battle after travel
              if (await checkBattleAfterCommand(ctx, travelResp.notifications, "travel")) {
                ctx.log("combat", "Battle detected during travel - fleeing!");
                await ctx.sleep(5000);
                continue;
              }

              // CRITICAL: Check for battle interrupt error
              if (travelResp.error) {
                const errMsg = travelResp.error.message.toLowerCase();
                if (travelResp.error.code === "battle_interrupt" || errMsg.includes("interrupted by battle") || errMsg.includes("interrupted by combat")) {
                  ctx.log("combat", `Travel to destination interrupted by battle! ${travelResp.error.message} - fleeing!`);
                  await ctx.sleep(5000);
                  continue;
                }
              }

              bot.poi = recoveredSession!.destPoi;
            }

            await ensureDocked(ctx);
            ctx.log("trade", "Arrived at destination — proceeding to sell trade items");
            // route, withdrawQty already set - will proceed to sell phase
          }
        }
      }
  }

    // ── Dock (also records market data + analyzes market) ──
    if (!recoveredSessionHandled) {
      yield "dock";
      await ensureDocked(ctx);

      // Re-check faction membership after docking (if we started undocked)
      if (!bot.docked) {
        // Docking failed, keep personalMode assumption
      } else if (personalMode) {
        // We assumed personal mode because we were undocked - now re-check
        //const factionResp = await bot.exec("view_storage", { target: "faction" });
        const factionResp = await bot.exec("storage", { action: 'view', target: "faction" }); //fixed by human! should view faction storage.
        if (!factionResp.error) {
          // Set faction if not set
          const result = factionResp.result as any;
          if (result.faction_id && !bot.faction) {
            bot.faction = result.faction_id;
          }
        }
        if (factionResp.error) {
          factionError = factionResp.error.message || "";
          personalMode = factionError.includes("not_in_faction") || factionError.includes("not in a faction");
        } else {
          factionError = null;
        }
        ctx.log("trade", personalMode
          ? `PERSONAL MODE: Bot is not in a faction, using personal storage`
          : `FACTION MODE: Bot is in a faction, using faction storage`);
      }

      // ── Maintenance ──
      yield "maintenance";
      await tryRefuel(ctx);
      await repairShip(ctx);
    } // End if (!recoveredSessionHandled)

    // ── Find sell routes from faction storage ──
    yield "find_sales";

    // Ensure docked before refreshing storage
    if (!bot.docked) {
      ctx.log("warn", "Not docked for find_sales phase — attempting to dock...");
      await ensureDocked(ctx);
    }

    // Refresh storage based on mode
    if (personalMode) {
      await bot.refreshStorage();
      ctx.log("trade", `PERSONAL MODE: Bot is not in a faction, using personal storage`);
    } else {
      await bot.refreshFactionStorage();
      // Show helpful message if faction storage is empty at this station
      if (factionError && (factionError.includes("no_faction_storage") || factionError.includes("no storage"))) {
        ctx.log("trade", `FACTION MODE: Bot is in a faction, but no faction storage at this station — travel to home station`);
      } else {
        ctx.log("trade", `FACTION MODE: Bot is in a faction, using faction storage`);
      }
    }
    
    await bot.refreshStatus();
    const cargoCapacity = bot.cargoMax > 0 ? bot.cargoMax : 50;
    const foundRoutes = findFactionSellRoutes(ctx, settings, bot.system, cargoCapacity, personalMode);

    // Station priority: put routes whose destination is the home station first
    if (settings.stationPriority && settings.homeSystem) {
      const homeStation = mapStore.findNearestStation(settings.homeSystem);
      if (homeStation) {
        const homeRoutes = foundRoutes.filter(r => r.destSystem === settings.homeSystem && r.destPoi === homeStation.id);
        const otherRoutes = foundRoutes.filter(r => !(r.destSystem === settings.homeSystem && r.destPoi === homeStation.id));
        if (homeRoutes.length > 0) {
          foundRoutes.length = 0;
          foundRoutes.push(...homeRoutes, ...otherRoutes);
          ctx.log("trade", `Station priority: ${homeRoutes.length} route(s) to home station`);
        }
      }
    }

    if (foundRoutes.length === 0) {
      // Check if bot has cargo items that need to be sold (recovery from interrupted session)
      await bot.refreshCargo();
      const nonFuelCargo = bot.inventory.filter(i => {
        const lower = i.itemId.toLowerCase();
        return !lower.includes("fuel") && !lower.includes("energy_cell") && i.quantity > 0;
      });
      
      if (nonFuelCargo.length > 0) {
        ctx.log("trade", `Found ${nonFuelCargo.length} item(s) in cargo — finding buyers for recovery`);
        // Find best buyers for cargo items
        const allBuys = mapStore.getAllBuyDemand();
        const cargoRoutes: FactionSellRoute[] = [];
        const cargoCapacity = bot.cargoMax > 0 ? bot.cargoMax : 50;
        
        for (const item of nonFuelCargo) {
          const itemConfig = settings.tradeItems.find(t => t.itemId === item.itemId);
          const itemMinSellPrice = (itemConfig && itemConfig.minSellPrice > 0) ? itemConfig.minSellPrice : settings.minSellPrice;

          const buyers = allBuys
            .filter(b => b.itemId === item.itemId && b.price > 0 && b.quantity > 0)
            .filter(b => itemMinSellPrice === 0 || b.price >= itemMinSellPrice)
            .sort((a, b) => b.price - a.price);

          if (buyers.length === 0) {
            if (itemMinSellPrice > 0) {
              ctx.log("trade", `No buyers meet min price (${itemMinSellPrice}cr) for ${item.quantity}x ${item.name} in cargo`);
            } else {
              ctx.log("trade", `No buyers found for ${item.quantity}x ${item.name} in cargo`);
            }
            continue;
          }

          const bestBuyer = buyers[0];

          // Verify destination is a valid station with a market
          if (!isValidDestination(ctx, bestBuyer.systemId, bestBuyer.poiId)) {
            ctx.log("error", `Skipping corrupt destination: ${bestBuyer.poiName} (${bestBuyer.systemId})`);
            continue;
          }

          const toDest = estimateFuelCost(bot.system, bestBuyer.systemId, settings.fuelCostPerJump);
          const returnHome = estimateFuelCost(bestBuyer.systemId, settings.homeSystem || bot.system, settings.fuelCostPerJump);
          const roundTripJumps = toDest.jumps + (returnHome.jumps < 999 ? returnHome.jumps : 0);
          const qty = Math.min(item.quantity, bestBuyer.quantity, maxItemsForCargo(cargoCapacity, item.itemId));

          cargoRoutes.push({
            itemId: item.itemId,
            itemName: item.name,
            availableQty: item.quantity,
            destSystem: bestBuyer.systemId,
            destPoi: bestBuyer.poiId,
            destPoiName: bestBuyer.poiName,
            sellPrice: bestBuyer.price,
            sellQty: qty,
            jumps: toDest.jumps,
            roundTripJumps,
            totalRevenue: qty * bestBuyer.price,
            totalProfit: qty * bestBuyer.price, // No acquisition cost for recovered cargo
          });
        }

        if (cargoRoutes.length > 0) {
          cargoRoutes.sort((a, b) => b.totalRevenue - a.totalRevenue);
          route = cargoRoutes[0];
          ctx.log("trade", `Recovery route: ${route.sellQty}x ${route.itemName} → ${route.destPoiName} (${route.sellPrice}cr/ea)`);
          // Skip to selling this cargo
          recoveredSessionHandled = true; // Skip storage withdrawal
        } else {
          ctx.log("error", `No buyers found for cargo items: ${nonFuelCargo.map(i => `${i.quantity}x ${i.name}`).join(", ")}`);
        }
      }
      
      // If still no route, check storage and potentially return home
      if (!route) {
        // If not at home, go there — storage is only visible at the home station
        const storageType = personalMode ? "personal" : "faction";
        const homeSystem = settings.homeSystem || startSystem;
        const homeStationPoi = settings.homeStation || null;
        const atHome = (!homeSystem || bot.system === homeSystem) && (!homeStationPoi || bot.poi === homeStationPoi);
        if (!atHome) {
          ctx.log("trade", `No ${storageType} storage items to sell — returning home to check ${storageType} storage`);
          yield "return_home";
          if (homeSystem && bot.system !== homeSystem) {
            await ensureUndocked(ctx);
            const homeFueled = await ensureFueled(ctx, settings.refuelThreshold);
            if (homeFueled) {
              await navigateToSystem(ctx, homeSystem, {
                fuelThresholdPct: settings.refuelThreshold,
                hullThresholdPct: settings.repairThreshold,
              });
            }
          }
          if (homeStationPoi && bot.poi !== homeStationPoi) {
            await ensureUndocked(ctx);
            const tResp = await bot.exec("travel", { target_poi: homeStationPoi });

            // Check for battle after travel
            if (await checkBattleAfterCommand(ctx, tResp.notifications, "travel")) {
              ctx.log("combat", "Battle detected during travel home - fleeing!");
              await ctx.sleep(5000);
              continue;
            }

            // CRITICAL: Check for battle interrupt error
            if (tResp.error) {
              const errMsg = tResp.error.message.toLowerCase();
              if (tResp.error.code === "battle_interrupt" || errMsg.includes("interrupted by battle") || errMsg.includes("interrupted by combat")) {
                ctx.log("combat", `Travel home interrupted by battle! ${tResp.error.message} - fleeing!`);
                await ctx.sleep(5000);
                continue;
              }
            }

            if (!tResp.error || tResp.error.message.includes("already")) {
              bot.poi = homeStationPoi;
            }
          }
          continue;
        }
        ctx.log("trade", `No ${storageType} storage items to sell — waiting 60s`);
        await ctx.sleep(60000);
        continue;
      }
    }

    // Use existing route if recovered session is being handled, otherwise pick the best found route
    if (!recoveredSessionHandled) {
      // Iterate through found routes to find one with an available lock
      for (const candidateRoute of foundRoutes) {
        // Verify destination is still valid
        if (!isValidDestination(ctx, candidateRoute.destSystem, candidateRoute.destPoi)) {
          ctx.log("error", `Skipping route to invalid destination: ${candidateRoute.destPoiName}`);
          continue;
        }

        const lockKey = getBuyOrderKey(candidateRoute.itemId, candidateRoute.destPoi, candidateRoute.sellPrice);
        const existingLock = getBuyOrderLock(candidateRoute.itemId, candidateRoute.destPoi, candidateRoute.sellPrice);

        if (existingLock) {
          ctx.log("trade", `Skipping route to ${candidateRoute.destPoiName} — buy order locked by ${existingLock.lockedBy}`);
          continue;
        }

        route = candidateRoute;
        break;
      }
      
      if (!route) {
        ctx.log("trade", "All found routes have locked buy orders — waiting 60s");
        await ctx.sleep(60000);
        continue;
      }
    }
    // route is guaranteed to be non-null here: either from recoveredSession or from foundRoutes
    const routeLabel = route!.roundTripJumps > route!.jumps
      ? `${route!.jumps} jumps out, ${route!.roundTripJumps} round-trip`
      : `${route!.jumps} jumps`;
    ctx.log("trade", `Faction sale: ${route!.sellQty}x ${route!.itemName} → ${route!.destPoiName} (${route!.sellPrice}cr/ea, ${routeLabel}, profit ~${Math.round(route!.totalProfit)}cr)`);

    const isInStation = route!.jumps === 0 && route!.destSystem === bot.system;

    if (isInStation) {
      // ── In-station: batch withdraw→sell loop ──
      let totalSold = 0;
      let totalRevenue = 0;
      let remaining = route!.availableQty;

      // Check if items are already in cargo (recovery from interrupted session)
      await bot.refreshCargo();
      const existingCargoItem = bot.inventory.find(i => i.itemId === route!.itemId);
      const isCargoRecovery = !!(existingCargoItem && existingCargoItem.quantity > 0);

      while (remaining > 0 && bot.state === "running") {
        await bot.refreshStatus();

        // Check battle status at start of each cycle
        if (battleState.inBattle) {
          ctx.log("combat", "Re-issuing flee stance during trade operations (ensuring we stay in flee mode)...");
          const fleeResp = await bot.exec("battle", { action: "stance", stance: "flee" });
          if (fleeResp.error) {
            ctx.log("error", `Flee re-issue failed: ${fleeResp.error.message}`);
          }
          // Check if we've successfully disengaged
          const currentBattleStatus = await getBattleStatus(ctx);
          if (!currentBattleStatus || !currentBattleStatus.is_participant) {
            ctx.log("combat", "Battle cleared - no longer in combat! Resuming trade operations...");
            battleState.inBattle = false;
            battleState.battleId = null;
            battleState.isFleeing = false;
          } else {
            // Still in battle - wait briefly and continue to next cycle to re-flee
            await ctx.sleep(2000);
            continue;
          }
        }

        // For cargo recovery, sell directly from cargo
        if (isCargoRecovery) {
          await bot.refreshCargo();
          const inCargo = bot.inventory.find(i => i.itemId === route!.itemId);
          if (!inCargo || inCargo.quantity <= 0) {
            ctx.log("error", "Cargo recovery: item no longer in cargo!");
            break;
          }
          const sellQty = Math.min(inCargo.quantity, remaining);
          const sResp = await bot.exec("sell", { item_id: route!.itemId, quantity: sellQty });
          if (sResp.error) {
            ctx.log("error", `Cargo recovery sell failed: ${sResp.error.message}`);
            break;
          }
          // Wait for cargo update after sell
          await ctx.sleep(12000);
          // Verify sale by checking cargo after sell
          await bot.refreshCargo();
          const afterSell = bot.inventory.find(i => i.itemId === route!.itemId)?.quantity ?? 0;
          const actuallySold = inCargo.quantity - afterSell;
          
          if (actuallySold <= 0) {
            const itemConfig = settings.tradeItems.find(t => t.itemId === route!.itemId);
            const itemMinSellPrice = (itemConfig && itemConfig.minSellPrice > 0) ? itemConfig.minSellPrice : settings.minSellPrice;
            if (itemMinSellPrice > 0 && inCargo.quantity > 0) {
              ctx.log("error", `Cargo recovery: Sell command succeeded but no items were sold! (price ${route!.sellPrice}cr may be below minimum ${itemMinSellPrice}cr)`);
            } else {
              ctx.log("error", `Cargo recovery: Sell command succeeded but no items were sold!`);
            }
            break;
          }
          
          totalSold += actuallySold;
          remaining -= actuallySold;
          ctx.log("trade", `Cargo recovery: Sold ${actuallySold}x ${route!.itemName} (${totalSold} total, ${remaining} remaining)`);
          continue;
        }
        
        const freeSpace = getFreeSpace(bot);
        if (freeSpace <= 0) {
          await bot.refreshCargo();
          // First try to sell the trade item we already have
          const inCargo = bot.inventory.find(i => i.itemId === route!.itemId);
          if (inCargo && inCargo.quantity > 0) {
            // Get actual market data before selling
            const itemConfig = settings.tradeItems.find(t => t.itemId === route!.itemId);
            const itemMinSellPrice = (itemConfig && itemConfig.minSellPrice > 0) ? itemConfig.minSellPrice : settings.minSellPrice;

            const marketCheck = await calculateFactionOptimalSellQuantity(
              ctx, route!.itemId, route!.itemName, inCargo.quantity, itemMinSellPrice
            );

            if (marketCheck.sellQty > 0) {
            ctx.log("trade", `Selling ${marketCheck.sellQty}x ${route!.itemName} (${marketCheck.priceBreakdown})...`);
            const sResp = await bot.exec("sell", { item_id: route!.itemId, quantity: marketCheck.sellQty });
            if (!sResp.error) {
              // Wait for cargo update after sell
              await ctx.sleep(12000);

              // Get actual revenue from sell result
              const sr = sResp.result as Record<string, unknown> | undefined;
              const actualRevenue = (sr?.credits_earned as number) ?? (sr?.total as number) ?? (sr?.revenue as number) ?? 0;

              // Verify sale
              await bot.refreshCargo();
                const afterSell = bot.inventory.find(i => i.itemId === route!.itemId)?.quantity ?? 0;
                const actuallySold = marketCheck.sellQty - afterSell;
                if (actuallySold > 0) {
                  totalSold += actuallySold;
                  const revenue = actualRevenue > 0 ? actualRevenue : actuallySold * marketCheck.weightedAvgPrice;
                  ctx.log("trade", `Sold ${actuallySold}x ${route!.itemName} from full cargo — ${revenue}cr revenue (actual)`);
                }
              }
            } else {
              if (itemMinSellPrice > 0) {
                ctx.log("trade", `No viable buy orders for ${route!.itemName} — all below minimum price of ${itemMinSellPrice}cr`);
              } else {
                ctx.log("trade", `No viable buy orders for ${route!.itemName} — skipping`);
              }
            }
            continue;
          }
          // Cargo full of other items (including fuel) — dump all to storage
          let freed = false;
          for (const item of [...bot.inventory]) {
            if (item.quantity <= 0) continue;
            let dResp;
            if (personalMode) {
              // Personal storage - use deposit_items command
              //dResp = await bot.exec("deposit_items", { item_id: item.itemId, quantity: item.quantity });
              dResp = await bot.exec("storage", { action: 'deposit', target: 'station', item_id: item.itemId, quantity: item.quantity }); //fixed by human!
            } else {
              // Faction storage
              //dResp = await bot.exec("faction_deposit_items", { item_id: item.itemId, quantity: item.quantity });
              dResp = await bot.exec("storage", { action: 'deposit', target: 'faction', item_id: item.itemId, quantity: item.quantity }); //fixed by human!
              if (dResp.error) {
                //dResp = await bot.exec("deposit_items", { item_id: item.itemId, quantity: item.quantity });
                dResp = await bot.exec("storage", { action: 'deposit', target: 'station', item_id: item.itemId, quantity: item.quantity }); //fixed by human!
              }
            }
            if (!dResp.error) {
              freed = true;
            }
          }
          if (!freed) break;
          continue;
        }

        let wQty = Math.min(remaining, maxItemsForCargo(freeSpace, route!.itemId));
        if (wQty <= 0) break;

        // Withdraw from storage based on mode
        let wResp;
        if (personalMode) {
          // Personal storage - use withdraw_items command
          //wResp = await bot.exec("withdraw_items", { item_id: route!.itemId, quantity: wQty });
          wResp = await bot.exec("storage", { action: 'withdraw', target: 'storage', item_id: route!.itemId, quantity: wQty }); //fixed by human, this should take from storage to cargo.
          // Check for battle notifications after withdraw
          if (wResp.notifications && Array.isArray(wResp.notifications)) {
            const battleDetected = await handleBattleNotifications(ctx, wResp.notifications, battleState);
            if (battleDetected) {
              ctx.log("combat", "Battle detected during withdraw - initiating flee!");
              battleState.isFleeing = false;
            }
          }
        } else {
          // Faction storage
          //wResp = await bot.exec("faction_withdraw_items", { item_id: route!.itemId, quantity: wQty });
          wResp = await bot.exec("storage", { action: 'withdraw', target: 'faction', item_id: route!.itemId, quantity: wQty }); //fixed by human! withdraws to cargo from faction.
          // Check for battle notifications after faction withdraw
          if (wResp.notifications && Array.isArray(wResp.notifications)) {
            const battleDetected = await handleBattleNotifications(ctx, wResp.notifications, battleState);
            if (battleDetected) {
              ctx.log("combat", "Battle detected during faction withdraw - initiating flee!");
              battleState.isFleeing = false;
            }
          }
          if (wResp.error && wResp.error.message.includes("cargo_full")) {
            wQty = Math.max(1, Math.floor(wQty / 2));
            //wResp = await bot.exec("faction_withdraw_items", { item_id: route!.itemId, quantity: wQty });
            wResp = await bot.exec("storage", { action: 'withdraw', target: 'faction', item_id: route!.itemId, quantity: wQty }); //fixed by human! withdraw from faction to cargo.
          }
          // Handle no_faction_storage error — return home and retry
          if (wResp.error && wResp.error.message.includes("no_faction_storage")) {
            ctx.log("error", `No faction storage at current station — returning to home station`);
            // Clear faction storage cache to prevent stale data
            clearFactionStorageCache();
            bot.factionStorage = [];
            // Skip to return home
            await ctx.sleep(30000);
            break;
          }
        }

        if (wResp.error) {
          if (totalSold > 0) break;
          ctx.log("error", `Withdraw failed: ${wResp.error.message}`);
          break;
        }

        // Verify item was actually withdrawn to cargo
        await bot.refreshCargo();
        const afterWithdraw = bot.inventory.find(i => i.itemId === route!.itemId)?.quantity ?? 0;
        if (afterWithdraw <= 0) {
          ctx.log("error", `Withdraw returned no items - item may not exist in storage`);
          break;
        }

        // remaining adjusted after sell based on actual quantity sold

        // Get actual market data before selling
        const itemConfig = settings.tradeItems.find(t => t.itemId === route!.itemId);
        const itemMinSellPrice = (itemConfig && itemConfig.minSellPrice > 0) ? itemConfig.minSellPrice : settings.minSellPrice;

        // Get initial market check to list eligible buy orders
        const initialMarketCheck = await calculateFactionOptimalSellQuantity(
          ctx, route!.itemId, route!.itemName, wQty, itemMinSellPrice
        );

        if (initialMarketCheck.buyOrders.length === 0) {
          if (itemMinSellPrice > 0) {
            ctx.log("trade", `No viable buy orders for ${route!.itemName} — all below minimum price of ${itemMinSellPrice}cr`);
          } else {
            ctx.log("trade", `No viable buy orders for ${route!.itemName} — skipping`);
          }
          continue;
        }

        ctx.log("trade", `Processing ${initialMarketCheck.buyOrders.length} buy orders for ${route!.itemName} (min price: ${itemMinSellPrice}cr)`);

        // Process each buy order individually, highest price first
        for (const buyOrder of initialMarketCheck.buyOrders) {
          const { priceEach, qtyToSell: targetQty } = buyOrder;
          ctx.log("trade", `[DEBUG] Processing buy order: ${targetQty}x @ ${priceEach}cr`);

          let orderTotalSold = 0;
          const maxRetries = 3;

          // Retry loop for this buy order
          for (let retry = 0; retry < maxRetries; retry++) {
            // Refresh market data to confirm buy order still exists
            const marketResp = await bot.exec("view_market", { item_id: route!.itemId });
            if (marketResp.error || !marketResp.result) {
              ctx.log("warn", `[DEBUG] Failed to refresh market for ${route!.itemName} (retry ${retry + 1}/${maxRetries})`);
              await ctx.sleep(1000);
              continue;
            }

            const marketData = marketResp.result as Record<string, unknown>;
            const items = Array.isArray(marketData) ? marketData :
              Array.isArray((marketData as any).items) ? (marketData as any).items : [];
            const itemMarket = items.find((i: any) => i.item_id === route!.itemId);
            if (!itemMarket) {
              ctx.log("warn", `[DEBUG] No market data for ${route!.itemName} (retry ${retry + 1}/${maxRetries})`);
              await ctx.sleep(1000);
              continue;
            }

            const currentBuyOrders = (itemMarket.buy_orders as Array<Record<string, unknown>>) || [];
            // Find matching buy order (same price, still has quantity)
            const matchingOrder = currentBuyOrders.find(o => 
              (o.price_each as number) === priceEach && (o.quantity as number) > 0
            );

            if (!matchingOrder) {
              ctx.log("trade", `[DEBUG] Buy order at ${priceEach}cr no longer available — skipping`);
              break; // Exit retry loop for this order
            }

            const currentOrderQty = (matchingOrder.quantity as number) || 0;
            const currentPrice = (matchingOrder.price_each as number) || 0;

            // Check current cargo
            await bot.refreshCargo();
            const cargoQty = bot.inventory.find(i => i.itemId === route!.itemId)?.quantity ?? 0;
            if (cargoQty <= 0) {
              ctx.log("trade", `No ${route!.itemName} remaining in cargo — stopping`);
              break;
            }

            // Calculate quantity to sell now
            const sellNow = Math.min(targetQty - orderTotalSold, currentOrderQty, cargoQty);
            if (sellNow <= 0) {
              ctx.log("trade", `[DEBUG] Buy order at ${priceEach}cr has no remaining quantity — skipping`);
              break;
            }

            ctx.log("trade", `Attempting to sell ${sellNow}x ${route!.itemName} at ${currentPrice}cr (retry ${retry + 1}/${maxRetries})...`);

            const sResp = await bot.exec("sell", { item_id: route!.itemId, quantity: sellNow });

            // Check for battle notifications
            if (sResp.notifications && Array.isArray(sResp.notifications)) {
              const battleDetected = await handleBattleNotifications(ctx, sResp.notifications, battleState);
              if (battleDetected) {
                ctx.log("combat", "Battle detected during sell - initiating flee!");
                battleState.isFleeing = false;
                await ctx.sleep(5000);
                break;
              }
            }

            if (sResp.error) {
              ctx.log("error", `Sell failed: ${sResp.error.message} (retry ${retry + 1}/${maxRetries})`);
              await ctx.sleep(1000);
              continue;
            }

            // Wait for cargo update after successful sell
            await ctx.sleep(12000);

            // Verify sale
            await bot.refreshCargo();
            const afterQty = bot.inventory.find(i => i.itemId === route!.itemId)?.quantity ?? 0;
            const soldThisAttempt = cargoQty - afterQty;

            if (soldThisAttempt <= 0) {
              ctx.log("error", `Sell succeeded but no items sold (retry ${retry + 1}/${maxRetries})`);
              await ctx.sleep(1000);
              continue;
            }

            // Success
            orderTotalSold += soldThisAttempt;
            const revenue = soldThisAttempt * currentPrice;
            totalSold += soldThisAttempt;
            totalRevenue += revenue;
            ctx.log("trade", `Sold ${soldThisAttempt}x ${route!.itemName} at ${currentPrice}cr — ${revenue}cr (order total: ${orderTotalSold}/${targetQty}, overall total: ${totalSold})`);

            // If we've sold the target quantity for this order, break
            if (orderTotalSold >= targetQty) {
              break;
            }
            await ctx.sleep(500); // Short delay before next attempt on same order
          }

          if (orderTotalSold === 0) {
            ctx.log("error", `Failed to sell any items for buy order at ${priceEach}cr after ${maxRetries} retries`);
          } else if (orderTotalSold < targetQty) {
            ctx.log("trade", `Partially sold buy order at ${priceEach}cr: ${orderTotalSold}/${targetQty}`);
          }
        }

        // After processing all buy orders, check if we sold anything
        if (totalSold === 0) {
          ctx.log("error", `No items were sold for ${route!.itemName} — failing session`);
          const session = getActiveSession(bot.username);
          if (session) {
            await failFactionSession(bot.username, "No items were actually sold");
          }
          break;
        } else {
          ctx.log("trade", `Finished selling ${route!.itemName}: ${totalSold}x total, ${totalRevenue}cr revenue`);
          remaining -= totalSold;
          // Deposit any unsold cargo back to storage
          await bot.refreshCargo();
          const remainingCargo = bot.inventory.find(i => i.itemId === route!.itemId)?.quantity ?? 0;
          if (remainingCargo > 0) {
            ctx.log("trade", `Depositing ${remainingCargo}x unsold ${route!.itemName} back to storage`);
            let dResp;
            if (personalMode) {
              //dResp = await bot.exec("deposit_items", { item_id: route!.itemId, quantity: remainingCargo });
              dResp = await bot.exec("storage", { action: 'deposit', target: 'storage', item_id: route!.itemId, quantity: remainingCargo }); //fixed by human!
            } else {
              //dResp = await bot.exec("faction_deposit_items", { item_id: route!.itemId, quantity: remainingCargo });
              dResp = await bot.exec("storage", { action: 'deposit', target: 'faction', item_id: route!.itemId, quantity: remainingCargo }); //fixed by human!
            }
            if (dResp.error) {
              ctx.log("error", `Failed to deposit unsold items: ${dResp.error.message}`);
            } else {
              remaining += remainingCargo; // Add back to remaining to sell
            }
          }
          continue;
        }
      }

      if (totalSold > 0) {
        await bot.refreshStatus();
        await recordMarketData(ctx);
        bot.stats.totalTrades++;
        bot.stats.totalProfit += totalRevenue;
        ctx.log("trade", `Faction sale complete: ${totalSold}x ${route!.itemName} — ${totalRevenue}cr revenue (actual)`);
        await factionDonateProfit(ctx, totalRevenue);
        // Complete trade session for in-station sale
        const session = createTradeSession({
          botUsername: bot.username,
          route: {
            itemId: route!.itemId,
            itemName: route!.itemName,
            sourceSystem: bot.system,
            sourcePoi: bot.poi,
            sourcePoiName: bot.poi || "Unknown",
            buyPrice: 0,
            buyQty: totalSold,
            destSystem: route!.destSystem,
            destPoi: route!.destPoi,
            destPoiName: route!.destPoiName,
            sellPrice: route!.sellPrice,
            sellQty: totalSold,
            jumps: 0,
            profitPerUnit: route!.sellPrice,
            totalProfit: totalRevenue,
          },
          isFactionRoute: true,
          isCargoRoute: false,
          investedCredits: 0,
        });
        session.state = "completed";
        session.completedAt = new Date().toISOString();
        await startTradeSession(session);
        ctx.log("trade", `In-station trade session completed: ${totalSold}x ${route!.itemName}`);
      } else if (route) {
        // No items sold - fail any existing session
        const session = getActiveSession(bot.username);
        if (session) {
          await failFactionSession(bot.username, "No items were actually sold");
        }
      }
    } else {
      // ── Cross-system: withdraw, travel, sell ──
      yield "withdraw_faction";
      await ensureDocked(ctx);

      // Check if items are already in cargo (recovery from interrupted session)
      await bot.refreshCargo();
      const existingCargoItem = bot.inventory.find(i => i.itemId === route!.itemId);
      const isCargoRecovery = !!(existingCargoItem && existingCargoItem.quantity > 0);
      let qty = 0; // Declare at higher scope for session creation

      // For cargo recovery, skip clearing cargo and withdrawal - items are already in cargo
      if (!isCargoRecovery) {
        // Clear ALL cargo to make room — keep only fuel cells needed for the round trip
        await bot.refreshCargo();
        if (bot.inventory.length > 0) {
          const fuelReserve = Math.max(3, route!.roundTripJumps + 2); // round trip + buffer
          let fuelKept = 0;
          const deposited: string[] = [];
          for (const item of [...bot.inventory]) {
            if (item.quantity <= 0) continue;
            const lower = item.itemId.toLowerCase();
            const isFuel = lower.includes("fuel") || lower.includes("energy_cell");
            if (isFuel) {
              const keep = Math.min(item.quantity, Math.max(0, fuelReserve - fuelKept));
              fuelKept += keep;
              const excess = item.quantity - keep;
              if (excess <= 0) continue;
              // Deposit to storage based on mode
              let dResp;
              if (personalMode) {
                //dResp = await bot.exec("deposit_items", { item_id: item.itemId, quantity: excess });
                dResp = await bot.exec("storage", { action: 'deposit', target: 'storage', item_id: item.itemId, quantity: excess }); //fixed by human!
              } else {
                //dResp = await bot.exec("faction_deposit_items", { item_id: item.itemId, quantity: excess });
                dResp = await bot.exec("storage", { action: 'deposit', target: 'faction', item_id: item.itemId, quantity: excess }); //fixed by human!
                if (dResp.error) {
                  //dResp = await bot.exec("deposit_items", { item_id: item.itemId, quantity: excess });
                  dResp = await bot.exec("storage", { action: '', target: 'storage', item_id: item.itemId, quantity: excess }); //fixed by human!
                }
              }
              deposited.push(`${excess}x ${item.name}`);
            } else {
              // Deposit to storage based on mode
              let dResp;
              if (personalMode) {
                //dResp = await bot.exec("deposit_items", { item_id: item.itemId, quantity: item.quantity });
                dResp = await bot.exec("storage", { action: 'deposit', target: 'storage', item_id: item.itemId, quantity: item.quantity }); //fixed by human!
              } else {
                //dResp = await bot.exec("faction_deposit_items", { item_id: item.itemId, quantity: item.quantity });
                dResp = await bot.exec("storage", { action: 'deposit', target: 'faction', item_id: item.itemId, quantity: item.quantity }); //fixed by human!
                if (dResp.error) {
                  //dResp = await bot.exec("deposit_items", { item_id: item.itemId, quantity: item.quantity });
                  dResp = await bot.exec("storage", { action: 'deposit', target: 'storage', item_id: item.itemId, quantity: item.quantity }); //fixed by human!
                }
              }
              deposited.push(`${item.quantity}x ${item.name}`);
            }
          }
          if (deposited.length > 0) {
            const storageType = personalMode ? "personal storage" : "storage";
            ctx.log("trade", `Cleared cargo: ${deposited.join(", ")} → ${storageType} (kept ${fuelKept} fuel cells)`);
          }
        }
        await bot.refreshCargo();
        await bot.refreshStatus();

        const freeSpace = getFreeSpace(bot);
        qty = Math.min(route!.sellQty, route!.availableQty, maxItemsForCargo(freeSpace, route!.itemId));
        if (qty <= 0) {
          ctx.log("trade", "No cargo space for withdrawal — skipping");
          await ctx.sleep(30000);
          continue;
        }

        // Withdraw from storage based on mode
        let wResp;
        if (personalMode) {
          // Personal storage - use withdraw_items command
          //wResp = await bot.exec("withdraw_items", { item_id: route!.itemId, quantity: qty });
          wResp = await bot.exec("storage", { action: 'withdraw', target: 'station', item_id: route!.itemId, quantity: qty }); //fixed by human! should withdraw from station to cargo.
        } else {
          // Faction storage
          //wResp = await bot.exec("faction_withdraw_items", { item_id: route!.itemId, quantity: qty });
          wResp = await bot.exec("storage", { action: 'withdraw', target: 'faction', item_id: route!.itemId, quantity: qty }); //fixed by human! should withdraw from faction to storage.
          if (wResp.error && wResp.error.message.includes("cargo_full")) {
            qty = Math.max(1, Math.floor(qty / 2));
            //wResp = await bot.exec("faction_withdraw_items", { item_id: route!.itemId, quantity: qty });
            wResp = await bot.exec("storage", { action: 'withdraw', target: 'faction', item_id: route!.itemId, quantity: qty }); //fixed by human! should withdraw from faction to storage.
          }
          // Handle no_faction_storage error — return home and retry
          if (wResp.error && wResp.error.message.includes("no_faction_storage")) {
            ctx.log("error", `No faction storage at current station — returning to home station`);
            // Clear faction storage cache to prevent stale data
            clearFactionStorageCache();
            bot.factionStorage = [];
            // Skip to return home
            await ctx.sleep(30000);
            break;
          }
        }

        if (wResp.error) {
          ctx.log("error", `Withdraw failed: ${wResp.error.message}`);
          await ctx.sleep(30000);
          continue;
        }

        const storageType = personalMode ? "personal storage" : "faction storage";
        ctx.log("trade", `Withdrew ${qty}x ${route!.itemName} from ${storageType}`);
      } else {
        // Cargo recovery - verify items are in cargo
        await bot.refreshCargo();
        const inCargo = bot.inventory.find(i => i.itemId === route!.itemId);
        if (!inCargo || inCargo.quantity <= 0) {
          ctx.log("error", "Cargo recovery: items not in cargo!");
          await ctx.sleep(30000);
          continue;
        }
        qty = inCargo.quantity;
        ctx.log("trade", `Cargo recovery: ${qty}x ${route!.itemName} in cargo — proceeding to destination`);
      }

      // Create trade session for crash recovery
      const session = createTradeSession({
        botUsername: bot.username,
        route: {
          itemId: route!.itemId,
          itemName: route!.itemName,
          sourceSystem: bot.system,
          sourcePoi: bot.poi,
          sourcePoiName: bot.poi || "Unknown",
          buyPrice: 0, // Faction items have no purchase cost
          buyQty: qty,
          destSystem: route!.destSystem,
          destPoi: route!.destPoi,
          destPoiName: route!.destPoiName,
          sellPrice: route!.sellPrice,
          sellQty: route!.sellQty,
          jumps: route!.jumps,
          profitPerUnit: route!.sellPrice,
          totalProfit: route!.totalProfit,
        },
        isFactionRoute: !personalMode,
        isCargoRoute: isCargoRecovery, // Mark as cargo route for recovery
        investedCredits: 0,
      });
      session.state = isCargoRecovery ? "in_transit" : "buying"; // Cargo recovery is already past buying phase

      // Acquire lock on the destination buy order
      const lockAcquired = acquireBuyOrderLock({
        botUsername: bot.username,
        itemId: session.itemId,
        itemName: session.itemName,
        destSystem: session.destSystem,
        destPoi: session.destPoi,
        destPoiName: session.destPoiName,
        pricePerUnit: session.sellPricePerUnit,
        quantityCommitted: session.sellQuantity,
        sessionId: session.sessionId,
      });

        if (!lockAcquired) {
          ctx.log("trade", `Failed to acquire lock on buy order for ${session.itemName} at ${session.destPoiName} — picking next route`);
          await failFactionSession(bot.username, "Buy order locked by another bot");
          continue;
        }

      await startTradeSession(session);
      ctx.log("trade", `Trade session started: ${session.sessionId}`);

      // Travel to destination
      yield "travel_to_dest";
      await ensureUndocked(ctx);
      const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct, { noJettison: true });
      if (!fueled) {
        ctx.log("error", "Cannot refuel — trade paused until fuel is available");

        // CRITICAL: Do NOT fail the session or sell cargo prematurely!
        // The bot may be rescued by a fuel rescue bot, or fuel may become available later.
        // Keep the session active for recovery.

        // Update session state to reflect we're waiting for fuel
        const session = getActiveSession(bot.username);
        if (session) {
          await updateTradeSession(bot.username, {
            state: "in_transit",
            notes: (session.notes || "") + " | Waiting for fuel",
          });
        }

        // Dock and wait - next cycle may have fuel from rescue or scavenging
        await ensureDocked(ctx);
        ctx.log("trade", "Docked and waiting for fuel — trade session preserved");
        ctx.log("trade", `Session will resume when fueled: ${session?.itemId} (${session?.quantityBought}x) → ${session?.destPoiName}`);

        // Wait 60 seconds before next cycle
        await ctx.sleep(60000);
        continue;
      }

      // Update session state to in_transit
      await updateTradeSession(bot.username, { state: "in_transit" });

      if (bot.system !== route!.destSystem) {
        ctx.log("travel", `Heading to ${route!.destPoiName} in ${route!.destSystem}...`);
        const arrived = await navigateToSystem(ctx, route!.destSystem, {
          ...safetyOpts,
          noJettison: true,
          onJump: async (jumpNum) => {
            if (jumpNum % 3 !== 0) return true;
            const buys = mapStore.getAllBuyDemand();
            const destBuyer = buys.find(b =>
              b.itemId === route!.itemId && b.systemId === route!.destSystem && b.poiId === route!.destPoi
            );
            if (!destBuyer || destBuyer.quantity <= 0) {
              ctx.log("trade", `Mid-route check (jump ${jumpNum}): buyer gone at ${route!.destPoiName} — aborting`);
              return false;
            }
            ctx.log("trade", `Mid-route check (jump ${jumpNum}): trade valid (${destBuyer.price}cr × ${destBuyer.quantity} at dest)`);
            return true;
          },
        });
        if (!arrived) {
          ctx.log("error", "Failed to reach destination — will retry on next cycle");

          // CRITICAL: Do NOT fail the session or sell cargo prematurely!
          // Network issues, server hiccups, and temporary disconnections are common.
          // The session remains active and will be recovered on the next cycle.
          // The bot will retry the jump with exponential backoff in navigateToSystem().

          // Update session state to reflect we're still in transit
          const session = getActiveSession(bot.username);
          if (session) {
            await updateTradeSession(bot.username, {
              state: "in_transit",
              notes: (session.notes || "") + " | Network interruption - will retry",
            });
          }

          // Find a station to dock at and wait for network recovery
          await ensureDocked(ctx);
          ctx.log("trade", "Docked and waiting for network recovery — trade session preserved");
          ctx.log("trade", `Session will resume: ${session?.itemId} (${session?.quantityBought}x) → ${session?.destPoiName}`);

          // Wait 60 seconds before next cycle will retry (gives network time to recover)
          await ctx.sleep(60000);
          continue;
        }
      }

      await ensureUndocked(ctx);
      if (bot.poi !== route!.destPoi) {
        const travelResp = await bot.exec("travel", { target_poi: route!.destPoi });
        
        // Check for battle after travel
        if (await checkBattleAfterCommand(ctx, travelResp.notifications, "travel")) {
          ctx.log("combat", "Battle detected during travel to destination - fleeing!");
          await ctx.sleep(5000);
          continue;
        }

        // CRITICAL: Check for battle interrupt error
        if (travelResp.error) {
          const errMsg = travelResp.error.message.toLowerCase();
          if (travelResp.error.code === "battle_interrupt" || errMsg.includes("interrupted by battle") || errMsg.includes("interrupted by combat")) {
            ctx.log("combat", `Travel to destination interrupted by battle! ${travelResp.error.message} - fleeing!`);
            await ctx.sleep(5000);
            continue;
          }
        }
        
        if (!travelResp.error || travelResp.error.message.includes("already")) {
          bot.poi = route!.destPoi;
        }
      }

      // Dock and sell
      yield "sell";
      await ensureDocked(ctx);
      await bot.refreshCargo();
      const inCargo = bot.inventory.find(i => i.itemId === route!.itemId)?.quantity ?? 0;
      if (inCargo > 0) {
        // Get actual market data to calculate real expected revenue
        const itemConfig = settings.tradeItems.find(t => t.itemId === route!.itemId);
        const itemMinSellPrice = (itemConfig && itemConfig.minSellPrice > 0) ? itemConfig.minSellPrice : settings.minSellPrice;

        const marketCheck = await calculateFactionOptimalSellQuantity(
          ctx, route!.itemId, route!.itemName, inCargo, itemMinSellPrice
        );

        if (marketCheck.sellQty <= 0) {
          const minPrice = itemMinSellPrice > 0 ? ` (minimum: ${itemMinSellPrice}cr)` : "";
          ctx.log("trade", `No viable buy orders for ${route!.itemName} at ${route!.destPoiName}${minPrice} — skipping sell`);
          await failFactionSession(bot.username, "No viable buy orders at destination");
        } else {
          ctx.log("trade", `Selling ${marketCheck.sellQty}x ${route!.itemName} (${marketCheck.priceBreakdown})...`);
          const sResp = await bot.exec("sell", { item_id: route!.itemId, quantity: marketCheck.sellQty });
          if (sResp.error) {
            ctx.log("error", `Sell failed: ${sResp.error.message}`);
            await failFactionSession(bot.username, `Sell failed: ${sResp.error.message}`);
          } else {
            // Wait for cargo update after sell
            await ctx.sleep(12000);

            // Get actual revenue from sell result
            const sr = sResp.result as Record<string, unknown> | undefined;
            const actualRevenue = (sr?.credits_earned as number) ?? (sr?.total as number) ?? (sr?.revenue as number) ?? 0;

            // Verify sale by checking cargo after sell
            await bot.refreshCargo();
            const afterSell = bot.inventory.find(i => i.itemId === route!.itemId)?.quantity ?? 0;
            const actuallySold = marketCheck.sellQty - afterSell;

            if (actuallySold <= 0) {
              ctx.log("error", `Sell command succeeded but no items were sold - item still in cargo (${inCargo}x)`);
              await failFactionSession(bot.username, "Sell command did not remove items from cargo");
            } else {
              const revenue = actualRevenue > 0 ? actualRevenue : actuallySold * marketCheck.weightedAvgPrice;
              bot.stats.totalTrades++;
              bot.stats.totalProfit += revenue;
              ctx.log("trade", `Sold ${actuallySold}x ${route!.itemName} at ${route!.destPoiName} — ${revenue}cr revenue (actual)`);
              await factionDonateProfit(ctx, revenue);
              // Complete trade session
              const actualProfit = revenue; // No acquisition cost for faction items
              await completeTradeSession(bot.username, revenue, actualProfit);

              // Release buy order lock
              const completedSession = getActiveSession(bot.username);
              if (completedSession) {
                releaseBuyOrderLock(
                  bot.username,
                  completedSession.itemId,
                  completedSession.destPoi,
                  completedSession.sellPricePerUnit,
                  "completed"
                );
              }

              ctx.log("trade", "Trade session completed successfully");

              // Update sold quantity tracking in settings
              try {
                const allSettings = readSettings();
                const ftSettings = (allSettings["faction_trader"] as Record<string, unknown>) || {};
                const tradeItems = (ftSettings.tradeItems as TradeItemConfig[]) || [];
                const itemIndex = tradeItems.findIndex(t => t.itemId === route!.itemId);
                if (itemIndex >= 0) {
                  tradeItems[itemIndex].soldQty = (tradeItems[itemIndex].soldQty || 0) + actuallySold;
                  writeSettings({ faction_trader: { tradeItems } as Record<string, unknown> });
                  ctx.log("trade", `Updated sold quantity for ${route!.itemName}: ${tradeItems[itemIndex].soldQty} total`);
                }
              } catch (err) {
                ctx.log("error", `Failed to update sold quantity tracking: ${err}`);
              }

              // Always refuel after selling before heading home (especially important for long return trips)
              ctx.log("system", "Topping off fuel before return journey...");
              await tryRefuel(ctx);
            }
          }
        }
      } else {
        // No cargo - session recovery needed
        ctx.log("error", "No cargo found at destination — trade session may need recovery");
        await failFactionSession(bot.username, "Cargo missing at destination");
      }
      await recordMarketData(ctx);
    } // End else (cross-system)

    // ── Return to home station ──
    const homeSystem = settings.homeSystem || startSystem;
    const homeStationPoi = settings.homeStation || null;
    const needsReturn = homeSystem && (bot.system !== homeSystem || (homeStationPoi && bot.poi !== homeStationPoi));

    if (needsReturn) {
      yield "return_home";
      if (bot.system !== homeSystem) {
        ctx.log("travel", `Returning to home system ${homeSystem}...`);
        await ensureUndocked(ctx);
        const homeFueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
        if (homeFueled) {
          await navigateToSystem(ctx, homeSystem, safetyOpts);
        }
      }

      // Dock at the specific home station POI
      if (homeStationPoi && bot.poi !== homeStationPoi) {
        await ensureUndocked(ctx);
        const tResp = await bot.exec("travel", { target_poi: homeStationPoi });

        // Check for battle after travel
        if (await checkBattleAfterCommand(ctx, tResp.notifications, "travel")) {
          ctx.log("combat", "Battle detected during travel home - fleeing!");
          await ctx.sleep(5000);
          continue;
        }

        // CRITICAL: Check for battle interrupt error
        if (tResp.error) {
          const errMsg = tResp.error.message.toLowerCase();
          if (tResp.error.code === "battle_interrupt" || errMsg.includes("interrupted by battle") || errMsg.includes("interrupted by combat")) {
            ctx.log("combat", `Travel home interrupted by battle! ${tResp.error.message} - fleeing!`);
            await ctx.sleep(5000);
            continue;
          }
        }

        if (!tResp.error || tResp.error.message.includes("already")) {
          bot.poi = homeStationPoi;
        }
      }
    }

    // Maintenance between runs
    yield "post_trade_maintenance";
    await ensureDocked(ctx);
    await tryRefuel(ctx);
    await repairShip(ctx);

    // ── Deposit excess credits: keep only 10k, deposit rest to faction ──
    yield "deposit_credits";
    const BOT_WORKING_BALANCE = 10_000;
    if (bot.credits > BOT_WORKING_BALANCE) {
      const excessCredits = bot.credits - BOT_WORKING_BALANCE;
      //const depositResp = await bot.exec("faction_deposit_credits", { amount: excessCredits });
      const depositResp = await bot.exec("storage", { action: 'deposit', target: 'faction', item_id: 'credits', quantity: excessCredits }); //fixed by human!
      if (!depositResp.error) {
        ctx.log("trade", `Deposited ${excessCredits}cr to faction treasury (retained ${BOT_WORKING_BALANCE}cr)`);
        logFactionActivity(ctx, "deposit", `Deposited ${excessCredits}cr (excess credits above ${BOT_WORKING_BALANCE}cr)`);
      }
    }
  }
};
