import type { Routine, RoutineContext, BotStatus } from "../bot.js";
import {
  findStation,
  getSystemInfo,
  collectFromStorage,
  ensureDocked,
  ensureUndocked,
  tryRefuel,
  ensureFueled,
  navigateToSystem,
  scavengeWrecks,
  detectAndRecoverFromDeath,
  readSettings,
  sleep,
  logStatus,
  checkAndFleeFromBattle,
  checkBattleAfterCommand,
} from "./common.js";
import { getNextMayday, markMaydayHandled, clearMaydayQueue, type MaydayRequest } from "../mayday.js";
import { getNextManualRescue, markManualRescueHandled, type ManualRescueRequest } from "../manualrescue.js";
import {
  isRescueHandled,
  parseRescueAnnouncement,
  recordRescueAnnouncement,
  cleanupExpiredAnnouncements,
} from "../rescuecoordination.js";
import {
  getActiveRescueSession,
  startRescueSession,
  updateRescueSession,
  completeRescueSession,
  failRescueSession,
  isMaydayDuplicate,
  type RescueSession,
} from "./rescueActivity.js";
import { isKnownPlayer } from "../playernames.js";
import {
  shouldRescuePlayer,
  recordRescueRequest,
  recordGhost,
  recordSuccessfulRescue,
  getPlayerRecord,
  markAsOwnBot,
  isOwnBot,
} from "../rescueBlackBook.js";
import {
  addToRescueQueue,
  getNextRescue,
  markRescueCompleted,
  incrementRescueAttempt,
  optimizeRescueRoute,
  setCurrentRoute,
  getCurrentRoute,
  advanceRoute,
  getCurrentRouteSystem,
  getRescuesInSystem,
  getQueueStats,
  cleanupStaleQueue,
  getRescueQueue,
} from "../rescueQueue.js";
import {
  getCooperationSettings,
  isCooperationEnabled,
  sendRescueClaim,
  processPrivateMessage,
  calculateJumpsToTarget,
  shouldProceedOrYield,
  isRescueClaimedByPartner,
  type RescueClaim,
} from "../cooperation/rescueCooperation.js";

// ── Settings ─────────────────────────────────────────────────

function getRescueSettings(): {
  fuelThreshold: number;
  rescueFuelCells: number;
  rescueCredits: number;
  scanIntervalSec: number;
  refuelThreshold: number;
  maydayMaxJumps: number;
  maydayFuelThreshold: number;
  homeSystem?: string;
  homeStation?: string;
  costPerJump: number;
  costPerFuel: number;
  cooperationEnabled: boolean;
  partnerBotName: string;
  cooperationMaxDelaySeconds: number;
  creditTopOffAmount: number;
} {
  const all = readSettings();
  const r = all.rescue || {};
  const ft = all.fuel_transfer || {};
  // Also check global settings for homeSystem
  const general = all.general || {};
  return {
    /** Fuel % below which a bot is considered in need of rescue. */
    fuelThreshold: (r.fuelThreshold as number) || 10,
    /** Number of fuel cells to deliver per rescue. */
    rescueFuelCells: (r.rescueFuelCells as number) || 10,
    /** Credits to send per rescue (if docked at same station). */
    rescueCredits: (r.rescueCredits as number) || 500,
    /** Seconds between fleet scans. */
    scanIntervalSec: (r.scanIntervalSec as number) || 30,
    /** Keep own fuel above this %. */
    refuelThreshold: (r.refuelThreshold as number) || 60,
    /** Maximum jumps away to respond to MAYDAYs (0 = unlimited). */
    maydayMaxJumps: (r.maydayMaxJumps as number) || 12,
    /** Max fuel % for MAYDAY sender to be considered a valid rescue (avoids ambushes). */
    maydayFuelThreshold: (r.maydayFuelThreshold as number) || 15,
    /** Home system from rescue settings, fuel_transfer settings, or global settings */
    homeSystem: (r.homeSystem as string) || (ft.homeSystem as string) || (general.homeSystem as string),
    /** Home station ID (format: "systemId|stationId") */
    homeStation: (r.homeStation as string) || '',
    /** Credits charged per jump for rescue billing */
    costPerJump: (r.costPerJump as number) || 50,
    /** Credits charged per unit of fuel for rescue billing */
    costPerFuel: (r.costPerFuel as number) || 2,
    /** Cooperation enabled for multi-bot coordination */
    cooperationEnabled: (r.cooperationEnabled as boolean) || false,
    /** Partner bot name for DM communication */
    partnerBotName: (r.partnerBotName as string) || '',
    /** Max acceptable delay for cooperation messages */
    cooperationMaxDelaySeconds: (r.cooperationMaxDelaySeconds as number) || 30,
    /** Credits threshold for topping off bots (0 = disabled) */
    creditTopOffAmount: (r.creditTopOffAmount as number) || 10000,
  };
}

// ── Helpers ──────────────────────────────────────────────────

interface RescueTarget {
  username: string;
  system: string;
  poi: string;
  fuelPct: number;
  docked: boolean;
}

/** Calculate rescue bill based on jumps and fuel delivered */
function calculateRescueBill(
  jumpsToTarget: number,
  jumpsToHome: number,
  fuelDelivered: number,
  settings: { costPerJump: number; costPerFuel: number }
): { jumpCost: number; fuelCost: number; total: number } {
  const totalJumps = jumpsToTarget + jumpsToHome;
  const jumpCost = totalJumps * settings.costPerJump;
  const fuelCost = fuelDelivered * settings.costPerFuel;
  return {
    jumpCost,
    fuelCost,
    total: jumpCost + fuelCost,
  };
}

/** Send rescue bill via private message */
async function sendRescueBill(
  ctx: RoutineContext,
  targetUsername: string,
  bill: { jumpCost: number; fuelCost: number; total: number },
  jumpsToTarget: number,
  jumpsToHome: number,
  fuelDelivered: number,
  isMayday: boolean
): Promise<void> {
  const aiChatService = (globalThis as any).aiChatService;
  if (aiChatService && typeof aiChatService.sendPrivateMessage === "function") {
    try {
      const result = await aiChatService.sendPrivateMessage(ctx.bot, targetUsername, {
        situation: isMayday
          ? `You responded to their MAYDAY distress call and successfully refueled them. You are now sending them an invoice for the rescue service. Total bill: ${bill.total} credits (${bill.jumpCost} for ${jumpsToTarget + jumpsToHome} jumps, ${bill.fuelCost} for ${fuelDelivered} fuel units).`
          : `You completed a fuel transfer mission to help them with their low fuel situation. You are now sending them an invoice for the rescue service. Total bill: ${bill.total} credits (${bill.jumpCost} for ${jumpsToTarget + jumpsToHome} jumps, ${bill.fuelCost} for ${fuelDelivered} fuel units).`,
        currentSystem: ctx.bot.system,
        targetSystem: '',
        jumps: jumpsToTarget + jumpsToHome,
        fuelRefueled: fuelDelivered,
        playerFuelPct: undefined,
      });
      if (result.ok) {
        ctx.log("rescue", `📧 Sent rescue invoice to ${targetUsername}: ${bill.total} credits (${bill.jumpCost} jumps + ${bill.fuelCost} fuel)`);
      } else {
        ctx.log("warn", `Rescue invoice to ${targetUsername} failed: ${result.error}`);
      }
    } catch (e) {
      ctx.log("warn", `Failed to send rescue bill: ${e}`);
    }
  } else {
    ctx.log("warn", "AI Chat service not available for rescue bill");
  }
}

/** Normalize system name for comparison (handles underscores vs spaces, case) */
const normalizeSystemName = (name: string) => name.toLowerCase().replace(/_/g, ' ').trim();

/**
 * Check if a rescue target still needs rescue by verifying their current fuel and position.
 * Returns an object with:
 *   - needsRescue: whether the target still needs rescue
 *   - currentFuelPct: current fuel percentage (if available)
 *   - currentSystem: current system (if available)
 *   - currentDocked: whether currently docked (if available)
 *   - reason: why rescue is no longer needed (if applicable)
 */
async function checkTargetStillNeedsRescue(
  ctx: RoutineContext,
  targetUsername: string,
  originalFuelPct: number,
  originalSystem: string,
  originalDocked: boolean,
): Promise<{
  needsRescue: boolean;
  currentFuelPct: number | null;
  currentSystem: string | null;
  currentDocked: boolean | null;
  reason?: string;
}> {
  const { bot } = ctx;

  // Get current fleet status to find the target
  const fleet = ctx.getFleetStatus?.() || [];
  const targetBot = fleet.find(b => b.username === targetUsername);

  if (!targetBot) {
    // Target not in fleet - can't verify status
    // This might mean they logged off or fleet status is unavailable
    ctx.log("rescue", `⚠️ Cannot verify ${targetUsername} status - not in fleet list`);
    return {
      needsRescue: true, // Assume they still need rescue
      currentFuelPct: null,
      currentSystem: null,
      currentDocked: null,
      reason: "Target not in fleet status",
    };
  }

  const currentFuelPct = targetBot.maxFuel > 0 ? Math.round((targetBot.fuel / targetBot.maxFuel) * 100) : 100;
  const currentSystem = targetBot.system;
  const currentDocked = targetBot.docked;

  // Check if target has refueled themselves
  if (currentFuelPct > 25 && originalFuelPct <= 10) {
    // Significant fuel increase indicates they refueled
    ctx.log("rescue", `✓ ${targetUsername} no longer needs rescue - fuel increased from ${originalFuelPct}% to ${currentFuelPct}% (self-refueled)`);
    return {
      needsRescue: false,
      currentFuelPct,
      currentSystem,
      currentDocked,
      reason: `Target self-refueled: ${originalFuelPct}% → ${currentFuelPct}%`,
    };
  }

  // Check if target has moved to a different system
  if (currentSystem && normalizeSystemName(currentSystem) !== normalizeSystemName(originalSystem)) {
    ctx.log("rescue", `✓ ${targetUsername} no longer needs rescue - moved from ${originalSystem} to ${currentSystem}`);
    return {
      needsRescue: false,
      currentFuelPct,
      currentSystem,
      currentDocked,
      reason: `Target moved: ${originalSystem} → ${currentSystem}`,
    };
  }

  // Check if target is now docked (might be refueling at station)
  if (currentDocked && !originalDocked && currentFuelPct > originalFuelPct) {
    ctx.log("rescue", `✓ ${targetUsername} is now docked and refueling - fuel ${currentFuelPct}% (was ${originalFuelPct}%)`);
    // Don't cancel rescue yet - they might still need fuel after refueling
    // Only cancel if fuel is above threshold
    if (currentFuelPct > 25) {
      return {
        needsRescue: false,
        currentFuelPct,
        currentSystem,
        currentDocked,
        reason: `Target docked and refueled: ${currentFuelPct}%`,
      };
    }
  }

  // Target still needs rescue
  return {
    needsRescue: true,
    currentFuelPct,
    currentSystem,
    currentDocked,
  };
}

/** Find bots that need fuel rescue. */
function findStrandedBots(
  fleet: BotStatus[],
  selfName: string,
  fuelThreshold: number,
): RescueTarget[] {
  const targets: RescueTarget[] = [];
  for (const bot of fleet) {
    if (bot.username === selfName) continue;
    if (bot.state !== "running" && bot.state !== "idle") continue;
    const fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    if (fuelPct <= fuelThreshold) {
      targets.push({
        username: bot.username,
        system: bot.system,
        poi: bot.poi,
        fuelPct,
        docked: bot.docked,
      });
    }
  }
  // Sort by most critical first
  targets.sort((a, b) => a.fuelPct - b.fuelPct);
  return targets;
}

/**
 * Check if the ship has the refueling_pump module installed.
 * Returns true if the module is found, false otherwise.
 */
async function hasRefuelingPump(ctx: RoutineContext): Promise<boolean> {
  const { bot } = ctx;

  try {
    const shipResp = await bot.exec("get_ship");
    if (shipResp.error) {
      ctx.log("warn", `Could not get ship info: ${shipResp.error.message}`);
      return false;
    }

    const shipData = shipResp.result as Record<string, unknown> | undefined;
    if (!shipData) return false;

    const modules = Array.isArray(shipData.modules) ? shipData.modules : [];

    for (const mod of modules) {
      const m = mod as Record<string, unknown>;
      const moduleId = (m.type_id as string) || (m.id as string) || "";
      const moduleName = (m.name as string) || "";

      if (moduleId.includes("refueling_pump") || moduleName.toLowerCase().includes("refueling pump")) {
        ctx.log("rescue", "✓ Refueling Pump module detected");
        return true;
      }
    }

    ctx.log("warn", "Refueling Pump module NOT detected on this ship");
    return false;
  } catch (err) {
    ctx.log("warn", `Error checking for Refueling Pump: ${err}`);
    return false;
  }
}

/**
 * Credit top-off function — redistributes credits from faction treasury
 * to ONE bot that is running low, including self.
 * This is designed to be called repeatedly in a background loop,
 * processing one bot per invocation.
 * 
 * @returns true if a bot was topped off, false if no bots needed it
 */
async function topOffOneBot(ctx: RoutineContext, targetAmount: number): Promise<boolean> {
  const { bot } = ctx;

  if (targetAmount <= 0) {
    ctx.log("rescue", "💰 topOffOneBot: targetAmount is 0, returning false");
    return false;
  }

  // Only top off when docked (can't send gifts while undocked)
  if (!bot.docked) {
    ctx.log("rescue", "💰 topOffOneBot: bot not docked, returning false");
    return false;
  }

  const fleet = ctx.getFleetStatus?.() || [];
  ctx.log("rescue", `💰 topOffOneBot: checking ${fleet.length} fleet members for credits below ${targetAmount}cr`);

  // Find first bot (other than self) that needs topping off
  for (const member of fleet) {
    if (member.username === bot.username) continue;
    if (member.state !== "running" && member.state !== "idle") continue;
    if (member.credits >= targetAmount) continue;

    const needed = targetAmount - member.credits;
    ctx.log("rescue", `💰 ${member.username} has ${member.credits}cr, needs ${needed}cr to reach ${targetAmount}cr`);

    // Withdraw from faction treasury
    ctx.log("rescue", `💰 Withdrawing ${needed}cr from faction treasury for ${member.username}...`);
    const withdrawResp = await bot.exec("faction_withdraw_credits", { amount: needed });
    if (withdrawResp.error) {
      ctx.log("rescue", `💰 Cannot withdraw ${needed}cr for ${member.username}: ${withdrawResp.error.message}`);
      return false; // treasury likely empty, stop trying
    }

    ctx.log("rescue", `💰 Successfully withdrew ${needed}cr, sending to ${member.username}...`);
    // Send credits to the bot
    const giftResp = await bot.exec("send_gift", { recipient: member.username, credits: needed });
    if (giftResp.error) {
      ctx.log("rescue", `💰 Gift to ${member.username} failed: ${giftResp.error.message}`);
      // Re-deposit withdrawn credits back
      await bot.exec("faction_deposit_credits", { amount: needed });
      return false;
    } else {
      ctx.log("rescue", `💰 Sent ${needed}cr to ${member.username} (topped off to ${targetAmount}cr)`);
      return true; // Successfully topped off one bot
    }
  }

  // Top off self if needed
  ctx.log("rescue", `💰 No other bots need topping off, checking self...`);
  await bot.refreshStatus();
  if (bot.credits < targetAmount) {
    const needed = targetAmount - bot.credits;
    ctx.log("rescue", `💰 Self has ${bot.credits}cr, needs ${needed}cr to reach ${targetAmount}cr`);

    const withdrawResp = await bot.exec("faction_withdraw_credits", { amount: needed });
    if (withdrawResp.error) {
      ctx.log("rescue", `💰 Cannot withdraw ${needed}cr for self: ${withdrawResp.error.message}`);
      return false;
    }

    ctx.log("rescue", `💰 Withdrew ${needed}cr from faction treasury for self (now at ${bot.credits + needed}cr)`);
    return true;
  }

  ctx.log("rescue", `💰 Self credits OK (${bot.credits}cr >= ${targetAmount}cr), no action needed`);
  return false; // No bots needed topping off
}

/**
 * Background credit top-off loop — runs independently every 60 seconds,
 * only when docked at sol_central. Non-blocking to the main rescue loop.
 */
function startCreditTopOffBackground(ctx: RoutineContext, targetAmount: number): void {
  if (targetAmount <= 0) {
    ctx.log("rescue", "💰 Credit top-off disabled (amount is 0)");
    return;
  }

  ctx.log("rescue", `💰 Credit top-off background loop started (target: ${targetAmount}cr, interval: 60s)`);

  const intervalMs = 60 * 1000; // 1 minute

  const loop = async () => {
    try {
      const { bot } = ctx;

      // Refresh bot status to get current docked state and system
      await bot.refreshStatus();

      ctx.log("rescue", `💰 Background credit check - docked: ${bot.docked}, system: ${bot.system}, credits: ${bot.credits}`);

      // Only run when docked
      if (!bot.docked) {
        ctx.log("rescue", `💰 Skipping credit top-off — not docked (docked: ${bot.docked})`);
        return;
      }

      // Check if we're at sol_central (or home system if configured)
      const settings = getRescueSettings();
      const expectedSystem = settings.homeSystem || "sol_central";

      if (normalizeSystemName(bot.system) !== normalizeSystemName(expectedSystem)) {
        ctx.log("rescue", `💰 Skipping credit top-off — not at ${expectedSystem} (current: ${bot.system})`);
        return;
      }

      ctx.log("rescue", `💰 At ${expectedSystem}, checking fleet credits...`);
      const toppedOff = await topOffOneBot(ctx, targetAmount);

      if (toppedOff) {
        ctx.log("rescue", `💰 Successfully topped off a bot — will check again in ${intervalMs / 1000}s`);
      } else {
        ctx.log("rescue", `💰 No bots need topping off this cycle`);
      }
    } catch (err) {
      ctx.log("rescue", `💰 Credit top-off background loop error: ${err}`);
    }
  };

  // Run immediately on start, then every minute
  loop();
  setInterval(loop, intervalMs);
}

// ── FuelTransfer routine (using refuel command) ─────────────────

/**
 * FuelTransfer routine — uses a dedicated fuel transfer ship to directly
 * refuel stranded ships in the field using the 'refuel' command.
 *
 * 1. Scan fleet status for bots with dangerously low fuel
 * 2. Navigate to stranded bot's system
 * 3. Travel to stranded bot's POI
 * 4. Issue 'refuel target=player_id' command to transfer fuel
 * 5. Return to idle scanning
 */
