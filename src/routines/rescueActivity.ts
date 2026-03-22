/**
 * Rescue session persistence for the rescue routines.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const DATA_DIR = join(process.cwd(), "data");
const ACTIVITY_FILE = join(DATA_DIR, "rescueActivity.json");

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
}

export interface RescueActivityData {
  [botUsername: string]: {
    activeSession?: RescueSession;
    lastCompletedSession?: RescueSession;
    sessionHistory?: RescueSession[];
  };
}

export function loadRescueActivity(): RescueActivityData {
  try {
    if (existsSync(ACTIVITY_FILE)) {
      return JSON.parse(readFileSync(ACTIVITY_FILE, "utf-8"));
    }
  } catch (err) {
    console.warn("Could not load rescueActivity.json:", err);
  }
  return {};
}

export function saveRescueActivity(data: RescueActivityData): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(ACTIVITY_FILE, JSON.stringify(data, null, 2) + "\n");
  } catch (err) {
    console.error("Error saving rescueActivity.json:", err);
  }
}

function getBotActivity(botUsername: string) {
  const data = loadRescueActivity();
  if (!data[botUsername]) {
    data[botUsername] = { activeSession: undefined, lastCompletedSession: undefined, sessionHistory: [] };
  }
  return data[botUsername]!;
}

function saveBotActivity(botUsername: string, activity: ReturnType<typeof getBotActivity>): void {
  const data = loadRescueActivity();
  data[botUsername] = activity;
  saveRescueActivity(data);
}

export function startRescueSession(session: RescueSession): void {
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
  saveBotActivity(session.botUsername, activity);
}

export function updateRescueSession(botUsername: string, updates: Partial<RescueSession>): RescueSession | null {
  const activity = getBotActivity(botUsername);
  if (!activity.activeSession) return null;
  activity.activeSession = { ...activity.activeSession, ...updates, lastUpdatedAt: new Date().toISOString() };
  saveBotActivity(botUsername, activity);
  return activity.activeSession;
}

export function completeRescueSession(botUsername: string): RescueSession | null {
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

export function failRescueSession(botUsername: string, reason: string): RescueSession | null {
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

export function getActiveRescueSession(botUsername: string): RescueSession | undefined {
  return getBotActivity(botUsername).activeSession;
}

export function clearActiveRescueSession(botUsername: string): void {
  const activity = getBotActivity(botUsername);
  activity.activeSession = undefined;
  saveBotActivity(botUsername, activity);
}
