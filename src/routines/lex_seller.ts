/**
 * LEx Seller (Local Exchange Seller) routine — a stationary "vendor" that lists
 * our own items for sale at a local exchange (our home station) via
 * `create_sell_order`, tracks posted sell orders via `view_orders`, and
 * auto-manages them:
 *   - list an item when no order exists and we have units,
 *   - append more of the same item when we have extra and the price still matches,
 *   - cancel + relist (reprice) when the market midpoint moved,
 *   - cancel (remove from sale, no relist) when the market best-buy drops below
 *     the item floor.
 *
 * Unlike faction_trader / fuel_cell_seller the bot never travels to buyers. It
 * sits at `homeStation` and only relists there. Items can come from faction
 * storage (withdraw → cargo → list) or straight from cargo.
 *
 * A snapshot of the live orders is written to data/lexSeller.json for the
 * standalone lexSeller.html web UI (which drives add / cancel / reprice / remove
 * actions directly against the running bot via the exec WebSocket action).
 */
import { writeFileSync } from "fs";
import { join } from "path";
import type { Routine, RoutineContext } from "../bot.js";
import { catalogStore } from "../catalogstore.js";
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
  checkAndFleeFromBattle,
} from "./common.js";
import { queryRemoteMarket } from "../client_sync_hooks.js";

const LEX_SELLER_FILE = "data/lexSeller.json";

// ── Settings ─────────────────────────────────────────────────

export type LexItemSource = "faction" | "cargo";

export interface LexItemConfig {
  itemId: string;
  /** Where the listed units come from. */
  source: LexItemSource;
  /** Explicit ask price. 0 = auto (market midpoint), ignored when autoPrice is true. */
  askPrice: number;
  /** Floor; cancel the order (and do not relist) if the market best-buy drops below. */
  minPrice: number;
  /** 0 = list all available. */
  maxQty: number;
  /** Compute the ask from the station market midpoint. */
  autoPrice: boolean;
}

export interface LexSellerSettings {
  /** "system|poi" or bare poi of the station we post at. */
  homeStation: string;
  homeSystem: string;
  fuelCostPerJump: number;
  refuelThreshold: number;
  repairThreshold: number;
  items: LexItemConfig[];
  /** Fallback floor when an item has no minPrice. */
  globalMinPrice: number;
  /** Midpoint clamp band (reuse fuel_cell_seller bands). */
  autoMin: number;
  autoMax: number;
  useRemoteMarketQuery: boolean;
  /** OPTIONAL empire-station fee/tax cover. Default off (current setup has no fees). */
  preloadCredits: boolean;
  /** Credits to keep aboard when preloadCredits is on. */
  feeCreditBuffer: number;
}

function normalizePoi(homeStation: string): string {
  if (!homeStation) return "";
  return homeStation.includes("|") ? homeStation.split("|")[1] : homeStation;
}

export function getLexSellerSettings(username?: string): LexSellerSettings {
  const all = readSettings();
  const general = (all.general as Record<string, unknown>) || {};
  const t = (all.lex_seller as Record<string, unknown>) || {};
  const botOverrides = username ? ((all[username] as Record<string, unknown>) || {}) : {};

  let items: LexItemConfig[] = [];
  if (Array.isArray(t.items)) {
    items = (t.items as any[])
      .map((i: any): LexItemConfig => ({
        itemId: i.itemId || "",
        source: (i.source === "cargo" ? "cargo" : "faction") as LexItemSource,
        askPrice: Number(i.askPrice) || 0,
        minPrice: Number(i.minPrice) || 0,
        maxQty: Number(i.maxQty) || 0,
        autoPrice: i.autoPrice === true || i.autoPrice === "true",
      }))
      .filter((i: LexItemConfig) => i.itemId);
  }

  const homeStation =
    (botOverrides.homeStation as string) ||
    (t.homeStation as string) ||
    (general.factionStorageStation as string) ||
    "";
  const homeSystem =
    (botOverrides.homeSystem as string) ||
    (t.homeSystem as string) ||
    (general.factionStorageSystem as string) ||
    (homeStation.includes("|") ? homeStation.split("|")[0] : "");

  return {
    homeStation,
    homeSystem,
    fuelCostPerJump: (t.fuelCostPerJump as number) || 10,
    refuelThreshold: (t.refuelThreshold as number) || 35,
    repairThreshold: (t.repairThreshold as number) || 80,
    items,
    globalMinPrice: (t.globalMinPrice as number) || 0,
    autoMin: (t.autoMin as number) || 1,
    autoMax: (t.autoMax as number) || 100000,
    useRemoteMarketQuery: (t.useRemoteMarketQuery as boolean) ?? true,
    preloadCredits: (t.preloadCredits as boolean) ?? false,
    feeCreditBuffer: (t.feeCreditBuffer as number) || 100000,
  };
}

