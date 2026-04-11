/**
 * Fleet Hunter Subordinate routine — follows a fleet commander's orders.
 *
 * Responsibilities:
 * - Listen for fleet commands via local fleet communication
 * - Follow commander's movement orders
 * - Engage targets called by commander
 * - Auto-flee if overwhelmed, then regroup
 * - Report status to commander (optional)
 *
 * Communication:
 * - Listens to local fleet comm service (no faction chat monitoring)
 * - Commands: MOVE, ATTACK, FLEE, REGROUP, HOLD, PATROL
 *
 * Settings (data/settings.json under "fleet_hunter"):
 *   fleetId           — unique identifier for this fleet (for filtering)
 *   refuelThreshold   — fuel % to trigger refuel stop (default: 40)
 *   repairThreshold   — hull % to abort and dock (default: 30)
 *   fleeThreshold     — hull % to flee active fight (default: 20)
 *   maxAttackTier     — highest pirate tier to engage (default: "large")
 *   fleeFromTier      — pirate tier that triggers flee (default: "boss")
 *   minPiratesToFlee  — number of pirates that triggers flee (default: 3)
 *   regroupSystem     — system to regroup at if disconnected (default: last known)
 */

import type { Routine, RoutineContext } from "../bot.js";
import { mapStore } from "../mapstore.js";
import { fleetCommService, parseMoveParams, parseAttackTarget, type FleetCommand } from "../fleet_comm.js";
import {
  findStation,
  isStationPoi,
  getSystemInfo,
  ensureDocked,
  ensureUndocked,
  tryRefuel,
  repairShip,
  navigateToSystem,
  fetchSecurityLevel,
  scavengeWrecks,
  ensureInsured,
  detectAndRecoverFromDeath,
  readSettings,
  sleep,
  logStatus,
  ensureFueled,
  getBattleStatus,
} from "./common.js";

// ── Settings ─────────────────────────────────────────────────

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

// ── Security level helpers ────────────────────────────────────

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

function findNearestSafeSystem(fromSystemId: string): string | null {
  const visited = new Set<string>([fromSystemId]);
  const queue: string[] = [fromSystemId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const conn of mapStore.getConnections(current)) {
      if (visited.has(conn.system_id)) continue;
      visited.add(conn.system_id);

      const secLevel = conn.security_level || mapStore.getSystem(conn.system_id)?.security_level;
      if (secLevel && secLevel.toLowerCase().includes("high")) return conn.system_id;

      queue.push(conn.system_id);
    }
  }
  return null;
}

