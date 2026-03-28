/**
 * Fleet Hunter Commander routine — leads a fleet of subordinate hunters.
 *
 * Responsibilities:
 * - Decide patrol systems and POIs
 * - Broadcast movement commands via faction chat
 * - Call targets for fleet to engage
 * - Coordinate fleet positioning during combat
 * - Order retreats when danger is detected
 * - Manage post-patrol logistics (dock, repair, resupply)
 *
 * Communication:
 * - Uses faction chat to broadcast commands to subordinates
 * - Format: [FLEET CMD] <COMMAND> <params>
 * - Commands: MOVE, ATTACK, FLEE, REGROUP, HOLD, PATROL
 *
 * Settings (data/settings.json under "fleet_hunter"):
 *   fleetId           — unique identifier for this fleet (for chat filtering)
 *   patrolSystem      — system ID to patrol (default: current system)
 *   refuelThreshold   — fuel % to trigger refuel stop (default: 40)
 *   repairThreshold   — hull % to abort patrol and dock (default: 30)
 *   fleeThreshold     — hull % to flee an active fight (default: 20)
 *   maxAttackTier     — highest pirate tier to engage (default: "large")
 *   fleeFromTier      — pirate tier that triggers fleet flee (default: "boss")
 *   minPiratesToFlee  — number of pirates that triggers fleet flee (default: 3)
 *   fireMode          — "focus" (all fire same target) or "spread" (split targets)
 *   fleetSize         — expected number of subordinates (for coordination)
 */

import type { Routine, RoutineContext } from "../bot.js";
import { mapStore } from "../mapstore.js";
import { getSystemBlacklist } from "../web/server.js";
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
    const blacklist = getSystemBlacklist();
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
  };
}

// ── Fleet command broadcasting ───────────────────────────────

/** Broadcast a command to the fleet via faction chat. */
async function broadcastFleetCommand(ctx: RoutineContext, command: string, params: string): Promise<void> {
  const settings = getFleetHunterSettings();
  const msg = `[FLEET ${settings.fleetId}] ${command} ${params}`;
  
  try {
    await ctx.bot.exec("chat", {
      channel: "faction",
      content: msg,
    });
    ctx.log("fleet", `Broadcast: ${msg}`);
  } catch (e) {
    ctx.log("error", `Failed to broadcast fleet command: ${e}`);
  }
}

/** Send a MOVE command to the fleet. */
async function orderFleetMove(ctx: RoutineContext, systemId: string, poiId?: string): Promise<void> {
  const params = poiId ? `${systemId}/${poiId}` : systemId;
  await broadcastFleetCommand(ctx, "MOVE", params);
}

/** Send an ATTACK command with target ID. */
async function orderFleetAttack(ctx: RoutineContext, targetId: string, targetName: string): Promise<void> {
  await broadcastFleetCommand(ctx, "ATTACK", `${targetId}:${targetName}`);
}

/** Send a FLEE command to the fleet. */
async function orderFleetFlee(ctx: RoutineContext): Promise<void> {
  await broadcastFleetCommand(ctx, "FLEE", "");
}

/** Send a REGROUP command. */
async function orderFleetRegroup(ctx: RoutineContext, systemId: string, poiId?: string): Promise<void> {
  const params = poiId ? `${systemId}/${poiId}` : systemId;
  await broadcastFleetCommand(ctx, "REGROUP", params);
}

/** Send a HOLD command (stay in position). */
async function orderFleetHold(ctx: RoutineContext): Promise<void> {
  await broadcastFleetCommand(ctx, "HOLD", "");
}

