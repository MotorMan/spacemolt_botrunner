import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { perf } from "./perf.js";
import { safeWriteFileSync } from "./diskSpaceGuard.js";

export const PATHFINDER_LANDING_MARGIN = 100.0;
export const PATHFINDER_SPEED = 10.0;

export interface SystemPosition {
  id: string;
  x: number;
  y: number;
  name?: string;
}

export interface PathfinderResult {
  systemId: string;
  systemName?: string;
  proj: number;
  perp: number;
  ticks: number;
  arrivalX: number;
  arrivalY: number;
  bearing: number;
}

export function toDegrees(rad: number): number {
  return ((rad * 180 / Math.PI) + 360) % 360;
}

export function calculatePathfinderBearing(
  originX: number,
  originY: number,
  destX: number,
  destY: number
): number {
  const dx = destX - originX;
  const dy = destY - originY;
  const rad = Math.atan2(dy, dx);
  return toDegrees(rad);
}

export function simulatePathfinderLanding(
  origin: SystemPosition,
  bearingDegrees: number,
  allSystems: readonly SystemPosition[]
): PathfinderResult | null {
  const originX = origin.x;
  const originY = origin.y;
  const rad = (bearingDegrees * Math.PI / 180);
  const dirX = Math.cos(rad);
  const dirY = Math.sin(rad);

  let best: PathfinderResult | null = null;
  let bestProj = Infinity;

  const originIdLower = origin.id.toLowerCase();

  for (const sys of allSystems) {
    if (sys.id.toLowerCase() === originIdLower) continue;
    if (typeof sys.x !== "number" || typeof sys.y !== "number") continue;

    const relX = sys.x - originX;
    const relY = sys.y - originY;

    const proj = relX * dirX + relY * dirY;
    if (proj <= 0) continue;

    const cross = relX * dirY - relY * dirX;
    const perp = Math.abs(cross);
    if (perp > PATHFINDER_LANDING_MARGIN) continue;

    if (proj < bestProj) {
      bestProj = proj;
      const ticks = Math.ceil(proj / PATHFINDER_SPEED);
      const arrivalX = originX + proj * dirX;
      const arrivalY = originY + proj * dirY;

      best = {
        systemId: sys.id,
        systemName: sys.name,
        proj,
        perp,
        ticks,
        arrivalX,
        arrivalY,
        bearing: bearingDegrees,
      };
    }
  }

  return best;
}

export function computePathfinderBearingToTarget(
  origin: SystemPosition,
  target: SystemPosition,
  allSystems: readonly SystemPosition[]
): {
  bearing: number;
  safe: boolean;
  landing: PathfinderResult | null;
  blocker?: PathfinderResult;
} {
  if (!origin || !target) {
    return { bearing: 0, safe: false, landing: null };
  }

  const bearing = calculatePathfinderBearing(
    origin.x, origin.y,
    target.x, target.y
  );

  const landing = simulatePathfinderLanding(origin, bearing, allSystems);

  const targetIdLower = target.id.toLowerCase();
  const safe = !!landing && landing.systemId.toLowerCase() === targetIdLower;

  const result: {
    bearing: number;
    safe: boolean;
    landing: PathfinderResult | null;
    blocker?: PathfinderResult;
  } = { bearing, safe, landing };

  if (landing && !safe) {
    result.blocker = landing;
  }

  return result;
}

export function reverseBearing(bearing: number): number {
  return (bearing + 180) % 360;
}

export function formatBearing(bearing: number, decimals = 12): string {
  const norm = ((bearing % 360) + 360) % 360;
  return norm.toFixed(decimals);
}

/** 
 * Pathfinder jumps use fixed speed (10 GU/tick), independent of ship speed.
 * ticks = ceil(proj / 10)
 * real seconds = ticks * 10  (game tick = 10s)
 */
export function getPathfinderTravelTime(proj: number): { ticks: number; seconds: number } {
  const ticks = Math.ceil(proj / PATHFINDER_SPEED);
  return { ticks, seconds: ticks * 10 };
}

export interface PathfinderCorrection {
  tick: number;
  bearing: number;
  bearingFull?: string;
}

export interface PathfinderTravelRecord {
  botName: string;
  originSystem: string;
  originTick: number;
  initialBearing: number;
  initialBearingFull?: string;
  corrections: PathfinderCorrection[];
  lastPolledTick?: number;
  lastPolledAt?: string;
  status?: string;
  destinationSystem?: string;
}

export interface PathfinderTravelData {
  version: 1;
  lastSaved: string;
  travels: Record<string, PathfinderTravelRecord>;
}

const DATA_DIR = join(process.cwd(), "data");
const TRAVEL_FILE = join(DATA_DIR, "pathfinderTraveling.json");
let travelCache: PathfinderTravelData | null = null;

