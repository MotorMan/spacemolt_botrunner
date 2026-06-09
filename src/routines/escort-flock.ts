/**
 * Escort routine (flock mode) — follows and protects a specified miner/salvager bot.
 *
 * This is the OLD-STYLE escort that uses chat signals instead of fleet commands.
 * The escort follows the miner via "Going to [system]" and "Jumping to [system]"
 * messages in the bot chat channel. Miners are free to leave to unload at any time.
 *
 * Loop:
 *   1. Track the escorted bot's system via bot chat signals
 *   2. Jump to the escorted bot's system when it moves
 *   3. Stay in the same system, scanning for hostile players/pirates
 *   4. Get pulled into battles automatically when escorted bot fights
 *   5. Engage any threats automatically (proactive and reactive)
 *   6. Flee and dock if hull drops below flee threshold
 *   7. Refuel, repair, resupply as needed
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
 *   ignoreBlacklist   — bypass system blacklist (default: false)
 *
 * Home system is automatically determined from general.factionStorageSystem (default: "sol")
 */

import type { Routine, RoutineContext } from "../bot.js";
import { getBotChatChannel } from "../botmanager.js";
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
    fleeThreshold: 0,
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

// ── Fuel cell collection ─────────────────────────────────────

async function collectFuelCells(ctx: RoutineContext): Promise<boolean> {
  const { bot } = ctx;

  if (!bot.docked) return false;

  await bot.refreshCargo();
  const availableSpace = bot.cargoMax - bot.cargo;

  const fuelCellSpace = Math.floor(bot.cargoMax / 2);
  const maxPremiumFuelCells = Math.floor(fuelCellSpace / 2);

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

  const toWithdraw = Math.min(maxPremiumFuelCells, factionPremium.quantity, Math.floor(availableSpace / 2), 200);
  ctx.log("system", `Withdrawing ${toWithdraw} premium fuel cells from faction storage...`);

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

// ── Combat ─────────────────────────────────────────────────

// ── Battle analysis for escort ───────────────────────────────

function isPlayerParticipant(username: string | undefined): boolean {
  if (!username) return false;
  const u = username.toLowerCase();
  return !u.includes("pirate") && !u.includes("drifter") &&
         !u.includes("executioner") && !u.includes("sentinel") &&
         !u.includes("prowler") && !u.includes("apex") &&
         !u.includes("razor") && !u.includes("striker") &&
         !u.includes("rampart") && !u.includes("stalwart") &&
         !u.includes("bastion") && !u.includes("onslaught") &&
         !u.includes("iron") && !u.includes("strike") &&
         !u.includes("battle") && !u.startsWith("[police]");
}

function isPlayerAttacker(entity: NearbyEntity): boolean {
  if (entity.isPirate || entity.isNPC) return false;
  if (!entity.name) return false;
  const name = entity.name.toLowerCase();
  const pirateKeywords = ["pirate", "drifter", "executioner", "sentinel", "prowler", "apex", "razor", "striker", "rampart", "stalwart", "bastion", "onslaught", "iron", "strike", "battle"];
  return !pirateKeywords.some(kw => name.includes(kw)) && !name.startsWith("[police]");
}

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

  const botUsername = ctx.bot.username;

  interface SideInfo {
    sideId: number;
    playerCount: number;
    pirateCount: number;
    playerNames: string[];
    pirateNames: string[];
    minerOnSide: boolean;
    botOnSide: boolean;
  }

  const sideInfo: SideInfo[] = battleStatus.sides.map(side => {
    const members = battleStatus.participants.filter(p => p.side_id === side.side_id);
    const players = members.filter(p => isPlayerParticipant(p.username));
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

    const minerLower = minerName.toLowerCase();
    const botLower = botUsername.toLowerCase();
    const minerOnSide = members.some(m => (m.username || "").toLowerCase() === minerLower);
    const botOnSide = members.some(m => (m.username || "").toLowerCase() === botLower);

    return {
      sideId: side.side_id,
      playerCount: players.length,
      pirateCount: pirates.length,
      playerNames: players.map(p => p.username || p.player_id),
      pirateNames: pirates.map(p => p.username || p.player_id),
      minerOnSide,
      botOnSide,
    };
  });

  ctx.log("combat", `   ${sideInfo.map(s =>
    `Side ${s.sideId}: ${s.playerCount}p [${s.playerNames.join(",")}] vs ${s.pirateCount}pir [${s.pirateNames.join(",")}]`
  ).join(" | ")}`);

  const playerVsPirateSides = sideInfo.filter(s => s.playerCount > 0 && s.pirateCount > 0);

  if (playerVsPirateSides.length > 0) {
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

  const playerOnlySides = sideInfo.filter(s => s.playerCount > 0 && s.pirateCount === 0);
  if (playerOnlySides.length > 0) {
    const minerSide = sideInfo.find(s => s.minerOnSide);
    const botSide = sideInfo.find(s => s.botOnSide);

    if (minerSide && !minerSide.botOnSide) {
      const attackers = playerOnlySides.filter(s => s.sideId !== minerSide.sideId);
      if (attackers.length > 0) {
        ctx.log("combat", `🚨 Player attack detected on escortee ${minerName} — joining their side!`);
        return {
          shouldJoin: true,
          sideId: minerSide.sideId,
          reason: `Player attack on escortee ${minerName} — joining their side`,
          pirateCount: 0,
        };
      }
    }

    if (botSide) {
      const attackers = playerOnlySides.filter(s => s.sideId !== botSide.sideId);
      if (attackers.length > 0) {
        ctx.log("combat", `🚨 Player attack detected on escort — staying and fighting!`);
        return {
          shouldJoin: true,
          sideId: botSide.sideId,
          reason: `Player attack on escort — staying and fighting`,
          pirateCount: 0,
        };
      }
    }

    const nonPirateParticipants = battleStatus.participants.filter(p => isPlayerParticipant(p.username));
    if (nonPirateParticipants.length >= 2 && battleStatus.sides.length >= 2) {
      return { shouldJoin: false, reason: "PvP battle — escort staying out", pirateCount: 0 };
    }
    return { shouldJoin: false, reason: "Pirate vs pirate — escort not engaging", pirateCount: 0 };
  }

  const nonPirateParticipants = battleStatus.participants.filter(p => {
    const u = (p.username || "").toLowerCase();
    return !u.includes("pirate") && !u.includes("drifter") && !p.username?.startsWith("[POLICE]");
  });
  if (nonPirateParticipants.length >= 2 && battleStatus.sides.length >= 2) {
    return { shouldJoin: false, reason: "PvP battle — escort staying out", pirateCount: 0 };
  }
  return { shouldJoin: false, reason: "Pirate vs pirate — escort not engaging", pirateCount: 0 };
}

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
  
  if (!analysis.shouldJoin) {
    ctx.log("combat", `Battle analysis: ${analysis.reason}`);
    const alreadyInBattle = ctx.bot.isInBattle();
    if (alreadyInBattle) {
      ctx.log("combat", `🚨 Already in battle — continuing to fight!`);
    } else {
      ctx.log("combat", `🚨 Escort fights regardless - protecting the miner!`);
    }
  }

  if (analysis.sideId !== undefined) {
    ctx.log("combat", `✅ Joining battle on side ${analysis.sideId}: ${analysis.reason}`);
    const engageResp = await ctx.bot.exec("battle", { action: "engage", side_id: analysis.sideId.toString() });
    if (engageResp.error && !engageResp.error.message.includes("already")) {
      ctx.log("error", `Failed to join unexpected battle: ${engageResp.error.message}`);
    }
  }

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
  
  const shieldRechargePctDecimal = shieldRechargePct / 100;
  await fightJoinedBattle(ctx, fakeTarget as any, fleeThreshold, fleeFromTier, maxAttackTier, repairThreshold, false, shieldRechargePctDecimal, false);
}

