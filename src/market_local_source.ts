import { existsSync, statSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import type { MarketQueryRequest, MarketQueryResponse, MarketQueryResult } from "./client_sync_types.js";

/**
 * Local market data source.
 *
 * `data/marketDetails.json` is written by the `market` routine (one bot parked
 * at every station, continuously re-scanning its local market). Two very
 * different callers need to read it:
 *
 *   1. The *remote* path: the sync master forwards another client's market
 *      query to this node's `/api/client-sync/market-query-handler`, which
 *      answers it out of this file.
 *   2. The *local* path (this is the new one): when the trader/faction trader
 *      is running in the SAME client as the market routines — or when there is
 *      no reachable remote market client at all — there is nobody to call. We
 *      must answer the query straight from the local file instead of firing a
 *      network request that can only ever fail.
 *
 * Both paths funnel through `queryLocalMarket()` here so the two can never
 * drift apart.
 *
 * The file is big (10MB+ on a mature fleet) and a single trader scan fans out
 * ~20 concurrent item queries, so parsing per query would be brutal: this
 * module keeps ONE parsed, item-indexed copy in memory, invalidates it on
 * mtime/size change, single-flights concurrent loads, and evicts the index
 * again once nothing has used it for a while.
 */

const DATA_DIR = join(process.cwd(), "data");
const MARKET_DETAILS_FILE = join(DATA_DIR, "marketDetails.json");

/** Age past which local market data is considered stale (still usable as a
 *  last resort, but we say so in the diagnostics). Matches the market slave's
 *  own freshness window. */
export const LOCAL_MARKET_STALE_MS = 30 * 60 * 1000;

/** Don't re-stat the (large) market file more than this often. */
const STAT_THROTTLE_MS = 2_000;

/** Drop the parsed index if nothing has queried it for this long, so an idle
 *  client doesn't hold tens of MB of market data forever. */
const INDEX_IDLE_EVICT_MS = 5 * 60 * 1000;

/** Minimum time between re-parses of the market file. A busy fleet of market
 *  bots rewrites `marketDetails.json` every few seconds, and re-parsing 10MB
 *  on every trader scan would stall the whole client — market prices do not
 *  move fast enough to justify that. */
const INDEX_MIN_REFRESH_MS = 30_000;

interface MarketOrderDetail {
  price: number;
  quantity: number;
}

/** Trimmed form of a marketDetails.json entry: only the fields a query needs. */
interface LocalMarketItem {
  systemId: string;
  stationPoiId: string;
  stationName: string;
  itemName: string;
  buyOrders: MarketOrderDetail[];
  sellOrders: MarketOrderDetail[];
  lastUpdated: string;
}

interface RawMarketDetails {
  lastSaved?: string;
  items?: Array<{
    systemId?: string;
    stationPoiId?: string;
    stationName?: string;
    itemId?: string;
    itemName?: string;
    buyOrders?: MarketOrderDetail[];
    sellOrders?: MarketOrderDetail[];
    lastUpdated?: string;
  }>;
}

interface MarketIndex {
  /** itemId -> every station entry that carries it. */
  byItem: Map<string, LocalMarketItem[]>;
  itemCount: number;
  stationCount: number;
  mtimeMs: number;
  sizeBytes: number;
  builtAt: number;
  lastUsed: number;
}

export interface LocalMarketFileInfo {
  exists: boolean;
  /** Age of the file on disk in ms, or null when it doesn't exist. */
  ageMs: number | null;
  sizeBytes: number;
  mtimeMs: number;
}

export interface LocalMarketStatus extends LocalMarketFileInfo {
  /** File is present and actually holds market entries. */
  usable: boolean;
  /** File is present and younger than LOCAL_MARKET_STALE_MS. */
  fresh: boolean;
  /** At least one local bot is currently running the `market` routine. */
  marketRoutineRunning: boolean;
  /** Names of the local bots running the `market` routine. */
  marketRoutineBots: string[];
  /** Number of item entries currently indexed (0 until first load). */
  indexedEntries: number;
  /** Number of distinct stations currently indexed (0 until first load). */
  indexedStations: number;
  /** How long ago the in-memory index was parsed, or null when not loaded. */
  indexAgeMs: number | null;
  /** Last read/parse failure for the market file, if any. */
  loadError: string | null;
}

let index: MarketIndex | null = null;
let loadInFlight: Promise<MarketIndex | null> | null = null;
let lastLoadError: string | null = null;
let lastStatAt = 0;
let lastStat: LocalMarketFileInfo = { exists: false, ageMs: null, sizeBytes: 0, mtimeMs: 0 };
let evictTimer: ReturnType<typeof setInterval> | null = null;

// ── Live in-memory overlay ────────────────────────────────────────────────
// The market routine writes every observation to marketDetails.json, but the
// parsed index above is only refreshed every INDEX_MIN_REFRESH_MS (the file is
// 10MB+). That means a query could be answered with data up to ~30s older than
// what the market routine literally just saw. The routine therefore also feeds
// each observation straight into this overlay, which is consulted BEFORE the
// file index — so "the market routine's memory" is always the freshest answer
// and the file is the durable backing store.

/** itemId -> "systemId/poiId" -> freshest observation. */
const overlay = new Map<string, Map<string, LocalMarketItem>>();
/** Overlay entries older than this are ignored (the file index covers them). */
const OVERLAY_TTL_MS = 30 * 60 * 1000;
let overlayLastPrune = 0;

export interface LocalMarketObservation {
  itemId: string;
  itemName?: string;
  buyOrders: MarketOrderDetail[];
  sellOrders: MarketOrderDetail[];
}

/**
 * Record a live market observation from the `market` routine running in this
 * process. Consulted ahead of the parsed marketDetails.json index so routines
 * always see the newest prices, even between file re-parses.
 */
export function noteLocalMarketObservation(
  systemId: string,
  stationPoiId: string,
  stationName: string,
  items: LocalMarketObservation[],
): void {
  if (!systemId || !stationPoiId || items.length === 0) return;
  const stationKey = `${systemId}/${stationPoiId}`;
  const stamp = new Date().toISOString();
  for (const item of items) {
    if (!item.itemId) continue;
    let byStation = overlay.get(item.itemId);
    if (!byStation) {
      byStation = new Map();
      overlay.set(item.itemId, byStation);
    }
    byStation.set(stationKey, {
      systemId,
      stationPoiId,
      stationName: stationName || stationPoiId,
      itemName: item.itemName || item.itemId,
      buyOrders: item.buyOrders || [],
      sellOrders: item.sellOrders || [],
      lastUpdated: stamp,
    });
  }
  pruneOverlay();
}

function pruneOverlay(): void {
  const now = Date.now();
  if (now - overlayLastPrune < 60_000) return;
  overlayLastPrune = now;
  for (const [itemId, byStation] of overlay) {
    for (const [key, entry] of byStation) {
      const age = now - Date.parse(entry.lastUpdated);
      if (!Number.isFinite(age) || age > OVERLAY_TTL_MS) byStation.delete(key);
    }
    if (byStation.size === 0) overlay.delete(itemId);
  }
}

/** Drop every live observation (used by tests / manual refresh). */
export function clearLocalMarketOverlay(): void {
  overlay.clear();
}

/**
 * Record that a station proved it is NOT selling an item, even though our market
 * data says it is.
 *
 * The order book we publish is only as good as the last observation, and a
 * listing can be unbuyable while still being visible: it was filled between the
 * scan and our arrival, or every order in it is one of our own (the server then
 * answers "No one is selling X at this station"). Without this, the offending
 * row stays in the overlay/index at ~30s of age and every routine that reads it
 * keeps planning the same doomed round trip.
 *
 * Clears the sell side for that station+item in both the live overlay and the
 * in-memory file index. The next real observation from a market bot restores it.
 */
export function noteLocalMarketUnavailable(systemId: string, stationPoiId: string, itemId: string): void {
  if (!systemId || !stationPoiId || !itemId) return;
  const stationKey = `${systemId}/${stationPoiId}`;

  const byStation = overlay.get(itemId);
  const live = byStation?.get(stationKey);
  if (live && live.sellOrders.length > 0) {
    byStation!.set(stationKey, { ...live, sellOrders: [] });
  }

  const indexed = index?.byItem.get(itemId);
  if (indexed) {
    for (const entry of indexed) {
      if (entry.systemId === systemId && entry.stationPoiId === stationPoiId && entry.sellOrders.length > 0) {
        entry.sellOrders = [];
      }
    }
  }
}

/** How many item/station observations the live overlay currently holds. */
export function getLocalMarketOverlaySize(): { items: number; entries: number } {
  let entries = 0;
  for (const byStation of overlay.values()) entries += byStation.size;
  return { items: overlay.size, entries };
}

/** Bots running the `market` routine in THIS process -> last heartbeat time.
 *  Registered by the market routine itself (see routines/market.ts) so this
 *  module never has to import botmanager, which would drag the entire app in. */
const activeMarketRoutines = new Map<string, number>();

/** A market routine that stopped without unregistering (crash/kill) is treated
 *  as gone once its heartbeat goes quiet for this long. */
const MARKET_ROUTINE_HEARTBEAT_TTL_MS = 5 * 60 * 1000;

/** Called by the market routine when it starts, and on every scan cycle, to
 *  advertise that this client is producing its own market data. */
export function noteMarketRoutineActive(botName: string): void {
  activeMarketRoutines.set(botName || "?", Date.now());
}

/** Called by the market routine when it stops. */
export function noteMarketRoutineStopped(botName: string): void {
  activeMarketRoutines.delete(botName || "?");
}

/** Stat the market file, throttled — callers hit this on every query. */
export function getLocalMarketFileInfo(force = false): LocalMarketFileInfo {
  const now = Date.now();
  if (!force && now - lastStatAt < STAT_THROTTLE_MS) return lastStat;
  lastStatAt = now;
  try {
    if (!existsSync(MARKET_DETAILS_FILE)) {
      lastStat = { exists: false, ageMs: null, sizeBytes: 0, mtimeMs: 0 };
      return lastStat;
    }
    const st = statSync(MARKET_DETAILS_FILE);
    lastStat = {
      exists: true,
      ageMs: Math.max(0, now - st.mtimeMs),
      sizeBytes: st.size,
      mtimeMs: st.mtimeMs,
    };
  } catch {
    lastStat = { exists: false, ageMs: null, sizeBytes: 0, mtimeMs: 0 };
  }
  return lastStat;
}

/**
 * Which market routine(s) are running in THIS client right now?
 *
 * This is the signal that says "the market bots live here, so a remote call is
 * pointless — read the file we ourselves are writing". Primary source is the
 * routine's own registration; as a safety net we also accept a bot-status
 * provider that botmanager publishes on globalThis (no import, so this module
 * stays free of app-boot side effects).
 */
export function getLocalMarketRoutineBots(): string[] {
  const now = Date.now();
  const names = new Set<string>();
  for (const [name, seen] of activeMarketRoutines) {
    if (now - seen <= MARKET_ROUTINE_HEARTBEAT_TTL_MS) names.add(name);
    else activeMarketRoutines.delete(name);
  }
  try {
    const provider = (globalThis as {
      __getBotStatuses?: () => Array<{ username?: string; routine?: string | null; state?: string }>;
    }).__getBotStatuses;
    if (provider) {
      for (const b of provider()) {
        if (b.routine === "market" && b.state === "running") names.add(String(b.username || "?"));
      }
    }
  } catch {
    // best-effort
  }
  return [...names];
}

/** Combined view of the local market data source: file freshness + whether the
 *  market routine that maintains it is running here. */
export function getLocalMarketStatus(): LocalMarketStatus {
  const info = getLocalMarketFileInfo();
  const bots = getLocalMarketRoutineBots();
  const live = getLocalMarketOverlaySize();
  return {
    ...info,
    // "usable" deliberately does NOT require freshness: stale local data still
    // beats no data at all when there is no remote client to ask. Live
    // observations from a locally running market routine count too, so a fresh
    // install answers queries before the first marketDetails.json write.
    usable: (info.exists && info.sizeBytes > 2) || live.entries > 0,
    fresh: (info.exists && info.ageMs !== null && info.ageMs < LOCAL_MARKET_STALE_MS) || live.entries > 0,
    marketRoutineRunning: bots.length > 0,
    marketRoutineBots: bots,
    indexedEntries: (index?.itemCount ?? 0) + live.entries,
    indexedStations: index?.stationCount ?? 0,
    indexAgeMs: index ? Date.now() - index.builtAt : null,
    loadError: lastLoadError,
  };
}

function scheduleEviction(): void {
  if (evictTimer) return;
  evictTimer = setInterval(() => {
    if (index && Date.now() - index.lastUsed > INDEX_IDLE_EVICT_MS) {
      index = null;
      if (evictTimer) {
        clearInterval(evictTimer);
        evictTimer = null;
      }
    }
  }, 60_000);
  // Don't keep the process alive just for cache eviction.
  (evictTimer as unknown as { unref?: () => void }).unref?.();
}

function buildIndex(raw: RawMarketDetails, mtimeMs: number, sizeBytes: number): MarketIndex {
  const byItem = new Map<string, LocalMarketItem[]>();
  const stations = new Set<string>();
  let itemCount = 0;
  for (const entry of raw.items || []) {
    const itemId = entry.itemId;
    if (!itemId) continue;
    const trimmed: LocalMarketItem = {
      systemId: String(entry.systemId || ""),
      stationPoiId: String(entry.stationPoiId || ""),
      stationName: String(entry.stationName || entry.stationPoiId || ""),
      itemName: String(entry.itemName || itemId),
      buyOrders: Array.isArray(entry.buyOrders) ? entry.buyOrders : [],
      sellOrders: Array.isArray(entry.sellOrders) ? entry.sellOrders : [],
      lastUpdated: String(entry.lastUpdated || raw.lastSaved || ""),
    };
    const list = byItem.get(itemId);
    if (list) list.push(trimmed);
    else byItem.set(itemId, [trimmed]);
    stations.add(`${trimmed.systemId}/${trimmed.stationPoiId}`);
    itemCount++;
  }
  const now = Date.now();
  return { byItem, itemCount, stationCount: stations.size, mtimeMs, sizeBytes, builtAt: now, lastUsed: now };
}

/** Load (or reuse) the parsed, item-indexed market file. Single-flighted so a
 *  20-item trader scan parses the 10MB file at most once. Never throws. */
async function getIndex(): Promise<MarketIndex | null> {
  const info = getLocalMarketFileInfo();
  if (!info.exists) {
    index = null;
    return null;
  }
  if (index) {
    const unchanged = index.mtimeMs === info.mtimeMs && index.sizeBytes === info.sizeBytes;
    if (unchanged || Date.now() - index.builtAt < INDEX_MIN_REFRESH_MS) {
      index.lastUsed = Date.now();
      return index;
    }
  }
  if (loadInFlight) return loadInFlight;

  loadInFlight = (async () => {
    try {
      const text = await readFile(MARKET_DETAILS_FILE, "utf-8");
      const raw = JSON.parse(text) as RawMarketDetails;
      index = buildIndex(raw, info.mtimeMs, info.sizeBytes);
      lastLoadError = null;
      scheduleEviction();
      return index;
    } catch (err) {
      // Corrupt or mid-write file: keep whatever we had rather than going dark.
      lastLoadError = err instanceof Error ? err.message : String(err);
      return index;
    } finally {
      loadInFlight = null;
    }
  })();
  return loadInFlight;
}

/** Force the next query to re-read the file (used by tests / manual refresh). */
export function invalidateLocalMarketIndex(): void {
  index = null;
  lastLoadError = null;
  lastStatAt = 0;
}

let mapStoreRef: typeof import("./mapstore.js").mapStore | null = null;

async function estimateSystemDistance(fromSystem: string, toSystem: string): Promise<number> {
  try {
    if (!mapStoreRef) {
      // Dynamic import to avoid a static cycle (mapstore -> client_sync_hooks
      // -> market_local_source).
      mapStoreRef = (await import("./mapstore.js")).mapStore;
    }
    const systems = mapStoreRef.getAllSystems();
    const from = Object.values(systems).find((s) => s.id === fromSystem);
    const to = Object.values(systems).find((s) => s.id === toSystem);
    if (!from || !to) return 0;
    const fromPos = from.position as Record<string, number> | undefined;
    const toPos = to.position as Record<string, number> | undefined;
    if (!fromPos || !toPos) return 0;
    const dx = (fromPos.x || 0) - (toPos.x || 0);
    const dy = (fromPos.y || 0) - (toPos.y || 0);
    const dz = (fromPos.z || 0) - (toPos.z || 0);
    return Math.max(1, Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz) / 10));
  } catch {
    return 0;
  }
}

