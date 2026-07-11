/**
 * Craft Trade routine.
 *
 * A single combined routine coordinating two roles:
 *  - TRADERS (10+): find profitable deals for *craftable* items, write build
 *    orders to data/craft_trade_orders.json, then wait for the crafter to
 *    produce the items into faction storage, withdraw, and sell.
 *  - CRAFTER (1): read open build orders and craft them on owned facilities,
 *    depositing outputs to faction storage.
 *
 * Deal sources: mapStore price spreads PLUS analyze_market insights (reusing
 * trader.ts logic). Coordination is via the persisted order file; an in-memory
 * chat ping just wakes the crafter (the file is the source of truth).
 */
import type { Bot, Routine, RoutineContext } from "../bot.js";
import { botChatChannel } from "../bot_chat_channel.js";
import {
  ensureDocked,
  tryRefuel,
  repairShip,
  detectAndRecoverFromDeath,
  maxItemsForCargo,
  recordMarketData,
  navigateToSystem,
  sanitizeCredits,
  factionDonateProfit,
  checkBattleAfterCommand,
} from "./common.js";
import {
  fetchAllRecipes,
  fetchFactionFacilities,
  buildOwnFacilityRecipeMap,
  resolveVenueForRecipe,
  queueCraftJob,
  getFacilityRecipeMap,
  type Recipe,
  type ResolvedVenue,
  type CrafterSettings,
} from "./crafter.js";
import {
  findTradeOpportunities,
  getItemMarketCost,
} from "./trader.js";
import {
  isValidDestination,
  calculateFactionOptimalSellQuantity,
} from "./faction_trader.js";
import {
  acquireBuyOrderLock,
  releaseBuyOrderLock,
} from "./factionTraderCoordination.js";
import {
  addOrder,
  getOpenOrders,
  getOrdersForCrafter,
  getOrdersForTrader,
  markCrafting,
  markReady,
  markSold,
  markFailed,
  expireStaleOrders,
  countOpenOrdersForTrader,
  type CraftOrder,
} from "./craftTradeOrders.js";

// ── Settings ─────────────────────────────────────────────────

interface CraftTradeSettings {
  crafterBots: string[];
  traderBots: string[];
  enabledCategories: string[];
  minProfitPerUnit: number;
  minFacilityAlertProfit: number;
  maxDealQty: number;
  maxCargoValue: number;
  fuelCostPerJump: number;
  refuelThreshold: number;
  repairThreshold: number;
  homeSystem: string;
  homeStation: string;
  useAnalyzeMarket: boolean;
  forceOwnFacility: boolean;
  craftingPreset: string;
  blacklistedRecipes: string[];
  maxConcurrentOrders: number;
  orderTimeoutMin: number;
  minMarginPct: number;
}

function getCraftTradeSettings(username?: string): CraftTradeSettings {
  const { readFileSync, existsSync } = require("fs");
  const { join } = require("path");
  const file = join(process.cwd(), "data", "settings.json");
  const raw = existsSync(file) ? JSON.parse(readFileSync(file, "utf-8") || "{}") : {};
  const t = (raw.craft_trade as Record<string, unknown>) || {};
  const general = (raw.general as Record<string, unknown>) || {};
  const botOverrides = username ? (raw[username] as Record<string, unknown>) || {} : {};

  const arr = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]).filter(x => typeof x === "string") : []);

  return {
    crafterBots: arr(t.crafterBots),
    traderBots: arr(t.traderBots),
    enabledCategories: (t.enabledCategories as string[]) ||
      ["Refining", "Components", "Consumables"],
    minProfitPerUnit: (t.minProfitPerUnit as number) || 10,
    minFacilityAlertProfit: (t.minFacilityAlertProfit as number) || 100000,
    maxDealQty: (t.maxDealQty as number) || 0,
    maxCargoValue: (t.maxCargoValue as number) || 0,
    fuelCostPerJump: (t.fuelCostPerJump as number) || 50,
    refuelThreshold: (t.refuelThreshold as number) || 50,
    repairThreshold: (t.repairThreshold as number) || 40,
    homeSystem: (botOverrides.homeSystem as string) || (t.homeSystem as string) ||
      (general.factionStorageSystem as string) || "",
    homeStation: (botOverrides.homeStation as string) || (t.homeStation as string) ||
      (general.factionStorageStation as string) || "",
    useAnalyzeMarket: (t.useAnalyzeMarket as boolean) ?? true,
    forceOwnFacility: (t.forceOwnFacility as boolean) ?? true,
    craftingPreset: (t.craftingPreset as string) || "fast",
    blacklistedRecipes: arr(t.blacklistedRecipes),
    maxConcurrentOrders: (t.maxConcurrentOrders as number) || 3,
    orderTimeoutMin: (t.orderTimeoutMin as number) || 360,
    minMarginPct: (t.minMarginPct as number) || 10,
  };
}

