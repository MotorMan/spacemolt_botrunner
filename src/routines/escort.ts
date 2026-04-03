/**
 * Escort routine — follows and protects a specified miner bot.
 *
 * Loop:
 *   1. Track the miner's current system via faction chat or status polling
 *   2. Jump to the miner's system if not already there
 *   3. Stay near the miner, scanning for hostile players/pirates
 *   4. Engage any threats automatically
 *   5. Flee and dock if hull drops below flee threshold
 *   6. Refuel, repair, resupply as needed
 *
 * The escort mirrors the miner's movements by reading the miner's
 * system from a shared coordination channel (faction chat signals
 * or a coordination file). Multiple escorts can follow one miner.
 *
 * Settings (data/settings.json under "escort"):
 *   minerName       — username of the miner to follow (required)
 *   refuelThreshold — fuel % to trigger refuel stop (default: 40)
 *   repairThreshold — hull % to abort and dock (default: 30)
 *   fleeThreshold   — hull % to flee an active fight (default: 20)
 *   maxAttackTier   — max pirate tier to engage (default: "large")
 *   fleeFromTier    — flee if pirate tier is this high (default: "boss")
 *   minPiratesToFlee — flee if this many pirates present (default: 3)
 *   autoCloak       — use cloak when available (default: false)
 *   ammoThreshold   — ammo level to trigger reload (default: 5)
 *   maxReloadAttempts — max reload retries (default: 3)
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
} from "./common.js";

// ── Settings ─────────────────────────────────────────────────

type PirateTier = "small" | "medium" | "large" | "capitol" | "boss";

const TIER_ORDER: Record<PirateTier, number> = {
  small: 1,
  medium: 2,
  large: 3,
  capitol: 4,
  boss: 5,
};

function getTierLevel(tier: PirateTier | undefined | null): number {
  if (!tier) return 1;
  return TIER_ORDER[tier] ?? 1;
}

function isTierTooHigh(pirateTier: PirateTier | undefined, maxTier: PirateTier): boolean {
  if (!pirateTier) return false;
  return getTierLevel(pirateTier) > getTierLevel(maxTier);
}

function getEscortSettings(username?: string): {
  minerName: string;
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
  const e = all.escort || {};
  const botOverrides = username ? (all[username] || {}) : {};

  return {
    minerName: (botOverrides.minerName as string) || (e.minerName as string) || "",
    refuelThreshold: (e.refuelThreshold as number) || 40,
    repairThreshold: (e.repairThreshold as number) || 30,
    fleeThreshold: (e.fleeThreshold as number) || 20,
    maxAttackTier: ((e.maxAttackTier as PirateTier) || "large") as PirateTier,
    fleeFromTier: ((e.fleeFromTier as PirateTier) || "boss") as PirateTier,
    minPiratesToFlee: (e.minPiratesToFlee as number) || 3,
    autoCloak: (e.autoCloak as boolean) ?? false,
    ammoThreshold: (e.ammoThreshold as number) || 5,
    maxReloadAttempts: (e.maxReloadAttempts as number) || 3,
  };
}

// ── Miner tracking ───────────────────────────────────────────

/**
 * Try to determine the miner's current system.
 * Strategy: check faction chat for miner's location announcements,
 * or fall back to a coordination file.
 */
const MINER_LOCATION_CACHE = new Map<string, { systemId: string; timestamp: number }>();

function setMinerLocation(minerName: string, systemId: string): void {
  MINER_LOCATION_CACHE.set(minerName, { systemId, timestamp: Date.now() });
}

function getMinerLocation(minerName: string): string | null {
  const entry = MINER_LOCATION_CACHE.get(minerName);
  if (!entry) return null;
  // Cache expires after 5 minutes
  if (Date.now() - entry.timestamp > 5 * 60 * 1000) {
    MINER_LOCATION_CACHE.delete(minerName);
    return null;
  }
  return entry.systemId;
}

