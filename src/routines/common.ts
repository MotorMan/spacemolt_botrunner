/**
 * Shared utilities for all bot routines.
 *
 * Provides: docking, refueling, repairing, navigation, system parsing,
 * ore parsing, and safety checks.
 */
import { combatDebugLog, combatDebugLogLine } from "../debug.js";
import type { Bot, RoutineContext } from "../bot.js";
import { isConnectionError } from "../connection.js";
import { recordInsurancePurchase, getInsuranceRecord, getInsuranceStatus, type InsuranceRecord } from "../insuranceTracker.js";
import type { BattleStatus, BattleSide, BattleParticipant, BattleZone, BattleStance, BattleCombatState, BoardingPublicStatus } from "../types/game.js";
import { catalogStore } from "../catalogstore.js";
import { mapStore } from "../mapstore.js";
import { getSystemBlacklist, getStationBlacklist, isCustomsDisabled } from "../web/server.js";
import {
  waitForCustomsInspection,
  pollForCustomsShip,
  isEmpireSystem,
  getBotCustomsStats,
} from "../customs.js";

// ── Emergency Warp Stabilizer ────────────────────────────────

/** The exact log message produced when the Emergency Warp Stabilizer activates. */
export const EMERGENCY_WARP_STABILIZER_MESSAGE =
  "Emergency Warp Stabilizer activated! Hull critical — warped to Confederacy Central Command. The module has been destroyed.";

// ── Denied fuel stations ─────────────────────────────────────
// Persistent (in-memory for the bot session) record of stations that rejected
// docking with "Access denied". We must NEVER loop trying to dock at a station
// that explicitly denied us — it strands the bot until fuel hits 0.
const deniedStations = new Set<string>();

/** Record that a station denied docking so we stop retrying it this session. */
export function markStationDenied(stationId: string): void {
  if (stationId) deniedStations.add(stationId.toLowerCase());
}

/** True if a station previously denied us docking access. */
export function isStationDenied(stationId: string): boolean {
  return stationId ? deniedStations.has(stationId.toLowerCase()) : false;
}

/** Combine the runtime-denied station set with the configured station blacklist
 *  (Settings → General → stationBlacklist). Returns a lowercased set of POI ids
 *  (and "system|poiId" keys) that must never be treated as a usable station. */
export function buildDeniedStationSet(extra?: Set<string>): Set<string> {
  const denied = new Set<string>(deniedStations);
  for (const s of getStationBlacklist()) denied.add(s.toLowerCase());
  if (extra) for (const s of extra) denied.add(s.toLowerCase());
  return denied;
}

/** Build the approved-fuel-station lookup set from settings (matches isApprovedFuelStation). */
export function buildApprovedStationSet(settings: any): Set<string> {
  const approved: string[] | undefined = settings?.general?.approvedFuelStations;
  const set = new Set<string>();
  if (!approved || approved.length === 0) return set;
  for (const entry of approved) {
    set.add(entry);
    const parts = entry.split("|");
    if (parts.length === 2) set.add(parts[1]);
  }
  return set;
}

/**
 * Check if the bot's current state indicates it should stop (e.g., due to emergency warp).
 * This is a convenience helper for routines to check between actions.
 * The actual detection and stop is handled automatically by bot.ts log method.
 */
export function shouldStopForEmergency(ctx: RoutineContext): boolean {
  return ctx.bot.state !== "running";
}

/**
 * Low-bandwidth notification refresh for idle bots.
 * Calls get_notifications with limit=1, clear=false to keep sessions alive
 * without heavy API traffic. Returns the notifications for processing.
 */
export async function refreshNotifications(ctx: RoutineContext): Promise<unknown> {
  // Library-backed bots receive notifications as push events (Bot.subscribeEvents),
  // so the HTTP poll is skipped entirely.
  if (ctx.bot.account) return { notifications: [] };
  const resp = await ctx.bot.exec("get_notifications", { limit: 1, clear: false });
  if (resp.error) {
    ctx.log("system", `Notification refresh failed: ${resp.error.message}`);
    return { notifications: [] };
  }
  return resp.result || { notifications: [] };
}

// ── Types ────────────────────────────────────────────────────

export interface BaseServices {
  refuel?: boolean;
  repair?: boolean;
  market?: boolean;
  storage?: boolean;
  shipyard?: boolean;
  crafting?: boolean;
  missions?: boolean;
  cloning?: boolean;
  insurance?: boolean;
  salvage_yard?: boolean;
}

export interface SystemPOI {
  id: string;
  name: string;
  type: string;
  has_base: boolean;
  base_id: string | null;
  /** Station services (refuel, repair, market, etc.) — null if unknown or no base. */
  services: BaseServices | null;
  /** Hidden POIs (e.g., secret ore belts) */
  hidden?: boolean;
}

export interface Connection {
  id: string;
  name: string;
  /** Fuel cost for this jump. */
  jump_cost: number | null;
}

export interface SystemInfo {
  pois: SystemPOI[];
  connections: Connection[];
  systemId: string;
}

// ── POI classification ───────────────────────────────────────

/** Check if a POI type is ANY minable resource location (belt, gas cloud, nebula, ice, etc.) */
export function isMinablePoi(type: string): boolean {
  const t = type.toLowerCase();
  return t.includes("asteroid") || t.includes("gas") || t.includes("cloud")
    || t.includes("nebula") || t.includes("field") || t.includes("ring")
    || t.includes("belt") || t.includes("resource");
}

/** Check if a POI is an ore belt (asteroid belt/field/ring — NOT gas clouds, ice fields, or hidden POIs). */
export function isOreBeltPoi(type: string): boolean {
  const t = type.toLowerCase();
  if (t.includes("gas") || t.includes("cloud") || t.includes("ice") || t.includes("residue") || t.includes("shimmer") || t.includes("nexus")) return false;
  return t.includes("asteroid") || t.includes("belt") || t.includes("ring")
    || t.includes("field") || t.includes("resource");
}

/** Check if a POI is a gas cloud. */
export function isGasCloudPoi(type: string): boolean {
  const t = type.toLowerCase();
  return t.includes("gas") || t.includes("cloud") || t.includes("nebula") ||
         t.includes("residue") || t.includes("shimmer") || t.includes("nexus") ||
         t.includes("hydrogen") || t.includes("helium") || t.includes("argon") ||
         t.includes("neon") || t.includes("chlorine") || t.includes("nitrogen") ||
         t.includes("oxygen") || t.includes("compressed");
}

/** Check if a POI is a gas cloud by name (fallback when type is not recognized). */
export function isGasCloudByName(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes("cloud") || n.includes("gas") || n.includes("residue") ||
         n.includes("shimmer") || n.includes("nexus") || n.includes("nebula");
}

/** Check if a POI is a gas cloud (by type or name). */
export function isGasCloudPoiOrName(typeOrName: string): boolean {
  return isGasCloudPoi(typeOrName) || isGasCloudByName(typeOrName);
}

/** Check if a POI is an ice field. */
export function isIceFieldPoi(type: string): boolean {
  const t = type.toLowerCase();
  return t.includes("ice") || t.includes("frost") || t.includes("cryo") || t.includes("water_ice");
}

/** Check if a POI type is purely scenic (only needs one visit). */
export function isScenicPoi(type: string): boolean {
  const t = type.toLowerCase();
  return t === "sun" || t === "star" || t === "wormhole" || t === "jump_gate";
}

// ── Item size helpers ────────────────────────────────────────

/** Cargo size (weight per unit) of a dynamically-generated package. Package IDs
 *  are NOT in the local catalog, and we must NOT `inspect` them (each inspect is a
 *  network command and issuing many in a row trips the server's rate limiter and
 *  gets the bot's IP banned). Per game knowledge every package occupies a fixed
 *  100 cargo space, so we hardcode that and never hit the network for it. */
export const PACKAGE_CARGO_SIZE = 100;

/** Runtime size overrides learned from cargo_full errors at load time. The catalog
 *  sometimes reports size 1 for items whose true in-game cargo weight is much larger
 *  (e.g. 101); when we observe the real size we cache it so the rest of the routine
 *  stops overbooking cargo. */
const runtimeSizeCache = new Map<string, number>();

/** Record the true per-unit cargo size observed for an item (e.g. from a cargo_full
 *  error's "Need X but only Y available" math). Overrides the catalog value afterwards. */
export function setItemSize(itemId: string, size: number): void {
  if (size > 0) runtimeSizeCache.set(itemId, size);
}

/** Get the cargo size (weight per unit) of an item.
 *
 *  Sizes come from the LOCAL catalog (catalog.json) — no network call. Almost
 *  every item exists there, so this is authoritative for 99.99% of cases.
 *
 *  Dynamically-generated `package:*` items are NOT in the catalog. We must never
 *  `inspect` them (that's a rate-limited network command that gets us banned when
 *  called in bulk), so we simply return the fixed PACKAGE_CARGO_SIZE.
 *
 *  Runtime overrides (learned from in-game cargo_full errors) take precedence. */
export function getItemSize(itemId: string): number {
  const runtime = runtimeSizeCache.get(itemId);
  if (runtime !== undefined) return runtime;
  if (itemId.startsWith("package:")) {
    return PACKAGE_CARGO_SIZE;
  }
  const item = catalogStore.getItem(itemId);
  const size = (item?.size as number | undefined) ?? undefined;
  return (size && size > 0) ? size : 1;
}

/** Async size lookup kept for API compatibility. Unlike the old implementation it
 *  performs NO `inspect` network call (that risks a rate-limit ban); it resolves
 *  sizes purely from the local catalog / the fixed package size. */
export async function getItemSizeAsync(bot: Bot, itemId: string): Promise<number> {
  return getItemSize(itemId);
}

/** No-op retained for API compatibility. Packages are no longer inspected (that
 *  would spam rate-limited `inspect` commands and get us banned); their size is a
 *  fixed constant, so there is nothing to pre-inspect. */
export async function preInspectPackageSizes(_bot: Bot, _items: Array<{ itemId: string }>): Promise<void> {
  return;
}

/** Authoritative count of cargo actually aboard, computed from the live inventory
 *  (quantity × true item size) rather than a manually-incremented tracker that can
 *  drift when an item's size estimate is wrong. Use this to re-anchor `cargoUsed`
 *  after every load so free-space math never over-requests into a cargo_full. */
export function cargoUsedFromInventory(bot: Bot): number {
  let used = 0;
  for (const item of bot.inventory) {
    used += item.quantity * getItemSize(item.itemId);
  }
  return used;
}

/** How many units of an item fit in the given free cargo weight. */
export function maxItemsForCargo(freeWeight: number, itemId: string): number {
  if (freeWeight <= 0) return 0;
  return Math.floor(freeWeight / getItemSize(itemId));
}

/** Ensure a credit/revenue/profit value is a safe integer. Game credits are integers; API and float math can produce .0000000002 etc. */
export function sanitizeCredits(value: number | string | undefined | null): number {
  if (value === undefined || value === null) return 0;
  const n = typeof value === 'string' ? parseFloat(value) : value;
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

/** Check if a POI represents a station. */
export function isStationPoi(poi: SystemPOI): boolean {
  return poi.has_base || !!poi.base_id || (poi.type || "").toLowerCase() === "station";
}

/** True only when a station is KNOWN to offer a market. Avoids attempting buys at
 *  stations whose services are undefined/unknown (which would error with no_market). */
export function stationHasMarket(poi: SystemPOI | undefined): boolean {
  if (!poi) return false;
  const s = poi.services;
  if (Array.isArray(s)) return s.includes("market");
  return s?.market === true;
}

/** Find the first station POI in a list. Optionally filter by required service.
 *  Skips POIs on the manual station blacklist (Settings → General → stationBlacklist),
 *  since faction-owned deployable outposts cannot be distinguished from stations
 *  automatically and must be excluded manually. */
export function findStation(pois: SystemPOI[], requiredService?: keyof BaseServices, excludePirates: boolean = true): SystemPOI | null {
  const blacklist = new Set(getStationBlacklist().map(s => s.toLowerCase()));
  const isBlacklisted = (p: SystemPOI) => blacklist.size > 0 && blacklist.has(p.id.toLowerCase());
  if (requiredService) {
    // Prefer station with the required service
    const withService = pois.find(p => isStationPoi(p) && !isBlacklisted(p) && p.services?.[requiredService] !== false && !(excludePirates && isPirateSystem(p.id)));
    if (withService) return withService;
  }
  return pois.find(p => isStationPoi(p) && !isBlacklisted(p) && !(excludePirates && isPirateSystem(p.id))) || null;
}

/** Check if a station POI is known to lack a specific service. */
export function stationHasService(poi: SystemPOI, service: keyof BaseServices): boolean {
  // If services are unknown, assume the station has the service (optimistic)
  if (!poi.services) return true;
  return poi.services[service] !== false;
}

/** Known salvage yard station IDs (one per empire). */
export const SALVAGE_YARD_STATIONS = [
  "alpha_centauri_colonial_station",   // Sol (legacy name — may not exist in all instances)
  "node_alpha_processing_station",     // Node
  "the_anvil_arsenal",                 // Anvil
  "mobile_capital",                    // Mobile empire (dynamic - location tracked by mapStore)
  "cargo_lanes_freight_depot",         // Cargo Lanes
];

/** Pirate station systems — these are hostile and should be avoided. */
export const PIRATE_SYSTEMS = [
  "alhena",
  "xamidimura",
  "algol",
  "zaniah",
  "sheratan",
  "bellatrix",
  "barnard_44",
  "gsc_0008",
  "gliese_581",
];

/** Check if a system ID is a pirate system. */
export function isPirateSystem(systemId: string): boolean {
  const lower = systemId.toLowerCase();
  return PIRATE_SYSTEMS.some(ps => lower === ps || lower.includes(ps));
}

/** Returns true if stationId is on the approved fuel list (or list is empty/unset = allow all).
 *  Reads from bot.settings.general.approvedFuelStations (string[] of "system|poiId" or plain poiId entries).
 *  When systemId is provided, matches "system|poiId" entries exactly; poiId-only entries always match. */
export function isApprovedFuelStation(stationId: string, settings: any, systemId?: string): boolean {
  const general = settings?.general || {};
  const approved: string[] | undefined = general.approvedFuelStations;
  if (!approved || approved.length === 0) return true;
  if (approved.includes(stationId)) return true;
  if (systemId) {
    const combined = `${systemId}|${stationId}`;
    return approved.includes(combined);
  }
  // No systemId: check if any entry is "system|stationId" format
  return approved.some(a => a.endsWith(`|${stationId}`));
}

/**
 * True only when a station may be used for autonomous REFUELING: it must pass the
 * approved-fuel check AND not sit on the configured station blacklist.
 *
 * The blacklist is intentionally NOT consulted when an explicit destination is in
 * play (see `ensureDocked`'s `targetStationId`): a user-specified home station
 * must remain dockable even if it is blacklisted (e.g. because it has no fuel of
 * its own — the bot carries its own cells). The blacklist only restricts where we
 * will *choose* to refuel.
 */
export function isUsableFuelStation(stationId: string, settings: any, systemId?: string): boolean {
  if (!isApprovedFuelStation(stationId, settings, systemId)) return false;
  const blacklist = getStationBlacklist();
  if (blacklist.length > 0 && blacklist.map(s => s.toLowerCase()).includes(stationId.toLowerCase())) return false;
  return true;
}

/** Find a station with a salvage yard service. Returns null if none found. */
export function findSalvageYardStation(pois: SystemPOI[]): SystemPOI | null {
  // First try: match known salvage yard station IDs (explicit list)
  const known = pois.find(p => isStationPoi(p) && SALVAGE_YARD_STATIONS.includes(p.id));
  if (known) return known;

  // Second try: explicit salvage_yard === true (not optimistic — must be confirmed)
  const withService = pois.find(p => isStationPoi(p) && p.services?.salvage_yard === true);
  if (withService) return withService;

  // Third try: ANY station (salvage yards may not have the service flag set in map data)
  // This ensures we can still process towed wrecks even if the service flag is missing
  return pois.find(p => isStationPoi(p)) || null;
}

/**
 * Get the system ID for a salvage yard station.
 * Works for ANY station (not just the legacy hard-coded salvage yards) by
 * resolving it through the map store, so the system no longer needs to be
 * configured separately — it is derived from the selected station.
 */
export function getSystemForSalvageYard(stationId: string): string | null {
  // Mobile capitol is dynamic - use the tracked location
  if (stationId === "mobile_capital") {
    return getMobileCapitolSystem();
  }

  // Resolve any station through the map store (covers every discovered station,
  // including faction stations that can now process salvaged wrecks).
  const resolved = mapStore.resolveStationIdentity(stationId);
  if (resolved.matched && resolved.systemId) {
    return resolved.systemId;
  }

  // Fallback to the legacy hard-coded mapping for any station not yet in the map.
  const stationToSystem: Record<string, string> = {
    "alpha_centauri_colonial_station": "alpha_centauri",  // Alpha Centauri empire
    "node_alpha_processing_station": "node_alpha",        // Node empire
    "the_anvil_arsenal": "the_anvil",                     // Anvil empire
    "cargo_lanes_freight_depot": "cargo_lanes",           // Cargo Lanes empire
    "starfall_salvage_station": "starfall",               // Starfall system
  };
  return stationToSystem[stationId] || null;
}

/**
 * Resolve the current system for the mobile_capitol station.
 * This is a moving station that changes location periodically.
 * Returns the last known system from mapStore, or null if not yet discovered.
 */
export function getMobileCapitolSystem(): string | null {
  const location = mapStore.getMobileCapitolLocation();
  return location?.systemId || null;
}

/**
 * Resolve a station reference that may be the mobile_capitol.
 * If stationId is "mobile_capital", returns the current known location from mapStore.
 * Otherwise returns the stationId unchanged.
 */
export function resolveStationId(stationId: string): string | null {
  if (stationId === "mobile_capital") {
    const location = mapStore.getMobileCapitolLocation();
    return location?.poiId || "mobile_capital";
  }
  return stationId;
}

/**
 * Resolve a system reference that may be the mobile_capitol's system.
 * If systemId is "mobile_capital" or refers to the mobile capitol, returns the current system.
 * Otherwise returns the systemId unchanged.
 */
export function resolveSystemForMobileCapitol(systemIdOrStation: string): string | null {
  if (systemIdOrStation === "mobile_capital") {
    return getMobileCapitolSystem();
  }
  return systemIdOrStation;
}

// ── System data parsing ──────────────────────────────────────

/** Parse system data from get_system response. Saves to mapStore. */
export function parseSystemData(resp: Record<string, unknown>): SystemInfo {
  const sysObj = resp.system as Record<string, unknown> | undefined;
  const rawPois = (sysObj?.pois ?? resp.pois) as Array<Record<string, unknown>> | undefined;
  const rawConns = (sysObj?.connections ?? sysObj?.jump_gates ?? resp.connections) as Array<Record<string, unknown>> | undefined;
  const systemId = (sysObj?.id as string) || "";

  const pois: SystemPOI[] = [];
  if (Array.isArray(rawPois)) {
    for (const p of rawPois) {
      // Extract base services from inline base object or direct services field
      let services: BaseServices | null = null;
      const baseObj = p.base as Record<string, unknown> | undefined;
      const rawServices = baseObj?.services ?? p.services;
      if (rawServices && typeof rawServices === "object" && !Array.isArray(rawServices)) {
        services = rawServices as BaseServices;
      } else if (Array.isArray(rawServices)) {
        // Convert string array ["refuel", "repair", ...] to services object
        services = {};
        for (const s of rawServices as string[]) {
          (services as Record<string, boolean>)[s] = true;
        }
      }

      pois.push({
        id: (p.id as string) || "",
        name: (p.name as string) || (p.id as string) || "",
        type: (p.type as string) || "",
        has_base: !!(p.has_base || p.base_id || baseObj),
        base_id: (p.base_id as string) || (baseObj?.id as string) || null,
        services,
      });
    }
  }

  const connections: Connection[] = [];
  if (Array.isArray(rawConns)) {
    for (const c of rawConns) {
      // Handle both string format (just system ID) and object format ({system_id: "...", ...})
      let id: string;
      let name: string;
      let jumpCost: number | null = null;
      
      if (typeof c === "string") {
        id = c;
        name = c;
      } else if (typeof c === "object" && c !== null) {
        const connObj = c as Record<string, unknown>;
        id = (connObj.system_id as string) || (connObj.id as string)
          || (connObj.target_system as string) || (connObj.target as string)
          || (connObj.destination as string) || "";
        name = (connObj.system_name as string) || (connObj.name as string) || id;
        jumpCost = (connObj.jump_cost as number) ?? null;
      } else {
        continue;
      }
      
      if (!id) continue;
      connections.push({
        id,
        name,
        jump_cost: jumpCost,
      });
    }
  }

  // Save to mapStore — merge top-level fields in case API puts them outside "system"
  const merged = { ...(sysObj || {}) } as Record<string, unknown>;
  if (!merged.id && resp.id) merged.id = resp.id;
  if (!merged.security_level && resp.security_level) merged.security_level = resp.security_level;
  if (!merged.security_status && resp.security_status) merged.security_status = resp.security_status;

  if (merged.id || sysObj?.id) {
    mapStore.updateSystem(merged);
  }

  return { pois, connections, systemId };
}

/** Fetch and parse system data from the API. Updates bot.system if found. */
export async function getSystemInfo(ctx: RoutineContext): Promise<SystemInfo> {
  const { bot } = ctx;
  const systemResp = await bot.exec("get_system");

  if (systemResp.result && typeof systemResp.result === "object") {
    const info = parseSystemData(systemResp.result as Record<string, unknown>);
    if (info.systemId) bot.system = info.systemId;
    return info;
  }

  return { pois: [], connections: [], systemId: bot.system };
}

// ── Ore parsing ──────────────────────────────────────────────

/** Extract ore id and name from a mine response result. */
export function parseOreFromMineResult(result: unknown): { oreId: string; oreName: string } {
  if (!result || typeof result !== "object") return { oreId: "", oreName: "" };

  const mr = result as Record<string, unknown>;
  
  // The mine response may be nested under 'details' field per OpenAPI spec
  // structuredContent: V2GameState post-mutation delta; command result is under `details` (MineResponse)
  const responseData = (mr.details as Record<string, unknown>) || mr;
  
  const ore = responseData.item ?? responseData.ore ?? responseData.mined;
  let oreId = "";
  let oreName = "";

  if (ore && typeof ore === "object") {
    const oreObj = ore as Record<string, unknown>;
    oreId = (oreObj.item_id as string) || (oreObj.id as string) || (oreObj.name as string) || "";
    oreName = (oreObj.name as string) || oreId;
  } else {
    oreId = (responseData.resource_id as string) || (responseData.item_id as string) || (responseData.ore_id as string) || "";
    oreName = (responseData.resource_name as string) || (responseData.item_name as string) || (responseData.ore_name as string) || (responseData.name as string) || oreId;
  }

  return { oreId, oreName };
}

/**
 * Fallback ore detection for mine responses that return the full game-state
 * delta (top-level `ship,cargo,queue,skills`) instead of a `details`/`item`
 * block. The mined ore is identified by diffing the post-mine `cargo` array
 * against the previously known inventory and returning the item whose quantity
 * increased. If no diff is found, falls back to `fallbackResourceId`.
 */
export function parseOreFromCargoDelta(
  result: unknown,
  prevInventory: Array<{ itemId: string; name: string; quantity: number }>,
  fallbackResourceId?: string,
): { oreId: string; oreName: string; quantity: number } {
  if (!result || typeof result !== "object") return { oreId: "", oreName: "", quantity: 0 };
  const mr = result as Record<string, unknown>;

  // The cargo array lives either at top-level `cargo` or nested under `details`.
  const cargoSrc = (Array.isArray(mr.cargo) ? mr.cargo : (mr.details as Record<string, unknown>)?.cargo) as
    | Array<Record<string, unknown>>
    | undefined;
  if (!Array.isArray(cargoSrc) || cargoSrc.length === 0) {
    const id = fallbackResourceId || "";
    return { oreId: id, oreName: id, quantity: 0 };
  }

  const norm = (s: unknown) =>
    String(s ?? "").replace(/ /g, "_").toLowerCase();

  const prev = new Map<string, number>();
  for (const it of prevInventory) prev.set(it.itemId, it.quantity);

  let bestId = "";
  let bestName = "";
  let bestDelta = 0;
  for (const raw of cargoSrc) {
    const id = norm(raw.item_id ?? raw.resource_id ?? raw.id);
    if (!id) continue;
    const qty = (raw.quantity as number) ?? (raw.count as number) ?? (raw.amount as number) ?? 0;
    const before = prev.get(id) ?? 0;
    const delta = qty - before;
    if (delta > bestDelta) {
      bestDelta = delta;
      bestId = id;
      bestName = (raw.name as string) || (raw.item_name as string) || (raw.resource_name as string) || id;
    }
  }

  if (bestId && bestDelta > 0) return { oreId: bestId, oreName: bestName || bestId, quantity: bestDelta };
  const id = fallbackResourceId || "";
  return { oreId: id, oreName: id, quantity: 0 };
}

// ── Docking ──────────────────────────────────────────────────

/** Ensure the bot is docked at a station. Finds one in current system,
 *  or navigates to the nearest known station system if none is available.
 *  Returns true if successfully docked.
 *  @param skipStorageCollection If true, skips automatic storage collection (withdraw credits).
 *  @param minBalance Minimum credits to keep on bot when collecting from storage (only withdraw if below this). If 0, withdraws all.
 */
export async function ensureDocked(
  ctx: RoutineContext,
  skipStorageCollection: boolean = true,
  minBalance: number = 0,
  opts?: { skipApprovedCheck?: boolean; targetStationId?: string },
): Promise<boolean> {
  const { bot } = ctx;
  if (bot.docked) {
    await bot.refreshStatus();
    if (bot.docked) return true;
  }

  const { pois } = await getSystemInfo(ctx);
  const stationBlacklist = buildDeniedStationSet();
  let station: SystemPOI | null = null;

  // If the caller named a specific destination station (e.g. a user-specified
  // home station), honor it even when it is on the configured station blacklist.
  // The blacklist governs REFUEL choices, not an explicit destination — we must
  // still be able to dock at a station the user told us to go to. We keep
  // respecting the runtime "access denied" set, since an explicitly-denied
  // station can never be docked at this session.
  if (opts?.targetStationId) {
    const target = pois.find(p => p.id === opts.targetStationId && isStationPoi(p));
    if (target && !isStationDenied(target.id)) station = target;
  }

  if (!station) {
    const candidate = findStation(pois, undefined, true);
    station = candidate && !isStationDenied(candidate.id) && !stationBlacklist.has(candidate.id.toLowerCase())
      ? candidate
      : pois.find(p => isStationPoi(p) && !isStationDenied(p.id) && !stationBlacklist.has(p.id.toLowerCase())) ?? null;
  }

  if (station) {
    if (bot.poi !== station.id) {
      ctx.log("travel", `Traveling to ${station.name}...`);
      const travelResp = await bot.exec("travel", { target_poi: station.id });
      if (travelResp.error && !travelResp.error.message.includes("already")) {
        ctx.log("error", `Travel to station failed: ${travelResp.error.message}`);
        // Fall through to search for nearest station
      } else {
        bot.poi = station.id;
        // Refresh location after travel to update position
        await bot.refreshLocation();
      }
    }
    // Only attempt dock if we're at a station POI
    if (bot.poi && pois.find(p => p.id === bot.poi)) {
      ctx.log("system", "Docking...");
      const dockResp = await bot.exec("dock");
      if (!dockResp.error || dockResp.error.message.includes("already")) {
        bot.docked = true;
        if (!skipStorageCollection) {
          await collectFromStorage(ctx, minBalance);
        }
        await ensureInsured(ctx);
        return true;
      }
      // A station that explicitly denied us must never be retried — remember it.
      if (/access denied/i.test(dockResp.error?.message || "")) {
        ctx.log("error", `Dock denied at ${station.name} — will not retry this station`);
        markStationDenied(station.id);
        // Fall through to search for a different (approved) station
      } else if (dockResp.error?.message?.includes("No base at this location")) {
        ctx.log("error", `No dockable base at current POI (${bot.poi}) — searching for nearest station...`);
        // Don't fall through to "No station in current system" - we know we need a different station
        // Jump directly to the nearest station system
      } else {
        ctx.log("error", `Dock failed: ${dockResp.error.message}`);
        // Fall through to search for nearest station
      }
    }
  }

  // No (usable) station in current system — find nearest station
  ctx.log("system", "No usable station in current system — searching for nearest station...");
  const dockTarget = await findReachableFuelStation(ctx, {
    skipApprovedCheck: opts?.skipApprovedCheck,
  });
  if (!dockTarget) {
    ctx.log("error", "No known approved station in mapped systems — cannot dock");
    return false;
  }
  const nearest = dockTarget;
  // Keep the blacklist bypass consistent for the route leg too (see ensureFueled).
  const dockBlacklist = dockTarget.blacklistBypassed ? [] : getSystemBlacklist();

  ctx.log("travel", `Nearest station: ${nearest.poiName} in ${nearest.systemId} (${nearest.hops} hops)${dockTarget.blacklistBypassed ? " [blacklist bypassed]" : ""}`);

  // Navigate there
  if (nearest.systemId !== bot.system) {
    await ensureUndocked(ctx);
    const route = mapStore.findRoute(bot.system, nearest.systemId, dockBlacklist);
    if (route && route.length > 1) {
      for (let i = 1; i < route.length; i++) {
        if (bot.state !== "running") return false;
        ctx.log("travel", `Jumping to ${route[i]} (${i}/${route.length - 1})...`);
        const jumpResp = await bot.exec("jump", { target_system: route[i] });
        if (jumpResp.error) {
          ctx.log("error", `Jump failed: ${jumpResp.error.message}`);
          // Check if we actually made the jump despite the error
          await bot.refreshLocation();
          if (bot.system.toLowerCase() !== route[i].toLowerCase()) {
            return false; // Jump truly failed
          }
          ctx.log("travel", `Jump succeeded despite error (server confirmed position)`);
        }
      }
    } else {
      const jumpResp = await bot.exec("jump", { target_system: nearest.systemId });
      if (jumpResp.error) {
        ctx.log("error", `Jump failed: ${jumpResp.error.message}`);
        // Check if we actually made the jump despite the error
        await bot.refreshLocation();
        if (bot.system.toLowerCase() !== nearest.systemId.toLowerCase()) {
          return false; // Jump truly failed
        }
        ctx.log("travel", `Jump succeeded despite error (server confirmed position)`);
      }
    }
    // Refresh location after navigation
    await bot.refreshLocation();
  }

  // Travel to station POI and dock
  ctx.log("travel", `Traveling to ${nearest.poiName}...`);
  const travelResp = await bot.exec("travel", { target_poi: nearest.poiId });
  if (travelResp.error && !travelResp.error.message.includes("already")) {
    ctx.log("error", `Travel to station POI failed: ${travelResp.error.message}`);
    return false;
  }
  bot.poi = nearest.poiId;

  ctx.log("system", "Docking...");
  const dResp = await bot.exec("dock");
  if (!dResp.error || dResp.error.message.includes("already")) {
    bot.docked = true;
    if (!skipStorageCollection) {
      await collectFromStorage(ctx, minBalance);
    }
    await ensureInsured(ctx);
    return true;
  }

  // A station that explicitly denied us must never be retried — remember it.
  if (/access denied/i.test(dResp.error?.message || "")) {
    ctx.log("error", `Dock denied at ${nearest.poiName} — will not retry this station`);
    markStationDenied(nearest.poiId);
  } else {
    ctx.log("error", `Dock failed at ${nearest.poiName}: ${dResp.error?.message}`);
  }
  return false;
}

/** Ensure the bot is undocked. */
export async function ensureUndocked(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;
  if (!bot.docked) return;

  ctx.log("system", "Undocking...");
  const resp = await bot.exec("undock");
  if (!resp.error || resp.error.message.includes("already")) {
    bot.docked = false;
  }
}

// ── Market data recording ────────────────────────────────────

/** Record market prices at the current station to the galaxy map. */
export async function recordMarketData(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;
  if (!bot.docked || !bot.poi || !bot.system) return;

  const marketResp = await bot.exec("view_market");
  if (marketResp.result && typeof marketResp.result === "object") {
    mapStore.updateMarket(bot.system, bot.poi, marketResp.result as Record<string, unknown>);
  }
}

/** Call analyze_market to build Trading XP and log top insight. Must be docked. */
export async function analyzeMarket(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;
  if (!bot.docked) return;
  const resp = await bot.exec("analyze_market");
  if (!resp.error && resp.result && typeof resp.result === "object") {
    const r = resp.result as Record<string, unknown>;
    const insights = r.insights as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(insights) && insights.length > 0) {
      const top = insights[0];
      ctx.log("trade", `Market intel: ${(top.message as string) ?? (top.category as string) ?? "no insights"}`);
    }
  }
}