// Per-cycle dedup for trader "uncraftable" red alerts (avoid spam).
const alertedUncraftable = new Map<string, number>();

// ── Main routine ─────────────────────────────────────────────

export const craftTradeRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;
  const myName = bot.username;
  const settings = getCraftTradeSettings(myName);

  const isCrafter = settings.crafterBots.includes(myName);
  const isTrader = settings.traderBots.includes(myName);

  if (isCrafter) {
    yield "crafter_init";
    yield* crafterLoop(ctx, settings);
  } else if (isTrader) {
    yield "trader_init";
    yield* traderLoop(ctx, settings);
  } else {
    ctx.log("info", `craft_trade: ${myName} not assigned as crafter or trader — idling`);
    while (bot.state === "running") {
      yield "idle";
      await ctx.sleep(60000);
    }
  }
};

// ── Trader loop ──────────────────────────────────────────────

function buildTraderSettingsShim(s: CraftTradeSettings): Parameters<typeof findTradeOpportunities>[0] {
  return {
    tradeItems: [],
    minProfitPerUnit: s.minProfitPerUnit,
    fuelCostPerJump: s.fuelCostPerJump,
    maxCargoValue: s.maxCargoValue,
  } as unknown as Parameters<typeof findTradeOpportunities>[0];
}

async function* traderLoop(ctx: RoutineContext, s: CraftTradeSettings): AsyncGenerator<string, void, void> {
  const { bot } = ctx;

  while (bot.state === "running") {
    yield "recover";
    await detectAndRecoverFromDeath(ctx);
    if (bot.state !== "running") break;

    yield "dock";
    await ensureDocked(ctx);
    await tryRefuel(ctx);
    await repairShip(ctx);

    yield "refresh_storage";
    await bot.refreshFactionStorage(true);

    // Gather fresh market intelligence.
    let marketInsights: Array<Record<string, unknown>> = [];
    if (s.useAnalyzeMarket) {
      try {
        const resp = await bot.exec("analyze_market");
        if (!resp.error && resp.result) {
          const r = resp.result as Record<string, unknown>;
          marketInsights = (r.insights as Array<Record<string, unknown>>) || [];
        }
      } catch { /* analyze best-effort */ }
      await recordMarketData(ctx);
    }

    yield "discover_deals";
    const recipes = await fetchAllRecipes(ctx);
    const factionFacilities = await fetchFactionFacilities(bot);
    buildOwnFacilityRecipeMap(factionFacilities);

    // output_item_id -> recipe + catalog facility type.
    const outputItemToRecipe = new Map<string, { recipe: Recipe; facilityType: string }>();
    const facilityRecipeMap = getFacilityRecipeMap();
    const facTypeByRecipe = new Map<string, string>();
    for (const f of facilityRecipeMap) facTypeByRecipe.set(f.recipeId, f.facilityType);
    for (const recipe of recipes) {
      const cat = (recipe.category || "").toLowerCase();
      if (s.enabledCategories.length > 0 && !s.enabledCategories.map(c => c.toLowerCase()).includes(cat)) continue;
      if (s.blacklistedRecipes.includes(recipe.recipe_id)) continue;
      outputItemToRecipe.set(recipe.output_item_id.toLowerCase(), {
        recipe,
        facilityType: facTypeByRecipe.get(recipe.recipe_id) || recipe.category || recipe.name,
      });
    }

    const shim = buildTraderSettingsShim(s);
    const cargoCapacity = bot.cargoMax || 999;
    const routes = findTradeOpportunities(shim, bot.system, bot.poi, cargoCapacity, marketInsights);

    let ordersCreated = 0;
    for (const route of routes) {
      if (bot.state !== "running") break;
      const entry = outputItemToRecipe.get(route.itemId.toLowerCase());

      if (entry) {
        // Craftable — request a build order.
        const recipe = entry.recipe;
        const estCost = estimateCraftCost(recipe);
        const expectedRevenue = route.sellPrice * route.buyQty;
        if (route.totalProfit <= 0) continue;
        if (expectedRevenue < estCost * (1 + s.minMarginPct / 100)) {
          ctx.log("trade", `Skipping ${recipe.output_name}: margin too thin (rev ${expectedRevenue} < cost ${Math.round(estCost)} x1.${s.minMarginPct})`);
          continue;
        }
        const quantity = Math.min(
          s.maxDealQty > 0 ? s.maxDealQty : Infinity,
          route.buyQty,
          maxItemsForCargo(cargoCapacity, route.itemId),
        );
        if (quantity <= 0) continue;
        if (countOpenOrdersForTrader(bot.username) >= s.maxConcurrentOrders) {
          ctx.log("trade", `Max concurrent orders (${s.maxConcurrentOrders}) reached — stopping discovery`);
          break;
        }
        const existing = addOrder({
          itemId: route.itemId,
          itemName: route.itemName,
          recipeId: recipe.recipe_id,
          facilityType: entry.facilityType,
          quantity,
          requestingTrader: bot.username,
          destSystem: route.destSystem,
          destPoi: route.destPoi,
          destPoiName: route.destPoiName,
          sellPrice: route.sellPrice,
          expectedRevenue,
          estCost,
        });
        ordersCreated++;
        ctx.log("trade", `Requested craft order ${existing.orderId} for ${quantity}x ${recipe.output_name} → sell @ ${route.destPoiName} (${route.sellPrice}cr, profit ~${Math.round(route.totalProfit)})`);
        // Best-effort ping to the crafter(s).
        for (const crafter of s.crafterBots) {
          ctx.sendBotChat?.(`craft ${route.itemId} ${quantity}`, "coordination", [crafter], { orderId: existing.orderId });
        }
      } else if (route.totalProfit >= s.minFacilityAlertProfit) {
        // Profitable buyer but NO recipe exists at all — uncraftable alert.
        const key = route.itemId;
        const last = alertedUncraftable.get(key) || 0;
        if (Date.now() - last > 30 * 60 * 1000) {
          alertedUncraftable.set(key, Date.now());
          ctx.log("alert", `🔴 UNCRAFTABLE: ${route.itemName} has profitable buyers (~${Math.round(route.totalProfit)}cr @ ${route.destPoiName}) but NO recipe exists — cannot be built by any facility`);
        }
      }
    }

    yield "fulfill_orders";
    const myOrders = getOrdersForTrader(bot.username);
    for (const order of myOrders) {
      if (bot.state !== "running") break;
      if (order.status === "sold" || order.status === "failed" || order.status === "expired") continue;
      await fulfillOrder(ctx, bot, s, order);
    }

    yield "expire";
    const expired = expireStaleOrders(s.orderTimeoutMin);
    if (expired > 0) ctx.log("trade", `Expired ${expired} stale craft_trade order(s)`);

    if (ordersCreated === 0) {
      ctx.log("trade", "No new craftable deals this cycle");
    }

    yield "sleep";
    await ctx.sleep(45000);
  }
}

