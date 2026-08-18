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
  clampAmmoLow,
  clampConsumableDays,
  clampSupplyRefreshMin,
  evaluateSupplies,
  MIN_POLL_INTERVAL_SEC,
  type StationConfig,
  type StationRow,
  type StationSnapshot,
  type StationSnapshots,
  type FuelCraftStatus,
  type SupplyFacility,
  type SupplyStock,
  type SupplyStatus,
  type StationBattleLog,
  type StationBattleLogEntry,
  loadBattleLog,
  saveBattleLog,
} from "./stationMonitorStore.js";
import { getFactionStorageCache } from "../factionStorageCache.js";
import { getStationFacilityCache } from "../stationFacilityCache.js";

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
  /** Item a station gun feeds from. Present only on armed defense facilities. */
  ammo_item: string | null;
}

/** A station facility normalized down to just what supply tracking needs. */
interface FacilityRec {
  id: string;
  name: string;
  type: string;
  active: boolean;
  /** Per-cycle maintenance draw, from the live record when it exposes one. */
  maintenance: SlimMat[];
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
  /** Gun-ammo + facility-maintenance stock state (drives the yellow/red card tiers). */
  supplies: SupplyStatus | null;
  /** True when the station's docked drone reports an active battle involving this station. */
  combatAlert: boolean;
  /** Battle id of the active (or most recent) combat alert. */
  battleId: string | null;
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
  private battleLog: StationBattleLog;
  private views: Record<string, StationView> = {};

  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;

  private snapDirty = false;
  private snapTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(port: number = 5000) {
    this.port = port;
    this.config = loadStationConfig();
    this.snapshots = loadSnapshots();
    this.battleLog = loadBattleLog();
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
            // Reviewable combat/battle log for a station row.
            if (stationId.endsWith("/battles") && req.method === "GET") {
              const sid = stationId.replace(/\/battles$/, "");
              const row = this.config.rows.find((r) => r.stationId === sid);
              const battles = row ? (this.battleLog[row.id] ?? []) : [];
              return Response.json({ stationId: sid, battles }, { headers: corsHeaders });
            }
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
      if (body.ammoLowThreshold != null) {
        this.config.ammoLowThreshold = clampAmmoLow(body.ammoLowThreshold);
      }
      if (body.consumableLowDays != null) {
        this.config.consumableLowDays = clampConsumableDays(body.consumableLowDays);
      }
      if (body.supplyRefreshMin != null) {
        this.config.supplyRefreshMin = clampSupplyRefreshMin(body.supplyRefreshMin);
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
  private catalogCache: {
    facilities: SlimFacility[];
    byId: Record<string, SlimFacility>;
    itemNames: Record<string, string>;
  } | null = null;

  private loadCatalog(): {
    facilities: SlimFacility[];
    byId: Record<string, SlimFacility>;
    itemNames: Record<string, string>;
  } {
    if (this.catalogCache) return this.catalogCache;
    let facilities: SlimFacility[] = [];
    const itemNames: Record<string, string> = {};
    try {
      const path = join(process.cwd(), "data", "catalog.json");
      if (existsSync(path)) {
        const raw = JSON.parse(readFileSync(path, "utf-8")) as {
          facilities?: Record<string, Record<string, unknown>>;
          items?: Record<string, Record<string, unknown>>;
        };
        const facs = raw.facilities || {};
        for (const [id, it] of Object.entries(raw.items || {})) {
          const nm = it && typeof it === "object" ? (it.name as string) : "";
          if (nm) itemNames[id] = nm;
        }
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
          ammo_item: (f.ammo_item as string) || null,
        }));
      }
    } catch {
      facilities = [];
    }
    const byId: Record<string, SlimFacility> = {};
    for (const f of facilities) if (f.id) byId[f.id] = f;
    this.catalogCache = { facilities, byId, itemNames };
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