// ── Storage collection ───────────────────────────────────────

/**
 * Check station storage for credits and withdraw them to the bot.
 * Does NOT transfer items - routines should handle storage items manually if needed.
 * Also records market prices at the station.
 * @param minBalance - Minimum credits to keep on bot (only withdraw if below this). If 0, withdraws all.
 */
export async function collectFromStorage(ctx: RoutineContext, minBalance: number = 0): Promise<void> {
  const { bot } = ctx;

  // CRITICAL: Only collect from storage if docked
  if (!bot.docked) {
    ctx.log("system", "Not docked - skipping storage collection");
    return;
  }

  const storageResp = await bot.exec("view_storage");
  if (!storageResp.result || typeof storageResp.result !== "object") return;

  const r = storageResp.result as Record<string, unknown>;

  // Withdraw credits to the bot
  const credits = (r.credits as number) || (r.stored_credits as number) || 0;
  if (credits > 0) {
    let amountToWithdraw = credits;
    
    // If minBalance is set, only withdraw if bot is below that threshold
    if (minBalance > 0 && bot.credits < minBalance) {
      amountToWithdraw = Math.min(credits, minBalance - bot.credits);
    } else if (minBalance > 0) {
      // Bot already has enough credits - don't withdraw
      amountToWithdraw = 0;
    }
    
    if (amountToWithdraw > 0) {
      const wResp = await bot.exec("storage", { action: "withdraw", item_id: "credits", quantity: amountToWithdraw, target: "self", source: "storage" });
      if (!wResp.error) {
        ctx.log("trade", `Collected ${amountToWithdraw} credits from storage`);
        await bot.refreshLocation();
      }
    }
  }

  // Record market prices at this station
  await recordMarketData(ctx);
}

/**
 * @deprecated This function is deprecated and no longer performs any action.
 * Routines should handle storage transfers explicitly if needed.
 * Transfer all items from personal station storage into faction storage.
 * This centralises materials so any bot (crafters, traders, etc.) can access them.
 * Credits are kept on the bot (not transferred).
 * Assumes docked at a station with both storage and faction storage access.
 */
export async function transferStationToFaction(ctx: RoutineContext): Promise<void> {
  // Deprecated - no longer performs any action
  // Routines should handle storage transfers explicitly if needed
}

// ── Refueling ────────────────────────────────────────────────

/** Sell all cargo to raise credits. Returns number of items sold. */
export async function sellAllCargo(ctx: RoutineContext): Promise<number> {
  const { bot } = ctx;
  await bot.refreshCargo();

  let sold = 0;
  for (const item of bot.inventory) {
    const resp = await bot.exec("sell", { item_id: item.itemId, quantity: item.quantity });
    if (!resp.error) sold++;
  }
  return sold;
}

/**
 * Emergency fuel recovery when stranded (0% fuel, can't travel).
 * Tries: dock where we are → sell cargo → refuel.
 * Last resort: self-destruct to respawn at home station.
 * Returns true if recovered, false if still stuck.
 */
export async function emergencyFuelRecovery(ctx: RoutineContext): Promise<boolean> {
  const { bot } = ctx;
  await bot.refreshLocation();

  // ── COMBAT GUARD: While in battle, dock/jump/refuel are all rejected by the
  // server with `in_battle`. Resolving the fight is the only thing that matters;
  // fuel is irrelevant until we're free. Flee first, then attempt recovery. ──
  if (ctx.bot.isInBattle()) {
    ctx.log("combat", "Emergency fuel recovery interrupted by battle — fleeing first (in battle, fuel does not matter!)");
    await checkAndFleeFromBattle(ctx, "emergencyFuelRecovery");
    if (ctx.bot.isInBattle()) {
      ctx.log("combat", "Still in battle after flee attempt — cannot recover fuel now");
      return false;
    }
  }

  ctx.log("error", "EMERGENCY: Fuel target not met — attempting recovery...");

  // First: scavenge nearby wrecks/containers for fuel cells
  if (!bot.docked) {
    ctx.log("scavenge", "Checking for nearby fuel cells or containers...");
    const looted = await scavengeWrecks(ctx);
    if (looted > 0) {
      // Try refueling from cargo (fuel cells)
      ctx.log("system", "Found items — attempting refuel from cargo...");
      const refuelResp = await bot.exec("refuel");
      if (!refuelResp.error) {
        await bot.refreshShip();
        const newFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : bot.fuel;
        ctx.log("system", `Recovery via scavenge successful! Fuel: ${newFuel}%`);
        return true;
      }
    }
  }

  // Try to dock at current location
  if (!bot.docked) {
    // Do not attempt to dock at a station that already denied us this session.
    if (bot.poi && isStationDenied(bot.poi)) {
      ctx.log("error", `Current station ${bot.poi} previously denied docking — not retrying`);
    } else {
      const dockResp = await bot.exec("dock");
      if (!dockResp.error || dockResp.error.message.includes("already")) {
        bot.docked = true;
        ctx.log("system", "Managed to dock — checking storage, selling cargo, refueling...");
        await collectFromStorage(ctx);
        await ensureInsured(ctx);
        await sellAllCargo(ctx);
        await tryRefuel(ctx);
        const pct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : bot.fuel;
        if (!bot.docked || pct >= 30) {
          ctx.log("system", `Recovery successful! Fuel: ${bot.fuel}/${bot.maxFuel} (${pct}%)`);
          return true;
        }
      } else if (/access denied/i.test(dockResp.error?.message || "")) {
        // A station that explicitly denied us must never be retried — remember it.
        const deniedId = bot.poi || ((dockResp as any)?.result?.poi ?? "");
        ctx.log("error", `Dock denied during emergency recovery — will not retry this station`);
        if (deniedId) markStationDenied(deniedId);
      }
    }
  }

  // If docked but still can't refuel, sell cargo and try again
  if (bot.docked) {
    await sellAllCargo(ctx);
    await tryRefuel(ctx);
    const pct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : bot.fuel;
    if (pct >= 30) {
      ctx.log("system", `Recovery successful! Fuel: ${bot.fuel}/${bot.maxFuel} (${pct}%)`);
      return true;
    }

    // Still can't refuel — stay docked and wait (rescue bot may help, or station restocks)
    ctx.log("system", "Cannot refuel — staying docked and waiting for help...");
    for (let w = 0; w < REFUEL_WAIT_RETRIES && bot.state === "running"; w++) {
      await sleep(REFUEL_WAIT_INTERVAL);
      await bot.refreshShip();
      const fuelNow = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
      if (fuelNow >= 30) {
        ctx.log("system", `Fuel recovered to ${fuelNow}% — resuming`);
        return true;
      }
      // Try selling + refueling each cycle
      await sellAllCargo(ctx);
      await tryRefuel(ctx);
      await bot.refreshShip();
      const afterPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : bot.fuel;
      if (afterPct >= 30) {
        ctx.log("system", `Refuel succeeded after wait! Fuel: ${bot.fuel}/${bot.maxFuel} (${afterPct}%)`);
        return true;
      }
      ctx.log("system", `Waiting at station for fuel... (${w + 1}/${REFUEL_WAIT_RETRIES})`);
    }
  }

  // Stranded — wait for rescue bot or manual intervention
  ctx.log("error", "Cannot recover fuel — stranded! Waiting for FuelRescue bot or manual help...");
  return false;
}

/** Max retries when waiting at station for fuel. */
const REFUEL_WAIT_RETRIES = 10;
/** Seconds between refuel retries when waiting at station. */
const REFUEL_WAIT_INTERVAL = 30_000;

/**
 * Fuel-cell items we can convert into fuel, ranked best-first by fuel-per-cell.
 * Used when a docked station's fuel reserve is empty: we pull cells from
 * faction/station storage or buy them from the market, then refuel from cargo.
 */
const FUEL_CELL_RANK: { id: string; fuel: number }[] = [
  { id: "military_fuel_cell", fuel: 100 },
  { id: "premium_fuel_cell", fuel: 50 },
  { id: "fuel_cell", fuel: 20 },
];

/**
 * Fuel restored by ONE unit of `itemId`, or 0 when the item is not a fuel cell.
 *
 * Catalog-driven (`effect.type === "fuel"`) so any future cell type is picked up
 * automatically, with the three known cells as a fallback for the window before
 * the catalog has loaded.
 *
 * Routines used to sniff fuel with `itemId.includes("fuel")`, which is wrong in
 * both directions:
 *   - it counts `fusion_fuel_rod`, `reactor_fuel_assembly`, `fuel_tank`… as fuel,
 *     so those cargo items were never delivered and inflated the "we have fuel"
 *     count;
 *   - it treats every cell as interchangeable, so 3x military_fuel_cell (300
 *     fuel) looked identical to 3x fuel_cell (60 fuel) and the bot went shopping
 *     for 20-fuel cells at 20k–50k credits each while sitting on 300 free fuel.
 */
export function getFuelCellFuelValue(itemId: string): number {
  if (!itemId) return 0;
  const item = catalogStore.getItem(itemId);
  const effect = item?.effect as { type?: string; amount?: number } | undefined;
  if (effect?.type === "fuel" && typeof effect.amount === "number" && effect.amount > 0) {
    return effect.amount;
  }
  return FUEL_CELL_RANK.find((f) => f.id === itemId.toLowerCase())?.fuel ?? 0;
}

/** True only for items the `refuel` command can actually burn. */
export function isFuelCellItem(itemId: string): boolean {
  return getFuelCellFuelValue(itemId) > 0;
}

function isFuelCellItemId(id: string): boolean {
  return isFuelCellItem(id);
}

export interface CargoFuelCells {
  /** Number of cells (all types) aboard. */
  cells: number;
  /** What those cells are worth in TANK FUEL — the number that actually matters. */
  fuel: number;
  /** Cargo weight they occupy. */
  cargoUsed: number;
  byItem: Array<{ itemId: string; name: string; quantity: number; fuelEach: number; fuel: number }>;
  /** e.g. "3x Military Fuel Cell (300 fuel)" */
  summary: string;
}

/** The fuel-cell reserve currently in cargo, measured in FUEL rather than in
 *  cell count. Always prefer this over counting inventory entries. */
export function getCargoFuelCells(bot: Bot): CargoFuelCells {
  const byItem: CargoFuelCells["byItem"] = [];
  let cells = 0;
  let fuel = 0;
  let cargoUsed = 0;
  for (const item of bot.inventory) {
    const fuelEach = getFuelCellFuelValue(item.itemId);
    if (fuelEach <= 0 || item.quantity <= 0) continue;
    cells += item.quantity;
    fuel += item.quantity * fuelEach;
    cargoUsed += item.quantity * getItemSize(item.itemId);
    byItem.push({
      itemId: item.itemId,
      name: item.name || item.itemId,
      quantity: item.quantity,
      fuelEach,
      fuel: item.quantity * fuelEach,
    });
  }
  byItem.sort((a, b) => b.fuelEach - a.fuelEach);
  const summary = byItem.length > 0
    ? byItem.map((b) => `${b.quantity}x ${b.name} (${b.fuel} fuel)`).join(", ")
    : "none";
  return { cells, fuel, cargoUsed, byItem, summary };
}

/**
 * Credits we are willing to pay per POINT of tank fuel when buying cells.
 * Catalog base values are ~2.2cr/fuel (fuel_cell 43cr/20), ~2.4 (premium),
 * ~3.9 (military), so 25cr/fuel is a ~10x-over-base ceiling that still blocks
 * the player-driven 20 000–50 000cr-per-fuel_cell listings outright.
 */
export const DEFAULT_MAX_CREDITS_PER_FUEL = 25;

export interface FuelCellReserveOptions {
  /** How much TANK FUEL the cargo reserve must be able to deliver. */
  fuelNeeded: number;
  /** Short description for the log, e.g. "27-jump route home". */
  reason?: string;
  /** Allow buying cells from the docked station's market (default true). */
  allowBuy?: boolean;
  /** Price ceiling per point of fuel. Defaults to DEFAULT_MAX_CREDITS_PER_FUEL. */
  maxCreditsPerFuel?: number;
  /** Hard cap on total credits spent on cells this call. 0 / omitted = no cap. */
  maxSpend?: number;
}

export interface FuelCellReserveResult {
  /** Reserve is at (or above) the requested fuel. */
  ok: boolean;
  /** Fuel aboard in cells after sourcing. */
  fuel: number;
  cells: number;
  /** Credits spent buying cells (0 when everything came from storage). */
  spent: number;
}

/**
 * Make sure the ship carries at least `fuelNeeded` worth of fuel CELLS, sourcing
 * them in the only sane order: what we already carry → faction storage (free) →
 * station storage (free) → a price-capped market buy as a last resort.
 *
 * Denser cells are preferred everywhere (military 100 fuel / 3 space beats plain
 * 20 fuel / 1 space per unit of cargo), and a buy is only attempted after
 * `estimate_purchase` confirms the station really is selling — so a ghost
 * listing produces a quiet skip instead of a red `item_not_available`.
 */
export async function ensureFuelCellReserve(
  ctx: RoutineContext,
  opts: FuelCellReserveOptions,
): Promise<FuelCellReserveResult> {
  const { bot } = ctx;
  const reason = opts.reason ? ` for ${opts.reason}` : "";
  const maxPerFuel = opts.maxCreditsPerFuel && opts.maxCreditsPerFuel > 0
    ? opts.maxCreditsPerFuel
    : DEFAULT_MAX_CREDITS_PER_FUEL;

  await bot.refreshCargo();
  let have = getCargoFuelCells(bot);
  const need = Math.max(0, Math.ceil(opts.fuelNeeded));

  if (need <= 0 || have.fuel >= need) {
    if (have.cells > 0) {
      ctx.log("system", `Fuel reserve OK${reason}: carrying ${have.summary} = ${have.fuel} fuel (need ${need})`);
    }
    return { ok: true, fuel: have.fuel, cells: have.cells, spent: 0 };
  }

  ctx.log(
    "system",
    `Fuel reserve short${reason}: carrying ${have.summary} = ${have.fuel} fuel, need ${need} — sourcing ${need - have.fuel} more`,
  );

  let spent = 0;

  // Densest cells first: more fuel per unit of cargo left for actual trade goods.
  const ranked = [...FUEL_CELL_RANK].sort((a, b) => b.fuel - a.fuel);

  /** Cells of `id` still required to close the gap, limited by free cargo. */
  const cellsWanted = (id: string, fuelEach: number): number => {
    const deficit = need - have.fuel;
    if (deficit <= 0) return 0;
    const freeWeight = Math.max(0, (bot.cargoMax || 0) - cargoUsedFromInventory(bot));
    return Math.max(0, Math.min(Math.ceil(deficit / fuelEach), maxItemsForCargo(freeWeight, id)));
  };

  // ── 1) Free cells already sitting in faction storage ──
  try {
    await bot.refreshFactionStorage(false, undefined, true);
  } catch { /* storage unavailable — fall through to the other sources */ }
  for (const { id } of ranked) {
    const fuelEach = getFuelCellFuelValue(id) || FUEL_CELL_RANK.find((f) => f.id === id)!.fuel;
    const want = cellsWanted(id, fuelEach);
    if (want <= 0) continue;
    const stock = bot.factionStorage.find((i) => i.itemId === id)?.quantity || 0;
    if (stock <= 0) continue;
    const qty = Math.min(stock, want);
    const direct = await bot.exec("storage", { action: "withdraw", target: "faction", item_id: id, quantity: qty });
    let got = false;
    if (!direct.error) {
      got = true;
    } else {
      // Older two-step path: faction -> station storage -> cargo.
      const move = await bot.exec("storage", { action: "deposit", target: "self", item_id: id, quantity: qty, source: "faction" });
      if (!move.error) {
        const w = await bot.exec("withdraw_items", { item_id: id, quantity: qty });
        got = !w.error;
      }
    }
    if (got) {
      await bot.refreshCargo();
      have = getCargoFuelCells(bot);
      ctx.log("system", `Pulled ${qty}x ${id} from faction storage (free) — reserve now ${have.fuel} fuel`);
    }
    if (have.fuel >= need) break;
  }

  // ── 2) Free cells in this station's personal storage ──
  if (have.fuel < need && bot.docked) {
    try {
      await bot.refreshStorage();
    } catch { /* not docked / no storage here */ }
    for (const { id } of ranked) {
      const fuelEach = getFuelCellFuelValue(id) || FUEL_CELL_RANK.find((f) => f.id === id)!.fuel;
      const want = cellsWanted(id, fuelEach);
      if (want <= 0) continue;
      const stock = bot.storage.find((i) => i.itemId === id)?.quantity || 0;
      if (stock <= 0) continue;
      const qty = Math.min(stock, want);
      const w = await bot.exec("withdraw_items", { item_id: id, quantity: qty });
      if (!w.error) {
        await bot.refreshCargo();
        have = getCargoFuelCells(bot);
        ctx.log("system", `Pulled ${qty}x ${id} from station storage (free) — reserve now ${have.fuel} fuel`);
      }
      if (have.fuel >= need) break;
    }
  }

  // ── 3) Buy, but only at a sane price ──
  if (have.fuel < need && opts.allowBuy !== false && bot.docked) {
    let hasMarket = true;
    try {
      const { pois } = await getSystemInfo(ctx);
      const station = pois.find((p) => isStationPoi(p) && p.id === bot.poi);
      hasMarket = stationHasMarket(station);
    } catch { /* unknown — let estimate_purchase decide */ }

    if (!hasMarket) {
      ctx.log("system", `No market at this station — cannot top up the fuel reserve here (${have.fuel}/${need} fuel)`);
    } else {
      for (const { id } of ranked) {
        const fuelEach = getFuelCellFuelValue(id) || FUEL_CELL_RANK.find((f) => f.id === id)!.fuel;
        let want = cellsWanted(id, fuelEach);
        if (want <= 0) continue;

        // Ask BEFORE buying: a ghost listing then costs a log line, not a red error.
        const est = await bot.exec("estimate_purchase", { item_id: id, quantity: want });
        if (est.error) continue;
        const e = (est.result || {}) as Record<string, unknown>;
        const available = Math.max(0, Number(e.available ?? e.available_quantity ?? 0) || 0);
        if (available <= 0) {
          ctx.log("system", `No one is selling ${id} here — skipping`);
          continue;
        }
        want = Math.min(want, available);
        const cost = Number(e.total_cost ?? e.subtotal ?? 0) || 0;
        const perUnit = cost > 0 ? cost / want : 0;
        const perFuel = perUnit / fuelEach;
        if (perFuel > maxPerFuel) {
          ctx.log(
            "trade",
            `Refusing to buy ${id} at ${Math.round(perUnit)}cr each (${perFuel.toFixed(1)}cr per fuel, cap ${maxPerFuel}) — ` +
            `military cells are free at home`,
          );
          continue;
        }
        const budget = opts.maxSpend && opts.maxSpend > 0 ? Math.min(opts.maxSpend - spent, bot.credits) : bot.credits;
        if (perUnit > 0 && budget < perUnit) continue;
        if (perUnit > 0) want = Math.min(want, Math.floor(budget / perUnit));
        if (want <= 0) continue;

        const creditsBefore = bot.credits;
        const buy = await bot.exec("buy", { item_id: id, quantity: want });
        if (buy.error) continue;
        await bot.refreshStatus();
        await bot.refreshCargo();
        have = getCargoFuelCells(bot);
        spent += Math.max(0, creditsBefore - bot.credits);
        ctx.log("trade", `Bought ${want}x ${id} at ~${Math.round(perUnit)}cr each — reserve now ${have.fuel} fuel`);
        if (have.fuel >= need) break;
      }
    }
  }

  const ok = have.fuel >= need;
  if (!ok) {
    ctx.log(
      "system",
      `Fuel reserve still short${reason}: ${have.fuel}/${need} fuel (${have.summary}) — continuing, the tank plus station refuelling may cover it`,
    );
  }
  return { ok, fuel: have.fuel, cells: have.cells, spent };
}

/**
 * Ask the server what a route actually costs in fuel. `find_route` is the only
 * source that knows this ship's fuel burn, so it beats every "jumps × guess"
 * estimate. Returns null when the route can't be resolved.
 */
export async function estimateRouteFuel(
  ctx: RoutineContext,
  targetSystem: string,
): Promise<{ jumps: number; estimatedFuel: number; fuelAvailable: number; fuelPerJump: number } | null> {
  if (!targetSystem) return null;
  try {
    const resp = await ctx.bot.exec("find_route", { target_system: targetSystem });
    if (resp.error) return null;
    const r = (resp.result || {}) as Record<string, unknown>;
    if (r.found === false) return null;
    const estimatedFuel = Number(r.estimated_fuel ?? 0) || 0;
    if (estimatedFuel <= 0) return null;
    return {
      jumps: Number(r.total_jumps ?? 0) || 0,
      estimatedFuel,
      fuelAvailable: Number(r.fuel_available ?? ctx.bot.fuel) || 0,
      fuelPerJump: Number(r.fuel_per_jump ?? 0) || 0,
    };
  } catch {
    return null;
  }
}

export interface PurchaseEstimate {
  /** Units the station can actually deliver right now. */
  available: number;
  /** Units of the request nobody can fill. */
  unfilled: number;
  totalCost: number;
  message: string;
  /** Who we would be buying from, when the server says. */
  counterparties: string[];
}

/**
 * Normalised view of an `estimate_purchase` reply.
 *
 * This is the only pre-flight check that talks to the live order book, and —
 * critically — it does NOT return an error when nobody is selling: it answers
 * `{ available: 0, unfilled: <asked>, fills: [] }` plus a message. Routines that
 * tested only `resp.error` therefore treated a seller-less station as a good
 * one, and the failure only surfaced on the `buy`, after the whole flight.
 *
 * `fills[].counterparty` is captured too: when the only orders in the book are
 * our own the server refuses the trade with "No one is selling …", and the
 * counterparty list is the one clue that explains why a listing we can plainly
 * see is still unbuyable.
 */
export function readPurchaseEstimate(raw: unknown): PurchaseEstimate {
  const e = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown): number => {
    const n = typeof v === "string" ? parseFloat(v) : (v as number);
    return Number.isFinite(n) ? n : 0;
  };
  const fills = Array.isArray(e.fills) ? (e.fills as Array<Record<string, unknown>>) : [];
  const counterparties = [
    ...new Set(fills.map((f) => String(f.counterparty || f.source || "")).filter(Boolean)),
  ];
  return {
    // `available` is the authoritative field; the others are legacy/defensive.
    available: Math.max(0, num(e.available ?? e.available_quantity ?? e.max_quantity ?? 0)),
    unfilled: Math.max(0, num(e.unfilled)),
    totalCost: num(e.total_cost ?? e.subtotal),
    message: typeof e.message === "string" ? e.message : "",
    counterparties,
  };
}

/** True when the bot is docked at its configured home system. Used to decide
 *  whether plain fuel_cells are "free" (home) or a waste of credits (remote). */
function isAtHomeStation(ctx: RoutineContext): boolean {
  const homeSystem = ((readSettings().trader?.homeSystem as string) || "").toLowerCase();
  if (!homeSystem) return false;
  return ctx.bot.system.toLowerCase() === homeSystem;
}

/** How many fuel cells of the given id fit in available cargo (by weight). */
function maxFuelCellsForCargo(ctx: RoutineContext, itemId: string): number {
  const { bot } = ctx;
  const free = Math.max(0, (bot.cargoMax || 0) - (bot.cargo || 0));
  return maxItemsForCargo(free, itemId);
}

/**
 * When docked at a station whose fuel RESERVE is empty (station_fuel_empty) and we
 * have no fuel cells in cargo, obtain the best available fuel cells and refuel:
 *   1. Pull from FACTION storage (military > premium > regular) into cargo.
 *   2. Else pull from STATION storage.
 *   3. Else BUY the best cell type from the station market.
 * Then call refuel (which consumes cargo cells) to fill the tank.
 *
 * Returns true if fuel improved (tank topped up or at least some cells consumed),
 * false if we could not source any fuel cells at all.
 */
export async function acquireFuelCellsAndRefuel(ctx: RoutineContext): Promise<boolean> {
  const { bot } = ctx;
  if (!bot.docked) return false;

  // Quick check: already topped up — nothing to do.
  const startFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
  if (startFuel >= 95) return false;

  await bot.refreshShip();
  await bot.refreshFactionStorage(false, undefined, true);
  await bot.refreshStorage();
  await bot.refreshCargo();

  const fuelNeeded = Math.max(0, bot.maxFuel - bot.fuel);

  if (bot.fuel >= bot.maxFuel * 0.9) return false;

  let sourced = 0;
  // If we already carry ANY fuel cell, prefer refueling from cargo rather than
  // buying inferior/expensive plain fuel_cells. This prevents the classic waste:
  // a ship holding 10x military_fuel_cell (100 fuel each) still buying 6x plain
  // fuel_cell (20 fuel each) for 20k at a remote station.
  const haveAnyCell = bot.inventory.some((i) => isFuelCellItemId(i.itemId) && (i.quantity || 0) > 0);
  for (const { id } of FUEL_CELL_RANK) {
    const have = bot.inventory.find((i) => i.itemId === id)?.quantity || 0;
    if (have > 0) continue;
    if (haveAnyCell) {
      ctx.log("trade", `Carrying fuel cells already — will refuel from cargo instead of buying ${id}`);
      continue;
    }
    // Never blow credits on plain fuel_cells at a remote station: military cells
    // are free at home and give 5x the fuel per cell. Only buy plain fuel_cell at home.
    if (id === "fuel_cell" && !isAtHomeStation(ctx)) {
      ctx.log("trade", "Skipping expensive plain fuel_cell at remote station (military cells are free at home)");
      continue;
    }

    const cellFuel = FUEL_CELL_RANK.find((f) => f.id === id)?.fuel || 20;
    const cellsNeeded = Math.max(1, Math.ceil(fuelNeeded / cellFuel));
    const pullLimit = cellsNeeded + 5;

    // 1) Faction storage
    const inFaction = bot.factionStorage.find((i) => i.itemId === id);
    if (inFaction && inFaction.quantity > 0) {
      const qty = Math.min(inFaction.quantity, maxFuelCellsForCargo(ctx, id) || inFaction.quantity, pullLimit);
      if (qty > 0) {
        const fResp = await bot.exec("storage", {
          action: "deposit", target: "self", item_id: id, quantity: qty, source: "faction",
        });
        if (!fResp.error) {
          await bot.refreshStorage();
          const wResp = await bot.exec("withdraw_items", { item_id: id, quantity: qty });
          if (!wResp.error) {
            await bot.refreshCargo();
            const got = bot.inventory.find((i) => i.itemId === id)?.quantity || 0;
            sourced += got;
            ctx.log("system", `Pulled ${got}x ${id} from faction storage`);
            continue;
          }
        }
      }
    }

    // 2) Station storage
    const inStation = bot.storage.find((i) => i.itemId === id);
    if (inStation && inStation.quantity > 0) {
      const qty = Math.min(inStation.quantity, maxFuelCellsForCargo(ctx, id) || inStation.quantity, pullLimit);
      if (qty > 0) {
        const wResp = await bot.exec("withdraw_items", { item_id: id, quantity: qty });
        if (!wResp.error) {
          await bot.refreshCargo();
          const got = bot.inventory.find((i) => i.itemId === id)?.quantity || 0;
          sourced += got;
          ctx.log("system", `Pulled ${got}x ${id} from station storage`);
          continue;
        }
      }
    }

    // 3) Buy from market
    try {
      const { pois } = await getSystemInfo(ctx);
      const station = pois.find((p) => isStationPoi(p) && p.id === bot.poi);
      if (stationHasMarket(station)) {
        const maxCanFit = maxFuelCellsForCargo(ctx, id);
        if (maxCanFit <= 0) continue;
        const buyQty = Math.min(maxCanFit, pullLimit);
        if (buyQty > 0) {
          const buyResp = await bot.exec("buy", { item_id: id, quantity: buyQty });
          if (!buyResp.error) {
            await bot.refreshCargo();
            const got = bot.inventory.find((i) => i.itemId === id)?.quantity || 0;
            if (got > 0) {
              sourced += got;
              ctx.log("system", `Bought ${got}x ${id} from market`);
              continue;
            }
          }
        }
      } else {
        ctx.log("trade", `Station has no market — skipping buy of ${id}`);
      }
    } catch { /* market unavailable — skip */ }
  }

  // 4) If we sourced any cells (or already had some), refuel from cargo.
  const totalCells = bot.inventory
    .filter((i) => isFuelCellItemId(i.itemId))
    .reduce((s, i) => s + (i.quantity || 0), 0);
  if (totalCells <= 0) {
    ctx.log("error", "No fuel cells available in faction storage, station storage, or market");
    return false;
  }

  // Refuel consumes cargo fuel cells. Try in place first; if the lib requires
  // undocking to draw from cargo, fall back to undock -> refuel -> redock.
  let improved = false;
  for (let attempt = 0; attempt < 12 && bot.state === "running"; attempt++) {
    const resp = await bot.exec("refuel");
    if (resp.error) {
      const msg = resp.error.message.toLowerCase();
      if (msg.includes("already full") || msg.includes("tank_full") || msg.includes("max")) break;
      if (msg.includes("no_fuel_cells") || msg.includes("no fuel cells") || msg.includes("no fuel")) {
        // Out of cargo cells — try buying one more of the best affordable type.
        const bought = await tryBuyOneFuelCell(ctx);
        if (!bought) break;
        continue;
      }
      if (msg.includes("station") && (msg.includes("dock") || msg.includes("undock"))) {
        // Refuel wants us undocked to use cargo cells.
        await ensureUndocked(ctx);
        const uResp = await bot.exec("refuel");
        await bot.refreshShip();
        if (!uResp.error) improved = true;
        const tResp = await bot.exec("travel", { target_poi: bot.poi });
        if (!tResp.error || tResp.error?.message.includes("already")) {
          await bot.exec("dock");
          bot.docked = true;
        }
        continue;
      }
      break;
    }
    improved = true;
    await bot.refreshShip();
    const fp = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    if (fp >= 95) break;
  }

  await bot.refreshShip();
  const endFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
  if (endFuel > startFuel) {
    ctx.log("system", `Recovered fuel via stored/bought cells: ${startFuel}% → ${endFuel}%`);
    return true;
  }
  return improved || sourced > 0;
}

