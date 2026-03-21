import type { Routine, RoutineContext } from "../bot.js";
import { mapStore } from "../mapstore.js";
import {
  isOreBeltPoi,
  isGasCloudPoi,
  isIceFieldPoi,
  findStation,
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
  readSettings,
  scavengeWrecks,
  detectAndRecoverFromDeath,
  getSystemInfo,
  sleep,
} from "./common.js";

// ── Settings ─────────────────────────────────────────────────

type DepositMode = "storage" | "faction" | "sell";
type MiningType = "auto" | "ore" | "gas" | "ice";

function getMinerSettings(username?: string): {
  miningType: MiningType;
  depositMode: DepositMode;
  depositFallback: DepositMode;
  cargoThreshold: number;
  refuelThreshold: number;
  repairThreshold: number;
  homeSystem: string;
  system: string;
  depositBot: string;
  targetOre: string;
  targetGas: string;
  targetIce: string;
} {
  const all = readSettings();
  const m = all.miner || {};
  const botOverrides = username ? (all[username] || {}) : {};

  function parseDepositMode(val: unknown): DepositMode | null {
    if (val === "faction" || val === "sell" || val === "storage") return val;
    return null;
  }

  function parseMiningType(val: unknown): MiningType | null {
    if (val === "auto" || val === "ore" || val === "gas" || val === "ice") return val;
    return null;
  }

  return {
    miningType:
      parseMiningType(botOverrides.miningType) ??
      parseMiningType(m.miningType) ?? "auto",
    depositMode:
      parseDepositMode(botOverrides.depositMode) ??
      parseDepositMode(m.depositMode) ?? "storage",
    depositFallback:
      parseDepositMode(botOverrides.depositFallback) ??
      parseDepositMode(m.depositFallback) ?? "storage",
    cargoThreshold: (m.cargoThreshold as number) || 80,
    refuelThreshold: (m.refuelThreshold as number) || 50,
    repairThreshold: (m.repairThreshold as number) || 40,
    homeSystem: (botOverrides.homeSystem as string) || (m.homeSystem as string) || "",
    system: (m.system as string) || "",
    depositBot: (botOverrides.depositBot as string) || (m.depositBot as string) || "",
    targetOre: (botOverrides.targetOre as string) || (m.targetOre as string) || "",
    targetGas: (botOverrides.targetGas as string) || (m.targetGas as string) || "",
    targetIce: (botOverrides.targetIce as string) || (m.targetIce as string) || "",
  };
}

/** Detect mining type from ship modules. */
async function detectMiningType(ctx: RoutineContext): Promise<"ore" | "gas" | "ice" | null> {
  const { bot } = ctx;
  const shipResp = await bot.exec("get_ship");
  if (shipResp.error) {
    ctx.log("error", `Failed to get ship info: ${shipResp.error.message}`);
    return null;
  }

  const shipData = shipResp.result as Record<string, unknown>;
  const modules = Array.isArray(shipData.modules) ? shipData.modules : [];

  let hasMiningLaser = false;
  let hasGasHarvester = false;
  let hasIceHarvester = false;

  for (const mod of modules) {
    const modObj = typeof mod === "object" && mod !== null ? mod as Record<string, unknown> : null;
    const modId = (modObj?.id as string) || (modObj?.type_id as string) || "";
    const modName = (modObj?.name as string) || "";
    const modType = (modObj?.type as string) || "";

    const checkStr = `${modId} ${modName} ${modType}`.toLowerCase();

    if (checkStr.includes("mining_laser") || checkStr.includes("mining laser")) {
      hasMiningLaser = true;
    }
    if (checkStr.includes("gas_harvester") || checkStr.includes("gas harvester")) {
      hasGasHarvester = true;
    }
    if (checkStr.includes("ice_harvester") || checkStr.includes("ice harvester")) {
      hasIceHarvester = true;
    }
  }

  // Priority: ice > gas > ore (if multiple types present, use settings preference)
  const detectedTypes: string[] = [];
  if (hasMiningLaser) detectedTypes.push("ore");
  if (hasGasHarvester) detectedTypes.push("gas");
  if (hasIceHarvester) detectedTypes.push("ice");

  if (detectedTypes.length > 1) {
    ctx.log("info", `Multiple mining modules detected (${detectedTypes.join(", ")}) — using settings preference`);
    return "ore"; // Default to ore if multiple present
  }
  if (hasIceHarvester) {
    ctx.log("info", "Ice harvester detected — ice mining mode");
    return "ice";
  }
  if (hasGasHarvester) {
    ctx.log("info", "Gas harvester detected — gas harvesting mode");
    return "gas";
  }
  if (hasMiningLaser) {
    ctx.log("info", "Mining laser detected — ore mining mode");
    return "ore";
  }

  ctx.log("error", "No mining equipment detected on ship");
  return null;
}

