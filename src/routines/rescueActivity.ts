/**
 * Rescue session persistence for the rescue routines.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "fs";
import { join } from "path";

const DATA_DIR = join(process.cwd(), "data");
const ACTIVITY_FILE = join(DATA_DIR, "rescueActivity.json");
const ACTIVITY_FILE_BACKUP = join(DATA_DIR, "rescueActivity.json.bak");
const ACTIVITY_FILE_TEMP = join(DATA_DIR, "rescueActivity.json.tmp");

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 100;

export type RescueSessionState = "navigating" | "at_system" | "traveling_to_poi" | "at_poi" | "delivering_fuel" | "returning_home" | "completed" | "failed";

export interface RescueTarget {
  username: string;
  system: string;
  poi: string;
  fuelPct: number;
  docked: boolean;
}

export interface RescueSession {
  sessionId: string;
  botUsername: string;
  targetUsername: string;
  targetSystem: string;
  targetPoi: string;
  isMayday: boolean;
  fuelDelivered?: number;
  creditsSent?: number;
  jumpsCompleted: number;
  totalJumps: number;
  startedAt: string;
  lastUpdatedAt: string;
  completedAt?: string;
  state: RescueSessionState;
  notes?: string;
  consecutiveFailures?: number;
  lastFailureReason?: string;
}

export interface RescueActivityData {
  [botUsername: string]: {
    activeSession?: RescueSession;
    lastCompletedSession?: RescueSession;
    sessionHistory?: RescueSession[];
  };
}

export function loadRescueActivity(): RescueActivityData {
  const filesToTry = [ACTIVITY_FILE, ACTIVITY_FILE_BACKUP];
  
  for (const file of filesToTry) {
    try {
      if (existsSync(file)) {
        const content = readFileSync(file, "utf-8").trim();
        if (!content) {
          console.warn(`Empty rescue activity file: ${file}`);
          continue;
        }
        const parsed = JSON.parse(content);
        if (typeof parsed !== "object" || parsed === null) {
          console.warn(`Invalid rescue activity data structure from ${file}`);
          continue;
        }
        console.log(`Loaded rescue activity from ${file}`);
        return parsed;
      }
    } catch (err) {
      console.warn(`Could not load ${file}:`, err);
    }
  }
  
  console.warn("No valid rescue activity file found. Starting with empty data.");
  return {};
}

async function saveWithRetry(data: string, ctx?: { sleep: (ms: number) => Promise<void> }): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (existsSync(ACTIVITY_FILE)) {
        try {
          const content = readFileSync(ACTIVITY_FILE, "utf-8");
          writeFileSync(ACTIVITY_FILE_BACKUP, content, "utf-8");
        } catch (backupErr) {
          console.warn("Could not create backup file:", backupErr);
        }
      }
      
      writeFileSync(ACTIVITY_FILE_TEMP, data, "utf-8");
      
      renameSync(ACTIVITY_FILE_TEMP, ACTIVITY_FILE);
      
      if (existsSync(ACTIVITY_FILE_TEMP)) {
        try {
          unlinkSync(ACTIVITY_FILE_TEMP);
        } catch (_) {}
      }
      
      return true;
    } catch (err: any) {
      console.warn(`Save attempt ${attempt}/${MAX_RETRIES} failed:`, err?.message || err);
      
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        if (ctx) {
          await ctx.sleep(delay);
        } else {
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
  }
  
  return false;
}

export async function saveRescueActivity(data: RescueActivityData): Promise<void> {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    
    const jsonData = JSON.stringify(data, null, 2) + "\n";
    const success = await saveWithRetry(jsonData);
    
    if (!success) {
      console.error("FAILED to save rescueActivity.json after all retries! Data may be lost.");
      console.error("Last known data structure keys:", Object.keys(data).join(", "));
    }
  } catch (err) {
    console.error("Unexpected error in saveRescueActivity:", err);
  }
}

function getBotActivity(botUsername: string) {
  const data = loadRescueActivity();
  if (!data[botUsername]) {
    data[botUsername] = { activeSession: undefined, lastCompletedSession: undefined, sessionHistory: [] };
  }
  return data[botUsername]!;
}

async function saveBotActivity(botUsername: string, activity: ReturnType<typeof getBotActivity>): Promise<void> {
  const data = loadRescueActivity();
  data[botUsername] = activity;
  await saveRescueActivity(data);
}

export async function startRescueSession(session: RescueSession): Promise<void> {
  const activity = getBotActivity(session.botUsername);
  if (activity.activeSession) {
    activity.activeSession.state = "failed";
    activity.activeSession.lastUpdatedAt = new Date().toISOString();
    activity.activeSession.notes = (activity.activeSession.notes || "") + " | Interrupted by new session";
    if (!activity.sessionHistory) activity.sessionHistory = [];
    activity.sessionHistory.unshift(activity.activeSession);
    if (activity.sessionHistory.length > 50) activity.sessionHistory = activity.sessionHistory.slice(0, 50);
  }
  activity.activeSession = session;
  await saveBotActivity(session.botUsername, activity);
}

export async function updateRescueSession(botUsername: string, updates: Partial<RescueSession>): Promise<RescueSession | null> {
  const activity = getBotActivity(botUsername);
  if (!activity.activeSession) return null;
  activity.activeSession = { ...activity.activeSession, ...updates, lastUpdatedAt: new Date().toISOString() };
  await saveBotActivity(botUsername, activity);
  return activity.activeSession;
}

export async function completeRescueSession(botUsername: string): Promise<RescueSession | null> {
  const activity = getBotActivity(botUsername);
  if (!activity.activeSession) return null;
  const session = activity.activeSession;
  session.state = "completed";
  session.completedAt = new Date().toISOString();
  session.lastUpdatedAt = session.completedAt;
  if (!activity.sessionHistory) activity.sessionHistory = [];
  activity.lastCompletedSession = session;
  activity.sessionHistory.unshift(session);
  if (activity.sessionHistory.length > 50) activity.sessionHistory = activity.sessionHistory.slice(0, 50);
  activity.activeSession = undefined;
  await saveBotActivity(botUsername, activity);
  return session;
}

export async function failRescueSession(botUsername: string, reason: string): Promise<RescueSession | null> {
  const activity = getBotActivity(botUsername);
  if (!activity.activeSession) return null;
  const session = activity.activeSession;
  session.state = "failed";
  session.lastUpdatedAt = new Date().toISOString();
  session.notes = (session.notes || "") + " | Failed: " + reason;
  if (!activity.sessionHistory) activity.sessionHistory = [];
  activity.sessionHistory.unshift(session);
  if (activity.sessionHistory.length > 50) activity.sessionHistory = activity.sessionHistory.slice(0, 50);
  activity.activeSession = undefined;
  await saveBotActivity(botUsername, activity);
  return session;
}

export function getActiveRescueSession(botUsername: string): RescueSession | undefined {
  return getBotActivity(botUsername).activeSession;
}

/**
 * Check if another bot already has an active rescue session for this target.
 * This prevents duplicate rescues when multiple bots process the same MAYDAY.
 * 
 * @returns the bot username that has the active session, or undefined if no other bot is handling it
 */
