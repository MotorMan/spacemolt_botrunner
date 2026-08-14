import type { Bot, Routine, RoutineContext } from "../bot.js";
import { catalogStore } from "../catalogstore.js";
import { extractShipModules, moduleHaystack } from "../shipmodules.js";
import { mapStore } from "../mapstore.js";
import {
  ensureFueled,
  repairShip,
  detectAndRecoverFromDeath,
  readSettings,
  checkAndFleeFromBattle,
  ensureDocked,
  tryRefuel,
  getItemSize,
} from "./common.js";
import {
  getFacilityState,
  saveFacilityState,
  incrementBuildFailures,
  resetBuildFailures,
  updateMaterialTransportStatus,
  type FacilityStatus,
  saveShipInfo,
  type ShipInfo,
  startActiveTransport,
  updateActiveTransport,
  clearActiveTransport,
  getTrackingFilePath,
} from "./fuelServiceTracking.js";

const STATION_API_RATE_LIMIT_MS = 1000;
const factionStorageApiLastCalled: Map<string, number> = new Map();

// Empire station mapping
interface EmpireStation {
  systemId: string;
  poiId: string;
  poiName: string;
}

export const EMPIRE_STATIONS: Record<string, EmpireStation[]> = {
  solarian: [
    { systemId: "sol", poiId: "sol_central", poiName: "Confederacy Central Command" },
    { systemId: "alpha_centauri", poiId: "alpha_centauri_colonial_station", poiName: "Alpha Centauri Colonial Station" },
    { systemId: "sirius", poiId: "sirius_observatory_station", poiName: "Sirius Observatory Station" },
    { systemId: "nova_terra", poiId: "nova_terra_central", poiName: "Nova Terra Central" },
    { systemId: "procyon", poiId: "procyon_colonial_station", poiName: "Procyon Colonial Station" },
  ],
  voidborn: [
    { systemId: "nexus_prime", poiId: "the_core", poiName: "Central Nexus" },
    { systemId: "node_alpha", poiId: "node_alpha_processing_station", poiName: "Node Alpha Processing Station" },
    { systemId: "node_beta", poiId: "node_beta_industrial_station", poiName: "Node Beta Industrial Station" },
    { systemId: "synchrony", poiId: "synchrony_hub", poiName: "Synchrony Hub" },
  ],
  nebula: [
    { systemId: "gold_run", poiId: "gold_run_extraction_hub", poiName: "Gold Run Extraction Hub" },
    { systemId: "haven", poiId: "grand_exchange", poiName: "Grand Exchange Station" },
    { systemId: "cargo_lanes", poiId: "cargo_lanes_freight_depot", poiName: "Cargo Lanes Freight Depot" },
  ],
  crimson: [
    { systemId: "the_rampart", poiId: "the_rampart_checkpoint", poiName: "The Rampart Checkpoint" },
    { systemId: "the_crucible", poiId: "the_crucible_garrison", poiName: "The Crucible Garrison" },
    { systemId: "krynn", poiId: "war_citadel", poiName: "Crimson War Citadel" },
  ],
  outerrim: [
    { systemId: "last_light", poiId: "ramens_rest", poiName: "Ramen's Rest" },
    { systemId: "starfall", poiId: "starfall_salvage_station", poiName: "Starfall Salvage Station" },
  ],
};

function getEmpireForStation(stationId: string): string | null {
  for (const [empire, stations] of Object.entries(EMPIRE_STATIONS)) {
    if (stations.some(s => s.poiId === stationId)) {
      return empire;
    }
  }
  return null;
}

function getAllStationsForEmpire(empire: string): string[] {
  const stations = EMPIRE_STATIONS[empire.toLowerCase()];
  if (!stations) return [];
  return stations.map(s => `${s.systemId}|${s.poiId}`);
}

export function getAllStationsForEmpires(empireList: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const empire of empireList) {
    const stations = getAllStationsForEmpire(empire);
    for (const station of stations) {
      if (!seen.has(station)) {
        seen.add(station);
        result.push(station);
      }
    }
  }
  return result;
}

/** Rate-limited call to view_faction_storage for a station. */
async function getRemoteFactionFuelReserve(bot: Bot, stationId: string): Promise<{reserve: number; capacity: number}> {
   const now = Date.now();
   const lastCalled = factionStorageApiLastCalled.get(stationId) || 0;
   const elapsed = now - lastCalled;
   
   if (elapsed < STATION_API_RATE_LIMIT_MS) {
     await new Promise(resolve => setTimeout(resolve, STATION_API_RATE_LIMIT_MS - elapsed));
   }
   factionStorageApiLastCalled.set(stationId, Date.now());
   
   const resp = await bot.exec("view_faction_storage", { station_id: stationId });
   if (resp.error || !resp.result) return { reserve: 0, capacity: 0 };
   
   const result = resp.result as Record<string, unknown>;
   const reserve = (result.faction_fuel_reserve as number) || 0;
   const capacity = (result.faction_fuel_capacity as number) || 0;
   return { reserve, capacity };
}

async function getRemoteFactionStorage(bot: Bot, stationId: string): Promise<Record<string, number>> {
   const now = Date.now();
   const lastCalled = factionStorageApiLastCalled.get(stationId) || 0;
   const elapsed = now - lastCalled;
   
   if (elapsed < STATION_API_RATE_LIMIT_MS) {
     await new Promise(resolve => setTimeout(resolve, STATION_API_RATE_LIMIT_MS - elapsed));
   }
   factionStorageApiLastCalled.set(stationId, Date.now());
   
   const resp = await bot.exec("view_faction_storage", { station_id: stationId });
   if (resp.error || !resp.result) return {};
   
   const result = resp.result as Record<string, unknown>;
   const items = (result.items as Array<Record<string, unknown>>) || [];
   const qtyMap: Record<string, number> = {};
   for (const item of items) {
     const id = (item.item_id as string) || (item.itemId as string);
     qtyMap[id.toLowerCase()] = (item.quantity as number) || 0;
   }
   return qtyMap;
}

