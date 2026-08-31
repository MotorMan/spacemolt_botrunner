/**
 * Cargo Mover activity persistence for tracking item movements across sessions.
 * 
 * Provides:
 * - Persistent tracking of item withdrawals and deposits
 * - Delivery progress tracking per item per bot
 * - Activity logging for debugging and monitoring
 * - Session recovery after interruptions
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { loadInTransitData } from "./cargoMoverInTransit.js";

const DATA_DIR = join(process.cwd(), "data");
const ACTIVITY_FILE = join(DATA_DIR, "cargoMoverActivity.json");

/** Represents a single item movement operation. */
export interface CargoMovement {
  /** Unique ID for this movement operation. */
  movementId: string;
  /** Bot username performing the movement. */
  botUsername: string;
  /** Item being moved. */
  itemId: string;
  itemName: string;
  /** Quantity withdrawn from source. */
  withdrawnQty: number;
  /** Quantity successfully deposited at destination. */
  depositedQty: number;
  /** Quantity lost (withdrawn but not deposited). */
  lostQty: number;
  /** Source station ID. */
  sourceStation: string;
  /** Source system ID. */
  sourceSystem: string;
  /** Destination station ID. */
  destinationStation: string;
  /** Destination system ID. */
  destinationSystem: string;
  /** Storage type at source. */
  storageType: "faction" | "personal";
  /** Storage type at destination. */
  destinationStorageType: "faction" | "personal" | "send_gift";
  /** Destination bot name (if send_gift). */
  destinationBotName?: string;
  /** When the withdrawal started. */
  startedAt: string;
  /** When the deposit completed. */
  completedAt?: string;
  /** Current state of this movement. */
  state: CargoMovementState;
  /** Trip number in the current session. */
  tripNumber: number;
  /** Notes about this movement (errors, retries, etc.). */
  notes?: string;
}

export type CargoMovementState =
  | "withdrawing"
  | "in_transit_to_dest"
  | "depositing"
  | "completed"
  | "failed"
  | "interrupted";

/** Tracks overall progress for an item configuration. */
export interface ItemDeliveryProgress {
  /** Item ID. */
  itemId: string;
  /** Item name. */
  itemName: string;
  /** Bot username. */
  botUsername: string;
  /** Total quantity configured to move. */
  targetQuantity: number;
  /** Total quantity withdrawn from source. */
  totalWithdrawn: number;
  /** Total quantity successfully delivered. */
  totalDelivered: number;
  /** Total quantity lost during transit. */
  totalLost: number;
  /** Number of trips made for this item. */
  totalTrips: number;
  /** When tracking started. */
  startedAt: string;
  /** When last updated. */
  lastUpdatedAt: string;
  /** Whether this item delivery is complete. */
  isComplete: boolean;
  /** Storage type being used. */
  storageType: "faction" | "personal";
}

/** Activity log entry for detailed auditing. */
export interface CargoActivityLog {
  /** Timestamp of the activity. */
  timestamp: string;
  /** Bot username. */
  botUsername: string;
  /** Activity type. */
  type: CargoActivityType;
  /** Item ID (if applicable). */
  itemId?: string;
  /** Item name (if applicable). */
  itemName?: string;
  /** Quantity (if applicable). */
  quantity?: number;
  /** Location info (system/station). */
  location?: string;
  /** Detailed message. */
  message: string;
  /** Error details (if applicable). */
  error?: string;
}

export type CargoActivityType =
  | "session_start"
  | "session_end"
  | "navigation"
  | "dock"
  | "undock"
  | "withdraw_start"
  | "withdraw_success"
  | "withdraw_failed"
  | "cargo_loaded"
  | "in_transit"
  | "arrived_destination"
  | "deposit_start"
  | "deposit_success"
  | "deposit_failed"
  | "trip_complete"
  | "refuel"
  | "repair"
  | "fuel_cells"
  | "cloak"
  | "battle_encounter"
  | "battle_escaped"
  | "death_recovery"
  | "error"
  | "lock_acquired"
  | "lock_released"
  | "lock_conflict"
  | "interruption"
  | "resume"
  | "graceful_stop"
  | "load_verify"
  | "load_verify_failed";