// ── Pure helpers (testable) ─────────────────────────────────

export interface LexOrder {
  orderId: string;
  itemId: string;
  quantity: number;
  remaining: number;
  filledQuantity: number;
  priceEach: number;
  createdAt: string;
}

export interface LexAskItem {
  itemId: string;
  askPrice: number;
  autoPrice: boolean;
}

export interface LexDesiredItem {
  itemId: string;
  source: LexItemSource;
  /** Units we are willing to have listed (already capped by maxQty). */
  qtyAvailable: number;
  desiredAsk: number;
  floor: number;
  /** Market best-buy price used for the floor check (0 = unknown). */
  bestBuy: number;
}

export type LexAction =
  | { kind: "list"; itemId: string; source: LexItemSource; qty: number; price: number }
  | { kind: "append"; itemId: string; source: LexItemSource; qty: number; price: number }
  | { kind: "cancel"; itemId: string; orderId: string }
  | { kind: "repricerem"; itemId: string; source: LexItemSource; orderId: string; price: number; qty: number };

/**
 * Compute the ask price for an item from a `view_market` result.
 * - Manual price wins when autoPrice is off and askPrice > 0.
 * - Otherwise midpoint(bestBuy, bestSell) clamped to [autoMin, autoMax]; fall
 *   back to bestSell then bestBuy inside the band, then the configured price.
 */
export function computeDesiredAsk(
  marketData: unknown,
  item: LexAskItem,
  settings: { autoMin: number; autoMax: number; globalMinPrice: number },
): number {
  if (!item.autoPrice && item.askPrice > 0) return item.askPrice;

  const fallback = item.askPrice > 0 ? item.askPrice : settings.globalMinPrice;

  if (!marketData || typeof marketData !== "object") return fallback;

  const md = marketData as Record<string, unknown>;
  const items = Array.isArray(md) ? md : Array.isArray(md.items) ? (md.items as unknown[]) : [];
  const entry = items.find((i) => (i as Record<string, unknown>).item_id === item.itemId) as
    | Record<string, unknown>
    | undefined;
  if (!entry) return fallback;

  const bestSell = Number(entry.best_sell) || 0;
  const bestBuy = Number(entry.best_buy) || 0;

  if (bestSell > 0 && bestBuy > 0) {
    const mid = Math.round((bestBuy + bestSell) / 2);
    if (mid >= settings.autoMin && mid <= settings.autoMax) return mid;
  }
  if (bestSell >= settings.autoMin && bestSell <= settings.autoMax) return bestSell;
  if (bestBuy >= settings.autoMin && bestBuy <= settings.autoMax) return bestBuy;
  return fallback;
}

/** Parse a `view_orders` result into our sell orders. */
export function parseOrders(viewOrdersResult: any): LexOrder[] {
  if (!viewOrdersResult || viewOrdersResult.error || !viewOrdersResult.result) return [];
  const data = viewOrdersResult.result as Record<string, unknown>;
  const orders = Array.isArray(data.orders) ? (data.orders as any[]) : [];
  return orders
    .filter((o) => o.side === "sell")
    .map((o) => ({
      orderId: o.order_id,
      itemId: o.item_id,
      quantity: o.quantity,
      remaining: o.remaining,
      filledQuantity: o.filled_quantity,
      priceEach: o.price_each,
      createdAt: o.created_at,
    }));
}

/**
 * Reconcile current sell orders against the desired state and produce the set
 * of actions the routine should execute:
 *   - list      : no order yet and we have units
 *   - append    : order at the desired price already exists and we have more to add
 *   - cancel    : market best-buy dropped below the floor (remove from sale)
 *   - repricerem: order exists at a different price → cancel + relist at desiredAsk
 */