export const fuelTransferRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  await bot.refreshStatus();
  const settings = getRescueSettings();
  const homeSystem = settings.homeSystem || bot.system;

  ctx.log("system", "FuelTransfer bot online — ready to refuel stranded ships...");

  if (settings.homeSystem) {
    ctx.log("system", `Home base configured: ${homeSystem}`);
  } else {
    ctx.log("warn", "No home base configured — will use starting system as home");
  }

  // Clear MAYDAY queue on startup (ignore old messages from chat history backlog)
  clearMaydayQueue();
  ctx.log("rescue", `🗑️ Cleared MAYDAY queue - ignoring old chat history`);

  // Check for Refueling Pump module at startup
  const hasPump = await hasRefuelingPump(ctx);
  if (!hasPump) {
    ctx.log("error", "Refueling Pump module not installed! This routine requires the refueling_pump module.");
    ctx.log("info", "Switching to fuel cell delivery fallback mode...");
  }

  // Track idle time when away from home (for auto-return feature)
  let idleStartTime = 0; // Timestamp when we started being idle
  const IDLE_RETURN_THRESHOLD_MS = 30000; // Return home after 30 seconds of idle time when away from home
  let isReturningIdle = false; // Track if we're returning home due to idle

  // Log if starting away from home
  const startedAwayFromHome = homeSystem && normalizeSystemName(bot.system) !== normalizeSystemName(homeSystem);
  if (startedAwayFromHome) {
    ctx.log("rescue", `⚠️ Bot started away from home (${bot.system} vs ${homeSystem}) — will return home after ${IDLE_RETURN_THRESHOLD_MS / 1000}s of idle time`);
  } else if (homeSystem) {
    ctx.log("rescue", `✓ Bot started at home base (${homeSystem})`);
  }

  // ── Mark all our bots in the blackbook to prevent them from being blacklisted ──
  // Get fleet status and mark all bots with our username pattern as "own bots"
  const fleet = ctx.getFleetStatus?.() || [];
  const ourBotNames = fleet.map(b => b.username).filter(name => name !== bot.username);
  for (const botName of ourBotNames) {
    markAsOwnBot(botName);
    ctx.log("rescue", `🤝 Marked ${botName} as our bot (will not blacklist)`);
  }
  ctx.log("rescue", `✓ Marked ${ourBotNames.length} bots as our own (excluded from ghost tracking)`);

  // ── Start background credit top-off loop (non-blocking) ──
  startCreditTopOffBackground(ctx, settings.creditTopOffAmount);

  while (bot.state === "running") {
    // ── Death recovery ──
    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) { await sleep(30000); continue; }

    // ── Battle check ──
    if (await checkAndFleeFromBattle(ctx, "rescue")) {
      await sleep(5000);
      continue;
    }

    // ── Clean up expired rescue announcements ──
    cleanupExpiredAnnouncements();

    // ── Monitor faction chat for rescue announcements from other bots ──
    // This helps coordinate with other rescue bots to avoid duplicate responses
    try {
      const chatResp = await bot.exec("get_chat_history", { channel: "faction", limit: 20 });
      if (!chatResp.error && chatResp.result) {
        const r = chatResp.result as Record<string, unknown>;
        const msgs = (
          Array.isArray(chatResp.result) ? chatResp.result :
          Array.isArray(r.messages) ? r.messages :
          Array.isArray(r.history) ? r.history :
          []
        ) as Array<Record<string, unknown>>;

        for (const msg of msgs) {
          const content = (msg.content as string) || (msg.message as string) || "";
          const sender = (msg.sender as string) || (msg.username as string) || "";
          const ts = (msg.timestamp as number) || (msg.created_at as number) || Date.now();

          // Skip messages from self
          if (sender === bot.username) continue;

          const announcement = parseRescueAnnouncement(content, sender, ts * 1000);
          if (announcement) {
            recordRescueAnnouncement(announcement);
            ctx.log("rescue", `📡 Detected rescue announcement from ${sender}: ${announcement.targetName} at ${announcement.targetSystem}`);
          }
        }
      }
    } catch (e) {
      // Ignore errors - faction chat monitoring is optional
    }

    // ── RESCUE COOPERATION: Monitor private messages from partner bot ──
    // This enables coordination between our two rescue bots
    // Note: We can't poll private chat history (requires target_id), so we rely on real-time messages
    const coopSettings = getCooperationSettings();
    if (isCooperationEnabled() && coopSettings.enabled) {
      ctx.log("coop_debug", `Cooperation monitoring enabled (partner: ${coopSettings.partnerBotName})`);
    }

    // ── Check for MANUAL RESCUE requests (HIGHEST PRIORITY) ──
    const manualRescue = getNextManualRescue();
    let manualRescueTarget: RescueTarget | null = null;
    if (manualRescue) {
      ctx.log("rescue", `🎯 MANUAL RESCUE REQUEST: ${manualRescue.targetPlayer} at ${manualRescue.targetSystem}/${manualRescue.targetPOI}`);
      manualRescueTarget = {
        username: manualRescue.targetPlayer,
        system: manualRescue.targetSystem,
        poi: manualRescue.targetPOI,
        fuelPct: 0, // Unknown fuel level for manual rescue
        docked: false,
      };
      markManualRescueHandled(manualRescue);
      ctx.log("rescue", `✓ Manual rescue request accepted - will rescue ${manualRescue.targetPlayer}`);
      // Reset idle timer since we have a mission
      idleStartTime = 0;
      isReturningIdle = false;
    }

    // ── Rescue session recovery ──
    const activeSession = getActiveRescueSession(bot.username);
    let recoveredSession: RescueSession | null = null;
    if (activeSession && !manualRescueTarget) {
      ctx.log("rescue", `Found incomplete rescue session: ${activeSession.targetUsername} at ${activeSession.targetSystem}/${activeSession.targetPoi} (${activeSession.state})`);
      const fleet = ctx.getFleetStatus?.() || [];
      const targetStillStranded = fleet.find(b => b.username === activeSession.targetUsername);

      if (targetStillStranded) {
        const fuelPct = targetStillStranded.maxFuel > 0 ? Math.round((targetStillStranded.fuel / targetStillStranded.maxFuel) * 100) : 100;
        if (fuelPct <= 25) {
          recoveredSession = activeSession;
          ctx.log("rescue", `Resuming rescue mission for ${activeSession.targetUsername} (state: ${activeSession.state})`);
          // Reset idle timer since we have a mission
          idleStartTime = 0;
          isReturningIdle = false;
        } else {
          ctx.log("rescue", `${activeSession.targetUsername} has been refueled (${fuelPct}%) - clearing session`);
          failRescueSession(bot.username, "Target no longer needs rescue");
        }
      } else {
        ctx.log("rescue", `Target ${activeSession.targetUsername} not in fleet - clearing session`);
        failRescueSession(bot.username, "Target not found in fleet");
      }
    }

    const settings = getRescueSettings();

    // ── Determine log category early (needed for skipToReturnHome case) ──
    let logCategory: string = "rescue";

    // ── Handle recovered session or manual rescue ──
    let target: RescueTarget | null = null;
    let isMaydayTarget = false;
    let isManualRescueTarget = false;
    let skipToReturnHome = false;

    if (manualRescueTarget) {
      // Manual rescue has highest priority
      target = manualRescueTarget;
      isManualRescueTarget = true;
      ctx.log("rescue", `🎯 PRIORITY: Manual rescue mission for ${target.username}`);
    } else if (recoveredSession) {
      target = {
        username: recoveredSession.targetUsername,
        system: recoveredSession.targetSystem,
        poi: recoveredSession.targetPoi,
        fuelPct: 0,
        docked: false,
      };
      isMaydayTarget = recoveredSession.isMayday;
      logCategory = isMaydayTarget ? "mayday" : "rescue";

      const fleet = ctx.getFleetStatus?.() || [];
      const targetBot = fleet.find(b => b.username === target!.username);
      if (targetBot) {
        target.fuelPct = targetBot.maxFuel > 0 ? Math.round((targetBot.fuel / targetBot.maxFuel) * 100) : 100;
        target.docked = targetBot.docked;
      }

      ctx.log("rescue", `Continuing rescue for ${target.username} at ${target.system}/${target.poi}`);

      if (recoveredSession.state === "navigating" || recoveredSession.state === "at_system") {
        ctx.log("rescue", `Session state '${recoveredSession.state}' - navigating to ${target.system}...`);
      } else if (recoveredSession.state === "traveling_to_poi" || recoveredSession.state === "at_poi") {
        ctx.log("rescue", `Session state '${recoveredSession.state}' - at system, proceeding to POI...`);
        bot.system = target.system;
      } else if (recoveredSession.state === "delivering_fuel") {
        ctx.log("rescue", `Session state '${recoveredSession.state}' - at POI, proceeding to fuel delivery...`);
        bot.system = target.system;
        bot.poi = target.poi;
      } else if (recoveredSession.state === "returning_home") {
        ctx.log("rescue", `Session state '${recoveredSession.state}' - continuing return to home (${homeSystem})...`);
        bot.system = target.system;
        bot.poi = target.poi;
        skipToReturnHome = true;
      }
    }

    // ── Check fleet status (only if not resuming and no manual rescue) ──
    if (!recoveredSession && !manualRescueTarget) {
      yield "scan_fleet";
      const fleet = ctx.getFleetStatus?.() || [];
      if (fleet.length === 0) {
        ctx.log("info", "No fleet data available — waiting...");
        await sleep(settings.scanIntervalSec * 1000);
        continue;
      }

      const targets = findStrandedBots(fleet, bot.username, settings.fuelThreshold);

      // ── RESCUE QUEUE: Add our own bots to the queue for batch processing ──
      for (const target of targets) {
        if (isOwnBot(target.username)) {
          const result = addToRescueQueue(
            target.username,
            target.system,
            target.poi,
            target.fuelPct,
            target.docked
          );
          if (result.added) {
            ctx.log("rescue", `📋 Added ${target.username} to rescue queue at ${target.system}/${target.poi} (${target.fuelPct}% fuel)`);
          }
        }
      }

      // Clean up stale queue entries
      cleanupStaleQueue();

      // Get queue stats for logging
      const queueStats = getQueueStats();
      if (queueStats.pending > 0) {
        ctx.log("rescue", `📋 Rescue queue: ${queueStats.pending} pending across ${queueStats.systems.length} system(s), ${queueStats.completed} completed`);
        if (queueStats.systems.length > 0) {
          ctx.log("rescue", `📍 Systems in queue: ${queueStats.systems.join(", ")}`);
        }
      }

      // ── Check for MAYDAY requests if no fleet targets ──
      let maydayTarget: RescueTarget | null = null;
      if (targets.length === 0) {
        const mayday = getNextMayday();
        if (mayday) {
          ctx.log("mayday", `🚨 MAYDAY received: ${mayday.sender} at ${mayday.system}/${mayday.poi} (${mayday.fuelPct}% fuel)`);

          // Check if sender is a known player (from playerNames.json)
          const knownPlayer = isKnownPlayer(mayday.sender);

          if (!knownPlayer) {
            // Unknown sender - skip this MAYDAY (possible ambush)
            ctx.log("mayday", `⚠️ Ignoring MAYDAY from ${mayday.sender} - not a known player (possible ambush)`);
            markMaydayHandled(mayday);
            continue;
          }

          ctx.log("mayday", `✓ Sender ${mayday.sender} is a KNOWN player — responding to MAYDAY`);

          // ── MAYDAY FUEL CHECK: Verify sender's fuel is below threshold ──
          // Prevents wasting fuel on players who aren't actually in distress (potential ambushes)
          if (mayday.fuelPct > settings.maydayFuelThreshold) {
            ctx.log("mayday", `⚠️ Ignoring MAYDAY from ${mayday.sender} - fuel too high (${mayday.fuelPct}% > ${settings.maydayFuelThreshold}% threshold)`);
            markMaydayHandled(mayday);
            continue;
          }
          ctx.log("mayday", `✓ Fuel check passed: ${mayday.fuelPct}% <= ${settings.maydayFuelThreshold}% threshold`);

          // ── RESCUE BLACKBOOK: Check if we should rescue this player ──
          const rescueDecision = shouldRescuePlayer(mayday.sender);
          if (!rescueDecision.shouldRescue) {
            ctx.log("mayday", `⚠️ Ignoring MAYDAY from ${mayday.sender} - ${rescueDecision.reason}`);
            markMaydayHandled(mayday);
            continue;
          }
          ctx.log("mayday", `✓ BlackBook check passed: ${rescueDecision.reason}`);

          // ── RESCUE BLACKBOOK: Check if this is a duplicate MAYDAY (chat cache echo) ──
          // Prevents re-triggering the same rescue we just completed
          if (isMaydayDuplicate(bot.username, mayday.sender, mayday.system, mayday.poi)) {
            ctx.log("mayday", `⚠️ Ignoring MAYDAY from ${mayday.sender} - duplicate of recently completed rescue (chat cache echo)`);
            markMaydayHandled(mayday);
            continue;
          }
          ctx.log("mayday_debug", `✓ Not a duplicate MAYDAY`);

          // Record rescue request for blackbook tracking
          recordRescueRequest(mayday.sender);

          // ── RESCUE COORDINATION: Check if another bot is already handling this ──
          const handledBy = isRescueHandled(mayday.sender, mayday.system, mayday.poi, bot.username);
          if (handledBy) {
            ctx.log("rescue", `🤝 MAYDAY already being handled by ${handledBy.rescuerUsername} - skipping to avoid duplicate rescue`);
            markMaydayHandled(mayday);
            continue;
          }

          // ── RESCUE COOPERATION: Check with partner bot if enabled ──
          let partnerClaim = isRescueClaimedByPartner(mayday.sender, mayday.system, mayday.poi, bot.username);
          
          if (isCooperationEnabled() && settings.cooperationEnabled) {
            ctx.log("coop", `🤝 Cooperation enabled (partner: ${settings.partnerBotName})`);
            ctx.log("coop", `🤝 MAYDAY: ${mayday.sender} at ${mayday.system}/${mayday.poi}`);
            
            if (partnerClaim) {
              // Partner has claimed this rescue - will compare distances after calculating jumps
              ctx.log("coop", `🤝 ✓ PARTNER CLAIM FOUND: ${partnerClaim.botName} claimed ${partnerClaim.player} at ${partnerClaim.system} (${partnerClaim.jumps} jumps, ts: ${partnerClaim.timestamp})`);
            } else {
              ctx.log("coop", `🤝 ✗ No partner claim found yet - will proceed and send claim (partner may respond with their claim)`);
            }
          }

          // Check jump range
          let jumpsAway = 0;
          if (mayday.system && mayday.system !== bot.system && settings.maydayMaxJumps > 0) {
            try {
              const routeResp = await bot.exec("find_route", { target_system: mayday.system });
              if (!routeResp.error && routeResp.result) {
                const route = routeResp.result as Record<string, unknown>;
                jumpsAway = (route.total_jumps as number) || 0;

                if (jumpsAway > settings.maydayMaxJumps) {
                  ctx.log("mayday", `⚠️ MAYDAY too far: ${jumpsAway} jumps (max: ${settings.maydayMaxJumps}) - ignoring`);
                  markMaydayHandled(mayday);
                  continue;
                }
              }
            } catch (e) {
              ctx.log("warn", `Could not calculate route to ${mayday.system}: ${e}`);
            }
          }

          maydayTarget = {
            username: mayday.sender,
            system: mayday.system,
            poi: mayday.poi,
            fuelPct: mayday.fuelPct,
            docked: false,
          };
          markMaydayHandled(mayday);
          ctx.log("mayday", `✓ MAYDAY validated (${jumpsAway} jumps) - launching rescue mission for ${mayday.sender}`);
          
          // ── RESCUE COOPERATION: Send claim to partner bot ──
          if (isCooperationEnabled() && settings.cooperationEnabled) {
            const myClaim: RescueClaim = {
              type: "RESCUE_CLAIM",
              player: mayday.sender,
              system: mayday.system,
              poi: mayday.poi,
              timestamp: new Date().toISOString(),
              jumps: jumpsAway,
              botName: bot.username,
            };

            // Send claim to partner bot and wait for it to complete
            ctx.log("coop", `📧 Sending rescue claim to ${settings.partnerBotName}...`);
            const sendResult = await sendRescueClaim(bot, myClaim);
            if (sendResult.ok) {
              ctx.log("coop", `📧 Sent rescue claim to ${settings.partnerBotName}: ${mayday.sender} at ${mayday.system} (${jumpsAway} jumps)`);
            } else {
              ctx.log("coop", `⚠️ Failed to send rescue claim: ${sendResult.error}`);
            }

            // Wait briefly for partner's claim to arrive (accounts for chat delays)
            // Use configured delay, default 3 seconds
            const cooperationDelay = Math.min(settings.cooperationMaxDelaySeconds * 1000, 5000);
            ctx.log("coop", `⏱ Waiting ${cooperationDelay / 1000}s for partner claim...`);
            await sleep(cooperationDelay);

            // Re-check for partner claims after delay
            partnerClaim = isRescueClaimedByPartner(mayday.sender, mayday.system, mayday.poi, bot.username);
            
            // Check if we should yield to partner
            if (partnerClaim) {
              const decision = shouldProceedOrYield(myClaim, partnerClaim);
              if (decision === "yield") {
                ctx.log("coop", `🤝 Yielding rescue to ${partnerClaim.botName} (they are closer: ${partnerClaim.jumps} vs ${jumpsAway} jumps)`);
                maydayTarget = null; // Cancel this rescue
                markMaydayHandled(mayday);
                continue;
              } else if (decision === "proceed") {
                ctx.log("coop", `🤝 Proceeding with rescue (closer than partner: ${jumpsAway} vs ${partnerClaim.jumps} jumps)`);
              }
            } else {
              ctx.log("coop", `🤝 No partner claim received - proceeding with rescue`);
            }
          }
        }
      }

      if (targets.length === 0 && !maydayTarget) {
        yield "idle";

        // Track idle time when away from home
        const isAwayFromHome = homeSystem && normalizeSystemName(bot.system) !== normalizeSystemName(homeSystem);
        if (isAwayFromHome && !isReturningIdle) {
          // Start idle timer on first idle cycle
          if (idleStartTime === 0) {
            idleStartTime = Date.now();
          }
          const elapsedMs = Date.now() - idleStartTime;

          if (elapsedMs >= IDLE_RETURN_THRESHOLD_MS) {
            ctx.log("rescue", `⏱️ Idle for ${Math.round(elapsedMs / 1000)}s — returning home...`);
            isReturningIdle = true;

            // Immediately execute return home
            ctx.log("rescue", `🏠 Returning home after idle timeout...`);
            yield "return_home";
            await ensureUndocked(ctx);
            const safetyOpts = { fuelThresholdPct: settings.refuelThreshold, hullThresholdPct: 30 };
            const arrived = await navigateToSystem(ctx, homeSystem, safetyOpts);
            if (!arrived) {
              ctx.log("error", `Failed to return to home system ${homeSystem}`);
            } else {
              // CRITICAL: Refresh status after navigation to ensure bot.system is updated
              await bot.refreshStatus();
              ctx.log("rescue", `✓ Arrived at home system ${homeSystem} (confirmed: ${bot.system})`);

              // If home station is configured, travel there and dock
              if (settings.homeStation) {
                const [expectedSystem, stationId] = settings.homeStation.split('|');
                ctx.log("rescue_debug", `homeStation config: "${settings.homeStation}", parsed: expectedSystem="${expectedSystem}", stationId="${stationId}"`);
                
                if (expectedSystem === homeSystem && stationId) {
                  ctx.log("rescue", `🚀 Traveling to home station (${stationId})...`);
                  const travelResp = await bot.exec("travel", { target_poi: stationId });
                  if (travelResp.error) {
                    ctx.log("error", `❌ Failed to travel to home station: ${travelResp.error.message}`);
                  } else {
                    ctx.log("rescue", `⚓ Docking at home station...`);
                    const dockResp = await bot.exec("dock");
                    if (dockResp.error) {
                      ctx.log("error", `❌ Failed to dock at home station: ${dockResp.error.message}`);
                    } else {
                      ctx.log("rescue", `✓ Docked at home station`);
                      // Refuel after docking
                      ctx.log("rescue", `⛽ Refueling at home station...`);
                      const refuelResp = await bot.exec("refuel");
                      if (refuelResp.error) {
                        ctx.log("error", `❌ Failed to refuel at home station: ${refuelResp.error.message}`);
                      } else {
                        await bot.refreshStatus();
                        ctx.log("rescue", `✓ Refueled to ${bot.fuel}/${bot.maxFuel} fuel`);
                      }
                    }
                  }
                } else {
                  ctx.log("warn", `⚠️ homeStation config mismatch: expectedSystem "${expectedSystem}" !== homeSystem "${homeSystem}" or stationId is empty`);
                }
              } else {
                ctx.log("warn", `⚠️ No home station configured - bot will remain at POI in ${homeSystem}`);
              }
            }
            isReturningIdle = false;
            idleStartTime = 0;
            continue; // Restart loop after returning home
          } else {
            ctx.log("rescue", `⏱️ Idle for ${Math.round(elapsedMs / 1000)}s (away from home)`);
          }
        } else {
          // Reset idle timer if we're not away from home or already returning
          idleStartTime = 0;
        }

        await sleep(settings.scanIntervalSec * 1000);
        continue;
      }

      // ── Rescue the most critical bot ──
      target = maydayTarget || targets[0];
      isMaydayTarget = !!maydayTarget;
      logCategory = isMaydayTarget ? "mayday" : "rescue";
    }

    if (!target) {
      await sleep(5000);
      continue;
    }

    // ── Create rescue session if starting new mission ──
    if (!recoveredSession && target) {
      const session: RescueSession = {
        sessionId: `${bot.username}_${Date.now()}`,
        botUsername: bot.username,
        targetUsername: target.username,
        targetSystem: target.system,
        targetPoi: target.poi || "unknown",
        isMayday: isMaydayTarget,
        jumpsCompleted: 0,
        totalJumps: 0,
        startedAt: new Date().toISOString(),
        lastUpdatedAt: new Date().toISOString(),
        state: "navigating",
      };
      startRescueSession(session);
      ctx.log("rescue", `Created rescue session for ${target.username}`);
    }

    // ── Log the rescue target ──
    if (isManualRescueTarget) {
      ctx.log("rescue", `🎯 MANUAL RESCUE: ${target.username} at ${target.system}/${target.poi || "unknown"}`);
    } else if (isMaydayTarget) {
      ctx.log("mayday", `RESCUE NEEDED (MAYDAY): ${target.username} at ${target.fuelPct}% fuel in ${target.system} (POI: ${target.poi || "unknown"})`);
    } else {
      ctx.log("rescue", `RESCUE NEEDED: ${target.username} at ${target.fuelPct}% fuel in ${target.system} (POI: ${target.poi || "unknown"})`);
    }

    // ── Check for Refueling Pump before each mission ──
    const hasPumpNow = hasPump || await hasRefuelingPump(ctx);

    // ── Ensure we have enough fuel to share ──
    yield "self_check";
    await bot.refreshStatus();
    logStatus(ctx);

    if (hasPumpNow) {
      // Calculate distance from home to determine fuel strategy
      let jumpsFromHome = 0;
      if (homeSystem && bot.system.toLowerCase() !== homeSystem.toLowerCase()) {
        try {
          const routeResp = await bot.exec("find_route", { target_system: homeSystem });
          if (!routeResp.error && routeResp.result) {
            const route = routeResp.result as Record<string, unknown>;
            jumpsFromHome = (route.total_jumps as number) || 0;
          }
        } catch (e) {
          ctx.log("warn", `Could not calculate route home: ${e}`);
        }
      }

      // Check current fuel level
      const fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
      
      // Only refuel if below threshold - don't waste time refueling when already well-fueled
      if (fuelPct < settings.refuelThreshold) {
        // If we're on a distant mission (>2 jumps from home), we may need to skip refueling
        const isOnDistantMission = jumpsFromHome > 2;
        
        if (isOnDistantMission) {
          ctx.log(logCategory, 
            `On distant mission (${jumpsFromHome} jumps from home) with ${fuelPct}% fuel — proceeding without refuel (below threshold but urgent)`);
        } else {
          // Need extra fuel beyond our own threshold to have enough to transfer
          const minFuelForTransfer = Math.round(bot.maxFuel * (settings.refuelThreshold / 100)) + 100;
          if (bot.fuel < minFuelForTransfer) {
            ctx.log(logCategory, 
              `Fuel at ${fuelPct}% (below threshold ${settings.refuelThreshold}%) — refueling before rescue...`);
            const fueled = await ensureFueled(ctx, settings.refuelThreshold);
            if (!fueled) {
              ctx.log("error", "Cannot refuel self — waiting before retry...");
              await sleep(settings.scanIntervalSec * 1000);
              continue;
            }
          } else {
            ctx.log(logCategory, 
              `Fuel at ${fuelPct}% — adequate for transfer, proceeding to target`);
          }
        }
      } else {
        ctx.log(logCategory, 
          `Fuel at ${fuelPct}% — above threshold (${settings.refuelThreshold}%), no need to refuel`);
      }
    } else {
      // Fallback: need fuel cells instead
      ctx.log(logCategory, "No Refueling Pump — will use fuel cell delivery method");
    }

    // ── Navigate to stranded bot's system ──
    if (!skipToReturnHome) {
      ctx.log("rescue", `🔍 Navigation debug: target.system=${target?.system}, bot.system=${bot.system}, isMayday=${isMaydayTarget}, isManual=${isManualRescueTarget}, skipToReturnHome=${skipToReturnHome}`);
      yield "navigate_to_target";
      await ensureUndocked(ctx);

      if (target.system && normalizeSystemName(target.system) !== normalizeSystemName(bot.system)) {
        ctx.log(logCategory, `Navigating to ${target.system}...`);

        // Track jumps for billing - get route before navigating
        let jumpsToTarget = 0;
        try {
          const routeResp = await bot.exec("find_route", { target_system: target.system });
          if (!routeResp.error && routeResp.result) {
            const route = routeResp.result as Record<string, unknown>;
            jumpsToTarget = (route.total_jumps as number) || 0;
            ctx.log("rescue", `📍 Route to target: ${jumpsToTarget} jump${jumpsToTarget !== 1 ? 's' : ''}`);
          }
        } catch (e) {
          ctx.log("warn", `Could not calculate route to ${target.system}: ${e}`);
        }

        // ── RESCUE COOPERATION: Send en-route notification to stranded player ──
        ctx.log("rescue", `📧 En-route notification check: isMayday=${isMaydayTarget}, isManual=${isManualRescueTarget}`);
        // Let them know we're on our way (only for MAYDAY rescues, not fleet rescues)
        if (isMaydayTarget || isManualRescueTarget) {
          const aiChatService = (globalThis as any).aiChatService;
          if (aiChatService && typeof aiChatService.sendRescueEnRouteNotification === "function") {
            aiChatService.sendRescueEnRouteNotification(bot, target.username, jumpsToTarget).then((result: { ok: boolean; message?: string; error?: string }) => {
              if (!result.ok) {
                ctx.log("warn", `Failed to send en-route notification: ${result.error}`);
              }
            }).catch((err: Error) => {
              ctx.log("warn", `Error sending en-route notification: ${err.message}`);
            });
          }
        }

        const safetyOpts = {
          fuelThresholdPct: settings.refuelThreshold,
          hullThresholdPct: 30,
          onJump: async (jumpNumber: number) => {
            // Check if target still needs rescue on every jump
            const statusCheck = await checkTargetStillNeedsRescue(
              ctx,
              target!.username,
              target!.fuelPct,
              target!.system,
              target!.docked,
            );

            if (!statusCheck.needsRescue) {
              ctx.log("rescue", `🛑 ABORTING rescue - ${statusCheck.reason}`);
              return false; // Abort navigation
            }

            // Log progress every 5 jumps
            if (jumpNumber % 5 === 0 && statusCheck.currentFuelPct !== null) {
              ctx.log("rescue", `📍 Jump ${jumpNumber}: ${target!.username} fuel at ${statusCheck.currentFuelPct}% in ${statusCheck.currentSystem}`);
            }

            return true; // Continue navigation
          },
        };
        const arrived = await navigateToSystem(ctx, target.system, safetyOpts);
        if (!arrived) {
          ctx.log("error", `Could not reach ${target.system} — will retry next scan`);
          if (recoveredSession || getActiveRescueSession(bot.username)) {
            failRescueSession(bot.username, "Could not reach target system");
          }
          await sleep(settings.scanIntervalSec * 1000);
          continue;
        }
        // CRITICAL: Refresh status to update bot.system after navigation
        await bot.refreshStatus();
        ctx.log("travel", `Arrived in ${bot.system}`);
        // Update session state and jumps after successful navigation
        if (recoveredSession || getActiveRescueSession(bot.username)) {
          updateRescueSession(bot.username, { state: "at_system", jumpsCompleted: jumpsToTarget });
        }
      }

      if (bot.state !== "running") break;

      // ── Travel to stranded bot's POI ──
      if (target.poi) {
        yield "travel_to_target";
        
        // Resolve POI name to POI ID by querying system info
        let targetPoiId: string | null = null;
        let targetPoiName: string = target.poi;
        
        try {
          const { pois } = await getSystemInfo(ctx);
          // Find POI by name (case-insensitive match)
          const matchedPoi = pois.find(p => p.name.toLowerCase() === target.poi.toLowerCase());
          if (matchedPoi) {
            targetPoiId = matchedPoi.id;
            targetPoiName = matchedPoi.name;
            ctx.log(logCategory, `Resolved POI "${target.poi}" -> ID: ${targetPoiId}`);
          } else {
            // Try partial match as fallback
            const partialMatch = pois.find(p => p.name.toLowerCase().includes(target.poi.toLowerCase()) || target.poi.toLowerCase().includes(p.name.toLowerCase()));
            if (partialMatch) {
              targetPoiId = partialMatch.id;
              targetPoiName = partialMatch.name;
              ctx.log(logCategory, `Partial POI match: "${target.poi}" -> ID: ${targetPoiId}`);
            }
          }
        } catch (e) {
          ctx.log("warn", `Could not query system POIs: ${e}`);
        }
        
        // Use POI ID if resolved, otherwise fall back to name
        const travelTarget = targetPoiId || target.poi;
        
        ctx.log(logCategory, `Traveling to ${target.username}'s location (${targetPoiName})...`);
        const travelResp = await bot.exec("travel", { target_poi: travelTarget });
        if (travelResp.error && !travelResp.error.message.includes("already")) {
          ctx.log("error", `Travel failed: ${travelResp.error.message}`);
        } else {
          // Success - update bot.poi with the resolved name
          bot.poi = targetPoiName;
        }
        // Update session state after traveling to POI
        if (recoveredSession || getActiveRescueSession(bot.username)) {
          updateRescueSession(bot.username, { state: "at_poi" });
        }
      }

      // ── Transfer fuel ──
      yield "transfer_fuel";

      // Update session state before fuel delivery
      if (recoveredSession || getActiveRescueSession(bot.username)) {
        updateRescueSession(bot.username, { state: "delivering_fuel" });
      }

      if (hasPumpNow) {
        // Use refuel command with Refueling Pump
        ctx.log(logCategory, `Initiating fuel transfer to ${target.username} using Refueling Pump...`);

        // Need to get the target's player ID for the refuel command
        const targetPlayerId = await findPlayerId(ctx, target.username);

        if (!targetPlayerId) {
          ctx.log("error", `Could not find player ID for ${target.username} — aborting transfer`);
          if (isMaydayTarget) {
            // Re-add to queue so another bot can try
            // (For now, just log - the MAYDAY is already marked as handled)
          }
          await sleep(settings.scanIntervalSec * 1000);
          continue;
        }

        // Issue the refuel command
        const refuelResp = await bot.exec("refuel", { target: targetPlayerId });

        if (refuelResp.error) {
          ctx.log("error", `Refuel command failed: ${refuelResp.error.message}`);
        } else {
          // Parse and log the result
          const result = refuelResp.result as Record<string, unknown> | undefined;
          if (result) {
            const fuelDelta = result.fuel as number || 0;
            const fuelNow = result.fuel_now as number || bot.fuel;
            const targetFuelNow = result.target_fuel_now as number || 0;
            const targetName = result.target_player_name as string || target.username;

            ctx.log(logCategory, `✓ Transferred ${Math.abs(fuelDelta)} fuel to ${targetName}`);
            ctx.log(logCategory, `  Our fuel: ${fuelNow}, Their fuel: ${targetFuelNow}`);
          } else {
            ctx.log(logCategory, `✓ Fuel transfer complete for ${target.username}`);
          }
        }
      } else {
        // Fallback: Use fuel cell delivery method (jettison for them to collect)
        ctx.log(logCategory, `Delivering fuel cells to ${target.username} (no Refueling Pump)...`);

        // Dock first to get fuel cells from storage
        await ensureDocked(ctx);
        await collectFromStorage(ctx);

        // Check if we have fuel cells in cargo
        await bot.refreshCargo();
        const fuelItem = bot.inventory.find(i =>
          i.itemId.includes("fuel_cell") || i.itemId.includes("fuel") || i.itemId.includes("energy_cell")
        );

        if (fuelItem && fuelItem.quantity > 0) {
          // Undock and jettison at target location
          await ensureUndocked(ctx);

          ctx.log(logCategory, `Jettisoning ${fuelItem.quantity}x ${fuelItem.name} for ${target.username} to collect...`);
          const jetResp = await bot.exec("jettison", {
            item_id: fuelItem.itemId,
            quantity: fuelItem.quantity,
          });

          if (jetResp.error) {
            ctx.log("error", `Jettison failed: ${jetResp.error.message}`);
          } else {
            ctx.log(logCategory, `✓ Fuel cells jettisoned at ${bot.poi} — ${target.username} should scavenge them`);
          }
        } else {
          // No fuel cells in cargo — try to buy them
          ctx.log(logCategory, "No fuel cells in cargo — attempting to purchase...");

          // Need to dock to buy
          const { pois } = await getSystemInfo(ctx);
          const station = findStation(pois);

          if (station) {
            ctx.log(logCategory, `Traveling to ${station.name} to purchase fuel cells...`);
            await bot.exec("travel", { target_poi: station.id });
            await bot.exec("dock");
            bot.docked = true;
            await collectFromStorage(ctx);

            // Try buying fuel cells
            const marketResp = await bot.exec("view_market");
            let boughtCells = false;

            if (marketResp.result && typeof marketResp.result === "object") {
              const mData = marketResp.result as Record<string, unknown>;
              const items = (
                Array.isArray(mData) ? mData :
                Array.isArray(mData.items) ? mData.items :
                Array.isArray(mData.market) ? mData.market :
                []
              ) as Array<Record<string, unknown>>;

              const fuelItem = items.find(i => {
                const id = ((i.item_id as string) || (i.id as string) || "").toLowerCase();
                return id.includes("fuel_cell") || id.includes("fuel") || id.includes("energy_cell");
              });

              if (fuelItem) {
                const fuelId = (fuelItem.item_id as string) || (fuelItem.id as string) || "";
                const price = (fuelItem.price as number) || (fuelItem.buy_price as number) || 0;
                const available = (fuelItem.quantity as number) || (fuelItem.stock as number) || 0;
                const qty = Math.min(settings.rescueFuelCells, available);

                if (qty > 0 && (price * qty) <= bot.credits) {
                  ctx.log(logCategory, `Buying ${qty}x fuel cells (${price}cr each)...`);
                  const buyResp = await bot.exec("buy", { item_id: fuelId, quantity: qty });
                  if (!buyResp.error) {
                    boughtCells = true;
                    ctx.log(logCategory, `Acquired ${qty}x fuel cells`);
                  }
                }
              }
            }

            if (boughtCells) {
              // Return to target and jettison
              await ensureUndocked(ctx);
              if (target.poi) {
                // Resolve POI name to ID
                let targetPoiId: string | null = null;
                try {
                  const { pois } = await getSystemInfo(ctx);
                  const matchedPoi = pois.find(p => p.name.toLowerCase() === target.poi.toLowerCase());
                  if (matchedPoi) {
                    targetPoiId = matchedPoi.id;
                    ctx.log(logCategory, `Resolved POI "${target.poi}" -> ID: ${targetPoiId}`);
                  }
                } catch (e) {
                  ctx.log("warn", `Could not query system POIs: ${e}`);
                }
                const travelTarget = targetPoiId || target.poi;
                await bot.exec("travel", { target_poi: travelTarget });
                bot.poi = targetPoiId ? target.poi : target.poi;
              }

              await bot.refreshCargo();
              const purchasedItem = bot.inventory.find(i =>
                i.itemId.includes("fuel_cell") || i.itemId.includes("fuel") || i.itemId.includes("energy_cell")
              );

              if (purchasedItem) {
                const jetResp = await bot.exec("jettison", {
                  item_id: purchasedItem.itemId,
                  quantity: purchasedItem.quantity,
                });

                if (jetResp.error) {
                  ctx.log("error", `Jettison failed: ${jetResp.error.message}`);
                } else {
                  ctx.log(logCategory, `✓ Fuel cells jettisoned at ${bot.poi} — ${target.username} should scavenge them`);
                }
              }
            } else {
              ctx.log("error", "Could not acquire fuel cells — mission failed");
            }
          } else {
            ctx.log("error", "No station found to acquire fuel cells");
          }
        }
      }
    }

    // Note: Rescue complete message and bill are sent immediately after fuel delivery
    // (see the "Send rescue complete message and bill IMMEDIATELY" section below)

    // ── Skip to return home if recovering from returning_home state ──
    if (skipToReturnHome) {
      ctx.log("rescue", "Recovered session was returning home - skipping to return home logic...");
      skipToReturnHome = false;
    }

    // ── Return to home system ──
    if (homeSystem && bot.system.toLowerCase() !== homeSystem.toLowerCase()) {
      yield "return_home";
      ctx.log(logCategory, `Returning to home system ${homeSystem}...`);
      await ensureUndocked(ctx);
      const safetyOpts = { fuelThresholdPct: settings.refuelThreshold, hullThresholdPct: 30 };
      const arrived = await navigateToSystem(ctx, homeSystem, safetyOpts);
      if (!arrived) {
        ctx.log("error", `Failed to return to home system ${homeSystem}`);
      } else {
        // CRITICAL: Refresh status after navigation to ensure bot.system is updated
        await bot.refreshStatus();
        ctx.log(logCategory, `✓ Arrived at home system ${homeSystem} (confirmed: ${bot.system})`);

        // If home station is configured, travel there and dock
        ctx.log("rescue_debug", `homeStation config: "${settings.homeStation}", homeSystem: "${homeSystem}"`);
        if (settings.homeStation) {
          const [expectedSystem, stationId] = settings.homeStation.split('|');
          ctx.log("rescue_debug", `Parsed homeStation: expectedSystem="${expectedSystem}", stationId="${stationId}"`);
          ctx.log("rescue_debug", `Comparison: expectedSystem===homeSystem? ${expectedSystem === homeSystem}, stationId truthy? ${!!stationId}`);
          if (expectedSystem === homeSystem && stationId) {
            ctx.log(logCategory, `🚀 Traveling to home station (${stationId})...`);
            const travelResp = await bot.exec("travel", { target_poi: stationId });
            if (travelResp.error) {
              ctx.log("error", `❌ Failed to travel to home station: ${travelResp.error.message}`);
            } else {
              ctx.log(logCategory, `⚓ Docking at home station...`);
              const dockResp = await bot.exec("dock");
              if (dockResp.error) {
                ctx.log("error", `❌ Failed to dock at home station: ${dockResp.error.message}`);
              } else {
                ctx.log(logCategory, `✓ Docked at home station`);
                // Refuel after docking
                ctx.log(logCategory, `⛽ Refueling at home station...`);
                const refuelResp = await bot.exec("refuel");
                if (refuelResp.error) {
                  ctx.log("error", `❌ Failed to refuel at home station: ${refuelResp.error.message}`);
                } else {
                  await bot.refreshStatus();
                  ctx.log(logCategory, `✓ Refueled to ${bot.fuel}/${bot.maxFuel} fuel`);
                }
              }
            }
          } else {
            ctx.log("warn", `⚠️ homeStation config mismatch: expectedSystem "${expectedSystem}" !== homeSystem "${homeSystem}" or stationId is empty`);
          }
        } else {
          ctx.log("warn", `⚠️ homeStation not configured - will use ensureFueled to refuel at ${homeSystem}`);
        }
      }
      // Update session state for return home
      if (recoveredSession || getActiveRescueSession(bot.username)) {
        updateRescueSession(bot.username, { state: "returning_home" });
      }
    } else if (!homeSystem) {
      ctx.log("warn", "No home system set — skipping return home");
    } else {
      ctx.log(logCategory, `Already at home system ${homeSystem}`);

      // Already at home system - still travel to home station and dock if configured
      ctx.log("rescue_debug", `Already at home: homeStation config="${settings.homeStation}", homeSystem="${homeSystem}"`);
      if (settings.homeStation) {
        const [expectedSystem, stationId] = settings.homeStation.split('|');
        ctx.log("rescue_debug", `Parsed: expectedSystem="${expectedSystem}", stationId="${stationId}"`);
        if (expectedSystem === homeSystem && stationId) {
          ctx.log(logCategory, `🚀 Traveling to home station (${stationId})...`);
          const travelResp = await bot.exec("travel", { target_poi: stationId });
          if (!travelResp.error) {
            ctx.log(logCategory, `⚓ Docking at home station...`);
            const dockResp = await bot.exec("dock");
            if (!dockResp.error) {
              ctx.log(logCategory, `✓ Docked at home station`);
              // Refuel after docking
              ctx.log(logCategory, `⛽ Refueling at home station...`);
              const refuelResp = await bot.exec("refuel");
              if (!refuelResp.error) {
                await bot.refreshStatus();
                ctx.log(logCategory, `✓ Refueled to ${bot.fuel}/${bot.maxFuel} fuel`);
              } else {
                ctx.log("error", `Refuel failed: ${refuelResp.error.message}`);
              }
            } else {
              ctx.log("error", `Dock failed: ${dockResp.error.message}`);
            }
          } else {
            ctx.log("error", `Travel to station failed: ${travelResp.error.message}`);
          }
        } else {
          ctx.log("warn", `homeStation config mismatch: expectedSystem "${expectedSystem}" !== homeSystem "${homeSystem}" or stationId is empty`);
        }
      } else {
        ctx.log("rescue", `⚠️ homeStation not configured - will use ensureFueled to refuel at ${homeSystem}`);
      }
    }

    // ── Refuel self (fallback if not already refueled at station) ──
    ctx.log("rescue_debug", `=== Starting refuel self section ===`);
    yield "self_refuel";
    await bot.refreshStatus();
    const fuelAfterRescue = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    ctx.log("rescue_debug", `Fuel after rescue: ${fuelAfterRescue}%, threshold: ${settings.refuelThreshold}%`);
    if (fuelAfterRescue < settings.refuelThreshold) {
      ctx.log(logCategory,
        `Fuel at ${fuelAfterRescue}% after rescue — refueling to threshold (${settings.refuelThreshold}%)...`);
      await ensureFueled(ctx, settings.refuelThreshold);
    } else {
      ctx.log(logCategory,
        `Fuel at ${fuelAfterRescue}% — above threshold (${settings.refuelThreshold}%), no need to refuel`);
    }
    await bot.refreshStatus();
    logStatus(ctx);

    // ── Calculate and send rescue bill (after refuel, before returning home) ──
    const activeSessionForBill = getActiveRescueSession(bot.username);
    if (activeSessionForBill) {
      const jumpsToTarget = activeSessionForBill.jumpsCompleted || 0;
      const fuelDelivered = activeSessionForBill.fuelDelivered || 0;
      
      // Estimate round trip: jumps to target × 2 (there and back)
      const estimatedTotalJumps = jumpsToTarget * 2;
      const bill = calculateRescueBill(
        jumpsToTarget, // One-way jumps for display
        jumpsToTarget, // Return jumps (estimate)
        fuelDelivered,
        settings
      );
      
      // Log the bill clearly
      ctx.log("rescue", `💰 RESCUE BILL for ${activeSessionForBill.targetUsername}:`);
      ctx.log("rescue", `   • Jumps: ${jumpsToTarget} there + ${jumpsToTarget} back = ${estimatedTotalJumps} × ${settings.costPerJump}cr = ${bill.jumpCost}cr`);
      ctx.log("rescue", `   • Fuel: ${fuelDelivered} units × ${settings.costPerFuel}cr = ${bill.fuelCost}cr`);
      ctx.log("rescue", `   • TOTAL: ${bill.total} credits`);
      
      if (bill.total > 0) {
        // Send bill via private message FIRST
        await sendRescueBill(
          ctx,
          activeSessionForBill.targetUsername,
          bill,
          jumpsToTarget,
          jumpsToTarget, // Estimate for return
          fuelDelivered,
          activeSessionForBill.isMayday
        );
        
        // Update session with billing info
        updateRescueSession(bot.username, {
          jumpsCompleted: jumpsToTarget,
          totalJumps: estimatedTotalJumps,
          fuelDelivered,
          creditsSent: bill.total,
          notes: `Billed ${bill.total}cr (${bill.jumpCost}cr jumps + ${bill.fuelCost}cr fuel)`,
        });

        // Record successful rescue in BlackBook
        recordSuccessfulRescue(activeSessionForBill.targetUsername, bill.total);

        // ── Send faction announcement in background (non-blocking) ──
        // This allows immediate return home instead of waiting for cooldown
        const aiChatService = (globalThis as any).aiChatService;
        const aiChatSettings = aiChatService?.getSettings?.();
        const cooldownSec = aiChatSettings?.conversationCooldownSec || 10;
        ctx.log("rescue", `📢 Faction announcement scheduled for ${cooldownSec}s from now (non-blocking)...`);
        
        // Schedule faction announcement to run after cooldown, but don't block
        setTimeout(async () => {
          if (aiChatService && typeof aiChatService.sendFactionMessage === "function") {
            try {
              const result = await aiChatService.sendFactionMessage(bot, {
                messageType: "rescue_complete",
                targetName: activeSessionForBill.targetUsername,
                isMayday: activeSessionForBill.isMayday,
                isBot: !activeSessionForBill.isMayday,
                currentSystem: bot.system,
                targetSystem: activeSessionForBill.targetSystem,
                targetPoi: activeSessionForBill.targetPoi || undefined,
              });
              if (!result.ok) {
                ctx.log("ai_chat_debug", `Faction announcement (complete) skipped: ${result.error}`);
              }
            } catch (e) {
              ctx.log("warn", `AI faction message (complete) failed: ${e}`);
            }
          }
        }, cooldownSec * 1000);
      } else {
        // No bill to send, but still send faction announcement in background
        const aiChatService = (globalThis as any).aiChatService;
        const aiChatSettings = aiChatService?.getSettings?.();
        const cooldownSec = aiChatSettings?.conversationCooldownSec || 10;
        ctx.log("rescue", `📢 Faction announcement scheduled for ${cooldownSec}s from now (non-blocking)...`);
        
        setTimeout(async () => {
          if (aiChatService && typeof aiChatService.sendFactionMessage === "function") {
            try {
              const result = await aiChatService.sendFactionMessage(bot, {
                messageType: "rescue_complete",
                targetName: activeSessionForBill.targetUsername,
                isMayday: activeSessionForBill.isMayday,
                isBot: !activeSessionForBill.isMayday,
                currentSystem: bot.system,
                targetSystem: activeSessionForBill.targetSystem,
                targetPoi: activeSessionForBill.targetPoi || undefined,
              });
              if (!result.ok) {
                ctx.log("ai_chat_debug", `Faction announcement (complete) skipped: ${result.error}`);
              }
            } catch (e) {
              ctx.log("warn", `AI faction message (complete) failed: ${e}`);
            }
          }
        }, cooldownSec * 1000);
      }
    }

    // ── Complete the rescue session ──
    if (recoveredSession || getActiveRescueSession(bot.username)) {
      completeRescueSession(bot.username);
      
      // Also mark the queue entry as completed if this was our own bot
      if (isOwnBot(target.username)) {
        const queue = getRescueQueue();
        const queuedRescue = queue.pending.find(r => r.targetUsername === target.username);
        if (queuedRescue) {
          markRescueCompleted(queuedRescue.id);
          ctx.log("rescue", `📋 Marked ${target.username} as completed in rescue queue`);
        }
      }
    }

    if (isManualRescueTarget) {
      ctx.log("rescue", `=== Manual rescue mission for ${target.username} complete ===`);
    } else if (isMaydayTarget) {
      ctx.log("mayday", `=== MAYDAY response complete for ${target.username} ===`);
    } else {
      ctx.log("rescue", `=== Fuel transfer mission for ${target.username} complete ===`);
    }

    ctx.log("rescue_debug", `=== Rescue loop iteration complete, sleeping before next scan ===`);

    // Reset idle timer after successful rescue
    idleStartTime = 0;
    isReturningIdle = false;

    // Short cooldown before next scan
    await sleep(10000);
  }
};

