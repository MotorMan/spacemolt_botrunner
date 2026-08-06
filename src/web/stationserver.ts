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
  MIN_POLL_INTERVAL_SEC,
  type StationConfig,
  type StationRow,
  type StationSnapshot,
  type StationSnapshots,
} from "./stationMonitorStore.js";

const GET_BASE_TIMEOUT_MS = 25_000;

type WSData = { id: number };

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

          if (url.pathname.startsWith("/api/station/") && req.method === "GET") {
            const stationId = decodeURIComponent(url.pathname.slice("/api/station/".length));
            return this.handleStationGet(stationId, corsHeaders);
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
      for (const row of rows) {
        const view = await this.readRow(row, statusMap);
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

  private async readRow(row: StationRow, statusMap: Map<string, BotStatus>): Promise<StationView> {
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
