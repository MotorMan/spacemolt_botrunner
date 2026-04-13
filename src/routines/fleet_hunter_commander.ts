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
 *   fleetId              — unique identifier for this fleet
 *   patrolSystem         — system ID to patrol (default: current system)
 *   refuelThreshold      — fuel % to trigger refuel stop (default: 40)
 *   repairThreshold      — hull % to abort patrol and dock (default: 30)
 *   fleeThreshold        — hull % to flee an active fight (default: 20)
 *   maxAttackTier        — highest pirate tier to engage (default: "large")
 *   fleeFromTier         — pirate tier that triggers fleet flee (default: "boss")
 *   minPiratesToFlee     — number of pirates that triggers fleet flee (default: 3)
 *   fireMode             — "focus" (all fire same target) or "spread" (split targets)
 *   fleetSize            — expected number of subordinates (for coordination)
 *   huntingEnabled       — enable/disable hunting (default: true)
 *   manualMode           — manual control mode (default: false)
 *   enableFactionBroadcast — also send commands to faction chat (default: false)
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
  navigateToSystem,
  fetchSecurityLevel,
  scavengeWrecks,
  depositNonFuelCargo,
  ensureInsured,
  detectAndRecoverFromDeath,
  getModProfile,
  ensureModsFitted,
  readSettings,
  sleep,
  logStatus,
  ensureFueled,
  getBattleStatus,
  fleeFromBattle,
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

function findNearestHuntableSystem(fromSystemId: string): string | null {
  const visited = new Set<string>([fromSystemId]);
  const queue: string[] = [fromSystemId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const conn of mapStore.getConnections(current)) {
      if (visited.has(conn.system_id)) continue;
      visited.add(conn.system_id);

      const secLevel = conn.security_level || mapStore.getSystem(conn.system_id)?.security_level;
      if (isHuntableSystem(secLevel)) return conn.system_id;

      queue.push(conn.system_id);
    }
  }

  for (const systemId of mapStore.getAllSystemIds()) {
    if (visited.has(systemId)) continue;
    const sys = mapStore.getSystem(systemId);
    if (!sys || !isHuntableSystem(sys.security_level)) continue;
    return systemId;
  }

  return null;
}

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

function getFleetHunterSettings(): {
  fleetId: string;
  patrolSystem: string;
  refuelThreshold: number;
  repairThreshold: number;
  fleeThreshold: number;
  maxAttackTier: PirateTier;
  fleeFromTier: PirateTier;
  minPiratesToFlee: number;
  fireMode: "focus" | "spread";
  fleetSize: number;
  autoCloak: boolean;
  ammoThreshold: number;
  maxReloadAttempts: number;
  responseRange: number;
  huntingEnabled: boolean;
  manualMode: boolean;
  enableFactionBroadcast: boolean;
} {
  const all = readSettings();
  const h = all.fleet_hunter || {};

  return {
    fleetId: (h.fleetId as string) || "default",
    patrolSystem: (h.patrolSystem as string) || "",
    refuelThreshold: (h.refuelThreshold as number) || 40,
    repairThreshold: (h.repairThreshold as number) || 30,
    fleeThreshold: (h.fleeThreshold as number) || 20,
    maxAttackTier: ((h.maxAttackTier as PirateTier) || "large") as PirateTier,
    fleeFromTier: ((h.fleeFromTier as PirateTier) || "boss") as PirateTier,
    minPiratesToFlee: (h.minPiratesToFlee as number) || 3,
    fireMode: ((h.fireMode as "focus" | "spread") || "spread") as "focus" | "spread",
    fleetSize: (h.fleetSize as number) || 6,
    autoCloak: (h.autoCloak as boolean) ?? false,
    ammoThreshold: (h.ammoThreshold as number) || 5,
    maxReloadAttempts: (h.maxReloadAttempts as number) || 3,
    responseRange: (h.responseRange as number) ?? 3,
    huntingEnabled: (h.huntingEnabled as boolean) ?? true,
    manualMode: (h.manualMode as boolean) ?? false,
    enableFactionBroadcast: (h.enableFactionBroadcast as boolean) ?? false,
  };
}