// ── Manual Player Rescue routine ────────────────────────────

interface ManualRescueParams {
  targetSystem: string;
  targetPOI: string;
  targetPlayer: string;
}

/**
 * Manual Player Rescue routine — rescues a specific player at a specified location.
 * Parameters are passed via ctx.bot.params or similar mechanism.
 *
 * 1. Navigate to the specified system
 * 2. Travel to the specified POI
 * 3. Use get_nearby to find the target player
 * 4. If player not found (typo), try fuzzy matching or refuel all nearby ships
 * 5. Refuel the target player(s)
 * 6. Return home, dock, and refuel
 */
export const manualPlayerRescueRoutine: Routine = async function* (ctx: RoutineContext, params?: ManualRescueParams) {
  const { bot } = ctx;

  await bot.refreshStatus();
  const homeSystem = bot.system;

  // Get parameters (passed from botmanager via action.params)
  const rescueParams = params || (bot as unknown as Record<string, unknown>).routineParams as ManualRescueParams | undefined;

  if (!rescueParams) {
    ctx.log("error", "No rescue parameters provided! Need targetSystem, targetPOI, and targetPlayer.");
    await sleep(5000);
    return;
  }

  const { targetSystem, targetPOI, targetPlayer } = rescueParams;
  
  ctx.log("rescue", `🚀 Manual Player Rescue Mission initiated!`);
  ctx.log("rescue", `Target: ${targetPlayer} at ${targetSystem} / ${targetPOI}`);

  const settings = getRescueSettings();

  while (bot.state === "running") {
    // ── Death recovery ──
    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) { await sleep(30000); continue; }

    // ── Check for Refueling Pump ──
    const hasPump = await hasRefuelingPump(ctx);
    if (!hasPump) {
      ctx.log("error", "Refueling Pump module not installed! Cannot perform direct fuel transfer.");
      ctx.log("info", "Falling back to fuel cell delivery method...");
    }

    // ── Ensure we have enough fuel ──
    yield "self_check";
    await bot.refreshStatus();
    logStatus(ctx);

    if (hasPump) {
      const minFuelForTransfer = Math.round(bot.maxFuel * (settings.refuelThreshold / 100)) + 100;
      if (bot.fuel < minFuelForTransfer) {
        ctx.log("rescue", "Insufficient fuel for transfer — refueling self first...");
        const fueled = await ensureFueled(ctx, settings.refuelThreshold);
        if (!fueled) {
          ctx.log("error", "Cannot refuel self — aborting mission");
          await sleep(5000);
          return;
        }
      }
    }

    // ── Navigate to target system ──
    yield "navigate_to_target";
    await ensureUndocked(ctx);

    if (targetSystem && targetSystem !== bot.system) {
      ctx.log("rescue", `Navigating to ${targetSystem}...`);
      const safetyOpts = { fuelThresholdPct: settings.refuelThreshold, hullThresholdPct: 30 };
      const arrived = await navigateToSystem(ctx, targetSystem, safetyOpts);
      if (!arrived) {
        ctx.log("error", `Could not reach ${targetSystem} — aborting mission`);
        await sleep(5000);
        return;
      }
    }

    if (bot.state !== "running") break;

    // ── Travel to target POI ──
    yield "travel_to_target";
    ctx.log("rescue", `Traveling to target location (${targetPOI})...`);
    const travelResp = await bot.exec("travel", { target_poi: targetPOI });
    if (travelResp.error && !travelResp.error.message.includes("already")) {
      ctx.log("error", `Travel failed: ${travelResp.error.message}`);
      // Continue anyway, we might already be there
    }
    bot.poi = targetPOI;

    // ── Find the target player using get_nearby ──
    yield "scan_target";
    ctx.log("rescue", `Scanning for player: ${targetPlayer}...`);

    const nearbyResp = await bot.exec("get_nearby");
    let nearbyPlayers: Array<{ playerId: string; username: string; shipType?: string }> = [];

    if (!nearbyResp.error && nearbyResp.result) {
      // Track player names from nearby scan
      bot.trackNearbyPlayers(nearbyResp.result);

      // Check for pirates and flee if detected
      const { checkAndFleeFromPirates } = await import("./common.js");
      const fled = await checkAndFleeFromPirates(ctx, nearbyResp.result);
      if (fled) {
        ctx.log("error", "Pirates detected - had to flee, rescue aborted");
        return;
      }

      const data = nearbyResp.result as Record<string, unknown>;
      const players = Array.isArray(data.players) ? data.players :
                      Array.isArray(data.nearby) ? data.nearby :
                      Array.isArray(data.ships) ? data.ships : [];

      for (const p of players as Array<Record<string, unknown>>) {
        const playerId = (p.player_id as string) || (p.id as string);
        const username = (p.username as string) || (p.name as string);
        const shipType = p.ship_type as string | undefined;
        if (playerId && username) {
          nearbyPlayers.push({ playerId, username, shipType });
        }
      }

      ctx.log("rescue", `Found ${nearbyPlayers.length} nearby ship(s)`);
    }

    if (nearbyPlayers.length === 0) {
      ctx.log("error", `No ships found at ${targetPOI}. Target may have left or location is wrong.`);
      ctx.log("rescue", `Returning home...`);
      break;
    }

    // ── Find target player (exact match or fuzzy) ──
    let targetEntry: { playerId: string; username: string; shipType?: string } | null = nearbyPlayers.find(p => p.username.toLowerCase() === targetPlayer.toLowerCase()) || null;

    if (!targetEntry) {
      // Fuzzy match - find closest by name similarity
      ctx.log("warn", `Exact match not found for "${targetPlayer}" — trying fuzzy match...`);

      let bestMatch: { playerId: string; username: string; shipType?: string } | null = null;
      let bestScore = 0;

      for (const p of nearbyPlayers) {
        // Simple similarity: check if one name contains the other or has high character overlap
        const name1 = p.username.toLowerCase();
        const name2 = targetPlayer.toLowerCase();

        // Check containment
        if (name1.includes(name2) || name2.includes(name1)) {
          bestMatch = p;
          break;
        }

        // Check character overlap (simple Levenshtein-like heuristic)
        let matches = 0;
        for (const char of name2) {
          if (name1.includes(char)) matches++;
        }
        const score = matches / Math.max(name1.length, name2.length);

        if (score > bestScore && score > 0.6) {
          bestScore = score;
          bestMatch = p;
        }
      }

      if (bestMatch) {
        ctx.log("warn", `Fuzzy match found: "${bestMatch.username}" (confidence: ${(bestScore * 100).toFixed(0)}%)`);
        targetEntry = bestMatch;
      } else {
        ctx.log("error", `Could not find player "${targetPlayer}" or any close match.`);
        ctx.log("rescue", `Will refuel all nearby ships as fallback...`);
      }
    }

    // ── Refuel target(s) ──
    yield "transfer_fuel";

    const playersToRefuel: Array<{ playerId: string; username: string; shipType?: string }> = targetEntry ? [targetEntry] : nearbyPlayers;
    
    for (const player of playersToRefuel) {
      if (hasPump) {
        // Direct refuel using refuel command
        ctx.log("rescue", `Refueling ${player.username}${player.shipType ? ` (${player.shipType})` : ''}...`);
        
        const refuelResp = await bot.exec("refuel", { target: player.playerId });
        
        if (refuelResp.error) {
          ctx.log("error", `Refuel failed: ${refuelResp.error.message}`);
        } else {
          const result = refuelResp.result as Record<string, unknown> | undefined;
          if (result) {
            const fuelDelta = result.fuel as number || 0;
            const targetFuelNow = result.target_fuel_now as number || 0;
            ctx.log("rescue", `✓ Transferred ${Math.abs(fuelDelta)} fuel to ${player.username}`);
            ctx.log("rescue", `  Their fuel: ${targetFuelNow}`);
          } else {
            ctx.log("rescue", `✓ Refueled ${player.username}`);
          }
        }
      } else {
        // Fallback: jettison fuel cells
        ctx.log("rescue", `No Refueling Pump — jettisoning fuel cells for ${player.username}...`);
        
        await ensureDocked(ctx);
        await collectFromStorage(ctx);
        
        await bot.refreshCargo();
        const fuelItem = bot.inventory.find(i =>
          i.itemId.includes("fuel_cell") || i.itemId.includes("fuel") || i.itemId.includes("energy_cell")
        );
        
        if (fuelItem && fuelItem.quantity > 0) {
          await ensureUndocked(ctx);
          
          const jetResp = await bot.exec("jettison", {
            item_id: fuelItem.itemId,
            quantity: fuelItem.quantity,
          });
          
          if (jetResp.error) {
            ctx.log("error", `Jettison failed: ${jetResp.error.message}`);
          } else {
            ctx.log("rescue", `✓ Jettisoned ${fuelItem.quantity}x ${fuelItem.name} for ${player.username}`);
          }
        } else {
          ctx.log("error", "No fuel cells available for delivery");
        }
      }
    }

    // ── Mission complete — return home ──
    ctx.log("rescue", `=== Rescue mission complete ===`);
    break;
  }

  // ── Return to home system ──
  if (homeSystem && bot.system.toLowerCase() !== homeSystem.toLowerCase()) {
    yield "return_home";
    ctx.log("rescue", `Returning to home system ${homeSystem}...`);
    await ensureUndocked(ctx);
    const safetyOpts = { fuelThresholdPct: settings.refuelThreshold, hullThresholdPct: 30 };
    const arrived = await navigateToSystem(ctx, homeSystem, safetyOpts);
    if (!arrived) {
      ctx.log("error", `Failed to return to home system ${homeSystem}`);
    } else {
      // CRITICAL: Refresh status after navigation to ensure bot.system is updated
      await bot.refreshStatus();
      ctx.log("rescue", `✓ Arrived at home system ${homeSystem} (confirmed: ${bot.system})`);

      // If home station is configured, travel there and dock
      if (settings.homeStation) {
        const [expectedSystem, stationId] = settings.homeStation.split('|');
        if (expectedSystem === homeSystem && stationId) {
          ctx.log("rescue", `🚀 Traveling to home station (${stationId})...`);
          const travelResp = await bot.exec("travel", { target_poi: stationId });
          if (travelResp.error) {
            ctx.log("error", `❌ Failed to travel to home station: ${travelResp.error.message}`);
          } else {
            ctx.log("rescue", `⚓ Docking at home station...`);
            const dockResp = await bot.exec("dock");
            if (dockResp.error) {
              ctx.log("error", `❌ Failed to dock at home station: ${dockResp.error.message}`);
            } else {
              ctx.log("rescue", `✓ Docked at home station`);
              // Refuel after docking
              ctx.log("rescue", `⛽ Refueling at home station...`);
              const refuelResp = await bot.exec("refuel");
              if (refuelResp.error) {
                ctx.log("error", `❌ Failed to refuel at home station: ${refuelResp.error.message}`);
              } else {
                await bot.refreshStatus();
                ctx.log("rescue", `✓ Refueled to ${bot.fuel}/${bot.maxFuel} fuel`);
              }
            }
          }
        }
      }
    }
  } else if (!homeSystem) {
    ctx.log("warn", "No home system set — skipping return home");
  } else {
    ctx.log("rescue", `Already at home system ${homeSystem}`);
    
    // Already at home system - still travel to home station and dock if configured
    if (settings.homeStation) {
      const [expectedSystem, stationId] = settings.homeStation.split('|');
      if (expectedSystem === homeSystem && stationId) {
        ctx.log("rescue", `🚀 Traveling to home station...`);
        const travelResp = await bot.exec("travel", { target_poi: stationId });
        if (!travelResp.error) {
          ctx.log("rescue", `⚓ Docking at home station...`);
          const dockResp = await bot.exec("dock");
          if (!dockResp.error) {
            ctx.log("rescue", `✓ Docked at home station`);
            // Refuel after docking
            ctx.log("rescue", `⛽ Refueling at home station...`);
            const refuelResp = await bot.exec("refuel");
            if (!refuelResp.error) {
              await bot.refreshStatus();
              ctx.log("rescue", `✓ Refueled to ${bot.fuel}/${bot.maxFuel} fuel`);
            }
          }
        }
      }
    }
  }

  // ── Dock and refuel self (fallback if not already docked at station) ──
  yield "self_refuel";
  await ensureDocked(ctx);

  // Refuel after mission - but only if below threshold
  await bot.refreshStatus();
  const fuelAfterMission = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
  if (fuelAfterMission < settings.refuelThreshold) {
    ctx.log("rescue", `Fuel at ${fuelAfterMission}% — refueling to threshold (${settings.refuelThreshold}%)...`);
    const refuelResp = await bot.exec("refuel");
    if (refuelResp.error) {
      ctx.log("error", `Refuel failed: ${refuelResp.error.message}`);
      await ensureFueled(ctx, settings.refuelThreshold);
    } else {
      await bot.refreshStatus();
      const fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
      ctx.log("rescue", `Fuel: ${fuelPct}% (${bot.fuel}/${bot.maxFuel})`);
    }
  } else {
    ctx.log("rescue", `Fuel at ${fuelAfterMission}% — above threshold, no need to refuel`);
  }

  await bot.refreshStatus();
  logStatus(ctx);

  ctx.log("rescue", `✓ Bot is docked and ready for next mission`);

  // Clear routine params after completion (also cleared in botmanager, but good to do here too)
  (bot as unknown as Record<string, unknown>).routineParams = undefined;
}

