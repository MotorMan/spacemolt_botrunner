import type { Routine, RoutineContext } from "../bot.js";
import type { CargoItem } from "../bot.js";
import { mapStore } from "../mapstore.js";
import { catalogStore } from "../catalogstore.js";
import {
  type SystemPOI,
  isOreBeltPoi,
  isStationPoi,
  findStation,
  parseSystemData,
  getSystemInfo,
  parseOreFromMineResult,
  collectFromStorage,
  ensureDocked,
  ensureUndocked,
  tryRefuel,
  repairShip,
  ensureFueled,
  navigateToSystem,
  refuelAtStation,
  factionDonateProfit,
  detectAndRecoverFromDeath,
  getModProfile,
  ensureModsFitted,
  readSettings,
  scavengeWrecks,
  sleep,
} from "./common.js";

// ── Settings ─────────────────────────────────────────────────

type DepositMode = "storage" | "faction" | "sell" | "gift";

const DEFAULT_ORE_QUOTA = 1000;

/** Default ore quotas: all known ores from map at 1000 each. Returns {} if no ores known yet. */
function defaultOreQuotas(): Record<string, number> {
  const ores = mapStore.getAllKnownOres();
  if (ores.length === 0) return {};
  const quotas: Record<string, number> = {};
  for (const ore of ores) {
    quotas[ore.item_id] = DEFAULT_ORE_QUOTA;
  }
  return quotas;
}

/** Read miner settings from data/settings.json.
 *  Per-bot overrides for targetOre, depositMode, depositBot are checked first. */
function getMinerSettings(username?: string): {
  depositMode: DepositMode;
  depositFallback: DepositMode;
  cargoThreshold: number;
  refuelThreshold: number;
  repairThreshold: number;
  homeSystem: string;
  system: string;
  depositBot: string;
  targetOre: string;
  acceptMissions: boolean;
  oreQuotas: Record<string, number>;
} {
  const all = readSettings();
  const m = all.miner || {};
  const botOverrides = username ? (all[username] || {}) : {};

  // depositMode: per-bot override > global > fallback
  function parseDepositMode(val: unknown): DepositMode | null {
    if (val === "faction" || val === "sell" || val === "storage" || val === "gift") return val;
    return null;
  }

  let depositMode: DepositMode =
    parseDepositMode(botOverrides.depositMode) ??
    parseDepositMode(m.depositMode) ??
    (m.sellOre === true ? "sell" : "faction");

  let depositFallback: DepositMode =
    parseDepositMode(botOverrides.depositFallback) ??
    parseDepositMode(m.depositFallback) ??
    "storage";

  // acceptMissions: per-bot > global miner > default true
  const acceptMissions = botOverrides.acceptMissions !== undefined
    ? Boolean(botOverrides.acceptMissions)
    : m.acceptMissions !== undefined
      ? Boolean(m.acceptMissions)
      : true;

  return {
    depositMode,
    depositFallback,
    cargoThreshold: (m.cargoThreshold as number) || 80,
    refuelThreshold: (m.refuelThreshold as number) || 50,
    repairThreshold: (m.repairThreshold as number) || 40,
    homeSystem: (botOverrides.homeSystem as string) || (m.homeSystem as string) || "",
    system: (m.system as string) || "",
    depositBot: (botOverrides.depositBot as string) || (m.depositBot as string) || "",
    targetOre: (botOverrides.targetOre as string) || (m.targetOre as string) || "",
    acceptMissions,
    oreQuotas: (m.oreQuotas as Record<string, number>) || defaultOreQuotas(),
  };
}

// ── Ore quota logic ──────────────────────────────────────────

/**
 * Pick the best ore to mine based on quota deficits in faction storage.
 * Returns ore ID with biggest deficit (tie-broken by base_value), or "" if all met.
 */
