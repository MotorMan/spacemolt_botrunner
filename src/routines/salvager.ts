import type { Routine, RoutineContext } from "../bot.js";
import type { BotChatMessage } from "../bot_chat_channel.js";
import { mapStore } from "../mapstore.js";
import { getBotChatChannel } from "../botmanager.js";
import {
  isMinablePoi,
  isStationPoi,
  isScenicPoi,
  findStation,
  findSalvageYardStation,
  getSystemForSalvageYard,
  collectFromStorage,
  ensureDocked,
  ensureUndocked,
  tryRefuel,
  repairShip,
  ensureFueled,
  navigateToSystem,
  factionDonateProfit,
  detectAndRecoverFromDeath,
  getModProfile,
  ensureModsFitted,
  readSettings,
  scavengeWrecks,
  fullSalvageWrecks,
  processTowedWrecks,
  getSystemInfo,
  checkAndFleeFromBattle,
  checkBattleAfterCommand,
  getBattleStatus,
  type BattleState,
  handleBattleNotifications,
  fleeFromBattle,
  parseWrecks,
} from "./common.js";
import { getSystemBlacklist } from "../web/server.js";
import {
  readFlockState,
  registerFlockMember,
  announceFlockTarget,
  updateFlockPhase,
  claimFlockWreck,
  reportFlockWrecks,
  getAvailableFlockWrecks,
  setFlockTimeout,
  isFlockTimeoutExpired,
  type FlockState,
  type FlockGroupConfig,
} from "./flock.js";

// ── Temporary pirate blacklist (in-memory) ────────────────────
const temporaryPirateBlacklist = new Map<string, number>(); // systemId -> expiresAt timestamp

/**
 * Add a system to the temporary pirate blacklist.
 * @param systemId System to blacklist
 * @param durationMinutes How long to blacklist (default: 30 minutes)
 */
function addTemporaryPirateBlacklist(systemId: string, durationMinutes: number = 30): void {
  const expiresAt = Date.now() + durationMinutes * 60 * 1000;
  temporaryPirateBlacklist.set(systemId, expiresAt);
  console.log(`[BLACKLIST] Added ${systemId} to temporary pirate blacklist for ${durationMinutes} minutes`);
}

/**
 * Check if a system is temporarily blacklisted due to recent pirate activity.
 */
function isTemporarilyBlacklisted(systemId: string): boolean {
  const expiresAt = temporaryPirateBlacklist.get(systemId);
  if (!expiresAt) return false;

  // Remove expired entries
  if (Date.now() > expiresAt) {
    temporaryPirateBlacklist.delete(systemId);
    return false;
  }

  return true;
}

/**
 * Clean up expired temporary blacklists (call periodically).
 */
function cleanupTemporaryBlacklist(): void {
  const now = Date.now();
  for (const [systemId, expiresAt] of temporaryPirateBlacklist.entries()) {
    if (now > expiresAt) {
      temporaryPirateBlacklist.delete(systemId);
    }
  }
}

// ── Settings ─────────────────────────────────────────────────

type DepositMode = "storage" | "faction" | "sell";

function getSalvagerSettings(username?: string): {
  depositMode: DepositMode;
  cargoThreshold: number;
  refuelThreshold: number;
  repairThreshold: number;
  system: string;
  homeSystem: string;
  salvageYardSystem: string;
  salvageYardStation: string;
  autoCloak: boolean;
  enableFullSalvage: boolean;
  enableTowing: boolean;
  minTowValue: number;
  preferScrap: boolean;
  maxRoamJumps: number;
  roamBaseSystems: string[];
  depositAtSalvageYard: boolean;

  // Flock salvaging settings
  flockEnabled: boolean;
  flockName: string;
  flockRole: "leader" | "follower";
  allowIndependentTowing: boolean;
} {
  const all = readSettings();
  const m = all.salvager || {};
  let botOverrides = username ? (all[username] || {}) : {};

  // Include flock assignments
  if (username && all.flock?.flockAssignments && typeof all.flock.flockAssignments === 'object' && (all.flock.flockAssignments as any)[username]) {
    botOverrides = { ...botOverrides, ...(all.flock.flockAssignments as any)[username] };
  }

  function parseDepositMode(val: unknown): DepositMode | null {
    if (val === "faction" || val === "sell" || val === "storage") return val;
    return null;
  }

  function parseStringArray(val: unknown): string[] {
    if (Array.isArray(val)) return val.filter((s): s is string => typeof s === "string" && s.length > 0);
    if (typeof val === "string") return val.split(",").map(s => s.trim()).filter(s => s.length > 0);
    return [];
  }

  return {
    depositMode:
      parseDepositMode(botOverrides.depositMode) ??
      parseDepositMode(m.depositMode) ?? "sell",
    cargoThreshold: (m.cargoThreshold as number) || 80,
    refuelThreshold: (m.refuelThreshold as number) || 50,
    repairThreshold: (m.repairThreshold as number) || 40,
    system: (botOverrides.system as string) || (m.system as string) || "",
    homeSystem: (botOverrides.homeSystem as string) || (m.homeSystem as string) || "",
    salvageYardSystem: (botOverrides.salvageYardSystem as string) || (m.salvageYardSystem as string) || "",
    salvageYardStation: (botOverrides.salvageYardStation as string) || (m.salvageYardStation as string) || "",
    autoCloak: (m.autoCloak as boolean) ?? false,
    enableFullSalvage: (m.enableFullSalvage as boolean) !== false,
    enableTowing: (m.enableTowing as boolean) ?? false,
    minTowValue: (m.minTowValue as number) || 500,
    preferScrap: (m.preferScrap as boolean) ?? false,
    maxRoamJumps: (m.maxRoamJumps as number) || 0, // 0 = no roaming beyond neighbors
    roamBaseSystems: parseStringArray(botOverrides.roamBaseSystems ?? m.roamBaseSystems),
    depositAtSalvageYard: (m.depositAtSalvageYard as boolean) ?? false,

    // Flock salvaging settings
    flockEnabled: (botOverrides.flockEnabled as boolean) ?? false,
    flockName: (botOverrides.flockName as string) || "",
    flockRole: ((botOverrides.flockRole as string) === "leader" ? "leader" : "follower") as "leader" | "follower",
    allowIndependentTowing: (m.allowIndependentTowing as boolean) ?? false,
  };
}

// ── Flock-coordinated salvage function ────────────────────────

