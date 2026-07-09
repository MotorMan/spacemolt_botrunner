import { debugLogForBot } from "./debug.js";
import { writeFileSync, existsSync, readFileSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { onWildlifeUpdate } from "./client_sync_hooks.js";

const CREATURES_DIR = join(process.cwd(), "data", "creatures");
const LEGACY_WILDLIFE_FILE = join(process.cwd(), "data", "wildlifeInfo.json");

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
}

export interface WildlifeFullData {
  systems: Record<string, SystemWildlife>;
  lastUpdated: string;
  counts: WildlifeCounts;
}

function sanitizeSystemName(system: string): string {
  const cleaned = (system || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
  return cleaned || "unknown";
}

export class WildlifeStore {
  private cache: Map<string, SystemWildlife> = new Map();
  private _botName: string | null = null;

  constructor() {
    this.migrateIfNeeded();
    this.loadAllIntoCache();
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
    const hasNew = readdirSync(CREATURES_DIR).some((f) => f.endsWith(".json"));
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
        this.writeSystemFile(sys);
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

  // Returns from cache or disk; never null (cached as blank when missing).
  private loadSystem(system: string): SystemWildlife {
    const key = sanitizeSystemName(system);
    let sys = this.cache.get(key);
    if (!sys) {
      sys = this.readSystem(key) ?? this.blankSystem(key);
      this.cache.set(key, sys);
    }
    return sys;
  }

  private writeSystemFile(sys: SystemWildlife): void {
    this.ensureDir();
    const path = this.systemFilePath(sys.system);
    writeFileSync(path, JSON.stringify(sys, null, 2) + "\n", "utf-8");
  }

  private loadAllIntoCache(): void {
    this.ensureDir();
    try {
      for (const file of readdirSync(CREATURES_DIR)) {
        if (!file.endsWith(".json")) continue;
        const sysName = file.slice(0, -".json".length);
        if (!this.cache.has(sysName)) {
          const sys = this.readSystem(sysName);
          if (sys) this.cache.set(sysName, sys);
        }
      }
    } catch {
      // No creatures yet; nothing to load.
    }
  }

  setBotName(name: string): void {
    this._botName = name;
  }

  private normalize(name: string): string {
    return name.trim().toLowerCase();
  }

  /**
   * Record a creature sighting. Dedups within a POI by (name + maxHull); if the
   * same type is seen again its creatureId is appended (so `ids.length` == count).
   * Returns true when a brand new type was discovered in that POI.
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

    const sys = this.loadSystem(system);
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

    sys.lastUpdated = now;
    this.writeSystemFile(sys);
    void onWildlifeUpdate({ system: sys.system, data: sys });

    if (newType) {
      debugLogForBot(this._botName || "unknown", "wildlife:add", `${this._botName || "unknown"}`, `Added wildlife: "${name}" (${species}) in ${system}/${poi}`);
    }
    return newType;
  }

  private *iterateEntries(): Generator<{ system: string; poi: string; entry: CreatureEntry }> {
    for (const sys of this.cache.values()) {
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

  getWildlifeDetail(name: string): WildlifeDetail | null {
    const normalized = this.normalize(name);
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

  getCounts(): WildlifeCounts {
    let systems = 0;
    let pois = 0;
    let creatures = 0;
    let individuals = 0;
    for (const sys of this.cache.values()) {
      systems++;
      for (const list of Object.values(sys.pois)) {
        if (list.length > 0) pois++;
        for (const e of list) {
          creatures++;
          individuals += e.ids.length;
        }
      }
    }
    return { systems, pois, creatures, individuals };
  }

  getFullData(): WildlifeFullData {
    const systems: Record<string, SystemWildlife> = {};
    let lastUpdated = "";
    for (const sys of this.cache.values()) {
      systems[sys.system] = sys;
      if (sys.lastUpdated > lastUpdated) lastUpdated = sys.lastUpdated;
    }
    return { systems, lastUpdated, counts: this.getCounts() };
  }

  getSystemData(system: string): SystemWildlife {
    return this.loadSystem(system);
  }

  /**
   * Replace the store contents from an aggregated snapshot (used by sync slaves
   * that pull the full dataset from the master). Writes per-system files.
   */
  importAll(data: WildlifeFullData): void {
    if (!data || !data.systems) return;
    for (const sys of Object.values(data.systems)) {
      if (!sys || !sys.system) continue;
      const key = sanitizeSystemName(sys.system);
      const normalized: SystemWildlife = {
        system: key,
        lastUpdated: sys.lastUpdated || new Date().toISOString(),
        pois: sys.pois || {},
      };
      this.cache.set(key, normalized);
      this.writeSystemFile(normalized);
    }
  }
}

export const wildlifeStore = new WildlifeStore();