function pickTargetOre(
  oreQuotas: Record<string, number>,
  factionStorage: CargoItem[],
): { oreId: string; deficit: number; current: number; target: number } {
  const entries: Array<{ oreId: string; deficit: number; current: number; target: number; baseValue: number }> = [];

  for (const [oreId, target] of Object.entries(oreQuotas)) {
    if (target <= 0) continue;
    // Safety: skip ores with no known ore belt locations (ice/gas ores)
    const locs = mapStore.findOreLocations(oreId);
    const hasOreBelt = locs.some(loc => {
      const sys = mapStore.getSystem(loc.systemId);
      const poi = sys?.pois.find(p => p.id === loc.poiId);
      return poi ? isOreBeltPoi(poi.type) : false;
    });
    if (locs.length > 0 && !hasOreBelt) continue;
    const current = factionStorage.find(i => i.itemId === oreId)?.quantity || 0;
    const deficit = target - current;
    const baseValue = catalogStore.getItem(oreId)?.base_value as number || 0;
    entries.push({ oreId, deficit, current, target, baseValue });
  }

  if (entries.length === 0) return { oreId: "", deficit: 0, current: 0, target: 0 };

  // Sort: biggest deficit first, then highest base_value
  entries.sort((a, b) => b.deficit - a.deficit || b.baseValue - a.baseValue);

  const best = entries[0];
  // All quotas met → return empty (fall back to local mining)
  if (best.deficit <= 0) return { oreId: "", deficit: 0, current: best.current, target: best.target };

  return { oreId: best.oreId, deficit: best.deficit, current: best.current, target: best.target };
}

// ── Mission helpers ───────────────────────────────────────────

const MINING_MISSION_KEYWORDS = ["mine", "ore", "mineral", "supply", "collect", "gather", "extract", "copper_requisition", "mine_resource", "asteroid"];

/** Accept available mining/supply missions at the current station. Respects 5-mission cap. */
async function checkAndAcceptMissions(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;
  if (!bot.docked) return;

  const activeResp = await bot.exec("get_active_missions");
  let activeCount = 0;
  if (activeResp.result && typeof activeResp.result === "object") {
    const r = activeResp.result as Record<string, unknown>;
    const list = Array.isArray(r) ? r : Array.isArray(r.missions) ? r.missions : [];
    activeCount = (list as unknown[]).length;
  }
  if (activeCount >= 5) return;

  const availResp = await bot.exec("get_missions");
  if (!availResp.result || typeof availResp.result !== "object") return;
  const r = availResp.result as Record<string, unknown>;
  const available = (
    Array.isArray(r) ? r :
    Array.isArray(r.missions) ? r.missions : []
  ) as Array<Record<string, unknown>>;

  for (const mission of available) {
    if (activeCount >= 5) break;
    const missionId = (mission.id as string) || (mission.mission_id as string) || "";
    if (!missionId) continue;
    const name = ((mission.name as string) || "").toLowerCase();
    const desc = ((mission.description as string) || "").toLowerCase();
    const type = ((mission.type as string) || "").toLowerCase();
    const isMiningMission = MINING_MISSION_KEYWORDS.some(kw =>
      name.includes(kw) || desc.includes(kw) || type.includes(kw)
    );
    if (!isMiningMission) continue;
    const acceptResp = await bot.exec("accept_mission", { mission_id: missionId });
    if (!acceptResp.error) {
      activeCount++;
      ctx.log("info", `Mission accepted: ${(mission.name as string) || missionId} (${activeCount}/5 active)`);
    }
  }
}

/** Complete any active missions while docked. Called before unloading so mission items are still in hold. */
async function completeActiveMissions(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;
  if (!bot.docked) return;

  const activeResp = await bot.exec("get_active_missions");
  if (!activeResp.result || typeof activeResp.result !== "object") return;
  const r = activeResp.result as Record<string, unknown>;
  const missions = (
    Array.isArray(r) ? r :
    Array.isArray(r.missions) ? r.missions : []
  ) as Array<Record<string, unknown>>;

  for (const mission of missions) {
    const missionId = (mission.id as string) || (mission.mission_id as string) || "";
    if (!missionId) continue;
    const completeResp = await bot.exec("complete_mission", { mission_id: missionId });
    if (!completeResp.error) {
      const reward = (mission.reward as number) || (mission.reward_credits as number) || 0;
      ctx.log("trade", `Mission complete: ${(mission.name as string) || missionId}${reward > 0 ? ` (+${reward} credits)` : ""}`);
      await bot.refreshStatus();
    }
  }
}

