/**
 * Rescue Queue System - Manages queued rescues for our own bots.
 * Batches multiple rescues and optimizes routes to avoid unnecessary travel.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const DATA_DIR = join(process.cwd(), "data");
const QUEUE_FILE = join(DATA_DIR, "rescueQueue.json");

export interface QueuedRescue {
  /** Unique ID for this queued rescue */
  id: string;
  /** Username of the bot to rescue */
  targetUsername: string;
  /** System where the bot is located */
  system: string;
  /** POI where the bot is located */
  poi: string;
  /** Current fuel percentage */
  fuelPct: number;
  /** Whether the bot is docked */
  docked: boolean;
  /** When this rescue was added to the queue */
  addedAt: number;
  /** Whether this rescue has been completed */
  completed: boolean;
  /** Number of attempts made */
  attempts: number;
  /** Last attempt timestamp */
  lastAttemptAt?: number;
}

export interface RescueQueueData {
  /** Queue of pending rescues */
  pending: QueuedRescue[];
  /** History of completed rescues */
  completed: QueuedRescue[];
  /** Current optimization plan */
  currentRoute?: {
    /** Systems to visit in order */
    systems: string[];
    /** Current index in the route */
    currentIndex: number;
    /** When this route was calculated */
    calculatedAt: number;
  };
}

export interface RescueQueue {
  pending: QueuedRescue[];
  completed: QueuedRescue[];
  currentRoute?: {
    systems: string[];
    currentIndex: number;
    calculatedAt: number;
  };
}

/**
 * Load the rescue queue from disk.
 */
export function loadRescueQueue(): RescueQueueData {
  try {
    if (existsSync(QUEUE_FILE)) {
      return JSON.parse(readFileSync(QUEUE_FILE, "utf-8"));
    }
  } catch (err) {
    console.warn("Could not load rescueQueue.json:", err);
  }
  return { pending: [], completed: [], currentRoute: undefined };
}

/**
 * Save the rescue queue to disk.
 */
export function saveRescueQueue(data: RescueQueueData): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(QUEUE_FILE, JSON.stringify(data, null, 2) + "\n");
  } catch (err) {
    console.error("Error saving rescueQueue.json:", err);
  }
}

/**
 * Get the current rescue queue.
 */
export function getRescueQueue(): RescueQueue {
  const data = loadRescueQueue();
  return {
    pending: data.pending || [],
    completed: data.completed || [],
    currentRoute: data.currentRoute,
  };
}

/**
 * Add a rescue to the queue.
 * Returns the queued rescue if added, or existing if already queued.
 */
export function addToRescueQueue(
  targetUsername: string,
  system: string,
  poi: string,
  fuelPct: number,
  docked: boolean
): { added: boolean; rescue: QueuedRescue } {
  const data = loadRescueQueue();

  // Check if already in queue
  const existing = data.pending.find(
    r => r.targetUsername === targetUsername && !r.completed
  );

  if (existing) {
    // Update existing entry with latest info
    existing.system = system;
    existing.poi = poi;
    existing.fuelPct = fuelPct;
    existing.docked = docked;
    return { added: false, rescue: existing };
  }

  const rescue: QueuedRescue = {
    id: `${targetUsername}_${Date.now()}`,
    targetUsername,
    system,
    poi,
    fuelPct,
    docked,
    addedAt: Date.now(),
    completed: false,
    attempts: 0,
  };

  data.pending.push(rescue);
  saveRescueQueue(data);

  return { added: true, rescue };
}

/**
 * Get the next rescue to perform, optionally optimized by location.
 * If currentSystem is provided, returns rescues in the same system first.
 */
export function getNextRescue(currentSystem?: string): QueuedRescue | null {
  const data = loadRescueQueue();

  if (data.pending.length === 0) {
    return null;
  }

  // If we have a current system, prioritize rescues in the same system
  if (currentSystem) {
    const normalize = (s: string) => s.toLowerCase().replace(/_/g, ' ').trim();
    const sameSystemRescues = data.pending.filter(
      r => normalize(r.system) === normalize(currentSystem) && !r.completed
    );

    if (sameSystemRescues.length > 0) {
      // Return the most critical (lowest fuel) rescue in this system
      sameSystemRescues.sort((a, b) => a.fuelPct - b.fuelPct);
      return sameSystemRescues[0];
    }
  }

  // Otherwise, return the most critical rescue overall
  const pending = data.pending.filter(r => !r.completed);
  if (pending.length > 0) {
    pending.sort((a, b) => a.fuelPct - b.fuelPct);
    return pending[0];
  }

  return null;
}

