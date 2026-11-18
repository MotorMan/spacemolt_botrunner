import type { Bot, Routine, RoutineContext } from "../bot.js";
import {
  ensureDocked,
  ensureUndocked,
  getSystemInfo,
  getItemSize,
  isStationPoi,
  findStation,
  parseSystemData,
  cargoUsedFromInventory,
  maxItemsForCargo,
  tryRefuel,
  getMobileCapitolSystem,
  resolveStationId,
} from "./common.js";
import { mapStore } from "../mapstore.js";
import { catalogStore } from "../catalogstore.js";
import { loadSettings } from "../web/server.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

interface MissionStep {
  id: string;
  name: string;
  description: string;
  type: "accept" | "dock" | "goto" | "jump" | "pathfinder_jump" | "grab" | "deliver" | "interact" | "interact_poi" | "scan" | "complete";
  system?: string;
  station?: string;
  items?: Array<{ itemId: string; quantity: number }>;
  bearing?: number;
  distance?: number;
  poi?: string;
  completeAfter?: string[];
  isMobileStation?: boolean;
  mobileStationId?: string;
  mobileStationPoiId?: string;
}

interface MissionChain {
  name: string;
  steps: MissionStep[];
  prerequisites?: string[];
}

const MISSION_CHAINS: MissionChain[] = [
  {
    name: "The Signal - Main Chain",
    steps: [
      {
        id: "the_memorial",
        name: "The Memorial",
        description: "Accept at Frontier Station (mobile station)",
        type: "dock",
        station: "frontier_station",
        isMobileStation: true,
        mobileStationId: "frontier_station",
        mobileStationPoiId: "mobile_capital",
      },
      {
        id: "the_expeditionary_mandate",
        name: "The Expeditionary Mandate",
        description: "Dock at Alpha Centauri Colonial Station, then Sol Central",
        type: "dock",
        system: "alpha_centauri",
        station: "alpha_centauri_colonial_station",
        completeAfter: ["the_memorial"],
      },
      {
        id: "the_expeditionary_mandate_sol",
        name: "The Expeditionary Mandate (Sol)",
        description: "Dock at Sol Central",
        type: "dock",
        system: "sol",
        station: "sol_central",
        completeAfter: ["the_expeditionary_mandate"],
      },
      {
        id: "the_other_side",
        name: "The Other Side",
        description: "Dock at War Citadel, then Ironhearth Station",
        type: "dock",
        system: "krynn",
        station: "war_citadel",
        completeAfter: ["the_expeditionary_mandate_sol"],
      },
      {
        id: "the_other_side_ironhearth",
        name: "The Other Side (Ironhearth)",
        description: "Dock at Ironhearth Station",
        type: "dock",
        system: "ironhearth",
        station: "ironhearth_station",
        completeAfter: ["the_other_side"],
      },
      {
        id: "the_dossier",
        name: "The Dossier",
        description: "Bring 8 Focused Crystal to Mobile Capital (Frontier Station)",
        type: "deliver",
        station: "mobile_capital",
        isMobileStation: true,
        mobileStationId: "mobile_capital",
        items: [{ itemId: "focused_crystal", quantity: 8 }],
        completeAfter: ["the_other_side_ironhearth"],
      },
      {
        id: "survey_equipment",
        name: "Survey Equipment",
        description: "Given 6x circuit_board, 4x focused_crystal at Sirius Observatory, return to FSMS",
        type: "dock",
        system: "sirius",
        station: "sirius_observatory_station",
        completeAfter: ["the_dossier"],
      },
      {
        id: "survey_equipment_return",
        name: "Survey Equipment Return",
        description: "Return to First Step Memorial Station",
        type: "dock",
        system: "first_step",
        station: "first_step_memorial_station",
        completeAfter: ["survey_equipment"],
      },
      {
        id: "environmental_sampling",
        name: "Environmental Sampling",
        description: "Visit Unknown Edge, Void Gate, Last Light, First Step",
        type: "goto",
        system: "unknown_edge",
        poi: "unknown_edge_waystation",
        completeAfter: ["survey_equipment_return"],
      },
      {
        id: "environmental_sampling_void_gate",
        name: "Environmental Sampling (Void Gate)",
        description: "Visit Void Gate Outpost",
        type: "dock",
        system: "void_gate",
        station: "void_gate_outpost",
        completeAfter: ["environmental_sampling"],
      },
      {
        id: "environmental_sampling_last_light",
        name: "Environmental Sampling (Last Light)",
        description: "Visit Last Light",
        type: "dock",
        system: "last_light",
        station: "last_light_station",
        completeAfter: ["environmental_sampling_void_gate"],
      },
      {
        id: "environmental_sampling_fsms",
        name: "Environmental Sampling (FSMS)",
        description: "Return to First Step Memorial Station",
        type: "dock",
        system: "first_step",
        station: "first_step_memorial_station",
        completeAfter: ["environmental_sampling_last_light"],
      },
      {
        id: "the_archive_report",
        name: "The Archive Report",
        description: "Grab 4 Focused Crystal, go to Sol Central",
        type: "deliver",
        system: "sol",
        station: "sol_central",
        items: [{ itemId: "focused_crystal", quantity: 4 }],
        completeAfter: ["environmental_sampling_fsms"],
      },
      {
        id: "observation_points",
        name: "Observation Points",
        description: "Go to Markab, Timberline, FSMS",
        type: "goto",
        system: "markab",
        poi: "markab_station",
        completeAfter: ["the_archive_report"],
      },
      {
        id: "observation_points_timberline",
        name: "Observation Points (Timberline)",
        description: "Dock at Timberline",
        type: "dock",
        system: "timberline",
        station: "timberline_station",
        completeAfter: ["observation_points"],
      },
      {
        id: "observation_points_fsms",
        name: "Observation Points (FSMS)",
        description: "Return to First Step Memorial Station",
        type: "dock",
        system: "first_step",
        station: "first_step_memorial_station",
        completeAfter: ["observation_points_timberline"],
      },
      {
        id: "parallel_installations",
        name: "Parallel Installations",
        description: "Visit Bharani, TRAPPIST-1, FSMS",
        type: "dock",
        system: "bharani",
        station: "bharani_station",
        completeAfter: ["observation_points_fsms"],
      },
      {
        id: "parallel_installations_trappist",
        name: "Parallel Installations (TRAPPIST-1)",
        description: "Dock at TRAPPIST-1",
        type: "dock",
        system: "trappist_1",
        station: "trappist_1_station",
        completeAfter: ["parallel_installations"],
      },
      {
        id: "parallel_installations_fsms",
        name: "Parallel Installations (FSMS)",
        description: "Return to First Step Memorial Station",
        type: "dock",
        system: "first_step",
        station: "first_step_memorial_station",
        completeAfter: ["parallel_installations_trappist"],
      },
      {
        id: "the_third_signature",
        name: "The Third Signature",
        description: "Go to Etamin, return to FSMS",
        type: "dock",
        system: "etamin",
        station: "etamin_station",
        completeAfter: ["parallel_installations_fsms"],
      },
      {
        id: "the_third_signature_fsms",
        name: "The Third Signature (FSMS)",
        description: "Return to First Step Memorial Station",
        type: "dock",
        system: "first_step",
        station: "first_step_memorial_station",
        completeAfter: ["the_third_signature"],
      },
      {
        id: "what_the_void_remembers",
        name: "What The Void Remembers",
        description: "Dock at Central Nexus (Nexus Prime)",
        type: "dock",
        system: "nexus_prime",
        station: "central_nexus",
        completeAfter: ["the_third_signature_fsms"],
      },
      {
        id: "processing_the_data",
        name: "Processing The Data",
        description: "Return to First Step Memorial Station",
        type: "dock",
        system: "first_step",
        station: "first_step_memorial_station",
        completeAfter: ["what_the_void_remembers"],
      },
      {
        id: "joining_the_investigators",
        name: "Joining The Investigators",
        description: "Go to The Telescope, then FSMS",
        type: "goto",
        system: "the_telescope",
        poi: "the_telescope",
        completeAfter: ["processing_the_data"],
      },
      {
        id: "joining_the_investigators_fsms",
        name: "Joining The Investigators (FSMS)",
        description: "Return to First Step Memorial Station",
        type: "dock",
        system: "first_step",
        station: "first_step_memorial_station",
        completeAfter: ["joining_the_investigators"],
      },
      {
        id: "the_allocation_pattern",
        name: "The Allocation Pattern",
        description: "Pass through Node Alpha, Node Beta, Node Gamma, then FSMS",
        type: "goto",
        system: "node_alpha",
        poi: "node_alpha_processing_station",
        completeAfter: ["joining_the_investigators_fsms"],
      },
      {
        id: "the_allocation_pattern_beta",
        name: "The Allocation Pattern (Node Beta)",
        description: "Pass through Node Beta",
        type: "goto",
        system: "node_beta",
        poi: "node_beta_industrial_station",
        completeAfter: ["the_allocation_pattern"],
      },
      {
        id: "the_allocation_pattern_gamma",
        name: "The Allocation Pattern (Node Gamma)",
        description: "Pass through Node Gamma",
        type: "goto",
        system: "node_gamma",
        poi: "node_gamma_relay_station",
        completeAfter: ["the_allocation_pattern_beta"],
      },
      {
        id: "the_allocation_pattern_fsms",
        name: "The Allocation Pattern (FSMS)",
        description: "Return to First Step Memorial Station",
        type: "dock",
        system: "first_step",
        station: "first_step_memorial_station",
        completeAfter: ["the_allocation_pattern_gamma"],
      },
      {
        id: "the_frequency_gap",
        name: "The Frequency Gap",
        description: "Pass through The Experiment, then FSMS",
        type: "goto",
        system: "the_experiment",
        poi: "the_experiment_research_station",
        completeAfter: ["the_allocation_pattern_fsms"],
      },
      {
        id: "the_frequency_gap_fsms",
        name: "The Frequency Gap (FSMS)",
        description: "Return to First Step Memorial Station",
        type: "dock",
        system: "first_step",
        station: "first_step_memorial_station",
        completeAfter: ["the_frequency_gap"],
      },
      {
        id: "the_cover_story",
        name: "The Cover Story",
        description: "Go to Starfall, back to FSMS",
        type: "dock",
        system: "starfall",
        station: "starfall_salvage_station",
        completeAfter: ["the_frequency_gap_fsms"],
      },
      {
        id: "the_cover_story_fsms",
        name: "The Cover Story (FSMS)",
        description: "Return to First Step Memorial Station",
        type: "dock",
        system: "first_step",
        station: "first_step_memorial_station",
        completeAfter: ["the_cover_story"],
      },
      {
        id: "the_listening_foundry",
        name: "The Listening Foundry",
        description: "Grab 4 Anomaly Probes, deliver to FSMS",
        type: "deliver",
        system: "first_step",
        station: "first_step_memorial_station",
        items: [{ itemId: "anomaly_probe", quantity: 4 }],
        completeAfter: ["the_cover_story_fsms"],
      },
      {
        id: "the_foundry_points_somewhere",
        name: "The Foundry Points Somewhere",
        description: "Dock at Central Nexus, find Phos-2",
        type: "dock",
        system: "nexus_prime",
        station: "central_nexus",
        completeAfter: ["the_listening_foundry"],
      },
      {
        id: "a_line_with_no_address",
        name: "A Line With No Address",
        description: "Return to FSMS with bearing 144.2 from Nexus Prime, ~590 GU, ~59 ticks",
        type: "dock",
        system: "first_step",
        station: "first_step_memorial_station",
        completeAfter: ["the_foundry_points_somewhere"],
      },
      {
        id: "into_the_sanctum",
        name: "Into The Sanctum",
        description: "Go to Nexus Prime, pathfinder jump bearing 144.2, interact POIs",
        type: "pathfinder_jump",
        system: "nexus_prime",
        bearing: 144.2,
        distance: 590,
        poi: "sanctum_receiver_housing",
        completeAfter: ["a_line_with_no_address"],
      },
      {
        id: "no_lane",
        name: "No Lane",
        description: "Install survey_scanner_ii, pathfinder jump to Sanctum, scan, visit hidden POI, return to FSMS",
        type: "pathfinder_jump",
        system: "first_step",
        station: "first_step_memorial_station",
        bearing: 144.2,
        distance: 590,
        poi: "sanctum_hidden_poi",
        completeAfter: ["into_the_sanctum"],
      },
      {
        id: "lanes_do_not_disappear",
        name: "Lanes Do Not Disappear",
        description: "Dock at Frontier Station (The Patchwork)",
        type: "dock",
        station: "frontier_station",
        isMobileStation: true,
        mobileStationId: "frontier_station",
        completeAfter: ["no_lane"],
      },
      {
        id: "larkin_says_no",
        name: "Larkin Says No",
        description: "Grab 200 fuel cells, deliver to Deep Range",
        type: "deliver",
        system: "deep_range",
        station: "deep_range_outpost",
        items: [{ itemId: "fuel_cell", quantity: 200 }],
        completeAfter: ["lanes_do_not_disappear"],
      },
      {
        id: "the_pickup",
        name: "The Pickup",
        description: "Jump bearing 226.5 from Deep Range, 1500 out, turn around",
        type: "jump",
        system: "deep_range",
        bearing: 226.5,
        distance: 1500,
        completeAfter: ["larkin_says_no"],
      },
      {
        id: "larkins_seven",
        name: "Larkin's Seven",
        description: "Visit Whitecap, Lantern Low, Quiet Floor, Grey Hollow, Brushfield, Sallow, Narrows. Recover data at Frame Yard (Quiet Floor) and Empty Berth (Narrows), return to Patchwork",
        type: "goto",
        system: "whitecap",
        poi: "whitecap_station",
        completeAfter: ["the_pickup"],
      },
    ],
  },
];

