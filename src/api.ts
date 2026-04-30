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

const DEFAULT_BASE_URL = "https://game.spacemolt.com/api/v2";
const USER_AGENT = "SM-BotRunner-LT1428-V2-Only-4-28-26";

// Session management
const MAX_RECONNECT_ATTEMPTS = 6;
const RECONNECT_BASE_DELAY = 5_000;
const MAX_SESSION_RECOVERIES = 10;

// Global session creation rate limiter
let lastSessionCreateTime = 0;
const SESSION_CREATE_INTERVAL = 3000;

// Global serial queue for ALL session creations across all bots
let globalSessionQueue: Promise<void> = Promise.resolve();

// Command-to-Tool Mapping for V2 API
const COMMAND_TOOL_MAP: Record<string, string> = {
  // Auth commands
  'login': 'spacemolt_auth',
  'register': 'spacemolt_auth',
  'claim': 'spacemolt_auth',
  'logout': 'spacemolt_auth',

  // Default spacemolt tool commands
  'get_status': 'spacemolt',
  'get_player': 'spacemolt',
  'get_ship': 'spacemolt',
  'get_cargo': 'spacemolt',
  'get_skills': 'spacemolt',
  'get_queue': 'spacemolt',
  'get_missions': 'spacemolt',
  'get_active_missions': 'spacemolt',
  'completed_missions': 'spacemolt',
  'view_completed_mission': 'spacemolt',
  'get_commands': 'spacemolt',
  'get_version': 'spacemolt',
  'get_base': 'spacemolt',
  'get_poi': 'spacemolt',
  'get_system': 'spacemolt',
  'get_system_agents': 'spacemolt',
  'get_nearby': 'spacemolt',
  'get_location': 'spacemolt',
  'get_map': 'spacemolt',
  'find_route': 'spacemolt',
  'search_systems': 'spacemolt',
  'survey_system': 'spacemolt',
  'jump': 'spacemolt',
  'travel': 'spacemolt',
  'dock': 'spacemolt',
  'undock': 'spacemolt',
  'mine': 'spacemolt',
  'sell': 'spacemolt',
  'buy': 'spacemolt',
  'jettison': 'spacemolt',
  'use_item': 'spacemolt',
  'craft': 'spacemolt',
  'attack': 'spacemolt',
  'cloak': 'spacemolt',
  'scan': 'spacemolt',
  'distress_signal': 'spacemolt',
  'self_destruct': 'spacemolt',
  'install_mod': 'spacemolt',
  'uninstall_mod': 'spacemolt',
  'repair': 'spacemolt',
  'repair_module': 'spacemolt',
  'refuel': 'spacemolt',
  'accept_mission': 'spacemolt',
  'complete_mission': 'spacemolt',
  'abandon_mission': 'spacemolt',
  'decline_mission': 'spacemolt',

  // Ship commands
  'browse_ships': 'spacemolt_ship',
  'buy_listed_ship': 'spacemolt_ship',
  'list_ships': 'spacemolt_ship',
  'switch_ship': 'spacemolt_ship',
  'sell_ship': 'spacemolt_ship',
  'commission_ship': 'spacemolt_ship',
  'claim_commission': 'spacemolt_ship',
  'commission_status': 'spacemolt_ship',
  'cancel_commission': 'spacemolt_ship',
  'list_ship_for_sale': 'spacemolt_ship',
  'cancel_ship_listing': 'spacemolt_ship',
  'commission_quote': 'spacemolt_ship',
  'refit_ship': 'spacemolt_ship',
  'rename_ship': 'spacemolt_ship',
  'supply_commission': 'spacemolt_ship',

  // Storage commands (actions differ from command names)
   'deposit_items': 'spacemolt_storage',
   'withdraw_items': 'spacemolt_storage',
   'view_storage': 'spacemolt_storage',
   'view_faction_storage': 'spacemolt_storage',
   'send_gift': 'spacemolt_storage',
   'faction_deposit_items': 'spacemolt_storage',  // auto-add target: 'faction'
   'faction_withdraw_items': 'spacemolt_storage', // auto-add source: 'faction'
   'faction_deposit_credits': 'spacemolt_storage', // auto-add item_id: 'credits', target: 'faction'
   'faction_withdraw_credits': 'spacemolt_storage', // auto-add item_id: 'credits', source: 'faction'
   'storage': 'spacemolt_storage',

  // Market commands
  'view_market': 'spacemolt_market',
  'view_orders': 'spacemolt_market',
  'create_buy_order': 'spacemolt_market',
  'create_sell_order': 'spacemolt_market',
  'cancel_order': 'spacemolt_market',
  'modify_order': 'spacemolt_market',
  'estimate_purchase': 'spacemolt_market',
  'analyze_market': 'spacemolt_market',

  // Faction commands
  'create_faction': 'spacemolt_faction',
  'join_faction': 'spacemolt_faction',
  'leave_faction': 'spacemolt_faction',
  'faction_info': 'spacemolt_faction',
  'faction_list': 'spacemolt_faction',
  'faction_invite': 'spacemolt_faction',
  'faction_kick': 'spacemolt_faction',
  'faction_accept_peace': 'spacemolt_faction',
  'faction_declare_war': 'spacemolt_faction',
  'faction_decline_invite': 'spacemolt_faction',
  'faction_get_invites': 'spacemolt_faction',
  'faction_set_ally': 'spacemolt_faction',
  'faction_set_enemy': 'spacemolt_faction',
  'faction_propose_peace': 'spacemolt_faction',
  'faction_remove_ally': 'spacemolt_faction',
  'faction_remove_enemy': 'spacemolt_faction',
  'faction_rooms': 'spacemolt_faction',
  'faction_visit_room': 'spacemolt_faction',
  'faction_list_missions': 'spacemolt_faction',

  // Faction commerce (only orders - credits moved to storage)
  // 'faction_deposit_credits': moved to spacemolt_storage
  // 'faction_withdraw_credits': moved to spacemolt_storage
  'faction_create_buy_order': 'spacemolt_faction_commerce',
  'faction_create_sell_order': 'spacemolt_faction_commerce',
  
  // Faction admin
  'faction_edit': 'spacemolt_faction_admin',
  'faction_create_role': 'spacemolt_faction_admin',
  'faction_edit_role': 'spacemolt_faction_admin',
  'faction_delete_role': 'spacemolt_faction_admin',
  'faction_post_mission': 'spacemolt_faction_admin',
  'faction_cancel_mission': 'spacemolt_faction_admin',
  'faction_promote': 'spacemolt_faction_admin',
  'faction_write_room': 'spacemolt_faction_admin',
  'faction_delete_room': 'spacemolt_faction_admin',

  // Social commands
  'chat': 'spacemolt_social',
  'captains_log_add': 'spacemolt_social',
  'captains_log_get': 'spacemolt_social',
  'captains_log_list': 'spacemolt_social',
  'create_note': 'spacemolt_social',
  'read_note': 'spacemolt_social',
  'write_note': 'spacemolt_social',
  'get_action_log': 'spacemolt_social',
  'get_chat_history': 'spacemolt_social',
  'forum_create_thread': 'spacemolt_social',
  'forum_reply': 'spacemolt_social',
  'forum_list': 'spacemolt_social',
  'forum_get_thread': 'spacemolt_social',
  'forum_upvote': 'spacemolt_social',
  'forum_delete_thread': 'spacemolt_social',
  'forum_delete_reply': 'spacemolt_social',
  'set_colors': 'spacemolt_social',
  'set_status': 'spacemolt_social',

  // Catalog
  'catalog': 'spacemolt_catalog',

  // Intel
  'faction_submit_intel': 'spacemolt_intel',
  'faction_query_intel': 'spacemolt_intel',
  'faction_submit_trade_intel': 'spacemolt_intel',
  'faction_query_trade_intel': 'spacemolt_intel',
  'faction_intel_status': 'spacemolt_intel',
  'faction_trade_intel_status': 'spacemolt_intel',

  // Facility (special: uses /tool/{action} pattern)
  'facility': 'spacemolt_facility',

  // Battle
  'battle': 'spacemolt_battle',
  'get_battle_status': 'spacemolt_battle',
  'reload': 'spacemolt_battle',

  // Salvage
  'get_wrecks': 'spacemolt_salvage',
  'loot_wreck': 'spacemolt_salvage',
  'salvage_wreck': 'spacemolt_salvage',
  'scrap_wreck': 'spacemolt_salvage',
  'tow_wreck': 'spacemolt_salvage',
  'sell_wreck': 'spacemolt_salvage',
  'release_tow': 'spacemolt_salvage',
  'buy_insurance': 'spacemolt_salvage',
  'claim_insurance': 'spacemolt_salvage',
  'get_insurance_quote': 'spacemolt_salvage',
  'view_insurance': 'spacemolt_salvage',
  'set_home_base': 'spacemolt_salvage',

  // Fleet
  'fleet': 'spacemolt_fleet',
};

