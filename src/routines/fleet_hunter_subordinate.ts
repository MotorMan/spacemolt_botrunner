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
import { getBotChatChannel } from "../botmanager.js";
import type { BotChatMessage } from "../bot_chat_channel.js";
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

    ctx.log("fleet", `Received command: ${command.type} ${command.params || ""}`);
    fleetState.lastCommandTime = Date.now();
    fleetState.currentCommand = command.type;
    fleetState.commandParams = command.params || null;

    // Commands are executed by the main routine loop
  };
}

/** Create a bot chat message handler for fleet coordination. */
function createBotChatMessageHandler(ctx: RoutineContext): (message: BotChatMessage) => void {
  const { bot } = ctx;
  const settings = getFleetHunterSettings();

  return (message: BotChatMessage) => {
    // Ignore messages from ourselves
    if (message.sender === bot.username) return;

    // Only process fleet channel messages
    if (message.channel !== "fleet") return;

    // Log the message
    ctx.log("fleet", `[BOT_CHAT] ${message.sender}: ${message.content}`);

    // Handle metadata if present
    if (message.metadata?.type === "status_update") {
      const { hull, shield, fuel, system, inBattle } = message.metadata;
      ctx.log("fleet", `📊 Commander Status: Hull=${hull}% | Shield=${shield}% | Fuel=${fuel}% | System=${system} | Battle=${inBattle ? "YES" : "NO"}`);
    }
    
    // Handle commands from web UI or commander
    if (message.metadata?.command && message.metadata?.fromWebUI) {
      const cmd = message.metadata.command as string;
      const params = (message.metadata.params as string) || "";
      
      ctx.log("fleet", `🎮 Web UI Command: ${cmd} ${params}`);
      
      // Update fleet state for command execution
      fleetState.lastCommandTime = Date.now();
      fleetState.currentCommand = cmd as any;
      fleetState.commandParams = params || null;
    }
  };
}

// ── Command execution ─────────────────────────────────────────

