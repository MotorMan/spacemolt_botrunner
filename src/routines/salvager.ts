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
   autoCloakIfDangerous,
   depositNonFuelCargo,
} from "./common.js";
import {
  fleetStatus,
  fleetCreate,
  fleetInvite,
  fleetLeave,
  fleetDecline,
  getFleetMemberByUsername,
  isFleetLeader,
  type FleetStatusResponse,
} from "./fleet.js";
import { getSystemBlacklist } from "../web/server.js";
import {
  readFlockSettings,
  readFlockState,
  registerFlockMember,
  announceFlockTarget,
  claimFlockWreck,
  reportFlockWrecks,
  getAvailableFlockWrecks,
  setFlockTimeout,
  isFlockTimeoutExpired,
  broadcastFlockHeartbeat,
  type FlockState,
  type FlockGroupConfig,
} from "./flock.js";
import {
  broadcastSalvageClaim,
  isWreckClaimedByOther,
  registerSalvageChatHandler,
  unregisterSalvageChatHandler,
} from "../cooperation/salvageCooperation.js";

// ── Temporary pirate blacklist (in-memory) ────────────────────
const temporaryPirateBlacklist = new Map<string, number>(); // systemId -> expiresAt timestamp

// ── Cloaking module detection and enablement ────────────────────────────────

/**
 * Check if the ship has a cloaking module installed.
 * Cloaking modules have "cloak" in their name, id, or special fields.
 * Returns true if a cloaking module is detected.
 */
async function hasCloakingModule(ctx: RoutineContext): Promise<boolean> {
  const { bot } = ctx;
  const shipResp = await bot.exec("get_ship");
  if (shipResp.error || !shipResp.result) return false;
  const shipData = shipResp.result as Record<string, unknown>;
  const modules = Array.isArray(shipData.modules) ? shipData.modules : [];

  for (const mod of modules) {
    const modObj = typeof mod === "object" && mod !== null ? mod as Record<string, unknown> : null;
    const modId = ((modObj?.id as string) || (modObj?.type_id as string) || "").toLowerCase();
    const modName = ((modObj?.name as string) || "").toLowerCase();
    const modSpecial = ((modObj?.special as string) || "").toLowerCase();

    const checkStr = `${modId} ${modName} ${modSpecial}`;
    if (checkStr.includes("cloak")) {
      return true;
    }
  }
  return false;
}

/**
 * Enable cloaking on the bot if not already cloaked.
 * This is a one-time command - once enabled, it stays on until fuel runs out.
 * Returns true if cloaking was enabled (or already was), false if no cloak module.
 */
async function enableCloakingIfPossible(ctx: RoutineContext): Promise<boolean> {
  const { bot } = ctx;

  // First check if already cloaked (from get_status)
  if (bot.isCloaked) {
    ctx.log("salvage", "Bot is already cloaked - no action needed");
    return true;
  }

  // Check if we have a cloaking module
  const hasCloak = await hasCloakingModule(ctx);
  if (!hasCloak) {
    ctx.log("salvage", "No cloaking module detected - cannot enable cloak");
    return false;
  }

  // Enable cloaking
  ctx.log("salvage", "Enabling cloaking module...");
  const resp = await bot.exec("cloak", { enable: true });
  if (resp.error) {
    ctx.log("error", `Failed to enable cloak: ${resp.error.message}`);
    return false;
  }

  ctx.log("salvage", "Cloaking enabled successfully");
  return true;
}

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

/**
 * Ensure minimum military fuel cells are available.
 * Withdraws from faction storage at current station.
 * Called after salvaging and at startup to ensure spare fuel for cloak-powered return.
 */
async function ensureMinimumFuelCells(ctx: RoutineContext, minCells: number): Promise<void> {
  const { bot } = ctx;
  if (!bot.docked) return;
  if (minCells <= 0) return;

  const countFuelCells = (): number => {
    let n = 0;
    for (const item of bot.inventory) {
      const lower = item.itemId.toLowerCase();
      if (lower.includes("fuel") || lower.includes("energy_cell")) n += item.quantity;
    }
    return n;
  };

  const withdraw = async (itemId: string, qty: number): Promise<boolean> => {
    const resp = await bot.exec("storage", { action: 'withdraw', target: 'faction', item_id: itemId, quantity: qty });
    if (resp.error) return false;
    ctx.log("salvage", `Withdrew ${qty} ${itemId}(s) from faction storage`);
    return true;
  };

  // Withdraw from faction storage (free) until the minimum is reached. Prefer
  // military fuel cells (held in reserve for cloak-powered returns); only fall
  // back to other fuel cells if military cells are exhausted. Counted 1:1
  // against minCells (each fuel cell counts as one unit).
  while (bot.state === "running") {
    await bot.refreshCargo();
    const have = countFuelCells();
    if (have >= minCells) break;

    const stillNeeded = minCells - have;
    if (await withdraw("military_fuel_cell", stillNeeded)) continue;
    if (await withdraw("premium_fuel_cell", stillNeeded)) continue;
    if (await withdraw("fuel_cell", stillNeeded)) continue;
    ctx.log("error", `Could not source enough fuel cells from faction storage (have ${have}/${minCells})`);
    break;
  }
}

type DepositMode = "storage" | "faction" | "sell";

