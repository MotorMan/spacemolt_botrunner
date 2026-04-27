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
 *   fleetId              - unique identifier for this fleet
 *   patrolSystem         - system ID to patrol (default: current system)
 *   refuelThreshold      - fuel % to trigger refuel stop (default: 40)
 *   repairThreshold      - hull % to abort patrol and dock (default: 30)
 *   fleeThreshold        - hull % to flee an active fight (default: 20)
 *   maxAttackTier        - highest pirate tier to engage (default: "large")
 *   fleeFromTier         - pirate tier that triggers fleet flee (default: "boss")
 *   minPiratesToFlee     - number of pirates that triggers fleet flee (default: 3)
 *   fireMode             - "focus" (all fire same target) or "spread" (split targets)
 *   fleetSize            - expected number of subordinates (for coordination)
 *   huntingEnabled       - enable/disable hunting (default: true)
 *   manualMode           - manual control mode (default: false)
 *   enableFactionBroadcast - also send commands to faction chat (default: false)
 */

import type { Routine, RoutineContext } from "../bot.js";
import { mapStore } from "../mapstore.js";
import { fleetCommService } from "../fleet_comm.js";
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
} from "./common.js";
import {
  type NearbyEntity,
  engageTarget,
  parseNearby,
  isPirateTarget,
} from "./battle.js";

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
  fireMode: "focus" | "spread",
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
        skipBlacklist: true, // Fleet hunters BYPASS blacklist
      };

      // ── Status ──
      yield "get_status";
      await bot.refreshStatus();
      logStatus(ctx);

      // ── Process pending web UI commands (ALWAYS process, even if hunting disabled) ──
      if (fleetState.currentCommand) {
        const cmd = fleetState.currentCommand;
        const params = fleetState.commandParams || "";

        ctx.log("fleet", `🎯 Processing web UI command: ${cmd} ${params}`);

        // Execute command based on type
        switch (cmd) {
          case "MOVE": {
            yield "exec_move";
            const moveData = params.includes("/") ? params : `${params}`;
            const parts = moveData.split("/");
            const targetSystem = parts[0];
            const targetPoi = parts[1] || null;

            if (!targetSystem) {
              ctx.log("error", `MOVE command has no target system! Params: "${params}"`);
              break;
            }

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

            ctx.log("combat", `🎯 Commander engaging ${targetData.name}...`);

            // Use engageTargetFleet which handles everything
            const won = await engageTargetFleet(
              ctx,
              targetData,
              currentSettings.fleeThreshold,
              currentSettings.fleeFromTier,
              currentSettings.minPiratesToFlee,
              currentSettings.fireMode,
            );
            if (won) totalKills++;
            break;
          }

          case "FLEE": {
            yield "exec_flee";
            ctx.log("fleet", "Executing FLEE — retreating immediately!");
            await orderFleetMove(ctx, bot.system, bot.poi || undefined);
            await ctx.sleep(1000);
            yield "fleeing";
            await fleeFromBattle(ctx, "fleet FLEE command received");
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
              currentSettings.fireMode,
            );
            if (won) totalKills++;
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
          currentSettings.fireMode,
        );
        if (won) totalKills++;
      }

      await ctx.sleep(5000);
    }
  } finally {
    // Clean up handlers
    getBotChatChannel().offMessage(bot.username, botChatHandler);
    fleetCommService.unsubscribe(settings.fleetId, bot.username, commandListener);
    ctx.log("fleet", "Fleet Hunter Commander offline — cleaned up handlers");
  }
};
