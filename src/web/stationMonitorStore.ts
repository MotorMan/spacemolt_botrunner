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
  /**
   * Ammo units (per ammo type, held in the station's faction storage) at or
   * below which the station is flagged LOW (yellow). 0 rounds is always OUT
   * (red) regardless of this value, because a gun with no ammo cannot fire.
   */
  ammoLowThreshold: number;
  /**
   * Days of maintenance stock remaining at or below which the station is
   * flagged LOW (yellow). Facilities draw their maintenance inputs once per
   * 1000-tick cycle (~2.78h), so this is derived from stock ÷ per-cycle burn.
   */
  consumableLowDays: number;
  /**
   * Minutes a cached facility list / faction-storage read stays usable before
   * the sweep refreshes it. Supply data is read from the shared caches that the
   * rest of the botrunner already fills; this only bounds how stale the monitor
   * will let those caches get before it refreshes them itself.
   */
  supplyRefreshMin: number;
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

/**
 * Severity of a single supply line (or of a whole category).
 * `unknown` means we could not read the data — it must never colour a card, so
 * a cache miss or a failed read can't red-flag an otherwise healthy station.
 */
export type SupplyLevel = "ok" | "low" | "out" | "unknown";

/** One tracked consumable: either a facility maintenance input or gun ammo. */
export interface SupplyItem {
  itemId: string;
  name: string;
  kind: "maintenance" | "ammo";
  /**
   * maintenance: units drawn from faction storage per 1000-tick cycle.
   * ammo: number of active guns feeding from this ammo item (guns burn ammo per
   * shot, so there is no per-cycle rate to project a depletion time from).
   */
  need: number;
  /** Units held in THIS station's faction storage — the only place station facilities draw from. */
  have: number;
  /** maintenance: estimated days of stock left at the per-cycle burn. null for ammo. */
  daysLeft: number | null;
  level: SupplyLevel;
  /** Names of the active facilities that consume this item. */
  facilities: string[];
}

/**
 * Ammo + maintenance supply state for a station, derived from the station's
 * facility list and its faction storage. Guns stop firing when their ammo box
 * is empty and facilities stop running when their maintenance inputs run out,
 * so both are surfaced on the monitor card as yellow (low) / red (out).
 */
export interface SupplyStatus {
  /** Worst level across facility maintenance inputs. */
  maintenance: SupplyLevel;
  /** Worst level across gun ammo. "ok" when the station has no armed guns. */
  ammo: SupplyLevel;
  /** Number of active guns that need ammo. */
  guns: number;
  items: SupplyItem[];
  /** How `have` was obtained: refreshed this pass, from the shared cache, or nothing available. */
  source: "live" | "cache" | "none";
  /** When the faction storage backing `have` was read (ms), if known. */
  storageAt: number | null;
  /** When the facility list was read (ms), if known. */
  facilitiesAt: number | null;
  /** Why the state is unknown / partial, for the card tooltip. */
  note: string | null;
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
  /** Optional: absent in snapshots written before supply tracking existed. */
  supplies?: SupplyStatus | null;
  /** True when the station's docked drone reports an active battle involving this station. */
  combatAlert?: boolean;
  /** Battle id of the active (or most recent) combat alert. */
  battleId?: string | null;
}

export type StationSnapshots = Record<string, StationSnapshot>;

/**
 * Facility reduced to what supply evaluation needs. The caller resolves the
 * per-cycle maintenance draw (live record first, catalog second) and the gun's
 * ammo item from the facility catalog before handing it over.
 */
export interface SupplyFacility {
  name: string;
  active: boolean;
  maintenance: { item_id: string; quantity: number }[];
  /** Ammo item this facility's gun feeds from; null when it is not an armed gun. */
  ammoItem: string | null;
}

/** Stock available to the station, i.e. its faction storage. */
export interface SupplyStock {
  /** itemId -> units held. */
  stock: Map<string, number>;
  /** itemId -> display name, when the storage read supplied one. */
  names: Map<string, string>;
  /** When the read happened (ms), or null when we have nothing. */
  at: number | null;
  source: "live" | "cache" | "none";
}

