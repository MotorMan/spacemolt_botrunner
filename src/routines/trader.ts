import type { Bot, Routine, RoutineContext } from "../bot.js";
import { mapStore } from "../mapstore.js";
import { catalogStore } from "../catalogstore.js";
import { getSystemBlacklist } from "../web/server.js";
import {
  ensureDocked,
  ensureUndocked,
  tryRefuel,
  repairShip,
  ensureFueled,
  navigateToSystem,
  collectFromStorage,
  recordMarketData,
  getSystemInfo,
  findStation,
  factionDonateProfit,
  ensureInsured,
  detectAndRecoverFromDeath,
  getModProfile,
  ensureModsFitted,
  maxItemsForCargo,
  getItemSize,
  readSettings,
  logFactionActivity,
  isPirateSystem,
  checkAndFleeFromBattle,
  checkBattleAfterCommand,
  getBattleStatus,
  fleeFromBattle,
  type BattleState,
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
  getItemLock,
  getRouteLock,
  acquireTradeLock,
  updateTradeLock,
  releaseTradeLock,
  getBestUnlockedRoute,
  canChallengeLock,
  cleanupStaleLocks,
} from "./traderCoordination.js";

/** Free cargo weight (not item count — callers must divide by item size). */
function getFreeSpace(bot: Bot): number {
  if (bot.cargoMax <= 0) return 999;
  return Math.max(0, bot.cargoMax - bot.cargo);
}

/** Minimum credits to keep in personal wallet for trading operations. */
const TRADER_WORKING_BALANCE = 200_000;
/** Buffer above working balance before depositing excess to faction storage. */
const TRADER_DEPOSIT_THRESHOLD = 210_000;

/**
 * Check if the bot can afford a trade route, including potential withdrawal from storage.
 * Returns an object with affordability info and withdrawal recommendation.
 */
async function canAffordRoute(
  ctx: RoutineContext,
  route: TradeRoute,
  settings: ReturnType<typeof getTraderSettings>,
): Promise<{
  canAfford: boolean;
  canAffordWithWithdrawal: boolean;
  withdrawalNeeded: number;
  maxAffordableQty: number;
}> {
  const { bot } = ctx;
  const totalCost = route.buyPrice * route.buyQty;
  const canAffordDirectly = bot.credits >= totalCost;

  if (canAffordDirectly) {
    return {
      canAfford: true,
      canAffordWithWithdrawal: true,
      withdrawalNeeded: 0,
      maxAffordableQty: route.buyQty,
    };
  }

  // Check station storage (personal) and faction storage (if in a faction)
  let storedCredits = 0;

  // Check personal station storage
  const storageResp = await bot.exec("view_storage");
  if (storageResp.result && typeof storageResp.result === "object") {
    const sr = storageResp.result as Record<string, unknown>;
    storedCredits = (sr.credits as number) || (sr.stored_credits as number) || 0;
  }

  // Also check faction storage if bot is in a faction
  let factionStoredCredits = 0;
  if (bot.faction) {
    const factionStorageResp = await bot.exec("view_faction_storage");
    if (factionStorageResp.result && typeof factionStorageResp.result === "object") {
      const fsr = factionStorageResp.result as Record<string, unknown>;
      factionStoredCredits = (fsr.credits as number) || (fsr.stored_credits as number) || 0;
    }
  }

  // Apply maxFactionCreditsToUse limit (0 = unlimited)
  let usableFactionCredits = factionStoredCredits;
  if (settings.maxFactionCreditsToUse > 0) {
    usableFactionCredits = Math.min(factionStoredCredits, settings.maxFactionCreditsToUse);
  }

  const totalStored = storedCredits + usableFactionCredits;
  const shortfall = totalCost - bot.credits;
  const canWithdraw = totalStored >= shortfall;

  // Calculate max affordable quantity with current credits + all storage
  const totalAvailable = bot.credits + totalStored;
  const maxAffordableQty = Math.floor(totalAvailable / route.buyPrice);

  return {
    canAfford: false,
    canAffordWithWithdrawal: canWithdraw && maxAffordableQty > 0,
    withdrawalNeeded: canWithdraw ? shortfall : totalStored,
    maxAffordableQty,
  };
}

/**
 * Withdraw credits from storage to fund a trade route.
 * Tries station storage first, then faction storage if needed.
 * Returns true if withdrawal was successful or not needed.
 */
async function withdrawCreditsForTrade(
  ctx: RoutineContext,
  route: TradeRoute,
  settings: ReturnType<typeof getTraderSettings>,
): Promise<boolean> {
  const { bot } = ctx;
  const totalCost = route.buyPrice * route.buyQty;

  // Already have enough credits
  if (bot.credits >= totalCost) {
    return true;
  }

  const needed = totalCost - bot.credits;

  // Try personal station storage first
  let storedCredits = 0;
  const storageResp = await bot.exec("view_storage");
  if (storageResp.result && typeof storageResp.result === "object") {
    const sr = storageResp.result as Record<string, unknown>;
    storedCredits = (sr.credits as number) || (sr.stored_credits as number) || 0;
  }

  if (storedCredits > 0) {
    const withdrawAmount = Math.min(needed, storedCredits);
    if (withdrawAmount > 0) {
      const wResp = await bot.exec("withdraw_credits", { amount: withdrawAmount });
      if (!wResp.error) {
        await bot.refreshStatus();
        ctx.log("trade", `Withdrew ${withdrawAmount}cr from station storage for trade (now ${bot.credits}cr)`);
        return true;
      }
    }
  }

  // Try faction storage if bot is in a faction
  if (bot.faction) {
    let factionStoredCredits = 0;
    const factionStorageResp = await bot.exec("view_faction_storage");
    if (factionStorageResp.result && typeof factionStorageResp.result === "object") {
      const fsr = factionStorageResp.result as Record<string, unknown>;
      factionStoredCredits = (fsr.credits as number) || (fsr.stored_credits as number) || 0;
    }

    if (factionStoredCredits > 0) {
      // Apply maxFactionCreditsToUse limit (0 = unlimited)
      let usableFactionCredits = factionStoredCredits;
      if (settings.maxFactionCreditsToUse > 0) {
        usableFactionCredits = Math.min(factionStoredCredits, settings.maxFactionCreditsToUse);
      }

      const remainingNeeded = needed - (storedCredits > 0 ? Math.min(needed, storedCredits) : 0);
      const withdrawAmount = Math.min(remainingNeeded, usableFactionCredits);
      if (withdrawAmount > 0) {
        const wResp = await bot.exec("faction_withdraw_credits", { amount: withdrawAmount });
        if (!wResp.error) {
          await bot.refreshStatus();
          ctx.log("trade", `Withdrew ${withdrawAmount}cr from faction storage for trade (now ${bot.credits}cr)`);
          return true;
        } else {
          ctx.log("error", `Failed to withdraw from faction storage: ${wResp.error.message}`);
        }
      }
    }
  }

  ctx.log("trade", `No storage credits available (need ${needed}cr)`);
  return false;
}

// ── Helpers ─────────────────────────────────────────────────

/**
 * Fail a trade session and release the fleet lock.
 */
async function failTradeSessionWithLockRelease(botUsername: string, reason: string): Promise<void> {
  const session = getActiveSession(botUsername);
  failTradeSession(botUsername, reason);
  if (session) {
    const lockReleased = releaseTradeLock(botUsername, session.itemId, `failed: ${reason}`);
    if (lockReleased) {
      console.log(`[Trader] Fleet lock released on ${session.itemName} (failure: ${reason})`);
    }
  }
}

// ── Settings ─────────────────────────────────────────────────

function getTraderSettings(username?: string): {
  minProfitPerUnit: number;
  maxCargoValue: number;
  fuelCostPerJump: number;
  refuelThreshold: number;
  repairThreshold: number;
  homeSystem: string;
  tradeItems: string[];
  autoInsure: boolean;
  stationPriority: boolean;
  autoCloak: boolean;
  maxFactionCreditsToUse: number;
} {
  const all = readSettings();
  const t = all.trader || {};
  const botOverrides = username ? (all[username] || {}) : {};
  return {
    minProfitPerUnit: (t.minProfitPerUnit as number) || 10,
    maxCargoValue: (t.maxCargoValue as number) || 0,
    fuelCostPerJump: (t.fuelCostPerJump as number) || 50,
    refuelThreshold: (t.refuelThreshold as number) || 50,
    repairThreshold: (t.repairThreshold as number) || 40,
    homeSystem: (botOverrides.homeSystem as string) || (t.homeSystem as string) || "",
    tradeItems: Array.isArray(t.tradeItems) ? (t.tradeItems as string[]) : [],
    autoInsure: (t.autoInsure as boolean) !== false,
    stationPriority: (botOverrides.stationPriority as boolean) || false,
    autoCloak: (t.autoCloak as boolean) ?? false,
    maxFactionCreditsToUse: (t.maxFactionCreditsToUse as number) ?? 0, // 0 = unlimited
  };
}

// ── Trade Session Recovery ──────────────────────────────────

/**
 * Check for and recover an incomplete trade session.
 * Validates cargo, destination, and market conditions.
 * Returns the recovered session if valid, or null if recovery is not possible.
 */
async function recoverTradeSession(
  ctx: RoutineContext,
  session: TradeSession,
  settings: ReturnType<typeof getTraderSettings>,
): Promise<TradeSession | null> {
  const { bot } = ctx;
  
  ctx.log("trade", `Found incomplete trade session: ${session.itemName} (${session.state})`);

  // Verify items are still in cargo (for non-cargo routes)
  if (!session.isCargoRoute) {
    await bot.refreshCargo();
    const cargoItem = bot.inventory.find(i => i.itemId === session.itemId);
    const cargoQty = cargoItem?.quantity ?? 0;
    
    if (cargoQty <= 0) {
      ctx.log("error", `Recovery failed: ${session.itemName} no longer in cargo`);
      await failTradeSessionWithLockRelease(session.botUsername, "Items not in cargo");
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
      // Find alternative buyer with a dockable station
      const alternativeBuyers = allBuys
        .filter(b => b.itemId === session.itemId && b.price > 0)
        .map(b => {
          const sys = mapStore.getSystem(b.systemId);
          const poi = sys?.pois.find(p => p.id === b.poiId);
          const hasStation = poi?.has_base ?? false;
          return { buyer: b, hasStation };
        })
        .filter(({ hasStation }) => hasStation)
        .sort((a, b) => b.buyer.price - a.buyer.price);

      if (alternativeBuyers.length === 0) {
        ctx.log("error", "No alternative buyers found — abandoning session");
        await failTradeSessionWithLockRelease(session.botUsername, "No buyers available");
        return null;
      }

      const bestAlt = alternativeBuyers[0].buyer;
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
      ctx.log("error", `Price dropped to ${destBuyer.price}cr (below cost ${session.buyPricePerUnit}cr) — abandoning`);
      await failTradeSessionWithLockRelease(session.botUsername, "Price below cost");
      return null;
    }

    // Validate that the destination POI actually has a station (can dock there)
    const destSystem = mapStore.getSystem(session.destSystem);
    const destPoiData = destSystem?.pois.find(p => p.id === session.destPoi);
    const hasStation = destPoiData?.has_base ?? false;

    if (!hasStation) {
      ctx.log("error", `Destination ${session.destPoiName} has no station — finding alternative buyer`);
      // Find alternative buyer with a dockable station
      const alternativeBuyers = allBuys
        .filter(b => b.itemId === session.itemId && b.price > 0)
        .map(b => {
          const sys = mapStore.getSystem(b.systemId);
          const poi = sys?.pois.find(p => p.id === b.poiId);
          const poiHasStation = poi?.has_base ?? false;
          return { buyer: b, hasStation: poiHasStation };
        })
        .filter(({ hasStation }) => hasStation)
        .sort((a, b) => b.buyer.price - a.buyer.price);

      if (alternativeBuyers.length === 0) {
        ctx.log("error", "No alternative buyers found — abandoning session");
        await failTradeSession(session.botUsername, "No station at destination");
        return null;
      }

      const bestAlt = alternativeBuyers[0].buyer;
      ctx.log("trade", `New destination: ${bestAlt.poiName} in ${bestAlt.systemId} (${bestAlt.price}cr/ea)`);
      const updated = await updateTradeSession(session.botUsername, {
        destSystem: bestAlt.systemId,
        destPoi: bestAlt.poiId,
        destPoiName: bestAlt.poiName,
        sellPricePerUnit: bestAlt.price,
        sellQuantity: Math.min(session.sellQuantity, bestAlt.quantity),
        totalJumps: session.jumpsCompleted + estimateFuelCost(bot.system, bestAlt.systemId, settings.fuelCostPerJump).jumps,
        state: "in_transit" as const,
        notes: (session.notes || "") + ` | Rerouted from ${session.destPoiName} (no station) to ${bestAlt.poiName}`,
      });
      if (updated) session = updated;
    }
  }
  
  ctx.log("trade", `Session recovered: ${session.quantityBought}x ${session.itemName} → ${session.destPoiName}`);
  return session;
}

// ── Types ────────────────────────────────────────────────────

interface TradeRoute {
  itemId: string;
  itemName: string;
  sourceSystem: string;
  sourcePoi: string;
  sourcePoiName: string;
  buyPrice: number;
  buyQty: number;
  destSystem: string;
  destPoi: string;
  destPoiName: string;
  sellPrice: number;
  sellQty: number;
  jumps: number;
  profitPerUnit: number;
  totalProfit: number;
}

// ── Trade route discovery ────────────────────────────────────

