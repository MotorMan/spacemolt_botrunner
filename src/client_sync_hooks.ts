import { type SyncEventType } from "./client_sync_types.js";
import type { MarketQueryRequest, MarketQueryResult } from "./client_sync_types.js";
import { getLocalMarketStatus, queryLocalMarket, type LocalMarketStatus } from "./market_local_source.js";

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
 * Query the market data held by another connected client (via the sync master),
 * or — when there is no remote client to ask — this client's own local market
 * file.
 *
 * Source detection (see `resolveMarketSource`) runs first, so a trader that is
 * running in the SAME client as the market routines reads `marketDetails.json`
 * directly instead of firing a call out of the client that can only fail.
 *
 * The remote path stays a low-bandwidth alternative to syncing the full
 * marketDetails.json: the request is ~200 bytes and the response is ~200 bytes
 * per result, instead of transferring 10MB+ every 10 seconds.
 */
export async function queryRemoteMarket(query: MarketQueryRequest): Promise<MarketQueryResult> {
  const source = await resolveMarketSource();

  if (source.mode === "local") {
    const local = await queryLocalMarket(query);
    // Mixed deployment: some market bots here, some on another client. Local is
    // authoritative and free, but if it has nothing for this item and a remote
    // link happens to be up, still ask — no reason to lose a deal.
    if (!local.ok && source.remoteFallback) {
      const remote = await runRemoteQuery(query);
      if (remote.ok) {
        noteRemoteSuccess();
        return remote;
      }
    }
    return local;
  }

  if (source.mode === "none") {
    return { ok: false, results: [], error: source.reason };
  }

  // Remote: ask the master (or, on a master node, route to a market client).
  const result = await runRemoteQuery(query);
  if (result.ok) noteRemoteSuccess();

  // Remote came back empty/failed but we do hold local market data: use it
  // rather than reporting "no deals". This is the case where the master has no
  // client advertising market data (e.g. every market bot moved into this
  // client), but the remote link itself is still up.
  if (!result.ok && source.localFallback) {
    const local = await queryLocalMarket(query);
    if (local.ok) {
      noteFallback(result.error || "no remote results");
      return local;
    }
  }
  return result;
}

/** Run the query over the client-connect link (slave query fn, or this node's
 *  own master routing to a client that advertises market data). Never throws. */
async function runRemoteQuery(query: MarketQueryRequest): Promise<MarketQueryResult> {
  try {
    const result = _marketQueryFn
      ? await _marketQueryFn(query)
      : await queryViaLocalMaster(query);
    return { ...result, source: "remote" };
  } catch (err) {
    return { ok: false, results: [], error: err instanceof Error ? err.message : String(err), source: "remote" };
  }
}

// ── Market source detection ───────────────────────────────────────────────
// Which market data source should this client use right now? Re-evaluated at
// most every MARKET_SOURCE_TTL_MS because it is consulted on every query (a
// single trader route scan fires ~20 of them).

export type MarketSourceMode = "local" | "remote" | "none";

export interface MarketSourceInfo {
  mode: MarketSourceMode;
  /** Human-readable explanation of why this mode was picked. */
  reason: string;
  /** Whether a failed/empty remote answer may fall back to the local file. */
  localFallback: boolean;
  /** Whether a local miss may still be backfilled from a connected client. */
  remoteFallback: boolean;
  /** Label routines can put in their logs: LocalMarket / RemoteMarket. */
  label: string;
  checkedAt: number;
}

const MARKET_SOURCE_TTL_MS = 15_000;

let _sourceInfo: MarketSourceInfo = {
  mode: "none",
  reason: "not checked yet",
  localFallback: false,
  remoteFallback: false,
  label: "Market",
  checkedAt: 0,
};
let _lastLoggedSource = "";
let _lastFallbackLog = 0;
/** Consecutive remote queries that came back empty while the local file could
 *  answer them. Enough of those and we stop paying for the round-trip. */
let _remoteMissStreak = 0;
/** While set (epoch ms), prefer the local file even though the remote link is
 *  up, because remote queries kept coming back empty. */
let _localPreferredUntil = 0;
const REMOTE_MISS_STREAK_LIMIT = 3;
const LOCAL_PREFERRED_COOLDOWN_MS = 5 * 60 * 1000;

/** Is the configured client-connect link actually up right now? A configured
 *  but disconnected slave is the same as having no remote client. */
function getRemoteLinkState(): { configured: boolean; connected: boolean; label: string } {
  const g = globalThis as {
    syncMarket?: { getState?: () => { connected?: boolean } };
    syncLight?: { getState?: () => { connected?: boolean } };
    syncSlave?: { getState?: () => { connected?: boolean } };
    syncMaster?: { getMarketClients?: () => Array<unknown> };
  };
  if (_marketQueryFn) {
    const client = g.syncMarket || g.syncLight || g.syncSlave;
    const label = g.syncMarket ? "market client" : g.syncLight ? "light client" : "slave client";
    if (!client?.getState) return { configured: true, connected: true, label };
    let connected = false;
    try {
      connected = !!client.getState().connected;
    } catch {
      connected = false;
    }
    return { configured: true, connected, label };
  }
  // Master node: no query fn is installed, but the master itself can route a
  // query to whichever connected client advertises market data.
  try {
    const clients = g.syncMaster?.getMarketClients?.() || [];
    if (clients.length > 0) return { configured: true, connected: true, label: `master (${clients.length} market client(s))` };
  } catch {
    // fall through
  }
  return { configured: false, connected: false, label: "none" };
}

