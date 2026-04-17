import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

export interface FactionStorageEntry {
  itemId: string;
  quantity: number;
  name?: string;
}

export interface FactionStorageCache {
  factionName: string;
  lastUpdated: number;
  entries: FactionStorageEntry[];
}

const DATA_DIR = join(process.cwd(), "data");
const CACHE_FILE = join(DATA_DIR, "factionStorage.json");

const MIN_WRITE_INTERVAL = 10 * 60 * 1000; // 10 minutes
let cachedData: FactionStorageCache | null = null;
let lastWritten: number = 0;
let pendingWrite = false;

function loadFromDisk(): FactionStorageCache | null {
  try {
    if (existsSync(CACHE_FILE)) {
      const content = readFileSync(CACHE_FILE, "utf-8");
      return JSON.parse(content) as FactionStorageCache;
    }
  } catch (e) {
    // Silently return null on error
  }
  return null;
}

function saveToDisk(data: FactionStorageCache): void {
  const now = Date.now();
  if (now - lastWritten < MIN_WRITE_INTERVAL && !pendingWrite) {
    return;
  }
  lastWritten = now;
  pendingWrite = false;
  try {
    writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (e) {
    // Silently fail on write error
  }
}

export function getFactionStorageCache(factionName: string): FactionStorageCache | null {
  if (cachedData && cachedData.factionName === factionName) {
    return cachedData;
  }
  cachedData = loadFromDisk();
  if (cachedData && cachedData.factionName === factionName) {
    return cachedData;
  }
  return null;
}

export function updateFactionStorageCache(
  factionName: string,
  entries: FactionStorageEntry[]
): void {
  const now = Date.now();
  
  if (!cachedData || cachedData.factionName !== factionName) {
    cachedData = {
      factionName,
      lastUpdated: now,
      entries,
    };
    saveToDisk(cachedData);
    return;
  }

  const hasChanged = JSON.stringify(cachedData.entries) !== JSON.stringify(entries);
  
  cachedData.lastUpdated = now;
  cachedData.entries = entries;

  if (hasChanged) {
    pendingWrite = true;
    saveToDisk(cachedData);
  }
}

export function isFactionStorageCacheStale(factionName: string, maxAgeMs: number = 5 * 60 * 1000): boolean {
  const cached = getFactionStorageCache(factionName);
  if (!cached) return true;
  return Date.now() - cached.lastUpdated > maxAgeMs;
}

export function flushFactionStorageCache(): void {
  if (cachedData) {
    lastWritten = 0;
    pendingWrite = false;
    saveToDisk(cachedData);
  }
}

export function clearFactionStorageCache(): void {
  cachedData = null;
}