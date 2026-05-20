import type { Routine, RoutineContext } from "../bot.js";
import {
  getSystemInfo,
  ensureDocked,
  ensureUndocked,
  navigateToSystem,
  refuelAtStation,
  findStation,
  isStationPoi,
  isApprovedFuelStation,
  ensureFueled,
  readSettings,
  checkAndFleeFromBattle,
  repairShip,
  type BattleState,
  getBattleStatus,
  fleeFromBattle,
} from "./common.js";

// ── Settings ─────────────────────────────────────────────────

/**
 * Get return_home settings for a bot.
 * Per-bot homeSystem/homeStation override global defaults.
 */
function getReturnHomeSettings(username?: string): {
  homeSystem: string;
  homeStation: string;
  refuelThreshold: number;
} {
  const all = readSettings();
  const globalDefaults = all.return_home || {};
  const botOverrides = username ? (all[username] || {}) : {};

  return {
    homeSystem: (botOverrides.homeSystem as string) || (globalDefaults.homeSystem as string) || "sol",
    homeStation: (botOverrides.homeStation as string) || (globalDefaults.homeStation as string) || "",
    refuelThreshold: (botOverrides.refuelThreshold as number) ?? (globalDefaults.refuelThreshold as number) ?? 50,
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

  const routineParams = (bot as unknown as Record<string, unknown>).routineParams as Record<string, unknown> | undefined;
  const ignoreBlacklist = routineParams?.ignoreBlacklist === true;

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
  const refuelThreshold = settings.refuelThreshold;

  if (!homeSystem) {
    ctx.log("error", "No home system configured — cannot return home");
    return; // Cancel routine
  }

  ctx.log("travel", `Return Home initiated — destination: ${homeStation || "any station"} in ${homeSystem}`);

  // Battle check before starting return home
  if (await checkAndFleeFromBattle(ctx, "return_home")) {
    ctx.log("combat", "Cannot return home while in battle — fleeing first");
    return; // Cancel routine
  }

  // Check if already at home
  await bot.refreshStatus();
  if (bot.system === homeSystem) {
    if (homeStation && bot.poi === homeStation) {
      ctx.log("travel", "Already at home station — checking repair status...");
      // Check and repair if needed before leaving
      const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
      if (hullPct < 95) {
        ctx.log("system", `Hull at ${hullPct}% — repairing before departure...`);
        await repairShip(ctx);
      }
      // Refuel if needed before journey
      const fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
      if (fuelPct < refuelThreshold) {
        ctx.log("system", `Fuel at ${fuelPct}% — refueling before departure...`);
        const { pois } = await getSystemInfo(ctx);
        const currentStation = pois.find(p => isStationPoi(p) && p.id === bot.poi && isApprovedFuelStation(p.id, readSettings()));
        if (currentStation) {
          await ensureFueled(ctx, refuelThreshold);
          await ensureDocked(ctx, true);
        } else {
          await ensureFueled(ctx, refuelThreshold);
        }
      }
      ctx.log("travel", "Already at home station — routine complete");
      return; // Cancel routine
    }
    if (!homeStation && bot.docked) {
      ctx.log("travel", "Already docked in home system — checking repair status...");
      // Check and repair if needed before leaving
      const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
      if (hullPct < 95) {
        ctx.log("system", `Hull at ${hullPct}% — repairing before departure...`);
        await repairShip(ctx);
      }
      // Refuel if needed before journey
      const fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
      if (fuelPct < refuelThreshold) {
        ctx.log("system", `Fuel at ${fuelPct}% — refueling before departure...`);
        const { pois } = await getSystemInfo(ctx);
        const currentStation = pois.find(p => isStationPoi(p) && p.id === bot.poi && isApprovedFuelStation(p.id, readSettings()));
        if (currentStation) {
          await ensureFueled(ctx, refuelThreshold);
          await ensureDocked(ctx, true);
        } else {
          await ensureFueled(ctx, refuelThreshold);
        }
      }
      ctx.log("travel", "Already docked in home system — routine complete");
      return; // Cancel routine
    }
  }

  // Check if at any station (not necessarily home) - repair and refuel before long journey
  if (bot.docked) {
    const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    if (hullPct < 95) {
      ctx.log("system", `Hull at ${hullPct}% — repairing before return journey...`);
      await repairShip(ctx);
    }
    const fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    if (fuelPct < refuelThreshold) {
      ctx.log("system", `Fuel at ${fuelPct}% — refueling before return journey...`);
      const { pois } = await getSystemInfo(ctx);
      const currentStation = pois.find(p => isStationPoi(p) && p.id === bot.poi && isApprovedFuelStation(p.id, readSettings()));
      if (currentStation) {
        await ensureFueled(ctx, refuelThreshold);
        await ensureDocked(ctx, true);
      } else {
        await ensureFueled(ctx, refuelThreshold);
      }
    }
  }

  // Ensure fueled before journey — use exact route fuel estimate
  yield "fuel_check";
  const fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
  let needsRefuel = fuelPct < refuelThreshold;
  try {
    const routeResp = await bot.exec("find_route", { target_system: homeSystem, target_poi: homeStation || undefined });
    if (!routeResp.error && routeResp.result && typeof routeResp.result === "object") {
      const r = routeResp.result as any;
      const est = r.estimated_fuel ?? 0;
      const avail = r.fuel_available ?? bot.fuel;
      if (avail >= est) {
        needsRefuel = false;
        ctx.log("system", `Route fuel check: ${avail} available >= ${est} needed — no refuel required`);
      } else {
        ctx.log("system", `Route needs ${est - avail} more fuel — will refuel`);
      }
    }
  } catch {}
  if (needsRefuel) {
    ctx.log("system", `Fuel low (${fuelPct}%) — refueling before journey...`);
    
    // Try to refuel at current location if docked
    if (bot.docked) {
      const { pois } = await getSystemInfo(ctx);
      const currentStation = pois.find(p => isStationPoi(p) && p.id === bot.poi && isApprovedFuelStation(p.id, readSettings()));
      if (currentStation) {
        const ok = await ensureFueled(ctx, refuelThreshold);
        if (!ok) {
          ctx.log("warn", "Refuel failed (station empty?) — proceeding with current fuel for return trip");
        } else {
          await ensureDocked(ctx, true);
        }
      } else {
        // Not at approved station — use cargo cells directly
        await ensureFueled(ctx, refuelThreshold);
      }
    } else {
      // Dock only at approved fuel station or use cargo cells
      await ensureFueled(ctx, refuelThreshold);
    }
  }

  // Navigate to home system with retry logic for API timeouts
  yield "navigate";
  if (bot.system !== homeSystem) {
    ctx.log("travel", `Navigating to ${homeSystem}...`);

    // Pre-navigation battle check
    if (await checkAndFleeFromBattle(ctx, "return_home")) {
      ctx.log("error", "Battle detected before navigation - cannot continue");
      return; // Cancel routine
    }

    const MAX_NAV_ATTEMPTS = 3;
    let navAttempts = 0;
    // Final battle check before navigation
    if (await checkAndFleeFromBattle(ctx, "return_home")) {
      ctx.log("combat", "Cannot navigate while in battle — fleeing first");
      return; // Cancel routine
    }

    let arrived = false;

    while (navAttempts < MAX_NAV_ATTEMPTS && bot.state === "running") {
      navAttempts++;
      try {
        arrived = await navigateToSystem(ctx, homeSystem, {
          fuelThresholdPct: refuelThreshold,
          hullThresholdPct: 40,
          skipBlacklist: ignoreBlacklist,
        });

        if (arrived) {
          ctx.log("travel", `Arrived in ${homeSystem}`);
          break;
        }

        // Navigation returned false - check if it was a timeout error
        ctx.log("warn", `Navigation attempt ${navAttempts}/${MAX_NAV_ATTEMPTS} failed`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const isTimeout = msg.includes("524") || msg.includes("timeout") || msg.includes("Timeout");

        ctx.log("error", `Navigation error (attempt ${navAttempts}/${MAX_NAV_ATTEMPTS}): ${msg}`);

        if (!isTimeout) {
          // Non-timeout error - don't retry
          ctx.log("error", `Failed to reach ${homeSystem} — routine cancelled`);
          return;
        }

        // Timeout error - wait and retry
        if (navAttempts < MAX_NAV_ATTEMPTS) {
          const waitTime = 10000 * navAttempts; // 10s, 20s, 30s
          ctx.log("travel", `API timeout detected - waiting ${waitTime/1000}s before retry...`);
          await ctx.sleep(waitTime);
          await bot.refreshStatus();
        }
      }
    }

    if (!arrived) {
      ctx.log("error", `Failed to reach ${homeSystem} after ${MAX_NAV_ATTEMPTS} attempts — routine cancelled`);
      return; // Cancel routine
    }
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
    // Verify travel succeeded by checking position
    await bot.refreshStatus();
    if (bot.poi !== targetStation.id) {
      ctx.log("error", `Travel to station failed: not at target ${targetStation.id} (currently at ${bot.poi})`);
      return; // Cancel routine
    }
  }

  // Dock at station (skip storage collection - return home doesn't need to manage items)
  // Refresh status first to ensure bot.docked is current before calling ensureDocked
  yield "dock";
  await bot.refreshStatus();
  const docked = await ensureDocked(ctx, true);
  if (!docked) {
    ctx.log("error", "Failed to dock at home station — routine cancelled");
    return; // Cancel routine
  }

  // After docking at home, repair and refuel if needed
  await bot.refreshStatus();
  const dockedHullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
  if (dockedHullPct < 95) {
    ctx.log("system", `Hull at ${dockedHullPct}% — repairing at home station...`);
    await repairShip(ctx);
  }
    const dockedFuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
  if (dockedFuelPct < refuelThreshold) {
    ctx.log("system", `Fuel at ${dockedFuelPct}% — refueling at home station...`);
    const { pois } = await getSystemInfo(ctx);
    const currentStation = pois.find(p => isStationPoi(p) && p.id === bot.poi && isApprovedFuelStation(p.id, readSettings()));
    if (currentStation) {
      await ensureFueled(ctx, refuelThreshold);
      await ensureDocked(ctx, true);
    } else {
      await ensureFueled(ctx, refuelThreshold);
    }
  }

  // Final status
  await bot.refreshStatus();
  ctx.log("travel", `Return Home complete — docked at ${targetStation.name} in ${homeSystem}`);
  ctx.log("info", `Bot status: ${bot.credits} credits, ${bot.fuel}/${bot.maxFuel} fuel, ${bot.hull}/${bot.maxHull} hull`);

  // Routine complete — return to cancel it (no loop)
  return;
};
