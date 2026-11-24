import type { Routine, RoutineContext, Bot } from "../bot.js";
import type { BotChatMessage } from "../bot_chat_channel.js";
import { extractLibResult } from "../commandBridge.js";
import { mapStore, isDepletionExpired } from "../mapstore.js";
import { getBotChatChannel } from "../botmanager.js";
import { getEffectiveSystemBlacklist } from "../web/server.js";
import { onCoordinationUpdate } from "../client_sync_hooks.js";
import { safeWriteFileSync } from "../diskSpaceGuard.js";
import {
  registerMinerTarget as registerCoordinationTarget,
  unregisterMinerTarget as unregisterCoordinationTarget,
  getMinerCountForSystem,
  isSystemOvercrowded,
} from "./minerCoordination.js";
import {
  isOreBeltPoi,
  isGasCloudPoi,
  isIceFieldPoi,
  findStation,
  parseOreFromMineResult,
  parseOreFromCargoDelta,
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
  getFuelCellFuelValue,
  isFuelCellItem,
  getCargoFuelCells,
  estimateRouteFuel,
  waitForTransitCompletion,
  topUpShields,
  useRepairKits,
  checkAndFleeFromBattle,
  getBattleStatus as getBattleStatusCommon,
  fleeFromBattle,
} from "./common.js";
import {
  calculateBearingToTarget,
  executePathfinderJumpToBearing,
} from "./pathfinder.js";
import {
  getRadioactiveCapability,
  getRadioactiveCapabilityCached,
  hasRadioactiveEquipmentCached,
  hasFullRadioactiveCapabilityCached,
  logRadioactiveCapability,
  isRadioactiveOre,
  RADIOACTIVE_ORES,
} from "./miner_radioactive.js";
import {
  ensureAmmoLoaded,
  getWeaponModules,
} from "./battle.js";
import { catalogStore } from "../catalogstore.js";
import { getItemSize } from "./common.js";
import {
  getActiveMiningSession,
  startMiningSession,
  updateMiningSession,
  completeMiningSession,
  failMiningSession,
  createMiningSession,
  type MiningSession,
  type MiningType,
} from "./minerActivity.js";
import {
  type BattleState,
  handleBattleNotifications,
  getBattleStatus,
  shouldEngagePlayersInCombat,
  engageInBattle,
} from "./common.js";
import {
  readFlockSettings,
  readFlockState,
  registerFlockMember,
  unregisterFlockMember,
  broadcastFlockHeartbeat,
  announceFlockTarget,
  updateFlockPhase,
  clearFlockState,
  type FlockState,
} from "./flock.js";
import {
  analyzeExistingBattle,
  fightJoinedBattle,
  fightFreshBattle,
  engageTarget,
  recloakAfterBattle,
  ensureCloakedIfNeeded,
  parseNearby,
  isPirateTarget,
  isCreatureTarget,
  isCreatureName,
  checkForBoardingAttempt,
  type NearbyEntity,
  type PirateTier,
  type WeaponModule,
  emergencyFleeSpam,
} from "./battle.js";

// ── Local hunter-like functions (copied from hunter.ts) ─────────────────────

function isLeviathanCreature(name: string | undefined): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();
  return lower.includes("leviathan");
}

function isBrandedCreature(name: string | undefined): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();
  if (lower.includes("branded")) return true;
  const tagMatch = name.match(/^\[[^\]]+\]\s*(.*)/);
  if (tagMatch) {
    const stripped = tagMatch[1].trim();
    if (stripped && isCreatureName(stripped)) return true;
  }
  return false;
}

function isProtectedCreature(name: string | undefined): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();
  return lower.includes("hatchling") || lower.includes("calf") || lower.includes("young") || lower.includes("juvenile");
}

function isCloudWhale(name: string | undefined): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();
  return lower.includes("cloudwhale") && !lower.includes("calf") && !lower.includes("hatchling") && !lower.includes("young") && !lower.includes("juvenile");
}

function applyCloudWhalePackRule(entities: NearbyEntity[]): NearbyEntity[] {
  const cloudWhales = entities.filter(e => isCloudWhale(e.name));
  const others = entities.filter(e => !isCloudWhale(e.name));
  if (cloudWhales.length < 3) {
    return others;
  }
  return [...others, cloudWhales[0]];
}

function pickCreatureTargets(entities: NearbyEntity[], bot: Bot, huntCreatures: boolean, max: number, coordinationMode: "off" | "assist" | "avoid"): NearbyEntity[] {
  const creatures = applyCloudWhalePackRule(entities.filter(e => isCreatureTarget(e, huntCreatures) && !isStationEntity(e) && !isBrandedCreature(e.name) && !isProtectedCreature(e.name)));
  const unclaimed = creatures.filter(e =>
    isLeviathanCreature(e.name) || coordinationMode !== "avoid"
  );
  const result = prioritizeLeviathans(unclaimed).slice(0, Math.max(0, max));
  return result;
}

function prioritizeLeviathans(creatures: NearbyEntity[]): NearbyEntity[] {
  if (!creatures.length) return creatures;
  const prioritized = creatures.filter(e => isLeviathanCreature(e.name));
  const rest = creatures.filter(e => !isLeviathanCreature(e.name));
  return [...prioritized, ...rest];
}

function isStationEntity(e: NearbyEntity): boolean {
  return e.type.toLowerCase() === "station";
}

const TIER_ORDER: Record<string, number> = {
  small: 1,
  medium: 2,
  large: 3,
  capitol: 4,
  boss: 5,
};

function sortTargetsByPriority(targets: NearbyEntity[]): NearbyEntity[] {
  function tierScore(e: NearbyEntity): number {
    return TIER_ORDER[(e.tier || "").toLowerCase()] || 0;
  }
  function shieldPct(e: NearbyEntity): number {
    if (!e.shield || !e.maxShield || e.maxShield <= 0) return 0;
    return e.shield / e.maxShield;
  }
  function hullPct(e: NearbyEntity): number {
    if (!e.hull || !e.maxHull || e.maxHull <= 0) return 0;
    return e.hull / e.maxHull;
  }

  const stations: NearbyEntity[] = [];
  const pirates: NearbyEntity[] = [];

  for (const e of targets) {
    if (isStationEntity(e)) {
      stations.push(e);
    } else {
      pirates.push(e);
    }
  }

  pirates.sort((a, b) => {
    const td = tierScore(b) - tierScore(a);
    if (td !== 0) return td;
    const sd = shieldPct(b) - shieldPct(a);
    if (sd !== 0) return sd;
    return hullPct(b) - hullPct(a);
  });

  return [...pirates, ...stations];
}

