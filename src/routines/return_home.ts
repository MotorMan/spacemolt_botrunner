import type { Routine, RoutineContext } from "../bot.js";
import {
  getSystemInfo,
  ensureDocked,
  ensureUndocked,
  navigateToSystem,
  refuelAtStation,
  findStation,
  isStationPoi,
  readSettings,
  sleep,
} from "./common.js";

// ── Settings ─────────────────────────────────────────────────

/**
 * Get return_home settings for a bot.
 * Per-bot homeSystem/homeStation override global defaults.
 */
function getReturnHomeSettings(username?: string): {
  homeSystem: string;
  homeStation: string;
} {
  const all = readSettings();
  const globalDefaults = all.return_home || {};
  const botOverrides = username ? (all[username] || {}) : {};

  return {
    homeSystem: (botOverrides.homeSystem as string) || (globalDefaults.homeSystem as string) || "sol",
    homeStation: (botOverrides.homeStation as string) || (globalDefaults.homeStation as string) || "",
  };
}

// ── Return Home routine ──────────────────────────────────────

/**
 * Return Home routine — navigates the bot back to its configured home base.
 * 
 * Flow:
 * 1. Read home system/station from settings (per-bot override > global default)
 * 2. If already at home station, log and exit
 * 3. Ensure fueled for the journey
 * 4. Navigate to home system via jump chain
 * 5. Travel to home station POI and dock
 * 6. Cancel the routine (return, don't loop)
 */
export const returnHomeRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  // Wait for any pending action from previous routine to clear
  // This is especially important for emergency return home scenarios
  yield "wait_idle";
  let waitAttempts = 0;
  while (waitAttempts < 5) {
    ctx.log("system", "Checking if ready to start (attempt " + (waitAttempts + 1) + "/5)...");
    try {
      await bot.refreshStatus();
      break; // Success — no pending action
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("action is already pending") || msg.includes("action_pending")) {
        ctx.log("system", "Previous action still pending — waiting 2s...");
        await new Promise(r => setTimeout(r, 2000));
        waitAttempts++;
      } else {
        // Other error — break and try to continue
        break;
      }
    }
  }

  // Read settings
  const settings = getReturnHomeSettings(bot.username);
  const homeSystem = settings.homeSystem;
  const homeStation = settings.homeStation;

  if (!homeSystem) {
    ctx.log("error", "No home system configured — cannot return home");
    return; // Cancel routine
  }

  ctx.log("travel", `Return Home initiated — destination: ${homeStation || "any station"} in ${homeSystem}`);

  // Check if already at home
  await bot.refreshStatus();
  if (bot.system === homeSystem) {
    if (homeStation && bot.poi === homeStation) {
      ctx.log("travel", "Already at home station — routine complete");
      return; // Cancel routine
    }
    if (!homeStation && bot.docked) {
      ctx.log("travel", "Already docked in home system — routine complete");
      return; // Cancel routine
    }
  }

  // Ensure fueled before journey
  yield "fuel_check";
  const fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
  if (fuelPct < 50) {
    ctx.log("system", `Fuel low (${fuelPct}%) — refueling before journey...`);
    
    // Try to refuel at current location if docked
    if (bot.docked) {
      const { pois } = await getSystemInfo(ctx);
      const currentStation = pois.find(p => isStationPoi(p) && p.id === bot.poi);
      if (currentStation) {
        const ok = await refuelAtStation(ctx, currentStation, 50);
        if (!ok) {
          ctx.log("error", "Failed to refuel at current station — cannot continue");
          return; // Cancel routine
        }
      }
    } else {
      // Need to dock first to refuel (skip storage collection - just need fuel)
      const docked = await ensureDocked(ctx, true);
      if (!docked) {
        ctx.log("error", "Cannot dock to refuel — aborting return home");
        return; // Cancel routine
      }
      await bot.refreshStatus();
      const refuelResp = await bot.exec("refuel");
      if (refuelResp.error) {
        ctx.log("error", `Refuel failed: ${refuelResp.error.message}`);
        // Try to continue anyway if we have some fuel
        const stillLow = bot.maxFuel > 0 ? (bot.fuel / bot.maxFuel) * 100 < 20 : true;
        if (stillLow) {
          ctx.log("error", "Fuel too low to continue — aborting");
          return; // Cancel routine
        }
      }
      await ensureUndocked(ctx);
    }
  }

  // Navigate to home system
  yield "navigate";
  if (bot.system !== homeSystem) {
    ctx.log("travel", `Navigating to ${homeSystem}...`);
    const arrived = await navigateToSystem(ctx, homeSystem, {
      fuelThresholdPct: 30,
      hullThresholdPct: 40,
    });

    if (!arrived) {
      ctx.log("error", `Failed to reach ${homeSystem} — routine cancelled`);
      return; // Cancel routine
    }

    ctx.log("travel", `Arrived in ${homeSystem}`);
  }

  // Find and travel to home station
  yield "find_station";
  const { pois } = await getSystemInfo(ctx);
  
  let targetStation = null;
  
  if (homeStation) {
    // Look for specific home station
    targetStation = pois.find(p => p.id === homeStation && isStationPoi(p));
    if (!targetStation) {
      ctx.log("error", `Home station "${homeStation}" not found in ${homeSystem} — finding alternative`);
    }
  }

  // Fallback: any station in the system
  if (!targetStation) {
    targetStation = findStation(pois);
  }

  if (!targetStation) {
    ctx.log("error", `No station found in ${homeSystem} — routine cancelled`);
    return; // Cancel routine
  }

  // Travel to station
  yield "travel_to_station";
  if (bot.poi !== targetStation.id) {
    ctx.log("travel", `Traveling to ${targetStation.name}...`);
    const travelResp = await bot.exec("travel", { target_poi: targetStation.id });
    if (travelResp.error && !travelResp.error.message.includes("already")) {
      ctx.log("error", `Travel to station failed: ${travelResp.error.message}`);
      return; // Cancel routine
    }
    bot.poi = targetStation.id;
  }

  // Dock at station (skip storage collection - return home doesn't need to manage items)
  yield "dock";
  const docked = await ensureDocked(ctx, true);
  if (!docked) {
    ctx.log("error", "Failed to dock at home station — routine cancelled");
    return; // Cancel routine
  }

  // Final status
  await bot.refreshStatus();
  ctx.log("travel", `Return Home complete — docked at ${targetStation.name} in ${homeSystem}`);
  ctx.log("info", `Bot status: ${bot.credits} credits, ${bot.fuel}/${bot.maxFuel} fuel, ${bot.hull}/${bot.maxHull} hull`);

  // Routine complete — return to cancel it (no loop)
  return;
};
