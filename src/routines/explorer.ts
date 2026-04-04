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
  sleep,
  isPirateSystem,
  checkCustomsInspection,
  checkAndFleeFromPirates,
  fleeFromBattle,
  checkAndFleeFromBattle,
  checkBattleAfterCommand,
} from "./common.js";

/** Minimum fuel % before heading back to refuel. */
const FUEL_SAFETY_PCT = 40;
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

export type ExplorerMode = "explore" | "trade_update";

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

  return {
    mode: (mode === "trade_update" ? "trade_update" : "explore") as ExplorerMode,
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
  };
}

/** Persist explorer mode setting for a specific bot. */
export function setExplorerMode(username: string, mode: ExplorerMode): void {
  writeSettings({
    [username]: { explorerMode: mode },
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

  const visitedSystems = new Set<string>();
  const fledFromSystems = new Set<string>(); // Track systems we've fled from due to pirates
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
      if (tResp.error && !tResp.error.message.includes("already")) {
        ctx.log("error", `Could not reach station: ${tResp.error.message}`);
      }
    }

    // Dock
    if (!bot.docked) {
      const dResp = await bot.exec("dock");
      if (!dResp.error || dResp.error.message.includes("already")) {
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
    if (!alive) { await sleep(30000); continue; }

    // ── Battle check — check global WebSocket battle state first (works during 524 timeouts) ──
    if (bot.isInBattle()) {
      ctx.log("combat", "[WebSocket] Battle detected via WebSocket - fleeing immediately!");
      if (await checkAndFleeFromBattle(ctx, "explorer")) {
        await sleep(5000);
        continue;
      }
    }

    // ── Battle check — also check via API (fallback) ──
    if (await checkAndFleeFromBattle(ctx, "explorer")) {
      await sleep(5000);
      continue;
    }

    // ── Re-check mode after recovery — user might have changed it, or session was restarted ──
    const modeCheck = getExplorerSettings(bot.username);
    if (modeCheck.mode === "trade_update") {
      ctx.log("system", "Mode changed to trade_update — switching routines...");
      yield* tradeUpdateRoutine(ctx);
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
      await sleep(30000);
      continue;
    }
    visitedSystems.add(systemId);

    // Try to capture security level
    await fetchSecurityLevel(ctx, systemId);

    // ── Survey the system to reveal hidden POIs ──
    // Only survey if scanPois is enabled
    const explorerSettings = getExplorerSettings(bot.username);

    if (explorerSettings.scanPois) {
      yield "survey_system";
      const surveyResp = await bot.exec("survey_system");

      // Check for battle after survey
      if (await checkBattleAfterCommand(ctx, surveyResp.notifications, "survey_system")) {
        ctx.log("combat", "Battle detected during survey - fleeing!");
        await sleep(5000);
        continue;
      }

      if (!surveyResp.error) {
        ctx.log("info", `Surveyed ${bot.system} — checking for newly revealed POIs...`);
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
      await sleep(30000);
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
        await sleep(5000);
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
          await sleep(5000);
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

      // ── Check cargo — if full, return to Sol Central to deposit ──
      await bot.refreshStatus();
      if (bot.cargoMax > 0 && bot.cargo >= bot.cargoMax) {
        yield "deposit_cargo";
        await depositCargoAtHome(ctx, { fuelThresholdPct: FUEL_SAFETY_PCT, hullThresholdPct: 30 });
        // After depositing, we're likely in Sol — break to restart system scan
        await bot.refreshStatus();
        if (bot.system !== systemId) {
          ctx.log("info", `Moved to ${bot.system} after deposit — restarting system scan`);
          break;
        }
      }
    }

    if (bot.state !== "running") break;

    // ── Check skills for level-ups ──
    yield "check_skills";
    await bot.checkSkills();

    // ── Re-get settings in case they changed ──
    const currentSettings = getExplorerSettings(bot.username);

    // ── Pick next system to explore ──
    yield "pick_next_system";

    // ── Direct to Unknown mode: jump directly to nearest unknown or stale system ──
    if (currentSettings.directToUnknown) {
      const blacklist = getSystemBlacklist();
      const unknowns = findUnknownSystems(ctx, systemId, blacklist);

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
          await sleep(30000);
          continue;
        }
        
        // If grouping is enabled, find nearby unknowns to visit after the target
        let nearbyUnknowns: string[] = [];
        if (currentSettings.groupUnknowns) {
          nearbyUnknowns = findNearbyUnknowns(ctx, target.id, 2, blacklist);
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
          await sleep(10000);
          continue;
        }

        ctx.log("travel", `Arrived at ${target.name || target.id}`);
        bot.stats.totalSystems++;
        await checkCustomsInspection(ctx, systemId);

        // Check for pirates and battle
        const nearbyResp = await bot.exec("get_nearby");
        if (await checkBattleAfterCommand(ctx, nearbyResp.notifications, "get_nearby")) {
          ctx.log("error", "Battle detected after arrival - fleeing!");
          await sleep(30000);
          continue;
        }
        if (nearbyResp.result && typeof nearbyResp.result === "object") {
          const fled = await checkAndFleeFromPirates(ctx, nearbyResp.result);
          if (fled) {
            ctx.log("error", "Pirates detected - fled, will retry");
            fledFromSystems.add(systemId);
            await sleep(30000);
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
      await sleep(30000);
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
          await sleep(30000);
          continue;
        }
        // Smart selection: avoid dead-ends and pirate systems
        const random = pickSmartConnection(ctx, validConns, lastSystem, visitedSystems, fledFromSystems);
        await ensureUndocked(ctx);
        ctx.log("travel", `Jumping to ${random.name || random.id}...`);
        const jumpResp = await bot.exec("jump", { target_system: random.id });
        if (jumpResp.error) {
          const msg = jumpResp.error.message.toLowerCase();
          // Check if we're in battle - need to flee immediately
          if (msg.includes("battle") || msg.includes("in battle")) {
            ctx.log("combat", "Cannot jump - in battle! Attempting to flee...");
            const fled = await fleeFromBattle(ctx);
            if (!fled) {
              ctx.log("error", "Flee command failed - battle engagement active");
            }
            await sleep(5000);
            continue;
          }
          ctx.log("error", `Jump failed: ${jumpResp.error.message}`);
          await sleep(10000);
          continue;
        }
        ctx.log("travel", `Jumped to ${random.name || random.id}`);
        bot.stats.totalSystems++;
        await checkCustomsInspection(ctx, systemId);
        // Check for pirates
        const nearbyResp = await bot.exec("get_nearby");
        if (nearbyResp.result && typeof nearbyResp.result === "object") {
          const fled = await checkAndFleeFromPirates(ctx, nearbyResp.result);
          if (fled) {
            ctx.log("error", "Pirates detected - fled, will retry");
            fledFromSystems.add(systemId); // Mark this system as hostile
            await sleep(30000);
            continue;
          }
        }
        lastSystem = systemId;
        continue;
      } else {
        ctx.log("error", "No connections from this system — stuck! Waiting 60s...");
        await sleep(60000);
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
        await sleep(30000);
        continue;
      }
    }

    await ensureUndocked(ctx);
    ctx.log("travel", `Jumping to ${nextSystem.name || nextSystem.id}...`);
    const jumpResp = await bot.exec("jump", { target_system: nextSystem.id });
    if (jumpResp.error) {
      const msg = jumpResp.error.message.toLowerCase();
      // Check if we're in battle - need to flee immediately
      if (msg.includes("battle") || msg.includes("in battle")) {
        ctx.log("combat", "Cannot jump - in battle! Attempting to flee...");
        const fled = await fleeFromBattle(ctx);
        if (!fled) {
          ctx.log("error", "Flee command failed - battle engagement active");
        }
        await sleep(5000);
        continue;
      }
      if (msg.includes("fuel")) {
        ctx.log("error", "Insufficient fuel for jump — will refuel next loop");
      } else {
        ctx.log("error", `Jump failed: ${jumpResp.error.message}`);
      }
      await sleep(10000);
      continue;
    }

    ctx.log("travel", `Jumped to ${nextSystem.name || nextSystem.id}`);
    bot.stats.totalSystems++;

    // Check for customs inspection after jump
    await checkCustomsInspection(ctx, systemId);
    // Check for pirates
    const nearbyResp = await bot.exec("get_nearby");
    if (nearbyResp.result && typeof nearbyResp.result === "object") {
      const fled = await checkAndFleeFromPirates(ctx, nearbyResp.result);
      if (fled) {
        ctx.log("error", "Pirates detected - fled, will retry");
        fledFromSystems.add(systemId); // Mark this system as hostile
        await sleep(30000);
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
    await sleep(5000);
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

  if (resources.length > 0) {
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
    await sleep(3000);
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
  if (marketResp.result && typeof marketResp.result === "object") {
    mapStore.updateMarket(systemId, poi.id, marketResp.result as Record<string, unknown>);
    const result = marketResp.result as Record<string, unknown>;
    const items = (
      Array.isArray(result) ? result :
      Array.isArray(result.items) ? result.items :
      Array.isArray(result.market) ? result.market :
      []
    ) as unknown[];
    marketCount = items.length;
  }

  const missionsResp = await bot.exec("get_missions");
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
  await bot.exec("undock");
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
    await sleep(5000);
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

// ── Trade Update routine ─────────────────────────────────────

/**
 * Trade update mode — cycles through known systems with stations,
 * refreshing market/orders/missions data. Stays in known space.
 */
async function* tradeUpdateRoutine(ctx: RoutineContext): AsyncGenerator<string, void, void> {
  const { bot } = ctx;

  await bot.refreshStatus();
  const homeSystem = bot.system;

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
    if (!alive2) { await sleep(30000); continue; }

    // ── Battle check — if in battle, flee immediately ──
    if (await checkAndFleeFromBattle(ctx, "trade_update")) {
      await sleep(5000);
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
      // Skip blacklisted systems
      if (blacklist.some(b => b.toLowerCase() === sysId.toLowerCase())) continue;

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
      await sleep(60000);
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
        await sleep(30000);
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
      }

      if (bot.state !== "running") break;

      // ── Travel to station POI ──
      yield "travel_to_station";
      await ensureUndocked(ctx);
      const tResp = await bot.exec("travel", { target_poi: target.stationPoi });

      // Check for battle after travel
      if (await checkBattleAfterCommand(ctx, tResp.notifications, "travel")) {
        ctx.log("combat", "Battle detected during travel - fleeing!");
        await sleep(5000);
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
          await sleep(5000);
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
        if (!dResp.error || dResp.error.message.includes("already")) {
          bot.docked = true;
          await collectFromStorage(ctx);

          const marketResp = await bot.exec("view_market");
          if (marketResp.result && typeof marketResp.result === "object") {
            mapStore.updateMarket(target.systemId, target.stationPoi, marketResp.result as Record<string, unknown>);
          }

          const missResp = await bot.exec("get_missions");
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
          await bot.exec("undock");
          bot.docked = false;
          mapStore.markExplored(target.systemId, target.stationPoi);
          ctx.log("info", `Updated ${target.stationName} in ${target.systemName}`);
        }
      }

      // ── Deposit cargo if getting full ──
      await bot.refreshStatus();
      if (bot.cargoMax > 0 && bot.cargo >= bot.cargoMax) {
        yield "deposit_cargo";
        await depositCargoAtHome(ctx, { fuelThresholdPct: FUEL_SAFETY_PCT, hullThresholdPct: 30 });
      }

      // ── Check skills ──
      yield "check_skills";
      await bot.checkSkills();

      await bot.refreshStatus();
    }

    await bot.refreshStatus();
    const cycleFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    ctx.log("info", `Trade update cycle done — ${stationSystems.length} stations, ${bot.credits} cr, ${cycleFuel}% fuel`);
    await sleep(5000);
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
function findUnknownSystems(ctx: RoutineContext, currentSystem: string, blacklist: string[]): Array<{
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
      // Skip blacklisted systems
      if (blacklist.some(b => b.toLowerCase() === connId.toLowerCase())) continue;

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
function findNearbyUnknowns(ctx: RoutineContext, targetSystem: string, maxJumps: number, blacklist: string[]): string[] {
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

  // Check current cargo space
  const cargoResp = await bot.exec("get_cargo");
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
  let fuelCellCount = 0;
  for (const item of cargoItems) {
    const itemId = (item.item_id as string) || "";
    const quantity = (item.quantity as number) || 0;
    currentCargo += quantity;
    if (itemId.toLowerCase().includes("fuel_cell")) {
      fuelCellCount = quantity;
    }
  }

  const availableSpace = bot.cargoMax - currentCargo;
  if (availableSpace <= 0) {
    ctx.log("info", `Cargo hold full — already loaded with ${fuelCellCount} fuel cells`);
    return true;
  }

  // Try to buy fuel cells at current station
  ctx.log("trade", `Loading ${availableSpace} fuel cells for long-range exploration...`);
  const buyResp = await bot.exec("buy_item", {
    item_id: "fuel_cell",
    quantity: availableSpace
  });

  if (!buyResp.error) {
    const newFuelCells = fuelCellCount + availableSpace;
    ctx.log("trade", `Loaded ${availableSpace} fuel cells (${newFuelCells} total, ${bot.cargo}/${bot.cargoMax} cargo)`);
    return true;
  }

  // If buy failed, try to withdraw credits from storage and retry
  const errorMsg = (buyResp.error.message || "").toLowerCase();
  if (errorMsg.includes("credit") || errorMsg.includes("not enough") || errorMsg.includes("insufficient")) {
    ctx.log("trade", "Not enough credits — withdrawing from storage...");
    const withdrawResp = await bot.exec("withdraw_credits");
    if (!withdrawResp.error) {
      await bot.refreshStatus();
      ctx.log("trade", `Withdrew credits — now ${bot.credits} credits, retrying fuel cell purchase...`);
      const retryResp = await bot.exec("buy_item", {
        item_id: "fuel_cell",
        quantity: availableSpace
      });
      if (!retryResp.error) {
        const newFuelCells = fuelCellCount + availableSpace;
        ctx.log("trade", `Loaded ${availableSpace} fuel cells (${newFuelCells} total, ${bot.cargo}/${bot.cargoMax} cargo)`);
        return true;
      }
      ctx.log("error", `Still could not buy fuel cells: ${retryResp.error.message}`);
    } else {
      ctx.log("error", `Could not withdraw credits: ${withdrawResp.error.message}`);
    }
  } else {
    ctx.log("error", `Could not buy fuel cells: ${buyResp.error.message}`);
  }

  return false;
}

/**
 * Load cargo hold with fuel cells for long journeys.
 * Fills cargo to max capacity with fuel cells.
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
    if (travelResp.error && !travelResp.error.message.includes("already")) {
      log("error", `Could not reach station: ${travelResp.error.message}`);
      return false;
    }

    const dockResp = await bot.exec("dock");
    if (dockResp.error && !dockResp.error.message.includes("already")) {
      log("error", `Could not dock: ${dockResp.error.message}`);
      return false;
    }
    bot.docked = true;
  }

  // Check current cargo
  const cargoResp = await bot.exec("get_cargo");
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
  for (const item of cargoItems) {
    const quantity = (item.quantity as number) || 0;
    currentCargo += quantity;
  }

  const availableSpace = bot.cargoMax - currentCargo;
  if (availableSpace <= 0) {
    log("info", "Cargo hold is full");
    return true;
  }

  // Buy fuel cells
  log("trade", `Loading ${availableSpace} fuel cells for long journey...`);
  const buyResp = await bot.exec("buy_item", {
    item_id: "fuel_cell",
    quantity: availableSpace
  });

  if (buyResp.error) {
    log("error", `Could not buy fuel cells: ${buyResp.error.message}`);
    return false;
  }

  log("trade", `Loaded ${availableSpace} fuel cells (${bot.cargo}/${bot.cargoMax} cargo)`);
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
  
  // Filter out blacklisted systems and systems we've fled from
  const nonBlacklistedConns = connections.filter(c => 
    !blacklist.some(b => b.toLowerCase() === c.id.toLowerCase()) &&
    !fledFromSystems.has(c.id)
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

  // Filter out blacklisted systems and systems we've fled from
  const nonBlacklisted = candidates.filter(c => 
    !blacklist.some(b => b.toLowerCase() === c.id.toLowerCase()) &&
    !fledFromSystems.has(c.id)
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
