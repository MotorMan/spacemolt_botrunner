import { log } from "./ui.js";

// ── Types ───────────────────────────────────────────────────

export type WsV2Status =
  | "idle"
  | "connecting"
  | "connected"
  | "subscribed"
  | "closed"
  | "error";

export interface MarketOrderLevel {
  price_each?: number;
  price?: number;
  quantity?: number;
  source?: string;
  [key: string]: unknown;
}

export interface MarketStreamItem {
  item_id: string;
  item_name?: string;
  sell_orders?: MarketOrderLevel[];
  buy_orders?: MarketOrderLevel[];
  [key: string]: unknown;
}

export interface MarketUpdatePayload {
  base_id: string;
  base_name?: string;
  tick: number;
  items: MarketStreamItem[];
  [key: string]: unknown;
}

export interface WebSocketV2ClientOptions {
  username: string;
  password: string;
  /** HTTP v2 base URL (e.g. https://game.spacemolt.com/api/v2). Defaults to the game server. */
  baseUrl?: string;
  onMarketUpdate?: (payload: MarketUpdatePayload) => void;
  onStatus?: (status: WsV2Status, info?: string) => void;
}

interface PendingEntry {
  resolve: () => void;
  reject: (err: Error) => void;
}

// ── Global WS login spacing ────────────────────────────────
// Every WS connect is a full login, and the login server times out
// below ~13s between attempts. Enforce a GLOBAL floor across all bots
// (mirrors SESSION_CREATE_INTERVAL / globalSessionQueue in api.ts).

const WS_LOGIN_FLOOR_MS = 13_000;
let _lastWsLoginAttempt = 0;
let _wsLoginQueue: Promise<void> = Promise.resolve();

function enqueueWsLogin(task: () => Promise<void>): Promise<void> {
  const run = _wsLoginQueue.then(async () => {
    const now = Date.now();
    const elapsed = now - _lastWsLoginAttempt;
    if (elapsed < WS_LOGIN_FLOOR_MS) {
      await sleep(WS_LOGIN_FLOOR_MS - elapsed + Math.random() * 1000);
    }
    _lastWsLoginAttempt = Date.now();
    await task();
  });
  _wsLoginQueue = run.then(() => {}, () => {});
  return run;
}

// ── Helpers ────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deriveWsUrl(baseUrl: string): string {
  let u = baseUrl.replace(/\/+$/, "");
  u = u.replace(/\/api\/v2$/, "/ws/v2");
  u = u.replace(/^https:/i, "wss:").replace(/^http:/i, "ws:");
  return u;
}

function toText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (data instanceof Uint8Array) return new TextDecoder().decode(data);
  if (typeof Buffer !== "undefined" && data instanceof Buffer) return data.toString("utf8");
  if (data && typeof (data as { toString?: () => string }).toString === "function") {
    return (data as { toString: () => string }).toString();
  }
  return String(data);
}

// ── WebSocket v2 client ────────────────────────────────────

export class WebSocketV2Client {
  readonly username: string;
  private readonly password: string;
  private readonly baseUrl: string;
  private readonly onMarketUpdate?: (payload: MarketUpdatePayload) => void;
  private readonly onStatus?: (status: WsV2Status, info?: string) => void;

  private ws: WebSocket | null = null;
  private shouldRun = false;
  private _loopRunning = false;
  private _connectResolve: (() => void) | null = null;
  private _connectReject: ((err: Error) => void) | null = null;
  private _closeGateResolve: (() => void) | null = null;

  private pending = new Map<string, PendingEntry>();
  private _timers = new Map<string, ReturnType<typeof setTimeout>>();

  private _rid = 0;
  private reconnectAttempts = 0;
  private isConnectedFlag = false;
  private isSubscribedFlag = false;
  private _subscribedBaseId: string | null = null;
  private _lastSubscribeBaseId: string | null = null;

  private status: WsV2Status = "idle";

  constructor(opts: WebSocketV2ClientOptions) {
    this.username = opts.username;
    this.password = opts.password;
    this.baseUrl = opts.baseUrl || "https://game.spacemolt.com/api/v2";
    this.onMarketUpdate = opts.onMarketUpdate;
    this.onStatus = opts.onStatus;
  }