/**
 * Answer a market query from this node's own market data: the live in-memory
 * observations pushed by a locally running `market` routine first, then
 * `data/marketDetails.json` for every station the routine isn't parked at.
 *
 * Identical contract (and identical ranking rules) to the remote
 * `/api/client-sync/market-query-handler` path — "buy" returns the cheapest
 * sell orders, "sell" returns the highest buy orders — so a caller cannot tell
 * whether it was served locally or by a remote market client, apart from the
 * `source` marker on the result.
 */
export async function queryLocalMarket(query: MarketQueryRequest): Promise<MarketQueryResult> {
  const { itemId, maxPrice, minQuantity = 0, requesterSystemId, tradeType = "buy" } = query;
  if (!itemId) {
    return { ok: false, results: [], error: "itemId required", source: "local" };
  }

  const idx = await getIndex();
  const live = overlay.get(itemId);
  if (!idx && (!live || live.size === 0)) {
    const why = lastLoadError
      ? `local market file unreadable: ${lastLoadError}`
      : "No local market data (data/marketDetails.json missing)";
    return { ok: false, results: [], error: why, source: "local" };
  }

  // Merge: one entry per station, with a live observation always overriding the
  // (possibly minutes-old) parsed file entry for the same station.
  const byStation = new Map<string, LocalMarketItem>();
  for (const item of idx?.byItem.get(itemId) || []) {
    byStation.set(`${item.systemId}/${item.stationPoiId}`, item);
  }
  if (live) {
    for (const [key, item] of live) byStation.set(key, item);
  }
  if (byStation.size === 0) {
    return { ok: false, results: [], error: "No matching orders found", source: "local" };
  }

  const comparator = tradeType === "sell" ? (p: number) => p >= (maxPrice as number) : (p: number) => p <= (maxPrice as number);
  const results: MarketQueryResponse[] = [];
  for (const item of byStation.values()) {
    const orders = tradeType === "sell" ? item.buyOrders : item.sellOrders;
    if (!orders || orders.length === 0) continue;
    let filtered = orders.filter((o) => o.quantity >= minQuantity);
    if (typeof maxPrice === "number") filtered = filtered.filter((o) => comparator(o.price));
    if (filtered.length === 0) continue;
    filtered = [...filtered].sort((a, b) => (tradeType === "sell" ? b.price - a.price : a.price - b.price));
    const best = filtered[0];
    let distance: number | undefined;
    if (typeof requesterSystemId === "string" && requesterSystemId !== item.systemId) {
      distance = await estimateSystemDistance(requesterSystemId, item.systemId);
    }
    results.push({
      ok: true,
      stationName: item.stationName,
      systemId: item.systemId,
      stationPoiId: item.stationPoiId,
      price: best.price,
      quantity: best.quantity,
      distance,
      itemName: item.itemName,
      lastUpdated: item.lastUpdated,
    });
  }

  results.sort((a, b) => (tradeType === "sell" ? b.price - a.price : a.price - b.price));
  return {
    ok: results.length > 0,
    results: results.slice(0, 10),
    error: results.length === 0 ? "No matching orders found" : undefined,
    source: "local",
  };
}
