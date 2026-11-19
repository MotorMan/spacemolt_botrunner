import type { Routine, RoutineContext } from "../bot.js";
import { mapStore } from "../mapstore.js";
import {
  navigateToSystem,
  readSettings,
  writeSettings,
  getSystemInfo,
  getFuelCellFuelValue,
  estimateRouteFuel,
  ensureDocked,
  tryRefuel,
  ensureFueled,
  repairShip,
  PIRATE_SYSTEMS,
  isPirateSystem,
} from "./common.js";
import { formatBearing, PATHFINDER_SPEED, generateScanPattern } from "../pathfinder.js";
import { getMainNetworkSystems } from "./explorer.js";
import { getEffectiveSystemBlacklist } from "../web/server.js";

const PATHFINDER_SETTINGS_KEY = "pathfinder";

interface PathfinderSettings {
  originSystem?: string;
  scanStartDegree?: number;
  scanStepDegrees?: number;
  scanWaitMinutes?: number;
  scanDelayTicks?: number;
  refuelThreshold?: number;
  scanPattern?: "circle" | "star" | "spiral" | "figure8" | "zigzag" | "petal" | "square" | "cross" | "wedge" | "random" | "p2p";
  p2pStartSystem?: string;
  p2pDestinationSystem?: string;
}

interface GalacticPos {
  x: number;
  y: number;
}

interface JumpResult {
  success: boolean;
  landedSystem: string;
  arrivalPos: GalacticPos | null;
  ticksTraveled: number;
}

function asString(v: unknown, fallback: string): string {
  return typeof v === "string" && v ? v : fallback;
}
function asNumber(v: unknown, fallback: number): number {
  return typeof v === "number" && !isNaN(v) ? v : fallback;
}

export function getPathfinderSettings(username?: string): PathfinderSettings {
  const all = readSettings();
  const botOverrides = (username ? (all[username] || {}) : {}) as Record<string, unknown>;
  const global = (all[PATHFINDER_SETTINGS_KEY] || {}) as Record<string, unknown>;
  return {
    originSystem: asString(botOverrides.originSystem, asString(global.originSystem, "sol")),
    scanStartDegree: asNumber(botOverrides.scanStartDegree, asNumber(global.scanStartDegree, 0)),
    scanStepDegrees: asNumber(botOverrides.scanStepDegrees, asNumber(global.scanStepDegrees, 12)),
    scanWaitMinutes: asNumber(botOverrides.scanWaitMinutes, asNumber(global.scanWaitMinutes, 5)),
    scanDelayTicks: asNumber(botOverrides.scanDelayTicks, asNumber(global.scanDelayTicks, 0)),
    refuelThreshold: asNumber(botOverrides.refuelThreshold, asNumber(global.refuelThreshold, 50)),
    scanPattern: (asString(botOverrides.scanPattern, asString(global.scanPattern, "circle")) as PathfinderSettings["scanPattern"]),
    p2pStartSystem: asString(botOverrides.p2pStartSystem, asString(global.p2pStartSystem, "")),
    p2pDestinationSystem: asString(botOverrides.p2pDestinationSystem, asString(global.p2pDestinationSystem, "")),
  };
}

export function setPathfinderOrigin(username: string, system: string): void {
  writeSettings({ [username]: { originSystem: system } });
}

export function setPathfinderScanStartDegree(username: string, degree: number): void {
  writeSettings({ [username]: { scanStartDegree: degree } });
}

export function setPathfinderScanStepDegrees(username: string, step: number): void {
  writeSettings({ [username]: { scanStepDegrees: step } });
}

export function setPathfinderScanWaitMinutes(username: string, minutes: number): void {
  writeSettings({ [username]: { scanWaitMinutes: minutes } });
}

export function setPathfinderRefuelThreshold(username: string, threshold: number): void {
  writeSettings({ [username]: { refuelThreshold: threshold } });
}

export function setPathfinderScanDelayTicks(username: string, ticks: number): void {
  writeSettings({ [username]: { scanDelayTicks: ticks } });
}

export function setPathfinderScanPattern(username: string, pattern: PathfinderSettings["scanPattern"]): void {
  writeSettings({ [username]: { scanPattern: pattern } });
}

/** Generate a sequence of scan angles for a given sweep pattern.
 *  All patterns except "circle" return to origin after each angle (out + back),
 *  keeping outward distance low. "circle" chains jumps mid-drift. */
export { generateScanPattern } from "../pathfinder.js";

/** Calculate the bearing from origin to target using galactic coordinates. */
export function calculateBearingToTarget(
  originX: number,
  originY: number,
  targetX: number,
  targetY: number
): number {
  const dx = targetX - originX;
  const dy = targetY - originY;
  const rad = Math.atan2(dy, dx);
  return ((rad * 180 / Math.PI) + 360) % 360;
}

/** Find the nearest main network system (original ~506 systems) from a given position.
 *  Returns the system ID and its distance. */
export function findNearestMainNetworkSystem(
  currentX: number,
  currentY: number
): { systemId: string; systemName: string; distance: number; position: { x: number; y: number } } | null {
  const mainNetwork = new Set<string>();
  
  // Build main network using same logic as getMainNetworkSystems in explorer.ts
  const graph = new Map<string, Set<string>>();
  const addNode = (id: string): void => {
    const key = id.toLowerCase();
    if (!graph.has(key)) graph.set(key, new Set());
  };
  const addEdge = (a: string, b: string): void => {
    addNode(a);
    addNode(b);
    graph.get(a.toLowerCase())!.add(b.toLowerCase());
    graph.get(b.toLowerCase())!.add(a.toLowerCase());
  };

  const STATIC_WORMHOLES: Array<[string, string]> = [
    ["alzirr", "praecipua"],
    ["hadar", "gsc_0036"],
  ];

  for (const sys of mapStore.getSystems()) {
    addNode(sys.id);
    for (const conn of sys.connections || []) {
      if (!conn.system_id) continue;
      addEdge(sys.id, conn.system_id);
    }
  }
  for (const [a, b] of STATIC_WORMHOLES) {
    addEdge(a, b);
  }

  // Find connected component from home system
  const homeSystem = "sol";
  const mainComponent = new Set<string>();
  const queue = [homeSystem.toLowerCase()];
  mainComponent.add(homeSystem.toLowerCase());
  
  while (queue.length > 0) {
    const current = queue.shift()!;
    const neighbors = graph.get(current);
    if (!neighbors) continue;
    for (const nb of neighbors) {
      if (!mainComponent.has(nb)) {
        mainComponent.add(nb);
        queue.push(nb);
      }
    }
  }

  // If home system not in graph, use largest component
  if (mainComponent.size <= 1) {
    const visited = new Set<string>();
    let largestComponent = new Set<string>();
    
    for (const node of graph.keys()) {
      if (visited.has(node)) continue;
      const component = new Set<string>();
      const compQueue = [node];
      component.add(node);
      visited.add(node);
      
      while (compQueue.length > 0) {
        const current = compQueue.shift()!;
        const neighbors = graph.get(current);
        if (!neighbors) continue;
        for (const nb of neighbors) {
          if (!visited.has(nb)) {
            visited.add(nb);
            component.add(nb);
            compQueue.push(nb);
          }
        }
      }
      
      if (component.size > largestComponent.size) {
        largestComponent = component;
      }
    }
    
    for (const node of largestComponent) {
      mainNetwork.add(node);
    }
  } else {
    for (const node of mainComponent) {
      mainNetwork.add(node);
    }
  }

  // Now find the nearest main network system with position data
  let nearest: { systemId: string; systemName: string; distance: number; position: { x: number; y: number } } | null = null;
  let minDist = Infinity;

  for (const sys of mapStore.getSystems()) {
    const sysIdLower = sys.id.toLowerCase();
    if (!mainNetwork.has(sysIdLower)) continue;
    if (!sys.position || typeof sys.position.x !== "number" || typeof sys.position.y !== "number") continue;
    
    const dx = sys.position.x - currentX;
    const dy = sys.position.y - currentY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    
    if (dist < minDist) {
      minDist = dist;
      nearest = {
        systemId: sys.id,
        systemName: sys.name || sys.id,
        distance: dist,
        position: sys.position
      };
    }
  }

  return nearest;
}

/** Execute a pathfinder jump at a specific bearing and wait for completion.
 *  Returns the landing system and position. */
