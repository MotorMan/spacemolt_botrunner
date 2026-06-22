import type { Bot, Routine, RoutineContext } from "../bot.js";
import { mapStore } from "../mapstore.js";
import type { StationRef } from "../stationRef.js";
import {
  ensureDocked,
  ensureUndocked,
  tryRefuel,
  repairShip,
  ensureFueled,
  navigateToSystem,
  detectAndRecoverFromDeath,
  readSettings,
  checkAndFleeFromBattle,
  checkBattleAfterCommand,
  getBattleStatus,
  fleeFromBattle,
  getShipTier,
  type BattleState,
  isPirateSystem,
  getItemSize,
} from "./common.js";
import { logCTFare } from "./trader.js";
import { getSystemBlacklist } from "../web/server.js";
import { civilianStore, CivilianPassenger } from "../civilianstore.js";
import { catalogStore } from "../catalogstore.js";
import { onCivilianTransportUpdate } from "../client_sync_hooks.js";

// ── Cloaking module detection and enablement ────────────────────────────────

async function hasCloakingModule(ctx: RoutineContext, cachedModules?: unknown[]): Promise<boolean> {
  const { bot } = ctx;
  let modules: unknown[];

  if (cachedModules && cachedModules.length > 0) {
    modules = cachedModules;
  } else {
    const shipResp = await bot.exec("get_ship");
    if (shipResp.error || !shipResp.result) return false;
    const shipData = shipResp.result as Record<string, unknown>;
    modules = Array.isArray(shipData.modules) ? shipData.modules : [];
  }

  for (const mod of modules) {
    const modObj = typeof mod === "object" && mod !== null ? mod as Record<string, unknown> : null;
    const modId = ((modObj?.id as string) || (modObj?.type_id as string) || "").toLowerCase();
    const modName = ((modObj?.name as string) || "").toLowerCase();
    const modSpecial = ((modObj?.special as string) || "").toLowerCase();

    const checkStr = `${modId} ${modName} ${modSpecial}`;
    if (checkStr.includes("cloak")) {
      return true;
    }
  }
  return false;
}

async function enableCloakingIfPossible(ctx: RoutineContext, cachedModules?: unknown[]): Promise<boolean> {
  const { bot } = ctx;

  if (bot.isCloaked) {
    ctx.log("transport", "Bot is already cloaked - no action needed");
    return true;
  }

  const hasCloak = await hasCloakingModule(ctx, cachedModules);
  if (!hasCloak) {
    ctx.log("transport", "No cloaking module detected - cannot enable cloak");
    return false;
  }

  ctx.log("transport", "Enabling cloaking module...");
  const resp = await bot.exec("cloak", { enable: true });
  if (resp.error) {
    ctx.log("error", `Failed to enable cloak: ${resp.error.message}`);
    return false;
  }

  ctx.log("transport", "Cloaking enabled successfully");
  return true;
}

let stationRefCache: StationRef | null = null;

function loadStationRef(): StationRef {
  if (stationRefCache) return stationRefCache;
  try {
    const fs = require("fs");
    const path = require("path");
    const stationRefPath = path.join(process.cwd(), "data/stationRef.json");
    if (fs.existsSync(stationRefPath)) {
      const raw = fs.readFileSync(stationRefPath, "utf-8");
      stationRefCache = JSON.parse(raw) as StationRef;
      console.log(`Loaded stationRef.json: ${Object.keys(stationRefCache.by_underline_name).length} stations`);
      return stationRefCache;
    }
    console.error("stationRef.json not found at:", stationRefPath);
  } catch (err) {
    console.error("Failed to load stationRef.json:", err);
  }
  return { stations: [], by_station_id: {}, by_system_id: {}, by_underline_name: {} };
}

function isPirateStation(stationId: string): boolean {
  const stationRef = loadStationRef();
  const lowerId = stationId.toLowerCase();
  const info = stationRef.by_station_id[lowerId];
  return info?.is_pirate === true;
}

function isPirateDestination(stationId: string, systemId: string | undefined): boolean {
  if (isPirateStation(stationId)) return true;
  if (systemId && isPirateSystem(systemId)) return true;
  return false;
}

const fs = require("fs");
const path = require("path");

const MOBILE_STATIONS = new Set(["mobile_capitol", "frontier_station"]);

function isMobileStation(poiId: string): boolean {
  return MOBILE_STATIONS.has(poiId.toLowerCase());
}

interface RouteResult {
  system: string;
  poi: string;
  poiName: string;
  origDest?: string;
}

async function resolveDestination(ctx: RoutineContext, bot: Bot, destinationId: string, destinationName: string, destinationSystem?: string): Promise<RouteResult | null> {
  if (isMobileStation(destinationId)) {
    ctx.log("transport", `resolveDestination: ${destinationId} is mobile, using find_route directly`);
    const routeResp = await bot.exec("find_route", { target: destinationId });
    if (!routeResp.error && routeResp.result) {
      const result = routeResp.result as Record<string, unknown>;
      const isFound = result.found || result.target_system || (result.route && (result.route as Array<{system_id: string}>).length > 0);
      if (isFound) {
        return {
          system: (result.target_system as string) || "",
          poi: (result.target_poi as string) || destinationId,
          poiName: (result.target_poi_name as string) || destinationName || destinationId,
          origDest: destinationId,
        };
      }
    }
    return null;
  }
  
  const stationRef = loadStationRef();
  const allSystems = mapStore.getAllSystems();
  
  ctx.log("transport", `resolveDestination: looking up ${destinationId}, by_underline_name keys: ${Object.keys(stationRef.by_underline_name).slice(0, 5).join(", ")}...`);
  
  const byUnderline = stationRef.by_underline_name[destinationId.toLowerCase()];
  if (byUnderline) {
    ctx.log("transport", `resolveDestination: found in by_underline_name: system=${byUnderline.system_id}, station=${byUnderline.station_id}, name=${byUnderline.regular_station_name || byUnderline.station_id}`);
    if (isPirateDestination(byUnderline.station_id, byUnderline.system_id)) {
      ctx.log("transport", `resolveDestination: REJECTING pirate destination ${byUnderline.station_id}`);
      return null;
    }
    const result = { system: byUnderline.system_id, poi: byUnderline.station_id, poiName: byUnderline.regular_station_name || byUnderline.station_id, origDest: destinationId };
    ctx.log("transport", `resolveDestination: SUCCESS returning system=${result.system}, poi=${result.poi}`);
    return result;
  }

  const byStationId = stationRef.by_station_id[destinationId.toLowerCase()];
  if (byStationId) {
    ctx.log("transport", `resolveDestination: found in by_station_id: system=${byStationId.system_id}, station=${byStationId.station_id}`);
    if (isPirateDestination(byStationId.station_id, byStationId.system_id)) {
      ctx.log("transport", `resolveDestination: REJECTING pirate destination ${byStationId.station_id}`);
      return null;
    }
    const result = { system: byStationId.system_id, poi: byStationId.station_id, poiName: byStationId.official_name || byStationId.station_id, origDest: destinationId };
    ctx.log("transport", `resolveDestination: SUCCESS returning system=${result.system}, poi=${result.poi}`);
    return result;
  }

  for (const st of stationRef.stations) {
    const destLower = destinationId.toLowerCase();
    const stIdLower = st.station_id.toLowerCase();
    const underlineLower = st.underline_station_name.toLowerCase();
    const regularNameLower = st.regular_station_name?.toLowerCase() || "";
    
    const stationIdMatch = stIdLower === destLower;
    const underlineMatch = underlineLower === destLower;
    const regularNameMatch = regularNameLower === destLower;
    const nameMatch = destinationName && regularNameLower === destinationName.toLowerCase();
    const partialMatch = stIdLower.includes(destLower) || destLower.includes(stIdLower) ||
      underlineLower.includes(destLower) || destLower.includes(underlineLower) ||
      regularNameLower.includes(destLower) || destLower.includes(regularNameLower);
    
    if (stationIdMatch || underlineMatch || regularNameMatch || nameMatch || partialMatch) {
      ctx.log("transport", `resolveDestination: found in stations: system=${st.system_id}, station=${st.station_id}`);
      if (isPirateDestination(st.station_id, st.system_id)) {
        ctx.log("transport", `resolveDestination: REJECTING pirate destination ${st.station_id}`);
        return null;
      }
      const result = { system: st.system_id, poi: st.station_id, poiName: st.regular_station_name || st.station_id, origDest: destinationId };
      ctx.log("transport", `resolveDestination: SUCCESS returning system=${result.system}, poi=${result.poi}`);
      return result;
    }
  }
  
  for (const [, sysData] of Object.entries(allSystems)) {
    const found = sysData.pois.find(
      (pp: { id: string; name: string }) => pp.id === destinationId || pp.name.toLowerCase() === destinationName.toLowerCase(),
    );
    if (found) {
      if (isPirateDestination(found.id, sysData.id)) {
        ctx.log("transport", `resolveDestination: REJECTING pirate destination ${found.id} in system ${sysData.id}`);
        return null;
      }
      const result = { system: sysData.id, poi: found.id, poiName: found.name || found.id, origDest: destinationId };
      ctx.log("transport", `resolveDestination: SUCCESS (allSystems scan) system=${result.system}, poi=${result.poi}`);
      return result;
    }
  }

  let bestStationMatch: { station_id: string; system_id: string; regular_station_name: string } | null = null;
  let bestMatchScore = 0;
  
  for (const st of stationRef.stations) {
    const destLower = destinationId.toLowerCase();
    const stIdLower = st.station_id.toLowerCase();
    const underlineLower = st.underline_station_name.toLowerCase();
    const regularNameLower = st.regular_station_name?.toLowerCase() || "";
    
    let score = 0;
    if (stIdLower === destLower) score = 10;
    else if (underlineLower === destLower) score = 10;
    else if (regularNameLower === destLower) score = 10;
    else if (stIdLower.includes(destLower) || destLower.includes(stIdLower)) score = 5;
    else if (underlineLower.includes(destLower) || destLower.includes(underlineLower)) score = 5;
    else if (regularNameLower.includes(destLower) || destLower.includes(regularNameLower)) score = 5;
    
    if (score > bestMatchScore) {
      bestMatchScore = score;
      bestStationMatch = st;
    }
  }

  if (bestStationMatch && bestMatchScore >= 5) {
    ctx.log("transport", `resolveDestination: fallback bestMatchScore=${bestMatchScore}, station=${bestStationMatch.station_id}, system=${bestStationMatch.system_id}`);
    const routeResp = await bot.exec("find_route", { target_system: bestStationMatch.system_id });
    if (!routeResp.error && routeResp.result) {
      const result = routeResp.result as Record<string, unknown>;
      const isFound = result.found || result.target_system || (result.route && (result.route as Array<{system_id: string}>).length > 0);
      if (isFound) {
        const targetSystem = (result.target_system as string) || "";
        const targetPoi = (result.target_poi as string) || bestStationMatch.station_id;
        if (!isPirateDestination(targetPoi, targetSystem)) {
          const ret = {
            system: targetSystem,
            poi: targetPoi,
            poiName: ((result.target_poi_name as string) || bestStationMatch.regular_station_name || bestStationMatch.station_id) as string,
            origDest: destinationId,
          };
          ctx.log("transport", `resolveDestination: SUCCESS (find_route fallback) system=${ret.system}, poi=${ret.poi}`);
          return ret;
        }
        ctx.log("transport", `resolveDestination: REJECTING pirate destination from find_route fallback: ${targetPoi}`);
      }
    }
  }
  
  let targetSystemId: string | null = null;
  
  if (destinationSystem) {
    ctx.log("transport", `resolveDestination: trying destinationSystem=${destinationSystem}`);
    const directKey = Object.keys(allSystems).find(k => k === destinationSystem || k.toLowerCase() === destinationSystem.toLowerCase());
    if (directKey) {
      targetSystemId = directKey;
      ctx.log("transport", `resolveDestination: matched system by direct key: ${targetSystemId}`);
    } else {
      const entry = Object.entries(allSystems).find(([, s]) => {
        const sysName = s.name || s.id || "";
        return sysName.toLowerCase() === destinationSystem.toLowerCase();
      });
      if (entry) {
        targetSystemId = entry[0];
        ctx.log("transport", `resolveDestination: matched system by name: ${targetSystemId}`);
      }
    }
  }

if (!targetSystemId) {
    ctx.log("transport", `resolveDestination: could not resolve system ID for ${destinationSystem}`);
    if (destinationSystem) {
      const routeResp = await bot.exec("find_route", { target_system: destinationSystem });
      if (!routeResp.error && routeResp.result) {
        const result = routeResp.result as Record<string, unknown>;
        const isFound = result.found || result.target_system || (result.route && (result.route as Array<{system_id: string}>).length > 0);
        if (isFound) {
          const targetSystem = (result.target_system as string) || "";
          const targetPoi = (result.target_poi as string) || destinationId;
          if (!isPirateDestination(targetPoi, targetSystem)) {
            const ret = {
              system: targetSystem,
              poi: targetPoi,
              poiName: ((result.target_poi_name as string) || destinationName || targetPoi) as string,
              origDest: destinationId,
            };
            ctx.log("transport", `resolveDestination: SUCCESS (destinationSystem fallback) system=${ret.system}, poi=${ret.poi}`);
            return ret;
          }
          ctx.log("transport", `resolveDestination: REJECTING pirate destination from destinationSystem fallback: ${targetPoi}`);
        }
      }
    }
    ctx.log("transport", `resolveDestination: FAILED - could not resolve destination ${destinationId}`);
    return null;
  }
  
  ctx.log("transport", `resolveDestination: using find_route for ${destinationId} in system ${targetSystemId}`);
  const routeResp = await bot.exec("find_route", { target_system: targetSystemId });
  if (routeResp.error || !routeResp.result) {
    ctx.log("transport", `resolveDestination: find_route error for ${destinationId}: ${routeResp.error?.message || "no result"}`);
    return null;
  }
  const result = routeResp.result as Record<string, unknown>;
  const isFound = result.found || result.target_system || (result.route && (result.route as Array<{system_id: string}>).length > 0);
  if (!isFound) {
    ctx.log("transport", `resolveDestination: find_route not found for ${destinationId}`);
    ctx.log("transport", `resolveDestination: FAILED - no route found`);
    return null;
  }
  const targetSystem = (result.target_system as string) || "";
  const targetPoi = (result.target_poi as string) || destinationId;
  if (isPirateDestination(targetPoi, targetSystem)) {
    ctx.log("transport", `resolveDestination: REJECTING pirate destination ${targetPoi} in system ${targetSystem}`);
    return null;
  }
  const ret = {
    system: targetSystem,
    poi: targetPoi,
    poiName: ((result.target_poi_name as string) || destinationName || targetPoi) as string,
    origDest: destinationId,
  };
  ctx.log("transport", `resolveDestination: SUCCESS (find_route) system=${ret.system}, poi=${ret.poi}`);
  return ret;
}

