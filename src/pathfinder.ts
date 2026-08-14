import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { perf } from "./perf.js";

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
    writeFileSync(TRAVEL_FILE, JSON.stringify(data, null, 2) + "\n", "utf-8");
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

export function isPathfinderLandingAtVoid(landing: PathfinderResult | null): boolean {
  if (!landing) return true;
  const systemId = landing.systemId.toLowerCase();
  const voidSystems = ["void", "empty", "deep_space", "interstellar", "space"];
  return voidSystems.some(v => systemId.includes(v));
}