  /**
   * Evaluate the station's combat state from its docked drone's passive battle
   * detection (`Bot.currentBattle`, fed by the `battle_alert`/`battle_started`/
   * `battle_update`/`battle_ended` WebSocket events). Returns whether the station
   * is under attack (and the active battle id), and maintains the persistent
   * battle log so the user can review engagements later and we know when a
   * battle has ended (to clear the alert).
   *
   * The `battle_alert` event only sets `currentBattle` while the drone is docked
   * at a station in the battle's system, so `inBattle && docked` already means
   * "this station's location is under attack". We additionally scan the
   * participants for our station (by id/name, or a `kind: "station"` flag when
   * present) and record every participant name for later review — the exact way
   * a station shows up in the participant list is still being learned, so we
   * match leniently and log the raw data.
   */
  private evaluateCombat(
    row: StationRow,
    bot: Bot | null | undefined,
    status: BotStatus | undefined,
  ): { combatAlert: boolean; battleId: string | null; stationInvolved: boolean } {
    const cb = bot?.currentBattle;
    const battleId = (cb?.battleId as string | null) ?? null;
    // NOTE: `currentBattle.inBattle` is set by the bot's `battle_alert` handler for
    // ANY battle in the drone's system while docked — it does NOT mean our station
    // (or the drone) is involved. A player farming creatures elsewhere in-system
    // trips it. The real signal is whether our station (or the docked drone) is an
    // actual participant of the battle, so we gate on that, not on `inBattle`.
    const participantsRaw = Array.isArray(cb?.participants)
      ? (cb!.participants as Array<Record<string, unknown>>)
      : [];
    const participants = participantsRaw
      .map((p) => String(p.username || p.player_id || p.ship_name || p.name || ""))
      .filter(Boolean);
    const stationInvolved = this.stationIsParticipant(row, participantsRaw);
    // The docked drone being a participant only counts as "station under attack"
    // if it is still docked here — otherwise it flew off to fight somewhere else.
    const docked = !!status?.docked;
    const droneInvolved = docked && this.droneIsParticipant(bot, participantsRaw);
    const involved = stationInvolved || droneInvolved;
    const combatAlert = involved && !!battleId;

    const entries = (this.battleLog[row.id] = this.battleLog[row.id] ?? []);
    const open = entries.find((e) => e.endedAt === null);

    if (combatAlert) {
      if (!open) {
        entries.push({
          battleId,
          startedAt: Date.now(),
          endedAt: null,
          outcome: "active",
          participants,
          stationInvolved,
          droneInvolved,
        });
        this.flushBattleLog();
      } else if (open.battleId !== battleId) {
        // A new battle started before the previous one was formally closed.
        open.endedAt = Date.now();
        open.outcome = "superseded";
        entries.push({
          battleId,
          startedAt: Date.now(),
          endedAt: null,
          outcome: "active",
          participants,
          stationInvolved,
          droneInvolved,
        });
        this.flushBattleLog();
      } else {
        let changed = false;
        for (const p of participants) {
          if (!open.participants.includes(p)) {
            open.participants.push(p);
            changed = true;
          }
        }
        if (stationInvolved && !open.stationInvolved) {
          open.stationInvolved = true;
          changed = true;
        }
        if (droneInvolved && !open.droneInvolved) {
          open.droneInvolved = true;
          changed = true;
        }
        if (changed) this.flushBattleLog();
      }
    } else if (open) {
      open.endedAt = Date.now();
      if (open.outcome === "active") open.outcome = "ended";
      this.flushBattleLog();
    }

    return { combatAlert, battleId, stationInvolved };
  }

  /** True when the docked drone's own ship is a participant (someone pulled our
   *  ship into the battle while it was docked at the station). */
  private droneIsParticipant(
    bot: Bot | null | undefined,
    participants: Array<Record<string, unknown>>,
  ): boolean {
    const me = (bot?.username || "").toLowerCase();
    if (!me) return false;
    return participants.some((p) => {
      const uname = String(p.username || "").toLowerCase();
      const pid = String(p.player_id || "").toLowerCase();
      const sname = String(p.ship_name || "").toLowerCase();
      return uname === me || pid === me || sname === me;
    });
  }

  /** Leniently check whether the station itself is among the battle participants. */
  private stationIsParticipant(
    row: StationRow,
    participants: Array<Record<string, unknown>>,
  ): boolean {
    const sid = (row.stationId || "").toLowerCase();
    const sname = (row.stationName || "").toLowerCase();
    const match = (p: Record<string, unknown>): boolean => {
      const pid = String(p.player_id || "").toLowerCase();
      const uname = String(p.username || "").toLowerCase();
      const snameP = String(p.ship_name || "").toLowerCase();
      return !!(
        (sid && (pid === sid || uname === sid)) ||
        (sname && (uname === sname || snameP === sname))
      );
    };
    for (const p of participants) {
      const kind = String(p.kind || "").toLowerCase();
      if (kind === "station" && (match(p) || !sid)) return true;
      if (match(p)) return true;
    }
    return false;
  }