function estimateCraftCost(recipe: Recipe): number {
  let cost = 0;
  for (const comp of recipe.components) {
    const market = getItemMarketCost(comp.item_id);
    cost += (market > 0 ? market : 0) * comp.quantity;
  }
  return cost;
}

// ── Sell a crafted order: withdraw from faction storage → travel → sell ──

async function fulfillOrder(
  ctx: RoutineContext,
  bot: Bot,
  s: CraftTradeSettings,
  order: CraftOrder,
): Promise<void> {
  const { log } = ctx;

  // Navigate to the faction-storage (home) station and withdraw.
  if (s.homeSystem && bot.system !== s.homeSystem) {
    log("travel", `Traveling to home ${s.homeSystem} to withdraw from faction storage`);
    await navigateToSystem(ctx, s.homeSystem, {
      fuelThresholdPct: s.refuelThreshold,
      hullThresholdPct: s.repairThreshold,
    });
  }
  await ensureDocked(ctx);
  await bot.refreshFactionStorage(true);
  const available = (bot.factionStorage || [])
    .filter(i => i.itemId.toLowerCase() === order.itemId.toLowerCase())
    .reduce((a, i) => a + i.quantity, 0);

  if (available < 1) {
    // Not ready yet — crafter may still be working or item consumed.
    if (order.status === "ready") {
      log("trade", `${order.itemName} marked ready but not found in faction storage (${available}) — waiting`);
    }
    return;
  }

  const qty = Math.min(available, order.quantity);
  log("trade", `Withdrawing ${qty}x ${order.itemName} from faction storage`);
  const wResp = await bot.exec("storage", { action: "withdraw", target: "faction", item_id: order.itemId, quantity: qty });
  if (wResp.error) {
    log("error", `Withdraw from faction storage failed: ${wResp.error.message}`);
    return;
  }
  await bot.refreshCargo();
  const cargoQty = bot.inventory.find(i => i.itemId.toLowerCase() === order.itemId.toLowerCase())?.quantity ?? 0;
  if (cargoQty <= 0) {
    log("error", `Withdraw returned no ${order.itemName} in cargo`);
    return;
  }

  // Travel to the buyer's station.
  if (order.destSystem && bot.system !== order.destSystem) {
    await navigateToSystem(ctx, order.destSystem, {
      fuelThresholdPct: s.refuelThreshold,
      hullThresholdPct: s.repairThreshold,
    });
  }
  await ensureDocked(ctx);

  if (!isValidDestination(ctx, order.destSystem, order.destPoi)) {
    log("error", `Destination ${order.destPoiName} invalid — depositing ${cargoQty}x ${order.itemName} back to faction storage`);
    await returnUnsold(ctx, bot, s, order.itemId, cargoQty);
    return;
  }

  // Acquire a buy-order lock so two traders don't sell the same buyer.
  const lockKeyPrice = order.sellPrice;
  const lockAcquired = acquireBuyOrderLock({
    botUsername: bot.username,
    itemId: order.itemId,
    itemName: order.itemName,
    destSystem: order.destSystem,
    destPoi: order.destPoi,
    destPoiName: order.destPoiName,
    pricePerUnit: lockKeyPrice,
    quantityCommitted: cargoQty,
    sessionId: `ct_${order.orderId}`,
  });
  if (!lockAcquired) {
    log("trade", `Buy order @ ${order.destPoiName} (${lockKeyPrice}cr) locked by another bot — skipping`);
    await returnUnsold(ctx, bot, s, order.itemId, cargoQty);
    return;
  }

  try {
    const sold = await sellAtBuyer(ctx, bot, order, cargoQty, 0);
    if (sold > 0) {
      await recordMarketData(ctx);
      await factionDonateProfit(ctx, sold * lockKeyPrice, 10000);
      markSold(order.orderId);
      log("trade", `Sold ${sold}x ${order.itemName} @ ${order.destPoiName} — order ${order.orderId} complete`);
      const remaining = cargoQty - sold;
      if (remaining > 0) {
        log("trade", `Depositing ${remaining}x unsold ${order.itemName} back to faction storage`);
        await returnUnsold(ctx, bot, s, order.itemId, remaining);
      }
    } else {
      log("error", `No ${order.itemName} sold at ${order.destPoiName} — depositing back to faction storage`);
      await returnUnsold(ctx, bot, s, order.itemId, cargoQty);
    }
  } finally {
    releaseBuyOrderLock(bot.username, order.itemId, order.destPoi, lockKeyPrice, "completed");
  }
}