/** Estimate fuel cost between two systems using mapStore route data. */
function estimateFuelCost(fromSystem: string, toSystem: string, costPerJump: number): { jumps: number; cost: number } {
  const blacklist = getSystemBlacklist();
  if (fromSystem === toSystem) return { jumps: 0, cost: 0 };
  const route = mapStore.findRoute(fromSystem, toSystem, blacklist);
  if (!route) return { jumps: 999, cost: 999 * costPerJump };
  const jumps = route.length - 1;
  return { jumps, cost: jumps * costPerJump };
}

/** Find profitable trade routes from mapStore price spreads. */
function findTradeOpportunities(settings: ReturnType<typeof getTraderSettings>, currentSystem: string, cargoCapacity: number = 999): TradeRoute[] {
  const spreads = mapStore.findPriceSpreads();
  const routes: TradeRoute[] = [];

  for (const sp of spreads) {
    // Filter by allowed items
    if (settings.tradeItems.length > 0) {
      const match = settings.tradeItems.some(t =>
        sp.itemId.toLowerCase().includes(t.toLowerCase()) ||
        sp.itemName.toLowerCase().includes(t.toLowerCase())
      );
      if (!match) continue;
    }

    // Calculate route: current → source → dest
    const toSource = estimateFuelCost(currentSystem, sp.sourceSystem, settings.fuelCostPerJump);
    const sourceToDest = estimateFuelCost(sp.sourceSystem, sp.destSystem, settings.fuelCostPerJump);
    const totalJumps = toSource.jumps + sourceToDest.jumps;
    const totalFuelCost = toSource.cost + sourceToDest.cost;

    const profitPerUnit = sp.spread - (totalJumps > 0 ? totalFuelCost / Math.min(sp.buyQty, sp.sellQty) : 0);
    if (profitPerUnit < settings.minProfitPerUnit) continue;

    const tradeQty = Math.min(sp.buyQty, sp.sellQty, maxItemsForCargo(cargoCapacity, sp.itemId));
    const totalProfit = profitPerUnit * tradeQty;

    // Cap by max cargo value
    if (settings.maxCargoValue > 0 && sp.buyAt * tradeQty > settings.maxCargoValue) continue;

    routes.push({
      itemId: sp.itemId,
      itemName: sp.itemName,
      sourceSystem: sp.sourceSystem,
      sourcePoi: sp.sourcePoi,
      sourcePoiName: sp.sourcePoiName,
      buyPrice: sp.buyAt,
      buyQty: tradeQty,
      destSystem: sp.destSystem,
      destPoi: sp.destPoi,
      destPoiName: sp.destPoiName,
      sellPrice: sp.sellAt,
      sellQty: tradeQty,
      jumps: totalJumps,
      profitPerUnit,
      totalProfit,
    });
  }

  // Sort by total profit descending
  routes.sort((a, b) => b.totalProfit - a.totalProfit);
  return routes;
}

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
 * Check market for an item and calculate optimal sell quantity based on actual buy orders.
 * Returns the quantity to sell at profitable prices and the expected revenue.
 */
async function calculateOptimalSellQuantity(
  ctx: RoutineContext,
  itemId: string,
  itemName: string,
  availableQuantity: number,
  minPricePerUnit: number,
): Promise<{ sellQty: number; expectedRevenue: number; priceBreakdown: string }> {
  const { bot } = ctx;

  // Check the market for this specific item
  const marketResp = await bot.exec("view_market", { item_id: itemId });
  if (marketResp.error || !marketResp.result) {
    ctx.log("trade", `view_market failed for ${itemName} — using cached data`);
    return { sellQty: availableQuantity, expectedRevenue: availableQuantity * minPricePerUnit, priceBreakdown: "cached" };
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
    return { sellQty: availableQuantity, expectedRevenue: availableQuantity * minPricePerUnit, priceBreakdown: "cached" };
  }

  const buyOrders = (itemMarket.buy_orders as Array<Record<string, unknown>>) || [];
  if (buyOrders.length === 0) {
    ctx.log("trade", `No buy orders for ${itemName} — cannot sell`);
    return { sellQty: 0, expectedRevenue: 0, priceBreakdown: "no buy orders" };
  }

  // Calculate how many we can sell at or above minimum price
  let remainingToSell = availableQuantity;
  let totalRevenue = 0;
  let soldAtProfit = 0;
  const priceDetails: string[] = [];

  for (const order of buyOrders) {
    if (remainingToSell <= 0) break;

    const priceEach = (order.price_each as number) || 0;
    const orderQty = (order.quantity as number) || 0;

    if (orderQty <= 0 || priceEach <= 0) continue;

    const qtyAtThisPrice = Math.min(remainingToSell, orderQty);
    const revenueAtThisPrice = qtyAtThisPrice * priceEach;

    totalRevenue += revenueAtThisPrice;
    remainingToSell -= qtyAtThisPrice;

    if (priceEach >= minPricePerUnit) {
      soldAtProfit += qtyAtThisPrice;
    }

    priceDetails.push(`${qtyAtThisPrice}x @ ${priceEach}cr`);
  }

  const actualSellQty = availableQuantity - remainingToSell;
  const priceBreakdown = priceDetails.join(", ");

  if (remainingToSell > 0) {
    ctx.log("trade", `Market check: can sell ${actualSellQty}/${availableQuantity}x ${itemName} (${priceBreakdown}), holding ${remainingToSell}x`);
  }

  if (soldAtProfit < actualSellQty && actualSellQty > 0) {
    ctx.log("warn", `Market check: only ${soldAtProfit}/${actualSellQty}x ${itemName} at target price ${minPricePerUnit}cr — rest at lower prices`);
  }

  return { sellQty: actualSellQty, expectedRevenue: totalRevenue, priceBreakdown };
}

/**
 * Find alternative profitable buyers for an item, considering acquisition cost.
 * Returns buyers that would result in a profit after fuel costs at dockable stations.
 */
