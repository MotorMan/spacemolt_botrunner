import { log, logError } from "./ui.js";
import { commandLog } from "./commandLogger.js";
import { reconnectQueue } from "./reconnectqueue.js";
import { debugLog } from "./debug.js";
import { SessionManager } from "./session.js";

export interface ApiSession {
  id: string;
  playerId?: string;
  createdAt: string;
  expiresAt: string;
}

export interface ApiResponse {
  result?: unknown;
  notifications?: unknown[];
  session?: ApiSession;
  error?: { code: string; message: string; wait_seconds?: number } | null;
}

const DEFAULT_BASE_URL = "https://game.spacemolt.com/api/v1";
const USER_AGENT = "SpaceMolt-BotRunner-LT1428-MODDED";

// Session management
const MAX_RECONNECT_ATTEMPTS = 6;
const RECONNECT_BASE_DELAY = 5_000;

// ── Response cache ────────────────────────────────────────────

interface CacheEntry {
  response: ApiResponse;
  expiresAt: number;
}

class ResponseCache {
  private entries = new Map<string, CacheEntry>();

  get(key: string): ApiResponse | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      return null;
    }
    return entry.response;
  }

  set(key: string, response: ApiResponse, ttlMs: number): void {
    this.entries.set(key, { response, expiresAt: Date.now() + ttlMs });
  }

  invalidate(commands: string[]): void {
    for (const cmd of commands) {
      const prefix = `${cmd}:`;
      for (const key of this.entries.keys()) {
        if (key.startsWith(prefix)) this.entries.delete(key);
      }
    }
  }
}

const COMMAND_TTL: Record<string, number> = {
  get_status: 15_000,
  get_system: 30_000,
  get_ship: 60_000,
  get_cargo: 10_000,
  get_nearby: 15_000,
  get_poi: 30_000,
  get_base: 120_000,
  get_skills: 120_000,
  get_missions: 60_000,
  view_storage: 30_000,
  view_faction_storage: 120_000,
  find_route: 30_000,
  survey_system: 60_000,
  get_queue: 5_000,
  view_market: 30_000,
  view_orders: 30_000,
  estimate_purchase: 30_000,
  get_wrecks: 15_000,
  v2_get_ship: 60_000,
  v2_get_cargo: 10_000,
  v2_get_player: 30_000,
  v2_get_skills: 120_000,
  v2_get_queue: 5_000,
  v2_get_missions: 60_000,
  catalog: 1800_000,
};

const INV_STATUS   = ["get_status", "v2_get_player", "get_queue", "v2_get_queue"];
const INV_LOCATION = ["get_system", "get_nearby", "get_poi", "get_base", "survey_system", "find_route"];
const INV_CARGO    = ["get_cargo", "v2_get_cargo"];
const INV_SHIP     = ["get_ship", "v2_get_ship"];
const INV_MISSIONS = ["get_missions", "v2_get_missions"];
const INV_STORAGE  = ["view_storage", "view_faction_storage"];
const INV_MARKET   = ["view_market", "view_orders"];

const MUTATION_INVALIDATIONS: Record<string, string[]> = {
  travel: [...INV_STATUS, ...INV_CARGO, ...INV_LOCATION],
  jump: [...INV_STATUS, ...INV_LOCATION],
  dock: [...INV_STATUS, ...INV_STORAGE, ...INV_MARKET, ...INV_LOCATION],
  undock: INV_STATUS,
  mine: [...INV_STATUS, ...INV_CARGO, ...INV_LOCATION],
  sell: [...INV_STATUS, ...INV_CARGO, ...INV_MARKET],
  buy: [...INV_STATUS, ...INV_CARGO, ...INV_MARKET],
  jettison: [...INV_STATUS, ...INV_CARGO, ...INV_LOCATION],
  craft: [...INV_STATUS, ...INV_CARGO, ...INV_STORAGE],
  loot: [...INV_STATUS, ...INV_CARGO, ...INV_LOCATION],
  salvage: [...INV_STATUS, ...INV_CARGO, ...INV_LOCATION],
  storage: [...INV_STATUS, ...INV_CARGO, ...INV_STORAGE],
  withdraw_items: [...INV_STATUS, ...INV_CARGO, ...INV_STORAGE],
  deposit_items: [...INV_STATUS, ...INV_CARGO, ...INV_STORAGE],
  faction_withdraw_items: [...INV_STATUS, ...INV_CARGO, ...INV_STORAGE],
  faction_deposit_items: [...INV_STATUS, ...INV_CARGO, ...INV_STORAGE],
  faction_deposit_credits: INV_STATUS,
  faction_withdraw_credits: INV_STATUS,
  create_sell_order: [...INV_STATUS, ...INV_CARGO, ...INV_MARKET],
  create_buy_order: [...INV_STATUS, ...INV_MARKET],
  cancel_order: [...INV_STATUS, ...INV_MARKET],
  install_mod: [...INV_STATUS, ...INV_SHIP, ...INV_CARGO],
  uninstall_mod: [...INV_STATUS, ...INV_SHIP, ...INV_CARGO],
  repair: [...INV_STATUS, ...INV_SHIP, ...INV_LOCATION],
  refuel: [...INV_STATUS, ...INV_SHIP, ...INV_LOCATION],
  accept_mission: [...INV_STATUS, ...INV_MISSIONS],
  complete_mission: [...INV_STATUS, ...INV_MISSIONS],
  abandon_mission: [...INV_STATUS, ...INV_MISSIONS],
  decline_mission: [...INV_STATUS, ...INV_MISSIONS],
  cloak: INV_STATUS,
  attack: [...INV_STATUS, ...INV_SHIP, ...INV_LOCATION],
  catalog: [],
};

