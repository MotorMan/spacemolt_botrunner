import type { Routine, RoutineContext } from "../bot.js";
import { mapStore } from "../mapstore.js";
import { getSystemBlacklist } from "../web/server.js";
import {
  type SystemPOI,
  type Connection,
  isMinablePoi,
  isScenicPoi,
  isStationPoi,
  findStation,
  getSystemInfo,
  collectFromStorage,
  ensureDocked,
  ensureUndocked,
  tryRefuel,
  repairShip,
  ensureFueled,
  depositCargoAtHome,
  navigateToSystem,
  fetchSecurityLevel,
  scavengeWrecks,
  detectAndRecoverFromDeath,
  readSettings,
  writeSettings,
  isPirateSystem,
  checkCustomsInspection,
  checkAndFleeFromPirates,
  fleeFromBattle,
  checkAndFleeFromBattle,
  checkBattleAfterCommand,
} from "./common.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

/** Minimum fuel % before heading back to refuel. */
const FUEL_SAFETY_PCT = 40;

// ── Market Details Storage ──────────────────────────────────

const DATA_DIR = join(process.cwd(), "data");
const MARKET_DETAILS_FILE = join(DATA_DIR, "marketDetails.json");

interface MarketOrderDetail {
  price: number;
  quantity: number;
}

interface MarketItemDetails {
  systemId: string;
  stationPoiId: string;
  stationName: string;
  itemId: string;
  itemName: string;
  buyOrders: MarketOrderDetail[];
  sellOrders: MarketOrderDetail[];
  lastUpdated: string;
}

interface MarketDetailsData {
  lastSaved: string;
  items: MarketItemDetails[];
}

function loadMarketDetails(): MarketDetailsData {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  if (existsSync(MARKET_DETAILS_FILE)) {
    try {
      const raw = readFileSync(MARKET_DETAILS_FILE, "utf-8");
      return JSON.parse(raw) as MarketDetailsData;
    } catch {
      // Corrupt file — start fresh
    }
  }
  return { lastSaved: now(), items: [] };
}

