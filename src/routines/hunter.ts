/**
 * Hunter routine — patrols a system hunting pirate NPCs for bounties and loot.
 *
 * Modes:
 *   - roam_systems: Navigate to configured patrol system, or find nearest huntable system
 *   - roam_system: Stay in current system and patrol POIs
 *   - stationary: Stay in one POI, wait for targets
 *   - patrol_systems: Cycle through a configured list of systems
 *   - cycle_patrols: Cycle through named patrol profiles
 *   - patrol_radius: Patrol all systems within X jumps of a pirate base system
 *
 * Loop:
 *   1. Navigate to configured patrol system
 *   2. Visit each non-station POI looking for pirate targets
 *   3. Scan -> engage -> loot each target
 *   4. Flee and dock if hull drops below flee threshold
 *   5. Post-patrol: complete missions, accept new missions,
 *      insure ship, refuel, repair
 *
 * Combat stances:
 *   - Fire   (default): 100% damage dealt — ALWAYS used
 *   - No Brace: Never blocks firing to recover shields (missile ships would use this)
 *   - No Retreat: Stay at engaged range, never move to inner/mid/outer (moving costs damage ticks)
 *   - Flee   (hull critical): auto-retreat — triggers when hull <= fleeThreshold
 *
 * Settings (data/settings.json under "hunter"):
 *   system          — system ID to patrol (default: current system)
 *   refuelThreshold — fuel % to trigger refuel stop (default: 40)
 *   repairThreshold — hull % to abort patrol and dock (default: 30)
 *   fleeThreshold   — hull % to flee an active fight (default: 20)
 *   shieldRechargePct — post-battle shield % to top up to with shield_charge items (default: 80)
  *   desiredShieldCharges — how many shield_charge the bot tries to keep stocked (default: 20)
  *   desiredRepairKits    — how many repair kits (advanced + regular) the bot tries to keep stocked (default: 12)
  *   desiredFuelCells     — how many fuel cells the bot tries to keep stocked (-1 = fill cargo, default: -1)
  *   Auto-uses repair kits (advanced_repair_kit preferred, then repair_kit) from cargo after fights when hull deficit > 100
 *   onlyNPCs        — only attack NPC pirates, never players (default: true)
 *   ammoReloadAbsoluteThreshold — ammo count to reload when weapon has ≤50 total ammo (default: 1)
 *   ammoReloadPercentThreshold — % of max ammo to reload when weapon has >50 total ammo (default: 25)
 *   pirateBaseSystem — system ID for patrol_radius mode (default: "" - currently configured base)
 *   patrolRadius    — max jumps from pirate base for patrol_radius mode (default: 5)
 *   cloakOnStart    — stay cloaked until attack command, then re-cloak after battle (default: false)
 *   meatShield      — enter/continue battles even with no weapons/ammo instead of aborting to resupply (default: false)
 *   stopOnDeath     — stop the routine on death instead of respawning into a new hunt (default: false)
 *   combatDebug     — log all raw battle JSON to data/logs/combat_debug/{botName}_combat_debug.log (default: false)
 *   targetRandomly  — shuffle target order each scan (default: false)
 */

import type { Routine, RoutineContext } from "../bot.js";
import { mapStore } from "../mapstore.js";
import { catalogStore } from "../catalogstore.js";
import { botChatChannel } from "../bot_chat_channel.js";
import { getSystemBlacklist } from "../web/server.js";
import { writeSettings, isCombatDebugEnabled } from "./common.js";
import { combatDebugLog } from "../debug.js";
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
  logStatus,
  getBattleStatus,
  type BattleState,
  handleBattleNotifications,
  fleeFromBattle,
  checkAndFleeFromBattle,
  checkBattleAfterCommand,
  getItemSize,
  topUpShields,
  useRepairKits,
} from "./common.js";

import type { Bot } from "../bot.js";
import type { PirateTier, NearbyEntity } from "./battle.js";
import {
  parseNearby,
  isPirateTarget,
  isCreatureTarget,
  isCreatureName,
  ensureAmmoLoaded,
  engageTarget,
  emergencyFleeSpam,
  analyzeExistingBattle,
  fightFreshBattle,
  fightJoinedBattle,
  getWeaponModules,
} from "./battle.js";



async function ensureObservationSubscribed(): Promise<void> {
      // Intentionally left empty - observation subscription replaced with polling
    }

async function resubscribeObservationAfterMove(bot: Bot): Promise<void> {
     bot.clearObservationState();
   }

function isStationEntity(e: NearbyEntity): boolean {
  return e.type.toLowerCase() === "station";
}

async function getObservationOrNearby(bot: Bot): Promise<{ result: unknown; isObservation: boolean }> {
     const resp = await bot.exec("get_nearby");
     return { result: resp.result, isObservation: false };
   }

function getObservationDebugLine(bot: Bot): string {
     return "observation: disabled (using polling)";
   }

const RAINBOW_LEVIATHAN_NAME = "Rainbow Leviathan";

function prioritizeRainbowLeviathan(creatures: NearbyEntity[]): NearbyEntity[] {
  if (!creatures.length) return creatures;
  const prioritized = creatures.filter(e => e.name === RAINBOW_LEVIATHAN_NAME);
  const rest = creatures.filter(e => e.name !== RAINBOW_LEVIATHAN_NAME);
  return [...prioritized, ...rest];
}

async function handleUnexpectedBattle(ctx: RoutineContext, maxAttackTier: PirateTier, minPiratesToFlee: number, fleeThreshold: number, fleeFromTier: PirateTier, repairThreshold: number = 0, onlyNPCs: boolean = false): Promise<void> {
  const battleStatus = await getBattleStatus(ctx);
  if (!battleStatus) return;

  ctx.log("combat", `⚠️ Unexpectedly in battle (ID: ${battleStatus.battle_id}) during scanning`);

  const analysis = await analyzeExistingBattle(ctx, maxAttackTier, minPiratesToFlee);
  if (!analysis.shouldJoin) {
    ctx.log("combat", `⏭️ Skipping unexpected battle: ${analysis.reason}`);
    return;
  }

  // Get hunter settings for shield recharge
  const hsettings = getHunterSettings(ctx.bot.username);
  const shieldRechargePct = (hsettings.shieldRechargePct ?? 80) / 100;

  if (analysis.reason.includes("Already in battle")) {
    ctx.log("combat", `Already participating on side ${analysis.sideId} — continuing fight`);
  } else {
    ctx.log("combat", `✅ Joining unexpected battle on side ${analysis.sideId}: ${analysis.reason}`);
    const engageResp = await ctx.bot.exec("battle", { action: "engage", side_id: analysis.sideId!.toString() });
    if (engageResp.error) {
      const errMsg = engageResp.error.message.toLowerCase();
      if (errMsg.includes("already in a battle") || errMsg.includes("already_in_battle")) {
        ctx.log("combat", `Already in battle — proceeding to fight`);
      } else {
        ctx.log("error", `Failed to join unexpected battle: ${engageResp.error.message}`);
        return;
      }
    }
  }

  // Pick a real target from battle participants so we get the full combat loop
  const enemy = battleStatus.participants.find(p => p.side_id !== analysis.sideId && !p.is_destroyed);
  const fakeTarget = enemy ? { id: enemy.player_id || enemy.username || "", name: enemy.username || enemy.player_id || "enemy" } as any : null;
  if (fakeTarget) {
    broadcastHunterAssist(ctx, fakeTarget, isCreatureName(fakeTarget.name));
  }
  await fightJoinedBattle(ctx, fakeTarget, fleeThreshold, fleeFromTier, maxAttackTier, repairThreshold, false, shieldRechargePct, hsettings.onlyNPCs);
}

async function checkAndHandleExistingBattle(ctx: RoutineContext, settings: ReturnType<typeof getHunterSettings>): Promise<boolean> {
  // Process any incoming hunter-assist requests from allies in our POI first.
  // (No-op if disabled, docked, already busy, or no pending requests.)
  await checkHunterCoordRequests(ctx, settings);

  // Check via API first to validate/clear stale WebSocket state
  let apiChecked = false;
  try {
    const battleStatus = await getBattleStatus(ctx);
    apiChecked = true;
    if (battleStatus) {
      ctx.log("combat", `⚠️ Battle detected via API (ID: ${battleStatus.battle_id}) - engaging instead of navigating`);
      await handleUnexpectedBattle(ctx, settings.maxAttackTier, settings.minPiratesToFlee, settings.fleeThreshold, settings.fleeFromTier, settings.repairThreshold, settings.onlyNPCs);
      return true;
    }
    // API returned no battle - clear stale WebSocket state if present
    if (ctx.bot.isInBattle()) {
      ctx.log("combat", `Clearing stale WebSocket battle state (API reports no battle)`);
      ctx.bot.currentBattle.inBattle = false;
      ctx.bot.currentBattle.battleId = null;
      ctx.bot.currentBattle.participants = [];
    }
  } catch (e) {
    // API check failed - rely on WebSocket state
    ctx.log("combat", `API battle check failed, relying on WebSocket state`);
  }
  
  // If API check succeeded and returned no battle, we're done
  if (apiChecked) return false;
  
  // API failed, check WebSocket state as fallback
  if (ctx.bot.isInBattle()) {
    ctx.log("combat", `⚠️ WebSocket battle state detected (ID: ${ctx.bot.currentBattle.battleId}) - engaging instead of navigating`);
    await handleUnexpectedBattle(ctx, settings.maxAttackTier, settings.minPiratesToFlee, settings.fleeThreshold, settings.fleeFromTier, settings.repairThreshold, settings.onlyNPCs);
    return true;
  }
  
  return false;
}

// ── Settings ─────────────────────────────────────────────────

export type HunterMode = "roam_systems" | "roam_system" | "stationary" | "patrol_systems" | "cycle_patrols" | "patrol_radius" | "station_protection" | "creature_farm";

/**
 * A Creature Farm "loadout". Each bot is assigned (per-bot) to one named loadout.
 * The loadout defines where the bot banks: a home base used to draw ammo and
 * deposit loot, plus the single target system it farms creatures in.
 *
 * Designed to be expanded later:
 *   - targetSystems: string[]  (farm multiple systems in one loadout)
 *   - targetPois:    string[]  (only farm specific POIs within the system)
 * For now a single target system + optional targetPois is supported.
 */
export interface CreatureFarmLoadout {
  name: string;
  homeSystem: string;
  homeStation: string;
  targetSystem: string;
  targetPois?: string[];
}

export type PatrolCycleMode = "random" | "sequential";

export interface HunterPatrolProfile {
  name: string;
  patrolSystems: string[];
}

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 9301 + 49297) % 233280;
    return state / 233280;
  };
}

function getHunterSettings(username?: string): {
  mode: HunterMode;
  patrolCycleMode: PatrolCycleMode;
  system: string;
  refuelThreshold: number;
  repairThreshold: number;
  fleeThreshold: number;
  shieldRechargePct: number;
  onlyNPCs: boolean;
  huntCreatures: boolean;
  coordinateHunts: boolean;
  autoCloak: boolean;
  cloakOnStart: boolean;
  ammoThreshold: number;
  ammoReloadAbsoluteThreshold: number;
  ammoReloadPercentThreshold: number;
  maxReloadAttempts: number;
  responseRange: number;
  maxAttackTier: PirateTier;
  fleeFromTier: PirateTier;
  minPiratesToFlee: number;
  disableScanCommandForPirates: boolean;
  disableWreckSalvaging: boolean;
  patrolSystems: string[];
  singleLoop: boolean;
  homeSystem: string;
  homeStation: string;
  desiredShieldCharges: number;
  desiredRepairKits: number;
  desiredFuelCells: number;
  desiredEmergencyWarpDevices: number;
  desiredAmmoBoxes: number;
  disableResupply: boolean;
  pirateBaseSystem: string;
  patrolRadius: number;
  meatShield: boolean;
  stopOnDeath: boolean;
  targetRandomly: boolean;
  combatDebug: boolean;
  maxCreaturesPerScan: number;
  creatureFarmLoadouts: CreatureFarmLoadout[];
  botCreatureFarmAssignments: Record<string, string>;
  creatureFarmAssignment: string;
  creatureFarmCargoFullPct: number;
  creatureFarmMaxPassesPerPoi: number;
  creatureFarmMaxSystemSweeps: number;
} {
  const all = readSettings();
  const h = all.hunter || {};
  const botOverrides = username ? (all[username] || {}) : {};

  // New multi-profile support (like crafter)
  const hunterPatrols: HunterPatrolProfile[] = Array.isArray(h.hunterPatrols) ? h.hunterPatrols : [];
  const botHunterPatrolAssignments: Record<string, string> = (h.botHunterPatrolAssignments as Record<string, string>) || {};

  let resolvedPatrolSystems: string[] = [];

  if (hunterPatrols.length > 0 && username) {
    const assignedProfileName = botHunterPatrolAssignments[username] || hunterPatrols[0]?.name || "Default Patrol";
    const assignedProfile = hunterPatrols.find(p => p.name === assignedProfileName) || hunterPatrols[0];
    resolvedPatrolSystems = assignedProfile?.patrolSystems || [];
  } else if (Array.isArray(h.patrolSystems)) {
    // Legacy single list
    resolvedPatrolSystems = h.patrolSystems;
  }

  // Creature Farm loadouts (named, per-bot assigned — same shape as hunterPatrols)
  const creatureFarmLoadouts: CreatureFarmLoadout[] = Array.isArray(h.creatureFarmLoadouts) ? h.creatureFarmLoadouts : [];
  const botCreatureFarmAssignments: Record<string, string> = (h.botCreatureFarmAssignments as Record<string, string>) || {};
  let resolvedCreatureFarmAssignment = "";
  if (creatureFarmLoadouts.length > 0 && username) {
    resolvedCreatureFarmAssignment = botCreatureFarmAssignments[username] || creatureFarmLoadouts[0]?.name || "";
  }

  return {
    mode: ((botOverrides.hunterMode as HunterMode) || (h.mode as HunterMode) || "roam_systems") as HunterMode,
    patrolCycleMode: ((botOverrides.patrolCycleMode as PatrolCycleMode) || (h.patrolCycleMode as PatrolCycleMode) || "sequential") as PatrolCycleMode,
    system: (botOverrides.system as string) || (h.system as string) || "",
    refuelThreshold: (h.refuelThreshold as number) || 40,
    repairThreshold: (h.repairThreshold as number) || 30,
    fleeThreshold: (h.fleeThreshold as number) || 20,
    shieldRechargePct: (h.shieldRechargePct as number) || 80,
onlyNPCs: (h.onlyNPCs as boolean) !== false,
  huntCreatures: (botOverrides.huntCreatures ?? h.huntCreatures) !== false,
  coordinateHunts: (h.coordinateHunts as boolean) !== false,
  autoCloak: (h.autoCloak as boolean) ?? false,
  cloakOnStart: (h.cloakOnStart as boolean) ?? false,
  ammoThreshold: (h.ammoThreshold as number) || 5,
    ammoReloadAbsoluteThreshold: (h.ammoReloadAbsoluteThreshold as number) || 1,
    ammoReloadPercentThreshold: (h.ammoReloadPercentThreshold as number) || 25,
    maxReloadAttempts: (h.maxReloadAttempts as number) || 3,
    responseRange: (h.responseRange as number) ?? 3,
    maxAttackTier: ((h.maxAttackTier as PirateTier) || "large") as PirateTier,
    fleeFromTier: ((h.fleeFromTier as PirateTier) || "boss") as PirateTier,
    minPiratesToFlee: (h.minPiratesToFlee as number) || 3,
    disableScanCommandForPirates: (h.disableScanCommandForPirates as boolean) ?? false,
    disableWreckSalvaging: (h.disableWreckSalvaging as boolean) ?? false,
    patrolSystems: resolvedPatrolSystems,
    singleLoop: (h.singleLoop as boolean) ?? false,
    homeSystem: (botOverrides.homeSystem as string) || (botOverrides.hunterHomeSystem as string) || (h.homeSystem as string) || (all.return_home?.homeSystem as string) || "",
    homeStation: (botOverrides.homeStation as string) || (botOverrides.hunterHomeStation as string) || (h.homeStation as string) || (all.return_home?.homeStation as string) || "",
    desiredShieldCharges: (h.desiredShieldCharges as number) ?? 20,
    desiredRepairKits: (h.desiredRepairKits as number) ?? 12,
    desiredFuelCells: (h.desiredFuelCells as number) ?? -1,
    desiredEmergencyWarpDevices: (h.desiredEmergencyWarpDevices as number) ?? 3,
    desiredAmmoBoxes: (h.desiredAmmoBoxes as number) ?? -1,
    disableResupply: (h.disableResupply as boolean) ?? false,
    pirateBaseSystem: (botOverrides.pirateBaseSystem as string) || (h.pirateBaseSystem as string) || "",
    patrolRadius: (botOverrides.patrolRadius as number) || (h.patrolRadius as number) || 5,
  meatShield: (h.meatShield as boolean) ?? false,
  stopOnDeath: (h.stopOnDeath as boolean) ?? false,
  targetRandomly: (h.targetRandomly as boolean) ?? false,
  combatDebug: (h.combatDebug as boolean) ?? false,
  maxCreaturesPerScan: (h.maxCreaturesPerScan as number) ?? 10,
  creatureFarmLoadouts,
  botCreatureFarmAssignments,
  creatureFarmAssignment: resolvedCreatureFarmAssignment,
  creatureFarmCargoFullPct: (h.creatureFarmCargoFullPct as number) ?? 95,
  creatureFarmMaxPassesPerPoi: (h.creatureFarmMaxPassesPerPoi as number) ?? 6,
  creatureFarmMaxSystemSweeps: (h.creatureFarmMaxSystemSweeps as number) ?? 40,
};
}