/** Check if the current belt's resources are heavily depleted. */
async function isBeltDepleted(ctx: RoutineContext): Promise<boolean> {
  const poiResp = await ctx.bot.exec("get_poi");
  if (!poiResp.result || typeof poiResp.result !== "object") return false;
  const r = poiResp.result as Record<string, unknown>;
  const resources = (
    Array.isArray(r.resources) ? r.resources :
    Array.isArray(r.asteroids) ? r.asteroids :
    Array.isArray(r.ores) ? r.ores : []
  ) as Array<Record<string, unknown>>;
  if (resources.length === 0) return false;
  
  // Handle potential API quirks - be very conservative about depletion detection
  // Some systems may incorrectly report depletion data for certain ore types like energy crystals
  const validResources = resources.filter(res => {
    const depletion = (res.depletion_percent as number) ?? 0;
    const remaining = (res.remaining as number) ?? Infinity;
    
    // If both are missing/invalid, skip this resource to avoid false positives
    if ((depletion === 0 && remaining === Infinity) ||
        (isNaN(depletion) && isNaN(remaining))) {
      return false; // Skip invalid data points
    }
    
    // Consider a resource depleted if it's completely empty or more than 95% depleted
    const isDepleted = depletion >= 95 || remaining === 0;
    return !isDepleted; // Return true for non-depleted resources that are valid
  });
  
  // If we have no valid resources to check, don't assume depleted
  if (validResources.length === 0) {
    // If original had data but it's all invalid/empty, be conservative
    return false;
  }
  
  // Only consider belt fully depleted if a high percentage of VALID resources are actually depleted
  const validDepletedCount = resources.filter(res => {
    const depletion = (res.depletion_percent as number) ?? 0;
    const remaining = (res.remaining as number) ?? Infinity;
    return depletion >= 95 || remaining === 0;
  }).length;
  
  // Even with conservative approach, only mark as depleted if most resources are truly empty
  // This is much more lenient than the original logic that required ALL to be depleted
  const threshold = Math.max(0.7, validResources.length > 0 ? validDepletedCount / validResources.length : 0);
  return validDepletedCount >= (validResources.length * 0.95); // At least 65% of valid resources are depleted
}

// ── Miner routine ────────────────────────────────────────────

/**
 * Miner routine — supports targeted ore seeking across systems:
 *
 * If targetOre is set:
 *   1. Look up ore locations in mapStore
 *   2. Navigate to best belt (cross-system jumps if needed)
 *   3. Mine target ore until cargo full
 *   4. Navigate back to home station
 *   5. Sell/deposit, refuel, repair
 *
 * If no targetOre:
 *   Mine at nearest belt in current/configured system
 */