function saveMarketDetails(data: MarketDetailsData): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  data.lastSaved = now();
  writeFileSync(MARKET_DETAILS_FILE, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function now(): string {
  return new Date().toISOString();
}
/** Default minimum fuel % required before attempting a system jump. */
const DEFAULT_JUMP_FUEL_PCT = 50;

/** Format an ISO timestamp as a relative "time ago" string. */
function timeAgoFromIso(isoStr: string | null): string {
  if (!isoStr) return "unknown";
  const diff = Date.now() - new Date(isoStr).getTime();
  if (diff < 0) return "just now";
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// ── Mission helpers ───────────────────────────────────────────

const EXPLORER_MISSION_KEYWORDS = [
  "explore", "survey", "scan", "chart", "discover", "map", "navigate",
  "visit", "investigate", "reconnaissance", "recon", "scout", "patrol",
  "deliver", "supply", "collect",
];

/** Accept available exploration missions at the current station. Respects 5-mission cap. */
async function checkAndAcceptMissions(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;
  if (!bot.docked) return;

  const activeResp = await bot.exec("get_active_missions");
  let activeCount = 0;
  if (activeResp.result && typeof activeResp.result === "object") {
    const r = activeResp.result as Record<string, unknown>;
    const list = Array.isArray(r) ? r : Array.isArray(r.missions) ? r.missions : [];
    activeCount = (list as unknown[]).length;
  }
  if (activeCount >= 5) return;

  const availResp = await bot.exec("get_missions");
  if (!availResp.result || typeof availResp.result !== "object") return;
  const r = availResp.result as Record<string, unknown>;
  const available = (
    Array.isArray(r) ? r :
    Array.isArray(r.missions) ? r.missions : []
  ) as Array<Record<string, unknown>>;

  for (const mission of available) {
    if (activeCount >= 5) break;
    const missionId = (mission.id as string) || (mission.mission_id as string) || "";
    if (!missionId) continue;
    const name = ((mission.name as string) || "").toLowerCase();
    const desc = ((mission.description as string) || "").toLowerCase();
    const type = ((mission.type as string) || "").toLowerCase();
    const isExplorerMission = EXPLORER_MISSION_KEYWORDS.some(kw =>
      name.includes(kw) || desc.includes(kw) || type.includes(kw)
    );
    if (!isExplorerMission) continue;
    const acceptResp = await bot.exec("accept_mission", { mission_id: missionId });
    if (!acceptResp.error) {
      activeCount++;
      ctx.log("info", `Mission accepted: ${(mission.name as string) || missionId} (${activeCount}/5 active)`);
    }
  }
}

/** Complete any active missions while docked. */
async function completeActiveMissions(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;
  if (!bot.docked) return;

  const activeResp = await bot.exec("get_active_missions");
  if (!activeResp.result || typeof activeResp.result !== "object") return;
  const r = activeResp.result as Record<string, unknown>;
  const missions = (
    Array.isArray(r) ? r :
    Array.isArray(r.missions) ? r.missions : []
  ) as Array<Record<string, unknown>>;

  for (const mission of missions) {
    const missionId = (mission.id as string) || (mission.mission_id as string) || "";
    if (!missionId) continue;
    const completeResp = await bot.exec("complete_mission", { mission_id: missionId });
    if (!completeResp.error) {
      const reward = (mission.reward as number) || (mission.reward_credits as number) || 0;
      ctx.log("trade", `Mission complete: ${(mission.name as string) || missionId}${reward > 0 ? ` (+${reward} credits)` : ""}`);
      await bot.refreshStatus();
    }
  }
}

/** Minutes before a station's market/orders/missions data is considered stale. */
const STATION_REFRESH_MINS = 30;
/** Minutes before a resource POI should be re-sampled. */
const RESOURCE_REFRESH_MINS = 120;

// ── Per-bot settings ─────────────────────────────────────────

export type ExplorerMode = "explore" | "trade_update" | "deep_core_scan";

function getExplorerSettings(username?: string): {
  mode: ExplorerMode;
  acceptMissions: boolean;
  focusAreaSystem: string | null;
  maxJumps: number;
  refuelThreshold: number;
  surveyMode: "quick" | "thorough";
  scanPois: boolean;
  directToUnknown: boolean;
  groupUnknowns: boolean;
  scavengeEnabled: boolean;
  loadFuelCellsAtHome: boolean;
  returnToHomeOnFuelCellDepletion: boolean;
} {
  const all = readSettings();
  const botOverrides = username ? (all[username] || {}) : {};
  const mode = (botOverrides.explorerMode as string) || "explore";
  const e = all.explorer || {};

  // acceptMissions: per-bot > global explorer > default true
  const acceptMissions = botOverrides.acceptMissions !== undefined
    ? Boolean(botOverrides.acceptMissions)
    : e.acceptMissions !== undefined
      ? Boolean(e.acceptMissions)
      : true;

  // Focus area settings: per-bot only (no global defaults)
  const focusAreaSystem = (botOverrides.focusAreaSystem as string) || null;
  const maxJumps = (botOverrides.maxJumps as number) || 5;

  // Refuel threshold: per-bot > global explorer > default 50%
  const refuelThreshold = (botOverrides.refuelThreshold as number) ?? e.refuelThreshold ?? DEFAULT_JUMP_FUEL_PCT;

  // Survey mode: per-bot > global explorer > default "thorough"
  const surveyMode = (botOverrides.surveyMode as "quick" | "thorough") ?? e.surveyMode ?? "thorough";

  // Scan POIs: per-bot > global explorer > default true
  const scanPois = botOverrides.scanPois !== undefined
    ? Boolean(botOverrides.scanPois)
    : e.scanPois !== undefined
      ? Boolean(e.scanPois)
      : true;

  // Direct to unknown: per-bot > global explorer > default false
  const directToUnknown = botOverrides.directToUnknown !== undefined
    ? Boolean(botOverrides.directToUnknown)
    : e.directToUnknown !== undefined
      ? Boolean(e.directToUnknown)
      : false;

  // Group unknowns: per-bot > global explorer > default true
  const groupUnknowns = botOverrides.groupUnknowns !== undefined
    ? Boolean(botOverrides.groupUnknowns)
    : e.groupUnknowns !== undefined
      ? Boolean(e.groupUnknowns)
      : true;

  // Scavenge: per-bot > global explorer > default false (unsafe near pirates)
  const scavengeEnabled = botOverrides.scavengeEnabled !== undefined
    ? Boolean(botOverrides.scavengeEnabled)
    : e.scavengeEnabled !== undefined
      ? Boolean(e.scavengeEnabled)
      : false;

  // Load fuel cells at home: per-bot > global explorer > default true
  const loadFuelCellsAtHome = botOverrides.loadFuelCellsAtHome !== undefined
    ? Boolean(botOverrides.loadFuelCellsAtHome)
    : e.loadFuelCellsAtHome !== undefined
      ? Boolean(e.loadFuelCellsAtHome)
      : true;

  // Return to home on fuel cell depletion: per-bot > global explorer > default false
  const returnToHomeOnFuelCellDepletion = botOverrides.returnToHomeOnFuelCellDepletion !== undefined
    ? Boolean(botOverrides.returnToHomeOnFuelCellDepletion)
    : e.returnToHomeOnFuelCellDepletion !== undefined
      ? Boolean(e.returnToHomeOnFuelCellDepletion)
      : false;

  return {
    mode: (mode === "trade_update" ? "trade_update" : mode === "deep_core_scan" ? "deep_core_scan" : "explore") as ExplorerMode,
    acceptMissions,
    focusAreaSystem,
    maxJumps,
    refuelThreshold: Number(refuelThreshold) || DEFAULT_JUMP_FUEL_PCT,
    surveyMode: (surveyMode === "quick" ? "quick" : "thorough") as "quick" | "thorough",
    scanPois,
    directToUnknown,
    groupUnknowns,
    scavengeEnabled,
    loadFuelCellsAtHome,
    returnToHomeOnFuelCellDepletion,
  };
}

/** Persist explorer mode setting for a specific bot. */
export function setExplorerMode(username: string, mode: ExplorerMode): void {
  writeSettings({
    [username]: { explorerMode: mode },
  });
}

/** Persist deep core scan mode setting for a specific bot. */
export function setExplorerDeepCoreScan(username: string, enabled: boolean): void {
  writeSettings({
    [username]: { explorerMode: enabled ? "deep_core_scan" : "explore" },
  });
}

/** Persist focus area settings for a specific bot. */
export function setExplorerFocusArea(username: string, focusAreaSystem: string | null, maxJumps: number): void {
  writeSettings({
    [username]: { focusAreaSystem, maxJumps },
  });
}

/** Persist jump fuel threshold setting for a specific bot. */
export function setExplorerJumpFuelThreshold(username: string, refuelThreshold: number): void {
  writeSettings({
    [username]: { refuelThreshold },
  });
}

/** Persist direct to unknown setting for a specific bot. */
export function setExplorerDirectToUnknown(username: string, directToUnknown: boolean): void {
  writeSettings({
    [username]: { directToUnknown },
  });
}

/** Persist group unknowns setting for a specific bot. */
export function setExplorerGroupUnknowns(username: string, groupUnknowns: boolean): void {
  writeSettings({
    [username]: { groupUnknowns },
  });
}

/** Persist scavenge enabled setting for a specific bot. */
export function setExplorerScavengeEnabled(username: string, scavengeEnabled: boolean): void {
  writeSettings({
    [username]: { scavengeEnabled },
  });
}

/** Persist load fuel cells at home setting for a specific bot. */
export function setExplorerLoadFuelCellsAtHome(username: string, loadFuelCellsAtHome: boolean): void {
  writeSettings({
    [username]: { loadFuelCellsAtHome },
  });
}

/** Persist return to home on fuel cell depletion setting for a specific bot. */
export function setExplorerReturnToHomeOnFuelCellDepletion(username: string, returnToHomeOnFuelCellDepletion: boolean): void {
  writeSettings({
    [username]: { returnToHomeOnFuelCellDepletion },
  });
}

/**
 * Explorer routine — systematically maps the galaxy:
 *
 * Exploration logic per POI:
 *   - Scenic (sun, star, gate): visit once, never revisit
 *   - Resource (belt, gas cloud, etc.): sample mine, revisit every RESOURCE_REFRESH_MINS
 *   - Station: dock, scan market/orders/missions, revisit every STATION_REFRESH_MINS
 *   - Other (planet, anomaly, etc.): check nearby, revisit every RESOURCE_REFRESH_MINS
 *
 * After visiting all POIs in a system, jump to least-explored connected system.
 */
export const explorerRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  // Check per-bot mode
  const initialSettings = getExplorerSettings(bot.username);
  if (initialSettings.mode === "trade_update") {
    yield* tradeUpdateRoutine(ctx);
    return;
  }
  if (initialSettings.mode === "deep_core_scan") {
    yield* deepCoreScanRoutine(ctx);
    return;
  }

  const visitedSystems = new Set<string>();
  const fledFromSystems = new Set<string>(); // Track systems we've fled from due to pirates
  const path: string[] = []; // Track the path of systems visited to enable reverse fleeing
  let lastSystem: string | null = null;

  // ── Startup: dock at local station to clear cargo & refuel ──
  yield "startup_prep";
  await bot.refreshStatus();
  const { pois: startPois } = await getSystemInfo(ctx);
  const startStation = findStation(startPois);
  if (startStation) {
    ctx.log("system", `Startup: docking at ${startStation.name} to clear cargo & refuel...`);

    // Travel to station if not already there
    if (bot.poi !== startStation.id) {
      await ensureUndocked(ctx);
      const tResp = await bot.exec("travel", { target_poi: startStation.id });

      // Check for battle after travel
      if (await checkBattleAfterCommand(ctx, tResp.notifications, "travel")) {
        ctx.log("combat", "Battle detected during startup travel - fleeing!");
        await ctx.sleep(5000);
        // Continue to main loop which will handle battle
      } else if (tResp.error && !tResp.error.message.includes("already")) {
        ctx.log("error", `Could not reach station: ${tResp.error.message}`);
      }
    }

    // Dock
    if (!bot.docked) {
      const dResp = await bot.exec("dock");

      // Check for battle after dock
      if (await checkBattleAfterCommand(ctx, dResp.notifications, "dock")) {
        ctx.log("combat", "Battle detected during startup dock - fleeing!");
        await ctx.sleep(5000);
        // Continue to main loop which will handle battle
      } else if (!dResp.error || dResp.error.message.includes("already")) {
        bot.docked = true;
      }
    }

    if (bot.docked) {
      // Collect gifted credits/items from storage
      await collectFromStorage(ctx);

      // Deposit non-fuel cargo
      yield "startup_deposit";
      const cargoResp = await bot.exec("get_cargo");
      if (cargoResp.result && typeof cargoResp.result === "object") {
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
          ctx.log("trade", `Depositing ${quantity}x ${displayName}...`);
          await bot.exec("deposit_items", { item_id: itemId, quantity });
          deposited += quantity;
        }
        if (deposited > 0) ctx.log("trade", `Deposited ${deposited} items to storage`);
      }

      // Load fuel cells to max cargo (explorer long-range mode)
      const startupSettings = getExplorerSettings(bot.username);
      if (startupSettings.loadFuelCellsAtHome) {
        yield "startup_load_fuel_cells";
        await loadFuelCellsToMax(ctx);
      }

      // Refuel
      yield "startup_refuel";
      await tryRefuel(ctx);
      await bot.refreshStatus();
      const startFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
      ctx.log("system", `Startup complete — Fuel: ${startFuel}% | Cargo: ${bot.cargo}/${bot.cargoMax}`);
    }
  } else {
    ctx.log("system", "No station in current system — skipping startup prep");
  }

  while (bot.state === "running") {
    // ── Death recovery ──
    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) { await ctx.sleep(30000); continue; }

    // ── Clean up expired temporary blacklists ──
    cleanupTemporaryBlacklist();

    // ── Battle check — check global WebSocket battle state first (works during 524 timeouts) ──
    if (bot.isInBattle()) {
      ctx.log("combat", "[WebSocket] Battle detected via WebSocket - fleeing immediately!");
      if (await checkAndFleeFromBattle(ctx, "explorer")) {
        await ctx.sleep(5000);
        continue;
      }
    }

    // ── Battle check — also check via API (fallback) ──
    if (await checkAndFleeFromBattle(ctx, "explorer")) {
      await ctx.sleep(5000);
      continue;
    }

    // ── Re-check mode after recovery — user might have changed it, or session was restarted ──
    const modeCheck = getExplorerSettings(bot.username);
    if (modeCheck.mode === "trade_update") {
      ctx.log("system", "Mode changed to trade_update — switching routines...");
      yield* tradeUpdateRoutine(ctx);
      return;
    }
    if (modeCheck.mode === "deep_core_scan") {
      ctx.log("system", "Mode changed to deep_core_scan — switching routines...");
      yield* deepCoreScanRoutine(ctx);
      return;
    }

    // ── Get current system data ──
    yield "scan_system";
    await bot.refreshStatus();
    const fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    ctx.log("info", `Exploring ${bot.system} — ${bot.credits} cr, ${fuelPct}% fuel, ${bot.cargo}/${bot.cargoMax} cargo`);

    let { pois, connections, systemId } = await getSystemInfo(ctx);
    if (!systemId) {
      ctx.log("error", "Could not determine current system — waiting 30s");
      await ctx.sleep(30000);
      continue;
    }
    visitedSystems.add(systemId);
    if (path.length === 0) {
      path.push(systemId); // Initialize path with starting system
    }

    // Try to capture security level
    await fetchSecurityLevel(ctx, systemId);

    // ── Proactive pirate stronghold proximity check ──
    // If within 3-4 jumps of a pirate stronghold, be EXTREMELY vigilant
    const proximityResult = await checkPirateStrongholdProximity(ctx, systemId, 4);
    if (proximityResult.nearStronghold) {
      ctx.log("combat", `[ALERT] Within ${proximityResult.jumpsToStronghold} jumps of pirate stronghold (${proximityResult.nearestStronghold})! Enhanced vigilance mode active.`);
      
      // Check nearby for pirates IMMEDIATELY
      yield "proximity_pirate_check";
      const nearbyResp = await bot.exec("get_nearby");
      
      // Check for battle after get_nearby
      if (await checkBattleAfterCommand(ctx, nearbyResp.notifications, "get_nearby")) {
        ctx.log("combat", "Battle detected during proximity check - fleeing immediately!");
        if (await checkAndFleeFromBattle(ctx, "explorer")) {
          await ctx.sleep(5000);
          continue;
        }
      }
      
      // Check for pirates in the area
      if (nearbyResp.result && typeof nearbyResp.result === "object") {
        const { parseNearbyForPirates } = await import("./common.js");
        const pirateResult = parseNearbyForPirates(nearbyResp.result);
        
        if (pirateResult.hasPirates) {
          ctx.log("combat", `[CRITICAL] Pirates detected near stronghold! ${pirateResult.pirateCount} pirate(s) spotted. Fleeing immediately!`);
          
          // Record pirate sighting with names
          await recordPirateSighting(ctx, systemId, pirateResult.pirates);

          // Add temporary blacklist for this system
          addTemporaryPirateBlacklist(systemId, 10); // 10 minutes

          // CRITICAL: Verify actual current system before fleeing
          // During cascade emergency jumps, lastSystem can get out of sync
          await bot.refreshStatus();
          const actualSystemId = bot.system;
          ctx.log("combat", `Verified actual position before flee: system=${actualSystemId}, lastSystem=${lastSystem}`);

          // Flee back the way we came using the path stack
          if (path.length > 1) {
            const fleeTarget = path[path.length - 2]; // The system before the current one
            const fleeTargetConnected = connections.some(c => c.id === fleeTarget);

            if (fleeTargetConnected) {
              ctx.log("combat", `Fleeing back to ${fleeTarget} (exact reverse path)...`);
              await ensureUndocked(ctx);
              const fleeJump = await bot.exec("jump", { target_system: fleeTarget });

              // Check for battle interrupt on flee jump
              if (fleeJump.error) {
                const fleeMsg = fleeJump.error.message.toLowerCase();
                if (fleeJump.error.code === "battle_interrupt" || fleeMsg.includes("interrupted by battle") || fleeMsg.includes("interrupted by combat")) {
                  ctx.log("combat", `Flee jump interrupted by battle! ${fleeJump.error.message} - using emergency flee!`);
                  const { emergencyFleeFromPirates } = await import("./common.js");
                  await emergencyFleeFromPirates(ctx, pirateResult);
                } else {
                  ctx.log("error", `Failed to flee to ${fleeTarget}: ${fleeJump.error.message}`);
                  // Try emergency flee if jump fails
                  const { emergencyFleeFromPirates } = await import("./common.js");
                  await emergencyFleeFromPirates(ctx, pirateResult);
                }
              } else {
                ctx.log("combat", `Successfully fled to ${fleeTarget}`);
                bot.stats.totalSystems++;
                // Update path: remove the current system from path since we fled from it
                path.pop();
                // Update lastSystem to the system we fled from (for avoidance logic)
                lastSystem = actualSystemId;
                // Continue to next iteration to rescan new system
                await ctx.sleep(5000);
                continue;
              }
            } else {
              ctx.log("error", `Flee target ${fleeTarget} is not connected to current system (${actualSystemId}) - using emergency flee.`);
              const { emergencyFleeFromPirates } = await import("./common.js");
              await emergencyFleeFromPirates(ctx, pirateResult);
            }
          } else {
            // No previous system in path - use emergency flee
            ctx.log("combat", "No previous system in path to flee to - using emergency flee");
            const { emergencyFleeFromPirates } = await import("./common.js");
            await emergencyFleeFromPirates(ctx, pirateResult);
          }
          
          await ctx.sleep(5000);
          continue;
        }
      }
    }

    // ── Survey the system to reveal hidden POIs ──
    // Only survey if scanPois is enabled
    const explorerSettings = getExplorerSettings(bot.username);

    if (explorerSettings.scanPois) {
      yield "survey_system";
      const surveyResp = await bot.exec("survey_system");

      // Check for battle after survey
      if (await checkBattleAfterCommand(ctx, surveyResp.notifications, "survey_system")) {
        ctx.log("combat", "Battle detected during survey - fleeing!");
        await ctx.sleep(5000);
        continue;
      }

      if (!surveyResp.error) {
        ctx.log("info", `Surveyed ${bot.system} — checking for newly revealed POIs...`);
        
        // Parse wormhole data from survey response if present
        const surveyResult = surveyResp.result as Record<string, unknown> | undefined;
        if (surveyResult && typeof surveyResult === "object") {
          const wormholeExit = surveyResult.poi as Record<string, unknown> | undefined;
          const wormholeDestination = surveyResult.wormhole_destination as string | undefined;
          const wormholeDestinationId = surveyResult.wormhole_destination_id as string | undefined;
          const wormholeExpiresIn = surveyResult.wormhole_expires_in as string | undefined;

          if (wormholeExit && wormholeExit.type === "wormhole_exit" && wormholeDestinationId) {
            ctx.log("info", `🌌 Wormhole detected: ${wormholeExit.name} -> ${wormholeDestination}`);
            
            // Register wormhole in mapStore
            mapStore.registerWormhole(systemId, {
              id: wormholeExit.id as string,
              name: wormholeExit.name as string,
              exit_system_id: systemId,
              exit_system_name: bot.system || systemId,
              exit_poi_id: wormholeExit.id as string,
              exit_poi_name: wormholeExit.name as string,
              destination_system_id: wormholeDestinationId,
              destination_system_name: wormholeDestination || wormholeDestinationId,
              expires_in_text: wormholeExpiresIn,
            });
            
            ctx.log("info", `🌌 Wormhole registered: ${wormholeExit.name} -> ${wormholeDestination}${wormholeExpiresIn ? ` (expires in ${wormholeExpiresIn})` : ""}`);
          }
        }
        
        // Re-fetch system info to pick up any hidden POIs that were revealed
        const refreshed = await getSystemInfo(ctx);
        if (refreshed.pois.length > pois.length) {
          ctx.log("info", `Survey revealed ${refreshed.pois.length - pois.length} new POI(s)!`);
        }
        pois = refreshed.pois;
        connections = refreshed.connections;
      } else {
        const msg = surveyResp.error.message.toLowerCase();
        // Don't log for expected errors like "already surveyed" or skill-related
        if (!msg.includes("already") && !msg.includes("cooldown")) {
          ctx.log("info", `Survey: ${surveyResp.error.message}`);
        }
      }
    }

    // ── Classify POIs and determine what needs visiting ──
    const toVisit: Array<{ poi: SystemPOI; reason: string }> = [];
    let skippedCount = 0;

    for (const poi of pois) {
      const isStation = isStationPoi(poi);
      const isMinable = isMinablePoi(poi.type);
      const isScenic = isScenicPoi(poi.type);
      const minutesAgo = mapStore.minutesSinceExplored(systemId, poi.id);

      if (isStation) {
        if (minutesAgo < STATION_REFRESH_MINS) { skippedCount++; continue; }
        toVisit.push({ poi, reason: minutesAgo === Infinity ? "new" : "refresh" });
      } else if (isMinable) {
        // Check if this POI has new-style resource scan data
        const storedPoi = mapStore.getSystem(systemId)?.pois.find(p => p.id === poi.id);
        const hasResourceData = (storedPoi?.resources?.length ?? 0) > 0;

        // In quick survey mode, skip resource POIs that already have scan data
        if (explorerSettings.surveyMode === "quick" && hasResourceData) {
          if (minutesAgo < RESOURCE_REFRESH_MINS) { skippedCount++; continue; }
        }

        // Always re-scan if no resource data (old-style explored, needs new scan)
        if (!hasResourceData) {
          toVisit.push({ poi, reason: "needs-resource-scan" });
        } else if (minutesAgo < RESOURCE_REFRESH_MINS) {
          skippedCount++; continue;
        } else {
          toVisit.push({ poi, reason: "refresh" });
        }
      } else if (isScenic) {
        // In quick survey mode, skip scenic POIs entirely
        if (explorerSettings.surveyMode === "quick") { skippedCount++; continue; }
        if (minutesAgo < Infinity) { skippedCount++; continue; }
        toVisit.push({ poi, reason: "new" });
      } else {
        // In quick survey mode, skip other POIs
        if (explorerSettings.surveyMode === "quick") { skippedCount++; continue; }
        if (minutesAgo < RESOURCE_REFRESH_MINS) { skippedCount++; continue; }
        toVisit.push({ poi, reason: minutesAgo === Infinity ? "new" : "refresh" });
      }
    }

    if (toVisit.length === 0) {
      ctx.log("info", `${bot.system}: all ${skippedCount} POIs up to date — moving on`);
    } else {
      ctx.log("info", `${bot.system}: ${toVisit.length} to visit, ${skippedCount} already explored`);
    }

    // ── Hull check — repair if <= 40% ──
    await bot.refreshStatus();
    const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    if (hullPct <= 40) {
      ctx.log("system", `Hull critical (${hullPct}%) — finding station for repair`);
      const docked = await ensureDocked(ctx);
      if (docked) {
        await repairShip(ctx);
      }
    }

    // ── Ensure fueled before exploring ──
    yield "fuel_check";
    const fueled = await ensureFueled(ctx, FUEL_SAFETY_PCT);
    if (!fueled) {
      ctx.log("error", "Could not refuel — waiting 30s before retry...");
      await ctx.sleep(30000);
      continue;
    }

    // If hull repair or refueling moved us to a different system, restart the loop
    await bot.refreshStatus();
    if (bot.system !== systemId) {
      ctx.log("info", `Moved to ${bot.system} during repair/refuel — restarting system scan`);
      continue;
    }

    // ── Undock if docked ──
    await ensureUndocked(ctx);

    // Find station for emergency refueling
    const station = findStation(pois);

    // ── Visit each POI ──
    for (const { poi, reason } of toVisit) {
      if (bot.state !== "running") break;

      const isMinable = isMinablePoi(poi.type);
      const isStation = isStationPoi(poi);

      // Check fuel before traveling to each POI
      yield "fuel_check";
      const poiFueled = await ensureFueled(ctx, FUEL_SAFETY_PCT);
      if (!poiFueled) {
        ctx.log("error", "Could not refuel — restarting system loop...");
        break;
      }
      // If refueling moved us to a different system, break out to restart
      await bot.refreshStatus();
      if (bot.system !== systemId) {
        ctx.log("info", `Moved to ${bot.system} during refuel — restarting system scan`);
        break;
      }
      await ensureUndocked(ctx);

      yield `visit_${poi.id}`;
      const travelResp = await bot.exec("travel", { target_poi: poi.id });

      // Check for battle after travel
      if (await checkBattleAfterCommand(ctx, travelResp.notifications, "travel")) {
        ctx.log("combat", "Battle detected during travel - fleeing!");
        await ctx.sleep(5000);
        continue;
      }

      if (travelResp.error && !travelResp.error.message.includes("already")) {
        ctx.log("error", `Travel to ${poi.name} failed: ${travelResp.error.message}`);
        continue;
      }
      bot.poi = poi.id;

      // Scavenge wrecks/containers at each POI (only if enabled — unsafe near pirates)
      if (explorerSettings.scavengeEnabled) {
        yield "scavenge";
        const scavengeResult = await scavengeWrecks(ctx);

        // Check battle status after scavenge (it makes multiple commands)
        if (await checkAndFleeFromBattle(ctx, "scavenge")) {
          await ctx.sleep(5000);
          continue;
        }
      }

      if (isMinable) {
        yield* scanResourcePoi(ctx, systemId, poi);
      } else if (isStation) {
        yield* scanStation(ctx, systemId, poi);
      } else {
        yield* visitOtherPoi(ctx, systemId, poi, fledFromSystems);
      }

      // ── Check cargo — if full with non-fuel-cell items, return to Sol Central to deposit ──
      await bot.refreshStatus();
      if (bot.cargoMax > 0 && bot.cargo >= bot.cargoMax) {
        // Check if cargo is full of only fuel cells (intentional for exploration)
        const cargoResp = await bot.exec("get_cargo");
        let isOnlyFuelCells = true;
        let fuelCellCount = 0;
        if (cargoResp.result && typeof cargoResp.result === "object") {
          const cResult = cargoResp.result as Record<string, unknown>;
          const cargoItems = (
            Array.isArray(cResult) ? cResult :
            Array.isArray(cResult.items) ? (cResult.items as Array<Record<string, unknown>>) :
            Array.isArray(cResult.cargo) ? (cResult.cargo as Array<Record<string, unknown>>) :
            []
          );
          for (const item of cargoItems) {
            const itemId = (item.item_id as string) || "";
            const quantity = (item.quantity as number) || 0;
            if (!itemId.toLowerCase().includes("fuel_cell")) {
              isOnlyFuelCells = false;
              break;
            }
            fuelCellCount += quantity;
          }
        }

        if (!isOnlyFuelCells) {
          yield "deposit_cargo";
          await depositCargoAtHome(ctx, { fuelThresholdPct: FUEL_SAFETY_PCT, hullThresholdPct: 30 });
          // After depositing, we're likely in Sol — break to restart system scan
          await bot.refreshStatus();
          if (bot.system !== systemId) {
            ctx.log("info", `Moved to ${bot.system} after deposit — restarting system scan`);
            break;
          }
        } else {
          ctx.log("info", `Cargo full with fuel cells (${fuelCellCount} fuel cells, ${bot.cargo}/${bot.cargoMax} cargo) — continuing exploration`);
        }
      }
    }

    if (bot.state !== "running") break;

    // ── Check skills for level-ups ──
    yield "check_skills";
    await bot.checkSkills();

    // ── Re-get settings in case they changed ──
    const currentSettings = getExplorerSettings(bot.username);

    // ── Check fuel cell depletion — return to home base if enabled and no fuel cells left ──
    if (currentSettings.returnToHomeOnFuelCellDepletion) {
      const fuelCellCheck = await checkFuelCellInventory(ctx);
      // Only return if we previously had fuel cells (cargo was full with them) but now they're gone
      // This prevents unnecessary trips when we never loaded fuel cells in the first place
      if (fuelCellCheck.totalFuelCells === 0) {
        ctx.log("system", `Fuel cells depleted (0 remaining) — returning to home base to reload`);
        yield "return_to_home_fuel_cells";
        const returned = await returnToHomeBaseForFuelCells(ctx);
        if (returned) {
          // After returning, restart the loop to continue exploration
          await bot.refreshStatus();
          ctx.log("info", `Returned to home base — continuing exploration`);
          continue;
        }
      }
    }

    // ── Pick next system to explore ──
    yield "pick_next_system";

    // ── Direct to Unknown mode: jump directly to nearest unknown or stale system ──
    if (currentSettings.directToUnknown) {
      const blacklist = getSystemBlacklist();
      const unknowns = findUnknownSystems(ctx, systemId, blacklist, fledFromSystems);

      if (unknowns.length > 0) {
        // Pick the nearest high-priority target (unknown first, then stale)
        const target = unknowns[0];
        const priorityLabel = target.priority === "unknown" ? "unknown" : "stale";
        const staleInfo = target.priority === "stale" && target.oldestPoiUpdate
          ? ` (oldest data: ${timeAgoFromIso(target.oldestPoiUpdate)})`
          : "";
        ctx.log("exploration", `Direct-to-${priorityLabel}: Found ${unknowns.length} system(s) needing exploration, targeting nearest: ${target.name} (${target.distance} jumps)${staleInfo}`);
        
        // Load fuel cells if cargo space available
        if (bot.cargoMax > 0 && bot.cargo < bot.cargoMax) {
          yield "load_fuel_cells";
          const stationForFuel = findStation(pois);
          if (stationForFuel) {
            // Travel to station if not already there
            if (bot.poi !== stationForFuel.id) {
              await ensureUndocked(ctx);
              const tResp = await bot.exec("travel", { target_poi: stationForFuel.id });
              if (!tResp.error || tResp.error.message.includes("already")) {
                bot.poi = stationForFuel.id;
              }
            }
            await loadFuelCells(ctx);
          }
        }
        
        // Ensure fuel before jumping
        yield "pre_jump_fuel";
        const directFueled = await ensureFueled(ctx, currentSettings.refuelThreshold);
        if (!directFueled) {
          ctx.log("error", "Could not refuel for direct jump — waiting 30s...");
          await ctx.sleep(30000);
          continue;
        }
        
        // If grouping is enabled, find nearby unknowns to visit after the target
        let nearbyUnknowns: string[] = [];
        if (currentSettings.groupUnknowns) {
          nearbyUnknowns = findNearbyUnknowns(ctx, target.id, 2, blacklist, fledFromSystems);
          if (nearbyUnknowns.length > 0) {
            ctx.log("exploration", `Grouping enabled: ${nearbyUnknowns.length} additional unknown(s) near ${target.name}`);
          }
        }

        // Navigate to target system via connected jumps (not a single direct jump)
        await ensureUndocked(ctx);
        ctx.log("travel", `Navigating to ${target.priority === "unknown" ? "unknown" : "stale"} system: ${target.name || target.id} (${target.distance} jumps via route)...`);
        const arrived = await navigateToSystem(ctx, target.id, { fuelThresholdPct: currentSettings.refuelThreshold, hullThresholdPct: 30 });
        if (!arrived) {
          ctx.log("error", `Could not reach ${target.name || target.id} — will retry next loop`);
          await ctx.sleep(10000);
          continue;
        }

        ctx.log("travel", `Arrived at ${target.name || target.id}`);
        bot.stats.totalSystems++;
        path.push(target.id); // Track the arrived system in path
        await checkCustomsInspection(ctx, systemId);

        // Check for pirates and battle
        const nearbyResp = await bot.exec("get_nearby");
        if (await checkBattleAfterCommand(ctx, nearbyResp.notifications, "get_nearby")) {
          ctx.log("error", "Battle detected after arrival - fleeing!");
          await ctx.sleep(30000);
          continue;
        }
        if (nearbyResp.result && typeof nearbyResp.result === "object") {
          const fled = await checkAndFleeFromPirates(ctx, nearbyResp.result);
          if (fled) {
            ctx.log("error", "Pirates detected - fled, will retry");
            fledFromSystems.add(systemId);
            await ctx.sleep(30000);
            continue;
          }
        }
        lastSystem = systemId;
        continue;
      } else {
        ctx.log("info", "Direct-to-Unknown: No unknown systems found — using normal exploration");
      }
    }

    // ALWAYS ensure fueled before jumping — will navigate to nearest station if needed
    yield "pre_jump_fuel";
    const jumpFueled = await ensureFueled(ctx, currentSettings.refuelThreshold);
    if (!jumpFueled) {
      ctx.log("error", "Could not refuel before jump — waiting 30s...");
      await ctx.sleep(30000);
      continue;
    }

    const validConns = connections.filter(c => c.id);
    const nextSystem = pickNextSystem(validConns, visitedSystems, lastSystem, fledFromSystems);
    if (!nextSystem) {
      ctx.log("info", "All connected systems explored! Picking a random connection...");
      if (validConns.length > 0) {
        // Ensure fuel before random jump
        const rndFueled = await ensureFueled(ctx, currentSettings.refuelThreshold);
        if (!rndFueled) {
          ctx.log("error", "Cannot refuel for random jump — waiting 30s...");
          await ctx.sleep(30000);
          continue;
        }
        // Smart selection: avoid dead-ends and pirate systems
        const random = pickSmartConnection(ctx, validConns, lastSystem, visitedSystems, fledFromSystems);
        await ensureUndocked(ctx);
        ctx.log("travel", `Jumping to ${random.name || random.id}...`);
        const jumpResp = await bot.exec("jump", { target_system: random.id });
        if (jumpResp.error) {
          const msg = jumpResp.error.message.toLowerCase();
          // CRITICAL: Check for battle interrupt error
          if (jumpResp.error.code === "battle_interrupt" || msg.includes("interrupted by battle") || msg.includes("interrupted by combat")) {
            ctx.log("combat", `Jump interrupted by battle! ${jumpResp.error.message} - fleeing!`);
            await fleeFromBattle(ctx);
            await ctx.sleep(5000);
            continue;
          }
          // Check if we're in battle - need to flee immediately
          if (msg.includes("battle") || msg.includes("in battle")) {
            ctx.log("combat", "Cannot jump - in battle! Attempting to flee...");
            const fled = await fleeFromBattle(ctx);
            if (!fled) {
              ctx.log("error", "Flee command failed - battle engagement active");
            }
            await ctx.sleep(5000);
            continue;
          }
          ctx.log("error", `Jump failed: ${jumpResp.error.message}`);
          await ctx.sleep(10000);
          continue;
        }
        ctx.log("travel", `Jumped to ${random.name || random.id}`);
        bot.stats.totalSystems++;
        path.push(random.id); // Track the new system in path
        await checkCustomsInspection(ctx, systemId);
        // Check for pirates
        const nearbyResp = await bot.exec("get_nearby");
        if (nearbyResp.result && typeof nearbyResp.result === "object") {
          const fled = await checkAndFleeFromPirates(ctx, nearbyResp.result);
          if (fled) {
            ctx.log("error", "Pirates detected - fled, will retry");
            fledFromSystems.add(systemId); // Mark this system as hostile
            await ctx.sleep(30000);
            continue;
          }
        }
        lastSystem = systemId;
        continue;
      } else {
        ctx.log("error", "No connections from this system — stuck! Waiting 60s...");
        await ctx.sleep(60000);
      }
      continue;
    }

    // Final fuel verify before jumping
    await bot.refreshStatus();
    const preJumpFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    if (preJumpFuel < 25) {
      ctx.log("system", `Fuel too low for jump (${preJumpFuel}%) — refueling first...`);
      const jf = await ensureFueled(ctx, currentSettings.refuelThreshold);
      if (!jf) {
        ctx.log("error", "Cannot refuel — waiting 30s...");
        await ctx.sleep(30000);
        continue;
      }
    }

    await ensureUndocked(ctx);
    ctx.log("travel", `Jumping to ${nextSystem.name || nextSystem.id}...`);
    const jumpResp = await bot.exec("jump", { target_system: nextSystem.id });
    if (jumpResp.error) {
      const msg = jumpResp.error.message.toLowerCase();
      // CRITICAL: Check for battle interrupt error
      if (jumpResp.error.code === "battle_interrupt" || msg.includes("interrupted by battle") || msg.includes("interrupted by combat")) {
        ctx.log("combat", `Jump interrupted by battle! ${jumpResp.error.message} - fleeing!`);
        await fleeFromBattle(ctx);
        await ctx.sleep(5000);
        continue;
      }
      // Check if we're in battle - need to flee immediately
      if (msg.includes("battle") || msg.includes("in battle")) {
        ctx.log("combat", "Cannot jump - in battle! Attempting to flee...");
        const fled = await fleeFromBattle(ctx);
        if (!fled) {
          ctx.log("error", "Flee command failed - battle engagement active");
        }
        await ctx.sleep(5000);
        continue;
      }
      if (msg.includes("fuel")) {
        ctx.log("error", "Insufficient fuel for jump — will refuel next loop");
      } else {
        ctx.log("error", `Jump failed: ${jumpResp.error.message}`);
      }
      await ctx.sleep(10000);
      continue;
    }

    ctx.log("travel", `Jumped to ${nextSystem.name || nextSystem.id}`);
    bot.stats.totalSystems++;
    path.push(nextSystem.id); // Track the new system in path

    // Check for customs inspection after jump
    await checkCustomsInspection(ctx, systemId);
    // Check for pirates
    const nearbyResp = await bot.exec("get_nearby");
    if (nearbyResp.result && typeof nearbyResp.result === "object") {
      const fled = await checkAndFleeFromPirates(ctx, nearbyResp.result);
      if (fled) {
        ctx.log("error", "Pirates detected - fled, will retry");
        fledFromSystems.add(systemId); // Mark this system as hostile
        await ctx.sleep(30000);
        continue;
      }
    }

    lastSystem = systemId;
  }
};

