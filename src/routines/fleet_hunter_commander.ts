/**
 * Fleet Hunter Commander routine — leads a fleet of subordinate hunters.
 *
 * Responsibilities:
 * - Decide patrol systems and POIs
 * - Send movement commands via local fleet communication
 * - Call targets for fleet to engage
 * - Coordinate fleet positioning during combat
 * - Order retreats when danger is detected
 * - Manage post-patrol logistics (dock, repair, resupply)
 *
 * Communication:
 * - Uses local fleet comm service (no faction chat spam)
 * - Commands: MOVE, ATTACK, FLEE, REGROUP, HOLD, PATROL
 * - Optional: Also broadcast to faction chat if enableFactionBroadcast is true
 *
 * Settings (data/settings.json under "fleet_hunter"):
 *   mode                 - patrol mode: "roam_systems", "roam_system", "stationary" (default: "roam_systems")
 *   fleetId              - unique identifier for this fleet
 *   patrolSystem         - system ID to patrol (default: current system)
 *   fireMode             - "focus" or "spread" fire (default: "focus")
 *   refuelThreshold      - fuel % to trigger refuel stop (default: 40)
 *   repairThreshold      - hull % to abort patrol and dock (default: 30)
 *   fleeThreshold        - hull % to flee an active fight (default: 20)
 *   maxAttackTier        - max pirate tier to attack (default: "large")
 *   fleeFromTier         - flee from pirates above this tier (default: "boss")
 *   minPiratesToFlee     - min pirates to flee from (default: 3)
 *   autoCloak            - auto-cloak when traveling (default: false)
 *   ammoThreshold        - ammo % to trigger reload (default: 5)
 *   maxReloadAttempts    - max reload attempts (default: 3)
 *   huntingEnabled       - enable/disable hunting (default: true)
 *   manualMode           - manual control mode (default: false)
 *   enableFactionBroadcast - also send commands to faction chat (default: false)
 */

import type { Routine, RoutineContext } from "../bot.js";
import { mapStore } from "../mapstore.js";
import { fleetCommService, parseAttackTarget, type FleetCommand } from "../fleet_comm.js";
import { getBotChatChannel } from "../botmanager.js";
import type { BotChatMessage } from "../bot_chat_channel.js";

// ── Local helper functions ───────────────────────────────────

function isSafeSystem(securityLevel: string | undefined): boolean {
  if (!securityLevel) return false;
  const level = securityLevel.toLowerCase().trim();

  if (level.includes("high") || level.includes("maximum") ||
      level.includes("empire")) return true;

  if (level.includes("low") || level.includes("frontier") ||
      level.includes("lawless") || level.includes("null") ||
      level.includes("unregulated") || level.includes("medium") ||
      level.includes("minimal")) return false;

  const numeric = parseInt(level, 10);
  if (!isNaN(numeric)) return numeric > 50;
  return false;
}

function findNearestSafeSystem(fromSystemId: string): string | null {
  const visited = new Set<string>([fromSystemId]);
  const queue: string[] = [fromSystemId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const conn of mapStore.getConnections(current)) {
      if (visited.has(conn.system_id)) continue;
      visited.add(conn.system_id);

      const secLevel = conn.security_level || mapStore.getSystem(conn.system_id)?.security_level;
      if (isSafeSystem(secLevel)) return conn.system_id;

      queue.push(conn.system_id);
    }
  }
  return null;
}

async function navigateToSafeStation(ctx: RoutineContext, safetyOpts: { fuelThresholdPct: number; hullThresholdPct: number }): Promise<boolean> {
  const { bot } = ctx;

  const currentSec = mapStore.getSystem(bot.system)?.security_level;
  if (!isSafeSystem(currentSec)) {
    const safeSystem = findNearestSafeSystem(bot.system);
    if (safeSystem) {
      const sys = mapStore.getSystem(safeSystem);
      ctx.log("travel", `Heading to safe system ${sys?.name || safeSystem} (${sys?.security_level}) for repairs...`);
      const arrived = await navigateToSystem(ctx, safeSystem, safetyOpts);
      if (!arrived) {
        ctx.log("error", "Could not reach safe system — attempting local dock");
      }
    } else {
      ctx.log("info", "No safe system mapped yet — docking locally");
    }
  }

  const { pois } = await getSystemInfo(ctx);
  const station = findStation(pois, "repair") || findStation(pois);
  if (station) {
    const tResp = await bot.exec("travel", { target_poi: station.id });
    if (tResp.error && !tResp.error.message.includes("already")) {
      ctx.log("error", `Travel to station failed: ${tResp.error.message}`);
    }
    bot.poi = station.id;
  }

  const dockResp = await bot.exec("dock");
  if (dockResp.error && !dockResp.error.message.includes("already")) {
    ctx.log("error", `Dock failed: ${dockResp.error.message}`);
    return false;
  }
  bot.docked = true;
  await collectFromStorage(ctx);
  return true;
}

async function completeActiveMissions(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;
  if (!bot.docked) return;

  const activeResp = await bot.exec("get_active_missions");
  if (activeResp.error || !activeResp.result) return;

  const activeMissions = Array.isArray(activeResp.result) ? activeResp.result :
    (activeResp.result as any).missions || [];

  for (const mission of activeMissions) {
    const mResp = await bot.exec("complete_mission", { mission_id: mission.id });
    if (!mResp.error) {
      ctx.log("mission", `Completed mission: ${mission.title || mission.id}`);
    }
  }
}

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
  if (availResp.error || !availResp.result) return;

  const missions = Array.isArray(availResp.result) ? availResp.result :
    (availResp.result as any).missions || [];

  for (const mission of missions) {
    const title = (mission.title || "").toLowerCase();
    const desc = (mission.description || "").toLowerCase();
    const hasCombat = title.includes("bounty") || title.includes("pirate") || title.includes("hunt") ||
      desc.includes("bounty") || desc.includes("pirate") || desc.includes("hunt");
    if (hasCombat) {
      const aResp = await bot.exec("accept_mission", { mission_id: mission.id });
      if (!aResp.error) {
        ctx.log("mission", `Accepted combat mission: ${mission.title || mission.id}`);
        activeCount++;
        if (activeCount >= 5) break;
      }
    }
  }
}

function findNextHuntSystem(fromSystemId: string): string | null {
  const conns = mapStore.getConnections(fromSystemId);
  if (conns.length === 0) return null;

  // Priority 1: adjacent lawless/null-sec system
  for (const conn of conns) {
    const sec = (conn.security_level || mapStore.getSystem(conn.system_id)?.security_level || "").toLowerCase();
    if (sec.includes("lawless") || sec.includes("null") || sec.includes("unregulated")) {
      return conn.system_id;
    }
  }

  // Priority 2: any adjacent huntable system
  for (const conn of conns) {
    const sec = conn.security_level || mapStore.getSystem(conn.system_id)?.security_level;
    if (isHuntableSystem(sec)) return conn.system_id;
  }

  // Priority 3: unmapped adjacent system
  const unmapped = conns.find(c => !mapStore.getSystem(c.system_id)?.security_level);
  if (unmapped) return unmapped.system_id;

  return null;
}

// ── Fleet Hunter Modes ───────────────────────────────────────

export type FleetHunterMode = "roam_systems" | "roam_system" | "stationary";

import {
  findStation,
  isStationPoi,
  getSystemInfo,
  ensureDocked,
  ensureUndocked,
  tryRefuel,
  repairShip,
  ensureFueled,
  navigateToSystem,
  fetchSecurityLevel,
  scavengeWrecks,
  depositNonFuelCargo,
  ensureInsured,
  detectAndRecoverFromDeath,
  getModProfile,
  ensureModsFitted,
  readSettings,
  logStatus,
  getBattleStatus,
  fleeFromBattle,
  checkAndFleeFromBattle,
  checkBattleAfterCommand,
  type BattleState,
  handleBattleNotifications,
  writeSettings,
  collectFromStorage,
} from "./common.js";

import {
  type NearbyEntity,
  engageTarget,
  parseNearby,
  isPirateTarget,
  ensureAmmoLoaded,
} from "./battle.js";

// PirateTier is defined locally at line 47

// ── Settings ─────────────────────────────────────────

type PirateTier = "small" | "medium" | "large" | "capitol" | "boss";

const TIER_ORDER: Record<PirateTier, number> = {
  "small": 1,
  "medium": 2,
  "large": 3,
  "capitol": 4,
  "boss": 5,
};

function getTierLevel(tier: PirateTier | undefined | null): number {
  if (!tier) return 1;
  return TIER_ORDER[tier] ?? 1;
}

function isTierTooHigh(pirateTier: PirateTier | undefined, maxTier: PirateTier): boolean {
  if (!pirateTier) return false;
  return getTierLevel(pirateTier) > getTierLevel(maxTier);
}

// ── Security level helpers ─────────────────────────────────

