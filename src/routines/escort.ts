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
  signalChannel: "faction" | "local" | "file";
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
    signalChannel: ((e.signalChannel as string) || "file") as "faction" | "local" | "file",
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

  // Strategy 1: Check faction chat
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

/**
 * Check for file-based escort signals from the miner.
 * This is more reliable than faction chat if both bots run on the same machine.
 */
async function checkFileEscortSignals(
  minerName: string,
): Promise<{ action: "jump" | "travel" | "dock" | "undock"; systemId?: string; timestamp: number } | null> {
  try {
    const { readFileSync, existsSync } = await import("fs");
    const { join } = await import("path");
    const signalFile = join(process.cwd(), "data", "escort_signals", `${minerName}.signal`);
    
    if (!existsSync(signalFile)) return null;
    
    const content = readFileSync(signalFile, "utf-8");
    const signal = JSON.parse(content) as { action: string; systemId?: string; timestamp: number };
    
    // Check if signal is recent (within last 5 minutes)
    if (Date.now() - signal.timestamp > 5 * 60 * 1000) {
      return null; // Signal too old
    }
    
    return {
      action: signal.action as "jump" | "travel" | "dock" | "undock",
      systemId: signal.systemId,
      timestamp: signal.timestamp,
    };
  } catch {
    return null;
  }
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

// ── Security zone detection ─────────────────────────────────

/**
 * Check if the current system has security/police monitoring.
 * Returns true if the system is monitored (NOT lawless).
 * In these systems, we should NOT attack back to avoid police retaliation.
 */
function isSecurityMonitoredSystem(securityLevel: string | undefined): boolean {
  if (!securityLevel) return false;
  const level = securityLevel.toLowerCase().trim();

  // Empire/high security systems are monitored
  if (level.includes("high") || level.includes("maximum") || level.includes("empire")) {
    return true;
  }

  // Medium security is also monitored
  if (level.includes("medium") || level.includes("moderate")) {
    return true;
  }

  // Lawless/null systems are NOT monitored (safe to fight)
  if (level.includes("lawless") || level.includes("null") || level.includes("unregulated")) {
    return false;
  }

  // Low security/frontier may or may not be monitored - treat as monitored to be safe
  if (level.includes("low") || level.includes("frontier")) {
    return true;
  }

  // Numeric security > 25 is considered monitored
  const numeric = parseInt(level, 10);
  if (!isNaN(numeric) && numeric > 25) {
    return true;
  }

  // Default to true if we can't determine - better safe than sorry
  return false;
}

// ── Combat (simplified from hunter) ─────────────────────────

async function engageTarget(
  ctx: RoutineContext,
  target: NearbyEntity,
  fleeThreshold: number,
  fleeFromTier: PirateTier,
  minPiratesToFlee: number,
  securityMonitored: boolean,
): Promise<boolean> {
  const { bot } = ctx;

  if (!target.id) return false;

  // If we're in a security monitored system, DO NOT attack - flee instead
  if (securityMonitored) {
    ctx.log("combat", `⚠ SECURITY MONITORED ZONE - Cannot attack ${target.name} - fleeing to avoid police!`);
    await bot.exec("stance", { stance: "flee" });
    return false;
  }

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

    // Emergency flee if hull critical
    if (hullPct <= fleeThreshold) {
      ctx.log("combat", `Hull critical (${hullPct}%) — fleeing!`);
      await bot.exec("stance", { stance: "flee" });
      await bot.exec("retreat");
      return false;
    }

    // If in security monitored space, keep fleeing every tick
    if (securityMonitored) {
      ctx.log("combat", `Security monitored zone - issuing flee command (tick ${tick + 1})`);
      await bot.exec("stance", { stance: "flee" });
      
      // Check if we've successfully fled the combat
      const nearbyCheck = await bot.exec("get_nearby");
      if (!nearbyCheck.error && nearbyCheck.result) {
        bot.trackNearbyPlayers(nearbyCheck.result);
        const entities = parseNearby(nearbyCheck.result);
        
        // If target is no longer nearby, we've successfully fled
        if (!entities.some(e => e.id === target.id)) {
          ctx.log("combat", `Successfully fled from ${target.name} in security monitored zone`);
          return false;
        }
      }
      
      // Continue fleeing for a few ticks before giving up
      if (tick >= 10) {
        ctx.log("combat", `Could not escape ${target.name} after 10 ticks in monitored zone - attempting retreat`);
        await bot.exec("retreat");
        return false;
      }
      
      continue;
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
  const MINER_CHECK_INTERVAL_MS = 10_000; // Check miner location every 10 seconds
  let minerSystem: string | null = null;
  let consecutiveFailedChecks = 0;
  const MAX_FAILED_CHECKS = 5; // After this many failures, dock and wait

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

    // Check signals based on configured channel preference
    let escortSignal = null;
    
    ctx.log("escort", `Checking for signals from ${minerName} via ${settings.signalChannel}...`);

    if (settings.signalChannel === "file") {
      // File-based signals (most reliable if on same machine)
      ctx.log("escort", `Checking file signal: data/escort_signals/${minerName}.signal`);
      escortSignal = await checkFileEscortSignals(minerName);
      if (escortSignal) {
        ctx.log("escort", `✓ Found file signal: ${escortSignal.action} ${escortSignal.systemId || ''}`);
      } else {
        ctx.log("escort", `✗ No valid file signal found`);
      }
    } else if (settings.signalChannel === "faction") {
      // Faction chat signals
      ctx.log("escort", `Checking faction chat for signals from ${minerName}...`);
      escortSignal = await checkEscortSignals(ctx, minerName);
      if (escortSignal) {
        ctx.log("escort", `✓ Found faction chat signal: ${escortSignal.action} ${escortSignal.systemId || ''}`);
      } else {
        ctx.log("escort", `✗ No faction chat signal found from ${minerName}`);
      }
    }

    // If primary channel failed, try the other as fallback
    if (!escortSignal && settings.signalChannel === "file") {
      ctx.log("escort", `Falling back to faction chat check...`);
      escortSignal = await checkEscortSignals(ctx, minerName);
    } else if (!escortSignal && settings.signalChannel === "faction") {
      ctx.log("escort", `Falling back to file signal check...`);
      escortSignal = await checkFileEscortSignals(minerName);
    }

    if (escortSignal) {
      ctx.log("escort", `Received escort signal: ${escortSignal.action}${escortSignal.systemId ? ` ${escortSignal.systemId}` : ""}`);
      consecutiveFailedChecks = 0; // Reset failure counter on successful signal

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
          
          // Add onJump callback to re-check miner location after each jump
          const jumpSafetyOpts = {
            ...safetyOpts,
            onJump: async (jumpNumber: number) => {
              // Re-check miner location after each jump
              if (ctx.getFleetStatus) {
                const fleetStatus = ctx.getFleetStatus();
                const minerBot = fleetStatus.find(b => b.username?.toLowerCase() === minerName.toLowerCase());
                if (minerBot?.system && minerBot.system !== targetSystem) {
                  ctx.log("escort", `⚠ Miner moved from ${targetSystem} to ${minerBot.system} during travel (after jump ${jumpNumber}) — recalculating route...`);
                  // Note: We continue to original target since signal was explicit
                  // But we update our tracking variable
                  minerSystem = minerBot.system;
                  setMinerLocation(minerName, minerBot.system);
                }
              }
              return true; // Continue navigation
            },
          };
          
          const arrived = await navigateToSystem(ctx, targetSystem, jumpSafetyOpts);
          if (arrived) {
            minerSystem = targetSystem;
            setMinerLocation(minerName, targetSystem);
            consecutiveFailedChecks = 0;
          } else {
            ctx.log("error", `Failed to reach ${targetSystem}`);
            consecutiveFailedChecks++;
          }
        } else {
          ctx.log("escort", `Already in ${targetSystem} — standing by`);
          minerSystem = targetSystem;
          setMinerLocation(minerName, targetSystem);
        }
      }
    } else {
      ctx.log("escort", `⚠ No signals received from ${minerName}`);
    }

    // ── Determine miner's current system (fallback if no signal) ──
    const now = Date.now();
    if ((now - lastMinerSystemCheck) > MINER_CHECK_INTERVAL_MS) {
      lastMinerSystemCheck = now;

      // If we already have a recent signal, use that
      if (!minerSystem) {
        // Strategy 1: Try to get miner's status directly from fleet (most reliable!)
        let detectedSystem: string | null = null;
        
        if (ctx.getFleetStatus) {
          const fleetStatus = ctx.getFleetStatus();
          const minerBot = fleetStatus.find(b => b.username?.toLowerCase() === minerName.toLowerCase());
          if (minerBot?.system) {
            detectedSystem = minerBot.system;
            ctx.log("escort", `✓ Located miner via fleet status: ${minerName} is in ${detectedSystem}`);
          }
        }

        // Strategy 2: Try faction chat scan if direct status failed
        if (!detectedSystem) {
          detectedSystem = await scanFactionForMinerLocation(ctx, minerName);
          if (detectedSystem) {
            ctx.log("escort", `✓ Located miner via faction chat scan: ${detectedSystem}`);
          }
        }

        // Strategy 3: Check cache
        if (!detectedSystem) {
          detectedSystem = getMinerLocation(minerName);
          if (detectedSystem) {
            ctx.log("escort", `✓ Located miner via cache: ${detectedSystem}`);
          }
        }

        if (detectedSystem) {
          minerSystem = detectedSystem;
          consecutiveFailedChecks = 0;
        } else {
          consecutiveFailedChecks++;
          ctx.log("escort", `✗ Cannot determine miner location (attempt ${consecutiveFailedChecks}/${MAX_FAILED_CHECKS})`);

          if (consecutiveFailedChecks >= MAX_FAILED_CHECKS) {
            ctx.log("escort", `⚠ Too many failed location checks — docking and waiting for signal...`);
            const docked = await navigateToSafeStation(ctx, safetyOpts);
            if (docked) {
              await tryRefuel(ctx);
              await repairShip(ctx);
              await ensureUndocked(ctx);
            }
            consecutiveFailedChecks = 0;
            await sleep(30000);
            continue;
          }
        }
      }

      // If miner is in a different system, jump to them
      if (minerSystem && minerSystem !== bot.system) {
        ctx.log("escort", `Miner ${minerName} detected in ${minerSystem} — following...`);
        
        // Add onJump callback to re-check miner location after each jump
        const jumpSafetyOpts = {
          ...safetyOpts,
          onJump: async (jumpNumber: number) => {
            // Re-check miner location after each jump
            if (ctx.getFleetStatus) {
              const fleetStatus = ctx.getFleetStatus();
              const minerBot = fleetStatus.find(b => b.username?.toLowerCase() === minerName.toLowerCase());
              if (minerBot?.system && minerBot.system !== minerSystem) {
                ctx.log("escort", `⚠ Miner moved from ${minerSystem} to ${minerBot.system} during travel (after jump ${jumpNumber}) — recalculating route...`);
                minerSystem = minerBot.system;
                // Update cache with new location
                setMinerLocation(minerName, minerBot.system);
              }
              // Also track POI if available
              if (minerBot?.poi) {
                ctx.log("escort", `Miner POI during travel: ${minerBot.poi}`);
              }
            }
            return true; // Continue navigation
          },
        };
        
        const arrived = await navigateToSystem(ctx, minerSystem, jumpSafetyOpts);
        if (!arrived) {
          ctx.log("error", `Could not reach ${minerSystem} — will retry next cycle`);
          consecutiveFailedChecks++;
          await sleep(15000);
          continue;
        }
        consecutiveFailedChecks = 0;
        // Update cache with current location
        setMinerLocation(minerName, minerSystem);
        ctx.log("escort", `✓ Successfully joined miner in ${minerSystem}`);
      } else if (minerSystem) {
        ctx.log("escort", `✓ Already in same system as miner (${minerSystem})`);
        // Update cache with current location
        setMinerLocation(minerName, minerSystem);
      }
    }

    if (bot.state !== "running") break;

    // ── If we don't know where the miner is, DOCK and wait ──
    if (!minerSystem) {
      ctx.log("escort", `⚠ Miner location unknown — docking and waiting for signals...`);
      const docked = await navigateToSafeStation(ctx, safetyOpts);
      if (docked) {
        await tryRefuel(ctx);
        await repairShip(ctx);
      }
      await sleep(15000);
      continue;
    }

    // ── Ensure we're undocked ──
    await ensureUndocked(ctx);

    // ── TRAVEL TO MINER'S POI ──
    // The escort must be at the SAME POI as the miner to get pulled into battles
    yield "travel_to_miner_poi";
    
    let minerPoi: string | null = null;
    let minerPoiName: string | null = null;
    let validPoi = false;
    
    // Get miner's POI from fleet status
    if (ctx.getFleetStatus) {
      const fleetStatus = ctx.getFleetStatus();
      const minerBot = fleetStatus.find(b => b.username?.toLowerCase() === minerName.toLowerCase());
      if (minerBot?.poi) {
        minerPoi = minerBot.poi;
        minerPoiName = minerBot.poi;
        ctx.log("escort", `Miner ${minerName} is at POI: ${minerPoiName}`);
      }
    }
    
    // Validate POI exists in current system before trying to travel
    if (minerPoi) {
      const { pois } = await getSystemInfo(ctx);
      const poiExists = pois.some(p => p.id === minerPoi || p.name === minerPoi);
      
      if (poiExists) {
        validPoi = true;
        ctx.log("escort", `✓ POI ${minerPoiName} exists in ${bot.system}`);
      } else {
        ctx.log("warn", `POI ${minerPoiName} not found in ${bot.system} — miner may be at a sub-POI or resource node`);
      }
    }
    
    // Travel to miner's POI if it's valid and we're not already there
    if (validPoi && minerPoi && bot.poi !== minerPoi) {
      ctx.log("escort", `Traveling to miner's POI: ${minerPoiName}...`);
      const travelResp = await bot.exec("travel", { target_poi: minerPoi });
      if (travelResp.error) {
        const msg = travelResp.error.message.toLowerCase();
        if (!msg.includes("already") && !msg.includes("arrived")) {
          ctx.log("warn", `Could not travel to miner's POI: ${travelResp.error.message} — will scan system-wide`);
        } else {
          bot.poi = minerPoi;
          ctx.log("escort", `✓ Arrived at miner's POI: ${minerPoiName}`);
        }
      } else {
        bot.poi = minerPoi;
        ctx.log("escort", `✓ Traveling to miner's POI: ${minerPoiName}`);
      }
    } else if (validPoi && minerPoi) {
      ctx.log("escort", `✓ Already at miner's POI: ${minerPoiName}`);
    } else if (minerPoi) {
      ctx.log("warn", `Invalid POI ${minerPoiName} — scanning system-wide for threats`);
    } else {
      ctx.log("warn", "Could not determine miner's POI — scanning system-wide for threats");
    }

    // ── STAY PUT: Do not patrol POIs ──
    // The escort should remain at the miner's current POI (or system-wide if POI invalid)
    // to be available for combat when the miner is attacked
    yield "standby";
    ctx.log("escort", `Standing by at ${validPoi ? minerPoiName : bot.system} — monitoring for threats to miner...`);
    
    // Scan for nearby hostiles that might threaten the miner
    yield "scan_system";
    await fetchSecurityLevel(ctx, bot.system);

    // Check if we're in a security monitored system
    const currentSystemSecurity = mapStore.getSystem(bot.system)?.security_level;
    const securityMonitored = isSecurityMonitoredSystem(currentSystemSecurity);
    
    if (securityMonitored) {
      ctx.log("combat", `⚠ SECURITY MONITORED ZONE detected (${currentSystemSecurity}) - will flee from attackers instead of fighting back`);
    } else {
      ctx.log("combat", `✓ Lawless space detected (${currentSystemSecurity}) - free to engage hostiles`);
    }

    const nearbyResp = await bot.exec("get_nearby");
    if (!nearbyResp.error && nearbyResp.result) {
      bot.trackNearbyPlayers(nearbyResp.result);
      const entities = parseNearby(nearbyResp.result);
      const targets = entities.filter(e => isHostileTarget(e, settings.maxAttackTier));

      if (targets.length > 0) {
        ctx.log("combat", `Found ${targets.length} hostile(s) in system: ${targets.map(t => t.name).join(", ")}`);

        // Engage threats
        for (const target of targets) {
          if (bot.state !== "running") break;

          await bot.refreshStatus();
          const preHull = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
          if (preHull <= settings.repairThreshold) {
            ctx.log("system", `Hull at ${preHull}% — too low for combat, docking...`);
            break;
          }

          // Pre-fight ammo check
          if (bot.ammo === 0) {
            ctx.log("combat", "Out of ammo — docking to resupply");
            break;
          }

          yield "engage";
          const won = await engageTarget(ctx, target, settings.fleeThreshold, settings.fleeFromTier, settings.minPiratesToFlee, securityMonitored);

          if (won) {
            totalKills++;
            ctx.log("combat", `Kill #${totalKills} — looting wreck...`);

            yield "loot";
            await scavengeWrecks(ctx);

            // Post-kill reload
            const hasAmmo = await ensureAmmoLoaded(ctx, settings.ammoThreshold, settings.maxReloadAttempts);
            if (!hasAmmo) {
              ctx.log("combat", "No ammo after kill — docking to resupply");
              break;
            }

            await bot.refreshStatus();
            ctx.log("combat", `Post-fight: hull ${bot.hull}/${bot.maxHull} | ammo ${bot.ammo} | credits ${bot.credits}`);
          } else {
            ctx.log("combat", "Retreated — docking to repair");
            break;
          }
        }
      } else {
        ctx.log("escort", `No threats in ${bot.system} — standing by`);
      }
    }

    // ── PERIODIC MINER LOCATION CHECK ──
    // Verify the miner is still in this system - if not, follow them
    yield "verify_miner_location";
    
    let minerStillHere = false;
    
    // Check 1: Look for miner in nearby entities
    if (nearbyResp.result) {
      const entities = parseNearby(nearbyResp.result);
      const minerFound = entities.find(e => e.name?.toLowerCase() === minerName.toLowerCase());
      if (minerFound) {
        minerStillHere = true;
        ctx.log("escort", `✓ Miner ${minerName} spotted nearby`);
      }
    }
    
    // Check 2: If not in nearby, check fleet status
    if (!minerStillHere && ctx.getFleetStatus) {
      const fleetStatus = ctx.getFleetStatus();
      const minerBot = fleetStatus.find(b => b.username?.toLowerCase() === minerName.toLowerCase());
      
      if (minerBot?.system) {
        const normalizeSystemName = (name: string) => name.toLowerCase().replace(/_/g, ' ').trim();
        
        if (normalizeSystemName(minerBot.system) !== normalizeSystemName(bot.system)) {
          ctx.log("escort", `⚠ Miner ${minerName} has moved to ${minerBot.system} — following...`);
          minerSystem = minerBot.system;
          setMinerLocation(minerName, minerBot.system);
          
          // Follow the miner immediately
          const arrived = await navigateToSystem(ctx, minerSystem, safetyOpts);
          if (arrived) {
            ctx.log("escort", `✓ Successfully followed miner to ${minerSystem}`);
            // Continue to next cycle to re-sync at new location
            continue;
          } else {
            ctx.log("error", `Failed to follow miner to ${minerSystem}`);
          }
        } else {
          minerStillHere = true;
          ctx.log("escort", `✓ Miner still in ${bot.system} (not nearby, but same system)`);
          
          // Update POI tracking if miner moved to a different POI
          if (minerBot.poi && minerBot.poi !== minerPoi) {
            ctx.log("escort", `Miner moved to POI: ${minerBot.poi} — traveling to join...`);
            minerPoi = minerBot.poi;
            minerPoiName = minerBot.poi;
            // Next cycle will handle POI travel
          }
        }
      }
    }
    
    if (!minerStillHere) {
      ctx.log("warn", "Could not verify miner location — will re-check next cycle");
    }

    // ── Post-cycle decision ──
    yield "post_cycle";
    await bot.refreshStatus();
    const postHull = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    const postFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;

    const needsRepair = postHull <= settings.repairThreshold;
    const needsFuel = postFuel < settings.refuelThreshold;

    if (needsRepair || needsFuel) {
      const reason = needsRepair ? `hull ${postHull}%` : `fuel ${postFuel}%`;
      ctx.log("system", `Cycle complete — docking (${reason})...`);

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

      yield "undock";
      await ensureUndocked(ctx);

      ctx.log("info", `Escort cycle complete. Total kills: ${totalKills} | Credits: ${bot.credits} ===`);
    } else {
      ctx.log("system", `Cycle complete. Hull: ${postHull}% | Fuel: ${postFuel}% — continuing escort...`);
    }
  }
};