// ── POI visit sub-routines ───────────────────────────────────

/** Scan a resource POI using get_poi to discover resources without mining. */
async function* scanResourcePoi(
  ctx: RoutineContext,
  systemId: string,
  poi: SystemPOI,
): AsyncGenerator<string, void, void> {
  const { bot } = ctx;
  yield `scan_${poi.id}`;

  // Call get_poi to get resource information
  const poiResp = await bot.exec("get_poi", { poi_id: poi.id });

  // Check for battle after get_poi
  if (await checkBattleAfterCommand(ctx, poiResp.notifications, "get_poi")) {
    ctx.log("combat", "Battle detected at POI scan - fleeing!");
    await ctx.sleep(5000);
    return;
  }

  if (poiResp.error) {
    ctx.log("error", `get_poi failed for ${poi.name}: ${poiResp.error.message}`);
    mapStore.markExplored(systemId, poi.id);
    return;
  }

  // Parse resource data from response
  const result = poiResp.result as Record<string, unknown>;
  const poiData = result?.poi as Record<string, unknown> | undefined;
  const resources = (
    Array.isArray(result?.resources) ? result.resources :
    Array.isArray(poiData?.resources) ? poiData.resources :
    []
  ) as Array<Record<string, unknown>>;

  // Register/update the POI in mapstore with full data from get_poi
  // This captures hidden POIs that aren't in get_system response
  if (poiData) {
    const resourceData = resources.map((r) => ({
      resource_id: (r.resource_id as string) || "",
      name: (r.name as string) || (r.resource_id as string) || "",
      richness: (r.richness as number) || 0,
      remaining: (r.remaining as number) || 0,
      max_remaining: (r.max_remaining as number) || 0,
      depletion_percent: (r.depletion_percent as number) || 100,
    }));

    mapStore.registerPoiFromScan(systemId, {
      id: (poiData.id as string) || poi.id,
      name: (poiData.name as string) || poi.name,
      type: (poiData.type as string) || poi.type,
      hidden: poiData.hidden as boolean | undefined,
      reveal_difficulty: poiData.reveal_difficulty as number | undefined,
      resources: resourceData.length > 0 ? resourceData : undefined,
    });

    // Log discovered resources
    if (resourceData.length > 0) {
      const resourceNames = resourceData.map(r => r.name).join(", ");
      const hiddenTag = poiData.hidden ? " [HIDDEN]" : "";
      ctx.log("exploration", `Scanned${hiddenTag} ${poi.name}: ${resourceNames}`);
    } else {
      const hiddenTag = poiData.hidden ? " [HIDDEN]" : "";
      ctx.log("info", `Scanned${hiddenTag} ${poi.name}: no resources found`);
    }
  } else if (resources.length > 0) {
    // Fallback if poi object not present but resources are
    const resourceData = resources.map((r) => ({
      resource_id: (r.resource_id as string) || "",
      name: (r.name as string) || (r.resource_id as string) || "",
      richness: (r.richness as number) || 0,
      remaining: (r.remaining as number) || 0,
      max_remaining: (r.max_remaining as number) || 0,
      depletion_percent: (r.depletion_percent as number) || 100,
    }));

    // Store resource data in map
    mapStore.updatePoiResources(systemId, poi.id, resourceData);

    // Log discovered resources
    const resourceNames = resourceData.map(r => r.name).join(", ");
    ctx.log("exploration", `Scanned ${poi.name}: ${resourceNames}`);
  } else {
    ctx.log("info", `Scanned ${poi.name}: no resources found`);
  }

  mapStore.markExplored(systemId, poi.id);
}

