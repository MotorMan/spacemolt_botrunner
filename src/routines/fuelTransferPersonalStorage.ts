/**
 * Lightweight tracker for fuel-transport "personal storage" deliveries.
 *
 * Personal storage items do not appear in the destination station's faction
 * storage, so the regular `view_faction_storage` checks falsely report "0 at
 * station" forever for stations that have no faction lockbox (e.g. moving
 * station ships that can only use gifting or personal storage). This module
 * records how much of each item has already been deposited to personal storage
 * at each remote station, letting the FT routine treat those units as "present"
 * when computing remaining need / co-op availability / loadout satisfaction.
 *
 * Data shape is intentionally simple: one JSON file keyed by station, then
 * itemId → quantity. No history, no per-bot attribution — just the fleet-wide
 * personal-storage total per station, because personal storage at a station is
 * not queryable via the faction storage API.
 */

import { readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { safeWriteFileSync } from "../diskSpaceGuard.js";

const DATA_DIR = join(process.cwd(), "data");
const PERSONAL_STORAGE_FILE = join(DATA_DIR, "fuelTransferPersonalStorage.json");

export interface PersonalStorageItemEntry {
  quantity: number;
  updatedAt: number;
}

export type PersonalStorageByStation = Record<string, Record<string, PersonalStorageItemEntry>>;

let personalStorageMemory: PersonalStorageByStation | null = null;

function loadPersonalStorageData(): PersonalStorageByStation {
  if (!personalStorageMemory) {
    try {
      if (existsSync(PERSONAL_STORAGE_FILE)) {
        const raw = readFileSync(PERSONAL_STORAGE_FILE, "utf-8");
        const parsed = JSON.parse(raw) as PersonalStorageByStation;
        personalStorageMemory = parsed;
      }
    } catch (err) {
      console.warn("Could not load fuelTransferPersonalStorage.json:", err);
    }
  }
  return personalStorageMemory ?? {};
}

function persistPersonalStorageData(data: PersonalStorageByStation): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    const payload = JSON.stringify(data, null, 2) + "\n";
    safeWriteFileSync(PERSONAL_STORAGE_FILE, payload, Buffer.byteLength(payload, "utf-8"));
  } catch (err) {
    console.error("Error saving fuelTransferPersonalStorage.json:", err);
  }
}

/** Quantity of `itemId` already deposited to personal storage at `stationId`. */
export function getPersonalStorageQuantity(stationId: string, itemId: string): number {
  const data = loadPersonalStorageData();
  return data[stationId]?.[itemId]?.quantity || 0;
}

/** All itemIds currently tracked as deposited to personal storage at `stationId`. */
export function getAllPersonalStorageItems(stationId: string): Record<string, PersonalStorageItemEntry> {
  const data = loadPersonalStorageData();
  return data[stationId] ?? {};
}

/** Count of stations that currently have at least one personal storage entry,
 *  plus the total number of item entries across all stations. Used by the web
 *  UI to report how much personal-storage tracking state exists before a reset. */
export function getPersonalStorageSummary(): { stationCount: number; entryCount: number } {
  const data = loadPersonalStorageData();
  let stationCount = 0;
  let entryCount = 0;
  for (const entries of Object.values(data)) {
    const keys = Object.keys(entries);
    if (keys.length > 0) {
      stationCount++;
      entryCount += keys.length;
    }
  }
  return { stationCount, entryCount };
}

/** Record `qty` more units of `itemId` as deposited to personal storage at
 *  `stationId`. Returns the new total. */
export function addPersonalStorageQuantity(stationId: string, itemId: string, qty: number): number {
  if (qty <= 0) return getPersonalStorageQuantity(stationId, itemId);
  const data = loadPersonalStorageData();
  if (!data[stationId]) data[stationId] = {};
  const existing = data[stationId][itemId];
  const entry: PersonalStorageItemEntry = existing
    ? existing
    : { quantity: 0, updatedAt: Date.now() };
  entry.quantity = Math.max(0, (entry.quantity || 0)) + qty;
  entry.updatedAt = Date.now();
  data[stationId][itemId] = entry;
  persistPersonalStorageData(data);
  return entry.quantity;
}

/** Reset personal storage tracking for one station (e.g. user reset/correction). */
export function clearPersonalStorageForStation(stationId: string): void {
  const data = loadPersonalStorageData();
  if (data[stationId]) {
    delete data[stationId];
    persistPersonalStorageData(data);
  }
}

/** Reset all personal storage tracking. */
export function clearAllPersonalStorage(): void {
  persistPersonalStorageData({});
  personalStorageMemory = {};
}
