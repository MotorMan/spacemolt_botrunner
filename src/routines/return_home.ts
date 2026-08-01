import type { Routine, RoutineContext } from "../bot.js";
import { isConnectionError } from "../connection.js";
import {
  getSystemInfo,
  ensureDocked,
  navigateToSystem,
  findStation,
  isStationPoi,
  isApprovedFuelStation,
  ensureFueled,
  readSettings,
  checkAndFleeFromBattle,
  repairShip,
  waitForTransitCompletion,
} from "./common.js";

async function hasCloakingModule(ctx: RoutineContext, cachedModules?: unknown[]): Promise<boolean> {
  const { bot } = ctx;
  let modules: unknown[];

  if (cachedModules && cachedModules.length > 0) {
    modules = cachedModules;
  } else {
    const shipResp = await bot.exec("get_ship");
    if (shipResp.error || !shipResp.result) return false;
    const shipData = shipResp.result as Record<string, unknown>;
    modules = Array.isArray(shipData.modules) ? shipData.modules : [];
  }

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

async function enableCloakingIfPossible(ctx: RoutineContext, cachedModules?: unknown[]): Promise<boolean> {
  const { bot } = ctx;

  if (bot.isCloaked) {
    ctx.log("travel", "Bot is already cloaked - no action needed");
    return true;
  }

  const hasCloak = await hasCloakingModule(ctx, cachedModules);
  if (!hasCloak) {
    ctx.log("travel", "No cloaking module detected - cannot enable cloak");
    return false;
  }

  ctx.log("travel", "Enabling cloaking module for return journey...");
  const resp = await bot.exec("cloak", { enable: true });
  if (resp.error) {
    const msg = resp.error.message.toLowerCase();
    if (!msg.includes("already cloaked") && !msg.includes("already_cloaked")) {
      ctx.log("warn", `Failed to enable cloak: ${resp.error.message}`);
    }
    return false;
  }

  ctx.log("travel", "Cloaking enabled successfully");
  return true;
}

// ── Settings ─────────────────────────────────────────────────

/**
 * Get return_home settings for a bot.
 * Per-bot homeSystem/homeStation override global defaults.
 */
function getReturnHomeSettings(username?: string): {
  homeSystem: string;
  homeStation: string;
  refuelThreshold: number;
  enableCloak: boolean;
  decloakBeforeDock: boolean;
  ignoreBlacklist: boolean;
} {
  const all = readSettings();
  const globalDefaults = all.return_home || {};
  const botOverrides = username ? (all[username] || {}) : {};

  return {
    homeSystem: (botOverrides.homeSystem as string) || (globalDefaults.homeSystem as string) || "sol",
    homeStation: (botOverrides.homeStation as string) || (globalDefaults.homeStation as string) || "",
    refuelThreshold: (botOverrides.refuelThreshold as number) ?? (globalDefaults.refuelThreshold as number) ?? 50,
    enableCloak: (botOverrides.enableCloak as boolean) ?? (globalDefaults.enableCloak as boolean) ?? true,
    decloakBeforeDock: (botOverrides.decloakBeforeDock as boolean) ?? (globalDefaults.decloakBeforeDock as boolean) ?? false,
    ignoreBlacklist: (botOverrides.ignoreBlacklist as boolean) ?? (globalDefaults.ignoreBlacklist as boolean) ?? false,
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

  // Wait for any pending action from previous routine to clear
  // This is especially important for emergency return home scenarios
  yield "wait_idle";
  let waitAttempts = 0;
  while (waitAttempts < 5) {
    ctx.log("system", "Checking if ready to start (attempt " + (waitAttempts + 1) + "/5)...");
    try {
      await bot.refreshLocation();
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

  // Check for ongoing transit (jump/travel) before starting
  yield "check_transit";
  await bot.refreshPOI();
  if (bot.inTransit) {
    ctx.log("travel", `Bot is already in transit (${bot.transitType}) - waiting for completion before return home`);
    const transitCompleted = await waitForTransitCompletion(ctx, 180);
    if (!transitCompleted) {
      ctx.log("error", "Transit did not complete within timeout - cannot start return home");
      return; // Cancel routine
    }
    // Refresh location after transit completes
    await bot.refreshLocation();
  }

  // Read settings
  const settings = getReturnHomeSettings(bot.username);
  const homeSystem = settings.homeSystem;
  const homeStation = settings.homeStation;
  const refuelThreshold = settings.refuelThreshold;
  const enableCloak = settings.enableCloak;
  const decloakBeforeDock = settings.decloakBeforeDock;
  const ignoreBlacklist = routineParams?.ignoreBlacklist === true || settings.ignoreBlacklist === true;

  if (!homeSystem) {
    ctx.log("error", "No home system configured — cannot return home");
    return; // Cancel routine
  }

  ctx.log("travel", `Return Home initiated — destination: ${homeStation || "any station"} in ${homeSystem}`);

  // If already at the destination, handle cloak/dock BEFORE re-enabling cloak
  await bot.refreshLocation();
  if (bot.system === homeSystem) {
    if (homeStation && bot.poi === homeStation) {
      if (bot.isCloaked && decloakBeforeDock) {
        ctx.log("travel", "Already at home station but cloaked — decloaking before docking...");
        const decloakResp = await bot.exec("cloak", { enable: false });
        if (decloakResp.error) {
          ctx.log("warn", `Failed to decloak before docking: ${decloakResp.error.message}`);
        } else {
          ctx.log("travel", "Decloaked successfully before docking");
        }
      }
      if (!bot.docked) {
        ctx.log("travel", "At home station but not docked — docking now...");
        const docked = await ensureDocked(ctx, true);
        if (!docked) {
          ctx.log("error", "Failed to dock at home station — routine cancelled");
          return;
        }
      }
      ctx.log("travel", "Already at home station — routine complete");
      return;
    }
    if (!homeStation && bot.docked) {
      ctx.log("travel", "Already docked in home system — routine complete");
      return;
    }
  }

  // Enable cloaking if configured and module is available
  let isCloaked = bot.isCloaked;
  if (enableCloak && !isCloaked) {
    isCloaked = await enableCloakingIfPossible(ctx);
  }

  // Battle check before starting return home
  if (await checkAndFleeFromBattle(ctx, "return_home")) {
    ctx.log("combat", "Cannot return home while in battle — fleeing first");
    return; // Cancel routine
  }

  // Check if already at home
  await bot.refreshLocation();
  if (bot.system === homeSystem) {
    if (homeStation && bot.poi === homeStation) {
      ctx.log("travel", "Already at home station — checking dock/repair status...");
      // The bot can be at the station POI but not docked (idle in orbit).
      // If so, dock it before treating the routine as complete.
      if (!bot.docked) {
        ctx.log("travel", "At home station but not docked — docking now...");
        const docked = await ensureDocked(ctx, true);
        if (!docked) {
          ctx.log("error", "Failed to dock at home station — routine cancelled");
          return; // Cancel routine
        }
      }
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
        const currentStation = pois.find(p => isStationPoi(p) && p.id === bot.poi && isApprovedFuelStation(p.id, readSettings(), bot.system));
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
        const currentStation = pois.find(p => isStationPoi(p) && p.id === bot.poi && isApprovedFuelStation(p.id, readSettings(), bot.system));
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
      const currentStation = pois.find(p => isStationPoi(p) && p.id === bot.poi && isApprovedFuelStation(p.id, readSettings(), bot.system));
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
    const routeResp = await bot.exec("find_route", { target_system: homeSystem });
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
      const currentStation = pois.find(p => isStationPoi(p) && p.id === bot.poi && isApprovedFuelStation(p.id, readSettings(), bot.system));
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
          skipBlacklist: ignoreBlacklist && isCloaked,
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
        // A dropped socket (server restart / network blip) is never fatal — the
        // dispatch layer pauses and resends, but if a connection error still
        // surfaces here we retry the same as a timeout instead of cancelling.
        const isConnectionLoss = isConnectionError(msg);

        ctx.log("error", `Navigation error (attempt ${navAttempts}/${MAX_NAV_ATTEMPTS}): ${msg}`);

        if (!isTimeout && !isConnectionLoss) {
          // Non-timeout, non-connection error - don't retry
          ctx.log("error", `Failed to reach ${homeSystem} — routine cancelled`);
          return;
        }

// Timeout error - wait and retry
         if (navAttempts < MAX_NAV_ATTEMPTS) {
           const waitTime = 10000 * navAttempts; // 10s, 20s, 30s
           ctx.log("travel", `API timeout detected - waiting ${waitTime/1000}s before retry...`);
           await ctx.sleep(waitTime);
           await bot.refreshLocation();
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
    await bot.refreshLocation();
    if (bot.poi !== targetStation.id) {
      ctx.log("error", `Travel to station failed: not at target ${targetStation.id} (currently at ${bot.poi})`);
      return; // Cancel routine
    }
  }

  // Decloak before docking if configured
  if (decloakBeforeDock && bot.isCloaked) {
    ctx.log("travel", "Decloaking before docking at destination station...");
    const decloakResp = await bot.exec("cloak", { enable: false });
    if (decloakResp.error) {
      ctx.log("warn", `Failed to decloak before docking: ${decloakResp.error.message}`);
    } else {
      ctx.log("travel", "Decloaked successfully before docking");
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
  await bot.refreshShip();
  const dockedHullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
  if (dockedHullPct < 95) {
    ctx.log("system", `Hull at ${dockedHullPct}% — repairing at home station...`);
    await repairShip(ctx);
  }
    const dockedFuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
  if (dockedFuelPct < refuelThreshold) {
    ctx.log("system", `Fuel at ${dockedFuelPct}% — refueling at home station...`);
    const { pois } = await getSystemInfo(ctx);
    const currentStation = pois.find(p => isStationPoi(p) && p.id === bot.poi && isApprovedFuelStation(p.id, readSettings(), bot.system));
    if (currentStation) {
      await ensureFueled(ctx, refuelThreshold);
      await ensureDocked(ctx, true);
    } else {
      await ensureFueled(ctx, refuelThreshold);
    }
  }

  // Double-check: verify the bot is actually docked before ending the routine.
  // If not docked (e.g. dock call silently failed or bot got undocked), actually dock.
  await bot.refreshLocation();
  if (!bot.docked) {
    ctx.log("warn", "Double-check: bot is not docked after routine — re-attempting dock...");
    const MAX_DOCK_CHECK_ATTEMPTS = 3;
    let docked = false;
    for (let dockAttempt = 1; dockAttempt <= MAX_DOCK_CHECK_ATTEMPTS && !docked; dockAttempt++) {
      ctx.log("system", `Dock double-check attempt ${dockAttempt}/${MAX_DOCK_CHECK_ATTEMPTS}...`);
      docked = await ensureDocked(ctx, true);
      if (!docked) {
        await bot.refreshLocation();
        if (bot.docked) {
          docked = true;
          break;
        }
        if (dockAttempt < MAX_DOCK_CHECK_ATTEMPTS) {
          await ctx.sleep(3000);
        }
      }
    }
    if (!docked) {
      ctx.log("error", "Double-check failed: bot could not be docked at home station — routine cancelled");
      return; // Cancel routine
    }

    // After successful re-dock, ensure repair/refuel completed
    await bot.refreshShip();
    const reDockedHullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    if (reDockedHullPct < 95) {
      ctx.log("system", `Hull at ${reDockedHullPct}% — repairing after re-dock...`);
      await repairShip(ctx);
    }
    const reDockedFuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    if (reDockedFuelPct < refuelThreshold) {
      ctx.log("system", `Fuel at ${reDockedFuelPct}% — refueling after re-dock...`);
      await ensureFueled(ctx, refuelThreshold);
      await ensureDocked(ctx, true);
    }
  }

  // Final status
  await bot.refreshLocation();
  ctx.log("travel", `Return Home complete — docked at ${bot.poi} in ${homeSystem}`);
  ctx.log("info", `Bot status: ${bot.credits} credits, ${bot.fuel}/${bot.maxFuel} fuel, ${bot.hull}/${bot.maxHull} hull`);

  // Routine complete — return to cancel it (no loop)
  return;
};
