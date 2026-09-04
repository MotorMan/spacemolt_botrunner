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
 *   - creature_farm: Farm creatures across a Hunter Patrol Profile's systems
 *   - fleet: Do nothing until pulled into a battle (fleet wingman), fight, then stand down
 *   - pvp: Camp a single system POI (never move) and send an attack command every
 *          tick at a configured target player (hunter.targetPlayer / per-bot override)
 *
 * Modes:
 *   - boarding: Hunt pirates as usual, but when a target's shields drop below
 *          boardingShieldThreshold and the ship has boarding capability + marines,
 *          enter the board stance (committing boardingMarines) instead of firing
 *          to destruction. Monitors the boarding operation to completion.
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
 *
 * Fleet mode settings (mode = "fleet"):
 *   fleetIdlePollSeconds      — standby tick length in seconds (default: 2)
 *   fleetBattleConfirmSeconds — get_battle_status fallback poll interval, in case a
 *                               battle push event is missed (default: 10, 0 = push only)
 *   fleetFightPlayers         — fight players too, since the fleet leader picked the
 *                               target (default: true; false = honour onlyNPCs and flee players)
 *   fleetUndockToFight        — undock when a battle starts while docked (default: true)
 *   boardingEnabled          — when true, the hunter switches to boarding stance on eligible targets with low shields instead of killing them (default: false)
 *   boardingShieldThreshold   — shield % at or below which to attempt boarding (default: 5)
 *   boardingMarines           — marines to commit to the board stance (0 = all fit marines on board; default: 0)
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
  ensureFueledEx,
  type FuelCheckOutcome,
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
import { fleetStatus } from "./fleet.js";
import type { PirateTier, NearbyEntity } from "./battle.js";
import type { PrizeInfo } from "../types/game.js";
import {
  parseNearby,
  isPirateTarget,
  isCreatureTarget,
  isCreatureName,
  ensureAmmoLoaded,
  engageTarget,
  analyzeExistingBattle,
  fightFreshBattle,
  fightJoinedBattle,
  getWeaponModules,
  emergencyFleeSpam,
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

/**
 * Returns true if a creature is a leviathan (worth a coordinated multi-hunter
 * assist). Everything else dies to a single hunter shot, so pulling in extra
 * hunters just splits the loot at the choke-point bottlenecks.
 *
 * Currently only Rainbow Leviathan spawns, but the match is generic so any
 * future leviathan variant is still coordinated.
 */
function isLeviathanCreature(name: string | undefined): boolean {
  if (!name) return false;
  return name.toLowerCase().includes("leviathan");
}

/**
 * Returns true if a creature has been branded by another faction/ranch.
 * Branded creatures must NEVER be attacked — the branding marker lives in the
 * creature's display name (not the hex id), so we check the name before picking
 * the id to attack. Future game updates may impose penalties for killing branded
 * livestock, so we skip them everywhere today.
 */
function isBrandedCreature(name: string | undefined): boolean {
  if (!name) return false;
  return name.toLowerCase().includes("branded");
}

/**
 * Used by the reactive battle-join paths (API battle detection while scanning /
 * navigating). If a battle we are NOT already part of contains a NON-leviathan
 * creature that another hunter is already fighting, we skip it — that creature is
 * already being solo'd (and likely claimed), so piling in just splits loot at the
 * shared choke-point POIs. Leviathan battles still pass through so the wing can
 * assist as intended.
 */
function isWeakCreatureBattleAlreadyHandled(ctx: RoutineContext, battleStatus: { is_participant?: boolean; participants?: Array<{ username?: string }> }): boolean {
  if (battleStatus.is_participant) return false; // we're already in it — fight
  const participants = battleStatus.participants || [];
  const creatures = participants.filter(p => isCreatureName(p.username));
  if (creatures.length === 0) return false;
  if (creatures.some(p => isLeviathanCreature(p.username))) return false; // leviathans: group assist
  const allies = participants.filter(p => {
    const u = p.username || "";
    if (isCreatureName(u)) return false;
    if (u === ctx.bot.username) return false;
    if (u.startsWith("[POLICE]")) return false;
    if (u.toLowerCase().includes("pirate") || u.toLowerCase().includes("drifter")) return false;
    return true;
  });
  return allies.length > 0;
}

async function handleUnexpectedBattle(ctx: RoutineContext, maxAttackTier: PirateTier, minPiratesToFlee: number, fleeThreshold: number, fleeFromTier: PirateTier, repairThreshold: number = 0, onlyNPCs: boolean = false): Promise<void> {
  const battleStatus = await getBattleStatus(ctx);
  if (!battleStatus) return;

  // Don't get pulled into a one-shot creature battle another hunter is already solo'ing
  // (and likely claimed). Leviathans still pass through for the group assist.
  if (isWeakCreatureBattleAlreadyHandled(ctx, battleStatus)) {
    ctx.log("combat", `⏭️ Skipping battle (ID: ${battleStatus.battle_id}) — non-leviathan creature already handled by an ally`);
    return;
  }

  ctx.log("combat", `⚠️ Unexpectedly in battle (ID: ${battleStatus.battle_id}) during scanning`);

  const analysis = await analyzeExistingBattle(ctx, maxAttackTier, minPiratesToFlee);
  if (!analysis.shouldJoin) {
    ctx.log("combat", `⏭️ Skipping unexpected battle: ${analysis.reason}`);
    return;
  }

  // Get hunter settings for shield recharge
  const hsettings = getHunterSettings(ctx.bot.username);
  const shieldRechargePct = (hsettings.shieldRechargePct ?? 80) / 100;

  // A hunter FIGHTS — it does not flee a creature it can crush in one shot, even if it
  // booted up already inside a battle. fightJoinedBattle engages correctly whether we're
  // a fresh participant (`attack`) or already a participant of a stale/restarted battle
  // (re-target + fire stance, since `attack` hangs when already engaged).
  ctx.log("combat", `✅ Engaging unexpected battle on side ${analysis.sideId}: ${analysis.reason} — holding and fighting`);

  // Pick a real target from battle participants so we get the full combat loop.
  // Branded creatures are skipped — we never attack them.
  const enemy = battleStatus.participants.find(p => p.side_id !== analysis.sideId && !p.is_destroyed && !isBrandedCreature(p.username || ""));
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

/**
 * Handle a fuel check that did not come back "fueled".
 *
 * A non-"fueled" outcome is NOT always a fuel problem:
 *
 *   "in_battle" — the fuel subsystem deliberately skipped itself because a
 *                 battle is live. Fuel is not consumed in combat, so there is
 *                 nothing to fix. GO FIGHT, immediately.
 *   "failed"    — genuinely could not secure fuel. But a battle may still have
 *                 started part-way through the fuel run, so check for that
 *                 before deciding to idle.
 *
 * Blindly sleeping 30s here is exactly the wrong move: the hunter sits there
 * absorbing hits while the battle-handling code further down the loop is never
 * reached, and the next iteration hits the same guard — forever. That is how a
 * hunter with a 95% tank and a hold full of military_fuel_cells ended up
 * logging "Cannot secure fuel — waiting 30s..." for 40 minutes straight while
 * being shot at.
 *
 * So: if a battle is live, FIGHT IT. Only wait when fuel is genuinely the problem.
 */
async function handleFuelCheckFailure(
  ctx: RoutineContext,
  settings: ReturnType<typeof getHunterSettings>,
  outcome: FuelCheckOutcome,
): Promise<void> {
  // Straight into the fighting functions — no fuel logic, no sleep, no delay.
  if (await checkAndHandleExistingBattle(ctx, settings)) {
    ctx.log("combat", "Fuel check yielded to combat — battle handled, resuming patrol");
    return;
  }

  if (outcome === "in_battle") {
    // Battle flag was set but has already resolved (or was stale). Loop straight
    // back around and re-check fuel rather than burning 30s for nothing.
    ctx.log("combat", "Battle already resolved — re-checking fuel immediately");
    return;
  }

  await ctx.bot.refreshShip();
  const fuelPct = ctx.bot.maxFuel > 0 ? Math.round((ctx.bot.fuel / ctx.bot.maxFuel) * 100) : 100;
  ctx.log("error", `Cannot secure fuel (at ${fuelPct}%, threshold ${settings.refuelThreshold}%) — waiting 30s...`);
  await ctx.sleep(30000);
}

// ── Settings ─────────────────────────────────────────────────

export type HunterMode = "roam_systems" | "roam_system" | "stationary" | "patrol_systems" | "cycle_patrols" | "patrol_radius" | "station_protection" | "creature_farm" | "fleet" | "pvp" | "boarding";

/**
 * A Creature Farm "route" is just a Hunter Patrol Profile (hunter.hunterPatrols).
 * Each bot is assigned (per-bot) to one named profile via
 * hunter.botHunterPatrolAssignments. The profile's `patrolSystems` is the list of
 * systems the creature-farm bot routes across, farming `creatureFarmLoopsPerSystem`
 * loops in each before advancing to the next system (cycling back to the first).
 *
 * The home base used to bank loot and restock ammo comes from the hunter
 * homeSystem / homeStation settings (same as every other hunter mode). Optional
 * per-profile `targetPois` restrict farming to specific POIs.
 */

export type PatrolCycleMode = "random" | "sequential";

export interface HunterPatrolProfile {
  name: string;
  patrolSystems: string[];
  /** Optional per-profile POI filter. When set, only these POIs are farmed /
   *  patrolled (matched by POI id or name). Used by the creature_farm sub-routine
   *  to restrict a profile to specific creature spawns. */
  targetPois?: string[];
  /** Optional creature farm radius mode: when set, the profile generates its
   *  patrol system list dynamically from `creatureFarmCenterSystem` rather than
   *  using the static `patrolSystems` array. The center system is resolved by ID
   *  or name, and all systems within `creatureFarmPatrolRadius` jumps are
   *  collected, shuffled, and farmed in random order. */
  creatureFarmCenterSystem?: string;
  creatureFarmPatrolRadius?: number;
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
  targetPlayer: string;
  maxCreaturesPerScan: number;
  creatureFarmLoopsPerSystem: number;
  creatureFarmCargoFullPct: number;
  creatureFarmMaxPassesPerPoi: number;
  creatureFarmMaxSystemSweeps: number;
   fleetIdlePollSeconds: number;
  fleetBattleConfirmSeconds: number;
  fleetFightPlayers: boolean;
  fleetUndockToFight: boolean;
  boardingEnabled: boolean;
  boardingShieldThreshold: number;
  boardingMarines: number;
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
  targetPlayer: (botOverrides.targetPlayer as string) || (h.targetPlayer as string) || "",
  maxCreaturesPerScan: (h.maxCreaturesPerScan as number) ?? 10,
  creatureFarmLoopsPerSystem: ((botOverrides.creatureFarmLoopsPerSystem as number) || (h.creatureFarmLoopsPerSystem as number) || 3),
  creatureFarmCargoFullPct: (h.creatureFarmCargoFullPct as number) ?? 95,
  creatureFarmMaxPassesPerPoi: (h.creatureFarmMaxPassesPerPoi as number) ?? 6,
  creatureFarmMaxSystemSweeps: (h.creatureFarmMaxSystemSweeps as number) ?? 40,
   fleetIdlePollSeconds: (botOverrides.fleetIdlePollSeconds as number) ?? (h.fleetIdlePollSeconds as number) ?? 2,
   fleetBattleConfirmSeconds: (botOverrides.fleetBattleConfirmSeconds as number) ?? (h.fleetBattleConfirmSeconds as number) ?? 10,
   fleetFightPlayers: (botOverrides.fleetFightPlayers as boolean) ?? (h.fleetFightPlayers as boolean) ?? true,
   fleetUndockToFight: (botOverrides.fleetUndockToFight as boolean) ?? (h.fleetUndockToFight as boolean) ?? true,
   boardingEnabled: (botOverrides.boardingEnabled as boolean) ?? (h.boardingEnabled as boolean) ?? false,
   boardingShieldThreshold: (botOverrides.boardingShieldThreshold as number) ?? (h.boardingShieldThreshold as number) ?? 5,
   boardingMarines: (botOverrides.boardingMarines as number) ?? (h.boardingMarines as number) ?? 0,
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

/**
 * Resolve the Hunter Patrol Profile assigned to a bot (falls back to the first
 * profile). The creature_farm sub-routine reuses this structure as its route:
 * `patrolSystems` is the ordered list of systems to farm across, and optional
 * `targetPois` restricts which POIs are visited.
 */
export function getHunterPatrolProfile(username: string): HunterPatrolProfile | null {
  const all = readSettings();
  const h = (all.hunter || {}) as any;
  const profiles: HunterPatrolProfile[] = Array.isArray(h.hunterPatrols) ? h.hunterPatrols : [];
  if (profiles.length === 0) return null;
  const assignments: Record<string, string> = (h.botHunterPatrolAssignments as Record<string, string>) || {};
  const name = assignments[username] || profiles[0].name;
  return profiles.find(p => p.name === name) || profiles[0] || null;
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

  // Don't get pulled into a one-shot creature battle another hunter is already solo'ing
  // (and likely claimed). Leviathans still pass through for the group assist.
  if (isWeakCreatureBattleAlreadyHandled(ctx, battleStatus)) {
    ctx.log("combat", `⏭️ Navigation battle (ID: ${battleStatus.battle_id}) skipped — non-leviathan creature already handled by an ally`);
    return;
  }

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

const enemy = (battleStatus?.participants ?? []).find((p: any) => p.side_id !== analysis.sideId && !p.is_destroyed && !isBrandedCreature(p.username || ""));
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

/**
 * Resolve a system reference (ID or name) to a canonical system ID from the
 * map store. Returns null if the system cannot be found.
 */
function resolveSystemId(ref: string): string | null {
  const normalized = ref.toLowerCase().replace(/_/g, ' ');
  if (mapStore.getSystem(ref)) return ref;
  for (const sysId of mapStore.getAllSystemIds()) {
    const sys = mapStore.getSystem(sysId);
    if (!sys) continue;
    const sysName = (sys.name || sysId).toLowerCase().replace(/_/g, ' ');
    if (sysName === normalized) return sysId;
  }
  return null;
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

// ── Creature "claim" lock (non-API bot chat channel) ──────────
//
// Because we no longer want multiple hunters piling onto a weak one-shot creature
// (it only splits loot at the crowded choke-point POIs all the tour bots share),
// the first hunter to start attacking a non-leviathan creature "claims" it over the
// in-memory bot chat channel. Other hunters in the same process honour the claim and
// skip that creatureId so they pick a different target instead.
//
// Leviathans are explicitly NOT claimed — they still get the full assist broadcast
// (see isLeviathanCreature / broadcastHunterAssist) so the whole wing lands on them.

/** How long a claim stays valid before it is treated as stale (ms). Covers the case
 *  where the claiming bot dies mid-fight and never releases the lock. */
const CREATURE_CLAIM_TTL_MS = 90 * 1000;
/** Map<creatureId, { claimer, expires }> — shared across all bots in this process. */
const creatureClaims = new Map<string, { claimer: string; expires: number }>();

function releaseExpiredCreatureClaims(): void {
  const now = Date.now();
  for (const [id, claim] of creatureClaims) {
    if (claim.expires <= now) creatureClaims.delete(id);
  }
}

/** Broadcast a claim lock for a non-leviathan creature we're about to engage. */
function claimCreature(ctx: RoutineContext, target: { id: string; name: string }): void {
  const { bot } = ctx;
  if (!bot.system || !bot.poi) return;
  const settings = getHunterSettings(bot.username);
  if (!settings.coordinateHunts) return;
  // Only non-leviathan creatures are claimed — leviathans keep the assist broadcast.
  // Branded creatures are never claimed — they belong to another faction.
  const isCreature = !!(target as any).isCreature || isCreatureTarget(target as any, true);
  if (!isCreature || isLeviathanCreature(target.name) || isBrandedCreature(target.name)) return;
  creatureClaims.set(target.id, { claimer: bot.username, expires: Date.now() + CREATURE_CLAIM_TTL_MS });
  botChatChannel.send({
    sender: bot.username,
    recipients: [],
    channel: "coordination",
    content: `[CREATURE CLAIM] ${bot.username} claiming ${target.name} (${target.id}) at ${bot.system}/${bot.poi}`,
    metadata: {
      type: "creature_claim",
      system: bot.system,
      poi: bot.poi,
      targetName: target.name,
      targetId: target.id,
    },
  });
}

/** True if a different hunter has an active claim on this creatureId. */
function isCreatureClaimedByOther(creatureId: string, username: string): boolean {
  const claim = creatureClaims.get(creatureId);
  if (!claim) return false;
  if (claim.expires <= Date.now()) {
    creatureClaims.delete(creatureId);
    return false;
  }
  return claim.claimer !== username;
}

/**
 * Pick the creatures a hunter should engage, honouring other hunters' claim locks.
 * Leviathans are never filtered (they want the group assist) and are prioritised
 * first. Non-leviathan creatures already claimed by another bot are dropped so the
 * hunter picks a different, unclaimed target instead.
 */
function pickCreatureTargets(entities: NearbyEntity[], username: string, huntCreatures: boolean, max: number): NearbyEntity[] {
  releaseExpiredCreatureClaims();
  const creatures = entities.filter(e => isCreatureTarget(e, huntCreatures) && !isStationEntity(e) && !isBrandedCreature(e.name));
  const unclaimed = creatures.filter(e =>
    isLeviathanCreature(e.name) || !isCreatureClaimedByOther(e.id, username),
  );
  const result = prioritizeRainbowLeviathan(unclaimed).slice(0, Math.max(0, max));
  // Claim the creatures we're handing back so a bot scanning on the same tick skips
  // them (selection is the sync point — the process-shared map prevents two hunters
  // from both picking the same one-shot creature). Leviathans are never claimed.
  for (const c of result) {
    if (!isLeviathanCreature(c.name) && !creatureClaims.has(c.id)) {
      creatureClaims.set(c.id, { claimer: username, expires: Date.now() + CREATURE_CLAIM_TTL_MS });
    }
  }
  return result;
}

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
    // Lock one-shot creatures so other hunters don't also start attacking the same
    // target (leviathans are intentionally skipped — they keep the assist broadcast).
    claimCreature(ctx, target);
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
    if (meta.type === "hunter_assist") {
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
    } else if (meta.type === "creature_claim") {
      // Another hunter claimed a one-shot creature — lock it so we don't also attack it.
      const targetId = (meta.targetId as string) || "";
      if (targetId) {
        creatureClaims.set(targetId, { claimer: msg.sender, expires: Date.now() + CREATURE_CLAIM_TTL_MS });
      }
    }
  });
}

/** Broadcast that we're engaging a target so same-POI allies can join in. */
function broadcastHunterAssist(ctx: RoutineContext, target: { id: string; name: string }, creature: boolean): void {
  const { bot } = ctx;
  if (!bot.system || !bot.poi) return;
  const settings = getHunterSettings(bot.username);
  if (!settings.coordinateHunts) return;
  // Only coordinate assists for leviathan creatures. Every other creature drops to
  // a single hunter shot, so pulling in multiple hunters just splits the loot at the
  // crowded choke-point POIs where all the bots converge.
  // Branded creatures are NEVER broadcast — they belong to another faction.
  if (creature && (!isLeviathanCreature(target.name) || isBrandedCreature(target.name))) return;
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

    // Only coordinate-assist creatures that are leviathans. Every other creature
    // dies to a single hunter shot, so joining those would just split loot at the
    // crowded choke-point POIs where all the tour bots converge.
    // Branded creatures are NEVER assisted either — they belong to another faction.
    if (req.creature && (!isLeviathanCreature(req.targetName) || isBrandedCreature(req.targetName))) {
      handled.add(key);
      continue;
    }

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
      ? isCreatureTarget(match, true) && !isBrandedCreature(match.name)
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
      // station_protection stays docked on purpose; fleet mode never moves itself
      // (the fleet leader owns dock/undock/jump), so it also stays put.
      if (initialSettings.mode !== "station_protection" && initialSettings.mode !== "fleet") {
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

    if (initialSettings.mode === "fleet") {
      yield* fleetModeRoutine(ctx);
      return;
    }

    if (initialSettings.mode === "pvp") {
      yield* pvpRoutine(ctx);
      return;
    }

    if (initialSettings.mode === "boarding") {
      yield* boardingRoutine(ctx);
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
//     then returns to the home base (hunter homeSystem / homeStation) to deposit
//     loot and restock ammo.
//   * Its route is a Hunter Patrol Profile (hunter.hunterPatrols) assigned to the
//     bot. The profile's `patrolSystems` is the ordered list of systems farmed;
//     the bot does `creatureFarmLoopsPerSystem` loops in each system before
//     advancing to the next (cycling back to the first). Optional per-profile
//     `targetPois` restricts farming to specific POIs.

/** Navigate to the home base, deposit loot, and restock ammo/shields/repair. */
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
  // Guard against an infinite resupply loop: if the home base cannot fully
  // restock (e.g. no shield charges in faction storage), isLowOnFieldConsumables
  // stays true and would otherwise send us home every single loop iteration
  // without ever farming. After a resupply we set this and skip the consumable
  // return-home check once so the bot actually leaves for the target system.
  let justResupplied = false;

  // Routing state across the whole run: which profile system we're currently
  // farming. A "loop" = one full sweep of every POI in the system (re-scanning
  // each POI up to creatureFarmMaxPassesPerPoi times to mop up respawns). We do
  // `creatureFarmLoopsPerSystem` loops in the current system, then advance to
  // the next system in the assigned Hunter Patrol Profile, cycling back to the
  // first when we reach the end. Whether we cycle systems forever (singleLoop =
  // false) or return home to restock after each full profile cycle (singleLoop =
  // true) is governed by the hunter.singleLoop setting. These persist for the
  // lifetime of the generator (the routine run).
  let sysIndex = 0;

  while (bot.state === "running") {
    const settings = getHunterSettings(bot.username);
    const profile = getHunterPatrolProfile(bot.username);
    if (!profile || !profile.patrolSystems || profile.patrolSystems.length === 0) {
      ctx.log("error", "creature_farm mode but no Hunter Patrol Profile assigned (set hunter.hunterPatrols + hunter.botHunterPatrolAssignments). Waiting 60s...");
      await ctx.sleep(60000);
      continue;
    }

    let effectiveSystems = profile.patrolSystems;
    if (profile.creatureFarmCenterSystem && profile.creatureFarmPatrolRadius) {
      const centerId = resolveSystemId(profile.creatureFarmCenterSystem);
      if (centerId) {
        const radiusSystems = findSystemsWithinRadius(centerId, profile.creatureFarmPatrolRadius);
        if (radiusSystems.length > 0) {
          for (let i = radiusSystems.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [radiusSystems[i], radiusSystems[j]] = [radiusSystems[j], radiusSystems[i]];
          }
          effectiveSystems = radiusSystems;
          ctx.log("info", `Creature farm radius mode: ${effectiveSystems.length} systems within ${profile.creatureFarmPatrolRadius} jumps of ${centerId}`);
        } else {
          ctx.log("warn", `No systems found within ${profile.creatureFarmPatrolRadius} jumps of ${centerId} — falling back to profile patrolSystems`);
        }
      } else {
        ctx.log("warn", `Could not resolve creature farm center system ${profile.creatureFarmCenterSystem} — falling back to profile patrolSystems`);
      }
    }

    // Re-clamp the index if the assigned profile changed underneath us.
    if (sysIndex >= effectiveSystems.length) sysIndex = 0;

    const homeSystem = settings.homeSystem || "";
    const homeStation = settings.homeStation || "";
    const targetSystem = effectiveSystems[sysIndex];
    const targetPois = profile.targetPois || [];
    // `loopsPerSystem` is the number of full POI sweeps to perform in this system
    // before advancing to the next profile system. This is the "loops" setting
    // the user configures (creatureFarmLoopsPerSystem); it drives the inner
    // sweep loop directly. `maxSweeps` is a hidden, non-UI safety ceiling so the
    // loop can never run away even if a bad loopsPerSystem value is supplied.
    const loopsPerSystem = settings.creatureFarmLoopsPerSystem > 0 ? settings.creatureFarmLoopsPerSystem : 3;
    const cargoFullPct = (settings.creatureFarmCargoFullPct > 0 ? settings.creatureFarmCargoFullPct : 95) / 100;
    const maxPasses = settings.creatureFarmMaxPassesPerPoi > 0 ? settings.creatureFarmMaxPassesPerPoi : 6;
    const maxSweeps = settings.creatureFarmMaxSystemSweeps > 0 ? settings.creatureFarmMaxSystemSweeps : 40;
    const loopCap = Math.min(loopsPerSystem, maxSweeps);

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
    const fueled = await ensureFueledEx(ctx, settings.refuelThreshold, { homeSystem, skipBlacklist: true, skipFleeCheck: true });
    if (fueled !== "fueled") {
      await handleFuelCheckFailure(ctx, settings, fueled);
      continue;
    }

    // ── Hull ──
    await bot.refreshShip();
    const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    if (hullPct <= settings.repairThreshold) {
      ctx.log("system", `Hull at ${hullPct}% — returning home to repair`);
      await returnToCreatureFarmHome(ctx, settings, homeSystem, homeStation);
      justResupplied = true;
      continue;
    }

    // ── Cargo full? ──
    await bot.refreshCargo();
    const cargoPct0 = bot.cargoMax > 0 ? bot.cargo / bot.cargoMax : 0;
    if (cargoPct0 >= cargoFullPct) {
      ctx.log("system", `Cargo ${Math.round(cargoPct0 * 100)}% — returning home to deposit loot + restock ammo`);
      await returnToCreatureFarmHome(ctx, settings, homeSystem, homeStation);
      justResupplied = true;
      continue;
    }

    // ── Ammo ──
    const hasAmmo = await ensureAmmoLoaded(ctx, settings.ammoThreshold, settings.maxReloadAttempts, settings.ammoReloadAbsoluteThreshold, settings.ammoReloadPercentThreshold);
    if (!hasAmmo && !settings.meatShield) {
      ctx.log("combat", "Out of ammo — returning home to restock");
      await returnToCreatureFarmHome(ctx, settings, homeSystem, homeStation);
      justResupplied = true;
      continue;
    }

    // ── Field consumables ──
    // Gated by !justResupplied so a home base that can't fully restock (e.g. no
    // shield charges in faction storage) doesn't trap us in a return-home loop.
    // Only bail to resupply when we are COMPLETELY out of REPAIR KITS (0) — a
    // missing shield charge is a luxury we can farm without, and repair kits are
    // the real life-savers (and almost never used by a healthy routine). Using
    // minRepairKits=1 means `< 1` == `=== 0`; minShieldCharges=0 disables the
    // shield check entirely.
    if (isLowOnFieldConsumables(bot.inventory, 1, 0) && !justResupplied) {
      ctx.log("combat", "Low on repair kits / shield charges — returning home to resupply");
      await returnToCreatureFarmHome(ctx, settings, homeSystem, homeStation);
      justResupplied = true;
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

    // We've left home and are committed to farming. Normally we clear the
    // resupply guard so a genuinely depleted stash triggers a real resupply trip
    // later. BUT if the home base could NOT actually restock us (e.g. no repair
    // kits in faction storage) we are STILL completely out — bailing back would
    // accomplish nothing and just loop forever. In that case keep the guard set
    // so we stay out and farm with what we have. Shield charges are intentionally
    // ignored here (luxury, not a life-saver).
    if (isLowOnFieldConsumables(bot.inventory, 1, 0)) {
      justResupplied = true;
    } else {
      justResupplied = false;
    }

    // ── Farm: sweep the system `loopCap` times (creatureFarmLoopsPerSystem),
    //    re-scanning each POI to catch respawns, then advance to the next
    //    profile system. ──
    let sweeps = 0;
    let cargoFull = false;
    while (bot.state === "running" && sweeps < loopCap && !cargoFull) {
      sweeps++;
      yield "scan_system";
      const { pois } = await getSystemInfo(ctx);
      let patrolPois = pois.filter(p => !isStationPoi(p));
      if (targetPois && targetPois.length > 0) {
        patrolPois = patrolPois.filter(p => targetPois.includes(p.id) || targetPois.includes(p.name));
      }
      if (patrolPois.length === 0) {
        ctx.log("info", "No non-station POIs in target system — waiting 30s");
        await ctx.sleep(30000);
        break;
      }

      ctx.log("info", `Creature farm sweep ${sweeps}/${loopCap} — ${patrolPois.length} POI(s) in ${targetSystem}`);
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
          const creatures = pickCreatureTargets(entities, bot.username, true, settings.maxCreaturesPerScan);
          const pirates = entities.filter(e => isPirateTarget(e, settings.onlyNPCs, settings.maxAttackTier));
          const targets = [...creatures, ...pirates];

          if (targets.length === 0) {
            // POI currently clear — stop re-scanning this POI for now
            break;
          }

          ctx.log("combat", `Found ${pirates.length} pirate(s), ${creatures.length} creature(s) at ${poi.name} (pass ${passes}/${maxPasses})`);

          for (const target of targets) {
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
              if (isLowOnFieldConsumables(bot.inventory, 1, 0) && !justResupplied) {
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

    // ── Routing: advance to the next profile system ──
    // The inner loop above already performed `creatureFarmLoopsPerSystem`
    // (loopCap) sweeps in the current system, so one "loop" of the system is
    // complete. Advance to the next system in the profile, cycling back to the
    // first at the end. We cycle systems forever; when singleLoop is enabled we
    // additionally return home to restock after finishing a full profile cycle
    // (mirrors the patrol_systems Single Loop Mode behaviour).
    const prevSystem = targetSystem;
    const wasLastSystem = (sysIndex + 1) >= effectiveSystems.length;
    sysIndex = (sysIndex + 1) % effectiveSystems.length;
    const nextSystem = effectiveSystems[sysIndex];
    if (nextSystem !== prevSystem) {
      ctx.log("info", `Creature farm: completed ${loopsPerSystem} loop(s) in ${prevSystem} — routing to ${nextSystem} (${sysIndex + 1}/${effectiveSystems.length})`);
    } else {
      ctx.log("debug", `Creature farm: completed ${loopsPerSystem} loop(s) in ${prevSystem} (only system in profile)`);
    }

    if (settings.singleLoop && wasLastSystem) {
      ctx.log("system", "Single loop mode — returning to faction home base for resupply...");
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
    const fueled = await ensureFueledEx(ctx, settings.refuelThreshold, { homeSystem: settings.homeSystem, skipBlacklist: true, skipFleeCheck: true });
    if (fueled !== "fueled") {
      await handleFuelCheckFailure(ctx, settings, fueled);
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
              const scanTargets = [...scanEntities.filter(e => isPirateTarget(e, settings.onlyNPCs, settings.maxAttackTier)), ...pickCreatureTargets(scanEntities, bot.username, settings.huntCreatures, settings.maxCreaturesPerScan)];
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
      const creature_targets = pickCreatureTargets(entities, bot.username, settings.huntCreatures, settings.maxCreaturesPerScan);

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
    const fueled = await ensureFueledEx(ctx, settings.refuelThreshold, { homeSystem: settings.homeSystem, skipBlacklist: true, skipFleeCheck: true });
    if (fueled !== "fueled") {
      await handleFuelCheckFailure(ctx, settings, fueled);
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
              const scanTargets = [...scanEntities.filter(e => isPirateTarget(e, settings.onlyNPCs, settings.maxAttackTier)), ...pickCreatureTargets(scanEntities, bot.username, settings.huntCreatures, settings.maxCreaturesPerScan)];
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
      const creature_targets = pickCreatureTargets(entities, bot.username, settings.huntCreatures, settings.maxCreaturesPerScan);

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
    const fueled = await ensureFueledEx(ctx, settings.refuelThreshold, { homeSystem: settings.homeSystem, skipBlacklist: true, skipFleeCheck: true });
    if (fueled !== "fueled") {
      await handleFuelCheckFailure(ctx, settings, fueled);
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
              const scanTargets = [...scanEntities.filter(e => isPirateTarget(e, settings.onlyNPCs, settings.maxAttackTier) && !isStationEntity(e)), ...pickCreatureTargets(scanEntities, bot.username, settings.huntCreatures, settings.maxCreaturesPerScan)];
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
      const creature_targets = pickCreatureTargets(entities, bot.username, settings.huntCreatures, settings.maxCreaturesPerScan);
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

// ── PVP Routine ─────────────────────────────────────────────
//
// Player-vs-Player hunter. It does NOT patrol or roam: it camps a single system
// POI and never moves (no navigation, no travel, no flee). Every tick it sends an
// `attack` command at a configured target player name (global under
// hunter.targetPlayer, overridable per-bot via <bot>.targetPlayer). If a battle is
// live it keeps fire stance + re-targets the player each tick. Ammo is reloaded and
// field repair kits are used in place, but the ship never leaves its POI.
//
// The target player must be physically present at the same POI for the attack to
// land; if they are not, the attack just fails and is re-issued next tick (this is
// the intended "always attacking" behaviour).

async function* pvpRoutine(ctx: RoutineContext): AsyncGenerator<string, void, void> {
  const { bot } = ctx;

  await bot.refreshLocation();

  // Camp wherever we already are. We must be at a POI (not docked, in open space)
  // for the attack command to reach a nearby player.
  const originalSystem = bot.system;
  const originalPoi = bot.poi;

  if (bot.docked) {
    ctx.log("error", "PVP mode cannot camp while docked — undock first (start the routine undocked at the target POI).");
    return;
  }
  if (!originalPoi) {
    ctx.log("error", "PVP mode requires a current POI (be in a system POI, not a station). Cannot start.");
    return;
  }

  ctx.log("info", `PVP mode: camping ${originalPoi} (${originalSystem}) — will attack the configured target player every tick (no movement).`);

  // Tick cadence for re-issuing the attack command.
  const TICK_MS = 3000;

  while (bot.state === "running") {
    const settings = getHunterSettings(bot.username);
    const targetPlayer = (settings.targetPlayer || "").trim();

    if (!targetPlayer) {
      ctx.log("error", "PVP mode has no target player set (Settings ▸ Hunter ▸ PVP Target Player). Standing by...");
      await ctx.sleep(10000);
      continue;
    }

    // ── Death recovery ──
    const death = await handleDeath(ctx, settings);
    if (death === "stop") return;
    if (death === "wait") continue;

    // ── Status ──
    yield "get_status";
    await bot.refreshLocation();
    await bot.refreshShip();
    logStatus(ctx);

    // ── Ammo reload (in place, no travel) ──
    await ensureAmmoLoaded(ctx, settings.ammoThreshold, settings.maxReloadAttempts, settings.ammoReloadAbsoluteThreshold, settings.ammoReloadPercentThreshold);

    // ── Find the target player in our POI ──
    yield "scan_for_targets";
    let targetEntity: NearbyEntity | null = null;
    const nearbyResp = await bot.exec("get_nearby");
    if (!nearbyResp.error && nearbyResp.result) {
      bot.trackNearbyPlayers(nearbyResp.result);
      const entities = parseNearby(nearbyResp.result);
      const needle = targetPlayer.toLowerCase();
      targetEntity = entities.find(
        e =>
          e.name.toLowerCase() === needle ||
          e.id.toLowerCase() === needle,
      ) || null;
    }

    // ── Send an attack command every tick ──
    const targetId = targetEntity ? targetEntity.id : targetPlayer;
    const atk = await bot.exec("attack", { target_id: targetId });
    if (atk.error) {
      const msg = atk.error.message.toLowerCase();
      if (msg.includes("not found") || msg.includes("invalid") || msg.includes("not in") || msg.includes("no target")) {
        // Fall back to the player name, then just report (we re-issue next tick).
        const atk2 = await bot.exec("attack", { target_id: targetPlayer });
        if (atk2.error) {
          ctx.log("combat", `⚔️ ${targetPlayer} not attackable at ${originalPoi} (${atk2.error.message}) — re-issuing next tick`);
        } else {
          ctx.log("combat", `⚔️ Attack command sent to ${targetPlayer} (name fallback)`);
        }
      } else {
        ctx.log("combat", `⚔️ Attack on ${targetPlayer}: ${atk.error.message}`);
      }
    } else {
      ctx.log("combat", `⚔️ Attack command sent to ${targetPlayer}${targetEntity ? "" : " (not in range — re-issued next tick)"}`);
    }

    // ── If a battle is live, hold fire stance and keep targeting the player ──
    const battleStatus = await getBattleStatus(ctx);
    if (battleStatus) {
      const targetId2 = targetEntity ? targetEntity.id : targetPlayer;
      const tResp = await bot.exec("battle", { action: "target", target_id: targetId2 });
      if (tResp.error && !tResp.error.message.toLowerCase().includes("already")) {
        await bot.exec("battle", { action: "target", target_id: targetPlayer });
      }
      await bot.exec("battle", { action: "stance", stance: "fire" });
    }

    // ── Field repair (in place) ──
    await useRepairKits(ctx);

    // ── Stay put: re-assert our camp position if we somehow drifted POIs ──
    if (bot.poi && bot.poi !== originalPoi) {
      ctx.log("travel", `PVP: re-asserting camp POI ${originalPoi} (no movement otherwise)`);
      const travelResp = await bot.exec("travel", { target_poi: originalPoi });
      if (!travelResp.error || (travelResp.error.message || "").toLowerCase().includes("already")) {
        bot.poi = originalPoi;
      }
    }

    await ctx.sleep(TICK_MS);
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

  const enemy = (bot.currentBattle.participants ?? []).find((p: any) => p.side_id !== analysis.sideId && !p.is_destroyed && !isBrandedCreature(p.username || ""));
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

// ── Fleet Mode Routine ────────────────────────────────────────
//
// "Wingman" sub-routine for a hunter flying in an in-game fleet.
//
// The problem it solves: when the fleet leader opens fire, the server pulls the
// fleet members into the battle but does NOT give them a target. Without an
// explicit order the bot just sits in the battle doing nothing (soaking damage)
// while the leader fights alone.
//
// Fleet mode does NOTHING until it detects it has joined a battle:
//
//   1. Standby   — no scanning, no patrolling, no navigation, no dock/undock.
//                  Detection is free: spacemolt-lib push events flip
//                  bot.isInBattle() the instant a battle we are in starts. A slow
//                  get_battle_status poll runs as a fallback in case a push is
//                  missed (benign "not in battle" errors are not logged).
//   2. Wake up   — undock if docked (a docked ship cannot fight), uncloak, pick
//                  the enemy (whoever is shooting at us first, then whatever the
//                  fleet leader is shooting at, then the focus-fired target),
//                  attack it, advance to engaged range and fight it out via the
//                  standard hunter combat loop (fightJoinedBattle).
//   3. Stand down — loot wrecks, top up shields, use repair kits, reload ammo,
//                  then go straight back to standby. It never travels on its own:
//                  fleet movement stays the leader's job (fleet jump/dock/undock).
//
// Everything else (flee threshold, in-combat repair kits/shield charges, salvage,
// death handling) reuses the normal hunter settings.

/** Battle snapshot shape returned by common.getBattleStatus. */
type FleetBattleSnapshot = NonNullable<Awaited<ReturnType<typeof getBattleStatus>>>;

/** Refresh the dashboard status line this often while standing by. */
const FLEET_STANDBY_STATUS_REFRESH_MS = 60 * 1000;

/** How often standby checks for death (a death can only happen in a battle). */
const FLEET_DEATH_CHECK_MS = 30 * 1000;

/**
 * Battle probe that does NOT depend on push state.
 *
 * `getBattleStatus` short-circuits to null for library-backed bots whenever
 * `isInBattle()` is false, which is exactly the case we must double-check in
 * fleet mode (a missed battle_started push would otherwise leave the bot asleep
 * inside a live fight). So we hit the API directly. A "not in battle" response is
 * a benign, unlogged error (see Bot.libExec), so this is safe to poll.
 */
async function probeFleetBattle(ctx: RoutineContext): Promise<FleetBattleSnapshot | null> {
  const { bot } = ctx;
  const resp = await bot.exec("get_battle_status");
  if (resp.error || !resp.result) return null;

  const result = resp.result as Record<string, unknown>;
  const innerErr = result.error as Record<string, unknown> | undefined;
  if (innerErr && innerErr.code === "not_in_battle") return null;

  const battleId = (result.battle_id as string) || "";
  if (!battleId) return null;

  return {
    battle_id: battleId,
    tick: (result.tick as number) ?? undefined,
    system_id: (result.system_id as string) || undefined,
    sides: (result.sides as FleetBattleSnapshot["sides"]) || [],
    participants: (result.participants as FleetBattleSnapshot["participants"]) || [],
    your_side_id: (result.your_side_id as number) ?? undefined,
    your_zone: result.your_zone as FleetBattleSnapshot["your_zone"],
    your_stance: result.your_stance as FleetBattleSnapshot["your_stance"],
    your_target_id: (result.your_target_id as string) || undefined,
    auto_pilot: (result.auto_pilot as boolean) ?? undefined,
    // Kept as undefined when the server omits it so we can tell "not our battle"
    // (false) apart from "the server didn't say" (absent).
    is_participant: (result.is_participant as boolean | undefined),
  };
}

/** Keep bot.currentBattle in sync with what the API just told us. */
function syncFleetBattleState(bot: Bot, status: FleetBattleSnapshot | null): void {
  if (status) {
    bot.currentBattle.inBattle = true;
    bot.currentBattle.battleId = status.battle_id;
    if (status.participants?.length) {
      bot.currentBattle.participants = status.participants as unknown as Array<Record<string, unknown>>;
    }
    bot.currentBattle.lastUpdate = Date.now();
    return;
  }
  if (bot.currentBattle.inBattle) {
    bot.clearBattleState("fleet mode probe: API reports no active battle");
  }
}

/**
 * True when this battle is actually ours to fight (not just a battle we can see).
 *
 * `pushDetected` is bot.isInBattle() from BEFORE the probe: the lib only pushes
 * battle_started/update/damage for battles we are involved in, so it is a valid
 * last-resort signal when the API response omits the participation fields. The
 * one push that can fire for someone else's fight is battle_alert (a raid on the
 * station we are docked at) — and that case is caught by an explicit
 * `is_participant: false` from the API.
 */
function isFleetBattleParticipant(
  status: FleetBattleSnapshot,
  username: string,
  pushDetected: boolean,
): boolean {
  if (status.is_participant === true) return true;
  if (status.is_participant === false) return false;
  if (status.your_side_id !== undefined && status.your_side_id !== null) return true;
  const lower = (username || "").toLowerCase();
  if (lower && (status.participants || []).some(p => (p.username || "").toLowerCase() === lower)) {
    return true;
  }
  return pushDetected;
}

interface FleetRoster {
  /** Lowercased usernames of every fleet member (including us). */
  members: Set<string>;
  leader: string;
  inFleet: boolean;
}

/** Read the in-game fleet roster so we can tell friend from foe in a battle. */
async function getFleetRoster(ctx: RoutineContext): Promise<FleetRoster> {
  const me = (ctx.bot.username || "").toLowerCase();
  const empty: FleetRoster = { members: new Set(me ? [me] : []), leader: "", inFleet: false };
  try {
    const status = await fleetStatus(ctx);
    if (!status || !status.in_fleet) return empty;
    const members = new Set<string>(me ? [me] : []);
    for (const m of status.members || []) {
      const name = (m.username || "").toLowerCase();
      if (name) members.add(name);
    }
    const leader = status.leader || (status.members || []).find(m => m.is_leader)?.username || "";
    return { members, leader, inFleet: true };
  } catch {
    return empty;
  }
}

/** Our own side in this battle (API value first, then roster inference). */
function resolveFleetBattleSide(
  status: FleetBattleSnapshot,
  username: string,
  roster: FleetRoster,
): number | undefined {
  if (status.your_side_id !== undefined && status.your_side_id !== null) return status.your_side_id;

  const lower = (username || "").toLowerCase();
  const mine = (status.participants || []).find(p => (p.username || "").toLowerCase() === lower);
  if (mine) return mine.side_id;

  // Not listed (the server sometimes trims the roster) — fall back to whichever
  // side a fleet-mate is on. That is the side the leader is fighting for.
  const mate = (status.participants || []).find(p => roster.members.has((p.username || "").toLowerCase()));
  return mate?.side_id;
}

/**
 * Choose who to shoot in a fleet battle, in priority order:
 *   1. Whoever is currently targeting US (the attacker).
 *   2. Whatever the fleet leader is shooting at (follow the leader's call).
 *   3. The enemy our side is focus-firing (most friendly targets pointed at it).
 *   4. The weakest remaining enemy, to finish it off.
 */
function pickFleetBattleEnemy(
  status: FleetBattleSnapshot,
  ourSideId: number | undefined,
  ourIds: string[],
  roster: FleetRoster,
): { id: string; name: string; reason: string } | null {
  const participants = status.participants || [];

  // Friendly = a fleet-mate, or anyone sharing a side with us or a fleet-mate.
  // Allies who joined the same side (police, faction-mates) must never be shot at.
  const friendlySides = new Set<number>();
  if (ourSideId !== undefined) friendlySides.add(ourSideId);
  for (const p of participants) {
    if (roster.members.has((p.username || "").toLowerCase()) && typeof p.side_id === "number") {
      friendlySides.add(p.side_id);
    }
  }
  const isFriendly = (p: FleetBattleSnapshot["participants"][number]): boolean => {
    if (roster.members.has((p.username || "").toLowerCase())) return true;
    return typeof p.side_id === "number" && friendlySides.has(p.side_id);
  };

  const enemies = participants.filter(p => !p.is_destroyed && (p.player_id || p.username) && !isFriendly(p));
  if (enemies.length === 0) return null;

  const asTarget = (p: FleetBattleSnapshot["participants"][number], reason: string) => ({
    id: p.player_id || p.username || "",
    name: p.username || p.player_id || "enemy",
    reason,
  });
  const matches = (p: FleetBattleSnapshot["participants"][number], id: string | undefined): boolean =>
    !!id && (p.player_id === id || p.username === id);

  // 1. The attacker: an enemy whose target is us.
  const ourIdSet = new Set(ourIds.filter(Boolean));
  if (ourIdSet.size > 0) {
    const onUs = enemies.find(p => p.target_id && ourIdSet.has(p.target_id));
    if (onUs) return asTarget(onUs, "attacking us");
  }

  // With no side information at all we cannot prove who is hostile, so only the
  // "attacking us" case above is safe. Bail out and let fightJoinedBattle
  // re-acquire a hostile from the nearby scan instead of risking friendly fire.
  if (friendlySides.size === 0) return null;

  // 2. The leader's target.
  const leaderLower = (roster.leader || "").toLowerCase();
  const leader = leaderLower
    ? participants.find(p => (p.username || "").toLowerCase() === leaderLower)
    : undefined;
  if (leader?.target_id) {
    const leaderTarget = enemies.find(p => matches(p, leader.target_id));
    if (leaderTarget) return asTarget(leaderTarget, `fleet leader ${leader.username} is on it`);
  }

  // 3. Focus fire with whoever is already shooting.
  const targetCounts = new Map<string, number>();
  for (const p of participants) {
    if (!isFriendly(p) || !p.target_id) continue;
    targetCounts.set(p.target_id, (targetCounts.get(p.target_id) ?? 0) + 1);
  }
  let focused: FleetBattleSnapshot["participants"][number] | null = null;
  let focusedCount = 0;
  for (const e of enemies) {
    const count = Math.max(
      e.player_id ? targetCounts.get(e.player_id) ?? 0 : 0,
      e.username ? targetCounts.get(e.username) ?? 0 : 0,
    );
    if (count > focusedCount) {
      focusedCount = count;
      focused = e;
    }
  }
  if (focused) return asTarget(focused, `focus fire (${focusedCount} ally target${focusedCount === 1 ? "" : "s"})`);

  // 4. Weakest enemy.
  const hullOf = (p: FleetBattleSnapshot["participants"][number]): number =>
    p.hull_pct ?? p.hull_percent ?? 100;
  const weakest = [...enemies].sort((a, b) => hullOf(a) - hullOf(b))[0];
  return asTarget(weakest ?? enemies[0], "weakest hostile on the other side");
}

/**
 * Wake up and fight the battle the fleet dragged us into.
 * Returns true if the battle ended in our favour (or simply ended).
 */
async function fleetModeFight(
  ctx: RoutineContext,
  settings: ReturnType<typeof getHunterSettings>,
  status: FleetBattleSnapshot,
): Promise<boolean> {
  const { bot } = ctx;

  // A docked ship cannot participate in a battle.
  if (bot.docked) {
    if (!settings.fleetUndockToFight) {
      ctx.log("combat", "In a fleet battle while docked, but fleetUndockToFight is disabled — holding at the station");
      return false;
    }
    ctx.log("combat", "Fleet battle started while docked — undocking to fight!");
    const undockResp = await bot.exec("undock");
    const undockMsg = (undockResp.error?.message || "").toLowerCase();
    if (undockResp.error && !undockMsg.includes("already") && !undockMsg.includes("not docked")) {
      ctx.log("error", `Failed to undock for the fleet battle: ${undockResp.error.message}`);
      return false;
    }
    bot.docked = false;
  }

  // Guns don't fire through a cloak. fightJoinedBattle re-cloaks after the fight
  // when cloakOnStart is enabled.
  if (bot.isCloaked) {
    const uncloakResp = await bot.exec("cloak", { enable: false });
    if (!uncloakResp.error) ctx.log("combat", "Uncloaked to join the fleet's battle");
  }

  const roster = await getFleetRoster(ctx);
  const ourSideId = resolveFleetBattleSide(status, bot.username, roster);
  const ourParticipant = (status.participants || [])
    .find(p => (p.username || "").toLowerCase() === (bot.username || "").toLowerCase());

  const enemy = pickFleetBattleEnemy(status, ourSideId, [ourParticipant?.player_id || "", bot.username], roster);
  if (enemy) {
    ctx.log("combat", `🎯 Fleet target: ${enemy.name} (${enemy.reason})${ourSideId !== undefined ? ` | our side ${ourSideId}` : ""}`);
  } else {
    ctx.log("combat", "No hostile listed in the battle roster — fightJoinedBattle will re-acquire the attacker from a nearby scan");
  }

  // Top off the magazines from cargo before shooting. Unlike patrol modes we never
  // abandon the fleet over ammo — we are already in the fight.
  const hasAmmo = await ensureAmmoLoaded(
    ctx,
    settings.ammoThreshold,
    settings.maxReloadAttempts,
    settings.ammoReloadAbsoluteThreshold,
    settings.ammoReloadPercentThreshold,
  );
  if (!hasAmmo) {
    ctx.log("combat", "⚠️ No ammo loaded for this fleet battle — fighting anyway (fleet mode never abandons the fleet mid-battle)");
  }

  return await fightJoinedBattle(
    ctx,
    enemy ? ({ id: enemy.id, name: enemy.name } as NearbyEntity) : null,
    settings.fleeThreshold,
    settings.fleeFromTier,
    settings.maxAttackTier,
    settings.repairThreshold,
    true,                               // canFlee — bail out when hull hits fleeThreshold
    settings.shieldRechargePct ?? 80,   // percentage; fightJoinedBattle divides by 100
    !settings.fleetFightPlayers,        // onlyNPCs — the leader picked the target, so default off
    settings.cloakOnStart,
  );
}

async function* fleetModeRoutine(ctx: RoutineContext): AsyncGenerator<string, void, void> {
  const { bot } = ctx;

  await bot.refreshLocation();

  const roster = await getFleetRoster(ctx);
  if (roster.inFleet) {
    ctx.log("info", `Fleet mode: in fleet (leader ${roster.leader || "unknown"}, ${roster.members.size} member(s)).`);
  } else {
    ctx.log("warn", "Fleet mode: not currently in a fleet — standing by anyway; the bot still reacts to any battle it gets pulled into.");
  }
  ctx.log(
    "info",
    `Fleet mode: standby at ${bot.poi || "(no POI)"} in ${bot.system || "(unknown system)"} — doing nothing until a battle starts, then engaging the fleet's target.`,
  );

  let battleCount = 0;
  let lastProbe = 0;
  let lastStatusRefresh = Date.now();
  let lastDeathCheck = Date.now();
  let standbyLogged = true;
  let ignoredBattleId = "";
  let consecutiveReengages = 0;

  while (bot.state === "running") {
    const settings = getHunterSettings(bot.username);
    const idleMs = Math.max(1000, (settings.fleetIdlePollSeconds || 2) * 1000);
    const confirmSeconds = settings.fleetBattleConfirmSeconds ?? 10;
    const confirmMs = confirmSeconds > 0 ? Math.max(5000, confirmSeconds * 1000) : 0;

    // ── Death recovery (respects stopOnDeath) ──
    // Throttled: standby must stay quiet on the wire. A death can only happen in
    // a battle, and the post-battle path forces a check by clearing lastDeathCheck.
    if (Date.now() - lastDeathCheck >= FLEET_DEATH_CHECK_MS) {
      lastDeathCheck = Date.now();
      const death = await handleDeath(ctx, settings);
      if (death === "stop") return;
      if (death === "wait") continue;
    }

    // ── Detect: push flag first (free), slow API probe as missed-push insurance ──
    const pushDetected = bot.isInBattle();
    let status: FleetBattleSnapshot | null = null;
    if (pushDetected) {
      status = await probeFleetBattle(ctx);
      lastProbe = Date.now();
      syncFleetBattleState(bot, status);
    } else if (confirmMs > 0 && Date.now() - lastProbe >= confirmMs) {
      lastProbe = Date.now();
      status = await probeFleetBattle(ctx);
      if (status) {
        ctx.log("combat", "Battle found by fallback poll (no push event arrived) — waking up");
        syncFleetBattleState(bot, status);
      }
    }

    // ── Standby: genuinely do nothing ──
    if (!status || !isFleetBattleParticipant(status, bot.username, pushDetected)) {
      if (status && ignoredBattleId !== status.battle_id) {
        ignoredBattleId = status.battle_id;
        ctx.log("combat", `Battle ${status.battle_id} visible but we are not a participant — staying on standby.`);
      }
      if (!standbyLogged) {
        ctx.log("info", "Fleet mode: standby — waiting for the fleet's next fight.");
        standbyLogged = true;
      }
      if (Date.now() - lastStatusRefresh >= FLEET_STANDBY_STATUS_REFRESH_MS) {
        lastStatusRefresh = Date.now();
        yield "get_status";
        await bot.refreshStatus();
        logStatus(ctx);
      }
      yield "waiting";
      await ctx.sleep(idleMs);
      continue;
    }

    // ── Wake up and fight ──
    battleCount++;
    standbyLogged = false;
    ignoredBattleId = "";
    ctx.log("combat", `⚔️ Fleet mode wake-up: joined battle ${status.battle_id} (fleet battle #${battleCount}) — engaging!`);

    yield "engage";
    const won = await fleetModeFight(ctx, settings, status);

    // ── Stand down ──
    // Force a death check on the next iteration: this is the only place a fleet
    // wingman can actually die.
    lastDeathCheck = 0;
    await ctx.sleep(1000);
    const after = await probeFleetBattle(ctx);
    lastProbe = Date.now();
    syncFleetBattleState(bot, after);
    if (after && isFleetBattleParticipant(after, bot.username, bot.isInBattle())) {
      // Still in it: either the fight is genuinely ongoing or we could not act
      // (e.g. the server refused the undock). Back off progressively so a stuck
      // battle can never turn into a hot loop of engage attempts.
      consecutiveReengages++;
      const backoffMs = Math.min(30000, 3000 * consecutiveReengages);
      ctx.log("combat", `Battle ${after.battle_id} still active after the combat loop — re-engaging in ${Math.round(backoffMs / 1000)}s.`);
      await ctx.sleep(backoffMs);
      continue;
    }
    consecutiveReengages = 0;

    if (bot.hull <= 0 || bot.isDead) {
      // Dead — let the throttled death handler take over on the next iteration
      // instead of trying to loot/reload a destroyed ship.
      continue;
    }

    ctx.log(
      "combat",
      won
        ? `✅ Fleet battle #${battleCount} over — standing down.`
        : `Fleet battle #${battleCount} ended (retreated or disengaged) — standing down.`,
    );

    if (!settings.disableWreckSalvaging && !bot.docked) {
      yield "loot";
      await scavengeWrecks(ctx);
    }
    await topUpShields(ctx, (settings.shieldRechargePct ?? 80) / 100);
    await useRepairKits(ctx);
    await ensureAmmoLoaded(
      ctx,
      settings.ammoThreshold,
      settings.maxReloadAttempts,
      settings.ammoReloadAbsoluteThreshold,
      settings.ammoReloadPercentThreshold,
    );
    await bot.refreshShip();
    ctx.log(
      "info",
      `Fleet mode: back on standby — hull ${bot.hull}/${bot.maxHull} | shields ${bot.shield}/${bot.maxShield} | ammo ${bot.ammo}`,
    );
    lastStatusRefresh = Date.now();
    standbyLogged = true;
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
        const creature_targets = pickCreatureTargets(entities, bot.username, settings.huntCreatures, settings.maxCreaturesPerScan);
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

  // Refresh the in-memory inventory so the freshly withdrawn repair kits /
  // shield charges / fuel cells are reflected. Without this, isLowOnFieldConsumables
  // keeps reading the pre-resupply (often 0) counts and re-triggers a return-home.
  await bot.refreshCargo();
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
        const creature_targets = pickCreatureTargets(entities, bot.username, settings.huntCreatures, settings.maxCreaturesPerScan);
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
        const creature_targets = pickCreatureTargets(entities, bot.username, currentSettings.huntCreatures, currentSettings.maxCreaturesPerScan);
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
    }
  }
}
// ── Boarding Subroutine ──────────────────────────────────────────
//
// Called from a hunter combat flow when boarding is enabled and the target's
// shields have dropped below boardingShieldThreshold. The subroutine:
//   1. Suppresses shields with fire stance until below threshold.
//   2. Issues `battle target` + `battle stance board` (V1: stance="board",
//      target_id, marines) to initiate the boarding operation.
//   3. Monitors the `boarding` array in get_battle_status until the operation
//      completes (phase = "victory" or "defeat" or "withdrawn") or the battle
//      ends.
//   4. Returns true if the boarding was successful, false otherwise.
//
// The boarding stance is persistent: once issued it stays active for multiple
// ticks (auto-closes to point-blank range). The bot does not fire normal weapons
// while boarding. Friendly fire can still destroy the target and kill the
// marines, so the subroutine keeps an eye on hull and bails to fire/brace if
// things go badly.

const BOARD_MAX_TICKS = 90;
const BOARD_TICK_MS = 10000;

/**
 * Get the number of fit marines aboard the bot's ship.
 * Calls get_ship to refresh personnel data.
 */
async function getFitMarineCount(ctx: RoutineContext): Promise<number> {
  await ctx.bot.refreshShip();
  return ctx.bot.fitMarines;
}

/**
 * Check if the bot's ship has boarding capability.
 */
async function checkBoardingCapability(ctx: RoutineContext): Promise<boolean> {
  await ctx.bot.refreshShip();
  return ctx.bot.hasBoardingCapability;
}

/**
 * Returns info about the bot's installed boarding clamp module.
 * Detects "boarding_clamp" (latch strength 8) and "assault_boarding_lock"
 * (latch strength 18). When latch strength > 0, the bot can attempt
 * boarding; higher latch strength enables more aggressive damage
 * before the target becomes unsalvageable.
 */
interface BoardingClampInfo {
  /** True if any boarding clamp module is installed. */
  hasClamp: boolean;
  /** Latch strength of the installed module (8 for Boarding Clamp, 18 for Assault Boarding Lock). 0 if none. */
  latchStrength: number;
  /** Human-readable module name. */
  moduleName: string | null;
  /** Whether the assault (advanced) version is installed. */
  isAssaultLock: boolean;
}

function getBoardingClampInfo(bot: Bot): BoardingClampInfo {
  const mods = bot.installedMods;
  const latchStrength = bot.boardingClampLatchStrength;
  if (latchStrength > 0) {
    const isAssault = latchStrength >= 15;
    return {
      hasClamp: true,
      latchStrength,
      moduleName: isAssault ? "Assault Boarding Lock" : "Boarding Clamp",
      isAssaultLock: isAssault,
    };
  }
  return {
    hasClamp: false,
    latchStrength: 0,
    moduleName: null,
    isAssaultLock: false,
  };
}

/**
 * Resolve how many marines to commit to the boarding stance.
 * boardingMarines=0 means "all fit marines on board".
 */
function resolveMarineCommitment(fitMarines: number, configured: number): number {
  if (configured > 0) {
    return Math.min(configured, fitMarines);
  }
  return fitMarines;
}

/**
 * Find the target participant in the battle and return its shield percentage.
 */
function getTargetShieldPct(
  status: NonNullable<Awaited<ReturnType<typeof getBattleStatus>>>,
  targetId: string,
  targetName?: string,
): number | null {
  const participant = status.participants.find(
    p => p.player_id === targetId || p.username === targetId || (targetName ? p.username === targetName : false),
  );
  if (!participant) return null;
  // shield_pct is optional in the API — when omitted, treat as 0 (shields depleted)
  const pct = participant.shield_pct ?? participant.shield_percent ?? 0;
  return pct;
}

/**
 * Check if any boarding operation in the battle status is for our target.
 */
function findBoardingOperation(
  status: NonNullable<Awaited<ReturnType<typeof getBattleStatus>>>,
  targetId: string,
): { operation_id: string; phase: string; progress?: string } | null {
  if (!status.boarding || status.boarding.length === 0) return null;
  const op = status.boarding.find(
    b => b.target_id === targetId || b.attacker_id === status.your_target_id,
  );
  if (!op) {
    // If we can't match by target, but there's a boarding operation where attacker matches our ship
    const ourOp = status.boarding[0];
    return {
      operation_id: ourOp.operation_id,
      phase: ourOp.phase,
      progress: ourOp.progress,
    };
  }
  return {
    operation_id: op.operation_id,
    phase: op.phase,
    progress: op.progress,
  };
}

/**
 * The boarding subroutine: open the battle directly (scan + attack + advance to
 * engaged), suppress shields with fire stance until below threshold, then issue
 * the board stance and monitor the boarding operation to completion.
 *
 * This does NOT call engageTarget — that function runs fightFreshBattle to total
 * destruction, which would prevent boarding. Instead we replicate the battle-opening
 * and zone-closing logic inline, then interpose the boarding stance when shields are
 * low enough.
 *
  * Returns:
  *   "captured" — boarding operation succeeded (target captured)
  *   "target_eliminated" — target was destroyed (before, during, or after boarding)
  *   "failed" — boarding failed, aborted, or timed out; the caller may re-engage normally
  *   "retreat" — hull critical, must flee
  *
  * On "captured", the prize ship may be at the current POI or at the POI where
  * the battle started (battles are system-wide). The caller handles prize recovery.
 */
export async function boardingSubroutine(
  ctx: RoutineContext,
  target: NearbyEntity,
  shieldThreshold: number,
  marinesConfigured: number,
  fleeThreshold: number,
  shieldRechargePct: number,
): Promise<"captured" | "target_eliminated" | "failed" | "retreat"> {
  const { bot } = ctx;
  if (!target.id) {
    ctx.log("combat", "Boarding: no target ID — aborting");
    return "failed";
  }

  // Check boarding capability
  const canBoard = await checkBoardingCapability(ctx);
  if (!canBoard) {
    ctx.log("combat", "Boarding: ship lacks boarding capability — falling back to fire stance");
    return "failed";
  }

  // Detect boarding clamp module for latch strength info
  const clampInfo = getBoardingClampInfo(bot);
  if (clampInfo.hasClamp) {
    ctx.log("combat", `🛸 Boarding: ${clampInfo.moduleName} installed (latch strength: ${clampInfo.latchStrength})`);
  } else {
    ctx.log("combat", "⚠️ Boarding: no boarding clamp module detected — boarding will require extreme precision (shields must be near 0)");
  }

  // Resolve marine commitment
  const fitMarines = await getFitMarineCount(ctx);
  if (fitMarines < 1) {
    ctx.log("combat", "Boarding: no fit marines aboard — cannot board");
    return "failed";
  }
  const marines = resolveMarineCommitment(fitMarines, marinesConfigured);
  ctx.log("combat", `Boarding: ${fitMarines} fit marines aboard, committing ${marines} to board stance (threshold: ${shieldThreshold}%)`);

  // ── Phase 1: Open the battle directly (scan + attack) ──
  ctx.log("combat", `⚔️ Boarding: engaging ${target.name}...`);

  // If already in a battle, skip scan/attack and go straight to advance.
  let battleActive = false;
  const preAttackStatus = await getBattleStatus(ctx);
  if (preAttackStatus) {
    battleActive = true;
    ctx.log("combat", `⚔️ Boarding: already in battle with ${target.name} — closing to engaged`);
  }

  if (!battleActive) {
    // Scan the target to get ship info (non-fatal if it fails)
    let scanResp = await bot.exec("scan", { target_id: target.id });
    if (scanResp.error) {
      const errMsg = scanResp.error.message.toLowerCase();
      if (errMsg.includes("in_battle") || errMsg.includes("in combat")) {
        ctx.log("combat", `⚔️ Scan revealed battle already active with ${target.name} — entering combat directly`);
        battleActive = true;
      } else if (errMsg.includes("invalid_target")) {
        scanResp = await bot.exec("scan", { target_id: target.name });
      }
    }
    if (!scanResp.error && scanResp.result) {
      const s = scanResp.result as Record<string, unknown>;
      const shipType = (s.ship_type as string) || (s.ship as string) || "unknown";
      const faction = (s.faction as string) || target.faction || "unknown";
      ctx.log("combat", `   Scan: ${target.name} — ${shipType} | Faction: ${faction}`);
    }

    if (!battleActive) {
      let attackResp = await bot.exec("attack", { target_id: target.id });
      if (attackResp.error) {
        const msg = attackResp.error.message.toLowerCase();
        if (msg.includes("not found") || msg.includes("invalid") || msg.includes("not in")) {
          ctx.log("combat", `Attack with id failed — trying name "${target.name}"...`);
          attackResp = await bot.exec("attack", { target_id: target.name });
        }
      }
      if (attackResp.error) {
        const msg = attackResp.error.message.toLowerCase();
        if (msg.includes("not found") || msg.includes("invalid") ||
            msg.includes("no target") || msg.includes("already") || msg.includes("not in")) {
          return "failed";
        }
        // Attack error but maybe a battle was started anyway — check
        const postStatus = await getBattleStatus(ctx);
        if (postStatus) {
          battleActive = true;
          ctx.log("combat", `⚔️ Attack errored ("${attackResp.error.message}") but battle is active — entering combat`);
        } else {
          ctx.log("error", `Attack failed on ${target.name}: ${attackResp.error.message}`);
          return "failed";
        }
      } else {
        battleActive = true;
      }
    }
  }

  if (!battleActive) {
    // Verify battle is live
    const checkStatus = await getBattleStatus(ctx);
    if (!checkStatus) {
      ctx.log("combat", "Boarding: no active battle after attack — target may have been eliminated");
      return "target_eliminated";
    }
  }

   // ── Phase 2+3: Suppress shields → close distance → board → monitor ──
   //
   // User's directive: "as soon as the target is ready to board, we just engage
   // boarding stance. it will get us closer and do things for us."
   //
   // So instead of a rigid advance-to-engaged phase followed by a separate
   // shield-check, we run a single unified loop that:
   //   1. Checks if battle/target ended / hull is critical
   //   2. Checks target shield % — if ≤ threshold, brace + board IMMEDIATELY
   //      (the board stance itself closes distance, so zone doesn't matter)
   //   3. If shields still high, use fire to suppress + advance to close range
   //   4. Once boarding starts, monitor the operation to completion
   const zoneDirMap: Record<string, number> = { outer: 0, mid: 1, inner: 2, engaged: 3 };

    let tickCount = 0;
    let boardingActive = false;
    let lastHull = bot.hull;
    let boardStanceIssued = false;

   while (bot.state === "running") {
     tickCount++;
     if (tickCount > BOARD_MAX_TICKS) {
       ctx.log("combat", "Boarding: timeout reached — switching to fire stance to finish");
       await bot.exec("battle", { action: "stance", stance: "fire" });
       return "failed";
     }

        const status = await getBattleStatus(ctx);
        if (!status) {
          if (boardingActive) {
            ctx.log("combat", `✅ Boarding: battle ended during active boarding — polling for captured prize (up to 8 checks, 3s apart)`);
            let foundPrize = false;
            for (let prizeTick = 0; prizeTick < 8; prizeTick++) {
              await ctx.sleep(3000);
              const nearbyResult = await getObservationOrNearby(bot);
              const nearbyData = nearbyResult.result;
              const prizes = nearbyData ? getNearbyPrizes(nearbyData) : [];
              const capturedPrize = prizes.find(p => p.status === "available" || p.status === "claimed");
              if (capturedPrize) {
                ctx.log("combat", `✅ Boarding: CAPTURED ${target.name}! (prize found on poll ${prizeTick + 1}: ${capturedPrize.ship_name || capturedPrize.prize_id})`);
                foundPrize = true;
                break;
              }
              ctx.log("combat", `🛸 Prize poll ${prizeTick + 1}/8 — no prize yet, waiting...`);
              
              await bot.refreshStatus();
              const recoveries = bot.prizeRecoveries;
              const activeRecovery = recoveries.find(r => r.status === "in_transit" || r.status === "claimed");
              if (activeRecovery) {
                ctx.log("combat", `✅ Boarding: CAPTURED ${target.name}! (active prize recovery: ${activeRecovery.ship_name || activeRecovery.prize_id})`);
                foundPrize = true;
                break;
              }
            }
            
            if (!foundPrize) {
              ctx.log("combat", `⚠️ Boarding: prize not visible after 8 polls — checking target status`);
              const nearbyResult = await getObservationOrNearby(bot);
              const nearbyData = nearbyResult.result;
              const prizes = nearbyData ? getNearbyPrizes(nearbyData) : [];
              const capturedPrize = prizes.find(p => p.status === "available" || p.status === "claimed");
              if (capturedPrize) {
                ctx.log("combat", `✅ Boarding: CAPTURED ${target.name}! (prize found in final check)`);
                return "captured";
              }
              
              const finalStatus = await getBattleStatus(ctx);
              if (finalStatus) {
                const tp = finalStatus.participants.find(p => p.player_id === target.id || p.username === target.name);
                if (tp && tp.is_destroyed) {
                  ctx.log("combat", `✅ Boarding: battle ended — ${target.name} eliminated!`);
                  return "target_eliminated";
                }
              }
              
              ctx.log("combat", `✅ Boarding: CAPTURED ${target.name}! (boarding was active, assuming capture — prize may still be spawning)`);
              return "captured";
            }
            
            if (foundPrize) {
              return "captured";
            }
          } else {
            ctx.log("combat", `✅ Boarding: battle ended — ${target.name} eliminated!`);
          }
          return "target_eliminated";
        }

     // Check hull
     await bot.refreshShip();
     const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
     const damageThisTick = Math.max(0, lastHull - bot.hull);
     lastHull = bot.hull;

     if (hullPct <= fleeThreshold) {
       ctx.log("combat", `💀 Boarding: hull critical (${hullPct}%) — FLEEING!`);
       await emergencyFleeSpam(ctx, `hull at ${hullPct}% during boarding`);
       return "retreat";
     }

     // Check if our target is destroyed
     const targetParticipant = status.participants.find(
       p => p.player_id === target.id || p.username === target.name,
     );
     if (targetParticipant && targetParticipant.is_destroyed) {
       ctx.log("combat", `⚠️ Boarding: ${target.name} was destroyed before boarding could complete`);
       return "target_eliminated";
     }

       // ── Phase 3: Shield suppression + boarding ──
       if (!boardingActive) {
         // Check shield percentage — BEFORE zone check.
         // If shields are already at/below threshold, brace + board immediately
         // regardless of our zone. The boarding stance auto-closes distance.
         const shieldPct = getTargetShieldPct(status, target.id, target.name);
         // When no boarding clamp is installed, we must wait until shields are completely
         // depleted (0%) before boarding — otherwise boarding will fail / not be available.
         // With a boarding clamp, the configured shieldThreshold applies normally.
         const effectiveShieldThreshold = clampInfo.hasClamp ? shieldThreshold : 0;

          if (shieldPct !== null && shieldPct <= effectiveShieldThreshold) {
            ctx.log("combat", `🛸 Boarding: ${target.name} shields at ${shieldPct}% (≤ ${effectiveShieldThreshold}%) — initiating board stance with ${marines} marines!`);
            
            const boardResp = await bot.exec("battle", {
              action: "stance",
              stance: "board",
              target_id: target.id,
              marines: marines,
            });
             if (boardResp.error) {
               const msg = boardResp.error.message.toLowerCase();
               if (msg.includes("not in battle") || msg.includes("no active battle")) {
                 ctx.log("combat", "✅ Boarding: battle ended before board stance could be issued");
                 return "target_eliminated";
               }
               const boardRespName = await bot.exec("battle", {
                 action: "stance",
                 stance: "board",
                 target_id: target.name,
                 marines: marines,
               });
               if (boardRespName.error) {
                 const msg2 = boardRespName.error.message.toLowerCase();
                 if (msg2.includes("not in battle") || msg2.includes("no active battle")) {
                   ctx.log("combat", "✅ Boarding: battle ended before board stance could be issued (name)");
                   return "target_eliminated";
                 }
                 if (msg2.includes("already has a boarding stance transition queued this tick") ||
                     msg2.includes("boarding stance transition queued") ||
                     msg2.includes("already")) {
                   ctx.log("combat", "🛸 Boarding: transition already queued — switching to passive monitoring");
                   boardingActive = true;
                   boardStanceIssued = true;
                 } else {
                   ctx.log("combat", `⚠️ Boarding: failed to issue board stance — ${boardRespName.error.message} (${boardResp.error.message}) — switching to fire to finish`);
                   await bot.exec("battle", { action: "stance", stance: "fire" });
                   boardingActive = false;
                 }
               } else {
                 ctx.log("combat", `🛸 Boarding: board stance issued (via name)! Operation beginning.`);
                 boardingActive = true;
                 boardStanceIssued = true;
               }
             } else {
               ctx.log("combat", `🛸 Boarding: board stance issued! Operation beginning.`);
               boardingActive = true;
               boardStanceIssued = true;
             }
         } else {
          // Shields still high — suppress with fire stance.
          // Use fire + advance to close distance and reduce shields.
          // The key: we keep firing ONLY while shields are above threshold.
          // As soon as they drop, the next loop iteration will brace + board.
          const enemyStance = targetParticipant?.stance || "unknown";
          const enemyZone = targetParticipant?.zone || "unknown";
          const ourZone = status.your_zone || "outer";
          ctx.log("combat", `Boarding tick ${tickCount}: Enemy=${enemyStance}/${enemyZone} | Hull=${hullPct}% | Target shields=${shieldPct ?? "unknown"}% (need ≤${effectiveShieldThreshold}%) | Dmg=${damageThisTick}`);

          await bot.exec("battle", { action: "stance", stance: "fire" });
          if (ourZone !== "engaged" && zoneDirMap[ourZone] !== undefined && zoneDirMap[ourZone] < 3) {
            const adv = await bot.exec("battle", { action: "advance" });
            if (adv.error) {
              const amsg = adv.error.message.toLowerCase();
              if (amsg.includes("not in battle") || amsg.includes("no active battle")) {
                ctx.log("combat", "✅ Boarding: battle ended during advance — target eliminated!");
                return "target_eliminated";
              }
              ctx.log("combat", `⚠️ Advance note: ${adv.error.message}`);
            }
          }
          await ctx.sleep(BOARD_TICK_MS);
        }
      } else {
        // Boarding is active — monitor the operation
        if (!boardStanceIssued) {
          ctx.log("combat", `🛸 Boarding: waiting for board stance to activate...`);
          await ctx.sleep(BOARD_TICK_MS);
          continue;
        }
        
      const boardingOp = findBoardingOperation(status, target.id);
      if (boardingOp) {
        ctx.log("combat", `🛸 Boarding: operation ${boardingOp.operation_id} — phase=${boardingOp.phase} progress=${boardingOp.progress ?? "n/a"}`);
        if (boardingOp.phase === "victory") {
          ctx.log("combat", `✅ Boarding: CAPTURED ${target.name}!`);
          
          // Register the captured prize in the tracker for later recovery
          bot.registerCapturedPrize(target.id, target.name, status.battle_id || "");
          
          // Switch to the next closest enemy instead of staying locked on the captured ship
          const closerEnemy = status.participants.find(p => {
            if (p.side_id === status.your_side_id || p.is_destroyed) return false;
            if (p.player_id === target.id || p.username === target.name) return false;
            return true;
          });
          
          if (closerEnemy) {
            const newTargetName = closerEnemy.username || closerEnemy.player_id || "unknown";
            ctx.log("combat", `🎯 Switching to ${newTargetName} after capturing ${target.name}`);
            target = { id: closerEnemy.player_id || closerEnemy.username, name: newTargetName } as any;
            await bot.exec("battle", { action: "target", target_id: target.id });
            await bot.exec("battle", { action: "stance", stance: "fire" });
            boardingActive = false;
            boardStanceIssued = false;
          } else {
            // No more enemies — battle should end soon
            ctx.log("combat", `✅ No more enemies after capturing ${target.name} — awaiting battle end`);
            await bot.exec("battle", { action: "stance", stance: "fire" });
            boardingActive = false;
            boardStanceIssued = false;
            return "captured";
          }
        }
        if (boardingOp.phase === "defeat" || boardingOp.phase === "withdrawn") {
          ctx.log("combat", `Boarding: operation ${boardingOp.phase} — target ${boardingOp.phase === "defeat" ? "resisted" : "withdrawn"}`);
          boardingActive = false;
          boardStanceIssued = false;
        }
      } else {
        // Boarding operation not found in get_battle_status response.
        const ourStanceNow = status.your_stance || "";
        if (ourStanceNow === "board") {
          ctx.log("combat", `🛸 Boarding: operation data not in status yet (stance=board) — continuing to monitor`);
        } else if (boardStanceIssued) {
          ctx.log("combat", `🛸 Boarding: board stance no longer active — waiting to see if operation completed`);
          boardStanceIssued = false;
          boardingActive = false;
        } else {
          const targetStillAlive = targetParticipant && !targetParticipant.is_destroyed;
          if (!targetStillAlive) {
            ctx.log("combat", `✅ Boarding: ${target.name} eliminated during operation`);
            return "target_eliminated";
          }
          const shieldPctNow = getTargetShieldPct(status, target.id, target.name);
          const effectiveShieldThresholdNow = clampInfo.hasClamp ? shieldThreshold : 0;
          if (shieldPctNow !== null && shieldPctNow <= effectiveShieldThresholdNow) {
            ctx.log("combat", `↩️ Boarding: shields still low (${shieldPctNow}% ≤ ${effectiveShieldThresholdNow}%) — re-issuing board stance`);
            const retryBoard = await bot.exec("battle", {
              action: "stance",
              stance: "board",
              target_id: target.id,
              marines: marines,
            });
            if (retryBoard.error) {
              const msg = retryBoard.error.message.toLowerCase();
              if (msg.includes("not in battle") || msg.includes("no active battle")) {
                ctx.log("combat", "✅ Boarding: battle ended during board retry");
                return "target_eliminated";
              }
              if (msg.includes("already") || msg.includes("queued")) {
                ctx.log("combat", `🛸 Boarding: board stance already queued — monitoring without further retries`);
                boardingActive = true;
                boardStanceIssued = true;
              } else {
                ctx.log("combat", `⚠️ Boarding: re-issue board failed — ${retryBoard.error.message}`);
              }
            } else {
              ctx.log("combat", `🛸 Boarding: board stance re-issued! Continuing operation.`);
              boardingActive = true;
              boardStanceIssued = true;
            }
          } else {
            ctx.log("combat", `Boarding: operation ended, shields at ${shieldPctNow ?? "unknown"}% — finishing with fire stance`);
            await bot.exec("battle", { action: "stance", stance: "fire" });
            boardingActive = false;
            boardStanceIssued = false;
          }
        }
      }

      // In-combat repair / shield top-up if needed
      const shieldPct = bot.maxShield > 0 ? Math.round((bot.shield / bot.maxShield) * 100) : 100;
      if (hullPct <= fleeThreshold) {
        ctx.log("combat", `💀 Boarding: hull critical (${hullPct}%) — FLEEING!`);
        await emergencyFleeSpam(ctx, `hull at ${hullPct}% during boarding`);
        return "retreat";
      }
      const shieldTopUpPct = shieldRechargePct / 100;
      if (shieldPct < shieldTopUpPct * 100) {
        await topUpShields(ctx, shieldTopUpPct);
        await useRepairKits(ctx);
      }

      await ctx.sleep(BOARD_TICK_MS);
    }
  }

  return "failed";
}

// ── Prize Recovery ──────────────────────────────────────────────
//
// After a successful boarding capture, the prize ship remains at the current
// POI until claimed. The bot must be at the same POI (out of combat), then
// issue spacemolt_salvage(claim_prize, ...) with a destination station base ID.
// The prize then autonomously travels to the destination and appears in
// get_status().prize_recoveries with status "in_transit".

/**
 * Extract intact prize ships from a get_nearby / observation result.
 * Prizes appear in the `nearby_prizes` array of the get_nearby response.
 */
function getNearbyPrizes(result: unknown): PrizeInfo[] {
  if (!result || typeof result !== "object") return [];
  const r = result as Record<string, unknown>;
  const prizesRaw = r.nearby_prizes as Array<Record<string, unknown>> | undefined;
  if (!prizesRaw || !Array.isArray(prizesRaw)) return [];

  return prizesRaw.map(p => ({
    prize_id: p.prize_id as string,
    actor_id: p.actor_id as string,
    ship_id: p.ship_id as string,
    ship_class: p.ship_class as string,
    ship_name: p.ship_name as string | undefined,
    status: (p.status as PrizeInfo["status"]) || "available",
    hull: p.hull as number,
    max_hull: p.max_hull as number,
    shield: p.shield as number,
    max_shield: p.max_shield as number,
    in_combat: p.in_combat as boolean,
    wait_reason: p.wait_reason as PrizeInfo["wait_reason"] | undefined,
  }));
}

/**
 * Find a station base ID to use as the prize recovery destination.
 * Prefers the bot's configured home station; falls back to the system's
 * first non-pirate station; falls back to any station in the current system.
 */
async function findDestinationBaseId(ctx: RoutineContext, settings: ReturnType<typeof getHunterSettings>): Promise<string | null> {
  const hs = settings.homeStation || "";
  if (hs && hs.includes("|")) {
    const parts = hs.split("|");
    const baseId = parts[1];
    if (baseId) return baseId;
  } else if (hs) {
    return hs;
  }

  // Try the current system's stations
  try {
    const { pois } = await getSystemInfo(ctx);
    if (pois && pois.length > 0) {
      const station = findStation(pois, undefined, true);
      if (station?.base_id) return station.base_id;
    }
  } catch {
    // System info may fail if we're at a station — continue to fallback
  }

  // No suitable destination found
  return null;
}

/**
 * Search all POIs in the current system for a prize matching the given ship_id
 * (if provided), or any available prize. When found, claim it with a destination
 * station.
 *
 * Battles are system-wide, so a captured prize may appear at a different POI
 * than where the bot is currently located.
 */
async function findAndClaimPrizeAcrossSystem(ctx: RoutineContext, settings: ReturnType<typeof getHunterSettings>, knownShipId?: string): Promise<boolean> {
  const { bot } = ctx;
  const destBaseId = await findDestinationBaseId(ctx, settings);
  if (!destBaseId) {
    ctx.log("combat", "FindPrize: no destination station found — cannot claim prize");
    return false;
  }

  const { pois } = await getSystemInfo(ctx);
  if (!pois || pois.length === 0) {
    ctx.log("combat", "FindPrize: no POIs found in current system");
    return false;
  }

  // Exclude stations from the POI search
  const searchPois = pois.filter(p => !isStationPoi(p));
  if (searchPois.length === 0) return false;

  // If we're already at a POI, check it first before traveling
  const currentPoiMatch = searchPois.find(p => p.id === bot.poi || p.name === bot.poi);
  const orderedPois = currentPoiMatch ? [currentPoiMatch, ...searchPois.filter(p => p !== currentPoiMatch)] : searchPois;

  for (const poi of orderedPois) {
    if (bot.state !== "running") return false;

    // Travel to this POI if not already there
    if (bot.poi !== poi.id) {
      ctx.log("travel", `🔍 FindPrize: searching for prize at ${poi.name}...`);
      const travelResp = await bot.exec("travel", { target_poi: poi.id });
      if (travelResp.error && !travelResp.error.message.includes("already")) {
        ctx.log("combat", `FindPrize: could not travel to ${poi.name}: ${travelResp.error.message}`);
        continue;
      }
      await ctx.sleep(2000);
    }

    // Check for prizes at this POI
    const nearbyResult = await getObservationOrNearby(bot);
    const nearbyData = nearbyResult.result;
    if (!nearbyData) continue;

     const prizes = getNearbyPrizes(nearbyData);
     
     // First check for prizes matching our captured prize tracker
     let availablePrize = prizes.find(p => {
       const match = bot.findCapturedPrizeMatch(p);
       return match && (p.status === "available" || p.status === "claimed");
     });
     
     // Fall back to knownShipId match or any available prize
     if (!availablePrize) {
       availablePrize = prizes.find(p =>
         (p.status === "available" || p.status === "claimed") &&
         (!knownShipId || p.ship_id === knownShipId),
       );
     }
     
     // Final fallback: any available prize
     if (!availablePrize) {
       availablePrize = prizes.find(p => p.status === "available" || p.status === "claimed");
     }

      if (availablePrize) {
        ctx.log("combat", `🛸 FindPrize: found prize ${availablePrize.ship_name || availablePrize.prize_id} at ${poi.name}!`);
        
        const trackedMatch = bot.findCapturedPrizeMatch(availablePrize);
        if (trackedMatch) {
          ctx.log("combat", `🛸 FindPrize: matched tracked capture ship_id=${trackedMatch.ship_id}`);
        }

        // NOTE: Cannot refuel before claiming — only the claimant can service a prize,
        // and claiming sends it off immediately. We verify post-claim via get_nearby.

        const claimResp = await bot.exec("claim_prize", {
          id: availablePrize.prize_id,
          target: destBaseId,
          crew_disposition: "aboard",
        });

       if (claimResp.error) {
         const msg = claimResp.error.message.toLowerCase();
         if (msg.includes("no prize") || msg.includes("not found") || msg.includes("invalid")) {
           ctx.log("combat", `FindPrize: prize not claimable (${claimResp.error.message}) — may already be claimed`);
           continue;
         }
         ctx.log("error", `FindPrize: claim failed: ${claimResp.error.message}`);
         continue;
       }

       // VERIFY: Check get_nearby to confirm the prize is now claimed/in_transit
       await ctx.sleep(2000);
       const verifyResult = await getObservationOrNearby(bot);
       const verifyData = verifyResult.result;
       if (verifyData) {
         const verifyPrizes = getNearbyPrizes(verifyData);
         const verifyPrize = verifyPrizes.find(p => p.prize_id === availablePrize.prize_id || p.ship_id === availablePrize.ship_id);
         if (verifyPrize) {
           const newStatus = verifyPrize.status;
           if (newStatus === "claimed" || newStatus === "in_transit") {
             ctx.log("combat", `✅ Prize ${availablePrize.ship_name || availablePrize.prize_id} verified as ${newStatus} via get_nearby!`);
             
             // Update the tracker
             if (verifyPrize.ship_id && verifyPrize.prize_id) {
               const existing = bot.getCapturedPrizeByShipId(verifyPrize.ship_id);
               if (existing) {
                 bot.registerCapturedPrize(verifyPrize.ship_id, verifyPrize.ship_class || existing.ship_class, existing.battle_id, verifyPrize.prize_id);
               }
             }
             
             return true;
           } else if (newStatus === "available") {
             ctx.log("combat", `⚠️ FindPrize: prize still shows as "available" after claim — may have failed silently`);
             continue;
           }
         }
       }

       ctx.log("combat", `✅ Prize ${availablePrize.ship_name || availablePrize.prize_id} claimed (command succeeded, nearby verification inconclusive)`);
       
       // Update the tracker
       if (availablePrize.ship_id && availablePrize.prize_id) {
         const existing = bot.getCapturedPrizeByShipId(availablePrize.ship_id);
         if (existing) {
           bot.registerCapturedPrize(availablePrize.ship_id, availablePrize.ship_class || existing.ship_class, existing.battle_id, availablePrize.prize_id);
         }
       }
       
        return true;
      }
  }

  return false;
}

/**
 * Attempt to claim a prize at the current POI.
 *
 * After a successful boarding, the prize ship should be at the same POI,
 * out of combat. This function finds the prize in nearby_prizes, determines
 * a destination station, and calls claim_prize to send the prize recovering
 * to that station.
 *
 * Returns true if the prize was claimed, false otherwise.
 */
async function claimPrizeAtCurrentPoi(ctx: RoutineContext, settings: ReturnType<typeof getHunterSettings>): Promise<boolean> {
  const { bot } = ctx;

  // Need to be out of combat to claim a prize
  const battle = await getBattleStatus(ctx);
  if (battle) {
    ctx.log("combat", "ClaimPrize: still in battle — cannot claim prize yet");
    return false;
  }

  // Scan nearby for prizes
  const nearbyResult = await getObservationOrNearby(bot);
  const nearbyData = nearbyResult.result;
  if (!nearbyData) {
    ctx.log("combat", "ClaimPrize: no nearby data — cannot check for prizes");
    return false;
  }

  const prizes = getNearbyPrizes(nearbyData);
  
  // First, check if any prize matches our captured prize tracker (by ship_id)
  let availablePrize = prizes.find(p => {
    const match = bot.findCapturedPrizeMatch(p);
    return match && (p.status === "available" || p.status === "claimed");
  });
  
  // If no tracked match, fall back to any available prize
  if (!availablePrize) {
    availablePrize = prizes.find(p => p.status === "available" || p.status === "claimed");
  }
  
  if (!availablePrize) {
    if (prizes.length > 0) {
      ctx.log("combat", `ClaimPrize: found ${prizes.length} prize(s) but none claimable (status: ${prizes.map(p => p.status).join(", ")})`);
    }
    return false;
  }
  
  // Log if this prize matches a tracked capture
  const trackedMatch = bot.findCapturedPrizeMatch(availablePrize);
  if (trackedMatch) {
    ctx.log("combat", `🛸 ClaimPrize: matched tracked capture ship_id=${trackedMatch.ship_id} prize_id=${availablePrize.prize_id}`);
  }

  // Find a destination station
  const destBaseId = findDestinationBaseId(ctx, settings);
  if (!destBaseId) {
    ctx.log("combat", "ClaimPrize: no destination station found to send prize to");
    return false;
  }

  ctx.log("combat", `🛸 Claiming prize ${availablePrize.ship_name || availablePrize.prize_id} → destination: ${destBaseId}`);

  // NOTE: Cannot refuel before claiming — only the claimant can service a prize,
  // and claiming sends it off immediately. We verify post-claim via get_nearby.

  const claimResp = await bot.exec("claim_prize", {
    id: availablePrize.prize_id,
    target: destBaseId,
    crew_disposition: "aboard",
  });

  if (claimResp.error) {
    const msg = claimResp.error.message.toLowerCase();
    if (msg.includes("no prize") || msg.includes("not found") || msg.includes("invalid")) {
      ctx.log("combat", `ClaimPrize: prize not claimable (${claimResp.error.message}) — may already be claimed`);
      return false;
    }
    if (msg.includes("rate limit") || msg.includes("retry")) {
      ctx.log("combat", `ClaimPrize: rate limited — will retry next tick`);
      return false;
    }
    ctx.log("error", `ClaimPrize failed: ${claimResp.error.message}`);
    return false;
  }

  // VERIFY: Check get_nearby to confirm the prize is now claimed/in_transit
  await ctx.sleep(2000);
  const verifyResult = await getObservationOrNearby(bot);
  const verifyData = verifyResult.result;
  if (verifyData) {
    const verifyPrizes = getNearbyPrizes(verifyData);
    const verifyPrize = verifyPrizes.find(p => p.prize_id === availablePrize.prize_id || p.ship_id === availablePrize.ship_id);
    if (verifyPrize) {
      const newStatus = verifyPrize.status;
      if (newStatus === "claimed" || newStatus === "in_transit") {
        ctx.log("combat", `✅ Prize ${availablePrize.ship_name || availablePrize.prize_id} verified as ${newStatus} via get_nearby!`);
        
        // Update the tracker with the confirmed prize_id
        if (verifyPrize.ship_id && verifyPrize.prize_id) {
          const existing = bot.getCapturedPrizeByShipId(verifyPrize.ship_id);
          if (existing) {
            bot.registerCapturedPrize(verifyPrize.ship_id, verifyPrize.ship_class || existing.ship_class, existing.battle_id, verifyPrize.prize_id);
          }
        }
        
        return true;
      } else if (newStatus === "available") {
        ctx.log("combat", `⚠️ ClaimPrize: prize still shows as "available" after claim command — may have failed silently`);
        return false;
      }
    }
  }

  // Fallback: command succeeded but nearby verification inconclusive
  ctx.log("combat", `✅ Prize ${availablePrize.ship_name || availablePrize.prize_id} claimed (command succeeded, nearby verification inconclusive)`);
  
  // Update the tracker with the confirmed prize_id
  if (availablePrize.ship_id && availablePrize.prize_id) {
    const existing = bot.getCapturedPrizeByShipId(availablePrize.ship_id);
    if (existing) {
      bot.registerCapturedPrize(availablePrize.ship_id, availablePrize.ship_class || existing.ship_class, existing.battle_id, availablePrize.prize_id);
    }
  }
  
  return true;
}

/**
 * After a boarding capture, attempt to claim the prize and monitor its
 * recovery state until it reaches a terminal state.
 *
 * Battles are system-wide, so the prize ship may be at a different POI than
 * where the bot is currently located. This function searches all system POIs
 * for the prize if it's not at the current POI.
 *
 * Terminal states: delivered, destroyed, expired, recaptured.
 * Non-terminal states: available, claimed, in_transit.
 *
 * Returns true if the prize was successfully delivered, false otherwise.
 */
async function recoverPrize(ctx: RoutineContext, settings: ReturnType<typeof getHunterSettings>, knownShipId?: string): Promise<boolean> {
  const { bot } = ctx;
  const maxWaitTicks = 30; // ~300 seconds max wait for recovery
  let waitTick = 0;
  let lastStatus = "";

  while (waitTick < maxWaitTicks) {
    waitTick++;

    // Check if we have an active prize recovery
    await bot.refreshStatus();
    const recoveries = bot.prizeRecoveries;

    if (recoveries.length === 0) {
      const claimed = await claimPrizeAtCurrentPoi(ctx, settings);
      if (!claimed) {
        const found = await findAndClaimPrizeAcrossSystem(ctx, settings, knownShipId);
        if (!found) {
          ctx.log("combat", `RecoverPrize: prize not visible yet — will keep polling (tick ${waitTick}/${maxWaitTicks})`);
        }
      }
    } else {
      const recovery = recoveries[0];
      if (recovery) {
        const statusChanged = recovery.status !== lastStatus;
        lastStatus = recovery.status;

        if (statusChanged) {
          ctx.log("combat", `RecoverPrize: status=${recovery.status} fuel=${recovery.fuel}/${recovery.max_fuel} hull=${recovery.hull}/${recovery.max_hull}`);
        }

        if (recovery.status === "delivered") {
          ctx.log("combat", `✅ Prize ${recovery.ship_name || recovery.prize_id} delivered to ${recovery.destination_base_id}!`);
          return true;
        }
        if (recovery.status === "destroyed" || recovery.status === "expired" || recovery.status === "recaptured") {
          ctx.log("combat", `RecoverPrize: prize ${recovery.status} — aborting recovery`);
          return false;
        }
        if (recovery.status === "claimed") {
          ctx.log("combat", `✅ Prize ${recovery.ship_name || recovery.prize_id} claimed and in transit to ${recovery.destination_base_id}!`);
          return true;
        }
        if (recovery.status === "in_transit") {
          if (recovery.wait_reason && statusChanged) {
            ctx.log("combat", `RecoverPrize: prize stalled (${recovery.wait_reason}) — will retry`);
          }
        }
      }
    }

    await ctx.sleep(10000);
  }

  ctx.log("combat", "RecoverPrize: timed out waiting for prize delivery");
  return false;
}

// ── Boarding Routine (patrol mode with boarding) ──────────────────
//
// Similar patrol flow to roam_systems / cycle_patrols, but when boarding is
// enabled and a target's shields drop below the configured threshold, the
// hunter initiates a boarding operation instead of destroying the target.
// Supports multi-system patrol via hunter patrol profiles (hunterPatrols)
// or the legacy single `system` setting.

async function* boardingRoutine(ctx: RoutineContext): AsyncGenerator<string, void, void> {
  const { bot } = ctx;

  await bot.refreshLocation();
  let totalKills = 0;
  let totalBoardings = 0;

  await ensureObservationSubscribed();
  await ensureHunterCoordListener(bot.username);

  const all = readSettings();
  const h = (all.hunter || {}) as any;
  const hunterPatrols: HunterPatrolProfile[] = Array.isArray(h.hunterPatrols) ? h.hunterPatrols : [];

  while (bot.state === "running") {
    const settings = getHunterSettings(bot.username);

    // ── Death recovery ──
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

    // ── Status ──
    yield "get_status";
    await bot.refreshLocation();
    logStatus(ctx);

    // ── Fuel ──
    const fueled = await ensureFueledEx(ctx, settings.refuelThreshold, { homeSystem: settings.homeSystem, skipBlacklist: true, skipFleeCheck: true });
    if (fueled !== "fueled") {
      await handleFuelCheckFailure(ctx, settings, fueled);
      continue;
    }

    // ── Hull ──
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

    // ── Determine systems to patrol ──
    const systemList = resolveBoardingPatrolSystems(ctx.bot.username, hunterPatrols);
    if (systemList.length === 0) {
      ctx.log("error", "Boarding mode: no patrol systems configured — falling back to single system setting");
      yield* boardingSystemPass(ctx, settings, safetyOpts, totalKills, totalBoardings);
      continue;
    }

    // ── Iterate through all systems in the patrol profile ──
    let completedFullCycle = true;
    for (const targetSystem of systemList) {
      if (bot.state !== "running") { completedFullCycle = false; break; }

      if (bot.system !== targetSystem) {
        ctx.log("travel", `Boarding patrol: heading to ${targetSystem}...`);
        const arrived = await navigateToSystem(ctx, targetSystem, safetyOpts);
        if (arrived) {
          await resubscribeObservationAfterMove(bot);
        }
        if (!arrived) {
          const battleAfterNav = await getBattleStatus(ctx);
          if (battleAfterNav) {
            ctx.log("combat", `Battle detected after navigation - hunter fights, not flees!`);
            await handleNavigationBattleInterrupt(ctx, settings);
          } else {
            ctx.log("error", `Could not reach ${targetSystem} — skipping to next`);
            completedFullCycle = false;
            continue;
          }
        }
      }

      if (bot.state !== "running") { completedFullCycle = false; break; }

      // ── Single system patrol pass (POI-by-POI with boarding) ──
      const result = yield* boardingSystemPass(ctx, settings, safetyOpts, totalKills, totalBoardings);
      if (result) {
        const [kills, boardings] = result;
        totalKills = kills;
        totalBoardings = boardings;
      }
    }

    if (!completedFullCycle && bot.state !== "running") break;

    if (completedFullCycle) {
      ctx.log("info", `Boarding patrol cycle complete — ${totalKills} kill(s), ${totalBoardings} boarding(s). Restarting patrol...`);
    }
  }
}

/**
 * Resolve the list of systems to patrol in boarding mode.
 * Prefers the assigned hunter patrol profile's patrolSystems.
 * Returns empty array when no profile is found (caller uses findNearestHuntableSystem fallback).
 */
function resolveBoardingPatrolSystems(
  botUsername: string,
  hunterPatrols: HunterPatrolProfile[],
): string[] {
  if (hunterPatrols.length > 0) {
    const botHunterPatrolAssignments = ((readSettings().hunter || {}) as any)?.botHunterPatrolAssignments as Record<string, string> | undefined;
    const assignedProfileName = botHunterPatrolAssignments?.[botUsername] || botHunterPatrolAssignments?.[""] || hunterPatrols[0]?.name;
    const assignedProfile = hunterPatrols.find(p => p.name === assignedProfileName) || hunterPatrols[0];
    if (assignedProfile?.patrolSystems && assignedProfile.patrolSystems.length > 0) {
      return assignedProfile.patrolSystems;
    }
  }

  // No profile or system found — return empty (caller will use findNearestHuntableSystem fallback)
  return [];
}

/**
 * Perform a single patrol pass through all POIs in the current system,
 * engaging pirates with boarding stance when conditions are met.
 *
 * Returns [totalKills, totalBoardings] if completed, or null if the loop
 * was broken early (e.g. hull critical / out of ammo).
 */
async function* boardingSystemPass(
  ctx: RoutineContext,
  settings: ReturnType<typeof getHunterSettings>,
  safetyOpts: { fuelThresholdPct: number; hullThresholdPct: number; autoCloak: boolean; skipBlacklist: boolean; isCombatBot: boolean; joinBattles: boolean },
  startKills: number,
  startBoardings: number,
): AsyncGenerator<string, [number, number] | null, void> {
  const { bot } = ctx;
  let totalKills = startKills;
  let totalBoardings = startBoardings;

  // ── Confirm we're in a huntable system ──
  await fetchSecurityLevel(ctx, bot.system);
  const currentSec = mapStore.getSystem(bot.system)?.security_level;
  if (!isHuntableSystem(currentSec)) {
    ctx.log("info", `${bot.system} is ${currentSec || "unknown"} security — searching for a huntable system...`);
    const huntTarget = findNearestHuntableSystem(bot.system);
    if (huntTarget) {
      const sys = mapStore.getSystem(huntTarget);
      ctx.log("travel", `Found huntable system: ${sys?.name || huntTarget} (${sys?.security_level}) — navigating...`);
      const huntArrived = await navigateToSystem(ctx, huntTarget, safetyOpts);
      if (!huntArrived) {
        const battleAfterNav = await getBattleStatus(ctx);
        if (battleAfterNav) {
          await handleNavigationBattleInterrupt(ctx, settings);
        }
      }
      await resubscribeObservationAfterMove(bot);
    }
  }

  // ── Get system layout ──
  yield "scan_system";
  await fetchSecurityLevel(ctx, bot.system);
  const { pois } = await getSystemInfo(ctx);
  const patrolPois = pois.filter(p => !isStationPoi(p));

  if (patrolPois.length === 0) {
    ctx.log("info", "No non-station POIs to patrol — waiting 30s");
    await ctx.sleep(30000);
    return [totalKills, totalBoardings];
  }

  ctx.log("info", `Boarding mode: patrolling ${patrolPois.length} POI(s) in ${bot.system}...`);

  for (const poi of patrolPois) {
    if (bot.state !== "running") break;

    await bot.refreshShip();
    const midHull = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    if (midHull <= settings.repairThreshold) {
      ctx.log("system", `Hull at ${midHull}% — aborting patrol`);
      break;
    }

    if (await checkAndHandleExistingBattle(ctx, settings)) continue;

    yield "travel_to_poi";
    ctx.log("travel", `Boarding patrol: ${poi.name}...`);
    const travelResp = await bot.exec("travel", { target_poi: poi.id });
    if (travelResp.error && !travelResp.error.message.includes("already")) {
      ctx.log("error", `Travel to ${poi.name} failed: ${travelResp.error.message}`);
      continue;
    }
    bot.poi = poi.id;
    bot.clearObservationState();
    await ctx.sleep(1000);

    yield "scan_for_targets";
    const nearbyResult = await getObservationOrNearby(bot);
    const nearbyData = nearbyResult.result;
    if (!nearbyData) {
      ctx.log("error", `No nearby data at ${poi.name}`);
      continue;
    }
    bot.trackNearbyPlayers(nearbyData);
    bot.trackWildlife(nearbyData);

    await handleUnexpectedBattle(ctx, settings.maxAttackTier, settings.minPiratesToFlee, settings.fleeThreshold, settings.fleeFromTier, settings.repairThreshold);

    const entities = parseNearby(nearbyData);
    const pirate_targets = entities.filter(e => isPirateTarget(e, settings.onlyNPCs, settings.maxAttackTier) && !isStationEntity(e) && !e.isCreature && !isCreatureName(e.name));

    if (pirate_targets.length === 0) {
      if (!settings.disableWreckSalvaging) await scavengeWrecks(ctx);
      continue;
    }

    // Sort by hull descending — board the largest (most valuable) ships first.
    // Lower-hull pirates can't threaten our shields, while high-hull pirates
    // are worth more and are the priority boarding targets.
    pirate_targets.sort((a, b) => {
      const ah = a.maxHull || a.hull || 0;
      const bh = b.maxHull || b.hull || 0;
      return bh - ah;
    });

    ctx.log("combat", `Found ${pirate_targets.length} boarding candidate(s) at ${poi.name} (sorted by hull: ${pirate_targets.map(p => `${p.name}(${p.maxHull || p.hull || 0})`).join(", ")})`);

    for (let targetIdx = 0; targetIdx < pirate_targets.length; targetIdx++) {
      const target = pirate_targets[targetIdx];
      if (bot.state !== "running") break;

      await bot.refreshShip();
      const preHull = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
      if (preHull <= settings.repairThreshold) {
        ctx.log("system", `Hull at ${preHull}% — too low for another fight`);
        break;
      }

      await useRepairKits(ctx);
      const hasAmmo = await ensureAmmoLoaded(ctx, settings.ammoThreshold, settings.maxReloadAttempts, settings.ammoReloadAbsoluteThreshold, settings.ammoReloadPercentThreshold);
      if (!hasAmmo && !settings.meatShield) {
        ctx.log("combat", "Out of ammo — aborting patrol to resupply");
        break;
      }

      yield "engage";

      const freshScanResp = await bot.exec("get_nearby");
      let freshEntities: NearbyEntity[] = [];
      if (!freshScanResp.error && freshScanResp.result) {
        bot.trackNearbyPlayers(freshScanResp.result);
        bot.trackWildlife(freshScanResp.result);
        freshEntities = parseNearby(freshScanResp.result);
      }
      const stillPresent = freshEntities.find(e => e.id === target.id || e.name === target.name);
      if (!stillPresent) {
        ctx.log("combat", `⚠️ ${target.name} is no longer at this POI (likely claimed or left) — skipping to next target`);
        continue;
      }

      // Check for any available prizes at this POI before engaging
      const preBattlePrizes = getNearbyPrizes(freshScanResp.result);
      const preBattlePrize = preBattlePrizes.find(p => p.status === "available" || p.status === "claimed");
      if (preBattlePrize) {
        ctx.log("combat", `🛸 Found unclaimed prize ${preBattlePrize.ship_name || preBattlePrize.prize_id} at ${poi.name} before engaging ${target.name}`);
        const claimed = await claimPrizeAtCurrentPoi(ctx, settings);
        if (claimed) {
          ctx.log("combat", `🏆 Prize claimed before engaging ${target.name}`);
        }
      }

      // Determine if we should attempt boarding this target
      const canBoard = settings.boardingEnabled
        && settings.boardingShieldThreshold > 0
        && await checkBoardingCapability(ctx);

      if (canBoard) {
        const fitMarines = await getFitMarineCount(ctx);
        if (fitMarines >= 1) {
          ctx.log("combat", `⚔️ Boarding engagement: ${target.name} (shields ≤ ${settings.boardingShieldThreshold}% → board)`);
          const result = await boardingSubroutine(
            ctx,
            target,
            settings.boardingShieldThreshold,
            settings.boardingMarines,
            settings.fleeThreshold,
            settings.shieldRechargePct,
          );

            if (result === "captured") {
              totalKills++;
              totalBoardings++;
               ctx.log("combat", `🎉 ${target.name} CAPTURED via boarding! (hull: ${target.hull || target.maxHull || "?"}%)`);
              if (!settings.disableWreckSalvaging) await scavengeWrecks(ctx);
              await topUpShields(ctx, (settings.shieldRechargePct ?? 80) / 100);
              await useRepairKits(ctx);
              await bot.refreshCargo();
              await bot.refreshStatus();
              const recoveries = bot.prizeRecoveries;
              if (recoveries.length > 0) {
                const cap = recoveries[0];
                ctx.log("combat", `📦 Prize tracked: prize_id=${cap.prize_id} ship_id=${cap.ship_id} status=${cap.status}`);
              }
              const recovered = await recoverPrize(ctx, settings);
              if (recovered) {
                ctx.log("combat", `🏆 Prize from ${target.name} successfully recovered!`);
              } else {
                ctx.log("combat", `⚠️ Could not recover prize from ${target.name} — another pilot may have claimed it, or the prize is at a different POI in this system`);
              }

              yield "safety_check";
              const postCaptureResp = await bot.exec("get_nearby");
              if (!postCaptureResp.error) {
                bot.trackNearbyPlayers(postCaptureResp.result);
                bot.trackWildlife(postCaptureResp.result);
              }
             continue;
            } else if (result === "target_eliminated") {
              totalKills++;
              ctx.log("combat", `Kill #${totalKills} (${target.name}) — target eliminated`);
              if (!settings.disableWreckSalvaging) await scavengeWrecks(ctx);
              await topUpShields(ctx, (settings.shieldRechargePct ?? 80) / 100);
              await useRepairKits(ctx);
              await bot.refreshCargo();

              yield "safety_check";
              const postKillResp = await bot.exec("get_nearby");
              if (!postKillResp.error) {
                bot.trackNearbyPlayers(postKillResp.result);
                bot.trackWildlife(postKillResp.result);
                const nearbyEntities = parseNearby(postKillResp.result);
                const newThreats = nearbyEntities.filter(e =>
                  isPirateTarget(e, settings.onlyNPCs, settings.maxAttackTier) &&
                  !isStationEntity(e) &&
                  e.id !== target.id &&
                  e.name !== target.name
                );
                if (newThreats.length > 0) {
                  ctx.log("combat", `🚨 ${newThreats.length} new pirate(s) detected after kill: ${newThreats.map(t => t.name).join(", ")} — engaging!`);
                  for (const newThreat of newThreats) {
                    if (bot.state !== "running") break;
                    const newWon = await hunterEngage(ctx, newThreat, settings.fleeThreshold, settings.fleeFromTier, settings.minPiratesToFlee, settings.maxAttackTier, undefined, settings.disableScanCommandForPirates, settings.repairThreshold, settings.cloakOnStart);
                    if (newWon) {
                      totalKills++;
                      ctx.log("combat", `Kill #${totalKills} (${newThreat.name}) — additional threat eliminated`);
                    }
                  }
                }
              }
              continue;
           } else if (result === "retreat") {
             break;
           }
           // "failed" — fall through to normal fire engagement
           ctx.log("combat", `Boarding failed for ${target.name} — engaging normally`);
         }
       }

       // Normal fire engagement (fallback or boarding disabled)
       if (!coordResponding) {
         broadcastHunterAssist(ctx, target, !!(target.isCreature) || isCreatureTarget(target as any, true));
         claimCreature(ctx, target);
       }
       const hsettings = getHunterSettings(ctx.bot.username);
       const won = await engageTarget(ctx, target, settings.fleeThreshold, settings.fleeFromTier, settings.minPiratesToFlee, settings.maxAttackTier, undefined, settings.disableScanCommandForPirates, settings.repairThreshold, settings.onlyNPCs, settings.cloakOnStart, hsettings.shieldRechargePct ?? 80);

       if (await shouldAbortPatrolAfterEngage(ctx, won, target.name)) break;
       if (won) {
         totalKills++;
         ctx.log("combat", `Kill #${totalKills} (${target.name}) — looting...`);
         yield "loot";
         if (!settings.disableWreckSalvaging) await scavengeWrecks(ctx);
         await topUpShields(ctx, (settings.shieldRechargePct ?? 80) / 100);
         await useRepairKits(ctx);
         await bot.refreshCargo();

         yield "safety_check";
         const postKillResp2 = await bot.exec("get_nearby");
         if (!postKillResp2.error) {
           bot.trackNearbyPlayers(postKillResp2.result);
           bot.trackWildlife(postKillResp2.result);
           const nearbyEntities2 = parseNearby(postKillResp2.result);
           const newThreats2 = nearbyEntities2.filter(e =>
             isPirateTarget(e, settings.onlyNPCs, settings.maxAttackTier) &&
             !isStationEntity(e) &&
             e.id !== target.id &&
             e.name !== target.name
           );
           if (newThreats2.length > 0) {
             ctx.log("combat", `🚨 ${newThreats2.length} new pirate(s) detected after kill: ${newThreats2.map(t => t.name).join(", ")} — engaging!`);
             for (const newThreat of newThreats2) {
               if (bot.state !== "running") break;
               const newWon = await hunterEngage(ctx, newThreat, settings.fleeThreshold, settings.fleeFromTier, settings.minPiratesToFlee, settings.maxAttackTier, undefined, settings.disableScanCommandForPirates, settings.repairThreshold, settings.cloakOnStart);
               if (newWon) {
                 totalKills++;
                 ctx.log("combat", `Kill #${totalKills} (${newThreat.name}) — additional threat eliminated`);
               }
             }
           }
         }
         if (isLowOnFieldConsumables(bot.inventory)) {
           ctx.log("combat", "Low on repair kits or shield charges — ending sweep to resupply");
           break;
         }
        }
      }
    }

    // After processing all targets at this POI, check for any prizes left behind
    // (from battles that happened before we arrived, or from captures we missed)
    yield "check_prizes";
    const prizeCheckResp = await bot.exec("get_nearby");
    if (!prizeCheckResp.error && prizeCheckResp.result) {
      const prizesAtPoi = getNearbyPrizes(prizeCheckResp.result);
      const missedPrize = prizesAtPoi.find(p => p.status === "available" || p.status === "claimed");
      if (missedPrize) {
        ctx.log("combat", `🛸 Found unclaimed prize ${missedPrize.ship_name || missedPrize.prize_id} at ${bot.poi} after combat — claiming now`);
        const claimed = await claimPrizeAtCurrentPoi(ctx, settings);
        if (claimed) {
          ctx.log("combat", `🏆 Missed prize from ${bot.poi} successfully claimed!`);
        }
      }
    }

   // ── Post-patrol decision ──
  yield "post_patrol";
  await bot.refreshCargo();
  await bot.refreshShip();
  const postHull = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
  const postFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
  const needsRepair = postHull <= settings.repairThreshold;
  const hasFuelCells = bot.inventory?.some(i =>
    i.itemId === 'fuel_cell' ||
    i.itemId === 'premium_fuel_cell' ||
    i.itemId === 'military_fuel_cell'
  );
  const needsFuel = !hasFuelCells;

  if (needsRepair || needsFuel) {
    ctx.log("system", `Patrol sweep done — ${totalKills} kill(s), ${totalBoardings} boarding(s). Hull: ${postHull}% | Fuel: ${postFuel}% — returning to safe system...`);
    yield "dock";
    const docked = await navigateToSafeStation(ctx, safetyOpts);
    if (!docked) {
      ctx.log("error", "Could not dock anywhere — retrying next cycle");
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

    if (settings.singleLoop) {
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
  } else {
    ctx.log("system", `Patrol sweep done — ${totalKills} kill(s), ${totalBoardings} boarding(s). Hull: ${postHull}% | Fuel: ${postFuel}% — continuing hunt...`);
  }

  return [totalKills, totalBoardings];
}