interface FuelServiceSettings {
  stations: string[];
  homeSystem: string;
  homeStation: string;
  facilityConfigs: Array<{ id: string; priority: number }>;
  refuelThreshold: number;
  repairThreshold: number;
  autoCloak: boolean;
  serviceAllEmpires: boolean;
  useAllStationsInEmpire: boolean;
  targetEmpires?: string[];
  refreshIntervalSec?: number;
}

interface FacilityDefinition {
  id: string;
  name: string;
  category?: string;
  build_materials?: Array<{ item_id: string; quantity: number }>;
  build_time?: number;
  recipe_id?: string;
  [key: string]: unknown;
}

interface FacilityInfo {
  facility_id: string;
  type: string;
  name: string;
  status: string;
}

interface CraftJobInfo {
  job_id: string;
  facility_id: string;
  recipe: string;
  runs_done: number;
  runs_remaining: number;
  progress: number;
  status: string;
}

function getFuelServiceSettings(botUsername?: string, botEmpire?: string): FuelServiceSettings {
  const all = readSettings();
  const general = all.general || {};
  const fs = all.fuel_service || {};
  // Per-bot overrides can be at both settings[bot].fuel_service and settings[bot] (top-level)
  const botOverrides = botUsername
    ? (all[botUsername as string] as Record<string, unknown> | undefined)?.fuel_service
    : undefined;
  const botTopLevel = botUsername
    ? (all[botUsername as string] as Record<string, unknown> | undefined)
    : undefined;

  let stations: string[] = ((botOverrides as Record<string, unknown>)?.stations as string[]) ||
    (fs.stations as string[]) ||
    [];
  const facilityConfigs = (fs.facilityConfigs as Array<{ id: string; priority: number }>) || [];

  const serviceAllEmpires = (fs.serviceAllEmpires as boolean) ?? false;
  // Check per-bot override first (at top-level), then global
  const useAllStationsInEmpire = (botTopLevel?.useAllStationsInEmpire as boolean) ??
    (fs.useAllStationsInEmpire as boolean) ?? false;

  // Expand stations list if useAllStationsInEmpire is enabled
  if (useAllStationsInEmpire && stations.length === 0) {
    // Determine which empires to use
    let empiresToUse: string[];
    if (serviceAllEmpires) {
      // Use all empires when serviceAllEmpires is true
      empiresToUse = Object.keys(EMPIRE_STATIONS);
    } else {
      // Use target empires (per-bot at top-level or fuel_service, or global)
      const perBotTargetEmpiresTop = (botTopLevel?.targetEmpires as string[]);
      const perBotTargetEmpires = (botOverrides as Record<string, unknown>)?.targetEmpires as string[];
      const globalTargetEmpires = (fs.targetEmpires as string[]);
      empiresToUse = perBotTargetEmpiresTop || perBotTargetEmpires || globalTargetEmpires || [botEmpire || ""];
    }
    stations = getAllStationsForEmpires(empiresToUse);
  }

  // Per-bot empire override - only used if serviceAllEmpires is false
  const targetEmpires = (botTopLevel?.targetEmpires as string[]) ||
    (fs.serviceAllEmpires !== true && (botOverrides as Record<string, unknown>)?.targetEmpires as string[]) ||
    undefined;

  return {
    stations,
    homeSystem: (general.factionStorageSystem as string) || "",
    homeStation: (general.factionStorageStation as string) || "",
    facilityConfigs,
    refuelThreshold: (fs.refuelThreshold as number) || 35,
    repairThreshold: (fs.repairThreshold as number) || 40,
    autoCloak: (fs.autoCloak as boolean) ?? false,
    serviceAllEmpires,
    useAllStationsInEmpire,
    targetEmpires,
    refreshIntervalSec: (fs.refreshIntervalSec as number) || 300,
  };
}

async function getFacilitiesAtStation(bot: Bot): Promise<FacilityInfo[]> {
  const resp = await bot.exec("facility", { action: "faction_list" });
  if (resp.error || !resp.result) {
    return [];
  }

  const result = resp.result as Record<string, unknown>;
  let facilities: Array<Record<string, unknown>> = [];
  if (Array.isArray(result.faction_facilities)) {
    facilities = result.faction_facilities;
  } else if (Array.isArray(result.facilities)) {
    facilities = result.facilities;
  } else if (Array.isArray(result)) {
    facilities = result;
  } else {
    const facilitiesKey = Object.keys(result).find(k => k.includes("facility"));
    if (facilitiesKey) {
      facilities = (result[facilitiesKey] as Array<Record<string, unknown>>) || [];
    }
  }

  return facilities.map(f => ({
    facility_id: (f.facility_id as string) || (f.id as string) || "",
    type: (f.type as string) || (f.facility_type as string) || "",
    name: (f.name as string) || "",
    status: (f.status as string) || "",
  }));
}

/** Read the bot's entire craft queue (all facilities, anywhere) via `craft action=queue`.
 *  Keyed by facility_id so a station's production can be checked without travelling to it. */
async function getGlobalCraftQueue(bot: Bot): Promise<Map<string, CraftJobInfo>> {
  const resp = await bot.exec("craft", { action: "queue" });
  if (resp.error || !resp.result) {
    return new Map();
  }

  const result = resp.result as Record<string, unknown>;
  const details = (result.details as Record<string, unknown>) || result;
  const jobs = (details.jobs as Array<Record<string, unknown>>) || (result.jobs as Array<Record<string, unknown>>) || [];

  const jobMap = new Map<string, CraftJobInfo>();
  for (const job of jobs) {
    const facilityId = (job.facility_id as string) || "";
    if (!facilityId) continue;
    jobMap.set(facilityId, {
      job_id: (job.job_id as string) || "",
      facility_id: facilityId,
      recipe: (job.recipe as string) || "",
      runs_done: (job.runs_done as number) || 0,
      runs_remaining: (job.runs_remaining as number) || 0,
      progress: (job.progress as number) || 0,
      status: (job.status as string) || "",
    });
  }
  return jobMap;
}

