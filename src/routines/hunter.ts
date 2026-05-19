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
import { writeSettings } from "./common.js";
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
} from "./common.js";

import type { PirateTier, NearbyEntity } from "./battle.js";
import {
  parseNearby,
  isPirateTarget,
  ensureAmmoLoaded,
  engageTarget,
  emergencyFleeSpam,
  analyzeExistingBattle,
  fightFreshBattle,
  fightJoinedBattle,
  getWeaponModules,
} from "./battle.js";

async function handleUnexpectedBattle(ctx: RoutineContext, maxAttackTier: PirateTier, minPiratesToFlee: number, fleeThreshold: number, fleeFromTier: PirateTier): Promise<void> {
  const battleStatus = await getBattleStatus(ctx);
  if (!battleStatus) return;

  ctx.log("combat", `⚠️ Unexpectedly in battle (ID: ${battleStatus.battle_id}) during scanning`);

  const analysis = await analyzeExistingBattle(ctx, maxAttackTier, minPiratesToFlee);
  if (!analysis.shouldJoin) {
    ctx.log("combat", `⏭️ Skipping unexpected battle: ${analysis.reason}`);
    return;
  }

  if (analysis.reason.includes("Already in battle")) {
    ctx.log("combat", `Already participating on side ${analysis.sideId} — continuing fight`);
  } else {
    ctx.log("combat", `✅ Joining unexpected battle on side ${analysis.sideId}: ${analysis.reason}`);
    const engageResp = await ctx.bot.exec("battle", { action: "engage", side_id: analysis.sideId!.toString() });
    if (engageResp.error) {
      ctx.log("error", `Failed to join unexpected battle: ${engageResp.error.message}`);
      return;
    }
  }

  // Pick a real target from battle participants so we get the full combat loop
  const enemy = battleStatus.participants.find(p => p.side_id !== analysis.sideId && !p.is_destroyed);
  const fakeTarget = enemy ? { id: enemy.player_id || enemy.username || "", name: enemy.username || enemy.player_id || "enemy" } as any : null;
  await fightJoinedBattle(ctx, fakeTarget, fleeThreshold, fleeFromTier, maxAttackTier);
}

// ── Settings ─────────────────────────────────────────────────

export type HunterMode = "roam_systems" | "roam_system" | "stationary" | "patrol_systems";

export interface HunterPatrolProfile {
  name: string;
  patrolSystems: string[];
}

