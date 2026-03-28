/**
 * Fleet Hunter Subordinate routine — follows a fleet commander's orders.
 *
 * Responsibilities:
 * - Listen for fleet commands via faction chat
 * - Follow commander's movement orders
 * - Engage targets called by commander
 * - Auto-flee if overwhelmed, then regroup
 * - Report status to commander (optional)
 *
 * Communication:
 * - Listens to faction chat for commands
 * - Format: [FLEET <fleetId>] <COMMAND> <params>
 * - Commands: MOVE, ATTACK, FLEE, REGROUP, HOLD, PATROL
 *
 * Settings (data/settings.json under "fleet_hunter"):
 *   fleetId           — unique identifier for this fleet (for chat filtering)
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
  };
}

// ── Fleet command parsing ─────────────────────────────────────

interface FleetCommand {
  command: string;
  params: string;
  fleetId: string;
}

/** Parse a faction chat message for fleet commands. */
function parseFleetCommand(content: string): FleetCommand | null {
  // Format: [FLEET <fleetId>] <COMMAND> <params>
  const match = content.match(/\[FLEET\s+([^\]]+)\]\s+(\w+)\s*(.*)/i);
  if (!match) return null;

  return {
    fleetId: match[1].trim(),
    command: match[2].trim().toUpperCase(),
    params: match[3]?.trim() || "",
  };
}

/** Check if a command is for our fleet. */
function isCommandForUs(command: FleetCommand, ourFleetId: string): boolean {
  return command.fleetId.toLowerCase() === ourFleetId.toLowerCase();
}

/** Parse target from ATTACK command params (format: "targetId:targetName"). */
function parseAttackTarget(params: string): { id: string; name: string } | null {
  const parts = params.split(":");
  if (parts.length < 1 || !parts[0]) return null;
  return {
    id: parts[0],
    name: parts[1] || parts[0],
  };
}

/** Parse MOVE/REGROUP params (format: "systemId" or "systemId/poiId"). */
function parseMoveParams(params: string): { systemId: string; poiId?: string } | null {
  if (!params) return null;
  const parts = params.split("/");
  return {
    systemId: parts[0],
    poiId: parts[1] || undefined,
  };
}

// ── Fleet command state ──────────────────────────────────────

interface FleetState {
  currentCommand: FleetCommand | null;
  lastCommandTime: number;
  targetSystem: string | null;
  targetPoi: string | null;
  currentTargetId: string | null;
  isFleeing: boolean;
  regroupPoint: { systemId: string; poiId?: string } | null;
}

const fleetState: FleetState = {
  currentCommand: null,
  lastCommandTime: 0,
  targetSystem: null,
  targetPoi: null,
  currentTargetId: null,
  isFleeing: false,
  regroupPoint: null,
};

// ── Faction chat monitoring ───────────────────────────────────

const COMMAND_TIMEOUT_MS = 30000; // Commands expire after 30s

