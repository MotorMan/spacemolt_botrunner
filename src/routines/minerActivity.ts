/**
 * Mining session persistence for the miner routine.
 * Tracks active mining targets, quotas being worked on, and current location.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const DATA_DIR = join(process.cwd(), "data");
const ACTIVITY_FILE = join(DATA_DIR, "minerActivity.json");

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 100;
const WRITE_INTERVAL_MS = 60000; // Write to disk once per minute

// In-memory cache of miner activity data
let cachedData: string | null = null;
let writeTimer: NodeJS.Timeout | null = null;
let isFlushPending = false;

export type MiningSessionState = "traveling_to_ore" | "mining" | "returning_home" | "depositing" | "completed" | "abandoned" | "failed";

export type MiningType = "ore" | "gas" | "ice" | "radioactive";

export interface MiningSession {
  sessionId: string;
  botUsername: string;
  miningType: MiningType;
  targetResourceId: string;
  targetResourceName: string;
  targetSystemId: string;
  targetSystemName: string;
  targetPoiId: string;
  targetPoiName: string;
  homeSystem: string;
  isQuotaDriven: boolean;
  quotaTarget: number;
  quotaCurrent: number;
  startedAt: string;
  lastUpdatedAt: string;
  completedAt?: string;
  state: MiningSessionState;
  cyclesMined: number;
  resourcesMined: Record<string, number>;
  notes?: string;
}

export interface MinerActivityData {
  [botUsername: string]: {
    activeSession?: MiningSession;
    lastCompletedSession?: MiningSession;
    sessionHistory?: MiningSession[];
  };
}

export function loadMinerActivity(): MinerActivityData {
  // Try main file
  try {
    if (existsSync(ACTIVITY_FILE)) {
      const content = readFileSync(ACTIVITY_FILE, "utf-8").trim();
      if (!content) {
        console.warn("Empty miner activity file");
        cachedData = null;
        return {};
      }
      const parsed = JSON.parse(content);
      // Basic validation
      if (typeof parsed !== "object" || parsed === null) {
        console.warn("Invalid miner activity data structure");
        cachedData = null;
        return {};
      }
      console.log("Loaded miner activity from", ACTIVITY_FILE);
      // Populate cache on load
      cachedData = JSON.stringify(parsed, null, 2) + "\n";
      return parsed;
    }
  } catch (err) {
    console.warn("Could not load miner activity:", err);
  }
  
  console.warn("No valid miner activity file found. Starting with empty data.");
  cachedData = null;
  return {};
}

async function saveWithRetry(data: string, ctx?: { sleep: (ms: number) => Promise<void> }): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Write directly to the activity file
      writeFileSync(ACTIVITY_FILE, data, "utf-8");
      return true;
    } catch (err: any) {
      console.warn(`Save attempt ${attempt}/${MAX_RETRIES} failed:`, err?.message || err);
      
      if (attempt < MAX_RETRIES) {
        // Exponential backoff
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

export async function saveMinerActivity(data: MinerActivityData): Promise<void> {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    
    const jsonData = JSON.stringify(data, null, 2) + "\n";
    
    // Update in-memory cache
    cachedData = jsonData;
    
    // Schedule a write if one isn't already pending
    if (!isFlushPending) {
      isFlushPending = true;
      if (writeTimer) {
        clearTimeout(writeTimer);
      }
      writeTimer = setTimeout(async () => {
        isFlushPending = false;
        writeTimer = null;
        const success = await saveWithRetry(cachedData!);
        if (!success) {
          console.error("FAILED to save minerActivity.json after all retries! Data may be lost.");
          console.error("Last known data structure keys:", Object.keys(JSON.parse(cachedData!)).join(", "));
        }
      }, WRITE_INTERVAL_MS);
    }
  } catch (err) {
    console.error("Unexpected error in saveMinerActivity:", err);
  }
}

/**
 * Force an immediate write of cached data to disk.
 * Used during shutdown to ensure no data loss.
 */
export async function flushMinerActivity(): Promise<boolean> {
  if (cachedData === null) {
    return true; // Nothing to flush
  }
  
  // Clear any pending timer
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  isFlushPending = false;
  
  const success = await saveWithRetry(cachedData);
  if (!success) {
    console.error("FAILED to flush minerActivity.json after all retries! Data may be lost.");
  }
  return success;
}

function getBotActivity(botUsername: string) {
  const data = loadMinerActivity();
  if (!data[botUsername]) {
    data[botUsername] = { activeSession: undefined, lastCompletedSession: undefined, sessionHistory: [] };
  }
  return data[botUsername]!;
}

async function saveBotActivity(botUsername: string, activity: ReturnType<typeof getBotActivity>): Promise<void> {
  const data = loadMinerActivity();
  data[botUsername] = activity;
  await saveMinerActivity(data);
}

export async function startMiningSession(session: MiningSession): Promise<void> {
  const activity = getBotActivity(session.botUsername);
  if (activity.activeSession) {
    activity.activeSession.state = "abandoned";
    activity.activeSession.lastUpdatedAt = new Date().toISOString();
    if (!activity.sessionHistory) activity.sessionHistory = [];
    activity.sessionHistory.unshift(activity.activeSession);
    if (activity.sessionHistory.length > 50) activity.sessionHistory = activity.sessionHistory.slice(0, 50);
  }
  activity.activeSession = session;
  await saveBotActivity(session.botUsername, activity);
}

export async function updateMiningSession(botUsername: string, updates: Partial<MiningSession>): Promise<MiningSession | null> {
  const activity = getBotActivity(botUsername);
  if (!activity.activeSession) return null;
  activity.activeSession = { ...activity.activeSession, ...updates, lastUpdatedAt: new Date().toISOString() };
  await saveBotActivity(botUsername, activity);
  return activity.activeSession;
}

export async function completeMiningSession(botUsername: string): Promise<MiningSession | null> {
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

export async function failMiningSession(botUsername: string, reason: string): Promise<MiningSession | null> {
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

export function getActiveMiningSession(botUsername: string): MiningSession | undefined {
  return getBotActivity(botUsername).activeSession;
}

export function createMiningSession(params: {
  botUsername: string;
  miningType: MiningType;
  targetResourceId: string;
  targetResourceName: string;
  targetSystemId: string;
  targetSystemName: string;
  targetPoiId: string;
  targetPoiName: string;
  homeSystem: string;
  isQuotaDriven: boolean;
  quotaTarget?: number;
  quotaCurrent?: number;
}): MiningSession {
  const now = new Date().toISOString();
  return {
    sessionId: params.botUsername + "_" + Date.now(),
    botUsername: params.botUsername,
    miningType: params.miningType,
    targetResourceId: params.targetResourceId,
    targetResourceName: params.targetResourceName,
    targetSystemId: params.targetSystemId,
    targetSystemName: params.targetSystemName,
    targetPoiId: params.targetPoiId,
    targetPoiName: params.targetPoiName,
    homeSystem: params.homeSystem,
    isQuotaDriven: params.isQuotaDriven,
    quotaTarget: params.quotaTarget ?? 0,
    quotaCurrent: params.quotaCurrent ?? 0,
    startedAt: now,
    lastUpdatedAt: now,
    state: "traveling_to_ore",
    cyclesMined: 0,
    resourcesMined: {},
    notes: params.isQuotaDriven ? `Quota-driven: ${params.quotaTarget} units target` : "Configured target",
  };
}
