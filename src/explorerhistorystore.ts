/**
 * Shared, write-throttled store for `data/explorerHistory.json`.
 *
 * Tracks the last 100 systems each bot has explored, with timestamps.
 * Other bots use this to avoid systems that were recently checked,
 * spreading exploration effort across the full galaxy.
 *
 * The parsed file is kept in memory ONCE. Updates only mutate memory
 * and mark the store dirty. One timer persists it every PERSIST_INTERVAL_MS
 * (plus on shutdown) instead of rewriting the file per visit.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "fs";
import { join } from "path";
import { safeWriteFileSync } from "./diskSpaceGuard.js";

const DATA_DIR = join(process.cwd(), "data");
const EXPLORER_HISTORY_FILE = join(DATA_DIR, "explorerHistory.json");

/** How often the in-memory explorer history is written to disk. */
const PERSIST_INTERVAL_MS = 60_000;

export interface ExplorerVisitRecord {
  systemId: string;
  visitedAt: string;
}

export interface ExplorerHistoryData {
  lastSaved: string;
  bots: Record<string, ExplorerVisitRecord[]>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

const MAX_VISITS_PER_BOT = 100;

class ExplorerHistoryStore {
  private data: ExplorerHistoryData | null = null;
  private dirty = false;
  private writing = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  private ensureLoaded(): ExplorerHistoryData {
    if (this.data) return this.data;
    ensureDataDir();
    let loaded: ExplorerHistoryData = { lastSaved: nowIso(), bots: {} };
    if (existsSync(EXPLORER_HISTORY_FILE)) {
      try {
        const raw = readFileSync(EXPLORER_HISTORY_FILE, "utf-8");
        const parsed = JSON.parse(raw) as ExplorerHistoryData;
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

  recordVisit(botName: string, systemId: string): void {
    const data = this.ensureLoaded();
    const botHistory = data.bots[botName] || [];

    botHistory.push({
      systemId,
      visitedAt: nowIso(),
    });

    if (botHistory.length > MAX_VISITS_PER_BOT) {
      data.bots[botName] = botHistory.slice(botHistory.length - MAX_VISITS_PER_BOT);
    } else {
      data.bots[botName] = botHistory;
    }

    this.dirty = true;
  }

  getBotHistory(botName: string): ExplorerVisitRecord[] {
    const data = this.ensureLoaded();
    return data.bots[botName] || [];
  }

  getLastVisitTime(systemId: string): number | null {
    const data = this.ensureLoaded();
    let latest: number | null = null;

    for (const history of Object.values(data.bots)) {
      for (const record of history) {
        if (record.systemId.toLowerCase() === systemId.toLowerCase()) {
          const ts = new Date(record.visitedAt).getTime();
          if (latest === null || ts > latest) {
            latest = ts;
          }
        }
      }
    }

    return latest;
  }

  getRecentSystemIds(timeoutMs: number): string[] {
    const data = this.ensureLoaded();
    const now = Date.now();
    const recent = new Set<string>();

    for (const history of Object.values(data.bots)) {
      for (const record of history) {
        const visitedAt = new Date(record.visitedAt).getTime();
        if (now - visitedAt <= timeoutMs) {
          recent.add(record.systemId.toLowerCase());
        }
      }
    }

    return [...recent];
  }

  getData(): ExplorerHistoryData {
    return this.ensureLoaded();
  }

  hasPendingWrites(): boolean {
    return this.dirty;
  }

  private serialize(): string {
    const data = this.ensureLoaded();
    data.lastSaved = nowIso();
    return JSON.stringify(data) + "\n";
  }

  async flush(): Promise<boolean> {
    if (!this.dirty || this.writing) return false;
    this.writing = true;
    this.dirty = false;
    try {
      const text = this.serialize();
      ensureDataDir();
      const payload = Buffer.byteLength(text, "utf-8");
      safeWriteFileSync(EXPLORER_HISTORY_FILE, text, payload);
      return true;
    } catch (err) {
      this.dirty = true;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ExplorerHistory] Save failed: ${msg}`);
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
      safeWriteFileSync(EXPLORER_HISTORY_FILE, text, payload);
      this.dirty = false;
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ExplorerHistory] Save failed: ${msg}`);
      return false;
    }
  }
}

export const explorerHistoryStore = new ExplorerHistoryStore();

/** Flush explorer history to disk right now (shutdown hook). */
export function flushExplorerHistorySync(): boolean {
  return explorerHistoryStore.flushSync();
}

// Safety net for exits that bypassed the graceful shutdown path.
process.on("exit", () => {
  try {
    explorerHistoryStore.flushSync();
  } catch {
    // nothing useful to do while exiting
  }
});
