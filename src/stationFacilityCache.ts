import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";

export interface StationFacilityCacheEntry {
  facility_id: string;
  name?: string;
  facility_type?: string;
  category?: string;
  status?: string;
  custom_name?: string;
  [key: string]: unknown;
}

export interface StationFacilityCache {
  station: string;
  factionFacilities: StationFacilityCacheEntry[];
  empireFacilities: StationFacilityCacheEntry[];
  lastUpdated: number;
}

const DATA_DIR = join(process.cwd(), "data");
const CACHE_DIR = join(DATA_DIR, "factionFacilities");
const cacheStore = new Map<string, { data: StationFacilityCache; lastWritten: number }>();

function sanitizeFilename(key: string): string {
  return key.replace(/[<>:"/\\|?*]/g, "_");
}

function ensureCacheDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function saveToDisk(key: string, data: StationFacilityCache): void {
  try {
    ensureCacheDir();
    const cacheFile = join(CACHE_DIR, `${sanitizeFilename(key)}.json`);
    writeFileSync(cacheFile, JSON.stringify(data, null, 2), "utf-8");
  } catch (e) {
    console.log("Error writing station facility cache:", e);
  }
}

function loadFromDisk(station: string): StationFacilityCache | null {
  try {
    const cacheFile = join(CACHE_DIR, `${sanitizeFilename(station)}.json`);
    if (existsSync(cacheFile)) {
      const content = readFileSync(cacheFile, "utf-8");
      return JSON.parse(content) as StationFacilityCache;
    }
  } catch (e) {
    console.log("Error loading station facility cache:", e);
  }
  return null;
}

ensureCacheDir();

export function getStationFacilityCache(station: string): StationFacilityCache | null {
  const entry = cacheStore.get(station);
  if (entry && entry.data) {
    return entry.data;
  }
  const loaded = loadFromDisk(station);
  if (loaded) {
    cacheStore.set(station, { data: loaded, lastWritten: 0 });
    return loaded;
  }
  return null;
}

export function updateStationFacilityCache(
  station: string,
  factionFacilities: StationFacilityCacheEntry[],
  empireFacilities: StationFacilityCacheEntry[] = [],
): void {
  const now = Date.now();
  const data: StationFacilityCache = {
    station,
    factionFacilities,
    empireFacilities,
    lastUpdated: now,
  };
  cacheStore.set(station, { data, lastWritten: now });
  saveToDisk(station, data);
}

export function isStationFacilityCacheStale(
  station: string,
  maxAgeMs: number = 5 * 60 * 1000,
): boolean {
  const cached = getStationFacilityCache(station);
  if (!cached) return true;
  return Date.now() - cached.lastUpdated > maxAgeMs;
}

export function flushStationFacilityCache(): void {
  cacheStore.forEach((entry, key) => {
    saveToDisk(key, entry.data);
  });
}

export function getAllStationFacilityCacheStations(): string[] {
  const stations: string[] = [];
  cacheStore.forEach((_value, key) => stations.push(key));
  if (existsSync(CACHE_DIR)) {
    try {
      const files = readdirSync(CACHE_DIR);
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        const st = f.slice(0, -5);
        if (!stations.includes(st)) stations.push(st);
      }
    } catch {
      // ignore
    }
  }
  return stations;
}