/** Buy a single (best affordable) fuel cell from the market as a last-ditch top-up. */
async function tryBuyOneFuelCell(ctx: RoutineContext): Promise<boolean> {
  const { bot } = ctx;
  const { pois } = await getSystemInfo(ctx);
  const station = pois.find((p) => isStationPoi(p) && p.id === bot.poi);
  if (!stationHasMarket(station)) return false;
  for (const { id } of FUEL_CELL_RANK) {
    // Don't waste credits on plain fuel_cells at remote stations — military cells
    // are free at home and vastly more efficient (100 vs 20 fuel, 3 vs 1 space).
    if (id === "fuel_cell" && !isAtHomeStation(ctx)) continue;
    if (maxFuelCellsForCargo(ctx, id) <= 0) continue;
    try {
      const buyResp = await bot.exec("buy", { item_id: id, quantity: 1 });
      if (!buyResp.error) {
        await bot.refreshCargo();
        if ((bot.inventory.find((i) => i.itemId === id)?.quantity || 0) > 0) {
          ctx.log("system", `Bought 1x ${id} from market to top up`);
          return true;
        }
      }
    } catch { /* skip */ }
  }
  return false;
}

/** Attempt to refuel to full. Calls refuel repeatedly until tank is full.
 *  If broke, sells cargo. If still can't refuel, waits at station and retries.
 *  Assumes docked.
 *  @param opts.skipApprovedCheck If true, bypass the approved fuel station check (for hunters). */
export async function tryRefuel(ctx: RoutineContext, opts?: { skipApprovedCheck?: boolean }): Promise<void> {
  const { bot } = ctx;
  await bot.refreshShip();
  await bot.refreshCargo();

  let fuelPct = bot.maxFuel > 0 ? (bot.fuel / bot.maxFuel) * 100 : bot.fuel;
  if (fuelPct >= 95) return;

  const startFuel = Math.round(fuelPct);
  
  // Check if current station has refuel service
  const { pois } = await getSystemInfo(ctx);
  const currentStation = pois.find(p => isStationPoi(p) && p.id === bot.poi);
  if (currentStation) {
    if (!opts?.skipApprovedCheck && !isApprovedFuelStation(currentStation.id, readSettings(), bot.system)) {
      ctx.log("system", `Station ${currentStation.name} is not on approved fuel list — skipping refuel here`);
      return;
    }
  }
  if (currentStation?.services && currentStation.services.refuel === false) {
      const refuelStation = findStation(pois, "refuel");
      if (refuelStation && refuelStation.id !== currentStation.id) {
        if (!opts?.skipApprovedCheck && !isApprovedFuelStation(refuelStation.id, readSettings(), bot.system)) {
          ctx.log("system", `Refuel station ${refuelStation.name} is not in approved fuel list — skipping`);
          return;
        }
        await bot.exec("undock");
        bot.docked = false;
        await bot.exec("travel", { target_poi: refuelStation.id });
        bot.poi = refuelStation.id;
        const dResp = await bot.exec("dock");
        if (!dResp.error || dResp.error.message.includes("already")) {
          bot.docked = true;
          await collectFromStorage(ctx);
          await ensureInsured(ctx);
        } else {
          ctx.log("error", `Dock at ${refuelStation.name} failed: ${dResp.error.message}`);
          return;
        }
      }
    }

  // Call refuel repeatedly until full or until it fails
  let consecutiveErrors = 0;
  const isSolCentralLoop = currentStation?.id === "sol_station" || currentStation?.id === "sol_central";
  for (let i = 0; i < 10 && bot.state === "running"; i++) {
    const resp = await bot.exec("refuel");
    if (resp.error) {
      consecutiveErrors++;
      const msg = resp.error.message.toLowerCase();
      if (msg.includes("already full") || msg.includes("tank_full") || msg.includes("max")) {
        break;
      }
      // Sol Central is always assumed to have fuel
      if (!isSolCentralLoop && (msg.includes("station_fuel_empty") || msg.includes("station's fuel reserves"))) {
        // Station reserve empty — try faction/station storage or market for fuel cells
        // instead of giving up (a docked station often has cells even with 0 reserve).
        if (bot.docked) {
          const recovered = await acquireFuelCellsAndRefuel(ctx);
          const fp = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
          if (recovered && fp >= 95) return;
          await bot.refreshShip();
        }
        ctx.log("error", `Station out of fuel — cannot refuel here (${resp.error.message})`);
        return; // bail out immediately, do not wait
      }
      if (msg.includes("credit") || msg.includes("fuel_source") || msg.includes("insufficient")) {
        const sold = await sellAllCargo(ctx);
        if (sold > 0) {
          await bot.refreshShip();
          continue;
        }
      }
      if (consecutiveErrors >= 2) break;
      continue;
    }

    consecutiveErrors = 0;
    await bot.refreshShip();
    fuelPct = bot.maxFuel > 0 ? (bot.fuel / bot.maxFuel) * 100 : bot.fuel;
    if (fuelPct >= 95) break;
  }

  await bot.refreshShip();
  fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
  if (fuelPct >= 50) {
    if (fuelPct > startFuel) ctx.log("system", `Refueled ${startFuel}% → ${fuelPct}%`);
    return;
  }

  // Fuel still low — wait at station and retry periodically
  const isSolCentral = currentStation?.id === "sol_station" || currentStation?.id === "sol_central";
  for (let attempt = 1; attempt <= REFUEL_WAIT_RETRIES && bot.state === "running"; attempt++) {
    ctx.log("system", `Fuel still at ${fuelPct}% — waiting at station (attempt ${attempt}/${REFUEL_WAIT_RETRIES})...`);
    await sleep(REFUEL_WAIT_INTERVAL);

    // Retry: sell + refuel
    await sellAllCargo(ctx);
    const refuelResp = await bot.exec("refuel");
     if (refuelResp.error) {
       const msg = refuelResp.error.message.toLowerCase();
       if (!isSolCentral && (msg.includes("no_fuel_cells") || msg.includes("no fuel cells") || msg.includes("station_fuel_empty") || msg.includes("station's fuel reserves"))) {
         // Reserve empty / no cargo cells — try faction/station storage or market before giving up.
           if (bot.docked) {
            const recovered = await acquireFuelCellsAndRefuel(ctx);
            await bot.refreshShip();
            fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
            if (recovered && fuelPct >= 50) return;
          }
         ctx.log("error", `Cannot refuel: ${msg.includes("station") ? "station out of fuel" : "no fuel cells available"} — will not retry infinitely`);
         break;
       }
     }
    await bot.refreshShip();
    fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    if (fuelPct >= 50) {
      ctx.log("system", `Fuel recovered to ${fuelPct}% — continuing`);
      return;
    }
  }

  await bot.refreshShip();
  ctx.log("error", `Could not refuel after ${REFUEL_WAIT_RETRIES} waits — fuel: ${bot.fuel}/${bot.maxFuel}`);
}

// ── Repair ───────────────────────────────────────────────────

/** Repair the ship if damaged. Assumes docked. */
export async function repairShip(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;
  await bot.refreshShip();
  const hullPct = bot.maxHull > 0 ? (bot.hull / bot.maxHull) * 100 : 100;
  if (hullPct < 100) {
    const startHull = Math.round(hullPct);

    // Check if current station has repair service
    const { pois } = await getSystemInfo(ctx);
    const currentStation = pois.find(p => isStationPoi(p) && p.id === bot.poi);
    if (currentStation?.services && currentStation.services.repair === false) {
      const repairStation = findStation(pois, "repair");
      if (repairStation && repairStation.id !== currentStation.id) {
        await bot.exec("undock");
        bot.docked = false;
        await bot.exec("travel", { target_poi: repairStation.id });
        bot.poi = repairStation.id;
        const dResp = await bot.exec("dock");
        if (!dResp.error || dResp.error.message.includes("already")) {
        bot.docked = true;
        await collectFromStorage(ctx);
        await ensureInsured(ctx);
        } else {
        ctx.log("error", `Dock at ${repairStation.name} failed: ${dResp.error.message}`);
        return;
        }
      }
    }

    await bot.exec("repair");
    await bot.refreshShip();
    const endHull = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    if (endHull > startHull) ctx.log("system", `Repaired hull ${startHull}% → ${endHull}%`);
  }
}

export async function topUpShields(ctx: RoutineContext, targetPct: number = 0.8): Promise<boolean> {
  const { bot } = ctx;
  if (!bot.maxShield || bot.maxShield <= 0) {
    ctx.log("combat", `Shield recharge skipped: maxShield=${bot.maxShield}`);
    return false;
  }
  await bot.refreshShip();
  await bot.refreshCargo();
  const target = Math.floor(bot.maxShield * targetPct);
  if (bot.shield >= target) {
    ctx.log("combat", `Shield recharge skipped: ${bot.shield}/${bot.maxShield} >= ${target} (${Math.round(targetPct * 100)}%)`);
    return false;
  }
  const deficit = target - bot.shield;
  const needed = Math.ceil(deficit / 100);
  const inventory = bot.inventory || [];
  const shieldItem = inventory.find(i => 
    i.itemId?.toLowerCase().includes("shield") && i.itemId?.toLowerCase().includes("charge")
  );
  const have = shieldItem?.quantity ?? 0;
  const qty = Math.min(needed, have);
  if (qty <= 0) {
    ctx.log("combat", `No shield charges in cargo (need ${needed}, have ${have})`);
    return false;
  }
  ctx.log("combat", `Using ${qty}x shield_charge from ${have} available`);
  const resp = await bot.exec("use_item", { id: shieldItem!.itemId, quantity: qty });
  if (!resp.error) {
    ctx.log("combat", `Used ${qty}x shield_charge (+${qty * 100} shields to ~${Math.round(targetPct * 100)}%)`);
    await bot.refreshShip();
    return true;
  } else {
    ctx.log("combat", `Shield recharge failed: ${resp.error.message}`);
    return false;
  }
}

export async function useRepairKits(ctx: RoutineContext): Promise<boolean> {
  const { bot } = ctx;
  await bot.refreshShip(); // ensure docked flag is fresh
  if (bot.docked) {
    return false; // never burn expensive repair kits at a station — repairShip() uses the station's repair command instead
  }
  await bot.refreshCargo();
  const deficit = (bot.maxHull || 0) - (bot.hull || 0);
  if (deficit <= 100) {
    return false;
  }
  const inventory = bot.inventory || [];
  // Prefer advanced (150 hull) then regular (50 hull)
  let kitItem = inventory.find(i => (i.itemId || "").toLowerCase() === "advanced_repair_kit");
  let hpPer = 150;
  if (!kitItem || (kitItem.quantity ?? 0) <= 0) {
    kitItem = inventory.find(i => (i.itemId || "").toLowerCase() === "repair_kit");
    hpPer = 50;
  }
  const have = kitItem?.quantity ?? 0;
  if (have <= 0) {
    ctx.log("combat", `No repair kits in cargo (hull deficit ${deficit} > 100)`);
    return false;
  }
  const needed = Math.ceil(deficit / hpPer);
  const qty = Math.min(needed, have);
  ctx.log("combat", `Using ${qty}x ${kitItem!.itemId} to repair ~${qty * hpPer} hull (deficit ${deficit})`);
  const resp = await bot.exec("use_item", { id: kitItem!.itemId, quantity: qty });
  if (!resp.error) {
    ctx.log("combat", `Used ${qty}x ${kitItem!.itemId} (+~${qty * hpPer} hull)`);
    await bot.refreshShip();
    return true;
  } else {
    ctx.log("combat", `Repair kit use failed: ${resp.error.message}`);
    return false;
  }
}

// ── Combat utilities ──────────────────────────────────────────

/** Check if the bot's ship has any equipped weapons. */
export async function hasWeapons(ctx: RoutineContext): Promise<boolean> {
  const { bot } = ctx;
  const shipResp = await bot.exec("get_ship");
  if (shipResp.error || !shipResp.result) {
    ctx.log("warn", "Unable to check ship weapons - get_ship failed");
    return false;
  }

  const result = shipResp.result as Record<string, unknown>;
  const modules = result.modules as Array<Record<string, unknown>> | undefined;
  if (!modules) return false;

  // Check for weapon modules (pulse_laser, etc.)
  return modules.some(mod => {
    const category = (mod.category as string)?.toLowerCase();
    return category === "weapon" || category?.includes("laser") || category?.includes("cannon");
  });
}

/** Get the tier of a ship by its ID from the catalog. */
export function getShipTier(shipId: string): number | null {
  const ship = catalogStore.getShip(shipId);
  return ship?.tier ?? null;
}

/**
 * Determine if we should engage attacking players in combat.
 * Checks general settings, our weapons, and attacker ship tiers.
 */
export async function shouldEngagePlayersInCombat(ctx: RoutineContext, players: NearbyEntity[]): Promise<boolean> {
  const { bot } = ctx;

  // Check if we have weapons
  const hasWeaponsEquipped = await hasWeapons(ctx);
  if (!hasWeaponsEquipped) {
    ctx.log("combat", "No weapons equipped - cannot fight players");
    return false;
  }

  // Get general settings
  const generalSettings = (ctx.bot.settings as any)?.general || {};
  const fightTier0 = (generalSettings.fightTier0Ships as boolean) ?? true;
  const fightTier1 = (generalSettings.fightTier1Ships as boolean) ?? true;
  const maxTier0Ships = (generalSettings.maxTier0Ships as number) ?? 8;

  // Count attackers by tier
  let tier0Count = 0;
  let tier1Count = 0;
  let otherTiers = 0;

  for (const player of players) {
    if (player.shipTier === 0) tier0Count++;
    else if (player.shipTier === 1) tier1Count++;
    else otherTiers++;
  }

  ctx.log("combat", `Attacker composition: ${tier0Count} T0, ${tier1Count} T1, ${otherTiers} other tiers`);

  // Check if we should fight based on settings
  const shouldFightTier0 = fightTier0 && tier0Count <= maxTier0Ships;
  const shouldFightTier1 = fightTier1 && tier1Count > 0;
  const hasOtherTiers = otherTiers > 0;

  // Only fight if all attackers are T0/T1 and we allow fighting them
  if (hasOtherTiers) {
    ctx.log("combat", "Higher tier ships detected - not engaging");
    return false;
  }

  if (tier0Count > 0 && !shouldFightTier0) {
    ctx.log("combat", `Too many T0 ships (${tier0Count} > ${maxTier0Ships}) or T0 fighting disabled - not engaging`);
    return false;
  }

  if (tier1Count > 0 && !shouldFightTier1) {
    ctx.log("combat", "T1 ships detected but T1 fighting disabled - not engaging");
    return false;
  }

  // We should fight!
  return (tier0Count > 0 && shouldFightTier0) || (tier1Count > 0 && shouldFightTier1);
}

/**
 * Engage in battle against attacking players.
 * Advances to engaged zone and starts firing.
 */