interface CatalogShip {
  id: string;
  name: string;
  special?: string;
  inherent_capabilities?: Array<{ type: string; value: number }>;
}

let catalogCache: Record<string, CatalogShip> | null = null;

function loadCatalog(): Record<string, CatalogShip> {
  if (catalogCache) return catalogCache;
  try {
    const catalogPath = path.join(process.cwd(), "data/catalog.json");
    if (fs.existsSync(catalogPath)) {
      const raw = fs.readFileSync(catalogPath, "utf-8");
      const data = JSON.parse(raw) as Record<string, unknown>;
      const shipsArray = (data.ships as { id?: unknown }[]) || [];
      const ships: Record<string, CatalogShip> = {};
      for (const ship of shipsArray) {
        const id = ship?.id;
        if (typeof id === "string") ships[id] = ship as CatalogShip;
      }
      catalogCache = ships;
      return ships;
    }
  } catch {
    // silent fail
  }
  return {};
}

// ── Types ────────────────────────────────────────────────────

interface TransportPassenger {
  citizenId: string;
  name: string;
  accommodationClass: "economy" | "business" | "first";
  citizenship: string;
  destination: string;
  destinationName: string;
  destinationSystem?: string;
  fare: number;
  bio: string;
  routeData: unknown;
  loadedAt: string;
  status: "boarded" | "delivered" | "stranded";
  ticksRemaining?: number;
}

interface TransportState {
  botUsername: string;
  status: "idle" | "traveling_to_ship" | "loading" | "in_transit" | "unloading" | "completed";
  shipId: string;
  shipName: string;
  customName?: string;
  tier: number | null;
  berths: { economy: number; business: number; first: number };
  berths_used: { economy: number; business: number; first: number };
  onboardPassengers: TransportPassenger[];
  pickupStation: string | null;
  pickupSystem: string | null;
  route: Array<{ system: string; poi: string; poiName: string; origDest?: string }>;
  currentRouteIndex: number;
  revenue: number;
  totalFaresEarned: number;
  currentDestination: string | null;
  lastUpdated: string;
  routeRebuildAttempts: number;
  roundsWithoutPassengers: number;
}

interface FleetShip {
  shipId: string;
  shipName: string;
  customName?: string;
  type: string;
  tier: number | null;
  berths: { economy: number; business: number; first: number };
  storedAtStationId: string;
  storedAtSystemId: string;
  hasShipyard: boolean;
  cargoCapacity: number;
  cargoUsed: number;
}

interface FleetData {
  version: number;
  bots: Record<string, { ships: FleetShip[]; lastUpdated: string }>;
}

interface StationPassenger {
  citizen_id: string;
  name: string;
  class: string;
  citizenship: string;
  destination: string;
  destination_name: string;
  destination_system?: string;
  bio?: string;
}

interface StationPassengersResponse {
  station: string;
  waiting: StationPassenger[];
  count: number;
}

interface AboardPassenger {
  citizen_id: string;
  name: string;
  class: string;
  citizenship: string;
  destination: string;
  destination_name: string;
  destination_system?: string;
  fare: number;
  bio: string;
  ticks_remaining: number;
  route_data?: unknown;
}

interface ListPassengersResponse {
  passengers: AboardPassenger[];
  berths: { economy: number; business: number; first: number };
  berths_used: { economy: number; business: number; first: number };
}

interface CivilianTransportSettings {
  maxJumps: number;
  roundsBeforeMoving: number;
  refuelThreshold: number;
  repairThreshold: number;
  homeSystem: string;
  homeStation: string;
  maxPassengers: number;
  maxEconomy: number;
  maxBusiness: number;
  maxFirst: number;
  blockPirateStations: boolean;
  passengerPriority: "first" | "business" | "economy" | "off";
  allowFirstClass: boolean;
  allowBusinessClass: boolean;
  allowEconomyClass: boolean;
  announceDestination: boolean;
  disableFactionMessage: boolean;
  enableCloak: boolean;
}

// ── Settings ─────────────────────────────────────────────────

function getCivilianTransportSettings(username?: string): CivilianTransportSettings {
  const all = readSettings();
  const t = (all as any).civilian_transport || {};
  const botOverrides = username ? ((all as any)[username] || {}) : {};
  return {
    maxJumps: Number((t.maxJumps as number) ?? 5),
    roundsBeforeMoving: Number((t.roundsBeforeMoving as number) ?? 5),
    refuelThreshold: Number((t.refuelThreshold as number) ?? 50),
    repairThreshold: Number((t.repairThreshold as number) ?? 40),
    homeSystem: (botOverrides.homeSystem as string) || (t.homeSystem as string) || "",
    homeStation: (botOverrides.homeStation as string) || (t.homeStation as string) || "",
    maxPassengers: Number((t.maxPassengers as number) ?? 0),
    maxEconomy: Number((t.maxEconomy as number) ?? 0),
    maxBusiness: Number((t.maxBusiness as number) ?? 0),
    maxFirst: Number((t.maxFirst as number) ?? 0),
    blockPirateStations: (t.blockPirateStations as boolean) ?? true,
    passengerPriority: ((t.passengerPriority as string) === "first" || (t.passengerPriority as string) === "business" || (t.passengerPriority as string) === "economy")
      ? (t.passengerPriority as "first" | "business" | "economy" | "off")
      : "off",
    allowFirstClass: (t.allowFirstClass as boolean) !== false,
    allowBusinessClass: (t.allowBusinessClass as boolean) !== false,
    allowEconomyClass: (t.allowEconomyClass as boolean) !== false,
    announceDestination: (t.announceDestination as boolean) !== false,
    disableFactionMessage: (t.disableFactionMessage as boolean) ?? false,
    enableCloak: (t.enableCloak as boolean) ?? false,
  };
}

// ── Empire station mapping ───────────────────────────────────

interface EmpireStation {
  systemId: string;
  poiId: string;
  poiName: string;
}

const EMPIRE_STATIONS: Record<string, EmpireStation[]> = {
  solarian: [
    { systemId: "sol", poiId: "sol_central", poiName: "Confederacy Central Command" },
    { systemId: "alpha_centauri", poiId: "alpha_centauri_colonial_station", poiName: "Alpha Centauri Colonial Station" },
    { systemId: "sirius", poiId: "sirius_observatory_station", poiName: "Sirius Observatory Station" },
    { systemId: "nova_terra", poiId: "nova_terra_central", poiName: "Nova Terra Central" },
    { systemId: "procyon", poiId: "procyon_colonial_station", poiName: "Procyon Colonial Station" },
  ],
  voidborn: [
    { systemId: "nexus_prime", poiId: "the_core", poiName: "Central Nexus" },
    { systemId: "node_alpha", poiId: "node_alpha_processing_station", poiName: "Node Alpha Processing Station" },
    { systemId: "node_beta", poiId: "node_beta_industrial_station", poiName: "Node Beta Industrial Station" },
    { systemId: "synchrony", poiId: "synchrony_hub", poiName: "Synchrony Hub" },
    { systemId: "the_experiment", poiId: "the_experiment_research_station", poiName: "The Experiment Research Station" },
    { systemId: "node_gamma", poiId: "node_gamma_relay_station", poiName: "Node Gamma Relay Station" },
  ],
  nebula: [
    { systemId: "gold_run", poiId: "gold_run_extraction_hub", poiName: "Gold Run Extraction Hub" },
    { systemId: "haven", poiId: "grand_exchange", poiName: "Grand Exchange Station" },
    { systemId: "cargo_lanes", poiId: "cargo_lanes_freight_depot", poiName: "Cargo Lanes Freight Depot" },
    { systemId: "traders_rest", poiId: "traders_rest_resort_station", poiName: "Trader's Rest Resort Station" },
    { systemId: "the_levy", poiId: "the_levy_customs_station", poiName: "The Levy Customs Station" },
    { systemId: "market_prime", poiId: "market_prime_exchange", poiName: "Market Prime Exchange" },
    { systemId: "treasure_cache", poiId: "treasure_cache_trading_post", poiName: "Treasure Cache Trading Post" },
  ],
  crimson: [
    { systemId: "the_rampart", poiId: "the_rampart_checkpoint", poiName: "The Rampart Checkpoint" },
    { systemId: "the_crucible", poiId: "the_crucible_garrison", poiName: "The Crucible Garrison" },
    { systemId: "iron_reach", poiId: "iron_reach_mining_colony", poiName: "Iron Reach Mining Colony" },
    { systemId: "krynn", poiId: "war_citadel", poiName: "Crimson War Citadel" },
    { systemId: "blood_forge", poiId: "blood_forge_smelting_works", poiName: "Blood Forge Smelting Works" },
    { systemId: "ironhearth", poiId: "ironhearth_station", poiName: "Ironhearth Station" },
    { systemId: "the_anvil", poiId: "the_anvil_arsenal", poiName: "The Anvil Arsenal" },
  ],
  outerrim: [
    { systemId: "last_light", poiId: "ramens_rest", poiName: "Ramen's Rest" },
    { systemId: "unknown_edge", poiId: "unknown_edge_waystation", poiName: "Unknown Edge Waystation" },
    { systemId: "starfall", poiId: "starfall_salvage_station", poiName: "Starfall Salvage Station" },
    { systemId: "void_gate", poiId: "void_gate_outpost", poiName: "Void Gate Outpost" },
    { systemId: "deep_range", poiId: "deep_range_outpost", poiName: "Deep Range Outpost" },
  ],
};