/** Persist hunter mode setting for a specific bot. */
export function setHunterMode(username: string, mode: HunterMode): void {
  writeSettings({
    [username]: { hunterMode: mode },
  });
}

/** Persist patrol systems list for a specific bot. */
export function setPatrolSystems(username: string, systems: string[]): void {
  writeSettings({
    [username]: { patrolSystems: systems },
  });
}

/** Persist patrol cycle mode (random or sequential) for a specific bot. */
export function setPatrolCycleMode(username: string, mode: PatrolCycleMode): void {
  writeSettings({
    [username]: { patrolCycleMode: mode },
  });
}

/** Persist patrol radius settings for a specific bot. */
export function setPatrolRadius(username: string, pirateBaseSystem: string, patrolRadius: number): void {
  writeSettings({
    [username]: { pirateBaseSystem, patrolRadius },
  });
}

/** Assign a bot to a named hunter patrol profile (new multi-bot system) */
export function assignBotToHunterPatrol(username: string, patrolProfileName: string): void {
  const all = readSettings();
  const h = (all.hunter || {}) as any;
  if (!h.botHunterPatrolAssignments) h.botHunterPatrolAssignments = {};
  h.botHunterPatrolAssignments[username] = patrolProfileName;
  writeSettings({ hunter: h });
}

/** Resolve the Creature Farm loadout assigned to a bot (falls back to first loadout). */
export function getCreatureFarmLoadout(username: string): CreatureFarmLoadout | null {
  const all = readSettings();
  const h = (all.hunter || {}) as any;
  const loadouts: CreatureFarmLoadout[] = Array.isArray(h.creatureFarmLoadouts) ? h.creatureFarmLoadouts : [];
  if (loadouts.length === 0) return null;
  const assignments: Record<string, string> = (h.botCreatureFarmAssignments as Record<string, string>) || {};
  const name = assignments[username] || loadouts[0].name;
  return loadouts.find(l => l.name === name) || loadouts[0] || null;
}

/** Assign a bot to a named Creature Farm loadout. */
export function assignBotToCreatureFarmLoadout(username: string, loadoutName: string): void {
  const all = readSettings();
  const h = (all.hunter || {}) as any;
  if (!Array.isArray(h.creatureFarmLoadouts)) h.creatureFarmLoadouts = [];
  if (!h.botCreatureFarmAssignments) h.botCreatureFarmAssignments = {};
  h.botCreatureFarmAssignments[username] = loadoutName;
  writeSettings({ hunter: h });
}

/** Returns true if the bot is low on field repair consumables and should return to resupply. */
function isLowOnFieldConsumables(inventory: any[] | undefined, minRepairKits = 5, minShieldCharges = 5): boolean {
  const repair = (inventory || [])
    .filter(i => (i.itemId || "").toLowerCase().includes("repair_kit"))
    .reduce((sum, i) => sum + (i.quantity || 0), 0);
  const shields = (inventory || [])
    .filter(i => (i.itemId || "").toLowerCase().includes("shield_charge"))
    .reduce((sum, i) => sum + (i.quantity || 0), 0);
  return repair < minRepairKits || shields < minShieldCharges;
}

async function handleNavigationBattleInterrupt(ctx: RoutineContext, settings: ReturnType<typeof getHunterSettings>): Promise<void> {
  // Check via API first to validate/clear stale WebSocket state
  let battleStatus: Awaited<ReturnType<typeof getBattleStatus>> = null;
  let apiChecked = false;
  
  try {
    battleStatus = await getBattleStatus(ctx);
    apiChecked = true;
    if (!battleStatus && ctx.bot.isInBattle()) {
      // API says no battle, but WebSocket says there is one - clear stale state
      ctx.log("combat", `Clearing stale WebSocket battle state (API reports no battle)`);
      ctx.bot.currentBattle.inBattle = false;
      ctx.bot.currentBattle.battleId = null;
      ctx.bot.currentBattle.participants = [];
      return;
    }
  } catch (e) {
    // API check failed - fall back to WebSocket state
    ctx.log("combat", `API battle check failed, relying on WebSocket state`);
  }
  
  // If API check succeeded and returned no battle, we're done
  if (apiChecked && !battleStatus) return;
  
  // API failed, check WebSocket state as fallback
  if (!battleStatus && ctx.bot.isInBattle()) {
    battleStatus = {
      battle_id: ctx.bot.currentBattle.battleId || "",
      participants: ctx.bot.currentBattle.participants as any,
      is_participant: true,
    } as any;
  }
  
  if (!battleStatus) return;

  ctx.log("combat", `⚠️ Navigation interrupted by battle (ID: ${battleStatus.battle_id}) - hunter fights, not flees!`);

  const analysis = await analyzeExistingBattle(ctx, settings.maxAttackTier, settings.minPiratesToFlee);
  if (!analysis.shouldJoin) {
    ctx.log("combat", `Skipping battle: ${analysis.reason}`);
    return;
  }

  if (analysis.sideId !== undefined) {
    ctx.log("combat", `Joining battle on side ${analysis.sideId} - FIGHTING!`);
    const engageResp = await ctx.bot.exec("battle", { action: "engage", side_id: analysis.sideId.toString() });
    if (engageResp.error) {
      const errMsg = engageResp.error.message.toLowerCase();
      if (errMsg.includes("already in a battle") || errMsg.includes("already_in_battle")) {
        ctx.log("combat", "Already in battle — proceeding to fight");
      } else {
        ctx.log("error", `Failed to join battle: ${engageResp.error.message}`);
        return;
      }
    }

const enemy = (battleStatus?.participants ?? []).find((p: any) => p.side_id !== analysis.sideId && !p.is_destroyed);
    const fakeTarget = enemy ? { id: enemy.player_id || enemy.username || "", name: enemy.username || enemy.player_id || "enemy" } as any : null;
    await fightJoinedBattle(ctx, fakeTarget, settings.fleeThreshold, settings.fleeFromTier, settings.maxAttackTier, settings.repairThreshold, false, settings.shieldRechargePct / 100, settings.onlyNPCs);
  }
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
      await bot.refreshLocation();
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
      const arrived = await navigateToSystem(ctx, safeSystem, { ...safetyOpts, skipBlacklist: true, joinBattles: true });
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
  await ensureHunterResupply(ctx);
  return true;
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

function findSystemsWithinRadius(fromSystemId: string, maxJumps: number): string[] {
  const normalizedFrom = fromSystemId.toLowerCase().replace(/_/g, ' ');
  let resolvedSystemId: string | null = null;
  
  if (mapStore.getSystem(fromSystemId)) {
    resolvedSystemId = fromSystemId;
  } else {
    for (const sysId of mapStore.getAllSystemIds()) {
      const sys = mapStore.getSystem(sysId);
      if (!sys) continue;
      const sysName = (sys.name || sysId).toLowerCase().replace(/_/g, ' ');
      const connNames = (sys.connections || []).map(c => 
        ((c.system_name || c.system_id) || "").toLowerCase().replace(/_/g, ' ')
      );
      if (sysName === normalizedFrom || connNames.includes(normalizedFrom)) {
        resolvedSystemId = sysId;
        break;
      }
    }
  }
  
  if (!resolvedSystemId) {
    return [];
  }
  
  const result: string[] = [];
  const visited = new Set<string>([resolvedSystemId]);
  const queue: Array<{ id: string; hops: number }> = [{ id: resolvedSystemId, hops: 0 }];
  
  while (queue.length > 0) {
    const current = queue.shift()!;
    result.push(current.id);
    
    if (current.hops >= maxJumps) continue;
    
    const conns = mapStore.getConnections(current.id);
    for (const conn of conns) {
      const nextId = conn.system_id;
      if (!nextId || visited.has(nextId)) continue;
      
      visited.add(nextId);
      queue.push({ id: nextId, hops: current.hops + 1 });
    }
  }
  
  return result;
}

// ── Ammo management ──────────────────────────────────────────

// ── Faction alert response ────────────────────────────────────

/** Cooldown per system so we don't divert repeatedly (5 minutes). */
const ALERT_RESPONSE_COOLDOWN_MS = 5 * 60 * 1000;
/** Ignore faction alerts older than this (seconds, if API returns Unix time). */
const ALERT_STALENESS_SECS = 5 * 60;

/** Map<systemId, lastRespondedTimestamp> — persists across loop iterations. */
const respondedAlerts = new Map<string, number>();

// ── Hunter-to-Hunter coordination (non-API bot chat channel) ──
//
// When a hunter engages a creature (or pirate) it broadcasts an "assist" message
// on the in-memory bot chat channel. Other hunters in the SAME POI pick it up and
// join the fight. This is how faction members get pulled into a creature battle
// they'd otherwise miss (the server does not auto-add same-POI allies).

interface HunterCoordRequest {
  sender: string;
  system: string;
  poi: string;
  targetName: string;
  targetId: string;
  creature: boolean;
  timestamp: number;
}

/** Per-bot pending coordination requests (drained by the routine loop). */
const coordRequests = new Map<string, HunterCoordRequest[]>();
/** Per-bot dedupe set of requests we've already acted on (key: targetId|sender). */
const coordHandled = new Map<string, Set<string>>();
/** Bots that already have a message handler registered. */
const coordListeners = new Set<string>();
/** True while we are engaging a target as a coordination *response* — suppresses
 *  our own broadcast so responders don't echo the assist request back. */
let coordResponding = false;

/**
 * Wrapper around engageTarget that broadcasts a hunter-assist request (so same-POI
 * allies can join) before fighting. Skips the broadcast when we are ourselves
 * responding to someone else's assist request, to avoid echo loops.
 */
async function hunterEngage(
  ctx: RoutineContext,
  target: { id: string; name: string; isCreature?: boolean },
  fleeThreshold: number,
  fleeFromTier: PirateTier,
  minPiratesToFlee: number,
  maxAttackTier: PirateTier,
  sideId?: number,
  skipScan: boolean = false,
  repairThreshold: number = 0,
  onlyNPCs: boolean = false,
  cloakOnStart: boolean = false,
): Promise<boolean> {
  if (!coordResponding) {
    broadcastHunterAssist(ctx, target, !!(target.isCreature) || isCreatureTarget(target as any, true));
  }
  const hsettings = getHunterSettings(ctx.bot.username);
  return engageTarget(ctx, target as any, fleeThreshold, fleeFromTier, minPiratesToFlee, maxAttackTier, sideId, skipScan, repairThreshold, onlyNPCs, cloakOnStart, hsettings.shieldRechargePct ?? 80);
}

/** Register the bot's coordination listener once. */
function ensureHunterCoordListener(username: string): void {
  if (coordListeners.has(username)) return;
  coordListeners.add(username);
  if (!coordRequests.has(username)) coordRequests.set(username, []);
  if (!coordHandled.has(username)) coordHandled.set(username, new Set());

  botChatChannel.onMessage(username, (msg) => {
    if (msg.channel !== "coordination") return;
    if (msg.sender === username) return;
    const meta = (msg.metadata || {}) as Record<string, unknown>;
    if (meta.type !== "hunter_assist") return;
    const system = (meta.system as string) || "";
    const poi = (meta.poi as string) || "";
    if (!system || !poi) return;
    const req: HunterCoordRequest = {
      sender: msg.sender,
      system,
      poi,
      targetName: (meta.targetName as string) || "",
      targetId: (meta.targetId as string) || "",
      creature: !!(meta.creature),
      timestamp: msg.timestamp,
    };
    coordRequests.get(username)!.push(req);
  });
}

/** Broadcast that we're engaging a target so same-POI allies can join in. */
function broadcastHunterAssist(ctx: RoutineContext, target: { id: string; name: string }, creature: boolean): void {
  const { bot } = ctx;
  if (!bot.system || !bot.poi) return;
  const settings = getHunterSettings(bot.username);
  if (!settings.coordinateHunts) return;
  botChatChannel.send({
    sender: bot.username,
    recipients: [],
    channel: "coordination",
    content: `[HUNTER ASSIST] ${bot.username} engaging ${target.name} (${creature ? "creature" : "pirate"}) at ${bot.system}/${bot.poi}`,
    metadata: {
      type: "hunter_assist",
      system: bot.system,
      poi: bot.poi,
      targetName: target.name,
      targetId: target.id,
      creature,
    },
  });
}

/**
 * After a failed engagement, check if we actually retreated from a live battle
 * (need to abort the patrol) or if the target just vanished / became untargetable
 * (should skip it and keep patrolling).
 */
async function shouldAbortPatrolAfterEngage(ctx: RoutineContext, won: boolean, targetName: string): Promise<boolean> {
  if (won) return false;
  const inBattle = await getBattleStatus(ctx);
  if (inBattle) {
    ctx.log("combat", "Retreated — aborting patrol to dock and repair");
    return true;
  }
  ctx.log("combat", `${targetName} unavailable — skipping and continuing patrol`);
  return false;
}

/**
 * Drain pending coordination requests and join any battle for a target that is in
 * our current POI. Called from the routine's scan / battle-check cadence so the
 * actual fighting happens inside the generator (never from the event handler).
 */
async function checkHunterCoordRequests(ctx: RoutineContext, settings: ReturnType<typeof getHunterSettings>): Promise<void> {
  const { bot } = ctx;
  if (!settings.coordinateHunts) return;
  if (bot.docked) return;

  const queue = coordRequests.get(bot.username);
  if (!queue || queue.length === 0) return;
  const handled = coordHandled.get(bot.username)!;

  const pending = queue.splice(0, queue.length);
  for (const req of pending) {
    if (bot.state !== "running") break;
    const key = `${req.targetId}|${req.sender}`;
    if (req.sender === bot.username || handled.has(key)) continue;

    // Only respond to requests from our exact POI.
    if (req.system !== bot.system || req.poi !== bot.poi) {
      // Drop stale cross-POI requests so the queue doesn't grow forever.
      if (Date.now() - req.timestamp > 5 * 60 * 1000) handled.add(key);
      continue;
    }

    // Already fighting something? Don't pile into a second battle.
    const existing = await getBattleStatus(ctx);
    if (existing) {
      handled.add(key);
      continue;
    }

    // Health / supply gate before committing to an assist.
    await bot.refreshShip();
    const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    if (hullPct <= settings.repairThreshold) {
      handled.add(key);
continue;
     }

     await ensureObservationSubscribed();
     const nearbyResult = await getObservationOrNearby(bot);
     const nearbyData = nearbyResult.result;
    if (!nearbyData) {
      ctx.log("error", `No observation/nearby data available for assist matching`);
      handled.add(key);
      continue;
    }
    bot.trackNearbyPlayers(nearbyData);
    bot.trackWildlife(nearbyData);

    const entities = parseNearby(nearbyData);
    const match = entities.find(e =>
      (req.targetId && e.id === req.targetId) ||
      (req.targetName && e.name === req.targetName) ||
      (req.targetName && e.name.toLowerCase().includes(req.targetName.toLowerCase()))
    );
    if (!match) {
      // Target not visible here anymore — mark handled to avoid re-polling forever.
      handled.add(key);
      continue;
    }

    const valid = req.creature
      ? isCreatureTarget(match, true)
      : isPirateTarget(match, settings.onlyNPCs, settings.maxAttackTier);
    if (!valid) {
      handled.add(key);
      continue;
    }

    handled.add(key);
    ctx.log("combat", `🤝 Hunter coordination: ${req.sender} requested assist vs ${req.targetName} — joining battle at ${req.poi}!`);
    coordResponding = true;
    try {
      await hunterEngage(ctx, match, settings.fleeThreshold, settings.fleeFromTier, settings.minPiratesToFlee, settings.maxAttackTier, undefined, settings.disableScanCommandForPirates, settings.repairThreshold, settings.cloakOnStart);
    } finally {
      coordResponding = false;
    }
  }
}

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

// ── Death handling ───────────────────────────────────────────
//
// Result of a death check at the top of a routine loop iteration:
//   "ok"   — bot is alive, routine should continue
//   "wait" — bot is dead but still recovering/unavailable; loop should sleep + continue
//   "stop" — stopOnDeath is enabled; routine should return (stop) immediately
type DeathHandleResult = "ok" | "wait" | "stop";

/**
 * Hunter death handling.
 *
 * By default the routine recovers from death (claim insurance, respawn, re-dock/
 * repair) and keeps hunting from wherever it respawns. When `settings.stopOnDeath`
 * is enabled we instead STOP the routine entirely — the ship stays where it
 * respawned and the bot does not immediately start hunting from a random point.
 */
async function handleDeath(
  ctx: RoutineContext,
  settings: ReturnType<typeof getHunterSettings>,
): Promise<DeathHandleResult> {
  const { bot } = ctx;
  await bot.refreshShip();
  const dead = bot.hull <= 0 || bot.isDead;
  if (!dead) return "ok";

  if (settings.stopOnDeath) {
    ctx.log(
      "system",
      "💀 Death detected and stopOnDeath is enabled — stopping hunter routine instead of respawning into a hunt.",
    );
    ctx.bot.stop();
    return "stop";
  }

  const alive = await detectAndRecoverFromDeath(ctx);
  if (!alive) {
    await ctx.sleep(30000);
    return "wait";
  }
  return "ok";
}

// Helper function to format observation updates in a human-readable way
function formatObservationUpdate(payload: any): string {
  const parts = [];

  // Handle nearby_changed (players who arrived or had updates)
  if (payload.nearby_changed && Array.isArray(payload.nearby_changed) && payload.nearby_changed.length > 0) {
    const changes = payload.nearby_changed.map((p: any) => {
      const username = p.username || p.player_id || 'unknown';
      const faction = p.faction_tag || p.faction_id || '';
      const shipClass = p.ship_class || '';
      const shipName = p.ship_name || '';
      const inCombat = p.in_combat ? ' [IN COMBAT]' : '';
      const status = p.status_message || '';
      
      let result = `${username}`;
      if (faction) result += ` [${faction}]`;
      if (shipClass) result += ` ${shipClass}`;
      if (shipName) result += ` "${shipName}"`;
      result += inCombat;
      if (status) result += `: ${status}`;
      return result;
    });
    parts.push(`+${changes.join(', ')}`);
  }

  // Handle nearby_departed (players who left)
  if (payload.nearby_departed && Array.isArray(payload.nearby_departed) && payload.nearby_departed.length > 0) {
    const departed = payload.nearby_departed.map((id: string) => id);
    parts.push(`-${departed.join(', ')}`);
  }

  // Handle system_changed (players who changed systems)
  if (payload.system_changed && Array.isArray(payload.system_changed) && payload.system_changed.length > 0) {
    const changes = payload.system_changed.map((p: any) => {
      const username = p.username || p.player_id || 'unknown';
      const faction = p.faction_tag || p.faction_id || '';
      const shipClass = p.ship_class || '';
      const shipName = p.ship_name || '';
      const inCombat = p.in_combat ? ' [IN COMBAT]' : '';
      const status = p.status_message || '';
      
      let result = `${username}`;
      if (faction) result += ` [${faction}]`;
      if (shipClass) result += ` ${shipClass}`;
      if (shipName) result += ` "${shipName}"`;
      result += inCombat;
      if (status) result += `: ${status}`;
      return result;
    });
    parts.push(`~${changes.join(', ')}`); // Using ~ to indicate system change
  }

  // Handle unknown signature
  if (payload.unknown_signature === true) {
    parts.push('(unknown signature present)');
  }

  return parts.length > 0 ? parts.join(' | ') : '(no changes)';
}

// ── Hunter routine ───────────────────────────────────────────

export const hunterRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  // Check per-bot mode
  const initialSettings = getHunterSettings(bot.username);

// Observation setup removed: using polling instead of subscription

  try {
    // Register the bot chat channel listener so allied hunters can pull us into
    // creature/pirate battles happening in our POI.
    ensureHunterCoordListener(bot.username);

    // Cloak on start if cloakOnStart is enabled.
    // Cloaking requires being UNDOCKED, so if we're docked we undock first, activate
    // the cloak, then immediately re-dock so the start-of-routine resupply (which can
    // only run while docked) still works. This prevents the ship from getting stuck
    // undocked with a stale `docked` flag, which made every withdraw fail with not_docked.
    const wasDockedAtStart = bot.docked;
    if (initialSettings.mode !== "station_protection" && initialSettings.cloakOnStart && !bot.isCloaked) {
      // Undock first if currently docked — the cloak command cannot enable while docked.
      if (bot.docked) {
        const undockResp = await bot.exec("undock");
        if (!undockResp.error) {
          bot.docked = false;
        } else {
          ctx.log("warn", `Failed to undock for cloak: ${undockResp.error.message}`);
        }
      }

      const cloakResp = await bot.exec("cloak", { enable: true });
      if (!cloakResp.error) {
        ctx.log("system", "Cloak enabled on routine start (cloakOnStart)");

        // Re-dock so we remain at the station for the start-of-routine resupply.
        if (wasDockedAtStart) {
          const redockResp = await bot.exec("dock");
          if (!redockResp.error || (redockResp.error?.message || "").toLowerCase().includes("already")) {
            bot.docked = true;
          } else {
            ctx.log("warn", `Failed to re-dock after cloak (continuing undocked): ${redockResp.error.message}`);
          }
        }
      } else {
        const msg = cloakResp.error.message.toLowerCase();
        if (!msg.includes("already cloaked") && !msg.includes("already_cloaked")) {
          ctx.log("warn", `Failed to cloak on start: ${cloakResp.error.message}`);
        }
      }
    }

    // If we started the routine while docked at home base, refuel, repair, then restock
    if (bot.docked) {
      await repairShip(ctx);
      await tryRefuel(ctx, { skipApprovedCheck: true });
      await ensureHunterResupply(ctx);
      if (initialSettings.mode !== "station_protection") {
        await ensureUndocked(ctx);
      }
      await ensureAmmoLoaded(ctx, initialSettings.ammoThreshold, initialSettings.maxReloadAttempts, initialSettings.ammoReloadAbsoluteThreshold, initialSettings.ammoReloadPercentThreshold);
    }

    // Field repair using cargo kits on routine start (in case started with battle damage and not docked)
    if (initialSettings.mode !== "station_protection") {
      await useRepairKits(ctx);
    }

    if (initialSettings.mode === "roam_system") {
      yield* roamSystemRoutine(ctx);
      return;
    }
    if (initialSettings.mode === "stationary") {
      yield* stationaryRoutine(ctx);
      return;
    }
    if (initialSettings.mode === "patrol_systems") {
      yield* patrolSystemsRoutine(ctx);
      return;
    }
    if (initialSettings.mode === "cycle_patrols") {
      yield* cyclePatrolsRoutine(ctx);
      return;
    }
    if (initialSettings.mode === "patrol_radius") {
      yield* patrolRadiusRoutine(ctx);
      return;
    }
    if (initialSettings.mode === "station_protection") {
      yield* stationProtectionRoutine(ctx);
      return;
    }

    if (initialSettings.mode === "creature_farm") {
      yield* creatureFarmRoutine(ctx);
      return;
    }

    // Default to roam_systems
    yield* roamSystemsRoutine(ctx);
} finally {
     // Clean up observation subscription (replaced with polling)
   }
};

