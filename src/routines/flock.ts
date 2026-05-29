// flock.ts - Generic flock coordination system
import type { RoutineContext } from "../bot.js";

// ── Generic Flock State ─────────────────────────────────────────

export interface FlockState {
  leader: string;
  targetSystemId: string;
  targetPoiId: string;
  targetPoiName: string;
  targetResourceId: string;
  miningType: "ore" | "gas" | "ice" | "radioactive" | "salvage";
  phase: "gathering" | "traveling" | "mining" | "salvaging" | "towing" | "returning" | "docked";
  members: string[];
  lastUpdate: number;
  rallySystem?: string;
  // Salvage-specific fields
  foundWrecks?: Array<{ poiId: string; wreckId: string; claimedBy?: string; claimedAt?: number }>;
  timeoutEnd?: number;
}

export interface FlockGroupConfig {
  name: string;
  targetOre: string;
  targetGas: string;
  targetIce: string;
  miningType: "auto" | "ore" | "gas" | "ice" | "radioactive" | "salvage";
  rallySystem?: string;
  systemOre?: string;
  systemGas?: string;
  systemIce?: string;
  systemSalvage?: string;
  maxMembers?: number;
  [key: string]: unknown;
}

// ── Flock State File Management ─────────────────────────────────

/**
 * Get the flock state file path for a given flock name.
 */
export async function getFlockStatePath(flockName: string): Promise<string> {
  const { join } = await import("path");
  return join(process.cwd(), "data", "flock_signals", `${flockName}.json`);
}

/**
 * Read the current flock state. Returns null if no state exists or it's stale (>60s).
 */
export async function readFlockState(flockName: string): Promise<FlockState | null> {
  const { readFileSync, existsSync } = await import("fs");
  const flockPath = await getFlockStatePath(flockName);

  if (!existsSync(flockPath)) return null;

  try {
    const raw = readFileSync(flockPath, "utf-8");
    const state = JSON.parse(raw) as FlockState;

    // Check if state is stale (older than 60 seconds)
    if (Date.now() - state.lastUpdate > 60_000) {
      return null;
    }

    return state;
  } catch (e) {
    return null;
  }
}

/**
 * Write flock state to the shared file.
 */
export async function writeFlockState(flockName: string, state: FlockState): Promise<void> {
  const { writeFileSync, existsSync, mkdirSync } = await import("fs");
  const { join } = await import("path");
  const flockDir = join(process.cwd(), "data", "flock_signals");

  if (!existsSync(flockDir)) {
    mkdirSync(flockDir, { recursive: true });
  }

  const flockPath = await getFlockStatePath(flockName);
  state.lastUpdate = Date.now();
  writeFileSync(flockPath, JSON.stringify(state, null, 2));
}

/**
 * Clear flock state file (used when leaving flock or session ends).
 */
export async function clearFlockState(flockName: string): Promise<void> {
  const { existsSync, unlinkSync } = await import("fs");
  const flockPath = await getFlockStatePath(flockName);

  if (existsSync(flockPath)) {
    try {
      unlinkSync(flockPath);
    } catch (e) {
      // Ignore errors
    }
  }
}

// ── Member Management ──────────────────────────────────────────

/**
 * Register this bot as a member of the flock.
 * Leader adds itself to the members list.
 */
export async function registerFlockMember(
  flockName: string,
  username: string,
  isLeader: boolean,
): Promise<FlockState | null> {
  const existingState = await readFlockState(flockName);

  if (isLeader) {
    // Leader creates or updates the flock state
    const newState: FlockState = {
      leader: username,
      targetSystemId: "",
      targetPoiId: "",
      targetPoiName: "",
      targetResourceId: "",
      miningType: "ore",
      phase: "gathering",
      members: existingState?.members ? [...new Set([...existingState.members, username])] : [username],
      lastUpdate: Date.now(),
      foundWrecks: [],
    };
    await writeFlockState(flockName, newState);
    return newState;
  } else {
    // Follower joins existing flock
    if (!existingState) return null;

    // Check if flock has room (if maxMembers is set)
    // Note: maxMembers check happens at higher level
    if (!existingState.members.includes(username)) {
      existingState.members.push(username);
    }
    await writeFlockState(flockName, existingState);
    return existingState;
  }
}

/**
 * Remove this bot from the flock members list.
 */