function getStationsForEmpire(empire: string): EmpireStation[] {
  const lowerEmpire = empire.toLowerCase();
  return EMPIRE_STATIONS[lowerEmpire] || [];
}

function getRandomEmpireStation(empire: string): EmpireStation | null {
  const stations = getStationsForEmpire(empire);
  if (stations.length === 0) return null;
  return stations[Math.floor(Math.random() * stations.length)];
}

// ── Persistent helpers ───────────────────────────────────────

const DATA_FILE = "data/civilianTransport.json";

function loadAllData(): { runs: Record<string, TransportState>; fleet: FleetData } {
  try {
    const fs = require("fs");
    const path = require("path");
    const full = path.join(process.cwd(), DATA_FILE);
    if (!fs.existsSync(full)) {
      return { runs: {}, fleet: { version: 1, bots: {} } };
    }
    const raw = fs.readFileSync(full, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { runs: {}, fleet: { version: 1, bots: {} } };
  }
}

function saveAllData(data: { runs: Record<string, TransportState>; fleet: FleetData }): void {
  try {
    const fs = require("fs");
    const path = require("path");
    const full = path.join(process.cwd(), DATA_FILE);
    const dir = path.dirname(full);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(full, JSON.stringify(data, null, 2) + "\n", "utf-8");
    void onCivilianTransportUpdate({ manifest: data });
  } catch (err) {
    console.error("Failed to save civilianTransport state:", err);
  }
}

function loadTransportState(botUsername: string): TransportState | null {
  try {
    const data = loadAllData();
    const raw = data.runs[botUsername];
    if (!raw || typeof raw !== "object") return null;
    return raw as TransportState;
  } catch {
    return null;
  }
}

function isValidTransportState(state: unknown): state is TransportState {
  if (!state || typeof state !== "object") return false;
  const s = state as Record<string, unknown>;
  if (typeof s.shipId !== "string" || s.shipId.length === 0) return false;
  const berths = s.berths as Record<string, number> | undefined;
  if (!berths || (berths.economy + berths.business + berths.first) <= 0) return false;
  const validStatuses = new Set(["idle", "loading", "unloading", "in_transit", "traveling_to_ship"]);
  if (typeof s.status !== "string" || !validStatuses.has(s.status)) return false;
  return true;
}

function saveTransportState(state: TransportState): void {
  const data = loadAllData();
  state.lastUpdated = new Date().toISOString();
  data.runs[state.botUsername] = state;
  saveAllData(data);
}

function clearTransportState(botUsername: string): void {
  const data = loadAllData();
  delete data.runs[botUsername];
  saveAllData(data);
}

function loadFleetData(botUsername: string): FleetShip[] {
  const data = loadAllData();
  return data.fleet.bots[botUsername]?.ships || [];
}

function saveFleetData(botUsername: string, ships: FleetShip[]): void {
  const data = loadAllData();
  data.fleet.bots[botUsername] = { ships, lastUpdated: new Date().toISOString() };
  saveAllData(data);
}

async function collectFuelCells(ctx: RoutineContext, settings: CivilianTransportSettings): Promise<void> {
  const { bot } = ctx;
  await bot.refreshCargo();

  const cargoFree = (bot.cargoMax || 0) - (bot.cargo || 0);
  if (cargoFree <= 0) {
    return;
  }

  const milSize = catalogStore.getItem("military_fuel_cell")?.size as number || 3;
  const premSize = catalogStore.getItem("premium_fuel_cell")?.size as number || 2;
  const regSize = catalogStore.getItem("fuel_cell")?.size as number || 1;

  let remainingSpace = cargoFree;
  const milCap = Math.floor(remainingSpace / milSize);
  remainingSpace -= milCap * milSize;

  const premCap = Math.floor(remainingSpace / premSize);
  remainingSpace -= premCap * premSize;

  const regCap = Math.floor(remainingSpace / regSize);

  const tryAcquire = async (fuelId: string, qty: number) => {
    if (qty <= 0) return true;
    const resp = await bot.exec("storage", {
      action: "withdraw",
      target: "faction",
      item_id: fuelId,
      quantity: qty,
    });
    if (!resp.error) {
      return true;
    }
    const buyResp = await bot.exec("buy", { item_id: fuelId, quantity: qty });
    return !buyResp.error;
  };

  await tryAcquire("military_fuel_cell", milCap);
  await tryAcquire("premium_fuel_cell", premCap);
  await tryAcquire("fuel_cell", regCap);
}

// ── Parsers ──────────────────────────────────────────────────

function parseStationPassengers(result: unknown): StationPassengersResponse | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  // Handles both {station, waiting, count} and {structuredContent: {...}}
  let inner = r.structuredContent && typeof r.structuredContent === "object"
    ? r.structuredContent as Record<string, unknown>
    : r;
  const waiting = Array.isArray(inner.waiting) ? inner.waiting as StationPassenger[] : [];
  return {
    station: (inner.station as string) || "",
    waiting,
    count: (inner.count as number) || waiting.length,
  };
}

function parseListPassengers(result: unknown): ListPassengersResponse | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  let inner = r.structuredContent && typeof r.structuredContent === "object"
    ? r.structuredContent as Record<string, unknown>
    : r;
  
  let passengers: AboardPassenger[] = [];
  const passengerSources = [inner.passengers, r.passengers, inner.passenger_list, r.passenger_list];
  for (const source of passengerSources) {
    if (Array.isArray(source)) {
      passengers = source as AboardPassenger[];
      break;
    }
  }
  
  if (passengers.length === 0 && typeof inner.passengers === "object" && inner.passengers !== null) {
    const p = inner.passengers as Record<string, unknown>;
    if (Array.isArray(p.data)) passengers = p.data as AboardPassenger[];
    else if (Array.isArray(p.items)) passengers = p.items as AboardPassenger[];
  }
  
  const num = (v: unknown): number | undefined => {
    if (typeof v === "number") return v;
    if (typeof v === "string") {
      const match = v.match(/(\d+)/);
      return match ? parseInt(match[1], 10) : undefined;
    }
    return undefined;
  };
  const berthsRaw = inner.berths && typeof inner.berths === "object" ? (inner.berths as Record<string, unknown>) : null;
  const berthsUsedRaw = inner.berths_used && typeof inner.berths_used === "object" ? (inner.berths_used as Record<string, unknown>) : null;
  const hasBerths = berthsRaw && (num(berthsRaw.economy) || num(berthsRaw.business) || num(berthsRaw.first));
  const economy = hasBerths
    ? num(berthsRaw!.economy) ?? 0
    : (num(inner.economy_berths) ?? num(inner.economyBerths) ?? num(inner.economy) ?? 0);
  const business = hasBerths
    ? num(berthsRaw!.business) ?? 0
    : (num(inner.business_berths) ?? num(inner.businessBerths) ?? num(inner.business) ?? 0);
  const first = hasBerths
    ? num(berthsRaw!.first) ?? 0
    : (num(inner.first_berths) ?? num(inner.firstBerths) ?? num(inner.first) ?? 0);
  for (let i = 0; i < passengers.length; i++) {
    const p = passengers[i];
    if (typeof p === "object" && p !== null) {
      const po = p as unknown as Record<string, unknown>;
      if (po.destination_system === undefined && po.destinationSystem !== undefined) {
        po.destination_system = po.destinationSystem;
      }
    }
  }
  return {
    passengers,
    berths: { economy, business, first },
    berths_used: {
      economy: num(berthsUsedRaw?.economy) ?? 0,
      business: num(berthsUsedRaw?.business) ?? 0,
      first: num(berthsUsedRaw?.first) ?? 0,
    },
  };
}

function extractBerthsFromCapabilities(capabilities: unknown): { economy: number; business: number; first: number } | null {
  if (!Array.isArray(capabilities)) return null;
  let economy = 0, business = 0, first = 0;
  for (const cap of capabilities) {
    if (!cap || typeof cap !== "object") continue;
    const c = cap as Record<string, unknown>;
    const type = (c.type as string) || "";
    const value = (c.value as number) || 0;
    if (type === "passenger_economy_berths") economy = value;
    else if (type === "passenger_business_berths") business = value;
    else if (type === "passenger_first_berths") first = value;
  }
  if (economy === 0 && business === 0 && first === 0) return null;
  return { economy, business, first };
}

function countPassengerModules(modules: unknown): { economy: number; business: number; first: number } {
  if (!Array.isArray(modules)) return { economy: 0, business: 0, first: 0 };
  let economy = 0, business = 0, first = 0;
  for (const m of modules) {
    if (!m || typeof m !== "object") continue;
    const mod = m as Record<string, unknown>;
    const typeId = ((mod.type_id as string) || (mod.type as string) || "") as string;
    const typeName = ((mod.name as string) || (mod.type_name as string) || "") as string;
    const allText = (typeId + " " + typeName).toLowerCase();
    
    if (allText.includes("passenger") || allText.includes("berth") || allText.includes("cabin")) {
      if (allText.includes("first")) first += 1;
      else if (allText.includes("business")) business += 1;
      else if (allText.includes("economy")) economy += 1;
    }
  }
  return { economy, business, first };
}

function parseListShips(result: unknown): FleetShip[] {
  if (!result || typeof result !== "object") return [];
  const r = result as Record<string, unknown>;
  const ships = Array.isArray(r.ships) ? r.ships : Array.isArray(r.fleet) ? r.fleet : [];
  const catalog = loadCatalog();
  
  return ships.map((s: Record<string, unknown>) => {
    let berths: { economy: number; business: number; first: number } = { economy: 0, business: 0, first: 0 };
    
    const directBerths = (s.passenger_berths || s.berths || {}) as Record<string, number>;
    if (directBerths.economy || directBerths.business || directBerths.first) {
      berths = {
        economy: directBerths.economy || 0,
        business: directBerths.business || 0,
        first: directBerths.first || 0,
      };
    } else {
      const classId = ((s.type || s.class_id || (s.class as Record<string, unknown>)?.id || s.ship_type || "") as string);
      const classData = catalog[classId];
      const caps = classData?.inherent_capabilities;
      const fromCaps = extractBerthsFromCapabilities(caps);
      if (fromCaps) {
        berths = fromCaps;
      }
    }
    
    const typeId = (s.type || s.class_id || (s.class as Record<string, unknown>)?.id || s.ship_type || "") as string;
    const customName = (s.custom_name || s.customName || "") as string;
    return {
      shipId: (s.ship_id || s.id || "") as string,
      shipName: (s.name || s.ship_name || s.class_name || "") as string,
      customName: customName || undefined,
      type: typeId,
      tier: (s.tier as number) ?? null,
      berths,
      storedAtStationId: (s.stored_at_station_id || s.station_id || s.current_station || s.location_base_id || "") as string,
      storedAtSystemId: (s.stored_at_system_id || s.system_id || s.system || "") as string,
      hasShipyard: (s.has_shipyard as boolean) || false,
      cargoCapacity: (s.cargo_capacity || s.max_cargo || 0) as number,
      cargoUsed: (s.cargo_used || 0) as number,
    };
  });
}

// ── Ship info ─────────────────────────────────────────────────

function totalBerths(b: { economy: number; business: number; first: number }): number {
  return b.economy + b.business + b.first;
}