/** Check faction chat for new fleet commands. */
async function checkFleetCommands(ctx: RoutineContext): Promise<FleetCommand | null> {
  const { bot } = ctx;
  const settings = getFleetHunterSettings();

  const chatResp = await bot.exec("get_chat_history", { channel: "faction", limit: 20 });
  if (chatResp.error || !chatResp.result) return null;

  const r = chatResp.result as Record<string, unknown>;
  const msgs = (
    Array.isArray(chatResp.result) ? chatResp.result :
    Array.isArray(r.messages) ? r.messages :
    Array.isArray(r.history) ? r.history :
    []
  ) as Array<Record<string, unknown>>;

  // Walk from newest to oldest
  for (const msg of [...msgs].reverse()) {
    const content = (msg.content as string) || (msg.message as string) || (msg.text as string) || "";
    const fleetCmd = parseFleetCommand(content);
    
    if (!fleetCmd) continue;
    if (!isCommandForUs(fleetCmd, settings.fleetId)) continue;

    // Check if this is a newer command than what we have
    const ts = (msg.timestamp as number) || (msg.created_at as number) || 0;
    const msgTimeMs = ts > 1000000000 ? ts * 1000 : ts; // Convert if Unix seconds
    
    if (msgTimeMs > fleetState.lastCommandTime) {
      fleetState.lastCommandTime = msgTimeMs;
      return fleetCmd;
    }
  }

  return null;
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

/** Execute an ATTACK command. */
async function executeAttackCommand(ctx: RoutineContext, params: string): Promise<void> {
  const targetData = parseAttackTarget(params);
  if (!targetData) return;

  const { bot } = ctx;
  const settings = getFleetHunterSettings();

  fleetState.currentTargetId = targetData.id;

  ctx.log("fleet", `Executing ATTACK on ${targetData.name} (${targetData.id})`);

  // Attack the target
  const attackResp = await bot.exec("attack", { target_id: targetData.id });
  if (attackResp.error) {
    ctx.log("combat", `Attack on ${targetData.name}: ${attackResp.error.message}`);
  }

  // Advance to close range
  for (let zone = 0; zone < 3; zone++) {
    await bot.refreshStatus();
    const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    if (hullPct <= settings.fleeThreshold) {
      ctx.log("combat", `Hull critical (${hullPct}%) — fleeing!`);
      fleetState.isFleeing = true;
      await bot.exec("stance", { stance: "flee" });
      return;
    }

    const advResp = await bot.exec("advance");
    if (advResp.error) break;
  }

  // Combat loop
  const MAX_COMBAT_TICKS = 30;
  for (let tick = 0; tick < MAX_COMBAT_TICKS; tick++) {
    if (bot.state !== "running") return;

    await bot.refreshStatus();
    const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    const shieldPct = bot.maxShield > 0 ? Math.round((bot.shield / bot.maxShield) * 100) : 100;

    // Emergency flee
    if (hullPct <= settings.fleeThreshold) {
      ctx.log("combat", `Hull critical (${hullPct}%) — fleeing!`);
      fleetState.isFleeing = true;
      await bot.exec("stance", { stance: "flee" });
      await bot.exec("retreat");
      return;
    }

    // Brace when shields critical
    const shieldsCritical = shieldPct < 15 && hullPct < 70;
    if (shieldsCritical) {
      await bot.exec("stance", { stance: "brace" });
    } else {
      await bot.exec("stance", { stance: "fire" });
    }

    ctx.log("combat", `Tick ${tick + 1}: hull ${hullPct}% | shields ${shieldPct}% — attacking ${targetData.name}`);

    // Continue attacking
    const atkResp = await bot.exec("attack", { target_id: targetData.id });
    if (atkResp.error) {
      const msg = atkResp.error.message.toLowerCase();
      if (
        msg.includes("not in battle") || msg.includes("no battle") ||
        msg.includes("battle_over") || msg.includes("destroyed") ||
        msg.includes("dead") || msg.includes("not found")
      ) {
        ctx.log("combat", `${targetData.name} eliminated`);
        fleetState.currentTargetId = null;
        return;
      }
    }

    await sleep(1000);
  }

  fleetState.currentTargetId = null;
}

/** Execute a FLEE command. */
async function executeFleeCommand(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;

  ctx.log("fleet", "Executing FLEE — retreating immediately!");
  fleetState.isFleeing = true;

  await bot.exec("stance", { stance: "flee" });
  await bot.exec("retreat");

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

  ctx.log("fleet", "Fleet Hunter Subordinate online — awaiting commander's orders...");
  const settings = getFleetHunterSettings();

  while (bot.state === "running") {
    // ── Death recovery ──
    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) { 
      await sleep(30000); 
      continue; 
    }

    const safetyOpts = {
      fuelThresholdPct: settings.refuelThreshold,
      hullThresholdPct: settings.repairThreshold,
      autoCloak: settings.autoCloak,
    };

    // ── Status ──
    yield "get_status";
    await bot.refreshStatus();
    logStatus(ctx);

    // ── Check for fleet commands ──
    yield "check_commands";
    const newCommand = await checkFleetCommands(ctx);
    
    if (newCommand) {
      ctx.log("fleet", `Received command: ${newCommand.command} ${newCommand.params}`);
      fleetState.currentCommand = newCommand;

      // Execute command based on type
      switch (newCommand.command) {
        case "MOVE":
          yield "exec_move";
          await executeMoveCommand(ctx, newCommand.params);
          break;
        case "ATTACK":
          yield "exec_attack";
          await executeAttackCommand(ctx, newCommand.params);
          break;
        case "FLEE":
          yield "exec_flee";
          await executeFleeCommand(ctx);
          break;
        case "REGROUP":
          yield "exec_regroup";
          await executeRegroupCommand(ctx, newCommand.params);
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
          ctx.log("warn", `Unknown fleet command: ${newCommand.command}`);
      }
    }

    // ── Fuel check ──
    yield "fuel_check";
    const fueled = await ensureFueled(ctx, settings.refuelThreshold);
    if (!fueled) {
      ctx.log("error", "Cannot secure fuel — waiting 30s...");
      await sleep(30000);
      continue;
    }

    // ── Hull check ──
    await bot.refreshStatus();
    const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    if (hullPct <= settings.repairThreshold) {
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