export async function executePathfinderJumpToBearing(
  ctx: RoutineContext,
  bearingDegrees: number,
  originPos: { x: number; y: number } | null,
  options: { waitForCompletion?: boolean; midTransitWaitMs?: number } = {}
): Promise<{ success: boolean; landedSystem: string; arrivalPos: { x: number; y: number } | null; ticksTraveled: number }> {
  const { bot } = ctx;
  if (bot.state !== "running") {
    return { success: false, landedSystem: bot.system, arrivalPos: null, ticksTraveled: 0 };
  }
  const { waitForCompletion = true, midTransitWaitMs = 0 } = options;

  if (!bot.hasPathfinderDrive) {
    await bot.refreshShipMods();
  }
  if (!bot.hasPathfinderDrive) {
    ctx.log("error", "Pathfinder jump attempted without Pathfinder Drive module.");
    return { success: false, landedSystem: bot.system, arrivalPos: null, ticksTraveled: 0 };
  }

  await bot.refreshStatus();
  const originSystem = bot.system;
  const bearing = ((bearingDegrees % 360) + 360) % 360;

  // Track cloak state - disable for pathfinder jump (saves fuel, can't be attacked in transit)
  const wasCloaked = bot.isCloaked || false;
  if (wasCloaked) {
    ctx.log("travel", "Disabling cloak for pathfinder jump (fuel conservation)...");
    const decloakResp = await bot.exec("cloak", { enable: false });
    if (decloakResp.error) {
      ctx.log("warn", `Failed to disable cloak: ${decloakResp.error.message}`);
    } else {
      ctx.log("travel", "Cloak disabled for pathfinder jump");
    }
  }

  const startTick = await bot.pollCurrentTick();

  ctx.log("travel", `Pathfinder jump at bearing ${formatBearing(bearing, 2)}° from ${originSystem} (returning to main network)`);

  if (bot.state !== "running") {
    if (wasCloaked) await bot.exec("cloak", { enable: true });
    return { success: false, landedSystem: bot.system, arrivalPos: null, ticksTraveled: 0 };
  }

  const jumpResp = await bot.exec("jump", { target_system: bearing });
  if (jumpResp.error) {
    ctx.log("error", `Pathfinder jump at bearing ${formatBearing(bearing, 2)}° failed: ${jumpResp.error.message}`);
    // Re-enable cloak if we disabled it
    if (wasCloaked) {
      await bot.exec("cloak", { enable: true });
    }
    return { success: false, landedSystem: bot.system, arrivalPos: null, ticksTraveled: 0 };
  }

  const jr = jumpResp.result as Record<string, unknown> | undefined;
  const arrivalSystemId = (jr?.arrival_system_id as string) || "";
  const arrivalSystemName = (jr?.arrival_system as string) || "";
  if (arrivalSystemId) {
    ctx.log("travel", `Jump result: arrived at ${arrivalSystemName || '?'} (${arrivalSystemId})`);
  }

  let inTransit = false;
  let ticksRemaining: number | null = null;
  let endTick: number | null = null;
  let poll = 0;
  const maxPolls = 720;

  let startPolls = 0;
  const maxStartPolls = 60;
  while (bot.state === "running" && startPolls < maxStartPolls && !inTransit) {
    await ctx.sleep(1000);
    if (bot.state !== "running") break;
    startPolls++;
    const startPoi = await bot.exec("get_poi");
    if (startPoi.result && typeof startPoi.result === "object") {
      const p = startPoi.result as Record<string, unknown>;
      inTransit = (p.in_transit as boolean) ?? false;
      ticksRemaining = (p.ticks_remaining as number) ?? ticksRemaining;
    }
  }

  if (!inTransit && bot.state === "running") {
    ctx.log("error", `Pathfinder jump at bearing ${formatBearing(bearing, 2)}° — transit never started`);
    // Re-enable cloak if we disabled it
    if (wasCloaked) {
      await bot.exec("cloak", { state: "on" });
    }
    return { success: false, landedSystem: bot.system, arrivalPos: null, ticksTraveled: 0 };
  }

  if (midTransitWaitMs > 0 && bot.state === "running") {
    ctx.log("system", `Waiting ${Math.round(midTransitWaitMs / 60000)} minute(s) into jump at ${formatBearing(bearing, 2)}° to get away from origin...`);
    await ctx.sleep(midTransitWaitMs);
  }

  if (!waitForCompletion) {
    return { success: true, landedSystem: bot.system, arrivalPos: null, ticksTraveled: 0 };
  }

  while (bot.state === "running" && poll < maxPolls && inTransit) {
    await ctx.sleep(2000);
    if (bot.state !== "running") break;
    poll++;

    const poiResp = await bot.exec("get_poi");
    if (poiResp.result && typeof poiResp.result === "object") {
      const p = poiResp.result as Record<string, unknown>;
      inTransit = (p.in_transit as boolean) ?? false;
      ticksRemaining = (p.ticks_remaining as number) ?? ticksRemaining;
    }

    if (poll % 6 === 0) {
      endTick = await bot.pollCurrentTick();
      ctx.log("travel", `Pathfinder in transit — ticks_remaining=${ticksRemaining ?? "?"}${endTick !== null ? `, tick=${endTick}` : ""}`);
    }
  }

  if (poll >= maxPolls && inTransit && bot.state === "running") {
    ctx.log("error", `Pathfinder jump at bearing ${formatBearing(bearing, 2)}° — transit did not complete after ${Math.round(maxPolls * 5 / 1000)}s, aborting`);
    // Re-enable cloak if we disabled it
    if (wasCloaked) {
      await bot.exec("cloak", { enable: true });
    }
    return { success: false, landedSystem: bot.system, arrivalPos: null, ticksTraveled: 0 };
  }

  if (bot.state !== "running") {
    ctx.log("system", "Pathfinder jump aborted — bot stopped");
    // Re-enable cloak if we disabled it
    if (wasCloaked) {
      await bot.exec("cloak", { enable: true });
    }
    return { success: false, landedSystem: bot.system, arrivalPos: null, ticksTraveled: 0 };
  }

  endTick = await bot.pollCurrentTick();

  if (bot.state !== "running") {
    ctx.log("system", "Pathfinder jump aborted — bot stopped");
    // Re-enable cloak if we disabled it
    if (wasCloaked) {
      await bot.exec("cloak", { enable: true });
    }
    return { success: false, landedSystem: bot.system, arrivalPos: null, ticksTraveled: 0 };
  }

  let arrivalPos: { x: number; y: number } | null = null;
  if (originPos && startTick !== null && endTick !== null) {
    const ticksTraveled = Math.max(0, endTick - startTick);
    const distance = ticksTraveled * PATHFINDER_SPEED;
    const rad = (bearing * Math.PI) / 180;
    arrivalPos = {
      x: originPos.x + distance * Math.cos(rad),
      y: originPos.y + distance * Math.sin(rad),
    };
    ctx.log("travel", `Tracked position: elapsed ${ticksTraveled} ticks, ${distance.toFixed(1)} GU, arrival galactic (${arrivalPos.x.toFixed(1)}, ${arrivalPos.y.toFixed(1)})`);
  }

  await bot.refreshLocation();
  await bot.refreshStatus();

  const landed = bot.system;
  ctx.log("travel", `Pathfinder jump at bearing ${formatBearing(bearing, 2)}° complete: arrived at ${landed}`);

  // Re-enable cloak if we disabled it for the jump
  if (wasCloaked) {
    ctx.log("travel", "Re-enabling cloak after pathfinder jump...");
    const recloakResp = await bot.exec("cloak", { state: "on" });
    if (recloakResp.error) {
      ctx.log("warn", `Failed to re-enable cloak: ${recloakResp.error.message}`);
    } else {
      ctx.log("travel", "Cloak re-enabled");
    }
  }

  if (arrivalPos === null) {
    const landedSys = mapStore.getSystem(landed);
    if (landedSys?.position) {
      arrivalPos = landedSys.position;
    }
  }

  return { success: true, landedSystem: landed, arrivalPos, ticksTraveled: endTick !== null && startTick !== null ? Math.max(0, endTick - startTick) : 0 };
}

/** Calculate total available fuel (tank + military fuel cells in cargo) and fuel per pathfinder jump. */
async function calculateAvailableFuel(ctx: RoutineContext): Promise<{ tankFuel: number; mfcFuel: number; totalFuel: number; fuelPerJump: number }> {
  const { bot } = ctx;
  await bot.refreshShip();
  await bot.refreshCargo();

  const tankFuel = bot.fuel;
  
  // Calculate MFC fuel in cargo
  let mfcFuel = 0;
  for (const item of bot.inventory) {
    if (item.itemId === "military_fuel_cell" && item.quantity > 0) {
      mfcFuel += item.quantity * 100; // Military fuel cell = 100 fuel each
    }
  }

  // Estimate pathfinder fuel per jump (5x normal jump cost)
  let pathfinderFuelPerJump = 25; // fallback
  const currentSystem = bot.system;
  if (currentSystem) {
    const route = await estimateRouteFuel(ctx, currentSystem);
    if (route && route.fuelPerJump > 0) {
      pathfinderFuelPerJump = route.fuelPerJump * 5;
    }
  }

  return {
    tankFuel,
    mfcFuel,
    totalFuel: tankFuel + mfcFuel,
    fuelPerJump: pathfinderFuelPerJump
  };
}