export function getOtherBotHandlingRescue(
  excludeBot: string,
  targetUsername: string,
  targetSystem: string,
  targetPoi?: string
): string | undefined {
  const data = loadRescueActivity();
  const normalize = (s: string) => s.toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  
  for (const [botName, activity] of Object.entries(data)) {
    if (botName === excludeBot) continue;
    const session = activity.activeSession;
    if (session && session.state !== "completed" && session.state !== "failed") {
      const playerMatch = normalize(session.targetUsername) === normalize(targetUsername);
      const systemMatch = normalize(session.targetSystem) === normalize(targetSystem);
      const poiMatch = !targetPoi || !session.targetPoi ||
                       normalize(session.targetPoi) === normalize(targetPoi);
      
      if (playerMatch && systemMatch && poiMatch) {
        return botName;
      }
    }
  }
  
  return undefined;
}

export async function clearActiveRescueSession(botUsername: string): Promise<void> {
  const activity = getBotActivity(botUsername);
  activity.activeSession = undefined;
  await saveBotActivity(botUsername, activity);
}

/**
 * Track recently received MAYDAYs to prevent processing duplicates.
 * This is separate from completed session tracking - it prevents
 * the same MAYDAY from being processed multiple times while a rescue is in progress.
 * 
 * Key: normalized "playername|system|poi" 
 * Value: timestamp when MAYDAY was first received
 * 
 * Entries expire after 1 hour (matching the in-game command cooldown).
 */
const recentMaydayReceived = new Map<string, number>();

/**
 * Track MAYDAYs that have been declined (no route, wormhole, etc).
 * This prevents the bot from spamming decline messages for the same MAYDAY.
 * 
 * Key: normalized "playername|system|poi"
 * Value: timestamp when MAYDAY was declined
 * 
 * Entries expire after 1 hour (matching the in-game command cooldown).
 */
const declinedMaydays = new Map<string, number>();

/**
 * Normalize a MAYDAY identifier for deduplication.
 */
function normalizeMaydayKey(player: string, system: string, poi?: string): string {
  const normalize = (s: string) => s.toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  return `${normalize(player)}|${normalize(system)}|${normalize(poi || '')}`;
}

