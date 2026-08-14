import { debugLogForBot } from "./debug.js";
import { writeFileSync, existsSync, readFileSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { writeFile, unlink } from "fs/promises";
import { join } from "path";
import { onWildlifeUpdate, isSyncPushEnabled } from "./client_sync_hooks.js";
import { perf } from "./perf.js";

const CREATURES_DIR = join(process.cwd(), "data", "creatures");
const LEGACY_WILDLIFE_FILE = join(process.cwd(), "data", "wildlifeInfo.json");

/**
 * How often dirty systems are written to disk. Sightings used to write the
 * whole per-system file synchronously on EVERY creature seen, which was the
 * single biggest CPU cost on a 90+ bot client.
 */
const FLUSH_INTERVAL_MS = 120_000;
/** Systems untouched for this long are flushed and dropped from the hot cache. */
const EVICT_IDLE_MS = 120_000;
/**
 * Grace period before a creature type that was NOT seen in a reconcile scan is
 * pruned. Several bots can sit in the same POI and scan at slightly different
 * moments; without a grace window one bot's scan would delete what another bot
 * saw a second earlier.
 */
const VISIT_GAP_MS = 45_000;
/** At most one wildlife sync push per system per this interval. */
const PUSH_INTERVAL_MS = 5_000;

// Minimal per-creature entry. One entry per (lowercase name + maxHull) within a POI.
// `ids` holds every unique creatureId seen of that type, so its length is the count.
export interface CreatureEntry {
  n: string;      // lowercase name
  h: number;      // maxHull
  s: string;      // species
  r: string;      // role (e.g. "grazer", "boss")
  ids: string[];  // unique creatureIds found
  seen: string;   // lastSeen ISO
}

export interface SystemWildlife {
  system: string;
  lastUpdated: string;
  pois: Record<string, CreatureEntry[]>;
  /** Potential creature data reported by survey_system (species that *could* be present). */
  survey?: SystemSurveyWildlife;
}

/** A species reported by survey_system as potentially present in a system. */
export interface SurveyWildlifeEntry {
  species: string;
  name: string;
  role: string;
  estimate: number;
  abundance: string;
}

/** A faint signature reported by survey_system — a hint about where creatures could be. */
export interface FaintSignature {
  type: string;
  hint: string;
  difficulty?: string;
}

/** Latest survey_system-derived potential-creature snapshot for a system. */
export interface SystemSurveyWildlife {
  lastUpdated: string;
  wildlife: SurveyWildlifeEntry[];
  faintSignatures: FaintSignature[];
}

// Expanded, human-friendly view used by the API / search.
export interface WildlifeDetail {
  name: string;
  species: string;
  role: string;
  maxHull: number;
  count: number;
  ids: string[];
  system: string;
  poi: string;
  lastSeen: string;
}

export interface WildlifeCounts {
  systems: number;
  pois: number;
  creatures: number;
  individuals: number;
  surveySystems: number;
  surveySpecies: number;
}

export interface WildlifeFullData {
  systems: Record<string, SystemWildlife>;
  lastUpdated: string;
  counts: WildlifeCounts;
}

/** One creature as reported by a single `get_nearby` scan. */
export interface ObservedCreature {
  name: string;
  creatureId: string;
  species: string;
  role: string;
  maxHull: number;
}

/** What a reconcile pass changed, for logging. */
export interface ReconcileResult {
  /** Creature types (name+maxHull) never seen in this POI before. */
  newTypes: number;
  /** Individual creatureIds dropped because they were no longer present. */
  prunedIds: number;
  /** Whole entries dropped because none of their creatures are around anymore. */
  prunedTypes: number;
}

/** One hot (recently touched) system held in memory. */
interface CacheEntry {
  sys: SystemWildlife;
  /** Has unsaved data. */
  dirty: boolean;
  /** Has changes that have not been pushed to sync clients yet. */
  pushPending: boolean;
  lastAccess: number;
  lastPush: number;
}

function sanitizeSystemName(system: string): string {
  const cleaned = (system || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
  return cleaned || "unknown";
}

/**
 * Per-system creature store.
 *
 * Hot path (bots scanning): memory only. `add()`/`reconcile()` mutate the
 * in-memory copy of the visited system and mark it dirty; a 2-minute timer
 * writes the dirty systems to disk and evicts the ones nobody touched since.
 *
 * Cold path (creatures page, sync push): reads `data/creatures/*.json` on
 * demand and overlays the hot cache, so a page load still shows every system
 * even though only recently-visited systems live in RAM.
 */
export class WildlifeStore {
  private cache: Map<string, CacheEntry> = new Map();
  private _botName: string | null = null;
  /** Every creature name ever recorded (lowercase). Cheap `isCreatureName`. */
  private nameIndex: Set<string> = new Set();
  private nameIndexBuilt = false;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private pushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  constructor() {
    this.migrateIfNeeded();
    this.startTimers();
  }

  private startTimers(): void {
    if (this.flushTimer || this.pushTimer) return;
    this.flushTimer = setInterval(() => {
      void this.flush().then(() => this.evictCold());
    }, FLUSH_INTERVAL_MS);
    this.pushTimer = setInterval(() => this.drainPushes(), PUSH_INTERVAL_MS);
    // Never keep the process alive just for housekeeping.
    (this.flushTimer as unknown as { unref?: () => void }).unref?.();
    (this.pushTimer as unknown as { unref?: () => void }).unref?.();
  }

  /** Stop the housekeeping timers (tests / shutdown). */
  stopTimers(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.pushTimer) clearInterval(this.pushTimer);
    this.flushTimer = null;
    this.pushTimer = null;
  }

  private ensureDir(): void {
    if (!existsSync(CREATURES_DIR)) {
      mkdirSync(CREATURES_DIR, { recursive: true });
    }
  }

  // One-time migration of the old single-file store (keyed by name, buggy) into
  // the new per-system structure. We can't recover lost locations, but we keep
  // whatever was recorded.
  private migrateIfNeeded(): void {
    this.ensureDir();
    const hasNew = this.listSystemKeys().length > 0;
    if (hasNew || !existsSync(LEGACY_WILDLIFE_FILE)) {
      return;
    }
    try {
      const text = readFileSync(LEGACY_WILDLIFE_FILE, "utf-8");
      const parsed = JSON.parse(text) as { wildlife?: Record<string, Record<string, unknown>> };
      const legacy = parsed.wildlife || {};
      for (const entry of Object.values(legacy)) {
        const system = sanitizeSystemName((entry.system as string) || "unknown");
        const poi = (entry.poi as string) || "unknown";
        const name = (entry.name as string) || "";
        if (!name) continue;
        const normalized = name.trim().toLowerCase();
        const maxHull = (entry.maxHull as number) || (entry.hull as number) || 0;
        const creatureId = (entry.creatureId as string) || "";
        const sys = this.readSystem(system) ?? this.blankSystem(system);
        const list = (sys.pois[poi] = sys.pois[poi] || []);
        const existing = list.find((e) => e.n === normalized && e.h === maxHull);
        if (existing) {
          if (creatureId && !existing.ids.includes(creatureId)) existing.ids.push(creatureId);
        } else {
          list.push({
            n: normalized,
            h: maxHull,
            s: (entry.species as string) || "",
            r: (entry.role as string) || "",
            ids: creatureId ? [creatureId] : [],
            seen: (entry.lastSeen as string) || new Date().toISOString(),
          });
        }
        this.writeSystemFileSync(sys);
      }
      debugLogForBot(this._botName || "unknown", "wildlife:migrate", `${this._botName || "unknown"}`, "Migrated legacy wildlifeInfo.json into per-system files");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[WildlifeStore] Migration failed: ${msg}`);
    }
  }

  private blankSystem(system: string): SystemWildlife {
    return { system: sanitizeSystemName(system), lastUpdated: new Date().toISOString(), pois: {} };
  }

  private systemFilePath(system: string): string {
    return join(CREATURES_DIR, `${sanitizeSystemName(system)}.json`);
  }

  /** Every system that has a file on disk. Names starting with `_` are reserved. */
  private listSystemKeys(): string[] {
    try {
      return readdirSync(CREATURES_DIR)
        .filter((f) => f.endsWith(".json") && !f.startsWith("_"))
        .map((f) => f.slice(0, -".json".length));
    } catch {
      return [];
    }
  }

  private readSystem(system: string): SystemWildlife | null {
    const path = this.systemFilePath(system);
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as SystemWildlife;
      if (!parsed.pois) parsed.pois = {};
      if (!parsed.system) parsed.system = sanitizeSystemName(system);
      return parsed;
    } catch {
      return null;
    }
  }

  /** Hot-cache accessor: loads from disk on first touch, then keeps it in RAM. */
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

  // Returns from cache or disk; never null (cached as blank when missing).
  private loadSystem(system: string): SystemWildlife {
    return this.loadEntry(system).sys;
  }

  private markChanged(entry: CacheEntry, stamp: string): void {
    entry.sys.lastUpdated = stamp;
    entry.dirty = true;
    entry.pushPending = true;
    entry.lastAccess = Date.now();
  }

  private writeSystemFileSync(sys: SystemWildlife): void {
    this.ensureDir();
    // No pretty-print: these files are machine-read only and `null, 2` tripled
    // their size (and the write cost) for nothing.
    writeFileSync(this.systemFilePath(sys.system), JSON.stringify(sys) + "\n", "utf-8");
  }

  setBotName(name: string): void {
    this._botName = name;
  }

  private normalize(name: string): string {
    return name.trim().toLowerCase();
  }

  // ── Name index ──────────────────────────────────────────────────────────
  // `isCreatureName()` is called from the combat path for every battle
  // participant. It used to walk every entry of every system; now it is a Set
  // lookup over a lazily-built index that live sightings keep up to date.

  private indexSystemNames(sys: SystemWildlife): void {
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

  /** Cheap "is this the name of a creature we have ever seen?" check. */
  hasCreatureName(name: string | undefined): boolean {
    if (!name) return false;
    const normalized = this.normalize(name);
    if (!normalized) return false;
    if (this.nameIndex.has(normalized)) return true;
    this.ensureNameIndex();
    return this.nameIndex.has(normalized);
  }

  /**
   * Record a creature sighting. Dedups within a POI by (name + maxHull); if the
   * same type is seen again its creatureId is appended (so `ids.length` == count).
   * Returns true when a brand new type was discovered in that POI.
   *
   * Memory only — the 2-minute flush timer persists it. Use `reconcile()` when
   * you hold the complete creature list for a POI, so dead creatures get pruned.
   */
  add(
    name: string,
    system: string,
    poi: string,
    creatureId: string,
    species: string,
    role: string,
    _hull: number,
    maxHull: number,
    _inCombat: boolean
  ): boolean {
    if (!name || typeof name !== "string") return false;
    const normalized = this.normalize(name);
    if (!normalized) return false;
    if (!system) system = "unknown";
    if (!poi) poi = "unknown";

    return perf.timeSync("wildlivestore.add", () => {
      const entry = this.loadEntry(system);
      const sys = entry.sys;
      const list = (sys.pois[poi] = sys.pois[poi] || []);

      const now = new Date().toISOString();
      const existing = list.find((e) => e.n === normalized && e.h === maxHull);

      let newType = false;
      if (existing) {
        if (creatureId && !existing.ids.includes(creatureId)) {
          existing.ids.push(creatureId);
        }
        existing.seen = now;
        if (species) existing.s = species;
        if (role) existing.r = role;
      } else {
        list.push({
          n: normalized,
          h: maxHull || 0,
          s: species || "",
          r: role || "",
          ids: creatureId ? [creatureId] : [],
          seen: now,
        });
        newType = true;
      }
      this.nameIndex.add(normalized);
      this.markChanged(entry, now);

      if (newType) {
        debugLogForBot(this._botName || "unknown", "wildlife:add", `${this._botName || "unknown"}`, `Added wildlife: "${name}" (${species}) in ${system}/${poi}`);
      }
      return newType;
    });
  }

  /**
   * Reconcile one POI against a complete `get_nearby` creature list: add what we
   * see, remove what we don't.
   *
   * A scan is authoritative for the creature types it contains, so any stored
   * creatureId of a type that IS present but whose id is NOT in the scan is
   * dead/despawned and gets dropped immediately. A type that is missing from
   * the scan entirely is only dropped after `VISIT_GAP_MS`, so two bots
   * scanning the same POI a second apart can't delete each other's findings.
   *
   * Memory only; the 2-minute flush timer persists the result.
   */
  reconcile(system: string, poi: string, observed: ObservedCreature[]): ReconcileResult {
    if (!system) system = "unknown";
    if (!poi) poi = "unknown";

    return perf.timeSync("wildlivestore.reconcile", () => {
      const result: ReconcileResult = { newTypes: 0, prunedIds: 0, prunedTypes: 0 };
      const entry = this.loadEntry(system);
      const sys = entry.sys;
      const nowMs = Date.now();
      const now = new Date(nowMs).toISOString();

      // Group the scan by (name + maxHull) — the same key the store uses.
      const present = new Map<string, { n: string; h: number; s: string; r: string; ids: Set<string> }>();
      for (const o of observed) {
        const n = this.normalize(o.name || "");
        if (!n) continue;
        const h = o.maxHull || 0;
        const key = `${n}\u0000${h}`;
        let group = present.get(key);
        if (!group) {
          group = { n, h, s: o.species || "", r: o.role || "", ids: new Set<string>() };
          present.set(key, group);
        }
        if (o.species) group.s = o.species;
        if (o.role) group.r = o.role;
        if (o.creatureId) group.ids.add(o.creatureId);
      }

      const list = sys.pois[poi] || [];
      const kept: CreatureEntry[] = [];
      for (const e of list) {
        const key = `${e.n}\u0000${e.h}`;
        const group = present.get(key);
        if (group) {
          // Present: this scan is the truth for this creature type, so stored
          // ids that it does not mention are dead/despawned.
          if (group.ids.size > 0) {
            for (const id of e.ids) if (!group.ids.has(id)) result.prunedIds++;
            e.ids = [...group.ids];
          }
          e.seen = now;
          if (group.s) e.s = group.s;
          if (group.r) e.r = group.r;
          present.delete(key);
          kept.push(e);
          continue;
        }
        // Absent from this scan: prune once the grace window has passed.
        const seenMs = Date.parse(e.seen);
        const stale = !Number.isFinite(seenMs) || nowMs - seenMs > VISIT_GAP_MS;
        if (stale) {
          result.prunedTypes++;
          result.prunedIds += e.ids.length;
        } else {
          kept.push(e);
        }
      }

      // Whatever is left in `present` was never recorded in this POI before.
      for (const group of present.values()) {
        kept.push({
          n: group.n,
          h: group.h,
          s: group.s,
          r: group.r,
          ids: [...group.ids],
          seen: now,
        });
        this.nameIndex.add(group.n);
        result.newTypes++;
        debugLogForBot(this._botName || "unknown", "wildlife:add", `${this._botName || "unknown"}`, `Added wildlife: "${group.n}" (${group.s}) in ${system}/${poi}`);
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

  // ── Read paths (creatures page / sync) ──────────────────────────────────
  // These deliberately read from disk and overlay the hot cache, so evicting
  // cold systems from RAM never makes the page incomplete.

  private *iterateSystems(): Generator<SystemWildlife> {
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

  private *iterateEntries(): Generator<{ system: string; poi: string; entry: CreatureEntry }> {
    for (const sys of this.iterateSystems()) {
      for (const [poi, list] of Object.entries(sys.pois)) {
        for (const entry of list) {
          yield { system: sys.system, poi, entry };
        }
      }
    }
  }

  private toDetail(system: string, poi: string, entry: CreatureEntry): WildlifeDetail {
    return {
      name: entry.n,
      species: entry.s,
      role: entry.r,
      maxHull: entry.h,
      count: entry.ids.length,
      ids: entry.ids,
      system,
      poi,
      lastSeen: entry.seen,
    };
  }

  getAll(): WildlifeDetail[] {
    const out: WildlifeDetail[] = [];
    for (const { system, poi, entry } of this.iterateEntries()) {
      out.push(this.toDetail(system, poi, entry));
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Most recent sighting of a creature by name, or null.
   *
   * NOTE: this walks every system (hot cache + disk). For a plain "is this a
   * creature?" test use `hasCreatureName()` — it is a Set lookup.
   */
  getWildlifeDetail(name: string): WildlifeDetail | null {
    const normalized = this.normalize(name);
    if (!this.hasCreatureName(normalized)) return null;
    let best: WildlifeDetail | null = null;
    for (const { system, poi, entry } of this.iterateEntries()) {
      if (entry.n === normalized) {
        const d = this.toDetail(system, poi, entry);
        if (!best || d.lastSeen > best.lastSeen) best = d;
      }
    }
    return best;
  }

  search(query: string): WildlifeDetail[] {
    const queryLower = query.toLowerCase().trim();
    if (!queryLower) return [];
    const out: WildlifeDetail[] = [];
    for (const { system, poi, entry } of this.iterateEntries()) {
      if (entry.n.includes(queryLower)) {
        out.push(this.toDetail(system, poi, entry));
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  private countSystem(sys: SystemWildlife, counts: WildlifeCounts): void {
    counts.systems++;
    for (const list of Object.values(sys.pois)) {
      if (list.length > 0) counts.pois++;
      for (const e of list) {
        counts.creatures++;
        counts.individuals += e.ids.length;
      }
    }
    if (sys.survey && sys.survey.wildlife.length > 0) {
      counts.surveySystems++;
      counts.surveySpecies += sys.survey.wildlife.length;
    }
  }

  getCounts(): WildlifeCounts {
    const counts: WildlifeCounts = {
      systems: 0, pois: 0, creatures: 0, individuals: 0, surveySystems: 0, surveySpecies: 0,
    };
    for (const sys of this.iterateSystems()) this.countSystem(sys, counts);
    return counts;
  }

  getFullData(): WildlifeFullData {
    const systems: Record<string, SystemWildlife> = {};
    const counts: WildlifeCounts = {
      systems: 0, pois: 0, creatures: 0, individuals: 0, surveySystems: 0, surveySpecies: 0,
    };
    let lastUpdated = "";
    for (const sys of this.iterateSystems()) {
      systems[sys.system] = sys;
      if (sys.lastUpdated > lastUpdated) lastUpdated = sys.lastUpdated;
      this.countSystem(sys, counts);
    }
    return { systems, lastUpdated, counts };
  }

  getSystemData(system: string): SystemWildlife {
    return this.loadSystem(system);
  }

  /**
   * Record potential-creature data reported by a survey_system result. This is
   * distinct from live `get_nearby` sightings: it describes species that *could*
   * be present in the system (with an estimate/abundance) plus faint signatures
   * that hint at where creatures may be hiding. The latest survey snapshot fully
   * replaces any previous one for the system.
   */
  recordSurvey(
    system: string,
    wildlife: SurveyWildlifeEntry[],
    faintSignatures: FaintSignature[]
  ): void {
    if (!system) system = "unknown";
    const normalized = wildlife
      .filter((w) => w && w.name)
      .map((w) => ({
        species: w.species || "",
        name: w.name || "",
        role: w.role || "",
        estimate: Number(w.estimate) || 0,
        abundance: w.abundance || "",
      }));
    const signatures = (faintSignatures || [])
      .filter((s) => s && s.hint)
      .map((s) => ({
        type: s.type || "",
        hint: s.hint || "",
        difficulty: s.difficulty || undefined,
      }));

    const entry = this.loadEntry(system);
    const stamp = new Date().toISOString();
    entry.sys.survey = {
      lastUpdated: stamp,
      wildlife: normalized,
      faintSignatures: signatures,
    };
    this.markChanged(entry, stamp);
  }

  /** Latest survey_system-derived potential-creature snapshot for a system, if any. */
  getSurvey(system: string): SystemSurveyWildlife | null {
    return this.loadSystem(system).survey ?? null;
  }

  /**
   * Merge an aggregated snapshot into this store. Unlike a replace, this unions
   * creatures by (system, poi, name, maxHull) and unions their `ids`, keeping the
   * most recently seen metadata. This prevents data loss when two synced nodes
   * exchange wildlife (e.g. a slave pulling the master's data must not wipe out
   * creatures the slave discovered locally).
   */
  mergeFrom(data: WildlifeFullData): void {
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
            for (const id of entry.ids || []) {
              if (id && !existing.ids.includes(id)) existing.ids.push(id);
            }
            if (entry.seen && entry.seen > existing.seen) {
              existing.seen = entry.seen;
              if (entry.s) existing.s = entry.s;
              if (entry.r) existing.r = entry.r;
            }
            changed = true;
          } else {
            tlist.push({
              n: entry.n,
              h: entry.h || 0,
              s: entry.s || "",
              r: entry.r || "",
              ids: [...(entry.ids || [])],
              seen: entry.seen || new Date().toISOString(),
            });
            changed = true;
          }
          this.nameIndex.add(entry.n);
        }
      }

      if (changed) {
        // A merge is remote data: persist it on the normal cadence, but don't
        // echo it straight back to the network.
        target.sys.lastUpdated = new Date().toISOString();
        target.dirty = true;
        target.lastAccess = Date.now();
      }
    }
  }

  /**
   * Import a full snapshot from the master (used by sync slaves). Merges rather
   * than replaces so locally-discovered creatures are preserved.
   */
  importAll(data: WildlifeFullData): void {
    this.mergeFrom(data);
  }

  // ── Persistence / housekeeping ──────────────────────────────────────────

  /** Systems currently held in RAM (diagnostics). */
  getCacheSize(): number {
    return this.cache.size;
  }

  /**
   * Write every dirty system. Async and sequential on purpose: a sync slave can
   * dirty hundreds of systems at once and writing them all in one synchronous
   * burst would stall the event loop exactly like the old per-sighting writes.
   */
  async flush(): Promise<number> {
    if (this.flushing) return 0;
    this.flushing = true;
    let written = 0;
    try {
      this.ensureDir();
      for (const [key, entry] of this.cache) {
        if (!entry.dirty) continue;
        entry.dirty = false;
        const empty = Object.keys(entry.sys.pois).length === 0 && !entry.sys.survey;
        const path = this.systemFilePath(key);
        try {
          if (empty) {
            // Everything in this system was pruned — drop the file too.
            if (existsSync(path)) await unlink(path);
          } else {
            await writeFile(path, JSON.stringify(entry.sys) + "\n", "utf-8");
          }
          written++;
        } catch (err) {
          entry.dirty = true;
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[WildlifeStore] Failed to write ${key}.json: ${msg}`);
        }
      }
    } finally {
      this.flushing = false;
    }
    return written;
  }

  /** Blocking flush for shutdown paths. */
  flushSync(): number {
    let written = 0;
    this.ensureDir();
    for (const [key, entry] of this.cache) {
      if (!entry.dirty) continue;
      entry.dirty = false;
      try {
        const path = this.systemFilePath(key);
        if (Object.keys(entry.sys.pois).length === 0 && !entry.sys.survey) {
          if (existsSync(path)) unlinkSync(path);
        } else {
          writeFileSync(path, JSON.stringify(entry.sys) + "\n", "utf-8");
        }
        written++;
      } catch (err) {
        entry.dirty = true;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[WildlifeStore] Failed to write ${key}.json: ${msg}`);
      }
    }
    return written;
  }

  /** Drop clean, untouched systems so RAM stays proportional to activity. */
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

  /**
   * Push at most one wildlife update per system per PUSH_INTERVAL_MS. Sightings
   * used to fire a push (and a full deep clone) per creature, which flooded
   * light slaves and burned more CPU than the sightings themselves.
   */
  private drainPushes(): void {
    if (!isSyncPushEnabled()) {
      // Nothing is listening — don't accumulate work for a push that never happens.
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

export const wildlifeStore = new WildlifeStore();

// Last-resort safety net: a normal `process.exit()` that skipped the graceful
// shutdown path must not throw away up to 2 minutes of sightings.
process.on("exit", () => {
  try {
    wildlifeStore.flushSync();
  } catch {
    // nothing useful to do while exiting
  }
});
