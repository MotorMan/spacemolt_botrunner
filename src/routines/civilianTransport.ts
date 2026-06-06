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
} from "./common.js";
import { getSystemBlacklist } from "../web/server.js";

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
  const data = loadAllData();
  return data.runs[botUsername] || null;
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
  const berths = (inner.berths || {}) as Record<string, number>;
  const berthsUsed = (inner.berths_used || {}) as Record<string, number>;
  return {
    passengers,
    berths: {
      economy: berths.economy || 0,
      business: berths.business || 0,
      first: berths.first || 0,
    },
    berths_used: {
      economy: berthsUsed.economy || 0,
      business: berthsUsed.business || 0,
      first: berthsUsed.first || 0,
    },
  };
}

function parseListShips(result: unknown): FleetShip[] {
  if (!result || typeof result !== "object") return [];
  const r = result as Record<string, unknown>;
  const ships = Array.isArray(r.ships) ? r.ships : Array.isArray(r.fleet) ? r.fleet : [];
  return ships.map((s: Record<string, unknown>) => {
    const berths = (s.passenger_berths || s.berths || {}) as Record<string, number>;
    return {
      shipId: (s.ship_id || s.id || "") as string,
      shipName: (s.name || s.ship_name || "") as string,
      type: (s.type || s.ship_type || "") as string,
      tier: (s.tier as number) ?? null,
      berths: {
        economy: berths.economy || 0,
        business: berths.business || 0,
        first: berths.first || 0,
      },
      storedAtStationId: (s.stored_at_station_id || s.station_id || s.current_station || "") as string,
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
  const ships = parseListShips(resp.result);
  saveFleetData(bot.username, ships);
  ctx.log("transport", `Fleet updated: ${ships.length} ship(s) cached`);
  return ships;
}

async function selectPickupStation(
  ctx: RoutineContext,
  berths: { economy: number; business: number; first: number },
  maxJumps: number,
): Promise<{ system: string; poi: string; poiName: string; count: number } | null> {
  const { bot } = ctx;
  const stations: Array<{ system: string; poi: string; poiName: string; count: number }> = [];

  // Check current station first if docked
  if (bot.docked && bot.poi && bot.system) {
    const resp = await bot.exec("list_station_passengers");
    if (!resp.error && resp.result) {
      const data = parseStationPassengers(resp.result);
      if (data && data.count > 0) {
        stations.push({
          system: bot.system,
          poi: bot.poi,
          poiName: data.station,
          count: data.count,
        });
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

  // Query each candidate system's station(s) concurrently
  const stationPromises: Promise<void>[] = [];
  candidates.forEach((info) => {
    if (info.hops > maxJumps) return;
    stationPromises.push(
      (async () => {
        try {
          const sysResp = await bot.exec("get_system", { system_id: info.systemId });
          if (sysResp.error || !sysResp.result) return;
          const sysResult = sysResp.result as Record<string, unknown>;
          const sysObj = sysResult.system as Record<string, unknown> || sysResult;
          const pois = (sysObj.pois || []) as Array<Record<string, unknown>>;
          for (const p of pois) {
            const hasBase = p.has_base || p.base_id || p.base;
            if (!hasBase) continue;
            const poiId = (p.id || p.poi_id || p.name || "") as string;
            if (!poiId) continue;
            const pResp = await bot.exec("list_station_passengers", { station: poiId });
            if (pResp.error || !pResp.result) continue;
            const pData = parseStationPassengers(pResp.result);
            if (pData && pData.count > 0) {
              stations.push({
                system: info.systemId,
                poi: poiId,
                poiName: pData.station,
                count: pData.count,
              });
            }
          }
        } catch {
          // skip system query errors
        }
      })()
    );
  });
  await Promise.allSettled(stationPromises);

  if (stations.length === 0) return null;

  // Pick station with most waiting passengers
  stations.sort((a, b) => b.count - a.count);
  return stations[0];
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
  if (destinations.length <= 1) return destinations;

  const remaining = [...destinations];
  const planned: typeof destinations = [];
  let cur = currentSystem;

  while (remaining.length > 0) {
    // Find nearest reachable within maxJumps from current position
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
      // No more reachable destinations within maxJumps — stop here
      break;
    }

    const next = remaining.splice(bestIndex, 1)[0]!;
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

  // Initialize state if none
  if (!state) {
    const best = pickBestShip(ctx, fleet);
    if (!best) {
      ctx.log("error", "No passenger-capable ship found in fleet. Routine cannot run.");
      return;
    }
    state = makeNewState(bot, best.shipId, best.shipName, best.tier, best.berths);
    saveTransportState(state);
  }

  ctx.log("transport", `Civilian transport started. Active ship: ${state.shipName} (${state.shipId}). Status: ${state.status}`);

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

    // ── State machine ────────────────────────────────────────
    if (state.status === "idle") {
      // Need to find passengers and load up
      const pickup = await selectPickupStation(ctx, state.berths, settings.maxJumps);
      if (!pickup) {
        ctx.log("transport", "No stations with waiting passengers found nearby. Sleeping 60s.");
        await ctx.sleep(60000);
        continue;
      }

      state.pickupStation = pickup.poi;
      state.pickupSystem = pickup.system;
      state.status = "traveling_to_ship";
      saveTransportState(state);

      // Check if we need to switch to the best passenger ship first
      const bestNow = pickBestShip(ctx, fleet);
      const targetShipId = bestNow ? bestNow.shipId : state.shipId;

      if (targetShipId !== state.shipId) {
        const targetShip = fleet.find(s => s.shipId === targetShipId);
        if (!targetShip) {
          ctx.log("transport", "Target ship not found in fleet — staying on current ship.");
        } else if (targetShip.storedAtSystemId !== bot.system || targetShip.storedAtStationId !== bot.poi) {
          // Travel to where the ship is stored
          const shipSystem = targetShip.storedAtSystemId || targetShip.storedAtStationId;
          if (shipSystem && shipSystem !== bot.system) {
            ctx.log("transport", `Traveling to ${shipSystem} to switch to ${targetShip.shipName}...`);
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
        ctx.log("transport", `Switching from ${state.shipName} to ${targetShip!.shipName}...`);
        const switchResp = await bot.exec("switch_ship", { ship_id: targetShipId });
        if (switchResp.error) {
          ctx.log("error", `switch_ship failed: ${switchResp.error.message} — staying on ${state.shipName}`);
        } else {
          ctx.log("transport", `Switched to ${targetShip!.shipName}`);
          state.shipId = targetShipId;
          state.shipName = targetShip!.shipName;
          state.tier = targetShip!.tier;
          state.berths = targetShip!.berths;
          saveTransportState(state);
        }
      }

      // Travel to pickup station and dock
      ctx.log("transport", `Traveling to pickup station: ${pickup.poiName} (${pickup.system})...`);
      state.status = "traveling_to_ship";
      saveTransportState(state);
      if (pickup.system !== bot.system) {
        const ok = await navigateToSystem(ctx, pickup.system, { fuelThresholdPct: settings.refuelThreshold, hullThresholdPct: settings.repairThreshold });
        if (!ok) {
          ctx.log("error", "Failed to reach pickup system. Will retry.");
          state.status = "idle";
          saveTransportState(state);
          await ctx.sleep(30000);
          continue;
        }
      }
      if (bot.poi !== pickup.poi) {
        ctx.log("transport", `Traveling to ${pickup.poiName}...`);
        const tr = await bot.exec("travel", { target_poi: pickup.poi });
        if (tr.error) {
          ctx.log("error", `Travel to pickup failed: ${tr.error.message}`);
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

      // Load passengers
      state.status = "loading";
      saveTransportState(state);

      // Determine destination groups
      const stationResp = await bot.exec("list_station_passengers");
      let waiting: StationPassenger[] = [];
      if (!stationResp.error && stationResp.result) {
        const parsed = parseStationPassengers(stationResp.result);
        if (parsed) waiting = parsed.waiting;
      }

      // Count berth availability
      const freeEconomy = state.berths.economy;
      const freeBusiness = state.berths.business;
      const freeFirst = state.berths.first;

      // Group passengers by destination
      const byDest = new Map<string, StationPassenger[]>();
      for (const p of waiting) {
        const arr = byDest.get(p.destination) || [];
        arr.push(p);
        byDest.set(p.destination, arr);
      }

      // For multi-destination tours: we can load passengers for multiple stops.
      // Call load_passenger once per destination to fill berths.
      // Economy berths can take any class; business can take business/first; first is exclusive.
      const loadedNames = new Set<string>();
      let usedEconomy = 0;
      let usedBusiness = 0;
      let usedFirst = 0;

      const capAvailable = (used: number, max: number, free: number) => {
        if (max > 0) return Math.min(free, max - used);
        return free;
      };

      const destinationsPriority = Array.from(byDest.entries())
        .sort((a, b) => b[1].length - a[1].length);

      for (const [destId, passengers] of destinationsPriority) {
        if (passengers.length === 0) continue;
        // Check total passenger cap
        const totalLoaded = usedEconomy + usedBusiness + usedFirst;
        if (settings.maxPassengers > 0 && totalLoaded >= settings.maxPassengers) {
          break;
        }
        // Check how many we can fit respecting configured maxes
        let canFit = 0;
        for (const p of passengers) {
          const cls = p.class.toLowerCase() as "economy" | "business" | "first";
          if (cls === "first") {
            if (usedFirst < capAvailable(usedFirst, settings.maxFirst, freeFirst)) {
              canFit++;
              usedFirst++;
            }
          } else if (cls === "business") {
            if (usedBusiness < capAvailable(usedBusiness, settings.maxBusiness, freeBusiness)) {
              canFit++;
              usedBusiness++;
            } else if (usedEconomy < capAvailable(usedEconomy, settings.maxEconomy, freeEconomy)) {
              canFit++;
              usedEconomy++;
            }
          } else {
            if (usedEconomy < capAvailable(usedEconomy, settings.maxEconomy, freeEconomy)) {
              canFit++;
              usedEconomy++;
            } else if (usedBusiness < capAvailable(usedBusiness, settings.maxBusiness, freeBusiness)) {
              canFit++;
              usedBusiness++;
            } else if (usedFirst < capAvailable(usedFirst, settings.maxFirst, freeFirst)) {
              canFit++;
              usedFirst++;
            }
          }
          if (canFit >= passengers.length) break;
        }
        if (canFit <= 0) continue;

        ctx.log("transport", `Loading up to ${canFit} passengers for ${passengers[0].destination_name} (${destId})...`);
        const loadResp = await bot.exec("load_passenger", { destination: destId });
        if (loadResp.error) {
          ctx.log("error", `load_passenger failed for ${destId}: ${loadResp.error.message}`);
          continue;
        }
        // Brief pause for mutation cooldown
        await ctx.sleep(11000);
        // Refresh fleet and state after load
        bot.refreshStatus().catch(() => {});
      }

      // Read full passenger info
      const listResp = await bot.exec("list_passengers");
      let aboard: AboardPassenger[] = [];
      if (!listResp.error && listResp.result) {
        const parsed = parseListPassengers(listResp.result);
        if (parsed) aboard = parsed.passengers;
      }

      // Build route from aboard passengers
      const destMap = new Map<string, { system: string; poi: string; poiName: string; count: number }>();
      for (const p of aboard) {
        // Destination may be a station id; we already have destination_name
        const existing = destMap.get(p.destination);
        if (existing) {
          existing.count++;
        } else {
          // Try to resolve destination station to system
          let sys = "";
          let poi = p.destination;
          // Look up in mapStore by station id or name
          const allSystems = mapStore.getAllSystems();
          for (const [, sysData] of Object.entries(allSystems)) {
            const found = sysData.pois.find(
              pp => pp.id === p.destination || pp.name.toLowerCase() === p.destination_name.toLowerCase(),
            );
            if (found) {
              sys = sysData.id;
              poi = found.id;
              break;
            }
          }
          destMap.set(p.destination, {
            system: sys,
            poi,
            poiName: p.destination_name,
            count: 1,
          });
        }
      }

      const routeDests = Array.from(destMap.values());
      const planned = planTourRoute(bot.system || "", routeDests, settings.maxJumps);

      // Build onboard passenger records
      const onboard: TransportPassenger[] = aboard.map(p => ({
        citizenId: p.citizen_id,
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
      state.berths = listResp.result
        ? parseListPassengers(listResp.result)!.berths
        : state.berths;
      saveTransportState(state);

      if (onboard.length === 0) {
        ctx.log("transport", "No passengers loaded — re-entering idle search.");
        await ctx.sleep(10000);
        continue;
      }

      ctx.log("transport", `Loaded ${onboard.length} passenger(s). Route: ${planned.map(d => d.poiName).join(" → ")}`);

      // Undock and continue to transit handling below
      await ensureUndocked(ctx);
      state.status = "in_transit";
      saveTransportState(state);
    }

    if (state.status === "in_transit" || state.status === "traveling_to_ship") {
      if (state.route.length === 0 || state.currentRouteIndex >= state.route.length) {
        state.status = "idle";
        saveTransportState(state);
        continue;
      }

      const waypoint = state.route[state.currentRouteIndex];
      ctx.log("transport", `Navigating to waypoint ${state.currentRouteIndex + 1}/${state.route.length}: ${waypoint.poiName} (${waypoint.system})`);

      if (waypoint.system !== bot.system) {
        const ok = await navigateToSystem(ctx, waypoint.system, { fuelThresholdPct: settings.refuelThreshold, hullThresholdPct: settings.repairThreshold });
        if (!ok) {
          ctx.log("error", "Navigation failed — will retry.");
          await ctx.sleep(30000);
          continue;
        }
      }
      if (bot.poi !== waypoint.poi) {
        ctx.log("transport", `Traveling to ${waypoint.poiName}...`);
        const tr = await bot.exec("travel", { target_poi: waypoint.poi });
        if (tr.error) {
          ctx.log("error", `Travel failed: ${tr.error.message}`);
          await ctx.sleep(30000);
          continue;
        }
      }

      const dockOk = await ensureDocked(ctx);
      if (!dockOk) {
        ctx.log("error", "Dock failed at destination.");
        await ctx.sleep(30000);
        continue;
      }

      // Unload passengers for this station
      state.status = "unloading";
      saveTransportState(state);

      // Refresh list_passengers to verify current onboard
      const checkResp = await bot.exec("list_passengers");
      let currentAboard: AboardPassenger[] = [];
      if (!checkResp.error && checkResp.result) {
        const parsed = parseListPassengers(checkResp.result);
        if (parsed) currentAboard = parsed.passengers;
      }

      const boundHere = currentAboard.filter(
        p => p.destination.toLowerCase() === waypoint.poi.toLowerCase() || p.destination_name.toLowerCase() === waypoint.poiName.toLowerCase(),
      );

      for (const p of boundHere) {
        const unloadResp = await bot.exec("unload_passenger", { name: p.citizen_id || p.name });
        if (unloadResp.error) {
          ctx.log("error", `unload_passenger ${p.name} failed: ${unloadResp.error.message}`);
          state.onboardPassengers = state.onboardPassengers.map(op =>
            op.citizenId === p.citizen_id ? { ...op, status: "stranded" as const } : op,
          );
        } else {
          ctx.log("transport", `Delivered ${p.name} to ${waypoint.poiName}. Fare: ${p.fare}cr`);
          state.revenue += p.fare;
          state.totalFaresEarned += p.fare;
          state.onboardPassengers = state.onboardPassengers.map(op =>
            op.citizenId === p.citizen_id ? { ...op, status: "delivered" as const } : op,
          );
        }
        await ctx.sleep(11000); // mutation cooldown
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
        clearTransportState(bot.username);
        state.status = "idle";
        state.onboardPassengers = [];
        state.route = [];
        state.revenue = 0;
        state.currentRouteIndex = 0;
        state.currentDestination = null;
        saveTransportState(state);
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