// ── Local waitForNextBattleTick (copied from battle.ts) ─────────────────────
async function waitForNextBattleTick(ctx: RoutineContext, lastTick: number | undefined): Promise<number | undefined> {
  const { bot } = ctx;
  const startTime = Date.now();
  while (Date.now() - startTime < 12000) {
    const status = await getBattleStatus(ctx);
    if (!status) return undefined;
    if (status.tick !== undefined && status.tick !== lastTick) {
      return status.tick;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return undefined;
}

// ── Repeater NPC Detection ──────────────────────────────────────────────────

interface RepeaterInfo {
  isRepeater: boolean;
  variant: "silver" | "pane" | "spire" | "monolith" | "unknown";
  name: string;
  tier: string;
}

function detectRepeater(entity: NearbyEntity): RepeaterInfo {
  const name = (entity.name || "").toLowerCase();
  const tier = (entity.tier || "").toLowerCase();
  
  if (!name.includes("repeater")) {
    return { isRepeater: false, variant: "unknown", name: entity.name || "", tier: entity.tier || "" };
  }

  let variant: RepeaterInfo["variant"] = "unknown";
  if (name.includes("spire")) variant = "spire";
  else if (name.includes("monolith")) variant = "monolith";
  else if (name.includes("silver")) variant = "silver";
  else if (name.includes("pane")) variant = "pane";

  return { isRepeater: true, variant, name: entity.name || "", tier: entity.tier || "" };
}

function shouldFleeFromRepeater(variant: RepeaterInfo["variant"], settings: GlassMinerSettings): boolean {
  if (variant === "spire" || variant === "monolith") {
    return true;
  }
  return false;
}

function canHandleRepeater(variant: RepeaterInfo["variant"]): boolean {
  return variant === "silver" || variant === "pane";
}

// ── Lib command wrapper (copied from miner.ts) ──────────────────────────────
interface LibCallResult {
  result?: unknown;
  error?: { code: string; message: string };
  notifications: unknown[];
}

async function runLibCommand<T>(call: Promise<T>): Promise<LibCallResult> {
  try {
    const res = (await call) as unknown;
    const result = extractLibResult(res);
    return { result, error: undefined, notifications: [] };
  } catch (err) {
    const e = err as Error & { code?: string };
    const message = e?.message ?? String(err);
    const msg = message.toLowerCase();
    let code = e?.code ?? "lib_error";
    if (msg.includes("battle_interrupt") || msg.includes("interrupted by battle") || msg.includes("interrupted by combat")) {
      code = "battle_interrupt";
    }
    return { error: { code, message }, result: undefined, notifications: [] };
  }
}

// ── Cloaking module detection and enablement ────────────────────────────────
async function hasCloakingModule(ctx: RoutineContext, cachedModules?: unknown[]): Promise<boolean> {
  const { bot } = ctx;
  let modules: unknown[];

  if (cachedModules && cachedModules.length > 0) {
    modules = cachedModules;
  } else {
    const shipResp = await bot.commands.spacemolt.get_ship();
    const shipData = shipResp.structuredContent as Record<string, unknown> | undefined;
    if (!shipData) return false;
    modules = Array.isArray(shipData.modules) ? shipData.modules : [];
  }

  for (const mod of modules) {
    const modObj = typeof mod === "object" && mod !== null ? mod as Record<string, unknown> : null;
    const modId = ((modObj?.id as string) || (modObj?.type_id as string) || "").toLowerCase();
    const modName = ((modObj?.name as string) || "").toLowerCase();
    const modSpecial = ((modObj?.special as string) || "").toLowerCase();

    const checkStr = `${modId} ${modName} ${modSpecial}`;
    if (checkStr.includes("cloak") || checkStr.includes("lensing_veil")) {
      return true;
    }
  }
  return false;
}

async function enableCloakingIfPossible(ctx: RoutineContext, cachedModules?: unknown[]): Promise<boolean> {
  const { bot } = ctx;

  if (bot.isCloaked) {
    const hasCloak = await hasCloakingModule(ctx, cachedModules);
    if (!hasCloak) {
      ctx.log("warn", "Bot reports as cloaked but has no cloaking module — clearing stale cloak state");
      bot.isCloaked = false;
      return false;
    }
    ctx.log("mining", "Bot is already cloaked - no action needed");
    return true;
  }

  const hasCloak = await hasCloakingModule(ctx, cachedModules);
  if (!hasCloak) {
    ctx.log("mining", "No cloaking module detected - cannot enable cloak");
    return false;
  }

  ctx.log("mining", "Enabling cloaking module...");
  try {
    await bot.commands.spacemolt.cloak({ enable: true });
  } catch (e) {
    ctx.log("error", `Failed to enable cloak: ${e}`);
    return false;
  }

  ctx.log("mining", "Cloaking enabled successfully");
  return true;
}

function getMiningBlacklist(bot: { routineName: string | null; username?: string }, settings: GlassMinerSettings, isCloaked: boolean): string[] {
  const baseBlacklist = getEffectiveSystemBlacklist(bot);
  if (isCloaked && settings.cloakIgnoreBlacklist) {
    return [];
  }
  return baseBlacklist;
}

// ── Mission helpers ───────────────────────────────────────────
const MINER_MISSION_KEYWORDS = [
  "mine_resource", "mine", "mining", "extract", "harvest",
  "copper_requisition", "iron_supply_run", "prove_your_steel",
];

async function checkAndAcceptMinerMissions(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;
  if (!bot.docked) return;

  let activeResp: Awaited<ReturnType<typeof bot.commands.spacemolt.get_active_missions>>;
  try {
    activeResp = await bot.commands.spacemolt.get_active_missions();
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
    if (msg.includes("does not offer mission") || msg.includes("no mission")) {
      ctx.log("mining", "Station offers no mission services — skipping mission accept");
      return;
    }
    throw err;
  }

  let activeCount = 0;
  const activeContent = activeResp.structuredContent;
  if (activeContent && typeof activeContent === "object") {
    const r = activeContent as Record<string, unknown>;
    const list = Array.isArray(r) ? r : Array.isArray(r.missions) ? r.missions : [];
    activeCount = (list as unknown[]).length;
  }
  if (activeCount >= 5) return;

  let availResp: Awaited<ReturnType<typeof bot.commands.spacemolt.get_missions>>;
  try {
    availResp = await bot.commands.spacemolt.get_missions();
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
    if (msg.includes("does not offer mission") || msg.includes("no mission")) {
      ctx.log("mining", "Station offers no mission services — skipping mission accept");
      return;
    }
    throw err;
  }
  const availContent = availResp.structuredContent;
  if (!availContent || typeof availContent !== "object") return;
  const r = availContent as Record<string, unknown>;
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
    try {
      await bot.commands.spacemolt.accept_mission({ id: missionId });
      activeCount++;
      ctx.log("trade", `Mission accepted: ${(mission.name as string) || missionId} (${activeCount}/5 active)`);
    } catch { }
  }
}

async function completeActiveMissions(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;
  if (!bot.docked) return;

  let activeResp: Awaited<ReturnType<typeof bot.commands.spacemolt.get_active_missions>>;
  try {
    activeResp = await bot.commands.spacemolt.get_active_missions();
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
    if (msg.includes("does not offer mission") || msg.includes("no mission")) {
      ctx.log("mining", "Station offers no mission services — skipping mission completion");
      return;
    }
    throw err;
  }
  const activeContent = activeResp.structuredContent;
  if (!activeContent || typeof activeContent !== "object") return;
  const r = activeContent as Record<string, unknown>;
  const missions = (
    Array.isArray(r) ? r :
    Array.isArray(r.missions) ? r.missions : []
  ) as Array<Record<string, unknown>>;

  for (const mission of missions) {
    const missionId = (mission.id as string) || (mission.mission_id as string) || "";
    if (!missionId) continue;
    try {
      await bot.commands.spacemolt.complete_mission({ id: missionId });
      const reward = (mission.reward as number) || (mission.reward_credits as number) || 0;
      ctx.log("trade", `Mission complete: ${(mission.name as string) || missionId}${reward > 0 ? ` (+${reward} credits)` : ""}`);
      await bot.refreshLocation();
    } catch { }
  }
}

// ── Settings ─────────────────────────────────────────────────
type DepositMode = "storage" | "faction" | "sell";
type FlockRole = "leader" | "follower";

interface FlockGroupConfig {
  name: string;
  targetOre: string;
  targetGas: string;
  targetIce: string;
  miningType: MiningType;
  rallySystem?: string;
  systemOre?: string;
  systemGas?: string;
  systemIce?: string;
  maxMembers?: number;
  [key: string]: unknown;
}

// ── Glass Miner Routing Profiles ────────────────────────────────
// Similar to HunterPatrolProfile but for mining routes with pathfinder support

export interface GlassMinerRouteProfile {
  name: string;
  /** Ordered list of system IDs/names to jump through using regular jumps */
  routeSystems: string[];
  /** Optional: Pathfinder jump from this system to the hazardous area */
  pathfinderStartSystem?: string;
  /** Optional: Target system for the pathfinder jump (hazardous mining area) */
  pathfinderTargetSystem?: string;
  /** Optional: Specific POI to mine in the hazardous system */
  miningPoiId?: string;
  /** Optional: Specific POI name to mine in the hazardous system */
  miningPoiName?: string;
  /** Optional: Resource ID to mine in the hazardous area */
  miningResourceId?: string;
  /** Optional: Bearing override for pathfinder jump (if pre-calculated) */
  pathfinderBearing?: number;
  /** Whether to use pathfinder jump for this route */
  usePathfinderJump: boolean;
  /** Cycle mode for the route */
  cycleMode: "sequential" | "random";
  /** Optional: return route (if different from outbound) */
  returnRouteSystems?: string[];
  /** Optional: pathfinder jump back from hazardous area */
  pathfinderReturnStartSystem?: string;
  /** Optional: pathfinder return target system */
  pathfinderReturnTargetSystem?: string;
  /** Optional: bearing override for return pathfinder jump */
  pathfinderReturnBearing?: number;
}

export interface GlassMinerSettings {
  miningType: MiningType;
  autoDetectMiningType: boolean;
  depositMode: DepositMode;
  depositFallback: DepositMode;
  cargoThreshold: number;
  refuelThreshold: number;
  repairThreshold: number;
  homeSystem: string;
  system: string;
  systemOre: string;
  systemGas: string;
  systemIce: string;
  systemRadioactive: string;
  systemDeepCore: string;
  depositBot: string;
  targetOre: string;
  targetGas: string;
  targetIce: string;
  targetRadioactive: string;
  targetDeepCore: string;
  oreQuotas: Record<string, number>;
  gasQuotas: Record<string, number>;
  iceQuotas: Record<string, number>;
  radioactiveQuotas: Record<string, number>;
  deepCoreQuotas: Record<string, number>;
  jettisonOres: string[];
  deepCoreJettisonOres: string[];
  radioactiveJettisonOres: string[];
  jettisonGas: string[];
  jettisonIce: string[];
  depletionTimeoutHours: number;
  ignoreDepletion: boolean;
  stayOutUntilFull: boolean;
  maxJumps: number;
  minimumFuelCells: number;
  returnHomeOnFuelCellsRemaining: number;
  noMidMiningRetarget: boolean;
  enableCloak: boolean;
  cloakIgnoreBlacklist: boolean;
  desiredEmergencyWarpDevices: number;
  desiredShieldCharges: number;
  desiredRepairKits: number;
  desiredAmmoBoxes: number;
  disableResupply: boolean;
  enableFighting: boolean;
  enableMissions: boolean;
  deepSleepIntervalMin: number;
  enableCoordination: boolean;
  maxBotsPerSystem: number;
  flockEnabled: boolean;
  flockName: string;
  flockRole: FlockRole;
  flockGroups: FlockGroupConfig[];
  // Glass Miner specific settings
  shieldRechargePct: number;
  shieldMonitorThresholdPct: number;
  repairKitThresholdPct: number;
  fleeSystemThresholdPct: number;
  desiredAdvancedRepairKits: number;
  enableFullTimeShieldMonitor: boolean;
  maxRepeaterTierToEngage: PirateTier;
fleeFromSpireMonolith: boolean;
  cloakOnStart: boolean;
  // Mine current seam_glass POI without traveling; keep shields/hull topped up
  mineOnly: boolean;
  // Routing profiles
  routeProfiles: GlassMinerRouteProfile[];
  activeRouteProfile: string;
}

async function getGlassMinerSettings(username?: string): Promise<GlassMinerSettings> {
  const all = readSettings();
  const m = all.glass_miner || {};
  const botOverrides = username ? (all[username] || {}) : {};
  const flockCfg = (await readFlockSettings()) || { assignments: {}, flockGroups: [] };

  if (username && flockCfg.assignments && flockCfg.assignments[username]) {
    Object.assign(botOverrides, flockCfg.assignments[username]);
  }

  function parseDepositMode(val: unknown): DepositMode | null {
    if (val === "faction" || val === "sell" || val === "storage") return val;
    return null;
  }

  function parseMiningType(val: unknown): MiningType | null {
    if (val === "ore" || val === "gas" || val === "ice" || val === "radioactive") return val;
    return null;
  }

  function parseFlockRole(val: unknown): FlockRole | null {
    if (val === "leader" || val === "follower") return val;
    return null;
  }

  function parsePirateTier(val: unknown): PirateTier | null {
    const tiers: PirateTier[] = ["small", "medium", "large", "capitol", "boss"];
    if (typeof val === "string" && tiers.includes(val as PirateTier)) return val as PirateTier;
    return null;
  }

  function parseRouteProfiles(val: unknown): GlassMinerRouteProfile[] {
    if (!Array.isArray(val)) return [];
    return val.map((p: Record<string, unknown>) => ({
      name: (p.name as string) || "unnamed_route",
      routeSystems: Array.isArray(p.routeSystems) ? (p.routeSystems as string[]) : [],
      pathfinderStartSystem: (p.pathfinderStartSystem as string) || undefined,
      pathfinderTargetSystem: (p.pathfinderTargetSystem as string) || undefined,
      miningPoiId: (p.miningPoiId as string) || undefined,
      miningPoiName: (p.miningPoiName as string) || undefined,
      miningResourceId: (p.miningResourceId as string) || undefined,
      pathfinderBearing: typeof p.pathfinderBearing === "number" ? p.pathfinderBearing : undefined,
      usePathfinderJump: (p.usePathfinderJump as boolean) ?? false,
      cycleMode: (p.cycleMode as "sequential" | "random") ?? "sequential",
      returnRouteSystems: Array.isArray(p.returnRouteSystems) ? (p.returnRouteSystems as string[]) : [],
      pathfinderReturnStartSystem: (p.pathfinderReturnStartSystem as string) || undefined,
      pathfinderReturnTargetSystem: (p.pathfinderReturnTargetSystem as string) || undefined,
      pathfinderReturnBearing: typeof p.pathfinderReturnBearing === "number" ? p.pathfinderReturnBearing : undefined,
    }));
  }

  const rawFlockGroups = flockCfg.flockGroups || [];
  const flockGroups: FlockGroupConfig[] = rawFlockGroups.map((g: Record<string, unknown>) => ({
    name: (g.name as string) || "unnamed_flock",
    targetOre: (g.targetOre as string) || (g.target_ore as string) || "",
    targetGas: (g.targetGas as string) || (g.target_gas as string) || "",
    targetIce: (g.targetIce as string) || (g.target_ice as string) || "",
    miningType: parseMiningType(g.miningType) ?? parseMiningType(g.mining_type) ?? "ore",
    rallySystem: (g.rallySystem as string) ?? (g.rally_system as string) ?? undefined,
    systemOre: (g.systemOre as string) ?? (g.system_ore as string) ?? undefined,
    systemGas: (g.systemGas as string) ?? (g.system_gas as string) ?? undefined,
    systemIce: (g.systemIce as string) ?? (g.system_ice as string) ?? undefined,
    maxMembers: (g.maxMembers as number) ?? (g.max_members as number) ?? undefined,
  }));

  return {
    miningType:
      parseMiningType(botOverrides.miningType) ??
      parseMiningType(m.miningType) ?? "ore",
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
    system: (m.system as string) || "",
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
    jettisonGas: (m.jettisonGas as string[]) || [],
    jettisonIce: (m.jettisonIce as string[]) || [],
    depletionTimeoutHours: (m.depletionTimeoutHours as number) || 3,
    ignoreDepletion: (m.ignoreDepletion as boolean) ?? false,
    stayOutUntilFull: (m.stayOutUntilFull as boolean) ?? false,
    maxJumps: (m.maxJumps as number) ?? 10,
    minimumFuelCells: (m.minimumFuelCells as number) ?? 20,
    returnHomeOnFuelCellsRemaining: (m.returnHomeOnFuelCellsRemaining as number) ?? 2,
    noMidMiningRetarget: (m.noMidMiningRetarget as boolean) ?? false,
    enableCloak: (m.enableCloak as boolean) ?? false,
    cloakIgnoreBlacklist: (m.cloakIgnoreBlacklist as boolean) ?? false,
    enableMissions: (m.enableMissions as boolean) ?? true,
    deepSleepIntervalMin: (m.deepSleepIntervalMin as number) ?? 30,
    enableCoordination: (m.enableCoordination as boolean) ?? true,
    maxBotsPerSystem: (m.maxBotsPerSystem as number) ?? 3,
    flockEnabled: (botOverrides.flockEnabled === true || botOverrides.flockEnabled === "true"),
    flockName: (botOverrides.flockName as string) || "",
    flockRole: parseFlockRole(botOverrides.flockRole) ?? "follower",
    flockGroups,
    desiredEmergencyWarpDevices: (m.desiredEmergencyWarpDevices as number) ?? 3,
    desiredShieldCharges: (m.desiredShieldCharges as number) ?? 20,
    desiredRepairKits: (m.desiredRepairKits as number) ?? 12,
    desiredAmmoBoxes: (m.desiredAmmoBoxes as number) ?? -1,
    disableResupply: (m.disableResupply as boolean) ?? false,
    enableFighting: (m.enableFighting as boolean) ?? true,
    // Glass Miner specific
    shieldRechargePct: (m.shieldRechargePct as number) ?? 80,
    shieldMonitorThresholdPct: (m.shieldMonitorThresholdPct as number) ?? 50,
    repairKitThresholdPct: (m.repairKitThresholdPct as number) ?? 50,
    fleeSystemThresholdPct: (m.fleeSystemThresholdPct as number) ?? 30,
    desiredAdvancedRepairKits: (m.desiredAdvancedRepairKits as number) ?? 10,
    enableFullTimeShieldMonitor: (m.enableFullTimeShieldMonitor as boolean) ?? true,
    maxRepeaterTierToEngage: parsePirateTier(m.maxRepeaterTierToEngage) ?? "large",
    fleeFromSpireMonolith: (m.fleeFromSpireMonolith as boolean) ?? true,
    cloakOnStart: (m.cloakOnStart as boolean) ?? false,
    autoDetectMiningType: (m.miningType === "auto" || m.miningType === "Auto" || m.miningType === "AUTO"),
    mineOnly: (botOverrides.mineOnly as boolean) ?? (m.mineOnly as boolean) ?? false,
    // Routing profiles
    routeProfiles: parseRouteProfiles(m.routeProfiles),
    activeRouteProfile: (botOverrides.activeRouteProfile as string) || (m.activeRouteProfile as string) || "",
  };
}

// ── Jettison helpers ──────────────────────────────────────────
function getJettisonListForMiningType(
  settings: GlassMinerSettings,
  miningType: "ore" | "gas" | "ice" | "radioactive",
): string[] {
  if (miningType === "gas") return settings.jettisonGas || [];
  if (miningType === "ice") return settings.jettisonIce || [];
  if (miningType === "radioactive") return settings.radioactiveJettisonOres || [];
  return settings.jettisonOres || [];
}

// ── Mining type detection ─────────────────────────────────────
async function detectMiningType(ctx: RoutineContext, cachedModules?: unknown[]): Promise<"ore" | "gas" | "ice" | "radioactive" | null> {
  const { bot } = ctx;
  let shipData: Record<string, unknown>;
  let usingCachedModules = false;

  if (cachedModules && cachedModules.length > 0) {
    shipData = { modules: cachedModules };
    usingCachedModules = true;
  } else {
    const shipResp = await bot.commands.spacemolt.get_ship();
    const shipDataResult = shipResp.structuredContent as Record<string, unknown> | undefined;
    if (!shipDataResult) {
      ctx.log("error", `Failed to get ship info`);
      return null;
    }
    shipData = shipDataResult;
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
    if (checkStr.includes("lead_lined_cargo") || checkStr.includes("lead lined cargo") || checkStr.includes("hazmat_cargo")) {
      hasLeadLinedCargo = true;
    }
    if (checkStr.includes("rad_harvester") || checkStr.includes("rad harvester") || checkStr.includes("rad_harvesting")) {
      hasRadHarvester = true;
    }
  }

  const hasRadioactiveEquipment = hasLeadLinedCargo && hasRadHarvester;

  const detectedTypes: string[] = [];
  if (hasMiningLaser || hasStripMiner) detectedTypes.push("ore");
  if (hasGasHarvester) detectedTypes.push("gas");
  if (hasIceHarvester) detectedTypes.push("ice");
  if (hasRadioactiveEquipment) detectedTypes.push("radioactive");

  if (hasRadioactiveEquipment) {
    ctx.log("info", "Radioactive mining equipment detected — radioactive mining mode");
    return "radioactive";
  }

  if (detectedTypes.length > 1) {
    ctx.log("info", `Multiple mining modules detected (${detectedTypes.join(", ")}) — using settings preference`);
    return "ore";
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

  if (usingCachedModules && !hasMiningLaser && !hasStripMiner && !hasGasHarvester && !hasIceHarvester && !hasRadioactiveEquipment) {
    ctx.log("warn", "Cached modules incomplete — retrying with fresh ship data");
    const freshResp = await bot.commands.spacemolt.get_ship();
    const freshShipData = freshResp.structuredContent as Record<string, unknown> | undefined;
    if (freshShipData) {
      const freshModules = Array.isArray(freshShipData.modules) ? freshShipData.modules : [];

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
        if (checkStr.includes("lead_lined_cargo") || checkStr.includes("lead lined cargo") || checkStr.includes("hazmat_cargo")) {
          hasLeadLinedCargo = true;
        }
        if (checkStr.includes("rad_harvester") || checkStr.includes("rad harvester") || checkStr.includes("rad_harvesting")) {
          hasRadHarvester = true;
        }
      }

      const freshHasRadioactiveEquipment = hasLeadLinedCargo && hasRadHarvester;

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
        ctx.log("info", "Strip miner detected (fresh data) — ore mining mode (limited to common ores)");
        ctx.log("warn", "Strip miners can only mine common rarity ores");
        return "ore";
      }
      if (hasMiningLaser) {
        ctx.log("info", "Mining laser detected (fresh data) — ore mining mode");
        return "ore";
      }
    }
  }

  ctx.log("error", "No mining equipment detected on ship");
  return null;
}