async function getCurrentShipInfo(ctx: RoutineContext, shipId: string): Promise<{ shipId: string; shipName: string; customName: string | undefined; tier: number | null; berths: { economy: number; business: number; first: number } } | null> {
  const { bot } = ctx;
  const resp = await bot.exec("get_ship", { ship_id: shipId });
  if (resp.error || !resp.result) {
    return null;
  }
  const result = resp.result as Record<string, unknown>;
  const shipData = (result.ship as Record<string, unknown>) || result;
  const cls = (result.class as Record<string, unknown>) || (shipData.class as Record<string, unknown>);
  
  const customName = (shipData.custom_name || shipData.customName) as string | undefined;
  const classId = (shipData.class_id || cls?.id || "") as string;
  const name = (shipData.name || shipData.ship_name || shipData.class_name || classId || "Unknown") as string;
  const typeId = (shipData.type || shipData.class_id || cls?.id || "") as string;
  const tier = (shipData.tier as number) ?? null;
  const cargoCapacity = (shipData.cargo_capacity || shipData.max_cargo || 0) as number;
  
  let berths = { economy: 0, business: 0, first: 0 };
  const directBerths = (shipData.passenger_berths || shipData.berths || {}) as Record<string, number>;
  if (directBerths.economy || directBerths.business || directBerths.first) {
    berths = {
      economy: directBerths.economy || 0,
      business: directBerths.business || 0,
      first: directBerths.first || 0,
    };
  } else {
    const catalog = loadCatalog();
    const classData = catalog[typeId];
    if (classData) {
      const caps = classData.inherent_capabilities;
      const fromCaps = extractBerthsFromCapabilities(caps);
      if (fromCaps) {
        berths = fromCaps;
      }
      if (totalBerths(berths) === 0 && classData.special === "passenger_liner") {
        berths = { economy: 1, business: 0, first: 0 };
      }
    }
  }
  
  const modules = (shipData.modules as unknown[]) || [];
  if (totalBerths(berths) === 0 && Array.isArray(modules) && modules.length > 0) {
    const fromMods = countPassengerModules(modules);
    if (totalBerths(fromMods) > 0) {
      berths = fromMods;
    }
  }
  
  return {
    shipId: (shipData.id || shipId) as string,
    shipName: name,
    customName: customName || undefined,
    tier,
    berths,
  };
}

// ── Passenger / station selection ────────────────────────────

async function selectPickupStation(
  ctx: RoutineContext,
  berths: { economy: number; business: number; first: number },
  maxJumps: number,
  blockPirateStations: boolean,
  excludeCurrentStation: boolean = false,
): Promise<{ system: string; poi: string; poiName: string; count: number } | null> {
  const { bot } = ctx;
  const stations: Array<{ system: string; poi: string; poiName: string; count: number; hops: number }> = [];
  const currentPoi = bot.poi || "";
  const currentSystem = bot.system || "";

  // Check current station first if docked (unless excluded)
  if (!excludeCurrentStation && bot.docked && currentPoi && currentSystem) {
    if (!blockPirateStations || !isPirateStation(currentPoi)) {
      const resp = await bot.exec("list_station_passengers");
      if (!resp.error && resp.result) {
        const data = parseStationPassengers(resp.result);
        if (data && data.count > 0) {
          stations.push({
            system: currentSystem,
            poi: currentPoi,
            poiName: data.station,
            count: data.count,
            hops: 0,
          });
        }
      }
    }
  }

  // Scan nearby known systems via mapStore
  const blacklist = getSystemBlacklist();
  const knownSystems = mapStore.getAllSystems();

  // Collect candidate systems within maxJumps
  const candidates = new Map<string, { hops: number; systemId: string }>();
  if (currentSystem) {
    candidates.set(currentSystem.toLowerCase(), { hops: 0, systemId: currentSystem });
    const conns = knownSystems[currentSystem]?.connections || [];
    let frontier = [currentSystem];
    for (let depth = 1; depth <= maxJumps; depth++) {
      const nextFrontier: string[] = [];
      for (const sys of frontier) {
        const systemConns = knownSystems[sys]?.connections || [];
        for (const c of systemConns) {
          const cid = c.system_id.toLowerCase();
          if (!candidates.has(cid) && !blacklist.includes(c.system_id)) {
            candidates.set(cid, { hops: depth, systemId: c.system_id });
            nextFrontier.push(c.system_id);
          }
        }
      }
      frontier = nextFrontier;
      if (frontier.length === 0) break;
    }
  }

// Query candidate systems sequentially with rate limiting to avoid flooding the API
  const SYSTEM_DELAY_MS = 1000;
  const MAX_SYSTEMS_TO_CHECK = 10;
   
   const validCandidates = Array.from(candidates.values()).filter(
     (info) => info.hops <= maxJumps && !(blockPirateStations && isPirateSystem(info.systemId))
   );
   
   // Sort by hops to prioritize closer systems
   validCandidates.sort((a, b) => a.hops - b.hops);
   
   // Limit total systems checked to prevent excessive requests
   const candidatesToCheck = validCandidates.slice(0, MAX_SYSTEMS_TO_CHECK);
   
   for (let i = 0; i < candidatesToCheck.length; i++) {
     const info = candidatesToCheck[i];
     
     try {
       const sysResp = await bot.exec("get_system", { system_id: info.systemId });
       if (sysResp.error || !sysResp.result) {
         if (i < candidatesToCheck.length - 1) await ctx.sleep(SYSTEM_DELAY_MS);
         continue;
       }
       const sysResult = sysResp.result as Record<string, unknown>;
       const sysObj = sysResult.system as Record<string, unknown> || sysResult;
       const pois = (sysObj.pois || []) as Array<Record<string, unknown>>;
for (const p of pois) {
          const hasBase = p.has_base || p.base_id || p.base;
          if (!hasBase) continue;
          const poiId = (p.id || p.poi_id || p.name || "") as string;
          if (!poiId) continue;
          if (blockPirateStations && isPirateStation(poiId)) continue;
          const pResp = await bot.exec("list_station_passengers", { station: poiId });
         if (pResp.error || !pResp.result) continue;
         const pData = parseStationPassengers(pResp.result);
         if (pData && pData.count > 0) {
           stations.push({
             system: info.systemId,
             poi: poiId,
             poiName: pData.station,
             count: pData.count,
             hops: info.hops,
           });
         }
       }
     } catch {
       // skip system query errors
     }
     
     // Delay between system queries to avoid rate limiting
     if (i < candidatesToCheck.length - 1) await ctx.sleep(SYSTEM_DELAY_MS);
   }

   if (stations.length === 0) return null;

   // Filter to stations within maxJumps, then sort by count (descending)
   const validStations = stations.filter(s => s.hops <= maxJumps);
   if (validStations.length === 0) return null;
   
validStations.sort((a, b) => b.count - a.count || a.hops - b.hops);
    return { system: validStations[0].system, poi: validStations[0].poi, poiName: validStations[0].poiName, count: validStations[0].count };
  }

async function selectNextPickupStation(
  ctx: RoutineContext,
  state: TransportState,
  settings: CivilianTransportSettings,
): Promise<{ system: string; poi: string; poiName: string } | null> {
  const { bot } = ctx;
  
  let empire = bot.getEmpire();
  
  if (!empire && bot.poi && bot.system) {
    const stationRef = loadStationRef();
    const stationInfo = stationRef.by_underline_name[bot.poi.toLowerCase()] || 
                         stationRef.by_station_id[bot.poi.toLowerCase()];
    if (stationInfo) {
      const systemId = stationInfo.system_id.toLowerCase();
      for (const [emp, stations] of Object.entries(EMPIRE_STATIONS)) {
        if (stations.some(s => s.systemId.toLowerCase() === systemId || s.poiId.toLowerCase() === bot.poi.toLowerCase())) {
          empire = emp;
          ctx.log("transport", `Derived empire '${emp}' from current station ${bot.poi}`);
          break;
        }
      }
    }
  }
  
  if (!empire) {
    ctx.log("transport", "Cannot determine bot's empire, falling back to nearest station search");
    const pickup = await selectPickupStation(ctx, state.berths, settings.maxJumps, settings.blockPirateStations, true);
    if (!pickup) return null;
    return { system: pickup.system, poi: pickup.poi, poiName: pickup.poiName };
  }

  const empireLower = empire.toLowerCase();
  const empireStations = getStationsForEmpire(empireLower);
  
  if (empireStations.length === 0) {
    ctx.log("transport", `No known stations for empire ${empire}, falling back to nearest station search`);
    const pickup = await selectPickupStation(ctx, state.berths, settings.maxJumps, settings.blockPirateStations, true);
    if (!pickup) return null;
    return { system: pickup.system, poi: pickup.poi, poiName: pickup.poiName };
  }

  const currentSystem = bot.system || "";
  const currentPoi = bot.poi || "";
  
  const availableStations = empireStations.filter(
    s => s.poiId !== currentPoi || s.systemId !== currentSystem
  );
  
  if (availableStations.length === 0) {
    ctx.log("transport", `All empire stations already checked, finding nearest from ${empireStations.length} total`);
    let nearest: EmpireStation & { dist: number } = { ...empireStations[0], dist: 9999 };
    for (const s of empireStations) {
      if (s.poiId === currentPoi && s.systemId === currentSystem) continue;
      const dist = hopsBetweenSync(currentSystem, s.systemId);
      if (dist < nearest.dist) {
        nearest = { ...s, dist };
      }
    }
    if (nearest.dist === 9999) {
      ctx.log("transport", `No other empire stations available`);
      return null;
    }
    if (nearest.dist > settings.maxJumps) {
      ctx.log("transport", `No stations within ${settings.maxJumps} hops, using nearest: ${nearest.poiName}`);
    }
    return { system: nearest.systemId, poi: nearest.poiId, poiName: nearest.poiName };
  }

  if (empireLower === "solarian") {
    const randomStation = availableStations[Math.floor(Math.random() * availableStations.length)];
    if (randomStation.poiId === currentPoi && randomStation.systemId === currentSystem) {
      ctx.log("transport", `Randomly selected same station, using next available`);
      const otherStations = availableStations.filter(s => !(s.poiId === currentPoi && s.systemId === currentSystem));
      if (otherStations.length > 0) {
        return { system: otherStations[0].systemId, poi: otherStations[0].poiId, poiName: otherStations[0].poiName };
      }
    }
    ctx.log("transport", `Solarian Empire: randomly selecting ${randomStation.poiName}`);
    return { system: randomStation.systemId, poi: randomStation.poiId, poiName: randomStation.poiName };
  }

  const stationsWithHops = availableStations.map(s => {
    const hops = hopsToStation(currentSystem, s.systemId);
    return { ...s, hops };
  }).filter(s => s.hops <= settings.maxJumps);
  
  ctx.log("transport", `Found ${stationsWithHops.length} reachable stations out of ${availableStations.length}`);
  
  if (stationsWithHops.length === 0) {
    let nearest: EmpireStation & { dist: number } = { ...availableStations[0], dist: 9999 };
    for (const s of availableStations) {
      if (s.poiId === currentPoi && s.systemId === currentSystem) continue;
      const dist = hopsToStation(currentSystem, s.systemId);
      if (dist < nearest.dist) {
        nearest = { ...s, dist };
      }
    }
    if (nearest.dist === 9999) {
      ctx.log("transport", `No other stations within ${settings.maxJumps} hops`);
      return null;
    }
    ctx.log("transport", `No stations within ${settings.maxJumps} hops, falling back to nearest: ${nearest.poiName}`);
    return { system: nearest.systemId, poi: nearest.poiId, poiName: nearest.poiName };
  }
  
  stationsWithHops.sort((a, b) => a.hops - b.hops);
  const next = stationsWithHops[0];
  ctx.log("transport", `Moving to next closest station: ${next.poiName} (${next.hops} hops)`);
  return { system: next.systemId, poi: next.poiId, poiName: next.poiName };
}

// ── Route planning ───────────────────────────────────────────

