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
import { getBotChatChannel } from "../botmanager.js";
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
  logStatus,
} from "./common.js";
import {
  type NearbyEntity,
  type PirateTier,
  parseNearby,
  isPirateTarget,
  ensureAmmoLoaded,
  emergencyFleeSpam,
  analyzeExistingBattle,
  engageTarget as battleEngageTarget,
} from "./battle.js";
import { getBattleStatus } from "./common.js";

// ── Settings ─────────────────────────────────────────────────

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
  signalChannel: "faction" | "local" | "file" | "chat";
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
    signalChannel: ((e.signalChannel as string) || "chat") as "faction" | "local" | "file" | "chat",
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

// ── Nearby entity parsing ─────────────────────────────────────
// Using parseNearby and isPirateTarget from battle.ts

// ── Combat ─────────────────────────────────────────────────
// Using battle.ts functions for combat detection and engagement

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
    if (!alive) { await ctx.sleep(30000); continue; }

    const settings = getEscortSettings(bot.username);
    const safetyOpts = {
      fuelThresholdPct: settings.refuelThreshold,
      hullThresholdPct: settings.repairThreshold,
    };
    const minerName = settings.minerName;

    if (!minerName) {
      ctx.log("error", "No minerName configured in escort settings — waiting 30s");
      await ctx.sleep(30000);
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
      await ctx.sleep(30000);
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
    } else if (settings.signalChannel === "chat") {
      // Check via bot chat channel (non-API, instant communication)
      ctx.log("escort", `Checking bot chat channel for signals from ${minerName}...`);
      const chatChannel = getBotChatChannel();

      // Check recent messages from the miner in the escort channel
      const recentMessages = chatChannel.getHistory("escort", 50);
      // Find the most recent message from the miner (iterate from end to get latest)
      let chatSignal = null;
      for (let i = recentMessages.length - 1; i >= 0; i--) {
        const msg = recentMessages[i];
        if (msg.sender === minerName) {
          const match = msg.content.match(/\[ESCORT\]\s*(jump|travel|dock|undock)\s*(\S+)?/i);
          if (match) {
            chatSignal = {
              action: match[1].toLowerCase(),
              systemId: match[2] || undefined
            };
          }
          break; // Use the most recent message
        }
      }

      escortSignal = chatSignal;
      
      if (escortSignal) {
        ctx.log("escort", `✓ Found chat signal: ${escortSignal.action} ${escortSignal.systemId || ""}`);
      } else {
        ctx.log("escort", `✗ No chat signal found from ${minerName}`);
      }
    }

    // If primary channel failed, try the other as fallback (including chat)
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
            await ctx.sleep(30000);
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
          await ctx.sleep(15000);
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
      await ctx.sleep(15000);
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

    // Check if we're already in battle (from protecting miner)
    const existingBattle = await getBattleStatus(ctx);
    if (existingBattle) {
      ctx.log("combat", `⚔️ Already in battle (${existingBattle.battle_id}) — continuing fight...`);
      // battle.ts functions will handle the ongoing battle
    }

    const nearbyResp = await bot.exec("get_nearby");
    if (!nearbyResp.error && nearbyResp.result) {
      bot.trackNearbyPlayers(nearbyResp.result);
      const entities = parseNearby(nearbyResp.result);
      const targets = entities.filter(e => isPirateTarget(e, false, settings.maxAttackTier));

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

          // Pre-fight ammo check - use ensureAmmoLoaded since bot.ammo may not reflect module-level ammo
          const hasAmmo = await ensureAmmoLoaded(ctx, settings.ammoThreshold, settings.maxReloadAttempts);
          if (!hasAmmo) {
            ctx.log("combat", "Out of ammo — docking to resupply");
            break;
          }

          yield "engage";
          const won = await battleEngageTarget(ctx, target, settings.fleeThreshold, settings.fleeFromTier, settings.minPiratesToFlee, settings.maxAttackTier);

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
