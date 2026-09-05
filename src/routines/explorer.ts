import type { Routine, RoutineContext } from "../bot.js";
import { mapStore } from "../mapstore.js";
import { extractShipModules, moduleHaystack } from "../shipmodules.js";
import { getSystemBlacklist } from "../web/server.js";
import { botChatChannel, type BotChatMessage, type BotChatChannel } from "../bot_chat_channel.js";
import type { FaintSignature } from "../wildlivestore.js";
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
  getGlobalHomeBase,
  isPirateSystem,
  checkCustomsInspection,
  checkAndFleeFromPirates,
  fleeFromBattle,
  checkAndFleeFromBattle,
  checkBattleAfterCommand,
  getBattleStatus,
  type BattleState,
  getItemSize,
} from "./common.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { marketDetailsStore, type MarketItemObservation } from "../marketdetailsstore.js";
import {
  updateShipListings,
} from "../shipsforsale.js";

/** Minimum fuel % before heading back to refuel. */
const FUEL_SAFETY_PCT = 40;

// ── Market Details Storage ──────────────────────────────────

const DATA_DIR = join(process.cwd(), "data");
const RAW_MISSIONS_FILE = join(DATA_DIR, "rawMissions.json");

interface RawMissionRecord {
  missionId: string;
  data: Record<string, unknown>; // Full raw mission data
  stations: Array<{
    systemId: string;
    stationPoiId: string;
    stationName: string;
    lastSeen: string;
  }>;
  firstSeen: string;
  lastSeen: string;
}

interface RawMissionsData {
  lastSaved: string;
  missions: Record<string, RawMissionRecord>; // key: mission_id
}

function loadRawMissions(): RawMissionsData {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  if (existsSync(RAW_MISSIONS_FILE)) {
    try {
      const raw = readFileSync(RAW_MISSIONS_FILE, "utf-8");
      return JSON.parse(raw) as RawMissionsData;
    } catch {
      // Corrupt file — start fresh
    }
  }
  return { lastSaved: now(), missions: {} };
}

function saveRawMissions(data: RawMissionsData): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  data.lastSaved = now();
  writeFileSync(RAW_MISSIONS_FILE, JSON.stringify(data, null, 2) + "\n", "utf-8");
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
      await bot.refreshLocation();
    }
  }
}

/** Minutes before a station's market/orders/missions data is considered stale. */
const STATION_REFRESH_MINS = 30;
/** Minutes before a resource POI should be re-sampled. */
const RESOURCE_REFRESH_MINS = 120;

// ── Per-bot settings ─────────────────────────────────────────