/**
 * Check if a MAYDAY has been declined recently (within the last hour).
 * This prevents the bot from spamming decline messages for the same MAYDAY.
 * The 1-hour cooldown matches the in-game command cooldown period.
 * 
 * @returns true if this MAYDAY was recently declined, false if it's new
 */
export function isMaydayDeclined(player: string, system: string, poi?: string): boolean {
  const maydayKey = normalizeMaydayKey(player, system, poi);
  const now = Date.now();
  const oneHour = 60 * 60 * 1000; // 1 hour in milliseconds

  const declinedAt = declinedMaydays.get(maydayKey);
  if (declinedAt) {
    const timeSinceDeclined = now - declinedAt;
    if (timeSinceDeclined < oneHour) {
      return true;
    } else {
      declinedMaydays.delete(maydayKey);
    }
  }

  return false;
}

/**
 * Mark a MAYDAY as declined. This prevents the bot from sending
 * another decline message for the same MAYDAY within the cooldown period.
 */
export function markMaydayDeclined(player: string, system: string, poi?: string): void {
  const maydayKey = normalizeMaydayKey(player, system, poi);
  declinedMaydays.set(maydayKey, Date.now());
  cleanupExpiredDeclinedMaydays();
}

/**
 * Clean up expired entries from the declined MAYDAYs map.
 */
function cleanupExpiredDeclinedMaydays(): void {
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;
  
  for (const [key, timestamp] of declinedMaydays.entries()) {
    if (now - timestamp >= oneHour) {
      declinedMaydays.delete(key);
    }
  }
}

/**
 * Check if a MAYDAY was recently received (within the last hour).
 * This prevents processing duplicate MAYDAY messages from the server.
 * The 1-hour cooldown matches the in-game command cooldown period.
 * 
 * @returns true if this MAYDAY was recently processed, false if it's new
 */
export function isMaydayDuplicate(
  botUsername: string,
  player: string,
  system: string,
  poi?: string
): boolean {
  const maydayKey = normalizeMaydayKey(player, system, poi);
  const now = Date.now();
  const oneHour = 60 * 60 * 1000; // 1 hour in milliseconds
  const processingGracePeriod = 5000; // 5 seconds grace period for newly received MAYDAYs

  // Check if we recently received this MAYDAY (regardless of completion status)
  const receivedAt = recentMaydayReceived.get(maydayKey);
  if (receivedAt) {
    const timeSinceReceived = now - receivedAt;
    
    // If received within the last 5 seconds, it's still being processed - not a duplicate yet
    if (timeSinceReceived < processingGracePeriod) {
      return false;
    }
    
    if (timeSinceReceived < oneHour) {
      // Still within the cooldown window - this is a duplicate
      return true;
    } else {
      // Expired - remove from tracking
      recentMaydayReceived.delete(maydayKey);
    }
  }

  // Also check against last completed session (existing logic)
  const activity = getBotActivity(botUsername);
  const lastCompleted = activity.lastCompletedSession;

  if (lastCompleted) {
    // Check if completed within last hour (prevent stale matches)
    const completedAt = new Date(lastCompleted.completedAt || lastCompleted.lastUpdatedAt).getTime();
    const timeSinceCompleted = now - completedAt;

    if (timeSinceCompleted < oneHour) {
      // Normalize for comparison (case-insensitive, handle spaces/underscores)
      const normalize = (s: string) => s.toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

      const playerMatch = normalize(lastCompleted.targetUsername) === normalize(player);
      const systemMatch = normalize(lastCompleted.targetSystem) === normalize(system);
      const poiMatch = !poi || !lastCompleted.targetPoi ||
                       normalize(lastCompleted.targetPoi) === normalize(poi);

      if (playerMatch && systemMatch && poiMatch) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Mark a MAYDAY as recently received. This should be called when a MAYDAY
 * is first processed (after validation passes).
 * Entries expire after 1 hour (matching the in-game command cooldown).
 */
export function markMaydayReceived(
  player: string,
  system: string,
  poi?: string
): void {
  const maydayKey = normalizeMaydayKey(player, system, poi);
  recentMaydayReceived.set(maydayKey, Date.now());
  
  // Clean up expired entries (keep map small)
  cleanupExpiredMaydayReceived();
}

/**
 * Clean up expired entries from the recent MAYDAY tracking map.
 */
function cleanupExpiredMaydayReceived(): void {
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;
  
  for (const [key, timestamp] of recentMaydayReceived.entries()) {
    if (now - timestamp >= oneHour) {
      recentMaydayReceived.delete(key);
    }
  }
}