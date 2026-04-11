/**
 * Hunter routine — patrols a system hunting pirate NPCs for bounties and loot.
 *
 * Loop:
 *   1. Navigate to configured patrol system
 *   2. Visit each non-station POI looking for pirate targets
 *   3. Scan -> engage -> loot each target
 *   4. Flee and dock if hull drops below flee threshold
 *   5. Post-patrol: complete missions, sell loot, accept new missions,
 *      insure ship, refuel, repair
 *
 * Combat stances:
 *   - Fire   (default): 100% damage dealt/taken
 *   - Brace  (shields critical): 0% damage dealt, shields regen 2x — use briefly to recover
 *   - Flee   (hull critical): auto-retreat — triggers when hull <= fleeThreshold
 *
 * Settings (data/settings.json under "hunter"):
 *   system          — system ID to patrol (default: current system)
 *   refuelThreshold — fuel % to trigger refuel stop (default: 40)
 *   repairThreshold — hull % to abort patrol and dock (default: 30)
 *   fleeThreshold   — hull % to flee an active fight (default: 20)
 *   onlyNPCs        — only attack NPC pirates, never players (default: true)
 */

import type { Routine, RoutineContext } from "../bot.js";
import { mapStore } from "../mapstore.js";
import { getSystemBlacklist } from "../web/server.js";
import {
  findStation,
  isStationPoi,
  getSystemInfo,
  collectFromStorage,
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
  sleep,
  logStatus,
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
  if (!tier) return 1; // default to small if unknown
  return TIER_ORDER[tier] ?? 1;
}

function isTierTooHigh(pirateTier: PirateTier | undefined, maxTier: PirateTier): boolean {
  if (!pirateTier) return false; // unknown tier, allow attack
  return getTierLevel(pirateTier) > getTierLevel(maxTier);
}

function getHunterSettings(username?: string): {
  system: string;
  refuelThreshold: number;
  repairThreshold: number;
  fleeThreshold: number;
  onlyNPCs: boolean;
  autoCloak: boolean;
  ammoThreshold: number;
  maxReloadAttempts: number;
  responseRange: number;
  maxAttackTier: PirateTier;
  fleeFromTier: PirateTier;
  minPiratesToFlee: number;
} {
  const all = readSettings();
  const h = all.hunter || {};
  const botOverrides = username ? (all[username] || {}) : {};

  return {
    system: (botOverrides.system as string) || (h.system as string) || "",
    refuelThreshold: (h.refuelThreshold as number) || 40,
    repairThreshold: (h.repairThreshold as number) || 30,
    fleeThreshold: (h.fleeThreshold as number) || 20,
    onlyNPCs: (h.onlyNPCs as boolean) !== false,
    autoCloak: (h.autoCloak as boolean) ?? false,
    ammoThreshold: (h.ammoThreshold as number) || 5,
    maxReloadAttempts: (h.maxReloadAttempts as number) || 3,
    responseRange: (h.responseRange as number) ?? 3,
    maxAttackTier: ((h.maxAttackTier as PirateTier) || "large") as PirateTier,
    fleeFromTier: ((h.fleeFromTier as PirateTier) || "boss") as PirateTier,
    minPiratesToFlee: (h.minPiratesToFlee as number) || 3,
  };
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
  // Phase 1: BFS through stored connections
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

  // Phase 2: scan all known systems
  const blacklist = getSystemBlacklist();
  for (const systemId of mapStore.getAllSystemIds()) {
    if (visited.has(systemId)) continue;
    // Skip blacklisted systems
    if (blacklist.some(b => b.toLowerCase() === systemId.toLowerCase())) continue;
    const sys = mapStore.getSystem(systemId);
    if (!sys || !isHuntableSystem(sys.security_level)) continue;
    if (mapStore.findRoute(fromSystemId, systemId, blacklist)) return systemId;
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

// ── Nearby entity parsing ─────────────────────────────────────

interface NearbyEntity {
  id: string;
  name: string;
  type: string;
  faction: string;
  isNPC: boolean;
  isPirate: boolean;
  tier?: "small" | "medium" | "large" | "capitol" | "boss";
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

  // Handle different possible response formats from get_nearby API call
  let rawEntities: Array<Record<string, unknown>> = [];

  if (Array.isArray(r)) {
    // Direct array of entities
    rawEntities = r;
  } else if (Array.isArray(r.entities)) {
    // Entities are under .entities key
    rawEntities = r.entities as Array<Record<string, unknown>>;
  } else if (Array.isArray(r.players) && r.players.length > 0) {
    // Players array is present
    rawEntities = r.players as Array<Record<string, unknown>>;
  } else if (Array.isArray(r.nearby)) {
    // Nearby array is present
    rawEntities = r.nearby as Array<Record<string, unknown>>;
  }

  // Parse regular entities
  for (const e of rawEntities) {
    const id = (e.id as string) || (e.player_id as string) || (e.entity_id as string) || (e.pirate_id as string) || "";
    // Safely extract faction - handling different possible field names
    let faction = "";
    if (typeof e.faction === "string") {
      faction = e.faction.toLowerCase();
    } else if (typeof e.faction_id === "string") {
      faction = e.faction_id.toLowerCase();
    }

    // Safely extract type - handling different possible field names
    let type = "";
    if (typeof e.type === "string") {
      type = e.type.toLowerCase();
    } else if (typeof e.entity_type === "string") {
      type = e.entity_type.toLowerCase();
    }

    const isPirate = !!(e.pirate_id) || type.includes("pirate") || faction.includes("pirate");
    const isNPC = isPirate || !!(e.is_npc) || type === "npc" || type === "enemy" || (typeof e.name === "string" && e.name.toLowerCase().includes("drifter"));

    entities.push({
      id,
      name: (e.name as string) || (e.username as string) || (e.pirate_name as string) || (e.pirate_id as string) || id,
      type,
      faction,
      isNPC,
      isPirate,
    });
  }

  // Parse pirates array (special format from get_nearby at POIs)
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
        tier: tier as "small" | "medium" | "large" | "capitol" | "boss",
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
    // Check tier restriction for pirates
    if (isTierTooHigh(entity.tier, maxAttackTier)) return false;
    return true;
  }
  if (onlyNPCs && !entity.isNPC) return false;

  // Fixed potential undefined checks
  const factionMatch = entity.faction ? PIRATE_KEYWORDS.some(kw => entity.faction.includes(kw)) : false;
  const typeMatch = entity.type ? PIRATE_KEYWORDS.some(kw => entity.type.includes(kw)) : false;
  const nameMatch = entity.name ? PIRATE_KEYWORDS.some(kw => entity.name.toLowerCase().includes(kw)) : false;

  return factionMatch || typeMatch || (entity.isNPC && nameMatch);
}

// ── Mission helpers ───────────────────────────────────────────

const COMBAT_MISSION_KEYWORDS = [
  "bounty", "pirate", "hunt", "kill", "eliminate", "destroy", "drifter",
  "combat", "hostile", "contract", "patrol", "neutralize",
];

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
  if (!availResp.result || typeof availResp.result !== "object") return;

  const r = availResp.result as Record<string, unknown>;
  const available = (
    Array.isArray(r) ? r :
    Array.isArray(r.missions) ? r.missions :
    []
  ) as Array<Record<string, unknown>>;

  for (const mission of available) {
    if (activeCount >= 5) break;

    const missionId = (mission.id as string) || (mission.mission_id as string) || "";
    if (!missionId) continue;

    const name = ((mission.name as string) || "").toLowerCase();
    const desc = ((mission.description as string) || "").toLowerCase();
    const type = ((mission.type as string) || "").toLowerCase();

    if (!COMBAT_MISSION_KEYWORDS.some(kw => name.includes(kw) || desc.includes(kw) || type.includes(kw))) continue;

    const acceptResp = await bot.exec("accept_mission", { mission_id: missionId });
    if (!acceptResp.error) {
      activeCount++;
      ctx.log("info", `Mission accepted: ${(mission.name as string) || missionId} (${activeCount}/5 active)`);
    }
  }
}