// ── Fleet command broadcasting ───────────────────────────────

/** Get all subordinate bot names for the current fleet */
function getSubordinateBots(fleetId: string): string[] {
  const fleetState = fleetCommService.getFleetState(fleetId);
  if (!fleetState) return [];
  return [...fleetState.subordinateBots];
}

/** Broadcast a command to the fleet via bot chat channel (replaces faction chat). */
async function broadcastFleetCommand(ctx: RoutineContext, command: string, params: string, metadata?: Record<string, unknown>): Promise<void> {
  const settings = getFleetHunterSettings();
  const subordinates = getSubordinateBots(settings.fleetId);

  // Send via local fleet comm service (for in-memory command routing)
  await fleetCommService.broadcast(settings.fleetId, command as any, params || undefined, ctx.bot.username);
  
  // Also send via bot chat channel for coordination, logging, and structured data
  const commandMsg = `${command} ${params || ""}`.trim();
  ctx.sendBotChat?.(commandMsg, "fleet", subordinates.length > 0 ? subordinates : undefined, {
    command,
    params: params || undefined,
    commander: ctx.bot.username,
    fleetId: settings.fleetId,
    ...metadata,
  });
  ctx.log("fleet", `Broadcast (bot chat): ${command} ${params || ""}`);
}

/** Send a MOVE command to the fleet. */
async function orderFleetMove(ctx: RoutineContext, systemId: string, poiId?: string): Promise<void> {
  const params = poiId ? `${systemId}/${poiId}` : systemId;
  await broadcastFleetCommand(ctx, "MOVE", params, { targetSystem: systemId, targetPoi: poiId });
}

/** Send an ATTACK command with target ID. */
async function orderFleetAttack(ctx: RoutineContext, targetId: string, targetName: string): Promise<void> {
  await broadcastFleetCommand(ctx, "ATTACK", `${targetId}:${targetName}`, { targetId, targetName });
}

/** Send a FLEE command to the fleet. */
async function orderFleetFlee(ctx: RoutineContext): Promise<void> {
  await broadcastFleetCommand(ctx, "FLEE", "");
}

/** Send a REGROUP command. */
async function orderFleetRegroup(ctx: RoutineContext, systemId: string, poiId?: string): Promise<void> {
  const params = poiId ? `${systemId}/${poiId}` : systemId;
  await broadcastFleetCommand(ctx, "REGROUP", params, { targetSystem: systemId, targetPoi: poiId });
}

/** Send a HOLD command (stay in position). */
async function orderFleetHold(ctx: RoutineContext): Promise<void> {
  await broadcastFleetCommand(ctx, "HOLD", "");
}

/** Send a PATROL command (resume patrol pattern). */
async function orderFleetPatrol(ctx: RoutineContext): Promise<void> {
  await broadcastFleetCommand(ctx, "PATROL", "");
}

/** Broadcast fleet status update with hull/shield info for all members. */
async function broadcastFleetStatus(ctx: RoutineContext): Promise<void> {
  const settings = getFleetHunterSettings();
  const subordinates = getSubordinateBots(settings.fleetId);
  const { bot } = ctx;
  
  await bot.refreshStatus();
  const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
  const shieldPct = bot.maxShield > 0 ? Math.round((bot.shield / bot.maxShield) * 100) : 100;
  const fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
  
  const statusMsg = `Commander Status: Hull=${hullPct}% | Shield=${shieldPct}% | Fuel=${fuelPct}% | System=${bot.system || "unknown"}`;
  
  ctx.sendBotChat?.(statusMsg, "fleet", subordinates.length > 0 ? subordinates : undefined, {
    type: "status_update",
    hull: hullPct,
    shield: shieldPct,
    fuel: fuelPct,
    system: bot.system || "unknown",
    poi: bot.poi || null,
    inBattle: !!(await getBattleStatus(ctx)),
  });
}

// ── Nearby entity parsing ─────────────────────────────────────

