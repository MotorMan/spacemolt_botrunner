/**
 * Fleet-wide cargo mover coordination for multiple bots.
 * 
 * Prevents bots from competing for the same items by:
 * 1. Locking item quantities (not entire items) so multiple bots can contribute
 * 2. Tracking how much of an item each bot has claimed
 * 3. Allowing bots to see remaining available quantities
 * 4. Automatic lock expiration on inactivity
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const DATA_DIR = join(process.cwd(), "data");
const COORDINATION_FILE = join(DATA_DIR, "cargoMoverCoordination.json");

/** Represents a quantity lock on an item by a specific bot. */
export interface ItemQuantityLock {
  /** The bot username that owns this lock. */
  lockedBy: string;
  /** The item being moved. */
  itemId: string;
  itemName: string;
  /** How much of this item the bot has claimed. */
  lockedQuantity: number;
  /** Total quantity available in storage when locked. */
  totalAvailable: number;
  /** Source station being used. */
  sourceStation: string;
  /** Destination station being used. */
  destinationStation: string;
  /** When the lock was acquired. */
  lockedAt: string;
  /** Last activity timestamp (updated as bot progresses). */
  lastActivity: string;
  /** How much has been successfully delivered. */
  deliveredQuantity: number;
  /** Current trip number. */
  currentTrip: number;
  /** Whether this lock is still active. */
  isActive: boolean;
}

export interface CargoMoverCoordinationData {
  _info: string;
  /** Active quantity locks keyed by `${itemId}:${botUsername}`. */
  activeLocks: Record<string, ItemQuantityLock>;
  /** Historical locks (for debugging/analysis). */
  lockHistory: Array<ItemQuantityLock & { releasedAt: string; reason: string }>;
  /** Global item tracking: total moved per item across all bots. */
  globalItemTracking: Record<string, {
    itemId: string;
    itemName: string;
    totalWithdrawn: number;
    totalDelivered: number;
    totalLost: number;
    lastUpdated: string;
  }>;
}

/** Load the coordination data from disk. */
export function loadCoordinationData(): CargoMoverCoordinationData {
  try {
    if (existsSync(COORDINATION_FILE)) {
      const data = JSON.parse(readFileSync(COORDINATION_FILE, "utf-8"));
      return {
        _info: data._info || "Cargo mover coordination data",
        activeLocks: data.activeLocks || {},
        lockHistory: Array.isArray(data.lockHistory) ? data.lockHistory : [],
        globalItemTracking: data.globalItemTracking || {},
      };
    }
  } catch (err) {
    console.warn("Could not load cargoMoverCoordination.json:", err);
  }
  return {
    _info: "Cargo mover coordination data",
    activeLocks: {},
    lockHistory: [],
    globalItemTracking: {},
  };
}

/** Save the coordination data to disk. */
export function saveCoordinationData(data: CargoMoverCoordinationData): void {
  try {
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }
    writeFileSync(COORDINATION_FILE, JSON.stringify(data, null, 2) + "\n");
  } catch (err) {
    console.error("Error saving cargoMoverCoordination.json:", err);
  }
}

/** Generate a lock key. */
function lockKey(itemId: string, botUsername: string): string {
  return `${itemId}:${botUsername}`;
}

/**
 * Get all active locks for a specific item.
 */
export function getItemLocks(itemId: string): ItemQuantityLock[] {
  const data = loadCoordinationData();
  return Object.values(data.activeLocks).filter(lock => lock.itemId === itemId && lock.isActive);
}

/**
 * Get the lock for a specific bot and item.
 */
export function getBotItemLock(botUsername: string, itemId: string): ItemQuantityLock | null {
  const data = loadCoordinationData();
  const key = lockKey(itemId, botUsername);
  const lock = data.activeLocks[key];
  return (lock && lock.isActive) ? lock : null;
}

/**
 * Get all active locks for a specific bot.
 */
export function getBotLocks(botUsername: string): ItemQuantityLock[] {
  const data = loadCoordinationData();
  return Object.values(data.activeLocks).filter(lock => lock.lockedBy === botUsername && lock.isActive);
}

/**
 * Calculate how much of an item is still available (not locked by other bots).
 */
export function getAvailableItemQuantity(
  itemId: string,
  totalInStorage: number,
  excludeBot?: string
): number {
  const locks = getItemLocks(itemId);
  const lockedByOthers = locks
    .filter(lock => !excludeBot || lock.lockedBy !== excludeBot)
    .reduce((sum, lock) => {
      const remaining = lock.lockedQuantity - lock.deliveredQuantity;
      return sum + Math.max(0, remaining);
    }, 0);
  
  return Math.max(0, totalInStorage - lockedByOthers);
}

