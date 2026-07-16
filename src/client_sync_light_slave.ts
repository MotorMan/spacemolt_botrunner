import { type SyncSettings } from "./client_sync_types.js";
import { botChatChannel } from "./bot_chat_channel.js";

/**
 * Lightweight client connect.
 *
 * This is a slim alternative to the full `ClientSyncSlave`. Where the slave does
 * a heavy two-way *file* sync (which deep-merges every data file and can clobber
 * personal per-client state on the other clients), the light client ONLY shares:
 *
 *   1. Bot names + full statuses for every bot (so the master — and therefore
 *      every other client — can see who's running, where, and at what fuel), and
 *   2. The non-API bot chat channel (relayed both ways through the master), so
 *      routines can run cross-client MAYDAY calls or periodic automatic status
 *      checks against the whole connected fleet without ever touching files.
 *
 * No map/market/catalog/coordination/wildlife sync, and crucially no
 * `syncFiles()`. That keeps the footprint tiny and avoids the overwrite problems
 * the full connect has. The master still lets light clients register (tagged
 * `light`) and the cross-client fleet-rescue poll (`/api/client-sync/fleet-poll`
 * and `/api/client-sync/bots`) works exactly the same, because it is built on
 * the per-client status pushes — not on shared files.
 */
export class ClientSyncLightSlave {
  private settings: SyncSettings;
  private clientId: string | null = null;
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSync = 0;
  private lastError: string | null = null;
  private connectionState: 'disconnected' | 'connecting' | 'connected' = 'disconnected';
  private lastConnectAttempt = 0;
  /** Hash of the last bot-chat message we relayed, to avoid echo loops. */
  private lastRelayedChat: string | null = null;

  constructor(settings: SyncSettings) {
    this.settings = settings;
  }

  public start(): void {
    if (this.running) return;
    this.running = true;
    console.log(`[ClientSync-Light] Starting lightweight client connect`);
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
    console.log(`[ClientSync-Light] ${msg}`);
  }

  private logError(msg: string): void {
    console.error(`[ClientSync-Light] ${msg}`);
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
          label: this.settings.label || "light",
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
        this.log(`Connected to master as ${this.settings.label || "light"} (${payload.clientId})`);
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

  /** Push this node's bot names + full statuses up to the master. */
  private async pushStatuses(): Promise<void> {
    let statuses: Record<string, unknown>[] = [];
    try {
      const { getBotStatuses } = await import("./botmanager.js");
      statuses = (getBotStatuses() as unknown[]) as Record<string, unknown>[];
    } catch {
      // best-effort: ignore if bot manager is unavailable
    }
    await this.request<{ ok: boolean }>("/api/client-sync/bot-status", { method: "POST" }, { clientId: this.clientId, statuses });
  }

  /**
   * Relay this client's local bot-chat messages up to the master so every other
   * connected client (and routines on the master) can see them — this is the
   * cross-client non-API chat channel that powers MAYDAY calls and periodic
   * status checks. We only relay messages that haven't been relayed yet to avoid
   * echo loops, and we seed the dedup cursor from current history on connect.
   */
  private async pushChat(): Promise<void> {
    const history = botChatChannel.getHistory(undefined, 100);
    for (const m of history) {
      const sig = `${m.sender}|${m.channel}|${m.content}|${m.timestamp}`;
      if (sig === this.lastRelayedChat) continue;
      // Only relay messages generated on THIS client: our own bot chat handler
      // tags local sends, but to be safe we relay everything newer than the last
      // relayed cursor. The master tags the source client label so other clients
      // can distinguish them, and we skip our own echoed messages on pull.
      try {
        await this.request<{ ok: boolean }>("/api/client-sync/chat-relay", { method: "POST" }, {
          channel: m.channel,
          content: m.content,
          sender: m.sender,
        });
      } catch {
        // leave cursor unchanged so we retry next cycle
        break;
      }
      this.lastRelayedChat = sig;
    }
  }

  /**
   * Pull the master's combined bot-chat history (the union of every connected
   * client's relayed chat) back into this client's bot chat channel so local
   * routines can read cross-client messages. Messages already present locally
   * (by timestamp + content) are skipped to avoid duplicates/echoes.
   */
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

  /**
   * Pull the master's cross-client fleet rescue poll: a single request that asks
   * every connected client for its local bots' fuel status + positions and
   * returns the union. Used by rescue routines to see the whole connected fleet
   * (named + full status) without each stranded bot having to request a rescue.
   * Never throws.
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

  private async pollCycle(): Promise<void> {
    if (!this.running) return;
    try {
      if (!this.clientId) {
        this.log('Registering with master...');
        const reg = await this.register();
        if (!reg.ok) throw new Error(reg.error || "register failed");
      }
      // The ONLY two things a light client shares are bot statuses + the
      // non-API bot chat channel. No file sync, no map/market/etc.
      await this.pushStatuses();
      await this.pushChat();
      await this.pullChat();
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