/** Send a PATROL command (resume patrol pattern). */
async function orderFleetPatrol(ctx: RoutineContext): Promise<void> {
  await broadcastFleetCommand(ctx, "PATROL", "");
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

// ── Combat engagement ─────────────────────────────────────────

async function engageTarget(
  ctx: RoutineContext,
  target: NearbyEntity,
  fleeThreshold: number,
  fleeFromTier: PirateTier,
  minPiratesToFlee: number,
  fireMode: "focus" | "spread",
): Promise<boolean> {
  const { bot } = ctx;

  if (!target.id) return false;

  // Order fleet to attack
  await orderFleetAttack(ctx, target.id, target.name);
  
  // Small delay to let subordinates receive the command
  await sleep(1000);

  ctx.log("combat", `Engaging ${target.name} (fire mode: ${fireMode})...`);

  // Commander also attacks
  const attackResp = await bot.exec("attack", { target_id: target.id });
  if (attackResp.error) {
    ctx.log("combat", `Attack initiated with errors: ${attackResp.error.message}`);
  }

  // Advance to close range
  for (let zone = 0; zone < 3; zone++) {
    if (bot.state !== "running") return false;

    await bot.refreshStatus();
    const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    if (hullPct <= fleeThreshold) {
      ctx.log("combat", `Hull critical (${hullPct}%) — ordering fleet flee!`);
      await orderFleetFlee(ctx);
      await bot.exec("stance", { stance: "flee" });
      return false;
    }

    const advResp = await bot.exec("advance");
    if (advResp.error) break;
  }

  // Combat loop
  const MAX_COMBAT_TICKS = 30;
  for (let tick = 0; tick < MAX_COMBAT_TICKS; tick++) {
    if (bot.state !== "running") return false;

    await bot.refreshStatus();
    const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    const shieldPct = bot.maxShield > 0 ? Math.round((bot.shield / bot.maxShield) * 100) : 100;

    // Emergency flee
    if (hullPct <= fleeThreshold) {
      ctx.log("combat", `Hull critical (${hullPct}%) — ordering fleet flee!`);
      await orderFleetFlee(ctx);
      await bot.exec("stance", { stance: "flee" });
      await bot.exec("retreat");
      return false;
    }

    // Check for fleet-wide danger
    const nearbyResp = await bot.exec("get_nearby");
    if (!nearbyResp.error && nearbyResp.result) {
      const entities = parseNearby(nearbyResp.result);
      const pirateCount = entities.filter(e => e.isPirate).length;
      const highestPirateTier = entities
        .filter(e => e.isPirate && e.tier)
        .reduce((max, e) => getTierLevel(e.tier) > getTierLevel(max) ? e.tier! : max, "small" as PirateTier);

      if (pirateCount >= minPiratesToFlee) {
        ctx.log("combat", `Too many pirates (${pirateCount}) — ordering fleet flee!`);
        await orderFleetFlee(ctx);
        await bot.exec("stance", { stance: "flee" });
        await bot.exec("retreat");
        return false;
      }

      if (isTierTooHigh(highestPirateTier, fleeFromTier)) {
        ctx.log("combat", `Pirate tier too high (${highestPirateTier}) — ordering fleet flee!`);
        await orderFleetFlee(ctx);
        await bot.exec("stance", { stance: "flee" });
        await bot.exec("retreat");
        return false;
      }
    }

    // Combat stance
    const shieldsCritical = shieldPct < 15 && hullPct < 70;
    if (shieldsCritical) {
      await bot.exec("stance", { stance: "brace" });
    } else {
      await bot.exec("stance", { stance: "fire" });
    }

    ctx.log("combat", `Tick ${tick + 1}: hull ${hullPct}% | shields ${shieldPct}% — attacking ${target.name}`);

    // Continue attacking
    const atkResp = await bot.exec("attack", { target_id: target.id });
    if (atkResp.error) {
      const msg = atkResp.error.message.toLowerCase();
      if (
        msg.includes("not in battle") || msg.includes("no battle") ||
        msg.includes("battle_over") || msg.includes("destroyed") ||
        msg.includes("dead") || msg.includes("not found")
      ) {
        ctx.log("combat", `${target.name} eliminated`);
        return true;
      }
    }

    await sleep(1000);
  }

  ctx.log("combat", `Combat with ${target.name} reached max ticks`);
  return true;
}

// ── Fleet Hunter Commander Routine ───────────────────────────

export const fleetHunterCommanderRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  await bot.refreshStatus();
  let totalKills = 0;

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

    const settings = getFleetHunterSettings();
    const safetyOpts = {
      fuelThresholdPct: settings.refuelThreshold,
      hullThresholdPct: settings.repairThreshold,
      autoCloak: settings.autoCloak,
    };
    const patrolSystem = settings.patrolSystem || "";

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

    // ── Hull check ──
    await bot.refreshStatus();
    const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    if (hullPct <= settings.repairThreshold) {
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
          const won = await engageTarget(
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
          const won = await engageTarget(
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