export async function unregisterFlockMember(
  flockName: string,
  username: string,
): Promise<void> {
  const existingState = await readFlockState(flockName);

  if (existingState) {
    existingState.members = existingState.members.filter(m => m !== username);

    // If leader is leaving, elect new leader or clear state
    if (existingState.leader === username) {
      if (existingState.members.length > 0) {
        existingState.leader = existingState.members[0];
      } else {
        await clearFlockState(flockName);
        return;
      }
    }

    await writeFlockState(flockName, existingState);
  }
}

// ── Target Management ──────────────────────────────────────────

/**
 * Leader announces target selection to flock.
 */
export async function announceFlockTarget(
  flockName: string,
  leader: string,
  targetSystemId: string,
  targetPoiId: string,
  targetPoiName: string,
  targetResourceId: string,
  miningType: "ore" | "gas" | "ice" | "radioactive" | "salvage",
  rallySystem?: string,
): Promise<void> {
  const existingState = await readFlockState(flockName);

  const newState: FlockState = {
    leader,
    targetSystemId,
    targetPoiId,
    targetPoiName,
    targetResourceId,
    miningType,
    phase: existingState?.phase === "mining" || existingState?.phase === "salvaging" ? existingState.phase : "traveling",
    members: existingState?.members || [leader],
    lastUpdate: Date.now(),
    rallySystem,
    foundWrecks: existingState?.foundWrecks || [],
  };

  await writeFlockState(flockName, newState);
}

/**
 * Update flock phase.
 */
export async function updateFlockPhase(
  flockName: string,
  phase: FlockState["phase"],
): Promise<void> {
  const existingState = await readFlockState(flockName);

  if (existingState) {
    existingState.phase = phase;
    await writeFlockState(flockName, existingState);
  }
}

// ── Salvage-Specific Functions ─────────────────────────────────

/**
 * Claim a wreck for towing (salvage-specific).
 */
export async function claimFlockWreck(
  flockName: string,
  username: string,
  poiId: string,
  wreckId: string,
): Promise<boolean> {
  const existingState = await readFlockState(flockName);

  if (!existingState || !existingState.foundWrecks) return false;

  // Check if wreck is already claimed
  const wreck = existingState.foundWrecks.find(w => w.poiId === poiId && w.wreckId === wreckId);
  if (wreck && wreck.claimedBy) return false; // Already claimed

  // Claim the wreck
  if (wreck) {
    wreck.claimedBy = username;
    wreck.claimedAt = Date.now();
  } else {
    existingState.foundWrecks.push({
      poiId,
      wreckId,
      claimedBy: username,
      claimedAt: Date.now(),
    });
  }

  await writeFlockState(flockName, existingState);
  return true;
}

/**
 * Report found wrecks to the flock (salvage-specific).
 */
export async function reportFlockWrecks(
  flockName: string,
  username: string,
  wrecks: Array<{ poiId: string; wreckId: string }>,
): Promise<void> {
  const existingState = await readFlockState(flockName);

  if (!existingState) return;

  if (!existingState.foundWrecks) existingState.foundWrecks = [];

  // Add new wrecks if not already reported
  for (const wreck of wrecks) {
    const existing = existingState.foundWrecks.find(w => w.poiId === wreck.poiId && w.wreckId === wreck.wreckId);
    if (!existing) {
      existingState.foundWrecks.push({
        poiId: wreck.poiId,
        wreckId: wreck.wreckId,
      });
    }
  }

  await writeFlockState(flockName, existingState);
}

/**
 * Get available unclaimed wrecks for this bot.
 */
export async function getAvailableFlockWrecks(
  flockName: string,
  username: string,
): Promise<Array<{ poiId: string; wreckId: string }>> {
  const existingState = await readFlockState(flockName);

  if (!existingState || !existingState.foundWrecks) return [];

  return existingState.foundWrecks
    .filter(w => !w.claimedBy || w.claimedBy === username)
    .map(w => ({ poiId: w.poiId, wreckId: w.wreckId }));
}

/**
 * Set flock timeout for coordination period.
 */
export async function setFlockTimeout(
  flockName: string,
  timeoutMinutes: number = 5,
): Promise<void> {
  const existingState = await readFlockState(flockName);

  if (existingState) {
    existingState.timeoutEnd = Date.now() + (timeoutMinutes * 60 * 1000);
    await writeFlockState(flockName, existingState);
  }
}

/**
 * Check if flock coordination timeout has expired.
 */
export async function isFlockTimeoutExpired(flockName: string): Promise<boolean> {
  const existingState = await readFlockState(flockName);

  if (!existingState || !existingState.timeoutEnd) return false;

  return Date.now() > existingState.timeoutEnd;
}