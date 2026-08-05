import { type SyncEventType } from "./client_sync_types.js";
import type { MarketQueryRequest, MarketQueryResult } from "./client_sync_types.js";

type PushFn = (type: SyncEventType, payload: Record<string, unknown>) => Promise<void>;

export interface SyncHookContext {
  masterUrl?: string;
  apiKey?: string;
  clientLabel?: string;
  enabled: boolean;
  pushToMaster?: (type: SyncEventType, payload: Record<string, unknown>) => Promise<void>;
}

let _push: PushFn | null = null;

let _marketQueryFn: ((query: MarketQueryRequest) => Promise<MarketQueryResult>) | null = null;

export function configureSync(_ctx: SyncHookContext): void {
  if (_ctx.pushToMaster) _push = _ctx.pushToMaster;
}

export function setPushFn(fn: PushFn): void {
  _push = fn;
}

export function setMarketQueryFn(fn: (query: MarketQueryRequest) => Promise<MarketQueryResult>): void {
  _marketQueryFn = fn;
}

async function _fire(type: SyncEventType, payload: Record<string, unknown>): Promise<void> {
  if (!_push) return;
  try {
    await _push(type, payload);
  } catch {
    // Swallow sync push failures; next cycle will reconcile.
  }
}

export async function onPoiUpdate(systemId: string, poi: Record<string, unknown>): Promise<void> {
  await _fire("poi", { systemId, poi });
}

export async function onMarketUpdate(station: string, orders: Record<string, unknown>[]): Promise<void> {
  await _fire("market", { station, orders });
}

export async function onPlayerNameUpdate(
  name: string,
  faction?: string,
  lastSeen?: string
): Promise<void> {
  await _fire("playerName", { name, faction, lastSeen });
}

export async function onCivilianTransportUpdate(
  manifest: Record<string, unknown>
): Promise<void> {
  await _fire("civilianTransport", { manifest });
}

export async function onCoordinationUpdate(file: string, data: unknown): Promise<void> {
  await _fire("coordination", { file, data: JSON.parse(JSON.stringify(data)) });
}

export async function onRescueUpdate(type: "queue" | "blackbook", data: unknown): Promise<void> {
  await _fire("rescue", { type, data: JSON.parse(JSON.stringify(data)) });
}

export async function onWildlifeUpdate(data: unknown): Promise<void> {
  await _fire("wildlife", { data: JSON.parse(JSON.stringify(data)) });
}

/**
 * Query the remote market data held by another connected client (via the sync
 * master). Returns the best deal(s) for the requested item, or an error if no
 * market data is available.
 *
 * This is a low-bandwidth alternative to syncing the full marketDetails.json:
 * the request is ~200 bytes and the response is ~200 bytes per result, instead
 * of transferring 5MB+ every 10 seconds.
 */
export async function queryRemoteMarket(query: MarketQueryRequest): Promise<MarketQueryResult> {
  if (!_marketQueryFn) {
    return { ok: false, results: [], error: "Market sync not configured" };
  }
  try {
    return await _marketQueryFn(query);
  } catch (err) {
    return { ok: false, results: [], error: err instanceof Error ? err.message : String(err) };
  }
}
