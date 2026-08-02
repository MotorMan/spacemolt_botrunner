import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";

const DATA_DIR = join(process.cwd(), "data");
const TRACKING_FILE = join(DATA_DIR, "fuelTransfer.json");
const FACTION_STORAGE_DIR = join(DATA_DIR, "factionStorage");

export interface FuelTripEvent {
  event: "withdraw" | "depart" | "arrive" | "deposit_faction" | "deposit_personal" | "deposit_failed" | "error";
  qty?: number;
  station?: string;
  system?: string;
  error?: string;
  ts: string;
}

export interface FactionStorageEntry {
  itemId: string;
  quantity: number;
  name?: string;
}

export interface FactionStorageRecord {
  factionName: string;
  station: string;
  lastUpdated: number;
  entries: FactionStorageEntry[];
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

export function loadFactionStorageRecord(station: string): FactionStorageRecord | null {
  try {
    const sanitized = station.replace(/::/g, "--").replace(/[^a-zA-Z0-9\-_]/g, "_");
    const cacheFile = join(FACTION_STORAGE_DIR, `${sanitized}.json`);
    if (existsSync(cacheFile)) {
      const raw = readFileSync(cacheFile, "utf-8");
      return JSON.parse(raw) as FactionStorageRecord;
    }
  } catch (err) {
    console.warn(`Could not load faction storage record for ${station}:`, err);
  }
  return null;
}

export function getAllFactionStorageRecords(): FactionStorageRecord[] {
  const records: FactionStorageRecord[] = [];
  try {
    if (!existsSync(FACTION_STORAGE_DIR)) return records;
    const files = readdirSync(FACTION_STORAGE_DIR);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const cacheFile = join(FACTION_STORAGE_DIR, file);
      const raw = readFileSync(cacheFile, "utf-8");
      const record = JSON.parse(raw) as FactionStorageRecord;
      if (record.station && record.entries && record.entries.length > 0) {
        records.push(record);
      }
    }
  } catch (err) {
    console.warn("Could not load faction storage records:", err);
  }
  return records;
}

export function getFactionStorageQuantity(station: string, itemId: string): number {
  const record = loadFactionStorageRecord(station);
  if (!record) return 0;
  const entry = record.entries.find(e => e.itemId === itemId);
  return entry?.quantity || 0;
}

export function getFactionStorageLastUpdated(station: string): number {
  const record = loadFactionStorageRecord(station);
  return record?.lastUpdated || 0;
}

export function updateFactionStorageFromDeposit(
  station: string,
  factionName: string,
  itemId: string,
  depositedQty: number,
  itemName?: string
): void {
  try {
    const record = loadFactionStorageRecord(station);
    const now = Date.now();
    
    if (!record) {
      const newRecord: FactionStorageRecord = {
        factionName,
        station,
        lastUpdated: now,
        entries: [{ itemId, quantity: depositedQty, name: itemName }],
      };
      const sanitized = station.replace(/::/g, "--").replace(/[^a-zA-Z0-9\-_]/g, "_");
      if (!existsSync(FACTION_STORAGE_DIR)) mkdirSync(FACTION_STORAGE_DIR, { recursive: true });
      writeFileSync(join(FACTION_STORAGE_DIR, `${sanitized}.json`), JSON.stringify(newRecord, null, 2), "utf-8");
      return;
    }
    
    const existingEntry = record.entries.find(e => e.itemId === itemId);
    if (existingEntry) {
      existingEntry.quantity += depositedQty;
    } else {
      record.entries.push({ itemId, quantity: depositedQty, name: itemName });
    }
    record.lastUpdated = now;
    
    const sanitized = station.replace(/::/g, "--").replace(/[^a-zA-Z0-9\-_]/g, "_");
    writeFileSync(join(FACTION_STORAGE_DIR, `${sanitized}.json`), JSON.stringify(record, null, 2), "utf-8");
  } catch (err) {
    console.warn(`Error updating faction storage for ${station}:`, err);
  }
}

