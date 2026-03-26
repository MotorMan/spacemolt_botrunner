import type { Routine, RoutineContext } from "../bot.js";
import { mapStore } from "../mapstore.js";
import {
  type SystemPOI,
  type Connection,
  isMinablePoi,
  isScenicPoi,
  isStationPoi,
  isOreBeltPoi,
  isGasCloudPoi,
  isIceFieldPoi,
  findStation,
  getSystemInfo,
  parseOreFromMineResult,
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
} from "./common.js";

/** Number of mine attempts per resource POI to sample ores. */
const SAMPLE_MINES = 5;
/** Minimum fuel % before heading back to refuel. */
const FUEL_SAFETY_PCT = 40;
/** Default minimum fuel % required before attempting a system jump. */
const DEFAULT_JUMP_FUEL_PCT = 50;

// ── Ship module detection ───────────────────────────────────

interface ShipModules {
  hasMiningLaser: boolean;
  hasGasHarvester: boolean;
  hasIceHarvester: boolean;
  hasRadHarvester: boolean;
}

/** Detect ship mining/harvesting modules. */
async function detectShipModules(ctx: RoutineContext): Promise<ShipModules> {
  const { bot } = ctx;
  const shipResp = await bot.exec("get_ship");
  if (shipResp.error) {
    ctx.log("error", `Failed to get ship info: ${shipResp.error.message}`);
    return { hasMiningLaser: false, hasGasHarvester: false, hasIceHarvester: false, hasRadHarvester: false };
  }

  const shipData = shipResp.result as Record<string, unknown>;
  const modules = Array.isArray(shipData.modules) ? shipData.modules : [];

  const result: ShipModules = {
    hasMiningLaser: false,
    hasGasHarvester: false,
    hasIceHarvester: false,
    hasRadHarvester: false,
  };

  for (const mod of modules) {
    const modObj = typeof mod === "object" && mod !== null ? mod as Record<string, unknown> : null;
    const modId = (modObj?.id as string) || (modObj?.type_id as string) || "";
    const modName = (modObj?.name as string) || "";
    const modType = (modObj?.type as string) || "";

    const checkStr = `${modId} ${modName} ${modType}`.toLowerCase();

    if (checkStr.includes("mining_laser") || checkStr.includes("mining laser")) {
      result.hasMiningLaser = true;
    }
    if (checkStr.includes("gas_harvester") || checkStr.includes("gas harvester")) {
      result.hasGasHarvester = true;
    }
    if (checkStr.includes("ice_harvester") || checkStr.includes("ice harvester")) {
      result.hasIceHarvester = true;
    }
    if (checkStr.includes("rad_harvester") || checkStr.includes("rad harvester") || checkStr.includes("radiation harvester")) {
      result.hasRadHarvester = true;
    }
  }

  return result;
}

