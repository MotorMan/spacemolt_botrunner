import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const DATA_DIR = join(process.cwd(), "data");
const TRACKING_FILE = join(DATA_DIR, "fuelTransfer.json");

export interface FuelTripEvent {
  event: "withdraw" | "depart" | "arrive" | "deposit_faction" | "deposit_personal" | "deposit_failed" | "error";
  qty?: number;
  station?: string;
  system?: string;
  error?: string;
  ts: string;
}

export interface FuelTripRecord {
  tripId: string;
  botUsername: string;
  itemId: string;
  itemName: string;
  targetStation: string;
  targetSystem: string;
  status: "withdrawn" | "in_transit" | "arrived" | "depositing" | "complete" | "failed" | "partial";
  withdrawnQty: number;
  depositedQty: number;
  depositTarget: "faction" | "personal";
  events: FuelTripEvent[];
  startedAt: string;
  completedAt?: string;
}

export interface FuelTransferBotData {
  currentTrip?: Omit<FuelTripRecord, "tripId" | "botUsername" | "events" | "startedAt" | "completedAt"> & {
    tripId?: string;
    events?: FuelTripEvent[];
    startedAt?: string;
    completedAt?: string;
  };
  history: FuelTripRecord[];
}

export interface FuelTransferData {
  version: number;
  bots: Record<string, FuelTransferBotData>;
}

export function loadFuelTransferData(): FuelTransferData {
  try {
    if (existsSync(TRACKING_FILE)) {
      const raw = readFileSync(TRACKING_FILE, "utf-8");
      const data = JSON.parse(raw) as FuelTransferData;
      if (!data.bots) data.bots = {};
      for (const bot of Object.keys(data.bots)) {
        if (!data.bots[bot].history) data.bots[bot].history = [];
      }
      return data;
    }
  } catch (err) {
    console.warn("Could not load fuelTransfer.json:", err);
  }
  return { version: 1, bots: {} };
}

export function saveFuelTransferData(data: FuelTransferData): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(TRACKING_FILE, JSON.stringify(data, null, 2) + "\n");
  } catch (err) {
    console.error("Error saving fuelTransfer.json:", err);
  }
}

function ensureBot(botUsername: string): FuelTransferBotData {
  const data = loadFuelTransferData();
  if (!data.bots[botUsername]) {
    data.bots[botUsername] = { history: [] };
  }
  saveFuelTransferData(data);
  return data.bots[botUsername];
}

export function startTrip(
  botUsername: string,
  itemId: string,
  itemName: string,
  targetStation: string,
  targetSystem: string,
  withdrawnQty: number,
  depositTarget: "faction" | "personal" = "faction"
): { tripId: string; data: FuelTransferData } {
  const tripId = `trip_${botUsername}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const now = new Date().toISOString();
  const data = loadFuelTransferData();
  if (!data.bots[botUsername]) data.bots[botUsername] = { history: [] };

  data.bots[botUsername].currentTrip = {
    tripId,
    itemId,
    itemName,
    targetStation,
    targetSystem,
    status: "withdrawn",
    withdrawnQty,
    depositedQty: 0,
    depositTarget,
    events: [{ event: "withdraw", qty: withdrawnQty, station: targetStation, system: targetSystem, ts: now }],
    startedAt: now,
  };

  saveFuelTransferData(data);
  return { tripId, data };
}

export function addTripEvent(
  botUsername: string,
  event: FuelTripEvent["event"],
  opts?: { qty?: number; station?: string; system?: string; error?: string }
): void {
  const data = loadFuelTransferData();
  const botData = data.bots[botUsername];
  if (!botData?.currentTrip) return;

  const now = new Date().toISOString();
  const evt: FuelTripEvent = { event, ts: now, ...opts };

  botData.currentTrip.events = botData.currentTrip.events || [];
  botData.currentTrip.events.push(evt);

  if (event === "depart") botData.currentTrip.status = "in_transit";
  if (event === "arrive") botData.currentTrip.status = "arrived";
  if (event === "deposit_faction" || event === "deposit_personal") {
    botData.currentTrip.status = "complete";
    botData.currentTrip.depositedQty = opts?.qty ?? botData.currentTrip.depositedQty;
    botData.currentTrip.depositTarget = event === "deposit_faction" ? "faction" : "personal";
  }
  if (event === "deposit_failed" || event === "error") {
    botData.currentTrip.status = botData.currentTrip.status === "arrived" ? "failed" : botData.currentTrip.status;
  }

  saveFuelTransferData(data);
}

export function completeTrip(botUsername: string, depositedQty: number): void {
  const data = loadFuelTransferData();
  const botData = data.bots[botUsername];
  if (!botData?.currentTrip) return;

  const now = new Date().toISOString();
  const record: FuelTripRecord = {
    tripId: botData.currentTrip.tripId!,
    botUsername,
    itemId: botData.currentTrip.itemId,
    itemName: botData.currentTrip.itemName,
    targetStation: botData.currentTrip.targetStation,
    targetSystem: botData.currentTrip.targetSystem,
    status: botData.currentTrip.depositedQty >= depositedQty ? "complete" : "partial",
    withdrawnQty: botData.currentTrip.withdrawnQty,
    depositedQty,
    depositTarget: botData.currentTrip.depositTarget,
    events: botData.currentTrip.events || [],
    startedAt: botData.currentTrip.startedAt || now,
    completedAt: now,
  };

  botData.history.unshift(record);
  if (botData.history.length > 500) botData.history = botData.history.slice(0, 500);

  botData.currentTrip = undefined;
  saveFuelTransferData(data);
}

export function failCurrentTrip(botUsername: string, reason: string): void {
  const data = loadFuelTransferData();
  const botData = data.bots[botUsername];
  if (!botData?.currentTrip) return;

  const now = new Date().toISOString();
  botData.currentTrip.status = "failed";
  botData.currentTrip.events = botData.currentTrip.events || [];
  botData.currentTrip.events.push({ event: "error", error: reason, ts: now });
  botData.currentTrip.completedAt = now;

  const record: FuelTripRecord = {
    tripId: botData.currentTrip.tripId!,
    botUsername,
    itemId: botData.currentTrip.itemId,
    itemName: botData.currentTrip.itemName,
    targetStation: botData.currentTrip.targetStation,
    targetSystem: botData.currentTrip.targetSystem,
    status: "failed",
    withdrawnQty: botData.currentTrip.withdrawnQty,
    depositedQty: botData.currentTrip.depositedQty,
    depositTarget: botData.currentTrip.depositTarget,
    events: botData.currentTrip.events,
    startedAt: botData.currentTrip.startedAt || now,
    completedAt: now,
  };

  botData.history.unshift(record);
  if (botData.history.length > 500) botData.history = botData.history.slice(0, 500);
  botData.currentTrip = undefined;
  saveFuelTransferData(data);
}

export function getCurrentTrip(botUsername: string): FuelTransferBotData["currentTrip"] {
  const data = loadFuelTransferData();
  return data.bots[botUsername]?.currentTrip;
}

export function getBotHistory(botUsername: string): FuelTripRecord[] {
  const data = loadFuelTransferData();
  return data.bots[botUsername]?.history || [];
}