// Maps commands to their API action names (when different from command name)
const COMMAND_ACTION_MAP: Record<string, string> = {
  // Battle
  'get_battle_status': 'status',      // spacemolt_battle_status -> action is 'status'
  
  // Storage (actions differ from command names)
  'deposit_items': 'deposit',          // spacemolt_storage/deposit
  'withdraw_items': 'withdraw',        // spacemolt_storage/withdraw
  'view_storage': 'view',              // spacemolt_storage/view
   'faction_deposit_items': 'deposit',    // auto-add target: 'faction'
   'faction_withdraw_items': 'withdraw',   // auto-add source: 'faction'
   'faction_deposit_credits': 'deposit',   // auto-add item_id: 'credits', target: 'faction'
   'faction_withdraw_credits': 'withdraw', // auto-add item_id: 'credits', source: 'faction'
  
  // Faction storage
  'view_faction_storage': 'view',  // auto-add source: 'faction'
  'create_faction': 'create',
  'join_faction': 'join',
  'leave_faction': 'leave',
  'faction_info': 'info',
  'faction_list': 'list',
  'faction_invite': 'invite',
  'faction_kick': 'kick',
  'faction_accept_peace': 'accept_peace',
  'faction_declare_war': 'declare_war',
  'faction_decline_invite': 'decline_invite',
  'faction_get_invites': 'get_invites',
  'faction_set_ally': 'set_ally',
  'faction_set_enemy': 'set_enemy',
  'faction_propose_peace': 'propose_peace',
  'faction_remove_ally': 'remove_ally',
  'faction_remove_enemy': 'remove_enemy',
  'faction_rooms': 'rooms',
  'faction_visit_room': 'visit_room',
  'faction_list_missions': 'list_missions',
  
   // Faction commerce (remove 'faction_' prefix) - orders only, credits moved to storage
   'faction_create_buy_order': 'create_buy_order',
   'faction_create_sell_order': 'create_sell_order',
  
  
  // Faction admin (remove 'faction_' prefix)
  'faction_edit': 'edit',
  'faction_create_role': 'create_role',
  'faction_edit_role': 'edit_role',
  'faction_delete_role': 'delete_role',
  'faction_post_mission': 'post_mission',
  'faction_cancel_mission': 'cancel_mission',
  'faction_promote': 'promote',
  'faction_write_room': 'write_room',
  'faction_delete_room': 'delete_room',
  
  // Intel (remove 'faction_' prefix)
  'faction_submit_intel': 'submit_intel',
  'faction_query_intel': 'query_intel',
  'faction_submit_trade_intel': 'submit_trade_intel',
  'faction_query_trade_intel': 'query_trade_intel',
  'faction_intel_status': 'intel_status',
  'faction_trade_intel_status': 'trade_intel_status',
  
  // Catalog
  'catalog': 'catalog',
};