  private flushBattleLog(): void {
    saveBattleLog(this.battleLog);
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
    // Combat detection is independent of the get_base read below — evaluate it
    // up front from the drone's already-populated battle state.
    const botForBattle = row.bot ? getBot(row.bot) : null;
    const battle = this.evaluateCombat(row, botForBattle, status);

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
          // Gun ammo + facility maintenance stock (faction storage only).
          // Reaching this branch already means the drone is docked here, so a
          // faction-storage read is allowed.
          const supplies = await this.readSupplies(
            row,
            botInstance,
            true,
            prev?.supplies ?? lastGood?.supplies ?? null,
          );
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
            supplies,
            combatAlert: battle.combatAlert,
            battleId: battle.battleId,
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
            supplies,
            combatAlert: battle.combatAlert,
            battleId: battle.battleId,
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
      // Same for supplies: an undocked/offline drone can't read faction storage,
      // and inventing an "out of ammo" state there would be a false alarm.
      supplies: prev?.supplies ?? lastGood?.supplies ?? null,
      combatAlert: battle.combatAlert,
      battleId: battle.battleId,
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

  // ── Ammo / consumable supply tracking ─────────────────────
  //
  // Station guns feed from an ammo item and go silent the moment it hits zero;
  // service/infrastructure facilities withdraw their maintenance inputs once per
  // 1000-tick cycle and stop running when those run out. Both pools come from
  // the STATION'S FACTION STORAGE — the docked drone's cargo and personal
  // station storage are never touched by station facilities — so that is the
  // only stock we count.
  //
  // The numbers come from caches the rest of the botrunner already fills (the
  // shared faction-storage cache and the per-station facility list). The monitor
  // only issues a read of its own when a cache has gone staler than
  // `supplyRefreshMin`, which also refills those shared caches for the
  // dashboard's faction/station page.

  /** Our own facility reads, keyed by "system|poi". These include `station_facilities`. */
  private facilityReads = new Map<string, { facilities: FacilityRec[]; at: number }>();

  private static readonly ACTIVE_FACILITY_STATUSES = new Set([
    "active",
    "online",
    "running",
    "operational",
  ]);

  /**
   * A facility counts as active (and therefore as consuming) unless it is
   * explicitly under construction or reports a non-running status. `facility
   * list` payloads often omit any status at all, in which case a built facility
   * is running.
   */
  private facilityIsActive(f: Record<string, unknown>): boolean {
    if (f.under_construction === true) return false;
    if (typeof f.active === "boolean") return f.active;
    if (typeof f.status === "string" && f.status) {
      return StationWebServer.ACTIVE_FACILITY_STATUSES.has(f.status.toLowerCase());
    }
    return true;
  }

  private toFacilityRec(f: Record<string, unknown>): FacilityRec | null {
    if (!f || typeof f !== "object") return null;
    const id = String(f.facility_id ?? f.id ?? "");
    const type = String(f.facility_type ?? f.type ?? f.id ?? "");
    if (!id && !type) return null;
    // Prefer the live, level-adjusted per-cycle draw when the server reports it;
    // the catalog's `maintenance_inputs` is the level-1 fallback.
    const maintenance: SlimMat[] = Array.isArray(f.maintenance_per_cycle)
      ? (f.maintenance_per_cycle as Record<string, unknown>[])
          .filter((m) => m && typeof m === "object" && m.item_id)
          .map((m) => ({
            item_id: String(m.item_id),
            quantity: num(m.quantity, 1) || 1,
            name: typeof m.name === "string" ? m.name : "",
          }))
      : [];
    return {
      id: id || type,
      name: String(f.custom_name || f.name || type || id),
      type,
      active: this.facilityIsActive(f),
      maintenance,
    };
  }

  /**
   * The station's own + faction facilities. `player_facilities` (the drone's
   * personal builds) and `public_facilities` (other players') are deliberately
   * excluded: they are not fed from this station's faction storage.
   */
  private async readStationFacilities(
    botInstance: Bot,
    stationKey: string,
    ttlMs: number,
  ): Promise<{ facilities: FacilityRec[]; at: number | null }> {
    const own = this.facilityReads.get(stationKey);
    if (own && Date.now() - own.at <= ttlMs) {
      return { facilities: own.facilities, at: own.at };
    }

    const resp = await this.execBot(botInstance, "facility", { action: "list" });
    if (resp.ok) {
      const data = (resp.data ?? {}) as Record<string, unknown>;
      const root =
        (data.structuredContent as Record<string, unknown>) ??
        (data.result as Record<string, unknown>) ??
        data;
      const pick = (k: string): Record<string, unknown>[] =>
        Array.isArray(root?.[k]) ? (root[k] as Record<string, unknown>[]) : [];
      const merged = new Map<string, FacilityRec>();
      for (const raw of [...pick("station_facilities"), ...pick("faction_facilities")]) {
        const rec = this.toFacilityRec(raw);
        if (rec) merged.set(rec.id, rec);
      }
      const facilities = [...merged.values()];
      const entry = { facilities, at: Date.now() };
      this.facilityReads.set(stationKey, entry);
      return { facilities, at: entry.at };
    }

    // Read failed. Fall back to the shared cache any docked bot's `facility
    // list`/`faction_list` fills, then to our own last good read.
    const shared = getStationFacilityCache(stationKey);
    if (shared?.factionFacilities?.length) {
      const facilities = shared.factionFacilities
        .map((f) => this.toFacilityRec(f as unknown as Record<string, unknown>))
        .filter((f): f is FacilityRec => !!f);
      if (facilities.length) return { facilities, at: shared.lastUpdated || null };
    }
    if (own) return { facilities: own.facilities, at: own.at };
    return { facilities: [], at: null };
  }

  /**
   * Stock held in THIS station's faction storage. Other routines cache their
   * reads under the plain station/POI id while a docked read is keyed
   * "system|poi", so every alias is checked and the freshest one wins.
   */
  private async readFactionStock(
    botInstance: Bot,
    row: StationRow,
    docked: boolean,
    ttlMs: number,
  ): Promise<SupplyStock> {
    const faction = botInstance.faction || "unknown";
    const dockedKey = `${botInstance.system}|${botInstance.poi}`;
    const keys = [dockedKey, row.stationId, botInstance.poi].filter((k): k is string => !!k);

    const toStock = (
      entries: { itemId: string; quantity: number; name?: string }[],
    ): { stock: Map<string, number>; names: Map<string, string> } => {
      const stock = new Map<string, number>();
      const names = new Map<string, string>();
      for (const e of entries) {
        if (!e?.itemId) continue;
        stock.set(e.itemId, (stock.get(e.itemId) ?? 0) + num(e.quantity));
        if (e.name) names.set(e.itemId, e.name);
      }
      return { stock, names };
    };

    let best: { at: number; entries: { itemId: string; quantity: number; name?: string }[] } | null = null;
    for (const key of new Set(keys)) {
      const cached = getFactionStorageCache(faction, key);
      if (!cached?.entries) continue;
      const at = cached.lastUpdated || 0;
      if (!best || at > best.at) best = { at, entries: cached.entries };
    }

    const fresh = !!best && Date.now() - best.at <= ttlMs;
    if (!fresh && docked) {
      // Read the faction storage of the station we're docked at and refill the
      // shared cache for every other consumer. `updateFactionStorageCache` only
      // runs on success, so a bumped `lastUpdated` is our success signal — that
      // way a genuinely empty storage still reads as empty rather than falling
      // back to stale numbers.
      const startedAt = Date.now();
      try {
        await botInstance.refreshFactionStorage(true, undefined, true);
        const after = getFactionStorageCache(faction, dockedKey);
        if (after && (after.lastUpdated || 0) >= startedAt) {
          return { ...toStock(after.entries || []), at: after.lastUpdated, source: "live" };
        }
      } catch {
        // fall through to whatever cache we have
      }
    }

    if (best) return { ...toStock(best.entries), at: best.at, source: "cache" };
    return { stock: new Map(), names: new Map(), at: null, source: "none" };
  }

  /** Read + evaluate a station's ammo and maintenance stock. Never throws. */
  private async readSupplies(
    row: StationRow,
    botInstance: Bot,
    docked: boolean,
    prev: SupplyStatus | null,
  ): Promise<SupplyStatus | null> {
    try {
      const ttlMs = Math.max(1, this.config.supplyRefreshMin) * 60_000;
      const stationKey = `${botInstance.system}|${botInstance.poi}`;
      const facs = await this.readStationFacilities(botInstance, stationKey, ttlMs);
      const stock = await this.readFactionStock(botInstance, row, docked, ttlMs);
      return this.evaluateSupplies(facs.facilities, facs.at, stock);
    } catch (err) {
      // A supply hiccup must never blank an otherwise good card.
      return prev;
    }
  }

  private evaluateSupplies(
    facilities: FacilityRec[],
    facilitiesAt: number | null,
    stock: SupplyStock,
  ): SupplyStatus {
    const cat = this.loadCatalog();
    // Resolve each facility against the catalog: the live record's own
    // `maintenance_per_cycle` is level-adjusted and wins, and `ammo_item` marks
    // the armed guns.
    const resolved: SupplyFacility[] = facilities.map((f) => {
      const def = cat.byId[f.type];
      const maint = f.maintenance.length ? f.maintenance : (def?.maintenance_inputs ?? []);
      return {
        name: f.name,
        active: f.active,
        maintenance: maint.map((m) => ({ item_id: m.item_id, quantity: m.quantity || 1 })),
        ammoItem: def?.ammo_item ?? null,
      };
    });
    return evaluateSupplies(
      resolved,
      facilitiesAt,
      stock,
      {
        ammoLowThreshold: this.config.ammoLowThreshold,
        consumableLowDays: this.config.consumableLowDays,
      },
      cat.itemNames,
    );
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
        supplies: snap?.supplies ?? null,
        combatAlert: snap?.combatAlert ?? false,
        battleId: snap?.battleId ?? null,
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