/** Safety check: verify we have enough fuel for pathfinder return journey.
 *  Returns true if safe to proceed, false if lockout should engage. */
async function checkPathfinderFuelSafety(ctx: RoutineContext, estimatedJumps: number, minReserveJumps: number = 3): Promise<{ safe: boolean; reason?: string }> {
  const { bot } = ctx;
  const fuelInfo = await calculateAvailableFuel(ctx);
  
  const neededFuel = estimatedJumps * fuelInfo.fuelPerJump;
  const reserveFuel = minReserveJumps * fuelInfo.fuelPerJump;
  const totalRequired = neededFuel + reserveFuel;
  
  ctx.log("system", `[Pathfinder Fuel Safety] Tank: ${fuelInfo.tankFuel} | MFCs: ${fuelInfo.mfcFuel} | Total: ${fuelInfo.totalFuel} | Per jump: ${fuelInfo.fuelPerJump} | Need: ${totalRequired} (${estimatedJumps} jumps + ${minReserveJumps} reserve)`);
  
  if (fuelInfo.totalFuel < totalRequired) {
    const deficit = totalRequired - fuelInfo.totalFuel;
    return { 
      safe: false, 
      reason: `INSUFFICIENT FUEL: need ${totalRequired} (${estimatedJumps} jumps + ${minReserveJumps} reserve) but only have ${fuelInfo.totalFuel} (tank: ${fuelInfo.tankFuel}, MFCs: ${fuelInfo.mfcFuel}). Deficit: ${deficit}. LOCKOUT ENGAGED.`
    };
  }
  
  // Also check if tank alone is critically low without MFCs
  if (fuelInfo.tankFuel < fuelInfo.fuelPerJump * 2 && fuelInfo.mfcFuel === 0) {
    return { 
      safe: false, 
      reason: `CRITICAL: Tank fuel (${fuelInfo.tankFuel}) below 2 jumps (${fuelInfo.fuelPerJump * 2}) and NO MFCs in cargo. LOCKOUT ENGAGED.`
    };
  }
  
  return { safe: true };
}

/** Check if a system is a pirate stronghold. */
function isPirateStronghold(systemId: string): boolean {
  return PIRATE_SYSTEMS.some(ps => systemId.toLowerCase() === ps || systemId.toLowerCase().includes(ps));
}

/** Check if the path from origin to target passes within captureRadius of any pirate stronghold.
 *  Returns the pirate stronghold if one is in the path, null otherwise. */
function checkPirateStrongholdInPath(
  ctx: RoutineContext,
  originX: number,
  originY: number,
  targetX: number,
  targetY: number,
  captureRadius: number = 100
): { systemId: string; distance: number } | null {
  const dx = targetX - originX;
  const dy = targetY - originY;
  const pathLength = Math.sqrt(dx * dx + dy * dy);
  
  if (pathLength === 0) return null;
  
  // Unit vector along the path
  const ux = dx / pathLength;
  const uy = dy / pathLength;
  
  for (const pirateSystem of PIRATE_SYSTEMS) {
    const sys = mapStore.getSystem(pirateSystem);
    if (!sys?.position) continue;
    
    // Vector from origin to pirate system
    const px = sys.position.x - originX;
    const py = sys.position.y - originY;
    
    // Project onto path line to find closest point on path
    const proj = px * ux + py * uy;
    
    // If projection is outside the segment, check endpoints
    let closestX: number, closestY: number;
    if (proj <= 0) {
      closestX = originX;
      closestY = originY;
    } else if (proj >= pathLength) {
      closestX = targetX;
      closestY = targetY;
    } else {
      closestX = originX + proj * ux;
      closestY = originY + proj * uy;
    }
    
    // Distance from pirate system to closest point on path
    const distToPath = Math.sqrt(
      Math.pow(sys.position.x - closestX, 2) + 
      Math.pow(sys.position.y - closestY, 2)
    );
    
    if (distToPath < captureRadius) {
      ctx.log("warn", `🏴‍☠️ PIRATE STRONGHOLD IN PATH: ${pirateSystem} is ${distToPath.toFixed(1)} GU from jump path (capture radius: ${captureRadius} GU)`);
      return { systemId: pirateSystem, distance: distToPath };
    }
  }
  
  return null;
}

/** Find the nearest main network system that is NOT a pirate stronghold. */
function findNearestMainNetworkSystemSafe(
  ctx: RoutineContext,
  currentX: number,
  currentY: number
): { systemId: string; systemName: string; distance: number; position: { x: number; y: number } } | null {
  const mainNetwork = new Set<string>();
  
  // Build main network using same logic as getMainNetworkSystems in explorer.ts
  const graph = new Map<string, Set<string>>();
  const addNode = (id: string): void => {
    const key = id.toLowerCase();
    if (!graph.has(key)) graph.set(key, new Set());
  };
  const addEdge = (a: string, b: string): void => {
    addNode(a);
    addNode(b);
    graph.get(a.toLowerCase())!.add(b.toLowerCase());
    graph.get(b.toLowerCase())!.add(a.toLowerCase());
  };

  const STATIC_WORMHOLES: Array<[string, string]> = [
    ["alzirr", "praecipua"],
    ["hadar", "gsc_0036"],
  ];

  for (const sys of mapStore.getSystems()) {
    addNode(sys.id);
    for (const conn of sys.connections || []) {
      if (!conn.system_id) continue;
      addEdge(sys.id, conn.system_id);
    }
  }
  for (const [a, b] of STATIC_WORMHOLES) {
    addEdge(a, b);
  }

  // Find connected component from home system
  const homeSystem = "sol";
  const mainComponent = new Set<string>();
  const queue = [homeSystem.toLowerCase()];
  mainComponent.add(homeSystem.toLowerCase());
  
  while (queue.length > 0) {
    const current = queue.shift()!;
    const neighbors = graph.get(current);
    if (!neighbors) continue;
    for (const nb of neighbors) {
      if (!mainComponent.has(nb)) {
        mainComponent.add(nb);
        queue.push(nb);
      }
    }
  }

  // If home system not in graph, use largest component
  if (mainComponent.size <= 1) {
    const visited = new Set<string>();
    let largestComponent = new Set<string>();
    
    for (const node of graph.keys()) {
      if (visited.has(node)) continue;
      const component = new Set<string>();
      const compQueue = [node];
      component.add(node);
      visited.add(node);
      
      while (compQueue.length > 0) {
        const current = compQueue.shift()!;
        const neighbors = graph.get(current);
        if (!neighbors) continue;
        for (const nb of neighbors) {
          if (!visited.has(nb)) {
            visited.add(nb);
            component.add(nb);
            compQueue.push(nb);
          }
        }
      }
      
      if (component.size > largestComponent.size) {
        largestComponent = component;
      }
    }
    
    for (const node of largestComponent) {
      mainNetwork.add(node);
    }
  } else {
    for (const node of mainComponent) {
      mainNetwork.add(node);
    }
  }

  // Now find the nearest main network system with position data (EXCLUDING PIRATE STRONGHOLDS)
  let nearest: { systemId: string; systemName: string; distance: number; position: { x: number; y: number } } | null = null;
  let minDist = Infinity;

  for (const sys of mapStore.getSystems()) {
    const sysIdLower = sys.id.toLowerCase();
    if (!mainNetwork.has(sysIdLower)) continue;
    if (!sys.position || typeof sys.position.x !== "number" || typeof sys.position.y !== "number") continue;
    if (isPirateStronghold(sys.id)) {
      ctx.log("debug", `Skipping pirate stronghold ${sys.id} as pathfinder target`);
      continue;
    }
    
    const dx = sys.position.x - currentX;
    const dy = sys.position.y - currentY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    
    if (dist < minDist) {
      minDist = dist;
      nearest = {
        systemId: sys.id,
        systemName: sys.name || sys.id,
        distance: dist,
        position: sys.position
      };
    }
  }

  return nearest;
}

