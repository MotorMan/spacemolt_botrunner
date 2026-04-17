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
import { getSystemBlacklist } from "../web/server.js";
import { resolveStationId, getMobileCapitolSystem } from "./common.js";
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
  getSystemInfo,
  findStation,
  isStationPoi,
  type SystemPOI,
  checkAndFleeFromBattle,
  checkBattleAfterCommand,
  type BattleState,
  handleBattleNotifications,
  getBattleStatus,
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
  baseId?: string;     // Optional base_id for storage queries (takes precedence over stationId)
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
 * Special handling: checks mapStore for mobile_capitol station's current location but prefers fresh system data.
 * 
 * Returns stationId (for travel), baseId (for storage queries), and poiName.
 */
function resolveStation(stationId: string): { systemId: string; poiId: string; baseId: string; poiName: string } | null {
  // Check if this is the mobile_capitol station - use mapStore's last known location as fallback
  const mcLocation = mapStore.getMobileCapitolLocation();
  if (mcLocation && (stationId === "mobile_capital" || stationId === mcLocation.poiId || stationId.toLowerCase().includes("mobile"))) {
    // Return poiId for travel, but baseId (from get_poi it's "frontier_station") for storage
    // NOTE: mobile_capital has base_id "frontier_station"
    return { systemId: mcLocation.systemId, poiId: mcLocation.poiId, baseId: "frontier_station", poiName: "Frontier Station" };
  }

  const allSystems = mapStore.getAllSystems();
  for (const [sysId, sys] of Object.entries(allSystems)) {
    for (const poi of sys.pois) {
      // Match on id, base_id, or base_name (case-insensitive for names)
      if (poi.id === stationId || poi.base_id === stationId) {
        return { systemId: sysId, poiId: poi.id, baseId: poi.base_id || poi.id, poiName: poi.base_name || poi.name || poi.id };
      }
      // Also match on base_name for convenience (e.g. "sol_central" -> base_name)
      if (poi.base_name && poi.base_name.toLowerCase() === stationId.toLowerCase()) {
        return { systemId: sysId, poiId: poi.id, baseId: poi.base_id || poi.id, poiName: poi.base_name };
      }
    }
  }
  return null;
}

/** Check if a station is the home station (matching by id, base_id, base_name, or partial match). */
function isHomeStation(stationId: string, poiId: string, homeSystem: string, homeStation: string): boolean {
  if (!homeStation) return false;
  const lowerHome = homeStation.toLowerCase();
  
  // Direct match
  if (
    stationId.toLowerCase() === lowerHome ||
    poiId.toLowerCase() === lowerHome
  ) return true;
  
  // Partial match (e.g., "sol" matches "sol_central", "central" matches "confederacy_central_command")
  if (
    stationId.toLowerCase().includes(lowerHome) ||
    poiId.toLowerCase().includes(lowerHome)
  ) return true;
  
  // Also check against known stations by base_name (case-insensitive)
  const allSystems = mapStore.getAllSystems();
  for (const [sysId, sys] of Object.entries(allSystems)) {
    for (const poi of sys.pois) {
      const travelId = poi.base_id || poi.id;
      if (travelId === stationId || travelId === poiId) {
        // Check if homeStation matches this station's base_name or name (case-insensitive)
        if (poi.base_name && poi.base_name.toLowerCase().includes(lowerHome)) return true;
        if (poi.name && poi.name.toLowerCase().includes(lowerHome)) return true;
      }
    }
  }
  
  // Last resort: check if homeStation is "sol" related and we're in sol system with a central command
  // This handles the "sol_central" -> "Confederacy Central Command" case
  if (homeSystem === "sol" && (lowerHome === "sol" || lowerHome === "sol_central" || lowerHome === "central")) {
    for (const [sysId, sys] of Object.entries(allSystems)) {
      if (sysId !== "sol") continue;
      for (const poi of sys.pois) {
        const travelId = poi.base_id || poi.id;
        if (travelId === stationId || travelId === poiId) {
          // Check if it's the central command station in sol
          if (poi.base_name && poi.base_name.toLowerCase().includes("central")) return true;
          if (poi.name && poi.name.toLowerCase().includes("central")) return true;
        }
      }
    }
  }
  
  return false;
}