function getMissionSettings(bot: Bot): Record<string, unknown> {
  const settings = loadSettings();
  const global = (settings.missions as Record<string, unknown>) || {};
  const perBot = bot.username ? (settings[bot.username] as Record<string, unknown>) || {} : {};
  const botMissions = (perBot.missions as Record<string, unknown>) || {};
  return { ...global, ...botMissions };
}

function getHomeSystem(settings: Record<string, unknown>): string | undefined {
  return (settings.general as Record<string, unknown>)?.homeSystem as string | undefined;
}

async function resolveStationSystem(ctx: RoutineContext, step: MissionStep): Promise<string | null> {
  if (step.isMobileStation && step.mobileStationId) {
    // For mobile stations, use the tracked location from mapStore
    const system = getMobileCapitolSystem();
    if (system) {
      ctx.log("mission", `Mobile station ${step.mobileStationId} currently at ${system}`);
      return system;
    }
    // Fallback: try to find it in mapStore
    const resolved = resolveStationId(step.mobileStationId);
    if (resolved && resolved !== step.mobileStationId) {
      // We have a resolved station ID, try to find its system
      // mapStore might have the system info
    }
    ctx.log("warn", `Mobile station ${step.mobileStationId} location unknown, using fallback`);
  }
  return step.system || null;
}