/**
 * Get all rescues in a specific system.
 */
export function getRescuesInSystem(system: string): QueuedRescue[] {
  const data = loadRescueQueue();
  const normalize = (s: string) => s.toLowerCase().replace(/_/g, ' ').trim();
  return data.pending.filter(
    r => normalize(r.system) === normalize(system) && !r.completed
  );
}

/**
 * Mark a rescue as completed.
 */
export function markRescueCompleted(rescueId: string): void {
  const data = loadRescueQueue();

  const index = data.pending.findIndex(r => r.id === rescueId);
  if (index !== -1) {
    const rescue = data.pending[index];
    rescue.completed = true;
    rescue.lastAttemptAt = Date.now();

    // Move to completed history
    data.completed.unshift(rescue);
    if (data.completed.length > 100) {
      data.completed = data.completed.slice(0, 100);
    }

    // Remove from pending
    data.pending.splice(index, 1);
    saveRescueQueue(data);
  }
}

/**
 * Increment attempt counter for a rescue.
 */
export function incrementRescueAttempt(rescueId: string): void {
  const data = loadRescueQueue();

  const rescue = data.pending.find(r => r.id === rescueId);
  if (rescue) {
    rescue.attempts++;
    rescue.lastAttemptAt = Date.now();
    saveRescueQueue(data);
  }
}

/**
 * Optimize the rescue route based on current location.
 * Returns an ordered list of systems to visit.
 */
export function optimizeRescueRoute(
  currentSystem: string,
  maxStops?: number
): string[] {
  const data = loadRescueQueue();
  const pending = data.pending.filter(r => !r.completed);

  if (pending.length === 0) {
    return [];
  }

  // Group rescues by system
  const systemCounts = new Map<string, number>();
  for (const rescue of pending) {
    systemCounts.set(
      rescue.system,
      (systemCounts.get(rescue.system) || 0) + 1
    );
  }

  // Simple optimization: start from current system, visit systems with most rescues first
  const systems = Array.from(systemCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([system]) => system);

  // Limit stops if specified
  if (maxStops && systems.length > maxStops) {
    return systems.slice(0, maxStops);
  }

  return systems;
}

/**
 * Set the current optimized route.
 */
export function setCurrentRoute(systems: string[]): void {
  const data = loadRescueQueue();
  data.currentRoute = {
    systems,
    currentIndex: 0,
    calculatedAt: Date.now(),
  };
  saveRescueQueue(data);
}

/**
 * Get the current optimized route.
 */
export function getCurrentRoute(): {
  systems: string[];
  currentIndex: number;
  calculatedAt: number;
} | null {
  const data = loadRescueQueue();
  return data.currentRoute || null;
}

/**
 * Advance to the next system in the route.
 */
export function advanceRoute(): string | null {
  const data = loadRescueQueue();

  if (!data.currentRoute) {
    return null;
  }

  data.currentRoute.currentIndex++;

  if (data.currentRoute.currentIndex >= data.currentRoute.systems.length) {
    // Route completed
    data.currentRoute = undefined;
    saveRescueQueue(data);
    return null;
  }

  saveRescueQueue(data);
  return data.currentRoute.systems[data.currentRoute.currentIndex];
}

/**
 * Get the current system in the route.
 */
export function getCurrentRouteSystem(): string | null {
  const data = loadRescueQueue();

  if (!data.currentRoute) {
    return null;
  }

  return data.currentRoute.systems[data.currentRoute.currentIndex] || null;
}

/**
 * Clear the rescue queue (completed entries are kept in history).
 */
export function clearRescueQueue(): void {
  const data = loadRescueQueue();
  data.pending = [];
  saveRescueQueue(data);
}

/**
 * Get queue statistics.
 */
export function getQueueStats(): {
  pending: number;
  completed: number;
  systems: string[];
  totalRescues: number;
} {
  const data = loadRescueQueue();
  const pending = data.pending.filter(r => !r.completed);
  const systems = [...new Set(pending.map(r => r.system))];

  return {
    pending: pending.length,
    completed: data.completed.length,
    systems,
    totalRescues: pending.length + data.completed.length,
  };
}

/**
 * Remove stale entries from the queue (older than 1 hour without attempts).
 */
export function cleanupStaleQueue(maxAgeMs: number = 60 * 60 * 1000): void {
  const data = loadRescueQueue();
  const now = Date.now();

  data.pending = data.pending.filter(r => {
    // Keep recent entries or ones that have been attempted
    if (r.attempts > 0) {
      return true;
    }
    return now - r.addedAt < maxAgeMs;
  });

  saveRescueQueue(data);
}