// ── Creature Farm Routine ───────────────────────────────────────
//
// Creature-SPECIFIC hunter sub-routine. Differences from the pirate-focused
// roam modes:
//   * It does NOT treat a POI as "empty" after engaging a single creature. It
//     repeatedly re-scans the same POI (up to `maxPassesPerPoi` passes) to mop
//     up respawns, then moves on. The goal is to clear as many creatures as
//     possible for their loot (used to make food).
//   * It farms until the cargo is full (or field consumables / ammo run low),
//     then returns to the loadout's home base to deposit loot and restock ammo.
//   * It is driven by a per-bot "loadout" (named profile) so many bots in one
//     client can each farm a different system while sharing the same home base.

/** Navigate to the loadout's home base, deposit loot, and restock ammo/shields/repair. */
async function returnToCreatureFarmHome(
  ctx: RoutineContext,
  settings: ReturnType<typeof getHunterSettings>,
  homeSystem: string,
  homeStation: string,
): Promise<void> {
  const { bot } = ctx;
  const safetyOpts = {
    fuelThresholdPct: settings.refuelThreshold,
    hullThresholdPct: settings.repairThreshold,
    autoCloak: settings.autoCloak,
    skipBlacklist: true,
    isCombatBot: true,
    joinBattles: true,
  };

  ctx.log("system", `Returning to home base ${homeStation || homeSystem || "(default)"} — depositing loot + restocking ammo...`);
  try {
    if (homeSystem && bot.system !== homeSystem) {
      await ensureUndocked(ctx);
      const arrived = await navigateToSystem(ctx, homeSystem, safetyOpts);
      if (!arrived) {
        ctx.log("warn", `Could not navigate to home system ${homeSystem} — docking wherever possible`);
      }
    }

    let docked = false;
    if (homeStation && homeStation.includes("|")) {
      const parts = homeStation.split("|");
      const poi = parts[1] || parts[0];
      docked = await ensureDocked(ctx, true, 0, poi ? { targetStationId: poi } : undefined);
    } else if (homeStation) {
      docked = await ensureDocked(ctx, true, 0, { targetStationId: homeStation });
    } else {
      docked = await ensureDocked(ctx);
    }

    if (!docked) {
      ctx.log("error", "Could not dock at home base — loot not deposited");
      return;
    }

    // ensureHunterResupply deposits non-protected loot to (faction) storage and
    // withdraws ammo / repair kits / shield charges / fuel cells from storage.
    await ensureHunterResupply(ctx);
    await collectFromStorage(ctx);
    await ensureAmmoLoaded(ctx, settings.ammoThreshold, settings.maxReloadAttempts, settings.ammoReloadAbsoluteThreshold, settings.ammoReloadPercentThreshold);
    await ensureInsured(ctx);
    await bot.checkSkills();
    await ensureUndocked(ctx);
    ctx.log("info", "Resupplied at home base — heading back to creature farm");
  } catch (e) {
    ctx.log("error", `Error returning to home base: ${e}`);
  }
}

async function* creatureFarmRoutine(ctx: RoutineContext): AsyncGenerator<string, void, void> {
  const { bot } = ctx;

  await ensureHunterCoordListener(bot.username);

  await bot.refreshLocation();
  let totalKills = 0;

  while (bot.state === "running") {
    const settings = getHunterSettings(bot.username);
    const loadout = getCreatureFarmLoadout(bot.username);
    if (!loadout || !loadout.targetSystem) {
      ctx.log("error", "creature_farm mode but no Creature Farm loadout assigned (set hunter.creatureFarmLoadouts + hunter.botCreatureFarmAssignments). Waiting 60s...");
      await ctx.sleep(60000);
      continue;
    }

    const homeSystem = loadout.homeSystem || settings.homeSystem || "";
    const homeStation = loadout.homeStation || settings.homeStation || "";
    const targetSystem = loadout.targetSystem;
    const cargoFullPct = (settings.creatureFarmCargoFullPct > 0 ? settings.creatureFarmCargoFullPct : 95) / 100;
    const maxPasses = settings.creatureFarmMaxPassesPerPoi > 0 ? settings.creatureFarmMaxPassesPerPoi : 6;
    const maxSweeps = settings.creatureFarmMaxSystemSweeps > 0 ? settings.creatureFarmMaxSystemSweeps : 40;

    const safetyOpts = {
      fuelThresholdPct: settings.refuelThreshold,
      hullThresholdPct: settings.repairThreshold,
      autoCloak: settings.autoCloak,
      skipBlacklist: true,
      isCombatBot: true,
      joinBattles: true,
    };

    // ── Death recovery ──
    const death = await handleDeath(ctx, settings);
    if (death === "stop") return;
    if (death === "wait") continue;

    // ── Status ──
    yield "get_status";
    await bot.refreshLocation();
    logStatus(ctx);

    // ── Fuel ──
    const fueled = await ensureFueled(ctx, settings.refuelThreshold, { homeSystem, skipBlacklist: true, skipFleeCheck: true });
    if (!fueled) {
      ctx.log("error", "Cannot secure fuel — waiting 30s...");
      await ctx.sleep(30000);
      continue;
    }

    // ── Hull ──
    await bot.refreshShip();
    const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    if (hullPct <= settings.repairThreshold) {
      ctx.log("system", `Hull at ${hullPct}% — returning home to repair`);
      await returnToCreatureFarmHome(ctx, settings, homeSystem, homeStation);
      continue;
    }

    // ── Cargo full? ──
    await bot.refreshCargo();
    const cargoPct0 = bot.cargoMax > 0 ? bot.cargo / bot.cargoMax : 0;
    if (cargoPct0 >= cargoFullPct) {
      ctx.log("system", `Cargo ${Math.round(cargoPct0 * 100)}% — returning home to deposit loot + restock ammo`);
      await returnToCreatureFarmHome(ctx, settings, homeSystem, homeStation);
      continue;
    }

    // ── Ammo ──
    const hasAmmo = await ensureAmmoLoaded(ctx, settings.ammoThreshold, settings.maxReloadAttempts, settings.ammoReloadAbsoluteThreshold, settings.ammoReloadPercentThreshold);
    if (!hasAmmo && !settings.meatShield) {
      ctx.log("combat", "Out of ammo — returning home to restock");
      await returnToCreatureFarmHome(ctx, settings, homeSystem, homeStation);
      continue;
    }

    // ── Field consumables ──
    if (isLowOnFieldConsumables(bot.inventory)) {
      ctx.log("combat", "Low on repair kits / shield charges — returning home to resupply");
      await returnToCreatureFarmHome(ctx, settings, homeSystem, homeStation);
      continue;
    }

    // ── Navigate to target system ──
    if (bot.system !== targetSystem) {
      ctx.log("travel", `Creature farm: heading to target system ${targetSystem}...`);
      const arrived = await navigateToSystem(ctx, targetSystem, safetyOpts);
      if (!arrived) {
        const battleAfterNav = await getBattleStatus(ctx);
        if (battleAfterNav) {
          await handleNavigationBattleInterrupt(ctx, settings);
        } else {
          ctx.log("error", `Could not reach ${targetSystem} — retrying next cycle`);
          await ctx.sleep(5000);
        }
        continue;
      }
      await resubscribeObservationAfterMove(bot);
    }

    // ── Farm: sweep the system repeatedly until cargo full (creatures respawn) ──
    let sweeps = 0;
    let cargoFull = false;
    while (bot.state === "running" && sweeps < maxSweeps && !cargoFull) {
      sweeps++;
      yield "scan_system";
      const { pois } = await getSystemInfo(ctx);
      let patrolPois = pois.filter(p => !isStationPoi(p));
      if (loadout.targetPois && loadout.targetPois.length > 0) {
        patrolPois = patrolPois.filter(p => loadout.targetPois!.includes(p.id) || loadout.targetPois!.includes(p.name));
      }
      if (patrolPois.length === 0) {
        ctx.log("info", "No non-station POIs in target system — waiting 30s");
        await ctx.sleep(30000);
        break;
      }

      ctx.log("info", `Creature farm sweep ${sweeps}/${maxSweeps} — ${patrolPois.length} POI(s) in ${targetSystem}`);
      let sweepKills = 0;

      for (const poi of patrolPois) {
        if (bot.state !== "running") break;

        // Mid-loop safety checks
        await bot.refreshShip();
        const midHull = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
        if (midHull <= settings.repairThreshold) {
          ctx.log("system", "Hull low — aborting sweep to return home");
          break;
        }
        await bot.refreshCargo();
        const midCargo = bot.cargoMax > 0 ? bot.cargo / bot.cargoMax : 0;
        if (midCargo >= cargoFullPct) { cargoFull = true; break; }
        const midAmmo = await ensureAmmoLoaded(ctx, settings.ammoThreshold, settings.maxReloadAttempts, settings.ammoReloadAbsoluteThreshold, settings.ammoReloadPercentThreshold);
        if (!midAmmo && !settings.meatShield) {
          ctx.log("combat", "Out of ammo mid-farm — aborting sweep to home");
          break;
        }

        if (await checkAndHandleExistingBattle(ctx, settings)) {
          // Got pulled into a battle — re-evaluate next iteration
        }

        // Travel to POI
        yield "travel_to_poi";
        ctx.log("travel", `Farming ${poi.name}...`);
        const travelResp = await bot.exec("travel", { target_poi: poi.id });
        if (travelResp.error && !travelResp.error.message.includes("already")) {
          ctx.log("error", `Travel to ${poi.name} failed: ${travelResp.error.message}`);
          continue;
        }
        bot.poi = poi.id;
        bot.clearObservationState();
        await ctx.sleep(1000);

        // Repeatedly scan + engage ALL creatures here to mop up respawns.
        let passes = 0;
        while (bot.state === "running" && passes < maxPasses && !cargoFull) {
          passes++;
          yield "scan_for_targets";
          const obsResult = await getObservationOrNearby(bot);
          const nearbyData = obsResult.result;
          if (!nearbyData) {
            ctx.log("error", `No nearby data at ${poi.name}`);
            break;
          }
          bot.trackNearbyPlayers(nearbyData);
          bot.trackWildlife(nearbyData);

          await handleUnexpectedBattle(ctx, settings.maxAttackTier, settings.minPiratesToFlee, settings.fleeThreshold, settings.fleeFromTier, settings.repairThreshold);

          const entities = parseNearby(nearbyData);
          const creatures = prioritizeRainbowLeviathan(
            entities.filter(e => isCreatureTarget(e, true) && !isStationEntity(e)),
          );

          if (creatures.length === 0) {
            // POI currently clear — stop re-scanning this POI for now
            break;
          }

          ctx.log("combat", `Found ${creatures.length} creature(s) at ${poi.name} (pass ${passes}/${maxPasses})`);

          for (const target of creatures) {
            if (bot.state !== "running") break;

            await bot.refreshShip();
            const preHull = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
            if (preHull <= settings.repairThreshold) break;

            await useRepairKits(ctx);
            const ammo = await ensureAmmoLoaded(ctx, settings.ammoThreshold, settings.maxReloadAttempts, settings.ammoReloadAbsoluteThreshold, settings.ammoReloadPercentThreshold);
            if (!ammo && !settings.meatShield) {
              ctx.log("combat", "Out of ammo mid-farm — aborting");
              break;
            }

            yield "engage";
            const won = await hunterEngage(ctx, target, settings.fleeThreshold, settings.fleeFromTier, settings.minPiratesToFlee, settings.maxAttackTier, undefined, settings.disableScanCommandForPirates, settings.repairThreshold, settings.cloakOnStart);
            if (won) {
              totalKills++;
              sweepKills++;
              ctx.log("combat", `Kill #${totalKills} (${target.name}) — looting before next...`);
              if (!settings.disableWreckSalvaging) await scavengeWrecks(ctx);
              const cset = getHunterSettings(bot.username);
              await topUpShields(ctx, (cset.shieldRechargePct ?? 80) / 100);
              await useRepairKits(ctx);
              await bot.refreshCargo();
              if (isLowOnFieldConsumables(bot.inventory)) {
                ctx.log("combat", "Low on consumables — ending sweep to resupply");
                break;
              }
              const cp = bot.cargoMax > 0 ? bot.cargo / bot.cargoMax : 0;
              if (cp >= cargoFullPct) { cargoFull = true; break; }
            }
          }
          if (cargoFull) break;
          // Re-scan shortly to catch respawns before moving on
          await ctx.sleep(1500);
        }
        if (cargoFull) break;
      }

      // After a full sweep, loop again to catch respawns across the system
      await bot.refreshCargo();
      const afterCargo = bot.cargoMax > 0 ? bot.cargo / bot.cargoMax : 0;
      if (afterCargo >= cargoFullPct) break; // top of loop routes home
      if (sweepKills === 0) {
        ctx.log("info", "Sweep found no creatures — waiting for respawns...");
        await ctx.sleep(10000);
      }
    }

    if (cargoFull) {
      await bot.refreshCargo();
      const cp = bot.cargoMax > 0 ? bot.cargo / bot.cargoMax : 0;
      ctx.log("system", `Cargo full (${Math.round(cp * 100)}%) — returning home to deposit loot + restock ammo`);
      await returnToCreatureFarmHome(ctx, settings, homeSystem, homeStation);
    }
  }
}