/** Dock at station, scan market/orders/missions, refuel. */
async function* scanStation(
  ctx: RoutineContext,
  systemId: string,
  poi: SystemPOI,
): AsyncGenerator<string, void, void> {
  const { bot } = ctx;

  yield `dock_${poi.id}`;
  const dockResp = await bot.exec("dock");

  // Check for battle after dock (unlikely at station, but possible if interrupted)
  if (await checkBattleAfterCommand(ctx, dockResp.notifications, "dock")) {
    ctx.log("combat", "Battle detected during docking - fleeing!");
    await ctx.sleep(3000);
    return;
  }

  if (dockResp.error && !dockResp.error.message.includes("already")) {
    ctx.log("error", `Dock failed at ${poi.name}: ${dockResp.error.message}`);
    return;
  }
  bot.docked = true;

  await collectFromStorage(ctx);

  // Complete active missions (while cargo still intact from exploration)
  const stationSettings = getExplorerSettings(bot.username);
  if (stationSettings.acceptMissions) {
    yield `complete_missions_${poi.id}`;
    await completeActiveMissions(ctx);
  }

  // Scan market, orders, missions — collect stats for summary
  yield `scan_${poi.id}`;
  let marketCount = 0;
  let missionCount = 0;

  const marketResp = await bot.exec("view_market");

  // Check for battle after view_market
  if (await checkBattleAfterCommand(ctx, marketResp.notifications, "view_market")) {
    ctx.log("combat", "Battle detected during market scan - fleeing!");
    await ctx.sleep(5000);
    return;
  }

  if (marketResp.result && typeof marketResp.result === "object") {
    mapStore.updateMarket(systemId, poi.id, marketResp.result as Record<string, unknown>);
    const result = marketResp.result as Record<string, unknown>;
    const items = (
      Array.isArray(result) ? result :
      Array.isArray(result.items) ? result.items :
      Array.isArray(result.market) ? result.market :
      []
    ) as Array<Record<string, unknown>>;
    marketCount = items.length;

    // Extract detailed order book data from view_market response and save to marketDetails.json
    if (items.length > 0) {
      const marketDetails = loadMarketDetails();
      let detailsUpdated = false;

      ctx.log("info", `Saving detailed market data for ${items.length} items...`);

      for (const item of items) {
        const itemId = (item.item_id as string) || (item.id as string) || "";
        const itemName = (item.name as string) || (item.item_name as string) || itemId;

        if (!itemId) continue;

        const buyOrders = ((item.buy_orders as Array<Record<string, unknown>>) || []).map(order => ({
          price: (order.price_each as number) || (order.price as number) || 0,
          quantity: (order.quantity as number) || 0,
        })).filter(order => order.price > 0 && order.quantity > 0);

        const sellOrders = ((item.sell_orders as Array<Record<string, unknown>>) || []).map(order => ({
          price: (order.price_each as number) || (order.price as number) || 0,
          quantity: (order.quantity as number) || 0,
        })).filter(order => order.price > 0 && order.quantity > 0);

        // Update or add to market details
        const existingIndex = marketDetails.items.findIndex(
          m => m.systemId === systemId && m.stationPoiId === poi.id && m.itemId === itemId
        );

        const marketItemDetail: MarketItemDetails = {
          systemId,
          stationPoiId: poi.id,
          stationName: poi.name,
          itemId,
          itemName,
          buyOrders,
          sellOrders,
          lastUpdated: now(),
        };

        if (existingIndex >= 0) {
          marketDetails.items[existingIndex] = marketItemDetail;
        } else {
          marketDetails.items.push(marketItemDetail);
        }

        detailsUpdated = true;
      }

      if (detailsUpdated) {
        saveMarketDetails(marketDetails);
        ctx.log("info", `Saved detailed market data for ${items.length} items to marketDetails.json`);
      }
    }
  }

  const missionsResp = await bot.exec("get_missions");

  // Check for battle after get_missions
  if (await checkBattleAfterCommand(ctx, missionsResp.notifications, "get_missions")) {
    ctx.log("combat", "Battle detected during mission scan - fleeing!");
    await ctx.sleep(5000);
    return;
  }

  if (missionsResp.result && typeof missionsResp.result === "object") {
    const mData = missionsResp.result as Record<string, unknown>;
    const missions = (
      Array.isArray(mData) ? mData :
      Array.isArray(mData.missions) ? mData.missions :
      Array.isArray(mData.available) ? mData.available :
      Array.isArray(mData.available_missions) ? mData.available_missions :
      []
    ) as Array<Record<string, unknown>>;
    if (missions.length > 0) {
      mapStore.updateMissions(systemId, poi.id, missions);
      missionCount = missions.length;
    }
  }

  // Station scan summary
  const scanParts: string[] = [];
  if (marketCount > 0) scanParts.push(`${marketCount} market items`);
  if (missionCount > 0) scanParts.push(`${missionCount} missions`);
  ctx.log("info", `Scanned ${poi.name}: ${scanParts.length > 0 ? scanParts.join(", ") : "empty station"}`);

  // Refuel
  yield `refuel_${poi.id}`;
  await bot.refreshStatus();
  const stationFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
  if (stationFuel < 90) {
    await tryRefuel(ctx);
  }

  // Deposit non-fuel cargo to station storage
  yield `deposit_${poi.id}`;
  const depositedItems: string[] = [];
  const cargoResp = await bot.exec("get_cargo");
  if (cargoResp.result && typeof cargoResp.result === "object") {
    const cResult = cargoResp.result as Record<string, unknown>;
    const cargoItems = (
      Array.isArray(cResult) ? cResult :
      Array.isArray(cResult.items) ? cResult.items :
      Array.isArray(cResult.cargo) ? cResult.cargo :
      []
    ) as Array<Record<string, unknown>>;

    for (const item of cargoItems) {
      const itemId = (item.item_id as string) || "";
      const quantity = (item.quantity as number) || 0;
      if (!itemId || quantity <= 0) continue;
      const lower = itemId.toLowerCase();
      if (lower.includes("fuel") || lower.includes("energy_cell")) continue;

      const displayName = (item.name as string) || itemId;
      await bot.exec("deposit_items", { item_id: itemId, quantity });
      depositedItems.push(`${quantity}x ${displayName}`);
      yield "depositing";
    }
  }
  if (depositedItems.length > 0) {
    ctx.log("trade", `Deposited ${depositedItems.join(", ")} to storage`);
  }

  // Accept new exploration missions before leaving
  if (stationSettings.acceptMissions) {
    yield `accept_missions_${poi.id}`;
    await checkAndAcceptMissions(ctx);
  }

  // Undock
  yield `undock_${poi.id}`;
  const undockResp = await bot.exec("undock");

  // Check for battle after undock
  if (await checkBattleAfterCommand(ctx, undockResp.notifications, "undock")) {
    ctx.log("combat", "Battle detected during undock - fleeing!");
    await ctx.sleep(5000);
    return;
  }

  bot.docked = false;

  mapStore.markExplored(systemId, poi.id);
}

/** Visit a non-minable, non-station POI — check what's nearby. */
async function* visitOtherPoi(
  ctx: RoutineContext,
  systemId: string,
  poi: SystemPOI,
  fledFromSystems: Set<string>,
): AsyncGenerator<string, void, void> {
  const { bot } = ctx;

  yield `scan_${poi.id}`;
  const nearbyResp = await bot.exec("get_nearby");

  // Check for battle notifications first
  if (await checkBattleAfterCommand(ctx, nearbyResp.notifications, "get_nearby")) {
    ctx.log("combat", "Battle detected at POI - fleeing!");
    await ctx.sleep(5000);
    return;
  }

  if (nearbyResp.result && typeof nearbyResp.result === "object") {
    const nr = nearbyResp.result as Record<string, unknown>;
    const objects = (nr.objects || nr.results || nr.ships || nr.players || []) as unknown[];
    if (objects.length > 0) {
      ctx.log("info", `Visited ${poi.name}: ${objects.length} objects nearby`);
    }

    // Track player names from nearby scan
    bot.trackNearbyPlayers(nearbyResp.result);

    // Check for pirates and flee if detected
    const { checkAndFleeFromPirates } = await import("./common.js");
    const fled = await checkAndFleeFromPirates(ctx, nearbyResp.result);
    if (fled) {
      // We've fled - mark this system as hostile and abort this POI scan
      fledFromSystems.add(systemId);
      mapStore.markExplored(systemId, poi.id);
      return;
    }
  }

  mapStore.markExplored(systemId, poi.id);
}

// ── Deep Core Scan routine ───────────────────────────────────

/**
 * Deep core scan mode — visits known hidden POIs to refresh their resource data.
 * Requires deep core survey scanner module to access hidden POIs.
 * Focuses on re-scanning hidden POIs that contain valuable deep core ores.
 */
