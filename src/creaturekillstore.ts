import { writeFileSync, existsSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { safeWriteFileSync } from "./diskSpaceGuard.js";

const DATA_DIR = join(process.cwd(), "data");
const CREATURE_KILLS_FILE = join(DATA_DIR, "creature_kills.json");

export interface CreatureKillData {
  lastUpdated: string;
  systems: Record<string, SystemKillData>;
}

export interface SystemKillData {
  pois: Record<string, Record<string, number>>;
}

function ensureDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function blankData(): CreatureKillData {
  return { lastUpdated: new Date().toISOString(), systems: {} };
}

export class CreatureKillStore {
  private cache: CreatureKillData | null = null;
  private dirty = false;

  private load(): CreatureKillData {
    if (this.cache) return this.cache;
    if (existsSync(CREATURE_KILLS_FILE)) {
      try {
        const parsed = JSON.parse(readFileSync(CREATURE_KILLS_FILE, "utf-8")) as CreatureKillData;
        if (!parsed.systems) parsed.systems = {};
        this.cache = parsed;
        return parsed;
      } catch {
        // corrupt file — start fresh
      }
    }
    this.cache = blankData();
    return this.cache;
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.cache) {
      this.cache.lastUpdated = new Date().toISOString();
    }
  }

  /** Record a creature kill at the given system/poi/species. */
  recordKill(system: string, poi: string, species: string): void {
    if (!system || !poi || !species) return;
    const data = this.load();
    const sys = data.systems[system] || { pois: {} };
    const poiData = sys.pois[poi] || {};
    const count = poiData[species] || 0;
    poiData[species] = count + 1;
    sys.pois[poi] = poiData;
    data.systems[system] = sys;
    this.markDirty();
    this.flush();
  }

  /** Get total kills across all POIs and species for a system. */
  getSystemTotal(system: string): number {
    const data = this.load();
    const sys = data.systems[system];
    if (!sys) return 0;
    let total = 0;
    for (const poiData of Object.values(sys.pois)) {
      for (const count of Object.values(poiData)) {
        total += count;
      }
    }
    return total;
  }

  /** Get kills broken down by species for a system (summed across all POIs). */
  getSystemSpeciesCounts(system: string): Record<string, number> {
    const data = this.load();
    const sys = data.systems[system];
    if (!sys) return {};
    const counts: Record<string, number> = {};
    for (const poiData of Object.values(sys.pois)) {
      for (const [species, count] of Object.entries(poiData)) {
        counts[species] = (counts[species] || 0) + count;
      }
    }
    return counts;
  }

  /** Get all systems that have recorded kills, with their totals. */
  getAllSystemTotals(): Record<string, number> {
    const data = this.load();
    const totals: Record<string, number> = {};
    for (const [system, sys] of Object.entries(data.systems)) {
      let total = 0;
      for (const poiData of Object.values(sys.pois)) {
        for (const count of Object.values(poiData)) {
          total += count;
        }
      }
      if (total > 0) totals[system] = total;
    }
    return totals;
  }

  /** Persist dirty data to disk. */
  flush(): void {
    if (!this.dirty || !this.cache) return;
    ensureDir();
    const payload = JSON.stringify(this.cache, null, 2) + "\n";
    safeWriteFileSync(CREATURE_KILLS_FILE, payload, Buffer.byteLength(payload, "utf-8"));
    this.dirty = false;
  }

  /** Force a flush and reload from disk. */
  flushSync(): void {
    this.flush();
    this.cache = null;
  }

  /** Clear all recorded data. */
  clear(): void {
    this.cache = blankData();
    this.dirty = true;
    this.flush();
  }
}

export const creatureKillStore = new CreatureKillStore();
