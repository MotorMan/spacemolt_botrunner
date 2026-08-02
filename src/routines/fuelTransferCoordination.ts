/**
 * Fleet-wide fuel transport coordination for multiple bots.
 *
 * Prevents bots from competing for the same delivery runs by:
 * 1. Locking item quantities per remote station so multiple bots can contribute
 * 2. Tracking how much of an item each bot has claimed for a destination
 * 3. Allowing bots to see remaining available quantities
 * 4. Tracking items in transit (loaded but not yet delivered)
 * 5. Automatic lock expiration on inactivity
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const DATA_DIR = join(process.cwd(), "data");
const COORDINATION_FILE = join(DATA_DIR, "fuelTransferCoordination.json");
const IN_TRANSIT_FILE = join(DATA_DIR, "fuelTransferInTransit.json");

/** Represents a delivery lock for a specific item to a specific remote station. */
export interface FtQuantityLock {
  lockedBy: string;
  itemId: string;
  itemName: string;
  remoteStationId: string;
  lockedQuantity: number;
  deliveredQuantity: number;
  lockedAt: string;
  lastActivity: string;
  isActive: boolean;
}

export interface FtCoordinationData {
  _info: string;
  activeLocks: Record<string, FtQuantityLock>;
  lockHistory: Array<FtQuantityLock & { releasedAt: string; reason: string }>;
}

export interface FtInTransitItem {
  itemId: string;
  itemName: string;
  quantity: number;
  botUsername: string;
  remoteStationId: string;
  loadedAt: string;
}

export interface FtInTransitData {
  _info: string;
  inTransitItems: FtInTransitItem[];
  lastUpdated: string;
}

function lockKey(itemId: string, remoteStationId: string, botUsername: string): string {
  return `${itemId}:${remoteStationId}:${botUsername}`;
}

export function loadCoordinationData(): FtCoordinationData {
  try {
    if (existsSync(COORDINATION_FILE)) {
      const data = JSON.parse(readFileSync(COORDINATION_FILE, "utf-8"));
      return {
        _info: data._info || "Fuel transport coordination data",
        activeLocks: data.activeLocks || {},
        lockHistory: Array.isArray(data.lockHistory) ? data.lockHistory : [],
      };
    }
  } catch (err) {
    console.warn("Could not load fuelTransferCoordination.json:", err);
  }
  return {
    _info: "Fuel transport coordination data",
    activeLocks: {},
    lockHistory: [],
  };
}

export function saveCoordinationData(data: FtCoordinationData): void {
  try {
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }
    writeFileSync(COORDINATION_FILE, JSON.stringify(data, null, 2) + "\n");
  } catch (err) {
    console.error("Error saving fuelTransferCoordination.json:", err);
  }
}

export function getItemLocks(itemId: string, remoteStationId: string): FtQuantityLock[] {
  const data = loadCoordinationData();
  return Object.values(data.activeLocks).filter(
    lock => lock.itemId === itemId && lock.remoteStationId === remoteStationId && lock.isActive
  );
}

export function getBotItemLock(botUsername: string, itemId: string, remoteStationId: string): FtQuantityLock | null {
  const data = loadCoordinationData();
  const key = lockKey(itemId, remoteStationId, botUsername);
  const lock = data.activeLocks[key];
  return (lock && lock.isActive) ? lock : null;
}

export function getBotLocks(botUsername: string): FtQuantityLock[] {
  const data = loadCoordinationData();
  return Object.values(data.activeLocks).filter(
    lock => lock.lockedBy === botUsername && lock.isActive
  );
}

export function getAvailableDeliveryQuantity(
  itemId: string,
  remoteStationId: string,
  need: number,
  excludeBot?: string
): number {
  const locks = getItemLocks(itemId, remoteStationId);
  const claimedByOthers = locks
    .filter(lock => !excludeBot || lock.lockedBy !== excludeBot)
    .reduce((sum, lock) => {
      const remaining = lock.lockedQuantity - lock.deliveredQuantity;
      return sum + Math.max(0, remaining);
    }, 0);

  return Math.max(0, need - claimedByOthers);
}

export function getBotClaimedQuantity(botUsername: string, itemId: string, remoteStationId: string): number {
  const lock = getBotItemLock(botUsername, itemId, remoteStationId);
  return lock ? (lock.lockedQuantity - lock.deliveredQuantity) : 0;
}