async function flockSalvageWrecks(
  ctx: RoutineContext,
  opts: {
    enableTow: boolean;
    minTowValue: number;
    battleState: BattleState;
    flockName: string;
    username: string;
    isLeader: boolean;
    allowIndependentTowing: boolean;
    timeoutExpired: boolean;
    availableWrecks: Array<{ poiId: string; wreckId: string }>;
  }
): Promise<{ itemsLooted: number; isTowing: boolean }> {
  const { bot } = ctx;
  const {
    enableTow,
    minTowValue,
    battleState,
    flockName,
    username,
    isLeader,
    allowIndependentTowing,
    timeoutExpired,
    availableWrecks,
  } = opts;

  if (bot.docked) return { itemsLooted: 0, isTowing: false };

  const wrecksResp = await bot.exec("get_wrecks");
  const allWrecks = parseWrecks(wrecksResp.result);
  if (allWrecks.length > 0) {
    ctx.log("scavenge", `get_wrecks found ${allWrecks.length} wreck(s)`);
  }
  if (allWrecks.length === 0) return { itemsLooted: 0, isTowing: bot.towingWreck };

  let totalLooted = 0;
  const lootedItems: string[] = [];

  for (const wreck of allWrecks) {
    if (bot.state !== "running") break;

    await bot.refreshStatus();
    if (bot.cargoMax > 0 && bot.cargo >= bot.cargoMax) {
      ctx.log("scavenge", "Cargo full — stopping salvage");
      break;
    }

    // Check if this wreck is available for this bot
    const wreckAvailable = availableWrecks.some(w => w.wreckId === wreck.wreck_id);
    if (!wreckAvailable && !isLeader && !timeoutExpired) {
      ctx.log("flock", `Wreck ${wreck.wreck_id} not available to this follower — skipping`);
      continue;
    }

    // Loot cargo from the wreck (same as standard salvage)
    if (wreck.items.length > 0) {
      // Sort: fuel cells first
      const candidates = [...wreck.items].sort((a, b) => {
        const aPri = a.item_id.toLowerCase().includes("fuel") || a.item_id.toLowerCase().includes("energy") ? 0 : 1;
        const bPri = b.item_id.toLowerCase().includes("fuel") || b.item_id.toLowerCase().includes("energy") ? 0 : 1;
        return aPri - bPri;
      });

      for (const item of candidates) {
        if (bot.state !== "running") break;

        const lootResp = await bot.exec("loot_wreck", { wreck_id: wreck.wreck_id, item_id: item.item_id, quantity: item.quantity });
        if (lootResp.error) {
          if (lootResp.error.message.includes("already")) {
            // Item already looted by someone else - continue to next item
            continue;
          }
          // Other error - log and continue to next wreck
          ctx.log("warn", `Failed to loot ${item.name} from ${wreck.name}: ${lootResp.error.message}`);
          continue;
        }

        totalLooted += item.quantity;
        lootedItems.push(`${item.quantity}x ${item.name}`);
        ctx.log("scavenge", `Looted ${item.quantity}x ${item.name} from ${wreck.name}`);

        // Check cargo again after looting
        await bot.refreshStatus();
        if (bot.cargoMax > 0 && bot.cargo >= bot.cargoMax) {
          ctx.log("scavenge", "Cargo full after looting — stopping salvage");
          return { itemsLooted: totalLooted, isTowing: bot.towingWreck };
        }
      }
    }

    // Consider towing this wreck (flock-coordinated)
    if (enableTow) {
      // Check if we can claim this wreck
      let canTow = false;

      if (isLeader) {
        // Leader can always tow
        canTow = true;
      } else if (timeoutExpired && allowIndependentTowing) {
        // Timeout expired and independent towing allowed
        canTow = true;
        ctx.log("flock", `Timeout expired - allowing independent towing of ${wreck.name}`);
      } else {
        // Try to claim the wreck
        const claimed = await claimFlockWreck(flockName, username, wreck.wreck_id.split("-")[0], wreck.wreck_id);
        if (claimed) {
          canTow = true;
          ctx.log("flock", `Claimed wreck ${wreck.wreck_id} for towing`);
        } else {
          ctx.log("flock", `Failed to claim wreck ${wreck.wreck_id} - another bot got it`);
        }
      }

      if (canTow) {
        const towResp = await bot.exec("tow_wreck", { wreck_id: wreck.wreck_id });
        if (towResp.error) {
          const msg = towResp.error.message.toLowerCase();
          if (msg.includes("already")) {
            if (msg.includes("already_towing") || msg.includes("already towing")) {
              ctx.log("warn", `Already towing a wreck — heading to salvage yard`);
              bot.towingWreck = true;
              return { itemsLooted: totalLooted, isTowing: true };
            } else {
              ctx.log("scavenge", `Wreck ${wreck.wreck_id} already being towed by another player`);
            }
          } else {
            ctx.log("warn", `Failed to tow ${wreck.name}: ${towResp.error.message}`);
          }
        } else {
          // Successful tow - get value from response
          const tr = towResp.result as any;
          const salvageValue = (tr?.salvage_value as number) || 0;
          const shipClass = (tr?.ship_class as string) || "unknown";

          if (salvageValue >= minTowValue) {
            ctx.log("scavenge", `Towed ${shipClass} wreck (${wreck.name}) - value: ${salvageValue}cr`);
            bot.towingWreck = true;
            return { itemsLooted: totalLooted, isTowing: true };
          } else {
            ctx.log("scavenge", `Towed ${shipClass} wreck (${wreck.name}) but value ${salvageValue}cr below threshold ${minTowValue}cr - releasing`);
            // Release the tow since it's not valuable enough
            await bot.exec("release_tow");
          }
        }
      }
    }
  }

  return { itemsLooted: totalLooted, isTowing: bot.towingWreck };
}

// ── Bot chat handler for escort queries ───────────────────────

// ── Escort signaling ──────────────────────────────────────────

async function signalEscort(
  ctx: RoutineContext,
  action: "jump" | "travel" | "dock" | "undock",
  systemId?: string,
  channel: "faction" | "local" | "file" | "chat" = "faction",
): Promise<void> {
  const { bot } = ctx;
  const message = `[ESCORT] ${action}${systemId ? ` ${systemId}` : ""}`;

  if (channel === "faction") {
    await bot.exec("chat", { channel: "faction", content: message });
  } else if (channel === "local") {
    ctx.log("escort", `Signal: ${message}`);
  } else if (channel === "chat") {
    // Use non-API chat channel for instant coordination
    ctx.sendBotChat?.(message, "escort");
  } else {
    // File-based signaling for cross-bot coordination on same machine
    const { writeFileSync, existsSync, mkdirSync } = await import("fs");
    const { join } = await import("path");
    const escortDir = join(process.cwd(), "data", "escort_signals");
    if (!existsSync(escortDir)) mkdirSync(escortDir, { recursive: true });
    const signalFile = join(escortDir, `${bot.username}.signal`);
    writeFileSync(signalFile, JSON.stringify({ action, systemId, timestamp: Date.now() }));
  }
}

// ── BFS helpers for roaming ──────────────────────────────────

/**
 * Find all systems within N jumps from a starting system using BFS.
 * Returns systems ordered by distance (hops), excluding the start system.
 */