function isHuntableSystem(securityLevel: string | undefined): boolean {
  if (!securityLevel) return false;
  const level = securityLevel.toLowerCase().trim();

  if (level.includes("low") || level.includes("frontier") ||
      level.includes("lawless") || level.includes("null") ||
      level.includes("unregulated") || level.includes("minimal")) return true;

  if (level.includes("high") || level.includes("medium") ||
      level.includes("maximum") || level.includes("empire")) return false;

  const numeric = parseInt(level, 10);
  if (!isNaN(numeric)) return numeric <= 25;

  return false;
}

function findNearestHuntableSystem(fromSystemId: string): string | null {
  // FLEET HUNTERS BYPASS SYSTEM BLACKLIST! They are combat bots that MUST enter
  // pirate-infested systems (which are often blacklisted for mining/trading bots).
  // Fleet hunters intentionally go into dangerous systems.

  // First check direct connections (1 jump away) - NO blacklist filter
  for (const conn of mapStore.getConnections(fromSystemId)) {
    const sysId = conn.system_id;
    const sys = mapStore.getSystem(sysId);
    if (sys && isHuntableSystem(sys.security_level)) return sysId;
  }

  // BFS using mapStore.findRoute - NO blacklist filter for fleet hunters
  const visited = new Set<string>([fromSystemId.toLowerCase()]);
  const queue: { systemId: string; hops: number }[] = [{ systemId: fromSystemId, hops: 0 }];

  while (queue.length > 0) {
    const { systemId, hops } = queue.shift()!;
    if (hops > 5) continue; // Limit search depth

    // findRoute without blacklist - fleet hunters can go anywhere
    const route = mapStore.findRoute(fromSystemId, systemId);
    if (route && route.length > 1) {
      const target = route[route.length - 1];
      const sys = mapStore.getSystem(target);
      if (sys && isHuntableSystem(sys.security_level)) {
        return target;
      }
    }

    for (const conn of mapStore.getConnections(systemId)) {
      const connId = conn.system_id;
      if (visited.has(connId.toLowerCase())) continue;
      visited.add(connId.toLowerCase());
      queue.push({ systemId: connId, hops: hops + 1 });
    }
  }

  // Fallback: check all known systems - NO blacklist filter
  for (const systemId of mapStore.getAllSystemIds()) {
    if (visited.has(systemId.toLowerCase())) continue;
    const sys = mapStore.getSystem(systemId);
    if (!sys || !isHuntableSystem(sys.security_level)) continue;
    return systemId;
  }

  return null;
}

interface FleetHunterSettings {
  mode: FleetHunterMode;
  fleetId: string;
  patrolSystem: string;
  fireMode: "focus" | "spread";
  refuelThreshold: number;
  repairThreshold: number;
  fleeThreshold: number;
  maxAttackTier: PirateTier;
  fleeFromTier: PirateTier;
  minPiratesToFlee: number;
  autoCloak: boolean;
  ammoThreshold: number;
  maxReloadAttempts: number;
  huntingEnabled: boolean;
  manualMode: boolean;
}

function getFleetHunterSettings(): FleetHunterSettings {
  const all = readSettings();
  const h = all.fleet_hunter || {};

  return {
    mode: ((h.mode as FleetHunterMode) || "roam_systems") as FleetHunterMode,
    fleetId: (h.fleetId as string) || "default",
    patrolSystem: (h.patrolSystem as string) || "",
    fireMode: ((h.fireMode as "focus" | "spread") || "focus") as "focus" | "spread",
    refuelThreshold: (h.refuelThreshold as number) || 40,
    repairThreshold: (h.repairThreshold as number) || 30,
    fleeThreshold: (h.fleeThreshold as number) || 20,
    maxAttackTier: ((h.maxAttackTier as PirateTier) || "large") as PirateTier,
    fleeFromTier: ((h.fleeFromTier as PirateTier) || "boss") as PirateTier,
    minPiratesToFlee: (h.minPiratesToFlee as number) || 3,
    autoCloak: (h.autoCloak as boolean) ?? false,
    ammoThreshold: (h.ammoThreshold as number) || 5,
    maxReloadAttempts: (h.maxReloadAttempts as number) || 3,
    huntingEnabled: (h.huntingEnabled as boolean) ?? true,
    manualMode: (h.manualMode as boolean) ?? false,
  };
}

/** Persist fleet hunter mode setting. */
export function setFleetHunterMode(mode: FleetHunterMode): void {
  writeSettings({
    fleet_hunter: { mode },
  });
}

// ── Fleet command state ────────────────────────────────────

interface FleetState {
  currentCommand: string | null;
  commandParams: string | null;
  lastCommandTime: number;
  targetSystem: string | null;
  targetPoi: string | null;
  currentTargetId: string | null;
  isFleeing: boolean;
  regroupPoint: { systemId: string; poiId?: string } | null;
}

const fleetState: FleetState = {
  currentCommand: null,
  commandParams: null,
  lastCommandTime: 0,
  targetSystem: null,
  targetPoi: null,
  currentTargetId: null,
  isFleeing: false,
  regroupPoint: null,
};

// ── Local fleet command listener ─────────────────────────────

const COMMAND_TIMEOUT_MS = 30000; // Commands expire after 30s

/** Create a command listener for the fleet comm service. */
function createCommanderBotChatHandler(ctx: RoutineContext): (message: BotChatMessage) => void {
  const { bot } = ctx;
  const settings = getFleetHunterSettings();

  return (message: BotChatMessage) => {
    // Ignore messages from ourselves
    if (message.sender === bot.username) return;

    // Only process fleet channel messages
    if (message.channel !== "fleet") return;

    // Log the message
    ctx.log("fleet", `[BOT_CHAT] ${message.sender}: ${message.content}`);

    // Handle commands from web UI
    if (message.metadata?.command && message.metadata?.fromWebUI) {
      const cmd = message.metadata.command as string;
      const params = (message.metadata.params as string) || "";

      ctx.log("fleet", `🎮 Web UI Command: ${cmd} ${params}`);

      // Store command for execution by main loop
      fleetState.lastCommandTime = Date.now();
      fleetState.currentCommand = cmd as any;
      fleetState.commandParams = params || null;
    }
  };
}

function createCommanderCommandListener(ctx: RoutineContext): (command: any) => void {
  const { bot } = ctx;
  const settings = getFleetHunterSettings();

  return (command: any) => {
    // Ignore if not for our fleet
    if (command.fleetId !== settings.fleetId) return;
    // Ignore if not for our bot
    if (command.botId && command.botId !== bot.username) return;

    ctx.log("fleet", `Received fleet command: ${command.type} ${command.params || ""}`);

    // Store command for execution by main loop
    fleetState.lastCommandTime = Date.now();
    fleetState.currentCommand = command.type;
    fleetState.commandParams = command.params || null;
  };
}

// ── Command helpers ────────────────────────────────────────

function parseMoveParams(params: string): { systemId: string; poiId?: string } | null {
  if (!params) return null;
  const parts = params.split("/");
  const systemId = parts[0];
  if (!systemId) return null;
  return {
    systemId,
    poiId: parts[1] || undefined,
  };
}

/** Broadcast a MOVE command to entire fleet. */
async function orderFleetMove(ctx: RoutineContext, targetSystem: string, targetPoi?: string): Promise<void> {
  const settings = getFleetHunterSettings();
  const params = targetPoi ? `${targetSystem}/${targetPoi}` : targetSystem;
  ctx.log("fleet", `Broadcasting MOVE to fleet: ${params}`);
  fleetCommService.broadcast(settings.fleetId, "MOVE", params);
}

/** Broadcast a REGROUP command to entire fleet. */
async function orderFleetRegroup(ctx: RoutineContext, targetSystem: string, targetPoi?: string): Promise<void> {
  const settings = getFleetHunterSettings();
  const params = targetPoi ? `${targetSystem}/${targetPoi}` : targetSystem;
  ctx.log("fleet", `Broadcasting REGROUP to fleet: ${params}`);
  fleetCommService.broadcast(settings.fleetId, "REGROUP", params);
}

/** Broadcast an ATTACK command with target ID and optional side ID. */
async function orderFleetAttack(ctx: RoutineContext, targetId: string, targetName: string, sideId?: number): Promise<void> {
  const settings = getFleetHunterSettings();
  const params = sideId !== undefined ? `${targetId}:${targetName}:${sideId}` : `${targetId}:${targetName}`;
  ctx.log("fleet", `Broadcasting ATTACK to fleet: ${params}`);
  fleetCommService.broadcast(settings.fleetId, "ATTACK", params);
}

// ── Battle analysis for fleet ─────────────────────────────

