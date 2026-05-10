/**
 * Escort routine — follows and protects a specified miner/salvager bot.
 *
 * Loop:
 *   1. Track the escorted bot's system via bot chat and fleet status
 *   2. Jump to the escorted bot's system when it moves
 *   3. Stay in the same system, scanning for hostile players/pirates
 *   4. Get pulled into battles automatically when escorted bot fights
 *   5. Engage any threats automatically (proactive and reactive)
 *   6. Flee and dock if hull drops below flee threshold
 *   7. Refuel, repair, resupply as needed
 *
 * The escort follows the escorted bot's movements by reading announcements
 * from the private bot chat channel. The escorted bot sends "Going to [system]"
 * and "Jumping to [system]" messages. Multiple escorts can follow one bot.
 *
 * Settings (data/settings.json under "escort"):
 *   minerName       — username of the bot to follow (required)
 *   refuelThreshold — fuel % to trigger refuel stop (default: 40)
 *   repairThreshold — hull % to abort and dock (default: 30)
 *   fleeThreshold   — hull % to flee an active fight (default: 20)
 *   maxAttackTier   — max pirate tier to engage proactively (default: "boss")
 *   fleeFromTier    — flee if pirate tier is this high (default: "boss")
 *   minPiratesToFlee — flee if this many pirates present (default: 3)
 *   autoCloak       — use cloak when available (default: false)
 *   ammoThreshold   — ammo level to trigger reload (default: 5)
 *   maxReloadAttempts — max reload retries (default: 3)
 *
 * Home system is automatically determined from general.factionStorageSystem (default: "sol")
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
  getBattleStatus,
  fleeFromBattle,
  checkAndFleeFromBattle,
  checkBattleAfterCommand,
  type BattleState,
  handleBattleNotifications,
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
  fightJoinedBattle,
} from "./battle.js";

// ── Tier helpers ─────────────────────────────────────────────

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

// ── Route helpers ─────────────────────────────────────────────

function getJumpsToSystem(fromSystemId: string, toSystemId: string): number {
  if (fromSystemId === toSystemId) return 0;

  const visited = new Set<string>();
  const queue: [string, number][] = [[fromSystemId, 0]];

  while (queue.length > 0) {
    const [current, jumps] = queue.shift()!;
    if (current === toSystemId) return jumps;

    for (const conn of mapStore.getConnections(current)) {
      if (!visited.has(conn.system_id)) {
        visited.add(conn.system_id);
        queue.push([conn.system_id, jumps + 1]);
      }
    }
  }

  return -1; // not reachable
}

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
  homeSystem: string;
} {
  const all = readSettings();
  const general = (all.general as Record<string, unknown>) || {};
  const e = all.escort || {};
  const botOverrides = username ? (all[username] || {}) : {};

  return {
    minerName: (botOverrides.minerName as string) || (e.minerName as string) || "",
    refuelThreshold: (e.refuelThreshold as number) || 40,
    repairThreshold: (e.repairThreshold as number) || 30,
    fleeThreshold: 0, // Escorts never flee - they protect at all costs
    maxAttackTier: ((e.maxAttackTier as PirateTier) || "boss") as PirateTier,
    fleeFromTier: ((e.fleeFromTier as PirateTier) || "boss") as PirateTier,
    minPiratesToFlee: (e.minPiratesToFlee as number) || 3,
    autoCloak: (e.autoCloak as boolean) ?? false,
    ammoThreshold: (e.ammoThreshold as number) || 5,
    maxReloadAttempts: (e.maxReloadAttempts as number) || 3,
    homeSystem: (botOverrides.homeSystem as string) || (e.homeSystem as string) || (general.factionStorageSystem as string) || "sol",
  };
}

// ── Miner tracking ───────────────────────────────────────────

const MINER_LOCATION_CACHE = new Map<string, { systemId: string; timestamp: number }>();

function setMinerLocation(minerName: string, systemId: string): void {
  MINER_LOCATION_CACHE.set(minerName, { systemId, timestamp: Date.now() });
}

function getMinerLocation(minerName: string): string | null {
  const entry = MINER_LOCATION_CACHE.get(minerName);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > 5 * 60 * 1000) {
    MINER_LOCATION_CACHE.delete(minerName);
    return null;
  }
  return entry.systemId;
}





// ── Fuel cell collection ─────────────────────────────────────

async function collectFuelCells(ctx: RoutineContext): Promise<boolean> {
  const { bot } = ctx;

  if (!bot.docked) return false;

  await bot.refreshCargo();
  const availableSpace = bot.cargoMax - bot.cargo;

  // Reserve half inventory for ammo and repair, use other half for premium fuel cells
  // Premium fuel cells take 2 cargo slots each
  const fuelCellSpace = Math.floor(bot.cargoMax / 2);
  const maxPremiumFuelCells = Math.floor(fuelCellSpace / 2); // Each premium fuel cell takes 2 slots

  if (availableSpace < 2) {
    ctx.log("system", "Not enough cargo space for premium fuel cells");
    return false;
  }

  await bot.refreshFactionStorage();
  const factionPremium = bot.factionStorage?.find(i => i.itemId === "premium_fuel_cell");
  if (!factionPremium || factionPremium.quantity < 1) {
    ctx.log("system", "No premium fuel cells in faction storage");
    return false;
  }

  // Withdraw up to half inventory capacity worth of premium fuel cells (accounting for 2 slots each)
  const toWithdraw = Math.min(maxPremiumFuelCells, factionPremium.quantity, Math.floor(availableSpace / 2), 200);
  ctx.log("system", `Withdrawing ${toWithdraw} premium fuel cells from faction storage (half inventory capacity, 2 slots each)...`);

  const withdrawResp = await bot.exec("storage", { action: 'withdraw', item_id: "premium_fuel_cell", quantity: toWithdraw, target: "faction" });

  if (withdrawResp.error) {
    ctx.log("error", `Failed to withdraw premium fuel cells: ${withdrawResp.error.message}`);
    return false;
  } else {
    ctx.log("system", `Successfully withdrew ${toWithdraw} premium fuel cells`);
    await bot.refreshCargo();
    return true;
  }
}

// ── Nearby entity parsing ─────────────────────────────────────
// Using parseNearby and isPirateTarget from battle.ts

// ── Combat ─────────────────────────────────────────────────
// Using battle.ts functions for combat detection and engagement

// ── Battle analysis for escort ───────────────────────────────

async function analyzeEscortBattle(
  ctx: RoutineContext,
  maxAttackTier: PirateTier,
  minPiratesToFlee: number,
  minerName: string,
): Promise<{ shouldJoin: boolean; sideId?: number; reason: string; pirateCount: number }> {
  const battleStatus = await getBattleStatus(ctx);
  if (!battleStatus) {
    return { shouldJoin: false, reason: "No active battle detected", pirateCount: 0 };
  }

  ctx.log("combat", `📊 Escort battle analysis: ${battleStatus.battle_id}`);
  ctx.log("combat", `   Sides: ${battleStatus.sides.length} | Participants: ${battleStatus.participants.length}`);

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
    `Side ${s.sideId}: ${s.playerCount}p [${s.playerNames.join(",")}] vs ${s.pirateCount}pir [${s.pirateNames.join(",")}]`
  ).join(" | ")}`);

  // Check if any fleet member is in the battle - if so, join their side regardless of PvP
  const fleetStatus = ctx.getFleetStatus ? ctx.getFleetStatus() : [];
  const fleetUsernames = new Set(fleetStatus.map(b => (b.username || "").toLowerCase()));

  const fleetInBattle = battleStatus.participants.find(p =>
    fleetUsernames.has((p.username || "").toLowerCase())
  );

  if (fleetInBattle) {
    const fleetSide = sideInfo.find(s => s.sideId === fleetInBattle.side_id);
    if (fleetSide) {
      const isMiner = (fleetInBattle.username || "").toLowerCase() === minerName.toLowerCase();
      return {
        shouldJoin: true,
        sideId: fleetSide.sideId,
        reason: `${isMiner ? 'Miner' : 'Fleet member'} ${fleetInBattle.username} is in battle — escort joining their side`,
        pirateCount: fleetSide.pirateCount,
      };
    }
  }

  const playerVsPirateSides = sideInfo.filter(s => s.playerCount > 0 && s.pirateCount > 0);

  if (playerVsPirateSides.length === 0) {
    const nonPirateParticipants = battleStatus.participants.filter(p => {
      const u = (p.username || "").toLowerCase();
      return !u.includes("pirate") && !u.includes("drifter") && !p.username?.startsWith("[POLICE]");
    });
    if (nonPirateParticipants.length >= 2 && battleStatus.sides.length >= 2) {
      return { shouldJoin: false, reason: "PvP battle — escort staying out", pirateCount: 0 };
    }
    return { shouldJoin: false, reason: "Pirate vs pirate — escort not engaging", pirateCount: 0 };
  }

  const sideToJoin = playerVsPirateSides.find(s => s.playerCount > 0);
  if (!sideToJoin) {
    return { shouldJoin: false, reason: "Could not determine escort's side", pirateCount: 0 };
  }

  const opposingSide = sideInfo.find(s => s.sideId !== sideToJoin.sideId);
  const opposingPirateCount = opposingSide?.pirateCount || 0;

  return {
    shouldJoin: true,
    sideId: sideToJoin.sideId,
    reason: `Escort joining side ${sideToJoin.sideId} (${sideToJoin.playerCount} player(s)) vs ${opposingPirateCount} pirate(s)`,
    pirateCount: opposingPirateCount,
  };
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

async function checkEscortSignals(
  ctx: RoutineContext,
  minerName: string,
): Promise<{ action: string; systemId?: string } | null> {
  const { bot } = ctx;

  ctx.log("escort", `Checking bot chat channel for signals from ${minerName}...`);
  const chatChannel = getBotChatChannel();

  // Check recent messages from the miner in the escort channel
  const recentMessages = chatChannel.getHistory("escort", 50);
  ctx.log("escort", `Found ${recentMessages.length} messages in escort channel`);
  // Find the most recent message from the miner (iterate from end to get latest)
  let escortSignal = null;
  for (let i = recentMessages.length - 1; i >= 0; i--) {
    const msg = recentMessages[i];
    if (msg.sender?.toLowerCase() === minerName.toLowerCase()) {
      let match = msg.content.match(/\[ESCORT\]\s*(jump|travel|dock|undock)\s*(\S+)?/i);
      if (match) {
        escortSignal = {
          action: match[1].toLowerCase() as "jump" | "travel" | "dock" | "undock",
          systemId: match[2] || undefined
        };
      } else {
        // Check for general announcements
            match = msg.content.match(/(?:Going to|Jumping to)\s*([a-z0-9_]+)/i);
        if (match) {
          const action = match[1].toLowerCase().replace(' ', '_');
          escortSignal = {
            action: action as "going_to" | "jumping_to",
            systemId: match[2]
          };
        } else {
          // Check for location response
          const locMatch = msg.content.match(/^LOCATION: (\w+)$/);
          if (locMatch) {
            escortSignal = {
              action: "location_update",
              systemId: locMatch[1]
            };
          }
        }
      }
      break; // Use the most recent message
    }
  }

  if (escortSignal) {
    ctx.log("escort", `✓ Found chat signal: ${escortSignal.action} ${escortSignal.systemId || ""}`);
  } else {
    ctx.log("escort", `✗ No chat signal found from ${minerName}`);
    // Log some recent messages for debugging
    const sampleMessages = recentMessages.slice(-5).map(m => `${m.sender}: ${m.content}`).join(" | ");
    ctx.log("escort", `Recent escort messages: ${sampleMessages}`);
  }

  return escortSignal;
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

  const battleRef = { state: null as BattleState | null };
  battleRef.state = {
    inBattle: false,
    battleId: null,
    battleStartTick: null,
    lastHitTick: null,
    isFleeing: false,
    lastFleeTime: undefined,
  };

  await bot.refreshStatus();
  let totalKills = 0;
  let lastMinerSystemCheck = 0;
  const MINER_CHECK_INTERVAL_MS = 2_000;
  let minerSystem: string | null = null;
  let consecutiveFailedChecks = 0;
  const MAX_FAILED_CHECKS = 5;
  let lastQueryTime = 0;

  while (bot.state === "running") {
    // ── Death recovery ──
    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) { await ctx.sleep(30000); continue; }

    // ── Fast battle detection via WebSocket (no API call) ──
    if (bot.isInBattle()) {
      battleRef.state.inBattle = true;
      ctx.log("combat", "[WebSocket] Battle detected — will handle in combat section");
    }

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

    // ── Check for escort coordination signals from miner ──
    yield "check_escort_signals";
    let escortSignal: { action: string; systemId?: string } | null = null;
    escortSignal = await checkEscortSignals(ctx, minerName);

    // Handle signals - for jump/travel, just store target, navigation happens later
    if (escortSignal) {
      ctx.log("escort", `Received escort signal: ${escortSignal.action}${escortSignal.systemId ? ` ${escortSignal.systemId}` : ""}`);
      consecutiveFailedChecks = 0;

      if (escortSignal.action === "dock") {
        ctx.log("escort", "Miner signaling dock — standing by at current location");
      } else if (escortSignal.action === "undock") {
        ctx.log("escort", "Miner signaling undock — preparing to follow");
        await ensureUndocked(ctx);
      } else if (escortSignal.systemId && (escortSignal.action === "going_to" || escortSignal.action === "jumping_to" || escortSignal.action === "location_update")) {
        minerSystem = escortSignal.systemId;
        setMinerLocation(minerName, escortSignal.systemId);
        ctx.log("escort", `Miner ${escortSignal.action === "location_update" ? "reported location" : "announced " + escortSignal.action.replace('_', ' ')} ${escortSignal.systemId}`);
      } else if (escortSignal.systemId && (escortSignal.action === "jump" || escortSignal.action === "travel")) {
        minerSystem = escortSignal.systemId;
        setMinerLocation(minerName, escortSignal.systemId);
        ctx.log("escort", `Miner signaled travel to ${escortSignal.systemId} (target system) — will follow immediately`);
      }
    } else {
      ctx.log("escort", `⚠ No signals received from ${minerName}`);
      // Send location query if no signals and no known location
      if (!minerSystem && Date.now() - lastQueryTime > 10000) {
        const chatChannel = getBotChatChannel();
        chatChannel.send({ sender: bot.username, recipients: [minerName], channel: "escort", content: "QUERY_LOCATION" });
        lastQueryTime = Date.now();
        ctx.log("escort", `Sent location query to ${minerName}`);
      }
    }

    // ── Fuel check ──
    yield "fuel_check";
    let fueled = await ensureFueled(ctx, settings.refuelThreshold);

    // Check if we should visit home system for premium fuel cells
    const shouldVisitHome = settings.homeSystem &&
                           bot.system === settings.homeSystem &&
                           bot.docked === false &&
                           (await bot.refreshCargo(), bot.cargoMax - bot.cargo >= 2); // Have space for at least 1 premium fuel cell (2 slots)

    if (shouldVisitHome) {
      ctx.log("escort", `At home system ${settings.homeSystem} — docking to collect premium fuel cells...`);
      const { pois } = await getSystemInfo(ctx);
      const station = findStation(pois);
      if (station) {
        const travelResp = await bot.exec("travel", { target_poi: station.id });
        if (!travelResp.error) {
          bot.poi = station.id;
          const dockResp = await bot.exec("dock");
          if (!dockResp.error) {
            bot.docked = true;
            const collectedFuelCells = await collectFuelCells(ctx);
            await tryRefuel(ctx); // Also refuel while we're here
            fueled = await ensureFueled(ctx, settings.refuelThreshold);
            if (collectedFuelCells) {
              ctx.log("escort", "Collected premium fuel cells and refueled at home system");
            } else {
              ctx.log("escort", "Refueled at home system (no premium fuel cells collected)");
            }
          } else {
            ctx.log("error", "Could not dock at home system station");
          }
        } else {
          ctx.log("error", "Could not travel to home system station");
        }
      }

      // Undock and continue
      if (bot.docked) {
        await ensureUndocked(ctx);
      }
    }

    if (!fueled) {
      // Check for signals while low on fuel
      const fuelSignal = await checkEscortSignals(ctx, minerName);
      if (fuelSignal) {
        ctx.log("escort", `Received signal while refueling: ${fuelSignal.action}${fuelSignal.systemId ? ` ${fuelSignal.systemId}` : ""}`);
        if (fuelSignal.systemId && (fuelSignal.action === "going_to" || fuelSignal.action === "jumping_to" || fuelSignal.action === "location_update" || fuelSignal.action === "jump" || fuelSignal.action === "travel")) {
          minerSystem = fuelSignal.systemId;
          setMinerLocation(minerName, fuelSignal.systemId);
          ctx.log("escort", `Miner location updated during refuel: ${fuelSignal.systemId}`);
        }
      }

      // Go to home system for refuel and premium fuel cell collection
      if (settings.homeSystem && bot.system !== settings.homeSystem) {
        ctx.log("escort", `Low on fuel — returning to home system ${settings.homeSystem} for refuel and premium fuel cells...`);
        const arrived = await navigateToSystem(ctx, settings.homeSystem, safetyOpts);
        if (!arrived) {
          ctx.log("error", `Could not reach home system ${settings.homeSystem} for refuel`);
          await ctx.sleep(30000);
          continue;
        }
      }

      // Dock and refuel at home system
      if (!bot.docked) {
        const { pois } = await getSystemInfo(ctx);
        const station = findStation(pois);
        if (station) {
          const travelResp = await bot.exec("travel", { target_poi: station.id });
          if (!travelResp.error) {
            bot.poi = station.id;
            const dockResp = await bot.exec("dock");
            if (!dockResp.error) {
              bot.docked = true;
            } else {
              ctx.log("error", "Could not dock for refuel");
              await ctx.sleep(30000);
              continue;
            }
          } else {
            ctx.log("error", "Could not travel to station for refuel");
            await ctx.sleep(30000);
            continue;
          }
        } else {
          ctx.log("error", "No station found for refuel");
          await ctx.sleep(30000);
          continue;
        }
      }

      // Collect premium fuel cells (half inventory) and refuel
      if (bot.docked) {
        await collectFuelCells(ctx);
        await tryRefuel(ctx);
        fueled = await ensureFueled(ctx, settings.refuelThreshold);

        if (fueled) {
          ctx.log("escort", "Refueled and stocked up on premium fuel cells at home system");
        } else {
          ctx.log("error", "Failed to refuel at home system");
        }
      }

      // Undock and continue
      if (bot.docked) {
        await ensureUndocked(ctx);
      }

      if (!fueled) {
        ctx.log("error", "Cannot secure fuel — waiting 30s...");
        await ctx.sleep(30000);
        continue;
      }
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

    // ── Follow miner immediately if signaled to a different system ──
    if (minerSystem && minerSystem !== bot.system) {
      ctx.log("escort", `Following miner to ${minerSystem} as signaled...`);
      yield "follow_signal";

      const jumpSafetyOpts = {
        ...safetyOpts,
        onJump: async (jumpNumber: number) => {
          // Check miner location after each jump
          if (ctx.getFleetStatus) {
            const fleetStatus = ctx.getFleetStatus();
            const minerBot = fleetStatus.find(b => b.username?.toLowerCase() === minerName.toLowerCase());
            if (minerBot?.system && minerBot.system !== "unknown" && minerBot.system !== minerSystem) {
              ctx.log("escort", `⚠ Miner moved from ${minerSystem} to ${minerBot.system} during travel (after jump ${jumpNumber}) — recalculating route...`);
              minerSystem = minerBot.system;
              setMinerLocation(minerName, minerBot.system);
              // Return false to abort current navigation and recalculate
              return false;
            }
            if (minerBot?.poi) {
              ctx.log("escort", `Miner POI during travel: ${minerBot.poi}`);
            }
          }
          return true;
        },
      };

      const arrived = await navigateToSystem(ctx, minerSystem, jumpSafetyOpts);
      if (arrived) {
        consecutiveFailedChecks = 0;
        setMinerLocation(minerName, minerSystem);
        ctx.log("escort", `✓ Successfully joined miner in ${minerSystem}`);
      } else {
        ctx.log("error", `Could not reach ${minerSystem} — will retry next cycle`);
        consecutiveFailedChecks++;
      }
      continue;
    }

    // ── Determine miner's current system (fallback if no signal) ──
    const now = Date.now();
    if ((now - lastMinerSystemCheck) > MINER_CHECK_INTERVAL_MS) {
      lastMinerSystemCheck = now;

      if (!minerSystem) {
        let detectedSystem: string | null = null;

        if (ctx.getFleetStatus) {
          const fleetStatus = ctx.getFleetStatus();
          ctx.log("escort", `Fleet status has ${fleetStatus.length} bots`);
          const matchingBots = fleetStatus.filter(b => b.username?.toLowerCase() === minerName.toLowerCase());
          ctx.log("escort", `Bots matching "${minerName}": ${matchingBots.map(b => `${b.username}(${b.system})`).join(', ') || 'NONE'}`);
          const minerBot = matchingBots[0]; // Use first match
          if (minerBot) {
            ctx.log("escort", `Selected bot: ${minerBot.username} in ${minerBot.system} at POI ${minerBot.poi || 'none'}`);
          } else {
            ctx.log("escort", `No bot found matching "${minerName}"`);
          }
          if (minerBot?.system && minerBot.system !== "unknown") {
            detectedSystem = minerBot.system;
            ctx.log("escort", `✓ Located miner via fleet status: ${minerName} is in ${detectedSystem}`);
          } else if (minerBot?.system === "unknown") {
            ctx.log("escort", `⚠ Miner ${minerName} is in unknown system (mid-jump?) — will use cached location or wait for signals`);
            // Don't set detectedSystem to null here - let cache fallback work
          } else if (!minerBot) {
            ctx.log("escort", `✗ Miner "${minerName}" not found in fleet status`);
          }
        }

        if (!detectedSystem) {
          detectedSystem = getMinerLocation(minerName);
          if (detectedSystem) {
            ctx.log("escort", `✓ Located miner via cache: ${detectedSystem}`);
          }
        }

        if (detectedSystem && detectedSystem !== "unknown") {
          minerSystem = detectedSystem;
          consecutiveFailedChecks = 0;
        } else if (detectedSystem === "unknown") {
          ctx.log("escort", `⚠ Miner ${minerName} location is unknown — will not follow stale data`);
          minerSystem = null; // Clear stale data
          consecutiveFailedChecks++;
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

      if (minerSystem && minerSystem !== bot.system) {
        // Check if too far behind
        const jumpsAway = getJumpsToSystem(bot.system, minerSystem);
        if (jumpsAway > 3) {
          ctx.log("escort", `Miner is ${jumpsAway} jumps away — waiting to catch up rather than following immediately`);
          minerSystem = null; // clear to avoid repeated attempts
          await ctx.sleep(30000);
          continue;
        }

        // Pre-navigation verification: check if miner is actually where we think
        let currentMinerLocation = minerSystem;
        if (ctx.getFleetStatus) {
          const fleetStatus = ctx.getFleetStatus();
          const minerBot = fleetStatus.find(b => b.username?.toLowerCase() === minerName.toLowerCase());
          if (minerBot?.system && minerBot.system !== "unknown") {
            if (minerBot.system !== minerSystem) {
              ctx.log("escort", `⚠ Pre-navigation check: miner ${minerName} is actually in ${minerBot.system}, not ${minerSystem} — updating target`);
              minerSystem = minerBot.system;
              currentMinerLocation = minerBot.system;
              setMinerLocation(minerName, minerBot.system);
            }
          } else if (minerBot?.system === "unknown") {
            ctx.log("escort", `⚠ Miner ${minerName} location unknown before travel — sending location query`);
            const chatChannel = getBotChatChannel();
            chatChannel.send({ sender: bot.username, recipients: [minerName], channel: "escort", content: "QUERY_LOCATION" });
            await ctx.sleep(2000); // Wait for potential response
          }
        }

        ctx.log("escort", `Miner ${minerName} detected in ${currentMinerLocation} — following...`);

        const jumpSafetyOpts = {
          ...safetyOpts,
          onJump: async (jumpNumber: number) => {
            // Check miner location after each jump
            if (ctx.getFleetStatus) {
              const fleetStatus = ctx.getFleetStatus();
              const minerBot = fleetStatus.find(b => b.username?.toLowerCase() === minerName.toLowerCase());
              if (minerBot?.system && minerBot.system !== "unknown" && minerBot.system !== currentMinerLocation) {
                ctx.log("escort", `⚠ Miner moved from ${currentMinerLocation} to ${minerBot.system} during travel (after jump ${jumpNumber}) — recalculating route...`);
                currentMinerLocation = minerBot.system;
                minerSystem = minerBot.system;
                setMinerLocation(minerName, minerBot.system);
                // Return false to abort current navigation and recalculate
                return false;
              }
              if (minerBot?.poi) {
                ctx.log("escort", `Miner POI during travel: ${minerBot.poi}`);
              }
            }
            return true;
          },
        };

        const arrived = await navigateToSystem(ctx, currentMinerLocation, jumpSafetyOpts);
        if (!arrived) {
          ctx.log("error", `Could not reach ${currentMinerLocation} — will retry next cycle`);
          consecutiveFailedChecks++;
          await ctx.sleep(15000);
          continue;
        }
        consecutiveFailedChecks = 0;
        setMinerLocation(minerName, currentMinerLocation);
        ctx.log("escort", `✓ Successfully joined miner in ${currentMinerLocation}`);
      } else if (minerSystem) {
        ctx.log("escort", `✓ Already in same system as miner (${minerSystem})`);
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

    // ── STAY PUT: No need to follow miner around POIs in same system ──
    // Escorts get pulled into battles automatically when in the same system
    yield "standby";
    ctx.log("escort", `Standing by in ${bot.system} — monitoring for threats to ${minerName}...`);

    // Scan for nearby hostiles that might threaten the miner
    yield "scan_system";
    await fetchSecurityLevel(ctx, bot.system);

    // ── Check if we're already in battle (miner pulled us in) ──
    const existingBattle = await getBattleStatus(ctx);
    if (existingBattle && battleRef.state.inBattle) {
      ctx.log("combat", `⚔️ Already in battle (${existingBattle.battle_id}) — running combat loop...`);

      const analysis = await analyzeEscortBattle(ctx, settings.maxAttackTier, settings.minPiratesToFlee, minerName);
      if (analysis.shouldJoin && analysis.sideId !== undefined) {
        ctx.log("combat", `✅ Escort joining side ${analysis.sideId}: ${analysis.reason}`);

        const opposingPirates = existingBattle.participants.filter(p => {
          const u = (p.username || "").toLowerCase();
          return (u.includes("pirate") || u.includes("drifter") ||
                  u.includes("executioner") || u.includes("sentinel") ||
                  u.includes("prowler") || u.includes("apex") ||
                  u.includes("razor") || u.includes("striker") ||
                  u.includes("rampart") || u.includes("stalwart") ||
                  u.includes("bastion") || u.includes("onslaught") ||
                  u.includes("iron") || u.includes("strike")) &&
                 p.side_id !== analysis.sideId;
        });

        if (opposingPirates.length > 0) {
          const targetPirate = opposingPirates.reduce((a, b) => {
            const aLevel = getTierLevel((a as any).tier as PirateTier);
            const bLevel = getTierLevel((b as any).tier as PirateTier);
            return aLevel >= bLevel ? a : b;
          });

          const targetEntity: NearbyEntity = {
            id: targetPirate.player_id,
            name: targetPirate.username || targetPirate.player_id,
            type: "pirate",
            faction: "pirate",
            isNPC: true,
            isPirate: true,
            tier: (targetPirate as any).tier as PirateTier,
          };

          const won = await fightJoinedBattle(ctx, targetEntity, settings.fleeThreshold, settings.fleeFromTier, settings.maxAttackTier);
          if (won) {
            totalKills++;
            ctx.log("combat", `Kill #${totalKills} — escort protected the miner!`);
            yield "loot";
            await scavengeWrecks(ctx);
          } else {
            ctx.log("combat", "Escort retreated from battle — docking to repair");
          }
        } else {
          ctx.log("combat", "No opposing pirates found in battle — standing by");
        }
      } else {
        ctx.log("combat", `Not joining battle: ${analysis.reason}`);
      }

      const postBattleCheck = await getBattleStatus(ctx);
      if (!postBattleCheck) {
        battleRef.state.inBattle = false;
        battleRef.state.battleId = null;
        battleRef.state.isFleeing = false;
        ctx.log("combat", "Battle ended");
      }
    } else if (existingBattle && !battleRef.state.inBattle) {
      ctx.log("combat", `⚔️ New battle detected (${existingBattle.battle_id}) — analyzing...`);
      battleRef.state.inBattle = true;
      battleRef.state.battleId = existingBattle.battle_id;

      const analysis = await analyzeEscortBattle(ctx, settings.maxAttackTier, settings.minPiratesToFlee, minerName);
      if (analysis.shouldJoin && analysis.sideId !== undefined) {
        ctx.log("combat", `✅ Escort joining side ${analysis.sideId}: ${analysis.reason}`);

        const engageResp = await bot.exec("battle", { action: "engage", side_id: analysis.sideId.toString() });
        if (engageResp.error) {
          ctx.log("error", `Failed to join battle: ${engageResp.error.message}`);
        } else {
          const opposingPirates = existingBattle.participants.filter(p => {
            const u = (p.username || "").toLowerCase();
            return (u.includes("pirate") || u.includes("drifter") ||
                    u.includes("executioner") || u.includes("sentinel") ||
                    u.includes("prowler") || u.includes("apex") ||
                    u.includes("razor") || u.includes("striker") ||
                    u.includes("rampart") || u.includes("stalwart") ||
                    u.includes("bastion") || u.includes("onslaught") ||
                    u.includes("iron") || u.includes("strike")) &&
                   p.side_id !== analysis.sideId;
          });

          if (opposingPirates.length > 0) {
            const targetPirate = opposingPirates.reduce((a, b) => {
              const aLevel = getTierLevel((a as any).tier as PirateTier);
              const bLevel = getTierLevel((b as any).tier as PirateTier);
              return aLevel >= bLevel ? a : b;
            });

            const targetEntity: NearbyEntity = {
              id: targetPirate.player_id,
              name: targetPirate.username || targetPirate.player_id,
              type: "pirate",
              faction: "pirate",
              isNPC: true,
              isPirate: true,
              tier: (targetPirate as any).tier as PirateTier,
            };

            const joinedBattle = await getBattleStatus(ctx);
            if (joinedBattle) {
              const won = await fightJoinedBattle(ctx, targetEntity, settings.fleeThreshold, settings.fleeFromTier, settings.maxAttackTier);
              if (won) {
                totalKills++;
                ctx.log("combat", `Kill #${totalKills} — escort protected the miner!`);
                yield "loot";
                await scavengeWrecks(ctx);
              }
            }
          }
        }

        const postBattleCheck = await getBattleStatus(ctx);
        if (!postBattleCheck) {
          battleRef.state.inBattle = false;
          battleRef.state.battleId = null;
        }
      }
    }

    // ── Scan for nearby threats to engage proactively ──
    const nearbyResp = await bot.exec("get_nearby");
    if (!nearbyResp.error && nearbyResp.result) {
      bot.trackNearbyPlayers(nearbyResp.result);
      const entities = parseNearby(nearbyResp.result);
      // Allow engaging all pirate tiers - escorts can handle bosses now
      const targets = entities.filter(e => isPirateTarget(e, false, "boss"));

      if (targets.length > 0) {
        if (battleRef.state.inBattle) {
          ctx.log("combat", `Battle still active — ${targets.length} hostiles nearby but staying in current fight`);
        } else {
          ctx.log("combat", `Found ${targets.length} hostile(s) in system: ${targets.map(t => t.name).join(", ")}`);

          for (const target of targets) {
            if (bot.state !== "running") break;

            await bot.refreshStatus();
            const preHull = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
            if (preHull <= settings.repairThreshold) {
              ctx.log("system", `Hull at ${preHull}% — too low for combat, docking...`);
              break;
            }

            const hasAmmo = await ensureAmmoLoaded(ctx, settings.ammoThreshold, settings.maxReloadAttempts);
            if (!hasAmmo) {
              ctx.log("combat", "Out of ammo — docking to resupply");
              break;
            }

            yield "engage";
            const won = await battleEngageTarget(ctx, target, settings.fleeThreshold, settings.fleeFromTier, settings.minPiratesToFlee, settings.maxAttackTier);

            if (won) {
              totalKills++;
              battleRef.state.inBattle = false;
              battleRef.state.battleId = null;
              ctx.log("combat", `Kill #${totalKills} — looting wreck...`);

              yield "loot";
              await scavengeWrecks(ctx);

              const hasAmmoAfter = await ensureAmmoLoaded(ctx, settings.ammoThreshold, settings.maxReloadAttempts);
              if (!hasAmmoAfter) {
                ctx.log("combat", "No ammo after kill — docking to resupply");
                break;
              }

              await bot.refreshStatus();
              ctx.log("combat", `Post-fight: hull ${bot.hull}/${bot.maxHull} | ammo ${bot.ammo} | credits ${bot.credits}`);
            } else {
              battleRef.state.inBattle = false;
              battleRef.state.battleId = null;
              ctx.log("combat", "Retreated — docking to repair");
              break;
            }
          }
        }
      } else {
        ctx.log("escort", `No threats in ${bot.system} — standing by`);
      }
    } else if (nearbyResp.error) {
      ctx.log("warn", `get_nearby failed: ${nearbyResp.error.message}`);
    }

    // ── Reset battle state if no longer in battle ──
    if (battleRef.state.inBattle) {
      const stillInBattle = await getBattleStatus(ctx);
      if (!stillInBattle) {
        battleRef.state.inBattle = false;
        battleRef.state.battleId = null;
        battleRef.state.isFleeing = false;
        ctx.log("combat", "Battle state cleared — no longer in combat");
      }
    }

    // ── PERIODIC MINER LOCATION CHECK ──
    yield "verify_miner_location";

    let minerStillHere = false;

    if (nearbyResp.result) {
      const entities = parseNearby(nearbyResp.result);
      const minerFound = entities.find(e => e.name?.toLowerCase() === minerName.toLowerCase());
      if (minerFound) {
        minerStillHere = true;
        ctx.log("escort", `✓ Miner ${minerName} spotted nearby`);
      }
    }

    // Also check if we're in the same POI as the miner
    if (!minerStillHere && ctx.getFleetStatus) {
      const fleetStatus = ctx.getFleetStatus();
      const minerBot = fleetStatus.find(b => b.username?.toLowerCase() === minerName.toLowerCase());
      if (minerBot?.poi && bot.poi && minerBot.poi === bot.poi) {
        minerStillHere = true;
        ctx.log("escort", `✓ Miner ${minerName} in same POI (${minerBot.poi}) — escorting locally`);
      }
    }

    if (!minerStillHere && ctx.getFleetStatus) {
      const fleetStatus = ctx.getFleetStatus();
      ctx.log("escort", `Periodic check - fleet status has ${fleetStatus.length} bots`);
      const minerBot = fleetStatus.find(b => b.username?.toLowerCase() === minerName.toLowerCase());
      ctx.log("escort", `Periodic check - miner "${minerName}" lookup: ${minerBot ? `found in ${minerBot.system} at POI ${minerBot.poi || 'none'}` : 'NOT FOUND'}`);

      if (minerBot?.system && minerBot.system !== "unknown") {
        const normalizeSystemName = (name: string) => name.toLowerCase().replace(/_/g, ' ').trim();

        if (normalizeSystemName(minerBot.system) !== normalizeSystemName(bot.system)) {
          ctx.log("escort", `⚠ Miner ${minerName} has moved to ${minerBot.system} — following...`);
          minerSystem = minerBot.system;
          setMinerLocation(minerName, minerBot.system);

          // Check if too far behind
          const jumpsAway = getJumpsToSystem(bot.system, minerSystem);
          if (jumpsAway > 3) {
            ctx.log("escort", `Miner is ${jumpsAway} jumps away — waiting to catch up rather than following immediately`);
            minerSystem = null; // clear to avoid repeated attempts
            await ctx.sleep(30000);
            continue;
          }
        } else {
          ctx.log("escort", `✓ Miner ${minerName} still in ${bot.system}`);
        }
      } else if (minerBot?.system === "unknown") {
        ctx.log("escort", `⚠ Miner ${minerName} location unknown in periodic check — sending query`);
        const chatChannel = getBotChatChannel();
        chatChannel.send({ sender: bot.username, recipients: [minerName], channel: "escort", content: "QUERY_LOCATION" });
        minerSystem = null; // Don't trust unknown location
      } else {
        ctx.log("escort", `✗ Miner ${minerName} not found in fleet status during periodic check`);
        minerSystem = null;
      }

      if (minerBot?.system && minerBot.system !== "unknown") {
        const normalizeSystemName = (name: string) => name.toLowerCase().replace(/_/g, ' ').trim();

        if (normalizeSystemName(minerBot.system) !== normalizeSystemName(bot.system)) {
          minerSystem = minerBot.system;
          setMinerLocation(minerName, minerBot.system);

          // Check if too far behind
          const jumpsAway = getJumpsToSystem(bot.system, minerSystem);
          if (jumpsAway > 3) {
            ctx.log("escort", `Miner is ${jumpsAway} jumps away — waiting to catch up rather than following immediately`);
            minerSystem = null; // clear to avoid repeated attempts
            await ctx.sleep(30000);
            continue;
          }

          ctx.log("escort", `⚠ Miner ${minerName} has moved to ${minerBot.system} — following...`);

          const arrived = await navigateToSystem(ctx, minerSystem, safetyOpts);
          if (arrived) {
            ctx.log("escort", `✓ Successfully followed miner to ${minerSystem}`);
            continue;
          } else {
            ctx.log("error", `Failed to follow miner to ${minerSystem}`);
          }
        } else {
          minerStillHere = true;
          // Check if we're in the same POI
          if (minerBot.poi && bot.poi && minerBot.poi === bot.poi) {
            ctx.log("escort", `✓ Miner ${minerName} in same POI (${minerBot.poi}) — escorting locally`);
          } else {
            ctx.log("escort", `✓ Miner still in ${bot.system} (not nearby, but same system)`);
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

      // Collect premium fuel cells if at home system
      if (settings.homeSystem && bot.system === settings.homeSystem) {
        await collectFuelCells(ctx);
      }

      yield "repair";
      await repairShip(ctx);

      yield "reload";
      await ensureAmmoLoaded(ctx, settings.ammoThreshold, settings.maxReloadAttempts);

      yield "fit_mods";
      const modProfile = getModProfile("hunter");
      if (modProfile.length > 0) await ensureModsFitted(ctx, modProfile);

      yield "check_skills";
      await bot.checkSkills();

      yield "undock";
      await ensureUndocked(ctx);

      battleRef.state.inBattle = false;
      battleRef.state.battleId = null;
      battleRef.state.isFleeing = false;

      ctx.log("info", `Escort cycle complete. Total kills: ${totalKills} | Credits: ${bot.credits} ===`);
    } else {
      ctx.log("system", `Cycle complete. Hull: ${postHull}% | Fuel: ${postFuel}% — continuing escort...`);
    }
  }
};