export const minerRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  await bot.refreshStatus();
  const settings0 = getMinerSettings(bot.username);
  // Home system: from settings, or wherever the bot is now as fallback
  //  // Use factionStorageSystem from general settings instead of homeSystem for mining operations
  const allSettings = readSettings();
  const factionStorageSystem: string = (allSettings.general && typeof allSettings.general.factionStorageSystem === "string")
    ? allSettings.general.factionStorageSystem
    : "sol";
  const homeSystem: string = factionStorageSystem;
  /** Systems where all belts were depleted for the current target ore. Cleared each cycle when ore target changes. */
  const depletedSystems = new Set<string>();
  let lastTargetOre = "";

  // ── Startup: return home and dump non-fuel cargo to storage ──
  await bot.refreshCargo();
  const nonFuelCargo = bot.inventory.filter(i => {
    const lower = i.itemId.toLowerCase();
    return !lower.includes("fuel") && !lower.includes("energy_cell") && i.quantity > 0;
  });
  if (nonFuelCargo.length > 0) {
    // Navigate to home system first so deposits go to the right station
    if (bot.system !== homeSystem) {
      ctx.log("mining", `Startup: returning to home system ${homeSystem} to deposit cargo...`);
      const fueled = await ensureFueled(ctx, 50);
      if (fueled) {
        await navigateToSystem(ctx, homeSystem, { fuelThresholdPct: 50, hullThresholdPct: 30 });
      }
    }
    await ensureDocked(ctx);
    for (const item of nonFuelCargo) {
      if (settings0.depositMode === "faction") {
        const fResp = await bot.exec("faction_deposit_items", { item_id: item.itemId, quantity: item.quantity });
        if (fResp.error) {
          await bot.exec("deposit_items", { item_id: item.itemId, quantity: item.quantity });
        }
      } else {
        await bot.exec("deposit_items", { item_id: item.itemId, quantity: item.quantity });
      }
    }
    const names = nonFuelCargo.map(i => `${i.quantity}x ${i.name}`).join(", ");
    ctx.log("mining", `Startup: deposited ${names} — cargo clear for mining`);
  }

  while (bot.state === "running") {
    // ── Death recovery ──
    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) { await sleep(30000); continue; }

    // Re-read settings each cycle so changes take effect without restart
    const settings = getMinerSettings(bot.username);
    const cargoThresholdRatio = settings.cargoThreshold / 100;
    const safetyOpts = {
      fuelThresholdPct: settings.refuelThreshold,
      hullThresholdPct: settings.repairThreshold,
    };
    let targetOre = settings.targetOre;
    const miningSystem = settings.system || "";

    // ── Ore quotas: pick ore with biggest deficit in faction storage ──
    if (Object.keys(settings.oreQuotas).length > 0) {
      await bot.refreshFactionStorage();
      const pick = pickTargetOre(settings.oreQuotas, bot.factionStorage);
      if (pick.oreId) {
        targetOre = pick.oreId;
        const oreName = catalogStore.resolveItemName(pick.oreId);
        ctx.log("mining", `Quota pick: ${oreName} (${pick.current}/${pick.target}, deficit ${pick.deficit})`);
      } else if (pick.target > 0) {
        // All quotas met — clear targetOre so we mine locally
        targetOre = "";
        ctx.log("mining", "All ore quotas met — mining locally");
      }
    }

    // Reset depleted systems tracker when target ore changes
    if (targetOre !== lastTargetOre) {
      depletedSystems.clear();
      lastTargetOre = targetOre;
    }

    // ── Status + fuel/hull checks ──
    yield "get_status";
    await bot.refreshStatus();

    // Ensure fuel before doing anything
    yield "fuel_check";
    const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
    if (!fueled) {
      ctx.log("error", "Cannot refuel — waiting 30s...");
      await sleep(30000);
      continue;
    }

    // Hull check — repair immediately if low
    await bot.refreshStatus();
    const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
    if (hullPct <= 95) {
      ctx.log("system", `Hull critical (${hullPct}%) — returning to station for repair`);
      await ensureDocked(ctx);
      await repairShip(ctx);
    }

    // ── Undock if docked ──
    await ensureUndocked(ctx);

    // ── Determine mining destination ──
    yield "find_destination";
    let targetSystemId = "";
    let targetBeltId = "";
    let targetBeltName = "";

    if (targetOre) {
      const allOreLocations = mapStore.findOreLocations(targetOre);
      // Filter to ore belts only — exclude ice fields, gas clouds, etc.
      const oreLocations = allOreLocations.filter(loc => {
        const sys = mapStore.getSystem(loc.systemId);
        const poi = sys?.pois.find(p => p.id === loc.poiId);
        return poi ? isOreBeltPoi(poi.type) : true; // keep if type unknown
      });
      if (oreLocations.length === 0) {
        ctx.log("error", `Target ore "${targetOre}" not found at any ore belt — mining locally`);
      } else {
        const inCurrentSystem = oreLocations.find(loc => loc.systemId === bot.system);
        if (inCurrentSystem) {
          targetSystemId = inCurrentSystem.systemId;
          targetBeltId = inCurrentSystem.poiId;
          targetBeltName = inCurrentSystem.poiName;
        } else {
          const withStation = oreLocations.filter(loc => loc.hasStation);
          const best = withStation.length > 0 ? withStation[0] : oreLocations[0];

          const route = mapStore.findRoute(bot.system, best.systemId);
          if (route) {
            targetSystemId = best.systemId;
            targetBeltId = best.poiId;
            targetBeltName = best.poiName;
          } else {
            const routeResp = await bot.exec("find_route", { target_system: best.systemId });
            if (routeResp.result && !routeResp.error) {
              targetSystemId = best.systemId;
              targetBeltId = best.poiId;
              targetBeltName = best.poiName;
            } else {
              ctx.log("error", `Can't reach ${best.systemName} for ${targetOre} — mining locally`);
            }
          }
        }
      }
    }

    if (!targetSystemId && miningSystem && miningSystem !== bot.system) {
      targetSystemId = miningSystem;
    }

    // ── Navigate to target system if needed ──
    if (targetSystemId && targetSystemId !== bot.system) {
      yield "navigate_to_target";
      const arrived = await navigateToSystem(ctx, targetSystemId, safetyOpts);
      if (!arrived) {
        ctx.log("error", "Failed to reach target system — mining locally instead");
        targetBeltId = "";
        targetBeltName = "";
      }
    }

    if (bot.state !== "running") break;

    // ── Find asteroid belt and station in current system ──
    yield "find_belt";
    const { pois, systemId } = await getSystemInfo(ctx);
    if (systemId) bot.system = systemId;

    let beltPoi: { id: string; name: string } | null = null;
    let stationPoi: { id: string; name: string } | null = null;

    const station = findStation(pois);
    if (station) stationPoi = { id: station.id, name: station.name };

    // If targeting a specific belt, prefer it — but only if it's an ore belt
    if (targetBeltId) {
      const match = pois.find(p => p.id === targetBeltId);
      if (match && isOreBeltPoi(match.type)) {
        beltPoi = { id: match.id, name: match.name };
      } else if (match) {
        ctx.log("mining", `Target POI ${match.name} is not an ore belt (${match.type}) — finding ore belt instead`);
      }
    }

    // Fallback: find belt with target ore
    if (!beltPoi && targetOre) {
      for (const poi of pois) {
        if (isOreBeltPoi(poi.type)) {
          const sysData = mapStore.getSystem(bot.system);
          const storedPoi = sysData?.pois.find(p => p.id === poi.id);
          if (storedPoi?.ores_found.some(o => o.item_id === targetOre)) {
            beltPoi = { id: poi.id, name: poi.name };
            break;
          }
        }
      }
    }

    // Fallback: any minable POI
    if (!beltPoi) {
      const minable = pois.find(p => isOreBeltPoi(p.type));
      if (minable) beltPoi = { id: minable.id, name: minable.name };
    }

    if (!beltPoi) {
      ctx.log("error", "No minable POI found in this system — waiting 30s before retry");
      await sleep(30000);
      continue;
    }

    // ── Travel to asteroid belt ──
    yield "travel_to_belt";
    const travelBeltResp = await bot.exec("travel", { target_poi: beltPoi.id });
    if (travelBeltResp.error && !travelBeltResp.error.message.includes("already")) {
      ctx.log("error", `Travel failed: ${travelBeltResp.error.message}`);
      await sleep(5000);
      continue;
    }
    bot.poi = beltPoi.id;

    // ── Check belt depletion — switch to an alternative if exhausted ──
    yield "check_belt";
    if (await isBeltDepleted(ctx)) {
      const altBelt = pois.find(p => isOreBeltPoi(p.type) && p.id !== beltPoi!.id);
      if (altBelt) {
        ctx.log("mining", `${beltPoi.name} depleted, switching to ${altBelt.name}`);
        const altTravel = await bot.exec("travel", { target_poi: altBelt.id });
        if (!altTravel.error || altTravel.error.message.includes("already")) {
          beltPoi = { id: altBelt.id, name: altBelt.name };
          bot.poi = altBelt.id;
        }
      }
    }

    // ── Scavenge wrecks at belt before mining ──
    yield "scavenge";
    await scavengeWrecks(ctx);

    // ── Mine loop: mine until cargo threshold ──
    yield "mine_loop";
    let miningCycles = 0;
    let stopReason = "";
    const oresMinedMap = new Map<string, number>();

    while (bot.state === "running") {
      await bot.refreshStatus();

      const midHull = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
      if (midHull <= 40) { stopReason = `hull critical (${midHull}%)`; break; }

      const midFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
      if (midFuel < safetyOpts.fuelThresholdPct) { stopReason = `fuel low (${midFuel}%)`; break; }

      const mineResp = await bot.exec("mine");

      if (mineResp.error) {
        const msg = mineResp.error.message.toLowerCase();
        if (msg.includes("no asteroids") || msg.includes("depleted") || msg.includes("no minable")) {
          stopReason = "belt depleted"; break;
        }
        if (msg.includes("cargo") && msg.includes("full")) {
          stopReason = "cargo full"; break;
        }
        ctx.log("error", `Mine error: ${mineResp.error.message}`);
        break;
      }

      miningCycles++;

      const { oreId, oreName } = parseOreFromMineResult(mineResp.result);
      if (oreId && bot.poi) {
        mapStore.recordMiningYield(bot.system, bot.poi, { item_id: oreId, name: oreName });
        oresMinedMap.set(oreName, (oresMinedMap.get(oreName) || 0) + 1);
        bot.stats.totalMined++;
      }

      await bot.refreshStatus();
      const fillRatio = bot.cargoMax > 0 ? bot.cargo / bot.cargoMax : 0;
      if (fillRatio >= cargoThresholdRatio) {
        stopReason = `cargo at ${Math.round(fillRatio * 100)}%`; break;
      }

      yield "mining";
    }

    // Mining summary
    if (miningCycles > 0) {
      const oreList = [...oresMinedMap.entries()].map(([name, qty]) => `${qty}x ${name}`).join(", ");
      ctx.log("mining", `Mined ${miningCycles} cycles (${oreList})${stopReason ? ` — ${stopReason}` : ""}`);
    } else if (stopReason) {
      ctx.log("mining", `Stopped before mining — ${stopReason}`);
    }

    if (bot.state !== "running") break;

    // ── Belt depleted: try another system before returning home ──
    if (stopReason === "belt depleted" && targetOre && bot.state === "running") {
      depletedSystems.add(bot.system);
      const altLocations = mapStore.findOreLocations(targetOre)
        .filter(loc => !depletedSystems.has(loc.systemId) && loc.systemId !== bot.system);

      if (altLocations.length > 0) {
        // Prefer systems with a station
        const withStation = altLocations.filter(loc => loc.hasStation);
        const nextLoc = withStation.length > 0 ? withStation[0] : altLocations[0];

        ctx.log("mining", `${bot.system} depleted for ${catalogStore.resolveItemName(targetOre)} — trying ${nextLoc.systemName}`);

        // Refuel before the jump
        const preFueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
        if (!preFueled && stationPoi) {
          await refuelAtStation(ctx, stationPoi, safetyOpts.fuelThresholdPct);
        }

        const arrived = await navigateToSystem(ctx, nextLoc.systemId, safetyOpts);
        if (arrived) {
          // Successfully reached alt system — restart the cycle (skip return home, skip unload)
          ctx.log("mining", `Arrived at ${nextLoc.systemName} — continuing mining`);
          continue;
        }
        ctx.log("error", `Failed to reach ${nextLoc.systemName} — returning home`);
      } else {
        // No alternative systems — clear depleted set (ores regenerate) and return home
        ctx.log("mining", "All known ore locations depleted — clearing depletion cache, returning home");
        depletedSystems.clear();
      }
    }

    // ── Return to home system if we traveled away ──
    if ((targetOre || Object.keys(settings.oreQuotas).length > 0) && bot.system !== homeSystem && homeSystem) {
      yield "return_home";

      // Ensure fueled before the journey home
      yield "pre_return_fuel";
      const returnFueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
      if (!returnFueled && stationPoi) {
        await refuelAtStation(ctx, stationPoi, safetyOpts.fuelThresholdPct);
      }

      const arrived = await navigateToSystem(ctx, homeSystem, safetyOpts);
      if (!arrived) {
        ctx.log("error", "Failed to return to home system — docking at nearest station");
      }

      // Re-find station in current system
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

    // ── Collect gifted credits/items + record market prices ──
    await collectFromStorage(ctx);
    const creditsBefore = bot.credits;

    // ── Complete active missions before unloading (while cargo is still intact) ──
    if (settings.acceptMissions) {
      yield "complete_missions";
      await completeActiveMissions(ctx);
    }

    // ── Sell or Deposit cargo ──
    yield "unload_cargo";
    const cargoResp = await bot.exec("get_cargo");
    if (cargoResp.result && typeof cargoResp.result === "object") {
      const result = cargoResp.result as Record<string, unknown>;
      const cargoItems = (
        Array.isArray(result) ? result :
        Array.isArray(result.items) ? result.items :
        Array.isArray(result.cargo) ? result.cargo :
        []
      ) as Array<Record<string, unknown>>;

      // Deposit helper: attempts primary mode, falls back on error
      async function depositItem(itemId: string, quantity: number, displayName: string, mode: DepositMode, recipient: string): Promise<boolean> {
        if (mode === "gift" || recipient) {
          const target = recipient || settings.depositBot;
          if (target) {
            const giftResp = await bot.exec("send_gift", { recipient: target, item_id: itemId, quantity });
            if (!giftResp.error) return true;
            ctx.log("trade", `Gift to ${target} failed for ${displayName}: ${giftResp.error.message}`);
            return false;
          }
        }
        if (mode === "sell") {
          const sellResp = await bot.exec("sell", { item_id: itemId, quantity });
          if (!sellResp.error) return true;
          ctx.log("trade", `Sell failed for ${displayName}: ${sellResp.error.message}`);
          return false;
        }
        if (mode === "faction") {
          const factionResp = await bot.exec("faction_deposit_items", { item_id: itemId, quantity });
          if (!factionResp.error) return true;
          ctx.log("trade", `Faction deposit failed for ${displayName}: ${factionResp.error.message}`);
          return false;
        }
        // Default: personal storage
        await bot.exec("deposit_items", { item_id: itemId, quantity });
        return true;
      }

      const modeLabel: Record<string, string> = {
        storage: "station storage", faction: "faction storage", sell: "market",
      };
      const primaryLabel = settings.depositBot
        ? `${settings.depositBot}'s storage`
        : (modeLabel[settings.depositMode] || "storage");

      const unloadedItems: string[] = [];
      for (const item of cargoItems) {
        const itemId = (item.item_id as string) || "";
        const quantity = (item.quantity as number) || 0;
        if (!itemId || quantity <= 0) continue;
        const displayName = (item.name as string) || itemId;

        const ok = await depositItem(itemId, quantity, displayName, settings.depositMode, settings.depositBot);
        if (!ok) {
          const ok2 = await depositItem(itemId, quantity, displayName, settings.depositFallback, "");
          if (!ok2) {
            await bot.exec("deposit_items", { item_id: itemId, quantity });
          }
        }
        unloadedItems.push(`${quantity}x ${displayName}`);
        yield "unloading";
      }

      if (unloadedItems.length > 0) {
        ctx.log("trade", `Unloaded ${unloadedItems.join(", ")} → ${primaryLabel}`);
      }
    }

    await bot.refreshStatus();
    await bot.refreshStorage();

    // ── Faction donation (10% of earnings from sales + mission rewards) ──
    const earnings = bot.credits - creditsBefore;
    await factionDonateProfit(ctx, earnings);

    // ── Accept mining missions for the next cycle ──
    if (settings.acceptMissions) {
      yield "check_missions";
      await checkAndAcceptMissions(ctx);
    }

    // ── Refuel + Repair ──
    yield "refuel";
    await tryRefuel(ctx);
    yield "repair";
    await repairShip(ctx);

    // ── Fit mods ──
    const modProfile = getModProfile("miner");
    if (modProfile.length > 0) await ensureModsFitted(ctx, modProfile);

    // ── Check for skill level-ups ──
    yield "check_skills";
    await bot.checkSkills();

    await bot.refreshStatus();
    const endFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    ctx.log("info", `Cycle done — ${bot.credits} credits, ${endFuel}% fuel, ${bot.cargo}/${bot.cargoMax} cargo`);
  }
};

