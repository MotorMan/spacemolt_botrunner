import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const DATA_DIR = join(process.cwd(), "data");
const TRACKING_FILE = join(DATA_DIR, "fuelServiceState.json");

export function getTrackingFilePath(): string {
  return TRACKING_FILE;
}

export type FacilityStatus = "pending_facility" | "building_facility" | "pending_materials" | "crafting_fuel" | "monitoring" | "transporting_materials";

export interface MaterialTransportStatus {
  itemId: string;
  itemName: string;
  neededQty: number;
  inCargo: number;
  withdrawnQty: number;
  depositedQty: number;
  status: "pending" | "withdrawing" | "in_transit" | "depositing" | "complete" | "failed";
  error?: string;
}

export interface ActiveTransport {
  stationId: string;
  facilityType: string;
  homeStation: string;
  homeSystem: string;
  items: Array<{ itemId: string; neededQty: number; withdrawnQty: number; depositedQty: number }>;
  currentItemIndex: number;
  status: "withdrawing" | "in_transit" | "depositing";
}

export interface StationFacilityState {
  stationId: string;
  facilityType: string;
  facilityId?: string;
  facilityBuilt: boolean;
  facilityUnderConstruction: boolean;
  craftJobId?: string;
  craftJobRecipeId: string;
  craftJobRunsDone: number;
  craftJobRunsTotal: number;
  lastCraftJobCheck: number;
  lastQueuedRuns?: number;
  status: FacilityStatus;
  buildFailures: number;
  materialTransport?: Record<string, MaterialTransportStatus>;
  activeTransport?: ActiveTransport;
}

export interface ShipInfo {
  shipId: string;
  speed: number;
  cargoCapacity: number;
}

export interface FuelServiceState {
  version: number;
  facilities: Record<string, StationFacilityState>;
  ships: Record<string, ShipInfo>;
}

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadState(): FuelServiceState {
  try {
    if (existsSync(TRACKING_FILE)) {
      const raw = readFileSync(TRACKING_FILE, "utf-8");
      const data = JSON.parse(raw) as FuelServiceState;
      if (!data.version) data.version = 1;
      if (!data.facilities) data.facilities = {};
      if (!data.ships) data.ships = {};
      return data;
    }
  } catch (err) {
    console.warn("Could not load fuelServiceState.json:", err);
  }
  return { version: 1, facilities: {}, ships: {} };
}

function saveState(data: FuelServiceState): void {
  ensureDataDir();
  try {
    writeFileSync(TRACKING_FILE, JSON.stringify(data, null, 2) + "\n", "utf-8");
  } catch (err) {
    console.error("Failed to save fuelServiceState.json:", err);
  }
}

export function getFacilityState(stationId: string, facilityType: string): StationFacilityState | null {
  const data = loadState();
  const key = `${stationId}::${facilityType}`;
  return data.facilities[key] || null;
}

export function saveFacilityState(state: StationFacilityState): void {
  const data = loadState();
  const key = `${state.stationId}::${state.facilityType}`;
  data.facilities[key] = state;
  saveState(data);
  console.log(`[fuelServiceTracking] Saved facility state: ${key}, status=${state.status}`);
}

export function updateFacilityState(
  stationId: string,
  facilityType: string,
  updates: Partial<StationFacilityState>
): StationFacilityState {
  const data = loadState();
  const key = `${stationId}::${facilityType}`;
  const existing = data.facilities[key] || {
    stationId,
    facilityType,
    facilityBuilt: false,
    facilityUnderConstruction: false,
    craftJobRecipeId: "",
    craftJobRunsDone: 0,
    craftJobRunsTotal: 0,
    lastCraftJobCheck: 0,
    lastQueuedRuns: 0,
    status: "pending_facility" as FacilityStatus,
    buildFailures: 0,
  };
  const updated: StationFacilityState = { ...existing, ...updates };
  data.facilities[key] = updated;
  saveState(data);
  return updated;
}

export function getAllFacilityStates(): Record<string, StationFacilityState> {
  return loadState().facilities;
}

export function clearFacilityState(stationId: string, facilityType: string): void {
  const data = loadState();
  const key = `${stationId}::${facilityType}`;
  delete data.facilities[key];
  saveState(data);
}

export function clearAllFacilityStates(): void {
  saveState({ version: 1, facilities: {}, ships: {} });
}

export function getShipInfo(shipId: string): ShipInfo | null {
  const data = loadState();
  return data.ships?.[shipId] || null;
}

