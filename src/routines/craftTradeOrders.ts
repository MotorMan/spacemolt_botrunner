/**
 * Persisted order store for the `craft_trade` routine.
 *
 * Traders write build orders here; the crafter reads them, crafts, and flips
 * the status. The file on disk (data/craft_trade_orders.json) is the source of
 * truth so coordination survives bot restarts. Chat pings are best-effort only.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const DATA_DIR = join(process.cwd(), "data");
const ORDERS_FILE = join(DATA_DIR, "craft_trade_orders.json");

export type OrderStatus =
  | "open"
  | "crafting"
  | "ready"
  | "sold"
  | "failed"
  | "expired";

export interface CraftOrder {
  orderId: string;
  itemId: string;
  itemName: string;
  recipeId: string;
  facilityType: string;
  quantity: number;
  requestingTrader: string;
  destSystem: string;
  destPoi: string;
  destPoiName: string;
  sellPrice: number;
  expectedRevenue: number;
  estCost: number;
  status: OrderStatus;
  createdAt: number;
  updatedAt: number;
}

function load(): CraftOrder[] {
  try {
    if (existsSync(ORDERS_FILE)) {
      const raw = JSON.parse(readFileSync(ORDERS_FILE, "utf-8"));
      if (Array.isArray(raw)) return raw as CraftOrder[];
    }
  } catch (err) {
    console.warn("[craftTradeOrders] Could not load orders:", err);
  }
  return [];
}

function save(orders: CraftOrder[]): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2) + "\n");
  } catch (err) {
    console.error("[craftTradeOrders] Error saving orders:", err);
  }
}

/** Stable dedup key: prevents 10 traders ordering the same craft twice. */
function dedupKey(order: {
  itemId: string;
  destSystem: string;
  destPoi: string;
  sellPrice: number;
}): string {
  return `${order.itemId}|${order.destSystem}|${order.destPoi}|${order.sellPrice}`;
}

function makeOrderId(): string {
  return `ct_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Add an order. If an identical open/crafting/ready order already exists
 * (same item + destination + sell price) returns the existing one.
 */
export function addOrder(order: Omit<CraftOrder, "orderId" | "status" | "createdAt" | "updatedAt">): CraftOrder {
  const orders = load();
  const key = dedupKey(order);
  const existing = orders.find(
    o =>
      dedupKey(o) === key &&
      (o.status === "open" || o.status === "crafting" || o.status === "ready")
  );
  if (existing) {
    // refresh the requesting trader set so any trader can sell the result
    existing.requestingTrader = order.requestingTrader;
    existing.updatedAt = Date.now();
    save(orders);
    return existing;
  }
  const now = Date.now();
  const full: CraftOrder = {
    ...order,
    orderId: makeOrderId(),
    status: "open",
    createdAt: now,
    updatedAt: now,
  };
  orders.push(full);
  save(orders);
  return full;
}

export function getOpenOrders(): CraftOrder[] {
  return load().filter(o => o.status === "open" || o.status === "crafting" || o.status === "ready");
}

export function getOrdersForCrafter(): CraftOrder[] {
  return load().filter(o => o.status === "open");
}

export function getOrdersForTrader(trader: string): CraftOrder[] {
  return load().filter(o => o.requestingTrader === trader && (o.status === "open" || o.status === "crafting" || o.status === "ready"));
}

export function getOrder(orderId: string): CraftOrder | undefined {
  return load().find(o => o.orderId === orderId);
}

function patch(orderId: string, updater: (o: CraftOrder) => void): CraftOrder | undefined {
  const orders = load();
  const o = orders.find(x => x.orderId === orderId);
  if (!o) return undefined;
  updater(o);
  o.updatedAt = Date.now();
  save(orders);
  return o;
}

export function markCrafting(orderId: string): CraftOrder | undefined {
  return patch(orderId, o => { o.status = "crafting"; });
}

export function markReady(orderId: string): CraftOrder | undefined {
  return patch(orderId, o => { o.status = "ready"; });
}

export function markSold(orderId: string): CraftOrder | undefined {
  return patch(orderId, o => { o.status = "sold"; });
}

export function markFailed(orderId: string, reason: string): CraftOrder | undefined {
  return patch(orderId, o => { o.status = "failed"; o.facilityType = o.facilityType ? `${o.facilityType} (${reason})` : reason; });
}

/** Expire stale open/crafting/ready orders past the timeout window. */
export function expireStaleOrders(timeoutMin: number): number {
  const orders = load();
  const cutoff = Date.now() - timeoutMin * 60 * 1000;
  let changed = 0;
  for (const o of orders) {
    if (
      (o.status === "open" || o.status === "crafting" || o.status === "ready") &&
      o.updatedAt < cutoff
    ) {
      o.status = "expired";
      o.updatedAt = Date.now();
      changed++;
    }
  }
  if (changed > 0) save(orders);
  return changed;
}

export function countOpenOrdersForTrader(trader: string): number {
  return load().filter(o => o.requestingTrader === trader && o.status === "open").length;
}

export function countOpenOrdersForCrafter(): number {
  return load().filter(o => o.status === "open").length;
}