/** Options for navigateFrontierToMainNetwork */
export interface NavigateFrontierOptions {
  maxJumps?: number;
  fuelThresholdPct?: number;
  hullThresholdPct?: number;
  scanWaitMinutes?: number;
  scanDelayTicks?: number;
  /** Known frontier systems from explorer memory with their wormhole connections */
  frontierMemory?: Map<string, { 
    id: string; 
    name: string; 
    position?: { x: number; y: number }; 
    distanceFromEntry?: number;
    connections: Set<string>; // Connected frontier system IDs via wormholes
  }>;
}

/** Navigate from a frontier dead-end back to the main network using pathfinder jumps.
 *  Uses galactic coordinates to find the nearest main network system and jumps toward it.
 *  Avoids repeat jumps in the same direction to save fuel.
 *  Checks known frontier systems first for better intermediate targets.
 *  Bans pirate strongholds as targets and checks path for pirate capture radius.
 *  Returns true if successfully reached main network, false otherwise. */
export async function navigateFrontierToMainNetwork(
  ctx: RoutineContext,
  options: NavigateFrontierOptions
): Promise<boolean> {
  const { bot } = ctx;
  const { 
    maxJumps = 15, 
    fuelThresholdPct = 30,
    hullThresholdPct = 30,
    scanWaitMinutes = 5,
    scanDelayTicks = 0,
    frontierMemory = new Map(),
  } = options || {} as NavigateFrontierOptions;

  // Get current position
  await bot.refreshLocation();
  await bot.refreshStatus();
  const currentSystem = bot.system;
  if (!currentSystem) {
    ctx.log("error", "Cannot determine current system for frontier return");
    return false;
  }

  const currentSys = mapStore.getSystem(currentSystem);
  if (!currentSys?.position) {
    ctx.log("error", `Current system ${currentSystem} has no position data — cannot calculate return bearing`);
    return false;
  }

  const originPos = { x: currentSys.position.x, y: currentSys.position.y };

  // ── CHECK IF ALREADY IN MAIN NETWORK OR HAS REGULAR ROUTE ──────────────────
  // If we're already in the main network, or have a regular route to it,
  // use normal navigation instead of pathfinder jumps
  const mainNetworkSystems = getMainNetworkSystems();
  if (mainNetworkSystems.has(currentSystem.toLowerCase())) {
    ctx.log("system", `Already in main network at ${currentSystem} — no pathfinder jumps needed`);
    return true;
  }

  // Check if there's a regular route to any main network system
  const blacklist = getEffectiveSystemBlacklist(bot);
  for (const mainSys of mainNetworkSystems) {
    const route = mapStore.findRoute(currentSystem, mainSys, blacklist);
    if (route && route.length > 1) {
      ctx.log("system", `Regular route to main network found via ${mainSys} (${route.length - 1} jumps) — using normal navigation instead of pathfinder`);
      // Navigate to the main network system using normal navigation
      const arrived = await navigateToSystem(ctx, mainSys, {
        fuelThresholdPct: fuelThresholdPct,
        hullThresholdPct: hullThresholdPct,
        skipBlacklist: false,
      });
      if (arrived) {
        ctx.log("system", `Successfully reached main network at ${mainSys} via regular route`);
        return true;
      }
      ctx.log("warn", `Normal navigation to ${mainSys} failed — will try pathfinder as fallback`);
      break; // Try pathfinder as fallback
    }
  }

  // ── FIND NEAREST SAFE MAIN NETWORK SYSTEM ────────────────────────────────
  const mainNetworkTarget = findNearestMainNetworkSystemSafe(ctx, originPos.x, originPos.y);
  if (!mainNetworkTarget) {
    ctx.log("error", "No safe main network system found");
    return false;
  }

  // Calculate current distance to main network
  const currentMainDist = Math.sqrt(
    Math.pow(mainNetworkTarget.position.x - originPos.x, 2) + 
    Math.pow(mainNetworkTarget.position.y - originPos.y, 2)
  );

  // ── TRAVERSE FRONTIER GRAPH TO FIND BEST INTERMEDIATE TARGET ─────────────
  // Use BFS through wormhole connections to find ALL reachable frontier systems
  // that have positions, then pick the one closest to main network
  let bestIntermediate: { 
    systemId: string; 
    systemName: string; 
    position: { x: number; y: number }; 
    distanceToMain: number;
    distanceFromCurrent: number;
    path: string[];
  } | null = null;

  if (frontierMemory && frontierMemory.size > 0) {
    ctx.log("system", `Traversing frontier graph (${frontierMemory.size} systems) to find best return path...`);
    
    // BFS from current system through wormhole connections
    const visited = new Set<string>();
    const queue: Array<{ systemId: string; path: string[] }> = [
      { systemId: currentSystem, path: [currentSystem] }
    ];
    visited.add(currentSystem);
    
    while (queue.length > 0) {
      const { systemId, path } = queue.shift()!;
      const fs = frontierMemory.get(systemId);
      if (!fs) continue;
      
      // Check if this system has a position and is closer to main network
      if (fs.position && systemId !== currentSystem) {
        const distToMain = Math.sqrt(
          Math.pow(mainNetworkTarget.position.x - fs.position.x, 2) + 
          Math.pow(mainNetworkTarget.position.y - fs.position.y, 2)
        );
        
        if (distToMain < currentMainDist) {
          // Calculate distance from current position
          const distFromCurrent = Math.sqrt(
            Math.pow(fs.position.x - originPos.x, 2) + 
            Math.pow(fs.position.y - originPos.y, 2)
          );
          
          // Check if this is the best so far (closest to main network)
          if (!bestIntermediate || distToMain < bestIntermediate.distanceToMain) {
            bestIntermediate = {
              systemId: fs.id,
              systemName: fs.name,
              position: fs.position,
              distanceToMain: distToMain,
              distanceFromCurrent: distFromCurrent,
              path: [...path]
            };
            ctx.log("travel", `Found better intermediate: ${fs.name} (${fs.id}) - ${distToMain.toFixed(1)} GU to main (vs current ${currentMainDist.toFixed(1)} GU), ${path.length - 1} wormhole hop(s)`);
          }
        }
      }
      
      // Traverse wormhole connections
      for (const connId of fs.connections) {
        if (visited.has(connId)) continue;
        visited.add(connId);
        queue.push({ systemId: connId, path: [...path, connId] });
      }
    }
    
    if (bestIntermediate) {
      ctx.log("travel", `Best intermediate target: ${bestIntermediate.systemName} (${bestIntermediate.systemId}) - ${bestIntermediate.distanceToMain.toFixed(1)} GU to main, ${bestIntermediate.path.length - 1} hop(s) via wormholes`);
    } else {
      ctx.log("system", `No frontier system closer to main network than current position (${currentMainDist.toFixed(1)} GU)`);
    }
  } else {
    ctx.log("warn", "No frontier memory available - cannot check for better intermediate targets");
  }

  // ── DECIDE TARGET AND NAVIGATION METHOD ──────────────────────────────────
  let target: { systemId: string; systemName: string; distance: number; position: { x: number; y: number } } | null = null;
  let usePathfinder = true;
  let intermediateTarget: { systemId: string; systemName: string; distance: number; position: { x: number; y: number } } | null = null;

  if (bestIntermediate) {
    // Use wormhole navigation to reach the intermediate target
    target = {
      systemId: bestIntermediate.systemId,
      systemName: bestIntermediate.systemName,
      distance: bestIntermediate.distanceFromCurrent,
      position: bestIntermediate.position
    };
    usePathfinder = false;
    intermediateTarget = {
      systemId: bestIntermediate.systemId,
      systemName: bestIntermediate.systemName,
      distance: bestIntermediate.distanceFromCurrent,
      position: bestIntermediate.position
    };
  } else {
    // No better intermediate - use pathfinder directly to main network
    target = mainNetworkTarget;
    usePathfinder = true;
  }

  if (!target) {
    ctx.log("error", "No valid target found for frontier return (all main network systems may be pirate strongholds)");
    return false;
  }

  ctx.log("travel", `Frontier return: targeting ${usePathfinder ? 'main network' : 'intermediate frontier'} system ${target.systemName} (${target.systemId}) at distance ${Math.sqrt(Math.pow(target.position.x - originPos.x, 2) + Math.pow(target.position.y - originPos.y, 2)).toFixed(1)} GU`);

  // Calculate initial bearing
  let bearing = calculateBearingToTarget(originPos.x, originPos.y, target.position.x, target.position.y);
  ctx.log("travel", `Initial bearing to ${target.systemName}: ${formatBearing(bearing, 2)}°`);

  // ── PRE-FLIGHT FUEL SAFETY LOCKOUT ─────────────────────────────────────
  const estimatedJumps = usePathfinder ? Math.max(1, Math.ceil(Math.sqrt(Math.pow(target.position.x - originPos.x, 2) + Math.pow(target.position.y - originPos.y, 2)) / 1000)) : 1;
  const safetyCheck = await checkPathfinderFuelSafety(ctx, estimatedJumps, 3);
  if (!safetyCheck.safe) {
    ctx.log("error", `🚫 PATHFINDER LOCKOUT: ${safetyCheck.reason}`);
    ctx.log("error", `🚫 Falling back to normal navigation — pathfinder jumps DISABLED.`);
    return false;
  }
  ctx.log("system", `[Pathfinder Fuel Safety] ✅ Pre-flight check PASSED — ${estimatedJumps} estimated jumps, sufficient fuel confirmed.`);

  // ── PRE-FLIGHT PIRATE PATH CHECK ───────────────────────────────────────
  if (usePathfinder) {
    const pirateInPath = checkPirateStrongholdInPath(ctx, originPos.x, originPos.y, target.position.x, target.position.y, 100);
    if (pirateInPath) {
      ctx.log("error", `🚫 PATHFINDER LOCKOUT: Pirate stronghold ${pirateInPath.systemId} is ${pirateInPath.distance.toFixed(1)} GU from jump path (capture radius: 100 GU)`);
      ctx.log("error", `🚫 Cannot safely jump to ${target.systemName} — path blocked by pirate stronghold.`);
      return false;
    }
    ctx.log("system", `[Pirate Path Safety] ✅ Path to ${target.systemName} clear of pirate strongholds (100 GU radius).`);
  }

  let jumpsPerformed = 0;
  let lastBearing: number | null = null;
  let consecutiveSameDirection = 0;
  let currentPos = originPos;
  let mainNetwork = new Set<string>();

  while (jumpsPerformed < maxJumps && bot.state === "running") {
    // ── PER-JUMP FUEL SAFETY LOCKOUT ─────────────────────────────────────
    const perJumpSafety = await checkPathfinderFuelSafety(ctx, maxJumps - jumpsPerformed, 2);
    if (!perJumpSafety.safe) {
      ctx.log("error", `🚫 PATHFINDER LOCKOUT (mid-journey): ${perJumpSafety.reason}`);
      ctx.log("error", `🚫 Aborting pathfinder return at jump ${jumpsPerformed}/${maxJumps} — falling back to normal nav.`);
      return false;
    }

    // ── PER-JUMP PIRATE PATH CHECK ───────────────────────────────────────
    // Before each jump, verify the path from current position to target is still clear
    if (usePathfinder) {
      const pirateInPath = checkPirateStrongholdInPath(ctx, currentPos.x, currentPos.y, target.position.x, target.position.y, 100);
      if (pirateInPath) {
        ctx.log("error", `🚫 PATHFINDER LOCKOUT (mid-journey): Pirate stronghold ${pirateInPath.systemId} entered capture radius of jump path!`);
        ctx.log("error", `🚫 Aborting pathfinder return at jump ${jumpsPerformed}/${maxJumps} — path blocked by pirate stronghold.`);
        return false;
      }
    }

    // Check fuel and hull before each jump
    await bot.refreshShip();
    const fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    const hullPct = bot.maxHull > 0 ? Math.round((bot.hull / bot.maxHull) * 100) : 100;

    if (fuelPct < fuelThresholdPct) {
      ctx.log("system", `Fuel ${fuelPct}% below threshold ${fuelThresholdPct}% — refueling before continuing`);
      const fueled = await ensureFueled(ctx, fuelThresholdPct);
      if (!fueled) {
        ctx.log("error", "Could not refuel — aborting frontier return");
        return false;
      }
      // Re-check safety after refuel attempt
      const postRefuelSafety = await checkPathfinderFuelSafety(ctx, maxJumps - jumpsPerformed, 2);
      if (!postRefuelSafety.safe) {
        ctx.log("error", `🚫 PATHFINDER LOCKOUT (post-refuel): ${postRefuelSafety.reason}`);
        return false;
      }
    }

    if (hullPct <= hullThresholdPct) {
      ctx.log("system", `Hull ${hullPct}% at/below threshold ${hullThresholdPct}% — finding station for repair`);
      const docked = await ensureDocked(ctx);
      if (docked) await repairShip(ctx);
    }

    // Check if we've already reached main network
    await bot.refreshLocation();
    
    // Build main network if not already built
    if (mainNetwork.size === 0) {
      const graph = new Map<string, Set<string>>();
      const addNode = (id: string): void => {
        const key = id.toLowerCase();
        if (!graph.has(key)) graph.set(key, new Set());
      };
      const addEdge = (a: string, b: string): void => {
        addNode(a);
        addNode(b);
        graph.get(a.toLowerCase())!.add(b.toLowerCase());
        graph.get(b.toLowerCase())!.add(a.toLowerCase());
      };
      const STATIC_WORMHOLES: Array<[string, string]> = [
        ["alzirr", "praecipua"],
        ["hadar", "gsc_0036"],
      ];
      for (const sys of mapStore.getSystems()) {
        addNode(sys.id);
        for (const conn of sys.connections || []) {
          if (!conn.system_id) continue;
          addEdge(sys.id, conn.system_id);
        }
      }
      for (const [a, b] of STATIC_WORMHOLES) {
        addEdge(a, b);
      }
      const homeSystem = "sol";
      const mainComponent = new Set<string>();
      const queue = [homeSystem.toLowerCase()];
      mainComponent.add(homeSystem.toLowerCase());
      while (queue.length > 0) {
        const current = queue.shift()!;
        const neighbors = graph.get(current);
        if (!neighbors) continue;
        for (const nb of neighbors) {
          if (!mainComponent.has(nb)) {
            mainComponent.add(nb);
            queue.push(nb);
          }
        }
      }
      if (mainComponent.size <= 1) {
        // fallback to largest component
        const visited = new Set<string>();
        let largestComponent = new Set<string>();
        for (const node of graph.keys()) {
          if (visited.has(node)) continue;
          const component = new Set<string>();
          const compQueue = [node];
          component.add(node);
          visited.add(node);
          while (compQueue.length > 0) {
            const current = compQueue.shift()!;
            const neighbors = graph.get(current);
            if (!neighbors) continue;
            for (const nb of neighbors) {
              if (!visited.has(nb)) {
                visited.add(nb);
                component.add(nb);
                compQueue.push(nb);
              }
            }
          }
          if (component.size > largestComponent.size) {
            largestComponent = component;
          }
        }
        for (const node of largestComponent) {
          mainNetwork.add(node);
        }
      } else {
        for (const node of mainComponent) {
          mainNetwork.add(node);
        }
      }
    }

    if (mainNetwork.has(bot.system.toLowerCase())) {
      ctx.log("travel", `Successfully returned to main network at ${bot.system}!`);
      return true;
    }

    // Avoid repeat jumps in the same direction (wastes fuel)
    // If bearing hasn't changed significantly, adjust slightly
    if (lastBearing !== null) {
      const bearingDiff = Math.abs(bearing - lastBearing);
      const normalizedDiff = Math.min(bearingDiff, 360 - bearingDiff);
      if (normalizedDiff < 5) { // Less than 5 degrees difference
        consecutiveSameDirection++;
        if (consecutiveSameDirection >= 2) {
          // Adjust bearing slightly to avoid fuel waste
          bearing = (bearing + 15) % 360;
          ctx.log("travel", `Adjusting bearing to ${formatBearing(bearing, 2)}° to avoid repeat jump in same direction (fuel conservation)`);
          consecutiveSameDirection = 0;
        }
      } else {
        consecutiveSameDirection = 0;
      }
    }

    // Execute pathfinder jump
    const midTransitWaitMs = (jumpsPerformed === 0 && scanWaitMinutes > 0) ? scanWaitMinutes * 60 * 1000 : 0;
    const result = await executePathfinderJumpToBearing(ctx, bearing, currentPos, {
      waitForCompletion: true,
      midTransitWaitMs,
    });

    if (!result.success) {
      ctx.log("error", `Pathfinder jump failed — aborting frontier return`);
      return false;
    }

    jumpsPerformed++;
    lastBearing = bearing;
    currentPos = result.arrivalPos || currentPos;

    // Delay between jumps if configured
    if (scanDelayTicks > 0 && bot.state === "running") {
      ctx.log("system", `Delaying ${scanDelayTicks} tick(s) between pathfinder jumps...`);
      await ctx.sleep(scanDelayTicks * 10_000);
    }

    // Recalculate bearing from new position toward target
    if (currentPos) {
      bearing = calculateBearingToTarget(currentPos.x, currentPos.y, target.position.x, target.position.y);
      ctx.log("travel", `Recalculated bearing to ${target.systemName}: ${formatBearing(bearing, 2)}° (jump ${jumpsPerformed}/${maxJumps})`);
    }
  }

  // Final check if we're in main network
  await bot.refreshLocation();
  if (mainNetwork.has(bot.system.toLowerCase())) {
    ctx.log("travel", `Successfully returned to main network at ${bot.system} after ${jumpsPerformed} pathfinder jumps!`);
    return true;
  }

  ctx.log("warn", `Frontier return: max jumps (${maxJumps}) reached, not yet in main network. Current system: ${bot.system}`);
  return false;
}

