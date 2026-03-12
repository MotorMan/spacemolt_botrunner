import type { Bot, Routine, RoutineContext } from "../bot.js";
import { mapStore } from "../mapstore.js";
import { catalogStore } from "../catalogstore.js";
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
  sleep,
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

/** Free cargo weight (not item count — callers must divide by item size). */
function getFreeSpace(bot: Bot): number {
  if (bot.cargoMax <= 0) return 999;
  return Math.max(0, bot.cargoMax - bot.cargo);
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
  
  // Verify items are still in cargo (for non-faction routes)
  if (!session.isFactionRoute && !session.isCargoRoute) {
    await bot.refreshCargo();
    const cargoItem = bot.inventory.find(i => i.itemId === session.itemId);
    const cargoQty = cargoItem?.quantity ?? 0;
    
    if (cargoQty <= 0) {
      ctx.log("error", `Recovery failed: ${session.itemName} no longer in cargo`);
      await failTradeSession(session.botUsername, "Items not in cargo");
      return null;
    }
    
    if (cargoQty < session.quantityBought) {
      ctx.log("trade", `Recovered with partial cargo: ${cargoQty}/${session.quantityBought}x ${session.itemName}`);
      session = updateTradeSession(session.botUsername, { 
        quantityBought: cargoQty,
        sellQuantity: cargoQty,
        notes: (session.notes || "") + ` | Partial recovery: ${cargoQty}/${session.quantityBought}x remaining`,
      })!;
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
        .sort((a, b) => b.price - a.price);
      
      if (alternativeBuyers.length === 0) {
        ctx.log("error", "No alternative buyers found — abandoning session");
        await failTradeSession(session.botUsername, "No buyers available");
        return null;
      }
      
      const bestAlt = alternativeBuyers[0];
      ctx.log("trade", `New destination: ${bestAlt.poiName} in ${bestAlt.systemId} (${bestAlt.price}cr/ea)`);
      session = updateTradeSession(session.botUsername, {
        destSystem: bestAlt.systemId,
        destPoi: bestAlt.poiId,
        destPoiName: bestAlt.poiName,
        sellPricePerUnit: bestAlt.price,
        sellQuantity: Math.min(session.sellQuantity, bestAlt.quantity),
        totalJumps: session.jumpsCompleted + estimateFuelCost(bot.system, bestAlt.systemId, settings.fuelCostPerJump).jumps,
        notes: (session.notes || "") + ` | Rerouted to ${bestAlt.poiName}`,
      })!;
    } else if (destBuyer.price < session.buyPricePerUnit) {
      ctx.log("error", `Price dropped to ${destBuyer.price}cr (below cost ${session.buyPricePerUnit}cr) — abandoning`);
      await failTradeSession(session.botUsername, "Price below cost");
      return null;
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
  if (fromSystem === toSystem) return { jumps: 0, cost: 0 };
  const route = mapStore.findRoute(fromSystem, toSystem);
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
 * Find profitable routes for items already in faction storage.
 * Uses the cheapest known market price as cost basis — profit is
 * sellPrice - materialCost - fuelCost. The trader withdraws from
 * faction storage at its current station, then travels to sell.
 */
function findFactionStorageRoutes(
  ctx: RoutineContext,
  settings: ReturnType<typeof getTraderSettings>,
  currentSystem: string,
  cargoCapacity: number = 999,
): TradeRoute[] {
  const { bot } = ctx;
  const routes: TradeRoute[] = [];
  if (bot.factionStorage.length === 0) return routes;

  const allBuys = mapStore.getAllBuyDemand();
  if (allBuys.length === 0) return routes;

  for (const item of bot.factionStorage) {
    const lower = item.itemId.toLowerCase();
    if (lower.includes("fuel") || lower.includes("energy_cell")) continue;
    // Never trade raw ores, ice, or gas — those are crafting inputs
    const catItem = catalogStore.getItem(item.itemId);
    if (catItem?.category === "ore") continue;
    if (item.quantity <= 0) continue;

    // Filter by allowed items if configured
    if (settings.tradeItems.length > 0) {
      const match = settings.tradeItems.some(t =>
        item.itemId.toLowerCase().includes(t.toLowerCase()) ||
        item.name.toLowerCase().includes(t.toLowerCase())
      );
      if (!match) continue;
    }

    // Material cost = cheapest known market price for this item
    const itemCost = getItemMarketCost(item.itemId);

    // Find best buy order for this item across all known stations
    const itemBuys = allBuys
      .filter(b => b.itemId === item.itemId && b.price > 0)
      .sort((a, b) => b.price - a.price);

    for (const buy of itemBuys) {
      // Skip if sell price doesn't beat material cost
      if (buy.price <= itemCost) continue;

      const { jumps, cost: fuelCost } = estimateFuelCost(currentSystem, buy.systemId, settings.fuelCostPerJump);
      if (jumps >= 999) continue;

      const sellQty = Math.min(item.quantity, buy.quantity, maxItemsForCargo(cargoCapacity, item.itemId));
      const profitPerUnit = buy.price - itemCost - (jumps > 0 ? fuelCost / sellQty : 0);
      if (profitPerUnit < settings.minProfitPerUnit) continue;

      const totalProfit = profitPerUnit * sellQty;

      routes.push({
        itemId: item.itemId,
        itemName: item.name,
        sourceSystem: currentSystem,
        sourcePoi: "",       // signals: withdraw from faction storage
        sourcePoiName: "faction storage",
        buyPrice: itemCost,  // material/market cost basis
        buyQty: sellQty,
        destSystem: buy.systemId,
        destPoi: buy.poiId,
        destPoiName: buy.poiName,
        sellPrice: buy.price,
        sellQty,
        jumps,
        profitPerUnit,
        totalProfit,
      });
      break; // best buy order for this item found
    }
  }

  routes.sort((a, b) => b.totalProfit - a.totalProfit);
  return routes;
}

/**
 * Find sell routes for non-fuel items currently in the bot's cargo.
 * These have zero acquisition cost — all revenue is profit minus fuel.
 * Ranked highest since the trader already has the goods.
 */
function findCargoSellRoutes(
  ctx: RoutineContext,
  settings: ReturnType<typeof getTraderSettings>,
  currentSystem: string,
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
    // Find best buyer (not at current station — we already tried selling here)
    const buyers = allBuys
      .filter(b => b.itemId === item.itemId && b.price > 0)
      .filter(b => !(b.systemId === currentSystem && b.poiId === bot.poi))
      .sort((a, b) => b.price - a.price);

    for (const buy of buyers) {
      const { jumps, cost: fuelCost } = estimateFuelCost(currentSystem, buy.systemId, settings.fuelCostPerJump);
      if (jumps >= 999) continue;

      const sellQty = Math.min(item.quantity, buy.quantity);
      if (sellQty <= 0) continue;
      const profitPerUnit = buy.price - (jumps > 0 ? fuelCost / sellQty : 0);
      if (profitPerUnit <= 0) continue;

      routes.push({
        itemId: item.itemId,
        itemName: item.name,
        sourceSystem: currentSystem,
        sourcePoi: "cargo",       // signals: already in cargo
        sourcePoiName: "ship cargo",
        buyPrice: 0,              // already have it — zero cost
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

// ── Faction storage liquidation ───────────────────────────────

/**
 * Sell items from faction storage at the current station's market.
 * Withdraws non-fuel items that can be sold here, sells them, and logs profit.
 * Must be docked.
 */
async function sellFactionStorageItems(ctx: RoutineContext): Promise<{ count: number; revenue: number }> {
  const { bot } = ctx;
  if (!bot.docked) return { count: 0, revenue: 0 };

  await bot.refreshStatus();
  const creditsBefore = bot.credits;

  await bot.refreshFactionStorage();
  if (bot.factionStorage.length === 0) return { count: 0, revenue: 0 };

  // Get current station's market to check what's sellable
  const marketResp = await bot.exec("view_market");
  if (!marketResp.result || typeof marketResp.result !== "object") return { count: 0, revenue: 0 };

  const marketData = marketResp.result as Record<string, unknown>;
  const listings = (
    Array.isArray(marketData) ? marketData :
    Array.isArray(marketData.items) ? marketData.items :
    Array.isArray(marketData.listings) ? marketData.listings :
    []
  ) as Array<Record<string, unknown>>;

  // Build set of items this market buys
  const buyableItems = new Set<string>();
  for (const listing of listings) {
    const itemId = (listing.item_id as string) || "";
    const buyPrice = (listing.buy_price as number) || (listing.best_sell as number) || 0;
    if (itemId && buyPrice > 0) buyableItems.add(itemId);
  }

  if (buyableItems.size === 0) return { count: 0, revenue: 0 };

  // Find faction storage items we can sell here (skip fuel, raw ores, ice, gas)
  const toSell: Array<{ itemId: string; name: string; qty: number }> = [];
  for (const item of bot.factionStorage) {
    const lower = item.itemId.toLowerCase();
    if (lower.includes("fuel") || lower.includes("energy_cell")) continue;
    // Never sell raw ores, ice, or gas — those are crafting inputs
    const catItem = catalogStore.getItem(item.itemId);
    if (catItem?.category === "ore") continue;
    if (!buyableItems.has(item.itemId)) continue;
    toSell.push({ itemId: item.itemId, name: item.name, qty: item.quantity });
  }

  if (toSell.length === 0) return { count: 0, revenue: 0 };

  let totalSold = 0;
  const soldItems: string[] = [];

  for (const item of toSell) {
    // Check cargo space
    await bot.refreshStatus();
    const freeSpace = getFreeSpace(bot);
    if (freeSpace <= 0) break;

    const qty = Math.min(item.qty, maxItemsForCargo(freeSpace, item.itemId));
    if (qty <= 0) continue;

    // Withdraw from faction storage
    const wResp = await bot.exec("faction_withdraw_items", { item_id: item.itemId, quantity: qty });
    if (wResp.error) continue;

    // Sell immediately
    const sResp = await bot.exec("sell", { item_id: item.itemId, quantity: qty });
    if (!sResp.error) {
      totalSold += qty;
      soldItems.push(`${qty}x ${item.name}`);
    } else {
      // Sell failed — put back in faction storage
      await bot.exec("faction_deposit_items", { item_id: item.itemId, quantity: qty });
    }
  }

  if (soldItems.length > 0) {
    await bot.refreshStatus();
    const revenue = Math.max(0, bot.credits - creditsBefore);
    ctx.log("trade", `Sold from faction storage: ${soldItems.join(", ")} — earned ${revenue}cr`);
    return { count: totalSold, revenue };
  }

  return { count: 0, revenue: 0 };
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

  while (bot.state === "running") {
    // ── Death recovery ──
    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) { await sleep(30000); continue; }

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
        await sleep(30000);
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
            updateTradeSession(bot.username, { jumpsCompleted: jumpNum });
          }
          return true;
        },
      });
      
      if (!arrived) {
        ctx.log("error", "Failed to reach destination for recovered session — will retry");
        await ensureDocked(ctx);
        await sleep(60000);
        continue;
      }
      
      // Arrived at destination - update session state and continue to sell phase
      updateTradeSession(bot.username, { state: "at_destination" });
      bot.system = recoveredSession.destSystem;
      
      // Travel to destination POI and dock
      if (bot.poi !== recoveredSession.destPoi) {
        ctx.log("travel", `Traveling to ${recoveredSession.destPoiName}...`);
        await bot.exec("travel", { target_poi: recoveredSession.destPoi });
        bot.poi = recoveredSession.destPoi;
      }
      
      await ensureDocked(ctx);
      ctx.log("trade", "Arrived at destination — proceeding to sell trade items");
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
    yield "handle_cargo";
    await bot.refreshStatus();
    await bot.refreshCargo();
    
    const cargoItems = bot.inventory.filter(i => {
      if (i.quantity <= 0) return false;
      const lower = i.itemId.toLowerCase();
      return !lower.includes("fuel") && !lower.includes("energy_cell");
    });

    if (cargoItems.length > 0 && bot.docked) {
      const allBuys = mapStore.getAllBuyDemand();
      const homeSystem = settings.homeSystem || startSystem;
      const itemsToDeposit: Array<{ itemId: string; name: string; quantity: number }> = [];
      const itemsToSell: Array<{ itemId: string; name: string; quantity: number; price: number }> = [];

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
        // Check if we're at home - if not, navigate there first
        if (bot.system !== homeSystem) {
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
                await bot.exec("travel", { target_poi: homeStation.id });
                await ensureDocked(ctx);
              }
            }
          }
        }

        // Deposit items to faction storage
        if (bot.docked) {
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
      const { revenue: fsRevenue1 } = await sellFactionStorageItems(ctx);
      extraRevenue += fsRevenue1;

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
    
    if (!recoveredSessionHandled) {
      await bot.refreshStatus();
      if (bot.docked) {
        await bot.refreshFactionStorage();
      }
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
      const factionRoutes = findFactionStorageRoutes(ctx, settings, bot.system, cargoCapacity);
      // Filter out routes that sell items we just sold at the current station (demand already filled)
      const currentPoi = bot.poi;
      const allRoutes = [...cargoRoutes, ...marketRoutes, ...factionRoutes].filter(r => {
        if (soldLocallyIds.has(r.itemId) && r.destSystem === bot.system && r.destPoi === currentPoi) return false;
        return true;
      });
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
        factionRoutes.length > 0 ? `${factionRoutes.length} faction` : "",
      ].filter(Boolean).join(" + ");
      if (cargoRoutes.length > 0 || factionRoutes.length > 0) {
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
    }

    if (routes.length === 0 && !recoveredSessionHandled) {
      // No routes found and no recovered session to handle
      ctx.log("trade", "No profitable trade routes found — waiting 60s before re-scanning");
      await sleep(60000);
      continue;
    }

    // If we have a recovered session that wasn't handled yet, convert it to a route and execute
    let route: TradeRoute | null = null;
    let buyQty = 0;
    let investedCredits = 0;
    let alreadySold = false;
    const failedSources = new Set<string>();
    let attempts = 0;

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
        updateTradeSession(bot.username, { state: "at_destination" });
      } else if (recoveredSession.jumpsCompleted > 0) {
        updateTradeSession(bot.username, { state: "in_transit" });
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
      const isFactionRoute = candidate.sourcePoi === "";
      const isCargoRoute = candidate.sourcePoi === "cargo";

      if (isCargoRoute) {
        ctx.log("trade", `Route #${ri + 1}: ${candidate.itemName} — sell ${candidate.buyQty}x from cargo → ${candidate.destPoiName} (${candidate.sellPrice}cr/ea) — est. profit ${Math.round(candidate.totalProfit)}cr (${candidate.jumps} jumps)`);
      } else if (isFactionRoute) {
        ctx.log("trade", `Route #${ri + 1}: ${candidate.itemName} — withdraw ${candidate.buyQty}x from faction storage (cost: ${candidate.buyPrice}cr/ea) → sell at ${candidate.destPoiName} (${candidate.sellPrice}cr) — est. profit ${Math.round(candidate.totalProfit)}cr (${candidate.jumps} jumps)`);
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

      if (isFactionRoute) {
        // ── Faction storage route: withdraw from faction storage and sell ──
        yield "withdraw_faction";
        await ensureDocked(ctx);

        // Emergency fuel reserve — 1 cell per 4 jumps, min 3, max 10% cargo
        const maxFuelFC = bot.cargoMax > 0 ? Math.max(3, Math.floor(bot.cargoMax * 0.1)) : 5;
        const RESERVE_FC = Math.min(Math.max(3, Math.ceil(candidate.jumps / 4)), maxFuelFC);
        await bot.refreshCargo();
        for (const item of [...bot.inventory]) {
          if (item.quantity <= 0) continue;
          const lower = item.itemId.toLowerCase();
          const isFuel = lower.includes("fuel") || lower.includes("energy_cell");
          if (isFuel) {
            const excess = item.quantity - RESERVE_FC;
            if (excess > 0) await bot.exec("deposit_items", { item_id: item.itemId, quantity: excess });
          } else {
            await bot.exec("deposit_items", { item_id: item.itemId, quantity: item.quantity });
          }
        }
        await bot.refreshStatus();

        // Check faction storage
        await bot.refreshFactionStorage();
        await bot.refreshStatus();
        const factionItem = bot.factionStorage.find(i => i.itemId === candidate.itemId);
        const availQty = factionItem ? factionItem.quantity : 0;

        if (availQty <= 0) {
          ctx.log("trade", `${candidate.itemName} no longer in faction storage — trying next route`);
          continue;
        }

        const isInStation = candidate.jumps === 0 && (candidate.destSystem === bot.system);

        if (isInStation) {
          // ── In-station faction route: batch withdraw→sell until done ──
          let totalSold = 0;
          let remaining = availQty;

          while (remaining > 0 && bot.state === "running") {
            await bot.refreshStatus();
            const freeSpace = getFreeSpace(bot);
            if (freeSpace <= 0) {
              ctx.log("trade", "Cargo full — selling before withdrawing more");
              // Sell what we have first
              await bot.refreshCargo();
              const inCargo = bot.inventory.find(i => i.itemId === candidate.itemId);
              if (inCargo && inCargo.quantity > 0) {
                await bot.exec("sell", { item_id: candidate.itemId, quantity: inCargo.quantity });
                totalSold += inCargo.quantity;
              } else {
                break; // cargo full with other items, can't proceed
              }
              continue;
            }

            // Try to withdraw — if cargo_full, halve and retry
            let wQty = Math.min(remaining, maxItemsForCargo(freeSpace, candidate.itemId));
            if (wQty <= 0) break;
            let wResp = await bot.exec("faction_withdraw_items", { item_id: candidate.itemId, quantity: wQty });
            if (wResp.error && wResp.error.message.includes("cargo_full")) {
              // Parse available space from error or just halve
              const spaceMatch = wResp.error.message.match(/only (\d+) available/);
              if (spaceMatch) {
                const actualSpace = parseInt(spaceMatch[1], 10);
                // Items may weigh more than 1 unit each — estimate per-item weight
                const estWeight = Math.ceil(wQty / Math.max(actualSpace, 1));
                wQty = Math.max(1, Math.floor(actualSpace / Math.max(estWeight, 1)));
              } else {
                wQty = Math.max(1, Math.floor(wQty / 2));
              }
              wResp = await bot.exec("faction_withdraw_items", { item_id: candidate.itemId, quantity: wQty });
            }

            if (wResp.error) {
              if (totalSold > 0) break; // sold some already, good enough
              ctx.log("error", `Withdraw from faction storage failed: ${wResp.error.message} — trying next route`);
              break;
            }

            remaining -= wQty;

            // Sell immediately
            const sResp = await bot.exec("sell", { item_id: candidate.itemId, quantity: wQty });
            if (sResp.error) {
              ctx.log("error", `Sell failed: ${sResp.error.message}`);
              break;
            }
            totalSold += wQty;
            ctx.log("trade", `Batch sold ${wQty}x ${candidate.itemName} (${totalSold} total, ${remaining} remaining in storage)`);
          }

          if (totalSold <= 0) continue;

          route = candidate;
          buyQty = totalSold;
          investedCredits = 0; // faction storage items are free
          alreadySold = true; // items already sold in batch loop
          mapStore.reserveTradeQuantity("", "", candidate.destSystem, candidate.destPoi, candidate.itemId, totalSold);
          ctx.log("trade", `In-station faction sale complete: ${totalSold}x ${candidate.itemName}`);
          break;
        }

        // ── Cross-system faction route: withdraw what fits, travel to sell ──
        const freeSpaceF = getFreeSpace(bot);
        let qty = Math.min(candidate.buyQty, availQty, maxItemsForCargo(freeSpaceF, candidate.itemId));
        if (qty <= 0) {
          ctx.log("trade", "No cargo space for faction withdrawal — trying next route");
          continue;
        }

        let wResp = await bot.exec("faction_withdraw_items", { item_id: candidate.itemId, quantity: qty });
        // If cargo_full, items weigh more than 1 — reduce and retry
        if (wResp.error && wResp.error.message.includes("cargo_full")) {
          const spaceMatch = wResp.error.message.match(/only (\d+) available/);
          if (spaceMatch) {
            const actualSpace = parseInt(spaceMatch[1], 10);
            const estWeight = Math.ceil(qty / Math.max(actualSpace, 1));
            qty = Math.max(1, Math.floor(actualSpace / Math.max(estWeight, 1)));
          } else {
            qty = Math.max(1, Math.floor(qty / 2));
          }
          wResp = await bot.exec("faction_withdraw_items", { item_id: candidate.itemId, quantity: qty });
        }

        if (wResp.error) {
          ctx.log("error", `Withdraw from faction storage failed: ${wResp.error.message} — trying next route`);
          continue;
        }

        route = candidate;
        buyQty = qty;
        investedCredits = 0; // faction storage items are free — all revenue is profit
        mapStore.reserveTradeQuantity("", "", candidate.destSystem, candidate.destPoi, candidate.itemId, qty);
        ctx.log("trade", `Withdrew ${qty}x ${candidate.itemName} from faction storage`);
        break;
      }

      // ── Normal market route: travel to source and buy ──
      yield "travel_to_source";

      if (bot.system !== candidate.sourceSystem) {
        await ensureUndocked(ctx);
        const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
        if (!fueled) {
          ctx.log("error", "Cannot refuel for trade run — waiting 30s");
          await sleep(30000);
          break;
        }

        ctx.log("travel", `Heading to ${candidate.sourcePoiName} in ${candidate.sourceSystem}...`);
        const arrived = await navigateToSystem(ctx, candidate.sourceSystem, safetyOpts);
        if (!arrived) {
          ctx.log("error", "Failed to reach source system — trying next route");
          continue;
        }
      }

      // Only undock/travel if we need to move to a different POI
      if (bot.poi !== candidate.sourcePoi) {
        await ensureUndocked(ctx);
        ctx.log("travel", `Traveling to ${candidate.sourcePoiName}...`);
        const tResp = await bot.exec("travel", { target_poi: candidate.sourcePoi });
        if (tResp.error && !tResp.error.message.includes("already")) {
          ctx.log("error", `Travel to source failed: ${tResp.error.message}`);
          continue;
        }
        bot.poi = candidate.sourcePoi;
      }

      // Dock at source (may already be docked if source = current station)
      yield "dock_source";
      await ensureDocked(ctx);
      bot.docked = true;

      // Withdraw credits from storage
      await bot.refreshStorage();
      const storageResp = await bot.exec("view_storage");
      if (storageResp.result && typeof storageResp.result === "object") {
        const sr = storageResp.result as Record<string, unknown>;
        const storedCredits = (sr.credits as number) || (sr.stored_credits as number) || 0;
        if (storedCredits > 0) {
          await bot.exec("withdraw_credits", { amount: storedCredits });
          ctx.log("trade", `Withdrew ${storedCredits} credits from storage`);
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
          isFactionRoute: candidate.sourcePoi === "",
          isCargoRoute: candidate.sourcePoi === "cargo",
          investedCredits: actualSpent,
        });
        startTradeSession(session);
        ctx.log("trade", `Trade session started: ${session.sessionId}`);
      }

      // Reserve this trade in cached market data so other bots don't chase the same route
      mapStore.reserveTradeQuantity(
        candidate.sourceSystem, candidate.sourcePoi,
        candidate.destSystem, candidate.destPoi,
        candidate.itemId, buyQty,
      );
      break;
    }
    } // End of route selection loop (skipped if recovered session)

    // Fill remaining cargo with station storage items sellable at destination
    if (route && buyQty > 0) {
      await bot.refreshStorage();
      if (bot.storage.length > 0) {
        const destSys = mapStore.getSystem(route.destSystem);
        const destStation = destSys?.pois.find(p => p.id === route.destPoi);
        const destMarket = destStation?.market || [];

        const storageToSell: Array<{ itemId: string; name: string; qty: number }> = [];
        for (const item of bot.storage) {
          const lower = item.itemId.toLowerCase();
          if (lower.includes("fuel") || lower.includes("energy_cell")) continue;
          if (item.itemId === route.itemId) continue; // skip the trade item itself
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
      // Fail any active session
      const activeSession = getActiveSession(bot.username);
      if (activeSession) {
        failTradeSession(bot.username, "No valid route found");
      }
      
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
      await sleep(60000);
      continue;
    }

    // ── Phase 2: Travel to destination and sell ──
    if (alreadySold) {
      // In-station faction route — items already sold in batch loop
      const localRevenue = buyQty * route.sellPrice;
      const localProfit = localRevenue + extraRevenue;
      bot.stats.totalTrades++;
      bot.stats.totalProfit += localProfit;
      await recordMarketData(ctx);
      ctx.log("trade", `Trade run complete: ${buyQty}x ${route.itemName} — profit ${localProfit}cr (${localRevenue}cr trade + ${extraRevenue}cr other sales)`);
      
      // Complete trade session
      const completedSession = completeTradeSession(bot.username, localRevenue, localProfit);
      if (completedSession) {
        ctx.log("trade", `Session completed: ${completedSession.sessionId}`);
      }
      
      await factionDonateProfit(ctx, localProfit);
      yield "post_trade_maintenance";
      await tryRefuel(ctx);
      await repairShip(ctx);
      yield "check_skills";
      await bot.checkSkills();
      continue;
    }

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
        updateTradeSession(bot.username, { 
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
            updateTradeSession(bot.username, { jumpsCompleted: jumpNum });
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
                // Don't abort - we'll find alternative buyer at destination
                return true;
              }
              
              if (investedCredits > 0 && refreshedBuyer.price * buyQty < investedCredits) {
                ctx.log("trade", `Mid-route check (jump ${jumpNum}): price dropped to ${refreshedBuyer.price}cr — will try to minimize loss`);
                // Don't abort - we'll try to sell anyway rather than lose everything
                return true;
              }
              
              ctx.log("trade", `Mid-route check (jump ${jumpNum}): trade valid (${refreshedBuyer.price}cr × ${refreshedBuyer.quantity} at dest)`);
            } else {
              // Original buyer found in cache
              if (destBuyer.quantity <= 0) {
                ctx.log("trade", `Mid-route check (jump ${jumpNum}): buyer quantity is 0 — finding alternative`);
                return true;
              }
              
              if (investedCredits > 0 && destBuyer.price * buyQty < investedCredits) {
                ctx.log("trade", `Mid-route check (jump ${jumpNum}): price dropped to ${destBuyer.price}cr — will try to minimize loss`);
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
          updateTradeSession(bot.username, {
            state: "in_transit",
            notes: (session.notes || "") + " | Network interruption - will retry",
          });
        }

        // Find a station to dock at and wait for network recovery
        await ensureDocked(ctx);
        ctx.log("trade", "Docked and waiting for network recovery — trade session preserved");
        ctx.log("trade", `Session will resume: ${session?.itemId} (${session?.quantityBought}x) → ${session?.destPoiName}`);

        // Wait 60 seconds before next cycle will retry (gives network time to recover)
        await sleep(60000);
        continue;
      }
    }

    // Travel to destination POI
    await ensureUndocked(ctx);
    if (bot.poi !== route.destPoi) {
      ctx.log("travel", `Traveling to ${route.destPoiName}...`);
      const t2Resp = await bot.exec("travel", { target_poi: route.destPoi });
      if (t2Resp.error && !t2Resp.error.message.includes("already")) {
        ctx.log("error", `Travel to dest failed: ${t2Resp.error.message}`);
        // Try to sell wherever we are
        const { pois } = await getSystemInfo(ctx);
        const station = findStation(pois);
        if (station) {
          await bot.exec("travel", { target_poi: station.id });
          bot.poi = station.id;
        }
      } else {
        bot.poi = route.destPoi;
      }
    }

    // Dock at destination
    yield "dock_dest";
    const d2Resp = await bot.exec("dock");
    if (d2Resp.error && !d2Resp.error.message.includes("already")) {
      ctx.log("error", `Dock failed at dest: ${d2Resp.error.message}`);
      continue;
    }
    bot.docked = true;
    await collectFromStorage(ctx);
    await tryMissions(ctx);

    // ── Sell trade items ──
    yield "sell";
    let totalSold = 0;
    let sellRevenue = 0;

    // Attempt to sell at current destination
    await bot.refreshCargo();
    let remaining = bot.inventory.find(i => i.itemId === route.itemId)?.quantity ?? 0;

    if (remaining <= 0) {
      ctx.log("error", `No ${route.itemName} left in cargo (bought ${buyQty}, all consumed during travel)`);
    } else {
      if (remaining < buyQty) {
        ctx.log("trade", `Only ${remaining}/${buyQty}x ${route.itemName} left (${buyQty - remaining} consumed during travel)`);
      }
      ctx.log("trade", `Selling ${remaining}x ${route.itemName} at ${route.sellPrice}cr/ea...`);
      const sellResp = await bot.exec("sell", { item_id: route.itemId, quantity: remaining });
      if (!sellResp.error) {
        const sr = sellResp.result as Record<string, unknown> | undefined;
        const earned = (sr?.credits_earned as number) ?? (sr?.total as number) ?? (sr?.revenue as number) ?? 0;
        // Check how many actually sold
        await bot.refreshCargo();
        const afterSell = bot.inventory.find(i => i.itemId === route.itemId)?.quantity ?? 0;
        const sold = remaining - afterSell;
        totalSold += sold;
        sellRevenue += earned > 0 ? earned : sold * route.sellPrice;
        remaining = afterSell;
        if (remaining > 0) {
          ctx.log("trade", `Sold ${sold}x but ${remaining}x ${route.itemName} still unsold — buyer demand exhausted`);
        }
        // Refresh dest market cache with real post-sale data
        await recordMarketData(ctx);
      } else {
        ctx.log("error", `Sell failed: ${sellResp.error.message}`);
      }
    }

    // If unsold items remain, find another buyer from mapStore
    if (remaining > 0) {
      yield "find_next_buyer";
      const allBuys = mapStore.getAllBuyDemand();
      const buyers = allBuys
        .filter(b => b.itemId === route.itemId && b.price > 0)
        .filter(b => !(b.systemId === bot.system && b.poiId === bot.poi)) // skip current station
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
          if (tResp.error && !tResp.error.message.includes("already")) continue;
          bot.poi = buyer.poiId;
        }

        await ensureDocked(ctx);
        await bot.refreshCargo();
        remaining = bot.inventory.find(i => i.itemId === route.itemId)?.quantity ?? 0;
        if (remaining <= 0) break;

        const sResp = await bot.exec("sell", { item_id: route.itemId, quantity: remaining });
        if (!sResp.error) {
          const sr = sResp.result as Record<string, unknown> | undefined;
          const earned = (sr?.credits_earned as number) ?? (sr?.total as number) ?? (sr?.revenue as number) ?? 0;
          await bot.refreshCargo();
          const afterSell = bot.inventory.find(i => i.itemId === route.itemId)?.quantity ?? 0;
          const sold = remaining - afterSell;
          totalSold += sold;
          sellRevenue += earned > 0 ? earned : sold * buyer.price;
          remaining = afterSell;
          ctx.log("trade", `Sold ${sold}x ${route.itemName} at ${buyer.poiName} (${buyer.price}cr/ea)${remaining > 0 ? ` — ${remaining}x still unsold` : ""}`);
          await recordMarketData(ctx);
        }
        break; // only try one alternative buyer, then fall back to storage
      }
    }

    // If still unsold, deposit at Sol Central storage
    if (remaining > 0) {
      yield "store_unsold";
      const SOL_CENTRAL = "sol_central";
      ctx.log("trade", `${remaining}x ${route.itemName} still unsold — storing at Sol Central`);

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
        await bot.exec("travel", { target_poi: SOL_CENTRAL });
        bot.poi = SOL_CENTRAL;
      }

      await ensureDocked(ctx);
      await bot.refreshCargo();
      remaining = bot.inventory.find(i => i.itemId === route.itemId)?.quantity ?? 0;
      if (remaining > 0) {
        await bot.exec("deposit_items", { item_id: route.itemId, quantity: remaining });
        ctx.log("trade", `Deposited ${remaining}x ${route.itemName} to Sol Central storage`);
      }
    }

    // Deposit any other non-fuel items from cargo to faction/station storage
    // (never sell — these may be crafting materials like durasteel)
    await bot.refreshCargo();
    for (const item of [...bot.inventory]) {
      if (item.itemId === route.itemId) continue;
      const lower = item.itemId.toLowerCase();
      if (lower.includes("fuel") || lower.includes("energy_cell")) continue;
      if (item.quantity <= 0) continue;
      const fResp = await bot.exec("faction_deposit_items", { item_id: item.itemId, quantity: item.quantity });
      if (fResp.error) {
        await bot.exec("deposit_items", { item_id: item.itemId, quantity: item.quantity });
      }
      ctx.log("trade", `Deposited ${item.quantity}x ${item.name} (extra cargo)`);
    }

    // Sell faction storage items at this market too
    const { revenue: fsRevenue2 } = await sellFactionStorageItems(ctx);
    extraRevenue += fsRevenue2;

    // Profit = sell revenue + other sales - cost of market purchases (faction storage is free)
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
    const completedSession = completeTradeSession(bot.username, actualRevenue, actualProfit);
    if (completedSession) {
      ctx.log("trade", `Session completed: ${completedSession.sessionId}`);
    }

    // ── Faction donation (10% of profit) ──
    await factionDonateProfit(ctx, actualProfit);

    // ── Maintenance ──
    yield "post_trade_maintenance";
    await tryRefuel(ctx);
    await repairShip(ctx);

    // ── Check skills ──
    yield "check_skills";
    await bot.checkSkills();

    // ── Check for next trade from current location before returning home ──
    const homeSystem = settings.homeSystem || startSystem;
    yield "seek_next_trade";
    await bot.refreshStatus();
    if (bot.docked) {
      await bot.refreshFactionStorage();
    }
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
    const nextFactionRoutes = findFactionStorageRoutes(ctx, settings, bot.system, nextCargoCapacity);
    const nextRoutes = [...nextCargoRoutes, ...nextMarketRoutes, ...nextFactionRoutes].sort((a, b) => b.totalProfit - a.totalProfit);

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
            await bot.exec("travel", { target_poi: homeStation.id });
            await bot.exec("dock");
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
