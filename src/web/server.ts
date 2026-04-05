import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import type { BotStatus } from "../bot.js";
import { getBot } from "../botmanager.js";
import { mapStore } from "../mapstore.js";
import { catalogStore } from "../catalogstore.js";
import type { ServerWebSocket } from "bun";

// ── Types ──────────────────────────────────────────────────

export interface WebAction {
  type: "start" | "stop" | "add" | "register" | "chat" | "saveSettings" | "exec" | "remove" | "shutdown" | "emergencyReturn";
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

export { loadSettings };

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
  writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2) + "\n", "utf-8");
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
  writeFileSync(STATS_FILE, JSON.stringify(s, null, 2) + "\n", "utf-8");
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

  // Persisted routine settings
  settings: RoutineSettings;

  // Persisted stats
  private statsData: StatsFile;

  // Action callback — set by botmanager
  onAction: ((action: WebAction) => Promise<WebActionResult>) | null = null;

  // Shutdown callback — set by botmanager
  onShutdown: (() => Promise<void>) | null = null;

  // Available routines — set by botmanager
  routines: string[] = [];

  constructor(port: number = 3000) {
    this.port = port;
    this.settings = loadSettings();
    this.statsData = loadStats();
    // Load persisted main logs
    const mainLogs = loadMainLogs();
    this.activityLog = mainLogs.activity.slice(-MAX_LOG_BUFFER);
    this.broadcastLog = mainLogs.broadcast.slice(-MAX_LOG_BUFFER);
    this.systemLog = mainLogs.system.slice(-MAX_LOG_BUFFER);
    this.factionLog = mainLogs.faction.slice(-MAX_LOG_BUFFER);
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
      port: this.port,
      fetch: async (req, server) => {
        const url = new URL(req.url);

        // WebSocket upgrade
        if (url.pathname === "/ws") {
          const id = this.nextClientId++;
          const ok = server.upgrade(req, { data: { id } });
          if (ok) return undefined as unknown as Response;
          return new Response("WebSocket upgrade failed", { status: 400 });
        }

        // REST API
        if (url.pathname === "/api/bots") {
          return Response.json(this.latestStatuses);
        }
        if (url.pathname === "/api/bots/discovered") {
          // Return list of discovered bot usernames (even if not logged in)
          const { getDiscoveredBots } = await import("../botmanager.js");
          const discovered = getDiscoveredBots();
          return Response.json({ usernames: discovered });
        }
        if (url.pathname === "/api/map") {
          return Response.json({ systems: mapStore.getAllSystems() });
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
        if (url.pathname === "/api/map/register-system" && req.method === "POST") {
          const body = await req.json() as { system_data: Record<string, unknown> };
          if (body?.system_data) {
            mapStore.updateSystem(body.system_data);
            return Response.json({ ok: true });
          }
          return Response.json({ ok: false, error: "Missing system_data" }, { status: 400 });
        }
        if (url.pathname === "/api/routines") {
          return Response.json(this.routines);
        }
        if (url.pathname === "/api/settings") {
          // GET: Return current settings
          if (req.method === "GET") {
            return Response.json(this.settings);
          }
          // POST: Save settings
          if (req.method === "POST") {
            const updates = await req.json() as Record<string, unknown>;
            // Merge updates into this.settings (deep merge for nested objects)
            for (const [key, value] of Object.entries(updates)) {
              if (typeof value === 'object' && value !== null && !Array.isArray(value) && key in this.settings && typeof this.settings[key] === 'object' && this.settings[key] !== null) {
                // Deep merge nested objects
                this.settings[key] = { ...this.settings[key], ...value };
              } else {
                this.settings[key] = value as Record<string, unknown>;
              }
            }
            saveSettings(this.settings);
            return Response.json(this.settings);
          }
        }
        if (url.pathname === "/api/stats") {
          return Response.json(this.statsData.daily);
        }
        if (url.pathname === "/api/catalog") {
          return Response.json(catalogStore.getAll());
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

        // Shutdown endpoint
        if (url.pathname === "/api/shutdown" && req.method === "POST") {
          if (this.onShutdown) {
            await this.onShutdown();
            return Response.json({ ok: true, message: "Shutting down..." });
          }
          return Response.json({ ok: false, error: "No shutdown handler" });
        }

        // Per-bot persistent log files
        if (url.pathname.startsWith("/api/logs/")) {
          const botName = decodeURIComponent(url.pathname.slice("/api/logs/".length));
          const tail = parseInt(url.searchParams.get("tail") || "200");
          const logPath = join(process.cwd(), "data", "logs", `${botName}.log`);
          if (!existsSync(logPath)) {
            return Response.json({ lines: [] });
          }
          const content = readFileSync(logPath, "utf-8");
          const allLines = content.split("\n").filter(l => l);
          const lines = allLines.slice(-tail);
          return Response.json({ lines, total: allLines.length });
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
          this.clients.add(ws);

          // Build known systems list for settings dropdowns
          const knownSystems = this.getKnownSystemsList();
          const knownOres = mapStore.getAllKnownOres();

          // Send scrollback and current state
          // Serialize per-bot logs as { username: lines[] }
          const botLogsObj: Record<string, string[]> = {};
          for (const [name, lines] of this.botLogs) {
            botLogsObj[name] = lines;
          }

          ws.send(JSON.stringify({
            type: "init",
            bots: this.latestStatuses,
            routines: this.routines,
            settings: this.settings,
            knownSystems,
            knownOres,
            mobileCapitol: this.getMobileCapitolLocation(),
            catalog: catalogStore.getAll(),
            mapData: mapStore.getAllSystems(),
            statsDaily: this.statsData.daily,
            logs: {
              activity: this.activityLog,
              broadcast: this.broadcastLog,
              system: this.systemLog,
              faction: this.factionLog,
            },
            botLogs: botLogsObj,
          }));
        },

        message: async (ws: ServerWebSocket<WSData>, msg: string | Buffer) => {
          let seq: unknown;
          let isExec = false;
          try {
            const raw = JSON.parse(typeof msg === "string" ? msg : msg.toString());
            seq = raw._seq;
            isExec = raw.type === "exec";
            const data = raw as WebAction;
            if (this.onAction) {
              const result = await this.onAction(data);
              const resType = isExec ? "execResult" : "actionResult";
              ws.send(JSON.stringify({ type: resType, _seq: seq, ...result }));
            }
          } catch (err) {
            ws.send(JSON.stringify({
              type: isExec ? "execResult" : "actionResult",
              _seq: seq,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            }));
          }
        },

        close: (ws: ServerWebSocket<WSData>) => {
          this.clients.delete(ws);
        },
      },
    });

    console.log(`Dashboard: http://localhost:${this.port}`);
  }

  stop(): void {
    this.server?.stop();
  }

  // ── Interface matching TUI ─────────────────────────────────

  updateBotStatus(bots: BotStatus[]): void {
    this.latestStatuses = bots;
    this.broadcast({ type: "status", bots });
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

  updateMapData(): void {
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
    const msg = JSON.stringify(data);
    for (const ws of this.clients) {
      try {
        ws.send(msg);
      } catch {
        this.clients.delete(ws);
      }
    }
  }
}