function getFacilityDefinition(facilityType: string): FacilityDefinition | null {
  const facilities = catalogStore.getAll().facilities;
  const facility = facilities[facilityType];
  if (facility) {
    return facility as FacilityDefinition;
  }
  for (const [id, f] of Object.entries(facilities)) {
    const catFac = f as Record<string, unknown>;
    if ((catFac.category as string) === "production" && id === facilityType) {
      return catFac as FacilityDefinition;
    }
  }
  return null;
}

function getRecipeForFacility(facilityType: string): string | null {
  const facility = getFacilityDefinition(facilityType);
  if (facility?.recipe_id) {
    return facility.recipe_id as string;
  }
  const recipeMap: Record<string, string> = {
    "peroxide_reaction_cell": "manufacture_fuel_h2o2",
    "hydrogen_processor": "extract_fuel_cell",
  };
  return recipeMap[facilityType] || null;
}

/** Output quantity per run for a recipe id (from catalog). Catalog stores it as
 *  `outputs[0].quantity` (e.g. extract_fuel_cell = 20, manufacture_fuel_h2o2 = 200). */
function getRecipeOutputQuantity(recipeId: string): number {
  const recipe = catalogStore.getAll().recipes[recipeId] as Record<string, unknown> | undefined;
  const outputs = (recipe?.outputs as Array<{ quantity?: number }>) || [];
  return (outputs[0]?.quantity as number) || 200;
}

/** Input components for a recipe id (from catalog). Catalog stores them as `inputs`
 *  (NOT `components`), normalised to lower-cased item ids. */
function getRecipeComponents(recipeId: string): Array<{ item_id: string; quantity: number }> {
  const recipe = catalogStore.getAll().recipes[recipeId] as Record<string, unknown> | undefined;
  const inputs = (recipe?.inputs as Array<{ item_id?: string; quantity?: number }>) || [];
  return inputs
    .map(c => ({ item_id: (c.item_id || "").toLowerCase(), quantity: c.quantity || 1 }))
    .filter(c => c.item_id);
}

interface OwnedShip {
  shipId: string;
  name: string;
  shipClass: string;
  speed: number;
  cargoCapacity: number;
}

async function listBotsShips(bot: Bot): Promise<OwnedShip[]> {
  const resp = await bot.exec("list_ships");
  if (resp.error || !resp.result) return [];

  const result = resp.result as Record<string, unknown>;
  const shipsRaw = result.ships as unknown;
  const ships = (Array.isArray(shipsRaw) ? shipsRaw : result) as Array<Record<string, unknown>>;
  if (!Array.isArray(ships)) return [];

  return ships.map((s) => ({
    shipId: (s.id as string) || (s.ship_id as string) || "",
    name: (s.name as string) || (s.ship_name as string) || "",
    shipClass: (s.ship_class as string) || (s.shipClass as string) || "",
    speed: (s.speed as number) || 1,
    cargoCapacity: (s.cargo_capacity as number) || (s.max_cargo as number) || 0,
  }));
}

async function switchToShip(bot: Bot, shipId: string): Promise<boolean> {
  const resp = await bot.exec("switch_ship", { ship_id: shipId });
  if (resp.error) {
    bot.log("system", `Failed to switch to ship ${shipId}: ${resp.error.message}`);
    return false;
  }
  await bot.refreshShip();
  return true;
}

async function updateShipInfoFromCurrent(bot: Bot): Promise<ShipInfo | null> {
  const resp = await bot.exec("get_ship");
  if (resp.error || !resp.result) return null;

  const result = resp.result as Record<string, unknown>;
  const ship = (result.ship as Record<string, unknown>) || result;

  const shipId = (ship.id as string) || "";
  if (!shipId) return null;

  const info: ShipInfo = {
    shipId,
    speed: (ship.speed as number) || 1,
    cargoCapacity: (ship.cargo_capacity as number) || (ship.max_cargo as number) || 0,
  };

  saveShipInfo(shipId, info);
  return info;
}

/** Pick the single best ship to run the whole routine with: prefer cargo capacity (for material
 *  transport), then speed as tie-breaker. The routine uses this one ship for the entire run — it
 *  no longer switches ships per-station, which previously teleported the bot between physically
 *  separate ships and caused endless back-and-forth travel. */
function selectBestLogisticsShip(ships: OwnedShip[]): OwnedShip | null {
  if (ships.length === 0) return null;
  return ships.reduce((best, ship) => {
    if (ship.cargoCapacity > best.cargoCapacity) return ship;
    if (ship.cargoCapacity === best.cargoCapacity && ship.speed > best.speed) return ship;
    return best;
  });
}

interface Recipe {
  recipe_id: string;
  name: string;
  components: Array<{ item_id: string; quantity: number }>;
  output_item_id: string;
  output_quantity: number;
  effective_time_per_run?: number;
}

function findRecipeForItem(itemId: string): Recipe | null {
  const recipes = catalogStore.getAll().recipes;
  for (const [id, r] of Object.entries(recipes)) {
    const recipe = r as Record<string, unknown>;
    const outputId = (recipe.output_item_id as string) || "";
    if (outputId === itemId) {
      const components = (recipe.components || recipe.ingredients || []) as Array<Record<string, unknown>>;
      return {
        recipe_id: id,
        name: (recipe.name as string) || id,
        components: components.map(c => ({
          item_id: (c.item_id as string) || "",
          quantity: (c.quantity as number) || 1,
        })),
        output_item_id: outputId,
        output_quantity: (recipe.output_quantity as number) || (recipe.output_per_run as number) || 1,
        effective_time_per_run: (recipe.effective_time_per_run as number) || 0,
      };
    }
  }
  return null;
}

function calculateMaxCraftableAtHome(storage: Record<string, number>, recipe: Recipe): number {
  let maxRuns = Infinity;
  for (const comp of recipe.components) {
    const available = storage[comp.item_id?.toLowerCase()] || 0;
    const neededPerRun = comp.quantity;
    const runsPossible = Math.floor(available / neededPerRun);
    maxRuns = Math.min(maxRuns, runsPossible);
  }
  return maxRuns === Infinity ? 0 : maxRuns;
}

