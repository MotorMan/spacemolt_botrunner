/**
 * Fleet-wide trade coordination for multiple trader bots.
 * 
 * Prevents traders from competing for the same trade routes by:
 * 1. Locking item types to the first trader that starts a trade session
 * 2. Allowing trade "stealing" only when significantly more profitable
 * 3. Considering cargo capacity, source prices, and destination demand
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { loadTraderActivity, type TradeSession, type TraderActivityData } from "./traderActivity.js";

const DATA_DIR = join(process.cwd(), "data");
const COORDINATION_FILE = join(DATA_DIR, "tradeCoordination.json");

/** Represents an active lock on a trade route by a specific bot. */
export interface TradeLock {
  /** The bot username that owns this lock. */
  lockedBy: string;
  /** The item being traded. */
  itemId: string;
  itemName: string;
  /** Source of the trade (where items are bought). */
  sourceSystem: string;
  sourcePoi: string;
  /** Destination of the trade (where items are sold). */
  destSystem: string;
  destPoi: string;
  /** When the lock was acquired. */
  lockedAt: string;
  /** Last activity timestamp (updated as trader progresses). */
  lastActivity: string;
  /** Quantity the trader is carrying/committed to. */
  quantityCommitted: number;
  /** The session ID this lock is associated with. */
  sessionId: string;
  /** Whether this lock can be challenged by other traders. */
  isChallengeable: boolean;
}

export interface TradeCoordinationData {
  _info: string;
  /** Active locks keyed by itemId. */
  activeLocks: Record<string, TradeLock>;
  /** Historical locks (for debugging/analysis). */
  lockHistory: Array<TradeLock & { releasedAt: string; reason: string }>;
}

/** Load the coordination data from disk. */
export function loadCoordinationData(): TradeCoordinationData {
  try {
    if (existsSync(COORDINATION_FILE)) {
      const data = JSON.parse(readFileSync(COORDINATION_FILE, "utf-8"));
      return {
        _info: data._info || "Trade coordination data",
        activeLocks: data.activeLocks || {},
        lockHistory: Array.isArray(data.lockHistory) ? data.lockHistory : [],
      };
    }
  } catch (err) {
    console.warn("Could not load tradeCoordination.json:", err);
  }
  return { _info: "Trade coordination data", activeLocks: {}, lockHistory: [] };
}

/** Save the coordination data to disk. */
export function saveCoordinationData(data: TradeCoordinationData): void {
  try {
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }
    writeFileSync(COORDINATION_FILE, JSON.stringify(data, null, 2) + "\n");
  } catch (err) {
    console.error("Error saving tradeCoordination.json:", err);
  }
}

/** Get all active trade sessions across all bots. */
export function getAllActiveSessions(): TradeSession[] {
  const activity = loadTraderActivity();
  const sessions: TradeSession[] = [];
  
  for (const botData of Object.values(activity)) {
    if (botData.activeSession) {
      sessions.push(botData.activeSession);
    }
  }
  
  return sessions;
}

/** Get all active locks. */
export function getAllActiveLocks(): TradeLock[] {
  const data = loadCoordinationData();
  return Object.values(data.activeLocks);
}

/**
 * Check if an item is currently locked by another trader.
 * Returns the lock info if locked, null if available.
 */
export function getItemLock(itemId: string, excludeBot?: string): TradeLock | null {
  const data = loadCoordinationData();
  const lock = data.activeLocks[itemId];
  
  if (!lock) return null;
  if (excludeBot && lock.lockedBy === excludeBot) return null;
  
  return lock;
}

/**
 * Check if a specific trade route (item + source + dest) is locked.
 * More specific than getItemLock - checks the full route.
 */
export function getRouteLock(
  itemId: string,
  sourceSystem: string,
  sourcePoi: string,
  destSystem: string,
  destPoi: string,
  excludeBot?: string
): TradeLock | null {
  const data = loadCoordinationData();
  
  for (const lock of Object.values(data.activeLocks)) {
    if (lock.itemId !== itemId) continue;
    if (excludeBot && lock.lockedBy === excludeBot) continue;
    
    // Check if routes match (allow some flexibility on POI, strict on system)
    const sourceMatches = lock.sourceSystem === sourceSystem && lock.sourcePoi === sourcePoi;
    const destMatches = lock.destSystem === destSystem && lock.destPoi === destPoi;
    
    if (sourceMatches && destMatches) {
      return lock;
    }
    
    // Also check if just the item+dest matches (competing for same buyer)
    if (lock.destSystem === destSystem && lock.destPoi === destPoi) {
      return lock;
    }
  }
  
  return null;
}