/**
 * Calculate how much of an item a specific bot has already claimed.
 */
export function getBotClaimedQuantity(botUsername: string, itemId: string): number {
  const lock = getBotItemLock(botUsername, itemId);
  return lock ? lock.lockedQuantity : 0;
}

/**
 * Acquire or update a quantity lock on an item.
 * 
 * @returns Object with success status and message.
 */
export function acquireQuantityLock(params: {
  botUsername: string;
  itemId: string;
  itemName: string;
  quantity: number;
  totalAvailable: number;
  sourceStation: string;
  destinationStation: string;
}): { success: boolean; message: string; lock?: ItemQuantityLock } {
  const data = loadCoordinationData();
  const key = lockKey(params.itemId, params.botUsername);
  const now = new Date().toISOString();

  // Check if bot already has a lock for this item
  const existingLock = data.activeLocks[key];
  if (existingLock && existingLock.isActive) {
    // Update existing lock
    existingLock.lastActivity = now;
    existingLock.lockedQuantity = params.quantity;
    existingLock.totalAvailable = params.totalAvailable;
    existingLock.currentTrip = (existingLock.currentTrip || 0) + 1;
    saveCoordinationData(data);
    return { success: true, message: "Updated existing lock", lock: existingLock };
  }

  // Create new lock
  const lock: ItemQuantityLock = {
    lockedBy: params.botUsername,
    itemId: params.itemId,
    itemName: params.itemName,
    lockedQuantity: params.quantity,
    totalAvailable: params.totalAvailable,
    sourceStation: params.sourceStation,
    destinationStation: params.destinationStation,
    lockedAt: now,
    lastActivity: now,
    deliveredQuantity: 0,
    currentTrip: 1,
    isActive: true,
  };

  data.activeLocks[key] = lock;

  // Update global tracking
  if (!data.globalItemTracking[params.itemId]) {
    data.globalItemTracking[params.itemId] = {
      itemId: params.itemId,
      itemName: params.itemName,
      totalWithdrawn: 0,
      totalDelivered: 0,
      totalLost: 0,
      lastUpdated: now,
    };
  }

  saveCoordinationData(data);
  return { success: true, message: "Acquired new lock", lock };
}

/**
 * Update the delivered quantity for a lock.
 */
export function updateDeliveredQuantity(
  botUsername: string,
  itemId: string,
  deliveredQty: number
): boolean {
  const data = loadCoordinationData();
  const key = lockKey(itemId, botUsername);
  const lock = data.activeLocks[key];

  if (!lock || !lock.isActive) return false;

  lock.deliveredQuantity += deliveredQty;
  lock.lastActivity = new Date().toISOString();

  // Update global tracking
  const tracking = data.globalItemTracking[itemId];
  if (tracking) {
    tracking.totalDelivered += deliveredQty;
    tracking.lastUpdated = new Date().toISOString();
  }

  saveCoordinationData(data);
  return true;
}

/**
 * Update the withdrawn quantity for global tracking.
 */
export function updateWithdrawnQuantity(
  itemId: string,
  withdrawnQty: number
): void {
  const data = loadCoordinationData();
  const now = new Date().toISOString();

  if (!data.globalItemTracking[itemId]) {
    data.globalItemTracking[itemId] = {
      itemId,
      itemName: "",
      totalWithdrawn: 0,
      totalDelivered: 0,
      totalLost: 0,
      lastUpdated: now,
    };
  }

  data.globalItemTracking[itemId].totalWithdrawn += withdrawnQty;
  data.globalItemTracking[itemId].lastUpdated = now;
  saveCoordinationData(data);
}

/**
 * Release a quantity lock.
 */