async function craftItemAtHome(
  ctx: RoutineContext,
  bot: Bot,
  itemId: string,
  quantity: number,
  homeStation: string,
): Promise<boolean> {
  const recipe = findRecipeForItem(itemId);
  if (!recipe) {
    ctx.log("craft", `No recipe found for ${itemId}`);
    return false;
  }

  const homeStorage = await getRemoteFactionStorage(bot, homeStation);
  const maxCraftable = calculateMaxCraftableAtHome(homeStorage, recipe);
  const runs = Math.ceil(quantity / (recipe.output_quantity || 1));
  const actualRuns = Math.min(runs, maxCraftable);

  if (actualRuns <= 0) {
    ctx.log("craft", `Cannot craft ${itemId}: insufficient materials at home`);
    return false;
  }

  ctx.log("craft", `Crafting ${actualRuns} runs of ${recipe.recipe_id} at home...`);
  const resp = await bot.exec("craft", { id: recipe.recipe_id, quantity: actualRuns * (recipe.output_quantity || 1), preset: "fast" });
  return !resp.error;
}

async function buildFacilityAtStation(
   ctx: RoutineContext,
   bot: Bot,
   stationId: string,
   facilityType: string,
   homeStation: string,
   homeSystem: string,
   autoCloak: boolean,
  ): Promise<boolean> {
   const facility = getFacilityDefinition(facilityType);
   if (!facility) {
     ctx.log("error", `Facility definition not found for ${facilityType}`);
     return false;
   }

   const buildMaterials = (facility.build_materials as Array<{ item_id: string; quantity: number }>) || [];
   if (buildMaterials.length === 0) {
     ctx.log("error", `No build materials defined for ${facilityType}`);
     return false;
   }

   const failures = incrementBuildFailures(stationId, facilityType);
   if (failures >= 3) {
     ctx.log("error", `Facility ${facilityType} at ${stationId} has failed ${failures} times - giving up`);
     return false;
   }

   // Check home station faction storage for materials and craft if needed
   for (const material of buildMaterials) {
     const itemId = material.item_id;
     const neededQty = material.quantity;

     const homeStorage = await getRemoteFactionStorage(bot, homeStation);
     const haveQty = homeStorage[itemId.toLowerCase()] || 0;

     if (haveQty < neededQty) {
       const needToCraft = neededQty - haveQty;
       ctx.log("fuel", `Need to craft ${needToCraft}x ${itemId} for facility build`);
       const craftOk = await craftItemAtHome(ctx, bot, itemId, needToCraft, homeStation);
       if (!craftOk) {
         ctx.log("error", `Failed to craft ${needToCraft}x ${itemId}`);
         return false;
       }
       // Re-fetch storage after crafting to verify
       const refreshedStorage = await getRemoteFactionStorage(bot, homeStation);
       const refreshedQty = refreshedStorage[itemId.toLowerCase()] || 0;
       if (refreshedQty < neededQty) {
         ctx.log("error", `Crafting didn't provide enough ${itemId}`);
         return false;
       }
     }
   }

    // Transport materials to target station (if not home station)
    if (stationId !== homeStation) {
      // Enable cloak if requested and not already cloaked
      if (autoCloak && !bot.isCloaked && bot.fuel > 0) {
        const shipResp = await bot.exec("get_ship");
        if (shipResp.result) {
          const { modules } = extractShipModules(shipResp.result);
          const hasCloak = modules.some(mod => moduleHaystack(mod).includes("cloak"));
          if (hasCloak) {
            ctx.log("fuel", "Enabling cloak for transport...");
            await bot.exec("cloak", { enable: true });
          }
        }
      }

      ctx.log("fuel", `Withdrawing build materials from ${homeStation} for transport to ${stationId}...`);
      if (bot.system !== homeSystem || bot.poi !== homeStation || !bot.docked) {
        await navigateToStation(ctx, homeSystem, homeStation);
        if (bot.state !== "running") return false;
      }

// Check for existing active transport and resume if needed
      const existingState = getFacilityState(stationId, facilityType);
      let activeTransport = existingState?.activeTransport;
      if (activeTransport && existingState) {
        ctx.log("fuel", `Resuming active transport for ${stationId}: ${activeTransport.items.length} items, current index ${activeTransport.currentItemIndex}`);
        await bot.refreshCargo();
        // Sync withdrawnQty from state into items array and account for cargo already in bot
        const savedMaterials = existingState.materialTransport || {};
        for (let i = 0; i < activeTransport.items.length; i++) {
          const savedItem = savedMaterials[activeTransport.items[i].itemId];
          if (savedItem?.withdrawnQty !== undefined) {
            activeTransport.items[i].withdrawnQty = savedItem.withdrawnQty;
          }
          // Also sync depositedQty
          if (savedItem?.depositedQty !== undefined) {
            activeTransport.items[i].depositedQty = savedItem.depositedQty;
          }
          // Account for cargo already in bot's inventory
          const item = activeTransport.items[i];
          const inBot = bot.inventory.find(inv => inv.itemId === item.itemId)?.quantity || 0;
          if (inBot > 0 && (item.withdrawnQty || 0) < inBot) {
            // Bot has cargo that wasn't recorded - sync it
            item.withdrawnQty = inBot;
            ctx.log("fuel", `Syncing ${item.itemId}: ${inBot} units already in cargo`);
          }
        }
      } else {
        // Start new transport
        activeTransport = startActiveTransport(stationId, facilityType, homeStation, homeSystem,
          buildMaterials.map(m => ({ itemId: m.item_id, neededQty: m.quantity }))
        );
        // Seed the per-item material transport tracker so progress is visible/auditable.
        for (const m of buildMaterials) {
          updateMaterialTransportStatus(stationId, facilityType, m.item_id, {
            neededQty: m.quantity, inCargo: 0, withdrawnQty: 0, depositedQty: 0, status: "withdrawing",
          });
        }
        ctx.log("fuel", `Starting new transport for ${stationId}: ${activeTransport.items.length} items`);
        ctx.log("fuel", `State file: ${getTrackingFilePath()}`);
      }

      // Helper to check if all items are fully transported and deposited
      const allItemsComplete = () => activeTransport.items.every(i => {
        const withdrawn = i.withdrawnQty || 0;
        const deposited = i.depositedQty || 0;
        return withdrawn >= i.neededQty && deposited >= withdrawn;
      });

      // Transport loop - continue until all items are withdrawn AND deposited
      while (bot.state === "running" && !allItemsComplete()) {
        // Refresh ship and cargo to ensure we have accurate data
        await bot.refreshShip();
        await bot.refreshCargo();

        // Navigate to home station if not already there
        if (bot.system !== homeSystem || bot.poi !== homeStation || !bot.docked) {
          if (bot.system !== homeSystem || bot.poi !== homeStation) {
            await navigateToStation(ctx, homeSystem, homeStation);
            if (bot.state !== "running") break;
          }
          if (!bot.docked) {
            const dockResp = await bot.exec("dock");
            if (dockResp.error && !dockResp.error.message.includes("already")) {
              ctx.log("error", `Dock at home station failed: ${dockResp.error.message}`);
              break;
            }
            bot.docked = true;
          }
        }

        // Withdraw phase - get materials from faction storage.
        // Reset the item cursor each pass so partial-load deposits (cargo too small for a full qty)
        // resume withdrawing the remaining amount instead of being skipped.
        activeTransport.currentItemIndex = 0;
        while (activeTransport.currentItemIndex < activeTransport.items.length && !allItemsComplete()) {
          const item = activeTransport.items[activeTransport.currentItemIndex];
          const itemId = item.itemId;
          const qty = item.neededQty;
          const inCargo = bot.inventory.find(i => i.itemId === itemId)?.quantity || 0;
          const alreadyWithdrawn = item.withdrawnQty || 0;
          // withdrawnQty already accounts for cargo pulled from storage, so do NOT subtract inCargo
          // again (that double-counts and under-withdraws when a single load can't hold the full qty).
          const stillNeeded = Math.max(0, qty - alreadyWithdrawn);

          if (stillNeeded <= 0) {
            activeTransport.currentItemIndex++;
            updateActiveTransport(stationId, facilityType, { items: activeTransport.items });
            continue;
          }

          // Calculate current cargo weight
          let currentCargoWeight = 0;
          for (const invItem of bot.inventory) {
            currentCargoWeight += invItem.quantity * getItemSize(invItem.itemId);
          }
          // Also use bot.cargo as a fallback for free space calculation
          const cargoUnitsInBot = bot.cargo || 0;
          const freeSpace = Math.max(0, (bot.cargoMax || 0) - Math.max(currentCargoWeight, cargoUnitsInBot));
          const itemSize = getItemSize(itemId);
          const maxCanCarry = Math.floor(freeSpace / itemSize);
          const withdrawQty = Math.min(stillNeeded, maxCanCarry);

          ctx.log("fuel", `Cargo check for ${itemId}: max=${bot.cargoMax}, currentWeight=${currentCargoWeight}, cargoUnits=${cargoUnitsInBot}, free=${freeSpace}, size=${itemSize}, canCarry=${maxCanCarry}, inCargo=${inCargo}, withdrawn=${alreadyWithdrawn}, stillNeeded=${stillNeeded}`);

          if (withdrawQty <= 0) {
            // Cargo full for other items - go deposit and return later
            ctx.log("fuel", `Cargo full - going to deposit and return for more ${itemId}...`);
            break;
          }

          const withdrawResp = await bot.exec("storage", {
            action: "withdraw",
            target: "faction",
            item_id: itemId,
            quantity: withdrawQty,
            station_id: homeStation,
          });
          if (withdrawResp.error) {
            ctx.log("error", `Withdraw failed for ${itemId}: ${withdrawResp.error.message}`);
            break;
          }

          await bot.refreshCargo();
          const afterQty = bot.inventory.find(i => i.itemId === itemId)?.quantity || 0;
          const actuallyWithdrawn = afterQty - inCargo;
          if (actuallyWithdrawn < 0) {
            ctx.log("error", `Unexpected cargo decrease for ${itemId}`);
            break;
          }

          item.withdrawnQty = (item.withdrawnQty || 0) + actuallyWithdrawn;
          updateActiveTransport(stationId, facilityType, { items: activeTransport.items });
          const curInCargo = bot.inventory.find(i => i.itemId === itemId)?.quantity || 0;
          updateMaterialTransportStatus(stationId, facilityType, itemId, {
            withdrawnQty: item.withdrawnQty, inCargo: curInCargo, status: "in_transit",
          });
          ctx.log("fuel", `Withdrew ${actuallyWithdrawn} units of ${itemId}, total now: ${item.withdrawnQty}/${qty}`);
        }

        // Navigate to target station to deposit
        ctx.log("fuel", `Navigating to ${stationId} to deposit build materials...`);
        const parts = stationId.includes("|") ? stationId.split("|") : [homeSystem, stationId];
        await navigateToStation(ctx, parts[0], stationId);
        if (bot.state !== "running") break;

        // Deposit phase - deposit what we have in cargo
        activeTransport.currentItemIndex = 0;
        while (activeTransport.currentItemIndex < activeTransport.items.length) {
          const item = activeTransport.items[activeTransport.currentItemIndex];
          const itemId = item.itemId;
          const inCargo = bot.inventory.find(i => i.itemId === itemId)?.quantity || 0;
          const alreadyDeposited = item.depositedQty || 0;
          const withdrawn = item.withdrawnQty || 0;

          // Skip only if everything we withdrew has already been deposited (also covers items not
          // yet withdrawn, where both are 0). The previous `withdrawn >= neededQty` clause wrongly
          // skipped fully-withdrawn items that still needed depositing, so they were never deposited.
          if (alreadyDeposited >= withdrawn) {
            item.depositedQty = Math.max(alreadyDeposited, inCargo);
            activeTransport.currentItemIndex++;
            updateActiveTransport(stationId, facilityType, { items: activeTransport.items, currentItemIndex: activeTransport.currentItemIndex });
            continue;
          }

          if (inCargo === 0) {
            activeTransport.currentItemIndex++;
            updateActiveTransport(stationId, facilityType, { items: activeTransport.items, currentItemIndex: activeTransport.currentItemIndex });
            continue;
          }

          ctx.log("fuel", `Depositing ${inCargo}x ${itemId} to ${stationId}...`);
          const depositResp = await bot.exec("faction_deposit_items", {
            item_id: itemId,
            quantity: inCargo,
            station_id: stationId,
          });
          if (depositResp.error) {
            const personalResp = await bot.exec("deposit_items", {
              item_id: itemId,
              quantity: inCargo,
              station_id: stationId,
            });
            if (personalResp.error) {
              ctx.log("error", `Deposit failed for ${itemId}: ${personalResp.error.message}`);
              // Abort the transport rather than looping forever on a persistent deposit failure.
              return false;
            }
          }
          await ctx.sleep(500);
          await bot.refreshCargo();

          item.depositedQty = (item.depositedQty || 0) + inCargo;
          activeTransport.currentItemIndex++;
          updateActiveTransport(stationId, facilityType, { items: activeTransport.items, currentItemIndex: activeTransport.currentItemIndex });
          const depDone = (item.depositedQty >= item.neededQty) || (item.depositedQty >= item.withdrawnQty && item.withdrawnQty >= item.neededQty);
          updateMaterialTransportStatus(stationId, facilityType, itemId, {
            depositedQty: item.depositedQty, inCargo: 0, status: depDone ? "complete" : "depositing",
          });
        }

        if (bot.state !== "running") break;
      }

      // Clear active transport when done
      clearActiveTransport(stationId, facilityType);
      if (allItemsComplete()) {
        ctx.log("fuel", `Transport complete for ${stationId}`);
      } else {
        ctx.log("fuel", `Transport interrupted for ${stationId}`);
        return false;
      }
    }

    ctx.log("fuel", `Issuing facility_build for ${facilityType} at ${stationId}`);
    const buildResp = await bot.exec("facility", { action: "faction_build", facility_type: facilityType });
    if (buildResp.error) {
      ctx.log("error", `facility_build failed: ${buildResp.error.message}`);
      return false;
    }

    resetBuildFailures(stationId, facilityType);
    return true;
  }