async function navigateToStation(ctx: RoutineContext, step: MissionStep): Promise<boolean> {
  const { bot } = ctx;
  
  // Resolve the system for this step (handles mobile stations)
  const targetSystem = await resolveStationSystem(ctx, step);
  if (!targetSystem) {
    ctx.log("error", `Cannot determine target system for step ${step.id}`);
    return false;
  }
  
  // Determine the POI ID to use (for mobile stations, use mobileStationPoiId)
  const poiId = step.isMobileStation && step.mobileStationPoiId 
    ? step.mobileStationPoiId 
    : step.station;
  
  // Check if already at the correct station
  if (bot.system?.toLowerCase() === targetSystem.toLowerCase() && 
      bot.poi === poiId && bot.docked) {
    return true;
  }
  
  // Navigate to the system
  const navigated = await navigateToSystem(ctx, targetSystem);
  if (!navigated) return false;
  
  // Find and travel to the station
  const { pois } = await getSystemInfo(ctx);
  const station = pois.find(p => p.id === poiId && isStationPoi(p));
  if (!station) {
    ctx.log("error", `Station ${poiId} not found in ${targetSystem}`);
    return false;
  }
  
  if (bot.poi !== station.id) {
    ctx.log("travel", `Traveling to ${station.name}...`);
    const travelResp = await bot.exec("travel", { target_poi: station.id });
    if (travelResp.error && !travelResp.error.message.includes("already")) {
      ctx.log("error", `Travel failed: ${travelResp.error.message}`);
      return false;
    }
    bot.poi = station.id;
    await bot.refreshLocation();
  }
  
  ctx.log("system", "Docking...");
  const dockResp = await bot.exec("dock");
  if (!dockResp.error || dockResp.error.message.includes("already")) {
    bot.docked = true;
    
    // Refuel after docking if needed
    ctx.log("system", "Checking fuel and refueling if needed...");
    await tryRefuel(ctx);
    
    return true;
  }
  
  ctx.log("error", `Dock failed: ${dockResp.error.message}`);
  return false;
}

