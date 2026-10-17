/**
 * Shared, write-throttled store for `data/explorerFixedPaths.json`.
 *
 * Tracks each fixed_route explorer bot's pre-determined route through all
 * known systems, plus the current route index so progress survives
 * crashes, restarts, and start/stop cycles.
 *
 * The parsed file is kept in memory. Updates mutate memory and mark the
 * store dirty. A timer persists it every PERSIST_INTERVAL_MS (plus on
 * shutdown) instead of rewriting the file per mutation. Callers that need
 * crash-survival (index advance, block, complete, regenerate) should call
 * flushSync() directly.
 */

import { existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { safeWriteFileSync } from "./diskSpaceGuard.js";

const DATA_DIR = join(process.cwd(), "data");
const EXPLORER_FIXED_PATHS_FILE = join(DATA_DIR, "explorerFixedPaths.json");

/** How often the in-memory fixed paths are written to disk. */
const PERSIST_INTERVAL_MS = 5_000;

export interface FixedPathRouteEntry {
  order: number;
  systemId: string;
  systemName: string;
  lastExploredAt: string | null;
  blockedCount: number;
}

export interface ExplorerFixedPath {
  botName: string;
  routeId: string;
  createdAt: string;
  updatedAt: string;
  status: "active" | "paused" | "disabled";
  cloakAvailable: boolean;
  homeSystem: string;
  currentIndex: number;
  route: FixedPathRouteEntry[];
}

export interface ExplorerFixedPathsData {
  version: number;
  lastSaved: string;
  bots: Record<string, ExplorerFixedPath>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function generateRouteId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

class ExplorerFixedPathStore {
  private data: ExplorerFixedPathsData | null = null;
  private dirty = false;
  private writing = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  private ensureLoaded(): ExplorerFixedPathsData {
    if (this.data) return this.data;
    ensureDataDir();
    let loaded: ExplorerFixedPathsData = {
      version: 1,
      lastSaved: nowIso(),
      bots: {},
    };
    if (existsSync(EXPLORER_FIXED_PATHS_FILE)) {
      try {
        const raw = readFileSync(EXPLORER_FIXED_PATHS_FILE, "utf-8");
        const parsed = JSON.parse(raw) as ExplorerFixedPathsData;
        if (parsed && typeof parsed.bots === "object") loaded = parsed;
      } catch {
        // Corrupt file — start fresh rather than losing every future write.
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
   * Get the fixed path entry for a specific bot.
   */
  getFixedPath(botName: string): ExplorerFixedPath | null {
    const data = this.ensureLoaded();
    return data.bots[botName] || null;
  }

  /**
   * Get all fixed path entries.
   */
  getAllFixedPaths(): ExplorerFixedPath[] {
    const data = this.ensureLoaded();
    return Object.values(data.bots);
  }

  /**
   * Upsert a bot's fixed path entry. Marks the store dirty.
   */
  upsertFixedPath(entry: ExplorerFixedPath): void {
    const data = this.ensureLoaded();
    const existing = data.bots[entry.botName];
    const now = nowIso();
    data.bots[entry.botName] = {
      ...entry,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.dirty = true;
  }

  /**
   * Set just the currentIndex for a bot (called on every route-state mutation
   * that survives crashes). Callers may additionally call flushSync().
   */
  setCurrentIndex(botName: string, currentIndex: number): void {
    const data = this.ensureLoaded();
    const entry = data.bots[botName];
    if (entry) {
      entry.currentIndex = currentIndex;
      entry.updatedAt = nowIso();
      this.dirty = true;
    }
  }

  /**
   * Mark a single route entry as explored at the given timestamp.
   */
  markEntryExplored(botName: string, order: number, lastExploredAt: string): void {
    const data = this.ensureLoaded();
    const entry = data.bots[botName];
    if (entry) {
      const routeEntry = entry.route.find((e) => e.order === order);
      if (routeEntry) {
        routeEntry.lastExploredAt = lastExploredAt;
        entry.updatedAt = nowIso();
        this.dirty = true;
      }
    }
  }

  /**
   * Increment the blockedCount for a single route entry.
   */
  incrementBlockedCount(botName: string, order: number): void {
    const data = this.ensureLoaded();
    const entry = data.bots[botName];
    if (entry) {
      const routeEntry = entry.route.find((e) => e.order === order);
      if (routeEntry) {
        routeEntry.blockedCount += 1;
        entry.updatedAt = nowIso();
        this.dirty = true;
      }
    }
  }

  /**
   * Remove a bot's fixed path entry (e.g. when mode changes away from fixed_route).
   */
  removeFixedPath(botName: string): void {
    const data = this.ensureLoaded();
    if (data.bots[botName]) {
      delete data.bots[botName];
      this.dirty = true;
    }
  }

  /**
   * Replace a bot's entire route (used on regeneration). Callers should call
   * flushSync() afterwards if crash-survival is required.
   */
  setRoute(botName: string, route: FixedPathRouteEntry[], homeSystem: string, cloakAvailable: boolean): void {
    const data = this.ensureLoaded();
    const existing = data.bots[botName];
    const now = nowIso();
    data.bots[botName] = {
      botName,
      routeId: existing?.routeId ?? generateRouteId(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      status: "active",
      cloakAvailable,
      homeSystem,
      currentIndex: 0,
      route,
    };
    this.dirty = true;
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
      safeWriteFileSync(EXPLORER_FIXED_PATHS_FILE, text, payload);
      return true;
    } catch (err) {
      this.dirty = true;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ExplorerFixedPath] Save failed: ${msg}`);
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
      safeWriteFileSync(EXPLORER_FIXED_PATHS_FILE, text, payload);
      this.dirty = false;
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ExplorerFixedPath] Save failed: ${msg}`);
      return false;
    }
  }

  hasPendingWrites(): boolean {
    return this.dirty;
  }
}

export const explorerFixedPathStore = new ExplorerFixedPathStore();

/** Flush explorer fixed paths to disk right now (shutdown hook). */
export function flushExplorerFixedPathsSync(): boolean {
  return explorerFixedPathStore.flushSync();
}

// Safety net for exits that bypassed the graceful shutdown path.
process.on("exit", () => {
  try {
    explorerFixedPathStore.flushSync();
  } catch {
    // nothing useful to do while exiting
  }
});