function findSystemsInRange(fromSystemId: string, maxHops: number): Array<{ systemId: string; hops: number }> {
  if (maxHops <= 0) return [];

  const visited = new Set<string>([fromSystemId]);
  const queue: Array<{ id: string; hops: number }> = [{ id: fromSystemId, hops: 0 }];
  const results: Array<{ systemId: string; hops: number }> = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.hops >= maxHops) continue;

    for (const conn of mapStore.getConnections(current.id)) {
      if (visited.has(conn.system_id)) continue;
      visited.add(conn.system_id);
      const newHops = current.hops + 1;
      results.push({ systemId: conn.system_id, hops: newHops });
      queue.push({ id: conn.system_id, hops: newHops });
    }
  }

  return results;
}

/**
 * Build an ordered list of systems to roam through.
 * If roamBaseSystems are configured, use those as starting points (filtered by maxRoamJumps).
 * Otherwise, use the current system as the base.
 * Systems on the blacklist or temporarily blacklisted are excluded.
 */
function buildRoamList(currentSystem: string, maxRoamJumps: number, roamBaseSystems: string[], blacklist: string[]): string[] {
  const bases = roamBaseSystems.length > 0 ? roamBaseSystems : [currentSystem];
  const allSystems = new Set<string>();
  const blacklistLower = blacklist.map(b => b.toLowerCase());

  for (const base of bases) {
    // Always include the base (unless blacklisted or temporarily blacklisted)
    if (!blacklistLower.some(b => b === base.toLowerCase()) && !isTemporarilyBlacklisted(base)) {
      allSystems.add(base);
      // Add systems within range
      for (const sys of findSystemsInRange(base, maxRoamJumps)) {
        if (!blacklistLower.some(b => b === sys.systemId.toLowerCase()) && !isTemporarilyBlacklisted(sys.systemId)) {
          allSystems.add(sys.systemId);
        }
      }
    }
  }

  return [...allSystems];
}

// ── Salvager routine ─────────────────────────────────────────

/**
 * Salvager routine — travels POI to POI scavenging wrecks:
 *
 * 1. Undock, get system info
 * 2. Visit each minable POI (belts, clouds, fields) looking for wrecks
 * 3. Loot and salvage wrecks at each location
 * 4. When cargo full or all POIs visited, return to station and sell
 * 5. Refuel, repair, repeat
 */
