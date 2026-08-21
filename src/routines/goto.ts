import type { Routine, RoutineContext } from "../bot.js";
import { isConnectionError } from "../connection.js";
import {
  getSystemInfo,
  ensureDocked,
  navigateToSystem,
  findStation,
  isStationPoi,
  isUsableFuelStation,
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
    // Cloaking always undocks the ship — keep the local flag in sync.
    bot.docked = false;
    return true;
  }

  const hasCloak = await hasCloakingModule(ctx, cachedModules);
  if (!hasCloak) {
    ctx.log("travel", "No cloaking module detected - cannot enable cloak");
    return false;
  }

  ctx.log("travel", "Enabling cloaking module for journey...");
  const resp = await bot.exec("cloak", { enable: true });
  if (resp.error) {
    const msg = resp.error.message.toLowerCase();
    if (!msg.includes("already cloaked") && !msg.includes("already_cloaked")) {
      ctx.log("warn", `Failed to enable cloak: ${resp.error.message}`);
      return false;
    }
    // Server reports we're already cloaked — treat as success and sync state.
    bot.isCloaked = true;
    bot.docked = false;
    return true;
  }

  // Cloaking always undocks the ship — clear the stale docked flag so a later
  // ensureDocked() actually re-docks instead of believing we're still docked.
  bot.isCloaked = true;
  bot.docked = false;
  ctx.log("travel", "Cloaking enabled successfully");
  return true;
}

/**
 * Decloak (if currently cloaked) and wait for the cloak mutation to fully
 * resolve before returning. Cloaking/decloaking is a server mutation that takes
 * one tick to apply; issuing `dock` immediately after `decloak` is rejected with
 * "action is already pending", and the local `docked` flag is stale (decloaking
 * undocks the ship). We refresh status and poll until the cloak state settles so
 * the caller's subsequent dock decision / dock command is accurate.
 */
async function decloakAndSettle(ctx: RoutineContext): Promise<boolean> {
  const { bot } = ctx;
  if (!bot.isCloaked) return true;

  ctx.log("travel", "Decloaking before docking at destination...");
  const resp = await bot.exec("cloak", { enable: false });
  if (resp.error) {
    const msg = resp.error.message.toLowerCase();
    if (!msg.includes("already") && !msg.includes("cloaked")) {
      ctx.log("warn", `Failed to decloak: ${resp.error.message}`);
      return false;
    }
  }

  // Wait for the 1-tick decloak mutation to resolve, refreshing so the local
  // isCloaked/docked flags reflect reality before the caller issues dock.
  for (let attempt = 0; attempt < 3; attempt++) {
    await ctx.sleep(2000);
    await bot.refreshStatus();
    if (!bot.isCloaked) break;
  }
  // Decloaking undocks the ship — clear the stale flag so ensureDocked() re-docks.
  bot.docked = false;
  return true;
}

// ── Settings ─────────────────────────────────────────────────

/**
 * Get GoTo settings for a bot.
 * Per-bot destinationSystem/destinationPoi override global defaults.
 *
 * GoTo is a generalized copy of Return Home: instead of always going home, the
 * destination is a configurable system + POI. If the chosen POI is a station the
 * bot docks (when dockIfStation is true); otherwise it just travels to the POI
 * (e.g. an ore belt / gas cloud) without docking. Leaving destinationPoi empty
 * means "any station in the destination system".
 */
function getGoToSettings(username?: string): {
  destinationSystem: string;
  destinationPoi: string;
  refuelThreshold: number;
  enableCloak: boolean;
  decloakBeforeDock: boolean;
  ignoreBlacklist: boolean;
  dockIfStation: boolean;
} {
  const all = readSettings();
  const globalDefaults = all.goto || {};
  const botOverrides = username ? (all[username] || {}) : {};

  return {
    destinationSystem: (botOverrides.destinationSystem as string) || (globalDefaults.destinationSystem as string) || "",
    destinationPoi: (botOverrides.destinationPoi as string) || (globalDefaults.destinationPoi as string) || "",
    refuelThreshold: (botOverrides.refuelThreshold as number) ?? (globalDefaults.refuelThreshold as number) ?? 50,
    enableCloak: (botOverrides.enableCloak as boolean) ?? (globalDefaults.enableCloak as boolean) ?? true,
    decloakBeforeDock: (botOverrides.decloakBeforeDock as boolean) ?? (globalDefaults.decloakBeforeDock as boolean) ?? false,
    ignoreBlacklist: (botOverrides.ignoreBlacklist as boolean) ?? (globalDefaults.ignoreBlacklist as boolean) ?? false,
    dockIfStation: (botOverrides.dockIfStation as boolean) ?? (globalDefaults.dockIfStation as boolean) ?? true,
  };
}

