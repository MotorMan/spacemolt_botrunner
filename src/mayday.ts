// ── MAYDAY Emergency Rescue Parser ──────────────────────────

import { existsSync, readFileSync } from "fs";
import { join } from "path";

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

// ── Flooding-sender filter ──────────────────────────────────
//
// Settings → FuelRescue → "Ignore MAYDAYs from Wexler pilots"
// (`rescue.ignoreWexlerMaydays`).
//
// The Wexler pilots spam the emergency channel hard enough to starve everyone
// else: the queue below is capped and evicts its OLDEST entry, so a burst of
// their calls pushes genuinely stranded pilots out before a rescue bot can even
// look at them. When the setting is on their MAYDAYs are dropped at intake and
// skipped by the queue readers, so no rescue bot spends a cycle on them and the
// queue stays free for real distress calls.
//
// The match is a NAME PREFIX on purpose: the flood comes from a whole family of
// accounts ("Wexler V6U-PA", "Wexler …"), not a single one.

const IGNORED_SENDER_PREFIXES = ["wexler"];

const SETTINGS_FILE = join(process.cwd(), "data", "settings.json");

/**
 * MAYDAYs arrive per chat message (that's the whole problem), so the on-disk
 * setting is cached briefly instead of re-read and re-parsed for every call.
 *
 * The file is read directly rather than through the web server's `loadSettings`:
 * this module sits underneath `bot.ts` in the import graph and pulling the
 * server module in here would add an import cycle just to read one boolean.
 */
const IGNORE_SETTING_TTL_MS = 5000;
let ignoreSettingCache: { enabled: boolean; readAt: number } | null = null;

function isSenderFilterEnabled(): boolean {
  const now = Date.now();
  if (ignoreSettingCache && now - ignoreSettingCache.readAt < IGNORE_SETTING_TTL_MS) {
    return ignoreSettingCache.enabled;
  }

  let enabled = false;
  try {
    if (existsSync(SETTINGS_FILE)) {
      const parsed = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8")) as Record<string, Record<string, unknown> | undefined>;
      enabled = parsed.rescue?.ignoreWexlerMaydays === true;
    }
  } catch {
    // A missing/corrupt/half-written settings file must never silently block
    // real rescues — fail open (filter off).
    enabled = false;
  }

  ignoreSettingCache = { enabled, readAt: now };
  return enabled;
}

/**
 * Is this MAYDAY sender currently filtered out by the FuelRescue
 * "ignore Wexler MAYDAYs" setting?
 *
 * Matched against the sender name parsed out of the MAYDAY text itself (the
 * stranded pilot), case- and whitespace-insensitively.
 */
