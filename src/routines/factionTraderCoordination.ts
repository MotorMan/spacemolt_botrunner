/**
 * Faction trader coordination to prevent multiple bots from targeting
 * the same destination buy orders.
 *
 * A claim covers an entire (item, station) book — NOT a single price point.
 *
 * The original design keyed locks by `item + POI + price`. That could not work:
 * a market `sell` fills from the top of the book downwards across every price
 * level, but the key pinned only one level, and the level's price changes as the
 * book fills. Two bots that planned against slightly different `best_buy`
 * snapshots produced two different keys for the same station and both committed.
 * The observed failure was two of our own bots carrying fuel cells to Node Alpha
 * Processing Station: the first swept all four good levels (3721/3646/3645/3619),
 * the second arrived a tick later and its market order swept straight through to
 * a 50cr junk bid — a 29288cr trade realised for 400cr.
 *
 * The key is therefore `item + POI` only, and `quantityCommitted` reserves book
 * depth so a genuinely deep book can still be shared by several bots.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { loadTraderActivity } from "./traderActivity.js";

const DATA_DIR = join(process.cwd(), "data");
const COORDINATION_FILE = join(DATA_DIR, "factionTradeCoordination.json");

/**
 * How long a claim may exist without a trade session behind it.
 *
 * A route is claimed at selection time but the session is only created once the
 * cargo is aboard, so there is always a legitimate sessionless window. The old
 * cleanup reaped anything without a live session immediately, which is why every
 * entry in the lock history reads `stale_cleanup` — claims were being freed out
 * from under the bot that owned them, letting a second bot take the same book.
 */
const LOCK_CLAIM_GRACE_MS = 5 * 60_000;

/** Hard ceiling on claim age, so a crashed run can never park a book forever. */
const LOCK_MAX_IDLE_MS = 90 * 60_000;

/** Unique key identifying a claim on one station's buy-side book for one item. */
export function getBuyOrderKey(itemId: string, poiId: string): string {
  return `faction_buy:${itemId}:${poiId}`;
}

export interface FactionTradeLock {
  lockedBy: string;
  buyOrderKey: string;
  itemId: string;
  itemName: string;
  destSystem: string;
  destPoi: string;
  destPoiName: string;
  /** Best buy price observed when the claim was made. Informational only — never part of the key. */
  pricePerUnit: number;
  /** Book depth this bot intends to consume. Subtracted from what other bots may claim. */
  quantityCommitted: number;
  lockedAt: string;
  lastActivity: string;
  /** Empty until the trade session exists; see LOCK_CLAIM_GRACE_MS. */
  sessionId: string;
}

export interface FactionCoordinationData {
  _info: string;
  activeLocks: Record<string, FactionTradeLock>;
  lockHistory: Array<FactionTradeLock & { releasedAt: string; reason: string }>;
}

/**
 * Re-key any legacy `faction_buy:item:poi:price` entries onto the price-free key.
 * When two legacy price levels at one station collapse onto the same key the
 * older claim wins and their committed depth is merged, so no reservation is lost.
 */
function migrateLegacyKeys(activeLocks: Record<string, FactionTradeLock>): Record<string, FactionTradeLock> {
  const migrated: Record<string, FactionTradeLock> = {};

  for (const lock of Object.values(activeLocks)) {
    if (!lock || !lock.itemId || !lock.destPoi) continue;

    const key = getBuyOrderKey(lock.itemId, lock.destPoi);
    const existing = migrated[key];

    if (!existing) {
      migrated[key] = { ...lock, buyOrderKey: key, sessionId: lock.sessionId || "" };
      continue;
    }

    // Same station+item claimed at two price levels: keep the earliest claim and
    // fold the depth together so the reservation stays conservative.
    const keepExisting = Date.parse(existing.lockedAt) <= Date.parse(lock.lockedAt);
    const winner = keepExisting ? existing : lock;
    migrated[key] = {
      ...winner,
      buyOrderKey: key,
      sessionId: winner.sessionId || "",
      quantityCommitted: (existing.quantityCommitted || 0) + (lock.quantityCommitted || 0),
    };
  }

  return migrated;
}