export const salvagerRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  // Persistent battle state across cycles
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
  const startSystem = bot.system;
  const settings0 = getSalvagerSettings(bot.username);
  const homeSystem0 = settings0.homeSystem || startSystem;

  // Register chat handler for escort queries
  const chatChannel = getBotChatChannel();
  const chatHandler = (message: BotChatMessage) => {
    if (message.channel === "escort" && message.recipients.includes(bot.username) && message.content === "QUERY_LOCATION") {
      chatChannel.send({ sender: bot.username, recipients: [message.sender], channel: "escort", content: `LOCATION: ${bot.system}` });
      ctx.log("escort", `Responded to location query: ${bot.system}`);
    }
  };
  chatChannel.onMessage(bot.username, chatHandler);

  // ── Startup: return home and dump non-fuel cargo to storage ──
  await bot.refreshCargo();
  const nonFuelCargo = bot.inventory.filter(i => {
    const lower = i.itemId.toLowerCase();
    return !lower.includes("fuel") && !lower.includes("energy_cell") && i.quantity > 0;
  });
  if (nonFuelCargo.length > 0) {
    if (bot.system !== homeSystem0) {
      ctx.log("salvage", `Startup: returning to home system ${homeSystem0} to deposit cargo...`);
      const fueled = await ensureFueled(ctx, 50);
      if (fueled) {
        await navigateToSystem(ctx, homeSystem0, { fuelThresholdPct: 50, hullThresholdPct: 30 });
      }
    }
    await ensureDocked(ctx);
    for (const item of nonFuelCargo) {
      if (settings0.depositMode === "sell") {
        const sResp = await bot.exec("sell", { item_id: item.itemId, quantity: item.quantity });
        if (sResp.error) {
          await bot.exec("deposit_items", { item_id: item.itemId, quantity: item.quantity });
        }
      } else if (settings0.depositMode === "faction") {
        const fResp = await bot.exec("faction_deposit_items", { item_id: item.itemId, quantity: item.quantity });
        if (fResp.error) {
          await bot.exec("deposit_items", { item_id: item.itemId, quantity: item.quantity });
        }
      } else {
        await bot.exec("deposit_items", { item_id: item.itemId, quantity: item.quantity });
      }
    }
    const names = nonFuelCargo.map(i => `${i.quantity}x ${i.name}`).join(", ");
    ctx.log("salvage", `Startup: deposited ${names} — cargo clear for salvaging`);
  }

  // ── Flock salvaging integration ──
  let isFlockLeader = false;
  let flockTargetSystemId = "";
  let flockPhase: FlockState["phase"] = "gathering";
  let flockGroup: FlockGroupConfig | undefined;

  while (bot.state === "running") {
    // Clean up expired temporary blacklists
    cleanupTemporaryBlacklist();

    // ── Death recovery ──
    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) { await ctx.sleep(30000); continue; }

    // ── Battle check ──
    if (await checkAndFleeFromBattle(ctx, "salvager")) {
      await ctx.sleep(5000);
      continue;
    }



    // Periodic battle status check (backup detection in case notifications fail)
    // Check every cycle for fast detection
    if (bot.isInBattle()) {
      const now = Date.now();
      if (!battleRef.state!.lastFleeTime || now - battleRef.state!.lastFleeTime > 10000) { // Only issue if more than 10 seconds since last flee
        ctx.log("combat", `PERIODIC CHECK: IN BATTLE! - initiating IMMEDIATE flee!`);
        battleRef.state!.inBattle = true;
        battleRef.state!.isFleeing = false;

        // Add current system to temporary pirate blacklist to avoid returning soon
        addTemporaryPirateBlacklist(bot.system);

        await bot.exec("battle", { action: "stance", stance: "flee" });
        battleRef.state!.lastFleeTime = now;
        ctx.log("combat", "Flee stance issued - will re-issue every cycle until disengaged!");
      }
    }

    // If we're in battle, re-issue flee command to ensure we stay in flee stance
    if (battleRef.state!.inBattle) {
      const now = Date.now();
      if (!battleRef.state!.lastFleeTime || now - battleRef.state!.lastFleeTime > 10000) { // Only issue if more than 10 seconds since last flee
        ctx.log("combat", "Re-issuing flee stance (ensuring we stay in flee mode)...");
        const fleeResp = await bot.exec("battle", { action: "stance", stance: "flee" });
        if (fleeResp.error) {
          ctx.log("error", `Flee re-issue failed: ${fleeResp.error.message}`);
        } else {
          battleRef.state!.lastFleeTime = now;
        }
      }
      // Check if we've successfully disengaged
      const currentBattleStatus = await getBattleStatus(ctx);
      if (!currentBattleStatus || !currentBattleStatus.is_participant) {
        ctx.log("combat", "Battle cleared - no longer in combat!");
        battleRef.state!.inBattle = false;
        battleRef.state!.battleId = null;
        battleRef.state!.isFleeing = false;
        battleRef.state!.lastFleeTime = undefined;
        await ctx.sleep(2000); // Brief pause before next check
        continue;
      }
      // Still in battle - continue to next cycle
      await ctx.sleep(2000); // Brief pause before next check
      continue;
    }

    // ── Verify tow status — sync with server but DON'T release (we may be heading to salvage yard) ──
    await bot.refreshStatus();
    if (bot.towingWreck) {
      // Check if server confirms we're towing (don't release — we might be heading to salvage yard)
      const statusResp = await bot.exec("get_status");
      const towingOnServer = (statusResp.result as Record<string, unknown>)?.towing_wreck as boolean || false;
      if (!towingOnServer) {
        ctx.log("warn", "Bot thought it was towing but server says no — clearing stale tow flag");
        bot.towingWreck = false;
      } else {
        ctx.log("scavenge", `Still towing wreck — will head to salvage yard this cycle`);
      }
    }

    const settings = getSalvagerSettings(bot.username);
    const homeSystem = settings.homeSystem || startSystem;
    const cargoThresholdRatio = settings.cargoThreshold / 100;
    const safetyOpts = {
      fuelThresholdPct: settings.refuelThreshold,
      hullThresholdPct: settings.repairThreshold,
      autoCloak: settings.autoCloak,
    };

    // ── Flock salvaging integration ──
    if (settings.flockEnabled && settings.flockName) {
      // Find the flock group config for this bot
      // Note: For now, we'll assume flock groups are defined in miner settings
      // TODO: Add salvager-specific flock groups
      const allSettings = readSettings();
      const minerGroups = (allSettings.flock?.flockGroups as FlockGroupConfig[]) || [];
      flockGroup = minerGroups.find(g => g.name === settings.flockName);

      if (settings.flockRole === "leader") {
        isFlockLeader = true;
        ctx.log("flock", `Flock mode: LEADER of "${settings.flockName}"`);

        // Register as leader
        await registerFlockMember(settings.flockName, bot.username, true);

        // Determine target system from flock group config
        const groupSystem = flockGroup?.systemSalvage || settings.system || "";
        flockTargetSystemId = groupSystem;
        flockPhase = "gathering";

        ctx.log("flock", `Leader target: salvage in system ${groupSystem || "any system"}`);

        // Announce target to flock
        await announceFlockTarget(
          settings.flockName,
          bot.username,
          groupSystem,
          "",
          "",
          "salvage",
          "salvage"
        );

        // Set coordination timeout (5 minutes for others to grab wrecks)
        await setFlockTimeout(settings.flockName, 5);
      } else {
        // Follower: read flock state and follow leader's decisions
        const flockState = await readFlockState(settings.flockName);

        if (!flockState) {
          ctx.log("flock", `Flock mode: FOLLOWER of "${settings.flockName}" — waiting for leader...`);
          await ctx.sleep(5000);
          continue;
        }

        // Register as follower
        const registered = await registerFlockMember(settings.flockName, bot.username, false);
        if (!registered) {
          ctx.log("error", "Failed to join flock — state may be stale");
          await ctx.sleep(5000);
          continue;
        }

        ctx.log("flock", `Flock mode: FOLLOWER of "${settings.flockName}" (leader: ${flockState.leader})`);

        flockTargetSystemId = flockState.targetSystemId;
        flockPhase = flockState.phase;
      }
    } else {
      // Not in flock mode
      isFlockLeader = false;
      flockTargetSystemId = "";
      flockPhase = "gathering";
    }

    // ── Status + fuel/hull checks ──
    yield "get_status";
    await bot.refreshStatus();

    yield "fuel_check";
    const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
    if (!fueled) {
      ctx.log("error", "Cannot refuel — waiting 30s...");
      await ctx.sleep(30000);
      continue;
    }

    await bot.refreshStatus();
    const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    if (hullPct <= 40) {
      ctx.log("system", `Hull critical (${hullPct}%) — returning to station for repair`);
      await ensureDocked(ctx);
      await repairShip(ctx);
    }

    await ensureUndocked(ctx);

    // ── Navigate to target system if configured ──
    const targetSystemId = settings.system || "";
    if (targetSystemId && targetSystemId !== bot.system) {
      // Check if target system is blacklisted
      const blacklist = getSystemBlacklist();
      if (blacklist.some(b => b.toLowerCase() === targetSystemId.toLowerCase()) || isTemporarilyBlacklisted(targetSystemId)) {
        ctx.log("error", `Target system ${targetSystemId} is blacklisted — salvaging locally instead`);
      } else {
        // Announce destination and signal escorts before traveling
        const chatChannel = getBotChatChannel();
        chatChannel.send({ sender: bot.username, recipients: [], channel: "escort", content: `Going to ${targetSystemId}` });
        ctx.log("escort", `Sent going to ${targetSystemId}`);

        ctx.log("escort", `Signaling escorts to travel to ${targetSystemId}...`);
        await signalEscort(ctx, "travel", targetSystemId, "chat");
        await ctx.sleep(2000); // Brief pause to let escorts read the signal

        yield "navigate_to_target";
        const travelOpts = {
          ...safetyOpts,
          onBeforeJump: async (nextSystem: string, jumpNumber: number) => {
            const chatChannel = getBotChatChannel();
            chatChannel.send({ sender: bot.username, recipients: [], channel: "escort", content: `Jumping to ${nextSystem}` });
          }
        };

        const arrived = await navigateToSystem(ctx, targetSystemId, travelOpts);
        if (!arrived) {
          ctx.log("error", "Failed to reach target system — salvaging locally instead");
        }
      }
    }

    if (bot.state !== "running") break;

    // ── Get system POIs ──
    yield "scan_system";
    const { pois, systemId } = await getSystemInfo(ctx);
    if (systemId) bot.system = systemId;

    let stationPoi: { id: string; name: string } | null = null;
    const station = findStation(pois);
    if (station) stationPoi = { id: station.id, name: station.name };

    // Check if already towing from previous session - if so, skip POI scanning and go to salvage yard
    await bot.refreshStatus();
    let skipScanning = false;
    if (bot.towingWreck) {
      ctx.log("scavenge", "Already towing a wreck from previous session — heading to salvage yard");
      skipScanning = true;
    }

    // Build list of POIs to visit (all non-station POIs — wrecks can spawn anywhere)
    const visitPois = pois.filter(p => !isStationPoi(p));

    // Flock coordination: Check for timeout
    let flockTimeoutExpired = false;
    if (settings.flockEnabled && settings.flockName) {
      flockTimeoutExpired = await isFlockTimeoutExpired(settings.flockName);
      if (flockTimeoutExpired) {
        ctx.log("flock", "Flock coordination timeout expired - allowing independent operation");
      }
    }

    if (!skipScanning && visitPois.length === 0) {
      ctx.log("error", "No salvageable POIs in this system — waiting 60s");
      await ctx.sleep(30000);
      continue;
    }

    if (!skipScanning) {
      ctx.log("scavenge", `Found ${visitPois.length} POIs to scan for wrecks`);
    }

    // ── Visit each POI and scavenge ──
    let totalLooted = 0;
    let cargoFull = false;

    // Battle state tracking for salvage loop
    const battleState: BattleState = {
      inBattle: false,
      battleId: null,
      battleStartTick: null,
      lastHitTick: null,
      isFleeing: false,
    };

    if (!skipScanning) {
      for (const poi of visitPois) {
        if (bot.state !== "running") break;

        // If we're in battle, re-issue flee command every cycle
        if (battleState.inBattle) {
          ctx.log("combat", "Re-issuing flee stance during salvage operations (ensuring we stay in flee mode)...");
          const fleeResp = await bot.exec("battle", { action: "stance", stance: "flee" });
          if (fleeResp.error) {
            ctx.log("error", `Flee re-issue failed: ${fleeResp.error.message}`);
          }
          // Check if we've successfully disengaged
          const currentBattleStatus = await getBattleStatus(ctx);
          if (!currentBattleStatus || !currentBattleStatus.is_participant) {
            ctx.log("combat", "Battle cleared - no longer in combat! Resuming salvage operations...");
            battleState.inBattle = false;
            battleState.battleId = null;
            battleState.isFleeing = false;
          } else {
            // Still in battle - wait briefly and continue to next cycle to re-flee
            await ctx.sleep(2000);
            continue;
          }
        }

        // Check cargo before traveling
        await bot.refreshStatus();
        const fillRatio = bot.cargoMax > 0 ? bot.cargo / bot.cargoMax : 0;
        if (fillRatio >= cargoThresholdRatio) {
          ctx.log("scavenge", `Cargo at ${Math.round(fillRatio * 100)}% — heading to station`);
          cargoFull = true;
          break;
        }

        // Check fuel
        const fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
        if (fuelPct < safetyOpts.fuelThresholdPct) {
          ctx.log("scavenge", `Fuel low (${fuelPct}%) — heading to station`);
          break;
        }

        // Travel to POI
        yield "travel_to_poi";
        ctx.log("travel", `Traveling to ${poi.name}...`);
        const travelResp = await bot.exec("travel", { target_poi: poi.id });
        // Check for battle notifications after travel
        if (await checkBattleAfterCommand(ctx, travelResp.notifications, "travel", battleState)) {
          ctx.log("combat", "Battle detected during travel to POI - initiating flee!");
          battleState.isFleeing = false;
          continue;
        }
        if (travelResp.error && !travelResp.error.message.includes("already")) {
          ctx.log("error", `Travel to ${poi.name} failed: ${travelResp.error.message}`);
          continue;
        }
        bot.poi = poi.id;

        // Pre-salvage battle check - prevents salvage command from freezing if battle starts
        const preSalvageBattleCheck = await getBattleStatus(ctx);
        if (preSalvageBattleCheck && preSalvageBattleCheck.is_participant) {
          ctx.log("combat", `PRE-SALVAGE CHECK: IN BATTLE! Battle ID: ${preSalvageBattleCheck.battle_id} - initiating flee!`);
          battleState.inBattle = true;
          battleState.battleId = preSalvageBattleCheck.battle_id;
          battleState.isFleeing = false;
          await fleeFromBattle(ctx, false, 5000); // Initial flee, don't wait for disengage
          continue;
        }

        // Flock coordination: Get wrecks and coordinate before salvaging
        let availableWrecks: Array<{ poiId: string; wreckId: string }> = [];
        if (settings.flockEnabled && settings.flockName && settings.enableFullSalvage) {
          // Get wrecks at this POI for coordination
          const wrecksResp = await bot.exec("get_wrecks");
          const wrecks = parseWrecks(wrecksResp.result);
          availableWrecks = wrecks.map((w: any) => ({ poiId: poi.id, wreckId: w.wreck_id }));

          if (isFlockLeader) {
            // Leader reports found wrecks
            await reportFlockWrecks(settings.flockName, bot.username, availableWrecks);
            ctx.log("flock", `Reported ${availableWrecks.length} wrecks at ${poi.name} to flock`);
          } else {
            // Follower gets available wrecks from flock state
            const flockWrecks = await getAvailableFlockWrecks(settings.flockName, bot.username);
            availableWrecks = flockWrecks.filter(w => w.poiId === poi.id);
            ctx.log("flock", `Flock has ${availableWrecks.length} available wrecks at ${poi.name}`);
          }
        }

        // Salvage wrecks at this POI
        yield "scavenge";
        let result: { itemsLooted: number; isTowing: boolean };

        if (settings.flockEnabled && settings.flockName && settings.enableFullSalvage) {
          // Flock-coordinated salvage
          result = await flockSalvageWrecks(ctx, {
            enableTow: settings.enableTowing,
            minTowValue: settings.minTowValue,
            battleState,
            flockName: settings.flockName,
            username: bot.username,
            isLeader: isFlockLeader,
            allowIndependentTowing: settings.allowIndependentTowing,
            timeoutExpired: flockTimeoutExpired,
            availableWrecks,
          });
        } else {
          // Standard salvage
          result = settings.enableFullSalvage
            ? await fullSalvageWrecks(ctx, { enableTow: settings.enableTowing, minTowValue: settings.minTowValue, battleState })
            : { itemsLooted: await scavengeWrecks(ctx), isTowing: false };
        }

        totalLooted += result.itemsLooted;

        ctx.log("scavenge", `Salvage returned: itemsLooted=${result.itemsLooted}, isTowing=${result.isTowing}, bot.towingWreck=${bot.towingWreck}`);

        if (result.itemsLooted > 0) {
          ctx.log("scavenge", `Extracted ${result.itemsLooted} items at ${poi.name}`);
        }

        // If towing a wreck, stop scanning and head to salvage yard
        await bot.refreshStatus(); // Ensure we have latest towing state
        if (result.isTowing || bot.towingWreck) {
          ctx.log("scavenge", `*** TOW DETECTED *** (result=${result.isTowing}, bot=${bot.towingWreck}) — heading to salvage yard`);
          cargoFull = true; // Signal to stop all further scanning including neighbor expansion
          break;
        }
      }
    }

    if (bot.state !== "running") break;

    if (!skipScanning) {
      ctx.log("scavenge", `Salvage sweep done — ${totalLooted} items looted across ${visitPois.length} POIs`);
    }

    // ── Expand to roam systems if current system had no wrecks ──
    // Don't expand if already towing (need to deliver wreck first)
    if (!skipScanning && totalLooted === 0 && !cargoFull && !bot.towingWreck && bot.state === "running") {
      const blacklist = getSystemBlacklist();
      const roamList = buildRoamList(bot.system, settings.maxRoamJumps, settings.roamBaseSystems, blacklist);

      if (roamList.length > 0) {
        ctx.log("scavenge", `No wrecks locally — roaming across ${roamList.length} system(s): ${roamList.join(", ")}`);
      }

      for (const roamSystemId of roamList) {
        if (bot.state !== "running" || cargoFull || bot.towingWreck) break;

        // Skip if we're already in this system
        if (roamSystemId === bot.system) continue;

        // Check fuel before jumping
        await bot.refreshStatus();
        const fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
        if (fuelPct < safetyOpts.fuelThresholdPct) {
          ctx.log("scavenge", `Fuel low (${fuelPct}%) — stopping roam scan`);
          break;
        }

        // Re-check towing status before jumping
        if (bot.towingWreck) {
          ctx.log("scavenge", "Now towing a wreck — stopping roam scan and heading to salvage yard");
          break;
        }

        yield "roam_system";
        ctx.log("travel", `Jumping to ${roamSystemId} to check for wrecks...`);

        // Announce destination
        const chatChannel = getBotChatChannel();
        chatChannel.send({ sender: bot.username, recipients: [], channel: "escort", content: `Going to ${roamSystemId}` });
        ctx.log("escort", `Sent going to ${roamSystemId}`);
        await signalEscort(ctx, "travel", roamSystemId, "chat");
        await ctx.sleep(1000); // Brief pause

        await ensureUndocked(ctx);
        const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
        if (!fueled) break;
        const travelOpts = {
          ...safetyOpts,
          onBeforeJump: async (nextSystem: string, jumpNumber: number) => {
            const chatChannel = getBotChatChannel();
            chatChannel.send({ sender: bot.username, recipients: [], channel: "escort", content: `Jumping to ${nextSystem}` });
          }
        };
        const arrived = await navigateToSystem(ctx, roamSystemId, travelOpts);
        if (!arrived) continue;

        // Scan roam system POIs (all non-station POIs — wrecks can spawn anywhere)
        const { pois: roamPois } = await getSystemInfo(ctx);
        const roamVisit = roamPois.filter(p => !isStationPoi(p));
        if (roamVisit.length === 0) continue;

        for (const poi of roamVisit) {
          if (bot.state !== "running") break;

          await bot.refreshStatus();
          const fillRatio = bot.cargoMax > 0 ? bot.cargo / bot.cargoMax : 0;
          if (fillRatio >= cargoThresholdRatio) {
            ctx.log("scavenge", `Cargo at ${Math.round(fillRatio * 100)}% — heading to station`);
            cargoFull = true;
            break;
          }

          const rFuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
          if (rFuelPct < safetyOpts.fuelThresholdPct) break;

          yield "travel_to_poi";
          ctx.log("travel", `Traveling to ${poi.name} (${roamSystemId})...`);
          const tResp = await bot.exec("travel", { target_poi: poi.id });
          if (await checkBattleAfterCommand(ctx, tResp.notifications, "travel", battleState)) {
            ctx.log("combat", "Battle detected during roam travel - initiating flee!");
            battleState.isFleeing = false;
            break;
          }
          if (tResp.error && !tResp.error.message.includes("already")) continue;
          bot.poi = poi.id;

          // Pre-salvage battle check for roam system
          const preSalvageBattleCheck = await getBattleStatus(ctx);
          if (preSalvageBattleCheck && preSalvageBattleCheck.is_participant) {
            ctx.log("combat", `PRE-SALVAGE CHECK (roam): IN BATTLE! Battle ID: ${preSalvageBattleCheck.battle_id} - initiating flee!`);
            battleState.inBattle = true;
            battleState.battleId = preSalvageBattleCheck.battle_id;
            battleState.isFleeing = false;
            await fleeFromBattle(ctx, false, 5000);
            break;
          }

          yield "scavenge";
          const result = settings.enableFullSalvage
            ? await fullSalvageWrecks(ctx, { enableTow: settings.enableTowing, minTowValue: settings.minTowValue, battleState })
            : { itemsLooted: await scavengeWrecks(ctx), isTowing: false };
          totalLooted += result.itemsLooted;
          if (result.itemsLooted > 0) {
            ctx.log("scavenge", `Extracted ${result.itemsLooted} items at ${poi.name} (${roamSystemId})`);
          }

          // If towing a wreck, stop scanning and head to salvage yard
          await bot.refreshStatus();
          if (result.isTowing || bot.towingWreck) {
            ctx.log("scavenge", `Now towing a wreck in roam system (result=${result.isTowing}, bot=${bot.towingWreck}) — heading to salvage yard`);
            cargoFull = true; // Signal to stop scanning
            break;
          }
        }

        // If we found wrecks in this system, stop roaming further
        if (totalLooted > 0 || cargoFull) break;
      }

      if (bot.state !== "running") break;
      if (totalLooted > 0) {
        ctx.log("scavenge", `Roam sweep: ${totalLooted} items looted`);
      }
    }

    // ── Process towed wrecks: navigate to salvage yard if towing ──
    await bot.refreshStatus();
    let wasTowing = bot.towingWreck;
    let reachedSalvageYard = false;
    if (bot.towingWreck) {
      ctx.log("scavenge", "Towing wreck — navigating to salvage yard...");

      // Determine salvage yard destination
      const configuredStation = settings.salvageYardStation || "";
      const configuredSystem = settings.salvageYardSystem || "";
      let targetSystem = configuredSystem;
      let targetStationId: string | null = null;

      if (configuredStation) {
        // User specified a specific salvage yard station
        targetStationId = configuredStation;
        // Try to find the system for this station
        const sysForStation = getSystemForSalvageYard(configuredStation);
        if (sysForStation) {
          targetSystem = sysForStation;
          ctx.log("scavenge", `Salvage station ${configuredStation} is in system ${targetSystem}`);
        } else {
          // If we can't determine the system from the station mapping,
          // try to find it by searching current system and neighbors
          ctx.log("warn", `Cannot determine system for salvage station ${configuredStation} — will search for it`);
          // Check if station exists in current system first
          const { pois: currentPois } = await getSystemInfo(ctx);
          const foundInCurrent = currentPois.find(p => p.id === configuredStation);
          if (foundInCurrent) {
            targetSystem = bot.system;
            ctx.log("scavenge", `Found salvage station ${configuredStation} in current system ${bot.system}`);
          } else {
            // Search neighbor systems
            ctx.log("scavenge", `Searching neighbor systems for ${configuredStation}...`);
            const neighbors = mapStore.getConnections(bot.system);
            for (const conn of neighbors) {
              ctx.log("travel", `Checking ${conn.system_name || conn.system_id} for salvage station...`);
              const arrived = await navigateToSystem(ctx, conn.system_id, safetyOpts);
              if (!arrived) continue;
              const { pois: neighborPois } = await getSystemInfo(ctx);
              const foundInNeighbor = neighborPois.find(p => p.id === configuredStation);
              if (foundInNeighbor) {
                targetSystem = conn.system_id;
                ctx.log("scavenge", `Found salvage station ${configuredStation} in ${conn.system_name || conn.system_id}`);
                break;
              }
            }
            if (!targetSystem) {
              ctx.log("error", `Could not find salvage station ${configuredStation} in current system or neighbors — returning to current system`);
              // Navigate back to original system
              await navigateToSystem(ctx, bot.system, safetyOpts);
            }
          }
        }
        ctx.log("scavenge", `Using configured salvage yard: ${configuredStation}`);
      }

      if (!targetSystem && !targetStationId) {
        // Default: Sol system (sol_central is the actual station in sol)
        targetSystem = "sol";
        targetStationId = "sol_central";
        ctx.log("scavenge", "No salvage yard configured — using default (Sol: sol_central)");
      }

      // Navigate to salvage yard system if not already there
      if (targetSystem && bot.system !== targetSystem) {
        // Announce destination
        const chatChannel = getBotChatChannel();
        chatChannel.send({ sender: bot.username, recipients: [], channel: "escort", content: `Going to ${targetSystem}` });
        await signalEscort(ctx, "travel", targetSystem, "chat");
        await ctx.sleep(1000);

        yield "navigate_to_salvage_yard";
        ctx.log("travel", `Traveling to salvage yard system: ${targetSystem}...`);
        const travelOpts = {
          ...safetyOpts,
          autoCloak: settings.autoCloak,
          onBeforeJump: async (nextSystem: string, jumpNumber: number) => {
            const chatChannel = getBotChatChannel();
            chatChannel.send({ sender: bot.username, recipients: [], channel: "escort", content: `Jumping to ${nextSystem}` });
            ctx.log("escort", `Sent jumping to ${nextSystem}`);
          }
        };
        const arrived = await navigateToSystem(ctx, targetSystem, travelOpts);
        if (!arrived) {
          ctx.log("error", "Failed to reach salvage yard system — docking at nearest station");
        }
      }

      // Find and travel to salvage yard station
      const { pois: yardPois } = await getSystemInfo(ctx);

      // Debug: log all stations and their salvage_yard service status
      const stationsInSystem = yardPois.filter(p => isStationPoi(p));
      ctx.log("debug", `Stations in ${bot.system}: ${stationsInSystem.map(s => `${s.id} (salvage_yard=${s.services?.salvage_yard})`).join(", ") || "none"}`);

      let salvageYardStation: typeof yardPois[0] | null = null;
      
      // Priority 1: If we have a configured station ID, try to find it in this system
      if (targetStationId) {
        salvageYardStation = yardPois.find(p => p.id === targetStationId) || null;
        if (salvageYardStation) {
          ctx.log("scavenge", `Found configured salvage station ${targetStationId} in ${bot.system}`);
        }
      }
      
      // Priority 2: If configured station not found in this system, or no station configured,
      // look for any station with salvage_yard service (or any station if service flag is missing)
      if (!salvageYardStation) {
        salvageYardStation = findSalvageYardStation(yardPois);
        if (salvageYardStation) {
          ctx.log("scavenge", `Found station with salvage yard (or fallback): ${salvageYardStation.id}`);
        }
      }

      // Priority 3: If we're in the target system but couldn't find the configured station,
      // try any available station as fallback
      if (!salvageYardStation && targetStationId && targetSystem && bot.system === targetSystem) {
        ctx.log("warn", `Configured salvage station ${targetStationId} not found in ${bot.system}`);
        ctx.log("warn", `Trying any available station as fallback`);
        salvageYardStation = yardPois.find(p => isStationPoi(p)) || null;
        if (salvageYardStation) {
          ctx.log("scavenge", `Using fallback station ${salvageYardStation.id} in ${bot.system}`);
        }
      }
      
      if (!salvageYardStation) {
        ctx.log("error", `No salvage yard found in ${bot.system} — cannot process towed wreck. Configure a salvage yard station in settings.`);
      }

      if (salvageYardStation) {
        yield "travel_to_salvage_yard";
        ctx.log("travel", `Traveling to salvage yard: ${salvageYardStation.name}...`);
        const travelResp = await bot.exec("travel", { target_poi: salvageYardStation.id });
        if (await checkBattleAfterCommand(ctx, travelResp.notifications, "travel_to_salvage_yard", battleState)) {
          ctx.log("combat", "Battle detected during travel to salvage yard - initiating flee!");
          battleState.isFleeing = false;
        } else if (travelResp.error && !travelResp.error.message.includes("already")) {
          ctx.log("error", `Travel to salvage yard failed: ${travelResp.error.message}`);
        } else {
          bot.poi = salvageYardStation.id;
          stationPoi = { id: salvageYardStation.id, name: salvageYardStation.name };
          reachedSalvageYard = true;
        }
      } else {
        // No salvage yard found — try the configured station anyway if it exists
        if (targetStationId) {
          const configuredStation = yardPois.find(p => p.id === targetStationId);
          if (configuredStation) {
            ctx.log("warn", `No station with salvage_yard=true found, but configured station ${targetStationId} exists — trying it anyway`);
            yield "travel_to_salvage_yard";
            ctx.log("travel", `Traveling to configured station: ${configuredStation.name}...`);
            const travelResp = await bot.exec("travel", { target_poi: configuredStation.id });
            if (await checkBattleAfterCommand(ctx, travelResp.notifications, "travel_to_salvage_yard", battleState)) {
              ctx.log("combat", "Battle detected during travel to salvage yard - initiating flee!");
              battleState.isFleeing = false;
            } else if (travelResp.error && !travelResp.error.message.includes("already")) {
              ctx.log("error", `Travel to salvage yard failed: ${travelResp.error.message}`);
            } else {
              bot.poi = configuredStation.id;
              stationPoi = { id: configuredStation.id, name: configuredStation.name };
              reachedSalvageYard = true;
            }
          } else {
            ctx.log("error", `Configured salvage station ${targetStationId} not found in ${bot.system} — cannot process towed wreck`);
          }
        } else {
          ctx.log("error", `No salvage yard found in ${bot.system} — cannot process towed wreck. Configure a salvage yard station in settings.`);
        }
      }

      // After delivering the wreck, skip further POI scanning and go straight to processing
      wasTowing = true;
    }

    // ── Return to home system if needed ──
    // Skip this if we're towing a wreck to the salvage yard (don't want to override salvage yard destination)
    // Also skip if depositAtSalvageYard is enabled and we're already at a station with cargo to unload
    const hasCargoToUnload = bot.inventory.some(i => {
      const lower = i.itemId.toLowerCase();
      return !lower.includes("fuel") && !lower.includes("energy_cell") && i.quantity > 0;
    });
    const shouldReturnHome = !wasTowing &&
      bot.system !== homeSystem &&
      homeSystem &&
      !(settings.depositAtSalvageYard && hasCargoToUnload && stationPoi);

    if (shouldReturnHome) {
      yield "return_home";
      const returnFueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
      if (returnFueled) {
        const arrived = await navigateToSystem(ctx, homeSystem, safetyOpts);
        if (!arrived) {
          ctx.log("error", "Failed to return home — docking at nearest station");
        }
      }
      const { pois: homePois } = await getSystemInfo(ctx);
      const homeStation = findStation(homePois);
      stationPoi = homeStation ? { id: homeStation.id, name: homeStation.name } : null;
    } else if (settings.depositAtSalvageYard && hasCargoToUnload && !stationPoi) {
      // depositAtSalvageYard enabled but no station targeted — find one in current system
      const { pois: currentPois } = await getSystemInfo(ctx);
      const currentStation = findStation(currentPois);
      if (currentStation) {
        stationPoi = { id: currentStation.id, name: currentStation.name };
        ctx.log("scavenge", `Using local station ${currentStation.name} for cargo deposit (depositAtSalvageYard enabled)`);
      }
    }

    // ── Travel to station ──
    yield "travel_to_station";
    if (stationPoi) {
      const travelStationResp = await bot.exec("travel", { target_poi: stationPoi.id });
      if (await checkBattleAfterCommand(ctx, travelStationResp.notifications, "travel_to_station", battleState)) {
        ctx.log("combat", "Battle detected during travel to station - initiating flee!");
        battleState.isFleeing = false;
      } else if (travelStationResp.error && !travelStationResp.error.message.includes("already")) {
        ctx.log("error", `Travel to station failed: ${travelStationResp.error.message}`);
      }
    }

    // ── Dock ──
    yield "dock";
    const dockResp = await bot.exec("dock");
    if (dockResp.error && !dockResp.error.message.includes("already")) {
      ctx.log("error", `Dock failed: ${dockResp.error.message}`);
      await ctx.sleep(5000);
      continue;
    }
    bot.docked = true;

    // ── Process towed wrecks at salvage yard ──
    let processedTow = false;
    if (bot.towingWreck) {
      if (!reachedSalvageYard) {
        ctx.log("error", "Not at a salvage yard — skipping wreck processing (tow flag kept for next cycle)");
        // Don't release the tow — keep it so we can try again next cycle
      } else {
        yield "process_towed_wrecks";
        const processed = await processTowedWrecks(ctx, { preferScrap: settings.preferScrap });
        if (processed > 0) {
          ctx.log("scavenge", `Processed ${processed} towed wreck(s) at salvage yard`);
          processedTow = true;
          bot.towingWreck = false; // Clear flag after successful processing
        } else if (bot.towingWreck) {
          // Processing failed — check if it's because this station has no salvage yard
          // Try other stations in the current system
          const { pois: currentPois } = await getSystemInfo(ctx);
          const otherStations = currentPois.filter(p => isStationPoi(p) && p.id !== bot.poi);
          if (otherStations.length > 0) {
            ctx.log("scavenge", `Current station failed — trying ${otherStations.length} other station(s) in ${bot.system}`);
            let foundSalvageYard = false;
            for (const otherStation of otherStations) {
              ctx.log("travel", `Trying station: ${otherStation.name}`);
              const travelResp = await bot.exec("travel", { target_poi: otherStation.id });
              if (await checkBattleAfterCommand(ctx, travelResp.notifications, "travel", battleState)) {
                ctx.log("combat", "Battle detected while trying other stations - initiating flee!");
                battleState.isFleeing = false;
                break;
              }
              if (travelResp.error) {
                ctx.log("error", `Travel failed: ${travelResp.error.message}`);
                continue;
              }
              bot.poi = otherStation.id;
              stationPoi = { id: otherStation.id, name: otherStation.name };

              // Dock and try processing
              const dockResp = await bot.exec("dock");
              if (dockResp.error) {
                ctx.log("error", `Dock failed: ${dockResp.error.message}`);
                continue;
              }
              bot.docked = true;

              const retryProcessed = await processTowedWrecks(ctx, { preferScrap: settings.preferScrap });
              if (retryProcessed > 0) {
                ctx.log("scavenge", `Processed ${retryProcessed} towed wreck(s) at ${otherStation.name}`);
                processedTow = true;
                bot.towingWreck = false;
                foundSalvageYard = true;
                break;
              }
              // Undock and try next station
              await bot.exec("undock");
              bot.docked = false;
            }
            if (!foundSalvageYard && bot.towingWreck) {
              ctx.log("error", `No station in ${bot.system} has a salvage yard — try a different system`);
            }
          } else {
            ctx.log("error", `No other stations in ${bot.system} to try`);
          }
        }
      }
    }

    // ── Collect storage + sell/deposit cargo ──
    await collectFromStorage(ctx);
    const creditsBefore = bot.credits;

    yield "unload_cargo";
    await bot.refreshCargo();
    const unloadedItems: string[] = [];
    for (const item of bot.inventory) {
      if (!item.itemId || item.quantity <= 0) continue;

      // Skip fuel cells — keep them
      const lower = item.itemId.toLowerCase();
      if (lower.includes("fuel") || lower.includes("energy_cell")) continue;

      if (settings.depositMode === "sell") {
        const sellResp = await bot.exec("sell", { item_id: item.itemId, quantity: item.quantity });
        if (sellResp.error) {
          await bot.exec("deposit_items", { item_id: item.itemId, quantity: item.quantity });
        }
      } else if (settings.depositMode === "faction") {
        const fResp = await bot.exec("faction_deposit_items", { item_id: item.itemId, quantity: item.quantity });
        if (fResp.error) {
          await bot.exec("deposit_items", { item_id: item.itemId, quantity: item.quantity });
        }
      } else {
        await bot.exec("deposit_items", { item_id: item.itemId, quantity: item.quantity });
      }
      unloadedItems.push(`${item.quantity}x ${item.name}`);
      yield "unloading";
    }

    if (unloadedItems.length > 0) {
      const label = settings.depositMode === "sell" ? "market" : settings.depositMode === "faction" ? "faction" : "storage";
      ctx.log("trade", `Unloaded ${unloadedItems.join(", ")} → ${label}`);
    }

    await bot.refreshStatus();

    const earnings = bot.credits - creditsBefore;
    if (earnings > 0) {
      ctx.log("trade", `Earned ${earnings}cr from salvage`);
      await factionDonateProfit(ctx, earnings);
    }

    // ── Refuel + Repair ──
    yield "refuel";
    await tryRefuel(ctx);
    yield "repair";
    await repairShip(ctx);

    // ── Fit mods ──
    const modProfile = getModProfile("salvager");
    if (modProfile.length > 0) await ensureModsFitted(ctx, modProfile);

    yield "check_skills";
    await bot.checkSkills();

    await bot.refreshStatus();
    const endFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    ctx.log("info", `Cycle done — ${bot.credits} credits, ${endFuel}% fuel, ${bot.cargo}/${bot.cargoMax} cargo`);
  }

  // Unregister chat handler
  chatChannel.offMessage(bot.username, chatHandler);
};