/** Scan faction chat for miner location messages. */
async function scanFactionForMinerLocation(
  ctx: RoutineContext,
  minerName: string,
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

  // Look for messages from the miner containing system info
  const SYSTEM_PATTERN = /(?:sys_[a-z0-9_]+)/i;
  const LOCATION_KEYWORDS = ["mining at", "heading to", "in system", "at", "traveling to", "jumping to"];

  for (const msg of [...msgs].reverse().slice(0, 50)) {
    const sender = (msg.sender as string) || (msg.username as string) || "";
    const content = (msg.content as string) || (msg.message as string) || (msg.text as string) || "";

    // Check if this is from our miner
    if (sender.toLowerCase() !== minerName.toLowerCase()) continue;

    // Look for system ID pattern in the message
    const sysMatch = content.match(SYSTEM_PATTERN);
    if (sysMatch) {
      return sysMatch[0];
    }

    // Look for location keywords followed by system-like text
    for (const kw of LOCATION_KEYWORDS) {
      const idx = content.toLowerCase().indexOf(kw);
      if (idx >= 0) {
        const after = content.slice(idx + kw.length);
        const match = after.match(SYSTEM_PATTERN);
        if (match) return match[0];
      }
    }
  }

  return null;
}

/**
 * Check if the miner has sent a coordination signal in faction chat.
 * Escorts look for messages like: [ESCORT] jump sys_xxx or [ESCORT] travel sys_xxx
 */
async function checkEscortSignals(
  ctx: RoutineContext,
  minerName: string,
): Promise<{ action: "jump" | "travel" | "dock" | "undock"; systemId?: string } | null> {
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

  const ESCORT_PATTERN = /\[ESCORT\]\s*(jump|travel|dock|undock)\s*(sys_[a-z0-9_]+)?/i;

  for (const msg of [...msgs].reverse().slice(0, 20)) {
    const sender = (msg.sender as string) || (msg.username as string) || "";
    const content = (msg.content as string) || (msg.message as string) || (msg.text as string) || "";

    if (sender.toLowerCase() !== minerName.toLowerCase()) continue;

    const match = content.match(ESCORT_PATTERN);
    if (match) {
      const action = match[1].toLowerCase() as "jump" | "travel" | "dock" | "undock";
      const systemId = match[2];
      return { action, systemId };
    }
  }

  return null;
}

// ── Nearby entity parsing (reused from hunter) ───────────────

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

function isHostileTarget(entity: NearbyEntity, maxAttackTier: PirateTier = "large"): boolean {
  // Always attack pirates
  if (entity.isPirate) {
    if (isTierTooHigh(entity.tier, maxAttackTier)) return false;
    return true;
  }
  // Attack NPCs with pirate-like names/factions
  if (!entity.isNPC) return false;

  const factionMatch = entity.faction ? PIRATE_KEYWORDS.some(kw => entity.faction.includes(kw)) : false;
  const typeMatch = entity.type ? PIRATE_KEYWORDS.some(kw => entity.type.includes(kw)) : false;
  const nameMatch = entity.name ? PIRATE_KEYWORDS.some(kw => entity.name.toLowerCase().includes(kw)) : false;

  return factionMatch || typeMatch || nameMatch;
}

// ── Combat (simplified from hunter) ─────────────────────────

