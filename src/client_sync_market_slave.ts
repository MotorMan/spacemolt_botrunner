import { type SyncSettings, type MarketQueryRequest, type MarketQueryResult } from "./client_sync_types.js";
import { botChatChannel } from "./bot_chat_channel.js";

/**
 * Market-mode client connect.
 *
 * A slimmed-down sync client (like the light slave) that additionally supports
 * low-bandwidth market data queries. Where the full slave does a heavy two-way
 * file sync and the light slave only shares bot statuses + chat, the market
 * slave adds one capability:
 *
 *   1. It can advertise that it has fresh market data (from a running market
 *      routine) so the master knows which client to route queries to.
 *   2. It exposes a local `/api/client-sync/market-query-handler` endpoint
 *      (served by the shared web server) that the master calls when a trader
 *      on another client needs market info.
 *   3. It provides `queryRemoteMarket(...)` for local routines (trader,
 *      faction trader, etc.) to ask the master for the best deal on an item.
 *
 * No file sync. No map/catalog/coordination sync. Just status + chat + market
 * queries, keeping bandwidth tiny (a few KB per query instead of 5MB every
 * 10s).
 */
export class ClientSyncMarketSlave {
  private settings: SyncSettings;
  private clientId: string | null = null;
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSync = 0;
  private staleMs = 60000;
  private lastError: string | null = null;
  private connectionState: 'disconnected' | 'connecting' | 'connected' = 'disconnected';
  private lastConnectAttempt = 0;
  private lastPullError: string | null = null;
  private lastClients: Array<Record<string, unknown>> = [];
  private lastRelayedChat: string | null = null;
  private lastCatalogSync = 0;
  /** Cached market data availability flag — advertised during registration and
   *  refreshed each poll cycle so the master always has an up-to-date view. */
  private hasMarketData = false;
  /** Minimum age (ms) of marketDetails.json before we consider it stale enough
   *  to stop advertising `hasMarketData`. 30 minutes by default. */
  private readonly MARKET_DATA_STALE_MS = 30 * 60 * 1000;

  constructor(settings: SyncSettings) {
    this.settings = settings;
  }

  public start(): void {
    if (this.running) return;
    this.running = true;
    console.log(`[ClientSync-Market] Starting market sync client`);
    const intervalMs = Math.max(5, this.settings.pollIntervalSec * 1000);
    this.staleMs = Math.max(30000, intervalMs * 4);
    this.timer = setInterval(() => this.pollCycle(), intervalMs);
    this.pollCycle();
  }

