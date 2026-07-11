import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const DATA_DIR = join(process.cwd(), "data");
const INSURANCE_FILE = join(DATA_DIR, "insurance.json");

export interface InsuranceRecord {
  shipId: string;
  shipName: string;
  botUsername: string;
  timestamp: number;
  cost: number;
  coverage: number;
  analysis?: Record<string, unknown>;
}

export interface InsuranceState {
  [botUsername: string]: {
    shipId: string;
    shipName: string;
    timestamp: number;
    cost: number;
    coverage: number;
    analysis?: Record<string, unknown>;
  };
}

function loadInsuranceState(): InsuranceState {
  if (existsSync(INSURANCE_FILE)) {
    try {
      const content = readFileSync(INSURANCE_FILE, "utf-8");
      return JSON.parse(content) as InsuranceState;
    } catch {
      return {};
    }
  }
  return {};
}

function saveInsuranceState(state: InsuranceState): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  writeFileSync(INSURANCE_FILE, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

export function recordInsurancePurchase(
  botUsername: string,
  shipId: string,
  shipName: string,
  cost: number,
  coverage: number,
  analysis?: Record<string, unknown>
): void {
  const state = loadInsuranceState();
  state[botUsername] = {
    shipId,
    shipName,
    timestamp: Date.now(),
    cost,
    coverage,
    analysis,
  };
  saveInsuranceState(state);
}

export function getInsuranceRecord(botUsername: string): InsuranceRecord | null {
  const state = loadInsuranceState();
  const record = state[botUsername];
  if (!record) return null;
  
  return {
    shipId: record.shipId,
    shipName: record.shipName,
    botUsername,
    timestamp: record.timestamp,
    cost: record.cost,
    coverage: record.coverage,
    analysis: record.analysis,
  };
}

export function getAllInsuranceRecords(): Record<string, InsuranceRecord> {
  const state = loadInsuranceState();
  const result: Record<string, InsuranceRecord> = {};
  
  for (const [botUsername, record] of Object.entries(state)) {
    result[botUsername] = {
      shipId: record.shipId,
      shipName: record.shipName,
      botUsername,
      timestamp: record.timestamp,
      cost: record.cost,
      coverage: record.coverage,
      analysis: record.analysis,
    };
  }
  
  return result;
}

export function clearInsuranceRecord(botUsername: string): void {
  const state = loadInsuranceState();
  delete state[botUsername];
  saveInsuranceState(state);
}

export function getInsuranceStatus(botUsername: string, currentShipId: string): {
  isInsured: boolean;
  timeRemaining: string;
  needsRepurchase: boolean;
} {
  const record = getInsuranceRecord(botUsername);
  if (!record) {
    return { isInsured: false, timeRemaining: "unknown", needsRepurchase: true };
  }
  
  const now = Date.now();
  const ageMs = now - record.timestamp;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  
  let timeRemaining: string;
  let needsRepurchase = false;
  
  if (record.coverage > 0) {
    const remainingDays = Math.max(0, record.coverage - ageDays);
    timeRemaining = `${remainingDays.toFixed(1)} days`;
    needsRepurchase = remainingDays < 1;
  } else {
    timeRemaining = "unknown (coverage not specified)";
    needsRepurchase = true;
  }
  
  const isInsured = record.shipId === currentShipId && !needsRepurchase;
  
  return { isInsured, timeRemaining, needsRepurchase };
}