function loadTravelData(): PathfinderTravelData {
  if (travelCache) return travelCache;
  try {
    if (existsSync(TRAVEL_FILE)) {
      const raw = readFileSync(TRAVEL_FILE, "utf-8");
      const parsed = JSON.parse(raw) as PathfinderTravelData;
      if (parsed && parsed.travels) {
        travelCache = parsed;
        return travelCache;
      }
    }
  } catch {}
  travelCache = { version: 1, lastSaved: new Date().toISOString(), travels: {} };
  return travelCache;
}

function saveTravelData(data: PathfinderTravelData): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    data.lastSaved = new Date().toISOString();
    const payload = JSON.stringify(data, null, 2) + "\n";
    safeWriteFileSync(TRAVEL_FILE, payload, Buffer.byteLength(payload, "utf-8"));
    travelCache = data;
  } catch {}
}

export function getActivePathfinderTravel(botName: string): PathfinderTravelRecord | null {
  const data = loadTravelData();
  return data.travels[botName] || null;
}

export function setPathfinderTravelState(botName: string, record: PathfinderTravelRecord): void {
  const data = loadTravelData();
  data.travels[botName] = { ...record, lastPolledAt: new Date().toISOString() };
  saveTravelData(data);
}

export function updatePathfinderTravelTick(botName: string, tick: number): void {
  const data = loadTravelData();
  const rec = data.travels[botName];
  if (rec) {
    rec.lastPolledTick = tick;
    rec.lastPolledAt = new Date().toISOString();
    saveTravelData(data);
  }
}

export function recordPathfinderCorrection(botName: string, tick: number, bearing: number, bearingFull?: string): void {
  const data = loadTravelData();
  const rec = data.travels[botName];
  if (rec) {
    if (!rec.corrections) rec.corrections = [];
    rec.corrections.push({ tick, bearing, bearingFull });
    saveTravelData(data);
  }
}

export function clearPathfinderTravel(botName: string): void {
  const data = loadTravelData();
  delete data.travels[botName];
  saveTravelData(data);
}

export interface DirectPathfinderJump {
  from: string;
  fromName: string;
  to: string;
  toName: string;
  bearing: number;
  bearing_full: string;
  proj: number;
  perpToTarget: number;
  ticks: number;
  travel_seconds: number;
}

export interface PathfinderCorrectionLeg {
  bearing: number;
  bearing_full?: string;
  proj: number;
  ticks: number;
  correction_frac?: number;
  correction_tick?: number;
  correction_tick_min?: number;
  correction_tick_max?: number;
}

export interface CorrectionPathfinderJump {
  from: string;
  fromName: string;
  to: string;
  toName: string;
  corrections_used: number;
  total_ticks: number;
  total_seconds: number;
  legs: PathfinderCorrectionLeg[];
  granularity_used?: string;
  min_tolerance_achieved?: number;
}

let directJumpsCache: DirectPathfinderJump[] | null = null;
let correctionJumpsCache: CorrectionPathfinderJump[] | null = null;

function loadDirectJumps(): DirectPathfinderJump[] {
  if (directJumpsCache) return directJumpsCache;
  try {
    const file = join(DATA_DIR, "pathfinder_level1_direct.json");
    if (existsSync(file)) {
      const raw = readFileSync(file, "utf-8");
      directJumpsCache = JSON.parse(raw);
    }
  } catch {
    directJumpsCache = [];
  }
  return directJumpsCache || [];
}

function loadCorrectionJumps(): CorrectionPathfinderJump[] {
  if (correctionJumpsCache) return correctionJumpsCache;
  return perf.timeSync("pathfinder.loadCorrectionJumps", () => {
    try {
      const file = join(DATA_DIR, "pathfinder_level2_1correction.json");
      if (existsSync(file)) {
        const raw = readFileSync(file, "utf-8");
        correctionJumpsCache = JSON.parse(raw);
      }
    } catch {
      correctionJumpsCache = [];
    }
    return correctionJumpsCache || [];
  });
}

export function getDirectPathfinderJump(fromSystem: string, toSystem: string): DirectPathfinderJump | null {
  const jumps = loadDirectJumps();
  const fromLower = fromSystem.toLowerCase();
  const toLower = toSystem.toLowerCase();
  return jumps.find(j => j.from.toLowerCase() === fromLower && j.to.toLowerCase() === toLower) || null;
}

export function getCorrectionPathfinderJump(fromSystem: string, toSystem: string): CorrectionPathfinderJump | null {
  return perf.timeSync("pathfinder.getCorrectionPathfinderJump", () => {
    const jumps = loadCorrectionJumps();
    const fromLower = fromSystem.toLowerCase();
    const toLower = toSystem.toLowerCase();
    return jumps.find(j => j.from.toLowerCase() === fromLower && j.to.toLowerCase() === toLower) || null;
  });
}