// ── Roam Systems Routine (original behavior) ────────────────────

async function* roamSystemsRoutine(ctx: RoutineContext): AsyncGenerator<string, void, void> {
  const { bot } = ctx;

  await bot.refreshStatus();
  let totalKills = 0;

  while (bot.state === "running") {
    // ── Death recovery ──
    const settings = getHunterSettings(bot.username);
    const death = await handleDeath(ctx, settings);
    if (death === "stop") return;
    if (death === "wait") continue;

    const safetyOpts = {
      fuelThresholdPct: settings.refuelThreshold,
      hullThresholdPct: settings.repairThreshold,
      autoCloak: settings.autoCloak,
      skipBlacklist: true,
      isCombatBot: true,
      joinBattles: true,
    };
    const patrolSystem = settings.system || "";

    // ── Status ──
    yield "get_status";
    await bot.refreshLocation();
    logStatus(ctx);

    // ── Position update for visual display ──
    yield "get_system";
    await bot.exec("get_system");
    yield "get_poi";
    if (bot.poi) await bot.exec("get_poi", { poi_id: bot.poi });

// ── Fuel check ──
    yield "fuel_check";
    const fueled = await ensureFueled(ctx, settings.refuelThreshold, { homeSystem: settings.homeSystem, skipBlacklist: true, skipFleeCheck: true });
    if (!fueled) {
      ctx.log("error", "Cannot secure fuel — waiting 30s...");
      await ctx.sleep(30000);
      continue;
    }

// ── Hull check — retreat to a high-security system to repair ──
     await bot.refreshShip();
     const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
     if (hullPct <= settings.repairThreshold) {
       ctx.log("system", `Hull at ${hullPct}% — retreating to high-security system for repairs`);
       yield "emergency_repair";
       const docked = await navigateToSafeStation(ctx, safetyOpts);
       if (docked) {
         await completeActiveMissions(ctx);
         await repairShip(ctx);
         await tryRefuel(ctx, { skipApprovedCheck: true });
         await checkAndAcceptMissions(ctx);
         await ensureInsured(ctx);
         await bot.checkSkills();
         await ensureUndocked(ctx);
         await resubscribeObservationAfterMove(bot);
       }
       continue;
     }

    // ── Faction alert check — divert if an ally is nearby and under attack ──
    yield "faction_alert_check";
    const alertTarget = await checkFactionAlerts(ctx, settings.responseRange);
    if (alertTarget) {
      // CRITICAL: Check for existing battle before navigating
      if (await checkAndHandleExistingBattle(ctx, settings)) {
        continue;
      }
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
       if (arrived) {
         await resubscribeObservationAfterMove(bot);
       } else {
         // Check if battle interrupted navigation
         const battleAfterNav = await getBattleStatus(ctx);
         if (battleAfterNav) {
           ctx.log("combat", `Battle detected after navigation attempt - hunter fights, not flees!`);
           await handleNavigationBattleInterrupt(ctx, settings);
         } else {
           ctx.log("error", `Could not reach ${alertTarget} — resuming normal patrol`);
         }
       }
    }

    // ── Navigate to a huntable (low/unregulated) system ──
    yield "find_patrol_system";

    // CRITICAL: Check for existing battle before navigating
    if (await checkAndHandleExistingBattle(ctx, settings)) {
      continue;
    }

    if (patrolSystem && bot.system !== patrolSystem) {
      ctx.log("travel", `Navigating to configured patrol system ${patrolSystem}...`);
      const arrived = await navigateToSystem(ctx, patrolSystem, safetyOpts);
      if (arrived) {
        await resubscribeObservationAfterMove(bot);
      }
      if (!arrived) {
        const battleAfterNav = await getBattleStatus(ctx);
        if (battleAfterNav) {
          ctx.log("combat", `Battle detected after navigation - hunter fights, not flees!`);
          await handleNavigationBattleInterrupt(ctx, settings);
        } else {
          ctx.log("error", `Could not reach ${patrolSystem} — patrolling ${bot.system} instead`);
        }
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
            const huntArrived = await navigateToSystem(ctx, huntTarget, safetyOpts);
            if (huntArrived) {
              await resubscribeObservationAfterMove(bot);
            }
            if (!huntArrived) {
              const battleAfterNav = await getBattleStatus(ctx);
              if (battleAfterNav) {
                ctx.log("combat", `Battle detected after navigation - hunter fights, not flees!`);
                await handleNavigationBattleInterrupt(ctx, settings);
              }
            }
          } else {
            const conns = mapStore.getConnections(bot.system);
            const unmapped = conns.find(c => !mapStore.getSystem(c.system_id)?.security_level);
            const target = unmapped ?? conns[0];
            if (target) {
              ctx.log("travel", `No huntable system mapped yet — scouting ${target.system_name || target.system_id}...`);
              const scoutArrived = await navigateToSystem(ctx, target.system_id, safetyOpts);
              if (scoutArrived) {
                await resubscribeObservationAfterMove(bot);
              }
              if (!scoutArrived) {
                const battleAfterNav = await getBattleStatus(ctx);
                if (battleAfterNav) {
                  ctx.log("combat", `Battle detected after navigation - hunter fights, not flees!`);
                  await handleNavigationBattleInterrupt(ctx, settings);
                }
              }
              await getSystemInfo(ctx);
              await fetchSecurityLevel(ctx, bot.system);
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
        await tryRefuel(ctx, { skipApprovedCheck: true });
        await ensureUndocked(ctx);
      }
      continue;
    }

    ctx.log("info", `Patrolling ${patrolPois.length} POI(s) in ${bot.system}...`);

    await ensureObservationSubscribed();

    // ── Patrol loop — visit each non-station POI ──
    let patrolKills = 0;
    let abortPatrol = false;

    for (const poi of patrolPois) {
      if (bot.state !== "running" || abortPatrol) break;

      await bot.refreshShip();
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

      // CRITICAL: Check for existing battle before traveling to POI
      if (await checkAndHandleExistingBattle(ctx, settings)) {
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
         const nearbyResult = await getObservationOrNearby(bot);
         const nearbyData = nearbyResult.result;
         if (nearbyData) {
           bot.trackNearbyPlayers(nearbyData);
           bot.trackWildlife(nearbyData);
            const entities = parseNearby(nearbyData);
              const nonStationThreats = entities.filter(e => isPirateTarget(e, settings.onlyNPCs, settings.maxAttackTier) && !isStationEntity(e));
              const stationThreats = entities.filter(e => isPirateTarget(e, settings.onlyNPCs, settings.maxAttackTier) && isStationEntity(e));
              const threats = [...nonStationThreats, ...stationThreats];
              
              if (threats.length > 0) {
               ctx.log("combat", `🚨 Threat(s) detected: ${threats.map(t => t.name).join(", ")}`);
               // Engage the threats
                for (const threat of threats) {
                  const won = await hunterEngage(ctx, threat, settings.fleeThreshold, settings.fleeFromTier, settings.minPiratesToFlee, settings.maxAttackTier, undefined, settings.disableScanCommandForPirates, settings.repairThreshold, settings.cloakOnStart);
                  if (await shouldAbortPatrolAfterEngage(ctx, won, threat.name)) {
                    abortPatrol = true;
                    break;
                  }
                }
               if (abortPatrol) break;
             }
           }
           // top up after engaging threats that interrupted travel
           const tsettings = getHunterSettings(bot.username);
           await topUpShields(ctx, (tsettings.shieldRechargePct ?? 80) / 100);
           await useRepairKits(ctx);
         }
         continue;
       }
       bot.poi = poi.id;
// Clear observation state to clear stale data from previous location
        bot.clearObservationState();
        // observationCache.delete(bot); // removed

        // Brief pause to ensure travel fully processed (especially for jumps between systems)
        await ctx.sleep(1000);

      // Scan for targets
      yield "scan_for_targets";
      await ensureObservationSubscribed();
      const nearbyResult = await getObservationOrNearby(bot);
      const nearbyData = nearbyResult.result;
      const isObservation = nearbyResult.isObservation;

      if (!nearbyData) {
        ctx.log("error", `No observation/nearby data at ${poi.name}`);
        continue;
      }

      if (isObservation) {
        ctx.log("debug", `obs: ${getObservationDebugLine(bot)}`);
      }

      // Track player names and wildlife from observation or nearby scan
      bot.trackNearbyPlayers(nearbyData);
      bot.trackWildlife(nearbyData);

      // Check if we got pulled into battle during scanning
      await handleUnexpectedBattle(ctx, settings.maxAttackTier, settings.minPiratesToFlee, settings.fleeThreshold, settings.fleeFromTier, settings.repairThreshold);

      // Immediate reaction to pirate scan notification (NPC only, not player scans)
      if ((nearbyData as any).notifications) {
        const notifs = Array.isArray((nearbyData as any).notifications) ? (nearbyData as any).notifications : [];
        for (const n of notifs) {
          const msg = (n as any)?.data?.message || (n as any)?.message || "";
          if (msg.includes("You were scanned by") && msg.includes("[COMBAT]")) {
            ctx.log("combat", "Pirate scan detected - immediate get_nearby + engage");
            const scanNearby = await bot.exec("get_nearby");
            if (!scanNearby.error) {
              bot.trackNearbyPlayers(scanNearby.result);
              bot.trackWildlife(scanNearby.result);
              const scanEntities = parseNearby(scanNearby.result);
              const scanTargets = [...scanEntities.filter(e => isPirateTarget(e, settings.onlyNPCs, settings.maxAttackTier)), ...scanEntities.filter(e => isCreatureTarget(e, settings.huntCreatures))];
              for (const t of scanTargets) {
                await hunterEngage(ctx, t, settings.fleeThreshold, settings.fleeFromTier, settings.minPiratesToFlee, settings.maxAttackTier, undefined, settings.disableScanCommandForPirates, settings.repairThreshold, settings.cloakOnStart);
              }
              // top up shields after immediate scan-target engagements (no per-target post-battle block)
              const ssettings = getHunterSettings(bot.username);
              await topUpShields(ctx, (ssettings.shieldRechargePct ?? 80) / 100);
              await useRepairKits(ctx);
            }
            break;
          }
        }
      }

      const entities = parseNearby(nearbyData);
      ctx.log("info", `entities: ${entities}`);
      const pirate_targets = entities.filter(e => isPirateTarget(e, settings.onlyNPCs, settings.maxAttackTier));
      const creature_targets = prioritizeRainbowLeviathan(entities.filter(e => isCreatureTarget(e, settings.huntCreatures)).slice(0, settings.maxCreaturesPerScan));

      if (pirate_targets.length === 0 && creature_targets.length === 0) {
        ctx.log("combat", `No targets at ${poi.name}`);
        if (!settings.disableWreckSalvaging) await scavengeWrecks(ctx);
        continue;
      }

      const allTargets = [...pirate_targets, ...creature_targets];
      ctx.log("combat", `Found ${pirate_targets.length} pirate(s), ${creature_targets.length} creature(s) at ${poi.name}`);

      const nonStationTargets = allTargets.filter(e => !isStationEntity(e));
      const stationTargets = allTargets.filter(e => isStationEntity(e));

      let targetsToEngage: NearbyEntity[];
      if (settings.targetRandomly) {
        const shuffledNonStation = [...nonStationTargets];
        for (let i = shuffledNonStation.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffledNonStation[i], shuffledNonStation[j]] = [shuffledNonStation[j], shuffledNonStation[i]];
        }
        const shuffledStation = [...stationTargets];
        for (let i = shuffledStation.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffledStation[i], shuffledStation[j]] = [shuffledStation[j], shuffledStation[i]];
        }
        targetsToEngage = [...shuffledNonStation, ...shuffledStation];
      } else {
        targetsToEngage = [...nonStationTargets, ...stationTargets];
      }

      if (targetsToEngage.length === 0) {
        ctx.log("combat", `No targets at ${poi.name}`);
        if (!settings.disableWreckSalvaging) await scavengeWrecks(ctx);
        continue;
      }

      // Engage each target
      for (const target of targetsToEngage) {
        if (bot.state !== "running") break;

        await bot.refreshShip();
        const preHull = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
        if (preHull <= settings.repairThreshold) {
          ctx.log("system", `Hull at ${preHull}% — too low for another fight`);
          abortPatrol = true;
          break;
        }

        await useRepairKits(ctx); // use cargo kits if hull deficit >100 before engaging

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
        const hasAmmo = await ensureAmmoLoaded(ctx, settings.ammoThreshold, settings.maxReloadAttempts, settings.ammoReloadAbsoluteThreshold, settings.ammoReloadPercentThreshold);
        if (!hasAmmo && !settings.meatShield) {
          ctx.log("combat", "Out of ammo — aborting patrol to resupply");
          abortPatrol = true;
          break;
        }
        if (!hasAmmo) {
          ctx.log("combat", "Meat-shield mode — no ammo but entering battle anyway");
        }

        yield "engage";
        const won = await hunterEngage(ctx, target, settings.fleeThreshold, settings.fleeFromTier, settings.minPiratesToFlee, settings.maxAttackTier, undefined, settings.disableScanCommandForPirates, settings.repairThreshold, settings.cloakOnStart);

        if (await shouldAbortPatrolAfterEngage(ctx, won, target.name)) {
          abortPatrol = true;
          break;
        }
        if (won) {
          totalKills++;
          patrolKills++;
          ctx.log("combat", `Kill #${totalKills} — checking for new threats before looting...`);

          // CRITICAL: Check for new pirates before looting (safety first!)
          yield "safety_check";
          const safetyCheckResp = await bot.exec("get_nearby");
          if (!safetyCheckResp.error) {
            bot.trackNearbyPlayers(safetyCheckResp.result);
            bot.trackWildlife(safetyCheckResp.result);
            const nearbyEntities = parseNearby(safetyCheckResp.result);
             const newThreats = nearbyEntities.filter(e => 
               isPirateTarget(e, settings.onlyNPCs, settings.maxAttackTier) &&
               !isStationEntity(e) &&
               e.id !== target.id &&
               e.name !== target.name
             );

            if (newThreats.length > 0) {
              ctx.log("combat", `🚨 ${newThreats.length} new pirate(s) detected: ${newThreats.map(t => t.name).join(", ")} — engaging instead of looting!`);
              // Fight the new threats first
              for (const newThreat of newThreats) {
                if (bot.state !== "running") break;
                
                const newWon = await hunterEngage(ctx, newThreat, settings.fleeThreshold, settings.fleeFromTier, settings.minPiratesToFlee, settings.maxAttackTier, undefined, settings.disableScanCommandForPirates, settings.repairThreshold, settings.cloakOnStart);
                if (await shouldAbortPatrolAfterEngage(ctx, newWon, newThreat.name)) {
                  abortPatrol = true;
                  break;
                }
                if (newWon) {
                  totalKills++;
                  patrolKills++;
                  ctx.log("combat", `Kill #${totalKills} (additional threat)`);
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
          const hasAmmo = await ensureAmmoLoaded(ctx, settings.ammoThreshold, settings.maxReloadAttempts, settings.ammoReloadAbsoluteThreshold, settings.ammoReloadPercentThreshold);
          if (!hasAmmo) {
            ctx.log("combat", "No ammo after kill — aborting patrol to resupply");
            abortPatrol = true;
          }

          await topUpShields(ctx, (settings.shieldRechargePct ?? 80) / 100);
          await useRepairKits(ctx);
          await bot.refreshCargo();
          if (isLowOnFieldConsumables(bot.inventory)) {
            ctx.log("combat", "Low on repair kits or shield charges — aborting patrol to resupply");
            abortPatrol = true;
          }
          await bot.refreshShip();
          ctx.log("combat", `Post-fight: hull ${bot.hull}/${bot.maxHull} | ammo ${bot.ammo} | credits ${bot.credits}`);
        }
      }
    }

    // ── Post-patrol decision ──
    yield "post_patrol";
    await bot.refreshCargo();
    await bot.refreshShip();
    const postHull = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    const postFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;

    // Only return home for repairs when hull is actually low
    const needsRepair = postHull <= settings.repairThreshold;

    // Only return home for fuel when we have ZERO fuel cells of any type in cargo
    const hasFuelCells = bot.inventory?.some(i =>
      i.itemId === 'fuel_cell' ||
      i.itemId === 'premium_fuel_cell' ||
      i.itemId === 'military_fuel_cell'
    );
    const needsFuel = !hasFuelCells;

    if (needsRepair || needsFuel) {
      const reason = needsRepair ? `hull ${postHull}%` : `fuel ${postFuel}%`;
      ctx.log("system", `Patrol sweep done — ${patrolKills} kill(s). Returning to safe system (${reason})...`);

      // When needsFuel is true, go directly to home base for full resupply
      if (needsFuel && settings.homeSystem) {
        ctx.log("system", "Returning to home base for full resupply...");
        await navigateToSystem(ctx, settings.homeSystem, safetyOpts);
        const hs = settings.homeStation || "";
        const [hsys, hpoi] = hs.includes("|") ? hs.split("|") : ["", ""];
        if (hsys && hpoi) {
          await bot.exec("travel", { target_poi: hpoi });
          await bot.exec("dock");
          bot.docked = true;
        } else {
          await ensureDocked(ctx);
        }
        await ensureHunterResupply(ctx);

        yield "complete_missions";
        await completeActiveMissions(ctx);

        await bot.refreshLocation();

        yield "check_missions";
        await checkAndAcceptMissions(ctx);

        yield "ensure_insured";
        await ensureInsured(ctx);

        yield "refuel";
        await tryRefuel(ctx, { skipApprovedCheck: true });

        yield "repair";
        await repairShip(ctx);

        yield "reload";
        await ensureAmmoLoaded(ctx, settings.ammoThreshold, settings.maxReloadAttempts, settings.ammoReloadAbsoluteThreshold, settings.ammoReloadPercentThreshold);

        yield "fit_mods";
        const modProfile = getModProfile("hunter");
        if (modProfile.length > 0) await ensureModsFitted(ctx, modProfile);

        yield "check_skills";
        await bot.checkSkills();

        ctx.log("info", `=== Patrol complete. Total kills: ${totalKills} | Credits: ${bot.credits} ===`);
      } else {
        yield "dock";
        const docked = await navigateToSafeStation(ctx, safetyOpts);
        if (!docked) {
          ctx.log("error", "Could not dock anywhere — retrying next cycle");
          continue;
        }

        await collectFromStorage(ctx);

        yield "complete_missions";
        await completeActiveMissions(ctx);

        await bot.refreshLocation();

        yield "check_missions";
        await checkAndAcceptMissions(ctx);

        yield "ensure_insured";
        await ensureInsured(ctx);

        yield "refuel";
        await tryRefuel(ctx, { skipApprovedCheck: true });

        yield "repair";
        await repairShip(ctx);

        yield "reload";
        await ensureAmmoLoaded(ctx, settings.ammoThreshold, settings.maxReloadAttempts, settings.ammoReloadAbsoluteThreshold, settings.ammoReloadPercentThreshold);

        yield "fit_mods";
        const modProfile = getModProfile("hunter");
        if (modProfile.length > 0) await ensureModsFitted(ctx, modProfile);

        yield "check_skills";
        await bot.checkSkills();

        ctx.log("info", `=== Patrol complete. Total kills: ${totalKills} | Credits: ${bot.credits} ===`);

        if (settings.singleLoop) {
          ctx.log("system", "Single loop mode — returning to faction home base for resupply...");
          const hs = settings.homeStation || "";
          const [hsys, hpoi] = hs.includes("|") ? hs.split("|") : ["", ""];
          if (hsys && hpoi) {
            await navigateToSystem(ctx, hsys, safetyOpts);
            const t = await bot.exec("travel", { target_poi: hpoi });
            if (!t.error) { bot.poi = hpoi; await bot.exec("dock"); bot.docked = true; }
          } else {
            await navigateToSafeStation(ctx, safetyOpts);
          }
          await ensureHunterResupply(ctx);
        }
      }

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
}

// ── Roam System Routine (stay in current system) ────────────────

async function* roamSystemRoutine(ctx: RoutineContext): AsyncGenerator<string, void, void> {
  const { bot } = ctx;

  await bot.refreshLocation();
  let totalKills = 0;

  while (bot.state === "running") {
    // ── Death recovery ──
    const settings = getHunterSettings(bot.username);
    const death = await handleDeath(ctx, settings);
    if (death === "stop") return;
    if (death === "wait") continue;

    const safetyOpts = {
      fuelThresholdPct: settings.refuelThreshold,
      hullThresholdPct: settings.repairThreshold,
      autoCloak: settings.autoCloak,
      skipBlacklist: true,
      isCombatBot: true,
    };

    // ── Status ──
    yield "get_status";
    await bot.refreshLocation();
    logStatus(ctx);

    // ── Position update for visual display ──
    yield "get_system";
    await bot.exec("get_system");
    yield "get_poi";
    if (bot.poi) await bot.exec("get_poi", { poi_id: bot.poi });

// ── Fuel check ──
    yield "fuel_check";
    const fueled = await ensureFueled(ctx, settings.refuelThreshold, { homeSystem: settings.homeSystem, skipBlacklist: true, skipFleeCheck: true });
    if (!fueled) {
      ctx.log("error", "Cannot secure fuel — waiting 30s...");
      await ctx.sleep(30000);
      continue;
    }

// ── Hull check — retreat to a high-security system to repair ──
     await bot.refreshShip();
     const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
     if (hullPct <= settings.repairThreshold) {
       ctx.log("system", `Hull at ${hullPct}% — retreating to high-security system for repairs`);
       yield "emergency_repair";
       const docked = await navigateToSafeStation(ctx, safetyOpts);
       if (docked) {
         await completeActiveMissions(ctx);
         await repairShip(ctx);
         await tryRefuel(ctx, { skipApprovedCheck: true });
         await checkAndAcceptMissions(ctx);
         await ensureInsured(ctx);
         await bot.checkSkills();
         await ensureUndocked(ctx);
         await resubscribeObservationAfterMove(bot);
       }
       continue;
     }
 
     // ── Faction alert check — divert if an ally is nearby and under attack ──
     yield "faction_alert_check";
     const alertTarget = await checkFactionAlerts(ctx, settings.responseRange);
     if (alertTarget && alertTarget === bot.system) {
       ctx.log("combat", `Faction alert! Responding in current system`);
       // Since we're already in the system, proceed to patrol
     } else if (alertTarget) {
       // If alert is in another system, we can't respond since we're in roam_system mode
       ctx.log("info", `Faction alert in ${alertTarget} — ignoring (roam_system mode)`);
     }

    // ── Confirm we're actually in a huntable system ──
    await fetchSecurityLevel(ctx, bot.system);
    const confirmedSec = mapStore.getSystem(bot.system)?.security_level;
    if (!isHuntableSystem(confirmedSec)) {
      ctx.log("info", `${bot.system} is ${confirmedSec || "unknown"} security — no pirates here. Waiting for pirates to appear...`);
      await ctx.sleep(5000);
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
        await tryRefuel(ctx, { skipApprovedCheck: true });
        await ensureUndocked(ctx);
      }
      continue;
    }

    ctx.log("info", `Patrolling ${patrolPois.length} POI(s) in ${bot.system}...`);

    await ensureObservationSubscribed();

    // ── Patrol loop — visit each non-station POI ──
    let patrolKills = 0;
    let abortPatrol = false;

    for (const poi of patrolPois) {
      if (bot.state !== "running" || abortPatrol) break;

      await bot.refreshShip();
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

      // CRITICAL: Check for existing battle before traveling to POI
      if (await checkAndHandleExistingBattle(ctx, settings)) {
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
// Clear observation state to clear stale data from previous location
        bot.clearObservationState();
//        observationCache.delete(bot); // removed

// Brief pause to ensure travel fully processed
        await ctx.sleep(1000);

      // Scan for targets
      yield "scan_for_targets";
      await ensureObservationSubscribed();
      const obsResult = await getObservationOrNearby(bot);
      const nearbyData = obsResult.result;
      const isObservation = obsResult.isObservation;

      if (!nearbyData) {
        ctx.log("error", `No observation/nearby data at ${poi.name}`);
        continue;
      }

      if (isObservation) {
        ctx.log("debug", `obs: ${getObservationDebugLine(bot)}`);
      }

      // Track player names and wildlife from observation or nearby scan
      bot.trackNearbyPlayers(nearbyData);
      bot.trackWildlife(nearbyData);

      // Check if we got pulled into battle during scanning
      await handleUnexpectedBattle(ctx, settings.maxAttackTier, settings.minPiratesToFlee, settings.fleeThreshold, settings.fleeFromTier, settings.repairThreshold);

      // Immediate reaction to pirate scan notification (NPC only, not player scans)
      if ((nearbyData as any).notifications) {
        const notifs = Array.isArray((nearbyData as any).notifications) ? (nearbyData as any).notifications : [];
        for (const n of notifs) {
          const msg = (n as any)?.data?.message || (n as any)?.message || "";
          if (msg.includes("You were scanned by") && msg.includes("[COMBAT]")) {
            ctx.log("combat", "Pirate scan detected - immediate get_nearby + engage");
            const scanNearby = await bot.exec("get_nearby");
            if (!scanNearby.error) {
              bot.trackNearbyPlayers(scanNearby.result);
              bot.trackWildlife(scanNearby.result);
              const scanEntities = parseNearby(scanNearby.result);
              const scanTargets = [...scanEntities.filter(e => isPirateTarget(e, settings.onlyNPCs, settings.maxAttackTier)), ...scanEntities.filter(e => isCreatureTarget(e, settings.huntCreatures))];
              for (const t of scanTargets) {
                await hunterEngage(ctx, t, settings.fleeThreshold, settings.fleeFromTier, settings.minPiratesToFlee, settings.maxAttackTier, undefined, settings.disableScanCommandForPirates, settings.repairThreshold, settings.cloakOnStart);
              }
              // top up shields after immediate scan-target engagements (no per-target post-battle block)
              const ssettings = getHunterSettings(bot.username);
              await topUpShields(ctx, (ssettings.shieldRechargePct ?? 80) / 100);
              await useRepairKits(ctx);
            }
            break;
          }
        }
      }

      const entities = parseNearby(nearbyData);
      ctx.log("info", `entities: ${entities}`);
      const pirate_targets = entities.filter(e => isPirateTarget(e, settings.onlyNPCs, settings.maxAttackTier));
      const creature_targets = prioritizeRainbowLeviathan(entities.filter(e => isCreatureTarget(e, settings.huntCreatures)).slice(0, settings.maxCreaturesPerScan));

      if (pirate_targets.length === 0 && creature_targets.length === 0) {
        ctx.log("combat", `No targets at ${poi.name}`);
        if (!settings.disableWreckSalvaging) await scavengeWrecks(ctx);
        continue;
      }

      const allTargets = [...pirate_targets, ...creature_targets];
      ctx.log("combat", `Found ${pirate_targets.length} pirate(s), ${creature_targets.length} creature(s) at ${poi.name}`);

      const nonStationTargets = allTargets.filter(e => !isStationEntity(e));
      const stationTargets = allTargets.filter(e => isStationEntity(e));

      let targetsToEngage: NearbyEntity[];
      if (settings.targetRandomly) {
        const shuffledNonStation = [...nonStationTargets];
        for (let i = shuffledNonStation.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffledNonStation[i], shuffledNonStation[j]] = [shuffledNonStation[j], shuffledNonStation[i]];
        }
        const shuffledStation = [...stationTargets];
        for (let i = shuffledStation.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffledStation[i], shuffledStation[j]] = [shuffledStation[j], shuffledStation[i]];
        }
        targetsToEngage = [...shuffledNonStation, ...shuffledStation];
      } else {
        targetsToEngage = [...nonStationTargets, ...stationTargets];
      }

      if (targetsToEngage.length === 0) {
        ctx.log("combat", `No targets at ${poi.name}`);
        if (!settings.disableWreckSalvaging) await scavengeWrecks(ctx);
        continue;
      }

      // Engage each target
      for (const target of targetsToEngage) {
        if (bot.state !== "running") break;

        await bot.refreshShip();
        const preHull = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
        if (preHull <= settings.repairThreshold) {
          ctx.log("system", `Hull at ${preHull}% — too low for another fight`);
          abortPatrol = true;
          break;
        }

        await useRepairKits(ctx); // use cargo kits if hull deficit >100 before engaging

        // Pre-fight ammo check
        const hasAmmo = await ensureAmmoLoaded(ctx, settings.ammoThreshold, settings.maxReloadAttempts, settings.ammoReloadAbsoluteThreshold, settings.ammoReloadPercentThreshold);
        if (!hasAmmo && !settings.meatShield) {
          ctx.log("combat", "Out of ammo — aborting patrol to resupply");
          abortPatrol = true;
          break;
        }
        if (!hasAmmo) {
          ctx.log("combat", "Meat-shield mode — no ammo but entering battle anyway");
        }

        yield "engage";
        const won = await hunterEngage(ctx, target, settings.fleeThreshold, settings.fleeFromTier, settings.minPiratesToFlee, settings.maxAttackTier, undefined, settings.disableScanCommandForPirates, settings.repairThreshold, settings.cloakOnStart);

        if (await shouldAbortPatrolAfterEngage(ctx, won, target.name)) {
          abortPatrol = true;
          break;
        }
        if (won) {
          totalKills++;
          patrolKills++;
          ctx.log("combat", `Kill #${totalKills} — checking for new threats before looting...`);

          // Safety check for new threats
          yield "safety_check";
          const safetyCheckResp = await bot.exec("get_nearby");
          if (!safetyCheckResp.error) {
            bot.trackNearbyPlayers(safetyCheckResp.result);
            bot.trackWildlife(safetyCheckResp.result);
            const nearbyEntities = parseNearby(safetyCheckResp.result);
            const newThreats = nearbyEntities.filter(e =>
              isPirateTarget(e, settings.onlyNPCs, settings.maxAttackTier) &&
              !isStationEntity(e) &&
              e.id !== target.id &&
              e.name !== target.name
            );

            if (newThreats.length > 0) {
              ctx.log("combat", `🚨 ${newThreats.length} new pirate(s) detected: ${newThreats.map(t => t.name).join(", ")} — engaging instead of looting!`);
              for (const newThreat of newThreats) {
                if (bot.state !== "running") break;

                const newWon = await hunterEngage(ctx, newThreat, settings.fleeThreshold, settings.fleeFromTier, settings.minPiratesToFlee, settings.maxAttackTier, undefined, settings.disableScanCommandForPirates, settings.repairThreshold, settings.cloakOnStart);
                if (await shouldAbortPatrolAfterEngage(ctx, newWon, newThreat.name)) {
                  abortPatrol = true;
                  break;
                }
                if (newWon) {
                  totalKills++;
                  patrolKills++;
                  ctx.log("combat", `Kill #${totalKills} (additional threat)`);
                }
              }

              if (abortPatrol) break;
              ctx.log("combat", "Area clear — now looting wrecks...");
            } else {
              ctx.log("combat", "Area clear — no new threats detected");
            }
          }

          if (!settings.disableWreckSalvaging) {
            yield "loot";
            await scavengeWrecks(ctx);
          }

          // Post-kill reload
          const hasAmmo = await ensureAmmoLoaded(ctx, settings.ammoThreshold, settings.maxReloadAttempts, settings.ammoReloadAbsoluteThreshold, settings.ammoReloadPercentThreshold);
          if (!hasAmmo) {
            ctx.log("combat", "No ammo after kill — aborting patrol to resupply");
            abortPatrol = true;
          }

          await topUpShields(ctx, (settings.shieldRechargePct ?? 80) / 100);
          await useRepairKits(ctx);
          await bot.refreshCargo();
          if (isLowOnFieldConsumables(bot.inventory)) {
            ctx.log("combat", "Low on repair kits or shield charges — aborting patrol to resupply");
            abortPatrol = true;
          }
          await bot.refreshShip();
          ctx.log("combat", `Post-fight: hull ${bot.hull}/${bot.maxHull} | ammo ${bot.ammo} | credits ${bot.credits}`);
        }
      }
    }

    // ── Post-patrol decision ──
    yield "post_patrol";
    await bot.refreshCargo();
    await bot.refreshShip();
    const postHull = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    const postFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;

    // Only return home for repairs when hull is actually low
    const needsRepair = postHull <= settings.repairThreshold;

    // Only return home for fuel when we have ZERO fuel cells of any type in cargo
    const hasFuelCells = bot.inventory?.some(i =>
      i.itemId === 'fuel_cell' ||
      i.itemId === 'premium_fuel_cell' ||
      i.itemId === 'military_fuel_cell'
    );
    const needsFuel = !hasFuelCells;

    if (needsRepair || needsFuel) {
      const reason = needsRepair ? `hull ${postHull}%` : `fuel ${postFuel}%`;
      ctx.log("system", `Patrol sweep done — ${patrolKills} kill(s). Returning to safe system (${reason})...`);

      // When needsFuel is true, go directly to home base for full resupply
      if (needsFuel && settings.homeSystem) {
        ctx.log("system", "Returning to home base for full resupply...");
        await navigateToSystem(ctx, settings.homeSystem, safetyOpts);
        const hs = settings.homeStation || "";
        const [hsys, hpoi] = hs.includes("|") ? hs.split("|") : ["", ""];
        if (hsys && hpoi) {
          await bot.exec("travel", { target_poi: hpoi });
          await bot.exec("dock");
          bot.docked = true;
        } else {
          await ensureDocked(ctx);
        }
        await ensureHunterResupply(ctx);

        yield "complete_missions";
        await completeActiveMissions(ctx);

        await bot.refreshLocation();

        yield "check_missions";
        await checkAndAcceptMissions(ctx);

        yield "ensure_insured";
        await ensureInsured(ctx);

        yield "refuel";
        await tryRefuel(ctx, { skipApprovedCheck: true });

        yield "repair";
        await repairShip(ctx);

        yield "reload";
        await ensureAmmoLoaded(ctx, settings.ammoThreshold, settings.maxReloadAttempts, settings.ammoReloadAbsoluteThreshold, settings.ammoReloadPercentThreshold);

        yield "fit_mods";
        const modProfile = getModProfile("hunter");
        if (modProfile.length > 0) await ensureModsFitted(ctx, modProfile);

        yield "check_skills";
        await bot.checkSkills();

        ctx.log("info", `=== Patrol complete. Total kills: ${totalKills} | Credits: ${bot.credits} ===`);
      } else {
        yield "dock";
        const docked = await navigateToSafeStation(ctx, safetyOpts);
        if (!docked) {
          ctx.log("error", "Could not dock anywhere — retrying next cycle");
          continue;
        }

        await collectFromStorage(ctx);

        yield "complete_missions";
        await completeActiveMissions(ctx);

        await bot.refreshLocation();

        yield "check_missions";
        await checkAndAcceptMissions(ctx);

        yield "ensure_insured";
        await ensureInsured(ctx);

        yield "refuel";
        await tryRefuel(ctx, { skipApprovedCheck: true });

        yield "repair";
        await repairShip(ctx);

        yield "reload";
        await ensureAmmoLoaded(ctx, settings.ammoThreshold, settings.maxReloadAttempts, settings.ammoReloadAbsoluteThreshold, settings.ammoReloadPercentThreshold);

        yield "fit_mods";
        const modProfile = getModProfile("hunter");
        if (modProfile.length > 0) await ensureModsFitted(ctx, modProfile);

        yield "check_skills";
        await bot.checkSkills();

        ctx.log("info", `=== Patrol complete. Total kills: ${totalKills} | Credits: ${bot.credits} ===`);
      }

    } else {
      ctx.log("system", `Patrol sweep done — ${patrolKills} kill(s). Hull: ${postHull}% | Fuel: ${postFuel}% — continuing hunt in system...`);
      // In roam_system mode, we just continue the loop without moving to another system
    }
  }
}

// ── Stationary Routine (stay in one POI) ────────────────────────

async function* stationaryRoutine(ctx: RoutineContext): AsyncGenerator<string, void, void> {
  const { bot } = ctx;

  await bot.refreshLocation();
  let totalKills = 0;

  // Store the original position to stay in
  const originalSystem = bot.system;
  const originalPoi = bot.poi;

  if (!originalPoi) {
    ctx.log("error", "No current POI set — cannot operate in stationary mode");
    return;
  }

  ctx.log("info", `Stationary mode: staying in ${originalPoi} (${originalSystem})`);

  while (bot.state === "running") {
    // ── Death recovery ──
    const settings = getHunterSettings(bot.username);
    const death = await handleDeath(ctx, settings);
    if (death === "stop") return;
    if (death === "wait") continue;

    const safetyOpts = {
      fuelThresholdPct: settings.refuelThreshold,
      hullThresholdPct: settings.repairThreshold,
      autoCloak: settings.autoCloak,
      skipBlacklist: true,
      isCombatBot: true,
    };

    // ── Status ──
    yield "get_status";
    await bot.refreshLocation();
    logStatus(ctx);

    // ── Position update for visual display ──
    yield "get_system";
    await bot.exec("get_system");
    yield "get_poi";
    if (bot.poi) await bot.exec("get_poi", { poi_id: bot.poi });

    // ── Battle check — defend the station if under attack ──
    const battleStatus = await getBattleStatus(ctx);
    if (battleStatus && battleStatus.is_participant) {
      ctx.log("combat", `⚠️ Station under attack (ID: ${battleStatus.battle_id}) — defending as hunter!`);
      await stationProtectionFight(ctx, settings);
      ctx.log("info", "Station defense complete — returning to protection post.");
      if (bot.system !== originalSystem) {
        ctx.log("travel", `Returning to stationary system ${originalSystem}...`);
        const arrived = await navigateToSystem(ctx, originalSystem, safetyOpts);
        if (!arrived) {
          ctx.log("error", `Could not return to ${originalSystem} — staying in ${bot.system}`);
        }
      }
      if (bot.poi !== originalPoi) {
        ctx.log("travel", `Returning to stationary POI ${originalPoi}...`);
        const travelResp = await bot.exec("travel", { target_poi: originalPoi });
        if (travelResp.error && !travelResp.error.message.includes("already")) {
          ctx.log("error", `Failed to return to POI ${originalPoi}: ${travelResp.error.message}`);
        } else {
          bot.poi = originalPoi;
        }
      }
      await dockAtStation(ctx);
      continue;
    }

    // ── Fuel check ──
    yield "fuel_check";
    const fueled = await ensureFueled(ctx, settings.refuelThreshold, { homeSystem: settings.homeSystem, skipBlacklist: true, skipFleeCheck: true });
    if (!fueled) {
      ctx.log("error", "Cannot secure fuel — waiting 30s...");
      await ctx.sleep(30000);
      continue;
    }

    // ── Hull check — retreat to a high-security system to repair ──
    await bot.refreshShip();
    const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    if (hullPct <= settings.repairThreshold) {
      ctx.log("system", `Hull at ${hullPct}% — retreating to high-security system for repairs`);
      yield "emergency_repair";
      const docked = await navigateToSafeStation(ctx, safetyOpts);
      if (docked) {
        await completeActiveMissions(ctx);
        await repairShip(ctx);
        await tryRefuel(ctx, { skipApprovedCheck: true });
        await checkAndAcceptMissions(ctx);
        await ensureInsured(ctx);
        await bot.checkSkills();
        await ensureUndocked(ctx);
        // Return to stationary position
        if (bot.system !== originalSystem) {
          ctx.log("travel", `Returning to stationary system ${originalSystem}...`);
          const arrived = await navigateToSystem(ctx, originalSystem, safetyOpts);
          if (!arrived) {
            ctx.log("error", `Could not return to ${originalSystem} — staying in ${bot.system}`);
          }
        }
        if (bot.poi !== originalPoi) {
          ctx.log("travel", `Returning to stationary POI ${originalPoi}...`);
          const travelResp = await bot.exec("travel", { target_poi: originalPoi });
          if (travelResp.error && !travelResp.error.message.includes("already")) {
            ctx.log("error", `Failed to return to POI ${originalPoi}: ${travelResp.error.message}`);
          } else {
            bot.poi = originalPoi;
          }
        }
      }
      continue;
    }

    // ── Faction alert check — only respond if in current system ──
    yield "faction_alert_check";
    const alertTarget = await checkFactionAlerts(ctx, settings.responseRange);
    if (alertTarget && alertTarget !== bot.system) {
      ctx.log("info", `Faction alert in ${alertTarget} — ignoring (stationary mode)`);
    }

    // ── Wait and scan for targets ──
    ctx.log("info", `Waiting for targets at ${originalPoi}...`);
    yield "scan_for_targets";
    await ensureObservationSubscribed();
    const obsResult = await getObservationOrNearby(bot);
    const nearbyData = obsResult.result;
    const isObservation = obsResult.isObservation;

    if (!nearbyData) {
      ctx.log("error", `No observation/nearby data at ${originalPoi}`);
      await ctx.sleep(5000);
      continue;
    }

    if (isObservation) {
      ctx.log("debug", `obs: ${getObservationDebugLine(bot)}`);
    }

    // Track player names and wildlife from observation or nearby scan
    bot.trackNearbyPlayers(nearbyData);
    bot.trackWildlife(nearbyData);

    // Check if we got pulled into battle during scanning
    await handleUnexpectedBattle(ctx, settings.maxAttackTier, settings.minPiratesToFlee, settings.fleeThreshold, settings.fleeFromTier, settings.repairThreshold);

      // Immediate reaction to pirate scan notification (NPC only, not player scans)
      if ((nearbyData as any).notifications) {
        const notifs = Array.isArray((nearbyData as any).notifications) ? (nearbyData as any).notifications : [];
        for (const n of notifs) {
          const msg = (n as any)?.data?.message || (n as any)?.message || "";
          if (msg.includes("You were scanned by") && msg.includes("[COMBAT]")) {
            ctx.log("combat", "Pirate scan detected - immediate get_nearby + engage");
            const scanNearby = await bot.exec("get_nearby");
            if (!scanNearby.error) {
              bot.trackNearbyPlayers(scanNearby.result);
              bot.trackWildlife(scanNearby.result);
              const scanEntities = parseNearby(scanNearby.result);
              const scanTargets = [...scanEntities.filter(e => isPirateTarget(e, settings.onlyNPCs, settings.maxAttackTier) && !isStationEntity(e)), ...scanEntities.filter(e => isCreatureTarget(e, settings.huntCreatures) && !isStationEntity(e))];
              for (const t of scanTargets) {
                await hunterEngage(ctx, t, settings.fleeThreshold, settings.fleeFromTier, settings.minPiratesToFlee, settings.maxAttackTier, undefined, settings.disableScanCommandForPirates, settings.repairThreshold, settings.cloakOnStart);
              }
              // top up shields after immediate scan-target engagements (no per-target post-battle block)
              const ssettings = getHunterSettings(bot.username);
              await topUpShields(ctx, (ssettings.shieldRechargePct ?? 80) / 100);
              await useRepairKits(ctx);
            }
            break;
          }
        }
      }

      const entities = parseNearby(nearbyData);
      const pirate_targets = entities.filter(e => isPirateTarget(e, settings.onlyNPCs, settings.maxAttackTier));
      const creature_targets = prioritizeRainbowLeviathan(entities.filter(e => isCreatureTarget(e, settings.huntCreatures)).slice(0, settings.maxCreaturesPerScan));
      const targets = [...pirate_targets, ...creature_targets];

      if (targets.length === 0) {
        ctx.log("combat", `No targets at ${originalPoi}`);
        if (!settings.disableWreckSalvaging) await scavengeWrecks(ctx);
        await ctx.sleep(5000); // Wait 30 seconds before next scan
        continue;
      }

      ctx.log("combat", `Found ${pirate_targets.length} pirate(s), ${creature_targets.length} creature(s) at ${originalPoi}`);

// Engage each target
      for (const target of targets) {
        if (bot.state !== "running") break;

        await bot.refreshShip();
        const preHull = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
      if (preHull <= settings.repairThreshold) {
        ctx.log("system", `Hull at ${preHull}% — too low for another fight`);
        break;
      }

      await useRepairKits(ctx); // use cargo kits if hull deficit >100 before engaging

      // Pre-fight ammo check
      const hasAmmo = await ensureAmmoLoaded(ctx, settings.ammoThreshold, settings.maxReloadAttempts, settings.ammoReloadAbsoluteThreshold, settings.ammoReloadPercentThreshold);
      if (!hasAmmo && !settings.meatShield) {
        ctx.log("combat", "Out of ammo — aborting to resupply");
        break;
        }

        yield "engage";
        const won = await hunterEngage(ctx, target, settings.fleeThreshold, settings.fleeFromTier, settings.minPiratesToFlee, settings.maxAttackTier, undefined, settings.disableScanCommandForPirates, settings.repairThreshold, settings.cloakOnStart);

        if (won) {
          totalKills++;
          ctx.log("combat", `Kill #${totalKills} — looting wreck before next target...`);

          if (!settings.disableWreckSalvaging) {
            yield "loot";
            await scavengeWrecks(ctx);
          }

          // Safety check for new threats
          yield "safety_check";
          const safetyCheckResp = await bot.exec("get_nearby");
          if (!safetyCheckResp.error) {
            bot.trackNearbyPlayers(safetyCheckResp.result);
            await handleUnexpectedBattle(ctx, settings.maxAttackTier, settings.minPiratesToFlee, settings.fleeThreshold, settings.fleeFromTier, settings.repairThreshold);
            const nearbyEntities = parseNearby(safetyCheckResp.result);
            const newThreats = nearbyEntities.filter(e =>
              isPirateTarget(e, settings.onlyNPCs, settings.maxAttackTier) &&
              !isStationEntity(e) &&
              e.id !== target.id &&
              e.name !== target.name
            );

            if (newThreats.length > 0) {
              ctx.log("combat", `🚨 ${newThreats.length} new pirate(s) detected: ${newThreats.map(t => t.name).join(", ")} — engaging!`);
              for (const newThreat of newThreats) {
                if (bot.state !== "running") break;

                  const newWon = await hunterEngage(ctx, newThreat, settings.fleeThreshold, settings.fleeFromTier, settings.minPiratesToFlee, settings.maxAttackTier, undefined, settings.disableScanCommandForPirates, settings.repairThreshold, settings.cloakOnStart);
                  if (newWon) {
                  totalKills++;
                  ctx.log("combat", `Kill #${totalKills} (additional threat)`);
                } else {
                  ctx.log("combat", "Retreated from new threat");
                  break;
                }
              }
              }
          }

          // Post-kill reload
          const hasAmmo = await ensureAmmoLoaded(ctx, settings.ammoThreshold, settings.maxReloadAttempts, settings.ammoReloadAbsoluteThreshold, settings.ammoReloadPercentThreshold);
          if (!hasAmmo && !settings.meatShield) {
            ctx.log("combat", "No ammo after kill — aborting to resupply");
            break;
          }

          await topUpShields(ctx, (settings.shieldRechargePct ?? 80) / 100);
          await useRepairKits(ctx);
          await bot.refreshCargo();
          if (isLowOnFieldConsumables(bot.inventory)) {
            ctx.log("combat", "Low on repair kits or shield charges — stopping to resupply");
            break;
          }
          await bot.refreshShip();
          ctx.log("combat", `Post-fight: hull ${bot.hull}/${bot.maxHull} | ammo ${bot.ammo} | credits ${bot.credits}`);

      } else {
        ctx.log("combat", `Could not engage ${target.name} (already gone, fighting, or retreated) — skipping to next target`);
        await ctx.sleep(800);
        // continue to try remaining targets in this scan instead of aborting the whole list
      }
    }

    // After fighting, wait a bit before next scan
    await ctx.sleep(5000);
  }
}

// ── Station Protection Routine ────────────────────────────────
//
// "Visual deterrent" mode: the hunter docks at the station and sits, uncloaked,
// as a show of force. It performs the usual docked housekeeping (cargo check,
// ammo top-off, repair kits, shield charges, fuel, repairs, missions, insurance)
// on a slow cadence. It does NOT roam or scan for prey.
//
// Detection is via the spacemolt-lib battle push events, which Bot already
// tracks in `bot.currentBattle` / `bot.isInBattle()` the instant a battle
// starts/updates anywhere the bot is involved (including a station raid that
// pulls the docked defender in). We do NO polling — we just idle and check the
// `isInBattle()` flag, which is updated for free by the library's push
// subscription. The moment it flips we:
//   1. Undock (a docked ship cannot fight) — we assume a raid does NOT
//      auto-undock us, so we do it ourselves.
//   2. Join the fight as a regular hunter (full combat loop).
//   3. Once the battle is over, re-dock with the station and resume waiting.
//
// If a raid somehow forced us undocked, we just fight normally and re-dock after.

/**
 * Dock at the CURRENT station POI without traveling. Station protection keeps
 * the bot at one station, so we must NOT call the generic `ensureDocked` (which
 * will travel between a station's multiple POIs and cause a dock/undock
 * flip-flop). Just issue a plain dock where we already are.
 */
async function dockAtStation(ctx: RoutineContext): Promise<boolean> {
  const { bot } = ctx;
  if (bot.docked) return true;
  const resp = await bot.exec("dock");
  if (!resp.error || (resp.error?.message || "").toLowerCase().includes("already")) {
    bot.docked = true;
    return true;
  }
  ctx.log("warn", `Dock at current station failed: ${resp.error?.message}`);
  return false;
}

/**
 * Run a full hunter combat engagement against whatever battle is happening at
 * the station. Mirrors what the other hunter modes do when pulled into a fight:
 * analyze, engage the side, then fight until the battle ends.
 */
async function stationProtectionFight(ctx: RoutineContext, settings: ReturnType<typeof getHunterSettings>): Promise<void> {
  const { bot } = ctx;

  // A docked ship cannot participate in a battle. Undock if still docked
  // (a raid is assumed NOT to auto-undock us, so we do it ourselves).
  if (bot.docked) {
    ctx.log("combat", "Station under attack — undocking to defend!");
    const undockResp = await bot.exec("undock");
    if (!undockResp.error) {
      bot.docked = false;
    } else {
      ctx.log("error", `Failed to undock for defense: ${undockResp.error.message}`);
      // If undock fails we can't fight, bail and stay put.
      return;
    }
  }

  ctx.log("combat", `⚠️ Station battle detected (ID: ${bot.currentBattle.battleId}) — defending as hunter!`);

  const analysis = await analyzeExistingBattle(ctx, settings.maxAttackTier, settings.minPiratesToFlee);
  if (!analysis.shouldJoin) {
    ctx.log("combat", `Skipping station battle: ${analysis.reason}`);
    return;
  }

  if (analysis.sideId !== undefined) {
    const engageResp = await bot.exec("battle", { action: "engage", side_id: analysis.sideId.toString() });
    if (engageResp.error) {
      const errMsg = engageResp.error.message.toLowerCase();
      if (!errMsg.includes("already in a battle") && !errMsg.includes("already_in_battle")) {
        ctx.log("error", `Failed to join station defense: ${engageResp.error.message}`);
        return;
      }
    }
  }

  const enemy = (bot.currentBattle.participants ?? []).find((p: any) => p.side_id !== analysis.sideId && !p.is_destroyed);
  const fakeTarget = enemy ? { id: enemy.player_id || enemy.username || "", name: enemy.username || enemy.player_id || "enemy" } as any : null;
  if (fakeTarget) {
    broadcastHunterAssist(ctx, fakeTarget, isCreatureName(fakeTarget.name));
  }
  await fightJoinedBattle(ctx, fakeTarget, settings.fleeThreshold, settings.fleeFromTier, settings.maxAttackTier, settings.repairThreshold, false, settings.shieldRechargePct / 100, settings.onlyNPCs);
}

async function* stationProtectionRoutine(ctx: RoutineContext): AsyncGenerator<string, void, void> {
  const { bot } = ctx;

  await bot.refreshLocation();
  const settings = getHunterSettings(bot.username);

  ctx.log("info", "Station Protection mode: docking at station as a visual deterrent, uncloaked, awaiting attacks (battle push notifications only).");

  // Ensure we're docked at the station (without traveling between POIs).
  await dockAtStation(ctx);

  // Initial docked housekeeping + make sure we are NOT cloaked (visual deterrent).
  if (bot.docked) {
    if (bot.isCloaked) {
      const uncloakResp = await bot.exec("cloak", { enable: false });
      if (!uncloakResp.error) ctx.log("system", "Uncloaked — station protection must remain visible");
    }
    await repairShip(ctx);
    await tryRefuel(ctx, { skipApprovedCheck: true });
    await ensureHunterResupply(ctx);
    await ensureAmmoLoaded(ctx, settings.ammoThreshold, settings.maxReloadAttempts, settings.ammoReloadAbsoluteThreshold, settings.ammoReloadPercentThreshold);
  }

  // Docked housekeeping only runs on this cadence — the rest of the time we idle.
  const MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000;
  let lastMaintenance = 0;

  while (bot.state === "running") {
    // ── Death recovery ──
    const s = getHunterSettings(bot.username);
    const death = await handleDeath(ctx, s);
    if (death === "stop") return;
    if (death === "wait") continue;

    // ── Instant battle detection via lib push events ──
    // bot.isInBattle() is set by the library the moment a battle push arrives
    // (battle_started / battle_update / battle_damage). No polling required.
    if (bot.isInBattle()) {
      ctx.log("combat", "Battle push received at station — engaging as hunter!");
      await stationProtectionFight(ctx, s);
      // After the fight, return to assigned protection station and resume waiting.
      ctx.log("info", "Station defense complete — returning to assigned station to resume protection.");
      const hs = s.homeStation || "";
      const [hsys, hpoi] = hs.includes("|") ? hs.split("|") : ["", ""];
      if (hsys && hpoi && (bot.system !== hsys || bot.poi !== hpoi)) {
        ctx.log("travel", `Returning to protection station ${hpoi} in ${hsys}...`);
        if (bot.system !== hsys) {
          const safetyOpts = {
            fuelThresholdPct: s.refuelThreshold,
            hullThresholdPct: s.repairThreshold,
            autoCloak: false,
            skipBlacklist: true,
            isCombatBot: true,
            joinBattles: true,
          };
          await navigateToSystem(ctx, hsys, safetyOpts);
        }
        await bot.exec("travel", { target_poi: hpoi });
        bot.poi = hpoi;
      }
      const redocked = await dockAtStation(ctx);
      if (redocked) {
        if (bot.isCloaked) {
          const uncloakResp = await bot.exec("cloak", { enable: false });
          if (!uncloakResp.error) ctx.log("system", "Uncloaked after defense — resuming visible deterrent");
        }
        await repairShip(ctx);
        await tryRefuel(ctx, { skipApprovedCheck: true });
        await ensureHunterResupply(ctx);
        await ensureAmmoLoaded(ctx, s.ammoThreshold, s.maxReloadAttempts, s.ammoReloadAbsoluteThreshold, s.ammoReloadPercentThreshold);
      }
      lastMaintenance = Date.now();
      continue;
    }

    // ── Keep the deterrent visible: never cloaked while docked ──
    if (bot.docked && bot.isCloaked) {
      const uncloakResp = await bot.exec("cloak", { enable: false });
      if (!uncloakResp.error) ctx.log("system", "Re-uncloaked (station protection stays visible)");
    }

    // ── Docked housekeeping on a slow timer (not every loop) ──
    if (bot.docked && Date.now() - lastMaintenance >= MAINTENANCE_INTERVAL_MS) {
      yield "docked_maintenance";
      await bot.refreshLocation();
      await bot.refreshShip();
      logStatus(ctx);
      const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
      const shieldPct = bot.maxShield > 0 ? Math.round((bot.shield / bot.maxShield) * 100) : 100;

      // Field-consumable / ammo top-off (the "usual check cargo" + restock).
      await ensureHunterResupply(ctx);
      await ensureAmmoLoaded(ctx, s.ammoThreshold, s.maxReloadAttempts, s.ammoReloadAbsoluteThreshold, s.ammoReloadPercentThreshold);
      if (shieldPct < (s.shieldRechargePct ?? 80)) {
        await topUpShields(ctx, (s.shieldRechargePct ?? 80) / 100);
      }
      await tryRefuel(ctx, { skipApprovedCheck: true });
      if (hullPct <= s.repairThreshold) {
        await repairShip(ctx);
      }

      // Missions + insurance upkeep while docked.
      await completeActiveMissions(ctx);
      await checkAndAcceptMissions(ctx);
      await ensureInsured(ctx);
      if (bot.isCloaked) {
        const uncloakResp = await bot.exec("cloak", { enable: false });
        if (!uncloakResp.error) ctx.log("system", "Uncloaked during maintenance — station protection stays visible");
      }
      lastMaintenance = Date.now();
    } else if (!bot.docked) {
      // We got undocked somehow (e.g. raid yanked us out). Re-dock at the
      // CURRENT station POI — do NOT travel between POIs (that causes a
      // dock/undock flip-flop on stations with multiple POIs).
      ctx.log("info", "No longer docked during station protection — re-docking at current station.");
      await dockAtStation(ctx);
      if (bot.isCloaked) {
        const uncloakResp = await bot.exec("cloak", { enable: false });
        if (!uncloakResp.error) await bot.refreshLocation();
      }
      // Brief pause so a failed re-dock doesn't spin instantly.
      await ctx.sleep(3000);
    }

    // Idle: do nothing but wait. The library's battle push will flip
    // isInBattle() the instant a fight breaks out — no polling needed.
    yield "waiting";
    await ctx.sleep(2000);
  }
}

// ── Patrol Systems Routine (cycle through configured list) ────────

async function* patrolSystemsRoutine(ctx: RoutineContext): AsyncGenerator<string, void, void> {
  const { bot } = ctx;

  await bot.refreshLocation();
  let totalKills = 0;
  let systemIndex = 0;

  while (bot.state === "running") {
    const settings = getHunterSettings(bot.username);
    const death = await handleDeath(ctx, settings);
    if (death === "stop") return;
    if (death === "wait") continue;

    const patrolList = settings.patrolSystems || [];
    if (patrolList.length === 0) {
      ctx.log("error", "patrol_systems mode but no patrolSystems configured — falling back to roam_systems");
      yield* roamSystemsRoutine(ctx);
      return;
    }

    const targetSystem = patrolList[systemIndex % patrolList.length];
    systemIndex++;

    const safetyOpts = {
      fuelThresholdPct: settings.refuelThreshold,
      hullThresholdPct: settings.repairThreshold,
      autoCloak: settings.autoCloak,
      skipBlacklist: true,
      isCombatBot: true,
      joinBattles: true,
    };

    // Navigate to the target system in the list
    if (bot.system !== targetSystem) {
      ctx.log("travel", `Patrol systems: heading to ${targetSystem}...`);
      const arrived = await navigateToSystem(ctx, targetSystem, safetyOpts);
      if (!arrived) {
        const battleAfterNav = await getBattleStatus(ctx);
        if (battleAfterNav) {
          ctx.log("combat", `Battle detected after navigation - hunter fights, not flees!`);
          await handleNavigationBattleInterrupt(ctx, settings);
        } else {
          ctx.log("error", `Could not reach ${targetSystem} — skipping`);
          await ctx.sleep(5000);
          continue;
        }
      }
    }

    // Reuse the core patrol logic from roamSystem by calling a single-system patrol pass
    // For simplicity, we run one full roamSystem-like sweep but targeted
    ctx.log("info", `Starting patrol sweep in ${targetSystem}`);
    // Delegate to a single pass of the roam logic but force the system
    // (reuse existing code path by temporarily overriding via settings isn't clean,
    // so we just call the navigation + let the main loop handle; instead do direct patrol here)
    // Simpler: run the stationary-style patrol in this system
    yield* (async function* singleSystemPatrol() {
      // inline minimal patrol of current system (copy of key parts)
      await fetchSecurityLevel(ctx, bot.system);
      const { pois } = await getSystemInfo(ctx);
      const patrolPois = pois.filter(p => !isStationPoi(p));
      if (patrolPois.length === 0) {
        ctx.log("info", "No POIs — moving to next system");
        return;
      }
      for (const poi of patrolPois) {
        if (bot.state !== "running") break;
        await bot.exec("travel", { target_poi: poi.id });
        bot.poi = poi.id;
        await ctx.sleep(500);
        await ensureObservationSubscribed();
        const nearbyResult = await getObservationOrNearby(bot);
        const nearbyData = nearbyResult.result;
        if (!nearbyData) continue;
        bot.trackNearbyPlayers(nearbyData);
        const entities = parseNearby(nearbyData);
        const pirate_targets = entities.filter(e => isPirateTarget(e, settings.onlyNPCs, settings.maxAttackTier));
        const creature_targets = prioritizeRainbowLeviathan(entities.filter(e => isCreatureTarget(e, settings.huntCreatures)).slice(0, settings.maxCreaturesPerScan));
        const targets = [...pirate_targets, ...creature_targets];
        for (const target of targets) {
          await useRepairKits(ctx); // patch hull with kits before fight if deficit >100
          await ensureAmmoLoaded(ctx, settings.ammoThreshold, settings.maxReloadAttempts, settings.ammoReloadAbsoluteThreshold, settings.ammoReloadPercentThreshold);
          const won = await hunterEngage(ctx, target, settings.fleeThreshold, settings.fleeFromTier, settings.minPiratesToFlee, settings.maxAttackTier, undefined, settings.disableScanCommandForPirates, settings.repairThreshold, settings.cloakOnStart);
          if (won) {
            totalKills++;
            await scavengeWrecks(ctx);
            // top up shields (this path previously had no shield recharge after kills)
            const csettings = getHunterSettings(bot.username);
            await topUpShields(ctx, (csettings.shieldRechargePct ?? 80) / 100);
            await useRepairKits(ctx);
            await bot.refreshCargo();
            if (isLowOnFieldConsumables(bot.inventory)) {
              ctx.log("combat", "Low on repair kits or shield charges — stopping to resupply");
              break;
            }
          }
        }
      }
    })();

    // Single loop support for patrol_systems mode
    // After completing one full cycle, return to base for resupply, then repeat
    if (settings.singleLoop && systemIndex >= (settings.patrolSystems?.length || 1)) {
      ctx.log("system", "Single loop mode — returning to faction home base for resupply...");
      const hs = settings.homeStation || "";
      const [hsys, hpoi] = hs.includes("|") ? hs.split("|") : ["", ""];
      if (hsys && hpoi) {
        await navigateToSystem(ctx, hsys, safetyOpts);
        const t = await bot.exec("travel", { target_poi: hpoi });
        if (!t.error) { bot.poi = hpoi; await bot.exec("dock"); bot.docked = true; }
      } else {
        await navigateToSafeStation(ctx, safetyOpts);
      }
      await ensureHunterResupply(ctx);
      systemIndex = 0; // restart the patrol list
    }
  }
}

/** Hunter resupply: ammo, advanced repair kits, and military fuel cells from faction storage or station. */
export async function ensureHunterResupply(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;

  if (!bot.docked) return;

  const hs = getHunterSettings(bot.username);

  // Buying is currently disabled — we only withdraw from faction storage
  const allowBuying = false;

  // Always try to refuel when docked at home base (free fuel)
  await tryRefuel(ctx, { skipApprovedCheck: true });

  // Repair hull if damaged
  await repairShip(ctx);

  await bot.refreshLocation();
  await bot.refreshCargo();

  // Deposit any extra loot so user can see what was brought home.
  // When disableResupply is enabled, deposit EVERYTHING so the bot undocks
  // with an empty cargo hold (suicide / no-return runs).
  for (const item of [...bot.inventory]) {
    if (item.quantity <= 0) continue;

    if (!hs.disableResupply) {
      const id = item.itemId.toLowerCase();
      const isProtected =
        id.includes("ammo") ||
        id.includes("cell_pack") ||
        id.includes("plasma") ||
        id.includes("fuel_cell") ||
        id.includes("repair_kit") ||
        id.includes("shield_charge");
      if (isProtected) continue;
    }

    const dResp = await bot.exec("faction_deposit_items", { item_id: item.itemId, quantity: item.quantity });
    if (dResp.error) {
      await bot.exec("deposit_items", { item_id: item.itemId, quantity: item.quantity });
    }
    ctx.log("trade", `Deposited ${item.quantity}x ${item.name} to storage`);
  }
  await bot.refreshCargo();

  if (hs.disableResupply) {
    ctx.log("trade", "Resupply disabled — skipping repair kits, shield charges, and warp devices");
  }

  let freeSpace = Math.max(0, bot.cargoMax - (bot.cargo || 0));
  if (freeSpace < 5) {
    ctx.log("trade", "Cargo almost full — skipping resupply");
    return;
  }

  // Count what we already have in cargo for protected resupply items (so we only top off)
  // Note: currentAmmo is total across all types; we calculate per-type below
  const currentRepair = bot.inventory
    .filter(i => i.itemId.toLowerCase().includes("repair_kit"))
    .reduce((sum, i) => sum + (i.quantity || 0), 0);

  const currentFuel = bot.inventory
    .filter(i => i.itemId.toLowerCase().includes("fuel_cell"))
    .reduce((sum, i) => sum + (i.quantity || 0), 0);

  const currentShield = bot.inventory
    .filter(i => i.itemId.toLowerCase().includes("shield_charge"))
    .reduce((sum, i) => sum + (i.quantity || 0), 0);

  // 1. Ammo resupply - handle ALL ammo types needed by all weapons
  const weapons = await getWeaponModules(ctx);
  ctx.log("debug", `Hunter resupply: detected ${weapons.length} weapons`);

  for (const w of weapons) {
    ctx.log("debug", `  Weapon: ${w.name} | ammoType: ${w.ammoType || 'none'} | maxAmmo: ${w.maxAmmo}`);
  }

  // Collect all unique ammo types needed by weapons
  const weaponAmmoTypes = new Set<string>();
  for (const w of weapons) {
    if (w.ammoType && w.ammoType !== "none") {
      weaponAmmoTypes.add(w.ammoType);
    }
  }

  let gotAnyAmmo = false;
  const desiredAmmoBoxes = hs.desiredAmmoBoxes ?? -1;
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

    // Calculate current ammo count for this specific type
    const currentAmmoForType = bot.inventory
      .filter(i => possibleAmmo.includes(i.itemId))
      .reduce((sum, i) => sum + (i.quantity || 0), 0);

     // Calculate ammo needed for this type
     const weaponsUsingThisAmmo = weapons.filter(w => w.ammoType === ammoType);
     const totalAmmoCapacity = weaponsUsingThisAmmo.reduce((sum, w) => sum + (w.maxAmmo || 0), 0);
     const maxAmmoForType = totalAmmoCapacity > 0 ? Math.max(...weaponsUsingThisAmmo.map(w => w.maxAmmo || 0)) : 0;
     let ammoToGet: number;
     if (maxAmmoForType > 50) {
       ammoToGet = Math.max(0, Math.ceil(totalAmmoCapacity * 0.25) - currentAmmoForType);
     } else if (maxAmmoForType > 0) {
       ammoToGet = Math.max(0, Math.ceil(totalAmmoCapacity * 0.5) - currentAmmoForType);
     } else {
       ammoToGet = Math.max(0, 20 - currentAmmoForType);
     }

      if (desiredAmmoBoxes > 0) {
        ammoToGet = Math.min(ammoToGet, desiredAmmoBoxes);
      }

    // Prefer currently loaded ammo if available
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
      // Honor a stop request — don't keep issuing withdraws after stop
      if (bot.state !== "running") return;
      const ammoSize = getItemSize(ammoId);
      let actualQty = Math.min(ammoToGet, Math.floor(freeSpace / ammoSize));
      if (desiredAmmoBoxes > 0) {
        actualQty = Math.min(actualQty, desiredAmmoBoxes - typeAmmoGotten);
      }
      if (actualQty <= 0) {
        continue;
      }

      const wResp = await bot.exec("storage", {
        action: "withdraw",
        target: "faction",
        item_id: ammoId,
        quantity: actualQty
      });
      if (!wResp.error) {
        ctx.log("trade", `Withdrew ${actualQty} ${ammoId} from faction storage`);
        freeSpace -= actualQty * ammoSize;
        typeAmmoGotten += actualQty;
        gotAnyAmmo = true;
        break;
      } else {
        ctx.log("trade", `Failed to withdraw ${ammoId} for ${ammoType}: ${wResp.error.message}`);
      }
    }
  }

  if (!gotAnyAmmo) {
    ctx.log("trade", "No ammo withdrawn — skipping ammo resupply");
  }

  const desiredRepair = hs.desiredRepairKits ?? 12;

  if (!hs.disableResupply) {
    // 2. Repair kits (~10) - try advanced first, then fallback to regular (top off only)
    const repairKits = ["advanced_repair_kit", "repair_kit"];
    let gotRepairKits = false;
    const repairToGet = Math.max(0, desiredRepair - currentRepair);
    for (const kitId of repairKits) {
      const kitSize = getItemSize(kitId);
      const kitQty = Math.min(repairToGet, Math.floor(freeSpace / kitSize));
      if (kitQty <= 0) continue;

      const wResp = await bot.exec("storage", {
        action: "withdraw",
        target: "faction",
        item_id: kitId,
        quantity: kitQty
      });
      if (!wResp.error) {
        ctx.log("trade", `Withdrew ${kitQty} ${kitId} from faction storage`);
        freeSpace -= kitQty * kitSize;
        gotRepairKits = true;
        break;
      }
    }
    if (!gotRepairKits) {
      ctx.log("trade", "Repair kits: relying on faction storage");
    }
  } else {
    ctx.log("trade", "Skipping repair kits (disableResupply enabled)");
  }

  const desiredShield = hs.desiredShieldCharges ?? 20;

  if (!hs.disableResupply) {
    const shieldIds = ["shield_charge"];
    let gotShield = false;
    const shieldToGet = Math.max(0, desiredShield - currentShield);
    for (const shId of shieldIds) {
      const shSize = getItemSize(shId);
      const shQty = Math.min(shieldToGet, Math.floor(freeSpace / shSize));
      if (shQty <= 0) continue;

      const wResp = await bot.exec("storage", {
        action: "withdraw",
        target: "faction",
        item_id: shId,
        quantity: shQty
      });
      if (!wResp.error) {
        ctx.log("trade", `Withdrew ${shQty} ${shId} from faction storage`);
        freeSpace -= shQty * shSize;
        gotShield = true;
        break;
      }
    }
    if (!gotShield) {
      ctx.log("trade", "Shield charges: relying on faction storage");
    }
  } else {
    ctx.log("trade", "Skipping shield charges (disableResupply enabled)");
  }

  const desiredWarp = hs.desiredEmergencyWarpDevices ?? 3;
  const currentWarp = bot.inventory
    .filter(i => i.itemId.toLowerCase().includes("emergency_warp_device"))
    .reduce((sum, i) => sum + (i.quantity || 0), 0);
  const warpToGet = Math.max(0, desiredWarp - currentWarp);
  if (!hs.disableResupply && warpToGet > 0 && freeSpace >= getItemSize("emergency_warp_device")) {
    const wResp = await bot.exec("storage", {
      action: "withdraw",
      target: "faction",
      item_id: "emergency_warp_device",
      quantity: warpToGet
    });
    if (!wResp.error) {
      ctx.log("trade", `Withdrew ${warpToGet} emergency_warp_device from faction storage`);
    } else {
      ctx.log("trade", `Emergency warp devices: relying on faction storage (${warpToGet} needed)`);
    }
  }

  // 3. Military fuel cells — fill the rest (prefer faction storage)
  if (!hs.disableResupply) {
    const fuelCellSize = getItemSize("military_fuel_cell");
    if (freeSpace >= fuelCellSize) {
      const desiredFuel = hs.desiredFuelCells ?? -1;
      let fuelQty: number;
      if (desiredFuel >= 0) {
        fuelQty = Math.max(0, desiredFuel - currentFuel);
        fuelQty = Math.min(fuelQty, Math.floor(freeSpace / fuelCellSize));
      } else {
        fuelQty = Math.floor(freeSpace / fuelCellSize);
      }
      if (allowBuying) {
        const fuelResp = await bot.exec("buy", { item_id: "military_fuel_cell", quantity: fuelQty });
        if (!fuelResp.error) {
          ctx.log("trade", `Resupplied ${fuelQty} military fuel cells`);
        }
      } else {
        const wResp = await bot.exec("storage", {
          action: "withdraw",
          target: "faction",
          item_id: "military_fuel_cell",
          quantity: fuelQty
        });
        if (!wResp.error) {
          ctx.log("trade", `Withdrew ${fuelQty} military fuel cells from faction storage`);
        } else {
          ctx.log("trade", `Military fuel cells: relying on faction storage (${fuelQty} needed)`);
        }
      }
    }
  } else {
    ctx.log("trade", "Skipping fuel cells (disableResupply enabled)");
  }
}

