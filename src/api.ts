import { log, logError } from "./ui.js";
import { commandLog } from "./commandLogger.js";
import { reconnectQueue } from "./reconnectqueue.js";
import { serverDisconnectDetector } from "./serverdisconnectdetector.js";
import { debugLog } from "./debug.js";

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

// ── Response cache ────────────────────────────────────────────

interface CacheEntry {
  response: ApiResponse;
  expiresAt: number;
}

/** In-memory cache for read-only game query responses, keyed by "command:payload". */
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

  /** Delete all entries for the given commands. */
  invalidate(commands: string[]): void {
    for (const cmd of commands) {
      const prefix = `${cmd}:`;
      for (const key of this.entries.keys()) {
        if (key.startsWith(prefix)) this.entries.delete(key);
      }
    }
  }
}

// Cacheable read-only commands and their fallback TTLs (ms).
// Server Cache-Control headers override these when present.
const COMMAND_TTL: Record<string, number> = {
  get_status:             15_000,
  get_system:             30_000,
  get_ship:               60_000,
  get_cargo:              10_000,
  get_nearby:             15_000,
  get_poi:                30_000,
  get_base:              120_000,
  get_skills:            120_000,
  get_missions:           60_000,
  view_storage:           30_000,
  view_faction_storage:  120_000,
  find_route:             30_000,
  survey_system:          60_000,
  get_queue:               5_000,
  view_market:            30_000,
  view_orders:            30_000,
  estimate_purchase:      30_000,
  get_wrecks:             15_000,
  v2_get_ship:            60_000,
  v2_get_cargo:           10_000,
  v2_get_player:          30_000,
  v2_get_skills:         120_000,
  v2_get_queue:            5_000,
  v2_get_missions:        60_000,
  catalog:             1800_000, // 30min, should be slow enough to not hurt.
};

// Cache groups for mutation invalidation
const INV_STATUS   = ["get_status", "v2_get_player", "get_queue", "v2_get_queue"];
const INV_LOCATION = ["get_system", "get_nearby", "get_poi", "get_base", "survey_system", "find_route"];
const INV_CARGO    = ["get_cargo", "v2_get_cargo"];
const INV_SHIP     = ["get_ship", "v2_get_ship"];
const INV_MISSIONS = ["get_missions", "v2_get_missions"];
const INV_STORAGE  = ["view_storage", "view_faction_storage"];
const INV_MARKET   = ["view_market", "view_orders"];

/** Which cache entries to invalidate when a mutation command succeeds. */
const MUTATION_INVALIDATIONS: Record<string, string[]> = {
  travel:   [...INV_STATUS, ...INV_CARGO, ...INV_LOCATION],
  jump:     [...INV_STATUS, ...INV_LOCATION],
  dock:     [...INV_STATUS, ...INV_STORAGE, ...INV_MARKET, ...INV_LOCATION],
  undock:   INV_STATUS,
  mine:     [...INV_STATUS, ...INV_CARGO, ...INV_LOCATION],
  sell:     [...INV_STATUS, ...INV_CARGO, ...INV_MARKET],
  buy:      [...INV_STATUS, ...INV_CARGO, ...INV_MARKET],
  jettison: [...INV_STATUS, ...INV_CARGO, ...INV_LOCATION],
  craft:    [...INV_STATUS, ...INV_CARGO, ...INV_STORAGE],
  loot:     [...INV_STATUS, ...INV_CARGO, ...INV_LOCATION],
  salvage:  [...INV_STATUS, ...INV_CARGO, ...INV_LOCATION],
  storage:	[...INV_STATUS, ...INV_CARGO, ...INV_STORAGE],
  withdraw_items:           [...INV_STATUS, ...INV_CARGO, ...INV_STORAGE],
  deposit_items:            [...INV_STATUS, ...INV_CARGO, ...INV_STORAGE],
  faction_withdraw_items:   [...INV_STATUS, ...INV_CARGO, ...INV_STORAGE],
  faction_deposit_items:    [...INV_STATUS, ...INV_CARGO, ...INV_STORAGE],
  faction_deposit_credits:  INV_STATUS,
  faction_withdraw_credits: INV_STATUS,
  create_sell_order: [...INV_STATUS, ...INV_CARGO, ...INV_MARKET],
  create_buy_order:  [...INV_STATUS, ...INV_MARKET],
  cancel_order:      [...INV_STATUS, ...INV_MARKET],
  install_mod:   [...INV_STATUS, ...INV_SHIP, ...INV_CARGO],
  uninstall_mod: [...INV_STATUS, ...INV_SHIP, ...INV_CARGO],
  repair:        [...INV_STATUS, ...INV_SHIP, ...INV_LOCATION],
  refuel:        [...INV_STATUS, ...INV_SHIP, ...INV_LOCATION],
  accept_mission:   [...INV_STATUS, ...INV_MISSIONS],
  complete_mission: [...INV_STATUS, ...INV_MISSIONS],
  abandon_mission:  [...INV_STATUS, ...INV_MISSIONS],
  decline_mission:  [...INV_STATUS, ...INV_MISSIONS],
  cloak:  INV_STATUS,
  attack: [...INV_STATUS, ...INV_SHIP, ...INV_LOCATION],
  catalog: [], // No invalidation needed for read-only catalog
};

