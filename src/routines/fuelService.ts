import type { Bot, Routine, RoutineContext } from "../bot.js";
import { catalogStore } from "../catalogstore.js";
import { mapStore } from "../mapstore.js";
import {
  ensureFueled,
  repairShip,
  detectAndRecoverFromDeath,
  readSettings,
  checkAndFleeFromBattle,
} from "./common.js";
import {
  getFacilityState,
  saveFacilityState,
  incrementBuildFailures,
  resetBuildFailures,
  type FacilityStatus,
} from "./fuelServiceTracking.js";

const STATION_API_RATE_LIMIT_MS = 1000;
const factionStorageApiLastCalled: Map<string, number> = new Map();

// Empire station mapping
interface EmpireStation {
  systemId: string;
  poiId: string;
  poiName: string;
}

const EMPIRE_STATIONS: Record<string, EmpireStation[]> = {
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

function getAllStationsForEmpires(empireList: string[]): string[] {
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

async function getFacilityJobs(bot: Bot, facilityIds: string[]): Promise<Map<string, CraftJobInfo>> {
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
    if (facilityIds.includes(facilityId)) {
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
  const resp = await bot.exec("craft", { id: recipe.recipe_id, quantity: actualRuns, preset: "fast" });
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
         const shipData = shipResp.result as Record<string, unknown>;
         const modules = Array.isArray(shipData.modules) ? shipData.modules : [];
         const hasCloak = modules.some((mod: unknown) => {
           const m = typeof mod === "object" && mod !== null ? mod as Record<string, unknown> : {};
           const id = (m?.id as string) || (m?.type_id as string) || "";
           const name = (m?.name as string) || "";
           const special = (m?.special as string) || "";
           const checkStr = `${id.toLowerCase()} ${name.toLowerCase()} ${special.toLowerCase()}`;
           return checkStr.includes("cloak");
         });
         if (hasCloak) {
           ctx.log("fuel", "Enabling cloak for transport...");
           await bot.exec("cloak", { enable: true });
         }
       }
     }

     ctx.log("fuel", `Transporting build materials to ${stationId}...`);
     if (bot.system !== homeSystem || bot.poi !== homeStation || !bot.docked) {
       await navigateToStation(ctx, homeSystem, homeStation);
       if (bot.state !== "running") return false;
     }

     // Withdraw each material from home faction storage
     for (const material of buildMaterials) {
       const itemId = material.item_id;
       const qty = material.quantity;

       // Check if already in cargo
       const inCargo = bot.inventory.find(i => i.itemId === itemId)?.quantity || 0;
       if (inCargo >= qty) continue;

       // Withdraw from faction storage
       const withdrawQty = qty;
       ctx.log("fuel", `Withdrawing ${withdrawQty}x ${itemId} from home...`);
       const withdrawResp = await bot.exec("storage", {
         action: "withdraw",
         target: "faction",
         item_id: itemId,
         quantity: withdrawQty,
         station_id: homeStation,
       });
       if (withdrawResp.error) {
         ctx.log("error", `Withdraw failed for ${itemId}: ${withdrawResp.error.message}`);
         return false;
       }

       // Wait for cargo update
       for (let attempt = 0; attempt < 5; attempt++) {
         await ctx.sleep(1000);
         await bot.refreshCargo();
         const afterQty = bot.inventory.find(i => i.itemId === itemId)?.quantity || 0;
         if (afterQty >= qty) break;
       }
     }

     // Navigate back to target station
     const stationParts = stationId.split("|").length > 1 ? stationId.split("|") : [null, stationId];
     const targetSys = stationParts[0] || stationId;
     await navigateToStation(ctx, targetSys, stationId);
     if (bot.state !== "running") return false;

     // Deposit to target faction storage
     for (const material of buildMaterials) {
       const itemId = material.item_id;

       const inCargo = bot.inventory.find(i => i.itemId === itemId)?.quantity || 0;
       if (inCargo === 0) continue;

       ctx.log("fuel", `Depositing ${inCargo}x ${itemId} to ${stationId}...`);
       const depositResp = await bot.exec("faction_deposit_items", {
         item_id: itemId,
         quantity: inCargo,
         station_id: stationId,
       });
       if (depositResp.error) {
         // Fall back to personal storage
         const personalResp = await bot.exec("deposit_items", {
           item_id: itemId,
           quantity: inCargo,
           station_id: stationId,
         });
         if (personalResp.error) {
           ctx.log("error", `Deposit failed for ${itemId}: ${personalResp.error.message}`);
           return false;
         }
       }
       await ctx.sleep(500);
       await bot.refreshCargo();
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

async function queueFuelProduction(
   ctx: RoutineContext,
   bot: Bot,
   facilityId: string,
   recipeId: string,
   quantity: number
 ): Promise<boolean> {
   ctx.log("fuel", `Queueing ${quantity}x ${recipeId} at facility ${facilityId}`);
   const resp = await bot.exec("facility", {
     action: "job_add",
     facility_id: facilityId,
     recipe_id: recipeId,
     quantity,
   });

   if (resp.error) {
     ctx.log("error", `job_add failed: ${resp.error.message}`);
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

   while (bot.state === "running") {
     yield "cycle_start";

     if (bot.state !== "running") { ctx.log("system", "Stopping"); return; }

     if (await checkAndFleeFromBattle(ctx, "fuel_service")) {
       yield "battle_flee";
       await ctx.sleep(5000);
       continue;
     }

     const facilities = settings.facilityConfigs.sort((a, b) => a.priority - b.priority);

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
         const targetStation = parts[1];

         // Empire filtering: skip if station not in target empire
         if (!settings.serviceAllEmpires) {
           const stationEmpire = getEmpireForStation(targetStation);
           const botEmpire = bot.getEmpire();
           const allowedEmpires = settings.targetEmpires || [botEmpire];
           
           // Station empire must be in allowed list
           if (stationEmpire && !allowedEmpires.includes(stationEmpire) && !allowedEmpires.includes(stationEmpire.toLowerCase())) {
             ctx.log("fuel", `Skipping station ${targetStation} (empire: ${stationEmpire}) - not in target empires: ${allowedEmpires.join(", ")}`);
             continue;
           }
           
           // Bot's own empire is always allowed for home base operations
           if (!stationEmpire && targetStation !== settings.homeStation) {
             ctx.log("fuel", `Skipping unknown station ${targetStation} (could not determine empire)`);
             continue;
           }
         }

         // Navigate to target station if not already there
         if (bot.system !== targetSystem || bot.poi !== targetStation) {
           await navigateToStation(ctx, targetSystem, targetStation);
           if (bot.state !== "running") break;
         }

         const state = getFacilityState(targetStation, facilityType) || {
           stationId: targetStation,
           facilityType,
           facilityBuilt: false,
           facilityUnderConstruction: false,
           craftJobRecipeId: recipeId,
           craftJobRunsDone: 0,
           craftJobRunsTotal: 0,
           lastCraftJobCheck: 0,
           status: "pending_facility" as FacilityStatus,
           buildFailures: 0,
         };

         const facilitiesAtStation = await getFacilitiesAtStation(bot);
         const existingFacility = facilitiesAtStation.find(f => f.type === facilityType);

         if (!existingFacility || !existingFacility.facility_id) {
           state.facilityBuilt = false;
           state.facilityUnderConstruction = false;
           state.status = "pending_facility";
         } else {
           state.facilityId = existingFacility.facility_id;
           state.facilityBuilt = true;
           state.facilityUnderConstruction = false;
           state.status = "monitoring";
         }

         if (!state.facilityBuilt) {
           state.status = "building_facility";
           state.facilityUnderConstruction = true;
           saveFacilityState(state);
           yield `build_${facilityType}_${targetStation}`;

           const built = await buildFacilityAtStation(ctx, bot, targetStation, facilityType, settings.homeStation, settings.homeSystem, settings.autoCloak);
           if (built) {
             state.facilityBuilt = true;
             state.facilityUnderConstruction = false;
             state.facilityId = state.facilityId || `faction_${Date.now()}`;
             state.status = "monitoring";
           }
           saveFacilityState(state);
           continue;
         }

         if (state.facilityId) {
           const jobs = await getFacilityJobs(bot, [state.facilityId]);
           const job = jobs.get(state.facilityId);

           if (job && job.runs_remaining > 0) {
             state.craftJobId = job.job_id;
             state.craftJobRunsDone = job.runs_done;
             state.craftJobRunsTotal = job.runs_done + job.runs_remaining;
             state.lastCraftJobCheck = Date.now();
             state.status = "crafting_fuel";
             saveFacilityState(state);
             yield `crafting_${facilityType}_${targetStation}`;
             continue;
           }

           if ((!job || job.runs_remaining === 0) && state.craftJobId) {
             ctx.log("fuel", `Fuel job completed for ${facilityType} at ${targetStation}`);
             state.craftJobId = undefined;
             state.craftJobRunsDone = state.craftJobRunsTotal;
             state.status = "monitoring";
             saveFacilityState(state);
           }

           yield `queue_${facilityType}_${targetStation}`;
             
           // Calculate fuel quantity based on actual recipe output_quantity
           const recipe = findRecipeForItem(state.craftJobRecipeId);
           const outputPerRun = recipe?.output_quantity || 200; // Default to 200 for peroxide
           const targetFuel = 500000;
           const maxRunsPerJob = 10000;
           
           // Check remote station fuel (uses fuel_reserve as the item key)
           const { reserve: haveFuel } = await getRemoteFactionFuelReserve(bot, targetStation);
           const runsNeeded = Math.max(0, Math.ceil((targetFuel - haveFuel) / outputPerRun));
           const actualRuns = Math.max(1, Math.min(runsNeeded, maxRunsPerJob));

           // Check if input materials are available for the recipe
           const remoteStorage = await getRemoteFactionStorage(bot, targetStation);
           let runsPossible = actualRuns;
           if (recipe?.components) {
             for (const comp of recipe.components) {
               const available = remoteStorage[comp.item_id.toLowerCase()] || 0;
               const runsForComp = Math.floor(available / comp.quantity);
               runsPossible = Math.min(runsPossible, runsForComp);
             }
           }
           const finalRuns = Math.max(1, runsPossible);

           if (finalRuns < actualRuns) {
             ctx.log("fuel", `Reduced runs from ${actualRuns} to ${finalRuns} due to input material constraints`);
           }

           const queued = await queueFuelProduction(ctx, bot, state.facilityId!, state.craftJobRecipeId, finalRuns);
           if (queued) {
             state.status = "monitoring";
           }
           saveFacilityState(state);
         }
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
async function navigateToStation(ctx: RoutineContext, targetSystem: string, targetStation: string): Promise<boolean> {
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
   if (bot.poi !== targetStation) {
     ctx.log("travel", `Traveling to ${targetStation}...`);
     const travelResp = await bot.exec("travel", { target_poi: targetStation });
     if (travelResp.error && !travelResp.error.message.includes("already")) {
       ctx.log("error", `Travel failed: ${travelResp.error.message}`);
       return false;
     }
     bot.poi = targetStation;
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