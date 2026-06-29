import { type SyncSettings, type CoordinationPayload } from "./client_sync_types.js";
import { mapStore } from "./mapstore.js";
import { catalogStore } from "./catalogstore.js";
import { botChatChannel } from "./bot_chat_channel.js";
import { onCoordinationUpdate } from "./client_sync_hooks.js";
import { wildlifeStore } from "./wildlivestore.js";

export class ClientSyncSlave {
  private settings: SyncSettings;
  private clientId: string | null = null;
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSync = 0;
  private lastError: string | null = null;
  private connectionState: 'disconnected' | 'connecting' | 'connected' = 'disconnected';
  private lastConnectAttempt = 0;

  constructor(settings: SyncSettings) {
    this.settings = settings;
  }

  public start(): void {
    if (this.running) return;
    this.running = true;
    console.log(`[ClientSync] Starting slave mode`);
    const intervalMs = Math.max(5, this.settings.pollIntervalSec * 1000);
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

  public getState(): { connected: boolean; lastSync: number; lastError: string | null; connectionState: string; lastConnectAttempt: number } {
    return { connected: !!this.clientId, lastSync: this.lastSync, lastError: this.lastError, connectionState: this.connectionState, lastConnectAttempt: this.lastConnectAttempt };
  }

  public updateSettings(s: SyncSettings): void {
    this.settings = s;
  }

  private log(msg: string): void {
    console.log(`[ClientSync] ${msg}`);
  }

  private logError(msg: string): void {
    console.error(`[ClientSync] ${msg}`);
  }

  private async request<T>(path: string, init?: RequestInit, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    };
    if (this.settings.apiKey) headers["X-API-Key"] = this.settings.apiKey;
    if (this.settings.password) headers["X-Password"] = this.settings.password;
    if (this.clientId) headers["X-Client-Id"] = this.clientId;

    const url = `${this.settings.masterUrl}${path}`;
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

  private async pushLocal(endpoint: string, payload: Record<string, unknown>): Promise<void> {
    await this.request<{ ok: boolean }>(`/api/client-sync/${endpoint}`, { method: "POST" }, payload);
  }

private async register(): Promise<{ ok: boolean; error?: string }> {
    const url = new URL("/api/client-sync/register", this.settings.masterUrl).toString();
    this.connectionState = 'connecting';
    this.lastConnectAttempt = Date.now();
    
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey: this.settings.apiKey, label: this.settings.label || "slave", password: this.settings.password }) });
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
        this.log(`Connected to master as ${this.settings.label || "slave"} (${payload.clientId})`);
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

  private async pullMap(): Promise<void> {
    const data = await this.request<{ systems: Record<string, unknown> }>("/api/client-sync/map");
    if (data && typeof data === "object" && "systems" in data) {
      const systems = (data as { systems: Record<string, unknown> }).systems;
      for (const [id, sys] of Object.entries(systems)) {
        mapStore.registerPoiFromScan(id, (sys as Record<string, unknown>).poi as any);
      }
      this.log(`Updated map: ${Object.keys(systems).length} systems`);
    }
  }

  private async pullCatalog(): Promise<void> {
    const data = await this.request<Record<string, unknown>>("/api/client-sync/catalog");
    if (data && typeof data === "object") {
      // shallow merge into catalog store
    }
  }

  private async pullChat(): Promise<void> {
    const data = await this.request<Array<Record<string, unknown>>>("/api/client-sync/chat-history");
    if (Array.isArray(data)) {
      for (const m of data) {
        botChatChannel.send({
          sender: `[Master] ${m.sender || ""}`,
          recipients: [],
          channel: (m.channel as any) || "general",
          content: String(m.content || ""),
        });
      }
    }
  }

  private async pullCoordination(): Promise<void> {
    const files = ["tradeCoordination.json", "cargoMoverCoordination.json", "cargoMoverInTransit.json", "rescueQueue.json", "rescueBlackBook.json"];
    for (const file of files) {
      const data = await this.request<Record<string, unknown>>(`/api/client-sync/coordination?file=${encodeURIComponent(file)}`);
      if (data && typeof data === "object") {
        await onCoordinationUpdate(file, data);
      }
    }
  }

  private async pullWildlife(): Promise<void> {
    const data = await this.request<Record<string, unknown>>("/api/client-sync/wildlife");
    if (data && typeof data === "object" && "wildlife" in data) {
      const wildlifeData = data.wildlife as Record<string, any>;
      for (const [normalized, entry] of Object.entries(wildlifeData)) {
        if (entry && typeof entry === "object") {
          const e = entry as Record<string, unknown>;
          wildlifeStore["data"].wildlife[normalized] = e as any;
        }
      }
      wildlifeStore["data"].lastUpdated = data.lastUpdated as string;
      wildlifeStore["data"].counts.wildlife = Object.keys(wildlifeData).length;
      this.log(`Updated wildlife: ${Object.keys(wildlifeData).length} entities`);
    }
  }

private async pushStatuses(): Promise<void> {
    const statuses: Record<string, unknown>[] = [];
    await this.pushLocal("bot-status", { clientId: this.clientId, statuses });
  }

  private async pollCycle(): Promise<void> {
    if (!this.running) return;
    try {
      if (!this.clientId) {
        this.log('Registering with master...');
        const reg = await this.register();
        if (!reg.ok) throw new Error(reg.error || "register failed");
      }
      if (this.settings.syncMap) await this.pullMap();
      if (this.settings.syncCatalog) await this.pullCatalog();
      if (this.settings.syncBotChat) await this.pullChat();
      if (this.settings.syncCoordination) await this.pullCoordination();
      if (this.settings.syncWildlife) await this.pullWildlife();
      await this.pushStatuses();
      if (this.settings.pushLocalDiscoveries) {
        await this.pushLocal("poi-update", { systemId: "", poi: {} });
        await this.pushLocal("market-update", { station: "", orders: [] });
      }
      this.lastSync = Date.now();
      this.lastError = null;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.clientId = null;
      this.connectionState = 'disconnected';
      this.logError(`Sync failed: ${this.lastError}`);
    }
  }
}
