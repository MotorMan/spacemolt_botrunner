import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const DATA_DIR = join(process.cwd(), "data");
const TRACKING_FILE = join(DATA_DIR, "fuelServiceState.json");

export type FacilityStatus = "pending_facility" | "building_facility" | "pending_materials" | "crafting_fuel" | "monitoring";

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
  status: FacilityStatus;
  buildFailures: number;
  materialTransport?: Record<string, MaterialTransportStatus>;
}

export interface FuelServiceState {
  version: number;
  facilities: Record<string, StationFacilityState>;
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
      return data;
    }
  } catch (err) {
    console.warn("Could not load fuelServiceState.json:", err);
  }
  return { version: 1, facilities: {} };
}

function saveState(data: FuelServiceState): void {
  ensureDataDir();
  writeFileSync(TRACKING_FILE, JSON.stringify(data, null, 2) + "\n", "utf-8");
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
  saveState({ version: 1, facilities: {} });
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