async function completeActiveMissions(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;
  if (!bot.docked) return;

  const activeResp = await bot.exec("get_active_missions");
  if (!activeResp.result || typeof activeResp.result !== "object") return;

  const r = activeResp.result as Record<string, unknown>;
  const missions = (
    Array.isArray(r) ? r :
    Array.isArray(r.missions) ? r.missions :
    []
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

// ── Safe-system docking ───────────────────────────────────────

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

// ── Combat — Tactical Battle System ──────────────────────────

/**
 * Emergency flee spam — sends flee commands rapidly until we escape.
 * Must send multiple commands or we'll get interrupted and stay in battle.
 */
async function emergencyFleeSpam(ctx: RoutineContext, reason: string): Promise<void> {
  const { bot } = ctx;
  ctx.log("combat", `🚨 EMERGENCY FLEE — ${reason}`);

  // Spam flee stance + retreat multiple times to ensure we escape
  for (let i = 0; i < 5; i++) {
    await bot.exec("battle", { action: "stance", stance: "flee" });
    await bot.exec("battle", { action: "retreat" });
  }

  // Wait for disengagement
  await sleep(5000);
  const status = await getBattleStatus(ctx);
  if (status) {
    ctx.log("combat", `⚠️ Still in battle after flee spam — trying again...`);
    for (let i = 0; i < 5; i++) {
      await bot.exec("battle", { action: "stance", stance: "flee" });
      await bot.exec("battle", { action: "retreat" });
    }
  } else {
    ctx.log("combat", `✅ Successfully disengaged from battle`);
  }
}

/**
 * Analyze an existing battle to determine if we should join and on which side.
 * Returns: { shouldJoin: boolean, sideId?: number, reason: string }
 */
async function analyzeExistingBattle(
  ctx: RoutineContext,
  maxAttackTier: PirateTier,
  minPiratesToFlee: number,
): Promise<{ shouldJoin: boolean; sideId?: number; reason: string }> {
  const { bot } = ctx;

  const battleStatus = await getBattleStatus(ctx);
  if (!battleStatus) {
    return { shouldJoin: false, reason: "No active battle detected" };
  }

  ctx.log("combat", `📊 Battle detected: ${battleStatus.battle_id}`);
  ctx.log("combat", `   Sides: ${battleStatus.sides.length} | Participants: ${battleStatus.participants.length}`);

  // Analyze each side to find player vs pirate dynamics
  const sides = battleStatus.sides;
  const participants = battleStatus.participants;

  // Track which side has players vs pirates
  interface SideAnalysis {
    sideId: number;
    playerCount: number;
    pirateCount: number;
    pirateTiers: string[];
    playerNames: string[];
    pirateNames: string[];
  }

  const sideAnalysis: SideAnalysis[] = sides.map(side => {
    const sideParticipants = participants.filter(p => p.side_id === side.side_id);
    const players = sideParticipants.filter(p => {
      // Check if this is a player (not an NPC pirate)
      const username = p.username || "";
      const isPirate = username.toLowerCase().includes("pirate") ||
                       username.toLowerCase().includes("drifter") ||
                       username.toLowerCase().includes("executioner") ||
                       username.toLowerCase().includes("sentinel") ||
                       username.toLowerCase().includes("prowler") ||
                       username.toLowerCase().includes("apex") ||
                       username.toLowerCase().includes("razor") ||
                       username.toLowerCase().includes("striker") ||
                       username.toLowerCase().includes("rampart") ||
                       username.toLowerCase().includes("stalwart") ||
                       username.toLowerCase().includes("bastion") ||
                       username.toLowerCase().includes("onslaught") ||
                       username.toLowerCase().includes("iron") ||
                       username.toLowerCase().includes("strike");
      return !isPirate && !p.username?.startsWith("[POLICE]");
    });
    const pirates = sideParticipants.filter(p => {
      const username = p.username || "";
      return username.toLowerCase().includes("pirate") ||
             username.toLowerCase().includes("drifter") ||
             username.toLowerCase().includes("executioner") ||
             username.toLowerCase().includes("sentinel") ||
             username.toLowerCase().includes("prowler") ||
             username.toLowerCase().includes("apex") ||
             username.toLowerCase().includes("razor") ||
             username.toLowerCase().includes("striker") ||
             username.toLowerCase().includes("rampart") ||
             username.toLowerCase().includes("stalwart") ||
             username.toLowerCase().includes("bastion") ||
             username.toLowerCase().includes("onslaught") ||
             username.toLowerCase().includes("iron") ||
             username.toLowerCase().includes("strike");
    });

    return {
      sideId: side.side_id,
      playerCount: players.length,
      pirateCount: pirates.length,
      pirateTiers: pirates.map(p => "unknown"), // Can't determine tier from battle status
      playerNames: players.map(p => p.username || p.player_id),
      pirateNames: pirates.map(p => p.username || p.player_id),
    };
  });

  ctx.log("combat", `   Side analysis: ${sideAnalysis.map(s =>
    `Side ${s.sideId}: ${s.playerCount} player(s) [${s.playerNames.join(",")}] vs ${s.pirateCount} pirate(s) [${s.pirateNames.join(",")}]`
  ).join(" | ")}`);

  // Check for [POLICE] participants — if present, this side is hostile to us if we attack their allies
  const hasPolice = participants.some(p => p.username?.startsWith("[POLICE]"));
  if (hasPolice) {
    return { shouldJoin: false, reason: "POLICE involved — staying out to avoid being marked criminal" };
  }

  // Find the side with players fighting pirates (our ideal join target)
  const playerVsPirateSides = sideAnalysis.filter(s => s.playerCount > 0 && s.pirateCount > 0);

  if (playerVsPirateSides.length === 0) {
    // Check if it's PvP (player vs player) — we must stay out
    const allPlayers = participants.filter(p => {
      const username = p.username || "";
      return !username.startsWith("[POLICE]") &&
             !username.toLowerCase().includes("pirate") &&
             !username.toLowerCase().includes("drifter");
    });

    if (allPlayers.length >= 2 && sides.length >= 2) {
      return { shouldJoin: false, reason: "PvP battle detected — staying out" };
    }

    // Might be pirate vs pirate — could join, but risky without knowing factions
    return { shouldJoin: false, reason: "Pirate vs pirate battle — not engaging" };
  }

  // We found player vs pirate — join the PLAYER's side
  const sideToJoin = playerVsPirateSides.find(s => s.playerCount > 0);
  if (!sideToJoin) {
    return { shouldJoin: false, reason: "Could not determine which side to join" };
  }

  // Assess threat — how many pirates on the opposing side?
  const opposingSide = sideAnalysis.find(s => s.sideId !== sideToJoin.sideId);
  const opposingPirateCount = opposingSide?.pirateCount || 0;

  // Flee if too many pirates on opposing side
  if (opposingPirateCount >= minPiratesToFlee) {
    return { shouldJoin: false, reason: `Too many pirates (${opposingPirateCount}) on opposing side — too dangerous` };
  }

  return {
    shouldJoin: true,
    sideId: sideToJoin.sideId,
    reason: `Joining side ${sideToJoin.sideId} (${sideToJoin.playerCount} player(s)) vs ${opposingPirateCount} pirate(s)`,
  };
}

/**
 * Main combat function — handles pre-battle assessment, engagement, and tactical combat.
 *
 * @returns true if we won/survived, false if we fled or lost
 */
async function engageTarget(
  ctx: RoutineContext,
  target: NearbyEntity,
  fleeThreshold: number,
  fleeFromTier: PirateTier,
  minPiratesToFlee: number,
  maxAttackTier: PirateTier,
): Promise<boolean> {
  const { bot } = ctx;

  if (!target.id) return false;

  // ── STEP 1: Check for existing battles ────────────────────
  const battleStatus = await getBattleStatus(ctx);

  if (battleStatus) {
    // There's already an active battle — analyze it
    ctx.log("combat", `⚔️ Existing battle detected — analyzing...`);
    const analysis = await analyzeExistingBattle(ctx, maxAttackTier, minPiratesToFlee);

    if (!analysis.shouldJoin) {
      ctx.log("combat", `⏭️ Skipping battle: ${analysis.reason}`);
      return false;
    }

    // Join the battle on the player's side
    ctx.log("combat", `✅ Joining battle on side ${analysis.sideId}: ${analysis.reason}`);
    const engageResp = await bot.exec("battle", { action: "engage", side_id: analysis.sideId!.toString() });

    if (engageResp.error) {
      ctx.log("error", `Failed to join battle: ${engageResp.error.message}`);
      return false;
    }

    // Now fight in the joined battle
    return await fightJoinedBattle(ctx, target, fleeThreshold, fleeFromTier, maxAttackTier);
  }

  // ── STEP 2: No existing battle — scan and initiate fresh fight ──
  ctx.log("combat", `🎯 Engaging ${target.name}...`);

  // Optional scan for info
  const scanResp = await bot.exec("scan", { target_id: target.id });
  if (!scanResp.error && scanResp.result) {
    const s = scanResp.result as Record<string, unknown>;
    const shipType = (s.ship_type as string) || (s.ship as string) || "unknown";
    const faction = (s.faction as string) || target.faction || "unknown";
    ctx.log("combat", `   Scan: ${target.name} — ${shipType} | Faction: ${faction}`);
  }

  // Start the battle
  const attackResp = await bot.exec("attack", { target_id: target.id });
  if (attackResp.error) {
    const msg = attackResp.error.message.toLowerCase();
    if (msg.includes("not found") || msg.includes("invalid") ||
        msg.includes("no target") || msg.includes("already")) {
      ctx.log("combat", `${target.name} is no longer available or already fighting`);
      return false;
    }
    ctx.log("error", `Attack failed on ${target.name}: ${attackResp.error.message}`);
    return false;
  }

  ctx.log("combat", `⚔️ Battle started with ${target.name} — advancing to engage`);

  return await fightFreshBattle(ctx, target, fleeThreshold, fleeFromTier, maxAttackTier);
}

/**
 * Fight a fresh battle we just started — advance to engaged, then tactical combat.
 */
async function fightFreshBattle(
  ctx: RoutineContext,
  target: NearbyEntity,
  fleeThreshold: number,
  fleeFromTier: PirateTier,
  maxAttackTier: PirateTier,
): Promise<boolean> {
  const { bot } = ctx;

  // ── STEP 1: Advance to engaged zone (3 ticks, 1 action per tick) ─────
  // Each advance costs 1 tick — we get attacked while advancing.
  // High-reach weapons (missiles, reach 3) fire from outer/mid zones.
  // Low-reach weapons (lasers, reach 1) only fire once we're in inner/engaged.
  for (let zone = 0; zone < 3; zone++) {
    if (bot.state !== "running") return false;

    await bot.refreshStatus();
    const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;

    if (hullPct <= fleeThreshold) {
      ctx.log("combat", `💀 Hull critical (${hullPct}%) while advancing — fleeing!`);
      await emergencyFleeSpam(ctx, "hull critical while advancing");
      return false;
    }

    const advResp = await bot.exec("battle", { action: "advance" });
    if (advResp.error) {
      ctx.log("error", `Advance failed: ${advResp.error.message}`);
      break;
    }

    const zoneNames = ["mid", "inner", "engaged"];
    ctx.log("combat", `   Advanced to ${zoneNames[zone]} zone (${zone + 1}/3)`);
  }

  // ── STEP 2: Set fire stance ───────────────────────────────
  await bot.exec("battle", { action: "stance", stance: "fire" });

  // ── STEP 3: Tactical combat loop ──────────────────────────
  // Combat is AUTO-RESOLVED — we just monitor and react
  const MAX_COMBAT_TICKS = 50;
  let consecutiveBraceTicks = 0;
  let lastKnownEnemyZone = "outer"; // Start tracking from outer zone

  for (let tick = 0; tick < MAX_COMBAT_TICKS; tick++) {
    if (bot.state !== "running") return false;

    // Use get_battle_status (FREE, no tick cost) to check state
    const status = await getBattleStatus(ctx);
    if (!status) {
      // Battle ended!
      ctx.log("combat", `✅ ${target.name} eliminated — battle complete`);
      return true;
    }

    // Check if our target is still alive in the battle
    const targetStillAlive = status.participants.some(
      p => (p.player_id === target.id || p.username === target.name) && !p.is_destroyed
    );

    if (!targetStillAlive) {
      // Target is marked destroyed but battle is still active.
      // The server may keep the battle running (auto-attacks, downed state, etc).
      // Stay in the combat loop — keep fire stance until the battle actually clears.
      ctx.log("combat", `⚠️ ${target.name} marked destroyed but battle still active — continuing to fight`);
    }

    // Check hull/shield from status (refresh our own status too)
    await bot.refreshStatus();
    const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    const shieldPct = bot.maxShield > 0 ? Math.round((bot.shield / bot.maxShield) * 100) : 100;

    // ── Track opponent zone — detect if pirate is fleeing or closing ──
    const targetParticipant = status.participants.find(
      p => p.player_id === target.id || p.username === target.name
    );
    if (targetParticipant && targetParticipant.zone) {
      if (targetParticipant.zone !== lastKnownEnemyZone) {
        const zoneDir = { outer: 0, mid: 1, inner: 2, engaged: 3 };
        const prevDir = zoneDir[lastKnownEnemyZone as keyof typeof zoneDir] ?? 0;
        const newDir = zoneDir[targetParticipant.zone as keyof typeof zoneDir] ?? 0;
        if (newDir > prevDir) {
          ctx.log("combat", `   ${target.name} moving closer: ${lastKnownEnemyZone} → ${targetParticipant.zone}`);
        } else if (newDir < prevDir) {
          ctx.log("combat", `   ⚠️ ${target.name} retreating: ${lastKnownEnemyZone} → ${targetParticipant.zone}`);
        } else {
          ctx.log("combat", `   ${target.name} zone: ${targetParticipant.zone}`);
        }
        lastKnownEnemyZone = targetParticipant.zone;
      }
    }

    // ── Emergency flee check ────────────────────────────────
    if (hullPct <= fleeThreshold) {
      ctx.log("combat", `💀 Hull critical (${hullPct}%) — FLEEING!`);
      await emergencyFleeSpam(ctx, `hull at ${hullPct}%`);
      return false;
    }

    // ── 3rd party detection — check for new participants ────
    const ourSideId = status.your_side_id;
    const thirdPartyParticipants = status.participants.filter(p =>
      p.side_id !== ourSideId &&
      p.player_id !== bot.username &&
      p.username !== bot.username &&
      !p.is_destroyed
    );

    // Check if any 3rd party is a player (not the original target)
    const hostileThirdParty = thirdPartyParticipants.find(p =>
      p.player_id !== target.id &&
      p.username !== target.name &&
      !p.username?.toLowerCase().includes("pirate") &&
      !p.username?.toLowerCase().includes("drifter")
    );

    if (hostileThirdParty) {
      ctx.log("combat", `🚨 3RD PARTY DETECTED: ${hostileThirdParty.username || hostileThirdParty.player_id} — FLEEING IMMEDIATELY!`);
      await emergencyFleeSpam(ctx, `3rd party joined: ${hostileThirdParty.username || hostileThirdParty.player_id}`);
      return false;
    }

    // ── Tactical stance decisions ───────────────────────────
    const shieldsCritical = shieldPct < 15 && hullPct < 70;

    if (shieldsCritical && consecutiveBraceTicks < 3) {
      // Brace for up to 3 ticks to regenerate shields
      ctx.log("combat", `🛡️ Tick ${tick + 1}: BRACE (shields ${shieldPct}%, hull ${hullPct}%)`);
      await bot.exec("battle", { action: "stance", stance: "brace" });
      consecutiveBraceTicks++;
    } else if (shieldsCritical && consecutiveBraceTicks >= 3) {
      // Been bracing too long — switch back to fire and hope for the best
      ctx.log("combat", `⚔️ Tick ${tick + 1}: SWITCHING BACK TO FIRE (braced ${consecutiveBraceTicks} ticks)`);
      await bot.exec("battle", { action: "stance", stance: "fire" });
      consecutiveBraceTicks = 0;
    } else {
      // Normal combat — fire stance
      if (consecutiveBraceTicks > 0) {
        ctx.log("combat", `⚔️ Tick ${tick + 1}: Resuming fire stance (shields ${shieldPct}%, hull ${hullPct}%)`);
      } else {
        ctx.log("combat", `⚔️ Tick ${tick + 1}: FIRE (hull ${hullPct}%, shields ${shieldPct}%)`);
      }
      await bot.exec("battle", { action: "stance", stance: "fire" });
      consecutiveBraceTicks = 0;
    }

    // Sleep between ticks to let combat resolve
    await sleep(2000);
  }

  // Max ticks reached — battle still ongoing, flee
  ctx.log("combat", `⏱️ Combat reached max ${MAX_COMBAT_TICKS} ticks — fleeing`);
  await emergencyFleeSpam(ctx, "max combat ticks reached");
  return false;
}

/**
 * Fight in a battle we joined via engage({ side_id }).
 * We skip the advance phase since we're already in the battle.
 */
async function fightJoinedBattle(
  ctx: RoutineContext,
  target: NearbyEntity,
  fleeThreshold: number,
  fleeFromTier: PirateTier,
  maxAttackTier: PirateTier,
): Promise<boolean> {
  const { bot } = ctx;

  ctx.log("combat", `🎯 Fighting in joined battle — targeting ${target.name}`);

  // Set our target and fire stance
  await bot.exec("battle", { action: "target", target_id: target.id });
  await bot.exec("battle", { action: "stance", stance: "fire" });

  // Reuse the same tactical combat loop
  const MAX_COMBAT_TICKS = 50;
  let consecutiveBraceTicks = 0;
  let lastKnownEnemyZone = "outer";

  for (let tick = 0; tick < MAX_COMBAT_TICKS; tick++) {
    if (bot.state !== "running") return false;

    const status = await getBattleStatus(ctx);
    if (!status) {
      ctx.log("combat", `✅ Battle complete — victory!`);
      return true;
    }

    const targetStillAlive = status.participants.some(
      p => (p.player_id === target.id || p.username === target.name) && !p.is_destroyed
    );

    if (!targetStillAlive) {
      // Target is marked destroyed but battle is still active.
      // Stay in the combat loop — keep fire stance until the battle actually clears.
      ctx.log("combat", `⚠️ ${target.name} marked destroyed but battle still active — continuing to fight`);
    }

    await bot.refreshStatus();
    const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    const shieldPct = bot.maxShield > 0 ? Math.round((bot.shield / bot.maxShield) * 100) : 100;

    // ── Track opponent zone — detect if pirate is fleeing or closing ──
    const targetParticipant = status.participants.find(
      p => p.player_id === target.id || p.username === target.name
    );
    if (targetParticipant && targetParticipant.zone) {
      if (targetParticipant.zone !== lastKnownEnemyZone) {
        const zoneDir = { outer: 0, mid: 1, inner: 2, engaged: 3 };
        const prevDir = zoneDir[lastKnownEnemyZone as keyof typeof zoneDir] ?? 0;
        const newDir = zoneDir[targetParticipant.zone as keyof typeof zoneDir] ?? 0;
        if (newDir > prevDir) {
          ctx.log("combat", `   ${target.name} moving closer: ${lastKnownEnemyZone} → ${targetParticipant.zone}`);
        } else if (newDir < prevDir) {
          ctx.log("combat", `   ⚠️ ${target.name} retreating: ${lastKnownEnemyZone} → ${targetParticipant.zone}`);
        } else {
          ctx.log("combat", `   ${target.name} zone: ${targetParticipant.zone}`);
        }
        lastKnownEnemyZone = targetParticipant.zone;
      }
    }

    if (hullPct <= fleeThreshold) {
      ctx.log("combat", `💀 Hull critical (${hullPct}%) — FLEEING!`);
      await emergencyFleeSpam(ctx, `hull at ${hullPct}%`);
      return false;
    }

    // 3rd party detection
    const ourSideId = status.your_side_id;
    const hostileThirdParty = status.participants.find(p =>
      p.side_id !== ourSideId &&
      p.player_id !== bot.username &&
      p.username !== bot.username &&
      p.player_id !== target.id &&
      p.username !== target.name &&
      !p.is_destroyed &&
      !p.username?.toLowerCase().includes("pirate") &&
      !p.username?.toLowerCase().includes("drifter")
    );

    if (hostileThirdParty) {
      ctx.log("combat", `🚨 3RD PARTY: ${hostileThirdParty.username || hostileThirdParty.player_id} — FLEEING!`);
      await emergencyFleeSpam(ctx, `3rd party: ${hostileThirdParty.username || hostileThirdParty.player_id}`);
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

  ctx.log("combat", `⏱️ Max ticks reached in joined battle — fleeing`);
  await emergencyFleeSpam(ctx, "max ticks in joined battle");
  return false;
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

// ── Ammo management ──────────────────────────────────────────

/**
 * Ensure the hunter has ammo loaded. Attempts reload up to maxAttempts times.
 * Returns false if out of ammo and needs to dock for resupply.
 */
async function ensureAmmoLoaded(
  ctx: RoutineContext,
  threshold: number,
  maxAttempts: number,
): Promise<boolean> {
  const { bot } = ctx;
  await bot.refreshStatus();

  if (bot.ammo > threshold) return true;
  if (bot.ammo < 0) return true; // ammo field not supported by this ship

  ctx.log("combat", `Ammo low (${bot.ammo}) — reloading...`);

  for (let i = 0; i < maxAttempts; i++) {
    const resp = await bot.exec("reload");
    if (resp.error) {
      const msg = resp.error.message.toLowerCase();
      if (msg.includes("full") || msg.includes("already")) {
        await bot.refreshStatus();
        return true;
      }
      if (msg.includes("no ammo") || msg.includes("no_ammo") || msg.includes("empty")) {
        ctx.log("combat", "No ammo available — need to resupply at station");
        return false;
      }
      ctx.log("combat", `Reload attempt ${i + 1} failed: ${resp.error.message}`);
      continue;
    }

    await bot.refreshStatus();
    if (bot.ammo > threshold) {
      ctx.log("combat", `Reloaded — ammo: ${bot.ammo}`);
      return true;
    }
  }

  ctx.log("combat", `Could not reload after ${maxAttempts} attempts — ammo: ${bot.ammo}`);
  return bot.ammo > 0;
}

// ── Faction alert response ────────────────────────────────────

/** Cooldown per system so we don't divert repeatedly (5 minutes). */
const ALERT_RESPONSE_COOLDOWN_MS = 5 * 60 * 1000;
/** Ignore faction alerts older than this (seconds, if API returns Unix time). */
const ALERT_STALENESS_SECS = 5 * 60;

/** Map<systemId, lastRespondedTimestamp> — persists across loop iterations. */
const respondedAlerts = new Map<string, number>();

/** Extract the system ID from a [COMBAT WARNING] or [HULL DAMAGE] faction message. */
function extractAlertSystem(content: string): string | null {
  // Both alert types end with:  ...| sys_xxxx/poi_yyyy
  const match = content.match(/\|\s*(sys_[a-z0-9_]+)\//i);
  return match ? match[1] : null;
}

/**
 * Scan recent faction chat for combat alerts from allied bots.
 * Returns the nearest threatened system if it's within `responseRange` jumps,
 * or null if there's nothing to respond to.
 */
async function checkFactionAlerts(
  ctx: RoutineContext,
  responseRange: number,
): Promise<string | null> {
  const { bot } = ctx;

  const chatResp = await bot.exec("get_chat_history", { channel: "faction" });
  if (chatResp.error || !chatResp.result) return null;

  const r = chatResp.result as Record<string, unknown>;
  const msgs = (
    Array.isArray(chatResp.result) ? chatResp.result :
    Array.isArray(r.messages) ? r.messages :
    Array.isArray(r.history) ? r.history :
    []
  ) as Array<Record<string, unknown>>;

  const nowSecs = Date.now() / 1000;
  const nowMs = Date.now();

  // Walk from newest → oldest (slice().reverse() in case order is oldest-first)
  for (const msg of [...msgs].reverse()) {
    const content = (msg.content as string) || (msg.message as string) || (msg.text as string) || "";
    if (!content.includes("[COMBAT WARNING]") && !content.includes("[HULL DAMAGE]")) continue;

    // Check message age if a timestamp is available
    const ts = (msg.timestamp as number) || (msg.created_at as number) || 0;
    if (ts > 0 && nowSecs - ts > ALERT_STALENESS_SECS) continue;

    const alertSystem = extractAlertSystem(content);
    if (!alertSystem) continue;

    // Already here — no need to divert
    if (alertSystem === bot.system) continue;

    // Cooldown per system
    const lastMs = respondedAlerts.get(alertSystem) ?? 0;
    if (nowMs - lastMs < ALERT_RESPONSE_COOLDOWN_MS) continue;

    // Check proximity via known map routes (use blacklist)
    const blacklist = getSystemBlacklist();
    const route = mapStore.findRoute(bot.system, alertSystem, blacklist);
    if (!route || route.length > responseRange) continue;

    return alertSystem;
  }

  return null;
}

// ── Hunter routine ───────────────────────────────────────────

export const hunterRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  await bot.refreshStatus();
  let totalKills = 0;

  while (bot.state === "running") {
    // ── Death recovery ──
    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) { await sleep(30000); continue; }

    const settings = getHunterSettings(bot.username);
    const safetyOpts = {
      fuelThresholdPct: settings.refuelThreshold,
      hullThresholdPct: settings.repairThreshold,
      autoCloak: settings.autoCloak,
    };
    const patrolSystem = settings.system || "";

    // ── Status ──
    yield "get_status";
    await bot.refreshStatus();
    logStatus(ctx);

    // ── Fuel check ──
    yield "fuel_check";
    const fueled = await ensureFueled(ctx, settings.refuelThreshold);
    if (!fueled) {
      ctx.log("error", "Cannot secure fuel — waiting 30s...");
      await sleep(30000);
      continue;
    }

    // ── Hull check — retreat to a high-security system to repair ──
    await bot.refreshStatus();
    const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    if (hullPct <= settings.repairThreshold) {
      ctx.log("system", `Hull at ${hullPct}% — retreating to high-security system for repairs`);
      yield "emergency_repair";
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

    // ── Faction alert check — divert if an ally is nearby and under attack ──
    yield "faction_alert_check";
    const alertTarget = await checkFactionAlerts(ctx, settings.responseRange);
    if (alertTarget) {
      const sys = mapStore.getSystem(alertTarget);
      const blacklist = getSystemBlacklist();
      const route = mapStore.findRoute(bot.system, alertTarget, blacklist);
      const jumps = route ? route.length : "?";
      ctx.log("combat", `Faction alert! ${sys?.name || alertTarget} is under attack (${jumps} jump(s)) — diverting to assist`);
      respondedAlerts.set(alertTarget, Date.now());
      try {
        await bot.exec("chat", {
          channel: "faction",
          content: `[HUNTER RESPONSE] ${bot.username} en route to ${sys?.name || alertTarget} (${jumps} jump(s)) to assist`,
        });
      } catch { /* non-fatal */ }
      // Override patrol target for this cycle
      const arrived = await navigateToSystem(ctx, alertTarget, safetyOpts);
      if (!arrived) {
        ctx.log("error", `Could not reach ${alertTarget} — resuming normal patrol`);
      }
    }

    // ── Navigate to a huntable (low/unregulated) system ──
    yield "find_patrol_system";

    if (patrolSystem && bot.system !== patrolSystem) {
      ctx.log("travel", `Navigating to configured patrol system ${patrolSystem}...`);
      const arrived = await navigateToSystem(ctx, patrolSystem, safetyOpts);
      if (!arrived) {
        ctx.log("error", `Could not reach ${patrolSystem} — patrolling ${bot.system} instead`);
      }
    } else {
      await fetchSecurityLevel(ctx, bot.system);
      const currentSec = mapStore.getSystem(bot.system)?.security_level;

      if (!isHuntableSystem(currentSec)) {
        ctx.log("travel", `${bot.system} is ${currentSec || "unknown"} security — searching for a huntable system...`);

        const huntTarget = findNearestHuntableSystem(bot.system);
        if (huntTarget) {
          const sys = mapStore.getSystem(huntTarget);
          ctx.log("travel", `Found huntable system: ${sys?.name || huntTarget} (${sys?.security_level}) — navigating...`);
          await navigateToSystem(ctx, huntTarget, safetyOpts);
        } else {
          const conns = mapStore.getConnections(bot.system);
          const unmapped = conns.find(c => !mapStore.getSystem(c.system_id)?.security_level);
          const target = unmapped ?? conns[0];
          if (target) {
            ctx.log("travel", `No huntable system mapped yet — scouting ${target.system_name || target.system_id}...`);
            await navigateToSystem(ctx, target.system_id, safetyOpts);
            await getSystemInfo(ctx);
            await fetchSecurityLevel(ctx, bot.system);
          } else {
            ctx.log("error", "No connected systems found — waiting 30s");
            await sleep(30000);
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
      await sleep(3000);
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
      if (midHull <= settings.repairThreshold) {
        ctx.log("system", `Hull at ${midHull}% — aborting patrol, heading to station`);
        abortPatrol = true;
        break;
      }
      if (midFuel < settings.refuelThreshold) {
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

      // Scan for targets
      yield "scan_for_targets";
      const nearbyResp = await bot.exec("get_nearby");
      //ctx.log("info", `get_nearby: ${nearbyResp}.`);
      if (nearbyResp.error) {
        ctx.log("error", `get_nearby at ${poi.name}: ${nearbyResp.error.message}`);
        continue;
      }

      // Track player names from nearby scan
      bot.trackNearbyPlayers(nearbyResp.result);

      const entities = parseNearby(nearbyResp.result);
      ctx.log("info", `entities: ${entities}`);
      const targets = entities.filter(e => isPirateTarget(e, settings.onlyNPCs, settings.maxAttackTier));

      if (targets.length === 0) {
        ctx.log("combat", `No targets at ${poi.name}`);
        await scavengeWrecks(ctx);
        continue;
      }

      ctx.log("combat", `Found ${targets.length} target(s) at ${poi.name}: ${targets.map(t => t.name).join(", ")}`);

      // Engage each target
      for (const target of targets) {
        if (bot.state !== "running") break;

        await bot.refreshStatus();
        const preHull = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
        if (preHull <= settings.repairThreshold) {
          ctx.log("system", `Hull at ${preHull}% — too low for another fight`);
          abortPatrol = true;
          break;
        }

        // Pre-fight ammo check - use ensureAmmoLoaded since bot.ammo may not reflect module-level ammo
        const hasAmmo = await ensureAmmoLoaded(ctx, settings.ammoThreshold, settings.maxReloadAttempts);
        if (!hasAmmo) {
          ctx.log("combat", "Out of ammo — aborting patrol to resupply");
          abortPatrol = true;
          break;
        }

        yield "engage";
        const won = await engageTarget(ctx, target, settings.fleeThreshold, settings.fleeFromTier, settings.minPiratesToFlee, settings.maxAttackTier);

        if (won) {
          totalKills++;
          patrolKills++;
          ctx.log("combat", `Kill #${totalKills} — looting wreck...`);

          yield "loot";
          await scavengeWrecks(ctx);

          // Post-kill reload
          const hasAmmo = await ensureAmmoLoaded(ctx, settings.ammoThreshold, settings.maxReloadAttempts);
          if (!hasAmmo) {
            ctx.log("combat", "No ammo after kill — aborting patrol to resupply");
            abortPatrol = true;
          }

          await bot.refreshStatus();
          ctx.log("combat", `Post-fight: hull ${bot.hull}/${bot.maxHull} | ammo ${bot.ammo} | credits ${bot.credits}`);
        } else {
          ctx.log("combat", "Retreated — aborting patrol to dock and repair");
          abortPatrol = true;
          break;
        }
      }
    }

    // ── Post-patrol decision ──
    yield "post_patrol";
    await bot.refreshStatus();
    const postHull = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    const postFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;

    const needsRepair = abortPatrol || postHull <= settings.repairThreshold;
    const needsFuel = postFuel < settings.refuelThreshold;

    if (needsRepair || needsFuel) {
      const reason = needsRepair ? `hull ${postHull}%` : `fuel ${postFuel}%`;
      ctx.log("system", `Patrol sweep done — ${patrolKills} kill(s). Returning to safe system (${reason})...`);

      yield "dock";
      const docked = await navigateToSafeStation(ctx, safetyOpts);
      if (!docked) {
        ctx.log("error", "Could not dock anywhere — retrying next cycle");
        continue;
      }

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
      await ensureAmmoLoaded(ctx, settings.ammoThreshold, settings.maxReloadAttempts);

      yield "fit_mods";
      const modProfile = getModProfile("hunter");
      if (modProfile.length > 0) await ensureModsFitted(ctx, modProfile);

      yield "check_skills";
      await bot.checkSkills();

      ctx.log("info", `=== Patrol complete. Total kills: ${totalKills} | Credits: ${bot.credits} ===`);

    } else {
      ctx.log("system", `Patrol sweep done — ${patrolKills} kill(s). Hull: ${postHull}% | Fuel: ${postFuel}% — continuing hunt...`);

      if (!patrolSystem) {
        const nextSystem = findNextHuntSystem(bot.system);
        if (nextSystem) {
          const sys = mapStore.getSystem(nextSystem);
          ctx.log("travel", `Moving to ${sys?.name || nextSystem} (${sys?.security_level || "unknown"}) to continue hunt...`);
          await navigateToSystem(ctx, nextSystem, safetyOpts);
          await getSystemInfo(ctx);
          await fetchSecurityLevel(ctx, bot.system);
        } else {
          ctx.log("info", "No adjacent huntable system found — will search next cycle");
        }
      }
    }
  }
};