async function pathfinderJumpAtBearing(
  ctx: RoutineContext,
  bearingDegrees: number,
  originPos: GalacticPos | null,
  { waitForCompletion = true, midTransitWaitMs = 0 }: { waitForCompletion?: boolean; midTransitWaitMs?: number } = {},
): Promise<JumpResult> {
  const { bot } = ctx;

  if (!bot.hasPathfinderDrive) {
    await bot.refreshShipMods();
  }
  if (!bot.hasPathfinderDrive) {
    ctx.log("error", "Pathfinder jump attempted without Pathfinder Drive module.");
    return { success: false, landedSystem: bot.system, arrivalPos: null, ticksTraveled: 0 };
  }

  await bot.refreshStatus();
  const originSystem = bot.system;
  const bearing = ((bearingDegrees % 360) + 360) % 360;

  // Track cloak state - disable for pathfinder jump (saves fuel, can't be attacked in transit)
  const wasCloaked = bot.isCloaked || false;
  if (wasCloaked) {
    ctx.log("travel", "Disabling cloak for pathfinder jump (fuel conservation)...");
    const decloakResp = await bot.exec("cloak", { enable: false });
    if (decloakResp.error) {
      ctx.log("warn", `Failed to disable cloak: ${decloakResp.error.message}`);
    } else {
      ctx.log("travel", "Cloak disabled for pathfinder jump");
    }
  }

  // Record the tick we depart on so we can compute distance traveled.
  const startTick = await bot.pollCurrentTick();

  ctx.log("travel", `Pathfinder jump at bearing ${formatBearing(bearing, 2)}° from ${originSystem}`);

  if (bot.state !== "running") {
    if (wasCloaked) await bot.exec("cloak", { enable: true });
    return { success: false, landedSystem: bot.system, arrivalPos: null, ticksTraveled: 0 };
  }

  const jumpResp = await bot.exec("jump", { target_system: bearing });
  if (jumpResp.error) {
    ctx.log("error", `Pathfinder jump at bearing ${formatBearing(bearing, 2)}° failed: ${jumpResp.error.message}`);
    // Re-enable cloak if we disabled it
    if (wasCloaked) {
      await bot.exec("cloak", { enable: true });
    }
    return { success: false, landedSystem: bot.system, arrivalPos: null, ticksTraveled: 0 };
  }

  ctx.log("debug", `Pathfinder jump at bearing ${formatBearing(bearing, 2)}° raw result=${JSON.stringify(jumpResp.result)}`);

  const jr = jumpResp.result as Record<string, unknown> | undefined;
  const arrivalSystemId = (jr?.arrival_system_id as string) || "";
  const arrivalSystemName = (jr?.arrival_system as string) || "";
  if (arrivalSystemId) {
    ctx.log("travel", `Jump result: arrived at ${arrivalSystemName || '?'} (${arrivalSystemId})`);
  }

  // Wait for transit to START (server may need a tick to register it).
  let inTransit = false;
  let ticksRemaining: number | null = null;
  let endTick: number | null = null;
  let poll = 0;
  const maxPolls = 720; // up to ~60 minutes at 5s polls

  // Phase 1: wait for transit to START
  let startPolls = 0;
  const maxStartPolls = 60; // up to ~1 minute at 1s polls
  while (bot.state === "running" && startPolls < maxStartPolls && !inTransit) {
    await ctx.sleep(1000);
    if (bot.state !== "running") break;
    startPolls++;
    const startPoi = await bot.exec("get_poi");
    if (startPoi.result && typeof startPoi.result === "object") {
      const p = startPoi.result as Record<string, unknown>;
      inTransit = (p.in_transit as boolean) ?? false;
      ticksRemaining = (p.ticks_remaining as number) ?? ticksRemaining;
    }
  }

  if (!inTransit && bot.state === "running") {
    ctx.log("error", `Pathfinder jump at bearing ${formatBearing(bearing, 2)}° — transit never started`);
    // Re-enable cloak if we disabled it
    if (wasCloaked) {
      await bot.exec("cloak", { enable: true });
    }
    return { success: false, landedSystem: bot.system, arrivalPos: null, ticksTraveled: 0 };
  }

  // Mid-transit sweep wait: get away from the origin system before continuing.
  if (midTransitWaitMs > 0 && bot.state === "running") {
    ctx.log("system", `Waiting ${Math.round(midTransitWaitMs / 60000)} minute(s) into jump at ${formatBearing(bearing, 2)}° to get away from origin...`);
    await ctx.sleep(midTransitWaitMs);
  }

  if (!waitForCompletion) {
    // Fire-and-forget: transit started, caller will sweep mid-transit and
    // wait for completion separately. No end tick / arrival pos available yet.
    return { success: true, landedSystem: bot.system, arrivalPos: null, ticksTraveled: 0 };
  }

  // Phase 2: wait for transit to COMPLETE
  while (bot.state === "running" && poll < maxPolls && inTransit) {
    await ctx.sleep(2000);
    if (bot.state !== "running") break;
    poll++;

    const poiResp = await bot.exec("get_poi");
    if (poiResp.result && typeof poiResp.result === "object") {
      const p = poiResp.result as Record<string, unknown>;
      inTransit = (p.in_transit as boolean) ?? false;
      ticksRemaining = (p.ticks_remaining as number) ?? ticksRemaining;
    }

    // Capture ticks periodically so we have an end tick when transit finishes.
    if (poll % 6 === 0) {
      endTick = await bot.pollCurrentTick();
      ctx.log("travel", `Pathfinder in transit — ticks_remaining=${ticksRemaining ?? "?"}${endTick !== null ? `, tick=${endTick}` : ""}`);
    }
  }

  if (poll >= maxPolls && inTransit && bot.state === "running") {
    ctx.log("error", `Pathfinder jump at bearing ${formatBearing(bearing, 2)}° — transit did not complete after ${Math.round(maxPolls * 5 / 1000)}s, aborting`);
    // Re-enable cloak if we disabled it
    if (wasCloaked) {
      await bot.exec("cloak", { enable: true });
    }
    return { success: false, landedSystem: bot.system, arrivalPos: null, ticksTraveled: 0 };
  }

  // Honor an immediate stop request — don't poll tick or continue processing.
  if (bot.state !== "running") {
    ctx.log("system", "Pathfinder jump aborted — bot stopped");
    // Re-enable cloak if we disabled it
    if (wasCloaked) {
      await bot.exec("cloak", { enable: true });
    }
    return { success: false, landedSystem: bot.system, arrivalPos: null, ticksTraveled: 0 };
  }

  // Final tick capture at landing.
  endTick = await bot.pollCurrentTick();

  if (bot.state !== "running") {
    ctx.log("system", "Pathfinder jump aborted — bot stopped");
    // Re-enable cloak if we disabled it
    if (wasCloaked) {
      await bot.exec("cloak", { enable: true });
    }
    return { success: false, landedSystem: bot.system, arrivalPos: null, ticksTraveled: 0 };
  }

  // Compute arrival galactic position from origin + bearing * speed * elapsed ticks.
  let arrivalPos: GalacticPos | null = null;
  if (originPos && startTick !== null && endTick !== null) {
    const ticksTraveled = Math.max(0, endTick - startTick);
    const distance = ticksTraveled * PATHFINDER_SPEED;
    const rad = (bearing * Math.PI) / 180;
    arrivalPos = {
      x: originPos.x + distance * Math.cos(rad),
      y: originPos.y + distance * Math.sin(rad),
    };
    ctx.log("travel", `Tracked position: elapsed ${ticksTraveled} ticks, ${distance.toFixed(1)} GU, arrival galactic (${arrivalPos.x.toFixed(1)}, ${arrivalPos.y.toFixed(1)})`);
  }

  // Refresh location to learn the system we landed at
  await bot.refreshLocation();
  await bot.refreshStatus();

  const landed = bot.system;
  ctx.log("travel", `Pathfinder jump at bearing ${formatBearing(bearing, 2)}° complete: arrived at ${landed}`);

  // Re-enable cloak if we disabled it for the jump
  if (wasCloaked) {
    ctx.log("travel", "Re-enabling cloak after pathfinder jump...");
    const recloakResp = await bot.exec("cloak", { enable: true });
    if (recloakResp.error) {
      ctx.log("warn", `Failed to re-enable cloak: ${recloakResp.error.message}`);
    } else {
      ctx.log("travel", "Cloak re-enabled");
    }
  }

  // If we landed at a known system in mapStore, prefer its exact position over our computed one.
  if (arrivalPos === null) {
    const landedSys = mapStore.getSystem(landed);
    if (landedSys?.position) {
      arrivalPos = landedSys.position;
    }
  }

  return { success: true, landedSystem: landed, arrivalPos, ticksTraveled: endTick !== null && startTick !== null ? Math.max(0, endTick - startTick) : 0 };
}