async function* deepCoreScanRoutine(ctx: RoutineContext): AsyncGenerator<string, void, void> {
  const { bot } = ctx;
  const visitedHiddenPois = new Set<string>(); // Track visited hidden POIs this cycle
  const path: string[] = []; // Track the path of systems visited
  let lastSystem: string | null = null;

  // ── Check for deep core survey scanner ──
  const scannerCap = await hasDeepCoreSurveyScanner(ctx);
  if (!scannerCap) {
    ctx.log("error", "Deep core scan mode requires a deep core survey scanner module!");
    ctx.log("error", "Please equip a deep core survey scanner and try again.");
    await ctx.sleep(30000);
    return;
  }

  ctx.log("system", "Deep Core Scan mode — refreshing known hidden POIs...");

  // Initialize path with current system
  await bot.refreshStatus();
  if (path.length === 0 && bot.system) {
    path.push(bot.system);
  }

  // ── Startup: dock at local station to clear cargo & refuel ──
  yield "startup_prep";
  await bot.refreshStatus();
  const { pois: startPois } = await getSystemInfo(ctx);
  const startStation = findStation(startPois);
  if (startStation) {
    ctx.log("system", `Startup: docking at ${startStation.name} to clear cargo & refuel...`);

    if (bot.poi !== startStation.id) {
      await ensureUndocked(ctx);
      const tResp = await bot.exec("travel", { target_poi: startStation.id });
      if (tResp.error && !tResp.error.message.includes("already")) {
        ctx.log("error", `Could not reach station: ${tResp.error.message}`);
      }
    }

    if (!bot.docked) {
      const dResp = await bot.exec("dock");
      if (!dResp.error || dResp.error.message.includes("already")) {
        bot.docked = true;
      }
    }

    if (bot.docked) {
      await collectFromStorage(ctx);
      yield "startup_refuel";
      await tryRefuel(ctx);
      await bot.refreshStatus();
      const startFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
      ctx.log("system", `Startup complete — Fuel: ${startFuel}% | Cargo: ${bot.cargo}/${bot.cargoMax}`);
    }
  }

  while (bot.state === "running") {
    // ── Death recovery ──
    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) { await ctx.sleep(30000); continue; }

    // ── Battle check ──
    if (bot.isInBattle()) {
      ctx.log("combat", "[WebSocket] Battle detected via WebSocket - fleeing immediately!");
      if (await checkAndFleeFromBattle(ctx, "deep_core_scan")) {
        await ctx.sleep(5000);
        continue;
      }
    }

    if (await checkAndFleeFromBattle(ctx, "deep_core_scan")) {
      await ctx.sleep(5000);
      continue;
    }

    // ── Re-check mode after recovery ──
    const modeCheck = getExplorerSettings(bot.username);
    if (modeCheck.mode !== "deep_core_scan") {
      ctx.log("system", `Mode changed to ${modeCheck.mode} — switching routines...`);
      if (modeCheck.mode === "trade_update") {
        yield* tradeUpdateRoutine(ctx);
      }
      return;
    }

    // ── Find hidden POIs that need scanning ──
    yield "find_hidden_pois";
    const hiddenPois = findHiddenPoisToScan(ctx);

    if (hiddenPois.length === 0) {
      ctx.log("info", "No hidden POIs found to scan — run explorer mode first to discover them!");
      await ctx.sleep(30000);
      continue;
    }

    ctx.log("info", `Found ${hiddenPois.length} hidden POI(s) to scan`);

    // ── Visit each hidden POI ──
    for (const hiddenPoi of hiddenPois) {
      if (bot.state !== "running") break;

      // ── Navigate to target system if needed ──
      yield "fuel_check";
      const fueled = await ensureFueled(ctx, FUEL_SAFETY_PCT);
      if (!fueled) {
        ctx.log("error", "Cannot refuel — waiting 30s...");
        await ctx.sleep(30000);
        continue;
      }

      if (hiddenPoi.systemId !== bot.system) {
        yield "navigate";
        await ensureUndocked(ctx);
        const blacklist = getSystemBlacklist();
        // Skip blacklisted systems (persistent + temporary)
        if (blacklist.some(b => b.toLowerCase() === hiddenPoi.systemId.toLowerCase()) || isTemporarilyBlacklisted(hiddenPoi.systemId)) {
          ctx.log("info", `Skipping blacklisted system: ${hiddenPoi.systemName}`);
          continue;
        }
        const arrived = await navigateToSystem(ctx, hiddenPoi.systemId, { fuelThresholdPct: FUEL_SAFETY_PCT, hullThresholdPct: 30 });
        if (!arrived) {
          ctx.log("error", `Could not reach ${hiddenPoi.systemName} — skipping POI`);
          continue;
        }
        path.push(hiddenPoi.systemId); // Track the arrived system in path
        lastSystem = bot.system;
      }

      if (bot.state !== "running") break;

      // ── Survey system to reveal hidden POIs ──
      yield "survey_system";
      const surveyResp = await bot.exec("survey_system");

      if (await checkBattleAfterCommand(ctx, surveyResp.notifications, "survey_system")) {
        ctx.log("combat", "Battle detected during survey - fleeing!");
        await ctx.sleep(5000);
        continue;
      }

      if (!surveyResp.error) {
        ctx.log("info", `Surveyed ${bot.system} — hidden POIs should now be accessible`);
      } else {
        const msg = surveyResp.error.message.toLowerCase();
        if (!msg.includes("already") && !msg.includes("cooldown")) {
          ctx.log("info", `Survey: ${surveyResp.error.message}`);
        }
      }

      // ── Travel to hidden POI ──
      yield "travel_to_poi";
      await ensureUndocked(ctx);
      const tResp = await bot.exec("travel", { target_poi: hiddenPoi.poiId });

      if (await checkBattleAfterCommand(ctx, tResp.notifications, "travel")) {
        ctx.log("combat", "Battle detected during travel - fleeing!");
        await ctx.sleep(5000);
        continue;
      }

      if (tResp.error) {
        const errMsg = tResp.error.message.toLowerCase();
        // CRITICAL: Check for battle interrupt error
        if (tResp.error.code === "battle_interrupt" || errMsg.includes("interrupted by battle") || errMsg.includes("interrupted by combat")) {
          ctx.log("combat", `Travel to hidden POI interrupted by battle! ${tResp.error.message} - fleeing!`);
          await fleeFromBattle(ctx);
          await ctx.sleep(5000);
          continue;
        }
        ctx.log("error", `Travel to ${hiddenPoi.poiName} failed: ${tResp.error.message}`);
        continue;
      }
      bot.poi = hiddenPoi.poiId;

      // ── Scan the hidden POI ──
      yield `scan_${hiddenPoi.poiId}`;
      const poiResp = await bot.exec("get_poi", { poi_id: hiddenPoi.poiId });

      if (await checkBattleAfterCommand(ctx, poiResp.notifications, "get_poi")) {
        ctx.log("combat", "Battle detected at POI scan - fleeing!");
        await ctx.sleep(5000);
        continue;
      }

      if (poiResp.error) {
        ctx.log("error", `get_poi failed for ${hiddenPoi.poiName}: ${poiResp.error.message}`);
        continue;
      }

      // Parse and update mapstore with POI data
      const result = poiResp.result as Record<string, unknown>;
      const poiData = result?.poi as Record<string, unknown> | undefined;
      const resources = (
        Array.isArray(result?.resources) ? result.resources :
        Array.isArray(poiData?.resources) ? poiData.resources :
        []
      ) as Array<Record<string, unknown>>;

      if (poiData) {
        const resourceData = resources.map((r) => ({
          resource_id: (r.resource_id as string) || "",
          name: (r.name as string) || (r.resource_id as string) || "",
          richness: (r.richness as number) || 0,
          remaining: (r.remaining as number) || 0,
          max_remaining: (r.max_remaining as number) || 0,
          depletion_percent: (r.depletion_percent as number) || 100,
        }));

        mapStore.registerPoiFromScan(hiddenPoi.systemId, {
          id: (poiData.id as string) || hiddenPoi.poiId,
          name: (poiData.name as string) || hiddenPoi.poiName,
          type: (poiData.type as string) || hiddenPoi.poiType,
          hidden: true,
          reveal_difficulty: poiData.reveal_difficulty as number | undefined,
          resources: resourceData.length > 0 ? resourceData : undefined,
        });

        if (resourceData.length > 0) {
          const resourceNames = resourceData.map(r => r.name).join(", ");
          ctx.log("exploration", `🎯 Scanned hidden POI ${hiddenPoi.poiName}: ${resourceNames}`);
        } else {
          ctx.log("info", `Scanned hidden POI ${hiddenPoi.poiName}: no resources found`);
        }
      }

      visitedHiddenPois.add(`${hiddenPoi.systemId}:${hiddenPoi.poiId}`);
      mapStore.markExplored(hiddenPoi.systemId, hiddenPoi.poiId);

      // ── Check cargo — if full with non-fuel-cell items, return home to deposit ──
      await bot.refreshStatus();
      if (bot.cargoMax > 0 && bot.cargo >= bot.cargoMax) {
        // Check if cargo is full of only fuel cells (intentional for exploration)
        const cargoResp = await bot.exec("get_cargo");
        let isOnlyFuelCells = true;
        let fuelCellCount = 0;
        if (cargoResp.result && typeof cargoResp.result === "object") {
          const cResult = cargoResp.result as Record<string, unknown>;
          const cargoItems = (
            Array.isArray(cResult) ? cResult :
            Array.isArray(cResult.items) ? (cResult.items as Array<Record<string, unknown>>) :
            Array.isArray(cResult.cargo) ? (cResult.cargo as Array<Record<string, unknown>>) :
            []
          );
          for (const item of cargoItems) {
            const itemId = (item.item_id as string) || "";
            const quantity = (item.quantity as number) || 0;
            if (!itemId.toLowerCase().includes("fuel_cell")) {
              isOnlyFuelCells = false;
              break;
            }
            fuelCellCount += quantity;
          }
        }

        if (!isOnlyFuelCells) {
          yield "deposit_cargo";
          await depositCargoAtHome(ctx, { fuelThresholdPct: FUEL_SAFETY_PCT, hullThresholdPct: 30 });
        } else {
          ctx.log("info", `Cargo full with fuel cells (${fuelCellCount} fuel cells, ${bot.cargo}/${bot.cargoMax} cargo) — continuing exploration`);
        }
      }

      // ── Check fuel cell depletion — return to home base if enabled and no fuel cells left ──
      const deepScanSettings = getExplorerSettings(bot.username);
      if (deepScanSettings.returnToHomeOnFuelCellDepletion) {
        const fuelCellCheck = await checkFuelCellInventory(ctx);
        if (fuelCellCheck.totalFuelCells === 0) {
          ctx.log("system", `Fuel cells depleted (0 remaining) — returning to home base to reload`);
          yield "return_to_home_fuel_cells";
          const returned = await returnToHomeBaseForFuelCells(ctx);
          if (returned) {
            await bot.refreshStatus();
            ctx.log("info", `Returned to home base — continuing deep core scan`);
            break; // Break to restart the while loop
          }
        }
      }
    }

    // ── Check skills ──
    yield "check_skills";
    await bot.checkSkills();

    // ── Cycle complete — restart ──
    await bot.refreshStatus();
    const cycleFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    ctx.log("info", `Deep core scan cycle done — visited ${visitedHiddenPois.size} POI(s), ${bot.credits} cr, ${cycleFuel}% fuel`);
    visitedHiddenPois.clear(); // Reset for next cycle
    await ctx.sleep(5000);
  }
}

/**
 * Find all hidden POIs that need scanning across all known systems.
 * Returns POIs sorted by staleness (oldest first).
 */
function findHiddenPoisToScan(ctx: RoutineContext): Array<{
  systemId: string;
  systemName: string;
  poiId: string;
  poiName: string;
  poiType: string;
  staleMins: number;
}> {
  const allSystems = mapStore.getAllSystems();
  const hiddenPois: Array<{
    systemId: string;
    systemName: string;
    poiId: string;
    poiName: string;
    poiType: string;
    staleMins: number;
  }> = [];

  const staleThreshold = Date.now() - RESOURCE_REFRESH_MINS * 60 * 1000;

  for (const [sysId, sys] of Object.entries(allSystems)) {
    // Skip pirate systems
    if (isPirateSystem(sysId)) continue;

    for (const poi of sys.pois) {
      // Only include hidden POIs
      if (!poi.hidden) continue;

      // Check how stale the data is
      let oldestMins = Infinity;
      if (poi.last_updated) {
        const mins = (Date.now() - new Date(poi.last_updated).getTime()) / 60000;
        oldestMins = mins;
      }

      // Skip if recently scanned
      if (oldestMins < RESOURCE_REFRESH_MINS) continue;

      hiddenPois.push({
        systemId: sysId,
        systemName: sys.name,
        poiId: poi.id,
        poiName: poi.name,
        poiType: poi.type,
        staleMins: oldestMins,
      });
    }
  }

  // Sort by staleness (oldest first)
  hiddenPois.sort((a, b) => b.staleMins - a.staleMins);

  return hiddenPois;
}

/**
 * Check if the ship has a deep core survey scanner equipped.
 * Reused from miner.ts — checks ship modules for scanner.
 */
async function hasDeepCoreSurveyScanner(ctx: RoutineContext): Promise<boolean> {
  const { bot } = ctx;
  const shipResp = await bot.exec("get_ship");
  if (shipResp.error || !shipResp.result) return false;

  const shipData = shipResp.result as Record<string, unknown>;
  const modules = Array.isArray(shipData.modules) ? shipData.modules : [];

  for (const mod of modules) {
    const modObj = typeof mod === "object" && mod !== null ? mod as Record<string, unknown> : null;
    const modId = (modObj?.id as string) || (modObj?.type_id as string) || "";
    const modName = (modObj?.name as string) || "";
    const modSpecial = (modObj?.special as string) || "";

    const checkStr = `${modId} ${modName} ${modSpecial}`.toLowerCase();
    if (checkStr.includes("deep_core_survey_scanner") ||
        checkStr.includes("deep core survey scanner") ||
        modSpecial.includes("deep_core_detection")) {
      return true;
    }
  }
  return false;
}

// ── Trade Update routine ─────────────────────────────────────

/**
 * Trade update mode — cycles through known systems with stations,
 * refreshing market/orders/missions data. Stays in known space.
 */