  public stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.clientId = null;
    this.connectionState = 'disconnected';
  }

  public getState(): { connected: boolean; lastSync: number; lastError: string | null; connectionState: string; lastConnectAttempt: number; hasMarketData: boolean } {
    return { connected: !!this.clientId, lastSync: this.lastSync, lastError: this.lastError, connectionState: this.connectionState, lastConnectAttempt: this.lastConnectAttempt, hasMarketData: this.hasMarketData };
  }

  public updateSettings(s: SyncSettings): void {
    this.settings = s;
  }

  /** Whether this node currently has fresh market data to share. */
  public getHasMarketData(): boolean {
    return this.hasMarketData;
  }

  /** Manually set the market data flag (called by the market routine when
   *  it subscribes/unsubscribes, or by a periodic freshness check). */
  public setHasMarketData(value: boolean): void {
    this.hasMarketData = value;
  }

  private log(msg: string): void {
    console.log(`[ClientSync-Market] ${msg}`);
  }

  private logError(msg: string): void {
    console.error(`[ClientSync-Market] ${msg}`);
  }

  private async request<T>(path: string, init?: RequestInit, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    };
    if (this.settings.apiKey) headers["X-API-Key"] = this.settings.apiKey;
    if (this.settings.password) headers["X-Password"] = this.settings.password;
    if (this.clientId) headers["X-Client-Id"] = this.clientId;

    const base = (this.settings.masterUrl || "").replace(/\/+$/, "");
    const url = `${base}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
      const res = await fetch(url, { ...init, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: controller.signal });
      clearTimeout(timeoutId);
      const text = await res.text();
      try { return JSON.parse(text) as T; } catch { return text as T; }
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof Error && err.name === 'AbortError') {
        this.logError(`Timeout connecting to master`);
        throw new Error(`Connection timeout to ${this.settings.masterUrl}`);
      }
      this.logError(`Fetch error: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  private async register(): Promise<{ ok: boolean; error?: string }> {
    const url = new URL("/api/client-sync/register", this.settings.masterUrl).toString();
    this.connectionState = 'connecting';
    this.lastConnectAttempt = Date.now();

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: this.settings.apiKey,
          label: this.settings.label || "market",
          password: this.settings.password,
          url: this.settings.selfUrl || "",
          light: true,
        }),
      });
      let payload: { ok: boolean; clientId?: string; error?: string };
      try {
        payload = await res.json();
      } catch {
        payload = { ok: false, error: "invalid response" };
      }
      if (payload.ok && payload.clientId) {
        this.clientId = payload.clientId;
        this.connectionState = 'connected';
        this.lastError = null;
        this.log(`Connected to master as ${this.settings.label || "market"} (${payload.clientId})`);
      } else {
        this.connectionState = 'disconnected';
        this.lastError = payload.error || `HTTP ${res.status}`;
      }
      return payload;
    } catch (err) {
      this.connectionState = 'disconnected';
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      return { ok: false, error: msg };
    }
  }

  public async forceRegister(): Promise<void> {
    if (this.running) return;
    const reg = await this.register();
    if (reg.ok) this.connectionState = "connected";
  }

  private async pushStatuses(): Promise<boolean> {
    let statuses: Record<string, unknown>[] = [];
    try {
      const { getBotStatuses } = await import("./botmanager.js");
      statuses = (getBotStatuses() as unknown[]) as Record<string, unknown>[];
    } catch {
      // best-effort
    }
    try {
      const res = await this.request<{ ok: boolean }>("/api/client-sync/bot-status", { method: "POST" }, { clientId: this.clientId, statuses });
      return !!(res && (res as { ok?: boolean }).ok);
    } catch {
      return false;
    }
  }

  private async pushChat(): Promise<void> {
    const history = botChatChannel.getHistory(undefined, 100);
    for (const m of history) {
      const sig = `${m.sender}|${m.channel}|${m.content}|${m.timestamp}`;
      if (sig === this.lastRelayedChat) continue;
      try {
        await this.request<{ ok: boolean }>("/api/client-sync/chat-relay", { method: "POST" }, {
          channel: m.channel,
          content: m.content,
          sender: m.sender,
        });
      } catch {
        break;
      }
      this.lastRelayedChat = sig;
    }
  }

  private async pullChat(): Promise<void> {
    const data = await this.request<Array<Record<string, unknown>>>("/api/client-sync/chat-history");
    if (!Array.isArray(data)) return;
    const local = botChatChannel.getHistory(undefined, 200);
    const seen = new Set(local.map((m) => `${m.sender}|${m.channel}|${m.content}|${m.timestamp}`));
    for (const m of data) {
      const sig = `${m.sender}|${m.channel}|${m.content}|${m.timestamp}`;
      if (seen.has(sig)) continue;
      botChatChannel.send({
        sender: String(m.sender || "remote"),
        recipients: [],
        channel: (m.channel as any) || "general",
        content: String(m.content || ""),
      });
    }
  }

  /** Advertise our market data availability to the master so it knows we can
   *  answer market queries. */
  private async syncMarketAvailability(): Promise<void> {
    if (!this.clientId) return;
    try {
      await this.request<{ ok?: boolean }>("/api/client-sync/market-data-status", { method: "POST" }, {
        clientId: this.clientId,
        hasMarketData: this.hasMarketData,
      });
    } catch {
      // Non-fatal: the master will just not route queries to us this cycle.
    }
  }

  private async localCatalogInfo(): Promise<{ version: string | null; lastFetched: string | null }> {
    try {
      const { catalogStore } = await import("./catalogstore.js");
      const all = catalogStore.getAll();
      return {
        version: typeof all.version === "string" ? all.version : null,
        lastFetched: typeof all.lastFetched === "string" ? all.lastFetched : null,
      };
    } catch {
      return { version: null, lastFetched: null };
    }
  }

  private async syncCatalog(): Promise<void> {
    if (!this.settings.syncCatalog) return;
    const now = Date.now();
    if (now - this.lastCatalogSync < 30000) return;
    this.lastCatalogSync = now;

    const { version, lastFetched } = await this.localCatalogInfo();
    let resp: { ok?: boolean; gameServerVersion?: string | null; action?: string; catalog?: Record<string, unknown>; version?: string | null };
    try {
      resp = await this.request<typeof resp>("/api/client-sync/catalog-version", { method: "POST" }, { version, lastFetched });
    } catch {
      return;
    }
    const action = resp?.action;
    try {
      const { catalogStore } = await import("./catalogstore.js");
      if (action === "accept_catalog" && resp.catalog && typeof resp.catalog === "object") {
        catalogStore.replaceWith(resp.catalog as Record<string, unknown>);
        this.log(`Adopted up-to-date catalog from master (was v${version ?? "?"})`);
      } else if (action === "upload") {
        await this.request<{ ok?: boolean }>("/api/client-sync/catalog-upload", { method: "POST" }, { catalog: catalogStore.getAll() });
        this.log(`Uploaded local catalog (v${version ?? "?"}) to master`);
      } else if (action === "download_and_upload") {
        await catalogStore.fetchFromLib(true);
        await this.request<{ ok?: boolean }>("/api/client-sync/catalog-upload", { method: "POST" }, { catalog: catalogStore.getAll() });
        this.log(`Downloaded fresh catalog (v${catalogStore.getAll().version ?? "?"}) from gameserver and shared to master`);
      }
    } catch (err) {
      this.logError(`Catalog sync (${action}) failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  public async pullFleetRescue(): Promise<{ bots: Array<Record<string, unknown>>; clients: Array<Record<string, unknown>> }> {
    this.lastPullError = null;
    if (!this.clientId) {
      try {
        const reg = await this.register();
        if (reg.ok) {
          this.connectionState = "connected";
        }
      } catch (err) {
        this.lastPullError = `register failed: ${err instanceof Error ? err.message : String(err)}`;
        this.logError(`pullFleetRescue: ${this.lastPullError}`);
        return this.localFleetStatuses();
      }
    }
    if (!this.clientId) {
      this.lastPullError = "not registered (no clientId)";
      this.log("pullFleetRescue: no clientId (not registered) — returning local-only fleet");
      return this.localFleetStatuses();
    }
    try {
      const data = await this.request<{ bots?: Array<Record<string, unknown>>; clients?: Array<Record<string, unknown>> }>("/api/client-sync/fleet-poll");
      if (data && Array.isArray(data.bots)) {
        this.lastClients = Array.isArray(data.clients) ? data.clients : [];
        this.log(`pullFleetRescue: got ${data.bots.length} remote bot(s) from master`);
        return { bots: data.bots, clients: this.lastClients };
      }
      this.lastPullError = `master returned unexpected shape (${typeof data})`;
      this.logError(`pullFleetRescue: ${this.lastPullError} — falling back to local-only`);
    } catch (err) {
      this.lastPullError = `fetch failed: ${err instanceof Error ? err.message : String(err)}`;
      this.logError(`pullFleetRescue: ${this.lastPullError} — falling back to local-only`);
    }
    return this.localFleetStatuses();
  }

  public getLastPullError(): string | null {
    return this.lastPullError;
  }

  public getLastClients(): Array<Record<string, unknown>> {
    return this.lastClients;
  }

  private async localFleetStatuses(): Promise<{ bots: Array<Record<string, unknown>>; clients: Array<Record<string, unknown>> }> {
    try {
      const { getBotStatuses } = await import("./botmanager.js");
      return { bots: (getBotStatuses() as unknown[]) as Array<Record<string, unknown>>, clients: [] };
    } catch {
      return { bots: [], clients: [] };
    }
  }

  /**
   * Send a market data query to the master, which will route it to the client
   * that has the freshest market data. Returns the best deal(s) found, or an
   * error if no market data is available.
   *
   * This is the method trader/faction trader/etc routines call to find out
   * where to go for the best price on an item, without transferring the full
   * marketDetails.json (typically 5MB+).
   */
  public async queryRemoteMarket(query: MarketQueryRequest): Promise<MarketQueryResult> {
    if (!this.clientId) {
      return { ok: false, results: [], error: "Not connected to master" };
    }
    try {
      const result = await this.request<MarketQueryResult>("/api/client-sync/market-query", { method: "POST" }, query);
      return result;
    } catch (err) {
      this.logError(`Market query failed: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, results: [], error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async checkMarketDataFreshness(): Promise<void> {
    try {
      // Shared with the in-client local market source so both agree on what
      // "we have market data" means (and share one throttled stat call).
      const { getLocalMarketFileInfo } = await import("./market_local_source.js");
      const info = getLocalMarketFileInfo();
      this.hasMarketData = info.exists && info.ageMs !== null && info.ageMs < this.MARKET_DATA_STALE_MS;
    } catch {
      this.hasMarketData = false;
    }
  }

  private async pollCycle(): Promise<void> {
    if (!this.running) return;
    try {
      if (this.clientId && this.lastSync !== 0 && Date.now() - this.lastSync > this.staleMs) {
        this.log(`Connection stale (last sync ${Math.round((Date.now() - this.lastSync) / 1000)}s ago) — forcing re-register`);
        this.clientId = null;
        this.connectionState = 'disconnected';
      }
      if (!this.clientId) {
        this.log('Registering with master...');
        const reg = await this.register();
        if (!reg.ok) {
          this.clientId = null;
          this.connectionState = 'disconnected';
          throw new Error(reg.error || "register failed");
        }
        this.connectionState = 'connected';
      }
      const pushed = await this.pushStatuses();
      if (!pushed) {
        this.clientId = null;
        this.connectionState = 'disconnected';
        this.logError(`Status push rejected by master — will re-register next cycle`);
      }
      await this.pushChat();
      await this.pullChat();
      await this.syncCatalog();
      await this.checkMarketDataFreshness();
      await this.syncMarketAvailability();
      this.lastSync = Date.now();
      this.lastError = null;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      if (!this.clientId) this.connectionState = 'disconnected';
      this.logError(`Sync failed: ${this.lastError}`);
    }
  }
}
