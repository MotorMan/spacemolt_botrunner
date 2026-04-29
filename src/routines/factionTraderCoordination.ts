/**
 * Faction trader coordination to prevent multiple bots from targeting
 * the same destination buy orders. Locks are keyed by unique buy order
 * identifiers (item + POI + price) instead of item IDs.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { loadTraderActivity, type TradeSession } from "./traderActivity.js";

const DATA_DIR = join(process.cwd(), "data");
const COORDINATION_FILE = join(DATA_DIR, "factionTradeCoordination.json");

/** Unique key to identify a buy order: item + POI + price per unit */
export function getBuyOrderKey(itemId: string, poiId: string, pricePerUnit: number): string {
  return `faction_buy:${itemId}:${poiId}:${pricePerUnit}`;
}

export interface FactionTradeLock {
  lockedBy: string;
  buyOrderKey: string;
  itemId: string;
  itemName: string;
  destSystem: string;
  destPoi: string;
  destPoiName: string;
  pricePerUnit: number;
  quantityCommitted: number;
  lockedAt: string;
  lastActivity: string;
  sessionId: string;
}

export interface FactionCoordinationData {
  _info: string;
  activeLocks: Record<string, FactionTradeLock>;
  lockHistory: Array<FactionTradeLock & { releasedAt: string; reason: string }>;
}

export function loadFactionCoordinationData(): FactionCoordinationData {
  try {
    if (existsSync(COORDINATION_FILE)) {
      const data = JSON.parse(readFileSync(COORDINATION_FILE, "utf-8"));
      return {
        _info: data._info || "Faction trader coordination data",
        activeLocks: data.activeLocks || {},
        lockHistory: Array.isArray(data.lockHistory) ? data.lockHistory : [],
      };
    }
  } catch (err) {
    console.warn("Could not load factionTradeCoordination.json:", err);
  }
  return { _info: "Faction trader coordination data", activeLocks: {}, lockHistory: [] };
}

export function saveFactionCoordinationData(data: FactionCoordinationData): void {
  try {
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }
    writeFileSync(COORDINATION_FILE, JSON.stringify(data, null, 2) + "\n");
  } catch (err) {
    console.error("Error saving factionTradeCoordination.json:", err);
  }
}

/** Check if a buy order is locked by another bot */
export function getBuyOrderLock(
  itemId: string,
  poiId: string,
  pricePerUnit: number,
  excludeBot?: string
): FactionTradeLock | null {
  const data = loadFactionCoordinationData();
  const key = getBuyOrderKey(itemId, poiId, pricePerUnit);
  const lock = data.activeLocks[key];
  
  if (!lock) return null;
  if (excludeBot && lock.lockedBy === excludeBot) return null;
  
  return lock;
}

/** Acquire a lock on a buy order. Returns true if successful. */
export function acquireBuyOrderLock(params: {
  botUsername: string;
  itemId: string;
  itemName: string;
  destSystem: string;
  destPoi: string;
  destPoiName: string;
  pricePerUnit: number;
  quantityCommitted: number;
  sessionId: string;
}): boolean {
  const data = loadFactionCoordinationData();
  const key = getBuyOrderKey(params.itemId, params.destPoi, params.pricePerUnit);
  const now = new Date().toISOString();
  
  // Check if already locked by another bot
  const existing = data.activeLocks[key];
  if (existing && existing.lockedBy !== params.botUsername) {
    return false;
  }
  
  data.activeLocks[key] = {
    lockedBy: params.botUsername,
    buyOrderKey: key,
    itemId: params.itemId,
    itemName: params.itemName,
    destSystem: params.destSystem,
    destPoi: params.destPoi,
    destPoiName: params.destPoiName,
    pricePerUnit: params.pricePerUnit,
    quantityCommitted: params.quantityCommitted,
    lockedAt: now,
    lastActivity: now,
    sessionId: params.sessionId,
  };
  
  saveFactionCoordinationData(data);
  return true;
}

/** Update an existing lock's activity timestamp or quantity */
export function updateBuyOrderLock(
  botUsername: string,
  itemId: string,
  poiId: string,
  pricePerUnit: number,
  updates: { quantityCommitted?: number; sessionId?: string }
): boolean {
  const data = loadFactionCoordinationData();
  const key = getBuyOrderKey(itemId, poiId, pricePerUnit);
  const lock = data.activeLocks[key];
  
  if (!lock || lock.lockedBy !== botUsername) {
    return false;
  }
  
  lock.lastActivity = new Date().toISOString();
  if (updates.quantityCommitted !== undefined) {
    lock.quantityCommitted = updates.quantityCommitted;
  }
  if (updates.sessionId !== undefined) {
    lock.sessionId = updates.sessionId;
  }
  
  saveFactionCoordinationData(data);
  return true;
}

/** Release a buy order lock */
export function releaseBuyOrderLock(
  botUsername: string,
  itemId: string,
  poiId: string,
  pricePerUnit: number,
  reason: string = "completed"
): boolean {
  const data = loadFactionCoordinationData();
  const key = getBuyOrderKey(itemId, poiId, pricePerUnit);
  const lock = data.activeLocks[key];
  
  if (!lock || lock.lockedBy !== botUsername) {
    return false;
  }
  
  const historicalLock = {
    ...lock,
    releasedAt: new Date().toISOString(),
    reason,
  };
  
  data.lockHistory.unshift(historicalLock);
  if (data.lockHistory.length > 100) {
    data.lockHistory = data.lockHistory.slice(0, 100);
  }
  
  delete data.activeLocks[key];
  saveFactionCoordinationData(data);
  
  return true;
}

/** Clean up stale locks where the associated session no longer exists */
export function cleanupStaleFactionLocks(): number {
  const data = loadFactionCoordinationData();
  const activity = loadTraderActivity();
  const activeSessionIds = new Set<string>();
  
  for (const botData of Object.values(activity)) {
    if (botData.activeSession) {
      activeSessionIds.add(botData.activeSession.sessionId);
    }
  }
  
  let cleaned = 0;
  for (const [key, lock] of Object.entries(data.activeLocks)) {
    if (!activeSessionIds.has(lock.sessionId)) {
      const historicalLock = {
        ...lock,
        releasedAt: new Date().toISOString(),
        reason: "stale_cleanup",
      };
      
      data.lockHistory.unshift(historicalLock);
      delete data.activeLocks[key];
      cleaned++;
      
      console.log(`[FactionCoord] Cleaned stale lock: ${key} (was held by ${lock.lockedBy})`);
    }
  }
  
  if (cleaned > 0) {
    if (data.lockHistory.length > 100) {
      data.lockHistory = data.lockHistory.slice(0, 100);
    }
    saveFactionCoordinationData(data);
  }
  
  return cleaned;
}

/** Get all active locks for debugging */
export function getAllActiveFactionLocks(): FactionTradeLock[] {
  const data = loadFactionCoordinationData();
  return Object.values(data.activeLocks);
}