async function* tradeUpdateRoutine(ctx: RoutineContext): AsyncGenerator<string, void, void> {
  const { bot } = ctx;
  const fledFromSystems = new Set<string>(); // Track systems we've fled from due to pirates
  const path: string[] = []; // Track the path of systems visited

  await bot.refreshStatus();
  const homeSystem = bot.system;
  if (homeSystem) {
    path.push(homeSystem);
  }

  ctx.log("system", "Trade Update mode — cycling known stations to refresh market data...");

  // ── Startup: dock, refuel, deposit cargo ──
  yield "startup_prep";
  const { pois: startPois } = await getSystemInfo(ctx);
  const startStation = findStation(startPois);
  if (startStation) {
    if (bot.poi !== startStation.id) {
      await ensureUndocked(ctx);
      await bot.exec("travel", { target_poi: startStation.id });
    }
    await ensureDocked(ctx);
    await collectFromStorage(ctx);
    await tryRefuel(ctx);
    await bot.refreshStatus();
  }

  while (bot.state === "running") {
    // ── Death recovery ──
    const alive2 = await detectAndRecoverFromDeath(ctx);
    if (!alive2) { await ctx.sleep(30000); continue; }

    // ── Battle check — if in battle, flee immediately ──
    if (await checkAndFleeFromBattle(ctx, "trade_update")) {
      await ctx.sleep(5000);
      continue;
    }

    // ── Re-check mode after recovery — user might have changed it, or session was restarted ──
    const modeCheck = getExplorerSettings(bot.username);
    if (modeCheck.mode !== "trade_update") {
      ctx.log("system", "Mode changed to explore — restarting as explorer...");
      break;
    }

    // ── Build list of known systems with stations, sorted by stalest market data ──
    yield "plan_route";
    const allSystems = mapStore.getAllSystems();
    const stationSystems: Array<{ systemId: string; systemName: string; stationPoi: string; stationName: string; staleMins: number }> = [];

    // Get focus area settings
    const focusSettings = getExplorerSettings(bot.username);
    const focusAreaSystem = focusSettings.focusAreaSystem;
    const maxJumps = focusSettings.maxJumps;
    const blacklist = getSystemBlacklist();

    for (const [sysId, sys] of Object.entries(allSystems)) {
      // Skip pirate systems — they are hostile!
      if (isPirateSystem(sysId)) continue;
      // Skip blacklisted systems (persistent + temporary + fled from)
      if (blacklist.some(b => b.toLowerCase() === sysId.toLowerCase())) continue;
      if (isTemporarilyBlacklisted(sysId)) continue;
      if (fledFromSystems.has(sysId)) continue;

      // If focus area is set, check if this system is within range
      if (focusAreaSystem) {
        const route = mapStore.findRoute(focusAreaSystem, sysId, blacklist);
        if (!route) continue; // No route = not reachable
        const jumpsNeeded = route.length - 1; // Number of jumps = route length - 1
        if (jumpsNeeded > maxJumps) continue; // Too far from focus area
      }

      for (const poi of sys.pois) {
        if (!poi.has_base) continue;
        // Find the stalest market entry, or Infinity if no market data
        let oldestMins = Infinity;
        if (poi.market && poi.market.length > 0) {
          for (const m of poi.market) {
            if (m.last_updated) {
              const mins = (Date.now() - new Date(m.last_updated).getTime()) / 60000;
              if (mins < oldestMins) oldestMins = mins;
            }
          }
        }
        stationSystems.push({
          systemId: sysId,
          systemName: sys.name,
          stationPoi: poi.id,
          stationName: poi.name,
          staleMins: oldestMins,
        });
      }
    }

    // Sort: stalest data first (or no data = Infinity first)
    stationSystems.sort((a, b) => b.staleMins - a.staleMins);

    if (stationSystems.length === 0) {
      const focusMsg = focusAreaSystem ? ` within ${maxJumps} jumps of ${focusAreaSystem}` : '';
      ctx.log("info", `No known stations${focusMsg} — run an explorer in 'explore' mode first. Waiting 60s...`);
      await ctx.sleep(60000);
      continue;
    }

    const focusLog = focusAreaSystem ? ` (focus: ${focusAreaSystem}, max ${maxJumps} jumps)` : '';
    ctx.log("info", `Found ${stationSystems.length} known stations to update${focusLog}`);

    // ── Visit each station ──
    for (const target of stationSystems) {
      if (bot.state !== "running") break;

      // Re-check mode
      const mc = getExplorerSettings(bot.username);
      if (mc.mode !== "trade_update") {
        ctx.log("system", "Mode changed — stopping trade update loop");
        break;
      }

      // Skip if recently updated (< 15 mins)
      const freshCheck = mapStore.minutesSinceExplored(target.systemId, target.stationPoi);
      if (freshCheck < 15) {
        continue;
      }

      // ── Navigate to target system if needed ──
      yield "fuel_check";
      const fueled = await ensureFueled(ctx, FUEL_SAFETY_PCT);
      if (!fueled) {
        ctx.log("error", "Cannot refuel — waiting 30s...");
        await ctx.sleep(30000);
        continue;
      }

      if (target.systemId !== bot.system) {
        yield "navigate";
        await ensureUndocked(ctx);
        const arrived = await navigateToSystem(ctx, target.systemId, { fuelThresholdPct: FUEL_SAFETY_PCT, hullThresholdPct: 30 });
        if (!arrived) {
          ctx.log("error", `Could not reach ${target.systemName} — skipping`);
          continue;
        }
        path.push(target.systemId); // Track the arrived system in path
      }

      if (bot.state !== "running") break;

      // ── Travel to station POI ──
      yield "travel_to_station";
      await ensureUndocked(ctx);
      const tResp = await bot.exec("travel", { target_poi: target.stationPoi });

      // Check for battle after travel
      if (await checkBattleAfterCommand(ctx, tResp.notifications, "travel")) {
        ctx.log("combat", "Battle detected during travel - fleeing!");
        await ctx.sleep(5000);
        continue;
      }

      if (tResp.error && !tResp.error.message.includes("already")) {
        ctx.log("error", `Travel failed: ${tResp.error.message}`);
        continue;
      }
      bot.poi = target.stationPoi;

      // ── Scavenge wrecks en route (only if enabled — unsafe near pirates) ──
      const tradeSettings = getExplorerSettings(bot.username);
      if (tradeSettings.scavengeEnabled) {
        yield "scavenge";
        const scavengeResult = await scavengeWrecks(ctx);

        // Check battle status after scavenge
        if (await checkAndFleeFromBattle(ctx, "scavenge")) {
          await ctx.sleep(5000);
          continue;
        }
      }

      // ── Dock and scan ──
      yield "scan_station";
      const sysPois = (await getSystemInfo(ctx)).pois;
      const stPoi = sysPois.find(p => p.id === target.stationPoi);
      if (stPoi) {
        yield* scanStation(ctx, target.systemId, stPoi);
      } else {
        // POI not found in live data — try docking anyway
        const dResp = await bot.exec("dock");

        // Check for battle after dock
        if (await checkBattleAfterCommand(ctx, dResp.notifications, "dock")) {
          ctx.log("combat", "Battle detected during docking - fleeing!");
          await ctx.sleep(5000);
          continue;
        }

        if (!dResp.error || dResp.error.message.includes("already")) {
          bot.docked = true;
          await collectFromStorage(ctx);

          const marketResp = await bot.exec("view_market");

          // Check for battle after view_market
          if (await checkBattleAfterCommand(ctx, marketResp.notifications, "view_market")) {
            ctx.log("combat", "Battle detected during market scan - fleeing!");
            await ctx.sleep(5000);
            continue;
          }

          if (marketResp.result && typeof marketResp.result === "object") {
            mapStore.updateMarket(target.systemId, target.stationPoi, marketResp.result as Record<string, unknown>);

            // Extract detailed order book data from view_market response and save to marketDetails.json
            const result = marketResp.result as Record<string, unknown>;
            const items = (
              Array.isArray(result) ? result :
              Array.isArray(result.items) ? result.items :
              Array.isArray(result.market) ? result.market :
              []
            ) as Array<Record<string, unknown>>;

            if (items.length > 0) {
              ctx.log("info", `Saving detailed market data for ${items.length} items...`);
              const marketDetails = loadMarketDetails();
              let detailsUpdated = false;

              for (const item of items) {
                const itemId = (item.item_id as string) || (item.id as string) || "";
                const itemName = (item.name as string) || (item.item_name as string) || itemId;

                if (!itemId) continue;

                const buyOrders = ((item.buy_orders as Array<Record<string, unknown>>) || []).map(order => ({
                  price: (order.price_each as number) || (order.price as number) || 0,
                  quantity: (order.quantity as number) || 0,
                })).filter(order => order.price > 0 && order.quantity > 0);

                const sellOrders = ((item.sell_orders as Array<Record<string, unknown>>) || []).map(order => ({
                  price: (order.price_each as number) || (order.price as number) || 0,
                  quantity: (order.quantity as number) || 0,
                })).filter(order => order.price > 0 && order.quantity > 0);

                // Update or add to market details
                const existingIndex = marketDetails.items.findIndex(
                  m => m.systemId === target.systemId && m.stationPoiId === target.stationPoi && m.itemId === itemId
                );

                const marketItemDetail: MarketItemDetails = {
                  systemId: target.systemId,
                  stationPoiId: target.stationPoi,
                  stationName: target.stationName,
                  itemId,
                  itemName,
                  buyOrders,
                  sellOrders,
                  lastUpdated: now(),
                };

                if (existingIndex >= 0) {
                  marketDetails.items[existingIndex] = marketItemDetail;
                } else {
                  marketDetails.items.push(marketItemDetail);
                }

                detailsUpdated = true;
              }

              if (detailsUpdated) {
                saveMarketDetails(marketDetails);
                ctx.log("info", `Saved detailed market data for ${items.length} items to marketDetails.json`);
              }
            }
          }

          const missResp = await bot.exec("get_missions");

          // Check for battle after get_missions
          if (await checkBattleAfterCommand(ctx, missResp.notifications, "get_missions")) {
            ctx.log("combat", "Battle detected during mission scan - fleeing!");
            await ctx.sleep(5000);
            continue;
          }

          if (missResp.result && typeof missResp.result === "object") {
            const mData = missResp.result as Record<string, unknown>;
            const missions = (
              Array.isArray(mData) ? mData :
              Array.isArray(mData.missions) ? mData.missions :
              Array.isArray(mData.available) ? mData.available :
              []
            ) as Array<Record<string, unknown>>;
            if (missions.length > 0) mapStore.updateMissions(target.systemId, target.stationPoi, missions);
          }

          await tryRefuel(ctx);

          const undockResp = await bot.exec("undock");

          // Check for battle after undock
          if (await checkBattleAfterCommand(ctx, undockResp.notifications, "undock")) {
            ctx.log("combat", "Battle detected during undock - fleeing!");
            await ctx.sleep(5000);
            continue;
          }

          bot.docked = false;
          mapStore.markExplored(target.systemId, target.stationPoi);
          ctx.log("info", `Updated ${target.stationName} in ${target.systemName}`);
        }
      }

      // ── Check cargo — if full with non-fuel-cell items, return home to deposit ──
      await bot.refreshStatus();
      if (bot.cargoMax > 0 && bot.cargo >= bot.cargoMax) {
        // Check if cargo is full of only fuel cells (intentional for exploration)
        const cargoResp = await bot.exec("get_cargo");
        let isOnlyFuelCells = true;
        let fuelCellCount = 0;
        if (cargoResp.result && typeof cargoResp.result === "object") {
          const cResult = cargoResp.result as Record<string, unknown>;
          const cargoItems = (
            Array.isArray(cResult) ? cResult :
            Array.isArray(cResult.items) ? (cResult.items as Array<Record<string, unknown>>) :
            Array.isArray(cResult.cargo) ? (cResult.cargo as Array<Record<string, unknown>>) :
            []
          );
          for (const item of cargoItems) {
            const itemId = (item.item_id as string) || "";
            const quantity = (item.quantity as number) || 0;
            if (!itemId.toLowerCase().includes("fuel_cell")) {
              isOnlyFuelCells = false;
              break;
            }
            fuelCellCount += quantity;
          }
        }

        if (!isOnlyFuelCells) {
          yield "deposit_cargo";
          await depositCargoAtHome(ctx, { fuelThresholdPct: FUEL_SAFETY_PCT, hullThresholdPct: 30 });
        } else {
          ctx.log("info", `Cargo full with fuel cells (${fuelCellCount} fuel cells, ${bot.cargo}/${bot.cargoMax} cargo) — continuing exploration`);
        }
      }

      // ── Check fuel cell depletion — return to home base if enabled and no fuel cells left ──
      const tradeFuelSettings = getExplorerSettings(bot.username);
      if (tradeFuelSettings.returnToHomeOnFuelCellDepletion) {
        const fuelCellCheck = await checkFuelCellInventory(ctx);
        if (fuelCellCheck.totalFuelCells === 0) {
          ctx.log("system", `Fuel cells depleted (0 remaining) — returning to home base to reload`);
          yield "return_to_home_fuel_cells";
          const returned = await returnToHomeBaseForFuelCells(ctx);
          if (returned) {
            await bot.refreshStatus();
            ctx.log("info", `Returned to home base — continuing trade update`);
            break; // Break to restart the while loop
          }
        }
      }

      // ── Check skills ──
      yield "check_skills";
      await bot.checkSkills();

      await bot.refreshStatus();
    }

    await bot.refreshStatus();
    const cycleFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    ctx.log("info", `Trade update cycle done — ${stationSystems.length} stations, ${bot.credits} cr, ${cycleFuel}% fuel`);
    await ctx.sleep(5000);
  }
}

// ── Helpers ──────────────────────────────────────────────────

/** Threshold in days for considering POI data stale. */
const STALE_POI_DAYS = 7;

/**
 * Find systems that need exploration, sorted by priority then distance (nearest first).
 *
 * Priority tiers:
 *   1. Systems with 0 POIs (completely unknown / never explored)
 *   2. Systems where all POIs are stale (last_updated > 7 days ago)
 *
 * Within each tier, systems are sorted by jump distance ascending (nearest first).
 */
function findUnknownSystems(ctx: RoutineContext, currentSystem: string, blacklist: string[], fledFromSystems: Set<string>): Array<{
  id: string;
  name: string;
  distance: number;
  route: string[];
  priority: "unknown" | "stale";
  oldestPoiUpdate: string | null;
}> {
  const unknowns: Array<{
    id: string;
    name: string;
    distance: number;
    route: string[];
    priority: "unknown" | "stale";
    oldestPoiUpdate: string | null;
  }> = [];

  const staleThreshold = Date.now() - STALE_POI_DAYS * 24 * 60 * 60 * 1000;

  // BFS to find all reachable systems and their distances
  const visited = new Set<string>();
  const queue: Array<{ systemId: string; distance: number; route: string[] }> = [
    { systemId: currentSystem, distance: 0, route: [currentSystem] }
  ];
  visited.add(currentSystem);

  while (queue.length > 0) {
    const { systemId, distance, route } = queue.shift()!;
    const sys = mapStore.getSystem(systemId);
    if (!sys) continue;

    for (const conn of sys.connections) {
      const connId = conn.system_id;
      if (!connId) continue;
      if (visited.has(connId)) continue;
      // Skip blacklisted systems, temporarily blacklisted systems, and systems we've fled from
      if (blacklist.some(b => b.toLowerCase() === connId.toLowerCase())) continue;
      if (isTemporarilyBlacklisted(connId)) continue;
      if (fledFromSystems.has(connId)) continue;

      visited.add(connId);
      const newRoute = [...route, connId];
      const newDistance = distance + 1;

      const targetSys = mapStore.getSystem(connId);
      if (targetSys) {
        // System is in map.json — check POI status
        const poiCount = targetSys.pois?.length ?? 0;

        if (poiCount === 0) {
          // Completely unknown — never explored
          unknowns.push({
            id: connId,
            name: conn.system_name || connId,
            distance: newDistance,
            route: newRoute,
            priority: "unknown",
            oldestPoiUpdate: null,
          });
        } else {
          // Has POIs — check if all are stale
          const now = Date.now();
          let allStale = true;
          let oldestUpdate: string | null = null;
          let oldestTime = Infinity;

          for (const poi of targetSys.pois) {
            const updateTime = poi.last_updated ? new Date(poi.last_updated).getTime() : 0;
            if (updateTime > staleThreshold) {
              allStale = false; // At least one POI is fresh
            }
            if (updateTime < oldestTime) {
              oldestTime = updateTime;
              oldestUpdate = poi.last_updated || null;
            }
          }

          if (allStale && oldestUpdate) {
            // All POIs are stale — needs re-exploration
            unknowns.push({
              id: connId,
              name: conn.system_name || connId,
              distance: newDistance,
              route: newRoute,
              priority: "stale",
              oldestPoiUpdate: oldestUpdate,
            });
          }
        }

        // Continue BFS through known systems (whether explored or not)
        queue.push({ systemId: connId, distance: newDistance, route: newRoute });
      } else {
        // System not in map.json at all — also consider it unknown
        unknowns.push({
          id: connId,
          name: conn.system_name || connId,
          distance: newDistance,
          route: newRoute,
          priority: "unknown",
          oldestPoiUpdate: null,
        });
      }
    }
  }

  // Sort: unknown priority first, then stale; within each tier, nearest first
  unknowns.sort((a, b) => {
    if (a.priority !== b.priority) {
      return a.priority === "unknown" ? -1 : 1;
    }
    return a.distance - b.distance; // nearest first
  });

  return unknowns;
}

/**
 * Find unknown or stale systems near a target system (for grouping).
 * Returns systems within maxJumps that have 0 POIs or all-stale POIs.
 */