interface NearbyEntity {
  id: string;
  name: string;
  type: string;
  faction: string;
  isNPC: boolean;
  isPirate: boolean;
  tier?: PirateTier;
  isBoss?: boolean;
  hull?: number;
  maxHull?: number;
  shield?: number;
  maxShield?: number;
  status?: string;
}

function parseNearby(result: unknown): NearbyEntity[] {
  if (!result || typeof result !== "object") return [];
  const r = result as Record<string, unknown>;
  const entities: NearbyEntity[] = [];

  let rawEntities: Array<Record<string, unknown>> = [];

  if (Array.isArray(r)) {
    rawEntities = r;
  } else if (Array.isArray(r.entities)) {
    rawEntities = r.entities as Array<Record<string, unknown>>;
  } else if (Array.isArray(r.players) && r.players.length > 0) {
    rawEntities = r.players as Array<Record<string, unknown>>;
  } else if (Array.isArray(r.nearby)) {
    rawEntities = r.nearby as Array<Record<string, unknown>>;
  }

  for (const e of rawEntities) {
    const id = (e.id as string) || (e.player_id as string) || (e.entity_id as string) || (e.pirate_id as string) || "";
    let faction = "";
    if (typeof e.faction === "string") {
      faction = e.faction.toLowerCase();
    } else if (typeof e.faction_id === "string") {
      faction = e.faction_id.toLowerCase();
    }

    let type = "";
    if (typeof e.type === "string") {
      type = e.type.toLowerCase();
    } else if (typeof e.entity_type === "string") {
      type = e.entity_type.toLowerCase();
    }

    const isPirate = !!(e.pirate_id) || type.includes("pirate") || faction.includes("pirate");
    const isNPC = isPirate || !!(e.is_npc) || type === "npc" || type === "enemy";

    entities.push({
      id,
      name: (e.name as string) || (e.username as string) || (e.pirate_name as string) || (e.pirate_id as string) || id,
      type,
      faction,
      isNPC,
      isPirate,
    });
  }

  if (Array.isArray(r.pirates)) {
    const rawPirates = r.pirates as Array<Record<string, unknown>>;
    for (const p of rawPirates) {
      const id = (p.pirate_id as string) || "";
      if (!id) continue;

      const tier = (p.tier as string) || "small";
      const isBoss = !!(p.is_boss as boolean);

      entities.push({
        id,
        name: (p.name as string) || (p.pirate_name as string) || id,
        type: "pirate",
        faction: "pirate",
        isNPC: true,
        isPirate: true,
        tier: tier as PirateTier,
        isBoss,
        hull: p.hull as number,
        maxHull: p.max_hull as number,
        shield: p.shield as number,
        maxShield: p.max_shield as number,
        status: p.status as string,
      });
    }
  }

  return entities.filter(e => e.id);
}

const PIRATE_KEYWORDS = ["drifter", "pirate", "raider", "outlaw", "bandit", "corsair", "marauder", "hostile"];

function isPirateTarget(entity: NearbyEntity, onlyNPCs: boolean, maxAttackTier: PirateTier = "large"): boolean {
  if (entity.isPirate) {
    if (isTierTooHigh(entity.tier, maxAttackTier)) return false;
    return true;
  }
  if (onlyNPCs && !entity.isNPC) return false;

  const factionMatch = entity.faction ? PIRATE_KEYWORDS.some(kw => entity.faction.includes(kw)) : false;
  const typeMatch = entity.type ? PIRATE_KEYWORDS.some(kw => entity.type.includes(kw)) : false;
  const nameMatch = entity.name ? PIRATE_KEYWORDS.some(kw => entity.name.toLowerCase().includes(kw)) : false;

  return factionMatch || typeMatch || (entity.isNPC && nameMatch);
}

// ── Combat — Tactical Fleet Battle System ────────────────────

/**
 * Emergency flee spam for fleet — sends flee commands and orders fleet to flee.
 */