// ── GoTo routine ─────────────────────────────────────────────

/**
 * GoTo routine — navigates the bot to a configurable destination
 * (system + POI), reusing all of Return Home's safety/protections.
 *
 * Flow:
 * 1. Read destination system/POI from settings (per-bot override > global default)
 * 2. If already at the destination POI, log and exit
 * 3. Ensure fueled for the journey
 * 4. Navigate to destination system via jump chain
 * 5. Travel to the destination POI (dock if it's a station and dockIfStation)
 * 6. Cancel the routine (return, don't loop)
 */
export const goToRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  const routineParams = (bot as unknown as Record<string, unknown>).routineParams as Record<string, unknown> | undefined;

  // Wait for any pending action from previous routine to clear
  // This is especially important for emergency go-to scenarios
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
    ctx.log("travel", `Bot is already in transit (${bot.transitType}) - waiting for completion before GoTo`);
    const transitCompleted = await waitForTransitCompletion(ctx, 180);
    if (!transitCompleted) {
      ctx.log("error", "Transit did not complete within timeout - cannot start GoTo");
      return; // Cancel routine
    }
    // Refresh location after transit completes
    await bot.refreshLocation();
  }

  // Read settings
  const settings = getGoToSettings(bot.username);
  const destinationSystem = settings.destinationSystem;
  const destinationPoi = settings.destinationPoi;
  const refuelThreshold = settings.refuelThreshold;
  const enableCloak = settings.enableCloak;
  const decloakBeforeDock = settings.decloakBeforeDock;
  const ignoreBlacklist = routineParams?.ignoreBlacklist === true || settings.ignoreBlacklist === true;
  const dockIfStation = settings.dockIfStation;

  if (!destinationSystem) {
    ctx.log("error", "No destination system configured — cannot GoTo");
    return; // Cancel routine
  }

  const destLabel = destinationPoi ? destinationPoi : "any station";
  ctx.log("travel", `GoTo initiated — destination: ${destLabel} in ${destinationSystem}`);

  // Determine whether the destination POI is a dockable station.
  // Only computed after we have system POIs, but we can reason about the
  // "already there" fast-path using current location first.
  const destIsStation = await (async (): Promise<boolean> => {
    if (!destinationPoi) return true; // empty POI = a station in the system
    const { pois } = await getSystemInfo(ctx);
    const poi = pois.find(p => p.id === destinationPoi);
    return !!poi && isStationPoi(poi);
  })();

  // If already at the destination, handle cloak/dock BEFORE re-enabling cloak
  await bot.refreshStatus();
  if (bot.system === destinationSystem) {
    const atDestPoi = destinationPoi ? bot.poi === destinationPoi : (destIsStation ? bot.docked : bot.poi === destinationPoi || !!bot.poi);
    if (atDestPoi) {
      if (destIsStation && dockIfStation && bot.isCloaked && decloakBeforeDock) {
        await decloakAndSettle(ctx);
      }
      if (destIsStation && dockIfStation && !bot.docked) {
        ctx.log("travel", "At destination station but not docked — docking now...");
        const docked = await ensureDocked(ctx, true, 0, { targetStationId: destinationPoi || undefined });
        if (!docked) {
          ctx.log("error", "Failed to dock at destination — routine cancelled");
          return;
        }
      }
      ctx.log("travel", "Already at destination — routine complete");
      return;
    }
    if (!destinationPoi && bot.docked) {
      ctx.log("travel", "Already docked in destination system — routine complete");
      return;
    }
  }

  // Enable cloaking if configured and module is available
  let isCloaked = bot.isCloaked;
  if (enableCloak && !isCloaked) {
    isCloaked = await enableCloakingIfPossible(ctx);
  }

  // Battle check before starting journey
  if (await checkAndFleeFromBattle(ctx, "goto")) {
    ctx.log("combat", "Cannot GoTo while in battle — fleeing first");
    return; // Cancel routine
  }

  // Check if already at destination
  await bot.refreshStatus();
  if (bot.system === destinationSystem) {
    const atDestPoi = destinationPoi ? bot.poi === destinationPoi : (destIsStation ? bot.docked : bot.poi === destinationPoi || !!bot.poi);
    if (atDestPoi) {
      ctx.log("travel", "Already at destination — checking dock/repair status...");
      if (destIsStation && dockIfStation) {
        // The bot can be at the station POI but not docked (idle in orbit).
        // If so, dock it before treating the routine as complete.
        if (!bot.docked) {
          ctx.log("travel", "At destination station but not docked — docking now...");
          const docked = await ensureDocked(ctx, true, 0, { targetStationId: destinationPoi || undefined });
          if (!docked) {
            ctx.log("error", "Failed to dock at destination — routine cancelled");
            return; // Cancel routine
          }
        }
        // Check and repair if needed
        const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
        if (hullPct < 95) {
          ctx.log("system", `Hull at ${hullPct}% — repairing...`);
          await repairShip(ctx);
        }
        // Refuel if needed
        const fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
        if (fuelPct < refuelThreshold) {
          ctx.log("system", `Fuel at ${fuelPct}% — refueling...`);
          const { pois } = await getSystemInfo(ctx);
          const currentStation = pois.find(p => isStationPoi(p) && p.id === bot.poi && isUsableFuelStation(p.id, readSettings(), bot.system));
          if (currentStation) {
            await ensureFueled(ctx, refuelThreshold);
            await ensureDocked(ctx, true);
          } else {
            await ensureFueled(ctx, refuelThreshold);
          }
        }
      }
      ctx.log("travel", "Already at destination — routine complete");
      return; // Cancel routine
    }
    if (!destinationPoi && bot.docked) {
      ctx.log("travel", "Already docked in destination system — routine complete");
      return; // Cancel routine
    }
  }

  // Check if at any station (not necessarily destination) - repair and refuel before long journey
  if (bot.docked) {
    const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    if (hullPct < 95) {
      ctx.log("system", `Hull at ${hullPct}% — repairing before journey...`);
      await repairShip(ctx);
    }
    const fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    if (fuelPct < refuelThreshold) {
      ctx.log("system", `Fuel at ${fuelPct}% — refueling before journey...`);
      const { pois } = await getSystemInfo(ctx);
      const currentStation = pois.find(p => isStationPoi(p) && p.id === bot.poi && isUsableFuelStation(p.id, readSettings(), bot.system));
      if (currentStation) {
       await ensureFueled(ctx, refuelThreshold);
       await ensureDocked(ctx, true, 0, { targetStationId: destinationPoi || undefined });
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
    const routeResp = await bot.exec("find_route", { target_system: destinationSystem });
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
      const currentStation = pois.find(p => isStationPoi(p) && p.id === bot.poi && isUsableFuelStation(p.id, readSettings(), bot.system));
      if (currentStation) {
        const ok = await ensureFueled(ctx, refuelThreshold);
        if (!ok) {
          ctx.log("warn", "Refuel failed (station empty?) — proceeding with current fuel for trip");
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

  // Navigate to destination system with retry logic for API timeouts
  yield "navigate";
  await bot.refreshStatus();
  if (bot.system !== destinationSystem) {
    ctx.log("travel", `Navigating to ${destinationSystem}...`);

    // Pre-navigation battle check
    if (await checkAndFleeFromBattle(ctx, "goto")) {
      ctx.log("error", "Battle detected before navigation - cannot continue");
      return; // Cancel routine
    }

    const MAX_NAV_ATTEMPTS = 3;
    let navAttempts = 0;
    // Final battle check before navigation
    if (await checkAndFleeFromBattle(ctx, "goto")) {
      ctx.log("combat", "Cannot navigate while in battle — fleeing first");
      return; // Cancel routine
    }

    let arrived = false;

    while (navAttempts < MAX_NAV_ATTEMPTS && bot.state === "running") {
      navAttempts++;
      try {
        arrived = await navigateToSystem(ctx, destinationSystem, {
          fuelThresholdPct: refuelThreshold,
          hullThresholdPct: 40,
          skipBlacklist: ignoreBlacklist && isCloaked,
        });

        if (arrived) {
          ctx.log("travel", `Arrived in ${destinationSystem}`);
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
          ctx.log("error", `Failed to reach ${destinationSystem} — routine cancelled`);
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
      ctx.log("error", `Failed to reach ${destinationSystem} after ${MAX_NAV_ATTEMPTS} attempts — routine cancelled`);
      return; // Cancel routine
    }
  }

  // Find and travel to destination POI
  yield "find_destination";
  const { pois } = await getSystemInfo(ctx);

  let targetPoi = null;

  if (destinationPoi) {
    // Travel to the specific destination POI
    targetPoi = pois.find(p => p.id === destinationPoi);
    if (!targetPoi) {
      ctx.log("error", `Destination POI "${destinationPoi}" not found in ${destinationSystem} — finding alternative`);
    }
  }

  // Fallback: any station in the system
  if (!targetPoi) {
    targetPoi = findStation(pois);
  }

  if (!targetPoi) {
    ctx.log("error", `No POI found in ${destinationSystem} — routine cancelled`);
    return; // Cancel routine
  }

  const poiIsStation = isStationPoi(targetPoi);
  const shouldDock = poiIsStation && dockIfStation;

  // Travel to POI
  yield "travel_to_poi";
  if (bot.poi !== targetPoi.id) {
    ctx.log("travel", `Traveling to ${targetPoi.name}...`);
    const travelResp = await bot.exec("travel", { target_poi: targetPoi.id });
    if (travelResp.error && !travelResp.error.message.includes("already")) {
      ctx.log("error", `Travel to POI failed: ${travelResp.error.message}`);
      return; // Cancel routine
    }
    // Verify travel succeeded by checking position
    await bot.refreshLocation();
    if (bot.poi !== targetPoi.id) {
      ctx.log("error", `Travel to POI failed: not at target ${targetPoi.id} (currently at ${bot.poi})`);
      return; // Cancel routine
    }
  }

  // A ship cannot be both cloaked and docked, and `cloak` is a 1-tick mutation.
  // Decloak (if cloaked) and wait for the mutation to settle BEFORE docking so the
  // dock command isn't rejected with "action pending" and the docked flag is accurate.
  if (shouldDock && bot.isCloaked && decloakBeforeDock) {
    await decloakAndSettle(ctx);
  }

  // Dock at station (only when the destination is a station and docking is requested)
  if (shouldDock) {
    yield "dock";
    await bot.refreshStatus();
    const docked = await ensureDocked(ctx, true, 0, { targetStationId: destinationPoi || undefined });
    if (!docked) {
      ctx.log("error", "Failed to dock at destination — routine cancelled");
      return; // Cancel routine
    }

    // After docking, repair and refuel if needed
    await bot.refreshShip();
    const dockedHullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    if (dockedHullPct < 95) {
      ctx.log("system", `Hull at ${dockedHullPct}% — repairing at destination...`);
      await repairShip(ctx);
    }
    const dockedFuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    if (dockedFuelPct < refuelThreshold) {
      ctx.log("system", `Fuel at ${dockedFuelPct}% — refueling at destination...`);
      const { pois: stationPois } = await getSystemInfo(ctx);
      const currentStation = stationPois.find(p => isStationPoi(p) && p.id === bot.poi && isUsableFuelStation(p.id, readSettings(), bot.system));
      if (currentStation) {
        await ensureFueled(ctx, refuelThreshold);
        await ensureDocked(ctx, true);
      } else {
        await ensureFueled(ctx, refuelThreshold);
      }
    }
  } else {
    ctx.log("travel", `Arrived at ${targetPoi.name} (${poiIsStation ? "station" : "POI"}) — no docking required`);
  }

  // Final status
  await bot.refreshLocation();
  const destType = poiIsStation ? "station" : "POI";
  ctx.log("travel", `GoTo complete — at ${bot.poi} (${destType}) in ${destinationSystem}`);
  ctx.log("info", `Bot status: ${bot.credits} credits, ${bot.fuel}/${bot.maxFuel} fuel, ${bot.hull}/${bot.maxHull} hull`);

  // Routine complete — return to cancel it (no loop)
  return;
};
