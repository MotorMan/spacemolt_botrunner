/**
 * Trade session persistence for the trader routine.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const DATA_DIR = join(process.cwd(), "data");
const ACTIVITY_FILE = join(DATA_DIR, "traderActivity.json");

export type TradeSessionState = "buying" | "in_transit" | "at_destination" | "selling" | "completed" | "abandoned" | "failed";

export interface TradeSession {
  sessionId: string;
  botUsername: string;
  itemId: string;
  itemName: string;
  sourceSystem: string;
  sourcePoi: string;
  sourcePoiName: string;
  buyPricePerUnit: number;
  quantityBought: number;
  totalSpent: number;
  destSystem: string;
  destPoi: string;
  destPoiName: string;
  sellPricePerUnit: number;
  sellQuantity: number;
  totalJumps: number;
  jumpsCompleted: number;
  estimatedFuelCost: number;
  investedCredits: number;
  expectedRevenue: number;
  expectedProfit: number;
  startedAt: string;
  lastUpdatedAt: string;
  completedAt?: string;
  state: TradeSessionState;
  isFactionRoute?: boolean;
  isCargoRoute?: boolean;
  hasInsurance?: boolean;
  notes?: string;
}

export interface TraderActivityData {
  [botUsername: string]: {
    activeSession?: TradeSession;
    lastCompletedSession?: TradeSession;
    sessionHistory?: TradeSession[];
  };
}

export function loadTraderActivity(): TraderActivityData {
  try {
    if (existsSync(ACTIVITY_FILE)) {
      return JSON.parse(readFileSync(ACTIVITY_FILE, "utf-8"));
    }
  } catch (err) {
    console.warn("Could not load traderActivity.json:", err);
  }
  return {};
}

export function saveTraderActivity(data: TraderActivityData): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(ACTIVITY_FILE, JSON.stringify(data, null, 2) + "\n");
  } catch (err) {
    console.error("Error saving traderActivity.json:", err);
  }
}

function getBotActivity(botUsername: string) {
  const data = loadTraderActivity();
  if (!data[botUsername]) {
    data[botUsername] = { activeSession: undefined, lastCompletedSession: undefined, sessionHistory: [] };
  }
  return data[botUsername]!;
}

function saveBotActivity(botUsername: string, activity: ReturnType<typeof getBotActivity>): void {
  const data = loadTraderActivity();
  data[botUsername] = activity;
  saveTraderActivity(data);
}

export function startTradeSession(session: TradeSession): void {
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

export function updateTradeSession(botUsername: string, updates: Partial<TradeSession>): TradeSession | null {
  const activity = getBotActivity(botUsername);
  if (!activity.activeSession) return null;
  activity.activeSession = { ...activity.activeSession, ...updates, lastUpdatedAt: new Date().toISOString() };
  saveBotActivity(botUsername, activity);
  return activity.activeSession;
}

export function completeTradeSession(botUsername: string, actualRevenue?: number, actualProfit?: number): TradeSession | null {
  const activity = getBotActivity(botUsername);
  if (!activity.activeSession) return null;
  const session = activity.activeSession;
  session.state = "completed";
  session.completedAt = new Date().toISOString();
  session.lastUpdatedAt = session.completedAt;
  if (actualRevenue !== undefined) session.expectedRevenue = actualRevenue;
  if (actualProfit !== undefined) session.expectedProfit = actualProfit;
  if (!activity.sessionHistory) activity.sessionHistory = [];
  activity.lastCompletedSession = session;
  activity.sessionHistory.unshift(session);
  if (activity.sessionHistory.length > 50) activity.sessionHistory = activity.sessionHistory.slice(0, 50);
  activity.activeSession = undefined;
  saveBotActivity(botUsername, activity);
  return session;
}

export function failTradeSession(botUsername: string, reason: string): TradeSession | null {
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

export function getActiveSession(botUsername: string): TradeSession | undefined {
  return getBotActivity(botUsername).activeSession;
}

export function createTradeSession(params: {
  botUsername: string;
  route: { itemId: string; itemName: string; sourceSystem: string; sourcePoi: string; sourcePoiName: string; buyPrice: number; buyQty: number; destSystem: string; destPoi: string; destPoiName: string; sellPrice: number; sellQty: number; jumps: number; profitPerUnit: number; totalProfit: number; };
  isFactionRoute?: boolean;
  isCargoRoute?: boolean;
  investedCredits?: number;
}): TradeSession {
  const now = new Date().toISOString();
  const { route, botUsername, isFactionRoute, isCargoRoute, investedCredits } = params;
  return {
    sessionId: botUsername + "_" + Date.now(),
    botUsername,
    itemId: route.itemId,
    itemName: route.itemName,
    sourceSystem: route.sourceSystem,
    sourcePoi: route.sourcePoi,
    sourcePoiName: route.sourcePoiName,
    buyPricePerUnit: route.buyPrice,
    quantityBought: route.buyQty,
    totalSpent: route.buyPrice * route.buyQty,
    destSystem: route.destSystem,
    destPoi: route.destPoi,
    destPoiName: route.destPoiName,
    sellPricePerUnit: route.sellPrice,
    sellQuantity: route.sellQty,
    totalJumps: route.jumps,
    jumpsCompleted: 0,
    estimatedFuelCost: route.jumps * 50,
    investedCredits: investedCredits ?? route.buyPrice * route.buyQty,
    expectedRevenue: route.sellPrice * route.sellQty,
    expectedProfit: route.totalProfit,
    startedAt: now,
    lastUpdatedAt: now,
    state: isCargoRoute || (isFactionRoute && route.jumps === 0) ? "selling" : "buying",
    isFactionRoute,
    isCargoRoute,
    hasInsurance: false,
    notes: isFactionRoute ? "Faction storage route" : isCargoRoute ? "Cargo sell route" : "Market buy route",
  };
}