export function acquireDeliveryLock(params: {
  botUsername: string;
  itemId: string;
  itemName: string;
  quantity: number;
  remoteStationId: string;
}): { success: boolean; message: string; lock?: FtQuantityLock } {
  const data = loadCoordinationData();
  const key = lockKey(params.itemId, params.remoteStationId, params.botUsername);
  const now = new Date().toISOString();

  const existingLock = data.activeLocks[key];
  if (existingLock && existingLock.isActive) {
    existingLock.lastActivity = now;
    existingLock.lockedQuantity = params.quantity;
    saveCoordinationData(data);
    return { success: true, message: "Updated existing lock", lock: existingLock };
  }

  const lock: FtQuantityLock = {
    lockedBy: params.botUsername,
    itemId: params.itemId,
    itemName: params.itemName,
    remoteStationId: params.remoteStationId,
    lockedQuantity: params.quantity,
    deliveredQuantity: 0,
    lockedAt: now,
    lastActivity: now,
    isActive: true,
  };

  data.activeLocks[key] = lock;
  saveCoordinationData(data);
  return { success: true, message: "Acquired new lock", lock };
}

export function updateDeliveredQuantity(
  botUsername: string,
  itemId: string,
  remoteStationId: string,
  deliveredQty: number
): boolean {
  const data = loadCoordinationData();
  const key = lockKey(itemId, remoteStationId, botUsername);
  const lock = data.activeLocks[key];

  if (!lock || !lock.isActive) return false;

  lock.deliveredQuantity += deliveredQty;
  lock.lastActivity = new Date().toISOString();
  saveCoordinationData(data);
  return true;
}

export function releaseDeliveryLock(
  botUsername: string,
  itemId: string,
  remoteStationId: string,
  reason: string = "completed"
): boolean {
  const data = loadCoordinationData();
  const key = lockKey(itemId, remoteStationId, botUsername);
  const lock = data.activeLocks[key];

  if (!lock || !lock.isActive) return false;

  const historicalLock = {
    ...lock,
    releasedAt: new Date().toISOString(),
    reason,
  };

  data.lockHistory.unshift(historicalLock);
  if (data.lockHistory.length > 200) {
    data.lockHistory = data.lockHistory.slice(0, 200);
  }

  lock.isActive = false;
  saveCoordinationData(data);
  return true;
}

export function cleanupStaleLocks(): number {
  const data = loadCoordinationData();
  const now = Date.now();
  const staleThresholdMs = 15 * 60 * 1000;
  let cleaned = 0;

  for (const [key, lock] of Object.entries(data.activeLocks)) {
    if (!lock.isActive) continue;

    const lastActivity = new Date(lock.lastActivity).getTime();
    const inactivityMs = now - lastActivity;

    if (inactivityMs > staleThresholdMs) {
      const historicalLock = {
        ...lock,
        releasedAt: new Date().toISOString(),
        reason: "stale_cleanup",
      };

      data.lockHistory.unshift(historicalLock);
      lock.isActive = false;
      cleaned++;
    }
  }

  if (cleaned > 0) {
    if (data.lockHistory.length > 200) {
      data.lockHistory = data.lockHistory.slice(0, 200);
    }
    saveCoordinationData(data);
  }

  return cleaned;
}

export function resetCoordinationTracking(): { clearedLocks: number } {
  const data = loadCoordinationData();
  let clearedLocks = 0;

  for (const [key, lock] of Object.entries(data.activeLocks)) {
    if (!lock.isActive) continue;
    clearedLocks++;
    data.lockHistory.unshift({ ...lock, releasedAt: new Date().toISOString(), reason: "manual_reset" });
    lock.isActive = false;
  }

  for (const key of Object.keys(data.activeLocks)) {
    if (!data.activeLocks[key].isActive) {
      delete data.activeLocks[key];
    }
  }

  if (data.lockHistory.length > 200) {
    data.lockHistory = data.lockHistory.slice(0, 200);
  }

  saveCoordinationData(data);
  return { clearedLocks };
}

export function loadInTransitData(): FtInTransitData {
  try {
    if (existsSync(IN_TRANSIT_FILE)) {
      const data = JSON.parse(readFileSync(IN_TRANSIT_FILE, "utf-8"));
      return {
        _info: data._info || "Fuel transport in-transit tracking",
        inTransitItems: Array.isArray(data.inTransitItems) ? data.inTransitItems : [],
        lastUpdated: data.lastUpdated || new Date().toISOString(),
      };
    }
  } catch (err) {
    console.warn("Could not load fuelTransferInTransit.json:", err);
  }
  return {
    _info: "Fuel transport in-transit tracking",
    inTransitItems: [],
    lastUpdated: new Date().toISOString(),
  };
}