export async function engageInBattle(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;

  ctx.log("combat", "ENGAGING IN BATTLE - advancing to engaged zone...");

  // Advance 3 times to get to engaged zone
  for (let i = 0; i < 3; i++) {
    const advanceResp = await bot.exec("battle", { action: "advance" });
    if (advanceResp.error) {
      ctx.log("error", `Battle advance ${i + 1} failed: ${advanceResp.error.message}`);
      // Continue trying - sometimes the first advance fails
    } else {
      ctx.log("combat", `Battle advance ${i + 1} successful`);
    }

    // Wait for server response
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  ctx.log("combat", "Setting battle stance to FIRE...");
  const fireResp = await bot.exec("battle", { action: "stance", stance: "fire" });
  if (fireResp.error) {
    ctx.log("error", `Failed to set fire stance: ${fireResp.error.message}`);
  } else {
    ctx.log("combat", "Battle stance set to FIRE - now actively fighting!");
  }

  // Start monitoring battle status
  monitorAndHandleBattleFlee(ctx);
}

/**
 * Monitor battle status and flee if hull drops below threshold.
 * Runs in background and handles fleeing automatically.
 */
export async function monitorAndHandleBattleFlee(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;
  const generalSettings = (bot.settings as any)?.general || {};
  const hullFleeThreshold = (generalSettings.hullFleeThreshold as number) ?? 20;

  if (hullFleeThreshold <= 0) {
    ctx.log("combat", "Hull flee threshold disabled (set to 0) - not monitoring hull");
    return;
  }

  ctx.log("combat", `Monitoring battle status - will flee if hull drops below ${hullFleeThreshold}%`);

  const monitorInterval = setInterval(async () => {
    try {
      // Check if we're still in a battle
      const battleStatus = await getBattleStatus(ctx);
      if (!battleStatus || !battleStatus.is_participant) {
        ctx.log("combat", "Battle monitoring: No longer in battle");
        clearInterval(monitorInterval);
        return;
      }

      // Check our hull
      await bot.refreshShip();
      const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;

      if (hullPct <= hullFleeThreshold) {
        ctx.log("combat", `Hull critical (${hullPct}% <= ${hullFleeThreshold}%) - initiating flee!`);
        clearInterval(monitorInterval);

        // Flee from battle
        const fled = await fleeFromBattle(ctx, true, 35000);
        if (fled) {
          ctx.log("combat", "Successfully fled battle due to low hull");

          // Check if we should return home
          if (hullPct <= 10) { // Very low hull - return home
            ctx.log("combat", "Hull very low - should return home for repairs");
            // Note: Routines should check for low hull and trigger return_home
          }
        } else {
          ctx.log("error", "Failed to flee battle despite low hull");
        }
      }
    } catch (error) {
      ctx.log("error", `Battle monitoring error: ${error}`);
      clearInterval(monitorInterval);
    }
  }, 5000); // Check every 5 seconds

  // Stop monitoring after 30 minutes (safety timeout)
  setTimeout(() => {
    clearInterval(monitorInterval);
    ctx.log("combat", "Battle monitoring timeout reached");
  }, 30 * 60 * 1000);
}

// ── Safety checks ────────────────────────────────────────────

/** Check fuel and hull, dock/refuel/repair if below thresholds.
 *  Uses ensureFueled() for robust cross-system fuel recovery. */
export async function safetyCheck(
  ctx: RoutineContext,
  opts: { fuelThresholdPct: number; hullThresholdPct: number },
): Promise<boolean> {
  const { bot } = ctx;
  await bot.refreshShip();
  await bot.refreshLocation();

  const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
  if (hullPct <= 40) {
    ctx.log("system", `Hull critical (${hullPct}%) — finding station for repair`);
    const docked = await ensureDocked(ctx);
    if (docked) {
      await repairShip(ctx);
    }
  }

  const fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
  if (fuelPct < opts.fuelThresholdPct) {
    if (bot.isCustomsHold()) {
      ctx.log("customs", "Fuel low but customs hold active - waiting for clearance before refueling");
      const outcome = await bot.waitForCustomsClear();
      ctx.log("customs", `Customs cleared (outcome: ${outcome}) - proceeding with refueling`);
    }
    const ok = await ensureFueled(ctx, opts.fuelThresholdPct);
    if (!ok) return false;
  }
  return true;
}

// ── Fuel-station selection (with blacklist bypass) ───────────
// The system blacklist is a *preference* (avoid sketchy systems). It must NEVER
// be a hard wall that strands a low-fuel bot in a pocket where every exit is
// blacklisted — that was the bug: the miner sat at 20% fuel for 40 minutes
// spamming "No approved refuel station reachable" while a station ~10 jumps away
// had room for it 3x over. When the blacklisted search finds nothing, we retry
// without the blacklist (still skipping pirate systems) and, as a last resort,
// ask the server for a reachable approved station we can actually afford to fly to.

export interface FuelStationTarget {
  systemId: string;
  poiId: string;
  poiName: string;
  hops: number;
  blacklistBypassed: boolean;
  serverRoute?: RouteSegment[];
}

export interface RouteFuelCheck {
  found: boolean;
  route?: RouteSegment[];
  totalJumps?: number;
  estimatedFuel?: number;
  fuelAvailable?: number;
  hasWormhole?: boolean;
  affordable?: boolean;
}

/** Ask the server for a route to a target system and whether we can afford it. */
export async function checkRouteFuel(
  ctx: RoutineContext,
  targetSystemId: string,
): Promise<RouteFuelCheck> {
  const { bot } = ctx;
  try {
    const resp = await bot.exec("find_route", { target_system: targetSystemId });
    const raw = resp.result as any;
    if (resp.error || !raw || !raw.found) return { found: false };
    const hasWormhole = routeHasWormhole(raw.route);
    let affordable: boolean | undefined;
    if (raw.fuel_available !== undefined && raw.estimated_fuel !== undefined && !hasWormhole) {
      affordable = raw.fuel_available >= raw.estimated_fuel;
    }
    return {
      found: true,
      route: raw.route,
      totalJumps: raw.total_jumps,
      estimatedFuel: raw.estimated_fuel,
      fuelAvailable: raw.fuel_available,
      hasWormhole,
      affordable,
    };
  } catch (e) {
    ctx.log("debug", `checkRouteFuel(${targetSystemId}) failed: ${e}`);
    return { found: false };
  }
}

/** Candidate {system, poiId} pairs to fall back to when local map search fails. */
function candidateApprovedStations(
  approvedSet: Set<string>,
  deniedSet: Set<string>,
): Array<{ systemId: string; poiId: string }> {
  const out: Array<{ systemId: string; poiId: string }> = [];
  const seen = new Set<string>();
  // 1) Explicit approvedFuelStations entries ("system|poi" or bare "poi")
  for (const e of approvedSet) {
    const parts = e.split("|");
    if (parts.length === 2) out.push({ systemId: parts[0], poiId: parts[1] });
  }
  // 2) Any known station POI on the map (prefer ones explicitly approved)
  for (const sys of mapStore.getSystems()) {
    for (const p of sys.pois) {
      if (!(p.has_base || (p as any).base_id)) continue;
      const key = `${sys.id}|${p.id}`;
      if (approvedSet.has(p.id) || approvedSet.has(key)) {
        const sKey = `${sys.id}|${p.id}`.toLowerCase();
        if (!seen.has(sKey) && !deniedSet.has(sKey) && !deniedSet.has(p.id.toLowerCase())) {
          out.push({ systemId: sys.id, poiId: p.id });
          seen.add(sKey);
        }
      }
    }
  }
  return out;
}

/**
 * Find a reachable approved fuel station, escalating through three strategies:
 *   1. Local map BFS honouring the blacklist (normal behaviour).
 *   2. Local map BFS ignoring the blacklist (recover from a blacklisted pocket).
 *   3. Server `find_route` over known approved stations, keeping only routes we
 *      can actually afford (enough fuel_available >= estimated_fuel).
 * Returns null when nothing reachable was found (caller should give up / recover).
 */
export async function findReachableFuelStation(
  ctx: RoutineContext,
  opts: { skipBlacklist?: boolean; skipApprovedCheck?: boolean; excludePoiIds?: Set<string> } = {},
): Promise<FuelStationTarget | null> {
  const { bot } = ctx;
  const approvedSet = opts.skipApprovedCheck ? new Set<string>() : buildApprovedStationSet(readSettings());
  const deniedSet = buildDeniedStationSet(opts.excludePoiIds);
  const blacklist = opts.skipBlacklist ? [] : getSystemBlacklist();

  // Strategy 1: honour the blacklist (unless explicitly skipped)
  if (blacklist.length > 0) {
    const nearest = mapStore.findNearestStationSystem(bot.system, blacklist, approvedSet, deniedSet);
    if (nearest) {
      return { ...nearest, blacklistBypassed: false };
    }
    ctx.log("system", "Blacklisted fuel search found no station — retrying without blacklist (avoiding pirate systems) before giving up");
  }

  // Strategy 2: ignore the blacklist (still skips pirate systems inside mapStore)
  const bypass = mapStore.findNearestStationSystem(bot.system, [], approvedSet, deniedSet);
  if (bypass) {
    ctx.log("system", `Found station ${bypass.poiName} in ${bypass.systemId} by bypassing the blacklist — stranded is worse than an avoided system`);
    return { ...bypass, blacklistBypassed: true };
  }

  // Strategy 3: ask the server for a reachable, affordable approved station.
  const candidates = candidateApprovedStations(approvedSet, deniedSet)
    .filter(c => c.systemId.toLowerCase() !== bot.system.toLowerCase());
  // Prefer stations whose distance we already know from the map.
  for (const c of candidates) {
    try { (c as any)._hops = mapStore.findNearestStationSystem(bot.system, [], approvedSet, new Set([c.poiId.toLowerCase()]))?.hops ?? 999; }
    catch { (c as any)._hops = 999; }
  }
  candidates.sort((a, b) => ((a as any)._hops as number) - ((b as any)._hops as number));

  let best: FuelStationTarget | null = null;
  let bestJumps = Infinity;
  for (const c of candidates.slice(0, 12)) {
    const check = await checkRouteFuel(ctx, c.systemId);
    if (!check.found || check.hasWormhole) continue;
    if (check.affordable === false) {
      ctx.log("debug", `Server route to ${c.systemId} not affordable (have ${check.fuelAvailable}, need ${check.estimatedFuel}) — skipping`);
      continue;
    }
    const jumps = check.totalJumps ?? (check.route?.length ? check.route.length - 1 : 999);
    if (jumps < bestJumps) {
      bestJumps = jumps;
      best = {
        systemId: c.systemId,
        poiId: c.poiId,
        poiName: c.poiId,
        hops: jumps,
        blacklistBypassed: true,
        serverRoute: check.route,
      };
    }
  }
  if (best) {
    ctx.log("system", `Server routed to approved station in ${best.systemId} (${best.hops} jumps) — flying there to refuel`);
  }
  return best;
}

/**
 * Outcome of a fuel check.
 *   "fueled"    — tank is at/above the threshold, carry on.
 *   "in_battle" — a battle is live, so the fuel subsystem was SKIPPED ENTIRELY.
 *                 This is NOT a fuel failure. The caller must go fight.
 *   "failed"    — genuinely could not secure fuel (no reachable station, broke, etc).
 */
export type FuelCheckOutcome = "fueled" | "in_battle" | "failed";

/**
 * Fuel check with an explicit outcome, so callers can tell "I'm out of fuel"
 * apart from "I'm busy being shot at".
 *
 * ── HARD COMBAT GUARD ───────────────────────────────────────────────────────
 * If a battle is live we do not care about fuel AT ALL, and we bail out before
 * touching a single line of the fuel machinery. Two independent reasons:
 *
 *   1. Fuel is NOT consumed while fighting. The tank physically cannot get
 *      worse during the battle, so there is nothing to protect against.
 *   2. Every fuel-acquiring action (refuel, dock, travel, jump) is rejected by
 *      the server with `in_battle` anyway.
 *
 * So there is literally nothing to gain and a fight to lose. Fighting is the
 * only thing that matters — OR WE DIE. We hand control straight back to the
 * caller's combat handling instead of grinding through station searches,
 * route planning and 30s sleeps while an enemy chews through our hull.
 */
export async function ensureFueledEx(
  ctx: RoutineContext,
  thresholdPct: number,
  opts?: { noJettison?: boolean; skipBlacklist?: boolean; skipApprovedCheck?: boolean; homeSystem?: string; skipFleeCheck?: boolean },
): Promise<FuelCheckOutcome> {
  const { bot } = ctx;

  if (bot.isInBattle()) {
    if (opts?.skipFleeCheck) {
      // Combat bot (hunter/fleet/escort). Confirm against the API first so a
      // stale WebSocket flag can never strand us in a phantom battle, then get
      // out of the way so the caller can fight.
      const status = await getBattleStatus(ctx);
      if (status) {
        ctx.log("combat", "⚔️ In battle — fuel check SKIPPED entirely (fuel is not consumed in combat). Fight first!");
        return "in_battle";
      }
      ctx.log("combat", "Clearing stale WebSocket battle state (API reports no battle)");
      bot.currentBattle.inBattle = false;
      bot.currentBattle.battleId = null;
      bot.currentBattle.participants = [];
    } else {
      // Non-combat bot (hauler/miner/trader). Running away IS its combat
      // response, so let it flee first — but still never fuel while in battle.
      ctx.log("combat", "Fuel check interrupted by battle — fleeing first (fuel is not consumed in combat)");
      const fled = await checkAndFleeFromBattle(ctx, "ensureFueled");
      if (!fled && bot.isInBattle()) {
        ctx.log("combat", "Still in battle after flee attempt — cannot fuel now, returning to caller");
        return "in_battle";
      }
    }
  }

  return (await ensureFueledCore(ctx, thresholdPct, opts)) ? "fueled" : "failed";
}

/**
 * Ensure the bot has adequate fuel.
 * If an approved fuel station list is configured and fuel is low,
 * go directly to the nearest approved station and refuel.
 * Returns true when fuel is adequate, false otherwise.
 *
 * NOTE: a `false` return can mean either "out of fuel" OR "in a battle, go
 * fight". Callers that have combat handling should prefer `ensureFueledEx()`
 * so they can tell the two apart.
 */
export async function ensureFueled(
  ctx: RoutineContext,
  thresholdPct: number,
  opts?: { noJettison?: boolean; skipBlacklist?: boolean; skipApprovedCheck?: boolean; homeSystem?: string; skipFleeCheck?: boolean },
): Promise<boolean> {
  return (await ensureFueledEx(ctx, thresholdPct, opts)) === "fueled";
}

/**
 * Core refuelling implementation. Assumes the caller already handled the
 * in-battle case (see `ensureFueledEx`).
 */
async function ensureFueledCore(
  ctx: RoutineContext,
  thresholdPct: number,
  opts?: { noJettison?: boolean; skipBlacklist?: boolean; skipApprovedCheck?: boolean; homeSystem?: string; skipFleeCheck?: boolean },
): Promise<boolean> {
  const { bot } = ctx;

  // ── FUEL-FIRST SHORT-CIRCUIT (must stay ABOVE the combat guard!) ───────────
  // If the tank is already above the threshold there is nothing to do, so bail
  // out immediately and NEVER touch the battle logic below.
  //
  // This ordering is load-bearing: the combat guard returns `false` while a
  // battle is active, and plain-boolean callers treat a `false` return as
  // "cannot secure fuel — wait 30s and retry". If the fuel level were checked
  // *after* the guard, a ship with a full tank (e.g. 95%) that gets jumped
  // would spin forever — "battle active" → "returning to caller" → "Cannot
  // secure fuel — waiting 30s" → repeat — never reaching the combat handling
  // in the caller's loop, so it just sits there being shot.
  await bot.refreshShip();
  await bot.refreshLocation();
  let fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
  if (fuelPct >= thresholdPct) return true;

  // ── COMBAT GUARD (second line of defence) ─────────────────────────────────
  // ensureFueledEx() already bailed out if we were in a battle on entry, but
  // this core routine jumps, travels and docks — a battle can start at any
  // point during that. Fuel is not consumed in combat and every fuel action is
  // rejected with `in_battle`, so stop immediately and let the caller fight.
  if (bot.isInBattle()) {
    ctx.log("combat", `Battle started mid-refuel (fuel ${fuelPct}%) — abandoning fuel run to fight (fuel is not consumed in combat)`);
    if (!opts?.skipFleeCheck) {
      const fled = await checkAndFleeFromBattle(ctx, "ensureFueled");
      if (fled || !bot.isInBattle()) {
        // Battle resolved (or was a stale flag) — re-evaluate fuel below.
      } else {
        // Still in battle and couldn't resolve it — bail so the caller can retry.
        ctx.log("combat", "Still in battle after flee attempt — cannot fuel now, returning to caller");
        return false;
      }
    } else {
      // Combat routine: do not auto-flee from here. Clear stale state if the
      // API disagrees, otherwise return control so the caller can handle the
      // battle with proper analysis (fight / flee based on tier / hull).
      const status = await getBattleStatus(ctx);
      if (!status && bot.isInBattle()) {
        ctx.log("combat", "Clearing stale WebSocket battle state (API reports no battle)");
        bot.currentBattle.inBattle = false;
        bot.currentBattle.battleId = null;
        bot.currentBattle.participants = [];
      } else if (status) {
        ctx.log("combat", "Active battle detected during fuel check — returning to caller to handle combat");
        return false;
      }
    }
  }

  // Re-read fuel: the combat guard above may have fled or otherwise changed
  // our state before falling through.
  await bot.refreshShip();
  fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
  if (fuelPct >= thresholdPct) return true;

  ctx.log("system", `Fuel low (${fuelPct}%) — need to refuel (threshold: ${thresholdPct}%)...`);

  // ── STEP 1: Check if already docked at a station with fuel service ───────
  await bot.refreshShip();
  const wasDocked = bot.docked;
  const { pois } = await getSystemInfo(ctx);
  const dockingStation = wasDocked ? pois.find(p => isStationPoi(p) && p.id === bot.poi) : undefined;

  // If docked at a station with fuel service, refuel there first (don't undock)
  if (wasDocked && dockingStation && isApprovedFuelStation(dockingStation.id, readSettings(), bot.system)) {
    ctx.log("system", `Already docked at ${dockingStation.name} with fuel service — refueling in place...`);
    await tryRefuel(ctx, { skipApprovedCheck: true });
    await bot.refreshShip();
    const newFuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    if (newFuelPct >= thresholdPct) {
      ctx.log("system", `Refueled at station — fuel now ${newFuelPct}%`);
      return true;
    }
  }

  // ── STEP 2: Convert all cargo fuel cells to fuel ────────────────────────
  // premium_fuel_cell, military_fuel_cell, x_fuel_cell, fuel_cell are consumed
  // via the refuel command even while docked at a station.
  // Undock first so cargo fuel cells are used one at a time (refuel undocked = use cargo)
  //
  // CRITICAL: Only undock if we actually HAVE fuel cells in cargo. Otherwise we
  // pointlessly undock, fail the refuel, and then fall through to a market buy at a
  // station that has no market. If cargo is empty, skip straight to the storage/market
  // fallback which checks faction/station storage first and only buys where a market exists.
  const cargoFuelCells = bot.inventory
    .filter((i) => isFuelCellItemId(i.itemId))
    .reduce((s, i) => s + (i.quantity || 0), 0);

  if (wasDocked && cargoFuelCells > 0) {
    ctx.log("system", `Undocking to use ${cargoFuelCells} cargo fuel cells before reaching for station fuel...`);
    await ensureUndocked(ctx);
  } else if (wasDocked && cargoFuelCells === 0) {
    ctx.log("system", "No fuel cells in cargo — skipping cargo refuel, will source from storage/market");
  }

  let cargoFuelAttempts = 0;
  const maxCargoFuelAttempts = 40;
  while (fuelPct < thresholdPct && cargoFuelAttempts < maxCargoFuelAttempts && bot.state === "running") {
    const resp = await bot.exec("refuel");
    if (resp.error) {
      const msg = resp.error.message.toLowerCase();
      if (msg.includes("no_fuel_cells") || msg.includes("no fuel cells") || msg.includes("no fuel")) {
        ctx.log("system", "Cargo fuel cells exhausted — refuel from cargo done");
        break;
      }
      ctx.log("error", `Cargo refuel error: ${resp.error.message}`);
      break;
    }
    cargoFuelAttempts++;
    await bot.refreshShip();
    fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    if (fuelPct >= thresholdPct) {
      ctx.log("system", `Refueled from cargo fuel cells — fuel now ${fuelPct}%`);
      return true;
    }
  }

  if (fuelPct >= thresholdPct) {
    return true;
  }

  // Universal fallback: we're docked at some station whose reserve is empty and we
  // have no cargo cells. Try to source fuel cells from faction/station storage or
  // the market (NOT gated by the approved-fuel-station list) before giving up and
  // wandering off to another station. The miner can otherwise deadlock here when
  // the only station it's locked to has 0 reserve but plenty of cells in storage.
  if (bot.docked) {
    const recovered = await acquireFuelCellsAndRefuel(ctx);
    await bot.refreshShip();
    fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    if (fuelPct >= thresholdPct) {
      ctx.log("system", `Recovered fuel at docked station (${dockingStation?.name ?? bot.poi}) — fuel now ${fuelPct}%`);
      return true;
    }
    if (recovered) {
      // Fuel improved but still under threshold — re-run tryRefuel for any residual station reserve.
      await tryRefuel(ctx, { skipApprovedCheck: true });
      await bot.refreshShip();
      fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
      if (fuelPct >= thresholdPct) return true;
    }
  }

  // Hunters (skipBlacklist=true) with homeSystem configured should go directly home to refuel
  if (opts?.skipBlacklist && opts?.homeSystem) {
    const homeSystem = opts.homeSystem;
    ctx.log("system", `Hunter mode: navigating to home system ${homeSystem} for refueling...`);
    const navResult = await navigateToSystem(ctx, homeSystem, { fuelThresholdPct: 10, hullThresholdPct: 50, noJettison: true, skipBlacklist: true });
    if (navResult) {
      await bot.refreshLocation();
      await getSystemInfo(ctx);
      const homeStation = findStation(pois);
      if (homeStation) {
        await ensureDocked(ctx);
        await tryRefuel(ctx, { skipApprovedCheck: true });
        await bot.refreshShip();
        const newFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
        if (newFuel >= thresholdPct) {
          ctx.log("system", `Refueled at home — fuel now ${newFuel}%`);
          return true;
        }
      }
    }
    // If we couldn't reach home or refuel there, continue to other options
  }

  // If we undocked and were previously docked, only return there if it's APPROVED
  // NOTE: station-approval is independent of the system blacklist (skipBlacklist).
  // A cloaked trader must still respect the approved-fuel-station allowlist.
  if (wasDocked && dockingStation && isApprovedFuelStation(dockingStation.id, readSettings(), bot.system)) {
    ctx.log("system", `Returning to ${dockingStation.name} to attempt station refuel...`);
    const trResp = await bot.exec("travel", { target_poi: dockingStation.id });
    bot.poi = dockingStation.id;
    const dResp = await bot.exec("dock");
    if (!dResp.error || dResp.error.message.includes("already")) {
      bot.docked = true;
      await ensureInsured(ctx);
    }
  }

  const currentStation = pois.find(p => isStationPoi(p) && p.id === bot.poi);
  const isCurrentStationApproved = currentStation && (opts?.skipApprovedCheck || isApprovedFuelStation(currentStation.id, readSettings(), bot.system));
  if (isCurrentStationApproved) {
    ctx.log("system", `Cargo fuel cells empty — attempting station refuel at ${currentStation.name}...`);
    const ok = await refuelAtStation(ctx, currentStation, thresholdPct, { skipApprovedCheck: opts?.skipApprovedCheck });
    if (ok) return true;
  } else if (currentStation) {
    ctx.log("system", `Station ${currentStation.name} is not on approved fuel list — checking if can reach home...`);
    const homeSystem = opts?.homeSystem || readSettings().homeSystem;
    if (homeSystem && typeof homeSystem === "string") {
      try {
        const routeResp = await bot.exec("find_route", { target_system: homeSystem });
        const routeData = routeResp.result as { found?: boolean; route?: RouteSegment[]; total_jumps?: number; fuel_per_jump?: number; fuel_available?: number; estimated_fuel?: number } | null;
        const hasWormhole = routeHasWormhole(routeData?.route);
        if (routeData?.found && routeData?.fuel_available !== undefined && routeData?.estimated_fuel !== undefined && !hasWormhole) {
          const canMakeItHome = routeData.fuel_available >= routeData.estimated_fuel;
          ctx.log("system", `Route to home: ${routeData.total_jumps} jumps, need ${routeData.estimated_fuel} fuel, have ${routeData.fuel_available}`);
          if (canMakeItHome) {
            ctx.log("system", `Can reach home (${routeData.fuel_available} fuel >= ${routeData.estimated_fuel} needed) — navigating home to refuel`);
            await navigateToSystem(ctx, homeSystem, { fuelThresholdPct: thresholdPct, hullThresholdPct: 50, noJettison: true });
            await bot.refreshLocation();
            const { pois: homePois } = await getSystemInfo(ctx);
            const homeStation = findStation(homePois);
            if (homeStation) {
              await bot.exec("travel", { target_poi: homeStation.id });
              await bot.exec("dock");
              bot.docked = true;
              await tryRefuel(ctx);
              await bot.refreshShip();
              const newFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
              if (newFuel >= thresholdPct) {
                ctx.log("system", `Refueled at home — fuel now ${newFuel}%`);
                return true;
              }
            }
            return false;
          } else {
            ctx.log("system", `Cannot reach home (${routeData.fuel_available} fuel < ${routeData.estimated_fuel} needed) — stranded`);
            return false;
          }
        } else if (hasWormhole) {
          ctx.log("system", `Route to home uses wormhole — cannot navigate (bot has not unlocked wormhole POI)`);
          ctx.log("debug", `Route contained wormhole segment(s) - forcing reroute to avoid POI the bot cannot access`);
        }
      } catch (e) {
        ctx.log("system", `Could not check route home: ${e}`);
      }
    }
  }

  // ── STEP 4: Scavenge wrecks as last resort ──────────────────────────────
  if (bot.fuel <= 1) {
    ctx.log("system", "Nearly out of fuel — scavenging for fuel cells...");
    const looted = await scavengeWrecks(ctx, { fuelOnly: true });
if (looted > 0) {
        const scavRefuel = await bot.exec("refuel");
        if (!scavRefuel.error) {
          await bot.refreshShip();
          fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
        if (fuelPct >= thresholdPct) {
          ctx.log("system", `Scavenged fuel cells — fuel now ${fuelPct}%`);
          return true;
        }
      }
    }
  }

  // ── STEP 5: Find nearest known APPROVED station with fuel ────────────────
  // Loop so a station that turns out to be empty/denied can be skipped and the
  // next reachable candidate tried, instead of giving up on the first miss.
  const haveCurrentStation = !!pois.find(p => isStationPoi(p) && p.id === bot.poi);
  ctx.log("system", haveCurrentStation
    ? "Current station not approved for refuel — searching known map for nearest approved station..."
    : "No approved station in current system — searching known map for nearest station...");

  const rejected = new Set<string>();
  let nearest: FuelStationTarget | null = null;
  let unaffordableTarget: FuelStationTarget | null = null;

  // Try several stations in turn. If the station we fly to turns out to be empty
  // on arrival (reserve depleted / no fuel cells), remember it for THIS search
  // and move on to the next reachable station instead of looping forever on a dead one.
  for (let stationAttempt = 0; stationAttempt < 6; stationAttempt++) {
    if (!nearest) {
      for (let attempt = 0; attempt < 4 && !nearest; attempt++) {
        const candidate = await findReachableFuelStation(ctx, {
          skipBlacklist: opts?.skipBlacklist,
          skipApprovedCheck: opts?.skipApprovedCheck,
          excludePoiIds: rejected,
        });
        if (!candidate) break;

        // Skip stations that explicitly report 0 fuel (Sol is always stocked).
        if (candidate.poiId !== "sol_station" && candidate.poiId !== "sol_central") {
          let fuelAtStation: number | null = null;
          try {
            const poiResp = await bot.exec("get_poi", { poi_id: candidate.poiId });
            fuelAtStation = (poiResp as any)?.result?.base?.fuel ?? (poiResp as any)?.base?.fuel;
          } catch {}
          if (fuelAtStation !== null && fuelAtStation !== undefined && fuelAtStation <= 0) {
            ctx.log("system", `Skipping ${candidate.poiName} — station reports 0 fuel`);
            rejected.add(candidate.poiId.toLowerCase());
            continue;
          }
        }

        // Don't fly to a station we can't afford to reach — check the server route
        // (unless we're already there, or we already validated it via checkRouteFuel).
        if (candidate.systemId.toLowerCase() !== bot.system.toLowerCase() && !candidate.serverRoute) {
          const check = await checkRouteFuel(ctx, candidate.systemId);
          if (check.found && check.hasWormhole) {
            ctx.log("system", `Route to ${candidate.poiName} uses a wormhole — skipping (bot cannot traverse it)`);
            rejected.add(candidate.poiId.toLowerCase());
            continue;
          }
          if (check.affordable === false) {
            ctx.log("system", `Cannot afford route to ${candidate.poiName} (have ${check.fuelAvailable}, need ${check.estimatedFuel}) — will retry further stations first`);
            if (!unaffordableTarget) unaffordableTarget = { ...candidate, serverRoute: check.route };
            rejected.add(candidate.poiId.toLowerCase());
            continue;
          }
          candidate.serverRoute = check.route;
        }

        nearest = candidate;
      }
    }

    if (!nearest) {
      if (unaffordableTarget) {
        ctx.log("error", `No affordable approved refuel station reachable — falling back to furthest-possible target`);
        nearest = unaffordableTarget;
        unaffordableTarget = null;
      } else {
        ctx.log("error", "No approved refuel station reachable");
        return false;
      }
    }

    // A blacklist bypass is a last-resort escape from a blacklisted pocket: keep
    // it bypassed for the route too, otherwise findRoute() returns null and the
    // bot jumps blind or gets "stuck" again.
    const routeBlacklist = nearest.blacklistBypassed ? [] : (opts?.skipBlacklist ? [] : getSystemBlacklist());

    ctx.log("travel", `Nearest station: ${nearest.poiName} in ${nearest.systemId} (${nearest.hops} jump${nearest.hops !== 1 ? "s" : ""} away)${nearest.blacklistBypassed ? " [blacklist bypassed]" : ""}`);

    if (nearest.systemId.toLowerCase() !== bot.system.toLowerCase()) {
      await ensureUndocked(ctx);
      // Prefer the server-validated route (matches what return_home used: 10 jumps,
      // 166 fuel available >= 50 needed). Fall back to the local map route.
      let route: string[] | null = null;
      if (nearest.serverRoute && nearest.serverRoute.length > 1) {
        route = nearest.serverRoute.map(s => s.system_id);
      } else {
        route = mapStore.findRoute(bot.system, nearest.systemId, routeBlacklist);
      }
      // SANITY CHECK: findReachableFuelStation already told us how far the station
      // is (BFS hops over the same map). If the planned route is wildly longer,
      // the route is bogus (stale precalc entry / wormhole detour) and following
      // it on low fuel strands the bot half a map away. Never fly it.
      if (route && route.length - 1 > nearest.hops + 2) {
        ctx.log("error", `Planned route to ${nearest.systemId} is ${route.length - 1} jumps but the station is only ${nearest.hops} away — rejecting bogus route`);
        route = mapStore.findRouteWithMode(bot.system, nearest.systemId, routeBlacklist, false);
        if (route && route.length - 1 > nearest.hops + 2) {
          ctx.log("error", `Fallback route is still ${route.length - 1} jumps — refusing to burn fuel on it`);
          return await emergencyFuelRecovery(ctx);
        }
        ctx.log("travel", `Using direct ${route ? route.length - 1 : 0}-jump route instead`);
      }
      if (route && route.length > 1) {
        for (let i = 1; i < route.length; i++) {
          if (bot.state !== "running") return false;
          await bot.refreshLocation();
          const preFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
          if (preFuel < 10) {
            ctx.log("error", `Fuel too low (${preFuel}%) to reach station — emergency recovery...`);
            return await emergencyFuelRecovery(ctx);
          }
          ctx.log("travel", `Jumping to ${route[i]} (${i}/${route.length - 1})...`);
          const jumpResp = await bot.exec("jump", { target_system: route[i] });
          if (jumpResp.error) {
            ctx.log("error", `Jump failed: ${jumpResp.error.message}`);
            return await emergencyFuelRecovery(ctx);
          }
        }
      } else {
        ctx.log("travel", `Direct jump to ${nearest.systemId}...`);
        const jumpResp = await bot.exec("jump", { target_system: nearest.systemId });
        if (jumpResp.error) {
          ctx.log("error", `Jump failed: ${jumpResp.error.message}`);
          return await emergencyFuelRecovery(ctx);
        }
      }
    }

    await bot.refreshLocation();
    await ensureUndocked(ctx);
    ctx.log("travel", `Traveling to ${nearest.poiName}...`);
    const tResp = await bot.exec("travel", { target_poi: nearest.poiId });
    if (tResp.error && !tResp.error.message.includes("already")) {
      ctx.log("error", `Travel to station failed: ${tResp.error.message}`);
      return await emergencyFuelRecovery(ctx);
    }
    bot.poi = nearest.poiId;

    const dResp = await bot.exec("dock");
    if (!dResp.error || dResp.error.message.includes("already")) {
      bot.docked = true;
      await collectFromStorage(ctx);
      await ensureInsured(ctx);
    } else {
      // A station that explicitly denied us must never be retried — remember it.
      if (/access denied/i.test(dResp.error?.message || "")) {
        ctx.log("error", `Dock denied at ${nearest.poiName} — will not retry this station`);
        markStationDenied(nearest.poiId);
        rejected.add(nearest.poiId.toLowerCase());
      } else {
        ctx.log("error", `Dock failed at ${nearest.poiName}: ${dResp.error.message}`);
      }
      await ensureUndocked(ctx);
      nearest = null;
      continue;
    }

    await tryRefuel(ctx, { skipApprovedCheck: opts?.skipApprovedCheck });
    await bot.refreshShip();
    let newFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    ctx.log("system", `Refueled at ${nearest.poiName} — Fuel: ${newFuel}%`);

    if (newFuel >= thresholdPct) return true;

    // Below threshold — if the station itself is empty, don't loop on it: remember
    // it for this search and try the next reachable station instead.
    let stationEmpty = false;
    if (nearest.poiId !== "sol_station" && nearest.poiId !== "sol_central") {
      try {
        const poiResp = await bot.exec("get_poi", { poi_id: nearest.poiId });
        const f = (poiResp as any)?.result?.base?.fuel ?? (poiResp as any)?.base?.fuel;
        if (f !== null && f !== undefined && f <= 0) stationEmpty = true;
      } catch {}
    }

    if (stationEmpty) {
      ctx.log("error", `Station ${nearest.poiName} reports 0 fuel after arrival — moving to another station`);
      rejected.add(nearest.poiId.toLowerCase());
      await ensureUndocked(ctx);
      nearest = null;
      continue;
    }

    if (newFuel < thresholdPct) {
      ctx.log("system", `Fuel still below threshold (${newFuel}% < ${thresholdPct}%) — staying docked and waiting...`);
      for (let w = 0; w < REFUEL_WAIT_RETRIES && bot.state === "running"; w++) {
        await sleep(REFUEL_WAIT_INTERVAL);
        await bot.refreshShip();
        const refuelResp = await bot.exec("refuel");
        if (refuelResp.error) {
          const msg = refuelResp.error.message.toLowerCase();
          if (msg.includes("no_fuel_cells") || msg.includes("no fuel cells") || msg.includes("station_fuel_empty")) {
            ctx.log("error", `Cannot refuel: no fuel cells available at station — will not retry infinitely`);
            break;
          }
        }
        await bot.refreshShip();
        newFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
        if (newFuel >= thresholdPct) {
          ctx.log("system", `Fuel recovered to ${newFuel}% — resuming`);
          break;
        }
        ctx.log("system", `Still waiting for fuel (${newFuel}%)... (${w + 1}/${REFUEL_WAIT_RETRIES})`);
      }
    }

    await bot.refreshShip();
    newFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    ctx.log("system", "Undocking...");
    await bot.exec("undock");
    bot.docked = false;
    // Preserve prior behaviour: report success if we at least have some fuel,
    // otherwise signal the caller we're still short so it can re-plan.
    return newFuel >= 10;
  }

  await ensureUndocked(ctx);
  return false;
}

// ── Cargo deposit ──────────────────────────────────────────

/** Legacy default home system/station — only used as a fallback when the global
 *  home base has not been configured in Settings → General. Do NOT rely on these
 *  for new logic; read the live home base via {@link getGlobalHomeBase} instead. */
const HOME_SYSTEM_FALLBACK = "sol";
const HOME_STATION_POI_FALLBACK = "sol_station";
const HOME_STATION_NAME_FALLBACK = "Sol Central";

/**
 * Resolve the configured global home base (Settings → General → factionStorageSystem /
 * factionStorageStation). This is the single source of truth now that "Sol Central"
 * is no longer the home base.
 *
 * `factionStorageStation` may be stored as a bare POI id ("grand_exchange_station")
 * or as "system|poi" ("haven|grand_exchange_station"). When only a POI is stored we
 * return it as `station` and leave `system` empty so the caller can discover the
 * system from the live map. Returns empty strings when nothing is configured.
 */
export interface GlobalHomeBase {
  /** System id, may be empty if only a station POI was configured. */
  system: string;
  /** POI id of the home station, may be empty. */
  station: string;
  /** Best-effort display name for logs. */
  name: string;
}

export function getGlobalHomeBase(): GlobalHomeBase {
  const all = readSettings();
  const general = (all.general || {}) as Record<string, unknown>;
  const rawSystem = (general.factionStorageSystem as string) || "";
  let station = (general.factionStorageStation as string) || "";
  let system = rawSystem;
  if (station.includes("|")) {
    const [sysPart, poiPart] = station.split("|");
    if (!system && sysPart) system = sysPart;
    station = poiPart || "";
  }
  const name = station || system || HOME_STATION_NAME_FALLBACK;
  return { system, station, name };
}

/**
 * Robust travel to the configured home station (handles landing at distant planets
 * after a jump). Uses live getSystemInfo + mapStore fallback for the correct POI id,
 * plus retries for "unknown destination". Returns true if positioned at the home
 * station POI. Falls back to any station in the system when no POI is configured.
 */
export async function travelToHomeStation(ctx: RoutineContext): Promise<boolean> {
  const { bot } = ctx;
  const home = getGlobalHomeBase();
  const homeStationPoi = home.station || HOME_STATION_POI_FALLBACK;
  const homeSystem = home.system || HOME_SYSTEM_FALLBACK;
  const homeName = home.name || HOME_STATION_NAME_FALLBACK;

  await bot.refreshLocation();
  if (bot.poi === homeStationPoi) return true;

  // Resolve POI id (live local first, fallback to stored map data)
  let stationPoi = homeStationPoi;
  try {
    const { pois } = await getSystemInfo(ctx);
    const live = pois.find(p => isStationPoi(p) && (p.id === homeStationPoi || new RegExp(homeName, "i").test(p.name || "")));
    if (live) stationPoi = live.id;
    else {
      const stored = mapStore.getSystem(homeSystem)?.pois?.find((p: any) => p.id === homeStationPoi || new RegExp(homeName, "i").test(p.name || ""));
      if (stored) stationPoi = stored.id;
    }
  } catch {}

  await ensureUndocked(ctx);

  const attemptTravel = async (poi: string) => {
    const r = await bot.exec("travel", { target_poi: poi });
    const unk = !!(r.error && /unknown destination/i.test(r.error.message || ""));
    return { resp: r, unknown: unk };
  };

  let { resp, unknown } = await attemptTravel(stationPoi);
  if (unknown) {
    ctx.log("warn", `${homeName} not in local travel list from ${bot.poi} — settling position and retry...`);
    await ctx.sleep(1500);
    await bot.refreshLocation();
    ({ resp, unknown } = await attemptTravel(stationPoi));
  }
  if (unknown) {
    ctx.log("warn", `Still unknown for ${homeName} — dock/undock at local station to update position then retry...`);
    if (await ensureDocked(ctx, true)) {
      await ensureUndocked(ctx);
      ({ resp, unknown } = await attemptTravel(stationPoi));
    }
  }

  if (resp.error && !resp.error.message.includes("already")) {
    ctx.log("error", `Travel to ${homeName} failed: ${resp.error.message}`);
    return false;
  }
  bot.poi = stationPoi;
  return true;
}

/**
 * Navigate to the configured home base and deposit all non-fuel cargo to station
 * storage. Used when cargo is full during exploration. Returns true if deposit
 * succeeded. The destination is read from the global home base (Settings → General)
 * rather than hardcoded to Sol Central.
 */
export async function depositCargoAtHome(
  ctx: RoutineContext,
  opts: { fuelThresholdPct: number; hullThresholdPct: number } = { fuelThresholdPct: 40, hullThresholdPct: 30 },
): Promise<boolean> {
  const { bot } = ctx;
  await bot.refreshCargoAndStorage();

  const home = getGlobalHomeBase();
  const homeSystem = home.system || HOME_SYSTEM_FALLBACK;
  const homeName = home.name || HOME_STATION_NAME_FALLBACK;

  ctx.log("trade", `Cargo full (${bot.cargo}/${bot.cargoMax}) — returning to ${homeName} to deposit...`);

  // Navigate to the home system if configured & not already there
  if (homeSystem && bot.system !== homeSystem) {
    await ensureUndocked(ctx);
    const arrived = await navigateToSystem(ctx, homeSystem, opts);
    if (!arrived) {
      ctx.log("error", `Could not reach ${homeSystem} — will try depositing at nearest station`);
      // Fallback: dock at any local station
      await ensureDocked(ctx);
      if (!bot.docked) return false;
      return await depositNonFuelCargo(ctx);
    }
  }

  // Dock at the configured home station (or any station in the system as fallback)
  const docked = await ensureDocked(ctx, true, 0, home.station ? { targetStationId: home.station } : undefined);
  if (!docked) {
    ctx.log("error", `Could not dock at home base (${homeName})`);
    return false;
  }

  await ensureInsured(ctx);

  // Collect any gifted credits/items from storage
  await collectFromStorage(ctx);

  // Deposit cargo
  const deposited = await depositNonFuelCargo(ctx);

  // Refuel while we're here
  await tryRefuel(ctx);

  // Undock
  await ensureUndocked(ctx);

  return deposited;
}

/** Deposit all non-fuel cargo to faction storage (shared pool). Assumes docked. Returns true if any items deposited. */
export async function depositNonFuelCargo(ctx: RoutineContext): Promise<boolean> {
  const { bot } = ctx;
  const cargoResp = await bot.exec("get_cargo");
  if (!cargoResp.result || typeof cargoResp.result !== "object") return false;

  const cResult = cargoResp.result as Record<string, unknown>;
  const cargoItems = (
    Array.isArray(cResult) ? cResult :
    Array.isArray(cResult.items) ? (cResult.items as Array<Record<string, unknown>>) :
    Array.isArray(cResult.cargo) ? (cResult.cargo as Array<Record<string, unknown>>) :
    []
  );

  let deposited = 0;
  for (const item of cargoItems) {
    const itemId = (item.item_id as string) || "";
    const quantity = (item.quantity as number) || 0;
    if (!itemId || quantity <= 0) continue;
    const lower = itemId.toLowerCase();
    if (lower.includes("fuel") || lower.includes("energy_cell")) continue;

    const displayName = (item.name as string) || itemId;
    // Try faction storage first (shared pool), fall back to station storage
    const fResp = await bot.exec("faction_deposit_items", { item_id: itemId, quantity });
    if (!fResp.error) {
      ctx.log("trade", `Deposited ${quantity}x ${displayName} to faction storage`);
      logFactionActivity(ctx, "deposit", `Deposited ${quantity}x ${displayName} to faction storage`);
    } else {
      await bot.exec("deposit_items", { item_id: itemId, quantity });
      ctx.log("trade", `Deposited ${quantity}x ${displayName} to station storage (faction full/unavailable)`);
    }
    deposited += quantity;
  }

  if (deposited > 0) {
    await bot.refreshCargo();
  }
  return deposited > 0;
}

// ── Navigation ───────────────────────────────────────────────

/**
 * Explicitly pause the routine until the bot's socket is reconnected. The
 * dispatch layer (bot.ts libExec) already survives a dropped socket by blocking
 * and resending, but calling this at the top of a travel loop makes the routine
 * *visibly* aware it can't act while disconnected, and avoids burning jump
 * retries/route re-queries against a dead socket. Fast no-op when already
 * connected. Returns true if connected (or reconnected), false if the routine
 * should give up (stopped or the connection is terminal).
 */
export async function waitForReconnect(ctx: RoutineContext): Promise<boolean> {
  if (ctx.bot.isConnected()) return true;
  ctx.log("warn", "Socket not connected — waiting for reconnection before issuing commands...");
  const ok = await ctx.bot.waitForSocket();
  if (ok) ctx.log("system", "Socket reconnected — resuming routine.");
  else ctx.log("error", "Socket could not be restored — ending routine.");
  return ok;
}

/** Route segment from find_route API response */
export interface RouteSegment {
  system_id: string;
  name: string;
  jumps?: number;
  via_wormhole?: boolean;
  entrance_poi?: string;
}

/** Check if a route contains wormhole segments that the bot cannot traverse. */
export function routeHasWormhole(route: RouteSegment[] | undefined): boolean {
  if (!route) return false;
  return route.some(seg => seg.via_wormhole === true);
}

/** Navigate to a target system via jump chain. Returns true if arrived. */
export async function navigateToSystem(
  ctx: RoutineContext,
  targetSystemId: string,
  opts: { fuelThresholdPct: number; hullThresholdPct: number; noJettison?: boolean; autoCloak?: boolean; onJump?: (jumpNumber: number) => Promise<boolean>; onBeforeJump?: (nextSystem: string, jumpNumber: number) => Promise<void>; onPreJump?: (nextSystem: string, jumpNumber: number) => void; skipBlacklist?: boolean; isCombatBot?: boolean; joinBattles?: boolean; ignorePiratesWhenCloaked?: boolean; ignoreBlacklistWhenCloaked?: boolean },
): Promise<boolean> {
  const { bot } = ctx;
  const MAX_JUMPS = 199;
  const MAX_RETRIES_PER_JUMP = 10;
  // A cloaked ship cannot be ambushed, so (by default) it may ignore both
  // pirates and blacklisted systems while cloaked. Both behaviors are
  // toggleable: a routine can pass either option as `false` to disable.
  const ignorePiratesWhenCloaked = opts.ignorePiratesWhenCloaked !== false;
  const ignoreBlacklistWhenCloaked = opts.ignoreBlacklistWhenCloaked !== false;
  // Fleet hunters BYPASS blacklist — they MUST enter pirate systems.
  // A cloaked ship also bypassses the blacklist (cloaking alone is enough)
  // unless the routine explicitly opted out via ignoreBlacklistWhenCloaked.
  const blacklist = (opts.skipBlacklist || (ignoreBlacklistWhenCloaked && bot.isCloaked)) ? [] : getSystemBlacklist();

  // Normalize system names for comparison (replace underscores with spaces, lowercase)
  const normalizeSystemName = (name: string) => name.toLowerCase().replace(/_/g, ' ').trim();

  for (let attempt = 0; attempt < MAX_JUMPS; attempt++) {
    // If the socket dropped (server restart / blip), pause here until it's back
    // rather than hammering route queries / jumps against a dead connection.
    // The dispatch layer also blocks per-command, so this is defense-in-depth.
    if (!bot.isConnected()) {
      const reconnected = await waitForReconnect(ctx);
      if (!reconnected) return false;
    }
    await bot.refreshLocation();
    // Case-insensitive comparison for system names (handle underscore vs space)
    if (normalizeSystemName(bot.system) === normalizeSystemName(targetSystemId)) {
      ctx.log("travel", `Already at ${targetSystemId} (normalized: "${normalizeSystemName(bot.system)}" === "${normalizeSystemName(targetSystemId)}")`);
      return true;
    }

    // Plan route from current position (use blacklist to avoid pirate systems)
    const route = mapStore.findRoute(bot.system, targetSystemId, blacklist);
    let nextSystem: string | null = null;

    if (route && route.length > 1) {
      nextSystem = route[1];
      ctx.log("travel", `Route: ${route.length - 1} jump${route.length - 1 !== 1 ? "s" : ""} remaining`);
    } else {
      ctx.log("travel", `No mapped route — querying server for route to ${targetSystemId}`);
      const routeResp = await bot.exec("find_route", { target_system: targetSystemId });
      const routeData = routeResp.result as { found?: boolean; route?: RouteSegment[]; total_jumps?: number; message?: string } | null;

      // Check if server says we're already at target (message field or 0 jumps)
      const alreadyAtTarget = routeData?.found && (
        routeData.total_jumps === 0 ||
        (routeData.message && routeData.message.toLowerCase().includes('already')) ||
        (routeData.route && routeData.route.length === 1)
      );

      if (alreadyAtTarget) {
        ctx.log("travel", `Server confirms we are already at ${targetSystemId}`);
        return true;
      }

      if (!routeResp.error && routeData?.found && routeData.route && routeData.route.length > 1) {
        const serverRouteSystemIds = routeData.route.map(r => r.system_id);
        // Exclude the first system (current position) from blacklist check - we're already there
        const systemsToCheck = serverRouteSystemIds.slice(1);
        const blacklistedOnRoute = systemsToCheck.find(
          sysId => blacklist.some(b => b.toLowerCase() === sysId.toLowerCase())
        );
        const routeStartsHere = serverRouteSystemIds[0] && 
          normalizeSystemName(serverRouteSystemIds[0]) === normalizeSystemName(bot.system);
        const hasWormhole = routeHasWormhole(routeData.route);

        const bypassBlacklist = (ignoreBlacklistWhenCloaked && bot.isCloaked) || !!opts.skipBlacklist;

        if (blacklistedOnRoute && !bypassBlacklist) {
          ctx.log("warn", `Server route passes through blacklisted system ${blacklistedOnRoute} — rejecting server route`);
        } else if (blacklistedOnRoute && bypassBlacklist) {
          ctx.log("travel", `Server route passes through blacklisted system ${blacklistedOnRoute} — cloaked/skipBlacklist, using route`);
          nextSystem = routeData.route[1].system_id;
        } else if (!routeStartsHere) {
          ctx.log("warn", `Server route does not start from current system (${bot.system}) — rejecting stale route`);
        } else if (hasWormhole) {
          ctx.log("warn", `Server route uses wormhole — rejecting route (bot has not unlocked wormhole POI)`);
          ctx.log("debug", `Route contained wormhole segment(s) - forcing reroute to avoid POI the bot cannot access`);
        } else {
          nextSystem = routeData.route[1].system_id;
          const fullRoute = routeData.route.map(r => r.system_id).join(" → ");
          ctx.log("travel", `Server route: ${routeData.total_jumps} jump${routeData.total_jumps !== 1 ? "s" : ""} — next: ${nextSystem}`);
          ctx.log("debug", `Server returned full route for ${targetSystemId}: ${fullRoute}`);
        }
      }

      // If server route was rejected or unavailable, try fallback options
      if (!nextSystem) {
        // Server returned no route - check if we might already be at the target
        // This can happen due to case mismatch or if we're already there
        ctx.log("warn", `Server returned no route to ${targetSystemId} — checking if already arrived...`);
        await bot.refreshLocation();
        if (normalizeSystemName(bot.system) === normalizeSystemName(targetSystemId)) {
          ctx.log("travel", `Confirmed at ${targetSystemId} after failed route lookup (normalized comparison)`);
          return true;
        }
        // Also check if we're in a neighboring system (1 jump away)
        const currentSystemData = mapStore.getSystem(bot.system);
        if (currentSystemData) {
          const isNeighbor = currentSystemData.connections.some(
            c => normalizeSystemName(c.system_id) === normalizeSystemName(targetSystemId)
          );
          if (isNeighbor) {
            ctx.log("travel", `Target ${targetSystemId} is adjacent - attempting direct jump`);
            nextSystem = targetSystemId;
          } else {
            ctx.log("error", `No route to ${targetSystemId} from ${bot.system} — cannot navigate`);
            return false;
          }
        } else {
          ctx.log("error", `No route to ${targetSystemId} — cannot navigate`);
          return false;
        }
      }
    }

    // Hull check — repair immediately if <= 40%
    const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    if (hullPct <= 40) {
      ctx.log("system", `Hull critical (${hullPct}%) — finding station for repair`);
      const docked = await ensureDocked(ctx);
      if (docked) {
        await repairShip(ctx);
        await ensureUndocked(ctx);
      } else if (hullPct === 0) {
        ctx.log("error", "Hull at 0% and no station found — cannot continue safely");
        return false;
      }
    }

// Fuel check — MUST have adequate fuel before jumping
      const fueled = await ensureFueledEx(ctx, opts.fuelThresholdPct, { noJettison: opts.noJettison, skipBlacklist: opts.skipBlacklist || (ignoreBlacklistWhenCloaked && bot.isCloaked), skipApprovedCheck: opts.skipBlacklist || (ignoreBlacklistWhenCloaked && bot.isCloaked), skipFleeCheck: opts.isCombatBot });
      if (fueled === "in_battle") {
        // Not a fuel problem — we're in a fight, and jumps are rejected while in
        // battle anyway. Abort navigation so the caller resolves combat first
        // (hunters call handleNavigationBattleInterrupt on a false return).
        ctx.log("combat", "In battle — aborting navigation so combat can be resolved first");
        return false;
      }
      if (fueled !== "fueled") {
      ctx.log("error", "Cannot secure fuel for jump — aborting navigation");
      return false;
    }

    // CRITICAL: Re-check position after ensureFueled — it may have moved us to a different system!
    await bot.refreshLocation();
    if (normalizeSystemName(bot.system) === normalizeSystemName(targetSystemId)) return true;

    // Recalculate route from CURRENT position (ensureFueled may have moved us, use blacklist)
    const postFuelRoute = mapStore.findRoute(bot.system, targetSystemId, blacklist);
    if (postFuelRoute && postFuelRoute.length > 1) {
      nextSystem = postFuelRoute[1];
      ctx.log("travel", `Route recalculated from ${bot.system}: ${postFuelRoute.length - 1} jump${postFuelRoute.length - 1 !== 1 ? "s" : ""} remaining`);
    } else {
      // No mapped route — query server
      ctx.log("travel", `No mapped route from ${bot.system} — querying server for route to ${targetSystemId}`);
      const routeResp = await bot.exec("find_route", { target_system: targetSystemId });
      const routeData = routeResp.result as { found?: boolean; route?: RouteSegment[]; total_jumps?: number; message?: string } | null;

      // Check if server says we're already at target
      const alreadyAtTarget = routeData?.found && (
        routeData.total_jumps === 0 ||
        (routeData.message && routeData.message.toLowerCase().includes('already')) ||
        (routeData.route && routeData.route.length === 1)
      );

      if (alreadyAtTarget) {
        ctx.log("travel", `Server confirms we are already at ${targetSystemId} (post-fuel check)`);
        return true;
      }

      if (!routeResp.error && routeData?.found && routeData.route && routeData.route.length > 1) {
        const serverRouteSystemIds = routeData.route.map(r => r.system_id);
        // Exclude the first system (current position) from blacklist check - we're already there
        const systemsToCheck = serverRouteSystemIds.slice(1);
        const blacklistedOnRoute = systemsToCheck.find(
          sysId => blacklist.some(b => b.toLowerCase() === sysId.toLowerCase())
        );
        const routeStartsHere = serverRouteSystemIds[0] && 
          normalizeSystemName(serverRouteSystemIds[0]) === normalizeSystemName(bot.system);
        const hasWormhole = routeHasWormhole(routeData.route);

        const bypassBlacklist = (ignoreBlacklistWhenCloaked && bot.isCloaked) || !!opts.skipBlacklist;
        
        if (blacklistedOnRoute && !bypassBlacklist) {
          ctx.log("warn", `Server route passes through blacklisted system ${blacklistedOnRoute} — rejecting server route (post-fuel)`);
        } else if (blacklistedOnRoute && bypassBlacklist) {
          ctx.log("travel", `Server route passes through blacklisted system ${blacklistedOnRoute} — cloaked/skipBlacklist, using route (post-fuel)`);
          nextSystem = routeData.route[1].system_id;
        } else if (!routeStartsHere) {
          ctx.log("warn", `Server route does not start from current system (${bot.system}) — rejecting stale route (post-fuel)`);
        } else if (hasWormhole) {
          ctx.log("warn", `Server route uses wormhole — rejecting route (bot has not unlocked wormhole POI) (post-fuel)`);
          ctx.log("debug", `Route contained wormhole segment(s) - forcing reroute to avoid POI the bot cannot access (post-fuel)`);
        } else {
          nextSystem = routeData.route[1].system_id;
          const fullRoute = routeData.route.map(r => r.system_id).join(" → ");
          ctx.log("travel", `Server route: ${routeData.total_jumps} jump${routeData.total_jumps !== 1 ? "s" : ""} — next: ${nextSystem}`);
          ctx.log("debug", `Server returned full route for ${targetSystemId}: ${fullRoute}`);
        }
      }

      if (!nextSystem) {
        ctx.log("error", `No route from ${bot.system} to ${targetSystemId} — cannot navigate`);
        return false;
      }
    }

    await ensureUndocked(ctx);

    // Pre-jump cloak check: cloak before jumping to dangerous systems if autoCloak enabled
    if (opts.autoCloak && !bot.isCloaked) {
      const nextSys = mapStore.getSystem(nextSystem);
      if (nextSys && isDangerousSystem(nextSys.security_level)) {
        ctx.log("system", `Cloaking before jump to dangerous system ${nextSystem}...`);
        const cloakResp = await bot.exec("cloak", { enable: true });
        if (cloakResp.error) {
          const msg = cloakResp.error.message.toLowerCase();
          if (!msg.includes("already cloaked") && !msg.includes("already_cloaked")) {
            ctx.log("warn", `Failed to cloak before jump: ${cloakResp.error.message}`);
          }
        }
      }
    }

    // Jump with retry logic for transient errors
    let jumpSuccess = false;
    let retries = 0;
    let inBattleDuringJump = false;
    while (!jumpSuccess && retries < MAX_RETRIES_PER_JUMP && bot.state === "running") {
      retries++;
      // Call onBeforeJump callback before jumping (pre-jump setup that is
      // allowed to be far in advance of the jump, e.g. re-cloaking).
      if (opts.onBeforeJump) {
        await opts.onBeforeJump(nextSystem, attempt + 1);
      }
      // `onPreJump` runs *immediately* before the jump. For library-backed bots
      // that queue commands, the hook fires the time-sensitive mutation (e.g.
      // afterburner fuel, a ~3-tick speed buff) WITHOUT awaiting, and we then
      // issue `jump` straight away so BOTH mutations queue in the SAME server
      // tick. That makes the buff active when the jump resolves; awaiting
      // `use_item` first would push it a tick ahead and the buff would lapse
      // before the jump acts (unboosted transit).
      if (opts.onPreJump) {
        opts.onPreJump(nextSystem, attempt + 1);
      }
      ctx.log("travel", `Jumping to ${nextSystem} from ${bot.system}... (attempt ${retries}/${MAX_RETRIES_PER_JUMP})`);
      const jumpResp = await bot.exec("jump", { target_system: nextSystem });

      // Track if we handled a battle interrupt to avoid double error handling
      let battleInterruptHandled = false;

      // Check for battle notifications after jump
      if (jumpResp.notifications && Array.isArray(jumpResp.notifications)) {
        const battleNotifs = parseBattleNotifications(jumpResp.notifications);
        const hasBattle = battleNotifs.some(n => n.type === "battle_start" || n.type === "battle_hit");
        if (hasBattle) {
          // For combat bots that want to join battles (joinBattles=true), continue navigation
          // For other bots, flee on battle detection
          if (opts.joinBattles) {
            ctx.log("combat", "Battle detected during jump - combat bot joins battle - continuing navigation");
            inBattleDuringJump = true;
            battleInterruptHandled = true;
          } else {
            ctx.log("combat", "Battle detected during jump - initiating flee!");
            inBattleDuringJump = true;
            battleInterruptHandled = true;
            // Re-issue flee every cycle while in battle
            const fleeResp = await bot.exec("battle", { action: "stance", stance: "flee" });
            if (fleeResp.error) {
              ctx.log("error", `Flee command failed: ${fleeResp.error.message}`);
            }
            // Check if disengaged
            const battleStatus = await getBattleStatus(ctx);
            if (!battleStatus || !battleStatus.is_participant) {
              ctx.log("combat", "Battle cleared - continuing navigation");
              inBattleDuringJump = false;
            } else {
              // Still in battle - wait and continue to re-flee
              await sleep(2000);
              continue;
            }
          }
        }
      }

      // CRITICAL: Check for battle interrupt error (jump timed out due to battle)
      if (jumpResp.error && jumpResp.error.code === "battle_interrupt") {
        ctx.log("combat", `Battle interrupt detected! ${jumpResp.error.message}`);
        // For combat bots that want to join battles (joinBattles=true), join battle instead of flee
        // For other bots, flee on battle interrupt
        if (opts.joinBattles) {
          ctx.log("combat", "Combat bot detected battle interrupt - joining battle instead of fleeing");
          inBattleDuringJump = true;
          battleInterruptHandled = true;
          // Don't flee - let the combat routine handle battle engagement
          // Return false to signal navigation was interrupted by battle
          return false;
        } else {
          ctx.log("combat", "Initiating flee!");
          inBattleDuringJump = true;
          battleInterruptHandled = true;
          // Re-issue flee every cycle while in battle
          const fleeResp = await bot.exec("battle", { action: "stance", stance: "flee" });
          if (fleeResp.error) {
            ctx.log("error", `Flee command failed: ${fleeResp.error.message}`);
          }
          // Check if disengaged
          const battleStatus = await getBattleStatus(ctx);
          if (!battleStatus || !battleStatus.is_participant) {
            ctx.log("combat", "Battle cleared - continuing navigation");
            inBattleDuringJump = false;
            // Battle was cleared, but we still have an error - need to retry the jump
            // Fall through to error handling below
          } else {
            // Still in battle - wait and continue to re-flee
            await sleep(2000);
            continue;
          }
        }
      }

      if (!jumpResp.error) {
        jumpSuccess = true;
        break;
      }

      // If we handled battle interrupt and battle is now cleared, treat as transient and retry
      if (battleInterruptHandled && !inBattleDuringJump) {
        ctx.log("travel", "Battle interrupt handled and cleared - retrying jump");
        // Fall through to retry logic below
      }

      // Check for undefined/null error message (session loss indicator)
      if (!jumpResp.error.message || jumpResp.error.message === "undefined") {
        ctx.log("error", `Jump response has undefined/null error message - treating as session loss`);
        return false;
      }

      const errorMsg = jumpResp.error.message.toLowerCase();

      // Check for in_battle error - for escorts, this means they got pulled into a battle
      // Return false to signal navigation was interrupted by battle so escort routine can handle it
      if (errorMsg.includes("in_battle") || errorMsg.includes("in combat")) {
        ctx.log("combat", `Jump failed due to battle: ${jumpResp.error.message}`);
        if (opts.skipBlacklist) {
          ctx.log("combat", "Escort detected battle - returning to let escort routine handle engagement");
          return false;
        }
      }

      // Check if error is transient (network timeout, connection issue, etc.)
      // Note: battle_interrupt is handled separately above, so we don't include it here
      const isTransient =
        jumpResp.error.code === "timeout" || // Our custom timeout from execWithTimeout
        errorMsg.includes("timeout") ||
        errorMsg.includes("524") || // HTTP 524 Request Timeout
        errorMsg.includes("520") || // HTTP 520 Web Server Returned An Unknown Error (server-side issue)
        errorMsg.includes("502") || // HTTP 502 Bad Gateway (server-side issue)
        errorMsg.includes("bad gateway") ||
        errorMsg.includes("connection") ||
        errorMsg.includes("network") ||
        errorMsg.includes("hiccup") ||
        errorMsg.includes("temporarily") ||
        errorMsg.includes("try again") ||
        errorMsg.includes("pending") ||
        errorMsg.includes("busy") ||
        errorMsg.includes("systems are not connected") || // Sometimes a temporary state
        errorMsg.includes("you are already in") || // Already at destination - treat as success
        errorMsg.includes("mid-jump") || // Already in a jump - wait for it to complete
        errorMsg.includes("mid-travel") || // Already traveling - wait for it to complete
        errorMsg.includes("already in transit") || // Generic in-transit error
        isConnectionError(errorMsg); // Socket dropped (server restart / blip) - wait + retry, never permanent-fail

      if (!isTransient) {
        // Permanent error - don't retry
        ctx.log("error", `Jump failed (permanent error): ${jumpResp.error.message}`);
        return false;
      }

      // Handle "mid-jump" or "mid-travel" errors - wait for transit to complete
      if (errorMsg.includes("mid-jump") || errorMsg.includes("mid-travel") || errorMsg.includes("already in transit")) {
        ctx.log("travel", "Bot is already in transit - waiting for jump/travel to complete...");
        const transitCompleted = await waitForTransitCompletion(ctx, 180);
        if (!transitCompleted) {
          ctx.log("error", "Transit did not complete within timeout - cannot continue navigation");
          return false;
        }
        // Refresh location after transit completes
        await bot.refreshLocation();
        // Check if we're now at the target system
        if (normalizeSystemName(bot.system) === normalizeSystemName(targetSystemId)) {
          ctx.log("travel", `Arrived at ${targetSystemId} after transit completed`);
          return true;
        }
        // Transit completed but we're not at target - recalculate route from current position
        ctx.log("travel", `Transit completed at ${bot.system}, recalculating route to ${targetSystemId}...`);
        continue; // Continue the jump loop with updated position
      }

      // Special case: "already in" means we're already at the target system
      if (errorMsg.includes("you are already in")) {
        ctx.log("travel", `Server says already in system — refreshing location to verify position...`);
        await bot.refreshLocation();
        // Check if we're actually at the target system
        if (normalizeSystemName(bot.system) === normalizeSystemName(targetSystemId)) {
          ctx.log("travel", `Confirmed: already at target ${targetSystemId}`);
          return true;
        }
        // Not at target - the "already in" error was for a different system
        // Fall through to retry logic
      }

      ctx.log("error", `Jump failed (transient): ${jumpResp.error.message}`);
      
      if (retries < MAX_RETRIES_PER_JUMP) {
        // Wait before retrying - exponential backoff
        const waitTime = 5000 * retries; // 5s, 10s, 15s
        ctx.log("travel", `Waiting ${waitTime/1000}s before retry...`);
        await sleep(waitTime);

        // CRITICAL: Refresh location and recalculate route after wait
        await bot.refreshLocation();
        if (bot.system.toLowerCase() === targetSystemId.toLowerCase()) return true;

        // Recalculate route from CURRENT position (may have changed during wait, use blacklist)
        // For "systems not connected" errors, always do a full server re-query to avoid stale bad hops
        let retryRoute = mapStore.findRoute(bot.system, targetSystemId, blacklist);
        if (!retryRoute || retryRoute.length <= 1) {
          ctx.log("travel", `No mapped route after wait — querying server for fresh route to ${targetSystemId}`);
          const retryResp = await bot.exec("find_route", { target_system: targetSystemId });
          const retryData = retryResp.result as { found?: boolean; route?: Array<{ system_id: string; name: string }>; total_jumps?: number } | null;
          if (!retryResp.error && retryData?.found && retryData.route && retryData.route.length > 1) {
            const ids = retryData.route.map(r => r.system_id);
            const startsHere = ids[0] && normalizeSystemName(ids[0]) === normalizeSystemName(bot.system);
            if (startsHere) {
              retryRoute = ids;
              const full = ids.join(" → ");
              ctx.log("debug", `Fresh server route after wait for ${targetSystemId}: ${full}`);
            } else {
              ctx.log("warn", `Fresh server route after wait rejected — does not start at ${bot.system}`);
            }
          }
        }
        if (retryRoute && retryRoute.length > 1) {
          nextSystem = retryRoute[1];
          ctx.log("travel", `Route recalculated after wait: ${retryRoute.length - 1} jump${retryRoute.length - 1 !== 1 ? "s" : ""} remaining`);
        }
      }
    }
    
    if (!jumpSuccess) {
      ctx.log("error", `Jump to ${nextSystem} failed after ${MAX_RETRIES_PER_JUMP} retries`);
      return false;
    }

    await bot.refreshLocation();

    // Check for customs inspection after entering new system
    await checkCustomsInspection(ctx, nextSystem);

    // Check for battle status after jump (in case we jumped into an active battle)
    const battleStatus = await getBattleStatus(ctx);
    if (battleStatus && battleStatus.is_participant) {
      ctx.log("combat", `JUMPED INTO BATTLE! Battle ID: ${battleStatus.battle_id}`);
      // For hunters/escorts (isCombatBot=true), they fight - never flee when jumping into battle
      // isCombatBot indicates this is a hunter or escort that should always fight
      if (opts.isCombatBot) {
        ctx.log("combat", "COMBAT BOT: Intentionally entering battle - will fight, not flee!");
        return false;
      }
      await fleeFromBattle(ctx, true, 35000);
      return false; // Aborted navigation due to battle
    }

    // Check for pirates in the new system and flee if detected.
    // Cloaked ships cannot be ambushed, so (by default) a cloaked bot with
    // ignorePiratesWhenCloaked ignores pirates. Hunters (skipBlacklist)
    // intentionally enter pirate systems — do NOT flee.
    if (!opts.skipBlacklist && !(ignorePiratesWhenCloaked && bot.isCloaked)) {
      const nearbyResp = await bot.exec("get_nearby");
      if (nearbyResp.result && typeof nearbyResp.result === "object") {
        bot.trackWildlife(nearbyResp.result);
        const fled = await checkAndFleeFromPirates(ctx, nearbyResp.result, true);
        if (fled) {
          // We fled - navigation is aborted, caller will need to handle new position
          return false;
        }
      }
    }

    // Update map data for the new system
    const sysResp = await bot.exec("get_system");
    if (sysResp.result && typeof sysResp.result === "object") {
      parseSystemData(sysResp.result as Record<string, unknown>);
    }

    // Auto-cloak in dangerous systems
    if (opts.autoCloak) {
      await autoCloakIfDangerous(ctx);
    }

    // Call onJump validation callback (e.g., mid-route trade validation)
    if (opts.onJump) {
      const shouldContinue = await opts.onJump(attempt + 1);
      if (!shouldContinue) return false;
    }

    ctx.log("travel", `Arrived in ${bot.system}`);
    if (bot.system.toLowerCase() === targetSystemId.toLowerCase()) {
      await sleep(1000);
      await bot.refreshLocation();
      return true;
    }
    if (bot.state !== "running") return false;
  }

  ctx.log("error", `Failed to reach ${targetSystemId} after ${MAX_JUMPS} jumps`);
  return false;
}

/** Refuel at a specific station POI if fuel is below threshold. Handles travel/dock/undock.
 *  Returns true if successfully refueled, false if stranded.
 *  @param opts.skipApprovedCheck If true, bypass the approved fuel station check. */
export async function refuelAtStation(
  ctx: RoutineContext,
  station: { id: string; name: string },
  thresholdPct: number,
  opts?: { skipApprovedCheck?: boolean },
): Promise<boolean> {
  const { bot } = ctx;
  await bot.refreshLocation();

  if (!opts?.skipApprovedCheck && !isApprovedFuelStation(station.id, readSettings(), bot.system)) {
    ctx.log("system", `Refuel skipped at ${station.name} — not on approved fuel list`);
    return false;
  }

  const fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
  if (fuelPct >= thresholdPct) return true;

  ctx.log("system", `Fuel low (${fuelPct}%) — refueling at ${station.name}...`);

  if (bot.poi !== station.id) {
    ctx.log("travel", `Traveling to ${station.name} for fuel...`);
    const travelResp = await bot.exec("travel", { target_poi: station.id });
    if (travelResp.error) {
      const msg = travelResp.error.message.toLowerCase();
      if (msg.includes("fuel") || msg.includes("no_fuel")) {
        ctx.log("error", `Can't travel to station — no fuel!`);
        return await emergencyFuelRecovery(ctx);
      }
      ctx.log("error", `Travel to station failed: ${travelResp.error.message}`);
      return false;
    }
    bot.poi = station.id;
  }

  if (!bot.docked) {
    const dockResp = await bot.exec("dock");
    if (dockResp.error && !dockResp.error.message.includes("already")) {
      ctx.log("error", `Dock failed: ${dockResp.error.message}`);
      return await emergencyFuelRecovery(ctx);
    }
    bot.docked = true;
    await ensureInsured(ctx);
    // Parse fuel_warning from dock response (e.g. "Fuel reserves critically low (0%)")
    // Sol Central is always assumed to have fuel (faction station with guaranteed supply)
    const isSolCentral = station.id === "sol_station" || station.id === "sol_central";
    const warning = (dockResp as any)?.fuel_warning || "";
    if (!isSolCentral && (warning.toLowerCase().includes("0%") || warning.toLowerCase().includes("critically low"))) {
      ctx.log("error", `Station reports 0 fuel on dock — aborting refuel here`);
      return false;
    }
  }

  // Collect any gifted credits/items (may help pay for fuel)
  await collectFromStorage(ctx);

  await tryRefuel(ctx);

  // Verify refuel actually worked — do NOT undock if fuel is dangerously low
  await bot.refreshShip();
  let newFuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
  if (newFuelPct < thresholdPct) {
    ctx.log("system", `Fuel still at ${newFuelPct}% after refuel — waiting at ${station.name}...`);
    for (let w = 0; w < REFUEL_WAIT_RETRIES && bot.state === "running"; w++) {
      await sleep(REFUEL_WAIT_INTERVAL);
      await bot.refreshShip();
      const refuelResp = await bot.exec("refuel");
      if (refuelResp.error) {
        const msg = refuelResp.error.message.toLowerCase();
        const isSolCentralRetry = station.id === "sol_station" || station.id === "sol_central";
        if (!isSolCentralRetry && (msg.includes("no_fuel_cells") || msg.includes("no fuel cells") || msg.includes("station_fuel_empty") || msg.includes("station's fuel reserves"))) {
          ctx.log("error", `Cannot refuel: ${msg.includes("station") ? "station out of fuel" : "no fuel cells available"} — will not retry infinitely`);
          break;
        }
      }
      await bot.refreshShip();
      newFuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
      if (newFuelPct >= thresholdPct) {
        ctx.log("system", `Fuel recovered to ${newFuelPct}% — resuming`);
        break;
      }
      ctx.log("system", `Still waiting for fuel (${newFuelPct}%)... (${w + 1}/${REFUEL_WAIT_RETRIES})`);
    }
  }

  await bot.refreshShip();
  newFuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
  if (newFuelPct < thresholdPct) {
    ctx.log("error", `Could not refuel at ${station.name} — fuel still at ${newFuelPct}% (threshold: ${thresholdPct}%)`);
    return false;
  }

  ctx.log("system", "Undocking...");
  await bot.exec("undock");
  bot.docked = false;
  return true;
}

// ── Security ─────────────────────────────────────────────────

/** Try to fetch security level from get_location and update mapStore. */
export async function fetchSecurityLevel(ctx: RoutineContext, systemId: string): Promise<void> {
  const { bot } = ctx;
  const locResp = await bot.exec("get_location");
  if (!locResp.result || typeof locResp.result !== "object") return;

  const loc = locResp.result as Record<string, unknown>;
  const locSys = loc.system as Record<string, unknown> | undefined;
  const secLevel = (locSys?.security_level as string) || (locSys?.security_status as string)
    || (locSys?.lawfulness as string) || (locSys?.security as string)
    || (loc.security_level as string) || (loc.security_status as string)
    || (loc.security as string);

  if (secLevel) {
    const stored = mapStore.getSystem(systemId);
    if (stored && !stored.security_level) {
      mapStore.updateSystem({ id: systemId, security_level: secLevel } as Record<string, unknown>);
      ctx.log("info", `Security level for ${systemId}: ${secLevel}`);
    }
  }
}

// ── Scavenging ──────────────────────────────────────────────

/** Items worth looting from wrecks (prioritize fuel cells). */
const LOOT_PRIORITY = ["fuel_cell", "fuel", "energy_cell"];

interface WreckItem {
  item_id: string;
  name: string;
  quantity: number;
}

interface WreckModule {
  id: string;
  type_id: string;
  name: string;
  type: string;
}

interface Wreck {
  wreck_id: string;
  name: string;
  items: WreckItem[];
  modules: WreckModule[];
}

/** Parse wreck list from get_wrecks response. */
export function parseWrecks(result: unknown): Wreck[] {
  if (!result || typeof result !== "object") return [];
  const r = result as Record<string, unknown>;
  const rawList = (
    Array.isArray(r) ? r :
    Array.isArray(r.wrecks) ? r.wrecks :
    Array.isArray(r.containers) ? r.containers :
    []
  ) as Array<Record<string, unknown>>;

  return rawList.map(w => {
    const rawItems = (
      Array.isArray(w.items) ? w.items :
      Array.isArray(w.cargo) ? w.cargo :
      Array.isArray(w.contents) ? w.contents :
      []
    ) as Array<Record<string, unknown>>;

    // Parse modules array
    const rawModules = (
      Array.isArray(w.modules) ? w.modules :
      []
    ) as Array<Record<string, unknown>>;

    return {
      wreck_id: (w.wreck_id as string) || (w.id as string) || "",
      name: (w.name as string) || (w.type as string) || "wreck",
      items: rawItems.map(i => ({
        item_id: (i.item_id as string) || (i.id as string) || "",
        name: (i.name as string) || (i.item_id as string) || "",
        quantity: (i.quantity as number) || 1,
      })).filter(i => i.item_id),
      modules: rawModules.map(m => ({
        id: (m.id as string) || "",
        type_id: (m.type_id as string) || "",
        name: (m.name as string) || "",
        type: (m.type as string) || "",
      })).filter(m => m.id),
    };
  }).filter(w => w.wreck_id);
}

/**
 * Check for wrecks/containers at current POI and loot useful items.
 * Prioritizes fuel cells, then loots everything if cargo space allows.
 * Returns number of items looted.
 */
function shuffleArray<T>(arr: T[]): T[] {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export async function scavengeWrecks(ctx: RoutineContext, opts?: { fuelOnly?: boolean }): Promise<number> {
  const { bot } = ctx;
  if (bot.docked) return 0; // can't scavenge while docked

  // CRITICAL: Don't scavenge if we're in battle. The cached WebSocket battle
  // flag can stay set after a won fight (no battle_end push), so confirm
  // against the API before skipping — otherwise loot is left behind.
  if (bot.isInBattle()) {
    const liveStatus = await getBattleStatus(ctx);
    if (liveStatus) {
      ctx.log("combat", `Not scavenging while in battle`);
      return 0;
    }
    ctx.log("combat", `Clearing stale battle state (API reports no battle) before scavenging`);
    bot.currentBattle.inBattle = false;
    bot.currentBattle.battleId = null;
    bot.currentBattle.participants = [];
  }

  // Skip if cargo is already full or nearly full (less than 5 free)
  await bot.refreshCargo();
  if (bot.cargoMax > 0 && bot.cargoMax - bot.cargo < 5) return 0;

  const fuelOnly = opts?.fuelOnly ?? false;

  const wrecksResp = await bot.exec("get_wrecks");
  const wrecks = parseWrecks(wrecksResp.result);
  if (wrecks.length === 0) return 0;

  let totalLooted = 0;
  const lootedItems: string[] = [];

  for (const wreck of shuffleArray(wrecks)) {
    if (bot.state !== "running") break;

    // Check cargo space
    await bot.refreshCargo();
    if (bot.cargoMax > 0 && bot.cargo >= bot.cargoMax) {
      ctx.log("scavenge", "Cargo full — stopping scavenge");
      break;
    }

    if (wreck.items.length === 0) {
      continue;
    }

    // Filter to fuel items only when fuelOnly is set
    let candidates = [...wreck.items];
    if (fuelOnly) {
      candidates = candidates.filter(i =>
        LOOT_PRIORITY.some(p => i.item_id.toLowerCase().includes(p))
      );
      if (candidates.length === 0) continue;
    }

    // Randomize item order to reduce cross-bot collisions, then sort: fuel cells first, then everything else
    candidates = shuffleArray(candidates);
    candidates.sort((a, b) => {
      const aPri = LOOT_PRIORITY.some(p => a.item_id.includes(p)) ? 0 : 1;
      const bPri = LOOT_PRIORITY.some(p => b.item_id.includes(p)) ? 0 : 1;
      return aPri - bPri;
    });

    // Track what we loot from this specific wreck
    const wreckLoot: string[] = [];

    for (const item of candidates) {
      if (bot.state !== "running") break;
      if (bot.cargoMax > 0 && bot.cargo >= bot.cargoMax) break;

      const lootResp = await bot.exec("loot_wreck", {
        wreck_id: wreck.wreck_id,
        item_id: item.item_id,
        quantity: item.quantity,
      });

      if (lootResp.error) {
        const errMsg = lootResp.error.message.toLowerCase();
        // CRITICAL: Check for battle interrupt - stop scavenging immediately
        if (lootResp.error.code === "battle_interrupt" || errMsg.includes("interrupted by battle") || errMsg.includes("interrupted by combat") || errMsg.includes("in_battle") || errMsg.includes("cannot perform this action while in combat")) {
          ctx.log("combat", `Loot interrupted by battle! ${lootResp.error.message} - stopping salvage!`);
          return totalLooted;
        }
        if (errMsg.includes("no_space") || errMsg.includes("not enough cargo") || errMsg.includes("cargo space")) {
          break; // cargo full — stop looting this wreck
        }
        if (errMsg.includes("empty") || errMsg.includes("not found") || errMsg.includes("not in wreck")) {
          break; // wreck gone or empty
        }
        continue;
      }

      totalLooted++;
      lootedItems.push(`${item.quantity}x ${item.name}`);
      wreckLoot.push(`${item.quantity}x ${item.name}`);
    }

    // Log what we got from this wreck
    if (wreckLoot.length > 0) {
      ctx.log("scavenge", `Wreck ${wreck.wreck_id.substring(0, 8)}...: ${wreckLoot.join(", ")}`);
    }
  }

  if (totalLooted > 0) {
    await bot.refreshCargo();
    ctx.log("scavenge", `Scavenged ${lootedItems.join(", ")} from ${wrecks.length} wreck(s)`);
  }

  return totalLooted;
}

/**
 * Full wreck salvage chain using the new tow-based system:
 * 1. Loot cargo from wrecks in the field (loot_wreck)
 * 2. Tow the wreck (tow_wreck) - attaches to ship, 50% speed penalty
 * 3. Travel to salvage yard station with the towed wreck
 * 4. Sell wreck (sell_wreck) for credits + salvaging XP, or scrap (scrap_wreck) for materials at lvl 2+
 *
 * Returns { itemsLooted, isTowing }. Towed wrecks are processed at salvage yard.
 */
export async function fullSalvageWrecks(
  ctx: RoutineContext,
  opts?: {
    fuelOnly?: boolean;
    enableTow?: boolean;
    minTowValue?: number;
    battleState?: BattleState;
    salvageCoop?: {
      isWreckAvailable?: (wreckId: string) => boolean;
      claimWreck?: (wreckId: string, action: "loot" | "tow") => void;
    };
  },
): Promise<{ itemsLooted: number; isTowing: boolean }> {
  const { bot } = ctx;
  if (bot.docked) return { itemsLooted: 0, isTowing: false };

  const enableTow = opts?.enableTow ?? false;
  const minTowValue = opts?.minTowValue ?? 0;
  const fuelOnly = opts?.fuelOnly ?? false;
  const battleState = opts?.battleState;
  const coop = opts?.salvageCoop;

  const wrecksResp = await bot.exec("get_wrecks");
  const wrecks = parseWrecks(wrecksResp.result);
  if (wrecks.length > 0) {
    ctx.log("scavenge", `get_wrecks found ${wrecks.length} wreck(s)`);
  }
  if (wrecks.length === 0) return { itemsLooted: 0, isTowing: bot.towingWreck };

  let totalLooted = 0;
  const lootedItems: string[] = [];
  const towedWrecks: { wreck_id: string; name: string; salvage_value: number }[] = [];

  for (const wreck of shuffleArray(wrecks)) {
    if (bot.state !== "running") break;

    await bot.refreshCargo();
    if (bot.cargoMax > 0 && bot.cargo >= bot.cargoMax) {
      ctx.log("scavenge", "Cargo full — stopping salvage");
      break;
    }

    // Chat-based co-op: skip if another salvager already claimed this wreck
    if (coop?.isWreckAvailable && !coop.isWreckAvailable(wreck.wreck_id)) {
      ctx.log("scavenge", `Wreck ${wreck.name} claimed by another salvager — skipping`);
      continue;
    }
    if (coop?.claimWreck) {
      coop.claimWreck(wreck.wreck_id, "loot");
    }

    if (wreck.items.length > 0) {
      let candidates = [...wreck.items];
      if (fuelOnly) {
        candidates = candidates.filter(i =>
          LOOT_PRIORITY.some(p => i.item_id.toLowerCase().includes(p))
        );
      }

      candidates = shuffleArray(candidates);
      candidates.sort((a, b) => {
        const aPri = LOOT_PRIORITY.some(p => a.item_id.includes(p)) ? 0 : 1;
        const bPri = LOOT_PRIORITY.some(p => b.item_id.includes(p)) ? 0 : 1;
        return aPri - bPri;
      });

      let remainingOnWreck = wreck.items.reduce((sum, it) => sum + (it.quantity || 0), 0);

      for (const item of candidates) {
        if (bot.state !== "running") break;
        if (bot.cargoMax > 0 && bot.cargo >= bot.cargoMax) break;
        if (remainingOnWreck <= 1) break;

        let qty = item.quantity;
        const maxSafe = remainingOnWreck - 1;
        if (qty > maxSafe) qty = maxSafe;
        if (qty <= 0) continue;

        const lootResp = await bot.exec("loot_wreck", {
          wreck_id: wreck.wreck_id,
          item_id: item.item_id,
          quantity: qty,
        });

        if (battleState && lootResp.notifications && Array.isArray(lootResp.notifications)) {
          const battleDetected = await handleBattleNotifications(ctx, lootResp.notifications, battleState);
          if (battleDetected) {
            ctx.log("combat", "Battle detected while looting wreck - initiating flee!");
            battleState.isFleeing = false;
          }
        }

        if (lootResp.error) {
          const msg = lootResp.error.message.toLowerCase();
          if (lootResp.error.code === "battle_interrupt" || msg.includes("interrupted by battle") || msg.includes("interrupted by combat")) {
            ctx.log("combat", `Loot interrupted by battle! ${lootResp.error.message} - stopping salvage!`);
            return { itemsLooted: totalLooted, isTowing: bot.towingWreck };
          }
          if (msg.includes("empty") || msg.includes("not found")) break;
          continue;
        }

        totalLooted++;
        lootedItems.push(`${qty}x ${item.name}`);
        remainingOnWreck -= qty;
      }
    }

    // Step 2: Optionally tow high-value wrecks
    if (enableTow) {
      // Skip jettison wrecks - they cannot be towed
      if (wreck.name === "jettison") {
        ctx.log("scavenge", `Skipping tow attempt for jettison wreck ${wreck.wreck_id} (${wreck.name}) - jettison wrecks cannot be towed`);
        continue;
      }

      // Check if we already have a tow attached
      await bot.refreshLocation();
      if (bot.towingWreck) {
        ctx.log("scavenge", "Already towing a wreck — stopping salvage and heading to salvage yard");
        break; // Exit the wrecks loop entirely
      }

      ctx.log("scavenge", `Attempting to tow wreck ${wreck.wreck_id} (${wreck.name})`);
      if (coop?.claimWreck) {
        coop.claimWreck(wreck.wreck_id, "tow");
      }
      const towResp = await bot.exec("tow_wreck", { wreck_id: wreck.wreck_id });
      // Check for battle notifications after tow
      if (battleState && towResp.notifications && Array.isArray(towResp.notifications)) {
        const battleDetected = await handleBattleNotifications(ctx, towResp.notifications, battleState);
        if (battleDetected) {
          ctx.log("combat", "Battle detected while towing wreck - initiating flee!");
          battleState.isFleeing = false;
        }
      }
      if (!towResp.error && towResp.result) {
        const tr = towResp.result as Record<string, unknown>;
        ctx.log("debug", `tow_wreck response: ${JSON.stringify(tr)}`);
        const salvageValue = (tr.salvage_value as number) || 0;
        const shipClass = (tr.ship_class as string) || "unknown";
        ctx.log("scavenge", `tow_wreck successful for ${wreck.name} (${shipClass}, value: ${salvageValue}cr)`);

        if (salvageValue >= minTowValue) {
          // Log modules from the wreck's modules array
          const moduleCount = wreck.modules.length;
          
          if (moduleCount > 0) {
            const moduleList = wreck.modules.map(m => {
              const name = m.name || m.type || m.type_id || m.id;
              return name;
            }).join(", ");
            ctx.log("scavenge", `📦 Wreck contains ${moduleCount} module(s): ${moduleList}`);
          } else {
            ctx.log("scavenge", `📦 Wreck contains no modules`);
          }

          towedWrecks.push({
            wreck_id: wreck.wreck_id,
            name: wreck.name,
            salvage_value: salvageValue,
          });
          ctx.log("scavenge", `Towed ${shipClass} wreck (${wreck.name}) - value: ${salvageValue}cr, speed penalty: 50%`);
          // Set towing flag immediately - server confirms tow in the response
          bot.towingWreck = true;
          bot.towingWreckId = wreck.wreck_id;
          ctx.log("scavenge", `Set bot.towingWreck=true after successful tow`);
          break;
        } else {
          ctx.log("scavenge", `tow_wreck successful but skipped towing ${wreck.name} - value ${salvageValue}cr below threshold ${minTowValue}cr`);
        }
      } else if (towResp.error) {
        const msg = towResp.error.message.toLowerCase();
        // CRITICAL: Check for battle interrupt - stop scavenging immediately
        if (towResp.error.code === "battle_interrupt" || msg.includes("interrupted by battle") || msg.includes("interrupted by combat")) {
          ctx.log("combat", `Tow interrupted by battle! ${towResp.error.message} - stopping salvage!`);
          return { itemsLooted: totalLooted, isTowing: bot.towingWreck };
        }
        if (msg.includes("already")) {
          // Check if it's "already_towing" (we're towing) vs "already_towed" (someone else has it)
          if (msg.includes("already_towing") || msg.includes("already towing")) {
            // We are already towing - this is a signal to head to salvage yard
            ctx.log("warn", `Already towing a wreck — should head to salvage yard (${towResp.error.message})`);
            bot.towingWreck = true;
            // Preserve existing towingWreckId
            break; // Stop scanning and go to salvage yard
          } else {
            // Someone else is towing this wreck - skip it and try another
            ctx.log("scavenge", `Wreck already being towed by another player — skipping (${towResp.error.message})`);
            continue; // Try the next wreck
          }
        } else {
          ctx.log("scavenge", `tow_wreck failed for ${wreck.name}: ${towResp.error.message}`);
        }
      }
    }
  }

  if (totalLooted > 0) {
    await bot.refreshCargo();
    ctx.log("scavenge", `Looted ${lootedItems.join(", ")} from ${wrecks.length} wreck(s)`);
  }

if (towedWrecks.length > 0) {
     ctx.log("scavenge", `Towing ${towedWrecks.length} wreck(s) to salvage yard: ${towedWrecks.map(w => w.name).join(", ")}`);
   }

   ctx.log("debug", `fullSalvageWrecks returning: itemsLooted=${totalLooted}, towedWrecks=${towedWrecks.length}, bot.towingWreck=${bot.towingWreck}`);
   return { itemsLooted: totalLooted, isTowing: bot.towingWreck };
}

/**
 * Process towed wrecks at a salvage yard station.
 * - First, loot any modules from the towed wreck
 * - If salvaging skill < 2: sell_wreck for credits + XP
 * - If salvaging skill >= 2: scrap_wreck for materials (or sell if preferred)
 *
 * Must be docked at a station with salvage_yard service.
 * Returns number of wrecks processed.
 */
export async function processTowedWrecks(
  ctx: RoutineContext,
  opts?: { preferScrap: boolean },
): Promise<number> {
  const { bot } = ctx;
  if (!bot.docked) {
    ctx.log("error", "Must be docked to process towed wrecks");
    return 0;
  }

  const preferScrap = opts?.preferScrap ?? false;

  // Check if we're towing a wreck
  await bot.refreshLocation();
  if (!bot.towingWreck) {
    return 0; // No towed wreck to process
  }

  // Check station has salvage yard
  const { pois } = await getSystemInfo(ctx);
  const currentStation = pois.find(p => isStationPoi(p) && p.id === bot.poi);
  if (currentStation?.services && currentStation.services.salvage_yard === false) {
    ctx.log("error", "This station does not have a salvage yard - cannot process wrecks");
    return 0;
  }

  // Step 1: Loot modules from the towed wreck before selling/scrapping
  ctx.log("scavenge", "Checking towed wreck for lootable modules...");
  const wrecksResp = await bot.exec("get_wrecks");
  const wrecks = parseWrecks(wrecksResp.result);

  // Find the specific towed wreck by ID
  const towedWreck = bot.towingWreckId ? wrecks.find(w => w.wreck_id === bot.towingWreckId) : wrecks[0];
  if (!towedWreck) {
    ctx.log("warn", "Towed wreck not found in get_wrecks response - may have been jettisoned or lost");
    bot.towingWreck = false;
    bot.towingWreckId = null;
    return 0;
  }

  // Check modules array (not items)
  let modulesLooted = 0;
  if (towedWreck.modules.length === 0) {
    ctx.log("scavenge", "📦 Towed wreck has no modules to loot");
  } else {
    ctx.log("scavenge", `📦 Towed wreck ${towedWreck.name} contains ${towedWreck.modules.length} module(s): ${towedWreck.modules.map(m => m.name || m.type || m.type_id || m.id).join(", ")}`);

    // Loot ALL modules and cargo from the wreck (no item_id specified = loots everything to cargo hold)
    // Check cargo space first
    await bot.refreshCargo();
    const moduleCargoCost = towedWreck.modules.length * 10; // Typical module size is 10 each
    if (bot.cargoMax > 0 && (bot.cargo + moduleCargoCost) > bot.cargoMax) {
      ctx.log("scavenge", `Cargo full while looting modules (${bot.cargo}/${bot.cargoMax}) — depositing items to make space...`);

      // We're already docked, so deposit all non-fuel items from inventory
      await bot.refreshCargo();
      let deposited = false;
      for (const cargoItem of bot.inventory) {
        const lower = cargoItem.itemId.toLowerCase();
        if (!lower.includes("fuel") && !lower.includes("energy_cell") && cargoItem.quantity > 0) {
          const depositResp = await bot.exec("deposit_items", { item_id: cargoItem.itemId, quantity: cargoItem.quantity });
          if (!depositResp.error) {
            ctx.log("scavenge", `Deposited ${cargoItem.quantity}x ${cargoItem.name} to storage`);
            deposited = true;
          }
        }
      }

      if (!deposited) {
        ctx.log("warn", "No items to deposit — cannot make space for modules");
      } else {
        // Re-check cargo after deposit
        await bot.refreshCargo();
        if (bot.cargoMax > 0 && (bot.cargo + moduleCargoCost) > bot.cargoMax) {
          ctx.log("warn", "Still no cargo space after deposit — skipping module loot");
        }
      }
    }

    if (bot.cargoMax > 0 && (bot.cargo + moduleCargoCost) <= bot.cargoMax) {
      // Loot ALL modules and cargo from wreck (no item_id = loots everything)
      const lootResp = await bot.exec("loot_wreck", {
        wreck_id: towedWreck.wreck_id,
      });

      if (lootResp.error) {
        const msg = lootResp.error.message.toLowerCase();
        // CRITICAL: Check for battle interrupt - stop immediately
        if (lootResp.error.code === "battle_interrupt" || msg.includes("interrupted by battle") || msg.includes("interrupted by combat")) {
          ctx.log("combat", `Module loot interrupted by battle! ${lootResp.error.message} - stopping!`);
          return 0;
        }
        // Handle wreck_gone during initial loot attempt
        if (msg.includes("wreck_gone") || msg.includes("empty") || msg.includes("not found")) {
          ctx.log("warn", "Wreck no longer exists during initial loot — releasing tow");
          await bot.exec("release_tow");
          bot.towingWreck = false;
          bot.towingWreckId = null;
          return 0;
        }
        if (msg.includes("no_space") || msg.includes("not enough cargo")) {
          ctx.log("scavenge", "Still no cargo space — depositing ALL current items and retrying...");
          // Deposit all non-fuel items to make space
          await bot.refreshCargo();
          for (const cargoItem of bot.inventory) {
            const lower = cargoItem.itemId.toLowerCase();
            if (!lower.includes("fuel") && !lower.includes("energy_cell") && cargoItem.quantity > 0) {
              await bot.exec("deposit_items", { item_id: cargoItem.itemId, quantity: cargoItem.quantity });
            }
          }
          // Retry looting everything
          const retryResp = await bot.exec("loot_wreck", {
            wreck_id: towedWreck.wreck_id,
          });
          if (!retryResp.error) {
            modulesLooted = towedWreck.modules.length;
            ctx.log("scavenge", `✓ Looted all modules from wreck`);
          } else {
            const retryMsg = retryResp.error.message.toLowerCase();
            // Check for battle interrupt on retry as well
            if (retryResp.error.code === "battle_interrupt" || retryMsg.includes("interrupted by battle") || retryMsg.includes("interrupted by combat")) {
              ctx.log("combat", `Module loot retry interrupted by battle! ${retryResp.error.message} - stopping!`);
              return 0;
            }
            ctx.log("error", `Failed to loot modules after deposit: ${retryResp.error.message}`);
          }
        } else {
          ctx.log("error", `Failed to loot modules: ${lootResp.error.message}`);
        }
      } else {
        modulesLooted = towedWreck.modules.length;
        ctx.log("scavenge", `✓ Looted all modules from wreck`);
      }
    }
  }

  if (modulesLooted > 0) {
    ctx.log("scavenge", `✅ Successfully looted ${modulesLooted} module(s) from towed wreck`);
  }

  // Step 2: Check salvaging skill level
  await bot.checkSkills();
  const salvagingLevel = bot.getSkillLevel("salvaging");
  const canScrap = salvagingLevel >= 2;

  ctx.log("debug", `Salvaging skill level: ${salvagingLevel}, canScrap: ${canScrap}, preferScrap: ${preferScrap}`);

  let processed = 0;
  const MAX_SALVAGE_RETRIES = 3;

  // Try to scrap if preferred and skill allows, with retries
  if (preferScrap && canScrap) {
    let scrapSuccess = false;

    for (let attempt = 1; attempt <= MAX_SALVAGE_RETRIES; attempt++) {
      ctx.log("scavenge", `🔄 Scrap attempt ${attempt}/${MAX_SALVAGE_RETRIES}...`);
      const scrapResp = await bot.exec("scrap_wreck");

      // V2 API returns command result in 'details' field, not 'result'
      const scrapDetails = (scrapResp.details as Record<string, unknown>) || (scrapResp.result as Record<string, unknown>);
      if (!scrapResp.error && scrapDetails) {
        // Scrap response uses 'materials' field
        const materials = (scrapDetails.materials as Array<Record<string, unknown>>) || [];
        const totalValue = (scrapDetails.total_value as number) || 0;
        const message = (scrapDetails.message as string) || "";

        if (materials.length > 0) {
          const names = materials.map(m => `${(m.quantity as number) || 1}x ${(m.name as string) || "material"}`).join(", ");
          ctx.log("scavenge", `✅ Scrapped wreck for: ${names} (total value: ${totalValue}cr)`);
          if (message) ctx.log("scavenge", `   ${message}`);
          processed++;
          scrapSuccess = true;
          break; // Success - exit retry loop
        } else {
          ctx.log("warn", `Scrap attempt ${attempt} returned no materials — retrying...`);
        }
      } else if (scrapResp.error) {
        const errMsg = scrapResp.error.message.toLowerCase();
        if (errMsg.includes("not_towing")) {
          ctx.log("warn", `Server says not towing during scrap (attempt ${attempt}) — clearing tow flag`);
          bot.towingWreck = false;
          bot.towingWreckId = null;
          break;
        } else if (errMsg.includes("wreck_gone")) {
          ctx.log("warn", `Wreck no longer exists during scrap (attempt ${attempt}) — releasing tow`);
          await bot.exec("release_tow");
          bot.towingWreck = false;
          bot.towingWreckId = null;
          break;
        } else {
          ctx.log("error", `Scrap attempt ${attempt} failed: ${scrapResp.error.message}`);
        }
      }

      // Wait briefly before retry (give server time to process)
      if (attempt < MAX_SALVAGE_RETRIES) {
        await sleep(2000);
      }
    }

    if (!scrapSuccess && bot.towingWreck) {
      ctx.log("warn", `All ${MAX_SALVAGE_RETRIES} scrap attempts failed — falling back to sell`);
    }
  }

  // If scrap failed or not preferred, sell the wreck (also with retries)
  if (processed === 0 && bot.towingWreck) {
    let sellSuccess = false;

    for (let attempt = 1; attempt <= MAX_SALVAGE_RETRIES; attempt++) {
      ctx.log("scavenge", `💰 Sell attempt ${attempt}/${MAX_SALVAGE_RETRIES}...`);
      const sellResp = await bot.exec("sell_wreck");

      // V2 API returns command result in 'details' field, not 'result'
      const sellDetails = (sellResp.details as Record<string, unknown>) || (sellResp.result as Record<string, unknown>);
      if (!sellResp.error && sellDetails) {
        // SellWreckResponse uses total_payout, cargo_value, salvage_value
        const totalPayout = (sellDetails.total_payout as number) || 0;
        const cargoValue = (sellDetails.cargo_value as number) || 0;
        const salvageValue = (sellDetails.salvage_value as number) || 0;
        const message = (sellDetails.message as string) || "";

        if (totalPayout > 0) {
          ctx.log("scavenge", `✅ Sold wreck for ${totalPayout}cr (cargo: ${cargoValue}, salvage: ${salvageValue})${message ? ` — ${message}` : ""}`);
          processed++;
          sellSuccess = true;
          break; // Success - exit retry loop
        } else {
          ctx.log("warn", `Sell attempt ${attempt} returned no payout (${totalPayout}) — retrying...`);
        }
      } else if (sellResp.error) {
        const errMsg = sellResp.error.message.toLowerCase();
        if (errMsg.includes("not_towing")) {
          ctx.log("warn", `Server says not towing during sell (attempt ${attempt}) — clearing tow flag`);
          bot.towingWreck = false;
          bot.towingWreckId = null;
          break;
        } else if (errMsg.includes("wreck_gone")) {
          ctx.log("warn", `Wreck no longer exists during sell (attempt ${attempt}) — releasing tow`);
          await bot.exec("release_tow");
          bot.towingWreck = false;
          bot.towingWreckId = null;
          break;
        } else {
          ctx.log("error", `Sell attempt ${attempt} failed: ${sellResp.error.message}`);
        }
      }

      // Wait briefly before retry (give server time to process)
      if (attempt < MAX_SALVAGE_RETRIES) {
        await sleep(2000);
      }
    }

    if (!sellSuccess && bot.towingWreck) {
      ctx.log("error", `All ${MAX_SALVAGE_RETRIES} sell attempts failed — wreck may be lost`);
    }
  }

  // Reset towing flag after successful processing
  if (processed > 0) {
    ctx.log("scavenge", `Successfully processed wreck (processed=${processed}) — clearing tow flag`);
    bot.towingWreck = false;
    bot.towingWreckId = null;
  }

  await bot.refreshLocation();
  return processed;
}

// ── Role-Based Mods ──────────────────────────────────────────

/**
 * Get the desired mod profile for a routine from settings.
 * Returns [] if autoFitMods is disabled or no profile configured.
 */
export function getModProfile(routineName: string): string[] {
  const all = readSettings();
  if ((all.general?.autoFitMods as boolean) === false) return [];
  const profiles = (all.general?.modProfiles as Record<string, string[]>) || {};
  return Array.isArray(profiles[routineName]) ? profiles[routineName] : [];
}

/**
 * Ensure the bot's ship has the desired mods installed.
 * Uninstalls unwanted mods and installs missing ones.
 * Requires docked at a station with shipyard service.
 */
export async function ensureModsFitted(
  ctx: RoutineContext,
  desiredMods: string[],
): Promise<void> {
  const { bot } = ctx;
  if (!bot.docked || desiredMods.length === 0) return;

  // Check if current station has shipyard
  const { pois } = await getSystemInfo(ctx);
  const currentStation = pois.find(p => isStationPoi(p) && p.id === bot.poi);
  if (currentStation && !stationHasService(currentStation, "shipyard")) return;

  const installed = await bot.refreshShipMods();
  const desiredSet = new Set(desiredMods);
  const installedSet = new Set(installed);

  // Uninstall mods not in the desired set
  for (const mod of installed) {
    if (!desiredSet.has(mod)) {
      const resp = await bot.exec("uninstall_mod", { mod_id: mod });
      if (!resp.error) {
        ctx.log("system", `Uninstalled mod: ${mod}`);
      }
    }
  }

  // Install missing desired mods
  for (const mod of desiredMods) {
    if (!installedSet.has(mod)) {
      const resp = await bot.exec("install_mod", { mod_id: mod });
      if (!resp.error) {
        ctx.log("system", `Installed mod: ${mod}`);
      } else {
        const msg = resp.error.message.toLowerCase();
        if (!msg.includes("already") && !msg.includes("not found") && !msg.includes("no slot")) {
          ctx.log("error", `Failed to install mod ${mod}: ${resp.error.message}`);
        }
      }
    }
  }
}

// ── Cloaking ─────────────────────────────────────────────────

/** Check if a system's security level is dangerous (low-sec, null-sec, lawless, etc.). */
export function isDangerousSystem(securityLevel: string | undefined): boolean {
  if (!securityLevel) return false;
  const level = securityLevel.toLowerCase().trim();

  if (level.includes("low") || level === "null" || level.includes("unregulated") ||
      level.includes("lawless") || level.includes("frontier") || level.includes("minimal")) {
    return true;
  }

  const numeric = parseInt(level, 10);
  if (!isNaN(numeric)) return numeric <= 25;

  return false;
}

/**
 * Auto-cloak if in a dangerous system. Skips if already cloaked, docked, or no cloak module.
 * Returns true if now cloaked, false otherwise.
 */
export async function autoCloakIfDangerous(ctx: RoutineContext): Promise<boolean> {
  const { bot } = ctx;
  if (bot.isCloaked || bot.docked) return bot.isCloaked;

  const sys = mapStore.getSystem(bot.system);
  if (!sys || !isDangerousSystem(sys.security_level)) return false;

  // IMPORTANT: always pass { enable: true }. A bare `cloak` command turns the
  // cloak OFF (it cannot turn it on), so calling it here would kill an active
  // cloak whenever bot.isCloaked is stale. enable=true is the only way on.
  const resp = await bot.exec("cloak", { enable: true });
  if (!resp.error) {
    bot.isCloaked = true;
    ctx.log("system", `Cloaked in ${bot.system} (${sys.security_level})`);
    return true;
  }

  const msg = resp.error.message.toLowerCase();
  if (msg.includes("already cloaked") || msg.includes("already_cloaked")) {
    bot.isCloaked = true;
    return true;
  }
  // No cloak module or other error — gracefully skip
  return false;
}

/**
 * Unconditionally attempt to enable cloaking (e.g. when a routine's settings
 * request permanent cloaking). Returns true if the bot ends up cloaked.
 * Skips gracefully when already cloaked or when no cloak module is available.
 */
export async function enableCloakingIfPossible(ctx: RoutineContext): Promise<boolean> {
  const { bot } = ctx;
  // The in-memory `isCloaked` flag is reset on every routine (re)start, but the
  // ship may ALREADY be cloaked on the gameserver from a previous run. Issuing
  // `cloak { enable: true }` forces a re-cloak which UN-DOCKS the ship, so we
  // must sync the real cloak state from the server before deciding to issue the
  // command. Without this, a plain routine restart would un-dock a perfectly
  // good docked + cloaked credit-top-off bot.
  try {
    await bot.refreshStatus();
  } catch {
    // best-effort: fall through to the local flag
  }
  if (bot.isCloaked) {
    ctx.log("system", `Already cloaked in ${bot.system} (confirmed via get_status) — skipping re-cloak to avoid un-dock`);
    return true;
  }
  try {
    const resp = await bot.exec("cloak", { enable: true });
    if (!resp.error) {
      bot.isCloaked = true;
      // Cloaking always undocks the ship — clear the stale docked flag so
      // downstream ensureDocked() actually re-docks (e.g. before analyze_market).
      bot.docked = false;
      ctx.log("system", `Cloaking enabled in ${bot.system}`);
      return true;
    }
    const msg = String(resp.error.message || "").toLowerCase();
    if (msg.includes("already cloaked") || msg.includes("already_cloaked")) {
      bot.isCloaked = true;
      bot.docked = false;
      return true;
    }
    ctx.log("warn", `Could not enable cloaking: ${resp.error.message}`);
    return false;
  } catch (e) {
    ctx.log("warn", `Could not enable cloaking: ${e}`);
    return false;
  }
}

// ── Transit Detection ───────────────────────────────────────────

/**
 * Wait for the bot to finish any ongoing transit (jump/travel).
 * Returns true if bot was in transit and completed it, false if not in transit.
 * Waits up to maxWaitSeconds (default 120s) before giving up.
 */
export async function waitForTransitCompletion(
  ctx: RoutineContext,
  maxWaitSeconds: number = 120,
): Promise<boolean> {
  const { bot } = ctx;
  
  await bot.refreshPOI();
  
  if (!bot.inTransit) {
    return false;
  }
  
  const transitType = bot.transitType || "unknown";
  const ticksRemaining = bot.ticksRemaining;
  ctx.log("travel", `Bot is in transit (${transitType}) with ${ticksRemaining} ticks remaining - waiting...`);
  
  const startTime = Date.now();
  const maxWaitMs = maxWaitSeconds * 1000;
  
  while (bot.state === "running" && Date.now() - startTime < maxWaitMs) {
    await bot.refreshPOI();
    
    if (!bot.inTransit) {
      ctx.log("travel", `Transit complete - ${transitType} finished`);
      return true;
    }
    
    ctx.log("travel", `Still in transit (${bot.transitType}) - ${bot.ticksRemaining} ticks remaining`);
    await ctx.sleep(10000);
  }
  
  ctx.log("warn", `Transit wait timeout after ${maxWaitSeconds}s - bot still in transit`);
  return false;
}

// ── Insurance ────────────────────────────────────────────────

/** Minimum credits to keep when buying insurance. */
const INSURANCE_CREDIT_FLOOR = 500;

/**
 * Universal auto-insure: buy insurance if docked at a station with the service.
 * Checks `general.autoInsure` setting (default: true).
 * Skips if already insured, can't afford, or no insurance service.
 */
export async function ensureInsured(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;
  if (!bot.docked) {
    ctx.log("insurance", "Skipping insurance check - not docked");
    return;
  }

  const all = readSettings();
  if ((all.general?.autoInsure as boolean) === false) {
    ctx.log("insurance", "Skipping insurance check - autoInsure disabled in settings");
    return;
  }

  const { pois } = await getSystemInfo(ctx);
  const currentStation = pois.find(p => isStationPoi(p) && p.id === bot.poi);
  if (currentStation && !stationHasService(currentStation, "insurance")) {
    ctx.log("insurance", `Skipping insurance check - station ${currentStation.name} does not have insurance service`);
    return;
  }

  const quoteResp = await bot.exec("get_insurance_quote");
  if (quoteResp.error || !quoteResp.result) {
    ctx.log("insurance", `Skipping insurance check - quote failed: ${quoteResp.error?.message || "no result"}`);
    return;
  }

  const q = quoteResp.result as Record<string, unknown>;
  const quoteObj = (q.quote as Record<string, unknown>) ?? q;

  // Already insured?
  const insured = (quoteObj.insured as boolean) ?? (q.insured as boolean) ?? false;
  if (insured) {
    ctx.log("insurance", "Already insured - skipping purchase");
    return;
  }

  const cost = (quoteObj.cost as number) || (quoteObj.premium as number) || (quoteObj.price as number) || 0;
  if (cost <= 0) {
    ctx.log("insurance", "Skipping insurance check - no valid quote cost");
    return;
  }

  // We are not insured and have a valid quote — buy insurance automatically.
  await buyInsurance(ctx);
}

export async function buyInsurance(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;
  if (!bot.docked) {
    ctx.log("insurance", "Cannot buy insurance - not docked");
    return;
  }
  ctx.log("insurance", "Buying insurance for 7 days...");
  const insureResp = await bot.exec("buy_insurance", { ticks: 60480 });
  if (!insureResp.error && insureResp.result) {
    const r = insureResp.result as Record<string, unknown>;
    const msg = (r?.message as string) || `Insurance purchased for 7 days`;
    ctx.log("insurance", msg);
    logFactionActivity(ctx, "insurance", `Bought insurance: ${msg}`);
    
    const quoteResp = await bot.exec("get_insurance_quote");
    let coverage = 7;
    let cost = 0;
    let analysis: Record<string, unknown> | undefined;
    if (!quoteResp.error && quoteResp.result) {
      const q = quoteResp.result as Record<string, unknown>;
      const quoteObj = (q.quote as Record<string, unknown>) ?? q;
      cost = (quoteObj.cost as number) || (quoteObj.premium as number) || 0;
      coverage = (quoteObj.coverage as number) || 7;
      analysis = q as Record<string, unknown>;
    }
    
    recordInsurancePurchase(bot.username, bot.shipId, bot.shipName, cost, coverage, analysis);
    ctx.log("insurance", `Recorded insurance: shipId=${bot.shipId}, coverage=${coverage} days`);
    
    await bot.refreshLocation();
  } else {
    const errMsg = insureResp.error?.message || "Unknown error";
    if (errMsg.toLowerCase().includes("already_insured")) {
      ctx.log("insurance", "Already insured - skipping purchase");
      logFactionActivity(ctx, "insurance", "Skipped - already insured");
    } else {
      ctx.log("insurance", `Insurance purchase failed: ${errMsg}`);
      logFactionActivity(ctx, "insurance", `Failed: ${errMsg}`);
    }
  }
}

/**
 * Detect death (hull=0) and attempt recovery: claim insurance, dock, refuel, repair, re-insure.
 * Returns true if alive/recovered, false if stuck dead.
 */
export async function detectAndRecoverFromDeath(ctx: RoutineContext): Promise<boolean> {
  const { bot } = ctx;
  await bot.refreshShip();

  if (bot.hull > 0 && !bot.isDead) return true; // alive

  ctx.log("system", "DEATH DETECTED — hull at 0. Attempting insurance claim...");

  // Claim insurance
  const claimResp = await bot.exec("claim_insurance");
  if (!claimResp.error && claimResp.result) {
    const r = claimResp.result as Record<string, unknown>;
    const payout = (r.payout as number) || (r.credits as number) || 0;
    if (payout > 0) ctx.log("info", `Insurance payout: ${payout}cr`);
  }

  // Refresh — we may have respawned
  await bot.refreshShip();

  if (bot.hull <= 0 && bot.maxHull > 0) {
    ctx.log("error", "Still dead after insurance claim — waiting for respawn...");
    // Wait up to 60s for respawn
    for (let i = 0; i < 6; i++) {
      await sleep(10_000);
      await bot.refreshShip();
      if (bot.hull > 0) break;
    }
    if (bot.hull <= 0 && bot.maxHull > 0) {
      ctx.log("error", "Could not recover from death — stuck");
      return false;
    }
  }

  bot.isDead = false;
  ctx.log("system", "Respawned — recovering...");

  // Try to dock, refuel, repair, re-insure
  if (bot.docked) {
    await tryRefuel(ctx);
    await repairShip(ctx);
    await ensureInsured(ctx);
  } else {
    const docked = await ensureDocked(ctx);
    if (docked) {
      await tryRefuel(ctx);
      await repairShip(ctx);
      await ensureInsured(ctx);
    }
  }

  await bot.refreshShip();
  ctx.log("system", `Recovery complete — hull: ${bot.hull}/${bot.maxHull}, credits: ${bot.credits}`);
  return true;
}

// ── Settings ─────────────────────────────────────────────────

/** Read settings from data/settings.json. */
export function readSettings(): Record<string, Record<string, unknown>> {
  try {
    const { readFileSync, existsSync } = require("fs");
    const { join } = require("path");
    const file = join(process.cwd(), "data", "settings.json");
    if (existsSync(file)) {
      const content = readFileSync(file, "utf-8");
      const parsed = JSON.parse(content);
      return parsed;
    } else {
    }
  } catch (error) {
  }
  return {};
}

/** Write settings to data/settings.json. Merges with existing settings. */
export function writeSettings(updates: Record<string, Record<string, unknown>>): void {
  const { writeFileSync, existsSync, mkdirSync, readFileSync } = require("fs");
  const { join } = require("path");
  const dir = join(process.cwd(), "data");
  const file = join(dir, "settings.json");

  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  let existing: Record<string, Record<string, unknown>> = {};
  try {
    if (existsSync(file)) {
      existing = JSON.parse(readFileSync(file, "utf-8"));
    }
  } catch { /* start fresh */ }

  // Deep merge: update each routine section
  for (const [key, val] of Object.entries(updates)) {
    if (key === "flock") continue;
    existing[key] = { ...(existing[key] || {}), ...val };
  }

  writeFileSync(file, JSON.stringify(existing, null, 2) + "\n", "utf-8");
}

export function isCombatDebugEnabled(): boolean {
  const all = readSettings();
  const h = (all.hunter || {}) as Record<string, unknown>;
  return (h.combatDebug as boolean) ?? false;
}

// ── Utilities ────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Log an entry to the faction activity log. Types: deposit, withdraw, donation, gift */
export function logFactionActivity(ctx: RoutineContext, type: string, message: string): void {
  const { bot } = ctx;
  const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false });
  const line = `${timestamp} [${type}] ${bot.username}: ${message}`;
  bot.onFactionLog?.(bot.username, line);
}