async function navigateToSystem(ctx: RoutineContext, targetSystem: string): Promise<boolean> {
  const { bot } = ctx;
  if (bot.system?.toLowerCase() === targetSystem.toLowerCase()) return true;

  await ensureUndocked(ctx);
  const settings = loadSettings();
  const blacklist = (Array.isArray(settings.system_blacklist) ? settings.system_blacklist : []) as string[];
  const route = mapStore.findRoute(bot.system, targetSystem, blacklist);
  
  if (!route || route.length < 2) {
    ctx.log("error", `No route found from ${bot.system} to ${targetSystem}`);
    return false;
  }

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
      ctx.log("travel", `Jump succeeded despite error`);
    }
    await bot.refreshLocation();
  }
  return true;
}

async function dockAtStation(ctx: RoutineContext, systemId: string, stationId: string): Promise<boolean> {
  const { bot } = ctx;
  const navigated = await navigateToSystem(ctx, systemId);
  if (!navigated) return false;

  const { pois } = await getSystemInfo(ctx);
  const station = pois.find(p => p.id === stationId && isStationPoi(p));
  if (!station) {
    ctx.log("error", `Station ${stationId} not found in ${systemId}`);
    return false;
  }

  if (bot.poi !== station.id) {
    ctx.log("travel", `Traveling to ${station.name}...`);
    const travelResp = await bot.exec("travel", { target_poi: station.id });
    if (travelResp.error && !travelResp.error.message.includes("already")) {
      ctx.log("error", `Travel failed: ${travelResp.error.message}`);
      return false;
    }
    bot.poi = station.id;
    await bot.refreshLocation();
  }

  ctx.log("system", "Docking...");
  const dockResp = await bot.exec("dock");
  if (!dockResp.error || dockResp.error.message.includes("already")) {
    bot.docked = true;
    
    // Refuel after docking if needed
    ctx.log("system", "Checking fuel and refueling if needed...");
    await tryRefuel(ctx);
    
    return true;
  }

  ctx.log("error", `Dock failed: ${dockResp.error.message}`);
  return false;
}

async function acceptMission(ctx: RoutineContext, missionId: string): Promise<{ success: boolean; error?: string }> {
  const { bot } = ctx;
  ctx.log("mission", `Accepting mission: ${missionId}`);
  const resp = await bot.exec("accept_mission", { mission_id: missionId });
  if (resp.error) {
    ctx.log("error", `Accept mission failed: ${resp.error.message}`);
    return { success: false, error: resp.error.message };
  }
  return { success: true };
}

async function completeMission(ctx: RoutineContext, missionId: string): Promise<boolean> {
  const { bot } = ctx;
  ctx.log("mission", `Completing mission: ${missionId}`);
  const resp = await bot.exec("complete_mission", { mission_id: missionId });
  if (resp.error) {
    ctx.log("error", `Complete mission failed: ${resp.error.message}`);
    return false;
  }
  return true;
}

async function getActiveMissions(ctx: RoutineContext): Promise<Array<{ id: string; objectives: unknown[] }>> {
  const { bot } = ctx;
  const resp = await bot.exec("get_active_missions");
  if (resp.error || !resp.result) return [];
  const result = resp.result as Record<string, unknown>;
  // API can return array directly or object with missions property
  const missions = (
    Array.isArray(result) ? result :
    Array.isArray(result.missions) ? result.missions : []
  ) as Array<Record<string, unknown>>;
  return missions.map(m => ({
    id: (m.mission_id as string) || (m.id as string) || "",
    objectives: (m.objectives as unknown[]) || [],
  }));
}

async function ensureItemsInCargo(ctx: RoutineContext, items: Array<{ itemId: string; quantity: number }>): Promise<boolean> {
  const { bot } = ctx;
  await bot.refreshCargo();
  
  for (const item of items) {
    const have = bot.inventory.find(i => i.itemId === item.itemId)?.quantity || 0;
    if (have >= item.quantity) continue;

    const needed = item.quantity - have;
    ctx.log("mission", `Need ${needed}x ${item.itemId}, checking storage...`);
    
    const storageResp = await bot.exec("view_storage");
    if (!storageResp.result) continue;
    const storage = storageResp.result as Record<string, unknown>;
    const storedItems = (storage.items as Array<Record<string, unknown>>) || [];
    const stored = storedItems.find(i => (i.item_id as string) === item.itemId || (i.id as string) === item.itemId);
    const storedQty = stored ? ((stored.quantity as number) || 0) : 0;
    
    if (storedQty > 0) {
      const withdraw = Math.min(needed, storedQty);
      const wResp = await bot.exec("storage", { 
        action: "withdraw", 
        item_id: item.itemId, 
        quantity: withdraw, 
        target: "self", 
        source: "storage" 
      });
      if (!wResp.error) {
        ctx.log("mission", `Withdrew ${withdraw}x ${item.itemId} from station storage`);
        await bot.refreshCargo();
        continue;
      }
    }

    const factionResp = await bot.exec("view_storage", { target: "faction" });
    if (!factionResp.result) continue;
    const faction = factionResp.result as Record<string, unknown>;
    const factionItems = (faction.items as Array<Record<string, unknown>>) || [];
    const factionStored = factionItems.find(i => (i.item_id as string) === item.itemId || (i.id as string) === item.itemId);
    const factionQty = factionStored ? ((factionStored.quantity as number) || 0) : 0;
    
    if (factionQty > 0) {
      const withdraw = Math.min(needed, factionQty);
      const wResp = await bot.exec("storage", { 
        action: "withdraw", 
        item_id: item.itemId, 
        quantity: withdraw, 
        target: "self", 
        source: "faction" 
      });
      if (!wResp.error) {
        ctx.log("mission", `Withdrew ${withdraw}x ${item.itemId} from faction storage`);
        await bot.refreshCargo();
        continue;
      }
    }

    if (bot.docked) {
      const marketResp = await bot.exec("view_market");
      if (marketResp.result) {
        const market = marketResp.result as Record<string, unknown>;
        const marketItems = (market.items as Array<Record<string, unknown>>) || [];
        const marketItem = marketItems.find(i => (i.item_id as string) === item.itemId || (i.id as string) === item.itemId);
        const sellOrders = (marketItem?.sell_orders as Array<Record<string, unknown>>) || [];
        if (sellOrders.length > 0) {
          const bestPrice = Math.min(...sellOrders.map(o => (o.price_each as number) || (o.price as number) || Infinity));
          if (bestPrice < Infinity && bot.credits >= bestPrice * needed) {
            const buyResp = await bot.exec("buy", { item_id: item.itemId, quantity: needed, max_price: bestPrice });
            if (!buyResp.error) {
              ctx.log("mission", `Bought ${needed}x ${item.itemId} at ${bestPrice}cr each`);
              await bot.refreshCargo();
              continue;
            }
          }
        }
      }
    }

    ctx.log("error", `Cannot acquire ${needed}x ${item.itemId}`);
    return false;
  }
  return true;
}

