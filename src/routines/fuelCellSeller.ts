/**
 * Fuel Cell Seller routine — travels to non-pirate stations and posts fuel cells for sale.
 *
 * Unlike full traders, this bot:
 * - Always starts at faction home base with MAX fuel cells
 * - Travels to each non-pirate station and creates sell orders
 * - Uses auto-pricing (midpoint between min/max) or manual price
 * - Returns home to restock and repeat
 *
 * Every station is screened BEFORE any network call is spent on it:
 * - Settings → Station Blacklist (restricted stations that refuse docking, banned
 *   faction outposts) and Settings → System Blacklist are always honoured, as is
 *   the runtime "this station denied us docking" set from common.ts.
 * - Faction deployable outposts are skipped — only the owning faction can dock
 *   there, so both the remote order check and a visit are guaranteed waste.
 * - Stations that answer "That station does not have a market" (or refuse to let
 *   us dock) are remembered in data/fcStations.json and skipped until the relearn
 *   window expires, instead of being re-queried on every pass.
 *
 * Tracks placed orders in data/fcStations.json.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import type { Routine, RoutineContext } from "../bot.js";
import { mapStore, type StoredPOI } from "../mapstore.js";
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
  isPirateSystem,
  checkAndFleeFromBattle,
  checkBattleAfterCommand,
  travelToStationWithHint,
  buildDeniedStationSet,
  markStationDenied,
  type BattleState,
  getBattleStatus,
  fleeFromBattle,
} from "./common.js";
import { getSystemBlacklist } from "../web/server.js";
import { queryRemoteMarket } from "../client_sync_hooks.js";

const FUEL_CELL_ITEM_ID = "fuel_cell";
const FUEL_CELL_ITEM_NAME = "Fuel Cell";
const FC_STATIONS_FILE = "data/fcStations.json";
/** Curated list of NPC stations. Used only as an exemption list: an NPC station
 *  named "... Outpost" (Void Gate Outpost, Deep Range Outpost) is a real, dockable
 *  station with a market and must never be mistaken for a faction outpost. */
const STATION_REF_FILE = "data/stationRef.json";

/** Pacing between remote `view_orders` queries. The server tolerates ~2/s, so 500ms
 *  is both the default and the floor — the old 5s spacing made a full 57-station
 *  sweep take five minutes. */
const DEFAULT_REMOTE_CHECK_DELAY_MS = 500;
const MIN_REMOTE_CHECK_DELAY_MS = 500;
/** How long a learned "no market"/"docking denied" verdict is trusted before we
 *  spend another query re-testing it (player stations can add a market later). */
const DEFAULT_RELEARN_HOURS = 168; // 7 days
/** A station the server does not know about may just be missing from our map, so
 *  it is retried far sooner than a hard "no market" answer. */
const UNKNOWN_STATION_RELEARN_MS = 24 * 60 * 60 * 1000;
/** Blacklist lookups read settings from disk, so cache them for a sweep. */
const FILTER_CACHE_MS = 10_000;

interface FCOrder {
  orderId: string;
  quantity: number;
  remaining: number;
  filledQuantity: number;
  priceEach: number;
  createdAt: string;
}

/** Why a station is not a usable fuel-cell sales target. */
export type FCSkipReason =
  | "pirate_system"
  | "system_blacklisted"
  | "station_blacklisted"
  | "outpost"
  | "no_market"
  | "dock_denied"
  | "unknown_station";

const SKIP_LABELS: Record<FCSkipReason, string> = {
  pirate_system: "pirate system",
  system_blacklisted: "system blacklisted",
  station_blacklisted: "station blacklisted",
  outpost: "faction outpost",
  no_market: "no market",
  dock_denied: "docking denied",
  unknown_station: "unknown station",
};

/** Skip reasons the bot can learn at runtime (the rest come from settings/map). */
const LEARNABLE_SKIPS: ReadonlySet<FCSkipReason> = new Set<FCSkipReason>([
  "no_market",
  "dock_denied",
  "unknown_station",
]);

export interface FCStationEntry {
  systemId: string;
  poiId: string;
  poiName: string;
  ordersPlaced: number;
  ordersUnsold: number;
  activeOrders: FCOrder[];
  lastVisit: string | null;
  lastPrice: number | null;
  /** Learned verdict from a real server answer ("no market", docking refused, …). */
  learnedSkip?: FCSkipReason | null;
  /** When the verdict was learned — drives the relearn window. */
  learnedSkipAt?: string | null;
  /** The server message that produced the verdict (diagnostics only). */
  learnedSkipDetail?: string | null;
  /** Last computed reason this station was skipped (diagnostics only). */
  skipReason?: FCSkipReason | null;
}

export interface FCStationsData {
  version: number;
  homeSystem: string;
  homeStation: string;
  stations: FCStationEntry[];
  currentStationIndex: number;
  lastStarted: string;
}

function emptyFCStationsData(): FCStationsData {
  return {
    version: 2,
    homeSystem: "",
    homeStation: "",
    stations: [],
    currentStationIndex: 0,
    lastStarted: new Date().toISOString(),
  };
}

function loadFCStationsData(): FCStationsData {
  try {
    if (!existsSync(FC_STATIONS_FILE)) {
      return emptyFCStationsData();
    }
    const rawData = readFileSync(FC_STATIONS_FILE, "utf-8");
    const data: FCStationsData = JSON.parse(rawData);
    // Backward compatibility: only keep fields we want, add ordersUnsold, activeOrders
    // and the learned-skip fields (added in version 2) if missing.
    data.stations = (data.stations ?? []).map(station => ({
      systemId: station.systemId,
      poiId: station.poiId,
      poiName: station.poiName,
      ordersPlaced: station.ordersPlaced ?? 0,
      ordersUnsold: station.ordersUnsold ?? 0,
      activeOrders: station.activeOrders ?? [],
      lastVisit: station.lastVisit ?? null,
      lastPrice: station.lastPrice ?? null,
      learnedSkip: station.learnedSkip ?? null,
      learnedSkipAt: station.learnedSkipAt ?? null,
      learnedSkipDetail: station.learnedSkipDetail ?? null,
      skipReason: station.skipReason ?? null,
    }));
    data.version = 2;
    return data;
  } catch {
    return emptyFCStationsData();
  }
}

function saveFCStationsData(data: FCStationsData): void {
  writeFileSync(FC_STATIONS_FILE, JSON.stringify(data, null, 2));
}

// ── Station eligibility ──────────────────────────────────────

