import { SpaceMoltAPI, type ApiResponse } from "./api.js";
import { SessionManager, type Credentials } from "./session.js";
import { log, logError, logNotifications } from "./ui.js";
import { debugLog } from "./debug.js";
import { mapStore } from "./mapstore.js";
import { addMaydayRequest, parseMaydayMessage } from "./mayday.js";
import { playerNameStore } from "./playernamestore.js";
import { detectCustomsMessage, logCustomsStop, getBotCustomsStats, sendCustomsChatResponse, isEmpireSystem } from "./customs.js";
import { processPrivateMessage as processCooperationPrivateMessage } from "./cooperation/rescueCooperation.js";

export type BotState = "idle" | "running" | "stopping" | "error";

// Simple sleep helper to avoid circular dependency with common.ts
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface CargoItem {
  itemId: string;
  name: string;
  quantity: number;
}

export interface BotStats {
  totalMined: number;
  totalCrafted: number;
  totalTrades: number;
  totalProfit: number;
  totalSystems: number;
}

export interface BotStatus {
  username: string;
  state: BotState;
  routine: string | null;
  credits: number;
  fuel: number;
  maxFuel: number;
  cargo: number;
  cargoMax: number;
  location: string;
  system: string;
  poi: string;
  docked: boolean;
  lastAction: string;
  error: string | null;
  shipName: string;
  hull: number;
  maxHull: number;
  shield: number;
  maxShield: number;
  ammo: number;
  inventory: CargoItem[];
  storage: CargoItem[];
  stats: BotStats;
}

export interface RoutineContext {
  api: SpaceMoltAPI;
  bot: Bot;
  log: (category: string, message: string) => void;
  /** Optional: get status of all bots in the fleet (used by rescue routine). */
  getFleetStatus?: () => BotStatus[];
}

/** A routine is an async generator that yields state names as it progresses. */
export type Routine = (ctx: RoutineContext) => AsyncGenerator<string, void, void>;

const BOT_COLORS = [
  "\x1b[96m", // bright cyan
  "\x1b[93m", // bright yellow
  "\x1b[92m", // bright green
  "\x1b[95m", // bright magenta
  "\x1b[94m", // bright blue
  "\x1b[91m", // bright red
];
const RESET = "\x1b[0m";

let colorIndex = 0;

export class Bot {
  readonly username: string;
  readonly api: SpaceMoltAPI;
  readonly session: SessionManager;
  private color: string;
  private _state: BotState = "idle";
  private _routine: string | null = null;
  private _lastAction = "";
  private _error: string | null = null;
  private _abortController: AbortController | null = null;

  // Cached game state from last get_status
  credits = 0;
  fuel = 0;
  maxFuel = 0;
  cargo = 0;
  cargoMax = 0;
  location = "unknown";
  system = "unknown";
  poi = "";
  docked = false;
  shipName = "";
  hull = 0;
  maxHull = 0;
  shield = 0;
  maxShield = 0;
  ammo = 0;

  /** Cached inventory items from last get_cargo. */
  inventory: CargoItem[] = [];

  /** Cached station storage items from last view_storage. */
  storage: CargoItem[] = [];

  /** Cached faction storage items from last view_faction_storage. */
  factionStorage: CargoItem[] = [];

  /** Whether the bot's ship is currently cloaked. */
  isCloaked = false;

  /** Whether the bot's ship is dead (hull <= 0). */
  isDead = false;

  /** Whether the bot is currently towing a wreck. */
  towingWreck = false;

  /** Cached installed mod IDs from last refreshShipMods(). */
  installedMods: string[] = [];

  /** Accumulated stats for this bot. */
  stats: BotStats = { totalMined: 0, totalCrafted: 0, totalTrades: 0, totalProfit: 0, totalSystems: 0 };

  // Action log (last N entries)
  readonly actionLog: string[] = [];
  private maxLogEntries = 200;

  /** Customs inspection state - tracks if bot is being held for customs scan. */
  customsHold: {
    active: boolean;
    since: number;
    system: string;
    poi: string;
    outcome: "pending" | "cleared" | "contraband" | "evasion" | null;
    aiResponseSent: boolean; // Track if AI response was already sent
  } = { active: false, since: 0, system: "", poi: "", outcome: null, aiResponseSent: false };

  /** Timestamp when customs hold was last cleared (prevents rapid re-triggering). */
  private customsClearedAt: number = 0;

  /** Track last customs message content to prevent duplicate processing. */
  private lastCustomsMessage: string = "";
  private lastCustomsMessageTime: number = 0;

  /** Cooldown after customs clears before new hold can start (prevents rapid re-triggering). */
  private static readonly CUSTOMS_COOLDOWN_MS = 30000; // 30 seconds

  /** Optional callback for routing log output (e.g. to TUI). */
  onLog?: (username: string, category: string, message: string) => void;

  /** Optional callback for faction activity log entries. */
  onFactionLog?: (username: string, line: string) => void;

  /** Cached skill levels for detecting level-ups. */
  private skillLevels: Map<string, number> = new Map();

  /** Timestamp of the last faction combat alert (ms). Rate-limits chat spam. */
  private lastCombatAlertMs = 0;
  private static readonly COMBAT_ALERT_COOLDOWN_MS = 30_000;

  /** Timestamp of the last combat warning alert (separate from hull-damage alerts). */
  private lastWarningAlertMs = 0;
  private static readonly WARNING_ALERT_COOLDOWN_MS = 60_000;

  /** Track ongoing login to prevent duplicate concurrent logins */
  private _loginPromise: Promise<boolean> | null = null;

  constructor(username: string, baseDir: string) {
    this.username = username;
    this.api = new SpaceMoltAPI();
    this.api.setBotName(username);
    this.session = new SessionManager(username, baseDir);
    // Connect API to session manager for persistence
    this.api.setSessionManager(this.session);
    this.color = BOT_COLORS[colorIndex % BOT_COLORS.length];
    colorIndex++;
    
    // Initialize player name tracking
    playerNameStore.setBotName(username);
  }

