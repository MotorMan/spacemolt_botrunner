import type { Routine, RoutineContext } from "../bot.js";
import { mapStore, isDepletionExpired } from "../mapstore.js";
import { getSystemBlacklist } from "../web/server.js";
import {
  isOreBeltPoi,
  isGasCloudPoi,
  isIceFieldPoi,
  findStation,
  parseOreFromMineResult,
  collectFromStorage,
  ensureDocked,
  ensureUndocked,
  tryRefuel,
  repairShip,
  ensureFueled,
  navigateToSystem,
  refuelAtStation,
  factionDonateProfit,
  readSettings,
  scavengeWrecks,
  detectAndRecoverFromDeath,
  getSystemInfo,
  sleep,
} from "./common.js";
import {
  getActiveMiningSession,
  startMiningSession,
  updateMiningSession,
  completeMiningSession,
  failMiningSession,
  createMiningSession,
  type MiningSession,
} from "./minerActivity.js";
import {
  type BattleState,
  handleBattleNotifications,
  getBattleStatus,
  fleeFromBattle,
} from "./common.js";

// ── Deep core mining constants ───────────────────────────────────────────

/**
 * Ores that require deep core equipment (survey scanner + extractor) to mine.
 * These are typically found in hidden POIs with extreme high density.
 */
const DEEP_CORE_ORES = new Set([
  "void_essence",
  "fury_crystal",
  "legacy_ore",
  "prismatic_nebulite",
  "exotic_matter",
  "dark_matter_residue",
]);

/**
 * Check if a resource ID requires deep core equipment to mine.
 */
function isDeepCoreOre(resourceId: string): boolean {
  return DEEP_CORE_ORES.has(resourceId);
}

/**
 * Check if the ship has a deep core survey scanner equipped.
 * This is required to detect hidden POIs and deep core ores.
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

/**
 * Check if the ship has a deep core extractor equipped.
 * This is required to mine deep core ores from hidden POIs.
 */
async function hasDeepCoreExtractor(ctx: RoutineContext): Promise<boolean> {
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
    if (checkStr.includes("deep_core_extractor") ||
        checkStr.includes("deep core extractor") ||
        modSpecial.includes("rare_ore_access")) {
      return true;
    }
  }
  return false;
}

/**
 * Check if the ship has full deep core mining capability (both scanner and extractor).
 * Returns an object with detailed capability info.
 */
async function getDeepCoreCapability(ctx: RoutineContext): Promise<{
  hasScanner: boolean;
  hasExtractor: boolean;
  canMine: boolean;
}> {
  const hasScanner = await hasDeepCoreSurveyScanner(ctx);
  const hasExtractor = await hasDeepCoreExtractor(ctx);
  return {
    hasScanner,
    hasExtractor,
    canMine: hasScanner && hasExtractor,
  };
}

// ── Mission helpers ───────────────────────────────────────────

/** Mission types and keywords that are suitable for miners. */
const MINER_MISSION_KEYWORDS = [
  "mine_resource", "mine", "mining", "extract", "harvest",
  "copper_requisition", "iron_supply_run", "prove_your_steel",
];