let filterCache: { at: number; systems: Set<string>; stations: Set<string> } | null = null;

/** Current system + station exclusions. `buildDeniedStationSet()` already folds
 *  Settings → Station Blacklist together with every station that refused us
 *  docking during this process's lifetime. */
function getBlacklistFilters(force = false): { systems: Set<string>; stations: Set<string> } {
  const now = Date.now();
  if (!force && filterCache && now - filterCache.at < FILTER_CACHE_MS) return filterCache;
  filterCache = {
    at: now,
    systems: new Set(getSystemBlacklist().map(s => s.toLowerCase())),
    stations: buildDeniedStationSet(),
  };
  return filterCache;
}

export function isStationBlacklisted(systemId: string, poiId: string, stations: Set<string>): boolean {
  if (stations.size === 0) return false;
  return stations.has(poiId.toLowerCase()) || stations.has(`${systemId}|${poiId}`.toLowerCase());
}

let npcStationIds: Set<string> | null = null;

/** POI ids of the game's own NPC stations (data/stationRef.json). */
function getNpcStationIds(): Set<string> {
  if (npcStationIds) return npcStationIds;
  const ids = new Set<string>();
  try {
    if (existsSync(STATION_REF_FILE)) {
      const ref = JSON.parse(readFileSync(STATION_REF_FILE, "utf-8")) as {
        stations?: Array<{ station_id?: string }>;
      };
      for (const s of ref.stations ?? []) {
        if (s.station_id) ids.add(s.station_id.toLowerCase());
      }
    }
  } catch {
    // The whitelist is only an exemption list — an unreadable file just means
    // no exemptions, never a crash.
  }
  npcStationIds = ids;
  return ids;
}

function findMapPoi(systemId: string, poiId: string): StoredPOI | undefined {
  const sys = mapStore.getSystem(systemId);
  if (!sys) return undefined;
  const lower = poiId.toLowerCase();
  return sys.pois.find(p => p.id === poiId) ?? sys.pois.find(p => p.id.toLowerCase() === lower);
}

/** True when a station is a faction outpost nobody outside the owning faction can
 *  dock at. The only authoritative signal is `get_base` (which returns
 *  `base_type: "outpost"`) — and we only get that for a POI we have physically
 *  visited, so it lands in the map via get_poi/get_base. A player can name a
 *  station anything, so the name is NEVER used. Stations with a recorded market
 *  or an NPC id in stationRef are never treated as outposts. When the map has no
 *  base_type for a POI we fall back to the learned dock-denied verdict at visit
 *  time (see classifyStationError). */
export function looksLikeOutpost(entry: Pick<FCStationEntry, "systemId" | "poiId" | "poiName">): boolean {
  if (getNpcStationIds().has(entry.poiId.toLowerCase())) return false;
  const poi = findMapPoi(entry.systemId, entry.poiId);
  if (poi && poi.market && poi.market.length > 0) return false; // we have traded here before
  const baseType = `${poi?.base_type ?? ""}`.toLowerCase();
  if (baseType.includes("outpost")) return true;
  // Last-resort: the map POI `type` is occasionally tagged too (rare for the
  // deployed outposts, which ship as plain "station"), so only act on an explicit
  // outpost type — never guess from the name.
  const poiType = `${poi?.type ?? ""}`.toLowerCase();
  return poiType === "outpost";
}

/** True only when the map explicitly lists this station's services and a market
 *  is not among them. Unknown/empty service lists stay optimistic. */
export function mapSaysNoMarket(poi: StoredPOI | undefined): boolean {
  const svc = poi?.services;
  if (!Array.isArray(svc) || svc.length === 0) return false;
  return !svc.some(s => String(s).toLowerCase() === "market");
}

function ageMs(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, now - t);
}

/** Record a server-proven verdict so this station is skipped from now on. */
function markStationLearnedSkip(
  ctx: RoutineContext,
  entry: FCStationEntry,
  reason: FCSkipReason,
  detail?: string,
): void {
  const isNew = entry.learnedSkip !== reason;
  entry.learnedSkip = reason;
  entry.learnedSkipAt = new Date().toISOString();
  entry.learnedSkipDetail = detail ? detail.slice(0, 200) : null;
  entry.skipReason = reason;
  if (reason === "dock_denied") {
    // Also stop every other routine in this process from retrying the dock.
    markStationDenied(entry.poiId);
  }
  if (isNew) {
    ctx.log(
      "fc",
      `Marking ${entry.poiName} (${entry.poiId}) as ${SKIP_LABELS[reason]} — skipping it from now on. ` +
        `Add "${entry.poiId}" to Settings → Station Blacklist to skip it permanently.`,
    );
  }
}

/**
 * Decide whether a station may be used at all. Expired learned verdicts are
 * cleared here (so a station that later builds a market gets retried), which is
 * why callers persist the data after a sweep.
 */
export function evaluateStationSkip(
  entry: FCStationEntry,
  data: FCStationsData,
  settings: ReturnType<typeof getFuelCellSellerSettings>,
  filters: { systems: Set<string>; stations: Set<string> },
  now: number = Date.now(),
): FCSkipReason | null {
  // The home station is explicitly configured by the user: it is where cargo is
  // withdrawn, so config-based exclusions never apply to it. Server-proven
  // verdicts (no market) still do — we simply cannot sell there.
  const isHome = entry.systemId === data.homeSystem && entry.poiId === data.homeStation;

  if (entry.learnedSkip && LEARNABLE_SKIPS.has(entry.learnedSkip)) {
    const window = entry.learnedSkip === "unknown_station"
      ? UNKNOWN_STATION_RELEARN_MS
      : settings.relearnMs;
    const age = ageMs(entry.learnedSkipAt, now);
    if (age === null || age < window) {
      entry.skipReason = entry.learnedSkip;
      return entry.learnedSkip;
    }
    // Window elapsed — give the station one more chance.
    entry.learnedSkip = null;
    entry.learnedSkipAt = null;
    entry.learnedSkipDetail = null;
  }

  if (!isHome) {
    if (isPirateSystem(entry.systemId)) {
      entry.skipReason = "pirate_system";
      return "pirate_system";
    }
    if (filters.systems.has(entry.systemId.toLowerCase())) {
      entry.skipReason = "system_blacklisted";
      return "system_blacklisted";
    }
    if (isStationBlacklisted(entry.systemId, entry.poiId, filters.stations)) {
      entry.skipReason = "station_blacklisted";
      return "station_blacklisted";
    }
    if (settings.skipOutposts && looksLikeOutpost(entry)) {
      entry.skipReason = "outpost";
      return "outpost";
    }
    if (mapSaysNoMarket(findMapPoi(entry.systemId, entry.poiId))) {
      entry.skipReason = "no_market";
      return "no_market";
    }
  }

  entry.skipReason = null;
  return null;
}

