/**
 * Cargo Mover In-Transit Tracking
 *
 * Tracks items that have been loaded by cargo mover bots but not yet delivered.
 * This prevents multiple bots from duplicating work on the same items.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const DATA_DIR = join(process.cwd(), "data");
const IN_TRANSIT_FILE = join(DATA_DIR, "cargoMoverInTransit.json");

export interface InTransitItem {
  itemId: string;
  itemName: string;
  quantity: number;
  botUsername: string;
  destinationStation: string;
  loadedAt: string;
  estimatedArrival?: string;
}

export interface CargoMoverInTransitData {
  _info: string;
  /** Items currently in transit, keyed by `${itemId}:${destinationStation}` */
  inTransitItems: Record<string, InTransitItem[]>;
  /** Last updated timestamp */
  lastUpdated: string;
}

/** Load in-transit data from disk. */
export function loadInTransitData(): CargoMoverInTransitData {
  try {
    if (existsSync(IN_TRANSIT_FILE)) {
      const data = JSON.parse(readFileSync(IN_TRANSIT_FILE, "utf-8"));
      return {
        _info: data._info || "Cargo mover in-transit tracking",
        inTransitItems: data.inTransitItems || {},
        lastUpdated: data.lastUpdated || new Date().toISOString(),
      };
    }
  } catch (err) {
    console.warn("Could not load cargoMoverInTransit.json:", err);
  }
  return {
    _info: "Cargo mover in-transit tracking",
    inTransitItems: {},
    lastUpdated: new Date().toISOString(),
  };
}

/** Save in-transit data to disk. */
export function saveInTransitData(data: CargoMoverInTransitData): void {
  try {
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }
    data.lastUpdated = new Date().toISOString();
    writeFileSync(IN_TRANSIT_FILE, JSON.stringify(data, null, 2) + "\n");
  } catch (err) {
    console.error("Error saving cargoMoverInTransit.json:", err);
  }
}

/** Add items to in-transit tracking when loaded. */
export function addInTransitItems(
  botUsername: string,
  destinationStation: string,
  items: Array<{ itemId: string; itemName: string; quantity: number }>
): void {
  const data = loadInTransitData();
  const now = new Date().toISOString();

  for (const item of items) {
    if (item.quantity <= 0) continue;

    const key = `${item.itemId}:${destinationStation}`;
    if (!data.inTransitItems[key]) {
      data.inTransitItems[key] = [];
    }

    // Check if this bot already has an entry for this item/destination
    let existingEntry = data.inTransitItems[key].find(
      entry => entry.botUsername === botUsername && entry.itemId === item.itemId
    );

    if (existingEntry) {
      // Update existing entry
      existingEntry.quantity += item.quantity;
      existingEntry.loadedAt = now;
    } else {
      // Add new entry
      data.inTransitItems[key].push({
        itemId: item.itemId,
        itemName: item.itemName,
        quantity: item.quantity,
        botUsername,
        destinationStation,
        loadedAt: now,
      });
    }
  }

  saveInTransitData(data);
}

/** Remove items from in-transit tracking when delivered. */
export function removeInTransitItems(
  botUsername: string,
  destinationStation: string,
  items: Array<{ itemId: string; quantity: number }>
): void {
  const data = loadInTransitData();
  let changed = false;

  for (const item of items) {
    if (item.quantity <= 0) continue;

    const key = `${item.itemId}:${destinationStation}`;
    const entries = data.inTransitItems[key];

    if (entries) {
      // Find entries for this bot and item
      const botEntries = entries.filter(
        entry => entry.botUsername === botUsername && entry.itemId === item.itemId
      );

      for (const entry of botEntries) {
        if (entry.quantity >= item.quantity) {
          entry.quantity -= item.quantity;
          changed = true;
          break;
        } else {
          // Remove entire entry and continue with remaining quantity
          const remaining = item.quantity - entry.quantity;
          entry.quantity = 0;
          item.quantity = remaining;
          changed = true;
        }
      }

      // Remove entries with zero quantity
      data.inTransitItems[key] = entries.filter(entry => entry.quantity > 0);

      // Remove empty arrays
      if (data.inTransitItems[key].length === 0) {
        delete data.inTransitItems[key];
      }
    }
  }

  if (changed) {
    saveInTransitData(data);
  }
}

/** Get total in-transit quantity for an item to a destination. */
export function getInTransitQuantity(
  itemId: string,
  destinationStation: string,
  excludeBot?: string
): number {
  const data = loadInTransitData();
  const key = `${itemId}:${destinationStation}`;
  const entries = data.inTransitItems[key] || [];

  return entries
    .filter(entry => !excludeBot || entry.botUsername !== excludeBot)
    .reduce((sum, entry) => sum + entry.quantity, 0);
}

/** Clean up stale in-transit entries (items in transit for more than 24 hours). */
export function cleanupStaleInTransit(): number {
  const data = loadInTransitData();
  const now = Date.now();
  const staleThresholdMs = 24 * 60 * 60 * 1000; // 24 hours
  let cleaned = 0;

  for (const [key, entries] of Object.entries(data.inTransitItems)) {
    const filtered = entries.filter(entry => {
      const loadedAt = new Date(entry.loadedAt).getTime();
      const ageMs = now - loadedAt;
      if (ageMs > staleThresholdMs) {
        console.log(`[CargoMoverInTransit] Cleaning up stale entry: ${entry.itemId} x${entry.quantity} from ${entry.botUsername} (${Math.round(ageMs / 3600000)}h old)`);
        cleaned++;
        return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      delete data.inTransitItems[key];
    } else {
      data.inTransitItems[key] = filtered;
    }
  }

  if (cleaned > 0) {
    saveInTransitData(data);
  }

  return cleaned;
}

/** Get summary of in-transit items. */
export function getInTransitSummary(): {
  totalItems: number;
  totalQuantity: number;
  itemsByDestination: Record<string, Array<{
    itemId: string;
    itemName: string;
    quantity: number;
    botUsername: string;
  }>>;
} {
  const data = loadInTransitData();
  const summary = {
    totalItems: 0,
    totalQuantity: 0,
    itemsByDestination: {} as Record<string, Array<{
      itemId: string;
      itemName: string;
      quantity: number;
      botUsername: string;
    }>>,
  };

  for (const [key, entries] of Object.entries(data.inTransitItems)) {
    const [, destination] = key.split(':');
    if (!summary.itemsByDestination[destination]) {
      summary.itemsByDestination[destination] = [];
    }

    for (const entry of entries) {
      summary.itemsByDestination[destination].push({
        itemId: entry.itemId,
        itemName: entry.itemName,
        quantity: entry.quantity,
        botUsername: entry.botUsername,
      });
      summary.totalItems++;
      summary.totalQuantity += entry.quantity;
    }
  }

  return summary;
}