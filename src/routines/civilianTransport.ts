import type { Bot, Routine, RoutineContext } from "../bot.js";
import { mapStore } from "../mapstore.js";
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
import { getSystemBlacklist } from "../web/server.js";
import { civilianStore, CivilianPassenger } from "../civilianstore.js";
import { catalogStore } from "../catalogstore.js";

const fs = require("fs");
const path = require("path");

interface RouteResult {
  system: string;
  poi: string;
  poiName: string;
}

async function resolveDestination(bot: Bot, destinationId: string, destinationName: string): Promise<RouteResult | null> {
  const allSystems = mapStore.getAllSystems();
  for (const [, sysData] of Object.entries(allSystems)) {
    const found = sysData.pois.find(
      pp => pp.id === destinationId || pp.name.toLowerCase() === destinationName.toLowerCase(),
    );
    if (found) {
      return { system: sysData.id, poi: found.id, poiName: found.name };
    }
  }

  const routeResp = await bot.exec("find_route", { target: destinationId });
  if (routeResp.error || !routeResp.result) {
    return null;
  }
  const result = routeResp.result as Record<string, unknown>;
  if (!result.found) {
    return null;
  }
  return {
    system: (result.target_system as string) || "",
    poi: (result.target_poi as string) || destinationId,
    poiName: (result.target_poi_name as string) || destinationName,
  };
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
      const ships = (data.ships as Record<string, CatalogShip>) || {};
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
  tier: number | null;
  berths: { economy: number; business: number; first: number };
  berths_used: { economy: number; business: number; first: number };
  onboardPassengers: TransportPassenger[];
  pickupStation: string | null;
  pickupSystem: string | null;
  route: Array<{ system: string; poi: string; poiName: string }>;
  currentRouteIndex: number;
  revenue: number;
  totalFaresEarned: number;
  currentDestination: string | null;
  lastUpdated: string;
}

interface FleetShip {
  shipId: string;
  shipName: string;
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
}

// ── Settings ─────────────────────────────────────────────────

function getCivilianTransportSettings(username?: string): CivilianTransportSettings {
  const all = readSettings();
  const t = (all as any).civilian_transport || {};
  const botOverrides = username ? ((all as any)[username] || {}) : {};
  return {
    maxJumps: Number((t.maxJumps as number) ?? 5),
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
  };
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
    const dir = path.join(process.cwd(), "data");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(process.cwd(), DATA_FILE), JSON.stringify(data, null, 2) + "\n", "utf-8");
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
  const validStatuses = new Set(["idle", "loading", "unloading", "in_transit", "traveling_to_ship", "docked_at_pickup"]);
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