/** Check if a POI type requires a specific module. */
function poiRequiresModule(poiType: string, modules: ShipModules): { canAccess: boolean; missingModule?: string } {
  const type = poiType.toLowerCase();
  
  // Gas clouds need gas harvester
  if (isGasCloudPoi(poiType) && !modules.hasGasHarvester) {
    return { canAccess: false, missingModule: "Gas Harvester" };
  }
  
  // Ice fields need ice harvester
  if (isIceFieldPoi(poiType) && !modules.hasIceHarvester) {
    return { canAccess: false, missingModule: "Ice Harvester" };
  }
  
  // Radiation nebulae need rad harvester
  if (type.includes("radiation") || type.includes("rad_") || type.includes("radioactive")) {
    if (!modules.hasRadHarvester) {
      return { canAccess: false, missingModule: "Rad Harvester" };
    }
  }
  
  // Ore belts need mining laser
  if (isOreBeltPoi(poiType) && !modules.hasMiningLaser) {
    return { canAccess: false, missingModule: "Mining Laser" };
  }
  
  return { canAccess: true };
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

  return {
    mode: (mode === "trade_update" ? "trade_update" : "explore") as ExplorerMode,
    acceptMissions,
    focusAreaSystem,
    maxJumps,
    refuelThreshold: Number(refuelThreshold) || DEFAULT_JUMP_FUEL_PCT,
    surveyMode: (surveyMode === "quick" ? "quick" : "thorough") as "quick" | "thorough",
    scanPois,
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

    // ── Detect ship modules for mining/harvesting ──
    const shipModules = await detectShipModules(ctx);
    const moduleInfo = [];
    if (shipModules.hasMiningLaser) moduleInfo.push("Mining Laser");
    if (shipModules.hasGasHarvester) moduleInfo.push("Gas Harvester");
    if (shipModules.hasIceHarvester) moduleInfo.push("Ice Harvester");
    if (shipModules.hasRadHarvester) moduleInfo.push("Rad Harvester");
    if (moduleInfo.length > 0) {
      ctx.log("info", `Ship equipped: ${moduleInfo.join(", ")}`);
    } else {
      ctx.log("warn", "No mining/harvesting modules detected — will skip resource POIs");
    }

    // ── Classify POIs and determine what needs visiting ──
    const toVisit: Array<{ poi: SystemPOI; reason: string }> = [];
    let skippedCount = 0;
    let skippedNoModule = 0;

    for (const poi of pois) {
      const isStation = isStationPoi(poi);
      const isMinable = isMinablePoi(poi.type);
      const isScenic = isScenicPoi(poi.type);
      const minutesAgo = mapStore.minutesSinceExplored(systemId, poi.id);

      // Check if we have the required module for this POI type
      if (isMinable) {
        const moduleCheck = poiRequiresModule(poi.type, shipModules);
        if (!moduleCheck.canAccess) {
          skippedNoModule++;
          // Mark as explored to avoid revisiting
          mapStore.markExplored(systemId, poi.id);
          ctx.log("info", `Skipping ${poi.name}: requires ${moduleCheck.missingModule} (not equipped)`);
          continue;
        }
      }

      if (isStation) {
        if (minutesAgo < STATION_REFRESH_MINS) { skippedCount++; continue; }
        toVisit.push({ poi, reason: minutesAgo === Infinity ? "new" : "refresh" });
      } else if (isMinable) {
        // In quick survey mode, skip resource POIs that have already been sampled
        if (explorerSettings.surveyMode === "quick") {
          const storedPoi = mapStore.getSystem(systemId)?.pois.find(p => p.id === poi.id);
          const hasOreData = (storedPoi?.ores_found?.length ?? 0) > 0;
          if (hasOreData) { skippedCount++; continue; }
        }
        
        // Always re-visit if explored but no ores were recorded
        const storedPoi = mapStore.getSystem(systemId)?.pois.find(p => p.id === poi.id);
        const hasOreData = (storedPoi?.ores_found?.length ?? 0) > 0;
        if (minutesAgo < RESOURCE_REFRESH_MINS && hasOreData) { skippedCount++; continue; }
        toVisit.push({ poi, reason: minutesAgo === Infinity ? "new" : (hasOreData ? "re-sample" : "no-data") });
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
      const moduleSkipMsg = skippedNoModule > 0 ? `, ${skippedNoModule} skipped (no module)` : "";
      ctx.log("info", `${bot.system}: all ${skippedCount} POIs up to date${moduleSkipMsg} — moving on`);
    } else {
      const moduleSkipMsg = skippedNoModule > 0 ? `, ${skippedNoModule} skipped (no module)` : "";
      ctx.log("info", `${bot.system}: ${toVisit.length} to visit, ${skippedCount} already explored${moduleSkipMsg}`);
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
      if (travelResp.error && !travelResp.error.message.includes("already")) {
        ctx.log("error", `Travel to ${poi.name} failed: ${travelResp.error.message}`);
        continue;
      }
      bot.poi = poi.id;

      // Scavenge wrecks/containers at each POI
      yield "scavenge";
      await scavengeWrecks(ctx);

      if (isMinable) {
        yield* sampleResourcePoi(ctx, systemId, poi);
      } else if (isStation) {
        yield* scanStation(ctx, systemId, poi);
      } else {
        yield* visitOtherPoi(ctx, systemId, poi);
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

    // ALWAYS ensure fueled before jumping — will navigate to nearest station if needed
    yield "pre_jump_fuel";
    const jumpFueled = await ensureFueled(ctx, currentSettings.refuelThreshold);
    if (!jumpFueled) {
      ctx.log("error", "Could not refuel before jump — waiting 30s...");
      await sleep(30000);
      continue;
    }

    const validConns = connections.filter(c => c.id);
    const nextSystem = pickNextSystem(validConns, visitedSystems, lastSystem);
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
        const random = pickSmartConnection(ctx, validConns, lastSystem, visitedSystems);
        await ensureUndocked(ctx);
        ctx.log("travel", `Jumping to ${random.name || random.id}...`);
        const jumpResp = await bot.exec("jump", { target_system: random.id });
        if (jumpResp.error) {
          ctx.log("error", `Jump failed: ${jumpResp.error.message}`);
          await sleep(10000);
        }
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
    
    lastSystem = systemId;
  }
};

// ── POI visit sub-routines ───────────────────────────────────

/** Sample mine at a resource POI to discover ores. */
async function* sampleResourcePoi(
  ctx: RoutineContext,
  systemId: string,
  poi: SystemPOI,
): AsyncGenerator<string, void, void> {
  const { bot } = ctx;
  yield `sample_${poi.id}`;
  const oresFound = new Set<string>();
  let mined = 0;
  let cantMine = false;

  for (let i = 0; i < SAMPLE_MINES && bot.state === "running"; i++) {
    const mineResp = await bot.exec("mine");

    if (mineResp.error) {
      const msg = mineResp.error.message.toLowerCase();
      if (msg.includes("no asteroids") || msg.includes("depleted") || msg.includes("no minable") || msg.includes("nothing to mine")) break;
      if (msg.includes("cargo") && msg.includes("full")) break;
      // Missing module — mark as explored to avoid revisiting, but don't sample
      if (msg.includes("gas harvester") || msg.includes("ice harvester")) {
        mapStore.markExplored(systemId, poi.id);
        return;
      }
      if (mined === 0) cantMine = true;
      break;
    }

    mined++;
    const { oreId, oreName } = parseOreFromMineResult(mineResp.result);
    if (oreId) {
      mapStore.recordMiningYield(systemId, poi.id, { item_id: oreId, name: oreName });
      oresFound.add(oreName);
    }

    yield "sampling";
  }

  // Single summary line
  if (oresFound.size > 0) {
    ctx.log("mining", `Sampled ${poi.name}: ${[...oresFound].join(", ")} (${mined} cycles)`);
  }

  if (!cantMine) {
    mapStore.markExplored(systemId, poi.id);
  }
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
): AsyncGenerator<string, void, void> {
  const { bot } = ctx;

  yield `scan_${poi.id}`;
  const nearbyResp = await bot.exec("get_nearby");
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
      // We've fled - abort this POI scan and return to main loop
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

    for (const [sysId, sys] of Object.entries(allSystems)) {
      // Skip pirate systems — they are hostile!
      if (isPirateSystem(sysId)) continue;

      // If focus area is set, check if this system is within range
      if (focusAreaSystem) {
        const route = mapStore.findRoute(focusAreaSystem, sysId);
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
      if (tResp.error && !tResp.error.message.includes("already")) {
        ctx.log("error", `Travel failed: ${tResp.error.message}`);
        continue;
      }
      bot.poi = target.stationPoi;

      // ── Scavenge wrecks en route ──
      yield "scavenge";
      await scavengeWrecks(ctx);

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

/**
 * Pick the best next system: prioritize unexplored systems not in map.json.
 * Priority:
 * 1. Systems not in map.json at all (completely unexplored)
 * 2. Systems in map.json but not yet visited this session
 * 3. Among unvisited, prefer systems with fewer POIs (less explored)
 * Always avoids pirate systems unless no other option exists.
 */
function pickNextSystem(connections: Connection[], visited: Set<string>, lastSystem: string | null): Connection | null {
  // Separate connections into pirate and non-pirate
  const nonPirateConns = connections.filter(c => !isPirateSystem(c.id));
  const pirateConns = connections.filter(c => isPirateSystem(c.id));
  
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
  return null;
}

/**
 * Smart connection picker that avoids dead-ends and pirate traps.
 * Used when all connected systems have been visited.
 * Priority:
 * 1. Not the system we just came from
 * 2. Not a pirate system
 * 3. Systems with more connections (not a dead-end)
 * 4. Unexplored systems (not in map.json) over explored ones
 */
function pickSmartConnection(ctx: RoutineContext, connections: Connection[], lastSystem: string | null, visited: Set<string>): Connection {
  // First, filter out the system we came from (if possible)
  let candidates = lastSystem ? connections.filter(c => c.id !== lastSystem) : connections;
  if (candidates.length === 0) candidates = connections;

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
