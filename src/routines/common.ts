/**
 * Shared utilities for all bot routines.
 *
 * Provides: docking, refueling, repairing, navigation, system parsing,
 * ore parsing, and safety checks.
 */
import type { RoutineContext } from "../bot.js";
import type { BattleStatus, BattleSide, BattleParticipant, BattleZone, BattleStance } from "../types/game.js";
import { catalogStore } from "../catalogstore.js";
import { mapStore } from "../mapstore.js";
import { getSystemBlacklist } from "../web/server.js";
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

/**
 * Check if the bot's current state indicates it should stop (e.g., due to emergency warp).
 * This is a convenience helper for routines to check between actions.
 * The actual detection and stop is handled automatically by bot.ts log method.
 */
export function shouldStopForEmergency(ctx: RoutineContext): boolean {
  return ctx.bot.state !== "running";
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

/** Check if a POI is an ore belt (asteroid belt/field/ring/nebula — NOT gas clouds or ice fields). */
export function isOreBeltPoi(type: string): boolean {
  const t = type.toLowerCase();
  if (t.includes("gas") || t.includes("cloud") || t.includes("ice")) return false;
  return t.includes("asteroid") || t.includes("belt") || t.includes("ring")
    || t.includes("field") ||  t.includes("nebula") || t.includes("resource");
}

/** Check if a POI is a gas cloud. */
export function isGasCloudPoi(type: string): boolean {
  const t = type.toLowerCase();
  return t.includes("gas") || t.includes("cloud") || t.includes("nebula");
}

/** Check if a POI is an ice field. */
export function isIceFieldPoi(type: string): boolean {
  const t = type.toLowerCase();
  return t.includes("ice");
}

/** Check if a POI type is purely scenic (only needs one visit). */
export function isScenicPoi(type: string): boolean {
  const t = type.toLowerCase();
  return t === "sun" || t === "star" || t === "wormhole" || t === "jump_gate";
}

// ── Item size helpers ────────────────────────────────────────

/** Get the cargo size (weight per unit) of an item from the catalog. Defaults to 1 if unknown. */
export function getItemSize(itemId: string): number {
  const item = catalogStore.getItem(itemId);
  const size = item?.size as number | undefined;
  return (size && size > 0) ? size : 1;
}

/** How many units of an item fit in the given free cargo weight. */
export function maxItemsForCargo(freeWeight: number, itemId: string): number {
  if (freeWeight <= 0) return 0;
  return Math.floor(freeWeight / getItemSize(itemId));
}

/** Check if a POI represents a station. */
export function isStationPoi(poi: SystemPOI): boolean {
  return poi.has_base || (poi.type || "").toLowerCase() === "station";
}

/** Find the first station POI in a list. Optionally filter by required service. */
export function findStation(pois: SystemPOI[], requiredService?: keyof BaseServices, excludePirates: boolean = true): SystemPOI | null {
  if (requiredService) {
    // Prefer station with the required service
    const withService = pois.find(p => isStationPoi(p) && p.services?.[requiredService] !== false && !(excludePirates && isPirateSystem(p.id)));
    if (withService) return withService;
  }
  return pois.find(p => isStationPoi(p) && !(excludePirates && isPirateSystem(p.id))) || null;
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

/** Get the system ID for a known salvage yard station. */
export function getSystemForSalvageYard(stationId: string): string | null {
  // Mobile capitol is dynamic - use the tracked location
  if (stationId === "mobile_capital") {
    return getMobileCapitolSystem();
  }
  
  // Map other salvage yard stations to their systems
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
      const id = (c.system_id as string) || (c.id as string)
        || (c.target_system as string) || (c.target as string)
        || (c.destination as string) || "";
      if (!id) continue;
      connections.push({
        id,
        name: (c.system_name as string) || (c.name as string) || id,
        jump_cost: (c.jump_cost as number) ?? null,
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
  const ore = mr.item ?? mr.ore ?? mr.mined;
  let oreId = "";
  let oreName = "";

  if (ore && typeof ore === "object") {
    const oreObj = ore as Record<string, unknown>;
    oreId = (oreObj.item_id as string) || (oreObj.id as string) || (oreObj.name as string) || "";
    oreName = (oreObj.name as string) || oreId;
  } else {
    oreId = (mr.resource_id as string) || (mr.item_id as string) || (mr.ore_id as string) || "";
    oreName = (mr.resource_name as string) || (mr.item_name as string) || (mr.ore_name as string) || (mr.name as string) || oreId;
  }

  return { oreId, oreName };
}

// ── Docking ──────────────────────────────────────────────────

/** Ensure the bot is docked at a station. Finds one in current system,
 *  or navigates to the nearest known station system if none is available.
 *  Returns true if successfully docked.
 *  @param skipStorageCollection If true, skips automatic storage collection (withdraw credits).
 *  @param minBalance Minimum credits to keep on bot when collecting from storage (only withdraw if below this). If 0, withdraws all.
 */
export async function ensureDocked(ctx: RoutineContext, skipStorageCollection: boolean = true, minBalance: number = 0): Promise<boolean> {
  const { bot } = ctx;
  if (bot.docked) return true;

  // Refresh status first to ensure we have the latest docked state
  await bot.refreshStatus();
  if (bot.docked) return true;

  const { pois } = await getSystemInfo(ctx);
  const station = findStation(pois);

  if (station) {
    if (bot.poi !== station.id) {
      ctx.log("travel", `Traveling to ${station.name}...`);
      const travelResp = await bot.exec("travel", { target_poi: station.id });
      if (travelResp.error && !travelResp.error.message.includes("already")) {
        ctx.log("error", `Travel to station failed: ${travelResp.error.message}`);
        // Fall through to search for nearest station
      } else {
        bot.poi = station.id;
        // Refresh status after travel to update position
        await bot.refreshStatus();
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
      // Dock failed at current POI - check if it's "No base at this location"
      if (dockResp.error?.message?.includes("No base at this location")) {
        ctx.log("error", `No dockable base at current POI (${bot.poi}) — searching for nearest station...`);
        // Don't fall through to "No station in current system" - we know we need a different station
        // Jump directly to the nearest station system
      } else {
        ctx.log("error", `Dock failed: ${dockResp.error.message}`);
        // Fall through to search for nearest station
      }
    }
  }

  // No station in current system — find nearest known station
  ctx.log("system", "No station in current system — searching for nearest station...");
  const blacklist = getSystemBlacklist();
  const nearest = mapStore.findNearestStationSystem(bot.system, blacklist);
  if (!nearest) {
    ctx.log("error", "No known station in mapped systems — cannot dock");
    return false;
  }

  ctx.log("travel", `Nearest station: ${nearest.poiName} in ${nearest.systemId} (${nearest.hops} hops)`);

  // Navigate there
  if (nearest.systemId !== bot.system) {
    await ensureUndocked(ctx);
    const route = mapStore.findRoute(bot.system, nearest.systemId, blacklist);
    if (route && route.length > 1) {
      for (let i = 1; i < route.length; i++) {
        if (bot.state !== "running") return false;
        ctx.log("travel", `Jumping to ${route[i]} (${i}/${route.length - 1})...`);
        const jumpResp = await bot.exec("jump", { target_system: route[i] });
        if (jumpResp.error) {
          ctx.log("error", `Jump failed: ${jumpResp.error.message}`);
          // Check if we actually made the jump despite the error
          await bot.refreshStatus();
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
        await bot.refreshStatus();
        if (bot.system.toLowerCase() !== nearest.systemId.toLowerCase()) {
          return false; // Jump truly failed
        }
        ctx.log("travel", `Jump succeeded despite error (server confirmed position)`);
      }
    }
    // Refresh status after navigation
    await bot.refreshStatus();
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

  ctx.log("error", `Dock failed at ${nearest.poiName}: ${dResp.error?.message}`);
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
  const resp = await bot.exec("analyze_market", { mode: "overview" });
  if (!resp.error && resp.result && typeof resp.result === "object") {
    const r = resp.result as Record<string, unknown>;
    const insights = r.top_insights as Array<Record<string, unknown>> | undefined;
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
      const wResp = await bot.exec("withdraw_credits", { amount: amountToWithdraw });
      if (!wResp.error) {
        ctx.log("trade", `Collected ${amountToWithdraw} credits from storage`);
        await bot.refreshStatus();
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
  await bot.refreshStatus();

  const fuelPct = bot.maxFuel > 0 ? (bot.fuel / bot.maxFuel) * 100 : bot.fuel;
  if (fuelPct > 5) return true; // not actually stranded

  ctx.log("error", "EMERGENCY: Stranded with no fuel — attempting recovery...");

  // First: scavenge nearby wrecks/containers for fuel cells
  if (!bot.docked) {
    ctx.log("scavenge", "Checking for nearby fuel cells or containers...");
    const looted = await scavengeWrecks(ctx);
    if (looted > 0) {
      // Try refueling from cargo (fuel cells)
      ctx.log("system", "Found items — attempting refuel from cargo...");
      const refuelResp = await bot.exec("refuel");
      if (!refuelResp.error) {
        await bot.refreshStatus();
        const newFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : bot.fuel;
        ctx.log("system", `Recovery via scavenge successful! Fuel: ${newFuel}%`);
        return true;
      }
    }
  }

  // Try to dock at current location
  if (!bot.docked) {
    const dockResp = await bot.exec("dock");
    if (!dockResp.error || dockResp.error.message.includes("already")) {
      bot.docked = true;
      ctx.log("system", "Managed to dock — checking storage, selling cargo, refueling...");
      await collectFromStorage(ctx);
      await sellAllCargo(ctx);
      await bot.refreshStatus();
      const refuelResp = await bot.exec("refuel");
      if (!refuelResp.error) {
        await bot.refreshStatus();
        ctx.log("system", `Recovery successful! Fuel: ${bot.fuel}/${bot.maxFuel}`);
        return true;
      }
    }
  }

  // If docked but still can't refuel, sell cargo and try again
  if (bot.docked) {
    await sellAllCargo(ctx);
    await bot.refreshStatus();
    const refuelResp = await bot.exec("refuel");
    if (!refuelResp.error) {
      await bot.refreshStatus();
      ctx.log("system", `Recovery successful! Fuel: ${bot.fuel}/${bot.maxFuel}`);
      return true;
    }

    // Still can't refuel — stay docked and wait (rescue bot may help, or station restocks)
    ctx.log("system", "Cannot refuel — staying docked and waiting for help...");
    for (let w = 0; w < REFUEL_WAIT_RETRIES && bot.state === "running"; w++) {
      await sleep(REFUEL_WAIT_INTERVAL);
      await bot.refreshStatus();
      const fuelNow = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
      if (fuelNow > 5) {
        ctx.log("system", `Fuel recovered to ${fuelNow}% — resuming`);
        return true;
      }
      // Try selling + refueling each cycle
      await sellAllCargo(ctx);
      const retryResp = await bot.exec("refuel");
      if (!retryResp.error) {
        await bot.refreshStatus();
        ctx.log("system", `Refuel succeeded after wait! Fuel: ${bot.fuel}/${bot.maxFuel}`);
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

/** Attempt to refuel to full. Calls refuel repeatedly until tank is full.
 *  If broke, sells cargo. If still can't refuel, waits at station and retries.
 *  Assumes docked. */
export async function tryRefuel(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;
  await bot.refreshStatus();

  let fuelPct = bot.maxFuel > 0 ? (bot.fuel / bot.maxFuel) * 100 : bot.fuel;
  if (fuelPct >= 95) return;

  const startFuel = Math.round(fuelPct);

  // Check if current station has refuel service
  const { pois } = await getSystemInfo(ctx);
  const currentStation = pois.find(p => isStationPoi(p) && p.id === bot.poi);
  if (currentStation?.services && currentStation.services.refuel === false) {
    const refuelStation = findStation(pois, "refuel");
    if (refuelStation && refuelStation.id !== currentStation.id) {
      await bot.exec("undock");
      bot.docked = false;
      await bot.exec("travel", { target_poi: refuelStation.id });
      bot.poi = refuelStation.id;
      const dResp = await bot.exec("dock");
      if (!dResp.error || dResp.error.message.includes("already")) {
        bot.docked = true;
        await collectFromStorage(ctx);
      } else {
        ctx.log("error", `Dock at ${refuelStation.name} failed: ${dResp.error.message}`);
        return;
      }
    }
  }

  // Call refuel repeatedly until full or until it fails
  let consecutiveErrors = 0;
  for (let i = 0; i < 10 && bot.state === "running"; i++) {
    const resp = await bot.exec("refuel");
    if (resp.error) {
      consecutiveErrors++;
      const msg = resp.error.message.toLowerCase();
      if (msg.includes("already full") || msg.includes("tank_full") || msg.includes("max")) {
        break;
      }
      if (msg.includes("credit") || msg.includes("fuel_source") || msg.includes("insufficient")) {
        const sold = await sellAllCargo(ctx);
        if (sold > 0) {
          await bot.refreshStatus();
          continue;
        }
      }
      if (consecutiveErrors >= 2) break;
      continue;
    }

    consecutiveErrors = 0;
    await bot.refreshStatus();
    fuelPct = bot.maxFuel > 0 ? (bot.fuel / bot.maxFuel) * 100 : bot.fuel;
    if (fuelPct >= 95) break;
  }

  await bot.refreshStatus();
  fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
  if (fuelPct >= 50) {
    if (fuelPct > startFuel) ctx.log("system", `Refueled ${startFuel}% → ${fuelPct}%`);
    return;
  }

  // Fuel still low — wait at station and retry periodically
  for (let attempt = 1; attempt <= REFUEL_WAIT_RETRIES && bot.state === "running"; attempt++) {
    ctx.log("system", `Fuel still at ${fuelPct}% — waiting at station (attempt ${attempt}/${REFUEL_WAIT_RETRIES})...`);
    await sleep(REFUEL_WAIT_INTERVAL);

    // Retry: sell + refuel
    await sellAllCargo(ctx);
    await bot.exec("refuel");
    await bot.refreshStatus();
    fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    if (fuelPct >= 50) {
      ctx.log("system", `Fuel recovered to ${fuelPct}% — continuing`);
      return;
    }
  }

  await bot.refreshStatus();
  ctx.log("error", `Could not refuel after ${REFUEL_WAIT_RETRIES} waits — fuel: ${bot.fuel}/${bot.maxFuel}`);
}

// ── Repair ───────────────────────────────────────────────────

/** Repair the ship if damaged. Assumes docked. */
export async function repairShip(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;
  await bot.refreshStatus();
  const hullPct = bot.maxHull > 0 ? (bot.hull / bot.maxHull) * 100 : 100;
  if (hullPct < 95) {
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
        } else {
          ctx.log("error", `Dock at ${repairStation.name} failed: ${dResp.error.message}`);
          return;
        }
      }
    }

    await bot.exec("repair");
    await bot.refreshStatus();
    const endHull = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    if (endHull > startHull) ctx.log("system", `Repaired hull ${startHull}% → ${endHull}%`);
  }
}

// ── Safety checks ────────────────────────────────────────────

/** Check fuel and hull, dock/refuel/repair if below thresholds.
 *  Uses ensureFueled() for robust cross-system fuel recovery. */
export async function safetyCheck(
  ctx: RoutineContext,
  opts: { fuelThresholdPct: number; hullThresholdPct: number },
): Promise<boolean> {
  const { bot } = ctx;
  await bot.refreshStatus();

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
    const ok = await ensureFueled(ctx, opts.fuelThresholdPct);
    if (!ok) return false;
  }
  return true;
}

/**
 * Ensure the bot has adequate fuel. If below threshold:
 * 1. Jettison non-fuel cargo to make room, scavenge nearby fuel cells
 * 2. Try to refuel at a station in the current system
 * 3. If no local station, find the nearest known system with a station and navigate there
 * Returns true if fuel is now adequate, false if stranded.
 */
export async function ensureFueled(
  ctx: RoutineContext,
  thresholdPct: number,
  opts?: { noJettison?: boolean },
): Promise<boolean> {
  const { bot } = ctx;
  await bot.refreshStatus();
  let fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
  if (fuelPct >= thresholdPct) return true;

  ctx.log("system", `Fuel low (${fuelPct}%) — need to refuel (threshold: ${thresholdPct}%)...`);

  // Step 1: Try local station first — dock and refuel with credits, no cargo loss
  const { pois } = await getSystemInfo(ctx);
  const localStation = findStation(pois);

  if (localStation) {
    ctx.log("system", `Station found in current system: ${localStation.name}`);
    const ok = await refuelAtStation(ctx, localStation, thresholdPct);
    if (ok) return true;
    // refuelAtStation failed — try emergency
    return await emergencyFuelRecovery(ctx);
  }

  // Step 2: No local station — try fuel cells already in cargo
  if (!bot.docked) {
    const refuelResp = await bot.exec("refuel");
    if (!refuelResp.error) {
      await bot.refreshStatus();
      fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
      if (fuelPct >= thresholdPct) {
        ctx.log("system", `Refueled from cargo — fuel now ${fuelPct}%`);
        return true;
      }
    }

    // Step 3: Nearly out of fuel — scavenge wrecks for fuel as last resort (never jettison cargo)
    if (bot.fuel <= 1) {
      ctx.log("system", "Nearly out of fuel — scavenging for fuel cells...");
      const looted = await scavengeWrecks(ctx, { fuelOnly: true });
      if (looted > 0) {
        const scavRefuel = await bot.exec("refuel");
        if (!scavRefuel.error) {
          await bot.refreshStatus();
          fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
          if (fuelPct >= thresholdPct) {
            ctx.log("system", `Scavenged fuel cells — fuel now ${fuelPct}%`);
            return true;
          }
        }
      }
    }
  }

  // Step 4: No local station — find nearest known system with one
  ctx.log("system", "No station in current system — searching known map for nearest station...");
  const blacklist = getSystemBlacklist();
  const nearest = mapStore.findNearestStationSystem(bot.system, blacklist);
  if (!nearest) {
    ctx.log("error", "No known station in mapped systems — emergency recovery...");
    return await emergencyFuelRecovery(ctx);
  }

  ctx.log("travel", `Nearest station: ${nearest.poiName} in ${nearest.systemId} (${nearest.hops} jump${nearest.hops !== 1 ? "s" : ""} away)`);

  // Navigate there — use navigateToSystem if in a different system
  if (nearest.systemId !== bot.system) {
    // Check if we have enough fuel for at least one jump
    await bot.refreshStatus();
    const curFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    if (curFuel < 10) {
      ctx.log("error", `Fuel too low (${curFuel}%) to reach station — emergency recovery...`);
      return await emergencyFuelRecovery(ctx);
    }

    await ensureUndocked(ctx);

    // Jump system by system toward the station
    const route = mapStore.findRoute(bot.system, nearest.systemId, blacklist);
    if (route && route.length > 1) {
      for (let i = 1; i < route.length; i++) {
        if (bot.state !== "running") return false;
        await bot.refreshStatus();
        const preFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
        if (preFuel < 10) {
          ctx.log("error", `Fuel critical (${preFuel}%) mid-route — emergency recovery...`);
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
      // Direct jump
      ctx.log("travel", `Direct jump to ${nearest.systemId}...`);
      const jumpResp = await bot.exec("jump", { target_system: nearest.systemId });
      if (jumpResp.error) {
        ctx.log("error", `Jump failed: ${jumpResp.error.message}`);
        return await emergencyFuelRecovery(ctx);
      }
    }
  }

  // Now in the station system — travel, dock, refuel
  await bot.refreshStatus();
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
  } else {
    ctx.log("error", `Dock failed: ${dResp.error.message}`);
    return await emergencyFuelRecovery(ctx);
  }

  await tryRefuel(ctx);
  await bot.refreshStatus();
  let newFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
  ctx.log("system", `Refueled at ${nearest.poiName} — Fuel: ${newFuel}%`);

  // CRITICAL: Do NOT undock until fuel is adequate
  if (newFuel < thresholdPct) {
    ctx.log("system", `Fuel still below threshold (${newFuel}% < ${thresholdPct}%) — staying docked and waiting...`);
    for (let w = 0; w < REFUEL_WAIT_RETRIES && bot.state === "running"; w++) {
      await sleep(REFUEL_WAIT_INTERVAL);
      await bot.refreshStatus();
      await bot.exec("refuel");
      await bot.refreshStatus();
      newFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
      if (newFuel >= thresholdPct) {
        ctx.log("system", `Fuel recovered to ${newFuel}% — resuming`);
        break;
      }
      ctx.log("system", `Still waiting for fuel (${newFuel}%)... (${w + 1}/${REFUEL_WAIT_RETRIES})`);
    }
  }

  await bot.refreshStatus();
  newFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
  ctx.log("system", "Undocking...");
  await bot.exec("undock");
  bot.docked = false;
  return newFuel >= 10;
}

// ── Cargo deposit ──────────────────────────────────────────

/** Default home station for depositing cargo. */
const HOME_SYSTEM = "sol";
const HOME_STATION_POI = "sol_station";
const HOME_STATION_NAME = "Sol Central";

/**
 * Navigate to Sol Central and deposit all non-fuel cargo to station storage.
 * Used when cargo is full during exploration. Returns true if deposit succeeded.
 */
export async function depositCargoAtHome(
  ctx: RoutineContext,
  opts: { fuelThresholdPct: number; hullThresholdPct: number } = { fuelThresholdPct: 40, hullThresholdPct: 30 },
): Promise<boolean> {
  const { bot } = ctx;
  await bot.refreshStatus();

  ctx.log("trade", `Cargo full (${bot.cargo}/${bot.cargoMax}) — returning to ${HOME_STATION_NAME} to deposit...`);

  // Navigate to Sol if not already there
  if (bot.system !== HOME_SYSTEM) {
    await ensureUndocked(ctx);
    const arrived = await navigateToSystem(ctx, HOME_SYSTEM, opts);
    if (!arrived) {
      ctx.log("error", `Could not reach ${HOME_SYSTEM} — will try depositing at nearest station`);
      // Fallback: dock at any local station
      await ensureDocked(ctx);
      if (!bot.docked) return false;
      return await depositNonFuelCargo(ctx);
    }
  }

  // Travel to Sol Central station
  await ensureUndocked(ctx);
  if (bot.poi !== HOME_STATION_POI) {
    ctx.log("travel", `Traveling to ${HOME_STATION_NAME}...`);
    const tResp = await bot.exec("travel", { target_poi: HOME_STATION_POI });
    if (tResp.error && !tResp.error.message.includes("already")) {
      ctx.log("error", `Travel to ${HOME_STATION_NAME} failed: ${tResp.error.message}`);
      return false;
    }
    bot.poi = HOME_STATION_POI;
  }

  // Dock
  if (!bot.docked) {
    const dResp = await bot.exec("dock");
    if (dResp.error && !dResp.error.message.includes("already")) {
      ctx.log("error", `Dock failed at ${HOME_STATION_NAME}: ${dResp.error.message}`);
      return false;
    }
    bot.docked = true;
  }

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

/** Navigate to a target system via jump chain. Returns true if arrived. */
export async function navigateToSystem(
  ctx: RoutineContext,
  targetSystemId: string,
  opts: { fuelThresholdPct: number; hullThresholdPct: number; noJettison?: boolean; autoCloak?: boolean; onJump?: (jumpNumber: number) => Promise<boolean> },
): Promise<boolean> {
  const { bot } = ctx;
  const MAX_JUMPS = 199;
  const MAX_RETRIES_PER_JUMP = 10;
  const blacklist = getSystemBlacklist();

  // Normalize system names for comparison (replace underscores with spaces, lowercase)
  const normalizeSystemName = (name: string) => name.toLowerCase().replace(/_/g, ' ').trim();

  for (let attempt = 0; attempt < MAX_JUMPS; attempt++) {
    await bot.refreshStatus();
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
      const routeData = routeResp.result as { found?: boolean; route?: Array<{ system_id: string; name: string }>; total_jumps?: number; message?: string } | null;

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
        // Validate server route against blacklist — reject if it passes through blacklisted systems
        const serverRouteSystemIds = routeData.route.map(r => r.system_id);
        const blacklistedOnRoute = serverRouteSystemIds.find(
          sysId => blacklist.some(b => b.toLowerCase() === sysId.toLowerCase())
        );
        if (blacklistedOnRoute) {
          ctx.log("warn", `Server route passes through blacklisted system ${blacklistedOnRoute} — rejecting server route`);
        } else {
          nextSystem = routeData.route[1].system_id;
          ctx.log("travel", `Server route: ${routeData.total_jumps} jump${routeData.total_jumps !== 1 ? "s" : ""} — next: ${nextSystem}`);
        }
      }

      // If server route was rejected or unavailable, try fallback options
      if (!nextSystem) {
        // Server returned no route - check if we might already be at the target
        // This can happen due to case mismatch or if we're already there
        ctx.log("warn", `Server returned no route to ${targetSystemId} — checking if already arrived...`);
        await bot.refreshStatus();
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
    const fueled = await ensureFueled(ctx, Math.max(opts.fuelThresholdPct, 25), { noJettison: opts.noJettison });
    if (!fueled) {
      ctx.log("error", "Cannot secure fuel for jump — aborting navigation");
      return false;
    }

    // CRITICAL: Re-check position after ensureFueled — it may have moved us to a different system!
    await bot.refreshStatus();
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
      const routeData = routeResp.result as { found?: boolean; route?: Array<{ system_id: string; name: string }>; total_jumps?: number; message?: string } | null;

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
        // Validate server route against blacklist — reject if it passes through blacklisted systems
        const serverRouteSystemIds = routeData.route.map(r => r.system_id);
        const blacklistedOnRoute = serverRouteSystemIds.find(
          sysId => blacklist.some(b => b.toLowerCase() === sysId.toLowerCase())
        );
        if (blacklistedOnRoute) {
          ctx.log("warn", `Server route passes through blacklisted system ${blacklistedOnRoute} — rejecting server route (post-fuel)`);
        } else {
          nextSystem = routeData.route[1].system_id;
          ctx.log("travel", `Server route: ${routeData.total_jumps} jump${routeData.total_jumps !== 1 ? "s" : ""} — next: ${nextSystem}`);
        }
      }

      if (!nextSystem) {
        ctx.log("error", `No route from ${bot.system} to ${targetSystemId} — cannot navigate`);
        return false;
      }
    }

    await ensureUndocked(ctx);

    // Jump with retry logic for transient errors
    let jumpSuccess = false;
    let retries = 0;
    let inBattleDuringJump = false;
    while (!jumpSuccess && retries < MAX_RETRIES_PER_JUMP && bot.state === "running") {
      retries++;
      ctx.log("travel", `Jumping to ${nextSystem} from ${bot.system}... (attempt ${retries}/${MAX_RETRIES_PER_JUMP})`);
      const jumpResp = await bot.exec("jump", { target_system: nextSystem });

      // Track if we handled a battle interrupt to avoid double error handling
      let battleInterruptHandled = false;

      // Check for battle notifications after jump
      if (jumpResp.notifications && Array.isArray(jumpResp.notifications)) {
        const battleNotifs = parseBattleNotifications(jumpResp.notifications);
        const hasBattle = battleNotifs.some(n => n.type === "battle_start" || n.type === "battle_hit");
        if (hasBattle) {
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

      // CRITICAL: Check for battle interrupt error (jump timed out due to battle)
      if (jumpResp.error && jumpResp.error.code === "battle_interrupt") {
        ctx.log("combat", `Battle interrupt detected! ${jumpResp.error.message} - initiating flee!`);
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

      if (!jumpResp.error) {
        jumpSuccess = true;
        break;
      }

      // If we handled battle interrupt and battle is now cleared, treat as transient and retry
      if (battleInterruptHandled && !inBattleDuringJump) {
        ctx.log("travel", "Battle interrupt handled and cleared - retrying jump");
        // Fall through to retry logic below
      }

      const errorMsg = jumpResp.error.message.toLowerCase();

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
        errorMsg.includes("you are already in"); // Already at destination - treat as success

      if (!isTransient) {
        // Permanent error - don't retry
        ctx.log("error", `Jump failed (permanent error): ${jumpResp.error.message}`);
        return false;
      }

      // Special case: "already in" means we're already at the target system
      if (errorMsg.includes("you are already in")) {
        ctx.log("travel", `Server says already in system — refreshing status to verify position...`);
        await bot.refreshStatus();
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

        // CRITICAL: Refresh status and recalculate route after wait
        await bot.refreshStatus();
        if (bot.system.toLowerCase() === targetSystemId.toLowerCase()) return true;

        // Recalculate route from CURRENT position (may have changed during wait, use blacklist)
        const retryRoute = mapStore.findRoute(bot.system, targetSystemId, blacklist);
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

    await bot.refreshStatus();

    // Check for customs inspection after entering new system
    await checkCustomsInspection(ctx, nextSystem);

    // Check for battle status after jump (in case we jumped into an active battle)
    const battleStatus = await getBattleStatus(ctx);
    if (battleStatus && battleStatus.is_participant) {
      ctx.log("combat", `JUMPED INTO BATTLE! Battle ID: ${battleStatus.battle_id} - initiating emergency flee!`);
      await fleeFromBattle(ctx, true, 35000);
      return false; // Aborted navigation due to battle
    }

    // Check for pirates in the new system and flee if detected
    const nearbyResp = await bot.exec("get_nearby");
    if (nearbyResp.result && typeof nearbyResp.result === "object") {
      const fled = await checkAndFleeFromPirates(ctx, nearbyResp.result, true);
      if (fled) {
        // We fled - navigation is aborted, caller will need to handle new position
        return false;
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
    if (bot.system.toLowerCase() === targetSystemId.toLowerCase()) return true;
    if (bot.state !== "running") return false;
  }

  ctx.log("error", `Failed to reach ${targetSystemId} after ${MAX_JUMPS} jumps`);
  return false;
}

/** Refuel at a specific station POI if fuel is below threshold. Handles travel/dock/undock.
 *  Returns true if successfully refueled, false if stranded. */
export async function refuelAtStation(
  ctx: RoutineContext,
  station: { id: string; name: string },
  thresholdPct: number,
): Promise<boolean> {
  const { bot } = ctx;
  await bot.refreshStatus();
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
  }

  // Collect any gifted credits/items (may help pay for fuel)
  await collectFromStorage(ctx);

  await tryRefuel(ctx);

  // Verify refuel actually worked — do NOT undock if fuel is dangerously low
  await bot.refreshStatus();
  let newFuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
  if (newFuelPct < thresholdPct) {
    ctx.log("system", `Fuel still at ${newFuelPct}% after refuel — waiting at ${station.name}...`);
    for (let w = 0; w < REFUEL_WAIT_RETRIES && bot.state === "running"; w++) {
      await sleep(REFUEL_WAIT_INTERVAL);
      await bot.refreshStatus();
      await bot.exec("refuel");
      await bot.refreshStatus();
      newFuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
      if (newFuelPct >= thresholdPct) {
        ctx.log("system", `Fuel recovered to ${newFuelPct}% — resuming`);
        break;
      }
      ctx.log("system", `Still waiting for fuel (${newFuelPct}%)... (${w + 1}/${REFUEL_WAIT_RETRIES})`);
    }
  }

  await bot.refreshStatus();
  newFuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
  if (newFuelPct < 10) {
    ctx.log("error", `Fuel critically low (${newFuelPct}%) — staying docked at ${station.name}`);
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
function parseWrecks(result: unknown): Wreck[] {
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
export async function scavengeWrecks(ctx: RoutineContext, opts?: { fuelOnly?: boolean }): Promise<number> {
  const { bot } = ctx;
  if (bot.docked) return 0; // can't scavenge while docked

  // Skip if cargo is already full or nearly full (less than 5 free)
  await bot.refreshStatus();
  if (bot.cargoMax > 0 && bot.cargoMax - bot.cargo < 5) return 0;

  const fuelOnly = opts?.fuelOnly ?? false;

  const wrecksResp = await bot.exec("get_wrecks");
  const wrecks = parseWrecks(wrecksResp.result);
  if (wrecks.length === 0) return 0;

  let totalLooted = 0;
  const lootedItems: string[] = [];

  for (const wreck of wrecks) {
    if (bot.state !== "running") break;

    // Check cargo space
    await bot.refreshStatus();
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

    // Sort: fuel cells first, then everything else
    candidates.sort((a, b) => {
      const aPri = LOOT_PRIORITY.some(p => a.item_id.includes(p)) ? 0 : 1;
      const bPri = LOOT_PRIORITY.some(p => b.item_id.includes(p)) ? 0 : 1;
      return aPri - bPri;
    });

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
  opts?: { fuelOnly?: boolean; enableTow?: boolean; minTowValue?: number; battleState?: BattleState },
): Promise<{ itemsLooted: number; isTowing: boolean }> {
  const { bot } = ctx;
  if (bot.docked) return { itemsLooted: 0, isTowing: false };

  const enableTow = opts?.enableTow ?? false;
  const minTowValue = opts?.minTowValue ?? 500;
  const fuelOnly = opts?.fuelOnly ?? false;
  const battleState = opts?.battleState;

  const wrecksResp = await bot.exec("get_wrecks");
  const wrecks = parseWrecks(wrecksResp.result);
  if (wrecks.length === 0) return { itemsLooted: 0, isTowing: bot.towingWreck };

  let totalLooted = 0;
  const lootedItems: string[] = [];
  const towedWrecks: { wreck_id: string; name: string; salvage_value: number }[] = [];

  for (const wreck of wrecks) {
    if (bot.state !== "running") break;

    await bot.refreshStatus();
    if (bot.cargoMax > 0 && bot.cargo >= bot.cargoMax) {
      ctx.log("scavenge", "Cargo full — stopping salvage");
      break;
    }

    // Step 1: Loot cargo from the wreck
    if (wreck.items.length > 0) {
      let candidates = [...wreck.items];
      if (fuelOnly) {
        candidates = candidates.filter(i =>
          LOOT_PRIORITY.some(p => i.item_id.toLowerCase().includes(p))
        );
      }

      // Sort: fuel cells first
      candidates.sort((a, b) => {
        const aPri = LOOT_PRIORITY.some(p => a.item_id.includes(p)) ? 0 : 1;
        const bPri = LOOT_PRIORITY.some(p => b.item_id.includes(p)) ? 0 : 1;
        return aPri - bPri;
      });

      for (const item of candidates) {
        if (bot.state !== "running") break;
        if (bot.cargoMax > 0 && bot.cargo >= bot.cargoMax) break;

        const lootResp = await bot.exec("loot_wreck", {
          wreck_id: wreck.wreck_id,
          item_id: item.item_id,
          quantity: item.quantity,
        });

        // Check for battle notifications after loot
        if (battleState && lootResp.notifications && Array.isArray(lootResp.notifications)) {
          const battleDetected = await handleBattleNotifications(ctx, lootResp.notifications, battleState);
          if (battleDetected) {
            ctx.log("combat", "Battle detected while looting wreck - initiating flee!");
            battleState.isFleeing = false;
          }
        }

        if (lootResp.error) {
          const msg = lootResp.error.message.toLowerCase();
          if (msg.includes("empty") || msg.includes("not found")) break;
          continue;
        }

        totalLooted++;
        lootedItems.push(`${item.quantity}x ${item.name}`);
      }
    }

    // Step 2: Optionally tow high-value wrecks
    if (enableTow) {
      // Check if we already have a tow attached
      await bot.refreshStatus();
      if (bot.towingWreck) {
        ctx.log("scavenge", "Already towing a wreck — stopping salvage and heading to salvage yard");
        break; // Exit the wrecks loop entirely
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
          ctx.log("scavenge", `Set bot.towingWreck=true after successful tow`);
          break;
        } else {
          ctx.log("scavenge", `Skipped towing ${wreck.name} - value ${salvageValue}cr below threshold ${minTowValue}cr`);
        }
      } else if (towResp.error) {
        const msg = towResp.error.message.toLowerCase();
        if (msg.includes("already")) {
          // Check if it's "already_towing" (we're towing) vs "already_towed" (someone else has it)
          if (msg.includes("already_towing") || msg.includes("already towing")) {
            // We are already towing - this is a signal to head to salvage yard
            ctx.log("warn", `Already towing a wreck — should head to salvage yard (${towResp.error.message})`);
            bot.towingWreck = true;
            break; // Stop scanning and go to salvage yard
          } else {
            // Someone else is towing this wreck - skip it and try another
            ctx.log("scavenge", `Wreck already being towed by another player — skipping (${towResp.error.message})`);
            continue; // Try the next wreck
          }
        } else {
          ctx.log("error", `Failed to tow ${wreck.name}: ${towResp.error.message}`);
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

  // Refresh status to get latest towing state
  await bot.refreshStatus();
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
  await bot.refreshStatus();
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

  // Find the towed wreck in the list (it should still be accessible)
  let modulesLooted = 0;
  for (const wreck of wrecks) {
    // Check modules array (not items)
    if (wreck.modules.length === 0) {
      ctx.log("scavenge", "📦 Towed wreck has no modules to loot");
      break;
    }

    ctx.log("scavenge", `📦 Towed wreck ${wreck.name} contains ${wreck.modules.length} module(s): ${wreck.modules.map(m => m.name || m.type || m.type_id || m.id).join(", ")}`);

    // Loot ALL modules and cargo from the wreck (no item_id specified = loots everything to cargo hold)
    // Check cargo space first
    await bot.refreshStatus();
    const moduleCargoCost = wreck.modules.length * 10; // Typical module size is 10 each
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
        break;
      }
      
      // Re-check cargo after deposit
      await bot.refreshStatus();
      if (bot.cargoMax > 0 && (bot.cargo + moduleCargoCost) > bot.cargoMax) {
        ctx.log("warn", "Still no cargo space after deposit — skipping module loot");
        break;
      }
    }

    // Loot ALL modules and cargo from wreck (no item_id = loots everything)
    const lootResp = await bot.exec("loot_wreck", {
      wreck_id: wreck.wreck_id,
    });

    if (lootResp.error) {
      const msg = lootResp.error.message.toLowerCase();
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
          wreck_id: wreck.wreck_id,
        });
        if (!retryResp.error) {
          modulesLooted = wreck.modules.length;
          ctx.log("scavenge", `✓ Looted all modules from wreck`);
        } else {
          ctx.log("error", `Failed to loot modules after deposit: ${retryResp.error.message}`);
        }
      } else if (msg.includes("empty") || msg.includes("not found")) {
        ctx.log("warn", "Wreck is empty or not found — stopping module loot");
      } else {
        ctx.log("error", `Failed to loot modules: ${lootResp.error.message}`);
      }
    } else {
      modulesLooted = wreck.modules.length;
      ctx.log("scavenge", `✓ Looted all modules from wreck`);
    }

    if (modulesLooted > 0) {
      ctx.log("scavenge", `✅ Successfully looted ${modulesLooted} module(s) from towed wreck`);
    }
    break; // Only process the first wreck (we're only towing one)
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
      
      if (!scrapResp.error && scrapResp.result) {
        const sr = scrapResp.result as Record<string, unknown>;
        // Scrap response uses 'materials' field
        const materials = (sr.materials as Array<Record<string, unknown>>) || [];
        const totalValue = (sr.total_value as number) || 0;
        const message = (sr.message as string) || "";
        
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
          break; // Stop retrying - we're no longer towing
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
      
      if (!sellResp.error && sellResp.result) {
        const sr = sellResp.result as Record<string, unknown>;
        const credits = (sr.credits as number) || (sr.earned as number) || 0;
        const xp = (sr.xp as number) || (sr.experience as number) || 0;
        const items = (sr.items as Array<Record<string, unknown>>) || [];

        if (credits > 0 || xp > 0 || items.length > 0) {
          const itemDetails = items.length > 0 ? ` + ${items.map(i => `${(i.quantity as number) || 1}x ${(i.name as string) || "material"}`).join(", ")}` : "";
          ctx.log("scavenge", `✅ Sold wreck for ${credits}cr + ${xp} XP${itemDetails}`);
          processed++;
          sellSuccess = true;
          break; // Success - exit retry loop
        } else {
          ctx.log("warn", `Sell attempt ${attempt} returned no credits, XP, or items — retrying...`);
        }
      } else if (sellResp.error) {
        const errMsg = sellResp.error.message.toLowerCase();
        if (errMsg.includes("not_towing")) {
          ctx.log("warn", `Server says not towing during sell (attempt ${attempt}) — clearing tow flag`);
          bot.towingWreck = false;
          break; // Stop retrying - we're no longer towing
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
  }

  await bot.refreshStatus();
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

  const resp = await bot.exec("cloak");
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
  if (!bot.docked) return;

  const all = readSettings();
  if ((all.general?.autoInsure as boolean) === false) return;

  const { pois } = await getSystemInfo(ctx);
  const currentStation = pois.find(p => isStationPoi(p) && p.id === bot.poi);
  if (currentStation && !stationHasService(currentStation, "insurance")) return;

  const quoteResp = await bot.exec("get_insurance_quote");
  if (quoteResp.error || !quoteResp.result) return;

  const q = quoteResp.result as Record<string, unknown>;
  const quoteObj = (q.quote as Record<string, unknown>) ?? q;

  // Already insured?
  const insured = (quoteObj.insured as boolean) ?? (q.insured as boolean) ?? false;
  if (insured) return;

  const cost = (quoteObj.cost as number) || (quoteObj.premium as number) || (quoteObj.price as number) || 0;
  if (cost <= 0) return;

  if (bot.credits < cost + INSURANCE_CREDIT_FLOOR) {
    ctx.log("info", `Insurance: can't afford ${cost}cr (need ${INSURANCE_CREDIT_FLOOR}cr floor) — skipping`);
    return;
  }

  const insureResp = await bot.exec("buy_insurance");
  if (!insureResp.error) {
    ctx.log("info", `Insurance purchased for ${cost}cr`);
    await bot.refreshStatus();
  } else if (insureResp.error.message.toLowerCase().includes("already")) {
    // silently skip
  }
}

/**
 * Detect death (hull=0) and attempt recovery: claim insurance, dock, refuel, repair, re-insure.
 * Returns true if alive/recovered, false if stuck dead.
 */
export async function detectAndRecoverFromDeath(ctx: RoutineContext): Promise<boolean> {
  const { bot } = ctx;
  await bot.refreshStatus();

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
  await bot.refreshStatus();

  if (bot.hull <= 0 && bot.maxHull > 0) {
    ctx.log("error", "Still dead after insurance claim — waiting for respawn...");
    // Wait up to 60s for respawn
    for (let i = 0; i < 6; i++) {
      await sleep(10_000);
      await bot.refreshStatus();
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

  await bot.refreshStatus();
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
      return JSON.parse(readFileSync(file, "utf-8"));
    }
  } catch { /* use defaults */ }
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
    existing[key] = { ...(existing[key] || {}), ...val };
  }

  writeFileSync(file, JSON.stringify(existing, null, 2) + "\n", "utf-8");
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

/** Minimum credits a bot must keep before donating to faction. */
const FACTION_DONATE_FLOOR = 1000;

/**
 * Donate a configurable % of profit to the faction treasury.
 * Reads `general.factionDonatePct` from settings (default 10).
 * Bot retains at least 1000 credits after donation.
 */
export async function factionDonateProfit(ctx: RoutineContext, profit: number): Promise<void> {
  if (profit <= 0) return;
  const all = readSettings();
  const pct = (all.general?.factionDonatePct as number) ?? 10;
  if (pct <= 0) return;
  const { bot } = ctx;
  const donation = Math.floor(profit * (pct / 100));
  if (donation <= 0) return;
  if (bot.credits - donation < FACTION_DONATE_FLOOR) return;
  const resp = await bot.exec("faction_deposit_credits", { amount: donation });
  if (!resp.error) {
    ctx.log("trade", `Donated ${donation}cr to faction treasury (${pct}% of ${profit}cr profit)`);
    logFactionActivity(ctx, "donation", `Deposited ${donation}cr (${pct}% of ${profit}cr profit)`);
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
    
    // If we have a battle_id, this means we're still in battle
    if (battleId) {
      return {
        type: "battle_tick",
        battleId,
        tick,
        participants,
        sides,
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

/** Pirate entity from get_nearby response */
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
 * Get current battle status from the API.
 * @param ctx - Routine context
 * @returns Battle status or null if not in battle
 */
export async function getBattleStatus(ctx: RoutineContext): Promise<BattleStatus | null> {
  const { bot } = ctx;
  const resp = await bot.exec("get_battle_status");
  if (resp.error || !resp.result) {
    return null;
  }

  const result = resp.result as Record<string, unknown>;
  if (result.error && (result.error as Record<string, unknown>).code === "not_in_battle") {
    return null;
  }

  // Parse battle status
  const status: BattleStatus = {
    battle_id: (result.battle_id as string) || "",
    tick: (result.tick as number) || undefined,
    system_id: (result.system_id as string) || undefined,
    sides: (result.sides as BattleSide[]) || [],
    participants: (result.participants as BattleParticipant[]) || [],
    your_side_id: (result.your_side_id as number) || undefined,
    your_zone: (result.your_zone as BattleZone) || undefined,
    your_stance: (result.your_stance as BattleStance) || undefined,
    your_target_id: (result.your_target_id as string) || undefined,
    auto_pilot: (result.auto_pilot as boolean) || undefined,
    is_participant: (result.is_participant as boolean) || false,
  };

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
        
        // Check for pirates in battle participants
        if (battleNotif.participants) {
          const pirateResult = parsePiratesFromBattleParticipants(battleNotif.participants);
          if (pirateResult.hasPirates) {
            ctx.log("combat", `⚠️ PIRATES DETECTED IN BATTLE! ${pirateResult.pirateCount} pirate(s), highest tier: ${pirateResult.highestTier}`);
          }
        }
        
        // Immediately initiate flee
        ctx.log("combat", "Initiating emergency flee!");
        await fleeFromBattle(ctx, true, 35000);
        return true;

      case "battle_tick":
        // Check for pirates in battle participants (from battle_update)
        if (battleNotif.participants) {
          const pirateResult = parsePiratesFromBattleParticipants(battleNotif.participants);
          if (pirateResult.hasPirates && !battleState.isFleeing) {
            ctx.log("combat", `⚠️ PIRATES DETECTED IN BATTLE UPDATE! ${pirateResult.pirateCount} pirate(s) - fleeing!`);
            battleState.isFleeing = false; // Reset to trigger flee
          }
        }
        
        if (battleState.inBattle && !battleState.isFleeing) {
          ctx.log("combat", `Battle tick ${battleNotif.tick} - combat continues (we're still in battle!)`);
          // If we somehow missed the battle start, flee now
          ctx.log("combat", "Initiating late flee!");
          await fleeFromBattle(ctx, true, 35000);
          return true;
        }
        break;

      case "battle_hit":
        ctx.log("combat", `Battle hit detected: ${battleNotif.message}`);
        battleState.lastHitTick = Date.now();
        // If we're not already fleeing, start fleeing
        if (battleState.inBattle && !battleState.isFleeing) {
          ctx.log("combat", "Hit detected - ensuring flee is active!");
          await fleeFromBattle(ctx, true, 35000);
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

  // Get system info to find jump targets
  const { connections } = await getSystemInfo(ctx);
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
  const jumpResp = await bot.exec("jump", { target_system: randomConnection.id });

  if (jumpResp.error) {
    ctx.log("error", `Emergency jump failed: ${jumpResp.error.message}`);
    return false;
  }

  ctx.log("combat", `Successfully escaped to ${randomConnection.name || randomConnection.id}!`);
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

// ── Customs Inspection ───────────────────────────────────────

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

  // Wait for customs inspection (up to 5 seconds total)
  const result = await waitForCustomsInspection(bot, (cat, msg) => bot.log(cat, msg), systemToCheck, 5000);

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