/** Master-node remote path: route the query through our own sync master. */
async function queryViaLocalMaster(query: MarketQueryRequest): Promise<MarketQueryResult> {
  const master = (globalThis as {
    syncMaster?: { handleMarketQuery?: (q: MarketQueryRequest) => Promise<MarketQueryResult> };
  }).syncMaster;
  if (!master?.handleMarketQuery) {
    return { ok: false, results: [], error: "Market sync not configured" };
  }
  return master.handleMarketQuery(query);
}

/**
 * Decide where market data should come from.
 *
 *  1. Market routine(s) running in THIS client + a local market file → local.
 *     There is no point asking a remote client for data we are producing here,
 *     and this is exactly the "traders moved into the market client" case.
 *  2. No remote client configured/connected → local if we have a market file,
 *     otherwise `none` (nothing to query; callers just skip remote deals).
 *  3. Remote link up but its answers keep coming back empty while our own file
 *     can answer them → local for a cooldown, then retry remote.
 *  4. Otherwise → remote, with local kept as a fallback when we have a file.
 */
export async function resolveMarketSource(force = false): Promise<MarketSourceInfo> {
  const now = Date.now();
  if (!force && now - _sourceInfo.checkedAt < MARKET_SOURCE_TTL_MS) return _sourceInfo;

  let local: LocalMarketStatus;
  try {
    local = getLocalMarketStatus();
  } catch {
    local = {
      exists: false, ageMs: null, sizeBytes: 0, mtimeMs: 0, usable: false, fresh: false,
      marketRoutineRunning: false, marketRoutineBots: [], indexedEntries: 0, indexedStations: 0,
      indexAgeMs: null, loadError: null,
    };
  }
  const remote = getRemoteLinkState();

  let mode: MarketSourceMode;
  let reason: string;
  if (local.marketRoutineRunning && local.usable) {
    mode = "local";
    reason = `market routine running locally (${local.marketRoutineBots.length} bot(s): ${local.marketRoutineBots.slice(0, 3).join(", ")}${local.marketRoutineBots.length > 3 ? "…" : ""}) — reading data/marketDetails.json directly`;
  } else if (!remote.configured) {
    mode = local.usable ? "local" : "none";
    reason = local.usable
      ? "no client connect configured — reading local data/marketDetails.json"
      : "no client connect configured and no local data/marketDetails.json";
  } else if (!remote.connected) {
    mode = local.usable ? "local" : "none";
    reason = local.usable
      ? `${remote.label} not connected — reading local data/marketDetails.json`
      : `${remote.label} not connected and no local data/marketDetails.json`;
  } else if (_localPreferredUntil > now && local.usable) {
    mode = "local";
    reason = `remote market queries kept coming back empty — using local data/marketDetails.json (retrying ${remote.label} in ${Math.max(1, Math.round((_localPreferredUntil - now) / 60000))}min)`;
  } else {
    mode = "remote";
    reason = `querying remote market data via ${remote.label}`;
  }

  if (mode === "local" && !local.fresh && local.ageMs !== null) {
    reason += ` (stale: ${Math.round(local.ageMs / 60000)}min old)`;
  }

  _sourceInfo = {
    mode,
    reason,
    localFallback: mode === "remote" && local.usable,
    remoteFallback: mode === "local" && remote.configured && remote.connected,
    label: mode === "local" ? "LocalMarket" : mode === "remote" ? "RemoteMarket" : "Market",
    checkedAt: now,
  };

  const sig = `${mode}|${reason}`;
  if (sig !== _lastLoggedSource) {
    _lastLoggedSource = sig;
    console.log(`[MarketSource] ${mode.toUpperCase()}: ${reason}`);
  }
  return _sourceInfo;
}

/** Last detected market source (no I/O). Used by routines for log labelling. */
export function getMarketSourceInfo(): MarketSourceInfo {
  return _sourceInfo;
}

/** Log label for the active market source, e.g. "LocalMarket". */
export function getMarketSourceLabel(): string {
  return _sourceInfo.label;
}

/** A remote answer proves the link is useful again: clear the miss streak and
 *  any local-preferred cooldown. */
function noteRemoteSuccess(): void {
  _remoteMissStreak = 0;
  if (_localPreferredUntil) {
    _localPreferredUntil = 0;
    _sourceInfo = { ..._sourceInfo, checkedAt: 0 };
  }
}

function noteFallback(why: string): void {
  _remoteMissStreak++;
  if (_remoteMissStreak >= REMOTE_MISS_STREAK_LIMIT && _localPreferredUntil < Date.now()) {
    // The remote link is up but has nothing for us (typically: the master has
    // no client advertising market data because every market bot now lives in
    // this client). Stop paying for the round-trip for a while — the source is
    // re-evaluated once the cooldown expires.
    _localPreferredUntil = Date.now() + LOCAL_PREFERRED_COOLDOWN_MS;
    _sourceInfo = { ..._sourceInfo, checkedAt: 0 };
    console.log(`[MarketSource] ${_remoteMissStreak} empty remote market queries in a row (${why}) — switching to the local data/marketDetails.json for ${Math.round(LOCAL_PREFERRED_COOLDOWN_MS / 60000)}min`);
    return;
  }
  const now = Date.now();
  if (now - _lastFallbackLog < 60_000) return;
  _lastFallbackLog = now;
  console.log(`[MarketSource] Remote market query returned nothing (${why}) — served from local data/marketDetails.json instead`);
}