async function deliverItems(ctx: RoutineContext, items: Array<{ itemId: string; quantity: number }>): Promise<boolean> {
  const { bot } = ctx;
  if (!bot.docked) {
    ctx.log("error", "Must be docked to deliver items");
    return false;
  }

  for (const item of items) {
    const have = bot.inventory.find(i => i.itemId === item.itemId)?.quantity || 0;
    if (have < item.quantity) {
      ctx.log("error", `Not enough ${item.itemId} in cargo (have ${have}, need ${item.quantity})`);
      return false;
    }
    ctx.log("mission", `Delivering ${item.quantity}x ${item.itemId}...`);
    const depResp = await bot.exec("storage", { 
      action: "deposit", 
      item_id: item.itemId, 
      quantity: item.quantity, 
      target: "storage", 
      source: "self" 
    });
    if (depResp.error) {
      ctx.log("error", `Deposit failed: ${depResp.error.message}`);
      return false;
    }
    ctx.log("mission", `Deposited ${item.quantity}x ${item.itemId}`);
  }
  return true;
}

async function executeMissionStep(ctx: RoutineContext, step: MissionStep): Promise<boolean> {
  const { bot } = ctx;
  const settings = getMissionSettings(bot);
  const disablePathfinder = settings.disablePathfinderJumps === true;
  const minFuelPct = (settings.minFuelForPathfinder as number) ?? 80;
  
  switch (step.type) {
    case "accept": {
      if (step.id) {
        const result = await acceptMission(ctx, step.id);
        return result.success;
      }
      return true;
    }
    case "dock": {
      if (step.station) {
        return await navigateToStation(ctx, step);
      }
      return true;
    }
    case "goto": {
      if (step.system) {
        const navigated = await navigateToSystem(ctx, step.system);
        if (!navigated) return false;
        if (step.station) {
          return await navigateToStation(ctx, step);
        }
        if (step.poi) {
          const { pois } = await getSystemInfo(ctx);
          const poi = pois.find(p => p.id === step.poi);
          if (poi) {
            ctx.log("travel", `Traveling to ${poi.name}...`);
            const travelResp = await bot.exec("travel", { target_poi: poi.id });
            if (travelResp.error && !travelResp.error.message.includes("already")) {
              ctx.log("error", `Travel failed: ${travelResp.error.message}`);
              return false;
            }
            bot.poi = poi.id;
            await bot.refreshLocation();
          }
        }
      }
      return true;
    }
    case "jump": {
      if (step.system) {
        await navigateToSystem(ctx, step.system);
      }
      if (step.bearing !== undefined && step.distance !== undefined) {
        ctx.log("travel", `Jumping bearing ${step.bearing}, distance ${step.distance}...`);
        const jumpResp = await bot.exec("jump", { bearing: step.bearing, distance: step.distance });
        if (jumpResp.error) {
          ctx.log("error", `Bearing jump failed: ${jumpResp.error.message}`);
          return false;
        }
        await bot.refreshLocation();
      }
      if (step.poi) {
        await bot.exec("interact_poi", { poi_id: step.poi });
      }
      return true;
    }
    case "pathfinder_jump": {
      // Safety checks for pathfinder jumps
      if (disablePathfinder) {
        ctx.log("error", `Pathfinder jump required for step "${step.name}" but pathfinder jumps are DISABLED in settings.`);
        ctx.log("error", `Please enable "Allow Pathfinder Jumps" in Missions settings, or manually execute: jump bearing ${step.bearing}, distance ${step.distance}`);
        return false; // This will cause the routine to retry and log repeatedly
      }
      
      // Check fuel level
      await bot.refreshShip();
      const fuelPct = bot.maxFuel > 0 ? (bot.fuel / bot.maxFuel) * 100 : 100;
      if (fuelPct < minFuelPct) {
        ctx.log("error", `Pathfinder jump requires ${minFuelPct}% fuel, current: ${fuelPct.toFixed(1)}%. Refueling first...`);
        // Try to refuel
        await ensureDocked(ctx);
        const refuelResp = await bot.exec("refuel");
        if (refuelResp.error) {
          ctx.log("error", `Refuel failed: ${refuelResp.error.message}`);
        }
        await bot.refreshShip();
        const newFuelPct = bot.maxFuel > 0 ? (bot.fuel / bot.maxFuel) * 100 : 100;
        if (newFuelPct < minFuelPct) {
          ctx.log("error", `Fuel still below ${minFuelPct}% after refuel attempt (${newFuelPct.toFixed(1)}%). Aborting pathfinder jump.`);
          return false;
        }
      }
      
      // Validate bearing (0-360)
      if (step.bearing === undefined || step.bearing < 0 || step.bearing > 360) {
        ctx.log("error", `Invalid bearing for pathfinder jump: ${step.bearing}. Must be 0-360 degrees.`);
        return false;
      }
      
      // Validate distance (must be positive)
      if (step.distance === undefined || step.distance <= 0) {
        ctx.log("error", `Invalid distance for pathfinder jump: ${step.distance}. Must be positive.`);
        return false;
      }
      
      // Check if we have a pathfinder drive equipped
      await bot.refreshShip();
      if (!bot.hasPathfinderDrive) {
        ctx.log("error", `No Pathfinder Drive equipped! Cannot execute pathfinder jump.`);
        return false;
      }
      
      ctx.log("travel", `⚠️ PATHFINDER JUMP: bearing ${step.bearing}, distance ${step.distance}...`);
      const jumpResp = await bot.exec("jump", { bearing: step.bearing, distance: step.distance, use_pathfinder: true });
      if (jumpResp.error) {
        ctx.log("error", `Pathfinder jump failed: ${jumpResp.error.message}`);
        return false;
      }
      await bot.refreshLocation();
      
      // If there's a POI to interact with after the jump
      if (step.poi) {
        await ctx.sleep(2000);
        const interactResp = await bot.exec("interact_poi", { poi_id: step.poi });
        if (interactResp.error) {
          ctx.log("error", `Interact POI after pathfinder jump failed: ${interactResp.error.message}`);
          return false;
        }
      }
      return true;
    }
    case "interact_poi": {
      if (step.poi) {
        ctx.log("mission", `Interacting with POI: ${step.poi}...`);
        const resp = await bot.exec("interact_poi", { poi_id: step.poi });
        if (resp.error) {
          ctx.log("error", `Interact POI failed: ${resp.error.message}`);
          return false;
        }
        ctx.log("mission", `POI interaction complete`);
      }
      return true;
    }
    case "grab": {
      if (step.items) {
        return await ensureItemsInCargo(ctx, step.items);
      }
      return true;
    }
    case "deliver": {
      if (step.items) {
        return await deliverItems(ctx, step.items);
      }
      return true;
    }
    case "interact": {
      if (step.poi) {
        const resp = await bot.exec("interact_poi", { poi_id: step.poi });
        if (resp.error) {
          ctx.log("error", `Interact POI failed: ${resp.error.message}`);
          return false;
        }
      }
      return true;
    }
    case "scan": {
      if (step.system) {
        await navigateToSystem(ctx, step.system);
      }
      ctx.log("mission", "Scanning... (placeholder)");
      return true;
    }
    case "complete": {
      if (step.id) {
        return await completeMission(ctx, step.id);
      }
      return true;
    }
  }
  return true;
}