function findNearbyUnknowns(ctx: RoutineContext, targetSystem: string, maxJumps: number, blacklist: string[], fledFromSystems: Set<string>): string[] {
  const nearby: string[] = [];
  const staleThreshold = Date.now() - STALE_POI_DAYS * 24 * 60 * 60 * 1000;

  // BFS from target system
  const visited = new Set<string>();
  const queue: Array<{ systemId: string; distance: number }> = [
    { systemId: targetSystem, distance: 0 }
  ];
  visited.add(targetSystem);

  while (queue.length > 0) {
    const { systemId, distance } = queue.shift()!;
    if (distance >= maxJumps) continue;

    const sys = mapStore.getSystem(systemId);
    if (!sys) continue;

    for (const conn of sys.connections) {
      const connId = conn.system_id;
      if (!connId) continue;
      if (visited.has(connId)) continue;
      if (blacklist.some(b => b.toLowerCase() === connId.toLowerCase())) continue;
      if (isTemporarilyBlacklisted(connId)) continue;
      if (fledFromSystems.has(connId)) continue;

      visited.add(connId);

      const targetSys = mapStore.getSystem(connId);
      if (targetSys) {
        const poiCount = targetSys.pois?.length ?? 0;
        if (poiCount === 0) {
          nearby.push(connId);
        } else {
          // Check if all POIs are stale
          let allStale = true;
          for (const poi of targetSys.pois) {
            const updateTime = poi.last_updated ? new Date(poi.last_updated).getTime() : 0;
            if (updateTime > staleThreshold) { allStale = false; break; }
          }
          if (allStale) nearby.push(connId);
        }
        // Continue BFS through known systems
        queue.push({ systemId: connId, distance: distance + 1 });
      } else {
        // System not in map.json at all - also consider it unknown
        nearby.push(connId);
      }
    }
  }

  return nearby;
}

/**
 * Load fuel cells to max cargo capacity at faction home (Sol Central).
 * Uses storage to withdraw credits if needed, prioritizes home base where fuel cells are cheap and abundant.
 */
async function loadFuelCellsToMax(ctx: RoutineContext): Promise<boolean> {
  const { bot } = ctx;

  // Check current cargo space and existing fuel cells
  const cargoResp = await bot.exec("get_cargo");

  // Check for battle after get_cargo
  if (await checkBattleAfterCommand(ctx, cargoResp.notifications, "get_cargo")) {
    ctx.log("combat", "Battle detected during cargo check - fleeing!");
    await ctx.sleep(5000);
    return false;
  }

  if (!cargoResp.result || typeof cargoResp.result !== "object") {
    ctx.log("error", "Could not get cargo status");
    return false;
  }

  const cResult = cargoResp.result as Record<string, unknown>;
  const cargoItems = (
    Array.isArray(cResult) ? cResult :
    Array.isArray(cResult.items) ? cResult.items :
    Array.isArray(cResult.cargo) ? cResult.cargo :
    []
  ) as Array<Record<string, unknown>>;

  let currentCargo = 0;
  let premiumFuelCells = 0;
  let regularFuelCells = 0;
  for (const item of cargoItems) {
    const itemId = (item.item_id as string) || "";
    const quantity = (item.quantity as number) || 0;
    const spacePerItem = itemId === "premium_fuel_cell" ? 2 : 1;
    currentCargo += quantity * spacePerItem;
    if (itemId === "premium_fuel_cell") {
      premiumFuelCells = quantity;
    } else if (itemId === "fuel_cell") {
      regularFuelCells = quantity;
    }
  }

  const availableSpace = bot.cargoMax - currentCargo;
  if (availableSpace <= 0) {
    ctx.log("info", `Cargo hold full — already loaded with ${premiumFuelCells} premium + ${regularFuelCells} regular fuel cells (${bot.cargo}/${bot.cargoMax} cargo)`);
    return true;
  }

  // Premium fuel cells take 2 cargo space each, regular take 1
  // Calculate max we can withdraw: premium uses 2 space, so use floor division
  const maxPremiumWithdraw = Math.floor(availableSpace / 2);
  // For regular, we can use all available space since they take 1 each
  const maxRegularWithdraw = availableSpace;

  // Try to withdraw premium_fuel_cell first (higher priority, takes 2 space each)
  const premiumToWithdraw = Math.min(maxPremiumWithdraw, 402); // Cap at reasonable amount
  ctx.log("trade", `Loading ${premiumToWithdraw} premium fuel cells from faction storage for long-range exploration...`);
  let withdrawResp = await bot.exec("faction_withdraw_items", {
    item_id: "premium_fuel_cell",
    quantity: premiumToWithdraw
  });

  // Check for battle after faction_withdraw_items
  if (await checkBattleAfterCommand(ctx, withdrawResp.notifications, "faction_withdraw_items")) {
    ctx.log("combat", "Battle detected during fuel cell withdraw - fleeing!");
    await ctx.sleep(5000);
    return false;
  }

  let loadedCount = 0;
  if (!withdrawResp.error) {
    loadedCount = premiumToWithdraw;
    const newPremium = premiumFuelCells + loadedCount;
    const actualCargoUsed = loadedCount * 2;
    ctx.log("trade", `Loaded ${loadedCount} premium fuel cells from faction storage (${actualCargoUsed} cargo space, ${newPremium} premium + ${regularFuelCells} regular, ${bot.cargo}/${bot.cargoMax} cargo)`);
    return true;
  }

  // If premium withdraw failed, try regular fuel_cell
  ctx.log("warn", `Could not withdraw premium fuel cells: ${withdrawResp.error.message} — trying regular fuel cells...`);
  withdrawResp = await bot.exec("faction_withdraw_items", {
    item_id: "fuel_cell",
    quantity: maxRegularWithdraw
  });

  // Check for battle after faction_withdraw_items
  if (await checkBattleAfterCommand(ctx, withdrawResp.notifications, "faction_withdraw_items")) {
    ctx.log("combat", "Battle detected during fuel cell withdraw - fleeing!");
    await ctx.sleep(5000);
    return false;
  }

  if (!withdrawResp.error) {
    loadedCount = maxRegularWithdraw;
    const newRegular = regularFuelCells + loadedCount;
    ctx.log("trade", `Loaded ${loadedCount} regular fuel cells from faction storage (${premiumFuelCells} premium + ${newRegular} regular, ${bot.cargo}/${bot.cargoMax} cargo)`);
    return true;
  }

  // If faction withdraw failed, try to buy premium fuel cells from station market as fallback
  ctx.log("warn", `Could not withdraw regular fuel cells: ${withdrawResp.error.message} — trying to buy premium fuel cells from market...`);
  const buyResp = await bot.exec("buy", {
    item_id: "premium_fuel_cell",
    quantity: premiumToWithdraw
  });

  // Check for battle after buy
  if (await checkBattleAfterCommand(ctx, buyResp.notifications, "buy")) {
    ctx.log("combat", "Battle detected during fuel cell purchase - fleeing!");
    await ctx.sleep(5000);
    return false;
  }

  if (!buyResp.error) {
    loadedCount = premiumToWithdraw;
    const newPremium = premiumFuelCells + loadedCount;
    ctx.log("trade", `Bought ${loadedCount} premium fuel cells from market (${newPremium} premium + ${regularFuelCells} regular, ${bot.cargo}/${bot.cargoMax} cargo)`);
    return true;
  }

  // If premium buy failed, try regular fuel_cell
  ctx.log("warn", `Could not buy premium fuel cells: ${buyResp.error.message} — trying regular fuel cells...`);
  const buyRegularResp = await bot.exec("buy", {
    item_id: "fuel_cell",
    quantity: maxRegularWithdraw
  });

  // Check for battle after buy
  if (await checkBattleAfterCommand(ctx, buyRegularResp.notifications, "buy")) {
    ctx.log("combat", "Battle detected during fuel cell purchase - fleeing!");
    await ctx.sleep(5000);
    return false;
  }

  if (!buyRegularResp.error) {
    loadedCount = maxRegularWithdraw;
    const newRegular = regularFuelCells + loadedCount;
    ctx.log("trade", `Bought ${loadedCount} regular fuel cells from market (${premiumFuelCells} premium + ${newRegular} regular, ${bot.cargo}/${bot.cargoMax} cargo)`);
    return true;
  }

  // If buy also failed, try to withdraw credits and retry with premium
  const buyErrorMsg = (buyRegularResp.error.message || "").toLowerCase();
  if (buyErrorMsg.includes("credit") || buyErrorMsg.includes("not enough") || buyErrorMsg.includes("insufficient")) {
    ctx.log("trade", "Not enough credits — withdrawing from storage...");
    const withdrawCreditsResp = await bot.exec("withdraw_credits");

    // Check for battle after withdraw_credits
    if (await checkBattleAfterCommand(ctx, withdrawCreditsResp.notifications, "withdraw_credits")) {
      ctx.log("combat", "Battle detected during credits withdraw - fleeing!");
      await ctx.sleep(5000);
      return false;
    }

    if (!withdrawCreditsResp.error) {
      await bot.refreshStatus();
      ctx.log("trade", `Withdrew credits — now ${bot.credits} credits, retrying premium fuel cell purchase...`);
      const retryResp = await bot.exec("buy", {
        item_id: "premium_fuel_cell",
        quantity: premiumToWithdraw
      });

      // Check for battle after retry buy
      if (await checkBattleAfterCommand(ctx, retryResp.notifications, "buy")) {
        ctx.log("combat", "Battle detected during retry fuel cell purchase - fleeing!");
        await ctx.sleep(5000);
        return false;
      }

      if (!retryResp.error) {
        loadedCount = premiumToWithdraw;
        const newPremium = premiumFuelCells + loadedCount;
        ctx.log("trade", `Loaded ${loadedCount} premium fuel cells (${newPremium} premium + ${regularFuelCells} regular, ${bot.cargo}/${bot.cargoMax} cargo)`);
        return true;
      }

      // If premium retry failed, try regular
      ctx.log("warn", `Could not buy premium fuel cells: ${retryResp.error.message} — trying regular...`);
      const retryRegularResp = await bot.exec("buy", {
        item_id: "fuel_cell",
        quantity: maxRegularWithdraw
      });

      // Check for battle after retry buy
      if (await checkBattleAfterCommand(ctx, retryRegularResp.notifications, "buy")) {
        ctx.log("combat", "Battle detected during retry fuel cell purchase - fleeing!");
        await ctx.sleep(5000);
        return false;
      }

      if (!retryRegularResp.error) {
        loadedCount = maxRegularWithdraw;
        const newRegular = regularFuelCells + loadedCount;
        ctx.log("trade", `Loaded ${loadedCount} regular fuel cells (${premiumFuelCells} premium + ${newRegular} regular, ${bot.cargo}/${bot.cargoMax} cargo)`);
        return true;
      }
      ctx.log("error", `Still could not buy fuel cells: ${retryRegularResp.error.message}`);
    } else {
      ctx.log("error", `Could not withdraw credits: ${withdrawCreditsResp.error.message}`);
    }
  } else {
    ctx.log("error", `Could not buy fuel cells: ${buyRegularResp.error.message}`);
  }

  return false;
}

/**
 * Check fuel cell inventory - returns count of fuel cells in cargo and whether we've ever had fuel cells.
 */
async function checkFuelCellInventory(ctx: RoutineContext): Promise<{
  totalFuelCells: number;
  hasFuelCellsInInventory: boolean;
}> {
  const { bot } = ctx;
  const cargoResp = await bot.exec("get_cargo");

  if (!cargoResp.result || typeof cargoResp.result !== "object") {
    return { totalFuelCells: 0, hasFuelCellsInInventory: false };
  }

  const cResult = cargoResp.result as Record<string, unknown>;
  const cargoItems = (
    Array.isArray(cResult) ? cResult :
    Array.isArray(cResult.items) ? (cResult.items as Array<Record<string, unknown>>) :
    Array.isArray(cResult.cargo) ? (cResult.cargo as Array<Record<string, unknown>>) :
    []
  );

  let totalFuelCells = 0;
  let hasFuelCellsInInventory = false;

  for (const item of cargoItems) {
    const itemId = (item.item_id as string) || "";
    const quantity = (item.quantity as number) || 0;
    if (itemId.toLowerCase().includes("fuel_cell")) {
      totalFuelCells += quantity;
      hasFuelCellsInInventory = true;
    }
  }

  return { totalFuelCells, hasFuelCellsInInventory };
}

/**
 * Return to home base (Sol Central) to reload fuel cells.
 * Navigates to Sol, docks, and loads fuel cells to max cargo.
 */
async function returnToHomeBaseForFuelCells(ctx: RoutineContext): Promise<boolean> {
  const { bot } = ctx;

  ctx.log("system", "Returning to home base (Sol Central) to reload fuel cells...");

  // Navigate to Sol system
  if (bot.system !== "sol") {
    await ensureUndocked(ctx);
    const arrived = await navigateToSystem(ctx, "sol", { fuelThresholdPct: FUEL_SAFETY_PCT, hullThresholdPct: 30 });
    if (!arrived) {
      ctx.log("error", "Could not reach Sol system — aborting fuel cell reload");
      return false;
    }
  }

  // Travel to Sol Central station
  const stationPoi = "sol_station";
  if (bot.poi !== stationPoi) {
    await ensureUndocked(ctx);
    const tResp = await bot.exec("travel", { target_poi: stationPoi });

    // Check for battle after travel
    if (await checkBattleAfterCommand(ctx, tResp.notifications, "travel")) {
      ctx.log("combat", "Battle detected during travel - fleeing!");
      await ctx.sleep(5000);
      return false;
    }

    if (tResp.error && !tResp.error.message.includes("already")) {
      ctx.log("error", `Could not reach Sol Central: ${tResp.error.message}`);
      return false;
    }
    bot.poi = stationPoi;
  }

  // Dock at station
  if (!bot.docked) {
    const dResp = await bot.exec("dock");

    // Check for battle after dock
    if (await checkBattleAfterCommand(ctx, dResp.notifications, "dock")) {
      ctx.log("combat", "Battle detected during dock - fleeing!");
      await ctx.sleep(5000);
      return false;
    }

    if (dResp.error && !dResp.error.message.includes("already")) {
      ctx.log("error", `Could not dock at Sol Central: ${dResp.error.message}`);
      return false;
    }
    bot.docked = true;
  }

  // Load fuel cells to max cargo
  const settings = getExplorerSettings(bot.username);
  if (settings.loadFuelCellsAtHome) {
    await loadFuelCellsToMax(ctx);
  }

  // Refuel while we're here
  await tryRefuel(ctx);

  // Undock to continue exploration
  await ensureUndocked(ctx);

  ctx.log("system", "Fuel cell reload complete — returning to exploration");
  return true;
}

/**
 * Load cargo hold with fuel cells for long journeys.
 * Fills cargo to max capacity with fuel cells.
 * Prioritizes premium_fuel_cell over regular fuel_cell.
 */