/** Sell cargoQty of itemId at the order's destination, honoring real buy orders. Returns items sold. */
async function sellAtBuyer(
  ctx: RoutineContext,
  bot: Bot,
  order: CraftOrder,
  cargoQty: number,
  minPrice: number,
): Promise<number> {
  const { log } = ctx;
  const check = await calculateFactionOptimalSellQuantity(ctx, order.itemId, order.itemName, cargoQty, minPrice);
  if (check.buyOrders.length === 0) {
    log("trade", `No buy orders for ${order.itemName} at ${order.destPoiName}`);
    return 0;
  }

  let totalSold = 0;
  for (const buyOrder of check.buyOrders) {
    if (totalSold >= cargoQty) break;
    const { priceEach, qtyToSell } = buyOrder;
    let targetQty = Math.min(qtyToSell, cargoQty - totalSold);
    let orderTotalSold = 0;
    for (let retry = 0; retry < 3 && orderTotalSold < targetQty; retry++) {
      await bot.refreshCargo();
      const have = bot.inventory.find(i => i.itemId.toLowerCase() === order.itemId.toLowerCase())?.quantity ?? 0;
      if (have <= 0) break;
      const sellNow = Math.min(targetQty - orderTotalSold, have);
      if (sellNow <= 0) break;
      const sResp = await bot.exec("sell", { item_id: order.itemId, quantity: sellNow });
      if (sResp.notifications && Array.isArray(sResp.notifications)) {
        await checkBattleAfterCommand(ctx, sResp.notifications, "sell");
      }
      if (sResp.error) {
        log("error", `Sell failed: ${sResp.error.message}`);
        break;
      }
      await ctx.sleep(12000);
      await bot.refreshCargo();
      const after = bot.inventory.find(i => i.itemId.toLowerCase() === order.itemId.toLowerCase())?.quantity ?? 0;
      const actuallySold = have - after;
      if (actuallySold > 0) {
        orderTotalSold += actuallySold;
        totalSold += actuallySold;
        const sr = sResp.result as Record<string, unknown> | undefined;
        const revenue = sanitizeCredits((sr?.credits_earned as number) ?? (sr?.total as number) ?? actuallySold * priceEach);
        log("trade", `Sold ${actuallySold}x ${order.itemName} @ ${priceEach}cr — ${revenue}cr`);
      } else {
        const sr = sResp.result as Record<string, unknown> | undefined;
        const revenue = sanitizeCredits((sr?.credits_earned as number) ?? (sr?.total as number) ?? 0);
        if (revenue > 0) {
          orderTotalSold += sellNow;
          totalSold += sellNow;
        } else {
          break;
        }
      }
    }
  }
  return totalSold;
}