function findNextStep(completedSteps: Set<string>, chain: MissionChain): MissionStep | null {
  for (const step of chain.steps) {
    if (completedSteps.has(step.id)) continue;
    if (step.completeAfter) {
      const allDone = step.completeAfter.every(id => completedSteps.has(id));
      if (!allDone) continue;
    }
    return step;
  }
  return null;
}

// ── Progress Persistence ────────────────────────────────────────────

const DATA_DIR = join(process.cwd(), "data");
const MISSIONS_PROGRESS_DIR = join(DATA_DIR, "missions_progress");

function ensureProgressDir(): void {
  if (!existsSync(MISSIONS_PROGRESS_DIR)) {
    mkdirSync(MISSIONS_PROGRESS_DIR, { recursive: true });
  }
}

function getProgressFile(botUsername: string): string {
  return join(MISSIONS_PROGRESS_DIR, `${botUsername}.json`);
}

interface MissionProgress {
  chainName: string;
  completedSteps: string[];
  lastUpdated: number;
}

function loadProgress(botUsername: string, chainName: string): Set<string> {
  try {
    ensureProgressDir();
    const file = getProgressFile(botUsername);
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, "utf-8")) as MissionProgress;
      if (data.chainName === chainName && Array.isArray(data.completedSteps)) {
        return new Set(data.completedSteps);
      }
    }
  } catch (e) {
    // Ignore errors, start fresh
  }
  return new Set<string>();
}

function saveProgress(botUsername: string, chainName: string, completedSteps: Set<string>): void {
  try {
    ensureProgressDir();
    const file = getProgressFile(botUsername);
    const data: MissionProgress = {
      chainName,
      completedSteps: Array.from(completedSteps),
      lastUpdated: Date.now(),
    };
    writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf-8");
  } catch (e) {
    // Ignore write errors
  }
}

async function detectChainPositionFromGameState(ctx: RoutineContext, chain: MissionChain, savedCompleted: Set<string>): Promise<Set<string>> {
  const { bot } = ctx;
  const completed = new Set(savedCompleted);
  
  // Get all active missions from the game
  const activeMissions = await getActiveMissions(ctx);
  const activeMissionIds = new Set(activeMissions.map(m => m.id));
  
  // ONLY verify completion for missions that are currently active
  // If a mission is active AND its objectives are complete, it's done
  // We do NOT infer completion from prerequisites or location
  for (const step of chain.steps) {
    if (!step.id) continue;
    
    // If already in saved completed, keep it
    if (completed.has(step.id)) continue;
    
    // If mission is currently active, check if objectives are complete
    if (activeMissionIds.has(step.id)) {
      const activeMission = activeMissions.find(m => m.id === step.id);
      const objectives = (activeMission?.objectives as Array<Record<string, unknown>>) || [];
      const allComplete = objectives.every((obj) => obj.completed === true || obj.progress === obj.quantity);
      if (allComplete) {
        completed.add(step.id);
        ctx.log("mission", `Verified completed from active mission: ${step.id}`);
      }
      continue;
    }
    
    // Mission is not active - we CANNOT determine if it's completed or not started
    // Do NOT infer from prerequisites or location
    // The progress file is the source of truth
  }
  
  // Do NOT detect based on current location - that's unreliable
  // (being in a system doesn't mean the mission step was done)
  
  return completed;
}

