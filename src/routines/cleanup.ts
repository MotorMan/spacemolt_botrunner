/**
 * Cleanup Agent routine — consolidates scattered station storage to faction home base.
 *
 * Uses the view_storage hint field to discover which stations have stored items/credits,
 * then remotely inspects each via view_storage(station_id=...) before traveling.
 * Only physically visits stations that have items or credits to collect.
 * Deposits everything at the faction storage station set in general settings.
 */
import type { Routine, RoutineContext } from "../bot.js";
import { mapStore } from "../mapstore.js";
import {
  ensureDocked,
  ensureUndocked,
  tryRefuel,
  repairShip,
  ensureFueled,
  navigateToSystem,
  detectAndRecoverFromDeath,
  maxItemsForCargo,
  readSettings,
  sleep,
  logFactionActivity,
  isPirateSystem,
} from "./common.js";

// ── Settings ─────────────────────────────────────────────────

function getCleanupSettings(username?: string): {
  homeSystem: string;
  homeStation: string;
  refuelThreshold: number;
  repairThreshold: number;
  focusStationId: string;  // If set, only clean up this specific station
} {
  const all = readSettings();
  const general = all.general || {};
  const t = all.cleanup || {};
  const botOverrides = username ? (all[username] || {}) : {};
  return {
    // Per-bot override > cleanup-specific > general faction storage > "sol"
    homeSystem: (botOverrides.homeSystem as string)
      || (t.homeSystem as string) || (general.factionStorageSystem as string) || "sol",
    homeStation: (botOverrides.homeStation as string)
      || (t.homeStation as string) || (general.factionStorageStation as string) || "",
    refuelThreshold: (t.refuelThreshold as number) || 50,
    repairThreshold: (t.repairThreshold as number) || 40,
    focusStationId: (botOverrides.focusStationId as string) || (t.focusStationId as string) || "",
  };
}

// ── Types ────────────────────────────────────────────────────

interface StationTarget {
  stationId: string;   // base_id or poi_id used for view_storage(station_id=...)
  systemId: string;
  poiId: string;
  poiName: string;
  hasItems: boolean;
  hasCredits: boolean;
  hasOrders: boolean;
}

interface StorageHintEntry {
  station_id?: string;
  base_id?: string;
  poi_id?: string;
  system_id?: string;
  name?: string;
  items?: number;
  credits?: number;
}

// ── Helpers ──────────────────────────────────────────────────

/**
 * Parse the hint field from view_storage/view_orders to find stations with data.
 * The hint is a summary string or structured data about where you have storage.
 */
function parseStorageHints(hint: unknown): StorageHintEntry[] {
  if (!hint) return [];

  // If hint is already an array of objects, use directly
  if (Array.isArray(hint)) {
    return hint.filter((h): h is StorageHintEntry => h && typeof h === "object");
  }

  // If hint is a string, try to extract station references
  // Format might be like: "You have storage at: Station A (System X), Station B (System Y)"
  if (typeof hint === "string") {
    const entries: StorageHintEntry[] = [];
    // Try to find base_id or station_id patterns in the text
    const matches = hint.match(/[a-f0-9-]{36}/gi);
    if (matches) {
      for (const id of matches) {
        entries.push({ station_id: id });
      }
    }
    return entries;
  }

  // If hint is a single object
  if (typeof hint === "object") {
    return [hint as StorageHintEntry];
  }

  return [];
}

/**
 * Resolve a station_id / base_id to a system + POI using mapStore.
 * Returns null if we can't find it in our map data.
 */
function resolveStation(stationId: string): { systemId: string; poiId: string; poiName: string } | null {
  const allSystems = mapStore.getAllSystems();
  for (const [sysId, sys] of Object.entries(allSystems)) {
    for (const poi of sys.pois) {
      if (poi.id === stationId || poi.base_id === stationId) {
        return { systemId: sysId, poiId: poi.id, poiName: poi.base_name || poi.name || poi.id };
      }
    }
  }
  return null;
}

