import { join } from "path";
import { type SyncSettings, type CoordinationPayload } from "./client_sync_types.js";
import { mapStore } from "./mapstore.js";
import { catalogStore } from "./catalogstore.js";
import { botChatChannel } from "./bot_chat_channel.js";
import { onCoordinationUpdate } from "./client_sync_hooks.js";
import { wildlifeStore } from "./wildlivestore.js";
import {
  listSyncedFiles,
  readSyncedFile,
  mergeIntoFile,
  seedIntoFile,
  type FileEntry,
} from "./client_sync_files.js";

export class ClientSyncSlave {
  private settings: SyncSettings;
  private clientId: string | null = null;
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSync = 0;
  private lastError: string | null = null;
  private connectionState: 'disconnected' | 'connecting' | 'connected' = 'disconnected';
  private lastConnectAttempt = 0;
  /** Hash of the last content we pushed to master for each file (loop guard). */
  private lastPushed = new Map<string, string>();
  /** Hash of the last content we pulled from master for each file (loop guard). */
  private lastPulled = new Map<string, string>();

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

  /** Like `request` but returns the raw response text (for file bodies). */
  private async requestText(path: string): Promise<string> {
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
      const res = await fetch(url, { method: "GET", headers, signal: controller.signal });
      clearTimeout(timeoutId);
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      return await res.text();
    } catch (err) {
      clearTimeout(timeoutId);
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
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey: this.settings.apiKey, label: this.settings.label || "slave", password: this.settings.password, url: this.settings.selfUrl || "" }) });
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
    const files = ["minerCoordination.json", "tradeCoordination.json", "cargoMoverCoordination.json", "cargoMoverInTransit.json", "rescueQueue.json", "rescueBlackBook.json"];
    for (const file of files) {
      const data = await this.request<Record<string, unknown>>(`/api/client-sync/coordination?file=${encodeURIComponent(file)}`);
      if (data && typeof data === "object") {
        await onCoordinationUpdate(file, data);
      }
    }
  }

  private async pullWildlife(): Promise<void> {
    const data = await this.request<Record<string, unknown>>("/api/client-sync/wildlife");
    if (data && typeof data === "object" && "systems" in data) {
      wildlifeStore.mergeFrom(data as any);
      const counts = wildlifeStore.getCounts();
      this.log(`Updated wildlife: ${counts.creatures} types across ${counts.systems} systems`);
    }
  }

  /**
   * Push this node's local wildlife findings up to the master so every
   * connected client converges on the union of all discoveries.
   */
  private async pushWildlife(): Promise<void> {
    const data = wildlifeStore.getFullData();
    await this.request<{ ok: boolean }>("/api/client-sync/wildlife-update", { method: "POST" }, data);
  }

  private async pushStatuses(): Promise<void> {
    let statuses: Record<string, unknown>[] = [];
    try {
      const { getBotStatuses } = await import("./botmanager.js");
      statuses = (getBotStatuses() as unknown[]) as Record<string, unknown>[];
    } catch {
      // best-effort: ignore if bot manager is unavailable
    }
    await this.pushLocal("bot-status", { clientId: this.clientId, statuses });
  }

  /**
   * Pull the master's cross-client fleet rescue poll: a single request that asks
   * every connected client for its local bots' fuel status + positions and
   * returns the union. This is how a rescue bot running on a *slave* node sees
   * the whole connected fleet — it polls the master once instead of each bot
   * needing to request its own rescue over the synced bot-chat channel.
   *
   * Returns this node's own local bot statuses on failure (so a rescue bot on a
   * disconnected slave still sees its own fleet). Never throws.
   */
  public async pullFleetRescue(): Promise<Array<Record<string, unknown>>> {
    if (!this.clientId) return this.localFleetStatuses();
    try {
      const data = await this.request<Array<Record<string, unknown>>>("/api/client-sync/fleet-poll");
      if (Array.isArray(data)) return data;
    } catch {
      // fall back to local-only fleet status
    }
    return this.localFleetStatuses();
  }

  /** This node's own local bot statuses (used as a fallback for fleet rescue). */
  private async localFleetStatuses(): Promise<Array<Record<string, unknown>>> {
    try {
      const { getBotStatuses } = await import("./botmanager.js");
      return (getBotStatuses() as unknown[]) as Array<Record<string, unknown>>;
    } catch {
      return [];
    }
  }

  /**
   * Two-way file sync against the master.
   *
   * PULL: fetch the master's combined repository listing and merge any file
   * that differs from what we last pulled. Missing files (incl. at first
   * connect) are seeded locally so this client gains the master's existing
   * data. After merging a master file we record its hash as both "pulled" and
   * "pushed" so we never echo it straight back.
   *
   * PUSH: diff our local synced files against the last content we sent to the
   * master and POST any that changed. The master deep-merges them into the
   * combined repo, so every other client converges on our writes.
   */
  private async syncFiles(): Promise<void> {
    if (!this.clientId) return;
    const dataDir = join(process.cwd(), "data");

    // ── PULL from master ──
    const masterList = await this.request<{ files: FileEntry[] }>("/api/client-sync/local-files");
    if (masterList && Array.isArray(masterList.files)) {
      for (const f of masterList.files) {
        const last = this.lastPulled.get(f.path);
        if (last === f.hash) continue;
        const content = await this.requestText(`/api/client-sync/local-file?path=${encodeURIComponent(f.path)}`);
        if (typeof content !== "string" || !content) continue;
        const localContent = readSyncedFile(dataDir, f.path);
        // Missing locally → seed with master's content; present → merge master
        // into our local copy so we gain every other client's data too.
        const hash = localContent === null
          ? seedIntoFile(dataDir, f.path, content)
          : mergeIntoFile(dataDir, f.path, content);
        if (hash) {
          this.lastPulled.set(f.path, f.hash);
          // If the merge produced exactly what master already has, mark it
          // pushed so we don't echo master's own data back. Otherwise leave it
          // unset so the push phase uploads our (superset) version once.
          if (hash === f.hash) this.lastPushed.set(f.path, f.hash);
        }
      }
    }

    // ── PUSH to master ──
    const localList = listSyncedFiles(dataDir);
    for (const f of localList) {
      const last = this.lastPushed.get(f.path);
      if (last === f.hash) continue;
      const content = readSyncedFile(dataDir, f.path);
      if (content === null) continue;
      try {
        await this.request<{ ok: boolean }>("/api/client-sync/file-update", { method: "POST" }, { path: f.path, content, mtime: f.mtime });
        this.lastPushed.set(f.path, f.hash);
      } catch {
        // leave lastPushed unchanged so we retry next cycle
      }
    }
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
      if (this.settings.syncWildlife) {
        await this.pushWildlife();
        await this.pullWildlife();
      }
      await this.pushStatuses();
      if (this.settings.pushLocalDiscoveries) {
        await this.pushLocal("poi-update", { systemId: "", poi: {} });
        await this.pushLocal("market-update", { station: "", orders: [] });
      }
      await this.syncFiles();
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