export interface CargoMoverActivityData {
  /** Active movements keyed by movementId. */
  activeMovements: Record<string, CargoMovement>;
  /** Completed movements history (last 200). */
  movementHistory: CargoMovement[];
  /** Item delivery progress per bot per item. */
  itemProgress: Record<string, ItemDeliveryProgress>; // key: `${botUsername}:${itemId}`
  /** Activity log (last 500 entries). */
  activityLog: CargoActivityLog[];
  /** Last session state for recovery. */
  lastSession?: {
    botUsername: string;
    sourceStation: string;
    destinationStation: string;
    items: Array<{ itemId: string; itemName: string; quantity: number; storageType: "faction" | "personal" }>;
    currentTrip: number;
    lastAction: string;
    lastSystem: string;
    lastStation: string;
    docked: boolean;
    timestamp: string;
  };
}

/** Load cargo mover activity data from disk. */
export function loadCargoMoverActivity(): CargoMoverActivityData {
  try {
    if (existsSync(ACTIVITY_FILE)) {
      const data = JSON.parse(readFileSync(ACTIVITY_FILE, "utf-8"));
      return {
        activeMovements: data.activeMovements || {},
        movementHistory: Array.isArray(data.movementHistory) ? data.movementHistory : [],
        itemProgress: data.itemProgress || {},
        activityLog: Array.isArray(data.activityLog) ? data.activityLog : [],
        lastSession: data.lastSession,
      };
    }
  } catch (err) {
    console.warn("Could not load cargoMoverActivity.json:", err);
  }
  return {
    activeMovements: {},
    movementHistory: [],
    itemProgress: {},
    activityLog: [],
    lastSession: undefined,
  };
}

/** Save cargo mover activity data to disk. */
export function saveCargoMoverActivity(data: CargoMoverActivityData): void {
  try {
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }
    writeFileSync(ACTIVITY_FILE, JSON.stringify(data, null, 2) + "\n");
  } catch (err) {
    console.error("Error saving cargoMoverActivity.json:", err);
  }
}

