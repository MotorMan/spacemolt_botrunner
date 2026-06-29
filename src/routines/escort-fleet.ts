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
 *   ignoreBlacklist   — bypass system blacklist when following miner/salvager into pirate systems (default: false)
 *
 * Home system is automatically determined from general.factionStorageSystem (default: "sol")
 */

import type { Routine, RoutineContext } from "../bot.js";
import { getBotChatChannel } from "../botmanager.js";
import type { BotChatMessage } from "../bot_chat_channel.js";
import { mapStore } from "../mapstore.js";
import {
  type NearbyEntity,
  type PirateTier,
  parseNearby,
  isPirateTarget,
  ensureAmmoLoaded,
  engageTarget as battleEngageTarget,
  fightJoinedBattle,
} from "./battle.js";
import { ensureHunterResupply } from "./hunter.js";
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
  topUpShields,
  useRepairKits,
} from "./common.js";
import {
  type FleetStatusResponse,
  fleetStatus,
  fleetCreate,
  fleetInvite,
  fleetLeave,
  fleetAccept,
  fleetDecline,
  fleetJump,
  fleetDock,
  fleetUndock,
  getFleetMemberByUsername,
  isFleetLeader,
} from "./fleet.js";

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
  shieldRechargePct: number;
  maxAttackTier: PirateTier;
  fleeFromTier: PirateTier;
  minPiratesToFlee: number;
  autoCloak: boolean;
  ammoThreshold: number;
  maxReloadAttempts: number;
  homeSystem: string;
  ignoreBlacklist: boolean;
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
    shieldRechargePct: (e.shieldRechargePct as number) || 80,
    maxAttackTier: ((e.maxAttackTier as PirateTier) || "boss") as PirateTier,
    fleeFromTier: ((e.fleeFromTier as PirateTier) || "boss") as PirateTier,
    minPiratesToFlee: (e.minPiratesToFlee as number) || 3,
    autoCloak: (e.autoCloak as boolean) ?? false,
    ammoThreshold: (e.ammoThreshold as number) || 5,
    maxReloadAttempts: (e.maxReloadAttempts as number) || 3,
    homeSystem: (botOverrides.homeSystem as string) || (e.homeSystem as string) || (general.factionStorageSystem as string) || "sol",
    ignoreBlacklist: (botOverrides.ignoreBlacklist as boolean) ?? (e.ignoreBlacklist as boolean) ?? false,
  };
}

function isLowOnFieldConsumables(inventory: any[] | undefined, minRepairKits = 5, minShieldCharges = 5): boolean {
  const repair = (inventory || [])
    .filter(i => (i.itemId || "").toLowerCase().includes("repair_kit"))
    .reduce((sum, i) => sum + (i.quantity || 0), 0);
  const shields = (inventory || [])
    .filter(i => (i.itemId || "").toLowerCase().includes("shield_charge"))
    .reduce((sum, i) => sum + (i.quantity || 0), 0);
  return repair < minRepairKits || shields < minShieldCharges;
}

// ── Miner tracking via fleet status ──────────────────────────────

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

async function getMinerLocationFromFleet(ctx: RoutineContext, minerName: string): Promise<string | null> {
  const status = await fleetStatus(ctx);
  const member = getFleetMemberByUsername(status, minerName);
  if (member?.system_id && member.system_id !== "unknown") {
    return member.system_id;
  }
  return getMinerLocation(minerName);
}

const FLEET_COORDINATION_TIMEOUT = 60000;
const POSITION_VERIFY_TIMEOUT = 30000;

async function waitForFleetInvite(ctx: RoutineContext, timeoutMs: number = FLEET_COORDINATION_TIMEOUT): Promise<boolean> {
  const { bot } = ctx;
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    const status = await fleetStatus(ctx);
    if (status && status.in_fleet) {
      return true;
    }
    if (status && status.pending_invite) {
      ctx.log("escort", `Pending fleet invite detected - accepting...`);
      const acceptResult = await fleetAccept(ctx);
      ctx.log("escort", `fleetAccept result: success=${acceptResult.success}, message=${acceptResult.message}`);
      if (acceptResult.success) {
        const verifyStatus = await fleetStatus(ctx);
        if (verifyStatus && verifyStatus.in_fleet) {
          ctx.log("escort", `Successfully accepted fleet invite and joined fleet`);
          return true;
        }
      }
    }
    await ctx.sleep(1000);
  }
  return false;
}