async function loadFuelCells(ctx: RoutineContext): Promise<boolean> {
  const { bot, log } = ctx;

  // Find a station with fuel cells
  const { pois } = await getSystemInfo(ctx);
  const station = findStation(pois);

  if (!station) {
    log("error", "No station in current system to load fuel cells");
    return false;
  }

  // Dock at station
  if (!bot.docked) {
    const travelResp = await bot.exec("travel", { target_poi: station.id });

    // Check for battle after travel
    if (await checkBattleAfterCommand(ctx, travelResp.notifications, "travel")) {
      log("combat", "Battle detected during travel - fleeing!");
      await ctx.sleep(5000);
      return false;
    }

    if (travelResp.error) {
      const errMsg = travelResp.error.message.toLowerCase();
      // CRITICAL: Check for battle interrupt error
      if (travelResp.error.code === "battle_interrupt" || errMsg.includes("interrupted by battle") || errMsg.includes("interrupted by combat")) {
        log("combat", `Travel to station interrupted by battle! ${travelResp.error.message} - fleeing!`);
        await fleeFromBattle(ctx);
        return false;
      }
      if (!errMsg.includes("already")) {
        log("error", `Could not reach station: ${travelResp.error.message}`);
        return false;
      }
    }

    const dockResp = await bot.exec("dock");

    // Check for battle after dock
    if (await checkBattleAfterCommand(ctx, dockResp.notifications, "dock")) {
      log("combat", "Battle detected during dock - fleeing!");
      await ctx.sleep(5000);
      return false;
    }

    if (dockResp.error && !dockResp.error.message.includes("already")) {
      log("error", `Could not dock: ${dockResp.error.message}`);
      return false;
    }
    bot.docked = true;
  }

  // Check current cargo and existing fuel cells
  const cargoResp = await bot.exec("get_cargo");

  // Check for battle after get_cargo
  if (await checkBattleAfterCommand(ctx, cargoResp.notifications, "get_cargo")) {
    log("combat", "Battle detected during cargo check - fleeing!");
    await ctx.sleep(5000);
    return false;
  }

  if (!cargoResp.result || typeof cargoResp.result !== "object") {
    log("error", "Could not get cargo status");
    return false;
  }

  const cResult = cargoResp.result as Record<string, unknown>;
  const cargoItems = (
    Array.isArray(cResult) ? cResult :
    Array.isArray(cResult.items) ? cResult.items :
    Array.isArray(cResult.cargo) ? cResult.cargo :
    []
  ) as Array<Record<string, unknown>>;

  let currentCargo = 0;
  let premiumFuelCells = 0;
  let regularFuelCells = 0;
  for (const item of cargoItems) {
    const itemId = (item.item_id as string) || "";
    const quantity = (item.quantity as number) || 0;
    const spacePerItem = itemId === "premium_fuel_cell" ? 2 : 1;
    currentCargo += quantity * spacePerItem;
    if (itemId === "premium_fuel_cell") {
      premiumFuelCells = quantity;
    } else if (itemId === "fuel_cell") {
      regularFuelCells = quantity;
    }
  }

  const availableSpace = bot.cargoMax - currentCargo;
  if (availableSpace <= 0) {
    log("info", `Cargo hold full — already loaded with ${premiumFuelCells} premium + ${regularFuelCells} regular fuel cells (${bot.cargo}/${bot.cargoMax} cargo)`);
    return true;
  }

  // Premium fuel cells take 2 cargo space each, regular take 1
  const maxPremiumWithdraw = Math.floor(availableSpace / 2);
  const maxRegularWithdraw = availableSpace;

  // Try to buy premium fuel cells first
  log("trade", `Loading ${maxPremiumWithdraw} premium fuel cells for long journey...`);
  const buyResp = await bot.exec("buy", {
    item_id: "premium_fuel_cell",
    quantity: maxPremiumWithdraw
  });

  // Check for battle after buy
  if (await checkBattleAfterCommand(ctx, buyResp.notifications, "buy")) {
    log("combat", "Battle detected during fuel cell purchase - fleeing!");
    await ctx.sleep(5000);
    return false;
  }

  if (!buyResp.error) {
    const newPremium = premiumFuelCells + maxPremiumWithdraw;
    log("trade", `Bought ${maxPremiumWithdraw} premium fuel cells (${newPremium} premium + ${regularFuelCells} regular, ${bot.cargo}/${bot.cargoMax} cargo)`);
    return true;
  }

  // If premium buy failed, try regular fuel_cell
  log("warn", `Could not buy premium fuel cells: ${buyResp.error.message} — trying regular fuel cells...`);
  const buyRegularResp = await bot.exec("buy", {
    item_id: "fuel_cell",
    quantity: maxRegularWithdraw
  });

  // Check for battle after buy
  if (await checkBattleAfterCommand(ctx, buyRegularResp.notifications, "buy")) {
    log("combat", "Battle detected during fuel cell purchase - fleeing!");
    await ctx.sleep(5000);
    return false;
  }

  if (buyRegularResp.error) {
    log("error", `Could not buy fuel cells: ${buyRegularResp.error.message}`);
    return false;
  }

  const newRegular = regularFuelCells + maxRegularWithdraw;
  log("trade", `Bought ${maxRegularWithdraw} regular fuel cells (${premiumFuelCells} premium + ${newRegular} regular, ${bot.cargo}/${bot.cargoMax} cargo)`);
  return true;
}

/**
 * Pick the best next system: prioritize unexplored systems not in map.json.
 * Priority:
 * 1. Systems not in map.json at all (completely unexplored)
 * 2. Systems in map.json but not yet visited this session
 * 3. Among unvisited, prefer systems with fewer POIs (less explored)
 * Always avoids pirate systems, blacklisted systems, and systems we've fled from.
 */
function pickNextSystem(connections: Connection[], visited: Set<string>, lastSystem: string | null, fledFromSystems: Set<string>): Connection | null {
  const blacklist = getSystemBlacklist();

  // Filter out blacklisted systems, systems we've fled from, and temporarily blacklisted systems
  const nonBlacklistedConns = connections.filter(c =>
    !blacklist.some(b => b.toLowerCase() === c.id.toLowerCase()) &&
    !fledFromSystems.has(c.id) &&
    !isTemporarilyBlacklisted(c.id)
  );
  
  // Separate connections into pirate and non-pirate
  const nonPirateConns = nonBlacklistedConns.filter(c => !isPirateSystem(c.id));
  const pirateConns = nonBlacklistedConns.filter(c => isPirateSystem(c.id));

  // Work with non-pirate connections first
  let candidates = nonPirateConns.length > 0 ? nonPirateConns : pirateConns;

  // Priority 1: Systems not in map.json at all (completely unexplored)
  const unmapped = candidates.filter(c => !mapStore.getSystem(c.id));
  if (unmapped.length > 0) {
    // If multiple unmapped, prefer non-pirate
    const unmappedNonPirate = unmapped.filter(c => !isPirateSystem(c.id));
    if (unmappedNonPirate.length > 0) {
      return unmappedNonPirate[Math.floor(Math.random() * unmappedNonPirate.length)];
    }
    return unmapped[Math.floor(Math.random() * unmapped.length)];
  }

  // Priority 2: Systems in map.json but not visited this session
  const unvisited = candidates.filter(c => !visited.has(c.id));
  if (unvisited.length > 0) {
    // Sort by POI count (prefer less explored systems)
    unvisited.sort((a, b) => {
      const aPois = mapStore.getSystem(a.id)?.pois?.length ?? 0;
      const bPois = mapStore.getSystem(b.id)?.pois?.length ?? 0;
      return aPois - bPois;
    });
    return unvisited[0];
  }

  // All connected systems have been visited this session
  // If no valid candidates, fall back to any non-blacklisted connection
  if (candidates.length === 0 && nonBlacklistedConns.length > 0) {
    return nonBlacklistedConns[0];
  }
  
  return null;
}

/**
 * Smart connection picker that avoids dead-ends, pirate traps, blacklisted systems, and systems we've fled from.
 * Used when all connected systems have been visited.
 * Priority:
 * 1. Not the system we just came from
 * 2. Not a blacklisted system
 * 3. Not a system we've fled from
 * 4. Not a pirate system
 * 5. Systems with more connections (not a dead-end)
 * 6. Unexplored systems (not in map.json) over explored ones
 */
function pickSmartConnection(ctx: RoutineContext, connections: Connection[], lastSystem: string | null, visited: Set<string>, fledFromSystems: Set<string>): Connection {
  const blacklist = getSystemBlacklist();
  
  // First, filter out the system we came from (if possible)
  let candidates = lastSystem ? connections.filter(c => c.id !== lastSystem) : connections;
  if (candidates.length === 0) candidates = connections;

  // Filter out blacklisted systems, systems we've fled from, and temporarily blacklisted systems
  const nonBlacklisted = candidates.filter(c =>
    !blacklist.some(b => b.toLowerCase() === c.id.toLowerCase()) &&
    !fledFromSystems.has(c.id) &&
    !isTemporarilyBlacklisted(c.id)
  );
  // If all are blacklisted, use original candidates (trapped situation)
  candidates = nonBlacklisted.length > 0 ? nonBlacklisted : candidates;

  // Separate into pirate and non-pirate
  const nonPirate = candidates.filter(c => !isPirateSystem(c.id));
  const pirate = candidates.filter(c => isPirateSystem(c.id));

  // Prefer non-pirate systems
  const pool = nonPirate.length > 0 ? nonPirate : pirate;

  // Score each connection by multiple factors
  const scored = pool.map(conn => {
    const sys = mapStore.getSystem(conn.id);
    const connectionCount = sys?.connections?.length ?? 1;
    const isInMap = conn.id ? mapStore.getSystem(conn.id) != null : false;
    const isExploredThisSession = conn.id ? visited.has(conn.id) : false;

    // Higher score = better
    let score = 0;

    // Big bonus for systems not in map.json (completely unexplored)
    if (!isInMap) {
      score += 1000;
    }

    // Bonus for systems with more connections (hubs, not dead-ends)
    score += connectionCount * 10;

    // Small penalty for already explored this session
    if (isExploredThisSession) {
      score -= 50;
    }

    return { conn, score };
  });

  // Sort by score (highest first)
  scored.sort((a, b) => b.score - a.score);

  // Pick from top scored (add some randomness among top candidates)
  const topScore = scored[0].score;
  const topCandidates = scored.filter(s => s.score === topScore);
  const chosen = topCandidates[Math.floor(Math.random() * topCandidates.length)];

  const connInfo = scored.map(s => `${s.conn.name || s.conn.id}: ${s.score}`).join(", ");
  ctx.log("info", `Connection scores: ${connInfo} — picking ${chosen.conn.name || chosen.conn.id}`);

  return chosen.conn;
}

// ── Pirate Stronghold Proximity Detection ────────────────────

/**
 * Check if the current system is within N jumps of a pirate stronghold.
 * Returns information about the nearest stronghold and distance.
 */
async function checkPirateStrongholdProximity(
  ctx: RoutineContext,
  currentSystem: string,
  maxJumps: number,
): Promise<{
  nearStronghold: boolean;
  jumpsToStronghold: number;
  nearestStronghold: string;
}> {
  const { PIRATE_SYSTEMS } = await import("./common.js");
  
  // BFS from current system to find nearest pirate stronghold
  const visited = new Set<string>();
  const queue: Array<{ systemId: string; distance: number }> = [
    { systemId: currentSystem, distance: 0 }
  ];
  visited.add(currentSystem);

  while (queue.length > 0) {
    const { systemId, distance } = queue.shift()!;
    
    // Check if this is a pirate system
    if (PIRATE_SYSTEMS.some(ps => systemId.toLowerCase() === ps || systemId.toLowerCase().includes(ps))) {
      return {
        nearStronghold: true,
        jumpsToStronghold: distance,
        nearestStronghold: systemId,
      };
    }
    
    // Stop if we've gone too far
    if (distance >= maxJumps) continue;

    // Get system from map store
    const sys = mapStore.getSystem(systemId);
    if (!sys) continue;

    // Add connections to queue
    for (const conn of sys.connections) {
      const connId = conn.system_id;
      if (!connId) continue;
      if (visited.has(connId)) continue;
      
      visited.add(connId);
      queue.push({ systemId: connId, distance: distance + 1 });
    }
  }

  return {
    nearStronghold: false,
    jumpsToStronghold: maxJumps + 1,
    nearestStronghold: "",
  };
}

/**
 * Record pirate sighting in map data with pirate names.
 */
async function recordPirateSighting(
  ctx: RoutineContext,
  systemId: string,
  pirates: Array<{ name?: string; tier?: string; isBoss?: boolean }>,
): Promise<void> {
  const { mapStore } = await import("../mapstore.js");
  
  for (const pirate of pirates) {
    const pirateName = pirate.name || "Unknown Pirate";
    ctx.log("combat", `📍 Recording pirate sighting: ${pirateName} in ${systemId}`);
    
    // Update map store with pirate sighting
    mapStore.recordPirate(systemId, {
      name: pirateName,
    });
  }
}

/** Temporary pirate blacklist with expiration (in-memory) */
const temporaryPirateBlacklist = new Map<string, number>(); // systemId -> expiresAt timestamp

/**
 * Add a system to the temporary pirate blacklist.
 * @param systemId System to blacklist
 * @param durationMinutes How long to blacklist (default: 30 minutes)
 */
function addTemporaryPirateBlacklist(systemId: string, durationMinutes: number = 30): void {
  const expiresAt = Date.now() + durationMinutes * 60 * 1000;
  temporaryPirateBlacklist.set(systemId, expiresAt);
  console.log(`[BLACKLIST] Added ${systemId} to temporary pirate blacklist for ${durationMinutes} minutes`);
}

/**
 * Check if a system is temporarily blacklisted due to recent pirate activity.
 */
function isTemporarilyBlacklisted(systemId: string): boolean {
  const expiresAt = temporaryPirateBlacklist.get(systemId);
  if (!expiresAt) return false;
  
  // Remove expired entries
  if (Date.now() > expiresAt) {
    temporaryPirateBlacklist.delete(systemId);
    return false;
  }
  
  return true;
}

/**
 * Clean up expired temporary blacklists (call periodically).
 */
function cleanupTemporaryBlacklist(): void {
  const now = Date.now();
  for (const [systemId, expiresAt] of temporaryPirateBlacklist.entries()) {
    if (now > expiresAt) {
      temporaryPirateBlacklist.delete(systemId);
    }
  }
}
