/**
 * Faction Trader routine — liquidates items from faction storage.
 *
 * Unlike the full trader, this routine never buys from markets.
 * It withdraws items from faction storage and sells them at the
 * best known buyer station, then returns home.
 */
import type { Bot, Routine, RoutineContext } from "../bot.js";
import { mapStore } from "../mapstore.js";
import {
  ensureDocked,
  ensureUndocked,
  tryRefuel,
  repairShip,
  ensureFueled,
  navigateToSystem,
  recordMarketData,
  factionDonateProfit,
  detectAndRecoverFromDeath,
  maxItemsForCargo,
  readSettings,
  sleep,
} from "./common.js";

// ── Settings ─────────────────────────────────────────────────

function getFactionTraderSettings(username?: string): {
  homeSystem: string;
  homeStation: string;
  fuelCostPerJump: number;
  refuelThreshold: number;
  repairThreshold: number;
  minSellPrice: number;
  tradeItems: string[];
  stationPriority: boolean;
} {
  const all = readSettings();
  const general = all.general || {};
  const t = all.faction_trader || {};
  const botOverrides = username ? (all[username] || {}) : {};
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
    tradeItems: Array.isArray(t.tradeItems) ? (t.tradeItems as string[]) : [],
    stationPriority: (botOverrides.stationPriority as boolean) || false,
  };
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

/** Free cargo weight (not item count — callers must divide by item size). */
function getFreeSpace(bot: Bot): number {
  if (bot.cargoMax <= 0) return 999;
  return Math.max(0, bot.cargoMax - bot.cargo);
}

