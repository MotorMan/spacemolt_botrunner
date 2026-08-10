import { readFileSync, existsSync } from "fs";
import { join } from "path";
import os from "os";
import type { ServerWebSocket } from "bun";
import { getBot, getDiscoveredBots, getBotStatuses } from "../botmanager.js";
import type { BotStatus, Bot } from "../bot.js";
import type { ApiResponse } from "../commandBridge.js";
import {
  loadStationConfig,
  saveStationConfig,
  loadSnapshots,
  saveSnapshots,
  clampInterval,
  clampCardCols,
  clampFpsCap,
  MIN_POLL_INTERVAL_SEC,
  type StationConfig,
  type StationRow,
  type StationSnapshot,
  type StationSnapshots,
  type FuelCraftStatus,
} from "./stationMonitorStore.js";

const GET_BASE_TIMEOUT_MS = 25_000;

/**
 * Every fuel recipe funnels its output straight into the station's fuel supply
 * as `fuel_reserve`, so matching on the produced item (instead of a recipe id)
 * automatically covers new fuel recipes and other players' recipe choices.
 */
const FUEL_RESERVE_ITEM = "fuel_reserve";
const ACTIVE_JOB_STATUSES = new Set(["active", "running", "in_progress", "in-progress", "crafting", "started"]);
const FINISHED_JOB_STATUSES = new Set(["complete", "completed", "done", "finished", "cancelled", "canceled", "failed", "error"]);

type WSData = { id: number };

interface SlimMat {
  item_id: string;
  quantity: number;
  name: string;
}

interface SlimFacility {
  id: string;
  name: string;
  category: string;
  level: number;
  description: string;
  build_cost: number;
  build_materials: SlimMat[];
  maintenance_inputs: SlimMat[];
  player_station_buildable: boolean;
  upgrades_from: string | null;
  power_draw: number;
  life_support_draw: number;
  recipe_id: string | null;
  service_type: string | null;
  faction_service_type: string | null;
  station_or_faction_only: boolean;
}

export interface StationView {
  id: string;
  bot: string;
  stationId: string;
  stationName: string;
  label: string;
  state: string;
  faction: string | null;
  base: Record<string, unknown> | null;
  condition: Record<string, unknown> | null;
  lifeSupport: Record<string, unknown> | null;
  power: Record<string, unknown> | null;
  factionFuelReserve: number;
  factionFuelCapacity: number;
  fuelCraft: FuelCraftStatus | null;
  lastError: string | null;
  lastErrorAt: number | null;
  /** FetchedAt of the last successful get_base (last good snapshot). */
  fetchedAt: number | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && isFinite(v) ? v : fallback;
}

/** True when a craft job outputs `fuel_reserve` (i.e. it refills station fuel). */
function jobMakesFuel(job: Record<string, unknown>): boolean {
  const outputs = [
    ...(Array.isArray(job.produces) ? (job.produces as Record<string, unknown>[]) : []),
    ...(Array.isArray(job.outputs) ? (job.outputs as Record<string, unknown>[]) : []),
  ];
  return outputs.some(
    (o) => o && typeof o === "object" && String(o.item_id ?? "").toLowerCase() === FUEL_RESERVE_ITEM,
  );
}

/** fuel_reserve produced per run by this job (0 when the job makes something else). */
function fuelPerRun(job: Record<string, unknown>): number {
  const outputs = [
    ...(Array.isArray(job.produces) ? (job.produces as Record<string, unknown>[]) : []),
    ...(Array.isArray(job.outputs) ? (job.outputs as Record<string, unknown>[]) : []),
  ];
  for (const o of outputs) {
    if (o && typeof o === "object" && String(o.item_id ?? "").toLowerCase() === FUEL_RESERVE_ITEM) {
      return num(o.quantity, 0);
    }
  }
  return 0;
}

/**
 * A station's craft queue is read through its own docked drone, so jobs are
 * already station-scoped. We still match on base_id/base_name when the payload
 * carries them, so a drone that queued work elsewhere can't produce a false
 * "fuel is flowing" reading. Jobs without any base info are trusted.
 */
