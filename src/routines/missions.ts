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
import { executePathfinderJumpToBearing } from "./pathfinder.js";
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
  isMission?: boolean;
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
        isMission: false,
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
        isMission: false,
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
        isMission: false,
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
        isMission: false,
        name: "Environmental Sampling (Void Gate)",
        description: "Visit Void Gate Outpost",
        type: "dock",
        system: "void_gate",
        station: "void_gate_outpost",
        completeAfter: ["environmental_sampling"],
      },
      {
        id: "environmental_sampling_last_light",
        isMission: false,
        name: "Environmental Sampling (Last Light)",
        description: "Visit Last Light",
        type: "dock",
        system: "last_light",
        station: "last_light_station",
        completeAfter: ["environmental_sampling_void_gate"],
      },
      {
        id: "environmental_sampling_fsms",
        isMission: false,
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
        isMission: false,
        name: "Observation Points (Timberline)",
        description: "Dock at Timberline",
        type: "dock",
        system: "timberline",
        station: "timberline_station",
        completeAfter: ["observation_points"],
      },
      {
        id: "observation_points_fsms",
        isMission: false,
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
        isMission: false,
        name: "Parallel Installations (TRAPPIST-1)",
        description: "Dock at TRAPPIST-1",
        type: "dock",
        system: "trappist_1",
        station: "trappist_1_station",
        completeAfter: ["parallel_installations"],
      },
      {
        id: "parallel_installations_fsms",
        isMission: false,
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
        isMission: false,
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
        isMission: false,
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
        isMission: false,
        name: "The Allocation Pattern (Node Beta)",
        description: "Pass through Node Beta",
        type: "goto",
        system: "node_beta",
        poi: "node_beta_industrial_station",
        completeAfter: ["the_allocation_pattern"],
      },
      {
        id: "the_allocation_pattern_gamma",
        isMission: false,
        name: "The Allocation Pattern (Node Gamma)",
        description: "Pass through Node Gamma",
        type: "goto",
        system: "node_gamma",
        poi: "node_gamma_relay_station",
        completeAfter: ["the_allocation_pattern_beta"],
      },
      {
        id: "the_allocation_pattern_fsms",
        isMission: false,
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
        isMission: false,
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
        isMission: false,
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

function resolveHomeStation(settings: Record<string, unknown>, bot: Bot): { system?: string; station?: string } {
  const m = ((settings.missions as Record<string, unknown>) || {}) as Record<string, unknown>;
  const g = ((settings.general as Record<string, unknown>) || {}) as Record<string, unknown>;
  const r = ((settings.return_home as Record<string, unknown>) || {}) as Record<string, unknown>;
  const perBot = bot.username ? ((settings[bot.username] as Record<string, unknown>) || {}) as Record<string, unknown> : {};
  const perBotM = ((perBot.missions as Record<string, unknown>) || {}) as Record<string, unknown>;
  const perBotR = ((perBot.return_home as Record<string, unknown>) || {}) as Record<string, unknown>;
  const perBotG = ((perBot.general as Record<string, unknown>) || {}) as Record<string, unknown>;

  const stationCandidates = [
    m.homeStation, perBotM.homeStation, g.factionStorageStation, r.homeStation, perBotR.homeStation, g.homeStation, perBotG.homeStation,
  ].filter((v): v is string => typeof v === "string" && v.length > 0);

  const systemCandidates = [
    g.factionStorageSystem, getHomeSystem(settings), r.homeSystem, perBotR.homeSystem, perBotG.homeSystem,
  ].filter((v): v is string => typeof v === "string" && v.length > 0);

  let system: string | undefined;
  let station: string | undefined;
  for (const c of stationCandidates) {
    if (c.includes("|")) {
      const [sys, st] = c.split("|");
      if (!system && sys) system = sys;
      if (!station && st) station = st;
    } else if (!station) {
      station = c;
    }
  }
  if (!system) system = systemCandidates[0];
  return { system, station };
}

async function goHomeAndDock(ctx: RoutineContext): Promise<boolean> {
  const { bot } = ctx;
  const allSettings = loadSettings() as Record<string, unknown>;
  const { system: homeSystem, station: homeStation } = resolveHomeStation(allSettings, bot);

  if (!homeSystem) {
    ctx.log("error", "No home/faction-storage system configured");
    return false;
  }

  const navigated = await navigateToSystem(ctx, homeSystem);
  if (!navigated) {
    ctx.log("error", `Failed to navigate home to ${homeSystem}`);
    return false;
  }

  const { pois } = await getSystemInfo(ctx);
  let stationPoi = homeStation ? pois.find(p => p.id === homeStation && isStationPoi(p)) : null;
  if (!stationPoi) {
    stationPoi = findStation(pois) || pois.find(p => isStationPoi(p)) || null;
  }
  if (!stationPoi) {
    ctx.log("error", `No station found in home system ${homeSystem}`);
    return false;
  }

  if (bot.poi !== stationPoi.id) {
    ctx.log("travel", `Traveling to ${stationPoi.name}...`);
    const travelResp = await bot.exec("travel", { target_poi: stationPoi.id });
    if (travelResp.error && !travelResp.error.message.includes("already")) {
      ctx.log("error", `Travel to home station failed: ${travelResp.error.message}`);
      return false;
    }
    bot.poi = stationPoi.id;
    await bot.refreshLocation();
  }

  ctx.log("system", "Docking at home station...");
  const dockResp = await bot.exec("dock");
  if (dockResp.error && !dockResp.error.message.includes("already")) {
    ctx.log("error", `Dock at home station failed: ${dockResp.error.message}`);
    return false;
  }
  bot.docked = true;
  await tryRefuel(ctx);
  ctx.log("mission", `Docked at home station ${stationPoi.id} in ${homeSystem}`);
  return true;
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
  if (!poiId) {
    ctx.log("error", `No station POI configured for step ${step.id}`);
    return false;
  }
  
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
  let station = pois.find(p => p.id === poiId && isStationPoi(p));
  if (!station) {
    // Station ids in mission data often don't match the actual POI id; fall back
    // to a name/substring match, then to the first usable station in the system.
    const norm = (s: string) => s.toLowerCase().replace(/[_\s]+/g, "");
    station = pois.find(p => isStationPoi(p) && norm(p.name || p.id) === norm(poiId));
  }
  if (!station) {
    const sub = poiId.toLowerCase().replace(/_station$/i, "");
    station = pois.find(p => isStationPoi(p) && (p.id.toLowerCase().includes(sub) || (p.name || "").toLowerCase().includes(sub)));
  }
  if (!station) {
    station = findStation(pois) || pois.find(p => isStationPoi(p));
  }
  if (!station) {
    // No station in this system. If the active mission only requires visiting
    // the system (visit_system), docking is unnecessary — treat as complete.
    const activeMissions = await getActiveMissions(ctx);
    const visitOnly = activeMissions.some(m => {
      const objs = (m.objectives as Array<Record<string, unknown>>) || [];
      return objs.some(o => o.type === "visit_system" && String(o.system_id || "").toLowerCase() === targetSystem.toLowerCase());
    });
    if (visitOnly) {
      ctx.log("mission", `No station in ${targetSystem}; visit_system objective satisfied by arrival`);
      return true;
    }
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

async function getActiveMissions(ctx: RoutineContext): Promise<Array<{ id: string; uuid: string; name: string; templateId: string; objectives: unknown[] }>> {
  const { bot } = ctx;
  const resp = await bot.exec("get_active_missions");
  if (resp.error || !resp.result) return [];
  const result = resp.result as Record<string, unknown>;
  // API can return various shapes: { missions: { active: [...] } }, { missions: [...] }, [...], etc.
  let raw: Array<Record<string, unknown>> = [];
  if (Array.isArray(result)) {
    raw = result as Array<Record<string, unknown>>;
  } else if (result.missions && typeof result.missions === "object" && !Array.isArray(result.missions)) {
    const m = result.missions as Record<string, unknown>;
    if (Array.isArray(m.active)) raw = m.active as Array<Record<string, unknown>>;
    else if (Array.isArray(m.missions)) raw = m.missions as Array<Record<string, unknown>>;
    else if (Array.isArray(m)) raw = m as unknown as Array<Record<string, unknown>>;
    else if (m.mission_id || m.id || m.mission_template_id || m.title || m.name) raw = [m];
  } else if (Array.isArray(result.missions)) {
    raw = result.missions as Array<Record<string, unknown>>;
  } else if (Array.isArray(result.active)) {
    raw = result.active as Array<Record<string, unknown>>;
  } else if (result.mission_id || result.id || result.mission_template_id || result.title || result.name) {
    raw = [result];
  }
  if (raw.length === 0 && (result.mission_id || result.id || result.mission_template_id || result.title || result.name)) {
    raw = [result];
  }
  return raw.map(m => {
    const templateId = (m.mission_template_id as string) || "";
    const title = (m.title as string) || (m.name as string) || "";
    const uuid = (m.mission_id as string) || (m.id as string) || "";
    // Best key for matching chain steps: prefer template id, then title/name, then uuid
    const id = templateId || title || uuid;
    return {
      id,
      uuid,
      name: title,
      templateId,
      objectives: (m.objectives as unknown[]) || [],
    };
  });
}

function missionMatchesStep(m: { id?: string; name?: string; templateId?: string }, step: { id?: string; name?: string }): boolean {
  const norm = (v: unknown) => String(v ?? "").toLowerCase().replace(/\s+/g, "_").trim();
  const mVals = [m.id, m.templateId, m.name].filter(Boolean).map(norm);
  const sVals = [step.id, step.name].filter(Boolean).map(norm);
  return mVals.some(mv => mv !== "" && sVals.includes(mv));
}

async function ensureItemsInCargo(ctx: RoutineContext, items: Array<{ itemId: string; quantity: number }>): Promise<boolean> {
  const { bot } = ctx;
  await bot.refreshCargo();

  if (!bot.docked) {
    ctx.log("mission", "Not docked - cannot check storage; items must be acquired at a station");
    return false;
  }

  for (const item of items) {
    const have = bot.inventory.find(i => i.itemId === item.itemId)?.quantity || 0;
    if (have >= item.quantity) continue;

    const needed = item.quantity - have;
    ctx.log("mission", `Need ${needed}x ${item.itemId}, checking storage...`);

    // 1. Personal (station) storage -> cargo via withdraw_items
    const storageResp = await bot.exec("view_storage");
    if (storageResp.result) {
      const storage = storageResp.result as Record<string, unknown>;
      const storedItems = (storage.items as Array<Record<string, unknown>>) || [];
      const stored = storedItems.find(i => (i.item_id as string) === item.itemId || (i.id as string) === item.itemId);
      const storedQty = stored ? ((stored.quantity as number) || 0) : 0;

      if (storedQty > 0) {
        const withdraw = Math.min(needed, storedQty);
        const before = bot.inventory.find(i => i.itemId === item.itemId)?.quantity || 0;
        const wResp = await bot.exec("withdraw_items", { item_id: item.itemId, quantity: withdraw });
        await bot.refreshCargo();
        const after = bot.inventory.find(i => i.itemId === item.itemId)?.quantity || 0;
        if (!wResp.error && after > before) {
          ctx.log("mission", `Withdrew ${withdraw}x ${item.itemId} from station storage`);
          continue;
        }
        ctx.log("warn", `Station storage withdraw did not increase cargo for ${item.itemId}: ${wResp.error?.message || ""}`);
      }
    }

    // 2. Faction storage -> station storage -> cargo (two-step; no direct faction->cargo command)
    const factionResp = await bot.exec("view_storage", { target: "faction" });
    if (factionResp.result) {
      const faction = factionResp.result as Record<string, unknown>;
      const factionItems = (faction.items as Array<Record<string, unknown>>) || [];
      const factionStored = factionItems.find(i => (i.item_id as string) === item.itemId || (i.id as string) === item.itemId);
      const factionQty = factionStored ? ((factionStored.quantity as number) || 0) : 0;

      if (factionQty > 0) {
        const withdraw = Math.min(needed, factionQty);
        let actualQty = withdraw;
        // Step A: move faction -> station (personal) storage
        let depResp = await bot.exec("storage", {
          action: "deposit",
          target: "self",
          item_id: item.itemId,
          quantity: actualQty,
          source: "faction",
        });
        if (depResp.error) {
          const msg = String(depResp.error.message || "").toLowerCase();
          if (msg.includes("invalid_quantity") || msg.includes("must be transferred with quantity")) {
            ctx.log("warn", `Faction transfer requires quantity 1 for ${item.itemId} — retrying single-unit`);
            depResp = await bot.exec("storage", {
              action: "deposit",
              target: "self",
              item_id: item.itemId,
              quantity: 1,
              source: "faction",
            });
            actualQty = 1;
          }
        }
        if (depResp.error) {
          ctx.log("warn", `Faction->station transfer failed for ${item.itemId}: ${depResp.error.message}`);
        } else {
          await bot.refreshStorage();
          // Step B: station -> cargo
          const before = bot.inventory.find(i => i.itemId === item.itemId)?.quantity || 0;
          const wResp = await bot.exec("withdraw_items", { item_id: item.itemId, quantity: actualQty });
          await bot.refreshCargo();
          const after = bot.inventory.find(i => i.itemId === item.itemId)?.quantity || 0;
          if (!wResp.error && after > before) {
            ctx.log("mission", `Withdrew ${actualQty}x ${item.itemId} from faction storage`);
            continue;
          }
          ctx.log("warn", `Station->cargo withdraw did not increase cargo for ${item.itemId}: ${wResp.error?.message || ""}`);
        }
      }
    }

    // 3. Market fallback
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
    const storageBefore = bot.storage?.find(i => i.itemId === item.itemId)?.quantity || 0;
    const cargoBefore = bot.inventory.find(i => i.itemId === item.itemId)?.quantity || 0;
    const depResp = await bot.exec("deposit_items", { item_id: item.itemId, quantity: item.quantity });
    if (depResp.error) {
      ctx.log("error", `Deposit failed: ${depResp.error.message}`);
      return false;
    }
    // Verify the deposit actually happened. Some missions consume the items
    // immediately on deposit (station storage unchanged), others keep them in
    // station storage until mission completion. Treat either signal as success:
    // items leaving cargo OR station storage increasing.
    let verified = 0;
    for (let attempt = 1; attempt <= 3; attempt++) {
      await ctx.sleep(1000);
      await bot.refreshStorage();
      await bot.refreshCargo();
      const storageAfter = bot.storage?.find(i => i.itemId === item.itemId)?.quantity || 0;
      const cargoAfter = bot.inventory.find(i => i.itemId === item.itemId)?.quantity || 0;
      const storageGain = Math.max(0, storageAfter - storageBefore);
      const cargoLoss = Math.max(0, cargoBefore - cargoAfter);
      if (storageGain > 0 || cargoLoss > 0) {
        verified = storageGain > 0 ? storageGain : cargoLoss;
        break;
      }
      ctx.log("warn", `Station storage/cargo unchanged after deposit (attempt ${attempt}/3) for ${item.itemId}`);
    }
    await bot.refreshCargo();
    if (verified <= 0) {
      ctx.log("error", `Deposit reported success but neither cargo nor station storage changed for ${item.itemId}`);
      return false;
    }
    ctx.log("mission", `Deposited ${item.quantity}x ${item.itemId} (verified ${verified})`);
  }
  return true;
}

async function executeMissionStep(ctx: RoutineContext, step: MissionStep): Promise<boolean> {
  const { bot } = ctx;
  const settings = getMissionSettings(bot);
  // removed unused top-level vars; defined in cases where needed

  // Ensure any incomplete visit_system objectives of the active mission are
  // satisfied before executing this step.
  try {
    const activeMissions = await getActiveMissions(ctx);
    const mission = activeMissions.find(m => missionMatchesStep(m, step)) || activeMissions.find(m => {
      const objs = (m.objectives as Array<Record<string, unknown>>) || [];
      return objs.some(o => {
        const tb = String(o.target_base || o.target_base_id || "").toLowerCase();
        const ts = String(step.station || "").toLowerCase();
        const sid = String(o.system_id || "").toLowerCase();
        const ss = String(step.system || "").toLowerCase();
        if (o.type === "visit_system") return sid !== "" && sid === ss;
        return ts !== "" && (tb === ts || tb.includes(ts) || ts.includes(tb));
      });
    });
    if (mission) {
      const objs = (mission.objectives as Array<Record<string, unknown>>) || [];
      const incompleteVisits = objs.filter(o => o.type === "visit_system" && o.completed !== true && o.system_id);
      for (const vo of incompleteVisits) {
        const sid = String(vo.system_id);
        ctx.log("mission", `Visiting incomplete objective system: ${sid}...`);
        await navigateToSystem(ctx, sid);
        await ctx.sleep(1500);
      }
    }
  } catch (e) {
    // ignore
  }
  
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
        // If this dock step fulfills delivery objectives of an active mission,
        // acquire those items from home faction storage BEFORE traveling.
        const activeMissions = await getActiveMissions(ctx);
        let mission = activeMissions.find(m => missionMatchesStep(m, step));
        if (!mission && step.completeAfter) {
          for (const pid of step.completeAfter) {
            mission = activeMissions.find(m => missionMatchesStep(m, { id: pid, name: pid }));
            if (mission) break;
          }
        }
        if (mission) {
          const objs = (mission.objectives as Array<Record<string, unknown>>) || [];
          const targetStation = (step.isMobileStation ? step.mobileStationId : step.station) || step.station;
          const deliverObjs = objs.filter(o => {
            if (o.completed === true) return false;
            if (o.type !== "deliver_item") return false;
            const tb = String(o.target_base || o.target_base_id || "").toLowerCase();
            const ts = String(targetStation || "").toLowerCase();
            return !!tb && (tb === ts || tb.includes(ts) || ts.includes(tb));
          });
          if (deliverObjs.length > 0) {
            const items = deliverObjs.map(o => ({
              itemId: String(o.item_id || o.itemId || ""),
              quantity: Math.max(0, ((o.required as number) || 0) - ((o.current as number) || 0)),
            })).filter(it => it.itemId && it.quantity > 0);
            if (items.length > 0) {
              ctx.log("mission", `Dock step requires delivery items: ${items.map(i => `${i.quantity}x ${i.itemId}`).join(", ")}`);
              await bot.refreshCargo();
              const hasAll = () => items.every(it => (bot.inventory.find(i => i.itemId === it.itemId)?.quantity || 0) >= it.quantity);
              let have = hasAll();
              if (!have && bot.docked) {
                have = await ensureItemsInCargo(ctx, items);
                await bot.refreshCargo();
                have = hasAll();
              }
              if (!have) {
                ctx.log("mission", "Traveling HOME to acquire delivery items from faction storage...");
                const docked = await goHomeAndDock(ctx);
                if (!docked) {
                  ctx.log("error", `Cannot reach home station for ${step.id}`);
                  return false;
                }
                have = await ensureItemsInCargo(ctx, items);
                await bot.refreshCargo();
                have = hasAll();
                if (!have) {
                  ctx.log("error", `Cannot acquire delivery items for ${step.id}`);
                  return false;
                }
              }
            }
          }
        }
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
      if (step.bearing !== undefined) {
        await ensureUndocked(ctx);
        ctx.log("travel", `Jumping bearing ${step.bearing}...`);
        const jumpResp = await bot.exec("jump", { target_system: step.bearing });
        if (jumpResp.error) {
          ctx.log("error", `Bearing jump failed: ${jumpResp.error.message}`);
          return false;
        }
        // Wait for transit to start
        let inTransit = false;
        for (let i = 0; i < 60 && bot.state === "running" && !inTransit; i++) {
          await ctx.sleep(1000);
          const poiResp = await bot.exec("get_poi");
          if (poiResp.result && typeof poiResp.result === "object") {
            inTransit = (poiResp.result as Record<string, unknown>).in_transit === true;
          }
        }
        if (!inTransit) {
          ctx.log("error", `Bearing jump ${step.bearing} — transit never started`);
          return false;
        }
        // If a distance is given, turn around after traveling that far.
        if (step.distance && step.distance > 0) {
          const targetTicks = Math.ceil(step.distance / 10);
          const startTick = await bot.pollCurrentTick();
          let redirected = false;
          while (bot.state === "running" && inTransit) {
            await ctx.sleep(2000);
            const poiResp = await bot.exec("get_poi");
            if (poiResp.result && typeof poiResp.result === "object") {
              inTransit = (poiResp.result as Record<string, unknown>).in_transit === true;
            }
            if (!redirected && startTick !== null && inTransit) {
              const nowTick = await bot.pollCurrentTick();
              if (nowTick !== null && nowTick - startTick >= targetTicks) {
                const newBearing = (step.bearing + 180) % 360;
                ctx.log("travel", `Turn-around: redirecting to bearing ${newBearing}...`);
                const rResp = await bot.exec("jump", { target_system: newBearing });
                if (rResp.error) {
                  ctx.log("error", `Redirect failed: ${rResp.error.message}`);
                  return false;
                }
                redirected = true;
              }
            }
          }
        } else {
          while (bot.state === "running" && inTransit) {
            await ctx.sleep(2000);
            const poiResp = await bot.exec("get_poi");
            if (poiResp.result && typeof poiResp.result === "object") {
              inTransit = (poiResp.result as Record<string, unknown>).in_transit === true;
            }
          }
        }
        await bot.refreshLocation();
      }
      if (step.poi) {
        await ctx.sleep(2000);
        const interactResp = await bot.exec("interact_poi", { poi_id: step.poi });
        if (interactResp.error) {
          ctx.log("error", `Interact POI failed: ${interactResp.error.message}`);
          return false;
        }
      }
      return true;
    }
    case "pathfinder_jump": {
      // Navigate to launch system first
      if (step.system) {
        const navigated = await navigateToSystem(ctx, step.system);
        if (!navigated) {
          ctx.log("warn", `Could not reach launch system ${step.system}; jumping from current location ${bot.system}`);
        }
      }
      await ensureUndocked(ctx);

      const disablePathfinder = settings.disablePathfinderJumps === true;
      if (disablePathfinder) {
        ctx.log("error", `Pathfinder jump required for step "${step.name}" but pathfinder jumps are DISABLED in settings.`);
        ctx.log("error", `Please enable "Allow Pathfinder Jumps" in Missions settings.`);
        return false;
      }

      // Check fuel level
      const minFuelPct = (settings.minFuelForPathfinder as number) ?? 80;
      await bot.refreshShip();
      const fuelPct = bot.maxFuel > 0 ? (bot.fuel / bot.maxFuel) * 100 : 100;
      if (fuelPct < minFuelPct) {
        ctx.log("error", `Pathfinder jump requires ${minFuelPct}% fuel, current: ${fuelPct.toFixed(1)}%. Refueling first...`);
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

      if (step.bearing === undefined || step.bearing < 0 || step.bearing > 360) {
        ctx.log("error", `Invalid bearing for pathfinder jump: ${step.bearing}. Must be 0-360 degrees.`);
        return false;
      }

      await bot.refreshShip();
      if (!bot.hasPathfinderDrive) {
        await bot.refreshShipMods();
      }
      if (!bot.hasPathfinderDrive) {
        ctx.log("error", `No Pathfinder Drive equipped! Cannot execute pathfinder jump.`);
        return false;
      }

      const currentSys = mapStore.getSystem(bot.system);
      const originPos = currentSys?.position ? { x: currentSys.position.x, y: currentSys.position.y } : null;

      ctx.log("travel", `⚠️ PATHFINDER JUMP: bearing ${step.bearing}...`);
      const result = await executePathfinderJumpToBearing(ctx, step.bearing, originPos, { waitForCompletion: true });
      if (!result.success) {
        ctx.log("error", `Pathfinder jump failed`);
        return false;
      }
      await bot.refreshLocation();

      if (step.poi) {
        await ctx.sleep(2000);
        const interactResp = await bot.exec("interact_poi", { poi_id: step.poi });
        if (interactResp.error) {
          ctx.log("error", `Interact POI after pathfinder jump failed: ${interactResp.error.message}`);
          return false;
        }
      }

      // Optional return-to-station after the jump (e.g. back to FSMS)
      if (step.station) {
        const targetSystem = step.system && step.system !== "first_step" ? step.system : undefined;
        // Resolve via navigateToStation using a synthetic step-like approach
        const navStep = { ...step } as MissionStep;
        const ok = await navigateToStation(ctx, navStep);
        if (!ok) {
          ctx.log("warn", `Post-jump navigation to station ${step.station} failed; continuing`);
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
        // Verify cargo first
        await bot.refreshCargo();
        const hasAll = () => step.items!.every(it => (bot.inventory.find(i => i.itemId === it.itemId)?.quantity || 0) >= it.quantity);

        let have = hasAll();
        if (!have && bot.docked) {
          have = await ensureItemsInCargo(ctx, step.items);
          await bot.refreshCargo();
          have = hasAll();
        }

        // If still missing, go HOME to grab from home base's faction storage (do NOT travel to destination empty)
        if (!have) {
          ctx.log("mission", `Insufficient items in cargo; traveling HOME to grab required items from faction storage...`);
          const docked = await goHomeAndDock(ctx);
          if (!docked) {
            ctx.log("error", `Cannot reach home station to acquire items for ${step.id}`);
            return false;
          }
          have = await ensureItemsInCargo(ctx, step.items);
          await bot.refreshCargo();
          have = hasAll();
          if (!have) {
            ctx.log("error", `Cannot acquire required items for ${step.id} from home faction storage`);
            return false;
          }
        }

        // Final verification before leaving home
        await bot.refreshCargo();
        for (const it of step.items) {
          const q = bot.inventory.find(i => i.itemId === it.itemId)?.quantity || 0;
          if (q < it.quantity) {
            ctx.log("error", `Item check failed before departure: have ${q}x ${it.itemId}, need ${it.quantity}`);
            return false;
          }
        }
        ctx.log("mission", `Cargo verified: ${step.items.map(it => `${it.quantity}x ${it.itemId}`).join(", ")}`);

        // Now navigate to the delivery station
        if (step.station) {
          const targetSystem = await resolveStationSystem(ctx, step);
          if (targetSystem) {
            const navigated = await navigateToSystem(ctx, targetSystem);
            if (!navigated) {
              ctx.log("error", `Failed to reach delivery station for ${step.id}`);
              return false;
            }
            const poiId = step.isMobileStation && step.mobileStationPoiId ? step.mobileStationPoiId : step.station;
            const { pois } = await getSystemInfo(ctx);
            const st0 = pois.find(p => p.id === poiId && isStationPoi(p));
            const st = st0 || pois.find(p => isStationPoi(p) && (p.id.toLowerCase().includes(String(poiId).toLowerCase().replace(/_station$/i, "")) || (p.name || "").toLowerCase().includes(String(poiId).toLowerCase().replace(/_station$/i, "")))) || findStation(pois) || pois.find(p => isStationPoi(p)) || null;
            if (st) {
              if (bot.poi !== st.id) {
                ctx.log("travel", `Traveling to ${st.name}...`);
                const tr = await bot.exec("travel", { target_poi: st.id });
                if (tr.error && !tr.error.message.includes("already")) {
                  ctx.log("error", `Travel failed: ${tr.error.message}`);
                  return false;
                }
                bot.poi = st.id;
                await bot.refreshLocation();
              }
              const dr = await bot.exec("dock");
              if (dr.error && !dr.error.message.includes("already")) {
                ctx.log("error", `Dock at delivery station failed: ${dr.error.message}`);
                return false;
              }
              bot.docked = true;
              await tryRefuel(ctx);
            } else {
              ctx.log("error", `Delivery station ${poiId} not found in ${targetSystem}`);
              return false;
            }
          } else {
            ctx.log("error", `Cannot resolve delivery system for ${step.id}`);
            return false;
          }
        }

        if (!bot.docked) {
          ctx.log("error", `Not docked at delivery station for ${step.id}`);
          return false;
        }

        // Verify items still in cargo before delivering
        await bot.refreshCargo();
        for (const it of step.items) {
          const q = bot.inventory.find(i => i.itemId === it.itemId)?.quantity || 0;
          if (q < it.quantity) {
            ctx.log("error", `Items missing at delivery station: have ${q}x ${it.itemId}, need ${it.quantity}`);
            return false;
          }
        }

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

// â”€â”€ Progress Persistence â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

interface StepProgressDetail {
  stepId: string;
  stepName: string;
  stepDescription?: string;
  stepType?: string;
  system?: string;
  station?: string;
  status: "completed" | "in_progress" | "skipped" | "failed";
  completedAt?: number;
  missionTitle?: string;
  missionDescription?: string;
  missionTemplateId?: string;
  missionUuid?: string;
  percentComplete?: number;
  objectives?: Array<{ description?: string; type?: string; completed?: boolean; current?: number; required?: number; targetBase?: string; targetBaseName?: string; systemName?: string }>;
  notes?: string;
}

interface MissionProgress {
  chainName: string;
  chainSteps?: Array<{ id: string; name: string; description: string; type: string; system?: string; station?: string }>;
  completedSteps: string[];
  stepDetails: Record<string, StepProgressDetail>;
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

function saveProgress(botUsername: string, chainName: string, completedSteps: Set<string>, chain?: MissionChain): void {
  try {
    ensureProgressDir();
    const file = getProgressFile(botUsername);
    let existing: MissionProgress | null = null;
    if (existsSync(file)) {
      try { existing = JSON.parse(readFileSync(file, "utf-8")) as MissionProgress; } catch (e) { existing = null; }
    }
    const data: MissionProgress = {
      chainName,
      chainSteps: chain ? chain.steps.map(st => ({ id: st.id, name: st.name, description: st.description, type: st.type, system: st.system, station: st.station })) : (existing?.chainSteps),
      completedSteps: Array.from(completedSteps),
      stepDetails: existing?.stepDetails || {},
      lastUpdated: Date.now(),
    };
    writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf-8");
  } catch (e) {
    // Ignore write errors
  }
}

function recordStepResult(botUsername: string, chainName: string, step: MissionStep, mission: { title?: string; description?: string; template_id?: string; mission_id?: string; uuid?: string; percent_complete?: number; objectives?: Array<Record<string, unknown>> } | null, status: "completed" | "in_progress" | "skipped" | "failed", notes?: string): void {
  try {
    ensureProgressDir();
    const file = getProgressFile(botUsername);
    let data: MissionProgress | null = null;
    if (existsSync(file)) {
      try { data = JSON.parse(readFileSync(file, "utf-8")) as MissionProgress; } catch (e) { data = null; }
    }
    if (!data || data.chainName !== chainName) {
      data = { chainName, completedSteps: [], stepDetails: {}, lastUpdated: Date.now() };
    }
    if (!data.stepDetails) data.stepDetails = {};
    data.stepDetails[step.id] = {
      stepId: step.id,
      stepName: step.name,
      stepDescription: step.description,
      stepType: step.type,
      system: step.system,
      station: step.station,
      status,
      completedAt: status === "completed" ? Date.now() : undefined,
      missionTitle: mission?.title,
      missionDescription: mission?.description,
      missionTemplateId: mission?.template_id,
      missionUuid: mission?.mission_id || mission?.uuid,
      percentComplete: mission?.percent_complete,
      objectives: (mission?.objectives || []).map(o => ({
        description: o.description as string,
        type: o.type as string,
        completed: o.completed as boolean,
        current: o.current as number,
        required: o.required as number,
        targetBase: (o.target_base || o.target_base_id) as string,
        targetBaseName: (o.target_base_name) as string,
        systemName: (o.system_name) as string,
      })),
      notes,
    };
    data.lastUpdated = Date.now();
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
  
  // ONLY verify completion for missions that are currently active
  // If a mission is active AND its objectives are complete, it's done
  // We do NOT infer completion from prerequisites or location
  for (const step of chain.steps) {
    if (!step.id) continue;

    const activeMission = activeMissions.find(m => missionMatchesStep(m, step));

    // If this mission is currently active, its completion status is dictated by
    // its objectives — NOT by saved progress. Remove from completed if incomplete.
    if (activeMission) {
      const objectives = (activeMission?.objectives as Array<Record<string, unknown>>) || [];
      const allComplete = objectives.length > 0 && objectives.every((obj) => obj.completed === true || (obj.current !== undefined && obj.current === obj.required) || (obj.progress !== undefined && obj.progress === obj.quantity));
      if (allComplete) {
        completed.add(step.id);
      } else {
        completed.delete(step.id);
        // Only clear subsequent steps whose objectives are not yet done
        const idx = chain.steps.indexOf(step);
        const objs = (activeMission?.objectives as Array<Record<string, unknown>>) || [];
        for (let k = idx; k < chain.steps.length; k++) {
          const st = chain.steps[k];
          if (!st.id) continue;
          const matchingObj = objs.find(o => {
            const tb = String(o.target_base || o.target_base_id || "").toLowerCase();
            const ts = String(st.station || "").toLowerCase();
            const sid = String(o.system_id || "").toLowerCase();
            const ss = String(st.system || "").toLowerCase();
            if (o.type === "visit_system") return sid !== "" && sid === ss;
            return ts !== "" && (tb === ts || tb.includes(ts) || ts.includes(tb));
          });
          if (matchingObj) {
            const done = matchingObj.completed === true || (matchingObj.current !== undefined && matchingObj.current === matchingObj.required);
            if (done) completed.add(st.id);
            else completed.delete(st.id);
          }
        }
        ctx.log("mission", `Active mission ${step.id} still in progress — reconciled completed steps`);
      }
      continue;
    }

    // Sub-requirement steps whose parent mission is still active with incomplete
    // objectives must NOT be considered completed.
    if (step.isMission === false && step.completeAfter) {
      const parentActive = step.completeAfter.some(pid => activeMissions.some(m => missionMatchesStep(m, { id: pid, name: pid })));
      if (parentActive) {
        completed.delete(step.id);
        continue;
      }
    }

    // For missions not currently active, trust saved progress (no change).
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

   // Refresh actual location/docked state (may be stale after a restart mid-travel)
   await bot.refreshLocation();
   ctx.log("mission", `Current location: system=${bot.system}, poi=${bot.poi}, docked=${bot.docked}`);

   // Ensure docked before doing anything else; do not travel to mission destinations
   // while undocked.
   if (!bot.docked) {
     ctx.log("mission", "Not docked at startup — docking before proceeding...");
     const docked = await ensureDocked(ctx);
     if (!docked) {
       ctx.log("error", "Could not dock at startup — stopping routine");
       return;
     }
     await bot.refreshLocation();
   }

  // Load saved progress
  const completedSteps = loadProgress(bot.username, chainName);
  
  // Detect current position in chain from game state (location, active missions, etc.)
  // This reconciles saved progress with reality
  const reconciled = await detectChainPositionFromGameState(ctx, chain, completedSteps);
  for (const id of reconciled) completedSteps.add(id);
  
  // Reconcile: if a mission is currently active, its step is NOT completed
  const currentActive = await getActiveMissions(ctx);
  for (const m of currentActive) {
    const step = chain.steps.find(s => missionMatchesStep(m, s));
    if (step?.id) {
      completedSteps.delete(step.id);
    }
  }
  saveProgress(bot.username, chainName, completedSteps);
  
  if (completedSteps.size > 0) {
    ctx.log("mission", `Resuming from step ${completedSteps.size + 1}/${chain.steps.length} (${completedSteps.size} steps already completed)`);
  }

  // === Smart Chain Position Detection (NO TRAVEL) ===
  // Stay at current location, try to accept missions in order
  // - "already completed" â†’ mark done, continue to next
  // - "only available at X" â†’ that's our next mission, go to X
  // - accepted successfully â†’ that's our next mission
  // - "already have an active instance" â†’ that's our next mission
  // - other error â†’ stop for investigation
  ctx.log("mission", "Detecting current position in mission chain (no travel)...");
  let firstIncompleteIndex = -1;
  
  // Get active missions ONCE at start
  const activeMissions = await getActiveMissions(ctx);

  // Fast path: if an active mission matches a chain step, jump straight to it
  // without iterating/accepting from the start.
  const activeMatchIndex = chain.steps.findIndex(step => !!step.id && activeMissions.some(m => missionMatchesStep(m, step)));
  if (activeMatchIndex !== -1) {
    for (let j = 0; j < activeMatchIndex; j++) {
      if (chain.steps[j].id) completedSteps.add(chain.steps[j].id);
    }
    // Clear any stale completed entries at/after the active step so the routine
    // never skips ahead past the mission the game says is still active.
    for (let j = activeMatchIndex; j < chain.steps.length; j++) {
      if (chain.steps[j].id) completedSteps.delete(chain.steps[j].id);
    }
    saveProgress(bot.username, chainName, completedSteps, chain);
    firstIncompleteIndex = activeMatchIndex;
    ctx.log("mission", `Active mission found at step ${chain.steps[activeMatchIndex].id} (index ${activeMatchIndex}); marked ${activeMatchIndex} prior steps completed`);
  }

  if (firstIncompleteIndex === -1) {
  // Only verify (via accept) missions within the last 2 steps of saved progress;
  // trust saved progress for anything further back to avoid re-accepting every mission.
  let progressStart = 0;
  for (let k = 0; k < chain.steps.length; k++) {
    const s = chain.steps[k];
    if (s.id && !completedSteps.has(s.id)) { progressStart = k; break; }
  }
  if (progressStart === 0 && completedSteps.size >= chain.steps.length) progressStart = chain.steps.length;
  const verifyFromIndex = Math.max(0, progressStart - 2);

  for (let i = 0; i < chain.steps.length; i++) {
    const step = chain.steps[i];
    if (!step.id) continue;

    // Trust saved progress for missions further than 2 steps behind current position
    if (completedSteps.has(step.id) && i < verifyFromIndex) {
      continue;
    }
    
    // Check if already active FIRST - no need to try accept
    if (activeMissions.some(m => missionMatchesStep(m, step))) {
      firstIncompleteIndex = i;
      ctx.log("mission", `Mission ${step.id} already active (from get_active_missions), this is our next step`);
      break;
    }

    // Not docked: can't accept missions. Trust saved progress + active missions.
    if (!bot.docked) {
      if (step.isMission === false) {
        const parentsDone = !step.completeAfter || step.completeAfter.every(id => completedSteps.has(id));
        if (parentsDone) {
          completedSteps.add(step.id);
          saveProgress(bot.username, chainName, completedSteps, chain);
          continue;
        }
      }
      if (completedSteps.has(step.id)) continue;
      firstIncompleteIndex = i;
      ctx.log("mission", `Not docked; resuming from step ${step.id} (index ${i})`);
      break;
    }
    
    // Skip if already verified as completed
    if (completedSteps.has(step.id)) {
      // Sub-requirements are not accept-able; ensure completed if parent done
      if (step.isMission === false) {
        if (!completedSteps.has(step.id)) {
          const parentsDone = !step.completeAfter || step.completeAfter.every(id => completedSteps.has(id));
          if (parentsDone) completedSteps.add(step.id);
        }
        await ctx.sleep(200);
        continue;
      }
      // Just try accept at CURRENT location
      const acceptResult = await acceptMission(ctx, step.id);
      if (!acceptResult.success) {
        if (acceptResult.error?.includes("already completed")) {
          ctx.log("mission", `Verified ${step.id}: already completed (server confirmed)`);
          recordStepResult(bot.username, chainName, step, null, "completed", "Verified already completed via accept");
          await ctx.sleep(200);
          continue;
        }
        if (acceptResult.error?.includes("already have an active")) {
          // Mission already active - it's our next step
          completedSteps.delete(step.id);
          saveProgress(bot.username, chainName, completedSteps);
          firstIncompleteIndex = i;
          ctx.log("mission", `Mission ${step.id} already active, this is our next step`);
          break;
        }
        if (acceptResult.error?.includes("not found") || acceptResult.error?.includes("mission_not_found")) {
          // Not a real mission (sub-requirement); treat as completed
          await ctx.sleep(200);
          continue;
        }
        if (acceptResult.error?.includes("not_docked") || acceptResult.error?.includes("not docked")) {
          // Not docked; can't verify. Trust progress.
          await ctx.sleep(200);
          continue;
        }
        // Any other error at current location = not completed, this is where we are
        completedSteps.delete(step.id);
        saveProgress(bot.username, chainName, completedSteps);
        firstIncompleteIndex = i;
        ctx.log("mission", `Found incomplete step at current location: ${step.id} (index ${i})`);
        break;
      } else {
        // Wasn't actually completed
        completedSteps.delete(step.id);
        saveProgress(bot.username, chainName, completedSteps);
        // Verify it's now in active missions
        await ctx.sleep(500);
        const verifyMissions = await getActiveMissions(ctx);
        const verifyHasMission = verifyMissions.some(m => missionMatchesStep(m, step));
        if (!verifyHasMission) {
          ctx.log("error", `Mission ${step.id} accept reported success but NOT in active missions â€” stopping for investigation`);
          return;
        }
        firstIncompleteIndex = i;
        ctx.log("mission", `Found incomplete step (just accepted at current location): ${step.id} (index ${i})`);
        break;
      }
      await ctx.sleep(200);
      continue;
    }
    
    // Sub-requirement steps: skip accept; auto-complete if parent mission done
    if (step.isMission === false) {
      const parentsDone = !step.completeAfter || step.completeAfter.every(id => completedSteps.has(id));
      if (parentsDone) {
        completedSteps.add(step.id);
        saveProgress(bot.username, chainName, completedSteps);
        ctx.log("mission", `Sub-requirement ${step.id} skipped (parent mission completed)`);
        recordStepResult(bot.username, chainName, step, null, "skipped", "Parent mission completed");
        await ctx.sleep(200);
        continue;
      }
      // Parent mission still in progress - this is our next objective
      firstIncompleteIndex = i;
      ctx.log("mission", `Sub-requirement ${step.id} is next objective of in-progress mission`);
      break;
    }
    
    // This step is not in completed - try to accept at CURRENT location
    const acceptResult = await acceptMission(ctx, step.id);
    if (acceptResult.success) {
      // Accepted! This is our next mission to do
      // Verify it's now in active missions
      await ctx.sleep(500);
      const verifyMissions = await getActiveMissions(ctx);
      const verifyHasMission = verifyMissions.some(m => missionMatchesStep(m, step));
      if (!verifyHasMission) {
        ctx.log("error", `Mission ${step.id} accept reported success but NOT in active missions â€” stopping for investigation`);
        return;
      }
      firstIncompleteIndex = i;
      ctx.log("mission", `Next mission to do: ${step.id} (just accepted it at current location)`);
      break;
    }
    
    // Check error
    if (acceptResult.error?.includes("already completed")) {
      // Already done - mark and continue
      ctx.log("mission", `Already completed: ${step.id}, moving to next`);
      completedSteps.add(step.id);
      saveProgress(bot.username, chainName, completedSteps);
      recordStepResult(bot.username, chainName, step, null, "completed", "Accept returned already completed");
      await ctx.sleep(200);
      continue;
    }
    
    if (acceptResult.error?.includes("already have an active")) {
      // Mission already active - it's our next step
      firstIncompleteIndex = i;
      ctx.log("mission", `Mission ${step.id} already active, this is our next step`);
      break;
    }
    
    if (acceptResult.error?.includes("not found") || acceptResult.error?.includes("mission_not_found")) {
      // Not a real mission (sub-requirement); proceed to execute
      firstIncompleteIndex = i;
      ctx.log("mission", `Step ${step.id} is not an accept-able mission (sub-requirement), proceeding`);
      break;
    }
    
    if (acceptResult.error?.includes("only available at") || acceptResult.error?.includes("not available at this station")) {
      // This mission is NOT completed, and it's only available at a specific station
      // This is our next step - we need to go to that station
      firstIncompleteIndex = i;
      ctx.log("mission", `Mission ${step.id} not completed (only available at specific station), this is our next step`);
      break;
    }
    
    if (acceptResult.error?.includes("not_docked") || acceptResult.error?.includes("not docked")) {
      firstIncompleteIndex = i;
      ctx.log("mission", `Not docked; resuming from step ${step.id}`);
      break;
    }

    if (acceptResult.error?.includes("requires completing mission") || acceptResult.error?.includes("prerequisite")) {
      const m = acceptResult.error.match(/\[([^\]]+)\]/);
      const prereqId = m ? m[1] : null;
      const prereqStep = prereqId ? chain.steps.find(s => s.id === prereqId) : undefined;
      if (prereqStep) {
        const idx = chain.steps.indexOf(prereqStep);
        for (let j = idx; j < chain.steps.length; j++) {
          if (chain.steps[j].id) completedSteps.delete(chain.steps[j].id);
        }
        saveProgress(bot.username, chainName, completedSteps);
        firstIncompleteIndex = idx;
        ctx.log("mission", `Accept blocked by prerequisite ${prereqId}; switching to that mission first (detection)`);
        break;
      }
    }

    // Other error - stop for investigation
    ctx.log("error", `Mission ${step.id} accept failed: ${acceptResult.error} — stopping for investigation`);
    return;
    
    await ctx.sleep(200);
  }
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
      if (completedSteps.has(step.id)) continue; // skip completed missions
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
     // Complete any missions that are already fully done before picking the next step
     await ctx.sleep(1500);
     const readyMissions = await getActiveMissions(ctx);
     for (const m of readyMissions) {
       const objs = (m.objectives as Array<Record<string, unknown>>) || [];
       const allDone = objs.length > 0 && objs.every(o => o.completed === true || (o.current !== undefined && o.current === o.required) || (o.progress !== undefined && o.progress === o.quantity));
       if (allDone) {
         const mid = (m as { uuid?: string; mission_id?: string; id?: string }).uuid || (m as { mission_id?: string }).mission_id || (m as { id?: string }).id;
         if (mid) {
           ctx.log("mission", `Mission ${(m as { title?: string; name?: string }).title || (m as { name?: string }).name} is complete — turning it in...`);
           await completeMission(ctx, mid);
           await ctx.sleep(1500);
         }
       }
     }

     // Source of truth: get_active_missions. Remove completed entries only for steps
     // whose corresponding objective is NOT yet done, so finished sub-steps stay
     // completed while the mission remains active.
     const activeNow2 = await getActiveMissions(ctx);
     const activeIdx2 = chain.steps.findIndex(s => !!s.id && activeNow2.some(m => missionMatchesStep(m, s)));
     if (activeIdx2 !== -1) {
       const mission = activeNow2.find(m => missionMatchesStep(m, chain.steps[activeIdx2]));
       const objs = (mission?.objectives as Array<Record<string, unknown>>) || [];
       for (let j = activeIdx2; j < chain.steps.length; j++) {
         const st = chain.steps[j];
         if (!st.id) continue;
         // Only reconcile steps that belong to the active mission; other missions'
         // steps must not inherit this mission's objective completion.
         const activeTemplate = String(mission?.templateId || activeNow2.find(m => missionMatchesStep(m, chain.steps[activeIdx2]))?.templateId || "").toLowerCase();
         const stepMission = st.id.split("_")[0] + "_" + (st.id.split("_")[1] || "");
         // Simpler: step belongs to active mission if its id starts with the active template id
         const belongsToActive = activeTemplate !== "" && st.id.toLowerCase().startsWith(activeTemplate);
         if (!belongsToActive) {
           // Don't trust saved progress for steps of other missions
           completedSteps.delete(st.id);
           continue;
         }
         // Find a matching objective for this step
         const matchingObj = objs.find(o => {
           const tb = String(o.target_base || o.target_base_id || "").toLowerCase();
           const ts = String(st.station || "").toLowerCase();
           const sid = String(o.system_id || "").toLowerCase();
           const ss = String(st.system || "").toLowerCase();
           if (o.type === "visit_system") return sid !== "" && sid === ss;
           return ts !== "" && (tb === ts || tb.includes(ts) || ts.includes(tb));
         });
         if (matchingObj) {
           const done = matchingObj.completed === true || (matchingObj.current !== undefined && matchingObj.current === matchingObj.required);
           if (done) {
             completedSteps.add(st.id);
           } else {
             completedSteps.delete(st.id);
           }
         } else {
           // Step belongs to a different mission than the active one; do not
           // trust saved progress for it — force re-evaluation.
           completedSteps.delete(st.id);
         }
       }
       saveProgress(bot.username, chainName, completedSteps, chain);
     }

     // Mark any step as completed if its corresponding objective is already done
     // in any active mission, regardless of position detection.
     const allActiveForCompletion = await getActiveMissions(ctx);
     for (const st of chain.steps) {
       if (!st.id) continue;
       if (completedSteps.has(st.id)) continue;
       for (const m of allActiveForCompletion) {
         const activeTemplate = String(m.templateId || "").toLowerCase();
         // Only mark steps that belong to this active mission
         if (activeTemplate && !st.id.toLowerCase().startsWith(activeTemplate)) continue;
         const objs = (m.objectives as Array<Record<string, unknown>>) || [];
         const matchingObj = objs.find(o => {
           const tb = String(o.target_base || o.target_base_id || "").toLowerCase();
           const ts = String(st.station || "").toLowerCase();
           const sid = String(o.system_id || "").toLowerCase();
           const ss = String(st.system || "").toLowerCase();
           if (o.type === "visit_system") return sid !== "" && sid === ss;
           return ts !== "" && (tb === ts || tb.includes(ts) || ts.includes(tb));
         });
         if (matchingObj && (matchingObj.completed === true || (matchingObj.current !== undefined && matchingObj.current === matchingObj.required))) {
           completedSteps.add(st.id);
           break;
         }
       }
     }
     saveProgress(bot.username, chainName, completedSteps, chain);

     // If any active mission has incomplete visit_system objectives, visit those
     // systems first instead of advancing to the next chain step.
     const activeForVisits = await getActiveMissions(ctx);
     let visitedAny = false;
     for (const m of activeForVisits) {
       const objs = (m.objectives as Array<Record<string, unknown>>) || [];
       const incompleteVisits = objs.filter(o => o.type === "visit_system" && o.completed !== true && o.system_id);
       for (const vo of incompleteVisits) {
         ctx.log("mission", `Incomplete visit objective: ${vo.system_name || vo.system_id}; traveling there to complete it...`);
         await navigateToSystem(ctx, String(vo.system_id));
         await ctx.sleep(2000);
         visitedAny = true;
       }
     }
     if (visitedAny) {
       // Re-check after travel; loop again to complete the mission / advance
       continue;
     }

     let nextStep = findNextStep(completedSteps, chain);
     if (!nextStep) {
       ctx.log("mission", "All mission steps completed!");
       break;
     }

     // Source of truth: get_active_missions. Never skip ahead past the mission
     // the game says is still active.
     const activeNow = await getActiveMissions(ctx);
     const activeIdx = chain.steps.findIndex(s => !!s.id && activeNow.some(m => missionMatchesStep(m, s)));
     if (activeIdx !== -1 && !completedSteps.has(chain.steps[activeIdx].id)) {
       if (!nextStep) break;
       const nextIdx = chain.steps.findIndex(s => s.id === nextStep!.id);
       if (activeIdx < nextIdx) {
         nextStep = chain.steps[activeIdx];
         ctx.log("mission", `Active mission override: executing ${nextStep.id} instead of skipping ahead`);
       }
     }

     ctx.log("mission", `Executing step: ${nextStep.name} (${nextStep.id})`);

     // For dock-type steps with a mission ID, accept the mission (handling accept-station mismatches)
     // Ensure docked first so accept can be attempted; never travel to the destination while undocked.
     if (!bot.docked) {
       ctx.log("mission", "Not docked — docking before accept attempt...");
       const d = await ensureDocked(ctx);
       if (!d) {
         ctx.log("error", "Could not dock — stopping routine");
         return;
       }
       await bot.refreshLocation();
     }
     if (autoAccept && (nextStep.type === "dock" || nextStep.type === "deliver" || nextStep.type === "goto") && nextStep.id) {
      const activeMissions = await getActiveMissions(ctx);
      const hasMission = activeMissions.some(m => missionMatchesStep(m, nextStep as any));

      if (nextStep.isMission !== false && !hasMission && bot.docked) {
        // Try accept at current location first
        let acceptResult = await acceptMission(ctx, nextStep.id);

        // If the mission is only available at a different station, travel there and accept
        if (!acceptResult.success && (acceptResult.error?.includes("only available at") || acceptResult.error?.includes("not available at this station"))) {
          const m = acceptResult.error?.match(/available at (.+?)(?:\.|$)/i);
          const stationName = m ? m[1].trim() : null;
          if (stationName) {
            ctx.log("mission", `Mission ${nextStep.id} only available at ${stationName}; traveling there to accept...`);
            // Resolve station id from display name (normalize spaces -> underscores)
            let ident = mapStore.resolveStationIdentity(stationName);
            if (!ident.matched) {
              ident = mapStore.resolveStationIdentity(stationName.toLowerCase().replace(/\s+/g, "_"));
            }
            let sysId = ident.systemId;
            let poiId = ident.poiId || ident.poiName || null;
            // Mobile capital (frontier station) handling
            if (!sysId && (stationName.toLowerCase().includes("frontier") || (poiId && poiId.toLowerCase().includes("frontier")))) {
              sysId = getMobileCapitolSystem();
              poiId = poiId || "frontier_station";
            }
            if (sysId && poiId) {
              const navigated = await navigateToSystem(ctx, sysId);
              if (navigated) {
                const { pois } = await getSystemInfo(ctx);
                const station = pois.find(p => isStationPoi(p) && (p.id === poiId || p.name?.toLowerCase() === stationName.toLowerCase()));
                if (station) {
                  if (bot.poi !== station.id) {
                    const tr = await bot.exec("travel", { target_poi: station.id });
                    if (tr.error && !tr.error.message.includes("already")) ctx.log("error", `Travel failed: ${tr.error.message}`);
                    bot.poi = station.id;
                    await bot.refreshLocation();
                  }
                  const dr = await bot.exec("dock");
                  if (!dr.error || dr.error.message.includes("already")) bot.docked = true;
                  await tryRefuel(ctx);
                }
                acceptResult = await acceptMission(ctx, nextStep.id);
              }
            }
          }
        }

        if (!acceptResult.success) {
          // Only mark as done if server explicitly says "already completed"
          if (acceptResult.error?.includes("already completed")) {
            ctx.log("mission", `Mission ${nextStep.id} already completed (server confirmed), marking step as done`);
            completedSteps.add(nextStep.id);
            saveProgress(bot.username, chainName, completedSteps, chain);
            recordStepResult(bot.username, chainName, nextStep, null, "completed", "Accept returned already completed");
            await ctx.sleep(2000);
            continue;
          }
          // Mission already active but not in our check? Re-check
          if (acceptResult.error?.includes("already have an active")) {
            const recheckMissions = await getActiveMissions(ctx);
            const recheckHasMission = recheckMissions.some(m => missionMatchesStep(m, nextStep as any));
            if (recheckHasMission) {
              ctx.log("mission", `Mission ${nextStep.id} already active (confirmed), proceeding`);
            } else {
              ctx.log("mission", `Mission ${nextStep.id} reported already active by server; proceeding`);
            }
          } else if (acceptResult.error?.includes("not found") || acceptResult.error?.includes("mission_not_found")) {
            // Sub-requirement step, not an accept-able mission; proceed to execute
            ctx.log("mission", `Step ${nextStep.id} is not an accept-able mission (sub-requirement), proceeding`);
          } else if (acceptResult.error?.includes("not_docked") || acceptResult.error?.includes("not docked")) {
            // Not docked; skip accept, proceed to execute (will dock)
            ctx.log("mission", `Not docked; skipping accept for ${nextStep.id}, proceeding to execute`);
          } else if (acceptResult.error?.includes("requires completing mission") || acceptResult.error?.includes("prerequisite")) {
            // A prerequisite mission isn't completed yet — go do it first instead of
            // trying to complete it in place.
            const m = acceptResult.error.match(/\[([^\]]+)\]/);
            const prereqId = m ? m[1] : null;
            ctx.log("mission", `Accept blocked by prerequisite ${prereqId}; switching to that mission first...`);
            const prereqStep = prereqId ? chain.steps.find(s => s.id === prereqId) : undefined;
            if (prereqStep) {
              // Clear completed entries from the prereq step onward so it actually runs
              const idx = chain.steps.indexOf(prereqStep);
              for (let j = idx; j < chain.steps.length; j++) {
                if (chain.steps[j].id) completedSteps.delete(chain.steps[j].id);
              }
              saveProgress(bot.username, chainName, completedSteps, chain);
              nextStep = prereqStep;
              ctx.log("mission", `Switching to prerequisite step ${prereqStep.id}`);
              continue;
            }
            // Fallback: try to complete it in place
            const activeMissions = await getActiveMissions(ctx);
            const prereqMission = prereqId ? activeMissions.find(m => (m.templateId || m.id) === prereqId || m.id === prereqId) : null;
            if (prereqMission) {
              const mid = (prereqMission as { uuid?: string; mission_id?: string; id?: string }).uuid || (prereqMission as { mission_id?: string }).mission_id || (prereqMission as { id?: string }).id;
              if (mid) {
                await completeMission(ctx, mid);
                await ctx.sleep(2000);
                acceptResult = await acceptMission(ctx, nextStep.id);
              }
            }
            if (!acceptResult.success && !(acceptResult.error?.includes("already completed") || acceptResult.error?.includes("already have an active"))) {
              ctx.log("error", `Mission ${nextStep.id} accept failed after prerequisite attempt: ${acceptResult.error} — stopping.`);
              return;
            }
            // Could not resolve accept station; stop for investigation
            ctx.log("error", `Mission ${nextStep.id} not available here (${acceptResult.error}) â€” stopping.`);
            return;
          } else {
            // Other errors - stop for investigation
            ctx.log("error", `Mission ${nextStep.id} accept failed: ${acceptResult.error} â€” stopping for investigation`);
            return;
          }
        } else {
          // Accept succeeded - VERIFY it's now in active missions
          await ctx.sleep(500);
          const verifyMissions = await getActiveMissions(ctx);
          const verifyHasMission = verifyMissions.some(m => missionMatchesStep(m, nextStep as any));
          if (!verifyHasMission) {
            ctx.log("error", `Mission ${nextStep.id} accept reported success but NOT in active missions â€” stopping for investigation`);
            return;
          }
          ctx.log("mission", `Mission ${nextStep.id} accepted and verified in active missions`);
        }
        await ctx.sleep(2000);
      } else if (nextStep.isMission === false) {
        ctx.log("mission", `Step ${nextStep.id} is a sub-requirement (not a mission), skipping accept`);
        recordStepResult(bot.username, chainName, nextStep, null, "skipped", "Sub-requirement (not an accept-able mission)");
      }
    }

    // Hard guard: never execute a mission step unless the mission is active (or was
    // just accepted). Sub-requirements (isMission === false) are exempt.
    if (nextStep.isMission !== false) {
      const nowMissions = await getActiveMissions(ctx);
      const isActive = nowMissions.some(m => missionMatchesStep(m, nextStep as any));
      if (!isActive) {
        ctx.log("error", `Mission ${nextStep.id} is not active and could not be accepted — stopping to avoid wasted travel.`);
        return;
      }
    }

    const success = await executeMissionStep(ctx, nextStep);
    if (!success) {
      ctx.log("error", `Step ${nextStep.id} failed â€” stopping routine for investigation. Fix the issue and restart to resume from this step.`);
      return; // Stop the routine instead of retrying
    }

    if (autoComplete && (nextStep.type === "dock" || nextStep.type === "deliver") && nextStep.id) {
      await ctx.sleep(2000);
      const activeMissions = await getActiveMissions(ctx);
      // Find the active mission: direct match, or parent mission for sub-requirements
      let mission = activeMissions.find(m => missionMatchesStep(m, nextStep as any));
      if (!mission && nextStep.completeAfter) {
        for (const parent of nextStep.completeAfter) {
          mission = activeMissions.find(m => missionMatchesStep(m, { id: parent, name: parent } as any));
          if (mission) break;
        }
      }
      if (!mission) {
        // Fallback: find an active mission whose objectives target this step's station/system
        const ts = String(nextStep.station || "").toLowerCase();
        const sy = String(nextStep.system || "").toLowerCase();
        mission = activeMissions.find(m => {
          const objs = (m.objectives as Array<Record<string, unknown>>) || [];
          return objs.some(o => {
            const tb = String(o.target_base || o.target_base_id || "").toLowerCase();
            const sid = String(o.system_id || "").toLowerCase();
            return (ts && (tb === ts || tb.includes(ts) || ts.includes(tb))) || (sy && sid === sy);
          });
        });
      }
      if (mission) {
        const objectives = (mission?.objectives as Array<Record<string, unknown>>) || [];
        const allComplete = objectives.length > 0 && objectives.every((obj) => obj.completed === true || (obj.current !== undefined && obj.current === obj.required) || (obj.progress !== undefined && obj.progress === obj.quantity));
         if (allComplete) {
           await completeMission(ctx, (mission as { uuid?: string })?.uuid || nextStep.id);
           await ctx.sleep(2000);
         }
      }
    }

    // Mark step completed if its objective is done, even if the mission has more objectives
    const postActiveMissions = await getActiveMissions(ctx);
    let mission = postActiveMissions.find(m => missionMatchesStep(m, nextStep as any));
    if (!mission && nextStep.completeAfter) {
      for (const parent of nextStep.completeAfter) {
        mission = postActiveMissions.find(m => missionMatchesStep(m, { id: parent, name: parent } as any));
        if (mission) break;
      }
    }
    let stepDone = true;
    if (mission) {
      const objs = (mission.objectives as Array<Record<string, unknown>>) || [];
      const allComplete = objs.length > 0 && objs.every((o) => o.completed === true || (o.current !== undefined && o.current === o.required) || (o.progress !== undefined && o.progress === o.quantity));
      if (objs.length > 0) {
        const targetStation = nextStep.isMobileStation ? nextStep.mobileStationId : nextStep.station;
        const matchingObj = objs.find(o => {
          const tb = ((o.target_base as string) || (o.target_base_id as string) || "").toLowerCase();
          const ts = (targetStation || "").toLowerCase();
          const ss = (nextStep.station || "").toLowerCase();
          return !!targetStation && (tb === ts || tb === ss || tb.includes(ts) || ts.includes(tb) || tb.includes(ss) || ss.includes(tb));
        });
        if (matchingObj) {
          // A dock step is done when its own matching objective is complete, even
          // if the mission has further objectives handled by later chain steps.
          const objDone = matchingObj.completed === true
            || (matchingObj.current !== undefined && matchingObj.current === matchingObj.required)
            || (matchingObj.progress !== undefined && matchingObj.progress === matchingObj.quantity);
          stepDone = objDone;
        } else if (!allComplete) {
          // If the step's objective is a visit_system (no dock required), consider
          // it done since navigation to the system succeeded.
          const visitObj = objs.find(o => o.type === "visit_system" && String(o.system_id || "").toLowerCase() === String(nextStep.system || "").toLowerCase());
          if (visitObj) {
            stepDone = true;
          } else {
            // Active mission not fully done and no matching objective for this step
            stepDone = false;
          }
        }
      }
    }
    // For non-dock steps or steps without a matching mission, consider done if executed successfully
    if (nextStep.type !== "dock") stepDone = true;

    if (stepDone) {
      completedSteps.add(nextStep.id);
      saveProgress(bot.username, chainName, completedSteps, chain);
      recordStepResult(bot.username, chainName, nextStep, mission as any, "completed");
      ctx.log("mission", `Step ${nextStep.id} completed (${completedSteps.size}/${chain.steps.length})`);
    } else {
      recordStepResult(bot.username, chainName, nextStep, mission as any, "failed", "Objective not confirmed complete after docking");
      ctx.log("error", `Step ${nextStep.id} objective not confirmed complete after docking â€” stopping for investigation`);
      return;
    }
    
    await ctx.sleep(5000);
  }
};

export { MISSION_CHAINS, type MissionChain, type MissionStep };