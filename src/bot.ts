import { SpaceMoltAPI, type ApiResponse } from "./api.js";
import { SessionManager, type Credentials } from "./session.js";
import { log, logError, logNotifications } from "./ui.js";
import { debugLog } from "./debug.js";
import { mapStore } from "./mapstore.js";
import { addMaydayRequest, parseMaydayMessage } from "./mayday.js";

export type BotState = "idle" | "running" | "stopping" | "error";

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

  constructor(username: string, baseDir: string) {
    this.username = username;
    this.api = new SpaceMoltAPI();
    this.api.setBotName(username);
    this.session = new SessionManager(username, baseDir);
    this.color = BOT_COLORS[colorIndex % BOT_COLORS.length];
    colorIndex++;
  }

  get state(): BotState {
    return this._state;
  }

  get routineName(): string | null {
    return this._routine;
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
    this._lastAction = command;
    debugLog("bot:exec", `${this.username} > ${command}`, payload);
    let resp = await this.api.execute(command, payload);

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

    return resp;
  }

  /** Login using stored credentials. Returns true on success. */
  async login(): Promise<boolean> {
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

    // Always login if we have credentials — ensures fresh authenticated session
    // even if a stale session object exists in memory
    const creds = this.session.loadCredentials();
    if (creds) {
      const loggedIn = await this.login();
      if (!loggedIn) {
        // login() already set _state = "error" and _error; throw so the caller's
        // .catch() handler fires instead of .then() (which would log "routine finished").
        throw new Error(this._error || "Login failed");
      }
    } else {
      this._error = "No credentials found";
      this._state = "error";
      throw new Error(this._error);
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

          this.log("chat", `Received [${channel}] ${sender}: ${content}`);

          // Check for MAYDAY emergency rescue requests
          if (channel === "emergency" || content.includes("MAYDAY")) {
            const mayday = parseMaydayMessage(content, sender, Date.now(), this.username, this.system, this.poi);
            if (mayday) {
              const added = addMaydayRequest(mayday);
              if (added) {
                this.log("mayday", `🚨 MAYDAY received from ${mayday.sender} at ${mayday.system}/${mayday.poi} (${mayday.fuelPct}% fuel)`);
              }
            }
          }

          // Route to AI chat handler if available
          if (aiChatService && typeof aiChatService.addChatMessage === "function") {
            aiChatService.addChatMessage({
              sender,
              channel: channel as "local" | "faction" | "system" | "private",
              content,
              timestamp: Date.now(),
              botUsername: this.username,
              botSystem: this.system,
              botPoi: this.poi,
            });
            this.log("ai_chat", `Forwarded to AI Chat service: ${sender}`);
          } else {
            this.log("debug", `AI Chat service not available (service=${!!aiChatService}, addChatMessage=${typeof aiChatService?.addChatMessage === "function"})`);
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