export type ExplorerMode = "explore" | "trade_update" | "deep_core_scan" | "visit_all" | "achievement";

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
  autoCloak: boolean;
  ignoreBlacklistWhenCloaked: boolean;
  ignorePirateFleeWhenCloaked: boolean;
  coordinateExplorers: boolean;
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

  // Auto cloak: per-bot > global explorer > default false
  const autoCloak = botOverrides.autoCloak !== undefined
    ? Boolean(botOverrides.autoCloak)
    : e.autoCloak !== undefined
      ? Boolean(e.autoCloak)
      : false;

  // Ignore blacklist when cloaked: per-bot > global explorer > default true (safe when cloaked)
  const ignoreBlacklistWhenCloaked = botOverrides.ignoreBlacklistWhenCloaked !== undefined
    ? Boolean(botOverrides.ignoreBlacklistWhenCloaked)
    : e.ignoreBlacklistWhenCloaked !== undefined
      ? Boolean(e.ignoreBlacklistWhenCloaked)
      : true;

  // Ignore pirate flee when cloaked: per-bot > global explorer > default true (safe when cloaked)
  const ignorePirateFleeWhenCloaked = botOverrides.ignorePirateFleeWhenCloaked !== undefined
    ? Boolean(botOverrides.ignorePirateFleeWhenCloaked)
    : e.ignorePirateFleeWhenCloaked !== undefined
      ? Boolean(e.ignorePirateFleeWhenCloaked)
      : true;

  // Coordinate with other explorers (avoid their targets): per-bot > global explorer > default true
  const coordinateExplorers = botOverrides.coordinateExplorers !== undefined
    ? Boolean(botOverrides.coordinateExplorers)
    : e.coordinateExplorers !== undefined
      ? Boolean(e.coordinateExplorers)
      : true;

  return {
    mode: (mode === "trade_update" ? "trade_update" : mode === "deep_core_scan" ? "deep_core_scan" : mode === "visit_all" ? "visit_all" : mode === "achievement" ? "achievement" : "explore") as ExplorerMode,
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
    autoCloak,
    ignoreBlacklistWhenCloaked,
    ignorePirateFleeWhenCloaked,
    coordinateExplorers,
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

/** Persist visit_all mode setting for a specific bot. */
export function setExplorerVisitAll(username: string, enabled: boolean): void {
  writeSettings({
    [username]: { explorerMode: enabled ? "visit_all" : "explore" },
  });
}

/** Persist achievement mode setting for a specific bot. */
export function setExplorerAchievement(username: string, enabled: boolean): void {
  writeSettings({
    [username]: { explorerMode: enabled ? "achievement" : "explore" },
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

/** Persist auto cloak setting for a specific bot. */
export function setExplorerAutoCloak(username: string, autoCloak: boolean): void {
  writeSettings({
    [username]: { autoCloak },
  });
}

/** Persist ignore blacklist when cloaked setting for a specific bot. */
export function setExplorerIgnoreBlacklistWhenCloaked(username: string, ignoreBlacklistWhenCloaked: boolean): void {
  writeSettings({
    [username]: { ignoreBlacklistWhenCloaked },
  });
}

/** Persist ignore pirate flee when cloaked setting for a specific bot. */
export function setExplorerIgnorePirateFleeWhenCloaked(username: string, ignorePirateFleeWhenCloaked: boolean): void {
  writeSettings({
    [username]: { ignorePirateFleeWhenCloaked },
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

  // DEBUG: Log system blacklist at startup
  const systemBlacklist = getSystemBlacklist();
  ctx.log("info", `Explorer starting - System blacklist contains ${systemBlacklist.length} systems: ${systemBlacklist.length > 0 ? systemBlacklist.join(', ') : 'none'}`);

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
  if (initialSettings.mode === "visit_all") {
    yield* visitAllRoutine(ctx);
    return;
  }
  if (initialSettings.mode === "achievement") {
    yield* achievementRoutine(ctx);
    return;
  }

  // ── Setup exploration coordination ──
  let sendBotChat: ((content: string, channel: BotChatChannel, recipients?: string[], metadata?: Record<string, unknown>) => void) | undefined;
  let getAllBotNames: (() => string[]) | undefined;
  
  if (ctx.sendBotChat) {
    sendBotChat = ctx.sendBotChat;
  }
  if (ctx.getAllBotNames) {
    getAllBotNames = ctx.getAllBotNames;
  }
  
  // Register for coordination messages
  if (getAllBotNames || sendBotChat) {
    botChatChannel.onMessage(bot.username, processExplorationTarget);
    ctx.log("exploration", "Exploration coordination enabled");
  }

  const visitedSystems = new Set<string>();
  const visitedSystemTimes = new Map<string, number>(); // Track when each system was last visited (timestamp)
  const fledFromSystems = new Set<string>(); // Track systems we've fled from due to pirates
  const path: string[] = []; // Track the path of systems visited to enable reverse fleeing
  let lastSystem: string | null = null;

  // ── Startup: fetch map with visited status ──
  yield "fetch_map";
  ctx.log("system", "Fetching galaxy map with visited status...");
  const mapResp = await bot.exec("get_map");
  if (mapResp.result && typeof mapResp.result === "object") {
    const mapData = mapResp.result as Record<string, unknown>;
    const systems = (mapData.systems as Array<Record<string, unknown>>) || [];
    for (const sys of systems) {
      const sysId = (sys.system_id as string) || (sys.id as string);
      if (sysId) {
        mapStore.updateSystem(sys);
      }
    }
    const visitedCount = systems.filter((s: Record<string, unknown>) => s.visited === true).length;
    ctx.log("exploration", `Map loaded: ${systems.length} systems, ${visitedCount} visited by this bot`);
  } else {
    ctx.log("warn", "Could not fetch map data — visited status may be incomplete");
  }

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
      await bot.refreshShip();
      const startFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
      ctx.log("system", `Startup complete — Fuel: ${startFuel}% | Cargo: ${bot.cargo}/${bot.cargoMax}`);
    }
  } else {
    ctx.log("system", "No station in current system — skipping startup prep");
  }

  // Persistent battle state across cycles
  const battleState: BattleState = {
    inBattle: false,
    battleId: null,
    battleStartTick: null,
    lastHitTick: null,
    isFleeing: false,
    lastFleeTime: undefined,
  };

  // Track if we've already enabled cloak (mutation command - don't re-issue)
  let cloakEnabled = false;

  while (bot.state === "running") {
    // ── Death recovery ──
    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) { await ctx.sleep(30000); continue; }

    // ── Enable cloak if autoCloak is enabled and not already cloaked ──
    const cloakSettings = getExplorerSettings(bot.username);
    if (cloakSettings.autoCloak && !bot.isCloaked && !cloakEnabled) {
      ctx.log("system", "Auto-cloak enabled - activating cloak for full-time stealth mode");
      const cloakResp = await bot.exec("cloak", { enable: true });
      if (!cloakResp.error) {
        cloakEnabled = true;
        ctx.log("info", "Cloak activated successfully - bot is now stealthed");
      } else {
        const msg = cloakResp.error.message.toLowerCase();
        if (msg.includes("already cloaked") || msg.includes("already_cloaked")) {
          cloakEnabled = true;
          ctx.log("info", "Cloak already active");
        } else {
          ctx.log("warn", `Cloak command failed: ${cloakResp.error.message}`);
        }
      }
    }

    // ── Clean up expired temporary blacklists ──
    cleanupTemporaryBlacklist();
    cleanupExplorationTargets();

    // ── Battle check — check global battle state first ──
    if (await checkAndFleeFromBattle(ctx, "explorer")) {
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
    if (modeCheck.mode === "visit_all") {
      ctx.log("system", "Mode changed to visit_all — switching routines...");
      yield* visitAllRoutine(ctx);
      return;
    }
    if (modeCheck.mode === "achievement") {
      ctx.log("system", "Mode changed to achievement — switching routines...");
      yield* achievementRoutine(ctx);
      return;
    }

    // ── Get current system data ──
    yield "scan_system";
    await bot.refreshLocation();
    await bot.refreshShip();
    const fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    ctx.log("info", `Exploring ${bot.system} — ${bot.credits} cr, ${fuelPct}% fuel, ${bot.cargo}/${bot.cargoMax} cargo`);

    let { pois, connections, systemId } = await getSystemInfo(ctx);
    if (!systemId) {
      ctx.log("error", "Could not determine current system — waiting 30s");
      await ctx.sleep(30000);
      continue;
    }
    visitedSystems.add(systemId);
    visitedSystemTimes.set(systemId, Date.now());
    mapStore.markSystemVisited(systemId);
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
        // Track wildlife from nearby scan
        bot.trackNearbyPlayers(nearbyResp.result); bot.trackWildlife(nearbyResp.result);
        
        const { parseNearbyForPirates } = await import("./common.js");
        const pirateResult = parseNearbyForPirates(nearbyResp.result);
        
        // Skip pirate flee if cloaked and ignorePirateFleeWhenCloaked is enabled
        if (!bot.isCloaked || !cloakSettings.ignorePirateFleeWhenCloaked) {
          if (pirateResult.hasPirates) {
            ctx.log("combat", `[CRITICAL] Pirates detected near stronghold! ${pirateResult.pirateCount} pirate(s) spotted. Fleeing immediately!`);
            
            // Record pirate sighting with names
            await recordPirateSighting(ctx, systemId, pirateResult.pirates);

            // Add temporary blacklist for this system
            addTemporaryPirateBlacklist(systemId, 10); // 10 minutes

            // CRITICAL: Verify actual current system before fleeing
            // During cascade emergency jumps, lastSystem can get out of sync
            await bot.refreshLocation();
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
        } else if (pirateResult.hasPirates && bot.isCloaked && cloakSettings.ignorePirateFleeWhenCloaked) {
          ctx.log("combat", `[INFO] Pirates detected but cloaked - ignoring flee (ignorePirateFleeWhenCloaked enabled)`);
        }
      }
    }

    // ── Survey the system to reveal hidden POIs ──
    // Only survey if scanPois is enabled
    const explorerSettings = getExplorerSettings(bot.username);

    // Faint signatures (creature hints) reported by the most recent survey this cycle.
    let currentFaintSignatures: FaintSignature[] = [];

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

          if (wormholeExit && (wormholeExit.type === "wormhole_exit" || wormholeExit.type === "wormhole_entrance") && wormholeDestinationId) {
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

          // Capture potential-creature data reported by the survey
          bot.trackSurveyWildlife(surveyResp.result);
          currentFaintSignatures = extractFaintSignatures(surveyResult);
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

    // ── Chase faint signatures (creature hints) ──
    // visit_all mode already visits every POI, so only do this in other modes.
    if (currentFaintSignatures.length > 0 && explorerSettings.mode !== "visit_all") {
      const sigPois = findPoisFromFaintSignatures(currentFaintSignatures, pois);
      for (const poi of sigPois) {
        if (!toVisit.some((t) => t.poi.id === poi.id)) {
          toVisit.push({ poi, reason: "faint-signature" });
        }
      }
      if (sigPois.length > 0) {
        ctx.log("wildlife", `Following ${sigPois.length} faint signature(s) to potential creature location(s): ${sigPois.map((p) => p.name).join(", ")}`);
      }
    }

    if (toVisit.length === 0) {
      ctx.log("info", `${bot.system}: all ${skippedCount} POIs up to date — moving on`);
    } else {
      ctx.log("info", `${bot.system}: ${toVisit.length} to visit, ${skippedCount} already explored`);
    }

// ── Hull check — repair if <= 40% ──
    await bot.refreshShip();
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
    await bot.refreshLocation();
    if (bot.system !== systemId) {
      ctx.log("info", `Moved to ${bot.system} during repair/refuel — restarting system scan`);
      continue;
    }

    // ── Undock if docked ──
    await ensureUndocked(ctx);

    // Find station for emergency refueling
    const station = findStation(pois);

    // ── Visit each POI ──
    let wormholeJumped = false;
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
      await bot.refreshLocation();
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

      // ── Wormhole test: travel to wh POI then jump with same POI id ──
      const isWormholePoi = poi.id.startsWith("wh_") || poi.type?.includes("wormhole");
      if (isWormholePoi) {
        ctx.log("info", `🌌 Testing wormhole ${poi.id}...`);
        yield `test_wormhole_${poi.id}`;
        const jumpResp = await bot.exec("jump", { target_poi: poi.id });
        if (!jumpResp.error) {
          const r = jumpResp.result as Record<string, unknown> | undefined;
          if (r && r.action === "jumped") {
            // from_system/system are display names ("Alzirr"); the map is keyed
            // by ids ("alzirr"), so never feed a name in as a system id.
            const fromSystemName = (r.from_system as string) || systemId;
            const exitPoi = (r.poi as string) || poi.id;
            const destSystemName = (r.system as string) || "";
            // bot.system is already updated to the arrival system by the jump.
            const destSystemId = (r.system_id as string)
              || (bot.system && bot.system !== systemId ? bot.system : "");
            ctx.log("info", `🌌 Wormhole jumped: ${fromSystemName} -> ${destSystemName || destSystemId} (${exitPoi})`);
            if (destSystemId) {
              mapStore.registerWormhole(destSystemId, {
                id: exitPoi,
                name: exitPoi,
                exit_system_id: destSystemId,
                exit_system_name: destSystemName || destSystemId,
                exit_poi_id: exitPoi,
                exit_poi_name: exitPoi,
                // The entrance is the system we just left, not wherever the
                // bot happens to be standing now.
                destination_system_id: systemId,
                destination_system_name: fromSystemName,
              });
            } else {
              ctx.log("warn", `Wormhole ${poi.id} jumped but no destination system id was reported — not recording it`);
            }
            // Mark both entrance and exit POIs explored
            mapStore.markExplored(systemId, poi.id);
            if (destSystemId) mapStore.markExplored(destSystemId, exitPoi);
          }
        }
        // Refresh location after wormhole jump
        await bot.refreshLocation();
        if (bot.system && bot.system !== systemId) {
          // We're in a whole different system now — abandon this system's POI
          // list and rescan from the top of the outer loop.
          wormholeJumped = true;
          break;
        }
        continue;
      }

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

      // ── Check cargo — if full with non-fuel-cell items, return to the home base to deposit ──
      await bot.refreshCargoAndStorage();
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
           await bot.refreshLocation();
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

    // A wormhole dropped us in a brand new system — rescan it from scratch
    // instead of picking a next system based on the one we just left.
    if (wormholeJumped) {
      ctx.log("info", `Arrived in ${bot.system} via wormhole — restarting system scan`);
      continue;
    }

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
      if (fuelCellCheck.totalFuelCells < 3) {
        ctx.log("system", `Fuel cells almost depleted (${fuelCellCheck.totalFuelCells} remaining) — returning to home base to restock military fuel cells`);
        yield "return_to_home_fuel_cells";
        const returned = await returnToHomeBaseForFuelCells(ctx);
        if (returned) {
          await bot.refreshLocation();
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
      const unknowns = findUnknownSystemsWithCoordination(ctx, systemId, blacklist, fledFromSystems, currentSettings.ignoreBlacklistWhenCloaked, bot.isCloaked);

      if (unknowns.length > 0) {
        // Pick the nearest high-priority target (unknown first, then stale)
        const target = unknowns[0];
        const priorityLabel = target.priority === "unknown" ? "unknown" : "stale";
        const staleInfo = target.priority === "stale" && target.oldestPoiUpdate
          ? ` (oldest data: ${timeAgoFromIso(target.oldestPoiUpdate)})`
          : "";
        ctx.log("exploration", `Direct-to-${priorityLabel}: Found ${unknowns.length} system(s) needing exploration, targeting nearest: ${target.name} (${target.distance} jumps)${staleInfo}`);
        
        // Announce our target to other explorers via bot chat
        if (sendBotChat && getAllBotNames) {
          const allBots = getAllBotNames();
          const otherBots = allBots.filter(name => name !== bot.username);
          if (otherBots.length > 0) {
            announceExplorationTarget(ctx, target.id);
          }
        }
        
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
        const arrived = await navigateToSystem(ctx, target.id, { fuelThresholdPct: currentSettings.refuelThreshold, hullThresholdPct: 30, skipBlacklist: currentSettings.ignoreBlacklistWhenCloaked && bot.isCloaked });
        if (!arrived) {
          ctx.log("error", `Could not reach ${target.name || target.id} — will retry next loop`);
          await ctx.sleep(10000);
          continue;
        }

        ctx.log("travel", `Arrived at ${target.name || target.id}`);
        bot.stats.totalSystems++;
        path.push(target.id); // Track the arrived system in path
        
        // Update visited status from server after arrival
        yield "update_visited_status";
        const updateMapResp = await bot.exec("get_map");
        if (updateMapResp.result && typeof updateMapResp.result === "object") {
          const mapData = updateMapResp.result as Record<string, unknown>;
          const systems = (mapData.systems as Array<Record<string, unknown>>) || [];
          for (const sys of systems) {
            const sysId = (sys.system_id as string) || (sys.id as string);
            if (sysId) {
              mapStore.updateSystem(sys);
            }
          }
        }
        
        await checkCustomsInspection(ctx, systemId);

        // Check for pirates and battle
        const nearbyResp = await bot.exec("get_nearby");
        if (await checkBattleAfterCommand(ctx, nearbyResp.notifications, "get_nearby")) {
          ctx.log("error", "Battle detected after arrival - fleeing!");
          await ctx.sleep(30000);
          continue;
        }
if (nearbyResp.result && typeof nearbyResp.result === "object") {
           // Track wildlife from nearby scan
           bot.trackNearbyPlayers(nearbyResp.result); bot.trackWildlife(nearbyResp.result);
           
           // Skip pirate flee if cloaked and ignorePirateFleeWhenCloaked is enabled
           if (!bot.isCloaked || !currentSettings.ignorePirateFleeWhenCloaked) {
             const fled = await checkAndFleeFromPirates(ctx, nearbyResp.result);
             if (fled) {
               ctx.log("error", "Pirates detected - fled, will retry");
               fledFromSystems.add(systemId);
               await ctx.sleep(30000);
               continue;
             }
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

    // DEBUG: Check for any blacklisted systems in connections
    const blacklist = getSystemBlacklist();
    const blacklistedInConnections = validConns.filter(c => blacklist.some(b => b.toLowerCase() === c.id.toLowerCase()));
    if (blacklistedInConnections.length > 0) {
      ctx.log("warning", `Found ${blacklistedInConnections.length} blacklisted systems in current connections: ${blacklistedInConnections.map(c => c.id).join(', ')}`);
    }

    // ── Coordination: avoid systems other active explorers are targeting ──
    const claimedTargets = currentSettings.coordinateExplorers ? getClaimedTargets() : null;

    const nextSystem = pickNextSystem(ctx, validConns, visitedSystems, visitedSystemTimes, lastSystem, fledFromSystems, path, bot.isCloaked, currentSettings.ignoreBlacklistWhenCloaked, claimedTargets);

    // ── Coordination: Announce our target to other explorers ──
    if (currentSettings.coordinateExplorers && sendBotChat && getAllBotNames && nextSystem) {
      const allBots = getAllBotNames();
      const otherBots = allBots.filter(name => name !== bot.username);
      if (otherBots.length > 0) {
        announceExplorationTarget(ctx, nextSystem.id);
      }
    }
    
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
        const random = pickSmartConnection(ctx, validConns, lastSystem, visitedSystems, visitedSystemTimes, fledFromSystems, path, bot.isCloaked, currentSettings.ignoreBlacklistWhenCloaked);
        if (!random) {
          ctx.log("error", "No valid non-blacklisted connections available! Explorer is trapped. Attempting to backtrack...");
          if (path.length >= 2) {
            const backtrackTarget = path[path.length - 2];
            const currentSystem = path[path.length - 1];
            ctx.log("system", `Backtracking from ${currentSystem} to ${backtrackTarget}...`);
            path.pop();
            await ensureUndocked(ctx);
            const backtrackResp = await bot.exec("jump", { target_system: backtrackTarget });
            if (backtrackResp.error) {
              ctx.log("error", `Backtrack failed: ${backtrackResp.error.message}`);
              await ctx.sleep(60000);
            } else {
              ctx.log("travel", `Backtracked to ${backtrackTarget}`);
              bot.stats.totalSystems++;
              lastSystem = currentSystem;
              await ctx.sleep(5000);
            }
            continue;
          } else {
            ctx.log("error", "No path to backtrack - explorer is completely trapped. Waiting before retry...");
            await ctx.sleep(60000);
            continue;
          }
        }
        await ensureUndocked(ctx);
        ctx.log("travel", `Jumping to ${random.name || random.id}...`);
        const jumpResp = await bot.exec("jump", { target_system: random.id });
        if (jumpResp.error) {
          if (!jumpResp.error.message) {
            ctx.log("error", `Jump response has undefined/null error message`);
            await ctx.sleep(10000);
            continue;
          }
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
          // Track wildlife from nearby scan
          bot.trackNearbyPlayers(nearbyResp.result); bot.trackWildlife(nearbyResp.result);
          
          // Skip pirate flee if cloaked and ignorePirateFleeWhenCloaked is enabled
          if (!bot.isCloaked || !currentSettings.ignorePirateFleeWhenCloaked) {
            const fled = await checkAndFleeFromPirates(ctx, nearbyResp.result);
            if (fled) {
              ctx.log("error", "Pirates detected - fled, will retry");
              fledFromSystems.add(systemId); // Mark this system as hostile
              await ctx.sleep(30000);
              continue;
            }
          }
        }
        lastSystem = systemId;
        continue;
      } else {
        ctx.log("error", "No connections from this system — attempting to backtrack...");
        if (path.length >= 2) {
          const backtrackTarget = path[path.length - 2];
          const currentSystem = path[path.length - 1];
          ctx.log("system", `Backtracking from ${currentSystem} to ${backtrackTarget}...`);
          path.pop();
          await ensureUndocked(ctx);
          const backtrackResp = await bot.exec("jump", { target_system: backtrackTarget });
          if (backtrackResp.error) {
            ctx.log("error", `Backtrack failed: ${backtrackResp.error.message}`);
            await ctx.sleep(60000);
          } else {
            ctx.log("travel", `Backtracked to ${backtrackTarget}`);
            bot.stats.totalSystems++;
            lastSystem = currentSystem;
            await ctx.sleep(5000);
          }
          continue;
        } else {
          ctx.log("error", "No connections and no path to backtrack - explorer is completely trapped. Waiting 60s...");
          await ctx.sleep(60000);
        }
      }
      continue;
    }

    // Final fuel verify before jumping
    await bot.refreshShip();
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
      if (!jumpResp.error.message) {
        ctx.log("error", `Jump response has undefined/null error message`);
        await ctx.sleep(10000);
        continue;
      }
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
      // Track wildlife from nearby scan
      bot.trackNearbyPlayers(nearbyResp.result); bot.trackWildlife(nearbyResp.result);
      
      // Skip pirate flee if cloaked and ignorePirateFleeWhenCloaked is enabled
      if (!bot.isCloaked || !currentSettings.ignorePirateFleeWhenCloaked) {
        const fled = await checkAndFleeFromPirates(ctx, nearbyResp.result);
        if (fled) {
          ctx.log("error", "Pirates detected - fled, will retry");
          fledFromSystems.add(systemId); // Mark this system as hostile
          await ctx.sleep(30000);
          continue;
        }
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
      supported_power: (r.supported_power as number) || 0,
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
      supported_power: (r.supported_power as number) || 0,
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

/** Check if a station has the faction_trade_intel facility. */
async function hasFactionTradeIntelFacility(ctx: RoutineContext, stationId: string): Promise<boolean> {
  const { bot } = ctx;
  const poiResp = await bot.exec("get_poi", { poi_id: stationId });
  if (poiResp.error || !poiResp.result) return false;
  
  const result = poiResp.result as Record<string, unknown>;
  const base = (result.base as Record<string, unknown>) || {};
  const facilities = (base.facilities as string[]) || [];
  
  return facilities.includes("faction_trade_intel");
}

/** Submit market price observations to the faction's trade ledger. */
async function submitTradeIntel(
  ctx: RoutineContext,
  systemId: string,
  stationPoiId: string,
  stationName: string,
  items: Array<Record<string, unknown>>,
): Promise<void> {
  const { bot } = ctx;
  
  const stationsPayload = [{
    base_id: stationPoiId,
    station_name: stationName,
    items: items.map(item => {
      const buyOrders = ((item.buy_orders as Array<Record<string, unknown>>) || []).map((order: Record<string, unknown>) => ({
        price: (order.price_each as number) || (order.price as number) || 0,
        quantity: (order.quantity as number) || 0,
      })).filter((order: { price: number; quantity: number }) => order.price > 0 && order.quantity > 0);

      const sellOrders = ((item.sell_orders as Array<Record<string, unknown>>) || []).map((order: Record<string, unknown>) => ({
        price: (order.price_each as number) || (order.price as number) || 0,
        quantity: (order.quantity as number) || 0,
      })).filter((order: { price: number; quantity: number }) => order.price > 0 && order.quantity > 0);

      const bestBuy = buyOrders.length > 0 ? Math.max(...buyOrders.map(o => o.price)) : 0;
      const bestSell = sellOrders.length > 0 ? Math.min(...sellOrders.map(o => o.price)) : 0;
      const buyVolume = buyOrders.reduce((sum, o) => sum + o.quantity, 0);
      const sellVolume = sellOrders.reduce((sum, o) => sum + o.quantity, 0);

      return {
        item_id: (item.item_id as string) || (item.id as string) || "",
        item_name: (item.name as string) || (item.item_name as string) || "",
        best_buy: bestBuy,
        best_sell: bestSell,
        buy_volume: buyVolume,
        sell_volume: sellVolume,
      };
    }).filter((item: { item_id: string; best_buy: number; best_sell: number }) => item.item_id && (item.best_buy > 0 || item.best_sell > 0))
  }];

  if (stationsPayload[0].items.length === 0) {
    ctx.log("info", "No valid market items to submit as trade intel");
    return;
  }

  const submitResp = await bot.exec("faction_submit_trade_intel", { stations: stationsPayload });
  
  if (submitResp.error) {
    ctx.log("warn", `Failed to submit trade intel: ${submitResp.error.message}`);
  } else {
    ctx.log("info", `Submitted trade intel for ${stationsPayload[0].items.length} items to faction`);
  }
}

/** Dock at station, scan market/orders/missions, refuel. */
async function* scanStation(
  ctx: RoutineContext,
  systemId: string,
  poi: SystemPOI,
): AsyncGenerator<string, void, void> {
  const { bot } = ctx;

  try {
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
        const observations: MarketItemObservation[] = [];

        ctx.log("info", `Saving detailed market data for ${items.length} items...`);

        for (const item of items) {
          const itemId = (item.item_id as string) || (item.id as string) || "";
          const itemName = (item.name as string) || (item.item_name as string) || itemId;

          if (!itemId) continue;

          let buyOrders = ((item.buy_orders as Array<Record<string, unknown>>) || []).map(order => ({
            price: (order.price_each as number) || (order.price as number) || 0,
            quantity: (order.quantity as number) || 0,
          })).filter(order => order.price > 0 && order.quantity > 0);

          let sellOrders = ((item.sell_orders as Array<Record<string, unknown>>) || []).map(order => ({
            price: (order.price_each as number) || (order.price as number) || 0,
            quantity: (order.quantity as number) || 0,
          })).filter(order => order.price > 0 && order.quantity > 0);

          // Stricter check: if buy orders and sell orders appear swapped (max buy < min sell), correct it
          if (buyOrders.length > 0 && sellOrders.length > 0) {
            const maxBuy = Math.max(...buyOrders.map(o => o.price));
            const minSell = Math.min(...sellOrders.map(o => o.price));
            if (maxBuy < minSell) {
              ctx.log("warn", `Detected potentially swapped buy/sell orders for ${itemName} at ${poi.name} — correcting`);
              [buyOrders, sellOrders] = [sellOrders, buyOrders];
            }
          }

          observations.push({ itemId, itemName, buyOrders, sellOrders });
        }

        // Memory-only upsert; marketDetailsStore persists on its 2-min cadence
        // (and on shutdown) instead of rewriting the whole ~10MB file here.
        const detailsUpdated = marketDetailsStore.upsertItems(systemId, poi.id, poi.name, observations) > 0;

        if (detailsUpdated) {
          ctx.log("info", `Recorded detailed market data for ${items.length} items`);

          // Submit trade intel to faction if station has the facility
          const hasTradeIntel = await hasFactionTradeIntelFacility(ctx, poi.id);
          if (hasTradeIntel) {
            yield "submit_trade_intel";
            await submitTradeIntel(ctx, systemId, poi.id, poi.name, items);
          }
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

        // Save raw mission data for collection with deduplication
        const rawMissions = loadRawMissions();
        let newMissions = 0;
        let updatedMissions = 0;

        for (const mission of missions) {
          const missionId = (mission.mission_id as string) || (mission.id as string) || "";
          if (!missionId) continue;

          const stationInfo = {
            systemId,
            stationPoiId: poi.id,
            stationName: poi.name,
            lastSeen: now(),
          };

          if (rawMissions.missions[missionId]) {
            // Mission already exists, check if this station is already recorded
            const existing = rawMissions.missions[missionId];
            const stationExists = existing.stations.some(s =>
              s.systemId === systemId && s.stationPoiId === poi.id
            );

            if (!stationExists) {
              existing.stations.push(stationInfo);
              updatedMissions++;
            }

            // Update last seen globally
            existing.lastSeen = now();
          } else {
            // New mission
            rawMissions.missions[missionId] = {
              missionId,
              data: mission,
              stations: [stationInfo],
              firstSeen: now(),
              lastSeen: now(),
            };
            newMissions++;
          }
        }

        if (newMissions > 0 || updatedMissions > 0) {
          saveRawMissions(rawMissions);
          const updateMsg = [];
          if (newMissions > 0) updateMsg.push(`${newMissions} new`);
          if (updatedMissions > 0) updateMsg.push(`${updatedMissions} updated`);
          ctx.log("info", `Collected raw mission data: ${updateMsg.join(", ")} at ${poi.name} (${missions.length} total available)`);
        }
      }
    }

    // Station scan summary
    const scanParts: string[] = [];
    if (marketCount > 0) scanParts.push(`${marketCount} market items`);
    if (missionCount > 0) scanParts.push(`${missionCount} missions`);
    ctx.log("info", `Scanned ${poi.name}: ${scanParts.length > 0 ? scanParts.join(", ") : "empty station"}`);

    // Refuel
    yield `refuel_${poi.id}`;
    await bot.refreshShip();
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

    // Browse ships for sale while docked
    yield `browse_ships_${poi.id}`;
    const browseResp = await bot.exec("browse_ships");

    // Check for battle after browse_ships
    if (await checkBattleAfterCommand(ctx, browseResp.notifications, "browse_ships")) {
      ctx.log("combat", "Battle detected during ship browsing - fleeing!");
      await ctx.sleep(5000);
      return;
    }

    if (browseResp.error) {
      ctx.log("error", `browse_ships failed: ${browseResp.error.message}`);
    } else if (browseResp.result && typeof browseResp.result === "object") {
      const result = browseResp.result as Record<string, unknown>;
      const listings = (
        Array.isArray(result.listings) ? result.listings : []
      ) as Array<Record<string, unknown>>;

      if (listings.length > 0) {
        updateShipListings(systemId, poi.id, poi.name, listings, ctx.log);
      }
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

  } finally {
    mapStore.markExplored(systemId, poi.id);
  }
}

/** Visit a non-minable, non-station POI — check what's nearby. */
/**
 * Extract faint signatures (creature hints) from a survey_system result.
 * Returns [] when the survey produced none or the result is malformed.
 */
function extractFaintSignatures(surveyResult: Record<string, unknown> | undefined): FaintSignature[] {
  if (!surveyResult || typeof surveyResult !== "object") return [];
  const raw = Array.isArray(surveyResult.faint_signatures) ? surveyResult.faint_signatures : [];
  return (raw as Array<Record<string, unknown>>)
    .filter((s) => s && (s.hint || s.type))
    .map((s) => ({
      type: (s.type as string) || "",
      hint: (s.hint as string) || "",
      difficulty: (s.difficulty as string) || undefined,
    }));
}

/**
 * Map faint signatures from a survey to candidate POIs in the current system.
 * A signature's `type` is matched against POI types first (exact, then
 * substring both ways); failing that, the free-text `hint` is scanned for a
 * POI name or any POI-type keyword. Returns the unique POIs best matched by
 * each signature.
 */
function findPoisFromFaintSignatures(
  signatures: FaintSignature[],
  pois: SystemPOI[],
): SystemPOI[] {
  const result: SystemPOI[] = [];
  const seen = new Set<string>();

  for (const sig of signatures) {
    if (!sig.hint && !sig.type) continue;
    const match = matchFaintSignatureToPoi(sig, pois);
    if (match && !seen.has(match.id)) {
      seen.add(match.id);
      result.push(match);
    }
  }
  return result;
}

function matchFaintSignatureToPoi(sig: FaintSignature, pois: SystemPOI[]): SystemPOI | null {
  const type = (sig.type || "").toLowerCase().trim();
  if (type) {
    const exact = pois.find((p) => p.type.toLowerCase() === type);
    if (exact) return exact;
    const partial = pois.find(
      (p) => p.type.toLowerCase().includes(type) || type.includes(p.type.toLowerCase()),
    );
    if (partial) return partial;
  }

  const hint = (sig.hint || "").toLowerCase();
  if (hint) {
    const byName = pois.find(
      (p) => hint.includes(p.name.toLowerCase()) || p.name.toLowerCase().includes(hint),
    );
    if (byName) return byName;

    for (const p of pois) {
      const words = p.type.toLowerCase().split(/[_\s-]+/).filter((w) => w.length > 2);
      if (words.some((w) => hint.includes(w))) return p;
    }
  }
  return null;
}

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
    bot.trackNearbyPlayers(nearbyResp.result); bot.trackWildlife(nearbyResp.result);

    // Check for pirates and flee if detected (skip if cloaked and ignorePirateFleeWhenCloaked is enabled)
    const { checkAndFleeFromPirates } = await import("./common.js");
    const settings = getExplorerSettings(bot.username);
    if (!bot.isCloaked || !settings.ignorePirateFleeWhenCloaked) {
      const fled = await checkAndFleeFromPirates(ctx, nearbyResp.result);
      if (fled) {
        // We've fled - mark this system as hostile and abort this POI scan
        fledFromSystems.add(systemId);
        return;
      }
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
  await bot.refreshLocation();
  if (path.length === 0 && bot.system) {
    path.push(bot.system);
  }

  // ── Startup: dock at local station to clear cargo & refuel ──
  yield "startup_prep";
  await bot.refreshLocation();
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

      // Load fuel cells to max cargo (deep core scans involve long trips between hidden POIs)
      const startupSettings = getExplorerSettings(bot.username);
      if (startupSettings.loadFuelCellsAtHome) {
        yield "startup_load_fuel_cells";
        await loadFuelCellsToMax(ctx);
      }

      yield "startup_refuel";
      await tryRefuel(ctx);
      await bot.refreshShip();
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
        // Skip blacklisted systems (persistent + temporary) unless cloaked
        const settings = getExplorerSettings(bot.username);
        if (!bot.isCloaked && (blacklist.some(b => b.toLowerCase() === hiddenPoi.systemId.toLowerCase()) || isTemporarilyBlacklisted(hiddenPoi.systemId))) {
          ctx.log("info", `Skipping blacklisted system: ${hiddenPoi.systemName}`);
          continue;
        }
        const arrived = await navigateToSystem(ctx, hiddenPoi.systemId, { fuelThresholdPct: FUEL_SAFETY_PCT, hullThresholdPct: 30, skipBlacklist: settings.ignoreBlacklistWhenCloaked && bot.isCloaked });
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
        bot.trackSurveyWildlife(surveyResp.result);
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
      await bot.refreshCargo();
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
            await bot.refreshLocation();
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
    await bot.refreshShip();
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

  const { modules } = extractShipModules(shipResp.result);

  for (const mod of modules) {
    const checkStr = moduleHaystack(mod);
    if (checkStr.includes("deep_core_survey_scanner") ||
        checkStr.includes("deep core survey scanner") ||
        checkStr.includes("deep_core_detection")) {
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
  const fledFromSystems = new Set<string>();
  const path: string[] = [];
  let cloakEnabled = false;

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

    // Load fuel cells to max cargo (explorers don't use their inventory for anything)
    const startupSettings = getExplorerSettings(bot.username);
    if (startupSettings.loadFuelCellsAtHome) {
      yield "startup_load_fuel_cells";
      await loadFuelCellsToMax(ctx);
    }

    await tryRefuel(ctx);
    await bot.refreshLocation();
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

    // ── Re-check mode after recovery ──
    const modeCheck = getExplorerSettings(bot.username);
    if (modeCheck.mode !== "trade_update") {
      ctx.log("system", "Mode changed to explore — restarting as explorer...");
      break;
    }

    // ── Enable cloak if autoCloak is enabled and not already cloaked ──
    const cloakSettings = getExplorerSettings(bot.username);
    if (cloakSettings.autoCloak && !bot.isCloaked && !cloakEnabled) {
      ctx.log("system", "Auto-cloak enabled - activating cloak for full-time stealth mode");
      const cloakResp = await bot.exec("cloak", { enable: true });
      if (!cloakResp.error) {
        cloakEnabled = true;
        ctx.log("info", "Cloak activated successfully - bot is now stealthed");
      } else {
        const msg = cloakResp.error.message.toLowerCase();
        if (msg.includes("already cloaked") || msg.includes("already_cloaked")) {
          cloakEnabled = true;
          ctx.log("info", "Cloak already active");
        } else {
          ctx.log("warn", `Cloak command failed: ${cloakResp.error.message}`);
        }
      }
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
    const isCloaked = bot.isCloaked;

    for (const [sysId, sys] of Object.entries(allSystems)) {
      // Skip pirate systems — they are hostile!
      if (isPirateSystem(sysId)) continue;
      // Skip blacklisted systems (persistent + temporary + fled from)
      // Unless cloaked and ignoreBlacklistWhenCloaked is enabled
      if (!isCloaked || !focusSettings.ignoreBlacklistWhenCloaked) {
        if (blacklist.some(b => b.toLowerCase() === sysId.toLowerCase())) continue;
        if (isTemporarilyBlacklisted(sysId)) continue;
        if (fledFromSystems.has(sysId)) continue;
      }

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
        const arrived = await navigateToSystem(ctx, target.systemId, { fuelThresholdPct: FUEL_SAFETY_PCT, hullThresholdPct: 30, skipBlacklist: isCloaked && focusSettings.ignoreBlacklistWhenCloaked });
        if (!arrived) {
          ctx.log("error", `Could not reach ${target.systemName} — skipping`);
          continue;
        }
        path.push(target.systemId);
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

      // Check for pirates before docking
      const nearbyResp = await bot.exec("get_nearby");
      if (nearbyResp.result && typeof nearbyResp.result === "object") {
        // Track wildlife from nearby scan
        bot.trackNearbyPlayers(nearbyResp.result); bot.trackWildlife(nearbyResp.result);
        
        const tradeSettings = getExplorerSettings(bot.username);
        if (!bot.isCloaked || !tradeSettings.ignorePirateFleeWhenCloaked) {
          const fled = await checkAndFleeFromPirates(ctx, nearbyResp.result);
          if (fled) {
            ctx.log("error", "Pirates detected - fled, will retry");
            fledFromSystems.add(target.systemId);
            await ctx.sleep(30000);
            continue;
          }
        }
      }

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
              const observations: MarketItemObservation[] = [];

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

                observations.push({ itemId, itemName, buyOrders, sellOrders });
              }

              const detailsUpdated = marketDetailsStore.upsertItems(
                target.systemId, target.stationPoi, target.stationName, observations,
              ) > 0;

              if (detailsUpdated) {
                ctx.log("info", `Recorded detailed market data for ${items.length} items`);

                // Submit trade intel to faction if station has the facility
                const hasTradeIntel = await hasFactionTradeIntelFacility(ctx, target.stationPoi);
                if (hasTradeIntel) {
                  yield "submit_trade_intel";
                  await submitTradeIntel(ctx, target.systemId, target.stationPoi, target.stationName, items);
                }
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

          // Browse ships for sale if in trade_update mode
          const settings = getExplorerSettings(bot.username);
          if (settings.mode === "trade_update") {
            const browseResp = await bot.exec("browse_ships");

            // Check for battle after browse_ships
            if (await checkBattleAfterCommand(ctx, browseResp.notifications, "browse_ships")) {
              ctx.log("combat", "Battle detected during ship browsing - fleeing!");
              await ctx.sleep(5000);
              return;
            }

            if (browseResp.result && typeof browseResp.result === "object") {
              const result = browseResp.result as Record<string, unknown>;
              const listings = (
                Array.isArray(result.listings) ? result.listings : []
              ) as Array<Record<string, unknown>>;

              if (listings.length > 0) {
                updateShipListings(target.systemId, target.stationPoi, target.stationName, listings, ctx.log);
              }
            }
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
      await bot.refreshCargo();
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
        if (fuelCellCheck.totalFuelCells < 3) {
          ctx.log("system", `Fuel cells almost depleted (${fuelCellCheck.totalFuelCells} remaining) — returning to home base to restock military fuel cells`);
          yield "return_to_home_fuel_cells";
          const returned = await returnToHomeBaseForFuelCells(ctx);
          if (returned) {
            await bot.refreshLocation();
            ctx.log("info", `Returned to home base — continuing exploration`);
            continue;
          }
        }
        
      }

      // ── Check skills ──
      yield "check_skills";
      await bot.checkSkills();

      await bot.refreshShip();
    }

    await bot.refreshShip();
    const cycleFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    ctx.log("info", `Trade update cycle done — ${stationSystems.length} stations, ${bot.credits} cr, ${cycleFuel}% fuel`);
    await ctx.sleep(5000);
  }
}

// ── Visit All Systems Routine ───────────────────────────────────

/**
 * Visit all systems mode — systematically visits every system in the galaxy
 * to update the server's visited flag and achieve 100% exploration.
 */
async function* visitAllRoutine(ctx: RoutineContext): AsyncGenerator<string, void, void> {
  const { bot } = ctx;

  ctx.log("system", "Visit All mode — systematically visiting all systems to update visited flags...");

  const visitedSystems = new Set<string>();
  const fledFromSystems = new Set<string>();
  const path: string[] = [];
  let lastSystem: string | null = null;

  // Get initial system info
  yield "startup";
  await bot.refreshLocation();
  let { systemId } = await getSystemInfo(ctx);
  if (!systemId) {
    ctx.log("error", "Could not determine current system — waiting 30s");
    await ctx.sleep(30000);
    return;
  }

  const blacklist = getSystemBlacklist();

  // ── Startup: dock at local station to clear cargo, pack fuel cells & refuel ──
  yield "startup_prep";
  await bot.refreshLocation();
  const { pois: startPois } = await getSystemInfo(ctx);
  const startStation = findStation(startPois);
  if (startStation) {
    ctx.log("system", `Startup: docking at ${startStation.name} to clear cargo & refuel...`);

    if (bot.poi !== startStation.id) {
      await ensureUndocked(ctx);
      const tResp = await bot.exec("travel", { target_poi: startStation.id });
      if (!tResp.error || tResp.error.message.includes("already")) {
        bot.poi = startStation.id;
      }
    }

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

      // Load fuel cells to max cargo (long trips visiting every system)
      const startupSettings = getExplorerSettings(bot.username);
      if (startupSettings.loadFuelCellsAtHome) {
        yield "startup_load_fuel_cells";
        await loadFuelCellsToMax(ctx);
      }

      // Refuel
      yield "startup_refuel";
      await tryRefuel(ctx);
      await bot.refreshShip();
      const startFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
      ctx.log("system", `Startup complete — Fuel: ${startFuel}% | Cargo: ${bot.cargo}/${bot.cargoMax}`);
    }
  } else {
    ctx.log("system", "No station in current system — skipping startup prep");
  }

  // ── Register for exploration coordination messages ──
  botChatChannel.onMessage(bot.username, processExplorationTarget);

  while (bot.state === "running") {
    // Check for battle
    if (await checkAndFleeFromBattle(ctx, "visit_all")) {
      await ctx.sleep(5000);
      continue;
    }

    // Refresh settings
    const settings = getExplorerSettings(bot.username);

    await bot.refreshShip();
    const fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    ctx.log("info", `Visit All ${bot.system} — ${bot.credits} cr, ${fuelPct}% fuel`);

    let { pois, connections, systemId } = await getSystemInfo(ctx);
    if (!systemId) {
      await ctx.sleep(30000);
      continue;
    }

    // Mark this system as visited (both locally and via mapStore)
    visitedSystems.add(systemId);
    mapStore.markSystemVisited(systemId);

    // Get visit stats
    const stats = mapStore.getVisitStats();
    ctx.log("exploration", `Progress: ${stats.visited}/${stats.total} systems visited (${Math.round(stats.visited/stats.total*100)}%)`);

    // Check if we're done
    if (stats.unvisited === 0) {
      ctx.log("info", "All systems visited! Explore mode complete.");
      return;
    }

    // Find unvisited systems reachable from current position
    const unvisited = findUnvisitedSystemsByServerFlag(ctx, systemId, blacklist, fledFromSystems);

    // Coordination: avoid systems other active explorers are currently targeting
    const visitAllClaimed = settings.coordinateExplorers ? getClaimedTargets() : null;

    if (unvisited.length === 0) {
      ctx.log("info", "No unvisited systems in connected region — picking nearest unvisited from map...");
      
      // Get all unvisited systems and find nearest
      const allUnvisited = mapStore.getUnvisitedSystems();
      if (allUnvisited.length === 0) {
        ctx.log("info", "All systems visited! Explore mode complete.");
        return;
      }

      // Find nearest unvisited system
      const allPos = mapStore.getAllSystemPositionsRecord();
      const currentPos = allPos[systemId];
      if (!currentPos) {
        ctx.log("error", "Could not get current position — waiting 30s");
        await ctx.sleep(30000);
        continue;
      }

      // Sort by distance
      allUnvisited.sort((a, b) => {
        const aPos = allPos[a.systemId];
        const bPos = allPos[b.systemId];
        if (!aPos || !bPos) return 0;
        const aDist = Math.sqrt(Math.pow(aPos.x - currentPos.x, 2) + Math.pow(aPos.y - currentPos.y, 2));
        const bDist = Math.sqrt(Math.pow(bPos.x - currentPos.x, 2) + Math.pow(bPos.y - currentPos.y, 2));
        return aDist - bDist;
      });

      const target = pickCoordinatedTarget(allUnvisited, visitAllClaimed, u => u.systemId);
      if (!target) {
        ctx.log("info", "All systems visited! Explore mode complete.");
        return;
      }

      // Announce our target to other explorers for coordination
      if (settings.coordinateExplorers && ctx.sendBotChat && ctx.getAllBotNames) {
        const otherBots = ctx.getAllBotNames().filter(n => n !== bot.username);
        if (otherBots.length > 0) {
          announceExplorationTarget(ctx, target.systemId);
        }
      }

      ctx.log("travel", `Navigating to ${target.systemName} (${target.systemId})...`);
      const arrived = await navigateToSystem(ctx, target.systemId, { fuelThresholdPct: settings.refuelThreshold, hullThresholdPct: 30, skipBlacklist: settings.ignoreBlacklistWhenCloaked && bot.isCloaked });
      if (!arrived) {
        await ctx.sleep(10000);
        continue;
      }
      bot.stats.totalSystems++;
      path.push(target.systemId);
      lastSystem = target.systemId;
      continue;
    }

    // Jump to nearest unvisited system
    const target = pickCoordinatedTarget(unvisited, visitAllClaimed, u => u.id);
    if (!target) {
      await ctx.sleep(5000);
      continue;
    }

    // Announce our target to other explorers for coordination
    if (settings.coordinateExplorers && ctx.sendBotChat && ctx.getAllBotNames) {
      const otherBots = ctx.getAllBotNames().filter(n => n !== bot.username);
      if (otherBots.length > 0) {
        announceExplorationTarget(ctx, target.id);
      }
    }

    ctx.log("travel", `Jumping to ${target.name} (${target.id}) - ${target.distance} jumps away`);

    // Ensure fueled
    const fueled = await ensureFueled(ctx, settings.refuelThreshold);
    if (!fueled) {
      await ctx.sleep(30000);
      continue;
    }

    await ensureUndocked(ctx);
    const jumpResp = await bot.exec("jump", { target_system: target.id });

    if (jumpResp.error) {
      const msg = jumpResp.error.message.toLowerCase();
      if (msg.includes("battle") || msg.includes("in battle")) {
        const fled = await fleeFromBattle(ctx);
        if (!fled) await ctx.sleep(5000);
        continue;
      }
      ctx.log("error", `Jump failed: ${jumpResp.error.message}`);
      await ctx.sleep(10000);
      continue;
    }

    ctx.log("travel", `Jumped to ${target.name}`);
    bot.stats.totalSystems++;
    path.push(target.id);
    lastSystem = target.id;
  }
}

// ── Achievement Routine ───────────────────────────────────────────

/**
 * Achievement mode — systematically visits all 505 systems in the galaxy
 * to achieve 100% exploration and update the visited flags from get_map.
 * Uses galactic coordinates to create an optimized path that minimizes
 * fuel consumption and travel time.
 */
async function* achievementRoutine(ctx: RoutineContext): AsyncGenerator<string, void, void> {
  const { bot } = ctx;

  ctx.log("system", "Achievement mode — systematically visiting all unvisited systems...");

  const visitedSystems = new Set<string>();
  const fledFromSystems = new Set<string>();
  const path: string[] = [];
  let lastSystem: string | null = null;

  // Get initial system info
  yield "startup";
  await bot.refreshLocation();
  let { systemId } = await getSystemInfo(ctx);
  if (!systemId) {
    ctx.log("error", "Could not determine current system — waiting 30s");
    await ctx.sleep(30000);
    return;
  }

  const blacklist = getSystemBlacklist();
  const settings = getExplorerSettings(bot.username);

  // ── Startup: dock at local station to clear cargo & refuel ──
  yield "startup_prep";
  await bot.refreshLocation();
  const { pois: startPois } = await getSystemInfo(ctx);
  const startStation = findStation(startPois);
  if (startStation) {
    ctx.log("system", `Startup: docking at ${startStation.name} to clear cargo & refuel...`);

    // Travel to station if not already there
    if (bot.poi !== startStation.id) {
      await ensureUndocked(ctx);
      const tResp = await bot.exec("travel", { target_poi: startStation.id });
      if (!tResp.error || tResp.error.message.includes("already")) {
        bot.poi = startStation.id;
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

      // Load fuel cells to max cargo (achievement mode needs full fuel cells for long trips)
      if (settings.loadFuelCellsAtHome) {
        yield "startup_load_fuel_cells";
        await loadFuelCellsToMax(ctx);
      }

      // Refuel
      yield "startup_refuel";
      await tryRefuel(ctx);
      await bot.refreshShip();
      const startFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
      ctx.log("system", `Startup complete — Fuel: ${startFuel}% | Cargo: ${bot.cargo}/${bot.cargoMax}`);
    }
  } else {
    ctx.log("system", "No station in current system — skipping startup prep");
  }

  // Fetch initial map data to get visited status for all systems
  yield "fetch_map";
  ctx.log("system", "Fetching galaxy map with visited status...");
  const mapResp = await bot.exec("get_map");
  if (mapResp.result && typeof mapResp.result === "object") {
    const mapData = mapResp.result as Record<string, unknown>;
    const systems = (mapData.systems as Array<Record<string, unknown>>) || [];
    for (const sys of systems) {
      const sysId = (sys.system_id as string) || (sys.id as string);
      if (sysId) {
        mapStore.updateSystem(sys);
      }
    }
    const visitedCount = systems.filter((s: Record<string, unknown>) => s.visited === true).length;
    ctx.log("exploration", `Map loaded: ${systems.length} systems, ${visitedCount} visited by this bot`);
  } else {
    ctx.log("warn", "Could not fetch map data — visited status may be incomplete");
  }

  // Initialize path with current system
  if (path.length === 0 && bot.system) {
    path.push(bot.system);
  }

  // Track if we've already enabled cloak (mutation command - don't re-issue)
  let cloakEnabled = false;

  while (bot.state === "running") {
    // Check for battle
    if (await checkAndFleeFromBattle(ctx, "achievement")) {
      await ctx.sleep(5000);
      continue;
    }

    // Re-check mode after recovery
    const modeCheck = getExplorerSettings(bot.username);
    if (modeCheck.mode !== "achievement") {
      ctx.log("system", "Mode changed from achievement — switching to new mode");
      return;
    }

    // ── Enable cloak if autoCloak is enabled and not already cloaked ──
    const cloakSettings = getExplorerSettings(bot.username);
    if (cloakSettings.autoCloak && !bot.isCloaked && !cloakEnabled) {
      ctx.log("system", "Auto-cloak enabled - activating cloak for full-time stealth mode");
      const cloakResp = await bot.exec("cloak", { enable: true });
      if (!cloakResp.error) {
        cloakEnabled = true;
        ctx.log("info", "Cloak activated successfully - bot is now stealthed");
      } else {
        const msg = cloakResp.error.message.toLowerCase();
        if (msg.includes("already cloaked") || msg.includes("already_cloaked")) {
          cloakEnabled = true;
          ctx.log("info", "Cloak already active");
        } else {
          ctx.log("warn", `Cloak command failed: ${cloakResp.error.message}`);
        }
      }
    }

    await bot.refreshShip();
    const fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    ctx.log("info", `Achievement ${bot.system} — ${bot.credits} cr, ${fuelPct}% fuel`);

    let { pois, connections, systemId } = await getSystemInfo(ctx);
    if (!systemId) {
      await ctx.sleep(30000);
      continue;
    }

    // Check if we're at a pirate system and stuck - return home
    if (isPirateSystem(bot.system)) {
      const stats = mapStore.getVisitStats();
      if (stats.unvisited === 0 || connections.length === 0) {
        ctx.log("warn", `At pirate system ${bot.system} with no viable route - returning home`);
        const homeArrived = await navigateToSystem(ctx, "sol", { fuelThresholdPct: FUEL_SAFETY_PCT, hullThresholdPct: 30, skipBlacklist: true, autoCloak: true });
        if (homeArrived) {
          ctx.log("system", "Returned to Sol from pirate system - continuing achievement mode");
          await ctx.sleep(5000);
        }
        continue;
      }
    }

    // Mark this system as visited locally
    visitedSystems.add(systemId);
    mapStore.markSystemVisited(systemId);

    // Get visit stats from mapStore
    const stats = mapStore.getVisitStats();
    ctx.log("exploration", `Progress: ${stats.visited}/${stats.total} systems visited (${Math.round(stats.visited/stats.total*100)}%)`);

    // Check if we've completed all systems (auto-disable achievement mode)
    if (stats.unvisited === 0) {
      ctx.log("info", "All systems visited! Returning home and auto-disabling achievement mode.");
      // Return home first
      const homeSystem = "sol";
      if (bot.system.toLowerCase() !== homeSystem) {
        await navigateToSystem(ctx, homeSystem, { fuelThresholdPct: FUEL_SAFETY_PCT, hullThresholdPct: 30, skipBlacklist: true, autoCloak: true });
      }
      setExplorerMode(bot.username, "explore");
      return;
    }

    // Refresh map data from server to get latest visited status
    yield "refresh_map_before_planning";
    const refreshMapResp = await bot.exec("get_map");
    if (refreshMapResp.result && typeof refreshMapResp.result === "object") {
      const mapData = refreshMapResp.result as Record<string, unknown>;
      const systems = (mapData.systems as Array<Record<string, unknown>>) || [];
      for (const sys of systems) {
        const sysId = (sys.system_id as string) || (sys.id as string);
        if (sysId) {
          mapStore.updateSystem(sys);
        }
      }
    }

    // Find all unvisited systems and build optimized path
    yield "plan_achievement_route";

    const unvisitedSystems = await findAllUnvisitedSystems(ctx, blacklist, fledFromSystems, visitedSystems);

    if (unvisitedSystems.length === 0) {
      ctx.log("info", "No unvisited systems found in map — refreshing map data...");
      yield "refresh_map";
      const mapResp = await bot.exec("get_map");
      if (mapResp.result && typeof mapResp.result === "object") {
        const mapData = mapResp.result as Record<string, unknown>;
        const systems = (mapData.systems as Array<Record<string, unknown>>) || [];
        for (const sys of systems) {
          const sysId = (sys.system_id as string) || (sys.id as string);
          if (sysId) {
            mapStore.updateSystem(sys);
          }
        }
      }
      // Check again after refresh
      const retryUnvisited = await findAllUnvisitedSystems(ctx, blacklist, fledFromSystems, visitedSystems);
      if (retryUnvisited.length === 0) {
        ctx.log("warn", "Still no unvisited systems after map refresh — may need to return home");
        // Check if we're in a pirate system and need to return
        if (isPirateSystem(bot.system)) {
          ctx.log("warn", "In pirate system with no route to unvisited - returning home");
          await navigateToSystem(ctx, "sol", { fuelThresholdPct: FUEL_SAFETY_PCT, hullThresholdPct: 30, skipBlacklist: true, autoCloak: true });
          await ctx.sleep(5000);
        } else {
          await ctx.sleep(30000);
        }
      }
      continue;
    }

    // Sort by distance from current position (nearest first)
    unvisitedSystems.sort((a, b) => a.distance - b.distance);

    const target = unvisitedSystems[0];
    ctx.log("travel", `Navigating to ${target.name} (${target.id}) - ${target.distance} jumps away, ${unvisitedSystems.length} systems remaining`);

    // Ensure fueled
    const fueled = await ensureFueled(ctx, settings.refuelThreshold);
    if (!fueled) {
      await ctx.sleep(30000);
      continue;
    }

    await ensureUndocked(ctx);

    // Navigate to target system
    // Use skipBlacklist: true for achievement mode - we need to visit ALL systems
    const arrived = await navigateToSystem(ctx, target.id, { fuelThresholdPct: settings.refuelThreshold, hullThresholdPct: 30, skipBlacklist: true, autoCloak: true });
    if (!arrived) {
      ctx.log("error", `Could not reach ${target.name} — will retry next loop`);
      await ctx.sleep(10000);
      continue;
    }

    ctx.log("travel", `Arrived at ${target.name}`);
    bot.stats.totalSystems++;
    path.push(target.id);
    lastSystem = target.id;

    // Check for pirates after arrival
    const nearbyResp = await bot.exec("get_nearby");
    if (nearbyResp.result && typeof nearbyResp.result === "object") {
      // Track wildlife from nearby scan
      bot.trackNearbyPlayers(nearbyResp.result); bot.trackWildlife(nearbyResp.result);
      
      const { checkAndFleeFromPirates } = await import("./common.js");
      if (!bot.isCloaked || !cloakSettings.ignorePirateFleeWhenCloaked) {
        const fled = await checkAndFleeFromPirates(ctx, nearbyResp.result);
        if (fled) {
          ctx.log("error", "Pirates detected - fled, will retry");
          fledFromSystems.add(target.id);
          await ctx.sleep(30000);
          continue;
        }
      } else if (bot.isCloaked && cloakSettings.ignorePirateFleeWhenCloaked) {
        ctx.log("combat", `[INFO] Pirates detected but cloaked - ignoring flee (ignorePirateFleeWhenCloaked enabled)`);
      }
    }

    // Survey the system to reveal hidden POIs
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
      bot.trackSurveyWildlife(surveyResp.result);
    }

    // Update map with visited status and refresh from server
    mapStore.markSystemVisited(target.id);
    const mapRefreshResp = await bot.exec("get_map");
    if (mapRefreshResp.result && typeof mapRefreshResp.result === "object") {
      const mapData = mapRefreshResp.result as Record<string, unknown>;
      const systems = (mapData.systems as Array<Record<string, unknown>>) || [];
      for (const sys of systems) {
        const sysId = (sys.system_id as string) || (sys.id as string);
        if (sysId) {
          mapStore.updateSystem(sys);
        }
      }
    }
  }
}

/**
 * Find the nearest unvisited system using server's find_route API.
 * This is a simplified version that just finds any unvisited system.
 * For achievement mode, we accept routes through blacklisted systems.
 */
async function findNearestUnvisitedSystem(
  ctx: RoutineContext,
  visitedSystems?: Set<string>,
): Promise<{
  id: string;
  name: string;
  distance: number;
  position: { x: number; y: number } | null;
} | null> {
  const currentSystem = ctx.bot.system;
  if (!currentSystem) return null;

  // Get all unvisited systems from mapStore
  const allSystems = mapStore.getSystems();
  const unvisited: Array<{ id: string; name: string }> = [];

  for (const sys of allSystems) {
    // Achievement mode visits ALL systems including pirate systems
    if (sys.visited === true) continue;
    // Also skip systems we've visited in this session
    if (visitedSystems?.has(sys.id)) continue;
    unvisited.push({ id: sys.id, name: sys.name || sys.id });
  }

  if (unvisited.length === 0) return null;

  // Try find_route for each unvisited system and pick the shortest
  let nearest: { id: string; name: string; distance: number; position: { x: number; y: number } | null } | null = null;

  for (const sys of unvisited.slice(0, 5)) {
    const routeResp = await ctx.bot.exec("find_route", { target_system: sys.id });
    const routeData = routeResp.result as { found?: boolean; route?: Array<{ system_id: string; name: string; jumps?: number }>; total_jumps?: number } | null;

    if (routeData?.found && routeData.route && routeData.route.length > 1) {
      // Use total_jumps if available, otherwise calculate from route length
      const distance = routeData.total_jumps ?? (routeData.route.length - 1);
      if (!nearest || distance < nearest.distance) {
        nearest = {
          id: sys.id,
          name: sys.name || sys.id,
          distance,
          position: null,
        };
      }
    }
  }

  return nearest;
}

/**
 * Find all unvisited systems reachable from current position using BFS.
 * Returns systems sorted by jump distance (nearest first).
 * Falls back to server API if mapStore lacks connection data.
 */
async function findAllUnvisitedSystems(
  ctx: RoutineContext,
  blacklist: string[],
  fledFromSystems: Set<string>,
  visitedSystems: Set<string>
): Promise<Array<{
  id: string;
  name: string;
  distance: number;
  position: { x: number; y: number } | null;
}>
> {
  const currentSystem = ctx.bot.system;
  if (!currentSystem) return [];

  // Refresh map data first
  const mapResp = await ctx.bot.exec("get_map");
  if (mapResp.result && typeof mapResp.result === "object") {
    const mapData = mapResp.result as Record<string, unknown>;
    const systems = (mapData.systems as Array<Record<string, unknown>>) || [];
    for (const sys of systems) {
      const sysId = (sys.system_id as string) || (sys.id as string);
      if (sysId) {
        mapStore.updateSystem(sys);
      }
    }
  }

  // Check if mapStore has connection data for current system
  const currentSys = mapStore.getSystem(currentSystem);
  if (!currentSys || !currentSys.connections || currentSys.connections.length === 0) {
    ctx.log("debug", `MapStore has no connection data for ${currentSystem} — using server fallback`);
    const nearest = await findNearestUnvisitedSystem(ctx, visitedSystems);
    if (nearest && !visitedSystems.has(nearest.id)) {
      return [nearest];
    }
    return [];
  }

  // BFS to find reachable unvisited systems
  const unvisited: Array<{ id: string; name: string; distance: number; position: { x: number; y: number } | null; }> = [];
  const visited = new Set<string>();
  const queue: Array<{ systemId: string; distance: number }> = [
    { systemId: currentSystem, distance: 0 }
  ];
  visited.add(currentSystem);

  while (queue.length > 0) {
    const { systemId, distance } = queue.shift()!;
    const sys = mapStore.getSystem(systemId);
    if (!sys) continue;

    for (const conn of sys.connections) {
      const connId = conn.system_id;
      if (!connId) continue;
      if (visited.has(connId)) continue;
      // Skip systems we've already visited in this session
      if (visitedSystems.has(connId)) continue;

      // Achievement mode visits ALL systems including pirate systems

      visited.add(connId);

      const targetSys = mapStore.getSystem(connId);
      // If system not in mapStore, treat as unvisited (we don't know its status)
      // Also check local visitedSystems set to avoid re-visiting systems we just visited
      if (!targetSys || targetSys.visited === false) {
        unvisited.push({
          id: connId,
          name: targetSys?.name || connId,
          distance: distance + 1,
          position: targetSys?.position ?? null,
        });
        queue.push({ systemId: connId, distance: distance + 1 });
      } else if (targetSys && targetSys.visited === true) {
        queue.push({ systemId: connId, distance: distance + 1 });
      }
    }
  }

  unvisited.sort((a, b) => a.distance - b.distance);

  if (unvisited.length === 0) {
    ctx.log("debug", "BFS found no unvisited systems — using server fallback");
    const nearest = await findNearestUnvisitedSystem(ctx, visitedSystems);
    if (nearest && !visitedSystems.has(nearest.id)) {
      return [nearest];
    }
  }

  return unvisited;
}

// ── Helpers ──────────────────────────────────────────────────

/** Threshold in days for considering POI data stale. */
const STALE_POI_DAYS = 7;

/**
 * Find systems that need exploration, sorted by priority then distance (nearest first).
 *
 * Priority tiers:
 *   1. Systems with visited=false from get_map (never visited by this bot)
 *   2. Systems where all POIs are stale (last_updated > 7 days ago)
 *
 * Within each tier, systems are sorted by jump distance ascending (nearest first).
 */
function findUnknownSystems(ctx: RoutineContext, currentSystem: string, blacklist: string[], fledFromSystems: Set<string>, ignoreBlacklistWhenCloaked: boolean = false, isCloaked: boolean = false): Array<{
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
      // Unless cloaked and ignoreBlacklistWhenCloaked is enabled
      if (!isCloaked || !ignoreBlacklistWhenCloaked) {
        if (blacklist.some(b => b.toLowerCase() === connId.toLowerCase())) continue;
        if (isTemporarilyBlacklisted(connId)) continue;
        if (fledFromSystems.has(connId)) continue;
      }

      visited.add(connId);
      const newRoute = [...route, connId];
      const newDistance = distance + 1;

      const targetSys = mapStore.getSystem(connId);
      if (targetSys) {
        // System is in map.json — check visited status from get_map
        // visited=false means the bot has never visited this system
        if (targetSys.visited === false) {
          unknowns.push({
            id: connId,
            name: conn.system_name || connId,
            distance: newDistance,
            route: newRoute,
            priority: "unknown",
            oldestPoiUpdate: targetSys.visited_at ?? null,
          });
          // Continue BFS through this system (we want to explore it)
          queue.push({ systemId: connId, distance: newDistance, route: newRoute });
          continue;
        }
        
        // System is visited by this bot — check if POIs need refreshing
        const poiCount = targetSys.pois?.length ?? 0;

        if (poiCount === 0) {
          // No POIs yet — unknown
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
        // Check visited flag first - if not visited by this bot, include it
        if (targetSys.visited === false) {
          nearby.push(connId);
          queue.push({ systemId: connId, distance: distance + 1 });
          continue;
        }
        
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
 * Find all systems that have not been visited according to the server's visited flag.
 * Returns systems sorted by distance from current system.
 */
function findUnvisitedSystemsByServerFlag(ctx: RoutineContext, currentSystem: string, blacklist: string[], fledFromSystems: Set<string>): Array<{
  id: string;
  name: string;
  distance: number;
  route: string[];
}> {
  const unvisited: Array<{
    id: string;
    name: string;
    distance: number;
    route: string[];
  }> = [];

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
        // Check server's visited flag - false means never visited by this bot
        if (targetSys.visited === false) {
          unvisited.push({
            id: connId,
            name: conn.system_name || connId,
            distance: newDistance,
            route: newRoute,
          });
        }
        // Continue BFS to find more unvisited systems
        queue.push({ systemId: connId, distance: newDistance, route: newRoute });
      }
    }
  }

  // Sort by distance (nearest first)
  unvisited.sort((a, b) => a.distance - b.distance);
  return unvisited;
}

/**
  * Load fuel cells to max cargo capacity at faction home (Sol Central).
  * Uses storage withdraw, prioritizes military_fuel_cell then premium then regular.
  * Falls back to buying if faction withdraw fails.
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
  let militaryFuelCells = 0;
  let premiumFuelCells = 0;
  let regularFuelCells = 0;
  for (const item of cargoItems) {
    const itemId = (item.item_id as string) || "";
    const quantity = (item.quantity as number) || 0;
    const spacePerItem = getItemSize(itemId);
    currentCargo += quantity * spacePerItem;
    if (itemId === "military_fuel_cell") {
      militaryFuelCells = quantity;
    } else if (itemId === "premium_fuel_cell") {
      premiumFuelCells = quantity;
    } else if (itemId === "fuel_cell") {
      regularFuelCells = quantity;
    }
  }

  const availableSpace = bot.cargoMax - currentCargo;
  if (availableSpace <= 0) {
    ctx.log("info", `Cargo hold full — already loaded with ${militaryFuelCells} military + ${premiumFuelCells} premium + ${regularFuelCells} regular fuel cells (${bot.cargo}/${bot.cargoMax} cargo)`);
    return true;
  }

  const milSize = getItemSize("military_fuel_cell");
  const premSize = getItemSize("premium_fuel_cell");
  const regSize = getItemSize("fuel_cell");

  // Calculate max we can withdraw: use floor division per size (military=3, premium=2, regular=1)
  const maxMilWithdraw = Math.floor(availableSpace / milSize);
  const maxPremWithdraw = Math.floor(availableSpace / premSize);
  const maxRegWithdraw = availableSpace;

  // Try to withdraw military_fuel_cell first (highest priority / density, 3 space each)
  const milToWithdraw = Math.min(maxMilWithdraw, 300); // Cap at reasonable amount
  ctx.log("trade", `Loading ${milToWithdraw} military fuel cells from faction storage for long-range exploration...`);
  let withdrawResp = await bot.exec("storage", { action: 'withdraw', item_id: "military_fuel_cell", quantity: milToWithdraw, target: "faction"});

  // Check for battle after faction_withdraw_items
  if (await checkBattleAfterCommand(ctx, withdrawResp.notifications, "faction_withdraw_items")) {
    ctx.log("combat", "Battle detected during fuel cell withdraw - fleeing!");
    await ctx.sleep(5000);
    return false;
  }

  let loadedCount = 0;
  if (!withdrawResp.error) {
    loadedCount = milToWithdraw;
    const newMil = militaryFuelCells + loadedCount;
    const actualCargoUsed = loadedCount * milSize;
    ctx.log("trade", `Loaded ${loadedCount} military fuel cells from faction storage (${actualCargoUsed} cargo space, ${newMil} military + ${premiumFuelCells} premium + ${regularFuelCells} regular, ${bot.cargo}/${bot.cargoMax} cargo)`);
    return true;
  }

  // If military withdraw failed, try premium_fuel_cell
  ctx.log("warn", `Could not withdraw military fuel cells: ${withdrawResp.error.message} — trying premium fuel cells...`);
  const premToWithdraw = Math.min(maxPremWithdraw, 400);
  withdrawResp = await bot.exec("storage", { action: 'withdraw', item_id: "premium_fuel_cell", quantity: premToWithdraw, target: "faction"});

  // Check for battle after faction_withdraw_items
  if (await checkBattleAfterCommand(ctx, withdrawResp.notifications, "faction_withdraw_items")) {
    ctx.log("combat", "Battle detected during fuel cell withdraw - fleeing!");
    await ctx.sleep(5000);
    return false;
  }

  if (!withdrawResp.error) {
    loadedCount = premToWithdraw;
    const newPrem = premiumFuelCells + loadedCount;
    const actualCargoUsed = loadedCount * premSize;
    ctx.log("trade", `Loaded ${loadedCount} premium fuel cells from faction storage (${actualCargoUsed} cargo space, ${militaryFuelCells} military + ${newPrem} premium + ${regularFuelCells} regular, ${bot.cargo}/${bot.cargoMax} cargo)`);
    return true;
  }

  // If premium withdraw failed, try regular fuel_cell
  ctx.log("warn", `Could not withdraw premium fuel cells: ${withdrawResp.error.message} — trying regular fuel cells...`);
  withdrawResp = await bot.exec("storage", { action: 'withdraw', target: 'faction', item_id: "fuel_cell", quantity: maxRegWithdraw });

  // Check for battle after faction_withdraw_items
  if (await checkBattleAfterCommand(ctx, withdrawResp.notifications, "faction_withdraw_items")) {
    ctx.log("combat", "Battle detected during fuel cell withdraw - fleeing!");
    await ctx.sleep(5000);
    return false;
  }

  if (!withdrawResp.error) {
    loadedCount = maxRegWithdraw;
    const newRegular = regularFuelCells + loadedCount;
    ctx.log("trade", `Loaded ${loadedCount} regular fuel cells from faction storage (${militaryFuelCells} military + ${premiumFuelCells} premium + ${newRegular} regular, ${bot.cargo}/${bot.cargoMax} cargo)`);
    return true;
  }

  // If faction withdraw failed, try to buy military fuel cells from station market as fallback
  ctx.log("warn", `Could not withdraw regular fuel cells: ${withdrawResp.error.message} — trying to buy military fuel cells from market...`);
  const buyResp = await bot.exec("buy", { item_id: "military_fuel_cell", quantity: milToWithdraw });

  // Check for battle after buy
  if (await checkBattleAfterCommand(ctx, buyResp.notifications, "buy")) {
    ctx.log("combat", "Battle detected during fuel cell purchase - fleeing!");
    await ctx.sleep(5000);
    return false;
  }

  if (!buyResp.error) {
    loadedCount = milToWithdraw;
    const newMil = militaryFuelCells + loadedCount;
    ctx.log("trade", `Bought ${loadedCount} military fuel cells from market (${newMil} military + ${premiumFuelCells} premium + ${regularFuelCells} regular, ${bot.cargo}/${bot.cargoMax} cargo)`);
    return true;
  }

  // If military buy failed, try premium fuel_cell
  ctx.log("warn", `Could not buy military fuel cells: ${buyResp.error.message} — trying premium fuel cells...`);
  const buyPremResp = await bot.exec("buy", { item_id: "premium_fuel_cell", quantity: premToWithdraw });

  // Check for battle after buy
  if (await checkBattleAfterCommand(ctx, buyPremResp.notifications, "buy")) {
    ctx.log("combat", "Battle detected during fuel cell purchase - fleeing!");
    await ctx.sleep(5000);
    return false;
  }

  if (!buyPremResp.error) {
    loadedCount = premToWithdraw;
    const newPrem = premiumFuelCells + loadedCount;
    ctx.log("trade", `Bought ${loadedCount} premium fuel cells from market (${militaryFuelCells} military + ${newPrem} premium + ${regularFuelCells} regular, ${bot.cargo}/${bot.cargoMax} cargo)`);
    return true;
  }

  // If premium buy failed, try regular fuel_cell
  ctx.log("warn", `Could not buy premium fuel cells: ${buyPremResp.error.message} — trying regular fuel cells...`);
  const buyRegularResp = await bot.exec("buy", { item_id: "fuel_cell", quantity: maxRegWithdraw });

  // Check for battle after buy
  if (await checkBattleAfterCommand(ctx, buyRegularResp.notifications, "buy")) {
    ctx.log("combat", "Battle detected during fuel cell purchase - fleeing!");
    await ctx.sleep(5000);
    return false;
  }

  if (!buyRegularResp.error) {
    loadedCount = maxRegWithdraw;
    const newRegular = regularFuelCells + loadedCount;
    ctx.log("trade", `Bought ${loadedCount} regular fuel cells from market (${militaryFuelCells} military + ${premiumFuelCells} premium + ${newRegular} regular, ${bot.cargo}/${bot.cargoMax} cargo)`);
    return true;
  }

  // If buy also failed, try to withdraw credits and retry with military first
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
      await bot.refreshLocation();
      ctx.log("trade", `Withdrew credits — now ${bot.credits} credits, retrying military fuel cell purchase...`);
      const retryResp = await bot.exec("buy", { item_id: "military_fuel_cell", quantity: milToWithdraw });

      // Check for battle after retry buy
      if (await checkBattleAfterCommand(ctx, retryResp.notifications, "buy")) {
        ctx.log("combat", "Battle detected during retry fuel cell purchase - fleeing!");
        await ctx.sleep(5000);
        return false;
      }

      if (!retryResp.error) {
        loadedCount = milToWithdraw;
        const newMil = militaryFuelCells + loadedCount;
        ctx.log("trade", `Loaded ${loadedCount} military fuel cells (${newMil} military + ${premiumFuelCells} premium + ${regularFuelCells} regular, ${bot.cargo}/${bot.cargoMax} cargo)`);
        return true;
      }

      // If military retry failed, try premium
      ctx.log("warn", `Could not buy military fuel cells: ${retryResp.error.message} — trying premium...`);
      const retryPremResp = await bot.exec("buy", { item_id: "premium_fuel_cell", quantity: premToWithdraw });

      // Check for battle after retry buy
      if (await checkBattleAfterCommand(ctx, retryPremResp.notifications, "buy")) {
        ctx.log("combat", "Battle detected during retry fuel cell purchase - fleeing!");
        await ctx.sleep(5000);
        return false;
      }

      if (!retryPremResp.error) {
        loadedCount = premToWithdraw;
        const newPrem = premiumFuelCells + loadedCount;
        ctx.log("trade", `Loaded ${loadedCount} premium fuel cells (${militaryFuelCells} military + ${newPrem} premium + ${regularFuelCells} regular, ${bot.cargo}/${bot.cargoMax} cargo)`);
        return true;
      }

      // If premium retry failed, try regular
      ctx.log("warn", `Could not buy premium fuel cells: ${retryPremResp.error.message} — trying regular...`);
      const retryRegularResp = await bot.exec("buy", { item_id: "fuel_cell", quantity: maxRegWithdraw });

      // Check for battle after retry buy
      if (await checkBattleAfterCommand(ctx, retryRegularResp.notifications, "buy")) {
        ctx.log("combat", "Battle detected during retry fuel cell purchase - fleeing!");
        await ctx.sleep(5000);
        return false;
      }

      if (!retryRegularResp.error) {
        loadedCount = maxRegWithdraw;
        const newRegular = regularFuelCells + loadedCount;
        ctx.log("trade", `Loaded ${loadedCount} regular fuel cells (${militaryFuelCells} military + ${premiumFuelCells} premium + ${newRegular} regular, ${bot.cargo}/${bot.cargoMax} cargo)`);
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
 * Return to the configured global home base (Settings → General) to reload fuel
 * cells. Navigates to the home system, docks at the home station, and loads fuel
 * cells to max cargo. No longer hardcodes Sol Central / sol_station.
 */
async function returnToHomeBaseForFuelCells(ctx: RoutineContext): Promise<boolean> {
  const { bot } = ctx;

  const home = getGlobalHomeBase();
  const homeSystem = home.system || "sol";
  const homeName = home.name || "home base";

  ctx.log("system", `Returning to home base (${homeName}) to reload fuel cells...`);

  // Navigate to the configured home system
  if (bot.system !== homeSystem) {
    await ensureUndocked(ctx);
    const arrived = await navigateToSystem(ctx, homeSystem, { fuelThresholdPct: FUEL_SAFETY_PCT, hullThresholdPct: 30, skipBlacklist: true });
    if (!arrived) {
      ctx.log("error", `Could not reach ${homeSystem} — aborting fuel cell reload`);
      return false;
    }
  }

  // Dock at the configured home station (or any station in the system as fallback)
  const docked = await ensureDocked(ctx, true, 0, home.station ? { targetStationId: home.station } : undefined);
  if (!docked) {
    ctx.log("error", `Could not dock at home base (${homeName}) — aborting fuel cell reload`);
    return false;
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
  * Prioritizes military_fuel_cell (3 space, 100 fuel) over premium_fuel_cell over regular fuel_cell.
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
  let militaryFuelCells = 0;
  let premiumFuelCells = 0;
  let regularFuelCells = 0;
  for (const item of cargoItems) {
    const itemId = (item.item_id as string) || "";
    const quantity = (item.quantity as number) || 0;
    const spacePerItem = getItemSize(itemId);
    currentCargo += quantity * spacePerItem;
    if (itemId === "military_fuel_cell") {
      militaryFuelCells = quantity;
    } else if (itemId === "premium_fuel_cell") {
      premiumFuelCells = quantity;
    } else if (itemId === "fuel_cell") {
      regularFuelCells = quantity;
    }
  }

  const availableSpace = bot.cargoMax - currentCargo;
  if (availableSpace <= 0) {
    log("info", `Cargo hold full — already loaded with ${militaryFuelCells} military + ${premiumFuelCells} premium + ${regularFuelCells} regular fuel cells (${bot.cargo}/${bot.cargoMax} cargo)`);
    return true;
  }

  const milSize = getItemSize("military_fuel_cell");
  const premSize = getItemSize("premium_fuel_cell");

  const maxMilWithdraw = Math.floor(availableSpace / milSize);
  const maxPremWithdraw = Math.floor(availableSpace / premSize);
  const maxRegularWithdraw = availableSpace;

  // Try to buy military fuel cells first (best density)
  log("trade", `Loading ${maxMilWithdraw} military fuel cells for long journey...`);
  const buyResp = await bot.exec("buy", {
    item_id: "military_fuel_cell",
    quantity: maxMilWithdraw
  });

  // Check for battle after buy
  if (await checkBattleAfterCommand(ctx, buyResp.notifications, "buy")) {
    log("combat", "Battle detected during fuel cell purchase - fleeing!");
    await ctx.sleep(5000);
    return false;
  }

  if (!buyResp.error) {
    const newMil = militaryFuelCells + maxMilWithdraw;
    log("trade", `Bought ${maxMilWithdraw} military fuel cells (${newMil} military + ${premiumFuelCells} premium + ${regularFuelCells} regular, ${bot.cargo}/${bot.cargoMax} cargo)`);
    return true;
  }

  // If military buy failed, try premium fuel cells
  log("warn", `Could not buy military fuel cells: ${buyResp.error.message} — trying premium fuel cells...`);
  const buyPremResp = await bot.exec("buy", {
    item_id: "premium_fuel_cell",
    quantity: maxPremWithdraw
  });

  // Check for battle after buy
  if (await checkBattleAfterCommand(ctx, buyPremResp.notifications, "buy")) {
    log("combat", "Battle detected during fuel cell purchase - fleeing!");
    await ctx.sleep(5000);
    return false;
  }

  if (!buyPremResp.error) {
    const newPrem = premiumFuelCells + maxPremWithdraw;
    log("trade", `Bought ${maxPremWithdraw} premium fuel cells (${militaryFuelCells} military + ${newPrem} premium + ${regularFuelCells} regular, ${bot.cargo}/${bot.cargoMax} cargo)`);
    return true;
  }

  // If premium buy failed, try regular fuel_cell
  log("warn", `Could not buy premium fuel cells: ${buyPremResp.error.message} — trying regular fuel cells...`);
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
  log("trade", `Bought ${maxRegularWithdraw} regular fuel cells (${militaryFuelCells} military + ${premiumFuelCells} premium + ${newRegular} regular, ${bot.cargo}/${bot.cargoMax} cargo)`);
  return true;
}

/**
 * Pick the best next system: prioritize unexplored systems not in map.json.
 * Priority:
 * 1. Systems not in map.json at all (completely unexplored)
 * 2. Systems in map.json but not yet visited this session
 * 3. Among unvisited, prefer systems with fewer POIs (less explored)
 * Skips pirate systems, blacklisted systems, and systems we've fled from.
 * When cloaked and ignoreBlacklistWhenCloaked is enabled, skips blacklist/flee filtering.
 */
function pickNextSystem(ctx: RoutineContext, connections: Connection[], visited: Set<string>, visitedTimes: Map<string, number>, lastSystem: string | null, fledFromSystems: Set<string>, path: string[] = [], isCloaked: boolean = false, ignoreBlacklistWhenCloaked: boolean = false, claimedTargets: Set<string> | null = null): Connection | null {
  const blacklist = getSystemBlacklist();
  const ONE_HOUR_MS = 60 * 60 * 1000;
  const now = Date.now();

  // DEBUG: Log blacklist contents and filtering
  if (blacklist.length > 0) {
    ctx.log("debug", `System blacklist contains ${blacklist.length} systems: ${blacklist.join(', ')}`);
  } else {
    ctx.log("debug", "System blacklist is empty");
  }

  // Filter out blacklisted systems, systems we've fled from, and temporarily blacklisted systems
  const nonBlacklistedConns = connections.filter(c => {
    const isBlacklisted = blacklist.some(b => b.toLowerCase() === c.id.toLowerCase());
    const hasFledFrom = fledFromSystems.has(c.id);
    const isTempBlacklisted = isTemporarilyBlacklisted(c.id);

    if (isBlacklisted) {
      ctx.log("debug", `Filtering out blacklisted system: ${c.id}`);
    }
    if (hasFledFrom) {
      ctx.log("debug", `Filtering out fled-from system: ${c.id}`);
    }
    if (isTempBlacklisted) {
      ctx.log("debug", `Filtering out temporarily blacklisted system: ${c.id}`);
    }

    // Skip blacklist/flee filtering if cloaked and ignoreBlacklistWhenCloaked is enabled
    if (isCloaked && ignoreBlacklistWhenCloaked) {
      return true;
    }

    return !isBlacklisted && !hasFledFrom && !isTempBlacklisted;
  });
  
  // Separate connections into pirate and non-pirate
  const nonPirateConns = nonBlacklistedConns.filter(c => !isPirateSystem(c.id));
  const pirateConns = nonBlacklistedConns.filter(c => isPirateSystem(c.id));

  // Work with non-pirate connections first
  let candidates = nonPirateConns.length > 0 ? nonPirateConns : pirateConns;

  // Coordination: avoid systems other active explorers are currently targeting.
  // Falls back to the full candidate set if every candidate is claimed (so we
  // never get stuck), matching findUnknownSystemsWithCoordination behaviour.
  if (claimedTargets && claimedTargets.size > 0) {
    const unclaimed = candidates.filter(c => !claimedTargets.has(c.id.toLowerCase()));
    if (unclaimed.length > 0) {
      ctx.log("exploration", `Coordination: skipping ${candidates.length - unclaimed.length} system(s) targeted by other explorers`);
      candidates = unclaimed;
    } else {
      ctx.log("exploration", `Coordination: all candidate systems are targeted by other explorers — proceeding anyway`);
    }
  }

  // If we're seeing the same 3-system loop, penalize connections that are part of the current path
  if (path && path.length >= 3) {
    // Check last 3 systems for repeating pattern (A->B->C where next choices include A)
    const last = path.slice(-3);
    const loopSet = new Set(last);
    const filtered = candidates.filter(c => !loopSet.has(c.id));
    if (filtered.length > 0) {
      candidates = filtered;
    } else {
      ctx.log("warning", "Loop avoidance: all immediate candidates were part of recent path — allowing them but deprioritizing");
      // keep original candidates but they'll be deprioritized later
    }
  }

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

  // Priority 2: Systems in map.json but not visited (per server flag or session)
  // Apply penalty to systems visited in the last hour to avoid loops
  const unvisited = candidates.filter(c => {
    if (visited.has(c.id)) {
      const lastVisit = visitedTimes.get(c.id);
      if (lastVisit && (now - lastVisit) < ONE_HOUR_MS) {
        return false; // Skip systems visited in the last hour
      }
    }
    // Also check server's visited flag
    const sys = mapStore.getSystem(c.id);
    if (sys?.visited === true) {
      return false;
    }
    return true;
  });
  if (unvisited.length > 0) {
    // Sort by POI count (prefer less explored systems)
    unvisited.sort((a, b) => {
      const aPois = mapStore.getSystem(a.id)?.pois?.length ?? 0;
      const bPois = mapStore.getSystem(b.id)?.pois?.length ?? 0;
      return aPois - bPois;
    });
    return unvisited[0];
  }

  // All connected systems have been visited this session or recently
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
function pickSmartConnection(ctx: RoutineContext, connections: Connection[], lastSystem: string | null, visited: Set<string>, visitedTimes: Map<string, number>, fledFromSystems: Set<string>, path: string[] = [], isCloaked: boolean = false, ignoreBlacklistWhenCloaked: boolean = false): Connection | null {
  const blacklist = getSystemBlacklist();
  const ONE_HOUR_MS = 60 * 60 * 1000;
  const now = Date.now();

  // DEBUG: Log blacklist contents and filtering
  if (blacklist.length > 0) {
    ctx.log("debug", `Smart connection picker - System blacklist contains ${blacklist.length} systems: ${blacklist.join(', ')}`);
  } else {
    ctx.log("debug", "Smart connection picker - System blacklist is empty");
  }

  // First, filter out the system we came from (if possible)
  let candidates = lastSystem ? connections.filter(c => c.id !== lastSystem) : connections;
  if (candidates.length === 0) candidates = connections;

  // Filter out blacklisted systems, systems we've fled from, and temporarily blacklisted systems
  const nonBlacklisted = candidates.filter(c => {
    const isBlacklisted = blacklist.some(b => b.toLowerCase() === c.id.toLowerCase());
    const hasFledFrom = fledFromSystems.has(c.id);
    const isTempBlacklisted = isTemporarilyBlacklisted(c.id);

    if (isBlacklisted) {
      ctx.log("debug", `Smart connection picker - Filtering out blacklisted system: ${c.id}`);
    }
    if (hasFledFrom) {
      ctx.log("debug", `Smart connection picker - Filtering out fled-from system: ${c.id}`);
    }
    if (isTempBlacklisted) {
      ctx.log("debug", `Smart connection picker - Filtering out temporarily blacklisted system: ${c.id}`);
    }

    // Skip blacklist/flee filtering if cloaked and ignoreBlacklistWhenCloaked is enabled
    if (isCloaked && ignoreBlacklistWhenCloaked) {
      return true;
    }

    return !isBlacklisted && !hasFledFrom && !isTempBlacklisted;
  });

  // CRITICAL: Never use blacklisted systems, even in trapped situations
  if (nonBlacklisted.length === 0) {
    ctx.log("error", `Smart connection picker - ALL connected systems are blacklisted/fled-from/temp-blacklisted! Cannot proceed with exploration.`);
    return null; // Return null to indicate no valid connections
  }

  candidates = nonBlacklisted;

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
    const lastVisit = conn.id ? visitedTimes.get(conn.id) : null;
    const visitedRecently = lastVisit && (now - lastVisit) < ONE_HOUR_MS;
    const isVisitedServer = sys?.visited === true;

    // Higher score = better
    let score = 0;

    // Big bonus for systems not in map.json (completely unexplored)
    if (!isInMap) {
      score += 1000;
    }

    // Bonus for unvisited systems according to server flag
    if (isInMap && !isVisitedServer) {
      score += 500;
    }

    // Reduce selection of systems that are directly in the recent path to avoid 3-system loops
    if (path && path.length >= 3 && path.slice(-3).includes(conn.id)) {
      score -= 900; // large penalty to avoid selecting looped systems
    }

    // Bonus for systems with more connections (hubs, not dead-ends)
    score += connectionCount * 10;

    // Small penalty for already explored this session
    if (isExploredThisSession) {
      score -= 50;
    }

    // Significant penalty for systems visited in the last hour (avoid loops)
    if (visitedRecently) {
      score -= 500;
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

// ── Explorer Coordination ────────────────────────────────────────

/** Exploration target announced by other explorers via bot chat. */
interface ExplorationTarget {
  botName: string;
  targetSystemId: string;
  timestamp: number;
  expiresAt: number;
}

/** In-memory store of other explorers' current targets (expires after 5 minutes). */
const explorationTargets = new Map<string, ExplorationTarget>();
const EXPLORATION_TARGET_TTL_MS = 5 * 60 * 1000;

/**
 * Announce our current target system to other explorers via bot chat.
 */
function announceExplorationTarget(ctx: RoutineContext, targetSystemId: string): void {
  const { sendBotChat, getAllBotNames } = ctx;
  if (!sendBotChat || !getAllBotNames) return;

  const allBots = getAllBotNames();
  const otherBots = allBots.filter(name => name !== ctx.bot.username);
  
  if (otherBots.length === 0) return;

  sendBotChat(
    JSON.stringify({
      type: "exploration_target",
      targetSystemId,
      botName: ctx.bot.username,
    }),
    "coordination",
    otherBots,
    { timestamp: Date.now() }
  );
}

/**
 * Process an incoming exploration target announcement from another bot.
 */
function processExplorationTarget(message: BotChatMessage): void {
  try {
    const data = JSON.parse(message.content);
    if (data.type !== "exploration_target") return;
    
    const target: ExplorationTarget = {
      botName: data.botName,
      targetSystemId: data.targetSystemId,
      timestamp: message.timestamp,
      expiresAt: message.timestamp + EXPLORATION_TARGET_TTL_MS,
    };
    
    explorationTargets.set(data.botName, target);
  } catch {
    // Invalid JSON, ignore
  }
}

/**
 * Get all currently claimed exploration targets (not expired).
 */
function getClaimedTargets(): Set<string> {
  const now = Date.now();
  const claimed = new Set<string>();
  
  for (const [botName, target] of explorationTargets.entries()) {
    if (now < target.expiresAt) {
      claimed.add(target.targetSystemId.toLowerCase());
    } else {
      explorationTargets.delete(botName);
    }
  }
  
  return claimed;
}

/**
 * Clean up expired exploration targets.
 */
function cleanupExplorationTargets(): void {
  const now = Date.now();
  for (const [botName, target] of explorationTargets.entries()) {
    if (now >= target.expiresAt) {
      explorationTargets.delete(botName);
    }
  }
}

/**
 * Find unknown systems to explore, avoiding targets claimed by other explorers.
 * Returns systems sorted by priority then distance (nearest first).
 */
function findUnknownSystemsWithCoordination(
  ctx: RoutineContext,
  currentSystem: string,
  blacklist: string[],
  fledFromSystems: Set<string>,
  ignoreBlacklistWhenCloaked: boolean = false,
  isCloaked: boolean = false,
): Array<{
  id: string;
  name: string;
  distance: number;
  route: string[];
  priority: "unknown" | "stale";
  oldestPoiUpdate: string | null;
}> {
  const claimedTargets = getClaimedTargets();
  cleanupExplorationTargets();
  
  const unknowns = findUnknownSystems(ctx, currentSystem, blacklist, fledFromSystems, ignoreBlacklistWhenCloaked, isCloaked);
  
  // Filter out systems that other explorers are targeting
  const unclaimed = unknowns.filter(u => !claimedTargets.has(u.id.toLowerCase()));
  
  if (unclaimed.length === 0 && unknowns.length > 0) {
    ctx.log("exploration", `All unknown systems are being targeted by other explorers - selecting nearest available`);
    // Return the original list - we'll pick the nearest even if targeted
    return unknowns;
  }
  
  ctx.log("exploration", `Filtered out ${unknowns.length - unclaimed.length} systems being targeted by other explorers`);
  return unclaimed;
}

/**
 * From a list of candidate targets, return the first that isn't currently
 * claimed by another explorer. Falls back to the first candidate if every one
 * is claimed, so we never get stuck waiting for a free system.
 */
function pickCoordinatedTarget<T>(
  candidates: T[],
  claimed: Set<string> | null,
  keyOf: (c: T) => string,
): T | undefined {
  if (!claimed || claimed.size === 0 || candidates.length === 0) {
    return candidates[0];
  }
  const unclaimed = candidates.filter(c => !claimed.has(keyOf(c).toLowerCase()));
  return (unclaimed.length > 0 ? unclaimed : candidates)[0];
}