async function analyzeBattleForFleet(
  ctx: RoutineContext,
  minPiratesToFlee: number,
): Promise<{ shouldJoin: boolean; sideId?: number; reason: string; pirateCount: number }> {
  const { bot } = ctx;

  const battleStatus = await getBattleStatus(ctx);
  if (!battleStatus) {
    return { shouldJoin: false, reason: "No active battle detected", pirateCount: 0 };
  }

  ctx.log("combat", `📊 Fleet battle analysis: ${battleStatus.battle_id}`);
  ctx.log("combat", `   Sides: ${battleStatus.sides.length} | Participants: ${battleStatus.participants.length}`);

  // Analyze sides
  interface SideInfo {
    sideId: number;
    playerCount: number;
    pirateCount: number;
    playerNames: string[];
    pirateNames: string[];
  }

  const sideInfo: SideInfo[] = battleStatus.sides.map(side => {
    const members = battleStatus.participants.filter(p => p.side_id === side.side_id);
    const players = members.filter(p => {
      const u = (p.username || "").toLowerCase();
      return !u.includes("pirate") && !u.includes("drifter") &&
             !u.includes("executioner") && !u.includes("sentinel") &&
             !u.includes("prowler") && !u.includes("apex") &&
             !u.includes("razor") && !u.includes("striker") &&
             !u.includes("rampart") && !u.includes("stalwart") &&
             !u.includes("bastion") && !u.includes("onslaught") &&
             !u.includes("iron") && !u.includes("strike") &&
             !p.username?.startsWith("[POLICE]");
    });
    const pirates = members.filter(p => {
      const u = (p.username || "").toLowerCase();
      return u.includes("pirate") || u.includes("drifter") ||
             u.includes("executioner") || u.includes("sentinel") ||
             u.includes("prowler") || u.includes("apex") ||
             u.includes("razor") || u.includes("striker") ||
             u.includes("rampart") || u.includes("stalwart") ||
             u.includes("bastion") || u.includes("onslaught") ||
             u.includes("iron") || u.includes("strike");
    });

    return {
      sideId: side.side_id,
      playerCount: players.length,
      pirateCount: pirates.length,
      playerNames: players.map(p => p.username || p.player_id),
      pirateNames: pirates.map(p => p.username || p.player_id),
    };
  });

  ctx.log("combat", `   ${sideInfo.map(s =>
    `Side ${s.sideId}: ${s.playerCount}p [${s.playerNames.join(",")}] vs ${s.pirateCount}pir [${s.pirateNames.join(",")}]`
  ).join(" | ")}`);

  // Find player vs pirate sides
  const playerVsPirateSides = sideInfo.filter(s => s.playerCount > 0 && s.pirateCount > 0);

  if (playerVsPirateSides.length === 0) {
    // Check for PvP
    const nonPirateParticipants = battleStatus.participants.filter(p => {
      const u = (p.username || "").toLowerCase();
      return !u.includes("pirate") && !u.includes("drifter") && !p.username?.startsWith("[POLICE]");
    });
    if (nonPirateParticipants.length >= 2 && battleStatus.sides.length >= 2) {
      return { shouldJoin: false, reason: "PvP battle — fleet staying out", pirateCount: 0 };
    }
    return { shouldJoin: false, reason: "Pirate vs pirate — fleet not engaging", pirateCount: 0 };
  }

  const sideToJoin = playerVsPirateSides.find(s => s.playerCount > 0);
  if (!sideToJoin) {
    return { shouldJoin: false, reason: "Could not determine fleet's side", pirateCount: 0 };
  }

  const opposingSide = sideInfo.find(s => s.sideId !== sideToJoin.sideId);
  const opposingPirateCount = opposingSide?.pirateCount || 0;

  // NOTE: Fleet hunters NEVER flee based on pirate count or police.
  // They ONLY flee when hull <= fleeThreshold.
  // This is intentional — they are combat bots designed to fight.

  return {
    shouldJoin: true,
    sideId: sideToJoin.sideId,
    reason: `Fleet joining side ${sideToJoin.sideId} (${sideToJoin.playerCount} player(s)) vs ${opposingPirateCount} pirate(s)`,
    pirateCount: opposingPirateCount,
  };
}

// ── Main fleet combat function ───────────────────────────────

async function engageTargetFleet(
  ctx: RoutineContext,
  target: NearbyEntity,
  fleeThreshold: number,
  fleeFromTier: PirateTier,
  minPiratesToFlee: number,
): Promise<boolean> {
  const { bot } = ctx;

  if (!target.id) return false;

  // Check for existing battle
  const battleStatus = await getBattleStatus(ctx);

  let sideId: number | undefined = undefined;

  if (battleStatus) {
    ctx.log("combat", `⚔️ Existing battle detected — fleet analyzing...`);
    const analysis = await analyzeBattleForFleet(ctx, minPiratesToFlee);

    if (!analysis.shouldJoin) {
      ctx.log("combat", `⏭️ Fleet skipping battle: ${analysis.reason}`);
      return false;
    }

    sideId = analysis.sideId;
    ctx.log("combat", `✅ Fleet joining side ${sideId}: ${analysis.reason}`);

    // Join battle on player's side — both commander and fleet
    const engageResp = await bot.exec("battle", { action: "engage", side_id: sideId!.toString() });
    if (engageResp.error) {
      ctx.log("error", `Fleet failed to join battle: ${engageResp.error.message}`);
      return false;
    }

    // Order fleet to attack the target, pass side ID so they join correctly
    await orderFleetAttack(ctx, target.id, target.name, sideId);
    await ctx.sleep(1000);

    // Use engageTarget from battle.ts with sideId for commander
    return await engageTarget(ctx, target, fleeThreshold, fleeFromTier, minPiratesToFlee, "large", sideId);
  }

  // No existing battle — start fresh fight
  ctx.log("combat", `🎯 Fleet engaging ${target.name}...`);

  // Order fleet to attack
  await orderFleetAttack(ctx, target.id, target.name);
  await ctx.sleep(1000);

  // Commander attacks too (starts the battle)
  const attackResp = await bot.exec("attack", { target_id: target.id });
  if (attackResp.error) {
    const msg = attackResp.error.message.toLowerCase();
    if (msg.includes("not found") || msg.includes("invalid") ||
        msg.includes("no target") || msg.includes("already")) {
      ctx.log("combat", `${target.name} unavailable — fleet standing down`);
      return false;
    }
    ctx.log("error", `Fleet attack failed: ${attackResp.error.message}`);
    return false;
  }

  ctx.log("combat", `⚔️ Fleet battle started with ${target.name} — advancing`);

  // Use engageTarget from battle.ts (no sideId since it's a fresh battle)
  return await engageTarget(ctx, target, fleeThreshold, fleeFromTier, minPiratesToFlee, "large");
}

// ── Fleet Hunter Commander Routine ───────────────────────

export const fleetHunterCommanderRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  // Persistent battle state across cycles
  const battleRef = { state: null as BattleState | null };
  battleRef.state = {
    inBattle: false,
    battleId: null,
    battleStartTick: null,
    lastHitTick: null,
    isFleeing: false,
    lastFleeTime: undefined,
  };

  await bot.refreshStatus();

  let totalKills = 0;

  // Register as commander with fleet comm service
  const settings = getFleetHunterSettings();
  fleetCommService.setCommander(settings.fleetId, bot.username);
  ctx.log("fleet", `Registered as commander for fleet ${settings.fleetId}`);

  // Register bot chat message handler for web UI commands
  const botChatHandler = createCommanderBotChatHandler(ctx);
  getBotChatChannel().onMessage(bot.username, botChatHandler);

  // Register fleet command listener
  const commandListener = createCommanderCommandListener(ctx);
  fleetCommService.subscribe(settings.fleetId, bot.username, commandListener);

  ctx.log("fleet", `Fleet Hunter Commander online — waiting for subordinates...`);
  await ctx.sleep(3000); // Give subordinates time to join

  try {
    // Get initial settings to determine mode
    const initialSettings = getFleetHunterSettings();
    const totalKillsRef = { value: totalKills };

    // Branch based on patrol mode
    if (initialSettings.mode === "stationary") {
      yield* stationaryRoutine(ctx, totalKillsRef, battleRef);
    } else if (initialSettings.mode === "roam_system") {
      yield* roamSystemRoutine(ctx, totalKillsRef, battleRef);
    } else {
      // Default to roam_systems
      yield* roamSystemsRoutine(ctx, totalKillsRef, battleRef);
    }
  } finally {
    // Clean up handlers
    getBotChatChannel().offMessage(bot.username, botChatHandler);
    fleetCommService.unsubscribe(settings.fleetId, bot.username, commandListener);
    ctx.log("fleet", "Fleet Hunter Commander offline — cleaned up handlers");
  }
}

// ── Roam Systems Routine (patrol multiple systems) ──────────────