export function isIgnoredMaydaySender(sender: string): boolean {
  if (!sender) return false;
  if (!isSenderFilterEnabled()) return false;
  const name = sender.trim().toLowerCase();
  return IGNORED_SENDER_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** Throttle state for reporting ignored MAYDAYs: sender -> last log + skipped count. */
const ignoredLogState = new Map<string, { lastLoggedAt: number; suppressed: number }>();
const IGNORED_LOG_INTERVAL_MS = 60000;
const IGNORED_LOG_STATE_MAX = 200;

function pruneIgnoredLogState(now: number): void {
  if (ignoredLogState.size <= IGNORED_LOG_STATE_MAX) return;
  for (const [sender, state] of ignoredLogState) {
    if (now - state.lastLoggedAt > IGNORED_LOG_INTERVAL_MS) ignoredLogState.delete(sender);
  }
  // Still oversized (a very wide flood across many names): start fresh rather
  // than let the throttle map grow without bound.
  if (ignoredLogState.size > IGNORED_LOG_STATE_MAX) ignoredLogState.clear();
}

/**
 * Should an ignored MAYDAY be written to the log right now?
 *
 * Throttled to one line per sender per minute, returning how many of that
 * sender's calls were swallowed since the last line — otherwise a MAYDAY flood
 * simply becomes a log flood, which is the problem this filter exists to stop.
 */
export function shouldLogIgnoredMayday(sender: string): { log: boolean; suppressed: number } {
  const now = Date.now();
  const state = ignoredLogState.get(sender);

  if (state && now - state.lastLoggedAt < IGNORED_LOG_INTERVAL_MS) {
    state.suppressed++;
    return { log: false, suppressed: state.suppressed };
  }

  const suppressed = state?.suppressed ?? 0;
  ignoredLogState.set(sender, { lastLoggedAt: now, suppressed: 0 });
  pruneIgnoredLogState(now);
  return { log: true, suppressed };
}

// ── MAYDAY Queue ────────────────────────────────────────────

const maydayQueue: MaydayRequest[] = [];
const processedMaydays = new Set<string>(); // Prevent duplicate processing

// MAYDAYs expire after 5 minutes (300000 ms) - players should be rescued or logged off by then
const MAYDAY_EXPIRY_MS = 300000;

/**
 * Add a MAYDAY request to the queue.
 * Returns true if added, false if duplicate, invalid, or from a sender that the
 * FuelRescue "ignore Wexler MAYDAYs" setting filters out.
 */
export function addMaydayRequest(mayday: MaydayRequest): boolean {
  // Filtered senders are rejected BEFORE anything else: the queue is capped and
  // drops its oldest entry when full, so letting a flood in here is exactly how
  // regular players stop getting rescued. Callers report the drop (throttled)
  // via shouldLogIgnoredMayday().
  if (isIgnoredMaydaySender(mayday.sender)) {
    return false;
  }

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
 * Count how many MAYDAY requests are currently pending (not yet expired).
 * Used by the rescue routines to decide whether a backup (non-primary) bot
 * should step in — only when there is a genuine surge (2+ at once).
 *
 * Senders filtered by the "ignore Wexler MAYDAYs" setting are not counted, so a
 * flood can't fake a surge and pull the backup bots off their own work.
 */
export function getPendingMaydayCount(): number {
  const now = Date.now();
  let count = 0;
  for (const mayday of maydayQueue) {
    if (isIgnoredMaydaySender(mayday.sender)) continue;
    if (now - mayday.timestamp <= MAYDAY_EXPIRY_MS) {
      count++;
    }
  }
  return count;
}

/**
 * Get the next pending MAYDAY request (oldest first).
 * Filters out expired MAYDAYs automatically, along with senders blocked by the
 * FuelRescue "ignore Wexler MAYDAYs" setting (which catches anything queued
 * before the setting was switched on).
 * Returns null if no pending requests.
 */
export function getNextMayday(): MaydayRequest | null {
  const now = Date.now();
  
  // Filter out expired MAYDAYs
  while (maydayQueue.length > 0) {
    const mayday = maydayQueue[0];
    const age = now - mayday.timestamp;
    
    if (age > MAYDAY_EXPIRY_MS) {
      // This MAYDAY is expired - remove it
      const ageMinutes = Math.round(age / 60000);
      console.log(`[mayday] ⏰ Expiring MAYDAY from ${mayday.sender} at ${mayday.system}/${mayday.poi} (${ageMinutes} minutes old)`);
      maydayQueue.shift();
      continue;
    }

    if (isIgnoredMaydaySender(mayday.sender)) {
      // Queued before the filter was enabled — drop it so it can't block the
      // head of the queue, and never hand it to a rescue bot.
      const { log, suppressed } = shouldLogIgnoredMayday(mayday.sender);
      if (log) {
        const extra = suppressed > 0 ? ` (+${suppressed} more suppressed)` : "";
        console.log(`[mayday] 🚫 Dropping queued MAYDAY from ${mayday.sender} — sender ignored by the FuelRescue Wexler filter${extra}`);
      }
      maydayQueue.shift();
      continue;
    }
    
    // Found a valid MAYDAY
    return mayday;
  }
  
  return null;
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

/**
 * Clear expired MAYDAYs from the queue.
 * Call this periodically or when starting a rescue routine.
 */
export function clearExpiredMaydays(): void {
  const now = Date.now();
  const initialLength = maydayQueue.length;
  
  while (maydayQueue.length > 0) {
    const mayday = maydayQueue[0];
    const age = now - mayday.timestamp;
    
    if (age > MAYDAY_EXPIRY_MS) {
      const ageMinutes = Math.round(age / 60000);
      console.log(`[mayday] ⏰ Expiring MAYDAY from ${mayday.sender} at ${mayday.system}/${mayday.poi} (${ageMinutes} minutes old)`);
      maydayQueue.shift();
    } else {
      break; // Queue is ordered by timestamp, so we can stop at first valid one
    }
  }
  
  const expired = initialLength - maydayQueue.length;
  if (expired > 0) {
    console.log(`[mayday] Cleared ${expired} expired MAYDAY(s)`);
  }
}