/** Get all known stations with bases from mapStore (excluding pirate systems). */
function getAllKnownStations(homeSystem: string, homeStation: string, focusStationId?: string): StationTarget[] {
  const stations: StationTarget[] = [];
  const allSystems = mapStore.getAllSystems();

  // If focus station is set, only return that station
  if (focusStationId) {
    for (const [sysId, sys] of Object.entries(allSystems)) {
      if (isPirateSystem(sysId)) continue;
      for (const poi of sys.pois) {
        if (!poi.has_base) continue;
        if (poi.base_id === focusStationId || poi.id === focusStationId) {
          // Skip the home/faction storage station
          if (sysId === homeSystem && (poi.id === homeStation || poi.base_id === homeStation)) continue;
          stations.push({
            stationId: poi.base_id || poi.id,
            systemId: sysId,
            poiId: poi.id,
            poiName: poi.base_name || poi.name || poi.id,
            hasItems: false,
            hasCredits: false,
            hasOrders: false,
          });
          return stations;  // Return early - only one station in focus mode
        }
      }
    }
    return stations;  // Focus station not found
  }

  // Default: return all stations (except home)
  for (const [sysId, sys] of Object.entries(allSystems)) {
    // Skip pirate systems
    if (isPirateSystem(sysId)) continue;
    for (const poi of sys.pois) {
      if (!poi.has_base) continue;
      // Skip the home/faction storage station
      if (sysId === homeSystem && (poi.id === homeStation || poi.base_id === homeStation)) continue;
      stations.push({
        stationId: poi.base_id || poi.id,
        systemId: sysId,
        poiId: poi.id,
        poiName: poi.base_name || poi.name || poi.id,
        hasItems: false,
        hasCredits: false,
        hasOrders: false,
      });
    }
  }

  return stations;
}

/** Transfer all items from personal storage to faction storage at home station. */
async function transferPersonalToFaction(ctx: RoutineContext, settings: ReturnType<typeof getCleanupSettings>): Promise<void> {
  const { bot } = ctx;
  const safetyOpts = {
    fuelThresholdPct: settings.refuelThreshold,
    hullThresholdPct: settings.repairThreshold,
  };

  // Navigate to home system
  if (bot.system !== settings.homeSystem) {
    await ensureUndocked(ctx);
    const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
    if (!fueled) {
      ctx.log("error", "Cannot refuel for return to home — staying put");
      return;
    }
    ctx.log("travel", `Returning to home system ${settings.homeSystem}...`);
    const arrived = await navigateToSystem(ctx, settings.homeSystem, safetyOpts);
    if (!arrived) {
      ctx.log("error", "Failed to reach home system");
      return;
    }
  }

  // Travel to home station POI
  await ensureUndocked(ctx);
  // Resolve home station to POI id (might be a base_id)
  let homePoiId = settings.homeStation;
  if (homePoiId) {
    const resolved = resolveStation(homePoiId);
    if (resolved) homePoiId = resolved.poiId;
  } else {
    // Find any station in the home system
    const sys = mapStore.getSystem(settings.homeSystem);
    const station = sys?.pois.find(p => p.has_base);
    if (station) homePoiId = station.id;
  }

  if (homePoiId && bot.poi !== homePoiId) {
    ctx.log("travel", `Traveling to home station...`);
    const tResp = await bot.exec("travel", { target_poi: homePoiId });
    if (tResp.error && !tResp.error.message.includes("already")) {
      ctx.log("error", `Travel to home station failed: ${tResp.error.message}`);
      return;
    }
    bot.poi = homePoiId;
  }

  // Dock
  await ensureDocked(ctx);

  // Check personal storage and transfer everything to faction storage
  await bot.refreshStorage();
  if (bot.storage.length === 0) {
    ctx.log("info", "Personal storage is empty — nothing to transfer to faction");
    return;
  }

  const transferred: string[] = [];
  for (const item of bot.storage) {
    if (item.quantity <= 0) continue;

    // Use storage command with action=deposit, target=faction
    const sResp = await bot.exec("storage", {
      action: "deposit",
      target: "faction",
      item_id: item.itemId,
      quantity: item.quantity,
      source: "storage",
    });

    if (!sResp.error) {
      transferred.push(`${item.quantity}x ${item.name}`);
      logFactionActivity(ctx, "transfer", `Transferred ${item.quantity}x ${item.name} from personal to faction storage`);
    } else {
      ctx.log("error", `Failed to transfer ${item.name} to faction storage: ${sResp.error.message}`);
    }
  }

  if (transferred.length > 0) {
    ctx.log("trade", `Transferred to faction storage: ${transferred.join(", ")}`);
    await bot.refreshStorage();
  } else {
    ctx.log("info", "No items transferred to faction storage");
  }
}