/** Get all known stations with bases from mapStore (excluding pirate systems). */
function getAllKnownStations(homeSystem: string, homeStation: string, focusStationId?: string): StationTarget[] {
  const stations: StationTarget[] = [];
  const allSystems = mapStore.getAllSystems();

  // If focus station is set, only return that station - special handling for mobile
  if (focusStationId) {
    // Check if focus is the mobile station - ONLY add mobile station, not other stations
    const mcLocation = mapStore.getMobileCapitolLocation();
    if (mcLocation && (focusStationId === "mobile_capital" || focusStationId.toLowerCase().includes("mobile") || focusStationId === mcLocation.poiId)) {
      const mcStation: StationTarget = {
        stationId: "frontier_station",
        systemId: mcLocation.systemId,
        poiId: mcLocation.poiId,
        baseId: "frontier_station",
        poiName: "Frontier Station",
        hasItems: false,
        hasCredits: false,
        hasOrders: false,
      };
      if (!isHomeStation(mcStation.stationId, mcStation.poiId, homeSystem, homeStation)) {
        stations.push(mcStation);
      }
      return stations;
    }

    // Existing logic for non-mobile focus
    for (const [sysId, sys] of Object.entries(allSystems)) {
      if (isPirateSystem(sysId)) continue;
      for (const poi of sys.pois) {
        if (!poi.has_base) continue;
        if (poi.base_id === focusStationId || poi.id === focusStationId) {
          const travelId = poi.base_id || poi.id;
          if (isHomeStation(travelId, travelId, homeSystem, homeStation)) continue;
          stations.push({
            stationId: travelId,
            systemId: sysId,
            poiId: travelId,
            poiName: poi.base_name || poi.name || poi.id,
            hasItems: false,
            hasCredits: false,
            hasOrders: false,
          });
          return stations;
        }
      }
    }
    return stations;
  }

  // Normal mode: add mobile station first, then optionally others
  // Check for mobile_capitol station's current location and add it if relevant
  const mcLocation = mapStore.getMobileCapitolLocation();
  if (mcLocation) {
    const mcStation: StationTarget = {
      stationId: "frontier_station",
      systemId: mcLocation.systemId,
      poiId: mcLocation.poiId,
      baseId: "frontier_station",
      poiName: "Frontier Station",
      hasItems: false,
      hasCredits: false,
      hasOrders: false,
    };
    if (!isHomeStation(mcStation.stationId, mcStation.poiId, homeSystem, homeStation)) {
      stations.push(mcStation);
    }
  }

  // Default: return all stations (except home)
  for (const [sysId, sys] of Object.entries(allSystems)) {
    // Skip pirate systems
    if (isPirateSystem(sysId)) continue;
    for (const poi of sys.pois) {
      if (!poi.has_base) continue;
      // Skip the home/faction storage station
      const travelId = poi.base_id || poi.id;
      if (isHomeStation(travelId, travelId, homeSystem, homeStation)) continue;
      // For stations with bases, use base_id for travel; otherwise use poi.id
      stations.push({
        stationId: travelId,
        systemId: sysId,
        poiId: travelId,
        poiName: poi.base_name || poi.name || poi.id,
        hasItems: false,
        hasCredits: false,
        hasOrders: false,
      });
    }
  }

  return stations;
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

  // Travel to home station POI using fresh API data (like return_home.ts)
  await ensureUndocked(ctx);
  
  // Get fresh system data from API
  const { pois } = await getSystemInfo(ctx);
  let targetStation = null;
  
  // If we're already docked at a valid home station, just stay there
  const currentStation = bot.poi ? pois.find(p => p.id === bot.poi || p.base_id === bot.poi) : null;
  if (currentStation && currentStation.has_base && currentStation.id !== settings.focusStationId) {
    ctx.log("info", `Already at home station (${currentStation.base_id || currentStation.id})`);
    targetStation = currentStation;
  }

  // Try to find by configured homeStation name/id (check multiple fields)
  if (settings.homeStation) {
    targetStation = pois.find(p => 
      isStationPoi(p) && 
      (p.id === settings.homeStation || p.base_id === settings.homeStation || p.name?.toLowerCase() === settings.homeStation.toLowerCase())
    );
    if (!targetStation) {
      // Also try matching by base_id (case-insensitive)
      targetStation = pois.find(p => 
        isStationPoi(p) && 
        p.base_id && 
        p.base_id.toLowerCase() === settings.homeStation.toLowerCase()
      );
    }
  }

  // If not found, search for any station with a base in the home system
  // Skip the focus station (we're collecting FROM there, not depositing TO there)
  // NOTE: Include bot.poi - if we're already docked at a valid station, use it
  if (!targetStation) {
    targetStation = pois.find(p =>
      isStationPoi(p) &&
      p.has_base &&
      p.base_id !== settings.focusStationId &&
      p.id !== settings.focusStationId
    );
    if (targetStation) {
      ctx.log("info", `Using default station in ${settings.homeSystem}: ${targetStation.base_id || targetStation.name || targetStation.id}`);
    }
  }

  // Final fallback: if still not found but we have a current station with base, use it
  if (!targetStation && currentStation && currentStation.has_base) {
    targetStation = currentStation;
    ctx.log("info", `Using current station as home: ${targetStation.base_id || targetStation.id}`);
  }

  // If still not found, fall back to "sol" system (the default)
  if (!targetStation && settings.homeSystem !== "sol") {
    ctx.log("warn", `No valid home station in ${settings.homeSystem} — falling back to sol system`);
    // Navigate to sol first
    const solSystem = "sol";
    if (bot.system !== solSystem) {
      const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
      if (fueled) {
        const arrived = await navigateToSystem(ctx, solSystem, safetyOpts);
        if (!arrived) {
          ctx.log("error", "Failed to reach sol system for fallback");
          return;
        }
      } else {
        ctx.log("error", "Cannot refuel to reach sol system");
        return;
      }
    }
    // Get fresh system data for sol
    const { pois: solPois } = await getSystemInfo(ctx);
    targetStation = solPois.find(p =>
      isStationPoi(p) &&
      p.has_base &&
      p.base_id !== settings.focusStationId &&
      p.id !== settings.focusStationId
    );
    if (targetStation) {
      ctx.log("info", `Using fallback station in sol: ${targetStation.base_id || targetStation.name || targetStation.id}`);
    }
  }

  if (!targetStation) {
    ctx.log("error", `Could not find home station (focus: ${settings.focusStationId || 'none'}, current: ${bot.poi}). Configure factionStorageStation in settings.`);
    return;
  }

  // For stations with bases, use base_id for travel (game API expects base_id for faction stations)
  const targetPoiId = targetStation.base_id && targetStation.has_base ? targetStation.base_id : targetStation.id;

  if (bot.poi !== targetPoiId) {
    ctx.log("travel", `Traveling to home station...`);
    const tResp = await bot.exec("travel", { target_poi: targetPoiId });

    // Check for battle after travel
    if (await checkBattleAfterCommand(ctx, tResp.notifications, "travel")) {
      ctx.log("combat", "Battle detected during travel to home station - fleeing!");
      await sleep(5000);
      return;
    }

    if (tResp.error) {
      const errMsg = tResp.error.message.toLowerCase();
      // CRITICAL: Check for battle interrupt error
      if (tResp.error.code === "battle_interrupt" || errMsg.includes("interrupted by battle") || errMsg.includes("interrupted by combat")) {
        ctx.log("combat", `Travel to home station interrupted by battle! ${tResp.error.message} - fleeing!`);
        return;
      }
      if (!errMsg.includes("already")) {
        ctx.log("error", `Travel to home station failed: ${tResp.error.message}`);
        return;
      }
    }
    bot.poi = targetPoiId;
  }

  // Dock
  await ensureDocked(ctx);

  // Check for battle after dock
  if (await checkAndFleeFromBattle(ctx, "dock")) {
    await sleep(5000);
    return;
  }

  // Refresh storage to get accurate data
  await bot.refreshStorage();
  await bot.refreshCargo();

  // Check if we're at the home station (has faction storage)
  const botPoiId = bot.poi || "";
  const isAtHomeStation = targetStation && (
    targetStation.id === botPoiId || 
    targetStation.base_id === botPoiId ||
    (targetStation as { poiId?: string }).poiId === botPoiId
  );

  const deposited: string[] = [];
  const skipped: string[] = [];

  // If at home station with faction storage, try efficient direct deposit from storage
  if (isAtHomeStation && bot.storage.length > 0) {
    ctx.log("trade", `At home station — attempting direct storage deposit...`);
    for (const item of [...bot.storage]) {
      if (item.quantity <= 0) continue;
      const lower = item.itemId.toLowerCase();
      if (lower.includes("fuel") || lower.includes("energy_cell")) continue;

      // Direct deposit from station storage to faction storage
      const fResp = await bot.exec("storage", {
        action: "deposit",
        target: "faction",
        item_id: item.itemId,
        quantity: item.quantity,
        source: "storage"
      });

      if (!fResp.error) {
        deposited.push(`${item.quantity}x ${item.name} (direct)`);
        logFactionActivity(ctx, "deposit", `Deposited ${item.quantity}x ${item.name} (cleanup direct)`);
        // Remove from local storage tracking
        const idx = bot.storage.findIndex(s => s.itemId === item.itemId);
        if (idx >= 0) bot.storage.splice(idx, 1);
      } else if (fResp.error?.message?.includes("storage_cap_exceeded")) {
        skipped.push(`${item.quantity}x ${item.name} (faction full)`);
        ctx.log("warn", `Faction storage full for ${item.name} — skipping`);
      }
    }
  }

  // Also handle any items in cargo (if not already deposited via storage)
  if (bot.inventory.some(i => i.quantity > 0)) {
    for (const item of [...bot.inventory]) {
      if (item.quantity <= 0) continue;
      const lower = item.itemId.toLowerCase();
      if (lower.includes("fuel") || lower.includes("energy_cell")) continue;

      // Skip if already deposited via storage action
      if (deposited.some(d => d.includes(item.name))) continue;

      const fResp = await bot.exec("faction_deposit_items", { item_id: item.itemId, quantity: item.quantity });
      if (!fResp.error) {
        deposited.push(`${item.quantity}x ${item.name}`);
        logFactionActivity(ctx, "deposit", `Deposited ${item.quantity}x ${item.name} (cleanup)`);
      } else if (fResp.error?.message?.includes("storage_cap_exceeded")) {
        skipped.push(`${item.quantity}x ${item.name} (faction full)`);
        ctx.log("warn", `Faction storage full for ${item.name} — skipping`);
      } else {
        // Fallback to station storage
        await bot.exec("deposit_items", { item_id: item.itemId, quantity: item.quantity });
        deposited.push(`${item.quantity}x ${item.name} (station)`);
      }
    }
  }

  if (deposited.length > 0 || skipped.length > 0) {
    const parts = [];
    if (deposited.length > 0) parts.push(`deposited: ${deposited.join(", ")}`);
    if (skipped.length > 0) parts.push(`skipped: ${skipped.join(", ")}`);
    ctx.log("trade", `Deposit result: ${parts.join(" | ")}`);
    await bot.refreshCargo();
    await bot.refreshStorage();
  }
}

