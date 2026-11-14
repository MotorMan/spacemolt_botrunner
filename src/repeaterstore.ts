import { debugLogForBot } from "./debug.js";
import { writeFileSync, existsSync, readFileSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { writeFile, unlink } from "fs/promises";
import { join } from "path";
import { onWildlifeUpdate, isSyncPushEnabled } from "./client_sync_hooks.js";
import { safeWriteFileSync } from "./diskSpaceGuard.js";
import { perf } from "./perf.js";

const REPEATERS_DIR = join(process.cwd(), "data", "repeaters");

/**
 * How often dirty systems are written to disk.
 */
const FLUSH_INTERVAL_MS = 120_000;
/** Systems untouched for this long are flushed and dropped from the hot cache. */
const EVICT_IDLE_MS = 120_000;
/**
 * Grace period before a repeater type that was NOT seen in a reconcile scan is
 * pruned. Several bots can sit in the same POI and scan at slightly different
 * moments; without a grace window one bot's scan would delete what another bot
 * saw a second earlier.
 */
const VISIT_GAP_MS = 45_000;
/** At most one repeater sync push per system per this interval. */
const PUSH_INTERVAL_MS = 5_000;

export interface RepeaterEntry {
  n: string;      // lowercase name
  h: number;      // maxHull
  c: string;      // ship_class
  ids: string[];  // unique repeaterIds found
  seen: string;   // lastSeen ISO
  b: boolean;     // in_battle
}

export interface SystemRepeaters {
  system: string;
  lastUpdated: string;
  pois: Record<string, RepeaterEntry[]>;
}

export interface RepeaterDetail {
  name: string;
  shipClass: string;
  maxHull: number;
  count: number;
  ids: string[];
  system: string;
  poi: string;
  lastSeen: string;
  inBattle: boolean;
}

export interface RepeaterCounts {
  systems: number;
  pois: number;
  repeaters: number;
  individuals: number;
}

export interface RepeaterFullData {
  systems: Record<string, SystemRepeaters>;
  lastUpdated: string;
  counts: RepeaterCounts;
}

export interface ObservedRepeater {
  name: string;
  repeaterId: string;
  shipClass: string;
  hull: number;
  maxHull: number;
  shield: number;
  maxShield: number;
  inBattle: boolean;
}

export interface ReconcileResult {
  newTypes: number;
  prunedIds: number;
  prunedTypes: number;
}

interface CacheEntry {
  sys: SystemRepeaters;
  dirty: boolean;
  pushPending: boolean;
  lastAccess: number;
  lastPush: number;
}

function sanitizeSystemName(system: string): string {
  const cleaned = (system || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
  return cleaned || "unknown";
}

export class RepeaterStore {
  private cache: Map<string, CacheEntry> = new Map();
  private _botName: string | null = null;
  private nameIndex: Set<string> = new Set();
  private nameIndexBuilt = false;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private pushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  constructor() {
    this.startTimers();
  }

  private startTimers(): void {
    if (this.flushTimer || this.pushTimer) return;
    this.flushTimer = setInterval(() => {
      void this.flush().then(() => this.evictCold());
    }, FLUSH_INTERVAL_MS);
    this.pushTimer = setInterval(() => this.drainPushes(), PUSH_INTERVAL_MS);
    (this.flushTimer as unknown as { unref?: () => void }).unref?.();
    (this.pushTimer as unknown as { unref?: () => void }).unref?.();
  }

  stopTimers(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.pushTimer) clearInterval(this.pushTimer);
    this.flushTimer = null;
    this.pushTimer = null;
  }

  private ensureDir(): void {
    if (!existsSync(REPEATERS_DIR)) {
      mkdirSync(REPEATERS_DIR, { recursive: true });
    }
  }

  private blankSystem(system: string): SystemRepeaters {
    return { system: sanitizeSystemName(system), lastUpdated: new Date().toISOString(), pois: {} };
  }

  private systemFilePath(system: string): string {
    return join(REPEATERS_DIR, `${sanitizeSystemName(system)}.json`);
  }

  private listSystemKeys(): string[] {
    try {
      return readdirSync(REPEATERS_DIR)
        .filter((f) => f.endsWith(".json") && !f.startsWith("_"))
        .map((f) => f.slice(0, -".json".length));
    } catch {
      return [];
    }
  }

  private readSystem(system: string): SystemRepeaters | null {
    const path = this.systemFilePath(system);
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as SystemRepeaters;
      if (!parsed.pois) parsed.pois = {};
      if (!parsed.system) parsed.system = sanitizeSystemName(system);
      return parsed;
    } catch {
      return null;
    }
  }

  private loadEntry(system: string): CacheEntry {
    const key = sanitizeSystemName(system);
    let entry = this.cache.get(key);
    if (!entry) {
      const sys = this.readSystem(key) ?? this.blankSystem(key);
      entry = { sys, dirty: false, pushPending: false, lastAccess: Date.now(), lastPush: 0 };
      this.cache.set(key, entry);
      this.indexSystemNames(sys);
    } else {
      entry.lastAccess = Date.now();
    }
    return entry;
  }

  private loadSystem(system: string): SystemRepeaters {
    return this.loadEntry(system).sys;
  }

  private markChanged(entry: CacheEntry, stamp: string): void {
    entry.sys.lastUpdated = stamp;
    entry.dirty = true;
    entry.pushPending = true;
    entry.lastAccess = Date.now();
  }

  private writeSystemFileSync(sys: SystemRepeaters): void {
    this.ensureDir();
    const payload = JSON.stringify(sys) + "\n";
    safeWriteFileSync(this.systemFilePath(sys.system), payload, Buffer.byteLength(payload, "utf-8"));
  }

  setBotName(name: string): void {
    this._botName = name;
  }

  private normalize(name: string): string {
    if (!name) return "";
    let cleaned = name.trim().toLowerCase();
    cleaned = cleaned.replace(/^\[[^\]]+\]\s*/g, "").trim();
    cleaned = cleaned.replace(/\s+/g, " ").trim();
    return cleaned;
  }

  private indexSystemNames(sys: SystemRepeaters): void {
    for (const list of Object.values(sys.pois)) {
      for (const e of list) if (e.n) this.nameIndex.add(e.n);
    }
  }

  private ensureNameIndex(): void {
    if (this.nameIndexBuilt) return;
    this.nameIndexBuilt = true;
    for (const key of this.listSystemKeys()) {
      const cached = this.cache.get(key);
      const sys = cached?.sys ?? this.readSystem(key);
      if (sys) this.indexSystemNames(sys);
    }
  }

  hasRepeaterName(name: string | undefined): boolean {
    if (!name) return false;
    const normalized = this.normalize(name);
    if (!normalized) return false;
    if (this.nameIndex.has(normalized)) return true;
    this.ensureNameIndex();
    return this.nameIndex.has(normalized);
  }

  add(
    name: string,
    system: string,
    poi: string,
    repeaterId: string,
    shipClass: string,
    hull: number,
    maxHull: number,
    inBattle: boolean
  ): boolean {
    if (!name || typeof name !== "string") return false;
    const normalized = this.normalize(name);
    if (!normalized) return false;
    if (!system) system = "unknown";
    if (!poi) poi = "unknown";

    return perf.timeSync("repeaterstore.add", () => {
      const entry = this.loadEntry(system);
      const sys = entry.sys;
      const list = (sys.pois[poi] = sys.pois[poi] || []);

      const now = new Date().toISOString();
      const existing = list.find((e) => e.n === normalized && e.h === maxHull);

      let newType = false;
      if (existing) {
        if (repeaterId && !existing.ids.includes(repeaterId)) {
          existing.ids.push(repeaterId);
        }
        existing.seen = now;
        if (shipClass) existing.c = shipClass;
        existing.b = inBattle;
      } else {
        list.push({
          n: normalized,
          h: maxHull || 0,
          c: shipClass || "",
          ids: repeaterId ? [repeaterId] : [],
          seen: now,
          b: inBattle,
        });
        newType = true;
      }
      this.nameIndex.add(normalized);
      this.markChanged(entry, now);

      if (newType) {
        debugLogForBot(this._botName || "unknown", "repeater:add", `${this._botName || "unknown"}`, `Added repeater: "${name}" (${shipClass}) in ${system}/${poi}`);
      }
      return newType;
    });
  }

  reconcile(system: string, poi: string, observed: ObservedRepeater[]): ReconcileResult {
    if (!system) system = "unknown";
    if (!poi) poi = "unknown";

    return perf.timeSync("repeaterstore.reconcile", () => {
      const result: ReconcileResult = { newTypes: 0, prunedIds: 0, prunedTypes: 0 };
      const entry = this.loadEntry(system);
      const sys = entry.sys;
      const nowMs = Date.now();
      const now = new Date(nowMs).toISOString();

      const present = new Map<string, { n: string; h: number; c: string; b: boolean; ids: Set<string> }>();
      for (const o of observed) {
        const n = this.normalize(o.name || "");
        if (!n) continue;
        const h = o.maxHull || 0;
        const key = `${n}\u0000${h}`;
        let group = present.get(key);
        if (!group) {
          group = { n, h, c: o.shipClass || "", b: o.inBattle, ids: new Set<string>() };
          present.set(key, group);
        }
        if (o.shipClass) group.c = o.shipClass;
        group.b = o.inBattle;
        if (o.repeaterId) group.ids.add(o.repeaterId);
      }

      const list = sys.pois[poi] || [];
      const kept: RepeaterEntry[] = [];
      for (const e of list) {
        const key = `${e.n}\u0000${e.h}`;
        const group = present.get(key);
        if (group) {
          if (group.ids.size > 0) {
            for (const id of e.ids) if (!group.ids.has(id)) result.prunedIds++;
            e.ids = [...group.ids];
          }
          e.seen = now;
          if (group.c) e.c = group.c;
          e.b = group.b;
          present.delete(key);
          kept.push(e);
          continue;
        }
        const seenMs = Date.parse(e.seen);
        const stale = !Number.isFinite(seenMs) || nowMs - seenMs > VISIT_GAP_MS;
        if (stale) {
          result.prunedTypes++;
          result.prunedIds += e.ids.length;
        } else {
          kept.push(e);
        }
      }

      for (const group of present.values()) {
        kept.push({
          n: group.n,
          h: group.h,
          c: group.c,
          ids: [...group.ids],
          seen: now,
          b: group.b,
        });
        this.nameIndex.add(group.n);
        result.newTypes++;
        debugLogForBot(this._botName || "unknown", "repeater:add", `${this._botName || "unknown"}`, `Added repeater: "${group.n}" (${group.c}) in ${system}/${poi}`);
      }

      if (kept.length > 0) {
        sys.pois[poi] = kept;
      } else {
        delete sys.pois[poi];
      }

      const changed =
        result.newTypes > 0 ||
        result.prunedIds > 0 ||
        result.prunedTypes > 0 ||
        kept.length > 0;
      if (changed) this.markChanged(entry, now);
      return result;
    });
  }

  private *iterateSystems(): Generator<SystemRepeaters> {
    const seen = new Set<string>();
    for (const [key, entry] of this.cache) {
      seen.add(key);
      yield entry.sys;
    }
    for (const key of this.listSystemKeys()) {
      if (seen.has(key)) continue;
      const sys = this.readSystem(key);
      if (sys) yield sys;
    }
  }

  private *iterateEntries(): Generator<{ system: string; poi: string; entry: RepeaterEntry }> {
    for (const sys of this.iterateSystems()) {
      for (const [poi, list] of Object.entries(sys.pois)) {
        for (const entry of list) {
          yield { system: sys.system, poi, entry };
        }
      }
    }
  }

  private toDetail(system: string, poi: string, entry: RepeaterEntry): RepeaterDetail {
    return {
      name: entry.n,
      shipClass: entry.c,
      maxHull: entry.h,
      count: entry.ids.length,
      ids: entry.ids,
      system,
      poi,
      lastSeen: entry.seen,
      inBattle: entry.b,
    };
  }

  getAll(): RepeaterDetail[] {
    const out: RepeaterDetail[] = [];
    for (const { system, poi, entry } of this.iterateEntries()) {
      out.push(this.toDetail(system, poi, entry));
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  getRepeaterDetail(name: string): RepeaterDetail | null {
    const normalized = this.normalize(name);
    if (!this.hasRepeaterName(normalized)) return null;
    let best: RepeaterDetail | null = null;
    for (const { system, poi, entry } of this.iterateEntries()) {
      if (entry.n === normalized) {
        const d = this.toDetail(system, poi, entry);
        if (!best || d.lastSeen > best.lastSeen) best = d;
      }
    }
    return best;
  }

  search(query: string): RepeaterDetail[] {
    const queryLower = query.toLowerCase().trim();
    if (!queryLower) return [];
    const out: RepeaterDetail[] = [];
    for (const { system, poi, entry } of this.iterateEntries()) {
      if (entry.n.includes(queryLower)) {
        out.push(this.toDetail(system, poi, entry));
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  private countSystem(sys: SystemRepeaters, counts: RepeaterCounts): void {
    counts.systems++;
    for (const list of Object.values(sys.pois)) {
      if (list.length > 0) counts.pois++;
      for (const e of list) {
        counts.repeaters++;
        counts.individuals += e.ids.length;
      }
    }
  }

  getCounts(): RepeaterCounts {
    const counts: RepeaterCounts = {
      systems: 0, pois: 0, repeaters: 0, individuals: 0,
    };
    for (const sys of this.iterateSystems()) this.countSystem(sys, counts);
    return counts;
  }

  getFullData(): RepeaterFullData {
    const systems: Record<string, SystemRepeaters> = {};
    const counts: RepeaterCounts = {
      systems: 0, pois: 0, repeaters: 0, individuals: 0,
    };
    let lastUpdated = "";
    for (const sys of this.iterateSystems()) {
      systems[sys.system] = sys;
      if (sys.lastUpdated > lastUpdated) lastUpdated = sys.lastUpdated;
      this.countSystem(sys, counts);
    }
    return { systems, lastUpdated, counts };
  }

  getSystemData(system: string): SystemRepeaters {
    return this.loadSystem(system);
  }

  mergeFrom(data: RepeaterFullData): void {
    if (!data || !data.systems) return;
    for (const sys of Object.values(data.systems)) {
      if (!sys || !sys.system) continue;
      const key = sanitizeSystemName(sys.system);
      const target = this.loadEntry(key);
      let changed = false;

      for (const [poi, list] of Object.entries(sys.pois || {})) {
        if (!list || list.length === 0) continue;
        const tlist = (target.sys.pois[poi] = target.sys.pois[poi] || []);
        for (const entry of list) {
          if (!entry || !entry.n) continue;
          const existing = tlist.find((e) => e.n === entry.n && e.h === entry.h);
          if (existing) {
            if (entry.seen && entry.seen > existing.seen) {
              existing.seen = entry.seen;
              if (entry.c) existing.c = entry.c;
              existing.b = entry.b;
            }
            changed = true;
          } else {
            tlist.push({
              n: entry.n,
              h: entry.h || 0,
              c: entry.c || "",
              ids: [],
              seen: entry.seen || new Date().toISOString(),
              b: entry.b,
            });
            changed = true;
          }
          this.nameIndex.add(entry.n);
        }
      }

      if (changed) {
        target.sys.lastUpdated = new Date().toISOString();
        target.dirty = true;
        target.lastAccess = Date.now();
      }
    }
  }

  importAll(data: RepeaterFullData): void {
    this.mergeFrom(data);
  }

  getCacheSize(): number {
    return this.cache.size;
  }

  async flush(): Promise<number> {
    if (this.flushing) return 0;
    this.flushing = true;
    let written = 0;
    try {
      this.ensureDir();
      for (const [key, entry] of this.cache) {
        if (!entry.dirty) continue;
        entry.dirty = false;
        const empty = Object.keys(entry.sys.pois).length === 0;
        const path = this.systemFilePath(key);
        try {
          if (empty) {
            if (existsSync(path)) await unlink(path);
          } else {
            await writeFile(path, JSON.stringify(entry.sys) + "\n", "utf-8");
          }
          written++;
        } catch (err) {
          entry.dirty = true;
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[RepeaterStore] Failed to write ${key}.json: ${msg}`);
        }
      }
    } finally {
      this.flushing = false;
    }
    return written;
  }

  flushSync(): number {
    let written = 0;
    this.ensureDir();
    for (const [key, entry] of this.cache) {
      if (!entry.dirty) continue;
      entry.dirty = false;
      try {
        const path = this.systemFilePath(key);
        if (Object.keys(entry.sys.pois).length === 0) {
          if (existsSync(path)) unlinkSync(path);
        } else {
          const payload = JSON.stringify(entry.sys) + "\n";
          safeWriteFileSync(path, payload, Buffer.byteLength(payload, "utf-8"));
        }
        written++;
      } catch (err) {
        entry.dirty = true;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[RepeaterStore] Failed to write ${key}.json: ${msg}`);
      }
    }
    return written;
  }

  private evictCold(): number {
    const cutoff = Date.now() - EVICT_IDLE_MS;
    let evicted = 0;
    for (const [key, entry] of this.cache) {
      if (entry.dirty || entry.pushPending) continue;
      if (entry.lastAccess > cutoff) continue;
      this.cache.delete(key);
      evicted++;
    }
    return evicted;
  }

  private drainPushes(): void {
    if (!isSyncPushEnabled()) {
      for (const entry of this.cache.values()) entry.pushPending = false;
      return;
    }
    const now = Date.now();
    for (const entry of this.cache.values()) {
      if (!entry.pushPending) continue;
      if (now - entry.lastPush < PUSH_INTERVAL_MS) continue;
      entry.pushPending = false;
      entry.lastPush = now;
      void onWildlifeUpdate({ system: entry.sys.system, data: entry.sys });
    }
  }
}

export const repeaterStore = new RepeaterStore();

process.on("exit", () => {
  try {
    repeaterStore.flushSync();
  } catch {
  }
});