interface FoundSystem {
  angle: number;
  systemId: string;
  systemName: string;
  known: boolean;
  atVoid: boolean;
}

interface FuelCheck {
  ok: boolean;
  availableFuel: number;
  neededFuel: number;
  fuelPerJump: number;
  totalJumps: number;
  jumpsPossible: number;
  militaryCells: number;
}

/** Pre-flight stupidity check: can this ship actually complete the configured scan? */
async function preflightFuelCheck(
  ctx: RoutineContext,
  totalJumps: number,
  originSystem?: string,
): Promise<FuelCheck> {
  const { bot } = ctx;

  // Tank fuel currently aboard.
  const tankFuel = bot.fuel;

  // Military fuel cells in cargo (100 fuel each for this ship's loadout).
  let militaryCells = 0;
  for (const item of bot.inventory) {
    if (item.itemId === "military_fuel_cell") militaryCells += item.quantity;
  }
  const cellFuel = getFuelCellFuelValue("military_fuel_cell"); // 100 per cell
  const availableFuel = tankFuel + militaryCells * cellFuel;

  // Pathfinder jumps cost 5x the ship's normal jump fuel cost (per find_route).
  // find_route is the only source that knows this ship's actual fuel burn.
  let pathfinderFuelPerJump = 25; // fallback if find_route is unavailable
  if (originSystem) {
    const route = await estimateRouteFuel(ctx, originSystem);
    if (route && route.fuelPerJump > 0) {
      pathfinderFuelPerJump = route.fuelPerJump * 5;
    }
  }

  const fuelPerJump = pathfinderFuelPerJump;

  const neededFuel = totalJumps * fuelPerJump;
  const jumpsPossible = fuelPerJump > 0 ? Math.floor(availableFuel / fuelPerJump) : 0;
  const ok = availableFuel >= neededFuel;

  return { ok, availableFuel, neededFuel, fuelPerJump, totalJumps, jumpsPossible, militaryCells };
}