// ── Cycle Patrols Routine (cycle through all patrol profiles) ─────

async function* cyclePatrolsRoutine(ctx: RoutineContext): AsyncGenerator<string, void, void> {
  const { bot } = ctx;

  await bot.refreshLocation();
  let totalKills = 0;

  const all = readSettings();
  const h = (all.hunter || {}) as any;
  const hunterPatrols: HunterPatrolProfile[] = Array.isArray(h.hunterPatrols) ? h.hunterPatrols : [];
  const settings = getHunterSettings(bot.username);

  if (hunterPatrols.length === 0) {
    ctx.log("error", "cycle_patrols mode but no hunterPatrols configured — falling back to roam_systems");
    yield* roamSystemsRoutine(ctx);
    return;
  }

  const botSeed = bot.username.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const random = seededRandom(botSeed);
  const initialProfileIndex = Math.floor(random() * hunterPatrols.length);

  let nextShuffle: number[] | null = null;
  let shuffleIndex = 0;
  let profileIndex = initialProfileIndex;

  while (bot.state === "running") {
    const death = await handleDeath(ctx, settings);
    if (death === "stop") return;
    if (death === "wait") continue;

    const cycleMode = settings.patrolCycleMode || "sequential";
    let targetIndex: number;

    if (cycleMode === "random") {
      if (!nextShuffle || shuffleIndex >= nextShuffle.length) {
        nextShuffle = [...Array(hunterPatrols.length).keys()].sort(() => random() - 0.5);
        shuffleIndex = 0;
      }
      targetIndex = nextShuffle[shuffleIndex];
      shuffleIndex++;
    } else {
      targetIndex = profileIndex;
      profileIndex = (profileIndex + 1) % hunterPatrols.length;
    }

    const profile = hunterPatrols[targetIndex];
    if (!profile || !profile.patrolSystems || profile.patrolSystems.length === 0) {
      ctx.log("error", `Invalid or empty patrol profile at index ${targetIndex} — skipping`);
      await ctx.sleep(5000);
      continue;
    }

    ctx.log("info", `Cycle patrols: now patrolling "${profile.name}" (${profile.patrolSystems.length} systems)`);

    const safetyOpts = {
      fuelThresholdPct: settings.refuelThreshold,
      hullThresholdPct: settings.repairThreshold,
      autoCloak: settings.autoCloak,
      skipBlacklist: true,
      isCombatBot: true,
      joinBattles: true,
    };

    for (const targetSystem of profile.patrolSystems) {
      if (bot.state !== "running") break;

      if (bot.system !== targetSystem) {
        ctx.log("travel", `Cycle patrols: heading to ${targetSystem}...`);
        const arrived = await navigateToSystem(ctx, targetSystem, safetyOpts);
        if (!arrived) {
          const battleAfterNav = await getBattleStatus(ctx);
          if (battleAfterNav) {
            ctx.log("combat", `Battle detected after navigation - hunter fights, not flees!`);
            await handleNavigationBattleInterrupt(ctx, settings);
          } else {
            ctx.log("error", `Could not reach ${targetSystem} — skipping`);
            await ctx.sleep(5000);
            continue;
          }
        }
      }

      await fetchSecurityLevel(ctx, bot.system);
      const { pois } = await getSystemInfo(ctx);
      const patrolPois = pois.filter(p => !isStationPoi(p));

      if (patrolPois.length === 0) {
        ctx.log("info", "No POIs — moving to next system");
        continue;
      }

      for (const poi of patrolPois) {
        if (bot.state !== "running") break;
        await bot.exec("travel", { target_poi: poi.id });
        bot.poi = poi.id;
        await ctx.sleep(500);
        await ensureObservationSubscribed();
        const nearbyResult = await getObservationOrNearby(bot);
        const nearbyData = nearbyResult.result;
        if (!nearbyData) continue;
        bot.trackNearbyPlayers(nearbyData);
        const entities = parseNearby(nearbyData);
        const pirate_targets = entities.filter(e => isPirateTarget(e, settings.onlyNPCs, settings.maxAttackTier));
        const creature_targets = prioritizeRainbowLeviathan(entities.filter(e => isCreatureTarget(e, settings.huntCreatures)).slice(0, settings.maxCreaturesPerScan));
        const targets = [...pirate_targets, ...creature_targets];
        for (const target of targets) {
          await useRepairKits(ctx); // patch hull with kits before fight if deficit >100
          await ensureAmmoLoaded(ctx, settings.ammoThreshold, settings.maxReloadAttempts, settings.ammoReloadAbsoluteThreshold, settings.ammoReloadPercentThreshold);
          const won = await hunterEngage(ctx, target, settings.fleeThreshold, settings.fleeFromTier, settings.minPiratesToFlee, settings.maxAttackTier, undefined, settings.disableScanCommandForPirates, settings.repairThreshold, settings.cloakOnStart);
          if (won) {
            totalKills++;
            await scavengeWrecks(ctx);
            // top up shields (this path previously had no shield recharge after kills)
            const csettings = getHunterSettings(bot.username);
            await topUpShields(ctx, (csettings.shieldRechargePct ?? 80) / 100);
            await useRepairKits(ctx);
            await bot.refreshCargo();
            if (isLowOnFieldConsumables(bot.inventory)) {
              ctx.log("combat", "Low on repair kits or shield charges — stopping to resupply");
              break;
            }
          }
        }
      }
    }

    if (settings.singleLoop) {
      ctx.log("system", "Single loop mode — returning to faction home base for resupply...");
      const hs = settings.homeStation || "";
      const [hsys, hpoi] = hs.includes("|") ? hs.split("|") : ["", ""];
      if (hsys && hpoi) {
        await navigateToSystem(ctx, hsys, safetyOpts);
        const t = await bot.exec("travel", { target_poi: hpoi });
        if (!t.error) { bot.poi = hpoi; await bot.exec("dock"); bot.docked = true; }
      } else {
        await navigateToSafeStation(ctx, safetyOpts);
      }
      await ensureHunterResupply(ctx);
      profileIndex = 0;
    }
  }
}