// ── MaydayRescue routine ────────────────────────────────────

/**
 * MaydayRescue routine — automatically responds to MAYDAY emergency chat messages.
 *
 * 1. Monitor MAYDAY queue for emergency rescue requests
 * 2. Validate request (fuel < 25% to avoid ambushes)
 * 3. Calculate route and send AI-generated "on my way" message
 * 4. Navigate to stranded pilot's location
 * 5. Refuel them using refuel command (if pump installed) or fuel cells
 * 6. Send AI-generated "rescue complete" message
 * 7. Return home and refuel
 * 8. Continue monitoring for next MAYDAY
 */
export const maydayRescueRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  await bot.refreshStatus();
  const settings = getRescueSettings();
  const homeSystem = settings.homeSystem || bot.system;
  
  if (settings.homeSystem) {
    ctx.log("system", `Home base configured: ${homeSystem}`);
  } else {
    ctx.log("warn", "No home base configured — will use starting system as home");
  }

  ctx.log("rescue", "🚨 MaydayRescue bot online — monitoring emergency channel for distress calls...");

  // Clear MAYDAY queue on startup (ignore old messages from chat history backlog)
  clearMaydayQueue();
  ctx.log("rescue", `🗑️ Cleared MAYDAY queue - ignoring old chat history`);

  const aiChatService = (globalThis as any).aiChatService;

  // Log category for this routine (always "mayday" since it's MAYDAY-specific)
  const logCategory = "mayday";

  while (bot.state === "running") {
    // ── Death recovery ──
    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) { await sleep(30000); continue; }

    // ── Rescue session recovery ──
    const activeSession = getActiveRescueSession(bot.username);
    let recoveredSession: RescueSession | null = null;
    if (activeSession && activeSession.isMayday) {
      ctx.log("mayday", `Found incomplete MAYDAY rescue session: ${activeSession.targetUsername} at ${activeSession.targetSystem}/${activeSession.targetPoi} (${activeSession.state})`);
      recoveredSession = activeSession;
      ctx.log("mayday", `Resuming MAYDAY rescue for ${activeSession.targetUsername} (state: ${activeSession.state})`);
    }

    // ── Handle recovered session ──
    let mayday: MaydayRequest | null = null;
    if (recoveredSession) {
      // Reconstruct mayday from session
      const fleet = ctx.getFleetStatus?.() || [];
      const targetBot = fleet.find(b => b.username === recoveredSession.targetUsername);
      const fuelPct = targetBot ? (targetBot.maxFuel > 0 ? Math.round((targetBot.fuel / targetBot.maxFuel) * 100) : 100) : 0;
      
      mayday = {
        sender: recoveredSession.targetUsername,
        system: recoveredSession.targetSystem,
        poi: recoveredSession.targetPoi,
        fuelPct,
        timestamp: Date.now(),
        currentFuel: targetBot?.fuel || 0,
        maxFuel: targetBot?.maxFuel || 100,
        rawMessage: "",
      };

      // Skip to appropriate phase based on session state
      if (recoveredSession.state === "navigating" || recoveredSession.state === "at_system") {
        ctx.log("mayday", `Session state '${recoveredSession.state}' - navigating to ${recoveredSession.targetSystem}...`);
      } else if (recoveredSession.state === "traveling_to_poi" || recoveredSession.state === "at_poi") {
        ctx.log("mayday", `Session state '${recoveredSession.state}' - at system, proceeding to POI...`);
        bot.system = recoveredSession.targetSystem;
        bot.poi = recoveredSession.targetPoi;
      } else if (recoveredSession.state === "delivering_fuel") {
        ctx.log("mayday", `Session state '${recoveredSession.state}' - at POI, proceeding to fuel delivery...`);
        bot.system = recoveredSession.targetSystem;
        bot.poi = recoveredSession.targetPoi;
      }
      
      ctx.log("mayday", `Resuming MAYDAY rescue for ${mayday.sender} at ${mayday.system}/${mayday.poi}`);
    }

    // ── Check for pending MAYDAY requests (only if not resuming) ──
    if (!recoveredSession) {
      yield "scan_mayday";
      const nextMayday = getNextMayday();

      if (!nextMayday) {
        // No pending MAYDAYs - idle and wait
        ctx.log("mayday", "No pending MAYDAY requests - standing by...");
        yield "idle";
        await sleep(10000); // Check every 10 seconds
        continue;
      }

      ctx.log("mayday", `🚨 MAYDAY received: ${nextMayday.sender} at ${nextMayday.system}/${nextMayday.poi} (${nextMayday.fuelPct}% fuel)`);

      // ── Validate MAYDAY ──
      // Check if sender is a known player (from playerNames.json)
      const knownPlayer = isKnownPlayer(nextMayday.sender);
      
      if (!knownPlayer) {
        // Unknown sender - skip this MAYDAY (possible ambush)
        ctx.log("mayday", `⚠️ Ignoring MAYDAY from ${nextMayday.sender} - not a known player (possible ambush)`);
        markMaydayHandled(nextMayday);
        continue;
      }
      
      ctx.log("mayday", `✓ Sender ${nextMayday.sender} is a KNOWN player — responding to MAYDAY`);

      // ── MAYDAY FUEL CHECK: Verify sender's fuel is below threshold ──
      // Prevents wasting fuel on players who aren't actually in distress (potential ambushes)
      if (nextMayday.fuelPct > settings.maydayFuelThreshold) {
        ctx.log("mayday", `⚠️ Ignoring MAYDAY from ${nextMayday.sender} - fuel too high (${nextMayday.fuelPct}% > ${settings.maydayFuelThreshold}% threshold)`);
        markMaydayHandled(nextMayday);
        continue;
      }
      ctx.log("mayday", `✓ Fuel check passed: ${nextMayday.fuelPct}% <= ${settings.maydayFuelThreshold}% threshold`);

      // ── RESCUE BLACKBOOK: Check if we should rescue this player ──
      const rescueDecision = shouldRescuePlayer(nextMayday.sender);
      if (!rescueDecision.shouldRescue) {
        ctx.log("mayday", `⚠️ Ignoring MAYDAY from ${nextMayday.sender} - ${rescueDecision.reason}`);
        markMaydayHandled(nextMayday);
        continue;
      }
      ctx.log("mayday", `✓ BlackBook check passed: ${rescueDecision.reason}`);

      // Record rescue request for blackbook tracking
      recordRescueRequest(nextMayday.sender);

      mayday = nextMayday;
    }

    // mayday is guaranteed to be set at this point (either from recovery or fresh)
    if (!mayday) {
      await sleep(5000);
      continue;
    }

    ctx.log("mayday", `✓ MAYDAY validated - launching rescue mission for ${mayday.sender}`);

    // ── Check for Refueling Pump ──
    const hasPump = await hasRefuelingPump(ctx);
    if (!hasPump) {
      ctx.log("mayday", "⚠️ Refueling Pump not installed - will use fuel cell delivery method");
    }

    // ── Ensure we have enough fuel ──
    yield "self_check";
    await bot.refreshStatus();
    logStatus(ctx);

    if (hasPump) {
      const minFuelForTransfer = Math.round(bot.maxFuel * (settings.refuelThreshold / 100)) + 100;
      if (bot.fuel < minFuelForTransfer) {
        ctx.log("mayday", "Insufficient fuel for transfer - refueling self first...");
        const fueled = await ensureFueled(ctx, settings.refuelThreshold);
        if (!fueled) {
          ctx.log("error", "Cannot refuel self - cannot respond to MAYDAY");
          await sleep(30000);
          continue;
        }
      }
    }

    // ── Calculate route and send "on my way" message ──
    let jumpsToTarget = 0;
    let estimatedFuel = 0;

    if (mayday.system && mayday.system !== bot.system) {
      try {
        const routeResp = await bot.exec("find_route", { target_system: mayday.system });
        if (!routeResp.error && routeResp.result) {
          const route = routeResp.result as Record<string, unknown>;
          jumpsToTarget = (route.total_jumps as number) || 0;
          estimatedFuel = (route.estimated_fuel as number) || 0;
          ctx.log("mayday", `Route calculated: ${jumpsToTarget} jumps, ~${estimatedFuel} fuel`);
        }
      } catch (e) {
        ctx.log("warn", `Could not calculate route: ${e}`);
      }
    }

    // ── Check jump limit ──
    let maxJumps = settings.maydayMaxJumps;
    
    if (maxJumps > 0 && jumpsToTarget > maxJumps) {
      ctx.log("mayday", `⚠️ MAYDAY too far: ${jumpsToTarget} jumps (max: ${maxJumps}) - ignoring`);
      markMaydayHandled(mayday);
      await sleep(5000);
      continue;
    }
    
    ctx.log("mayday", `✓ Jump check passed: ${jumpsToTarget} jumps (limit: ${maxJumps})`);

    // ── Create rescue session if starting new mission ──
    if (!recoveredSession) {
      const session: RescueSession = {
        sessionId: `${bot.username}_${Date.now()}`,
        botUsername: bot.username,
        targetUsername: mayday.sender,
        targetSystem: mayday.system,
        targetPoi: mayday.poi || "unknown",
        isMayday: true,
        jumpsCompleted: 0,
        totalJumps: jumpsToTarget,
        startedAt: new Date().toISOString(),
        lastUpdatedAt: new Date().toISOString(),
        state: "navigating",
      };
      startRescueSession(session);
      ctx.log("mayday", `Created MAYDAY rescue session for ${mayday.sender}`);
    }

    // Send AI-generated "on my way" message via private chat
    if (aiChatService && typeof aiChatService.sendPrivateMessage === "function") {
      try {
        const result = await aiChatService.sendPrivateMessage(bot, mayday.sender, {
          situation: `You are responding to their MAYDAY distress call. You are coming to rescue them with fuel.`,
          currentSystem: bot.system,
          targetSystem: mayday.system,
          jumps: jumpsToTarget > 0 ? jumpsToTarget : undefined,
          playerFuelPct: mayday.fuelPct,
        });
        if (result.ok) {
          ctx.log("mayday", `✓ Sent "on my way" private message to ${mayday.sender}`);
        } else {
          ctx.log("warn", `Private message to ${mayday.sender} failed: ${result.error}`);
        }
      } catch (e) {
        ctx.log("warn", `AI message failed: ${e}`);
      }
    } else {
      // Fallback: simple hardcoded message
      const etaMsg = jumpsToTarget > 0 ? `ETA: ${jumpsToTarget} jumps` : "Arriving shortly";
      ctx.log("mayday", `Sending rescue confirmation to ${mayday.sender}`);
      // Note: Would need private chat command here
    }

    // ── Navigate to target system ──
    yield "navigate_to_target";
    await ensureUndocked(ctx);

    if (mayday.system && mayday.system !== bot.system) {
      ctx.log("mayday", `Jumping to ${mayday.system}...`);
      const safetyOpts = { fuelThresholdPct: settings.refuelThreshold, hullThresholdPct: 30 };
      const arrived = await navigateToSystem(ctx, mayday.system, safetyOpts);
      if (!arrived) {
        ctx.log("error", `Could not reach ${mayday.system} - MAYDAY response failed`);
        if (recoveredSession || getActiveRescueSession(bot.username)) {
          failRescueSession(bot.username, "Could not reach target system");
        }
        markMaydayHandled(mayday);
        await sleep(5000);
        continue;
      }
      // Update session state after successful navigation
      if (recoveredSession || getActiveRescueSession(bot.username)) {
        updateRescueSession(bot.username, { state: "at_system" });
      }
    }

    if (bot.state !== "running") break;

    // ── Travel to target POI ──
    yield "travel_to_target";
    ctx.log("mayday", `Traveling to ${mayday.poi}...`);
    const travelResp = await bot.exec("travel", { target_poi: mayday.poi });
    if (travelResp.error && !travelResp.error.message.includes("already")) {
      ctx.log("error", `Travel failed: ${travelResp.error.message}`);
    }
    bot.poi = mayday.poi;
    // Update session state after traveling to POI
    if (recoveredSession || getActiveRescueSession(bot.username)) {
      updateRescueSession(bot.username, { state: "at_poi" });
    }

    // ── Find and refuel target ──
    yield "scan_target";
    ctx.log("mayday", `Scanning for ${mayday.sender}...`);

    // Update session state before fuel delivery
    if (recoveredSession || getActiveRescueSession(bot.username)) {
      updateRescueSession(bot.username, { state: "delivering_fuel" });
    }

    const nearbyResp = await bot.exec("get_nearby");
    let targetPlayerId: string | null = null;
    let targetFuelBefore = 0;

    if (!nearbyResp.error && nearbyResp.result) {
      // Track player names from nearby scan
      bot.trackNearbyPlayers(nearbyResp.result);

      // Check for pirates and flee if detected
      const { checkAndFleeFromPirates } = await import("./common.js");
      const fled = await checkAndFleeFromPirates(ctx, nearbyResp.result);
      if (fled) {
        ctx.log("error", "Pirates detected - had to flee, rescue aborted");
        return;
      }

      const data = nearbyResp.result as Record<string, unknown>;
      const players = Array.isArray(data.players) ? data.players :
                      Array.isArray(data.nearby) ? data.nearby :
                      Array.isArray(data.ships) ? data.ships : [];

      for (const p of players as Array<Record<string, unknown>>) {
        const playerId = (p.player_id as string) || (p.id as string);
        const username = (p.username as string) || (p.name as string);
        const fuelNow = (p.fuel_now as number) || (p.fuel as number) || 0;
        if (username && username.toLowerCase() === mayday.sender.toLowerCase()) {
          targetPlayerId = playerId;
          targetFuelBefore = fuelNow;
          break;
        }
      }
    }

    // ── Refuel target ──
    yield "transfer_fuel";
    let fuelTransferred = 0;

    if (targetPlayerId) {
      if (hasPump) {
        // Direct refuel using refuel command
        ctx.log("mayday", `Refueling ${mayday.sender}...`);
        const refuelResp = await bot.exec("refuel", { target: targetPlayerId });

        if (refuelResp.error) {
          ctx.log("error", `Refuel failed: ${refuelResp.error.message}`);
        } else {
          const result = refuelResp.result as Record<string, unknown> | undefined;
          if (result) {
            fuelTransferred = Math.abs(result.fuel as number || 0);
            const targetFuelNow = result.target_fuel_now as number || 0;
            ctx.log("mayday", `✓ Transferred ${fuelTransferred} fuel to ${mayday.sender}`);
            ctx.log("mayday", `  Their fuel: ${targetFuelNow}`);
          }
        }
      } else {
        // Fallback: jettison fuel cells
        ctx.log("mayday", `No Refueling Pump - jettisoning fuel cells for ${mayday.sender}...`);
        await ensureDocked(ctx);
        await collectFromStorage(ctx);
        await bot.refreshCargo();
        const fuelItem = bot.inventory.find(i =>
          i.itemId.includes("fuel_cell") || i.itemId.includes("fuel") || i.itemId.includes("energy_cell")
        );
        if (fuelItem && fuelItem.quantity > 0) {
          await ensureUndocked(ctx);
          const jetResp = await bot.exec("jettison", {
            item_id: fuelItem.itemId,
            quantity: fuelItem.quantity,
          });
          if (jetResp.error) {
            ctx.log("error", `Jettison failed: ${jetResp.error.message}`);
          } else {
            fuelTransferred = fuelItem.quantity * 10; // Approximate fuel value
            ctx.log("mayday", `✓ Jettisoned ${fuelItem.quantity}x ${fuelItem.name} for ${mayday.sender}`);
          }
        }
      }
    } else {
      ctx.log("warn", `Could not find ${mayday.sender} at location - they may have left or it was a false MAYDAY`);
    }

    // Send AI-generated "rescue complete" message
    if (aiChatService && typeof aiChatService.sendPrivateMessage === "function") {
      try {
        const result = await aiChatService.sendPrivateMessage(bot, mayday.sender, {
          situation: fuelTransferred > 0
            ? `You have successfully refueled the stranded pilot. They are now safe and can continue their journey.`
            : `You arrived to help but couldn't provide fuel. You did your best to assist.`,
          currentSystem: mayday.system, // Now at same system
          targetSystem: mayday.system,
          fuelRefueled: fuelTransferred > 0 ? fuelTransferred : undefined,
          playerFuelPct: targetFuelBefore,
        });
        if (result.ok) {
          ctx.log("mayday", `✓ Sent "rescue complete" private message to ${mayday.sender}`);
        } else {
          ctx.log("warn", `Private message to ${mayday.sender} failed: ${result.error}`);
        }
      } catch (e) {
        ctx.log("warn", `AI completion message failed: ${e}`);
      }
    } else {
      ctx.log("warn", "AI Chat service not available for rescue complete message");
    }

    // Mark MAYDAY as handled
    markMaydayHandled(mayday);
    ctx.log("mayday", `=== MAYDAY response complete for ${mayday.sender} ===`);

    // Refresh status before returning home
    await bot.refreshStatus();
    ctx.log("mayday", `Current location: ${bot.system}, Home: ${homeSystem || "not set"}`);

    // ── Return home ──
    if (homeSystem && bot.system.toLowerCase() !== homeSystem.toLowerCase()) {
      yield "return_home";
      ctx.log("mayday", `Returning to home system ${homeSystem}...`);
      await ensureUndocked(ctx);
      const safetyOpts = { fuelThresholdPct: settings.refuelThreshold, hullThresholdPct: 30 };
      const arrived = await navigateToSystem(ctx, homeSystem, safetyOpts);
      if (!arrived) {
        ctx.log("error", `Failed to return to home system ${homeSystem}`);
      } else {
        // CRITICAL: Refresh status after navigation to ensure bot.system is updated
        await bot.refreshStatus();
        ctx.log("mayday", `✓ Arrived at home system ${homeSystem} (confirmed: ${bot.system})`);

        // If home station is configured, travel there and dock
        if (settings.homeStation) {
          const [expectedSystem, stationId] = settings.homeStation.split('|');
          if (expectedSystem === homeSystem && stationId) {
            ctx.log("mayday", `🚀 Traveling to home station (${stationId})...`);
            const travelResp = await bot.exec("travel", { target_poi: stationId });
            if (travelResp.error) {
              ctx.log("error", `❌ Failed to travel to home station: ${travelResp.error.message}`);
            } else {
              ctx.log("mayday", `⚓ Docking at home station...`);
              const dockResp = await bot.exec("dock");
              if (dockResp.error) {
                ctx.log("error", `❌ Failed to dock at home station: ${dockResp.error.message}`);
              } else {
                ctx.log("mayday", `✓ Docked at home station`);
                // Refuel after docking
                ctx.log("mayday", `⛽ Refueling at home station...`);
                const refuelResp = await bot.exec("refuel");
                if (refuelResp.error) {
                  ctx.log("error", `❌ Failed to refuel at home station: ${refuelResp.error.message}`);
                } else {
                  await bot.refreshStatus();
                  ctx.log("mayday", `✓ Refueled to ${bot.fuel}/${bot.maxFuel} fuel`);
                }
              }
            }
          }
        }
      }
      // Update session state for return home
      if (recoveredSession || getActiveRescueSession(bot.username)) {
        updateRescueSession(bot.username, { state: "returning_home" });
      }
    } else if (!homeSystem) {
      ctx.log("warn", "No home system set — skipping return home");
    } else {
      ctx.log("mayday", `Already at home system ${homeSystem}`);
      
      // Already at home system - still travel to home station and dock if configured
      if (settings.homeStation) {
        const [expectedSystem, stationId] = settings.homeStation.split('|');
        if (expectedSystem === homeSystem && stationId) {
          ctx.log("mayday", `🚀 Traveling to home station...`);
          const travelResp = await bot.exec("travel", { target_poi: stationId });
          if (!travelResp.error) {
            ctx.log("mayday", `⚓ Docking at home station...`);
            const dockResp = await bot.exec("dock");
            if (!dockResp.error) {
              ctx.log("mayday", `✓ Docked at home station`);
              // Refuel after docking
              ctx.log("mayday", `⛽ Refueling at home station...`);
              const refuelResp = await bot.exec("refuel");
              if (!refuelResp.error) {
                await bot.refreshStatus();
                ctx.log("mayday", `✓ Refueled to ${bot.fuel}/${bot.maxFuel} fuel`);
              }
            }
          }
        }
      }
    }

    // ── Dock and refuel self (fallback if not already docked at station) ──
    yield "self_refuel";
    await ensureDocked(ctx);

    // ── Complete the rescue session ──
    if (recoveredSession || getActiveRescueSession(bot.username)) {
      completeRescueSession(bot.username);

      // Also mark the queue entry as completed if this was our own bot
      if (isOwnBot(mayday.sender)) {
        const queue = getRescueQueue();
        const queuedRescue = queue.pending.find(r => r.targetUsername === mayday.sender);
        if (queuedRescue) {
          markRescueCompleted(queuedRescue.id);
          ctx.log("rescue", `📋 Marked ${mayday.sender} as completed in rescue queue`);
        }
      }
    }

    await bot.refreshStatus();
    const fuelAfterMission = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    if (fuelAfterMission < settings.refuelThreshold) {
      ctx.log("mayday", `Fuel at ${fuelAfterMission}% — refueling to threshold (${settings.refuelThreshold}%)...`);
      const refuelResp = await bot.exec("refuel");
      if (refuelResp.error) {
        ctx.log("error", `Refuel failed: ${refuelResp.error.message}`);
        await ensureFueled(ctx, settings.refuelThreshold);
      } else {
        await bot.refreshStatus();
        const fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
        ctx.log("mayday", `Fuel: ${fuelPct}% (${bot.fuel}/${bot.maxFuel})`);
      }
    } else {
      ctx.log("mayday", `Fuel at ${fuelAfterMission}% — above threshold, no need to refuel`);
    }

    await bot.refreshStatus();
    logStatus(ctx);
    ctx.log("mayday", "✓ Bot is docked and ready for next MAYDAY");

    // Short cooldown before next scan
    await sleep(5000);
  }
};