/** Navigate to home station and deposit all non-fuel cargo to faction storage. */
async function depositAtHome(ctx: RoutineContext, settings: ReturnType<typeof getCleanupSettings>): Promise<void> {
  const { bot } = ctx;
  const safetyOpts = {
    fuelThresholdPct: settings.refuelThreshold,
    hullThresholdPct: settings.repairThreshold,
  };

  // Navigate to home system
  if (bot.system !== settings.homeSystem) {
    await ensureUndocked(ctx);
    const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
    if (!fueled) {
      ctx.log("error", "Cannot refuel for return to home — staying put");
      return;
    }
    ctx.log("travel", `Returning to home system ${settings.homeSystem}...`);
    const arrived = await navigateToSystem(ctx, settings.homeSystem, safetyOpts);
    if (!arrived) {
      ctx.log("error", "Failed to reach home system");
      return;
    }
  }

  // Travel to home station POI
  await ensureUndocked(ctx);
  // Resolve home station to POI id (might be a base_id)
  let homePoiId = settings.homeStation;
  if (homePoiId) {
    const resolved = resolveStation(homePoiId);
    if (resolved) homePoiId = resolved.poiId;
  } else {
    // Find any station in the home system
    const sys = mapStore.getSystem(settings.homeSystem);
    const station = sys?.pois.find(p => p.has_base);
    if (station) homePoiId = station.id;
  }

  if (homePoiId && bot.poi !== homePoiId) {
    ctx.log("travel", `Traveling to home station...`);
    const tResp = await bot.exec("travel", { target_poi: homePoiId });
    if (tResp.error && !tResp.error.message.includes("already")) {
      ctx.log("error", `Travel to home station failed: ${tResp.error.message}`);
      return;
    }
    bot.poi = homePoiId;
  }

  // Dock
  await ensureDocked(ctx);

  // Deposit all non-fuel cargo to faction storage
  await bot.refreshCargo();
  const deposited: string[] = [];
  for (const item of [...bot.inventory]) {
    if (item.quantity <= 0) continue;
    const lower = item.itemId.toLowerCase();
    if (lower.includes("fuel") || lower.includes("energy_cell")) continue;

    const fResp = await bot.exec("faction_deposit_items", { item_id: item.itemId, quantity: item.quantity });
    if (!fResp.error) {
      deposited.push(`${item.quantity}x ${item.name}`);
      logFactionActivity(ctx, "deposit", `Deposited ${item.quantity}x ${item.name} (cleanup)`);
    } else {
      // Fallback to station storage
      await bot.exec("deposit_items", { item_id: item.itemId, quantity: item.quantity });
      deposited.push(`${item.quantity}x ${item.name} (station)`);
    }
  }

  if (deposited.length > 0) {
    ctx.log("trade", `Deposited at home: ${deposited.join(", ")}`);
    await bot.refreshCargo();
  }
}

// ── Main routine ─────────────────────────────────────────────