async function* roamSystemsRoutine(
  ctx: RoutineContext,
  totalKillsRef: { value: number },
  battleRef: { state: BattleState | null }
) {
  const { bot } = ctx;
  const totalKills = totalKillsRef.value;

  while (bot.state === "running") {
    // ── Death recovery ──
    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) {
      await ctx.sleep(30000);
      continue;
    }

    const currentSettings = getFleetHunterSettings();
    const safetyOpts = {
      fuelThresholdPct: currentSettings.refuelThreshold,
      hullThresholdPct: currentSettings.repairThreshold,
      autoCloak: currentSettings.autoCloak,
      skipBlacklist: true,
    };

    // Check for pending commands from fleet comm or web UI
    if (fleetState.currentCommand) {
      const cmd = fleetState.currentCommand;
      const params = fleetState.commandParams || "";
      const targetSystem = parseMoveParams(params)?.systemId || "";
      const targetPoi = parseMoveParams(params)?.poiId || "";

      yield `exec_${cmd.toLowerCase()}`;

      switch (cmd) {
        case "MOVE": {
              fleetState.targetSystem = targetSystem;
            fleetState.targetPoi = targetPoi;

            ctx.log("fleet", `Executing MOVE to ${targetSystem}${targetPoi ? "/" + targetPoi : ""}`);

            // Navigate to system if different
            if (bot.system !== targetSystem) {
              await orderFleetMove(ctx, targetSystem, targetPoi || undefined);
              const arrived = await navigateToSystem(ctx, targetSystem, safetyOpts);
              if (!arrived) {
                ctx.log("error", `Could not reach ${targetSystem}`);
              }
            }

            // Travel to POI if specified
            if (targetPoi && bot.poi !== targetPoi) {
              await ensureUndocked(ctx);
              const travelResp = await bot.exec("travel", { target_poi: targetPoi });
              if (!travelResp.error || travelResp.error.message.includes("already")) {
                bot.poi = targetPoi;
              }
            }
            break;
          }

          case "ATTACK": {
            yield "exec_attack";
            const targetData = parseAttackTarget(params);
            if (!targetData) break;

            // Create a NearbyEntity from targetData for engageTargetFleet
            const targetEntity: NearbyEntity = {
              id: targetData.id,
              name: targetData.name,
              type: "pirate", // Assume pirate for fleet hunters
              faction: "",
              isNPC: true,
              isPirate: true,
            };

            ctx.log("combat", `🎯 Commander engaging ${targetEntity.name}...`);

            // Use engageTargetFleet which handles everything
            const won = await engageTargetFleet(
              ctx,
              targetEntity,
              currentSettings.fleeThreshold,
              currentSettings.fleeFromTier,
              currentSettings.minPiratesToFlee,
             );
          if (won) totalKillsRef.value++;
            break;
          }

          case "FLEE": {
            yield "exec_flee";
            ctx.log("fleet", "Executing FLEE — retreating immediately!");
            await orderFleetMove(ctx, bot.system, bot.poi || undefined);
            await ctx.sleep(1000);
            yield "fleeing";
            await fleeFromBattle(ctx);
            break;
          }

          case "REGROUP": {
            yield "exec_regroup";
            const moveData = parseMoveParams(params);
            if (!moveData) break;

            ctx.log("fleet", `Executing REGROUP at ${moveData.systemId}${moveData.poiId ? "/" + moveData.poiId : ""}`);
            await orderFleetRegroup(ctx, moveData.systemId, moveData.poiId);
            await ctx.sleep(1000);

            // Navigate to regroup point
            if (bot.system !== moveData.systemId) {
              await navigateToSystem(ctx, moveData.systemId, safetyOpts);
            }
            break;
          }

          case "HOLD": {
            yield "exec_hold";
            ctx.log("fleet", "Executing HOLD — maintaining position");
            // Just stay in current position
            break;
          }

          case "PATROL": {
            yield "exec_patrol";
            ctx.log("fleet", "Executing PATROL — resuming patrol pattern");
            // Clear current target, continue patrol
            fleetState.currentTargetId = null;
            break;
          }

          case "DOCK": {
            yield "exec_dock";
            ctx.log("fleet", "Executing DOCK — docking at current station");
            if (!bot.docked) {
              const dockResp = await bot.exec("dock");
              if (dockResp.error) {
                ctx.log("error", `Failed to dock: ${dockResp.error.message}`);
              } else {
                bot.docked = true;
                ctx.log("fleet", "Successfully docked");
              }
            }
            break;
          }

          case "BATTLE_ADVANCE": {
            yield "battle_advance";
            await bot.exec("battle", { action: "advance" });
            break;
          }

          case "BATTLE_RETREAT": {
            yield "battle_retreat";
            await bot.exec("battle", { action: "retreat" });
            break;
          }

          case "BATTLE_STANCE": {
            yield "battle_stance";
            const stance = params || "fire";
            await bot.exec("battle", { action: "stance", stance });
            break;
          }

          case "BATTLE_TARGET": {
            yield "battle_target";
            if (params) {
              await bot.exec("battle", { action: "target", target_id: params });
            }
            break;
          }

          default:
            ctx.log("warn", `Unknown fleet command: ${cmd}`);
          }

          fleetState.currentCommand = null;
          fleetState.commandParams = null;

          // After executing command, check if we should continue or wait
          const updatedSettings = getFleetHunterSettings();
          if (!updatedSettings.huntingEnabled) {
            ctx.log("fleet", "Hunting is disabled — executed command, now waiting...");
            await ctx.sleep(2000);
            continue;
          }
        }

        // ── Check if hunting is disabled (only reaches here if no commands were pending) ──
        if (!currentSettings.huntingEnabled) {
          ctx.log("fleet", "Hunting is disabled — waiting for commands...");
          await ctx.sleep(5000);
          continue;
        }

        // ── In manual mode, just wait for commands ──
        if (currentSettings.manualMode) {
          ctx.log("fleet", "Manual mode active — awaiting commands");
          await ctx.sleep(2000);
          continue;
        }

         // ── Branch based on patrol mode ──
         if (currentSettings.mode === "stationary") {
           yield* stationaryRoutine(ctx, totalKillsRef, battleRef);
           continue;
         }
         if (currentSettings.mode === "roam_system") {
           yield* roamSystemRoutine(ctx, totalKillsRef, battleRef);
           continue;
         }
        // Default to roam_systems patrol logic

        // ── Fuel check ──
        yield "fuel_check";
        const fueled = await ensureFueled(ctx, currentSettings.refuelThreshold);
        if (!fueled) {
          ctx.log("error", "Cannot secure fuel — waiting 30s...");
          await ctx.sleep(30000);
          continue;
        }

        // ── Hull check ──
        await bot.refreshStatus();
        const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
        if (hullPct <= currentSettings.repairThreshold) {
          ctx.log("system", `Hull at ${hullPct}% — ordering fleet to retreat for repairs`);
          yield "emergency_repair";
          await orderFleetRegroup(ctx, bot.system);
          await ctx.sleep(1000);

          const docked = await ensureDocked(ctx);
          if (docked) {
            await repairShip(ctx);
            await tryRefuel(ctx);
            await ensureInsured(ctx);
            await ensureUndocked(ctx);

            // Order fleet to regroup at current position
            await orderFleetRegroup(ctx, bot.system, bot.poi || undefined);
          }
          continue;
        }

        // ── Navigate to patrol system ──
        yield "find_patrol_system";

        if (currentSettings.patrolSystem && bot.system !== currentSettings.patrolSystem) {
          ctx.log("travel", `Navigating to configured patrol system ${currentSettings.patrolSystem}...`);
          await orderFleetMove(ctx, currentSettings.patrolSystem);
          await ctx.sleep(1000);
          const arrived = await navigateToSystem(ctx, currentSettings.patrolSystem, safetyOpts);
          if (!arrived) {
            ctx.log("error", `Could not reach ${currentSettings.patrolSystem} — patrolling ${bot.system} instead`);
          }
        } else {
          await fetchSecurityLevel(ctx, bot.system);
          const currentSec = mapStore.getSystem(bot.system)?.security_level;
          if (!isHuntableSystem(currentSec)) {
            ctx.log("travel", `${bot.system} is ${currentSec || "unknown"} security — searching for huntable system...`);

            const huntTarget = findNearestHuntableSystem(bot.system);
            if (huntTarget) {
              const sys = mapStore.getSystem(huntTarget);
              ctx.log("travel", `Found huntable system: ${sys?.name || huntTarget} — fleet moving...`);
              await orderFleetMove(ctx, huntTarget);
              await ctx.sleep(1000);
              await navigateToSystem(ctx, huntTarget, safetyOpts);
            } else {
              ctx.log("error", "No huntable system found — waiting 30s");
              await ctx.sleep(30000);
              continue;
            }
          }
        }

        if (bot.state !== "running") break;

        // ── Confirm huntable system ──
        await fetchSecurityLevel(ctx, bot.system);
        const confirmedSec = mapStore.getSystem(bot.system)?.security_level;
        if (!isHuntableSystem(confirmedSec)) {
          ctx.log("info", `${bot.system} is ${confirmedSec || "unknown"} security — no pirates here`);
          await ctx.sleep(3000);
          continue;
        }

        // ── Get system layout ──
        yield "scan_system";
        const { pois } = await getSystemInfo(ctx);
        const station = findStation(pois);
        const patrolPois = pois.filter(p => !isStationPoi(p));

        if (patrolPois.length === 0) {
          ctx.log("info", "No non-station POIs to patrol");
          if (station) {
            await bot.exec("travel", { target_poi: station.id });
            await bot.exec("dock");
          }
          await ctx.sleep(15000);
          continue;
        }

        // ── Scan for targets ──
        yield "scan_nearby";
        const scanResp = await bot.exec("scan", { type: "nearby" });
        if (scanResp.error) {
          ctx.log("error", `Scan failed: ${scanResp.error.message}`);
          await ctx.sleep(10000);
          continue;
        }

        const nearby = scanResp.result as any;
        const entities = parseNearby(nearby);
        const pirates = entities.filter(e => e.isPirate && isPirateTarget(e, true, currentSettings.maxAttackTier));

        ctx.log("combat", `Found ${pirates.length} pirate target(s) in ${bot.system}`);

        if (pirates.length === 0) {
          ctx.log("combat", "No suitable pirate targets — patrolling POIs...");

          // Patrol POIs
          for (const poi of patrolPois) {
            if (bot.state !== "running") break;
            if (bot.docked) await ensureUndocked(ctx);

            ctx.log("travel", `Patrolling to ${poi.name || poi.id}...`);
            const travelResp = await bot.exec("travel", { target_poi: poi.id });
            if (travelResp.error) {
              ctx.log("error", `Travel to ${poi.id} failed: ${travelResp.error.message}`);
              continue;
            }
            bot.poi = poi.id;

            // Scan for targets while patrolling
            await ctx.sleep(5000);
            const scanResp2 = await bot.exec("scan", { type: "nearby" });
            if (scanResp2.error) continue;

            const nearby2 = scanResp2.result as any;
            const entities2 = parseNearby(nearby2);
            const pirates2 = entities2.filter(e => e.isPirate && isPirateTarget(e, true, currentSettings.maxAttackTier));

            if (pirates2.length > 0) {
              ctx.log("combat", `Found ${pirates2.length} pirate(s) at ${poi.name || poi.id}!`);

              // Pick target based on fire mode
              let target = pirates2[0];
              if (currentSettings.fireMode === "focus" && pirates2.length > 1) {
                // Focus fire on highest tier
                target = pirates2.reduce((a, b) => {
                  const aLevel = getTierLevel(a.tier);
                  const bLevel = getTierLevel(b.tier);
                  return aLevel >= bLevel ? a : b;
                });
              }

              ctx.log("combat", `🎯 Commander engaging ${target.name} (${target.tier || "unknown"} tier)...`);

       // Use engageTargetFleet which handles everything
       const won = await engageTargetFleet(
         ctx,
         target,
         currentSettings.fleeThreshold,
         currentSettings.fleeFromTier,
         currentSettings.minPiratesToFlee,
       );
          if (won) totalKillsRef.value++;
              break; // Break out of patrol loop to re-scan
            }

            await ctx.sleep(10000);
          }
        } else {
          ctx.log("combat", `Found ${pirates.length} pirate(s) — engaging...`);

          // Pick target based on fire mode
          let target = pirates[0];
          if (currentSettings.fireMode === "focus" && pirates.length > 1) {
            // Focus fire on highest tier
            target = pirates.reduce((a, b) => {
              const aLevel = getTierLevel(a.tier);
              const bLevel = getTierLevel(b.tier);
              return aLevel >= bLevel ? a : b;
            });
          }

          ctx.log("combat", `🎯 Commander engaging ${target.name} (${target.tier || "unknown"} tier)...`);

            // Use engageTargetFleet which handles everything
            const won = await engageTargetFleet(
              ctx,
              target,
              currentSettings.fleeThreshold,
              currentSettings.fleeFromTier,
               currentSettings.minPiratesToFlee,
             );
          if (won) totalKillsRef.value++;
      }

      await ctx.sleep(5000);
    }
  }

  // ── Roam Systems Routine (patrol multiple systems) ──────────────

