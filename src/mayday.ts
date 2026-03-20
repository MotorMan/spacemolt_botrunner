// ── MAYDAY Emergency Rescue Parser ──────────────────────────

export interface MaydayRequest {
  sender: string;
  system: string;
  poi: string;
  currentFuel: number;
  maxFuel: number;
  fuelPct: number;
  timestamp: number;
  rawMessage: string;
  botUsername?: string; // Which bot received this
}

const MAYDAY_REGEX = /MAYDAY:\s*(.+?)\s+is stranded at\s+(.+?)\s+in\s+(.+?)\s+with\s+(\d+)\/(\d+)\s+fuel!/i;

/**
 * Parse a MAYDAY emergency message and extract rescue details.
 * Returns null if the message is not a valid MAYDAY request.
 * 
 * Expected format:
 * "MAYDAY: DavyJones is stranded at Bluerift Frost Ring in Bluerift with 4/120 fuel!"
 */
export function parseMaydayMessage(content: string, sender: string, timestamp: number, botUsername?: string, botSystem?: string, botPoi?: string): MaydayRequest | null {
  const match = content.match(MAYDAY_REGEX);
  
  if (!match) {
    return null;
  }

  const [, playerName, poi, system, currentFuelStr, maxFuelStr] = match;
  const currentFuel = parseInt(currentFuelStr, 10);
  const maxFuel = parseInt(maxFuelStr, 10);
  const fuelPct = maxFuel > 0 ? Math.round((currentFuel / maxFuel) * 100) : 0;

  return {
    sender: playerName.trim(),
    system: system.trim(),
    poi: poi.trim(),
    currentFuel,
    maxFuel,
    fuelPct,
    timestamp,
    rawMessage: content,
    botUsername,
  };
}

/**
 * Check if a MAYDAY request is legitimate (fuel below threshold).
 * Default threshold is 25% to avoid ambushes.
 */
export function isLegitimateMayday(mayday: MaydayRequest, fuelThresholdPct: number = 25): boolean {
  return mayday.fuelPct <= fuelThresholdPct;
}

// ── MAYDAY Queue ────────────────────────────────────────────

const maydayQueue: MaydayRequest[] = [];
const processedMaydays = new Set<string>(); // Prevent duplicate processing

/**
 * Add a MAYDAY request to the queue.
 * Returns true if added, false if duplicate or invalid.
 */
export function addMaydayRequest(mayday: MaydayRequest): boolean {
  // Create unique ID to prevent duplicates
  const maydayId = `${mayday.sender}-${mayday.system}-${mayday.poi}-${Math.floor(mayday.timestamp / 60000)}`; // Unique per minute
  
  if (processedMaydays.has(maydayId)) {
    return false; // Already processed
  }

  maydayQueue.push(mayday);
  
  // Keep queue size reasonable
  if (maydayQueue.length > 50) {
    maydayQueue.shift();
  }

  return true;
}

/**
 * Get the next pending MAYDAY request (oldest first).
 * Returns null if no pending requests.
 */
export function getNextMayday(): MaydayRequest | null {
  if (maydayQueue.length === 0) {
    return null;
  }
  return maydayQueue[0];
}

/**
 * Mark a MAYDAY request as being handled.
 */
export function markMaydayHandled(mayday: MaydayRequest): void {
  const maydayId = `${mayday.sender}-${mayday.system}-${mayday.poi}-${Math.floor(mayday.timestamp / 60000)}`;
  processedMaydays.add(maydayId);
  
  // Remove from queue
  const index = maydayQueue.indexOf(mayday);
  if (index >= 0) {
    maydayQueue.splice(index, 1);
  }
  
  // Clean up old processed entries (keep last 100)
  if (processedMaydays.size > 100) {
    const entries = [...processedMaydays];
    entries.slice(0, entries.length - 100).forEach(id => processedMaydays.delete(id));
  }
}

/**
 * Clear all pending MAYDAY requests.
 */
export function clearMaydayQueue(): void {
  maydayQueue.length = 0;
}
