import type { Routine, RoutineContext } from "../bot.js";
import { mapStore } from "../mapstore.js";
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
  sleep,
} from "./common.js";

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
} {
  const all = readSettings();
  const m = all.salvager || {};
  const botOverrides = username ? (all[username] || {}) : {};

  function parseDepositMode(val: unknown): DepositMode | null {
    if (val === "faction" || val === "sell" || val === "storage") return val;
    return null;
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
  };
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

  await bot.refreshStatus();
  const startSystem = bot.system;
  const settings0 = getSalvagerSettings(bot.username);
  const homeSystem0 = settings0.homeSystem || startSystem;

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

  while (bot.state === "running") {
    // ── Death recovery ──
    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) { await sleep(30000); continue; }

    // ── Verify tow status — clear stale flag if server says we're not towing ──
    await bot.refreshStatus();
    if (bot.towingWreck) {
      // Try to release tow - if server says not towing, clear our flag
      const releaseResp = await bot.exec("release_tow");
      if (releaseResp.error && releaseResp.error.message.includes("not_towing")) {
        ctx.log("warn", "Bot thought it was towing but server says no — clearing stale tow flag");
        bot.towingWreck = false;
      } else if (!releaseResp.error) {
        // Successfully released a tow - we were actually towing, log it
        const releasedId = (releaseResp.result as Record<string, unknown>)?.wreck_id as string || "unknown";
        ctx.log("scavenge", `Released towed wreck ${releasedId} — was from previous session`);
        bot.towingWreck = false;
        await bot.refreshStatus(); // Sync with server
      }
      // If we get here with no error, we released the tow and flag is cleared
    }

    const settings = getSalvagerSettings(bot.username);
    const homeSystem = settings.homeSystem || startSystem;
    const cargoThresholdRatio = settings.cargoThreshold / 100;
    const safetyOpts = {
      fuelThresholdPct: settings.refuelThreshold,
      hullThresholdPct: settings.repairThreshold,
      autoCloak: settings.autoCloak,
    };

    // ── Status + fuel/hull checks ──
    yield "get_status";
    await bot.refreshStatus();

    yield "fuel_check";
    const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
    if (!fueled) {
      ctx.log("error", "Cannot refuel — waiting 30s...");
      await sleep(30000);
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
      yield "navigate_to_target";
      const arrived = await navigateToSystem(ctx, targetSystemId, safetyOpts);
      if (!arrived) {
        ctx.log("error", "Failed to reach target system — salvaging locally instead");
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

    if (!skipScanning && visitPois.length === 0) {
      ctx.log("error", "No salvageable POIs in this system — waiting 60s");
      await sleep(30000);
      continue;
    }

    if (!skipScanning) {
      ctx.log("scavenge", `Found ${visitPois.length} POIs to scan for wrecks`);
    }

    // ── Visit each POI and scavenge ──
    let totalLooted = 0;
    let cargoFull = false;

    if (!skipScanning) {
      for (const poi of visitPois) {
        if (bot.state !== "running") break;

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
        if (travelResp.error && !travelResp.error.message.includes("already")) {
          ctx.log("error", `Travel to ${poi.name} failed: ${travelResp.error.message}`);
          continue;
        }
        bot.poi = poi.id;

        // Salvage wrecks at this POI
        yield "scavenge";
        const result = settings.enableFullSalvage
          ? await fullSalvageWrecks(ctx, { enableTow: settings.enableTowing, minTowValue: settings.minTowValue })
          : { itemsLooted: await scavengeWrecks(ctx), isTowing: false };
        totalLooted += result.itemsLooted;

        ctx.log("scavenge", `fullSalvageWrecks returned: itemsLooted=${result.itemsLooted}, isTowing=${result.isTowing}, bot.towingWreck=${bot.towingWreck}`);

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

    // ── Expand to neighbor systems if current system had no wrecks ──
    // Don't expand if already towing (need to deliver wreck first)
    if (!skipScanning && totalLooted === 0 && !cargoFull && !bot.towingWreck && bot.state === "running") {
      const neighbors = mapStore.getConnections(bot.system);
      if (neighbors.length > 0) {
        ctx.log("scavenge", `No wrecks locally — checking ${neighbors.length} neighbor system(s)`);
      }

      for (const conn of neighbors) {
        if (bot.state !== "running" || cargoFull || bot.towingWreck) break;

        // Check fuel before jumping
        await bot.refreshStatus();
        const fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
        if (fuelPct < safetyOpts.fuelThresholdPct) {
          ctx.log("scavenge", `Fuel low (${fuelPct}%) — stopping neighbor scan`);
          break;
        }

        // Re-check towing status before jumping
        if (bot.towingWreck) {
          ctx.log("scavenge", "Now towing a wreck — stopping neighbor scan and heading to salvage yard");
          break;
        }

        yield "neighbor_system";
        ctx.log("travel", `Jumping to ${conn.system_name || conn.system_id} to check for wrecks...`);
        await ensureUndocked(ctx);
        const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
        if (!fueled) break;
        const arrived = await navigateToSystem(ctx, conn.system_id, safetyOpts);
        if (!arrived) continue;

        // Scan neighbor system POIs (all non-station POIs — wrecks can spawn anywhere)
        const { pois: neighborPois } = await getSystemInfo(ctx);
        const neighborVisit = neighborPois.filter(p => !isStationPoi(p));
        if (neighborVisit.length === 0) continue;

        for (const poi of neighborVisit) {
          if (bot.state !== "running") break;

          await bot.refreshStatus();
          const fillRatio = bot.cargoMax > 0 ? bot.cargo / bot.cargoMax : 0;
          if (fillRatio >= cargoThresholdRatio) {
            ctx.log("scavenge", `Cargo at ${Math.round(fillRatio * 100)}% — heading to station`);
            cargoFull = true;
            break;
          }

          const nFuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
          if (nFuelPct < safetyOpts.fuelThresholdPct) break;

          yield "travel_to_poi";
          const tResp = await bot.exec("travel", { target_poi: poi.id });
          if (tResp.error && !tResp.error.message.includes("already")) continue;
          bot.poi = poi.id;

          yield "scavenge";
          const result = settings.enableFullSalvage
            ? await fullSalvageWrecks(ctx, { enableTow: settings.enableTowing, minTowValue: settings.minTowValue })
            : { itemsLooted: await scavengeWrecks(ctx), isTowing: false };
          totalLooted += result.itemsLooted;
          if (result.itemsLooted > 0) {
            ctx.log("scavenge", `Extracted ${result.itemsLooted} items at ${poi.name} (${conn.system_name || conn.system_id})`);
          }

          // If towing a wreck, stop scanning and head to salvage yard
          await bot.refreshStatus();
          if (result.isTowing || bot.towingWreck) {
            ctx.log("scavenge", `Now towing a wreck in neighbor system (result=${result.isTowing}, bot=${bot.towingWreck}) — heading to salvage yard`);
            cargoFull = true; // Signal to stop scanning
            break;
          }
        }

        // If we found wrecks in this neighbor, stop expanding further
        if (totalLooted > 0 || cargoFull) break;
      }

      if (bot.state !== "running") break;
      if (totalLooted > 0) {
        ctx.log("scavenge", `Neighbor sweep: ${totalLooted} items looted`);
      }
    }

    // ── Process towed wrecks: navigate to salvage yard if towing ──
    await bot.refreshStatus();
    let wasTowing = bot.towingWreck;
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
        }
        ctx.log("scavenge", `Using configured salvage yard: ${configuredStation}`);
      }

      if (!targetSystem) {
        // Default: Sol system (Alpha Centauri Colonial Station)
        targetSystem = "sol";
        targetStationId = "alpha_centauri_colonial_station";
        ctx.log("scavenge", "No salvage yard configured — using default (Sol: Alpha Centauri Colonial Station)");
      }

      // Navigate to salvage yard system if not already there
      if (bot.system !== targetSystem) {
        yield "navigate_to_salvage_yard";
        ctx.log("travel", `Traveling to salvage yard system: ${targetSystem}...`);
        const arrived = await navigateToSystem(ctx, targetSystem, {
          ...safetyOpts,
          autoCloak: settings.autoCloak,
        });
        if (!arrived) {
          ctx.log("error", "Failed to reach salvage yard system — docking at nearest station");
        }
      }

      // Find and travel to salvage yard station
      const { pois: yardPois } = await getSystemInfo(ctx);
      let salvageYardStation = targetStationId
        ? yardPois.find(p => p.id === targetStationId) || findSalvageYardStation(yardPois)
        : findSalvageYardStation(yardPois);

      if (salvageYardStation) {
        yield "travel_to_salvage_yard";
        ctx.log("travel", `Traveling to salvage yard: ${salvageYardStation.name}...`);
        const travelResp = await bot.exec("travel", { target_poi: salvageYardStation.id });
        if (travelResp.error && !travelResp.error.message.includes("already")) {
          ctx.log("error", `Travel to salvage yard failed: ${travelResp.error.message}`);
        } else {
          bot.poi = salvageYardStation.id;
          stationPoi = { id: salvageYardStation.id, name: salvageYardStation.name };
        }
      } else {
        // Fall back to any station
        const fallbackStation = findStation(yardPois);
        if (fallbackStation) {
          ctx.log("warn", "No salvage yard found — using regular station");
          const travelResp = await bot.exec("travel", { target_poi: fallbackStation.id });
          if (!travelResp.error || travelResp.error.message.includes("already")) {
            bot.poi = fallbackStation.id;
            stationPoi = { id: fallbackStation.id, name: fallbackStation.name };
          }
        }
      }

      // After delivering the wreck, skip further POI scanning and go straight to processing
      wasTowing = true;
    }

    // ── Return to home system if needed ──
    // Skip this if we're towing a wreck to the salvage yard (don't want to override salvage yard destination)
    if (!wasTowing && bot.system !== homeSystem && homeSystem) {
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
    }

    // ── Travel to station ──
    yield "travel_to_station";
    if (stationPoi) {
      const travelStationResp = await bot.exec("travel", { target_poi: stationPoi.id });
      if (travelStationResp.error && !travelStationResp.error.message.includes("already")) {
        ctx.log("error", `Travel to station failed: ${travelStationResp.error.message}`);
      }
    }

    // ── Dock ──
    yield "dock";
    const dockResp = await bot.exec("dock");
    if (dockResp.error && !dockResp.error.message.includes("already")) {
      ctx.log("error", `Dock failed: ${dockResp.error.message}`);
      await sleep(5000);
      continue;
    }
    bot.docked = true;

    // ── Process towed wrecks at salvage yard ──
    let processedTow = false;
    if (bot.towingWreck) {
      yield "process_towed_wrecks";
      const processed = await processTowedWrecks(ctx, { preferScrap: settings.preferScrap });
      if (processed > 0) {
        ctx.log("scavenge", `Processed ${processed} towed wreck(s) at salvage yard`);
        processedTow = true;
        bot.towingWreck = false; // Clear flag after successful processing
      }
      // If processing failed with "not_towing", the flag will be cleared at start of next cycle
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

    // If we processed a towed wreck, restart the cycle immediately (don't continue scanning)
    if (processedTow) {
      ctx.log("scavenge", "Processed towed wreck — restarting cycle");
      continue;
    }

    // If nothing was found, wait longer before next sweep
    if (totalLooted === 0) {
      ctx.log("scavenge", "No wrecks found — waiting 60s before next sweep");
      await sleep(60000);
    }
  }
};