export function getCorrectionBearingAtTick(
  jump: CorrectionPathfinderJump,
  currentTick: number,
  originTick: number
): { bearing: number; legIndex: number; ticksRemaining: number } | null {
  const elapsed = currentTick - originTick;
  let accumulated = 0;
  let lastLegIndex = jump.legs.length - 1;
  
  for (let i = 0; i < jump.legs.length; i++) {
    const leg = jump.legs[i];
    if (leg.correction_tick_min !== undefined && leg.correction_tick_max !== undefined) {
      const targetTick = leg.correction_tick_min + Math.floor((leg.correction_tick_max - leg.correction_tick_min) / 2);
      if (elapsed >= targetTick && elapsed <= leg.correction_tick_max) {
        const nextLeg = jump.legs[i + 1];
        if (nextLeg) {
          return { bearing: nextLeg.bearing, legIndex: i + 1, ticksRemaining: jump.total_ticks - accumulated - (elapsed - (leg.correction_tick_min || 0)) };
        }
        return { bearing: leg.bearing, legIndex: i, ticksRemaining: jump.total_ticks - accumulated - (elapsed - (leg.correction_tick_min || 0)) };
      }
    }
    accumulated += leg.ticks;
    lastLegIndex = i;
  }
  
  if (elapsed >= accumulated - 5) {
    return { bearing: jump.legs[lastLegIndex].bearing, legIndex: lastLegIndex, ticksRemaining: 0 };
  }
  
  return null;
}

export interface MccWindowInfo {
  ticksUntilMcc: number;
  correctionBearing: number;
  legIndex: number;
}

export function getMccWindowInfo(
  jump: CorrectionPathfinderJump,
  elapsed: number
): MccWindowInfo | null {
  for (let i = 0; i < jump.legs.length; i++) {
    const leg = jump.legs[i];
    if (leg.correction_tick_min !== undefined && leg.correction_tick_max !== undefined) {
      const targetTick = leg.correction_tick_min + Math.floor((leg.correction_tick_max - leg.correction_tick_min) / 2);
      if (elapsed < targetTick) {
        const nextLeg = jump.legs[i + 1];
        if (nextLeg) {
          return {
            ticksUntilMcc: targetTick - elapsed,
            correctionBearing: nextLeg.bearing,
            legIndex: i + 1
          };
        }
      }
    }
  }
  return null;
}


export function generateScanPattern(
  pattern: string,
  startDegree: number,
  stepDegrees: number,
  numAngles: number,
): number[] {
  const angles: number[] = [];
  const start = ((startDegree % 360) + 360) % 360;
  const step = Math.max(1, Math.min(180, stepDegrees));
  const n = Math.max(1, Math.floor(numAngles));

  const norm = (a: number): number => ((a % 360) + 360) % 360;

  const base: number[] = [];
  for (let i = 0; i < n; i++) base.push(norm(start + i * step));

  const seen = new Set<number>();
  const pushUnique = (value: number): boolean => {
    const v = norm(value);
    if (seen.has(v)) return false;
    seen.add(v);
    angles.push(v);
    return true;
  };
  const fillRemaining = (): void => {
    for (const b of base) {
      if (angles.length >= n) break;
      pushUnique(b);
    }
  };

  switch (pattern) {
    case "circle": {
      for (const b of base) pushUnique(b);
      break;
    }
    case "star": {
      for (let i = 0; i < n; i++) {
        const k = Math.floor(i / 2) + 1;
        if (i === 0) {
          pushUnique(start);
        } else if (i % 2 === 0) {
          pushUnique(start + 180 + k * step);
        } else {
          pushUnique(start - k * step);
        }
      }
      fillRemaining();
      break;
    }
    case "spiral": {
      for (let i = 0; i < n; i++) {
        const offset = Math.floor((i + 1) / 2) * step;
        const dir = i % 2 === 0 ? 1 : -1;
        pushUnique(start + dir * offset);
      }
      fillRemaining();
      break;
    }
    case "figure8": {
      const half = Math.ceil(n / 2);
      for (let i = 0; i < half; i++) pushUnique(start + i * step);
      for (let i = half - 1; i >= 0; i--) pushUnique(start + i * step);
      fillRemaining();
      break;
    }
    case "zigzag": {
      for (let i = 0; i < n; i++) {
        const offset = Math.floor((i + 1) / 2) * step;
        const dir = i % 2 === 0 ? -1 : 1;
        pushUnique(start + dir * offset);
      }
      fillRemaining();
      break;
    }
    case "petal": {
      const stride = 7;
      for (let i = 0; i < n; i++) {
        pushUnique(base[(i * stride) % n]);
      }
      fillRemaining();
      break;
    }
    case "square": {
      for (let i = 0; i < 4; i++) pushUnique(start + i * 90);
      break;
    }
    case "cross": {
      for (let i = 0; i < 8; i++) pushUnique(start + i * 45);
      break;
    }
    case "wedge": {
      const halfWedge = Math.min(45, Math.floor(n / 2) * step);
      for (let i = 0; i < n; i++) pushUnique(start - halfWedge + i * step);
      break;
    }
    case "random": {
      const shuffled = [...base];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = shuffled[i];
        shuffled[i] = shuffled[j];
        shuffled[j] = tmp;
      }
      for (const a of shuffled) pushUnique(a);
      break;
    }
    default: {
      for (const b of base) pushUnique(b);
      break;
    }
  }

  return angles;
}