/** Accept available mining missions at current station. Respects 5-mission cap. */
async function checkAndAcceptMinerMissions(ctx: RoutineContext): Promise<void> {
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
    const isMinerMission = MINER_MISSION_KEYWORDS.some(kw =>
      name.includes(kw) || desc.includes(kw) || type.includes(kw)
    );
    if (!isMinerMission) continue;
    const acceptResp = await bot.exec("accept_mission", { mission_id: missionId });
    if (!acceptResp.error) {
      activeCount++;
      ctx.log("trade", `Mission accepted: ${(mission.name as string) || missionId} (${activeCount}/5 active)`);
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

// ── Settings ─────────────────────────────────────────────────

type DepositMode = "storage" | "faction" | "sell";
type MiningType = "auto" | "ore" | "gas" | "ice";
type FlockRole = "leader" | "follower";

interface FlockGroupConfig {
  name: string;
  targetOre: string;
  targetGas: string;
  targetIce: string;
  miningType: MiningType;
  rallySystem?: string;
  systemOre?: string; // Ore mining target system for this flock group
  systemGas?: string; // Gas mining target system for this flock group
  systemIce?: string; // Ice mining target system for this flock group
  maxMembers?: number;
  [key: string]: unknown; // Add index signature for compatibility
}

function getMinerSettings(username?: string): {
  miningType: MiningType;
  depositMode: DepositMode;
  depositFallback: DepositMode;
  cargoThreshold: number;
  refuelThreshold: number;
  repairThreshold: number;
  homeSystem: string;
  system: string; // Legacy: fallback if type-specific systems not set
  systemOre: string; // Ore mining target system
  systemGas: string; // Gas mining target system
  systemIce: string; // Ice mining target system
  depositBot: string;
  targetOre: string;
  targetGas: string;
  targetIce: string;
  oreQuotas: Record<string, number>;
  gasQuotas: Record<string, number>;
  iceQuotas: Record<string, number>;
  jettisonOres: string[]; // Ore IDs to jettison when found in cargo during mining
  deepCoreJettisonOres: string[]; // Ore IDs to jettison when mining deep core (hidden POIs)
  depletionTimeoutHours: number;
  ignoreDepletion: boolean;
  stayOutUntilFull: boolean;
  maxJumps: number;
  escortName: string;
  escortSignalChannel: "faction" | "local" | "file";
  // Flock mining settings
  flockEnabled: boolean;
  flockName: string;
  flockRole: FlockRole;
  flockGroups: FlockGroupConfig[];
} {
  const all = readSettings();
  const m = all.miner || {};
  const botOverrides = username ? (all[username] || {}) : {};

  function parseDepositMode(val: unknown): DepositMode | null {
    if (val === "faction" || val === "sell" || val === "storage") return val;
    return null;
  }

  function parseMiningType(val: unknown): MiningType | null {
    if (val === "auto" || val === "ore" || val === "gas" || val === "ice") return val;
    return null;
  }

  function parseSignalChannel(val: unknown): "faction" | "local" | "file" | null {
    if (val === "faction" || val === "local" || val === "file") return val;
    return null;
  }

  function parseFlockRole(val: unknown): FlockRole | null {
    if (val === "leader" || val === "follower") return val;
    return null;
  }

  // Parse flock groups from settings
  const rawFlockGroups = (botOverrides.flockGroups as FlockGroupConfig[]) ?? (m.flockGroups as FlockGroupConfig[]) ?? [];
  const flockGroups: FlockGroupConfig[] = rawFlockGroups.map((g: Record<string, unknown>) => ({
    name: (g.name as string) || "unnamed_flock",
    targetOre: (g.targetOre as string) || (g.target_ore as string) || "",
    targetGas: (g.targetGas as string) || (g.target_gas as string) || "",
    targetIce: (g.targetIce as string) || (g.target_ice as string) || "",
    miningType: parseMiningType(g.miningType) ?? parseMiningType(g.mining_type) ?? "auto",
    rallySystem: (g.rallySystem as string) ?? (g.rally_system as string) ?? undefined,
    systemOre: (g.systemOre as string) ?? (g.system_ore as string) ?? undefined,
    systemGas: (g.systemGas as string) ?? (g.system_gas as string) ?? undefined,
    systemIce: (g.systemIce as string) ?? (g.system_ice as string) ?? undefined,
    maxMembers: (g.maxMembers as number) ?? (g.max_members as number) ?? undefined,
  }));

  return {
    miningType:
      parseMiningType(botOverrides.miningType) ??
      parseMiningType(m.miningType) ?? "auto",
    depositMode:
      parseDepositMode(botOverrides.depositMode) ??
      parseDepositMode(m.depositMode) ?? "storage",
    depositFallback:
      parseDepositMode(botOverrides.depositFallback) ??
      parseDepositMode(m.depositFallback) ?? "storage",
    cargoThreshold: (m.cargoThreshold as number) || 80,
    refuelThreshold: (m.refuelThreshold as number) || 50,
    repairThreshold: (m.repairThreshold as number) || 40,
    homeSystem: (botOverrides.homeSystem as string) || (m.homeSystem as string) || "",
    system: (m.system as string) || "", // Legacy fallback
    systemOre: (botOverrides.systemOre as string) || (m.systemOre as string) || (m.system as string) || "",
    systemGas: (botOverrides.systemGas as string) || (m.systemGas as string) || (m.system as string) || "",
    systemIce: (botOverrides.systemIce as string) || (m.systemIce as string) || (m.system as string) || "",
    depositBot: (botOverrides.depositBot as string) || (m.depositBot as string) || "",
    targetOre: (botOverrides.targetOre as string) || (m.targetOre as string) || "",
    targetGas: (botOverrides.targetGas as string) || (m.targetGas as string) || "",
    targetIce: (botOverrides.targetIce as string) || (m.targetIce as string) || "",
    oreQuotas: (m.oreQuotas as Record<string, number>) || {},
    gasQuotas: (m.gasQuotas as Record<string, number>) || {},
    iceQuotas: (m.iceQuotas as Record<string, number>) || {},
    jettisonOres: (m.jettisonOres as string[]) || [],
    deepCoreJettisonOres: (m.deepCoreJettisonOres as string[]) || [],
    depletionTimeoutHours: (m.depletionTimeoutHours as number) || 3,
    ignoreDepletion: (m.ignoreDepletion as boolean) ?? false,
    stayOutUntilFull: (m.stayOutUntilFull as boolean) ?? false,
    maxJumps: (m.maxJumps as number) ?? 10,
    escortName: (botOverrides.escortName as string) || (m.escortName as string) || "",
    escortSignalChannel:
      parseSignalChannel(botOverrides.escortSignalChannel) ??
      parseSignalChannel(m.escortSignalChannel) ?? "faction",
    // Flock mining settings
    flockEnabled: (botOverrides.flockEnabled as boolean) ?? (m.flockEnabled as boolean) ?? false,
    flockName: (botOverrides.flockName as string) || (m.flockName as string) || "",
    flockRole:
      parseFlockRole(botOverrides.flockRole) ??
      parseFlockRole(m.flockRole) ?? "follower",
    flockGroups,
  };
}

/** Detect mining type from ship modules. Uses cached modules if provided for resilience. */
async function detectMiningType(ctx: RoutineContext, cachedModules?: unknown[]): Promise<"ore" | "gas" | "ice" | null> {
  const { bot } = ctx;
  let shipData: Record<string, unknown>;

  if (cachedModules) {
    shipData = { modules: cachedModules };
  } else {
    const shipResp = await bot.exec("get_ship");
    if (shipResp.error) {
      ctx.log("error", `Failed to get ship info: ${shipResp.error.message}`);
      return null;
    }
    shipData = shipResp.result as Record<string, unknown>;
  }

  const modules = Array.isArray(shipData.modules) ? shipData.modules : [];

  let hasMiningLaser = false;
  let hasGasHarvester = false;
  let hasIceHarvester = false;

  for (const mod of modules) {
    const modObj = typeof mod === "object" && mod !== null ? mod as Record<string, unknown> : null;
    const modId = (modObj?.id as string) || (modObj?.type_id as string) || "";
    const modName = (modObj?.name as string) || "";
    const modType = (modObj?.type as string) || "";

    const checkStr = `${modId} ${modName} ${modType}`.toLowerCase();

    if (checkStr.includes("mining_laser") || checkStr.includes("mining laser")) {
      hasMiningLaser = true;
    }
    if (checkStr.includes("gas_harvester") || checkStr.includes("gas harvester")) {
      hasGasHarvester = true;
    }
    if (checkStr.includes("ice_harvester") || checkStr.includes("ice harvester")) {
      hasIceHarvester = true;
    }
  }

  // Priority: ice > gas > ore (if multiple types present, use settings preference)
  const detectedTypes: string[] = [];
  if (hasMiningLaser) detectedTypes.push("ore");
  if (hasGasHarvester) detectedTypes.push("gas");
  if (hasIceHarvester) detectedTypes.push("ice");

  if (detectedTypes.length > 1) {
    ctx.log("info", `Multiple mining modules detected (${detectedTypes.join(", ")}) — using settings preference`);
    return "ore"; // Default to ore if multiple present
  }
  if (hasIceHarvester) {
    ctx.log("info", "Ice harvester detected — ice mining mode");
    return "ice";
  }
  if (hasGasHarvester) {
    ctx.log("info", "Gas harvester detected — gas harvesting mode");
    return "gas";
  }
  if (hasMiningLaser) {
    ctx.log("info", "Mining laser detected — ore mining mode");
    return "ore";
  }

  // Check for deep core equipment (survey scanner + extractor) — counts as ore mining
  const deepCoreCap = await getDeepCoreCapability(ctx);
  if (deepCoreCap.canMine) {
    ctx.log("info", "Deep core mining equipment detected — ore mining mode (hidden POIs)");
    return "ore";
  }

  ctx.log("error", "No mining equipment detected on ship");
  return null;
}

/** Quick check: does the ship have equipment for a specific mining type? */
async function hasEquipmentForMiningType(ctx: RoutineContext, miningType: "ore" | "gas" | "ice", cachedModules?: unknown[]): Promise<boolean> {
  const { bot } = ctx;
  let modules: unknown[];

  if (cachedModules) {
    modules = cachedModules;
  } else {
    const shipResp = await bot.exec("get_ship");
    if (shipResp.error) return false;
    const shipData = shipResp.result as Record<string, unknown>;
    modules = Array.isArray(shipData.modules) ? shipData.modules : [];
  }

  const moduleStr = modules.map(m => {
    const obj = typeof m === "object" && m !== null ? m as Record<string, unknown> : {};
    return `${obj.id || ""} ${obj.name || ""} ${obj.type || ""}`.toLowerCase();
  }).join(" ");

  switch (miningType) {
    case "ore":
      return moduleStr.includes("mining_laser") || moduleStr.includes("mining laser") ||
             moduleStr.includes("deep_core_survey_scanner") || moduleStr.includes("deep core survey scanner");
    case "gas": return moduleStr.includes("gas_harvester") || moduleStr.includes("gas harvester");
    case "ice": return moduleStr.includes("ice_harvester") || moduleStr.includes("ice harvester");
  }
}

/** Detect deep core mining capability and log it. */
async function logDeepCoreCapability(ctx: RoutineContext): Promise<void> {
  const deepCoreCap = await getDeepCoreCapability(ctx);
  if (deepCoreCap.hasScanner || deepCoreCap.hasExtractor) {
    const parts: string[] = [];
    if (deepCoreCap.hasScanner) parts.push("survey scanner");
    if (deepCoreCap.hasExtractor) parts.push("deep core extractor");
    ctx.log("mining", `Deep core equipment detected: ${parts.join(" + ")}`);
    if (deepCoreCap.canMine) {
      ctx.log("mining", "Deep core mining capability: FULL (can mine hidden POIs)");
    } else {
      if (!deepCoreCap.hasScanner) ctx.log("warn", "Deep core mining INCOMPLETE: missing survey scanner");
      if (!deepCoreCap.hasExtractor) ctx.log("warn", "Deep core mining INCOMPLETE: missing extractor");
    }
  }
}

/** Get expected mining type for a resource ID. */
function getMiningTypeForResource(resourceId: string): "ore" | "gas" | "ice" {
  const lower = resourceId.toLowerCase();

  // Gas resources (including legacy names like compressed_hydrogen)
  if (lower.includes("gas") ||
      lower.includes("hydrogen") || 
      lower.includes("helium") || 
      lower.includes("argon") || 
      lower.includes("neon") || 
      lower.includes("chlorine") || 
      lower.includes("nitrogen") || 
      lower.includes("oxygen") ||
      lower.includes("compressed_")) {
    return "gas";
  }
  
  // Ice resources
  if (lower.includes("ice") || lower.includes("frost") || lower.includes("cryo") || lower.includes("water_ice")) {
    return "ice";
  }
  
  // Default to ore
  return "ore";
}

/** Pick target resource based on quota deficits. Returns the resource ID with biggest deficit. */
function pickTargetFromQuotas(
  quotas: Record<string, number>,
  factionStorage: Array<{ itemId: string; quantity: number }>,
  miningType: "ore" | "gas" | "ice"
): string {
  const entries: Array<{ resourceId: string; deficit: number; current: number; target: number }> = [];

  for (const [resourceId, target] of Object.entries(quotas)) {
    if (target <= 0) continue;
    const current = factionStorage.find(i => i.itemId === resourceId)?.quantity || 0;
    const deficit = target - current;
    if (deficit > 0) {
      entries.push({ resourceId, deficit, current, target });
    }
  }

  if (entries.length === 0) return "";

  // Sort: biggest deficit first
  entries.sort((a, b) => b.deficit - a.deficit);
  return entries[0].resourceId;
}

/** Find appropriate POI based on mining type. */
function findMiningPoi(
  pois: Array<{ id: string; name: string; type: string }>,
  miningType: "ore" | "gas" | "ice",
  targetResource?: string
): { id: string; name: string } | null {
  if (miningType === "ice") {
    // Ice mining
    if (targetResource) {
      for (const poi of pois) {
        if (isIceFieldPoi(poi.type)) {
          const sysData = mapStore.getSystem(poi.id.split("-")[0] || "");
          const storedPoi = sysData?.pois.find(p => p.id === poi.id);
          if (storedPoi?.ores_found.some(o => o.item_id === targetResource)) {
            return { id: poi.id, name: poi.name };
          }
        }
      }
    }
    // Fallback: any ice field
    const iceField = pois.find(p => isIceFieldPoi(p.type));
    return iceField ? { id: iceField.id, name: iceField.name } : null;
  } else if (miningType === "ore") {
    // Ore mining
    if (targetResource) {
      for (const poi of pois) {
        if (isOreBeltPoi(poi.type)) {
          const sysData = mapStore.getSystem(poi.id.split("-")[0] || "");
          const storedPoi = sysData?.pois.find(p => p.id === poi.id);
          if (storedPoi?.ores_found.some(o => o.item_id === targetResource)) {
            return { id: poi.id, name: poi.name };
          }
        }
      }
    }
    // Fallback: any ore belt
    const oreBelt = pois.find(p => isOreBeltPoi(p.type));
    return oreBelt ? { id: oreBelt.id, name: oreBelt.name } : null;
  } else {
    // Gas harvesting
    if (targetResource) {
      for (const poi of pois) {
        if (isGasCloudPoi(poi.type)) {
          const sysData = mapStore.getSystem(poi.id.split("-")[0] || "");
          const storedPoi = sysData?.pois.find(p => p.id === poi.id);
          if (storedPoi?.ores_found.some(o => o.item_id === targetResource)) {
            return { id: poi.id, name: poi.name };
          }
        }
      }
    }
    // Fallback: any gas cloud
    const gasCloud = pois.find(p => isGasCloudPoi(p.type));
    return gasCloud ? { id: gasCloud.id, name: gasCloud.name } : null;
  }
}

// ── Flock coordination ─────────────────────────────────────────

/**
 * Flock coordination state shared via file system.
 * Leader writes decisions, followers read and follow.
 */
interface FlockState {
  leader: string;
  targetSystemId: string;
  targetPoiId: string;
  targetPoiName: string;
  targetResourceId: string;
  miningType: "ore" | "gas" | "ice";
  phase: "gathering" | "traveling" | "mining" | "returning" | "docked";
  members: string[];
  lastUpdate: number;
  rallySystem?: string;
}

/**
 * Get the flock state file path for a given flock name.
 */
async function getFlockStatePath(flockName: string): Promise<string> {
  const { join } = await import("path");
  return join(process.cwd(), "data", "flock_signals", `${flockName}.json`);
}

/**
 * Read the current flock state. Returns null if no state exists or it's stale (>60s).
 */
async function readFlockState(flockName: string): Promise<FlockState | null> {
  const { readFileSync, existsSync } = await import("fs");
  const flockPath = await getFlockStatePath(flockName);
  
  if (!existsSync(flockPath)) return null;
  
  try {
    const raw = readFileSync(flockPath, "utf-8");
    const state = JSON.parse(raw) as FlockState;
    
    // Check if state is stale (older than 60 seconds)
    if (Date.now() - state.lastUpdate > 60_000) {
      return null;
    }
    
    return state;
  } catch (e) {
    return null;
  }
}

/**
 * Write flock state to the shared file.
 */
async function writeFlockState(flockName: string, state: FlockState): Promise<void> {
  const { writeFileSync, existsSync, mkdirSync } = await import("fs");
  const { join } = await import("path");
  const flockDir = join(process.cwd(), "data", "flock_signals");
  
  if (!existsSync(flockDir)) {
    mkdirSync(flockDir, { recursive: true });
  }
  
  const flockPath = await getFlockStatePath(flockName);
  state.lastUpdate = Date.now();
  writeFileSync(flockPath, JSON.stringify(state, null, 2));
}

/**
 * Clear flock state file (used when leaving flock or session ends).
 */
async function clearFlockState(flockName: string): Promise<void> {
  const { existsSync, unlinkSync } = await import("fs");
  const flockPath = await getFlockStatePath(flockName);
  
  if (existsSync(flockPath)) {
    try {
      unlinkSync(flockPath);
    } catch (e) {
      // Ignore errors
    }
  }
}

/**
 * Register this bot as a member of the flock.
 * Leader adds itself to the members list.
 */
async function registerFlockMember(
  flockName: string,
  username: string,
  isLeader: boolean,
): Promise<FlockState | null> {
  const existingState = await readFlockState(flockName);
  
  if (isLeader) {
    // Leader creates or updates the flock state
    const newState: FlockState = {
      leader: username,
      targetSystemId: "",
      targetPoiId: "",
      targetPoiName: "",
      targetResourceId: "",
      miningType: "ore",
      phase: "gathering",
      members: existingState?.members ? [...new Set([...existingState.members, username])] : [username],
      lastUpdate: Date.now(),
    };
    await writeFlockState(flockName, newState);
    return newState;
  } else {
    // Follower joins existing flock
    if (!existingState) return null;
    
    // Check if flock has room (if maxMembers is set)
    // Note: maxMembers check happens at higher level
    if (!existingState.members.includes(username)) {
      existingState.members.push(username);
    }
    await writeFlockState(flockName, existingState);
    return existingState;
  }
}

/**
 * Remove this bot from the flock members list.
 */
async function unregisterFlockMember(
  flockName: string,
  username: string,
): Promise<void> {
  const existingState = await readFlockState(flockName);
  
  if (existingState) {
    existingState.members = existingState.members.filter(m => m !== username);
    
    // If leader is leaving, elect new leader or clear state
    if (existingState.leader === username) {
      if (existingState.members.length > 0) {
        existingState.leader = existingState.members[0];
      } else {
        await clearFlockState(flockName);
        return;
      }
    }
    
    await writeFlockState(flockName, existingState);
  }
}

/**
 * Leader announces target selection to flock.
 */
async function announceFlockTarget(
  flockName: string,
  leader: string,
  targetSystemId: string,
  targetPoiId: string,
  targetPoiName: string,
  targetResourceId: string,
  miningType: "ore" | "gas" | "ice",
  rallySystem?: string,
): Promise<void> {
  const existingState = await readFlockState(flockName);
  
  const newState: FlockState = {
    leader,
    targetSystemId,
    targetPoiId,
    targetPoiName,
    targetResourceId,
    miningType,
    phase: existingState?.phase === "mining" ? "mining" : "traveling",
    members: existingState?.members || [leader],
    lastUpdate: Date.now(),
    rallySystem,
  };
  
  await writeFlockState(flockName, newState);
}

/**
 * Update flock phase.
 */
async function updateFlockPhase(
  flockName: string,
  phase: FlockState["phase"],
): Promise<void> {
  const existingState = await readFlockState(flockName);
  
  if (existingState) {
    existingState.phase = phase;
    await writeFlockState(flockName, existingState);
  }
}

// ── Escort signaling ─────────────────────────────────────────

/**
 * Send a coordination signal to escort bots.
 * Uses faction chat by default, can also use local log or file.
 */
async function signalEscort(
  ctx: RoutineContext,
  action: "jump" | "travel" | "dock" | "undock",
  systemId?: string,
  channel: "faction" | "local" | "file" = "faction",
): Promise<void> {
  const { bot } = ctx;
  const message = `[ESCORT] ${action}${systemId ? ` ${systemId}` : ""}`;

  if (channel === "faction") {
    await bot.exec("chat", { channel: "faction", content: message });
  } else if (channel === "local") {
    ctx.log("escort", `Signal: ${message}`);
  } else {
    // File-based signaling for cross-bot coordination on same machine
    const { writeFileSync, existsSync, mkdirSync } = await import("fs");
    const { join } = await import("path");
    const escortDir = join(process.cwd(), "data", "escort_signals");
    if (!existsSync(escortDir)) mkdirSync(escortDir, { recursive: true });
    const signalFile = join(escortDir, `${bot.username}.signal`);
    writeFileSync(signalFile, JSON.stringify({ action, systemId, timestamp: Date.now() }));
  }
}

/**
 * Dump all non-fuel cargo at the current station. Used when returning home early due to depletion.
 */
async function dumpCargo(ctx: RoutineContext, settings: ReturnType<typeof getMinerSettings>): Promise<void> {
  const { bot } = ctx;
  await bot.refreshCargo();
  const cargoItems = bot.inventory.filter(i => {
    if (i.quantity <= 0) return false;
    const lower = i.itemId.toLowerCase();
    return !lower.includes("fuel") && !lower.includes("energy_cell");
  });
  if (cargoItems.length === 0) {
    ctx.log("harvesting", "No cargo to deposit");
    return;
  }
  let hadFallback = false;
  for (const item of cargoItems) {
    if (settings.depositMode === "faction") {
      const fResp = await bot.exec("faction_deposit_items", { item_id: item.itemId, quantity: item.quantity });
      if (fResp.error) {
        ctx.log("warn", `Faction deposit failed for ${item.name}: ${fResp.error.message} — falling back to personal storage`);
        await bot.exec("deposit_items", { item_id: item.itemId, quantity: item.quantity });
        hadFallback = true;
      }
    } else {
      await bot.exec("deposit_items", { item_id: item.itemId, quantity: item.quantity });
    }
  }
  const names = cargoItems.map(i => `${i.quantity}x ${i.name}`).join(", ");
  const locationTag = hadFallback ? " to personal storage (fallback)" : "";
  ctx.log("harvesting", `Deposited ${names}${locationTag} — cargo cleared`);
}

/**
 * Cache ship modules at routine start or after death recovery.
 * This avoids repeated get_ship calls that may return incomplete data
 * when the server is still processing (e.g. after a jump timeout).
 * Returns the modules array, or null if detection failed.
 */
async function cacheShipModules(ctx: RoutineContext): Promise<unknown[] | null> {
  const { bot } = ctx;
  const shipResp = await bot.exec("get_ship");
  if (shipResp.error) {
    ctx.log("warn", `Failed to cache ship modules: ${shipResp.error.message}`);
    return null;
  }
  const shipData = shipResp.result as Record<string, unknown>;
  const modules = Array.isArray(shipData.modules) ? shipData.modules : [];
  if (modules.length === 0) {
    ctx.log("warn", "Ship modules not returned from get_ship — server may still be processing");
    return null;
  }
  ctx.log("system", `Cached ${modules.length} ship modules for routine use`);
  return modules;
}

// ── Miner routine ────────────────────────────────────────────

export const minerRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  await bot.refreshStatus();
  const settings0 = getMinerSettings(bot.username);
  const homeSystem = settings0.homeSystem || bot.system;

  // ── Cache ship modules at routine start ──
  // This avoids repeated get_ship calls that may return incomplete data
  // when the server is still processing (e.g. after a jump timeout).
  let cachedModules: unknown[] | null = await cacheShipModules(ctx);

  // ── Mining session recovery ──
  const activeSession = getActiveMiningSession(bot.username);
  let recoveredSession: MiningSession | null = null;
  if (activeSession) {
    ctx.log("mining", `Found incomplete mining session: ${activeSession.targetResourceName} (${activeSession.state})`);
    // Validate session - check if target resource is still valid
    if (activeSession.targetResourceId) {
      const locations = mapStore.findOreLocations(activeSession.targetResourceId);
      if (locations.length > 0) {
        // Also check if we have equipment for this resource type
        const sessionMiningType = getMiningTypeForResource(activeSession.targetResourceId);
        const hasEquipment = await hasEquipmentForMiningType(ctx, sessionMiningType, cachedModules || undefined);
        if (!hasEquipment) {
          ctx.log("error", `Session invalid: no equipment for ${sessionMiningType} mining (${activeSession.targetResourceName}) — abandoning`);
          failMiningSession(bot.username, "No equipment for resource type");
        } else {
          ctx.log("mining", `Session validated: ${activeSession.targetResourceName} still available in map`);
          recoveredSession = activeSession;
        }
      } else {
        ctx.log("error", `Session invalid: ${activeSession.targetResourceName} no longer in map - abandoning`);
        failMiningSession(bot.username, "Target resource no longer in map");
      }
    } else {
      ctx.log("error", "Session invalid: no target resource - abandoning");
      failMiningSession(bot.username, "No target resource");
    }
  }

  // ── Startup: accept missions ──
  await completeActiveMissions(ctx);
  await checkAndAcceptMinerMissions(ctx);

  while (bot.state === "running") {
    // ── Death recovery ──
    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) { await sleep(30000); continue; }

    // ── Refresh cached ship modules after death recovery ──
    // (modules could change if ship was destroyed and replaced)
    cachedModules = await cacheShipModules(ctx);

    // ── Battle state tracking (per-cycle initialization) ──
    const battleState: BattleState = {
      inBattle: false,
      battleId: null,
      battleStartTick: null,
      lastHitTick: null,
      isFleeing: false,
    };

    const settings = getMinerSettings(bot.username);
    const cargoThresholdRatio = settings.cargoThreshold / 100;
    const safetyOpts = {
      fuelThresholdPct: settings.refuelThreshold,
      hullThresholdPct: settings.repairThreshold,
    };
    const depletionTimeoutMs = settings.depletionTimeoutHours * 60 * 60 * 1000;

    // ── Deep core equipment detection (log once per cycle) ──
    await logDeepCoreCapability(ctx);

    // ── Flock mining integration ──
    let isFlockLeader = false;
    let flockTargetResource = "";
    let flockTargetSystemId = "";
    let flockTargetPoiId = "";
    let flockTargetPoiName = "";
    let flockMiningType: "ore" | "gas" | "ice" = "ore";
    let flockPhase: FlockState["phase"] = "gathering";
    let flockGroup: FlockGroupConfig | undefined;

    if (settings.flockEnabled && settings.flockName) {
      // Find the flock group config for this bot
      flockGroup = settings.flockGroups.find(g => g.name === settings.flockName);
      
      if (settings.flockRole === "leader") {
        isFlockLeader = true;
        ctx.log("flock", `Flock mode: LEADER of "${settings.flockName}"`);
        
        // Register as leader
        await registerFlockMember(settings.flockName, bot.username, true);
        
        // Determine target from flock group config or personal settings
        const groupMiningType = flockGroup?.miningType ?? settings.miningType;
        let actualMiningType: "ore" | "gas" | "ice" = "ore";
        
        if (groupMiningType === "auto") {
          const detected = await detectMiningType(ctx, cachedModules || undefined);
          if (!detected) {
            ctx.log("error", "Cannot determine mining type for flock leader — waiting 30s");
            await sleep(30000);
            continue;
          }
          actualMiningType = detected;
        } else {
          actualMiningType = groupMiningType as "ore" | "gas" | "ice";
        }
        
        const groupTarget = actualMiningType === "ice"
          ? (flockGroup?.targetIce || settings.targetIce)
          : (actualMiningType === "ore"
            ? (flockGroup?.targetOre || settings.targetOre)
            : (flockGroup?.targetGas || settings.targetGas));

        // CRITICAL FIX: Use type-specific system from flock group config if available
        const groupSystem = actualMiningType === "ice"
          ? (flockGroup?.systemIce || settings.systemIce || settings.system)
          : (actualMiningType === "ore"
            ? (flockGroup?.systemOre || settings.systemOre || settings.system)
            : (flockGroup?.systemGas || settings.systemGas || settings.system));

        flockTargetResource = groupTarget || "";
        flockMiningType = actualMiningType;
        flockPhase = "gathering";

        // Deep core miner restriction for flock leaders: if this miner has deep core equipment,
        // only accept deep core ore targets. Ignore regular ore targets from settings.
        const deepCoreCap = await getDeepCoreCapability(ctx);
        if (deepCoreCap.canMine && flockTargetResource && !isDeepCoreOre(flockTargetResource)) {
          ctx.log("flock", `Deep core miner — ignoring regular ore target "${flockTargetResource}", will search for deep core ores`);
          flockTargetResource = "";
        }

        ctx.log("flock", `Leader target: ${flockTargetResource || "any deep core ore"} (${flockMiningType}) @ ${groupSystem || "any system"}`);
      } else {
        // Follower: read flock state and follow leader's decisions
        const flockState = await readFlockState(settings.flockName);
        
        if (!flockState) {
          ctx.log("flock", `Flock mode: FOLLOWER of "${settings.flockName}" — waiting for leader...`);
          // Wait for leader to announce target
          await sleep(5000);
          continue;
        }
        
        // Register as follower
        const registered = await registerFlockMember(settings.flockName, bot.username, false);
        if (!registered) {
          ctx.log("error", "Failed to join flock — state may be stale");
          await sleep(5000);
          continue;
        }
        
        ctx.log("flock", `Flock mode: FOLLOWER of "${settings.flockName}" (leader: ${flockState.leader})`);
        
        flockTargetResource = flockState.targetResourceId;
        flockTargetSystemId = flockState.targetSystemId;
        flockTargetPoiId = flockState.targetPoiId;
        flockTargetPoiName = flockState.targetPoiName;
        flockMiningType = flockState.miningType;
        flockPhase = flockState.phase;
        
        // Check max members if configured
        if (flockGroup?.maxMembers && flockState.members.length > flockGroup.maxMembers) {
          ctx.log("warn", `Flock "${settings.flockName}" is full (${flockState.members.length}/${flockGroup.maxMembers}) — mining solo`);
          // Continue with solo mining
        } else {
          ctx.log("flock", `Following leader to: ${flockTargetPoiName || flockTargetSystemId || "TBD"} (${flockTargetResource || "any"}, ${flockMiningType})`);
        }
      }
    }

    // ── Re-evaluate mining type and target from settings each cycle ──
    let miningType: "ore" | "gas" | "ice" = "ore";
    if (settings.miningType === "auto") {
      const detected = await detectMiningType(ctx, cachedModules || undefined);
      if (!detected) {
        ctx.log("error", "Cannot determine mining type — please check ship equipment");
        await sleep(30000);
        continue;
      }
      miningType = detected;
    } else {
      miningType = settings.miningType;
    }

    // Smart target selection: when mining type is auto-detected, only use the
    // matching target field (no cross-type fallback). A gas harvester should
    // never be forced to mine ore just because targetGas is empty.
    // When mining type is manually forced, fall back to other targets as backup.
    let targetResource = "";
    let resourceLabel = "";
    const isAutoDetected = settings.miningType === "auto";

    if (miningType === "ice") {
      targetResource = isAutoDetected ? settings.targetIce : (settings.targetIce || settings.targetOre || settings.targetGas);
      resourceLabel = targetResource === settings.targetGas ? "gas" : (targetResource === settings.targetOre ? "ore" : "ice");
    } else if (miningType === "ore") {
      targetResource = isAutoDetected ? settings.targetOre : (settings.targetOre || settings.targetGas || settings.targetIce);
      resourceLabel = targetResource === settings.targetGas ? "gas" : (targetResource === settings.targetIce ? "ice" : "ore");
    } else {
      // gas
      targetResource = isAutoDetected ? settings.targetGas : (settings.targetGas || settings.targetOre || settings.targetIce);
      resourceLabel = targetResource === settings.targetOre ? "ore" : (targetResource === settings.targetIce ? "ice" : "gas");
    }

    // Log mining configuration (re-checked each cycle)
    if (targetResource) {
      ctx.log("mining", `Target ${resourceLabel}: ${targetResource} (mode: ${settings.miningType})`);
    } else {
      ctx.log("mining", `Mining any ${resourceLabel} (no specific target configured)`);
      // Debug: Log what settings were loaded to help diagnose targeting issues
      ctx.log("debug", `Settings loaded: targetOre="${settings.targetOre}", targetGas="${settings.targetGas}", targetIce="${settings.targetIce}"`);
      ctx.log("debug", `System targets: systemOre="${settings.systemOre}", systemGas="${settings.systemGas}", systemIce="${settings.systemIce}"`);
    }

    // ── Select quotas based on mining type ──
    const quotas = miningType === "ice" ? settings.iceQuotas : (miningType === "ore" ? settings.oreQuotas : settings.gasQuotas);

    // ── Determine priority target (global target or quota pick) ──
    const hasGlobalTarget = !!targetResource;
    if (hasGlobalTarget) {
      ctx.log("mining", `Global ${resourceLabel} target configured: ${targetResource} — overriding quotas`);
    }

    let quotaTargetResource = "";
    if (!hasGlobalTarget && Object.keys(quotas).length > 0) {
      await bot.refreshFactionStorage();
      quotaTargetResource = pickTargetFromQuotas(quotas, bot.factionStorage, miningType);
      if (quotaTargetResource) {
        ctx.log("mining", `Quota pick: ${quotaTargetResource} (biggest deficit)`);
      } else {
        ctx.log("mining", "All quotas met — mining locally");
      }
    }

    const priorityTarget = hasGlobalTarget ? targetResource : quotaTargetResource;

    // ── Recovered session handling ──
    // Validate recovered session against current priorities (global target and quotas)
    if (recoveredSession) {
      // Validate that the recovered session's target is compatible with currently detected mining type
      const sessionMiningType = getMiningTypeForResource(recoveredSession.targetResourceId);
      if (sessionMiningType !== miningType) {
        ctx.log("warn", `Recovered session target (${recoveredSession.targetResourceName}) incompatible with detected equipment (${miningType}) — discarding session`);
        failMiningSession(bot.username, "Equipment mismatch");
        recoveredSession = null;
      } else {
        // Check if recovered session target matches current priorities
        const sessionTarget = recoveredSession.targetResourceId;
        let shouldAbandon = false;
        let reason = "";

        // If there's a priority target (global or quota) that differs from session target, abandon session
        if (priorityTarget && sessionTarget !== priorityTarget) {
          shouldAbandon = true;
          reason = hasGlobalTarget ? `global target override (${targetResource})` : `quota priority (${quotaTargetResource})`;
        }

        if (shouldAbandon) {
          ctx.log("mining", `Abandoning recovered session: ${reason}`);
          failMiningSession(bot.username, reason);
          recoveredSession = null;
        } else {
          ctx.log("mining", `Resuming recovered session: ${recoveredSession.targetResourceName} @ ${recoveredSession.targetPoiName}`);
          // Update session state based on current position
          if (bot.system === recoveredSession.homeSystem && bot.docked) {
            recoveredSession.state = "depositing";
          } else if (bot.system === recoveredSession.targetSystemId) {
            recoveredSession.state = "mining";
          } else {
            recoveredSession.state = "traveling_to_ore";
          }
          updateMiningSession(bot.username, { state: recoveredSession.state });
        }
      }
    }

    // ── Determine effective target ──
    let effectiveTarget = recoveredSession ? recoveredSession.targetResourceId : priorityTarget;
    const isQuotaDriven = recoveredSession ? recoveredSession.isQuotaDriven : !!quotaTargetResource;
    const maxJumps = settings.maxJumps || 10;
    
    // Initialize target location variables (may be set by deep core search below)
    let targetSystemId = "";
    let targetPoiId = "";
    let targetPoiName = "";

    // ── Deep core miner restriction ──
    // If the miner has full deep core capability, restrict mining to deep core ores only
    // This prevents deep core miners from being assigned to mundane regular ores
    const deepCoreCap = await getDeepCoreCapability(ctx);
    if (deepCoreCap.canMine) {
      // If current target is not a deep core ore, search for one
      if (effectiveTarget && !isDeepCoreOre(effectiveTarget)) {
        ctx.log("mining", `Deep core miner detected — restricting to deep core ores only`);
        ctx.log("mining", `Target ${effectiveTarget} is NOT a deep core ore — searching for deep core target`);
        effectiveTarget = "";
        if (recoveredSession) {
          ctx.log("mining", "Abandoning recovered session: not a deep core ore");
          failMiningSession(bot.username, "Not a deep core ore");
          recoveredSession = null;
        }
      }

      // If no effective target, search for available deep core ores
      if (!effectiveTarget) {
        ctx.log("mining", "Searching for available deep core ore targets...");
        const blacklist = getSystemBlacklist();
        let foundDeepCoreTarget = false;

        // Try each deep core ore to find an available target
        for (const deepCoreOre of DEEP_CORE_ORES) {
          const locations = mapStore.findOreLocations(deepCoreOre).filter(loc => {
            const sys = mapStore.getSystem(loc.systemId);
            const poi = sys?.pois.find(p => p.id === loc.poiId);
            // Deep core ores are in hidden POIs, so check for ore belts (they might be hidden)
            return isOreBeltPoi(poi?.type || "") || poi?.hidden === true;
          }).filter(loc => {
            // Skip completely exhausted POIs
            if (loc.remaining !== undefined && loc.remaining <= 0 && loc.maxRemaining !== undefined && loc.maxRemaining > 0) {
              return false;
            }
            if (settings.ignoreDepletion) return true;
            const sys = mapStore.getSystem(loc.systemId);
            const poi = sys?.pois.find(p => p.id === loc.poiId);
            const oreEntry = poi?.ores_found.find(o => o.item_id === deepCoreOre);
            if (!oreEntry?.depleted) return true;
            return isDepletionExpired(oreEntry.depleted_at, depletionTimeoutMs);
          });

          if (locations.length > 0) {
            // Score locations and pick best one
            const scoredLocations = mapStore.findBestMiningLocation(deepCoreOre, bot.system, blacklist)
              .filter(loc => locations.some(l => l.poiId === loc.poiId && l.systemId === loc.systemId))
              .map(loc => {
                const route = mapStore.findRoute(bot.system, loc.systemId, blacklist);
                return { ...loc, jumps: route ? route.length - 1 : 999 };
              })
              .filter(loc => loc.jumps <= maxJumps);

            if (scoredLocations.length > 0) {
              const chosen = scoredLocations[0];
              effectiveTarget = deepCoreOre;
              targetPoiId = chosen.poiId;
              targetPoiName = chosen.poiName;
              targetSystemId = chosen.systemId;
              const hiddenTag = chosen.isHidden ? " [HIDDEN POI]" : "";
              const scanInfo = chosen.minutesSinceScan === Infinity ? "(never scanned)" : `(${chosen.remaining.toLocaleString()}/${chosen.maxRemaining.toLocaleString()}, richness: ${chosen.richness})`;
              ctx.log("mining", `Found deep core target: ${deepCoreOre} @ ${chosen.poiName} in ${chosen.systemName} (${chosen.jumps} jumps)${hiddenTag} ${scanInfo}`);
              foundDeepCoreTarget = true;
              break;
            }
          }
        }

        if (!foundDeepCoreTarget) {
          ctx.log("error", "No deep core ore targets found — waiting 60s before retry");
          await sleep(60000);
          continue;
        }
      }
    }

    // ── Deep core ore equipment validation ──
    // If the target is a deep core ore, verify we have the proper equipment
    if (effectiveTarget && isDeepCoreOre(effectiveTarget)) {
      const deepCoreCap = await getDeepCoreCapability(ctx);
      if (!deepCoreCap.canMine) {
        ctx.log("error", `Target ${effectiveTarget} is a deep core ore — requires deep core survey scanner + extractor`);
        if (!deepCoreCap.hasScanner) {
          ctx.log("error", "  Missing: Deep Core Survey Scanner (detection capability)");
        }
        if (!deepCoreCap.hasExtractor) {
          ctx.log("error", "  Missing: Deep Core Extractor (mining capability)");
        }
        ctx.log("error", "  Skipping deep core target — selecting alternative target");
        // Clear the target so we fall back to non-deep-core mining
        effectiveTarget = "";
        if (recoveredSession) {
          ctx.log("mining", "Abandoning recovered session due to equipment mismatch");
          failMiningSession(bot.username, "Deep core ore — missing equipment");
          recoveredSession = null;
        }
      } else {
        ctx.log("mining", `Deep core target validated: ${effectiveTarget} (scanner + extractor equipped)`);
      }
    }

    // ── Flock target override ──
    // If flock mode is enabled and we have a flock target, use it instead
    if (settings.flockEnabled && settings.flockName && flockTargetResource) {
      // For followers, also override mining type and system/POI from flock state
      if (!isFlockLeader) {
        miningType = flockMiningType;
        ctx.log("flock", `Using flock target: ${flockTargetResource} (${miningType})`);
      }
      
      // Deep core validation for flock target
      if (isDeepCoreOre(flockTargetResource)) {
        const deepCoreCap = await getDeepCoreCapability(ctx);
        if (!deepCoreCap.canMine) {
          ctx.log("error", `Flock target ${flockTargetResource} is a deep core ore — skipping (missing equipment)`);
          if (!deepCoreCap.hasScanner) ctx.log("error", "  Missing: Deep Core Survey Scanner");
          if (!deepCoreCap.hasExtractor) ctx.log("error", "  Missing: Deep Core Extractor");
          // Don't override effectiveTarget — continue with solo mining instead
        } else {
          effectiveTarget = flockTargetResource;
          ctx.log("mining", `Flock deep core target validated: ${flockTargetResource}`);
        }
      } else {
        effectiveTarget = flockTargetResource;
      }
    }

    // ── Status + fuel/hull checks ──
    yield "get_status";
    await bot.refreshStatus();

    yield "fuel_check";
    const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
    if (!fueled) {
      ctx.log("error", "Cannot refuel — waiting 30s...");
      await sleep(30000);
      continue;
    }

    await bot.refreshStatus();
    const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    if (hullPct <= 40) {
      ctx.log("system", `Hull critical (${hullPct}%) — returning to station for repair`);
      await ensureDocked(ctx);
      await repairShip(ctx);
    }

    // Signal escorts that we're undocking (they should prepare to follow)
    if (settings.escortName) {
      ctx.log("escort", "Signaling escorts: miner undocking...");
      await signalEscort(ctx, "undock", undefined, settings.escortSignalChannel);
    }

    await ensureUndocked(ctx);

    // ── Determine mining destination ──
    yield "find_destination";
    // targetSystemId, targetPoiId, targetPoiName already declared above

    // Smart system selection: check the matching mining type first, but fall back
    // to other fields or legacy `system` setting if not configured.
    let configuredSystem = "";
    if (miningType === "ice") {
      configuredSystem = settings.systemIce || settings.systemOre || settings.systemGas || settings.system || "";
    } else if (miningType === "ore") {
      configuredSystem = settings.systemOre || settings.systemGas || settings.systemIce || settings.system || "";
    } else {
      // gas
      configuredSystem = settings.systemGas || settings.systemOre || settings.systemIce || settings.system || "";
    }

    if (configuredSystem) {
      ctx.log("mining", `Configured harvesting system for ${miningType}: ${configuredSystem}`);
    }

    if (effectiveTarget) {
      const allLocations = mapStore.findOreLocations(effectiveTarget);
      // Filter to matching POI type only (skip depleted)
      const locations = allLocations.filter(loc => {
        const sys = mapStore.getSystem(loc.systemId);
        const poi = sys?.pois.find(p => p.id === loc.poiId);
        if (!poi) return true; // keep if type unknown
        if (miningType === "ore") return isOreBeltPoi(poi.type) || poi.hidden === true;
        if (miningType === "gas") return isGasCloudPoi(poi.type);
        if (miningType === "ice") return isIceFieldPoi(poi.type);
        return true;
      }).filter(loc => {
        // Skip depleted ores (unless depletion has expired or ignoreDepletion is enabled)
        if (settings.ignoreDepletion) {
          // Even with ignoreDepletion, skip completely exhausted POIs (0 remaining)
          if (loc.remaining !== undefined && loc.remaining <= 0 && loc.maxRemaining !== undefined && loc.maxRemaining > 0) {
            return false;
          }
          return true;
        }
        const sys = mapStore.getSystem(loc.systemId);
        const poi = sys?.pois.find(p => p.id === loc.poiId);
        const oreEntry = poi?.ores_found.find(o => o.item_id === effectiveTarget);
        if (!oreEntry?.depleted) return true;
        // Depleted but expired - can re-check
        return isDepletionExpired(oreEntry.depleted_at, depletionTimeoutMs);
      });

      if (locations.length === 0) {
        ctx.log("error", `Target ${resourceLabel} "${effectiveTarget}" not found in map — mining locally in ${bot.system}`);
        targetSystemId = bot.system;
        // Clear session if target not found
        if (recoveredSession) {
          failMiningSession(bot.username, "Target resource not found in map");
          recoveredSession = null;
        }
      } else {
        // Use new scoring system that factors in remaining resources, depletion, and distance
        const blacklist = getSystemBlacklist();
        const scoredLocations = mapStore.findBestMiningLocation(effectiveTarget, bot.system, blacklist)
          .filter(loc => locations.some(l => l.poiId === loc.poiId && l.systemId === loc.systemId)) // keep only valid type/non-depleted
          .map(loc => {
            const route = mapStore.findRoute(bot.system, loc.systemId, blacklist);
            const jumps = route ? route.length - 1 : 999;
            return { ...loc, jumps };
          })
          .filter(loc => loc.jumps <= maxJumps);

        if (scoredLocations.length === 0) {
          ctx.log("warn", `No ${effectiveTarget} locations within ${maxJumps} jumps — mining locally instead`);
          targetSystemId = bot.system;
        } else {
          // ── Recovered session upgrade check ──
          // If we have a recovered session, check if the best scored location is
          // significantly better than the session's current POI. If so, abandon
          // the old session and start fresh at the better location.
          if (recoveredSession) {
            const bestLoc = scoredLocations[0];
            const sessionPoiId = recoveredSession.targetPoiId;
            const sessionPoiName = recoveredSession.targetPoiName;

            // Check if best location is different from session's POI
            if (bestLoc.poiId !== sessionPoiId) {
              // Hidden POI always wins over regular POIs for deep core mining
              const bestIsHidden = bestLoc.isHidden;
              const sessionIsHidden = sessionPoiId ? (() => {
                const sys = mapStore.getSystem(recoveredSession.targetSystemId);
                const poi = sys?.pois.find(p => p.id === sessionPoiId);
                return poi?.hidden ?? false;
              })() : false;

              let shouldUpgrade = false;
              let upgradeReason = "";

              if (bestIsHidden && !sessionIsHidden) {
                shouldUpgrade = true;
                upgradeReason = `hidden POI upgrade (${bestLoc.poiName} vs ${sessionPoiName})`;
              } else if (!bestIsHidden && !sessionIsHidden) {
                // Both regular POIs — check if best is significantly better
                // Compare: remaining pool size + richness + score
                const sessionSys = mapStore.getSystem(recoveredSession.targetSystemId);
                const sessionPoi = sessionSys?.pois.find(p => p.id === sessionPoiId);
                const sessionResource = sessionPoi?.resources?.find(r => r.resource_id === effectiveTarget);
                const sessionRemaining = sessionResource?.remaining ?? 0;
                const sessionRichness = sessionResource?.richness ?? 0;

                // Upgrade if new location has 2x+ remaining OR 2x+ richness OR 50+ point score advantage
                if (bestLoc.remaining >= sessionRemaining * 2 && bestLoc.remaining > 1000) {
                  shouldUpgrade = true;
                  upgradeReason = `much larger pool (${bestLoc.remaining.toLocaleString()} vs ${sessionRemaining.toLocaleString()})`;
                } else if (bestLoc.richness >= sessionRichness * 2 && bestLoc.richness > 10) {
                  shouldUpgrade = true;
                  upgradeReason = `much higher richness (${bestLoc.richness} vs ${sessionRichness})`;
                } else if (bestLoc.score - (recoveredSession as any).lastKnownScore > 50) {
                  shouldUpgrade = true;
                  upgradeReason = `significantly better score (${bestLoc.score} vs session)`;
                }
              }

              if (shouldUpgrade) {
                ctx.log("mining", `Upgrading mining location: ${upgradeReason} — abandoning old session`);
                failMiningSession(bot.username, `Location upgrade: ${upgradeReason}`);
                recoveredSession = null;
              } else {
                ctx.log("mining", `Keeping recovered session at ${sessionPoiName} (no significant upgrade available)`);
              }
            }
          }

          // CRITICAL FIX: Always prefer configured harvesting system if set (manual override)
          let chosenLoc: typeof scoredLocations[0] | undefined;
          if (configuredSystem) {
            chosenLoc = scoredLocations.find(loc => loc.systemId === configuredSystem);
            if (chosenLoc) {
              const hiddenTag = chosenLoc.isHidden ? " [HIDDEN POI]" : "";
              const scanInfo = chosenLoc.minutesSinceScan === Infinity ? "(never scanned)" : `(${chosenLoc.remaining.toLocaleString()}/${chosenLoc.maxRemaining.toLocaleString()}, ${chosenLoc.depletionPercent.toFixed(1)}% available, richness: ${chosenLoc.richness})`;
              ctx.log("mining", `Found ${effectiveTarget} in configured harvesting system ${configuredSystem} (${chosenLoc.jumps} jumps)${hiddenTag} ${scanInfo} — manual override active`);
            }
          }
          // If no location in configured system, prefer current system (0 jumps)
          if (!chosenLoc) {
            chosenLoc = scoredLocations.find(loc => loc.systemId === bot.system);
            if (chosenLoc) {
              const hiddenTag = chosenLoc.isHidden ? " [HIDDEN POI]" : "";
              const scanInfo = chosenLoc.minutesSinceScan === Infinity ? "(never scanned)" : `(${chosenLoc.remaining.toLocaleString()}/${chosenLoc.maxRemaining.toLocaleString()}, ${chosenLoc.depletionPercent.toFixed(1)}% available, richness: ${chosenLoc.richness})`;
              ctx.log("mining", `Found ${effectiveTarget} in current system ${bot.system}${hiddenTag} ${scanInfo}`);
            }
          }
          // Pick best scored location (already sorted by composite score)
          if (!chosenLoc) {
            chosenLoc = scoredLocations[0];
            const hiddenTag = chosenLoc.isHidden ? " [HIDDEN POI]" : "";
            const scanInfo = chosenLoc.minutesSinceScan === Infinity ? "(never scanned)" : `(${chosenLoc.remaining.toLocaleString()}/${chosenLoc.maxRemaining.toLocaleString()}, ${chosenLoc.depletionPercent.toFixed(1)}% available, richness: ${chosenLoc.richness}, score: ${chosenLoc.score})`;
            ctx.log("mining", `Selected ${effectiveTarget} at ${chosenLoc.poiName} in ${chosenLoc.systemName} (${chosenLoc.jumps} jumps)${hiddenTag} ${scanInfo}`);
          }

          targetSystemId = chosenLoc.systemId;
          targetPoiId = chosenLoc.poiId;
          targetPoiName = chosenLoc.poiName;

          // Create mining session if we don't have one and we're targeting a specific POI
          if (!recoveredSession && targetPoiId) {
            const sysData = mapStore.getSystem(targetSystemId);
            const session = createMiningSession({
              botUsername: bot.username,
              miningType: miningType,
              targetResourceId: effectiveTarget,
              targetResourceName: effectiveTarget,
              targetSystemId,
              targetSystemName: sysData?.name || targetSystemId,
              targetPoiId,
              targetPoiName,
              homeSystem,
              isQuotaDriven,
              quotaTarget: isQuotaDriven ? (quotas[effectiveTarget] || 0) : undefined,
            });
            startMiningSession(session);
            recoveredSession = session;
            ctx.log("mining", `Started mining session: ${session.targetResourceName} @ ${session.targetPoiName}`);
          }

          // ── Flock leader announces target ──
          if (isFlockLeader && settings.flockEnabled && settings.flockName) {
            const rallySystem = flockGroup?.rallySystem;
            await announceFlockTarget(
              settings.flockName,
              bot.username,
              targetSystemId,
              targetPoiId,
              targetPoiName,
              effectiveTarget,
              miningType,
              rallySystem,
            );
            ctx.log("flock", `Announced target to flock: ${targetPoiName} @ ${targetSystemId} (${miningType})`);
            await updateFlockPhase(settings.flockName, "traveling");
          }
        }
      }
    } else {
      // No specific target - mine in configured harvesting system or locally
      if (configuredSystem && configuredSystem !== bot.system) {
        ctx.log("mining", `No specific target - traveling to configured harvesting system ${configuredSystem}`);
        targetSystemId = configuredSystem;
      } else {
        ctx.log("mining", `No specific ${resourceLabel} target - mining locally in ${bot.system}`);
        targetSystemId = bot.system;
      }
      // Clear any active session since we're mining without a specific target
      if (recoveredSession) {
        completeMiningSession(bot.username);
        recoveredSession = null;
      }
    }

    // ── Navigate to target system if needed ──
    if (targetSystemId && targetSystemId !== bot.system) {
      yield "navigate_to_target";
      if (recoveredSession) {
        updateMiningSession(bot.username, { state: "traveling_to_ore" });
      }

      // Flock followers wait for leader to arrive first (optional synchronization)
      if (!isFlockLeader && settings.flockEnabled && settings.flockName) {
        ctx.log("flock", "Waiting 5s for leader to jump first...");
        await sleep(5000);
      }

      // CRITICAL FIX: If rally system is configured, navigate to it first as a waypoint
      const rallySystem = flockGroup?.rallySystem;
      if (rallySystem && settings.flockEnabled && settings.flockName && rallySystem !== bot.system && rallySystem !== targetSystemId) {
        ctx.log("flock", `Navigating to rally system ${rallySystem} as waypoint before mining target...`);
        const rallyArrived = await navigateToSystem(ctx, rallySystem, safetyOpts);
        if (rallyArrived) {
          ctx.log("flock", `Arrived at rally system ${rallySystem} — proceeding to mining target ${targetSystemId}`);
          // Brief pause to sync with flock members
          await sleep(2000);
        } else {
          ctx.log("error", `Failed to reach rally system ${rallySystem} — proceeding directly to mining target`);
        }
      }

      // Signal escorts before jumping
      const minerSettings = getMinerSettings(bot.username);
      if (minerSettings.escortName) {
        ctx.log("escort", `Signaling escorts to jump to ${targetSystemId}...`);
        await signalEscort(ctx, "jump", targetSystemId, minerSettings.escortSignalChannel);
        await sleep(2000); // Brief pause to let escorts read the signal
      }

      const arrived = await navigateToSystem(ctx, targetSystemId, safetyOpts);
      if (!arrived) {
        ctx.log("error", "Failed to reach target system — mining locally instead");
        targetSystemId = bot.system;
        targetPoiId = "";
        targetPoiName = "";
        
        // CRITICAL FIX: Re-validate deep core equipment after jump timeout failure.
        // Jump timeouts can leave the bot in an inconsistent state where equipment
        // detection may have failed. Re-check and re-apply deep core restrictions.
        if (effectiveTarget && isDeepCoreOre(effectiveTarget)) {
          ctx.log("mining", "Re-validating deep core equipment after jump failure...");
          const deepCoreCapRecheck = await getDeepCoreCapability(ctx);
          if (!deepCoreCapRecheck.canMine) {
            ctx.log("error", "Deep core equipment not detected after jump failure — cannot mine deep core ore");
            ctx.log("error", "  Clearing deep core target to prevent mining wrong ore type");
            effectiveTarget = "";
            if (recoveredSession) {
              ctx.log("mining", "Abandoning recovered session: equipment lost after jump timeout");
              failMiningSession(bot.username, "Deep core equipment lost after jump timeout");
              recoveredSession = null;
            }
          } else {
            ctx.log("mining", "Deep core equipment re-validated after jump failure");
          }
        }
        
        if (recoveredSession) {
          updateMiningSession(bot.username, { state: "mining" });
        }
      } else {
        // MAP UPDATE: Record successful system arrival and update connections
        // Get the fresh system info to update the map with current POI data
        const { pois: newPois, systemId: newSystemId, connections: newConnections } = await getSystemInfo(ctx);
        if (newSystemId && newPois.length > 0) {
          mapStore.updateSystem({
            id: newSystemId,
            pois: newPois.map(p => ({
              id: p.id,
              name: p.name,
              type: p.type,
            })),
            connections: newConnections,
            last_visited: new Date().toISOString(),
          });
          ctx.log("map", `Updated map for ${newSystemId}: ${newPois.length} POIs, ${newConnections?.length || 0} connections`);
        }
        
        if (settings.flockEnabled && settings.flockName) {
          // Update flock phase after successful arrival
          await updateFlockPhase(settings.flockName, "traveling");
        }
      }
    }

    if (bot.state !== "running") break;

    // ── Determine active jettison list (deep core vs regular) ──
    const isDeepCoreMining = effectiveTarget && isDeepCoreOre(effectiveTarget);
    const activeJettisonList = isDeepCoreMining && settings.deepCoreJettisonOres.length > 0
      ? settings.deepCoreJettisonOres
      : settings.jettisonOres;

    // ── Find mining POI and station in current system ──
    yield miningType === "ice" ? "find_ice_field" : (miningType === "ore" ? "find_ore_belt" : "find_gas_cloud");
    const { pois: initialPois, systemId } = await getSystemInfo(ctx);
    if (systemId) bot.system = systemId;

    // CRITICAL MAP UPDATE: Record system visit and update POI data
    // Miners are excellent map data sources since they visit systems frequently
    if (systemId && initialPois.length > 0) {
      mapStore.updateSystem({
        id: systemId,
        pois: initialPois.map(p => ({
          id: p.id,
          name: p.name,
          type: p.type,
        })),
        last_visited: new Date().toISOString(),
      });
      ctx.log("map", `Updated map data for system ${systemId}: ${initialPois.length} POIs recorded`);
    }

    let pois = initialPois;
    let miningPoi: { id: string; name: string } | null = null;
    let stationPoi: { id: string; name: string } | null = null;

    const station = findStation(pois);
    if (station) stationPoi = { id: station.id, name: station.name };

    // If targeting a specific POI, prefer it
    if (targetPoiId) {
      const match = pois.find(p => p.id === targetPoiId);
      if (match) {
        miningPoi = { id: match.id, name: match.name };
      }
    }

    // Fallback: find POI with target resource (skip depleted unless expired)
    if (!miningPoi && effectiveTarget) {
      for (const poi of pois) {
        const isMatchingType =
          (miningType === "ice" && isIceFieldPoi(poi.type)) ||
          (miningType === "ore" && (isOreBeltPoi(poi.type) || poi.hidden === true)) ||
          (miningType === "gas" && isGasCloudPoi(poi.type));

        if (!isMatchingType) continue;

        // Check stored depletion status - skip if depleted and not expired
        const sysData = mapStore.getSystem(bot.system);
        const storedPoi = sysData?.pois.find(p => p.id === poi.id);
        const oreEntry = storedPoi?.ores_found.find(o => o.item_id === effectiveTarget);

        if (oreEntry && oreEntry.depleted && !isDepletionExpired(oreEntry.depleted_at, depletionTimeoutMs)) {
          if (settings.ignoreDepletion) {
            ctx.log("mining", `Mining depleted ${effectiveTarget} at ${poi.name} (ignoreDepletion enabled)`);
          } else {
            ctx.log("mining", `Skipping ${poi.name}: ${effectiveTarget} is depleted (waiting for timeout)`);
            continue;
          }
        }

        // Found a viable POI (not marked depleted in cache)
        miningPoi = { id: poi.id, name: poi.name };
        break;
      }
    }

    // Fallback: any matching POI type
    if (!miningPoi) {
      // CRITICAL FIX: For deep core miners, don't fall back to mining regular ores
      // if the deep core target isn't available in the current system.
      if (effectiveTarget && isDeepCoreOre(effectiveTarget)) {
        ctx.log("mining", `Deep core miner: ${effectiveTarget} not found in current system — waiting for next cycle to retry target`);
        await sleep(30000);
        continue;
      }
      
      if (miningType === "ice") {
        const iceField = pois.find(p => isIceFieldPoi(p.type));
        if (iceField) miningPoi = { id: iceField.id, name: iceField.name };
      } else if (miningType === "ore") {
        const oreBelt = pois.find(p => isOreBeltPoi(p.type) || p.hidden === true);
        if (oreBelt) miningPoi = { id: oreBelt.id, name: oreBelt.name };
      } else if (miningType === "gas") {
        const gasCloud = pois.find(p => isGasCloudPoi(p.type));
        if (gasCloud) miningPoi = { id: gasCloud.id, name: gasCloud.name };
      }
    }

    if (!miningPoi) {
      ctx.log("error", `No ${resourceLabel} field/cloud found in this system — waiting 30s before retry`);
      await sleep(30000);
      continue;
    }

    // ── Pre-travel get_poi scan: verify resources before committing to travel ──
    yield "scan_poi_before_travel";
    const preScanResp = await bot.exec("get_poi", { poi_id: miningPoi.id });
    if (!preScanResp.error && preScanResp.result) {
      const scanResult = preScanResp.result as Record<string, unknown>;
      const poiData = scanResult?.poi as Record<string, unknown> | undefined;
      const scanResources = (
        Array.isArray(scanResult?.resources) ? scanResult.resources :
        Array.isArray(poiData?.resources) ? poiData.resources :
        []
      ) as Array<Record<string, unknown>>;

      if (scanResources.length > 0) {
        // Update map store with fresh scan data
        const resourceData = scanResources.map((r) => ({
          resource_id: (r.resource_id as string) || "",
          name: (r.name as string) || (r.resource_id as string) || "",
          richness: (r.richness as number) || 0,
          remaining: (r.remaining as number) || 0,
          max_remaining: (r.max_remaining as number) || 0,
          depletion_percent: (r.depletion_percent as number) || 100,
        }));

        // Register/update the POI with full data (captures hidden POIs)
        if (poiData) {
          mapStore.registerPoiFromScan(bot.system, {
            id: (poiData.id as string) || miningPoi.id,
            name: (poiData.name as string) || miningPoi.name,
            type: (poiData.type as string) || "",
            hidden: poiData.hidden as boolean | undefined,
            reveal_difficulty: poiData.reveal_difficulty as number | undefined,
            resources: resourceData,
          });
        } else {
          mapStore.updatePoiResources(bot.system, miningPoi.id, resourceData);
        }

        // Check if target resource is still available
        if (effectiveTarget) {
          const targetResource = scanResources.find(r => (r.resource_id as string) === effectiveTarget);
          const remaining = (targetResource?.remaining as number) ?? 0;
          if (remaining <= 0) {
            ctx.log("mining", `Pre-scan: ${effectiveTarget} depleted at ${miningPoi.name} — marking depleted and searching for alternative`);
            mapStore.markOreDepleted(bot.system, miningPoi.id, effectiveTarget);
            // Don't travel here — fall through to depletion handling below
            miningPoi = null;
          } else {
            ctx.log("mining", `Pre-scan: ${effectiveTarget} has ${remaining.toLocaleString()} units remaining at ${miningPoi.name}`);
          }
        }
      }
    }

    if (!miningPoi) {
      // POI was depleted — search for alternative in current system first
      ctx.log("mining", "Target POI depleted — searching for alternative in current system...");
      const altPoi = pois.find(p => {
        if (miningType === "ore") return isOreBeltPoi(p.type) || p.hidden === true;
        if (miningType === "gas") return isGasCloudPoi(p.type);
        if (miningType === "ice") return isIceFieldPoi(p.type);
        return false;
      });
      if (altPoi) {
        miningPoi = { id: altPoi.id, name: altPoi.name };
        ctx.log("mining", `Found alternative: ${altPoi.name}`);
      } else {
        // No alternative in current system — search broader map for non-depleted locations
        ctx.log("mining", "No alternative in current system — searching map for non-depleted locations...");
        const broaderLocations = mapStore.findOreLocations(effectiveTarget).filter(loc => {
          const sys = mapStore.getSystem(loc.systemId);
          const poi = sys?.pois.find(p => p.id === loc.poiId);
          if (miningType === "ore") return isOreBeltPoi(poi?.type || "");
          if (miningType === "gas") return isGasCloudPoi(poi?.type || "");
          if (miningType === "ice") return isIceFieldPoi(poi?.type || "");
          return true;
        }).filter(loc => {
          // Skip completely exhausted POIs
          if (loc.remaining !== undefined && loc.remaining <= 0 && loc.maxRemaining !== undefined && loc.maxRemaining > 0) {
            return false;
          }
          if (settings.ignoreDepletion) return true;
          const sys = mapStore.getSystem(loc.systemId);
          const poi = sys?.pois.find(p => p.id === loc.poiId);
          const oreEntry = poi?.ores_found.find(o => o.item_id === effectiveTarget);
          if (!oreEntry?.depleted) return true;
          return isDepletionExpired(oreEntry.depleted_at, depletionTimeoutMs);
        });

        if (broaderLocations.length > 0) {
          // Prefer configured system, then closest by jumps
          const blacklist = getSystemBlacklist();
          const scored = broaderLocations
            .map(loc => {
              const route = mapStore.findRoute(bot.system, loc.systemId, blacklist);
              return { ...loc, jumps: route ? route.length - 1 : 999 };
            })
            .filter(loc => loc.jumps <= maxJumps)
            .sort((a, b) => {
              if (configuredSystem && a.systemId === configuredSystem && b.systemId !== configuredSystem) return -1;
              if (configuredSystem && b.systemId === configuredSystem && a.systemId !== configuredSystem) return -1;
              if (a.systemId === bot.system && b.systemId !== bot.system) return -1;
              if (b.systemId === bot.system && a.systemId !== bot.system) return 1;
              return a.jumps - b.jumps;
            });

          if (scored.length > 0) {
            const chosen = scored[0];
            ctx.log("mining", `Found ${effectiveTarget} at ${chosen.poiName} in ${chosen.systemName} (${chosen.jumps} jumps) — navigating there`);
            const arrived = await navigateToSystem(ctx, chosen.systemId, safetyOpts);
            if (arrived) {
              // Refresh pois list for new system and retry travel
              const { pois: newPois } = await getSystemInfo(ctx);
              pois = newPois;
              bot.system = chosen.systemId;
              const newMiningPoi = pois.find(p => {
                if (miningType === "ore") return isOreBeltPoi(p.type) || p.hidden === true;
                if (miningType === "gas") return isGasCloudPoi(p.type);
                if (miningType === "ice") return isIceFieldPoi(p.type);
                return false;
              });
              if (newMiningPoi) {
                miningPoi = { id: newMiningPoi.id, name: newMiningPoi.name };
                ctx.log("mining", `Will travel to ${newMiningPoi.name}`);
              } else {
                ctx.log("error", `No suitable ${resourceLabel} POI found in ${chosen.systemName} — returning home to retry next cycle`);
                await ensureUndocked(ctx);
                const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
                if (fueled) await navigateToSystem(ctx, homeSystem, safetyOpts);
                await ensureDocked(ctx);
                await dumpCargo(ctx, settings);
                continue;
              }
            } else {
              ctx.log("error", "Failed to reach alternative system — returning home to retry next cycle");
              await ensureUndocked(ctx);
              const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
              if (fueled) await navigateToSystem(ctx, homeSystem, safetyOpts);
              await ensureDocked(ctx);
              await dumpCargo(ctx, settings);
              continue;
            }
          } else {
            ctx.log("error", `No alternative ${resourceLabel} within ${maxJumps} jumps — returning home to retry next cycle`);
            await ensureUndocked(ctx);
            const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
            if (fueled) await navigateToSystem(ctx, homeSystem, safetyOpts);
            await ensureDocked(ctx);
            await dumpCargo(ctx, settings);
            continue;
          }
        } else {
          ctx.log("error", `No alternative ${resourceLabel} found anywhere — returning home to retry next cycle`);
          await ensureUndocked(ctx);
          const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
          if (fueled) await navigateToSystem(ctx, homeSystem, safetyOpts);
          await ensureDocked(ctx);
          await dumpCargo(ctx, settings);
          continue;
        }
      }
    }

    // ── Travel to mining location ──
    yield miningType === "ice" ? "travel_to_ice_field" : (miningType === "ore" ? "travel_to_belt" : "travel_to_cloud");
    const travelResp = await bot.exec("travel", { target_poi: miningPoi.id });
    
    // Check for battle notifications during travel
    if (travelResp.notifications && Array.isArray(travelResp.notifications)) {
      const battleDetected = await handleBattleNotifications(ctx, travelResp.notifications, battleState);
      if (battleDetected) {
        ctx.log("error", "Battle detected during travel - fleeing!");
        await sleep(5000);
        continue;
      }
    }
    
    if (travelResp.error && !travelResp.error.message.includes("already")) {
      ctx.log("error", `Travel failed: ${travelResp.error.message}`);
      await sleep(5000);
      continue;
    }
    bot.poi = miningPoi.id;

    // Check for pirates at mining location
    const nearbyResp = await bot.exec("get_nearby");

    // Check for battle notifications in get_nearby response
    if (nearbyResp.notifications && Array.isArray(nearbyResp.notifications)) {
      const battleDetected = await handleBattleNotifications(ctx, nearbyResp.notifications, battleState);
      if (battleDetected) {
        ctx.log("error", "Battle detected at mining location - fleeing!");
        await sleep(30000);
        continue;
      }
    }

    // Also check battle status directly (in case we missed notifications)
    const directBattleStatus = await getBattleStatus(ctx);
    if (directBattleStatus && directBattleStatus.is_participant) {
      ctx.log("combat", `Direct battle status check: IN BATTLE (ID: ${directBattleStatus.battle_id}) - fleeing!`);
      await fleeFromBattle(ctx, true, 35000);
      ctx.log("error", "Battle detected via status check - fled, will retry mining");
      await sleep(30000);
      continue;
    }

    if (nearbyResp.result && typeof nearbyResp.result === "object") {
      const { checkAndFleeFromPirates } = await import("./common.js");
      const fled = await checkAndFleeFromPirates(ctx, nearbyResp.result);
      if (fled) {
        ctx.log("error", "Pirates detected - fled mining location, will retry");
        await sleep(30000);
        continue;
      }
    }

    // Update session state to mining
    if (recoveredSession) {
      updateMiningSession(bot.username, {
        state: "mining",
        targetPoiId: miningPoi.id,
        targetPoiName: miningPoi.name,
      });
    }

    // Update flock phase to mining
    if (settings.flockEnabled && settings.flockName && miningPoi) {
      await updateFlockPhase(settings.flockName, "mining");
      ctx.log("flock", "Flock phase updated: mining");
    }

    // ── Scavenge wrecks before harvesting ──
    yield "scavenge";
    await scavengeWrecks(ctx);

    // ── Harvest loop: mine until cargo threshold ──
    yield "harvest_loop";
    let harvestCycles = 0;
    let stopReason = "";
    const resourcesMinedMap = new Map<string, number>();
    let lastPoiCheck = 0;
    let lastBattleCheck = 0;
    const POI_CHECK_INTERVAL_MS = 60_000; // Check POI remaining every 60 seconds
    const BATTLE_CHECK_INTERVAL_MS = 8_000; // Check battle status every 8 seconds (< 1 game tick)

    while (bot.state === "running") {
      await bot.refreshStatus();

      const midHull = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
      if (midHull <= 40) { stopReason = `hull critical (${midHull}%)`; break; }

      const midFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
      if (midFuel < safetyOpts.fuelThresholdPct) { stopReason = `fuel low (${midFuel}%)`; break; }

      // Periodic battle status check (backup detection in case notifications fail)
      const now = Date.now();
      if ((now - lastBattleCheck) > BATTLE_CHECK_INTERVAL_MS) {
        lastBattleCheck = now;
        const battleStatusCheck = await getBattleStatus(ctx);
        if (battleStatusCheck && battleStatusCheck.is_participant) {
          ctx.log("combat", `PERIODIC CHECK: IN BATTLE! Battle ID: ${battleStatusCheck.battle_id} - fleeing!`);
          battleState.inBattle = true;
          battleState.battleId = battleStatusCheck.battle_id;
          await fleeFromBattle(ctx, true, 35000);
          stopReason = "battle detected (status check)";
          break;
        }
      }

      // If we're in battle, re-issue flee command every cycle to ensure we stay in flee stance
      if (battleState.inBattle) {
        ctx.log("combat", "Re-issuing flee stance (ensuring we stay in flee mode)...");
        const fleeResp = await bot.exec("battle", { action: "stance", stance: "flee" });
        if (fleeResp.error) {
          ctx.log("error", `Flee re-issue failed: ${fleeResp.error.message}`);
        }
        // Check if we've successfully disengaged
        const currentBattleStatus = await getBattleStatus(ctx);
        if (!currentBattleStatus || !currentBattleStatus.is_participant) {
          ctx.log("combat", "Battle cleared - no longer in combat!");
          battleState.inBattle = false;
          battleState.battleId = null;
          battleState.isFleeing = false;
          stopReason = "battle escaped successfully";
          break;
        }
        // Still in battle - continue to next cycle to re-flee again
        await sleep(2000); // Brief pause before next flee attempt
        continue;
      }

      // Periodically check POI to see if resource is depleted (remaining: 0)
      if (effectiveTarget && bot.poi && !settings.ignoreDepletion &&
          (now - lastPoiCheck) > POI_CHECK_INTERVAL_MS) {
        lastPoiCheck = now;
        const poiResp = await bot.exec("get_poi", { poi_id: bot.poi });
        if (!poiResp.error && poiResp.result) {
          const result = poiResp.result as Record<string, unknown>;
          const poiData = result?.poi as Record<string, unknown> | undefined;
          const resources = Array.isArray(result.resources)
            ? (result.resources as Array<Record<string, unknown>>)
            : Array.isArray(poiData?.resources)
            ? (poiData.resources as Array<Record<string, unknown>>)
            : [];

          // Register/update the POI with full data (captures hidden POIs)
          if (poiData && resources.length > 0) {
            const resourceData = resources.map((r) => ({
              resource_id: (r.resource_id as string) || (r.id as string) || "",
              name: (r.name as string) || (r.resource_id as string) || "",
              richness: (r.richness as number) || 0,
              remaining: (r.remaining as number) ?? (r.quantity as number) ?? 0,
              max_remaining: (r.max_remaining as number) || 0,
              depletion_percent: (r.depletion_percent as number) || 100,
            }));

            mapStore.registerPoiFromScan(bot.system, {
              id: (poiData.id as string) || bot.poi,
              name: (poiData.name as string) || "",
              type: (poiData.type as string) || "",
              hidden: poiData.hidden as boolean | undefined,
              reveal_difficulty: poiData.reveal_difficulty as number | undefined,
              resources: resourceData,
            });
          }

          for (const res of resources) {
            const resId = (res.resource_id as string) || (res.id as string) || "";
            if (resId === effectiveTarget) {
              const remaining = (res.remaining as number) ?? (res.quantity as number) ?? null;
              if (remaining !== null && remaining <= 0) {
                ctx.log("mining", `POI check: ${effectiveTarget} is depleted (remaining: ${remaining})`);
                mapStore.markOreDepleted(bot.system, bot.poi, effectiveTarget);
                
                // If stayOutUntilFull is enabled and cargo is not full, search for new POI
                if (settings.stayOutUntilFull) {
                  const fillRatio = bot.cargoMax > 0 ? bot.cargo / bot.cargoMax : 0;
                  if (fillRatio < cargoThresholdRatio) {
                    ctx.log("mining", "stayOutUntilFull enabled and cargo not full — searching for next POI...");
                    // Search for next available POI with same target
                    const newLocs = mapStore.findOreLocations(effectiveTarget).filter(loc => {
                      if (loc.poiId === bot.poi && loc.systemId === bot.system) return false; // Skip current POI
                      const sys = mapStore.getSystem(loc.systemId);
                      const poi = sys?.pois.find(p => p.id === loc.poiId);
                      if (miningType === "ore") return isOreBeltPoi(poi?.type || "");
                      if (miningType === "gas") return isGasCloudPoi(poi?.type || "");
                      if (miningType === "ice") return isIceFieldPoi(poi?.type || "");
                      return true;
                    }).filter(loc => {
                      const sys = mapStore.getSystem(loc.systemId);
                      const poi = sys?.pois.find(p => p.id === loc.poiId);
                      const oreEntry = poi?.ores_found.find(o => o.item_id === effectiveTarget);
                      if (!oreEntry?.depleted) return true;
                      // Even with ignoreDepletion, skip completely exhausted POIs
                      if (settings.ignoreDepletion) {
                        if (loc.remaining !== undefined && loc.remaining <= 0 && loc.maxRemaining !== undefined && loc.maxRemaining > 0) {
                          return false;
                        }
                        return true;
                      }
                      return isDepletionExpired(oreEntry.depleted_at, depletionTimeoutMs);
                    });

                    if (newLocs.length > 0) {
                      const blacklist = getSystemBlacklist();
                      const locsWithDist = newLocs
                        .map(loc => {
                          const route = mapStore.findRoute(bot.system, loc.systemId, blacklist);
                          return { ...loc, jumps: route ? route.length - 1 : 999 };
                        })
                        .filter(loc => loc.jumps <= maxJumps)
                        .sort((a, b) => {
                          if (a.systemId === bot.system && b.systemId !== bot.system) return -1;
                          if (b.systemId === bot.system && a.systemId !== bot.system) return 1;
                          return a.jumps - b.jumps;
                        });

                      if (locsWithDist.length > 0) {
                        const chosen = locsWithDist[0];
                        ctx.log("mining", `Found next target: ${effectiveTarget} @ ${chosen.poiName} in ${chosen.systemId} (${chosen.jumps} jumps)`);
                        
                        // Travel to new system if needed
                        if (chosen.systemId !== bot.system) {
                          const arrived = await navigateToSystem(ctx, chosen.systemId, safetyOpts);
                          if (arrived) {
                            const { pois: newPois } = await getSystemInfo(ctx);
                            pois = newPois;
                            bot.system = chosen.systemId;
                          } else {
                            ctx.log("error", "Failed to reach new system");
                          }
                        }
                        
                        // Travel to new POI
                        const travelResp = await bot.exec("travel", { target_poi: chosen.poiId });
                        
                        // Check for battle notifications
                        if (travelResp.notifications && Array.isArray(travelResp.notifications)) {
                          const battleDetected = await handleBattleNotifications(ctx, travelResp.notifications, battleState);
                          if (battleDetected) {
                            ctx.log("combat", "Battle detected while changing POI - initiating flee!");
                            // Don't break - let the flee handling in main loop re-issue every cycle
                            battleState.isFleeing = false;
                          }
                        }
                        
                        if (!travelResp.error || travelResp.error.message.includes("already")) {
                          bot.poi = chosen.poiId;
                          miningPoi = { id: chosen.poiId, name: chosen.poiName };
                          ctx.log("mining", `Continuing at new POI: ${chosen.poiName}`);
                          lastPoiCheck = 0; // Reset POI check timer
                          continue; // Continue mining
                        }
                      }
                    }
                    ctx.log("mining", "No alternative POI found within range");
                  }
                }
                
                stopReason = `${effectiveTarget} depleted at this POI`;
                if (recoveredSession) {
                  failMiningSession(bot.username, "Resource depleted");
                  recoveredSession = null;
                }
                break;
              } else if (remaining !== null) {
                ctx.log("mining", `POI check: ${effectiveTarget} remaining: ${remaining}`);
              }
            }
          }
        }
        if (stopReason) break;
      }

      // JETTISON: Clear jettison-listed ores from cargo before mining
      if (activeJettisonList.length > 0) {
        await bot.refreshCargo();
        for (const jettisonOreId of activeJettisonList) {
          const cargoItem = bot.inventory.find(i => i.itemId === jettisonOreId);
          if (cargoItem && cargoItem.quantity > 0) {
            const jettisonResp = await bot.exec("jettison", { item_id: jettisonOreId, quantity: cargoItem.quantity });
            if (!jettisonResp.error) {
              const dcTag = isDeepCoreMining ? " [deep core]" : "";
              ctx.log("mining", `Jettisoned ${cargoItem.quantity}x ${cargoItem.name || jettisonOreId} (pre-mine cargo cleanup${dcTag})`);
              await bot.refreshCargo();
            }
          }
        }
      }

      // Pre-mine battle check - prevents mine command from freezing if battle starts
      const preMineBattleCheck = await getBattleStatus(ctx);
      if (preMineBattleCheck && preMineBattleCheck.is_participant) {
        ctx.log("combat", `PRE-MINE CHECK: IN BATTLE! Battle ID: ${preMineBattleCheck.battle_id} - initiating flee!`);
        battleState.inBattle = true;
        battleState.battleId = preMineBattleCheck.battle_id;
        battleState.isFleeing = false;
        // Don't break - let the flee handling below re-issue flee every cycle
        await fleeFromBattle(ctx, false, 5000); // Initial flee, don't wait for disengage
      }

      const mineResp = await bot.exec("mine");

      // Check for battle notifications after mining
      if (mineResp.notifications && Array.isArray(mineResp.notifications)) {
        const battleDetected = await handleBattleNotifications(ctx, mineResp.notifications, battleState);
        if (battleDetected) {
          ctx.log("combat", "Battle detected while mining - initiating flee (will re-issue every cycle)!");
          // Don't break - let the flee handling below re-issue flee every cycle
          battleState.isFleeing = false; // Reset so the loop will re-issue
        }
      }

      if (mineResp.error) {
        const msg = mineResp.error.message.toLowerCase();
        if (msg.includes("depleted") || msg.includes("no resources") || msg.includes("no gas") || msg.includes("no ice") || msg.includes("no minable")) {
          // Mark this ore as depleted in the map (unless ignoreDepletion is enabled)
          if (effectiveTarget && bot.poi && !settings.ignoreDepletion) {
            mapStore.markOreDepleted(bot.system, bot.poi, effectiveTarget);
            ctx.log("mining", `Marked ${effectiveTarget} at ${bot.poi} as depleted`);
          }
          // Re-pick a new target from quotas, or find any nearby ore if no quotas remain
          ctx.log("mining", `${resourceLabel} field depleted — searching for new target...`);

          // CRITICAL FIX: Check global/configured target FIRST before falling back to quotas
          // This ensures energy_crystal (or any global target) doesn't get ignored when depleted
          // DEEP CORE FIX: If this is a deep core miner, only accept deep core ore targets
          let newTarget: string | null = null;
          let newPoiId: string | null = null;
          let newPoiName: string | null = null;
          let newSystemId: string | null = null;

          // For deep core miners, check if we should search for deep core ores instead
          const currentDeepCoreCap = await getDeepCoreCapability(ctx);
          const isDeepCoreMiner = currentDeepCoreCap.canMine;
          let searchTarget = targetResource;
          
          if (isDeepCoreMiner && (!searchTarget || !isDeepCoreOre(searchTarget))) {
            ctx.log("mining", "Deep core miner — searching for deep core ore target after depletion...");
            // Search for any available deep core ore
            for (const deepCoreOre of DEEP_CORE_ORES) {
              const deepCoreLocs = mapStore.findOreLocations(deepCoreOre).filter(loc => {
                const sys = mapStore.getSystem(loc.systemId);
                const poi = sys?.pois.find(p => p.id === loc.poiId);
                return isOreBeltPoi(poi?.type || "") || poi?.hidden === true;
              }).filter(loc => {
                if (settings.ignoreDepletion) {
                  if (loc.remaining !== undefined && loc.remaining <= 0 && loc.maxRemaining !== undefined && loc.maxRemaining > 0) {
                    return false;
                  }
                  return true;
                }
                const sys = mapStore.getSystem(loc.systemId);
                const poi = sys?.pois.find(p => p.id === loc.poiId);
                const oreEntry = poi?.ores_found.find(o => o.item_id === deepCoreOre);
                if (!oreEntry?.depleted) return true;
                return isDepletionExpired(oreEntry.depleted_at, depletionTimeoutMs);
              });

              if (deepCoreLocs.length > 0) {
                const blacklist = getSystemBlacklist();
                const locsWithDist = deepCoreLocs
                  .map(loc => {
                    const route = mapStore.findRoute(bot.system, loc.systemId, blacklist);
                    return { ...loc, jumps: route ? route.length - 1 : 999 };
                  })
                  .filter(loc => loc.jumps <= maxJumps)
                  .sort((a, b) => {
                    if (a.systemId === bot.system && b.systemId !== bot.system) return -1;
                    if (b.systemId === bot.system && a.systemId !== bot.system) return 1;
                    return a.jumps - b.jumps;
                  });

                if (locsWithDist.length > 0) {
                  const chosen = locsWithDist[0];
                  newTarget = deepCoreOre;
                  newPoiId = chosen.poiId;
                  newPoiName = chosen.poiName;
                  newSystemId = chosen.systemId;
                  const hiddenTag = chosen.isHidden ? " [HIDDEN POI]" : "";
                  ctx.log("mining", `Found deep core target: ${deepCoreOre} @ ${chosen.poiName} (${chosen.jumps} jumps)${hiddenTag}`);
                  break;
                }
              }
            }

            if (!newTarget) {
              ctx.log("mining", "No deep core ores available — waiting for next cycle to retry");
              stopReason = "no deep core ores available";
              break;
            }
          } else if (searchTarget) {
            ctx.log("mining", `Checking for configured global target ${resourceLabel}: ${searchTarget}...`);
            const globalTargetLocs = mapStore.findOreLocations(searchTarget).filter(loc => {
              const sys = mapStore.getSystem(loc.systemId);
              const poi = sys?.pois.find(p => p.id === loc.poiId);
              if (miningType === "ore") return isOreBeltPoi(poi?.type || "");
              if (miningType === "gas") return isGasCloudPoi(poi?.type || "");
              if (miningType === "ice") return isIceFieldPoi(poi?.type || "");
              return true;
            }).filter(loc => {
              if (settings.ignoreDepletion) {
                if (loc.remaining !== undefined && loc.remaining <= 0 && loc.maxRemaining !== undefined && loc.maxRemaining > 0) {
                  return false;
                }
                return true;
              }
              const sys = mapStore.getSystem(loc.systemId);
              const poi = sys?.pois.find(p => p.id === loc.poiId);
              const oreEntry = poi?.ores_found.find(o => o.item_id === targetResource);
              if (!oreEntry?.depleted) return true;
              return isDepletionExpired(oreEntry.depleted_at, depletionTimeoutMs);
            });

            if (globalTargetLocs.length > 0) {
              const blacklist = getSystemBlacklist();
              const locsWithDist = globalTargetLocs
                .map(loc => {
                  const route = mapStore.findRoute(bot.system, loc.systemId, blacklist);
                  return { ...loc, jumps: route ? route.length - 1 : 999 };
                })
                .filter(loc => loc.jumps <= maxJumps)
                .sort((a, b) => {
                  if (a.systemId === bot.system && b.systemId !== bot.system) return -1;
                  if (b.systemId === bot.system && a.systemId !== bot.system) return 1;
                  return a.jumps - b.jumps;
                });

              if (locsWithDist.length > 0) {
                const chosen = locsWithDist[0];
                newTarget = targetResource;
                newPoiId = chosen.poiId;
                newPoiName = chosen.poiName;
                newSystemId = chosen.systemId;
                ctx.log("mining", `Found global target ${resourceLabel}: ${targetResource} @ ${chosen.poiName} (${chosen.jumps} jumps${chosen.systemId !== bot.system ? ` in ${chosen.systemId}` : ''})`);
              }
            }
          }

          // If no global target available, try quotas
          if (!newTarget) {
            ctx.log("mining", `Global target not available — checking quotas...`);
            await bot.refreshFactionStorage();
            const newQuotaTarget = pickTargetFromQuotas(quotas, bot.factionStorage, miningType);

            if (newQuotaTarget) {
              // Find locations for the new quota target
              const newLocs = mapStore.findOreLocations(newQuotaTarget).filter(loc => {
                const sys = mapStore.getSystem(loc.systemId);
                const poi = sys?.pois.find(p => p.id === loc.poiId);
                if (miningType === "ore") return isOreBeltPoi(poi?.type || "");
                if (miningType === "gas") return isGasCloudPoi(poi?.type || "");
                if (miningType === "ice") return isIceFieldPoi(poi?.type || "");
                return true;
              }).filter(loc => {
                if (settings.ignoreDepletion) {
                  // Even with ignoreDepletion, skip completely exhausted POIs
                  if (loc.remaining !== undefined && loc.remaining <= 0 && loc.maxRemaining !== undefined && loc.maxRemaining > 0) {
                    return false;
                  }
                  return true;
                }
                const sys = mapStore.getSystem(loc.systemId);
                const poi = sys?.pois.find(p => p.id === loc.poiId);
                const oreEntry = poi?.ores_found.find(o => o.item_id === newQuotaTarget);
                if (!oreEntry?.depleted) return true;
                return isDepletionExpired(oreEntry.depleted_at, depletionTimeoutMs);
              });

              if (newLocs.length > 0) {
                newTarget = newQuotaTarget;
                // Prefer current system, then closest by jumps (use blacklist)
                const blacklist = getSystemBlacklist();
                const locsWithDist = newLocs
                .map(loc => {
                  const route = mapStore.findRoute(bot.system, loc.systemId, blacklist);
                  return { ...loc, jumps: route ? route.length - 1 : 999 };
                })
                .filter(loc => loc.jumps <= maxJumps)
                .sort((a, b) => {
                  if (a.systemId === bot.system && b.systemId !== bot.system) return -1;
                  if (b.systemId === bot.system && a.systemId !== bot.system) return 1;
                  return a.jumps - b.jumps;
                });

              if (locsWithDist.length > 0) {
                const chosen = locsWithDist[0];
                newPoiId = chosen.poiId;
                newPoiName = chosen.poiName;
                newSystemId = chosen.systemId;
                ctx.log("mining", `Quota pick: ${newQuotaTarget} @ ${chosen.poiName} (${chosen.jumps} jumps${chosen.systemId !== bot.system ? ` in ${chosen.systemId}` : ''})`);
              }
              }
            }
          }

          // If still no target found and we're set for "any", find any nearby ore
          // DEEP CORE FIX: Don't fall back to regular ores for deep core miners
          if (!newTarget && !targetResource) {
            // For deep core miners, don't fall back to regular ores
            if (isDeepCoreMiner) {
              ctx.log("mining", "Deep core miner — no target found, will wait for next cycle");
              stopReason = "no deep core target available";
              break;
            }
            
            // First try current system
            const allPois = miningType === "ice" ? pois.filter(p => isIceFieldPoi(p.type)) :
                           miningType === "ore" ? pois.filter(p => isOreBeltPoi(p.type) || p.hidden === true) :
                           pois.filter(p => isGasCloudPoi(p.type));

            for (const poi of allPois) {
              const sysData = mapStore.getSystem(bot.system);
              const storedPoi = sysData?.pois.find(p => p.id === poi.id);
              const availableOres = storedPoi?.ores_found.filter(o => {
                if (miningType === "ice" && !o.item_id.toLowerCase().includes("ice")) return false;
                if (miningType === "gas" && !o.item_id.toLowerCase().includes("gas")) return false;
                if (miningType === "ore" && (o.item_id.toLowerCase().includes("gas") || o.item_id.toLowerCase().includes("ice"))) return false;
                if (!o.depleted) return true;
                return isDepletionExpired(o.depleted_at, depletionTimeoutMs);
              }) || [];

              if (availableOres.length > 0) {
                newTarget = availableOres[0].item_id;
                newPoiId = poi.id;
                newPoiName = poi.name;
                newSystemId = bot.system;
                ctx.log("mining", `Found ${newTarget} @ ${poi.name} (no quota, mining any)`);
                break;
              }
            }

            // If stayOutUntilFull is enabled and cargo is not full, search other systems using resource scan data
            if (!newTarget && settings.stayOutUntilFull) {
              const fillRatio = bot.cargoMax > 0 ? bot.cargo / bot.cargoMax : 0;
              if (fillRatio < cargoThresholdRatio) {
                ctx.log("mining", "stayOutUntilFull enabled and cargo not full — searching other systems using resource scan data...");
                // Use the new scoring system to find best available location
                const blacklist = getSystemBlacklist();
                const bestLocations = mapStore.findBestMiningLocation(effectiveTarget || (miningType === "ore" ? "iron_ore" : miningType === "gas" ? "argon_gas" : "water_ice"), bot.system, blacklist);

                for (const loc of bestLocations) {
                  if (loc.systemId === bot.system) continue; // Skip current system
                  if (loc.jumpsAway > maxJumps) continue; // Too far
                  if (loc.poiId === miningPoi?.id) continue; // Skip current POI

                  // Check if this POI has available resources
                  const sys = mapStore.getSystem(loc.systemId);
                  const poi = sys?.pois.find(p => p.id === loc.poiId);
                  if (!poi) continue;

                  // Verify POI type matches
                  if (miningType === "ore" && !isOreBeltPoi(poi.type) && !poi.hidden) continue;
                  if (miningType === "gas" && !isGasCloudPoi(poi.type)) continue;
                  if (miningType === "ice" && !isIceFieldPoi(poi.type)) continue;

                  // Check if not depleted (or expired)
                  const oreEntry = poi.ores_found.find(o => o.item_id === loc.resourceId || o.item_id === effectiveTarget);
                  if (oreEntry?.depleted) {
                    // Skip completely exhausted POIs regardless of settings
                    if (loc.remaining <= 0 && loc.maxRemaining > 0) continue;
                    if (!isDepletionExpired(oreEntry.depleted_at, depletionTimeoutMs)) continue;
                  }

                  // Found a good target
                  const hiddenTag = loc.isHidden ? " [HIDDEN POI]" : "";
                  const scanInfo = loc.minutesSinceScan === Infinity ? "(never scanned)" : `(${loc.remaining.toLocaleString()}/${loc.maxRemaining.toLocaleString()}, ${loc.depletionPercent.toFixed(1)}% available, richness: ${loc.richness}, score: ${loc.score})`;
                  newTarget = effectiveTarget || oreEntry?.item_id || loc.resourceId;
                  newPoiId = loc.poiId;
                  newPoiName = loc.poiName;
                  newSystemId = loc.systemId;
                  ctx.log("mining", `Found ${newTarget} @ ${loc.poiName} in ${loc.systemName} (${loc.jumpsAway} jumps)${hiddenTag} ${scanInfo} - stayOutUntilFull`);
                  break;
                }
              }
            }
          }

          if (newTarget && newPoiId && newPoiName) {
            // Update target and continue mining
            const oldTarget = effectiveTarget;
            const oldPoi = miningPoi;
            
            // CRITICAL: Update effectiveTarget to the new target
            effectiveTarget = newTarget;

            // Update session if active
            if (recoveredSession) {
              updateMiningSession(bot.username, {
                targetResourceId: newTarget,
                targetResourceName: newTarget,
                targetPoiId: newPoiId,
                targetPoiName: newPoiName,
              });
            }

            // Travel to new POI (may be in different system)
            if (newSystemId && newSystemId !== bot.system) {
              // Need to jump to new system first
              ctx.log("mining", `Traveling to ${newTarget} in ${newSystemId} (${newPoiName}) - stayOutUntilFull`);
              const arrived = await navigateToSystem(ctx, newSystemId, safetyOpts);
              if (!arrived) {
                ctx.log("error", "Failed to reach new system — returning home");
                stopReason = `${resourceLabel} field depleted (travel failed)`;
                break;
              }
              // Update pois list for new system
              const { pois: newPois } = await getSystemInfo(ctx);
              pois = newPois;
              bot.system = newSystemId;
            }

            if (newPoiId !== bot.poi) {
              ctx.log("mining", `Traveling to new target: ${newTarget} @ ${newPoiName}`);
              const travelResp = await bot.exec("travel", { target_poi: newPoiId });
              
              // Check for battle notifications
              if (travelResp.notifications && Array.isArray(travelResp.notifications)) {
                const battleDetected = await handleBattleNotifications(ctx, travelResp.notifications, battleState);
                if (battleDetected) {
                  ctx.log("error", "Battle detected while traveling to new target - fleeing!");
                  stopReason = "battle detected";
                  break;
                }
              }
              
              if (travelResp.error && !travelResp.error.message.includes("already")) {
                ctx.log("error", `Travel to new target failed: ${travelResp.error.message}`);
                stopReason = `${resourceLabel} field depleted (travel failed)`;
                break;
              }
              bot.poi = newPoiId;
            }

            miningPoi = { id: newPoiId, name: newPoiName };
            ctx.log("mining", `Continuing mining session with new target: ${newTarget}`);
            continue; // Continue the harvest loop with new target
          } else {
            ctx.log("mining", `No alternative ${resourceLabel} found — ending mining cycle`);
            stopReason = `${resourceLabel} field depleted (no alternatives)`;
            break;
          }
        }
        if (msg.includes("cargo") && msg.includes("full")) {
          stopReason = "cargo full"; break;
        }
        if (msg.includes("harvester") || msg.includes("equipment") || msg.includes("mining")) {
          ctx.log("error", `Missing ${resourceLabel} harvesting module: ${mineResp.error.message}`);
          await sleep(30000);
          return;
        }
        ctx.log("error", `Harvest error: ${mineResp.error.message}`);
        break;
      }

      harvestCycles++;

      const { oreId, oreName } = parseOreFromMineResult(mineResp.result);
      if (oreId && bot.poi) {
        mapStore.recordMiningYield(bot.system, bot.poi, { item_id: oreId, name: oreName });
        resourcesMinedMap.set(oreName, (resourcesMinedMap.get(oreName) || 0) + 1);
        bot.stats.totalMined++;

        // JETTISON: If the mined ore is in the jettison list, dump it immediately
        if (activeJettisonList.includes(oreId)) {
          const jettisonResp = await bot.exec("jettison", { item_id: oreId, quantity: 9999 });
          if (!jettisonResp.error) {
            const dcTag = isDeepCoreMining ? " [deep core]" : "";
            ctx.log("mining", `Jettisoned ${oreName} (low-value ore configured for jettison${dcTag})`);
            await bot.refreshCargo();
          }
        }

        // JETTISON: Also clear any other jettison-listed ores that may have accumulated in cargo
        for (const jettisonOreId of activeJettisonList) {
          if (jettisonOreId === oreId) continue; // Already jettisoned above
          const cargoItem = bot.inventory.find(i => i.itemId === jettisonOreId);
          if (cargoItem && cargoItem.quantity > 0) {
            const jettisonResp = await bot.exec("jettison", { item_id: jettisonOreId, quantity: cargoItem.quantity });
            if (!jettisonResp.error) {
              const jettisonName = cargoItem.name || jettisonOreId;
              const dcTag = isDeepCoreMining ? " [deep core]" : "";
              ctx.log("mining", `Jettisoned ${cargoItem.quantity}x ${jettisonName} (configured for jettison${dcTag})`);
              await bot.refreshCargo();
            }
          }
        }

        // Update session with mined resources
        if (recoveredSession) {
          const currentMined = recoveredSession.resourcesMined[oreName] || 0;
          updateMiningSession(bot.username, {
            resourcesMined: { ...recoveredSession.resourcesMined, [oreName]: currentMined + 1 },
            cyclesMined: recoveredSession.cyclesMined + 1,
          });
        }

        // MAP UPDATE: Record successful mining at this POI
        // This helps validate that the POI still has this resource available
        const sysData = mapStore.getSystem(bot.system);
        const storedPoi = sysData?.pois.find(p => p.id === bot.poi);
        if (storedPoi) {
          const oreEntry = storedPoi.ores_found.find(o => o.item_id === oreId);
          if (oreEntry) {
            // Update last_seen and increment times_seen
            oreEntry.last_seen = new Date().toISOString();
            oreEntry.times_seen = (oreEntry.times_seen || 0) + 1;
            // Clear depleted flag if it was marked depleted
            if (oreEntry.depleted) {
              oreEntry.depleted = false;
              oreEntry.depleted_at = undefined;
              ctx.log("map", `Cleared depletion flag for ${oreId} at ${bot.poi} (successful mining)`);
            }
          }
        }
      }

      await bot.refreshStatus();
      const fillRatio = bot.cargoMax > 0 ? bot.cargo / bot.cargoMax : 0;
      if (fillRatio >= cargoThresholdRatio) {
        stopReason = `cargo at ${Math.round(fillRatio * 100)}%`; break;
      }

      yield "harvesting";
    }

    // Harvest summary
    if (harvestCycles > 0) {
      const resourceList = [...resourcesMinedMap.entries()].map(([name, qty]) => `${qty}x ${name}`).join(", ");
      ctx.log("mining", `Harvested ${harvestCycles} cycles (${resourceList})${stopReason ? ` — ${stopReason}` : ""}`);
    } else if (stopReason) {
      ctx.log("mining", `Stopped before harvesting — ${stopReason}`);
    }

    if (bot.state !== "running") break;

    // ── Return to home system if we traveled away ──
    // When stayOutUntilFull is enabled, only return home if cargo is full OR
    // if we stopped mining due to depletion (no alternative POI found)
    const fillRatio = bot.cargoMax > 0 ? bot.cargo / bot.cargoMax : 0;
    const isDepleted = stopReason && stopReason.includes("depleted");
    const shouldReturnHome = settings.stayOutUntilFull
      ? ((fillRatio >= cargoThresholdRatio || isDepleted) && bot.system !== homeSystem && homeSystem)
      : (bot.system !== homeSystem && homeSystem);

    if (shouldReturnHome) {
      yield "return_home";
      yield "pre_return_fuel";
      // Update session state
      if (recoveredSession) {
        updateMiningSession(bot.username, { state: "returning_home" });
      }
      const returnFueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
      if (!returnFueled && stationPoi) {
        await refuelAtStation(ctx, stationPoi, safetyOpts.fuelThresholdPct);
      }

      const arrived = await navigateToSystem(ctx, homeSystem, safetyOpts);
      if (!arrived) {
        ctx.log("error", "Failed to return to home system — docking at nearest station");
      }

      const { pois: homePois } = await getSystemInfo(ctx);
      const homeStation = findStation(homePois);
      stationPoi = homeStation ? { id: homeStation.id, name: homeStation.name } : null;
    }

    // ── Ensure we have a valid station to dock at ──
    if (!stationPoi || bot.system === homeSystem) {
      const { pois: currentPois } = await getSystemInfo(ctx);
      const currentStation = findStation(currentPois);
      if (currentStation) {
        stationPoi = { id: currentStation.id, name: currentStation.name };
      }
    }

    // ── Travel to station ──
    yield "travel_to_station";
    if (stationPoi) {
      const travelStationResp = await bot.exec("travel", { target_poi: stationPoi.id });
      if (travelStationResp.error && !travelStationResp.error.message.includes("already")) {
        ctx.log("error", `Travel to station failed: ${travelStationResp.error.message}`);
      }
    }

    // ── Dock ──
    yield "dock";

    // Signal escorts that we're docking (they should stay on patrol)
    const minerDockSettings = getMinerSettings(bot.username);
    if (minerDockSettings.escortName) {
      ctx.log("escort", "Signaling escorts: miner docking...");
      await signalEscort(ctx, "dock", undefined, minerDockSettings.escortSignalChannel);
    }

    // Signal flock that we're docking
    if (settings.flockEnabled && settings.flockName) {
      ctx.log("flock", "Signaling flock: miner docking...");
      await updateFlockPhase(settings.flockName, "docked");
    }

    const dockResp = await bot.exec("dock");
    if (dockResp.error && !dockResp.error.message.includes("already")) {
      ctx.log("error", `Dock failed: ${dockResp.error.message}`);
      const docked = await ensureDocked(ctx);
      if (!docked) {
        ctx.log("error", "Failed to find station — waiting before retry");
        await sleep(5000);
        continue;
      }
    } else {
      bot.docked = true;
    }

    // ── Collect storage + unload cargo ──
    await collectFromStorage(ctx);
    const creditsBefore = bot.credits;

    yield "unload_cargo";
    const cargoResp = await bot.exec("get_cargo");
    if (cargoResp.result && typeof cargoResp.result === "object") {
      const result = cargoResp.result as Record<string, unknown>;
      const cargoItems = (
        Array.isArray(result) ? result :
        Array.isArray(result.items) ? result.items :
        Array.isArray(result.cargo) ? result.cargo : []
      ) as Array<Record<string, unknown>>;

      const modeLabel: Record<string, string> = {
        storage: "station storage", faction: "faction storage", sell: "market",
      };
      const intendedLabel = settings.depositBot
        ? `${settings.depositBot}'s storage`
        : (modeLabel[settings.depositMode] || "storage");

      const unloadedItems: string[] = [];
      let hadFallback = false;
      for (const item of cargoItems) {
        const itemId = (item.item_id as string) || "";
        const quantity = (item.quantity as number) || 0;
        if (!itemId || quantity <= 0) continue;
        const displayName = (item.name as string) || itemId;

        if (settings.depositMode === "sell") {
          const sellResp = await bot.exec("sell", { item_id: itemId, quantity });
          if (sellResp.error) {
            ctx.log("warn", `Market sell failed for ${displayName} — falling back to personal storage`);
            await bot.exec("deposit_items", { item_id: itemId, quantity });
            hadFallback = true;
          }
        } else if (settings.depositMode === "faction") {
          const fResp = await bot.exec("faction_deposit_items", { item_id: itemId, quantity });
          if (fResp.error) {
            ctx.log("warn", `Faction deposit failed for ${displayName}: ${fResp.error.message} — falling back to personal storage`);
            await bot.exec("deposit_items", { item_id: itemId, quantity });
            hadFallback = true;
          }
        } else if (settings.depositBot) {
          const gResp = await bot.exec("send_gift", { recipient: settings.depositBot, item_id: itemId, quantity });
          if (gResp.error) {
            ctx.log("warn", `Gift to ${settings.depositBot} failed for ${displayName}: ${gResp.error.message} — falling back to personal storage`);
            await bot.exec("deposit_items", { item_id: itemId, quantity });
            hadFallback = true;
          }
        } else {
          await bot.exec("deposit_items", { item_id: itemId, quantity });
        }
        unloadedItems.push(`${quantity}x ${displayName}`);
        yield "unloading";
      }

      if (unloadedItems.length > 0) {
        const actualLabel = hadFallback ? "personal storage (fallback)" : intendedLabel;
        ctx.log("trade", `Unloaded ${unloadedItems.join(", ")} → ${actualLabel}`);
      }

      // Update session state after depositing
      if (recoveredSession) {
        updateMiningSession(bot.username, { state: "depositing" });
      }
    }

    await bot.refreshStatus();
    await bot.refreshStorage();

    const earnings = bot.credits - creditsBefore;
    await factionDonateProfit(ctx, earnings);

    // Complete mining session after successful deposit
    if (recoveredSession) {
      completeMiningSession(bot.username);
      ctx.log("mining", `Mining session completed: ${recoveredSession.cyclesMined} cycles, ${Object.entries(recoveredSession.resourcesMined).map(([k, v]) => `${v}x ${k}`).join(", ")}`);
      recoveredSession = null;
    }

    // Flock: unregister member after cycle completes (optional - can stay in flock across cycles)
    // Uncomment if you want bots to leave flock after each cycle:
    // if (settings.flockEnabled && settings.flockName) {
    //   await unregisterFlockMember(settings.flockName, bot.username);
    //   ctx.log("flock", "Left flock after cycle completion");
    // }

    // ── Mission handling: complete and accept missions ──
    yield "complete_missions";
    await completeActiveMissions(ctx);

    yield "accept_missions";
    await checkAndAcceptMinerMissions(ctx);

    // ── Refuel + Repair ──
    yield "refuel";
    await tryRefuel(ctx);
    yield "repair";
    await repairShip(ctx);

    yield "check_skills";
    await bot.checkSkills();

    await bot.refreshStatus();
    const endFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    ctx.log("info", `Cycle done — ${bot.credits} credits, ${endFuel}% fuel, ${bot.cargo}/${bot.cargoMax} cargo`);
  }
};