function getHunterSettings(username?: string): {
  mode: HunterMode;
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
  disableScanCommandForPirates: boolean;
  disableWreckSalvaging: boolean;
  patrolSystems: string[];
  singleLoop: boolean;
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
    disableScanCommandForPirates: (h.disableScanCommandForPirates as boolean) ?? false,
    disableWreckSalvaging: (h.disableWreckSalvaging as boolean) ?? false,
    patrolSystems: resolvedPatrolSystems,
    singleLoop: (h.singleLoop as boolean) ?? false,
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

/** Assign a bot to a named hunter patrol profile (new multi-bot system) */
export function assignBotToHunterPatrol(username: string, patrolProfileName: string): void {
  const all = readSettings();
  const h = (all.hunter || {}) as any;
  if (!h.botHunterPatrolAssignments) h.botHunterPatrolAssignments = {};
  h.botHunterPatrolAssignments[username] = patrolProfileName;
  writeSettings({ hunter: h });
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
/**
 * Ensure the hunter has ammo loaded. Only reloads when ammo <= 25% of max capacity.
 * Uses proper reload command with weapon_instance_id and ammo_item_id from cargo.
 * Returns false if out of ammo and needs to dock for resupply.
 * 
 * Handles both traditional weapons (with reported ammo) and missile launchers
 * (which may not report ammo state but still need cargo ammo).
 */
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

  // Check per-bot mode
  const initialSettings = getHunterSettings(bot.username);

  // If we started the routine while docked at home base, refuel, repair, then restock
  if (bot.docked) {
    await repairShip(ctx);
    await tryRefuel(ctx);
    await ensureHunterResupply(ctx);
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

  // Default to roam_systems
  yield* roamSystemsRoutine(ctx);
};

// ── Roam Systems Routine (original behavior) ────────────────────

async function* roamSystemsRoutine(ctx: RoutineContext): AsyncGenerator<string, void, void> {
  const { bot } = ctx;

  await bot.refreshStatus();
  let totalKills = 0;

  while (bot.state === "running") {
    // ── Death recovery ──
    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) { await ctx.sleep(30000); continue; }

    const settings = getHunterSettings(bot.username);
    const safetyOpts = {
      fuelThresholdPct: settings.refuelThreshold,
      hullThresholdPct: settings.repairThreshold,
      autoCloak: settings.autoCloak,
      skipBlacklist: true,
    };
    const patrolSystem = settings.system || "";

    // ── Status ──
    yield "get_status";
    await bot.refreshStatus();
    logStatus(ctx);

    // ── Position update for visual display ──
    yield "get_system";
    await bot.exec("get_system");
    yield "get_poi";
    if (bot.poi) await bot.exec("get_poi", { poi_id: bot.poi });

    // ── Fuel check ──
    yield "fuel_check";
    const fueled = await ensureFueled(ctx, settings.refuelThreshold);
    if (!fueled) {
      ctx.log("error", "Cannot secure fuel — waiting 30s...");
      await ctx.sleep(30000);
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
                const won = await engageTarget(ctx, threat, settings.fleeThreshold, settings.fleeFromTier, settings.minPiratesToFlee, settings.maxAttackTier, undefined, settings.disableScanCommandForPirates);
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
      await ctx.sleep(1000);

      // Scan for targets
      yield "scan_for_targets";
      const nearbyResp = await bot.exec("get_nearby");
      if (nearbyResp.error) {
        ctx.log("error", `get_nearby at ${poi.name}: ${nearbyResp.error.message}`);
        continue;
      }

      // Track player names from nearby scan
      bot.trackNearbyPlayers(nearbyResp.result);

      // Check if we got pulled into battle during scanning
      await handleUnexpectedBattle(ctx, settings.maxAttackTier, settings.minPiratesToFlee, settings.fleeThreshold, settings.fleeFromTier);

      // Immediate reaction to pirate scan notification (NPC only, not player scans)
      if (nearbyResp.notifications) {
        const notifs = Array.isArray(nearbyResp.notifications) ? nearbyResp.notifications : [];
        for (const n of notifs) {
          const msg = (n as any)?.data?.message || (n as any)?.message || "";
          if (msg.includes("You were scanned by") && msg.includes("[COMBAT]")) {
            ctx.log("combat", "Pirate scan detected - immediate get_nearby + engage");
            const scanNearby = await bot.exec("get_nearby");
            if (!scanNearby.error) {
              bot.trackNearbyPlayers(scanNearby.result);
              const scanEntities = parseNearby(scanNearby.result);
              const scanTargets = scanEntities.filter(e => isPirateTarget(e, settings.onlyNPCs, settings.maxAttackTier));
              for (const t of scanTargets) {
                await engageTarget(ctx, t, settings.fleeThreshold, settings.fleeFromTier, settings.minPiratesToFlee, settings.maxAttackTier, undefined, settings.disableScanCommandForPirates);
              }
            }
            break;
          }
        }
      }

      const entities = parseNearby(nearbyResp.result);
      ctx.log("info", `entities: ${entities}`);
      const targets = entities.filter(e => isPirateTarget(e, settings.onlyNPCs, settings.maxAttackTier));

      if (targets.length === 0) {
        ctx.log("combat", `No targets at ${poi.name}`);
        if (!settings.disableWreckSalvaging) await scavengeWrecks(ctx);
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
                
                const newWon = await engageTarget(ctx, newThreat, settings.fleeThreshold, settings.fleeFromTier, settings.minPiratesToFlee, settings.maxAttackTier, undefined, settings.disableScanCommandForPirates);
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
    await bot.refreshCargo();
    await bot.refreshStatus();
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

      if (settings.singleLoop) {
        ctx.log("system", "Single loop mode enabled — patrol complete, returning to base and stopping.");
        return;
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

  await bot.refreshStatus();
  let totalKills = 0;

  while (bot.state === "running") {
    // ── Death recovery ──
    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) { await ctx.sleep(30000); continue; }

    const settings = getHunterSettings(bot.username);
    const safetyOpts = {
      fuelThresholdPct: settings.refuelThreshold,
      hullThresholdPct: settings.repairThreshold,
      autoCloak: settings.autoCloak,
      skipBlacklist: true,
    };

    // ── Status ──
    yield "get_status";
    await bot.refreshStatus();
    logStatus(ctx);

    // ── Position update for visual display ──
    yield "get_system";
    await bot.exec("get_system");
    yield "get_poi";
    if (bot.poi) await bot.exec("get_poi", { poi_id: bot.poi });

    // ── Fuel check ──
    yield "fuel_check";
    const fueled = await ensureFueled(ctx, settings.refuelThreshold);
    if (!fueled) {
      ctx.log("error", "Cannot secure fuel — waiting 30s...");
      await ctx.sleep(30000);
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

      // Brief pause to ensure travel fully processed
      await ctx.sleep(1000);

      // Scan for targets
      yield "scan_for_targets";
      const nearbyResp = await bot.exec("get_nearby");
      if (nearbyResp.error) {
        ctx.log("error", `get_nearby at ${poi.name}: ${nearbyResp.error.message}`);
        continue;
      }

      // Track player names from nearby scan
      bot.trackNearbyPlayers(nearbyResp.result);

      // Check if we got pulled into battle during scanning
      await handleUnexpectedBattle(ctx, settings.maxAttackTier, settings.minPiratesToFlee, settings.fleeThreshold, settings.fleeFromTier);

      // Immediate reaction to pirate scan notification (NPC only, not player scans)
      if (nearbyResp.notifications) {
        const notifs = Array.isArray(nearbyResp.notifications) ? nearbyResp.notifications : [];
        for (const n of notifs) {
          const msg = (n as any)?.data?.message || (n as any)?.message || "";
          if (msg.includes("You were scanned by") && msg.includes("[COMBAT]")) {
            ctx.log("combat", "Pirate scan detected - immediate get_nearby + engage");
            const scanNearby = await bot.exec("get_nearby");
            if (!scanNearby.error) {
              bot.trackNearbyPlayers(scanNearby.result);
              const scanEntities = parseNearby(scanNearby.result);
              const scanTargets = scanEntities.filter(e => isPirateTarget(e, settings.onlyNPCs, settings.maxAttackTier));
              for (const t of scanTargets) {
                await engageTarget(ctx, t, settings.fleeThreshold, settings.fleeFromTier, settings.minPiratesToFlee, settings.maxAttackTier, undefined, settings.disableScanCommandForPirates);
              }
            }
            break;
          }
        }
      }

      const entities = parseNearby(nearbyResp.result);
      ctx.log("info", `entities: ${entities}`);
      const targets = entities.filter(e => isPirateTarget(e, settings.onlyNPCs, settings.maxAttackTier));

      if (targets.length === 0) {
        ctx.log("combat", `No targets at ${poi.name}`);
        if (!settings.disableWreckSalvaging) await scavengeWrecks(ctx);
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

        // Pre-fight ammo check
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

          // Safety check for new threats
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
              for (const newThreat of newThreats) {
                if (bot.state !== "running") break;

                const newWon = await engageTarget(ctx, newThreat, settings.fleeThreshold, settings.fleeFromTier, settings.minPiratesToFlee, settings.maxAttackTier, undefined, settings.disableScanCommandForPirates);
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
    await bot.refreshCargo();
    await bot.refreshStatus();
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

      yield "dock";
      const docked = await navigateToSafeStation(ctx, safetyOpts);
      if (!docked) {
        ctx.log("error", "Could not dock anywhere — retrying next cycle");
        continue;
      }

      await collectFromStorage(ctx);

      yield "complete_missions";
      await completeActiveMissions(ctx);

      // Sell loot
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
      ctx.log("system", `Patrol sweep done — ${patrolKills} kill(s). Hull: ${postHull}% | Fuel: ${postFuel}% — continuing hunt in system...`);
      // In roam_system mode, we just continue the loop without moving to another system
    }
  }
}

// ── Stationary Routine (stay in one POI) ────────────────────────

async function* stationaryRoutine(ctx: RoutineContext): AsyncGenerator<string, void, void> {
  const { bot } = ctx;

  await bot.refreshStatus();
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
    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) { await ctx.sleep(30000); continue; }

    const settings = getHunterSettings(bot.username);
    const safetyOpts = {
      fuelThresholdPct: settings.refuelThreshold,
      hullThresholdPct: settings.repairThreshold,
      autoCloak: settings.autoCloak,
      skipBlacklist: true,
    };

    // ── Status ──
    yield "get_status";
    await bot.refreshStatus();
    logStatus(ctx);

    // ── Position update for visual display ──
    yield "get_system";
    await bot.exec("get_system");
    yield "get_poi";
    if (bot.poi) await bot.exec("get_poi", { poi_id: bot.poi });

    // ── Fuel check ──
    yield "fuel_check";
    const fueled = await ensureFueled(ctx, settings.refuelThreshold);
    if (!fueled) {
      ctx.log("error", "Cannot secure fuel — waiting 30s...");
      await ctx.sleep(30000);
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
    const nearbyResp = await bot.exec("get_nearby");
    if (nearbyResp.error) {
      ctx.log("error", `get_nearby failed: ${nearbyResp.error.message}`);
      await ctx.sleep(5000);
      continue;
    }

      // Track player names from nearby scan
      bot.trackNearbyPlayers(nearbyResp.result);

      // Check if we got pulled into battle during scanning
      await handleUnexpectedBattle(ctx, settings.maxAttackTier, settings.minPiratesToFlee, settings.fleeThreshold, settings.fleeFromTier);

      // Immediate reaction to pirate scan notification (NPC only, not player scans)
      if (nearbyResp.notifications) {
        const notifs = Array.isArray(nearbyResp.notifications) ? nearbyResp.notifications : [];
        for (const n of notifs) {
          const msg = (n as any)?.data?.message || (n as any)?.message || "";
          if (msg.includes("You were scanned by") && msg.includes("[COMBAT]")) {
            ctx.log("combat", "Pirate scan detected - immediate get_nearby + engage");
            const scanNearby = await bot.exec("get_nearby");
            if (!scanNearby.error) {
              bot.trackNearbyPlayers(scanNearby.result);
              const scanEntities = parseNearby(scanNearby.result);
              const scanTargets = scanEntities.filter(e => isPirateTarget(e, settings.onlyNPCs, settings.maxAttackTier));
              for (const t of scanTargets) {
                await engageTarget(ctx, t, settings.fleeThreshold, settings.fleeFromTier, settings.minPiratesToFlee, settings.maxAttackTier, undefined, settings.disableScanCommandForPirates);
              }
            }
            break;
          }
        }
      }

      const entities = parseNearby(nearbyResp.result);
    const targets = entities.filter(e => isPirateTarget(e, settings.onlyNPCs, settings.maxAttackTier));

    if (targets.length === 0) {
      ctx.log("combat", `No targets detected at ${originalPoi}`);
      if (!settings.disableWreckSalvaging) await scavengeWrecks(ctx);
      await ctx.sleep(5000); // Wait 30 seconds before next scan
      continue;
    }

    ctx.log("combat", `Found ${targets.length} target(s) at ${originalPoi}: ${targets.map(t => t.name).join(", ")}`);

    // Engage each target
    for (const target of targets) {
      if (bot.state !== "running") break;

      await bot.refreshStatus();
      const preHull = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
      if (preHull <= settings.repairThreshold) {
        ctx.log("system", `Hull at ${preHull}% — too low for another fight`);
        break;
      }

      // Pre-fight ammo check
      const hasAmmo = await ensureAmmoLoaded(ctx, settings.ammoThreshold, settings.maxReloadAttempts);
      if (!hasAmmo) {
        ctx.log("combat", "Out of ammo — aborting to resupply");
        break;
        }

        yield "engage";
        const won = await engageTarget(ctx, target, settings.fleeThreshold, settings.fleeFromTier, settings.minPiratesToFlee, settings.maxAttackTier, undefined, settings.disableScanCommandForPirates);

        if (won) {
          totalKills++;
        ctx.log("combat", `Kill #${totalKills} — checking for new threats...`);

        // Safety check for new threats
        yield "safety_check";
        const safetyCheckResp = await bot.exec("get_nearby");
        if (!safetyCheckResp.error) {
          bot.trackNearbyPlayers(safetyCheckResp.result);
          await handleUnexpectedBattle(ctx, settings.maxAttackTier, settings.minPiratesToFlee, settings.fleeThreshold, settings.fleeFromTier);
          const nearbyEntities = parseNearby(safetyCheckResp.result);
          const newThreats = nearbyEntities.filter(e =>
            isPirateTarget(e, settings.onlyNPCs, settings.maxAttackTier) &&
            e.id !== target.id &&
            e.name !== target.name
          );

          if (newThreats.length > 0) {
            ctx.log("combat", `🚨 ${newThreats.length} new pirate(s) detected: ${newThreats.map(t => t.name).join(", ")} — engaging!`);
            for (const newThreat of newThreats) {
              if (bot.state !== "running") break;

                const newWon = await engageTarget(ctx, newThreat, settings.fleeThreshold, settings.fleeFromTier, settings.minPiratesToFlee, settings.maxAttackTier, undefined, settings.disableScanCommandForPirates);
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

          if (!settings.disableWreckSalvaging) {
            yield "loot";
            await scavengeWrecks(ctx);
          }

          // Post-kill reload
        const hasAmmo = await ensureAmmoLoaded(ctx, settings.ammoThreshold, settings.maxReloadAttempts);
        if (!hasAmmo) {
          ctx.log("combat", "No ammo after kill — aborting to resupply");
          break;
        }

        await bot.refreshStatus();
        ctx.log("combat", `Post-fight: hull ${bot.hull}/${bot.maxHull} | ammo ${bot.ammo} | credits ${bot.credits}`);
      } else {
        ctx.log("combat", "Retreated — waiting before next scan");
        await ctx.sleep(5000);
        break;
      }
    }

    // After fighting, wait a bit before next scan
    await ctx.sleep(5000);
  }
}

// ── Patrol Systems Routine (cycle through configured list) ────────

async function* patrolSystemsRoutine(ctx: RoutineContext): AsyncGenerator<string, void, void> {
  const { bot } = ctx;

  await bot.refreshStatus();
  let totalKills = 0;
  let systemIndex = 0;

  while (bot.state === "running") {
    const settings = getHunterSettings(bot.username);
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
    };

    // Navigate to the target system in the list
    if (bot.system !== targetSystem) {
      ctx.log("travel", `Patrol systems: heading to ${targetSystem}...`);
      const arrived = await navigateToSystem(ctx, targetSystem, safetyOpts);
      if (!arrived) {
        ctx.log("error", `Could not reach ${targetSystem} — skipping`);
        await ctx.sleep(5000);
        continue;
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
        const nearbyResp = await bot.exec("get_nearby");
        if (nearbyResp.error) continue;
        bot.trackNearbyPlayers(nearbyResp.result);
        const entities = parseNearby(nearbyResp.result);
        const targets = entities.filter(e => isPirateTarget(e, settings.onlyNPCs, settings.maxAttackTier));
        for (const target of targets) {
          await ensureAmmoLoaded(ctx, settings.ammoThreshold, settings.maxReloadAttempts);
          const won = await engageTarget(ctx, target, settings.fleeThreshold, settings.fleeFromTier, settings.minPiratesToFlee, settings.maxAttackTier, undefined, settings.disableScanCommandForPirates);
          if (won) {
            totalKills++;
            await scavengeWrecks(ctx);
          }
        }
      }
    })();
  }
}

/** Hunter resupply: ammo, advanced repair kits, and military fuel cells from faction storage or station. */
async function ensureHunterResupply(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;

  if (!bot.docked) return;

  // Buying is currently disabled — we only withdraw from faction storage
  const allowBuying = false;

  // Always try to refuel when docked at home base (free fuel)
  await tryRefuel(ctx);

  await bot.refreshStatus();
  await bot.refreshCargo();

  // Empty cargo of loot while protecting ammo, fuel cells, and repair kits
  for (const item of [...bot.inventory]) {
    const id = item.itemId.toLowerCase();
    const isProtected =
      id.includes("ammo") ||
      id.includes("fuel_cell") ||
      id.includes("repair_kit");

    if (isProtected) continue;

    if (item.quantity > 0) {
      const sellResp = await bot.exec("sell", { item_id: item.itemId, quantity: item.quantity });
      if (!sellResp.error) {
        ctx.log("trade", `Sold ${item.quantity}x ${item.name} (cleared cargo)`);
      }
    }
  }

  let freeSpace = bot.cargoMax;
  if (freeSpace < 5) {
    ctx.log("trade", "Cargo almost full — skipping resupply");
    return;
  }

  // Check if we already have ammo in cargo (user may have placed it manually)
  const existingAmmo = bot.inventory.find(i =>
    i.itemId.includes("ammo") || i.itemId.includes("_ammo")
  );

  // 1. Ammo resupply
  const weapons = await getWeaponModules(ctx);
  ctx.log("debug", `Hunter resupply: detected ${weapons.length} weapons`);

  for (const w of weapons) {
    ctx.log("debug", `  Weapon: ${w.name} | ammoType: ${w.ammoType || 'none'} | maxAmmo: ${w.maxAmmo}`);
  }

  let ammoToGet = 30;

  if (weapons.length > 0) {
    const maxAmmo = Math.max(...weapons.map(w => w.maxAmmo || 0));
    if (maxAmmo > 50) {
      ammoToGet = 20;
    } else if (maxAmmo > 0) {
      ammoToGet = 40;
    }
  }

  let chosenAmmoId: string | null = null;

  if (existingAmmo) {
    chosenAmmoId = existingAmmo.itemId;
    ctx.log("trade", `Using existing ammo type from cargo: ${chosenAmmoId}`);
  } else if (weapons.length > 0) {
    // Find the first weapon that actually uses ammo
    const ammoWeapon = weapons.find(w => w.ammoType && w.ammoType !== "none");
    
    if (ammoWeapon) {
      const ammoIndex = catalogStore.getAmmoTypeIndex();
      const ammoType = ammoWeapon.ammoType!;

      // Prefer the ammo that is currently loaded in the weapon, if available
      let possibleAmmo = ammoIndex[ammoType] || [];

      if (ammoWeapon.loadedAmmoId && possibleAmmo.includes(ammoWeapon.loadedAmmoId)) {
        // Move the currently loaded ammo to the front so we prefer it
        possibleAmmo = [
          ammoWeapon.loadedAmmoId,
          ...possibleAmmo.filter(id => id !== ammoWeapon.loadedAmmoId)
        ];
        ctx.log("debug", `Preferring currently loaded ammo: ${ammoWeapon.loadedAmmoId}`);
      }

      ctx.log("debug", `Catalog ammo options for ${ammoType}: ${possibleAmmo.join(", ") || "none"}`);

      if (possibleAmmo.length > 0) {
        chosenAmmoId = possibleAmmo[0];
      }
    } else {
      ctx.log("debug", "No weapons with ammoType found");
    }
  }

  if (chosenAmmoId) {
    // Try the selected ammo, then fall back through other catalog options if it fails
    const ammoOptions = [chosenAmmoId];
    const ammoIndex = catalogStore.getAmmoTypeIndex();
    const ammoWeapon = weapons.find(w => w.ammoType && w.ammoType !== "none");
    if (ammoWeapon) {
      const ammoType = ammoWeapon.ammoType!;
      const extra = ammoIndex[ammoType] || [];
      for (const opt of extra) {
        if (!ammoOptions.includes(opt)) ammoOptions.push(opt);
      }
    }

    let gotAmmo = false;
    for (const ammoId of ammoOptions) {
      const ammoSize = getItemSize(ammoId);
      const actualQty = Math.min(ammoToGet, Math.floor(freeSpace / ammoSize));
      if (actualQty <= 0) continue;

      const wResp = await bot.exec("storage", {
        action: "withdraw",
        target: "faction",
        item_id: ammoId,
        quantity: actualQty
      });
      if (!wResp.error) {
        ctx.log("trade", `Withdrew ${actualQty} ${ammoId} from faction storage`);
        freeSpace -= actualQty * ammoSize;
        gotAmmo = true;
        break;
      }
    }

    if (!gotAmmo) {
      ctx.log("trade", `Ammo resupply: relying on faction storage (tried ${ammoOptions.length} options)`);
    }
  } else {
    ctx.log("trade", "No suitable ammo found for equipped weapons — skipping ammo resupply");
  }

  // 2. Repair kits (~10) - try advanced first, then fallback to regular
  const repairKits = ["advanced_repair_kit", "repair_kit"];
  let gotRepairKits = false;
  for (const kitId of repairKits) {
    const kitSize = getItemSize(kitId);
    const kitQty = Math.min(10, Math.floor(freeSpace / kitSize));
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

  // 3. Military fuel cells — fill the rest (prefer faction storage)
  const fuelCellSize = getItemSize("military_fuel_cell");
  if (freeSpace >= fuelCellSize) {
    const fuelQty = Math.floor(freeSpace / fuelCellSize);
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
}




