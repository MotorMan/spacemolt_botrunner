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
  /** Animation frame-rate cap. -1 = off (static), 0 = uncapped, otherwise max FPS. */
  fpsCap: number;
}

/**
 * Fuel production status for a station, derived from the station bot's
 * `craft action=queue`. Any craft job that outputs `fuel_reserve` counts — that
 * item only ever lands in the station's fuel supply, so this catches every
 * current and future fuel recipe (manufacture_fuel_h2o2, extract_fuel_cell, …).
 */
export interface FuelCraftStatus {
  /** active = a job is running, queued = only pending jobs, none = nothing making fuel, unknown = queue unreadable. */
  state: "active" | "queued" | "none" | "unknown";
  activeJobs: number;
  queuedJobs: number;
  /** Runs still to complete across all fuel jobs. */
  runsRemaining: number;
  /** fuel_reserve units still to be produced across all fuel jobs. */
  unitsRemaining: number;
  /** ETA (ticks) of the running job, when reported. */
  etaTicks: number | null;
  /** Recipe name of the running (or first pending) fuel job. */
  recipe: string | null;
  checkedAt: number;
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
  /** Optional: absent in snapshots written before fuel tracking existed. */
  fuelCraft?: FuelCraftStatus | null;
  /** True when the station's docked drone reports an active battle involving this station. */
  combatAlert?: boolean;
  /** Battle id of the active (or most recent) combat alert. */
  battleId?: string | null;
}

export type StationSnapshots = Record<string, StationSnapshot>;

/**
 * Persistent, reviewable log of combat events per station row. Keyed by the
 * station row id (so each monitored station keeps its own history). Entries are
 * appended by the station server whenever the docked drone's battle detection
 * reports a battle that involves the station, and closed when the battle ends.
 */
export interface StationBattleLogEntry {
  battleId: string;
  startedAt: number;
  /** null while the battle is still in progress. */
  endedAt: number | null;
  /** active = in progress; ended = battle_ended/cleared; superseded = a newer battle replaced this one. */
  outcome: "active" | "ended" | "superseded";
  /** Free-text reason from the battle_ended notification, when available. */
  reason?: string;
  /** Raw participant display names seen during the battle (for later review). */
  participants: string[];
  /** True when one of the participants matched our station (by id/name). */
  stationInvolved: boolean;
}

export type StationBattleLog = Record<string, StationBattleLogEntry[]>;

const BATTLE_LOG_FILE = join(DATA_DIR, "stationBattles.json");

export function loadBattleLog(): StationBattleLog {
  if (existsSync(BATTLE_LOG_FILE)) {
    try {
      const data = JSON.parse(readFileSync(BATTLE_LOG_FILE, "utf-8")) as StationBattleLog;
      if (data && typeof data === "object") return data;
    } catch (err) {
      console.warn("[StationServer] Warning: corrupt stationBattles.json —", err);
    }
  }
  return {};
}

export function saveBattleLog(log: StationBattleLog): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(BATTLE_LOG_FILE, JSON.stringify(log, null, 2) + "\n", "utf-8");
}

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

/** Clamp the animation frame-rate cap: -1 = off, 0 = uncapped, 1..240 = capped FPS. */
export function clampFpsCap(n: number): number {
  if (n === -1) return -1;
  if (typeof n !== "number" || !isFinite(n) || n < 0) return 0;
  if (n === 0) return 0;
  return Math.max(1, Math.min(240, Math.round(n)));
}

export function defaultConfig(): StationConfig {
  return { version: 1, pollIntervalSec: 60, cardCols: 5, rows: [], fpsCap: 0 };
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
        fpsCap: clampFpsCap((data.fpsCap as number) ?? 0),
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
    fpsCap: clampFpsCap(config.fpsCap),
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
