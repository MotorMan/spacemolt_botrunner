import { mapStore } from "./mapstore.js";
import { log } from "./ui.js";

export interface MarketBookOrder {
  price: number;
  quantity: number;
  source?: string;
  orderId?: string;
}

export interface MarketBookItem {
  itemId: string;
  itemName: string;
  buyOrders: MarketBookOrder[];
  sellOrders: MarketBookOrder[];
}

export interface MarketStationSnapshot {
  baseId: string;
  systemId: string;
  poiId: string;
  poiName: string;
  updatedAt: number;
  snapshotTick?: number;
  items: MarketBookItem[];
}

interface InternalSnapshot {
  snapshot: MarketStationSnapshot;
  resolved: boolean;
  warnIssued: boolean;
}

const FRESHNESS_WINDOW_MS = 120_000;
const mobileCapitalWarned = new Set<string>();
const unresolvedBaseWarned = new Set<string>();

function stationKey(systemId: string, poiId: string): string {
  return `${systemId.toLowerCase()}|${poiId.toLowerCase()}`;
}

const snapshots = new Map<string, InternalSnapshot>();

function isFinitePositive(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

function normalizeOrders(
  orders: Array<{ price?: number; price_each?: number; quantity?: number; source?: string; order_id?: string; id?: string }> | undefined
): MarketBookOrder[] {
  if (!Array.isArray(orders)) return [];
  const out: MarketBookOrder[] = [];
  for (const o of orders) {
    const price = typeof o.price_each === "number" ? o.price_each : typeof o.price === "number" ? o.price : 0;
    const quantity = typeof o.quantity === "number" ? o.quantity : 0;
    if (isFinitePositive(price) && isFinitePositive(quantity)) {
      out.push({
        price,
        quantity,
        source: typeof o.source === "string" ? o.source : undefined,
        orderId: typeof o.order_id === "string" ? o.order_id : typeof o.id === "string" ? o.id : undefined,
      });
    }
  }
  return out;
}

function resolveMobileCapital(systemId: string, baseId: string): { systemId: string; poiId: string; poiName: string } | null {
  if (baseId !== "frontier_station") return null;
  const mc = mapStore.getMobileCapitolLocation();
  if (!mc) return null;
  if (mc.systemId !== systemId) return null;
  return { systemId: mc.systemId, poiId: mc.poiId, poiName: mc.systemName };
}

function resolveViaMapStore(systemId: string, baseId: string): { systemId: string; poiId: string; poiName: string; baseId: string } | null {
  const found = mapStore.findStationInSystem(systemId, baseId);
  if (!found) return null;
  return { systemId, poiId: found.poiId, poiName: found.poiName, baseId: found.baseId };
}

function resolveViaPoi(systemId: string, baseId: string): { systemId: string; poiId: string; poiName: string; baseId: string } | null {
  const sys = mapStore.getSystem(systemId);
  if (!sys) return null;
  for (const poi of sys.pois) {
    if (!poi.has_base) continue;
    const poiBaseId = poi.base_id || poi.id;
    if (poiBaseId === baseId || poi.id === baseId) {
      return { systemId, poiId: poi.id, poiName: poi.name, baseId: poiBaseId };
    }
  }
  return null;
}

function resolveMetadata(
  baseId: string,
  systemId: string,
  metadataBaseId?: string,
  metadataSystemId?: string,
  metadataPoiId?: string,
  metadataPoiName?: string
): { systemId: string; poiId: string; poiName: string; baseId: string; resolved: boolean } {
  if (metadataBaseId && metadataSystemId && metadataPoiId && metadataPoiName) {
    return { systemId: metadataSystemId, poiId: metadataPoiId, poiName: metadataPoiName, baseId: metadataBaseId, resolved: true };
  }

  const mcResult = resolveMobileCapital(systemId, baseId);
  if (mcResult) {
    return { systemId: mcResult.systemId, poiId: mcResult.poiId, poiName: mcResult.poiName, baseId, resolved: true };
  }

  const mapResult = resolveViaMapStore(systemId, baseId);
  if (mapResult) {
    return { systemId: mapResult.systemId, poiId: mapResult.poiId, poiName: mapResult.poiName, baseId: mapResult.baseId, resolved: true };
  }

  const poiResult = resolveViaPoi(systemId, baseId);
  if (poiResult) {
    return { systemId: poiResult.systemId, poiId: poiResult.poiId, poiName: poiResult.poiName, baseId: poiResult.baseId, resolved: true };
  }

  return { systemId, poiId: baseId, poiName: baseId, baseId, resolved: false };
}

export function record(
  baseId: string,
  metadata: { systemId?: string; baseId?: string; poiId?: string; poiName?: string; updatedAt?: number },
  tick: number,
  items: Array<{
    item_id: string;
    item_name?: string;
    sell_orders?: Array<{ price?: number; price_each?: number; quantity?: number; source?: string; order_id?: string; id?: string }>;
    buy_orders?: Array<{ price?: number; price_each?: number; quantity?: number; source?: string; order_id?: string; id?: string }>;
    [key: string]: unknown;
  }>
): void {
  const now = metadata.updatedAt ?? Date.now();
  const systemId = metadata.systemId ?? baseId;

  const { systemId: resolvedSystemId, poiId, poiName, baseId: resolvedBaseId, resolved } = resolveMetadata(
    baseId,
    systemId,
    metadata.baseId,
    metadata.systemId,
    metadata.poiId,
    metadata.poiName
  );

  if (!resolved) {
    const warnKey = `${resolvedSystemId}|${baseId}`;
    if (!unresolvedBaseWarned.has(warnKey)) {
      unresolvedBaseWarned.add(warnKey);
      log("warn", `[marketSnapshot] Unresolved baseId "${baseId}" in system "${resolvedSystemId}" — excluded from planning`);
    }
    return;
  }

  const key = stationKey(resolvedSystemId, poiId);

  const newItems: MarketBookItem[] = [];
  for (const item of items) {
    const itemId = item.item_id;
    if (!itemId) continue;
    const itemName = item.item_name ?? itemId;
    const buyOrders = normalizeOrders(item.buy_orders);
    const sellOrders = normalizeOrders(item.sell_orders);
    if (buyOrders.length === 0 && sellOrders.length === 0) continue;
    newItems.push({ itemId, itemName, buyOrders, sellOrders });
  }

  if (newItems.length === 0) {
    snapshots.delete(key);
    return;
  }

  const snapshot: MarketStationSnapshot = {
    baseId: resolvedBaseId,
    systemId: resolvedSystemId,
    poiId,
    poiName,
    updatedAt: now,
    snapshotTick: tick,
    items: newItems,
  };

  snapshots.set(key, { snapshot, resolved: true, warnIssued: false });
}

export function getFreshSnapshots(maxAgeMs: number = FRESHNESS_WINDOW_MS): MarketStationSnapshot[] {
  const now = Date.now();
  const fresh: MarketStationSnapshot[] = [];
  for (const [key, internal] of snapshots) {
    const age = now - internal.snapshot.updatedAt;
    if (age <= maxAgeMs) {
      fresh.push(internal.snapshot);
    } else {
      snapshots.delete(key);
    }
  }
  return fresh;
}

export const getFreshMarketSnapshots = getFreshSnapshots;

export function getSnapshot(systemId: string, poiId: string): MarketStationSnapshot | null {
  const internal = snapshots.get(stationKey(systemId, poiId));
  return internal?.snapshot ?? null;
}

export function clearSnapshot(systemId: string, poiId: string): void {
  const key = stationKey(systemId, poiId);
  snapshots.delete(key);
  mobileCapitalWarned.delete(key);
  unresolvedBaseWarned.delete(key);
}

export const FRESHNESS_WINDOW = FRESHNESS_WINDOW_MS;