async function hopsBetween(a: string, b: string, bot: Bot): Promise<number> {
  if (a.toLowerCase() === b.toLowerCase()) return 0;
  const route = mapStore.findRoute(a, b, getSystemBlacklist());
  if (route) return route.length - 1;
  
  const routeResp = await bot.exec("find_route", { target_system: b });
  if (!routeResp.error && routeResp.result) {
    const result = routeResp.result as Record<string, unknown>;
    // Check for valid route in multiple formats
    if (result.found || result.target_system) {
      const jumps = (result.total_jumps as number) || (result.route && (result.route as Array<{system_id: string}>).length - 1) || 1;
      return Math.max(0, typeof jumps === 'number' ? jumps : 1);
    }
    // Also check if route array exists (server may not set 'found' but still return valid route)
    const serverRoute = result.route as Array<{ system_id: string }> | undefined;
    if (serverRoute && serverRoute.length > 0) {
      const jumps = serverRoute.length - 1;
      return Math.max(0, jumps);
    }
  } else if (routeResp.error) {
    // Error already handled
  }
  console.log(`hopsBetween: no route found from ${a} to ${b}`);
  return 9999;
}

async function planTourRoute(
  currentSystem: string,
  destinations: Array<{ system: string; poi: string; poiName: string; origDest?: string }>,
  maxJumps: number,
  bot: Bot,
): Promise<Array<{ system: string; poi: string; poiName: string; origDest?: string }>> {
  const validDests = destinations.filter(d => d.system);
  if (validDests.length === 0) {
    console.log(`planTourRoute: no valid destinations (total=${destinations.length})`);
    return [];
  }
  if (!currentSystem) {
    console.log(`planTourRoute: no current system, returning ${validDests.length} destinations`);
    return validDests;
  }
  if (validDests.length === 1) return validDests;

  const remaining = [...validDests];
  const planned: typeof destinations = [];
  let cur = currentSystem;
  let totalJumps = 0;

  while (remaining.length > 0) {
    let bestIndex = -1;
    let bestHops = maxJumps + 1;
    for (let i = 0; i < remaining.length; i++) {
      const hops = await hopsBetween(cur, remaining[i].system, bot);
      if (hops <= maxJumps && hops < bestHops) {
        bestHops = hops;
        bestIndex = i;
      }
    }

    if (bestIndex === -1) {
      console.log(`planTourRoute: no reachable destination from ${cur}, remaining=${remaining.length}`);
      // Fallback: return all remaining destinations anyway
      console.log(`planTourRoute: fallback - returning all ${remaining.length} remaining destinations`);
      return [...planned, ...remaining];
    }

    const next = remaining.splice(bestIndex, 1)[0]!;
    if (totalJumps + bestHops > maxJumps) {
      break;
    }
    totalJumps += bestHops;
    planned.push(next);
    cur = next.system;
  }
  return planned;
}

function hopsBetweenSync(a: string, b: string): number {
  if (a.toLowerCase() === b.toLowerCase()) return 0;
  const route = mapStore.findRoute(a, b, getSystemBlacklist());
  if (!route) return 9999;
  return route.length - 1;
}

function hopsToStation(a: string, b: string): number {
  if (a.toLowerCase() === b.toLowerCase()) return 0;
  const route = mapStore.findRoute(a, b);
  if (!route) return 9999;
  return route.length - 1;
}

function makeNewState(bot: Bot, shipId: string, shipName: string, customName: string | undefined, tier: number | null, berths: { economy: number; business: number; first: number }): TransportState {
  return {
    botUsername: bot.username,
    status: "idle",
    shipId,
    shipName,
    customName,
    tier,
    berths,
    berths_used: { economy: 0, business: 0, first: 0 },
    onboardPassengers: [],
    pickupStation: null,
    pickupSystem: null,
    route: [],
    currentRouteIndex: 0,
    revenue: 0,
    totalFaresEarned: 0,
    currentDestination: null,
    lastUpdated: new Date().toISOString(),
    routeRebuildAttempts: 0,
    roundsWithoutPassengers: 0,
  };
}

// ── Main routine ─────────────────────────────────────────────

export const civilianTransportRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;
  const settings = getCivilianTransportSettings(bot.username);
  let state = loadTransportState(bot.username);
  let idleStartTime = 0;
  const IDLE_RETURN_THRESHOLD_MS = 60 * 60 * 1000; // Return home after 1 hour of idle time

  // Get current ship info via get_ship
  const currentShipId = bot.shipId || "";
  const currentShipInfo = currentShipId ? await getCurrentShipInfo(ctx, currentShipId) : null;
  
  if (!currentShipInfo || currentShipInfo.berths.economy + currentShipInfo.berths.business + currentShipInfo.berths.first === 0) {
    ctx.log("error", "Current ship has no passenger berths or cannot be verified. Routine cannot run.");
    return;
  }
  
  // Initialize state if none or invalid
  if (!state || !isValidTransportState(state)) {
    ctx.log("transport", "State invalid or missing, creating new state");
    clearTransportState(bot.username);
    state = makeNewState(bot, currentShipInfo.shipId, currentShipInfo.shipName, currentShipInfo.customName, currentShipInfo.tier, currentShipInfo.berths);
    saveTransportState(state);
  } else if (state.status === "in_transit" && state.route.length === 0) {
    ctx.log("transport", "State is in_transit but route is empty, resetting to idle");
    state.status = "idle";
    state.route = [];
    state.currentRouteIndex = 0;
    state.currentDestination = null;
    saveTransportState(state);
  } else if (state.status === "idle" && state.onboardPassengers.length > 0) {
    const allStranded = state.onboardPassengers.every(p => p.status === "stranded");
    if (allStranded) {
      ctx.log("transport", "All passengers stranded, clearing state");
      state.onboardPassengers = [];
      state.route = [];
      state.currentRouteIndex = 0;
      state.currentDestination = null;
      saveTransportState(state);
    }
  }
  
  if (state) {
    ctx.log("transport", `Loaded state: status=${state.status}, route.length=${state.route.length}`);
    // Verify state against current ship
    state.shipId = currentShipInfo.shipId;
    state.shipName = currentShipInfo.shipName;
    state.customName = currentShipInfo.customName;
    state.tier = currentShipInfo.tier;
    state.berths = currentShipInfo.berths;
    saveTransportState(state);
  }