const V2_ROUTED_COMMANDS = new Set(["facility"]);

const V2_DIRECT_COMMANDS = new Set([
  "v2_get_ship", "v2_get_cargo", "v2_get_player",
  "v2_get_queue", "v2_get_skills", "v2_get_missions",
  "catalog",
]);

export class SpaceMoltAPI {
  readonly baseUrl: string;
  private session: ApiSession | null = null;
  private v2Session: ApiSession | null = null;
  private credentials: { username: string; password: string } | null = null;
  private _rateLimitRetries = 0;
  private _cache = new ResponseCache();
  private _botName: string | null = null;
  private _sessionManager: SessionManager | null = null;
  
  /** Queue for session creation - prevents duplicate concurrent creation */
  private _sessionQueue: Promise<void> = Promise.resolve();
  private _v2SessionQueue: Promise<void> = Promise.resolve();

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || process.env.SPACEMOLT_URL || DEFAULT_BASE_URL;
  }

  setBotName(name: string): void {
    this._botName = name;
  }

  setCredentials(username: string, password: string): void {
    this.credentials = { username, password };
  }

  setSessionManager(sessionManager: SessionManager): void {
    this._sessionManager = sessionManager;
  }

  restoreSessionToken(): boolean {
    if (!this._sessionManager) return false;
    const token = this._sessionManager.loadSessionToken();
    if (!token || !token.sessionId) return false;

    this.session = {
      id: token.sessionId,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      playerId: token.playerId,
      createdAt: token.expiresAt || "",
    };

    if (token.v2SessionId) {
      this.v2Session = {
        id: token.v2SessionId,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        playerId: token.playerId,
        createdAt: token.v2ExpiresAt || "",
      };
    }

    debugLog("api:restoreSession", `${this._botName || "unknown"} session restored from disk`, {
      sessionId: this.session.id.slice(0, 8),
      hasV2: !!this.v2Session,
    });
    return true;
  }

  getSession(): ApiSession | null {
    return this.session;
  }

  private isV2Command(command: string, payload?: Record<string, unknown>): boolean {
    return V2_DIRECT_COMMANDS.has(command)
      || (V2_ROUTED_COMMANDS.has(command) && !!payload?.action && typeof payload.action === "string");
  }

  async execute(command: string, payload?: Record<string, unknown>): Promise<ApiResponse> {
    const botName = this._botName || this.credentials?.username || "unknown";
    commandLog("api", `Executing command: ${this.credentials?.username}:${command}`, { command, payload });

    const cacheTtl = COMMAND_TTL[command];
    const cacheKey = `${command}:${JSON.stringify(payload ?? {})}`;
    if (cacheTtl !== undefined) {
      const cached = this._cache.get(cacheKey);
      if (cached) return cached;
    }

    const needsV2 = this.isV2Command(command, payload);

    try {
      await this.ensureSession();
      if (needsV2) await this.ensureV2Session();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("Login failed:")) {
        return { error: { code: "login_failed", message: msg } };
      }
      return this.handleReconnection(command, payload, needsV2);
    }

    let resp: ApiResponse;
    try {
      resp = await this.doRequest(command, payload);
    } catch {
      // Network error - server may have restarted or network hiccup
      // DON'T nullify sessions - they might still be valid after reconnect!
      log("system", "Connection lost, reconnecting...");
      return this.handleReconnection(command, payload, needsV2);
    }

    if (resp.error) {
      const code = resp.error.code;

      if (code === "rate_limited") {
        const secs = resp.error.wait_seconds || 20;
        this._rateLimitRetries++;
        if (this._rateLimitRetries >= 5) {
          log("error", `Rate limited ${this._rateLimitRetries} times, giving up on ${command}`);
          this._rateLimitRetries = 0;
          return resp;
        }
        log("wait", `Rate limited — sleeping ${secs}s... (retry ${this._rateLimitRetries}/5)`);
        await sleep(Math.ceil(secs * 1000));
        return this.execute(command, payload);
      }

      // Session invalid - create new session and retry ONCE
      if (code === "session_invalid" || code === "session_expired" || code === "not_authenticated") {
        debugLog("api:execute", `${botName} session invalid, creating new session`);
        this.session = null;
        if (needsV2) this.v2Session = null;

        try {
          await this.ensureSession();
          if (needsV2) await this.ensureV2Session();
          return this.execute(command, payload);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log("error", `${botName} session renewal failed: ${msg}`);
          return { error: { code: "session_renewal_failed", message: msg } };
        }
      }
    }

    this._rateLimitRetries = 0;

    if (resp.session) {
      if (needsV2) {
        this.v2Session = resp.session;
      } else {
        this.session = resp.session;
      }
    }

    if (!resp.error) {
      if (cacheTtl !== undefined) {
        this._cache.set(cacheKey, resp, cacheTtl);
      }
      const toInvalidate = MUTATION_INVALIDATIONS[command];
      if (toInvalidate) this._cache.invalidate(toInvalidate);
    }

    return resp;
  }

  private async handleReconnection(
    command: string,
    payload: Record<string, unknown> | undefined,
    needsV2: boolean
  ): Promise<ApiResponse> {
    const botName = this._botName || this.credentials?.username || "unknown";
    log("system", `${botName} connection lost, adding to reconnection queue...`);

    try {
      const success = await reconnectQueue.enqueue({
        botName,
        api: this,
        credentials: this.credentials,
      });

      if (success) {
        log("system", `${botName} reconnection successful, retrying ${command}...`);
        try {
          await this.ensureSession();
          if (needsV2) await this.ensureV2Session();
          return this.execute(command, payload);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { error: { code: "connection_failed", message: msg } };
        }
      } else {
        return { error: { code: "connection_failed", message: "Reconnection failed after multiple attempts" } };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log("error", `${botName} reconnection queue error: ${msg}`);
      return { error: { code: "connection_failed", message: `Reconnection queue error: ${msg}` } };
    }
  }

  private async ensureSession(): Promise<void> {
    if (this.session) return; // Session exists, use it

    // Add to session creation queue - ensures only one creation at a time
    this._sessionQueue = this._sessionQueue.then(async () => {
      // Double-check after waiting in queue
      if (this.session) return;
      
      // Small random jitter to stagger bots
      const jitter = Math.random() * 2000;
      await sleep(jitter);
      
      // Check again after jitter
      if (this.session) return;
      
      await this.createSession();
    });
    
    return this._sessionQueue;
  }

  private async createSession(): Promise<void> {
    const botName = this._botName || "unknown";
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RECONNECT_ATTEMPTS; attempt++) {
      try {
        log("system", "Creating new session...");
        const resp = await fetch(`${this.baseUrl}/session`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
        });

        if (!resp.ok) {
          throw new Error(`Failed to create session: ${resp.status} ${resp.statusText}`);
        }

        const data = (await resp.json()) as ApiResponse;
        if (data.session) {
          this.session = data.session;
          log("system", `Session created: ${this.session.id.slice(0, 8)}...`);
        } else {
          throw new Error("No session in response");
        }

        if (this.credentials) {
          log("system", `Logging in as ${this.credentials.username}...`);
          const loginResp = await this.doRequest("login", {
            username: this.credentials.username,
            password: this.credentials.password,
          });
          if (loginResp.error) {
            log("error", `Login failed: ${loginResp.error.message}`);
          } else {
            log("system", "Logged in successfully");
          }
        }

        this.saveSessionToken();
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const delay = RECONNECT_BASE_DELAY * Math.pow(2, attempt);
        debugLog("api:createSession", `${botName} attempt ${attempt + 1} failed, retrying in ${delay}ms`);
        await sleep(delay);
      }
    }

    throw lastError || new Error("Failed to create session");
  }

  private saveSessionToken(): void {
    if (!this._sessionManager) return;
    const token: import("./session.js").SessionToken = {
      sessionId: this.session?.id || "",
      expiresAt: this.session?.expiresAt || "",
      playerId: this.session?.playerId,
    };
    if (this.v2Session) {
      token.v2SessionId = this.v2Session.id;
      token.v2ExpiresAt = this.v2Session.expiresAt;
    }
    this._sessionManager.saveSessionToken(token);
  }

  private async ensureV2Session(): Promise<void> {
    if (this.v2Session) return;

    // Add to v2 session creation queue
    this._v2SessionQueue = this._v2SessionQueue.then(async () => {
      // Double-check after waiting in queue
      if (this.v2Session) return;
      
      // Small random jitter to stagger bots
      const jitter = Math.random() * 2000;
      await sleep(jitter);
      
      // Check again after jitter
      if (this.v2Session) return;
      
      await this.createV2Session();
    });
    
    return this._v2SessionQueue;
  }

  private async createV2Session(): Promise<void> {
    const botName = this._botName || "unknown";
    const v2Base = this.baseUrl.replace("/api/v1", "/api/v2");
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RECONNECT_ATTEMPTS; attempt++) {
      try {
        log("system", "Creating v2 session...");
        const resp = await fetch(`${v2Base}/session`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
        });

        if (!resp.ok) {
          throw new Error(`Failed to create v2 session: ${resp.status} ${resp.statusText}`);
        }

        const data = (await resp.json()) as ApiResponse;
        if (data.session) {
          const s = data.session as unknown as Record<string, unknown>;
          if (s.created_at && !s.createdAt) {
            s.createdAt = s.created_at;
            s.expiresAt = s.expires_at;
            s.playerId = s.player_id;
          }
          this.v2Session = data.session;
          log("system", `v2 session created: ${this.v2Session.id.slice(0, 8)}...`);
        } else {
          throw new Error("No session in v2 response");
        }

        if (this.credentials) {
          const loginResp = await fetch(`${v2Base}/spacemolt_auth/login`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "User-Agent": USER_AGENT,
              "X-Session-Id": this.v2Session.id,
            },
            body: JSON.stringify({
              username: this.credentials.username,
              password: this.credentials.password,
            }),
          });

          const loginData = (await loginResp.json()) as ApiResponse & { structuredContent?: unknown };
          if (loginData.structuredContent !== undefined) {
            loginData.result = loginData.structuredContent;
          }
          if (loginData.error) {
            logError(`v2 login failed: ${loginData.error.message}`);
          } else {
            log("system", "v2 session authenticated");
          }
        }

        this.saveSessionToken();
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const delay = RECONNECT_BASE_DELAY * Math.pow(2, attempt);
        debugLog("api:createV2Session", `${botName} attempt ${attempt + 1} failed`);
        await sleep(delay);
      }
    }

    throw lastError || new Error("Failed to create v2 session");
  }

  private async doRequest(command: string, payload?: Record<string, unknown>): Promise<ApiResponse> {
    let url: string;
    let body = payload;

    if (V2_DIRECT_COMMANDS.has(command)) {
      const v2Base = this.baseUrl.replace("/api/v1", "/api/v2");
      const v2Command = command.replace(/^v2_/, "");
      url = `${v2Base}/spacemolt_${v2Command}`;
    } else if (payload?.action && typeof payload.action === "string" && V2_ROUTED_COMMANDS.has(command)) {
      const action = payload.action as string;
      const v2Base = this.baseUrl.replace("/api/v1", "/api/v2");
      url = `${v2Base}/spacemolt_${command}/${action}`;
      body = payload;
    } else {
      url = `${this.baseUrl}/${command}`;
    }

    const isV2 = url.includes("/api/v2/");
    const activeSession = isV2 ? this.v2Session : this.session;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    };
    if (activeSession) {
      headers["X-Session-Id"] = activeSession.id;
    }

    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (resp.status === 401) {
      return {
        error: { code: "session_invalid", message: "Unauthorized — session lost" },
      };
    }

    try {
      const data = (await resp.json()) as ApiResponse & { structuredContent?: unknown };
      if (data.structuredContent !== undefined) {
        data.result = data.structuredContent;
      }
      if (data.session) {
        const s = data.session as unknown as Record<string, unknown>;
        if (s.created_at && !s.createdAt) {
          s.createdAt = s.created_at;
          s.expiresAt = s.expires_at;
          s.playerId = s.player_id;
        }
        if (isV2) {
          this.v2Session = data.session;
        } else {
          this.session = data.session;
        }
      }
      return data as ApiResponse;
    } catch {
      return {
        error: { code: "http_error", message: `HTTP ${resp.status}: ${resp.statusText}` },
      };
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