/**
 * Look up a player's ID from their username.
 * Uses get_nearby to find players at the current location.
 */
async function findPlayerId(ctx: RoutineContext, username: string): Promise<string | null> {
  const { bot } = ctx;
  
  // First, check if we can get it from fleet status (extended fields)
  const fleet = ctx.getFleetStatus?.() || [];
  for (const member of fleet) {
    if (member.username === username) {
      // Check for player_id in extended fields
      const memberRecord = member as unknown as Record<string, unknown>;
      if (memberRecord.player_id && typeof memberRecord.player_id === 'string') {
        return memberRecord.player_id;
      }
    }
  }
  
  // Use get_nearby to find the player at current location
  try {
    const resp = await bot.exec("get_nearby");
    if (!resp.error && resp.result) {
      // Check for pirates and flee if detected
      const { checkAndFleeFromPirates } = await import("./common.js");
      const fled = await checkAndFleeFromPirates(ctx, resp.result);
      if (fled) {
        ctx.log("error", "Pirates detected - had to flee");
        return null;
      }

      const data = resp.result as Record<string, unknown>;
      const players = Array.isArray(data.players) ? data.players :
                      Array.isArray(data.nearby) ? data.nearby :
                      Array.isArray(data.ships) ? data.ships :
                      [];

      for (const p of players as Array<Record<string, unknown>>) {
        const playerId = (p.player_id as string) || (p.id as string);
        const pUsername = (p.username as string) || (p.name as string);

        if (pUsername && pUsername.toLowerCase() === username.toLowerCase()) {
          ctx.log("rescue", `Found player ID for ${username}: ${playerId}`);
          return playerId;
        }
      }

      // If exact match not found, try fuzzy match
      ctx.log("warn", `Exact match not found for "${username}" — trying fuzzy match...`);
      for (const p of players as Array<Record<string, unknown>>) {
        const playerId = (p.player_id as string) || (p.id as string);
        const pUsername = ((p.username as string) || (p.name as string) || "").toLowerCase();

        if (pUsername.includes(username.toLowerCase()) || username.toLowerCase().includes(pUsername)) {
          ctx.log("rescue", `Fuzzy match found: ${pUsername} -> ${playerId}`);
          return playerId;
        }
      }
    }
  } catch (e) {
    ctx.log("warn", `Error getting nearby players: ${e}`);
  }

  ctx.log("warn", `Could not resolve player ID for ${username}`);
  return null;
}

// ── FuelRescue routine ──────────────────────────────────────

/**
 * FuelRescue routine — monitors fleet and rescues stranded bots:
 *
 * 1. Scan fleet status for bots with dangerously low fuel
 * 2. Buy fuel cells at nearest station (or use existing stock)
 * 3. Navigate to stranded bot's system
 * 4. Travel to stranded bot's POI
 * 5. If same station: send_gift credits. If in space: jettison fuel cells
 * 6. Scavenge loop on the stranded bot picks up the fuel cells
 * 7. Return to idle scanning
 */
