/**
 * Mining session persistence for the miner routine.
 * Tracks active mining targets, quotas being worked on, and current location.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const DATA_DIR = join(process.cwd(), "data");
const ACTIVITY_FILE = join(DATA_DIR, "minerActivity.json");

export type MiningSessionState = "traveling_to_ore" | "mining" | "returning_home" | "depositing" | "completed" | "abandoned" | "failed";

export type MiningType = "ore" | "gas" | "ice";

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
  try {
    if (existsSync(ACTIVITY_FILE)) {
      return JSON.parse(readFileSync(ACTIVITY_FILE, "utf-8"));
    }
  } catch (err) {
    console.warn("Could not load minerActivity.json:", err);
  }
  return {};
}

export function saveMinerActivity(data: MinerActivityData): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(ACTIVITY_FILE, JSON.stringify(data, null, 2) + "\n");
  } catch (err) {
    console.error("Error saving minerActivity.json:", err);
  }
}

function getBotActivity(botUsername: string) {
  const data = loadMinerActivity();
  if (!data[botUsername]) {
    data[botUsername] = { activeSession: undefined, lastCompletedSession: undefined, sessionHistory: [] };
  }
  return data[botUsername]!;
}

function saveBotActivity(botUsername: string, activity: ReturnType<typeof getBotActivity>): void {
  const data = loadMinerActivity();
  data[botUsername] = activity;
  saveMinerActivity(data);
}

export function startMiningSession(session: MiningSession): void {
  const activity = getBotActivity(session.botUsername);
  if (activity.activeSession) {
    activity.activeSession.state = "abandoned";
    activity.activeSession.lastUpdatedAt = new Date().toISOString();
    if (!activity.sessionHistory) activity.sessionHistory = [];
    activity.sessionHistory.unshift(activity.activeSession);
    if (activity.sessionHistory.length > 50) activity.sessionHistory = activity.sessionHistory.slice(0, 50);
  }
  activity.activeSession = session;
  saveBotActivity(session.botUsername, activity);
}

export function updateMiningSession(botUsername: string, updates: Partial<MiningSession>): MiningSession | null {
  const activity = getBotActivity(botUsername);
  if (!activity.activeSession) return null;
  activity.activeSession = { ...activity.activeSession, ...updates, lastUpdatedAt: new Date().toISOString() };
  saveBotActivity(botUsername, activity);
  return activity.activeSession;
}

export function completeMiningSession(botUsername: string): MiningSession | null {
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
  saveBotActivity(botUsername, activity);
  return session;
}

export function failMiningSession(botUsername: string, reason: string): MiningSession | null {
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
  saveBotActivity(botUsername, activity);
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
    sessionId: botUsername + "_" + Date.now(),
    botUsername,
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