/** Log a status summary line. */
export function logStatus(ctx: RoutineContext): void {
  const { bot } = ctx;
  const fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : bot.fuel;
  const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
  ctx.log("info", `Credits: ${bot.credits} | Fuel: ${fuelPct}% | Hull: ${hullPct}% | Cargo: ${bot.cargo}/${bot.cargoMax} | System: ${bot.system} | Docked: ${bot.docked}`);
}

/**
 * Donate a configurable % of profit to the faction treasury.
 * Reads `general.factionDonatePct` from settings (default 10).
 * Bot retains at least `creditsToHold` credits after donation (default 10000).
 */
export async function factionDonateProfit(ctx: RoutineContext, profit: number, creditsToHold?: number): Promise<void> {
  if (profit <= 0) return;
  const all = readSettings();
  const pct = (all.general?.factionDonatePct as number) ?? 10;
  if (pct <= 0) return;
  const { bot } = ctx;
  const hold = creditsToHold ?? (all.general?.factionDonateFloor as number) ?? 10000;
  const donation = Math.floor(profit * (pct / 100));
  if (donation <= 0) return;
  if (bot.credits - donation < hold) return;
  const resp = await bot.exec("storage", { action: 'deposit', target: 'faction', item_id: 'credits', quantity: donation }); // NEVER CHANGE THIS - deposit credits to faction storage
  if (!resp.error) {
    ctx.log("trade", `Donated ${donation}cr to faction treasury (${pct}% of ${profit}cr profit)`);
    logFactionActivity(ctx, "deposit", `Deposited ${donation}cr (${pct}% of ${profit}cr profit)`);
  }
}