function jobBelongsToStation(job: Record<string, unknown>, stationId: string, stationName: string): boolean {
  const baseId = typeof job.base_id === "string" ? job.base_id : "";
  const baseName = typeof job.base_name === "string" ? job.base_name : "";
  if (!baseId && !baseName) return true;
  if (baseId && stationId && baseId === stationId) return true;
  if (baseName && stationName && baseName.toLowerCase() === stationName.toLowerCase()) return true;
  return false;
}

export class StationWebServer {
  private port: number;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private clients = new Set<ServerWebSocket<WSData>>();
  private nextClientId = 1;

  private config: StationConfig;
  private snapshots: StationSnapshots;
  private views: Record<string, StationView> = {};

  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;

  private snapDirty = false;
  private snapTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(port: number = 5000) {
    this.port = port;
    this.config = loadStationConfig();
    this.snapshots = loadSnapshots();
  }

  start(): void {
    const indexPath = join(import.meta.dir, "station.html");
    const cssPath = join(import.meta.dir, "station.css");

    try {
      this.server = Bun.serve<WSData>({
        hostname: "0.0.0.0",
        port: this.port,
        fetch: async (req) => {
          const url = new URL(req.url);

          const corsHeaders = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          };

          if (req.method === "OPTIONS") {
            return new Response(null, { headers: corsHeaders });
          }

          if (url.pathname === "/ws") {
            const id = this.nextClientId++;
            const ok = this.server!.upgrade(req, { data: { id } });
            if (ok) return undefined as unknown as Response;
            return new Response("WebSocket upgrade failed", { status: 400 });
          }

          if (url.pathname === "/api/bots" && req.method === "GET") {
            return Response.json({ bots: getDiscoveredBots() }, { headers: corsHeaders });
          }

          if (url.pathname === "/api/config" && req.method === "GET") {
            return Response.json(this.config, { headers: corsHeaders });
          }

          if (url.pathname === "/api/config" && req.method === "POST") {
            return this.handleConfigPost(req, corsHeaders);
          }

          if (url.pathname === "/api/detect" && req.method === "POST") {
            return this.handleDetect(req, corsHeaders);
          }

          if (url.pathname === "/api/stations" && req.method === "GET") {
            return Response.json({ stations: this.getStations() }, { headers: corsHeaders });
          }

          if (url.pathname.startsWith("/api/station/")) {
            let stationId = decodeURIComponent(url.pathname.slice("/api/station/".length));
            if (req.method === "GET") return this.handleStationGet(stationId, corsHeaders);
            if (req.method === "POST") {
              stationId = stationId.replace(/\/action$/, "");
              return this.handleStationAction(stationId, req, corsHeaders);
            }
          }

          if (url.pathname === "/api/catalog/facilities" && req.method === "GET") {
            return this.handleCatalogFacilities(url, corsHeaders);
          }

          if (url.pathname.startsWith("/api/catalog/facility/") && req.method === "GET") {
            const fid = decodeURIComponent(url.pathname.slice("/api/catalog/facility/".length));
            const fac = this.loadCatalog().facilities.find((f) => f.id === fid) || null;
            return Response.json({ facility: fac }, { headers: corsHeaders });
          }

          if (url.pathname === "/api/refresh" && req.method === "POST") {
            this.triggerSweep();
            return Response.json({ ok: true }, { headers: corsHeaders });
          }

          if (url.pathname === "/station.css") {
            if (existsSync(cssPath)) {
              return new Response(readFileSync(cssPath, "utf-8"), {
                headers: {
                  "Content-Type": "text/css; charset=utf-8",
                  "Cache-Control": "no-store",
                  ...corsHeaders,
                },
              });
            }
            return new Response("Not found", { status: 404, headers: corsHeaders });
          }

          // Detail route + SPA fallback both serve the single page.
          if (url.pathname.startsWith("/station/") || url.pathname === "/" || url.pathname === "") {
            if (existsSync(indexPath)) {
              return new Response(readFileSync(indexPath, "utf-8"), {
                headers: {
                  "Content-Type": "text/html; charset=utf-8",
                  "Cache-Control": "no-store",
                  ...corsHeaders,
                },
              });
            }
            return new Response("Station UI not found", { status: 404, headers: corsHeaders });
          }

          return new Response("Not found", { status: 404, headers: corsHeaders });
        },
        websocket: {
          open: (ws: ServerWebSocket<WSData>) => {
            this.clients.add(ws);
            this.sendInit(ws);
          },
          message: (_ws: ServerWebSocket<WSData>, msg: string | Buffer) => {
            try {
              const raw = JSON.parse(typeof msg === "string" ? msg : msg.toString());
              if (raw.type === "ping") {
                _ws.send(JSON.stringify({ type: "pong" }));
              }
            } catch {
              // ignore malformed messages
            }
          },
          close: (ws: ServerWebSocket<WSData>) => {
            this.clients.delete(ws);
          },
        },
      });
    } catch (err) {
      console.error(
        `[StationServer] FAILED to start on port ${this.port} (set STATION_PORT to override). ` +
          `The rest of the botrunner is unaffected. Error:`,
        err instanceof Error ? err.message : err,
      );
      return;
    }