export interface SupplyThresholds {
  /** Ammo rounds at or below which an ammo item is LOW. 0 disables the LOW tier. */
  ammoLowThreshold: number;
  /** Days of stock at or below which a maintenance item is LOW. 0 disables the LOW tier. */
  consumableLowDays: number;
}

/**
 * Facility maintenance inputs are withdrawn once per 1000-tick cycle (the
 * 100-tick check only decides whether a facility runs that tick), and one tick
 * is 10s of real time — so a full consumable cycle is 10000s ≈ 2.78h.
 */
export const SECS_PER_MAINT_CYCLE = 1000 * 10;
const SECS_PER_DAY = 86_400;

/**
 * Grade a station's ammo and maintenance stock against the configured
 * thresholds. Pure: no I/O, so this is the single place the yellow/red decision
 * is made for both the monitor cards and the station detail table.
 *
 * Anything we could not read grades as `unknown`, never as a problem — a cache
 * miss or a failed call must not red-flag a healthy station.
 */
export function evaluateSupplies(
  facilities: SupplyFacility[],
  facilitiesAt: number | null,
  stock: SupplyStock,
  thresholds: SupplyThresholds,
  itemNames: Record<string, string> = {},
): SupplyStatus {
  const checkedAt = Date.now();
  const nameOf = (id: string): string => stock.names.get(id) || itemNames[id] || id;

  const maintNeed = new Map<string, { need: number; facs: string[] }>();
  const ammoNeed = new Map<string, { guns: number; facs: string[] }>();
  let guns = 0;

  for (const f of facilities) {
    if (!f.active) continue;
    for (const m of f.maintenance) {
      if (!m.item_id) continue;
      const e = maintNeed.get(m.item_id) ?? { need: 0, facs: [] };
      e.need += m.quantity || 1;
      if (!e.facs.includes(f.name)) e.facs.push(f.name);
      maintNeed.set(m.item_id, e);
    }
    if (f.ammoItem) {
      guns++;
      const e = ammoNeed.get(f.ammoItem) ?? { guns: 0, facs: [] };
      e.guns++;
      if (!e.facs.includes(f.name)) e.facs.push(f.name);
      ammoNeed.set(f.ammoItem, e);
    }
  }

  const stockUnknown = stock.source === "none";
  const facsUnknown = facilitiesAt === null;
  const lowDays = thresholds.consumableLowDays;
  const lowAmmo = thresholds.ammoLowThreshold;
  const items: SupplyItem[] = [];

  for (const [itemId, e] of maintNeed) {
    const have = stock.stock.get(itemId) ?? 0;
    const daysLeft = e.need > 0 ? ((have / e.need) * SECS_PER_MAINT_CYCLE) / SECS_PER_DAY : null;
    let level: SupplyLevel;
    if (stockUnknown) level = "unknown";
    else if (have <= 0) level = "out";
    else if (lowDays > 0 && daysLeft !== null && daysLeft <= lowDays) level = "low";
    else level = "ok";
    items.push({
      itemId,
      name: nameOf(itemId),
      kind: "maintenance",
      need: e.need,
      have,
      daysLeft: daysLeft === null ? null : Math.round(daysLeft * 100) / 100,
      level,
      facilities: e.facs,
    });
  }

  for (const [itemId, e] of ammoNeed) {
    const have = stock.stock.get(itemId) ?? 0;
    let level: SupplyLevel;
    if (stockUnknown) level = "unknown";
    // An empty ammo box means the gun simply does not fire.
    else if (have <= 0) level = "out";
    else if (lowAmmo > 0 && have <= lowAmmo) level = "low";
    else level = "ok";
    items.push({
      itemId,
      name: nameOf(itemId),
      kind: "ammo",
      need: e.guns,
      have,
      daysLeft: null,
      level,
      facilities: e.facs,
    });
  }

  // Ammo first (a silent gun is the more urgent problem), then by item id.
  items.sort((a, b) =>
    a.kind === b.kind ? a.itemId.localeCompare(b.itemId) : a.kind === "ammo" ? -1 : 1,
  );

  // No line items for a category means nothing at this station consumes it,
  // which is "ok" — but with no facility list at all we genuinely don't know.
  const worst = (kind: SupplyItem["kind"]): SupplyLevel => {
    const levels = items.filter((i) => i.kind === kind).map((i) => i.level);
    if (!levels.length) return facsUnknown ? "unknown" : "ok";
    if (levels.includes("out")) return "out";
    if (levels.includes("low")) return "low";
    if (levels.includes("unknown")) return "unknown";
    return "ok";
  };

  let note: string | null = null;
  if (facsUnknown) {
    note = "Facility list unavailable — ammo/consumable state unknown.";
  } else if (stockUnknown) {
    note = "No faction storage reading for this station yet — stock unknown.";
  }

  return {
    maintenance: worst("maintenance"),
    ammo: worst("ammo"),
    guns,
    items,
    source: stock.source,
    storageAt: stock.at,
    facilitiesAt,
    note,
    checkedAt,
  };
}

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
  /** True when the docked drone's own ship was a participant. */
  droneInvolved?: boolean;
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

