/**
 * Rescue BlackBook - tracks player rescue history and reputation.
 * Used to make quick decisions on whether to respond to MAYDAY requests.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const DATA_DIR = join(process.cwd(), "data");
const BLACKBOOK_FILE = join(DATA_DIR, "rescueBlackBook.json");

export interface PlayerRescueRecord {
  /** Number of times player requested rescue */
  rescueRequests: number;
  /** Number of times player was not where they said (ghosted) */
  ghostCount: number;
  /** Number of times rescue was successful */
  successfulRescues: number;
  /** Total credits billed to player */
  totalCreditsBilled: number;
  /** Manual override for rescue decisions: true=always rescue, false=never rescue, undefined=auto */
  shouldRescue?: boolean;
  /** Last updated timestamp */
  lastUpdatedAt?: string;
}

export interface RescueBlackBookData {
  [playerName: string]: PlayerRescueRecord;
}

/**
 * Load the rescue blackbook from disk.
 */
export function loadRescueBlackBook(): RescueBlackBookData {
  try {
    if (existsSync(BLACKBOOK_FILE)) {
      return JSON.parse(readFileSync(BLACKBOOK_FILE, "utf-8"));
    }
  } catch (err) {
    console.warn("Could not load rescueBlackBook.json:", err);
  }
  return {};
}

/**
 * Save the rescue blackbook to disk.
 */
export function saveRescueBlackBook(data: RescueBlackBookData): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(BLACKBOOK_FILE, JSON.stringify(data, null, 2) + "\n");
  } catch (err) {
    console.error("Error saving rescueBlackBook.json:", err);
  }
}

/**
 * Get or create a player's rescue record.
 */
export function getPlayerRecord(playerName: string): PlayerRescueRecord {
  const data = loadRescueBlackBook();
  if (!data[playerName]) {
    data[playerName] = {
      rescueRequests: 0,
      ghostCount: 0,
      successfulRescues: 0,
      totalCreditsBilled: 0,
      lastUpdatedAt: new Date().toISOString(),
    };
    saveRescueBlackBook(data);
  }
  return data[playerName]!;
}

/**
 * Update a player's rescue record.
 */
export function updatePlayerRecord(playerName: string, updates: Partial<PlayerRescueRecord>): PlayerRescueRecord {
  const data = loadRescueBlackBook();
  if (!data[playerName]) {
    data[playerName] = {
      rescueRequests: 0,
      ghostCount: 0,
      successfulRescues: 0,
      totalCreditsBilled: 0,
      lastUpdatedAt: new Date().toISOString(),
    };
  }
  data[playerName] = {
    ...data[playerName],
    ...updates,
    lastUpdatedAt: new Date().toISOString(),
  };
  saveRescueBlackBook(data);
  return data[playerName]!;
}

/**
 * Record a rescue request (when player sends MAYDAY or is identified for rescue).
 */
export function recordRescueRequest(playerName: string): void {
  const record = getPlayerRecord(playerName);
  updatePlayerRecord(playerName, { rescueRequests: record.rescueRequests + 1 });
}

/**
 * Record a ghost incident (player was not where they said).
 * Skips if player is marked as one of our bots (ghostCount < 0).
 */
export function recordGhost(playerName: string): void {
  const record = getPlayerRecord(playerName);
  // Skip if this is one of our bots (marked with negative ghostCount)
  if (record.ghostCount < 0) {
    return;
  }
  updatePlayerRecord(playerName, { ghostCount: record.ghostCount + 1 });
}

/**
 * Mark a player as one of our own bots by setting ghostCount to -1.
 * This prevents our bots from being blacklisted due to "ghost" incidents.
 */
export function markAsOwnBot(playerName: string): void {
  const record = getPlayerRecord(playerName);
  if (record.ghostCount >= 0) {
    updatePlayerRecord(playerName, { ghostCount: -1 });
  }
}

/**
 * Check if a player is marked as one of our own bots.
 */
export function isOwnBot(playerName: string): boolean {
  const record = getPlayerRecord(playerName);
  return record.ghostCount < 0;
}

/**
 * Record a successful rescue.
 */
export function recordSuccessfulRescue(playerName: string, creditsBilled: number): void {
  const record = getPlayerRecord(playerName);
  updatePlayerRecord(playerName, {
    successfulRescues: record.successfulRescues + 1,
    totalCreditsBilled: record.totalCreditsBilled + creditsBilled,
  });
}

/**
 * Check if we should rescue a player.
 * Returns:
 * - true/false if manual override is set
 * - false if ghost count >= threshold
 * - true otherwise (auto-decision)
 */
export function shouldRescuePlayer(playerName: string, ghostThreshold: number = 3): { shouldRescue: boolean; reason: string } {
  const record = getPlayerRecord(playerName);

  // Manual override takes precedence
  if (record.shouldRescue === true) {
    return { shouldRescue: true, reason: "Manual override: always rescue" };
  }
  if (record.shouldRescue === false) {
    return { shouldRescue: false, reason: "Manual override: never rescue" };
  }

  // Auto-decision based on ghost count
  if (record.ghostCount >= ghostThreshold) {
    return { shouldRescue: false, reason: `Too many ghosts (${record.ghostCount}/${ghostThreshold})` };
  }

  return { shouldRescue: true, reason: "Auto-approve" };
}

/**
 * Set manual override for rescuing a player.
 */
export function setRescueOverride(playerName: string, shouldRescue: boolean): void {
  updatePlayerRecord(playerName, { shouldRescue });
}

/**
 * Clear manual override for a player (revert to auto-decision).
 */
export function clearRescueOverride(playerName: string): void {
  updatePlayerRecord(playerName, { shouldRescue: undefined });
}

/**
 * Get all player records (for debugging/admin purposes).
 */
export function getAllRecords(): RescueBlackBookData {
  return loadRescueBlackBook();
}