async function* patrolRadiusRoutine(ctx: RoutineContext): AsyncGenerator<string, void, void> {
  const { bot } = ctx;

  await bot.refreshLocation();
  let totalKills = 0;

  const settings = getHunterSettings(bot.username);
  const pirateBase = settings.pirateBaseSystem;
  const maxJumps = settings.patrolRadius;

  if (!pirateBase) {
    ctx.log("error", "patrol_radius mode requires pirateBaseSystem to be configured — falling back to roam_systems");
    yield* roamSystemsRoutine(ctx);
    return;
  }

  const normalizedPirateBase = pirateBase.toLowerCase().replace(/_/g, ' ');
  let pirateBaseSystemId: string | null = null;
  
  if (mapStore.getSystem(pirateBase)) {
    pirateBaseSystemId = pirateBase;
  } else {
    for (const sysId of mapStore.getAllSystemIds()) {
      const sys = mapStore.getSystem(sysId);
      if (!sys) continue;
      const sysName = (sys.name || sysId).toLowerCase().replace(/_/g, ' ');
      if (sysName === normalizedPirateBase) {
        pirateBaseSystemId = sysId;
        break;
      }
    }
  }
  
  if (!pirateBaseSystemId) {
    ctx.log("info", `Navigating to pirate base ${pirateBase} to map it...`);
    const safetyOpts = {
      fuelThresholdPct: settings.refuelThreshold,
      hullThresholdPct: settings.repairThreshold,
      autoCloak: settings.autoCloak,
      skipBlacklist: true,
      isCombatBot: true,
      joinBattles: true,
    };
    const arrived = await navigateToSystem(ctx, pirateBase, safetyOpts);
    if (!arrived) {
      ctx.log("error", `Could not reach pirate base ${pirateBase} — falling back to roam_systems`);
      yield* roamSystemsRoutine(ctx);
      return;
    }
    await getSystemInfo(ctx);
    pirateBaseSystemId = bot.system;
  }

  const patrolList = findSystemsWithinRadius(pirateBaseSystemId, maxJumps);
  if (patrolList.length === 0) {
    ctx.log("error", `patrol_radius mode: no systems found within ${maxJumps} jumps of ${pirateBaseSystemId} — falling back to roam_systems`);
    yield* roamSystemsRoutine(ctx);
    return;
  }

  ctx.log("info", `Patrol radius mode: ${patrolList.length} systems within ${maxJumps} jumps of ${pirateBaseSystemId}`);
  let systemIndex = 0;

  while (bot.state === "running") {
    const currentSettings = getHunterSettings(bot.username);
    const death = await handleDeath(ctx, currentSettings);
    if (death === "stop") return;
    if (death === "wait") continue;

    const currentSafetyOpts = {
      fuelThresholdPct: currentSettings.refuelThreshold,
      hullThresholdPct: currentSettings.repairThreshold,
      autoCloak: currentSettings.autoCloak,
      skipBlacklist: true,
      isCombatBot: true,
      joinBattles: true,
    };

    const targetSystem = patrolList[systemIndex % patrolList.length];
    systemIndex++;

    if (bot.system !== targetSystem) {
      ctx.log("travel", `Patrol radius: heading to ${targetSystem}...`);
      const arrived = await navigateToSystem(ctx, targetSystem, currentSafetyOpts);
      if (!arrived) {
        const battleAfterNav = await getBattleStatus(ctx);
        if (battleAfterNav) {
          ctx.log("combat", `Battle detected after navigation - hunter fights, not flees!`);
          await handleNavigationBattleInterrupt(ctx, currentSettings);
        } else {
          ctx.log("error", `Could not reach ${targetSystem} — skipping`);
          await ctx.sleep(5000);
          continue;
        }
      }
    }

    ctx.log("info", `Starting patrol sweep in ${targetSystem}`);
    yield* (async function* singleSystemPatrol() {
      await fetchSecurityLevel(ctx, bot.system);
      const { pois } = await getSystemInfo(ctx);
      const patrolPois = pois.filter(p => !isStationPoi(p));
      if (patrolPois.length === 0) {
        ctx.log("info", "No POIs — moving to next system");
        return;
      }
      for (const poi of patrolPois) {
        if (bot.state !== "running") break;
        await bot.exec("travel", { target_poi: poi.id });
        bot.poi = poi.id;
        await ctx.sleep(500);
        await ensureObservationSubscribed();
        const nearbyResult = await getObservationOrNearby(bot);
        const nearbyData = nearbyResult.result;
        if (!nearbyData) continue;
        bot.trackNearbyPlayers(nearbyData);
        const entities = parseNearby(nearbyData);
        const pirate_targets = entities.filter(e => isPirateTarget(e, currentSettings.onlyNPCs, currentSettings.maxAttackTier));
        const creature_targets = prioritizeRainbowLeviathan(entities.filter(e => isCreatureTarget(e, currentSettings.huntCreatures)).slice(0, currentSettings.maxCreaturesPerScan));
        const targets = [...pirate_targets, ...creature_targets];
        for (const target of targets) {
          await useRepairKits(ctx);
          await ensureAmmoLoaded(ctx, currentSettings.ammoThreshold, currentSettings.maxReloadAttempts, currentSettings.ammoReloadAbsoluteThreshold, currentSettings.ammoReloadPercentThreshold);
          const won = await hunterEngage(ctx, target, currentSettings.fleeThreshold, currentSettings.fleeFromTier, currentSettings.minPiratesToFlee, currentSettings.maxAttackTier, undefined, currentSettings.disableScanCommandForPirates, currentSettings.repairThreshold);
          if (won) {
            totalKills++;
            await scavengeWrecks(ctx);
            const csettings = getHunterSettings(bot.username);
            await topUpShields(ctx, (csettings.shieldRechargePct ?? 80) / 100);
            await useRepairKits(ctx);
            await bot.refreshCargo();
            if (isLowOnFieldConsumables(bot.inventory)) {
              ctx.log("combat", "Low on repair kits or shield charges — stopping to resupply");
              break;
            }
          }
        }
      }
    })();

    if (currentSettings.singleLoop && systemIndex >= patrolList.length) {
      ctx.log("system", "Single loop mode — returning to faction home base for resupply...");
      const hs = currentSettings.homeStation || "";
      const [hsys, hpoi] = hs.includes("|") ? hs.split("|") : ["", ""];
      if (hsys && hpoi) {
        await navigateToSystem(ctx, hsys, currentSafetyOpts);
        const t = await bot.exec("travel", { target_poi: hpoi });
        if (!t.error) { bot.poi = hpoi; await bot.exec("dock"); bot.docked = true; }
      } else {
        await navigateToSafeStation(ctx, currentSafetyOpts);
      }
      await ensureHunterResupply(ctx);
      systemIndex = 0;
    }
  }
}






