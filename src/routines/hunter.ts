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
import { catalogStore } from "../catalogstore.js";
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
 * Emergency flee — properly synced with server ticks.
 * 
 * KEY: We can ONLY flee when we're NOT in the engaged zone.
 * If we're in engaged zone, we must retreat first, then flee.
 * We wait for get_battle_status after EACH command to sync with server ticks.
 */
async function emergencyFleeSpam(ctx: RoutineContext, reason: string): Promise<void> {
  const { bot } = ctx;
  ctx.log("combat", `🚨 EMERGENCY FLEE — ${reason}`);

  // Check battle status to determine our zone
  let status = await getBattleStatus(ctx);
  if (!status) {
    ctx.log("combat", `✅ Not in battle - no need to flee`);
    return;
  }

  // Try to flee using proper flee stance
  // The flee stance takes 3 ticks to complete, so we set it once and wait
  const fleeResp = await bot.exec("battle", { action: "stance", stance: "flee" });
  
  if (fleeResp.error) {
    const errMsg = fleeResp.error.message.toLowerCase();
    // If we get in_battle error, it means we're trying to do something while in combat
    // We should just wait and check battle status again
    if (errMsg.includes("in_battle") || errMsg.includes("in combat")) {
      ctx.log("combat", `⚠️ Flee stance blocked - already in battle action. Waiting for tick to complete...`);
      await sleep(2000);
      status = await getBattleStatus(ctx);
      if (!status) {
        ctx.log("combat", `✅ Battle ended during flee attempt`);
        return;
      }
    } else {
      ctx.log("error", `Flee stance failed: ${fleeResp.error.message}`);
    }
  }

  // Wait for server to process the flee stance (3 ticks = ~6 seconds)
  ctx.log("combat", `Flee stance set - waiting for disengagement (3 ticks)...`);
  
  const MAX_FLEE_WAIT_TICKS = 10; // Max wait to prevent infinite loops
  let waitTicks = 0;
  
  for (waitTicks = 0; waitTicks < MAX_FLEE_WAIT_TICKS; waitTicks++) {
    await sleep(2000); // Wait 2 seconds per check
    
    status = await getBattleStatus(ctx);
    if (!status) {
      ctx.log("combat", `✅ Successfully disengaged from battle`);
      return;
    }
    
    // Check if our zone changed (should be retreating)
    const ourZone = status.your_zone;
    if (ourZone && ourZone !== "engaged") {
      ctx.log("combat", `Retreating from ${ourZone} zone...`);
    }
  }
  
  // Check if we're still in battle after waiting
  status = await getBattleStatus(ctx);
  if (status) {
    ctx.log("combat", `⚠️ Still in battle after flee wait - trying retreat commands...`);
    
    // Try retreat commands to escape
    for (let i = 0; i < 3; i++) {
      const retreatResp = await bot.exec("battle", { action: "retreat" });
      if (retreatResp.error) {
        const errMsg = retreatResp.error.message.toLowerCase();
        if (errMsg.includes("in_battle") || errMsg.includes("in combat")) {
          ctx.log("combat", `⚠️ Retreat blocked - in battle action. Waiting...`);
          await sleep(2000);
        } else {
          ctx.log("error", `Retreat failed: ${retreatResp.error.message}`);
        }
      }
      
      // Check if we escaped
      await sleep(1000);
      status = await getBattleStatus(ctx);
      if (!status) {
        ctx.log("combat", `✅ Successfully disengaged after retreat`);
        return;
      }
    }
    
    ctx.log("warn", `⚠️ Still in battle after flee attempts - will continue checking on next tick`);
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

  // Optional scan for info - try pirate_id first, then name if it fails
  let scanResp = await bot.exec("scan", { target_id: target.id });
  
  // If scan fails with invalid_target, try using the name instead
  if (scanResp.error && scanResp.error.message.toLowerCase().includes("invalid_target")) {
    ctx.log("combat", `Scan with pirate_id failed - trying name instead...`);
    scanResp = await bot.exec("scan", { target_id: target.name });
  }
  
  if (!scanResp.error && scanResp.result) {
    const s = scanResp.result as Record<string, unknown>;
    const shipType = (s.ship_type as string) || (s.ship as string) || "unknown";
    const faction = (s.faction as string) || target.faction || "unknown";
    ctx.log("combat", `   Scan: ${target.name} — ${shipType} | Faction: ${faction}`);
  }

  // Start the battle - try pirate_id first, fallback to name if needed
  let attackResp = await bot.exec("attack", { target_id: target.id });
  
  // If attack fails, try using the name as fallback
  if (attackResp.error) {
    const msg = attackResp.error.message.toLowerCase();
    if (msg.includes("not found") || msg.includes("invalid") || msg.includes("not in")) {
      ctx.log("combat", `Attack with pirate_id failed - trying name "${target.name}" instead...`);
      attackResp = await bot.exec("attack", { target_id: target.name });
    }
  }
  
  if (attackResp.error) {
    const msg = attackResp.error.message.toLowerCase();
    if (msg.includes("not found") || msg.includes("invalid") ||
        msg.includes("no target") || msg.includes("already") || msg.includes("not in")) {
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
  for (let zone = 0; zone < 3; zone++) {
    if (bot.state !== "running") return false;

    // Check battle status first (free command)
    const status = await getBattleStatus(ctx);
    if (!status) {
      ctx.log("combat", `✅ Battle ended during advance — ${target.name} eliminated!`);
      return true;
    }

    await bot.refreshStatus();
    const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;

    if (hullPct <= fleeThreshold) {
      ctx.log("combat", `💀 Hull critical (${hullPct}%) while advancing — fleeing!`);
      await emergencyFleeSpam(ctx, "hull critical while advancing");
      return false;
    }

    // Send advance command (locks us for 1 tick until server responds)
    const advResp = await bot.exec("battle", { action: "advance" });
    if (advResp.error) {
      ctx.log("error", `Advance failed: ${advResp.error.message}`);
      break;
    }

    // After server responds, check battle status to see what happened
    const postAdvanceStatus = await getBattleStatus(ctx);
    if (postAdvanceStatus) {
      const zoneNames = ["mid", "inner", "engaged"];
      ctx.log("combat", `   Advanced to ${zoneNames[zone]} zone (${zone + 1}/3) | Hull: ${hullPct}%`);
    }
  }

  // ── STEP 2: Tactical combat loop — ONE command per tick, server-synced ──
  // Based on analysis of actual winning battles:
  // - Player NEVER re-sends "stance fire" after initial set
  // - Player uses advance/retreat as combat actions
  // - Player retreats to stay in engaged zone (defensive positioning)
  // - Against bosses (high damage), brace MUCH earlier
  
  let consecutiveBraceTicks = 0;
  let lastKnownEnemyZone = "outer";
  let tickCount = 0;
  let totalDamageTaken = 0;
  let lastHull = bot.hull;

  // Set fire stance ONCE - never re-send unless switching from brace
  await bot.exec("battle", { action: "stance", stance: "fire" });
  const initialStatus = await getBattleStatus(ctx); // Wait for server response
  let ourCurrentZone = initialStatus?.your_zone || "outer";

  while (true) {
    if (bot.state !== "running") return false;
    tickCount++;

    // STEP 1: Get battle status (FREE command - doesn't lock us)
    const status = await getBattleStatus(ctx);
    if (!status) {
      ctx.log("combat", `✅ ${target.name} eliminated — battle complete (${tickCount} ticks, victory!)`);
      return true;
    }

    // Find target in battle
    const targetParticipant = status.participants.find(
      p => p.player_id === target.id || p.username === target.name
    );
    const targetStillAlive = targetParticipant && !targetParticipant.is_destroyed;

    if (!targetStillAlive && targetParticipant) {
      ctx.log("combat", `⚠️ ${target.name} marked destroyed but battle still active — waiting for battle end...`);
      // Keep checking until battle ends
      await sleep(2000);
      continue;
    }

    // STEP 2: Refresh our hull/shield status
    await bot.refreshStatus();
    const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    const shieldPct = bot.maxShield > 0 ? Math.round((bot.shield / bot.maxShield) * 100) : 100;
    
    // Track damage taken per tick
    const damageThisTick = Math.max(0, lastHull - bot.hull);
    totalDamageTaken += damageThisTick;
    lastHull = bot.hull;

    // STEP 3: Track enemy zone movement
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

    // STEP 4: Emergency flee check (ONLY based on hull, not ticks)
    if (hullPct <= fleeThreshold) {
      ctx.log("combat", `💀 Hull critical (${hullPct}%) — FLEEING!`);
      await emergencyFleeSpam(ctx, `hull at ${hullPct}%`);
      return false;
    }

    // STEP 5: Detect new third parties (pirates/players that weren't in original fight)
    const ourSideId = status.your_side_id;
    const thirdPartyParticipants = status.participants.filter(p =>
      p.side_id !== ourSideId &&
      p.player_id !== bot.username &&
      p.username !== bot.username &&
      p.player_id !== target.id &&
      p.username !== target.name &&
      !p.is_destroyed
    );

    // Flee if we see 2+ new entities or any unknown players
    if (thirdPartyParticipants.length >= 2) {
      ctx.log("combat", `🚨 ${thirdPartyParticipants.length} THIRD PARTIES DETECTED — FLEEING!`);
      await emergencyFleeSpam(ctx, `${thirdPartyParticipants.length} third parties in battle`);
      return false;
    }

    // STEP 6: Log battle state for debugging
    const enemyStance = targetParticipant?.stance || "unknown";
    const enemyZone = targetParticipant?.zone || "unknown";
    ctx.log("combat", `Tick ${tickCount}: Enemy=${enemyStance}/${enemyZone} | Hull=${hullPct}% | Shields=${shieldPct}% | Dmg=${damageThisTick}`);

    // STEP 7: Decide our action based on battle state
    // CRITICAL: Only send ONE command per tick, and ONLY if we need to change something!
    // Winning battle analysis: Player used advance/retreat, NOT repeated stance commands
    
    const zoneDirMap = { outer: 0, mid: 1, inner: 2, engaged: 3 };
    const enemyZoneNum = zoneDirMap[enemyZone as keyof typeof zoneDirMap] ?? 0;
    const ourZoneNum = zoneDirMap[ourCurrentZone as keyof typeof zoneDirMap] ?? 0;

    // Check if we're fighting a boss/high-damage enemy
    const isHighDamageEnemy = damageThisTick > 50 || (target.tier && ["boss", "capitol", "large"].includes(target.tier));

    // Brace earlier against high-damage enemies: shields < 40% OR hull < 50%
    // Normal enemies: shields < 15% AND hull < 70%
    const shieldsCritical = isHighDamageEnemy
      ? (shieldPct < 40 || hullPct < 50)
      : (shieldPct < 15 && hullPct < 70);

    if (shieldsCritical && consecutiveBraceTicks < 3) {
      // BRACE - recover shields
      ctx.log("combat", `🛡️ BRACE (${isHighDamageEnemy ? 'high-damage enemy' : 'shields critical'})`);
      await bot.exec("battle", { action: "stance", stance: "brace" });
      consecutiveBraceTicks++;
    } else if (shieldsCritical && consecutiveBraceTicks >= 3) {
      // Switch back to fire after bracing
      ctx.log("combat", `⚔️ FIRE (braced ${consecutiveBraceTicks} ticks, switching back)`);
      await bot.exec("battle", { action: "stance", stance: "fire" });
      consecutiveBraceTicks = 0;
    } else if (consecutiveBraceTicks > 0) {
      // Resume fire stance after bracing
      ctx.log("combat", `⚔️ FIRE (resuming after brace)`);
      await bot.exec("battle", { action: "stance", stance: "fire" });
      consecutiveBraceTicks = 0;
    } else {
      // Normal combat - use positional tactics like winning battle
      // If enemy is in same zone as us, retreat to maintain position (defensive)
      // If enemy is behind us, advance to maintain pressure
      // If enemy is ahead of us, advance to catch up

      if (enemyZoneNum > ourZoneNum) {
        // Enemy is ahead - advance to catch up
        ctx.log("combat", `⚔️ ADVANCING (enemy in ${enemyZone}, we're in ${ourCurrentZone})`);
        const advResp = await bot.exec("battle", { action: "advance" });
        if (!advResp.error) {
          // Update our zone based on response
          const newZoneNum = Math.min(3, ourZoneNum + 1);
          ourCurrentZone = (["outer", "mid", "inner", "engaged"][newZoneNum]) as typeof ourCurrentZone;
        }
      } else if (enemyZoneNum <= ourZoneNum && ourZoneNum > 0) {
        // Enemy is in same zone or behind - retreat to maintain engaged zone
        // This is the winning strategy: stay in engaged zone while fighting
        ctx.log("combat", `🔄 RETREAT (maintaining position in ${ourCurrentZone})`);
        const retResp = await bot.exec("battle", { action: "retreat" });
        if (!retResp.error) {
          // Retreat might keep us in same zone or move us back
          const newZoneNum = Math.max(0, ourZoneNum - 1);
          ourCurrentZone = (["outer", "mid", "inner", "engaged"][newZoneNum]) as typeof ourCurrentZone;
        }
      } else {
        // Both in outer zone - advance
        ctx.log("combat", `⚔️ ADVANCING to engage`);
        await bot.exec("battle", { action: "advance" });
        ourCurrentZone = "mid";
      }
    }

    // Wait for server to process our command (get_battle_status will sync with next tick)
    await sleep(2000);
  }
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
  await getBattleStatus(ctx); // Wait for server response

  // Tactical combat loop — server-synced ticks, NO arbitrary tick limit
  let consecutiveBraceTicks = 0;
  let lastKnownEnemyZone = "outer";
  let tickCount = 0;

  while (true) {
    if (bot.state !== "running") return false;
    tickCount++;

    // STEP 1: Get battle status (FREE command)
    const status = await getBattleStatus(ctx);
    if (!status) {
      ctx.log("combat", `✅ Battle complete — victory! (${tickCount} ticks)`);
      return true;
    }

    // Find target
    const targetParticipant = status.participants.find(
      p => p.player_id === target.id || p.username === target.name
    );
    const targetStillAlive = targetParticipant && !targetParticipant.is_destroyed;

    if (!targetStillAlive && targetParticipant) {
      ctx.log("combat", `⚠️ ${target.name} marked destroyed but battle still active — waiting...`);
      await sleep(2000);
      continue;
    }

    // STEP 2: Refresh our status
    await bot.refreshStatus();
    const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    const shieldPct = bot.maxShield > 0 ? Math.round((bot.shield / bot.maxShield) * 100) : 100;

    // STEP 3: Track enemy zone
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

    // STEP 4: Emergency flee check (ONLY based on hull, not ticks)
    if (hullPct <= fleeThreshold) {
      ctx.log("combat", `💀 Hull critical (${hullPct}%) — FLEEING!`);
      await emergencyFleeSpam(ctx, `hull at ${hullPct}%`);
      return false;
    }

    // STEP 5: Third party detection
    const ourSideId = status.your_side_id;
    const thirdPartyParticipants = status.participants.filter(p =>
      p.side_id !== ourSideId &&
      p.player_id !== bot.username &&
      p.username !== bot.username &&
      p.player_id !== target.id &&
      p.username !== target.name &&
      !p.is_destroyed
    );

    if (thirdPartyParticipants.length >= 2) {
      ctx.log("combat", `🚨 ${thirdPartyParticipants.length} THIRD PARTIES DETECTED — FLEEING!`);
      await emergencyFleeSpam(ctx, `${thirdPartyParticipants.length} third parties in battle`);
      return false;
    }

    // STEP 6: Log battle state
    const enemyStance = targetParticipant?.stance || "unknown";
    const enemyZone = targetParticipant?.zone || "unknown";
    ctx.log("combat", `Tick ${tickCount}: Enemy=${enemyStance}/${enemyZone} | Hull=${hullPct}% | Shields=${shieldPct}%`);

    // STEP 7: Decide action - use positional tactics like winning battle
    const zoneDirMap = { outer: 0, mid: 1, inner: 2, engaged: 3 };
    const enemyZoneNum = zoneDirMap[enemyZone as keyof typeof zoneDirMap] ?? 0;
    const ourZone = status.your_zone || "outer";
    const ourZoneNum = zoneDirMap[ourZone as keyof typeof zoneDirMap] ?? 0;
    
    // Check if fighting high-damage enemy (boss/capitol/large)
    const isHighDamageEnemy = target.tier && ["boss", "capitol", "large"].includes(target.tier);
    
    // Brace earlier against high-damage enemies
    const shieldsCritical = isHighDamageEnemy 
      ? (shieldPct < 40 || hullPct < 50) 
      : (shieldPct < 15 && hullPct < 70);

    if (shieldsCritical && consecutiveBraceTicks < 3) {
      ctx.log("combat", `🛡️ BRACE (${isHighDamageEnemy ? 'high-damage enemy' : 'shields critical'})`);
      await bot.exec("battle", { action: "stance", stance: "brace" });
      consecutiveBraceTicks++;
    } else if (shieldsCritical && consecutiveBraceTicks >= 3) {
      ctx.log("combat", `⚔️ FIRE (braced ${consecutiveBraceTicks} ticks, switching back)`);
      await bot.exec("battle", { action: "stance", stance: "fire" });
      consecutiveBraceTicks = 0;
    } else if (consecutiveBraceTicks > 0) {
      ctx.log("combat", `⚔️ FIRE (resuming after brace)`);
      await bot.exec("battle", { action: "stance", stance: "fire" });
      consecutiveBraceTicks = 0;
    } else {
      // Normal combat - use positional tactics
      if (enemyZoneNum > ourZoneNum) {
        ctx.log("combat", `⚔️ ADVANCING (enemy in ${enemyZone}, we're in ${ourZone})`);
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

interface WeaponModule {
  instanceId: string;
  moduleId: string;
  name: string;
  currentAmmo: number;
  maxAmmo: number;
  ammoType?: string;
}

/**
 * Fetch weapon modules from get_ship and return those with ammo info.
 * Looks up ammo_type from catalog using the module_id.
 * Handles both traditional ammo weapons and missile launchers.
 */
async function getWeaponModules(ctx: RoutineContext): Promise<WeaponModule[]> {
  const { bot } = ctx;
  const shipResp = await bot.exec("get_ship");
  if (shipResp.error || !shipResp.result) {
    ctx.log("error", `get_ship failed for weapon info: ${shipResp.error?.message}`);
    return [];
  }

  const result = shipResp.result as Record<string, unknown>;
  const ship = (result.ship as Record<string, unknown>) || result;
  const modulesArray = (
    Array.isArray(ship.modules) ? ship.modules :
    Array.isArray(result.modules) ? result.modules :
    []
  ) as Array<Record<string, unknown>>;

  const weapons: WeaponModule[] = [];
  for (const mod of modulesArray) {
    if (!mod || typeof mod !== "object") continue;

    // Check if this is a weapon module
    const modType = ((mod.type as string) || (mod.module_type as string) || "").toLowerCase();
    const modId = ((mod.module_id as string) || (mod.mod_id as string) || (mod.id as string) || "").toLowerCase();

    // Skip if not a weapon module
    const isWeapon = modType.includes("weapon") || modType.includes("missile") || modType.includes("launcher") || modType.includes("torpedo") || modId.includes("weapon") || modId.includes("missile") || modId.includes("launcher");
    if (!isWeapon) continue;

    // Try to get ammo_type from module data first, then from catalog
    let ammoType = (mod.ammo_type as string) || (mod.ammo_item_id as string) || (mod.ammo as string);

    // If not in module data, look it up from catalog
    if (!ammoType && modId) {
      const catalogModule = catalogStore.getItem(modId);
      if (catalogModule) {
        ammoType = (catalogModule as Record<string, unknown>).ammo_type as string;
      }
    }

    // Get instance ID and module ID
    const instanceId = (mod.instance_id as string) ||
                       (mod.weapon_instance_id as string) ||
                       (mod.module_instance_id as string) ||
                       (mod.id as string) || "";
    const moduleId = (mod.module_id as string) || (mod.mod_id as string) || (mod.id as string) || "";
    const currentAmmo = (mod.current_ammo as number) ?? 0;
    const maxAmmo = (mod.max_ammo as number) ?? 0;

    if (instanceId && moduleId) {
      weapons.push({
        instanceId,
        moduleId,
        name: (mod.name as string) || moduleId,
        currentAmmo,
        maxAmmo,
        ammoType, // May be undefined for missile launchers - will check cargo instead
      });
    }
  }

  return weapons;
}

/**
 * Ensure the hunter has ammo loaded. Only reloads when ammo <= 25% of max capacity.
 * Uses proper reload command with weapon_instance_id and ammo_item_id from cargo.
 * Returns false if out of ammo and needs to dock for resupply.
 * 
 * Handles both traditional weapons (with reported ammo) and missile launchers
 * (which may not report ammo state but still need cargo ammo).
 */
async function ensureAmmoLoaded(
  ctx: RoutineContext,
  _threshold: number,
  maxAttempts: number,
): Promise<boolean> {
  const { bot } = ctx;

  // Get weapon modules to check ammo
  const weapons = await getWeaponModules(ctx);
  if (weapons.length === 0) {
    ctx.log("warn", "No weapon modules found — skipping reload");
    return true;
  }

  // Get cargo to find matching ammo
  await bot.refreshCargo();
  const cargoItems = bot.inventory.map(item => ({
    itemId: item.itemId,
    quantity: item.quantity,
  }));

  // Check each weapon for ammo needs
  let anyReloaded = false;
  
  for (const weapon of weapons) {
    // Skip weapons with no defined ammo type
    if (!weapon.ammoType) {
      ctx.log("warn", `Weapon "${weapon.name}" has no ammo type defined — skipping`);
      continue;
    }

    // For weapons with maxAmmo > 0, check if they need reload (<=25%)
    // For missile launchers with maxAmmo == 0, always try to reload if we have cargo ammo
    let needsReload = false;
    
    if (weapon.maxAmmo > 0) {
      // Traditional weapon with known ammo capacity
      needsReload = weapon.currentAmmo <= Math.floor(weapon.maxAmmo * 0.25);
      if (needsReload) {
        ctx.log("combat", `Weapon "${weapon.name}" ammo low: ${weapon.currentAmmo}/${weapon.maxAmmo} (<=25%, type: ${weapon.ammoType})`);
      }
    } else {
      // Missile launcher or weapon with unknown ammo state
      // Check if we have ammo in cargo and try to reload
      const matchingAmmo = catalogStore.findMatchingAmmoInCargo(cargoItems, weapon.ammoType);
      if (matchingAmmo.length > 0) {
        ctx.log("combat", `Weapon "${weapon.name}" ammo state unknown - attempting reload with ${weapon.ammoType}`);
        needsReload = true;
      } else {
        ctx.log("warn", `Weapon "${weapon.name}" needs ${weapon.ammoType} but none in cargo`);
      }
    }

    if (!needsReload) continue;

    // Find matching ammo in cargo
    const matchingAmmo = catalogStore.findMatchingAmmoInCargo(cargoItems, weapon.ammoType);

    if (matchingAmmo.length === 0) {
      ctx.log("combat", `⚠️ No ${weapon.ammoType} ammo in cargo for "${weapon.name}" — need to resupply`);
      continue;
    }

    // Use the first matching ammo
    const ammoItem = matchingAmmo[0];
    ctx.log("combat", `Found ${ammoItem.quantity}x ${ammoItem.itemId} (${weapon.ammoType}) — reloading "${weapon.name}"...`);

    for (let i = 0; i < maxAttempts; i++) {
      const resp = await bot.exec("reload", {
        weapon_instance_id: weapon.instanceId,
        ammo_item_id: ammoItem.itemId,
      });

      if (resp.error) {
        const msg = resp.error.message.toLowerCase();
        if (msg.includes("full") || msg.includes("already")) {
          ctx.log("combat", `Weapon "${weapon.name}" already full or reload skipped`);
          break;
        }
        if (msg.includes("no ammo") || msg.includes("no_ammo") || msg.includes("empty")) {
          ctx.log("combat", `No ${weapon.ammoType} ammo available — need to resupply at station`);
          return false;
        }
        if (msg.includes("must specify") || msg.includes("missing")) {
          ctx.log("error", `Reload failed: ${resp.error.message} — weapon_instance_id: ${weapon.instanceId}, ammo_item_id: ${ammoItem.itemId}`);
          break;
        }
        ctx.log("combat", `Reload attempt ${i + 1} failed for "${weapon.name}": ${resp.error.message}`);
        continue;
      }

      ctx.log("combat", `✅ Reloaded "${weapon.name}" with ${ammoItem.itemId}`);
      anyReloaded = true;
      break;
    }
  }

  // Verify reload worked
  await bot.refreshStatus();
  const updatedWeapons = await getWeaponModules(ctx);
  let updatedTotalAmmo = 0;
  let updatedTotalMaxAmmo = 0;

  for (const weapon of updatedWeapons) {
    updatedTotalAmmo += weapon.currentAmmo;
    updatedTotalMaxAmmo += weapon.maxAmmo;
  }

  if (updatedTotalMaxAmmo > 0) {
    const updatedPct = (updatedTotalAmmo / updatedTotalMaxAmmo) * 100;
    ctx.log("combat", `Post-reload ammo: ${updatedTotalAmmo}/${updatedTotalMaxAmmo} (${updatedPct.toFixed(0)}%)`);
    return updatedTotalAmmo > 0 || anyReloaded;
  }

  return updatedTotalAmmo > 0 || anyReloaded;
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
            const threats = entities.filter(e => isPirateTarget(e, settings.onlyNPCs, settings.maxAttackTier));
            
            if (threats.length > 0) {
              ctx.log("combat", `🚨 Threat(s) detected: ${threats.map(t => t.name).join(", ")}`);
              // Engage the threats
              for (const threat of threats) {
                const won = await engageTarget(ctx, threat, settings.fleeThreshold, settings.fleeFromTier, settings.minPiratesToFlee, settings.maxAttackTier);
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

      // Brief pause to ensure travel fully processed (especially for jumps between systems)
      await sleep(1000);

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

        // CRITICAL: Check if we're already in battle before engaging
        // A pirate might have attacked us while we were doing other actions
        const existingBattle = await getBattleStatus(ctx);
        if (existingBattle) {
          ctx.log("combat", `⚠️ Already in battle (ID: ${existingBattle.battle_id}) before engaging ${target.name}`);
          ctx.log("combat", `Battle participants: ${existingBattle.participants.map(p => p.username || p.player_id).join(", ")}`);
          
          // Check if this battle is with our intended target
          const targetInBattle = existingBattle.participants.find(
            p => p.player_id === target.id || p.username === target.name
          );
          
          if (targetInBattle && !targetInBattle.is_destroyed) {
            ctx.log("combat", `Target ${target.name} is already in battle - joining fight`);
            // Skip engage and let engageTarget handle the existing battle
          } else {
            // We're in battle with someone else - analyze and handle
            ctx.log("combat", `In battle with other entities - analyzing...`);
          }
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
          ctx.log("combat", `Kill #${totalKills} — checking for new threats before looting...`);

          // CRITICAL: Check for new pirates before looting (safety first!)
          yield "safety_check";
          const safetyCheckResp = await bot.exec("get_nearby");
          if (!safetyCheckResp.error) {
            bot.trackNearbyPlayers(safetyCheckResp.result);
            const nearbyEntities = parseNearby(safetyCheckResp.result);
            const newThreats = nearbyEntities.filter(e => 
              isPirateTarget(e, settings.onlyNPCs, settings.maxAttackTier) &&
              e.id !== target.id &&
              e.name !== target.name
            );

            if (newThreats.length > 0) {
              ctx.log("combat", `🚨 ${newThreats.length} new pirate(s) detected: ${newThreats.map(t => t.name).join(", ")} — engaging instead of looting!`);
              // Fight the new threats first
              for (const newThreat of newThreats) {
                if (bot.state !== "running") break;
                
                const newWon = await engageTarget(ctx, newThreat, settings.fleeThreshold, settings.fleeFromTier, settings.minPiratesToFlee, settings.maxAttackTier);
                if (newWon) {
                  totalKills++;
                  patrolKills++;
                  ctx.log("combat", `Kill #${totalKills} (additional threat)`);
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