// Commands with sub-actions that route through v2 endpoints instead of v1.
// v1: POST /api/v1/{command} { action: "sub", ...params }
// v2: POST /api/v2/spacemolt_{command}/{action} { ...params }
const V2_ROUTED_COMMANDS = new Set(["facility"]);

// Commands that always route directly to v2 (no sub-action needed).
// v2: POST /api/v2/spacemolt_{command} { ...params }
// These return enriched data (e.g. v2_get_ship returns full module objects).
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
  /** Track bot name for reconnection queue logging */
  private _botName: string | null = null;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || process.env.SPACEMOLT_URL || DEFAULT_BASE_URL;
  }

  setBotName(name: string): void {
    this._botName = name;
  }

  setCredentials(username: string, password: string): void {
    this.credentials = { username, password };
  }

  getSession(): ApiSession | null {
    return this.session;
  }

  /** Check if a command will route to a v2 endpoint. */
  private isV2Command(command: string, payload?: Record<string, unknown>): boolean {
    return V2_DIRECT_COMMANDS.has(command)
      || (V2_ROUTED_COMMANDS.has(command) && !!payload?.action && typeof payload.action === "string");
  }

  async execute(command: string, payload?: Record<string, unknown>): Promise<ApiResponse> {
    // Log the command being executed to debugCommands.log
    commandLog("api", `Executing command: ${this.credentials?.username}:${command}`, { command, payload });

    // Return cached response for read-only commands when fresh
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
      // Connection failed - use the global reconnection queue
      return this.handleReconnection(command, payload, needsV2);
    }

    let resp: ApiResponse;
    try {
      resp = await this.doRequest(command, payload);
    } catch {
      // Network error — server may have restarted mid-request
      log("system", "Connection lost, reconnecting...");
      this.session = null;
      this.v2Session = null;
      try {
        await this.ensureSession();
        if (needsV2) await this.ensureV2Session();
        resp = await this.doRequest(command, payload);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith("Login failed:")) {
          return { error: { code: "login_failed", message: msg } };
        }
        // Connection failed - use the global reconnection queue
        return this.handleReconnection(command, payload, needsV2);
      }
    }

    // Handle session/auth errors by refreshing and retrying
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

      if (code === "session_invalid" || code === "session_expired" || code === "not_authenticated") {
        log("system", `Session expired (${needsV2 ? "v2" : "v1"}), refreshing...`);
        if (needsV2) {
          this.v2Session = null;
          try {
            await this.ensureV2Session();
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!msg.startsWith("Login failed:")) {
              return this.handleReconnection(command, payload, needsV2);
            }
            return { error: { code: "connection_failed", message: "Could not reconnect to server" } };
          }
        } else {
          this.session = null;
          try {
            await this.ensureSession();
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!msg.startsWith("Login failed:")) {
              return this.handleReconnection(command, payload, needsV2);
            }
            return { error: { code: "connection_failed", message: "Could not reconnect to server" } };
          }
        }
        // Fall through with fresh request so cache logic runs below
        resp = await this.doRequest(command, payload);
      }
    }

    // Reset rate-limit counter on success
    this._rateLimitRetries = 0;

    // Update session info from response
    if (resp.session) {
      if (needsV2) {
        this.v2Session = resp.session;
      } else {
        this.session = resp.session;
      }
    }

    if (!resp.error) {
      // Cache successful read responses
      if (cacheTtl !== undefined) {
        this._cache.set(cacheKey, resp, cacheTtl);
      }
      // Invalidate affected caches on successful mutations
      const toInvalidate = MUTATION_INVALIDATIONS[command];
      if (toInvalidate) this._cache.invalidate(toInvalidate);
    }

    return resp;
  }

  /**
   * Handle reconnection through the global queue.
   * This ensures only ONE bot attempts to reconnect at a time.
   */
  private async handleReconnection(
    command: string,
    payload: Record<string, unknown> | undefined,
    needsV2: boolean
  ): Promise<ApiResponse> {
    const botName = this._botName || this.credentials?.username || "unknown";
    
    // Report disconnect to server-wide detector
    const serverDownTriggered = serverDisconnectDetector.reportDisconnect(botName);
    if (serverDownTriggered) {
      log("system", `${botName} disconnect triggered server-wide detection - waiting for coordinated reconnect...`);
      return { error: { code: "server_down", message: "Server down detected - waiting for coordinated reconnection" } };
    }

    // If server-wide reconnect is already in progress, wait for it
    if (serverDisconnectDetector.isReconnecting()) {
      log("system", `${botName} - coordinated reconnection in progress, waiting...`);
      return { error: { code: "server_down", message: "Coordinated reconnection in progress" } };
    }

    log("system", `${botName} requesting reconnection via global queue...`);

    try {
      const success = await reconnectQueue.enqueue({
        botName,
        api: this,
        credentials: this.credentials,
      });

      if (success) {
        log("system", `${botName} reconnection successful, retrying ${command}...`);
        // Retry the original request
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
    const botName = this._botName || "unknown";
    
    // Check if we have a session and if it's expiring
    const hasSession = !!this.session;
    const isExpiring = hasSession ? this.isSessionExpiring() : true;
    
    debugLog("api:ensureSession", `${botName} ensureSession called`, { 
      hasSession, 
      isExpiring, 
      sessionId: this.session?.id.slice(0, 8),
      expiresAt: this.session?.expiresAt 
    });
    
    if (hasSession && !isExpiring) {
      debugLog("api:ensureSession", `${botName} session still valid, skipping renewal`);
      return;
    }

    const isRenewal = hasSession;
    log("system", isRenewal ? "Renewing session..." : "Creating new session...");

    // Build headers — include existing session ID for renewal
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.session) {
      headers["X-Session-Id"] = this.session.id;
    }

    // Single attempt - the reconnection queue handles retries with backoff
    const resp = await fetch(`${this.baseUrl}/session`, {
      method: "POST",
      headers,
    });

    if (!resp.ok) {
      throw new Error(`Failed to create session: ${resp.status} ${resp.statusText}`);
    }

    const data = (await resp.json()) as ApiResponse;
    if (data.session) {
      this.session = data.session;
      log("system", isRenewal ? `Session renewed: ${this.session.id.slice(0, 8)}...` : `Session created: ${this.session.id.slice(0, 8)}...`);
    } else {
      throw new Error("No session in response");
    }

    // Only do full login if this is a fresh session (not a renewal)
    // Renewal should preserve authentication state without re-sending credentials
    if (!isRenewal && this.credentials) {
      log("system", `Logging in as ${this.credentials.username}...`);
      const loginResp = await this.doRequest("login", {
        username: this.credentials.username,
        password: this.credentials.password,
      });
      if (loginResp.error) {
        throw new Error(`Login failed: ${loginResp.error.message}`);
      }
      log("system", "Logged in successfully");
      if (loginResp.session) {
        this.session = loginResp.session;
      }
    }
  }

  private isSessionExpiring(): boolean {
    if (!this.session) return true;
    const expiresAt = new Date(this.session.expiresAt).getTime();
    const now = Date.now();
    const remaining = expiresAt - now;
    const remainingSecs = Math.round(remaining / 1000);
    debugLog("api:session", `${this._botName || "unknown"} session check: ${remainingSecs}s remaining`, { 
      expiresAt: this.session.expiresAt, 
      now: new Date(now).toISOString(),
      isExpiring: remaining < 240_000 
    });
    return remaining < 240_000; // Less than 240s remaining
  }

  private isV2SessionExpiring(): boolean {
    if (!this.v2Session) return true;
    const expiresAt = new Date(this.v2Session.expiresAt).getTime();
    const now = Date.now();
    const remaining = expiresAt - now;
    const remainingSecs = Math.round(remaining / 1000);
    debugLog("api:session", `${this._botName || "unknown"} v2 session check: ${remainingSecs}s remaining`, { 
      expiresAt: this.v2Session.expiresAt, 
      now: new Date(now).toISOString(),
      isExpiring: remaining < 240_000 
    });
    return remaining < 240_000;
  }

  /** Create and authenticate a v2 session (separate session store from v1). */
  private async ensureV2Session(): Promise<void> {
    const botName = this._botName || "unknown";
    
    // Check if we have a v2 session and if it's expiring
    const hasSession = !!this.v2Session;
    const isExpiring = hasSession ? this.isV2SessionExpiring() : true;
    
    debugLog("api:ensureV2Session", `${botName} ensureV2Session called`, { 
      hasSession, 
      isExpiring, 
      sessionId: this.v2Session?.id.slice(0, 8),
      expiresAt: this.v2Session?.expiresAt 
    });
    
    if (hasSession && !isExpiring) {
      debugLog("api:ensureV2Session", `${botName} v2 session still valid, skipping renewal`);
      return;
    }

    const isRenewal = hasSession;
    const v2Base = this.baseUrl.replace("/api/v1", "/api/v2");
    log("system", isRenewal ? "Renewing v2 session..." : "Creating v2 session...");

    // Build headers — include existing session ID for renewal
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.v2Session) {
      headers["X-Session-Id"] = this.v2Session.id;
    }

    // Single attempt - the reconnection queue handles retries with backoff
    const resp = await fetch(`${v2Base}/session`, {
      method: "POST",
      headers,
    });

    if (!resp.ok) {
      throw new Error(`Failed to create v2 session: ${resp.status} ${resp.statusText}`);
    }

    const data = (await resp.json()) as ApiResponse;
    if (data.session) {
      // Normalize v2 snake_case fields
      const s = data.session as unknown as Record<string, unknown>;
      if (s.created_at && !s.createdAt) {
        s.createdAt = s.created_at;
        s.expiresAt = s.expires_at;
        s.playerId = s.player_id;
      }
      this.v2Session = data.session;
      log("system", isRenewal ? `v2 session renewed: ${this.v2Session.id.slice(0, 8)}...` : `v2 session created: ${this.v2Session.id.slice(0, 8)}...`);
    } else {
      throw new Error("No session in v2 response");
    }

    // Only do full login if this is a fresh session (not a renewal)
    // Renewal should preserve authentication state without re-sending credentials
    if (!isRenewal && this.credentials) {
      const loginResp = await fetch(`${v2Base}/spacemolt_auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
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
      // Capture updated session from login response
      if (loginData.session) {
        const ls = loginData.session as unknown as Record<string, unknown>;
        if (ls.created_at && !ls.createdAt) {
          ls.createdAt = ls.created_at;
          ls.expiresAt = ls.expires_at;
          ls.playerId = ls.player_id;
        }
        this.v2Session = loginData.session;
      }
    }
  }

  private async doRequest(command: string, payload?: Record<string, unknown>): Promise<ApiResponse> {
    // Route commands with sub-actions through v2 endpoints where each action
    // is a separate path: /api/v2/spacemolt_{command}/{action}
    // This fixes facility commands where v1 doesn't pass parameters correctly.
    let url: string;
    let body = payload;

    if (V2_DIRECT_COMMANDS.has(command)) {
      // Route directly to v2 endpoint (no sub-action)
      // Strip v2_ prefix from command name — it's just a naming convention,
      // the actual endpoint is /api/v2/spacemolt_{base_command}
      const v2Base = this.baseUrl.replace("/api/v1", "/api/v2");
      const v2Command = command.replace(/^v2_/, "");
      url = `${v2Base}/spacemolt_${v2Command}`;
    } else if (payload?.action && typeof payload.action === "string" && V2_ROUTED_COMMANDS.has(command)) {
      const action = payload.action as string;
      const v2Base = this.baseUrl.replace("/api/v1", "/api/v2");
      url = `${v2Base}/spacemolt_${command}/${action}`;
      // Keep full payload in body — v2 endpoint needs all params for validation
      body = payload;
    } else {
      url = `${this.baseUrl}/${command}`;
    }

    // Use v2 session for v2 endpoints, v1 session for v1
    const isV2 = url.includes("/api/v2/");
    const activeSession = isV2 ? this.v2Session : this.session;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (activeSession) {
      headers["X-Session-Id"] = activeSession.id;
    }

    // fetch() only throws on network errors (DNS, connection refused, etc.)
    // Any HTTP response — even 4xx/5xx — means the server is reachable.
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    // 401 = session gone (server restarted, etc.) — return as session error
    if (resp.status === 401) {
      return {
        error: { code: "session_invalid", message: "Unauthorized — session lost" },
      };
    }

    // Try to parse JSON for any status code. If the server returned an HTTP
    // response (even an error), the connection is fine — don't throw.
    try {
      const data = (await resp.json()) as ApiResponse & { structuredContent?: unknown };
      // v2 returns structured data in structuredContent; prefer it over result
      // (v2 result is a human-readable text summary, structuredContent is the raw JSON)
      if (data.structuredContent !== undefined) {
        data.result = data.structuredContent;
      }
      // Normalize v2 session fields (snake_case → camelCase)
      if (data.session) {
        const s = data.session as unknown as Record<string, unknown>;
        if (s.created_at && !s.createdAt) {
          s.createdAt = s.created_at;
          s.expiresAt = s.expires_at;
          s.playerId = s.player_id;
        }
      }
      return data as ApiResponse;
    } catch {
      // Non-JSON response (e.g. HTML error page, empty body)
      return {
        error: { code: "http_error", message: `HTTP ${resp.status}: ${resp.statusText}` },
      };
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

