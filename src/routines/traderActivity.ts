/**
 * Trade session persistence for the trader routine.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "fs";
import { join, dirname } from "path";

const DATA_DIR = join(process.cwd(), "data");
const ACTIVITY_FILE = join(DATA_DIR, "traderActivity.json");
const ACTIVITY_FILE_BACKUP = join(DATA_DIR, "traderActivity.json.bak");
const ACTIVITY_FILE_TEMP = join(DATA_DIR, "traderActivity.json.tmp");

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 100;

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
  // Try main file first, then fallback to backup
  const filesToTry = [ACTIVITY_FILE, ACTIVITY_FILE_BACKUP];
  
  for (const file of filesToTry) {
    try {
      if (existsSync(file)) {
        const content = readFileSync(file, "utf-8").trim();
        if (!content) {
          console.warn(`Empty trader activity file: ${file}`);
          continue;
        }
        const parsed = JSON.parse(content);
        // Basic validation
        if (typeof parsed !== "object" || parsed === null) {
          console.warn(`Invalid trader activity data structure from ${file}`);
          continue;
        }
        console.log(`Loaded trader activity from ${file}`);
        return parsed;
      }
    } catch (err) {
      console.warn(`Could not load ${file}:`, err);
    }
  }
  
  console.warn("No valid trader activity file found. Starting with empty data.");
  return {};
}

async function saveWithRetry(data: string, ctx?: { sleep: (ms: number) => Promise<void> }): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Step 1: Create backup of existing file if it exists
      if (existsSync(ACTIVITY_FILE)) {
        try {
          // Copy current to backup (read + write to avoid rename issues during crash)
          const content = readFileSync(ACTIVITY_FILE, "utf-8");
          writeFileSync(ACTIVITY_FILE_BACKUP, content, "utf-8");
        } catch (backupErr) {
          console.warn("Could not create backup file:", backupErr);
        }
      }
      
      // Step 2: Write to temp file first
      writeFileSync(ACTIVITY_FILE_TEMP, data, "utf-8");
      
      // Step 3: Atomic rename from temp to actual file
      renameSync(ACTIVITY_FILE_TEMP, ACTIVITY_FILE);
      
      // Step 4: Clean up temp file if it still exists (rename should remove it)
      if (existsSync(ACTIVITY_FILE_TEMP)) {
        try {
          unlinkSync(ACTIVITY_FILE_TEMP);
        } catch (_) {
          // Ignore cleanup errors
        }
      }
      
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

export async function saveTraderActivity(data: TraderActivityData): Promise<void> {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    
    const jsonData = JSON.stringify(data, null, 2) + "\n";
    const success = await saveWithRetry(jsonData);
    
    if (!success) {
      console.error("FAILED to save traderActivity.json after all retries! Data may be lost.");
      console.error("Last known data structure keys:", Object.keys(data).join(", "));
    }
  } catch (err) {
    console.error("Unexpected error in saveTraderActivity:", err);
  }
}

function getBotActivity(botUsername: string) {
  const data = loadTraderActivity();
  if (!data[botUsername]) {
    data[botUsername] = { activeSession: undefined, lastCompletedSession: undefined, sessionHistory: [] };
  }
  return data[botUsername]!;
}

async function saveBotActivity(botUsername: string, activity: ReturnType<typeof getBotActivity>): Promise<void> {
  const data = loadTraderActivity();
  data[botUsername] = activity;
  await saveTraderActivity(data);
}

export async function startTradeSession(session: TradeSession): Promise<void> {
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

export async function updateTradeSession(botUsername: string, updates: Partial<TradeSession>): Promise<TradeSession | null> {
  const activity = getBotActivity(botUsername);
  if (!activity.activeSession) return null;
  activity.activeSession = { ...activity.activeSession, ...updates, lastUpdatedAt: new Date().toISOString() };
  await saveBotActivity(botUsername, activity);
  return activity.activeSession;
}

export async function completeTradeSession(botUsername: string, actualRevenue?: number, actualProfit?: number): Promise<TradeSession | null> {
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
  await saveBotActivity(botUsername, activity);
  return session;
}

export async function failTradeSession(botUsername: string, reason: string): Promise<TradeSession | null> {
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