async function* roamSystemsRoutine(
  ctx: RoutineContext,
  totalKillsRef: { value: number },
  battleRef: { state: BattleState | null }
) {
  const { bot } = ctx;

  while (bot.state === "running") {
    // ── Death recovery ──
    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) {
      await ctx.sleep(30000);
      continue;
    }

    const currentSettings = getFleetHunterSettings();
    const safetyOpts = {
      fuelThresholdPct: currentSettings.refuelThreshold,
      hullThresholdPct: currentSettings.repairThreshold,
      autoCloak: currentSettings.autoCloak,
      skipBlacklist: true,
    };
    const patrolSystem = currentSettings.patrolSystem || "";

    // ── Fuel check ──
    const fueled = await ensureFueled(ctx, currentSettings.refuelThreshold);
    if (!fueled) {
      ctx.log("error", "Cannot secure fuel — waiting 30s...");
      await ctx.sleep(30000);
      continue;
    }

    // ── Hull check — retreat to a high-security system to repair ──
    await bot.refreshStatus();
    const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    if (hullPct <= currentSettings.repairThreshold) {
      ctx.log("system", `Hull at ${hullPct}% — retreating to high-security system for repairs`);
      await orderFleetRegroup(ctx, bot.system, bot.poi || undefined);
      const docked = await navigateToSafeStation(ctx, safetyOpts);
      if (docked) {
        await completeActiveMissions(ctx);
        await repairShip(ctx);
        await tryRefuel(ctx);
        await checkAndAcceptMissions(ctx);
        await ensureInsured(ctx);
        await bot.checkSkills();
        await ensureUndocked(ctx);
      }
      continue;
    }

    // ── Navigate to a huntable (low/unregulated) system ──

    if (patrolSystem && bot.system !== patrolSystem) {
      ctx.log("travel", `Navigating fleet to configured patrol system ${patrolSystem}...`);
      const arrived = await navigateToSystem(ctx, patrolSystem, safetyOpts);
      if (!arrived) {
        ctx.log("error", `Could not reach ${patrolSystem} — patrolling ${bot.system} instead`);
      }
      // Order fleet to follow after system jump
      await orderFleetMove(ctx, bot.system, bot.poi || undefined);
    } else {
      await fetchSecurityLevel(ctx, bot.system);
      const currentSec = mapStore.getSystem(bot.system)?.security_level;

      if (!isHuntableSystem(currentSec)) {
        ctx.log("travel", `${bot.system} is ${currentSec || "unknown"} security — searching for a huntable system...`);

        const huntTarget = findNearestHuntableSystem(bot.system);
        if (huntTarget) {
          const sys = mapStore.getSystem(huntTarget);
          ctx.log("travel", `Found huntable system: ${sys?.name || huntTarget} (${sys?.security_level}) — navigating fleet...`);
          await navigateToSystem(ctx, huntTarget, safetyOpts);
          // Order fleet to follow after system jump
          await orderFleetMove(ctx, bot.system, bot.poi || undefined);
        } else {
          const conns = mapStore.getConnections(bot.system);
          const unmapped = conns.find(c => !mapStore.getSystem(c.system_id)?.security_level);
          const target = unmapped ?? conns[0];
          if (target) {
            ctx.log("travel", `No huntable system mapped yet — scouting ${target.system_name || target.system_id}...`);
            await navigateToSystem(ctx, target.system_id, safetyOpts);
            await getSystemInfo(ctx);
            await fetchSecurityLevel(ctx, bot.system);
            // Order fleet to follow after system jump
            await orderFleetMove(ctx, bot.system, bot.poi || undefined);
          } else {
            ctx.log("error", "No connected systems found — waiting 30s");
            await ctx.sleep(30000);
            continue;
          }
        }
      }
    }

    if (bot.state !== "running") break;

    // ── Confirm we're actually in a huntable system ──
    await fetchSecurityLevel(ctx, bot.system);
    const confirmedSec = mapStore.getSystem(bot.system)?.security_level;
    if (!isHuntableSystem(confirmedSec)) {
      ctx.log("info", `${bot.system} is ${confirmedSec || "unknown"} security — no pirates here. Will search again next cycle`);
      await ctx.sleep(3000);
      continue;
    }

    // ── Get system layout ──
    await fetchSecurityLevel(ctx, bot.system);
    const { pois } = await getSystemInfo(ctx);
    const station = findStation(pois);
    const patrolPois = pois.filter(p => !isStationPoi(p));

    if (patrolPois.length === 0) {
      ctx.log("info", "No non-station POIs to patrol — docking to refuel");
      if (station) {
        await bot.exec("travel", { target_poi: station.id });
        await bot.exec("dock");
        bot.docked = true;
        await tryRefuel(ctx);
        await ensureUndocked(ctx);
        // Order fleet to follow
        await orderFleetMove(ctx, bot.system, station.id);
      }
      continue;
    }

    ctx.log("info", `Patrolling ${patrolPois.length} POI(s) in ${bot.system}...`);

    // ── Patrol loop — visit each non-station POI ──
    let patrolKills = 0;
    let abortPatrol = false;

    for (const poi of patrolPois) {
      if (bot.state !== "running" || abortPatrol) break;

      await bot.refreshStatus();
      const midHull = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
      const midFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
      if (midHull <= currentSettings.repairThreshold) {
        ctx.log("system", `Hull at ${midHull}% — aborting patrol, heading to station`);
        abortPatrol = true;
        break;
      }
      if (midFuel < currentSettings.refuelThreshold) {
        ctx.log("system", `Fuel at ${midFuel}% — aborting patrol, heading to refuel`);
        abortPatrol = true;
        break;
      }

      // Travel to POI
      ctx.log("travel", `Patrolling ${poi.name}...`);
      const travelResp = await bot.exec("travel", { target_poi: poi.id });
      if (travelResp.error && !travelResp.error.message.includes("already")) {
        ctx.log("error", `Travel to ${poi.name} failed: ${travelResp.error.message}`);

        // Check if we're in battle - this might be why travel failed
        const battleStatus = await getBattleStatus(ctx);
        if (battleStatus) {
          ctx.log("combat", `⚠️ Battle detected during travel failure (ID: ${battleStatus.battle_id})`);
          ctx.log("combat", `Battle participants: ${battleStatus.participants.map(p => p.username || p.player_id).join(", ")}`);

          // Parse nearby entities to find the attacker
          const nearbyResp = await bot.exec("get_nearby");
          if (!nearbyResp.error) {
            bot.trackNearbyPlayers(nearbyResp.result);
            const entities = parseNearby(nearbyResp.result);
            const threats = entities.filter(e => e.isPirate && isPirateTarget(e, true, currentSettings.maxAttackTier));

            if (threats.length > 0) {
              ctx.log("combat", `🚨 Threat(s) detected: ${threats.map(t => t.name).join(", ")}`);
              // Engage the threats
              for (const threat of threats) {
                const won = await engageTargetFleet(
                  ctx,
                  threat,
                  currentSettings.fleeThreshold,
                  currentSettings.fleeFromTier,
                  currentSettings.minPiratesToFlee,
                );
                if (!won) {
                  ctx.log("combat", "Retreated from threat — aborting patrol");
                  abortPatrol = true;
                  break;
                }
              }
              if (abortPatrol) break;
            }
          }
        }
        continue;
      }
      bot.poi = poi.id;

      // Order fleet to follow
      await orderFleetMove(ctx, bot.system, bot.poi);

      // Brief pause to ensure travel fully processed (especially for jumps between systems)
      await ctx.sleep(1000);

      // Scan for targets
      const nearbyResp = await bot.exec("get_nearby");
      if (nearbyResp.error) {
        ctx.log("error", `get_nearby at ${poi.name}: ${nearbyResp.error.message}`);
        continue;
      }

      // Track player names from nearby scan
      bot.trackNearbyPlayers(nearbyResp.result);

      const entities = parseNearby(nearbyResp.result);
      const pirates = entities.filter(e => e.isPirate && isPirateTarget(e, true, currentSettings.maxAttackTier));

      if (pirates.length === 0) {
        ctx.log("combat", `No pirates at ${poi.name}`);
        await scavengeWrecks(ctx);
        continue;
      }

      ctx.log("combat", `Found ${pirates.length} pirate(s) at ${poi.name}: ${pirates.map(p => p.name).join(", ")}`);

      // Pick target based on fire mode
      let target = pirates[0];
      if (currentSettings.fireMode === "focus" && pirates.length > 1) {
        target = pirates.reduce((a, b) => {
          const aLevel = getTierLevel(a.tier);
          const bLevel = getTierLevel(b.tier);
          return aLevel >= bLevel ? a : b;
        });
      }

      ctx.log("combat", `🎯 Commander engaging ${target.name} (${target.tier || "unknown"} tier)...`);

      // Use engageTargetFleet which handles everything
      const won = await engageTargetFleet(
        ctx,
        target,
        currentSettings.fleeThreshold,
        currentSettings.fleeFromTier,
        currentSettings.minPiratesToFlee,
        currentSettings.maxAttackTier
      );

      if (won) {
        totalKillsRef.value++;
        patrolKills++;
        ctx.log("combat", `Kill #${totalKillsRef.value} — checking for new threats before looting...`);

        // CRITICAL: Check for new pirates before looting (safety first!)
        const safetyCheckResp = await bot.exec("get_nearby");
        if (!safetyCheckResp.error) {
          bot.trackNearbyPlayers(safetyCheckResp.result);
          const nearbyEntities = parseNearby(safetyCheckResp.result);
          const newThreats = nearbyEntities.filter(e =>
            e.isPirate && isPirateTarget(e, true, currentSettings.maxAttackTier) &&
            e.id !== target.id &&
            e.name !== target.name
          );

          if (newThreats.length > 0) {
            ctx.log("combat", `🚨 ${newThreats.length} new pirate(s) detected: ${newThreats.map(t => t.name).join(", ")} — engaging instead of looting!`);
            // Fight the new threats first
            for (const newThreat of newThreats) {
              if (bot.state !== "running") break;

               const newWon = await engageTargetFleet(
                 ctx,
                 newThreat,
                 currentSettings.fleeThreshold,
                 currentSettings.fleeFromTier,
                 currentSettings.minPiratesToFlee,
               );
              if (newWon) {
                totalKillsRef.value++;
                patrolKills++;
                ctx.log("combat", `Kill #${totalKillsRef.value} (additional threat)`);
              } else {
                ctx.log("combat", "Retreated from new threat — aborting patrol");
                abortPatrol = true;
                break;
              }
            }

            // After fighting new threats, check again before looting
            if (abortPatrol) break;
            ctx.log("combat", "Area clear — now looting wrecks...");
          } else {
            ctx.log("combat", "Area clear — no new threats detected");
          }
        }

        await scavengeWrecks(ctx);

        // Post-kill reload
        const hasAmmo = await ensureAmmoLoaded(ctx, currentSettings.ammoThreshold, currentSettings.maxReloadAttempts);
        if (!hasAmmo) {
          ctx.log("combat", "No ammo after kill — aborting patrol to resupply");
          abortPatrol = true;
        }

        await bot.refreshStatus();
        ctx.log("combat", `Post-fight: hull ${bot.hull}/${bot.maxHull} | ammo ${bot.ammo} | credits ${bot.credits}`);
      } else {
        ctx.log("combat", "Retreated — aborting patrol to regroup");
        abortPatrol = true;
        break;
      }
    }

    // ── Post-patrol decision ──
    await bot.refreshStatus();
    const postHull = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    const postFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;

    const needsRepair = abortPatrol || postHull <= currentSettings.repairThreshold;
    const needsFuel = postFuel < currentSettings.refuelThreshold;

    if (needsRepair || needsFuel) {
      const reason = needsRepair ? `hull ${postHull}%` : `fuel ${postFuel}%`;
      ctx.log("system", `Patrol sweep done — ${patrolKills} kill(s). Returning to safe system (${reason})...`);

      await orderFleetRegroup(ctx, bot.system, bot.poi || undefined);
      const docked = await navigateToSafeStation(ctx, safetyOpts);
      if (docked) {
        await collectFromStorage(ctx);

        await completeActiveMissions(ctx);

        // Sell loot (everything except fuel cells)
        await bot.refreshCargo();
        let unsold = false;
        for (const item of bot.inventory) {
          if (item.itemId.toLowerCase().includes("fuel") || item.itemId.toLowerCase().includes("energy_cell") || item.itemId.toLowerCase().includes("repair")) continue;
          ctx.log("trade", `Selling ${item.quantity}x ${item.name}...`);
          const sellResp = await bot.exec("sell", { item_id: item.itemId, quantity: item.quantity });
          if (sellResp.error) unsold = true;
          // yield "selling";
        }
        if (unsold) await depositNonFuelCargo(ctx);
        await bot.refreshStatus();

        await checkAndAcceptMissions(ctx);

        await ensureInsured(ctx);

        await tryRefuel(ctx);

        await repairShip(ctx);

        await ensureAmmoLoaded(ctx, currentSettings.ammoThreshold, currentSettings.maxReloadAttempts);

        const modProfile = getModProfile("hunter");
        if (modProfile.length > 0) await ensureModsFitted(ctx, modProfile);

        await bot.checkSkills();

        ctx.log("info", `=== Patrol complete. Total kills: ${totalKillsRef.value} | Credits: ${bot.credits} ===`);

      } else {
        ctx.log("error", "Could not dock anywhere — retrying next cycle");
        continue;
      }
    } else {
      ctx.log("system", `Patrol sweep done — ${patrolKills} kill(s). Hull: ${postHull}% | Fuel: ${postFuel}% — moving to next huntable system...`);

      if (!patrolSystem) {
        const nextSystem = findNextHuntSystem(bot.system);
        if (nextSystem) {
          const sys = mapStore.getSystem(nextSystem);
          ctx.log("travel", `Moving fleet to ${sys?.name || nextSystem} (${sys?.security_level || "unknown"}) to continue hunt...`);
          await navigateToSystem(ctx, nextSystem, safetyOpts);
          await getSystemInfo(ctx);
          await fetchSecurityLevel(ctx, bot.system);
          // Order fleet to follow after system jump
          await orderFleetMove(ctx, bot.system, bot.poi || undefined);
        } else {
          ctx.log("info", "No adjacent huntable system found — will search next cycle");
        }
      }
    }
  }
}