/** Generate a unique movement ID. */
export function generateMovementId(botUsername: string): string {
  return `move_${botUsername}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

/** Generate a progress key. */
function progressKey(botUsername: string, itemId: string): string {
  return `${botUsername}:${itemId}`;
}

/** Log an activity entry. */
export function logCargoActivity(
  botUsername: string,
  type: CargoActivityType,
  message: string,
  options?: {
    itemId?: string;
    itemName?: string;
    quantity?: number;
    location?: string;
    error?: string;
  }
): void {
  const activity = loadCargoMoverActivity();
  const logEntry: CargoActivityLog = {
    timestamp: new Date().toISOString(),
    botUsername,
    type,
    itemId: options?.itemId,
    itemName: options?.itemName,
    quantity: options?.quantity,
    location: options?.location,
    message,
    error: options?.error,
  };

  activity.activityLog.unshift(logEntry);
  if (activity.activityLog.length > 500) {
    activity.activityLog = activity.activityLog.slice(0, 500);
  }

  saveCargoMoverActivity(activity);
}

/** Start tracking a new item delivery progress. */
export function startItemProgress(
  botUsername: string,
  itemId: string,
  itemName: string,
  targetQuantity: number,
  storageType: "faction" | "personal"
): void {
  const activity = loadCargoMoverActivity();
  const key = progressKey(botUsername, itemId);

  if (!activity.itemProgress[key]) {
    const now = new Date().toISOString();
    activity.itemProgress[key] = {
      itemId,
      itemName,
      botUsername,
      targetQuantity,
      totalWithdrawn: 0,
      totalDelivered: 0,
      totalLost: 0,
      totalTrips: 0,
      startedAt: now,
      lastUpdatedAt: now,
      isComplete: false,
      storageType,
    };
  }

  saveCargoMoverActivity(activity);
}

/** Update item delivery progress. */
export function updateItemProgress(
  botUsername: string,
  itemId: string,
  updates: {
    withdrawn?: number;
    delivered?: number;
    lost?: number;
    tripCompleted?: boolean;
    isComplete?: boolean;
  }
): ItemDeliveryProgress | null {
  const activity = loadCargoMoverActivity();
  const key = progressKey(botUsername, itemId);
  const progress = activity.itemProgress[key];

  if (!progress) return null;

  if (updates.withdrawn !== undefined) {
    progress.totalWithdrawn += updates.withdrawn;
  }
  if (updates.delivered !== undefined) {
    progress.totalDelivered += updates.delivered;
  }
  if (updates.lost !== undefined) {
    progress.totalLost += updates.lost;
  }
  if (updates.tripCompleted) {
    progress.totalTrips += 1;
  }
  if (updates.isComplete !== undefined) {
    progress.isComplete = updates.isComplete;
  }

  progress.lastUpdatedAt = new Date().toISOString();

  // Auto-complete if delivered >= target
  if (progress.targetQuantity > 0 && progress.totalDelivered >= progress.targetQuantity) {
    progress.isComplete = true;
  }

  saveCargoMoverActivity(activity);
  return progress;
}

/** Get item delivery progress for a bot. */
export function getItemProgress(
  botUsername: string,
  itemId: string
): ItemDeliveryProgress | undefined {
  const activity = loadCargoMoverActivity();
  const key = progressKey(botUsername, itemId);
  return activity.itemProgress[key];
}

/** Get all item progress for a bot. */
export function getBotItemProgress(botUsername: string): ItemDeliveryProgress[] {
  const activity = loadCargoMoverActivity();
  return Object.values(activity.itemProgress).filter(p => p.botUsername === botUsername);
}

/** Create a new movement record. */
export function createMovement(
  botUsername: string,
  itemId: string,
  itemName: string,
  withdrawnQty: number,
  sourceStation: string,
  sourceSystem: string,
  destinationStation: string,
  destinationSystem: string,
  storageType: "faction" | "personal",
  destinationStorageType: "faction" | "personal" | "send_gift",
  tripNumber: number,
  destinationBotName?: string
): CargoMovement {
  const movementId = generateMovementId(botUsername);
  const now = new Date().toISOString();

  const movement: CargoMovement = {
    movementId,
    botUsername,
    itemId,
    itemName,
    withdrawnQty,
    depositedQty: 0,
    lostQty: 0,
    sourceStation,
    sourceSystem,
    destinationStation,
    destinationSystem,
    storageType,
    destinationStorageType,
    destinationBotName,
    startedAt: now,
    state: "withdrawing",
    tripNumber,
  };

  const activity = loadCargoMoverActivity();
  activity.activeMovements[movementId] = movement;
  saveCargoMoverActivity(activity);

  return movement;
}

/** Update a movement record. */
export function updateMovement(
  movementId: string,
  updates: {
    depositedQty?: number;
    lostQty?: number;
    state?: CargoMovementState;
    completedAt?: string;
    notes?: string;
  }
): CargoMovement | null {
  const activity = loadCargoMoverActivity();
  const movement = activity.activeMovements[movementId];

  if (!movement) return null;

  if (updates.depositedQty !== undefined) {
    movement.depositedQty = updates.depositedQty;
  }
  if (updates.lostQty !== undefined) {
    movement.lostQty = updates.lostQty;
  }
  if (updates.state !== undefined) {
    movement.state = updates.state;
  }
  if (updates.completedAt !== undefined) {
    movement.completedAt = updates.completedAt;
  }
  if (updates.notes !== undefined) {
    movement.notes = movement.notes ? `${movement.notes} | ${updates.notes}` : updates.notes;
  }

  saveCargoMoverActivity(activity);
  return movement;
}

/** Complete a movement and move to history. */
export function completeMovement(movementId: string): boolean {
  const activity = loadCargoMoverActivity();
  const movement = activity.activeMovements[movementId];

  if (!movement) return false;

  movement.state = "completed";
  movement.completedAt = movement.completedAt || new Date().toISOString();

  // Calculate lost quantity
  movement.lostQty = movement.withdrawnQty - movement.depositedQty;
  if (movement.lostQty < 0) movement.lostQty = 0;

  // Move to history
  activity.movementHistory.unshift(movement);
  if (activity.movementHistory.length > 200) {
    activity.movementHistory = activity.movementHistory.slice(0, 200);
  }

  delete activity.activeMovements[movementId];
  saveCargoMoverActivity(activity);

  return true;
}

/** Mark a movement as failed. */
export function failMovement(movementId: string, reason: string): boolean {
  const activity = loadCargoMoverActivity();
  const movement = activity.activeMovements[movementId];

  if (!movement) return false;

  movement.state = "failed";
  movement.completedAt = new Date().toISOString();
  movement.notes = movement.notes ? `${movement.notes} | Failed: ${reason}` : `Failed: ${reason}`;
  movement.lostQty = movement.withdrawnQty - movement.depositedQty;
  if (movement.lostQty < 0) movement.lostQty = 0;

  // Move to history
  activity.movementHistory.unshift(movement);
  if (activity.movementHistory.length > 200) {
    activity.movementHistory = activity.movementHistory.slice(0, 200);
  }

  delete activity.activeMovements[movementId];
  saveCargoMoverActivity(activity);

  return true;
}

/** Save the last session state for recovery. */
export function saveLastSession(
  botUsername: string,
  sourceStation: string,
  destinationStation: string,
  items: Array<{ itemId: string; itemName: string; quantity: number; storageType: "faction" | "personal" }>,
  currentTrip: number,
  lastAction: string,
  lastSystem: string,
  lastStation: string,
  docked: boolean
): void {
  const activity = loadCargoMoverActivity();
  activity.lastSession = {
    botUsername,
    sourceStation,
    destinationStation,
    items,
    currentTrip,
    lastAction,
    lastSystem,
    lastStation,
    docked,
    timestamp: new Date().toISOString(),
  };
  saveCargoMoverActivity(activity);
}

/** Get the last session state for recovery. */
export function getLastSession(botUsername: string): CargoMoverActivityData["lastSession"] {
  const activity = loadCargoMoverActivity();
  if (!activity.lastSession || activity.lastSession.botUsername !== botUsername) {
    return undefined;
  }
  return activity.lastSession;
}

/** Clear the last session state. */
export function clearLastSession(botUsername: string): void {
  const activity = loadCargoMoverActivity();
  if (activity.lastSession?.botUsername === botUsername) {
    activity.lastSession = undefined;
    saveCargoMoverActivity(activity);
  }
}

/**
 * Zero the delivered counters in the activity-progress store. This is the store
 * `findMoveJobs` reads via `getItemProgress(...).totalDelivered` — it is a
 * fleet-wide cumulative that, unlike `settings.cargo_mover.items[].totalDelivered`,
 * was NEVER cleared by any reset (only the settings mirror was). A stale value
 * here makes the bot believe everything is already delivered and skip every item
 * even after the user "resets" the settings. This is the missing half of a real
 * full reset. Scoped to a single bot when `botUsername` is given, else all bots.
 */
export function resetCargoMoverDeliveryProgress(botUsername?: string): { cleared: number } {
  const activity = loadCargoMoverActivity();
  let cleared = 0;
  for (const key of Object.keys(activity.itemProgress)) {
    if (botUsername && !key.startsWith(`${botUsername}:`)) continue;
    const p = activity.itemProgress[key];
    if (p.totalDelivered !== 0 || p.isComplete) {
      p.totalDelivered = 0;
      p.isComplete = false;
      cleared++;
    }
  }
  if (cleared > 0) saveCargoMoverActivity(activity);
  return { cleared };
}

/** Get a summary of cargo mover activity. */
export function getCargoMoverSummary(botUsername?: string): {
  totalMovements: number;
  activeMovements: number;
  completedMovements: number;
  failedMovements: number;
  totalItemsMoved: number;
  totalItemsLost: number;
  itemProgress: ItemDeliveryProgress[];
} {
  const activity = loadCargoMoverActivity();
  
  let movements = Object.values(activity.activeMovements);
  let history = activity.movementHistory;

  if (botUsername) {
    movements = movements.filter(m => m.botUsername === botUsername);
    history = history.filter(m => m.botUsername === botUsername);
  }

  const completed = history.filter(m => m.state === "completed");
  const failed = history.filter(m => m.state === "failed");

  const totalItemsMoved = completed.reduce((sum, m) => sum + m.depositedQty, 0);
  const totalItemsLost = history.reduce((sum, m) => sum + (m.lostQty || 0), 0);

  let itemProgress = Object.values(activity.itemProgress);
  if (botUsername) {
    itemProgress = itemProgress.filter(p => p.botUsername === botUsername);
  }

  return {
    totalMovements: movements.length + history.length,
    activeMovements: movements.length,
    completedMovements: completed.length,
    failedMovements: failed.length,
    totalItemsMoved,
    totalItemsLost,
    itemProgress,
  };
}

/**
 * Live per-item delivery status aggregated from the authoritative data sources
 * (activity progress + in-transit tracking). Unlike the `totalDelivered` mirror
 * kept on the settings object, this always reflects the real current counts.
 */
export function getCargoMoverItemStatuses(): Record<
  string,
  { itemName: string; delivered: number; inTransit: number }
> {
  const activity = loadCargoMoverActivity();
  const inTransit = loadInTransitData();
  const result: Record<string, { itemName: string; delivered: number; inTransit: number }> = {};

  for (const p of Object.values(activity.itemProgress)) {
    const entry = result[p.itemId] || (result[p.itemId] = { itemName: p.itemName, delivered: 0, inTransit: 0 });
    entry.delivered += p.totalDelivered || 0;
    entry.itemName = p.itemName || entry.itemName;
  }

  // The activity-progress `totalDelivered` above is a *fleet-wide cumulative*
  // that never resets when the destination changes and is spread across every
  // bot, so it does NOT reflect what is actually at the current destination.
  // The authoritative, reconcilable delivered count lives in the cargo_mover
  // settings (`totalDelivered` per configured item) — that is exactly what the
  // "Reconcile" button writes. Prefer it so the dashboard shows the real
  // per-destination delivered amount instead of an inflated lifetime sum.
  const settings = loadCargoMoverSettings();
  const configuredItems = (settings.items as Array<Record<string, unknown>>) || [];
  for (const it of configuredItems) {
    const itemId = it.itemId as string;
    if (!itemId) continue;
    const entry = result[itemId] || (result[itemId] = { itemName: (it.itemName as string) || itemId, delivered: 0, inTransit: 0 });
    entry.delivered = (it.totalDelivered as number) || 0;
    entry.itemName = (it.itemName as string) || entry.itemName;
  }

  for (const entries of Object.values(inTransit.inTransitItems)) {
    for (const e of entries) {
      if (e.quantity <= 0) continue;
      const entry = result[e.itemId] || (result[e.itemId] = { itemName: e.itemName, delivered: 0, inTransit: 0 });
      entry.inTransit += e.quantity;
      entry.itemName = e.itemName || entry.itemName;
    }
  }

  return result;
}

/** Lightweight read of just the cargo_mover settings block (no circular deps). */
function loadCargoMoverSettings(): Record<string, unknown> {
  try {
    const settingsPath = join(DATA_DIR, "settings.json");
    if (!existsSync(settingsPath)) return {};
    const raw = readFileSync(settingsPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return (parsed.cargo_mover as Record<string, unknown>) || {};
  } catch {
    return {};
  }
}
