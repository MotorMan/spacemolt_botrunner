import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, writeFile } from "fs";
import { join } from "path";
import os from "os";
import type { BotStatus } from "../bot.js";
import { getBot, getTotalBandwidth, getDiscoveredBots } from "../botmanager.js";
import { chatBuffer, type ChatMessage } from "../chatbuffer.js";
import { mapStore } from "../mapstore.js";
import { catalogStore } from "../catalogstore.js";
import { botChatChannel } from "../bot_chat_channel.js";
import type { ServerWebSocket } from "bun";
import { getFacilityTransferLoadouts, saveFacilityTransferLoadout, deleteFacilityTransferLoadout, getStationCompletions, setLoadoutActive, clearLoadoutCompletions, clearAllCompletions } from "../routines/fuelTransferTracking.js";
import { playerNameStore } from "../playernamestore.js";
import { wildlifeStore, type WildlifeFullData } from "../wildlivestore.js";
import { ClientSyncMaster, type RegisteredClient, type PoiPayload, type MarketPayload, type CoordinationPayload, type PlayerNamePayload, type PassengerPayload, type BotStatusPush, type HelloResponse } from "../client_sync_master.js";
import { listSyncedFiles, readSyncedFile, mergeIntoFile, seedIntoFile, isPathSynced, type FileEntry } from "../client_sync_files.js";
import { configureSync, onPlayerNameUpdate, onCoordinationUpdate, onCivilianTransportUpdate, onRescueUpdate } from "../client_sync_hooks.js";
import { getAllInsuranceRecords, getInsuranceRecord } from "../insuranceTracker.js";
import { getCargoMoverItemStatuses } from "../routines/cargoMoverActivity.js";
import { reconcileDeliveredWithDestination, getCargoMoverSettings } from "../routines/cargo_mover.js";
import { resetInTransitData } from "../routines/cargoMoverInTransit.js";
import { resetCoordinationTracking } from "../routines/cargoMoverCoordination.js";
import { setEnabled as setPerfEnabled } from "../perf.js";

function getLocalIp(): string | null {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const addrs = interfaces[name];
    if (!addrs) continue;
    for (const iface of addrs) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

// ── Types ──────────────────────────────────────────────────

export interface WebAction {
  type: "start" | "stop" | "stop_after_cycle" | "chat" | "saveSettings" | "exec" | "remove" | "shutdown" | "emergencyReturn" | "manual_rescue_request" | "pathfinder_calc" | "setClerkKey" | "listClerkPlayers" | "addClerkBots" | "setPerformanceMonitoring" | "bulkSetHunterMode";
  bot?: string;
  routine?: string;
  username?: string;
  password?: string;
  empire?: string;
  message?: string;
  channel?: string;
  registration_code?: string;
  settings?: Record<string, unknown>;
  command?: string;
  params?: Record<string, unknown>;
  /** Toggled value for the `setPerformanceMonitoring` action (live, no full save). */
  enabled?: boolean;
  /** Clerk API key supplied from Settings → General (replaces env SPACEMOLT_CLERK_API_KEY). */
  clerkApiKey?: string;
  /** Optional second Clerk API key, for adding bots owned by a different Clerk account. */
  clerkApiKey2?: string;
  /** Player ids selected to add as bots. */
  ids?: string[];
  /**
   * Clerk player selection state to persist alongside a General-settings save.
   * `displayed` is the set of player ids currently shown in the Add-Bots list;
   * `checked` is the subset the user left ticked. Any id in `displayed` that is
   * NOT in `checked` is removed from the persisted `clerk.bots` list (so
   * unchecking a bot and saving really removes it), while ids not in
   * `displayed` are left untouched (so bots added from an account the user
   * hasn't listed aren't accidentally wiped).
   */
  clerkSelection?: { checked?: string[]; displayed?: string[] };
}

export interface WebActionResult {
  ok: boolean;
  message?: string;
  error?: string;
  password?: string;
  settings?: Record<string, Record<string, unknown>>;
  data?: unknown;
}

export interface RoutineSettings {
  [routine: string]: Record<string, unknown>;
}

type WSData = { id: number };

// ── Settings persistence ───────────────────────────────────

const DATA_DIR = join(process.cwd(), "data");
const SETTINGS_FILE = join(DATA_DIR, "settings.json");
const STATS_FILE = join(DATA_DIR, "stats.json");
const MAIN_LOG_FILE = join(DATA_DIR, "main_logs.json");
const TAXES_FILE = join(DATA_DIR, "taxes.json");
const FLOCK_FILE = join(DATA_DIR, "flock.json");
const LAST_USED_ROUTINE_FILE = join(DATA_DIR, "lastUsedRoutine.json");
const ACTIVE_BOTS_FILE = join(DATA_DIR, "activeBots.json");

interface MainLogs {
  activity: string[];
  broadcast: string[];
  system: string[];
  faction: string[];
}

function loadMainLogs(): MainLogs {
  if (existsSync(MAIN_LOG_FILE)) {
    try {
      return JSON.parse(readFileSync(MAIN_LOG_FILE, "utf-8")) as MainLogs;
    } catch (err) {
      console.warn(`Warning: corrupt main_logs.json, starting fresh —`, err);
    }
  }
  return { activity: [], broadcast: [], system: [], faction: [] };
}

function saveMainLogs(logs: MainLogs): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(MAIN_LOG_FILE, JSON.stringify(logs, null, 2) + "\n", "utf-8");
}

function loadSettings(): RoutineSettings {
  if (existsSync(SETTINGS_FILE)) {
    try {
      return JSON.parse(readFileSync(SETTINGS_FILE, "utf-8")) as RoutineSettings;
    } catch (err) {
      console.warn(`Warning: corrupt settings.json, starting fresh —`, err);
    }
  }
  return {};
}

export { loadSettings, saveSettings };

// The WebServer keeps an in-memory copy of settings (`this.settings`) that most
// save paths write back to disk wholesale via `saveSettings(this.settings)`.
// `setClerkConfig` writes `clerk.bots` to disk directly, so we must keep this
// in-memory copy pointed at the same object and keep its `clerk` section in
// sync — otherwise the next routine/settings save silently clobbers the
// selected-bot list (added bots vanish on restart). `activeSettings` tracks the
// live in-memory object even when `this.settings` is reassigned on reload.
let activeSettings: RoutineSettings | null = null;

// ── Clerk (headless client) config persistence ─────────────
// Stored separately from `general` so the per-routine settings save (which
// replaces the whole `general` object) can't clobber the selected-bot list.

export interface ClerkConfig {
  /** Primary Clerk API key — headless-client credential that owns the player accounts. */
  apiKey: string;
  /** Optional second Clerk API key — lets you add bots owned by a different Clerk account. */
  apiKey2: string;
  /** Player ids the user has chosen to run as bots (a Clerk account can own hundreds). */
  bots: string[];
}

export function getClerkConfig(): ClerkConfig {
  const s = loadSettings();
  const c = (s.clerk as Record<string, unknown>) || {};
  return {
    apiKey: typeof c.apiKey === "string" ? c.apiKey : "",
    apiKey2: typeof c.apiKey2 === "string" ? c.apiKey2 : "",
    bots: Array.isArray(c.bots) ? (c.bots as string[]) : [],
  };
}

/**
 * Resolve every configured Clerk API key: env vars take precedence (kept for
 * the CLI / headless deployments), then the dashboard-supplied keys in
 * settings. Returns a de-duplicated, order-preserving list (env first).
 */
export function getClerkApiKeys(): string[] {
  const keys: string[] = [];
  if (process.env.SPACEMOLT_CLERK_API_KEY) keys.push(process.env.SPACEMOLT_CLERK_API_KEY);
  if (process.env.SPACEMOLT_CLERK_API_KEY_2) keys.push(process.env.SPACEMOLT_CLERK_API_KEY_2);
  const cfg = getClerkConfig();
  if (cfg.apiKey) keys.push(cfg.apiKey);
  if (cfg.apiKey2) keys.push(cfg.apiKey2);
  return [...new Set(keys)];
}

/**
 * Resolve the primary Clerk API key (env var takes precedence, kept for the
 * CLI / headless deployments, then the dashboard-supplied keys). Backward
 * compatible with callers that expect a single key.
 */
export function getClerkApiKey(): string | undefined {
  const keys = getClerkApiKeys();
  return keys[0] || undefined;
}

/** Merge a partial Clerk config into settings and persist it. */
export function setClerkConfig(partial: Partial<ClerkConfig>): ClerkConfig {
  const s = loadSettings();
  const c = (s.clerk as Record<string, unknown>) || {};
  if (typeof partial.apiKey === "string") c.apiKey = partial.apiKey;
  if (typeof partial.apiKey2 === "string") c.apiKey2 = partial.apiKey2;
  if (Array.isArray(partial.bots)) c.bots = partial.bots;
  s.clerk = c;
  // Keep the in-memory settings copy (used by every other save path) in sync so
  // a later `saveSettings(this.settings)` doesn't overwrite clerk.bots with a
  // stale version and drop freshly-added/removed bots.
  if (activeSettings) activeSettings.clerk = c;
  saveSettings(s);
  return c as unknown as ClerkConfig;
}

export interface LastUsedRoutineData {
  [botUsername: string]: string;
}

function loadLastUsedRoutines(): LastUsedRoutineData {
  if (existsSync(LAST_USED_ROUTINE_FILE)) {
    try {
      return JSON.parse(readFileSync(LAST_USED_ROUTINE_FILE, "utf-8")) as LastUsedRoutineData;
    } catch (err) {
      console.warn(`Warning: corrupt lastUsedRoutine.json, starting fresh —`, err);
    }
  }
  return {};
}

function saveLastUsedRoutine(botUsername: string, routine: string): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const data = loadLastUsedRoutines();
  data[botUsername] = routine;
  writeFileSync(LAST_USED_ROUTINE_FILE, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function getLastUsedRoutine(botUsername: string): string | null {
  const data = loadLastUsedRoutines();
  return data[botUsername] || null;
}

function getAllLastUsedRoutines(): LastUsedRoutineData {
  return loadLastUsedRoutines();
}

export { loadLastUsedRoutines, saveLastUsedRoutine, getLastUsedRoutine, getAllLastUsedRoutines };

// ── Active bots snapshot (survives client restarts) ──────────
// The dashboard's bot list is driven by `latestStatuses`, which is empty until
// the library reconnects the selected bots. That made the fleet "pop in" one
// card at a time after every restart (and the window resize with each). We
// persist a snapshot of the last-known statuses to disk and rehydrate
// `latestStatuses` from it at startup, so the last-active bots appear
// immediately — flagged `offline` (Reconnecting…) until a live status arrives.
// Only bots that are still in the selected-bot list (`clerk.bots`) are seeded,
// so a bot that was removed never lingers as a ghost card.

interface ActiveBotsFile {
  bots: BotStatus[];
}

function loadActiveBots(): BotStatus[] {
  if (!existsSync(ACTIVE_BOTS_FILE)) return [];
  try {
    const data = JSON.parse(readFileSync(ACTIVE_BOTS_FILE, "utf-8")) as ActiveBotsFile;
    const list = Array.isArray(data.bots) ? data.bots : [];
    const selected = new Set(getClerkConfig().bots);
    // Keep only bots we still intend to reconnect, and flag them offline.
    const seeded = list
      .filter((b) => b && typeof b.username === "string" && selected.has(b.username))
      .map((b) => ({ ...b, offline: true }));
    return seeded;
  } catch (err) {
    console.warn(`Warning: corrupt activeBots.json, starting fresh —`, err);
    return [];
  }
}

let activeBotsSaveTimer: ReturnType<typeof setTimeout> | null = null;
let activeBotsDirty = false;
let latestActiveStatuses: BotStatus[] = [];

// Snapshot is only used to rehydrate the dashboard on restart, so a long
// debounce is fine and greatly reduces SSD wear (was 5s).
const ACTIVE_BOTS_SAVE_DEBOUNCE_MS = 120_000;

function scheduleActiveBotsSave(statuses: BotStatus[]): void {
  // Persist a clean (non-offline) snapshot of the live fleet so the next
  // restart rehydrates from real last-known data rather than stale ghosts.
  latestActiveStatuses = statuses;
  activeBotsDirty = true;
  if (activeBotsSaveTimer) return;
  activeBotsSaveTimer = setTimeout(() => {
    activeBotsSaveTimer = null;
    if (!activeBotsDirty) return;
    activeBotsDirty = false;
    try {
      if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
      const clean = latestActiveStatuses.map(({ offline, ...rest }) => rest);
      writeFileSync(ACTIVE_BOTS_FILE, JSON.stringify({ bots: clean } as ActiveBotsFile, null, 2) + "\n", "utf-8");
    } catch (err) {
      console.warn(`Warning: failed to save activeBots.json —`, err);
    }
  }, ACTIVE_BOTS_SAVE_DEBOUNCE_MS);
}

/** Write any pending activeBots snapshot to disk immediately (call on shutdown). */
function flushActiveBotsSave(): void {
  if (activeBotsSaveTimer) {
    clearTimeout(activeBotsSaveTimer);
    activeBotsSaveTimer = null;
  }
  if (!activeBotsDirty) return;
  activeBotsDirty = false;
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    const clean = latestActiveStatuses.map(({ offline, ...rest }) => rest);
    writeFileSync(ACTIVE_BOTS_FILE, JSON.stringify({ bots: clean } as ActiveBotsFile, null, 2) + "\n", "utf-8");
  } catch (err) {
    console.warn(`Warning: failed to flush activeBots.json —`, err);
  }
}

const STOPPED_STATE_FILE = join(DATA_DIR, "stoppedState.json");

export interface StoppedStateData {
  [botUsername: string]: "user" | "emergency" | true;
}