export const rescueRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  await bot.refreshStatus();
  const settings = getRescueSettings();
  const homeSystem = settings.homeSystem || bot.system;
  
  if (settings.homeSystem) {
    ctx.log("system", `Home base configured: ${homeSystem}`);
  } else {
    ctx.log("warn", "No home base configured — will use starting system as home");
  }

  ctx.log("system", "FuelRescue bot online — monitoring fleet and MAYDAY channel for stranded ships...");

  // Clear MAYDAY queue on startup (ignore old messages from chat history backlog)
  clearMaydayQueue();
  ctx.log("rescue", `🗑️ Cleared MAYDAY queue - ignoring old chat history`);

  // Track idle time when away from home (for auto-return feature)
  let idleStartTime = 0; // Timestamp when we started being idle
  const IDLE_RETURN_THRESHOLD_MS = 30000; // Return home after 30 seconds of idle time when away from home
  let isReturningIdle = false; // Track if we're returning home due to idle

  // Log if starting away from home
  const startedAwayFromHome = homeSystem && normalizeSystemName(bot.system) !== normalizeSystemName(homeSystem);
  if (startedAwayFromHome) {
    ctx.log("rescue", `⚠️ Bot started away from home (${bot.system} vs ${homeSystem}) — will return home after ${IDLE_RETURN_THRESHOLD_MS / 1000}s of idle time`);
  } else if (homeSystem) {
    ctx.log("rescue", `✓ Bot started at home base (${homeSystem})`);
  }

  // ── Start background credit top-off loop (non-blocking) ──
  startCreditTopOffBackground(ctx, settings.creditTopOffAmount);

  // Log category - determined when target is selected
  let logCategory: string = "rescue";

  while (bot.state === "running") {
    // ── Death recovery ──
    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) { await sleep(30000); continue; }

    // ── Clean up expired rescue announcements ──
    cleanupExpiredAnnouncements();

    // ── Monitor faction chat for rescue announcements from other bots ──
    // This helps coordinate with other rescue bots to avoid duplicate responses
    try {
      const chatResp = await bot.exec("get_chat_history", { channel: "faction", limit: 20 });
      if (!chatResp.error && chatResp.result) {
        const r = chatResp.result as Record<string, unknown>;
        const msgs = (
          Array.isArray(chatResp.result) ? chatResp.result :
          Array.isArray(r.messages) ? r.messages :
          Array.isArray(r.history) ? r.history :
          []
        ) as Array<Record<string, unknown>>;

        for (const msg of msgs) {
          const content = (msg.content as string) || (msg.message as string) || "";
          const sender = (msg.sender as string) || (msg.username as string) || "";
          const ts = (msg.timestamp as number) || (msg.created_at as number) || Date.now();

          // Skip messages from self
          if (sender === bot.username) continue;

          const announcement = parseRescueAnnouncement(content, sender, ts * 1000);
          if (announcement) {
            recordRescueAnnouncement(announcement);
            ctx.log("rescue", `📡 Detected rescue announcement from ${sender}: ${announcement.targetName} at ${announcement.targetSystem}`);
          }
        }
      }
    } catch (e) {
      // Ignore errors - faction chat monitoring is optional
    }

    // ── RESCUE COOPERATION: Monitor private messages from partner bot ──
    // This enables coordination between our two rescue bots
    // Note: We can't poll private chat history (requires target_id), so we rely on real-time messages
    const coopSettings = getCooperationSettings();
    if (isCooperationEnabled() && coopSettings.enabled) {
      ctx.log("coop_debug", `Cooperation monitoring enabled (partner: ${coopSettings.partnerBotName})`);
    }

    // ── Check for MANUAL RESCUE requests (HIGHEST PRIORITY) ──
    const manualRescue = getNextManualRescue();
    let manualRescueTarget: RescueTarget | null = null;
    if (manualRescue) {
      ctx.log("rescue", `🎯 MANUAL RESCUE REQUEST: ${manualRescue.targetPlayer} at ${manualRescue.targetSystem}/${manualRescue.targetPOI}`);
      manualRescueTarget = {
        username: manualRescue.targetPlayer,
        system: manualRescue.targetSystem,
        poi: manualRescue.targetPOI,
        fuelPct: 0, // Unknown fuel level for manual rescue
        docked: false,
      };
      markManualRescueHandled(manualRescue);
      ctx.log("rescue", `✓ Manual rescue request accepted - will rescue ${manualRescue.targetPlayer}`);
    }

    // ── Rescue session recovery ──
    const activeSession = getActiveRescueSession(bot.username);
    let recoveredSession: RescueSession | null = null;
    if (activeSession && !manualRescueTarget) {
      ctx.log("rescue", `Found incomplete rescue session: ${activeSession.targetUsername} at ${activeSession.targetSystem}/${activeSession.targetPoi} (${activeSession.state})`);
      // Validate the session is still relevant
      const fleet = ctx.getFleetStatus?.() || [];
      const targetStillStranded = fleet.find(b => b.username === activeSession.targetUsername);
      
      if (targetStillStranded) {
        const fuelPct = targetStillStranded.maxFuel > 0 ? Math.round((targetStillStranded.fuel / targetStillStranded.maxFuel) * 100) : 100;
        if (fuelPct <= 25) {
          // Target still needs help - resume the session
          recoveredSession = activeSession;
          ctx.log("rescue", `Resuming rescue mission for ${activeSession.targetUsername} (state: ${activeSession.state})`);
        } else {
          // Target has been refueled - clear the session
          ctx.log("rescue", `${activeSession.targetUsername} has been refueled (${fuelPct}%) - clearing session`);
          failRescueSession(bot.username, "Target no longer needs rescue");
        }
      } else {
        // Target not in fleet - they may have logged off or session is stale
        ctx.log("rescue", `Target ${activeSession.targetUsername} not in fleet - clearing session`);
        failRescueSession(bot.username, "Target not found in fleet");
      }
    }

    const settings = getRescueSettings();

    // ── Determine log category early (needed for skipToReturnHome case) ──
    let logCategory: string = "rescue";

    // ── Handle recovered session or manual rescue ──
    let target: RescueTarget | null = null;
    let isMaydayTarget = false;
    let isManualRescueTarget = false;
    let skipToReturnHome = false;

    if (manualRescueTarget) {
      // Manual rescue has highest priority
      target = manualRescueTarget;
      isManualRescueTarget = true;
      ctx.log("rescue", `🎯 PRIORITY: Manual rescue mission for ${target.username}`);
    } else if (recoveredSession) {
      // Resume the rescued session - skip scanning and go directly to execution
      target = {
        username: recoveredSession.targetUsername,
        system: recoveredSession.targetSystem,
        poi: recoveredSession.targetPoi,
        fuelPct: 0, // Will be updated below
        docked: false,
      };
      isMaydayTarget = recoveredSession.isMayday;
      logCategory = isMaydayTarget ? "mayday" : "rescue";

      // Update fleet info for target
      const fleet = ctx.getFleetStatus?.() || [];
      const targetBot = fleet.find(b => b.username === target!.username);
      if (targetBot) {
        target.fuelPct = targetBot.maxFuel > 0 ? Math.round((targetBot.fuel / targetBot.maxFuel) * 100) : 100;
        target.docked = targetBot.docked;
      }

      ctx.log("rescue", `Continuing rescue for ${target.username} at ${target.system}/${target.poi}`);

      // Skip to appropriate phase based on session state
      if (recoveredSession.state === "navigating" || recoveredSession.state === "at_system") {
        // Need to navigate to target system
        ctx.log("rescue", `Session state '${recoveredSession.state}' - navigating to ${target.system}...`);
      } else if (recoveredSession.state === "traveling_to_poi" || recoveredSession.state === "at_poi") {
        // Already at system, need to travel to POI
        ctx.log("rescue", `Session state '${recoveredSession.state}' - at system, proceeding to POI...`);
        bot.system = target.system;
      } else if (recoveredSession.state === "delivering_fuel") {
        // At POI, need to deliver fuel
        ctx.log("rescue", `Session state '${recoveredSession.state}' - at POI, proceeding to fuel delivery...`);
        bot.system = target.system;
        bot.poi = target.poi;
      } else if (recoveredSession.state === "returning_home") {
        // Already returning home
        ctx.log("rescue", `Session state '${recoveredSession.state}' - continuing return to home...`);
        bot.system = target.system;
        bot.poi = target.poi;
      }

      // Jump over setup phases and go to navigation/delivery
      // Set up for immediate execution below
    }

    // ── Check fleet status (only if not resuming and no manual rescue) ──
    if (!recoveredSession && !manualRescueTarget) {
      yield "scan_fleet";
      const fleet = ctx.getFleetStatus?.() || [];
      if (fleet.length === 0) {
        ctx.log("info", "No fleet data available — waiting...");
        await sleep(settings.scanIntervalSec * 1000);
        continue;
      }

      const targets = findStrandedBots(fleet, bot.username, settings.fuelThreshold);

      // ── RESCUE QUEUE: Add our own bots to the queue for batch processing ──
      for (const target of targets) {
        if (isOwnBot(target.username)) {
          const result = addToRescueQueue(
            target.username,
            target.system,
            target.poi,
            target.fuelPct,
            target.docked
          );
          if (result.added) {
            ctx.log("rescue", `📋 Added ${target.username} to rescue queue at ${target.system}/${target.poi} (${target.fuelPct}% fuel)`);
          }
        }
      }

      // Clean up stale queue entries
      cleanupStaleQueue();

      // Get queue stats for logging
      const queueStats = getQueueStats();
      if (queueStats.pending > 0) {
        ctx.log("rescue", `📋 Rescue queue: ${queueStats.pending} pending across ${queueStats.systems.length} system(s), ${queueStats.completed} completed`);
        if (queueStats.systems.length > 0) {
          ctx.log("rescue", `📍 Systems in queue: ${queueStats.systems.join(", ")}`);
        }
      }

      // ── Check for MAYDAY requests if no fleet targets ──
      let maydayTarget: RescueTarget | null = null;
      if (targets.length === 0) {
        const mayday = getNextMayday();
        if (mayday) {
          ctx.log("mayday", `🚨 MAYDAY received: ${mayday.sender} at ${mayday.system}/${mayday.poi} (${mayday.fuelPct}% fuel)`);

          // Check if sender is a known player (from playerNames.json)
          const knownPlayer = isKnownPlayer(mayday.sender);

          if (!knownPlayer) {
            // Unknown sender - skip this MAYDAY (possible ambush)
            ctx.log("mayday", `⚠️ Ignoring MAYDAY from ${mayday.sender} - not a known player (possible ambush)`);
            markMaydayHandled(mayday);
            continue;
          }

          ctx.log("mayday", `✓ Sender ${mayday.sender} is a KNOWN player — responding to MAYDAY`);

          // ── MAYDAY FUEL CHECK: Verify sender's fuel is below threshold ──
          // Prevents wasting fuel on players who aren't actually in distress (potential ambushes)
          if (mayday.fuelPct > settings.maydayFuelThreshold) {
            ctx.log("mayday", `⚠️ Ignoring MAYDAY from ${mayday.sender} - fuel too high (${mayday.fuelPct}% > ${settings.maydayFuelThreshold}% threshold)`);
            markMaydayHandled(mayday);
            continue;
          }
          ctx.log("mayday", `✓ Fuel check passed: ${mayday.fuelPct}% <= ${settings.maydayFuelThreshold}% threshold`);

          // ── RESCUE BLACKBOOK: Check if we should rescue this player ──
          const rescueDecision = shouldRescuePlayer(mayday.sender);
          if (!rescueDecision.shouldRescue) {
            ctx.log("mayday", `⚠️ Ignoring MAYDAY from ${mayday.sender} - ${rescueDecision.reason}`);
            markMaydayHandled(mayday);
            continue;
          }
          ctx.log("mayday", `✓ BlackBook check passed: ${rescueDecision.reason}`);

          // ── RESCUE BLACKBOOK: Check if this is a duplicate MAYDAY (chat cache echo) ──
          // Prevents re-triggering the same rescue we just completed
          if (isMaydayDuplicate(bot.username, mayday.sender, mayday.system, mayday.poi)) {
            ctx.log("mayday", `⚠️ Ignoring MAYDAY from ${mayday.sender} - duplicate of recently completed rescue (chat cache echo)`);
            markMaydayHandled(mayday);
            continue;
          }
          ctx.log("mayday_debug", `✓ Not a duplicate MAYDAY`);

          // Record rescue request for blackbook tracking
          recordRescueRequest(mayday.sender);

          // ── RESCUE COORDINATION: Check if another bot is already handling this ──
          const handledBy = isRescueHandled(mayday.sender, mayday.system, mayday.poi, bot.username);
          if (handledBy) {
            ctx.log("rescue", `🤝 MAYDAY already being handled by ${handledBy.rescuerUsername} - skipping to avoid duplicate rescue`);
            markMaydayHandled(mayday);
            continue;
          }

          // ── RESCUE COOPERATION: Check with partner bot if enabled ──
          let partnerClaim = isRescueClaimedByPartner(mayday.sender, mayday.system, mayday.poi, bot.username);
          
          if (isCooperationEnabled() && settings.cooperationEnabled) {
            ctx.log("coop", `🤝 Cooperation enabled (partner: ${settings.partnerBotName})`);
            ctx.log("coop", `🤝 MAYDAY: ${mayday.sender} at ${mayday.system}/${mayday.poi}`);
            
            if (partnerClaim) {
              // Partner has claimed this rescue - will compare distances after calculating jumps
              ctx.log("coop", `🤝 ✓ PARTNER CLAIM FOUND: ${partnerClaim.botName} claimed ${partnerClaim.player} at ${partnerClaim.system} (${partnerClaim.jumps} jumps, ts: ${partnerClaim.timestamp})`);
            } else {
              ctx.log("coop", `🤝 ✗ No partner claim found yet - will proceed and send claim (partner may respond with their claim)`);
            }
          }

          // Check jump range
          let jumpsAway = 0;
          if (mayday.system && mayday.system !== bot.system && settings.maydayMaxJumps > 0) {
            try {
              const routeResp = await bot.exec("find_route", { target_system: mayday.system });
              if (!routeResp.error && routeResp.result) {
                const route = routeResp.result as Record<string, unknown>;
                jumpsAway = (route.total_jumps as number) || 0;

                if (jumpsAway > settings.maydayMaxJumps) {
                  ctx.log("mayday", `⚠️ MAYDAY too far: ${jumpsAway} jumps (max: ${settings.maydayMaxJumps}) - ignoring`);
                  markMaydayHandled(mayday);
                  continue;
                }
              }
            } catch (e) {
              ctx.log("warn", `Could not calculate route to ${mayday.system}: ${e}`);
            }
          }

          maydayTarget = {
            username: mayday.sender,
            system: mayday.system,
            poi: mayday.poi,
            fuelPct: mayday.fuelPct,
            docked: false,
          };
          markMaydayHandled(mayday);
          ctx.log("mayday", `✓ MAYDAY validated (${jumpsAway} jumps) - launching rescue mission for ${mayday.sender}`);
          
          // ── RESCUE COOPERATION: Send claim to partner bot ──
          if (isCooperationEnabled() && settings.cooperationEnabled) {
            const myClaim: RescueClaim = {
              type: "RESCUE_CLAIM",
              player: mayday.sender,
              system: mayday.system,
              poi: mayday.poi,
              timestamp: new Date().toISOString(),
              jumps: jumpsAway,
              botName: bot.username,
            };

            // Send claim to partner bot and wait for it to complete
            ctx.log("coop", `📧 Sending rescue claim to ${settings.partnerBotName}...`);
            const sendResult = await sendRescueClaim(bot, myClaim);
            if (sendResult.ok) {
              ctx.log("coop", `📧 Sent rescue claim to ${settings.partnerBotName}: ${mayday.sender} at ${mayday.system} (${jumpsAway} jumps)`);
            } else {
              ctx.log("coop", `⚠️ Failed to send rescue claim: ${sendResult.error}`);
            }

            // Wait briefly for partner's claim to arrive (accounts for chat delays)
            // Use configured delay, default 3 seconds
            const cooperationDelay = Math.min(settings.cooperationMaxDelaySeconds * 1000, 5000);
            ctx.log("coop", `⏱ Waiting ${cooperationDelay / 1000}s for partner claim...`);
            await sleep(cooperationDelay);

            // Re-check for partner claims after delay
            partnerClaim = isRescueClaimedByPartner(mayday.sender, mayday.system, mayday.poi, bot.username);
            
            // Check if we should yield to partner
            if (partnerClaim) {
              const decision = shouldProceedOrYield(myClaim, partnerClaim);
              if (decision === "yield") {
                ctx.log("coop", `🤝 Yielding rescue to ${partnerClaim.botName} (they are closer: ${partnerClaim.jumps} vs ${jumpsAway} jumps)`);
                maydayTarget = null; // Cancel this rescue
                markMaydayHandled(mayday);
                continue;
              } else if (decision === "proceed") {
                ctx.log("coop", `🤝 Proceeding with rescue (closer than partner: ${jumpsAway} vs ${partnerClaim.jumps} jumps)`);
              }
            } else {
              ctx.log("coop", `🤝 No partner claim received - proceeding with rescue`);
            }
          }
        }
      }

      if (targets.length === 0 && !maydayTarget) {
        // Track idle time when away from home
        const isAwayFromHome = homeSystem && normalizeSystemName(bot.system) !== normalizeSystemName(homeSystem);
        if (isAwayFromHome && !isReturningIdle) {
          // Start idle timer on first idle cycle
          if (idleStartTime === 0) {
            idleStartTime = Date.now();
          }
          const elapsedMs = Date.now() - idleStartTime;

          if (elapsedMs >= IDLE_RETURN_THRESHOLD_MS) {
            ctx.log("rescue", `⏱️ Idle for ${Math.round(elapsedMs / 1000)}s — returning home...`);
            isReturningIdle = true;

            // Immediately execute return home
            ctx.log("rescue", `🏠 Returning home after idle timeout...`);
            yield "return_home";
            await ensureUndocked(ctx);
            const safetyOpts = { fuelThresholdPct: settings.refuelThreshold, hullThresholdPct: 30 };
            const arrived = await navigateToSystem(ctx, homeSystem, safetyOpts);
            if (!arrived) {
              ctx.log("error", `Failed to return to home system ${homeSystem}`);
            } else {
              // CRITICAL: Refresh status after navigation to ensure bot.system is updated
              await bot.refreshStatus();
              ctx.log("rescue", `✓ Arrived at home system ${homeSystem} (confirmed: ${bot.system})`);

              // If home station is configured, travel there and dock
              if (settings.homeStation) {
                const [expectedSystem, stationId] = settings.homeStation.split('|');
                ctx.log("rescue_debug", `homeStation config: "${settings.homeStation}", parsed: expectedSystem="${expectedSystem}", stationId="${stationId}"`);
                
                if (expectedSystem === homeSystem && stationId) {
                  ctx.log("rescue", `🚀 Traveling to home station (${stationId})...`);
                  const travelResp = await bot.exec("travel", { target_poi: stationId });
                  if (travelResp.error) {
                    ctx.log("error", `❌ Failed to travel to home station: ${travelResp.error.message}`);
                  } else {
                    ctx.log("rescue", `⚓ Docking at home station...`);
                    const dockResp = await bot.exec("dock");
                    if (dockResp.error) {
                      ctx.log("error", `❌ Failed to dock at home station: ${dockResp.error.message}`);
                    } else {
                      ctx.log("rescue", `✓ Docked at home station`);
                      // Refuel after docking
                      ctx.log("rescue", `⛽ Refueling at home station...`);
                      const refuelResp = await bot.exec("refuel");
                      if (refuelResp.error) {
                        ctx.log("error", `❌ Failed to refuel at home station: ${refuelResp.error.message}`);
                      } else {
                        await bot.refreshStatus();
                        ctx.log("rescue", `✓ Refueled to ${bot.fuel}/${bot.maxFuel} fuel`);
                      }
                    }
                  }
                } else {
                  ctx.log("warn", `⚠️ homeStation config mismatch: expectedSystem "${expectedSystem}" !== homeSystem "${homeSystem}" or stationId is empty`);
                }
              } else {
                ctx.log("warn", `⚠️ No home station configured - bot will remain at POI in ${homeSystem}`);
              }
            }
            isReturningIdle = false;
            idleStartTime = 0;
            continue; // Restart loop after returning home
          } else {
            ctx.log("rescue", `⏱️ Idle for ${Math.round(elapsedMs / 1000)}s (away from home)`);
          }
        } else {
          // Reset idle timer if we're not away from home or already returning
          idleStartTime = 0;
        }

        // ── RESCUE QUEUE: Check if we have queued rescues before idling ──
        const queueStats = getQueueStats();
        if (queueStats.pending > 0) {
          ctx.log("rescue", `📋 Rescue queue has ${queueStats.pending} pending rescues — checking for optimized route...`);
          
          // Optimize route based on current location
          const optimizedRoute = optimizeRescueRoute(bot.system);
          if (optimizedRoute.length > 0) {
            setCurrentRoute(optimizedRoute);
            ctx.log("rescue", `🗺️ Optimized route set: ${optimizedRoute.join(" → ")}`);
            
            // Get the first system in the route
            const firstSystem = optimizedRoute[0];
            const rescuesInSystem = getRescuesInSystem(firstSystem);
            
            if (rescuesInSystem.length > 0) {
              // Pick the most critical rescue in the first system
              rescuesInSystem.sort((a, b) => a.fuelPct - b.fuelPct);
              const queuedRescue = rescuesInSystem[0];
              
              ctx.log("rescue", `🎯 Selecting queued rescue: ${queuedRescue.targetUsername} at ${queuedRescue.system}/${queuedRescue.poi} (${queuedRescue.fuelPct}%)`);
              
              target = {
                username: queuedRescue.targetUsername,
                system: queuedRescue.system,
                poi: queuedRescue.poi,
                fuelPct: queuedRescue.fuelPct,
                docked: queuedRescue.docked,
              };
              isMaydayTarget = false;
              logCategory = "rescue";
              
              // Skip the idle/scavenge and go directly to rescue
              incrementRescueAttempt(queuedRescue.id);
            }
          }
        }
        
        if (!target) {
          // No queued rescues or queue is empty — scavenge and idle
          yield "idle_scavenge";
          if (!bot.docked) {
            await scavengeWrecks(ctx);
          }
          await sleep(settings.scanIntervalSec * 1000);
          continue;
        }
      }

      // ── Rescue the most critical bot ──
      target = maydayTarget || targets[0];
      isMaydayTarget = !!maydayTarget;
      logCategory = isMaydayTarget ? "mayday" : "rescue";
    }

    if (!target) {
      // Should not happen, but safety check
      await sleep(5000);
      continue;
    }

    // ── Create rescue session if starting new mission ──
    if (!recoveredSession && target) {
      const session: RescueSession = {
        sessionId: `${bot.username}_${Date.now()}`,
        botUsername: bot.username,
        targetUsername: target.username,
        targetSystem: target.system,
        targetPoi: target.poi || "unknown",
        isMayday: isMaydayTarget,
        jumpsCompleted: 0,
        totalJumps: 0,
        startedAt: new Date().toISOString(),
        lastUpdatedAt: new Date().toISOString(),
        state: "navigating",
      };
      startRescueSession(session);
      ctx.log("rescue", `Created rescue session for ${target.username}`);

      // Send faction chat announcement for rescue start
      const aiChatService = (globalThis as any).aiChatService;
      if (aiChatService && typeof aiChatService.sendFactionMessage === "function") {
        try {
          const result = await aiChatService.sendFactionMessage(bot, {
            messageType: "rescue_start",
            targetName: target.username,
            isMayday: isMaydayTarget,
            isBot: !isMaydayTarget && !isManualRescueTarget,
            currentSystem: bot.system,
            targetSystem: target.system,
            targetPoi: target.poi || undefined,
            targetFuelPct: target.fuelPct,
          });
          // Only record announcement if message was actually sent
          if (result.ok) {
            recordRescueAnnouncement({
              rescuerUsername: bot.username,
              targetName: target.username,
              targetSystem: target.system,
              targetPoi: target.poi || undefined,
              timestamp: Date.now(),
              isMayday: isMaydayTarget,
            });
          } else {
            ctx.log("ai_chat_debug", `Faction announcement skipped: ${result.error}`);
          }
        } catch (e) {
          ctx.log("warn", `AI faction message (start) failed: ${e}`);
        }
      }
    }

    // ── Log the rescue target ──
    if (isManualRescueTarget) {
      ctx.log("rescue", `🎯 MANUAL RESCUE: ${target.username} at ${target.system}/${target.poi || "unknown"}`);
    } else if (isMaydayTarget) {
      ctx.log("mayday", `RESCUE NEEDED (MAYDAY): ${target.username} at ${target.fuelPct}% fuel in ${target.system} (POI: ${target.poi || "unknown"})`);
    } else {
      ctx.log("rescue", `RESCUE NEEDED: ${target.username} at ${target.fuelPct}% fuel in ${target.system} (POI: ${target.poi || "unknown"})`);
    }

    // ── Ensure we have fuel ourselves ──
    yield "self_check";
    await bot.refreshStatus();
    logStatus(ctx);

    // Only refuel if below threshold - don't waste time refueling when already well-fueled
    const fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    if (fuelPct < settings.refuelThreshold) {
      ctx.log("rescue", `Fuel at ${fuelPct}% (below threshold ${settings.refuelThreshold}%) — refueling before mission...`);
      const fueled = await ensureFueled(ctx, settings.refuelThreshold);
      if (!fueled) {
        ctx.log("error", "Cannot refuel self — waiting before retry...");
        await sleep(settings.scanIntervalSec * 1000);
        continue;
      }
    } else {
      ctx.log("rescue", `Fuel at ${fuelPct}% — above threshold (${settings.refuelThreshold}%), no need to refuel`);
    }

    // ── Check for Refueling Pump ──
    const hasPump = await hasRefuelingPump(ctx);
    if (hasPump) {
      ctx.log("rescue", "✓ Refueling Pump detected - will use direct refuel command");
    }

    // ── Stock up on fuel cells for delivery (only if no pump) ──
    let hasFuelCells = false;
    let willSendCredits = false;
    
    if (!hasPump) {
      yield "acquire_fuel";
      await ensureDocked(ctx);

      // First check faction storage for fuel cells
      ctx.log("rescue", "Checking faction storage for fuel cells...");
      await bot.refreshFactionStorage();
      const factionFuelCells = bot.factionStorage?.find(i =>
        i.itemId.includes("fuel_cell") || i.itemId.includes("fuel") || i.itemId.includes("energy_cell")
      );
      
      if (factionFuelCells && factionFuelCells.quantity >= settings.rescueFuelCells) {
        ctx.log("rescue", `Found ${factionFuelCells.quantity}x ${factionFuelCells.name} in faction storage`);
        // collectFromStorage will be called after docking below
        hasFuelCells = true;
      }

      // If not in faction storage, check cargo
      if (!hasFuelCells) {
        await bot.refreshCargo();
        const fuelInCargo = bot.inventory.find(i =>
          i.itemId.includes("fuel_cell") || i.itemId.includes("fuel") || i.itemId.includes("energy_cell")
        );
        if (fuelInCargo && fuelInCargo.quantity > 0) {
          hasFuelCells = true;
          ctx.log("rescue", `Already have ${fuelInCargo.quantity}x ${fuelInCargo.name} in cargo`);
        }
      }

      // Try buying fuel cells from market as last resort
      if (!hasFuelCells) {
        ctx.log("rescue", "Checking market for fuel cells...");
        const marketResp = await bot.exec("view_market");

        if (marketResp.result && typeof marketResp.result === "object") {
          const mData = marketResp.result as Record<string, unknown>;
          const items = (
            Array.isArray(mData) ? mData :
            Array.isArray(mData.items) ? mData.items :
            Array.isArray(mData.market) ? mData.market :
            []
          ) as Array<Record<string, unknown>>;

          const fuelItem = items.find(i => {
            const id = ((i.item_id as string) || (i.id as string) || "").toLowerCase();
            return id.includes("fuel_cell") || id.includes("fuel") || id.includes("energy_cell");
          });

          if (fuelItem) {
            const fuelId = (fuelItem.item_id as string) || (fuelItem.id as string) || "";
            const price = (fuelItem.price as number) || (fuelItem.buy_price as number) || 0;
            const available = (fuelItem.quantity as number) || (fuelItem.stock as number) || 0;
            const qty = Math.min(settings.rescueFuelCells, available);

            if (qty > 0 && (price * qty) <= bot.credits) {
              ctx.log("rescue", `Buying ${qty}x fuel cells (${price}cr each)...`);
              const buyResp = await bot.exec("buy", { item_id: fuelId, quantity: qty });
              if (!buyResp.error) {
                hasFuelCells = true;
                ctx.log("rescue", `Acquired ${qty}x fuel cells`);
              } else {
                ctx.log("rescue", `Buy failed: ${buyResp.error.message}`);
              }
            }
          }
        }
      }

      // If we can't get fuel cells, send credits instead (if at same station)
      willSendCredits = !hasFuelCells && bot.credits >= settings.rescueCredits;

      if (!hasFuelCells && !willSendCredits) {
        ctx.log("error", "No fuel cells available and not enough credits to help — waiting for better situation...");
        // Fail the session if we can't acquire resources
        if (recoveredSession || getActiveRescueSession(bot.username)) {
          failRescueSession(bot.username, "Could not acquire fuel cells or credits");
        }
        await sleep(settings.scanIntervalSec * 1000);
        continue;
      }
    } else {
      // Has Refueling Pump - no need for fuel cells
      willSendCredits = false;
    }

    // ── Navigate to stranded bot's system ──
    ctx.log("rescue", `🔍 Navigation debug (2nd path): target.system=${target?.system}, bot.system=${bot.system}, isMayday=${isMaydayTarget}, isManual=${isManualRescueTarget}`);
    yield "navigate_to_target";
    await ensureUndocked(ctx);

    if (target.system && normalizeSystemName(target.system) !== normalizeSystemName(bot.system)) {
      ctx.log(logCategory, `Navigating to ${target.system}...`);

      // Track jumps for billing - get route before navigating
      let jumpsToTarget = 0;
      try {
        const routeResp = await bot.exec("find_route", { target_system: target.system });
        if (!routeResp.error && routeResp.result) {
          const route = routeResp.result as Record<string, unknown>;
          jumpsToTarget = (route.total_jumps as number) || 0;
          ctx.log("rescue", `📍 Route to target: ${jumpsToTarget} jump${jumpsToTarget !== 1 ? 's' : ''}`);
        }
      } catch (e) {
        ctx.log("warn", `Could not calculate route to ${target.system}: ${e}`);
      }

      // ── RESCUE COOPERATION: Send en-route notification to stranded player ──
      // Let them know we're on our way (only for MAYDAY rescues, not fleet rescues)
      if (isMaydayTarget || isManualRescueTarget) {
        const aiChatService = (globalThis as any).aiChatService;
        if (aiChatService && typeof aiChatService.sendRescueEnRouteNotification === "function") {
          aiChatService.sendRescueEnRouteNotification(bot, target.username, jumpsToTarget).then((result: { ok: boolean; message?: string; error?: string }) => {
            if (!result.ok) {
              ctx.log("warn", `Failed to send en-route notification: ${result.error}`);
            }
          }).catch((err: Error) => {
            ctx.log("warn", `Error sending en-route notification: ${err.message}`);
          });
        }
      }

      const safetyOpts = {
        fuelThresholdPct: settings.refuelThreshold,
        hullThresholdPct: 30,
        onJump: async (jumpNumber: number) => {
          // Check if target still needs rescue on every jump
          const statusCheck = await checkTargetStillNeedsRescue(
            ctx,
            target!.username,
            target!.fuelPct,
            target!.system,
            target!.docked,
          );

          if (!statusCheck.needsRescue) {
            ctx.log("rescue", `🛑 ABORTING rescue - ${statusCheck.reason}`);
            return false; // Abort navigation
          }

          // Log progress every 5 jumps
          if (jumpNumber % 5 === 0 && statusCheck.currentFuelPct !== null) {
            ctx.log("rescue", `📍 Jump ${jumpNumber}: ${target!.username} fuel at ${statusCheck.currentFuelPct}% in ${statusCheck.currentSystem}`);
          }

          return true; // Continue navigation
        },
      };
      const arrived = await navigateToSystem(ctx, target.system, safetyOpts);
      if (!arrived) {
        ctx.log("error", `Could not reach ${target.system} — will retry next scan`);
        // Fail the session if we can't reach the target
        if (recoveredSession || getActiveRescueSession(bot.username)) {
          failRescueSession(bot.username, "Could not reach target system");
        }
        await sleep(settings.scanIntervalSec * 1000);
        continue;
      }
      // Update session state and jumps after successful navigation
      if (recoveredSession || getActiveRescueSession(bot.username)) {
        updateRescueSession(bot.username, { state: "at_system", jumpsCompleted: jumpsToTarget });
      }
    }

    if (bot.state !== "running") break;

    // ── Travel to stranded bot's POI ──
    if (target.poi) {
      yield "travel_to_target";

      // For our own bots, refresh position from fleet status before traveling
      const isOurBot = isOwnBot(target.username);
      if (isOurBot) {
        ctx.log("rescue", `🔄 Refreshing position for our own bot ${target.username}...`);
        const fleet = ctx.getFleetStatus?.() || [];
        const targetBot = fleet.find(b => b.username === target.username);
        if (targetBot) {
          const oldPoi = target.poi;
          target.poi = targetBot.poi || target.poi;
          target.system = targetBot.system || target.system;
          target.docked = targetBot.docked;
          if (oldPoi !== target.poi) {
            ctx.log("rescue", `📍 Position updated for ${target.username}: ${oldPoi} -> ${target.poi}`);
          }
        }
      }

      // Track attempts for hidden POI detection
      let travelAttempts = 0;
      const maxTravelAttempts = isOurBot ? 5 : 3; // Retry more for our own bots, but always try search for others
      let travelSuccess = false;
      let searchAttempted = false; // Track if we've tried the hidden POI search

      while (travelAttempts < maxTravelAttempts && !travelSuccess) {
        travelAttempts++;

        // For our own bots, refresh position on each attempt
        if (isOurBot && travelAttempts > 1) {
          ctx.log("rescue", `🔄 Re-refreshing position for ${target.username} (attempt ${travelAttempts})...`);
          const fleet = ctx.getFleetStatus?.() || [];
          const targetBot = fleet.find(b => b.username === target.username);
          if (targetBot) {
            target.poi = targetBot.poi || target.poi;
            target.system = targetBot.system || target.system;
            target.docked = targetBot.docked;
            ctx.log("rescue", `📍 Position refreshed: ${target.system}/${target.poi}`);
          }
        }

        // Resolve POI name to POI ID by querying system info
        let targetPoiId: string | null = null;
        let targetPoiName: string = target.poi;

        try {
          const { pois } = await getSystemInfo(ctx);
          // Find POI by name (case-insensitive match)
          const matchedPoi = pois.find(p => p.name.toLowerCase() === target.poi.toLowerCase());
          if (matchedPoi) {
            targetPoiId = matchedPoi.id;
            targetPoiName = matchedPoi.name;
            ctx.log(logCategory, `Resolved POI "${target.poi}" -> ID: ${targetPoiId}`);
          } else {
            // Try partial match as fallback
            const partialMatch = pois.find(p => p.name.toLowerCase().includes(target.poi.toLowerCase()) || target.poi.toLowerCase().includes(p.name.toLowerCase()));
            if (partialMatch) {
              targetPoiId = partialMatch.id;
              targetPoiName = partialMatch.name;
              ctx.log(logCategory, `Partial POI match: "${target.poi}" -> ID: ${targetPoiId}`);
            }
          }
        } catch (e) {
          ctx.log("warn", `Could not query system POIs: ${e}`);
        }

        // Use POI ID if resolved, otherwise fall back to name
        const travelTarget = targetPoiId || target.poi;

        ctx.log(logCategory, `Traveling to ${target.username}'s location (${targetPoiName})... (attempt ${travelAttempts}/${maxTravelAttempts})`);
        const travelResp = await bot.exec("travel", { target_poi: travelTarget });
        if (travelResp.error && !travelResp.error.message.includes("already")) {
          ctx.log("error", `Travel failed: ${travelResp.error.message}`);

          // Check if this might be a hidden POI - try jumping out and back
          // This can happen for ANY bot (not just our own) when they're in a hidden POI
          const isUnknownDestination = travelResp.error.message.toLowerCase().includes("unknown");
          
          if ((isOurBot || isUnknownDestination) && !searchAttempted && travelAttempts < maxTravelAttempts) {
            ctx.log("rescue", `🔀 Possible hidden POI detected! Attempting jump-out-and-back to find ${target.username}...`);
            searchAttempted = true;

            // Find all connected systems (jump gates) to try
            const { pois } = await getSystemInfo(ctx);
            const jumpGates = pois.filter(p => p.type === "jump_gate" || p.type === "stargate");

            if (jumpGates.length > 0) {
              ctx.log("rescue", `📍 Found ${jumpGates.length} connected system(s) to search: ${jumpGates.map(g => g.name).join(', ')}`);
              
              // Try each connected system until we find the hidden POI
              let foundHiddenPoi = false;
              for (const jumpGate of jumpGates) {
                if (foundHiddenPoi) break; // Stop if we already found it
                
                ctx.log("rescue", `🚀 Trying jump to ${jumpGate.name} to reset entry...`);
                const jumpResp = await bot.exec("travel", { target_poi: jumpGate.id });

                if (!jumpResp.error || jumpResp.error.message.includes("already")) {
                  // Now jump back to the target POI
                  await sleep(2000); // Brief pause for system to update

                  ctx.log("rescue", `🚀 Jumping back to ${targetPoiName} from ${jumpGate.name}...`);
                  const returnResp = await bot.exec("travel", { target_poi: travelTarget });

                  if (!returnResp.error || returnResp.error.message.includes("already")) {
                    ctx.log("rescue", `✓ Successfully jumped back in from ${jumpGate.name} - found hidden POI!`);
                    bot.poi = targetPoiName;
                    travelSuccess = true;
                    foundHiddenPoi = true;
                  } else {
                    ctx.log("warn", `Return jump from ${jumpGate.name} failed: ${returnResp.error?.message}`);
                  }
                } else {
                  ctx.log("warn", `Jump to ${jumpGate.name} failed: ${jumpResp.error?.message}`);
                }
              }
              
              if (!foundHiddenPoi) {
                ctx.log("warn", `Hidden POI search completed - tried all ${jumpGates.length} connected system(s) without success`);
              }
            } else {
              ctx.log("warn", `No jump gates found to reset entry`);
            }
          } else if (!isOurBot && !isUnknownDestination) {
            // Try docking at station to send gift instead
          }
        } else {
          // Success - update bot.poi with the resolved name
          bot.poi = targetPoiName;
          travelSuccess = true;
        }

        // If we haven't succeeded and this is our bot, refresh position again
        if (!travelSuccess && isOurBot && travelAttempts < maxTravelAttempts) {
          ctx.log("rescue", `⏳ Waiting before next attempt for ${target.username}...`);
          await sleep(3000);
        }
      }

      if (!travelSuccess) {
        ctx.log("error", `Failed to reach ${target.username} at ${target.poi} after ${maxTravelAttempts} attempts`);
        
        // If we attempted the hidden POI search but still couldn't reach, try one more thing:
        // Check if the target is actually in the system by looking at fleet status
        const isOurBot = isOwnBot(target.username);
        if (isOurBot) {
          ctx.log("rescue", `🔍 Checking fleet status for ${target.username} after travel failure...`);
          const fleet = ctx.getFleetStatus?.() || [];
          const targetBot = fleet.find(b => b.username === target.username);
          
          if (targetBot && targetBot.system === target.system) {
            ctx.log("rescue", `✓ Target ${target.username} is confirmed in ${target.system} (POI: ${targetBot.poi})`);
            ctx.log("rescue", `🔀 Hidden POI confirmed! Retrying with fresh POI information...`);
            
            // Update target info and try one more time with a fresh travel attempt
            target.poi = targetBot.poi || target.poi;
            
            // Try the search function one more time with ALL connected systems
            const { pois } = await getSystemInfo(ctx);
            const jumpGates = pois.filter(p => p.type === "jump_gate" || p.type === "stargate");
            
            if (jumpGates.length > 0) {
              ctx.log("rescue", `🚀 Final attempt: Trying all ${jumpGates.length} connected system(s) to find hidden POI...`);
              let foundInFinalAttempt = false;
              
              for (const jumpGate of jumpGates) {
                if (foundInFinalAttempt) break;
                
                ctx.log("rescue", `🚀 Jumping to ${jumpGate.name}...`);
                const jumpResp = await bot.exec("travel", { target_poi: jumpGate.id });
                
                if (!jumpResp.error || jumpResp.error.message.includes("already")) {
                  await sleep(2000);
                  ctx.log("rescue", `🚀 Jumping back to ${target.poi} from ${jumpGate.name}...`);
                  const returnResp = await bot.exec("travel", { target_poi: target.poi });
                  
                  if (!returnResp.error || returnResp.error.message.includes("already")) {
                    ctx.log("rescue", `✓ Successfully found hidden POI on final attempt via ${jumpGate.name}!`);
                    bot.poi = target.poi;
                    travelSuccess = true;
                    foundInFinalAttempt = true;
                  } else {
                    ctx.log("warn", `Final return jump from ${jumpGate.name} failed: ${returnResp.error?.message}`);
                  }
                } else {
                  ctx.log("warn", `Final jump to ${jumpGate.name} failed: ${jumpResp.error?.message}`);
                }
              }
              
              if (!foundInFinalAttempt) {
                ctx.log("error", `Final search attempt failed - tried all ${jumpGates.length} connected system(s)`);
              }
            }
          }
        }
        
        // If still no success after all attempts, we need to handle the failure
        if (!travelSuccess) {
          ctx.log("error", `All rescue attempts failed for ${target.username} at ${target.poi}`);
          
          // For our own bots, don't record as ghost - they're just in a hidden POI
          if (isOurBot) {
            ctx.log("rescue", `👻 Our bot ${target.username} not reachable - likely in hidden POI`);
            ctx.log("rescue", `💡 Will retry rescue when bot is in a visible location`);
            
            // Return home and retry later
            if (homeSystem && normalizeSystemName(bot.system) !== normalizeSystemName(homeSystem)) {
              ctx.log("rescue", `🏠 Returning home before retry...`);
              await ensureUndocked(ctx);
              const safetyOpts = { fuelThresholdPct: settings.refuelThreshold, hullThresholdPct: 30 };
              const arrived = await navigateToSystem(ctx, homeSystem, safetyOpts);
              if (arrived) {
                ctx.log("rescue", `✓ Arrived at home system ${homeSystem}`);
              }
            }
            
            // Don't fail the session permanently - just continue the loop
            await sleep(10000);
            continue;
          }
          
          // For non-own bots, record ghost and fail normally
          recordGhost(target.username);
          const currentGhosts = getPlayerRecord(target.username).ghostCount;
          ctx.log("rescue", `👻 Recorded ghost incident for ${target.username} (total ghosts: ${currentGhosts})`);
          
          // Send grumpy faction chat message about being ghosted
          const aiChatService = (globalThis as any).aiChatService;
          if (aiChatService && typeof aiChatService.sendFactionMessage === "function") {
            try {
              const result = await aiChatService.sendFactionMessage(bot, {
                messageType: "rescue_no_show",
                targetName: target.username,
                isMayday: isMaydayTarget,
                isBot: !isMaydayTarget,
                currentSystem: bot.system,
                targetSystem: target.system,
                targetPoi: target.poi || undefined,
              });
              if (!result.ok) {
                ctx.log("ai_chat_debug", `Faction announcement (no_show) skipped: ${result.error}`);
              }
            } catch (e) {
              ctx.log("warn", `AI faction message (no_show) failed: ${e}`);
            }
          }
          
          if (recoveredSession || getActiveRescueSession(bot.username)) {
            failRescueSession(bot.username, "Could not reach target - all attempts failed");
          }
          markMaydayHandled({ sender: target.username, system: target.system, poi: target.poi || "", fuelPct: target.fuelPct, timestamp: Date.now(), currentFuel: 0, maxFuel: 0, rawMessage: "" });
          
          // Return home after failed rescue
          if (homeSystem && normalizeSystemName(bot.system) !== normalizeSystemName(homeSystem)) {
            ctx.log("rescue", `🚨 All rescue attempts failed - returning home to safety...`);
            await ensureUndocked(ctx);
            const safetyOpts = { fuelThresholdPct: settings.refuelThreshold, hullThresholdPct: 30 };
            const arrived = await navigateToSystem(ctx, homeSystem, safetyOpts);
            if (arrived) {
              ctx.log("rescue", `✓ Arrived at home system ${homeSystem}`);
            }
          }
          continue;
        }
      }

      // Update session state after traveling to POI
      if (recoveredSession || getActiveRescueSession(bot.username)) {
        updateRescueSession(bot.username, { state: "at_poi" });
      }

      // Skip faction chat announcement for arrival - save cooldown for completion message
    }

    // ── Deliver fuel ──
    yield "deliver_fuel";

    // Update session state before fuel delivery
    if (recoveredSession || getActiveRescueSession(bot.username)) {
      updateRescueSession(bot.username, { state: "delivering_fuel" });
    }

    // Check if target is actually at the location (for non-station targets)
    let targetFound = true;
    if (!target.docked) {
      // For our own bots, do one final position refresh before checking
      const isOurBot = isOwnBot(target.username);
      if (isOurBot) {
        ctx.log("rescue", `🔄 Final position check for our bot ${target.username}...`);
        const fleet = ctx.getFleetStatus?.() || [];
        const targetBot = fleet.find(b => b.username === target.username);
        if (targetBot) {
          const oldPoi = target.poi;
          target.poi = targetBot.poi || target.poi;
          target.system = targetBot.system || target.system;
          if (oldPoi !== target.poi) {
            ctx.log("rescue", `📍 Position updated: ${oldPoi} -> ${target.poi}`);
            // Try traveling to the new POI immediately
            ctx.log("rescue", `🚀 Traveling to updated position...`);
            const { pois } = await getSystemInfo(ctx);
            const matchedPoi = pois.find(p => p.name.toLowerCase() === target.poi.toLowerCase());
            if (matchedPoi) {
              await bot.exec("travel", { target_poi: matchedPoi.id });
              bot.poi = target.poi;
            }
          }
        }
      }

      // Use get_nearby to verify target is present
      const nearbyResp = await bot.exec("get_nearby");
      if (!nearbyResp.error && nearbyResp.result) {
        // Check for pirates and flee if detected
        const { checkAndFleeFromPirates } = await import("./common.js");
        const fled = await checkAndFleeFromPirates(ctx, nearbyResp.result);
        if (fled) {
          ctx.log("error", "Pirates detected - had to flee, rescue aborted");
          return;
        }

        const data = nearbyResp.result as Record<string, unknown>;
        const players = Array.isArray(data.players) ? data.players :
                        Array.isArray(data.nearby) ? data.nearby :
                        Array.isArray(data.ships) ? data.ships : [];

        const targetHere = players.some(p => {
          const username = ((p.username as string) || (p.name as string) || "").toLowerCase();
          return username === target.username.toLowerCase();
        });

        if (!targetHere) {
          targetFound = false;
          ctx.log("error", `Target ${target.username} not found at ${target.poi} - they may have left or it was a false alarm`);

          // For our own bots, NEVER record as ghost - they're just in a hidden POI
          if (isOurBot) {
            ctx.log("rescue", `👻 Our bot ${target.username} not found - likely in hidden POI, will keep trying`);
            ctx.log("rescue", `💡 Hidden POI detected: ${target.poi} in ${target.system}`);
            
            // Don't fail the session - keep retrying by not marking mayday as handled
            // and returning to the start of the loop
            ctx.log("rescue", `🔄 Will retry rescue for ${target.username}...`);
            
            // Return home first
            if (homeSystem && normalizeSystemName(bot.system) !== normalizeSystemName(homeSystem)) {
              ctx.log("rescue", `🏠 Returning home before retry...`);
              await ensureUndocked(ctx);
              const safetyOpts = { fuelThresholdPct: settings.refuelThreshold, hullThresholdPct: 30 };
              const arrived = await navigateToSystem(ctx, homeSystem, safetyOpts);
              if (arrived) {
                ctx.log("rescue", `✓ Arrived at home system ${homeSystem}`);
              }
            }
            
            // Retry by continuing the loop without failing the session
            await sleep(5000);
            continue;
          }

          // Record ghost incident in BlackBook (skipped for our own bots)
          recordGhost(target.username);
          const currentGhosts = getPlayerRecord(target.username).ghostCount;
          if (currentGhosts < 0) {
            ctx.log("rescue", `👻 Skipped ghost recording for ${target.username} (our own bot)`);
          } else {
            ctx.log("rescue", `👻 Recorded ghost incident for ${target.username} (total ghosts: ${currentGhosts})`);
          }

          // Send grumpy faction chat message about being ghosted
          const aiChatService = (globalThis as any).aiChatService;
          if (aiChatService && typeof aiChatService.sendFactionMessage === "function") {
            try {
              const result = await aiChatService.sendFactionMessage(bot, {
                messageType: "rescue_no_show",
                targetName: target.username,
                isMayday: isMaydayTarget,
                isBot: !isMaydayTarget,
                currentSystem: bot.system,
                targetSystem: target.system,
                targetPoi: target.poi || undefined,
              });
              if (!result.ok) {
                ctx.log("ai_chat_debug", `Faction announcement (no_show) skipped: ${result.error}`);
              }
            } catch (e) {
              ctx.log("warn", `AI faction message (no_show) failed: ${e}`);
            }
          }

          // Fail the session and return home
          if (recoveredSession || getActiveRescueSession(bot.username)) {
            failRescueSession(bot.username, "Target not found at location");
          }
          markMaydayHandled({ sender: target.username, system: target.system, poi: target.poi || "", fuelPct: target.fuelPct, timestamp: Date.now(), currentFuel: 0, maxFuel: 0, rawMessage: "" });

          // Return home after failed rescue (potential ambush)
          if (homeSystem && normalizeSystemName(bot.system) !== normalizeSystemName(homeSystem)) {
            ctx.log("rescue", `🚨 Target not found - returning home to safety...`);
            await ensureUndocked(ctx);
            const safetyOpts = { fuelThresholdPct: settings.refuelThreshold, hullThresholdPct: 30 };
            const arrived = await navigateToSystem(ctx, homeSystem, safetyOpts);
            if (arrived) {
              ctx.log("rescue", `✓ Arrived at home system ${homeSystem}`);

              // If home station is configured, travel there and dock
              if (settings.homeStation) {
                const [expectedSystem, stationId] = settings.homeStation.split('|');
                if (expectedSystem === homeSystem && stationId) {
                  ctx.log("rescue", `🚀 Traveling to home station...`);
                  const travelResp = await bot.exec("travel", { target_poi: stationId });
                  if (!travelResp.error) {
                    ctx.log("rescue", `⚓ Docking at home station...`);
                    const dockResp = await bot.exec("dock");
                    if (!dockResp.error) {
                      ctx.log("rescue", `✓ Docked at home station`);
                      // Refuel after docking
                      ctx.log("rescue", `⛽ Refueling at home station...`);
                      const refuelResp = await bot.exec("refuel");
                      if (!refuelResp.error) {
                        await bot.refreshStatus();
                        ctx.log("rescue", `✓ Refueled to ${bot.fuel}/${bot.maxFuel} fuel`);
                      }
                    }
                  }
                }
              }
            }
          }
          continue;
        }
      }
    }

    if (hasPump) {
      // Use Refueling Pump for direct refuel
      ctx.log(logCategory, `Initiating fuel transfer to ${target.username} using Refueling Pump...`);

      // Need to get the target's player ID for the refuel command
      const targetPlayerId = await findPlayerId(ctx, target.username);

      if (!targetPlayerId) {
        ctx.log("error", `Could not find player ID for ${target.username} — aborting transfer`);
        await sleep(settings.scanIntervalSec * 1000);
        continue;
      }

      // Issue the refuel command
      const refuelResp = await bot.exec("refuel", { target: targetPlayerId });

      if (refuelResp.error) {
        ctx.log("error", `Refuel command failed: ${refuelResp.error.message}`);
      } else {
        const result = refuelResp.result as Record<string, unknown> | undefined;
        let fuelDelivered = 0;
        if (result) {
          const fuelDelta = result.fuel as number || 0;
          const targetFuelNow = result.target_fuel_now as number || 0;
          fuelDelivered = Math.abs(fuelDelta);
          ctx.log(logCategory, `✓ Transferred ${fuelDelivered} fuel to ${target.username}`);
          ctx.log(logCategory, `  Their fuel: ${targetFuelNow}`);
        }
        ctx.log(logCategory, `Delivery complete for ${target.username}!`);
        
        // Track fuel delivered in session for billing
        if (recoveredSession || getActiveRescueSession(bot.username)) {
          updateRescueSession(bot.username, { fuelDelivered });
        }

        // Skip faction chat here - billing code will send it after delay
        ctx.log("rescue", `Will send faction announcement after billing delay...`);
      }
    } else if (target.docked) {
      // Target is docked — dock at same station and send gift
      ctx.log(logCategory, `${target.username} is docked — docking to send gift...`);
      const dockResp = await bot.exec("dock");
      if (!dockResp.error || dockResp.error.message.includes("already")) {
        bot.docked = true;
        await collectFromStorage(ctx);

        if (hasFuelCells) {
          // Send fuel cells
          await bot.refreshCargo();
          const fuelItem = bot.inventory.find(i =>
            i.itemId.includes("fuel_cell") || i.itemId.includes("fuel") || i.itemId.includes("energy_cell")
          );
          if (fuelItem) {
            ctx.log(logCategory, `Sending ${fuelItem.quantity}x ${fuelItem.name} to ${target.username}...`);
            await bot.exec("send_gift", {
              recipient: target.username,
              item_id: fuelItem.itemId,
              quantity: fuelItem.quantity,
              message: "Emergency fuel delivery from FuelRescue bot!",
            });
            // Track fuel cells delivered (estimate: 10 fuel per cell)
            if (recoveredSession || getActiveRescueSession(bot.username)) {
              updateRescueSession(bot.username, { fuelDelivered: fuelItem.quantity * 10 });
            }
          }
        }

        if (willSendCredits || bot.credits >= settings.rescueCredits) {
          ctx.log(logCategory, `Sending ${settings.rescueCredits} credits to ${target.username}...`);
          await bot.exec("send_gift", {
            recipient: target.username,
            credits: settings.rescueCredits,
            message: "Emergency credits from FuelRescue bot — refuel ASAP!",
          });
        }

        ctx.log(logCategory, `Delivery complete for ${target.username}!`);

        // Skip faction chat here - billing code will send it after delay
        ctx.log("rescue", `Will send faction announcement after billing delay...`);
      }
    } else {
      // Target is in space — jettison fuel cells for them to scavenge
      if (hasFuelCells) {
        await bot.refreshCargo();
        const fuelItem = bot.inventory.find(i =>
          i.itemId.includes("fuel_cell") || i.itemId.includes("fuel") || i.itemId.includes("energy_cell")
        );
        if (fuelItem) {
          ctx.log(logCategory, `Jettisoning ${fuelItem.quantity}x ${fuelItem.name} for ${target.username} to collect...`);
          const jetResp = await bot.exec("jettison", {
            item_id: fuelItem.itemId,
            quantity: fuelItem.quantity,
          });
          if (jetResp.error) {
            ctx.log("error", `Jettison failed: ${jetResp.error.message}`);
          } else {
            ctx.log(logCategory, `Fuel cells jettisoned at ${target.poi || bot.poi} — ${target.username} should scavenge them`);
            // Track fuel cells delivered (estimate: 10 fuel per cell)
            if (recoveredSession || getActiveRescueSession(bot.username)) {
              updateRescueSession(bot.username, { fuelDelivered: fuelItem.quantity * 10 });
            }
          }
        }
      } else {
        // Can't help in space without fuel cells — dock at nearest station and send credits
        ctx.log(logCategory, "No fuel cells to jettison — looking for station to send credits...");
        const { pois } = await getSystemInfo(ctx);
        const station = findStation(pois);
        if (station) {
          ctx.log(logCategory, `Docking at ${station.name} to send credits...`);
          await bot.exec("travel", { target_poi: station.id });
          await bot.exec("dock");
          bot.docked = true;
          await collectFromStorage(ctx);
          if (bot.credits >= settings.rescueCredits) {
            await bot.exec("send_gift", {
              recipient: target.username,
              credits: settings.rescueCredits,
              message: "Emergency credits — dock here to collect and refuel!",
            });
            ctx.log(logCategory, `Sent ${settings.rescueCredits} credits to ${target.username}'s storage at ${station.name}`);
          }
        }
      }
    }

    // ── Send rescue bill IMMEDIATELY after fuel delivery ──
    // Get the active session for billing
    const activeSessionForBill = getActiveRescueSession(bot.username);
    if (activeSessionForBill) {
      const jumpsToTarget = activeSessionForBill.jumpsCompleted || 0;
      const fuelDeliveredBill = activeSessionForBill.fuelDelivered || 0;

      // Calculate bill (we know jumps to target, estimate return jumps as same)
      const bill = calculateRescueBill(
        jumpsToTarget,
        jumpsToTarget,
        fuelDeliveredBill,
        settings
      );

      // Log the bill
      ctx.log("rescue", `💰 RESCUE BILL for ${activeSessionForBill.targetUsername}:`);
      ctx.log("rescue", `   • Jumps: ${jumpsToTarget} there + ${jumpsToTarget} back = ${jumpsToTarget * 2} × ${settings.costPerJump}cr = ${bill.jumpCost}cr`);
      ctx.log("rescue", `   • Fuel: ${fuelDeliveredBill} units × ${settings.costPerFuel}cr = ${bill.fuelCost}cr`);
      ctx.log("rescue", `   • TOTAL: ${bill.total} credits`);

      // Send bill via private message (if total > 0)
      // Note: The bill message includes rescue completion info, so no separate message is needed
      const aiChatService = (globalThis as any).aiChatService;
      if (bill.total > 0) {
        await sendRescueBill(
          ctx,
          activeSessionForBill.targetUsername,
          bill,
          jumpsToTarget,
          jumpsToTarget,
          fuelDeliveredBill,
          activeSessionForBill.isMayday
        );

        // Update session with billing info
        updateRescueSession(bot.username, {
          jumpsCompleted: jumpsToTarget,
          totalJumps: jumpsToTarget * 2,
          fuelDelivered: fuelDeliveredBill,
          creditsSent: bill.total,
          notes: `Billed ${bill.total}cr (${bill.jumpCost}cr jumps + ${bill.fuelCost}cr fuel)`,
        });

        // Record successful rescue in BlackBook
        recordSuccessfulRescue(activeSessionForBill.targetUsername, bill.total);

        // ── Send faction announcement in background (non-blocking) ──
        // This allows immediate return home instead of waiting for cooldown
        const aiChatSettings = aiChatService?.getSettings?.();
        const cooldownSec = aiChatSettings?.conversationCooldownSec || 10;
        ctx.log("rescue", `📢 Faction announcement scheduled for ${cooldownSec}s from now (non-blocking)...`);
        
        setTimeout(async () => {
          if (aiChatService && typeof aiChatService.sendFactionMessage === "function") {
            try {
              const result = await aiChatService.sendFactionMessage(bot, {
                messageType: "rescue_complete",
                targetName: activeSessionForBill.targetUsername,
                isMayday: activeSessionForBill.isMayday,
                isBot: !activeSessionForBill.isMayday,
                currentSystem: bot.system,
                targetSystem: activeSessionForBill.targetSystem,
                targetPoi: activeSessionForBill.targetPoi || undefined,
              });
              if (!result.ok) {
                ctx.log("ai_chat_debug", `Faction announcement (complete) skipped: ${result.error}`);
              }
            } catch (e) {
              ctx.log("warn", `AI faction message (complete) failed: ${e}`);
            }
          }
        }, cooldownSec * 1000);
      } else {
        // No bill to send, but still send faction announcement in background
        const aiChatSettings = aiChatService?.getSettings?.();
        const cooldownSec = aiChatSettings?.conversationCooldownSec || 10;
        ctx.log("rescue", `📢 Faction announcement scheduled for ${cooldownSec}s from now (non-blocking)...`);
        
        setTimeout(async () => {
          if (aiChatService && typeof aiChatService.sendFactionMessage === "function") {
            try {
              const result = await aiChatService.sendFactionMessage(bot, {
                messageType: "rescue_complete",
                targetName: activeSessionForBill.targetUsername,
                isMayday: activeSessionForBill.isMayday,
                isBot: !activeSessionForBill.isMayday,
                currentSystem: bot.system,
                targetSystem: activeSessionForBill.targetSystem,
                targetPoi: activeSessionForBill.targetPoi || undefined,
              });
              if (!result.ok) {
                ctx.log("ai_chat_debug", `Faction announcement (complete) skipped: ${result.error}`);
              }
            } catch (e) {
              ctx.log("warn", `AI faction message (complete) failed: ${e}`);
            }
          }
        }, cooldownSec * 1000);
      }
    }

    // ── Return to home system ──
    if (homeSystem && normalizeSystemName(bot.system) !== normalizeSystemName(homeSystem)) {
      yield "return_home";
      ctx.log(logCategory, `Returning to home system ${homeSystem}...`);
      await ensureUndocked(ctx);
      const safetyOpts = { fuelThresholdPct: settings.refuelThreshold, hullThresholdPct: 30 };
      const arrived = await navigateToSystem(ctx, homeSystem, safetyOpts);
      if (!arrived) {
        ctx.log("error", `Failed to return to home system ${homeSystem}`);
      } else {
        // CRITICAL: Refresh status after navigation to ensure bot.system is updated
        await bot.refreshStatus();
        ctx.log(logCategory, `✓ Arrived at home system ${homeSystem} (confirmed: ${bot.system})`);

        // If home station is configured, travel there and dock
        if (settings.homeStation) {
          const [expectedSystem, stationId] = settings.homeStation.split('|');
          if (expectedSystem === homeSystem && stationId) {
            ctx.log("rescue", `🚀 Traveling to home station (${stationId})...`);
            const travelResp = await bot.exec("travel", { target_poi: stationId });
            if (travelResp.error) {
              ctx.log("error", `❌ Failed to travel to home station: ${travelResp.error.message}`);
            } else {
              ctx.log("rescue", `⚓ Docking at home station...`);
              const dockResp = await bot.exec("dock");
              if (dockResp.error) {
                ctx.log("error", `❌ Failed to dock at home station: ${dockResp.error.message}`);
              } else {
                ctx.log("rescue", `✓ Docked at home station`);
                // Refuel after docking
                ctx.log("rescue", `⛽ Refueling at home station...`);
                const refuelResp = await bot.exec("refuel");
                if (refuelResp.error) {
                  ctx.log("error", `❌ Failed to refuel at home station: ${refuelResp.error.message}`);
                } else {
                  await bot.refreshStatus();
                  ctx.log("rescue", `✓ Refueled to ${bot.fuel}/${bot.maxFuel} fuel`);
                }
              }
            }
          }
        }
      }
      // Update session state for return home
      if (recoveredSession || getActiveRescueSession(bot.username)) {
        updateRescueSession(bot.username, { state: "returning_home" });
      }
    } else if (!homeSystem) {
      ctx.log("warn", "No home system set — skipping return home");
    } else {
      ctx.log(logCategory, `Already at home system ${homeSystem}`);
      
      // If home station is configured and we're in the system but not docked, travel there
      if (settings.homeStation && !bot.docked) {
        const [expectedSystem, stationId] = settings.homeStation.split('|');
        if (expectedSystem === homeSystem && stationId) {
          ctx.log("rescue", `🚀 Traveling to home station...`);
          const travelResp = await bot.exec("travel", { target_poi: stationId });
          if (!travelResp.error) {
            ctx.log("rescue", `⚓ Docking at home station...`);
            const dockResp = await bot.exec("dock");
            if (!dockResp.error) {
              ctx.log("rescue", `✓ Docked at home station`);
              // Refuel after docking
              ctx.log("rescue", `⛽ Refueling at home station...`);
              const refuelResp = await bot.exec("refuel");
              if (!refuelResp.error) {
                await bot.refreshStatus();
                ctx.log("rescue", `✓ Refueled to ${bot.fuel}/${bot.maxFuel} fuel`);
              }
            }
          }
        }
      }
    }

    // ── Refuel self ──
    yield "self_refuel";
    await bot.refreshStatus();
    const fuelAfterRescue2 = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    if (fuelAfterRescue2 < settings.refuelThreshold) {
      ctx.log(logCategory,
        `Fuel at ${fuelAfterRescue2}% after rescue — refueling to threshold (${settings.refuelThreshold}%)...`);
      await ensureFueled(ctx, settings.refuelThreshold);
    } else {
      ctx.log(logCategory,
        `Fuel at ${fuelAfterRescue2}% — above threshold, no need to refuel`);
    }
    await bot.refreshStatus();
    logStatus(ctx);

    // ── Complete the rescue session ──
    if (recoveredSession || getActiveRescueSession(bot.username)) {
      completeRescueSession(bot.username);
      
      // Also mark the queue entry as completed if this was our own bot
      if (isOwnBot(target.username)) {
        const queue = getRescueQueue();
        const queuedRescue = queue.pending.find(r => r.targetUsername === target.username);
        if (queuedRescue) {
          markRescueCompleted(queuedRescue.id);
          ctx.log("rescue", `📋 Marked ${target.username} as completed in rescue queue`);
        }
      }
    }

    if (isMaydayTarget) {
      ctx.log("mayday", `=== MAYDAY response complete for ${target.username} ===`);
    } else {
      ctx.log("rescue", `=== Rescue mission for ${target.username} complete ===`);
    }

    // Reset idle timer after successful rescue
    idleStartTime = 0;
    isReturningIdle = false;

    // Short cooldown before next scan
    await sleep(10000);
  }
};