/** Find appropriate POI based on mining type. */
function findMiningPoi(
  pois: Array<{ id: string; name: string; type: string }>,
  miningType: "ore" | "gas" | "ice",
  targetResource?: string
): { id: string; name: string } | null {
  if (miningType === "ice") {
    // Ice mining
    if (targetResource) {
      for (const poi of pois) {
        if (isIceFieldPoi(poi.type)) {
          const sysData = mapStore.getSystem(poi.id.split("-")[0] || "");
          const storedPoi = sysData?.pois.find(p => p.id === poi.id);
          if (storedPoi?.ores_found.some(o => o.item_id === targetResource)) {
            return { id: poi.id, name: poi.name };
          }
        }
      }
    }
    // Fallback: any ice field
    const iceField = pois.find(p => isIceFieldPoi(p.type));
    return iceField ? { id: iceField.id, name: iceField.name } : null;
  } else if (miningType === "ore") {
    // Ore mining
    if (targetResource) {
      for (const poi of pois) {
        if (isOreBeltPoi(poi.type)) {
          const sysData = mapStore.getSystem(poi.id.split("-")[0] || "");
          const storedPoi = sysData?.pois.find(p => p.id === poi.id);
          if (storedPoi?.ores_found.some(o => o.item_id === targetResource)) {
            return { id: poi.id, name: poi.name };
          }
        }
      }
    }
    // Fallback: any ore belt
    const oreBelt = pois.find(p => isOreBeltPoi(p.type));
    return oreBelt ? { id: oreBelt.id, name: oreBelt.name } : null;
  } else {
    // Gas harvesting
    if (targetResource) {
      for (const poi of pois) {
        if (isGasCloudPoi(poi.type)) {
          const sysData = mapStore.getSystem(poi.id.split("-")[0] || "");
          const storedPoi = sysData?.pois.find(p => p.id === poi.id);
          if (storedPoi?.ores_found.some(o => o.item_id === targetResource)) {
            return { id: poi.id, name: poi.name };
          }
        }
      }
    }
    // Fallback: any gas cloud
    const gasCloud = pois.find(p => isGasCloudPoi(p.type));
    return gasCloud ? { id: gasCloud.id, name: gasCloud.name } : null;
  }
}