function loadStoppedState(): StoppedStateData {
  if (existsSync(STOPPED_STATE_FILE)) {
    try {
      return JSON.parse(readFileSync(STOPPED_STATE_FILE, "utf-8")) as StoppedStateData;
    } catch (err) {
      console.warn(`Warning: corrupt stoppedState.json, starting fresh —`, err);
    }
  }
  return {};
}

export function saveStoppedState(botUsername: string, reason: "user" | "emergency" | true): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const data = loadStoppedState();
  data[botUsername] = reason;
  writeFileSync(STOPPED_STATE_FILE, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

export function getStoppedState(botUsername: string): "user" | "emergency" | true | null {
  const data = loadStoppedState();
  return data[botUsername] || null;
}

export function clearStoppedState(botUsername: string): void {
  const data = loadStoppedState();
  if (data[botUsername] !== undefined) {
    delete data[botUsername];
    writeFileSync(STOPPED_STATE_FILE, JSON.stringify(data, null, 2) + "\n", "utf-8");
  }
}

/** Get the global system blacklist from settings. */
export function getSystemBlacklist(): string[] {
  const settings = loadSettings();
  // Support multiple storage formats for backward compatibility
  const raw = (settings.system_blacklist as any) 
           || (settings.systemBlacklist as any) 
           || [];
  // Handle both direct array storage and nested object storage
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object' && Array.isArray(raw.system_blacklist)) {
    return raw.system_blacklist;
  }
  if (raw && typeof raw === 'object' && Array.isArray(raw.systemBlacklist)) {
    return raw.systemBlacklist;
  }
  return [];
}

function saveSettings(s: RoutineSettings): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const { writeFileSync } = require("fs");
  writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2) + "\n", "utf-8");
}

// ── Flock settings persistence (separate file) ──────────────

interface FlockSettingsData {
  flockGroups: Record<string, unknown>[];
  assignments: Record<string, Record<string, unknown>>;
}

function loadFlockSettings(): FlockSettingsData {
  if (existsSync(FLOCK_FILE)) {
    try {
      return JSON.parse(readFileSync(FLOCK_FILE, "utf-8")) as FlockSettingsData;
    } catch (err) {
      console.warn(`Warning: corrupt flock.json, starting fresh —`, err);
    }
  }
  return { flockGroups: [], assignments: {} };
}

function saveFlockSettings(data: FlockSettingsData): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(FLOCK_FILE, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

// ── Stats persistence ─────────────────────────────────────

interface DayStats {
  mined: number;
  crafted: number;
  trades: number;
  profit: number;
  systems: number;
}

interface StatsFile {
  daily: Record<string, Record<string, DayStats>>;   // bot -> date -> stats
  lastSeen: Record<string, DayStats>;                 // bot -> snapshot
}

function loadStats(): StatsFile {
  if (existsSync(STATS_FILE)) {
    try {
      return JSON.parse(readFileSync(STATS_FILE, "utf-8")) as StatsFile;
    } catch (err) {
      console.warn(`Warning: corrupt stats.json, starting fresh —`, err);
    }
  }
  return { daily: {}, lastSeen: {} };
}

function saveStats(s: StatsFile): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFile(STATS_FILE, JSON.stringify(s, null, 2) + "\n", "utf-8", (err) => {
    if (err) console.warn(`Warning: failed to save stats.json —`, err);
  });
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function pruneOldDates(daily: Record<string, Record<string, DayStats>>, maxAgeDays = 30): void {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - maxAgeDays);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  for (const bot of Object.keys(daily)) {
    for (const date of Object.keys(daily[bot])) {
      if (date < cutoffStr) delete daily[bot][date];
    }
    if (Object.keys(daily[bot]).length === 0) delete daily[bot];
  }
}

// ── WebServer ──────────────────────────────────────────────

const MAX_LOG_BUFFER = 200;
const MAIN_LOG_SAVE_DEBOUNCE_MS = 5000;

export class WebServer {
  private port: number;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private clients = new Set<ServerWebSocket<WSData>>();
  private nextClientId = 1;

  // Cached serialized payloads so we don't re-stringify the ~1.1MB map on
  // every connection (reconnect storms / multiple tabs would otherwise
  // multiply the cost and stall the single-threaded event loop).
  private mapDataCache: string | null = null;
  private catalogCache: string | null = null;
  private statsCache: string | null = null;

  // Log buffers for scrollback on reconnect (persisted to disk)
  private activityLog: string[];
  private broadcastLog: string[];
  private systemLog: string[];
  private factionLog: string[];
  private mainLogsDirty = false;
  private mainLogSaveTimer: ReturnType<typeof setTimeout> | null = null;

  // Per-bot activity log buffers (username -> lines)
  private botLogs = new Map<string, string[]>();

  // Latest bot statuses for initial page load
  private latestStatuses: BotStatus[] = [];

  // Bots rehydrated from the persisted snapshot at startup (offline /
  // "Reconnecting…"). Kept separate so live statuses can replace them
  // one-by-one as each bot reconnects, instead of the whole list being wiped
  // by a `refreshStatusTable` tick while the fleet is still connecting.
  private seededOffline = new Map<string, BotStatus>();

  // Persisted routine settings
  settings: RoutineSettings;

  // Persisted stats
  private statsData: StatsFile;

  // Action callback — set by botmanager
  onAction: ((action: WebAction) => Promise<WebActionResult>) | null = null;

  // Shutdown callback — set by botmanager. `restart` is true when the user
  // asked to restart the client (re-pull updates) rather than fully shut down.
  onShutdown: ((restart?: boolean) => Promise<void>) | null = null;

  // Empire official alert callback — set by botmanager
  onEmpireAlert: ((sender: string, content: string) => void) | null = null;

  // Available routines — set by botmanager
  routines: string[] = [];

  // Client sync state
  private syncMaster: ClientSyncMaster | null = null;