export function reconcileOrders(current: LexOrder[], desired: LexDesiredItem[]): LexAction[] {
  const actions: LexAction[] = [];

  for (const d of desired) {
    const orders = current.filter((o) => o.itemId === d.itemId);

    if (orders.length === 0) {
      if (d.qtyAvailable > 0) {
        actions.push({ kind: "list", itemId: d.itemId, source: d.source, qty: d.qtyAvailable, price: d.desiredAsk });
      }
      continue;
    }

    const totalRemaining = orders.reduce((s, o) => s + o.remaining, 0);

    // Market crashed below the floor → cancel everything, do not relist.
    if (d.bestBuy > 0 && d.bestBuy < d.floor) {
      for (const o of orders) actions.push({ kind: "cancel", itemId: d.itemId, orderId: o.orderId });
      continue;
    }

    const priceMismatch = orders.some((o) => o.priceEach !== d.desiredAsk);
    if (priceMismatch) {
      for (const o of orders) {
        actions.push({
          kind: "repricerem",
          itemId: d.itemId,
          source: d.source,
          orderId: o.orderId,
          price: d.desiredAsk,
          qty: Math.max(o.remaining, d.qtyAvailable),
        });
      }
      continue;
    }

    // Price already matches → add more if we have extra units to list.
    if (d.qtyAvailable > totalRemaining) {
      actions.push({
        kind: "append",
        itemId: d.itemId,
        source: d.source,
        qty: d.qtyAvailable - totalRemaining,
        price: d.desiredAsk,
      });
    }
  }

  return actions;
}

// ── Snapshot for the web UI ─────────────────────────────────

interface LexSnapshotItem {
  itemId: string;
  itemName: string;
  haveInCargo: number;
  inFactionStorage: number;
  desiredAsk: number;
  floor: number;
}

interface LexSnapshotOrder {
  orderId: string;
  itemId: string;
  itemName: string;
  quantity: number;
  remaining: number;
  filledQuantity: number;
  priceEach: number;
  createdAt: string;
  source: LexItemSource;
}

interface LexSnapshot {
  bot: string;
  station: string;
  updatedAt: string;
  orders: LexSnapshotOrder[];
  items: LexSnapshotItem[];
  settings: LexSellerSettings;
}

function saveSnapshot(snapshot: LexSnapshot): void {
  writeFileSync(LEX_SELLER_FILE, JSON.stringify(snapshot, null, 2));
}

// ── Routine ─────────────────────────────────────────────────