/** Before each scan jump, ensure fuel is above the refuel threshold.
 *  If in pathfinder transit, uses military fuel cells from cargo.
 *  If not in transit, docks at the nearest station and refuels.
 *  Returns false if refueling fails (caller should abort the scan). */
async function checkAndRefuelMidScan(
  ctx: RoutineContext,
  thresholdPct: number,
): Promise<boolean> {
  const { bot } = ctx;

  await bot.refreshStatus();
  await bot.refreshCargo();

  const fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
  if (fuelPct >= thresholdPct) {
    return true;
  }

  ctx.log("system", `Fuel ${fuelPct}% below refuel threshold ${thresholdPct}% — refueling before continuing scan...`);

  // If in pathfinder transit, we CANNOT dock at a station.
  // Use military fuel cells from cargo instead.
  if (bot.inTransit) {
    ctx.log("system", "In pathfinder transit — using military fuel cells from cargo to refuel");
    const mfcItem = bot.inventory.find(i => i.itemId === "military_fuel_cell" && i.quantity > 0);
    if (!mfcItem) {
      ctx.log("error", "No military fuel cells in cargo — cannot refuel while in pathfinder transit");
      return false;
    }

    // Consume MFCs via refuel command (works while undocked/in-transit)
    let consecutiveErrors = 0;
    for (let i = 0; i < 10 && bot.state === "running" && bot.inTransit; i++) {
      const resp = await bot.exec("refuel");
      if (resp.error) {
        consecutiveErrors++;
        const msg = resp.error.message.toLowerCase();
        if (msg.includes("already full") || msg.includes("tank_full") || msg.includes("max")) {
          break;
        }
        if (msg.includes("no_fuel_cells") || msg.includes("no fuel cells") || msg.includes("no fuel")) {
          ctx.log("error", "Ran out of fuel cells in cargo while in transit");
          return false;
        }
        if (consecutiveErrors >= 2) break;
        continue;
      }
      consecutiveErrors = 0;
      await bot.refreshShip();
      await bot.refreshCargo();
      const newPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
      if (newPct >= thresholdPct) {
        ctx.log("system", `Refueled to ${newPct}% via cargo cells — resuming scan`);
        return true;
      }
    }

    await bot.refreshShip();
    const finalPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    if (finalPct < thresholdPct) {
      ctx.log("error", `Refuel from cargo cells failed — still at ${finalPct}% — aborting pathfinder scan`);
      return false;
    }
    ctx.log("system", `Refueled to ${finalPct}% via cargo cells — resuming scan`);
    return true;
  }

  // Not in transit — can dock at a station normally
  const docked = await ensureDocked(ctx);
  if (!docked) {
    ctx.log("error", "Cannot dock to refuel — aborting pathfinder scan");
    return false;
  }
  await tryRefuel(ctx);
  await bot.refreshShip();
  const newPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
  if (newPct < thresholdPct) {
    ctx.log("error", `Refuel failed — still at ${newPct}% — aborting pathfinder scan`);
    return false;
  }
  ctx.log("system", `Refueled to ${newPct}% — resuming scan`);
  return true;
}