  get state(): BotState {
    return this._state;
  }

  get routineName(): string | null {
    return this._routine;
  }

  /** Get the bot's empire affiliation from session credentials. */
  getEmpire(): string {
    const creds = this.session.loadCredentials();
    return creds?.empire || "";
  }

  log(category: string, message: string): void {
    const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false });
    const line = `${timestamp} [${category}] ${message}`;
    this.actionLog.push(line);
    if (this.actionLog.length > this.maxLogEntries) {
      this.actionLog.shift();
    }
    if (this.onLog) {
      this.onLog(this.username, category, message);
    } else {
      console.log(
        `\x1b[2m${timestamp}${RESET} ${this.color}[${this.username}]${RESET} ` +
          `${getCategoryColor(category)}[${category}]${RESET} ${message}`
      );
    }
  }

  /** Execute an API command, log the result, handle notifications. */
  async exec(command: string, payload?: Record<string, unknown>): Promise<ApiResponse> {
    // Block travel/jump commands while customs hold is active (allow chat and get_nearby for interaction)
    const blockedCommands = new Set(["jump", "travel", "dock", "undock", "mine", "salvage", "buy", "sell"]);
    if (this.isCustomsHold() && blockedCommands.has(command)) {
      this.log("customs", `⏳ Customs hold ACTIVE - blocking ${command} until clearance...`);
      const outcome = await this.waitForCustomsClear();
      this.log("customs", `✅ Customs clearance received (outcome: ${outcome}), resuming ${command}`);
    }

    this._lastAction = command;
    debugLog("bot:exec", `${this.username} > ${command}`, payload);
    let resp = await this.api.execute(command, payload);

    // Handle full login required (after too many session recovery failures)
    if (resp.error && resp.error.code === "full_login_required") {
      this.log("system", "Full login required due to session recovery failures, performing login...");
      const loggedIn = await this.login();
      if (loggedIn) {
        this.log("system", "Full login successful, retrying command...");
        resp = await this.api.execute(command, payload);
      } else {
        this.log("error", "Full login failed");
      }
    }

    // After jump/travel commands in empire space, wait for customs messages
    // This is the PROACTIVE check - wait 2 seconds minimum for customs to respond
    // Only applies to customs empires (Voidborn, Nebula, Crimson, Solarian) in non-lawless systems
    if (!resp.error && (command === "jump" || command === "travel")) {
      await this.refreshStatus();
      // Check if we're in an empire system with customs (not Frontier, not Outer Rim, not pirate, not lawless)
      const sysData = mapStore.getSystem(this.system);
      if (isEmpireSystem(this.system, this.getEmpire(), sysData?.security_level)) {
        this.log("customs", `⏱️ Post-jump customs wait @ ${this.system} - 2 second delay...`);
        await sleep(2000);
      }
    }

    // Action pending — a previous game action is still resolving (10s tick).
    // Wait for the tick to complete then retry once.
    if (resp.error) {
      const msg = resp.error.message || "";
      if (resp.error.code === "action_pending" || msg.includes("action is already pending")) {
        debugLog("bot:exec", `${this.username} > ${command}: action pending, waiting 10s...`);
        await sleep(10_000);
        resp = await this.api.execute(command, payload);
      }
    }

    if (resp.notifications && Array.isArray(resp.notifications) && resp.notifications.length > 0) {
      logNotifications(resp.notifications);
      await this.handleNotifications(resp.notifications);
    }

    if (resp.error) {
      // Suppress noisy expected errors — callers handle these gracefully
      const code = resp.error.code || "";
      const quiet =
        code === "mission_incomplete" ||
        (command === "view_faction_storage" && code !== "session_invalid") ||
        (command === "get_missions" && code !== "session_invalid") ||
        (command === "complete_mission" && code === "mission_incomplete") ||
        (command === "get_insurance_quote" && code !== "session_invalid") ||
        (command === "survey_system" && code === "no_scanner") ||
        (command === "faction_deposit_items" && code === "no_faction_storage") ||
        (command === "faction_deposit_credits" && code === "no_faction_storage") ||
        (command === "withdraw_items" && code === "cargo_full") ||
        (command === "faction_withdraw_items" && code === "cargo_full");
      if (!quiet) {
        this.log("error", `${command}: ${resp.error.message}`);
      }
    }

    // Auto-scan nearby players after navigation commands (travel, jump, dock, undock)
    // This helps collect player names faster as we move through the galaxy
    if (!resp.error) {
      const navigationCommands = ["travel", "jump", "dock", "undock"];
      if (navigationCommands.includes(command)) {
        // Small delay to let the navigation complete
        await sleep(500);
        const nearbyResp = await this.api.execute("get_nearby");
        if (!nearbyResp.error && nearbyResp.result) {
          this.trackNearbyPlayers(nearbyResp.result);
        }
      }
    }

    return resp;
  }

  /** Login using stored credentials. Returns true on success. Prevents duplicate concurrent logins. */
  async login(): Promise<boolean> {
    // If login already in progress, wait for it instead of starting a new one
    if (this._loginPromise) {
      this.log("system", "Login already in progress, waiting...");
      return this._loginPromise;
    }

    // Start new login
    this._loginPromise = this.doLogin().finally(() => {
      this._loginPromise = null;
    });

    return this._loginPromise;
  }

  /** Internal login implementation */
  private async doLogin(): Promise<boolean> {
    const creds = this.session.loadCredentials();
    if (!creds) {
      this._error = "No credentials found";
      this._state = "error";
      return false;
    }

    this.api.setCredentials(creds.username, creds.password);
    this.log("system", `Logging in as ${creds.username}...`);
    const resp = await this.exec("login", {
      username: creds.username,
      password: creds.password,
    });

    if (resp.error) {
      this._error = `Login failed: ${resp.error.message}`;
      this._state = "error";
      return false;
    }

    this.log("system", "Login successful");
    this.api.resetFullLoginFlag();
    await this.refreshStatus();
    return true;
  }

  /** Resume session from disk without full login. Returns true if session was restored and is valid. */
  async resumeSession(): Promise<boolean> {
    const restored = this.api.restoreSessionToken();
    if (!restored) {
      this.log("system", "No saved session token found, will require full login");
      return false;
    }

    // Test the session with a lightweight API call
    this.log("system", "Testing restored session...");
    const resp = await this.exec("get_status");
    if (resp.error) {
      this.log("system", `Restored session invalid: ${resp.error.message}, will require full login`);
      return false;
    }

    this.log("system", "Session resumed successfully");
    await this.refreshStatus();
    return true;
  }

  /** Fetch current game state and cache it. */
  async refreshStatus(): Promise<ApiResponse> {
    const resp = await this.exec("get_status");
    debugLog("bot:refreshStatus", `${this.username} get_status response`, resp.result);
    if (resp.result && typeof resp.result === "object") {
      const r = resp.result as Record<string, unknown>;
      debugLog("bot:refreshStatus", `${this.username} top-level keys`, Object.keys(r));

      // Player data may be nested under r.player or flat at top level
      const player = r.player as Record<string, unknown> | undefined;
      const p = player || r;

      this.credits = (p.credits as number) ?? this.credits;
      debugLog("bot:credits", `${this.username} credits=${this.credits} raw=${p.credits}`);
      this.system = (p.current_system as string) ?? this.system;
      this.poi = (p.current_poi as string) ?? (p.poi_id as string) ?? this.poi;
      this.docked = p.docked_at_base != null
        ? !!(p.docked_at_base)
        : (p.docked as boolean) ?? (p.status === "docked");
      this.location =
        (p.current_system as string) ||
        (p.location as string) ||
        this.location;

      // Ship fields
      const ship = r.ship as Record<string, unknown> | undefined;
      debugLog("bot:ship", `${this.username} ship object`, ship);
      if (ship) {
        const rawName = (ship.name as string) || "";
        const shipType = (ship.ship_type as string) || (ship.type as string) || "";
        this.shipName = (rawName && rawName.toLowerCase() !== "unnamed" ? rawName : shipType) || this.shipName;
        this.fuel = (ship.fuel as number) ?? this.fuel;
        this.maxFuel = (ship.max_fuel as number) ?? this.maxFuel;
        this.cargo = (ship.cargo_used as number) ?? this.cargo;
        this.cargoMax = (ship.cargo_capacity as number) ?? (ship.max_cargo as number) ?? this.cargoMax;
        this.hull = (ship.hull as number) ?? (ship.hp as number) ?? this.hull;
        this.maxHull = (ship.max_hull as number) ?? (ship.max_hp as number) ?? this.maxHull;
        this.shield = (ship.shield as number) ?? (ship.shields as number) ?? this.shield;
        this.maxShield = (ship.max_shield as number) ?? (ship.max_shields as number) ?? this.maxShield;
        this.ammo = (ship.ammo as number) ?? this.ammo;
      }

      // Cloak detection
      this.isCloaked = !!(p.is_cloaked || p.cloaked);

      // Tow detection - check for towing_wreck flag or tow_attached status
      const towingField = (p.towing_wreck as boolean) ?? (p.towing as boolean) ?? (p.has_tow as boolean);
      if (towingField != null) {
        this.towingWreck = towingField;
      }
      // Also check ship-level tow status
      if (ship) {
        const shipTowing = (ship.towing_wreck as boolean) ?? (ship.towing as boolean) ?? (ship.has_tow as boolean);
        if (shipTowing != null) {
          this.towingWreck = shipTowing;
        }
      }
      
      // Debug: log tow-related fields from status
      if (p.towing_wreck !== undefined || p.towing !== undefined || p.has_tow !== undefined || 
          (ship && (ship.towing_wreck !== undefined || ship.towing !== undefined || ship.has_tow !== undefined))) {
        this.log("debug", `Tow fields in status: p.towing_wreck=${p.towing_wreck}, p.towing=${p.towing}, p.has_tow=${p.has_tow}, ship.towing_wreck=${ship?.towing_wreck}, ship.towing=${ship?.towing}, ship.has_tow=${ship?.has_tow}, this.towingWreck=${this.towingWreck}`);
      }

      // Death detection
      if (this.hull <= 0 && this.maxHull > 0) {
        this.isDead = true;
      } else if (this.hull > 0 && this.isDead) {
        this.isDead = false; // respawned
      }

      // Fallback: fuel at top level
      if (typeof r.fuel === "number") this.fuel = r.fuel;
    }

    // Also refresh cargo inventory (and storage only if docked)
    await this.refreshCargo();
    if (this.docked) {
      await this.refreshStorage();
    }

    return resp;
  }

  /** Parse an item list from API response, handling both item_id and resource_id formats. */
  private parseItemList(result: unknown): CargoItem[] {
    if (!result || typeof result !== "object") return [];

    const r = result as Record<string, unknown>;
    const items = (
      Array.isArray(r) ? r :
      Array.isArray(r.items) ? r.items :
      Array.isArray(r.cargo) ? r.cargo :
      Array.isArray(r.storage) ? r.storage :
      []
    ) as Array<Record<string, unknown>>;

    return items
      .map((item) => ({
        itemId: (item.item_id as string) || (item.resource_id as string) || (item.id as string) || "",
        name: (item.name as string) || (item.item_name as string) || (item.resource_name as string) || (item.item_id as string) || "",
        quantity: (item.quantity as number) || (item.count as number) || 0,
      }))
      .filter((i) => i.itemId && i.quantity > 0);
  }

  /** Fetch cargo contents and cache them. */
  async refreshCargo(): Promise<void> {
    const resp = await this.exec("get_cargo");
    // Always update inventory — even if response is empty/null, clear stale data
    this.inventory = this.parseItemList(resp.result);
  }

  /** Fetch station storage contents and cache them. Pass station_id to check remotely. */
  async refreshStorage(stationId?: string): Promise<void> {
    const resp = await this.exec("view_storage", stationId ? { station_id: stationId } : undefined);
    this.storage = this.parseItemList(resp.result);
  }

  /**
   * Call view_storage and return the full response (including hint field).
   * Pass station_id to query a specific station remotely.
   */
  async viewStorage(stationId?: string): Promise<Record<string, unknown>> {
    const resp = await this.exec("view_storage", stationId ? { station_id: stationId } : undefined);
    if (resp.error || !resp.result || typeof resp.result !== "object") return {};
    return resp.result as Record<string, unknown>;
  }

  /**
   * Call view_orders with optional station_id for remote order checking.
   */
  async viewOrders(stationId?: string): Promise<Record<string, unknown>> {
    const resp = await this.exec("view_orders", stationId ? { station_id: stationId } : undefined);
    if (resp.error || !resp.result || typeof resp.result !== "object") return {};
    return resp.result as Record<string, unknown>;
  }

  /** Fetch faction storage contents and cache them. Silently returns empty on error. */
  async refreshFactionStorage(): Promise<void> {
    const resp = await this.exec("view_faction_storage");
    if (resp.error) {
      this.factionStorage = [];
      return;
    }
    this.factionStorage = this.parseItemList(resp.result);
  }

  /** Start running a routine. */
  async start(
    routineName: string,
    routine: Routine,
    opts?: { getFleetStatus?: () => BotStatus[] },
  ): Promise<void> {
    if (this._state === "running") {
      this.log("error", "Bot is already running");
      return;
    }

    this._state = "running";
    this._routine = routineName;
    this._error = null;
    this._abortController = new AbortController();

    const creds = this.session.loadCredentials();
    if (!creds) {
      this._error = "No credentials found";
      this._state = "error";
      throw new Error(this._error);
    }

    // Try to resume session from disk first (fast, no login delay)
    // If resume fails, fall back to full login
    if (this.api.needsFullLogin()) {
      // Full login required due to too many session recovery failures
      this.log("system", "Full login required (session recovery failed too many times)...");
      const loggedIn = await this.login();
      if (!loggedIn) {
        this._state = "error";
        throw new Error(this._error || "Login failed");
      }
      this.api.resetFullLoginFlag();
    } else if (this.api.getSession()) {
      this.log("system", "Using existing in-memory session");
    } else if (await this.resumeSession()) {
      // Session resumed successfully from disk
    } else {
      // No valid session, need full login
      this.log("system", "No valid session, performing full login...");
      const loggedIn = await this.login();
      if (!loggedIn) {
        this._state = "error";
        throw new Error(this._error || "Login failed");
      }
    }

    this.log("system", `Starting routine: ${routineName}`);

    const ctx: RoutineContext = {
      api: this.api,
      bot: this,
      log: (cat, msg) => this.log(cat, msg),
      getFleetStatus: opts?.getFleetStatus,
    };

    try {
      for await (const stateName of routine(ctx)) {
        if ((this._state as BotState) === "stopping") {
          this.log("system", `Stopped during state: ${stateName}`);
          break;
        }
        // Small gap between actions
        await sleep(2000);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._error = msg;
      this.log("error", `Routine error: ${msg}`);
      this._state = "error";
      // Re-throw so the caller's .catch() handler fires, ensuring the bot
      // assignment is cleared and "crashed" is logged rather than "finished".
      throw err;
    }

    this._state = "idle";
    this._routine = null;
    this.log("system", "Routine finished");
  }

  /** Fetch ship modules and cache installed mod IDs. */
  async refreshShipMods(): Promise<string[]> {
    const resp = await this.exec("get_ship");
    if (resp.result && typeof resp.result === "object") {
      const r = resp.result as Record<string, unknown>;
      const ship = (r.ship as Record<string, unknown>) || r;
      const modules = (
        Array.isArray(ship.modules) ? ship.modules :
        Array.isArray(ship.mods) ? ship.mods :
        Array.isArray(ship.installed_mods) ? ship.installed_mods :
        []
      ) as Array<Record<string, unknown> | string>;

      this.installedMods = modules.map(m => {
        if (typeof m === "string") return m;
        return (m.mod_id as string) || (m.id as string) || (m.name as string) || "";
      }).filter(Boolean);
    }
    return this.installedMods;
  }

  /** Get the current cached level for a skill. Returns 0 if unknown. Call checkSkills() first to populate. */
  getSkillLevel(skillId: string): number {
    return this.skillLevels.get(skillId) ?? 0;
  }

  /** Fetch skills and log any level-ups since the last check. */
  async checkSkills(): Promise<void> {
    const resp = await this.exec("get_skills");
    if (!resp.result || typeof resp.result !== "object") return;

    const r = resp.result as Record<string, unknown>;

    // Resolve the skills container — handles all known API shapes:
    //   Array at top level:          [{ skill_id, name, level }, ...]
    //   Array nested under .skills:  { skills: [{ skill_id, ... }] }
    //   Dict nested under .skills:   { skills: { crafting_basic: { level, xp, ... } } }
    //   Dict at top level:           { crafting_basic: { level, xp, ... } }
    //   Dict with numeric values:    { crafting_basic: 7, ... }
    let skillsContainer: unknown = r;
    if (!Array.isArray(r) && r.skills !== undefined) {
      skillsContainer = r.skills;
    }

    const entries: Array<{ id: string; name: string; level: number }> = [];

    if (Array.isArray(skillsContainer)) {
      for (const skill of skillsContainer as Array<Record<string, unknown>>) {
        const id = (skill.skill_id as string) || (skill.id as string) || (skill.name as string) || "";
        const name = (skill.name as string) || id;
        const level = (skill.level as number) ?? 0;
        if (id) entries.push({ id, name, level });
      }
    } else if (skillsContainer && typeof skillsContainer === "object") {
      for (const [key, val] of Object.entries(skillsContainer as Record<string, unknown>)) {
        if (typeof val === "number") {
          entries.push({ id: key, name: key, level: val });
        } else if (val && typeof val === "object") {
          const s = val as Record<string, unknown>;
          const level = (s.level as number) ?? (s.current_level as number) ?? 0;
          const name = (s.name as string) || key;
          entries.push({ id: key, name, level });
        }
      }
    }

    for (const { id, name, level } of entries) {
      const prev = this.skillLevels.get(id);
      if (prev !== undefined && level > prev) {
        this.log("skill", `LEVEL UP! ${name}: ${prev} -> ${level}`);
      }
      this.skillLevels.set(id, level);
    }
  }

  /**
   * Start a customs hold - blocks travel/jump actions until cleared.
   */
  startCustomsHold(): void {
    // Don't restart if already active - prevents timer reset and AI response spam
    if (this.customsHold.active) {
      this.log("customs", "📋 Customs hold already active - ignoring duplicate stop request");
      return;
    }
    
    this.customsHold = {
      active: true,
      since: Date.now(),
      system: this.system,
      poi: this.poi,
      outcome: "pending",
      aiResponseSent: false, // Fresh hold = allow AI response
    };
    this.log("customs", `🛑 CUSTOMS HOLD: Awaiting inspection at ${this.system}/${this.poi}...`);
  }

  /**
   * Clear the customs hold after scan completes.
   */
  clearCustomsHold(outcome: "cleared" | "contraband" | "evasion"): void {
    if (!this.customsHold.active && this.customsHold.outcome === null) {
      this.log("customs_debug", `Clear received but no active hold (outcome: ${outcome})`);
      return;
    }

    this.customsHold.outcome = outcome;
    this.customsHold.active = false;
    this.customsHold.aiResponseSent = false; // Reset for next customs stop
    this.customsClearedAt = Date.now(); // Set cooldown timestamp
    this.log("customs", `✅ CUSTOMS CLEARED: ${outcome} (30s cooldown)`);
  }

  /**
   * Check if bot is currently held by customs.
   */
  isCustomsHold(): boolean {
    if (!this.customsHold.active) return false;
    
    // Auto-timeout after 30 seconds (customs ship should have arrived by then)
    const elapsed = Date.now() - this.customsHold.since;
    if (elapsed > 30000) {
      this.log("customs", "⏰ CUSTOMS TIMEOUT: Proceeding after 30s wait");
      this.customsHold.active = false;
      this.customsHold.outcome = "cleared";
      return false;
    }
    
    return true;
  }

  /**
   * Wait for customs hold to clear (blocks until cleared or timeout).
   */
  async waitForCustomsClear(maxWaitMs: number = 30000): Promise<"cleared" | "contraband" | "evasion" | "timeout"> {
    const startTime = Date.now();
    
    while (this.customsHold.active && Date.now() - startTime < maxWaitMs) {
      await sleep(500);
      
      // Check if outcome was set by chat handler
      if (this.customsHold.outcome && this.customsHold.outcome !== "pending") {
        this.customsHold.active = false;
        return this.customsHold.outcome;
      }
    }
    
    // Timeout
    if (this.customsHold.active) {
      this.customsHold.active = false;
      this.customsHold.outcome = "cleared";
      this.log("customs", "⏰ Customs scan timeout - proceeding");
      return "timeout";
    }
    
    return this.customsHold.outcome || "cleared";
  }

  /**
   * Route notifications to the bot's own activity log and detect hull damage.
   * Uses this.api.execute() directly (not this.exec()) to avoid recursion.
   */
  private async handleNotifications(notifications: unknown[]): Promise<void> {
    // Get AI Chat service from global scope (initialized by botmanager)
    const aiChatService = (globalThis as any).aiChatService;

    for (const n of notifications) {
      if (typeof n !== "object" || !n) {
        if (typeof n === "string") this.log("info", `[NOTIFY] ${n}`);
        continue;
      }

      const notif = n as Record<string, unknown>;
      const type = notif.type as string | undefined;
      const msgType = notif.msg_type as string | undefined;

      // Chat messages - route to AI chat handler and display
      if (msgType === "chat_message") {
        const data = notif.data as Record<string, unknown> | undefined;
        if (data && typeof data === "object") {
          const channel = (data.channel as string) || "local";
          const sender = (data.sender as string) || "Unknown";
          const content = (data.content as string) || "";

          // Skip messages from self (prevent processing our own AI responses)
          if (sender === this.username) {
            continue;
          }

          this.log("chat", `Received [${channel}] ${sender}: ${content}`);
          
          // Track player name from chat (but NOT from MAYDAY messages - those can be fake/pirate names)
          if (sender && sender !== "Unknown" && sender !== this.username) {
            const contentLower = content.toLowerCase();
            if (!contentLower.includes("mayday")) {
              playerNameStore.add(sender);
            } else {
              debugLog("playernames:skip", `${this.username}`, `Ignored MAYDAY sender: "${sender}"`);
            }
          }

          // Check for MAYDAY emergency rescue requests
          if (channel === "emergency" || content.includes("MAYDAY")) {
            const mayday = parseMaydayMessage(content, sender, Date.now(), this.username, this.system, this.poi);
            if (mayday) {
              const added = addMaydayRequest(mayday);
              if (added) {
                this.log("mayday", `🚨 MAYDAY received from ${mayday.sender} at ${mayday.system}/${mayday.poi} (${mayday.fuelPct}% fuel)`);
              }
            } else {
              this.log("warn", `MAYDAY parse failed - message format may have changed. Content: "${content}"`);
            }
          }

          // Check for CUSTOMS inspection messages addressed to THIS BOT
          // Only process customs messages if sender is actually a customs agent
          if (channel === "system" || channel === "local") {
            const senderLower = sender.toLowerCase();
            const isFromCustoms =
              senderLower.startsWith("[customs]") ||
              senderLower.startsWith("confederacy customs") ||
              senderLower.includes("customs i -") ||
              senderLower.includes("customs ii -") ||
              senderLower.includes("customs iii -");

            if (isFromCustoms) {
              // This is a customs message - process it
              const customsDetection = detectCustomsMessage(content);
              if (customsDetection.type !== "none") {
                // Check if message is addressed to THIS bot (by player name or ship name)
                const lowerContent = content.toLowerCase();
                const lowerUsername = this.username.toLowerCase();
                const lowerShipName = (this.shipName || "").toLowerCase();

                // Check if username appears in message (customs messages use player name)
                const mentionsUsername = lowerContent.includes(lowerUsername);

                // Also check ship name as fallback
                const mentionsShip = lowerShipName && (
                  lowerContent.includes(lowerShipName) ||
                  lowerContent.includes(lowerShipName.replace(/\s+/g, ""))
                );

                const isAddressedToBot = mentionsUsername || mentionsShip;

                this.log("customs_debug", `Customs check: user="${this.username}", ship="${this.shipName}", mentionsUser=${mentionsUsername}, mentionsShip=${mentionsShip}, addressed=${isAddressedToBot}`);

                if (!isAddressedToBot) {
                  // Skip customs messages for other players/ships
                  this.log("customs_debug", `Skipping customs message - not addressed to this bot`);
                  continue;
                }

                // CRITICAL: Skip if we just cleared customs (cooldown period)
                const now = Date.now();
                if (this.customsClearedAt && now - this.customsClearedAt < Bot.CUSTOMS_COOLDOWN_MS) {
                  const remaining = Math.round((Bot.CUSTOMS_COOLDOWN_MS - (now - this.customsClearedAt)) / 1000);
                  this.log("customs_debug", `Skipping customs message - in ${remaining}s cooldown period`);
                  continue;
                }

                // Deduplicate: ignore if same message content within 10 seconds
                if (content === this.lastCustomsMessage && now - this.lastCustomsMessageTime < 10000) {
                  this.log("customs_debug", "Skipping duplicate customs message");
                  continue;
                }
                this.lastCustomsMessage = content;
                this.lastCustomsMessageTime = now;

                this.log("customs_debug", `Detection result: ${customsDetection.type}, keywords: ${customsDetection.matchedKeywords.join(", ")}`);

                this.log("customs", `CUSTOMS detected [${customsDetection.type}]: ${sender} - ${content.slice(0, 100)}`);

                // Get bot's customs statistics for AI response
                const customsStats = getBotCustomsStats(this.username);

                // Handle customs hold state
                if (customsDetection.type === "stop_request") {
                  // Start customs hold - this will block travel/jump actions
                  this.startCustomsHold();
                  this.log("customs", "📋 Scan in progress - waiting for clearance...");
                  logCustomsStop(this.username, this.system, this.poi, "pending");

                  // Send AI chat response to customs (only once per entire customs encounter)
                  // Check both aiResponseSent flag AND if we're still in the same hold session
                  if (!this.customsHold.aiResponseSent) {
                    sendCustomsChatResponse(this, (cat, msg) => this.log(cat, msg), {
                      messageType: "stop_request",
                      customsMessage: content,
                      botStops: customsStats.totalStops,
                    });
                    this.customsHold.aiResponseSent = true;
                    this.log("customs_debug", "AI customs response sent");
                  } else {
                    this.log("customs_debug", "AI response already sent for this customs encounter - skipping");
                  }
                } else if (customsDetection.type === "cleared") {
                  // Clear the hold - scan complete, all good
                  this.clearCustomsHold("cleared");
                  logCustomsStop(this.username, this.system, this.poi, "cleared");
                  // No AI response for clearance - just log and continue
                } else if (customsDetection.type === "contraband") {
                  // Clear hold - contraband found, penalty process complete
                  this.clearCustomsHold("contraband");
                  this.log("customs", "⚠️ Contraband detected - penalty process complete");
                  logCustomsStop(this.username, this.system, this.poi, "contraband");
                  // No AI response for contraband - just log and continue
                } else if (customsDetection.type === "evasion_warning") {
                  // Clear hold - evasion noted, process complete
                  this.clearCustomsHold("evasion");
                  this.log("customs", "⚠️ Evasion warning - process complete");
                  logCustomsStop(this.username, this.system, this.poi, "evasion");
                  // No AI response for evasion - just log and continue
                }
              }

              // Don't forward customs messages to general AI Chat service
              // (we handle them separately with sendCustomsChatResponse)
              this.log("customs_debug", "Customs message - skipping general AI Chat forwarding");
              continue; // Skip the addChatMessage() call below
            }
            // End of isFromCustoms block - non-customs messages fall through
          }

          // Route NON-customs messages to AI chat handler
          if (aiChatService && typeof aiChatService.addChatMessage === "function") {
            aiChatService.addChatMessage({
              sender,
              channel: channel as "local" | "faction" | "system" | "private",
              content,
              timestamp: Date.now(),
              botUsername: this.username,
              botSystem: this.system,
              botPoi: this.poi,
              targetId: channel === "private" ? (data.sender_id as string) : undefined,
            });
            this.log("ai_chat", `Forwarded to AI Chat service: ${sender}`);
          } else {
            this.log("debug", `AI Chat service not available (service=${!!aiChatService}, addChatMessage=${typeof aiChatService?.addChatMessage === "function"})`);
          }
          
          // ── RESCUE COOPERATION: Process private messages for cooperation claims ──
          if (channel === "private") {
            const senderId = data.sender_id as string | undefined;
            const result = processCooperationPrivateMessage(sender, content, senderId);
            
            if (result.isClaim && result.claim) {
              this.log("coop", `📧 Processed claim from ${sender}: ${result.claim.player} at ${result.claim.system} (${result.claim.jumps} jumps by ${result.claim.botName})`);
            } else if (result.skipReason) {
              this.log("coop_debug", `Skipped private message from ${sender}: ${result.skipReason}`);
            }
            
            if (senderId && result.isClaim) {
              this.log("coop_debug", `Cached player ID for ${sender}: ${senderId}`);
            }
          }
        } else {
          this.log("debug", `Chat message received but data is not object: ${typeof data}`);
        }
        continue;
      }

      let data = notif.data as Record<string, unknown> | string | undefined;
      if (typeof data === "string") {
        try { data = JSON.parse(data) as Record<string, unknown>; } catch { /* leave as string */ }
      }

      if (type === "system" && data && typeof data === "object") {
        const d = data as Record<string, unknown>;

        if (d.damage !== undefined) {
          const pirateName = (d.pirate_name as string) || "Unknown";
          const pirateT    = (d.pirate_tier as string) || "";
          const damage     = (d.damage as number) ?? 0;
          const damageType = (d.damage_type as string) || "";
          const yourHull   = d.your_hull as number | undefined;
          const maxHull    = d.your_max_hull as number | undefined;
          const yourShield = d.your_shield as number | undefined;

          const hullStr   = yourHull !== undefined && maxHull !== undefined
            ? ` | Hull: ${yourHull}/${maxHull} (${maxHull > 0 ? Math.round((yourHull / maxHull) * 100) : 100}%)`
            : "";
          const shieldStr = yourShield !== undefined ? ` | Shield: ${yourShield}` : "";

          this.log("combat",
            `UNDER ATTACK! ${pirateName}${pirateT ? ` (${pirateT})` : ""} dealt ${damage} ${damageType} dmg${hullStr}${shieldStr}`
          );

          // Track pirate name
          if (pirateName && pirateName !== "Unknown") {
            playerNameStore.add(pirateName);
          }

          // Combat chat alerts disabled — was spamming faction chat
          // const now = Date.now();
          // if (now - this.lastCombatAlertMs > Bot.COMBAT_ALERT_COOLDOWN_MS) {
          //   this.lastCombatAlertMs = now;
          //   await this.sendCombatFactionAlert(
          //     pirateName, pirateT, damage, damageType,
          //     yourHull ?? this.hull, maxHull ?? this.maxHull, yourShield,
          //   );
          // }

          if (yourHull !== undefined) this.hull = yourHull;
          if (yourShield !== undefined) this.shield = yourShield;

          // Record pirate sighting for map intelligence
          if (this.system) {
            mapStore.recordPirate(this.system, { player_id: pirateName, name: pirateName });
          }

        } else {
          const message = (d.message as string) || "";
          if (message) {
            const msgLower = message.toLowerCase();
            const isCombatWarning =
              msgLower.includes("attack") ||
              msgLower.includes("detected you") ||
              msgLower.includes("hostile");
            this.log(isCombatWarning ? "combat" : "info", `[SYSTEM] ${message}`);
            // Combat warning chat alerts disabled — was spamming faction chat
            // if (isCombatWarning) {
            //   const now = Date.now();
            //   if (now - this.lastWarningAlertMs > Bot.WARNING_ALERT_COOLDOWN_MS) {
            //     this.lastWarningAlertMs = now;
            //     await this.sendWarningFactionAlert(message);
            //   }
            // }
          }
        }

      } else if (type === "combat" && data && typeof data === "object") {
        const d = data as Record<string, unknown>;
        const message = (d.message as string) || "";
        if (message) this.log("combat", `[COMBAT] ${message}`);
      }
    }
  }

  /** Post a faction chat alert with attack details, location, and nearby entities. */
  private async sendCombatFactionAlert(
    pirateName: string,
    pirateT: string,
    damage: number,
    damageType: string,
    yourHull: number,
    maxHull: number,
    yourShield: number | undefined,
  ): Promise<void> {
    try {
      let nearbyInfo = "";
      const nearbyResp = await this.api.execute("get_nearby");
      
      // Track players from nearby response
      if (nearbyResp.result) {
        this.trackNearbyPlayers(nearbyResp.result);
      }
      
      if (nearbyResp.result && typeof nearbyResp.result === "object") {
        const nearby = nearbyResp.result as Record<string, unknown>;

        const players = Array.isArray(nearby.players)
          ? (nearby.players as Array<Record<string, unknown>>)
          : [];
        const pirates = Array.isArray(nearby.pirates)
          ? (nearby.pirates as Array<Record<string, unknown>>)
          : [];

        if (players.length > 0) {
          const names = players
            .map(p => (p.username as string) || (p.name as string) || "?")
            .join(", ");
          nearbyInfo += ` | Players: ${names}`;
        }
        if (pirates.length > 0) {
          const ps = pirates
            .map(p => `${(p.name as string) || (p.type as string) || "?"}${p.tier ? ` (${p.tier})` : ""}`)
            .join(", ");
          nearbyInfo += ` | Pirates: ${ps}`;
        }
      }

      const hullPct = maxHull > 0 ? Math.round((yourHull / maxHull) * 100) : 100;
      const shieldStr = yourShield !== undefined ? ` Shield: ${yourShield}` : "";
      const content = `[HULL DAMAGE] ${this.username} hit by ${pirateName}${pirateT ? ` (${pirateT})` : ""} — ${damage} ${damageType} dmg | Hull: ${yourHull}/${maxHull} (${hullPct}%)${shieldStr} | ${this.system}/${this.poi}${nearbyInfo}`;

      await this.api.execute("chat", { channel: "faction", content });
      this.log("combat", `Faction alert sent: ${pirateName} at ${this.system}`);
    } catch (err) {
      this.log("error", `Combat alert failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Post a faction chat warning about an imminent attack or pirate detection. */
  private async sendWarningFactionAlert(message: string): Promise<void> {
    try {
      const content = `[COMBAT WARNING] ${this.username} — ${message} | ${this.system}/${this.poi}`;
      await this.api.execute("chat", { channel: "faction", content });
      this.log("combat", `Faction warning sent`);
    } catch (err) {
      this.log("error", `Warning alert failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Extract and track player names from a get_nearby response.
   * Handles players, pirates, ships, and other entity arrays.
   */
  trackNearbyPlayers(nearbyResult: unknown): void {
    if (!nearbyResult || typeof nearbyResult !== "object") {
      this.log("debug", "trackNearbyPlayers: no result or not object");
      return;
    }

    const data = nearbyResult as Record<string, unknown>;
    
    // Debug: log what keys we have
    debugLog("playernames:track", `${this.username}`, `get_nearby result keys: ${Object.keys(data).join(", ")}`);

    // Extract from various possible array formats (objects, nearby, ships, players, pirates)
    const arraysToCheck = [
      Array.isArray(data.objects) ? data.objects : [],
      Array.isArray(data.nearby) ? data.nearby : [],
      Array.isArray(data.ships) ? data.ships : [],
      Array.isArray(data.players) ? data.players : [],
      Array.isArray(data.pirates) ? data.pirates : [],
      Array.isArray(data.nearby_players) ? data.nearby_players : [],
    ];

    let count = 0;
    let totalFound = 0;
    for (const arr of arraysToCheck) {
      totalFound += arr.length;
      for (const entity of arr as Array<Record<string, unknown>>) {
        // Try various field names for player/ship names
        const name = (entity.username as string) ||
                     (entity.name as string) ||
                     (entity.player_name as string) ||
                     (entity.ship_name as string);

        if (name && name.trim()) {
          if (playerNameStore.add(name)) {
            count++;
          }
        }
      }
    }

    debugLog("playernames:track", `${this.username}`, `Found ${totalFound} entities, ${count} new names`);

    if (count > 0) {
      this.log("playernames", `Discovered ${count} new player(s) from nearby scan`);
    }
  }

  /**
   * Track faction member names from faction data.
   * Call this after loading faction info to record all members.
   */
  trackFactionMembers(factionData: unknown): void {
    if (!factionData || typeof factionData !== "object") {
      return;
    }

    const data = factionData as Record<string, unknown>;
    const members = Array.isArray(data.members) ? data.members : [];
    
    let count = 0;
    for (const member of members as Array<Record<string, unknown>>) {
      const name = (member.username as string) || (member.player_name as string) || (member.name as string);
      if (name && name.trim()) {
        if (playerNameStore.add(name)) {
          count++;
        }
      }
    }

    if (count > 0) {
      this.log("playernames", `Discovered ${count} new faction member(s)`);
    }
  }

  /**
   * Track player names from battle/scan results.
   * Handles battle participants, scan targets, and similar arrays.
   */
  trackBattleParticipants(resultData: unknown): void {
    if (!resultData || typeof resultData !== "object") {
      return;
    }

    const data = resultData as Record<string, unknown>;
    
    // Extract from various possible array formats
    const arraysToCheck = [
      Array.isArray(data.participants) ? data.participants : [],
      Array.isArray(data.targets) ? data.targets : [],
      Array.isArray(data.sides) ? data.sides : [],
    ];

    let count = 0;
    for (const arr of arraysToCheck) {
      for (const entity of arr as Array<Record<string, unknown>>) {
        const name = (entity.username as string) || 
                     (entity.player_name as string) || 
                     (entity.name as string);
        
        if (name && name.trim()) {
          if (playerNameStore.add(name)) {
            count++;
          }
        }
      }
    }

    if (count > 0) {
      this.log("playernames", `Discovered ${count} new player(s) from battle/scan`);
    }
  }

  /** Signal the bot to stop after the current action. */
  stop(): void {
    if (this._state !== "running") return;
    this._state = "stopping";
    this._abortController?.abort();
    this.log("system", "Stop requested — will halt after current action");
  }

  /** Get a summary of the bot's current state. */
  status(): BotStatus {
    return {
      username: this.username,
      state: this._state,
      routine: this._routine,
      credits: this.credits,
      fuel: this.fuel,
      maxFuel: this.maxFuel,
      cargo: this.cargo,
      cargoMax: this.cargoMax,
      location: this.location,
      system: this.system,
      poi: this.poi,
      docked: this.docked,
      lastAction: this._lastAction,
      error: this._error,
      shipName: this.shipName,
      hull: this.hull,
      maxHull: this.maxHull,
      shield: this.shield,
      maxShield: this.maxShield,
      ammo: this.ammo,
      inventory: this.inventory,
      storage: this.storage,
      stats: { ...this.stats },
    };
  }
}

const CATEGORY_COLORS: Record<string, string> = {
  system: "\x1b[34m",
  mining: "\x1b[32m",
  travel: "\x1b[36m",
  trade: "\x1b[33m",
  error: "\x1b[91m",
  info: "\x1b[37m",
  combat: "\x1b[31m",
  skill: "\x1b[95m",
  scavenge: "\x1b[33m",
  rescue: "\x1b[96m",
};

function getCategoryColor(category: string): string {
  return CATEGORY_COLORS[category] || CATEGORY_COLORS.info;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