/** Find a system with mining POIs from mapStore. */
function findSystemWithMiningPoi(miningType: "ore" | "gas" | "ice", targetResource?: string): { systemId: string; poiId: string; poiName: string } | null {
  const allSystems = mapStore.getAllSystems();
  const candidates: Array<{ systemId: string; poiId: string; poiName: string; priority: number }> = [];

  for (const [systemId, sys] of Object.entries(allSystems)) {
    const pois = sys.pois || [];
    for (const poi of pois) {
      let matches = false;
      let priority = 0;

      if (miningType === "ice" && isIceFieldPoi(poi.type)) {
        matches = true;
        priority = poi.type.includes("ice") ? 2 : 1;
        if (targetResource) {
          const storedPoi = sys.pois?.find(p => p.id === poi.id);
          if (storedPoi?.ores_found.some(o => o.item_id === targetResource)) {
            priority = 10;
          }
        }
      } else if (miningType === "ore" && isOreBeltPoi(poi.type)) {
        matches = true;
        priority = poi.type.includes("asteroid") || poi.type.includes("belt") ? 2 : 1;
        if (targetResource) {
          const storedPoi = sys.pois?.find(p => p.id === poi.id);
          if (storedPoi?.ores_found.some(o => o.item_id === targetResource)) {
            priority = 10;
          }
        }
      } else if (miningType === "gas" && isGasCloudPoi(poi.type)) {
        matches = true;
        priority = poi.type.includes("gas") || poi.type.includes("cloud") ? 2 : 1;
        if (targetResource) {
          const storedPoi = sys.pois?.find(p => p.id === poi.id);
          if (storedPoi?.ores_found.some(o => o.item_id === targetResource)) {
            priority = 10;
          }
        }
      }

      if (matches) {
        candidates.push({ systemId, poiId: poi.id, poiName: poi.name, priority });
      }
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.priority - a.priority);
  return { systemId: candidates[0].systemId, poiId: candidates[0].poiId, poiName: candidates[0].poiName };
}

// ── Miner routine ────────────────────────────────────────────

export const minerRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  await bot.refreshStatus();
  const settings0 = getMinerSettings(bot.username);
  const homeSystem = settings0.homeSystem || bot.system;

  // ── Detect mining type from modules ──
  let miningType: "ore" | "gas" | "ice" = "ore";
  if (settings0.miningType === "auto") {
    const detected = await detectMiningType(ctx);
    if (!detected) {
      ctx.log("error", "Cannot determine mining type — please check ship equipment");
      await sleep(30000);
      return;
    }
    miningType = detected;
  } else {
    miningType = settings0.miningType;
  }

  const targetResource = miningType === "ice" ? settings0.targetIce : (miningType === "ore" ? settings0.targetOre : settings0.targetGas);
  const resourceLabel = miningType === "ice" ? "ice" : (miningType === "ore" ? "ore" : "gas");

  // ── Startup: return home and dump non-fuel cargo to storage ──
  await bot.refreshCargo();
  const nonFuelCargo = bot.inventory.filter(i => {
    const lower = i.itemId.toLowerCase();
    return !lower.includes("fuel") && !lower.includes("energy_cell") && i.quantity > 0;
  });
  if (nonFuelCargo.length > 0) {
    if (bot.system !== homeSystem) {
      ctx.log("harvesting", `Startup: returning to home system ${homeSystem} to deposit cargo...`);
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
    ctx.log("harvesting", `Startup: deposited ${names} — cargo clear for harvesting`);
  }

  while (bot.state === "running") {
    // ── Death recovery ──
    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) { await sleep(30000); continue; }

    const settings = getMinerSettings(bot.username);
    const cargoThresholdRatio = settings.cargoThreshold / 100;
    const safetyOpts = {
      fuelThresholdPct: settings.refuelThreshold,
      hullThresholdPct: settings.repairThreshold,
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
        ctx.log("error", "Failed to reach target system — harvesting locally instead");
      }
    }

    if (bot.state !== "running") break;

    // ── Find mining POI and station in current system ──
    yield miningType === "ice" ? "find_ice_field" : (miningType === "ore" ? "find_ore_belt" : "find_gas_cloud");
    const { pois, systemId } = await getSystemInfo(ctx);
    if (systemId) bot.system = systemId;

    let miningPoi: { id: string; name: string } | null = null;
    let stationPoi: { id: string; name: string } | null = null;

    const station = findStation(pois);
    if (station) stationPoi = { id: station.id, name: station.name };

    miningPoi = findMiningPoi(pois, miningType, targetResource);

    if (!miningPoi) {
      // No mining POI in current system — try to find one from mapStore
      const systemPoi = findSystemWithMiningPoi(miningType, targetResource);
      if (systemPoi) {
        ctx.log("info", `No ${resourceLabel} here — traveling to ${systemPoi.poiName} in ${systemPoi.systemId}`);
        const navOk = await navigateToSystem(ctx, systemPoi.systemId, safetyOpts);
        if (navOk) {
          miningPoi = { id: systemPoi.poiId, name: systemPoi.poiName };
        } else {
          ctx.log("error", `Failed to reach ${systemPoi.systemId} — waiting 30s`);
          await sleep(30000);
          continue;
        }
      }
    }

    if (!miningPoi) {
      ctx.log("error", `No ${resourceLabel} field/cloud found in this system — waiting 30s before retry`);
      await sleep(30000);
      continue;
    }

    // ── Travel to mining location ──
    yield miningType === "ice" ? "travel_to_ice_field" : (miningType === "ore" ? "travel_to_belt" : "travel_to_cloud");
    const travelResp = await bot.exec("travel", { target_poi: miningPoi.id });
    if (travelResp.error && !travelResp.error.message.includes("already")) {
      ctx.log("error", `Travel failed: ${travelResp.error.message}`);
      await sleep(5000);
      continue;
    }
    bot.poi = miningPoi.id;

    // ── Scavenge wrecks before harvesting ──
    yield "scavenge";
    await scavengeWrecks(ctx);

    // ── Harvest loop: mine until cargo threshold ──
    yield "harvest_loop";
    let harvestCycles = 0;
    let stopReason = "";
    const resourcesMinedMap = new Map<string, number>();

    while (bot.state === "running") {
      await bot.refreshStatus();

      const midHull = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;
      if (midHull <= 40) { stopReason = `hull critical (${midHull}%)`; break; }

      const midFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
      if (midFuel < safetyOpts.fuelThresholdPct) { stopReason = `fuel low (${midFuel}%)`; break; }

      const mineResp = await bot.exec("mine");

      if (mineResp.error) {
        const msg = mineResp.error.message.toLowerCase();
        if (msg.includes("depleted") || msg.includes("no resources") || msg.includes("no gas") || msg.includes("no ice") || msg.includes("no minable")) {
          stopReason = `${resourceLabel} field depleted`; break;
        }
        if (msg.includes("cargo") && msg.includes("full")) {
          stopReason = "cargo full"; break;
        }
        if (msg.includes("harvester") || msg.includes("equipment") || msg.includes("mining")) {
          ctx.log("error", `Missing ${resourceLabel} harvesting module: ${mineResp.error.message}`);
          await sleep(30000);
          return;
        }
        ctx.log("error", `Harvest error: ${mineResp.error.message}`);
        break;
      }

      harvestCycles++;

      const { oreId, oreName } = parseOreFromMineResult(mineResp.result);
      if (oreId && bot.poi) {
        mapStore.recordMiningYield(bot.system, bot.poi, { item_id: oreId, name: oreName });
        resourcesMinedMap.set(oreName, (resourcesMinedMap.get(oreName) || 0) + 1);
        bot.stats.totalMined++;
      }

      await bot.refreshStatus();
      const fillRatio = bot.cargoMax > 0 ? bot.cargo / bot.cargoMax : 0;
      if (fillRatio >= cargoThresholdRatio) {
        stopReason = `cargo at ${Math.round(fillRatio * 100)}%`; break;
      }

      yield "harvesting";
    }

    // Harvest summary
    if (harvestCycles > 0) {
      const resourceList = [...resourcesMinedMap.entries()].map(([name, qty]) => `${qty}x ${name}`).join(", ");
      ctx.log("mining", `Harvested ${harvestCycles} cycles (${resourceList})${stopReason ? ` — ${stopReason}` : ""}`);
    } else if (stopReason) {
      ctx.log("mining", `Stopped before harvesting — ${stopReason}`);
    }

    if (bot.state !== "running") break;

    // ── Return to home system if we traveled away ──
    if (bot.system !== homeSystem && homeSystem) {
      yield "return_home";
      yield "pre_return_fuel";
      const returnFueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
      if (!returnFueled && stationPoi) {
        await refuelAtStation(ctx, stationPoi, safetyOpts.fuelThresholdPct);
      }

      const arrived = await navigateToSystem(ctx, homeSystem, safetyOpts);
      if (!arrived) {
        ctx.log("error", "Failed to return to home system — docking at nearest station");
      }

      const { pois: homePois } = await getSystemInfo(ctx);
      const homeStation = findStation(homePois);
      stationPoi = homeStation ? { id: homeStation.id, name: homeStation.name } : null;
    }

    // ── Ensure we have a valid station to dock at ──
    if (!stationPoi || bot.system === homeSystem) {
      const { pois: currentPois } = await getSystemInfo(ctx);
      const currentStation = findStation(currentPois);
      if (currentStation) {
        stationPoi = { id: currentStation.id, name: currentStation.name };
      }
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
      const docked = await ensureDocked(ctx);
      if (!docked) {
        ctx.log("error", "Failed to find station — waiting before retry");
        await sleep(5000);
        continue;
      }
    } else {
      bot.docked = true;
    }

    // ── Collect storage + unload cargo ──
    await collectFromStorage(ctx);
    const creditsBefore = bot.credits;

    yield "unload_cargo";
    const cargoResp = await bot.exec("get_cargo");
    if (cargoResp.result && typeof cargoResp.result === "object") {
      const result = cargoResp.result as Record<string, unknown>;
      const cargoItems = (
        Array.isArray(result) ? result :
        Array.isArray(result.items) ? result.items :
        Array.isArray(result.cargo) ? result.cargo : []
      ) as Array<Record<string, unknown>>;

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

        if (settings.depositMode === "sell") {
          const sellResp = await bot.exec("sell", { item_id: itemId, quantity });
          if (sellResp.error) {
            await bot.exec("deposit_items", { item_id: itemId, quantity });
          }
        } else if (settings.depositMode === "faction") {
          const fResp = await bot.exec("faction_deposit_items", { item_id: itemId, quantity });
          if (fResp.error) {
            await bot.exec("deposit_items", { item_id: itemId, quantity });
          }
        } else if (settings.depositBot) {
          const gResp = await bot.exec("send_gift", { recipient: settings.depositBot, item_id: itemId, quantity });
          if (gResp.error) {
            await bot.exec("deposit_items", { item_id: itemId, quantity });
          }
        } else {
          await bot.exec("deposit_items", { item_id: itemId, quantity });
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

    const earnings = bot.credits - creditsBefore;
    await factionDonateProfit(ctx, earnings);

    // ── Refuel + Repair ──
    yield "refuel";
    await tryRefuel(ctx);
    yield "repair";
    await repairShip(ctx);

    yield "check_skills";
    await bot.checkSkills();

    await bot.refreshStatus();
    const endFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    ctx.log("info", `Cycle done — ${bot.credits} credits, ${endFuel}% fuel, ${bot.cargo}/${bot.cargoMax} cargo`);
  }
};