async function emergencyFleeSpamFleet(ctx: RoutineContext, reason: string): Promise<void> {
  const { bot } = ctx;
  ctx.log("combat", `🚨 FLEET EMERGENCY FLEE — ${reason}`);

  // Order entire fleet to flee
  await orderFleetFlee(ctx);

  // Spam our own flee stance + retreat
  for (let i = 0; i < 5; i++) {
    await bot.exec("battle", { action: "stance", stance: "flee" });
    await bot.exec("battle", { action: "retreat" });
  }

  await sleep(5000);
  const status = await getBattleStatus(ctx);
  if (status) {
    ctx.log("combat", `⚠️ Still in battle after fleet flee spam — trying again...`);
    for (let i = 0; i < 5; i++) {
      await bot.exec("battle", { action: "stance", stance: "flee" });
      await bot.exec("battle", { action: "retreat" });
    }
  } else {
    ctx.log("combat", `✅ Fleet successfully disengaged from battle`);
  }
}

/**
 * Analyze an existing battle for fleet engagement decisions.
 * Returns: { shouldJoin: boolean, sideId?: number, reason: string, pirateCount: number }
 */
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
    `Side ${s.sideId}: ${s.playerCount} player(s) [${s.playerNames.join(",")}] vs ${s.pirateCount} pirate(s) [${s.pirateNames.join(",")}]`
  ).join(" | ")}`);

  // POLICE check
  const hasPolice = battleStatus.participants.some(p => p.username?.startsWith("[POLICE]"));
  if (hasPolice) {
    return { shouldJoin: false, reason: "POLICE involved — fleet staying out", pirateCount: 0 };
  }

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

  if (opposingPirateCount >= minPiratesToFlee) {
    return { shouldJoin: false, reason: `Too many pirates (${opposingPirateCount}) — too dangerous for fleet`, pirateCount: opposingPirateCount };
  }

  return {
    shouldJoin: true,
    sideId: sideToJoin.sideId,
    reason: `Fleet joining side ${sideToJoin.sideId} (${sideToJoin.playerCount} player(s)) vs ${opposingPirateCount} pirate(s)`,
    pirateCount: opposingPirateCount,
  };
}

/**
 * Main fleet combat function — handles pre-battle assessment and engagement.
 */
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

  // ── STEP 1: Check for existing battles ────────────────────
  const battleStatus = await getBattleStatus(ctx);

  if (battleStatus) {
    ctx.log("combat", `⚔️ Existing battle detected — fleet analyzing...`);
    const analysis = await analyzeBattleForFleet(ctx, minPiratesToFlee);

    if (!analysis.shouldJoin) {
      ctx.log("combat", `⏭️ Fleet skipping battle: ${analysis.reason}`);
      return false;
    }

    // Join battle on player's side — both commander and fleet
    ctx.log("combat", `✅ Fleet joining battle on side ${analysis.sideId}: ${analysis.reason}`);
    const engageResp = await bot.exec("battle", { action: "engage", side_id: analysis.sideId!.toString() });

    if (engageResp.error) {
      ctx.log("error", `Fleet failed to join battle: ${engageResp.error.message}`);
      return false;
    }

    // Order fleet to attack the target
    await orderFleetAttack(ctx, target.id, target.name);
    await sleep(1000);

    return await fightJoinedBattleFleet(ctx, target, fleeThreshold, minPiratesToFlee, fireMode);
  }

  // ── STEP 2: No existing battle — start fresh fight ────────
  ctx.log("combat", `🎯 Fleet engaging ${target.name}...`);

  // Order fleet to attack
  await orderFleetAttack(ctx, target.id, target.name);
  await sleep(1000);

  // Commander attacks too
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
  return await fightFreshBattleFleet(ctx, target, fleeThreshold, minPiratesToFlee, fireMode);
}

/**
 * Fight a fresh fleet battle — advance to engaged, then tactical combat.
 * Uses server-synced ticks: ONE command per tick, wait for response.
 */
async function fightFreshBattleFleet(
  ctx: RoutineContext,
  target: NearbyEntity,
  fleeThreshold: number,
  minPiratesToFlee: number,
  fireMode: "focus" | "spread",
): Promise<boolean> {
  const { bot } = ctx;

  // Advance to engaged (3 ticks, 1 action per tick)
  for (let zone = 0; zone < 3; zone++) {
    if (bot.state !== "running") return false;

    const status = await getBattleStatus(ctx);
    if (!status) {
      ctx.log("combat", `✅ Battle ended during advance — fleet victory!`);
      return true;
    }

    await bot.refreshStatus();
    const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;

    if (hullPct <= fleeThreshold) {
      ctx.log("combat", `💀 Hull critical (${hullPct}%) while advancing — fleet fleeing!`);
      await emergencyFleeSpamFleet(ctx, "hull critical while advancing");
      return false;
    }

    const advResp = await bot.exec("battle", { action: "advance" });
    if (advResp.error) {
      ctx.log("error", `Fleet advance failed: ${advResp.error.message}`);
      if (!advResp.error.message.toLowerCase().includes("already")) {
        break;
      }
    }

    const postAdvStatus = await getBattleStatus(ctx);
    if (postAdvStatus) {
      const zoneNames = ["mid", "inner", "engaged"];
      ctx.log("combat", `Fleet advanced to ${zoneNames[zone]} zone (${zone + 1}/3) | Hull: ${hullPct}%`);
    }
  }

  // ── Tactical combat loop — server-synced, NO arbitrary tick limit ──
  let consecutiveBraceTicks = 0;
  let lastKnownEnemyZone = "outer";
  let tickCount = 0;
  let ourCurrentZone = "outer";

  // Set fire stance ONCE
  await bot.exec("battle", { action: "stance", stance: "fire" });
  await getBattleStatus(ctx);

  while (true) {
    if (bot.state !== "running") return false;
    tickCount++;

    const status = await getBattleStatus(ctx);
    if (!status) {
      ctx.log("combat", `✅ ${target.name} eliminated — fleet victory! (${tickCount} ticks)`);
      return true;
    }

    const targetParticipant = status.participants.find(
      p => p.player_id === target.id || p.username === target.name
    );
    const targetStillAlive = targetParticipant && !targetParticipant.is_destroyed;

    if (!targetStillAlive && targetParticipant) {
      ctx.log("combat", `⚠️ ${target.name} marked destroyed but battle still active — waiting...`);
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
          ctx.log("combat", `⚠️ ${target.name} advancing: ${lastKnownEnemyZone} → ${targetParticipant.zone}`);
        } else if (newDir < prevDir) {
          ctx.log("combat", `${target.name} retreating: ${lastKnownEnemyZone} → ${targetParticipant.zone}`);
        }
        lastKnownEnemyZone = targetParticipant.zone;
      }
    }

    // Emergency flee (ONLY based on hull)
    if (hullPct <= fleeThreshold) {
      ctx.log("combat", `💀 Hull critical (${hullPct}%) — fleet fleeing!`);
      await emergencyFleeSpamFleet(ctx, `hull at ${hullPct}%`);
      return false;
    }

    // 3rd party detection
    const ourSideId = status.your_side_id;
    const thirdPartyParticipants = status.participants.filter(p =>
      p.side_id !== ourSideId &&
      p.player_id !== bot.username &&
      p.username !== bot.username &&
      p.player_id !== target.id &&
      p.username !== target.name &&
      !p.is_destroyed
    );

    if (thirdPartyParticipants.length >= minPiratesToFlee) {
      ctx.log("combat", `🚨 ${thirdPartyParticipants.length} third parties — fleet fleeing!`);
      await emergencyFleeSpamFleet(ctx, `${thirdPartyParticipants.length} third parties`);
      return false;
    }

    // Log battle state
    const enemyStance = targetParticipant?.stance || "unknown";
    const enemyZone = targetParticipant?.zone || "unknown";
    ctx.log("combat", `Fleet Tick ${tickCount}: Enemy=${enemyStance}/${enemyZone} | Hull=${hullPct}% | Shields=${shieldPct}%`);

    // Decide action - use positional tactics
    const zoneDirMap = { outer: 0, mid: 1, inner: 2, engaged: 3 };
    const enemyZoneNum = zoneDirMap[enemyZone as keyof typeof zoneDirMap] ?? 0;
    const ourZoneNum = zoneDirMap[ourCurrentZone as keyof typeof zoneDirMap] ?? 0;

    // Check if fighting high-damage enemy
    const isHighDamageEnemy = target.tier && ["boss", "capitol", "large"].includes(target.tier);
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

/**
 * Fight in a fleet battle we joined via engage.
 * Uses server-synced ticks: ONE command per tick, wait for response.
 */
async function fightJoinedBattleFleet(
  ctx: RoutineContext,
  target: NearbyEntity,
  fleeThreshold: number,
  minPiratesToFlee: number,
  fireMode: "focus" | "spread",
): Promise<boolean> {
  const { bot } = ctx;

  ctx.log("combat", `🎯 Fleet fighting in joined battle — targeting ${target.name}`);

  // Set target and fire stance
  await bot.exec("battle", { action: "target", target_id: target.id });
  await bot.exec("battle", { action: "stance", stance: "fire" });
  await getBattleStatus(ctx);

  // Tactical combat loop — server-synced, NO arbitrary tick limit
  let consecutiveBraceTicks = 0;
  let lastKnownEnemyZone = "outer";
  let tickCount = 0;

  while (true) {
    if (bot.state !== "running") return false;
    tickCount++;

    const status = await getBattleStatus(ctx);
    if (!status) {
      ctx.log("combat", `✅ Fleet battle complete — victory! (${tickCount} ticks)`);
      return true;
    }

    const targetParticipant = status.participants.find(
      p => p.player_id === target.id || p.username === target.name
    );
    const targetStillAlive = targetParticipant && !targetParticipant.is_destroyed;

    if (!targetStillAlive && targetParticipant) {
      ctx.log("combat", `⚠️ ${target.name} marked destroyed but battle still active — waiting...`);
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
          ctx.log("combat", `⚠️ ${target.name} advancing: ${lastKnownEnemyZone} → ${targetParticipant.zone}`);
        } else if (newDir < prevDir) {
          ctx.log("combat", `${target.name} retreating: ${lastKnownEnemyZone} → ${targetParticipant.zone}`);
        }
        lastKnownEnemyZone = targetParticipant.zone;
      }
    }

    if (hullPct <= fleeThreshold) {
      ctx.log("combat", `💀 Hull critical (${hullPct}%) — fleet fleeing!`);
      await emergencyFleeSpamFleet(ctx, `hull at ${hullPct}%`);
      return false;
    }

    // 3rd party detection
    const ourSideId = status.your_side_id;
    const thirdPartyParticipants = status.participants.filter(p =>
      p.side_id !== ourSideId &&
      p.player_id !== bot.username &&
      p.username !== bot.username &&
      p.player_id !== target.id &&
      p.username !== target.name &&
      !p.is_destroyed
    );

    if (thirdPartyParticipants.length >= minPiratesToFlee) {
      ctx.log("combat", `🚨 ${thirdPartyParticipants.length} third parties — fleet fleeing!`);
      await emergencyFleeSpamFleet(ctx, `${thirdPartyParticipants.length} third parties`);
      return false;
    }

    // Log battle state
    const enemyStance = targetParticipant?.stance || "unknown";
    const enemyZone = targetParticipant?.zone || "unknown";
    ctx.log("combat", `Fleet Tick ${tickCount}: Enemy=${enemyStance}/${enemyZone} | Hull=${hullPct}% | Shields=${shieldPct}%`);

    // Decide action - use positional tactics
    const zoneDirMap = { outer: 0, mid: 1, inner: 2, engaged: 3 };
    const enemyZoneNum = zoneDirMap[enemyZone as keyof typeof zoneDirMap] ?? 0;
    const ourZone = status.your_zone || "outer";
    const ourZoneNum = zoneDirMap[ourZone as keyof typeof zoneDirMap] ?? 0;

    // Check if fighting high-damage enemy
    const isHighDamageEnemy = target.tier && ["boss", "capitol", "large"].includes(target.tier);
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
      } else if (enemyZoneNum <= ourZoneNum && ourZoneNum > 0) {
        ctx.log("combat", `🔄 RETREAT (maintaining position)`);
        await bot.exec("battle", { action: "retreat" });
      } else {
        ctx.log("combat", `⚔️ ADVANCING to engage`);
        await bot.exec("battle", { action: "advance" });
      }
    }

    await sleep(2000);
  }
}

// ── Fleet Hunter Commander Routine ───────────────────────────

export const fleetHunterCommanderRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  // Verify this bot is assigned as the fleet commander
  const assignments = ctx.getBotAssignments?.() || {};
  const assignedCommander = Object.entries(assignments).find(
    ([_, routine]) => routine === "fleet_hunter_commander"
  )?.[0];

  if (assignedCommander && assignedCommander !== bot.username) {
    ctx.log("fleet", `❌ This bot is not the assigned fleet commander. Assigned: ${assignedCommander}, Current: ${bot.username}. Exiting.`);
    return;
  }

  await bot.refreshStatus();
  let totalKills = 0;

  // Register as commander with fleet comm service
  const settings = getFleetHunterSettings();
  fleetCommService.setCommander(settings.fleetId, bot.username);
  ctx.log("fleet", `Registered as commander for fleet ${settings.fleetId}`);

  ctx.log("fleet", "Fleet Hunter Commander online — waiting for subordinates...");
  await sleep(3000); // Give subordinates time to join

  while (bot.state === "running") {
    // ── Death recovery ──
    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) {
      await orderFleetRegroup(ctx, bot.system, bot.poi || undefined);
      await sleep(30000);
      continue;
    }

    const currentSettings = getFleetHunterSettings();
    
    // Check if hunting is disabled
    if (!currentSettings.huntingEnabled) {
      ctx.log("fleet", "Hunting is disabled — waiting...");
      await sleep(5000);
      continue;
    }

    // In manual mode, wait for commands
    if (currentSettings.manualMode) {
      ctx.log("fleet", "Manual mode active — awaiting commands");
      await sleep(2000);
      continue;
    }

    const safetyOpts = {
      fuelThresholdPct: currentSettings.refuelThreshold,
      hullThresholdPct: currentSettings.repairThreshold,
      autoCloak: currentSettings.autoCloak,
    };
    const patrolSystem = currentSettings.patrolSystem || "";

    // ── Status ──
    yield "get_status";
    await bot.refreshStatus();
    logStatus(ctx);
    
    // Broadcast status to fleet
    await broadcastFleetStatus(ctx);

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
      ctx.log("system", `Hull at ${hullPct}% — ordering fleet to retreat for repairs`);
      yield "emergency_repair";
      await orderFleetRegroup(ctx, bot.system); // Order regroup before docking

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

    if (patrolSystem && bot.system !== patrolSystem) {
      ctx.log("travel", `Navigating to configured patrol system ${patrolSystem}...`);
      await orderFleetMove(ctx, patrolSystem);
      const arrived = await navigateToSystem(ctx, patrolSystem, safetyOpts);
      if (!arrived) {
        ctx.log("error", `Could not reach ${patrolSystem} — patrolling ${bot.system} instead`);
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
          await navigateToSystem(ctx, huntTarget, safetyOpts);
        } else {
          ctx.log("error", "No huntable system found — waiting 30s");
          await sleep(30000);
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
      await sleep(3000);
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
        bot.docked = true;
        await tryRefuel(ctx);
        await ensureUndocked(ctx);
      }
      continue;
    }

    ctx.log("fleet", `Patrolling ${patrolPois.length} POI(s) in ${bot.system} with fleet...`);
    await orderFleetPatrol(ctx);

    // ── Patrol loop ──
    let patrolKills = 0;
    let abortPatrol = false;

    for (const poi of patrolPois) {
      if (bot.state !== "running" || abortPatrol) break;

      await bot.refreshStatus();
      const midHull = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
      if (midHull <= settings.repairThreshold) {
        ctx.log("system", `Hull at ${midHull}% — aborting patrol`);
        abortPatrol = true;
        break;
      }

      // Travel to POI and order fleet
      yield "travel_to_poi";
      ctx.log("travel", `Moving fleet to ${poi.name}...`);
      await orderFleetMove(ctx, bot.system, poi.id);
      
      const travelResp = await bot.exec("travel", { target_poi: poi.id });
      if (travelResp.error && !travelResp.error.message.includes("already")) {
        ctx.log("error", `Travel to ${poi.name} failed: ${travelResp.error.message}`);
        continue;
      }
      bot.poi = poi.id;

      // Scan for targets
      yield "scan_for_targets";
      const nearbyResp = await bot.exec("get_nearby");
      if (nearbyResp.error) {
        ctx.log("error", `get_nearby at ${poi.name}: ${nearbyResp.error.message}`);
        continue;
      }

      const entities = parseNearby(nearbyResp.result);
      const targets = entities.filter(e => isPirateTarget(e, true, settings.maxAttackTier));

      if (targets.length === 0) {
        ctx.log("combat", `No targets at ${poi.name}`);
        await scavengeWrecks(ctx);
        continue;
      }

      ctx.log("combat", `Found ${targets.length} target(s) at ${poi.name}`);

      // Engage targets based on fire mode
      if (settings.fireMode === "focus") {
        // All bots focus same target
        for (const target of targets) {
          if (bot.state !== "running") break;

          await bot.refreshStatus();
          const preHull = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
          if (preHull <= settings.repairThreshold) {
            abortPatrol = true;
            break;
          }

          yield "engage";
          const won = await engageTargetFleet(
            ctx,
            target,
            settings.fleeThreshold,
            settings.fleeFromTier,
            settings.minPiratesToFlee,
            settings.fireMode
          );

          if (won) {
            totalKills++;
            patrolKills++;
            ctx.log("combat", `Kill #${totalKills} — looting...`);
            yield "loot";
            await scavengeWrecks(ctx);
            // Broadcast status after combat
            await broadcastFleetStatus(ctx);
          } else {
            ctx.log("combat", "Retreated — aborting patrol");
            abortPatrol = true;
            break;
          }
        }
      } else {
        // Spread fire — each bot can engage different targets
        // Commander engages first target, subordinates pick others
        for (const target of targets) {
          if (bot.state !== "running") break;

          yield "engage";
          const won = await engageTargetFleet(
            ctx,
            target,
            settings.fleeThreshold,
            settings.fleeFromTier,
            settings.minPiratesToFlee,
            settings.fireMode
          );

          if (won) {
            totalKills++;
            patrolKills++;
            await scavengeWrecks(ctx);
            // Broadcast status after combat
            await broadcastFleetStatus(ctx);
          }
        }
      }
    }

    // ── Post-patrol ──
    yield "post_patrol";
    await bot.refreshStatus();
    const postHull = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    const postFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;

    if (abortPatrol || postHull <= settings.repairThreshold || postFuel < settings.refuelThreshold) {
      const reason = postHull <= settings.repairThreshold ? `hull ${postHull}%` : `fuel ${postFuel}%`;
      ctx.log("system", `Patrol done — ${patrolKills} kill(s). Returning for ${reason}...`);

      await orderFleetRegroup(ctx, bot.system);
      yield "dock";
      const docked = await ensureDocked(ctx);
      if (docked) {
        await repairShip(ctx);
        await tryRefuel(ctx);
        await ensureInsured(ctx);
        await ensureUndocked(ctx);
        
        // Order fleet to regroup after repairs
        await orderFleetRegroup(ctx, bot.system, bot.poi || undefined);
      }
    } else {
      ctx.log("fleet", `Patrol sweep done — ${patrolKills} kill(s). Continuing hunt...`);
    }
  }
};
