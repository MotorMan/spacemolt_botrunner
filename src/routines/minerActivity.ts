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
const WRITE_INTERVAL_MS = 60000;

let cachedData: MinerActivityData = {};
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

export interface FailedTargetRecord {
  oreId: string;
  systemId: string;
  poiId: string;
  failedAt: string;
  reason: string;
}

export interface MinerActivityData {
  [botUsername: string]: {
    activeSession?: MiningSession;
    lastCompletedSession?: MiningSession;
    sessionHistory?: MiningSession[];
    failedTargets: FailedTargetRecord[];
  };
}

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function readFromFile(): MinerActivityData {
  try {
    if (existsSync(ACTIVITY_FILE)) {
      const content = readFileSync(ACTIVITY_FILE, "utf-8").trim();
      if (content) {
        const parsed = JSON.parse(content);
        if (typeof parsed === "object" && parsed !== null) {
          return parsed;
        }
      }
    }
  } catch (err) {
    console.warn("Could not load miner activity:", err);
  }
  return {};
}

function writeToFile(data: MinerActivityData): boolean {
  try {
    ensureDataDir();
    writeFileSync(ACTIVITY_FILE, JSON.stringify(data, null, 2) + "\n", "utf-8");
    return true;
  } catch (err: any) {
    console.warn("Failed to write miner activity:", err?.message || err);
    return false;
  }
}

export function loadMinerActivity(): MinerActivityData {
  cachedData = readFromFile();
  return cachedData;
}

async function saveWithRetry(data: MinerActivityData): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (writeToFile(data)) return true;
    
    if (attempt < MAX_RETRIES) {
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * Math.pow(2, attempt - 1)));
    }
  }
  return false;
}

export async function saveMinerActivity(data: MinerActivityData): Promise<void> {
  ensureDataDir();
  cachedData = data;
  
  const fileExists = existsSync(ACTIVITY_FILE);
  
  if (!fileExists) {
    const success = await saveWithRetry(cachedData);
    if (!success) {
      console.error("FAILED to create minerActivity.json! Data may be lost.");
    }
    return;
  }
  
  if (!isFlushPending) {
    isFlushPending = true;
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(async () => {
      isFlushPending = false;
      writeTimer = null;
      const success = await saveWithRetry(cachedData);
      if (!success) {
        console.error("FAILED to save minerActivity.json after all retries! Data may be lost.");
      }
    }, WRITE_INTERVAL_MS);
  }
}

export async function flushMinerActivity(): Promise<boolean> {
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
  if (!cachedData[botUsername]) {
    cachedData[botUsername] = { activeSession: undefined, lastCompletedSession: undefined, sessionHistory: [], failedTargets: [] };
  }
  return cachedData[botUsername]!;
}

async function saveBotActivity(botUsername: string, activity: { activeSession?: MiningSession; lastCompletedSession?: MiningSession; sessionHistory?: MiningSession[]; failedTargets?: FailedTargetRecord[] }): Promise<void> {
  cachedData[botUsername] = activity as MinerActivityData[string];
  await saveMinerActivity(cachedData);
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

export function recordFailedTarget(botUsername: string, oreId: string, systemId: string, poiId: string, reason: string): void {
  const activity = getBotActivity(botUsername);
  if (!activity.failedTargets) activity.failedTargets = [];
  
  activity.failedTargets.push({
    oreId,
    systemId,
    poiId,
    failedAt: new Date().toISOString(),
    reason,
  });
  
  // Keep only last 50 failed targets
  if (activity.failedTargets.length > 50) {
    activity.failedTargets = activity.failedTargets.slice(-50);
  }
  
  saveMinerActivity(cachedData);
}

export function isTargetFailedInSystem(botUsername: string, oreId: string, systemId: string, poiId: string, timeoutMs: number = 3 * 60 * 60 * 1000): boolean {
  const activity = getBotActivity(botUsername);
  if (!activity.failedTargets) return false;
  
  const cutoffTime = Date.now() - timeoutMs;
  return activity.failedTargets.some(f => 
    f.oreId === oreId && 
    f.systemId === systemId && 
    f.poiId === poiId &&
    new Date(f.failedAt).getTime() > cutoffTime
  );
}