/**
 * Acquire a lock on a trade route.
 * Returns true if lock was acquired, false if already locked by another bot.
 */
export function acquireTradeLock(params: {
  botUsername: string;
  itemId: string;
  itemName: string;
  sourceSystem: string;
  sourcePoi: string;
  destSystem: string;
  destPoi: string;
  quantityCommitted: number;
  sessionId: string;
}): boolean {
  const data = loadCoordinationData();
  const now = new Date().toISOString();
  
  // Check if already locked
  const existingLock = data.activeLocks[params.itemId];
  if (existingLock && existingLock.lockedBy !== params.botUsername) {
    // Already locked by another bot
    return false;
  }
  
  // Create new lock
  const lock: TradeLock = {
    lockedBy: params.botUsername,
    itemId: params.itemId,
    itemName: params.itemName,
    sourceSystem: params.sourceSystem,
    sourcePoi: params.sourcePoi,
    destSystem: params.destSystem,
    destPoi: params.destPoi,
    lockedAt: now,
    lastActivity: now,
    quantityCommitted: params.quantityCommitted,
    sessionId: params.sessionId,
    isChallengeable: true,
  };
  
  data.activeLocks[params.itemId] = lock;
  saveCoordinationData(data);
  
  return true;
}

/**
 * Update the activity timestamp and quantity for an existing lock.
 */
export function updateTradeLock(
  botUsername: string,
  itemId: string,
  updates: { quantityCommitted?: number; sessionId?: string }
): boolean {
  const data = loadCoordinationData();
  const lock = data.activeLocks[itemId];
  
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
  
  saveCoordinationData(data);
  return true;
}

/**
 * Release a trade lock.
 */
export function releaseTradeLock(
  botUsername: string,
  itemId: string,
  reason: string = "completed"
): boolean {
  const data = loadCoordinationData();
  const lock = data.activeLocks[itemId];
  
  if (!lock || lock.lockedBy !== botUsername) {
    return false;
  }
  
  // Move to history
  const historicalLock = {
    ...lock,
    releasedAt: new Date().toISOString(),
    reason,
  };
  
  data.lockHistory.unshift(historicalLock);
  if (data.lockHistory.length > 100) {
    data.lockHistory = data.lockHistory.slice(0, 100);
  }
  
  delete data.activeLocks[itemId];
  saveCoordinationData(data);
  
  return true;
}

/**
 * Evaluate whether a bot can challenge an existing lock.
 * 
 * A challenge is allowed when:
 * 1. The challenger can carry significantly more (2x+) than the current holder
 * 2. The challenger has a much better profit margin (50%+ better)
 * 3. The current holder has been inactive for too long (10+ minutes)
 * 4. The destination has much higher demand than current cargo fulfills
 */
export function canChallengeLock(params: {
  botUsername: string;
  itemId: string;
  sourceSystem: string;
  sourcePoi: string;
  destSystem: string;
  destPoi: string;
  buyPrice: number;
  sellPrice: number;
  quantity: number;
  cargoCapacity: number;
  currentProfit: number;
}): { canChallenge: boolean; reason: string } {
  const lock = getItemLock(params.itemId, params.botUsername);
  
  if (!lock) {
    return { canChallenge: false, reason: "No active lock" };
  }
  
  // Check if it's the same bot (no challenge needed)
  if (lock.lockedBy === params.botUsername) {
    return { canChallenge: false, reason: "Already own this lock" };
  }
  
  // Check if lock is marked as challengeable
  if (!lock.isChallengeable) {
    return { canChallenge: false, reason: "Lock is not challengeable" };
  }
  
  // Check inactivity timeout (10 minutes)
  const lastActivity = new Date(lock.lastActivity).getTime();
  const now = Date.now();
  const inactivityMs = now - lastActivity;
  const inactivityMinutes = inactivityMs / 60000;
  
  if (inactivityMinutes > 10) {
    return { canChallenge: true, reason: `Lock holder inactive for ${inactivityMinutes.toFixed(1)} minutes` };
  }
  
  // Check cargo capacity advantage (challenger must have 2x+ capacity)
  const capacityRatio = params.cargoCapacity / lock.quantityCommitted;
  if (capacityRatio >= 2) {
    return { canChallenge: true, reason: `Can carry ${capacityRatio.toFixed(1)}x more than current holder` };
  }
  
  // Check profit margin advantage (50%+ better)
  const challengerProfitPerUnit = params.sellPrice - params.buyPrice;
  const currentProfitPerUnit = lock.quantityCommitted > 0 
    ? params.currentProfit / lock.quantityCommitted 
    : 0;
  
  if (currentProfitPerUnit > 0 && challengerProfitPerUnit >= currentProfitPerUnit * 1.5) {
    return { canChallenge: true, reason: "Can achieve 50%+ better profit margin" };
  }
  
  return { canChallenge: false, reason: "No advantage over current lock holder" };
}

