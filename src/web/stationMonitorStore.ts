import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const DATA_DIR = join(process.cwd(), "data");
const CONFIG_FILE = join(DATA_DIR, "stationMonitor.json");
const SNAPSHOT_FILE = join(DATA_DIR, "stationMonitorSnapshots.json");

export const MIN_POLL_INTERVAL_SEC = 15;

export interface StationRow {
  id: string;
  bot: string;
  stationId: string;
  stationName: string;
  label: string;
}

export interface StationConfig {
  version: number;
  pollIntervalSec: number;
  cardCols: number;
  rows: StationRow[];
}

export interface StationSnapshot {
  stationId: string;
  stationName: string;
  fetchedAt: number;
  base: Record<string, unknown>;
  condition: Record<string, unknown>;
  lifeSupport: Record<string, unknown>;
  power: Record<string, unknown>;
  factionFuelReserve: number;
  factionFuelCapacity: number;
  faction: string | null;
  wrecked: boolean;
}

export type StationSnapshots = Record<string, StationSnapshot>;

function genId(): string {
  let uuid: string;
  try {
    const g = globalThis as { crypto?: { randomUUID?: () => string } };
    uuid = g.crypto?.randomUUID?.() ?? "";
  } catch {
    uuid = "";
  }
  if (!uuid) {
    uuid =
      Date.now().toString(36) +
      Math.random().toString(36).slice(2, 10);
  }
  return `row_${uuid}`;
}

export function clampInterval(sec: number): number {
  if (typeof sec !== "number" || !isFinite(sec)) return 60;
  return Math.max(MIN_POLL_INTERVAL_SEC, Math.round(sec));
}

function normalizeRow(raw: Record<string, unknown> | StationRow): StationRow {
  const id = typeof raw.id === "string" && raw.id ? raw.id : genId();
  return {
    id,
    bot: typeof raw.bot === "string" ? raw.bot : "",
    stationId: typeof raw.stationId === "string" ? raw.stationId : "",
    stationName: typeof raw.stationName === "string" ? raw.stationName : "",
    label: typeof raw.label === "string" ? raw.label : "",
  };
}

export const MIN_CARD_COLS = 1;
export const MAX_CARD_COLS = 16;

export function clampCardCols(n: number): number {
  if (typeof n !== "number" || !isFinite(n)) return 5;
  return Math.max(MIN_CARD_COLS, Math.min(MAX_CARD_COLS, Math.round(n)));
}

export function defaultConfig(): StationConfig {
  return { version: 1, pollIntervalSec: 60, cardCols: 5, rows: [] };
}

export function loadStationConfig(): StationConfig {
  if (existsSync(CONFIG_FILE)) {
    try {
      const data = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as Record<string, unknown>;
      const rows = Array.isArray(data.rows)
        ? (data.rows as Record<string, unknown>[])
            .filter((r) => r && typeof r === "object")
            .map(normalizeRow)
        : [];
      return {
        version: 1,
        pollIntervalSec: clampInterval((data.pollIntervalSec as number) ?? 60),
        cardCols: clampCardCols((data.cardCols as number) ?? (data.cardMinPx as number) ?? 5),
        rows,
      };
    } catch (err) {
      console.warn("[StationServer] Warning: corrupt stationMonitor.json, starting fresh —", err);
    }
  }
  return defaultConfig();
}

export function saveStationConfig(config: StationConfig): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const clean: StationConfig = {
    version: 1,
    pollIntervalSec: clampInterval(config.pollIntervalSec),
    cardCols: clampCardCols(config.cardCols),
    rows: config.rows.map(normalizeRow),
  };
  writeFileSync(CONFIG_FILE, JSON.stringify(clean, null, 2) + "\n", "utf-8");
}

export function loadSnapshots(): StationSnapshots {
  if (existsSync(SNAPSHOT_FILE)) {
    try {
      const data = JSON.parse(readFileSync(SNAPSHOT_FILE, "utf-8")) as StationSnapshots;
      if (data && typeof data === "object") return data;
    } catch (err) {
      console.warn("[StationServer] Warning: corrupt stationMonitorSnapshots.json —", err);
    }
  }
  return {};
}

export function saveSnapshots(snapshots: StationSnapshots): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshots, null, 2) + "\n", "utf-8");
}