export const pathfinderRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;
  const settings = getPathfinderSettings(bot.username);

  const originSystem = settings.originSystem || "sol";
  const scanStartDegree = settings.scanStartDegree ?? 0;
  const scanStepDegrees = Math.max(1, Math.min(180, settings.scanStepDegrees ?? 12));
  const scanWaitMinutes = settings.scanWaitMinutes ?? 5;
  const scanDelayTicks = settings.scanDelayTicks ?? 0;
  const refuelThreshold = settings.refuelThreshold ?? 50;

  const scanPattern = settings.scanPattern ?? "circle";
  let scanAngles: number[];
  let originPos: GalacticPos | null = null;
  let totalJumps = 0;
  let jumpsPerAngle = 1;

  // Handle P2P mode: point-to-point jump from start system to destination system
  if (scanPattern === "p2p") {
    const startSystem = settings.p2pStartSystem || originSystem;
    const destSystem = settings.p2pDestinationSystem || "";
    if (!destSystem) {
      ctx.log("error", "P2P mode requires a destination system — aborting");
      return;
    }
    ctx.log("system", `P2P mode: navigating from ${startSystem} to ${destSystem}`);

    // Navigate to start system
    const startArrived = await navigateToSystem(ctx, startSystem, {
      fuelThresholdPct: refuelThreshold,
      hullThresholdPct: 30,
    });
    if (!startArrived) {
      ctx.log("error", `Could not reach start system ${startSystem} — aborting P2P mode`);
      return;
    }
    ctx.log("travel", `At start system ${startSystem}`);

    // Get origin position for fuel check
    await getSystemInfo(ctx);
    const startSys = mapStore.getSystem(startSystem);
    originPos = startSys?.position ?? null;

    // Single jump to destination
    scanAngles = [];
    totalJumps = 1;
    ctx.log("system", `P2P mode: jumping to destination ${destSystem}`);

    // Perform the jump
    const jumped = await pathfinderJumpAtBearing(ctx, 0, originPos, {
      waitForCompletion: true,
    });
    if (!jumped.success) {
      ctx.log("error", `P2P jump to ${destSystem} failed`);
      return;
    }

    ctx.log("system", `P2P complete: arrived at ${bot.system}`);
    // Report and yield done
    ctx.log("system", `=== Pathfinder P2P Complete ===`);
    ctx.log("system", `Origin: ${startSystem}`);
    ctx.log("system", `Destination: ${destSystem}`);
    ctx.log("system", `Pattern: p2p`);
    ctx.log("system", `Systems found: 1`);
    ctx.log("system", `Back at ${bot.system} — pathfinder routine finished`);
    yield "done";
    return;
  }

  const startDegree = ((settings.scanStartDegree ?? 0 % 360) + 360) % 360;
  const numAngles = Math.floor(360 / scanStepDegrees);
  scanAngles = generateScanPattern(scanPattern, startDegree, scanStepDegrees, numAngles);
  // Every angle is a single pathfinder jump. Circle adds a final return jump;
  // non-circle patterns chain scans mid-drift without returning between angles.
  jumpsPerAngle = 1;
  totalJumps = scanAngles.length * jumpsPerAngle + (scanPattern === "circle" ? 1 : 0);

  ctx.log("system", `Pathfinder scan routine started — origin: ${originSystem}, start: ${startDegree}°, step: ${scanStepDegrees}° (${scanAngles.length} angles), pattern: ${scanPattern}, wait: ${scanWaitMinutes} min`);

  yield "prep";
  await bot.refreshStatus();

  ctx.log("travel", `Navigating to origin system ${originSystem}...`);
  const originArrived = await navigateToSystem(ctx, originSystem, {
    fuelThresholdPct: refuelThreshold,
    hullThresholdPct: 30,
  });
  if (!originArrived) {
    ctx.log("error", `Could not reach origin system ${originSystem} — aborting pathfinder scan`);
    return;
  }
  ctx.log("travel", `At origin system ${originSystem}`);

  // ── Pre-flight stupidity check ──
  const fuel = await preflightFuelCheck(ctx, totalJumps, originSystem);
  ctx.log("system", `=== Pathfinder fuel check ===`);
  ctx.log("system", `Tank fuel: ${bot.fuel}/${bot.maxFuel}  Military cells: ${fuel.militaryCells}x (${fuel.militaryCells * getFuelCellFuelValue("military_fuel_cell")} fuel)`);
  ctx.log("system", `Total available fuel: ${fuel.availableFuel}  Per-jump cost (this ship): ${fuel.fuelPerJump}`);
  ctx.log("system", `Planned jumps: ${fuel.totalJumps} (${numAngles} scan jumps${scanPattern !== "circle" ? "" : " + 1 return"})  Needed: ${fuel.neededFuel} fuel`);
  ctx.log("system", `Jumps possible with current fuel: ${fuel.jumpsPossible}`);
  if (!fuel.ok) {
    ctx.log("error", `INSUFFICIENT FUEL: need ${fuel.neededFuel} for the full scan but only have ${fuel.availableFuel} (${fuel.jumpsPossible} jumps possible). Refuel or reduce scan angles before starting.`);
    return;
  }
  ctx.log("system", `Fuel check PASSED — enough fuel for the full scan.`);

  // Ensure origin position is known for return calculations
  await getSystemInfo(ctx);
  const originSys = mapStore.getSystem(originSystem);
  originPos = originSys?.position ?? null;
  if (!originPos) {
    ctx.log("warn", `Origin system ${originSystem} has no position data — return bearing cannot be calculated`);
  }

  const foundSystems: FoundSystem[] = [];

  /** Issue a pathfinder jump at a bearing, then immediately read get_poi and
   *  log/record the destination. Fire-and-forget — no transit completion wait.
   *  `midTransitWaitMs` waits that many ms after transit starts (used for the
   *  initial jump to get away from the origin). */
  async function scanAngle(angle: number, label: string, opts?: { midTransitWaitMs?: number }): Promise<void> {
    const jumped = await pathfinderJumpAtBearing(ctx, angle, null, {
      waitForCompletion: false,
      midTransitWaitMs: opts?.midTransitWaitMs,
    });
    if (!jumped.success) {
      ctx.log("error", `Pathfinder jump at ${label} ${angle}° failed`);
      return;
    }

    if (bot.state !== "running") return;

    // Brief settle so the server registers the jump before we read get_poi.
    await ctx.sleep(500);

    if (bot.state !== "running") return;

    // Grab get_poi to see where we're headed.
    let destinationSystem = "?";
    let inTransit = false;
    let ticksRemaining: number | null = null;
    const poiResp = await bot.exec("get_poi");
    if (poiResp.result && typeof poiResp.result === "object") {
      const p = poiResp.result as Record<string, unknown>;
      inTransit = (p.in_transit as boolean) ?? false;
      ticksRemaining = (p.ticks_remaining as number) ?? ticksRemaining;
      const toSystem = p.to_system as string | undefined;
      if (toSystem && toSystem !== "") {
        destinationSystem = toSystem;
      } else if (!inTransit) {
        destinationSystem = (p.system as string) || (p.arrival_system as string) || "?";
      } else {
        destinationSystem = "VOID";
      }
    }

    ctx.log("system", `${label} ${angle}°: in_transit=${inTransit} ticks_remaining=${ticksRemaining ?? "?"} destination=${destinationSystem}`);

    // Refresh to learn where we are / where we're headed.
    await bot.refreshLocation();
    await bot.refreshStatus();
    const destination = destinationSystem !== "?" ? destinationSystem : bot.system;
    const wasKnown = mapStore.getSystem(destination) !== null;
    const atVoid = /void|empty|deep_space|interstellar|space/i.test(destination);

    foundSystems.push({
      angle,
      systemId: destination,
      systemName: destination,
      known: wasKnown,
      atVoid,
    });

    if (atVoid) {
      ctx.log("hunt", `${label} ${angle}°: destination ${destination} (void/empty space)`);
    } else if (wasKnown) {
      ctx.log("hunt", `${label} ${angle}°: destination ${destination} (known system)`);
    } else {
      ctx.log("hunt", `🎯 JACKPOT! ${label} ${angle}°: destination ${destination} (unknown/hidden system)`);
    }
  }

  for (let i = 0; i < scanAngles.length && bot.state === "running"; i++) {
    const angle = scanAngles[i];
    const label = scanPattern === "circle" ? "Angle" : "Out";

    yield "scanning";
    ctx.log("hunt", `Scanning ${label} ${angle}° (${i + 1}/${scanAngles.length})`);

    // Check fuel before each jump — refuel if below threshold.
    const fueled = await checkAndRefuelMidScan(ctx, refuelThreshold);
    if (!fueled) break;

    // Initial jump from origin at startDegree. Wait for transit to START,
    // then wait scanWaitMinutes mid-transit to get away from origin.
    if (i === 0) {
      if (bot.inTransit) {
        ctx.log("system", `Already drifting at start of sweep — skipping redundant initial jump at ${angle}°, checking destination instead...`);
      } else {
        await scanAngle(angle, label, {
          midTransitWaitMs: scanWaitMinutes > 0 ? scanWaitMinutes * 60 * 1000 : 0,
        });
      }
    } else {
      await scanAngle(angle, label);
    }

    if (bot.state !== "running") break;

    // Delay between scan jumps / spikes (1 tick = 10 seconds).
    if (scanDelayTicks > 0 && bot.state === "running") {
      ctx.log("system", `Delaying ${scanDelayTicks} tick(s) between scan jumps...`);
      await ctx.sleep(scanDelayTicks * 10_000);
    }
  }

  // Final return to origin.
  // Circle chains jumps mid-drift and needs one return jump to get back home.
  // Non-circle patterns chain scans without returning between angles, so they
  // also need a final return to get back to origin.
  if (bot.state === "running") {
    const returnBearing = (startDegree + 180) % 360;
    ctx.log("travel", `Returning to origin ${originSystem} at bearing ${returnBearing}°`);
    const returned = await pathfinderJumpAtBearing(ctx, returnBearing, null, { waitForCompletion: true });
    if (!returned.success) {
      ctx.log("error", `Return jump failed — may be stranded in ${bot.system}`);
    }
  }

  // Final formatted report
  const knownCount = foundSystems.filter(f => f.known && !f.atVoid).length;
  const unknownCount = foundSystems.filter(f => !f.known && !f.atVoid).length;
  const voidCount = foundSystems.filter(f => f.atVoid).length;

  ctx.log("system", `=== Pathfinder Scan Complete ===`);
  ctx.log("system", `Origin: ${originSystem}`);
  ctx.log("system", `Pattern: ${scanPattern}`);
  ctx.log("system", `Angles scanned: ${numAngles} (start ${startDegree}°, step ${scanStepDegrees}°)`);
  ctx.log("system", `Systems found: ${foundSystems.length} (known: ${knownCount}, unknown/jackpot: ${unknownCount}, void: ${voidCount})`);

  if (foundSystems.length > 0) {
    ctx.log("system", `--- Targeted Systems List ---`);
    for (const f of foundSystems) {
      const tag = f.atVoid ? "[VOID]" : (f.known ? "KNOWN" : "UNKNOWN/JACKPOT");
      ctx.log("system", `${f.angle.toFixed(0)}°: ${f.systemId} — ${tag}`);
    }
    ctx.log("system", `--- End of List ---`);
  }

  ctx.log("system", `Back at ${bot.system} — pathfinder scan routine finished`);
  yield "done";
};