ctx.log("transport", `Civilian transport started. Ship: ${state.customName || state.shipName}. Status: ${state.status}`);

  // Enable cloaking if configured and module is available
  if (settings.enableCloak) {
    await enableCloakingIfPossible(ctx);
  }

  // Collect fuel cells at home base on startup
  if (settings.homeStation && bot.docked && bot.poi && bot.poi.toLowerCase() === settings.homeStation.toLowerCase()) {
    ctx.log("transport", "At home station - collecting fuel cells");
    await collectFuelCells(ctx, settings);
    await bot.refreshShip();
    const fuelPct = bot.maxFuel > 0 ? (bot.fuel / bot.maxFuel) * 100 : 0;
    ctx.log("transport", `Fuel after collection: ${Math.round(fuelPct)}%`);
  }

  if (state && state.status !== "idle") {
    const verifyResp = await bot.exec("list_passengers");
    if (verifyResp.error || !verifyResp.result) {
      state.status = "idle";
      state.onboardPassengers = [];
      state.route = [];
      state.currentRouteIndex = 0;
      state.currentDestination = null;
      state.berths_used = { economy: 0, business: 0, first: 0 };
      saveTransportState(state);
    } else {
      const vParsed = parseListPassengers(verifyResp.result);
      const verifiedCount = vParsed ? vParsed.passengers.length : 0;
      if (verifiedCount === 0) {
        state.status = "idle";
        state.onboardPassengers = [];
        state.route = [];
        state.currentRouteIndex = 0;
        state.currentDestination = null;
        state.berths_used = { economy: 0, business: 0, first: 0 };
        saveTransportState(state);
      } else {
        const destMap = new Map<string, { system: string; poi: string; poiName: string; count: number }>();
        for (const p of vParsed!.passengers) {
          const existing = destMap.get(p.destination);
          if (existing) {
            existing.count++;
            continue;
          }
          const resolved = await resolveDestination(ctx, bot, p.destination, p.destination_name, p.destination_system);
          destMap.set(p.destination, { system: resolved?.system || "", poi: resolved?.poi || p.destination, poiName: p.destination_name, count: 1 });
        }
        const routeDests = Array.from(destMap.values()).filter(d => d.system);
        const planned = await planTourRoute(bot.system || "", routeDests, 6, bot);
        state.onboardPassengers = vParsed!.passengers.map(p => ({
          citizenId: p.citizen_id || p.name,
          name: p.name,
          accommodationClass: (p.class || "economy").toLowerCase() as "economy" | "business" | "first",
          citizenship: p.citizenship,
          destination: p.destination,
          destinationName: p.destination_name,
          destinationSystem: (p as any).destinationSystem || p.destination_system,
          fare: p.fare,
          bio: p.bio,
          routeData: p.route_data || null,
          loadedAt: new Date().toISOString(),
          status: "boarded",
          ticksRemaining: p.ticks_remaining,
        }));
        state.route = planned;
        state.currentRouteIndex = 0;
        state.currentDestination = planned.length > 0 ? planned[0].poiName : null;
        state.status = "in_transit";
        const recoveredBerths = vParsed!.berths;
        const recoveredBerthsUsed = vParsed!.berths_used;
        const hasRecoveredBerths = (recoveredBerths.economy + recoveredBerths.business + recoveredBerths.first) > 0;
        if (hasRecoveredBerths) {
          state.berths = recoveredBerths;
          state.berths_used = recoveredBerthsUsed;
        }
        saveTransportState(state);
      }
    }
  } else if (state && state.status === "idle") {
    const verifyResp = await bot.exec("list_passengers");
    if (!verifyResp.error && verifyResp.result) {
      const vParsed = parseListPassengers(verifyResp.result);
      const verifiedCount = vParsed ? vParsed.passengers.length : 0;
      if (verifiedCount > 0) {
        const destMap = new Map<string, { system: string; poi: string; poiName: string; count: number }>();
        for (const p of vParsed!.passengers) {
          const existing = destMap.get(p.destination);
          if (existing) {
            existing.count++;
            continue;
          }
          const resolved = await resolveDestination(ctx, bot, p.destination, p.destination_name, p.destination_system);
          destMap.set(p.destination, { system: resolved?.system || "", poi: resolved?.poi || p.destination, poiName: p.destination_name, count: 1 });
        }
        const routeDests = Array.from(destMap.values()).filter(d => d.system);
        const planned = await planTourRoute(bot.system || "", routeDests, 6, bot);
        state.onboardPassengers = vParsed!.passengers.map(p => ({
          citizenId: p.citizen_id || p.name,
          name: p.name,
          accommodationClass: (p.class || "economy").toLowerCase() as "economy" | "business" | "first",
          citizenship: p.citizenship,
          destination: p.destination,
          destinationName: p.destination_name,
          destinationSystem: (p as any).destinationSystem || p.destination_system,
          fare: p.fare,
          bio: p.bio,
          routeData: p.route_data || null,
          loadedAt: new Date().toISOString(),
          status: "boarded",
          ticksRemaining: p.ticks_remaining,
        }));
        state.route = planned;
        state.currentRouteIndex = 0;
        state.currentDestination = planned.length > 0 ? planned[0].poiName : null;
        state.status = "in_transit";
        saveTransportState(state);
      }
    }
  }

  // Battle state tracking
  const battleState: BattleState = {
    inBattle: false,
    battleId: null,
    battleStartTick: null,
    lastHitTick: null,
    isFleeing: false,
    lastFleeTime: undefined,
  };

  while (bot.state === "running") {
    yield state.status;
    ctx.log("transport", `Main loop: status=${state.status}, route.length=${state.route.length}, currentRouteIndex=${state.currentRouteIndex}, onboard=${state.onboardPassengers.length}`);

    // ── Death recovery ──
    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) { await ctx.sleep(30000); continue; }

    // ── Battle check ──
    if (battleState.inBattle) {
      const now = Date.now();
      if (!battleState.lastFleeTime || now - battleState.lastFleeTime > 10000) {
        ctx.log("combat", "Re-issuing flee stance during civilian transport...");
        const fleeResp = await bot.exec("battle", { action: "stance", stance: "flee" });
        if (fleeResp.error) {
          ctx.log("error", `Flee re-issue failed: ${fleeResp.error.message}`);
        } else {
          battleState.lastFleeTime = now;
        }
      }
      let battleCleared = !bot.isInBattle();
      if (!battleCleared) {
        const current = await getBattleStatus(ctx);
        battleCleared = !current || !current.is_participant;
      }
      if (battleCleared) {
        ctx.log("combat", "Battle cleared — resuming civilian transport");
        battleState.inBattle = false;
        battleState.battleId = null;
        battleState.isFleeing = false;
        battleState.lastFleeTime = undefined;
      } else {
        await ctx.sleep(2000);
        continue;
      }
    } else {
      if (await checkAndFleeFromBattle(ctx, "civilian_transport")) {
        battleState.inBattle = true;
        battleState.isFleeing = false;
        battleState.lastFleeTime = Date.now();
        await ctx.sleep(2000);
        continue;
      }
    }

    if (bot.isInBattle()) {
      const now = Date.now();
      if (!battleState.lastFleeTime || now - battleState.lastFleeTime > 10000) {
        ctx.log("combat", "PERIODIC CHECK: IN BATTLE during civilian transport!");
        battleState.inBattle = true;
        await bot.exec("battle", { action: "stance", stance: "flee" });
        battleState.lastFleeTime = now;
      }
    }

    // --- State machine ---
    if (state.status === "idle") {
      // Check idle timeout - return home if stuck idle for too long
      const isAwayFromHome = settings.homeSystem && bot.system && bot.system.toLowerCase() !== settings.homeSystem.toLowerCase();
      if (isAwayFromHome && !bot.docked) {
        if (idleStartTime === 0) {
          idleStartTime = Date.now();
        }
        const elapsedMs = Date.now() - idleStartTime;
        if (elapsedMs >= IDLE_RETURN_THRESHOLD_MS) {
          ctx.log("transport", `⏱️ Idle for ${Math.round(elapsedMs / 1000)}s away from home - returning home...`);
          state.status = "idle";
          state.route = [];
          state.currentRouteIndex = 0;
          state.currentDestination = null;
          state.pickupStation = settings.homeStation || null;
          state.pickupSystem = settings.homeSystem || null;
          state.roundsWithoutPassengers = 0;
          saveTransportState(state);
          idleStartTime = 0;
          await ctx.sleep(5000);
          continue;
        }
      } else if (idleStartTime !== 0) {
        idleStartTime = 0;
      }

      // Need to find passengers and load up
      // If already docked at a station, check for passengers to loaf
      if (bot.docked && bot.poi && bot.system) {
        // Collect fuel cells at any station when idle
        await collectFuelCells(ctx, settings);
        const resp = await bot.exec("list_station_passengers");
        if (!resp.error && resp.result) {
          const data = parseStationPassengers(resp.result);
          if (data && data.count > 0) {
            state.pickupStation = bot.poi;
            state.pickupSystem = bot.system;
            ctx.log("transport", `Found ${data.count} passengers at ${bot.poi}`);
          } else {
            state.roundsWithoutPassengers = (state.roundsWithoutPassengers || 0) + 1;
            ctx.log("transport", `No passengers at ${bot.poi}. Round ${state.roundsWithoutPassengers}/${settings.roundsBeforeMoving}`);
            if (state.roundsWithoutPassengers >= settings.roundsBeforeMoving) {
              ctx.log("transport", `Threshold reached (${settings.roundsBeforeMoving} rounds without passengers). Moving to next station.`);
              const nextPickup = await selectNextPickupStation(ctx, state, settings);
              if (!nextPickup) {
                // No next pickup available - try to return home
                if (settings.homeSystem) {
                  ctx.log("transport", `No next pickup found, returning home to ${settings.homeSystem}`);
                  state.pickupStation = settings.homeStation || null;
                  state.pickupSystem = settings.homeSystem || null;
                  state.roundsWithoutPassengers = 0;
                } else {
                  await ctx.sleep(60000);
                  continue;
                }
              } else {
                const isSameStation = nextPickup.poi.toLowerCase() === bot.poi.toLowerCase() && nextPickup.system.toLowerCase() === bot.system.toLowerCase();
                if (isSameStation) {
                  ctx.log("transport", `Next pickup is same station, resetting counter and checking for different passengers`);
                  state.roundsWithoutPassengers = 0;
                  state.pickupStation = nextPickup.poi;
                  state.pickupSystem = nextPickup.system;
                  await ctx.sleep(5000);
                  continue;
                }
                state.roundsWithoutPassengers = 0;
                state.pickupStation = nextPickup.poi;
                state.pickupSystem = nextPickup.system;
              }
            } else {
              await ctx.sleep(60000);
              continue;
            }
          }
        } else {
          await ctx.sleep(60000);
          continue;
        }
      } else {
        const pickup = await selectPickupStation(ctx, state.berths, settings.maxJumps, settings.blockPirateStations);
        if (!pickup) {
          // No passengers found anywhere - check if we should return home
          if (settings.homeSystem && bot.system && bot.system.toLowerCase() !== settings.homeSystem.toLowerCase()) {
            ctx.log("transport", `No passengers found, returning home from ${bot.system}`);
            state.pickupStation = settings.homeStation || null;
            state.pickupSystem = settings.homeSystem || null;
          } else {
            await ctx.sleep(60000);
            continue;
          }
        } else {
          state.pickupStation = pickup.poi;
          state.pickupSystem = pickup.system;
        }
      }

      // Check if already at pickup station before any travel
      const poiMatch = String(bot.poi || "").toLowerCase() === String(state.pickupStation || "").toLowerCase();
      const sysMatch = String(bot.system || "").toLowerCase() === String(state.pickupSystem || "").toLowerCase();
      const alreadyAtPickup = bot.docked && poiMatch && sysMatch;
      
      if (!alreadyAtPickup) {
        // Travel to pickup station and dock
        if (!state.pickupStation || !state.pickupSystem) {
          state.status = "idle";
          saveTransportState(state);
          await ctx.sleep(30000);
          continue;
        }
        state.status = "traveling_to_ship";
        saveTransportState(state);
        if (state.pickupSystem !== bot.system) {
          const ok = await navigateToSystem(ctx, state.pickupSystem, { fuelThresholdPct: settings.refuelThreshold, hullThresholdPct: settings.repairThreshold, skipBlacklist: true });
          if (!ok) {
            state.status = "idle";
            saveTransportState(state);
            await ctx.sleep(30000);
            continue;
          }
        }
        if (bot.poi !== state.pickupStation) {
          const tr = await bot.exec("travel", { target_poi: state.pickupStation });
          if (tr.error) {
            state.status = "idle";
            saveTransportState(state);
            await ctx.sleep(30000);
            continue;
          }
        }
        const dOk = await ensureDocked(ctx);
        if (!dOk) {
          state.status = "idle";
          saveTransportState(state);
          await ctx.sleep(30000);
          continue;
        }
        await collectFuelCells(ctx, settings);
      } else {
        ctx.log("transport", `Ready at ${state.pickupStation}`);
        await collectFuelCells(ctx, settings);
      }
      state.status = "loading";
      saveTransportState(state);
      if (bot.state !== "running") {
        await ctx.sleep(10000);
        continue;
      }

// Count berth availability BEFORE issuing any load commands
      const preListResp = await bot.exec("list_passengers");
      let preListParsed: ListPassengersResponse | null = null;
      if (!preListResp.error && preListResp.result) {
        preListParsed = parseListPassengers(preListResp.result);
      }
      state.berths = preListParsed && (preListParsed.berths.economy + preListParsed.berths.business + preListParsed.berths.first) > 0
        ? preListParsed.berths
        : state.berths;
      state.berths_used = preListParsed
        ? preListParsed.berths_used
        : { economy: 0, business: 0, first: 0 };
      const freeEconomy = state.berths.economy - state.berths_used.economy;
      const freeBusiness = state.berths.business - state.berths_used.business;
      const freeFirst = state.berths.first - state.berths_used.first;
      if (state.berths.economy + state.berths.business + state.berths.first === 0) {
        state.status = "idle";
        saveTransportState(state);
        await ctx.sleep(10000);
        continue;
      }

      // Determine destination groups
      const stationResp = await bot.exec("list_station_passengers");
      let waiting: StationPassenger[] = [];
      if (!stationResp.error && stationResp.result) {
        const parsed = parseStationPassengers(stationResp.result);
        if (parsed) waiting = parsed.waiting;
      }

      for (const p of waiting) {
        civilianStore.registerSeen({
          citizenId: p.citizen_id,
          name: p.name,
          accommodationClass: p.class.toLowerCase() as "economy" | "business" | "first",
          destination: p.destination,
          destinationName: p.destination_name,
          destinationSystem: (p as any).destinationSystem || p.destination_system,
          fare: 0,
          bio: p.bio || "",
        });
      }

      // Group passengers by destination
      const byDest = new Map<string, StationPassenger[]>();
      for (const p of waiting) {
        const cls = p.class.toLowerCase();
        if (settings.blockPirateStations && isPirateStation(p.destination)) continue;
        if (cls === "first" && !settings.allowFirstClass) continue;
        if (cls === "business" && !settings.allowBusinessClass) continue;
        if (cls === "economy" && !settings.allowEconomyClass) continue;
        const arr = byDest.get(p.destination) || [];
        arr.push(p);
        byDest.set(p.destination, arr);
      }

      // For multi-destination tours, plan the route FIRST so loading order follows it.
      // This prevents stranding nearby passengers when distant destinations fill berths first.
      ctx.log("transport", `Determining destinations for ${waiting.length} waiting passengers`);
      const destDrafts: Array<{ system: string; poi: string; poiName: string; count: number; origDest: string }> = [];
      for (const [destId, ps] of byDest.entries()) {
        ctx.log("transport", `resolveDestination for waiting passenger: ${destId} (name: ${ps[0]?.destination_name || destId}, system: ${ps[0]?.destination_system || 'none'})`);
        const resolved = await resolveDestination(ctx, bot, destId, ps[0]?.destination_name || destId, ps[0]?.destination_system);
        if (resolved) {
          ctx.log("transport", `Resolved waiting ${destId} -> system=${resolved.system}, poi=${resolved.poi}`);
        } else {
          ctx.log("transport", `FAILED to resolve waiting passenger ${destId}`);
        }
        destDrafts.push({ system: resolved?.system || "", poi: resolved?.poi || destId, poiName: ps[0]?.destination_name || destId, count: ps.length, origDest: destId });
      }

      const plannedRoute = await planTourRoute(bot.system || "", destDrafts.filter(d => d.system), settings.maxJumps, bot);
      ctx.log("transport", `Planned route: ${plannedRoute.length} waypoints, ${destDrafts.filter(d => !d.system).length} could not resolve`);
      for (const d of destDrafts.filter(d => !d.system)) {
        ctx.log("transport", `  Unresolved destination: ${d.poiName} (origDest: ${d.origDest})`);
      }
      const outsideJumpLimit = destDrafts.filter(d => !d.system);

      if (waiting.length > 0 && byDest.size === 0 && destDrafts.length === 0) {
        ctx.log("transport", `All ${waiting.length} passengers filtered out (likely pirates). Moving to next station.`);
        state.roundsWithoutPassengers = 0;
        const nextPickup = await selectNextPickupStation(ctx, state, settings);
        if (nextPickup) {
          const isSameStation = nextPickup.poi.toLowerCase() === bot.poi.toLowerCase() && nextPickup.system.toLowerCase() === bot.system.toLowerCase();
          if (!isSameStation) {
            state.pickupStation = nextPickup.poi;
            state.pickupSystem = nextPickup.system;
            state.status = "idle";
            saveTransportState(state);
            await ctx.sleep(5000);
            continue;
          }
        }
        if (settings.homeSystem) {
          state.pickupStation = settings.homeStation || null;
          state.pickupSystem = settings.homeSystem || null;
        }
        state.status = "idle";
        saveTransportState(state);
        await ctx.sleep(5000);
        continue;
      }

      // Now load in route order, one destination per loop, berth tally.
      const loadedNames = new Set<string>();
      let usedEconomy = 0;
      let usedBusiness = 0;
      let usedFirst = 0;

      const capAvailable = (used: number, max: number, free: number) => {
        if (max > 0) return Math.min(free, max - used);
        return free;
      };

      for (const leg of plannedRoute) {
        const passengers = byDest.get(leg.poi) || [];
        const passengersByOrigDest = leg.origDest ? byDest.get(leg.origDest) || [] : passengers;
        const passengersFinal = passengersByOrigDest.length > 0 ? passengersByOrigDest : passengers;
        if (passengersFinal.length === 0) continue;

        const totalLoaded = usedEconomy + usedBusiness + usedFirst;
        if (settings.maxPassengers > 0 && totalLoaded >= settings.maxPassengers) {
          break;
        }

        const priority = settings.passengerPriority;
        const classOrder: Record<string, number> = { first: 0, business: 0, economy: 0 };
        if (priority === "first") {
          classOrder.first = 0;
          classOrder.business = 1;
          classOrder.economy = 2;
        } else if (priority === "business") {
          classOrder.business = 0;
          classOrder.first = 1;
          classOrder.economy = 2;
        } else if (priority === "economy") {
          classOrder.economy = 0;
          classOrder.first = 1;
          classOrder.business = 2;
        }
        const sortedPassengers = [...passengersFinal].sort((a, b) => {
          if (priority === "off") return 0;
          return classOrder[a.class.toLowerCase()] - classOrder[b.class.toLowerCase()];
        });

        let loadedThisLeg = 0;
        let loadAttempted = false;
        for (const p of sortedPassengers) {
          if (loadedNames.has(p.citizen_id)) continue;
          const cls = p.class.toLowerCase() as "economy" | "business" | "first";
          const capFirst = capAvailable(usedFirst, settings.maxFirst, freeFirst);
          const capBusiness = capAvailable(usedBusiness, settings.maxBusiness, freeBusiness);
          const capEconomy = capAvailable(usedEconomy, settings.maxEconomy, freeEconomy);
          
          let canLoad = false;
          if (cls === "first" && usedFirst < capFirst) {
            canLoad = true;
            usedFirst++;
          } else if (cls === "business" && usedBusiness < capBusiness) {
            canLoad = true;
            usedBusiness++;
          } else if (cls === "economy") {
            if (usedEconomy < capEconomy) {
              canLoad = true;
              usedEconomy++;
            } else if (usedBusiness < capBusiness) {
              canLoad = true;
              usedBusiness++;
            } else if (usedFirst < capFirst) {
              canLoad = true;
              usedFirst++;
            }
          }
          
          if (!canLoad) continue;
          
          loadedNames.add(p.citizen_id);
          loadedThisLeg++;
        }
        
        if (loadedThisLeg > 0 && !loadAttempted) {
          loadAttempted = true;
          const loadResp = await bot.exec("load_passenger", { destination: leg.origDest || leg.poi });
          if (loadResp.error) {
            ctx.log("error", `load_passenger failed: ${loadResp.error.message}`);
          }
          await ctx.sleep(11000);
        }

        if (bot.state !== "running") {
          break;
        }
        const verifyResp = await bot.exec("list_passengers");
        if (!verifyResp.error && verifyResp.result) {
          const verifyParsed = parseListPassengers(verifyResp.result);
          const currentCount = verifyParsed?.passengers.length || 0;
          if (currentCount > 0 && verifyParsed) {
            const aboardIds = new Set(verifyParsed.passengers.map(p => p.citizen_id || p.name));
            state.onboardPassengers = state.onboardPassengers.filter(op => aboardIds.has(op.citizenId));
            for (const p of verifyParsed.passengers) {
              const existing = state.onboardPassengers.find(op => op.citizenId === (p.citizen_id || p.name));
              if (!existing) {
                state.onboardPassengers.push({
                  citizenId: p.citizen_id || p.name,
                  name: p.name,
                  accommodationClass: p.class.toLowerCase() as "economy" | "business" | "first",
                  citizenship: p.citizenship,
                  destination: p.destination,
                  destinationName: p.destination_name,
                  destinationSystem: (p as any).destinationSystem || p.destination_system,
                  fare: p.fare,
                  bio: p.bio || "",
                  routeData: p.route_data || null,
                  loadedAt: new Date().toISOString(),
                  status: "boarded",
                  ticksRemaining: p.ticks_remaining,
                });
              }
            }
            const destMap = new Map<string, { system: string; poi: string; poiName: string; count: number }>();
            for (const p of verifyParsed.passengers) {
              const existing = destMap.get(p.destination);
              if (existing) { existing.count++; continue; }
              const resolved = await resolveDestination(ctx, bot, p.destination, p.destination_name, p.destination_system);
              if (resolved) {
                destMap.set(p.destination, { ...resolved, count: 1 });
              } else {
                destMap.set(p.destination, { system: "", poi: p.destination, poiName: p.destination_name || p.destination, count: 1 });
              }
            }
            const routeDests = Array.from(destMap.values()).filter(d => d.system);
            state.route = await planTourRoute(bot.system || "", routeDests, 6, bot);
            state.currentRouteIndex = 0;
            state.currentDestination = state.route.length > 0 ? state.route[0].poiName : null;
            ctx.log("transport", `Route recalculated: ${state.route.map(d => d.poiName).join(" → ")}`);
            usedEconomy = verifyParsed.berths_used.economy;
            usedBusiness = verifyParsed.berths_used.business;
            usedFirst = verifyParsed.berths_used.first;
          }
        }
        bot.refreshStatus().catch(() => {});
      }

      const listResp = await bot.exec("list_passengers");
      let aboard: AboardPassenger[] = [];
      if (!listResp.error && listResp.result) {
        const parsed = parseListPassengers(listResp.result);
        if (parsed) {
          aboard = parsed.passengers;
        }
      }

      if (aboard.length === 0) {
        state.roundsWithoutPassengers = (state.roundsWithoutPassengers || 0) + 1;
        ctx.log("transport", `No passengers loaded, round ${state.roundsWithoutPassengers}/${settings.roundsBeforeMoving}`);
        state.status = "idle";
        saveTransportState(state);
        await ctx.sleep(10000);
        continue;
      }

      // Build route from aboard passengers
      const destMap = new Map<string, { system: string; poi: string; poiName: string; count: number }>();
      for (const p of aboard) {
        const existing = destMap.get(p.destination);
        if (existing) {
          existing.count++;
          continue;
        }
        ctx.log("transport", `resolveDestination for aboard passenger: ${p.destination} (name: ${p.destination_name}, system: ${p.destination_system || 'none'})`);
        const resolved = await resolveDestination(ctx, bot, p.destination, p.destination_name, p.destination_system);
        if (resolved) {
          destMap.set(p.destination, { ...resolved, count: 1 });
          ctx.log("transport", `Resolved aboard ${p.destination} -> system=${resolved.system}, poi=${resolved.poi}`);
        } else {
          destMap.set(p.destination, { system: "", poi: p.destination, poiName: p.destination_name || p.destination, count: 1 });
          ctx.log("transport", `FAILED to resolve aboard passenger ${p.destination}`);
        }
      }

      const routeDests = Array.from(destMap.values()).filter(d => d.system);
      ctx.log("transport", `Route destinations: ${routeDests.length} valid out of ${destMap.size}`);
      const planned = await planTourRoute(bot.system || "", routeDests, 6, bot);
      ctx.log("transport", `planTourRoute result: ${planned.length} waypoints, currentSystem=${bot.system || 'none'}`);

      const aboardIds = new Set(aboard.map(p => p.citizen_id || p.name));
      state.onboardPassengers = state.onboardPassengers.filter(op => aboardIds.has(op.citizenId));

      if (planned.length === 0) {
        ctx.log("transport", `planned.length === 0 but ${state.onboardPassengers.length} passengers remain`);
        const stranded = state.onboardPassengers.filter(p => !routeDests.some(d => d.poi === p.destination));
        ctx.log("transport", `${stranded.length} passengers stranded`);
        if (stranded.length > 0) {
          state.onboardPassengers = state.onboardPassengers.filter(p => routeDests.some(d => d.poi === p.destination));
        }
        if (state.onboardPassengers.length === 0) {
          state.route = [];
          state.currentRouteIndex = 0;
          state.currentDestination = null;
          state.status = "idle";
          saveTransportState(state);
          await ctx.sleep(10000);
          continue;
        }
        state.roundsWithoutPassengers = (state.roundsWithoutPassengers || 0) + 1;
        ctx.log("transport", `No route planned for passengers, round ${state.roundsWithoutPassengers}/${settings.roundsBeforeMoving}`);
        if (state.roundsWithoutPassengers >= settings.roundsBeforeMoving) {
          ctx.log("transport", `Threshold reached (${settings.roundsBeforeMoving} rounds without passengers). Moving to next station.`);
          const nextPickup = await selectNextPickupStation(ctx, state, settings);
          if (nextPickup) {
            const isSameStation = nextPickup.poi.toLowerCase() === bot.poi.toLowerCase() && nextPickup.system.toLowerCase() === bot.system.toLowerCase();
            if (isSameStation) {
              ctx.log("transport", `Next pickup is same station, resetting counter and checking for different passengers`);
              state.roundsWithoutPassengers = 0;
              state.pickupStation = nextPickup.poi;
              state.pickupSystem = nextPickup.system;
              state.onboardPassengers = [];
              state.route = [];
              state.status = "idle";
              saveTransportState(state);
              await ctx.sleep(5000);
              continue;
            }
            state.pickupStation = nextPickup.poi;
            state.pickupSystem = nextPickup.system;
            state.roundsWithoutPassengers = 0;
            state.onboardPassengers = [];
            state.route = [];
            state.status = "idle";
            saveTransportState(state);
            await ctx.sleep(5000);
            continue;
          }
        }
        state.status = "idle";
        saveTransportState(state);
        await ctx.sleep(10000);
        continue;
      }

      for (const p of aboard) {
        civilianStore.addOrUpdate({
          citizenId: p.citizen_id || p.name,
          name: p.name,
          accommodationClass: p.class.toLowerCase() as "economy" | "business" | "first",
          citizenship: p.citizenship,
          destination: p.destination,
          destinationName: p.destination_name,
          destinationSystem: (p as any).destinationSystem || p.destination_system,
          fare: p.fare,
          bio: p.bio,
          loadedAt: new Date().toISOString(),
          status: "boarded",
          ticksRemaining: p.ticks_remaining,
        });
      }

      // Build onboard passenger records
      const onboard: TransportPassenger[] = aboard.map(p => ({
        citizenId: p.citizen_id || p.name,
        name: p.name,
        accommodationClass: p.class.toLowerCase() as "economy" | "business" | "first",
        citizenship: p.citizenship,
        destination: p.destination,
        destinationName: p.destination_name,
        destinationSystem: (p as any).destinationSystem || p.destination_system,
        fare: p.fare,
        bio: p.bio,
        routeData: p.route_data || null,
        loadedAt: new Date().toISOString(),
        status: "boarded",
        ticksRemaining: p.ticks_remaining,
      }));

      state.onboardPassengers = onboard;
      state.route = planned;
      state.currentRouteIndex = 0;
      state.currentDestination = planned.length > 0 ? planned[0].poiName : null;
      state.status = onboard.length > 0 ? "in_transit" : "idle";
      state.routeRebuildAttempts = 0;
      state.roundsWithoutPassengers = 0;
      const listParsed = listResp.result ? parseListPassengers(listResp.result) : null;
      state.berths = listParsed && (listParsed.berths.economy + listParsed.berths.business + listParsed.berths.first) > 0
        ? listParsed.berths
        : state.berths;
      saveTransportState(state);

      if (onboard.length === 0) {
        await ctx.sleep(10000);
        continue;
      }

      if (bot.state !== "running") {
        state.onboardPassengers = [];
        state.route = [];
        state.status = "idle";
        saveTransportState(state);
        await ctx.sleep(10000);
        continue;
      }

      ctx.log("transport", `${onboard.length} passengers. Route: ${planned.map(d => d.poiName).join(" → ")}`);
      if (planned.length === 0 && onboard.length > 0) {
        ctx.log("transport", `WARNING: ${onboard.length} passengers but empty route!`);
        for (const p of onboard) {
          ctx.log("transport", `  - Passenger ${p.name} -> ${p.destination} (system: ${p.destinationSystem || 'none'})`);
        }
      }

      if (!settings.disableFactionMessage) {
        const announceService = (globalThis as any).aiChatService;
        const pickupIsHome = state.pickupStation === settings.homeStation || state.pickupSystem === settings.homeSystem;
        if (
          announceService &&
          typeof announceService.sendTransportAnnouncement === "function"
        ) {
          const routeNames = settings.announceDestination
            ? planned.map(d => d.poiName).filter(name => name && name.trim().length > 0)
            : [];
          const passengerInfos = onboard.map(p => ({
            name: p.name,
            bio: p.bio || "",
            destinationName: p.destinationName,
          }));
          const shipDisplayName = state.customName || state.shipName;
          announceService.sendTransportAnnouncement(bot, {
            shipName: shipDisplayName,
            route: routeNames,
            totalPassengers: onboard.length,
            currentSystem: bot.system || "",
            cycleType: "pickup",
            onboardPassengers: passengerInfos,
          }).then((result: { ok: boolean; message?: string; error?: string }) => {
            if (!result.ok) {
              ctx.log("error", `Transport announcement failed: ${result.error}`);
            }
          }).catch((err: Error) => {
            ctx.log("error", `Transport announcement error: ${err.message}`);
          });
        }
      }

      // Undock and continue to transit handling below
      await ensureUndocked(ctx);
      state.status = "in_transit";
      saveTransportState(state);
    }

    if (state.status === "in_transit" || state.status === "traveling_to_ship") {
      if (state.route.length === 0 || state.currentRouteIndex >= state.route.length) {
        if (state.onboardPassengers.length > 0) {
          ctx.log("transport", `Route empty but ${state.onboardPassengers.length} passengers onboard, rebuilding route`);
          const retryCount = (state.routeRebuildAttempts || 0) + 1;
          if (retryCount > 3) {
            ctx.log("transport", `Route rebuild failed ${retryCount} times, stranding passengers`);
            state.onboardPassengers = state.onboardPassengers.map(p => ({ ...p, status: "stranded" }));
            state.status = "idle";
            state.routeRebuildAttempts = 0;
            saveTransportState(state);
            await ctx.sleep(60000);
            continue;
          }
          state.routeRebuildAttempts = retryCount;
          const destMap = new Map<string, { system: string; poi: string; poiName: string; count: number }>();
          for (const p of state.onboardPassengers) {
            ctx.log("transport", `resolveDestination for onboard passenger: ${p.destination} (system: ${p.destinationSystem || 'none'})`);
            const resolved = await resolveDestination(ctx, bot, p.destination, p.destinationName, p.destinationSystem);
            if (resolved) {
              destMap.set(p.destination, { ...resolved, count: 1 });
              ctx.log("transport", `Resolved ${p.destination} -> system=${resolved.system}, poi=${resolved.poi}`);
            } else {
              destMap.set(p.destination, { system: "", poi: p.destination, poiName: p.destinationName, count: 1 });
              ctx.log("transport", `FAILED to resolve ${p.destination}`);
            }
          }
          const validDests = Array.from(destMap.values()).filter(d => d.system);
          ctx.log("transport", `Route rebuild: ${validDests.length} valid destinations out of ${destMap.size}`);
          if (validDests.length > 0) {
            const newRoute = await planTourRoute(bot.system || "", validDests, 6, bot);
            ctx.log("transport", `Route rebuild result: ${newRoute.length} waypoints, route: ${newRoute.map(d => d.poiName).join(' -> ')}`);
            if (newRoute.length > 0) {
              state.route = newRoute;
              state.currentRouteIndex = 0;
              state.currentDestination = newRoute[0].poiName;
              state.status = "in_transit";
              state.routeRebuildAttempts = 0;
              saveTransportState(state);
              continue;
            }
          }
          ctx.log("transport", `Route rebuild failed: validDests=${validDests.length}, would strand passengers`);
          saveTransportState(state);
          await ctx.sleep(30000);
          continue;
        }
        state.status = "idle";
        state.routeRebuildAttempts = 0;
        saveTransportState(state);
        continue;
      }

      const waypoint = state.route[state.currentRouteIndex];
      ctx.log("transport", `Processing waypoint ${state.currentRouteIndex + 1}/${state.route.length}: system=${waypoint.system}, poi=${waypoint.poi}`);

      if (waypoint.system !== bot.system) {
        ctx.log("transport", `Navigating to system ${waypoint.system}`);
        const ok = await navigateToSystem(ctx, waypoint.system, { fuelThresholdPct: settings.refuelThreshold, hullThresholdPct: settings.repairThreshold, skipBlacklist: true });
        await bot.refreshStatus();
        if (!ok) {
          ctx.log("transport", `FAILED to navigate to system ${waypoint.system}`);
          await ctx.sleep(30000);
          continue;
        }
        ctx.log("transport", `Arrived at system ${waypoint.system}`);
      }
      if (bot.poi !== waypoint.poi) {
        ctx.log("transport", `Traveling to poi ${waypoint.poi}`);
        const tr = await bot.exec("travel", { target_poi: waypoint.poi });
        if (tr.error) {
          const errMsg = tr.error.message || "";
          if (isMobileStation(waypoint.poi) && state.routeRebuildAttempts < 3) {
            ctx.log("transport", `Travel to mobile station ${waypoint.poi} failed: ${errMsg}. Re-resolving destination.`);
            const resolved = await resolveDestination(ctx, bot, waypoint.poi, waypoint.poiName);
            if (resolved && resolved.system && resolved.poi) {
              const newRoute = await planTourRoute(bot.system || "", [resolved], 6, bot);
              if (newRoute.length > 0) {
                state.route = newRoute;
                state.currentRouteIndex = 0;
                state.currentDestination = newRoute[0].poiName;
                state.routeRebuildAttempts = (state.routeRebuildAttempts || 0) + 1;
                ctx.log("transport", `Updated route to ${resolved.poi} in ${resolved.system}`);
                continue;
              }
            }
          }
          ctx.log("transport", `Travel to ${waypoint.poi} failed: ${errMsg}`);
          await ctx.sleep(30000);
          continue;
        }
        await bot.refreshStatus();
      }

      const alreadyDocked = bot.docked && bot.poi === waypoint.poi;
      
      const creditsBefore = bot.credits || 0;
      
      if (!alreadyDocked) {
        const dockResp = await bot.exec("dock");
        if (dockResp.error && !dockResp.error.message.includes("already")) {
          ctx.log("error", `Dock failed: ${dockResp.error.message}`);
          await ctx.sleep(30000);
          continue;
        }
      }

      if (isMobileStation(waypoint.poi)) {
        state.routeRebuildAttempts = 0;
      }

      await collectFuelCells(ctx, settings);

      await bot.refreshStatus();
      const creditsAfter = bot.credits || 0;
      const fareEarned = creditsAfter - creditsBefore;

      // Unload passengers for this station
      state.status = "unloading";
      saveTransportState(state);

      const boundHere = state.onboardPassengers.filter(
        p => p.status === "boarded" && (p.destination.toLowerCase() === waypoint.poi.toLowerCase() || p.destinationName.toLowerCase() === waypoint.poiName.toLowerCase()),
      );

      // Calculate fare per passenger (distribute evenly if multiple passengers)
      const farePerPassenger = boundHere.length > 0 ? Math.round(fareEarned / boundHere.length) : 0;

      for (const p of boundHere) {
        const citizenId = p.citizenId || p.name;
        state.revenue += farePerPassenger;
        state.totalFaresEarned += farePerPassenger;
        state.onboardPassengers = state.onboardPassengers.map(op =>
          op.citizenId === citizenId ? { ...op, status: "delivered" as const } : op,
        );
        civilianStore.addOrUpdate({
          citizenId,
          name: p.name,
          accommodationClass: p.accommodationClass,
          citizenship: p.citizenship,
          destination: p.destination,
          destinationName: p.destinationName,
          destinationSystem: p.destinationSystem,
          fare: farePerPassenger,
          bio: p.bio,
          loadedAt: p.loadedAt,
          status: "delivered",
        });
        logCTFare(bot.username, p.name, farePerPassenger);
      }

      state.currentRouteIndex += 1;
      if (state.currentRouteIndex >= state.route.length) {
        state.status = "completed";
        state.currentDestination = null;
        ctx.log("transport", `Run complete. Revenue: ${state.totalFaresEarned}cr, Delivered: ${boundHere.length}`);
      } else {
        const next = state.route[state.currentRouteIndex];
        state.currentDestination = next.poiName;
        state.status = "in_transit";
        if (state.currentRouteIndex > 0) {
          // Quick refuel/repair at intermediate stops if needed
          await tryRefuel(ctx);
          await repairShip(ctx);
        }
      }
      saveTransportState(state);

      if (state.status === "completed") {
        const completedPassengers = [...state.onboardPassengers];
        clearTransportState(bot.username);
        
        if (settings.homeStation) {
          await ensureDocked(ctx);
          await collectFuelCells(ctx, settings);
        }
        
        state.status = "idle";
        state.onboardPassengers = [];
        state.route = [];
        state.revenue = 0;
        state.currentRouteIndex = 0;
        state.currentDestination = null;
        saveTransportState(state);
        
        if (!settings.disableFactionMessage) {
          const announceService = (globalThis as any).aiChatService;
          if (
            announceService &&
            typeof announceService.sendTransportAnnouncement === "function"
          ) {
            const routeNames = settings.announceDestination
              ? completedPassengers.map(p => p.destinationName).filter(name => name && name.trim().length > 0)
              : [];
            const passengerInfos = completedPassengers.map(p => ({
              name: p.name,
              bio: p.bio || "",
              destinationName: p.destinationName,
            }));
            const shipDisplayName = state.customName || state.shipName;
            announceService.sendTransportAnnouncement(bot, {
              shipName: shipDisplayName,
              route: routeNames,
              totalPassengers: completedPassengers.length,
              currentSystem: bot.system || "",
              cycleType: "cycle_complete",
              onboardPassengers: passengerInfos,
            }).then((result: { ok: boolean; message?: string; error?: string }) => {
              if (!result.ok) {
                ctx.log("error", `Transport cycle_complete announcement failed: ${result.error}`);
              }
            }).catch((err: Error) => {
              ctx.log("error", `Transport cycle_complete announcement error: ${err.message}`);
            });
          }
        }
        
        if (bot.shouldStopAfterCycle()) {
          bot.clearStopAfterCycle();
          bot.initiateStop();
          await ctx.sleep(5000);
          return;
        }
        
        await ctx.sleep(15000);
        continue;
      }

      await ensureUndocked(ctx);
      state.status = "in_transit";
      saveTransportState(state);
    }

    // Safety / upkeep
    await tryRefuel(ctx);
    await repairShip(ctx);
    ctx.log("transport", `Loop iteration complete, sleeping 5s`);
    await ctx.sleep(5000);
  }
};
