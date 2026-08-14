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
    const existing = loadouts[name];
    loadouts[name] = {
      name,
      items: loadout.items,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      // Editing a loadout must not silently switch it off / drop its
      // force-full flag when the caller omits those fields.
      active: loadout.active ?? existing?.active ?? false,
      forceFullDelivery: loadout.forceFullDelivery ?? existing?.forceFullDelivery ?? false,
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

// ── Facility Transfer delivery progress ────────────────────────
//
// `forceFullDelivery` loadouts mean "actually haul `targetQuantity` units to
// this station", regardless of how much already sits in its faction storage.
// Station stock levels therefore cannot be used to decide whether such a
// loadout is satisfied — we have to remember how much WE delivered. That is
// what this progress file is for: per station, per loadout, per item.
//
// The recorded `target` is stored alongside the counter so that editing a
// loadout's target quantity restarts the count instead of silently inheriting
// progress from the old target.

export interface FacilityTransferProgressItem {
  delivered: number;
  target: number;
  updatedAt: number;
}

export type FacilityTransferProgress = Record<string, Record<string, Record<string, FacilityTransferProgressItem>>>;

const PROGRESS_FILE = join(DATA_DIR, "facilityTransferProgress.json");

function loadProgressData(): FacilityTransferProgress {
  try {
    if (existsSync(PROGRESS_FILE)) {
      return JSON.parse(readFileSync(PROGRESS_FILE, "utf-8")) as FacilityTransferProgress;
    }
  } catch (err) {
    console.warn("Could not load facilityTransferProgress.json:", err);
  }
  return {};
}

function saveProgressData(data: FacilityTransferProgress): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(PROGRESS_FILE, JSON.stringify(data, null, 2) + "\n", "utf-8");
  } catch (err) {
    console.error("Error saving facilityTransferProgress.json:", err);
  }
}

/**
 * How much of `itemId` this fleet has already hauled to `stationId` for
 * `loadoutName`. Returns 0 when the stored progress was recorded against a
 * different target quantity (the loadout was edited since).
 */
export function getLoadoutDeliveredQty(stationId: string, loadoutName: string, itemId: string, target: number): number {
  const entry = loadProgressData()[stationId]?.[loadoutName]?.[itemId];
  if (!entry) return 0;
  if (target > 0 && entry.target !== target) return 0;
  return Math.max(0, entry.delivered || 0);
}

/** Record `qty` more units delivered for a force-full loadout. Returns the new total. */
export function addLoadoutDeliveredQty(
  stationId: string,
  loadoutName: string,
  itemId: string,
  qty: number,
  target: number
): number {
  if (qty <= 0) return getLoadoutDeliveredQty(stationId, loadoutName, itemId, target);
  const data = loadProgressData();
  if (!data[stationId]) data[stationId] = {};
  if (!data[stationId][loadoutName]) data[stationId][loadoutName] = {};
  const existing = data[stationId][loadoutName][itemId];
  const entry: FacilityTransferProgressItem =
    existing && (target <= 0 || existing.target === target)
      ? existing
      : { delivered: 0, target, updatedAt: Date.now() };
  entry.delivered = Math.max(0, (entry.delivered || 0)) + qty;
  entry.target = target;
  entry.updatedAt = Date.now();
  data[stationId][loadoutName][itemId] = entry;
  saveProgressData(data);
  return entry.delivered;
}

export function getStationLoadoutProgress(stationId: string): Record<string, Record<string, FacilityTransferProgressItem>> {
  return loadProgressData()[stationId] || {};
}

export function clearLoadoutProgress(loadoutName: string): void {
  const data = loadProgressData();
  let changed = false;
  for (const stationId of Object.keys(data)) {
    if (data[stationId][loadoutName]) {
      delete data[stationId][loadoutName];
      changed = true;
    }
    if (Object.keys(data[stationId]).length === 0) delete data[stationId];
  }
  if (changed) saveProgressData(data);
}

export function clearAllProgress(): void {
  saveProgressData({});
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
    // Replace any previous record for the same loadout so repeated completion
    // checks cannot pile up duplicate entries for one station.
    completions[stationId] = completions[stationId].filter(c => c.loadoutName !== loadoutName);
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
    // Force-full loadouts are judged by hauled progress, so resetting a
    // completion must also reset the haul counters or the loadout would be
    // re-marked complete on the next check.
    clearLoadoutProgress(loadoutName);
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
    clearAllProgress();
  } catch (err) {
    console.error("Error clearing all completions:", err);
  }
}