// ── Ship module caching ──────────────────────────────────────
async function cacheShipModules(ctx: RoutineContext): Promise<unknown[]> {
  const { bot } = ctx;
  const shipResp = await bot.commands.spacemolt.get_ship();
  const shipData = shipResp.structuredContent as Record<string, unknown> | undefined;
  if (!shipData) return [];
  const modules = Array.isArray(shipData.modules) ? shipData.modules : [];
  ctx.log("system", `Cached ${modules.length} ship modules for routine use`);
  return modules;
}

// ── Deep core capability checks ──────────────────────────────
const DEEP_CORE_ORES = new Set([
  "void_essence", "fury_crystal", "legacy_ore", "prismatic_nebulite",
  "exotic_matter", "dark_matter_residue", "adamantite_ore", "nebulium",
]);

export const ALLOWED_HIDDEN_POIS_FOR_PARTIAL_MINERS = new Set([
  "adamantite_core",
]);

export function isDeepCoreOre(resourceId: string): boolean {
  return DEEP_CORE_ORES.has(resourceId);
}

function shouldEnforceStandardMiningLimits(oreId: string, hasModulatedLaser: boolean | undefined): boolean {
  return !hasModulatedLaser && !isDeepCoreOre(oreId);
}

async function hasDeepCoreSurveyScanner(ctx: RoutineContext): Promise<boolean> {
  const { bot } = ctx;
  const shipResp = await bot.commands.spacemolt.get_ship();
  const shipData = shipResp.structuredContent as Record<string, unknown> | undefined;
  if (!shipData) return false;

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

async function hasDeepCoreExtractor(ctx: RoutineContext): Promise<boolean> {
  const { bot } = ctx;
  const shipResp = await bot.commands.spacemolt.get_ship();
  const shipData = shipResp.structuredContent as Record<string, unknown> | undefined;
  if (!shipData) return false;

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
        modSpecial.includes("rare_ore_access") || modSpecial.includes("deep_core_access")) {
      return true;
    }
  }
  return false;
}

async function hasModulatedMiningLaser(ctx: RoutineContext, cachedModules?: unknown[]): Promise<boolean> {
  const { bot } = ctx;
  let modules: unknown[];

  if (cachedModules && cachedModules.length > 0) {
    modules = cachedModules;
  } else {
    const shipResp = await bot.commands.spacemolt.get_ship();
    const shipData = shipResp.structuredContent as Record<string, unknown> | undefined;
    if (!shipData) return false;
    modules = Array.isArray(shipData.modules) ? shipData.modules : [];
  }

  for (const mod of modules) {
    const modObj = typeof mod === "object" && mod !== null ? mod as Record<string, unknown> : null;
    const modId = (modObj?.id as string) || (modObj?.type_id as string) || "";
    const modName = (modObj?.name as string) || "";

    const checkStr = `${modId} ${modName}`.toLowerCase();
    if (checkStr.includes("modulated_mining_laser") || checkStr.includes("modulated mining laser")) {
      return true;
    }
  }
  return false;
}