export const DEFAULT_AMMO_LOW = 100;
export const DEFAULT_CONSUMABLE_LOW_DAYS = 2;
export const DEFAULT_SUPPLY_REFRESH_MIN = 10;

/**
 * Ammo rounds at or below which a station is LOW. 0 disables the low warning
 * (only a truly empty ammo item then flags the station, as OUT).
 */
export function clampAmmoLow(n: number): number {
  if (typeof n !== "number" || !isFinite(n) || n < 0) return DEFAULT_AMMO_LOW;
  return Math.min(10_000_000, Math.round(n));
}

/**
 * Days of maintenance stock at or below which a station is LOW. Kept to one
 * decimal so sub-day thresholds (e.g. 0.5 = 12h) are expressible. 0 disables
 * the low warning; a depleted item still flags the station as OUT.
 */
export function clampConsumableDays(n: number): number {
  if (typeof n !== "number" || !isFinite(n) || n < 0) return DEFAULT_CONSUMABLE_LOW_DAYS;
  return Math.min(3650, Math.round(n * 10) / 10);
}

/** Minutes before the monitor refreshes a stale facility / faction-storage cache itself. */
export function clampSupplyRefreshMin(n: number): number {
  if (typeof n !== "number" || !isFinite(n) || n <= 0) return DEFAULT_SUPPLY_REFRESH_MIN;
  return Math.max(1, Math.min(1440, Math.round(n)));
}

export function defaultConfig(): StationConfig {
  return {
    version: 1,
    pollIntervalSec: 60,
    cardCols: 5,
    rows: [],
    fpsCap: 0,
    ammoLowThreshold: DEFAULT_AMMO_LOW,
    consumableLowDays: DEFAULT_CONSUMABLE_LOW_DAYS,
    supplyRefreshMin: DEFAULT_SUPPLY_REFRESH_MIN,
  };
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
        ammoLowThreshold: clampAmmoLow((data.ammoLowThreshold as number) ?? DEFAULT_AMMO_LOW),
        consumableLowDays: clampConsumableDays(
          (data.consumableLowDays as number) ?? DEFAULT_CONSUMABLE_LOW_DAYS,
        ),
        supplyRefreshMin: clampSupplyRefreshMin(
          (data.supplyRefreshMin as number) ?? DEFAULT_SUPPLY_REFRESH_MIN,
        ),
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
    ammoLowThreshold: clampAmmoLow(config.ammoLowThreshold),
    consumableLowDays: clampConsumableDays(config.consumableLowDays),
    supplyRefreshMin: clampSupplyRefreshMin(config.supplyRefreshMin),
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