export const missionsRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;
  const settings = getMissionSettings(bot);
  const chainName = (settings.chain as string) || "The Signal - Main Chain";
  const chain = MISSION_CHAINS.find(c => c.name === chainName);
  
  if (!chain) {
    ctx.log("error", `Mission chain not found: ${chainName}`);
    return;
  }

  ctx.log("mission", `Starting mission chain: ${chain.name} (${chain.steps.length} steps)`);

  // Load saved progress
  const completedSteps = loadProgress(bot.username, chainName);
  
  // Detect current position in chain from game state (location, active missions, etc.)
  // This reconciles saved progress with reality
  const reconciled = await detectChainPositionFromGameState(ctx, chain, completedSteps);
  for (const id of reconciled) completedSteps.add(id);
  
  if (completedSteps.size > 0) {
    ctx.log("mission", `Resuming from step ${completedSteps.size + 1}/${chain.steps.length} (${completedSteps.size} steps already completed)`);
  }

  // === Smart Chain Position Detection ===
  // Walk through the chain from the beginning, trying to accept each mission
  // - "already completed" → mark done, continue to next
  // - "only available at X" → go to X, accept it, that's our next step
  // - accepted successfully → that's our next step
  // - other error → stop for investigation
  ctx.log("mission", "Detecting current position in mission chain...");
  let firstIncompleteIndex = -1;
  
  for (let i = 0; i < chain.steps.length; i++) {
    const step = chain.steps[i];
    if (!step.id || step.type !== "dock" || !step.station) continue;
    
    // Skip if already verified as completed
    if (completedSteps.has(step.id)) {
      // Quick verify - try accept at the right station
      const targetSystem = await resolveStationSystem(ctx, step);
      if (!targetSystem) continue;
      const poiId = step.isMobileStation && step.mobileStationPoiId 
        ? step.mobileStationPoiId 
        : step.station;
      if (bot.system?.toLowerCase() !== targetSystem.toLowerCase() || 
          bot.poi !== poiId || !bot.docked) {
        ctx.log("mission", `Verifying ${step.id}: navigating to ${poiId}...`);
        const docked = await navigateToStation(ctx, step);
        if (!docked) continue;
      }
      const acceptResult = await acceptMission(ctx, step.id);
      if (!acceptResult.success) {
        if (acceptResult.error?.includes("already completed")) {
          ctx.log("mission", `Verified ${step.id}: already completed (server confirmed)`);
          continue;
        }
        if (acceptResult.error?.includes("already have an active instance")) {
          // Mission already active - it's our next step
          completedSteps.delete(step.id);
          saveProgress(bot.username, chainName, completedSteps);
          firstIncompleteIndex = i;
          ctx.log("mission", `Mission ${step.id} already active, this is our next step`);
          break;
        }
        // Not actually completed - found our position
        completedSteps.delete(step.id);
        saveProgress(bot.username, chainName, completedSteps);
        firstIncompleteIndex = i;
        ctx.log("mission", `Found incomplete step: ${step.id} (index ${i})`);
        break;
      } else {
        // Wasn't actually completed
        completedSteps.delete(step.id);
        saveProgress(bot.username, chainName, completedSteps);
        firstIncompleteIndex = i;
        ctx.log("mission", `Found incomplete step (just accepted): ${step.id} (index ${i})`);
        break;
      }
      await ctx.sleep(500);
      continue;
    }
    
    // This step is not in completed - try to accept it
    const targetSystem = await resolveStationSystem(ctx, step);
    if (!targetSystem) {
      ctx.log("error", `Cannot resolve system for ${step.id}`);
      firstIncompleteIndex = i;
      break;
    }
    
    const poiId = step.isMobileStation && step.mobileStationPoiId 
      ? step.mobileStationPoiId 
      : step.station;
    if (bot.system?.toLowerCase() !== targetSystem.toLowerCase() || 
        bot.poi !== poiId || !bot.docked) {
      ctx.log("mission", `Checking ${step.id}: navigating to ${poiId}...`);
      const docked = await navigateToStation(ctx, step);
      if (!docked) {
        firstIncompleteIndex = i;
        break;
      }
    }
    
    const acceptResult = await acceptMission(ctx, step.id);
    if (acceptResult.success) {
      // Accepted! This is our next mission to do
      firstIncompleteIndex = i;
      ctx.log("mission", `Next mission to do: ${step.id} (just accepted it)`);
      break;
    }
    
    // Check error
    if (acceptResult.error?.includes("already completed")) {
      // Already done - mark and continue
      ctx.log("mission", `Already completed: ${step.id}, moving to next`);
      completedSteps.add(step.id);
      saveProgress(bot.username, chainName, completedSteps);
      await ctx.sleep(500);
      continue;
    }
    
    if (acceptResult.error?.includes("already have an active instance")) {
      // Mission already active - check active missions to confirm
      const activeMissions = await getActiveMissions(ctx);
      const hasMission = activeMissions.some(m => m.id === step.id);
      if (hasMission) {
        // It's already active - this is our next step
        firstIncompleteIndex = i;
        ctx.log("mission", `Mission ${step.id} already active, this is our next step`);
        break;
      }
      // Not in active missions but got this error - weird, treat as not completed
      firstIncompleteIndex = i;
      break;
    }
    
    if (acceptResult.error?.includes("only available at") || acceptResult.error?.includes("not available at this station")) {
      // Wrong station - we're already at the resolved station, so this is weird
      // But the error tells us the mission is NOT completed
      ctx.log("mission", `Mission ${step.id} not completed (wrong station error), this is our next step`);
      firstIncompleteIndex = i;
      break;
    }
    
    // Other error - stop for investigation
    ctx.log("error", `Mission ${step.id} accept failed: ${acceptResult.error} — stopping for investigation`);
    return;
    
    await ctx.sleep(500);
  }
  
  // If we went through all steps without finding incomplete, we're done
  if (firstIncompleteIndex === -1 && completedSteps.size >= chain.steps.filter(s => s.id && s.type === "dock").length) {
    ctx.log("mission", "All mission steps appear completed!");
  }

  const autoAccept = settings.autoAccept !== false;
  const autoComplete = settings.autoComplete !== false;
  const preGrabItems = settings.preGrabItems !== false;

  if (preGrabItems) {
    ctx.log("mission", "Pre-gathering all required items for the chain...");
    const allItems = new Map<string, number>();
    for (const step of chain.steps) {
      if (step.items) {
        for (const item of step.items) {
          const current = allItems.get(item.itemId) || 0;
          allItems.set(item.itemId, current + item.quantity);
        }
      }
    }
    if (allItems.size > 0) {
      ctx.log("mission", `Total items needed: ${Array.from(allItems.entries()).map(([id, qty]) => `${qty}x ${id}`).join(", ")}`);
      await ensureItemsInCargo(ctx, Array.from(allItems.entries()).map(([itemId, quantity]) => ({ itemId, quantity })));
    }
  }

  while (bot.state === "running") {
    const nextStep = findNextStep(completedSteps, chain);
    if (!nextStep) {
      ctx.log("mission", "All mission steps completed!");
      break;
    }

    ctx.log("mission", `Executing step: ${nextStep.name} (${nextStep.id})`);

    // For dock-type steps with a mission ID, we need to be at the right station
    if (autoAccept && nextStep.type === "dock" && nextStep.id) {
      // First, ensure we're at the correct station for this mission
      if (nextStep.station) {
        // Check if already at the correct station (resolving mobile station system)
        const targetSystem = await resolveStationSystem(ctx, nextStep);
        // Determine the POI ID to use (for mobile stations, use mobileStationPoiId)
        const poiId = nextStep.isMobileStation && nextStep.mobileStationPoiId 
          ? nextStep.mobileStationPoiId 
          : nextStep.station;
        const atCorrectStation = targetSystem && 
                                bot.system?.toLowerCase() === targetSystem.toLowerCase() && 
                                bot.poi === poiId && bot.docked;
        
        if (!atCorrectStation) {
          ctx.log("mission", `Navigating to ${poiId} for mission ${nextStep.id}...`);
          const docked = await navigateToStation(ctx, nextStep);
          if (!docked) {
            ctx.log("error", `Failed to dock at ${poiId} for mission ${nextStep.id} — stopping routine for investigation. Fix the issue and restart to resume from this step.`);
            return; // Stop the routine instead of retrying
          }
        }
      }

      // Now try to accept the mission
      const activeMissions = await getActiveMissions(ctx);
      const hasMission = activeMissions.some(m => m.id === nextStep.id);
      
      if (!hasMission) {
        const acceptResult = await acceptMission(ctx, nextStep.id);
        if (!acceptResult.success) {
          // Only mark as done if server explicitly says "already completed"
          if (acceptResult.error?.includes("already completed")) {
            ctx.log("mission", `Mission ${nextStep.id} already completed (server confirmed), marking step as done`);
            completedSteps.add(nextStep.id);
            saveProgress(bot.username, chainName, completedSteps);
            await ctx.sleep(2000);
            continue;
          }
          // Mission already active but not in our check? Re-check
          if (acceptResult.error?.includes("already have an active instance")) {
            const recheckMissions = await getActiveMissions(ctx);
            const recheckHasMission = recheckMissions.some(m => m.id === nextStep.id);
            if (recheckHasMission) {
              ctx.log("mission", `Mission ${nextStep.id} already active (confirmed), proceeding`);
              // Continue with the step
            } else {
              ctx.log("error", `Mission ${nextStep.id} accept failed: ${acceptResult.error} — stopping for investigation`);
              return;
            }
          } else {
            // "only available at X" or "not available at this station" = wrong station, NOT completed
            if (acceptResult.error?.includes("only available at") || acceptResult.error?.includes("not available at this station")) {
              ctx.log("error", `Mission ${nextStep.id} not available here (${acceptResult.error}) — we're at the wrong station! Stopping.`);
              return; // Stop the routine
            }
            // Other errors - don't assume completed, stop for investigation
            ctx.log("error", `Mission ${nextStep.id} accept failed: ${acceptResult.error} — stopping for investigation`);
            return;
          }
        }
        await ctx.sleep(2000);
      }
    }

    const success = await executeMissionStep(ctx, nextStep);
    if (!success) {
      ctx.log("error", `Step ${nextStep.id} failed — stopping routine for investigation. Fix the issue and restart to resume from this step.`);
      return; // Stop the routine instead of retrying
    }

    if (autoComplete && nextStep.type === "dock" && nextStep.id) {
      await ctx.sleep(2000);
      const activeMissions = await getActiveMissions(ctx);
      const hasMission = activeMissions.some(m => m.id === nextStep.id);
      if (hasMission) {
        const mission = activeMissions.find(m => m.id === nextStep.id);
        const objectives = (mission?.objectives as Array<Record<string, unknown>>) || [];
        const allComplete = objectives.every((obj) => obj.completed === true || obj.progress === obj.quantity);
        if (allComplete) {
          await completeMission(ctx, nextStep.id);
          await ctx.sleep(2000);
        }
      }
    }

    completedSteps.add(nextStep.id);
    saveProgress(bot.username, chainName, completedSteps);
    ctx.log("mission", `Step ${nextStep.id} completed (${completedSteps.size}/${chain.steps.length})`);
    
    await ctx.sleep(5000);
  }
};

export { MISSION_CHAINS, type MissionChain, type MissionStep };