async function returnUnsold(
  ctx: RoutineContext,
  bot: Bot,
  s: CraftTradeSettings,
  itemId: string,
  qty: number,
): Promise<void> {
  if (qty <= 0) return;
  await bot.refreshCargo();
  const have = bot.inventory.find(i => i.itemId.toLowerCase() === itemId.toLowerCase())?.quantity ?? 0;
  const dQty = Math.min(have, qty);
  if (dQty <= 0) return;
  if (s.homeSystem && bot.system !== s.homeSystem) {
    await navigateToSystem(ctx, s.homeSystem, {
      fuelThresholdPct: s.refuelThreshold,
      hullThresholdPct: s.repairThreshold,
    });
    await ensureDocked(ctx);
  }
  const dResp = await bot.exec("storage", { action: "deposit", target: "faction", item_id: itemId, quantity: dQty });
  if (dResp.error) {
    ctx.log("error", `Failed to deposit unsold ${itemId}: ${dResp.error.message}`);
  } else {
    ctx.log("trade", `Deposited ${dQty}x unsold ${itemId} back to faction storage`);
  }
}

// ── Crafter loop ─────────────────────────────────────────────

async function* crafterLoop(ctx: RoutineContext, s: CraftTradeSettings): AsyncGenerator<string, void, void> {
  const { bot } = ctx;
  await bot.refreshLocation();
  await bot.initCraftQueueTracker();

  // Chat ping handler — best-effort wake-up; file is the source of truth.
  let wakeRequested = false;
  const pingHandler = (msg: { content?: string }) => {
    if (msg.content && msg.content.startsWith("craft ")) wakeRequested = true;
  };
  botChatChannel.onMessage(bot.username, pingHandler);

  const crafterSettings: CrafterSettings = {
    crafters: [{ name: bot.username, craftLimits: [] }],
    botCrafterAssignments: {},
    enabledCategories: s.enabledCategories,
    refuelThreshold: s.refuelThreshold,
    repairThreshold: s.repairThreshold,
    categoryAssignments: {},
    botQuotaOverrides: {},
    goalProcessingMode: "batch",
    autoBuy: { enabled: false, maxPricePercentOverBase: 150, maxCreditsPerCycle: 50000, excludeCategories: ["ammo"] },
    blacklistedRecipes: s.blacklistedRecipes,
    useQueuedCrafting: true,
    craftingPreset: s.craftingPreset,
    finalItemThreshold: 1,
    allowExternalFacilities: false,
    forceOwnFacility: s.forceOwnFacility,
    noFacilityFallback: "auto",
    allowRentalPurchase: false,
    rentalSpendingLimit: 0,
    cycleTimeSec: 30,
  };

  const facTypeByRecipe = new Map<string, string>();
  for (const f of getFacilityRecipeMap()) facTypeByRecipe.set(f.recipeId, f.facilityType);

  const countFactionItemFn = (itemId: string): number => {
    const lowerId = itemId.toLowerCase();
    let total = 0;
    for (const i of bot.inventory) if (i.itemId.toLowerCase() === lowerId) total += i.quantity;
    for (const i of bot.storage) if (i.itemId.toLowerCase() === lowerId) total += i.quantity;
    for (const i of (bot.factionStorage || [])) if (i.itemId.toLowerCase() === lowerId) total += i.quantity;
    return total;
  };

  try {
    while (bot.state === "running") {
      yield "recover";
      await detectAndRecoverFromDeath(ctx);
      if (bot.state !== "running") break;

      yield "dock";
      await ensureDocked(ctx);

      yield "fetch_recipes";
      if (wakeRequested) wakeRequested = false;
      const recipes = await fetchAllRecipes(ctx);

      yield "refresh_storage";
      await bot.refreshFactionStorage(true);

      const factionFacilities = await fetchFactionFacilities(bot);
      const ownFacilityMap = buildOwnFacilityRecipeMap(factionFacilities);
      const recipeIndex = new Map(recipes.map(r => [r.recipe_id, r]));

      // 1) Queue any open orders we can craft.
      yield "queue_orders";
      const openOrders = getOrdersForCrafter();
      for (const order of openOrders) {
        if (bot.state !== "running") break;
        const recipe = recipeIndex.get(order.recipeId);
        if (!recipe) {
          markFailed(order.orderId, "no recipe");
          ctx.log("error", `Order ${order.orderId}: recipe ${order.recipeId} not found`);
          continue;
        }
        const venue: ResolvedVenue = resolveVenueForRecipe(order.recipeId, recipe.name, ownFacilityMap, crafterSettings);
        if (venue.missingFacility) {
          const facilityType = facTypeByRecipe.get(order.recipeId) || order.facilityType || recipe.category || recipe.name;
          ctx.log("alert", `🔴 BUILD NEEDED: ${facilityType} to craft ${recipe.output_name} — deal profit ~${Math.round(order.expectedRevenue - order.estCost)}cr @ ${order.destPoiName} (${order.recipeId})`);
          markFailed(order.orderId, "no facility");
          continue;
        }
        const result = await queueCraftJob(
          ctx, order.recipeId, order.quantity, bot, bot.craftQueueTracker!,
          countFactionItemFn, recipes, venue, crafterSettings, ownFacilityMap,
        );
        if (result.success) {
          markCrafting(order.orderId);
          ctx.log("craft", `Queued craft order ${order.orderId}: ${order.quantity}x ${recipe.output_name}`);
        } else if (result.error && result.error !== "Job already queued") {
          ctx.log("error", `Failed to queue order ${order.orderId}: ${result.error}`);
          if (result.error === "insufficient_inputs") {
            ctx.log("craft", `Order ${order.orderId} awaiting materials — will retry next cycle`);
          } else {
            markFailed(order.orderId, result.error);
          }
        }
      }

      // 2) Mark crafting orders ready once produced AND in faction storage.
      yield "check_progress";
      await bot.refreshFactionStorage(true);
      const tracker = bot.craftQueueTracker!;
      const inCrafting = getOpenOrders().filter(o => o.status === "crafting");
      for (const order of inCrafting) {
        const recipe = recipeIndex.get(order.recipeId);
        if (!recipe) continue;
        const progress = tracker.getProgress(order.recipeId);
        const completed = progress.completed * (recipe.output_quantity || 1);
        if (completed >= order.quantity) {
          const inStorage = (bot.factionStorage || [])
            .filter(i => i.itemId.toLowerCase() === order.itemId.toLowerCase())
            .reduce((a, i) => a + i.quantity, 0);
          if (inStorage >= order.quantity) {
            markReady(order.orderId);
            ctx.log("craft", `Order ${order.orderId} READY: ${order.quantity}x ${recipe.output_name} in faction storage`);
          } else {
            ctx.log("craft", `Order ${order.orderId}: crafted (${completed}) but only ${inStorage} in faction storage — waiting for deposit`);
          }
        }
      }

      yield "refuel";
      await tryRefuel(ctx);
      yield "repair";
      await repairShip(ctx);

      yield "sleep";
      await ctx.sleep(30000);
    }
  } finally {
    botChatChannel.offMessage(bot.username, pingHandler);
  }
}