export function releaseQuantityLock(
  botUsername: string,
  itemId: string,
  reason: string = "completed"
): boolean {
  const data = loadCoordinationData();
  const key = lockKey(itemId, botUsername);
  const lock = data.activeLocks[key];

  if (!lock || !lock.isActive) return false;

  // Calculate lost quantity
  const lostQty = lock.lockedQuantity - lock.deliveredQuantity;
  if (lostQty > 0) {
    const tracking = data.globalItemTracking[itemId];
    if (tracking) {
      tracking.totalLost += lostQty;
      tracking.lastUpdated = new Date().toISOString();
    }
  }

  // Move to history
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

/**
 * Update the last activity timestamp for a lock.
 */
export function updateLockActivity(botUsername: string, itemId: string): boolean {
  const data = loadCoordinationData();
  const key = lockKey(itemId, botUsername);
  const lock = data.activeLocks[key];

  if (!lock || !lock.isActive) return false;

  lock.lastActivity = new Date().toISOString();
  saveCoordinationData(data);
  return true;
}

/**
 * Clean up stale locks (locks with no activity for 15+ minutes).
 * Should be called periodically to prevent lock leaks.
 */
export function cleanupStaleLocks(): number {
  const data = loadCoordinationData();
  const now = Date.now();
  const staleThresholdMs = 15 * 60 * 1000; // 15 minutes
  let cleaned = 0;

  for (const [key, lock] of Object.entries(data.activeLocks)) {
    if (!lock.isActive) continue;

    const lastActivity = new Date(lock.lastActivity).getTime();
    const inactivityMs = now - lastActivity;

    if (inactivityMs > staleThresholdMs) {
      // Calculate lost quantity
      const lostQty = lock.lockedQuantity - lock.deliveredQuantity;
      if (lostQty > 0) {
        const tracking = data.globalItemTracking[lock.itemId];
        if (tracking) {
          tracking.totalLost += lostQty;
          tracking.lastUpdated = new Date().toISOString();
        }
      }

      const historicalLock = {
        ...lock,
        releasedAt: new Date().toISOString(),
        reason: "stale_cleanup",
      };

      data.lockHistory.unshift(historicalLock);
      lock.isActive = false;
      cleaned++;

      console.log(`[CargoMoverCoord] Cleaned up stale lock: ${lock.itemId} (was held by ${lock.lockedBy})`);
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

/**
 * Get a summary of fleet cargo moving activity.
 */
export function getFleetCargoMoverSummary(): {
  totalActiveBots: number;
  totalActiveLocks: number;
  locks: Array<{
    bot: string;
    item: string;
    lockedQty: number;
    deliveredQty: number;
    remaining: number;
    source: string;
    destination: string;
  }>;
  globalTracking: Array<{
    item: string;
    totalWithdrawn: number;
    totalDelivered: number;
    totalLost: number;
  }>;
} {
  const data = loadCoordinationData();
  const activeLocks = Object.values(data.activeLocks).filter(lock => lock.isActive);
  const uniqueBots = new Set(activeLocks.map(lock => lock.lockedBy));

  return {
    totalActiveBots: uniqueBots.size,
    totalActiveLocks: activeLocks.length,
    locks: activeLocks.map(lock => ({
      bot: lock.lockedBy,
      item: lock.itemName,
      lockedQty: lock.lockedQuantity,
      deliveredQty: lock.deliveredQuantity,
      remaining: Math.max(0, lock.lockedQuantity - lock.deliveredQuantity),
      source: lock.sourceStation,
      destination: lock.destinationStation,
    })),
    globalTracking: Object.values(data.globalItemTracking).map(tracking => ({
      item: tracking.itemName || tracking.itemId,
      totalWithdrawn: tracking.totalWithdrawn,
      totalDelivered: tracking.totalDelivered,
      totalLost: tracking.totalLost,
    })),
  };
}

/**
 * Check if a bot can claim more of an item (quantity-based locking).
 * 
 * @returns Object with whether the bot can claim and how much is available.
 */
export function canClaimItemQuantity(
  botUsername: string,
  itemId: string,
  requestedQty: number,
  totalInStorage: number
): { canClaim: boolean; availableQty: number; alreadyClaimed: number; reason: string } {
  const locks = getItemLocks(itemId);
  const botLock = locks.find(lock => lock.lockedBy === botUsername);
  
  // Calculate how much is already claimed by other bots
  const claimedByOthers = locks
    .filter(lock => lock.lockedBy !== botUsername)
    .reduce((sum, lock) => {
      const remaining = lock.lockedQuantity - lock.deliveredQuantity;
      return sum + Math.max(0, remaining);
    }, 0);

  const availableQty = Math.max(0, totalInStorage - claimedByOthers);
  const alreadyClaimed = botLock ? (botLock.lockedQuantity - botLock.deliveredQuantity) : 0;

  if (botLock && botLock.isActive) {
    // Bot already has a lock - can continue
    return {
      canClaim: true,
      availableQty,
      alreadyClaimed,
      reason: "Already have active lock",
    };
  }

  if (availableQty <= 0) {
    return {
      canClaim: false,
      availableQty: 0,
      alreadyClaimed: 0,
      reason: "All quantity claimed by other bots",
    };
  }

  if (requestedQty > availableQty) {
    return {
      canClaim: true,
      availableQty,
      alreadyClaimed: 0,
      reason: `Can only claim ${availableQty} of ${requestedQty} requested`,
    };
  }

  return {
    canClaim: true,
    availableQty,
    alreadyClaimed: 0,
    reason: "Quantity available",
  };
}