/**
 * Get the best available trade route considering existing locks.
 *
 * Returns the route if available, or suggests an alternative if the preferred
 * route is locked by another bot.
 */
export function getBestUnlockedRoute<T extends {
  itemId: string;
  itemName: string;
  sourceSystem: string;
  sourcePoi: string;
  destSystem: string;
  destPoi: string;
  buyPrice: number;
  sellPrice: number;
  profitPerUnit: number;
  totalProfit: number;
}>(routes: T[], botUsername: string, cargoCapacity: number): {
  route: T | null;
  reason: string;
  lockedBy?: string;
} {
  for (const route of routes) {
    const lock = getRouteLock(
      route.itemId,
      route.sourceSystem,
      route.sourcePoi,
      route.destSystem,
      route.destPoi,
      botUsername
    );

    if (!lock) {
      // No lock - this route is available
      return { route, reason: "Route is unlocked" };
    }

    // Route is locked - check if we can challenge
    const challengeResult = canChallengeLock({
      botUsername,
      itemId: route.itemId,
      sourceSystem: route.sourceSystem,
      sourcePoi: route.sourcePoi,
      destSystem: route.destSystem,
      destPoi: route.destPoi,
      buyPrice: route.buyPrice,
      sellPrice: route.sellPrice,
      quantity: 1, // Use 1 as default - actual quantity doesn't affect challenge logic
      cargoCapacity,
      currentProfit: route.totalProfit,
    });

    if (challengeResult.canChallenge) {
      // We can challenge this lock
      return { 
        route, 
        reason: `Challenging lock: ${challengeResult.reason}`,
        lockedBy: lock.lockedBy,
      };
    }

    // Can't challenge - try next route
  }

  // No routes available
  const firstRoute = routes[0];
  if (firstRoute) {
    const lock = getItemLock(firstRoute.itemId);
    return { 
      route: null, 
      reason: "All routes are locked by other bots",
      lockedBy: lock?.lockedBy,
    };
  }

  return { route: null, reason: "No routes available" };
}

/**
 * Clean up stale locks (locks for sessions that no longer exist).
 * Should be called periodically to prevent lock leaks.
 */
export function cleanupStaleLocks(): number {
  const data = loadCoordinationData();
  const sessions = getAllActiveSessions();
  const activeSessionIds = new Set(sessions.map(s => s.sessionId));
  
  let cleaned = 0;
  
  for (const [itemId, lock] of Object.entries(data.activeLocks)) {
    if (!activeSessionIds.has(lock.sessionId)) {
      // Session no longer exists - release the lock
      const historicalLock = {
        ...lock,
        releasedAt: new Date().toISOString(),
        reason: "stale_cleanup",
      };
      
      data.lockHistory.unshift(historicalLock);
      delete data.activeLocks[itemId];
      cleaned++;
      
      console.log(`[TradeCoord] Cleaned up stale lock: ${itemId} (was held by ${lock.lockedBy})`);
    }
  }
  
  if (cleaned > 0) {
    if (data.lockHistory.length > 100) {
      data.lockHistory = data.lockHistory.slice(0, 100);
    }
    saveCoordinationData(data);
  }
  
  return cleaned;
}

/**
 * Get a summary of fleet trading activity.
 */
export function getFleetTradingSummary(): {
  totalActiveTraders: number;
  totalLockedItems: number;
  locks: Array<{ bot: string; item: string; quantity: number; route: string }>;
} {
  const sessions = getAllActiveSessions();
  const locks = getAllActiveLocks();
  
  return {
    totalActiveTraders: sessions.length,
    totalLockedItems: locks.length,
    locks: locks.map(lock => ({
      bot: lock.lockedBy,
      item: lock.itemName,
      quantity: lock.quantityCommitted,
      route: `${lock.sourceSystem} → ${lock.destSystem}`,
    })),
  };
}