/** Split the persisted list into usable stations and a per-reason skip tally. */
export function partitionStations(
  data: FCStationsData,
  settings: ReturnType<typeof getFuelCellSellerSettings>,
  filters: { systems: Set<string>; stations: Set<string> },
): { eligible: Array<{ entry: FCStationEntry; idx: number }>; skipped: Map<FCSkipReason, number> } {
  const eligible: Array<{ entry: FCStationEntry; idx: number }> = [];
  const skipped = new Map<FCSkipReason, number>();
  const now = Date.now();
  data.stations.forEach((entry, idx) => {
    const reason = evaluateStationSkip(entry, data, settings, filters, now);
    if (reason) {
      skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
      return;
    }
    eligible.push({ entry, idx });
  });
  return { eligible, skipped };
}

export function describeSkips(skipped: Map<FCSkipReason, number>): string {
  if (skipped.size === 0) return "none";
  return [...skipped.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${count} ${SKIP_LABELS[reason]}`)
    .join(", ");
}

/** Map a server error message onto a skip verdict, or null when it is unrelated. */
export function classifyStationError(message: string | undefined | null): FCSkipReason | null {
  const msg = (message || "").toLowerCase();
  if (!msg) return null;
  // Transient conditions ("docking restricted while in battle", rate limits, …)
  // must never be recorded as a permanent verdict about the station.
  if (
    msg.includes("battle") ||
    msg.includes("combat") ||
    msg.includes("cooldown") ||
    msg.includes("rate limit") ||
    msg.includes("too many") ||
    msg.includes("try again")
  ) {
    return null;
  }
  if (msg.includes("not have a market") || msg.includes("no market") || msg.includes("without a market")) {
    return "no_market";
  }
  if (
    msg.includes("access denied") ||
    msg.includes("docking denied") ||
    msg.includes("not public") ||
    msg.includes("restricted") ||
    msg.includes("no permission") ||
    msg.includes("not permitted") ||
    msg.includes("not allowed to dock")
  ) {
    return "dock_denied";
  }
  if (
    msg.includes("station not found") ||
    msg.includes("unknown station") ||
    msg.includes("no such station") ||
    msg.includes("invalid station")
  ) {
    return "unknown_station";
  }
  return null;
}

/**
 * Check orders at a specific station remotely using view_orders with station_id.
 * Updates the station entry with current active orders. Pacing is the caller's
 * job so a single sweep can control its own rate.
 * Returns whether the check succeeded and any verdict learned from the failure.
 */
async function checkStationOrdersRemote(
  ctx: RoutineContext,
  stationEntry: FCStationEntry,
): Promise<{ ok: boolean; learned: FCSkipReason | null }> {
  const { bot } = ctx;

  try {
    // Use station_id parameter to check orders at this station remotely
    const ordersResp = await bot.exec("view_orders", { station_id: stationEntry.poiId });

    if (ordersResp.error || !ordersResp.result || typeof ordersResp.result !== "object") {
      const message = ordersResp.error?.message || "no result";
      const learned = classifyStationError(message);
      if (learned) {
        markStationLearnedSkip(ctx, stationEntry, learned, message);
      } else {
        ctx.log("fc", `Remote check failed for ${stationEntry.poiName}: ${message.split("\n")[0]}`);
      }
      return { ok: false, learned };
    }

    const ordersData = ordersResp.result as Record<string, unknown>;
    const orders = Array.isArray(ordersData.orders) ? ordersData.orders : [];

    // Filter for fuel_cell sell orders
    const fcOrders = orders.filter((o: any) => o.item_id === FUEL_CELL_ITEM_ID && o.side === "sell");

    const activeOrders = fcOrders.map((o: any) => ({
      orderId: o.order_id,
      quantity: o.quantity,
      remaining: o.remaining,
      filledQuantity: o.filled_quantity,
      priceEach: o.price_each,
      createdAt: o.created_at,
    }));

    // Update station entry
    stationEntry.activeOrders = activeOrders;
    stationEntry.ordersUnsold = activeOrders.reduce((sum: number, o: any) => sum + o.remaining, 0);
    stationEntry.lastVisit = new Date().toISOString();

    const totalPlaced = activeOrders.reduce((sum: any, o: any) => sum + o.quantity, 0);
    if (totalPlaced > 0) {
      stationEntry.ordersPlaced = totalPlaced;
    }

    ctx.log("fc", `Remote check: ${stationEntry.poiName} - ${activeOrders.length} active orders, ${stationEntry.ordersUnsold} unsold`);
    return { ok: true, learned: null };
  } catch (error) {
    ctx.log("error", `Remote check error for ${stationEntry.poiName}: ${error}`);
    return { ok: false, learned: null };
  }
}

/**
 * Check all eligible stations' orders remotely and update fcStations.json.
 *
 * Blacklisted stations, faction outposts and stations already proven to have no
 * market are never queried — they only produced guaranteed errors and burned
 * `remoteCheckDelayMs` each.
 */
async function updateAllStationsFromRemote(
  ctx: RoutineContext,
  data: FCStationsData,
  settings: ReturnType<typeof getFuelCellSellerSettings>,
): Promise<void> {
  const filters = getBlacklistFilters(true);
  const { eligible, skipped } = partitionStations(data, settings, filters);
  const skipCount = data.stations.length - eligible.length;

  ctx.log(
    "fc",
    `Starting remote update of ${eligible.length}/${data.stations.length} stations ` +
      `(${settings.remoteCheckDelayMs}ms apart; skipping ${skipCount}: ${describeSkips(skipped)})...`,
  );

  let successCount = 0;
  let failCount = 0;
  let learnedCount = 0;

  for (let i = 0; i < eligible.length; i++) {
    if (ctx.bot.state !== "running") {
      ctx.log("fc", "Bot stopped, aborting remote update");
      break;
    }

    const station = eligible[i].entry;
    if (i > 0) await ctx.sleep(settings.remoteCheckDelayMs);

    ctx.log("fc", `Checking ${station.poiName}... (${i + 1}/${eligible.length})`);
    const result = await checkStationOrdersRemote(ctx, station);

    if (result.ok) {
      successCount++;
    } else {
      failCount++;
      if (result.learned) learnedCount++;
    }

    // Save after each station so we don't lose progress
    saveFCStationsData(data);
  }

  ctx.log(
    "fc",
    `Remote update complete: ${successCount} succeeded, ${failCount} failed` +
      (learnedCount > 0 ? ` (${learnedCount} newly excluded)` : ""),
  );
  saveFCStationsData(data);
}

export function getFuelCellSellerSettings(username?: string): {
  homeSystem: string;
  homeStation: string;
  fuelCostPerJump: number;
  refuelThreshold: number;
  repairThreshold: number;
  priceMode: "manual" | "auto";
  baseTargetPrice: number;
  autoMinPrice: number;
  autoMaxPrice: number;
  maxFuelCellsPerStation: number;
  useRemoteMarketQuery: boolean;
  /** Delay between remote `view_orders` queries during a sweep (ms). */
  remoteCheckDelayMs: number;
  /** How often a full remote order sweep runs (ms). */
  remoteUpdateIntervalMs: number;
  /** Skip faction deployable outposts (nobody outside the faction can dock). */
  skipOutposts: boolean;
  /** How long a learned "no market"/"docking denied" verdict is trusted (ms). */
  relearnMs: number;
} {
  const all = readSettings();
  const general = (all.general as Record<string, unknown>) || {};
  const t = all.fuel_cell_seller as Record<string, unknown> | undefined;
  const fc = t || {};
  const botOverrides = username ? (all[username] as Record<string, unknown>) : undefined;
  const priceModeVal = (fc.priceMode as string) || "auto";
  const priceMode: "manual" | "auto" = priceModeVal === "manual" ? "manual" : "auto";
  const rawDelay = Number(fc.remoteCheckDelayMs ?? DEFAULT_REMOTE_CHECK_DELAY_MS);
  const rawInterval = Number(fc.remoteUpdateIntervalMinutes ?? 60);
  const rawRelearn = Number(fc.relearnHours ?? DEFAULT_RELEARN_HOURS);
  return {
    homeSystem: (botOverrides?.homeSystem as string) || (fc.homeSystem as string) || (general.factionStorageSystem as string) || "sol",
    homeStation: (botOverrides?.homeStation as string) || (fc.homeStation as string) || (general.factionStorageStation as string) || "sol_central",
    fuelCostPerJump: (fc.fuelCostPerJump as number) || 10,
    refuelThreshold: (fc.refuelThreshold as number) || 35,
    repairThreshold: (fc.repairThreshold as number) || 80,
    priceMode,
    baseTargetPrice: (fc.baseTargetPrice as number) || 40,
    autoMinPrice: (fc.autoMinPrice as number) || 30,
    autoMaxPrice: (fc.autoMaxPrice as number) || 50,
    maxFuelCellsPerStation: (fc.maxFuelCellsPerStation as number) || 20000,
    useRemoteMarketQuery: (fc.useRemoteMarketQuery as boolean) ?? true,
    remoteCheckDelayMs: Number.isFinite(rawDelay)
      ? Math.max(MIN_REMOTE_CHECK_DELAY_MS, Math.round(rawDelay))
      : DEFAULT_REMOTE_CHECK_DELAY_MS,
    remoteUpdateIntervalMs: Number.isFinite(rawInterval) && rawInterval > 0
      ? Math.round(rawInterval * 60 * 1000)
      : 60 * 60 * 1000,
    skipOutposts: (fc.skipOutposts as boolean) ?? true,
    relearnMs: Number.isFinite(rawRelearn) && rawRelearn > 0
      ? Math.round(rawRelearn * 60 * 60 * 1000)
      : DEFAULT_RELEARN_HOURS * 60 * 60 * 1000,
  };
}

function estimateFuelCost(fromSystem: string, toSystem: string, costPerJump: number): { jumps: number; cost: number } {
  if (fromSystem === toSystem) return { jumps: 0, cost: 0 };
  const route = mapStore.findRoute(fromSystem, toSystem);
  if (!route) return { jumps: 999, cost: 999 * costPerJump };
  const jumps = route.length - 1;
  return { jumps, cost: jumps * costPerJump };
}

/**
 * Build the candidate station list from the map, excluding everything we already
 * know we can never sell at: pirate systems, blacklisted systems/stations and
 * faction outposts. Learned verdicts are applied later (they live per entry).
 */
function initializeFCStations(settings: ReturnType<typeof getFuelCellSellerSettings>): FCStationEntry[] {
  const entries: FCStationEntry[] = [];
  const seen = new Set<string>();
  const filters = getBlacklistFilters(true);
  const systems = mapStore.getAllSystems();
  const mobileCapital = mapStore.getMobileCapitolLocation();

  for (const [systemId, sys] of Object.entries(systems)) {
    if (isPirateSystem(systemId)) continue;
    if (filters.systems.has(systemId.toLowerCase())) continue;

    for (const poi of sys.pois) {
      if (!poi.has_base && !poi.base_id) continue;
      if (isStationBlacklisted(systemId, poi.id, filters.stations)) continue;
      if (settings.skipOutposts && looksLikeOutpost({ systemId, poiId: poi.id, poiName: poi.name })) continue;
      if (mapSaysNoMarket(poi)) continue;

      // The mobile capital shows up in every system it has ever been seen in;
      // only its currently tracked location is real.
      const key = poi.id.toLowerCase();
      if (seen.has(key)) continue;
      if (poi.id === "mobile_capital" && mobileCapital && mobileCapital.systemId !== systemId) continue;
      seen.add(key);

      entries.push({
        systemId,
        poiId: poi.id,
        poiName: poi.name,
        ordersPlaced: 0,
        ordersUnsold: 0,
        activeOrders: [],
        lastVisit: null,
        lastPrice: null,
        learnedSkip: null,
        learnedSkipAt: null,
        learnedSkipDetail: null,
        skipReason: null,
      });
    }
  }

  return entries;
}

/**
 * Merge newly-mapped stations into the persisted list and retire dead rows.
 *
 * Order counts and learned verdicts of known stations are preserved. Entries that
 * are now excluded (blacklisted, outpost, …) are only dropped when nothing is
 * parked at them, so a blacklisted station that still holds our orders stays
 * visible in the file.
 */
function syncFCStations(
  ctx: RoutineContext,
  data: FCStationsData,
  settings: ReturnType<typeof getFuelCellSellerSettings>,
): boolean {
  const filters = getBlacklistFilters(true);
  const discovered = initializeFCStations(settings);
  const known = new Map(data.stations.map(s => [s.poiId.toLowerCase(), s]));

  let added = 0;
  for (const candidate of discovered) {
    const existing = known.get(candidate.poiId.toLowerCase());
    if (!existing) {
      data.stations.push(candidate);
      known.set(candidate.poiId.toLowerCase(), candidate);
      added++;
      continue;
    }
    // Keep names/locations current (stations get renamed, the capital moves).
    if (candidate.poiName && existing.poiName !== candidate.poiName) existing.poiName = candidate.poiName;
    if (existing.systemId !== candidate.systemId) existing.systemId = candidate.systemId;
  }

  const before = data.stations.length;
  data.stations = data.stations.filter(entry => {
    const isHome = entry.systemId === data.homeSystem && entry.poiId === data.homeStation;
    if (isHome) return true;
    const reason = evaluateStationSkip(entry, data, settings, filters);
    if (!reason) return true;
    // Config-based exclusions with nothing parked there are just noise.
    const hasStake = entry.ordersUnsold > 0 || entry.activeOrders.length > 0;
    return hasStake || LEARNABLE_SKIPS.has(reason);
  });
  const removed = before - data.stations.length;

  if (added > 0 || removed > 0) {
    ctx.log("fc", `Station list synced with map: +${added} new, -${removed} excluded (${data.stations.length} tracked)`);
  }
  return added > 0 || removed > 0;
}

async function getOptimalPrice(
  ctx: RoutineContext,
  marketData: unknown,
  settings: ReturnType<typeof getFuelCellSellerSettings>,
): Promise<number> {
  const { bot } = ctx;

  if (settings.priceMode === "manual") {
    return settings.baseTargetPrice;
  }

  if (!marketData || typeof marketData !== "object") {
    return settings.baseTargetPrice;
  }

  const md = marketData as Record<string, unknown>;
  const items = Array.isArray(md) ? md : Array.isArray(md.items) ? md.items : [];
  const fcItem = items.find(i => (i as Record<string, unknown>).item_id === FUEL_CELL_ITEM_ID);
  if (!fcItem) {
    return settings.baseTargetPrice;
  }

  const fi = fcItem as Record<string, unknown>;
  const bestSell = (fi.best_sell as number) || 0;
  const bestBuy = (fi.best_buy as number) || 0;

  if (bestSell > 0 && bestBuy > 0) {
    const midPrice = Math.round((bestBuy + bestSell) / 2);
    if (midPrice >= settings.autoMinPrice && midPrice <= settings.autoMaxPrice) {
      return midPrice;
    }
  }

  if (bestSell >= settings.autoMinPrice && bestSell <= settings.autoMaxPrice) {
    return bestSell;
  }

  if (bestBuy >= settings.autoMinPrice && bestBuy <= settings.autoMaxPrice) {
    return bestBuy;
  }

  return settings.baseTargetPrice;
}

/**
 * Pick the next station to sell at. Only stations that passed the eligibility
 * screen are considered, so blacklisted stations, faction outposts and stations
 * proven to have no market are never travelled to.
 */
function getNextStation(
  data: FCStationsData,
  settings: ReturnType<typeof getFuelCellSellerSettings>,
  filters: { systems: Set<string>; stations: Set<string> },
): number {
  const { eligible } = partitionStations(data, settings, filters);
  if (eligible.length === 0) return -1;

  // Always prioritize the home station if it can accept more orders
  const home = eligible.find(({ entry }) =>
    entry.systemId === data.homeSystem && entry.poiId === data.homeStation
  );
  if (home && home.entry.ordersUnsold < settings.maxFuelCellsPerStation) {
    return home.idx;
  }

  // Prioritize stations with lowest unsold (highest demand), then closest, then oldest visit
  const stationPriority = eligible.map(({ entry: station, idx }) => {
    const cost = estimateFuelCost(data.homeSystem, station.systemId, settings.fuelCostPerJump).cost;
    const lastVisit = station.lastVisit ? new Date(station.lastVisit).getTime() : 0;
    const isNearCap = station.ordersUnsold >= settings.maxFuelCellsPerStation;
    return {
      idx,
      ordersUnsold: station.ordersUnsold,
      cost,
      lastVisit,
      isNearCap,
      // Priority: low unsold first, then low cost, then old lastVisit
      // But skip near cap stations
      priorityScore: isNearCap ? 999999 : station.ordersUnsold,
      tieBreaker: cost,
      lastTie: lastVisit,
    };
  });

  // Sort by priorityScore ascending (low unsold first), then cost ascending, then lastVisit ascending
  stationPriority.sort((a, b) => {
    if (a.priorityScore !== b.priorityScore) return a.priorityScore - b.priorityScore;
    if (a.tieBreaker !== b.tieBreaker) return a.tieBreaker - b.tieBreaker;
    return a.lastTie - b.lastTie;
  });

  // Always pick the best (first in sorted)
  return stationPriority[0].idx;
}

export const fuelCellSellerRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  await bot.refreshStatus();
  const settings = getFuelCellSellerSettings(bot.username);
  const safetyOpts = {
    fuelThresholdPct: settings.refuelThreshold,
    hullThresholdPct: settings.repairThreshold,
  };

  let fcData = loadFCStationsData();

  if (!fcData.homeSystem || fcData.homeSystem !== settings.homeSystem) {
    fcData.homeSystem = settings.homeSystem;
    fcData.homeStation = settings.homeStation;
    fcData.stations = initializeFCStations(settings);
    fcData.currentStationIndex = 0;
    fcData.lastStarted = new Date().toISOString();
    saveFCStationsData(fcData);
  } else {
    // Fold in stations discovered since the list was built and retire rows that
    // the blacklist / outpost screen now excludes.
    syncFCStations(ctx, fcData, settings);
    saveFCStationsData(fcData);
  }

  {
    const { eligible, skipped } = partitionStations(fcData, settings, getBlacklistFilters(true));
    ctx.log(
      "fc",
      `Tracking ${fcData.stations.length} stations: ${eligible.length} sellable, ` +
        `${fcData.stations.length - eligible.length} skipped (${describeSkips(skipped)})`,
    );
  }

  // Track last remote update time for periodic checks
  let lastRemoteUpdate: number = 0;

  // Persistent battle state across cycles
  const battleState: BattleState = {
    inBattle: false,
    battleId: null,
    battleStartTick: null,
    lastHitTick: null,
    isFleeing: false,
    lastFleeTime: undefined,
  };

  while (bot.state === "running") {
    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) {
      await ctx.sleep(30000);
      continue;
    }

    if (await checkAndFleeFromBattle(ctx, "fuelCellSeller")) {
      await ctx.sleep(5000);
      continue;
    }

    // Periodic battle status check (backup detection in case notifications fail)
    // Check every cycle for fast detection
    if (bot.isInBattle()) {
      const now = Date.now();
      const timeSinceLastFlee = battleState.lastFleeTime ? now - battleState.lastFleeTime : Infinity;
      if (timeSinceLastFlee > 10000) { // Only issue if more than 10 seconds since last flee
        ctx.log("combat", `PERIODIC CHECK: IN BATTLE! - initiating IMMEDIATE flee!`);
        battleState.inBattle = true;
        battleState.isFleeing = false;

        await bot.exec("battle", { action: "stance", stance: "flee" });
        battleState.lastFleeTime = now;
        ctx.log("combat", "Flee stance issued - will re-issue every cycle until disengaged!");
      }
    }

    // Periodic remote update of station orders
    const now = Date.now();
    if (now - lastRemoteUpdate >= settings.remoteUpdateIntervalMs) {
      ctx.log("fc", "Time for periodic remote update of station orders...");
      await updateAllStationsFromRemote(ctx, fcData, settings);
      lastRemoteUpdate = now;
      // Reload data after update to ensure we have latest
      fcData = loadFCStationsData();
    }

    // Capacity is judged over sellable stations only — a blacklisted station or
    // one without a market must not keep the routine alive forever.
    const cycleFilters = getBlacklistFilters();
    const { eligible: sellable, skipped: cycleSkips } = partitionStations(fcData, settings, cycleFilters);
    if (fcData.stations.length > 0 && sellable.length === 0) {
      ctx.log(
        "fc",
        `No sellable stations left (${fcData.stations.length} tracked, all skipped: ${describeSkips(cycleSkips)}) — stopping routine`,
      );
      saveFCStationsData(fcData);
      return;
    }
    const allStationsFull = sellable.length > 0
      && sellable.every(({ entry }) => entry.ordersUnsold >= settings.maxFuelCellsPerStation);
    if (allStationsFull) {
      ctx.log("fc", "All stations are at or above capacity — stopping routine");
      return;
    }

    // If we're in battle, re-issue flee command to ensure we stay in flee stance
    if (battleState.inBattle) {
      const now = Date.now();
      const timeSinceLastFlee = battleState.lastFleeTime ? now - battleState.lastFleeTime : Infinity;
      if (timeSinceLastFlee > 10000) { // Only issue if more than 10 seconds since last flee
        ctx.log("combat", "Re-issuing flee stance (ensuring we stay in flee mode)...");
        const fleeResp = await bot.exec("battle", { action: "stance", stance: "flee" });
        if (fleeResp.error) {
          ctx.log("error", `Flee re-issue failed: ${fleeResp.error.message}`);
        } else {
          battleState.lastFleeTime = now;
        }
      }
      // Check if we've successfully disengaged
      const currentBattleStatus = await getBattleStatus(ctx);
      if (!currentBattleStatus || !currentBattleStatus.is_participant) {
        ctx.log("combat", "Battle cleared - no longer in combat!");
        battleState.inBattle = false;
        battleState.battleId = null;
        battleState.isFleeing = false;
        battleState.lastFleeTime = undefined;
        await ctx.sleep(2000); // Brief pause before next check
        continue;
      }
      // Still in battle - continue to next cycle
      await ctx.sleep(2000); // Brief pause before next check
      continue;
    }

    await bot.refreshStatus();
    await bot.refreshCargo();

    const fuelCellItem = bot.inventory.find(i => i.itemId === FUEL_CELL_ITEM_ID);
    let cargoQty = fuelCellItem?.quantity ?? 0;

    const atHomeStation = bot.system === settings.homeSystem && bot.poi === settings.homeStation;

    // Restart recovery: empty cargo not at home → return home; full cargo → proceed to station
    if (!atHomeStation && cargoQty <= 0) {
      ctx.log("fc", `Restart recovery: empty cargo not at home (${bot.system}/${bot.poi}) — returning home`);
      yield "return_home";
      if (bot.system !== settings.homeSystem) {
        await ensureUndocked(ctx);
        const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
        if (!fueled) {
          ctx.log("error", "Cannot refuel for return journey");
          await ctx.sleep(60000);
          continue;
        }
        await navigateToSystem(ctx, settings.homeSystem, safetyOpts);
      }
      if (bot.poi !== settings.homeStation) {
        await ensureUndocked(ctx);
        const travelResp = await bot.exec("travel", { target_poi: settings.homeStation });
        if (travelResp.error) {
          ctx.log("error", `Return travel failed: ${travelResp.error.message}`);
          await ctx.sleep(30000);
          continue;
        }
        bot.poi = settings.homeStation;
      }
      await bot.refreshCargo();
      const postReturnCargo = bot.inventory.find(i => i.itemId === FUEL_CELL_ITEM_ID);
      cargoQty = postReturnCargo?.quantity ?? 0;
    } else if (!atHomeStation && cargoQty > 0) {
      ctx.log("fc", `Restart recovery: cargo present — heading to selected station`);
    }

    await ensureDocked(ctx);
    await tryRefuel(ctx);
    await repairShip(ctx);

    await bot.refreshCargo();
    const currentFuelCellCargo = bot.inventory.find(i => i.itemId === FUEL_CELL_ITEM_ID);
    const cargoAfterMaintenance = currentFuelCellCargo?.quantity ?? 0;
    const atHomeStationAfterMaintenance = bot.system === settings.homeSystem && bot.poi === settings.homeStation;

    if (cargoAfterMaintenance <= 0) {
      if (atHomeStationAfterMaintenance) {
        ctx.log("fc", "No cargo at home station — attempting to withdraw from faction storage");
        
        const freeSpace = Math.max(0, (bot.cargoMax || 825) - (bot.cargo || 0));
        //const withdrawResp = await bot.exec("faction_withdraw_items", { item_id: FUEL_CELL_ITEM_ID, quantity: maxItemsForCargo(freeSpace, FUEL_CELL_ITEM_ID), });
        const withdrawResp = await bot.exec("storage", { action: 'withdraw', target: 'faction',  item_id: FUEL_CELL_ITEM_ID, quantity: maxItemsForCargo(freeSpace, FUEL_CELL_ITEM_ID), }); //fixed by human!

        if (withdrawResp.error) {
          ctx.log("error", `Withdraw failed: ${withdrawResp.error.message} — waiting for cargo`);
          await ctx.sleep(10000);
          continue;
        }

        // Wait for potential caching delays before refreshing cargo
        await ctx.sleep(2000);
        await bot.refreshCargo();
        const afterWithdraw = bot.inventory.find(i => i.itemId === FUEL_CELL_ITEM_ID);
        const newCargoQty = afterWithdraw?.quantity ?? 0;

        if (newCargoQty <= 0) {
          ctx.log("fc", "Withdraw returned no cargo — waiting for cargo to become available");
          await ctx.sleep(10000);
          continue;
        }

        ctx.log("fc", `Withdrew ${newCargoQty}x fuel cells from faction storage`);
        cargoQty = newCargoQty;
      } else {
        ctx.log("fc", "Lost cargo during maintenance — returning home to restock");
        continue;
      }
    }

    let targetIdx = getNextStation(fcData, settings, cycleFilters);
    if (targetIdx < 0) {
      if (fcData.stations.length === 0) {
        ctx.log("fc", "No stations tracked — initializing station list from mapStore...");
        fcData.stations = initializeFCStations(settings);
        fcData.currentStationIndex = 0;
      } else {
        // Never rebuild a populated list here: that would throw away the learned
        // "no market" / "docking denied" verdicts and every order count with them.
        ctx.log("fc", "No sellable station selected — re-syncing station list with the map");
        syncFCStations(ctx, fcData, settings);
      }
      saveFCStationsData(fcData);

      targetIdx = getNextStation(fcData, settings, getBlacklistFilters(true));
      if (targetIdx < 0) {
        ctx.log("fc", "Every mapped station is excluded (blacklist / outpost / no market) — waiting");
        await ctx.sleep(60000);
        continue;
      }
    }

    const target = fcData.stations[targetIdx];
    if (!target) {
      targetIdx = (targetIdx + 1) % fcData.stations.length;
      continue;
    }

    // Mobile Capital location may have changed — refresh from mapStore
    if (target.poiId === "mobile_capital") {
      const mcLoc = mapStore.getMobileCapitolLocation();
      if (mcLoc) {
        // Update in-memory and persisted station entry to current location
        target.systemId = mcLoc.systemId;
        fcData.stations[targetIdx].systemId = mcLoc.systemId;
        saveFCStationsData(fcData);
      }
    }

    ctx.log("fc", `Target: ${target.poiName} in ${target.systemId}`);

    await bot.refreshCargo();
    const preTravelCargo = bot.inventory.find(i => i.itemId === FUEL_CELL_ITEM_ID);
    if (!preTravelCargo || preTravelCargo.quantity <= 0) {
      ctx.log("fc", "No cargo before travel — returning home to restock");
      yield "return_home";
      if (bot.system !== settings.homeSystem) {
        await navigateToSystem(ctx, settings.homeSystem, safetyOpts);
      }
      if (bot.poi !== settings.homeStation) {
        await ensureUndocked(ctx);
        await bot.exec("travel", { target_poi: settings.homeStation });
        bot.poi = settings.homeStation;
      }
      continue;
    }

    await ensureUndocked(ctx);

    if (bot.system !== target.systemId) {
      const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
      if (!fueled) {
        ctx.log("error", "Cannot refuel — waiting");
        await ctx.sleep(60000);
        continue;
      }

      ctx.log("travel", `Jumping to ${target.systemId}...`);
      const arrived = await navigateToSystem(ctx, target.systemId, safetyOpts);
      if (!arrived) {
        ctx.log("error", "Failed to reach target system");
        await ctx.sleep(30000);
        continue;
      }
    }

    if (bot.poi !== target.poiId) {
      ctx.log("travel", `Traveling to ${target.poiName}...`);
      const travelResult = await travelToStationWithHint(ctx, target.poiId, target.poiName, target.systemId, {
        fuelThresholdPct: safetyOpts.fuelThresholdPct,
        hullThresholdPct: safetyOpts.hullThresholdPct,
        maxRetries: 3,
      });

      if (!travelResult.success) {
        ctx.log("error", `Travel to ${target.poiName} failed${travelResult.usedHint ? ` after redirect to ${travelResult.hintSystem}` : ''} — skipping station`);
        fcData.currentStationIndex = targetIdx;
        saveFCStationsData(fcData);
        continue;
      }

      bot.poi = target.poiId;
    }

    yield "dock";
    const dockResp = await bot.exec("dock");

    if (dockResp.error && !dockResp.error.message.includes("already")) {
      // A restricted station (private / faction-only) answers with an access
      // denial. Remember it so we never fly here again instead of retrying it
      // on the next pass.
      const dockSkip = classifyStationError(dockResp.error.message);
      if (dockSkip) {
        markStationLearnedSkip(ctx, target, dockSkip, dockResp.error.message);
      }
      ctx.log("error", `Dock failed: ${dockResp.error.message} — skipping station`);
      fcData.currentStationIndex = targetIdx;
      saveFCStationsData(fcData);
      continue;
    }

    bot.docked = true;
    ctx.log("fc", `Docked at ${target.poiName}`);

    await bot.refreshCargo();
    const inCargo = bot.inventory.find(i => i.itemId === FUEL_CELL_ITEM_ID);
    const availableQty = inCargo?.quantity ?? 0;

    if (availableQty <= 0) {
      ctx.log("fc", "No fuel cells in cargo — returning home");
      yield "return_home";
      await navigateToSystem(ctx, settings.homeSystem, safetyOpts);
      continue;
    }

    // Get current active orders at this station
    let currentStationOrders: FCOrder[] = [];
    const ordersResp = await bot.exec("view_orders", { scope: "personal" });
    if (!ordersResp.error && ordersResp.result) {
      const ordersData = ordersResp.result as Record<string, unknown>;
      const orders = (ordersData.orders as any[]) || [];
      // Filter for fuel_cell sell orders
      const fcOrders = orders.filter(o => o.item_id === FUEL_CELL_ITEM_ID && o.side === "sell");
      currentStationOrders = fcOrders.map(o => ({
        orderId: o.order_id,
        quantity: o.quantity,
        remaining: o.remaining,
        filledQuantity: o.filled_quantity,
        priceEach: o.price_each,
        createdAt: o.created_at,
      }));
    } else if (ordersResp.error) {
      // "That station does not have a market" — the station is dockable but can
      // never host a sell order. Remember it and move on with the cargo aboard.
      const orderSkip = classifyStationError(ordersResp.error.message);
      if (orderSkip) {
        markStationLearnedSkip(ctx, target, orderSkip, ordersResp.error.message);
        fcData.currentStationIndex = targetIdx;
        saveFCStationsData(fcData);
        continue;
      }
      ctx.log("fc", `view_orders failed at ${target.poiName}: ${ordersResp.error.message.split("\n")[0]}`);
    }

    const currentUnsold = currentStationOrders.reduce((sum, o) => sum + o.remaining, 0);
    const quantityToPlace = availableQty;
    if (quantityToPlace <= 0) {
      ctx.log("fc", `No fuel cells available — returning home`);
      yield "return_home";
      await navigateToSystem(ctx, settings.homeSystem, safetyOpts);
      continue;
    }

    // Get market data for pricing
    let marketData: unknown = null;
    const marketResp = await bot.exec("view_market", { item_id: FUEL_CELL_ITEM_ID });
    if (!marketResp.error && marketResp.result) {
      marketData = marketResp.result;
    } else {
      const marketSkip = classifyStationError(marketResp.error?.message);
      if (marketSkip) {
        markStationLearnedSkip(ctx, target, marketSkip, marketResp.error?.message);
        fcData.currentStationIndex = targetIdx;
        saveFCStationsData(fcData);
        continue;
      }
      if (settings.useRemoteMarketQuery !== false) {
        // Fallback to remote market query if local view_market failed
        ctx.log("fc", "[RemoteMarket] view_market failed, trying remote market query for fuel_cell pricing...");
        try {
          const result = await queryRemoteMarket({ itemId: FUEL_CELL_ITEM_ID, tradeType: "sell", requesterSystemId: bot.system });
          if (result.ok && result.results.length > 0) {
            const best = result.results[0];
            ctx.log("fc", `[RemoteMarket] Got remote fuel_cell price: ${best.price}cr @ ${best.stationName} (qty: ${best.quantity})`);
            // Build synthetic marketData for getOptimalPrice
            marketData = {
              items: [{
                item_id: FUEL_CELL_ITEM_ID,
                best_sell: best.price,
                best_buy: best.price,
                sell_quantity: best.quantity,
                buy_quantity: best.quantity,
              }],
            };
          } else {
            ctx.log("fc", `[RemoteMarket] No remote fuel_cell data available: ${result.error || "no results"}`);
          }
        } catch (err) {
          ctx.log("fc", `[RemoteMarket] Remote query failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    let price: number | null = null;
    price = await getOptimalPrice(ctx, marketData, settings);
    ctx.log("fc", `Creating sell orders: ${quantityToPlace}x @ ${price}cr each (current unsold: ${currentUnsold})`);

    let ordersPlacedCount = 0;

    if (quantityToPlace > 0) {
      const createResp = await bot.exec("create_sell_order", {
        item_id: FUEL_CELL_ITEM_ID,
        quantity: quantityToPlace,
        price_each: price!,
      });

      if (createResp.error) {
        ctx.log("error", `Create sell order failed: ${createResp.error.message}`);
        const createSkip = classifyStationError(createResp.error.message);
        if (createSkip) {
          markStationLearnedSkip(ctx, target, createSkip, createResp.error.message);
          fcData.currentStationIndex = targetIdx;
          saveFCStationsData(fcData);
          continue;
        }
      } else {
        ctx.log("fc", `Listed ${quantityToPlace}x ${FUEL_CELL_ITEM_NAME} @ ${price!}cr`);

        // Refresh orders after creating new one
        const updatedOrdersResp = await bot.exec("view_orders", { scope: "personal" });
        if (!updatedOrdersResp.error && updatedOrdersResp.result) {
          const updatedOrdersData = updatedOrdersResp.result as Record<string, unknown>;
          const updatedOrders = (updatedOrdersData.orders as any[]) || [];
          const updatedFcOrders = updatedOrders.filter(o => o.item_id === FUEL_CELL_ITEM_ID && o.side === "sell");
          currentStationOrders = updatedFcOrders.map(o => ({
            orderId: o.order_id,
            quantity: o.quantity,
            remaining: o.remaining,
            filledQuantity: o.filled_quantity,
            priceEach: o.price_each,
            createdAt: o.created_at,
          }));
        }

        ordersPlacedCount = quantityToPlace;
      }
    }

    // Update station entry with latest data
    const currentStation = fcData.stations[targetIdx];
    currentStation.ordersPlaced += ordersPlacedCount;
    currentStation.ordersUnsold = currentStationOrders.reduce((sum, o) => sum + o.remaining, 0);
    currentStation.activeOrders = currentStationOrders;
    if (ordersPlacedCount > 0) {
      currentStation.lastPrice = price;
    }
    currentStation.lastVisit = new Date().toISOString();

    fcData.currentStationIndex = targetIdx;
    saveFCStationsData(fcData);

    await bot.refreshCargo();

    yield "return_home";
    ctx.log("travel", `Returning to ${settings.homeSystem}...`);

    if (bot.system !== settings.homeSystem) {
      await ensureUndocked(ctx);

      // Refuel at target station before long journey home - use higher threshold
      const returnThreshold = Math.max(60, settings.refuelThreshold + 20);
      ctx.log("fc", `Pre-return fuel check: ${Math.round((bot.fuel / (bot.maxFuel || 1)) * 100)}%, refueling if below ${returnThreshold}%...`);
      const fueled = await ensureFueled(ctx, returnThreshold);
      if (!fueled) {
        ctx.log("error", "Failed to refuel before return journey");
        await ctx.sleep(30000);
        continue;
      }

      await navigateToSystem(ctx, settings.homeSystem, safetyOpts);
    }

    const checkCargo = bot.inventory.find(i => i.itemId === FUEL_CELL_ITEM_ID);
    if (checkCargo && checkCargo.quantity > 0) {
      ctx.log("fc", `Depositing ${checkCargo.quantity}x remaining fuel cells`);
      await ensureDocked(ctx);
      //await bot.exec("faction_deposit_items", { item_id: FUEL_CELL_ITEM_ID, quantity: checkCargo.quantity, });
      await bot.exec("storage", { action: 'deposit', source: 'cargo', target: 'faction', item_id: FUEL_CELL_ITEM_ID, quantity: checkCargo.quantity, }); //fixed by human!
    }


    saveFCStationsData(fcData);

    ctx.log("fc", `Loop complete. Next station index: ${targetIdx}`);
  }
};