// ── Main routine ─────────────────────────────────────────────

export const cleanupRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  await bot.refreshStatus();

  let emptyScanCount = 0;

  while (bot.state === "running") {
    // ── Death recovery ──
    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) { await sleep(10000); continue; }

    // ── Battle state tracking (per-cycle initialization) ──
    const battleState: BattleState = {
      inBattle: false,
      battleId: null,
      battleStartTick: null,
      lastHitTick: null,
      isFleeing: false,
    };

    // ── Battle check ──
    if (await checkAndFleeFromBattle(ctx, "cleanup")) {
      await sleep(5000);
      continue;
    }

    const settings = getCleanupSettings(bot.username);
    const safetyOpts = {
      fuelThresholdPct: settings.refuelThreshold,
      hullThresholdPct: settings.repairThreshold,
    };

    // ── Phase 1: Remote scan — discover which stations have our stuff ──
    yield "remote_scan";
    const focusMode = settings.focusStationId ? ` (focus: ${settings.focusStationId})` : "";
    ctx.log("info", `Scanning${focusMode} for stored items (remote)...`);

    // Call view_storage to get the hint field
    // NOTE: If not docked and no station_id provided, the API returns an error.
    // We need to detect this and ensure we're at a station first.
    let storageData = await bot.viewStorage();
    
    // Check if we got an error about needing to be docked - this means we're floating in space
    const storageError = storageData.error as { message?: string } | undefined;
    const storageErrorMsg = storageError?.message?.toLowerCase() || "";
    const needsDockOrStation = storageErrorMsg.includes("must be docked") || storageErrorMsg.includes("provide a station_id");
    
    if (needsDockOrStation) {
      ctx.log("info", "Not docked and no station_id — attempting to dock at nearest station first...");
      const docked = await ensureDocked(ctx);
      if (!docked) {
        ctx.log("error", "Could not dock at any station — returning to home base");
        await depositAtHome(ctx, settings);
        ctx.log("info", "Cleanup routine complete: could not establish position at any station");
        return;
      }
      // Retry after docking
      storageData = await bot.viewStorage();
    }
    
    const hint = storageData.hint;
    const hintEntries = parseStorageHints(hint);

    // Get all known stations for comparison
    const allStations = getAllKnownStations(settings.homeSystem, settings.homeStation, settings.focusStationId);

    // If we got hints, mark stations that have items
    const stationsWithStorage: StationTarget[] = [];

    if (hintEntries.length > 0) {
      ctx.log("info", `Hint lists ${hintEntries.length} station(s) with storage — verifying each remotely...`);
      for (const entry of hintEntries) {
        const sid = entry.station_id || entry.base_id || entry.poi_id || "";
        if (!sid) continue;

        // Check if this might be the mobile station - use current location from mapStore
        const mcLocation = mapStore.getMobileCapitolLocation();
        let resolved = resolveStation(sid);
        if (mcLocation && (sid === "mobile_capital" || sid.toLowerCase().includes("mobile") || sid === mcLocation.poiId || (entry.name && entry.name.toLowerCase().includes("frontier")))) {
          // Use current mobile station location
          resolved = { systemId: mcLocation.systemId, poiId: mcLocation.poiId, baseId: "frontier_station", poiName: "Frontier Station" };
        }

        // Don't collect from the home station (that's where we deposit)
        if (resolved && isHomeStation(sid, resolved.poiId, settings.homeSystem, settings.homeStation)) {
          continue;
        }

        // Also skip if sid directly matches homeStation
        if (isHomeStation(sid, sid, settings.homeSystem, settings.homeStation)) {
          continue;
        }

        // Find matching station in our known list, or build one from hint data
        let target = allStations.find(s => s.stationId === sid || s.poiId === sid);
        // If not found but resolved, check if it's mobile station we need to add with current location
        if (!target && resolved) {
          const isMobile = mcLocation && (sid === mcLocation.poiId || sid.toLowerCase().includes("mobile") || sid === "mobile_capital");
          if (isMobile && mcLocation) {
            target = {
              stationId: "frontier_station",
              systemId: mcLocation.systemId,
              poiId: mcLocation.poiId,
              baseId: "frontier_station",
              poiName: "Frontier Station",
              hasItems: false,
              hasCredits: false,
              hasOrders: false,
            };
          }
        }
        if (!target && resolved) {
          target = {
            stationId: sid,
            systemId: resolved.systemId,
            poiId: resolved.poiId,
            baseId: resolved.baseId,
            poiName: resolved.poiName,
            hasItems: false,
            hasCredits: false,
            hasOrders: false,
          };
        } else if (!target && entry.system_id) {
          target = {
            stationId: sid,
            systemId: entry.system_id,
            poiId: sid,
            poiName: entry.name || sid,
            hasItems: false,
            hasCredits: false,
            hasOrders: false,
          };
        }

        if (!target) continue;

        // Remotely verify this station actually has items/credits
        const remote = await bot.viewStorage(target.stationId);
        const credits = (remote.credits as number) || (remote.stored_credits as number) || 0;
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
          target.hasCredits = credits > 0;
          target.hasItems = hasItems;
          stationsWithStorage.push(target);
          ctx.log("info", `  ${target.poiName}: ${credits > 0 ? credits + "cr" : ""}${hasItems ? " + items" : ""}`);
        }
      }
    } else {
      // No hint data available — fall back to remote-checking all known stations
      ctx.log("info", `No hint data — checking ${allStations.length} known station(s) remotely...`);
      
      // Dedupe stations by stationId to avoid checking the same station twice
      const seenStationIds = new Set<string>();
      
      for (const station of allStations) {
        if (bot.state !== "running") break;
        
        // Skip if we've already checked this station ID
        const storageId = station.baseId || station.stationId;
        if (seenStationIds.has(storageId)) {
          continue;
        }
        seenStationIds.add(storageId);

        const remote = await bot.viewStorage(storageId);
        const credits = (remote.credits as number) || (remote.stored_credits as number) || 0;
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
    let ordersData = await bot.viewOrders();
    const ordersError = ordersData.error as { message?: string } | undefined;
    const ordersErrorMsg = ordersError?.message?.toLowerCase() || "";
    const ordersNeedsDockOrStation = ordersErrorMsg.includes("must be docked") || ordersErrorMsg.includes("provide a station_id");
    
    if (ordersNeedsDockOrStation && !bot.docked) {
      ctx.log("info", "view_orders: Not docked — ensuring docked state first...");
      const docked = await ensureDocked(ctx);
      if (!docked) {
        ctx.log("error", "Could not dock for orders check — continuing without orders");
        ordersData = {} as Record<string, unknown>;
      } else {
        ordersData = await bot.viewOrders();
      }
    }
    
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

      emptyScanCount++;

      // If we're not docked and can't find items, we're stuck floating - go home
      if (!bot.docked) {
        ctx.log("info", "Not docked and no items found — going home to complete cleanup");
        await depositAtHome(ctx, settings);
        ctx.log("info", "Cleanup routine complete: bot was not docked, returned home");
        return;
      }

      const atHome = bot.system === settings.homeSystem && 
        isHomeStation(bot.poi || "", bot.poi || "", settings.homeSystem, settings.homeStation);

      // If docked at a remote station (not home) with empty remote storage, go deposit cargo and return home
      if (bot.docked && !atHome && emptyScanCount >= 1) {
        ctx.log("info", "Docked at remote station with no items to collect — depositing cargo and returning home");
        
        // Check if there's cargo to deposit
        await bot.refreshCargo();
        const hasCargoLeft = bot.inventory.some(i => {
          if (i.quantity <= 0) return false;
          const lower = i.itemId.toLowerCase();
          return !lower.includes("fuel") && !lower.includes("energy_cell");
        });
        
        if (hasCargoLeft) {
          ctx.log("trade", "Depositing remaining cargo before returning home...");
          await depositAtHome(ctx, settings);
        }
        
        // Now return to home system for maintenance and completion
        ctx.log("info", "Returning to home base for cleanup completion...");
        await ensureDocked(ctx);
        await tryRefuel(ctx);
        await repairShip(ctx);
        ctx.log("info", "Cleanup routine complete: finished at remote station, returned home");
        return;
      }

      if (atHome && emptyScanCount >= 3) {
        ctx.log("info", "Cleanup routine complete: no items found after 3 scans at home — stopping");
        return;
      }

      continue;
    }

    emptyScanCount = 0;

    const stationCountMsg = settings.focusStationId
      ? `Found ${stationsWithStorage.length} station(s) in focus mode with items/credits to collect`
      : `Found ${stationsWithStorage.length} station(s) with items/credits to collect`;
    ctx.log("info", stationCountMsg);

    // ── Phase 2: Travel to each station and collect ──
    let totalCredits = 0;
    let totalItems = 0;

    // Sort by distance (same-system first, then by jump count, avoiding blacklisted systems)
    const blacklist = getSystemBlacklist();
    stationsWithStorage.sort((a, b) => {
      const aLocal = a.systemId === bot.system ? 0 : 1;
      const bLocal = b.systemId === bot.system ? 0 : 1;
      if (aLocal !== bLocal) return aLocal - bLocal;
      const aRoute = mapStore.findRoute(bot.system, a.systemId, blacklist);
      const bRoute = mapStore.findRoute(bot.system, b.systemId, blacklist);
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
        
        // After arriving in system, get fresh POI data to find mobile station's current location
        const { pois: freshPois } = await getSystemInfo(ctx);
        for (const p of freshPois) {
          if (p.id === "mobile_capital") {
            mapStore.updateMobileCapitolLocation(station.systemId, station.systemId, p.id);
            ctx.log("map", `Updated mobile_capitol location: ${station.systemId}/${p.id}`);
            break;
          }
        }
      }

      await ensureUndocked(ctx);
      
      // Force refresh status to get accurate poi after undocking
      await bot.refreshStatus();
      
      ctx.log("travel", `At ${bot.poi}, target is ${station.poiId} - traveling...`);
      if (bot.poi !== station.poiId) {
        const tResp = await bot.exec("travel", { target_poi: station.poiId });

        // Check for battle after travel
        if (await checkBattleAfterCommand(ctx, tResp.notifications, "travel")) {
          ctx.log("combat", "Battle detected during travel - fleeing!");
          await sleep(5000);
          continue;
        }

        if (tResp.error) {
          const errMsg = tResp.error.message.toLowerCase();
          // CRITICAL: Check for battle interrupt error
          if (tResp.error.code === "battle_interrupt" || errMsg.includes("interrupted by battle") || errMsg.includes("interrupted by combat")) {
            ctx.log("combat", `Travel to station interrupted by battle! ${tResp.error.message} - fleeing!`);
            await sleep(5000);
            continue;
          }
          if (!errMsg.includes("already")) {
            ctx.log("error", `Travel to ${station.poiName} failed: ${tResp.error.message} — skipping`);
            continue;
          }
        }
        bot.poi = station.poiId;
      }

      // Explicit dock attempt - don't use ensureDocked's complex logic
      await bot.refreshStatus();
      if (!bot.docked) {
        ctx.log("system", `Docking at ${station.poiName}...`);
        const dockResp = await bot.exec("dock");
        if (dockResp.error) {
          ctx.log("error", `Failed to dock: ${dockResp.error.message}`);
          // If error isn't "already docked", try traveling to the station first
          if (!dockResp.error.message.toLowerCase().includes("already")) {
            ctx.log("travel", `Need to travel to dock point first...`);
            const travelResp = await bot.exec("travel", { target_poi: station.poiId });
            if (!travelResp.error || travelResp.error.message.toLowerCase().includes("already")) {
              bot.poi = station.poiId;
              await bot.refreshStatus();
              const retryDock = await bot.exec("dock");
              if (retryDock.error) {
                ctx.log("error", `Retry dock failed: ${retryDock.error.message}`);
                continue;
              }
            }
          }
        }
        await bot.refreshStatus();
        if (!bot.docked) {
          ctx.log("error", `Still not docked after attempt — skipping`);
          continue;
        }
      }

      // Check for battle after dock
      if (await checkAndFleeFromBattle(ctx, "dock")) {
        await sleep(5000);
        continue;
      }

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
        // If this is the only station (or last station), we're done - don't keep looping
        if (stationsWithStorage.length === 1) {
          ctx.log("info", "Only station was empty - ending cleanup cycle");
          break;
        }
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

    // Maintenance at home
    await ensureDocked(ctx);
    await tryRefuel(ctx);
    await repairShip(ctx);

    // Wait before next run
    ctx.log("info", "Next cleanup run in 30 seconds");
    await sleep(30000);
  }
};