/** Queue fuel production by issuing the recipe's `craft` command while docked at the station.
 *  This auto-queues the station's facility (same as `facility job_add`) but, unlike job_add,
 *  its status is visible from anywhere via the global craft queue. */
async function queueFuelProduction(
   ctx: RoutineContext,
   bot: Bot,
   recipeId: string,
   quantity: number
 ): Promise<boolean> {
   const resp = await bot.exec("craft", {
     id: recipeId,
     quantity,
     preset: "fast",
   });

    if (resp.error) {
      const msg = resp.error.message;
      if (/not enough materials/i.test(msg)) {
        // Intentionally surfaced (not silently chopped): the station lacks inputs, so the
        // caller can skip / wait for materials to be deposited into station storage.
        ctx.log("warn", `craft queue for ${recipeId}: insufficient input materials - skipping (deposit inputs into station storage first)`);
      } else {
        ctx.log("error", `craft queue failed for ${recipeId}: ${msg}`);
      }
      return false;
    }
    return true;
 }

export const fuelServiceRoutine: Routine = async function* (ctx: RoutineContext) {
   const { bot } = ctx;

   while (bot.state !== "running") {
     await ctx.sleep(2000);
   }

   const alive = await detectAndRecoverFromDeath(ctx);
   if (!alive) {
     await ctx.sleep(30000);
     yield "death_recovery";
     return;
   }

   const settings = getFuelServiceSettings(bot.username, bot.getEmpire());
   const safetyOpts = {
     fuelThresholdPct: settings.refuelThreshold,
     hullThresholdPct: settings.repairThreshold,
     autoCloak: settings.autoCloak,
   };

   if (!settings.homeSystem || !settings.homeStation) {
     ctx.log("error", "Fuel Service: General > Faction Storage System and Station must be set");
     yield "config_error";
     await ctx.sleep(60000);
     return;
   }

   if (settings.stations.length === 0) {
     ctx.log("warn", "Fuel Service: No stations configured");
     yield "no_stations";
     await ctx.sleep(60000);
     return;
   }

   if (settings.facilityConfigs.length === 0) {
     ctx.log("warn", "Fuel Service: No facility types configured");
yield "no_facilities";
      await ctx.sleep(60000);
      return;
    }

    ctx.log("fuel", `Fuel Service started: ${settings.stations.length} stations, ${settings.facilityConfigs.length} facility types`);

    await updateShipInfoFromCurrent(bot);
    const ownedShips = await listBotsShips(bot);
    // Select the best logistics ship ONCE at startup and use it for the whole routine.
    // (Previously the routine switched ships per-station, which teleported the bot between
    //  physically separate ships and caused endless back-and-forth travel.)
    const bestShip = selectBestLogisticsShip(ownedShips);
    if (bestShip && bestShip.shipId !== bot.shipId && bot.docked) {
      ctx.log("fuel", `Selecting logistics ship ${bestShip.name} for fuel service runs`);
      await switchToShip(bot, bestShip.shipId);
      await updateShipInfoFromCurrent(bot);
    }

    await ensureDocked(ctx);
    await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
    await repairShip(ctx);

    while (bot.state === "running") {
      yield "cycle_start";

      if (bot.state !== "running") { ctx.log("system", "Stopping"); return; }

      if (await checkAndFleeFromBattle(ctx, "fuel_service")) {
        yield "battle_flee";
        await ctx.sleep(5000);
        continue;
      }

      const facilities = settings.facilityConfigs.sort((a, b) => a.priority - b.priority);

      // Read the bot's entire craft queue once per cycle (readable from anywhere) so we can decide
      // which stations actually need a visit without travelling to each of them.
      const globalJobs = await getGlobalCraftQueue(bot);

      for (const facilityConfig of facilities) {
        if (bot.state !== "running") break;

        const facilityType = facilityConfig.id;
        const recipeId = getRecipeForFacility(facilityType);
        if (!recipeId) {
          ctx.log("error", `Could not find recipe for facility ${facilityType}`);
          continue;
        }

        for (const stationRef of settings.stations) {
          if (bot.state !== "running") break;

          // Parse station reference (format: "system|poiId" or just "poiId")
          const parts = stationRef.includes("|") ? stationRef.split("|") : [settings.homeSystem, stationRef];
          const targetSystem = parts[0];
          const stationId = parts[1];

          // Empire filtering: skip if station not in target empire
          if (!settings.serviceAllEmpires) {
            const stationEmpire = getEmpireForStation(stationId);
            const botEmpire = bot.getEmpire();
            const allowedEmpires = settings.targetEmpires || [botEmpire];

            if (stationEmpire && !allowedEmpires.includes(stationEmpire) && !allowedEmpires.includes(stationEmpire.toLowerCase())) {
              ctx.log("fuel", `Skipping station ${stationId} (empire: ${stationEmpire}) - not in target empires: ${allowedEmpires.join(", ")}`);
              continue;
            }

            if (!stationEmpire && stationId !== settings.homeStation) {
              ctx.log("fuel", `Skipping unknown station ${stationId} (could not determine empire)`);
              continue;
            }
          }

          const state = getFacilityState(stationId, facilityType) || {
            stationId: stationId,
            facilityType,
            facilityBuilt: false,
            facilityUnderConstruction: false,
            craftJobRecipeId: recipeId,
            craftJobRunsDone: 0,
            craftJobRunsTotal: 0,
            lastCraftJobCheck: 0,
            lastQueuedRuns: 0,
            status: "pending_facility" as FacilityStatus,
            buildFailures: 0,
            buildIssuedAt: undefined,
          };

          const needBuild = !state.facilityBuilt;
          let needVisit = needBuild;

          // For already-built facilities, decide REMOTELY (global craft queue + remote fuel reserve)
          // whether a visit is needed at all. This avoids travelling to a station just to discover it
          // is already full and producing.
          if (!needBuild) {
            const outputPerRun = getRecipeOutputQuantity(recipeId);
            const targetFuel = 500000;

            const { reserve: haveFuel } = await getRemoteFactionFuelReserve(bot, stationId);
            const runsNeeded = Math.max(0, Math.ceil((targetFuel - haveFuel) / outputPerRun));

            const activeJob = state.facilityId ? globalJobs.get(state.facilityId) : undefined;
            const hasActiveJob = !!activeJob && activeJob.runs_remaining > 0;

            if (runsNeeded <= 0) {
              ctx.log("fuel", `${facilityType} at ${stationId}: fuel ${haveFuel}/${targetFuel} - at target, skipping`);
              continue;
            }
            if (hasActiveJob) {
              ctx.log("fuel", `${facilityType} at ${stationId}: job active (${activeJob.runs_remaining} runs remaining) - skipping visit`);
              continue;
            }

            // Below target with no active job: queue production. Verify the station has the input
            // materials (remote check) so we don't travel there for nothing.
            const remoteStorage = await getRemoteFactionStorage(bot, stationId);
            const components = getRecipeComponents(recipeId);
            let materialsPresent = components.length === 0;
            for (const comp of components) {
              const available = remoteStorage[comp.item_id] || 0;
              const runsForComp = Math.floor(available / comp.quantity);
              ctx.log("fuel", `  Material ${comp.item_id}: ${available} available, ${comp.quantity} per run (${runsForComp} runs possible)`);
              if (runsForComp <= 0) materialsPresent = false;
            }
            if (!materialsPresent) {
              ctx.log("fuel", `${facilityType} at ${stationId}: need ${runsNeeded} runs but no input materials at station - skipping`);
              continue;
            }
            needVisit = true;
          }

          if (!needVisit) continue;

          // Travel to the station (to build, or to issue the craft command that queues the facility).
          if (bot.system !== targetSystem || bot.poi !== stationId) {
            await navigateToStation(ctx, targetSystem, stationId);
            if (bot.state !== "running") break;
          }
          if (bot.docked) {
            await tryRefuel(ctx, { skipApprovedCheck: true });
          }

          const facilitiesAtStation = await getFacilitiesAtStation(bot);
          const existingFacility = facilitiesAtStation.find(f => f.type === facilityType && f.facility_id);

          if (existingFacility?.facility_id) {
            state.facilityId = existingFacility.facility_id;
            state.facilityBuilt = true;
            state.facilityUnderConstruction = false;
            state.buildIssuedAt = undefined;
            state.status = "monitoring";
          } else if (state.facilityBuilt && state.facilityId) {
            // Previously built and confirmed, but not visible this cycle (transient) - keep as built.
            state.status = "monitoring";
          } else {
            // Not built yet. Preserve the under-construction flag that is set when a build is issued,
            // otherwise the build would be re-issued every cycle (facilities take build_time to appear).
            state.facilityBuilt = false;
            if (!state.facilityUnderConstruction) {
              state.status = "pending_facility";
            } else {
              state.status = "building_facility";
            }
          }

          if (!state.facilityBuilt) {
            if (state.facilityUnderConstruction) {
              const transportInProgress = getFacilityState(stationId, facilityType)?.activeTransport;
              if (transportInProgress) {
                // Materials still being moved to the station; buildFacilityAtStation resumes it.
                ctx.log("fuel", `${facilityType} at ${stationId} material transport in progress - resuming`);
              } else {
                // Transport done and faction_build issued. The facility won't appear in faction_list
                // until build_time elapses. Poll while it's plausibly still constructing; only treat as
                // stale (and re-attempt) if no build timestamp was recorded or build_time + buffer passed.
                const buildTimeMs = (getFacilityDefinition(facilityType)?.build_time || 0) * 1000;
                const elapsed = state.buildIssuedAt ? Date.now() - state.buildIssuedAt : Infinity;
                const stale = state.buildIssuedAt == null ||
                  elapsed > Math.max(buildTimeMs + 60000, 3600000);
                if (stale) {
                  ctx.log("fuel", `${facilityType} at ${stationId} build not confirmed within expected time - re-attempting`);
                  state.facilityUnderConstruction = false;
                } else {
                  state.status = "building_facility";
                  saveFacilityState(state);
                  yield `building_${facilityType}_${stationId}`;
                  continue;
                }
              }
            }

            state.status = "building_facility";
            saveFacilityState(state);
            yield `build_${facilityType}_${stationId}`;

            ctx.log("fuel", `Building ${facilityType} at ${stationId} (materials from ${settings.homeStation})`);

            const built = await buildFacilityAtStation(ctx, bot, stationId, facilityType, settings.homeStation, settings.homeSystem, settings.autoCloak);
            if (built) {
              // faction_build succeeded; server is now constructing. It will appear in faction_list
              // (and thus be confirmed built) after build_time elapses. Do NOT mark it built yet.
              state.facilityUnderConstruction = true;
              state.buildIssuedAt = Date.now();
              state.status = "building_facility";
            } else {
              // Build did not complete this cycle; allow a retry next cycle.
              state.facilityUnderConstruction = false;
            }
            saveFacilityState(state);
            continue;
          }

          // Facility is built and we already decided (remotely) it needs more production. Issue the
          // recipe's `craft` command while docked - this auto-queues the station's facility, and its
          // status is visible from anywhere via the global craft queue.
          //
          // The `craft` command's `quantity` is the TOTAL OUTPUT (fuel_reserve units), not a run count
          // (e.g. extract_fuel_cell = 20 units/run, so quantity:200 => 10 runs). Passing the full amount
          // needed means the server fills to target, or errors "Not enough materials" when inputs are
          // short (which we surface rather than silently under-filling).
          const outputPerRun = getRecipeOutputQuantity(recipeId);
          const targetFuel = 500000;
          const maxRunsPerJob = 10000;

          const { reserve: haveFuel } = await getRemoteFactionFuelReserve(bot, stationId);
          const activeJob = state.facilityId ? globalJobs.get(state.facilityId) : undefined;
          const queuedUnits = activeJob && activeJob.runs_remaining > 0
            ? activeJob.runs_remaining * outputPerRun
            : 0;

          const unitsNeeded = Math.max(0, targetFuel - haveFuel - queuedUnits);
          if (unitsNeeded <= 0) {
            ctx.log("fuel", `${facilityType} at ${stationId}: fuel ${haveFuel + queuedUnits}/${targetFuel} (incl. queued) - at target, skipping`);
            saveFacilityState(state);
            continue;
          }

          // Cap a single job at maxRunsPerJob so we don't push one enormous queue; remaining gap is
          // filled on subsequent cycles. The server still errors if station inputs can't cover this.
          const maxUnitsPerJob = maxRunsPerJob * outputPerRun;
          const quantity = Math.min(unitsNeeded, maxUnitsPerJob);
          const runsForLog = Math.ceil(quantity / outputPerRun);

          ctx.log("fuel", `Queueing ${quantity} output units of ${recipeId} (${runsForLog} runs) at ${stationId} via craft command`);
          const queued = await queueFuelProduction(ctx, bot, recipeId, quantity);
          if (queued) {
            state.lastQueuedRuns = runsForLog;
            state.craftJobRecipeId = recipeId;
            state.status = "monitoring";
          }
          saveFacilityState(state);
        }
      }

      await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
      await repairShip(ctx);

      const refreshMs = (settings.refreshIntervalSec || 300) * 1000;
      ctx.log("fuel", `Fuel service cycle complete - waiting ${settings.refreshIntervalSec || 300} seconds...`);
      yield "maintenance";
      await ctx.sleep(refreshMs);
    }
  };

  /** Navigate bot to target station system and dock. */
  async function navigateToStation(ctx: RoutineContext, targetSystem: string, stationId: string): Promise<boolean> {
    const { bot } = ctx;

    if (bot.system !== targetSystem) {
      ctx.log("travel", `Navigating to ${targetSystem} for fuel service...`);
      const route = mapStore.findRoute(bot.system, targetSystem);
      if (route && route.length > 1) {
        for (let i = 1; i < route.length; i++) {
          if (bot.state !== "running") return false;
          ctx.log("travel", `Jumping to ${route[i]} (${i}/${route.length - 1})...`);
          const jumpResp = await bot.exec("jump", { target_system: route[i] });
          if (jumpResp.error) {
            ctx.log("error", `Jump failed: ${jumpResp.error.message}`);
            await bot.refreshLocation();
            if (bot.system.toLowerCase() !== route[i].toLowerCase()) {
              return false;
            }
          }
          await bot.refreshLocation();
        }
      } else {
        const jumpResp = await bot.exec("jump", { target_system: targetSystem });
        if (jumpResp.error && !jumpResp.error.message.includes("already")) {
          ctx.log("error", `Jump failed: ${jumpResp.error.message}`);
          return false;
        }
        await bot.refreshLocation();
      }
    }

    // Travel to station and dock
    if (bot.poi !== stationId) {
      ctx.log("travel", `Traveling to ${stationId}...`);
      const travelResp = await bot.exec("travel", { target_poi: stationId });
      if (travelResp.error && !travelResp.error.message.includes("already")) {
        ctx.log("error", `Travel failed: ${travelResp.error.message}`);
        return false;
      }
      bot.poi = stationId;
    }

    if (!bot.docked) {
      const dockResp = await bot.exec("dock");
      if (dockResp.error && !dockResp.error.message.includes("already")) {
        ctx.log("error", `Dock failed: ${dockResp.error.message}`);
        return false;
      }
      bot.docked = true;
    }

    return true;
  }