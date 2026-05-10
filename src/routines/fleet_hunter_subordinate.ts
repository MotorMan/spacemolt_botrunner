/**
 * Fleet Hunter Subordinate routine — follows a fleet commander's orders.
 *
 * Responsibilities:
 * - Listen for fleet commands via local fleet communication
 * - Follow commander's movement orders
 * - Engage targets called by commander (uses battle.ts engageTarget)
 * - Auto-flee if hull critical, then regroup
 * - Report status to commander (optional)
 *
 * Communication:
 * - Listens to local fleet comm service (no faction chat monitoring)
 * - Commands: MOVE, ATTACK, FLEE, REGROUP, HOLD, PATROL
 * - Battle commands: BATTLE_ADVANCE, BATTLE_RETREAT, BATTLE_STANCE, BATTLE_TARGET
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
   ensureFueled,
   ensureInsured,
   navigateToSystem,
   fetchSecurityLevel,
   getBattleStatus,
   logStatus,
  detectAndRecoverFromDeath,
  ensureModsFitted,
  getModProfile,
  readSettings,
   fleeFromBattle,
   checkAndFleeFromBattle,
   checkBattleAfterCommand,
   type BattleState,
   handleBattleNotifications,
} from "./common.js";
import {
  type NearbyEntity,
  engageTarget,
  parseNearby,
  isPirateTarget,
} from "./battle.js";

// ── Settings ────────────────────────────────────────

type PirateTier = "small" | "medium" | "large" | "capitol" | "boss";

interface FleetHunterSettings {
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

// ── Local fleet command listener ────────────────────────────────

const COMMAND_TIMEOUT_MS = 30000; // Commands expire after 30s

/** Create a command listener for the fleet comm service. */
function createFleetCommandListener(ctx: RoutineContext): (command: FleetCommand) => Promise<void> {
  const { bot } = ctx;
  const settings = getFleetHunterSettings();

  return async (command: FleetCommand) => {
    // Ignore if not for our fleet
    if (command.fleetId !== settings.fleetId) return;

    ctx.log("fleet", `Received command: ${command.type} ${command.params || ""}`);

    // Store command for execution by main loop
    fleetState.lastCommandTime = Date.now();
    fleetState.currentCommand = command.type;
    fleetState.commandParams = command.params || null;

    // Commands are ALWAYS processed (even if hunting disabled)
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

/** Execute an ATTACK command from the commander — uses battle.ts engageTarget. */
async function executeAttackCommand(ctx: RoutineContext, params: string): Promise<void> {
  const targetData = parseAttackTarget(params);
  if (!targetData) return;

  const { bot } = ctx;
  const settings = getFleetHunterSettings();

  fleetState.currentTargetId = targetData.id;
  // CRITICAL: Reset fleeing flag when starting a new attack
  fleetState.isFleeing = false;

  ctx.log("combat", `🎯 Subordinate engaging ${targetData.name}...`);

  // Use engageTarget from battle.ts which handles:
  // - Engaging existing battle (with sideId if provided)
  // - Starting fresh fight
  // - Advancing to engaged
  // - Tactical combat loop
  // - ONLY fleeing on hull <= fleeThreshold
  // Create a NearbyEntity from targetData for engageTarget
  const targetEntity: NearbyEntity = {
    id: targetData.id,
    name: targetData.name,
    type: "pirate", // Assume pirate for fleet hunters
    faction: "",
    isNPC: true,
    isPirate: true,
  };

  const won = await engageTarget(
    ctx,
    targetEntity,
    settings.fleeThreshold,
    settings.fleeFromTier,
    settings.minPiratesToFlee,
    "large", // maxAttackTier
    targetData.sideId, // sideId if provided by commander
  );

  if (!won) {
    ctx.log("combat", `Subordinate retreated from ${targetData.name}`);
  }

  fleetState.currentTargetId = null;
}

/** Execute a FLEE command. */
async function executeFleeCommand(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;

  ctx.log("fleet", "Executing FLEE — retreating immediately!");
  fleetState.isFleeing = true;

  // Use emergencyFlee from battle.ts (imported via engageTarget)
  await ctx.sleep(5000);

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
    skipBlacklist: true,
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

// ── Fleet Hunter Subordinate Routine ────────────────────────────────

export const fleetHunterSubordinateRoutine: Routine = async function* (ctx: RoutineContext) {
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

      // ── Status ──
      yield "get_status";
      await bot.refreshStatus();
      logStatus(ctx);

      // ── Battle detection ──
      // Update battle state from current status
      if (bot.isInBattle()) {
        if (!battleRef.state!.inBattle) {
          ctx.log("combat", "Battle detected - fleet subordinate engaging!");
          battleRef.state!.inBattle = true;
          battleRef.state!.battleId = null; // Will be updated when available
        }
      } else {
        if (battleRef.state!.inBattle) {
          ctx.log("combat", "Battle cleared - fleet subordinate standing down");
          battleRef.state!.inBattle = false;
          battleRef.state!.battleId = null;
        }
      }

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

        // After executing command, check if we should continue or wait
        // If hunting is disabled and no more commands, just wait
        const updatedSettings = getFleetHunterSettings();
        if (!updatedSettings.huntingEnabled) {
          ctx.log("fleet", "Hunting is disabled — executed command, now waiting...");
          await ctx.sleep(2000);
          continue;
        }
      }

      // ── Check if hunting is disabled (only reaches here if no commands pending) ──
      if (!currentSettings.huntingEnabled) {
        ctx.log("fleet", "Hunting is disabled — waiting for commands...");
        await ctx.sleep(5000);
        continue;
      }

      // ── In manual mode, just wait for commands ──
      if (currentSettings.manualMode) {
        ctx.log("fleet", "Manual mode active — awaiting commands");
        await ctx.sleep(2000);
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

      // ── Safety checks ──
      yield "safety_check";
      const fueled = await ensureFueled(ctx, currentSettings.refuelThreshold);
      if (!fueled) {
        ctx.log("error", "Cannot secure fuel — waiting 30s...");
        await ctx.sleep(30000);
        continue;
      }

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

      // ── Idle wait ──
      yield "wait_idle";
      await ctx.sleep(2000);
    }
  } finally {
    // Clean up bot chat handler
    getBotChatChannel().offMessage(bot.username, botChatHandler);
    // Unsubscribe from fleet commands
    fleetCommService.unsubscribe(settings.fleetId, bot.username, commandListener);
    ctx.log("fleet", "Fleet Hunter Subordinate offline — cleaned up handlers");
  }
};