// ── Combat Detection & Flee ─────────────────────────────────

/** Battle notification types detected from notification parsing */
export interface BattleNotification {
  type: "battle_start" | "battle_tick" | "battle_hit" | "battle_end" | "battle_disengage" | "battle_flee_success" | "battle_flee_failed";
  battleId?: string;
  tick?: number;
  message?: string;
  /** Battle participants data - used for pirate detection */
  participants?: Array<Record<string, unknown>>;
  sides?: Array<Record<string, unknown>>;
  /** From battle_update: our own stance this tick */
  your_stance?: string;
  /** From battle_update: our own distance ring */
  your_zone?: string;
  /** From battle_update: our own side id */
  your_side_id?: number;
}

/**
 * Parse a notification to detect battle-related events.
 * Based on actual game notification formats.
 * 
 * Raw notification structure:
 * - type: "combat" | "system"
 * - msg_type: "battle_started" | "battle_joined" | "battle_tick" | etc.
 * - data: { message: "..." } or structured battle data
 * 
 * Message formats (without UI prefixes):
 * - "Battle started! ID: {battle_id}"
 * - "Battle tick {tick} - combat continues"
 * - "{attacker} hit {defender} for {damage} damage"
 * - "{player} left the battle"
 * - "Battle ended!"
 * - "You have disengaged from battle."
 * 
 * @param notification - Raw notification object
 * @returns BattleNotification if battle-related, null otherwise
 */
