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
  maxItemsForCargo,
  readSettings,
  sleep,
} from "./common.js";

// ── Settings ─────────────────────────────────────────────────

function getFactionTraderSettings(username?: string): {
  homeSystem: string;
  refuelThreshold: number;
  repairThreshold: number;
  minSellPrice: number;
  tradeItems: string[];
} {
  const all = readSettings();
  const t = all.faction_trader || {};
  const botOverrides = username ? (all[username] || {}) : {};
  return {
    homeSystem: (botOverrides.homeSystem as string) || (t.homeSystem as string) || "",
    refuelThreshold: (t.refuelThreshold as number) || 50,
    repairThreshold: (t.repairThreshold as number) || 40,
    minSellPrice: (t.minSellPrice as number) || 0,
    tradeItems: Array.isArray(t.tradeItems) ? (t.tradeItems as string[]) : [],
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
  jumps: number;
  totalRevenue: number;
}

// ── Helpers ──────────────────────────────────────────────────

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

/** Find sell routes for items currently in faction storage. */
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

    for (const buy of buyers) {
      if (settings.minSellPrice > 0 && buy.price < settings.minSellPrice) continue;

      const { jumps } = estimateFuelCost(currentSystem, buy.systemId);
      if (jumps >= 999) continue;

      const qty = Math.min(item.quantity, buy.quantity, maxItemsForCargo(cargoCapacity, item.itemId));
      if (qty <= 0) continue;

      routes.push({
        itemId: item.itemId,
        itemName: item.name,
        availableQty: item.quantity,
        destSystem: buy.systemId,
        destPoi: buy.poiId,
        destPoiName: buy.poiName,
        sellPrice: buy.price,
        sellQty: qty,
        jumps,
        totalRevenue: qty * buy.price,
      });
      break; // best buyer for this item
    }
  }

  routes.sort((a, b) => b.totalRevenue - a.totalRevenue);
  return routes;
}

// ── Main routine ─────────────────────────────────────────────

export const factionTraderRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  await bot.refreshStatus();
  const startSystem = bot.system;

  while (bot.state === "running") {
    const settings = getFactionTraderSettings(bot.username);
    const safetyOpts = {
      fuelThresholdPct: settings.refuelThreshold,
      hullThresholdPct: settings.repairThreshold,
    };

    // ── Dock, record market ──
    yield "dock";
    await ensureDocked(ctx);
    if (bot.docked) {
      await recordMarketData(ctx);
    }

    // ── Maintenance ──
    yield "maintenance";
    await tryRefuel(ctx);
    await repairShip(ctx);

    // ── Clear cargo before planning (dump non-fuel items to faction storage) ──
    yield "clear_cargo";
    await bot.refreshCargo();
    if (bot.inventory.length > 0) {
      for (const item of [...bot.inventory]) {
        if (item.quantity <= 0) continue;
        const lower = item.itemId.toLowerCase();
        if (lower.includes("fuel") || lower.includes("energy_cell")) continue;
        const fResp = await bot.exec("faction_deposit_items", { item_id: item.itemId, quantity: item.quantity });
        if (fResp.error) {
          await bot.exec("deposit_items", { item_id: item.itemId, quantity: item.quantity });
        }
      }
    }

    // ── Find sell routes from faction storage ──
    yield "find_sales";
    await bot.refreshFactionStorage();
    await bot.refreshStatus();
    const cargoCapacity = bot.cargoMax > 0 ? bot.cargoMax : 50;
    const routes = findFactionSellRoutes(ctx, settings, bot.system, cargoCapacity);

    if (routes.length === 0) {
      ctx.log("trade", "No faction storage items to sell — waiting 60s");
      await sleep(60000);
      continue;
    }

    const route = routes[0];
    ctx.log("trade", `Faction sale: ${route.sellQty}x ${route.itemName} → ${route.destPoiName} (${route.sellPrice}cr/ea, ${route.jumps} jumps, est. ${route.totalRevenue}cr)`);

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
          // Cargo full of other items — dump non-fuel items to faction storage
          let freed = false;
          for (const item of [...bot.inventory]) {
            if (item.quantity <= 0) continue;
            const lower = item.itemId.toLowerCase();
            if (lower.includes("fuel") || lower.includes("energy_cell")) continue;
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

      // Clear non-fuel cargo to make room — deposit back to faction storage (fallback: station)
      await bot.refreshCargo();
      if (bot.inventory.length > 0) {
        const deposited: string[] = [];
        for (const item of [...bot.inventory]) {
          if (item.quantity <= 0) continue;
          const lower = item.itemId.toLowerCase();
          if (lower.includes("fuel") || lower.includes("energy_cell")) continue;
          const fResp = await bot.exec("faction_deposit_items", { item_id: item.itemId, quantity: item.quantity });
          if (fResp.error) {
            await bot.exec("deposit_items", { item_id: item.itemId, quantity: item.quantity });
          }
          deposited.push(`${item.quantity}x ${item.name}`);
        }
        if (deposited.length > 0) {
          ctx.log("trade", `Cleared cargo: ${deposited.join(", ")} → faction storage`);
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

      // Return home
      const homeSystem = settings.homeSystem || startSystem;
      if (homeSystem && bot.system !== homeSystem) {
        yield "return_home";
        ctx.log("travel", `Returning to home system ${homeSystem}...`);
        await ensureUndocked(ctx);
        const homeFueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
        if (homeFueled) {
          await navigateToSystem(ctx, homeSystem, safetyOpts);
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
