import type { Bot, Routine, RoutineContext } from "../bot.js";
import { mapStore } from "../mapstore.js";
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
  readSettings,
  sleep,
} from "./common.js";

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
async function sellFactionStorageItems(ctx: RoutineContext): Promise<number> {
  const { bot } = ctx;
  if (!bot.docked) return 0;

  await bot.refreshFactionStorage();
  if (bot.factionStorage.length === 0) return 0;

  // Get current station's market to check what's sellable
  const marketResp = await bot.exec("view_market");
  if (!marketResp.result || typeof marketResp.result !== "object") return 0;

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

  if (buyableItems.size === 0) return 0;

  // Find faction storage items we can sell here
  const toSell: Array<{ itemId: string; name: string; qty: number }> = [];
  for (const item of bot.factionStorage) {
    const lower = item.itemId.toLowerCase();
    if (lower.includes("fuel") || lower.includes("energy_cell")) continue;
    if (!buyableItems.has(item.itemId)) continue;
    toSell.push({ itemId: item.itemId, name: item.name, qty: item.quantity });
  }

  if (toSell.length === 0) return 0;

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
    ctx.log("trade", `Sold from faction storage: ${soldItems.join(", ")}`);
    await bot.refreshStatus();
  }

  return totalSold;
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

    const settings = getTraderSettings(bot.username);
    const safetyOpts = {
      fuelThresholdPct: settings.refuelThreshold,
      hullThresholdPct: settings.repairThreshold,
      autoCloak: settings.autoCloak,
    };

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

    // ── Priority 1: Sell any non-fuel items already in cargo ──
    yield "sell_cargo";
    await bot.refreshCargo();
    const cargoToSell = bot.inventory.filter(i => {
      if (i.quantity <= 0) return false;
      const lower = i.itemId.toLowerCase();
      return !lower.includes("fuel") && !lower.includes("energy_cell");
    });

    if (cargoToSell.length > 0 && bot.docked) {
      const soldHere: string[] = [];
      const unsold: Array<{ itemId: string; name: string; quantity: number }> = [];

      for (const item of cargoToSell) {
        const sResp = await bot.exec("sell", { item_id: item.itemId, quantity: item.quantity });
        if (!sResp.error) {
          soldHere.push(`${item.quantity}x ${item.name}`);
        } else {
          unsold.push(item);
        }
      }
      if (soldHere.length > 0) {
        ctx.log("trade", `Sold cargo: ${soldHere.join(", ")}`);
        await recordMarketData(ctx);
      }

      // Items that didn't sell here — find a buyer
      for (const item of unsold) {
        if (bot.state !== "running") break;
        await bot.refreshCargo();
        const remaining = bot.inventory.find(i => i.itemId === item.itemId)?.quantity ?? 0;
        if (remaining <= 0) continue;

        // Search mapStore for best buyer
        const allBuys = mapStore.getAllBuyDemand();
        const buyer = allBuys
          .filter(b => b.itemId === item.itemId && b.price > 0)
          .filter(b => !(b.systemId === bot.system && b.poiId === bot.poi))
          .sort((a, b) => b.price - a.price)[0];

        if (buyer) {
          const { jumps } = estimateFuelCost(bot.system, buyer.systemId, settings.fuelCostPerJump);
          if (jumps < 999) {
            ctx.log("trade", `${remaining}x ${item.name} unsellable here — taking to ${buyer.poiName} (${buyer.price}cr/ea, ${jumps} jumps)`);
            if (bot.system !== buyer.systemId) {
              await ensureUndocked(ctx);
              const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct, { noJettison: true });
              if (!fueled) continue;
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
            const nowHave = bot.inventory.find(i => i.itemId === item.itemId)?.quantity ?? 0;
            if (nowHave > 0) {
              const sResp = await bot.exec("sell", { item_id: item.itemId, quantity: nowHave });
              if (!sResp.error) {
                ctx.log("trade", `Sold ${nowHave}x ${item.name} at ${buyer.poiName} (${buyer.price}cr/ea)`);
              }
            }
            await recordMarketData(ctx);
            continue;
          }
        }

        // No buyer found — deposit to station storage
        ctx.log("trade", `No buyer for ${remaining}x ${item.name} — depositing to storage`);
        await bot.exec("deposit_items", { item_id: item.itemId, quantity: remaining });
      }
    }

    // ── Priority 2: Sell station storage items at current market ──
    if (bot.docked) {
      await sellFactionStorageItems(ctx);

      // Sell station storage items that this market buys
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
              ctx.log("trade", `Sold ${qty}x ${item.name} from station storage`);
            } else {
              await bot.exec("deposit_items", { item_id: item.itemId, quantity: qty });
            }
          }
        }
      }
    }

    // ── Priority 3: Find new trade opportunities ──
    yield "find_trades";
    await bot.refreshStatus();
    if (bot.docked) {
      await bot.refreshFactionStorage();
    }
    const cargoCapacity = bot.cargoMax > 0 ? bot.cargoMax : 50;
    const marketRoutes = findTradeOpportunities(settings, bot.system, cargoCapacity);
    const factionRoutes = findFactionStorageRoutes(ctx, settings, bot.system, cargoCapacity);
    let routes = [...marketRoutes, ...factionRoutes].sort((a, b) => b.totalProfit - a.totalProfit);

    if (factionRoutes.length > 0) {
      ctx.log("trade", `Found ${marketRoutes.length} market routes + ${factionRoutes.length} faction storage routes`);
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

    if (routes.length === 0) {
      ctx.log("trade", "No profitable trade routes found — waiting 60s before re-scanning");
      await sleep(60000);
      continue;
    }

    // Try up to 3 routes — skip stale/unavailable ones
    let route: TradeRoute | null = null;
    let buyQty = 0;
    let investedCredits = 0;
    let alreadySold = false; // true if in-station faction route already sold items
    const failedSources = new Set<string>(); // "sourceSystem:sourcePoi:itemId" combos that failed
    let attempts = 0;

    for (let ri = 0; ri < routes.length && attempts < 3; ri++) {
      if (bot.state !== "running") break;
      const candidate = routes[ri];

      // Skip routes with same source+item as a previous failure
      const sourceKey = `${candidate.sourceSystem}:${candidate.sourcePoi}:${candidate.itemId}`;
      if (failedSources.has(sourceKey)) continue;
      attempts++;
      const isFactionRoute = candidate.sourcePoi === "";

      if (isFactionRoute) {
        ctx.log("trade", `Route #${ri + 1}: ${candidate.itemName} — withdraw ${candidate.buyQty}x from faction storage (cost: ${candidate.buyPrice}cr/ea) → sell at ${candidate.destPoiName} (${candidate.sellPrice}cr) — est. profit ${Math.round(candidate.totalProfit)}cr (${candidate.jumps} jumps)`);
      } else {
        ctx.log("trade", `Route #${ri + 1}: ${candidate.itemName} — buy ${candidate.buyQty}x at ${candidate.sourcePoiName} (${candidate.buyPrice}cr) → sell at ${candidate.destPoiName} (${candidate.sellPrice}cr) — est. profit ${Math.round(candidate.totalProfit)}cr (${candidate.jumps} jumps)`);
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
          investedCredits = totalSold * candidate.buyPrice;
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
        investedCredits = qty * candidate.buyPrice; // material cost basis
        mapStore.reserveTradeQuantity("", "", candidate.destSystem, candidate.destPoi, candidate.itemId, qty);
        ctx.log("trade", `Withdrew ${qty}x ${candidate.itemName} from faction storage (material cost: ${investedCredits}cr)`);
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

      if (qty <= 0 && alreadyHave <= 0) {
        ctx.log("trade", "Cannot afford any items or cargo full — trying next route");
        continue;
      }

      // Buy items (skip if we already have enough)
      yield "buy";
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
      route = candidate;
      buyQty = qty + alreadyHave;
      investedCredits = qty * candidate.buyPrice; // only count newly purchased items
      if (qty > 0) {
        ctx.log("trade", `Purchased ${qty}x ${candidate.itemName} for ${investedCredits}cr${alreadyHave > 0 ? ` (+${alreadyHave}x already in cargo)` : ""}`);
      }

      // Reserve this trade in cached market data so other bots don't chase the same route
      mapStore.reserveTradeQuantity(
        candidate.sourceSystem, candidate.sourcePoi,
        candidate.destSystem, candidate.destPoi,
        candidate.itemId, buyQty,
      );
      break;
    }

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

    // No route worked — wait and retry
    if (!route || buyQty <= 0) {
      ctx.log("trade", "All routes failed — waiting 60s before re-scanning");
      await sleep(60000);
      continue;
    }

    // ── Phase 2: Travel to destination and sell ──
    if (alreadySold) {
      // In-station faction route — items already sold in batch loop
      const localProfit = buyQty * (route.sellPrice - route.buyPrice);
      bot.stats.totalTrades++;
      bot.stats.totalProfit += localProfit;
      await recordMarketData(ctx);
      ctx.log("trade", `Trade run complete: ${buyQty}x ${route.itemName} — sold at ${route.destPoiName} (${route.sellPrice}cr/ea) — profit ${localProfit}cr`);
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
      const arrived2 = await navigateToSystem(ctx, route.destSystem, cargoSafetyOpts);
      if (!arrived2) {
        ctx.log("error", "Failed to reach destination — selling at nearest station");
        await ensureDocked(ctx);
        await bot.exec("sell", { item_id: route.itemId, quantity: buyQty });
        await bot.refreshStatus();
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
    await sellFactionStorageItems(ctx);

    // Profit = sell revenue minus cost of newly purchased goods
    const actualProfit = sellRevenue - investedCredits;
    bot.stats.totalTrades++;
    bot.stats.totalProfit += actualProfit;

    // Record market data
    await recordMarketData(ctx);

    // ── Trade summary ──
    const soldLabel = totalSold < buyQty ? `${totalSold}/${buyQty}` : `${buyQty}`;
    ctx.log("trade", `Trade run complete: ${soldLabel}x ${route.itemName} — profit ${actualProfit}cr (${route.jumps} jumps)`);

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
    const nextMarketRoutes = findTradeOpportunities(settings, bot.system, cargoCapacity);
    const nextFactionRoutes = findFactionStorageRoutes(ctx, settings, bot.system, cargoCapacity);
    const nextRoutes = [...nextMarketRoutes, ...nextFactionRoutes].sort((a, b) => b.totalProfit - a.totalProfit);

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