export const cleanupRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  await bot.refreshStatus();

  while (bot.state === "running") {
    // ── Death recovery ──
    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) { await sleep(10000); continue; }

    const settings = getCleanupSettings(bot.username);
    const safetyOpts = {
      fuelThresholdPct: settings.refuelThreshold,
      hullThresholdPct: settings.repairThreshold,
    };

    // ── Phase 0: Transfer personal storage to faction storage (FIRST) ──
    yield "transfer_personal_to_faction";
    ctx.log("info", "Checking personal storage and transferring to faction storage...");
    await transferPersonalToFaction(ctx, settings);

    // ── Phase 1: Remote scan — discover which stations have our stuff ──
    yield "remote_scan";
    const focusMode = settings.focusStationId ? ` (focus: ${settings.focusStationId})` : "";
    ctx.log("info", `Scanning${focusMode} for stored items (remote)...`);

    // Call view_storage to get the hint field
    const storageData = await bot.viewStorage();
    const hint = storageData.hint;
    const hintEntries = parseStorageHints(hint);

    // Get all known stations for comparison
    const allStations = getAllKnownStations(settings.homeSystem, settings.homeStation, settings.focusStationId);

    // If we got hints, mark stations that have items
    const stationsWithStorage: StationTarget[] = [];

    if (hintEntries.length > 0) {
      ctx.log("info", `Hint lists ${hintEntries.length} station(s) with storage`);
      for (const entry of hintEntries) {
        const sid = entry.station_id || entry.base_id || entry.poi_id || "";
        if (!sid) continue;

        // Don't collect from the home station (that's where we deposit)
        const resolved = resolveStation(sid);
        if (resolved && resolved.systemId === settings.homeSystem
            && (resolved.poiId === settings.homeStation || sid === settings.homeStation)) {
          continue;
        }

        // Find matching station in our known list, or build one from hint data
        let target = allStations.find(s => s.stationId === sid || s.poiId === sid);
        if (!target && resolved) {
          target = {
            stationId: sid,
            systemId: resolved.systemId,
            poiId: resolved.poiId,
            poiName: resolved.poiName,
            hasItems: true,
            hasCredits: false,
            hasOrders: false,
          };
        } else if (!target && entry.system_id) {
          target = {
            stationId: sid,
            systemId: entry.system_id,
            poiId: sid,
            poiName: entry.name || sid,
            hasItems: true,
            hasCredits: false,
            hasOrders: false,
          };
        }

        if (target) {
          target.hasItems = true;
          stationsWithStorage.push(target);
        }
      }
    } else {
      // No hint data available — fall back to remote-checking all known stations
      ctx.log("info", `No hint data — checking ${allStations.length} known station(s) remotely...`);
      for (const station of allStations) {
        if (bot.state !== "running") break;

        const remote = await bot.viewStorage(station.stationId);
        const credits = (remote.credits as number) || (remote.stored_credits as number) || 0;
        const items = bot.parseItemList ? [] : []; // parseItemList is private, check items array
        const itemArray = (
          Array.isArray(remote) ? remote :
          Array.isArray(remote.items) ? remote.items :
          Array.isArray(remote.storage) ? remote.storage :
          []
        ) as Array<Record<string, unknown>>;
        const hasItems = itemArray.some(
          (i: Record<string, unknown>) => ((i.quantity as number) || 0) > 0
        );

        if (credits > 0 || hasItems) {
          station.hasCredits = credits > 0;
          station.hasItems = hasItems;
          stationsWithStorage.push(station);
          ctx.log("info", `  ${station.poiName}: ${credits > 0 ? credits + "cr" : ""}${hasItems ? " + items" : ""}`);
        }
      }
    }

    // Also check for forgotten orders at all stations
    const ordersData = await bot.viewOrders();
    const ordersHint = ordersData.hint;
    if (ordersHint) {
      const orderHintEntries = parseStorageHints(ordersHint);
      for (const entry of orderHintEntries) {
        const sid = entry.station_id || entry.base_id || entry.poi_id || "";
        if (!sid) continue;
        const existing = stationsWithStorage.find(s => s.stationId === sid || s.poiId === sid);
        if (existing) {
          existing.hasOrders = true;
        } else {
          const resolved = resolveStation(sid);
          if (resolved) {
            stationsWithStorage.push({
              stationId: sid,
              systemId: resolved.systemId,
              poiId: resolved.poiId,
              poiName: resolved.poiName,
              hasItems: false,
              hasCredits: false,
              hasOrders: true,
            });
          }
        }
      }
    }

    if (stationsWithStorage.length === 0) {
      const waitMsg = settings.focusStationId 
        ? `No items at focus station — waiting 30 seconds`
        : "No stations with stored items — waiting 30 seconds";
      ctx.log("info", waitMsg);
      await sleep(30000);
      continue;
    }

    const stationCountMsg = settings.focusStationId
      ? `Found ${stationsWithStorage.length} station(s) in focus mode with items/credits to collect`
      : `Found ${stationsWithStorage.length} station(s) with items/credits to collect`;
    ctx.log("info", stationCountMsg);

    // ── Phase 2: Travel to each station and collect ──
    let totalCredits = 0;
    let totalItems = 0;

    // Sort by distance (same-system first, then by jump count)
    stationsWithStorage.sort((a, b) => {
      const aLocal = a.systemId === bot.system ? 0 : 1;
      const bLocal = b.systemId === bot.system ? 0 : 1;
      if (aLocal !== bLocal) return aLocal - bLocal;
      const aRoute = mapStore.findRoute(bot.system, a.systemId);
      const bRoute = mapStore.findRoute(bot.system, b.systemId);
      const aJumps = aRoute ? aRoute.length - 1 : 999;
      const bJumps = bRoute ? bRoute.length - 1 : 999;
      return aJumps - bJumps;
    });

    for (const station of stationsWithStorage) {
      if (bot.state !== "running") break;

      // ── Travel to station ──
      yield "travel_to_station";
      ctx.log("travel", `Heading to ${station.poiName} in ${station.systemId}...`);

      if (bot.system !== station.systemId) {
        await ensureUndocked(ctx);
        const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
        if (!fueled) {
          ctx.log("error", `Cannot refuel to reach ${station.systemId} — skipping`);
          continue;
        }
        const arrived = await navigateToSystem(ctx, station.systemId, safetyOpts);
        if (!arrived) {
          ctx.log("error", `Failed to reach ${station.systemId} — skipping`);
          continue;
        }
      }

      await ensureUndocked(ctx);
      if (bot.poi !== station.poiId) {
        const tResp = await bot.exec("travel", { target_poi: station.poiId });
        if (tResp.error && !tResp.error.message.includes("already")) {
          ctx.log("error", `Travel to ${station.poiName} failed: ${tResp.error.message} — skipping`);
          continue;
        }
        bot.poi = station.poiId;
      }

      // Dock
      await ensureDocked(ctx);
      if (!bot.docked) {
        ctx.log("error", `Could not dock at ${station.poiName} — skipping`);
        continue;
      }

      // Check storage (now docked, get fresh data)
      const storageResp = await bot.viewStorage();
      const storedCredits = (storageResp.credits as number) || (storageResp.stored_credits as number) || 0;
      await bot.refreshStorage();
      const hasItems = bot.storage.length > 0;

      if (storedCredits === 0 && !hasItems) {
        ctx.log("info", `${station.poiName}: empty — skipping`);
        await tryRefuel(ctx);
        continue;
      }

      // Withdraw credits
      if (storedCredits > 0) {
        const wResp = await bot.exec("withdraw_credits", { amount: storedCredits });
        if (!wResp.error) {
          totalCredits += storedCredits;
          ctx.log("trade", `Withdrew ${storedCredits}cr from ${station.poiName}`);
        }
      }

      // Withdraw items (capped by free space)
      if (hasItems) {
        for (const item of bot.storage) {
          if (item.quantity <= 0) continue;
          await bot.refreshStatus();
          const freeSpace = bot.cargoMax > 0 ? bot.cargoMax - bot.cargo : 0;
          if (freeSpace <= 0) break;

          const qty = Math.min(item.quantity, maxItemsForCargo(freeSpace, item.itemId));
          if (qty <= 0) continue;
          const wResp = await bot.exec("withdraw_items", { item_id: item.itemId, quantity: qty });
          if (!wResp.error) {
            totalItems += qty;
            ctx.log("trade", `Withdrew ${qty}x ${item.name} from ${station.poiName}`);
          }
        }
      }

      // Cancel any forgotten orders at this station
      if (station.hasOrders) {
        const orders = await bot.viewOrders();
        const orderList = (
          Array.isArray(orders) ? orders :
          Array.isArray(orders.orders) ? orders.orders :
          Array.isArray(orders.buy_orders) ? [...(orders.buy_orders as unknown[]), ...(orders.sell_orders as unknown[] || [])] :
          []
        ) as Array<Record<string, unknown>>;
        for (const order of orderList) {
          const orderId = (order.order_id as string) || (order.id as string) || "";
          if (orderId) {
            const cResp = await bot.exec("cancel_order", { order_id: orderId });
            if (!cResp.error) {
              ctx.log("trade", `Cancelled order ${orderId} at ${station.poiName}`);
            }
          }
        }
      }

      // Refuel while docked
      await tryRefuel(ctx);

      // If cargo >= 80% full, deposit at home before continuing
      await bot.refreshStatus();
      const usedPct = bot.cargoMax > 0 ? (bot.cargo / bot.cargoMax) * 100 : 0;
      if (usedPct >= 80) {
        yield "deposit_home";
        ctx.log("trade", `Cargo ${Math.round(usedPct)}% full — depositing at home`);
        await depositAtHome(ctx, settings);
      }
    }

    // ── Phase 3: Final deposit ──
    yield "final_deposit";
    await bot.refreshCargo();
    const hasCargoLeft = bot.inventory.some(i => {
      if (i.quantity <= 0) return false;
      const lower = i.itemId.toLowerCase();
      return !lower.includes("fuel") && !lower.includes("energy_cell");
    });

    if (hasCargoLeft) {
      ctx.log("trade", "Final deposit run...");
      await depositAtHome(ctx, settings);
    }

    // Summary
    ctx.log("info", `Cleanup complete: ${totalCredits}cr + ${totalItems} items collected from ${stationsWithStorage.length} station(s)`);

    // ── Phase 4: Final personal storage to faction transfer ──
    yield "final_personal_transfer";
    ctx.log("info", "Final check: transferring any remaining personal storage to faction...");
    await transferPersonalToFaction(ctx, settings);

    // Maintenance at home
    await ensureDocked(ctx);
    await tryRefuel(ctx);
    await repairShip(ctx);

    // Wait before next run
    ctx.log("info", "Next cleanup run in 30 seconds");
    await sleep(30000);
  }
};