/** Estimate fuel cost between two systems using mapStore route data. */
function estimateFuelCost(fromSystem: string, toSystem: string, costPerJump: number = 50): { jumps: number; cost: number } {
  if (fromSystem === toSystem) return { jumps: 0, cost: 0 };
  const route = mapStore.findRoute(fromSystem, toSystem);
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
): FactionSellRoute[] {
  const { bot } = ctx;
  const routes: FactionSellRoute[] = [];
  if (bot.factionStorage.length === 0) return routes;

  const allBuys = mapStore.getAllBuyDemand();
  if (allBuys.length === 0) return routes;

  const homeSystem = settings.homeSystem || currentSystem;
  const costPerJump = settings.fuelCostPerJump;

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

    // Find best buyer for this item
    const buyers = allBuys
      .filter(b => b.itemId === item.itemId && b.price > 0)
      .sort((a, b) => b.price - a.price);

    // Material cost = cheapest known market price (what this item is worth)
    const materialCost = getItemMarketCost(item.itemId);

    for (const buy of buyers) {
      if (settings.minSellPrice > 0 && buy.price < settings.minSellPrice) continue;

      // Round-trip fuel: current → dest + dest → home
      const toDest = estimateFuelCost(currentSystem, buy.systemId, costPerJump);
      const returnHome = estimateFuelCost(buy.systemId, homeSystem, costPerJump);
      if (toDest.jumps >= 999) continue;
      const roundTripJumps = toDest.jumps + (returnHome.jumps < 999 ? returnHome.jumps : 0);
      const roundTripFuel = toDest.cost + (returnHome.jumps < 999 ? returnHome.cost : 0);

      const qty = Math.min(item.quantity, buy.quantity, maxItemsForCargo(cargoCapacity, item.itemId));
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

  while (bot.state === "running") {
    // ── Death recovery ──
    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) { await sleep(30000); continue; }

    const settings = getFactionTraderSettings(bot.username);
    const safetyOpts = {
      fuelThresholdPct: settings.refuelThreshold,
      hullThresholdPct: settings.repairThreshold,
    };

    // ── Dock (also records market data + analyzes market) ──
    yield "dock";
    await ensureDocked(ctx);

    // ── Maintenance ──
    yield "maintenance";
    await tryRefuel(ctx);
    await repairShip(ctx);

    // ── Clear cargo before planning — deposit everything, keep minimal fuel reserve ──
    yield "clear_cargo";
    await bot.refreshCargo();
    if (bot.inventory.length > 0) {
      const FUEL_RESERVE = 5; // keep a few fuel cells for short jumps; ensureFueled handles the rest
      let fuelKept = 0;
      for (const item of [...bot.inventory]) {
        if (item.quantity <= 0) continue;
        const lower = item.itemId.toLowerCase();
        const isFuel = lower.includes("fuel") || lower.includes("energy_cell");
        if (isFuel) {
          // Keep up to FUEL_RESERVE, deposit the excess
          const keep = Math.min(item.quantity, Math.max(0, FUEL_RESERVE - fuelKept));
          fuelKept += keep;
          const excess = item.quantity - keep;
          if (excess <= 0) continue;
          const fResp = await bot.exec("faction_deposit_items", { item_id: item.itemId, quantity: excess });
          if (fResp.error) {
            await bot.exec("deposit_items", { item_id: item.itemId, quantity: excess });
          }
        } else {
          const fResp = await bot.exec("faction_deposit_items", { item_id: item.itemId, quantity: item.quantity });
          if (fResp.error) {
            await bot.exec("deposit_items", { item_id: item.itemId, quantity: item.quantity });
          }
        }
      }
    }

    // ── Find sell routes from faction storage ──
    yield "find_sales";
    await bot.refreshFactionStorage();
    await bot.refreshStatus();
    const cargoCapacity = bot.cargoMax > 0 ? bot.cargoMax : 50;
    let routes = findFactionSellRoutes(ctx, settings, bot.system, cargoCapacity);

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
      ctx.log("trade", "No faction storage items to sell — waiting 60s");
      await sleep(60000);
      continue;
    }

    const route = routes[0];
    const routeLabel = route.roundTripJumps > route.jumps
      ? `${route.jumps} jumps out, ${route.roundTripJumps} round-trip`
      : `${route.jumps} jumps`;
    ctx.log("trade", `Faction sale: ${route.sellQty}x ${route.itemName} → ${route.destPoiName} (${route.sellPrice}cr/ea, ${routeLabel}, profit ~${Math.round(route.totalProfit)}cr)`);

    const isInStation = route.jumps === 0 && route.destSystem === bot.system;

    if (isInStation) {
      // ── In-station: batch withdraw→sell loop ──
      let totalSold = 0;
      let remaining = route.availableQty;

      while (remaining > 0 && bot.state === "running") {
        await bot.refreshStatus();
        const freeSpace = getFreeSpace(bot);
        if (freeSpace <= 0) {
          await bot.refreshCargo();
          // First try to sell the trade item we already have
          const inCargo = bot.inventory.find(i => i.itemId === route.itemId);
          if (inCargo && inCargo.quantity > 0) {
            await bot.exec("sell", { item_id: route.itemId, quantity: inCargo.quantity });
            totalSold += inCargo.quantity;
            continue;
          }
          // Cargo full of other items (including fuel) — dump all to faction storage
          let freed = false;
          for (const item of [...bot.inventory]) {
            if (item.quantity <= 0) continue;
            const fResp = await bot.exec("faction_deposit_items", { item_id: item.itemId, quantity: item.quantity });
            if (fResp.error) {
              await bot.exec("deposit_items", { item_id: item.itemId, quantity: item.quantity });
            }
            freed = true;
          }
          if (!freed) break;
          continue;
        }

        let wQty = Math.min(remaining, maxItemsForCargo(freeSpace, route.itemId));
        if (wQty <= 0) break;
        let wResp = await bot.exec("faction_withdraw_items", { item_id: route.itemId, quantity: wQty });
        if (wResp.error && wResp.error.message.includes("cargo_full")) {
          wQty = Math.max(1, Math.floor(wQty / 2));
          wResp = await bot.exec("faction_withdraw_items", { item_id: route.itemId, quantity: wQty });
        }
        if (wResp.error) {
          if (totalSold > 0) break;
          ctx.log("error", `Withdraw failed: ${wResp.error.message}`);
          break;
        }

        remaining -= wQty;

        const sResp = await bot.exec("sell", { item_id: route.itemId, quantity: wQty });
        if (sResp.error) {
          ctx.log("error", `Sell failed: ${sResp.error.message}`);
          break;
        }
        totalSold += wQty;
        ctx.log("trade", `Sold ${wQty}x ${route.itemName} (${totalSold} total, ${remaining} remaining)`);
      }

      if (totalSold > 0) {
        await bot.refreshStatus();
        await recordMarketData(ctx);
        const revenue = totalSold * route.sellPrice;
        bot.stats.totalTrades++;
        bot.stats.totalProfit += revenue;
        ctx.log("trade", `Faction sale complete: ${totalSold}x ${route.itemName} — ${revenue}cr revenue`);
        await factionDonateProfit(ctx, revenue);
      }
    } else {
      // ── Cross-system: withdraw, travel, sell ──
      yield "withdraw_faction";
      await ensureDocked(ctx);

      // Clear ALL cargo to make room — keep only fuel cells needed for the round trip
      await bot.refreshCargo();
      if (bot.inventory.length > 0) {
        const fuelReserve = Math.max(3, route.roundTripJumps + 2); // round trip + buffer
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
            const fResp = await bot.exec("faction_deposit_items", { item_id: item.itemId, quantity: excess });
            if (fResp.error) {
              await bot.exec("deposit_items", { item_id: item.itemId, quantity: excess });
            }
            deposited.push(`${excess}x ${item.name}`);
          } else {
            const fResp = await bot.exec("faction_deposit_items", { item_id: item.itemId, quantity: item.quantity });
            if (fResp.error) {
              await bot.exec("deposit_items", { item_id: item.itemId, quantity: item.quantity });
            }
            deposited.push(`${item.quantity}x ${item.name}`);
          }
        }
        if (deposited.length > 0) {
          ctx.log("trade", `Cleared cargo: ${deposited.join(", ")} → storage (kept ${fuelKept} fuel cells)`);
        }
      }
      await bot.refreshCargo();
      await bot.refreshStatus();

      const freeSpace = getFreeSpace(bot);
      let qty = Math.min(route.sellQty, route.availableQty, maxItemsForCargo(freeSpace, route.itemId));
      if (qty <= 0) {
        ctx.log("trade", "No cargo space for faction withdrawal — skipping");
        await sleep(30000);
        continue;
      }

      let wResp = await bot.exec("faction_withdraw_items", { item_id: route.itemId, quantity: qty });
      if (wResp.error && wResp.error.message.includes("cargo_full")) {
        qty = Math.max(1, Math.floor(qty / 2));
        wResp = await bot.exec("faction_withdraw_items", { item_id: route.itemId, quantity: qty });
      }
      if (wResp.error) {
        ctx.log("error", `Withdraw failed: ${wResp.error.message}`);
        await sleep(30000);
        continue;
      }
      ctx.log("trade", `Withdrew ${qty}x ${route.itemName} from faction storage`);

      // Travel to destination
      yield "travel_to_dest";
      await ensureUndocked(ctx);
      const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct, { noJettison: true });
      if (!fueled) {
        ctx.log("error", "Cannot refuel — selling locally instead");
        await ensureDocked(ctx);
        await bot.exec("sell", { item_id: route.itemId, quantity: qty });
        await bot.refreshStatus();
        continue;
      }

      if (bot.system !== route.destSystem) {
        ctx.log("travel", `Heading to ${route.destPoiName} in ${route.destSystem}...`);
        const arrived = await navigateToSystem(ctx, route.destSystem, { ...safetyOpts, noJettison: true });
        if (!arrived) {
          ctx.log("error", "Failed to reach destination — selling locally");
          await ensureDocked(ctx);
          await bot.exec("sell", { item_id: route.itemId, quantity: qty });
          await bot.refreshStatus();
          continue;
        }
      }

      await ensureUndocked(ctx);
      if (bot.poi !== route.destPoi) {
        await bot.exec("travel", { target_poi: route.destPoi });
        bot.poi = route.destPoi;
      }

      // Dock and sell
      yield "sell";
      await ensureDocked(ctx);
      await bot.refreshCargo();
      const inCargo = bot.inventory.find(i => i.itemId === route.itemId)?.quantity ?? 0;
      if (inCargo > 0) {
        const sResp = await bot.exec("sell", { item_id: route.itemId, quantity: inCargo });
        if (!sResp.error) {
          const revenue = inCargo * route.sellPrice;
          bot.stats.totalTrades++;
          bot.stats.totalProfit += revenue;
          ctx.log("trade", `Sold ${inCargo}x ${route.itemName} at ${route.destPoiName} — ${revenue}cr revenue`);
          await factionDonateProfit(ctx, revenue);
        } else {
          ctx.log("error", `Sell failed: ${sResp.error.message}`);
        }
      }
      await recordMarketData(ctx);
    }

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
  }
};