// Commands that use payload.action for the action (like facility and battle)
const COMMANDS_WITH_PAYLOAD_ACTION = new Set(['facility', 'battle', 'storage']);

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
  catalog: 3600_000,
};

const INV_STATUS   = ["get_status", "get_player", "get_queue", "get_skills"];
const INV_LOCATION = ["get_system", "get_nearby", "get_poi", "get_base", "survey_system", "find_route"];
const INV_CARGO    = ["get_cargo"];
const INV_SHIP     = ["get_ship"];
const INV_MISSIONS = ["get_missions"];
const INV_STORAGE  = ["view_storage"];
const INV_MARKET   = ["view_market", "view_orders"];

const MUTATION_INVALIDATIONS: Record<string, string[]> = {
  travel: [...INV_STATUS, ...INV_CARGO, ...INV_LOCATION],
  jump: [...INV_STATUS, ...INV_LOCATION],
  dock: [...INV_STATUS, ...INV_STORAGE, ...INV_MARKET, ...INV_LOCATION],
  switch_ship: [...INV_STATUS, ...INV_STORAGE, ...INV_MARKET, ...INV_LOCATION, ...INV_CARGO, ...INV_SHIP],
  reload: [...INV_STATUS, ...INV_STORAGE, ...INV_MARKET, ...INV_LOCATION, ...INV_CARGO, ...INV_SHIP],
  undock: INV_STATUS,
  mine: [...INV_STATUS, ...INV_CARGO, ...INV_LOCATION],
  sell: [...INV_STATUS, ...INV_CARGO, ...INV_MARKET, ...INV_STORAGE],
  buy: [...INV_STATUS, ...INV_CARGO, ...INV_MARKET, ...INV_STORAGE],
  jettison: [...INV_STATUS, ...INV_CARGO, ...INV_LOCATION, ...INV_STORAGE],
  craft: [...INV_STATUS, ...INV_CARGO, ...INV_STORAGE],
  loot: [...INV_STATUS, ...INV_CARGO, ...INV_LOCATION, ...INV_STORAGE],
  salvage: [...INV_STATUS, ...INV_CARGO, ...INV_LOCATION],
  withdraw_items: [...INV_STATUS, ...INV_CARGO, ...INV_STORAGE],
  deposit_items: [...INV_STATUS, ...INV_CARGO, ...INV_STORAGE],
  faction_deposit_credits: INV_STATUS,
  faction_withdraw_credits: INV_STATUS,
  send_gift: [...INV_STATUS, ...INV_STORAGE, ...INV_MARKET, ...INV_LOCATION, ...INV_CARGO, ...INV_SHIP],
  create_sell_order: [...INV_STATUS, ...INV_CARGO, ...INV_MARKET, ...INV_STORAGE],
  create_buy_order: [...INV_STATUS, ...INV_MARKET, ...INV_STORAGE],
  cancel_order: [...INV_STATUS, ...INV_MARKET, ...INV_STORAGE],
  install_mod: [...INV_STATUS, ...INV_SHIP, ...INV_CARGO, ...INV_STORAGE],
  uninstall_mod: [...INV_STATUS, ...INV_SHIP, ...INV_CARGO, ...INV_STORAGE],
  repair: [...INV_STATUS, ...INV_SHIP, ...INV_LOCATION, ...INV_STORAGE],
  refuel: [...INV_STATUS, ...INV_SHIP, ...INV_LOCATION, ...INV_CARGO, ...INV_STORAGE],
  accept_mission: [...INV_STATUS, ...INV_MISSIONS, ...INV_STORAGE, ...INV_CARGO],
  complete_mission: [...INV_STATUS, ...INV_MISSIONS, ...INV_CARGO, ...INV_STORAGE],
  abandon_mission: [...INV_STATUS, ...INV_MISSIONS, ...INV_CARGO, ...INV_STORAGE],
  decline_mission: [...INV_STATUS, ...INV_MISSIONS, ...INV_CARGO, ...INV_STORAGE],
  cloak: INV_STATUS,
  attack: [...INV_STATUS, ...INV_SHIP, ...INV_LOCATION],
  battle: [...INV_STATUS, ...INV_SHIP, ...INV_LOCATION],
  catalog: [],
};

