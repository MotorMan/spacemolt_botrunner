/**
 * Shared, write-throttled store for `data/explorerAssignments.json`.
 * 
 * Tracks the starting system and completed systems for each explorer bot.
 * Used for coordination to spread exploration across the galaxy.
 */

import { existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { safeWriteFileSync } from "./diskSpaceGuard.js";

const DATA_DIR = join(process.cwd(), "data");
const EXPLORER_ASSIGNMENTS_FILE = join(DATA_DIR, "explorerAssignments.json");

/** How often the in-memory explorer assignments are written to disk. */
const PERSIST_INTERVAL_MS = 30_000;

export interface ExplorerAssignment {
  botName: string;
  startingSystem: string;
  startingSystemName: string;
  assignedAt: string;
  completedSystems: string[];
  lastUpdated: string;
}

export interface ExplorerAssignmentsData {
  lastSaved: string;
  bots: Record<string, ExplorerAssignment>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

class ExplorerAssignmentStore {
  private data: ExplorerAssignmentsData | null = null;
  private dirty = false;
  private writing = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  private ensureLoaded(): ExplorerAssignmentsData {
    if (this.data) return this.data;
    ensureDataDir();
    let loaded: ExplorerAssignmentsData = { lastSaved: nowIso(), bots: {} };
    if (existsSync(EXPLORER_ASSIGNMENTS_FILE)) {
      try {
        const raw = readFileSync(EXPLORER_ASSIGNMENTS_FILE, "utf-8");
        const parsed = JSON.parse(raw) as ExplorerAssignmentsData;
        if (parsed && typeof parsed.bots === "object") loaded = parsed;
      } catch {
        // Corrupt file — start fresh
      }
    }
    this.data = loaded;
    this.startAutoPersist();
    return loaded;
  }

  private startAutoPersist(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, PERSIST_INTERVAL_MS);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  stopAutoPersist(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Assign a starting system to a bot.
   * Only assigns if the bot doesn't already have an assignment.
   */
  assignStartingSystem(botName: string, systemId: string, systemName: string): boolean {
    const data = this.ensureLoaded();
    const existing = data.bots[botName];
    
    if (existing) {
      // Bot already has an assignment - don't override
      return false;
    }

    const assignment: ExplorerAssignment = {
      botName,
      startingSystem: systemId,
      startingSystemName: systemName,
      assignedAt: nowIso(),
      completedSystems: [],
      lastUpdated: nowIso(),
    };

    data.bots[botName] = assignment;
    this.dirty = true;
    return true;
  }

  /**
   * Record a system as completed by a bot.
   */
  recordCompletedSystem(botName: string, systemId: string): void {
    const data = this.ensureLoaded();
    const assignment = data.bots[botName];
    
    if (!assignment) {
      // No assignment yet - create one with this as starting system
      const newAssignment: ExplorerAssignment = {
        botName,
        startingSystem: systemId,
        startingSystemName: systemId,
        assignedAt: nowIso(),
        completedSystems: [systemId],
        lastUpdated: nowIso(),
      };
      data.bots[botName] = newAssignment;
    } else {
      // Add to completed systems if not already there
      if (!assignment.completedSystems.includes(systemId)) {
        assignment.completedSystems.push(systemId);
      }
      assignment.lastUpdated = nowIso();
    }
    
    this.dirty = true;
  }

  /**
   * Get the assignment for a specific bot.
   */
  getAssignment(botName: string): ExplorerAssignment | null {
    const data = this.ensureLoaded();
    return data.bots[botName] || null;
  }

  /**
   * Get all assignments.
   */
  getAllAssignments(): ExplorerAssignment[] {
    const data = this.ensureLoaded();
    return Object.values(data.bots);
  }

  /**
   * Get all starting systems currently assigned.
   */
  getAllStartingSystems(): string[] {
    const data = this.ensureLoaded();
    return Object.values(data.bots).map(a => a.startingSystem.toLowerCase());
  }

  /**
   * Get all completed systems across all bots.
   */
  getAllCompletedSystems(): string[] {
    const data = this.ensureLoaded();
    const completed = new Set<string>();
    for (const assignment of Object.values(data.bots)) {
      for (const sys of assignment.completedSystems) {
        completed.add(sys.toLowerCase());
      }
    }
    return [...completed];
  }

  /**
   * Get completed systems for a specific bot.
   */
  getCompletedSystems(botName: string): string[] {
    const data = this.ensureLoaded();
    return data.bots[botName]?.completedSystems || [];
  }

  /**
   * Check if a bot has an assignment.
   */
  hasAssignment(botName: string): boolean {
    const data = this.ensureLoaded();
    return !!data.bots[botName];
  }

  /**
   * Find the best starting system for a new bot - one that's farthest from other bots' starting systems.
   * Returns null if no good starting system can be determined.
   */
  findDistantStartingSystem(
    ctx: { bot: { system: string } },
    mapStore: { getSystems: () => Array<{ id: string; name: string; connections: Array<{ system_id: string }> }> },
    blacklist: string[],
    fledFromSystems: Set<string>
  ): { id: string; name: string } | null {
    const currentSystem = ctx.bot.system;
    if (!currentSystem) return null;

    const otherStartingSystems = this.getAllStartingSystems();
    
    // If no other bots have starting systems, just use current system
    if (otherStartingSystems.length === 0) {
      const current = mapStore.getSystems().find(s => s.id.toLowerCase() === currentSystem.toLowerCase());
      if (current) return { id: current.id, name: current.name || current.id };
      return null;
    }

    // BFS from current system to find all reachable systems with distances
    const visited = new Set<string>();
    const queue: Array<{ systemId: string; distance: number }> = [
      { systemId: currentSystem, distance: 0 }
    ];
    visited.add(currentSystem.toLowerCase());

    const reachable: Array<{ id: string; name: string; distance: number }> = [];

    while (queue.length > 0) {
      const { systemId, distance } = queue.shift()!;
      const sys = mapStore.getSystems().find(s => s.id.toLowerCase() === systemId.toLowerCase());
      if (!sys) continue;

      // Check if this system is a good candidate (not blacklisted, not fled from)
      const isBlacklisted = blacklist.some(b => b.toLowerCase() === systemId.toLowerCase());
      const hasFledFrom = fledFromSystems.has(systemId.toLowerCase());
      
      if (!isBlacklisted && !hasFledFrom) {
        reachable.push({
          id: sys.id,
          name: sys.name || sys.id,
          distance,
        });
      }

      for (const conn of sys.connections) {
        const connId = conn.system_id;
        if (!connId) continue;
        const connLower = connId.toLowerCase();
        if (visited.has(connLower)) continue;
        visited.add(connLower);
        queue.push({ systemId: connId, distance: distance + 1 });
      }
    }

    if (reachable.length === 0) return null;

    // Sort by distance from current (farther = better for spreading out)
    reachable.sort((a, b) => b.distance - a.distance);

    // Pick one of the top 3 farthest systems (add some randomness)
    const topCount = Math.min(3, reachable.length);
    const idx = Math.floor(Math.random() * topCount);
    return { id: reachable[idx].id, name: reachable[idx].name };
  }

  /**
   * Clear a bot's assignment (e.g., when mode changes).
   */
  clearAssignment(botName: string): void {
    const data = this.ensureLoaded();
    if (data.bots[botName]) {
      delete data.bots[botName];
      this.dirty = true;
    }
  }

  private serialize(): string {
    const data = this.ensureLoaded();
    data.lastSaved = nowIso();
    return JSON.stringify(data, null, 2) + "\n";
  }

  async flush(): Promise<boolean> {
    if (!this.dirty || this.writing) return false;
    this.writing = true;
    this.dirty = false;
    try {
      const text = this.serialize();
      ensureDataDir();
      const payload = Buffer.byteLength(text, "utf-8");
      safeWriteFileSync(EXPLORER_ASSIGNMENTS_FILE, text, payload);
      return true;
    } catch (err) {
      this.dirty = true;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ExplorerAssignment] Save failed: ${msg}`);
      return false;
    } finally {
      this.writing = false;
    }
  }

  flushSync(): boolean {
    if (!this.dirty) return false;
    const text = this.serialize();
    try {
      ensureDataDir();
      const payload = Buffer.byteLength(text, "utf-8");
      safeWriteFileSync(EXPLORER_ASSIGNMENTS_FILE, text, payload);
      this.dirty = false;
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ExplorerAssignment] Save failed: ${msg}`);
      return false;
    }
  }
}

export const explorerAssignmentStore = new ExplorerAssignmentStore();

/** Flush explorer assignments to disk right now (shutdown hook). */
export function flushExplorerAssignmentsSync(): boolean {
  return explorerAssignmentStore.flushSync();
}

// Safety net for exits that bypassed the graceful shutdown path.
process.on("exit", () => {
  try {
    explorerAssignmentStore.flushSync();
  } catch {
    // nothing useful to do while exiting
  }
});