// ── Safe-system docking ─────────────────────────────────────

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

// ── Chat-based miner tracking ─────────────────────────────────

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

// ── Escort routine (flock mode - chat-based) ───────────────────────────────

const POSITION_VERIFY_TIMEOUT = 30000;

async function checkPositionAndCoordinate(
  ctx: RoutineContext,
  minerName: string,
): Promise<string | null> {
  const { bot } = ctx;
  const chatChannel = getBotChatChannel();
  
  chatChannel.send({
    sender: bot.username,
    recipients: [minerName],
    channel: "escort",
    content: "QUERY_LOCATION"
  });
  
  ctx.log("escort", `Sent location query to ${minerName}...`);
  
  const startTime = Date.now();
  while (Date.now() - startTime < POSITION_VERIFY_TIMEOUT) {
    const messages = chatChannel.getHistory("escort", 20);
    for (const msg of messages) {
      if (msg.sender?.toLowerCase() === minerName.toLowerCase() && msg.content.startsWith("LOCATION: ")) {
        const minerSystem = msg.content.substring(9).trim();
        ctx.log("escort", `${minerName} responded: system=${minerSystem}`);
        return minerSystem;
      }
    }
    await ctx.sleep(500);
  }
  
  ctx.log("escort", `No location response from ${minerName} within timeout`);
  return null;
}