async function getSalvagerSettings(username?: string): Promise<{
   depositMode: DepositMode;
   cargoThreshold: number;
   refuelThreshold: number;
   repairThreshold: number;
    system: string;
    homeSystem: string;
    salvageYardStation: string;
   autoCloak: boolean;
   enableCloak: boolean;
   enableFullSalvage: boolean;
  enableTowing: boolean;
  minTowValue: number;
  preferScrap: boolean;
  maxRoamJumps: number;
  roamBaseSystems: string[];
  depositAtSalvageYard: boolean;
minimumFuelCells: number;
   ignoreBlacklist: boolean;
   ignoreCargoFull: boolean;
   escortName: string;

  // Flock salvaging settings
  flockEnabled: boolean;
  flockName: string;
  flockRole: "leader" | "follower";
  allowIndependentTowing: boolean;
}> {
  const all = readSettings();
  const m = all.salvager || {};
  const flockCfg = await readFlockSettings();
  let botOverrides = username ? (all[username] || {}) : {};

  if (username && flockCfg.assignments[username]) {
    botOverrides = { ...botOverrides, ...flockCfg.assignments[username] };
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

   // Flock salvaging settings - read from flockGroups
   const rawFlockGroups = flockCfg.flockGroups || [];
   const flockGroups: FlockGroupConfig[] = rawFlockGroups.map((g: Record<string, unknown>) => ({
    name: (g.name as string) || "unnamed_flock",
    targetOre: (g.targetOre as string) || (g.target_ore as string) || "",
    targetGas: (g.targetGas as string) || (g.target_gas as string) || "",
    targetIce: (g.targetIce as string) || (g.target_ice as string) || "",
    miningType: (g.miningType as string) === "salvage" ? "salvage" : "auto",
    rallySystem: (g.rallySystem as string) ?? (g.rally_system as string) ?? undefined,
    systemOre: (g.systemOre as string) ?? (g.system_ore as string) ?? undefined,
    systemGas: (g.systemGas as string) ?? (g.system_gas as string) ?? undefined,
    systemIce: (g.systemIce as string) ?? (g.system_ice as string) ?? undefined,
    systemSalvage: (g.systemSalvage as string) ?? (g.system_salvage as string) ?? undefined,
    maxMembers: (g.maxMembers as number) ?? (g.max_members as number) ?? undefined,
    leader: g.leader as string | undefined,
    minerName: g.minerName as string | undefined,
    salvagerName: g.salvagerName as string | undefined,
    escortName: g.escortName as string | undefined,
    follower: g.follower as string | undefined,
    escort: g.escort as string | undefined,
  }));
  
// Find the flock group this bot is assigned to
   let assignedFlockGroup: FlockGroupConfig | undefined;
   for (const group of flockGroups) {
     // Check if this bot is the leader or follower in this group
     if (group.leader === username || group.minerName === username || group.salvagerName === username) {
       assignedFlockGroup = group;
       break;
     }
   }

   // Determine flock settings - use botOverrides (from flockAssignments) OR flock group assignment
   const effectiveFlockEnabled = (botOverrides.flockEnabled as boolean) === true || (assignedFlockGroup !== undefined);
   const effectiveFlockName = (botOverrides.flockName as string) || assignedFlockGroup?.name || "";
   // Read role from botOverrides if set, otherwise default based on flock group assignment
   const effectiveFlockRole = (botOverrides.flockRole as string) || (assignedFlockGroup ? (assignedFlockGroup.salvagerName === username ? "leader" : "follower") : "leader") as "leader" | "follower";

   // Auto-detect escort from flock group if not explicitly set
   // The salvager is the leader, the escort is the follower in the same flock
   // Find a bot assigned to the same flock with flockRole="follower"
   let autoEscortName = "";

   // First try to get escort from flock group config
   if (!autoEscortName && assignedFlockGroup) {
     if (typeof assignedFlockGroup.escortName === "string" && assignedFlockGroup.escortName.length > 0) {
       autoEscortName = assignedFlockGroup.escortName as string;
     } else if (typeof assignedFlockGroup.follower === "string") {
       autoEscortName = assignedFlockGroup.follower as string;
     } else if (typeof assignedFlockGroup.escort === "string") {
       autoEscortName = assignedFlockGroup.escort as string;
     }
   }

   // Then try from flockAssignments
   if (!autoEscortName && username && flockCfg.assignments) {
     const assignments = flockCfg.assignments;
     const myFlockAssignment = assignments[username];
     const myFlockName = myFlockAssignment?.flockName;
     
     if (myFlockName) {
       // Find any other bot in the same flock with role "follower" - that's the escort
       for (const [otherBot, otherAssignment] of Object.entries(assignments)) {
         if (otherBot === username) continue;
         const oa = otherAssignment as Record<string, unknown>;
         if (oa.flockName === myFlockName && oa.flockRole === "follower") {
           autoEscortName = otherBot;
           break;
         }
       }
     }
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
    salvageYardStation: (botOverrides.salvageYardStation as string) || (m.salvageYardStation as string) || "",
     autoCloak: (m.autoCloak as boolean) ?? false,
     enableCloak: (m.enableCloak as boolean) ?? false,
     enableFullSalvage: (m.enableFullSalvage as boolean) !== false,
    enableTowing: (m.enableTowing as boolean) ?? false,
    minTowValue: (m.minTowValue as number) ?? 500,
    preferScrap: (m.preferScrap as boolean) ?? false,
    maxRoamJumps: (m.maxRoamJumps as number) || 0, // 0 = no roaming beyond neighbors
    roamBaseSystems: parseStringArray(botOverrides.roamBaseSystems ?? m.roamBaseSystems),
    depositAtSalvageYard: (m.depositAtSalvageYard as boolean) ?? false,
minimumFuelCells: (m.minimumFuelCells as number) ?? 20,
     ignoreBlacklist: (botOverrides.ignoreBlacklist as boolean) ?? (m.ignoreBlacklist as boolean) ?? false,
     ignoreCargoFull: (m.ignoreCargoFull as boolean) ?? false,

     // Escort coordination - use auto-detected escort as fallback
    escortName: (botOverrides.escortName as string) || autoEscortName || "",

    // Flock salvaging settings - use effective values from flock group
    flockEnabled: effectiveFlockEnabled,
    flockName: effectiveFlockName,
    flockRole: effectiveFlockRole as "leader" | "follower",
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

    await bot.refreshCargo();
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
      const candidates = [...wreck.items].sort((a, b) => {
        const aPri = a.item_id.toLowerCase().includes("fuel") || a.item_id.toLowerCase().includes("energy") ? 0 : 1;
        const bPri = b.item_id.toLowerCase().includes("fuel") || b.item_id.toLowerCase().includes("energy") ? 0 : 1;
        return aPri - bPri;
      });

      let remainingOnWreck = wreck.items.reduce((sum, it) => sum + (it.quantity || 0), 0);

      for (const item of candidates) {
        if (bot.state !== "running") break;
        if (remainingOnWreck <= 1) break;

        let qty = item.quantity;
        const maxSafe = remainingOnWreck - 1;
        if (qty > maxSafe) qty = maxSafe;
        if (qty <= 0) continue;

        const lootResp = await bot.exec("loot_wreck", { wreck_id: wreck.wreck_id, item_id: item.item_id, quantity: qty });
        if (lootResp.error) {
          if (lootResp.error.message.includes("already")) {
            continue;
          }
          ctx.log("warn", `Failed to loot ${item.name} from ${wreck.name}: ${lootResp.error.message}`);
          continue;
        }

        totalLooted += qty;
        lootedItems.push(`${qty}x ${item.name}`);
        ctx.log("scavenge", `Looted ${qty}x ${item.name} from ${wreck.name}`);
        remainingOnWreck -= qty;

        await bot.refreshCargo();
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
              // Don't clear towingWreckId since we're already towing
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
            bot.towingWreckId = wreck.wreck_id;
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

// ── Escort signaling ───────────────────────────────────────────

function sendEscortSignal(
  ctx: RoutineContext,
  action: "jump" | "travel" | "dock" | "undock",
  systemId?: string,
  channel: "faction" | "local" | "file" | "chat" = "faction",
): Promise<void> {
  const { bot } = ctx;
  const message = `[ESCORT] ${action}${systemId ? ` ${systemId}` : ""}`;

  if (channel === "faction") {
    return bot.exec("chat", { channel: "faction", content: message }).then(() => {});
  } else if (channel === "local") {
    ctx.log("escort", `Signal: ${message}`);
    return Promise.resolve();
  } else if (channel === "chat") {
    ctx.sendBotChat?.(message, "escort");
    return Promise.resolve();
  } else {
    return new Promise((resolve) => {
      const { writeFileSync, existsSync, mkdirSync } = require("fs");
      const { join } = require("path");
      const escortDir = join(process.cwd(), "data", "escort_signals");
      if (!existsSync(escortDir)) mkdirSync(escortDir, { recursive: true });
      const signalFile = join(escortDir, `${bot.username}.signal`);
      writeFileSync(signalFile, JSON.stringify({ action, systemId, timestamp: Date.now() }));
      resolve();
    });
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
 * Systems on the blacklist or temporarily blacklisted are excluded (unless ignoreTemporaryBlacklist is true).
 */
function buildRoamList(currentSystem: string, maxRoamJumps: number, roamBaseSystems: string[], blacklist: string[], ignoreTemporaryBlacklist: boolean = false): string[] {
  const bases = roamBaseSystems.length > 0 ? roamBaseSystems : [currentSystem];
  const allSystems = new Set<string>();
  const blacklistLower = blacklist.map(b => b.toLowerCase());

  for (const base of bases) {
    // Always include the base (unless blacklisted or temporarily blacklisted)
    if (!blacklistLower.some(b => b === base.toLowerCase()) && (ignoreTemporaryBlacklist || !isTemporarilyBlacklisted(base))) {
      allSystems.add(base);
      // Add systems within range
      for (const sys of findSystemsInRange(base, maxRoamJumps)) {
        if (!blacklistLower.some(b => b === sys.systemId.toLowerCase()) && (ignoreTemporaryBlacklist || !isTemporarilyBlacklisted(sys.systemId))) {
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

   // Persistent flag for fleet invite handling (chat handler is sync)
   let pendingFleetInvite: { sender: string; escortBot: string } | null = null;

   // Track escort fuel level reported via bot chat (ESCORT_FUEL messages)
   let escortReportedFuelPct: number | null = null;
   let escortFuelQuerySent: number = 0; // timestamp of last fuel query to avoid spamming

await bot.refreshLocation();
   const startSystem = bot.system;
   const settings0 = await getSalvagerSettings(bot.username);
   const homeSystem0 = settings0.homeSystem || startSystem;

   // Register chat handler for escort queries
   const chatChannel = getBotChatChannel();
   const chatHandler = (message: BotChatMessage) => {
     if (message.channel === "escort") {
       if (message.recipients.includes(bot.username) && message.content === "QUERY_LOCATION") {
         chatChannel.send({ sender: bot.username, recipients: [message.sender], channel: "escort", content: `LOCATION: ${bot.system}` });
         ctx.log("escort", `Responded to location query: ${bot.system}`);
       }
       // Track escort fuel reports
       if (message.content.startsWith("ESCORT_FUEL ")) {
         const fuelPct = parseInt(message.content.substring(12).trim(), 10);
         if (!isNaN(fuelPct)) {
           escortReportedFuelPct = fuelPct;
           ctx.log("escort", `Escort ${message.sender} reported fuel: ${fuelPct}%`);
         }
       }
       if (message.content.startsWith("FLEET_INVITE ")) {
         const escortBot = message.content.substring(12).trim();
         // If the message is broadcast (empty recipients), the sender IS the escort
         // If the message is direct, the escortBot field contains the escort's username
         const actualEscortBot = message.recipients.length === 0 ? message.sender : escortBot;
         pendingFleetInvite = { sender: message.sender, escortBot: actualEscortBot };
         ctx.log("escort", `Received fleet invite request from ${message.sender} for escort: ${actualEscortBot}`);
}
    }
   };
   chatChannel.onMessage(bot.username, chatHandler);

   const FLEET_INVITE_TIMEOUT = 60000;
  const FLEET_INVITE_RETRY_DELAY = 10000;
  const WAIT_FOR_INVITE_TIMEOUT = 120000;

  async function waitForEscortAcceptance(escortBot: string, timeoutMs: number): Promise<boolean> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      if (bot.state !== "running") return false;
      const status = await fleetStatus(ctx);
      const escortMember = getFleetMemberByUsername(status, escortBot);
      if (escortMember) {
        ctx.log("escort", `Escort ${escortBot} has joined the fleet`);
        return true;
      }
      await ctx.sleep(1000);
    }
    return false;
  }

  async function waitForFleetInviteFromEscort(timeoutMs: number): Promise<{ sender: string; escortBot: string } | null> {
    const startTime = Date.now();
    ctx.log("escort", `Waiting for escort to send FLEET_INVITE message (timeout: ${timeoutMs}ms)...`);
    while (Date.now() - startTime < timeoutMs) {
      if (bot.state !== "running") return null;
      if (pendingFleetInvite) {
        ctx.log("escort", `Received FLEET_INVITE from ${pendingFleetInvite.sender} for escort: ${pendingFleetInvite.escortBot}`);
        return pendingFleetInvite;
      }
      await ctx.sleep(1000);
    }
    ctx.log("escort", `Timeout waiting for FLEET_INVITE message`);
    return null;
  }

  const ESCORT_FUEL_QUERY_TIMEOUT = 15000;

  async function queryEscortFuel(escortName: string, timeoutMs: number = ESCORT_FUEL_QUERY_TIMEOUT): Promise<number | null> {
    const chatChannel = getBotChatChannel();
    escortReportedFuelPct = null;
    chatChannel.send({ sender: bot.username, recipients: [escortName], channel: "escort", content: "ESCORT_FUEL_QUERY" });
    ctx.log("escort", `Sent fuel query to ${escortName}`);
    escortFuelQuerySent = Date.now();

    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      if (bot.state !== "running") return null;
      if (escortReportedFuelPct !== null) {
        ctx.log("escort", `Received fuel report from ${escortName}: ${escortReportedFuelPct}%`);
        return escortReportedFuelPct;
      }
      await ctx.sleep(500);
    }
    ctx.log("escort", `No fuel response from ${escortName} within timeout`);
    return null;
  }

  async function processEscortFleetInvite(requiredEscortName?: string): Promise<boolean> {
    ctx.log("escort", `processEscortFleetInvite called, pendingFleetInvite=${pendingFleetInvite ? JSON.stringify(pendingFleetInvite) : 'null'}, requiredEscortName=${requiredEscortName || 'not set'}`);
    
    // If no escort is required and we haven't received an invite, wait for one
    if (!requiredEscortName) {
      // Check if we're already in a fleet (no escort needed)
      const existingStatus = await fleetStatus(ctx);
      if (existingStatus?.in_fleet) {
        ctx.log("escort", `Already in a fleet - no escort coordination needed`);
        return true;
      }
      return true; // No escort required
    }
    
    // First check if we're already in a fleet with the escort as a member
    const existingStatus = await fleetStatus(ctx);
    if (existingStatus?.in_fleet && getFleetMemberByUsername(existingStatus, requiredEscortName)) {
      ctx.log("escort", `Already in fleet with required escort ${requiredEscortName} - fleet is ready`);
      return true;
    }
    
    // Determine who to invite
    let escortBot = pendingFleetInvite?.escortBot || requiredEscortName;
    
    // Ensure we're in a fleet before trying to invite - this is the critical fix
    // We need to create the fleet FIRST, then invite the escort
    const currentStatus = await fleetStatus(ctx);
    if (!currentStatus?.in_fleet) {
      ctx.log("escort", `Creating fleet for escort ${escortBot}...`);
      const createResult = await fleetCreate(ctx);
      ctx.log("escort", `fleetCreate result: success=${createResult.success}, fleetId=${createResult.fleetId}, message=${createResult.message}`);
      if (!createResult.success) {
        ctx.log("error", `Failed to create fleet: ${createResult.message}`);
        return false;
      }
      ctx.log("escort", `Created fleet: ${createResult.fleetId}`);
    }
    
    // Check if escort is already in fleet
    const checkStatus = await fleetStatus(ctx);
    const escortMember = getFleetMemberByUsername(checkStatus, escortBot);
    if (escortMember) {
      ctx.log("escort", `Escort ${escortBot} already in fleet`);
      pendingFleetInvite = null;
      return true;
    }
    
    // Invite loop - retries until escort joins or bot is stopped
    while (true) {
      if (bot.state !== "running") {
        ctx.log("escort", `Stop requested — abandoning invite loop for ${escortBot}`);
        return false;
      }

      // Re-check if escort already joined (e.g. accepted invite via fleetAccept)
      const preCheck = await fleetStatus(ctx);
      if (getFleetMemberByUsername(preCheck, escortBot)) {
        ctx.log("escort", `Escort ${escortBot} is already in fleet`);
        pendingFleetInvite = null;
        return true;
      }

      ctx.log("escort", `Inviting ${escortBot} to fleet...`);
      const inviteResult = await fleetInvite(ctx, escortBot!);
      ctx.log("escort", `fleetInvite result: success=${inviteResult.success}, message=${inviteResult.message}`);
      
      if (inviteResult.success) {
        ctx.log("escort", `Waiting up to ${FLEET_INVITE_TIMEOUT / 1000}s for ${escortBot} to accept...`);
        const accepted = await waitForEscortAcceptance(escortBot!, FLEET_INVITE_TIMEOUT);
        if (accepted) {
          pendingFleetInvite = null;
          return true;
        }
        ctx.log("escort", `Escort did not join within timeout - retrying invite...`);
      } else if (inviteResult.message?.includes("already_invited") || inviteResult.message?.includes("target_in_fleet")) {
        ctx.log("escort", `Escort ${escortBot} already invited or in a fleet - checking if they've joined this fleet...`);
        const accepted = await waitForEscortAcceptance(escortBot!, FLEET_INVITE_TIMEOUT);
        if (accepted) {
          pendingFleetInvite = null;
          return true;
        }
        ctx.log("escort", `Escort still not in fleet - will retry invite...`);
      }
      
      ctx.log("escort", `Waiting ${FLEET_INVITE_RETRY_DELAY / 1000}s before retry...`);
      await ctx.sleep(FLEET_INVITE_RETRY_DELAY);
    }
  }

  // ── Escort fuel management ───────────────────────────────────────
  // Before each navigation jump, check if escort has enough fuel.
  // If escort is low, dock at a station here so escort can refuel too.
  async function checkEscortFuelAndRefuel(escortName: string, fuelThresholdPct: number): Promise<boolean> {
    if (!escortName) return true;

    // Only query if we don't have a recent fuel reading (>60s old)
    const fuelStale = escortFuelQuerySent === 0 || (Date.now() - escortFuelQuerySent) > 60000;
    if (fuelStale) {
      await queryEscortFuel(escortName);
    }

    if (escortReportedFuelPct !== null && escortReportedFuelPct < fuelThresholdPct) {
      ctx.log("escort", `Escort fuel low (${escortReportedFuelPct}%) — docking at station for escort refuel...`);

      // Dock at current station so escort can also dock and refuel
      const docked = await ensureDocked(ctx);
      if (docked) {
        // Tell escort to dock and refuel
        const chatChannel = getBotChatChannel();
        chatChannel.send({ sender: bot.username, recipients: [escortName], channel: "escort", content: "ESCORT_DOCK_WAIT" });

        // Refuel ourselves too (ensureFueled finds a station with fuel)
        await ensureFueled(ctx, fuelThresholdPct);

        // Wait a bit for escort to use cargo fuel cells / dock / refuel
        ctx.log("escort", `Waiting 20s for escort to refuel...`);
        await ctx.sleep(20000);

        // Query escort fuel again to confirm they refueled
        escortReportedFuelPct = null;
        const newFuel = await queryEscortFuel(escortName);
        if (newFuel !== null && newFuel < fuelThresholdPct) {
          ctx.log("error", `Escort fuel still low after refuel stop: ${newFuel}% — continuing anyway`);
        } else if (newFuel !== null) {
          ctx.log("escort", `Escort refueled successfully: ${newFuel}%`);
        }

        await ensureUndocked(ctx);
      } else {
        ctx.log("error", "Could not dock for escort fuel stop — continuing anyway");
      }
    }

    return true;
  }

  async function ensureEscortFleetReady(escortName: string): Promise<boolean> {
    ctx.log("escort", `ensureEscortFleetReady: waiting for escort ${escortName} to initiate fleet coordination...`);
    
    // Wait for the escort to send FLEET_INVITE message
    const inviteInfo = await waitForFleetInviteFromEscort(WAIT_FOR_INVITE_TIMEOUT);
    if (!inviteInfo) {
      ctx.log("escort", `Escort did not send FLEET_INVITE within timeout - proceeding with auto-detected escort: ${escortName}`);
    }
    
    return await processEscortFleetInvite(escortName);
  }

  async function createFleetAndInviteEscort(escortName: string): Promise<boolean> {
    // Create fleet if not in one
    let currentStatus = await fleetStatus(ctx);
    if (!currentStatus?.in_fleet) {
      ctx.log("escort", `Creating fleet for escort ${escortName}...`);
      const createResult = await fleetCreate(ctx);
      if (!createResult.success) {
        ctx.log("error", `Failed to create fleet: ${createResult.message}`);
        return false;
      }
      ctx.log("escort", `Created fleet: ${createResult.fleetId}`);
    }
    
    // Wait for escort to accept invite
    return await processEscortFleetInvite(escortName);
  }

  // Register lightweight salvage co-op handler (chat-based wreck claiming for independent salvagers)
  const salvageChatHandler = registerSalvageChatHandler(bot.username, (cat, msg) => ctx.log(cat as any, msg));

// ── Startup: return home and dump non-fuel cargo to storage ──
   // Process escort fleet invite BEFORE startup to ensure fleet is ready
   // If escort is required, wait for them to join; otherwise proceed normally
   if (settings0.escortName) {
     ctx.log("escort", `Escort required: ${settings0.escortName}`);
     ctx.log("escort", `Waiting for escort to send FLEET_INVITE message...`);
     
     // Wait for the escort to send FLEET_INVITE message
     const inviteInfo = await waitForFleetInviteFromEscort(WAIT_FOR_INVITE_TIMEOUT);
     if (inviteInfo) {
       ctx.log("escort", `Received FLEET_INVITE from ${inviteInfo.sender} for escort: ${inviteInfo.escortBot}`);
     }
     
     const fleetReady = await processEscortFleetInvite(settings0.escortName);
     if (!fleetReady) {
       ctx.log("error", `Escort coordination failed - required escort ${settings0.escortName} did not join fleet`);
       ctx.log("system", `Waiting indefinitely at home system until escort joins...`);
       let waitingForEscort = true;
       while (waitingForEscort && bot.state === "running") {
         await ctx.sleep(5000);
         const rejoined = await processEscortFleetInvite(settings0.escortName);
         if (rejoined) {
           waitingForEscort = false;
         }
       }
     }
   }
  
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

// Startup: ensure min military fuel cells before first outing (from any station's faction storage)
  if (settings0.minimumFuelCells > 0 && bot.docked) {
    await ensureMinimumFuelCells(ctx, settings0.minimumFuelCells);
  }

  // ── Startup: Enable cloaking if configured and module available ──
   // Best practice: manually undock before cloaking to have full control over state
   // This avoids race conditions with auto-undock and ensures we can re-dock for resupply
   let wasCloakingAttempted = false;
   if (settings0.enableCloak && bot.docked && !bot.isCloaked) {
     ctx.log("salvage", "Manually undocking before cloaking to control state...");
     const undockResp = await bot.exec("undock");
     await ctx.sleep(500);
     await bot.refreshShip();
   }
   
   if (settings0.enableCloak) {
     const cloaked = await enableCloakingIfPossible(ctx);
     if (cloaked) {
       ctx.log("salvage", "Cloaking enabled - bot is now invulnerable to attacks");
       wasCloakingAttempted = true;
     }
   }

   // ── Startup: Refuel if docked (cloaking indicates docked status) ──
   // If cloaking was just enabled or bot is already cloaked, we're docked - refuel
   const isDocked = bot.docked || bot.isCloaked;
   if (isDocked) {
     ctx.log("salvage", "Bot is docked - checking fuel at startup");
     await tryRefuel(ctx, { skipApprovedCheck: true });
   }

   // ── Startup: Re-dock if we cloaked at home ──
   if (wasCloakingAttempted && homeSystem0 && bot.system === homeSystem0 && !bot.docked) {
     ctx.log("salvage", "Re-docking at home station for resupply after cloaking");
     const dockResp = await bot.exec("dock");
     if (!dockResp.error) {
       bot.docked = true;
       ctx.log("salvage", "Re-docked at home station");
     }
   }

   // ── Flock salvaging integration ──
  let isFlockLeader = false;
  let flockTargetSystemId = "";
  let flockPhase: FlockState["phase"] = "gathering";
  let flockGroup: FlockGroupConfig | undefined;
  let lastFlockHeartbeat = 0;

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
        ctx.log("scavenge", `Still towing wreck ${bot.towingWreckId} — will head to salvage yard this cycle`);
      }

     // ── Cloak status check ──
     // Verify bot is still cloaked (cloak can expire or be lost).
     // If not cloaked and cloaking is enabled with fuel available, re-enable cloak.
     // Skip check if bot has 0 fuel to avoid getting stuck.
     if (settings0.enableCloak && bot.fuel > 0 && !bot.isCloaked) {
       ctx.log("salvage", "Cloak check: not cloaked, attempting to re-enable...");
       const cloaked = await enableCloakingIfPossible(ctx);
       if (cloaked) {
         ctx.log("salvage", "Cloaking re-enabled successfully");
       } else {
         ctx.log("warn", "Cloaking re-enable failed or not possible");
       }
     }

     const settings = await getSalvagerSettings(bot.username);
    const homeSystem = settings.homeSystem || startSystem;
    const cargoThresholdRatio = settings.cargoThreshold / 100;
    const safetyOpts = {
      fuelThresholdPct: settings.refuelThreshold,
      hullThresholdPct: settings.repairThreshold,
      autoCloak: settings.autoCloak,
      skipBlacklist: settings.ignoreBlacklist,
    };

// ── Flock salvaging integration ──
     if (settings.flockEnabled && settings.flockName) {
       const flockCfg = await readFlockSettings();
       const minerGroups = flockCfg.flockGroups || [];
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
    // Not in flock mode
      isFlockLeader = false;
      flockTargetSystemId = "";
      flockPhase = "gathering";
    }

    // ── Leader: broadcast heartbeat AND target updates every 30 seconds ──
    if (isFlockLeader && settings.flockEnabled && settings.flockName && (Date.now() - lastFlockHeartbeat) > 30_000) {
      await broadcastFlockHeartbeat(settings.flockName, bot.username, {
        targetSystemId: flockTargetSystemId,
        phase: flockPhase,
      });
      lastFlockHeartbeat = Date.now();
      ctx.log("flock", `Leader broadcast: target=${flockTargetSystemId}, phase=${flockPhase}`);
    }

    let flockState: FlockState | null = null;

    if (settings.flockEnabled && settings.flockName) {
      flockState = await readFlockState(settings.flockName);
      if (!flockState) {
        ctx.log("flock", "Nothing here to hold on");
      } else if (!isFlockLeader) {
        flockTargetSystemId = flockState.targetSystemId;
        flockPhase = flockState.phase;
        ctx.log("flock", `Follower updating: target=${flockTargetSystemId}, phase=${flockPhase}`);
      }
    }
    // ── Fleet coordination for escort ──
    // The escort bot sends FLEET_INVITE messages - we respond by creating fleet and inviting them
    // If escort is required and not in fleet, wait indefinitely before departure
    if (settings.escortName) {
      let escortReady = await processEscortFleetInvite(settings.escortName);
      if (!escortReady) {
        ctx.log("error", `Escort ${settings.escortName} not in fleet - waiting before departure`);
        while (!escortReady && bot.state === "running") {
          await ctx.sleep(5000);
          escortReady = await processEscortFleetInvite(settings.escortName);
        }
      }
    }

    // ── Status + fuel/hull checks ──
    yield "get_status";
    await bot.refreshLocation();

    yield "fuel_check";
    const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
    if (!fueled) {
      ctx.log("error", "Cannot refuel — waiting 30s...");
      await ctx.sleep(30000);
      continue;
    }

    await bot.refreshShip();
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
      // Check if target system is blacklisted (unless ignoreBlacklist is enabled)
      const effectiveBlacklist = settings.ignoreBlacklist ? [] : getSystemBlacklist();
      const targetIsBlacklisted = effectiveBlacklist.some(b => b.toLowerCase() === targetSystemId.toLowerCase()) || (!settings.ignoreBlacklist && isTemporarilyBlacklisted(targetSystemId));
      if (targetIsBlacklisted) {
        ctx.log("error", `Target system ${targetSystemId} is blacklisted — salvaging locally instead`);
      } else {
        // Announce destination and signal escorts before traveling
        const chatChannel = getBotChatChannel();
        chatChannel.send({ sender: bot.username, recipients: [], channel: "escort", content: `Going to ${targetSystemId}` });
        ctx.log("escort", `Sent going to ${targetSystemId}`);

        ctx.log("escort", `Signaling escorts to travel to ${targetSystemId}...`);
        await sendEscortSignal(ctx, "travel", targetSystemId, "chat");
        await ctx.sleep(2000); // Brief pause to let escorts read the signal

        // Check escort fuel before jumping
        if (settings.escortName) {
          await checkEscortFuelAndRefuel(settings.escortName, safetyOpts.fuelThresholdPct);
        }

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
    await bot.refreshShip();
    let skipScanning = false;
    if (bot.towingWreck) {
      ctx.log("scavenge", "Already towing a wreck from previous session — heading to salvage yard");
      skipScanning = true;
    }

    const visitPois = pois;
    const cur = (bot.poi || "").toLowerCase();
    if (cur) {
      const i = visitPois.findIndex(p => p.id.toLowerCase() === cur || p.name.toLowerCase() === cur);
      if (i > 0) {
        const f = visitPois.splice(i, 1)[0];
        visitPois.unshift(f);
      }
    }

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

         // Skip if already towing (need to deliver wreck first) - but still allow salvage in ignoreCargoFull mode
         if (bot.towingWreck && !settings.ignoreCargoFull) {
           ctx.log("scavenge", "Now towing a wreck — stopping POI scan");
           break;
         }

         // Check fuel before salvaging this POI
         await bot.refreshShip();
         const fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
         if (fuelPct < safetyOpts.fuelThresholdPct) {
           ctx.log("scavenge", `Fuel low (${fuelPct}%) — stopping salvage`);
           break;
         }

         const atCur = bot.poi && (bot.poi.toLowerCase() === poi.id.toLowerCase() || bot.poi.toLowerCase() === poi.name.toLowerCase());
         if (!atCur) {
           yield "travel_to_poi";
           ctx.log("travel", `Traveling to ${poi.name}...`);
           const travelResp = await bot.exec("travel", { target_poi: poi.id });
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
         }

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
            ? await fullSalvageWrecks(ctx, {
                enableTow: settings.enableTowing,
                minTowValue: settings.minTowValue,
                battleState,
                salvageCoop: {
                  isWreckAvailable: (wid) => !isWreckClaimedByOther(wid, bot.username),
                  claimWreck: (wid, action) => broadcastSalvageClaim(wid, poi.id, action, bot.username),
                },
              })
            : { itemsLooted: await scavengeWrecks(ctx), isTowing: false };
        }

totalLooted += result.itemsLooted;

         ctx.log("scavenge", `Salvage returned: itemsLooted=${result.itemsLooted}, isTowing=${result.isTowing}, bot.towingWreck=${bot.towingWreck}`);

         if (result.itemsLooted > 0) {
           ctx.log("scavenge", `Extracted ${result.itemsLooted} items at ${poi.name}`);
         }

         // If towing a wreck, stop scanning and head to salvage yard
         await bot.refreshShip(); // Ensure we have latest towing state
         if (result.isTowing || bot.towingWreck) {
           ctx.log("scavenge", `*** TOW DETECTED *** (result=${result.isTowing}, bot=${bot.towingWreck}) — heading to salvage yard`);
           cargoFull = true; // Signal to stop all further scanning including neighbor expansion
           break;
         }

         // Check if cargo is full after salvaging (skip if ignoreCargoFull is set to allow continued towing)
         if (!settings.ignoreCargoFull) {
           await bot.refreshCargo();
           const fillRatio = bot.cargoMax > 0 ? bot.cargo / bot.cargoMax : 0;
           if (fillRatio >= cargoThresholdRatio) {
             ctx.log("scavenge", `Cargo at ${Math.round(fillRatio * 100)}% — stopping salvage to deposit`);
             cargoFull = true;
             break;
           }
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
      const blacklist = settings.ignoreBlacklist ? [] : getSystemBlacklist();
      const roamList = buildRoamList(bot.system, settings.maxRoamJumps, settings.roamBaseSystems, blacklist, settings.ignoreBlacklist);

      if (roamList.length > 0) {
        ctx.log("scavenge", `No wrecks locally — roaming across ${roamList.length} system(s): ${roamList.join(", ")}`);
      }

      for (const roamSystemId of roamList) {
        if (bot.state !== "running" || cargoFull || bot.towingWreck) break;

        // Skip if we're already in this system
        if (roamSystemId === bot.system) continue;

        // Check fuel before jumping
        await bot.refreshShip();
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
        await sendEscortSignal(ctx, "travel", roamSystemId, "chat");
        await ctx.sleep(1000); // Brief pause

        await ensureUndocked(ctx);
        const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
        if (!fueled) break;

        // Check escort fuel before jumping to roam system
        if (settings.escortName) {
          await checkEscortFuelAndRefuel(settings.escortName, safetyOpts.fuelThresholdPct);
        }

        const travelOpts = {
          ...safetyOpts,
          onBeforeJump: async (nextSystem: string, jumpNumber: number) => {
            const chatChannel = getBotChatChannel();
            chatChannel.send({ sender: bot.username, recipients: [], channel: "escort", content: `Jumping to ${nextSystem}` });
          }
        };
        const arrived = await navigateToSystem(ctx, roamSystemId, travelOpts);
        if (!arrived) continue;

        const { pois: roamPois } = await getSystemInfo(ctx);
        const roamVisit = roamPois;
        const curR = (bot.poi || "").toLowerCase();
        if (curR) {
          const i = roamVisit.findIndex(p => p.id.toLowerCase() === curR || p.name.toLowerCase() === curR);
          if (i > 0) {
            const f = roamVisit.splice(i, 1)[0];
            roamVisit.unshift(f);
          }
        }
        if (roamVisit.length === 0) continue;

for (const poi of roamVisit) {
           if (bot.state !== "running") break;

           // Check fuel before salvaging this roam POI
           await bot.refreshShip();
           const rFuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
           if (rFuelPct < safetyOpts.fuelThresholdPct) break;

           const atCurR = bot.poi && (bot.poi.toLowerCase() === poi.id.toLowerCase() || bot.poi.toLowerCase() === poi.name.toLowerCase());
          if (!atCurR) {
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
          }

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
            ? await fullSalvageWrecks(ctx, {
                enableTow: settings.enableTowing,
                minTowValue: settings.minTowValue,
                battleState,
                salvageCoop: {
                  isWreckAvailable: (wid) => !isWreckClaimedByOther(wid, bot.username),
                  claimWreck: (wid, action) => broadcastSalvageClaim(wid, poi.id, action, bot.username),
                },
              })
            : { itemsLooted: await scavengeWrecks(ctx), isTowing: false };
          totalLooted += result.itemsLooted;
          if (result.itemsLooted > 0) {
            ctx.log("scavenge", `Extracted ${result.itemsLooted} items at ${poi.name} (${roamSystemId})`);
          }

// If towing a wreck, stop scanning and head to salvage yard
           await bot.refreshShip();
           if (result.isTowing || bot.towingWreck) {
             ctx.log("scavenge", `Now towing a wreck in roam system (result=${result.isTowing}, bot=${bot.towingWreck}) — heading to salvage yard`);
             cargoFull = true; // Signal to stop scanning
             break;
           }

           // Check if cargo is full after salvaging in roam (skip if ignoreCargoFull is set)
           if (!settings.ignoreCargoFull) {
             await bot.refreshCargo();
             const fillRatio = bot.cargoMax > 0 ? bot.cargo / bot.cargoMax : 0;
             if (fillRatio >= cargoThresholdRatio) {
               ctx.log("scavenge", `Cargo at ${Math.round(fillRatio * 100)}% — stopping roam to deposit`);
               cargoFull = true;
               break;
             }
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

    // ── Fuel cell depletion check: return to home to restock military cells if critically low (prevents stranding far from base) ──
    await bot.refreshCargo();
    let fuelCellCount = 0;
    for (const item of bot.inventory) {
      if (item.itemId.toLowerCase().includes("fuel_cell")) fuelCellCount += item.quantity;
    }
    const lowOnFuelCells = fuelCellCount < 4;
    if (lowOnFuelCells && !bot.towingWreck) {
      ctx.log("salvage", `Fuel cells critically low (${fuelCellCount} remaining) — returning to home base to restock military fuel cells`);
      if (homeSystem && bot.system !== homeSystem) {
        const retFueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
        if (retFueled) {
          await navigateToSystem(ctx, homeSystem, safetyOpts);
        }
      }
      // if already home or after nav, the upcoming dock/unload will trigger the top-up to 20
    }

    // ── Cargo full check: deposit cargo if full ──
    // When towing, prioritize salvage yard over local station for cargo deposit
    if (cargoFull && !settings.ignoreCargoFull) {
      await bot.refreshShip();
      if (bot.towingWreck && settings.salvageYardStation) {
        // When towing and salvage yard configured, go directly to salvage yard to deposit
        // (will process tow and refuel there)
        ctx.log("salvage", "Cargo full while towing — skipping local deposit, will go to salvage yard");
      } else {
        ctx.log("salvage", "Cargo is full — navigating to station to deposit");
        const { pois: currentPois } = await getSystemInfo(ctx);
        const station = findStation(currentPois);
        if (station) {
          const stationId = station.id;
          const atStation = bot.poi && bot.poi.toLowerCase() === stationId.toLowerCase();
          if (!atStation) {
            const travelResp = await bot.exec("travel", { target_poi: stationId });
            if (travelResp.error && !travelResp.error.message.includes("already")) {
              ctx.log("error", `Failed to travel to station: ${travelResp.error.message}`);
            } else {
              ctx.log("travel", `Traveled to ${station.name} to deposit cargo`);
            }
          }
        }
        await ensureDocked(ctx);
        await depositNonFuelCargo(ctx);
      }
    }

    // ── Process towed wrecks: navigate to salvage yard if towing ──
    await bot.refreshShip();
    let wasTowing = bot.towingWreck;
    let reachedSalvageYard = false;
    if (bot.towingWreck) {
      ctx.log("scavenge", "Towing wreck — navigating to salvage yard...");

      // Ensure we have enough fuel before navigating to salvage yard
      // Critical: salvage yard journey may be multiple jumps, ensure adequate fuel
      const towFuelCheck = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
      if (!towFuelCheck) {
        ctx.log("error", "Cannot secure fuel for salvage yard journey — aborting navigation, will retry next cycle");
        await ctx.sleep(5000);
        continue; // Skip this cycle, let next cycle retry
      }

      // Determine salvage yard destination
      const configuredStation = settings.salvageYardStation || "";
      let targetSystem = "";
      let targetStationId: string | null = null;

      if (configuredStation) {
        // User specified a specific salvage yard station; derive its system from
        // the selected station (no separate system setting required anymore).
        targetStationId = configuredStation;
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
        await sendEscortSignal(ctx, "travel", targetSystem, "chat");
        await ctx.sleep(1000);

        // Check escort fuel before jumping to salvage yard
        if (settings.escortName) {
          await checkEscortFuelAndRefuel(settings.escortName, safetyOpts.fuelThresholdPct);
        }

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

    // Refuel immediately after docking (critical for towed wrecks journey)
    if (reachedSalvageYard) {
      await tryRefuel(ctx, { skipApprovedCheck: true });
    }

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

    // Ensure minimum fuel cells from faction storage (free) — never buy them on
    // the market; the faction storage already holds what we need.
    await ensureMinimumFuelCells(ctx, settings.minimumFuelCells);

    await bot.refreshLocation();

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

    await bot.refreshShip();
    const endFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    ctx.log("info", `Cycle done — ${bot.credits} credits, ${endFuel}% fuel, ${bot.cargo}/${bot.cargoMax} cargo`);
  }

  // Unregister chat handler
  chatChannel.offMessage(bot.username, chatHandler);
}
