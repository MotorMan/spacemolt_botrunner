import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync } from "fs";
import { join } from "path";

export interface FactionStorageEntry {
  itemId: string;
  quantity: number;
  name?: string;
}

export interface FactionStorageCache {
  factionName: string;
  station: string;
  lastUpdated: number;
  entries: FactionStorageEntry[];
  factionFuelReserve?: number;
  factionFuelCapacity?: number;
}

const DATA_DIR = join(process.cwd(), "data");
const CACHE_DIR = join(DATA_DIR, "factionStorage");
const cacheStore = new Map<string, { data: FactionStorageCache; lastWritten: number }>();
const stationToKeyMap = new Map<string, string>();

function getCacheKey(factionName: string, station: string): string {
  return `${factionName}::${station || "default"}`;
}

function sanitizeFilename(key: string): string {
  return key.replace(/::/g, "--");
}

function checkExistingCacheFiles(): void {
  try {
    if (!existsSync(CACHE_DIR)) return;
    const files = readdirSync(CACHE_DIR);
    for (const file of files) {
      if (file.includes("::") && file.endsWith(".json")) {
        const oldPath = join(CACHE_DIR, file);
        const newPath = join(CACHE_DIR, file.replace(/::/g, "--"));
        renameSync(oldPath, newPath);
      }
    }
  } catch (e) {
    console.log("Error checking cache files:", e);
  }
}

function loadAllCacheFiles(): void {
  try {
    if (!existsSync(CACHE_DIR)) return;
    const files = readdirSync(CACHE_DIR);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const cacheFile = join(CACHE_DIR, file);
      const content = readFileSync(cacheFile, "utf-8");
      const data = JSON.parse(content) as FactionStorageCache;
      if (data.factionName && data.station) {
        const key = getCacheKey(data.factionName, data.station);
        cacheStore.set(key, { data, lastWritten: 0 });
        stationToKeyMap.set(data.station, key);
      }
    }
  } catch (e) {
    console.log("Error loading cache files:", e);
  }
}

function loadFromDisk(factionName: string, station: string): FactionStorageCache | null {
  try {
    const key = getCacheKey(factionName, station);
    const cacheFile = join(CACHE_DIR, `${sanitizeFilename(key)}.json`);
    if (existsSync(cacheFile)) {
      const content = readFileSync(cacheFile, "utf-8");
      return JSON.parse(content) as FactionStorageCache;
    }
  } catch (e) {
  }
  return null;
}

function ensureCacheDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function saveToDisk(key: string, data: FactionStorageCache): void {
  try {
    ensureCacheDir();
    const cacheFile = join(CACHE_DIR, `${sanitizeFilename(key)}.json`);
    writeFileSync(cacheFile, JSON.stringify(data, null, 2), "utf-8");
  } catch (e) {
    console.log("Error writing faction storage cache:", e);
  }
}

function migrateOldCache(): void {
  try {
    const oldCacheFile = join(DATA_DIR, "factionStorage.json");
    if (existsSync(oldCacheFile)) {
      const content = readFileSync(oldCacheFile, "utf-8");
      const oldData = JSON.parse(content) as { factionName: string; entries: FactionStorageEntry[]; factionFuelReserve?: number; factionFuelCapacity?: number };
      if (oldData.factionName && oldData.entries && oldData.entries.length > 0) {
        const key = getCacheKey(oldData.factionName, "default");
        const data: FactionStorageCache = {
          factionName: oldData.factionName,
          station: "default",
          lastUpdated: Date.now(),
          entries: oldData.entries,
          factionFuelReserve: oldData.factionFuelReserve,
          factionFuelCapacity: oldData.factionFuelCapacity,
        };
        cacheStore.set(key, { data, lastWritten: Date.now() });
        stationToKeyMap.set("default", key);
        saveToDisk(key, data);
      }
    }
  } catch (e) {
    console.log("Error migrating old faction storage cache:", e);
  }
}

ensureCacheDir();
migrateOldCache();
checkExistingCacheFiles();
loadAllCacheFiles();

export function getFactionStorageCache(factionName: string, station: string = ""): FactionStorageCache | null {
  const key = getCacheKey(factionName, station);
  const entry = cacheStore.get(key);
  if (entry && entry.data) {
    return entry.data;
  }
  const loaded = loadFromDisk(factionName, station);
  if (loaded) {
    cacheStore.set(key, { data: loaded, lastWritten: 0 });
    return loaded;
  }
  return null;
}

export function getFactionStorageCacheByStationOnly(station: string): FactionStorageCache | null {
  const key = stationToKeyMap.get(station);
  if (key) {
    const entry = cacheStore.get(key);
    if (entry?.data) return entry.data;
  }
  const keys = getAllFactionStorageKeys();
  for (const k of keys) {
    const [factionName, st] = k.split("::");
    if (st === station) {
      const entry = cacheStore.get(k);
      if (entry?.data) {
        stationToKeyMap.set(station, k);
        return entry.data;
      }
    }
  }
  return null;
}

export function updateFactionStorageCache(
  factionName: string,
  entries: FactionStorageEntry[],
  station?: string,
  factionFuelReserve?: number,
  factionFuelCapacity?: number,
): void {
  const st = station || "";
  const key = getCacheKey(factionName, st);
  const now = Date.now();
  
  if (st) {
    stationToKeyMap.set(st, key);
  }
  
  const entry = cacheStore.get(key);
  
  if (!entry) {
    const data: FactionStorageCache = {
      factionName,
      station: st,
      lastUpdated: now,
      entries,
      factionFuelReserve,
      factionFuelCapacity,
    };
    cacheStore.set(key, { data, lastWritten: now });
    saveToDisk(key, data);
    return;
  }

  entry.data.lastUpdated = now;
  entry.data.entries = entries;
  entry.data.station = st;
  if (factionFuelReserve !== undefined) entry.data.factionFuelReserve = factionFuelReserve;
  if (factionFuelCapacity !== undefined) entry.data.factionFuelCapacity = factionFuelCapacity;

  cacheStore.set(key, { data: entry.data, lastWritten: now });
  saveToDisk(key, entry.data);
}

export function isFactionStorageCacheStale(factionName: string, station?: string, maxAgeMs: number = 5 * 60 * 1000): boolean {
  const cached = getFactionStorageCache(factionName, station);
  if (!cached) return true;
  return Date.now() - cached.lastUpdated > maxAgeMs;
}

export function flushFactionStorageCache(factionName?: string, station?: string): void {
  if (factionName) {
    const key = getCacheKey(factionName, station || "");
    const entry = cacheStore.get(key);
    if (entry) {
      saveToDisk(key, entry.data);
    }
  } else {
    cacheStore.forEach((entry, key) => {
      saveToDisk(key, entry.data);
    });
  }
}

export function clearFactionStorageCache(): void {
  cacheStore.clear();
}

export function getAllFactionStorageKeys(): string[] {
  const keys: string[] = [];
  cacheStore.forEach((_value, key) => keys.push(key));
  return keys;
}

export function getFactionStorageCacheByStation(factionName: string, station: string): FactionStorageCache | undefined {
  const key = getCacheKey(factionName, station);
  return cacheStore.get(key)?.data;
}