// ── Roam System Routine (stay in current system) ────────────────

async function* roamSystemRoutine(
  ctx: RoutineContext,
  totalKillsRef: { value: number },
  battleRef: { state: BattleState | null }
) {
  const { bot } = ctx;

  while (bot.state === "running") {
    // ── Death recovery ──
    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) {
      await ctx.sleep(30000);
      continue;
    }

    const currentSettings = getFleetHunterSettings();
    const safetyOpts = {
      fuelThresholdPct: currentSettings.refuelThreshold,
      hullThresholdPct: currentSettings.repairThreshold,
      autoCloak: currentSettings.autoCloak,
      skipBlacklist: true,
    };

    // ── Fuel check ──
    yield "fuel_check";
    const fueled = await ensureFueled(ctx, currentSettings.refuelThreshold);
    if (!fueled) {
      ctx.log("error", "Cannot secure fuel — waiting 30s...");
      await ctx.sleep(30000);
      continue;
    }

    // ── Hull check ──
    await bot.refreshStatus();
    const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    if (hullPct <= currentSettings.repairThreshold) {
      ctx.log("system", `Hull at ${hullPct}% — ordering fleet retreat for repairs`);
      const docked = await navigateToSafeStation(ctx, safetyOpts);
      if (docked) {
        await completeActiveMissions(ctx);
        await repairShip(ctx);
        await tryRefuel(ctx);
        await checkAndAcceptMissions(ctx);
        await ensureInsured(ctx);
        await bot.checkSkills();
        await ensureUndocked(ctx);
      }
      continue;
    }

    // ── Get system layout ──
    yield "scan_system";
    await fetchSecurityLevel(ctx, bot.system);
    const { pois } = await getSystemInfo(ctx);
    const station = findStation(pois);
    const patrolPois = pois.filter(p => !isStationPoi(p));

    if (patrolPois.length === 0) {
      ctx.log("info", "No non-station POIs to patrol — docking to refuel");
      if (station) {
        await bot.exec("travel", { target_poi: station.id });
        await bot.exec("dock");
        bot.docked = true;
        await tryRefuel(ctx);
        await ensureUndocked(ctx);
      }
      continue;
    }

    ctx.log("info", `Patrolling ${patrolPois.length} POI(s) in ${bot.system}...`);

    // ── Patrol loop — visit each non-station POI ──
    let patrolKills = 0;
    let abortPatrol = false;

    for (const poi of patrolPois) {
      if (bot.state !== "running" || abortPatrol) break;

      await bot.refreshStatus();
      const midHull = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
      const midFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
      if (midHull <= currentSettings.repairThreshold) {
        ctx.log("system", `Hull at ${midHull}% — aborting patrol, heading to station`);
        abortPatrol = true;
        break;
      }
      if (midFuel < currentSettings.refuelThreshold) {
        ctx.log("system", `Fuel at ${midFuel}% — aborting patrol, heading to refuel`);
        abortPatrol = true;
        break;
      }

      // Travel to POI
      yield "travel_to_poi";
      ctx.log("travel", `Patrolling ${poi.name}...`);
      const travelResp = await bot.exec("travel", { target_poi: poi.id });
      if (travelResp.error && !travelResp.error.message.includes("already")) {
        ctx.log("error", `Travel to ${poi.name} failed: ${travelResp.error.message}`);
        continue;
      }
      bot.poi = poi.id;

      // Order fleet to follow
      await orderFleetMove(ctx, bot.system, bot.poi);

      // Brief pause to ensure travel fully processed
      await ctx.sleep(1000);

      // Scan for targets
      yield "scan_for_targets";
      const nearbyResp = await bot.exec("get_nearby");
      if (nearbyResp.error) {
        ctx.log("error", `get_nearby at ${poi.name}: ${nearbyResp.error.message}`);
        continue;
      }

      // Track player names from nearby scan
      bot.trackNearbyPlayers(nearbyResp.result);

      const entities = parseNearby(nearbyResp.result);
      const pirates = entities.filter(e => e.isPirate && isPirateTarget(e, true, currentSettings.maxAttackTier));

      if (pirates.length === 0) {
        ctx.log("combat", `No pirates at ${poi.name}`);
        await scavengeWrecks(ctx);
        continue;
      }

      ctx.log("combat", `Found ${pirates.length} pirate(s) at ${poi.name}: ${pirates.map(p => p.name).join(", ")}`);

      // Pick target based on fire mode
      let target = pirates[0];
      if (currentSettings.fireMode === "focus" && pirates.length > 1) {
        target = pirates.reduce((a, b) => {
          const aLevel = getTierLevel(a.tier);
          const bLevel = getTierLevel(b.tier);
          return aLevel >= bLevel ? a : b;
        });
      }

      ctx.log("combat", `🎯 Commander engaging ${target.name} (${target.tier || "unknown"} tier)...`);

      // Use engageTargetFleet which handles everything
      const won = await engageTargetFleet(
        ctx,
        target,
        currentSettings.fleeThreshold,
        currentSettings.fleeFromTier,
        currentSettings.minPiratesToFlee,
        currentSettings.maxAttackTier
      );

      if (won) {
        totalKillsRef.value++;
        patrolKills++;
        ctx.log("combat", `Kill #${totalKillsRef.value} — checking for new threats before looting...`);

        // CRITICAL: Check for new pirates before looting (safety first!)
        yield "safety_check";
         const safetyCheckResp = await bot.exec("get_nearby");
         if (!safetyCheckResp.error) {
           bot.trackNearbyPlayers(safetyCheckResp.result);
           const nearbyEntities = parseNearby(safetyCheckResp.result);
           const newThreats = nearbyEntities.filter(e =>
             e.isPirate && isPirateTarget(e, true, currentSettings.maxAttackTier) &&
             e.id !== target.id &&
             e.name !== target.name
           );

           if (newThreats.length > 0) {
             ctx.log("combat", `🚨 ${newThreats.length} new pirate(s) detected: ${newThreats.map(t => t.name).join(", ")} — engaging instead of looting!`);
             // Fight the new threats first
             for (const newThreat of newThreats) {
               if (bot.state !== "running") break;

               const newWon = await engageTargetFleet(
                 ctx,
                 newThreat,
                 currentSettings.fleeThreshold,
                 currentSettings.fleeFromTier,
                 currentSettings.minPiratesToFlee,
               );
               if (newWon) {
                 totalKillsRef.value++;
                 patrolKills++;
                 ctx.log("combat", `Kill #${totalKillsRef.value} (additional threat)`);
               } else {
                 ctx.log("combat", "Retreated from new threat — aborting patrol");
                 abortPatrol = true;
                 break;
               }
             }

             // After fighting new threats, check again before looting
             if (abortPatrol) break;
             ctx.log("combat", "Area clear — now looting wrecks...");
           } else {
             ctx.log("combat", "Area clear — no new threats detected");
           }
         }

         yield "loot";
         await scavengeWrecks(ctx);

         // Post-kill reload
         const hasAmmo = await ensureAmmoLoaded(ctx, currentSettings.ammoThreshold, currentSettings.maxReloadAttempts);
         if (!hasAmmo) {
           ctx.log("combat", "No ammo after kill — aborting patrol to resupply");
           abortPatrol = true;
         }

         await bot.refreshStatus();
         ctx.log("combat", `Post-fight: hull ${bot.hull}/${bot.maxHull} | ammo ${bot.ammo} | credits ${bot.credits}`);
       } else {
         ctx.log("combat", "Retreated — aborting patrol to regroup");
         abortPatrol = true;
         break;
       }
    }

    // ── Post-patrol decision ──
    yield "post_patrol";
    await bot.refreshStatus();
    const postHull = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    const postFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;

    const needsRepair = abortPatrol || postHull <= currentSettings.repairThreshold;
    const needsFuel = postFuel < currentSettings.refuelThreshold;

    if (needsRepair || needsFuel) {
      const reason = needsRepair ? `hull ${postHull}%` : `fuel ${postFuel}%`;
      ctx.log("system", `Patrol sweep done — ${patrolKills} kill(s). Returning to safe system (${reason})...`);

      yield "dock";
      const docked = await navigateToSafeStation(ctx, safetyOpts);
      if (docked) {
        await collectFromStorage(ctx);

        yield "complete_missions";
        await completeActiveMissions(ctx);

        // Sell loot (everything except fuel cells)
        yield "sell_loot";
        await bot.refreshCargo();
        let unsold = false;
        for (const item of bot.inventory) {
          if (item.itemId.toLowerCase().includes("fuel") || item.itemId.toLowerCase().includes("energy_cell") || item.itemId.toLowerCase().includes("repair")) continue;
          ctx.log("trade", `Selling ${item.quantity}x ${item.name}...`);
          const sellResp = await bot.exec("sell", { item_id: item.itemId, quantity: item.quantity });
          if (sellResp.error) unsold = true;
          yield "selling";
        }
        if (unsold) await depositNonFuelCargo(ctx);
        await bot.refreshStatus();

        yield "check_missions";
        await checkAndAcceptMissions(ctx);

        yield "ensure_insured";
        await ensureInsured(ctx);

        yield "refuel";
        await tryRefuel(ctx);

        yield "repair";
        await repairShip(ctx);

        yield "reload";
        await ensureAmmoLoaded(ctx, currentSettings.ammoThreshold, currentSettings.maxReloadAttempts);

        yield "fit_mods";
        const modProfile = getModProfile("hunter");
        if (modProfile.length > 0) await ensureModsFitted(ctx, modProfile);

        yield "check_skills";
        await bot.checkSkills();

        ctx.log("info", `=== Patrol complete. Total kills: ${totalKillsRef.value} | Credits: ${bot.credits} ===`);
      } else {
        ctx.log("error", "Could not dock anywhere — retrying next cycle");
        continue;
      }
    } else {
      ctx.log("system", `Patrol sweep done — ${patrolKills} kill(s). Hull: ${postHull}% | Fuel: ${postFuel}% — continuing hunt in system...`);
      // In roam_system mode, we just continue the loop without moving to another system
    }
  }
}