export const lexSellerRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  await bot.refreshStatus();
  const settings = getLexSellerSettings(bot.username);
  const homePoi = normalizePoi(settings.homeStation) || settings.homeStation;
  const homeSystem = settings.homeSystem || (settings.homeStation.includes("|") ? settings.homeStation.split("|")[0] : bot.system);

  const safetyOpts = {
    fuelThresholdPct: settings.refuelThreshold,
    hullThresholdPct: settings.repairThreshold,
  };

  while (bot.state === "running") {
    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) {
      await ctx.sleep(30000);
      continue;
    }

    if (await checkAndFleeFromBattle(ctx, "lex_seller")) {
      await ctx.sleep(5000);
      continue;
    }

    yield "navigate_home";
    // Stationary vendor: ensure we are docked at the post station.
    if (bot.system !== homeSystem || bot.poi !== homePoi) {
      if (bot.system !== homeSystem) {
        await ensureUndocked(ctx);
        const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
        if (!fueled) {
          ctx.log("error", "lex_seller: cannot refuel for journey home");
          await ctx.sleep(60000);
          continue;
        }
        await navigateToSystem(ctx, homeSystem, safetyOpts);
      }
      if (bot.poi !== homePoi) {
        await ensureUndocked(ctx);
        const travelResp = await bot.exec("travel", { target_poi: homePoi });
        if (travelResp.error) {
          ctx.log("error", `lex_seller: travel home failed: ${travelResp.error.message}`);
          await ctx.sleep(30000);
          continue;
        }
        bot.poi = homePoi;
      }
    }

    yield "dock";
    await ensureDocked(ctx);
    await tryRefuel(ctx);
    await repairShip(ctx);
    await bot.refreshCargo();
    await bot.refreshStatus();

    // Optional empire-station fee coverage (default off).
    if (settings.preloadCredits) {
      await ensureFeeCredits(ctx, settings.feeCreditBuffer);
    }

    // Build desired state for each configured item.
    const desired: LexDesiredItem[] = [];
    const snapshotItems: LexSnapshotItem[] = [];

    for (const item of settings.items) {
      const cargoEntry = bot.inventory.find((i) => i.itemId === item.itemId);
      const cargoQty = cargoEntry?.quantity ?? 0;
      const factionEntry = bot.factionStorage.find((i) => i.itemId === item.itemId);
      const factionQty = factionEntry?.quantity ?? 0;

      const have = item.source === "faction" ? factionQty : cargoQty;
      const cap = item.maxQty > 0 ? Math.min(item.maxQty, have) : have;

      const marketData = await getMarketData(ctx, item.itemId, settings.useRemoteMarketQuery);
      const bestBuy = readBestBuy(marketData);
      const desiredAsk = computeDesiredAsk(marketData, item, settings);
      const floor = item.minPrice > 0 ? item.minPrice : settings.globalMinPrice;

      desired.push({
        itemId: item.itemId,
        source: item.source,
        qtyAvailable: cap,
        desiredAsk,
        floor,
        bestBuy,
      });

      snapshotItems.push({
        itemId: item.itemId,
        itemName: catalogStore.getItem(item.itemId)?.name || item.itemId,
        haveInCargo: cargoQty,
        inFactionStorage: factionQty,
        desiredAsk,
        floor,
      });
    }

    // Read current orders (personal scope at the post station).
    let currentOrders: LexOrder[] = [];
    const ordersResp = await bot.exec("view_orders", { scope: "personal" });
    if (!ordersResp.error && ordersResp.result) {
      currentOrders = parseOrders(ordersResp);
      // Limit to the configured items for clarity.
      currentOrders = currentOrders.filter((o) => settings.items.some((i) => i.itemId === o.itemId));
    }

    const actions = reconcileOrders(currentOrders, desired);

    // Phase A: cancels (floor breach + the cancel half of repricerem).
    for (const action of actions) {
      if (action.kind === "cancel") {
        ctx.log("lex", `Cancelling ${action.itemId} order ${action.orderId} (below floor)`);
        await bot.exec("cancel_order", { order_id: action.orderId });
        await ctx.sleep(2000);
      } else if (action.kind === "repricerem") {
        ctx.log("lex", `Cancelling ${action.itemId} order ${action.orderId} for reprice`);
        await bot.exec("cancel_order", { order_id: action.orderId });
        await ctx.sleep(2000);
      }
    }

    // Re-read after cancels to avoid listing duplicates.
    if (actions.some((a) => a.kind === "cancel" || a.kind === "repricerem")) {
      const reResp = await bot.exec("view_orders", { scope: "personal" });
      if (!reResp.error && reResp.result) {
        currentOrders = parseOrders(reResp).filter((o) => settings.items.some((i) => i.itemId === o.itemId));
      }
    }

    // Phase B: lists / appends / relists.
    for (const action of actions) {
      if (action.kind === "cancel") continue;

      let qty = action.qty;

      // For faction-sourced units, withdraw to cargo first and re-check availability.
      if (action.source === "faction") {
        const freeSpace = Math.max(0, (bot.cargoMax || 0) - (bot.cargo || 0));
        const withdrawQty = Math.min(qty, maxItemsForCargo(freeSpace, action.itemId));
        if (withdrawQty > 0) {
          const wResp = await bot.exec("storage", {
            action: "withdraw",
            target: "faction",
            item_id: action.itemId,
            quantity: withdrawQty,
          });
          if (wResp.error) {
            ctx.log("error", `lex_seller: withdraw ${action.itemId} failed: ${wResp.error.message}`);
            await ctx.sleep(2000);
            continue;
          }
          await ctx.sleep(2000);
          await bot.refreshCargo();
        }
      }

      await bot.refreshCargo();
      const aboard = bot.inventory.find((i) => i.itemId === action.itemId)?.quantity ?? 0;
      const haveForOrder = action.kind === "append" ? qty : Math.min(qty, aboard);
      if (haveForOrder <= 0) {
        ctx.log("lex", `No ${action.itemId} aboard to ${action.kind} — skipping`);
        await ctx.sleep(1000);
        continue;
      }

      yield "list";
      const createResp = await bot.exec("create_sell_order", {
        item_id: action.itemId,
        quantity: haveForOrder,
        price_each: action.price,
      });
      if (createResp.error) {
        ctx.log("error", `lex_seller: create_sell_order ${action.itemId} failed: ${createResp.error.message}`);
      } else {
        ctx.log("lex", `${action.kind} ${haveForOrder}x ${action.itemId} @ ${action.price}cr`);
      }
      await ctx.sleep(2000);
    }

    // Re-read final orders for the snapshot.
    const finalResp = await bot.exec("view_orders", { scope: "personal" });
    let finalOrders: LexOrder[] = [];
    if (!finalResp.error && finalResp.result) {
      finalOrders = parseOrders(finalResp).filter((o) => settings.items.some((i) => i.itemId === o.itemId));
    }

    const snapshot: LexSnapshot = {
      bot: bot.username,
      station: homePoi,
      updatedAt: new Date().toISOString(),
      orders: finalOrders.map((o) => ({
        orderId: o.orderId,
        itemId: o.itemId,
        itemName: catalogStore.getItem(o.itemId)?.name || o.itemId,
        quantity: o.quantity,
        remaining: o.remaining,
        filledQuantity: o.filledQuantity,
        priceEach: o.priceEach,
        createdAt: o.createdAt,
        source: settings.items.find((i) => i.itemId === o.itemId)?.source || "cargo",
      })),
      items: snapshotItems,
      settings,
    };
    saveSnapshot(snapshot);

    ctx.log("lex", `Cycle complete — ${snapshot.orders.length} orders, ${snapshot.items.length} items tracked`);
    yield "idle";
    await ctx.sleep(45000);
  }
};

