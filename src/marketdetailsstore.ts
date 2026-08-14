/**
 * Shared, write-throttled store for `data/marketDetails.json`.
 *
 * Two producers write this file: the `market` routine (a bot parked at a
 * station, receiving a push for every order-book change) and the `explorer`
 * routine (view_market at each station it visits). Both used to do a full
 * read + parse + rewrite of the whole ~10MB file per update — the market
 * routine did it ~17 times a minute, which was the dominant stall on a market
 * client.
 *
 * Now both go through this module:
 *   - the parsed file is kept in memory ONCE, with an index for O(1) upserts
 *     (the old code did a linear `findIndex` over every entry, per item),
 *   - updates only mutate memory and mark the store dirty,
 *   - one timer persists it every PERSIST_INTERVAL_MS (plus on shutdown).
 *
 * Readers are unaffected: routines in this process see fresh prices through the
 * in-memory overlay in `market_local_source.ts`, and `marketDetails.json`
 * remains the durable, cross-process copy — just written on a sane cadence.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { rename, writeFile } from "fs/promises";
import { join } from "path";
import { perf } from "./perf.js";

const DATA_DIR = join(process.cwd(), "data");
const MARKET_DETAILS_FILE = join(DATA_DIR, "marketDetails.json");
const MARKET_DETAILS_TMP = join(DATA_DIR, "marketDetails.json.tmp");

/** How often the in-memory market details are written to disk. */
const PERSIST_INTERVAL_MS = 120_000;

export interface MarketOrderDetail {
  price: number;
  quantity: number;
}

export interface MarketItemDetails {
  systemId: string;
  stationPoiId: string;
  stationName: string;
  itemId: string;
  itemName: string;
  buyOrders: MarketOrderDetail[];
  sellOrders: MarketOrderDetail[];
  lastUpdated: string;
}

export interface MarketDetailsData {
  lastSaved: string;
  items: MarketItemDetails[];
}

/** One item's order book as observed at a station. */
export interface MarketItemObservation {
  itemId: string;
  itemName: string;
  buyOrders: MarketOrderDetail[];
  sellOrders: MarketOrderDetail[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

class MarketDetailsStore {
  private data: MarketDetailsData | null = null;
  /** `systemId\0poiId\0itemId` -> index into `data.items`. */
  private index = new Map<string, number>();
  private dirty = false;
  private writing = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  private key(systemId: string, stationPoiId: string, itemId: string): string {
    return `${systemId}\u0000${stationPoiId}\u0000${itemId}`;
  }

  /** Parse the file once. Subsequent calls are free. */
  private ensureLoaded(): MarketDetailsData {
    if (this.data) return this.data;
    ensureDataDir();
    let loaded: MarketDetailsData = { lastSaved: nowIso(), items: [] };
    if (existsSync(MARKET_DETAILS_FILE)) {
      try {
        const raw = readFileSync(MARKET_DETAILS_FILE, "utf-8");
        const parsed = JSON.parse(raw) as MarketDetailsData;
        if (parsed && Array.isArray(parsed.items)) loaded = parsed;
      } catch {
        // Corrupt file — start fresh rather than losing every future write.
      }
    }
    this.data = loaded;
    this.index.clear();
    for (let i = 0; i < loaded.items.length; i++) {
      const it = loaded.items[i];
      if (!it || !it.itemId) continue;
      this.index.set(this.key(it.systemId, it.stationPoiId, it.itemId), i);
    }
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

  /** Stop the persist timer (tests / shutdown). */
  stopAutoPersist(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Insert or update one station's order books. Memory only — the periodic
   * flush (or `flushSync()` on shutdown) puts it on disk.
   *
   * Returns how many item entries were written.
   */
  upsertItems(
    systemId: string,
    stationPoiId: string,
    stationName: string,
    observations: MarketItemObservation[],
  ): number {
    if (!observations.length) return 0;
    const data = this.ensureLoaded();
    const stamp = nowIso();
    let updated = 0;

    for (const obs of observations) {
      if (!obs.itemId) continue;
      const detail: MarketItemDetails = {
        systemId,
        stationPoiId,
        stationName,
        itemId: obs.itemId,
        itemName: obs.itemName || obs.itemId,
        buyOrders: obs.buyOrders || [],
        sellOrders: obs.sellOrders || [],
        lastUpdated: stamp,
      };
      const key = this.key(systemId, stationPoiId, obs.itemId);
      const existing = this.index.get(key);
      if (existing !== undefined && data.items[existing]) {
        data.items[existing] = detail;
      } else {
        this.index.set(key, data.items.length);
        data.items.push(detail);
      }
      updated++;
    }

    if (updated > 0) this.dirty = true;
    return updated;
  }

  /** The live in-memory market details (loads the file on first call). */
  getData(): MarketDetailsData {
    return this.ensureLoaded();
  }

  /** Number of entries currently held in memory (diagnostics). */
  size(): number {
    return this.data ? this.data.items.length : 0;
  }

  hasPendingWrites(): boolean {
    return this.dirty;
  }

  private serialize(): string {
    const data = this.ensureLoaded();
    data.lastSaved = nowIso();
    // No pretty-print: this file is only ever machine-read and `null, 2` made
    // it ~3x bigger (and ~3x slower to write and re-parse).
    return JSON.stringify(data) + "\n";
  }

  /** Persist if anything changed. Safe to call concurrently. */
  async flush(): Promise<boolean> {
    if (!this.dirty || this.writing) return false;
    this.writing = true;
    this.dirty = false;
    try {
      const text = perf.timeSync("marketdetails.serialize", () => this.serialize());
      ensureDataDir();
      try {
        await writeFile(MARKET_DETAILS_TMP, text, "utf-8");
        await rename(MARKET_DETAILS_TMP, MARKET_DETAILS_FILE);
      } catch {
        // Some filesystems (and antivirus on Windows) can refuse the rename;
        // fall back to writing in place rather than dropping the data.
        await writeFile(MARKET_DETAILS_FILE, text, "utf-8");
      }
      return true;
    } catch (err) {
      this.dirty = true;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[MarketDetails] Save failed: ${msg}`);
      return false;
    } finally {
      this.writing = false;
    }
  }

  /** Blocking persist for shutdown paths. */
  flushSync(): boolean {
    if (!this.dirty) return false;
    try {
      const text = this.serialize();
      ensureDataDir();
      try {
        writeFileSync(MARKET_DETAILS_TMP, text, "utf-8");
        renameSync(MARKET_DETAILS_TMP, MARKET_DETAILS_FILE);
      } catch {
        writeFileSync(MARKET_DETAILS_FILE, text, "utf-8");
      }
      this.dirty = false;
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[MarketDetails] Save failed: ${msg}`);
      return false;
    }
  }
}

export const marketDetailsStore = new MarketDetailsStore();

/** Flush market details to disk right now (shutdown hook). */
export function flushMarketDetailsSync(): boolean {
  return marketDetailsStore.flushSync();
}

// Safety net for exits that bypassed the graceful shutdown path.
process.on("exit", () => {
  try {
    marketDetailsStore.flushSync();
  } catch {
    // nothing useful to do while exiting
  }
});