export const escortFlockRoutine: Routine = async function* (ctx: RoutineContext) {
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

  if (bot.docked) {
    await repairShip(ctx);
    await tryRefuel(ctx);
    await ensureHunterResupply(ctx);
  }

  let totalKills = 0;

  while (bot.state === "running") {
    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) { await ctx.sleep(30000); continue; }

    if (bot.isInBattle()) {
      battleRef.state.inBattle = true;
      ctx.log("combat", "[WebSocket] Battle detected — will handle in combat section");
    }

    const settings = getEscortSettings(bot.username);
    const minerName = settings.minerName;

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

    yield "get_status";
    await bot.refreshStatus();
    logStatus(ctx);

    yield "position_check";
    const chatChannel = getBotChatChannel();
    const recentMessages = chatChannel.getHistory("escort", 20);
    let minerSystem: string | null = null;
    
    for (let i = recentMessages.length - 1; i >= 0; i--) {
      const msg = recentMessages[i];
      if (msg.sender?.toLowerCase() === minerName.toLowerCase()) {
        if (msg.content.startsWith("LOCATION: ")) {
          minerSystem = msg.content.substring(9).trim();
          setMinerLocation(minerName, minerSystem);
          ctx.log("escort", `Miner ${minerName} at ${minerSystem} (broadcast)`);
          break;
        }
        const jumpMatch = msg.content.match(/Jumping to ([a-z0-9_]+)/i);
        const travelMatch = msg.content.match(/Going to ([a-z0-9_]+)/i);
        const match = jumpMatch || travelMatch;
        if (match) {
          minerSystem = match[1].toLowerCase();
          setMinerLocation(minerName, minerSystem);
          ctx.log("escort", `Miner ${minerName} at ${minerSystem}`);
          break;
        }
      }
    }

    if (!minerSystem) {
      minerSystem = getMinerLocation(minerName);
    }
    
    if (!minerSystem) {
      minerSystem = await checkPositionAndCoordinate(ctx, minerName);
    }
    
    if (!minerSystem) {
      ctx.log("escort", `No location for ${minerName} — waiting for signal...`);
      await ctx.sleep(5000);
      continue;
    }

    yield "fuel_check";
    let fueled = await ensureFueled(ctx, settings.refuelThreshold);

    yield "navigation";
    if (bot.system !== minerSystem) {
      ctx.log("escort", `Following ${minerName} to ${minerSystem}...`);
      const arrived = await navigateToSystem(ctx, minerSystem, safetyOpts);
      if (!arrived) {
        ctx.log("error", `Could not reach ${minerSystem} — retrying...`);
        await ctx.sleep(10000);
        continue;
      }
    }

    yield "standby";
    ctx.log("escort", `Standing by in ${bot.system} — monitoring for threats to ${minerName}...`);

    yield "scan_system";
    await fetchSecurityLevel(ctx, bot.system);

    await handleUnexpectedEscortBattle(ctx, settings.maxAttackTier, settings.minPiratesToFlee, settings.fleeThreshold, settings.fleeFromTier, minerName, 0, settings.shieldRechargePct);

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

    const nearbyResp = await bot.exec("get_nearby");
    if (!nearbyResp.error && nearbyResp.result) {
      const entities = parseNearby(nearbyResp.result);
      const pirateTargets = entities.filter(e => isPirateTarget(e, false, "boss"));
      const playerAttackers = entities.filter(e => isPlayerAttacker(e));

      const inCombat = battleRef.state.inBattle || bot.isInBattle();

      if (!inCombat) {
        if (pirateTargets.length > 0) {
          ctx.log("combat", `Found ${pirateTargets.length} hostile pirate(s) in system...`);

          for (const target of pirateTargets) {
            if (bot.state !== "running") break;

            await bot.refreshStatus();
            const preHull = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
            if (preHull <= settings.repairThreshold) {
              ctx.log("system", `Hull at ${preHull}% — docking...`);
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
              await bot.refreshStatus();
              ctx.log("combat", `Post-fight: hull ${bot.hull}/${bot.maxHull} | ammo ${bot.ammo} | credits ${bot.credits}`);
            } else {
              battleRef.state.inBattle = false;
              battleRef.state.battleId = null;
              ctx.log("combat", "Retreated — docking to repair");
              break;
            }
          }
        } else {
          ctx.log("escort", `No threats in ${bot.system} — standing by`);
          await scavengeWrecks(ctx);
        }
      } else {
        ctx.log("combat", `In battle — checking for player attackers...`);
        const postBattle = await getBattleStatus(ctx);
        if (postBattle && postBattle.is_participant) {
          for (const target of playerAttackers) {
            ctx.log("combat", `Player attacker ${target.name} detected in system during battle`);
          }
        }
        await scavengeWrecks(ctx);
      }
    }

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
      if (docked) {
        await tryRefuel(ctx);
        await repairShip(ctx);
        await ensureInsured(ctx);
        await bot.checkSkills();
        await ensureHunterResupply(ctx);
        await ensureUndocked(ctx);
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

    yield "wait";
    await ctx.sleep(8000);
  }
};

// ── Helper function for safe station docking ─────────────────

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