export function saveInTransitData(data: FtInTransitData): void {
  try {
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }
    data.lastUpdated = new Date().toISOString();
    writeFileSync(IN_TRANSIT_FILE, JSON.stringify(data, null, 2) + "\n");
  } catch (err) {
    console.error("Error saving fuelTransferInTransit.json:", err);
  }
}

export function addInTransitItems(
  botUsername: string,
  remoteStationId: string,
  items: Array<{ itemId: string; itemName: string; quantity: number }>
): void {
  const data = loadInTransitData();
  const now = new Date().toISOString();

  for (const item of items) {
    if (item.quantity <= 0) continue;

    const existing = data.inTransitItems.find(
      entry => entry.botUsername === botUsername && entry.itemId === item.itemId && entry.remoteStationId === remoteStationId
    );

    if (existing) {
      existing.quantity += item.quantity;
      existing.loadedAt = now;
    } else {
      data.inTransitItems.push({
        itemId: item.itemId,
        itemName: item.itemName,
        quantity: item.quantity,
        botUsername,
        remoteStationId,
        loadedAt: now,
      });
    }
  }

  saveInTransitData(data);
}

export function removeInTransitItems(
  botUsername: string,
  remoteStationId: string,
  items: Array<{ itemId: string; quantity: number }>
): void {
  const data = loadInTransitData();
  let changed = false;

  for (const item of items) {
    if (item.quantity <= 0) continue;

    const botEntries = data.inTransitItems.filter(
      entry => entry.botUsername === botUsername && entry.itemId === item.itemId && entry.remoteStationId === remoteStationId
    );

    for (const entry of botEntries) {
      if (entry.quantity >= item.quantity) {
        entry.quantity -= item.quantity;
        changed = true;
        break;
      } else {
        const remaining = item.quantity - entry.quantity;
        entry.quantity = 0;
        item.quantity = remaining;
        changed = true;
      }
    }

    data.inTransitItems = data.inTransitItems.filter(entry => entry.quantity > 0);
  }

  if (changed) {
    saveInTransitData(data);
  }
}

export function getInTransitQuantity(itemId: string, remoteStationId: string, excludeBot?: string): number {
  const data = loadInTransitData();
  return data.inTransitItems
    .filter(entry => !excludeBot || entry.botUsername !== excludeBot)
    .filter(entry => entry.itemId === itemId && entry.remoteStationId === remoteStationId)
    .reduce((sum, entry) => sum + entry.quantity, 0);
}

export function cleanupStaleInTransit(): number {
  const data = loadInTransitData();
  const now = Date.now();
  const staleThresholdMs = 24 * 60 * 60 * 1000;
  let cleaned = 0;

  const filtered = data.inTransitItems.filter(entry => {
    const loadedAt = new Date(entry.loadedAt).getTime();
    const ageMs = now - loadedAt;
    if (ageMs > staleThresholdMs) {
      cleaned++;
      return false;
    }
    return true;
  });

  if (cleaned > 0) {
    data.inTransitItems = filtered;
    saveInTransitData(data);
  }

  return cleaned;
}

export function resetInTransitData(): { clearedEntries: number } {
  const data = loadInTransitData();
  const clearedEntries = data.inTransitItems.length;
  data.inTransitItems = [];
  saveInTransitData(data);
  return { clearedEntries };
}

export function getFleetFtSummary(): {
  totalActiveBots: number;
  totalActiveLocks: number;
  locks: Array<{
    bot: string;
    item: string;
    station: string;
    lockedQty: number;
    deliveredQty: number;
    remaining: number;
  }>;
  inTransit: Array<{
    bot: string;
    item: string;
    station: string;
    quantity: number;
  }>;
} {
  const coordData = loadCoordinationData();
  const transitData = loadInTransitData();
  const activeLocks = Object.values(coordData.activeLocks).filter(lock => lock.isActive);
  const uniqueBots = new Set(activeLocks.map(lock => lock.lockedBy));

  return {
    totalActiveBots: uniqueBots.size,
    totalActiveLocks: activeLocks.length,
    locks: activeLocks.map(lock => ({
      bot: lock.lockedBy,
      item: lock.itemName || lock.itemId,
      station: lock.remoteStationId,
      lockedQty: lock.lockedQuantity,
      deliveredQty: lock.deliveredQuantity,
      remaining: Math.max(0, lock.lockedQuantity - lock.deliveredQuantity),
    })),
    inTransit: transitData.inTransitItems.map(entry => ({
      bot: entry.botUsername,
      item: entry.itemName || entry.itemId,
      station: entry.remoteStationId,
      quantity: entry.quantity,
    })),
  };
}