async function engageTarget(
  ctx: RoutineContext,
  target: NearbyEntity,
  fleeThreshold: number,
  fleeFromTier: PirateTier,
  minPiratesToFlee: number,
): Promise<boolean> {
  const { bot } = ctx;

  if (!target.id) return false;

  const scanResp = await bot.exec("scan", { target_id: target.id });
  if (scanResp.error) {
    ctx.log("combat", `Scan failed for ${target.name}: ${scanResp.error.message}`);
  } else if (scanResp.result) {
    const s = scanResp.result as Record<string, unknown>;
    const shipType = (s.ship_type as string) || (s.ship as string) || "unknown";
    const faction = (s.faction as string) || target.faction || "unknown";
    ctx.log("combat", `Scan: ${target.name} — ${shipType} | Faction: ${faction}`);
  }

  ctx.log("combat", `Engaging ${target.name}...`);

  const attackResp = await bot.exec("attack", { target_id: target.id });
  if (attackResp.error) {
    const msg = attackResp.error.message.toLowerCase();
    if (msg.includes("not found") || msg.includes("invalid") ||
        msg.includes("no target") || msg.includes("already in battle")) {
      ctx.log("combat", `${target.name} is no longer available or already fighting`);
      return false;
    }
    ctx.log("error", `Attack attempt on ${target.name}: ${attackResp.error.message}`);
  }

  // Advance up to 3 zones
  for (let zone = 0; zone < 3; zone++) {
    if (bot.state !== "running") return false;

    await bot.refreshStatus();
    const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    if (hullPct <= fleeThreshold) {
      ctx.log("combat", `Hull critical (${hullPct}%) while advancing — fleeing!`);
      await bot.exec("stance", { stance: "flee" });
      return false;
    }

    const advResp = await bot.exec("advance");
    if (advResp.error) break;
  }

  // Main combat loop
  const MAX_COMBAT_TICKS = 30;
  for (let tick = 0; tick < MAX_COMBAT_TICKS; tick++) {
    if (bot.state !== "running") return false;

    await bot.refreshStatus();
    const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    const shieldPct = bot.maxShield > 0 ? Math.round((bot.shield / bot.maxShield) * 100) : 100;

    // Emergency flee
    if (hullPct <= fleeThreshold) {
      ctx.log("combat", `Hull critical (${hullPct}%) — fleeing!`);
      await bot.exec("stance", { stance: "flee" });
      await bot.exec("retreat");
      return false;
    }

    // Check for pirate-based flee conditions
    const nearbyResp = await bot.exec("get_nearby");
    if (!nearbyResp.error && nearbyResp.result) {
      bot.trackNearbyPlayers(nearbyResp.result);

      const entities = parseNearby(nearbyResp.result);
      const pirateCount = entities.filter(e => e.isPirate).length;
      const highestPirateTier = entities
        .filter(e => e.isPirate && e.tier)
        .reduce((max, e) => getTierLevel(e.tier) > getTierLevel(max) ? e.tier! : max, "small" as PirateTier);

      if (pirateCount >= minPiratesToFlee) {
        ctx.log("combat", `Too many pirates (${pirateCount}) — fleeing!`);
        await bot.exec("stance", { stance: "flee" });
        await bot.exec("retreat");
        return false;
      }

      if (isTierTooHigh(highestPirateTier, fleeFromTier)) {
        ctx.log("combat", `Pirate tier too high (${highestPirateTier}) — fleeing!`);
        await bot.exec("stance", { stance: "flee" });
        await bot.exec("retreat");
        return false;
      }
    }

    // Brace when shields critical
    const shieldsCritical = shieldPct < 15 && hullPct < 70;
    if (shieldsCritical) {
      ctx.log("combat", `Bracing (shields ${shieldPct}%, hull ${hullPct}%)`);
      await bot.exec("stance", { stance: "brace" });
    } else {
      await bot.exec("stance", { stance: "fire" });
    }

    ctx.log("combat", `Tick ${tick + 1}: hull ${hullPct}% | shields ${shieldPct}% — attacking ${target.name}`);

    const nearbyCheck = await bot.exec("get_nearby");
    if (!nearbyCheck.error && nearbyCheck.result) {
      bot.trackNearbyPlayers(nearbyCheck.result);
      const entities = parseNearby(nearbyCheck.result);

      if (entities.some(e => e.id === target.id)) {
        const atkResp = await bot.exec("attack", { target_id: target.id });
        if (atkResp.error) {
          const msg = atkResp.error.message.toLowerCase();
          if (msg.includes("not in battle") || msg.includes("no battle") ||
              msg.includes("battle_over") || msg.includes("destroyed") ||
              msg.includes("dead") || msg.includes("not found") ||
              msg.includes("already") || msg.includes("ended")) {
            ctx.log("combat", `${target.name} eliminated`);
            return true;
          }
        }
      } else {
        ctx.log("combat", `${target.name} is gone — eliminated or fled`);
        return true;
      }
    } else {
      const atkResp = await bot.exec("attack", { target_id: target.id });
      if (atkResp.error) {
        const msg = atkResp.error.message.toLowerCase();
        if (msg.includes("not in battle") || msg.includes("no battle") ||
            msg.includes("battle_over") || msg.includes("destroyed") ||
            msg.includes("dead") || msg.includes("not found") ||
            msg.includes("already") || msg.includes("ended")) {
          ctx.log("combat", `${target.name} eliminated`);
          return true;
        }
      }
    }

    const finalCheck = await bot.exec("get_nearby");
    if (!finalCheck.error && finalCheck.result) {
      bot.trackNearbyPlayers(finalCheck.result);
      const entitiesFinal = parseNearby(finalCheck.result);
      if (!entitiesFinal.some(e => e.id === target.id)) {
        ctx.log("combat", `${target.name} is gone — eliminated or fled`);
        return true;
      }
    }
  }

  ctx.log("combat", `Combat with ${target.name} reached max ticks — moving on`);
  return true;
}