export function saveShipInfo(shipId: string, info: ShipInfo): void {
  const data = loadState();
  if (!data.ships) data.ships = {};
  data.ships[shipId] = info;
  saveState(data);
}

export function getAllShipInfos(): Record<string, ShipInfo> {
  return loadState().ships || {};
}

export function clearShipInfo(shipId: string): void {
  const data = loadState();
  if (data.ships && data.ships[shipId]) {
    delete data.ships[shipId];
    saveState(data);
  }
}

export function incrementBuildFailures(stationId: string, facilityType: string): number {
  const state = updateFacilityState(stationId, facilityType, {});
  const failures = (state.buildFailures || 0) + 1;
  updateFacilityState(stationId, facilityType, { buildFailures: failures });
  return failures;
}

export function resetBuildFailures(stationId: string, facilityType: string): void {
  updateFacilityState(stationId, facilityType, { buildFailures: 0 });
}

export function updateMaterialTransportStatus(
  stationId: string,
  facilityType: string,
  itemId: string,
  updates: Partial<MaterialTransportStatus>
): void {
  const data = loadState();
  const key = `${stationId}::${facilityType}`;
  const existing = data.facilities[key] || {
    stationId,
    facilityType,
    facilityBuilt: false,
    facilityUnderConstruction: false,
    craftJobRecipeId: "",
    craftJobRunsDone: 0,
    craftJobRunsTotal: 0,
    lastCraftJobCheck: 0,
    lastQueuedRuns: 0,
    status: "pending_facility" as FacilityStatus,
    buildFailures: 0,
  };
  const currentTransport = existing.materialTransport || {};
  const currentMaterial = currentTransport[itemId] || {
    itemId,
    itemName: itemId,
    neededQty: 0,
    inCargo: 0,
    withdrawnQty: 0,
    depositedQty: 0,
    status: "pending" as const,
  };
  const updatedMaterial: MaterialTransportStatus = { ...currentMaterial, ...updates };
  currentTransport[itemId] = updatedMaterial;
  const updated: StationFacilityState = { ...existing, materialTransport: currentTransport };
  data.facilities[key] = updated;
  saveState(data);
}

export function startActiveTransport(
  stationId: string,
  facilityType: string,
  homeStation: string,
  homeSystem: string,
  items: Array<{ itemId: string; neededQty: number }>
): ActiveTransport {
  const data = loadState();
  const key = `${stationId}::${facilityType}`;
  const existing = data.facilities[key] || {
    stationId,
    facilityType,
    facilityBuilt: false,
    facilityUnderConstruction: false,
    craftJobRecipeId: "",
    craftJobRunsDone: 0,
    craftJobRunsTotal: 0,
    lastCraftJobCheck: 0,
    lastQueuedRuns: 0,
    status: "pending_facility" as FacilityStatus,
    buildFailures: 0,
  };

  const activeTransport: ActiveTransport = {
    stationId,
    facilityType,
    homeStation,
    homeSystem,
    items: items.map(i => ({ ...i, withdrawnQty: 0, depositedQty: 0 })),
    currentItemIndex: 0,
    status: "withdrawing",
  };

  const updated: StationFacilityState = { ...existing, activeTransport, status: "transporting_materials" };
  data.facilities[key] = updated;
  saveState(data);
  console.log(`[fuelServiceTracking] Started active transport: ${key}, items=${items.length}`);
  return activeTransport;
}

export function updateActiveTransport(
  stationId: string,
  facilityType: string,
  updates: Partial<ActiveTransport>
): ActiveTransport | null {
  const data = loadState();
  const key = `${stationId}::${facilityType}`;
  const existing = data.facilities[key];
  if (!existing?.activeTransport) return null;

  const updated: ActiveTransport = { ...existing.activeTransport, ...updates };
  const updatedState: StationFacilityState = { ...existing, activeTransport: updated };
  data.facilities[key] = updatedState;
  saveState(data);
  console.log(`[fuelServiceTracking] Updated active transport: ${key}, index=${updated.currentItemIndex}, status=${updated.status}`);
  return updated;
}

export function clearActiveTransport(stationId: string, facilityType: string): void {
  const data = loadState();
  const key = `${stationId}::${facilityType}`;
  const existing = data.facilities[key];
  if (!existing) return;

  const updated: StationFacilityState = { ...existing, activeTransport: undefined };
  data.facilities[key] = updated;
  saveState(data);
  console.log(`[fuelServiceTracking] Cleared active transport: ${key}`);
}