function findProfitableAlternativeBuyers(
  itemId: string,
  itemName: string,
  quantity: number,
  acquisitionCost: number,
  currentSystem: string,
  settings: ReturnType<typeof getTraderSettings>,
): Array<{ buyer: ReturnType<typeof mapStore.getAllBuyDemand>[0]; profit: number; jumps: number }> {
  const allBuys = mapStore.getAllBuyDemand();
  const buyers = allBuys
    .filter(b => b.itemId === itemId && b.price > 0 && b.quantity > 0)
    .filter(b => {
      // Only include buyers at POIs with a dockable station
      const sys = mapStore.getSystem(b.systemId);
      const poi = sys?.pois.find(p => p.id === b.poiId);
      return poi?.has_base ?? false;
    })
    .map(buyer => {
      const { jumps, cost: fuelCost } = estimateFuelCost(currentSystem, buyer.systemId, settings.fuelCostPerJump);
      if (jumps >= 999) return null;

      const sellQty = Math.min(quantity, buyer.quantity);
      if (sellQty <= 0) return null;

      // Calculate total profit: revenue - acquisition cost - fuel
      const revenue = buyer.price * sellQty;
      const totalCost = acquisitionCost + fuelCost;
      const profit = revenue - totalCost;

      if (profit <= 0) return null;

      return { buyer, profit, jumps };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort((a, b) => b.profit - a.profit);

  return buyers;
}

/**
 * Find sell routes for non-fuel items currently in the bot's cargo.
 * These have zero acquisition cost — all revenue is profit minus fuel.
 * Ranked highest since the trader already has the goods.
 * 
 * @param acquisitionCostPerUnit - Optional original purchase price. If provided,
 *   only routes that recover cost + profit are returned.
 */
function findCargoSellRoutes(
  ctx: RoutineContext,
  settings: ReturnType<typeof getTraderSettings>,
  currentSystem: string,
  acquisitionCostPerUnit?: number,
): TradeRoute[] {
  const { bot } = ctx;
  const routes: TradeRoute[] = [];

  const cargoItems = bot.inventory.filter(i => {
    if (i.quantity <= 0) return false;
    const lower = i.itemId.toLowerCase();
    return !lower.includes("fuel") && !lower.includes("energy_cell");
  });
  if (cargoItems.length === 0) return routes;

  const allBuys = mapStore.getAllBuyDemand();
  if (allBuys.length === 0) return routes;

  for (const item of cargoItems) {
    // Find best buyer at a dockable station (not at current station — we already tried selling here)
    const buyers = allBuys
      .filter(b => b.itemId === item.itemId && b.price > 0)
      .filter(b => !(b.systemId === currentSystem && b.poiId === bot.poi))
      .filter(b => {
        // Only include buyers at POIs with a dockable station
        const sys = mapStore.getSystem(b.systemId);
        const poi = sys?.pois.find(p => p.id === b.poiId);
        return poi?.has_base ?? false;
      })
      .sort((a, b) => b.price - a.price);

    for (const buy of buyers) {
      const { jumps, cost: fuelCost } = estimateFuelCost(currentSystem, buy.systemId, settings.fuelCostPerJump);
      if (jumps >= 999) continue;

      const sellQty = Math.min(item.quantity, buy.quantity);
      if (sellQty <= 0) continue;

      // Calculate profit: if acquisition cost is known, include it in the calculation
      const costBasis = acquisitionCostPerUnit ?? 0;
      const profitPerUnit = buy.price - costBasis - (jumps > 0 ? fuelCost / sellQty : 0);
      if (profitPerUnit <= 0) continue;

      routes.push({
        itemId: item.itemId,
        itemName: item.name,
        sourceSystem: currentSystem,
        sourcePoi: "cargo",       // signals: already in cargo
        sourcePoiName: "ship cargo",
        buyPrice: costBasis,      // original cost basis (0 if unknown)
        buyQty: sellQty,
        destSystem: buy.systemId,
        destPoi: buy.poiId,
        destPoiName: buy.poiName,
        sellPrice: buy.price,
        sellQty: sellQty,
        jumps,
        profitPerUnit,
        totalProfit: profitPerUnit * sellQty,
      });
      break; // best buyer for this item
    }
  }

  routes.sort((a, b) => b.totalProfit - a.totalProfit);
  return routes;
}

// ── Missions ─────────────────────────────────────────────────

/**
 * Complete any active missions that are ready, then accept new market/trade
 * missions at the current station (up to 2 per visit, respecting the 5-mission cap).
 * Must be docked.
 */
async function tryMissions(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;
  if (!bot.docked) return;

  // Try to complete active missions
  const activeResp = await bot.exec("get_active_missions");
  let activeMissionCount = 0;
  if (!activeResp.error && activeResp.result) {
    const ar = activeResp.result as Record<string, unknown>;
    const active = (
      Array.isArray(ar.missions) ? ar.missions :
      Array.isArray(ar) ? ar :
      []
    ) as Array<Record<string, unknown>>;
    activeMissionCount = active.length;

    for (const mission of active) {
      const missionId = (mission.mission_id as string) || (mission.id as string) || "";
      if (!missionId) continue;
      // Only try to complete missions marked as ready/completable
      const status = ((mission.status as string) || "").toLowerCase();
      if (status === "incomplete" || status === "in_progress") continue;
      const completeResp = await bot.exec("complete_mission", { mission_id: missionId });
      if (completeResp.error) {
        // Silently skip mission_incomplete — expected for in-progress missions
        if (completeResp.error.code === "mission_incomplete") continue;
      }
      if (!completeResp.error && completeResp.result) {
        const cr = completeResp.result as Record<string, unknown>;
        const earned = (cr.credits_earned as number) ?? 0;
        ctx.log("trade", `Mission complete! +${earned}cr`);
        activeMissionCount--;
        await bot.refreshStatus();
      }
    }
  }

  // Accept new market/trade missions (cap at 5 total active)
  if (activeMissionCount >= 5) return;

  const availResp = await bot.exec("get_missions");
  if (availResp.error || !availResp.result) return;

  const vr = availResp.result as Record<string, unknown>;
  const available = (
    Array.isArray(vr.missions) ? vr.missions :
    Array.isArray(vr) ? vr :
    []
  ) as Array<Record<string, unknown>>;

  let accepted = 0;
  for (const mission of available) {
    if (activeMissionCount + accepted >= 5 || accepted >= 2) break;

    const missionId = (mission.mission_id as string) || (mission.id as string) || "";
    const type = ((mission.type as string) || "").toLowerCase();
    const title = ((mission.title as string) || "").toLowerCase();

    const isTradeRelated =
      type === "market_participation" || type === "trade" || type === "delivery" ||
      title.includes("market") || title.includes("trade") ||
      title.includes("sell") || title.includes("buy") || title.includes("deliver");

    if (!isTradeRelated || !missionId) continue;

    const acceptResp = await bot.exec("accept_mission", { mission_id: missionId });
    if (!acceptResp.error) {
      ctx.log("trade", `Accepted mission: ${(mission.title as string) || missionId}`);
      accepted++;
    }
  }
}

// ── Trader routine ───────────────────────────────────────────

/**
 * Trader routine — travels between stations, buys items cheaply, sells at higher prices:
 *
 * 1. Dock at current station, refresh market data
 * 2. Scan mapStore for price spreads across known stations
 * 3. Pick best trade opportunity (highest total profit)
 * 4. Travel to source station, buy items
 * 5. Travel to destination station, sell items
 * 6. Refuel, repair, repeat
 */
export const traderRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  await bot.refreshStatus();
  const startSystem = bot.system;

  // Battle state tracking for continuous flee re-issuing
  const battleState: BattleState = {
    inBattle: false,
    battleId: null,
    battleStartTick: null,
    lastHitTick: null,
    isFleeing: false,
  };

  while (bot.state === "running") {
    // ── Death recovery ──
    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) { await ctx.sleep(30000); continue; }

    // ── Battle check ──
    // If we're already in battle from previous cycle, re-issue flee command
    if (battleState.inBattle) {
      ctx.log("combat", "Re-issuing flee stance during trade operations (ensuring we stay in flee mode)...");
      const fleeResp = await bot.exec("battle", { action: "stance", stance: "flee" });
      if (fleeResp.error) {
        ctx.log("error", `Flee re-issue failed: ${fleeResp.error.message}`);
      }

      // Check battle status to see if we've escaped
      // CRITICAL: Check WebSocket state FIRST (fastest, no API call)
      let battleCleared = !bot.isInBattle();
      
      // If WebSocket still shows in battle, verify via API
      if (!battleCleared) {
        const currentBattleStatus = await getBattleStatus(ctx);
        battleCleared = !currentBattleStatus || !currentBattleStatus.is_participant;
      }
      
      if (battleCleared) {
        ctx.log("combat", "Battle cleared - no longer in combat! Resuming trade operations...");
        battleState.inBattle = false;
        battleState.battleId = null;
        battleState.isFleeing = false;
      } else {
        // Still in battle - wait briefly and continue to next cycle to re-flee
        await ctx.sleep(2000);
        continue;
      }
    } else {
      // Not in battle - do a fresh check (WebSocket-first via checkAndFleeFromBattle)
      if (await checkAndFleeFromBattle(ctx, "trader")) {
        // Battle detected - set battle state and flee
        battleState.inBattle = true;
        battleState.isFleeing = false;
        await ctx.sleep(2000);
        continue;
      }
    }

    // ── Fleet coordination cleanup (periodic stale lock cleanup) ──
    const cleanedLocks = cleanupStaleLocks();
    if (cleanedLocks > 0) {
      ctx.log("trade", `Fleet coordination: cleaned up ${cleanedLocks} stale lock(s)`);
    }

    // ── Trade session recovery ──
    const activeSession = getActiveSession(bot.username);
    let recoveredSession: TradeSession | null = null;
    if (activeSession) {
      const settings = getTraderSettings(bot.username);
      recoveredSession = await recoverTradeSession(ctx, activeSession, settings);
      if (recoveredSession) {
        ctx.log("trade", `Resuming trade session: ${recoveredSession.itemName} (${recoveredSession.state})`);
      }
    }

    const settings = getTraderSettings(bot.username);
    const safetyOpts = {
      fuelThresholdPct: settings.refuelThreshold,
      hullThresholdPct: settings.repairThreshold,
      autoCloak: settings.autoCloak,
    };
    let extraRevenue = 0;
    let recoveredSessionHandled = false; // Track if we've handled a recovered session
    let route: TradeRoute | null = null; // Declare route early for recovered session handler
    let buyQty = 0;
    let investedCredits = 0;

    // ── Handle recovered session ──
    // If we have a recovered session that's in transit, skip dock/maintenance and go directly to destination
    if (recoveredSession && (recoveredSession.state === "in_transit" || recoveredSession.state === "at_destination")) {
      ctx.log("trade", `Recovered session is ${recoveredSession.state} — proceeding directly to destination`);
      
      // Quick fuel check only if we're at a station
      if (bot.docked) {
        await tryRefuel(ctx);
      }
      
      // Skip to travel phase - set up route for immediate execution
      route = {
        itemId: recoveredSession.itemId,
        itemName: recoveredSession.itemName,
        sourceSystem: recoveredSession.sourceSystem,
        sourcePoi: recoveredSession.sourcePoi,
        sourcePoiName: recoveredSession.sourcePoiName,
        buyPrice: recoveredSession.buyPricePerUnit,
        buyQty: recoveredSession.quantityBought,
        destSystem: recoveredSession.destSystem,
        destPoi: recoveredSession.destPoi,
        destPoiName: recoveredSession.destPoiName,
        sellPrice: recoveredSession.sellPricePerUnit,
        sellQty: recoveredSession.sellQuantity,
        jumps: recoveredSession.totalJumps - recoveredSession.jumpsCompleted,
        profitPerUnit: recoveredSession.expectedProfit / recoveredSession.sellQuantity,
        totalProfit: recoveredSession.expectedProfit,
      };
      buyQty = recoveredSession.quantityBought;
      investedCredits = recoveredSession.investedCredits;
      recoveredSessionHandled = true;
      
      // Skip dock/maintenance/cargo-sell and go straight to travel
      await ensureUndocked(ctx);
      const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
      if (!fueled) {
        ctx.log("error", "Cannot refuel for recovered session — will retry next cycle");
        await ctx.sleep(30000);
        continue;
      }
      
      // Jump directly to destination
      ctx.log("travel", `Resuming route to ${recoveredSession.destPoiName}...`);
      const arrived = await navigateToSystem(ctx, recoveredSession.destSystem, {
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
      bot.system = recoveredSession.destSystem;

      // Travel to destination POI and dock
      if (bot.poi !== recoveredSession.destPoi) {
        ctx.log("travel", `Traveling to ${recoveredSession.destPoiName}...`);
        const travelResp = await bot.exec("travel", { target_poi: recoveredSession.destPoi });
        if (await checkBattleAfterCommand(ctx, travelResp.notifications, "travel", battleState)) {
          ctx.log("combat", "Battle detected during travel — fleeing!");
          await ctx.sleep(2000);
          continue;
        }
        // CRITICAL: Check for battle interrupt error
        if (travelResp.error) {
          const errMsg = travelResp.error.message.toLowerCase();
          if (travelResp.error.code === "battle_interrupt" || errMsg.includes("interrupted by battle") || errMsg.includes("interrupted by combat")) {
            ctx.log("combat", `Travel interrupted by battle! ${travelResp.error.message} - fleeing!`);
            await fleeFromBattle(ctx);
            await ctx.sleep(5000);
            continue;
          }
        }
        bot.poi = recoveredSession.destPoi;
      }

      const dockResp = await bot.exec("dock");
      if (await checkBattleAfterCommand(ctx, dockResp.notifications, "dock", battleState)) {
        ctx.log("combat", "Battle detected during dock — fleeing!");
        await ctx.sleep(2000);
        continue;
      }
      if (dockResp.error && !dockResp.error.message.includes("already")) {
        ctx.log("error", `Dock failed at destination: ${dockResp.error.message} — finding alternative buyer`);
        // Destination has no station - find alternative buyer with a dockable station
        const allBuys = mapStore.getAllBuyDemand();
        const alternativeBuyers = allBuys
          .filter(b => b.itemId === recoveredSession.itemId && b.price > 0)
          .map(b => {
            const sys = mapStore.getSystem(b.systemId);
            const poi = sys?.pois.find(p => p.id === b.poiId);
            const hasStation = poi?.has_base ?? false;
            return { buyer: b, hasStation };
          })
          .filter(({ hasStation }) => hasStation)
          .sort((a, b) => b.buyer.price - a.buyer.price);

        if (alternativeBuyers.length === 0) {
          ctx.log("error", "No alternative buyers found — abandoning session");
          await failTradeSessionWithLockRelease(recoveredSession.botUsername, "No station at destination");
          recoveredSessionHandled = true; // Mark as handled to prevent re-recovery
          await ensureDocked(ctx);
          await ctx.sleep(60000);
          continue;
        }

        const bestAlt = alternativeBuyers[0].buyer;
        ctx.log("trade", `New destination: ${bestAlt.poiName} in ${bestAlt.systemId} (${bestAlt.price}cr/ea)`);
        await updateTradeSession(bot.username, {
          destSystem: bestAlt.systemId,
          destPoi: bestAlt.poiId,
          destPoiName: bestAlt.poiName,
          sellPricePerUnit: bestAlt.price,
          sellQuantity: Math.min(recoveredSession.sellQuantity, bestAlt.quantity),
          state: "in_transit",
          notes: (recoveredSession.notes || "") + ` | Rerouted from ${recoveredSession.destPoiName} (no station) to ${bestAlt.poiName}`,
        });
        // Don't mark as handled - let the normal route selection pick it up
        recoveredSessionHandled = false;
        await ensureDocked(ctx);
        continue; // Restart the loop with the updated session
      }
      bot.docked = true;
      ctx.log("trade", "Arrived at destination — proceeding to sell trade items");

      // Mark as handled and skip remaining setup phases
      recoveredSessionHandled = true;
      // route, buyQty, investedCredits already set - will proceed to sell phase
    }

    // ── Ensure docked (also records market data + analyzes market) ──
    yield "dock";
    await ensureDocked(ctx);
    if (bot.docked) {
      await tryMissions(ctx);
    }

    // ── Fuel + hull check + mods ──
    yield "maintenance";
    await tryRefuel(ctx);
    await repairShip(ctx);
    const modProfile = getModProfile("trader");
    if (modProfile.length > 0) await ensureModsFitted(ctx, modProfile);

    // ── Priority 1: Handle leftover cargo items ──
    // Instead of auto-selling at random stations, we:
    // 1. Check if current station has good buy orders
    // 2. If yes, sell here
    // 3. If no, travel home and deposit to faction storage for later sale
    // This handles: corrupt session data, human-placed trade items, failed trades
    // IMPORTANT: Skip items that are part of an active/recovered trade session!
    yield "handle_cargo";
    await bot.refreshStatus();
    await bot.refreshCargo();

    // Get the active trade session to protect those items
    // (activeSession already declared above for recovery check)
    const protectedItemId = activeSession?.itemId || recoveredSession?.itemId;

    if (protectedItemId) {
      ctx.log("trade", `Protecting trade session item: ${protectedItemId} (not selling in cargo phase)`);
    }

    // Track items sold locally so we don't plan routes to sell them here again
    const soldLocallyIds = new Set<string>();
    
    const cargoItems = bot.inventory.filter(i => {
      if (i.quantity <= 0) return false;
      const lower = i.itemId.toLowerCase();
      if (lower.includes("fuel") || lower.includes("energy_cell")) return false;
      // PROTECT trade session items - don't sell them in this phase!
      if (protectedItemId && i.itemId === protectedItemId) {
        ctx.log("trade", `Skipping ${i.quantity}x ${i.name} - part of active trade session`);
        return false;
      }
      return true;
    });

    if (cargoItems.length > 0 && bot.docked) {
      const allBuys = mapStore.getAllBuyDemand();
      const homeSystem = settings.homeSystem || startSystem;
      const itemsToDeposit: Array<{ itemId: string; name: string; quantity: number }> = [];
      const itemsToSell: Array<{ itemId: string; name: string; quantity: number; price: number }> = [];
      const soldLocallyIds = new Set<string>(); // Track items sold at current station

      for (const item of cargoItems) {
        // Find best buy order for this item
        const buyers = allBuys
          .filter(b => b.itemId === item.itemId && b.price > 0 && b.quantity > 0)
          .sort((a, b) => b.price - a.price);

        if (buyers.length === 0) {
          // No buyers at all - deposit to faction storage
          itemsToDeposit.push(item);
          continue;
        }

        const bestBuyer = buyers[0];
        const isCurrentStation = bestBuyer.systemId === bot.system && bestBuyer.poiId === bot.poi;
        
        // Get average market price for this item across all known stations
        const allBuysForItem = allBuys.filter(b => b.itemId === item.itemId && b.price > 0);
        const avgPrice = allBuysForItem.length > 0 
          ? allBuysForItem.reduce((sum, b) => sum + b.price, 0) / allBuysForItem.length 
          : 0;
        const priceRatio = avgPrice > 0 ? bestBuyer.price / avgPrice : 0;
        
        // Consider price "good" if it's >= 80% of average buy price across all stations
        // OR if it's the best price available (we're already at the best station)
        const isBestPrice = !buyers.some(b => b.systemId !== bot.system || b.poiId !== bot.poi);
        const isGoodPrice = priceRatio >= 0.8 || isBestPrice || isCurrentStation;

        if (isGoodPrice) {
          // Sell at current station
          itemsToSell.push({
            itemId: item.itemId,
            name: item.name,
            quantity: item.quantity,
            price: bestBuyer.price,
          });
        } else {
          // Price is too low - deposit to faction storage
          itemsToDeposit.push(item);
        }
      }

      // Sell items with good prices
      if (itemsToSell.length > 0) {
        const cargoSellCreditsBefore = bot.credits;
        const soldHere: string[] = [];

        for (const item of itemsToSell) {
          const sResp = await bot.exec("sell", { item_id: item.itemId, quantity: item.quantity });
          if (!sResp.error) {
            soldHere.push(`${item.quantity}x ${item.name} @ ${item.price}cr`);
            soldLocallyIds.add(item.itemId);
          } else {
            // Sell failed - add to deposit list
            itemsToDeposit.push({ itemId: item.itemId, name: item.name, quantity: item.quantity });
          }
        }

        if (soldHere.length > 0) {
          await bot.refreshCargo();
          await bot.refreshStatus();
          const cargoSellRevenue = Math.max(0, bot.credits - cargoSellCreditsBefore);
          ctx.log("trade", `Sold cargo: ${soldHere.join(", ")} — earned ${cargoSellRevenue}cr`);
          extraRevenue += cargoSellRevenue;
          await recordMarketData(ctx);
        }
      }

      // Deposit items with no good price to faction storage
      if (itemsToDeposit.length > 0) {
        // Check if bot is in a faction
        if (!bot.faction) {
          ctx.log("trade", `Not in a faction — keeping ${itemsToDeposit.length} item(s) in cargo for later sale`);
          // Keep items in cargo - they'll be sold when a profitable route is found
        } else if (bot.system !== homeSystem) {
          ctx.log("trade", `Depositing ${itemsToDeposit.length} item(s) to faction storage — traveling to home system ${homeSystem}...`);
          await ensureUndocked(ctx);
          const fueled = await ensureFueled(ctx, settings.refuelThreshold);
          if (fueled) {
            const arrived = await navigateToSystem(ctx, homeSystem, {
              fuelThresholdPct: settings.refuelThreshold,
              hullThresholdPct: settings.repairThreshold,
              autoCloak: settings.autoCloak,
            });
            if (arrived) {
              // Find station at home
              const { pois } = await getSystemInfo(ctx);
              const homeStation = findStation(pois);
              if (homeStation) {
                const travelResp = await bot.exec("travel", { target_poi: homeStation.id });
                if (await checkBattleAfterCommand(ctx, travelResp.notifications, "travel", battleState)) {
                  ctx.log("combat", "Battle detected during travel — fleeing!");
                  await ctx.sleep(2000);
                  continue;
                }
                // CRITICAL: Check for battle interrupt error
                if (travelResp.error) {
                  const errMsg = travelResp.error.message.toLowerCase();
                  if (travelResp.error.code === "battle_interrupt" || errMsg.includes("interrupted by battle") || errMsg.includes("interrupted by combat")) {
                    ctx.log("combat", `Travel interrupted by battle! ${travelResp.error.message} - fleeing!`);
                    await fleeFromBattle(ctx);
                    await ctx.sleep(5000);
                    continue;
                  }
                }
                await ensureDocked(ctx);
              }
            }
          }
        }

        // Deposit items to faction storage (only if in a faction and docked)
        if (bot.faction && bot.docked) {
          const deposited: string[] = [];
          for (const item of itemsToDeposit) {
            const dResp = await bot.exec("faction_deposit_items", { item_id: item.itemId, quantity: item.quantity });
            if (!dResp.error) {
              deposited.push(`${item.quantity}x ${item.name}`);
              logFactionActivity(ctx, "deposit", `Deposited ${item.quantity}x ${item.name} from cargo (no good sell price found)`);
            }
          }
          if (deposited.length > 0) {
            ctx.log("trade", `Deposited to faction storage: ${deposited.join(", ")}`);
          }
        }
      }
    }

    await bot.refreshStatus();

    // ── Priority 2: Sell station storage items at current market ──
    if (bot.docked) {
      // Sell station storage items that this market buys
      await bot.refreshStatus();
      const storageSellCredits = bot.credits;
      await bot.refreshStorage();
      if (bot.storage.length > 0) {
        const marketResp = await bot.exec("view_market");
        if (marketResp.result && typeof marketResp.result === "object") {
          const md = marketResp.result as Record<string, unknown>;
          const listings = (
            Array.isArray(md) ? md :
            Array.isArray(md.items) ? md.items :
            Array.isArray(md.listings) ? md.listings : []
          ) as Array<Record<string, unknown>>;
          const buyableHere = new Set(
            listings.filter(l => ((l.buy_price as number) || 0) > 0).map(l => l.item_id as string)
          );

          const soldFromStorage: string[] = [];
          for (const item of bot.storage) {
            if (item.quantity <= 0) continue;
            const lower = item.itemId.toLowerCase();
            if (lower.includes("fuel") || lower.includes("energy_cell")) continue;
            if (!buyableHere.has(item.itemId)) continue;

            // Withdraw and sell
            await bot.refreshStatus();
            const freeSpace = getFreeSpace(bot);
            if (freeSpace <= 0) break;
            const qty = Math.min(item.quantity, maxItemsForCargo(freeSpace, item.itemId));
            if (qty <= 0) continue;
            const wResp = await bot.exec("withdraw_items", { item_id: item.itemId, quantity: qty });
            if (wResp.error) continue;
            const sResp = await bot.exec("sell", { item_id: item.itemId, quantity: qty });
            if (!sResp.error) {
              soldFromStorage.push(`${qty}x ${item.name}`);
            } else {
              await bot.exec("deposit_items", { item_id: item.itemId, quantity: qty });
            }
          }
          await bot.refreshStatus();
          const storageRevenue = Math.max(0, bot.credits - storageSellCredits);
          if (soldFromStorage.length > 0) {
            ctx.log("trade", `Sold from station storage: ${soldFromStorage.join(", ")} — earned ${storageRevenue}cr`);
          }
          extraRevenue += storageRevenue;
        }
      }
    }

    // ── Priority 3: Find new trade opportunities ──
    // Skip route finding if we've already handled a recovered session (route is already set)
    yield "find_trades";
    let routes: TradeRoute[] = [];
    let allRoutesCount = 0;
    let affordableRoutesCount = 0;

    if (!recoveredSessionHandled) {
      await bot.refreshStatus();
      await bot.refreshCargo();
      // Subtract fuel cell weight from cargo capacity so route planning doesn't over-buy
      let fuelCellWeight = 0;
      for (const item of bot.inventory) {
        const lower = item.itemId.toLowerCase();
        if (lower.includes("fuel") || lower.includes("energy_cell")) {
          fuelCellWeight += item.quantity * getItemSize(item.itemId);
        }
      }
      const cargoCapacity = Math.max(0, (bot.cargoMax > 0 ? bot.cargoMax : 50) - fuelCellWeight);
      const cargoRoutes = findCargoSellRoutes(ctx, settings, bot.system);
      const marketRoutes = findTradeOpportunities(settings, bot.system, cargoCapacity);
      // Filter out routes that sell items we just sold at the current station (demand already filled)
      const currentPoi = bot.poi;
      let allRoutes = [...cargoRoutes, ...marketRoutes].filter(r => {
        if (soldLocallyIds.has(r.itemId) && r.destSystem === bot.system && r.destPoi === currentPoi) return false;
        return true;
      });
      allRoutesCount = allRoutes.length;

      // Filter out routes where bot can't afford even 1 unit (will try again with cheaper items next scan)
      const affordableRoutes = allRoutes.filter(r => bot.credits >= r.buyPrice);
      affordableRoutesCount = affordableRoutes.length;
      if (affordableRoutes.length < allRoutes.length) {
        const skipped = allRoutes.length - affordableRoutes.length;
        ctx.log("trade", `Skipping ${skipped} route(s) — item(s) too expensive for current budget (${bot.credits}cr)`);
      }
      allRoutes = affordableRoutes;
      
      // Cargo routes first (already have the goods), then by profit
      routes = allRoutes.sort((a, b) => {
        // Cargo routes get priority — sort them first, then by profit
        const aIsCargo = a.sourcePoi === "cargo" ? 1 : 0;
        const bIsCargo = b.sourcePoi === "cargo" ? 1 : 0;
        if (aIsCargo !== bIsCargo) return bIsCargo - aIsCargo;
        return b.totalProfit - a.totalProfit;
      });

      const routeCounts = [
        cargoRoutes.length > 0 ? `${cargoRoutes.length} cargo` : "",
        `${marketRoutes.length} market`,
      ].filter(Boolean).join(" + ");
      if (cargoRoutes.length > 0) {
        ctx.log("trade", `Found ${routeCounts} routes`);
      }

      // Station priority: put routes whose destination is the home station first
      if (settings.stationPriority && settings.homeSystem) {
        const homeStation = mapStore.findNearestStation(settings.homeSystem);
        if (homeStation) {
          const homeRoutes = routes.filter(r => r.destSystem === settings.homeSystem && r.destPoi === homeStation.id);
          const otherRoutes = routes.filter(r => !(r.destSystem === settings.homeSystem && r.destPoi === homeStation.id));
          if (homeRoutes.length > 0) {
            routes = [...homeRoutes, ...otherRoutes];
            ctx.log("trade", `Station priority: ${homeRoutes.length} route(s) to home station`);
          }
        }
      }

      // Fleet coordination: filter out routes locked by other traders
      const coordinationResult = getBestUnlockedRoute(routes, bot.username, cargoCapacity);
      if (coordinationResult.lockedBy && coordinationResult.lockedBy !== bot.username) {
        ctx.log("trade", `Route coordination: ${coordinationResult.reason} — ${coordinationResult.lockedBy} is trading ${routes[0].itemName}`);
      } else if (coordinationResult.route) {
        ctx.log("trade", `Route coordination: ${coordinationResult.reason}`);
      }

      // Filter routes based on coordination
      if (coordinationResult.route) {
        // Find the selected route in our list and prioritize it
        const selectedRoute = coordinationResult.route;
        routes = [selectedRoute, ...routes.filter(r => r !== selectedRoute)];
      } else {
        // No routes available due to locks - clear routes array
        routes = [];
      }
    }

    if (routes.length === 0 && !recoveredSessionHandled) {
      // No routes found and no recovered session to handle
      if (allRoutesCount > 0 && affordableRoutesCount === 0) {
        ctx.log("trade", `No affordable routes found (budget: ${bot.credits}cr) — waiting 60s for more market data or consider earning credits via missions`);
      } else {
        ctx.log("trade", "No profitable trade routes found — waiting 60s before re-scanning");
      }
      await ctx.sleep(60000);
      continue;
    }

    // If we have a recovered session that wasn't handled yet, convert it to a route and execute
    const failedSources = new Set<string>();
    let attempts = 0;
    let pendingLockItemId: string | null = null; // Track lock acquired during route selection
    let pendingLockReleased = false; // Track if pending lock was released

    if (recoveredSession && !recoveredSessionHandled) {
      ctx.log("trade", `Executing recovered session: ${recoveredSession.itemName} (${recoveredSession.quantityBought}x @ ${recoveredSession.buyPricePerUnit}cr → ${recoveredSession.destPoiName})`);
      
      // Convert recovered session to a route
      route = {
        itemId: recoveredSession.itemId,
        itemName: recoveredSession.itemName,
        sourceSystem: recoveredSession.sourceSystem,
        sourcePoi: recoveredSession.sourcePoi,
        sourcePoiName: recoveredSession.sourcePoiName,
        buyPrice: recoveredSession.buyPricePerUnit,
        buyQty: recoveredSession.quantityBought,
        destSystem: recoveredSession.destSystem,
        destPoi: recoveredSession.destPoi,
        destPoiName: recoveredSession.destPoiName,
        sellPrice: recoveredSession.sellPricePerUnit,
        sellQty: recoveredSession.sellQuantity,
        jumps: recoveredSession.totalJumps - recoveredSession.jumpsCompleted,
        profitPerUnit: recoveredSession.expectedProfit / recoveredSession.sellQuantity,
        totalProfit: recoveredSession.expectedProfit,
      };
      
      buyQty = recoveredSession.quantityBought;
      investedCredits = recoveredSession.investedCredits;
      
      // Update session state based on current position
      if (bot.system === recoveredSession.destSystem) {
        await updateTradeSession(bot.username, { state: "at_destination" });
      } else if (recoveredSession.jumpsCompleted > 0) {
        await updateTradeSession(bot.username, { state: "in_transit" });
      }
    }

    // Try up to 3 routes — skip stale/unavailable ones (skip if we've already handled a recovered session)
    if (!recoveredSessionHandled) {
      for (let ri = 0; ri < routes.length && attempts < 3; ri++) {
      if (bot.state !== "running") break;
      const candidate = routes[ri];

      // Skip routes with same source+item as a previous failure
      const sourceKey = `${candidate.sourceSystem}:${candidate.sourcePoi}:${candidate.itemId}`;
      if (failedSources.has(sourceKey)) continue;
      attempts++;
      const isCargoRoute = candidate.sourcePoi === "cargo";

      if (isCargoRoute) {
        ctx.log("trade", `Route #${ri + 1}: ${candidate.itemName} — sell ${candidate.buyQty}x from cargo → ${candidate.destPoiName} (${candidate.sellPrice}cr/ea) — est. profit ${Math.round(candidate.totalProfit)}cr (${candidate.jumps} jumps)`);
      } else {
        ctx.log("trade", `Route #${ri + 1}: ${candidate.itemName} — buy ${candidate.buyQty}x at ${candidate.sourcePoiName} (${candidate.buyPrice}cr) → sell at ${candidate.destPoiName} (${candidate.sellPrice}cr) — est. profit ${Math.round(candidate.totalProfit)}cr (${candidate.jumps} jumps)`);
      }

      // ── Cargo route: items already in cargo — just need to travel and sell ──
      if (isCargoRoute) {
        await bot.refreshCargo();
        const inCargo = bot.inventory.find(i => i.itemId === candidate.itemId)?.quantity ?? 0;
        if (inCargo <= 0) {
          ctx.log("trade", `${candidate.itemName} no longer in cargo — trying next route`);
          continue;
        }
        route = candidate;
        buyQty = Math.min(inCargo, candidate.buyQty);
        investedCredits = 0; // already have the items
        ctx.log("trade", `Selling ${buyQty}x ${candidate.itemName} from cargo`);
        break;
      }

      // ── Normal market route: travel to source and buy ──
      // Acquire tentative lock BEFORE traveling to prevent other bots from taking same route
      const tentativeLockId = `${candidate.sourceSystem}:${candidate.sourcePoi}:${candidate.itemId}`;
      const lockAcquired = acquireTradeLock({
        botUsername: bot.username,
        itemId: candidate.itemId,
        itemName: candidate.itemName,
        sourceSystem: candidate.sourceSystem,
        sourcePoi: candidate.sourcePoi,
        destSystem: candidate.destSystem,
        destPoi: candidate.destPoi,
        quantityCommitted: candidate.buyQty,
        sessionId: `${bot.username}_pending_${Date.now()}`,
      });
      
      if (!lockAcquired) {
        ctx.log("trade", `Route locked by another bot — skipping ${candidate.itemName}`);
        failedSources.add(sourceKey);
        continue;
      }
      
      // Track the lock so we can release it if route fails
      pendingLockItemId = candidate.itemId;
      pendingLockReleased = false; // Reset for this route attempt

      ctx.log("trade", `Fleet lock acquired: ${candidate.itemName} (${candidate.sourceSystem} → ${candidate.destSystem})`);

      // Check affordability BEFORE traveling — include faction withdrawal fallback
      const affordability = await canAffordRoute(ctx, candidate, settings);

      const totalCost = candidate.buyPrice * candidate.buyQty;
      const maxAffordableWithStorage = affordability.maxAffordableQty;
      const maxAffordableOwnCredits = Math.floor(bot.credits / candidate.buyPrice);

      // Can't afford even a single unit with all available credits — skip
      if (maxAffordableWithStorage <= 0) {
        ctx.log("trade", `Cannot afford route: need ${totalCost}cr for ${candidate.buyQty}x, have ${bot.credits}cr (storage: ${affordability.withdrawalNeeded > 0 ? 'insufficient' : 'empty'}) — skipping`);
        releaseTradeLock(bot.username, candidate.itemId, "skipped:cannot_afford");
        pendingLockItemId = null;
        pendingLockReleased = true;
        failedSources.add(sourceKey);
        continue;
      }

      // Determine the actual quantity we can afford and should buy
      let targetQty = candidate.buyQty;
      let needsWithdrawal = false;

      if (maxAffordableOwnCredits <= 0) {
        // Can't afford any with own credits — need withdrawal
        if (!affordability.canAffordWithWithdrawal) {
          // Storage also can't help — skip
          ctx.log("trade", `Cannot afford route: need ${totalCost}cr for ${candidate.buyQty}x, have ${bot.credits}cr (storage empty) — skipping`);
          releaseTradeLock(bot.username, candidate.itemId, "skipped:cannot_afford");
          pendingLockItemId = null;
          pendingLockReleased = true;
          failedSources.add(sourceKey);
          continue;
        }
        // Use storage to fund the route
        targetQty = Math.min(maxAffordableWithStorage, candidate.buyQty);
        needsWithdrawal = true;
      } else if (maxAffordableOwnCredits < candidate.buyQty) {
        // Can afford some with own credits — adjust quantity (no withdrawal needed)
        targetQty = maxAffordableOwnCredits;
        ctx.log("trade", `Can only afford ${targetQty}/${candidate.buyQty}x with current credits — adjusting route`);
      } else if (!affordability.canAfford && affordability.canAffordWithWithdrawal) {
        // Can afford with storage help — use storage to get full quantity
        targetQty = Math.min(maxAffordableWithStorage, candidate.buyQty);
        needsWithdrawal = true;
      }

      // Adjust the route quantity if needed
      if (targetQty < candidate.buyQty) {
        ctx.log("trade", `Adjusted route: ${targetQty}/${candidate.buyQty}x ${candidate.itemName} (affordable quantity)`);
        const adjustedProfitPerUnit = candidate.profitPerUnit;
        candidate.buyQty = targetQty;
        candidate.sellQty = targetQty;
        candidate.totalProfit = adjustedProfitPerUnit * targetQty;
      }

      // Withdraw from storage if needed
      if (needsWithdrawal) {
        const adjustedCost = candidate.buyPrice * candidate.buyQty;
        const withdrawalNeeded = Math.max(0, adjustedCost - bot.credits);
        if (withdrawalNeeded > 0) {
          ctx.log("trade", `Need ${withdrawalNeeded}cr from faction storage`);
          const withdrew = await withdrawCreditsForTrade(ctx, candidate, settings);
          if (!withdrew) {
            ctx.log("error", "Failed to withdraw credits from faction storage — skipping route");
            releaseTradeLock(bot.username, candidate.itemId, "aborted:withdraw_failed");
            pendingLockItemId = null;
            pendingLockReleased = true;
            failedSources.add(sourceKey);
            continue;
          }
        }
      }

      yield "travel_to_source";

      if (bot.system !== candidate.sourceSystem) {
        await ensureUndocked(ctx);
        const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
        if (!fueled) {
          ctx.log("error", "Cannot refuel for trade run — waiting 30s");
          releaseTradeLock(bot.username, candidate.itemId, "aborted:cannot_refuel");
          pendingLockItemId = null;
          pendingLockReleased = true;
          await ctx.sleep(30000);
          break;
        }

        ctx.log("travel", `Heading to ${candidate.sourcePoiName} in ${candidate.sourceSystem}...`);
        const arrived = await navigateToSystem(ctx, candidate.sourceSystem, safetyOpts);
        if (!arrived) {
          ctx.log("error", "Failed to reach source system — trying next route");
          releaseTradeLock(bot.username, candidate.itemId, "aborted:travel_failed");
          pendingLockItemId = null;
          pendingLockReleased = true;
          continue;
        }
      }

      // Only undock/travel if we need to move to a different POI
      if (bot.poi !== candidate.sourcePoi) {
        await ensureUndocked(ctx);
        ctx.log("travel", `Traveling to ${candidate.sourcePoiName}...`);
        const tResp = await bot.exec("travel", { target_poi: candidate.sourcePoi });
        if (await checkBattleAfterCommand(ctx, tResp.notifications, "travel", battleState)) {
          ctx.log("combat", "Battle detected during travel — fleeing!");
          await ctx.sleep(2000);
          continue;
        }
        // CRITICAL: Check for battle interrupt error
        if (tResp.error) {
          const errMsg = tResp.error.message.toLowerCase();
          if (tResp.error.code === "battle_interrupt" || errMsg.includes("interrupted by battle") || errMsg.includes("interrupted by combat")) {
            ctx.log("combat", `Travel interrupted by battle! ${tResp.error.message} - fleeing!`);
            await fleeFromBattle(ctx);
            await ctx.sleep(5000);
            continue;
          }
        }
        if (tResp.error && !tResp.error.message.includes("already")) {
          ctx.log("error", `Travel to source failed: ${tResp.error.message}`);
          releaseTradeLock(bot.username, candidate.itemId, "aborted:travel_failed");
          pendingLockItemId = null;
          pendingLockReleased = true;
          continue;
        }
        bot.poi = candidate.sourcePoi;
      }

      // Dock at source (may already be docked if source = current station)
      yield "dock_source";
      await ensureDocked(ctx);
      bot.docked = true;

      // Withdraw credits from storage only if below working balance
      await bot.refreshStorage();
      const storageResp = await bot.exec("view_storage");
      if (storageResp.result && typeof storageResp.result === "object") {
        const sr = storageResp.result as Record<string, unknown>;
        const storedCredits = (sr.credits as number) || (sr.stored_credits as number) || 0;
        if (storedCredits > 0 && bot.credits < TRADER_WORKING_BALANCE) {
          // Only withdraw what's needed to reach working balance
          const needed = Math.min(storedCredits, TRADER_WORKING_BALANCE - bot.credits);
          if (needed > 0) {
            await bot.exec("withdraw_credits", { amount: needed });
            ctx.log("trade", `Withdrew ${needed} credits from storage (working balance: ${bot.credits + needed}cr)`);
          }
        }
      }

      // Record fresh market data at source and accept missions here too
      await recordMarketData(ctx);
      await tryMissions(ctx);

      // Verify item is actually available via estimate_purchase
      yield "verify_availability";
      const estResp = await bot.exec("estimate_purchase", { item_id: candidate.itemId, quantity: 1 });
      if (estResp.error) {
        failedSources.add(sourceKey);
        mapStore.removeMarketItem(candidate.sourceSystem, candidate.sourcePoi, candidate.itemId);
        ctx.log("trade", `${candidate.itemName} not available at ${candidate.sourcePoiName} (stale data) — trying next route`);
        releaseTradeLock(bot.username, candidate.itemId, "aborted:item_not_available");
        pendingLockItemId = null;
        pendingLockReleased = true;
        continue;
      }

      // Emergency fuel reserve — ship starts fully fueled, ensureFueled docks at
      // stations along the route. Cells are only for systems with no station.
      // ~1 cell per 4 jumps is plenty, min 3, max 10% of cargo.
      const maxFuelSlots = bot.cargoMax > 0 ? Math.max(3, Math.floor(bot.cargoMax * 0.1)) : 5;
      const RESERVE_FUEL_CELLS = Math.min(Math.max(3, Math.ceil(candidate.jumps / 4)), maxFuelSlots);

      // Clear cargo: keep fuel cells + trade item, deposit everything else
      await bot.refreshCargo();
      const depositSummary: string[] = [];
      for (const item of [...bot.inventory]) {
        if (item.itemId === candidate.itemId) continue; // keep the item we're about to buy
        const lower = item.itemId.toLowerCase();
        const isFuel = lower.includes("fuel") || lower.includes("energy_cell");
        if (isFuel) {
          const excess = item.quantity - RESERVE_FUEL_CELLS;
          if (excess > 0) {
            await bot.exec("deposit_items", { item_id: item.itemId, quantity: excess });
            depositSummary.push(`${excess}x ${item.name}`);
          }
        } else {
          await bot.exec("deposit_items", { item_id: item.itemId, quantity: item.quantity });
          depositSummary.push(`${item.quantity}x ${item.name}`);
        }
      }
      if (depositSummary.length > 0) {
        ctx.log("trade", `Cleared cargo: ${depositSummary.join(", ")}`);
      }

      // Ensure we have enough fuel cells for the route
      await bot.refreshCargo();
      await bot.refreshStatus();
      let fuelInCargo = 0;
      for (const item of bot.inventory) {
        const lower = item.itemId.toLowerCase();
        if (lower.includes("fuel") || lower.includes("energy_cell")) fuelInCargo += item.quantity;
      }
      if (fuelInCargo < RESERVE_FUEL_CELLS) {
        const freeSpace = getFreeSpace(bot);
        const needed = Math.min(RESERVE_FUEL_CELLS - fuelInCargo, maxItemsForCargo(freeSpace, "fuel_cell"));
        if (needed > 0) {
          ctx.log("trade", `Buying ${needed} fuel cells for ${candidate.jumps}-jump route...`);
          await bot.exec("buy", { item_id: "fuel_cell", quantity: needed });
        }
      }

      // Check if we already have the trade item in cargo (kept during clear)
      await bot.refreshCargo();
      const existingInCargo = bot.inventory.find(i => i.itemId === candidate.itemId);
      const alreadyHave = existingInCargo?.quantity ?? 0;

      // Determine buy quantity
      await bot.refreshStatus();
      const freeSpace = getFreeSpace(bot);
      let qty = Math.min(candidate.buyQty - alreadyHave, maxItemsForCargo(freeSpace, candidate.itemId));
      if (settings.maxCargoValue > 0) {
        qty = Math.min(qty, Math.floor(settings.maxCargoValue / candidate.buyPrice));
      }
      if (qty > 0) {
        qty = Math.min(qty, Math.floor(bot.credits / candidate.buyPrice));
      }

      // Pre-buy validation: check actual available stock and real item cost
      if (qty > 0) {
        const estCheck = await bot.exec("estimate_purchase", { item_id: candidate.itemId, quantity: qty });
        if (!estCheck.error && estCheck.result && typeof estCheck.result === "object") {
          const est = estCheck.result as Record<string, unknown>;
          // Cap to available stock
          const avail = (est.available_quantity as number) || (est.available as number) || (est.max_quantity as number) || 0;
          if (avail > 0 && avail < qty) {
            ctx.log("trade", `Market only has ${avail}x available (wanted ${qty}) — adjusting`);
            qty = avail;
          }
          // Cap by actual total cost (API may charge different from cached price)
          const totalCost = (est.total_cost as number) || (est.total as number) || (est.cost as number) || 0;
          if (totalCost > 0 && totalCost > bot.credits - 500) {
            const affordQty = Math.max(0, Math.floor(qty * ((bot.credits - 500) / totalCost)));
            if (affordQty < qty) {
              ctx.log("trade", `Actual cost ${totalCost}cr exceeds budget — reducing to ${affordQty}x`);
              qty = affordQty;
            }
          }
          // Derive actual item weight from estimate if possible (total_weight / qty)
          const totalWeight = (est.total_weight as number) || (est.cargo_required as number) || (est.weight as number) || 0;
          if (totalWeight > 0 && qty > 0) {
            const realItemWeight = totalWeight / qty;
            const fitsInCargo = Math.floor(freeSpace / realItemWeight);
            if (fitsInCargo < qty) {
              ctx.log("trade", `Cargo can fit ${fitsInCargo}x at ${realItemWeight} weight/ea (not ${qty}) — adjusting`);
              qty = fitsInCargo;
            }
          }
        }
      }

      if (qty <= 0 && alreadyHave <= 0) {
        ctx.log("trade", "Cannot afford any items or cargo full — trying next route");
        releaseTradeLock(bot.username, candidate.itemId, "aborted:cannot_afford");
        pendingLockItemId = null;
        pendingLockReleased = true;
        continue;
      }

      // Buy items (skip if we already have enough)
      yield "buy";
      const creditsBefore = bot.credits;
      if (qty > 0) {
        ctx.log("trade", `Buying ${qty}x ${candidate.itemName} at ${candidate.buyPrice}cr/ea...`);
        const buyResp = await bot.exec("buy", { item_id: candidate.itemId, quantity: qty });
        if (buyResp.error) {
          failedSources.add(sourceKey);
          if (buyResp.error.message.includes("item_not_available") || buyResp.error.message.includes("not_available")) {
            mapStore.removeMarketItem(candidate.sourceSystem, candidate.sourcePoi, candidate.itemId);
          }
          if (alreadyHave <= 0) {
            ctx.log("error", `Buy failed: ${buyResp.error.message} — trying next route`);
            releaseTradeLock(bot.username, candidate.itemId, "aborted:buy_failed");
            pendingLockItemId = null;
            pendingLockReleased = true;
            continue;
          }
          // Have some already — proceed with what we've got
          ctx.log("trade", `Buy failed but have ${alreadyHave}x already in cargo — proceeding`);
          qty = 0;
        }
      } else if (alreadyHave > 0) {
        ctx.log("trade", `Already have ${alreadyHave}x ${candidate.itemName} in cargo — skipping buy`);
      }

      await bot.refreshStatus();
      await bot.refreshCargo();
      const actualInCargo = bot.inventory.find(i => i.itemId === candidate.itemId)?.quantity ?? 0;
      const actualReceived = Math.max(0, actualInCargo - alreadyHave);
      const actualSpent = Math.max(0, creditsBefore - bot.credits);

      if (actualReceived < qty && qty > 0) {
        ctx.log("trade", `Partial fill: received ${actualReceived}/${qty} items (cargo: ${actualInCargo} total)`);
        if (actualSpent > actualReceived * candidate.buyPrice + 10) {
          ctx.log("error", `OVERCHARGE: spent ${actualSpent}cr for ${actualReceived} items (expected ~${actualReceived * candidate.buyPrice}cr) — charged for ${Math.round(actualSpent / candidate.buyPrice)} items`);
        }
      }

      route = candidate;
      buyQty = actualInCargo; // use actual cargo count, not requested
      investedCredits = actualSpent; // use actual credits spent, not theoretical
      if (qty > 0) {
        ctx.log("trade", `Purchased ${actualReceived}x ${candidate.itemName} for ${actualSpent}cr (${actualSpent > 0 ? Math.round(actualSpent / Math.max(actualReceived, 1)) : candidate.buyPrice}cr/ea)${alreadyHave > 0 ? ` (+${alreadyHave}x already in cargo)` : ""}`);
      }

      // Start trade session tracking (only for new trades, not recovered ones)
      if (!recoveredSession) {
        const session = createTradeSession({
          botUsername: bot.username,
          route: candidate,
          isCargoRoute: candidate.sourcePoi === "cargo",
          investedCredits: actualSpent,
        });
        await startTradeSession(session);
        ctx.log("trade", `Trade session started: ${session.sessionId}`);

        // Update the lock with the real session ID and actual quantity
        updateTradeLock(bot.username, candidate.itemId, {
          sessionId: session.sessionId,
          quantityCommitted: buyQty,
        });
      }

      // Reserve this trade in cached market data so other bots don't chase the same route
      mapStore.reserveTradeQuantity(
        candidate.sourceSystem, candidate.sourcePoi,
        candidate.destSystem, candidate.destPoi,
        candidate.itemId, buyQty,
      );
      
      // Clear pending lock - it's now tracked by the session
      pendingLockItemId = null;
      
      break;
    }
    } // End of route selection loop (skipped if recovered session)

    // Clean up any pending lock that wasn't converted to a session
    if (pendingLockItemId && !pendingLockReleased) {
      ctx.log("trade", `Releasing pending lock on ${pendingLockItemId} (route selection failed)`);
      releaseTradeLock(bot.username, pendingLockItemId, "aborted:route_failed");
      pendingLockItemId = null;
    }

    // Fill remaining cargo with station storage items sellable at destination
    if (route && buyQty > 0) {
      await bot.refreshStorage();
      if (bot.storage.length > 0) {
        const destSys = mapStore.getSystem(route!.destSystem);
        const destStation = destSys?.pois.find(p => p.id === route!.destPoi);
        const destMarket = destStation?.market || [];

        const storageToSell: Array<{ itemId: string; name: string; qty: number }> = [];
        for (const item of bot.storage) {
          const lower = item.itemId.toLowerCase();
          if (lower.includes("fuel") || lower.includes("energy_cell")) continue;
          if (item.itemId === route!.itemId) continue; // skip the trade item itself
          const destItem = destMarket.find(m => m.item_id === item.itemId);
          if (destItem && destItem.best_buy !== null && destItem.best_buy > 0) {
            storageToSell.push({ itemId: item.itemId, name: item.name, qty: item.quantity });
          }
        }

        if (storageToSell.length > 0) {
          const withdrawnItems: string[] = [];
          for (const si of storageToSell) {
            // Re-check actual free space each iteration
            await bot.refreshStatus();
            const freeSpace = getFreeSpace(bot);
            if (freeSpace <= 0) break;
            const wQty = Math.min(si.qty, maxItemsForCargo(freeSpace, si.itemId));
            if (wQty <= 0) continue;
            const wResp = await bot.exec("withdraw_items", { item_id: si.itemId, quantity: wQty });
            if (!wResp.error) {
              withdrawnItems.push(`${wQty}x ${si.name}`);
            }
          }
          if (withdrawnItems.length > 0) {
            ctx.log("trade", `Extra cargo from storage to sell at dest: ${withdrawnItems.join(", ")}`);
          }
        }
      }
    }

    // Re-record market data after buying — quantities/prices changed
    if (route && buyQty > 0 && bot.docked) {
      await recordMarketData(ctx);
    }

    // Insure the loaded ship before departing (still docked at source)
    if (route && buyQty > 0 && settings.autoInsure) {
      await ensureInsured(ctx);
    }

    // No route worked — deposit unsellable cargo and wait
    if (!route || buyQty <= 0) {
      // Fail any active session and release lock
      await failTradeSessionWithLockRelease(bot.username, "No valid route found");

      if (bot.docked) {
        await bot.refreshCargo();
        for (const item of [...bot.inventory]) {
          if (item.quantity <= 0) continue;
          const lower = item.itemId.toLowerCase();
          if (lower.includes("fuel") || lower.includes("energy_cell")) continue;
          ctx.log("trade", `No buyer for ${item.quantity}x ${item.name} — depositing to storage`);
          await bot.exec("deposit_items", { item_id: item.itemId, quantity: item.quantity });
        }
      }
      ctx.log("trade", "All routes failed — waiting 60s before re-scanning");
      await ctx.sleep(60000);
      continue;
    }

    // ── Phase 2: Travel to destination and sell ──
    yield "travel_to_dest";
    await ensureUndocked(ctx);

    // Ensure fuel for the trip — never jettison trade cargo
    const cargoSafetyOpts = { ...safetyOpts, noJettison: true };
    const fueled2 = await ensureFueled(ctx, safetyOpts.fuelThresholdPct, { noJettison: true });
    if (!fueled2) {
      ctx.log("error", "Cannot refuel for delivery — selling locally instead");
      await ensureDocked(ctx);
      await bot.exec("sell", { item_id: route.itemId, quantity: buyQty });
      await bot.refreshStatus();
      continue;
    }

    if (bot.system !== route.destSystem) {
      ctx.log("travel", `Heading to ${route.destPoiName} in ${route.destSystem}...`);
      
      // Update session state to in_transit
      const activeSession = getActiveSession(bot.username);
      if (activeSession) {
        await updateTradeSession(bot.username, {
          state: "in_transit",
          jumpsCompleted: 0,
        });
      }
      
      const arrived2 = await navigateToSystem(ctx, route.destSystem, {
        ...cargoSafetyOpts,
        onJump: async (jumpNum) => {
          if (jumpNum % 3 !== 0) return true; // validate every 3 jumps

          // Update session jump progress
          const session = getActiveSession(bot.username);
          if (session) {
            await updateTradeSession(bot.username, { jumpsCompleted: jumpNum });
          }

          try {
            const buys = mapStore.getAllBuyDemand();
            const destBuyer = buys.find(b =>
              b.itemId === route!.itemId && b.systemId === route!.destSystem && b.poiId === route!.destPoi
            );

            // If no buyer found in cache, refresh market data and check again
            if (!destBuyer) {
              ctx.log("trade", `Mid-route check (jump ${jumpNum}): buyer not in cache — refreshing market data`);
              await recordMarketData(ctx);
              const refreshedBuys = mapStore.getAllBuyDemand();
              const refreshedBuyer = refreshedBuys.find(b =>
                b.itemId === route!.itemId && b.systemId === route!.destSystem && b.poiId === route!.destPoi
              );

              if (!refreshedBuyer) {
                ctx.log("trade", `Mid-route check (jump ${jumpNum}): buyer still not found — may be stale data, continuing anyway`);
                return true; // Continue - don't abort on potentially stale cache
              }

              // Check quantity and price with refreshed data
              if (refreshedBuyer.quantity <= 0) {
                ctx.log("trade", `Mid-route check (jump ${jumpNum}): buyer quantity is 0 — finding alternative`);
                // Search for alternative profitable buyer
                const alternatives = findProfitableAlternativeBuyers(
                  route!.itemId,
                  route!.itemName,
                  buyQty,
                  investedCredits,
                  bot.system,
                  settings,
                );

                if (alternatives.length > 0) {
                  const best = alternatives[0];
                  ctx.log("trade", `Mid-route check (jump ${jumpNum}): Found alternative buyer at ${best.buyer.poiName} (${best.buyer.price}cr/ea, ${best.jumps} jumps) — est. profit ${Math.round(best.profit)}cr`);
                  // Redirect to alternative buyer
                  route = {
                    ...route!,
                    destSystem: best.buyer.systemId,
                    destPoi: best.buyer.poiId,
                    destPoiName: best.buyer.poiName,
                    sellPrice: best.buyer.price,
                    jumps: best.jumps,
                    totalProfit: best.profit,
                  };
                  await updateTradeSession(bot.username, {
                    destSystem: best.buyer.systemId,
                    destPoi: best.buyer.poiId,
                    destPoiName: best.buyer.poiName,
                    sellPricePerUnit: best.buyer.price,
                    notes: (session?.notes || "") + ` | Rerouted mid-flight to ${best.buyer.poiName}`,
                  });
                  return true;
                }
                
                ctx.log("trade", `Mid-route check (jump ${jumpNum}): No profitable alternative found — will deposit at destination`);
                return true;
              }

              if (investedCredits > 0 && refreshedBuyer.price * buyQty < investedCredits) {
                ctx.log("trade", `Mid-route check (jump ${jumpNum}): price dropped to ${refreshedBuyer.price}cr — checking alternatives`);
                // Search for alternative profitable buyer
                const alternatives = findProfitableAlternativeBuyers(
                  route!.itemId,
                  route!.itemName,
                  buyQty,
                  investedCredits,
                  bot.system,
                  settings,
                );

                if (alternatives.length > 0) {
                  const best = alternatives[0];
                  ctx.log("trade", `Mid-route check (jump ${jumpNum}): Found better buyer at ${best.buyer.poiName} (${best.buyer.price}cr/ea, ${best.jumps} jumps) — est. profit ${Math.round(best.profit)}cr`);
                  // Redirect to alternative buyer
                  route = {
                    ...route!,
                    destSystem: best.buyer.systemId,
                    destPoi: best.buyer.poiId,
                    destPoiName: best.buyer.poiName,
                    sellPrice: best.buyer.price,
                    jumps: best.jumps,
                    totalProfit: best.profit,
                  };
                  await updateTradeSession(bot.username, {
                    destSystem: best.buyer.systemId,
                    destPoi: best.buyer.poiId,
                    destPoiName: best.buyer.poiName,
                    sellPricePerUnit: best.buyer.price,
                    notes: (session?.notes || "") + ` | Rerouted mid-flight to ${best.buyer.poiName} for better price`,
                  });
                  return true;
                }

                ctx.log("warn", `Mid-route check (jump ${jumpNum}): No profitable alternative — will incur loss of ${investedCredits - refreshedBuyer.price * buyQty}cr`);
                return true;
              }

              ctx.log("trade", `Mid-route check (jump ${jumpNum}): trade valid (${refreshedBuyer.price}cr × ${refreshedBuyer.quantity} at dest)`);
            } else {
              // Original buyer found in cache
              if (destBuyer.quantity <= 0) {
                ctx.log("trade", `Mid-route check (jump ${jumpNum}): buyer quantity is 0 — finding alternative`);
                // Search for alternative profitable buyer
                const alternatives = findProfitableAlternativeBuyers(
                  route!.itemId,
                  route!.itemName,
                  buyQty,
                  investedCredits,
                  bot.system,
                  settings,
                );

                if (alternatives.length > 0) {
                  const best = alternatives[0];
                  ctx.log("trade", `Mid-route check (jump ${jumpNum}): Found alternative buyer at ${best.buyer.poiName} (${best.buyer.price}cr/ea, ${best.jumps} jumps) — est. profit ${Math.round(best.profit)}cr`);
                  // Redirect to alternative buyer
                  route = {
                    ...route!,
                    destSystem: best.buyer.systemId,
                    destPoi: best.buyer.poiId,
                    destPoiName: best.buyer.poiName,
                    sellPrice: best.buyer.price,
                    jumps: best.jumps,
                    totalProfit: best.profit,
                  };
                  await updateTradeSession(bot.username, {
                    destSystem: best.buyer.systemId,
                    destPoi: best.buyer.poiId,
                    destPoiName: best.buyer.poiName,
                    sellPricePerUnit: best.buyer.price,
                    notes: (session?.notes || "") + ` | Rerouted mid-flight to ${best.buyer.poiName}`,
                  });
                  return true;
                }

                ctx.log("trade", `Mid-route check (jump ${jumpNum}): No profitable alternative found — will deposit at destination`);
                return true;
              }

              if (investedCredits > 0 && destBuyer.price * buyQty < investedCredits) {
                ctx.log("trade", `Mid-route check (jump ${jumpNum}): price dropped to ${destBuyer.price}cr — checking alternatives`);
                // Search for alternative profitable buyer
                const alternatives = findProfitableAlternativeBuyers(
                  route!.itemId,
                  route!.itemName,
                  buyQty,
                  investedCredits,
                  bot.system,
                  settings,
                );

                if (alternatives.length > 0) {
                  const best = alternatives[0];
                  ctx.log("trade", `Mid-route check (jump ${jumpNum}): Found better buyer at ${best.buyer.poiName} (${best.buyer.price}cr/ea, ${best.jumps} jumps) — est. profit ${Math.round(best.profit)}cr`);
                  // Redirect to alternative buyer
                  route = {
                    ...route!,
                    destSystem: best.buyer.systemId,
                    destPoi: best.buyer.poiId,
                    destPoiName: best.buyer.poiName,
                    sellPrice: best.buyer.price,
                    jumps: best.jumps,
                    totalProfit: best.profit,
                  };
                  await updateTradeSession(bot.username, {
                    destSystem: best.buyer.systemId,
                    destPoi: best.buyer.poiId,
                    destPoiName: best.buyer.poiName,
                    sellPricePerUnit: best.buyer.price,
                    notes: (session?.notes || "") + ` | Rerouted mid-flight to ${best.buyer.poiName} for better price`,
                  });
                  return true;
                }

                ctx.log("warn", `Mid-route check (jump ${jumpNum}): No profitable alternative — will incur loss of ${investedCredits - destBuyer.price * buyQty}cr`);
                return true;
              }

              ctx.log("trade", `Mid-route check (jump ${jumpNum}): trade valid (${destBuyer.price}cr × ${destBuyer.quantity} at dest)`);
            }

            return true;
          } catch (err) {
            // Network error during validation - don't abort, just continue
            ctx.log("trade", `Mid-route check (jump ${jumpNum}): validation error — continuing anyway`);
            return true;
          }
        },
      });
      if (!arrived2) {
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

    // Travel to destination POI
    await ensureUndocked(ctx);
    if (bot.poi !== route.destPoi) {
      ctx.log("travel", `Traveling to ${route.destPoiName}...`);
      const t2Resp = await bot.exec("travel", { target_poi: route.destPoi });
      if (await checkBattleAfterCommand(ctx, t2Resp.notifications, "travel", battleState)) {
        ctx.log("combat", "Battle detected during travel — fleeing!");
        await ctx.sleep(2000);
        continue;
      }
      // CRITICAL: Check for battle interrupt error
      if (t2Resp.error) {
        const errMsg = t2Resp.error.message.toLowerCase();
        if (t2Resp.error.code === "battle_interrupt" || errMsg.includes("interrupted by battle") || errMsg.includes("interrupted by combat")) {
          ctx.log("combat", `Travel interrupted by battle! ${t2Resp.error.message} - fleeing!`);
          await fleeFromBattle(ctx);
          await ctx.sleep(5000);
          continue;
        }
      }
      if (t2Resp.error && !t2Resp.error.message.includes("already")) {
        ctx.log("error", `Travel to dest failed: ${t2Resp.error.message}`);
        // Try to sell wherever we are
        const { pois } = await getSystemInfo(ctx);
        const station = findStation(pois);
        if (station) {
          const travelResp = await bot.exec("travel", { target_poi: station.id });
          if (await checkBattleAfterCommand(ctx, travelResp.notifications, "travel", battleState)) {
            ctx.log("combat", "Battle detected during travel — fleeing!");
            await ctx.sleep(2000);
            continue;
          }
          // CRITICAL: Check for battle interrupt error
          if (travelResp.error) {
            const errMsg = travelResp.error.message.toLowerCase();
            if (travelResp.error.code === "battle_interrupt" || errMsg.includes("interrupted by battle") || errMsg.includes("interrupted by combat")) {
              ctx.log("combat", `Travel interrupted by battle! ${travelResp.error.message} - fleeing!`);
              await ctx.sleep(5000);
              continue;
            }
          }
          bot.poi = station.id;
        }
      } else {
        bot.poi = route.destPoi;

        // Check for pirates at destination
        const nearbyResp = await bot.exec("get_nearby");
        if (nearbyResp.result && typeof nearbyResp.result === "object") {
          const { checkAndFleeFromPirates } = await import("./common.js");
          const fled = await checkAndFleeFromPirates(ctx, nearbyResp.result);
          if (fled) {
            ctx.log("error", "Pirates detected at destination - fled, aborting trade");
            await ensureDocked(ctx);
            await ctx.sleep(30000);
            continue;
          }
        }
      }
    }

    // Dock at destination
    yield "dock_dest";
    const d2Resp = await bot.exec("dock");
    if (await checkBattleAfterCommand(ctx, d2Resp.notifications, "dock", battleState)) {
      ctx.log("combat", "Battle detected during dock — fleeing!");
      await ctx.sleep(2000);
      continue;
    }
    if (d2Resp.error && !d2Resp.error.message.includes("already")) {
      ctx.log("error", `Dock failed at dest: ${d2Resp.error.message}`);
      continue;
    }
    bot.docked = true;
    await tryMissions(ctx);

    // ── Sell trade items ──
    yield "sell";
    let totalSold = 0;
    let sellRevenue = 0;

    // Attempt to sell at current destination
    await bot.refreshCargo();
    let remaining = bot.inventory.find(i => i.itemId === route!.itemId)?.quantity ?? 0;

    if (remaining <= 0) {
      ctx.log("error", `No ${route!.itemName} left in cargo (bought ${buyQty}, all consumed during travel)`);
    } else {
      if (remaining < buyQty) {
        ctx.log("trade", `Only ${remaining}/${buyQty}x ${route!.itemName} left (${buyQty - remaining} consumed during travel)`);
      }

      // Check actual market conditions before selling
      const minAcceptablePrice = Math.floor(investedCredits / buyQty); // Break-even price per unit
      const marketCheck = await calculateOptimalSellQuantity(
        ctx,
        route!.itemId,
        route!.itemName,
        remaining,
        minAcceptablePrice,
      );

      if (marketCheck.sellQty <= 0) {
        ctx.log("trade", `No viable buy orders for ${route!.itemName} — holding items for better prices`);
        remaining = marketCheck.sellQty; // Will trigger deposit logic below
      } else {
        // Sell only what the market can absorb at reasonable prices
        const actualSellQty = marketCheck.sellQty;
        ctx.log("trade", `Selling ${actualSellQty}x ${route!.itemName} (${marketCheck.priceBreakdown})...`);
        const sellResp = await bot.exec("sell", { item_id: route!.itemId, quantity: actualSellQty });
        if (!sellResp.error) {
          const sr = sellResp.result as Record<string, unknown> | undefined;
          const earned = (sr?.credits_earned as number) ?? (sr?.total as number) ?? (sr?.revenue as number) ?? 0;
          // Check how many actually sold
          await bot.refreshCargo();
          const afterSell = bot.inventory.find(i => i.itemId === route!.itemId)?.quantity ?? 0;
          const sold = actualSellQty - afterSell;
          totalSold += sold;
          sellRevenue += earned > 0 ? earned : sold * route!.sellPrice;
          remaining = afterSell;
          if (remaining > 0) {
            ctx.log("trade", `Sold ${sold}x but ${remaining}x ${route!.itemName} still unsold — buyer demand exhausted`);
          }
          // Refresh dest market cache with real post-sale data
          await recordMarketData(ctx);
        } else {
          ctx.log("error", `Sell failed: ${sellResp.error.message}`);
        }
      }
    }

    // If unsold items remain, find another buyer from mapStore
    if (remaining > 0) {
      yield "find_next_buyer";
      
      // Check if current destination sale is profitable
      const currentSaleRevenue = route.sellPrice * remaining;
      const isCurrentSaleProfitable = currentSaleRevenue >= investedCredits;
      
      if (!isCurrentSaleProfitable && investedCredits > 0) {
        ctx.log("trade", `Current sale at ${route.sellPrice}cr/ea would result in loss (cost: ${investedCredits}cr for ${buyQty}x) — searching for profitable alternatives`);
        
        // Search for profitable alternative buyers
        const alternatives = findProfitableAlternativeBuyers(
          route.itemId,
          route.itemName,
          remaining,
          investedCredits,
          bot.system,
          settings,
        );
        
        if (alternatives.length > 0) {
          const best = alternatives[0];
          ctx.log("trade", `Found profitable alternative at ${best.buyer.poiName} (${best.buyer.price}cr/ea, ${best.jumps} jumps) — est. profit ${Math.round(best.profit)}cr`);
          
          // Navigate to the profitable buyer
          if (bot.system !== best.buyer.systemId) {
            await ensureUndocked(ctx);
            const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct, { noJettison: true });
            if (fueled) {
              const arrived = await navigateToSystem(ctx, best.buyer.systemId, { ...safetyOpts, noJettison: true });
              if (arrived) {
                bot.system = best.buyer.systemId;
              }
            }
          }

          if (bot.poi !== best.buyer.poiId) {
            await ensureUndocked(ctx);
            const tResp = await bot.exec("travel", { target_poi: best.buyer.poiId });
            if (await checkBattleAfterCommand(ctx, tResp.notifications, "travel", battleState)) {
              ctx.log("combat", "Battle detected during travel — fleeing!");
              await ctx.sleep(2000);
              continue;
            }
            // CRITICAL: Check for battle interrupt error
            if (tResp.error) {
              const errMsg = tResp.error.message.toLowerCase();
              if (tResp.error.code === "battle_interrupt" || errMsg.includes("interrupted by battle") || errMsg.includes("interrupted by combat")) {
                ctx.log("combat", `Travel interrupted by battle! ${tResp.error.message} - fleeing!`);
                await fleeFromBattle(ctx);
                await ctx.sleep(5000);
                continue;
              }
            }
            if (!tResp.error || tResp.error.message.includes("already")) {
              bot.poi = best.buyer.poiId;
            }
          }
          
          await ensureDocked(ctx);
          await bot.refreshCargo();
          remaining = bot.inventory.find(i => i.itemId === route!.itemId)?.quantity ?? 0;

          if (remaining > 0) {
            const sResp = await bot.exec("sell", { item_id: route!.itemId, quantity: remaining });
            if (!sResp.error) {
              const sr = sResp.result as Record<string, unknown> | undefined;
              const earned = (sr?.credits_earned as number) ?? (sr?.total as number) ?? 0;
              await bot.refreshCargo();
              const afterSell = bot.inventory.find(i => i.itemId === route!.itemId)?.quantity ?? 0;
              const sold = remaining - afterSell;
              totalSold += sold;
              sellRevenue += earned > 0 ? earned : sold * best.buyer.price;
              remaining = afterSell;
              ctx.log("trade", `Sold ${sold}x ${route!.itemName} at ${best.buyer.poiName} (${best.buyer.price}cr/ea)`);
              await recordMarketData(ctx);
            }
          }
        } else {
          ctx.log("trade", `No profitable buyers found — will deposit unsold items at home`);
        }
      }
      
      // If still unsold, try regular buyer search (sorted by price)
      if (remaining > 0) {
        const allBuys = mapStore.getAllBuyDemand();
        const buyers = allBuys
          .filter(b => b.itemId === route!.itemId && b.price > 0)
          .filter(b => !(b.systemId === bot.system && b.poiId === bot.poi)) // skip current station
          .filter(b => {
            // Only include buyers at POIs with a dockable station
            const sys = mapStore.getSystem(b.systemId);
            const poi = sys?.pois.find(p => p.id === b.poiId);
            return poi?.has_base ?? false;
          })
          .sort((a, b) => b.price - a.price);

        for (const buyer of buyers) {
          if (remaining <= 0 || bot.state !== "running") break;
          const { jumps } = estimateFuelCost(bot.system, buyer.systemId, settings.fuelCostPerJump);
          if (jumps >= 999) continue;

          ctx.log("trade", `${remaining}x ${route.itemName} unsold — trying ${buyer.poiName} in ${buyer.systemId} (${buyer.price}cr/ea, ${jumps} jumps)`);

          // Navigate to the buyer
          if (bot.system !== buyer.systemId) {
            await ensureUndocked(ctx);
            const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct, { noJettison: true });
            if (!fueled) break;
            const arrived = await navigateToSystem(ctx, buyer.systemId, { ...safetyOpts, noJettison: true });
            if (!arrived) continue;
          }

          if (bot.poi !== buyer.poiId) {
            await ensureUndocked(ctx);
            const tResp = await bot.exec("travel", { target_poi: buyer.poiId });
            if (await checkBattleAfterCommand(ctx, tResp.notifications, "travel", battleState)) {
              ctx.log("combat", "Battle detected during travel — fleeing!");
              await ctx.sleep(2000);
              continue;
            }
            // CRITICAL: Check for battle interrupt error
            if (tResp.error) {
              const errMsg = tResp.error.message.toLowerCase();
              if (tResp.error.code === "battle_interrupt" || errMsg.includes("interrupted by battle") || errMsg.includes("interrupted by combat")) {
                ctx.log("combat", `Travel interrupted by battle! ${tResp.error.message} - fleeing!`);
                await fleeFromBattle(ctx);
                await ctx.sleep(5000);
                continue;
              }
            }
            if (tResp.error && !tResp.error.message.includes("already")) continue;
            bot.poi = buyer.poiId;
          }

          await ensureDocked(ctx);
          await bot.refreshCargo();
          remaining = bot.inventory.find(i => i.itemId === route!.itemId)?.quantity ?? 0;
          if (remaining <= 0) break;

          const sResp = await bot.exec("sell", { item_id: route!.itemId, quantity: remaining });
          if (!sResp.error) {
            const sr = sResp.result as Record<string, unknown> | undefined;
            const earned = (sr?.credits_earned as number) ?? (sr?.total as number) ?? (sr?.revenue as number) ?? 0;
            await bot.refreshCargo();
            const afterSell = bot.inventory.find(i => i.itemId === route!.itemId)?.quantity ?? 0;
            const sold = remaining - afterSell;
            totalSold += sold;
            sellRevenue += earned > 0 ? earned : sold * buyer.price;
            remaining = afterSell;
            ctx.log("trade", `Sold ${sold}x ${route!.itemName} at ${buyer.poiName} (${buyer.price}cr/ea)${remaining > 0 ? ` — ${remaining}x still unsold` : ""}`);
            await recordMarketData(ctx);
          } else {
            ctx.log("error", `Sell failed: ${sResp.error.message}`);
          }
          break; // only try one alternative buyer, then fall back to storage
        }
      }
    }

    // If still unsold, deposit at faction storage
    if (remaining > 0) {
      yield "store_unsold";
      
      // Check if we've recovered our investment
      const totalRevenue = sellRevenue + extraRevenue;
      const isProfitable = totalRevenue >= investedCredits;
      const homeSystem = settings.homeSystem || startSystem;
      
      if (!isProfitable && investedCredits > 0 && homeSystem) {
        // Unprofitable trade — return home and deposit to faction storage
        ctx.log("trade", `${remaining}x ${route.itemName} still unsold — trade unprofitable (spent ${investedCredits}cr, earned ${totalRevenue}cr) — returning to home system ${homeSystem} to deposit`);
        
        // Navigate to home system
        if (bot.system !== homeSystem) {
          await ensureUndocked(ctx);
          const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct, { noJettison: true });
          if (fueled) {
            await navigateToSystem(ctx, homeSystem, { ...safetyOpts, noJettison: true });
          }
        }
        
        // Find station at home
        const { pois: homePois } = await getSystemInfo(ctx);
        const homeStation = findStation(homePois);
        if (homeStation) {
          if (bot.poi !== homeStation.id) {
            await ensureUndocked(ctx);
            const travelResp = await bot.exec("travel", { target_poi: homeStation.id });
            if (await checkBattleAfterCommand(ctx, travelResp.notifications, "travel", battleState)) {
              ctx.log("combat", "Battle detected during travel — fleeing!");
              await ctx.sleep(2000);
              continue;
            }
            // CRITICAL: Check for battle interrupt error
            if (travelResp.error) {
              const errMsg = travelResp.error.message.toLowerCase();
              if (travelResp.error.code === "battle_interrupt" || errMsg.includes("interrupted by battle") || errMsg.includes("interrupted by combat")) {
                ctx.log("combat", `Travel interrupted by battle! ${travelResp.error.message} - fleeing!`);
                await fleeFromBattle(ctx);
                await ctx.sleep(5000);
                continue;
              }
            }
            bot.poi = homeStation.id;
          }
          await ensureDocked(ctx);

          // Deposit unsold items
          await bot.refreshCargo();
          remaining = bot.inventory.find(i => i.itemId === route!.itemId)?.quantity ?? 0;
          if (remaining > 0) {
            await bot.exec("deposit_items", { item_id: route!.itemId, quantity: remaining });
            ctx.log("trade", `Deposited ${remaining}x ${route!.itemName} to faction storage at ${homeStation.name} (will sell when prices improve)`);
            logFactionActivity(ctx, "deposit", `Deposited ${remaining}x ${route!.itemName} from unprofitable trade (cost: ${investedCredits}cr)`);
          }
        }
      } else {
        // Profitable or break-even — deposit at Sol Central as before
        const SOL_CENTRAL = "sol_central";
        ctx.log("trade", `${remaining}x ${route!.itemName} still unsold — storing at Sol Central`);

        // Navigate to Sol Central if needed
        const solSystem = "sol";
        if (bot.system !== solSystem) {
          await ensureUndocked(ctx);
          const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct, { noJettison: true });
          if (fueled) {
            await navigateToSystem(ctx, solSystem, { ...safetyOpts, noJettison: true });
          }
        }

        if (bot.poi !== SOL_CENTRAL) {
          await ensureUndocked(ctx);
          const travelResp = await bot.exec("travel", { target_poi: SOL_CENTRAL });
          if (await checkBattleAfterCommand(ctx, travelResp.notifications, "travel", battleState)) {
            ctx.log("combat", "Battle detected during travel — fleeing!");
            await ctx.sleep(2000);
            continue;
          }
          // CRITICAL: Check for battle interrupt error
          if (travelResp.error) {
            const errMsg = travelResp.error.message.toLowerCase();
            if (travelResp.error.code === "battle_interrupt" || errMsg.includes("interrupted by battle") || errMsg.includes("interrupted by combat")) {
              ctx.log("combat", `Travel interrupted by battle! ${travelResp.error.message} - fleeing!`);
              await ctx.sleep(5000);
              continue;
            }
          }
          bot.poi = SOL_CENTRAL;
        }

        await ensureDocked(ctx);
        await bot.refreshCargo();
        remaining = bot.inventory.find(i => i.itemId === route!.itemId)?.quantity ?? 0;
        if (remaining > 0) {
          await bot.exec("deposit_items", { item_id: route!.itemId, quantity: remaining });
          ctx.log("trade", `Deposited ${remaining}x ${route!.itemName} to Sol Central storage`);
        }
      }
    }

    // Extra cargo items stay in cargo - will be handled by next cycle's cargo handling phase
    // (No need to deposit at trade destinations - faction storage may not exist here)

    // Profit = sell revenue + other sales - cost of market purchases
    const actualProfit = sellRevenue + extraRevenue - investedCredits;
    bot.stats.totalTrades++;
    bot.stats.totalProfit += actualProfit;

    // Record market data
    await recordMarketData(ctx);

    // ── Trade summary ──
    const soldLabel = totalSold < buyQty ? `${totalSold}/${buyQty}` : `${buyQty}`;
    ctx.log("trade", `Trade run complete: ${soldLabel}x ${route.itemName} — profit ${actualProfit}cr (${sellRevenue}cr sells + ${extraRevenue}cr other - ${investedCredits}cr cost, ${route.jumps} jumps)`);
    
    // Complete trade session
    const actualRevenue = sellRevenue;
    const completedSession = await completeTradeSession(bot.username, actualRevenue, actualProfit);
    if (completedSession) {
      ctx.log("trade", `Session completed: ${completedSession.sessionId}`);
      
      // Release fleet lock on this item
      const lockReleased = releaseTradeLock(bot.username, completedSession.itemId, "completed");
      if (lockReleased) {
        ctx.log("trade", `Fleet lock released on ${completedSession.itemName}`);
      }
    }

    // ── Faction donation (10% of profit) ──
    await factionDonateProfit(ctx, actualProfit);

    // ── Check for next trade before considering excess credit deposit ──
    const homeSystem = settings.homeSystem || startSystem;
    yield "seek_next_trade";
    await bot.refreshStatus();
    await bot.refreshCargo();
    let nextFuelWeight = 0;
    for (const item of bot.inventory) {
      const lower = item.itemId.toLowerCase();
      if (lower.includes("fuel") || lower.includes("energy_cell")) {
        nextFuelWeight += item.quantity * getItemSize(item.itemId);
      }
    }
    const nextCargoCapacity = Math.max(0, (bot.cargoMax > 0 ? bot.cargoMax : 50) - nextFuelWeight);
    const nextCargoRoutes = findCargoSellRoutes(ctx, settings, bot.system);
    const nextMarketRoutes = findTradeOpportunities(settings, bot.system, nextCargoCapacity);
    const nextRoutes = [...nextCargoRoutes, ...nextMarketRoutes].sort((a, b) => b.totalProfit - a.totalProfit);

    // ── Deposit excess credits to faction storage ──
    // Only deposit if:
    // 1. We're currently at the home station (convenient opportunity), OR
    // 2. There are no more profitable trades to do
    await bot.refreshStatus();
    const hasProfitableTrades = nextRoutes.length > 0;
    const isAtHomeStation = homeSystem && bot.system === homeSystem && bot.docked;
    const noTradesAndHasExcess = !hasProfitableTrades && bot.credits > TRADER_DEPOSIT_THRESHOLD;

    if (bot.credits > TRADER_WORKING_BALANCE && (isAtHomeStation || noTradesAndHasExcess)) {
      const excessCredits = bot.credits - TRADER_WORKING_BALANCE;
      const homeSystemForDeposit = homeSystem;

      if (isAtHomeStation) {
        // We're at home station - deposit immediately
        ctx.log("trade", `At home station with ${bot.credits}cr — depositing ${excessCredits}cr to faction storage`);
        const depositResp = await bot.exec("faction_deposit_credits", { amount: excessCredits });
        if (!depositResp.error) {
          ctx.log("trade", `Deposited ${excessCredits}cr to faction storage (kept ${TRADER_WORKING_BALANCE}cr working balance)`);
          logFactionActivity(ctx, "deposit", `Deposited ${excessCredits}cr excess trading profits to faction storage`);
        } else {
          ctx.log("error", `Failed to deposit credits: ${depositResp.error.message}`);
        }
      } else if (noTradesAndHasExcess && homeSystemForDeposit && bot.system !== homeSystemForDeposit) {
        // No trades available and we have excess - return home to deposit
        ctx.log("trade", `No profitable trades and excess credits detected (${bot.credits}cr) — returning to home system ${homeSystemForDeposit} to deposit ${excessCredits}cr`);
        await ensureUndocked(ctx);
        const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
        if (fueled) {
          const arrived = await navigateToSystem(ctx, homeSystemForDeposit, safetyOpts);
          if (arrived) {
            // Dock at home station
            const { pois: homePois } = await getSystemInfo(ctx);
            const homeStation = findStation(homePois);
            if (homeStation) {
              const travelResp = await bot.exec("travel", { target_poi: homeStation.id });
              if (await checkBattleAfterCommand(ctx, travelResp.notifications, "travel", battleState)) {
                ctx.log("combat", "Battle detected during travel — fleeing!");
                await ctx.sleep(2000);
                continue;
              }
              // CRITICAL: Check for battle interrupt error
              if (travelResp.error) {
                const errMsg = travelResp.error.message.toLowerCase();
                if (travelResp.error.code === "battle_interrupt" || errMsg.includes("interrupted by battle") || errMsg.includes("interrupted by combat")) {
                  ctx.log("combat", `Travel interrupted by battle! ${travelResp.error.message} - fleeing!`);
                  await ctx.sleep(5000);
                  continue;
                }
              }
              await ensureDocked(ctx, true);

              // Deposit excess credits to faction storage
              const depositResp = await bot.exec("faction_deposit_credits", { amount: excessCredits });
              if (!depositResp.error) {
                ctx.log("trade", `Deposited ${excessCredits}cr to faction storage (kept ${TRADER_WORKING_BALANCE}cr working balance)`);
                logFactionActivity(ctx, "deposit", `Deposited ${excessCredits}cr excess trading profits to faction storage`);
              } else {
                ctx.log("error", `Failed to deposit credits: ${depositResp.error.message}`);
              }
            }
          }
        }
      }
    }

    // ── Maintenance ──
    yield "post_trade_maintenance";
    await tryRefuel(ctx);
    await repairShip(ctx);

    // ── Check skills ──
    yield "check_skills";
    await bot.checkSkills();

    // ── Continue with next trade or return home ──
    if (nextRoutes.length > 0) {
      ctx.log("trade", `Found ${nextRoutes.length} routes from current location — continuing trading`);
      // Skip the return home — the main loop will pick up these routes
    } else if (homeSystem && bot.system !== homeSystem) {
      yield "return_home";
      ctx.log("travel", `No profitable routes nearby — returning to home system ${homeSystem}...`);
      const homeFueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
      if (!homeFueled) {
        ctx.log("error", "Cannot refuel for return home — will try next cycle");
      } else {
        await ensureUndocked(ctx);
        const arrived = await navigateToSystem(ctx, homeSystem, safetyOpts);
        if (arrived) {
          // Dock at home station
          const { pois: homePois } = await getSystemInfo(ctx);
          const homeStation = findStation(homePois);
          if (homeStation) {
            const travelResp = await bot.exec("travel", { target_poi: homeStation.id });
            if (await checkBattleAfterCommand(ctx, travelResp.notifications, "travel", battleState)) {
              ctx.log("combat", "Battle detected during travel — fleeing!");
              await ctx.sleep(2000);
              continue;
            }
            // CRITICAL: Check for battle interrupt error
            if (travelResp.error) {
              const errMsg = travelResp.error.message.toLowerCase();
              if (travelResp.error.code === "battle_interrupt" || errMsg.includes("interrupted by battle") || errMsg.includes("interrupted by combat")) {
                ctx.log("combat", `Travel interrupted by battle! ${travelResp.error.message} - fleeing!`);
                await fleeFromBattle(ctx);
                await ctx.sleep(5000);
                continue;
              }
            }
            const dockResp = await bot.exec("dock");
            if (await checkBattleAfterCommand(ctx, dockResp.notifications, "dock", battleState)) {
              ctx.log("combat", "Battle detected during dock — fleeing!");
              await ctx.sleep(2000);
              continue;
            }
            bot.docked = true;
            bot.poi = homeStation.id;
            ctx.log("travel", `Docked at home station ${homeStation.name}`);
          }
        } else {
          ctx.log("error", "Failed to return home — will retry next cycle");
        }
      }
    }

    await bot.refreshStatus();
    const endFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    ctx.log("info", `Credits: ${bot.credits} | Fuel: ${endFuel}% | Cargo: ${bot.cargo}/${bot.cargoMax}`);
  }
};