async function getDeepCoreCapability(ctx: RoutineContext, fieldTestActive: boolean = false): Promise<{
  hasScanner: boolean;
  hasExtractor: boolean;
  canMineHidden: boolean;
  canMineVisibleDeepCore: boolean;
}> {
  const hasScanner = await hasDeepCoreSurveyScanner(ctx);
  const hasExtractor = await hasDeepCoreExtractor(ctx);

  const canMineHidden = fieldTestActive ? hasExtractor : (hasScanner && hasExtractor);
  const canMineVisibleDeepCore = hasExtractor;

  return {
    hasScanner,
    hasExtractor,
    canMineHidden,
    canMineVisibleDeepCore,
  };
}

async function hasFieldTestMission(ctx: RoutineContext): Promise<boolean> {
  const { bot } = ctx;
  const activeResp = await bot.commands.spacemolt.get_active_missions();
  const result = activeResp.structuredContent as Record<string, unknown> | undefined;
  if (!result) return false;

  const missions = Array.isArray(activeResp.structuredContent)
    ? activeResp.structuredContent
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

// ── Strip Miner Helpers ──────────────────────────────────────
const STRIP_MINER_ORES = new Set([
  "carbon_ore", "copper_ore", "iron_ore", "lead_ore", "silicon_ore", "aluminum_ore"
]);

function isStripMinerOre(oreId: string): boolean {
  return STRIP_MINER_ORES.has(oreId.toLowerCase());
}

async function hasStripMiner(ctx: RoutineContext, cachedModules?: unknown[]): Promise<boolean> {
  const { bot } = ctx;
  let modules: unknown[];

  if (cachedModules) {
    modules = cachedModules;
  } else {
    const shipResp = await bot.commands.spacemolt.get_ship();
    const shipData = shipResp.structuredContent as Record<string, unknown> | undefined;
    if (!shipData) return false;
    modules = Array.isArray(shipData.modules) ? shipData.modules : [];
  }

  const moduleStr = modules.map(m => {
    const obj = typeof m === "object" && m !== null ? m as Record<string, unknown> : {};
    return `${obj.id || ""} ${obj.name || ""} ${obj.type || ""}`.toLowerCase();
  }).join(" ");

  return moduleStr.includes("strip_miner") || moduleStr.includes("strip miner");
}

// ── Mining Power Calculation ─────────────────────────────────
function getTotalMiningPower(modules: unknown[]): number {
  let totalPower = 0;

  const MINING_PREFIXES = [
    "mining_laser", "strip_miner", "rad_harvester", "ice_harvester",
    "gas_harvester", "deep_core_extractor",
  ];

  function toSnakeCase(str: string): string {
    return str.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
  }

  for (const mod of modules) {
    const modObj = typeof mod === "object" && mod !== null ? mod as Record<string, unknown> : null;
    if (!modObj) continue;

    const modId = ((modObj.id as string) || (modObj.type_id as string) || "").toLowerCase();
    const modName = ((modObj.name as string) || "").toLowerCase();
    const modType = ((modObj.type as string) || "").toLowerCase();
    const modSpecial = ((modObj.special as string) || "").toLowerCase();

    const checkStr = `${modId} ${modName} ${modType} ${modSpecial}`;
    const isMiningModule = MINING_PREFIXES.some(prefix => checkStr.includes(prefix));
    if (!isMiningModule) continue;

    let catalogEntry = (modName ? catalogStore.getItemByName(modName) : undefined) ||
      catalogStore.getItem(modId) ||
      (modObj.type_id ? catalogStore.getItem(modObj.type_id as string) : undefined);

    if (!catalogEntry && modName) {
      const snake = toSnakeCase(modName);
      catalogEntry = catalogStore.getItem(snake);
    }

    if (!catalogEntry) {
      for (const item of Object.values(catalogStore.getAll().items)) {
        const itemName = (item.name || "").toLowerCase();
        if (itemName && modName && itemName.includes(modName)) {
          catalogEntry = item;
          break;
        }
      }
    }

    const power =
      (catalogEntry?.mining_power as number) ??
      (modObj.mining_power as number) ??
      (modObj.power as number) ??
      0;
    totalPower += power;
  }

  return totalPower;
}

function checkDepositPowerCompatibility(
  totalMiningPower: number,
  supportedPower: number | undefined,
  oreId: string,
  hasModulatedMiningLaser?: boolean,
): { canMine: boolean; reason: string; effectivePower: number; requiredPower: number } {
  if (!shouldEnforceStandardMiningLimits(oreId, hasModulatedMiningLaser)) {
    return { canMine: true, reason: isDeepCoreOre(oreId) ? "deep core bypass" : "modulated mining laser bypass", effectivePower: totalMiningPower, requiredPower: supportedPower ?? 0 };
  }

  if (supportedPower === undefined || supportedPower === null || supportedPower <= 0) {
    return { canMine: true, reason: "no supported_power data", effectivePower: totalMiningPower, requiredPower: 0 };
  }
  
  if (totalMiningPower <= supportedPower) {
    return { canMine: true, reason: "power within limit", effectivePower: totalMiningPower, requiredPower: supportedPower };
  }
  
  if (totalMiningPower > supportedPower * 4) {
    return { 
      canMine: false, 
      reason: `equipment power (${totalMiningPower}) exceeds 4x deposit density (${supportedPower})`, 
      effectivePower: 0, 
      requiredPower: supportedPower 
    };
  }
  
  return { 
    canMine: true, 
    reason: `power capped at ${supportedPower} (equipment: ${totalMiningPower})`, 
    effectivePower: supportedPower, 
    requiredPower: supportedPower 
  };
}

function hasLocalMiningPoiOfType(
  botSystem: string,
  miningType: "ore" | "gas" | "ice" | "radioactive",
  canMineHiddenRadioactive: boolean,
  canMineHiddenIce: boolean,
): boolean {
  const sys = mapStore.getSystem(botSystem);
  if (!sys) return false;
  for (const poi of sys.pois) {
    const hidden = poi.hidden === true;
    if (hidden) {
      if (miningType === "radioactive" && !canMineHiddenRadioactive) continue;
      if (miningType === "ice" && !canMineHiddenIce) continue;
      if (miningType === "ore" && !ALLOWED_HIDDEN_POIS_FOR_PARTIAL_MINERS.has(poi.id)) continue;
    }
    if (miningType === "ore") {
      if (isOreBeltPoi(poi.type) || !hidden || ALLOWED_HIDDEN_POIS_FOR_PARTIAL_MINERS.has(poi.id)) return true;
    } else if (miningType === "gas") {
      if (isGasCloudPoi(poi.type)) return true;
    } else if (miningType === "ice") {
      if (isIceFieldPoi(poi.type)) return true;
    } else if (miningType === "radioactive") {
      if (isOreBeltPoi(poi.type)) return true;
    }
  }
  return false;
}

// ── Mine-only (stationary) helpers ───────────────────────────

/**
 * When mine-only mode is enabled and the bot is already inside a seam_glass POI,
 * build a mining target from the current POI instead of traveling.
 */
function getCurrentSeamGlassTarget(settings: GlassMinerSettings, bot: Bot): { systemId: string; poiId: string; resourceId: string; poiName: string } | null {
  if (!settings.mineOnly) return null;
  if (bot.docked) return null;

  const sys = mapStore.getSystem(bot.system);
  if (!sys) return null;

  const poi = sys.pois.find(p => p.id === bot.poi);
  if (!poi) return null;

  const hasSeamGlass =
    (poi.ores_found || []).some(e => e.item_id === "seam_glass") ||
    (poi.resources || []).some(r => r.resource_id === "seam_glass");
  if (!hasSeamGlass) return null;

  return {
    systemId: bot.system,
    poiId: poi.id,
    resourceId: "seam_glass",
    poiName: poi.name || poi.id,
  };
}

/** Build a mining target from the active route profile (if it defines one). */
function getRouteProfileTarget(settings: GlassMinerSettings, bot: Bot): { systemId: string; poiId: string; resourceId: string; poiName: string } | null {
  const activeRoute = getActiveRouteProfile(settings);
  if (!activeRoute) return null;
  if (!activeRoute.miningPoiId || !activeRoute.miningResourceId) return null;

  const targetSystemId = activeRoute.pathfinderTargetSystem
    ? resolveSystemId(activeRoute.pathfinderTargetSystem)
    : bot.system;

  if (!targetSystemId) return null;

  return {
    systemId: targetSystemId,
    poiId: activeRoute.miningPoiId,
    resourceId: activeRoute.miningResourceId,
    poiName: activeRoute.miningPoiName || activeRoute.miningPoiId,
  };
}

// ── Target selection ─────────────────────────────────────────
async function findBestMiningTarget(
  ctx: RoutineContext,
  settings: GlassMinerSettings,
  miningType: "ore" | "gas" | "ice" | "radioactive",
  totalMiningPower: number,
  blacklist: string[],
  canMineHiddenRadioactive: boolean,
  canMineHiddenIce: boolean,
  hasModulatedMiningLaser: boolean,
  fieldTestActive: boolean,
  cachedModules: unknown[],
): Promise<{ systemId: string; poiId: string; resourceId: string; poiName: string } | null> {
  const { bot } = ctx;
  const depletionTimeoutMs = settings.depletionTimeoutHours * 60 * 60 * 1000;
  
  const candidateOres: string[] = [];
  if (miningType === "ore") {
    if (settings.targetOre) candidateOres.push(settings.targetOre);
    if (settings.targetDeepCore) candidateOres.push(settings.targetDeepCore);
    for (const [ore, quota] of Object.entries(settings.oreQuotas)) {
      if (quota > 0 && !candidateOres.includes(ore)) candidateOres.push(ore);
    }
    for (const [ore, quota] of Object.entries(settings.deepCoreQuotas)) {
      if (quota > 0 && !candidateOres.includes(ore)) candidateOres.push(ore);
    }
  } else if (miningType === "gas") {
    if (settings.targetGas) candidateOres.push(settings.targetGas);
    for (const [gas, quota] of Object.entries(settings.gasQuotas)) {
      if (quota > 0 && !candidateOres.includes(gas)) candidateOres.push(gas);
    }
  } else if (miningType === "ice") {
    if (settings.targetIce) candidateOres.push(settings.targetIce);
    for (const [ice, quota] of Object.entries(settings.iceQuotas)) {
      if (quota > 0 && !candidateOres.includes(ice)) candidateOres.push(ice);
    }
  } else if (miningType === "radioactive") {
    if (settings.targetRadioactive) candidateOres.push(settings.targetRadioactive);
    for (const [rad, quota] of Object.entries(settings.radioactiveQuotas)) {
      if (quota > 0 && !candidateOres.includes(rad)) candidateOres.push(rad);
    }
  }

  const triedAndRejectedTargets = new Set<string>();
  const maxJumps = settings.maxJumps ?? 10;

  for (const ore of candidateOres) {
    const locs = mapStore.findOreLocations(ore, blacklist, blacklist.length > 0);
    if (locs.length === 0) continue;

    for (const loc of locs) {
      if (triedAndRejectedTargets.has(loc.poiId)) continue;
      
      const sys = mapStore.getSystem(loc.systemId);
      if (!sys) continue;
      
      const poi = sys.pois.find(p => p.id === loc.poiId);
      if (!poi) continue;

      const hidden = poi.hidden === true;
      if (hidden) {
        if (miningType === "radioactive" && !canMineHiddenRadioactive) continue;
        if (miningType === "ice" && !canMineHiddenIce) continue;
        if (miningType === "ore" && !ALLOWED_HIDDEN_POIS_FOR_PARTIAL_MINERS.has(poi.id)) continue;
      }

      if (!settings.ignoreDepletion) {
        const oreEntry = poi.ores_found?.find((e: any) => e.item_id === ore);
        if (oreEntry?.depleted && !isDepletionExpired(oreEntry.depleted_at, depletionTimeoutMs)) {
          continue;
        }
      }

      const hasScanData = loc.minutesSinceScan !== Infinity;
      if (shouldEnforceStandardMiningLimits(ore, hasModulatedMiningLaser) && hasScanData && loc.remaining <= 300 && (!loc.supportedPower || loc.supportedPower <= 0)) {
        continue;
      }
      if (shouldEnforceStandardMiningLimits(ore, hasModulatedMiningLaser) && totalMiningPower > 0 && loc.supportedPower && loc.supportedPower > 0 && totalMiningPower > loc.supportedPower * 4) {
        continue;
      }

      if (settings.enableCoordination) {
        const currentCount = getMinerCountForSystem(loc.systemId);
        if (currentCount >= (settings.maxBotsPerSystem ?? 3)) {
          continue;
        }
      }

      const route = mapStore.findRoute(bot.system, loc.systemId, blacklist);
      if (!route || route.length > maxJumps + 1) continue;

      return { systemId: loc.systemId, poiId: loc.poiId, resourceId: ore, poiName: poi.name || loc.poiId };
    }
  }

  return null;
}

// ── Combat with full-time shield monitoring ──────────────────
async function handleCombatWithShieldMonitor(
  ctx: RoutineContext,
  settings: GlassMinerSettings,
  target: NearbyEntity,
): Promise<boolean> {
  const { bot } = ctx;
  const shieldRechargePctDecimal = settings.shieldRechargePct / 100;
  const shieldMonitorThresholdDecimal = settings.shieldMonitorThresholdPct / 100;
  const repairKitThresholdDecimal = settings.repairKitThresholdPct / 100;
  const fleeThreshold = settings.fleeSystemThresholdPct;

  ctx.log("combat", `🎯 Engaging ${target.name} (tier: ${target.tier}) with full-time shield monitoring`);

  const analysis = await analyzeExistingBattle(ctx, settings.maxRepeaterTierToEngage, 3);
  if (analysis.shouldJoin) {
    ctx.log("combat", `Joining existing battle on side ${analysis.sideId}`);
    return fightJoinedBattle(
      ctx,
      target,
      fleeThreshold,
      settings.maxRepeaterTierToEngage,
      settings.maxRepeaterTierToEngage,
      0,
      false,
      shieldRechargePctDecimal,
      true,
      settings.cloakOnStart,
      false
    );
  }

  return fightFreshBattle(
    ctx,
    target,
    fleeThreshold,
    settings.maxRepeaterTierToEngage,
    settings.maxRepeaterTierToEngage,
    0,
    settings.cloakOnStart,
    shieldRechargePctDecimal,
    5,
    3,
    1,
    25,
    true
  );
}

async function checkAndHandleNearbyThreats(
  ctx: RoutineContext,
  settings: GlassMinerSettings,
): Promise<boolean> {
  const { bot } = ctx;
  
  const nearbyResp = await bot.exec("get_nearby");
  if (nearbyResp.error || !nearbyResp.result) {
    return false;
  }

  bot.trackNearbyPlayers(nearbyResp.result);
  bot.trackWildlife(nearbyResp.result);
  bot.trackRepeaters(nearbyResp.result);

  const entities = parseNearby(nearbyResp.result);
  
  const repeaters = entities.filter(e => {
    const info = detectRepeater(e);
    return info.isRepeater;
  });

  if (repeaters.length === 0) {
    return false;
  }

  ctx.log("combat", `⚠️ ${repeaters.length} repeater(s) detected nearby`);

  for (const repeater of repeaters) {
    const info = detectRepeater(repeater);
    ctx.log("combat", `  Repeater: ${info.name} (variant: ${info.variant}, tier: ${info.tier})`);

    if (settings.fleeFromSpireMonolith && shouldFleeFromRepeater(info.variant, settings)) {
      ctx.log("combat", `🚨 ${info.variant.toUpperCase()} Repeater detected — FLEEING SYSTEM IMMEDIATELY!`);
      await emergencyFleeSpam(ctx, `${info.variant} repeater detected`);
      return true;
    }

    if (canHandleRepeater(info.variant) || !settings.fleeFromSpireMonolith) {
      ctx.log("combat", `⚔️ Engaging ${info.variant} Repeater`);
      const engaged = await handleCombatWithShieldMonitor(ctx, settings, repeater);
      if (!engaged) {
        ctx.log("combat", `Failed to engage ${info.name} — may have fled or been destroyed`);
      }
      // Loot the wreck (repeaters drop valuable modules/cargo) before resuming mining.
      if (!bot.docked) {
        ctx.log("combat", `Scavenging wrecks after engaging ${info.name}`);
        const looted = await scavengeWrecks(ctx);
        if (looted > 0) {
          ctx.log("scavenge", `Looted ${looted} item stack(s) from ${info.name} wreck`);
        }
      }
      return true;
    }
  }

  return false;
}

async function fullTimeShieldMonitor(
  ctx: RoutineContext,
  settings: GlassMinerSettings,
): Promise<void> {
  if (!settings.enableFullTimeShieldMonitor) return;

  const { bot } = ctx;
  await bot.refreshShip();
  
  if (!bot.maxShield || bot.maxShield <= 0) return;

  const shieldPct = bot.shield / bot.maxShield;
  const hullPct = bot.maxHull > 0 ? bot.hull / bot.maxHull : 1;
  
  const shieldThreshold = settings.shieldMonitorThresholdPct / 100;
  const repairThreshold = settings.repairKitThresholdPct / 100;
  const fleeThreshold = settings.fleeSystemThresholdPct / 100;

  if (hullPct <= fleeThreshold) {
    ctx.log("combat", `🚨 Hull at ${Math.round(hullPct * 100)}% ≤ flee threshold (${settings.fleeSystemThresholdPct}%) — FLEEING SYSTEM!`);
    await emergencyFleeSpam(ctx, `hull critical ${Math.round(hullPct * 100)}%`);
    return;
  }

  if (shieldPct <= shieldThreshold) {
    ctx.log("combat", `🛡️ Shields at ${Math.round(shieldPct * 100)}% ≤ monitor threshold (${settings.shieldMonitorThresholdPct}%) — recharging`);
    await topUpShields(ctx, settings.shieldRechargePct / 100);
  }

  if (hullPct <= repairThreshold) {
    ctx.log("combat", `🛠️ Hull at ${Math.round(hullPct * 100)}% ≤ repair threshold (${settings.repairKitThresholdPct}%) — using repair kits`);
    await useRepairKits(ctx);
  }
}

// ── Resupply ──────────────────────────────────────────────────
async function ensureGlassMinerResupply(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;
  const settings = await getGlassMinerSettings(bot.username);

  if (!bot.docked) {
    ctx.log("trade", "Not docked - cannot resupply");
    return;
  }

  if (settings.disableResupply) {
    ctx.log("trade", "Resupply disabled — skipping repair kits, shield charges, and warp devices");
  }

  await bot.refreshLocation();
  await bot.refreshCargo();

  const weapons = await getWeaponModules(ctx);
  ctx.log("debug", `Glass Miner resupply: detected ${weapons.length} weapons`);

  const weaponAmmoTypes = new Set<string>();
  for (const w of weapons) {
    if (w.ammoType && w.ammoType !== "none") {
      weaponAmmoTypes.add(w.ammoType);
    }
  }

  let freeSpace = Math.max(0, bot.cargoMax - (bot.cargo || 0));
  if (freeSpace < 5) {
    ctx.log("trade", "Cargo almost full — skipping resupply");
    return;
  }

  const currentRepair = bot.inventory
    .filter(i => i.itemId.toLowerCase().includes("repair_kit"))
    .reduce((sum, i) => sum + (i.quantity || 0), 0);

  const currentAdvancedRepair = bot.inventory
    .filter(i => i.itemId.toLowerCase() === "advanced_repair_kit")
    .reduce((sum, i) => sum + (i.quantity || 0), 0);

  const currentFuel = bot.inventory
    .filter(i => i.itemId.toLowerCase().includes("fuel_cell"))
    .reduce((sum, i) => sum + (i.quantity || 0), 0);

  const currentShield = bot.inventory
    .filter(i => i.itemId.toLowerCase().includes("shield_charge"))
    .reduce((sum, i) => sum + (i.quantity || 0), 0);

  const desiredAmmoBoxes = settings.desiredAmmoBoxes ?? -1;
  for (const ammoType of weaponAmmoTypes) {
    let typeAmmoGotten = 0;
    const ammoIndex = catalogStore.getAmmoTypeIndex();
    const possibleAmmo = ammoIndex[ammoType] || [];
    ctx.log("debug", `Catalog ammo options for ${ammoType}: ${possibleAmmo.join(", ") || "none"}`);

    if (possibleAmmo.length === 0) {
      ctx.log("trade", `No catalog options for ${ammoType} — skipping`);
      continue;
    }

    if (desiredAmmoBoxes === 0) {
      ctx.log("trade", `Ammo withdrawal disabled (desiredAmmoBoxes=0) — skipping ${ammoType}`);
      continue;
    }

    const currentAmmoForType = bot.inventory
      .filter(i => possibleAmmo.includes(i.itemId))
      .reduce((sum, i) => sum + (i.quantity || 0), 0);

    const weaponsUsingThisAmmo = weapons.filter(w => w.ammoType === ammoType);
    const maxAmmoForType = weaponsUsingThisAmmo.length > 0
      ? Math.max(...weaponsUsingThisAmmo.map(w => w.maxAmmo || 0))
      : 0;
    let ammoToGet: number;
    if (maxAmmoForType > 50) {
      ammoToGet = Math.max(0, 20 - currentAmmoForType);
    } else if (maxAmmoForType > 0) {
      ammoToGet = Math.max(0, 40 - currentAmmoForType);
    } else {
      ammoToGet = Math.max(0, 30 - currentAmmoForType);
    }

    if (desiredAmmoBoxes > 0) {
      ammoToGet = Math.min(ammoToGet, desiredAmmoBoxes);
    }

    let chosenAmmoId: string | null = null;
    const loadedAmmo = weaponsUsingThisAmmo.find(w => w.loadedAmmoId && possibleAmmo.includes(w.loadedAmmoId));
    if (loadedAmmo && loadedAmmo.loadedAmmoId) {
      chosenAmmoId = loadedAmmo.loadedAmmoId;
      ctx.log("debug", `Preferring currently loaded ammo: ${chosenAmmoId}`);
    } else {
      chosenAmmoId = possibleAmmo[0];
    }

    if (!chosenAmmoId) {
      ctx.log("trade", `No suitable ammo found for ${ammoType} — skipping`);
      continue;
    }

    const ammoOrder = chosenAmmoId && possibleAmmo.includes(chosenAmmoId)
      ? [chosenAmmoId, ...possibleAmmo.filter(a => a !== chosenAmmoId)]
      : possibleAmmo;
    for (const ammoId of ammoOrder) {
      const ammoSize = getItemSize(ammoId);
      let actualQty = Math.min(ammoToGet, Math.floor(freeSpace / ammoSize));
      if (desiredAmmoBoxes > 0) {
        actualQty = Math.min(actualQty, desiredAmmoBoxes - typeAmmoGotten);
      }
      if (actualQty <= 0) {
        continue;
      }

      try {
        await bot.commands.spacemolt_storage.withdraw({ target: "faction", item_id: ammoId, quantity: actualQty });
        ctx.log("trade", `Withdrew ${actualQty} ${ammoId} from faction storage`);
        freeSpace -= actualQty * ammoSize;
        typeAmmoGotten += actualQty;
        break;
      } catch (e) {
        ctx.log("trade", `Failed to withdraw ${ammoId} for ${ammoType}: ${e}`);
      }
    }
  }

  const desiredRepair = settings.desiredRepairKits ?? 12;
  const desiredAdvancedRepair = settings.desiredAdvancedRepairKits ?? 10;

  if (!settings.disableResupply) {
    const repairToGet = Math.max(0, desiredRepair - currentRepair);
    if (repairToGet > 0) {
      const kitQty = Math.min(repairToGet, Math.floor(freeSpace / getItemSize("repair_kit")));
      if (kitQty > 0) {
        try {
          await bot.commands.spacemolt_storage.withdraw({ target: "faction", item_id: "advanced_repair_kit", quantity: kitQty });
          ctx.log("trade", `Withdrew ${kitQty} advanced_repair_kit from faction storage`);
          freeSpace -= kitQty * getItemSize("advanced_repair_kit");
        } catch (e) {
          ctx.log("trade", `Failed to withdraw advanced_repair_kit: ${e}`);
        }
      }
    }

    const advancedRepairToGet = Math.max(0, desiredAdvancedRepair - currentAdvancedRepair);
    if (advancedRepairToGet > 0) {
      const kitQty = Math.min(advancedRepairToGet, Math.floor(freeSpace / getItemSize("advanced_repair_kit")));
      if (kitQty > 0) {
        try {
          await bot.commands.spacemolt_storage.withdraw({ target: "faction", item_id: "advanced_repair_kit", quantity: kitQty });
          ctx.log("trade", `Withdrew ${kitQty} advanced_repair_kit from faction storage`);
          freeSpace -= kitQty * getItemSize("advanced_repair_kit");
        } catch (e) {
          ctx.log("trade", `Failed to withdraw advanced_repair_kit: ${e}`);
        }
      }
    }
  }

  const desiredShield = settings.desiredShieldCharges ?? 20;

  if (!settings.disableResupply) {
    const shieldToGet = Math.max(0, desiredShield - currentShield);
    if (shieldToGet > 0 && freeSpace >= getItemSize("shield_charge")) {
      const shQty = Math.min(shieldToGet, Math.floor(freeSpace / getItemSize("shield_charge")));
      if (shQty > 0) {
        try {
          await bot.commands.spacemolt_storage.withdraw({ target: "faction", item_id: "shield_charge", quantity: shQty });
          ctx.log("trade", `Withdrew ${shQty} shield_charge from faction storage`);
        } catch (e) {
          ctx.log("trade", `Failed to withdraw shield_charge: ${e}`);
        }
      }
    }
  }

  const desiredWarp = settings.desiredEmergencyWarpDevices ?? 3;
  const currentWarp = bot.inventory
    .filter(i => i.itemId.toLowerCase().includes("emergency_warp_device"))
    .reduce((sum, i) => sum + (i.quantity || 0), 0);
  const warpToGet = Math.max(0, desiredWarp - currentWarp);

  if (!settings.disableResupply) {
    if (warpToGet > 0 && freeSpace >= getItemSize("emergency_warp_device")) {
      try {
        await bot.commands.spacemolt_storage.withdraw({ target: "faction", item_id: "emergency_warp_device", quantity: warpToGet });
        ctx.log("trade", `Withdrew ${warpToGet} emergency_warp_device from faction storage`);
      } catch (e) {
        ctx.log("trade", `Failed to withdraw emergency_warp_device: ${e}`);
      }
    }
  }
}

// ── Glass Miner Routing Helpers ──────────────────────────────────

interface GalacticPos {
  x: number;
  y: number;
}

interface JumpResult {
  success: boolean;
  landedSystem: string;
  arrivalPos: GalacticPos | null;
  ticksTraveled: number;
}

/** Get the active route profile for this bot */
function getActiveRouteProfile(settings: GlassMinerSettings): GlassMinerRouteProfile | null {
  if (!settings.activeRouteProfile) return null;
  return settings.routeProfiles.find(p => p.name === settings.activeRouteProfile) || null;
}

/** Resolve system ID from name or ID */
function resolveSystemId(systemRef: string): string | null {
  if (!systemRef) return null;
  // Try exact match first
  if (mapStore.getSystem(systemRef)) return systemRef;
  // Try case-insensitive match
  const normalized = systemRef.toLowerCase().replace(/_/g, ' ');
  for (const sys of mapStore.getSystems()) {
    const sysName = (sys.name || sys.id).toLowerCase().replace(/_/g, ' ');
    if (sysName === normalized) return sys.id;
    if (sys.id.toLowerCase() === normalized) return sys.id;
  }
  return null;
}

/** Get galactic position for a system */
function getSystemPosition(systemId: string): GalacticPos | null {
  const sys = mapStore.getSystem(systemId);
  if (!sys?.position) return null;
  return { x: sys.position.x, y: sys.position.y };
}

/** Calculate bearing from origin system to target system */
function calculateRouteBearing(originSystemId: string, targetSystemId: string): number | undefined {
  const originPos = getSystemPosition(originSystemId);
  const targetPos = getSystemPosition(targetSystemId);
  if (!originPos || !targetPos) return undefined;
  return calculateBearingToTarget(originPos.x, originPos.y, targetPos.x, targetPos.y);
}

/** Execute a pathfinder jump at a calculated bearing */
async function executePathfinderJump(
  ctx: RoutineContext,
  bearing: number,
  originPos: GalacticPos | null
): Promise<JumpResult> {
  const result = await executePathfinderJumpToBearing(ctx, bearing, originPos, {
    waitForCompletion: true,
    midTransitWaitMs: 30000, // Wait 30 seconds mid-transit to get away from origin
  });
  return {
    success: result.success,
    landedSystem: result.landedSystem,
    arrivalPos: result.arrivalPos,
    ticksTraveled: result.ticksTraveled,
  };
}

/** Navigate through a list of systems using regular jumps */
async function navigateRouteSystems(
  ctx: RoutineContext,
  systems: string[],
  settings: GlassMinerSettings,
  direction: "outbound" | "return"
): Promise<boolean> {
  const { bot } = ctx;
  const safetyOpts = {
    fuelThresholdPct: settings.refuelThreshold,
    hullThresholdPct: settings.repairThreshold,
    autoCloak: settings.enableCloak,
    skipBlacklist: false,
    isCombatBot: true,
    joinBattles: true,
  };

  for (const systemRef of systems) {
    const systemId = resolveSystemId(systemRef);
    if (!systemId) {
      ctx.log("error", `Could not resolve system: ${systemRef}`);
      return false;
    }
    if (bot.system === systemId) {
      ctx.log("travel", `Already in ${systemId} (${direction})`);
      continue;
    }
    ctx.log("travel", `Navigating to ${systemId} (${direction})...`);
    const arrived = await navigateToSystem(ctx, systemId, safetyOpts);
    if (!arrived) {
      ctx.log("error", `Failed to reach ${systemId} on ${direction} route`);
      return false;
    }
    // Check for threats after each jump
    await fullTimeShieldMonitor(ctx, settings);
    const threatHandled = await checkAndHandleNearbyThreats(ctx, settings);
    if (threatHandled) {
      ctx.log("combat", `Threat handled during ${direction} route, continuing...`);
    }
    await ctx.sleep(2000);
  }
  return true;
}

/** Travel to a specific POI in the current system */
async function travelToPoi(ctx: RoutineContext, poiId: string, poiName: string): Promise<boolean> {
  const { bot } = ctx;
  if (bot.poi === poiId) {
    ctx.log("travel", `Already at POI ${poiName} (${poiId})`);
    return true;
  }
  ctx.log("travel", `Traveling to POI ${poiName} (${poiId})...`);
  const travelResp = await bot.exec("travel", { target_poi: poiId });
  if (travelResp.error && !travelResp.error.message.includes("already")) {
    ctx.log("error", `Travel to POI failed: ${travelResp.error.message}`);
    return false;
  }
  bot.poi = poiId;
  await ctx.sleep(2000);
  return true;
}

// ── Main Routine ──────────────────────────────────────────────
export const glassMinerRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;
  const settings = await getGlassMinerSettings(bot.username);
  
  ctx.log("info", `🔮 Glass Miner routine started for ${bot.username}`);
  ctx.log("info", `Settings: shieldRechargePct=${settings.shieldRechargePct}%, shieldMonitorThreshold=${settings.shieldMonitorThresholdPct}%, repairKitThreshold=${settings.repairKitThresholdPct}%, fleeSystemThreshold=${settings.fleeSystemThresholdPct}%`);
  ctx.log("info", `Combat: enabled=${settings.enableFighting}, fleeSpireMonolith=${settings.fleeFromSpireMonolith}, maxRepeaterTier=${settings.maxRepeaterTierToEngage}`);

  let cachedModules = await cacheShipModules(ctx);
  let fieldTestActive = await hasFieldTestMission(ctx);
  let totalMiningPower = 0;
  let hasModulatedLaser = false;

  if (settings.enableCloak) {
    await enableCloakingIfPossible(ctx, cachedModules);
  }

  while (bot.state === "running") {
    const blacklist = getMiningBlacklist(bot, settings, bot.isCloaked);
    
    await bot.refreshLocation();
    await bot.refreshShip();
    await bot.refreshCargo();

    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) { await ctx.sleep(30000); continue; }

    // Full-time shield monitoring - ALWAYS active, even while mining
    await fullTimeShieldMonitor(ctx, settings);

    // Check for nearby threats (repeaters) - this runs continuously
    const threatHandled = await checkAndHandleNearbyThreats(ctx, settings);
    if (threatHandled) {
      await ctx.sleep(2000);
      continue;
    }

    // Fuel check
    const fuelPct = bot.maxFuel > 0 ? (bot.fuel / bot.maxFuel) * 100 : 100;
    if (fuelPct <= settings.refuelThreshold && !settings.mineOnly) {
      ctx.log("system", `Fuel at ${fuelPct.toFixed(1)}% ≤ ${settings.refuelThreshold}% — refueling`);
      yield "refuel";
      await tryRefuel(ctx, { skipApprovedCheck: true });
      await bot.refreshShip();
      const newFuelPct = bot.maxFuel > 0 ? (bot.fuel / bot.maxFuel) * 100 : 100;
      if (newFuelPct <= settings.refuelThreshold) {
        await ctx.sleep(10000);
        continue;
      }
    }

    // Cargo full check
    const cargoPct = bot.cargoMax > 0 ? (bot.cargo / bot.cargoMax) * 100 : 0;
    if (cargoPct >= settings.cargoThreshold || (settings.stayOutUntilFull && cargoPct >= 95)) {
      ctx.log("system", `Cargo at ${cargoPct.toFixed(1)}% — returning to deposit`);
      yield "return_home";
      
      const activeRoute = getActiveRouteProfile(settings);
      
      // Use return route if configured in active profile
      if (activeRoute && activeRoute.returnRouteSystems && activeRoute.returnRouteSystems.length > 0) {
        ctx.log("system", `Using return route from profile: ${activeRoute.name}`);
        const routeSuccess = await navigateRouteSystems(ctx, activeRoute.returnRouteSystems, settings, "return");
        if (!routeSuccess) {
          ctx.log("error", "Return route failed — trying direct navigation to home");
        } else {
          // Check if we're home
          const homeSystem = settings.systemOre || settings.system || settings.homeSystem;
          if (homeSystem && bot.system === homeSystem) {
            await ensureDocked(ctx);
            await collectFromStorage(ctx);
            await ensureGlassMinerResupply(ctx);
            await ensureAmmoLoaded(ctx, 5, 3, 1, 25);
            await ensureUndocked(ctx);
            continue;
          }
        }
      }
      
      // Handle pathfinder return jump if configured
      if (activeRoute && activeRoute.usePathfinderJump && activeRoute.pathfinderReturnStartSystem && activeRoute.pathfinderReturnTargetSystem) {
        const startSystemId = resolveSystemId(activeRoute.pathfinderReturnStartSystem);
        const targetSystemId = resolveSystemId(activeRoute.pathfinderReturnTargetSystem);
        
        if (startSystemId && targetSystemId) {
          // Navigate to return pathfinder start system if needed
          if (bot.system !== startSystemId) {
            const safetyOpts = {
              fuelThresholdPct: 10,
              hullThresholdPct: settings.repairThreshold,
              autoCloak: settings.enableCloak,
              skipBlacklist: false,
              isCombatBot: true,
              joinBattles: true,
            };
            const arrived = await navigateToSystem(ctx, startSystemId, safetyOpts);
            if (!arrived) {
              ctx.log("error", `Could not reach pathfinder return start system ${startSystemId}`);
            }
          }
          
          if (bot.system === startSystemId) {
            let bearing = activeRoute.pathfinderReturnBearing;
            if (bearing === undefined) {
              bearing = calculateRouteBearing(startSystemId, targetSystemId);
            }
            
            if (bearing !== undefined) {
              const originPos = getSystemPosition(startSystemId);
              ctx.log("system", `Executing pathfinder return jump at bearing ${bearing.toFixed(2)}°...`);
              yield "pathfinder_return_jump";
              const jumpResult = await executePathfinderJump(ctx, bearing, originPos);
              
              if (jumpResult.success) {
                ctx.log("system", `Pathfinder return jump successful, landed in ${jumpResult.landedSystem}`);
              }
            }
          }
        }
      }
      
      // Fallback to direct navigation to home system
      const homeSystem = settings.systemOre || settings.system || settings.homeSystem;
      const homeStation = settings.depositBot;
      if (homeSystem) {
        const safetyOpts = {
          fuelThresholdPct: 10,
          hullThresholdPct: settings.repairThreshold,
          autoCloak: settings.enableCloak,
          skipBlacklist: false,
          isCombatBot: true,
          joinBattles: true,
        };
        const arrived = await navigateToSystem(ctx, homeSystem, safetyOpts);
        if (arrived) {
          await ensureDocked(ctx);
          await collectFromStorage(ctx);
          await ensureGlassMinerResupply(ctx);
          await ensureAmmoLoaded(ctx, 5, 3, 1, 25);
          await ensureUndocked(ctx);
        }
      }
      continue;
    }

    // Mine-only mode: when enabled, skip all travel. If we are already inside a
    // seam_glass POI, mine it and keep shields/hull topped up while the POI's
    // hazard zone drains them. Never navigate, jump, or travel to a POI.
    let target: { systemId: string; poiId: string; resourceId: string; poiName: string } | null = null;
    if (settings.mineOnly) {
      const mineOnlyTarget = getCurrentSeamGlassTarget(settings, bot);
      if (!mineOnlyTarget) {
        ctx.log("system", "Mine-only mode enabled — not in a seam_glass POI; holding position");
        await fullTimeShieldMonitor(ctx, settings);
        await ctx.sleep(15000);
        continue;
      }
      ctx.log("mining", `Mine-only mode — mining ${mineOnlyTarget.resourceId} at ${mineOnlyTarget.poiName} (${mineOnlyTarget.systemId})`);
      target = mineOnlyTarget;
    }

    // Detect mining type
    const detectedMiningType = await detectMiningType(ctx, cachedModules);
    let miningType: MiningType;
    if (settings.autoDetectMiningType) {
      miningType = detectedMiningType || "ore";
    } else {
      miningType = settings.miningType;
    }
    
    if (!detectedMiningType && settings.autoDetectMiningType) {
      cachedModules = await cacheShipModules(ctx);
      continue;
    }

    // Deep core capability
    const deepCoreCap = await getDeepCoreCapability(ctx, fieldTestActive);
    const useDeepCore = deepCoreCap.canMineVisibleDeepCore;
    const canMineHiddenPois = deepCoreCap.canMineHidden;
    hasModulatedLaser = await hasModulatedMiningLaser(ctx, cachedModules);
    totalMiningPower = getTotalMiningPower(cachedModules);

    // Radioactive capability
    const radioactiveCap = getRadioactiveCapabilityCached(cachedModules);
    const canMineHiddenRadioactive = miningType === "radioactive" && 
      (radioactiveCap.canMineHiddenRadioactive || 
       (radioactiveCap.canMineBasicRadioactive && await hasDeepCoreSurveyScanner(ctx)));
    const canMineHiddenIce = miningType === "ice" && deepCoreCap.hasExtractor;

    // Find mining target - use routing profile if active
    const activeRoute = getActiveRouteProfile(settings);

    // Non-mine-only modes navigate along the route profile's outbound route and
    // optional pathfinder jump before mining. Mine-only mode skips all travel.
    if (activeRoute && !settings.mineOnly) {
      ctx.log("system", `Using routing profile: ${activeRoute.name}`);
      
      // Navigate outbound route systems
      if (activeRoute.routeSystems && activeRoute.routeSystems.length > 0) {
        const routeSuccess = await navigateRouteSystems(ctx, activeRoute.routeSystems, settings, "outbound");
        if (!routeSuccess) {
          ctx.log("error", "Outbound route failed — deep sleeping");
          await ctx.sleep(settings.deepSleepIntervalMin * 60 * 1000);
          continue;
        }
      }
      
      // Handle pathfinder jump to hazardous area
      if (activeRoute.usePathfinderJump && activeRoute.pathfinderStartSystem && activeRoute.pathfinderTargetSystem) {
        const startSystemId = resolveSystemId(activeRoute.pathfinderStartSystem);
        const targetSystemId = resolveSystemId(activeRoute.pathfinderTargetSystem);
        
        if (!startSystemId || !targetSystemId) {
          ctx.log("error", "Could not resolve pathfinder start/target systems");
          await ctx.sleep(settings.deepSleepIntervalMin * 60 * 1000);
          continue;
        }
        
        // Navigate to pathfinder start system if not already there
        if (bot.system !== startSystemId) {
          ctx.log("travel", `Navigating to pathfinder start system ${startSystemId}...`);
          const safetyOpts = {
            fuelThresholdPct: settings.refuelThreshold,
            hullThresholdPct: settings.repairThreshold,
            autoCloak: settings.enableCloak,
            skipBlacklist: false,
            isCombatBot: true,
            joinBattles: true,
          };
          const arrived = await navigateToSystem(ctx, startSystemId, safetyOpts);
          if (!arrived) {
            ctx.log("error", `Could not reach pathfinder start system ${startSystemId}`);
            await ctx.sleep(settings.deepSleepIntervalMin * 60 * 1000);
            continue;
          }
        }
        
        // Calculate bearing if not provided
        let bearing = activeRoute.pathfinderBearing;
        if (bearing === undefined) {
          bearing = calculateRouteBearing(startSystemId, targetSystemId);
          if (bearing === undefined) {
            ctx.log("error", "Could not calculate bearing for pathfinder jump");
            await ctx.sleep(settings.deepSleepIntervalMin * 60 * 1000);
            continue;
          }
          ctx.log("system", `Calculated bearing: ${bearing.toFixed(2)}° from ${startSystemId} to ${targetSystemId}`);
        } else {
          ctx.log("system", `Using configured bearing: ${bearing}°`);
        }
        
        // Get origin position for pathfinder jump
        const originPos = getSystemPosition(startSystemId);
        
        // Execute pathfinder jump
        ctx.log("system", `Executing pathfinder jump at bearing ${bearing.toFixed(2)}°...`);
        yield "pathfinder_jump";
        const jumpResult = await executePathfinderJump(ctx, bearing, originPos);
        
        if (!jumpResult.success) {
          ctx.log("error", "Pathfinder jump failed — deep sleeping");
          await ctx.sleep(settings.deepSleepIntervalMin * 60 * 1000);
          continue;
        }
        
        ctx.log("system", `Pathfinder jump successful, landed in ${jumpResult.landedSystem}`);
        
        // Verify we're in the target system
        if (jumpResult.landedSystem !== targetSystemId) {
          ctx.log("warn", `Landed in ${jumpResult.landedSystem}, expected ${targetSystemId} — continuing anyway`);
        }
      }
      
      // Set target from route profile
      if (!target) {
        target = getRouteProfileTarget(settings, bot);
        if (target) {
          ctx.log("system", `Target from route profile: ${target.resourceId} at ${target.poiName} (${target.systemId})`);
        }
      }
    }

    // Fallback to automatic target finding if no route profile or profile didn't set target
    if (!target) {
      target = await findBestMiningTarget(
        ctx,
        settings,
        miningType,
        totalMiningPower,
        blacklist,
        canMineHiddenRadioactive,
        canMineHiddenIce,
        hasModulatedLaser,
        fieldTestActive,
        cachedModules
      );
    }

    if (!target) {
      ctx.log("mining", "No viable mining target found — deep sleeping");
      await ctx.sleep(settings.deepSleepIntervalMin * 60 * 1000);
      continue;
    }

    ctx.log("mining", `Target: ${target.resourceId} at ${target.poiName} (${target.systemId})`);

    // Navigate to target system (never travels in mine-only mode)
    if (!settings.mineOnly && bot.system !== target.systemId) {
      yield "navigate";
      const safetyOpts = {
        fuelThresholdPct: settings.refuelThreshold,
        hullThresholdPct: settings.repairThreshold,
        autoCloak: settings.enableCloak,
        skipBlacklist: false,
        isCombatBot: true,
        joinBattles: true,
      };
      const arrived = await navigateToSystem(ctx, target.systemId, safetyOpts);
      if (!arrived) {
        ctx.log("error", `Could not reach ${target.systemId}`);
        await ctx.sleep(30000);
        continue;
      }
    }

    // Travel to POI (never travels in mine-only mode)
    if (!settings.mineOnly && bot.poi !== target.poiId) {
      yield "travel";
      const travelResp = await bot.exec("travel", { target_poi: target.poiId });
      if (travelResp.error && !travelResp.error.message.includes("already")) {
        ctx.log("error", `Travel to POI failed: ${travelResp.error.message}`);
        await ctx.sleep(10000);
        continue;
      }
      bot.poi = target.poiId;
      await ctx.sleep(2000);
    }

    // Start mining session
    const sysData = mapStore.getSystem(target.systemId);
    const session = createMiningSession({
      botUsername: bot.username,
      miningType,
      targetResourceId: target.resourceId,
      targetResourceName: target.resourceId,
      targetSystemId: target.systemId,
      targetSystemName: sysData?.name || target.systemId,
      targetPoiId: target.poiId,
      targetPoiName: target.poiName,
      homeSystem: settings.homeSystem,
      isQuotaDriven: false,
    });
    await startMiningSession(session);

    // Register with coordination system
    if (settings.enableCoordination) {
      registerCoordinationTarget(bot.username, target.systemId, target.poiId);
    }

    // Mining loop
    let miningCycle = 0;
    while (bot.state === "running") {
      miningCycle++;
      
      // Full-time shield monitoring during mining
      await fullTimeShieldMonitor(ctx, settings);

      // Check for threats
      const threatHandled = await checkAndHandleNearbyThreats(ctx, settings);
      if (threatHandled) {
        await ctx.sleep(2000);
        continue;
      }

      // Check cargo
      await bot.refreshCargo();
      const cargoPct = bot.cargoMax > 0 ? (bot.cargo / bot.cargoMax) * 100 : 0;
      if (cargoPct >= settings.cargoThreshold || (settings.stayOutUntilFull && cargoPct >= 95)) {
        ctx.log("mining", `Cargo full (${cargoPct.toFixed(1)}%) — ending mining session`);
        break;
      }

      // Mine
      yield "mine";
      ctx.log("mining", `Mining cycle #${miningCycle} - ${target.resourceId}`);
      
      const mineResp = await runLibCommand(bot.commands.spacemolt.mine());

      // Check for battle notifications after mining
      if (mineResp.notifications && Array.isArray(mineResp.notifications)) {
        const battleState: BattleState = {
          inBattle: false,
          battleId: null,
          battleStartTick: null,
          lastHitTick: null,
          isFleeing: false,
        };
        const battleDetected = await handleBattleNotifications(ctx, mineResp.notifications, battleState);
        if (battleDetected) {
          ctx.log("combat", "Battle detected while mining - engaging!");
        }
      }

      if (mineResp.error) {
        const errMsg = mineResp.error.message.toLowerCase();
        // CRITICAL: Check for battle interrupt - stop mining immediately
        if (mineResp.error.code === "battle_interrupt" || errMsg.includes("interrupted by battle") || errMsg.includes("interrupted by combat")) {
          ctx.log("combat", `Mine interrupted by battle! ${mineResp.error.message} - engaging!`);
          continue;
        }
        
        if (errMsg.includes("depleted") || errMsg.includes("empty") || errMsg.includes("no more")) {
          ctx.log("mining", `Deposit depleted — ending session`);
          break;
        }
        if (errMsg.includes("too sparse") || errMsg.includes("deposit_too_sparse")) {
          ctx.log("error", "Deposit too sparse for current mining array — equipment power exceeds deposit density");
          break;
        }
        ctx.log("error", `Mine failed: ${mineResp.error.message}`);
        await ctx.sleep(5000);
        continue;
      }

      let { oreId, oreName } = parseOreFromMineResult(mineResp.result);

      // Self-diagnosing guard: if we still can't identify the mined resource
      // despite a successful mine, dump the raw result so the shape mismatch
      // is visible instead of silently logging "unknown".
      // Also compute the cargo delta every time — it both identifies the ore
      // AND yields the true mined quantity for harvest responses (ice/gas),
      // which return a full game-state delta with no explicit `quantity` field.
      const cargoDelta = parseOreFromCargoDelta(mineResp.result, bot.inventory, target.resourceId);
      if (!oreId && mineResp.result && typeof mineResp.result === "object") {
        const raw = mineResp.result as Record<string, unknown>;
        const keys = Object.keys(raw);
        const nested = raw.details && typeof raw.details === "object"
          ? Object.keys(raw.details as Record<string, unknown>)
          : null;
        ctx.log("debug", `parseOreFromMineResult found no ore: topKeys=${keys.join(",")}${nested ? ` detailsKeys=${nested.join(",")}` : ""}`);

        // FALLBACK: the mine response can be a full game-state delta
        // (top-level ship,cargo,queue,skills) with no details/item block.
        // Identify the mined ore by diffing the post-mine cargo against the
        // known pre-mine inventory. Falls back to the quota target resource.
        if (cargoDelta.oreId) {
          ctx.log("debug", `parseOreFromCargoDelta recovered ore: ${cargoDelta.oreId}`);
          oreId = cargoDelta.oreId;
          oreName = cargoDelta.oreName || cargoDelta.oreId;
        }
      }

      // MINING RESULT SUMMARY: Log exactly what was mined for visibility
      // The mine response may be nested under 'details' field per OpenAPI spec
      if (mineResp.result && typeof mineResp.result === "object") {
        const result = mineResp.result as Record<string, unknown>;
        const responseData = (result.details as Record<string, unknown>) || result;
        // Prefer the explicit quantity from the response. Harvest responses
        // (ice/gas) are a full game-state delta with no quantity field, so fall
        // back to the cargo-delta amount (the real mined count). Default to 1.
        const explicitQty = (responseData.quantity as number) ?? (responseData.amount as number);
        const quantity = (explicitQty != null && explicitQty > 0)
          ? explicitQty
          : (cargoDelta.oreId && cargoDelta.quantity > 0 ? cargoDelta.quantity : 1);
        const richness = (responseData.richness as number) ?? 0;
        const resourceType = (responseData.resource_type as string) ?? (responseData.type as string) ?? "";
        const poiName = (typeof responseData.poi_name === "string" ? responseData.poi_name : undefined) ?? (typeof responseData.location === "string" ? responseData.location : undefined) ?? target.poiName ?? "";
        
        // Build a detailed summary of what was mined
        const summaryParts = [`Mined ${quantity}x ${oreName || "unknown"}`];
        if (poiName) summaryParts.push(`@ ${poiName}`);
        if (richness > 0) summaryParts.push(`[richness: ${richness}]`);
        if (resourceType) summaryParts.push(`[type: ${resourceType}]`);
        if (oreId && oreId !== oreName) summaryParts.push(`[id: ${oreId}]`);
        
        ctx.log("mining", `${summaryParts.join(" ")}`);
        
        // SKILL XP DISPLAY: Show skill gains from the mine response
        const xpGained = responseData.xp_gained as Record<string, number> | undefined;
        if (xpGained && Object.keys(xpGained).length > 0) {
          const xpParts = Object.entries(xpGained)
            .map(([skill, amount]) => `${skill}: +${amount}`)
            .join(", ");
          ctx.log("mining", `Skill XP gained: ${xpParts}`);
        }
      } else if (oreId) {
        // Fallback if result structure is unexpected
        ctx.log("mining", `Mined ${oreName}`);
      }
      
      if (oreId && bot.poi) {
        mapStore.recordMiningYield(bot.system, bot.poi, { item_id: oreId, name: oreName });
        bot.stats.totalMined++;

        // JETTISON: If the mined ore is in the jettison list, dump it immediately
        const activeJettisonList = getJettisonListForMiningType(settings, miningType);
        if (activeJettisonList.includes(oreId)) {
          ctx.log("mining", `Jettisoning unwanted ${oreId}`);
          await bot.exec("jettison", { item_id: oreId, quantity: bot.inventory.find(i => i.itemId === oreId)?.quantity || 1 });
        }
      }

      // Update mining session
      await updateMiningSession(bot.username, { cyclesMined: miningCycle });
      if (oreId) {
        await updateMiningSession(bot.username, { 
          resourcesMined: { [oreId]: (session.resourcesMined[oreId] || 0) + 1 }
        });
      }

      await ctx.sleep(2000);
    }

    await completeMiningSession(bot.username);
    unregisterCoordinationTarget(bot.username, target.systemId, target.poiId);
  }
};

export default glassMinerRoutine;