/** Execute a MOVE command. */
async function executeMoveCommand(ctx: RoutineContext, params: string): Promise<void> {
  const moveData = parseMoveParams(params);
  if (!moveData) {
    ctx.log("error", `MOVE command has invalid params: "${params}"`);
    return;
  }
  
  if (!moveData.systemId) {
    ctx.log("error", `MOVE command has no target system! Params: "${params}"`);
    return;
  }

  const { bot } = ctx;
  const settings = getFleetHunterSettings();

  fleetState.targetSystem = moveData.systemId;
  fleetState.targetPoi = moveData.poiId || null;

  ctx.log("fleet", `Executing MOVE to ${moveData.systemId}${moveData.poiId ? "/" + moveData.poiId : ""}`);

  const safetyOpts = {
    fuelThresholdPct: settings.refuelThreshold,
    hullThresholdPct: settings.repairThreshold,
    autoCloak: settings.autoCloak,
    skipBlacklist: true, // Fleet hunters BYPASS blacklist - they hunt in pirate systems!
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
    ourBotCount: number;
    pirateCount: number;
    ourBotNames: string[];
    pirateNames: string[];
  }

  // Find which side the subordinate's bot is on
  const ourParticipant = battleStatus.participants.find(p => p.player_id === bot.username || p.username === bot.username);
  const ourSideId = ourParticipant?.side_id;

  const sideInfo: SideInfo[] = battleStatus.sides.map(side => {
    const members = battleStatus.participants.filter(p => p.side_id === side.side_id);
    // Count OUR bots on this side (not just "non-pirates")
    const ourBots = members.filter(p => {
      const u = (p.username || "").toLowerCase();
      const isOurBot = p.player_id === bot.username || p.username === bot.username ||
                      !u.includes("pirate") && !u.includes("drifter") &&
                      !u.includes("executioner") && !u.includes("sentinel") &&
                      !u.includes("prowler") && !u.includes("apex") &&
                      !u.includes("razor") && !u.includes("striker") &&
                      !u.includes("rampart") && !u.includes("stalwart") &&
                      !u.includes("bastion") && !u.includes("onslaught") &&
                      !u.includes("iron") && !u.includes("strike") &&
                      !p.username?.startsWith("[POLICE]");
      return isOurBot;
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
      ourBotCount: ourBots.length,
      pirateCount: pirates.length,
      ourBotNames: ourBots.map(p => p.username || p.player_id),
      pirateNames: pirates.map(p => p.username || p.player_id),
    };
  });

  ctx.log("combat", `📊 Sub battle analysis: ${sideInfo.map(s =>
    `Side ${s.sideId}: ${s.ourBotCount}ours [${s.ourBotNames.join(",")}] vs ${s.pirateCount}pir [${s.pirateNames.join(",")}]`
  ).join(" | ")}`);

  // POLICE check
  const hasPolice = battleStatus.participants.some(p => p.username?.startsWith("[POLICE]"));
  if (hasPolice) {
    return { shouldJoin: false, reason: "POLICE involved — staying out", pirateCount: 0 };
  }

  // Find the side OUR bot is on — that's the side to join!
  const ourSide = sideInfo.find(s => s.sideId === ourSideId);
  if (!ourSide) {
    // If we can't find our side, find ANY side with our bots
    const anySideWithUs = sideInfo.find(s => s.ourBotCount > 0);
    if (!anySideWithUs) {
      // We're in the battle but not on any side? Just join the first side with space
      return { shouldJoin: true, sideId: battleStatus.sides[0]?.side_id, reason: "Auto-joining first available side" };
    }
    return { shouldJoin: true, sideId: anySideWithUs.sideId, reason: `Joining our side (${anySideWithUs.ourBotCount} bots)` };
  }

  // Find opposing side (the one with pirates)
  const opposingSide = sideInfo.find(s => s.sideId !== ourSide.sideId);
  const opposingPirateCount = opposingSide?.pirateCount || 0;

  if (opposingPirateCount >= minPiratesToFlee) {
    return { shouldJoin: false, reason: `Too many pirates (${opposingPirateCount}) — too dangerous`, pirateCount: opposingPirateCount };
  }

  return {
    shouldJoin: true,
    sideId: ourSide.sideId,
    reason: `Joining our side ${ourSide.sideId} vs ${opposingPirateCount} pirate(s)`,
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
  // CRITICAL: Reset fleeing flag when starting a new attack
  fleetState.isFleeing = false;

  ctx.log("combat", `🎯 Subordinate engaging ${targetData.name}...`);

  // If sideId is provided, use "engage" to join the correct side
  // This ensures ALL subordinates join the SAME side as the commander
  if (targetData.sideId !== undefined) {
    ctx.log("combat", `Joining battle side ${targetData.sideId}...`);
    const engageResp = await bot.exec("battle", { action: "engage", side_id: targetData.sideId.toString() });
    if (engageResp.error) {
      ctx.log("error", `Subordinate failed to join battle side: ${engageResp.error.message}`);
      // Fallback: try attacking directly
      const attackResp = await bot.exec("attack", { target_id: targetData.id });
      if (attackResp.error) {
        ctx.log("error", `Subordinate attack also failed: ${attackResp.error.message}`);
        fleetState.currentTargetId = null;
        return;
      }
    }
  } else {
    // No sideId provided — just attack (backward compatibility)
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
 * Uses server-synced ticks: ONE command per tick, wait for response.
 * NO arbitrary tick limit - fights until victory or hull critical.
 */
async function fightSubordinateTacticalLoop(
  ctx: RoutineContext,
  targetData: { id: string; name: string },
  settings: ReturnType<typeof getFleetHunterSettings>,
): Promise<boolean> {
  const { bot } = ctx;
  let consecutiveBraceTicks = 0;
  let lastKnownEnemyZone = "outer";
  let tickCount = 0;
  let ourCurrentZone = "outer";

  while (true) {
    if (bot.state !== "running") return false;
    tickCount++;

    // CRITICAL: Reset fleeing flag when in active combat
    fleetState.isFleeing = false;

    // Use get_battle_status (FREE, no tick cost)
    const status = await getBattleStatus(ctx);
    if (!status) {
      ctx.log("combat", `✅ ${targetData.name} destroyed — subordinate victory! (${tickCount} ticks)`);
      return true;
    }

    // Check if target still alive
    const targetParticipant = status.participants.find(
      p => p.player_id === targetData.id || p.username === targetData.name
    );
    const targetStillAlive = targetParticipant && !targetParticipant.is_destroyed;

    if (!targetStillAlive && targetParticipant) {
      ctx.log("combat", `⚠️ ${targetData.name} marked destroyed but battle still active — waiting...`);
      await sleep(2000);
      continue;
    }

    await bot.refreshStatus();
    const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    const shieldPct = bot.maxShield > 0 ? Math.round((bot.shield / bot.maxShield) * 100) : 100;

    // Track enemy zone
    if (targetParticipant && targetParticipant.zone) {
      if (targetParticipant.zone !== lastKnownEnemyZone) {
        const zoneDir = { outer: 0, mid: 1, inner: 2, engaged: 3 };
        const prevDir = zoneDir[lastKnownEnemyZone as keyof typeof zoneDir] ?? 0;
        const newDir = zoneDir[targetParticipant.zone as keyof typeof zoneDir] ?? 0;
        if (newDir > prevDir) {
          ctx.log("combat", `⚠️ ${targetData.name} advancing: ${lastKnownEnemyZone} → ${targetParticipant.zone}`);
        } else if (newDir < prevDir) {
          ctx.log("combat", `${targetData.name} retreating: ${lastKnownEnemyZone} → ${targetParticipant.zone}`);
        }
        lastKnownEnemyZone = targetParticipant.zone;
      }
    }

    // Emergency flee (ONLY based on hull — NEVER flee for any other reason)
    if (hullPct <= settings.fleeThreshold) {
      ctx.log("combat", `💀 Hull critical (${hullPct}%) — subordinate fleeing!`);
      await emergencyFleeSpamSubordinate(ctx, `hull at ${hullPct}%`);
      return false;
    }

    // NOTE: Subordinates NEVER flee based on pirate count, police, or third parties.
    // They ONLY flee when hull <= fleeThreshold.
    // This is intentional — they are combat bots designed to fight.

    // Log battle state
    const enemyStance = targetParticipant?.stance || "unknown";
    const enemyZone = targetParticipant?.zone || "unknown";
    ctx.log("combat", `Sub Tick ${tickCount}: Enemy=${enemyStance}/${enemyZone} | Hull=${hullPct}% | Shields=${shieldPct}%`);

    // Decide action - use positional tactics
    const zoneDirMap = { outer: 0, mid: 1, inner: 2, engaged: 3 };
    const enemyZoneNum = zoneDirMap[enemyZone as keyof typeof zoneDirMap] ?? 0;
    const ourZoneNum = zoneDirMap[ourCurrentZone as keyof typeof zoneDirMap] ?? 0;

    // Check if fighting high-damage enemy (boss/capitol/large)
    // Note: We don't have tier info here, so we use damage-based heuristic
    const isHighDamageEnemy = false; // Could track damage per tick like hunter.ts
    const shieldsCritical = isHighDamageEnemy
      ? (shieldPct < 40 || hullPct < 50)
      : (shieldPct < 15 && hullPct < 70);

    if (shieldsCritical && consecutiveBraceTicks < 3) {
      ctx.log("combat", `🛡️ BRACE (${isHighDamageEnemy ? 'high-damage' : 'shields critical'})`);
      await bot.exec("battle", { action: "stance", stance: "brace" });
      consecutiveBraceTicks++;
    } else if (shieldsCritical && consecutiveBraceTicks >= 3) {
      ctx.log("combat", `⚔️ FIRE (braced ${consecutiveBraceTicks}, resuming)`);
      await bot.exec("battle", { action: "stance", stance: "fire" });
      consecutiveBraceTicks = 0;
    } else if (consecutiveBraceTicks > 0) {
      ctx.log("combat", `⚔️ FIRE (resuming after brace)`);
      await bot.exec("battle", { action: "stance", stance: "fire" });
      consecutiveBraceTicks = 0;
    } else {
      // Positional tactics
      if (enemyZoneNum > ourZoneNum) {
        ctx.log("combat", `⚔️ ADVANCING (enemy in ${enemyZone})`);
        await bot.exec("battle", { action: "advance" });
        ourCurrentZone = (["outer", "mid", "inner", "engaged"][Math.min(3, ourZoneNum + 1)]) as typeof ourCurrentZone;
      } else if (enemyZoneNum <= ourZoneNum && ourZoneNum > 0) {
        ctx.log("combat", `🔄 RETREAT (maintaining position)`);
        await bot.exec("battle", { action: "retreat" });
        ourCurrentZone = (["outer", "mid", "inner", "engaged"][Math.max(0, ourZoneNum - 1)]) as typeof ourCurrentZone;
      } else {
        ctx.log("combat", `⚔️ ADVANCING to engage`);
        await bot.exec("battle", { action: "advance" });
        ourCurrentZone = "mid";
      }
    }

    await sleep(2000);
  }
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

/** Execute a DOCK command. */
async function executeDockCommand(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;
  
  ctx.log("fleet", "Executing DOCK — docking at current station");
  
  // If already docked, do nothing
  if (bot.docked) {
    ctx.log("fleet", "Already docked");
    return;
  }
  
  // Dock the bot
  const dockResp = await bot.exec("dock");
  if (dockResp.error) {
    ctx.log("error", `Failed to dock: ${dockResp.error.message}`);
    return;
  }
  
  bot.docked = true;
  ctx.log("fleet", "Successfully docked");
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

  // Register bot chat message handler
  const botChatHandler = createBotChatMessageHandler(ctx);
  getBotChatChannel().onMessage(bot.username, botChatHandler);

  ctx.log("fleet", `Fleet Hunter Subordinate online — awaiting commander's orders (fleet: ${settings.fleetId})...`);

  try {
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

    // ── Process pending fleet commands (ALWAYS process commands, even if hunting disabled) ──
    yield "check_commands";
    if (fleetState.currentCommand) {
      const cmd = fleetState.currentCommand;
      const params = fleetState.commandParams || "";

      ctx.log("fleet", `🎯 Processing command: ${cmd} ${params}`);

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
        case "DOCK":
          yield "exec_dock";
          await executeDockCommand(ctx);
          break;
        default:
          ctx.log("warn", `Unknown fleet command: ${cmd}`);
      }

      fleetState.currentCommand = null;
      fleetState.commandParams = null;
      
      // After executing command, check if we should continue or wait
      // If hunting is disabled and no more commands, just wait
      const updatedSettings = getFleetHunterSettings();
      if (!updatedSettings.huntingEnabled) {
        ctx.log("fleet", "Hunting is disabled — executed command, now waiting...");
        await sleep(2000);
        continue;
      }
    }

    // ── Check if hunting is disabled (only reaches here if no commands were pending) ──
    if (!currentSettings.huntingEnabled) {
      ctx.log("fleet", "Hunting is disabled — waiting for commands...");
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
        case "DOCK":
          yield "exec_dock";
          await executeDockCommand(ctx);
          break;
        case "BATTLE_ADVANCE":
          yield "battle_advance";
          await ctx.bot.exec("battle", { action: "advance" });
          break;
        case "BATTLE_RETREAT":
          yield "battle_retreat";
          await ctx.bot.exec("battle", { action: "retreat" });
          break;
        case "BATTLE_STANCE":
          yield "battle_stance";
          const stance = params || "fire";
          await ctx.bot.exec("battle", { action: "stance", stance });
          break;
        case "BATTLE_TARGET":
          yield "battle_target";
          if (params) {
            await ctx.bot.exec("battle", { action: "target", target_id: params });
          }
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
  } finally {
    // Clean up bot chat handler
    getBotChatChannel().offMessage(bot.username, botChatHandler);
    // Unsubscribe from fleet commands
    fleetCommService.unsubscribe(settings.fleetId, bot.username, commandListener);
    ctx.log("fleet", "Fleet Hunter Subordinate offline — cleaned up handlers");
  }
};