    const lanIp = this.getLocalIp() || "localhost";
    console.log(`Station UI: http://localhost:${this.port}`);
    console.log(`Station UI (LAN): http://${lanIp}:${this.port}`);

    this.startPoller();
  }

  stop(): void {
    this.pollInterval && clearInterval(this.pollInterval);
    this.pollInterval = null;
    this.snapTimer && clearTimeout(this.snapTimer);
    this.snapTimer = null;
    this.flushSnapshots();
    this.server?.stop();
    this.server = null;
  }

  broadcast(data: unknown): void {
    const msg = JSON.stringify(data);
    for (const ws of this.clients) {
      try {
        ws.send(msg);
      } catch {
        this.clients.delete(ws);
      }
    }
  }

  private sendInit(ws: ServerWebSocket<WSData>): void {
    try {
      ws.send(JSON.stringify({ type: "init", config: this.config, stations: this.getStations() }));
    } catch {
      // ignore
    }
  }

  // ── Config ────────────────────────────────────────────────

  private async handleConfigPost(req: Request, corsHeaders: Record<string, string>): Promise<Response> {
    try {
      const body = (await req.json()) as Partial<StationConfig>;
      if (body.pollIntervalSec != null) {
        this.config.pollIntervalSec = clampInterval(body.pollIntervalSec);
      }
      if (body.cardCols != null) {
        this.config.cardCols = clampCardCols(body.cardCols);
      }
      if (body.fpsCap != null) {
        this.config.fpsCap = clampFpsCap(body.fpsCap);
      }
      if (Array.isArray(body.rows)) {
        const seen = new Set<string>();
        this.config.rows = (body.rows as StationRow[]).map((raw) => {
          const row: StationRow = {
            id: typeof raw.id === "string" && raw.id ? raw.id : `row_${crypto.randomUUID()}`,
            bot: typeof raw.bot === "string" ? raw.bot : "",
            stationId: typeof raw.stationId === "string" ? raw.stationId : "",
            stationName: typeof raw.stationName === "string" ? raw.stationName : "",
            label: typeof raw.label === "string" ? raw.label : "",
          };
          // Drop duplicate ids (defensive).
          if (seen.has(row.id)) row.id = `row_${crypto.randomUUID()}`;
          seen.add(row.id);
          return row;
        });
        // Drop snapshots for rows that no longer exist.
        const liveIds = new Set(this.config.rows.map((r) => r.id));
        for (const id of Object.keys(this.snapshots)) {
          if (!liveIds.has(id)) delete this.snapshots[id];
        }
      }
      saveStationConfig(this.config);
      this.flushSnapshots();
      this.startPoller();
      this.broadcast({ type: "config", config: this.config });
      this.triggerSweep();
      return Response.json(this.config, { headers: corsHeaders });
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 400, headers: corsHeaders },
      );
    }
  }

  private async handleDetect(req: Request, corsHeaders: Record<string, string>): Promise<Response> {
    try {
      const body = (await req.json()) as { bot?: string };
      const botName = body.bot || "";
      const botInstance = getBot(botName);
      if (!botInstance) {
        return Response.json({ error: `Bot ${botName} not found` }, { status: 404, headers: corsHeaders });
      }
      const resp = await this.getBase(botInstance);
      if (resp.error) {
        return Response.json(
          { error: resp.error.message || "get_base failed" },
          { status: 500, headers: corsHeaders },
        );
      }
      const r = (resp.result ?? {}) as Record<string, unknown>;
      const base = (r.base as Record<string, unknown>) ?? r;
      const stationId = (base.id as string) || (base.poi_id as string) || "";
      const stationName = (base.name as string) || "";
      return Response.json({ stationId, stationName }, { headers: corsHeaders });
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 500, headers: corsHeaders },
      );
    }
  }

  private handleStationGet(stationId: string, corsHeaders: Record<string, string>): Response {
    const row = this.config.rows.find((r) => r.stationId === stationId);
    const snap = row ? this.snapshots[row.id] : undefined;
    if (!snap) {
      return Response.json({ error: "No snapshot for station", stationId }, { status: 404, headers: corsHeaders });
    }
    return Response.json({ stationId, snapshot: snap }, { headers: corsHeaders });
  }

  // Generic action proxy: runs a game-server command on the bot assigned to the
  // station row. Powers all station/facility mutations + reads (rename, market
  // fee, refuel/repair prices, public, auto-buy, build policy, facility
  // build/toggle/repair/upgrade/rename, and facility list queries).
  private async handleStationAction(
    stationId: string,
    req: Request,
    corsHeaders: Record<string, string>,
  ): Promise<Response> {
    try {
      const row = this.config.rows.find((r) => r.stationId === stationId);
      if (!row) {
        return Response.json({ ok: false, error: "Station not configured" }, { status: 404, headers: corsHeaders });
      }
      const botInstance = getBot(row.bot);
      if (!botInstance) {
        return Response.json({ ok: false, error: `Bot ${row.bot} not found` }, { status: 404, headers: corsHeaders });
      }
      const body = (await req.json()) as { command?: string; params?: Record<string, unknown> };
      if (!body.command) {
        return Response.json({ ok: false, error: "command required" }, { status: 400, headers: corsHeaders });
      }
      const resp = await this.execBot(botInstance, body.command, body.params || {});
      return Response.json(resp, { headers: corsHeaders });
    } catch (err) {
      return Response.json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        { status: 500, headers: corsHeaders },
      );
    }
  }

  private async execBot(
    botInstance: Bot,
    command: string,
    params: Record<string, unknown>,
  ): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    const apiPromise = botInstance.exec(command, params);
    const timeoutPromise = new Promise<ApiResponse>((resolve) =>
      setTimeout(
        () => resolve({ error: { code: "timeout", message: `${command} timed out` } }),
        GET_BASE_TIMEOUT_MS,
      ),
    );
    const resp = await Promise.race([apiPromise, timeoutPromise]);
    if (resp.error) return { ok: false, error: resp.error.message, data: resp.result };
    return { ok: true, data: resp.result };
  }

  // Slimmed catalog facility list (avoids shipping the 5MB raw catalog).
  private catalogCache: { facilities: SlimFacility[] } | null = null;

  private loadCatalog(): { facilities: SlimFacility[] } {
    if (this.catalogCache) return this.catalogCache;
    let facilities: SlimFacility[] = [];
    try {
      const path = join(process.cwd(), "data", "catalog.json");
      if (existsSync(path)) {
        const raw = JSON.parse(readFileSync(path, "utf-8")) as { facilities?: Record<string, Record<string, unknown>> };
        const facs = raw.facilities || {};
        facilities = Object.values(facs).map((f) => ({
          id: (f.id as string) || "",
          name: (f.name as string) || "",
          category: (f.category as string) || "",
          level: (f.level as number) ?? 0,
          description: (f.description as string) || "",
          build_cost: (f.build_cost as number) ?? 0,
          build_materials: Array.isArray(f.build_materials)
            ? (f.build_materials as Record<string, unknown>[]).map((m) => ({
                item_id: (m.item_id as string) || "",
                quantity: (m.quantity as number) ?? 1,
                name: (m.name as string) || "",
              }))
            : [],
          maintenance_inputs: Array.isArray(f.maintenance_inputs)
            ? (f.maintenance_inputs as Record<string, unknown>[]).map((m) => ({
                item_id: (m.item_id as string) || "",
                quantity: (m.quantity as number) ?? 1,
                name: (m.name as string) || "",
              }))
            : [],
          player_station_buildable: !!f.player_station_buildable,
          upgrades_from: (f.upgrades_from as string) || null,
          power_draw: (f.power_draw as number) ?? 0,
          life_support_draw: (f.life_support_draw as number) ?? 0,
          recipe_id: (f.recipe_id as string) || null,
          service_type: (f.service_type as string) || null,
          faction_service_type: (f.faction_service_type as string) || null,
          station_or_faction_only: !!f.station_or_faction_only,
        }));
      }
    } catch {
      facilities = [];
    }
    this.catalogCache = { facilities };
    return this.catalogCache;
  }

  private handleCatalogFacilities(url: URL, corsHeaders: Record<string, string>): Response {
    const cat = url.searchParams.get("category");
    const q = (url.searchParams.get("q") || "").toLowerCase();
    let list = this.loadCatalog().facilities;
    if (cat) list = list.filter((f) => f.category === cat);
    if (q) {
      list = list.filter(
        (f) => (f.name || "").toLowerCase().includes(q) || (f.id || "").toLowerCase().includes(q),
      );
    }
    const limited = list.slice(0, 400);
    return Response.json({ count: list.length, facilities: limited }, { headers: corsHeaders });
  }

  // ── Poller ────────────────────────────────────────────────

  private startPoller(): void {
    if (this.pollInterval) clearInterval(this.pollInterval);
    const ms = Math.max(MIN_POLL_INTERVAL_SEC, this.config.pollIntervalSec) * 1000;
    this.pollInterval = setInterval(() => this.triggerSweep(), ms);
    // Kick off an initial sweep shortly after start / config change.
    setTimeout(() => this.triggerSweep(), 800);
  }

  private triggerSweep(): void {
    void this.runSweep().catch((err) => {
      console.error("[StationServer] sweep error:", err);
    });
  }

  private async runSweep(): Promise<void> {
    if (this.sweeping) return; // guard against overlapping sweeps
    this.sweeping = true;
    try {
      const rows = this.config.rows;
      const statusMap = new Map<string, BotStatus>();
      for (const s of getBotStatuses()) statusMap.set(s.username, s);
      const stepMs = rows.length > 0 ? (this.config.pollIntervalSec * 1000) / rows.length : 0;
      const freshViews: Record<string, StationView> = {};
      // One craft-queue read per bot per sweep, shared across its rows.
      const queueCache = new Map<string, Record<string, unknown>[] | null>();
      for (const row of rows) {
        const view = await this.readRow(row, statusMap, queueCache);
        freshViews[row.id] = view;
        this.broadcast({ type: "station", station: view });
        await sleep(stepMs);
      }
      this.views = freshViews;
      this.broadcast({ type: "stations", stations: this.getStations() });
    } finally {
      this.sweeping = false;
    }
  }

  private async readRow(
    row: StationRow,
    statusMap: Map<string, BotStatus>,
    queueCache: Map<string, Record<string, unknown>[] | null>,
  ): Promise<StationView> {
    const id = row.id;
    const prev = this.views[id];
    const lastGood = this.snapshots[id];
    const status = statusMap.get(row.bot);
    const faction = status?.faction ?? lastGood?.faction ?? null;

    let state = "OK";
    let lastError: string | null = prev?.lastError ?? null;
    let lastErrorAt: number | null = prev?.lastErrorAt ?? null;

    const baseEmpty = (): Record<string, unknown> | null => prev?.base ?? null;

    if (!row.bot) {
      state = "UNCONFIGURED";
    } else if (!getBot(row.bot)) {
      state = "NO_BOT";
    } else if (!status || status.docked === false) {
      state = "UNDOCKED";
    } else if (!row.stationId) {
      state = "UNCONFIGURED";
    } else {
      try {
        const botInstance = getBot(row.bot)!;
        const resp = await this.getBase(botInstance);
        if (resp.error) {
          lastError = resp.error.message || "get_base error";
          lastErrorAt = Date.now();
          // keep previous good snapshot; fall through to staleness check
        } else {
          const r = (resp.result ?? {}) as Record<string, unknown>;
          const base = (r.base as Record<string, unknown>) ?? {};
          const baseId = (base.id as string) || (base.poi_id as string) || "";
          if (baseId && row.stationId && baseId !== row.stationId) {
            state = "MISMATCH";
          }
          const condition = (r.condition as Record<string, unknown>) ?? {};
          const lifeSupport = (r.life_support as Record<string, unknown>) ?? {};
          const power = (r.power as Record<string, unknown>) ?? {};
          const wrecked = !!base.wrecked;
          const fetchedAt = Date.now();
          const name =
            (base.name as string) ||
            row.stationName ||
            (base.poi_id as string) ||
            row.stationId;
          // Fuel production check: any queued/running craft job that outputs
          // `fuel_reserve` at this station.
          const jobs = await this.readCraftQueue(botInstance, row.bot, queueCache);
          const fuelCraft = this.summarizeFuelCraft(jobs, row.stationId, name);
          const snapshot: StationSnapshot = {
            stationId: row.stationId,
            stationName: name,
            fetchedAt,
            base,
            condition,
            lifeSupport,
            power,
            factionFuelReserve: num(r.faction_fuel_reserve),
            factionFuelCapacity: num(r.faction_fuel_capacity),
            faction: status?.faction ?? null,
            wrecked,
            fuelCraft,
          };
          this.snapshots[id] = snapshot;
          this.markSnapshotsDirty();

          const view: StationView = {
            id,
            bot: row.bot,
            stationId: row.stationId,
            stationName: name,
            label: row.label,
            state,
            faction: snapshot.faction,
            base,
            condition,
            lifeSupport,
            power,
            factionFuelReserve: snapshot.factionFuelReserve,
            factionFuelCapacity: snapshot.factionFuelCapacity,
            fuelCraft,
            lastError: null,
            lastErrorAt: null,
            fetchedAt,
          };
          return view;
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        lastErrorAt = Date.now();
        // keep previous good snapshot; fall through
      }
    }

    // No fresh read (error/undocked/no-bot/unconfigured). Derive staleness from
    // the last good snapshot timestamp and assemble a view from whatever we have.
    const fetchedAt = lastGood?.fetchedAt ?? null;
    const staleThreshold = Math.max(MIN_POLL_INTERVAL_SEC, this.config.pollIntervalSec) * 3 * 1000;
    if (state === "OK" && fetchedAt != null && Date.now() - fetchedAt > staleThreshold) {
      state = "STALE";
    }

    const view: StationView = {
      id,
      bot: row.bot,
      stationId: row.stationId,
      stationName: lastGood?.stationName || row.stationName || row.stationId,
      label: row.label,
      state,
      faction,
      base: lastGood?.base ?? baseEmpty(),
      condition: lastGood?.condition ?? null,
      lifeSupport: lastGood?.lifeSupport ?? null,
      power: lastGood?.power ?? null,
      factionFuelReserve: lastGood?.factionFuelReserve ?? 0,
      factionFuelCapacity: lastGood?.factionFuelCapacity ?? 0,
      // No fresh queue read this pass — carry the last known status forward
      // rather than reporting a fuel outage we did not actually observe.
      fuelCraft: prev?.fuelCraft ?? lastGood?.fuelCraft ?? null,
      lastError,
      lastErrorAt,
      fetchedAt,
    };
    return view;
  }

  private async getBase(botInstance: Bot): Promise<ApiResponse> {
    const apiPromise = botInstance.exec("get_base", {});
    const timeoutPromise = new Promise<ApiResponse>((resolve) =>
      setTimeout(
        () => resolve({ error: { code: "timeout", message: "get_base timed out" } }),
        GET_BASE_TIMEOUT_MS,
      ),
    );
    return Promise.race([apiPromise, timeoutPromise]);
  }

  /**
   * Read a bot's whole craft queue once per sweep. Results are cached by bot
   * name so two rows sharing a drone only cost one call. `null` means the queue
   * could not be read (treated as "unknown", never as "no fuel").
   */
  private async readCraftQueue(
    botInstance: Bot,
    botName: string,
    cache: Map<string, Record<string, unknown>[] | null>,
  ): Promise<Record<string, unknown>[] | null> {
    if (cache.has(botName)) return cache.get(botName) ?? null;
    let jobs: Record<string, unknown>[] | null = null;
    try {
      const resp = await this.execBot(botInstance, "craft", { action: "queue" });
      if (resp.ok) {
        const data = (resp.data ?? {}) as Record<string, unknown>;
        const root =
          (data.structuredContent as Record<string, unknown>) ??
          (data.details as Record<string, unknown>) ??
          data;
        const raw = Array.isArray(root?.jobs)
          ? (root.jobs as unknown[])
          : Array.isArray(data.jobs)
            ? (data.jobs as unknown[])
            : null;
        // An empty/absent `jobs` array on a successful call legitimately means
        // "nothing queued" — only a failed call stays unknown.
        jobs = (raw ?? []).filter(
          (j): j is Record<string, unknown> => !!j && typeof j === "object",
        );
      }
    } catch {
      jobs = null;
    }
    cache.set(botName, jobs);
    return jobs;
  }

  /** Collapse a craft queue into this station's fuel-production status. */
  private summarizeFuelCraft(
    jobs: Record<string, unknown>[] | null,
    stationId: string,
    stationName: string,
  ): FuelCraftStatus {
    const checkedAt = Date.now();
    if (!jobs) {
      return {
        state: "unknown",
        activeJobs: 0,
        queuedJobs: 0,
        runsRemaining: 0,
        unitsRemaining: 0,
        etaTicks: null,
        recipe: null,
        checkedAt,
      };
    }

    let activeJobs = 0;
    let queuedJobs = 0;
    let runsRemaining = 0;
    let unitsRemaining = 0;
    let etaTicks: number | null = null;
    let activeRecipe: string | null = null;
    let anyRecipe: string | null = null;

    for (const job of jobs) {
      if (!jobMakesFuel(job)) continue;
      if (!jobBelongsToStation(job, stationId, stationName)) continue;
      const status = String(job.status ?? "").toLowerCase();
      if (FINISHED_JOB_STATUSES.has(status)) continue;

      const runs = num(job.runs_remaining, 0);
      runsRemaining += runs;
      unitsRemaining += runs * fuelPerRun(job);
      const recipe = typeof job.recipe === "string" ? job.recipe : null;
      if (!anyRecipe) anyRecipe = recipe;

      // Anything not explicitly finished and not explicitly running still
      // represents pending fuel, so it counts as queued.
      if (ACTIVE_JOB_STATUSES.has(status) || (!status && num(job.progress, 0) > 0)) {
        activeJobs++;
        if (!activeRecipe) activeRecipe = recipe;
        if (etaTicks == null && job.eta_ticks != null) etaTicks = num(job.eta_ticks, 0);
      } else {
        queuedJobs++;
      }
    }

    const state: FuelCraftStatus["state"] =
      activeJobs > 0 ? "active" : queuedJobs > 0 ? "queued" : "none";

    return {
      state,
      activeJobs,
      queuedJobs,
      runsRemaining,
      unitsRemaining,
      etaTicks,
      recipe: activeRecipe ?? anyRecipe,
      checkedAt,
    };
  }

  /** Merged view: config rows + latest snapshot + derived state, in config order. */
  getStations(): StationView[] {
    return this.config.rows.map((row) => {
      const live = this.views[row.id];
      if (live) return live;
      const status = getBot(row.bot) ? "OK" : row.bot ? "NO_BOT" : "UNCONFIGURED";
      const snap = this.snapshots[row.id];
      return {
        id: row.id,
        bot: row.bot,
        stationId: row.stationId,
        stationName: snap?.stationName || row.stationName || row.stationId,
        label: row.label,
        state: row.stationId ? status : "UNCONFIGURED",
        faction: snap?.faction ?? null,
        base: snap?.base ?? null,
        condition: snap?.condition ?? null,
        lifeSupport: snap?.lifeSupport ?? null,
        power: snap?.power ?? null,
        factionFuelReserve: snap?.factionFuelReserve ?? 0,
        factionFuelCapacity: snap?.factionFuelCapacity ?? 0,
        fuelCraft: snap?.fuelCraft ?? null,
        lastError: null,
        lastErrorAt: null,
        fetchedAt: snap?.fetchedAt ?? null,
      } as StationView;
    });
  }

  // ── Snapshot persistence (debounced) ──────────────────────

  private markSnapshotsDirty(): void {
    this.snapDirty = true;
    if (this.snapTimer) return;
    this.snapTimer = setTimeout(() => {
      this.snapTimer = null;
      if (this.snapDirty) {
        this.flushSnapshots();
      }
    }, 30_000);
  }

  private flushSnapshots(): void {
    if (!this.snapDirty) return;
    saveSnapshots(this.snapshots);
    this.snapDirty = false;
  }

  // ── Misc ──────────────────────────────────────────────────

  private getLocalIp(): string | null {
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
}
