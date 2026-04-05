import { log, logError } from "./ui.js";
import { reconnectQueue } from "./reconnectqueue.js";
import { debugLogForBot } from "./debug.js";
import { SessionManager } from "./session.js";
import { massDisconnectDetector } from "./massdisconnect.js";

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
const MAX_SESSION_RECOVERIES = 10; // After this many failures, force full login

// Global session creation rate limiter - prevents rapid session spam
let lastSessionCreateTime = 0;
const SESSION_CREATE_INTERVAL = 3000; // Minimum 3 seconds between any session creations

// Global serial queue for ALL session creations across all bots
let globalSessionQueue: Promise<void> = Promise.resolve();
let globalV2SessionQueue: Promise<void> = Promise.resolve();

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
  switch_ship: [...INV_STATUS, ...INV_STORAGE, ...INV_MARKET, ...INV_LOCATION, ...INV_CARGO, ...INV_SHIP],
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
  private _lastRecoveryTime = 0;
  private _recoveryCount = 0;
  private _recoveryInProgress = false;
  private _forceFullLogin = false;

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
    const botName = this._botName || "unknown";

    if (!token || !token.sessionId) {
      return false;
    }

    // Check if saved sessions are expired
    const now = Date.now();
    const v2ExpiresAt = token.v2ExpiresAt ? new Date(token.v2ExpiresAt).getTime() : 0;
    const v2Expired = token.v2SessionId && v2ExpiresAt <= now;

    if (v2Expired && token.v2SessionId) {
      debugLogForBot(botName, "api:restoreSession", `V2 session expired on disk, not restoring`, {
        v2SessionId: token.v2SessionId.slice(0, 8),
        expiresAt: token.v2ExpiresAt,
        now: new Date(now).toISOString(),
      });
    }

    const oldSession = this.session;
    this.session = {
      id: token.sessionId,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      playerId: token.playerId,
      createdAt: token.expiresAt || "",
    };

    // Only restore V2 session if it's still valid
    if (token.v2SessionId && !v2Expired) {
      this.v2Session = {
        id: token.v2SessionId,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        playerId: token.playerId,
        createdAt: token.v2ExpiresAt || "",
      };
    }

    debugLogForBot(botName, "api:restoreSession", `${botName} session restored from disk`, {
      sessionId: this.session.id.slice(0, 8),
      hasV2: !!this.v2Session,
    });
    return true;
  }

  getSession(): ApiSession | null {
    return this.session;
  }

  /** Check if full login is required (after too many session recovery failures) */
  needsFullLogin(): boolean {
    return this._forceFullLogin;
  }

  /** Reset the full login flag after successful login */
  resetFullLoginFlag(): void {
    this._forceFullLogin = false;
    this._recoveryCount = 0;
  }

  private isV2Command(command: string, payload?: Record<string, unknown>): boolean {
    return V2_DIRECT_COMMANDS.has(command)
      || (V2_ROUTED_COMMANDS.has(command) && !!payload?.action && typeof payload.action === "string");
  }

  async execute(command: string, payload?: Record<string, unknown>): Promise<ApiResponse> {
    const botName = this._botName || this.credentials?.username || "unknown";
    debugLogForBot(botName, "api:execute", `${botName} > ${command}`, payload);

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

      // Session invalid - log full response and create new session
      if (code === "session_invalid" || code === "session_expired" || code === "not_authenticated") {
        // Notify mass disconnect detector (tracks unique bots losing sessions)
        massDisconnectDetector.trackSessionLoss(botName);

        // Check if recovery is already in progress - if so, wait for it to complete
        if (this._recoveryInProgress) {
          debugLogForBot(botName, "api:execute", `${botName} recovery already in progress, waiting for completion...`);
          // Wait longer to allow recovery to complete (session creation can take time due to rate limiting)
          await sleep(5000);
          // After waiting, just retry - the sessions should be refreshed now
          return this.execute(command, payload);
        }

        this._recoveryInProgress = true;

        try {
          // Cap recovery attempts - force full login after too many failures
          if (this._recoveryCount >= MAX_SESSION_RECOVERIES) {
            log("system", `${botName} exceeded max session recoveries (${MAX_SESSION_RECOVERIES}), full login required`);
            this._forceFullLogin = true;
            this._recoveryCount = 0;
            this.session = null;
            this.v2Session = null;
            return { error: { code: "full_login_required", message: "Session recovery failed too many times, full login required" } };
          }

          this._recoveryCount++;
          this._lastRecoveryTime = Date.now();

          // If we've had too many recoveries in a short time, wait before trying again
          if (this._recoveryCount > 5) {
            const waitTime = 5000; // Wait 5 seconds
            log("wait", `${botName} too many session recoveries (${this._recoveryCount}), waiting ${waitTime}ms...`);
            await sleep(waitTime);
          }

          // Clear BOTH sessions - they may both be expired (especially V2 expiring first)
          // This prevents the loop where V1 is renewed but V2 stays expired
          debugLogForBot(botName, "api:execute", `${botName} session invalid, clearing both V1 and V2 sessions`);
          const oldSessionId = this.session?.id;
          const oldV2SessionId = this.v2Session?.id;
          this.session = null;
          this.v2Session = null;

          try {
            debugLogForBot(botName, "api:recovery", `${botName} starting session recovery (old V1: ${oldSessionId?.slice(0, 8) || "none"}, old V2: ${oldV2SessionId?.slice(0, 8) || "none"})`);
            await this.ensureSession();
            // CRITICAL: Always ensure V2 session exists after recovery, even if the
            // failing command was V1-only. V2 session expiration can cause V1 commands
            // to fail indirectly, so we must renew both to break the recovery loop.
            await this.ensureV2Session();
            const newV1Id = (this.session as ApiSession | null)?.id?.slice(0, 8) || "none";
            const newV2Id = (this.v2Session as ApiSession | null)?.id?.slice(0, 8) || "none";
            debugLogForBot(botName, "api:recovery", `${botName} session recovery complete (new V1: ${newV1Id}, new V2: ${newV2Id})`);
            // Reset recovery count on successful session creation
            this._recoveryCount = 0;
            return this.execute(command, payload);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log("error", `${botName} session renewal failed: ${msg}`);
            return { error: { code: "session_renewal_failed", message: msg } };
          }
        } finally {
          this._recoveryInProgress = false;
          debugLogForBot(botName, "api:recovery", `${botName} recovery flag cleared`);
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
      // Success - reset recovery count
      this._recoveryCount = 0;
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
          // CRITICAL: Always ensure V2 session exists after reconnection, even for V1 commands.
          // The V2 keepalive mechanism requires an active V2 session to function.
          await this.ensureV2Session();
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

    // Use global serial queue - ensures only ONE session creation at a time across ALL bots
    globalSessionQueue = globalSessionQueue.then(async () => {
      // Double-check after waiting in queue
      if (this.session) return;

      // Small random jitter to stagger bots
      const jitter = Math.random() * 2000;
      await sleep(jitter);

      // Check again after jitter
      if (this.session) return;

      await this.createSession();
    });

    return globalSessionQueue;
  }

  private async createSession(): Promise<void> {
    const botName = this._botName || "unknown";
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RECONNECT_ATTEMPTS; attempt++) {
      try {
        // Global rate limiting - wait if another session was just created
        const now = Date.now();
        const timeSinceLastCreate = now - lastSessionCreateTime;
        if (timeSinceLastCreate < SESSION_CREATE_INTERVAL) {
          const waitTime = SESSION_CREATE_INTERVAL - timeSinceLastCreate;
          debugLogForBot(botName, "api:createSession", `${botName} rate limited, waiting ${waitTime}ms`);
          await sleep(waitTime);
        }

        log("system", `Creating new session for ${botName}...`);

        const resp = await fetch(`${this.baseUrl}/session`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
        });

        if (!resp.ok) {
          const error = `Failed to create session: ${resp.status} ${resp.statusText}`;
          throw new Error(error);
        }

        const data = (await resp.json()) as ApiResponse;
        if (data.session) {
          this.session = data.session;
          lastSessionCreateTime = Date.now(); // Update global rate limiter
          log("system", `Session created for ${botName}: ${this.session.id.slice(0, 8)}...`);
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
            log("error", `Login failed for ${botName}: ${loginResp.error.message}`);
          } else {
            log("system", `Logged in successfully as ${botName}`);
          }
        }

        this.saveSessionToken();
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const delay = RECONNECT_BASE_DELAY * Math.pow(2, attempt);
        debugLogForBot(botName, "api:createSession", `${botName} attempt ${attempt + 1} failed, retrying in ${delay}ms`);
        await sleep(delay);
      }
    }

    throw lastError || new Error("Failed to create session");
  }

  private saveSessionToken(): void {
    if (!this._sessionManager || !this.session) return;

    // Check if v2 session is expired - don't save expired sessions!
    let v2SessionId: string | undefined;
    if (this.v2Session) {
      const v2ExpiresAt = new Date(this.v2Session.expiresAt).getTime();
      const now = Date.now();
      if (v2ExpiresAt > now) {
        // V2 session still valid, save it
        v2SessionId = this.v2Session.id;
      } else {
        // V2 session expired, clear it
        debugLogForBot(this._botName || "unknown", "api:saveSession", `V2 session expired, clearing from save`, {
          v2SessionId: this.v2Session.id.slice(0, 8),
          expiresAt: this.v2Session.expiresAt,
          now: new Date(now).toISOString(),
        });
        this.v2Session = null;  // Clear expired v2 session
      }
    }

    const token: import("./session.js").SessionToken = {
      sessionId: this.session.id,
      expiresAt: this.session.expiresAt,
      playerId: this.session.playerId,
    };
    if (v2SessionId) {
      token.v2SessionId = v2SessionId;
      token.v2ExpiresAt = this.v2Session?.expiresAt;
    }

    this._sessionManager.saveSessionToken(token);
  }

  private async ensureV2Session(): Promise<void> {
    if (this.v2Session) return;

    // Use global serial queue - ensures only ONE v2 session creation at a time across ALL bots
    globalV2SessionQueue = globalV2SessionQueue.then(async () => {
      // Double-check after waiting in queue
      if (this.v2Session) return;

      // Small random jitter to stagger bots
      const jitter = Math.random() * 2000;
      await sleep(jitter);

      // Check again after jitter
      if (this.v2Session) return;

      await this.createV2Session();
    });

    return globalV2SessionQueue;
  }

  private async createV2Session(): Promise<void> {
    const botName = this._botName || "unknown";
    const v2Base = this.baseUrl.replace("/api/v1", "/api/v2");
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RECONNECT_ATTEMPTS; attempt++) {
      try {
        // Global rate limiting - wait if another session was just created
        const now = Date.now();
        const timeSinceLastCreate = now - lastSessionCreateTime;
        if (timeSinceLastCreate < SESSION_CREATE_INTERVAL) {
          const waitTime = SESSION_CREATE_INTERVAL - timeSinceLastCreate;
          debugLogForBot(botName, "api:createV2Session", `${botName} rate limited, waiting ${waitTime}ms`);
          await sleep(waitTime);
        }

        log("system", `Creating v2 session for ${botName}...`);
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
          lastSessionCreateTime = Date.now(); // Update global rate limiter
          log("system", `v2 session created for ${botName}: ${this.v2Session.id.slice(0, 8)}...`);
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
        debugLogForBot(botName, "api:createV2Session", `${botName} attempt ${attempt + 1} failed`);
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