// ── Stationary Routine (stay in one POI) ────────────────────────

async function* stationaryRoutine(
  ctx: RoutineContext,
  totalKillsRef: { value: number },
  battleRef: { state: BattleState | null }
) {
  const { bot } = ctx;

  await bot.refreshStatus();

  // Choose a POI to stay in - prefer non-station POIs
  const { pois } = await getSystemInfo(ctx);
  const nonStationPois = pois.filter(p => !isStationPoi(p));
  const targetPoi = nonStationPois.length > 0 ? nonStationPois[0] : pois[0];

  if (!targetPoi) {
    ctx.log("error", "No POIs found in system — cannot operate in stationary mode");
    return;
  }

  ctx.log("info", `Stationary mode: staying in ${targetPoi.name} (${bot.system})`);

  // Travel to the chosen POI
  if (bot.poi !== targetPoi.id) {
    const travelResp = await bot.exec("travel", { target_poi: targetPoi.id });
    if (travelResp.error && !travelResp.error.message.includes("already")) {
      ctx.log("error", `Failed to travel to ${targetPoi.name}: ${travelResp.error.message}`);
      return;
    }
    bot.poi = targetPoi.id;
  }

  // Order fleet to follow
  await orderFleetMove(ctx, bot.system, bot.poi);

  while (bot.state === "running") {
    // ── Death recovery ──
    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) {
      await ctx.sleep(30000);
      continue;
    }

    const currentSettings = getFleetHunterSettings();
    const safetyOpts = {
      fuelThresholdPct: currentSettings.refuelThreshold,
      hullThresholdPct: currentSettings.repairThreshold,
      autoCloak: currentSettings.autoCloak,
      skipBlacklist: true,
    };

    // ── Fuel check ──
    yield "fuel_check";
    const fueled = await ensureFueled(ctx, currentSettings.refuelThreshold);
    if (!fueled) {
      ctx.log("error", "Cannot secure fuel — waiting 30s...");
      await ctx.sleep(30000);
      continue;
    }

    // ── Hull check ──
    await bot.refreshStatus();
    const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    if (hullPct <= currentSettings.repairThreshold) {
      ctx.log("system", `Hull at ${hullPct}% — ordering fleet retreat for repairs`);
      await orderFleetRegroup(ctx, bot.system, bot.poi);
      const docked = await navigateToSafeStation(ctx, safetyOpts);
      if (docked) {
        await completeActiveMissions(ctx);
        await repairShip(ctx);
        await tryRefuel(ctx);
        await checkAndAcceptMissions(ctx);
        await ensureInsured(ctx);
        await bot.checkSkills();
        await ensureUndocked(ctx);
        // Order fleet back to POI
        await orderFleetMove(ctx, bot.system, bot.poi);
      }
      continue;
    }

    // ── Wait and scan for targets ──
    ctx.log("info", `Waiting for targets at ${targetPoi.name}...`);
    yield "scan_for_targets";
    const nearbyResp = await bot.exec("get_nearby");
    if (nearbyResp.error) {
      ctx.log("error", `get_nearby failed: ${nearbyResp.error.message}`);
      await ctx.sleep(10000);
      continue;
    }

    // Track player names from nearby scan
    bot.trackNearbyPlayers(nearbyResp.result);

    const entities = parseNearby(nearbyResp.result);
    const pirates = entities.filter(e => e.isPirate && isPirateTarget(e, true, currentSettings.maxAttackTier));

    if (pirates.length === 0) {
      ctx.log("combat", `No pirates detected at ${targetPoi.name}`);
      await scavengeWrecks(ctx);
      await ctx.sleep(30000); // Wait 30 seconds before next scan
      continue;
    }

    ctx.log("combat", `Found ${pirates.length} pirate(s) at ${targetPoi.name}: ${pirates.map(p => p.name).join(", ")}`);

    // Pick target based on fire mode
    let target = pirates[0];
    if (currentSettings.fireMode === "focus" && pirates.length > 1) {
      target = pirates.reduce((a, b) => {
        const aLevel = getTierLevel(a.tier);
        const bLevel = getTierLevel(b.tier);
        return aLevel >= bLevel ? a : b;
      });
    }

    ctx.log("combat", `🎯 Commander engaging ${target.name} (${target.tier || "unknown"} tier)...`);

      // Use engageTargetFleet which handles everything
      const won = await engageTargetFleet(
        ctx,
        target,
        currentSettings.fleeThreshold,
        currentSettings.fleeFromTier,
        currentSettings.minPiratesToFlee,
      );

      if (won) {
        totalKillsRef.value++;
        ctx.log("combat", `Kill #${totalKillsRef.value} — checking for more threats...`);

      // Safety check for more threats
      yield "safety_check";
      const safetyCheckResp = await bot.exec("get_nearby");
      if (!safetyCheckResp.error) {
        bot.trackNearbyPlayers(safetyCheckResp.result);
        const nearbyEntities = parseNearby(safetyCheckResp.result);
        const newThreats = nearbyEntities.filter(e =>
          e.isPirate && isPirateTarget(e, true, currentSettings.maxAttackTier) &&
          e.id !== target.id &&
          e.name !== target.name
        );

        if (newThreats.length > 0) {
          ctx.log("combat", `🚨 ${newThreats.length} more pirate(s) detected: ${newThreats.map(t => t.name).join(", ")} — engaging!`);
          for (const newThreat of newThreats) {
            if (bot.state !== "running") break;

                const newWon = await engageTargetFleet(
                  ctx,
                  newThreat,
                  currentSettings.fleeThreshold,
                  currentSettings.fleeFromTier,
                  currentSettings.minPiratesToFlee,
                );
            if (newWon) {
              totalKillsRef.value++;
              ctx.log("combat", `Kill #${totalKillsRef.value} (additional threat)`);
            } else {
              ctx.log("combat", "Retreated from new threat");
              break;
            }
          }
        } else {
          ctx.log("combat", "Area clear — no more threats detected");
        }
      }

      yield "loot";
      await scavengeWrecks(ctx);

      // Post-kill reload
      const hasAmmo = await ensureAmmoLoaded(ctx, currentSettings.ammoThreshold, currentSettings.maxReloadAttempts);
      if (!hasAmmo) {
        ctx.log("combat", "Out of ammo — ordering fleet retreat to resupply");
        await orderFleetRegroup(ctx, bot.system, bot.poi);
        const docked = await navigateToSafeStation(ctx, safetyOpts);
        if (docked) {
          await tryRefuel(ctx);
          await ensureAmmoLoaded(ctx, currentSettings.ammoThreshold, currentSettings.maxReloadAttempts);
          await ensureUndocked(ctx);
          await orderFleetMove(ctx, bot.system, bot.poi);
        }
      }

      await bot.refreshStatus();
      ctx.log("combat", `Post-fight: hull ${bot.hull}/${bot.maxHull} | credits ${bot.credits}`);
    } else {
      ctx.log("combat", "Retreated — ordering fleet regroup");
      await orderFleetRegroup(ctx, bot.system, bot.poi);
    }
  }
}