export function loadFactionCoordinationData(): FactionCoordinationData {
  try {
    if (existsSync(COORDINATION_FILE)) {
      const data = JSON.parse(readFileSync(COORDINATION_FILE, "utf-8"));
      return {
        _info: data._info || "Faction trader coordination data",
        activeLocks: migrateLegacyKeys(data.activeLocks || {}),
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

/** Check whether another bot has claimed this station's book for this item. */
export function getBuyOrderLock(
  itemId: string,
  poiId: string,
  excludeBot?: string
): FactionTradeLock | null {
  const data = loadFactionCoordinationData();
  const lock = data.activeLocks[getBuyOrderKey(itemId, poiId)];

  if (!lock) return null;
  if (excludeBot && lock.lockedBy === excludeBot) return null;

  return lock;
}

/**
 * Book depth already reserved at this station by OTHER bots.
 *
 * Route planning subtracts this from the demand it can see, so a second bot only
 * ever plans against the depth the first one is not going to consume.
 */
export function getReservedQuantity(
  itemId: string,
  poiId: string,
  excludeBot?: string
): number {
  const lock = getBuyOrderLock(itemId, poiId, excludeBot);
  return lock ? Math.max(0, lock.quantityCommitted || 0) : 0;
}

/**
 * Claim a station's book for an item. Returns false when another bot holds it.
 *
 * Call this at route-selection time, not at departure. The old code checked the
 * lock during selection but did not acquire until ~700 lines later, after the
 * cargo was withdrawn — a time-of-check/time-of-use window wide enough for two
 * bots to pass the same check and both commit to the same buyer.
 */
export function acquireBuyOrderLock(params: {
  botUsername: string;
  itemId: string;
  itemName: string;
  destSystem: string;
  destPoi: string;
  destPoiName: string;
  pricePerUnit: number;
  quantityCommitted: number;
  /** Omit while the claim precedes session creation. */
  sessionId?: string;
}): boolean {
  const data = loadFactionCoordinationData();
  const key = getBuyOrderKey(params.itemId, params.destPoi);
  const now = new Date().toISOString();

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
    // Preserve the original claim time on re-acquire so the grace window cannot
    // be reset indefinitely by a bot that keeps re-claiming the same book.
    lockedAt: existing?.lockedAt || now,
    lastActivity: now,
    sessionId: params.sessionId ?? existing?.sessionId ?? "",
  };

  saveFactionCoordinationData(data);
  return true;
}

/** Refresh an existing claim's activity timestamp, committed depth, or session id. */
export function updateBuyOrderLock(
  botUsername: string,
  itemId: string,
  poiId: string,
  updates: { quantityCommitted?: number; sessionId?: string; pricePerUnit?: number }
): boolean {
  const data = loadFactionCoordinationData();
  const key = getBuyOrderKey(itemId, poiId);
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
  if (updates.pricePerUnit !== undefined) {
    lock.pricePerUnit = updates.pricePerUnit;
  }

  saveFactionCoordinationData(data);
  return true;
}

/** Release a claim. */
export function releaseBuyOrderLock(
  botUsername: string,
  itemId: string,
  poiId: string,
  reason: string = "completed"
): boolean {
  const data = loadFactionCoordinationData();
  const key = getBuyOrderKey(itemId, poiId);
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

/**
 * Reap claims that no longer belong to a live run.
 *
 * A claim survives when it has a live session, or when it is still inside the
 * sessionless grace window (route selected, cargo not yet loaded). Anything else
 * — dead session, sessionless past the grace window, or idle past the hard
 * ceiling — is released.
 */
export function cleanupStaleFactionLocks(): number {
  const data = loadFactionCoordinationData();
  const activity = loadTraderActivity();
  const activeSessionIds = new Set<string>();

  for (const botData of Object.values(activity)) {
    if (botData.activeSession) {
      activeSessionIds.add(botData.activeSession.sessionId);
    }
  }

  const now = Date.now();
  let cleaned = 0;

  for (const [key, lock] of Object.entries(data.activeLocks)) {
    const claimedAt = Date.parse(lock.lockedAt);
    const activeAt = Date.parse(lock.lastActivity || lock.lockedAt);
    const claimAge = Number.isNaN(claimedAt) ? Infinity : now - claimedAt;
    const idleFor = Number.isNaN(activeAt) ? Infinity : now - activeAt;

    let reason: string | null = null;
    if (idleFor > LOCK_MAX_IDLE_MS) {
      reason = "stale_cleanup_idle";
    } else if (lock.sessionId) {
      if (!activeSessionIds.has(lock.sessionId)) reason = "stale_cleanup_session_gone";
    } else if (claimAge > LOCK_CLAIM_GRACE_MS) {
      reason = "stale_cleanup_claim_expired";
    }

    if (!reason) continue;

    data.lockHistory.unshift({
      ...lock,
      releasedAt: new Date().toISOString(),
      reason,
    });
    delete data.activeLocks[key];
    cleaned++;

    console.log(`[FactionCoord] Cleaned stale lock: ${key} (was held by ${lock.lockedBy}, ${reason})`);
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