export class SpaceMoltAPI {
  readonly baseUrl: string;
  private session: ApiSession | null = null;
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

    this.session = {
      id: token.sessionId,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      playerId: token.playerId,
      createdAt: token.expiresAt || "",
    };

    debugLogForBot(botName, "api:restoreSession", `${botName} session restored from disk`, {
      sessionId: this.session.id.slice(0, 8),
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

  async execute(command: string, payload?: Record<string, unknown>, abortSignal?: AbortSignal): Promise<ApiResponse> {
    const botName = this._botName || this.credentials?.username || "unknown";
    debugLogForBot(botName, "api:execute", `${botName} > ${command}`, payload);

    const cacheTtl = COMMAND_TTL[command];
    const cacheKey = `${command}:${JSON.stringify(payload ?? {})}`;
    if (cacheTtl !== undefined) {
      const cached = this._cache.get(cacheKey);
      if (cached) return cached;
    }

    try {
      await this.ensureSession();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("Login failed:")) {
        return { error: { code: "login_failed", message: msg } };
      }
      return this.handleReconnection(command, payload);
    }

    let resp: ApiResponse;
    try {
      resp = await this.doRequest(command, payload, abortSignal);
    } catch {
      log("system", "Connection lost, reconnecting...");
      return this.handleReconnection(command, payload);
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

      if (code === "session_invalid" || code === "session_expired" || code === "not_authenticated") {
        massDisconnectDetector.trackSessionLoss(botName);

        if (this._recoveryInProgress) {
          debugLogForBot(botName, "api:execute", `${botName} recovery already in progress, waiting...`);
          await sleep(5000);
          return this.execute(command, payload);
        }

        this._recoveryInProgress = true;

        try {
          if (this._recoveryCount >= MAX_SESSION_RECOVERIES) {
            log("system", `${botName} exceeded max session recoveries (${MAX_SESSION_RECOVERIES}), full login required`);
            this._forceFullLogin = true;
            this._recoveryCount = 0;
            this.session = null;
            return { error: { code: "full_login_required", message: "Session recovery failed too many times, full login required" } };
          }

          this._recoveryCount++;
          this._lastRecoveryTime = Date.now();

          if (this._recoveryCount > 5) {
            const waitTime = 5000;
            log("wait", `${botName} too many session recoveries (${this._recoveryCount}), waiting ${waitTime}ms...`);
            await sleep(waitTime);
          }

          debugLogForBot(botName, "api:execute", `${botName} session invalid, clearing session`);
          const oldSessionId = this.session?.id;
          this.session = null;

          try {
            debugLogForBot(botName, "api:recovery", `${botName} starting session recovery (old: ${oldSessionId?.slice(0, 8) || "none"})`);
            await this.ensureSession();
            const newId = (this.session as ApiSession | null)?.id?.slice(0, 8) || "none";
            debugLogForBot(botName, "api:recovery", `${botName} session recovery complete (new: ${newId})`);
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
      this.session = resp.session;
    }

    if (!resp.error) {
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
    if (this.session) return;

    globalSessionQueue = globalSessionQueue.then(async () => {
      if (this.session) return;

      const jitter = Math.random() * 2000;
      await sleep(jitter);

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
          throw new Error(`Failed to create session: ${resp.status} ${resp.statusText}`);
        }

        const data = (await resp.json()) as ApiResponse;
        if (data.session) {
          this.session = data.session;
          lastSessionCreateTime = Date.now();
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
        debugLogForBot(botName, "api:createSession", `${botName} attempt ${attempt + 1} failed`);
        await sleep(delay);
      }
    }

    throw lastError || new Error("Failed to create session");
  }

  private saveSessionToken(): void {
    if (!this._sessionManager || !this.session) return;

    const token = {
      sessionId: this.session.id,
      expiresAt: this.session.expiresAt,
      playerId: this.session.playerId,
    };

    this._sessionManager.saveSessionToken(token);
  }

  private async doRequest(command: string, payload?: Record<string, unknown>, abortSignal?: AbortSignal): Promise<ApiResponse> {
    const tool = COMMAND_TOOL_MAP[command] || 'spacemolt';
    let url: string;
    let body: Record<string, unknown> = payload ? { ...payload } : {};

    // Auto-add target: 'faction' for faction_deposit_items (deposit TO faction)
    if (command === 'faction_deposit_items' && !body.target) {
      body.target = 'faction';
    }
    // Auto-add source: 'faction' for faction_withdraw_items (withdraw FROM faction)
    if (command === 'faction_withdraw_items' && !body.source) {
      body.source = 'faction';
    }
    // Auto-add target: 'faction' for view_faction_storage (view faction storage)
    if (command === 'view_faction_storage' && !body.target) {
      body.target = 'faction';
    }
    // Auto-add item_id: 'credits' and target: 'faction' for faction_deposit_credits
    if (command === 'faction_deposit_credits') {
      body.item_id = 'credits';
      if (body.amount !== undefined) {
        body.quantity = body.amount;
        delete body.amount;
      }
      if (!body.target) {
        body.target = 'faction';
      }
    }
    // Auto-add item_id: 'credits' and source: 'faction' for faction_withdraw_credits
    if (command === 'faction_withdraw_credits') {
      body.item_id = 'credits';
      if (body.amount !== undefined) {
        body.quantity = body.amount;
        delete body.amount;
      }
      if (!body.source) {
        body.source = 'faction';
      }
    }

    if (tool === 'spacemolt_catalog') {
      url = `${this.baseUrl}/${tool}`;
    } else if (COMMANDS_WITH_PAYLOAD_ACTION.has(command) && payload?.action) {
      // Commands like facility and battle that use payload.action
      const action = payload.action as string;
      url = `${this.baseUrl}/${tool}/${action}`;
    } else {
      // For most commands, use the command name (or mapped action) as the action
      const action = COMMAND_ACTION_MAP[command] || command;
      url = `${this.baseUrl}/${tool}/${action}`;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    };
    if (this.session) {
      headers["X-Session-Id"] = this.session.id;
    }

    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: abortSignal,
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
        this.session = data.session;
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
