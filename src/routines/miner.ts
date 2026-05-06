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
} from "./common.js";
import {
  getRadioactiveCapability,
  getRadioactiveCapabilityCached,
  hasRadioactiveEquipmentCached,
  hasFullRadioactiveCapabilityCached,
  logRadioactiveCapability,
  isRadioactiveOre,
} from "./miner_radioactive.js";
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
  shouldEngagePlayersInCombat,
  engageInBattle,
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
  "adamantite_ore",
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
    if (checkStr.includes("deep_core_extractor_mki") ||
        checkStr.includes("deep_core_extractor_mkii") ||
        checkStr.includes("deep_core_extractor_ii") ||
        checkStr.includes("deep_core_extractor") ||
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
 * During field_test mission, only extractor is required.
 * Miners with only extractor can mine deep core ores in visible POIs.
 */
async function getDeepCoreCapability(ctx: RoutineContext, fieldTestActive: boolean = false): Promise<{
  hasScanner: boolean;
  hasExtractor: boolean;
  canMineHidden: boolean;
  canMineVisibleDeepCore: boolean;
}> {
  const hasScanner = await hasDeepCoreSurveyScanner(ctx);
  const hasExtractor = await hasDeepCoreExtractor(ctx);

  // Can mine hidden POIs: requires scanner + extractor (or extractor only during field_test)
  const canMineHidden = fieldTestActive ? hasExtractor : (hasScanner && hasExtractor);

  // Can mine deep core ores in visible POIs: requires extractor (even without scanner)
  const canMineVisibleDeepCore = hasExtractor;

  return {
    hasScanner,
    hasExtractor,
    canMineHidden,
    canMineVisibleDeepCore,
  };
}

/**
 * Check if the 'field_test' mission is currently active.
 * This is the early game mission that gives you the deep core extractor
 * and tasks you with mining 10 exotic matter, but you don't have the
 * survey scanner yet.
 */
async function hasFieldTestMission(ctx: RoutineContext): Promise<boolean> {
  const { bot } = ctx;
  const activeResp = await bot.exec("get_active_missions");
  if (activeResp.error || !activeResp.result) return false;

  const result = activeResp.result as Record<string, unknown>;
  const missions = Array.isArray(activeResp.result)
    ? activeResp.result
    : Array.isArray(result.missions)
    ? result.missions
    : [];

  for (const mission of missions) {
    const missionObj = typeof mission === "object" && mission !== null ? mission as Record<string, unknown> : null;
    const missionId = (missionObj?.id as string) || (missionObj?.mission_id as string) || "";
    const missionName = (missionObj?.name as string) || "";
    const missionDesc = (missionObj?.description as string) || "";
    const missionType = (missionObj?.type as string) || "";

    const checkStr = `${missionId} ${missionName} ${missionDesc} ${missionType}`.toLowerCase();
    if (checkStr.includes("field_test") || checkStr.includes("field test")) {
      return true;
    }
  }

  return false;
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
type MiningType = "auto" | "ore" | "gas" | "ice" | "radioactive";
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
  systemRadioactive: string; // Radioactive mining target system
  systemDeepCore: string; // Deep core mining target system
  depositBot: string;
  targetOre: string;
  targetGas: string;
  targetIce: string;
  targetRadioactive: string;
  targetDeepCore: string; // Deep core ore global target override
  oreQuotas: Record<string, number>;
  gasQuotas: Record<string, number>;
  iceQuotas: Record<string, number>;
  radioactiveQuotas: Record<string, number>;
  deepCoreQuotas: Record<string, number>;
  jettisonOres: string[]; // Ore IDs to jettison when found in cargo during mining
  deepCoreJettisonOres: string[]; // Ore IDs to jettison when mining deep core (hidden POIs)
  radioactiveJettisonOres: string[]; // Ore IDs to jettison when mining radioactive ores
  depletionTimeoutHours: number;
  ignoreDepletion: boolean;
  stayOutUntilFull: boolean;
  maxJumps: number;
  escortName: string;
   escortSignalChannel: "faction" | "local" | "file" | "chat";
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
    if (val === "auto" || val === "ore" || val === "gas" || val === "ice" || val === "radioactive") return val;
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
    systemRadioactive: (botOverrides.systemRadioactive as string) || (m.systemRadioactive as string) || (m.system as string) || "",
    systemDeepCore: (botOverrides.systemDeepCore as string) || (m.systemDeepCore as string) || (m.system as string) || "",
    depositBot: (botOverrides.depositBot as string) || (m.depositBot as string) || "",
    targetOre: (botOverrides.targetOre as string) || (m.targetOre as string) || "",
    targetGas: (botOverrides.targetGas as string) || (m.targetGas as string) || "",
    targetIce: (botOverrides.targetIce as string) || (m.targetIce as string) || "",
    targetRadioactive: (botOverrides.targetRadioactive as string) || (m.targetRadioactive as string) || "",
    targetDeepCore: (botOverrides.targetDeepCore as string) || (m.targetDeepCore as string) || "",
    oreQuotas: (m.oreQuotas as Record<string, number>) || {},
    gasQuotas: (m.gasQuotas as Record<string, number>) || {},
    iceQuotas: (m.iceQuotas as Record<string, number>) || {},
    radioactiveQuotas: (m.radioactiveQuotas as Record<string, number>) || {},
    deepCoreQuotas: (m.deepCoreQuotas as Record<string, number>) || {},
    jettisonOres: (m.jettisonOres as string[]) || [],
    deepCoreJettisonOres: (m.deepCoreJettisonOres as string[]) || [],
    radioactiveJettisonOres: (m.radioactiveJettisonOres as string[]) || [],
    depletionTimeoutHours: (m.depletionTimeoutHours as number) || 3,
    ignoreDepletion: (m.ignoreDepletion as boolean) ?? false,
    stayOutUntilFull: (m.stayOutUntilFull as boolean) ?? false,
    maxJumps: (m.maxJumps as number) ?? 10,
    escortName: (botOverrides.escortName as string) || (m.escortName as string) || "",
    escortSignalChannel:
      parseSignalChannel(botOverrides.escortSignalChannel) ??
      parseSignalChannel(m.escortSignalChannel) ?? "chat",
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
async function detectMiningType(ctx: RoutineContext, cachedModules?: unknown[]): Promise<"ore" | "gas" | "ice" | "radioactive" | null> {
  const { bot } = ctx;
  let shipData: Record<string, unknown>;
  let usingCachedModules = false;

  if (cachedModules) {
    shipData = { modules: cachedModules };
    usingCachedModules = true;
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
  let hasStripMiner = false;
  let hasGasHarvester = false;
  let hasIceHarvester = false;
  let hasLeadLinedCargo = false;
  let hasRadHarvester = false;

  for (const mod of modules) {
    const modObj = typeof mod === "object" && mod !== null ? mod as Record<string, unknown> : null;
    const modId = (modObj?.id as string) || (modObj?.type_id as string) || "";
    const modName = (modObj?.name as string) || "";
    const modType = (modObj?.type as string) || "";
    const modSpecial = (modObj?.special as string) || "";

    const checkStr = `${modId} ${modName} ${modType} ${modSpecial}`.toLowerCase();

    if (checkStr.includes("mining_laser") || checkStr.includes("mining laser")) {
      hasMiningLaser = true;
    }
    if (checkStr.includes("strip_miner") || checkStr.includes("strip miner")) {
      hasStripMiner = true;
    }
    if (checkStr.includes("gas_harvester") || checkStr.includes("gas harvester")) {
      hasGasHarvester = true;
    }
    if (checkStr.includes("ice_harvester") || checkStr.includes("ice harvester")) {
      hasIceHarvester = true;
    }
    if (checkStr.includes("lead_lined_cargo") || checkStr.includes("lead lined cargo")) {
      hasLeadLinedCargo = true;
    }
    if (checkStr.includes("rad_harvester") || checkStr.includes("rad harvester")) {
      hasRadHarvester = true;
    }
  }

  const hasRadioactiveEquipment = hasLeadLinedCargo && hasRadHarvester;

  // Priority: radioactive > ice > gas > ore (if multiple types present, use settings preference)
  const detectedTypes: string[] = [];
  if (hasMiningLaser || hasStripMiner) detectedTypes.push("ore");
  if (hasGasHarvester) detectedTypes.push("gas");
  if (hasIceHarvester) detectedTypes.push("ice");
  if (hasRadioactiveEquipment) detectedTypes.push("radioactive");

  if (detectedTypes.length > 1) {
    ctx.log("info", `Multiple mining modules detected (${detectedTypes.join(", ")}) — using settings preference`);
    return "ore"; // Default to ore if multiple present
  }
  if (hasRadioactiveEquipment) {
    ctx.log("info", "Radioactive mining equipment detected — radioactive mining mode");
    return "radioactive";
  }
  if (hasIceHarvester) {
    ctx.log("info", "Ice harvester detected — ice mining mode");
    return "ice";
  }
  if (hasGasHarvester) {
    ctx.log("info", "Gas harvester detected — gas harvesting mode");
    return "gas";
  }
  if (hasStripMiner) {
    ctx.log("info", "Strip miner detected — ore mining mode (limited to common ores: carbon, copper, iron, lead, silicon, aluminum)");
    ctx.log("warn", "Strip miners can only mine common rarity ores — will only target carbon/copper/iron/lead/silicon/aluminum");
    return "ore";
  }
  if (hasMiningLaser) {
    ctx.log("info", "Mining laser detected — ore mining mode");
    return "ore";
  }

  // Check for deep core equipment (survey scanner + extractor) — counts as ore mining
  // Even with only extractor (no scanner), it's still ore mining capability
  const fieldTestActive = await hasFieldTestMission(ctx);
  const deepCoreCap = await getDeepCoreCapability(ctx, fieldTestActive);
  if (deepCoreCap.canMineVisibleDeepCore) {
    if (deepCoreCap.canMineHidden) {
      if (fieldTestActive) {
        ctx.log("info", "Deep core mining equipment detected — ore mining mode (extractor only, field_test mission)");
      } else {
        ctx.log("info", "Deep core mining equipment detected — ore mining mode (full capability - can access hidden POIs)");
      }
    } else {
      ctx.log("info", "Deep core mining equipment detected — ore mining mode (limited capability - visible POIs only)");
    }
    return "ore";
  }

  // CRITICAL FIX: If using cached modules and no equipment detected, try fresh get_ship call
  // This prevents failures when cached modules are incomplete after client restart/timeout
  if (usingCachedModules && !hasMiningLaser && !hasStripMiner && !hasGasHarvester && !hasIceHarvester && !hasRadioactiveEquipment && !deepCoreCap.canMineHidden) {
    ctx.log("warn", "Cached modules incomplete — retrying with fresh ship data");
    const freshResp = await bot.exec("get_ship");
    if (!freshResp.error && freshResp.result) {
      const freshShipData = freshResp.result as Record<string, unknown>;
      const freshModules = Array.isArray(freshShipData.modules) ? freshShipData.modules : [];

      // Reset detection flags
      hasMiningLaser = false;
      hasStripMiner = false;
      hasGasHarvester = false;
      hasIceHarvester = false;
      hasLeadLinedCargo = false;
      hasRadHarvester = false;

      for (const mod of freshModules) {
        const modObj = typeof mod === "object" && mod !== null ? mod as Record<string, unknown> : null;
        const modId = (modObj?.id as string) || (modObj?.type_id as string) || "";
        const modName = (modObj?.name as string) || "";
        const modType = (modObj?.type as string) || "";
        const modSpecial = (modObj?.special as string) || "";

        const checkStr = `${modId} ${modName} ${modType} ${modSpecial}`.toLowerCase();

        if (checkStr.includes("mining_laser") || checkStr.includes("mining laser")) {
          hasMiningLaser = true;
        }
        if (checkStr.includes("strip_miner") || checkStr.includes("strip miner")) {
          hasStripMiner = true;
        }
        if (checkStr.includes("gas_harvester") || checkStr.includes("gas harvester")) {
          hasGasHarvester = true;
        }
        if (checkStr.includes("ice_harvester") || checkStr.includes("ice harvester")) {
          hasIceHarvester = true;
        }
        if (checkStr.includes("lead_lined_cargo") || checkStr.includes("lead lined cargo")) {
          hasLeadLinedCargo = true;
        }
        if (checkStr.includes("rad_harvester") || checkStr.includes("rad harvester")) {
          hasRadHarvester = true;
        }
      }

      const freshHasRadioactiveEquipment = hasLeadLinedCargo && hasRadHarvester;

      // Re-check deep core with fresh data
      const freshDeepCoreCap = await getDeepCoreCapability(ctx, fieldTestActive);

      // Re-evaluate with fresh data
      if (freshHasRadioactiveEquipment) {
        ctx.log("info", "Radioactive mining equipment detected (fresh data) — radioactive mining mode");
        return "radioactive";
      }
      if (hasIceHarvester) {
        ctx.log("info", "Ice harvester detected (fresh data) — ice mining mode");
        return "ice";
      }
      if (hasGasHarvester) {
        ctx.log("info", "Gas harvester detected (fresh data) — gas harvesting mode");
        return "gas";
      }
      if (hasStripMiner) {
        ctx.log("info", "Strip miner detected (fresh data) — ore mining mode (limited to common ores: carbon, copper, iron, lead, silicon, aluminum)");
        ctx.log("warn", "Strip miners can only mine common rarity ores — will only target carbon/copper/iron/lead/silicon/aluminum");
        return "ore";
      }
      if (hasMiningLaser) {
        ctx.log("info", "Mining laser detected (fresh data) — ore mining mode");
        return "ore";
      }
      if (freshDeepCoreCap.canMineVisibleDeepCore) {
        if (freshDeepCoreCap.canMineHidden) {
          if (fieldTestActive) {
            ctx.log("info", "Deep core mining equipment detected (fresh data) — ore mining mode (extractor only, field_test mission)");
          } else {
            ctx.log("info", "Deep core mining equipment detected (fresh data) — ore mining mode (full capability - can access hidden POIs)");
          }
        } else {
          ctx.log("info", "Deep core mining equipment detected (fresh data) — ore mining mode (limited capability - visible POIs only)");
        }
        return "ore";
      }
    }
  }

  ctx.log("error", "No mining equipment detected on ship");
  return null;
}

/** Quick check: does the ship have equipment for a specific mining type? */
async function hasEquipmentForMiningType(ctx: RoutineContext, miningType: "ore" | "gas" | "ice" | "radioactive", cachedModules?: unknown[]): Promise<boolean> {
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
             moduleStr.includes("strip_miner") || moduleStr.includes("strip miner") ||
             moduleStr.includes("deep_core_survey_scanner") || moduleStr.includes("deep core survey scanner");
    case "gas": return moduleStr.includes("gas_harvester") || moduleStr.includes("gas harvester");
    case "ice": return moduleStr.includes("ice_harvester") || moduleStr.includes("ice harvester");
    case "radioactive": return hasRadioactiveEquipmentCached(modules);
  }
}

/**
 * Check if the ship has strip miner equipped (limited to basic ores only).
 * Strip miners can ONLY mine iron_ore and copper_ore - they cannot mine rarer ores.
 */
async function hasStripMiner(ctx: RoutineContext, cachedModules?: unknown[]): Promise<boolean> {
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

  return moduleStr.includes("strip_miner") || moduleStr.includes("strip miner");
}

/**
 * List of ores that strip miners can mine (common rarity only).
 * Strip miners are limited to common ores - cannot mine rare/exotic ores.
 * Common ores: carbon, copper, iron, lead, silicon, aluminum
 */
const STRIP_MINER_ORES = new Set([
  "carbon_ore",
  "copper_ore", 
  "iron_ore",
  "lead_ore",
  "silicon_ore",
  "aluminum_ore"
]);

/**
 * Check if an ore is minable by strip miner.
 */
function isStripMinerOre(oreId: string): boolean {
  return STRIP_MINER_ORES.has(oreId.toLowerCase());
}

/**
 * Survey the current system to reveal hidden POIs.
 * This is required before a bot can travel to a hidden POI it hasn't discovered yet.
 * Returns true if the survey was successful (or already surveyed), false on error.
 */
async function surveySystemForHiddenPois(ctx: RoutineContext): Promise<boolean> {
  const { bot } = ctx;
  
  ctx.log("mining", "Surveying system to reveal hidden POIs...");
  const surveyResp = await bot.exec("survey_system");
  
  // Check for battle notifications after survey
  if (surveyResp.notifications && Array.isArray(surveyResp.notifications)) {
    const battleState: BattleState = {
      inBattle: false,
      battleId: null,
      battleStartTick: null,
      lastHitTick: null,
      isFleeing: false,
    };
    const battleDetected = await handleBattleNotifications(ctx, surveyResp.notifications, battleState);
    if (battleDetected) {
      ctx.log("error", "Battle detected during survey - will retry later");
      return false;
    }
  }
  
  if (surveyResp.error) {
    const errorMsg = surveyResp.error.message.toLowerCase();
    // "already surveyed" is not an error - just means we've already done it
    if (errorMsg.includes("already surveyed")) {
      ctx.log("mining", "System already surveyed - hidden POIs should be visible");
      return true;
    }
    // "no_scanner" means we don't have the equipment
    if (errorMsg.includes("no_scanner") || errorMsg.includes("no scanner")) {
      ctx.log("error", "Survey failed: no survey scanner equipped");
      return false;
    }
    // Other errors
    ctx.log("error", `Survey failed: ${surveyResp.error.message}`);
    return false;
  }
  
  // Survey was successful - update map with newly revealed POIs
  ctx.log("mining", "System surveyed successfully - hidden POIs now accessible");
  
  // Refresh system info to get the newly revealed POIs
  const { pois: newPois, systemId } = await getSystemInfo(ctx);
  if (systemId && newPois.length > 0) {
    mapStore.updateSystem({
      id: systemId,
      pois: newPois.map(p => ({
        id: p.id,
        name: p.name,
        type: p.type,
      })),
      last_visited: new Date().toISOString(),
    });
    ctx.log("map", `Updated map for ${systemId}: ${newPois.length} POIs recorded (including hidden POIs)`);
  }
  
  return true;
}

/**
 * Check if a travel error is due to an unknown destination (hidden POI not yet discovered).
 */
function isUnknownDestinationError(error: { message: string } | null | undefined): boolean {
  if (!error) return false;
  const msg = error.message.toLowerCase();
  return msg.includes("unknown destination") || msg.includes("unknown poi");
}

/**
 * Attempt to travel to a POI, and if it fails due to unknown destination
 * (hidden POI not yet discovered), survey the system and retry.
 */
async function travelToPoiWithSurvey(
  ctx: RoutineContext,
  poiId: string,
  poiName: string,
  isHidden: boolean,
): Promise<{ success: boolean; error?: string }> {
  const { bot } = ctx;
  
  // First attempt to travel
  const travelResp = await bot.exec("travel", { target_poi: poiId });

  // Check for battle notifications
  if (travelResp.notifications && Array.isArray(travelResp.notifications)) {
    const battleState: BattleState = {
      inBattle: false,
      battleId: null,
      battleStartTick: null,
      lastHitTick: null,
      isFleeing: false,
    };
    const battleDetected = await handleBattleNotifications(ctx, travelResp.notifications, battleState);
    if (battleDetected) {
      ctx.log("error", "Battle detected during travel - fleeing!");
      return { success: false, error: "battle detected" };
    }
  }

  // Check if travel was successful
  if (!travelResp.error || travelResp.error.message.includes("already")) {
    bot.poi = poiId;
    return { success: true };
  }

  // CRITICAL: Check for battle interrupt error
  if (travelResp.error.code === "battle_interrupt" ||
      travelResp.error.message.toLowerCase().includes("interrupted by battle") ||
      travelResp.error.message.toLowerCase().includes("interrupted by combat")) {
    ctx.log("combat", `Travel interrupted by battle! ${travelResp.error.message} - fleeing!`);
    await fleeFromBattle(ctx);
    return { success: false, error: "battle detected" };
  }

  // Travel failed - check if it's because the POI is unknown (hidden, not yet discovered)
  if (isUnknownDestinationError(travelResp.error)) {
    ctx.log("error", `Travel failed: Unknown destination ${poiId} — hidden POI not yet discovered`);
    
    // Only attempt survey if this is actually a hidden POI
    if (!isHidden) {
      ctx.log("error", `Travel failed: ${travelResp.error.message}`);
      return { success: false, error: travelResp.error.message };
    }
    
    // Survey the system to reveal the hidden POI
    const surveySuccess = await surveySystemForHiddenPois(ctx);
    if (!surveySuccess) {
      return { success: false, error: "survey failed" };
    }
    
    // Retry travel after survey
    ctx.log("mining", `Retrying travel to hidden POI ${poiName} after survey...`);
    const retryResp = await bot.exec("travel", { target_poi: poiId });

    // Check for battle notifications on retry
    if (retryResp.notifications && Array.isArray(retryResp.notifications)) {
      const battleState: BattleState = {
        inBattle: false,
        battleId: null,
        battleStartTick: null,
        lastHitTick: null,
        isFleeing: false,
      };
      const battleDetected = await handleBattleNotifications(ctx, retryResp.notifications, battleState);
      if (battleDetected) {
        ctx.log("error", "Battle detected during retry travel - fleeing!");
        return { success: false, error: "battle detected" };
      }
    }

    // CRITICAL: Check for battle interrupt error on retry
    if (retryResp.error && (retryResp.error.code === "battle_interrupt" ||
        retryResp.error.message.toLowerCase().includes("interrupted by battle") ||
        retryResp.error.message.toLowerCase().includes("interrupted by combat"))) {
      ctx.log("combat", `Travel retry interrupted by battle! ${retryResp.error.message} - fleeing!`);
      await fleeFromBattle(ctx);
      return { success: false, error: "battle detected" };
    }

    if (!retryResp.error || retryResp.error.message.includes("already")) {
      bot.poi = poiId;
      ctx.log("mining", `Successfully traveled to hidden POI ${poiName} after survey`);
      return { success: true };
    } else {
      ctx.log("error", `Failed to travel to hidden POI even after survey: ${retryResp.error.message}`);
      return { success: false, error: retryResp.error.message };
    }
  }
  
  // Some other travel error
  ctx.log("error", `Travel failed: ${travelResp.error.message}`);
  return { success: false, error: travelResp.error.message };
}

/** Detect deep core mining capability and log it. */
async function logDeepCoreCapability(ctx: RoutineContext, fieldTestActive: boolean = false): Promise<void> {
  const deepCoreCap = await getDeepCoreCapability(ctx, fieldTestActive);
  if (deepCoreCap.hasScanner || deepCoreCap.hasExtractor) {
    const parts: string[] = [];
    if (deepCoreCap.hasScanner) parts.push("survey scanner");
    if (deepCoreCap.hasExtractor) parts.push("deep core extractor");
    ctx.log("mining", `Deep core equipment detected: ${parts.join(" + ")}`);
    if (fieldTestActive) {
      if (deepCoreCap.canMineHidden) {
        ctx.log("mining", "Deep core mining capability: EXTRACTOR ONLY (field_test mission active - using directional jump method)");
      } else {
        ctx.log("warn", "Deep core mining INCOMPLETE: missing extractor");
      }
    } else {
      if (deepCoreCap.canMineHidden) {
        ctx.log("mining", "Deep core mining capability: FULL (can mine hidden POIs)");
      } else if (deepCoreCap.canMineVisibleDeepCore) {
        ctx.log("mining", "Deep core mining capability: LIMITED (extractor only - visible deep core POIs only)");
      } else {
        if (!deepCoreCap.hasScanner) ctx.log("warn", "Deep core mining INCOMPLETE: missing survey scanner");
        if (!deepCoreCap.hasExtractor) ctx.log("warn", "Deep core mining INCOMPLETE: missing extractor");
      }
    }
  }
}

/** Get expected mining type for a resource ID. */
function getMiningTypeForResource(resourceId: string): "ore" | "gas" | "ice" | "radioactive" {
  const lower = resourceId.toLowerCase();

  // Radioactive resources
  if (lower.includes("polonium") || 
      lower.includes("radium") || 
      lower.includes("uranium") || 
      lower.includes("thorium")) {
    return "radioactive";
  }

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
  miningType: "ore" | "gas" | "ice" | "radioactive"
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

/**
 * Find the first quota target that has available locations in the map.
 * Returns the resource ID of the first quota ore that can actually be mined.
 */
function findFirstAvailableQuotaTarget(
  quotas: Record<string, number>,
  factionStorage: Array<{ itemId: string; quantity: number }>,
  miningType: "ore" | "gas" | "ice" | "radioactive",
  settings: ReturnType<typeof getMinerSettings>,
  mapStore: any,
  depletionTimeoutMs: number,
  canMineHiddenRadioactive: boolean,
  canMineHiddenIce: boolean,
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

  // Also include ores with no deficit but still in quotas (for cycling when all quotas met)
  for (const [resourceId, target] of Object.entries(quotas)) {
    if (target <= 0) continue;
    const current = factionStorage.find(i => i.itemId === resourceId)?.quantity || 0;
    const deficit = target - current;
    if (deficit <= 0 && !entries.some(e => e.resourceId === resourceId)) {
      entries.push({ resourceId, deficit, current, target });
    }
  }

  if (entries.length === 0) return "";

  // Sort: biggest deficit first, then smallest surplus (closest to deficit)
  entries.sort((a, b) => b.deficit - a.deficit);

  // Check each ore in priority order to see if it has available locations
  for (const entry of entries) {
    const locations = mapStore.findOreLocations(entry.resourceId).filter((loc: any) => {
      const sys = mapStore.getSystem(loc.systemId);
      const poi = sys?.pois.find((p: any) => p.id === loc.poiId);
      if (!poi) return true; // keep if type unknown
      if (miningType === "ore") return isOreBeltPoi(poi.type) || poi.hidden === true;
      if (miningType === "radioactive") {
        if (poi.hidden === true && !canMineHiddenRadioactive) return false;
        return isOreBeltPoi(poi.type) || poi.hidden === true;
      }
      if (miningType === "gas") return isGasCloudPoi(poi.type);
      if (miningType === "ice") {
        if (poi.hidden === true && !canMineHiddenIce) return false;
        return isIceFieldPoi(poi.type);
      }
      return true;
    }).filter((loc: any) => {
      // Skip depleted ores (unless depletion has expired or ignoreDepletion is enabled)
      if (settings.ignoreDepletion) {
        // Even with ignoreDepletion, skip completely exhausted POIs (0 remaining)
        if (loc.remaining !== undefined && loc.remaining <= 0 && loc.maxRemaining !== undefined && loc.maxRemaining > 0) {
          return false;
        }
        return true;
      }
      const sys = mapStore.getSystem(loc.systemId);
      const poi = sys?.pois.find((p: any) => p.id === loc.poiId);
      const oreEntry = poi?.ores_found.find((o: any) => o.item_id === entry.resourceId);
      if (!oreEntry?.depleted) return true;
      // Depleted but expired - can re-check
      return isDepletionExpired(oreEntry.depleted_at, depletionTimeoutMs);
    });

    if (locations.length > 0) {
      return entry.resourceId;
    }
  }

  // No quota targets have available locations
  return "";
}

/**
 * Enhanced quota picker that always returns a target, even when all quotas are met.
 * When all quotas are met, picks the resource closest to deficit (smallest surplus).
 * This ensures the miner keeps cycling through ores based on quota priorities.
 */
function pickTargetFromQuotasOrClosest(
  quotas: Record<string, number>,
  factionStorage: Array<{ itemId: string; quantity: number }>,
  miningType: "ore" | "gas" | "ice" | "radioactive"
): { target: string; hasDeficit: boolean } {
  const entries: Array<{ resourceId: string; deficit: number; current: number; target: number }> = [];

  for (const [resourceId, target] of Object.entries(quotas)) {
    if (target <= 0) continue;
    const current = factionStorage.find(i => i.itemId === resourceId)?.quantity || 0;
    const deficit = target - current;
    entries.push({ resourceId, deficit, current, target });
  }

  if (entries.length === 0) return { target: "", hasDeficit: false };

  // Check if any have deficit
  const withDeficit = entries.filter(e => e.deficit > 0);
  if (withDeficit.length > 0) {
    // Sort: biggest deficit first
    withDeficit.sort((a, b) => b.deficit - a.deficit);
    return { target: withDeficit[0].resourceId, hasDeficit: true };
  }

  // All quotas met - pick the one with smallest surplus (closest to needing more)
  entries.sort((a, b) => a.deficit - b.deficit); // smallest surplus first (most negative deficit)
  return { target: entries[0].resourceId, hasDeficit: false };
}

/** Find appropriate POI based on mining type. */
function findMiningPoi(
  pois: Array<{ id: string; name: string; type: string; hidden?: boolean }>,
  miningType: "ore" | "gas" | "ice" | "radioactive",
  targetResource?: string,
  allowHiddenPois?: boolean
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
  } else if (miningType === "radioactive") {
    // Radioactive mining - uses ore belts (and hidden POIs if has deep core extractor)
    if (targetResource) {
      for (const poi of pois) {
        const isMatchingPoi = isOreBeltPoi(poi.type) || (allowHiddenPois && poi.hidden === true);
        if (isMatchingPoi) {
          const sysData = mapStore.getSystem(poi.id.split("-")[0] || "");
          const storedPoi = sysData?.pois.find(p => p.id === poi.id);
          if (storedPoi?.ores_found.some(o => o.item_id === targetResource)) {
            return { id: poi.id, name: poi.name };
          }
        }
      }
    }
    // Fallback: any ore belt (or hidden POI if available)
    const oreBelt = pois.find(p => isOreBeltPoi(p.type) || (allowHiddenPois && p.hidden === true));
    return oreBelt ? { id: oreBelt.id, name: oreBelt.name } : null;
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
  miningType: "ore" | "gas" | "ice" | "radioactive";
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
  miningType: "ore" | "gas" | "ice" | "radioactive",
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
  channel: "faction" | "local" | "file" | "chat" = "faction",
): Promise<void> {
  const { bot } = ctx;
  const message = `[ESCORT] ${action}${systemId ? ` ${systemId}` : ""}`;

  if (channel === "faction") {
    await bot.exec("chat", { channel: "faction", content: message });
  } else if (channel === "local") {
    ctx.log("escort", `Signal: ${message}`);
  } else if (channel === "chat") {
    // Use non-API chat channel for instant coordination
    ctx.sendBotChat?.(message, "escort");
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

// ── Deep core mining efficiency helpers ───────────────────────────────────

/**
 * Find the best hidden POI for a given deep core ore.
 * Prioritizes hidden POIs with high richness.
 * Returns null if no suitable hidden POI found.
 */
function findBestHiddenPoiForOre(
  oreId: string,
  currentSystem: string,
  currentPoiId: string,
  maxJumps: number,
  ignoreDepletion: boolean,
  depletionTimeoutMs: number,
  minRichness: number = 50, // Only consider POIs with richness >= this
): { poiId: string; poiName: string; systemId: string; systemName: string; richness: number; remaining: number; jumps: number; isHidden: boolean } | null {
  const locations = mapStore.findOreLocations(oreId).filter(loc => {
    // Skip current POI
    if (loc.poiId === currentPoiId && loc.systemId === currentSystem) return false;
    
    // Must be a hidden POI
    const sys = mapStore.getSystem(loc.systemId);
    const poi = sys?.pois.find(p => p.id === loc.poiId);
    if (!poi?.hidden) return false;
    
    return true;
  }).filter(loc => {
    // Skip completely exhausted POIs
    if (loc.remaining !== undefined && loc.remaining <= 0 && loc.maxRemaining !== undefined && loc.maxRemaining > 0) {
      return false;
    }
    if (ignoreDepletion) return true;
    const sys = mapStore.getSystem(loc.systemId);
    const poi = sys?.pois.find(p => p.id === loc.poiId);
    const oreEntry = poi?.ores_found.find(o => o.item_id === oreId);
    if (!oreEntry?.depleted) return true;
    return isDepletionExpired(oreEntry.depleted_at, depletionTimeoutMs);
  }).filter(loc => {
    // Only consider high richness POIs
    return loc.richness >= minRichness;
  });

  if (locations.length === 0) return null;

  // Score and sort by distance and richness
  const blacklist = getSystemBlacklist();
  const scored = locations
    .map(loc => {
      const route = mapStore.findRoute(currentSystem, loc.systemId, blacklist);
      return { ...loc, jumps: route ? route.length - 1 : 999 };
    })
    .filter(loc => loc.jumps <= maxJumps)
    .sort((a, b) => {
      // Prefer current system
      if (a.systemId === currentSystem && b.systemId !== currentSystem) return -1;
      if (b.systemId === currentSystem && a.systemId !== currentSystem) return 1;
      // Then by richness (higher is better)
      if (b.richness !== a.richness) return b.richness - a.richness;
      // Then by distance
      return a.jumps - b.jumps;
    });

  if (scored.length === 0) return null;

  const chosen = scored[0];
  const sysData = mapStore.getSystem(chosen.systemId);
  return {
    poiId: chosen.poiId,
    poiName: chosen.poiName,
    systemId: chosen.systemId,
    systemName: sysData?.name || chosen.systemId,
    richness: chosen.richness,
    remaining: chosen.remaining,
    jumps: chosen.jumps,
    isHidden: true,
  };
}

/**
 * Check if all hidden POIs for a given ore are currently depleted (on timer).
 * Returns true if there are hidden POIs but all are on depletion cooldown.
 */
function areAllHiddenPoisDepleted(
  oreId: string,
  currentSystem: string,
  currentPoiId: string,
  ignoreDepletion: boolean,
  depletionTimeoutMs: number,
): boolean {
  const allHiddenLocations = mapStore.findOreLocations(oreId).filter(loc => {
    // Skip current POI
    if (loc.poiId === currentPoiId && loc.systemId === currentSystem) return false;
    
    // Must be a hidden POI
    const sys = mapStore.getSystem(loc.systemId);
    const poi = sys?.pois.find(p => p.id === loc.poiId);
    if (!poi?.hidden) return false;
    
    return true;
  });

  if (allHiddenLocations.length === 0) return false; // No hidden POIs exist

  // Check if ALL of them are depleted and not expired
  const allDepleted = allHiddenLocations.every(loc => {
    // Skip completely exhausted POIs (0 remaining)
    if (loc.remaining !== undefined && loc.remaining <= 0 && loc.maxRemaining !== undefined && loc.maxRemaining > 0) {
      return true; // Consider as "depleted"
    }
    if (ignoreDepletion) return false;
    const sys = mapStore.getSystem(loc.systemId);
    const poi = sys?.pois.find(p => p.id === loc.poiId);
    const oreEntry = poi?.ores_found.find(o => o.item_id === oreId);
    if (!oreEntry?.depleted) return false;
    return !isDepletionExpired(oreEntry.depleted_at, depletionTimeoutMs);
  });

  return allDepleted;
}

// ── Miner routine ────────────────────────────────────────────

export const minerRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  await bot.refreshStatus();
  const settings0 = getMinerSettings(bot.username);
  const homeSystem = settings0.homeSystem || bot.system;
  const cargoThresholdRatio = settings0.cargoThreshold / 100;

  // ── CRITICAL FIX: Check cargo after client restart/timeout before anything else ──
  // If cargo is full at routine start, log a warning - the session recovery will handle it
  const startCargoFill = bot.cargoMax > 0 ? bot.cargo / bot.cargoMax : 0;
  if (startCargoFill >= cargoThresholdRatio) {
    ctx.log("mining", `Warning: Cargo full (${Math.round(startCargoFill * 100)}%) at routine start`);
  }

   // ── Cache ship modules at routine start ──
   // This avoids repeated get_ship calls that may return incomplete data
   // when the server is still processing (e.g. after a jump timeout).
   let cachedModules: unknown[] | null = await cacheShipModules(ctx);

   // ── CRITICAL FIX: Refresh faction storage at startup for accurate quota checks ──
   ctx.log("miner", "Refreshing faction storage at startup...");
   await bot.refreshFactionStorage();

   // ── Mining session recovery ──
   const activeSession = getActiveMiningSession(bot.username);
   let recoveredSession: MiningSession | null = null;
  let sessionWasReturningHome = false;
  if (activeSession) {
    ctx.log("mining", `Found incomplete mining session: ${activeSession.targetResourceName} (${activeSession.state})`);
    
    // CRITICAL FIX: Track if the session was in returning_home state
    // This is needed to properly resume after client restart/timeouts
    sessionWasReturningHome = activeSession.state === "returning_home";
    
    // Validate session - check if target resource is still valid
    if (activeSession.targetResourceId) {
      const locations = mapStore.findOreLocations(activeSession.targetResourceId);
      if (locations.length > 0) {
        // Also check if we have equipment for this resource type
        const sessionMiningType = getMiningTypeForResource(activeSession.targetResourceId);
        const hasEquipment = await hasEquipmentForMiningType(ctx, sessionMiningType, cachedModules || undefined);
        if (!hasEquipment) {
          ctx.log("error", `Session invalid: no equipment for ${sessionMiningType} mining (${activeSession.targetResourceName}) — abandoning`);
          await failMiningSession(bot.username, "No equipment for resource type");
        } else {
          ctx.log("mining", `Session validated: ${activeSession.targetResourceName} still available in map`);
          recoveredSession = activeSession;
        }
      } else {
        ctx.log("error", `Session invalid: ${activeSession.targetResourceName} no longer in map - abandoning`);
        await failMiningSession(bot.username, "Target resource no longer in map");
      }
    } else {
      ctx.log("error", "Session invalid: no target resource - abandoning");
      await failMiningSession(bot.username, "No target resource");
    }
  }

  // ── Startup: accept missions ──
  await completeActiveMissions(ctx);
  await checkAndAcceptMinerMissions(ctx);

  while (bot.state === "running") {
    // ── Death recovery ──
    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) { await ctx.sleep(30000); continue; }

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

    // ── CRITICAL FIX: Always refresh faction storage at cycle start ──
    // This ensures quota decisions are based on fresh data, not stale cached state
    // Works from anywhere (doesn't require being docked)
    await bot.refreshFactionStorage();

    // ── Check for field_test mission (early game mining mission) ──
    const fieldTestActive = await hasFieldTestMission(ctx);
    if (fieldTestActive) {
      ctx.log("mining", "Field test mission detected - mining with extractor only (directional jump method)");
    }

    // ── Deep core equipment detection (log once per cycle) ──
    await logDeepCoreCapability(ctx, fieldTestActive);

    // ── Flock mining integration ──
    let isFlockLeader = false;
    let flockTargetResource = "";
    let flockTargetSystemId = "";
    let flockTargetPoiId = "";
    let flockTargetPoiName = "";
    let flockMiningType: "ore" | "gas" | "ice" | "radioactive" = "ore";
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
        let actualMiningType: "ore" | "gas" | "ice" | "radioactive" = "ore";

        if (groupMiningType === "auto") {
          const detected = await detectMiningType(ctx, cachedModules || undefined);
          if (!detected) {
            ctx.log("error", "Cannot determine mining type for flock leader — waiting 30s");
            await ctx.sleep(30000);
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
        const deepCoreCap = await getDeepCoreCapability(ctx, fieldTestActive);
        if (deepCoreCap.canMineVisibleDeepCore && flockTargetResource && !isDeepCoreOre(flockTargetResource)) {
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
          await ctx.sleep(5000);
          continue;
        }
        
        // Register as follower
        const registered = await registerFlockMember(settings.flockName, bot.username, false);
        if (!registered) {
          ctx.log("error", "Failed to join flock — state may be stale");
          await ctx.sleep(5000);
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
     let miningType: "ore" | "gas" | "ice" | "radioactive" = "ore";
     if (settings.miningType === "auto") {
       const detected = await detectMiningType(ctx, cachedModules || undefined);
       if (!detected) {
         // CRITICAL FIX: Refresh cached modules and try again
         ctx.log("warn", "Mining type detection failed — refreshing cached modules and retrying");
         cachedModules = await cacheShipModules(ctx);
         const retryDetected = await detectMiningType(ctx, cachedModules || undefined);
         if (!retryDetected) {
           ctx.log("error", "Cannot determine mining type even after refreshing modules — please check ship equipment");
           await ctx.sleep(30000);
           continue;
         }
         miningType = retryDetected;
       } else {
         miningType = detected;
       }
     } else {
       miningType = settings.miningType;
     }

    // Deep core capability check - needed for quota selection below
    const deepCoreCap = await getDeepCoreCapability(ctx, fieldTestActive);
    const useDeepCore = deepCoreCap.canMineVisibleDeepCore;

    // Check for strip miner (limited to basic ores only)
    const usingStripMiner = await hasStripMiner(ctx, cachedModules || undefined);

    // Radioactive mining: check capability levels
    // Basic: can mine basic rad ores in public areas
    // Enhanced: can mine deep core rad ores in visible POIs
    // Full: can mine rad ores in hidden POIs
    const radioactiveCap = getRadioactiveCapabilityCached(cachedModules || []);
    const canMineBasicRadioactive = miningType === "radioactive" && radioactiveCap.canMineBasicRadioactive;
    const canMineDeepCoreRadioactive = miningType === "radioactive" && radioactiveCap.canMineDeepCoreRadioactive;
    let canMineHiddenRadioactive = miningType === "radioactive" && radioactiveCap.canMineHiddenRadioactive;

    // For radioactive mining, allow hidden POIs with basic equipment + deep core survey scanner
    const moduleStr = cachedModules ? cachedModules.map(m => {
      const obj = typeof m === "object" && m !== null ? m as Record<string, unknown> : {};
      return `${obj.id || ""} ${obj.name || ""} ${obj.type || ""} ${obj.special || ""}`.toLowerCase();
    }).join(" ") : "";
    const hasDeepCoreSurveyScannerCached = moduleStr.includes("deep_core_survey_scanner") || moduleStr.includes("deep core survey scanner") || moduleStr.includes("deep_core_detection");
    if (miningType === "radioactive" && radioactiveCap.canMineBasicRadioactive && hasDeepCoreSurveyScannerCached) {
      canMineHiddenRadioactive = true;
    }

    // Debug: log the capability check for troubleshooting
    if (miningType === "radioactive") {
      ctx.log("debug", `Radioactive capability: basic=${radioactiveCap.canMineBasicRadioactive}, deepCore=${radioactiveCap.canMineDeepCoreRadioactive}, hiddenPOI=${canMineHiddenRadioactive}`);
    }

    // Ice mining: check if we can access hidden POIs (requires deep core extractor)
    const hasDeepCoreExtractorForIce = await hasDeepCoreExtractor(ctx);
    const canMineHiddenIce = miningType === "ice" && hasDeepCoreExtractorForIce;

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
      targetResource = isAutoDetected ? (useDeepCore ? settings.targetDeepCore : settings.targetOre) : ( (useDeepCore ? settings.targetDeepCore : settings.targetOre) || settings.targetGas || settings.targetIce);
      resourceLabel = targetResource === settings.targetGas ? "gas" : (targetResource === settings.targetIce ? "ice" : "ore");
    } else if (miningType === "radioactive") {
      targetResource = isAutoDetected ? settings.targetRadioactive : (settings.targetRadioactive || settings.targetOre || settings.targetGas);
      resourceLabel = "radioactive";
    } else {
      // gas
      targetResource = isAutoDetected ? settings.targetGas : (settings.targetGas || settings.targetOre || settings.targetIce);
      resourceLabel = targetResource === settings.targetOre ? "ore" : (targetResource === settings.targetIce ? "ice" : "gas");
    }

    // ── STRIP MINER RESTRICTION ──
    // Strip miners can ONLY mine basic ores (iron/copper) - cannot mine rarer ores
    // If strip miner is equipped and target is not a common ore, override to iron_ore
    if (usingStripMiner && targetResource && !isStripMinerOre(targetResource)) {
      ctx.log("warn", `Strip miner limitation: cannot mine ${targetResource} — overriding to iron_ore`);
      targetResource = "iron_ore";
      resourceLabel = "ore";
    }

    // Log mining configuration (re-checked each cycle)
    if (targetResource) {
      ctx.log("mining", `Target ${resourceLabel}: ${targetResource} (mode: ${settings.miningType})`);
    } else {
      ctx.log("mining", `Mining any ${resourceLabel} (no specific target configured)`);
      // Debug: Log what settings were loaded to help diagnose targeting issues
      ctx.log("debug", `Settings loaded: targetOre="${settings.targetOre}", targetGas="${settings.targetGas}", targetIce="${settings.targetIce}", targetRadioactive="${settings.targetRadioactive}"`);
      ctx.log("debug", `System targets: systemOre="${settings.systemOre}", systemGas="${settings.systemGas}", systemIce="${settings.systemIce}", systemRadioactive="${settings.systemRadioactive}"`);
    }

    // ── Select quotas based on mining type ──
    // CRITICAL FIX: Deep core miners should use deepCoreQuotas, not oreQuotas
    // STRIP MINER: Use iron/copper specific quotas (basic ores only)
    let quotas = useDeepCore 
      ? settings.deepCoreQuotas 
      : (miningType === "ice" ? settings.iceQuotas : (miningType === "ore" ? settings.oreQuotas : (miningType === "radioactive" ? settings.radioactiveQuotas : settings.gasQuotas)));
    
    // Strip miner restriction: filter quotas to only iron/copper ores
    if (usingStripMiner) {
      const filteredQuotas: Record<string, number> = {};
      for (const [ore, quota] of Object.entries(quotas)) {
        if (isStripMinerOre(ore)) {
          filteredQuotas[ore] = quota;
        }
      }
      if (Object.keys(filteredQuotas).length > 0) {
        quotas = filteredQuotas;
        ctx.log("debug", `Strip miner - using filtered quotas: ${JSON.stringify(quotas)}`);
      }
    }

    // Radioactive miner restriction: basic radioactive miners can only mine uranium/thorium (common radioactive ores)
    // Rare radioactive ores like polonium/radium require hidden POI access
    if (miningType === "radioactive" && !canMineHiddenRadioactive) {
      const allowedRadioactiveOres = new Set(["uranium_ore", "thorium_ore"]);
      const filteredQuotas: Record<string, number> = {};
      for (const [ore, quota] of Object.entries(quotas)) {
        if (allowedRadioactiveOres.has(ore)) {
          filteredQuotas[ore] = quota;
        }
      }
      quotas = filteredQuotas;
      ctx.log("debug", `Basic radioactive miner - restricted to common radioactive ores: ${JSON.stringify(quotas)}`);
    }
    
    if (useDeepCore) {
      ctx.log("debug", `Deep core mining detected - using deepCoreQuotas: ${JSON.stringify(quotas)}`);
    }

    // ── Determine priority target (global target or quota pick) ──
    const hasGlobalTarget = !!targetResource;
    if (hasGlobalTarget) {
      ctx.log("mining", `Global ${resourceLabel} target configured: ${targetResource} — overriding quotas`);
    }

    // CRITICAL FIX: Always refresh faction storage before quota evaluation
    // (also refreshed above when docked at home, but ensure it's fresh here too)
    let quotaTargetResource = "";
    let quotaHasDeficit = false;
    if (!hasGlobalTarget && Object.keys(quotas).length > 0) {
      await bot.refreshFactionStorage();
      
      // When docked at home, use enhanced selection that always picks a target
      // This ensures the miner keeps cycling through ores even when all quotas are met
      if (bot.docked && bot.system === homeSystem) {
        const quotaResult = pickTargetFromQuotasOrClosest(quotas, bot.factionStorage, miningType);
        quotaTargetResource = quotaResult.target;
        quotaHasDeficit = quotaResult.hasDeficit;
        if (quotaTargetResource) {
          if (quotaHasDeficit) {
            ctx.log("mining", `Quota pick: ${quotaTargetResource} (has deficit)`);
          } else {
            ctx.log("mining", `Quota cycling: ${quotaTargetResource} (all met, smallest surplus)`);
          }
        }
      } else {
        // Original behavior when not at home
        quotaTargetResource = pickTargetFromQuotas(quotas, bot.factionStorage, miningType);
        if (quotaTargetResource) {
          ctx.log("mining", `Quota pick: ${quotaTargetResource} (biggest deficit)`);
        } else {
          ctx.log("mining", "All quotas met — no quota target selected");
        }
      }
    }

    const priorityTarget = hasGlobalTarget ? targetResource : quotaTargetResource;

    // ── Recovered session handling ──
    // CRITICAL FIX: Always validate recovered session against current quotas
    // This prevents the miner from continuing to mine an ore whose quota is now met
    if (recoveredSession) {
      // Validate that the recovered session's target is compatible with currently detected mining type
      const sessionMiningType = getMiningTypeForResource(recoveredSession.targetResourceId);
      if (sessionMiningType !== miningType) {
        ctx.log("warn", `Recovered session target (${recoveredSession.targetResourceName}) incompatible with detected equipment (${miningType}) — discarding session`);
        await failMiningSession(bot.username, "Equipment mismatch");
        recoveredSession = null;
      } else {
        // Check if recovered session target matches current priorities
        const sessionTarget = recoveredSession.targetResourceId;
        let shouldAbandon = false;
        let reason = "";

        // If there's a priority target (global or quota) that differs from session target, abandon session
        if (priorityTarget && sessionTarget !== priorityTarget) {
          shouldAbandon = true;
          reason = hasGlobalTarget ? `global target override (${targetResource})` : `quota priority changed (${quotaTargetResource})`;
        }

        // CRITICAL FIX: If quotas are now all met (no quota target), but session target's quota is now met,
        // abandon the session so the miner can switch to the next ore with a deficit
        if (!shouldAbandon && !hasGlobalTarget && Object.keys(quotas).length > 0) {
          const sessionQuota = quotas[sessionTarget];
          if (sessionQuota !== undefined) {
            const sessionCurrent = bot.factionStorage.find(i => i.itemId === sessionTarget)?.quantity || 0;
            if (sessionCurrent >= sessionQuota) {
              shouldAbandon = true;
              reason = `quota met for ${sessionTarget} (${sessionCurrent}/${sessionQuota}) — switching to next deficit`;
            }
          }
        }

        if (shouldAbandon) {
          ctx.log("mining", `Abandoning recovered session: ${reason}`);
          await failMiningSession(bot.username, reason);
          recoveredSession = null;
        } else {
          ctx.log("mining", `Resuming recovered session: ${recoveredSession.targetResourceName} @ ${recoveredSession.targetPoiName}`);
          
          // CRITICAL FIX: Check cargo BEFORE deciding to continue mining
          // If cargo is full (or session was returning_home), return home first
          const currentFill = bot.cargoMax > 0 ? bot.cargo / bot.cargoMax : 0;
          const isCargoFull = currentFill >= cargoThresholdRatio;
          
          if (isCargoFull) {
            ctx.log("mining", `Cargo full (${Math.round(currentFill * 100)}%) — session must return home first`);
            // Keep the returning_home state from the session
            recoveredSession.state = "returning_home";
            await updateMiningSession(bot.username, { state: "returning_home" });
          } else if (sessionWasReturningHome) {
            // Session was returning_home but cargo isn't full - might have been a restart during return
            // Keep it as returning_home to complete the return journey
            ctx.log("mining", "Session was returning_home — completing return journey");
            recoveredSession.state = "returning_home";
            await updateMiningSession(bot.username, { state: "returning_home" });
          } else {
            // Update session state based on current position
            if (bot.system === recoveredSession.homeSystem && bot.docked) {
              recoveredSession.state = "depositing";
            } else if (bot.system === recoveredSession.targetSystemId) {
              recoveredSession.state = "mining";
            } else {
              // traveling_to_ore or returning_home
              recoveredSession.state = recoveredSession.state as any;
            }
            await updateMiningSession(bot.username, { state: recoveredSession.state });
          }
        }
      }
    }

    // ── Determine effective target ──
    let effectiveTarget = recoveredSession ? recoveredSession.targetResourceId : priorityTarget;
    const isQuotaDriven = recoveredSession ? recoveredSession.isQuotaDriven : !!quotaTargetResource;
    const maxJumps = settings.maxJumps || 10;

    // CRITICAL FIX: If session is in returning_home state, return home instead of mining
    // This catches both full cargo and session Was returning_home
    if (recoveredSession && recoveredSession.state === "returning_home") {
      ctx.log("mining", "Session state is returning_home — returning to deposit cargo first");
      yield "return_home";
      yield "pre_return_fuel";
      const returnFueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
      if (!returnFueled) {
        const { pois: currentPois } = await getSystemInfo(ctx);
        const currentStation = findStation(currentPois);
        if (currentStation) {
          await refuelAtStation(ctx, currentStation, safetyOpts.fuelThresholdPct);
        }
      }
      const homeArrived = await navigateToSystem(ctx, homeSystem, safetyOpts);
      if (!homeArrived) {
        ctx.log("error", "Failed to return to home system — will retry next cycle");
        await ctx.sleep(30000);
        continue;
      }
      const { pois: homePois } = await getSystemInfo(ctx);
      const homeStation = findStation(homePois);
      if (homeStation) {
        yield "travel_to_station";
        await bot.exec("travel", { target_poi: homeStation.id });
      }
      yield "deposit_cargo";
      await ensureDocked(ctx);
      await dumpCargo(ctx, settings);
      await bot.refreshCargo();
      const remainingCargo = bot.inventory.filter(
        i => i.quantity > 0 && !i.itemId.toLowerCase().includes("fuel") && !i.itemId.toLowerCase().includes("energy_cell")
      );
      if (remainingCargo.length > 0) {
        const itemsLeft = remainingCargo.map(i => `${i.quantity}x ${i.name}`).join(", ");
        ctx.log("error", `Cargo deposit FAILED — items still in cargo: ${itemsLeft}`);
        await ctx.sleep(5000);
        continue;
      }
      ctx.log("mining", "Cargo deposited — session complete");
      await completeMiningSession(bot.username);
      recoveredSession = null;
      continue;
    }

    // Initialize target location variables (may be set by deep core search below)
    // CRITICAL FIX: Restore target location from recovered session to prevent
    // deep core miners from losing track of hidden POIs between cycles
    let targetSystemId = recoveredSession ? recoveredSession.targetSystemId : "";
    let targetPoiId = recoveredSession ? recoveredSession.targetPoiId : "";
    let targetPoiName = recoveredSession ? recoveredSession.targetPoiName : "";

    // ── Deep core miner restriction ──
    // If the miner has deep core capability, restrict mining to deep core ores only
    // This prevents deep core miners from being assigned to mundane regular ores
    // During field_test mission, only extractor is required
    if (deepCoreCap.canMineVisibleDeepCore) {
      // If current target is not a deep core ore, search for one
      if (effectiveTarget && !isDeepCoreOre(effectiveTarget)) {
        ctx.log("mining", `Deep core miner detected — restricting to deep core ores only`);
        ctx.log("mining", `Target ${effectiveTarget} is NOT a deep core ore — searching for deep core target`);
        effectiveTarget = "";
        if (recoveredSession) {
          ctx.log("mining", "Abandoning recovered session: not a deep core ore");
          await failMiningSession(bot.username, "Not a deep core ore");
          recoveredSession = null;
        }
      } else if (effectiveTarget && isDeepCoreOre(effectiveTarget)) {
        // Check if deep core quota is met
        const settings = getMinerSettings(bot.username);
        const quotas = settings.deepCoreQuotas;
        const targetQuota = quotas[effectiveTarget];
        if (targetQuota !== undefined) {
          const current = bot.factionStorage.find(i => i.itemId === effectiveTarget)?.quantity || 0;
          const deficit = targetQuota - current;
          if (deficit <= 0) {
            ctx.log("mining", `Deep core quota met for ${effectiveTarget} (${current}/${targetQuota}) — abandoning session and searching for new target`);
            if (recoveredSession) {
              await failMiningSession(bot.username, "Deep core quota met");
              recoveredSession = null;
            }
            effectiveTarget = "";
          }
        }
      }

      // If no effective target, search for available deep core ores
      if (!effectiveTarget) {
        // During field_test mission, force exotic_matter as the target
        if (fieldTestActive) {
          ctx.log("mining", "Field test mission active - targeting exotic_matter for mission completion");
          effectiveTarget = "exotic_matter";
        } else if (settings.targetDeepCore) {
          // Global deep core target override - use this instead of quota cycling
          ctx.log("mining", `Deep core global target override: ${settings.targetDeepCore} — bypassing quota search`);
          effectiveTarget = settings.targetDeepCore;
        } else {
          ctx.log("mining", "Searching for available deep core ore targets...");
          const blacklist = getSystemBlacklist();
          let foundDeepCoreTarget = false;

          // CRITICAL FIX: When quotas are configured for deep core ores, use quota priority
          // instead of just picking the first available ore
          const deepCoreQuotas: Record<string, number> = {};
          for (const [oreId, quota] of Object.entries(quotas)) {
            if (isDeepCoreOre(oreId) && quota > 0) {
              deepCoreQuotas[oreId] = quota;
            }
          }

          let oresToCheck: string[];
          if (Object.keys(deepCoreQuotas).length > 0) {
            // Quotas exist - prioritize by deficit (biggest first)
            const quotaEntries: Array<{ oreId: string; deficit: number }> = [];
            for (const [oreId, quotaTarget] of Object.entries(deepCoreQuotas)) {
              const current = bot.factionStorage.find(i => i.itemId === oreId)?.quantity || 0;
              const deficit = quotaTarget - current;
              if (deficit > 0) {
                quotaEntries.push({ oreId, deficit });
              }
            }

            if (quotaEntries.length > 0) {
              // Sort: biggest deficit first
              quotaEntries.sort((a, b) => b.deficit - a.deficit);
              oresToCheck = quotaEntries.map(e => e.oreId);
              ctx.log("mining", `Deep core quota priority: ${oresToCheck.map((oreId, i) => `${oreId} (deficit: ${quotaEntries[i].deficit.toLocaleString()})`).join(", ")}`);
            } else {
              // All deep core quotas met - pick the one with smallest surplus (closest to deficit)
              // This ensures the miner keeps cycling through ores based on quota priorities,
              // never fully stopping mining
              const allEntries: Array<{ oreId: string; deficit: number }> = [];
              for (const [oreId, quotaTarget] of Object.entries(deepCoreQuotas)) {
                const current = bot.factionStorage.find(i => i.itemId === oreId)?.quantity || 0;
                const deficit = quotaTarget - current;
                allEntries.push({ oreId, deficit });
              }
              
              if (allEntries.length > 0) {
                // Sort by deficit descending (largest = closest to zero = smallest surplus)
                // deficit = target - current, so -211 (small surplus) > -64567 (big surplus)
                allEntries.sort((a, b) => b.deficit - a.deficit);
                const smallestSurplus = allEntries[0];
                ctx.log("mining", `All deep core quotas met - cycling to ${smallestSurplus.oreId} (smallest surplus: ${smallestSurplus.deficit.toLocaleString()})`);
                ctx.log("mining", `Current storage: ${Object.entries(deepCoreQuotas).map(([oreId, quotaTarget]) => {
                  const current = bot.factionStorage.find(i => i.itemId === oreId)?.quantity || 0;
                  return `${oreId}: ${current.toLocaleString()}/${quotaTarget.toLocaleString()}`;
                }).join(", ")}`);
                oresToCheck = [smallestSurplus.oreId];
              } else {
                // No quotas at all - wait
                ctx.log("mining", "No deep core ore quotas configured - waiting for quota setup");
                ctx.log("mining", "Configure deepCoreQuotas for deep core ores (void_essence, fury_crystal, legacy_ore, prismatic_nebulite, exotic_matter, dark_matter_residue, adamantite_ore)");
                await ctx.sleep(60000);
                continue;
              }
            }
          } else {
            // No deep core quotas configured - don't mine anything
            ctx.log("mining", "No deep core ore quotas configured - waiting for quota setup");
            ctx.log("mining", "Configure deepCoreQuotas for deep core ores (void_essence, fury_crystal, legacy_ore, prismatic_nebulite, exotic_matter, dark_matter_residue, adamantite_ore)");
            await ctx.sleep(60000);
            continue;
          }

          // Try each deep core ore to find an available target
          for (const deepCoreOre of oresToCheck) {
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
                const quotaTag = Object.keys(deepCoreQuotas).length > 0 ? " [quota priority]" : "";
                ctx.log("mining", `Found deep core target: ${deepCoreOre} @ ${chosen.poiName} in ${chosen.systemName} (${chosen.jumps} jumps)${hiddenTag} ${scanInfo}${quotaTag}`);
                foundDeepCoreTarget = true;
                break;
              }
            }
          }

          if (!foundDeepCoreTarget) {
            ctx.log("error", "No deep core ore targets found — waiting 60s before retry");
            await ctx.sleep(60000);
            continue;
          }
        }
      }
    }

    // ── Deep core ore equipment validation ──
    // If the target is a deep core ore, verify we have the proper equipment
    if (effectiveTarget && isDeepCoreOre(effectiveTarget)) {
      const deepCoreCap = await getDeepCoreCapability(ctx, fieldTestActive);
      if (!deepCoreCap.canMineVisibleDeepCore) {
        ctx.log("error", `Target ${effectiveTarget} is a deep core ore — requires deep core extractor`);
        ctx.log("error", "  Skipping deep core target — selecting alternative target");
        // Clear the target so we fall back to non-deep-core mining
        effectiveTarget = "";
        if (recoveredSession) {
          ctx.log("mining", "Abandoning recovered session due to equipment mismatch");
          await failMiningSession(bot.username, "Deep core ore — missing equipment");
          recoveredSession = null;
        }
      } else {
        if (deepCoreCap.canMineHidden) {
          ctx.log("mining", `Deep core target validated: ${effectiveTarget} (full capability - can access hidden POIs)`);
        } else {
          ctx.log("mining", `Deep core target validated: ${effectiveTarget} (limited capability - visible POIs only)`);
        }
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
        const deepCoreCap = await getDeepCoreCapability(ctx, fieldTestActive);
        if (!deepCoreCap.canMineVisibleDeepCore) {
          ctx.log("error", `Flock target ${flockTargetResource} is a deep core ore — skipping (missing equipment)`);
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
      await ctx.sleep(30000);
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
      // Check if mining deep core ore - use systemDeepCore if set
      if (effectiveTarget && isDeepCoreOre(effectiveTarget)) {
        configuredSystem = settings.systemDeepCore || settings.systemOre || settings.system || "";
      } else {
        configuredSystem = settings.systemOre || settings.systemGas || settings.systemIce || settings.system || "";
      }
    } else if (miningType === "radioactive") {
      configuredSystem = settings.systemRadioactive || settings.systemOre || settings.systemGas || settings.system || "";
    } else {
      // gas
      configuredSystem = settings.systemGas || settings.systemOre || settings.systemIce || settings.system || "";
    }

    if (configuredSystem) {
      ctx.log("mining", `Configured harvesting system for ${miningType}: ${configuredSystem}`);
    }

    if (effectiveTarget) {
      // Survey system for hidden POIs if radioactive mining with hidden capability
      if (miningType === "radioactive" && canMineHiddenRadioactive) {
        await surveySystemForHiddenPois(ctx);
      }
      const allLocations = mapStore.findOreLocations(effectiveTarget);
      // Filter to matching POI type only (skip depleted)
      const locations = allLocations.filter(loc => {
        const sys = mapStore.getSystem(loc.systemId);
        const poi = sys?.pois.find(p => p.id === loc.poiId);
        if (!poi) return true; // keep if type unknown
        if (miningType === "ore") return isOreBeltPoi(poi.type) || poi.hidden === true;
        if (miningType === "radioactive") {
          if (poi.hidden === true && !canMineHiddenRadioactive) {
            return false;
          }
          return isOreBeltPoi(poi.type) || poi.hidden === true;
        }
        if (miningType === "gas") return isGasCloudPoi(poi.type);
        if (miningType === "ice") {
          if (poi.hidden === true && !canMineHiddenIce) {
            return false;
          }
          return isIceFieldPoi(poi.type);
        }
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
        ctx.log("error", `Target ${resourceLabel} "${effectiveTarget}" not found in map — searching for alternative target`);
        // Clear session if target not found
        if (recoveredSession) {
          await failMiningSession(bot.username, "Target resource not found in map");
          recoveredSession = null;
        }
        // If we have quotas configured, try to find an alternative quota target
        if (Object.keys(quotas).length > 0) {
          const originalTarget = effectiveTarget;
          ctx.log("mining", `Target "${originalTarget}" not available — searching for first available quota target`);

          // For deep core miners, when global target fails, restrict to deep core quotas only
          // This prevents deep core miners from falling back to basic ores
          let quotaTargetsToUse = quotas;
          const fieldTestActive = await hasFieldTestMission(ctx);
          const deepCoreCap = await getDeepCoreCapability(ctx, fieldTestActive);
          if (deepCoreCap.canMineVisibleDeepCore && isDeepCoreOre(originalTarget)) {
            const deepCoreQuotas: Record<string, number> = {};
            for (const [oreId, quota] of Object.entries(quotas)) {
              if (isDeepCoreOre(oreId) && quota > 0) {
                deepCoreQuotas[oreId] = quota;
              }
            }
            quotaTargetsToUse = deepCoreQuotas;
            ctx.log("mining", `Deep core miner: restricting alternative targets to deep core ores only (${Object.keys(deepCoreQuotas).length} available)`);
          }

          const availableQuotaTarget = findFirstAvailableQuotaTarget(
            quotaTargetsToUse, bot.factionStorage, miningType, settings, mapStore, depletionTimeoutMs,
            canMineHiddenRadioactive, canMineHiddenIce
          );
          if (availableQuotaTarget && availableQuotaTarget !== originalTarget) {
            effectiveTarget = availableQuotaTarget;
            ctx.log("mining", `Switching to available quota target: "${effectiveTarget}"`);
            // Re-check locations with new target
            const newLocations = mapStore.findOreLocations(effectiveTarget).filter(loc => {
              const sys = mapStore.getSystem(loc.systemId);
              const poi = sys?.pois.find(p => p.id === loc.poiId);
              if (!poi) return true;
              if (miningType === "ore") return isOreBeltPoi(poi.type) || poi.hidden === true;
              if (miningType === "radioactive") {
                if (poi.hidden === true && !canMineHiddenRadioactive) return false;
                return isOreBeltPoi(poi.type) || poi.hidden === true;
              }
              if (miningType === "gas") return isGasCloudPoi(poi.type);
              if (miningType === "ice") {
                if (poi.hidden === true && !canMineHiddenIce) return false;
                return isIceFieldPoi(poi.type);
              }
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
              const oreEntry = poi?.ores_found.find(o => o.item_id === effectiveTarget);
              if (!oreEntry?.depleted) return true;
              return isDepletionExpired(oreEntry.depleted_at, depletionTimeoutMs);
            });
            if (newLocations.length > 0) {
              locations.push(...newLocations);
              ctx.log("mining", `Found ${newLocations.length} locations for quota target "${effectiveTarget}"`);
            }
          } else if (availableQuotaTarget === originalTarget) {
            ctx.log("mining", `Quota target "${originalTarget}" is the only available option — proceeding`);
          } else {
            ctx.log("warn", `No quota targets have available locations — mining locally without specific target`);
          }
        }
        // If still no locations, target locally (either no quotas configured or no available quota targets)
        if (locations.length === 0) {
          targetSystemId = bot.system;
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
                await failMiningSession(bot.username, `Location upgrade: ${upgradeReason}`);
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
            await startMiningSession(session);
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
        // For deep core miners, try to find a local deep core target before falling back to general local mining
        const fieldTestActive = await hasFieldTestMission(ctx);
        const deepCoreCap = await getDeepCoreCapability(ctx, fieldTestActive);
        if (deepCoreCap.canMineVisibleDeepCore && Object.keys(quotas).some(q => isDeepCoreOre(q))) {
          // Check if any deep core ores are available in the local system
          const localSystem = mapStore.getSystem(bot.system);
          if (localSystem) {
            const deepCorePois = localSystem.pois.filter(p =>
              isOreBeltPoi(p.type) || (p.hidden === true && deepCoreCap.canMineHidden)
            );
            for (const poi of deepCorePois) {
              const deepCoreOres = poi.ores_found?.filter(o =>
                isDeepCoreOre(o.item_id) &&
                !o.depleted &&
                quotas[o.item_id] > 0
              );
              if (deepCoreOres && deepCoreOres.length > 0) {
                // Found local deep core ore - set as target
                const targetOre = deepCoreOres[0];
                effectiveTarget = targetOre.item_id;
                targetSystemId = bot.system;
                ctx.log("mining", `Deep core miner: found local deep core target ${effectiveTarget} in ${bot.system} - using instead of general local mining`);
                break;
              }
            }
          }
        }

        if (!effectiveTarget) {
          ctx.log("mining", `No specific ${resourceLabel} target - mining locally in ${bot.system}`);
          targetSystemId = bot.system;
        }
      }
      // Clear any active session since we're mining without a specific target
      if (recoveredSession) {
        await completeMiningSession(bot.username);
        recoveredSession = null;
      }
    }

    // ── Field test mission: force navigation to markeb, then jump to ironpeak ──
    // During field_test mission, we may not have the survey scanner yet,
    // so we use the directional jump method to reach ironpeak hidden pockets
    if (fieldTestActive && effectiveTarget === "exotic_matter") {
      ctx.log("mining", "Field test mission: forcing navigation to markeb system");
      targetSystemId = "markeb";
      
      // Check if we're already in markeb
      if (bot.system !== "markeb") {
        ctx.log("mining", "Navigating to markeb system as waypoint before ironpeak...");
        // We'll handle this in the navigation section below
      } else {
        ctx.log("mining", "Already in markeb system - will jump to ironpeak for mining");
        // Set the target POI to ironpeak (hidden pocket)
        targetPoiId = "ironpeak";
        targetPoiName = "Ironpeak";
      }
    }

    // ── Navigate to target system if needed ──
    if (targetSystemId && targetSystemId !== bot.system) {
      yield "navigate_to_target";
      if (recoveredSession) {
        await updateMiningSession(bot.username, { state: "traveling_to_ore" });
      }

      // Flock followers wait for leader to arrive first (optional synchronization)
      if (!isFlockLeader && settings.flockEnabled && settings.flockName) {
        ctx.log("flock", "Waiting 5s for leader to jump first...");
        await ctx.sleep(5000);
      }

      // CRITICAL FIX: If rally system is configured, navigate to it first as a waypoint
      const rallySystem = flockGroup?.rallySystem;
      
      // FIELD TEST MISSION: Navigate to markeb first, then jump to ironpeak
      if (fieldTestActive && targetSystemId === "markeb") {
        ctx.log("mining", "Field test mission: navigating to markeb system...");
        const markebArrived = await navigateToSystem(ctx, "markeb", safetyOpts);
        if (markebArrived) {
          ctx.log("mining", "Arrived at markeb system - now jumping to ironpeak hidden pocket...");
          // After arriving at markeb, set target to ironpeak
          targetSystemId = "ironpeak";
          targetPoiId = "ironpeak";
          targetPoiName = "Ironpeak";
          
          // Now navigate to ironpeak
          const ironpeakArrived = await navigateToSystem(ctx, "ironpeak", safetyOpts);
          if (!ironpeakArrived) {
            ctx.log("error", "Failed to reach ironpeak from markeb — will retry next cycle");
            await ctx.sleep(30000);
            continue;
          }
          ctx.log("mining", "Successfully arrived at ironpeak - ready to mine exotic_matter");
        } else {
          ctx.log("error", "Failed to reach markeb system — will retry next cycle");
          await ctx.sleep(30000);
          continue;
        }
      } else if (rallySystem && settings.flockEnabled && settings.flockName && rallySystem !== bot.system && rallySystem !== targetSystemId) {
        ctx.log("flock", `Navigating to rally system ${rallySystem} as waypoint before mining target...`);
        const rallyArrived = await navigateToSystem(ctx, rallySystem, safetyOpts);
        if (rallyArrived) {
          ctx.log("flock", `Arrived at rally system ${rallySystem} — proceeding to mining target ${targetSystemId}`);
          // Brief pause to sync with flock members
          await ctx.sleep(2000);
        } else {
          ctx.log("error", `Failed to reach rally system ${rallySystem} — proceeding directly to mining target`);
        }
      }

      // Signal escorts before jumping
      const minerSettings = getMinerSettings(bot.username);
      if (minerSettings.escortName) {
        ctx.log("escort", `Signaling escorts to jump to ${targetSystemId}...`);
        await signalEscort(ctx, "jump", targetSystemId, minerSettings.escortSignalChannel);
        await ctx.sleep(2000); // Brief pause to let escorts read the signal
      }

      const arrived = await navigateToSystem(ctx, targetSystemId, safetyOpts);
      if (!arrived) {
        ctx.log("error", "Failed to reach target system — mining locally instead");
        targetSystemId = bot.system;
        targetPoiId = "";
        targetPoiName = "";
      }
      
      // CRITICAL FIX: Check cargo after traveling to target system (both success and failure cases)
      // If cargo is full, return home to deposit before traveling to POI
      await bot.refreshStatus();
      const postTravelFillRatio = bot.cargoMax > 0 ? bot.cargo / bot.cargoMax : 0;
      if (postTravelFillRatio >= cargoThresholdRatio) {
        ctx.log("mining", `Cargo full (${Math.round(postTravelFillRatio * 100)}%) after arriving at ${targetSystemId} — returning home to deposit before continuing`);
        
        // Find current station for refueling if needed (before we return home)
        const { pois: currentPois } = await getSystemInfo(ctx);
        const currentStation = findStation(currentPois);
        const currentStationPoi = currentStation ? { id: currentStation.id, name: currentStation.name } : null;
        
        yield "return_home";
        yield "pre_return_fuel";
        if (recoveredSession) {
          await updateMiningSession(bot.username, { state: "returning_home" });
        }
        const returnFueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
        if (!returnFueled && currentStationPoi) {
          await refuelAtStation(ctx, currentStationPoi, safetyOpts.fuelThresholdPct);
        }
        
        const homeArrived = await navigateToSystem(ctx, homeSystem, safetyOpts);
        if (!homeArrived) {
          ctx.log("error", "Failed to return to home system — will retry next cycle");
        }
        const { pois: homePois } = await getSystemInfo(ctx);
        const homeStation = findStation(homePois);
        const homeStationPoi = homeStation ? { id: homeStation.id, name: homeStation.name } : null;
        if (homeStationPoi) {
          yield "travel_to_station";
          await bot.exec("travel", { target_poi: homeStationPoi.id });
        }
        yield "deposit_cargo";
        await ensureDocked(ctx);
        await dumpCargo(ctx, settings);
        await bot.refreshCargo();
        const remainingCargo = bot.inventory.filter(i => i.quantity > 0 && !i.itemId.toLowerCase().includes("fuel") && !i.itemId.toLowerCase().includes("energy_cell"));
        if (remainingCargo.length > 0) {
          const itemsLeft = remainingCargo.map(i => `${i.quantity}x ${i.name}`).join(", ");
          ctx.log("error", `Cargo deposit FAILED — items still in cargo: ${itemsLeft}`);
          await ctx.sleep(5000);
          continue;
        }
        ctx.log("mining", "Cargo deposited — restarting mining cycle");
        continue;
      }

      // Only do post-arrival processing if we successfully arrived
      if (arrived) {
        // CRITICAL FIX: Re-validate deep core equipment after jump timeout failure.
        // Jump timeouts can leave the bot in an inconsistent state where equipment
        // detection may have failed. Re-check and re-apply deep core restrictions.
        if (effectiveTarget && isDeepCoreOre(effectiveTarget)) {
          ctx.log("mining", "Re-validating deep core equipment after jump failure...");
          const deepCoreCapRecheck = await getDeepCoreCapability(ctx, fieldTestActive);
          if (!deepCoreCapRecheck.canMineVisibleDeepCore) {
            ctx.log("error", "Deep core equipment not detected after jump failure — cannot mine deep core ore");
            ctx.log("error", "  Clearing deep core target to prevent mining wrong ore type");
            effectiveTarget = "";
            if (recoveredSession) {
              ctx.log("mining", "Abandoning recovered session: equipment lost after jump timeout");
              await failMiningSession(bot.username, "Deep core equipment lost after jump timeout");
              recoveredSession = null;
            }
          } else {
            ctx.log("mining", "Deep core equipment re-validated after jump failure");
          }
        }
        
        if (recoveredSession) {
          await updateMiningSession(bot.username, { state: "mining" });
        }

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
    // Survey for hidden POIs if radioactive mining with capability
    if (miningType === "radioactive" && canMineHiddenRadioactive) {
      await surveySystemForHiddenPois(ctx);
    }
    yield (miningType === "ice" ? "find_ice_field" : (miningType === "ore" || miningType === "radioactive" ? "find_ore_belt" : "find_gas_cloud"));
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
      } else if (effectiveTarget && isDeepCoreOre(effectiveTarget) && deepCoreCap.canMineHidden) {
        // Deep core ore hidden POI not visible in system POI list — use map store
        // (unrelated to radioactive mining - deep core uses separate equipment check)
        const sysData = mapStore.getSystem(bot.system);
        const storedPoi = sysData?.pois.find(p => p.id === targetPoiId);
        if (storedPoi) {
          miningPoi = { id: storedPoi.id, name: storedPoi.name };
          ctx.log("mining", `Using known deep core POI from map: ${storedPoi.name} (${storedPoi.hidden ? "hidden" : "visible"})`);
        }
        } else if (!deepCoreCap.canMineHidden) {
          // Miner without full deep core capability cannot use hidden POIs
          // Skip this - miner doesn't have the required modules
        }
    }

    // If no specific POI targeted, find the best one for our mining type
    if (!miningPoi) {
      const allowHiddenPois = miningType === "radioactive" ? canMineHiddenRadioactive : (miningType === "ice" ? canMineHiddenIce : false);
      miningPoi = findMiningPoi(pois, miningType, effectiveTarget, allowHiddenPois);
      if (!miningPoi && effectiveTarget) {
        // Fallback to any suitable POI if specific target not found
        miningPoi = findMiningPoi(pois, miningType, undefined, allowHiddenPois);
      }
    }

    // No fallback to any POI type - if target resource not found, search for alternatives
    // This prevents miners from traveling to POIs that don't have the right resources
    if (!miningPoi) {
      // For deep core miners, wait for next cycle to retry target
      if (effectiveTarget && isDeepCoreOre(effectiveTarget)) {
        ctx.log("mining", `Deep core miner: ${effectiveTarget} not found in current system — waiting for next cycle to retry target`);
        await ctx.sleep(30000);
        continue;
      }
      
      // For other miners, log and wait - will search for new target in next cycle
      ctx.log("mining", `No ${resourceLabel} POI with target resource '${effectiveTarget}' found in current system — searching for alternatives`);
      await ctx.sleep(10000);
      continue;
    }

    // For mining with deep core capability: check map store for known hidden POIs
    // not yet visible in the system POI list
    if (!miningPoi && deepCoreCap.canMineHidden && effectiveTarget) {
      const sysData = mapStore.getSystem(bot.system);
      for (const storedPoi of (sysData?.pois || [])) {
        if (!storedPoi.hidden) continue;
        const oreEntry = storedPoi.ores_found?.find(o => o.item_id === effectiveTarget);
        if (!oreEntry) continue;
        // Check depletion
        if (oreEntry.depleted && !isDepletionExpired(oreEntry.depleted_at, depletionTimeoutMs)) continue;
        // Found a known hidden POI with the target resource
        miningPoi = { id: storedPoi.id, name: storedPoi.name };
        ctx.log("mining", `Using known hidden POI from map: ${storedPoi.name} (${effectiveTarget})`);
        break;
      }
    }

    // For deep core ore mining: check map store for known deep core POIs
    // not yet visible in the system POI list
    if (!miningPoi && effectiveTarget && isDeepCoreOre(effectiveTarget) && deepCoreCap.canMineHidden) {
      const sysData = mapStore.getSystem(bot.system);
      for (const storedPoi of (sysData?.pois || [])) {
        const oreEntry = storedPoi.ores_found?.find(o => o.item_id === effectiveTarget);
        if (!oreEntry) continue;
        // Check depletion
        if (oreEntry.depleted && !isDepletionExpired(oreEntry.depleted_at, depletionTimeoutMs)) continue;
        // Found a known deep core POI with the target resource
        miningPoi = { id: storedPoi.id, name: storedPoi.name };
        ctx.log("mining", `Using known deep core POI from map: ${storedPoi.name} (${effectiveTarget})`);
        break;
      }
    }

    if (!miningPoi) {
      ctx.log("error", `No ${resourceLabel} field/cloud found in this system — waiting 30s before retry`);
      await ctx.sleep(30000);
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

          // If this is a hidden POI and get_poi succeeded, mark it as discovered
          // so we can skip the travel step (which would fail for hidden POIs)
          const isHidden = poiData.hidden as boolean | undefined;
          if (isHidden && (!bot.poi || bot.poi !== miningPoi.id)) {
            bot.poi = miningPoi.id;
            ctx.log("mining", `Hidden POI ${miningPoi.name} discovered via pre-scan — travel step skipped`);
          }
        } else {
          mapStore.updatePoiResources(bot.system, miningPoi.id, resourceData);
        }

        // Check if target resource is still available
        if (effectiveTarget) {
          const targetResource = scanResources.find(r => (r.resource_id as string) === effectiveTarget);
          const remaining = (targetResource?.remaining as number) ?? 0;
          const maxRemaining = (targetResource?.max_remaining as number) ?? 0;
          
          // CRITICAL FIX: Only mark depleted if we have CONFIRMED evidence of 0 remaining
          // AND the max_remaining was previously > 0 (proves it was actually mined/scanned)
          // This prevents false depletion markers from POIs that were never properly checked
          if (remaining <= 0 && maxRemaining > 0) {
            // Double-check: verify this isn't a stale/incorrect reading
            // by checking if we have any prior map data for this POI
            const sysData = mapStore.getSystem(bot.system);
            const existingPoi = sysData?.pois.find(p => p.id === miningPoi!.id);
            const existingOreEntry = existingPoi?.ores_found.find(o => o.item_id === effectiveTarget);

            // If we have prior evidence this POI had resources, mark it depleted
            // Otherwise, log a warning and don't mark it (prevents false positives)
            if (existingOreEntry || maxRemaining > 0) {
              ctx.log("mining", `Pre-scan: ${effectiveTarget} depleted at ${miningPoi!.name} (${remaining}/${maxRemaining}) — marking depleted and searching for alternative`);
              mapStore.markOreDepleted(bot.system, miningPoi!.id, effectiveTarget);
              // Don't travel here — fall through to depletion handling below
              miningPoi = null;
            } else {
              ctx.log("warn", `Pre-scan: ${effectiveTarget} shows 0 remaining at ${miningPoi!.name} but no prior mining history — NOT marking depleted (may be unscanned POI)`);
            }
          } else if (remaining > 0) {
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
              if (miningType === "radioactive") return canMineBasicRadioactive && (
                isOreBeltPoi(p.type) ||
                (!p.hidden && canMineDeepCoreRadioactive) ||
                (p.hidden && canMineHiddenRadioactive)
              );
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
                if (miningType === "radioactive") return canMineBasicRadioactive && (
                  isOreBeltPoi(poi?.type || "") ||
                  (!poi?.hidden && canMineDeepCoreRadioactive) ||
                  (poi?.hidden && canMineHiddenRadioactive)
                );
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
            
            // CRITICAL FIX: Check cargo before traveling to alternative POI after depletion
            await bot.refreshStatus();
            const altFillRatio = bot.cargoMax > 0 ? bot.cargo / bot.cargoMax : 0;
            if (altFillRatio >= cargoThresholdRatio) {
              ctx.log("mining", `Cargo full (${Math.round(altFillRatio * 100)}%) — returning home to deposit before traveling to alternative POI`);
              yield "return_home";
              yield "pre_return_fuel";
              if (recoveredSession) {
                await updateMiningSession(bot.username, { state: "returning_home" });
              }
              const returnFueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
              if (!returnFueled && stationPoi) {
                await refuelAtStation(ctx, stationPoi, safetyOpts.fuelThresholdPct);
              }
              const homeArrived = await navigateToSystem(ctx, homeSystem, safetyOpts);
              if (!homeArrived) {
                ctx.log("error", "Failed to return to home system — will retry next cycle");
              }
              const { pois: homePois } = await getSystemInfo(ctx);
              const homeStation = findStation(homePois);
              stationPoi = homeStation ? { id: homeStation.id, name: homeStation.name } : null;
              if (stationPoi) {
                yield "travel_to_station";
                await bot.exec("travel", { target_poi: stationPoi.id });
              }
              yield "deposit_cargo";
              await ensureDocked(ctx);
              await dumpCargo(ctx, settings);
              await bot.refreshCargo();
              const remainingCargo = bot.inventory.filter(i => i.quantity > 0 && !i.itemId.toLowerCase().includes("fuel") && !i.itemId.toLowerCase().includes("energy_cell"));
              if (remainingCargo.length > 0) {
                const itemsLeft = remainingCargo.map(i => `${i.quantity}x ${i.name}`).join(", ");
                ctx.log("error", `Cargo deposit FAILED — items still in cargo: ${itemsLeft}`);
                await ctx.sleep(5000);
                continue;
              }
              ctx.log("mining", "Cargo deposited — restarting mining cycle");
              continue;
            }
            
            const arrived = await navigateToSystem(ctx, chosen.systemId, safetyOpts);
            if (arrived) {
              // Refresh pois list for new system and retry travel
              const { pois: newPois } = await getSystemInfo(ctx);
              pois = newPois;
              bot.system = chosen.systemId;
              const newMiningPoi = pois.find(p => {
                if (miningType === "ore") return isOreBeltPoi(p.type) || p.hidden === true;
        if (miningType === "radioactive") return canMineBasicRadioactive && (
          isOreBeltPoi(p.type) ||
          (!p.hidden && canMineDeepCoreRadioactive) ||
          (p.hidden && canMineHiddenRadioactive)
        );
                if (miningType === "gas") return isGasCloudPoi(p.type);
                if (miningType === "ice") return isIceFieldPoi(p.type);
                return false;
              });
               if (newMiningPoi) {
                 miningPoi = { id: newMiningPoi.id, name: newMiningPoi.name };
                 ctx.log("mining", `Will travel to ${newMiningPoi.name}`);
               } else {
                 ctx.log("error", `No suitable ${resourceLabel} POI found in ${chosen.systemName} — clearing target and returning home to retry next cycle`);
                 effectiveTarget = "";
                 targetResource = "";
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
             ctx.log("error", `No alternative ${resourceLabel} within ${maxJumps} jumps — clearing target and returning home to retry next cycle`);
             effectiveTarget = "";
             targetResource = "";
             await ensureUndocked(ctx);
            const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
            if (fueled) await navigateToSystem(ctx, homeSystem, safetyOpts);
            await ensureDocked(ctx);
            await dumpCargo(ctx, settings);
            continue;
          }
         } else {
           ctx.log("error", `No alternative ${resourceLabel} found anywhere — clearing target and returning home to retry next cycle`);
           effectiveTarget = "";
           targetResource = "";
           await ensureUndocked(ctx);
          const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
          if (fueled) await navigateToSystem(ctx, homeSystem, safetyOpts);
          await ensureDocked(ctx);
          await dumpCargo(ctx, settings);
          continue;
        }
      }
    }

    // miningPoi is guaranteed non-null here after the depletion check
    if (!miningPoi) continue;

    // ── Travel to mining location ──
    yield (miningType === "ice" ? "travel_to_ice_field" : (miningType === "ore" || miningType === "radioactive" ? "travel_to_belt" : "travel_to_cloud"));
    
    // CRITICAL FIX: Check cargo capacity BEFORE traveling to POI
    // If cargo is full, return home to deposit first
    await bot.refreshStatus();
    const travelFillRatio = bot.cargoMax > 0 ? bot.cargo / bot.cargoMax : 0;
    if (travelFillRatio >= cargoThresholdRatio) {
      ctx.log("mining", `Cargo full (${Math.round(travelFillRatio * 100)}%) — returning home to deposit before traveling to POI`);
      yield "return_home";
      yield "pre_return_fuel";
      if (recoveredSession) {
        await updateMiningSession(bot.username, { state: "returning_home" });
      }
      const returnFueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
      if (!returnFueled && stationPoi) {
        await refuelAtStation(ctx, stationPoi, safetyOpts.fuelThresholdPct);
      }
      const homeArrived = await navigateToSystem(ctx, homeSystem, safetyOpts);
      if (!homeArrived) {
        ctx.log("error", "Failed to return to home system — will retry next cycle");
      }
      // Get station at home and deposit
      const { pois: homePois } = await getSystemInfo(ctx);
      const homeStation = findStation(homePois);
      stationPoi = homeStation ? { id: homeStation.id, name: homeStation.name } : null;
      if (stationPoi) {
        yield "travel_to_station";
        await bot.exec("travel", { target_poi: stationPoi.id });
      }
      yield "deposit_cargo";
      await ensureDocked(ctx);
      await dumpCargo(ctx, settings);
      await bot.refreshCargo();
      const remainingCargo = bot.inventory.filter(i => i.quantity > 0 && !i.itemId.toLowerCase().includes("fuel") && !i.itemId.toLowerCase().includes("energy_cell"));
      if (remainingCargo.length > 0) {
        const itemsLeft = remainingCargo.map(i => `${i.quantity}x ${i.name}`).join(", ");
        ctx.log("error", `Cargo deposit FAILED — items still in cargo: ${itemsLeft}`);
        await ctx.sleep(5000);
        continue;
      }
      ctx.log("mining", "Cargo deposited — restarting mining cycle");
      continue;
    }

    // Check if this is a hidden POI (need to survey before traveling if not yet discovered)
    const sysData = mapStore.getSystem(bot.system);
    const poiData = sysData?.pois.find(p => p.id === miningPoi!.id);
    const isHiddenPoi = poiData?.hidden ?? false;

    // CRITICAL: For DEEP CORE hidden POIs, we MUST use travel command to get there
    // get_poi alone is NOT sufficient - it may return data from wherever we actually are
    // Always try travel first for hidden POIs to ensure we're actually at the right location
    if (isHiddenPoi) {
      ctx.log("mining", `Hidden POI ${miningPoi.name} detected — MUST travel to verify actual location`);
    }

    // For hidden POIs: ALWAYS use travel command (not just get_poi) to confirm we're actually at the location
    // CRITICAL: Refresh status FIRST to get actual current location - don't trust cached bot.poi
    await bot.refreshStatus();
    const actualPoi = bot.poi || "";
    ctx.log("mining", `Current actual location before travel: ${actualPoi || "(none)"}`);
    if (!bot.poi || bot.poi !== miningPoi.id) {
      // Use the new travel function that handles hidden POI discovery
      const travelResult = await travelToPoiWithSurvey(ctx, miningPoi.id, miningPoi.name, isHiddenPoi);

      if (!travelResult.success) {
        ctx.log("error", `Travel to mining location failed: ${travelResult.error}`);

        // Additional verification for hidden POIs: run a system survey to confirm POI exists
        if (isHiddenPoi) {
          ctx.log("mining", `Running system survey to verify hidden POI ${miningPoi.name} exists...`);
          const surveySuccess = await surveySystemForHiddenPois(ctx);
          if (surveySuccess) {
            // After survey, verify we can now travel to the POI
            ctx.log("mining", `Retrying travel to ${miningPoi.name} after survey...`);
            const retryResp = await bot.exec("travel", { target_poi: miningPoi.id });
            if (!retryResp.error || retryResp.error.message.includes("already")) {
              bot.poi = miningPoi.id;
              ctx.log("mining", `Successfully traveled to hidden POI ${miningPoi.name} after verification survey`);
            } else {
              ctx.log("error", `Still cannot access hidden POI after survey: ${retryResp.error.message}`);
            }
          }
        }

        // For hidden POIs: if we're in the system where the POI should be but can't travel to it,
        // it may require a directional jump. Try leaving and coming back.
        if (isHiddenPoi) {
          ctx.log("mining", `Hidden POI may require directional access — trying to leave and re-enter system`);
          const homeSys = bot.system; // Save current system before traveling out
          // Get connected systems to try
          const currentSysData = mapStore.getSystem(homeSys);
          const connections = currentSysData?.connections || [];
          if (connections.length > 0) {
            // Try traveling to first connected system and back
            const firstConn = connections[0];
            const targetSysName = firstConn.system_name || firstConn.system_id || "unknown";
            ctx.log("mining", `Traveling to connected system ${targetSysName} then back...`);
            const outResp = await bot.exec("travel", { target_system: firstConn.system_id });
            if (!outResp.error) {
              ctx.log("mining", `Traveled to ${targetSysName} — returning to ${homeSys}`);
              await ctx.sleep(3000);
              const backResp = await bot.exec("travel", { target_system: homeSys });
              if (!backResp.error) {
                bot.system = homeSys;
                ctx.log("mining", `Returned to ${homeSys} — retrying POI discovery`);
                await ctx.sleep(3000);
                // Try get_poi again after re-entering
                const retryDiscover = await bot.exec("get_poi", { poi_id: miningPoi.id });
                if (!retryDiscover.error && retryDiscover.result) {
                  ctx.log("mining", `Discovered hidden POI ${miningPoi.name} after directional approach`);
                  bot.poi = miningPoi.id;
                } else {
                  ctx.log("error", `Still cannot access hidden POI after directional approach: ${retryDiscover.error?.message || "unknown"}`);
                }
              } else {
                ctx.log("error", `Failed to return to ${homeSys}: ${backResp.error.message}`);
                // Navigate back using normal navigation
                await navigateToSystem(ctx, homeSys, safetyOpts);
              }
            } else {
              ctx.log("error", `Failed to travel to ${targetSysName}: ${outResp.error.message}`);
            }
          } else {
            ctx.log("warn", `No connected systems known for ${homeSys} — cannot attempt directional approach`);
          }
        }

        if (!bot.poi || bot.poi !== miningPoi.id) {
          await ctx.sleep(5000);
          continue;
        }
      }
    }

    // Check for pirates at mining location
    const nearbyResp = await bot.exec("get_nearby");

    // Check for battle notifications in get_nearby response
    if (nearbyResp.notifications && Array.isArray(nearbyResp.notifications)) {
      const battleDetected = await handleBattleNotifications(ctx, nearbyResp.notifications, battleState);
      if (battleDetected) {
        ctx.log("error", "Battle detected at mining location - fleeing!");
        await ctx.sleep(30000);
        continue;
      }
    }

    // Also check battle status directly (in case we missed notifications)
    // CRITICAL: Check WebSocket state FIRST for fastest detection
    if (bot.isInBattle()) {
      ctx.log("combat", `Direct battle check [WebSocket]: IN BATTLE! - checking engagement...`);

      // Check for nearby players to decide if we should engage
      const nearbyResp = await bot.exec("get_nearby");
      if (nearbyResp.result && typeof nearbyResp.result === "object") {
        const { parseNearbyEntities } = await import("./common.js");
        const nearbyResult = parseNearbyEntities(nearbyResp.result);

        if (nearbyResult.hasPlayers) {
          const shouldFight = await shouldEngagePlayersInCombat(ctx, nearbyResult.players);
          if (shouldFight) {
            ctx.log("combat", "Decided to ENGAGE attacking players in combat!");
            battleState.inBattle = true;
            battleState.isFleeing = false;
            await engageInBattle(ctx);
            await ctx.sleep(30000);
            continue;
          }
        }
      }

      // Default: flee if we can't determine attackers or shouldn't fight
      ctx.log("combat", "Not engaging - fleeing from battle!");
      await fleeFromBattle(ctx, true, 35000);
      ctx.log("error", "Battle detected via WebSocket - fled, will retry mining");
      await ctx.sleep(30000);
      continue;
    }

    const directBattleStatus = await getBattleStatus(ctx);
    if (directBattleStatus && directBattleStatus.is_participant) {
      ctx.log("combat", `Direct battle status check: IN BATTLE (ID: ${directBattleStatus.battle_id}) - checking engagement...`);

      // Check for nearby players to decide if we should engage
      const nearbyResp2 = await bot.exec("get_nearby");
      if (nearbyResp2.result && typeof nearbyResp2.result === "object") {
        const { parseNearbyEntities } = await import("./common.js");
        const nearbyResult2 = parseNearbyEntities(nearbyResp2.result);

        if (nearbyResult2.hasPlayers) {
          const shouldFight2 = await shouldEngagePlayersInCombat(ctx, nearbyResult2.players);
          if (shouldFight2) {
            ctx.log("combat", "Decided to ENGAGE attacking players in combat!");
            battleState.inBattle = true;
            battleState.battleId = directBattleStatus.battle_id;
            battleState.isFleeing = false;
            await engageInBattle(ctx);
            await ctx.sleep(30000);
            continue;
          }
        }
      }

      // Default: flee if we can't determine attackers or shouldn't fight
      ctx.log("combat", "Not engaging - fleeing from battle!");
      await fleeFromBattle(ctx, true, 35000);
      ctx.log("error", "Battle detected via status check - fled, will retry mining");
      await ctx.sleep(30000);
      continue;
    }

    if (nearbyResp.result && typeof nearbyResp.result === "object") {
      const { checkAndFleeFromPirates } = await import("./common.js");
      const fled = await checkAndFleeFromPirates(ctx, nearbyResp.result);
      if (fled) {
        ctx.log("error", "Pirates detected - fled mining location, will retry");
        await ctx.sleep(30000);
        continue;
      }
    }

    // CRITICAL FIX: Verify we're at the intended hidden POI before mining
    // This prevents deep core miners from mining at the wrong location (e.g., Ross 128 Belt instead of Rainbow Nebulite Vein)
    if (effectiveTarget && isDeepCoreOre(effectiveTarget) && targetPoiId) {
      const currentPoi = bot.poi || "";
      const intendedPoi = targetPoiId;
      
      // CRITICAL: This check runs BEFORE mining - verify actual location, not trust cached bot.poi
      // We MUST refresh status to get the ACTUAL current POI from the server
      await bot.refreshStatus();
      const realCurrentPoi = bot.poi || "";
      
      if (realCurrentPoi !== intendedPoi) {
        ctx.log("mining", `DEEP CORE VERIFICATION FAILURE: actually at ${realCurrentPoi || "none"}, intended: ${intendedPoi} — fixing...`);
        
        // MUST travel to the correct hidden POI
        const verifyTravel = await travelToPoiWithSurvey(ctx, intendedPoi, targetPoiName || intendedPoi, true);
        
        // Verify AGAIN after travel - refresh status to get actual location
        await bot.refreshStatus();
        const afterTravelPoi = bot.poi || "";
        
        if (afterTravelPoi !== intendedPoi) {
          ctx.log("error", `Travel claimed success but location wrong: at ${afterTravelPoi}, expected ${intendedPoi}`);
          
          // Try one more travel as last resort
          const lastTravel = await bot.exec("travel", { target_poi: intendedPoi });
          await bot.refreshStatus();
          const finalPoi = bot.poi || "";
          
          if (finalPoi === intendedPoi) {
            ctx.log("mining", `Deep core verification: CORRECTED via forced travel to ${targetPoiName}`);
          } else {
            ctx.log("error", `CRITICAL: Cannot reach hidden POI ${targetPoiName}. At ${finalPoi}, expected ${intendedPoi}`);
            // Abort mining - we're at the wrong place
            ctx.log("error", "Aborting deep core mining - cannot reach correct hidden POI");
            await ctx.sleep(30000);
            continue;
          }
        } else {
          ctx.log("mining", `Deep core verification: FIXED, now at ${targetPoiName}`);
        }
      } else {
        ctx.log("mining", `Deep core verification: confirmed at intended POI ${targetPoiName}`);
      }
      
      // CRITICAL: Verify the POI actually contains the target resource before mining
      // This prevents mining wrong ores at a mis-identified hidden POI
      const poiScanResp = await bot.exec("get_poi", { poi_id: targetPoiId });
      if (!poiScanResp.error && poiScanResp.result) {
        const scanData = poiScanResp.result as Record<string, unknown>;
        const poiResources = Array.isArray(scanData.resources) ? scanData.resources : [];
        const hasTargetResource = poiResources.some((r: any) => r.resource_id === effectiveTarget);
        
        if (!hasTargetResource) {
          ctx.log("error", `Deep core resource mismatch: POI ${targetPoiName} does not contain ${effectiveTarget}! Found: ${poiResources.map((r: any) => r.resource_id).join(", ")}`);
          ctx.log("error", "Target POI mismatch - re-scanning to find correct hidden POI...");
          
          // Re-scan the system to find the correct hidden POI with the target resource
          const sysData = mapStore.getSystem(bot.system);
          for (const storedPoi of (sysData?.pois || [])) {
            if (!storedPoi.hidden) continue;
            const oreEntry = storedPoi.ores_found?.find(o => o.item_id === effectiveTarget);
            if (!oreEntry) continue;
            
            // Found a POI with the target resource - try to travel there
            ctx.log("mining", `Found correct POI: ${storedPoi.name} contains ${effectiveTarget} - traveling...`);
            const correctTrav = await travelToPoiWithSurvey(ctx, storedPoi.id, storedPoi.name, true);
            if (correctTrav.success) {
              targetPoiId = storedPoi.id;
              targetPoiName = storedPoi.name;
              miningPoi = { id: storedPoi.id, name: storedPoi.name };
              ctx.log("mining", `Corrected: now at ${targetPoiName} for ${effectiveTarget}`);
              break;
            }
          }
        } else {
          ctx.log("mining", `Resource verified: ${targetPoiName} contains ${effectiveTarget} ✓`);
        }
      }
    }

    // Update session state to mining
    if (recoveredSession) {
      await updateMiningSession(bot.username, {
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

    // ── CRITICAL FIX: Verify target resource is available at current POI before mining ──
    // This prevents mining at depleted POIs that cause endless equipment errors
    if (effectiveTarget && bot.poi) {
      const poiCheckResp = await bot.exec("get_poi", { poi_id: bot.poi });
      if (!poiCheckResp.error && poiCheckResp.result) {
        const poiData = poiCheckResp.result as Record<string, unknown>;
        const resources = Array.isArray(poiData.resources)
          ? (poiData.resources as Array<Record<string, unknown>>)
          : Array.isArray(poiData.resources)
          ? poiData.resources
          : [];

        let targetAvailable = false;
        let targetRemaining = 0;

        for (const res of resources) {
          const resId = (res.resource_id as string) || (res.id as string) || "";
          const remaining = (res.remaining as number) ?? (res.quantity as number) ?? 0;
          const maxRemaining = (res.max_remaining as number) ?? 0;

          if (resId === effectiveTarget) {
            targetRemaining = remaining;
            // Resource is available if it has remaining > 0
            targetAvailable = remaining > 0 && maxRemaining > 0;
            break;
          }
        }

        if (!targetAvailable) {
          ctx.log("mining", `Target resource ${effectiveTarget} not available at ${miningPoi?.name || bot.poi} (remaining: ${targetRemaining})`);

          // Mark as depleted if it was actually depleted (not just temporarily unavailable)
          if (targetRemaining <= 0) {
            mapStore.markOreDepleted(bot.system, bot.poi, effectiveTarget);
            ctx.log("mining", `Marked ${effectiveTarget} as depleted at ${bot.poi}`);
          }

          // For strip miners, try to switch to another available common ore
          let switchedTarget = false;
          if (usingStripMiner && targetRemaining <= 0) {
            const availableCommonOres = resources
              .map(res => ({
                id: (res.resource_id as string) || (res.id as string) || "",
                remaining: (res.remaining as number) ?? (res.quantity as number) ?? 0
              }))
              .filter(ore => ore.remaining > 0 && isStripMinerOre(ore.id));

            if (availableCommonOres.length > 0) {
              const newTarget = availableCommonOres[0].id;
              ctx.log("mining", `Strip miner: switching from depleted ${effectiveTarget} to available ${newTarget}`);
              effectiveTarget = newTarget;
              switchedTarget = true;
            }
          }

          if (!switchedTarget) {
            // No alternative available - this POI is depleted for our target
            ctx.log("mining", `POI ${miningPoi?.name || bot.poi} depleted for ${effectiveTarget} — will search for new target next cycle`);
            await ctx.sleep(5000);
            continue; // Skip mining, go back to target selection
          }
        } else {
          ctx.log("mining", `Resource check passed: ${effectiveTarget} available (remaining: ${targetRemaining})`);
        }
      } else {
        ctx.log("warn", `Failed to check POI resources: ${poiCheckResp.error?.message || "unknown error"}`);
        // Continue anyway - don't block mining on verification failure
      }
    }

    // ── Harvest loop: mine until cargo threshold ──
    yield "harvest_loop";
    let harvestCycles = 0;
    let stopReason = "";
    const resourcesMinedMap = new Map<string, number>();
    let lastPoiCheck = 0;
    let lastBattleCheck = 0;
    let miningErrorCount = 0; // Track consecutive mining errors for retry logic
    const POI_CHECK_INTERVAL_MS = 600_000; // Check POI remaining every 10 minutes
    const BATTLE_CHECK_INTERVAL_MS = 8_000; // Check battle status every 8 seconds (< 1 game tick)

    while (bot.state === "running") {
      await bot.refreshStatus();

      const midHull = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
      if (midHull <= 40) { stopReason = `hull critical (${midHull}%)`; break; }

      const midFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
      if (midFuel < safetyOpts.fuelThresholdPct) { stopReason = `fuel low (${midFuel}%)`; break; }

      // Periodic battle status check (backup detection in case notifications fail)
      // CRITICAL: Check WebSocket state FIRST for fastest detection (no API call needed)
      // FIX: Check EVERY cycle, not just every 8 seconds!
      if (bot.isInBattle()) {
        const now = Date.now();
        const timeSinceLastFlee = battleState.lastFleeTime ? now - battleState.lastFleeTime : Infinity;
        if (timeSinceLastFlee > 10000) { // Only issue if more than 10 seconds since last flee
          ctx.log("combat", `PERIODIC CHECK: IN BATTLE! - initiating IMMEDIATE flee!`);
          battleState.inBattle = true;
          battleState.isFleeing = false;

          // Issue flee stance and return immediately - DON'T wait for disengage!
          // The harvest loop below will re-issue flee every cycle
          await bot.exec("battle", { action: "stance", stance: "flee" });
          battleState.lastFleeTime = now;
          ctx.log("combat", "Flee stance issued - will re-issue every cycle until disengaged!");
          // Continue to the battle handling code below (lines 3290-3309)
        }
      }

      // Also check via API periodically (fallback)
      const now = Date.now();
      if (!battleState.inBattle && (now - lastBattleCheck) > BATTLE_CHECK_INTERVAL_MS) {
        lastBattleCheck = now;

        const battleStatusCheck = await getBattleStatus(ctx);
        if (battleStatusCheck && battleStatusCheck.is_participant) {
          const now = Date.now();
          const timeSinceLastFlee = battleState.lastFleeTime ? now - battleState.lastFleeTime : Infinity;
          if (timeSinceLastFlee > 10000) { // Only issue if more than 10 seconds since last flee
            ctx.log("combat", `PERIODIC CHECK: IN BATTLE! Battle ID: ${battleStatusCheck.battle_id} - initiating IMMEDIATE flee!`);
            battleState.inBattle = true;
            battleState.battleId = battleStatusCheck.battle_id;
            battleState.isFleeing = false;

            // Issue flee stance and return immediately - DON'T wait for disengage!
            await bot.exec("battle", { action: "stance", stance: "flee" });
            battleState.lastFleeTime = now;
            ctx.log("combat", "Flee stance issued via API check - will re-issue every cycle until disengaged!");
          }
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
          stopReason = "battle escaped successfully";
          break;
        }
        // Still in battle - continue to next cycle
        await ctx.sleep(2000); // Brief pause before next check
        continue;
      }

      // Periodically check POI to see if resource is depleted (remaining: 0)
      // DEEP CORE FIX: This check also ensures deep core miners stay on deep core tasks
      // RICHNESS CHECK: Also check for significantly better POIs periodically
      if (effectiveTarget && bot.poi && !settings.ignoreDepletion &&
          (now - lastPoiCheck) > POI_CHECK_INTERVAL_MS) {
        lastPoiCheck = now;

        // DEEP CORE GUARD: Verify we're still mining a deep core ore if we have deep core equipment
        const deepCoreCap = await getDeepCoreCapability(ctx, fieldTestActive);
        if (deepCoreCap.canMineVisibleDeepCore && isDeepCoreOre(effectiveTarget)) {
          ctx.log("mining", `Deep core guard check: confirming still on deep core task (${effectiveTarget})`);
        } else if (deepCoreCap.canMineVisibleDeepCore && !isDeepCoreOre(effectiveTarget)) {
          ctx.log("warn", `Deep core miner is NOT on a deep core target! Current target: ${effectiveTarget} — this should not happen, will re-select target`);
          // Force re-selection of target on next cycle
          targetResource = "";
          continue;
        }

        // ── RICHNESS UPGRADE CHECK ──
        // Check if there's a significantly better POI available (not just depleted check)
        // This prevents miners from staying at very low richness POIs indefinitely
        const blacklist = getSystemBlacklist();
        const currentSys = mapStore.getSystem(bot.system);
        const currentPoi = currentSys?.pois.find(p => p.id === bot.poi);
        
        // Get current POI resource data from stored resources (has richness/remaining)
        const currentPoiObj = currentPoi as unknown as Record<string, unknown> | undefined;
        const currentPoiResources = currentPoiObj?.resources as Array<Record<string, unknown>> | undefined;
        const currentResourceData = currentPoiResources?.find(r => (r.resource_id as string) === effectiveTarget);
        const currentRichness = (currentResourceData?.richness as number) ?? 0;
        const currentRemaining = (currentResourceData?.remaining as number) ?? 0;

        // Only search for upgrades if current POI is 100% depleted
        const maxRemaining = (currentResourceData?.max_remaining as number) ?? 0;
        const depletionPercent = maxRemaining > 0 ? currentRemaining / maxRemaining : 1;

        const shouldSearchForUpgrade = depletionPercent <= 0; // 100% depleted

        if (shouldSearchForUpgrade) {
          ctx.log("mining", `Richness check: current POI has richness ${currentRichness}, ${((1 - depletionPercent) * 100).toFixed(1)}% depleted — searching for better options...`);

          // Find best available POI for this resource
          const allLocations = mapStore.findOreLocations(effectiveTarget).filter(loc => {
            if (loc.poiId === bot.poi && loc.systemId === bot.system) return false; // Skip current POI
            const sys = mapStore.getSystem(loc.systemId);
            const poi = sys?.pois.find(p => p.id === loc.poiId);
            if (miningType === "ore") return isOreBeltPoi(poi?.type || "");
              if (miningType === "radioactive") return canMineBasicRadioactive && (
                isOreBeltPoi(poi?.type || "") ||
                (!poi?.hidden && canMineDeepCoreRadioactive) ||
                (poi?.hidden && canMineHiddenRadioactive)
              );
            if (miningType === "gas") return isGasCloudPoi(poi?.type || "");
            if (miningType === "ice") return isIceFieldPoi(poi?.type || "");
            return true;
          }).filter(loc => {
            const sys = mapStore.getSystem(loc.systemId);
            const poi = sys?.pois.find(p => p.id === loc.poiId);
            const oreEntry = poi?.ores_found.find(o => o.item_id === effectiveTarget);
            if (!oreEntry?.depleted) return true;
            if (settings.ignoreDepletion) {
              if (loc.remaining !== undefined && loc.remaining <= 0 && loc.maxRemaining !== undefined && loc.maxRemaining > 0) {
                return false;
              }
              return true;
            }
            return isDepletionExpired(oreEntry.depleted_at, depletionTimeoutMs);
          });

          if (allLocations.length > 0) {
            const scoredLocations = allLocations
              .map(loc => {
                const route = mapStore.findRoute(bot.system, loc.systemId, blacklist);
                const jumps = route ? route.length - 1 : 999;
                return { ...loc, jumps };
              })
              .filter(loc => loc.jumps <= maxJumps)
              .sort((a, b) => {
                // Sort by richness first, then by remaining, then by distance
                if (b.richness !== a.richness) return b.richness - a.richness;
                if (b.remaining !== a.remaining) return b.remaining - a.remaining;
                return a.jumps - b.jumps;
              });

            if (scoredLocations.length > 0) {
              const bestLoc = scoredLocations[0];
              const bestRichness = bestLoc.richness ?? 0;
              const bestRemaining = bestLoc.remaining ?? 0;

              // Upgrade criteria: 2x+ richness OR 2x+ remaining pool (same logic as startup check)
              let shouldUpgrade = false;
              let upgradeReason = "";

              if (bestLoc.isHidden && !currentPoi?.hidden) {
                const canMineHiddenForType = miningType === "ore" ? deepCoreCap.canMineHidden :
                  miningType === "radioactive" ? canMineHiddenRadioactive :
                  miningType === "ice" ? canMineHiddenIce : false;
                if (canMineHiddenForType) {
                  shouldUpgrade = true;
                  upgradeReason = `hidden POI upgrade (${bestLoc.poiName} vs ${currentPoi?.name})`;
                }
              } else if (bestRichness >= currentRichness * 2 && bestRichness > 10) {
                shouldUpgrade = true;
                upgradeReason = `much higher richness (${bestRichness} vs ${currentRichness})`;
              } else if (bestRemaining >= currentRemaining * 2 && bestRemaining > 1000) {
                shouldUpgrade = true;
                upgradeReason = `much larger pool (${bestRemaining.toLocaleString()} vs ${currentRemaining.toLocaleString()})`;
              }

              if (shouldUpgrade) {
                ctx.log("mining", `RICHNESS UPGRADE: ${upgradeReason} — switching POIs`);

                // Travel to new system if needed
                if (bestLoc.systemId !== bot.system) {
                  ctx.log("mining", `Traveling to ${bestLoc.systemName} for better POI...`);
                  
                  // CRITICAL FIX: Check cargo before traveling to new POI
                  await bot.refreshStatus();
                  const upgradeFillRatio = bot.cargoMax > 0 ? bot.cargo / bot.cargoMax : 0;
                  if (upgradeFillRatio >= cargoThresholdRatio) {
                    ctx.log("mining", `Cargo full (${Math.round(upgradeFillRatio * 100)}%) — returning home to deposit before richness upgrade`);
                    yield "return_home";
                    yield "pre_return_fuel";
                    if (recoveredSession) {
                      await updateMiningSession(bot.username, { state: "returning_home" });
                    }
                    const returnFueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
                    if (!returnFueled && stationPoi) {
                      await refuelAtStation(ctx, stationPoi, safetyOpts.fuelThresholdPct);
                    }
                    const homeArrived = await navigateToSystem(ctx, homeSystem, safetyOpts);
                    if (!homeArrived) {
                      ctx.log("error", "Failed to return to home system — will retry next cycle");
                    }
                    const { pois: homePois } = await getSystemInfo(ctx);
                    const homeStation = findStation(homePois);
                    stationPoi = homeStation ? { id: homeStation.id, name: homeStation.name } : null;
                    if (stationPoi) {
                      yield "travel_to_station";
                      await bot.exec("travel", { target_poi: stationPoi.id });
                    }
                    yield "deposit_cargo";
                    await ensureDocked(ctx);
                    await dumpCargo(ctx, settings);
                    await bot.refreshCargo();
                    const remainingCargo = bot.inventory.filter(i => i.quantity > 0 && !i.itemId.toLowerCase().includes("fuel") && !i.itemId.toLowerCase().includes("energy_cell"));
                    if (remainingCargo.length > 0) {
                      const itemsLeft = remainingCargo.map(i => `${i.quantity}x ${i.name}`).join(", ");
                      ctx.log("error", `Cargo deposit FAILED — items still in cargo: ${itemsLeft}`);
                      await ctx.sleep(5000);
                      continue;
                    }
                    ctx.log("mining", "Cargo deposited — restarting mining cycle");
                    continue;
                  }

                  const travelOpts = {
                    ...safetyOpts,
                    onJump: async (jumpNumber: number) => {
                      // Check if target POI is still available
                      const sys = mapStore.getSystem(bestLoc.systemId);
                      const poi = sys?.pois.find(p => p.id === bestLoc.poiId);
                      const oreEntry = poi?.ores_found.find(o => o.item_id === effectiveTarget);
                      if (oreEntry && oreEntry.depleted && !isDepletionExpired(oreEntry.depleted_at, depletionTimeoutMs)) {
                        ctx.log("mining", `Target POI ${bestLoc.poiName} depleted by another bot during travel (jump ${jumpNumber}) — aborting richness upgrade`);
                        return false;
                      }
                      return true;
                    }
                  };
                  const arrived = await navigateToSystem(ctx, bestLoc.systemId, travelOpts);
                  if (arrived) {
                    const { pois: newPois } = await getSystemInfo(ctx);
                    pois = newPois;
                    bot.system = bestLoc.systemId;
                  } else {
                    ctx.log("error", "Failed to reach new system for richness upgrade");
                  }
                }

                // Travel to new POI using the survey-aware travel function
                const travelResult = await travelToPoiWithSurvey(ctx, bestLoc.poiId, bestLoc.poiName, bestLoc.isHidden);

                if (travelResult.success) {
                  miningPoi = { id: bestLoc.poiId, name: bestLoc.poiName };
                  ctx.log("mining", `Switched to better POI: ${bestLoc.poiName} (richness: ${bestRichness}, remaining: ${bestRemaining.toLocaleString()})`);

                  // Update session if active
                  if (recoveredSession) {
                    await updateMiningSession(bot.username, {
                      targetPoiId: bestLoc.poiId,
                      targetPoiName: bestLoc.poiName,
                      targetSystemId: bestLoc.systemId,
                      targetSystemName: bestLoc.systemName,
                    });
                    ctx.log("mining", `Updated mining session to new POI: ${bestLoc.poiName}`);
                  }

                  lastPoiCheck = 0; // Reset POI check timer
                  continue; // Continue mining at new POI
                } else {
                  ctx.log("error", `Failed to travel to better POI: ${travelResult.error}`);
                }
              } else {
                ctx.log("mining", `No significantly better POI found (current: richness ${currentRichness}, remaining ${currentRemaining.toLocaleString()})`);
              }
            }
          }
        }

        // ── DEPLETION CHECK (original logic) ──
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
            
            ctx.log("map", `Updated map for ${bot.system}: POI ${poiData.name || bot.poi} scan data recorded`);
          }

          for (const res of resources) {
            const resId = (res.resource_id as string) || (res.id as string) || "";
            if (resId === effectiveTarget) {
              const remaining = (res.remaining as number) ?? (res.quantity as number) ?? null;
              const maxRemaining = (res.max_remaining as number) ?? 0;
              
              // CRITICAL FIX: Only mark depleted if we have CONFIRMED evidence
              // Same logic as pre-scan: require maxRemaining > 0 to prove it was actually scanned/mined
              if (remaining !== null && remaining <= 0 && maxRemaining > 0) {
                ctx.log("mining", `POI check: ${effectiveTarget} is depleted (remaining: ${remaining}, max: ${maxRemaining})`);
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
              if (miningType === "radioactive") return canMineBasicRadioactive && (
                isOreBeltPoi(poi?.type || "") ||
                (!poi?.hidden && canMineDeepCoreRadioactive) ||
                (poi?.hidden && canMineHiddenRadioactive)
              );
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
                        
                        // CRITICAL FIX: Check cargo before traveling to next POI when stayOutUntilFull is enabled
                        await bot.refreshStatus();
                        const nextPoiFillRatio = bot.cargoMax > 0 ? bot.cargo / bot.cargoMax : 0;
                        if (nextPoiFillRatio >= cargoThresholdRatio) {
                          ctx.log("mining", `Cargo full (${Math.round(nextPoiFillRatio * 100)}%) — returning home to deposit before switching POIs`);
                          yield "return_home";
                          yield "pre_return_fuel";
                          if (recoveredSession) {
                            await updateMiningSession(bot.username, { state: "returning_home" });
                          }
                          const returnFueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
                          if (!returnFueled && stationPoi) {
                            await refuelAtStation(ctx, stationPoi, safetyOpts.fuelThresholdPct);
                          }
                          const homeArrived = await navigateToSystem(ctx, homeSystem, safetyOpts);
                          if (!homeArrived) {
                            ctx.log("error", "Failed to return to home system — will retry next cycle");
                          }
                          const { pois: homePois } = await getSystemInfo(ctx);
                          const homeStation = findStation(homePois);
                          stationPoi = homeStation ? { id: homeStation.id, name: homeStation.name } : null;
                          if (stationPoi) {
                            yield "travel_to_station";
                            await bot.exec("travel", { target_poi: stationPoi.id });
                          }
                          yield "deposit_cargo";
                          await ensureDocked(ctx);
                          await dumpCargo(ctx, settings);
                          await bot.refreshCargo();
                          const remainingCargo = bot.inventory.filter(i => i.quantity > 0 && !i.itemId.toLowerCase().includes("fuel") && !i.itemId.toLowerCase().includes("energy_cell"));
                          if (remainingCargo.length > 0) {
                            const itemsLeft = remainingCargo.map(i => `${i.quantity}x ${i.name}`).join(", ");
                            ctx.log("error", `Cargo deposit FAILED — items still in cargo: ${itemsLeft}`);
                            await ctx.sleep(5000);
                            continue;
                          }
                          ctx.log("mining", "Cargo deposited — restarting mining cycle");
                          continue;
                        }

                        // Travel to new system if needed
                        if (chosen.systemId !== bot.system) {
                          const travelOpts = {
                            ...safetyOpts,
                            onJump: async (jumpNumber: number) => {
                              // Check if target POI is still available
                              const sys = mapStore.getSystem(chosen.systemId);
                              const poi = sys?.pois.find(p => p.id === chosen.poiId);
                              const oreEntry = poi?.ores_found.find(o => o.item_id === effectiveTarget);
                              if (oreEntry && oreEntry.depleted && !isDepletionExpired(oreEntry.depleted_at, depletionTimeoutMs)) {
                                ctx.log("mining", `Target POI ${chosen.poiName} depleted by another bot during travel (jump ${jumpNumber}) — aborting travel`);
                                return false;
                              }
                              return true;
                            }
                          };
                          const arrived = await navigateToSystem(ctx, chosen.systemId, travelOpts);
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
                  await failMiningSession(bot.username, "Resource depleted");
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

            // CRITICAL: Check for battle interrupt after jettison (the bot was hit here!)
            if (jettisonResp.error && (
              jettisonResp.error.code === "battle_interrupt" ||
              jettisonResp.error.message.toLowerCase().includes("interrupted by battle") ||
              jettisonResp.error.message.toLowerCase().includes("interrupted by combat")
            )) {
              ctx.log("combat", `Jettison interrupted by battle! ${jettisonResp.error.message} - fleeing IMMEDIATELY!`);
              battleState.inBattle = true;
              battleState.battleId = null;
              battleState.isFleeing = false;
              // Issue flee and DON'T wait - let the harvest loop re-issue
              await fleeFromBattle(ctx, false, 5000);
              stopReason = "battle detected (jettison interrupted)";
              break;
            }

            if (!jettisonResp.error) {
              const dcTag = isDeepCoreMining ? " [deep core]" : "";
              ctx.log("mining", `Jettisoned ${cargoItem.quantity}x ${cargoItem.name || jettisonOreId} (pre-mine cargo cleanup${dcTag})`);
              await bot.refreshCargo();
            }
          }
        }

        // If battle was detected during jettison, break out of harvest loop
        if (battleState.inBattle) {
          break;
        }
      }

      // Pre-mine battle check - prevents mine command from freezing if battle starts
      // CRITICAL: Check WebSocket state FIRST for fastest detection
      // FIX: Break immediately after detecting battle - DON'T try to mine!
      if (bot.isInBattle()) {
        ctx.log("combat", `PRE-MINE CHECK: IN BATTLE! - initiating flee and BREAKING!`);
        battleState.inBattle = true;
        battleState.isFleeing = false;
        await bot.exec("battle", { action: "stance", stance: "flee" }); // Issue flee immediately
        battleState.lastFleeTime = Date.now();
        break; // BREAK out of harvest loop - don't try to mine!
      } else {
        const preMineBattleCheck = await getBattleStatus(ctx);
        if (preMineBattleCheck && preMineBattleCheck.is_participant) {
          ctx.log("combat", `PRE-MINE CHECK: IN BATTLE! Battle ID: ${preMineBattleCheck.battle_id} - initiating flee and BREAKING!`);
          battleState.inBattle = true;
          battleState.battleId = preMineBattleCheck.battle_id;
          battleState.isFleeing = false;
          await bot.exec("battle", { action: "stance", stance: "flee" }); // Issue flee immediately
          battleState.lastFleeTime = Date.now();
          break; // BREAK out of harvest loop - don't try to mine!
        }
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
        // CRITICAL: Check for battle interrupt - stop mining immediately
        if (mineResp.error.code === "battle_interrupt" || msg.includes("interrupted by battle") || msg.includes("interrupted by combat")) {
          ctx.log("combat", `Mine interrupted by battle! ${mineResp.error.message} - fleeing IMMEDIATELY!`);
          battleState.inBattle = true;
          battleState.isFleeing = false;
          // Issue flee and DON'T wait for disengage - let the loop re-issue
          await bot.exec("battle", { action: "stance", stance: "flee" });
          stopReason = "battle detected (mine interrupted)";
          break;
        }
        if (msg.includes("depleted") || msg.includes("no resources") || msg.includes("no gas") || msg.includes("no ice") || msg.includes("no minable")) {
          // VERIFY actual remaining resources before marking as depleted
          // This prevents false positives from transient errors that mention "depleted"
          let actuallyDepleted = false;
          try {
            const verifyResp = await bot.exec("get_poi", { poi_id: bot.poi });
            if (!verifyResp.error && verifyResp.result) {
              const result = verifyResp.result as Record<string, unknown>;
              const poiData = result?.poi as Record<string, unknown> | undefined;
              const resources = Array.isArray(result.resources)
                ? (result.resources as Array<Record<string, unknown>>)
                : Array.isArray(poiData?.resources)
                ? (poiData.resources as Array<Record<string, unknown>>)
                : [];
              
              for (const res of resources) {
                const resId = (res.resource_id as string) || (res.id as string) || "";
                if (resId === effectiveTarget) {
                  const remaining = (res.remaining as number) ?? (res.quantity as number) ?? null;
                  const maxRemaining = (res.max_remaining as number) ?? 0;
                  // CRITICAL FIX: Only mark depleted if confirmed 0 AND had resources before
                  actuallyDepleted = remaining !== null && remaining <= 0 && maxRemaining > 0;
                  if (!actuallyDepleted) {
                    ctx.log("mining", `Mine error says "depleted" but ${effectiveTarget} still has ${remaining} remaining (max: ${maxRemaining}) — NOT marking as depleted`);
                  }
                  break;
                }
              }
            }
          } catch (e) {
            ctx.log("warn", `Failed to verify POI status before marking depleted: ${e}`);
            // If we can't verify, assume it's actually depleted to be safe
            actuallyDepleted = true;
          }

          // Only mark as depleted if we confirmed resources are actually at 0
          if (actuallyDepleted && effectiveTarget && bot.poi && !settings.ignoreDepletion) {
            mapStore.markOreDepleted(bot.system, bot.poi, effectiveTarget);
            ctx.log("mining", `Marked ${effectiveTarget} at ${bot.poi} as depleted`);
          }
          // Re-pick a new target from quotas, or find any nearby ore if no quotas remain
          ctx.log("mining", `${resourceLabel} field depleted — searching for new target...`);

          // CRITICAL FIX: Check global/configured target FIRST before falling back to quotas
          // This ensures energy_crystal (or any global target) doesn't get ignored when depleted
          // DEEP CORE FIX: If this is a deep core miner, use efficient hidden POI rotation
          let newTarget: string | null = null;
          let newPoiId: string | null = null;
          let newPoiName: string | null = null;
          let newSystemId: string | null = null;

          // For deep core miners, implement efficient hidden POI rotation:
          // 1. First, try to find another hidden POI with the SAME ore (high richness)
          // 2. If none found, check if all hidden POIs for this ore are depleted (on timer)
          // 3. If all hidden POIs depleted, switch to NEXT deep core ore in quota
          // 4. Only mine low richness POIs when all hidden POIs are on timer
          const currentDeepCoreCap = await getDeepCoreCapability(ctx, fieldTestActive);
          const isDeepCoreMiner = currentDeepCoreCap.canMineVisibleDeepCore;
          let searchTarget = targetResource;

          if (isDeepCoreMiner && effectiveTarget && isDeepCoreOre(effectiveTarget)) {
            ctx.log("mining", `Deep core miner: ${effectiveTarget} depleted — searching for next hidden POI...`);
            
            // Step 1: Search for another hidden POI with the SAME ore (high richness)
            const hiddenPoi = findBestHiddenPoiForOre(
              effectiveTarget,
              bot.system,
              bot.poi || "",
              maxJumps,
              settings.ignoreDepletion,
              depletionTimeoutMs,
              50 // Minimum richness threshold
            );
            
            if (hiddenPoi) {
              // Found another high-richness hidden POI for the same ore
              newTarget = effectiveTarget;
              newPoiId = hiddenPoi.poiId;
              newPoiName = hiddenPoi.poiName;
              newSystemId = hiddenPoi.systemId;
              ctx.log("mining", `Found hidden POI: ${effectiveTarget} @ ${hiddenPoi.poiName} in ${hiddenPoi.systemName} (${hiddenPoi.jumps} jumps, richness: ${hiddenPoi.richness})`);
            } else {
              // Step 2: Check if all hidden POIs for this ore are depleted (on timer)
              const allHiddenDepleted = areAllHiddenPoisDepleted(
                effectiveTarget,
                bot.system,
                bot.poi || "",
                settings.ignoreDepletion,
                depletionTimeoutMs
              );
              
              if (allHiddenDepleted) {
                ctx.log("mining", `All hidden POIs for ${effectiveTarget} are depleted (on timer) — switching to next quota ore`);
                // Step 3: Switch to the next deep core ore in the quota
                // Get all deep core ores that have quotas or are available
                const deepCoreQuotaEntries = Object.entries(quotas).filter(([oreId]) => isDeepCoreOre(oreId));

                // CRITICAL FIX: Sort by deficit to pick the next most needed ore
                // When all quotas are met, cycle through by smallest surplus
                await bot.refreshFactionStorage();
                const sortedDeepCoreOres = deepCoreQuotaEntries
                  .map(([oreId, target]) => {
                    const current = bot.factionStorage.find(i => i.itemId === oreId)?.quantity || 0;
                    const deficit = target - current;
                    return { oreId, deficit, current, target };
                  })
                  .sort((a, b) => {
                    // First: ores with deficit > 0 (biggest first)
                    // Then: ores with deficit <= 0 (smallest surplus first)
                    const aHasDeficit = a.deficit > 0;
                    const bHasDeficit = b.deficit > 0;
                    if (aHasDeficit && !bHasDeficit) return -1;
                    if (!aHasDeficit && bHasDeficit) return 1;
                    if (aHasDeficit && bHasDeficit) return b.deficit - a.deficit; // biggest deficit first
                    return a.deficit - b.deficit; // smallest surplus first
                  });

                // Try each deep core ore in quota priority order
                for (const quotaEntry of sortedDeepCoreOres) {
                  if (quotaEntry.oreId === effectiveTarget) continue; // Skip current ore
                  
                  const nextHiddenPoi = findBestHiddenPoiForOre(
                    quotaEntry.oreId,
                    bot.system,
                    bot.poi || "",
                    maxJumps,
                    settings.ignoreDepletion,
                    depletionTimeoutMs,
                    50
                  );
                  
                  if (nextHiddenPoi) {
                    newTarget = quotaEntry.oreId;
                    newPoiId = nextHiddenPoi.poiId;
                    newPoiName = nextHiddenPoi.poiName;
                    newSystemId = nextHiddenPoi.systemId;
                    ctx.log("mining", `Switched to next quota ore: ${quotaEntry.oreId} @ ${nextHiddenPoi.poiName} in ${nextHiddenPoi.systemName} (${nextHiddenPoi.jumps} jumps, richness: ${nextHiddenPoi.richness}, deficit: ${quotaEntry.deficit})`);
                    break;
                  }
                }
                
                // If no hidden POIs found for any quota ore, check if ALL hidden POIs are on timer
                if (!newTarget) {
                  // Check if there are ANY hidden POIs available for deep core ores
                  // CRITICAL FIX: Check in quota priority order, not set order
                  let anyHiddenAvailable = false;
                  for (const deepCoreOre of sortedDeepCoreOres.map(e => e.oreId)) {
                    const anyPoi = findBestHiddenPoiForOre(
                      deepCoreOre,
                      bot.system,
                      bot.poi || "",
                      maxJumps,
                      settings.ignoreDepletion,
                      depletionTimeoutMs,
                      30 // Lower threshold to be more inclusive
                    );
                    if (anyPoi) {
                      anyHiddenAvailable = true;
                      break;
                    }
                  }

                  if (!anyHiddenAvailable) {
                    // Step 4: All hidden POIs are on depletion timer - fall back to low richness mining
                    ctx.log("mining", "All hidden POIs depleted across all deep core ores — falling back to low richness mining");

                    // CRITICAL FIX: Try deep core ores in quota priority order, not set order
                    for (const deepCoreOre of sortedDeepCoreOres.map(e => e.oreId)) {
                      const anyPoiResult = findBestHiddenPoiForOre(
                        deepCoreOre,
                        bot.system,
                        bot.poi || "",
                        maxJumps,
                        settings.ignoreDepletion,
                        depletionTimeoutMs,
                        0 // Accept any richness
                      );

                      if (anyPoiResult) {
                        newTarget = deepCoreOre;
                        newPoiId = anyPoiResult.poiId;
                        newPoiName = anyPoiResult.poiName;
                        newSystemId = anyPoiResult.systemId;
                        ctx.log("mining", `Found low richness deep core target: ${deepCoreOre} @ ${anyPoiResult.poiName} (${anyPoiResult.jumps} jumps, richness: ${anyPoiResult.richness})`);
                        break;
                      }
                    }
                    
                    if (!newTarget) {
                      ctx.log("mining", "No deep core ores available at all — waiting for depletion timers");
                      stopReason = "all deep core POIs on depletion timer";
                      break;
                    }
                  } else {
                    ctx.log("mining", "Some hidden POIs still available but not meeting richness threshold — will retry next cycle");
                    stopReason = "waiting for hidden POI richness recovery";
                    break;
                  }
                }
              } else {
                // Not all hidden POIs are depleted, but none found with high richness
                // This means there might be some low-richness ones - skip them for now
                ctx.log("mining", `No high-richness hidden POIs for ${effectiveTarget} — switching to next quota ore`);
                
                // Switch to next quota ore (same logic as above)
                const deepCoreQuotaEntries = Object.entries(quotas).filter(([oreId]) => isDeepCoreOre(oreId));
                await bot.refreshFactionStorage();
                const sortedDeepCoreOres = deepCoreQuotaEntries
                  .map(([oreId, target]) => {
                    const current = bot.factionStorage.find(i => i.itemId === oreId)?.quantity || 0;
                    const deficit = target - current;
                    return { oreId, deficit, current, target };
                  })
                  .filter(entry => entry.deficit > 0)
                  .sort((a, b) => b.deficit - a.deficit);
                
                for (const quotaEntry of sortedDeepCoreOres) {
                  if (quotaEntry.oreId === effectiveTarget) continue;
                  
                  const nextHiddenPoi = findBestHiddenPoiForOre(
                    quotaEntry.oreId,
                    bot.system,
                    bot.poi || "",
                    maxJumps,
                    settings.ignoreDepletion,
                    depletionTimeoutMs,
                    50
                  );
                  
                  if (nextHiddenPoi) {
                    newTarget = quotaEntry.oreId;
                    newPoiId = nextHiddenPoi.poiId;
                    newPoiName = nextHiddenPoi.poiName;
                    newSystemId = nextHiddenPoi.systemId;
                    ctx.log("mining", `Switched to next quota ore: ${quotaEntry.oreId} @ ${nextHiddenPoi.poiName} in ${nextHiddenPoi.systemName} (${nextHiddenPoi.jumps} jumps, richness: ${nextHiddenPoi.richness})`);
                    break;
                  }
                }
                
                if (!newTarget) {
                  ctx.log("mining", "No alternative deep core ores with high richness — waiting for next cycle");
                  stopReason = "no high-richness hidden POIs available";
                  break;
                }
              }
            }
          } else if (isDeepCoreMiner && (!targetResource || !isDeepCoreOre(targetResource))) {
            // Deep core miner without a specific target - search for any deep core ore
            // CRITICAL FIX: Use quota priority when searching for targets
            ctx.log("mining", "Deep core miner — searching for deep core ore target after depletion...");

            // Get deep core quotas and sort by priority
            const deepCoreQuotaEntries = Object.entries(quotas).filter(([oreId]) => isDeepCoreOre(oreId));
            let oresToSearch: string[];

            if (deepCoreQuotaEntries.length > 0) {
              await bot.refreshFactionStorage();
              const sortedEntries = deepCoreQuotaEntries
                .map(([oreId, target]) => {
                  const current = bot.factionStorage.find(i => i.itemId === oreId)?.quantity || 0;
                  return { oreId, deficit: target - current };
                })
                .sort((a, b) => {
                  const aHasDeficit = a.deficit > 0;
                  const bHasDeficit = b.deficit > 0;
                  if (aHasDeficit && !bHasDeficit) return -1;
                  if (!aHasDeficit && bHasDeficit) return 1;
                  if (aHasDeficit && bHasDeficit) return b.deficit - a.deficit;
                  return a.deficit - b.deficit;
                });
              oresToSearch = sortedEntries.map(e => e.oreId);
              ctx.log("mining", `Deep core search in quota priority order: ${oresToSearch.join(", ")}`);
            } else {
              oresToSearch = Array.from(DEEP_CORE_ORES);
            }

            // Search for any available deep core ore with hidden POIs
            for (const deepCoreOre of oresToSearch) {
              const hiddenPoiResult = findBestHiddenPoiForOre(
                deepCoreOre,
                bot.system,
                bot.poi || "",
                maxJumps,
                settings.ignoreDepletion,
                depletionTimeoutMs,
                50
              );

              if (hiddenPoiResult) {
                newTarget = deepCoreOre;
                newPoiId = hiddenPoiResult.poiId;
                newPoiName = hiddenPoiResult.poiName;
                newSystemId = hiddenPoiResult.systemId;
                ctx.log("mining", `Found deep core target: ${deepCoreOre} @ ${hiddenPoiResult.poiName} in ${hiddenPoiResult.systemName} (${hiddenPoiResult.jumps} jumps, richness: ${hiddenPoiResult.richness})`);
                break;
              }
            }

            if (!newTarget) {
              ctx.log("mining", "No high-richness hidden POIs available — checking for any hidden POI...");
              // Fallback to any hidden POI regardless of richness
              for (const deepCoreOre of oresToSearch) {
                const anyPoiResult = findBestHiddenPoiForOre(
                  deepCoreOre,
                  bot.system,
                  bot.poi || "",
                  maxJumps,
                  settings.ignoreDepletion,
                  depletionTimeoutMs,
                  0
                );

                if (anyPoiResult) {
                  newTarget = deepCoreOre;
                  newPoiId = anyPoiResult.poiId;
                  newPoiName = anyPoiResult.poiName;
                  newSystemId = anyPoiResult.systemId;
                  ctx.log("mining", `Found low richness deep core target: ${deepCoreOre} @ ${anyPoiResult.poiName} (${anyPoiResult.jumps} jumps, richness: ${anyPoiResult.richness})`);
                  break;
                }
              }
              
              if (!newTarget) {
                ctx.log("mining", "No deep core ores available — waiting for next cycle to retry");
                stopReason = "no deep core ores available";
                break;
              }
            }
          } else if (searchTarget) {
            ctx.log("mining", `Checking for configured global target ${resourceLabel}: ${searchTarget}...`);
            const globalTargetLocs = mapStore.findOreLocations(searchTarget).filter(loc => {
              const sys = mapStore.getSystem(loc.systemId);
              const poi = sys?.pois.find(p => p.id === loc.poiId);
              if (miningType === "ore") return isOreBeltPoi(poi?.type || "");
                      if (miningType === "radioactive") return canMineBasicRadioactive && (
                        isOreBeltPoi(poi?.type || "") ||
                        (!poi?.hidden && canMineDeepCoreRadioactive) ||
                        (poi?.hidden && canMineHiddenRadioactive)
                      );
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
            if (miningType === "radioactive") return canMineBasicRadioactive && (
              isOreBeltPoi(poi?.type || "") ||
              (!poi?.hidden && canMineDeepCoreRadioactive) ||
              (poi?.hidden && canMineHiddenRadioactive)
            );
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
miningType === "radioactive" ? pois.filter(p => canMineBasicRadioactive && (
  isOreBeltPoi(p.type) ||
  (!p.hidden && canMineDeepCoreRadioactive) ||
  (p.hidden && canMineHiddenRadioactive)
)) :
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
                const bestLocations = mapStore.findBestMiningLocation(effectiveTarget || (miningType === "ore" ? "iron_ore" : miningType === "gas" ? "argon_gas" : miningType === "radioactive" ? "uranium_ore" : "water_ice"), bot.system, blacklist);

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
                  if (miningType === "radioactive" && !(canMineBasicRadioactive && (
                    isOreBeltPoi(poi.type) ||
                    (!poi.hidden && canMineDeepCoreRadioactive) ||
                    (poi.hidden && canMineHiddenRadioactive)
                  ))) continue;
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
              await updateMiningSession(bot.username, {
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
              const travelOpts = {
                ...safetyOpts,
                onJump: async (jumpNumber: number) => {
                  // Check if target POI is still available
                  const sys = mapStore.getSystem(newSystemId);
                  const poi = sys?.pois.find(p => p.id === newPoiId);
                  const oreEntry = poi?.ores_found.find(o => o.item_id === targetResource);
                  if (oreEntry && oreEntry.depleted && !isDepletionExpired(oreEntry.depleted_at, depletionTimeoutMs)) {
                    ctx.log("mining", `Target POI ${newPoiName} depleted by another bot during travel (jump ${jumpNumber}) — aborting travel`);
                    return false;
                  }
                  return true;
                }
              };
              const arrived = await navigateToSystem(ctx, newSystemId, travelOpts);
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

              // CRITICAL: Check for battle interrupt error
              if (travelResp.error && (travelResp.error.code === "battle_interrupt" ||
                  travelResp.error.message.toLowerCase().includes("interrupted by battle") ||
                  travelResp.error.message.toLowerCase().includes("interrupted by combat"))) {
                ctx.log("combat", `Travel to new target interrupted by battle! ${travelResp.error.message} - fleeing!`);
                await fleeFromBattle(ctx);
                stopReason = "battle detected";
                break;
              }

              if (travelResp.error && !travelResp.error.message.includes("already")) {
                ctx.log("error", `Travel to new target failed: ${travelResp.error.message}`);
                stopReason = `${resourceLabel} field depleted (travel failed)`;
                break;
              }
              bot.poi = newPoiId;
            }

            miningPoi = { id: newPoiId!, name: newPoiName! };
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
          // EQUIPMENT ERROR: Verify POI resources before treating as fatal
          // This prevents false positives from server timeouts that cause state confusion
          ctx.log("warn", `Mining equipment error: ${mineResp.error.message}`);
          
          // Verify what resources are actually available at this POI
          let poiHasTargetResource = false;
          let poiResourceTypes: string[] = [];
          
          try {
            const verifyResp = await bot.exec("get_poi", { poi_id: bot.poi });
            if (!verifyResp.error && verifyResp.result) {
              const result = verifyResp.result as Record<string, unknown>;
              const poiData = result?.poi as Record<string, unknown> | undefined;
              const resources = Array.isArray(result.resources)
                ? (result.resources as Array<Record<string, unknown>>)
                : Array.isArray(poiData?.resources)
                ? (poiData.resources as Array<Record<string, unknown>>)
                : [];

              for (const res of resources) {
                const resId = (res.resource_id as string) || (res.id as string) || "";
                const remaining = (res.remaining as number) ?? (res.quantity as number) ?? 0;
                if (resId) {
                  poiResourceTypes.push(resId);
                  if (resId === effectiveTarget && remaining > 0) {
                    poiHasTargetResource = true;
                  }
                }
              }
              
              ctx.log("mining", `POI resource check at ${miningPoi?.name || 'unknown'}: ${poiResourceTypes.length > 0 ? poiResourceTypes.join(', ') : 'none detected'}`);
              if (effectiveTarget) {
                ctx.log("mining", `Target resource ${effectiveTarget}: ${poiHasTargetResource ? 'AVAILABLE' : 'NOT FOUND'}`);
              }

              // STRIP MINER FIX: If using strip miner and target ore not available,
              // switch to mining whichever common ore IS available at this POI
              if (usingStripMiner && !poiHasTargetResource && effectiveTarget) {
                const availableCommonOres = poiResourceTypes.filter(oreId => isStripMinerOre(oreId));
                if (availableCommonOres.length > 0) {
                  // Switch target to the first available common ore
                  const newTarget = availableCommonOres[0];
                  ctx.log("mining", `Strip miner: ${effectiveTarget} not available — switching to ${newTarget} (available at current POI)`);
                  effectiveTarget = newTarget;
                  poiHasTargetResource = true; // Now the target is available
                } else {
                  ctx.log("warn", `Strip miner: No common ores available at ${miningPoi?.name || 'current POI'} — cannot mine here`);
                }
              }
            }
          } catch (e) {
            ctx.log("warn", `Failed to verify POI resources: ${e}`);
          }

          // If the target resource is confirmed available, this is likely a transient error
          // Retry instead of exiting the routine
          if (poiHasTargetResource) {
            ctx.log("warn", `Equipment error but target resource is available — likely transient error, will retry`);
            await ctx.sleep(5000);
            continue; // Retry mining
          }
          
          // Resource not available - check if POI type mismatch
          const hasGasResources = poiResourceTypes.some(r => r.includes('gas') || getMiningTypeForResource(r) === 'gas');
          const hasIceResources = poiResourceTypes.some(r => r.includes('ice') || getMiningTypeForResource(r) === 'ice');
          const hasOreResources = poiResourceTypes.some(r => !r.includes('gas') && !r.includes('ice') && getMiningTypeForResource(r) === 'ore');
          
          // Determine actual POI type from resources
          let actualPoiType: "ore" | "gas" | "ice" | "unknown" = "unknown";
          if (hasGasResources && !hasOreResources && !hasIceResources) actualPoiType = "gas";
          else if (hasIceResources && !hasOreResources && !hasGasResources) actualPoiType = "ice";
          else if (hasOreResources || (hasGasResources && hasIceResources)) actualPoiType = "ore"; // Mixed = likely ore belt
          
          // Check if there's a type mismatch
          if (actualPoiType !== "unknown" && actualPoiType !== miningType) {
            ctx.log("error", `POI type mismatch: mining ${miningType} but POI has ${actualPoiType} resources — searching for correct POI type`);
            // Mark current POI as wrong type and search for alternative
            miningPoi = null;
            
            // Search for correct POI type in current system
            const altPoi = pois.find(p => {
              if (miningType === "ore") return isOreBeltPoi(p.type);
                if (miningType === "radioactive") return canMineBasicRadioactive && (
                  isOreBeltPoi(p.type) ||
                  (!p.hidden && canMineDeepCoreRadioactive) ||
                  (p.hidden && canMineHiddenRadioactive)
                );
              if (miningType === "gas") return isGasCloudPoi(p.type);
              if (miningType === "ice") return isIceFieldPoi(p.type);
              return false;
            });
            
            if (altPoi) {
              ctx.log("mining", `Found correct POI type: ${altPoi.name}`);
              const travelResp = await bot.exec("travel", { target_poi: altPoi.id });
              
              // Check for battle notifications
              if (travelResp.notifications && Array.isArray(travelResp.notifications)) {
                const battleDetected = await handleBattleNotifications(ctx, travelResp.notifications, battleState);
                if (battleDetected) {
                  ctx.log("error", "Battle detected while traveling to alternative POI - fleeing!");
                  stopReason = "battle detected";
                  break;
                }
              }

              // CRITICAL: Check for battle interrupt error
              if (travelResp.error && (travelResp.error.code === "battle_interrupt" ||
                  travelResp.error.message.toLowerCase().includes("interrupted by battle") ||
                  travelResp.error.message.toLowerCase().includes("interrupted by combat"))) {
                ctx.log("combat", `Travel to alternative POI interrupted by battle! ${travelResp.error.message} - fleeing!`);
                await fleeFromBattle(ctx);
                stopReason = "battle detected";
                break;
              }

              if (!travelResp.error || travelResp.error.message.includes("already")) {
                bot.poi = altPoi.id;
                miningPoi = { id: altPoi.id, name: altPoi.name };
                continue; // Continue mining at correct POI
              }
            }
            
             // No alternative found - clear target and return to station to pick a new one
             ctx.log("error", `No correct POI type found — clearing target and returning to station`);
             effectiveTarget = "";
             targetResource = "";
             stopReason = "POI type mismatch (no alternatives)";
             break;
          }
          
          // GENUINE EQUIPMENT ERROR: No resources at all or truly missing equipment
          // Only exit after multiple retries to handle transient issues
          miningErrorCount = (miningErrorCount || 0) + 1;
          if (miningErrorCount >= 3) {
            ctx.log("error", `Missing ${resourceLabel} harvesting module after ${miningErrorCount} retries: ${mineResp.error.message}`);
            ctx.log("error", `Genuine equipment issue detected — returning to station`);
            stopReason = "missing harvesting module";
            break;
          }
          
          ctx.log("warn", `Equipment error (${miningErrorCount}/3) — retrying in 10s...`);
          await ctx.sleep(10000);
          continue; // Retry mining
        }
        ctx.log("error", `Harvest error: ${mineResp.error.message}`);
        break;
      }

      // Successful mining - reset error counter
      miningErrorCount = 0;
      harvestCycles++;

      const { oreId, oreName } = parseOreFromMineResult(mineResp.result);
      
      // MINING RESULT SUMMARY: Log exactly what was mined for visibility
      if (mineResp.result && typeof mineResp.result === "object") {
        const result = mineResp.result as Record<string, unknown>;
        const quantity = (result.quantity as number) ?? (result.amount as number) ?? 1;
        const richness = (result.richness as number) ?? 0;
        const resourceType = (result.resource_type as string) ?? (result.type as string) ?? "";
        const poiName = (result.poi_name as string) ?? (result.location as string) ?? miningPoi?.name ?? "";
        
        // Build a detailed summary of what was mined
        const summaryParts = [`Mined ${quantity}x ${oreName || "unknown"}`];
        if (poiName) summaryParts.push(`@ ${poiName}`);
        if (richness > 0) summaryParts.push(`[richness: ${richness}]`);
        if (resourceType) summaryParts.push(`[type: ${resourceType}]`);
        if (oreId && oreId !== oreName) summaryParts.push(`[id: ${oreId}]`);
        
        const dcTag = isDeepCoreMining ? " [DEEP CORE]" : "";
        ctx.log("mining", `${summaryParts.join(" ")}${dcTag}`);
      } else if (oreId) {
        // Fallback if result structure is unexpected
        const dcTag = isDeepCoreMining ? " [deep core]" : "";
        ctx.log("mining", `Mined ${oreName}${dcTag}`);
      }
      
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
          await updateMiningSession(bot.username, {
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
    const isFuelLowStop = stopReason && stopReason.includes("fuel low");
    
    // CRITICAL FIX: When stopping due to fuel low mid-mining and stayOutUntilFull is enabled:
    // - Don't deposit cargo at the refuel station
    // - Refuel and continue mining instead of returning home
    // This prevents depositing at random stations during refuel detours
    const isCargoFull = fillRatio >= cargoThresholdRatio;
    const shouldStayOutDueToFuel = isFuelLowStop && settings.stayOutUntilFull && !isCargoFull;
    
    const shouldReturnHome = settings.stayOutUntilFull
      ? ((fillRatio >= cargoThresholdRatio || isDepleted) && bot.system !== homeSystem && homeSystem)
      : (bot.system !== homeSystem && homeSystem);

    if (shouldStayOutDueToFuel) {
      // CRITICAL FIX: Fuel low stop with stayOutUntilFull enabled - refuel and continue mining
      // DO NOT deposit cargo at random station, DO NOT return home yet
      ctx.log("mining", `Fuel low but stayOutUntilFull enabled and cargo not full (${(fillRatio * 100).toFixed(0)}%) — refueling and continuing mining`);
      
      // Refuel at local/current station - do NOT deposit cargo here
      const { pois: currentPois } = await getSystemInfo(ctx);
      const currentStation = findStation(currentPois);
      if (currentStation) {
        // Dock and refuel but do NOT unload cargo
        const dockResp = await bot.exec("dock");
        if (!dockResp.error || dockResp.error.message.includes("already")) {
          bot.docked = true;
          ctx.log("system", `Refueling at ${currentStation.name} (cargo: ${bot.cargo}/${bot.cargoMax}, will deposit at home)`);
          const refuelResp = await bot.exec("refuel");
          if (!refuelResp.error) {
            ctx.log("system", "Refueled — continuing mining (cargo kept onboard)");
          }
        }
      } else {
        // No station in current system - use ensureFueled to get fuel
        await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
      }
      
      // Continue the mining cycle instead of returning home to deposit
      // Reset stopReason so the outer loop continues
      stopReason = "";
      continue;
    } else if (shouldReturnHome) {
      yield "return_home";
      yield "pre_return_fuel";
      // Update session state
      if (recoveredSession) {
        await updateMiningSession(bot.username, { state: "returning_home" });
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
      
      // Check for battle notifications
      if (travelStationResp.notifications && Array.isArray(travelStationResp.notifications)) {
        const battleDetected = await handleBattleNotifications(ctx, travelStationResp.notifications, battleState);
        if (battleDetected) {
          ctx.log("error", "Battle detected while traveling to station - fleeing!");
          // Don't dock - handle battle first
          stationPoi = null;
        }
      }

      // CRITICAL: Check for battle interrupt error
      if (travelStationResp.error && (travelStationResp.error.code === "battle_interrupt" ||
          travelStationResp.error.message.toLowerCase().includes("interrupted by battle") ||
          travelStationResp.error.message.toLowerCase().includes("interrupted by combat"))) {
        ctx.log("combat", `Travel to station interrupted by battle! ${travelStationResp.error.message} - fleeing!`);
        await fleeFromBattle(ctx);
        // Don't dock - handle battle first
        stationPoi = null;
      } else if (travelStationResp.error && !travelStationResp.error.message.includes("already")) {
        ctx.log("error", `Travel to station failed: ${travelStationResp.error.message}`);
        stationPoi = null;
      }
    }

    // ── CRITICAL: Only deposit at HOME system ──
    // If we're not at home system, either navigate home first or skip deposit entirely
    // This prevents depositing at random stations during refuel detours
    const isAtHome = !homeSystem || bot.system === homeSystem;
    
    if (!isAtHome) {
      ctx.log("mining", `Not at home system (${bot.system}) — will navigate home before depositing cargo`);
      const arrived = await navigateToSystem(ctx, homeSystem, safetyOpts);
      if (!arrived) {
        ctx.log("error", "Failed to reach home system — keeping cargo, will retry next cycle");
        // Don't deposit - keep cargo and restart mining loop
        await ensureUndocked(ctx);
        stopReason = "";
        continue;
      }
      // Refresh station info after arriving home
      const { pois: homePois } = await getSystemInfo(ctx);
      const homeStation = findStation(homePois);
      stationPoi = homeStation ? { id: homeStation.id, name: homeStation.name } : null;
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
        await ctx.sleep(5000);
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
        await updateMiningSession(bot.username, { state: "depositing" });
      }
    }

    await bot.refreshStatus();
    await bot.refreshStorage();

    const earnings = bot.credits - creditsBefore;
    await factionDonateProfit(ctx, earnings);

    // Complete mining session after successful deposit
    if (recoveredSession) {
      await completeMiningSession(bot.username);
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