function getFleetHunterSettings(): {
  fleetId: string;
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
} {
  const all = readSettings();
  const h = all.fleet_hunter || {};

  return {
    fleetId: (h.fleetId as string) || "default",
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

// ── Fleet command state ──────────────────────────────────────

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
function createFleetCommandListener(ctx: RoutineContext): (command: FleetCommand) => Promise<void> {
  const { bot } = ctx;
  const settings = getFleetHunterSettings();

  return async (command: FleetCommand) => {
    // Ignore if not for our fleet
    if (command.fleetId !== settings.fleetId) return;

    // Ignore if hunting is disabled (except for enable command)
    if (!settings.huntingEnabled && command.type !== "HUNTING_ENABLED") return;

    ctx.log("fleet", `Received command: ${command.type} ${command.params || ""}`);
    fleetState.lastCommandTime = Date.now();
    fleetState.currentCommand = command.type;
    fleetState.commandParams = command.params || null;

    // Commands are executed by the main routine loop
  };
}

// ── Command execution ─────────────────────────────────────────

/** Execute a MOVE command. */
async function executeMoveCommand(ctx: RoutineContext, params: string): Promise<void> {
  const moveData = parseMoveParams(params);
  if (!moveData) return;

  const { bot } = ctx;
  const settings = getFleetHunterSettings();

  fleetState.targetSystem = moveData.systemId;
  fleetState.targetPoi = moveData.poiId || null;

  ctx.log("fleet", `Executing MOVE to ${moveData.systemId}${moveData.poiId ? "/" + moveData.poiId : ""}`);

  const safetyOpts = {
    fuelThresholdPct: settings.refuelThreshold,
    hullThresholdPct: settings.repairThreshold,
    autoCloak: settings.autoCloak,
  };

  // Navigate to system
  if (bot.system !== moveData.systemId) {
    await navigateToSystem(ctx, moveData.systemId, safetyOpts);
  }

  // Travel to POI if specified
  if (moveData.poiId && bot.poi !== moveData.poiId) {
    await ensureUndocked(ctx);
    const travelResp = await bot.exec("travel", { target_poi: moveData.poiId });
    if (!travelResp.error || travelResp.error.message.includes("already")) {
      bot.poi = moveData.poiId;
    }
  }
}

// ── Combat — Tactical Fleet Subordinate Battle System ───────

/**
 * Emergency flee spam for subordinate — sends flee commands rapidly.
 */
async function emergencyFleeSpamSubordinate(ctx: RoutineContext, reason: string): Promise<void> {
  const { bot } = ctx;
  ctx.log("combat", `🚨 Subordinate EMERGENCY FLEE — ${reason}`);

  for (let i = 0; i < 5; i++) {
    await bot.exec("battle", { action: "stance", stance: "flee" });
    await bot.exec("battle", { action: "retreat" });
  }

  await sleep(5000);
  const status = await getBattleStatus(ctx);
  if (status) {
    ctx.log("combat", `⚠️ Still in battle after flee spam — trying again...`);
    for (let i = 0; i < 5; i++) {
      await bot.exec("battle", { action: "stance", stance: "flee" });
      await bot.exec("battle", { action: "retreat" });
    }
  } else {
    ctx.log("combat", `✅ Subordinate successfully disengaged`);
  }
}

/**
 * Analyze existing battle to determine if we should join and on which side.
 * Subordinate version — mirrors commander's logic.
 */
async function analyzeBattleForSubordinate(
  ctx: RoutineContext,
  minPiratesToFlee: number,
): Promise<{ shouldJoin: boolean; sideId?: number; reason: string; pirateCount: number }> {
  const { bot } = ctx;

  const battleStatus = await getBattleStatus(ctx);
  if (!battleStatus) {
    return { shouldJoin: false, reason: "No active battle detected", pirateCount: 0 };
  }

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

  ctx.log("combat", `📊 Sub battle analysis: ${sideInfo.map(s =>
    `Side ${s.sideId}: ${s.playerCount}p [${s.playerNames.join(",")}] vs ${s.pirateCount}pir [${s.pirateNames.join(",")}]`
  ).join(" | ")}`);

  // POLICE check
  const hasPolice = battleStatus.participants.some(p => p.username?.startsWith("[POLICE]"));
  if (hasPolice) {
    return { shouldJoin: false, reason: "POLICE involved — staying out", pirateCount: 0 };
  }

  // Find player vs pirate sides
  const playerVsPirateSides = sideInfo.filter(s => s.playerCount > 0 && s.pirateCount > 0);

  if (playerVsPirateSides.length === 0) {
    const nonPirateParticipants = battleStatus.participants.filter(p => {
      const u = (p.username || "").toLowerCase();
      return !u.includes("pirate") && !u.includes("drifter") && !p.username?.startsWith("[POLICE]");
    });
    if (nonPirateParticipants.length >= 2 && battleStatus.sides.length >= 2) {
      return { shouldJoin: false, reason: "PvP battle — staying out", pirateCount: 0 };
    }
    return { shouldJoin: false, reason: "Pirate vs pirate — not engaging", pirateCount: 0 };
  }

  const sideToJoin = playerVsPirateSides.find(s => s.playerCount > 0);
  if (!sideToJoin) {
    return { shouldJoin: false, reason: "Could not determine side", pirateCount: 0 };
  }

  const opposingSide = sideInfo.find(s => s.sideId !== sideToJoin.sideId);
  const opposingPirateCount = opposingSide?.pirateCount || 0;

  if (opposingPirateCount >= minPiratesToFlee) {
    return { shouldJoin: false, reason: `Too many pirates (${opposingPirateCount}) — too dangerous`, pirateCount: opposingPirateCount };
  }

  return {
    shouldJoin: true,
    sideId: sideToJoin.sideId,
    reason: `Joining side ${sideToJoin.sideId} vs ${opposingPirateCount} pirate(s)`,
    pirateCount: opposingPirateCount,
  };
}

/**
 * Execute an ATTACK command from the commander — uses proper tactical combat.
 */
async function executeAttackCommand(ctx: RoutineContext, params: string): Promise<void> {
  const targetData = parseAttackTarget(params);
  if (!targetData) return;

  const { bot } = ctx;
  const settings = getFleetHunterSettings();

  fleetState.currentTargetId = targetData.id;

  // ── STEP 1: Check for existing battles ────────────────────
  const battleStatus = await getBattleStatus(ctx);

  if (battleStatus) {
    ctx.log("combat", `⚔️ Subordinate: existing battle detected — analyzing...`);
    const analysis = await analyzeBattleForSubordinate(ctx, settings.minPiratesToFlee);

    if (!analysis.shouldJoin) {
      ctx.log("combat", `⏭️ Subordinate skipping battle: ${analysis.reason}`);
      fleetState.currentTargetId = null;
      return;
    }

    // Join battle on player's side
    ctx.log("combat", `✅ Subordinate joining battle side ${analysis.sideId}: ${analysis.reason}`);
    const engageResp = await bot.exec("battle", { action: "engage", side_id: analysis.sideId!.toString() });

    if (engageResp.error) {
      ctx.log("error", `Subordinate failed to join battle: ${engageResp.error.message}`);
      fleetState.currentTargetId = null;
      return;
    }

    // Fight in joined battle
    await fightSubordinateJoinedBattle(ctx, targetData, settings);
    fleetState.currentTargetId = null;
    return;
  }

  // ── STEP 2: No existing battle — start fresh fight ────────
  ctx.log("combat", `🎯 Subordinate engaging ${targetData.name}...`);

  // Attack the target
  const attackResp = await bot.exec("attack", { target_id: targetData.id });
  if (attackResp.error) {
    const msg = attackResp.error.message.toLowerCase();
    if (msg.includes("not found") || msg.includes("invalid") ||
        msg.includes("no target") || msg.includes("already")) {
      ctx.log("combat", `${targetData.name} unavailable — subordinate standing down`);
      fleetState.currentTargetId = null;
      return;
    }
    ctx.log("error", `Subordinate attack failed: ${attackResp.error.message}`);
    fleetState.currentTargetId = null;
    return;
  }

  ctx.log("combat", `⚔️ Subordinate battle started with ${targetData.name} — advancing`);

  // Advance to engaged (3 ticks)
  for (let zone = 0; zone < 3; zone++) {
    if (bot.state !== "running") return;

    await bot.refreshStatus();
    const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;

    if (hullPct <= settings.fleeThreshold) {
      ctx.log("combat", `💀 Hull critical (${hullPct}%) while advancing — subordinate fleeing!`);
      await emergencyFleeSpamSubordinate(ctx, "hull critical while advancing");
      fleetState.currentTargetId = null;
      return;
    }

    const advResp = await bot.exec("battle", { action: "advance" });
    if (advResp.error) {
      ctx.log("error", `Subordinate advance failed: ${advResp.error.message}`);
      break;
    }

    const zoneNames = ["mid", "inner", "engaged"];
    ctx.log("combat", `   Advanced to ${zoneNames[zone]} zone (${zone + 1}/3)`);
  }

  // Set fire stance
  await bot.exec("battle", { action: "stance", stance: "fire" });

  // Tactical combat loop
  const won = await fightSubordinateTacticalLoop(ctx, targetData, settings);
  if (!won) {
    ctx.log("combat", `Subordinate retreated from ${targetData.name}`);
  }

  fleetState.currentTargetId = null;
}

/**
 * Fight in a battle the subordinate joined via engage.
 */
async function fightSubordinateJoinedBattle(
  ctx: RoutineContext,
  targetData: { id: string; name: string },
  settings: ReturnType<typeof getFleetHunterSettings>,
): Promise<void> {
  const { bot } = ctx;

  ctx.log("combat", `🎯 Subordinate fighting in joined battle — targeting ${targetData.name}`);

  // Set target and fire stance
  await bot.exec("battle", { action: "target", target_id: targetData.id });
  await bot.exec("battle", { action: "stance", stance: "fire" });

  const won = await fightSubordinateTacticalLoop(ctx, targetData, settings);
  if (!won) {
    ctx.log("combat", `Subordinate retreated from joined battle`);
  }
}

/**
 * Core tactical combat loop for subordinates.
 * Uses get_battle_status (free), monitors for 3rd parties, manages stances.
 */
async function fightSubordinateTacticalLoop(
  ctx: RoutineContext,
  targetData: { id: string; name: string },
  settings: ReturnType<typeof getFleetHunterSettings>,
): Promise<boolean> {
  const { bot } = ctx;
  const MAX_COMBAT_TICKS = 50;
  let consecutiveBraceTicks = 0;

  for (let tick = 0; tick < MAX_COMBAT_TICKS; tick++) {
    if (bot.state !== "running") return false;

    // Use get_battle_status (FREE, no tick cost)
    const status = await getBattleStatus(ctx);
    if (!status) {
      ctx.log("combat", `✅ ${targetData.name} destroyed — subordinate victory!`);
      return true;
    }

    // Check if target still alive
    const targetStillAlive = status.participants.some(
      p => (p.player_id === targetData.id || p.username === targetData.name) && !p.is_destroyed
    );

    if (!targetStillAlive) {
      ctx.log("combat", `✅ ${targetData.name} eliminated — subordinate victory!`);
      return true;
    }

    await bot.refreshStatus();
    const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    const shieldPct = bot.maxShield > 0 ? Math.round((bot.shield / bot.maxShield) * 100) : 100;

    // Emergency flee
    if (hullPct <= settings.fleeThreshold) {
      ctx.log("combat", `💀 Hull critical (${hullPct}%) — subordinate fleeing!`);
      await emergencyFleeSpamSubordinate(ctx, `hull at ${hullPct}%`);
      return false;
    }

    // 3rd party detection
    const ourSideId = status.your_side_id;
    const hostileThirdParty = status.participants.find(p =>
      p.side_id !== ourSideId &&
      p.player_id !== bot.username &&
      p.username !== bot.username &&
      p.player_id !== targetData.id &&
      p.username !== targetData.name &&
      !p.is_destroyed &&
      !p.username?.toLowerCase().includes("pirate") &&
      !p.username?.toLowerCase().includes("drifter")
    );

    if (hostileThirdParty) {
      ctx.log("combat", `🚨 3RD PARTY: ${hostileThirdParty.username || hostileThirdParty.player_id} — subordinate fleeing!`);
      await emergencyFleeSpamSubordinate(ctx, `3rd party: ${hostileThirdParty.username || hostileThirdParty.player_id}`);
      return false;
    }

    // Stance decisions
    const shieldsCritical = shieldPct < 15 && hullPct < 70;

    if (shieldsCritical && consecutiveBraceTicks < 3) {
      ctx.log("combat", `🛡️ Tick ${tick + 1}: BRACE (shields ${shieldPct}%, hull ${hullPct}%)`);
      await bot.exec("battle", { action: "stance", stance: "brace" });
      consecutiveBraceTicks++;
    } else {
      if (consecutiveBraceTicks > 0) {
        ctx.log("combat", `⚔️ Tick ${tick + 1}: FIRE (hull ${hullPct}%, shields ${shieldPct}%)`);
      } else {
        ctx.log("combat", `⚔️ Tick ${tick + 1}: FIRE (hull ${hullPct}%, shields ${shieldPct}%)`);
      }
      await bot.exec("battle", { action: "stance", stance: "fire" });
      consecutiveBraceTicks = 0;
    }

    await sleep(2000);
  }

  ctx.log("combat", `⏱️ Subordinate combat reached max ${MAX_COMBAT_TICKS} ticks — fleeing`);
  await emergencyFleeSpamSubordinate(ctx, "max combat ticks reached");
  return false;
}

/** Execute a FLEE command. */
async function executeFleeCommand(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;

  ctx.log("fleet", "Executing FLEE — retreating immediately!");
  fleetState.isFleeing = true;

  await emergencyFleeSpamSubordinate(ctx, "fleet FLEE command received");

  // After fleeing, set regroup point
  await bot.refreshStatus();
  fleetState.regroupPoint = {
    systemId: bot.system,
    poiId: bot.poi || undefined,
  };
}

/** Execute a REGROUP command. */
async function executeRegroupCommand(ctx: RoutineContext, params: string): Promise<void> {
  const moveData = parseMoveParams(params);
  if (!moveData) return;

  const { bot } = ctx;
  const settings = getFleetHunterSettings();

  ctx.log("fleet", `Executing REGROUP at ${moveData.systemId}${moveData.poiId ? "/" + moveData.poiId : ""}`);

  fleetState.regroupPoint = {
    systemId: moveData.systemId,
    poiId: moveData.poiId,
  };

  const safetyOpts = {
    fuelThresholdPct: settings.refuelThreshold,
    hullThresholdPct: settings.repairThreshold,
    autoCloak: settings.autoCloak,
  };

  // Navigate to regroup point
  if (bot.system !== moveData.systemId) {
    await navigateToSystem(ctx, moveData.systemId, safetyOpts);
  }

  if (moveData.poiId && bot.poi !== moveData.poiId) {
    await ensureUndocked(ctx);
    const travelResp = await bot.exec("travel", { target_poi: moveData.poiId });
    if (!travelResp.error || travelResp.error.message.includes("already")) {
      bot.poi = moveData.poiId;
    }
  }

  fleetState.isFleeing = false;
}

/** Execute a HOLD command. */
async function executeHoldCommand(ctx: RoutineContext): Promise<void> {
  ctx.log("fleet", "Executing HOLD — maintaining position");
  // Just stay in current position, do nothing
}

/** Execute a PATROL command. */
async function executePatrolCommand(ctx: RoutineContext): Promise<void> {
  ctx.log("fleet", "Executing PATROL — resuming patrol pattern");
  // Clear current target, continue patrol
  fleetState.currentTargetId = null;
}

// ── Fleet Hunter Subordinate Routine ─────────────────────────

export const fleetHunterSubordinateRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  await bot.refreshStatus();

  const settings = getFleetHunterSettings();
  
  // Register with fleet comm service
  const commandListener = createFleetCommandListener(ctx);
  fleetCommService.subscribe(settings.fleetId, bot.username, commandListener);
  fleetCommService.addSubordinate(settings.fleetId, bot.username);
  
  ctx.log("fleet", `Fleet Hunter Subordinate online — awaiting commander's orders (fleet: ${settings.fleetId})...`);

  while (bot.state === "running") {
    // ── Death recovery ──
    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) {
      await sleep(30000);
      continue;
    }

    const currentSettings = getFleetHunterSettings();
    const safetyOpts = {
      fuelThresholdPct: currentSettings.refuelThreshold,
      hullThresholdPct: currentSettings.repairThreshold,
      autoCloak: currentSettings.autoCloak,
    };

    // ── Status ──
    yield "get_status";
    await bot.refreshStatus();
    logStatus(ctx);

    // ── Check if hunting is disabled ──
    if (!currentSettings.huntingEnabled) {
      ctx.log("fleet", "Hunting is disabled — waiting...");
      await sleep(5000);
      continue;
    }

    // ── In manual mode, just wait for commands ──
    if (currentSettings.manualMode) {
      ctx.log("fleet", "Manual mode active — awaiting commands");
      await sleep(2000);
    }

    // ── Process pending fleet commands ──
    yield "check_commands";
    if (fleetState.currentCommand) {
      const cmd = fleetState.currentCommand;
      const params = fleetState.commandParams || "";
      
      ctx.log("fleet", `Processing command: ${cmd} ${params}`);

      // Execute command based on type
      switch (cmd) {
        case "MOVE":
          yield "exec_move";
          await executeMoveCommand(ctx, params);
          break;
        case "ATTACK":
          yield "exec_attack";
          await executeAttackCommand(ctx, params);
          break;
        case "FLEE":
          yield "exec_flee";
          await executeFleeCommand(ctx);
          break;
        case "REGROUP":
          yield "exec_regroup";
          await executeRegroupCommand(ctx, params);
          break;
        case "HOLD":
          yield "exec_hold";
          await executeHoldCommand(ctx);
          break;
        case "PATROL":
          yield "exec_patrol";
          await executePatrolCommand(ctx);
          break;
        default:
          ctx.log("warn", `Unknown fleet command: ${cmd}`);
      }
      
      fleetState.currentCommand = null;
      fleetState.commandParams = null;
    }

    // ── Fuel check ──
    yield "fuel_check";
    const fueled = await ensureFueled(ctx, currentSettings.refuelThreshold);
    if (!fueled) {
      ctx.log("error", "Cannot secure fuel — waiting 30s...");
      await sleep(30000);
      continue;
    }

    // ── Hull check ──
    await bot.refreshStatus();
    const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    if (hullPct <= currentSettings.repairThreshold) {
      ctx.log("system", `Hull at ${hullPct}% — docking for repairs`);
      yield "emergency_repair";

      const docked = await ensureDocked(ctx);
      if (docked) {
        await repairShip(ctx);
        await tryRefuel(ctx);
        await ensureInsured(ctx);
        await ensureUndocked(ctx);
        
        // Return to regroup point after repairs
        if (fleetState.regroupPoint) {
          await executeRegroupCommand(ctx, 
            `${fleetState.regroupPoint.systemId}${fleetState.regroupPoint.poiId ? "/" + fleetState.regroupPoint.poiId : ""}`
          );
        }
      }
      continue;
    }

    // ── Auto-regroup if disconnected ──
    if (fleetState.regroupPoint && !fleetState.isFleeing) {
      if (bot.system !== fleetState.regroupPoint.systemId || 
          (fleetState.regroupPoint.poiId && bot.poi !== fleetState.regroupPoint.poiId)) {
        ctx.log("fleet", "Out of position — returning to regroup point");
        yield "auto_regroup";
        await executeRegroupCommand(ctx,
          `${fleetState.regroupPoint.systemId}${fleetState.regroupPoint.poiId ? "/" + fleetState.regroupPoint.poiId : ""}`
        );
      }
    }

    // ── Command timeout check ──
    if (fleetState.currentCommand) {
      const now = Date.now();
      if (now - fleetState.lastCommandTime > COMMAND_TIMEOUT_MS) {
        ctx.log("fleet", "Command timeout — awaiting new orders");
        fleetState.currentCommand = null;
      }
    }

    // ── Idle wait ──
    yield "wait_idle";
    await sleep(2000);
  }
};