// ── Internal support ───────────────────────────────────────

async function getMarketData(
  ctx: RoutineContext,
  itemId: string,
  useRemote: boolean,
): Promise<unknown> {
  const resp = await ctx.bot.exec("view_market", { item_id: itemId });
  if (!resp.error && resp.result) return resp.result;

  if (useRemote) {
    try {
      const result = await queryRemoteMarket({ itemId, tradeType: "sell", requesterSystemId: ctx.bot.system });
      if (result.ok && result.results.length > 0) {
        const best = result.results[0];
        return {
          items: [
            {
              item_id: itemId,
              best_sell: best.price,
              best_buy: best.price,
              sell_quantity: best.quantity,
              buy_quantity: best.quantity,
            },
          ],
        };
      }
    } catch {
      /* ignore remote failure, fall through */
    }
  }
  return null;
}

function readBestBuy(marketData: unknown): number {
  if (!marketData || typeof marketData !== "object") return 0;
  const md = marketData as Record<string, unknown>;
  const items = Array.isArray(md) ? md : Array.isArray(md.items) ? (md.items as unknown[]) : [];
  // bestBuy is item-specific; the routine passes per-item market data so we read
  // the single entry (or the entry matching the item would be ideal, but the
  // caller always fetches one item at a time).
  for (const i of items as Record<string, unknown>[]) {
    const b = Number(i.best_buy) || 0;
    if (b > 0) return b;
  }
  return 0;
}

async function ensureFeeCredits(ctx: RoutineContext, buffer: number): Promise<void> {
  const { bot } = ctx;
  if (bot.credits >= buffer) return;
  ctx.log("lex", `preloadCredits: ensuring ${buffer}cr aboard (have ${bot.credits})`);
  const need = buffer - bot.credits;
  const wResp = await bot.exec("storage", {
    action: "withdraw",
    target: "faction",
    item_id: "credits",
    quantity: need,
  });
  if (wResp.error) {
    ctx.log("error", `lex_seller: fee credit withdraw failed: ${wResp.error.message}`);
  } else {
    await bot.refreshStatus();
  }
}