async function checkPositionAndCoordinate(
  ctx: RoutineContext,
  minerName: string,
  homeSystem: string
): Promise<{ sameSystem: boolean; minerSystem?: string }> {
  const { bot } = ctx;
  const chatChannel = getBotChatChannel();
  
  chatChannel.send({
    sender: bot.username,
    recipients: [minerName],
    channel: "escort",
    content: "LOCATION_QUERY"
  });
  
  ctx.log("escort", `Sent location query to ${minerName}...`);
  
  const startTime = Date.now();
  while (Date.now() - startTime < POSITION_VERIFY_TIMEOUT) {
    const messages = chatChannel.getHistory("escort", 20);
    for (const msg of messages) {
      if (msg.sender.toLowerCase() === minerName.toLowerCase() && msg.content.startsWith("LOCATION: ")) {
        const minerSystem = msg.content.substring(9).trim();
        ctx.log("escort", `${minerName} responded: system=${minerSystem}`);
        return { sameSystem: bot.system === minerSystem, minerSystem };
      }
    }
    await ctx.sleep(500);
  }
  
  ctx.log("escort", `No location response from ${minerName} within timeout`);
  return { sameSystem: false };
}

async function handleFleetCoordination(
  ctx: RoutineContext,
  minerName: string,
  homeSystem: string
): Promise<{ success: boolean; message: string }> {
  const { bot } = ctx;
  const chatChannel = getBotChatChannel();
  
  ctx.log("escort", `Starting fleet coordination with ${minerName}...`);
  
  const status = await fleetStatus(ctx);
  const amIFleetMember = status?.in_fleet ?? false;
  const inCorrectFleet = status && status.in_fleet && 
                         status.leader.toLowerCase() === minerName.toLowerCase();
  
  if (inCorrectFleet) {
    ctx.log("escort", `Already in fleet with ${minerName} as leader`);
    return { success: true, message: "Already in correct fleet" };
  }
  
  if (status?.in_fleet && !inCorrectFleet) {
    ctx.log("escort", `Currently in different fleet - leaving...`);
    const leaveResult = await fleetLeave(ctx);
    if (!leaveResult.success) {
      ctx.log("escort", `Failed to leave current fleet: ${leaveResult.message}`);
    }
    await ctx.sleep(1000);
  }
  
  const sameSystem = bot.system === homeSystem;
  if (!sameSystem) {
    ctx.log("escort", `Bots in different systems - navigating to ${homeSystem}...`);
    const arrived = await navigateToSystem(ctx, homeSystem, {
      fuelThresholdPct: 50,
      hullThresholdPct: 40,
      skipBlacklist: true
    });
    if (!arrived) {
      return { success: false, message: `Could not reach home system ${homeSystem}` };
    }
  }
  
  const { sameSystem: minerSameSystem, minerSystem } = await checkPositionAndCoordinate(ctx, minerName, homeSystem);
  
  if (!minerSameSystem && minerSystem && bot.system !== minerSystem) {
    ctx.log("escort", `Escort at ${bot.system}, miner at ${minerSystem} - navigating to meet...`);
    const arrived = await navigateToSystem(ctx, minerSystem, {
      fuelThresholdPct: 50,
      hullThresholdPct: 40,
      skipBlacklist: true
    });
    if (!arrived) {
      return { success: false, message: `Could not reach miner at ${minerSystem}` };
    }
  }
  
  await new Promise(resolve => setTimeout(resolve, 100));
  
  ctx.log("escort", `Asking ${minerName} to create fleet and invite escort...`);
  chatChannel.send({
    sender: bot.username,
    recipients: [minerName],
    channel: "escort",
    content: `FLEET_INVITE ${bot.username}`
  });
  
  ctx.log("escort", `Waiting for ${minerName} to create fleet and invite...`);
  
  const invited = await waitForFleetInvite(ctx, FLEET_COORDINATION_TIMEOUT);
  if (!invited) {
    ctx.log("escort", `${minerName} did not create fleet within timeout - will retry`);
    return { success: false, message: `${minerName} did not create fleet within timeout` };
  }
  
  const finalStatus = await fleetStatus(ctx);
  if (finalStatus?.in_fleet && finalStatus?.leader.toLowerCase() === minerName.toLowerCase()) {
    ctx.log("escort", `Fleet coordination successful - ${minerName} is leader`);
    return { success: true, message: "Fleet formed successfully" };
  }
  
  return { success: true, message: "Fleet coordination complete" };
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
      // Fleet member is in battle — escort MUST join to protect regardless of API pirate count
      // The battle status API is buggy and may report 0 pirates even when pirates are present
      const opposingSide = sideInfo.find(s => s.sideId !== fleetSide.sideId);
      const reportedPirateCount = opposingSide?.pirateCount || 0;
      ctx.log("combat", `   ⚠ Battle status API reports ${reportedPirateCount} pirates — but API is unreliable, joining anyway to protect ${isMiner ? 'miner' : 'fleet member'}`);
      return {
        shouldJoin: true,
        sideId: fleetSide.sideId,
        reason: `${isMiner ? 'Miner' : 'Fleet member'} ${fleetInBattle.username} is in battle — escort joining to protect`,
        pirateCount: reportedPirateCount,
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

/** Handle being unexpectedly pulled into a battle (e.g. miner started combat).
 *  Mirrors the robust logic from hunter using escort-specific battle analysis.
 *  Escorts NEVER flee - they fight to protect the miner.
 */
async function handleUnexpectedEscortBattle(
  ctx: RoutineContext,
  maxAttackTier: PirateTier,
  minPiratesToFlee: number,
  fleeThreshold: number,
  fleeFromTier: PirateTier,
  minerName: string,
  repairThreshold: number = 0,
  shieldRechargePct: number = 80,
): Promise<void> {
  const battleStatus = await getBattleStatus(ctx);
  if (!battleStatus) return;

  ctx.log("combat", `⚠️ Unexpectedly in battle (ID: ${battleStatus.battle_id})`);

  const analysis = await analyzeEscortBattle(ctx, maxAttackTier, minPiratesToFlee, minerName);
  // If fleet member is in battle, analysis.shouldJoin is true regardless of reported pirate count
  // The battle status API is buggy and reports 0 pirates even when pirates are present
  if (!analysis.shouldJoin) {
    ctx.log("combat", `Battle analysis: ${analysis.reason}`);
    // Check if we're already in this battle by checking bot's battle state
    const alreadyInBattle = ctx.bot.isInBattle();
    if (alreadyInBattle) {
      ctx.log("combat", `🚨 Already in battle — continuing to fight!`);
    } else if (analysis.pirateCount === 0 && !alreadyInBattle) {
      ctx.log("combat", `🛡️ No pirates reported and not in battle — waiting for resolution...`);
      await ctx.sleep(5000);
      return;
    } else {
      // Even with pirates but analysis says don't join (e.g., PvP), escorts still fight!
      ctx.log("combat", `🚨 Escort fights regardless - protecting the miner!`);
    }
    // Continue to fight logic below...
  }

  if (analysis.reason.includes("Already in battle")) {
    ctx.log("combat", `Already participating on side ${analysis.sideId} — continuing fight`);
  } else if (analysis.sideId !== undefined) {
    ctx.log("combat", `✅ Joining unexpected battle on side ${analysis.sideId}: ${analysis.reason}`);
    const engageResp = await ctx.bot.exec("battle", { action: "engage", side_id: analysis.sideId.toString() });
    if (engageResp.error) {
      const errMsg = engageResp.error.message.toLowerCase();
      if (errMsg.includes("already in a battle") || errMsg.includes("already_in_battle")) {
        ctx.log("combat", `Already in battle — proceeding to fight`);
      } else {
        ctx.log("error", `Failed to join unexpected battle: ${engageResp.error.message}`);
        return;
      }
    }
  } else {
    // No sideId determined - but we have pirates, so pick any side with pirates
    ctx.log("combat", `🚨 No side determined but pirates detected - picking side with pirates!`);
    const sidesWithPirates = battleStatus.sides.filter(s => {
      const sideParticipants = battleStatus.participants.filter(p => p.side_id === s.side_id);
      return sideParticipants.some(p => p.username?.toLowerCase().includes("pirate") || p.username?.toLowerCase().includes("drifter"));
    });
    if (sidesWithPirates.length > 0) {
      analysis.sideId = sidesWithPirates[0].side_id;
      ctx.log("combat", `Joining side ${analysis.sideId} with pirates`);
      await ctx.bot.exec("battle", { action: "engage", side_id: analysis.sideId.toString() });
    }
  }

  // Pick a real target from battle participants so we get the full combat loop
  const enemy = battleStatus.participants.find(p => p.side_id !== analysis.sideId && !p.is_destroyed);
  const fakeTarget = enemy
    ? ({
        id: enemy.player_id || enemy.username || "",
        name: enemy.username || enemy.player_id || "enemy",
        type: "pirate",
        faction: "pirate",
        isNPC: true,
        isPirate: true,
        tier: (enemy as any).tier as PirateTier,
      } as NearbyEntity)
    : null;
  // shieldRechargePct is stored as percentage (80), convert to decimal for fightJoinedBattle
  const shieldRechargePctDecimal = shieldRechargePct / 100;
  await fightJoinedBattle(ctx, fakeTarget as any, fleeThreshold, fleeFromTier, maxAttackTier, repairThreshold, false, shieldRechargePctDecimal, false);
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

// ── Fleet-based escort routine ─────────────────────────────────

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

  await bot.refreshLocation();

  if (bot.docked) {
    await repairShip(ctx);
    await tryRefuel(ctx);
    await ensureHunterResupply(ctx);
  }

  let totalKills = 0;
  let consecutiveFailedChecks = 0;
  const MAX_FAILED_CHECKS = 5;

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
    const minerName = settings.minerName;

    // Handle any battle that may have started before we began this cycle
    if (battleRef.state.inBattle || bot.isInBattle()) {
      const battleStatus = await getBattleStatus(ctx);
      if (battleStatus) {
        ctx.log("combat", `⚠ Currently in battle (ID: ${battleStatus.battle_id}) — handling before proceeding`);
        await handleUnexpectedEscortBattle(ctx, settings.maxAttackTier, settings.minPiratesToFlee, settings.fleeThreshold, settings.fleeFromTier, minerName, 0, settings.shieldRechargePct);
        await ctx.sleep(2000);
        continue;
      }
    }

    const safetyOpts = {
      fuelThresholdPct: settings.refuelThreshold,
      hullThresholdPct: settings.repairThreshold,
      skipBlacklist: settings.ignoreBlacklist,
      isCombatBot: true,
    };

    if (!minerName) {
      ctx.log("error", "No minerName configured in escort settings — waiting 30s");
      await ctx.sleep(30000);
      continue;
    }

    // ── Status ──
    yield "get_status";
    await bot.refreshShip();
    await bot.refreshLocation();
    logStatus(ctx);

    // ── Fleet status check ──
    yield "fleet_status";
    const fleetStatusResp = await fleetStatus(ctx);
    if (!fleetStatusResp) {
      ctx.log("escort", "Could not get fleet status — waiting 30s");
      await ctx.sleep(30000);
      continue;
    }

    const amILeader = fleetStatusResp.is_leader || isFleetLeader(fleetStatusResp, bot.username);
    const amIFleetMember = fleetStatusResp.in_fleet;
    const minerIsLeader = isFleetLeader(fleetStatusResp, minerName);

    // ── Fleet coordination: ensure we're in a fleet with the miner as leader ──
    if (!amIFleetMember || (amIFleetMember && !minerIsLeader)) {
      ctx.log("escort", `Fleet check: in_fleet=${amIFleetMember}, checking coordination...`);
      
      const coordResult = await handleFleetCoordination(ctx, minerName, settings.homeSystem);
      if (!coordResult.success) {
        ctx.log("escort", `Fleet coordination failed: ${coordResult.message}`);
      }
      
      await ctx.sleep(5000);
      continue;
    }

    // ── In correct fleet with miner as leader - skip navigation, just stay put ──
    // The fleet system sync ensures we stay together automatically
    // Only navigate if we're NOT in a fleet or if the miner is NOT the leader
    const inCorrectFleet = amIFleetMember && minerIsLeader;

    // ── Fleet standby mode: when in correct fleet, skip all navigation/fuel/hull logic ──
    if (inCorrectFleet) {
      ctx.log("escort", `In fleet with ${minerName} as leader — entering fleet standby mode`);

      // Re-check fleet status periodically in case we get kicked or fleet disbands
      const fleetCheck = await fleetStatus(ctx);
      if (!fleetCheck?.in_fleet || !isFleetLeader(fleetCheck, minerName)) {
        ctx.log("escort", "Lost fleet connection — will re-coordinate");
        await ctx.sleep(5000);
        continue;
      }

      // Report fuel status to fleet leader if below threshold
      const currentFuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
      const chatChannel = getBotChatChannel();
      if (currentFuelPct < settings.refuelThreshold) {
        chatChannel.send({ sender: bot.username, recipients: [minerName], channel: "escort", content: `ESCORT_FUEL ${currentFuelPct}` });
        ctx.log("escort", `Reported low fuel to ${minerName}: ${currentFuelPct}%`);
      }

      // Check if we got pulled into battle
      await handleUnexpectedEscortBattle(ctx, settings.maxAttackTier, settings.minPiratesToFlee, settings.fleeThreshold, settings.fleeFromTier, minerName, 0, settings.shieldRechargePct);

      // Scan for nearby threats to engage proactively
      const nearbyResp = await bot.exec("get_nearby");
      if (!nearbyResp.error && nearbyResp.result) {
        bot.trackNearbyPlayers(nearbyResp.result);
        bot.trackWildlife(nearbyResp.result);
        const entities = parseNearby(nearbyResp.result);
        const targets = entities.filter(e => isPirateTarget(e, false, "boss"));

        if (targets.length > 0) {
          if (battleRef.state.inBattle) {
            ctx.log("combat", `Battle still active — ${targets.length} hostiles nearby but staying in current fight`);
          } else {
            ctx.log("combat", `Found ${targets.length} hostile(s) in system: ${targets.map(t => t.name).join(", ")}`);

for (const target of targets) {
            if (bot.state !== "running") break;

            await bot.refreshShip();
            const preHull = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
            if (preHull <= settings.repairThreshold) {
                ctx.log("system", `Hull at ${preHull}% — too low for combat, waiting in fleet...`);
                break;
              }

              const hasAmmo = await ensureAmmoLoaded(ctx, settings.ammoThreshold, settings.maxReloadAttempts);
              if (!hasAmmo) {
                ctx.log("combat", "Out of ammo — staying in fleet to resupply");
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
                  ctx.log("combat", "No ammo after kill — staying in fleet to resupply");
                  break;
                }

                await topUpShields(ctx, settings.shieldRechargePct / 100);
                await useRepairKits(ctx);

                await bot.refreshShip();
                ctx.log("combat", `Post-fight: hull ${bot.hull}/${bot.maxHull} | ammo ${bot.ammo} | credits ${bot.credits}`);
              } else {
                battleRef.state.inBattle = false;
                battleRef.state.battleId = null;
                ctx.log("combat", "Retreated — staying in fleet");
                break;
              }
            }
          }
        } else {
          ctx.log("escort", `No threats in ${bot.system} — standing by`);
          await scavengeWrecks(ctx);
        }
      } else if (nearbyResp.error) {
        ctx.log("warn", `get_nearby failed: ${nearbyResp.error.message}`);
      }

      // Reset battle state if no longer in battle
      if (battleRef.state.inBattle) {
        const stillInBattle = await getBattleStatus(ctx);
        if (!stillInBattle) {
          battleRef.state.inBattle = false;
          battleRef.state.battleId = null;
          battleRef.state.isFleeing = false;
          ctx.log("combat", "Battle state cleared — no longer in combat");
          await scavengeWrecks(ctx);
        }
      }

      yield "standby";

      // Check for fuel query or dock command from fleet leader
      const standbyMessages = chatChannel.getHistory("escort", 20);
      let leaderWantsDock = false;
      for (const msg of standbyMessages) {
        if (msg.sender.toLowerCase() === minerName.toLowerCase()) {
          if (msg.content === "ESCORT_FUEL_QUERY") {
            const fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
            chatChannel.send({ sender: bot.username, recipients: [minerName], channel: "escort", content: `ESCORT_FUEL ${fuelPct}` });
            ctx.log("escort", `Leader queried fuel — responded: ${fuelPct}%`);
          } else if (msg.content === "ESCORT_DOCK_WAIT") {
            leaderWantsDock = true;
            ctx.log("escort", "Leader signaled dock-wait — will refuel at station");
          }
        }
      }

      // Refuel from cargo fuel cells or dock if leader signaled or fuel is low
      const fuelPctNow = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
      if (leaderWantsDock || fuelPctNow < settings.refuelThreshold) {
        ctx.log("escort", `Refueling (fuel=${fuelPctNow}%, threshold=${settings.refuelThreshold}%, leaderDock=${leaderWantsDock})...`);

        // Use cargo fuel cells directly via refuel command (works while fleet-docked)
        const preFuel = bot.fuel;
        for (let i = 0; i < 30; i++) {
          if (bot.state !== "running") break;
          await bot.refreshShip();
          const currentPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
          if (currentPct >= settings.refuelThreshold) break;
          const refuelResp = await bot.exec("refuel");
          if (refuelResp.error) {
            const errMsg = refuelResp.error.message.toLowerCase();
            if (errMsg.includes("no_fuel_cells") || errMsg.includes("no fuel cells") || errMsg.includes("no fuel")) {
              ctx.log("escort", "Cargo fuel cells exhausted");
              break;
            }
            ctx.log("escort", `Refuel error: ${refuelResp.error.message}`);
            break;
          }
        }
        await bot.refreshShip();
        const fuelGained = bot.fuel - preFuel;
        const newPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
        ctx.log("escort", `Refuel complete: ${newPct}% (gained ${fuelGained})`);
        chatChannel.send({ sender: bot.username, recipients: [minerName], channel: "escort", content: `ESCORT_FUEL ${newPct}` });
      }

      ctx.log("escort", `Standing by in ${bot.system} — fleet escorting ${minerName}`);
      await ctx.sleep(8000);
      continue;
    }

    // ── Find the miner in fleet status ──
    const minerMember = getFleetMemberByUsername(fleetStatusResp, minerName);
    if (!minerMember) {
      ctx.log("escort", `Miner ${minerName} not found in fleet members`);
      await ctx.sleep(5000);
      continue;
    }

    const minerSystem = minerMember.system_id;
    const minerPoi = minerMember.poi_id;

    // ── Fuel check ──
    yield "fuel_check";
    let fueled = await ensureFueled(ctx, settings.refuelThreshold);

    const shouldVisitHome = settings.homeSystem &&
                           bot.system === settings.homeSystem &&
                           bot.docked === false &&
                           (await bot.refreshCargo(), bot.cargoMax - bot.cargo >= 2);

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
            await tryRefuel(ctx);
            fueled = await ensureFueled(ctx, settings.refuelThreshold);
            await ensureHunterResupply(ctx);
            if (collectedFuelCells) {
              ctx.log("escort", "Collected premium fuel cells and refueled at home system");
            }
          }
        }
      }
      if (bot.docked) {
        await ensureUndocked(ctx);
      }
    }

    if (!fueled) {
      if (settings.homeSystem && bot.system !== settings.homeSystem) {
        ctx.log("escort", `Low on fuel — returning to home system ${settings.homeSystem} for refuel...`);
        const arrived = await navigateToSystem(ctx, settings.homeSystem, safetyOpts);
        if (!arrived) {
          ctx.log("error", `Could not reach home system ${settings.homeSystem} for refuel`);
          await ctx.sleep(30000);
          continue;
        }
      }

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
            }
          }
        }
      }

      if (bot.docked) {
        await collectFuelCells(ctx);
        await tryRefuel(ctx);
        fueled = await ensureFueled(ctx, settings.refuelThreshold);
        await ensureHunterResupply(ctx);
        if (fueled) {
          ctx.log("escort", "Refueled and stocked up on premium fuel cells at home system");
        } else {
          ctx.log("error", "Failed to refuel at home system");
        }
      }

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
    await bot.refreshShip();
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
        await ensureHunterResupply(ctx);
        await ensureUndocked(ctx);
      }
      continue;
    }

    // ── Follow miner using fleet commands ──
    if (inCorrectFleet && bot.system === minerSystem) {
      // Already in same system with miner as leader - STAY PUT and monitor
    } else if (inCorrectFleet && minerSystem && minerSystem !== bot.system) {
      if (amILeader) {
        ctx.log("escort", `Leader: using fleet jump command to ${minerSystem}...`);
        yield "fleet_jump";
        const jumpResult = await fleetJump(ctx, minerSystem);
        if (jumpResult.success) {
          ctx.log("escort", `✓ Fleet jump commanded to ${minerSystem}`);
        } else {
          ctx.log("escort", `Fleet jump failed: ${jumpResult.message}`);
        }
        continue;
      } else {
        ctx.log("escort", `In fleet with ${minerName} as leader - waiting for fleet sync to ${minerSystem}...`);
        yield "standby";
        ctx.log("escort", `Standing by in ${bot.system} - fleet system will handle movement...`);
        await ctx.sleep(5000);
        continue;
      }
    } else if (!inCorrectFleet && minerSystem && minerSystem !== bot.system) {
      ctx.log("escort", `Following miner to ${minerSystem} (not in fleet with leader)...`);
      yield "follow_signal";

      const jumpSafetyOpts = {
        ...safetyOpts,
        skipBlacklist: settings.ignoreBlacklist,
        onJump: async (jumpNumber: number) => {
          const jumpBattleStatus = await getBattleStatus(ctx);
          if (jumpBattleStatus) {
            ctx.log("combat", `⚠ Battle started during jump ${jumpNumber} (ID: ${jumpBattleStatus.battle_id}) — aborting navigation`);
            await handleUnexpectedEscortBattle(ctx, settings.maxAttackTier, settings.minPiratesToFlee, settings.fleeThreshold, settings.fleeFromTier, minerName, 0, settings.shieldRechargePct);
            return false;
          }
          return true;
        },
      };

      const arrived = await navigateToSystem(ctx, minerSystem, jumpSafetyOpts);
      if (arrived) {
        consecutiveFailedChecks = 0;
        ctx.log("escort", `✓ Successfully joined miner in ${minerSystem}`);
      } else {
        ctx.log("error", `Could not reach ${minerSystem} — checking if battle interrupted...`);
        const navBattle = await getBattleStatus(ctx);
        if (navBattle) {
          ctx.log("combat", `⚠ Battle detected (ID: ${navBattle.battle_id}) — handling before retrying`);
          await handleUnexpectedEscortBattle(ctx, settings.maxAttackTier, settings.minPiratesToFlee, settings.fleeThreshold, settings.fleeFromTier, minerName, 0, settings.shieldRechargePct);
        } else {
          consecutiveFailedChecks++;
        }
      }
      continue;
    }

    // ── If not in same system, check if we should dock ──
    if (bot.system !== minerSystem && !minerSystem) {
      ctx.log("escort", `⚠ Miner location unknown — docking and waiting for signals...`);
      const docked = await navigateToSafeStation(ctx, safetyOpts);
      if (docked) {
        await tryRefuel(ctx);
        await repairShip(ctx);
        await ensureHunterResupply(ctx);
      }
      await ctx.sleep(15000);
      continue;
    }

    // ── Ensure we're undocked ──
    await ensureUndocked(ctx);

    // ── STAY PUT: With fleet commands, we're locked together ──
    yield "standby";
    ctx.log("escort", `Standing by in ${bot.system} — monitoring for threats to ${minerName}...`);

    // Scan for nearby hostiles that might threaten the miner
    yield "scan_system";
    await fetchSecurityLevel(ctx, bot.system);

    // Check if we got pulled into battle
    await handleUnexpectedEscortBattle(ctx, settings.maxAttackTier, settings.minPiratesToFlee, settings.fleeThreshold, settings.fleeFromTier, minerName, 0, settings.shieldRechargePct);

    // Sync local battleRef after possible battle handling
    const postUnexpected = await getBattleStatus(ctx);
    if (postUnexpected) {
      battleRef.state.inBattle = true;
      battleRef.state.battleId = postUnexpected.battle_id;
    } else {
      battleRef.state.inBattle = false;
      battleRef.state.battleId = null;
      battleRef.state.isFleeing = false;
      await scavengeWrecks(ctx);
    }

    // ── Scan for nearby threats to engage proactively ──
    const nearbyResp = await bot.exec("get_nearby");
    if (!nearbyResp.error && nearbyResp.result) {
      bot.trackNearbyPlayers(nearbyResp.result);
      const entities = parseNearby(nearbyResp.result);
      const targets = entities.filter(e => isPirateTarget(e, false, "boss"));

      if (targets.length > 0) {
        if (battleRef.state.inBattle) {
          ctx.log("combat", `Battle still active — ${targets.length} hostiles nearby but staying in current fight`);
        } else {
          ctx.log("combat", `Found ${targets.length} hostile(s) in system: ${targets.map(t => t.name).join(", ")}`);

          for (const target of targets) {
            if (bot.state !== "running") break;

            await bot.refreshShip();
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

              await topUpShields(ctx, settings.shieldRechargePct / 100);
              await useRepairKits(ctx);

              await bot.refreshShip();
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
        await scavengeWrecks(ctx);
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

        await bot.refreshCargo();
        if (isLowOnFieldConsumables(bot.inventory)) {
          ctx.log("combat", "Low on repair kits or shield charges after battle — returning home to resupply");
          const homeSystem = settings.homeSystem;
          if (homeSystem && bot.system !== homeSystem) {
            ctx.log("system", `Returning to home system ${homeSystem} to resupply...`);
            const arrived = await navigateToSystem(ctx, homeSystem, safetyOpts);
            if (arrived) {
              await ensureHunterResupply(ctx);
            }
          } else if (homeSystem && bot.system === homeSystem) {
            await ensureHunterResupply(ctx);
          }
        }
      }
    }

    // ── Post-cycle decision ──
    yield "post_cycle";
    await bot.refreshShip();
    const postHull = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    const postFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;

    const needsRepair = postHull <= settings.repairThreshold;
    const needsFuel = postFuel < settings.refuelThreshold;

    if (needsRepair || needsFuel) {
      const reason = needsRepair ? `hull ${postHull}%` : `fuel ${postFuel}%`;
      ctx.log("system", `Cycle complete — docking (${reason})...`);

      yield "dock";
      // Don't navigate if in correct fleet - just dock locally
      let docked: boolean;
      if (!inCorrectFleet) {
        docked = await navigateToSafeStation(ctx, safetyOpts);
      } else {
        ctx.log("escort", "In fleet with miner - docking locally for maintenance");
        docked = await ensureDocked(ctx);
      }
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

      if (settings.homeSystem && bot.system === settings.homeSystem) {
        await collectFuelCells(ctx);
      }

      await ensureHunterResupply(ctx);

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