export function isPathfinderLandingAtVoid(landing: PathfinderResult | null): boolean {
  if (!landing) return true;
  const systemId = landing.systemId.toLowerCase();
  const voidSystems = ["void", "empty", "deep_space", "interstellar", "space"];
  return voidSystems.some(v => systemId.includes(v));
}

// Import mapStore for the new functions
import { mapStore } from "./mapstore.js";
import { ensureFueled, repairShip, ensureDocked } from "./routines/common.js";

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
  // Build main network using same logic as getMainNetworkSystems in explorer.ts
  const mainNetwork = new Set<string>();
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
  ctx: any, // RoutineContext
  bearingDegrees: number,
  originPos: { x: number; y: number } | null,
  options: { waitForCompletion?: boolean; midTransitWaitMs?: number } = {}
): Promise<{ success: boolean; landedSystem: string; arrivalPos: { x: number; y: number } | null; ticksTraveled: number }> {
  const { bot } = ctx;
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

  const startTick = await bot.pollCurrentTick();

  ctx.log("travel", `Pathfinder jump at bearing ${formatBearing(bearing, 2)}° from ${originSystem} (returning to main network)`);

  const jumpResp = await bot.exec("jump", { target_system: bearing });
  if (jumpResp.error) {
    ctx.log("error", `Pathfinder jump at bearing ${formatBearing(bearing, 2)}° failed: ${jumpResp.error.message}`);
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
    return { success: false, landedSystem: bot.system, arrivalPos: null, ticksTraveled: 0 };
  }

  if (bot.state !== "running") {
    ctx.log("system", "Pathfinder jump aborted — bot stopped");
    return { success: false, landedSystem: bot.system, arrivalPos: null, ticksTraveled: 0 };
  }

  endTick = await bot.pollCurrentTick();

  if (bot.state !== "running") {
    ctx.log("system", "Pathfinder jump aborted — bot stopped");
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

  if (arrivalPos === null) {
    const landedSys = mapStore.getSystem(landed);
    if (landedSys?.position) {
      arrivalPos = landedSys.position;
    }
  }

  return { success: true, landedSystem: landed, arrivalPos, ticksTraveled: endTick !== null && startTick !== null ? Math.max(0, endTick - startTick) : 0 };
}

/** Navigate from a frontier dead-end back to the main network using pathfinder jumps.
 *  Uses galactic coordinates to find the nearest main network system and jumps toward it.
 *  Avoids repeat jumps in the same direction to save fuel.
 *  Returns true if successfully reached main network, false otherwise. */
export async function navigateFrontierToMainNetwork(
  ctx: any, // RoutineContext
  options: { 
    maxJumps?: number; 
    fuelThresholdPct?: number;
    hullThresholdPct?: number;
    scanWaitMinutes?: number;
    scanDelayTicks?: number;
  } = {}
): Promise<boolean> {
  const { bot } = ctx;
  const { 
    maxJumps = 15, 
    fuelThresholdPct = 30,
    hullThresholdPct = 30,
    scanWaitMinutes = 5,
    scanDelayTicks = 0,
  } = options;

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

  // Find nearest main network system
  const target = findNearestMainNetworkSystem(originPos.x, originPos.y);
  if (!target) {
    ctx.log("error", "No main network system found with position data — cannot navigate back");
    return false;
  }

  ctx.log("travel", `Frontier return: targeting nearest main network system ${target.systemName} (${target.systemId}) at distance ${target.distance.toFixed(1)} GU`);

  // Calculate initial bearing
  let bearing = calculateBearingToTarget(originPos.x, originPos.y, target.position.x, target.position.y);
  ctx.log("travel", `Initial bearing to ${target.systemName}: ${formatBearing(bearing, 2)}°`);

  let jumpsPerformed = 0;
  let lastBearing: number | null = null;
  let consecutiveSameDirection = 0;
  let currentPos = originPos;
  let mainNetwork = new Set<string>();

  while (jumpsPerformed < maxJumps && bot.state === "running") {
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