  // Bandwidth tracking
  private wsBytesByType = new Map<string, number>();
  private wsTotalBytes = 0;
  private wsBytesTimer: ReturnType<typeof setInterval> | null = null;

constructor(port: number = 3000) {
    this.port = port;
    this.settings = loadSettings();
    activeSettings = this.settings;
    delete (this.settings as Record<string, unknown>).flock;
    if (!this.settings.module_seller) {
      this.settings.module_seller = {
        homeSystem: "",
        homeStation: "",
        fuelCostPerJump: 50,
        refuelThreshold: 50,
        repairThreshold: 40,
        priceMode: "premium",
        premiumPct: 5,
        undercutCr: 100,
        sellAtHome: true,
        maxQtyDefault: 10,
        moduleItems: [],
      };
      saveSettings(this.settings);
    }
if (!this.settings.fuel_service) {
       this.settings.fuel_service = {
         stations: [],
         facilityConfigs: [],
         refuelThreshold: 35,
         repairThreshold: 40,
         autoCloak: false,
         serviceAllEmpires: false,
         refreshIntervalSec: 300,
       };
       saveSettings(this.settings);
     }
    if (!this.settings.clientSync) {
      this.settings.clientSync = {
        enabled: false,
        mode: "slave",
        masterUrl: "http://192.168.1.100:3000",
        apiKey: "",
        password: "",
        label: "",
        pollIntervalSec: 15,
        syncMap: true,
        syncMarket: true,
        syncCatalog: true,
        syncStats: true,
        syncBotChat: true,
        syncPlayerNames: true,
        syncCoordination: true,
        syncCivilianTransport: true,
        syncRescue: true,
        syncWildlife: true,
        allowRemoteBotsInDropdowns: true,
        remoteBotNameStyle: "prefix",
        pushLocalDiscoveries: true,
        selfUrl: "",
        disabledSyncFiles: [],
      };
      saveSettings(this.settings);
    }
    if (this.settings.clientSync.mode === "master" && !this.settings.clientSync.apiKey) {
      const generatedKey = `master_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      this.settings.clientSync.apiKey = generatedKey;
      saveSettings(this.settings);
    }
    // When this node is the client-sync MASTER, bring the master up eagerly at
    // startup (not just on the first inbound /api/client-sync request). This
    // publishes it on globalThis so botmanager.getCombinedFleetStatus — which
    // the rescue routine uses for its cross-client fleet poll — can find it
    // immediately, and it lets slaves register before the rescue bot runs its
    // first scan. Without this, a rescue bot on the master node never saw the
    // connected slaves' pushed bot statuses.
    if (this.settings.clientSync.mode === "master") {
      if (!this.syncMaster) {
        this.syncMaster = new ClientSyncMaster(this.settings.clientSync);
        (globalThis as unknown as { syncMaster: ClientSyncMaster }).syncMaster = this.syncMaster;
        this.syncMaster.saveSettings();
      }
      this.syncMaster.startFileSync((this.settings.clientSync.pollIntervalSec as number) || 15);
    }
    // Initialize periodic refresh setting in general
    if (!this.settings.general || typeof this.settings.general !== "object") {
      this.settings.general = {};
    }
    if ((this.settings.general as Record<string, unknown>).periodicRefreshSec === undefined) {
      (this.settings.general as Record<string, unknown>).periodicRefreshSec = 30;
      saveSettings(this.settings);
    }
    this.statsData = loadStats();
    const mainLogs = loadMainLogs();
    this.activityLog = mainLogs.activity.slice(-MAX_LOG_BUFFER);
    this.broadcastLog = mainLogs.broadcast.slice(-MAX_LOG_BUFFER);
    this.systemLog = mainLogs.system.slice(-MAX_LOG_BUFFER);
    this.factionLog = mainLogs.faction.slice(-MAX_LOG_BUFFER);
    // Rehydrate the last-active bot list so the dashboard shows the fleet
    // immediately on restart instead of starting blank and popping in cards.
    const seeded = loadActiveBots();
    this.seededOffline = new Map(seeded.map((b) => [b.username, b]));
    this.latestStatuses = seeded;
    this.applyInitialLogSettings();

    this.wsBytesTimer = setInterval(() => this.logWsBytesSummary(), 10000);
  }

  private trackWsBytes(data: unknown): void {
    const raw = JSON.stringify(data);
    const len = Buffer.byteLength(raw, "utf8");
    this.wsTotalBytes += len;
    const type = (data as Record<string, unknown>)?.type;
    if (typeof type === "string" && type) {
      this.wsBytesByType.set(type, (this.wsBytesByType.get(type) || 0) + len);
    }
  }

  private trackWsBytesRaw(jsonStr: string, fallbackType: string): void {
    const len = Buffer.byteLength(jsonStr, "utf8");
    this.wsTotalBytes += len;
    this.wsBytesByType.set(fallbackType, (this.wsBytesByType.get(fallbackType) || 0) + len);
  }

  private logWsBytesSummary(): void {
    if (this.wsTotalBytes === 0) return;
    const lines: string[] = [
      `[WS_BW] 10s summary: ${(this.wsTotalBytes / 1024 / 1024).toFixed(2)} MB total`,
    ];
    const sorted = [...this.wsBytesByType.entries()].sort((a, b) => b[1] - a[1]);
    for (const [type, bytes] of sorted) {
      lines.push(`  ${type}: ${(bytes / 1024 / 1024).toFixed(2)} MB`);
    }
    console.log(lines.join("\n"));
    this.wsTotalBytes = 0;
    this.wsBytesByType.clear();
  }

  applyInitialLogSettings(): void {
    const { setDebugLog, setActivityLog } = require("../debug.js");
    if ((this.settings.general as Record<string, unknown>)?.disableDebugLog === true) {
      setDebugLog(false);
    }
    if ((this.settings.general as Record<string, unknown>)?.disableActivityLog === true) {
      setActivityLog(false);
    }
  }

  /** Schedule save of main logs to disk (debounced). */
  private scheduleMainLogSave(): void {
    if (this.mainLogSaveTimer) return;
    this.mainLogsDirty = true;
    this.mainLogSaveTimer = setTimeout(() => {
      if (this.mainLogsDirty) {
        saveMainLogs({
          activity: this.activityLog,
          broadcast: this.broadcastLog,
          system: this.systemLog,
          faction: this.factionLog,
        });
        this.mainLogsDirty = false;
        this.mainLogSaveTimer = null;
      }
    }, MAIN_LOG_SAVE_DEBOUNCE_MS);
  }

  getSettings(routine: string): Record<string, unknown> {
    return this.settings[routine] || {};
  }

  saveRoutineSettings(routine: string, s: Record<string, unknown>): void {
    this.settings[routine] = s;
    saveSettings(this.settings);
    this.applySettingsChanges(routine, s);
  }

  applySettingsChanges(routine: string, s: Record<string, unknown>): void {
    if (routine === "general") {
      const { setDebugLog, setActivityLog } = require("../debug.js");
      if (s.disableDebugLog !== undefined) {
        setDebugLog(!s.disableDebugLog);
      }
      if (s.disableActivityLog !== undefined) {
        setActivityLog(!s.disableActivityLog);
      }
      // Performance monitoring is default-OFF; only enable when explicitly true.
      if (s.performanceMonitoring !== undefined) {
        setPerfEnabled(!!s.performanceMonitoring);
      }
    }
  }

  /** Reload settings from disk and broadcast to all connected clients.
   *  Called periodically to catch external writes (e.g., from bot routines). */
  reloadSettingsFromDisk(): void {
    const diskSettings = loadSettings();
    delete (diskSettings as Record<string, unknown>).flock;
    const diskJson = JSON.stringify(diskSettings);
    const memJson = JSON.stringify(this.settings);
    if (diskJson !== memJson) {
      this.settings = diskSettings;
      activeSettings = this.settings;
      for (const ws of this.clients) {
        try {
          ws.send(JSON.stringify({
            type: "settings_updated",
            settings: this.settings,
          }));
        } catch { /* ignore dead connections */ }
      }
    }
  }

  // ── Bot assignment persistence (auto-resume on restart) ───

  saveBotAssignment(username: string, routine: string): void {
    if (!this.settings.botAssignments) {
      this.settings.botAssignments = {};
    }
    (this.settings.botAssignments as Record<string, string>)[username] = routine;
    saveSettings(this.settings);
  }

  clearBotAssignment(username: string): void {
    const assignments = this.settings.botAssignments as Record<string, string> | undefined;
    if (assignments && username in assignments) {
      delete assignments[username];
      saveSettings(this.settings);
    }
  }

  getBotAssignments(): Record<string, string> {
    return (this.settings.botAssignments as Record<string, string>) || {};
  }

  removePerBotSettings(username: string): void {
    if (username in this.settings) {
      delete this.settings[username];
      saveSettings(this.settings);
    }
  }

  start(): void {
    const indexPath = join(import.meta.dir, "index.html");

    this.server = Bun.serve<WSData>({
      hostname: "0.0.0.0",
      port: this.port,
      fetch: async (req, server) => {
        const url = new URL(req.url);

        // WebSocket upgrade
        if (url.pathname === "/ws") {
          const id = this.nextClientId++;
          console.log(`WebSocket upgrade attempt from ${req.headers.get('user-agent') || 'unknown'} (id: ${id})`);
          const ok = server.upgrade(req, { data: { id } });
          if (ok) {
            console.log(`WebSocket upgrade successful (id: ${id})`);
            return undefined as unknown as Response;
          }
          console.log(`WebSocket upgrade failed (id: ${id})`);
          return new Response("WebSocket upgrade failed", { status: 400 });
        }

        // REST API
        if (url.pathname === "/api/bots") {
          return Response.json(this.latestStatuses);
        }
        if (url.pathname === "/api/bots/discovered") {
          // Return list of discovered bot usernames (even if not logged in)
          const discovered = getDiscoveredBots();
          return Response.json({ usernames: discovered });
        }
        if (url.pathname === "/api/chat-bots") {
          // Return bot list in format expected by chat UI
          const discovered = getDiscoveredBots();
          return Response.json({ bots: discovered });
        }
        if (url.pathname === "/api/channels" && req.method === "GET") {
          const bot = url.searchParams.get("bot") || undefined;
          let channels = bot ? chatBuffer.getChannels(bot) : chatBuffer.getChannels();
          const defaultChannels = [{ name: "local", displayName: "Local" }, { name: "faction", displayName: "Faction" }, { name: "system", displayName: "System" }, { name: "private", displayName: "Private" }];
          if (channels.length === 0) {
            channels = defaultChannels;
          } else {
            for (const dc of defaultChannels) {
              if (!channels.some(c => c.name === dc.name)) {
                channels.push(dc);
              }
            }
          }
          return Response.json({ channels }, { headers: { "Access-Control-Allow-Origin": "*" } });
        }
        if (url.pathname === "/api/messages" && req.method === "GET") {
          const bot = url.searchParams.get("bot") || undefined;
          const channel = url.searchParams.get("channel") || undefined;
          const limit = parseInt(url.searchParams.get("limit") || "500", 10);
          const after = url.searchParams.get("after");
          const messages = chatBuffer.getMessages({ bot, channel, limit, after: after ? parseInt(after, 10) : undefined });
          return Response.json({ messages, count: chatBuffer.getMessageCount({ bot, channel }) }, { headers: { "Access-Control-Allow-Origin": "*" } });
        }
        if (url.pathname === "/api/send" && req.method === "POST") {
          const body = (await req.json()) as { bot: string; channel: string; content: string; targetId?: string };
          const { bot, channel, content, targetId } = body;
          const corsHeader = { "Access-Control-Allow-Origin": "*" };

          if (!bot || !channel || !content) {
            return Response.json({ error: "Missing bot, channel, or content" }, { status: 400, headers: corsHeader });
          }

          const botInstance = getBot(bot);
          if (!botInstance) {
            return Response.json({ error: `Bot ${bot} not found` }, { status: 404, headers: corsHeader });
          }

          try {
            const chatBody: Record<string, unknown> = { channel, content };
            if (channel === "private") {
              if (!targetId) {
                return Response.json({ error: "targetId is required for private messages" }, { status: 400, headers: corsHeader });
              }
              chatBody.target_id = targetId;
            }

            const result = await botInstance.exec("chat", chatBody);

            if (result.error) {
              return Response.json({ error: result.error.message || "Chat failed" }, { status: 500, headers: corsHeader });
            }

            const sentMsg: ChatMessage = {
              botUsername: bot,
              channel,
              sender: bot,
              content,
              timestamp: Date.now(),
              direction: "out",
              ...(targetId ? { targetId } : {}),
            };
            chatBuffer.addMessage(sentMsg);

            return Response.json({ ok: true, message: "Message sent" }, { headers: corsHeader });
          } catch (err) {
            return Response.json(
              { error: err instanceof Error ? err.message : String(err) },
              { status: 500, headers: corsHeader }
            );
          }
        }
        if (url.pathname === "/api/bandwidth") {
          const bandwidth = getTotalBandwidth();
          return Response.json(bandwidth);
        }
        if (url.pathname === "/api/map") {
          return Response.json({ systems: mapStore.getAllSystems() });
        }
        if (url.pathname === "/api/cargo_mover/status") {
          return Response.json({ items: getCargoMoverItemStatuses() });
        }
        if (url.pathname === "/api/cargo_mover/reconcile" && req.method === "POST") {
          try {
            const body = await req.json() as { bot?: string };
            if (!body.bot) {
              return Response.json({ error: "bot name required" }, { status: 400 });
            }
            const botInstance = getBot(body.bot);
            if (!botInstance) {
              return Response.json({ error: `bot ${body.bot} not found` }, { status: 404 });
            }
            const settings = getCargoMoverSettings(body.bot);
            const ctx = { bot: botInstance, log: (cat: string, msg: string) => botInstance.log(cat, msg) } as any;
            const result = await reconcileDeliveredWithDestination(ctx, settings);
            return Response.json({ ok: true, ...result });
          } catch (err) {
            return Response.json(
              { error: err instanceof Error ? err.message : String(err) },
              { status: 500 },
            );
          }
        }
        if (url.pathname === "/api/cargo_mover/reset-intransit" && req.method === "POST") {
          try {
            const inTransit = resetInTransitData();
            const coord = resetCoordinationTracking(true);
            return Response.json({ ok: true, inTransit, coordination: coord });
          } catch (err) {
            return Response.json(
              { error: err instanceof Error ? err.message : String(err) },
              { status: 500 },
            );
          }
        }
        if (url.pathname === "/api/stationRef") {
          const stationRefPath = join(DATA_DIR, "stationRef.json");
          if (existsSync(stationRefPath)) {
            try {
              const raw = readFileSync(stationRefPath, "utf-8");
              return Response.json(JSON.parse(raw));
            } catch {
              return Response.json({ stations: [], by_station_id: {}, by_system_id: {}, by_underline_name: {} });
            }
          }
          return Response.json({ stations: [], by_station_id: {}, by_system_id: {}, by_underline_name: {} });
        }
        if (url.pathname === "/api/faction-station-map") {
          const CACHE_DIR = join(process.cwd(), "data", "factionStorage");
          if (!existsSync(CACHE_DIR)) {
            return Response.json({});
          }
          const result: Record<string, string[]> = {};
          const files = readdirSync(CACHE_DIR);
          const factionFiles = files.filter(f => f.endsWith(".json") && !f.startsWith("Busy") && !f.startsWith("1582") && !f.startsWith("bad"));
          for (const file of factionFiles) {
            const match = file.match(/^(.+)--(.+)\.json$/);
            if (match) {
              const [, faction, station] = match;
              if (!result[faction]) result[faction] = [];
              if (!result[faction].includes(station)) result[faction].push(station);
            }
          }
          return Response.json(result);
        }
        if (url.pathname === "/api/map/register-poi" && req.method === "POST") {
          const body = await req.json() as {
            system_id: string;
            poi: {
              id: string;
              name: string;
              type: string;
              hidden?: boolean;
              reveal_difficulty?: number;
              resources?: Array<{
                resource_id: string;
                name: string;
                richness: number;
                remaining: number;
                max_remaining: number;
                depletion_percent: number;
              }>;
            };
          };
          if (body?.system_id && body?.poi?.id) {
            mapStore.registerPoiFromScan(body.system_id, body.poi);
            return Response.json({ ok: true });
          }
          return Response.json({ ok: false, error: "Missing system_id or poi.id" }, { status: 400 });
        }
        if (url.pathname === "/api/map/register-wormhole" && req.method === "POST") {
          const body = await req.json() as {
            system_id: string;
            wormhole: {
              id: string;
              name: string;
              exit_system_id: string;
              exit_system_name: string;
              exit_poi_id: string;
              exit_poi_name: string;
              destination_system_id: string;
              destination_system_name: string;
              expires_in_text?: string;
              expires_at?: string;
            };
          };
          if (body?.system_id && body?.wormhole?.id) {
            mapStore.registerWormhole(body.system_id, body.wormhole);
            return Response.json({ ok: true });
          }
          return Response.json({ ok: false, error: "Missing system_id or wormhole.id" }, { status: 400 });
        }
        if (url.pathname === "/api/map/register-system" && req.method === "POST") {
          const body = await req.json() as { system_data: Record<string, unknown> };
          if (body?.system_data) {
            mapStore.updateSystem(body.system_data);
            return Response.json({ ok: true });
          }
          return Response.json({ ok: false, error: "Missing system_data" }, { status: 400 });
        }
        if (url.pathname === "/api/map/reset-poi" && req.method === "POST") {
          const body = await req.json() as { system_id: string; poi_id: string };
          if (body?.system_id && body?.poi_id) {
            mapStore.resetPoi(body.system_id, body.poi_id);
            return Response.json({ ok: true });
          }
          return Response.json({ ok: false, error: "Missing system_id or poi_id" }, { status: 400 });
        }
        if (url.pathname === "/api/map/reset-corrupted" && req.method === "POST") {
          const result = mapStore.resetCorruptedPois();
          return Response.json(result);
        }
        if (url.pathname === "/api/map/clear-poi-resources" && req.method === "POST") {
          const body = await req.json() as { system_id: string; poi_id: string };
          if (body?.system_id && body?.poi_id) {
            mapStore.clearPoiResources(body.system_id, body.poi_id);
            return Response.json({ ok: true });
          }
          return Response.json({ ok: false, error: "Missing system_id or poi_id" }, { status: 400 });
        }
        if (url.pathname === "/api/routines") {
          return Response.json(this.routines);
        }
        if (url.pathname === "/api/settings") {
          // GET: Return current settings
          if (req.method === "GET") {
            const settings = { ...this.settings };
            delete settings.flock;
            return Response.json(settings);
          }
          // POST: Save settings
          if (req.method === "POST") {
            const updates = await req.json() as Record<string, unknown>;
            for (const [key, value] of Object.entries(updates)) {
              if (key === "flock") continue;
              if (typeof value === 'object' && value !== null && !Array.isArray(value) && key in this.settings && typeof this.settings[key] === 'object' && this.settings[key] !== null) {
                this.settings[key] = { ...this.settings[key], ...value };
              } else {
                this.settings[key] = value as Record<string, unknown>;
              }
            }
            saveSettings(this.settings);
            return Response.json(this.settings);
          }
        }
        if (url.pathname === "/api/flock/settings") {
          if (req.method === "GET") {
            return Response.json(loadFlockSettings());
          }
          if (req.method === "POST") {
            const updates = await req.json() as Record<string, unknown>;
            const current = loadFlockSettings();
            if (updates.flockGroups !== undefined) current.flockGroups = updates.flockGroups as FlockSettingsData["flockGroups"];
            if (updates.assignments !== undefined) current.assignments = updates.assignments as FlockSettingsData["assignments"];
            saveFlockSettings(current);
            return Response.json(current);
          }
        }
        if (url.pathname === "/api/last-used-routines") {
          if (req.method === "GET") {
            return Response.json(getAllLastUsedRoutines());
          }
          if (req.method === "POST") {
            const body = await req.json() as { bot: string; routine: string };
            if (!body.bot || !body.routine) {
              return Response.json({ error: "Missing bot or routine" }, { status: 400 });
            }
            saveLastUsedRoutine(body.bot, body.routine);
            return Response.json({ ok: true });
          }
        }
        if (url.pathname === "/api/stats") {
          return Response.json(this.statsData.daily);
        }
        if (url.pathname === "/api/insurance") {
          if (req.method === "GET") {
            const botName = url.searchParams.get("bot");
            if (botName) {
              const record = getInsuranceRecord(botName);
              if (!record) {
                return Response.json({ record: null, status: "not_found" });
              }
              return Response.json({ record, status: "found" });
            }
            return Response.json(getAllInsuranceRecords());
          }
          return new Response("Method not allowed", { status: 405 });
        }
        if (url.pathname === "/api/taxes") {
          const taxesPath = join(DATA_DIR, "taxes.json");
          if (!existsSync(taxesPath)) {
            return Response.json({ bots: {}, fleetTotals: {} });
          }
          try {
            const raw = readFileSync(taxesPath, "utf-8");
            const taxes = JSON.parse(raw);
            const bots: Record<string, { lastTaxEstimate?: any; history: any[] }> = {};
            let totalIncome = 0, totalIncomeTax = 0, totalPropertyTax = 0, totalAssessedValue = 0, totalTaxPrepaid = 0, totalTaxDue = 0;
            for (const [botName, data] of Object.entries(taxes)) {
              const botData = data as { lastTaxEstimate?: any; history: any[] };
              bots[botName] = botData;
              if (botData.lastTaxEstimate) {
                totalIncome += botData.lastTaxEstimate.taxable_income_to_date || 0;
                totalIncomeTax += botData.lastTaxEstimate.income_tax_total || 0;
                totalPropertyTax += botData.lastTaxEstimate.property_tax_total || 0;
                totalAssessedValue += botData.lastTaxEstimate.assessed_property_value || 0;
                totalTaxPrepaid += botData.lastTaxEstimate.tax_prepaid || 0;
                totalTaxDue += (botData.lastTaxEstimate.income_tax_total || 0) + (botData.lastTaxEstimate.property_tax_total || 0);
              }
            }
            return Response.json({
              bots,
              fleetTotals: {
                totalIncome,
                totalIncomeTax,
                totalPropertyTax,
                totalAssessedValue,
                totalTaxPrepaid,
                totalTaxDue,
                botCount: Object.keys(taxes).length
              }
            });
          } catch {
            return Response.json({ bots: {}, fleetTotals: {} });
          }
        }
        if (url.pathname === "/api/faction-tax-estimate") {
          const factionTaxesFile = join(DATA_DIR, "faction_taxes.json");
          if (!existsSync(factionTaxesFile)) {
            return Response.json({ factionTaxEstimate: null });
          }
          try {
            const raw = readFileSync(factionTaxesFile, "utf-8");
            const data = JSON.parse(raw);
            return Response.json({ factionTaxEstimate: data.lastFactionTaxEstimate || null });
          } catch {
            return Response.json({ factionTaxEstimate: null });
          }
        }
        if (url.pathname === "/api/catalog") {
          return Response.json(catalogStore.getAll());
        }
        if (url.pathname === "/data/catalog.json") {
          const catalogPath = join(DATA_DIR, "catalog.json");
          if (existsSync(catalogPath)) {
            return new Response(readFileSync(catalogPath, "utf-8"), {
              headers: { "Content-Type": "application/json" },
            });
          } else {
            return Response.json({ error: "Catalog file not found" }, { status: 404 });
          }
        }
        if (url.pathname === "/data/map.json") {
          const mapPath = join(DATA_DIR, "map.json");
          if (existsSync(mapPath)) {
            return new Response(readFileSync(mapPath, "utf-8"), {
              headers: { "Content-Type": "application/json" },
            });
          } else {
            return Response.json({ error: "Map file not found" }, { status: 404 });
          }
        }
if (url.pathname === "/data/shipsForSale.json") {
          const shipsForSalePath = join(DATA_DIR, "shipsForSale.json");
          if (existsSync(shipsForSalePath)) {
            return new Response(readFileSync(shipsForSalePath, "utf-8"), {
              headers: {
                "Content-Type": "application/json",
              },
            });
          } else {
            return Response.json({ error: "Ships for sale file not found" }, { status: 404 });
          }
        }
        if (url.pathname === "/data/rawMissions.json") {
          const rawMissionsPath = join(process.cwd(), "data", "rawMissions.json");
          if (existsSync(rawMissionsPath)) {
            return new Response(readFileSync(rawMissionsPath, "utf-8"), {
              headers: {
                "Content-Type": "application/json",
              },
            });
          } else {
            return Response.json({ error: "rawMissions.json not found" }, { status: 404 });
          }
        }
        if (url.pathname === "/api/wildlife") {
          return Response.json(wildlifeStore.getFullData());
        }
        if (url.pathname === "/data/wildlifeInfo.json") {
          return Response.json(wildlifeStore.getFullData(), {
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.pathname === "/api/logs/main") {
          // Return persisted main logs (activity, broadcast, system, faction)
          return Response.json({
            activity: this.activityLog,
            broadcast: this.broadcastLog,
            system: this.systemLog,
            faction: this.factionLog,
          });
        }
        if (url.pathname === "/api/faction-storage") {
          const station = url.searchParams.get("station") || "";
          const factionName = url.searchParams.get("faction") || "";
          const live = url.searchParams.get("live") === "1";
          const liveBot = url.searchParams.get("bot") || "";

          // Live mode: perform an actual remote read via the selected bot so the
          // viewer reflects current server inventory instead of the (often stale)
          // on-disk cache. refreshFactionStorage(true, station) does the live
          // view_faction_storage call AND rewrites the disk cache, so afterwards
          // we can fall through to the normal cache read to build the response.
          if (live && liveBot) {
            const bot = getBot(liveBot);
            if (!bot) {
              return Response.json({ error: { code: "not_found", message: `Bot ${liveBot} not found` }, items: [] });
            }
            try {
              await bot.refreshFactionStorage(true, station || undefined);
              // Return the freshly-read inventory directly from the bot instance.
              // The disk cache is keyed on the RESOLVED hex POI id (not the raw
              // `system|poi` string the viewer sends), so re-reading disk here
              // could miss the just-written file. bot.factionStorage was populated
              // by the live read above, so it is authoritative for this response.
              const items = (bot.factionStorage || []).map((e) => ({
                itemId: e.itemId,
                item_id: e.itemId,
                name: e.name || e.itemId,
                quantity: e.quantity,
              }));
              return Response.json({
                items,
                factionFuelReserve: bot.factionFuelReserve || 0,
                factionFuelCapacity: bot.factionFuelCapacity || 0,
                factionName: bot.faction || factionName,
                station,
                live: true,
              });
            } catch (err) {
              return Response.json({ error: { code: "refresh_failed", message: err instanceof Error ? err.message : String(err) }, items: [] });
            }
          }

          const CACHE_DIR = join(process.cwd(), "data", "factionStorage");
          
          if (!existsSync(CACHE_DIR)) {
            return Response.json({ items: [], factionName: "", station: "" });
          }
          
          if (factionName) {
            const factionStoragePath = join(CACHE_DIR, `${factionName}--${station || "default"}.json`);
            if (!existsSync(factionStoragePath)) {
              return Response.json({ items: [], factionName, station });
            }
            try {
              const raw = readFileSync(factionStoragePath, "utf-8");
              const data = JSON.parse(raw);
              const items = data.entries || data.items || [];
              return Response.json({
                items,
                factionFuelReserve: data.factionFuelReserve || 0,
                factionFuelCapacity: data.factionFuelCapacity || 0,
                factionName: data.factionName,
                station: data.station,
              });
            } catch {
              return Response.json({ items: [], factionName, station });
            }
          }
          
          try {
            const files = readdirSync(CACHE_DIR);
            const allItems: any[] = [];
            let bestFuelReserve = 0;
            let bestFuelCapacity = 0;
            let bestFactionName = "";
            let bestStation = "";
            
            for (const file of files) {
              if (!file.endsWith(".json")) continue;
              const match1 = file.match(/^(.+)::(.+)\.json$/);
              const match2 = file.match(/^(.+)--(.+)\.json$/);
              const match = match1 || match2;
              if (!match) continue;
              const [, fn, st] = match;
              if (st === station) {
                const factionStoragePath = join(CACHE_DIR, file);
                const raw = readFileSync(factionStoragePath, "utf-8");
                const data = JSON.parse(raw);
                const items = data.entries || data.items || [];
                allItems.push(...items);
                if (data.factionFuelReserve > bestFuelReserve) {
                  bestFuelReserve = data.factionFuelReserve;
                  bestFuelCapacity = data.factionFuelCapacity || 0;
                  bestFactionName = data.factionName || fn;
                  bestStation = data.station || st;
                }
              }
            }
            
            if (allItems.length > 0) {
              return Response.json({
                items: allItems,
                factionFuelReserve: bestFuelReserve,
                factionFuelCapacity: bestFuelCapacity,
                factionName: bestFactionName,
                station: bestStation,
              });
            }
            
            for (const file of files) {
              if (!file.endsWith(".json")) continue;
              const match1 = file.match(/^(.+)::(.+)\.json$/);
              const match2 = file.match(/^(.+)--(.+)\.json$/);
              const match = match1 || match2;
              if (!match) continue;
              const factionStoragePath = join(CACHE_DIR, file);
              const raw = readFileSync(factionStoragePath, "utf-8");
              const data = JSON.parse(raw);
              const items = data.entries || data.items || [];
              if (items && items.length > 0) {
                return Response.json({
                  items,
                  factionFuelReserve: data.factionFuelReserve || 0,
                  factionFuelCapacity: data.factionFuelCapacity || 0,
                  factionName: data.factionName,
                  station: data.station,
                });
              }
            }
            return Response.json({ items: [], factionName: "", station });
          } catch {
            return Response.json({ items: [] });
          }
        }
        
        if (url.pathname === "/api/faction-storage/list") {
          // List all available faction storage caches
          const CACHE_DIR = join(process.cwd(), "data", "factionStorage");
          if (!existsSync(CACHE_DIR)) {
            return Response.json({ caches: [] });
          }
          try {
            const files = readdirSync(CACHE_DIR);
            const caches = files
              .filter(f => f.endsWith(".json"))
              .map(f => {
                // Try both formats: with :: and with --
                const match1 = f.match(/^(.+)::(.+)\.json$/);
                const match2 = f.match(/^(.+)--(.+)\.json$/);
                const match = match1 || match2;
                if (!match) return null;
                const [, factionName, station] = match;
                return { factionName, station };
              })
              .filter((c): c is { factionName: string; station: string } => c !== null);
            return Response.json({ caches });
          } catch {
            return Response.json({ caches: [] });
          }
        }

        if (url.pathname === "/api/station-facilities") {
          // Per-station facility list cache (faction + empire facilities).
          const station = url.searchParams.get("station") || "";
          try {
            const { getStationFacilityCache, getAllStationFacilityCacheStations } =
              await import("../stationFacilityCache.js");
            if (station) {
              const data = getStationFacilityCache(station);
              if (!data) {
                return Response.json({ station, factionFacilities: [], empireFacilities: [], lastUpdated: 0 });
              }
              return Response.json(data);
            }
            const stations = getAllStationFacilityCacheStations();
            const all = stations.map((st) => getStationFacilityCache(st)).filter(Boolean);
            return Response.json({ stations: all });
          } catch (e) {
            return Response.json({ error: String(e) });
          }
        }

        if (url.pathname === "/api/faction-fuel-stations" && req.method === "GET") {
          const settings = this.settings;
          const approvedStations = (settings.general as Record<string, unknown>)?.approvedFuelStations as string[] || [];
          const CACHE_DIR = join(process.cwd(), "data", "factionStorage");

          const stationsData: Array<{ stationId: string; systemId: string; fuelReserve: number; fuelCapacity: number }> = [];

          // The bot's own faction (from live status). Cache files are written under
          // this faction name (e.g. "Busy Being Dead--sol_central.json"). Anything
          // else is a mislabeled/bugged file and must NOT be used for the dashboard.
          const ourFaction = (this.latestStatuses || []).map((b) => b.faction).find((f) => !!f) || null;

          for (const stationKey of approvedStations) {
            const [systemId, stationId] = stationKey.split("|");
            if (!stationId) continue;

            try {
              const files = readdirSync(CACHE_DIR);
              let ourFactionData: any = null; // preferred: matches the bot's own faction
              let fallbackData: any = null;   // most recent valid (non-legacy) file

              // The faction storage cache keeps a separate file PER faction for the
              // same station. Some are mislabeled (the monitor used to trust an
              // unreliable response field), so we must prefer the bot's own faction
              // file and only fall back to the most-recent valid file if none exists.
              const consider = (faction: string, data: any): void => {
                const updated = data.lastUpdated || 0;
                const isOurs = ourFaction && (data.factionName === ourFaction || faction === ourFaction);
                if (isOurs) {
                  if (!ourFactionData || updated > (ourFactionData.lastUpdated || 0)) ourFactionData = data;
                  return;
                }
                if (ourFactionData) return; // already have the authoritative faction file
                if (!fallbackData || updated > (fallbackData.lastUpdated || 0)) fallbackData = data;
              };

              for (const file of files) {
                if (!file.endsWith(".json")) continue;
                const match = file.match(/^(.+)--(.+)\.json$/) || file.match(/^(.+)::(.+)\.json$/);
                if (!match) continue;
                const faction = match[1];
                const fileStationId = match[2];
                if (fileStationId !== stationId) continue;
                if (/^[0-9a-f]{8,}$/i.test(faction)) continue; // skip hex hash faction ids
                if (faction.toLowerCase() === "default") continue;
                const raw = readFileSync(join(CACHE_DIR, file), "utf-8");
                consider(faction, JSON.parse(raw));
              }

              // Fallback: if only hex/default faction files existed for this station,
              // take the most recent of those rather than reporting nothing.
              if (!ourFactionData && !fallbackData) {
                for (const file of files) {
                  if (!file.endsWith(".json")) continue;
                  const match = file.match(/^(.+)--(.+)\.json$/) || file.match(/^(.+)::(.+)\.json$/);
                  if (!match || match[2] !== stationId) continue;
                  const raw = readFileSync(join(CACHE_DIR, file), "utf-8");
                  consider(match[1], JSON.parse(raw));
                }
              }

              const bestData = ourFactionData || fallbackData;

              if (bestData) {
                stationsData.push({
                  stationId,
                  systemId,
                  fuelReserve: bestData.factionFuelReserve || 0,
                  fuelCapacity: bestData.factionFuelCapacity || 0,
                });
              }
            } catch {
              // Ignore errors for individual stations
            }
          }

          return Response.json({ stations: stationsData });
        }

        // Shutdown endpoint. `?restart=true` means the user asked to restart
        // the client (re-pull updates) rather than fully shut it down — the
        // watchdog will bring it back up after a git pull.
        if (url.pathname === "/api/shutdown" && req.method === "POST") {
          if (this.onShutdown) {
            const restart = url.searchParams.get("restart") === "true";
            await this.onShutdown(restart);
            return Response.json({ ok: true, message: "Shutting down...", restart });
          }
          return Response.json({ ok: false, error: "No shutdown handler" });
        }

        // Per-bot persistent log files (debug logs with [bot:onLog] entries)
        if (url.pathname.startsWith("/api/logs/")) {
          const botName = decodeURIComponent(url.pathname.slice("/api/logs/".length));
          const tail = parseInt(url.searchParams.get("tail") || "200");
          const logPath = join(process.cwd(), "data", "logs", `${botName}_debug.log`);
          if (!existsSync(logPath)) {
            return Response.json({ lines: [] });
          }
          const content = readFileSync(logPath, "utf-8");
          const allLines = content.split("\n").filter(l => l);
          // Filter only [bot:onLog] lines (activity log entries)
          const botOnLogLines = allLines.filter(line => line.includes("[bot:onLog]"));
          const lines = botOnLogLines.slice(-tail);
          return Response.json({ lines, total: botOnLogLines.length });
        }

        // GET /api/skills - Extract skills from last get_status in each bot's log
        if (url.pathname === "/api/skills" && req.method === "GET") {
          const logsDir = join(process.cwd(), "data", "logs");
          if (!existsSync(logsDir)) {
            return Response.json({ bots: {} });
          }
          const files = readdirSync(logsDir).filter(f => f.endsWith("_debug.log"));
          const result: Record<string, { skills: Record<string, { level: number; xp?: number; nextLevelXp?: number }>; lastUpdated: string }> = {};
          
          for (const file of files) {
            const botName = file.replace(/_debug\.log$/, "");
            const logPath = join(logsDir, file);
            try {
              const content = readFileSync(logPath, "utf-8");
              const lines = content.split("\n");
              
              // Find the last get_status response
              for (let i = lines.length - 1; i >= 0; i--) {
                const line = lines[i];
                if (line.includes("get_status response")) {
                  const jsonStart = line.indexOf("get_status response ");
                  if (jsonStart !== -1) {
                    const jsonStr = line.substring(jsonStart + "get_status response ".length);
                    try {
                      const status = JSON.parse(jsonStr);
                      const skillsData = status.skills as Record<string, { level?: number; xp?: number; next_level_xp?: number }> | undefined;
                      if (skillsData) {
                        const skills: Record<string, { level: number; xp?: number; nextLevelXp?: number }> = {};
                        for (const [skillId, skillData] of Object.entries(skillsData)) {
                          skills[skillId] = {
                            level: skillData.level || 0,
                            xp: skillData.xp,
                            nextLevelXp: skillData.next_level_xp
                          };
                        }
                        result[botName] = { skills, lastUpdated: new Date().toISOString() };
                      }
                    } catch (parseErr) {
                      // JSON parse failed, continue to next line
                    }
                    break;
                  }
                }
              }
            } catch (e) {
              console.warn(`Failed to parse skills from ${file}:`, e);
            }
          }
          return Response.json({ bots: result });
        }

        // Flock state endpoint
        if (url.pathname.startsWith("/api/flock/") && req.method === "GET") {
          const flockName = decodeURIComponent(url.pathname.slice("/api/flock/".length));
          const flockPath = join(process.cwd(), "data", "flock_signals", `${flockName}.json`);
          if (!existsSync(flockPath)) {
            return new Response("Flock not found", { status: 404 });
          }
          try {
            const raw = readFileSync(flockPath, "utf-8");
            const state = JSON.parse(raw);
            return Response.json(state);
          } catch (e) {
            return new Response("Invalid flock state", { status: 500 });
          }
        }

// Client sync routes
        if (url.pathname.startsWith("/api/client-sync/")) {
          if (!this.syncMaster) {
            const csSettings = this.settings.clientSync || {};
            this.syncMaster = new ClientSyncMaster(csSettings);
            // Expose the master on globalThis so botmanager.getCombinedFleetStatus
            // (used by rescue's cross-client fleet poll) can find it. The slave and
            // light slave already publish themselves on globalThis; the master must
            // too, otherwise a rescue bot running ON the master node only ever sees
            // its own local bots and never the connected slaves' pushed statuses.
            (globalThis as unknown as { syncMaster: ClientSyncMaster }).syncMaster = this.syncMaster;
            this.syncMaster.saveSettings();
            // Persist any key the master lazily generated so disk matches memory.
            saveSettings(this.settings);
            if (this.syncMaster.getMode() === "master") {
              this.syncMaster.startFileSync((csSettings.pollIntervalSec as number) || 15);
            }
          }
          const cors = { "Access-Control-Allow-Origin": "*" } as Record<string, string>;
          const syncCfg = (this.settings.clientSync || {}) as Record<string, unknown>;

          if (url.pathname === "/api/client-sync/hello" && req.method === "GET") {
            const clientId = req.headers.get("x-client-id") || "unknown";
            const master = this.syncMaster;
            master?.touch(clientId);
            return Response.json(master?.hello(clientId), { headers: cors });
          }
          if (url.pathname === "/api/client-sync/map" && req.method === "GET") {
            return Response.json(mapStore.getAllSystems(), { headers: cors });
          }
          if (url.pathname === "/api/client-sync/catalog" && req.method === "GET") {
            return Response.json(catalogStore.getAll(), { headers: cors });
          }
          if (url.pathname === "/api/client-sync/stats" && req.method === "GET") {
            return Response.json(this.statsData.daily, { headers: cors });
          }
          if (url.pathname === "/api/client-sync/chat-history" && req.method === "GET") {
            const history = botChatChannel.getHistory(undefined, 100);
            return Response.json(history, { headers: cors });
          }
          if (url.pathname === "/api/client-sync/clients" && req.method === "GET") {
            return Response.json(this.syncMaster?.getClients() ?? [], { headers: cors });
          }
          if (url.pathname === "/api/client-sync/bots" && req.method === "GET") {
            // Combined fleet: this node's own bots plus every connected client's
            // bots (full name + status). Works for both full slaves and the
            // lightweight "light" connect, since both push bot-status updates.
            const combined = [...this.latestStatuses];
            for (const b of (this.syncMaster?.getBots() ?? [])) {
              const u = (b as unknown as Record<string, unknown>).username;
              if (!u || combined.some((x) => (x as unknown as Record<string, unknown>).username === u)) continue;
              combined.push(b as any);
            }
            return Response.json(combined, { headers: cors });
          }
          if (url.pathname === "/api/client-sync/fleet-poll" && req.method === "GET") {
            // Cross-client fleet rescue poll: ask every connected client for its
            // local bots' fuel status + positions and return the union. Used by
            // rescue bots to see the whole connected fleet without each stranded
            // bot having to request a rescue itself. Also returns the client
            // roster so a rescue bot can see which clients are connected (and
            // which one is missing from the combined fleet).
            const poll = await this.syncMaster?.requestFleetRescuePoll();
            return Response.json(poll ?? { bots: [], clients: [] }, { headers: cors });
          }
          if (url.pathname === "/api/client-sync/api-key" && req.method === "GET") {
            return Response.json({ apiKey: this.syncMaster?.getApiKey() ?? "" }, { headers: cors });
          }
          if (url.pathname === "/api/client-sync/set-password" && req.method === "POST") {
            const body = await req.json() as { password: string };
            this.syncMaster?.setPassword(body.password);
            this.syncMaster?.saveSettings();
            saveSettings(this.settings);
            return Response.json({ ok: true }, { headers: cors });
          }
          if (url.pathname === "/api/client-sync/set-api-key" && req.method === "POST") {
            const body = await req.json() as { apiKey: string };
            this.syncMaster?.setApiKey(body.apiKey);
            this.syncMaster?.saveSettings();
            saveSettings(this.settings);
            return Response.json({ ok: true }, { headers: cors });
          }
          if (url.pathname === "/api/client-sync/slave-state" && req.method === "GET") {
            const syncSlave = (globalThis as any).syncSlave;
            if (syncSlave) {
              return Response.json(syncSlave.getState(), { headers: cors });
            }
            const syncLight = (globalThis as any).syncLight;
            if (syncLight) {
              return Response.json({ ...syncLight.getState(), mode: "light" }, { headers: cors });
            }
            return Response.json({ connected: false, lastError: "Slave not running" }, { headers: cors });
          }
          if (url.pathname.startsWith("/api/client-sync/coordination") && req.method === "GET") {
            const file = url.searchParams.get("file") || "";
            const path = join(process.cwd(), "data", file);
            if (!existsSync(path)) return new Response("not found", { status: 404, headers: cors });
            try {
              const raw = readFileSync(path, "utf-8");
              const data = JSON.parse(raw);
              return Response.json(data, { headers: cors });
            } catch {
              return new Response("invalid json", { status: 500, headers: cors });
            }
          }
          if (url.pathname === "/api/client-sync/player-names" && req.method === "GET") {
            return Response.json({ names: playerNameStore.getAll() }, { headers: cors });
          }
          if (url.pathname === "/api/client-sync/wildlife" && req.method === "GET") {
            return Response.json(wildlifeStore.getFullData(), { headers: cors });
          }
          if (url.pathname === "/api/client-sync/wildlife-update" && req.method === "POST") {
            try {
              const body = await req.json() as WildlifeFullData;
              wildlifeStore.mergeFrom(body);
              return Response.json({ ok: true }, { headers: cors });
            } catch {
              return Response.json({ ok: false, error: "invalid json" }, { status: 500, headers: cors });
            }
          }
          if (url.pathname === "/api/client-sync/register" && req.method === "POST") {
            const body = await req.json() as { apiKey: string; label: string; password?: string; url?: string };
            if (!this.syncMaster) {
              return Response.json({ ok: false, error: "syncMaster not initialized" }, { headers: cors });
            }
            const result = await this.syncMaster.register(body);
            if (result.ok && this.syncMaster.getMode() === "master") {
              // Start (idempotent) the periodic re-poll of slaves, then pull
              // this freshly-connected slave immediately so its files are
              // seeded into the combined repository right away.
              this.syncMaster.startFileSync((syncCfg.pollIntervalSec as number) || 15);
              const cid = result.clientId;
              if (body.url) {
                this.syncMaster.pullFromSlave(cid).catch(() => {});
              }
            }
            return Response.json(result, { headers: cors });
          }
          if (url.pathname === "/api/client-sync/test-register" && req.method === "POST") {
            const body = await req.json() as { masterUrl: string; apiKey: string; label?: string; password?: string };
            const testCors = { "Access-Control-Allow-Origin": "*" } as Record<string, string>;
            // Validate the master is reachable and the credentials are correct,
            // but do NOT permanently register a client here — that's what made the
            // connected-clients list pile up with one-shot "Test Connection" pings.
            if (!this.syncMaster) {
              return Response.json({ ok: false, error: "syncMaster not initialized" }, { headers: testCors });
            }
            const result = this.syncMaster.validateConnection({ apiKey: body.apiKey, password: body.password });
            return Response.json(result, { headers: testCors });
          }
          if (url.pathname === "/api/client-sync/chat-relay" && req.method === "POST") {
            const body = await req.json() as { channel: string; content: string; sender?: string };
            const clientId = req.headers.get("x-client-id") || "";
            const result = this.syncMaster?.chatRelay({ ...body, clientId });
            return Response.json(result ?? { ok: false }, { headers: cors });
          }
          if (url.pathname === "/api/client-sync/bot-status" && req.method === "POST") {
            const body = await req.json() as { clientId?: string; statuses: BotStatusPush[] };
            const cid = body.clientId || req.headers.get("x-client-id") || "";
            const ok = this.syncMaster?.botStatusPush(cid, body.statuses);
            if (!ok && cid) {
              // Client pushed statuses but isn't a registered client — usually
              // the master restarted and forgot it, or the slave is pushing with
              // a stale clientId. The slave detects ok:false and re-registers.
              console.warn(`[ClientSync] bot-status push rejected: unknown clientId "${cid}" (master has ${this.syncMaster?.getClients().length} clients)`);
            }
            return Response.json({ ok: !!ok }, { headers: cors });
          }
          if (url.pathname === "/api/client-sync/poi-update" && req.method === "POST") {
            const body = await req.json() as PoiPayload;
            const ok = this.syncMaster?.poiUpdate(body);
            return Response.json({ ok: !!ok }, { headers: cors });
          }
          if (url.pathname === "/api/client-sync/market-update" && req.method === "POST") {
            const body = await req.json() as MarketPayload;
            const ok = this.syncMaster?.marketUpdate(body);
            return Response.json({ ok: !!ok }, { headers: cors });
          }
          if (url.pathname === "/api/client-sync/coordination-sync" && req.method === "POST") {
            const body = await req.json() as CoordinationPayload;
            const ok = this.syncMaster?.coordinationSync(body);
            return Response.json({ ok: !!ok }, { headers: cors });
          }
          if (url.pathname === "/api/client-sync/player-names-update" && req.method === "POST") {
            const body = await req.json() as PlayerNamePayload;
            const ok = this.syncMaster?.playerNamesUpdate(body);
            return Response.json({ ok: !!ok }, { headers: cors });
          }
          if (url.pathname === "/api/client-sync/civilian-transport-update" && req.method === "POST") {
            const body = await req.json() as PassengerPayload;
            const ok = this.syncMaster?.civilianTransportUpdate(body);
            return Response.json({ ok: !!ok }, { headers: cors });
          }
          if (url.pathname === "/api/client-sync/catalog-version" && req.method === "POST") {
            // A connected client reports its local catalog.json version. The
            // master runs the single-download election (only ONE node fetches
            // from the gameserver) and tells this client what to do next.
            const body = await req.json() as { version?: string | null; lastFetched?: string | null };
            const cid = req.headers.get("x-client-id") || "";
            const result = await this.syncMaster?.reportCatalogVersion(
              cid,
              typeof body.version === "string" ? body.version : null,
              typeof body.lastFetched === "string" ? body.lastFetched : null,
            ) ?? { ok: false, gameServerVersion: null, action: "none" };
            // When no client has the new gameserver version (the common post-patch
            // case), the master itself downloads catalog.json ONCE and relays it to
            // the fleet — so clients never hammer the gameserver and stay connected.
            if (result.action === "master_fetch") {
              try {
                await catalogStore.fetchFromLib(true);
                const res = this.syncMaster?.masterCatalogFetched(catalogStore.getAll()) ?? { ok: false, version: null };
                console.log(`[ClientSync] Master fetched catalog v${res.version ?? "?"} from gameserver — relaying to fleet`);
              } catch (err) {
                this.syncMaster?.masterCatalogFetched(null);
                console.error(`[ClientSync] Master catalog fetch failed:`, err);
              }
            }
            return Response.json(result, { headers: cors });
          }
          if (url.pathname === "/api/client-sync/catalog-upload" && req.method === "POST") {
            // A designated client uploads its (freshly fetched) catalog so the
            // master can relay the single copy to every other connected client.
            const body = await req.json() as { catalog?: Record<string, unknown> };
            const cid = req.headers.get("x-client-id") || "";
            const res = this.syncMaster?.catalogUpload(cid, body.catalog ?? null) ?? { ok: false, version: null };
            // Keep the master node's own catalog store fresh so /api/catalog
            // reflects the fleet-converged copy instead of a stale local one.
            if (res.ok && body.catalog) {
              try { catalogStore.replaceWith(body.catalog); } catch { /* non-fatal */ }
            }
            return Response.json(res, { headers: cors });
          }
          if (url.pathname === "/api/client-sync/catalog-sync-state" && req.method === "GET") {
            return Response.json(this.syncMaster?.getCatalogSyncState() ?? {}, { headers: cors });
          }
          if (url.pathname.startsWith("/api/client-sync/clients/") && req.method === "DELETE") {
            const id = decodeURIComponent(url.pathname.slice("/api/client-sync/clients/".length));
            const ok = this.syncMaster?.disconnect(id);
            return Response.json({ ok: !!ok }, { headers: cors });
          }

          // ── File sync (shared by master + slave; the master's local data dir
          //    IS the combined repository) ──────────────────────────────────
          const cfgApiKey = (syncCfg.apiKey as string) || "";
          const cfgPassword = (syncCfg.password as string) || "";
          const apiKeyMatch = !cfgApiKey
            || req.headers.get("x-api-key") === cfgApiKey
            || (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") === cfgApiKey;
          const passwordMatch = !cfgPassword || req.headers.get("x-password") === cfgPassword;
          const fileAuthOk = apiKeyMatch && passwordMatch;

          if (url.pathname === "/api/client-sync/local-files" && req.method === "GET") {
            if (!fileAuthOk) return new Response("unauthorized", { status: 401, headers: cors });
            const dataDir = join(process.cwd(), "data");
            const files: FileEntry[] = listSyncedFiles(dataDir);
            return Response.json({ files }, { headers: cors });
          }
          if (url.pathname === "/api/client-sync/local-file" && req.method === "GET") {
            if (!fileAuthOk) return new Response("unauthorized", { status: 401, headers: cors });
            const relPath = url.searchParams.get("path") || "";
            if (!isPathSynced(relPath)) return new Response("not allowed", { status: 403, headers: cors });
            const dataDir = join(process.cwd(), "data");
            const content = readSyncedFile(dataDir, relPath);
            if (content === null) return new Response("not found", { status: 404, headers: cors });
            return new Response(content, { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
          }
          if (url.pathname === "/api/client-sync/file-update" && req.method === "POST") {
            if (!fileAuthOk) return new Response("unauthorized", { status: 401, headers: cors });
            const body = await req.json() as { path?: string; content?: string };
            if (!body.path || body.content === undefined) {
              return Response.json({ ok: false, error: "path and content required" }, { status: 400, headers: cors });
            }
            if (!isPathSynced(body.path)) return Response.json({ ok: false, error: "not allowed" }, { status: 403, headers: cors });
            const dataDir = join(process.cwd(), "data");
            const hash = mergeIntoFile(dataDir, body.path, body.content);
            if (hash === null) return Response.json({ ok: false, error: "merge failed" }, { status: 500, headers: cors });
            return Response.json({ ok: true, hash }, { headers: cors });
          }
          if (url.pathname === "/api/client-sync/file-seed" && req.method === "POST") {
            if (!fileAuthOk) return new Response("unauthorized", { status: 401, headers: cors });
            const body = await req.json() as { path?: string; content?: string };
            if (!body.path || body.content === undefined) {
              return Response.json({ ok: false, error: "path and content required" }, { status: 400, headers: cors });
            }
            if (!isPathSynced(body.path)) return Response.json({ ok: false, error: "not allowed" }, { status: 403, headers: cors });
            const dataDir = join(process.cwd(), "data");
            const hash = seedIntoFile(dataDir, body.path, body.content);
            if (hash === null) return Response.json({ ok: false, error: "seed failed" }, { status: 500, headers: cors });
            return Response.json({ ok: true, hash, seeded: true }, { headers: cors });
          }

          return new Response("not found", { status: 404, headers: cors });
        }

        // POST actions (fallback for non-WS clients)
        if (url.pathname === "/api/action" && req.method === "POST") {
          const action = (await req.json()) as WebAction;
          if (this.onAction) {
            const result = await this.onAction(action);
            return Response.json(result);
          }
          return Response.json({ ok: false, error: "No action handler" });
        }

        // POST chat endpoint (for fleet commands via faction chat)
        if (url.pathname === "/api/chat" && req.method === "POST") {
          const body = await req.json();
          const { bot, channel, content } = body as { bot: string; channel: string; content: string };
          if (!bot || !channel || !content) {
            return Response.json({ error: { code: "invalid_request", message: "Missing bot, channel, or content" } });
          }
          const botInstance = getBot(bot);
          if (!botInstance) {
            return Response.json({ error: { code: "not_found", message: `Bot ${bot} not found` } });
          }
          try {
            const result = await botInstance.exec("chat", { channel, content });
            return Response.json(result);
          } catch (err) {
            return Response.json({ error: { code: "exec_failed", message: err instanceof Error ? err.message : String(err) } });
          }
        }

        // POST fleet command via bot chat channel (replaces faction chat)
        if (url.pathname === "/api/fleet-command" && req.method === "POST") {
          const body = await req.json();
          const { command, params, fleetId, metadata } = body as { 
            command: string; 
            params?: string; 
            fleetId?: string;
            metadata?: Record<string, unknown>;
          };
          
          if (!command) {
            return Response.json({ error: { code: "invalid_request", message: "Missing command" } });
          }

          // Get fleet settings to find subordinate bots
          const fleetHunterSettings = (this.settings as Record<string, unknown>).fleet_hunter as Record<string, unknown> || {};
          const resolvedFleetId = (fleetId || (fleetHunterSettings.fleetId as string) || "default") as string;
          
          // Get fleet state to find subordinate bots
          const { fleetCommService } = await import("../fleet_comm.js");
          const fleetState = fleetCommService.getFleetState(resolvedFleetId);
          const subordinates = fleetState ? [...fleetState.subordinateBots] : [];
          const commanderBot = fleetState?.commanderBot;
          
          if (!commanderBot) {
            return Response.json({ error: { code: "no_commander", message: "No commander assigned to fleet" } });
          }

          // Send via bot chat channel - include BOTH commander and subordinates
          const commandMsg = `${command} ${params || ""}`.trim();
          const allRecipients = commanderBot ? [commanderBot, ...subordinates] : subordinates;
          
          botChatChannel.send({
            sender: "web-ui",
            recipients: allRecipients,
            channel: "fleet",
            content: commandMsg,
            metadata: {
              command,
              params: params || undefined,
              fleetId: resolvedFleetId,
              fromWebUI: true,
              ...metadata,
            },
          });

          // Also send via fleet comm service for command processing
          await fleetCommService.broadcast(resolvedFleetId, command as any, params || undefined, commanderBot);

          return Response.json({ 
            ok: true, 
            message: `Fleet command ${command} sent to ${subordinates.length} subordinate(s)`,
            fleetId: resolvedFleetId,
            subordinateCount: subordinates.length,
          });
        }

        // Per-bot battle status endpoint
        if (url.pathname.startsWith("/api/bot/") && url.pathname.endsWith("/battle-status") && req.method === "GET") {
          const botName = decodeURIComponent(url.pathname.slice("/api/bot/".length, -"/battle-status".length));
          const bot = getBot(botName);
          if (!bot) {
            return Response.json({ error: { code: "not_found", message: `Bot ${botName} not found` } });
          }
          try {
            const result = await bot.exec("get_battle_status");
            if (result.error) {
              // Not in battle is OK - return null battle
              if ((result.error as Record<string, unknown>).code === "not_in_battle") {
                return Response.json({ battle: null });
              }
              return Response.json({ error: result.error });
            }
            return Response.json({ battle: result.result });
          } catch (err) {
            return Response.json({ error: { code: "exec_failed", message: err instanceof Error ? err.message : String(err) } });
          }
        }

        // Per-bot reload endpoint
        if (url.pathname.startsWith("/api/bot/") && url.pathname.endsWith("/reload") && req.method === "POST") {
          const botName = decodeURIComponent(url.pathname.slice("/api/bot/".length, -"/reload".length));
          const body = await req.json();
          const bot = getBot(botName);
          if (!bot) {
            return Response.json({ error: { code: "not_found", message: `Bot ${botName} not found` } });
          }
          try {
            const result = await bot.exec("reload", {
              weapon_instance_id: body.weapon_instance_id,
              ammo_item_id: body.ammo_item_id
            });
            return Response.json(result);
          } catch (err) {
            return Response.json({ error: { code: "exec_failed", message: err instanceof Error ? err.message : String(err) } });
          }
        }

        // Per-bot achievements endpoint
        if (url.pathname.startsWith("/api/bot/") && url.pathname.endsWith("/achievements") && req.method === "GET") {
          const botName = decodeURIComponent(url.pathname.slice("/api/bot/".length, -"/achievements".length));
          const bot = getBot(botName);
          if (!bot) {
            return Response.json({ error: { code: "not_found", message: `Bot ${botName} not found` } });
          }
          try {
            const result = await bot.exec("get_achievements");
            if (result.error) {
              return Response.json({ error: result.error });
            }
            return Response.json({ data: result.result });
          } catch (err) {
            return Response.json({ error: { code: "exec_failed", message: err instanceof Error ? err.message : String(err) } });
          }
        }

        // Per-bot action endpoint (for battle commands)
        if (url.pathname.startsWith("/api/bot/") && url.pathname.endsWith("/action") && req.method === "POST") {
          const botName = decodeURIComponent(url.pathname.slice("/api/bot/".length, -"/action".length));
          const body = await req.json();
          const bot = getBot(botName);
          if (!bot) {
            return Response.json({ error: { code: "not_found", message: `Bot ${botName} not found` } });
          }
          try {
            // Map battle actions to game commands
            const { type, action, ...params } = body;
            let command: string;
            let cmdParams: Record<string, unknown> = {};
            
            if (type === "battle") {
              switch (action) {
                case "advance":
                  command = "battle";
                  cmdParams = { action: "advance" };
                  break;
                case "retreat":
                  command = "battle";
                  cmdParams = { action: "retreat" };
                  break;
                case "stance":
                  command = "battle";
                  cmdParams = { action: "stance", stance: params.stance };
                  break;
                case "target":
                  command = "battle";
                  cmdParams = { action: "target", target_id: params.target_id };
                  break;
                case "engage":
                  command = "battle";
                  cmdParams = { action: "engage", ...(params.side_id ? { side_id: params.side_id } : {}) };
                  break;
                default:
                  return Response.json({ error: { code: "invalid_action", message: `Unknown battle action: ${action}` } });
              }
            } else {
              return Response.json({ error: { code: "invalid_type", message: `Unknown action type: ${type}` } });
            }
            
            const result = await bot.exec(command, cmdParams);
            return Response.json(result);
          } catch (err) {
            return Response.json({ error: { code: "exec_failed", message: err instanceof Error ? err.message : String(err) } });
          }
        }

        // Crafting Loadouts endpoints
        const LOADOUTS_FILE = join(DATA_DIR, "craftingLoadouts.json");
        const MODULE_LOADOUTS_FILE = join(DATA_DIR, "moduleLoadouts.json");

        interface CraftingLoadoutFile {
          crafting?: Record<string, Record<string, number>>;
          ship?: Record<string, ShipLoadout>;
        }

        interface ModuleLoadout {
          modules: { weapons: string[]; defense: string[]; utility: string[] };
          shipId?: string;
          savedAt?: string;
        }

        interface ShipLoadout {
          shipId: string;
          shipName: string;
          buildMaterials: Array<{ item_id: string; quantity: number }>;
          defaultModules: string[];
          savedAt: string;
        }

        function loadCraftingLoadouts(): Record<string, Record<string, number>> {
          if (existsSync(LOADOUTS_FILE)) {
            try {
              const data: CraftingLoadoutFile = JSON.parse(readFileSync(LOADOUTS_FILE, "utf-8"));
              return data.crafting || {};
            } catch (err) {
              console.warn(`Warning: corrupt craftingLoadouts.json, starting fresh —`, err);
            }
          }
          return {};
        }

        function saveCraftingLoadouts(loadouts: Record<string, Record<string, number>>): void {
          if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
          let fileData: CraftingLoadoutFile = { crafting: loadouts, ship: {} };
          if (existsSync(LOADOUTS_FILE)) {
            try {
              const existing: CraftingLoadoutFile = JSON.parse(readFileSync(LOADOUTS_FILE, "utf-8"));
              fileData.ship = existing.ship || {};
            } catch (err) {
              // ignore, use empty ship section
            }
          }
          fileData.crafting = loadouts;
          writeFileSync(LOADOUTS_FILE, JSON.stringify(fileData, null, 2) + "\n", "utf-8");
        }

        function loadShipLoadouts(): Record<string, ShipLoadout> {
          if (existsSync(LOADOUTS_FILE)) {
            try {
              const data: CraftingLoadoutFile = JSON.parse(readFileSync(LOADOUTS_FILE, "utf-8"));
              return data.ship || {};
            } catch (err) {
              console.warn(`Warning: corrupt craftingLoadouts.json (ship section) —`, err);
            }
          }
          return {};
        }

        function saveShipLoadouts(loadouts: Record<string, ShipLoadout>): void {
          if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
          let fileData: CraftingLoadoutFile = { crafting: {}, ship: loadouts };
          if (existsSync(LOADOUTS_FILE)) {
            try {
              const existing: CraftingLoadoutFile = JSON.parse(readFileSync(LOADOUTS_FILE, "utf-8"));
              fileData.crafting = existing.crafting || {};
            } catch (err) {
              // ignore, use empty crafting section
            }
          }
          fileData.ship = loadouts;
          writeFileSync(LOADOUTS_FILE, JSON.stringify(fileData, null, 2) + "\n", "utf-8");
        }

        function loadModuleLoadouts(): Record<string, ModuleLoadout> {
          // Dedicated file (preferred)
          if (existsSync(MODULE_LOADOUTS_FILE)) {
            try {
              const data = JSON.parse(readFileSync(MODULE_LOADOUTS_FILE, "utf-8"));
              return data || {};
            } catch (err) {
              console.warn(`Warning: corrupt moduleLoadouts.json —`, err);
              return {};
            }
          }

          // One-time migration from old craftingLoadouts.json
          if (existsSync(LOADOUTS_FILE)) {
            try {
              const old: any = JSON.parse(readFileSync(LOADOUTS_FILE, "utf-8"));
              const migrated = old.moduleLoadouts || {};
              if (Object.keys(migrated).length > 0) {
                if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
                writeFileSync(MODULE_LOADOUTS_FILE, JSON.stringify(migrated, null, 2) + "\n", "utf-8");
                console.log(`Migrated ${Object.keys(migrated).length} module presets to data/moduleLoadouts.json`);

                // Strip from old file to prevent future mix-ups
                delete old.moduleLoadouts;
                writeFileSync(LOADOUTS_FILE, JSON.stringify(old, null, 2) + "\n", "utf-8");
              }
              return migrated;
            } catch (err) {
              console.warn(`Warning during module loadouts migration —`, err);
            }
          }
          return {};
        }

        function saveModuleLoadouts(loadouts: Record<string, ModuleLoadout>): void {
          if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
          writeFileSync(MODULE_LOADOUTS_FILE, JSON.stringify(loadouts, null, 2) + "\n", "utf-8");
        }

        // GET /api/crafting-loadouts - Load all loadouts
        if (url.pathname === "/api/crafting-loadouts" && req.method === "GET") {
          const loadouts = loadCraftingLoadouts();
          return Response.json({ loadouts });
        }

        // POST /api/crafting-loadouts - Save a loadout
        if (url.pathname === "/api/crafting-loadouts" && req.method === "POST") {
          const body = await req.json() as { name: string; craftLimits: Record<string, number> };
          if (!body?.name || !body?.craftLimits) {
            return Response.json({ error: "Missing name or craftLimits" }, { status: 400 });
          }
          const loadouts = loadCraftingLoadouts();
          loadouts[body.name] = body.craftLimits;
          saveCraftingLoadouts(loadouts);
          return Response.json({ ok: true, name: body.name });
        }

         // DELETE /api/crafting-loadouts/:name - Delete a loadout
         if (url.pathname.startsWith("/api/crafting-loadouts/") && req.method === "DELETE") {
           const name = decodeURIComponent(url.pathname.slice("/api/crafting-loadouts/".length));
           const loadouts = loadCraftingLoadouts();
           if (!(name in loadouts)) {
             return Response.json({ error: "Loadout not found" }, { status: 404 });
           }
           delete loadouts[name];
           saveCraftingLoadouts(loadouts);
           return Response.json({ ok: true, name });
         }

         // GET /api/ship-loadouts - Load all ship loadouts
         if (url.pathname === "/api/ship-loadouts" && req.method === "GET") {
           const loadouts = loadShipLoadouts();
           return Response.json({ loadouts });
         }

         // POST /api/ship-loadouts - Save a ship loadout
         if (url.pathname === "/api/ship-loadouts" && req.method === "POST") {
           const body = await req.json() as { name: string; shipId: string; shipName: string; buildMaterials: Array<{item_id: string; quantity: number}>; defaultModules: string[] };
           if (!body?.name || !body?.shipId || !body?.buildMaterials) {
             return Response.json({ error: "Missing required fields" }, { status: 400 });
           }
           const loadouts = loadShipLoadouts();
           loadouts[body.name] = {
             shipId: body.shipId,
             shipName: body.shipName,
             buildMaterials: body.buildMaterials,
             defaultModules: body.defaultModules || [],
             savedAt: new Date().toISOString()
           };
           saveShipLoadouts(loadouts);
           return Response.json({ ok: true, name: body.name });
         }

         // DELETE /api/ship-loadouts/:name - Delete a ship loadout
         if (url.pathname.startsWith("/api/ship-loadouts/") && req.method === "DELETE") {
           const name = decodeURIComponent(url.pathname.slice("/api/ship-loadouts/".length));
           const loadouts = loadShipLoadouts();
           if (!(name in loadouts)) {
             return Response.json({ error: "Loadout not found" }, { status: 404 });
           }
            delete loadouts[name];
            saveShipLoadouts(loadouts);
            return Response.json({ ok: true, name });
          }

          // GET /api/module-loadouts - Load all module loadouts for simulator
          if (url.pathname === "/api/module-loadouts" && req.method === "GET") {
            const loadouts = loadModuleLoadouts();
            return Response.json({ loadouts });
          }

          // POST /api/module-loadouts - Save a module loadout preset
          if (url.pathname === "/api/module-loadouts" && req.method === "POST") {
            const body = await req.json() as { name: string; modules: { weapons: string[]; defense: string[]; utility: string[] }; shipId?: string };
            if (!body?.name || !body?.modules) {
              return Response.json({ error: "Missing name or modules" }, { status: 400 });
            }
            const loadouts = loadModuleLoadouts();
            loadouts[body.name] = {
              modules: body.modules,
              shipId: body.shipId,
              savedAt: new Date().toISOString()
            };
            saveModuleLoadouts(loadouts);
            return Response.json({ ok: true, name: body.name });
          }

          // DELETE /api/module-loadouts/:name - Delete a module loadout
          if (url.pathname.startsWith("/api/module-loadouts/") && req.method === "DELETE") {
            const name = decodeURIComponent(url.pathname.slice("/api/module-loadouts/".length));
            const loadouts = loadModuleLoadouts();
            if (!(name in loadouts)) {
              return Response.json({ error: "Loadout not found" }, { status: 404 });
            }
            delete loadouts[name];
            saveModuleLoadouts(loadouts);
            return Response.json({ ok: true, name });
          }

          // GET /api/facility-transfer-loadouts - Load all facility transfer loadouts
          if (url.pathname === "/api/facility-transfer-loadouts" && req.method === "GET") {
            const loadouts = getFacilityTransferLoadouts();
            return Response.json({ loadouts });
          }

          // POST /api/facility-transfer-loadouts - Save a facility transfer loadout
          if (url.pathname === "/api/facility-transfer-loadouts" && req.method === "POST") {
            const body = await req.json() as { name: string; items: Array<{ itemId: string; itemName: string; targetQuantity: number }> };
            if (!body?.name || !Array.isArray(body.items)) {
              return Response.json({ error: "Missing name or items" }, { status: 400 });
            }
            const loadout: any = {
              name: body.name,
              items: body.items,
              createdAt: new Date().toISOString(),
            };
            saveFacilityTransferLoadout(body.name, { items: body.items });
            return Response.json({ ok: true, name: body.name });
          }

          // DELETE /api/facility-transfer-loadouts/:name - Delete a facility transfer loadout
          if (url.pathname.startsWith("/api/facility-transfer-loadouts/") && req.method === "DELETE") {
            const name = decodeURIComponent(url.pathname.slice("/api/facility-transfer-loadouts/".length));
            const success = deleteFacilityTransferLoadout(name);
            if (!success) {
              return Response.json({ error: "Loadout not found" }, { status: 404 });
            }
            return Response.json({ ok: true, name });
          }

          // PATCH /api/facility-transfer-loadouts/:name/active - Set loadout active state
          if (url.pathname.match(/^\/api\/facility-transfer-loadouts\/[^/]+\/active$/) && req.method === "PATCH") {
            const name = decodeURIComponent(url.pathname.slice("/api/facility-transfer-loadouts/".length, -"/active".length));
            const body = await req.json() as { active: boolean };
            setLoadoutActive(name, body.active);
            return Response.json({ ok: true, name, active: body.active });
          }

          // GET /api/facility-transfer-completions?station=X - Get completions for a station
          if (url.pathname === "/api/facility-transfer-completions" && req.method === "GET") {
            const station = url.searchParams.get("station") || "";
            const completions = getStationCompletions(station);
            return Response.json({ completions });
          }

          // DELETE /api/facility-transfer-completions/loadout/:name - Clear completions for a loadout
          if (url.pathname.startsWith("/api/facility-transfer-completions/loadout/") && req.method === "DELETE") {
            const name = decodeURIComponent(url.pathname.slice("/api/facility-transfer-completions/loadout/".length));
            clearLoadoutCompletions(name);
            return Response.json({ ok: true, cleared: name });
          }

          // DELETE /api/facility-transfer-completions - Clear all completions
          if (url.pathname === "/api/facility-transfer-completions" && req.method === "DELETE") {
            clearAllCompletions();
            return Response.json({ ok: true, cleared: "all" });
          }

          // Serve index.css

        if (url.pathname === "/index.css") {
          const cssPath = join(import.meta.dir, "index.css");
          return new Response(readFileSync(cssPath, "utf-8"), {
            headers: {
              "Content-Type": "text/css; charset=utf-8",
              "Cache-Control": "no-store",
            },
          });
        }

        // Serve dashboard variants page
        if (url.pathname === "/dashboard-variants" || url.pathname === "/variants") {
          const variantsPath = join(import.meta.dir, "dashboard-variants.html");
          return new Response(readFileSync(variantsPath, "utf-8"), {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-store",
            },
          });
        }

        // API endpoint for player data
        if (url.pathname === "/api/players" && req.method === "GET") {
          const playersPath = join(DATA_DIR, "fullPlayerInfo.json");
          if (!existsSync(playersPath)) {
            return Response.json({ players: {}, total: 0 });
          }
          try {
            const raw = readFileSync(playersPath, "utf-8");
            const data = JSON.parse(raw);
            const playerCount = Object.keys(data.players || {}).length;
            return Response.json({ ...data, total: playerCount });
          } catch {
            return Response.json({ players: {}, total: 0 });
          }
        }

        // Serve players.html for players route
        if (url.pathname === "/players.html") {
          const playersPath = join(import.meta.dir, "players.html");
          return new Response(readFileSync(playersPath, "utf-8"), {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-store",
            },
          });
        }

        // Serve shipsforsale.html for ships for sale route
        if (url.pathname === "/shipsforsale.html") {
          const shipsforsalePath = join(import.meta.dir, "shipsforsale.html");
          return new Response(readFileSync(shipsforsalePath, "utf-8"), {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-store",
            },
          });
        }

        // Serve shipSim.html for ship simulator route
        if (url.pathname === "/shipSim.html") {
          const shipSimPath = join(import.meta.dir, "shipSim.html");
          return new Response(readFileSync(shipSimPath, "utf-8"), {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-store",
            },
          });
        }

        // Serve engineeringCalc.html for engineering calculator route
        if (url.pathname === "/engineeringCalc.html") {
          const engineeringCalcPath = join(import.meta.dir, "engineeringCalc.html");
          return new Response(readFileSync(engineeringCalcPath, "utf-8"), {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-store",
            },
          });
        }

        // Serve fa.html for Forensic Analysis route
        if (url.pathname === "/fa.html") {
          const faPath = join(import.meta.dir, "fa.html");
          return new Response(readFileSync(faPath, "utf-8"), {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-store",
            },
          });
        }

        // Serve creatures.html for creatures route
        if (url.pathname === "/creatures.html") {
          const creaturesPath = join(import.meta.dir, "creatures.html");
          return new Response(readFileSync(creaturesPath, "utf-8"), {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-store",
            },
          });
        }

        // Serve commandall.html for command all route
        if (url.pathname === "/commandall.html") {
          const commandallPath = join(import.meta.dir, "commandall.html");
          return new Response(readFileSync(commandallPath, "utf-8"), {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-store",
            },
          });
        }

        // Serve chat.html for chat UI route
        if (url.pathname === "/chat.html" || url.pathname === "/chat") {
          const chatPath = join(import.meta.dir, "chat.html");
          return new Response(readFileSync(chatPath, "utf-8"), {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-store",
            },
          });
        }

        // Serve chat.css for chat UI
        if (url.pathname === "/chat.css") {
          const chatCssPath = join(import.meta.dir, "chat.css");
          return new Response(readFileSync(chatCssPath, "utf-8"), {
            headers: {
              "Content-Type": "text/css; charset=utf-8",
              "Cache-Control": "no-store",
            },
          });
        }

        // Serve map.html for map route
        if (url.pathname === "/map.html") {
          const mapPath = join(import.meta.dir, "map.html");
          return new Response(readFileSync(mapPath, "utf-8"), {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-store",
            },
          });
        }

        // Serve chat.html for chat route
        if (url.pathname === "/chat.html" || url.pathname === "/chat/") {
          const chatPath = join(import.meta.dir, "chat.html");
          return new Response(readFileSync(chatPath, "utf-8"), {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-store",
            },
          });
        }

        // Serve chat.css for chat route
        if (url.pathname === "/chat.css") {
          const chatCssPath = join(import.meta.dir, "chat.css");
          return new Response(readFileSync(chatCssPath, "utf-8"), {
            headers: {
              "Content-Type": "text/css; charset=utf-8",
              "Cache-Control": "no-store",
            },
          });
        }

        // Serve market.html for market route
        if (url.pathname === "/market.html") {
          const marketPath = join(import.meta.dir, "market.html");
          return new Response(readFileSync(marketPath, "utf-8"), {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-store",
            },
          });
        }

        // Serve missions.html for missions route
        if (url.pathname === "/missions.html") {
          const missionsPath = join(import.meta.dir, "missions.html");
          return new Response(readFileSync(missionsPath, "utf-8"), {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-store",
            },
          });
        }

        // Serve shipyard.html for shipyard route
        if (url.pathname === "/shipyard.html") {
          const shipyardPath = join(import.meta.dir, "shipyard.html");
          return new Response(readFileSync(shipyardPath, "utf-8"), {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-store",
            },
          });
        }

        // Serve stats.html for stats route
        if (url.pathname === "/stats.html") {
          const statsPath = join(import.meta.dir, "stats.html");
          return new Response(readFileSync(statsPath, "utf-8"), {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-store",
            },
          });
        }

        // Serve achievements.html for achievements route
        if (url.pathname === "/achievements.html") {
          const achievementsPath = join(import.meta.dir, "achievements.html");
          return new Response(readFileSync(achievementsPath, "utf-8"), {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-store",
            },
          });
        }

        // Serve shipComparison.html for ship comparison route
        if (url.pathname === "/shipComparison.html") {
          const shipComparisonPath = join(import.meta.dir, "shipComparison.html");
          return new Response(readFileSync(shipComparisonPath, "utf-8"), {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-store",
            },
          });
        }

        // Serve index.html for all other routes (read fresh for dev, no cache)
        return new Response(readFileSync(indexPath, "utf-8"), {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      },

      websocket: {
        open: (ws: ServerWebSocket<WSData>) => {
          console.log(`WebSocket connection opened (id: ${ws.data.id})`);
          this.clients.add(ws);

          // Defer sending init to avoid blocking the event loop
          setImmediate(() => {
            try {
              // Build known systems list for settings dropdowns
              const knownSystems = this.getKnownSystemsList();
              const knownOres = mapStore.getAllKnownOres();

              // Serialize per-bot logs as { username: lines[] }
              const botLogsObj: Record<string, string[]> = {};
              for (const [name, lines] of this.botLogs) {
                botLogsObj[name] = lines;
              }

              // Send basic init data first (small)
              const initPayload = {
                type: "init",
                bots: this.latestStatuses,
                routines: this.routines,
                settings: this.settings,
                knownSystems,
                knownOres,
                mobileCapitol: this.getMobileCapitolLocation(),
                logs: {
                  activity: this.activityLog,
                  broadcast: this.broadcastLog,
                  system: this.systemLog,
                  faction: this.factionLog,
                },
                botLogs: botLogsObj,
                flockSettings: loadFlockSettings(),
                lastUsedRoutines: getAllLastUsedRoutines(),
              };
              this.trackWsBytes(initPayload);
              ws.send(JSON.stringify(initPayload));

              // Send large data separately to avoid blocking with JSON serialization.
              // These payloads are cached (built once, reused for every connection)
              // so reconnect storms / multiple tabs don't re-serialize ~1.1MB each time.
              setImmediate(() => {
                try {
                  const mapJson = this.getMapDataMessage();
                  console.log(`Sending mapData, size: ${mapJson.length} chars`);
                  this.trackWsBytesRaw(mapJson, "mapData");
                  ws.send(mapJson);

                  const catalogJson = this.getCatalogMessage();
                  console.log(`Sending catalog, size: ${catalogJson.length} chars`);
                  this.trackWsBytesRaw(catalogJson, "catalog");
                  ws.send(catalogJson);

                  const statsJson = this.getStatsMessage();
                  console.log(`Sending statsDaily, size: ${statsJson.length} chars`);
                  this.trackWsBytesRaw(statsJson, "statsDaily");
                  ws.send(statsJson);
                } catch (err) {
                  console.warn('Failed to send large data:', err);
                }
              });
            } catch (err) {
              console.warn('Failed to send init message:', err);
              this.clients.delete(ws);
            }
          });
        },

        message: async (ws: ServerWebSocket<WSData>, msg: string | Buffer) => {
          let seq: unknown;
          let isExec = false;
          try {
            const raw = JSON.parse(typeof msg === "string" ? msg : msg.toString());
            // Heartbeat: the client pings to prove the socket is alive (and to
            // keep it from being reaped); reply with a pong so the client's
            // data watchdog sees activity.
            if (raw && raw.type === "ping") {
              this.trackWsBytes({ type: "pong" });
              try { ws.send(JSON.stringify({ type: "pong" })); } catch {}
              return;
            }
            seq = raw._seq;
            isExec = raw.type === "exec";
            const data = raw as WebAction;



            if (this.onAction) {
              const result = await this.onAction(data);
              const resType = isExec ? "execResult" : "actionResult";
              const responseData = { type: resType, action: data.type, _seq: seq, bot: data.bot, command: data.command, params: data.params, ...result };
              this.trackWsBytes(responseData);
              ws.send(JSON.stringify(responseData));
            }
          } catch (err) {
            const rawData = JSON.parse(typeof msg === "string" ? msg : msg.toString());
            const errorResponse = {
              type: isExec ? "execResult" : "actionResult",
              _seq: seq,
              bot: rawData.bot,
              command: rawData.command,
              params: rawData.params,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            };
            this.trackWsBytes(errorResponse);
            ws.send(JSON.stringify(errorResponse));
          }
        },

        close: (ws: ServerWebSocket<WSData>) => {
          this.clients.delete(ws);
        },
      },
    });

    // Periodically reload settings from disk to catch external writes (e.g., from bot routines)
    setInterval(() => {
      this.reloadSettingsFromDisk();
    }, 10000); // Check every 10 seconds

    const lanIp = getLocalIp() || "localhost";
    console.log(`Dashboard: http://localhost:${this.port}`);
    console.log(`Dashboard (LAN): http://${lanIp}:${this.port}`);
  }

  stop(): void {
    this.server?.stop();
  }

  // ── Interface matching TUI ─────────────────────────────────

  updateBotStatus(bots: BotStatus[]): void {
    // Merge live statuses with any rehydrated (offline) bots that haven't
    // produced a live status yet, so the dashboard list stays stable across
    // restarts instead of being wiped while the fleet is still reconnecting.
    const liveByUser = new Map(bots.map((b) => [b.username, b]));
    const merged: BotStatus[] = bots.slice();
    for (const [name, offlineStatus] of [...this.seededOffline]) {
      if (liveByUser.has(name)) {
        // This bot has now (re)connected — drop its offline placeholder.
        this.seededOffline.delete(name);
        continue;
      }
      merged.push(offlineStatus);
    }
    this.latestStatuses = merged;
    // Persist a snapshot (live only) so a future restart rehydrates from real
    // last-known data rather than stale ghosts.
    scheduleActiveBotsSave(bots);
    this.broadcast({ type: "status", bots: merged });
  }

  /** Flush pending activeBots snapshot to disk immediately (call on shutdown). */
  flushActiveBots(): void {
    flushActiveBotsSave();
  }

  /** Drop a rehydrated offline placeholder (e.g. when its bot is removed). */
  clearSeededOffline(username: string): void {
    if (this.seededOffline.delete(username)) {
      this.latestStatuses = this.latestStatuses.filter((b) => b.username !== username);
      this.broadcast({ type: "status", bots: this.latestStatuses });
    }
  }

  logActivity(line: string): void {
    this.pushLog(this.activityLog, line);
    this.scheduleMainLogSave();
    this.broadcast({ type: "log", panel: "activity", line });
  }

  logBroadcast(line: string): void {
    this.pushLog(this.broadcastLog, line);
    this.scheduleMainLogSave();
    this.broadcast({ type: "log", panel: "broadcast", line });
  }

  logSystem(line: string): void {
    this.pushLog(this.systemLog, line);
    this.scheduleMainLogSave();
    this.broadcast({ type: "log", panel: "system", line });
  }

  logFaction(line: string): void {
    this.pushLog(this.factionLog, line);
    this.scheduleMainLogSave();
    this.broadcast({ type: "factionLog", line });
  }

  logBot(username: string, line: string): void {
    if (!this.botLogs.has(username)) {
      this.botLogs.set(username, []);
    }
    const buf = this.botLogs.get(username)!;
    this.pushLog(buf, line);
    this.broadcast({ type: "botLog", username, line });
  }

  // ── Cached, pre-serialized large payloads ──────────────────
  // Built once and reused for every connection; invalidated when the
  // underlying data changes. Avoids re-stringifying ~1.1MB maps per connect.

  private getMapDataMessage(): string {
    if (this.mapDataCache === null) {
      this.mapDataCache = JSON.stringify({ type: "mapData", data: mapStore.getAllSystems() });
    }
    return this.mapDataCache;
  }

  private getCatalogMessage(): string {
    if (this.catalogCache === null) {
      this.catalogCache = JSON.stringify({ type: "catalog", data: catalogStore.getAll() });
    }
    return this.catalogCache;
  }

  private getStatsMessage(): string {
    if (this.statsCache === null) {
      this.statsCache = JSON.stringify({ type: "statsDaily", data: this.statsData.daily });
    }
    return this.statsCache;
  }

  updateMapData(): void {
    this.mapDataCache = null;
    this.broadcast({
      type: "mapUpdate",
      mapData: mapStore.getAllSystems(),
      knownOres: mapStore.getAllKnownOres(),
    });
  }

  // ── Stats flushing ──────────────────────────────────────────

  flushBotStats(bots: BotStatus[]): void {
    const today = todayStr();
    let changed = false;

    for (const bot of bots) {
      if (!bot.stats) continue;
      const name = bot.username;

      const current: DayStats = {
        mined: bot.stats.totalMined,
        crafted: bot.stats.totalCrafted,
        trades: bot.stats.totalTrades,
        profit: bot.stats.totalProfit,
        systems: bot.stats.totalSystems,
      };

      // Get last seen snapshot (default zeros)
      const last = this.statsData.lastSeen[name] || { mined: 0, crafted: 0, trades: 0, profit: 0, systems: 0 };

      // If bot restarted (stats went back to zero/lower), reset lastSeen
      const botRestarted =
        current.mined < last.mined ||
        current.crafted < last.crafted ||
        current.trades < last.trades ||
        current.profit < last.profit ||
        current.systems < last.systems;

      const base = botRestarted ? { mined: 0, crafted: 0, trades: 0, profit: 0, systems: 0 } : last;

      // Compute deltas
      const dm = current.mined - base.mined;
      const dc = current.crafted - base.crafted;
      const dt = current.trades - base.trades;
      const dp = current.profit - base.profit;
      const ds = current.systems - base.systems;

      // Always update lastSeen so restart detection works next cycle
      this.statsData.lastSeen[name] = { ...current };

      if (dm === 0 && dc === 0 && dt === 0 && dp === 0 && ds === 0) continue;

      // Accumulate into daily
      if (!this.statsData.daily[name]) this.statsData.daily[name] = {};
      const day = this.statsData.daily[name][today] || { mined: 0, crafted: 0, trades: 0, profit: 0, systems: 0 };
      day.mined += dm;
      day.crafted += dc;
      day.trades += dt;
      day.profit += dp;
      day.systems += ds;
      this.statsData.daily[name][today] = day;
      changed = true;
    }

    if (changed) {
      pruneOldDates(this.statsData.daily);
      saveStats(this.statsData);
      this.statsCache = null;
      this.broadcast({ type: "statsUpdate", statsDaily: this.statsData.daily });
    }
  }

  getStatsData(): Record<string, Record<string, DayStats>> {
    return this.statsData.daily;
  }

  // ── Internal helpers ───────────────────────────────────────

  private getKnownSystemsList(): Array<{ id: string; name: string }> {
    const ids = mapStore.getKnownSystems();
    return ids.map(id => {
      const sys = mapStore.getSystem(id);
      return { id, name: sys?.name || id };
    });
  }

  private getMobileCapitolLocation(): { systemId: string; systemName: string; poiId: string; discoveredAt: string } | null {
    return mapStore.getMobileCapitolLocation();
  }

  private pushLog(buffer: string[], line: string): void {
    buffer.push(line);
    if (buffer.length > MAX_LOG_BUFFER) {
      buffer.shift();
    }
  }

  private broadcast(data: unknown): void {
    this.trackWsBytes(data);
    const msg = JSON.stringify(data);
    for (const ws of this.clients) {
      try {
        ws.send(msg);
      } catch {
        this.clients.delete(ws);
      }
    }
  }

  sendEmpireAlert(sender: string, content: string, botUsername: string): void {
    this.broadcast({ type: "empireAlert", sender, content, botUsername });
  }

  /** Broadcast an arbitrary structured event to all connected dashboard clients. */
  broadcastJson(data: unknown): void {
    this.broadcast(data);
  }

  broadcastSkillsUpdate(bot: string, skills: Record<string, { level: number; xp: number; nextLevelXp: number }>): void {
    this.broadcast({ type: "skillsUpdate", bot, skills });
  }
}