export function parseBattleNotification(notification: unknown): BattleNotification | null {
  if (!notification || typeof notification !== "object") {
    return null;
  }

  const notif = notification as Record<string, unknown>;
  const type = notif.type as string | undefined;
  const msgType = notif.msg_type as string | undefined;
  let data = notif.data as Record<string, unknown> | string | undefined;

  // Parse data if it's a string (json.RawMessage)
  if (typeof data === "string") {
    try { data = JSON.parse(data) as Record<string, unknown>; } catch { /* leave as string */ }
  }

  // Get message text from notification
  let message = "";
  if (data && typeof data === "object") {
    message = (data.message as string) || formatNotificationData(data);
  } else if (typeof data === "string") {
    message = data;
  }

  if (!message) return null;

  const lowerMsg = message.toLowerCase();

  // Check for battle_started msg_type (system notification with structured data)
  if (msgType === "battle_started" && data && typeof data === "object") {
    const battleData = data as Record<string, unknown>;
    const battleId = (battleData.battle_id as string) || "";
    if (battleId) {
      return {
        type: "battle_start",
        battleId,
        message: `Battle started! ID: ${battleId}`,
      };
    }
  }

  // Check for battle_joined msg_type (we were pulled into a battle)
  if (msgType === "battle_joined" && data && typeof data === "object") {
    const joinData = data as Record<string, unknown>;
    const battleId = (joinData.battle_id as string) || "";
    // This notification doesn't include battle_id directly, but indicates we joined a battle
    return {
      type: "battle_start",
      battleId: undefined, // Will be populated by get_battle_status
      message: "Joined battle",
    };
  }

  // Check for battle_update msg_type (periodic battle state updates)
  // Format from debug log: msg_type: "battle_update", data: { battle_id, tick, your_zone, your_stance, participants, sides, ... }
  if (msgType === "battle_update" && data && typeof data === "object") {
    const updateData = data as Record<string, unknown>;
    const battleId = (updateData.battle_id as string) || "";
    const tick = (updateData.tick as number) || 0;
    const participants = Array.isArray(updateData.participants) ? updateData.participants as Array<Record<string, unknown>> : undefined;
    const sides = Array.isArray(updateData.sides) ? updateData.sides as Array<Record<string, unknown>> : undefined;
    const yourStance = (updateData.your_stance as string) || undefined;
    const yourZone = (updateData.your_zone as string) || undefined;
    const yourSideId = (updateData.your_side_id as number) || undefined;
    
    // If we have a battle_id, this means we're still in battle
    if (battleId) {
      return {
        type: "battle_tick",
        battleId,
        tick,
        participants,
        sides,
        your_stance: yourStance,
        your_zone: yourZone,
        your_side_id: yourSideId,
        message: `Battle update - tick: ${tick}`,
      };
    }
  }

  // Check for battle_damage msg_type (damage events)
  // Format from debug log: msg_type: "battle_damage", data: { tick, attacker_id, attacker_name, target_id, target_name, total_damage, ... }
  if (msgType === "battle_damage" && data && typeof data === "object") {
    const damageData = data as Record<string, unknown>;
    const attackerName = (damageData.attacker_name as string) || "";
    const targetName = (damageData.target_name as string) || "";
    const totalDamage = (damageData.total_damage as number) || 0;
    const tick = (damageData.tick as number) || 0;
    
    return {
      type: "battle_hit",
      tick,
      message: `${attackerName} hit ${targetName} for ${totalDamage} damage (tick: ${tick})`,
    };
  }

  // Battle started notification (type: combat)
  // Format: "Battle started! ID: {battle_id}"
  if (type === "combat") {
    const battleStartMatch = message.match(/Battle started!\s*ID:\s*([a-f0-9]+)/i);
    if (battleStartMatch) {
      return {
        type: "battle_start",
        battleId: battleStartMatch[1],
        message,
      };
    }

    // Battle tick notification
    // Format: "Battle tick {tick} - combat continues"
    const battleTickMatch = message.match(/Battle tick\s+(\d+)\s*-\s*combat continues/i);
    if (battleTickMatch) {
      return {
        type: "battle_tick",
        tick: parseInt(battleTickMatch[1], 10),
        message,
      };
    }

    // Battle hit notification
    // Format: "{attacker} hit {defender} for {damage} damage"
    const battleHitMatch = message.match(/(.+?)\s+hit\s+(.+?)\s+for\s+(\d+)\s+damage/i);
    if (battleHitMatch) {
      return {
        type: "battle_hit",
        message,
      };
    }

    // Player left battle notification
    // Format: "{player} left the battle"
    const leftBattleMatch = message.match(/(.+?)\s+left the battle/i);
    if (leftBattleMatch) {
      return {
        type: "battle_end",
        message,
      };
    }

    // Battle ended notification
    if (lowerMsg.includes("battle ended")) {
      return {
        type: "battle_end",
        message,
      };
    }
  }

  // Disengage notification (type: system)
  // Format: "You have disengaged from battle."
  if (type === "system" && lowerMsg.includes("disengaged from battle")) {
    return {
      type: "battle_disengage",
      message,
    };
  }

  return null;
}

/** Helper to format notification data object */
function formatNotificationData(data: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, val] of Object.entries(data)) {
    if (val === null || val === undefined || val === "") continue;
    if (typeof val === "object") continue;
    parts.push(`${key}: ${val}`);
  }
  return parts.length > 0 ? parts.join(", ") : JSON.stringify(data);
}

/**
 * Parse array of notifications to detect battle events.
 * @param notifications - Array of raw notifications
 * @returns Array of parsed battle notifications
 */
export function parseBattleNotifications(notifications: unknown[]): BattleNotification[] {
  const results: BattleNotification[] = [];
  for (const n of notifications) {
    const battle = parseBattleNotification(n);
    if (battle) {
      results.push(battle);
    }
  }
  return results;
}

/** Result of pirate detection in nearby entities */
export interface PirateDetectionResult {
  hasPirates: boolean;
  pirateCount: number;
  highestTier: PirateTier | null;
  pirates: NearbyEntity[];
}

export interface NearbyEntitiesResult {
  pirates: NearbyEntity[];
  players: NearbyEntity[];
  hasPirates: boolean;
  hasPlayers: boolean;
  pirateCount: number;
  playerCount: number;
}

/** Pirate tier type for threat assessment - matches API values */
export type PirateTier = "small" | "medium" | "large" | "capitol" | "boss" | "raider" | "salvager" | "tanker" | "fighter" | "destroyer" | "cruiser" | "battleship";

/** Map pirate ship types to threat levels for flee decisions */
const PIRATE_THREAT_LEVELS: Record<string, number> = {
  "salvager": 1,
  "tanker": 1,
  "fighter": 2,
  "small": 2,
  "raider": 3,
  "medium": 3,
  "destroyer": 4,
  "large": 4,
  "cruiser": 5,
  "capitol": 6,
  "battleship": 7,
  "boss": 8,
};

/** Get threat level for a pirate tier (higher = more dangerous) */
export function getPirateThreatLevel(tier: string | undefined | null): number {
  if (!tier) return 0;
  return PIRATE_THREAT_LEVELS[tier.toLowerCase()] || 2;
}

/** Entity from get_nearby response (pirates or players) */
export interface NearbyEntity {
  id: string;
  name: string;
  type: string;
  faction: string;
  isNPC: boolean;
  isPirate: boolean;
  tier?: PirateTier;
  isBoss?: boolean;
  hull?: number;
  maxHull?: number;
  shield?: number;
  maxShield?: number;
  status?: string;
  shipId?: string; // For players
  shipTier?: number; // For players
}

/**
 * Parse get_nearby response to detect pirates.
 * @param result - The result from get_nearby API call
 * @returns Detection result with pirate count and threat level
 */
export function parseNearbyForPirates(result: unknown): PirateDetectionResult {
  if (!result || typeof result !== "object") {
    return { hasPirates: false, pirateCount: 0, highestTier: null, pirates: [] };
  }

  const r = result as Record<string, unknown>;
  const pirates: NearbyEntity[] = [];

  // Handle different response formats
  let rawEntities: Array<Record<string, unknown>> = [];

  if (Array.isArray(r)) {
    rawEntities = r;
  } else if (Array.isArray(r.entities)) {
    rawEntities = r.entities as Array<Record<string, unknown>>;
  } else if (Array.isArray(r.players) && r.players.length > 0) {
    rawEntities = r.players as Array<Record<string, unknown>>;
  } else if (Array.isArray(r.nearby)) {
    rawEntities = r.nearby as Array<Record<string, unknown>>;
  }

  // Parse entities looking for pirates
  for (const e of rawEntities) {
    const id = (e.id as string) || (e.player_id as string) || (e.entity_id as string) || (e.pirate_id as string) || "";
    if (!id) continue;

    let faction = "";
    if (typeof e.faction === "string") faction = e.faction.toLowerCase();
    else if (typeof e.faction_id === "string") faction = e.faction_id.toLowerCase();

    let type = "";
    if (typeof e.type === "string") type = e.type.toLowerCase();
    else if (typeof e.entity_type === "string") type = e.entity_type.toLowerCase();

    const isPirate = !!(e.pirate_id) || type.includes("pirate") || faction.includes("pirate");
    if (!isPirate) continue;

    const tier = (e.tier as PirateTier) || "small";
    const isBoss = !!(e.is_boss as boolean);

    pirates.push({
      id,
      name: (e.name as string) || (e.username as string) || (e.pirate_name as string) || id,
      type: "pirate",
      faction: "pirate",
      isNPC: true,
      isPirate: true,
      tier,
      isBoss,
      hull: e.hull as number,
      maxHull: e.max_hull as number,
      shield: e.shield as number,
      maxShield: e.max_shield as number,
      status: e.status as string,
    });
  }

  // Parse pirates array (special format from get_nearby at POIs)
  if (Array.isArray(r.pirates)) {
    const rawPirates = r.pirates as Array<Record<string, unknown>>;
    for (const p of rawPirates) {
      const id = (p.pirate_id as string) || "";
      if (!id) continue;

      const tier = (p.tier as PirateTier) || "small";
      const isBoss = !!(p.is_boss as boolean);

      pirates.push({
        id,
        name: (p.name as string) || (p.pirate_name as string) || id,
        type: "pirate",
        faction: "pirate",
        isNPC: true,
        isPirate: true,
        tier,
        isBoss,
        hull: p.hull as number,
        maxHull: p.max_hull as number,
        shield: p.shield as number,
        maxShield: p.max_shield as number,
        status: p.status as string,
      });
    }
  }

  // Determine highest threat tier present
  let highestTier: PirateTier | null = null;
  let highestThreat = 0;
  for (const pirate of pirates) {
    if (pirate.tier) {
      const threat = getPirateThreatLevel(pirate.tier);
      if (threat > highestThreat) {
        highestThreat = threat;
        highestTier = pirate.tier;
      }
    }
  }

  return {
    hasPirates: pirates.length > 0,
    pirateCount: pirates.length,
    highestTier,
    pirates,
  };
}

/**
 * Parse get_nearby response to detect both pirates and players.
 * @param result - The result from get_nearby API call
 * @returns Detection result with pirates and players
 */
export function parseNearbyEntities(result: unknown): NearbyEntitiesResult {
  if (!result || typeof result !== "object") {
    return { pirates: [], players: [], hasPirates: false, hasPlayers: false, pirateCount: 0, playerCount: 0 };
  }

  const r = result as Record<string, unknown>;
  const pirates: NearbyEntity[] = [];
  const players: NearbyEntity[] = [];

  // Handle different response formats
  let rawEntities: Array<Record<string, unknown>> = [];

  if (Array.isArray(r)) {
    rawEntities = r;
  } else if (Array.isArray(r.entities)) {
    rawEntities = r.entities as Array<Record<string, unknown>>;
  } else if (Array.isArray(r.players) && r.players.length > 0) {
    rawEntities = r.players as Array<Record<string, unknown>>;
  } else if (Array.isArray(r.nearby)) {
    rawEntities = r.nearby as Array<Record<string, unknown>>;
  }

  // Parse entities looking for pirates and players
  for (const e of rawEntities) {
    const id = (e.id as string) || (e.player_id as string) || (e.entity_id as string) || (e.pirate_id as string) || "";
    if (!id) continue;

    let faction = "";
    if (typeof e.faction === "string") faction = e.faction.toLowerCase();
    else if (typeof e.faction_id === "string") faction = e.faction_id.toLowerCase();

    let type = "";
    if (typeof e.type === "string") type = e.type.toLowerCase();
    else if (typeof e.entity_type === "string") type = e.entity_type.toLowerCase();

    const isPirate = !!(e.pirate_id) || type.includes("pirate") || faction.includes("pirate");
    const isPlayer = !isPirate && (type.includes("player") || type.includes("ship") || e.player_id);

    if (isPirate) {
      const tier = (e.tier as PirateTier) || "small";
      const isBoss = !!(e.is_boss as boolean);

      pirates.push({
        id,
        name: (e.name as string) || (e.username as string) || (e.pirate_name as string) || id,
        type: "pirate",
        faction: "pirate",
        isNPC: true,
        isPirate: true,
        tier,
        isBoss,
        hull: e.hull as number,
        maxHull: e.max_hull as number,
        shield: e.shield as number,
        maxShield: e.max_shield as number,
        status: e.status as string,
      });
    } else if (isPlayer) {
      const shipId = (e.ship_id as string) || (e.ship as string) || "";
      const shipTier = shipId ? getShipTier(shipId) : null;

      players.push({
        id,
        name: (e.name as string) || (e.username as string) || id,
        type: "player",
        faction: faction || "neutral",
        isNPC: false,
        isPirate: false,
        shipId,
        shipTier: shipTier ?? undefined,
        hull: e.hull as number,
        maxHull: e.max_hull as number,
        shield: e.shield as number,
        maxShield: e.max_shield as number,
        status: e.status as string,
      });
    }
  }

  // Parse pirates array (special format from get_nearby at POIs)
  if (Array.isArray(r.pirates)) {
    const rawPirates = r.pirates as Array<Record<string, unknown>>;
    for (const p of rawPirates) {
      const id = (p.pirate_id as string) || "";
      if (!id) continue;

      const tier = (p.tier as PirateTier) || "small";
      const isBoss = !!(p.is_boss as boolean);

      pirates.push({
        id,
        name: (p.name as string) || (p.pirate_name as string) || id,
        type: "pirate",
        faction: "pirate",
        isNPC: true,
        isPirate: true,
        tier,
        isBoss,
        hull: p.hull as number,
        maxHull: p.max_hull as number,
        shield: p.shield as number,
        maxShield: p.max_shield as number,
        status: p.status as string,
      });
    }
  }

  return {
    pirates,
    players,
    hasPirates: pirates.length > 0,
    hasPlayers: players.length > 0,
    pirateCount: pirates.length,
    playerCount: players.length,
  };
}

/**
 * Get current battle status from the API.
 * @param ctx - Routine context
 * @returns Battle status or null if not in battle
 */
export async function getBattleStatus(ctx: RoutineContext): Promise<BattleStatus | null> {
  const { bot } = ctx;

  // Library-backed bots receive battle state as push events (Bot.subscribeEvents:
  // battle_update / battle_started / battle_ended / battle_damage / battle_alert).
  // When those indicate we are NOT in a battle, polling get_battle_status is
  // redundant and would only produce a benign "No active battle" error. Skip the
  // poll and report "not in battle" directly. We still poll whenever push state
  // says we're in a battle, to get live zone/stance/target data for combat loops.
  if (bot.account && !bot.isInBattle()) {
    return null;
  }

  // Otherwise check API for fresh data
  const resp = await bot.exec("get_battle_status");
  if (resp.error || !resp.result) {
    // On 502/524 errors, return null but don't log - rely on WebSocket state
    return null;
  }

  const result = resp.result as Record<string, unknown>;
  if (result.error && (result.error as Record<string, unknown>).code === "not_in_battle") {
    combatDebugLog(bot.username, "battle:get_status_not_in_battle", result);
    return null;
  }

   combatDebugLog(bot.username, "battle:get_status", result);

  // Merge WebSocket-pushed battle_update fields with the fresh API response.
  // The get_battle_status API response does NOT include your_stance / your_zone
  // / your_side_id / tick — those only arrive via the battle_update WebSocket
  // push notification. Fall back to the WebSocket-stored values when the API
  // response doesn't include them.
  const ws = bot.currentBattle;
  const resultWithWs: Record<string, unknown> = {
    ...result,
    your_stance: result.your_stance ?? ws.yourStance,
    your_zone: result.your_zone ?? ws.yourZone,
    your_side_id: result.your_side_id ?? ws.yourSideId,
    tick: result.tick ?? ws.lastTick,
  };

  // Parse battle status
  const status: BattleStatus = {
    battle_id: (resultWithWs.battle_id as string) || "",
    tick: (resultWithWs.tick as number) || undefined,
    system_id: (resultWithWs.system_id as string) || undefined,
    sides: (resultWithWs.sides as BattleSide[]) || [],
    participants: (resultWithWs.participants as BattleParticipant[]) || [],
    your_side_id: (resultWithWs.your_side_id as number) || undefined,
    your_zone: (resultWithWs.your_zone as BattleZone) || undefined,
    your_stance: (resultWithWs.your_stance as BattleStance) || undefined,
    your_target_id: (resultWithWs.your_target_id as string) || undefined,
    auto_pilot: (resultWithWs.auto_pilot as boolean) || undefined,
    is_participant: (resultWithWs.is_participant as boolean) || false,
    boarding: (resultWithWs.boarding as BoardingPublicStatus[]) || undefined,
    combat_state: (resultWithWs.combat_state as BattleCombatState) || undefined,
  };

  ctx.log("combat", formatBattleUpdateDebug(
    {
      your_stance: resultWithWs.your_stance as string | undefined,
      your_zone: resultWithWs.your_zone as string | undefined,
      your_side_id: resultWithWs.your_side_id as number | undefined,
      participants: resultWithWs.participants as Array<Record<string, unknown>> | undefined,
      sides: resultWithWs.sides as Array<Record<string, unknown>> | undefined,
      tick: resultWithWs.tick as number | undefined,
    },
    ctx.bot.system,
    ctx.bot.poi,
  ));

  return status;
}

/**
 * Attempt to flee from an active battle.
 * Uses "battle stance flee" command which takes 3 ticks to complete.
 * Optionally waits for disengage confirmation notification.
 * 
 * @param ctx - Routine context
 * @param waitForDisengage - If true, waits for "You have disengaged from battle" notification (default: true)
 * @param maxWaitMs - Maximum time to wait for disengage confirmation in ms (default: 35000ms = 3.5 ticks)
 * @returns true if successfully fled and disengaged, false otherwise
 */
export async function fleeFromBattle(
  ctx: RoutineContext,
  waitForDisengage: boolean = true,
  maxWaitMs: number = 35000,
): Promise<boolean> {
  const { bot } = ctx;

  // Check if we're actually in a battle
  const status = await getBattleStatus(ctx);
  if (!status) {
    ctx.log("combat", "Not in battle - cannot flee");
    return false;
  }

   ctx.log("combat", "FLEEING BATTLE - issuing flee stance command!");
  const resp = await bot.exec("battle", { action: "stance", stance: "flee" });

  if (resp.error) {
    ctx.log("error", `Flee command failed: ${resp.error.message}`);
    return false;
  }

   ctx.log("combat", "Flee stance engaged - escaping battle! (takes 3 ticks)");

  // Wait for disengage confirmation if requested
  if (waitForDisengage) {
    ctx.log("combat", "Waiting for disengage confirmation...");
    const startTime = Date.now();
    let disengaged = false;

    // Poll for disengage notification or battle status change
    while (!disengaged && Date.now() - startTime < maxWaitMs) {
      await new Promise(resolve => setTimeout(resolve, 5000)); // Check every 5 seconds

      // Check battle status - if not in battle anymore, we're clear
      const newStatus = await getBattleStatus(ctx);
      if (!newStatus) {
        ctx.log("combat", "Battle status cleared - successfully disengaged!");
        disengaged = true;
        break;
      }

      // Also check if we're still in the battle by ID
      if (newStatus.battle_id !== status.battle_id) {
        ctx.log("combat", "Battle ID changed - successfully disengaged!");
        disengaged = true;
        break;
      }
    }

    if (!disengaged) {
      ctx.log("warn", "Flee timeout - battle may still be active");
      return false;
    }
  }

  return true;
}

/**
 * Handle battle detection from notifications and initiate flee.
 * Call this after any command execution that may return battle notifications.
 * 
 * @param ctx - Routine context
 * @param notifications - Array of notifications to check
 * @param battleState - Current battle state object to track battle status
 * @returns true if battle was detected and flee was initiated, false otherwise
 */
export interface BattleState {
  inBattle: boolean;
  battleId: string | null;
  battleStartTick: number | null;
  lastHitTick: number | null;
  isFleeing: boolean;
  lastFleeTime?: number; // Timestamp of last flee command issued
}