async function collectFuelCells(ctx: RoutineContext, settings: CivilianTransportSettings, atHomeBase: boolean): Promise<void> {
  const { bot } = ctx;
  await bot.refreshStatus();

  const cargoFree = (bot.cargoMax || 0) - (bot.cargo || 0);
  if (cargoFree <= 0) {
    ctx.log("transport", "No cargo space for fuel cells");
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

  ctx.log("transport", `Fuel cell capacity: military=${milCap}, premium=${premCap}, regular=${regCap}`);

  const tryAcquire = async (fuelId: string, qty: number) => {
    if (qty <= 0) return true;
    const resp = await bot.exec("storage", {
      action: "withdraw",
      target: "faction",
      item_id: fuelId,
      quantity: qty,
    });
    if (!resp.error) {
      ctx.log("transport", `Withdrew ${qty} ${fuelId} from faction storage`);
      return true;
    }
    if (atHomeBase) {
      ctx.log("transport", `At home base - skipping purchase of ${fuelId}`);
      return false;
    }
    const buyResp = await bot.exec("buy", { item_id: fuelId, quantity: qty });
    if (!buyResp.error) {
      ctx.log("transport", `Bought ${qty} ${fuelId}`);
      return true;
    }
    ctx.log("transport", `Could not acquire ${fuelId}: ${buyResp.error.message}`);
    return false;
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
  const passengers = Array.isArray(inner.passengers) ? inner.passengers as AboardPassenger[] : [];
  const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
  const berthsRaw = inner.berths && typeof inner.berths === "object" ? (inner.berths as Record<string, unknown>) : null;
  const berthsUsedRaw = inner.berths_used && typeof inner.berths_used === "object" ? (inner.berths_used as Record<string, unknown>) : null;
  const hasBerths = berthsRaw && (num(berthsRaw.economy) || num(berthsRaw.business) || num(berthsRaw.first));
  return {
    passengers,
    berths: hasBerths
      ? {
          economy: num(berthsRaw!.economy) ?? 0,
          business: num(berthsRaw!.business) ?? 0,
          first: num(berthsRaw!.first) ?? 0,
        }
      : {
          economy: num(inner.economy_berths) ?? 0,
          business: num(inner.business_berths) ?? 0,
          first: num(inner.first_berths) ?? 0,
        },
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
    if (typeId.includes("passenger")) {
      if (typeId.includes("first")) first += 1;
      else if (typeId.includes("business")) business += 1;
      else if (typeId.includes("economy")) economy += 1;
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
      const classId = ((s.class_id || (s.class as Record<string, unknown>)?.id || s.type || "") as string);
      const classData = catalog[classId];
      const caps = classData?.inherent_capabilities;
      const fromCaps = extractBerthsFromCapabilities(caps);
      if (fromCaps) {
        berths = fromCaps;
      } else if (s.modules) {
        berths = countPassengerModules(s.modules);
      }
    }
    
    return {
      shipId: (s.ship_id || s.id || "") as string,
      shipName: (s.name || s.ship_name || s.class_name || "") as string,
      type: (s.type || s.ship_type || s.class_id || "") as string,
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

// ── Fleet / ship selection ───────────────────────────────────

function totalBerths(b: { economy: number; business: number; first: number }): number {
  return b.economy + b.business + b.first;
}

function pickBestShip(ctx: RoutineContext, fleet: FleetShip[]): FleetShip | null {
  const { bot } = ctx;
  const currentId = bot.shipName || "";

  // Filter ships that have any passenger berths
  const withBerths = fleet.filter(s => totalBerths(s.berths) > 0);
  if (withBerths.length === 0) return null;

  // Sort by total berths descending; prefer higher tier as tiebreaker
  withBerths.sort((a, b) => {
    const tbA = totalBerths(a.berths);
    const tbB = totalBerths(b.berths);
    if (tbB !== tbA) return tbB - tbA;
    const tA = a.tier || 0;
    const tB = b.tier || 0;
    return tB - tA;
  });

  return withBerths[0];
}

// ── Passenger / station selection ────────────────────────────

async function refreshFleetCache(ctx: RoutineContext): Promise<FleetShip[]> {
  const { bot } = ctx;
  const resp = await bot.exec("list_ships");
  if (resp.error || !resp.result) {
    ctx.log("transport", "list_ships failed — using cached fleet data");
    return loadFleetData(bot.username);
  }
  let ships = parseListShips(resp.result);
  
  const shipsNeedingDetails = ships.filter(s => totalBerths(s.berths) === 0);
  if (shipsNeedingDetails.length > 0) {
    ctx.log("transport", `Fetching details for ${shipsNeedingDetails.length} ship(s) without berth info...`);
    const catalog = loadCatalog();
    for (const ship of shipsNeedingDetails) {
      const classData = catalog[ship.type];
      if (classData) {
        const caps = classData.inherent_capabilities;
        const fromCaps = extractBerthsFromCapabilities(caps);
        if (fromCaps) {
          ship.berths = fromCaps;
        }
        if (totalBerths(ship.berths) === 0 && classData.special === "passenger_liner") {
          ship.berths = { economy: 1, business: 0, first: 0 };
        }
      }
      
      if (totalBerths(ship.berths) === 0) {
        const detailResp = await bot.exec("get_ship", { ship_id: ship.shipId });
        if (detailResp.error) {
          ctx.log("transport", `get_ship failed for ${ship.shipId}: ${detailResp.error.message}`);
          continue;
        }
        if (!detailResp.result) {
          ctx.log("transport", `get_ship returned no result for ${ship.shipId}`);
          continue;
        }
        const detail = detailResp.result as Record<string, unknown> & { ship?: Record<string, unknown>; class?: { special?: string; inherent_capabilities?: unknown } };
        const shipData = detail.ship || detail;
        ship.shipId = (shipData.id || ship.shipId) as string;
        ship.shipName = (detail.name || shipData.name || ship.shipName) as string;
        ship.type = (shipData.ship_type || shipData.type || ship.type) as string;
        ship.tier = (shipData.tier as number) ?? ship.tier;
        ship.cargoCapacity = (shipData.cargo_capacity || shipData.max_cargo || ship.cargoCapacity) as number;
        ship.cargoUsed = (shipData.cargo_used || ship.cargoUsed) as number;
        ship.hasShipyard = (shipData.has_shipyard as boolean) ?? ship.hasShipyard;
        
        const caps = ((detail.class as Record<string, unknown>)?.inherent_capabilities as unknown) || ((shipData.class as Record<string, unknown>)?.inherent_capabilities as unknown);
        const fromCaps = extractBerthsFromCapabilities(caps);
        if (fromCaps) {
          ship.berths = fromCaps;
        } else if (detail.modules || shipData.modules) {
          const fromMods = countPassengerModules(detail.modules || shipData.modules);
          if (totalBerths(fromMods) > 0) {
            ship.berths = fromMods;
          }
        }
        if (totalBerths(ship.berths) === 0 && detail.class?.special === "passenger_liner") {
          ship.berths = { economy: 1, business: 0, first: 0 };
        }
      }
    }
  }
  
  saveFleetData(bot.username, ships);
  ctx.log("transport", `Fleet updated: ${ships.length} ship(s) cached`);
  return ships;
}

async function selectPickupStation(
  ctx: RoutineContext,
  berths: { economy: number; business: number; first: number },
  maxJumps: number,
  blockPirateStations: boolean,
): Promise<{ system: string; poi: string; poiName: string; count: number } | null> {
  const { bot } = ctx;
  const stations: Array<{ system: string; poi: string; poiName: string; count: number; hops: number }> = [];

  // Check current station first if docked
  if (bot.docked && bot.poi && bot.system) {
    if (!blockPirateStations || !isPirateSystem(bot.system)) {
      const resp = await bot.exec("list_station_passengers");
      if (!resp.error && resp.result) {
        const data = parseStationPassengers(resp.result);
        if (data && data.count > 0) {
          stations.push({
            system: bot.system,
            poi: bot.poi,
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
  const currentSystem = bot.system || "";

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
         if (blockPirateStations && isPirateSystem(info.systemId)) continue;
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

// ── Route planning ───────────────────────────────────────────

function hopsBetween(a: string, b: string): number {
  if (a.toLowerCase() === b.toLowerCase()) return 0;
  const route = mapStore.findRoute(a, b, getSystemBlacklist());
  if (!route) return 9999;
  return route.length - 1;
}

function planTourRoute(
  currentSystem: string,
  destinations: Array<{ system: string; poi: string; poiName: string }>,
  maxJumps: number,
): Array<{ system: string; poi: string; poiName: string }> {
  const validDests = destinations.filter(d => d.system);
  if (validDests.length === 0) return [];
  if (validDests.length === 1) return validDests;

  const remaining = [...destinations];
  const planned: typeof destinations = [];
  let cur = currentSystem;
  let totalJumps = 0;

  while (remaining.length > 0) {
    let bestIndex = -1;
    let bestHops = maxJumps + 1;
    for (let i = 0; i < remaining.length; i++) {
      const hops = hopsBetween(cur, remaining[i].system);
      if (hops <= maxJumps && hops < bestHops) {
        bestHops = hops;
        bestIndex = i;
      }
    }

    if (bestIndex === -1) {
      break;
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

function makeNewState(bot: Bot, shipId: string, shipName: string, tier: number | null, berths: { economy: number; business: number; first: number }): TransportState {
  return {
    botUsername: bot.username,
    status: "idle",
    shipId,
    shipName,
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
  };
}

// ── Main routine ─────────────────────────────────────────────

export const civilianTransportRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;
  const settings = getCivilianTransportSettings(bot.username);
  let state = loadTransportState(bot.username);
  let fleet: FleetShip[] = loadFleetData(bot.username);

  // Initial fleet refresh
  try {
    fleet = await refreshFleetCache(ctx);
  } catch {
    ctx.log("transport", "Initial fleet refresh failed — using cached data");
  }

  // Initialize state if none or invalid
  if (!state || !isValidTransportState(state)) {
    clearTransportState(bot.username);
    const best = pickBestShip(ctx, fleet);
    if (!best) {
      ctx.log("error", "No passenger-capable ship found in fleet. Routine cannot run.");
      return;
    }
    state = makeNewState(bot, best.shipId, best.shipName, best.tier, best.berths);
    saveTransportState(state);
  } else {
    const currentShip = fleet.find(s => s.shipId === state!.shipId);
    if (currentShip && totalBerths(currentShip.berths) > 0) {
      state!.shipId = currentShip.shipId;
      state!.shipName = currentShip.shipName;
      state!.tier = currentShip.tier;
      state!.berths = currentShip.berths;
      state!.berths_used = { economy: 0, business: 0, first: 0 };
      saveTransportState(state!);
      ctx.log("transport", `Synced berths from fleet cache: ${state!.shipName} = ${state!.berths.economy}e/${state!.berths.business}b/${state!.berths.first}f`);
    }
  }

  ctx.log("transport", `Civilian transport started. Active ship: ${state.shipName} (${state.shipId}). Status: ${state.status}`);

  if (state && state.status !== "idle") {
    ctx.log("transport", `Verifying loaded passengers for non-idle state (${state.status})...`);
    const verifyResp = await bot.exec("list_passengers");
    if (verifyResp.error || !verifyResp.result) {
      ctx.log("transport", `list_passengers failed during verification: ${verifyResp.error?.message || "no result"} — resetting to idle.`);
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
        ctx.log("transport", "Stale state detected: no passengers aboard despite non-idle status. Resetting to idle.");
        state.status = "idle";
        state.onboardPassengers = [];
        state.route = [];
        state.currentRouteIndex = 0;
        state.currentDestination = null;
        state.berths_used = { economy: 0, business: 0, first: 0 };
        saveTransportState(state);
      } else {
        ctx.log("transport", `Verified ${verifiedCount} passengers aboard — rebuilding route from actual destinations.`);
        const destMap = new Map<string, { system: string; poi: string; poiName: string; count: number }>();
        const mcLocation = mapStore.getMobileCapitolLocation();
        for (const p of vParsed!.passengers) {
          const existing = destMap.get(p.destination);
          if (existing) {
            existing.count++;
            continue;
          }
          const resolved = await resolveDestination(bot, p.destination, p.destination_name);
          let sys = resolved?.system || "";
          let poi = resolved?.poi || p.destination;
          if (!sys && mcLocation && (p.destination.toLowerCase() === "frontier_station" || p.destination_name.toLowerCase() === "frontier station")) {
            sys = mcLocation.systemId;
            poi = mcLocation.poiId;
          }
          destMap.set(p.destination, { system: sys, poi, poiName: p.destination_name, count: 1 });
        }
        const routeDests = Array.from(destMap.values()).filter(d => d.system);
        const planned = planTourRoute(bot.system || "", routeDests, 6);
        state.onboardPassengers = vParsed!.passengers.map(p => ({
          citizenId: p.citizen_id || p.name,
          name: p.name,
          accommodationClass: (p.class || "economy").toLowerCase() as "economy" | "business" | "first",
          citizenship: p.citizenship,
          destination: p.destination,
          destinationName: p.destination_name,
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
        if (planned.length === 0 && vParsed!.passengers.length > 0) {
          ctx.log("transport", `Warning: ${vParsed!.passengers.length} passengers aboard but no valid route — staying in_transit to attempt recovery.`);
        } else {
          state.status = "in_transit";
        }
        const recoveredBerths = vParsed!.berths;
        const recoveredBerthsUsed = vParsed!.berths_used;
        const hasRecoveredBerths = (recoveredBerths.economy + recoveredBerths.business + recoveredBerths.first) > 0;
        if (hasRecoveredBerths) {
          state.berths = recoveredBerths;
          state.berths_used = recoveredBerthsUsed;
        }
        saveTransportState(state);
        ctx.log("transport", `Rebuilt route from ${verifiedCount} passengers: ${planned.map(d => d.poiName).join(" → ")}`);
      }
    }
  }

  if (!state || state.status === "idle") {
    ctx.log("transport", "State is missing or idle — checking for already-loaded passengers to recover route.");
    const listResp = await bot.exec("list_passengers");
    if (listResp.error || !listResp.result) {
      ctx.log("transport", `list_passengers failed during recovery: ${listResp.error?.message || "no result"}`);
    } else {
      const parsed = parseListPassengers(listResp.result);
      if (parsed && parsed.passengers.length > 0) {
        const destMap = new Map<string, { system: string; poi: string; poiName: string; count: number }>();
        const mcLocation = mapStore.getMobileCapitolLocation();
        for (const p of parsed.passengers) {
          const existing = destMap.get(p.destination);
          if (existing) {
            existing.count++;
            continue;
          }
          const resolved = await resolveDestination(bot, p.destination, p.destination_name);
          let sys = resolved?.system || "";
          let poi = resolved?.poi || p.destination;
          if (!sys && mcLocation && (p.destination.toLowerCase() === "frontier_station" || p.destination_name.toLowerCase() === "frontier station")) {
            sys = mcLocation.systemId;
            poi = mcLocation.poiId;
          }
          destMap.set(p.destination, { system: sys, poi, poiName: p.destination_name, count: 1 });
        }
        const routeDests = Array.from(destMap.values()).filter(d => d.system);
        const planned = planTourRoute(bot.system || "", routeDests, 6);
        state.onboardPassengers = parsed.passengers.map(p => ({
          citizenId: p.citizen_id || p.name,
          name: p.name,
          accommodationClass: (p.class || "economy").toLowerCase() as "economy" | "business" | "first",
          citizenship: p.citizenship,
          destination: p.destination,
          destinationName: p.destination_name,
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
        if (planned.length === 0 && parsed.passengers.length > 0) {
          ctx.log("transport", `Warning: ${parsed.passengers.length} passengers aboard but no valid route — staying in_transit to attempt recovery.`);
        } else {
          state.status = "in_transit";
        }
        const stateParsed = parsed;
        const recoveredBerths = stateParsed.berths;
        const recoveredBerthsUsed = stateParsed.berths_used;
        const hasRecoveredBerths = (recoveredBerths.economy + recoveredBerths.business + recoveredBerths.first) > 0;
        if (hasRecoveredBerths) {
          state.berths = recoveredBerths;
          state.berths_used = recoveredBerthsUsed;
        }
        saveTransportState(state);
        ctx.log("transport", `Recovered ${parsed.passengers.length} passengers. Route: ${planned.map(d => d.poiName).join(" → ")}`);
      } else {
        ctx.log("transport", "No passengers aboard — staying idle.");
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

    // ── Refresh shuttle fleet periodically ──
    if (Math.random() < 0.1) {
      try {
        fleet = await refreshFleetCache(ctx);
        const latest = pickBestShip(ctx, fleet);
        if (latest && latest.shipId !== state.shipId) {
          ctx.log("transport", `Better ship available: ${latest.shipName} (${totalBerths(latest.berths)} berths) vs ${state.shipName} (${totalBerths(state.berths)} berths)`);
        }
      } catch {
        // silent refresh failure
      }
    }

    // --- State machine ---
    if (state.status === "idle") {
      // Need to find passengers and load up
      // If already docked at a station, check for passengers to loaf
      if (bot.docked && bot.poi && bot.system) {
        const resp = await bot.exec("list_station_passengers");
        if (!resp.error && resp.result) {
          const data = parseStationPassengers(resp.result);
          if (data && data.count > 0) {
            // Passengers available at current station - proceed with loading
            ctx.log("transport", "Found " + data.count + " passengers at current station " + bot.poi);
            // Set pickup to current station so we can proceed
            state.pickupStation = bot.poi;
            state.pickupSystem = bot.system;
          } else {
            // No passengers at current station - loaf here and wait
            ctx.log("transport", "No passengers at current station " + bot.poi + " -- loafing and waiting");
            await ctx.sleep(60000);
            continue;
          }
        } else {
          ctx.log("transport", "Could not list station passengers -- sleeping 60s");
          await ctx.sleep(60000);
          continue;
        }
      } else {
        const pickup = await selectPickupStation(ctx, state.berths, settings.maxJumps, settings.blockPirateStations);
        if (!pickup) {
          ctx.log("transport", "No stations with waiting passengers found nearby. Sleeping 60s.");
          await ctx.sleep(60000);
          continue;
        }
        state.pickupStation = pickup.poi;
        state.pickupSystem = pickup.system;
      }

      // Check if already at pickup station before any travel
      const poiMatch = String(bot.poi || "").toLowerCase() === String(state.pickupStation || "").toLowerCase();
      const sysMatch = String(bot.system || "").toLowerCase() === String(state.pickupSystem || "").toLowerCase();
      const alreadyAtPickup = bot.docked && poiMatch && sysMatch;
      ctx.log("transport", "Check pickup: docked=" + bot.docked + ", poi=" + bot.poi + ", pickupStation=" + state.pickupStation + ", system=" + bot.system + ", pickupSystem=" + state.pickupSystem + ", alreadyAtPickup=" + alreadyAtPickup);
      
      if (!alreadyAtPickup) {
        ctx.log("transport", "NOT already at pickup -- will travel");
        // Check if we need to switch to the best passenger ship first
        const bestNow = pickBestShip(ctx, fleet);
        const targetShipId = bestNow ? bestNow.shipId : state.shipId;

        if (targetShipId !== state.shipId) {
          const targetShip = fleet.find(s => s.shipId === targetShipId);
          if (!targetShip) {
            ctx.log("transport", "Target ship not found in fleet -- staying on current ship.");
          } else {
            if (targetShip.storedAtSystemId !== bot.system || targetShip.storedAtStationId !== bot.poi) {
              // Travel to where the ship is stored
              const shipSystem = targetShip.storedAtSystemId || targetShip.storedAtStationId;
              if (shipSystem && shipSystem !== bot.system) {
                ctx.log("transport", "Traveling to " + shipSystem + " to switch to " + targetShip.shipName + "...");
                state.status = "traveling_to_ship";
                saveTransportState(state);
                const ok = await navigateToSystem(ctx, shipSystem, { fuelThresholdPct: settings.refuelThreshold, hullThresholdPct: settings.repairThreshold });
                if (!ok) {
                  ctx.log("error", "Failed to reach ship location. Will retry.");
                  state.status = "idle";
                  saveTransportState(state);
                  await ctx.sleep(30000);
                  continue;
                }
              }
              // Dock at the ship's station
              const docked = await ensureDocked(ctx);
              if (!docked) {
                ctx.log("error", "Failed to dock at ship's station. Will retry.");
                state.status = "idle";
                saveTransportState(state);
                await ctx.sleep(30000);
                continue;
              }
            }

            // Attempt switch_ship
            ctx.log("transport", "Switching from " + state.shipName + " to " + targetShip.shipName + "...");
            const switchResp = await bot.exec("switch_ship", { ship_id: targetShipId });
            if (switchResp.error) {
              ctx.log("error", "switch_ship failed: " + switchResp.error.message + " -- staying on " + state.shipName);
            } else {
              ctx.log("transport", "Switched to " + targetShip.shipName);
              state.shipId = targetShipId;
              state.shipName = targetShip.shipName;
              state.tier = targetShip.tier;
              state.berths = targetShip.berths;
              saveTransportState(state);
            }
          }
        }

        // Travel to pickup station and dock
        if (!state.pickupStation || !state.pickupSystem) {
          ctx.log("error", "Pickup station not set -- cannot proceed");
          state.status = "idle";
          saveTransportState(state);
          await ctx.sleep(30000);
          continue;
        }
        ctx.log("transport", "Traveling to pickup station: " + state.pickupStation + " (" + state.pickupSystem + ")...");
        state.status = "traveling_to_ship";
        saveTransportState(state);
        if (state.pickupSystem !== bot.system) {
          const ok = await navigateToSystem(ctx, state.pickupSystem, { fuelThresholdPct: settings.refuelThreshold, hullThresholdPct: settings.repairThreshold });
          if (!ok) {
            ctx.log("error", "Failed to reach pickup system. Will retry.");
            state.status = "idle";
            saveTransportState(state);
            await ctx.sleep(30000);
            continue;
          }
        }
        if (bot.poi !== state.pickupStation) {
          ctx.log("transport", "Traveling to " + state.pickupStation + "...");
          const tr = await bot.exec("travel", { target_poi: state.pickupStation });
          if (tr.error) {
            ctx.log("error", "Travel to pickup failed: " + tr.error.message);
            state.status = "idle";
            saveTransportState(state);
            await ctx.sleep(30000);
            continue;
          }
        }
        const dOk = await ensureDocked(ctx);
        if (!dOk) {
          ctx.log("error", "Failed to dock at pickup station.");
          state.status = "idle";
          saveTransportState(state);
          await ctx.sleep(30000);
          continue;
        }
      } else {
        ctx.log("transport", "Already at pickup station " + state.pickupStation);
      }

      // Collect fuel cells at home base
      if ((state.pickupStation === settings.homeStation || state.pickupSystem === settings.homeSystem) && bot.system === settings.homeSystem && bot.poi === settings.homeStation) {
        ctx.log("transport", "At home base - collecting fuel cells");
        await collectFuelCells(ctx, settings, true);
      }

      // Load passengers
      state.status = "loading";
      saveTransportState(state);
      if (bot.state !== "running") {
        ctx.log("transport", "Stop requested before loading — aborting.");
        state.status = "idle";
        saveTransportState(state);
        await ctx.sleep(10000);
        continue;
      }

      // Count berth availability BEFORE issuing any load commands
      const preListResp = await bot.exec("list_passengers");
      let preListParsed: ListPassengersResponse | null = null;
      if (!preListResp.error && preListResp.result) {
        preListParsed = parseListPassengers(preListResp.result);
        ctx.log("transport", `Raw list_passengers result keys: ${Object.keys(preListResp.result).join(", ")} berths=${JSON.stringify((preListResp.result as any).berths)} berths_used=${JSON.stringify((preListResp.result as any).berths_used)}`);
      } else if (preListResp.error) {
        ctx.log("transport", `Pre-load list_passengers error: ${preListResp.error?.message}`);
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
      ctx.log("transport", `Pre-load berths: total=${state.berths.economy}e/${state.berths.business}b/${state.berths.first}f used=${state.berths_used.economy}e/${state.berths_used.business}b/${state.berths_used.first}f free=${freeEconomy}e/${freeBusiness}b/${freeFirst}f`);
      if (freeEconomy <= 0 && freeBusiness <= 0 && freeFirst <= 0) {
        ctx.log("transport", "No free berths available — skipping load, returning to idle.");
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
      ctx.log("transport", `list_station_passengers returned ${waiting.length} waiting`);

      for (const p of waiting) {
        const bio = p.bio || "";
        if (!p.bio) {
          ctx.log("transport", `Passenger ${p.name} (${p.citizen_id}) has no bio`);
        }
        civilianStore.registerSeen({
          citizenId: p.citizen_id,
          name: p.name,
          accommodationClass: p.class.toLowerCase() as "economy" | "business" | "first",
          destination: p.destination,
          destinationName: p.destination_name,
          fare: 0,
          bio,
        });
      }

      // Group passengers by destination
      const byDest = new Map<string, StationPassenger[]>();
      for (const p of waiting) {
        const cls = p.class.toLowerCase();
        if (settings.blockPirateStations && isPirateSystem(p.destination)) {
          ctx.log("transport", `Skipping ${p.name}: pirate route -> ${p.destination_name}`);
          continue;
        }
        if (cls === "first" && !settings.allowFirstClass) {
          ctx.log("transport", `Skipping ${p.name}: first disabled`);
          continue;
        }
        if (cls === "business" && !settings.allowBusinessClass) {
          ctx.log("transport", `Skipping ${p.name}: business disabled`);
          continue;
        }
        if (cls === "economy" && !settings.allowEconomyClass) {
          ctx.log("transport", `Skipping ${p.name}: economy disabled`);
          continue;
        }
        const arr = byDest.get(p.destination) || [];
        arr.push(p);
        byDest.set(p.destination, arr);
      }

      // For multi-destination tours, plan the route FIRST so loading order follows it.
      // This prevents stranding nearby passengers when distant destinations fill berths first.
      const mcLocation = mapStore.getMobileCapitolLocation();
      const destDrafts: Array<{ system: string; poi: string; poiName: string; count: number }> = [];
      for (const [destId, ps] of byDest.entries()) {
        const resolved = await resolveDestination(bot, destId, ps[0]?.destination_name || destId);
        let sys = resolved?.system || "";
        let poi = resolved?.poi || destId;
        if (!sys && mcLocation && (destId.toLowerCase() === "frontier_station" || (ps[0]?.destination_name || "").toLowerCase() === "frontier station")) {
          sys = mcLocation.systemId;
          poi = mcLocation.poiId;
        }
        destDrafts.push({ system: sys, poi, poiName: ps[0]?.destination_name || destId, count: ps.length });
      }

      const plannedRoute = planTourRoute(bot.system || "", destDrafts.filter(d => d.system), settings.maxJumps);
      ctx.log("transport", `Planned route BEFORE loading: ${plannedRoute.map(d => d.poiName).join(" → ") || "(none)"}`);

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
        if (bot.state !== "running") {
          ctx.log("transport", "Stop requested during loading — aborting passenger load loop.");
          state.status = "idle";
          saveTransportState(state);
          break;
        }
        const passengers = byDest.get(leg.poi) || [];
        if (passengers.length === 0) continue;

        const totalLoaded = usedEconomy + usedBusiness + usedFirst;
        if (settings.maxPassengers > 0 && totalLoaded >= settings.maxPassengers) {
          ctx.log("transport", "Max passenger cap reached — stopping load loop.");
          break;
        }

        const priority = settings.passengerPriority;
        const sortedPassengers = [...passengers].sort((a, b) => {
          if (priority === "off") return 0;
          const classOrder = { first: 0, business: 1, economy: 2 };
          return classOrder[a.class.toLowerCase() as keyof typeof classOrder] - classOrder[b.class.toLowerCase() as keyof typeof classOrder];
        });

        let canFit = 0;
        for (const p of sortedPassengers) {
          if (loadedNames.has(p.citizen_id)) continue;
          const cls = p.class.toLowerCase() as "economy" | "business" | "first";
          const capFirst = capAvailable(usedFirst, settings.maxFirst, freeFirst);
          const capBusiness = capAvailable(usedBusiness, settings.maxBusiness, freeBusiness);
          const capEconomy = capAvailable(usedEconomy, settings.maxEconomy, freeEconomy);
          if (cls === "first") {
            if (usedFirst < capFirst) {
              ctx.log("transport", `→ canFit ${p.name} (first): capAvail=${capFirst}, usedFirst=${usedFirst} → fit`);
              canFit++;
              usedFirst++;
              loadedNames.add(p.citizen_id);
            } else {
              ctx.log("transport", `→ NOFIT ${p.name} (first): capAvail=${capFirst}, usedFirst=${usedFirst}`);
            }
          } else if (cls === "business") {
            if (usedBusiness < capBusiness) {
              ctx.log("transport", `→ canFit ${p.name} (business): capAvail=${capBusiness}, usedBusiness=${usedBusiness} → fit`);
              canFit++;
              usedBusiness++;
              loadedNames.add(p.citizen_id);
            } else if (usedEconomy < capEconomy) {
              ctx.log("transport", `→ canFit ${p.name} (business->economy): capAvail=${capEconomy}, usedEconomy=${usedEconomy} → fit`);
              canFit++;
              usedEconomy++;
              loadedNames.add(p.citizen_id);
            } else {
              ctx.log("transport", `→ NOFIT ${p.name} (business): capAvail bus=${capBusiness} eco=${capEconomy}`);
            }
          } else {
            if (usedEconomy < capEconomy) {
              ctx.log("transport", `→ canFit ${p.name} (economy): capAvail=${capEconomy}, usedEconomy=${usedEconomy} → fit`);
              canFit++;
              usedEconomy++;
              loadedNames.add(p.citizen_id);
            } else if (usedBusiness < capBusiness) {
              ctx.log("transport", `→ canFit ${p.name} (economy->business): capAvail=${capBusiness}, usedBusiness=${usedBusiness} → fit`);
              canFit++;
              usedBusiness++;
              loadedNames.add(p.citizen_id);
            } else if (usedFirst < capFirst) {
              ctx.log("transport", `→ canFit ${p.name} (economy->first): capAvail=${capFirst}, usedFirst=${usedFirst} → fit`);
              canFit++;
              usedFirst++;
              loadedNames.add(p.citizen_id);
            } else {
              ctx.log("transport", `→ NOFIT ${p.name} (economy): capAvail eco=${capEconomy} bus=${capBusiness} first=${capFirst}`);
            }
          }
        }

        if (canFit <= 0) continue;

        ctx.log("transport", `Loading up to ${canFit} passengers for ${leg.poiName} (${leg.poi})...`);
        if (bot.state !== "running") {
          ctx.log("transport", "Stop requested before issuing load_passenger — aborting.");
          state.status = "idle";
          saveTransportState(state);
          break;
        }
        const loadResp = await bot.exec("load_passenger", { destination: leg.poi });
        if (loadResp.error) {
          ctx.log("error", `load_passenger failed for ${leg.poi}: ${loadResp.error.message}`);
          continue;
        }
        await ctx.sleep(11000);
        if (bot.state !== "running") {
          ctx.log("transport", "Stop requested after load sleep — aborting passenger load loop.");
          state.status = "idle";
          saveTransportState(state);
          break;
        }
        bot.refreshStatus().catch(() => {});
      }

      if (bot.state !== "running") {
        ctx.log("transport", "Stop requested after loading — remaining docked, returning to idle.");
        state.onboardPassengers = [];
        state.route = [];
        state.status = "idle";
        saveTransportState(state);
        await ctx.sleep(10000);
        continue;
      }

      // Read full passenger info
      const listResp = await bot.exec("list_passengers");
      let aboard: AboardPassenger[] = [];
      if (!listResp.error && listResp.result) {
        const parsed = parseListPassengers(listResp.result);
        if (parsed) {
          aboard = parsed.passengers;
          ctx.log("transport", `list_passengers returned ${aboard.length} passengers`);
          if (aboard.length > 0) {
            ctx.log("transport", `Sample passenger fields: ${Object.keys(aboard[0]).join(", ")}`);
            ctx.log("transport", `Sample passenger citizen_id: ${aboard[0].citizen_id}`);
          }
        }
      } else {
        ctx.log("transport", `WARNING: list_passengers failed: ${listResp.error?.message}`);
      }

      // Build route from aboard passengers
      const destMap = new Map<string, { system: string; poi: string; poiName: string; count: number }>();
      for (const p of aboard) {
        const existing = destMap.get(p.destination);
        if (existing) {
          existing.count++;
        } else {
          const resolved = await resolveDestination(bot, p.destination, p.destination_name);
          if (resolved) {
            destMap.set(p.destination, { ...resolved, count: 1 });
          } else {
            ctx.log("transport", `Could not resolve destination for ${p.name}: ${p.destination_name}`);
            destMap.set(p.destination, { system: "", poi: p.destination, poiName: p.destination_name, count: 1 });
          }
        }
      }

      const routeDests = Array.from(destMap.values()).filter(d => d.system);
      const planned = plannedRoute;

      const aboardIds = new Set(aboard.map(p => p.citizen_id || p.name));
      const beforeCount = state.onboardPassengers.length;
      state.onboardPassengers = state.onboardPassengers.filter(op => aboardIds.has(op.citizenId));
      const removedCount = beforeCount - state.onboardPassengers.length;
      if (removedCount > 0) {
        ctx.log("transport", `Removed ${removedCount} passenger(s) from onboard manifest — no longer aboard per list_passengers.`);
      }

      if (planned.length === 0) {
        const stranded = state.onboardPassengers.filter(p => !routeDests.some(d => d.poi === p.destination));
        if (stranded.length > 0) {
          ctx.log("transport", `Stranded ${stranded.length} passenger(s) with unresolvable destinations: ${stranded.map(p => p.destinationName).join(", ")}`);
          state.onboardPassengers = state.onboardPassengers.filter(p => routeDests.some(d => d.poi === p.destination));
        }
        if (state.onboardPassengers.length === 0) {
          ctx.log("transport", "No passengers with resolvable destinations — returning to idle.");
          state.route = [];
          state.currentRouteIndex = 0;
          state.currentDestination = null;
          state.status = "idle";
          saveTransportState(state);
          await ctx.sleep(10000);
          continue;
        }
      }

      for (const p of aboard) {
        civilianStore.addOrUpdate({
          citizenId: p.citizen_id || p.name,
          name: p.name,
          accommodationClass: p.class.toLowerCase() as "economy" | "business" | "first",
          citizenship: p.citizenship,
          destination: p.destination,
          destinationName: p.destination_name,
          fare: p.fare,
          bio: p.bio,
          loadedAt: new Date().toISOString(),
          status: "boarded",
          ticksRemaining: p.ticks_remaining,
        });
      }
      ctx.log("transport", `civilianStore updated for ${aboard.length} boarded passenger(s)`);

      // Build onboard passenger records
      const onboard: TransportPassenger[] = aboard.map(p => ({
        citizenId: p.citizen_id || p.name,
        name: p.name,
        accommodationClass: p.class.toLowerCase() as "economy" | "business" | "first",
        citizenship: p.citizenship,
        destination: p.destination,
        destinationName: p.destination_name,
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
      const listParsed = listResp.result ? parseListPassengers(listResp.result) : null;
      state.berths = listParsed && (listParsed.berths.economy + listParsed.berths.business + listParsed.berths.first) > 0
        ? listParsed.berths
        : state.berths;
      saveTransportState(state);

      if (onboard.length === 0) {
        ctx.log("transport", "No passengers loaded — re-entering idle search.");
        await ctx.sleep(10000);
        continue;
      }

      if (bot.state !== "running") {
        ctx.log("transport", "Stop requested after loading — remaining docked, returning to idle.");
        state.onboardPassengers = [];
        state.route = [];
        state.status = "idle";
        saveTransportState(state);
        await ctx.sleep(10000);
        continue;
      }

      ctx.log("transport", `Loaded ${onboard.length} passenger(s). Route: ${planned.map(d => d.poiName).join(" → ")}`);

      const announceService = (globalThis as any).aiChatService;
      const pickupIsHome = state.pickupStation === settings.homeStation || state.pickupSystem === settings.homeSystem;
      ctx.log("transport", `Transport announcement check: service=${!!announceService}, sendTransportAnnouncement=${typeof announceService?.sendTransportAnnouncement === "function"}, pickupIsHome=${pickupIsHome}`);
      if (
        announceService &&
        typeof announceService.sendTransportAnnouncement === "function" &&
        pickupIsHome
      ) {
        const routeNames = planned.map(d => d.poiName);
        const passengerInfos = onboard.map(p => ({
          name: p.name,
          bio: p.bio || "",
          destinationName: p.destinationName,
        }));
        announceService.sendTransportAnnouncement(bot, {
          shipName: state.shipName,
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

      // Undock and continue to transit handling below
      await ensureUndocked(ctx);
      state.status = "in_transit";
      saveTransportState(state);
    }

    if (state.status === "in_transit" || state.status === "traveling_to_ship") {
      if (state.route.length === 0 || state.currentRouteIndex >= state.route.length) {
        if (state.onboardPassengers.length > 0) {
          ctx.log("transport", `Route exhausted but ${state.onboardPassengers.length} passenger(s) remain — checking for new route...`);
          const destMap = new Map<string, { system: string; poi: string; poiName: string; count: number }>();
          for (const p of state.onboardPassengers) {
            const resolved = await resolveDestination(bot, p.destination, p.destinationName);
            if (resolved) {
              destMap.set(p.destination, { ...resolved, count: 1 });
            } else {
              destMap.set(p.destination, { system: "", poi: p.destination, poiName: p.destinationName, count: 1 });
            }
          }
          const validDests = Array.from(destMap.values()).filter(d => d.system);
          if (validDests.length > 0) {
            const newRoute = planTourRoute(bot.system || "", validDests, 6);
            if (newRoute.length > 0) {
              state.route = newRoute;
              state.currentRouteIndex = 0;
              state.currentDestination = newRoute[0].poiName;
              state.status = "in_transit";
              ctx.log("transport", `Rebuilt route with ${validDests.length} destination(s): ${newRoute.map(d => d.poiName).join(" → ")}`);
              saveTransportState(state);
              continue;
            }
          }
          ctx.log("transport", "Cannot find route for remaining passengers — marking as stranded and returning to idle.");
          state.onboardPassengers = state.onboardPassengers.map(p => ({ ...p, status: "stranded" }));
        }
        state.status = "idle";
        saveTransportState(state);
        continue;
      }

      const waypoint = state.route[state.currentRouteIndex];
      ctx.log("transport", `Navigating to waypoint ${state.currentRouteIndex + 1}/${state.route.length}: ${waypoint.poiName} (${waypoint.system})`);

      if (waypoint.system !== bot.system) {
        ctx.log("transport", `Navigating from ${bot.system} to ${waypoint.system}...`);
        const ok = await navigateToSystem(ctx, waypoint.system, { fuelThresholdPct: settings.refuelThreshold, hullThresholdPct: settings.repairThreshold });
        await bot.refreshStatus();
        ctx.log("transport", `navigateToSystem result: ${ok}, bot.system: ${bot.system}, bot.poi: ${bot.poi}`);
        if (!ok) {
          ctx.log("error", "Navigation failed — will retry.");
          await ctx.sleep(30000);
          continue;
        }
      } else {
        ctx.log("transport", `Already in system ${bot.system}`);
      }
      if (bot.poi !== waypoint.poi) {
        ctx.log("transport", `Traveling to ${waypoint.poiName}... (current poi: ${bot.poi})`);
        const tr = await bot.exec("travel", { target_poi: waypoint.poi });
        if (tr.error) {
          ctx.log("error", `Travel failed: ${tr.error.message}`);
          await ctx.sleep(30000);
          continue;
        }
        await bot.refreshStatus();
        ctx.log("transport", `After travel, bot.poi: ${bot.poi}`);
      } else {
        ctx.log("transport", `Already at ${waypoint.poi}`);
      }

      const alreadyDocked = bot.docked && bot.poi === waypoint.poi;
      ctx.log("transport", `Docking at ${waypoint.poiName}... (alreadyDocked=${alreadyDocked}, poi=${bot.poi}, docked=${bot.docked})`);
      
      const creditsBefore = bot.credits || 0;
      ctx.log("transport", `Credits before docking: ${creditsBefore}`);
      
      if (!alreadyDocked) {
        const dockResp = await bot.exec("dock");
        if (dockResp.error && !dockResp.error.message.includes("already")) {
          ctx.log("error", `Dock failed: ${dockResp.error.message}`);
          await ctx.sleep(30000);
          continue;
        }
      }

      await bot.refreshStatus();
      const creditsAfter = bot.credits || 0;
      const fareEarned = creditsAfter - creditsBefore;
      ctx.log("transport", `Credits after docking: ${creditsAfter}, fare earned: ${fareEarned}`);

      // Unload passengers for this station
      state.status = "unloading";
      saveTransportState(state);

      const boundHere = state.onboardPassengers.filter(
        p => p.status === "boarded" && (p.destination.toLowerCase() === waypoint.poi.toLowerCase() || p.destinationName.toLowerCase() === waypoint.poiName.toLowerCase()),
      );

      ctx.log("transport", `Found ${boundHere.length} passengers to deliver at ${waypoint.poiName}`);

      // Calculate fare per passenger (distribute evenly if multiple passengers)
      const farePerPassenger = boundHere.length > 0 ? Math.round(fareEarned / boundHere.length) : 0;

      for (const p of boundHere) {
        const citizenId = p.citizenId || p.name;
        ctx.log("transport", `Delivered ${p.name} to ${waypoint.poiName}. Fare: ${farePerPassenger}cr`);
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
          fare: farePerPassenger,
          bio: p.bio,
          loadedAt: p.loadedAt,
          status: "delivered",
        });
      }

      state.currentRouteIndex += 1;
      if (state.currentRouteIndex >= state.route.length) {
        state.status = "completed";
        state.currentDestination = null;
        ctx.log("transport", `Run complete. Total revenue: ${state.totalFaresEarned}cr. Passengers delivered: ${boundHere.length}`);
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
          await collectFuelCells(ctx, settings, true);
        }
        
        state.status = "idle";
        state.onboardPassengers = [];
        state.route = [];
        state.revenue = 0;
        state.currentRouteIndex = 0;
        state.currentDestination = null;
        saveTransportState(state);
        
        const announceService = (globalThis as any).aiChatService;
        const isAtHomeSystem = bot.system === settings.homeSystem;
        ctx.log("transport", `Transport cycle_complete announcement check: service=${!!announceService}, sendTransportAnnouncement=${typeof announceService?.sendTransportAnnouncement === "function"}, isAtHomeSystem=${isAtHomeSystem}`);
        if (
          announceService &&
          typeof announceService.sendTransportAnnouncement === "function" &&
          isAtHomeSystem
        ) {
          const routeNames = completedPassengers.map(p => p.destinationName);
          const passengerInfos = completedPassengers.map(p => ({
            name: p.name,
            bio: p.bio || "",
            destinationName: p.destinationName,
          }));
          announceService.sendTransportAnnouncement(bot, {
            shipName: state.shipName,
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
    await ctx.sleep(5000);
  }
};