export function refreshFactionStorageCache(
  station: string,
  factionName: string,
  items: { itemId: string; quantity: number; name?: string }[]
): void {
  try {
    const sanitized = station.replace(/::/g, "--").replace(/[^a-zA-Z0-9\-_]/g, "_");
    const now = Date.now();
    
    const record: FactionStorageRecord = {
      factionName,
      station,
      lastUpdated: now,
      entries: items.map(i => ({ itemId: i.itemId, quantity: i.quantity, name: i.name })),
    };
    
    if (!existsSync(FACTION_STORAGE_DIR)) mkdirSync(FACTION_STORAGE_DIR, { recursive: true });
    writeFileSync(join(FACTION_STORAGE_DIR, `${sanitized}.json`), JSON.stringify(record, null, 2), "utf-8");
  } catch (err) {
    console.warn(`Error refreshing faction storage cache for ${station}:`, err);
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

// ── Facility Transfer Loadouts ─────────────────────────────────

export interface FacilityTransferLoadoutItem {
  itemId: string;
  itemName: string;
  targetQuantity: number;
}

export interface FacilityTransferLoadout {
  name: string;
  items: FacilityTransferLoadoutItem[];
  createdAt: string;
  active?: boolean;
  forceFullDelivery?: boolean;
}

const LOADOUTS_FILE = join(DATA_DIR, "facilityTransferLoadouts.json");

function loadFacilityTransferLoadouts(): Record<string, FacilityTransferLoadout> {
  try {
    if (existsSync(LOADOUTS_FILE)) {
      const raw = readFileSync(LOADOUTS_FILE, "utf-8");
      const data = JSON.parse(raw) as Record<string, FacilityTransferLoadout>;
      return data;
    }
  } catch (err) {
    console.warn("Could not load facilityTransferLoadouts.json:", err);
  }
  return {};
}

export function saveFacilityTransferLoadout(name: string, loadout: Omit<FacilityTransferLoadout, "name" | "createdAt">): void {
  try {
    const loadouts = loadFacilityTransferLoadouts();
    loadouts[name] = {
      name,
      items: loadout.items,
      createdAt: new Date().toISOString(),
      active: loadout.active ?? false,
      forceFullDelivery: loadout.forceFullDelivery ?? false,
    };
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(LOADOUTS_FILE, JSON.stringify(loadouts, null, 2) + "\n", "utf-8");
  } catch (err) {
    console.error("Error saving facilityTransferLoadouts.json:", err);
  }
}

export function deleteFacilityTransferLoadout(name: string): boolean {
  try {
    const loadouts = loadFacilityTransferLoadouts();
    if (name in loadouts) {
      delete loadouts[name];
      if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(LOADOUTS_FILE, JSON.stringify(loadouts, null, 2) + "\n", "utf-8");
      return true;
    }
  } catch (err) {
    console.error("Error deleting facilityTransferLoadouts.json:", err);
  }
  return false;
}

export function getFacilityTransferLoadouts(): Record<string, FacilityTransferLoadout> {
  return loadFacilityTransferLoadouts();
}

export function setLoadoutActive(name: string, active: boolean): void {
  try {
    const loadouts = loadFacilityTransferLoadouts();
    if (name in loadouts) {
      loadouts[name].active = active;
      if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(LOADOUTS_FILE, JSON.stringify(loadouts, null, 2) + "\n", "utf-8");
    }
  } catch (err) {
    console.error("Error setting loadout active:", err);
  }
}

export function setLoadoutForceFullDelivery(name: string, forceFullDelivery: boolean): void {
  try {
    const loadouts = loadFacilityTransferLoadouts();
    if (name in loadouts) {
      loadouts[name].forceFullDelivery = forceFullDelivery;
      if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(LOADOUTS_FILE, JSON.stringify(loadouts, null, 2) + "\n", "utf-8");
    }
  } catch (err) {
    console.error("Error setting loadout force full delivery:", err);
  }
}

export interface FacilityTransferStationCompletion {
  stationId: string;
  loadoutName: string;
  completedAt: number;
  itemsDelivered: { itemId: string; quantity: number }[];
}

export function getStationCompletionFilePath(): string {
  return join(DATA_DIR, "facilityTransferCompletions.json");
}

function loadStationCompletions(): Record<string, FacilityTransferStationCompletion[]> {
  try {
    const file = getStationCompletionFilePath();
    if (existsSync(file)) {
      return JSON.parse(readFileSync(file, "utf-8")) as Record<string, FacilityTransferStationCompletion[]>;
    }
  } catch (err) {
    console.warn("Could not load facilityTransferCompletions.json:", err);
  }
  return {};
}

export function saveStationCompletion(stationId: string, loadoutName: string, itemsDelivered: { itemId: string; quantity: number }[]): void {
  try {
    const completions = loadStationCompletions();
    if (!completions[stationId]) completions[stationId] = [];
    completions[stationId].push({
      stationId,
      loadoutName,
      completedAt: Date.now(),
      itemsDelivered,
    });
    const file = getStationCompletionFilePath();
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify(completions, null, 2) + "\n", "utf-8");
  } catch (err) {
    console.error("Error saving facilityTransferCompletions.json:", err);
  }
}

export function isStationCompletedForLoadout(stationId: string, loadoutName: string): boolean {
  const completions = loadStationCompletions();
  const stationCompletions = completions[stationId] || [];
  return stationCompletions.some(c => c.loadoutName === loadoutName);
}

export function getStationCompletions(stationId: string): FacilityTransferStationCompletion[] {
  const completions = loadStationCompletions();
  return completions[stationId] || [];
}

export function clearLoadoutCompletions(loadoutName: string): void {
  try {
    const completions = loadStationCompletions();
    for (const stationId of Object.keys(completions)) {
      completions[stationId] = completions[stationId].filter(c => c.loadoutName !== loadoutName);
      if (completions[stationId].length === 0) {
        delete completions[stationId];
      }
    }
    const file = getStationCompletionFilePath();
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify(completions, null, 2) + "\n", "utf-8");
  } catch (err) {
    console.error("Error clearing loadout completions:", err);
  }
}

export function clearAllCompletions(): void {
  try {
    const file = getStationCompletionFilePath();
    if (existsSync(file)) {
      writeFileSync(file, JSON.stringify({}, null, 2) + "\n", "utf-8");
    }
  } catch (err) {
    console.error("Error clearing all completions:", err);
  }
}