  get isConnected(): boolean {
    return this.isConnectedFlag;
  }

  get isSubscribed(): boolean {
    return this.isSubscribedFlag;
  }

  get subscribedBaseId(): string | null {
    return this._subscribedBaseId;
  }

  /** Begin (and keep alive) the WS v2 connection. Resolves on first successful login. */
  start(): Promise<void> {
    if (this._loopRunning) return Promise.resolve();
    this.shouldRun = true;
    this._loopRunning = true;
    return this._runLoop();
  }

  private async _runLoop(): Promise<void> {
    while (this.shouldRun) {
      try {
        await this._connectAndLogin();
        await this._waitForClose();
      } catch (err) {
        this._logError(err);
      }
      if (!this.shouldRun) break;
      const delay = Math.min(30_000, 13_000 * Math.pow(1.4, Math.min(this.reconnectAttempts, 8)));
      this.reconnectAttempts++;
      this.setStatus("connecting");
      await sleep(delay);
    }
    this._loopRunning = false;
  }

  private _connectAndLogin(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this._connectResolve = resolve;
      this._connectReject = reject;
      this._openSocket();
    });
  }

  private _waitForClose(): Promise<void> {
    if (!this.ws && !this.shouldRun) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this._closeGateResolve = resolve;
    });
  }

  private _openSocket(): void {
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    const url = deriveWsUrl(this.baseUrl);
    this.setStatus("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this._onLoginFailed(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    this.ws = ws;

    const loginRid = "auth-" + (++this._rid);
    const loginTimer = setTimeout(() => {
      const p = this.pending.get(loginRid);
      if (p) {
        this.pending.delete(loginRid);
        p.reject(new Error("WS v2 login timeout"));
      }
    }, 20_000);
    this._timers.set(loginRid, loginTimer);
    this.pending.set(loginRid, {
      resolve: () => this._onLoggedIn(),
      reject: (e: Error) => this._onLoginFailed(e),
    });

    ws.onopen = () => {
      enqueueWsLogin(() => {
        this.ws!.send(JSON.stringify({
          tool: "spacemolt_auth",
          action: "login",
          payload: { username: this.username, password: this.password },
          request_id: loginRid,
        }));
        return Promise.resolve();
      }).catch((err) => {
        const p = this.pending.get(loginRid);
        this.pending.delete(loginRid);
        if (p) p.reject(err instanceof Error ? err : new Error(String(err)));
      });
    };
    ws.onmessage = (ev) => this._onMessage(ev.data);
    ws.onerror = () => { /* surfaced via onclose */ };
    ws.onclose = () => this._onClose();
  }

  private _onLoggedIn(): void {
    this.isConnectedFlag = true;
    this.reconnectAttempts = 0;
    this.setStatus("connected");
    if (this._connectResolve) {
      const r = this._connectResolve;
      this._connectResolve = null;
      this._connectReject = null;
      r();
    }
    if (this._lastSubscribeBaseId) {
      this._subscribe(this._lastSubscribeBaseId)
        .then(() => this.setStatus("subscribed"))
        .catch(() => { /* logged via reject */ });
    }
  }

  private _onLoginFailed(err: Error): void {
    this.setStatus("error", err.message);
    if (this._connectReject) {
      const r = this._connectReject;
      this._connectReject = null;
      this._connectResolve = null;
      r(err);
    }
    try { this.ws?.close(); } catch { /* ignore */ }
  }

  private _onClose(): void {
    this.setStatus("closed");
    this.isConnectedFlag = false;
    this.isSubscribedFlag = false;
    this._subscribedBaseId = null;
    for (const [, p] of this.pending) {
      try { p.reject(new Error("WS v2 connection closed")); } catch { /* ignore */ }
    }
    this.pending.clear();
    for (const t of this._timers.values()) clearTimeout(t);
    this._timers.clear();
    this.ws = null;
    if (this._closeGateResolve) {
      const r = this._closeGateResolve;
      this._closeGateResolve = null;
      r();
    }
  }

  private _onMessage(raw: unknown): void {
    let text: string;
    try {
      text = toText(raw);
    } catch {
      return;
    }
    if (!text) return;
    let frame: { type?: string; request_id?: string; payload?: unknown };
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    if (!frame || typeof frame !== "object") return;

    const type = frame.type;
    if (type === "welcome") return; // server push, no request_id

    const rid = frame.request_id;

    switch (type) {
      case "logged_in":
        if (rid && this.pending.has(rid)) {
          const p = this.pending.get(rid)!;
          this.pending.delete(rid);
          p.resolve();
        }
        break;
      case "result":
        if (rid && this.pending.has(rid)) {
          const p = this.pending.get(rid)!;
          this.pending.delete(rid);
          p.resolve();
        }
        break;
      case "error":
        if (rid && this.pending.has(rid)) {
          const p = this.pending.get(rid)!;
          this.pending.delete(rid);
          const payload = (frame.payload as { message?: string }) || {};
          p.reject(new Error(payload.message || "WS v2 error"));
        }
        break;
      case "market_update":
        if (this.onMarketUpdate && frame.payload) {
          try {
            this.onMarketUpdate(frame.payload as MarketUpdatePayload);
          } catch (err) {
            this._logError(err);
          }
        }
        break;
      case "server_restart_warning":
        this._log("system", "WS v2: server_restart_warning received, reconnecting.");
        try { this.ws?.close(); } catch { /* ignore */ }
        break;
      default:
        break;
    }
  }

  /** Subscribe to realtime market updates for a station. Resolves on the ack. */
  subscribeMarket(baseId: string): Promise<void> {
    return this._subscribe(baseId);
  }

  private _subscribe(baseId: string): Promise<void> {
    if (!this.ws || !this.isConnectedFlag) {
      return Promise.reject(new Error("WS v2 not connected"));
    }
    const rid = "sub-" + (++this._rid);
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const p = this.pending.get(rid);
        if (p) {
          this.pending.delete(rid);
          p.reject(new Error("WS v2 subscribe timeout"));
        }
      }, 20_000);
      this._timers.set(rid, timer);
      this.pending.set(rid, {
        resolve: () => {
          clearTimeout(timer);
          this._timers.delete(rid);
          this._subscribedBaseId = baseId;
          this._lastSubscribeBaseId = baseId;
          this.isSubscribedFlag = true;
          this.setStatus("subscribed");
          resolve();
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          this._timers.delete(rid);
          reject(err);
        },
      });
      this.ws!.send(JSON.stringify({
        tool: "spacemolt_market",
        action: "subscribe_market",
        payload: { base_id: baseId },
        request_id: rid,
      }));
    });
  }

  /** Tear down the connection. Best-effort unsubscribe, then close. */
  close(): void {
    this.shouldRun = false;
    if (this.ws) {
      if (this._subscribedBaseId) {
        try {
          this.ws.send(JSON.stringify({
            tool: "spacemolt_market",
            action: "unsubscribe_market",
            payload: { base_id: this._subscribedBaseId },
            request_id: "unsub-" + (++this._rid),
          }));
        } catch { /* ignore */ }
      }
      try { this.ws.close(); } catch { /* ignore */ }
    }
    for (const [, p] of this.pending) {
      try { p.reject(new Error("WS v2 closed")); } catch { /* ignore */ }
    }
    this.pending.clear();
    for (const t of this._timers.values()) clearTimeout(t);
    this._timers.clear();
    this.ws = null;
    this.isConnectedFlag = false;
    this.isSubscribedFlag = false;
    this._loopRunning = false;
  }

  private setStatus(status: WsV2Status, info?: string): void {
    this.status = status;
    if (this.onStatus) {
      try {
        this.onStatus(status, info);
      } catch { /* ignore */ }
    }
  }

  private _log(category: string, message: string): void {
    log(category as "system", message);
  }

  private _logError(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    this._log("error", `WS v2: ${msg}`);
  }
}