export async function handleBattleNotifications(
  ctx: RoutineContext,
  notifications: unknown[],
  battleState: BattleState,
): Promise<boolean> {
  const battleNotifications = parseBattleNotifications(notifications);

  if (battleNotifications.length === 0) {
    return false;
  }

  if (isCombatDebugEnabled()) {
    combatDebugLog(ctx.bot.username, "battle:notifications", notifications);
  }

  ctx.log("combat", `Processing ${battleNotifications.length} battle notification(s)...`);

  for (const battleNotif of battleNotifications) {
    ctx.log("combat", `Event: ${battleNotif.type} - ${battleNotif.message?.substring(0, 100) || ''}`);
    
    switch (battleNotif.type) {
      case "battle_start":
        ctx.log("combat", `BATTLE DETECTED! Battle ID: ${battleNotif.battleId}`);
        battleState.inBattle = true;
        battleState.battleId = battleNotif.battleId || null;
        battleState.battleStartTick = Date.now();
        battleState.isFleeing = false;

        // Check for pirates in battle participants first
        if (battleNotif.participants) {
          const pirateResult = parsePiratesFromBattleParticipants(battleNotif.participants);
          if (pirateResult.hasPirates) {
            ctx.log("combat", `⚠️ PIRATES DETECTED IN BATTLE! ${pirateResult.pirateCount} pirate(s), highest tier: ${pirateResult.highestTier}`);
            ctx.log("combat", "Issuing flee stance IMMEDIATELY (non-blocking)!");
            // FIX: Issue flee and return immediately - DON'T wait for disengage!
            await ctx.bot.exec("battle", { action: "stance", stance: "flee" });
            return true;
          }
        }

        // No pirates detected - check for players via get_nearby
        ctx.log("combat", "No pirates detected - checking for attacking players...");
        const nearbyResp = await ctx.bot.exec("get_nearby");
        if (!nearbyResp.error && nearbyResp.result) {
          ctx.bot.trackWildlife(nearbyResp.result);
          const nearbyResult = parseNearbyEntities(nearbyResp.result);
          ctx.log("combat", `Nearby entities: ${nearbyResult.playerCount} players, ${nearbyResult.pirateCount} pirates`);

          // Check if we should fight players
          if (nearbyResult.hasPlayers) {
            const shouldFight = await shouldEngagePlayersInCombat(ctx, nearbyResult.players);
            if (shouldFight) {
              ctx.log("combat", "Decided to engage attacking players in combat!");
              await engageInBattle(ctx);
              return true; // We're fighting, not fleeing
            }
          }
        }

        // Default: flee if we can't determine attackers or shouldn't fight
        ctx.log("combat", "Unable to determine attackers or decided not to fight - issuing flee IMMEDIATELY (non-blocking)!");
        // FIX: Issue flee and return immediately - DON'T wait for disengage!
        await ctx.bot.exec("battle", { action: "stance", stance: "flee" });
        return true;

      case "battle_tick":
        // Debug: log full battle update state for every tick
        {
          const debugLines = formatBattleUpdateDebug(battleNotif, ctx.bot.system, ctx.bot.poi);
          ctx.log("combat", debugLines);
        }

        // Check for pirates in battle participants (from battle_update)
        if (battleNotif.participants) {
          const pirateResult = parsePiratesFromBattleParticipants(battleNotif.participants);
          if (pirateResult.hasPirates && !battleState.isFleeing) {
            ctx.log("combat", `⚠️ PIRATES DETECTED IN BATTLE UPDATE! ${pirateResult.pirateCount} pirate(s) - issuing flee!`);
            battleState.isFleeing = false; // Reset to trigger flee
          }
        }

        if (battleState.inBattle && !battleState.isFleeing) {
          ctx.log("combat", `Battle tick ${battleNotif.tick} - combat continues (we're still in battle!)`);
          // If we somehow missed the battle start, flee now
          ctx.log("combat", "Initiating late flee - issuing stance IMMEDIATELY (non-blocking)!");
          // FIX: Issue flee and return immediately - DON'T wait for disengage!
          await ctx.bot.exec("battle", { action: "stance", stance: "flee" });
          return true;
        }
        break;

      case "battle_hit":
        ctx.log("combat", `Battle hit detected: ${battleNotif.message}`);
        battleState.lastHitTick = Date.now();
        // If we're not already fleeing, start fleeing
        if (battleState.inBattle && !battleState.isFleeing) {
          ctx.log("combat", "Hit detected - issuing flee IMMEDIATELY (non-blocking)!");
          // FIX: Issue flee and return immediately - DON'T wait for disengage!
          await ctx.bot.exec("battle", { action: "stance", stance: "flee" });
          return true;
        }
        break;

      case "battle_disengage":
        ctx.log("combat", "Disengage confirmation received - battle escaped!");
        battleState.inBattle = false;
        battleState.battleId = null;
        battleState.isFleeing = false;
        break;

      case "battle_end":
        ctx.log("combat", `Battle ended: ${battleNotif.message}`);
        // If we were in this battle, clear state
        if (battleState.inBattle) {
          battleState.inBattle = false;
          battleState.battleId = null;
          battleState.isFleeing = false;
          ctx.log("combat", "Battle won! Resuming normal operations.");
        }
        break;
    }
  }

  return battleNotifications.some(n => n.type === "battle_start" || n.type === "battle_hit");
}

/**
 * Quick battle status check with automatic flee.
 * Use this in routines that don't need full battle state tracking.
 * Returns true if battle was detected and flee was initiated.
 * 
 * @param ctx - Routine context
 * @param logPrefix - Optional prefix for log messages (e.g., routine name)
 * @returns true if battle detected and flee initiated, false otherwise
 */
export async function checkAndFleeFromBattle(
  ctx: RoutineContext,
  logPrefix?: string,
): Promise<boolean> {
  // CRITICAL: Check WebSocket battle state FIRST (fastest, no API call, and
  // works even when HTTP requests are hanging). This flag is now driven
  // authoritatively by spacemolt-lib push events: battle_update / battle_damage
  // set it, and battle_ended / battle_left immediately clear it (see
  // Bot.handleNotifications), so it no longer lingers as a stale "still in
  // battle" lock after the fight is actually over.
  if (ctx.bot.isInBattle()) {
    const prefix = logPrefix ? `[${logPrefix}] ` : "";
    const status = await getBattleStatus(ctx);
    if (!status || !status.is_participant) {
      ctx.bot.clearBattleState("stale-websocket-fallback");
      return false;
    }
    ctx.log("combat", `${prefix}BATTLE DETECTED [WebSocket]! - fleeing immediately!`);
    await fleeFromBattle(ctx, true, 35000);
    return true;
  }
  
  // Fallback: check via API
  const battleStatus = await getBattleStatus(ctx);
  if (battleStatus && battleStatus.is_participant) {
    const prefix = logPrefix ? `[${logPrefix}] ` : "";
    ctx.log("combat", `${prefix}BATTLE DETECTED! Battle ID: ${battleStatus.battle_id} - fleeing!`);
    await fleeFromBattle(ctx, true, 35000);
    return true;
  }
  return false;
}

/**
 * Check battle status and handle notifications after a command.
 * Use this wrapper pattern in routines: 
 *   const resp = await bot.exec("command");
 *   if (await checkBattleAfterCommand(ctx, resp.notifications, "command_name")) {
 *     // Handle battle - command was interrupted
 *     return; // or continue/break depending on loop
 *   }
 * 
 * @param ctx - Routine context  
 * @param notifications - Notifications from the command response
 * @param commandName - Name of the command (for logging)
 * @param battleState - Optional battle state for tracking
 * @returns true if battle detected and flee initiated, false otherwise
 */
export async function checkBattleAfterCommand(
  ctx: RoutineContext,
  notifications: unknown[] | undefined,
  commandName: string,
  battleState?: BattleState,
): Promise<boolean> {
  if (!notifications || !Array.isArray(notifications)) {
    return false;
  }

  // Check notifications first
  if (battleState) {
    const battleDetected = await handleBattleNotifications(ctx, notifications, battleState);
    if (battleDetected) {
      return true;
    }
  } else {
    // Simple mode - just check for battle start events
    const battleNotifs = parseBattleNotifications(notifications);
    const hasBattleStart = battleNotifs.some(n => n.type === "battle_start" || n.type === "battle_hit");
    if (hasBattleStart) {
      ctx.log("combat", `Battle detected during ${commandName} - fleeing!`);
      await fleeFromBattle(ctx, true, 35000);
      return true;
    }
  }

  // Fallback: check battle status directly
  return await checkAndFleeFromBattle(ctx, commandName);
}

/**
 * Emergency flee response when pirates are detected in get_nearby.
 * If not in a battle, immediately jump to a random adjacent system.
 * If already in battle, use flee stance.
 * 
 * IMPROVEMENTS:
 * - Uses get_status to verify actual current system before jumping (fixes system tracking)
 * - Polls get_battle_status every 5 seconds while jump is pending
 * - Detects silent battle locks and cancels out to use battle stance flee
 * - Validates jump target is actually connected to current system
 * 
 * @param ctx - Routine context
 * @param pirateResult - Result from parseNearbyForPirates
 * @returns true if successfully escaped/fled, false if failed
 */
export async function emergencyFleeFromPirates(
  ctx: RoutineContext,
  pirateResult: PirateDetectionResult,
): Promise<boolean> {
  const { bot } = ctx;

  ctx.log("error", `PIRATES DETECTED! ${pirateResult.pirateCount} pirate(s), highest tier: ${pirateResult.highestTier || "unknown"} - EMERGENCY FLEE!`);

  // Check if we're already in a battle
  const battleStatus = await getBattleStatus(ctx);
  if (battleStatus) {
    ctx.log("combat", "Already in battle - using flee stance");
    return await fleeFromBattle(ctx);
  }

  // Not in battle - need to jump away immediately
  // We have 20 seconds (2 ticks) to leave before they attack
  ctx.log("combat", "Not in battle - attempting emergency jump!");

  // CRITICAL: Verify actual current system via get_location before selecting jump target
  // This prevents jumping to non-connected systems when tracking gets mixed up
  await bot.refreshLocation();
  const actualCurrentSystem = bot.system;
  const actualCurrentPoi = bot.poi;
  ctx.log("travel", `Verified actual position: system=${actualCurrentSystem}, poi=${actualCurrentPoi}`);

  // Get fresh system info for the ACTUAL current system
  const systemInfo = await getSystemInfo(ctx);
  const { connections } = systemInfo;
  
  if (!connections || connections.length === 0) {
    ctx.log("error", "No jump connections available - trapped!");
    return false;
  }

  // Get blacklist and filter out blacklisted systems
  const blacklist = getSystemBlacklist();
  const safeConnections = connections.filter(c =>
    c.id && !blacklist.some(b => b.toLowerCase() === c.id!.toLowerCase())
  );

  // If all connections are blacklisted, we have no choice but to use any connection
  const candidates = safeConnections.length > 0 ? safeConnections : connections;
  if (candidates.length === 0) {
    ctx.log("error", "No valid jump targets available - trapped!");
    return false;
  }

  // Pick a random connection from valid candidates
  const randomConnection = candidates[Math.floor(Math.random() * candidates.length)];
  if (!randomConnection || !randomConnection.id) {
    ctx.log("error", "Could not select jump target - trapped!");
    return false;
  }

  ctx.log("travel", `Emergency jump to ${randomConnection.name || randomConnection.id}!`);
  
  // Start the jump command
  const jumpPromise = bot.exec("jump", { target_system: randomConnection.id });
  
  // Start battle status polling while jump is pending
  // This detects silent battle locks (when server regresses and doesn't send interruption message)
  const battlePollInterval = 5000; // Check every 5 seconds
  const battlePollTimeout = 25000; // Give up after 25 seconds (slightly more than the 20s window)
  let pollTimer: NodeJS.Timeout | null = null;
  let jumpCompleted = false;
  let battleDetectedDuringJump = false;
  let fleeIssued = false;

  const battlePoll = async () => {
    let elapsed = 0;
    while (elapsed < battlePollTimeout && !jumpCompleted) {
      await new Promise(resolve => {
        pollTimer = setTimeout(resolve, battlePollInterval);
      });
      elapsed += battlePollInterval;

      if (jumpCompleted) break;

      // CRITICAL: Check WebSocket battle state FIRST (fastest detection, no API call)
      // This catches battles even when the jump command is hung/slow to respond
      if (bot.isInBattle()) {
        ctx.log("combat", `[EMERGENCY] Battle detected via WebSocket during jump polling! Issuing flee immediately!`);
        battleDetectedDuringJump = true;
        jumpCompleted = true;
        // Issue flee IMMEDIATELY - don't wait for jump promise to resolve
        // The jump command can't be cancelled, but we need to start fleeing NOW
        fleeFromBattle(ctx).catch(err => ctx.log("error", `Emergency flee failed: ${(err as Error).message}`));
        fleeIssued = true;
        return;
      }

      // Also check battle status via API (fallback for edge cases)
      const currentBattleStatus = await getBattleStatus(ctx);
      if (currentBattleStatus && currentBattleStatus.is_participant) {
        ctx.log("combat", `[EMERGENCY] Battle detected via API during jump polling! Battle ID: ${currentBattleStatus.battle_id} - fleeing immediately!`);
        battleDetectedDuringJump = true;
        jumpCompleted = true;
        // Issue flee IMMEDIATELY
        fleeFromBattle(ctx).catch(err => ctx.log("error", `Emergency flee failed: ${(err as Error).message}`));
        fleeIssued = true;
        return;
      }

      // Also verify we're still in the same system (jump hasn't silently succeeded)
      await bot.refreshLocation();
      if (bot.system !== actualCurrentSystem) {
        ctx.log("travel", `[EMERGENCY] System changed during poll - jump succeeded to ${bot.system}`);
        jumpCompleted = true;
        return;
      }

      ctx.log("combat", `[EMERGENCY] Battle poll ${Math.floor(elapsed / 1000)}s - still in system ${actualCurrentSystem}, no battle detected`);
    }
  };

  // Run both the jump and the battle poll concurrently
  // Note: Promise.all waits for both, but the poll issues flee immediately if battle detected
  const [jumpResp] = await Promise.all([
    jumpPromise,
    battlePoll(),
  ]);

  // Clean up timer
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  jumpCompleted = true;

  // If battle was detected during polling and flee was already issued, check if we survived
  if (fleeIssued) {
    // Flee was already issued - check if we're still alive and in battle
    await bot.refreshLocation();
    if (bot.isInBattle()) {
      // Still in battle after flee - try again
      ctx.log("combat", "Still in battle after emergency flee - retrying flee stance!");
      return await fleeFromBattle(ctx);
    }
    // Flee succeeded or battle ended
    ctx.log("combat", "Emergency flee completed - checking if we escaped");
    return bot.system !== actualCurrentSystem;
  }

  if (jumpResp.error) {
    ctx.log("error", `Emergency jump failed: ${jumpResp.error.message}`);
    
    // Check if we're now in battle (silent lock detection)
    const postFailBattleStatus = await getBattleStatus(ctx);
    if (postFailBattleStatus && postFailBattleStatus.is_participant) {
      ctx.log("combat", "Battle detected after jump failure - switching to battle flee!");
      return await fleeFromBattle(ctx);
    }
    
    return false;
  }

  // Verify jump succeeded by checking system
  await bot.refreshLocation();
  if (bot.system === actualCurrentSystem) {
    ctx.log("error", `Jump reported success but still in ${actualCurrentSystem} - jump may have silently failed!`);
    
    // Check if battle started during the jump
    const postJumpBattleStatus = await getBattleStatus(ctx);
    if (postJumpBattleStatus && postJumpBattleStatus.is_participant) {
      ctx.log("combat", "Battle detected after silent jump failure - switching to battle flee!");
      return await fleeFromBattle(ctx);
    }
    
    return false;
  }

  ctx.log("combat", `Successfully escaped to ${bot.system}!`);
  return true;
}

/**
 * Check for pirates in nearby and flee if detected.
 * Should be called after get_nearby in non-combat routines.
 * @param ctx - Routine context
 * @param nearbyResult - Result from get_nearby API call
 * @param isJumpCommand - Whether the previous command was a jump (if true, we're already escaping)
 * @returns true if pirates were detected and flee was attempted, false if no pirates
 */
export async function checkAndFleeFromPirates(
  ctx: RoutineContext,
  nearbyResult: unknown,
  isJumpCommand: boolean = false,
): Promise<boolean> {
  const pirateResult = parseNearbyForPirates(nearbyResult);

  if (!pirateResult.hasPirates) {
    return false;
  }

  // Pirates detected!
  if (isJumpCommand) {
    // We just jumped - already fleeing, but log the threat
    ctx.log("combat", `Pirates detected in system (${pirateResult.pirateCount}x, tier: ${pirateResult.highestTier}) - continuing escape`);
    return true;
  }

  // Not a jump command - we need to flee NOW
  await emergencyFleeFromPirates(ctx, pirateResult);
  return true;
}

/**
 * Detect pirates from battle participant data.
 * This is a fallback when get_nearby fails or during battle.
 * @param battleParticipants - Array of battle participants from battle_update
 * @returns PirateDetectionResult with detected pirates
 */
export function parsePiratesFromBattleParticipants(battleParticipants: unknown[]): PirateDetectionResult {
  if (!Array.isArray(battleParticipants)) {
    return { hasPirates: false, pirateCount: 0, highestTier: null, pirates: [] };
  }

  const pirates: NearbyEntity[] = [];

  for (const participant of battleParticipants) {
    if (!participant || typeof participant !== "object") continue;
    const p = participant as Record<string, unknown>;

    // Check if this is a pirate participant
    // Pirates typically have faction_id that doesn't match player factions
    // Or they might be identified by ship class names like "raider", "eviction_notice", etc.
    const playerId = (p.player_id as string) || "";
    const username = (p.username as string) || (p.name as string) || "";
    const shipClass = (p.ship_class as string) || "";
    const factionId = (p.faction_id as string) || "";

    // Known pirate ship classes (from game data and logs)
    const pirateShipClasses = [
      "raider",
      "eviction_notice",
      "buccaneer",
      "marauder",
      "freebooter",
      "corsair",
      "plunderer",
      "reaver",
      "predator",
      "banshee",
    ];

    // Check if ship class indicates pirate
    const isPirateShip = pirateShipClasses.some(cls => 
      shipClass.toLowerCase().includes(cls) || shipClass.toLowerCase() === cls
    );

    // Also check for pirate faction IDs (these are faction IDs that belong to pirates)
    // From the log: Breacher (raider) is attacking - ship_class: eviction_notice
    const isPirateFaction = factionId && (
      factionId === "pirate" || 
      factionId.toLowerCase().includes("pirate") ||
      // Known pirate faction IDs from game
      factionId === "d8f3a7b2c1e4f5a6b7c8d9e0f1a2b3c4" || // Example - replace with actual IDs
      factionId === "pirates"
    );

    if (isPirateShip || isPirateFaction) {
      pirates.push({
        id: playerId || username,
        name: username || playerId,
        type: "pirate",
        faction: "pirate",
        isNPC: true,
        isPirate: true,
        tier: "raider", // Default to raider for battle-detected pirates
        isBoss: false,
        hull: p.hull_pct as number,
        maxHull: 100,
        shield: p.shield_pct as number,
        maxShield: 100,
        status: p.stance as string,
      });
    }
  }

  let highestTier: PirateTier | null = null;
  let highestThreat = 0;
  for (const pirate of pirates) {
    if (pirate.tier) {
      const threat = getPirateThreatLevel(pirate.tier);
      if (threat > highestThreat) {
        highestThreat = threat;
        highestTier = pirate.tier;
      }
    }
  }

  return {
    hasPirates: pirates.length > 0,
    pirateCount: pirates.length,
    highestTier,
    pirates,
  };
}

/**
 * Minimal shape that both BattleNotification (from notification parsing) and
 * BattleStatus (from get_battle_status API polling) satisfy. Used by
 * formatBattleUpdateDebug so either code path can produce consistent debug
 * output.
 */
interface BattleDebugData {
  your_stance?: string;
  your_zone?: string;
  your_side_id?: number;
  participants?: Array<Record<string, unknown>>;
  sides?: Array<Record<string, unknown>>;
  tick?: number;
}

/**
 * Format a one-line debug summary of every participant in a battle_update,
 * partitioning them into enemies vs friendlies relative to our own side.
 *
 * Produces output like:
 *   ⚔ [BattleUpdate tick:42] self[stance:fire zone:outer] @ SYYS-123/Poi-45 | enemies(2):
 *     - Raider (pirate) [zone:outer dist:3] hull:45% shields:90% stance:fire target:None
 *     - Breacher (pirate) [zone:mid dist:1] hull:100% shields:100% stance:fire target:None
 *   friendlies(1):
 *     - MyBot (player) [zone:engaged dist:0] hull:80% shields:60% stance:fire target:Raider
 *
 * @param data  Battle notification or status with stance/zone/participants
 * @param botSystem  Current system ID of the bot
 * @param botPoi  Current POI ID of the bot
 */
export function formatBattleUpdateDebug(
  data: BattleDebugData,
  botSystem: string | undefined,
  botPoi: string | undefined,
): string {
  const lines: string[] = [];

  const stance = data.your_stance || "unknown";
  const zone = data.your_zone || "unknown";
  const ourSide = data.your_side_id;

  const loc = botSystem || "?";
  const poi = botPoi ? `/${botPoi}` : "";
  lines.push(`\x1b[96m⚔ [BattleUpdate tick:${data.tick ?? "?"}] self[stance:${stance} zone:${zone}] @ ${loc}${poi}\x1b[0m`);

  const participants = data.participants;
  if (!participants || participants.length === 0) {
    lines.push("  (no participant data — server returned empty participant list)");
    return lines.join("\n");
  }

  const enemies: Record<string, unknown>[] = [];
  const friendlies: Record<string, unknown>[] = [];

  for (const p of participants) {
    if (!p || typeof p !== "object") continue;
    const sideId = (p.side_id as number | undefined);
    if (ourSide !== undefined && sideId !== undefined && sideId !== ourSide) {
      enemies.push(p);
    } else {
      friendlies.push(p);
    }
  }

  const hpColor = (pct: number): string =>
    pct < 30 ? "\x1b[91m" : pct < 70 ? "\x1b[93m" : "\x1b[92m";
  const RESET = "\x1b[0m";

  const fmt = (p: Record<string, unknown>, color: string) => {
    const username = (p.username as string) || (p.ship_name as string) || "???";
    const kind = (p.kind as string) || "";
    const shipClass = (p.ship_class as string) || "";
    const hull = (p.hull_pct as number) ?? (p.hull_percent as number) ?? 0;
    const shields = (p.shield_pct as number) ?? (p.shield_percent as number) ?? 0;
    const pzone = (p.zone as string) || "?";
    const dist = (p.zone_distance as number) ?? "?";
    const stanceP = (p.stance as string) || "-";
    const target = (p.target_id as string) || "";
    const targetDisplay = target || "None";
    const isNpc = (p.is_npc as boolean);
    const shipInfo = [shipClass, kind].filter(Boolean).join("/");
    const tag = isNpc ? "[NPC]" : "[P]";
    const label = shipInfo ? `${shipInfo} ` : "";
    const hc = hpColor(hull);
    const sc = hpColor(shields);
    return `    - ${color}${username}${RESET} ${tag}${label} [zone:${pzone} dist:${dist}] hull:${hc}${hull}%${RESET} shields:${sc}${shields}%${RESET} stance:${stanceP} target:${targetDisplay}`;
  };

  if (enemies.length > 0) {
    lines.push(`\x1b[91m  enemies(${enemies.length}):${RESET}`);
    for (const e of enemies) lines.push(fmt(e as Record<string, unknown>, "\x1b[91m"));
  } else {
    lines.push("  enemies(0): none");
  }

  if (friendlies.length > 0) {
    lines.push(`\x1b[92m  friendlies(${friendlies.length}):${RESET}`);
    for (const f of friendlies) lines.push(fmt(f as Record<string, unknown>, "\x1b[92m"));
  } else {
    lines.push("  friendlies(0): none");
  }

  return lines.join("\n");
}

// ── Customs Inspection ───────────────────────────────────────────

/**
 * Check for customs inspection when entering a new system.
 * Should be called after travel/jump commands when entering empire space.
 *
 * @param ctx - Routine context
 * @param targetSystem - The system we jumped to (for accurate logging since bot.system may be unstable during jumps)
 * @returns Object with inspection result
 */
export async function checkCustomsInspection(
  ctx: RoutineContext,
  targetSystem?: string
): Promise<{
  wasStopped: boolean;
  outcome: "cleared" | "contraband" | "evasion" | "timeout" | "none";
  chatMessages: string[];
}> {
  const { bot } = ctx;

  // If customs stopping/lockouts are globally disabled (Settings → General),
  // skip the inspection entirely so bots never get stopped or locked out.
  if (isCustomsDisabled()) {
    ctx.log("customs", "Customs stopping disabled in settings - skipping inspection");
    return { wasStopped: false, outcome: "none", chatMessages: [] };
  }

  // Use targetSystem if provided, otherwise fall back to bot.system
  const systemToCheck = targetSystem || bot.system;

  // Get the system's security level from mapStore
  const sysData = mapStore.getSystem(systemToCheck);
  const securityLevel = sysData?.security_level;

  // Only check if we're in an empire system (not Frontier, not pirate, not lawless)
  if (!isEmpireSystem(systemToCheck, bot.getEmpire(), securityLevel)) {
    ctx.log("customs", `System ${systemToCheck} is not an empire system (or bot is Frontier, or system is lawless) - no customs check needed`);
    return { wasStopped: false, outcome: "none", chatMessages: [] };
  }

  ctx.log("customs", `Entering empire system ${systemToCheck} - checking for customs...`);

  // PROACTIVE: Always wait at least 2 seconds for customs message to arrive
  // This is mandatory for all empire jumps, even if no message has arrived yet
  ctx.log("customs", "⏱️ Mandatory customs wait - 2 second delay...");
  await sleep(2000);

  // Wait for customs inspection (up to 90 seconds total)
  const result = await waitForCustomsInspection(bot, (cat, msg) => bot.log(cat, msg), systemToCheck, 90000);

  // If customs ship is expected but not yet visible, poll for it
  if (result.wasStopped && result.outcome === "timeout") {
    ctx.log("customs", "Customs scan in progress - polling for customs ship...");
    const pollResult = await pollForCustomsShip(
      bot,
      (cat, msg) => bot.log(cat, msg),
      5000, // Poll every 5 seconds
      6     // Max 6 polls (30 seconds total)
    );

    if (pollResult.customsShipFound && pollResult.shipName) {
      ctx.log("customs", `Customs ship ${pollResult.shipName} detected!`);
    }
  }

  return result;
}

/**
 * Get customs statistics for AI chat context.
 */
export { getBotCustomsStats };

export const MOBILE_CAPITAL_NOT_FOUND_REGEX = /It's called a Mobile Capital for a reason[^.]*\.?\s*Jump to (\w+) to find it/i;

export function parseTravelHint(errorMessage: string): string | null {
  if (!errorMessage) return null;
  const match = MOBILE_CAPITAL_NOT_FOUND_REGEX.exec(errorMessage);
  return match ? match[1] : null;
}

export async function smartTravel(
  ctx: RoutineContext,
  stationId: string,
  opts?: {
    fuelThresholdPct?: number;
    hullThresholdPct?: number;
    noJettison?: boolean;
    autoCloak?: boolean;
  },
): Promise<{ success: boolean; usedHint: boolean; hintSystem?: string }> {
  const { bot } = ctx;
  const maxRetries = 3;
  let hintSystem: string | null = null;
  let usedHint = false;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    ctx.log("travel", `Traveling to ${stationId}... (attempt ${attempt + 1}/${maxRetries})`);
    const travelResp = await bot.exec("travel", { target_poi: stationId });

    if (!travelResp.error) {
      ctx.log("travel", `Arrived at ${stationId}`);
      return { success: true, usedHint, hintSystem: hintSystem || undefined };
    }

    const errorMsg = travelResp.error?.message || "";
    ctx.log("error", `Travel failed: ${errorMsg}`);

    if (!hintSystem) {
      const parsedHint = parseTravelHint(errorMsg);
      if (parsedHint) {
        ctx.log("travel", `[error] travel: It's called a Mobile Capital for a reason — it's not here right now. Jump to ${parsedHint} to find it.`);
        hintSystem = parsedHint;
        usedHint = true;
      }
    }

    if (hintSystem && attempt < maxRetries - 1) {
      ctx.log("travel", `Rerouting to hint system ${hintSystem}...`);
      const navResult = await navigateToSystem(ctx, hintSystem, {
        fuelThresholdPct: opts?.fuelThresholdPct ?? 40,
        hullThresholdPct: opts?.hullThresholdPct ?? 30,
        noJettison: opts?.noJettison,
        autoCloak: opts?.autoCloak,
      });

      if (!navResult) {
        ctx.log("error", `Failed to navigate to hint system ${hintSystem}`);
        return { success: false, usedHint, hintSystem };
      }

      const jumpResp = await bot.exec("jump", { target_system: hintSystem });
      if (jumpResp.error && !jumpResp.error.message.includes("already")) {
        ctx.log("error", `Jump to ${hintSystem} failed: ${jumpResp.error.message}`);
        return { success: false, usedHint, hintSystem };
      }

      ctx.log("travel", `Jumped to ${hintSystem}, retrying travel to ${stationId}...`);
      hintSystem = null;
    }
  }

  return { success: false, usedHint, hintSystem: hintSystem || undefined };
}

export async function travelToStationWithHint(
  ctx: RoutineContext,
  stationId: string,
  stationName: string,
  targetSystemId: string,
  opts: {
    fuelThresholdPct: number;
    hullThresholdPct: number;
    noJettison?: boolean;
    autoCloak?: boolean;
    hint?: string;
    maxRetries?: number;
  }
): Promise<{ success: boolean; usedHint: boolean; hintSystem?: string }> {
  const { bot } = ctx;
  const maxRetries = opts.maxRetries ?? 3;
  let hintSystem = opts.hint || null;
  let usedHint = false;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    ctx.log("travel", `Traveling to ${stationName || stationId}... (attempt ${attempt + 1}/${maxRetries})`);
    const travelResp = await bot.exec("travel", { target_poi: stationId });

    if (!travelResp.error) {
      ctx.log("travel", `Arrived at ${stationName || stationId}`);
      return { success: true, usedHint, hintSystem: hintSystem || undefined };
    }

    const errorMsg = travelResp.error?.message || "";
    ctx.log("error", `Travel failed: ${errorMsg}`);

    if (!hintSystem) {
      const parsedHint = parseTravelHint(errorMsg);
      if (parsedHint) {
        ctx.log("travel", `Received hint: Jump to ${parsedHint} to find it`);
        hintSystem = parsedHint;
        usedHint = true;
      }
    }

    if (hintSystem && attempt < maxRetries - 1) {
      ctx.log("travel", `Rerouting to hint system ${hintSystem}...`);
      const navResult = await navigateToSystem(ctx, hintSystem, {
        fuelThresholdPct: opts.fuelThresholdPct,
        hullThresholdPct: opts.hullThresholdPct,
        noJettison: opts.noJettison,
        autoCloak: opts.autoCloak,
      });

      if (!navResult) {
        ctx.log("error", `Failed to navigate to hint system ${hintSystem}`);
        return { success: false, usedHint, hintSystem };
      }

      targetSystemId = hintSystem;
      hintSystem = null;
    }
  }

  return { success: false, usedHint, hintSystem: hintSystem || undefined };
}