// ── Ammo management ──────────────────────────────────────────

async function ensureAmmoLoaded(
  ctx: RoutineContext,
  threshold: number,
  maxAttempts: number,
): Promise<boolean> {
  const { bot } = ctx;
  await bot.refreshStatus();

  if (bot.ammo > threshold) return true;
  if (bot.ammo < 0) return true; // ammo field not supported

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

// ── Safe-system docking (reused from hunter) ─────────────────

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

// ── Escort routine ───────────────────────────────────────────

export const escortRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  await bot.refreshStatus();
  let totalKills = 0;
  let lastMinerSystemCheck = 0;
  const MINER_CHECK_INTERVAL_MS = 15_000; // Check miner location every 15 seconds

  while (bot.state === "running") {
    // ── Death recovery ──
    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) { await sleep(30000); continue; }

    const settings = getEscortSettings(bot.username);
    const safetyOpts = {
      fuelThresholdPct: settings.refuelThreshold,
      hullThresholdPct: settings.repairThreshold,
    };
    const minerName = settings.minerName;

    if (!minerName) {
      ctx.log("error", "No minerName configured in escort settings — waiting 30s");
      await sleep(30000);
      continue;
    }

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
      ctx.log("system", `Hull at ${hullPct}% — retreating to safe system for repairs`);
      yield "emergency_repair";
      const docked = await navigateToSafeStation(ctx, safetyOpts);
      if (docked) {
        await repairShip(ctx);
        await tryRefuel(ctx);
        await ensureInsured(ctx);
        await bot.checkSkills();
        await ensureUndocked(ctx);
      }
      continue;
    }

    // ── Check for escort coordination signals from miner ──
    yield "check_escort_signals";
    const escortSignal = await checkEscortSignals(ctx, minerName);
    if (escortSignal) {
      ctx.log("escort", `Received escort signal: ${escortSignal.action}${escortSignal.systemId ? ` ${escortSignal.systemId}` : ""}`);

      if (escortSignal.action === "dock") {
        ctx.log("escort", "Miner signaling dock — standing by at current location");
        // Stay put, don't dock (we're the bodyguard)
      } else if (escortSignal.action === "undock") {
        ctx.log("escort", "Miner signaling undock — preparing to follow");
        await ensureUndocked(ctx);
      } else if (escortSignal.systemId && (escortSignal.action === "jump" || escortSignal.action === "travel")) {
        const targetSystem = escortSignal.systemId;
        if (targetSystem !== bot.system) {
          ctx.log("escort", `Following miner to ${targetSystem}...`);
          const arrived = await navigateToSystem(ctx, targetSystem, safetyOpts);
          if (arrived) {
            setMinerLocation(minerName, targetSystem);
          } else {
            ctx.log("error", `Failed to reach ${targetSystem}`);
          }
        }
      }
    }

    // ── Determine miner's current system ──
    const now = Date.now();
    if ((now - lastMinerSystemCheck) > MINER_CHECK_INTERVAL_MS) {
      lastMinerSystemCheck = now;

      // Try faction chat first
      let minerSystem = await scanFactionForMinerLocation(ctx, minerName);

      // Fall back to cache
      if (!minerSystem) {
        minerSystem = getMinerLocation(minerName);
      }

      if (minerSystem && minerSystem !== bot.system) {
        ctx.log("escort", `Miner ${minerName} detected in ${minerSystem} — following...`);
        const arrived = await navigateToSystem(ctx, minerSystem, safetyOpts);
        if (!arrived) {
          ctx.log("error", `Could not reach ${minerSystem} — will retry next cycle`);
          await sleep(30000);
          continue;
        }
      }
    }

    if (bot.state !== "running") break;

    // ── Ensure we're undocked for patrol ──
    await ensureUndocked(ctx);

    // ── Scan system for threats ──
    yield "scan_system";
    await fetchSecurityLevel(ctx, bot.system);
    const { pois } = await getSystemInfo(ctx);

    // ── Patrol nearby POIs for threats ──
    const patrolPois = pois.filter(p => !isStationPoi(p));

    if (patrolPois.length === 0) {
      ctx.log("info", "No POIs to patrol — staying near station");
      await sleep(10000);
      continue;
    }

    ctx.log("escort", `Patrolling ${patrolPois.length} POI(s) in ${bot.system}...`);

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

      // Scan for hostile targets
      yield "scan_for_targets";
      const nearbyResp = await bot.exec("get_nearby");
      if (nearbyResp.error) {
        ctx.log("error", `get_nearby at ${poi.name}: ${nearbyResp.error.message}`);
        continue;
      }

      bot.trackNearbyPlayers(nearbyResp.result);

      const entities = parseNearby(nearbyResp.result);
      const targets = entities.filter(e => isHostileTarget(e, settings.maxAttackTier));

      if (targets.length === 0) {
        ctx.log("escort", `No threats at ${poi.name}`);
        await scavengeWrecks(ctx);
        continue;
      }

      ctx.log("combat", `Found ${targets.length} hostile(s) at ${poi.name}: ${targets.map(t => t.name).join(", ")}`);

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
        if (bot.ammo === 0) {
          ctx.log("combat", "Out of ammo — aborting patrol to resupply");
          abortPatrol = true;
          break;
        }

        yield "engage";
        const won = await engageTarget(ctx, target, settings.fleeThreshold, settings.fleeFromTier, settings.minPiratesToFlee);

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

      yield "sell_loot";
      await bot.refreshCargo();
      for (const item of bot.inventory) {
        if (item.itemId.toLowerCase().includes("fuel") || item.itemId.toLowerCase().includes("energy_cell") || item.itemId.toLowerCase().includes("repair")) continue;
        ctx.log("trade", `Selling ${item.quantity}x ${item.name}...`);
        await bot.exec("sell", { item_id: item.itemId, quantity: item.quantity });
      }

      yield "refuel";
      await tryRefuel(ctx);

      yield "repair";
      await repairShip(ctx);

      yield "reload";
      await ensureAmmoLoaded(ctx, settings.ammoThreshold, settings.maxReloadAttempts);

      yield "fit_mods";
      const modProfile = getModProfile("hunter"); // Use hunter mod profile
      if (modProfile.length > 0) await ensureModsFitted(ctx, modProfile);

      yield "check_skills";
      await bot.checkSkills();

      ctx.log("info", `Escort cycle complete. Total kills: ${totalKills} | Credits: ${bot.credits} ===`);

    } else {
      ctx.log("system", `Patrol sweep done — ${patrolKills} kill(s). Hull: ${postHull}% | Fuel: ${postFuel}% — continuing escort...`);
    }
  }
};
