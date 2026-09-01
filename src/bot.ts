import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { type ApiResponse, COMMAND_TOOL_MAP, buildLibDispatch, extractLibResult } from "./commandBridge.js";
import { log, logError, logNotifications } from "./ui.js";
import { debugLogForBot, combatDebugLog } from "./debug.js";
import { isCombatDebugEnabled } from "./routines/common.js";
import { measureSend } from "./sendMetrics.js";
import { perf } from "./perf.js";
import { mapStore } from "./mapstore.js";
import type { NotificationMarketUpdate } from "@spacemolt/lib";
import { marketStreamStore } from "./marketstreamstore.js";
import { addMaydayRequest, parseMaydayMessage, isIgnoredMaydaySender, shouldLogIgnoredMayday } from "./mayday.js";
import { playerNameStore } from "./playernamestore.js";
import { wildlifeStore, type SurveyWildlifeEntry, type FaintSignature, type ObservedCreature } from "./wildlivestore.js";
import { detectCustomsMessage, logCustomsStop, getBotCustomsStats, sendCustomsChatResponse, isEmpireSystem } from "./customs.js";
import { getFactionStorageCache, getFactionStorageCacheByStationOnly, updateFactionStorageCache, isFactionStorageCacheStale } from "./factionStorageCache.js";
import { recordPilotingActivity, recordSkillGains } from "./pilotSkillTracker.js";
import { logSkills } from "./skillTracker.js";
import { setPathfinderTravelState, updatePathfinderTravelTick, recordPathfinderCorrection, clearPathfinderTravel, getActivePathfinderTravel, type PathfinderTravelRecord, getDirectPathfinderJump, getCorrectionPathfinderJump, getCorrectionBearingAtTick, isPathfinderLandingAtVoid, type CorrectionPathfinderJump, getMccWindowInfo, type MccWindowInfo } from "./pathfinder.js";
import { saveTaxEstimate, hasTaxEstimateChanged, type TaxEstimate, saveFactionTaxEstimate, type FactionTaxEstimate } from "./taxData.js";
import { chatBuffer } from "./chatbuffer.js";
import { loadSettings, saveStoppedState, saveLastUsedRoutine, isCustomsDisabled } from "./web/server.js";
import { ensureInsured } from "./routines/common.js";
import { type Account, type Commands, type TypedNotificationType, TYPED_NOTIFICATION_TYPES, type RawFrame } from "@spacemolt/lib";
import { isConnectionError } from "./connection.js";

/** A login() promise older than this (ms) is treated as wedged and reset, so a
 *  dead socket can never permanently park the routine on an unresolved promise. */
const LOGIN_WEDGE_TIMEOUT_MS = 60_000;
import { catalogStore } from "./catalogstore.js";
import { extractShipModules, moduleTypeId } from "./shipmodules.js";
import { isPirateTarget, isCreatureTarget, isCreatureName } from "./routines/battle.js";

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
  shipClass: string;
  tier: number | null;
  hull: number;
  maxHull: number;
  shield: number;
  maxShield: number;
  ammo: number;
  inventory: CargoItem[];
  storage: CargoItem[];
  stats: BotStats;
  stopAfterCycle: boolean;
  skills?: Record<string, { level: number; xp: number; xpToNext?: number; totalXP?: number }>;
  factionFuelReserve?: number;
  factionFuelCapacity?: number;
  /** Home station's OWN base fuel (base.fuel), captured when a bot is at the configured home POI. */
  homeBaseFuel?: number;
  homeBaseMaxFuel?: number;
  /** Hex POI id the homeBaseFuel was last captured for. */
  homeBaseFuelPoi?: string;
  faction: string | null;
  isCloaked: boolean;
  /**
   * Whether the active ship has an Emergency Warp Stabilizer (EWS) module
   * installed. null = unknown (no ship data yet). false = known NOT equipped
   * (ship will be destroyed if it enters battle). Surfaced on the dashboard
   * with a red dot next to the bot name.
   */
  hasEmergencyWarpStabilizer: boolean | null;
  /**
   * Outstanding bounties (in credits) keyed by faction name, parsed from
   * get_status `player.standings[faction].outstanding_bounty`. Surfaced on the
   * dashboard with a jail-bars indicator next to the bot name when non-empty.
   * Empty object = no bounties / unknown.
   */
  bounties: Record<string, number>;
  inBattle?: boolean;
  battleId?: string | null;
  /**
   * Transient flag set only for bot cards that have been rehydrated from the
   * persisted active-bot snapshot at client startup — i.e. bots that were
   * active last run but have not yet reconnected this session. The dashboard
   * renders these with a "Reconnecting…" badge so the fleet list is stable
   * across restarts instead of popping in one card at a time. Cleared as soon
   * as a live status update arrives for the bot.
   */
  offline?: boolean;
}

export interface RoutineContext {
  bot: Bot;
  log: (category: string, message: string) => void;
  /** Interruptible sleep - checks for stop signal periodically. */
  sleep: (ms: number) => Promise<void>;
  /** Optional: get status of all bots in the fleet (used by rescue routine). */
  getFleetStatus?: () => BotStatus[];
  /** Optional: get fresh status for a specific bot by name (used by rescue routine for credit checks). */
  getBotFreshStatus?: (botName: string) => Promise<BotStatus | null>;
  /** Optional: get fleet status across ALL connected clients (cross-client rescue poll). */
  getFleetStatusAsync?: () => Promise<BotStatus[]>;
  /** Optional: send a chat message to other bots. */
  sendBotChat?: (
    content: string,
    channel: string,
    recipients?: string[],
    metadata?: Record<string, unknown>
  ) => void;
  /** Optional: get all bot usernames. */
  getAllBotNames?: () => string[];
  /** Optional: get bot assignments (maps bot name to routine key). */
  getBotAssignments?: () => Record<string, string>;
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

/**
 * Commands whose response carries the full post-action cargo hold (and updated
 * ship cargo used/capacity + credits). After any of these succeeds we adopt the
 * returned `cargo` array straight into `this.inventory` so the cargo viewer is
 * current the instant the command responds — no follow-up get_cargo needed —
 * and fire the immediate-UI-push hook. These are the item-moving storage/market
 * commands the cargo mover fires in bursts. `storage` is the unified v2 command
 * (deposit/withdraw/loot/jettison via payload.action).
 */
const CARGO_AFFECTING_COMMANDS = new Set<string>([
  "storage",
  "deposit_items",
  "withdraw_items",
  "faction_deposit_items",
  "faction_withdraw_items",
  "send_gift",
  "loot_wreck",
  "jettison",
  "buy",
  "sell",
]);

let colorIndex = 0;

export class Bot {
  readonly username: string;
  /** Live library-backed connection, set when the bot runner is driven through @spacemolt/lib. */
  account: Account | null = null;
  /** Unsubscribe functions for the event subscriptions registered in `subscribeEvents`. */
  private eventUnsubscribers: Array<() => void> = [];
  /** Unsubscribe function for the realtime market push stream (only used by trade routines). */
  private marketUnsubscriber: (() => void) | null = null;
  private baseDir: string;
  private color: string;
  private _state: BotState = "idle";
  private _routine: string | null = null;
  private _lastAction = "";
  private _error: string | null = null;
  private _abortController: AbortController | null = null;
  private pendingCommands = new Map<string, AbortController>();
  private lastSystem = "unknown";
  private lastPoi = "";
  private _lastTimeoutLog = 0;
  private _lastTimeoutCommand = "";

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
  shipId = "";
  shipClass = "";
  tier: number | null = null;
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

  /** Which station the `factionStorage` cache currently represents (the resolved
   *  station id of the last successful read). Faction storage is PER-STATION, so
   *  a read of a *different* station must always replace the cache — even if the
   *  new read carries far less quantity. Only a read of the SAME station may be
   *  rejected as a degraded (partial) payload. */
  factionStorageStation: string | null = null;

  /** Cached faction ID from last get_status (null if not in a faction). */
  faction: string | null = null;

  /**
   * Optional callback fired (fire-and-forget) the moment this bot transitions
   * from undocked to docked, as detected by `applyStatusResult`. Used to trigger
   * dock-time housekeeping (e.g. tax prepay) without polling. Set by the
   * botmanager; bot.ts never calls it directly.
   */
  onDocked?: () => void;

  /**
   * Optional callback fired (fire-and-forget) whenever this bot's cached cargo,
   * personal storage, or faction storage changes as a direct result of a
   * command response (deposit/withdraw/gift/buy/sell/etc.), so the dashboard can
   * push an IMMEDIATE status broadcast instead of waiting for the next periodic
   * (~2s) refresh tick. This is what keeps the cargo/storage viewers "peppy"
   * during a cargo-mover run that fires many storage commands in quick
   * succession. Set by the botmanager; bot.ts only invokes it.
   */
  onStateChanged?: () => void;

  /** Throttle timer for onStateChanged so a burst of storage commands coalesces
   *  into a small number of broadcasts instead of one per command. */
  private _stateChangedTimer: ReturnType<typeof setTimeout> | null = null;

  /** Cached faction fuel reserve from last view_faction_storage. */
  factionFuelReserve: number = 0;

  /** Cached faction fuel capacity from last view_faction_storage. */
  factionFuelCapacity: number = 0;

  /**
   * Base fuel of the configured global home station (settings.general.factionStorageStation),
   * captured from get_poi/get_base results when a bot is physically at that POI.
   * This is the station's own fuel reserve (base.fuel), distinct from faction storage fuel.
   */
  homeBaseFuel: number = 0;
  homeBaseMaxFuel: number = 0;
  /** Hex POI id the homeBaseFuel was last captured for (to avoid stale cross-station hits). */
  homeBaseFuelPoi: string = "";

  /** Whether the bot's ship is currently cloaked. */
  isCloaked = false;

  /** Whether the bot's ship is dead (hull <= 0). */
  isDead = false;

  /**
   * Set when the library reports this account's socket is gone for good
   * (terminal close: `session_replaced` 4001 / `auth_timeout` 4002, or reconnect
   * retries exhausted). Unlike a routine server-restart blip — which the library
   * auto-reconnects in place and flips `authenticated` back to true — a terminal
   * close means this bot is connected ELSEWHERE and can never send commands here.
   * The dispatch layer uses this to stop waiting for a reconnect that will never
   * come, so the running routine ends cleanly instead of blocking forever.
   */
  private _terminalClosed = false;

  /** Clear the terminal-close guard (e.g. when a forced reconnect is requested). */
  clearTerminalClosed(): void {
    this._terminalClosed = false;
  }

  /**
   * Mark this bot's socket as gone-for-good (the library fired
   * `onAccountDisconnected` — a terminal close, or its in-place reconnect
   * retries exhausted). The single coalesced `runRecovery` loop reads this to
   * escalate from "wait for the library" to "request one forced fresh socket".
   */
  markTerminalClosed(): void {
    this._terminalClosed = true;
  }

  /**
   * The ONE in-flight socket-recovery promise for this bot, shared by every
   * concurrent `sendResilient` caller. Without this, each of the (potentially
   * dozens of) commands in flight when a socket drops spawned its OWN
   * `waitForFreshSocket` loop — each with its own force-reconnect cadence and
   * counter — so we'd fire `client.remove()` + `connectOwned()` many times per
   * second. Every new socket the server saw looked like a duplicate login and
   * got answered with `session_replaced` (4001), which killed the previous
   * socket and re-armed the whole storm. That self-inflicted dupe-login loop is
   * the "she won't reconnect until I stop the routine" bug: the instant the
   * routine stopped and the storm ceased, the library's single in-place
   * reconnect finally stuck. Coalescing to one shared recovery promise is what
   * lets the library's own reconnect win.
   */
  private _recovery: Promise<boolean> | null = null;

  /** Progressive backoff (ms) applied after a rate-limit/IP-block error, so we
   *  stop hammering the server and let the temporary block window elapse. Grows
   *  by 30s per hit (capped at 5min) and resets after a clean command. */
  private _rateLimitBackoff = 30_000;

  /** Whether the bot is currently towing a wreck. */
  towingWreck = false;

  /** Whether the bot is currently in transit (jumping/traveling). */
  inTransit = false;

  /** Type of current transit: "jump" or "travel" (if in_transit is true). */
  transitType: "jump" | "travel" | null = null;

  /** Ticks remaining until transit completes (if in_transit is true). */
  ticksRemaining: number | null = null;

  /** The ID of the wreck being towed (if any). */
  towingWreckId: string | null = null;

shipSpeed = 1;
    hasPathfinderDrive = false;
    hasEmergencyWarpStabilizer: boolean | null = null;
    installedMods: string[] = [];
    hasLeadLinedCargoHold: boolean | null = null;
  private _prevHullPct: number = 100;
  private _prevHasEws: boolean | null = null;
  private _ewsFallbackTriggered = false;
  /** Outstanding bounties (credits) keyed by faction. Parsed in applyStatusResult. */
  bounties: Record<string, number> = {};
  lastKnownTick?: number;

  /** Accumulated stats for this bot. */
  stats: BotStats = { totalMined: 0, totalCrafted: 0, totalTrades: 0, totalProfit: 0, totalSystems: 0 };

  /** Bot-specific settings loaded from disk. */
  settings?: Record<string, unknown>;

  /** Maps a subscribed base_id to the {systemId, poiId} it was subscribed from (for dashboard mirror). */


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

  /** Global battle state - updated by WebSocket notifications even when HTTP is hanging */
  currentBattle: {
    inBattle: boolean;
    battleId: string | null;
    lastUpdate: number; // Timestamp of last battle update
    participants: Array<Record<string, unknown>>;
  } = { inBattle: false, battleId: null, lastUpdate: 0, participants: [] };

  /** Track the last known observation subscription ID and its cached presence data.
   *  This replaces polling get_nearby with the live observation feed. */
  observationSession: { id: string; poi_id: string; system_id: string } | null = null;
  observationNearby: Array<Record<string, unknown>> = [];
  observationSystemAgents: Array<Record<string, unknown>> = [];
  observationUnknownSignature = false;
  observationActiveScan = false;
  observationTick = 0;

  /** Set of queued crafting job IDs to prevent duplicate submissions. */
  private queuedCraftingJobs: Set<string> = new Set();

  /** Tracks active crafting queue jobs with server-assigned job IDs. */
  craftQueueTracker: import("./routines/craftQueueTracker.js").CraftQueueTracker | null = null;

  // Per-bot cache of the last `craft` queue fetch. CRITICAL: the crafter routine
  // used to cache the queue at MODULE level, which is shared by every bot running
  // in this process — so one drone would receive ANOTHER drone's queue (and its
  // phantom "pending", e.g. 148k fuel_reserve) whenever the refresh cooldown was
  // still active. Storing it per-bot guarantees each bot only ever sees its OWN
  // crafting queue from its own `craft` command.
  craftQueueCache: {
    lastQueueCheck: number;
    jobs: import("./routines/craftQueueTracker.js").ServerJobInfo[];
  } = { lastQueueCheck: 0, jobs: [] };

  // Per-bot facility round-robin cursor. Module-level sharing would make every
  // drone route the same recipe to the same facility index.
  facilityRoundRobin: Map<string, number> = new Map();

  // Per-bot dedupe of "no owned facility" warnings.
  notifiedMissingFacilities: Set<string> = new Set();

  /**
   * Generate a unique job ID for a crafting job.
   * Uses recipe_id (as returned in notifications) to prevent duplicates.
   */
  makeCraftingJobId(recipeId: string, quantity: number): string {
    return `${recipeId}:${quantity}`;
  }

  /** Check if a crafting job is already queued. */
  isCraftingJobQueued(recipeId: string, quantity: number): boolean {
    return this.queuedCraftingJobs.has(this.makeCraftingJobId(recipeId, quantity));
  }

  /** Mark a crafting job as queued. */
  queueCraftingJob(recipeId: string, quantity: number): void {
    this.queuedCraftingJobs.add(this.makeCraftingJobId(recipeId, quantity));
  }

  /** Remove a crafting job from the queue (when completed or cancelled). */
  unqueueCraftingJob(recipeId: string, quantity: number): void {
    this.queuedCraftingJobs.delete(this.makeCraftingJobId(recipeId, quantity));
  }

  /** Clear all queued crafting jobs. */
  clearCraftingQueue(): void {
    this.queuedCraftingJobs.clear();
  }

  /** Clear crafting jobs by recipe_id prefix (for server notifications that don't include quantity). */
  clearCraftingJobByRecipe(recipeId: string): void {
    for (const key of [...this.queuedCraftingJobs]) {
      if (key.startsWith(`${recipeId}:`)) {
        this.queuedCraftingJobs.delete(key);
      }
    }
  }

  /** Timestamp when customs hold was last cleared (prevents rapid re-triggering). */
  private customsClearedAt: number = 0;

  /** Track last customs message content to prevent duplicate processing. */
  private lastCustomsMessage: string = "";
  private lastCustomsMessageTime: number = 0;

  /** Track last chat message content to prevent duplicate processing. */
  private lastChatMessage: string = "";
  private lastChatMessageTime: number = 0;
  private lastChatSender: string = "";
  private lastChatChannel: string = "";

  /** Cooldown after customs clears before new hold can start (prevents rapid re-triggering). */
  private static readonly CUSTOMS_COOLDOWN_MS = 120000; // 2 minutes

  /** Optional callback for routing log output (e.g. to TUI). */
  onLog?: (username: string, category: string, message: string) => void;

  /** Optional callback for faction activity log entries. */
  onFactionLog?: (username: string, line: string) => void;

   /** Cached skill levels for detecting level-ups. */
   private skillLevels: Map<string, number> = new Map();
   /** Cached skill XP for tracking gains. */
   private skillXP: Map<string, number> = new Map();
   /** Cached total cumulative XP (if available from API). */
   private skillTotalXP: Map<string, number> = new Map();
   /** Cached XP-to-next for accurate gain calculation across level-ups. */
   private skillXpToNext: Map<string, number> = new Map();
   /** Snapshot of skills (level, XP, totalXP, xpToNext) taken before a command to measure gains. */
   private skillSnapshot: Map<string, { level: number; xp: number; totalXP?: number; xpToNext?: number }> = new Map();

   /** Timestamp of the last faction combat alert (ms). Rate-limits chat spam. */
  private lastCombatAlertMs = 0;
  private static readonly COMBAT_ALERT_COOLDOWN_MS = 30_000;

  /** Timestamp of the last combat warning alert (separate from hull-damage alerts). */
  private lastWarningAlertMs = 0;
  private static readonly WARNING_ALERT_COOLDOWN_MS = 60_000;

  /** Timestamp of the last battle response to AI chat service (ms). Prevents spam. */
  private lastBattleResponseMs = 0;
  private static readonly BATTLE_RESPONSE_COOLDOWN_MS = 15000;

  /** Track ongoing login to prevent duplicate concurrent logins */
  private _loginPromise: Promise<boolean> | null = null;
  /** When the current (or last) login() promise was started — used to detect a
   *  wedged login (one whose underlying doLogin never settled, e.g. a
   *  refreshStatus stuck waiting on a dead socket) so we can reset it instead of
   *  waiting on a promise that will never resolve. */
  private _loginStartedAt = 0;

  /** Flag to request stop after current cycle completes (for civilian transport). */
  private _stopAfterCycle = false;

  constructor(username: string, baseDir: string, account?: Account | null) {
    this.username = username;
    this.baseDir = baseDir;
    this.account = account ?? null;
    this.instrumentSend();
    this.color = BOT_COLORS[colorIndex % BOT_COLORS.length];
    colorIndex++;

    // Initialize player name tracking
    playerNameStore.setBotName(username);
  }

  /**
   * Install a measurement + connection-loss wrapper over this bot's library
   * `Account.send`. This is the ONE chokepoint every outbound command funnels
   * through — both `Bot.libExec` AND the direct `bot.commands.spacemolt.*()`
   * calls the routines make (hundreds of sites) call `account.send` underneath.
   *
   * The wrapper times each attempt (measureSend) and, crucially, makes the
   * socket drop transparent to callers: if `send` throws a connection error
   * ("cannot send on a closed socket" / "WebSocket connection closed") the
   * command was NEVER delivered to the server, so it is always safe to resend
   * it once the socket is back. We block and retry the exact same call until
   * the library reconnects (account.authenticated flips true again) — so a
   * routine survives a server patch restart / network blip instead of
   * permanently failing and leaving the bot idle (== death). Idempotent
   * (`_instrumented`) so a reconnect that swaps in a fresh `Account` and the
   * constructor never double-wrap.
   */
  instrumentSend(): void {
    const account = this.account;
    if (!account) return;
    const tagged = account as unknown as {
      _instrumented?: boolean;
      _originalSend?: (t: string, a: string, p?: Record<string, unknown>) => Promise<unknown>;
      send: (t: string, a: string, p?: Record<string, unknown>) => Promise<unknown>;
    };
    if (tagged._instrumented) return;
    // Stash the UN-instrumented send on the account object itself so a later
    // reconnect that swaps in a fresh `Account` (and re-instruments IT) always
    // gives `sendResilient` the LIVE account's real send — never the dead
    // socket it replaced. Binding to this wrapper's captured `account` instead
    // was what let a forced reconnect open a new socket while the old, dead
    // `rawSend` kept being retried forever (the "stuck bot" hang).
    tagged._originalSend = account.send.bind(account);
    const self = this;
    tagged.send = (tool, action, payload) => self.sendResilient(tool, action, payload);
    tagged._instrumented = true;
  }

  /** The un-instrumented `send` of the CURRENT `Account`, or undefined if none. */
  private liveRawSend(): ((t: string, a: string, p?: Record<string, unknown>) => Promise<unknown>) | null {
    const acct = this.account as unknown as {
      _originalSend?: (t: string, a: string, p?: Record<string, unknown>) => Promise<unknown>;
      send?: (t: string, a: string, p?: Record<string, unknown>) => Promise<unknown>;
    } | null;
    if (!acct) return null;
    return acct._originalSend ?? (acct.send ? acct.send.bind(acct) : null);
  }

  /**
   * Resilient `account.send`: on a transport/connection error, DROP the dead
   * socket and force a brand-new one — we never sit and hope a closed socket
   * magically revives (it won't, you told me). Used by the `instrumentSend`
   * wrapper so it covers EVERY command path (libExec and direct
   * bot.commands.*). Returns the result, or throws (the original error) only
   * when the recovery is aborted (bot stopped), the connection is terminal
   * (player connected elsewhere), or we exhaust the bounded force attempts — in
   * which case the caller should end the routine cleanly instead of hanging.
   *
   * Each retry uses the LIVE `Account`'s `send` (via `liveRawSend`), so after a
   * forced reconnect swaps in a fresh socket the very next attempt goes out on
   * the new socket — not the dead one it replaced.
   */
  private async sendResilient(
    tool: string,
    action: string,
    payload: Record<string, unknown> | undefined,
  ): Promise<unknown> {
    for (;;) {
      // If the socket is ALREADY observably closed (not just "not yet
      // authenticated"), there is zero point firing the send: it can ONLY throw
      // "cannot send on a closed socket" and spam the log with the very error
      // the user is sick of. Skip straight to the shared recovery wait, which
      // will drive a clean disconnect → close-wait → fresh-socket reconnect and
      // then resume the send on the live socket. This is what stops us from
      // "trying it when we know it's closed".
      if (this.getConnectionState() !== "connected") {
        const first = !this.hasActiveRecovery();
        if (first) {
          this.log("warn", `Socket already closed/disconnected — waiting for recovery before sending ${tool}/${action}...`);
        }
        const reconnected = await this.waitForFreshSocket();
        if (!reconnected) {
          throw new Error("socket closed (recovery aborted)");
        }
        // After recovery, fall through to actually attempt the send on the new
        // live socket (below). Stagger slightly so a fleet-wide recovery burst
        // doesn't simultaneously flood the server with identical commands.
        await new Promise((r) => setTimeout(r, Math.random() * 200));
        continue;
      }

      const rawSend = this.liveRawSend();
      if (!rawSend) throw new Error("no account");
      try {
        return await measureSend(() => rawSend(tool, action, payload));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!isConnectionError(message)) throw err;
        if (this.state === "stopping" || this._abortController?.signal.aborted) {
          throw err;
        }
        // A connection error means the socket dropped. The library is (or will
        // be) reconnecting the SAME Account in place — so we wait on the ONE
        // shared recovery promise rather than each command forcing its own fresh
        // socket (that was the duplicate-login storm). Only the first caller to
        // hit this actually logs + drives recovery; the rest silently await it.
        const first = !this.hasActiveRecovery();
        if (first) {
          this.log("warn", `Disconnected (${message}) — waiting for the socket to recover before resending...`);
        }
        const reconnected = await this.waitForFreshSocket();
        if (!reconnected) {
          throw err;
        }
        this.log("system", `Reconnected — resending ${tool}/${action}`);
        // After a recovery, many sendResilient callers share the same _recovery
        // promise and all resume at once. Stagger each retry by a small random
        // jitter so they don't simultaneously flood the server with a burst of
        // identical commands and trip the rate limiter / IP ban.
        await new Promise((r) => setTimeout(r, Math.random() * 200));
      }
    }
  }

  async initCraftQueueTracker(): Promise<void> {
    const { CraftQueueTracker } = await import("./routines/craftQueueTracker.js");
    this.craftQueueTracker = await CraftQueueTracker.create(this);
  }

  getCraftQueueTracker(): import("./routines/craftQueueTracker.js").CraftQueueTracker {
    if (!this.craftQueueTracker) throw new Error("CraftQueueTracker not initialized");
    return this.craftQueueTracker;
  }

  private logPosition(): void {
    const dataDir = join(this.baseDir, "data");
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }
    const logFile = join(dataDir, "bot_positions.csv");
    const header = "bot_name,time,system_id,poi_id\n";
    if (!existsSync(logFile)) {
      appendFileSync(logFile, header);
    }
    const time = new Date().toISOString();
    const line = `${this.username},${time},${this.system},${this.poi}\n`;
    appendFileSync(logFile, line);
  }

  get state(): BotState {
    return this._state;
  }

  get routineName(): string | null {
    return this._routine;
  }

  /**
   * Typed command facade from `@spacemolt/lib`. Every bot is backed by a live
   * `Account` (the legacy HTTP/credential path was retired in P4.1), so this is
   * always available. Call sites use it directly:
   * `bot.commands.<tool>.<action>(params)` per the library's API.
   */
  get commands(): Commands {
    return this.account!.commands;
  }

  clearError(): void {
    this._state = "idle";
    this._routine = null;
    this._error = null;
  }

  /** Get the bot's empire affiliation from the library account state. */
  getEmpire(): string {
    return this.account?.state.player?.empire ?? "";
  }

  /**
   * Execute an API command with a timeout. If the timeout fires, check if we
   * arrived at the target (success) or not (return timeout error for retry).
   */
  private async execWithTimeout(
    command: string,
    payload: Record<string, unknown> | undefined,
    timeoutMs: number,
    targetId: string,
    abortSignal?: AbortSignal,
  ): Promise<ApiResponse> {
    // Race the API call against a timeout and abort
    const apiPromise = this.libExec(command, payload);
    // If OUR timeout/abort wins the race, `apiPromise` is left pending. The
    // underlying library call may later reject (e.g. its own mutation-timeout
    // timer fires) — attach a no-op catch so that late rejection can never
    // become an unhandledRejection that crashes the whole process.
    apiPromise.catch(() => {});
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`TIMEOUT`)), timeoutMs);
    });
    const abortPromise = abortSignal ? new Promise<never>((_, reject) => {
      abortSignal.addEventListener('abort', () => reject(new Error('ABORTED')));
    }) : new Promise(() => {}); // Never resolves if no signal

    try {
      return await Promise.race([apiPromise, timeoutPromise, abortPromise]) as ApiResponse;
    } catch (err) {
      if (!(err instanceof Error) || (err.message !== "TIMEOUT" && err.message !== "ABORTED")) {
        throw err;
      }

      // A user-initiated stop/abort should never be reported as a timeout.
      if (err.message === "ABORTED") {
        return {
          error: { code: "aborted", message: `${command} aborted by user` },
          result: undefined,
          notifications: [],
        };
      }

      // Skip expensive position check on non-movement commands (get_cargo, get_status, etc.)
      // to prevent timeout cascades during heavy combat
      if (command !== "travel" && command !== "jump" && command !== "mine" && command !== "jettison") {
        return {
          error: { code: "timeout", message: `${command} timed out after ${timeoutMs / 1000}s` },
          result: undefined,
          notifications: [],
        };
      }

        this.log("warn", `${command} timed out after ${timeoutMs / 1000}s — checking position...`);
        // Refresh status to see where we actually are
        await this.refreshStatus();

        if (command === "jump" && targetId && !targetId.startsWith("bearing:")) {
          const normalizeSystemName = (name: string) => name.toLowerCase().replace(/_/g, ' ').trim();
          if (normalizeSystemName(this.system) === normalizeSystemName(targetId)) {
            this.log("travel", `✓ Timeout check: confirmed at target ${targetId} — treating as success`);
            return { error: undefined, result: { message: "Jump completed (timeout recovery)" }, notifications: [] };
          }
          
          // CRITICAL: Check if we're in battle (jump was interrupted by combat)
          // The battle state is tracked via WebSocket even when HTTP hangs
          if (this.currentBattle.inBattle) {
            this.log("combat", `Jump interrupted by battle! Battle ID: ${this.currentBattle.battleId} — we're in ${this.system}, not ${targetId}`);
            return {
              error: { code: "battle_interrupt", message: `Jump interrupted by battle ${this.currentBattle.battleId}` },
              result: undefined,
              notifications: [],
            };
          }
        }

        // For travel: check if we're at the target POI or system
        if (command === "travel" && targetId) {
          const normalize = (name: string) => name.toLowerCase().replace(/_/g, ' ').trim();
          // Target could be a POI ID or system ID
          if (normalize(this.poi) === normalize(targetId) || normalize(this.system) === normalize(targetId)) {
            this.log("travel", `✓ Timeout check: confirmed at target ${targetId} — treating as success`);
            return { error: undefined, result: { message: "Travel completed (timeout recovery)" }, notifications: [] };
          }
          
          // CRITICAL: Check if we're in battle (travel was interrupted by combat)
          if (this.currentBattle.inBattle) {
            this.log("combat", `Travel interrupted by battle! Battle ID: ${this.currentBattle.battleId} — we're in ${this.system}, not ${targetId}`);
            return {
              error: { code: "battle_interrupt", message: `Travel interrupted by battle ${this.currentBattle.battleId}` },
              result: undefined,
              notifications: [],
            };
          }
        }

        // For mine/jettison: check if interrupted by battle (timeout or abort)
        if ((command === "mine" || command === "jettison") && this.currentBattle.inBattle) {
          this.log("combat", `${command} interrupted by battle! Battle ID: ${this.currentBattle.battleId}`);
          return {
            error: { code: "battle_interrupt", message: `${command} interrupted by battle ${this.currentBattle.battleId}` },
            result: undefined,
            notifications: [],
          };
        }

        // Not at target — return timeout error so caller can retry
        // Debounce repeated identical timeout errors (common after battles)
        const now = Date.now();
        if (!this._lastTimeoutLog || now - this._lastTimeoutLog > 2000 || this._lastTimeoutCommand !== command) {
          this.log("error", `${command} timed out — not at target ${targetId} (currently at ${this.system}/${this.poi})`);
          this._lastTimeoutLog = now;
          this._lastTimeoutCommand = command;
        }
        return {
          error: { code: "timeout", message: `${command} timed out after ${timeoutMs / 1000}s` },
          result: undefined,
          notifications: [],
        };
    }
  }

  /**
   * Calculate the appropriate timeout for a jump command based on ship speed.
   * Uses configurable jump times from settings (with defaults if not set).
   * If towing a wreck, speed is reduced by 50% (timeout increased accordingly).
   * Adds configurable buffer (default 10s = 1 game tick) to the base jump time.
   */
  private calculateJumpTimeout(): number {
    // Get jump times from settings or use defaults
    const settings = (this as any).settings || {};
    const generalSettings = settings.general || {};

    const jumpTimes: Record<number, number> = {
      1: generalSettings.jumpSpeed1 || 80,
      2: generalSettings.jumpSpeed2 || 70,
      3: generalSettings.jumpSpeed3 || 60,
      4: generalSettings.jumpSpeed4 || 50,
      5: generalSettings.jumpSpeed5 || 40,
      6: generalSettings.jumpSpeed6 || 30,
    };

    const buffer = generalSettings.jumpBuffer || 10;
    let baseTime = jumpTimes[this.shipSpeed] || 80;

    // Apply 50% speed penalty if towing a wreck
    if (this.towingWreck) {
      baseTime = Math.round(baseTime * 1.5);
    }

    // Add buffer (1 game tick = 10s by default)
    const timeoutWithBuffer = baseTime + buffer;

    // Round up to next 10-second tick (game ticks every 10 seconds)
    const roundedTimeout = Math.ceil(timeoutWithBuffer / 10) * 10;

    return roundedTimeout * 1000; // Convert to milliseconds
  }

  /**
   * Calculate the appropriate timeout for a travel command based on ship speed.
   * Travel within a system is generally faster than jumps between systems.
   * Uses configurable travel times from settings (with defaults if not set).
   * If towing a wreck, speed is reduced by 50% (timeout increased accordingly).
   * Adds configurable buffer (default 5s) to the base travel time.
   */
  private calculateTravelTimeout(): number {
    // Use same timeout as jumps to prevent station travel timeouts
    const settings = (this as any).settings || {};
    const generalSettings = settings.general || {};

    const jumpTimes: Record<number, number> = {
      1: generalSettings.jumpSpeed1 || 80,
      2: generalSettings.jumpSpeed2 || 70,
      3: generalSettings.jumpSpeed3 || 60,
      4: generalSettings.jumpSpeed4 || 50,
      5: generalSettings.jumpSpeed5 || 40,
      6: generalSettings.jumpSpeed6 || 30,
    };

    const buffer = generalSettings.jumpBuffer || 10;
    let baseTime = jumpTimes[this.shipSpeed] || 80;

    // Apply 50% speed penalty if towing a wreck
    if (this.towingWreck) {
      baseTime = Math.round(baseTime * 1.5);
    }

    // Add buffer
    const timeoutWithBuffer = baseTime + buffer;

    // Round up to next 10-second tick (game ticks every 10 seconds)
    const roundedTimeout = Math.ceil(timeoutWithBuffer / 10) * 10;

    return roundedTimeout * 1000; // Convert to milliseconds
  }

  log(category: string, message: string): void {
    const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false });
    const line = `${timestamp} [${category}] ${message}`;
    this.actionLog.push(line);
    if (this.actionLog.length > this.maxLogEntries) {
      this.actionLog.shift();
    }

    // Emergency Warp Stabilizer detection — monitor ALL log lines
    // Check BEFORE logging to avoid recursion issues
    if (message.includes("Emergency Warp Stabilizer activated")) {
      // Log the emergency message directly without triggering another detection
      const emergencyLine = `${timestamp} [emergency] ⚠️ Emergency Warp Stabilizer triggered! Ship warped to safety.`;
      this.actionLog.push(emergencyLine);
      const stopLine = `${timestamp} [system] ⛔ Routine stopped — please install a new stabilizer before resuming.`;
      this.actionLog.push(stopLine);

      if (this.onLog) {
        this.onLog(this.username, "emergency", "⚠️ Emergency Warp Stabilizer triggered! Ship warped to safety.");
        this.onLog(this.username, "system", "⛔ Routine stopped — please install a new stabilizer before resuming.");
      } else {
        console.log(
          `\x1b[2m${timestamp}${RESET} ${this.color}[${this.username}]${RESET} ` +
            `\x1b[91m[emergency]${RESET} ⚠️ Emergency Warp Stabilizer triggered! Ship warped to safety.`
        );
        console.log(
          `\x1b[2m${timestamp}${RESET} ${this.color}[${this.username}]${RESET} ` +
            `\x1b[93m[system]${RESET} ⛔ Routine stopped — please install a new stabilizer before resuming.`
        );
      }

      // Mark bot as stopped-by-emergency so it won't auto-restart on mass disconnect
      saveStoppedState(this.username, "emergency");

      // Reassign the bot's last-used routine to "return_home" so that nothing
      // can ever automatically re-queue it into the routine it was just pulled
      // out of (miner/trader/etc.). Emergency-Warp always drops the ship back at
      // its home base, so return_home will find it already home, confirm dock,
      // and then idle — keeping it home instead of re-entering the old routine.
      saveLastUsedRoutine(this.username, "return_home");

      // Stop the routine immediately
      if (this._state === "running") {
        this._state = "stopping";
        this._abortController?.abort();
      }

      // Once the aborted routine has unwound, explicitly start the return_home
      // routine so the bot is in a "stay home" state (it is already home). This
      // runs best-effort: if the bot is already busy with another routine it is
      // skipped, and the re-assigned last-used routine guarantees that the next
      // auto-resume / mass-reconnect still lands it on return_home, never the
      // old routine.
      const botName = this.username;
      setTimeout(() => {
        void (async () => {
          const { handleStart, getBot } = await import("./botmanager.js");
          const bot = getBot(botName);
          if (!bot) return;
          if (bot.state === "running") return;
          await handleStart({ type: "start", bot: botName, routine: "return_home" });
        })().catch(() => {});
      }, 4000);

      return; // Don't log the original message again, we've already handled it
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

  /**
   * Library-backed command dispatch for bots connected through `@spacemolt/lib`.
   * Translates the legacy `exec(command, params)` call into the typed
   * `account.send(tool, action, params)` facade, normalizing the result back
   * into the legacy `ApiResponse` shape so the existing call sites keep working
   * until they are individually migrated to the typed accessor (P3).
   *
   * Mutations resolve to the typed `MutationResult.delta`; queries to
   * `structuredContent`. Event-driven notifications (chat/battle/market) move
   * to `account.on(...)` in P2, so `notifications` is empty here. This is the
   * keystone that lets the whole runner run on the library without touching
   * the ~1000 `exec` call sites yet.
   */
  private async libExec(command: string, payload?: Record<string, unknown>): Promise<ApiResponse> {
    const account = this.account;
    if (!account) {
      return { error: { code: "no_account", message: "Library account not connected" }, result: undefined, notifications: [] };
    }

    // Transport-level auth is already handled by connectOwned(); treat it as a no-op.
    if (COMMAND_TOOL_MAP[command] === "spacemolt_auth") {
      return { result: { ok: true }, error: undefined, notifications: [] };
    }
    // Notifications arrive via event subscriptions (P2) for library bots.
    if (command === "get_notifications") {
      return { result: { notifications: [] }, error: undefined, notifications: [] };
    }

    const blockedCommands = new Set(["jump", "travel", "dock", "undock", "mine", "salvage", "buy", "sell"]);
    if (this.isCustomsHold() && blockedCommands.has(command)) {
      this.log("customs", `⏳ Customs hold ACTIVE - blocking ${command} until clearance...`);
      await this.waitForCustomsClear();
    }

    this._lastAction = command;
    debugLogForBot(this.username, "bot:libExec", `${account.id ?? this.username} > ${command}`, payload);
    this.captureSkillSnapshot();

    const { tool, action, body } = buildLibDispatch(command, payload);

    const acct = this.account;
    if (!acct) {
      return { error: { code: "no_account", message: "Library account not connected" }, result: undefined, notifications: [] };
    }

    // account.send is instrumented (see instrumentSend) with connection-loss
    // resilience: if the socket drops mid-command it blocks and resends once
    // the library reconnects, so a routine never sees a transient disconnect
    // as a failure. We only handle genuine, non-connection errors here.
    try {
      const res = await acct.send(tool, action, body);
      const result = extractLibResult(res);
      // A clean command means we're no longer rate-limited; ease the backoff
      // back to its base so normal operation resumes promptly.
      this._rateLimitBackoff = 30_000;
      return { result, error: undefined, notifications: [] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Some failures are expected and not actionable, so avoid spamming the
      // log with red errors:
      //  - players who are not in a faction (view_faction_storage)
      //  - starter ships that simply cannot be insured (get_insurance_quote)
      if (command === "view_faction_storage" && /you must be in a faction/i.test(message)) {
        return { error: { code: "lib_error", message }, result: undefined, notifications: [] };
      }
      if (command === "get_insurance_quote" && /starter ships cannot be insured/i.test(message)) {
        this.log("info", `libExec ${command} failed: ${message}`);
        return { error: { code: "lib_error", message }, result: undefined, notifications: [] };
      }
      // Viewing station storage requires being docked or passing a station_id.
      // Bots undocking (or without a station_id for remote faction storage) hit
      // this constantly, so don't spam red errors — drop it to info.
      if (command === "view_storage" && /must be docked or provide a station_id/i.test(message)) {
        this.log("info", `libExec ${command} failed: ${message}`);
        return { error: { code: "lib_error", message }, result: undefined, notifications: [] };
      }
      // Not being in a battle is an expected, benign state for library-backed bots
      // (battle presence is tracked via push events). Don't log it as a red error
      // or it spams every routine that polls get_battle_status while idle.
      if (command === "get_battle_status" && /no active battle|not_in_battle|not in (a )?battle/i.test(message)) {
        return { error: { code: "not_in_battle", message }, result: undefined, notifications: [] };
      }
      // Scan commands fail with "in_battle" when the bot is already in combat.
      // This is expected and should not be logged as a red error.
      if (command === "scan" && /in_battle|in combat/i.test(message)) {
        return { error: { code: "in_battle", message }, result: undefined, notifications: [] };
      }
      this.log("error", `libExec ${command} failed: ${message}`);
      // Rate-limit / IP-block protection: the server temporarily bans an IP for
      // excessive command rate. If we blindly return the error, routines retry
      // immediately and the storm keeps the IP blocked (or escalates the ban).
      // Instead, pause here so the block window elapses before we issue more
      // commands. We sleep in increasing steps so repeated hits back off harder.
      if (/excessive rate limit|temporarily blocked|rate limit|too many requests/i.test(message)) {
        const penalty = this._rateLimitBackoff;
        this._rateLimitBackoff = Math.min(this._rateLimitBackoff + 30_000, 300_000);
        this.log("warn", `⏳ Rate limit hit — backing off ${Math.round(penalty / 1000)}s before next command to avoid an IP ban`);
        await sleep(penalty);
      }
      return { error: { code: "lib_error", message }, result: undefined, notifications: [] };
    }
  }

  /**
   * Wait for this bot's socket to come back after a drop. Returns true once the
   * live `account.authenticated` flips true again, false if the bot was stopped
   * or the connection is TERMINAL (the account is genuinely connected
   * elsewhere / the library gave up).
   *
   * CRITICAL: this coalesces to ONE shared recovery promise per bot. When a
   * socket drops there can be dozens of commands in flight (a routine fans out
   * many `get_*` queries at once), and previously each one spawned its own
   * recovery loop that independently force-reconnected the account. That storm
   * of `client.remove()` + `connectOwned()` calls made the server see duplicate
   * logins and answer with `session_replaced` (4001) — each new socket killing
   * the last — so the bot could never reconnect until the routine stopped and
   * the storm ceased. Sharing one promise means all callers await the SAME
   * recovery, and the recovery itself defers to the library's own in-place
   * reconnect first (see `runRecovery`).
   */
  private waitForFreshSocket(): Promise<boolean> {
    if (!this._recovery) {
      this._recovery = this.runRecovery().finally(() => {
        this._recovery = null;
      });
    }
    return this._recovery;
  }

  /** True while this bot's single coalesced socket-recovery loop is running. */
  hasActiveRecovery(): boolean {
    return this._recovery !== null;
  }

  /**
   * The actual recovery driver — exactly ONE runs per bot at a time (guarded by
   * `_recovery`). Strategy, in order of preference:
   *
   *   1. TRUST THE LIBRARY. `@spacemolt/lib` already reconnects the same
   *      `Account` instance in place on any non-terminal drop (its client-level
   *      `handleAccountDisconnected` → `account.reconnectOnce`, rate-limited).
   *      During that window `account.authenticated` is briefly false, but the
   *      socket is being rebuilt on the SAME instance — so we just WAIT for it
   *      to flip back. We do NOT evict/replace it (that's what created the
   *      duplicate-login storm). This grace window is generous.
   *
   *   2. Only if the library gives up — it fires `onAccountDisconnected`, which
   *      the botmanager surfaces as a terminal close (`_terminalClosed`) — OR
   *      the grace window elapses with no recovery, do we escalate to ONE forced
   *      fresh socket via botmanager (bounded by its shared backoff). That's a
   *      genuine last resort, not the per-tick hammer it used to be.
   *
   * Never resolves false on a plain blip while the bot is running; only on an
   * explicit stop or a real terminal close.
   */
  private async runRecovery(): Promise<boolean> {
    const POLL_MS = 500;
    // How long to let the library's own in-place reconnect work before we
    // escalate to a forced fresh socket. The library paces reconnects through
    // its rate-limited queue, so a post-restart mass reconnect can legitimately
    // take a while — but we don't wait forever without acting.
    //
    // CRITICAL (do not regress): we force a fresh socket at MOST once per grace
    // window — never on every poll. Forcing every poll evicts + reconnects the
    // account continuously, which races @spacemolt/lib's own in-place reconnect
    // and provokes `session_replaced`: the server sees two concurrent sessions
    // for the same bot, kills the newest, and the recovery loop just fights
    // itself forever (a per-second reconnect storm). So a forced reconnect is a
    // *rare, last-resort nudge*, not the per-tick hammer.
    //
    // Under heavy CPU (a 979-bot fleet all mining at once) the event loop lags
    // and the library's reconnect runs SLOW, so we scale the grace + poll by the
    // measured loop lag (see loadMonitor): we stay lenient under load and give
    // the library room instead of hammering it.
    const LIBRARY_GRACE_MS = 30_000;
    let cycle = 0;
    for (;;) {
      // Stop requested — bail immediately so the routine can end.
      if (this.state === "stopping" || this._abortController?.signal.aborted) {
        this.log("system", "Stop requested — aborting socket recovery.");
        return false;
      }
      // Recovered? Require the library to report authenticated AND the socket to
      // actually be open (readyState 1). Don't resume on a half-open /
      // reconnecting socket (readyState 0), or we'd declare victory a moment
      // before it dies again.
      const acct = this.account;
      if (acct && acct.authenticated && this.getConnectionState() === "connected") {
        if (cycle > 0) this.log("system", "Socket reconnected — resuming routine.");
        return true;
      }
      // Escalate to ONE forced fresh socket only when:
      //   - the library gave up (terminal close fired — _terminalClosed), OR
      //   - a grace window has elapsed with no recovery.
      // Either way it happens at most once per window — see the note above. The
      // reconnect STORM is prevented by forceReconnectBot's own exponential
      // backoff + in-flight guard, NOT by stretching this grace, so we keep this
      // grace FIXED (prompt) regardless of CPU load: scaling it up would just
      // make the bot wait minutes before its first forced reconnect.
      const waited = cycle * POLL_MS;
      const grace = LIBRARY_GRACE_MS;
      if (this._terminalClosed) {
        this.log("warn", "Library reported the socket gone for good — requesting one fresh socket (backed off) and waiting for recovery...");
        this.clearTerminalClosed();
        await this.forceSocketReconnect();
      } else if (waited > 0 && waited % grace === 0) {
        this.log("warn", "Still disconnected after grace window — requesting one fresh socket (backed off) and waiting for recovery...");
        await this.forceSocketReconnect();
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
      cycle++;
    }
  }

  /**
   * Force @spacemolt/lib to drop this account's dead socket and open a fresh one,
   * RIGHT NOW. Called from `sendResilient`/`waitForFreshSocket` on EVERY
   * connection error so we never sit "pounding our heads against a closed door" —
   * we make the library replace the socket instantly. Delegates to botmanager's
   * `forceReconnectBot` (evict the dead `Account` from the client, then reconnect
   * a fresh one) via a lazy import to avoid a bot.ts ↔ botmanager.ts circular
   * dependency. It also clears the terminal-close guard, because a
   * `session_replaced`/`auth_timeout` close is usually a zombie session after a
   * server restart rather than a genuine elsewhere-login, so our fresh socket
   * should be allowed to win. A truly-elsewhere session just gets re-closed and
   * re-arms the guard, ending the routine cleanly.
   */
  private async forceSocketReconnect(): Promise<void> {
    const id = this.account?.id;
    if (!id) return;
    if (this.state === "stopping" || this._abortController?.signal.aborted) return;
    this.log("system", `Forcing a fresh @spacemolt/lib socket for ${id} (dropping the dead one)...`);
    try {
      const { forceReconnectBot } = await import("./botmanager.js");
      await forceReconnectBot(id);
    } catch {
      // Transient (e.g. the client isn't initialized yet). The watchdog and the
      // routine's own back-off restart will still retry; this is a best-effort
      // kick that must never throw into the caller.
    }
  }

  /** Public alias routines can call to explicitly pause until reconnected. */
  async waitForSocket(): Promise<boolean> {
    return this.waitForFreshSocket();
  }

  /**
   * Subscribe to the library's typed server push events for this bot. Replaces
   * the legacy `get_notifications` polling: chat, battle, crafting, mining,
   * market, trade, and other pushes are routed through the same
   * `handleNotifications` business logic the HTTP path used, so customs holds,
   * MAYDAY rescue, battle-state tracking, and AI-chat forwarding all keep
   * working for library-backed bots. No-op when this bot has no `Account`.
   */
  subscribeEvents(): void {
    const account = this.account;
    if (!account) return;
    this.unsubscribeEvents();

    const forward = (...types: TypedNotificationType[]) => {
      for (const t of types) {
        const off = account.on(t, (payload) => {
          void this.handleNotifications([{ type: t, msg_type: t, data: payload as unknown as Record<string, unknown> }]);
        });
        this.eventUnsubscribers.push(off);
      }
    };

    forward(
      "chat_message",
      "battle_update",
      "battle_damage",
      "battle_started",
      "battle_ended",
      "battle_joined",
      "battle_left",
      "battle_alert",
      "crafting_update",
      "mining_yield",
      "skill_level_up",
      "achievement_unlocked",
      "trade_offer_received",
      "trade_complete",
      "trade_cancelled",
      "trade_declined",
      "pirate_radio",
      "scan_detected",
      "observation_update",
      "drone_update",
      "drone_scan",
      "drone_survey",
      "drone_destroyed",
      "pilotless_ship",
      "pirate_destroyed",
      "player_kill",
      "player_died",
      "facility_reclaimed",
      "facility_rent_warning",
      "base_destroyed",
      "base_raid_update",
    );
    this.log("system", `Registered @spacemolt/lib typed event handlers including observation_update`);

    // Track terminal closes (the player is connected elsewhere / reconnect gave
    // up). A routine server-restart blip is NOT terminal — the library
    // auto-reconnects in place and flips `authenticated` back to true, so the
    // dispatch layer just waits for that. A terminal close never reconnects, so
    // `waitForReconnect` checks this flag and stops blocking so the routine can
    // end gracefully. This single-slot listener is otherwise unused (the
    // botrunner keys off the client-level `onAccountDisconnected`), so setting
    // it here is safe.
    this._terminalClosed = false;
    try {
      (account as unknown as { onDisconnected?: (cb: (err: unknown) => void) => void }).onDisconnected?.(() => {
        this._terminalClosed = true;
      });
      (account as unknown as { onReconnected?: (cb: () => void) => void }).onReconnected?.(() => {
        this._terminalClosed = false;
      });
    } catch { /* listener registration is best-effort */ }

    // Realtime market order-book updates feed the stream store + dashboard cache.
    // Only subscribed for routines that actually deal with trade (explorer/trader)
    // — every other routine drops it to avoid wasting game-server bandwidth.
    this.syncMarketSubscription();

    // Untyped pushes (legacy "system"/"combat" pirate-attack messages) arrive as
    // RawFrame via onAny. Forward those too, skipping anything already covered
    // by the typed handlers above to avoid double-processing.
    const typedSet = new Set<string>(TYPED_NOTIFICATION_TYPES as readonly string[]);
    const offAny = account.onAny((frame: RawFrame) => {
      const type = frame.type;
      if (typedSet.has(type)) return;
      const data = frame.payload;
      if (typeof data === "object" && data !== null) {
        void this.handleNotifications([{ type, msg_type: type, data: data as Record<string, unknown> }]);
      } else if (typeof data === "string") {
        void this.handleNotifications([{ type, msg_type: type, data: { message: data } }]);
      }
    });
    this.eventUnsubscribers.push(offAny);

    const channels = ["chat", "battle", "notifications"];
    if (this.marketUnsubscriber) channels.push("market");
    this.log("system", `Subscribed to @spacemolt/lib push events (${channels.join("/")}).`);
  }

  /**
   * True when this bot's current routine is one that deals in trade data and
   * therefore needs the high-bandwidth realtime market push stream. Only
   * explorers and traders subscribe; every other routine drops it to save
   * game-server bandwidth.
   */
  private isTradeRoutine(): boolean {
    return this._routine === "explorer" || this._routine === "trader" || this._routine === "market";
  }

  /**
   * Subscribe to (or unsubscribe from) the realtime `market_update` push stream
   * based on the bot's current routine. Idempotent: calling repeatedly with the
   * same routine state is a no-op. Routines that don't deal with trade never
   * open the market stream, so they generate no market bandwidth against the
   * game server.
   */
  private syncMarketSubscription(): void {
    const account = this.account;
    if (!account) return;

    if (this.isTradeRoutine()) {
      if (!this.marketUnsubscriber) {
        this.marketUnsubscriber = account.on("market_update", (payload) =>
          this.handleMarketUpdate(payload),
        );
      }
    } else if (this.marketUnsubscriber) {
      try { this.marketUnsubscriber(); } catch { /* ignore */ }
      this.marketUnsubscriber = null;
    }
  }

  /** Remove all event subscriptions registered by `subscribeEvents`. */
  unsubscribeEvents(): void {
    for (const off of this.eventUnsubscribers) {
      try { off(); } catch { /* ignore */ }
    }
    this.eventUnsubscribers = [];
    if (this.marketUnsubscriber) {
      try { this.marketUnsubscriber(); } catch { /* ignore */ }
      this.marketUnsubscriber = null;
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

    if (command === "jump") {
      const t = (payload as Record<string, unknown> | undefined)?.target_system;
      if (typeof t === "number") {
        if (!this.hasPathfinderDrive) {
          await this.refreshShipMods();
        }
        if (!this.hasPathfinderDrive) {
          this.log("error", "Pathfinder jump attempted without Pathfinder Drive module.");
          return { error: { code: "no_pathfinder_drive", message: "Pathfinder jumps require the Pathfinder Drive utility module installed." }, result: undefined, notifications: [] };
        }
      }
    }

      // All bots are library-backed (P4.1): dispatch every command through
      // @spacemolt/lib. The HTTP/SpaceMoltAPI transport (and its 502/524 retry
      // loops, which the library handles internally) was removed; the business
      // logic below runs on the normalized ApiResponse libExec returns.
      let resp: ApiResponse;
      resp = await this.libExec(command, payload);

      if (isCombatDebugEnabled() && (
        command === "battle" || command === "scan" || command === "attack" ||
        command === "get_battle_status" || command === "get_nearby" ||
        command === "cloak"
      )) {
        combatDebugLog(this.username, `exec:${command}`, {
          command,
          payload,
          result: resp.result,
          error: resp.error,
        });
      }

      try {

        // (HTTP 502/524/full_login_required retry blocks were transport-level and
        // are handled internally by @spacemolt/lib; removed with the SpaceMoltAPI
        // transport. The library surfaces battle interrupts as thrown errors that
        // libExec normalizes, so no manual 502/524 battle-retry loop is needed.)

        // After jump/travel commands in empire space, wait for customs messages
        // This is the PROACTIVE check - wait 2 seconds minimum for customs to respond
        // Only applies to customs empires (Voidborn, Nebula, Crimson, Solarian) in non-lawless systems
        if (!resp.error && (command === "jump" || command === "travel")) {
          const sysData = mapStore.getSystem(this.system);
          if (isEmpireSystem(this.system, this.getEmpire(), sysData?.security_level)) {
            this.log("customs", `⏱️ Post-jump customs wait @ ${this.system} - 2 second delay...`);
            await sleep(250); //human says it does not need to be much because the cusoms know you are coming the instant you issue the jump command.
          }
        }

        // Action pending — a previous game action is still resolving (10s tick).
        // Wait for the tick to complete then retry once.
        if (resp.error) {
          const msg = resp.error.message || "";
          if (resp.error.code === "action_pending" || msg.includes("action is already pending") || msg.includes("Another action is already in progress")) {
            debugLogForBot(this.username, "bot:exec", `${this.username} > ${command}: action pending, waiting 10s...`);
            this.log("system", "Action pending — waiting for server to process...");
            // Honor a stop request instead of blocking on the pending action
            if (this._state !== "running") {
              this.log("system", "Stop requested — aborting pending action wait");
            } else {
              await sleep(10_000);
              // Re-check stop before issuing the retry
              if (this._state !== "running") {
                this.log("system", "Stop requested — aborting pending action retry");
              } else {
                resp = await this.libExec(command, payload);

                // If still pending, wait a bit longer and try one more time
                if (resp.error && (resp.error.code === "action_pending" || resp.error.message?.includes("action is already pending") || resp.error.message?.includes("Another action is already in progress"))) {
                  // Honor a stop request instead of blocking further
                  if (this._state !== "running") {
                    this.log("system", "Stop requested — aborting pending action wait");
                  } else {
                    this.log("system", "Action still pending — waiting additional 5s...");
                    await sleep(5_000);
                    // Re-check stop before issuing the final retry
                    if (this._state === "running") {
                      resp = await this.libExec(command, payload);
                    }
                  }
                }
              }
            }
          }
        }

        if (resp.notifications && Array.isArray(resp.notifications) && resp.notifications.length > 0) {
          logNotifications(resp.notifications);
          await this.handleNotifications(resp.notifications);
        }

        // Update faction storage cache whenever view_storage is called for faction
        if (command === "view_storage" && payload?.target === "faction" && !resp.error) {
          const entries = this.parseItemList(resp.result);
          const station = (payload.station_id as string) || this.poi;
          const result = resp.result as Record<string, unknown> | undefined;
          // Try to get faction name from response, then from existing cache, then fall back to this.faction
          const factionName = (result?.faction_name as string) || (result?.faction_id as string) || (station ? getFactionStorageCacheByStationOnly(station)?.factionName : null) || this.faction || "";
          if (factionName) {
            const fuelReserve = (result?.faction_fuel_reserve as number) || 0;
            const fuelCapacity = (result?.faction_fuel_capacity as number) || 0;
            updateFactionStorageCache(factionName, entries, station, fuelReserve, fuelCapacity);
          }
        }

        // Update faction fuel cache whenever get_poi is called at a station
        if (command === "get_poi" && !resp.error && resp.result) {
          const result = resp.result as Record<string, unknown>;
          const fuelReserve = (result.faction_fuel_reserve as number) || 0;
          const fuelCapacity = (result.faction_fuel_capacity as number) || 0;
          if (fuelCapacity > 0) {
            this.factionFuelReserve = fuelReserve;
            this.factionFuelCapacity = fuelCapacity;
            const station = (result.poi as Record<string, unknown>)?.id as string || this.poi;
            // Try to get faction name from response (base.empire), cache, or this.faction
            const base = (result.base as Record<string, unknown>) || {};
            const factionFromResponse = (base.empire as string) || (base.faction as string) || (base.faction_id as string);
            const cached = station ? getFactionStorageCacheByStationOnly(station) : null;
            const factionFromCache = cached?.factionName || null;
            const factionName = factionFromResponse || factionFromCache || this.faction;
            if (factionName) {
              updateFactionStorageCache(factionName, [], station, fuelReserve, fuelCapacity);
            }
          }
          // Capture the home station's OWN base fuel (base.fuel / base.max_fuel) whenever
          // this get_poi result is for the configured global home station. Bots run
          // get_poi constantly on entering/docking at a POI, so a bot at the home base
          // will refresh this frequently. We match on the POI id or base id.
          const homeStationId =
            ((loadSettings().general as Record<string, unknown>)?.factionStorageStation as string) || "";
          if (homeStationId) {
            const poiId = (result.poi as Record<string, unknown>)?.id as string || "";
            const baseObj = (result.base as Record<string, unknown>) || {};
            const baseId =
              (baseObj.id as string) ||
              (baseObj.poi_id as string) ||
              "";
            if (poiId === homeStationId || baseId === homeStationId) {
              const baseFuel = baseObj.fuel as number | undefined;
              const baseMaxFuel = baseObj.max_fuel as number | undefined;
              if (typeof baseFuel === "number") this.homeBaseFuel = baseFuel;
              if (typeof baseMaxFuel === "number") this.homeBaseMaxFuel = baseMaxFuel;
              if (typeof baseFuel === "number" || typeof baseMaxFuel === "number") {
                this.homeBaseFuelPoi = homeStationId;
                this.notifyStateChanged();
              }
            }
          }
        }

        // get_base (with a base_id) returns the home station's own fuel directly.
        if (command === "get_base" && !resp.error && resp.result) {
          const baseObj = (resp.result as Record<string, unknown>).base as Record<string, unknown> || (resp.result as Record<string, unknown>);
          const baseId =
            (baseObj.id as string) ||
            (baseObj.poi_id as string) ||
            "";
          const homeStationId =
            ((loadSettings().general as Record<string, unknown>)?.factionStorageStation as string) || "";
          if (homeStationId && baseId === homeStationId) {
            const baseFuel = baseObj.fuel as number | undefined;
            const baseMaxFuel = baseObj.max_fuel as number | undefined;
            if (typeof baseFuel === "number") this.homeBaseFuel = baseFuel;
            if (typeof baseMaxFuel === "number") this.homeBaseMaxFuel = baseMaxFuel;
            if (typeof baseFuel === "number" || typeof baseMaxFuel === "number") {
              this.homeBaseFuelPoi = homeStationId;
              this.notifyStateChanged();
            }
          }
        }

        if (!resp.error && resp.result) {
          const r = resp.result as Record<string, unknown>;
          const ship = (r.ship as Record<string, unknown>) || {};
          const location = (r.location as Record<string, unknown>) || {};
          const player = (r.player as Record<string, unknown>) || {};
          const p = location || player || r;

if (command === "get_status") {
             this.system = (location?.system_id as string) || (p.current_system as string) || this.system;
             this.poi = (location?.poi_id as string) || (p.current_poi as string) || (p.poi_id as string) || this.poi;
             this.docked = location?.docked_at != null
               ? !!(location.docked_at)
               : (p.docked_at_base != null
                 ? !!(p.docked_at_base)
                 : (p.docked as boolean) ?? (p.status === "docked"));
             this.location =
               (location?.system_name as string) ||
               (location?.system_id as string) ||
               (p.current_system as string) ||
               (p.location as string) ||
               this.location;

             this.credits = (player?.credits as number) ?? (r.credits as number) ?? (p.credits as number) ?? this.credits;
    this.faction = (p.faction_id as string) ?? (p.faction as string) ?? this.faction ?? null;

    // Outstanding bounties: get_status puts per-faction standings on
    // `player.standings[faction].outstanding_bounty`. Parse any > 0 into a map.
    const standings = (player?.standings as Record<string, Record<string, unknown>> | undefined)
      ?? (r.standings as Record<string, Record<string, unknown>> | undefined);
    if (standings && typeof standings === "object") {
      const parsed: Record<string, number> = {};
      for (const [faction, data] of Object.entries(standings)) {
        const amt = (data?.outstanding_bounty as number) ?? (data?.bounty as number) ?? 0;
        if (amt > 0) parsed[faction] = amt;
      }
      this.bounties = parsed;
    }
             if (player?.is_cloaked !== undefined || ship?.is_cloaked !== undefined || p.is_cloaked !== undefined || p.cloaked !== undefined || player?.cloaked !== undefined || ship?.cloaked !== undefined) {
               this.isCloaked = !!(player?.is_cloaked || ship?.is_cloaked || p.is_cloaked || p.cloaked || player?.cloaked || ship?.cloaked);
             }

             const towingWreckId = (p.towing_wreck_id as string) ?? (ship?.towing_wreck_id as string) ?? (r.towing_wreck_id as string);
             if (towingWreckId != null) {
               this.towingWreck = true;
               this.towingWreckId = towingWreckId;
             }

             if (ship) {
               this.fuel = (ship.fuel as number) ?? this.fuel;
               this.maxFuel = (ship.max_fuel as number) ?? this.maxFuel;
               this.cargo = (ship.cargo_used as number) ?? this.cargo;
               this.cargoMax = (ship.cargo_capacity as number) ?? (ship.max_cargo as number) ?? this.cargoMax;
               this.hull = (ship.hull as number) ?? (ship.hp as number) ?? this.hull;
               this.maxHull = (ship.max_hull as number) ?? (ship.max_hp as number) ?? this.maxHull;
this.shield = (ship.shield as number) ?? (ship.shields as number) ?? this.shield;
        this.maxShield = (ship.max_shield as number) ?? (ship.max_shields as number) ?? this.maxShield;
        this.shipSpeed = (ship.speed as number) || 1;
        this.shipId = (ship.id as string) || "";
             }
           } else if (command === "mine") {
            // Mine response is nested under 'details' per OpenAPI spec
            const details = (r.details as Record<string, unknown>) || r;
            const qty = (details.quantity as number) || (details.count as number) || 0;
            if (qty) this.cargo = Math.max(0, this.cargo + qty);
            const xpGained = details.xp_gained as Record<string, number> | undefined;
            if (xpGained) {
              for (const [skill, gained] of Object.entries(xpGained)) {
                this.skillXP.set(skill, (this.skillXP.get(skill) || 0) + gained);
              }
            }
          } else if (command === "jump" || command === "travel") {
            const sysId = (r.system_id as string) || (r.system as string) || (location.system_id as string);
            const poiId = (r.poi as string) || (r.poi_id as string) || (location.poi_id as string);
            if (sysId) this.system = sysId;
            if (poiId) this.poi = poiId;
            if (r.auto_docked || location.docked_at) this.docked = true;
            if (r.auto_undocked) this.docked = false;
            if (typeof r.fuel === "number") this.fuel = r.fuel;
            // Auto-scan nearby after arriving at a new system/POI so creature &
            // player tracking never misses spawns. Covers miners, traders,
            // civilian transport, explorers, and every other routine.
            await this.autoScanAndTrackNearby();
          } else if (command === "dock") {
            this.docked = true;
            if (location.docked_at) this.poi = (location.docked_at as string);
          } else if (command === "undock") {
            this.docked = false;
            } else if (command === "sell" || command === "create_sell_order") {
            // Prefer the authoritative absolute balance when the API returns
            // it; otherwise apply the relative earned amount. This avoids
            // double-counting (adding an absolute balance to the current one)
            // which produced bouncing/wrong credit values.
            const newCredits = (r.credits as number);
            if (typeof newCredits === "number") {
              this.credits = newCredits;
            } else {
              const creditsEarned = (r.credits_earned as number) || 0;
              if (creditsEarned) this.credits += creditsEarned;
            }
            const qty = (r.quantity as number) || 0;
            if (qty) this.cargo = Math.max(0, this.cargo - qty);
          } else if (command === "buy" || command === "create_buy_order") {
            const newCredits = (r.credits as number);
            if (typeof newCredits === "number") {
              this.credits = newCredits;
            } else {
              const creditsSpent = (r.credits_spent as number) || 0;
              if (creditsSpent) this.credits = Math.max(0, this.credits - creditsSpent);
            }
            const qty = (r.quantity as number) || 0;
            if (qty) this.cargo += qty;
          } else if (command === "refuel") {
            const fuelAdded = (r.fuel_added as number) || (r.quantity as number) || 0;
            if (fuelAdded) this.fuel = Math.min(this.maxFuel, this.fuel + fuelAdded);
            if (typeof ship.fuel === "number") this.fuel = ship.fuel;
          } else if (command === "repair") {
            const hullRepaired = (r.hull_repaired as number) || (r.hull as number) || 0;
            if (hullRepaired) this.hull = Math.min(this.maxHull, this.hull + hullRepaired);
            const shieldRepaired = (r.shield_repaired as number) || (r.shield as number) || 0;
            if (shieldRepaired) this.shield = Math.min(this.maxShield, this.shield + shieldRepaired);
          } else if (command === "jettison") {
            const qty = (r.quantity as number) || 0;
            if (qty) this.cargo = Math.max(0, this.cargo - qty);
          } else if (command === "craft") {
            const qty = (r.quantity as number) || (r.count as number) || 0;
            if (qty) this.cargo += qty;
          }
        }

        // Storage / cargo-moving commands return the FULL post-action cargo hold
        // (plus ship cargo used/capacity + credits). Apply it directly so the
        // cargo viewer updates the instant the command responds — with no extra
        // get_cargo round-trip — and fire the UI hook for an immediate dashboard
        // push. This is what makes item moves feel "peppy" during a cargo-mover
        // run that fires many storage commands in a row.
        if (!resp.error && resp.result && CARGO_AFFECTING_COMMANDS.has(command)) {
          this.syncCargoFromResponse(resp.result);
        }

        if (this.system !== this.lastSystem || this.poi !== this.lastPoi) {
          this.log("debug", `Position changed: ${this.lastSystem}/${this.lastPoi} -> ${this.system}/${this.poi}`);
          this.logPosition();
          this.lastSystem = this.system;
          this.lastPoi = this.poi;
        }

        return resp;
        } catch (err) {
        // Handle abort
        if (err instanceof Error && err.name === "AbortError" && this.currentBattle.inBattle) {
          this.log("combat", `${command} aborted due to battle detection`);
          return {
            error: { code: "battle_interrupt", message: `${command} aborted due to battle ${this.currentBattle.battleId}` },
            result: undefined,
            notifications: [],
          };
        }
        throw err;
      }
  }

  /** Login using stored credentials. Returns true on success. Prevents duplicate concurrent logins. */
  async login(): Promise<boolean> {
    if (this._loginPromise) {
      const age = Date.now() - this._loginStartedAt;
      // A login that's been "in progress" longer than this is wedged: its
      // doLogin() never settled (almost always a refreshStatus/get_status stuck
      // waiting on a dead socket whose recovery never completed). Waiting on it
      // forever is what leaves a bot "never able to reconnect" — the routine is
      // parked on a promise that will never resolve. Discard it and retry so the
      // bot can actually make progress once the socket is back.
      if (age < LOGIN_WEDGE_TIMEOUT_MS) {
        this.log("system", "Login already in progress, waiting...");
        return this._loginPromise;
      }
      this.log("warn", `Previous login() promise wedged for ${Math.round(age / 1000)}s — resetting and retrying.`);
      this._loginPromise = null;
    }

    this._loginStartedAt = Date.now();
    this._loginPromise = this.doLogin().finally(() => {
      this._loginPromise = null;
    });

    return this._loginPromise;
  }

  /** Race `p` against a timeout; resolves to `undefined` (instead of hanging)
   *  if it doesn't settle within `ms`. Used to keep login()/resumeSession()
   *  from wedging on a refreshStatus/get_status stuck waiting for a socket that
   *  may be down for a long time. */
  private async bound<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((res) => {
      timer = setTimeout(() => res(undefined), ms);
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** True when this bot has a live library Account connection.
   *  Checks both the library auth flag and the underlying WebSocket readyState
   *  so a "silently dead" socket (authenticated stays true but ws is closed)
   *  is treated as disconnected. */
  isConnected(): boolean {
    const acct = this.account;
    if (!acct || !acct.authenticated) return false;
    const rs = (acct as unknown as { readyState?: number }).readyState;
    if (rs !== undefined && rs !== 1) return false;
    return true;
  }

  /** Return a side-effect-free connection-state snapshot. Does not send any
   *  commands; just inspects the library Account's own state flags so routines
   *  and the health monitor can decide whether to issue further commands
   *  without risking a reconnection storm. */
  getConnectionState(): "connected" | "reconnecting" | "disconnected" {
    const acct = this.account;
    if (!acct) return "disconnected";
    if (!acct.authenticated) return "disconnected";
    const rs = (acct as unknown as { readyState?: number }).readyState;
    if (rs === 0) return "reconnecting";
    if (rs === 2 || rs === 3) return "disconnected";
    return "connected";
  }

  /** Internal login implementation */
  private async doLogin(): Promise<boolean> {
    // Backed by a library Account: connectOwned() already authenticated it,
    // so there is no HTTP credential flow to perform.
    if (this.account) {
      this.log("system", `Connected via @spacemolt/lib as ${this.account.id ?? this.username} (no login needed)`);
      // Best-effort, BOUNDED state warm-up. For a library bot the account is
      // already connected, so the only reason to refresh here is to populate
      // cached status/skills before the routine runs. We must NOT await it
      // unboundedly: a flaky socket makes refreshStatus()/checkSkills() hang
      // inside sendResilient waiting for recovery, which wedges login() (and
      // thus the whole routine) forever on a promise that won't resolve until
      // the socket is back. The routine refreshes state on its own as it runs,
      // so if this times out we simply proceed with the library's seeded data.
      await this.bound(this.refreshStatus(), 15_000);
      await this.bound(this.checkSkills(), 15_000);
      return true;
    }

    // No library Account and no credentials: nothing to authenticate with.
    this._error = "No account/session available";
    this._state = "error";
    this.log("error", "Cannot log in: bot has no @spacemolt/lib Account and no credentials.");
    return false;
  }

  /** Resume session from disk without full login. Returns true if session was restored and is valid. */
  async resumeSession(): Promise<boolean> {
    // Library-backed bots are already connected; nothing to restore.
    if (this.account) {
      this.log("system", `Session already active via @spacemolt/lib (${this.account.id ?? this.username})`);
      // Bounded (see doLogin): a dead socket must never wedge resumeSession.
      await this.bound(this.refreshStatus(), 15_000);
      await this.bound(this.checkSkills(), 15_000);
      return true;
    }

    // No library Account and no saved session token: nothing to resume.
    this.log("system", "No @spacemolt/lib Account and no saved session token; cannot resume.");
    return false;
  }

  /**
   * Throttle for real `get_status` network fetches. `refreshStatus()` is called
   * extremely often — every routine loop iteration, after every web-UI command,
   * and on every periodic tick across the whole fleet — so issuing a network
   * `get_status` on each call would hammer the game server. We fetch at most
   * once per window and otherwise return the last authoritative result.
   *
   * This also fixes a stale-data bounce: previously library-backed bots read
   * `account.state` directly, which the library only refreshes from push
   * events and does NOT keep current for credits/fuel/etc. Each broadcast then
   * clobbered freshly-fetched values with that stale cache, making the UI
   * flicker between old and new data (and prefer the old). Now the cached
   * `credits`/`fuel`/`hull`/`shield`/`cargo` come from a real `get_status`.
   */
  private _lastStatusResult: Record<string, unknown> | null = null;
  private _lastStatusFetchAt = 0;
  private static readonly STATUS_FETCH_THROTTLE_MS = 5000;

  async refreshStatus(): Promise<ApiResponse> {
    if (this.account) {
      const now = Date.now();
      if (now - this._lastStatusFetchAt >= Bot.STATUS_FETCH_THROTTLE_MS) {
        const resp = await this.libExec("get_status");
        this._lastStatusFetchAt = now;
        if (!resp.error && resp.result && typeof resp.result === "object") {
          this._lastStatusResult = resp.result as Record<string, unknown>;
          this.applyStatusResult(this._lastStatusResult);
          return { result: this._lastStatusResult, error: undefined, notifications: [] };
        }
        // The fetch failed but we have a previous good result — keep using it
        // instead of falling back to the possibly-stale account.state.
        if (this._lastStatusResult == null) {
          this._lastStatusResult = this.account.state as unknown as Record<string, unknown>;
        }
        this.applyStatusResult(this._lastStatusResult);
        return { result: this._lastStatusResult, error: undefined, notifications: [] };
      }
      // Throttled: reuse the last authoritative result so callers (and the
      // status broadcast) use real data instead of stale account.state.
      return {
        result: this._lastStatusResult ?? (this.account.state as unknown as Record<string, unknown>),
        error: undefined,
        notifications: [],
      };
    }
    return this.libExec("get_status");
  }

  /** Parse a `get_status` result into the bot's cached game state. */
  private applyStatusResult(r: Record<string, unknown>): void {
    debugLogForBot(this.username, "bot:refreshStatus", `${this.username} get_status response`, r);
    debugLogForBot(this.username, "bot:refreshStatus", `${this.username} top-level keys`, Object.keys(r));

    // The `get_status`/`get_state` response carries the live gameserver version
    // (top-level `version`). Whenever it differs from the catalog we hold, kick
    // off a version-driven catalog refresh (conditional GET → 304 until the file
    // is republished, then a fresh 200). This is how we pick up the frequent
    // game patches within moments of the first status report — no 24h wait.
    const gsVersion = typeof r.version === "string" ? r.version : null;
    if (gsVersion) void catalogStore.noteGameServerVersion(gsVersion);

    const location = r.location as Record<string, unknown> | undefined;
    const player = r.player as Record<string, unknown> | undefined;
    const p = location || player || r;

    const wasDocked = this.docked;
    this.system = (location?.system_id as string) || (p.current_system as string) || this.system;
    this.poi = (location?.poi_id as string) || (p.current_poi as string) || (p.poi_id as string) || this.poi;
    this.docked = location?.docked_at != null
      ? !!(location.docked_at)
      : (p.docked_at_base != null
        ? !!(p.docked_at_base)
        : (p.docked as boolean) ?? (p.status === "docked"));
    if (!wasDocked && this.docked) {
      try { this.onDocked?.(); } catch { /* hook errors must never break status parsing */ }
    }
    this.location =
      (location?.system_name as string) ||
      (location?.system_id as string) ||
      (p.current_system as string) ||
      (p.location as string) ||
      this.location;

    this.credits = (player?.credits as number) ?? (r.credits as number) ?? (p.credits as number) ?? this.credits;
    this.faction = (p.faction_id as string) ?? (p.faction as string) ?? this.faction ?? null;
    if (player?.is_cloaked !== undefined || p.is_cloaked !== undefined || p.cloaked !== undefined || player?.cloaked !== undefined) {
      this.isCloaked = !!(player?.is_cloaked || p.is_cloaked || p.cloaked || player?.cloaked);
    }

    const ship = r.ship as Record<string, unknown> | undefined;
    debugLogForBot(this.username, "bot:ship", `${this.username} ship object`, ship);
    if (ship) {
      const prevHullPct = this.maxHull > 0 ? (this.hull / this.maxHull) * 100 : 100;
      const prevHasEws = this.hasEmergencyWarpStabilizer;
      const rawName = (ship.name as string) || "";
      const shipType = (ship.ship_type as string) || (ship.type as string) || "";
      this.shipName = (rawName && rawName.toLowerCase() !== "unnamed" ? rawName : shipType) || this.shipName;
      this.shipClass = shipType;
      this.tier = (ship.tier as number) ?? null;
      this.fuel = (ship.fuel as number) ?? this.fuel;
      this.maxFuel = (ship.max_fuel as number) ?? this.maxFuel;
      this.cargo = (ship.cargo_used as number) ?? this.cargo;
      this.cargoMax = (ship.cargo_capacity as number) ?? (ship.max_cargo as number) ?? this.cargoMax;
      this.hull = (ship.hull as number) ?? (ship.hp as number) ?? this.hull;
      this.maxHull = (ship.max_hull as number) ?? (ship.max_hp as number) ?? this.maxHull;
      this.shield = (ship.shield as number) ?? (ship.shields as number) ?? this.shield;
      this.maxShield = (ship.max_shield as number) ?? (ship.max_shields as number) ?? this.maxShield;
      this.shipSpeed = (ship.speed as number) || 1;
      this.shipId = (ship.id as string) || "";

      // `ship.modules` is a list of opaque instance ids; the detail objects
      // live in the top-level `modules` array. extractShipModules joins them.
      const { modules: modulesArray, resolved: modulesResolved } = extractShipModules(r);

      let totalAmmo = 0;
      for (const mod of modulesArray) {
        if (mod && typeof mod === "object" && mod.current_ammo != null && typeof mod.current_ammo === "number") {
          totalAmmo += mod.current_ammo as number;
        }
      }
      if (totalAmmo > 0) {
        this.ammo = totalAmmo;
      } else if (ship.ammo != null) {
        this.ammo = ship.ammo as number;
      }
      this.applyModuleFlags(modulesArray, modulesResolved);

      if (!this._ewsFallbackTriggered && this._state === "running" && prevHasEws === true) {
        const hullPct = this.maxHull > 0 ? (this.hull / this.maxHull) * 100 : 100;
        if (prevHullPct > 20 && hullPct <= 20) {
          const positionChanged = this.system !== this.lastSystem || this.poi !== this.lastPoi;
          const ewsGone = this.hasEmergencyWarpStabilizer !== true;

          if (ewsGone || positionChanged) {
            this._ewsFallbackTriggered = true;
            this.log("emergency", "⚠️ Emergency Warp Stabilizer activation detected (hull critical fallback)!");
            saveStoppedState(this.username, "emergency");
            saveLastUsedRoutine(this.username, "return_home");

            if (this._state === "running") {
              this._state = "stopping";
              this._abortController?.abort();
            }

            const botName = this.username;
            setTimeout(() => {
              void (async () => {
                const { handleStart, getBot } = await import("./botmanager.js");
                const bot = getBot(botName);
                if (!bot) return;
                if (bot.state === "running") return;
                await handleStart({ type: "start", bot: botName, routine: "return_home" });
              })().catch(() => {});
            }, 4000);
          }
        }
      }
     }

    // Towing state handling - moved outside ship block since it's on player/location
    if (player?.is_cloaked !== undefined || p.is_cloaked !== undefined || p.cloaked !== undefined || player?.cloaked !== undefined) {
      this.isCloaked = !!(player?.is_cloaked || p.is_cloaked || p.cloaked || player?.cloaked);
    }

    const towingWreckId = (p.towing_wreck_id as string) ?? (ship?.towing_wreck_id as string) ?? (r.towing_wreck_id as string);
    // Only update towing state if the field is present in the response
    if (towingWreckId !== undefined && towingWreckId !== null) {
      if (towingWreckId !== "") {
        this.towingWreck = true;
        this.towingWreckId = towingWreckId;
      } else {
        this.towingWreck = false;
        this.towingWreckId = null;
      }
    }
    // If field is not present, preserve existing towing state

    playerNameStore.add(this.username, this.faction || "", this.shipClass, "", this.system, this.poi);

    if (p.towing_wreck_id !== undefined || (ship && ship.towing_wreck_id !== undefined) || r.towing_wreck_id !== undefined) {
      this.log("debug", `Tow fields in status: p.towing_wreck_id=${p.towing_wreck_id}, this.towingWreck=${this.towingWreck}`);
    }

    if (this.hull <= 0 && this.maxHull > 0) {
      this.isDead = true;
    } else if (this.hull > 0 && this.isDead) {
      this.isDead = false;
    }

    if (typeof r.fuel === "number") this.fuel = r.fuel;

    if (this.system !== this.lastSystem || this.poi !== this.lastPoi) {
      this.log("debug", `Position changed: ${this.lastSystem}/${this.lastPoi} -> ${this.system}/${this.poi}`);
      this.logPosition();
      this.lastSystem = this.system;
      this.lastPoi = this.poi;
    }
  }

  async refreshLocation(): Promise<ApiResponse> {
    const resp: ApiResponse = this.account
      ? { result: this.account.state as unknown as Record<string, unknown>, error: undefined, notifications: [] }
      : await this.libExec("get_location");
    if (!resp.error && resp.result) {
      const r = resp.result as Record<string, unknown>;
      const location = r.location as Record<string, unknown> | undefined;
      const player = r.player as Record<string, unknown> | undefined;
      const p = location || player || r;
      this.system = (location?.system_id as string) || (p.current_system as string) || this.system;
      this.poi = (location?.poi_id as string) || (p.current_poi as string) || (p.poi_id as string) || this.poi;
      this.docked = location?.docked_at != null
        ? !!(location.docked_at)
        : (p.docked_at_base != null
          ? !!(p.docked_at_base)
          : (p.docked as boolean) ?? (p.status === "docked"));
      this.location =
        (location?.system_name as string) ||
        (location?.system_id as string) ||
        (p.current_system as string) ||
        (p.location as string) ||
        this.location;
      this.faction = (p.faction_id as string) ?? (p.faction as string) ?? this.faction ?? null;
      // For library-backed bots `r` is `account.state`, which the library only
      // updates from push events and does NOT keep current for is_cloaked /
      // credits (see refreshStatus's throttle note). Re-deriving these here from
      // that stale cache clobbers freshly-fetched values on every periodic tick,
      // reverting the dashboard to the client-start snapshot ~30s after a
      // "command all status". These fields are owned by refreshStatus() (a real
      // get_status), so only apply them from a genuine get_location (HTTP bots).
      if (!this.account && (player?.is_cloaked !== undefined || p.is_cloaked !== undefined || p.cloaked !== undefined || player?.cloaked !== undefined)) {
        this.isCloaked = !!(player?.is_cloaked || p.is_cloaked || p.cloaked || player?.cloaked);
      }
      const towingWreckId = (p.towing_wreck_id as string) ?? (player?.towing_wreck_id as string) ?? (r.towing_wreck_id as string);
      // Only update towing state if the field is present in the response (get_location may not include it)
      if (towingWreckId !== undefined && towingWreckId !== null) {
        if (towingWreckId !== "") {
          this.towingWreck = true;
          this.towingWreckId = towingWreckId;
        } else {
          this.towingWreck = false;
          this.towingWreckId = null;
        }
      }
      // If field is not present, preserve existing towing state
      const creditsValue = r.credits ?? player?.credits;
      if (!this.account && typeof creditsValue === "number") this.credits = creditsValue;
    }

    return resp;
  }

  async refreshShip(): Promise<ApiResponse> {
    const resp = this.account
      ? await this.libExec("get_ship", {})
      : await this.libExec("get_ship");
    if (!resp.error && resp.result) {
      const r = resp.result as Record<string, unknown>;
      const ship = (r.ship as Record<string, unknown>) || r;
      const player = r.player as Record<string, unknown> | undefined;
      if (ship) {
        const prevHullPct = this.maxHull > 0 ? (this.hull / this.maxHull) * 100 : 100;
        const prevHasEws = this.hasEmergencyWarpStabilizer;
        this.fuel = (ship.fuel as number) ?? this.fuel;
        this.maxFuel = (ship.max_fuel as number) ?? this.maxFuel;
        this.hull = (ship.hull as number) ?? (ship.hp as number) ?? this.hull;
        this.maxHull = (ship.max_hull as number) ?? (ship.max_hp as number) ?? this.maxHull;
        this.shield = (ship.shield as number) ?? (ship.shields as number) ?? this.shield;
        this.maxShield = (ship.max_shield as number) ?? (ship.max_shields as number) ?? this.maxShield;
        this.shipSpeed = (ship.speed as number) || this.shipSpeed;
        this.cargo = (ship.cargo_used as number) ?? this.cargo;
        this.cargoMax = (ship.cargo_capacity as number) ?? (ship.max_cargo as number) ?? this.cargoMax;
        this.shipId = (ship.id as string) || this.shipId;
        const { modules: modulesArray, resolved: modulesResolved } = extractShipModules(r);
        let totalAmmo = 0;
        for (const mod of modulesArray) {
          if (mod && typeof mod === "object" && mod.current_ammo != null) totalAmmo += mod.current_ammo as number;
        }
        if (totalAmmo > 0) this.ammo = totalAmmo;
        else if (ship.ammo != null) this.ammo = ship.ammo as number;
        this.applyModuleFlags(modulesArray, modulesResolved);

        if (!this._ewsFallbackTriggered && this._state === "running" && prevHasEws === true) {
          const hullPct = this.maxHull > 0 ? (this.hull / this.maxHull) * 100 : 100;
          if (prevHullPct > 20 && hullPct <= 20) {
            const positionChanged = this.system !== this.lastSystem || this.poi !== this.lastPoi;
            const ewsGone = this.hasEmergencyWarpStabilizer !== true;

            if (ewsGone || positionChanged) {
              this._ewsFallbackTriggered = true;
              this.log("emergency", "⚠️ Emergency Warp Stabilizer activation detected (hull critical fallback)!");
              saveStoppedState(this.username, "emergency");
              saveLastUsedRoutine(this.username, "return_home");

              if (this._state === "running") {
                this._state = "stopping";
                this._abortController?.abort();
              }

              const botName = this.username;
              setTimeout(() => {
                void (async () => {
                  const { handleStart, getBot } = await import("./botmanager.js");
                  const bot = getBot(botName);
                  if (!bot) return;
                  if (bot.state === "running") return;
                  await handleStart({ type: "start", bot: botName, routine: "return_home" });
                })().catch(() => {});
              }, 4000);
            }
          }
        }

        if (modulesArray.length > 0 || modulesResolved) {
          this.installedMods = modulesArray
            .map(m => moduleTypeId(m) || (m.name as string) || "")
            .filter(Boolean);
        }
      }
      const creditsValue = r.credits ?? player?.credits;
      if (typeof creditsValue === "number") this.credits = creditsValue;
    }
    return resp;
  }

  async refreshCargoAndStorage(): Promise<ApiResponse> {
    const cargoResp: ApiResponse = this.account
      ? { result: this.account.state as unknown as Record<string, unknown>, error: undefined, notifications: [] }
      : await this.libExec("get_cargo");
    if (!cargoResp.error && cargoResp.result) {
      this.inventory = this.parseItemList(cargoResp.result, 'cargo');
      const r = cargoResp.result as Record<string, unknown>;
      const player = r.player as Record<string, unknown> | undefined;
      const creditsValue = r.credits ?? player?.credits;
      if (typeof creditsValue === "number") this.credits = creditsValue;
    }
    if (this.docked) {
      await this.refreshStorage();
    }
    return cargoResp;
  }

  async refreshPOI(): Promise<ApiResponse> {
    const resp = this.account
      ? await this.libExec("get_poi", {})
      : await this.libExec("get_poi");
    if (!resp.error && resp.result) {
      const r = resp.result as Record<string, unknown>;
      const poi = (r.poi as Record<string, unknown>) || {};
      this.system = (poi.system_id as string) || (poi.system as string) || this.system;
      this.poi = (poi.id as string) || (poi.poi_id as string) || this.poi;
      this.docked = poi.docked != null ? !!(poi.docked as boolean) : this.docked;
      this.inTransit = (r.in_transit as boolean) ?? false;
      this.transitType = (r.transit_type as string) === "jump" ? "jump" : 
                         (r.transit_type as string) === "travel" ? "travel" : null;
      this.ticksRemaining = (r.ticks_remaining as number) ?? null;
    }
    return resp;
  }

  async refreshMissions(): Promise<ApiResponse> {
    if (this.account) return this.libExec("get_missions", {});
    return this.libExec("get_missions");
  }

  async refreshQueue(): Promise<ApiResponse> {
    if (this.account) return this.libExec("get_queue", {});
    return this.libExec("get_queue");
  }

  async refreshNearby(): Promise<ApiResponse> {
    this.log("observation", `Refreshing nearby via get_nearby (fallback)`);
    if (this.account) return this.libExec("get_nearby", {});
    return this.libExec("get_nearby");
  }

  /**
   * Scan the immediate area with get_nearby and feed the result into the
   * player and creature (wildlife) tracking systems.
   *
   * This is invoked automatically after every successful jump/travel so that
   * creature & player discoveries are never missed when a bot arrives at a new
   * system or POI (miners, traders, civilian transport, explorers, etc.).
   */
  async autoScanAndTrackNearby(): Promise<void> {
    try {
      const resp = this.account
        ? await this.libExec("get_nearby", {})
        : await this.libExec("get_nearby");
      if (!resp.error && resp.result) {
        this.trackNearbyPlayers(resp.result);
        this.trackWildlife(resp.result);
      }
    } catch (e) {
      // Never let a scan failure interrupt navigation/routines
      this.log("debug", `autoScanAndTrackNearby failed: ${e}`);
    }
  }

  async refreshSkills(): Promise<ApiResponse> {
     const resp = this.account
       ? await this.libExec("get_skills", {})
       : await this.libExec("get_skills");
     if (!resp.error && resp.result) {
       const r = resp.result as Record<string, unknown>;
       let skillsData: Record<string, unknown> | null = null;
       if (r.skills && typeof r.skills === "object") {
         skillsData = r.skills as Record<string, unknown>;
       } else if (r.data && typeof r.data === "object") {
         skillsData = r.data as Record<string, unknown>;
       } else {
         skillsData = r;
       }
       
       this.skillLevels.clear();
       this.skillXP.clear();
       this.skillTotalXP.clear();
       this.skillXpToNext.clear();
       for (const [skillId, skillVal] of Object.entries(skillsData)) {
         if (skillId === 'message' || skillId === 'status' || skillId === 'error') continue;
         if (skillVal && typeof skillVal === "object") {
           const s = skillVal as Record<string, unknown>;
           const level = (s.level as number) ?? (s.current_level as number) ?? 0;
           const rawXP = (s.xp as number) ?? (s.experience as number) ?? (s.current_xp as number) ?? 0;
           const xp = typeof rawXP === "number" ? rawXP : 0;
           const xpToNext = (s.xp_to_next_level as number) ?? (s.xp_to_next as number) ?? (s.xp_needed as number) ?? (s.xp_remaining as number);
           const totalXP = (s.total_xp as number) ?? (s.total_experience as number) ?? (s.cumulative_xp as number);
           this.skillLevels.set(skillId, level);
           this.skillXP.set(skillId, xp);
           if (xpToNext !== undefined) this.skillXpToNext.set(skillId, xpToNext);
           if (totalXP !== undefined) this.skillTotalXP.set(skillId, totalXP);
         }
       }
     }
     logSkills(this);
     return resp;
   }

  /** Parse an item list from API response, handling both item_id and resource_id formats. */
  public parseItemList(result: unknown, preferField?: string): CargoItem[] {
    if (!result || typeof result !== "object") return [];

    let r = result as Record<string, unknown>;

    // If response has a data wrapper, use that
    if (r.data && typeof r.data === "object") {
      r = r.data as Record<string, unknown>;
    }

    // Check structuredContent first (V2 API format)
    if (r.structuredContent && typeof r.structuredContent === "object") {
      const sc = r.structuredContent as Record<string, unknown>;
      const scHasTarget = preferField
        ? Array.isArray((sc as Record<string, unknown>)[preferField as string]) && ((sc as Record<string, unknown>)[preferField as string] as Array<Record<string, unknown>>).length > 0
        : (Array.isArray(sc.items) && sc.items.length > 0) || (Array.isArray(sc.storage) && sc.storage.length > 0);
      if (scHasTarget) {
        r = sc;
      }
    }

    // Determine which field to use based on preferField or auto-detect
    // preferField is used to prioritize a specific field (e.g., 'cargo' for get_cargo, 'storage' for view_storage)
    let items: Array<Record<string, unknown>>;
    if (preferField && Array.isArray(r[preferField]) && (r[preferField] as Array<Record<string, unknown>>).length > 0) {
      items = r[preferField] as Array<Record<string, unknown>>;
    } else {
      // Auto-detect: check multiple fields in order of priority, skipping empty arrays
      items = (
        Array.isArray(r) && r.length > 0 ? r :
        Array.isArray(r.cargo) && r.cargo.length > 0 ? r.cargo :
        Array.isArray(r.storage) && r.storage.length > 0 ? r.storage :
        Array.isArray(r.items) && r.items.length > 0 ? r.items :
        Array.isArray(r.stored_items) && r.stored_items.length > 0 ? r.stored_items :
        Array.isArray(r.faction_items) && r.faction_items.length > 0 ? r.faction_items :
        Array.isArray(r.faction_storage) && r.faction_storage.length > 0 ? r.faction_storage :
        Array.isArray(r.data) && r.data.length > 0 ? r.data :
        []
      ) as Array<Record<string, unknown>>;
    }

    return items
      .map((item) => {
        const parsedItem = {
          itemId: ((item.item_id as string) || (item.resource_id as string) || (item.id as string) || "").replace(/ /g, '_').toLowerCase(),
          name: (item.name as string) || (item.item_name as string) || (item.resource_name as string) || (item.item_id as string) || "",
          quantity: (item.quantity as number) || (item.count as number) || (item.amount as number) || 0,
        };

        return parsedItem;
      })
      .filter((i) => i.itemId && i.quantity > 0);
  }

  /** Fetch cargo contents and cache them. */
  async refreshCargo(): Promise<void> {
    const resp = await this.exec("get_cargo");
    this.inventory = this.parseItemList(resp.result, 'cargo');
    if (!resp.error && resp.result) {
      const r = resp.result as Record<string, unknown>;
      const player = r.player as Record<string, unknown> | undefined;
      const creditsValue = r.credits ?? player?.credits;
      if (typeof creditsValue === "number") this.credits = creditsValue;
    }
    this.notifyStateChanged();
  }

  /** Fetch station storage contents and cache them. Pass station_id to check remotely. */
  async refreshStorage(stationId?: string): Promise<void> {
    const resp = await this.exec("view_storage", stationId ? { station_id: stationId } : undefined);
    this.storage = this.parseItemList(resp.result, 'storage');
    if (!resp.error && resp.result) {
      const r = resp.result as Record<string, unknown>;
      const player = r.player as Record<string, unknown> | undefined;
      const creditsValue = r.credits ?? player?.credits;
      if (typeof creditsValue === "number") this.credits = creditsValue;
    }
    this.notifyStateChanged();
  }

  /**
   * Fetch tax estimate and save to data/taxes.json if changed.
   * Only updates when tax values actually change to preserve history.
   */
  async updateTaxEstimate(): Promise<TaxEstimate | null> {
    const resp = await this.exec("get_tax_estimate");
    if (resp.error || !resp.result) {
      this.log("warn", `get_tax_estimate failed: ${resp.error?.message}`);
      return null;
    }

    const result = resp.result as Record<string, unknown>;
    const estimate: TaxEstimate = {
      botUsername: this.username,
      timestamp: Date.now(),
      taxable_income_to_date: (result.taxable_income_to_date as number) || 0,
      income_tax_total: (result.income_tax_total as number) || 0,
      property_tax_total: (result.property_tax_total as number) || 0,
      assessed_property_value: (result.assessed_property_value as number) || 0,
      tax_prepaid: (result.tax_prepaid as number) || 0,
      last_assessed_at: (result.last_assessed_at as number) || 0,
    };

    if (hasTaxEstimateChanged(this.username, estimate)) {
      saveTaxEstimate(this.username, estimate);
      this.log("system", `Tax estimate updated: income=${estimate.taxable_income_to_date}, income_tax=${estimate.income_tax_total}, property_tax=${estimate.property_tax_total}, prepaid=${estimate.tax_prepaid}`);
    } else {
      this.log("system", "Tax estimate unchanged, skipping save");
    }

    return estimate;
  }

  /**
   * Fetch faction tax estimate and save to data/faction_taxes.json.
   */
  async updateFactionTaxEstimate(): Promise<FactionTaxEstimate | null> {
    const resp = await this.exec("get_faction_tax_estimate");
    if (resp.error || !resp.result) {
      this.log("warn", `get_faction_tax_estimate failed: ${resp.error?.message}`);
      return null;
    }

    const result = resp.result as Record<string, unknown>;
    const estimate: FactionTaxEstimate = {
      action: "get_faction_tax_estimate",
      faction_id: (result.faction_id as string) || "",
      faction_name: (result.faction_name as string) || "",
      domicile: (result.domicile as string) || "",
      taxable_income_to_date: (result.taxable_income_to_date as number) || 0,
      deductible_expenses_to_date: (result.deductible_expenses_to_date as number) || 0,
      net_taxable_profit: (result.net_taxable_profit as number) || 0,
      income_tax: (result.income_tax as Array<any>) || [],
      income_tax_total: (result.income_tax_total as number) || 0,
      carried_debt: (result.carried_debt as Array<any>) || [],
      carried_debt_total: (result.carried_debt_total as number) || 0,
      tax_prepaid: (result.tax_prepaid as number) || 0,
      next_assessment_approx_seconds: (result.next_assessment_approx_seconds as number) || 0,
      tax_collection_active: (result.tax_collection_active as boolean) ?? true,
      last_assessed_at: (result.last_assessed_at as number) || Date.now(),
      note: (result.note as string) || "",
    };

    saveFactionTaxEstimate(estimate);
    this.log("system", `Faction tax estimate updated: income=${estimate.taxable_income_to_date}, tax=${estimate.income_tax_total}, prepaid=${estimate.tax_prepaid}`);
    return estimate;
  }

  /**
   * Idempotently top up this bot's personal tax-prepayment pool so it covers
   * the current estimated tax bill. Only the *shortfall* (owed minus what is
   * already prepaid) is ever sent, so re-running this daily can never stack a
   * huge double-prepayment on top of a small bill — prepaid credits are escrowed
   * and only refunded after Sunday's assessment, so over-paying is money frozen
   * until then.
   *
   * The wallet is checked first; if it can't cover the shortfall, credits are
   * pulled from faction storage via `faction_withdraw_credits` (requires a
   * docked bot with ManageTreasury access) before prepaying.
   *
   * Returns the amount actually prepaid (0 if already covered or it failed).
   */
  async prepayTaxShortfall(opts?: { maxPrepay?: number; useFactionStorage?: boolean }): Promise<number> {
    const maxPrepay = opts?.maxPrepay ?? Infinity;
    const useFactionStorage = opts?.useFactionStorage ?? true;

    // Refresh the live estimate so we never act on stale data.
    const estimate = await this.updateTaxEstimate();
    if (!estimate) {
      this.log("warn", "prepayTaxShortfall: could not fetch tax estimate");
      return 0;
    }

    const owed = estimate.income_tax_total + estimate.property_tax_total;
    const alreadyPrepaid = estimate.tax_prepaid;
    const shortfall = Math.max(0, Math.ceil(owed - alreadyPrepaid));

    if (shortfall <= 0) {
      this.log("system", `Tax prepay not needed: owed=${owed}, prepaid=${alreadyPrepaid} (fully covered)`);
      return 0;
    }

    const wanted = Math.min(shortfall, maxPrepay);
    if (!Number.isFinite(wanted) || wanted <= 0) {
      this.log("system", `Tax prepay capped: shortfall=${shortfall} exceeds maxPrepay=${maxPrepay}`);
      return 0;
    }

    // Ensure we have a current wallet balance.
    await this.refreshStatus();
    let wallet = this.credits;

    if ((wallet ?? 0) < wanted && useFactionStorage) {
      const need = Math.ceil(wanted - (wallet ?? 0));
      this.log("system", `Tax prepay: withdrawing ${need}cr from faction storage (wallet=${wallet ?? 0}, want=${wanted})`);
      const wres = await this.exec("faction_withdraw_credits", { amount: need });
      if (wres.error) {
        this.log("warn", `Tax prepay faction withdraw failed: ${wres.error.message}`);
        // Fall back to whatever is in the wallet.
      } else {
        await this.refreshStatus();
        wallet = this.credits;
      }
    }

    const available = Math.max(0, Math.floor(wallet ?? 0));
    const toPrepay = Math.min(wanted, available);

    if (toPrepay <= 0) {
      this.log("warn", `Tax prepay skipped: no available credits (wallet=${wallet ?? 0}, want=${wanted})`);
      return 0;
    }

    const res = await this.exec("prepay_tax", { amount: toPrepay });
    if (res.error) {
      this.log("error", `Tax prepay failed: ${res.error.message}`);
      return 0;
    }

    this.log("system", `Tax prepay: sent ${toPrepay}cr (owed=${owed}, prepaid was=${alreadyPrepaid}, shortfall=${shortfall})`);

    // Re-fetch the live estimate so the new tax_prepaid balance is persisted to
    // data/taxes.json (the Refresh button only reads that file). Without this the
    // web UI would keep showing the stale pre-prepay balance until the next
    // scheduled estimate refresh.
    await this.updateTaxEstimate();
    return toPrepay;
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

  /**
   * Fetch faction storage contents and cache them. Uses view_faction_storage with station_id for remote access.
   *
   * @param forceLive When true, bypasses the API response cache so callers (the
   *   crafter) always get the current on-disk server inventory. The underlying
   *   `view_faction_storage` command is cached for 120s in api.ts, and the bot's
   *   own crafting jobs constantly consume/produce materials — so a cached read
   *   is routinely minutes behind reality and makes the planner undercount
   *   holdings (e.g. think it has 714k steel_plate when it really has 1.1M),
   *   which wastes queue slots refining materials it already has enough of.
   */
  async refreshFactionStorage(forceLive = false, stationId?: string, readCurrentStation = false): Promise<void> {
    const settings = loadSettings();
    const generalSettings = (settings.general as Record<string, unknown>) || {};
    const homeStationId = (generalSettings.factionStorageStation as string) || "";

    // Two read modes:
    //  - specific station: read `stationId` if given, else the configured hub
    //    (factionStorageStation). Faction storage is PER-STATION, so a deposit
    //    into station A must be verified by reading station A.
    //  - current station: omit station_id entirely so the server returns the
    //    faction storage of the station we're currently docked at.
    //
    // The server's `view_faction_storage` station_id is the station's POI — same
    // as a regular station's POI. Player faction bases are exposed as hex POI ids
    // (e.g. a356fc2c1744c0425cf6cf47f48def92), so a station reference must be
    // resolved to that plain hex id before being sent, otherwise the lookup
    // fails with "Station not found".
    let readStation: string | undefined;
    let cacheKey: string;
    if (readCurrentStation) {
      readStation = undefined;
      cacheKey = `${this.system}|${this.poi}`;
    } else if (stationId || homeStationId) {
      readStation = stationId || homeStationId;
      cacheKey = readStation;
    } else if (this.docked && this.poi) {
      // No specific station was passed and no faction hub is configured, but we
      // ARE docked at a station — read the faction storage of the CURRENT
      // station. Faction storage is per-station, so when we're docked at (for
      // example) the cargo mover's source station this is precisely the storage
      // the caller needs. Bailing out here would leave this.factionStorage empty
      // and make callers believe the station is empty even when it is full
      // (the "nothing to move" bug when factionStorageStation is unset).
      readStation = undefined;
      readCurrentStation = true;
      cacheKey = `${this.system}|${this.poi}`;
    } else {
      this.log("warn", "No factionStorageStation configured in settings.general and not docked - cannot refresh faction storage");
      return;
    }

    // Resolve a station reference (e.g. "system|poi" or a friendly name) to the
    // plain hex POI id the server expects as station_id. Faction bases are hex
    // ids, and a "system|poi" reference must be collapsed to just the poi token
    // or the remote lookup is rejected. When the reference is already a bare hex
    // id / raw token that mapStore can't resolve, this preserves it untouched.
    let stationIdParam: string | undefined;
    if (readStation) {
      const resolved = mapStore.resolveStationIdentity(readStation);
      stationIdParam = (resolved.matched && resolved.poiId) ? resolved.poiId : mapStore.resolveStationTarget(readStation);
      // Keep cacheKey aligned with the resolved id so a docked read (keyed on
      // `${system}|${poi}`) and a remote read of the same base share a cache.
      cacheKey = stationIdParam;
    }

    const factionName = this.faction || "unknown";
    const label = stationIdParam ? ` from ${stationIdParam}` : " (current station)";
    // Force a live API call. We never want the 120s response cache here, and we
    // do NOT rely on the data/factionStorage/*.json cache files (they are often
    // stale or wildly incorrect). We call api.execute directly (as get_status
    // does) so we can pass bypassCache without going through the command
    // bookkeeping in exec().
    const resp = await this.libExec(
      "view_faction_storage",
      stationIdParam ? { station_id: stationIdParam } : {},
    );
    if (resp.error) {
      const errMsg = resp.error.message || "";
      // Not being in a faction is expected for many players and not
      // actionable, so don't flood the log with a red error every refresh.
      if (!/you must be in a faction/i.test(errMsg)) {
        this.log("error", `Error refreshing faction storage${label}: ${errMsg}`);
      }
      // Do NOT silently fall back to the on-disk cache file — those are known to
      // be stale/misleading. Keep whatever the last successful live read gave us
      // so counts stay consistent instead of jumping to a wrong cached value.
      if (this.factionStorage.length === 0) {
        const cached = getFactionStorageCache(factionName, cacheKey);
        if (cached?.entries?.length) {
          this.log("warn", `No live faction storage and bot store empty - falling back to stale cache${label}: ${cached.entries.length} items (may be inaccurate)`);
          this.factionStorage = cached.entries.map((e) => ({
            itemId: e.itemId,
            name: e.name || e.itemId,
            quantity: e.quantity,
          }));
          this.factionFuelReserve = cached.factionFuelReserve || 0;
          this.factionFuelCapacity = cached.factionFuelCapacity || 0;
        }
      }
    } else {
      const result = resp.result as Record<string, unknown> | null;
      // Use the robust item parser (same one used for view_storage) so we
      // correctly handle whichever field view_faction_storage returns its items
      // under (items / faction_items / stored_items / data wrapper, etc.). The
      // fragile inline parser here previously missed the real field, leaving
      // factionStorage empty so the crafter undercounted holdings.
      const entries = this.parseItemList(result);

      if (entries.length === 0) {
        this.log("warn", "Faction storage refresh returned 0 items");
      }

      // Guard against a degraded live read clobbering good data. The server can
      // return a partial/near-empty payload (e.g. only the 18 items of the
      // station the bot happens to be docked at, instead of the full hub
      // storage at factionStorageStation) even when a previous read already
      // populated bot.factionStorage with the real thousands of items. If we
      // overwrite the good set with the tiny one, the crafter suddenly "loses"
      // its holdings (e.g. the 536k aluminum_sheet) and wrongly decides it must
      // re-smelt them — which then fails on aluminum_ore and holds the whole
      // chain. Only accept the live result when it carries a comparable or
      // larger amount of stock than what we already had; otherwise keep the
      const priorCount = this.factionStorage.length;
      const sumQty = (xs: { quantity: number }[]) => xs.reduce((n, x) => n + (x.quantity || 0), 0);
      const priorQty = priorCount > 0 ? sumQty(this.factionStorage) : 0;
      const liveQty = sumQty(entries);

      // Only treat a read as "degraded" when it is a re-read of the SAME station
      // that we already cached. Faction storage is per-station; a small read is
      // completely legitimate when it's a DIFFERENT (e.g. the cargo mover's real
      // source) station whose holdings genuinely differ from the previously cached
      // station. The old blanket `liveQty < priorQty * 0.5` guard kept the wrong
      // (large) station's holdings forever and made the bot believe phantom stock
      // was "already held" — so it planned against items that didn't exist at the
      // station it was actually docked at. Now a read of a new station always
      // replaces the cache; only a same-station read that suddenly collapses is
      // rejected as a partial/transient payload.
      const sameStation = this.factionStorageStation !== null &&
        stationIdParam !== undefined &&
        this.factionStorageStation === stationIdParam;
      const looksDegraded = sameStation && priorQty > 0 && liveQty < priorQty * 0.5;

      if (entries.length > 0 && !looksDegraded) {
        this.factionStorage = entries;
        this.factionStorageStation = stationIdParam ?? null;
      } else if (priorCount > 0 && looksDegraded) {
        this.log("warn", `Faction storage live refresh (${stationIdParam ?? "current station"}) returned only ${liveQty} total qty vs ${priorQty} already held at this station - keeping prior holdings to avoid undercounting`);
      } else {
        this.factionStorage = entries;
        this.factionStorageStation = stationIdParam ?? null;
      }
      this.factionFuelReserve = (result?.faction_fuel_reserve as number) || 0;
      this.factionFuelCapacity = (result?.faction_fuel_capacity as number) || 0;
      updateFactionStorageCache(factionName, entries, cacheKey, this.factionFuelReserve, this.factionFuelCapacity);
      this.log("info", `Refreshed faction storage${label}: ${entries.length} items${forceLive ? " (live)" : ""}`);
    }
    this.notifyStateChanged();
  }

  // ── Realtime market push handling ─────────────────────────

  /** Feed a market snapshot/update into the stream store and dashboard cache. */
  private handleMarketUpdate(payload: NotificationMarketUpdate): void {
    const baseId = payload.base_id;
    if (!baseId || !Array.isArray(payload.items)) return;
    marketStreamStore.update(baseId, payload.tick, payload.items);

    // Optional mirror into the dashboard's HTTP market cache, normalizing
    // the WS order-book shape (price_each) into what mapStore expects (price).
    try {
      const normalized = payload.items.map((it) => ({
        item_id: it.item_id,
        item_name: it.item_name,
        sell_orders: it.sell_orders.map((o) => ({ price: o.price_each, quantity: o.quantity, source: o.source })),
        buy_orders: it.buy_orders.map((o) => ({ price: o.price_each, quantity: o.quantity, source: o.source })),
      }));
      perf.timeSync("mapStore.updateMarket", () => mapStore.updateMarket(this.system, this.poi, { items: normalized }));
    } catch { /* ignore dashboard mirror errors */ }
  }

  /** Start running a routine. */
  async start(
    routineName: string,
    routine: Routine,
    opts?: {
      getFleetStatus?: () => BotStatus[];
      getFleetStatusAsync?: () => Promise<BotStatus[]>;
      getBotFreshStatus?: (botName: string) => Promise<BotStatus | null>;
      sendBotChat?: (content: string, channel: string, recipients?: string[], metadata?: Record<string, unknown>) => void;
      getAllBotNames?: () => string[];
    },
  ): Promise<void> {
    if (this._state === "running") {
      this.log("error", "Bot is already running");
      return;
    }

    this._state = "running";
    this._routine = routineName;
    this._error = null;
    this._abortController = new AbortController();

    // (Re)subscribe to the realtime market push stream if this routine deals
    // with trade (explorer/trader); otherwise ensure it's dropped to save
    // game-server bandwidth.
    this.syncMarketSubscription();

    // (Re)subscribe to the realtime market push stream if this routine deals
    // with trade (explorer/trader); otherwise ensure it's dropped to save
    // game-server bandwidth.

    // Library-backed bots are already authenticated via connectOwned(); the
    // legacy per-bot rate-limiting toggle and credential/session resume flow
    // were part of the retired HTTP transport.
    this.log("system", `Starting routine: ${routineName}`);

    const ctx: RoutineContext = {
      bot: this,
      log: (cat, msg) => this.log(cat, msg),
      // Interruptible sleep that checks for stop signal every 100ms
      sleep: (ms: number) => {
        return new Promise<void>((resolve) => {
          const start = Date.now();
          const self = this; // Capture this for use in setInterval callback
          const timer = setInterval(() => {
            if (self._state === "stopping" || self._stopAfterCycle) {
              clearInterval(timer);
              resolve();
              return;
            }
            if (Date.now() - start >= ms) {
              clearInterval(timer);
              resolve();
            }
          }, 100);
        });
      },
      getFleetStatus: opts?.getFleetStatus,
      getFleetStatusAsync: opts?.getFleetStatusAsync,
      getBotFreshStatus: opts?.getBotFreshStatus,
      sendBotChat: opts?.sendBotChat,
      getAllBotNames: opts?.getAllBotNames,
    };

    await ensureInsured(ctx);

    const generator = routine(ctx);
    try {
      while (true) {
        let stateName!: string | void;
        let done!: boolean | undefined;
        if (perf.isEnabled()) {
          const cpuStart = process.cpuUsage();
          const wallStart = performance.now();
          ({ value: stateName, done } = await generator.next());
          const wallMs = performance.now() - wallStart;
          const cpuDelta = process.cpuUsage(cpuStart);
          perf.markRoutineTick(this.username, routineName, (cpuDelta.user + cpuDelta.system) / 1000, wallMs);
        } else {
          ({ value: stateName, done } = await generator.next());
        }
        if (done) break;
        if ((this._state as BotState) === "stopping") {
          this.log("system", `Stopped during state: ${stateName}`);
          break;
        }
        // Small gap between actions - use interruptible sleep
        await ctx.sleep(2000);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._error = msg;
      this.log("error", `Routine error: ${msg}`);
      this._state = "error";
      // Re-throw so the caller's .catch() handler fires, ensuring the bot
      // assignment is cleared and "crashed" is logged rather than "finished".
      throw err;
    } finally {
      await generator.return(undefined);
    }

    this._state = "idle";
    this._routine = null;
    // Routine ended — drop the market push stream (it was only for trade
    // routines) so an idle bot generates no market bandwidth.
    this.syncMarketSubscription();
    this.log("system", "Routine finished");
  }

  /** Fetch ship modules and cache installed mod type ids. */
  async refreshShipMods(): Promise<string[]> {
    const resp = await this.exec("get_ship");
    if (resp.result && typeof resp.result === "object") {
      const { modules, resolved } = extractShipModules(resp.result);

      // Type ids ("afterburner_ii"), not instance UUIDs — callers compare these
      // against configured mod profiles.
      if (modules.length > 0 || resolved) {
        this.installedMods = modules
          .map(m => moduleTypeId(m) || (m.name as string) || "")
          .filter(Boolean);
      }
      this.applyModuleFlags(modules, resolved);
    }
    return this.installedMods;
  }

  /**
   * Apply module-derived capability flags.
   *
   * A positive match is always trusted. A negative is only trusted when the
   * whole fitted list resolved to real module objects — otherwise the payload
   * gave us nothing but opaque instance ids and "not found" would wrongly
   * clear a flag we already learned from a richer response.
   */
  private applyModuleFlags(modules: Array<Record<string, unknown> | string>, resolved: boolean): void {
    if (!resolved && modules.length === 0) return;

    const pathfinder = this.hasPathfinderModule(modules);
    const ews = this.hasEwsModule(modules) === true;
    const leadLined = this.hasLeadLinedCargoModule(modules) === true;

    if (resolved) {
      this.hasPathfinderDrive = pathfinder;
      this.hasEmergencyWarpStabilizer = ews;
      this.hasLeadLinedCargoHold = leadLined;
      return;
    }
    if (pathfinder) this.hasPathfinderDrive = true;
    if (ews) this.hasEmergencyWarpStabilizer = true;
    if (leadLined) this.hasLeadLinedCargoHold = true;
  }

  private hasPathfinderModule(modules: Array<Record<string, unknown> | string>): boolean {
    for (const m of modules) {
      if (typeof m === "string") continue;
      const mod = m as Record<string, unknown>;
      const stats = mod.stats as Record<string, unknown> | undefined;
      if (stats && stats.special === "pathfinder_drive") return true;
      if (mod.type_id === "pathfinder_drive" || mod.module_id === "pathfinder_drive") return true;
      const n = mod.name;
      if (typeof n === "string" && n.toLowerCase().includes("pathfinder")) return true;
      if (mod.special === "pathfinder_drive") return true;
    }
    return false;
  }

  /** Detect whether an installed module is an Emergency Warp Stabilizer. */
  /**
   * Detect whether an installed module is an Emergency Warp Stabilizer.
   * Returns `true`/`false` only when the module list contains resolvable
   * module objects; returns `null` when the list is empty or contains only
   * opaque UUID strings (unresolvable) so callers can keep the last known
   * value instead of wrongly reporting "no EWS".
   */
  private hasEwsModule(modules: Array<Record<string, unknown> | string>): boolean | null {
    if (modules.length === 0) return null;
    let sawResolvable = false;
    for (const m of modules) {
      if (typeof m === "string") {
        // A bare string is an opaque UUID we can't classify — skip it.
        continue;
      }
      sawResolvable = true;
      const mod = m as Record<string, unknown>;
      const id = mod.type_id || mod.module_id || mod.mod_id || mod.id || mod.item_id;
      if (typeof id === "string" && id.toLowerCase() === "emergency_warp_stabilizer") return true;
      const stats = mod.stats as Record<string, unknown> | undefined;
      if (stats && stats.special === "emergency_warp_stabilizer") return true;
      if (mod.special === "emergency_warp_stabilizer") return true;
      const n = mod.name;
      if (typeof n === "string" && n.toLowerCase().includes("emergency warp stabilizer")) return true;
    }
    // We had real module objects but none were EWS → definitively absent.
    return sawResolvable ? false : null;
  }

  /** Detect whether the ship has lead-lined cargo modules. */
  private hasLeadLinedCargoModule(modules: Array<Record<string, unknown> | string>): boolean | null {
    if (modules.length === 0) return null;
    for (const m of modules) {
      if (typeof m === "string") continue;
      const mod = m as Record<string, unknown>;
      const modId = (mod.type_id as string) || (mod.module_id as string) || (mod.mod_id as string) || "";
      const modName = (mod.name as string) || "";
      const modType = (mod.type as string) || "";
      const modSpecial = (mod.special as string) || "";
      const checkStr = `${modId} ${modName} ${modType} ${modSpecial}`.toLowerCase();
      if (checkStr.includes("lead_lined_cargo") || checkStr.includes("lead lined cargo") || checkStr.includes("hazmat_cargo")) {
        return true;
      }
    }
    return false;
  }

  async pollCurrentTick(): Promise<number | null> {
    const resp = await this.exec("get_notifications");
    if (resp.error || !resp.result) {
      if (this.lastKnownTick !== null) {
        this.log("warn", "get_notifications failed, using lastKnownTick for tick estimation");
      }
      return null;
    }
    const r = resp.result as Record<string, unknown>;
    let tick = r.current_tick as number | undefined;
    if (typeof tick !== "number") {
      tick = r.tick as number | undefined;
    }
    if (typeof tick === "number") {
      this.lastKnownTick = tick;
      return tick;
    }
    if (this.lastKnownTick !== null) {
      this.log("debug", `current_tick not in response, using lastKnownTick=${this.lastKnownTick}`);
    }
    return null;
  }

  async awaitNextTick(pollIntervalMs = 5000): Promise<number> {
    const startTick = await this.pollCurrentTick();
    if (startTick === null) throw new Error("Could not determine current tick");
    while (this.state === "running") {
      await new Promise(r => setTimeout(r, pollIntervalMs));
      const nextTick = await this.pollCurrentTick();
      if (nextTick !== null && nextTick > startTick) return nextTick;
    }
    throw new Error("Bot stopped while waiting for next tick");
  }

  async waitForTick(tickNumber: number, pollIntervalMs = 5000): Promise<boolean> {
    while (this.state === "running") {
      const current = await this.pollCurrentTick();
      if (current !== null && current >= tickNumber) return true;
      await new Promise(r => setTimeout(r, pollIntervalMs));
    }
    return false;
  }

  async performPathfinderJump(
    targetSystemId: string
  ): Promise<{ success: boolean; arrivedTick?: number; landing?: { systemId: string; ticks: number } }> {
    if (!this.hasPathfinderDrive) {
      await this.refreshShipMods();
    }
    if (!this.hasPathfinderDrive) {
      this.log("error", "Pathfinder jump attempted without Pathfinder Drive module.");
      return { success: false };
    }

    await this.refreshStatus();
    
    const originSystem = this.system;
    
    let directJump = getDirectPathfinderJump(originSystem, targetSystemId);
    let correctionJump = getCorrectionPathfinderJump(originSystem, targetSystemId);
    
    let bearing: number;
    let landingTicks: number;
    let landingSystemId: string;
    
    if (directJump) {
      bearing = directJump.bearing;
      landingTicks = directJump.ticks;
      landingSystemId = directJump.to;
      this.log("travel", `Using precomputed direct jump: ${originSystem} -> ${targetSystemId}, bearing ${bearing.toFixed(4)}°, ETA ${landingTicks} ticks`);
    } else if (correctionJump) {
      bearing = correctionJump.legs[0].bearing;
      landingTicks = correctionJump.total_ticks;
      landingSystemId = targetSystemId;
      this.log("travel", `Using precomputed correction jump: ${originSystem} -> ${targetSystemId}, bearing ${bearing.toFixed(4)}°, ETA ${landingTicks} ticks (${correctionJump.corrections_used} corrections)`);
    } else {
      const calculatedBearing = mapStore.calculatePathfinderBearing(originSystem, targetSystemId);
      if (typeof calculatedBearing !== "number") {
        this.log("error", `Could not calculate bearing to ${targetSystemId} from ${originSystem}`);
        return { success: false };
      }
      bearing = calculatedBearing;
      const landing = mapStore.simulatePathfinderLanding(originSystem, bearing);
      if (!landing) {
        this.log("error", `No landing predicted for bearing ${bearing}° — aborting pathfinder jump`);
        return { success: false };
      }
      landingTicks = landing.ticks;
      landingSystemId = landing.systemId;
      this.log("travel", `Calculated jump: ${originSystem} -> ${targetSystemId}, bearing ${bearing.toFixed(4)}°, ETA ${landingTicks} ticks`);
    }
    
    this.log("travel", `Pathfinder jump: ${originSystem} -> ${targetSystemId}, bearing ${bearing.toFixed(4)}°, ETA ${landingTicks} ticks (${landingTicks * 10}s)`);
    this.log("travel", `Predicted landing on ${landingSystemId}`);

    const travelRecord: PathfinderTravelRecord = {
      botName: this.username,
      originSystem: originSystem,
      originTick: 0,
      initialBearing: bearing,
      corrections: [],
      lastPolledTick: 0,
      status: "in_transit",
      destinationSystem: targetSystemId,
    };
    setPathfinderTravelState(this.username, travelRecord as any);

    const originTick = await this.pollCurrentTick();
    travelRecord.originTick = (originTick ?? 0) + 1;
    travelRecord.lastPolledTick = originTick ?? 0;
    setPathfinderTravelState(this.username, travelRecord as any);

    const jumpResp = await this.exec("jump", { target_system: bearing });
    if (jumpResp.error) {
      this.log("error", `Pathfinder jump failed: ${jumpResp.error.message}`);
      clearPathfinderTravel(this.username);
      return { success: false };
    }

    const jr = jumpResp.result as Record<string, unknown> | undefined;
    const arrivalSystemId = (jr?.arrival_system_id as string) || (jr?.system_id as string) || (jr?.from_system as string) || "";
    const arrivalSystemName = (jr?.arrival_system as string) || (jr?.system as string) || (jr?.from_system as string) || "";
    const exitPoi = (jr?.poi as string) || (jr?.exit_poi as string) || "";
    if (arrivalSystemId || exitPoi) {
      this.log("travel", `Jump result from server: system=${arrivalSystemName || '?'} (${arrivalSystemId}), exit_poi=${exitPoi || 'n/a'}`);
      this.log("travel", `Intended destination: ${landingSystemId} (${targetSystemId}) — match: ${arrivalSystemId.toLowerCase() === landingSystemId.toLowerCase()}`);
    } else {
      this.log("info", `Jump command accepted. Use get_poi to determine actual transit path.`);
    }

    await new Promise(r => setTimeout(r, 500));
    const poiResp = await this.libExec("get_poi");
    if (!poiResp.result || typeof poiResp.result !== "object") {
      this.log("error", "Pathfinder jump: failed to get initial transit status");
      clearPathfinderTravel(this.username);
      return { success: false };
    }
    const poi = poiResp.result as Record<string, unknown>;
    let inTransit = (poi.in_transit as boolean) ?? false;
    let ticksRemaining = (poi.ticks_remaining as number) ?? landingTicks;
    let currentFrom = (poi.from_system as string) ?? "";
    let currentTo = (poi.to_system as string) ?? "";
    let currentBearing = bearing;

    this.log("travel", `Pathfinder transit: from=${currentFrom}, to=${currentTo}, in_transit=${inTransit}, ticks_remaining=${ticksRemaining}`);

    const maxPolls = Math.max(landingTicks * 3 + 50, 300);
    let arrived = false;
    let poll = 0;
    let correctionIssued = false;
    let elapsedTicks = 0;
    let nearMccWindow = false;
    let lastLoggedTick: number | null = null;

    while (this.state === "running" && poll < maxPolls) {
      await new Promise(r => setTimeout(r, 5000));
      poll++;

      const poiResp2 = await this.libExec("get_poi");
      if (poiResp2.result && typeof poiResp2.result === "object") {
        const poi2 = poiResp2.result as Record<string, unknown>;
        inTransit = (poi2.in_transit as boolean) ?? false;
        ticksRemaining = (poi2.ticks_remaining as number) ?? ticksRemaining;
        currentFrom = (poi2.from_system as string) ?? "";
        currentTo = (poi2.to_system as string) ?? "";
        if (correctionJump && !correctionIssued) {
          const mccInfo = getMccWindowInfo(correctionJump, elapsedTicks);
          const targetTick = mccInfo?.ticksUntilMcc !== undefined 
            ? elapsedTicks + mccInfo.ticksUntilMcc 
            : null;
          nearMccWindow = targetTick !== null && Math.abs(elapsedTicks - targetTick) <= 2;
        }
      }

      const tick = await this.pollCurrentTick();
      if (tick !== null) {
        updatePathfinderTravelTick(this.username, tick);
        elapsedTicks = tick - travelRecord.originTick;
        if (tick !== lastLoggedTick) {
          lastLoggedTick = tick;
          let mccInfoStr = "";
          if (correctionJump && !correctionIssued) {
            const mccInfo = getMccWindowInfo(correctionJump, elapsedTicks);
            if (mccInfo && mccInfo.ticksUntilMcc > 0) {
              mccInfoStr = `, mcc_in=${mccInfo.ticksUntilMcc} ticks (bearing ${mccInfo.correctionBearing.toFixed(1)}°)`;
            }
          }
          this.log("travel", `Pathfinder in transit — from=${currentFrom}, to=${currentTo}, ticks_remaining=${ticksRemaining}${mccInfoStr}`);
        }
      }

      if (!inTransit) {
        const locResp = await this.libExec("get_location");
        if (locResp.result && typeof locResp.result === "object") {
          const loc = locResp.result as Record<string, unknown>;
          const newSystem = (loc.system_id as string) || (loc.system_name as string) || null;
          if (newSystem) this.system = newSystem;
        }
        const lowerCurrent = this.system.toLowerCase();
        const lowerTarget = landingSystemId.toLowerCase();
        if (lowerCurrent === lowerTarget || lowerCurrent === targetSystemId.toLowerCase()) {
          arrived = true;
          this.log("travel", `Pathfinder jump complete: arrived at ${this.system}`);
          break;
        }
      }

      if (ticksRemaining <= 0) {
        arrived = true;
        this.log("travel", `Pathfinder jump complete: all ticks elapsed`);
        break;
      }

      if ((poll % 10 === 0 || nearMccWindow) && poll > 1 && !correctionIssued) {
        const expectedFrom = travelRecord.originSystem;
        const expectedTo = landingSystemId;
        if (currentFrom && currentTo) {
          const fromMatch = currentFrom.toLowerCase() === expectedFrom.toLowerCase();
          const toMatch = currentTo.toLowerCase() === expectedTo.toLowerCase();
          if (!fromMatch || !toMatch) {
            this.log("travel", `Pathfinder deviation detected: expected ${expectedFrom} -> ${expectedTo}, but transit shows ${currentFrom} -> ${currentTo}`);
            
            if (correctionJump && tick !== null) {
              const correctionInfo = getCorrectionBearingAtTick(correctionJump, tick, travelRecord.originTick);
              if (correctionInfo) {
                this.log("travel", `Pathfinder correction jump to bearing ${correctionInfo.bearing.toFixed(4)}° (leg ${correctionInfo.legIndex + 1}/${correctionJump.legs.length})`);
                recordPathfinderCorrection(this.username, tick + 1, correctionInfo.bearing);
                const correctionResp = await this.exec("jump", { target_system: correctionInfo.bearing });
                if (correctionResp.error) {
                  this.log("error", `Correction jump failed: ${correctionResp.error.message}`);
                } else {
                  this.log("travel", `Correction jump issued successfully`);
                  currentBearing = correctionInfo.bearing;
                  correctionIssued = true;
                  await new Promise(r => setTimeout(r, 1000));
                }
              }
            } else {
              const currentSystem = this.system || currentFrom;
              const correctionBearing = mapStore.calculatePathfinderBearing(currentSystem, targetSystemId);
              if (typeof correctionBearing === "number") {
                const correctedLanding = mapStore.simulatePathfinderLanding(currentSystem, correctionBearing);
                if (correctedLanding && correctedLanding.systemId.toLowerCase() === targetSystemId.toLowerCase()) {
                  this.log("travel", `Pathfinder correction jump to bearing ${correctionBearing.toFixed(4)}°`);
                  recordPathfinderCorrection(this.username, (tick ?? 0) + 1, correctionBearing);
                  const correctionResp = await this.exec("jump", { target_system: correctionBearing });
                  if (correctionResp.error) {
                    this.log("error", `Correction jump failed: ${correctionResp.error.message}`);
                  } else {
                    this.log("travel", `Correction jump issued successfully`);
                    currentBearing = correctionBearing;
                    correctionIssued = true;
                    await new Promise(r => setTimeout(r, 1000));
                  }
                } else {
                  this.log("warn", `Correction bearing ${correctionBearing.toFixed(4)}° does not land at target — cannot correct`);
                }
              }
            }
          }
        }
      }
    }

    const existingRecord = getActivePathfinderTravel(this.username);
    if (existingRecord) {
      setPathfinderTravelState(this.username, {
        ...existingRecord,
        status: arrived ? "arrived" : "unknown",
      });
    }

    if (!arrived) {
      this.log("warn", "Pathfinder jump finished but arrival not confirmed via location polling");
    }

    return { success: arrived, arrivedTick: (await this.pollCurrentTick()) ?? undefined, landing: { systemId: landingSystemId, ticks: landingTicks } };
  }
getSkillLevel(skillId: string): number {
     const lowerId = skillId.toLowerCase();
     for (const [id, level] of this.skillLevels.entries()) {
       if (id.toLowerCase() === lowerId) return level;
     }
     return 0;
   }

   /** Fetch skills and log any level-ups since the last check. */
    async checkSkills(): Promise<void> {
      const resp = await this.refreshSkills();
      if (resp.error || !resp.result) return;
      
      const r = resp.result as Record<string, unknown>;
      // Handle various response formats: skills.skills, skills.data, or top-level
      let skillsData: Record<string, unknown> | null = null;
      if (r.skills && typeof r.skills === "object") {
        skillsData = r.skills as Record<string, unknown>;
      } else if (r.data && typeof r.data === "object") {
        skillsData = r.data as Record<string, unknown>;
      } else {
        skillsData = r;
      }
      
      for (const [skillId, skillVal] of Object.entries(skillsData)) {
        if (skillId === 'message' || skillId === 'status' || skillId === 'error') continue;
        if (skillVal && typeof skillVal === "object") {
          const s = skillVal as Record<string, unknown>;
          const level = (s.level as number) ?? (s.current_level as number) ?? 0;
          const prev = this.skillLevels.get(skillId);
          if (prev !== undefined && level > prev) {
            this.log("skill", `LEVEL UP! ${skillId}: ${prev} -> ${level}`);
          }
        }
      }
    }

     /** Fetch all skills as a Map (calls get_skills API). */
     private async fetchAllSkills(): Promise<Map<string, { level: number; xp: number; xpToNext?: number; totalXP?: number }>> {
       const map = new Map<string, { level: number; xp: number; xpToNext?: number; totalXP?: number }>();
       const resp = await this.libExec("get_skills");
       if (resp.error || !resp.result) return map;
       
       const r = resp.result as Record<string, unknown>;
       let skillsData: Record<string, unknown> | null = null;
       if (r.skills && typeof r.skills === "object") {
         skillsData = r.skills as Record<string, unknown>;
       } else if (r.data && typeof r.data === "object") {
         skillsData = r.data as Record<string, unknown>;
       } else {
         skillsData = r;
       }
       
       for (const [id, skillVal] of Object.entries(skillsData)) {
         if (id === 'message' || id === 'status' || id === 'error') continue;
         if (skillVal && typeof skillVal === "object") {
           const s = skillVal as Record<string, unknown>;
           const level = (s.level as number) ?? (s.current_level as number) ?? 0;
           const rawXP = (s.xp as number) ?? (s.experience as number) ?? (s.current_xp as number) ?? 0;
           const xp = typeof rawXP === "number" ? rawXP : 0;
           const xpToNext = (s.xp_to_next_level as number) ?? (s.xp_to_next as number) ?? (s.xp_needed as number) ?? (s.xp_remaining as number);
           const totalXP = (s.total_xp as number) ?? (s.total_experience as number) ?? (s.cumulative_xp as number);
           map.set(id, { level, xp, xpToNext, totalXP });
         }
       }
       return map;
     }

    /** Capture current skill levels & XP for before/after comparison. */
    captureSkillSnapshot(): void {
      this.skillSnapshot = new Map(
        Array.from(this.skillLevels.entries()).map(([id, level]) => [
          id,
          {
            level,
            xp: this.skillXP.get(id) ?? 0,
            totalXP: this.skillTotalXP.get(id) ?? undefined,
            xpToNext: this.skillXpToNext.get(id) ?? undefined
          }
        ])
      );
    }

/** Compare skills after a command and log any gains. */
     private async logSkillGains(command: string): Promise<void> {
       const fresh = await this.fetchAllSkills();
       if (fresh.size === 0) return;
       const gains: Array<{
         id: string;
         name: string;
         levelBefore: number;
         levelAfter: number;
         xpBefore: number;
         xpAfter: number;
         xpGained: number;
         xpToNext?: number;
         totalXPBefore?: number;
         totalXPAfter?: number;
       }> = [];
       for (const [id, data] of fresh.entries()) {
         const old = this.skillSnapshot.get(id);
         if (!old) continue;
         let xpGained: number;
         if (old.totalXP !== undefined && data.totalXP !== undefined) {
           xpGained = data.totalXP - old.totalXP;
         } else if (data.level > old.level) {
           const oldRemaining = (old.xpToNext !== undefined) ? (old.xpToNext - old.xp) : 0;
           xpGained = oldRemaining + data.xp;
         } else {
           xpGained = data.xp - old.xp;
         }
         const levelDelta = data.level - old.level;
         if (xpGained > 0 || levelDelta > 0) {
           gains.push({
             id,
             name: id,
             levelBefore: old.level,
             levelAfter: data.level,
             xpBefore: old.xp,
             xpAfter: data.xp,
             xpGained,
             xpToNext: data.xpToNext,
             totalXPBefore: old.totalXP,
             totalXPAfter: data.totalXP,
           });
         }
       }
       if (gains.length > 0) {
         const parts = gains.map(g => {
           if (g.levelAfter > g.levelBefore && g.xpGained > 0) return `+${g.xpGained} ${g.id} (lvl ${g.levelAfter - g.levelBefore})`;
           if (g.xpGained > 0) return `+${g.xpGained} ${g.id}`;
           return `+${g.levelAfter - g.levelBefore} ${g.id}`;
         }).join(", ");
         this.log("skills", `Skill gains: ${parts}`);
         recordSkillGains(this, command, this.shipName, gains);
         const pilotGain = gains.find(g => g.id.toLowerCase().includes('pilot'));
         if (pilotGain) {
           recordPilotingActivity(this, command, pilotGain.xpGained, pilotGain.levelAfter, pilotGain.xpAfter, this.shipName);
         }
       }
       this.skillLevels.clear();
       this.skillXP.clear();
       this.skillTotalXP.clear();
       this.skillXpToNext.clear();
       for (const [id, data] of fresh.entries()) {
         this.skillLevels.set(id, data.level);
         this.skillXP.set(id, data.xp);
         if (data.xpToNext !== undefined) this.skillXpToNext.set(id, data.xpToNext);
         if (data.totalXP !== undefined) this.skillTotalXP.set(id, data.totalXP);
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
    this.log("customs", `✅ CUSTOMS CLEARED: ${outcome} (2m cooldown)`);
  }

  /**
   * Check if bot is currently held by customs.
   */
  isCustomsHold(): boolean {
    if (!this.customsHold.active) return false;

    // Auto-timeout after 2 minutes (customs ship should have arrived by then)
    const elapsed = Date.now() - this.customsHold.since;
    if (elapsed > 120000) {
      this.log("customs", "⏰ CUSTOMS TIMEOUT: Proceeding after 2m wait");
      this.customsHold.active = false;
      this.customsHold.outcome = "cleared";
      return false;
    }

    return true;
  }

  /**
   * Check if we're currently in a battle based on global WebSocket state.
   * This works even when HTTP requests are hanging (524 timeouts).
   * @returns true if in battle, false otherwise
   */
  /**
   * Authoritatively clear our cached battle state. Called when the spacemolt-lib
   * push channel tells us the battle is over (battle_ended) or we have left it
   * (battle_left). This is the source of truth for "we are no longer in battle"
   * and must immediately override any stale cached flag, otherwise the bot keeps
   * believing it is in battle (from an old WebSocket update) and refuses to move.
   */
  clearBattleState(reason: string): void {
    if (this.currentBattle.inBattle || this.currentBattle.battleId) {
      debugLogForBot(this.username, "bot:battle", `${this.username} clearing battle state (${reason}). Was battle ${this.currentBattle.battleId}`);
    }
    this.currentBattle.inBattle = false;
    this.currentBattle.battleId = null;
    this.currentBattle.participants = [];
    this.currentBattle.lastUpdate = Date.now();
  }

  /**
   * Check if we're currently in battle based on the battle state maintained from
   * spacemolt-lib push events (battle_update / battle_damage set it; battle_ended
   * / battle_left clear it). The 120s staleness guard is a last-resort safety net
   * for the rare case where an end/left event is missed entirely — it must never
   * be the primary mechanism, or the bot gets stuck locked out of movement.
   */
   isInBattle(): boolean {
     if (!this.currentBattle.inBattle) return false;

     const timeSinceUpdate = Date.now() - this.currentBattle.lastUpdate;
     // Use 120 second timeout instead of 60 to be more lenient during HTTP errors
     if (timeSinceUpdate > 120000) {
       // Battle state is stale and no end/left event ever arrived - clear it
       this.clearBattleState("stale-timeout");
       return false;
     }

     return true;
   }

  /**
   * Return a snapshot of the library's observation cache. Call this instead of
   * reaching into `account.observationCache` directly so we don't break if the
   * library's internals change.
   */
  private libObservationState(): { subscribed: boolean; poiId: string; systemId: string; tick: number; nearby: Array<Record<string, unknown>>; systemAgents: Array<Record<string, unknown>>; unknownSignature: boolean; activeScan: boolean } {
    try {
      const acct = this.account as unknown as {
        observationSubscribedState?: boolean;
        subscribedObservationPoiId?: string;
        observationActiveScanState?: boolean;
        observationCache?: { current: () => { poi_id?: string; system_id?: string; tick?: number; nearby: Map<string, Record<string, unknown>>; system: Map<string, Record<string, unknown>>; unknownSignature: boolean; activeScan: boolean } | null };
      } | null;
      if (!acct) return { subscribed: false, poiId: "", systemId: "", tick: 0, nearby: [], systemAgents: [], unknownSignature: false, activeScan: false };
      const subscribed = !!acct.observationSubscribedState;
      const view = acct.observationCache?.current?.();
      const poiId = view?.poi_id ?? acct.subscribedObservationPoiId ?? "";
      const systemId = view?.system_id ?? "";
      return {
        subscribed,
        poiId,
        systemId,
        tick: view?.tick ?? 0,
        nearby: view ? Array.from(view.nearby.values()) : [],
        systemAgents: view ? Array.from(view.system.values()) : [],
        unknownSignature: view?.unknownSignature ?? false,
        activeScan: view?.activeScan ?? !!acct.observationActiveScanState,
      };
    } catch {
      return { subscribed: false, poiId: "", systemId: "", tick: 0, nearby: [], systemAgents: [], unknownSignature: false, activeScan: false };
     }
  }

  /**
   * Subscribe to live observation updates (replaces polling get_nearby).
   * Anchors a watch at the current POI/system and returns the initial snapshot.
   * Subsequent updates arrive via observation_update push events.
   */
async subscribeToObservation(activeScan: boolean = false): Promise<ApiResponse> {
     console.error(`[${this.username}] >>> subscribeToObservation called activeScan=${activeScan}`);
     const libObs = this.libObservationState();
    if (libObs.subscribed && !activeScan) {
      console.error(`[${this.username}] >>> subscribeToObservation(library already active=true, porting cache)`);
      this.observationSession = { id: "active", poi_id: libObs.poiId, system_id: libObs.systemId };
      this.observationTick = libObs.tick;
      this.observationUnknownSignature = libObs.unknownSignature;
      this.observationActiveScan = libObs.activeScan;
      this.observationNearby = libObs.nearby;
      this.observationSystemAgents = libObs.systemAgents;
      this.log("observation", `Library observation already active (poi=${libObs.poiId} nearby=${libObs.nearby.length}) — ported cache`);
      return { result: { poi_id: libObs.poiId, system_id: libObs.systemId, nearby: libObs.nearby, system_agents: libObs.systemAgents, active_scan: libObs.activeScan, unknown_signature: libObs.unknownSignature }, error: undefined, notifications: [] };
    }
    if (libObs.subscribed && activeScan) {
      console.error(`[${this.username}] >>> subscribeToObservation(library active=true, switching to activeScan)`);
      await this.libExec("subscribe_observation", { active_scan: true });
      const updated = this.libObservationState();
      this.observationSession = { id: "active", poi_id: updated.poiId, system_id: updated.systemId };
      this.observationTick = updated.tick;
      this.observationUnknownSignature = updated.unknownSignature;
      this.observationActiveScan = true;
      this.observationNearby = updated.nearby;
      this.observationSystemAgents = updated.systemAgents;
      this.log("observation", `Observation active scan enabled (poi=${updated.poiId} nearby=${updated.nearby.length})`);
      return { result: { poi_id: updated.poiId, system_id: updated.systemId, nearby: updated.nearby, system_agents: updated.systemAgents, active_scan: true, unknown_signature: updated.unknownSignature }, error: undefined, notifications: [] };
    }
this.log("observation", `[${this.username}] >>> subscribeToObservation(activeScan=${activeScan}) calling libExec`);
    const resp = await this.libExec("subscribe_observation", { active_scan: activeScan });
    this.log("observation", `[${this.username}] >>> subscribe_observation response: error=${resp.error ? resp.error.message : "none"}, result_type=${resp.result ? typeof resp.result : "undefined"}`);
    if (resp.error) {
      this.log("error", `subscribe_observation failed: ${resp.error.message}`);
      return resp;
    }

const sc = resp.result as Record<string, unknown>;
    this.log("observation", `[${this.username}] >>> subscribe_observation full response: ${JSON.stringify(sc)}`);
    const fresh = this.libObservationState();

    // Determine nearby and systemAgents from response; if missing, use empty arrays
    let nearby: Array<Record<string, unknown>> = Array.isArray(sc.nearby) ? sc.nearby as Array<Record<string, unknown>> : [];
    let systemAgents: Array<Record<string, unknown>> = Array.isArray(sc.system_agents) ? sc.system_agents as Array<Record<string, unknown>> : [];

    // Update observation state
    this.observationSession = {
      id: "active",
      poi_id: (sc.poi_id as string) || fresh.poiId,
      system_id: (sc.system_id as string) || fresh.systemId,
    };
    this.observationNearby = nearby;
    this.observationSystemAgents = systemAgents;
    this.observationUnknownSignature = !!sc.unknown_signature || fresh.unknownSignature;
    this.observationActiveScan = !!sc.active_scan || fresh.activeScan;
    this.observationTick = typeof sc.tick === 'number' ? sc.tick : fresh.tick;

    this.log("debug", `Subscribed to observation (poi=${this.observationSession.poi_id} system=${this.observationSession.system_id} nearby=${this.observationNearby.length} agents=${this.observationSystemAgents.length})`);
    this.log("observation", `Subscribed to observation (poi=${this.observationSession.poi_id} system=${this.observationSession.system_id} nearby=${this.observationNearby.length})`);

    // Return the original response
    return resp;
  }

  /**
   * Clear the cached observation state. Call after travel/jump since the
   * watch ends automatically when you move.
   */
  clearObservationState(): void {
    this.observationSession = null;
    this.observationNearby = [];
    this.observationSystemAgents = [];
    this.observationUnknownSignature = false;
    this.observationActiveScan = false;
    this.observationTick = 0;
    try {
      const libObs = this.account as unknown as {
        observationCache?: { clear: () => void };
        observationSubscribedState?: boolean;
      };
      if (libObs?.observationCache?.clear) {
        libObs.observationCache.clear();
      }
    } catch {}
  }

  /**
   * Return a synthetic get_nearby-shaped result built from the live
   * observation cache, so existing parseNearby() logic keeps working.
   */
getObservationResult(): Record<string, unknown> {
const allNearby = [...this.observationNearby, ...this.observationSystemAgents];
    const pirates: Record<string, unknown>[] = [];
    const creatures: Record<string, unknown>[] = [];
    const empireNpcs: Record<string, unknown>[] = [];
    const players: Record<string, unknown>[] = [];
    
    for (const entity of allNearby) {
      // Check if it's a pirate first
      if (isPirateTarget(entity as any, true, "boss")) {
        pirates.push(entity);
      } 
      // Then check if it's a creature
      else if (isCreatureTarget(entity as any, true)) {
        creatures.push(entity);
      } 
      // Then check if it's an empire NPC based on name patterns
      else {
        const name = (entity as any).name || (entity as any).username || '';
        const nameLower = name.toLowerCase();
        const isEmpireNpc = 
          nameLower.startsWith("[customs]") ||
          nameLower.startsWith("[police]") ||
          nameLower.startsWith("confederacy customs") ||
          nameLower.includes("customs i -") ||
          nameLower.includes("customs ii -") ||
          nameLower.includes("customs iii -") ||
          nameLower.includes("confederacy customs i -") ||
          nameLower.includes("confederacy customs ii -") ||
          nameLower.includes("pact border") ||
          nameLower.includes("pact enforcer") ||
          nameLower.includes("rim ranger");
        
        if (isEmpireNpc) {
          empireNpcs.push(entity);
        } else {
          players.push(entity);
        }
      }
    }
     
return {
      nearby: allNearby,
      system_agents: this.observationSystemAgents,
      players: players,
      objects: this.observationNearby,
      nearby_players: this.observationNearby,
      ships: [],
      pirates: pirates,
      creatures: creatures,
      empire_npcs: empireNpcs,
      unknown_signature: this.observationUnknownSignature,
    };
   }

  /**
   * Process an observation_update push event from the server and update
   * the cached nearby / system_agent lists.
   */
  private handleObservationUpdate(data: Record<string, unknown>): void {
    debugLogForBot(this.username, "bot:observation", `${this.username} >>> handleObservationUpdate received`);
    
    const poiId = (data.poi_id as string) || this.observationSession?.poi_id || "";
    const systemId = (data.system_id as string) || this.observationSession?.system_id || "";
    const tick = (data.tick as number) || 0;
    const unknownSig = (data.unknown_signature as boolean) ?? this.observationUnknownSignature;

    debugLogForBot(this.username, "bot:observation", `${this.username} observation_update tick:${tick} poi:${poiId} system:${systemId}`);

    if (!this.observationSession) {
      this.observationSession = { id: "", poi_id: poiId, system_id: systemId };
    } else {
      this.observationSession.poi_id = poiId;
      this.observationSession.system_id = systemId;
    }
    this.observationTick = tick;
    this.observationUnknownSignature = unknownSig;

const nearbyPlayerMap = new Map<string, Record<string, unknown>>();
     const systemNpcMap = new Map<string, Record<string, unknown>>();
     for (const e of this.observationNearby) {
       const key = (e.username as string) || (e.player_id as string) || "";
       if (key) nearbyPlayerMap.set(key, e);
     }
     for (const e of this.observationSystemAgents) {
       const key = (e.username as string) || (e.player_id as string) || "";
       if (key) systemNpcMap.set(key, e);
     }

     const departures: string[] = [];
     if (Array.isArray(data.nearby_departed)) {
       for (const pid of data.nearby_departed as string[]) {
         nearbyPlayerMap.delete(pid);
         departures.push(pid);
       }
     }
     if (Array.isArray(data.system_departed)) {
       for (const pid of data.system_departed as string[]) {
         systemNpcMap.delete(pid);
         departures.push(pid);
       }
     }
     if (departures.length > 0) {
       debugLogForBot(this.username, "bot:observation", `${this.username} observation departed: ${departures.join(", ")}`);
       this.log("observation", `Departed: ${departures.join(", ")}`);
     }

     if (Array.isArray(data.nearby_changed)) {
       for (const e of data.nearby_changed as Array<Record<string, unknown>>) {
         const key = (e.username as string) || (e.player_id as string) || "";
         if (key) nearbyPlayerMap.set(key, e);
       }
     }
     if (Array.isArray(data.system_changed)) {
       for (const e of data.system_changed as Array<Record<string, unknown>>) {
         const key = (e.username as string) || (e.player_id as string) || "";
         if (key) systemNpcMap.set(key, e);
       }
     }

     this.observationNearby = Array.from(nearbyPlayerMap.values());
     this.observationSystemAgents = Array.from(systemNpcMap.values());

    const cloakedResolved = Array.isArray(data.cloaked_resolved) ? (data.cloaked_resolved as Array<Record<string, unknown>>).length : 0;
    const cloakedLost = Array.isArray(data.cloaked_lost) ? (data.cloaked_lost as string[]).length : 0;
    if (cloakedResolved > 0 || cloakedLost > 0) {
      debugLogForBot(this.username, "bot:observation", `${this.username} observation cloaked: +${cloakedResolved} resolved, -${cloakedLost} lost`);
      this.log("observation", `Cloaked: +${cloakedResolved} resolved, -${cloakedLost} lost`);
    }

    debugLogForBot(this.username, "bot:observation", `${this.username} observation snapshot: nearby=${this.observationNearby.length} system_agents=${this.observationSystemAgents.length} unknown=${this.observationUnknownSignature}`);
    this.log("observation", `[tick ${tick}] nearby=${this.observationNearby.length} system_agents=${this.observationSystemAgents.length} unknown=${this.observationUnknownSignature}`);
  }

  /**
   * Wait for customs hold to clear (blocks until cleared or timeout).
   */
  async waitForCustomsClear(maxWaitMs: number = 120000): Promise<"cleared" | "contraband" | "evasion" | "timeout"> {
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
      this.log("customs", "⏰ Customs scan timeout - proceeding after 2m");
      return "timeout";
    }

    const outcome = this.customsHold.outcome;
    if (outcome === "pending") return "cleared";
    return outcome || "cleared";
  }

  /**
   * Route notifications to the bot's own activity log and detect hull damage.
   * Uses this.libExec() directly (not this.exec()) to avoid recursion.
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

      if (isCombatDebugEnabled()) {
        const battleTypes = new Set([
          "battle_update", "battle_started", "battle_ended", "battle_damage",
          "battle_alert", "battle_joined", "battle_left"
        ]);
        const sourceKey = type ?? msgType ?? "unknown";
        if (battleTypes.has(type || "") || battleTypes.has(msgType || "")) {
          combatDebugLog(this.username, `push:${sourceKey}`, notif);
        }
      }

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

           // Deduplicate chat messages: ignore if same sender, channel, content within 10 seconds
           const now = Date.now();
           if (sender === this.lastChatSender && channel === this.lastChatChannel && content === this.lastChatMessage && now - this.lastChatMessageTime < 10000) {
             this.log("chat_debug", "Skipping duplicate chat message");
             continue;
           }
           this.lastChatSender = sender;
           this.lastChatChannel = channel;
           this.lastChatMessage = content;
           this.lastChatMessageTime = now;

            this.log("chat", `Received [${channel}] ${sender}: ${content}`);

            chatBuffer.addMessage({
              botUsername: this.username,
              channel,
              sender,
              content,
              timestamp: Date.now(),
              direction: "in",
              ...(channel === "private" && data.target_id ? { targetId: data.target_id as string } : {}),
            });

           // Track player name from chat (but NOT from MAYDAY messages - those can be fake/pirate names)
           // Also skip empire NPCs like customs agents and police
          if (sender && sender !== "Unknown" && sender !== this.username) {
            const contentLower = content.toLowerCase();
            const senderLower = sender.toLowerCase();
            
            // Check if sender is an empire NPC (customs, police, etc.)
            const isEmpireNpc = 
              senderLower.startsWith("[customs]") ||
              senderLower.startsWith("[police]") ||
              senderLower.startsWith("confederacy customs") ||
              senderLower.includes("customs i -") ||
              senderLower.includes("customs ii -") ||
              senderLower.includes("customs iii -") ||
              senderLower.includes("confederacy customs i -") ||
              senderLower.includes("confederacy customs ii -") ||
              senderLower.includes("pact border") ||
              senderLower.includes("pact enforcer") ||
              senderLower.includes("federation patrol") ||
              senderLower.includes("rim ranger");
            
            if (!contentLower.includes("mayday") && !isEmpireNpc) {
              playerNameStore.add(sender, "", "", "", this.system, this.poi);
            } else if (isEmpireNpc) {
              debugLogForBot(this.username, "playernames:skip", `${this.username}`, `Ignored empire NPC sender: "${sender}"`);
            } else {
              debugLogForBot(this.username, "playernames:skip", `${this.username}`, `Ignored MAYDAY sender: "${sender}"`);
            }
          }

          // Check for MAYDAY emergency rescue requests
          if (channel === "emergency" || content.includes("MAYDAY")) {
            const mayday = parseMaydayMessage(content, sender, Date.now(), this.username, this.system, this.poi);
            if (mayday) {
              if (isIgnoredMaydaySender(mayday.sender)) {
                // Settings → FuelRescue → "Ignore MAYDAYs from Wexler pilots".
                // addMaydayRequest() also rejects these, so the call is skipped
                // entirely here and only reported (throttled to one line per
                // sender per minute) — the flood is precisely why it is filtered.
                const { log: shouldLog, suppressed } = shouldLogIgnoredMayday(mayday.sender);
                if (shouldLog) {
                  const extra = suppressed > 0 ? ` (+${suppressed} more suppressed)` : "";
                  this.log("mayday", `🚫 Ignoring MAYDAY from ${mayday.sender} — sender ignored by the FuelRescue Wexler filter${extra}`);
                }
              } else {
                const added = addMaydayRequest(mayday);
                if (added) {
                  this.log("mayday", `🚨 MAYDAY received from ${mayday.sender} at ${mayday.system}/${mayday.poi} (${mayday.fuelPct}% fuel)`);
                }
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

            if (isFromCustoms && !isCustomsDisabled()) {
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
                  logCustomsStop(this.username, this.system, "pending");

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
                  logCustomsStop(this.username, this.system, "cleared");
                  // No AI response for clearance - just log and continue
                } else if (customsDetection.type === "contraband") {
                  // Clear hold - contraband found, penalty process complete
                  this.clearCustomsHold("contraband");
                  this.log("customs", "⚠️ Contraband detected - penalty process complete");
                  logCustomsStop(this.username, this.system, "contraband");
                  // No AI response for contraband - just log and continue
                } else if (customsDetection.type === "evasion_warning") {
                  // Clear hold - evasion noted, process complete
                  this.clearCustomsHold("evasion");
                  this.log("customs", "⚠️ Evasion warning - process complete");
                  logCustomsStop(this.username, this.system, "evasion");
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
          
          // Note: Rescue cooperation is now handled via Bot Chat Channel (in rescue.ts)
          // Private message processing for cooperation claims has been replaced
        } else {
          this.log("debug", `Chat message received but data is not object: ${typeof data}`);
        }
        continue;
      }

      let data = notif.data as Record<string, unknown> | string | undefined;
      if (typeof data === "string") {
        try { data = JSON.parse(data) as Record<string, unknown>; } catch { /* leave as string */ }
      }

      // ── BATTLE STATE TRACKING: Update global battle state from WebSocket notifications ──
      // This allows battle detection even when HTTP requests are hanging (524 timeouts)
      if (msgType === "battle_started" && data && typeof data === "object") {
        // Authoritative lib signal that a battle we're in has begun. Set the flag
        // immediately (battle_update may not have arrived yet).
        const battleId = (data.battle_id as string) || "";
        if (battleId) {
          this.currentBattle.inBattle = true;
          this.currentBattle.battleId = battleId;
          this.currentBattle.lastUpdate = Date.now();
          this.currentBattle.participants = Array.isArray(data.participants)
            ? (data.participants as Array<Record<string, unknown>>)
            : this.currentBattle.participants;
          debugLogForBot(this.username, "bot:battle", `${this.username} battle_started: ${battleId}`);
        }
       } else if (msgType === "battle_update" && data && typeof data === "object") {
        const battleId = (data.battle_id as string) || "";
        const tick = (data.tick as number) || 0;
        const participants = Array.isArray(data.participants) ? data.participants : [];
        
        if (battleId) {
          // We're in battle - update global state
          this.currentBattle.inBattle = true;
          this.currentBattle.battleId = battleId;
          this.currentBattle.lastUpdate = Date.now();
          this.currentBattle.participants = participants as Array<Record<string, unknown>>;

          debugLogForBot(this.username, "bot:battle", `${this.username} battle_update: ${battleId} tick:${tick} participants:${participants.length}`);
        }
       } else if (msgType === "battle_ended" && data && typeof data === "object") {
        // Authoritative lib signal: the battle is over for everyone. Clear our
        // battle flag immediately so isInBattle() stops reporting a stale
        // "still in battle" long after the fight actually ended.
        const endedBattleId = (data.battle_id as string) || this.currentBattle.battleId || "";
        if (!this.currentBattle.battleId || this.currentBattle.battleId === endedBattleId) {
          this.clearBattleState(`battle_ended (${endedBattleId})`);
        }
       } else if (msgType === "battle_left" && data && typeof data === "object") {
        // Authoritative lib signal: a participant left the battle. If WE left,
        // clear our battle flag. We match on player_id/username since a side can
        // still be fighting after we disengage.
        const leftId = (data.player_id as string) || "";
        const leftName = (data.username as string) || "";
        const isUs = leftName === this.username ||
          (!leftId && !leftName); // Civilian/bot self-leave notifications omit ids
        if (isUs) {
          this.clearBattleState(`battle_left (${leftName || leftId || "us"})`);
        }
       } else if (msgType === "battle_damage" && data && typeof data === "object") {
         // Battle damage also indicates we're in battle
         const attackerName = (data.attacker_name as string) || "";
         const targetName = (data.target_name as string) || "";
         const totalDamage = (data.total_damage as number) || 0;

         // CRITICAL: Set battle state on damage too (battle_update might not arrive first)
         const battleId = (data.battle_id as string) || this.currentBattle.battleId || "";
         if (battleId || attackerName) {
           this.currentBattle.inBattle = true;
           if (battleId) {
             this.currentBattle.battleId = battleId;
           }
this.currentBattle.lastUpdate = Date.now();
          }

          debugLogForBot(this.username, "bot:battle", `${this.username} battle_damage: ${attackerName} -> ${targetName} (${totalDamage} dmg)`);

          // Check if we should send a battle response to AI chat
          const now = Date.now();
          if (now - this.lastBattleResponseMs > Bot.BATTLE_RESPONSE_COOLDOWN_MS) {
            // Only respond if we're taking damage (target is us) or just entered battle
            if ((totalDamage > 0 && targetName === this.username) || !this.currentBattle.inBattle) {
              this.lastBattleResponseMs = now;
              await this.sendBattleResponseToAI(attackerName, totalDamage);
}
          }
        } else if (msgType === "battle_alert" && data && typeof data === "object") {
         const alertData = data as Record<string, unknown>;
         const battleId = (alertData.battle_id as string) || "";
         const systemId = (alertData.system_id as string) || "";
         const participants = Array.isArray(alertData.participants)
           ? (alertData.participants as Array<Record<string, unknown>>)
           : [];
         const sides = Array.isArray(alertData.sides)
           ? (alertData.sides as Array<Record<string, unknown>>)
           : [];
         const message = (alertData.message as string) || "";

         if (battleId) {
           const isAtBattleSystem = systemId && systemId === this.system;
           const isDockedAtStation = this.docked;

           if ((isAtBattleSystem || systemId === "") && isDockedAtStation) {
             this.currentBattle.inBattle = true;
             this.currentBattle.battleId = battleId;
             this.currentBattle.lastUpdate = Date.now();
             this.currentBattle.participants = participants;

             debugLogForBot(this.username, "bot:battle", `${this.username} battle_alert: ${battleId} at station (${message})`);
           }
         }
        } else if (msgType === "observation_update" && data && typeof data === "object") {
         this.handleObservationUpdate(data as Record<string, unknown>);
        } else if ((msgType === "crafting_update" || type === "crafting_update") && data && typeof data === "object") {
          const d = data as Record<string, unknown>;
          const jobs = (d.jobs as Array<Record<string, unknown>>) || [];

          for (const job of jobs) {
            const jobId = (job.job_id as string) || "";
            const recipeId = (job.recipe_id as string) || (job.recipe as string) || "";
            const deposited = (job.deposited as Array<Record<string, unknown>>) || [];
            const completed = (job.completed as boolean) ?? false;

if (this.craftQueueTracker && jobId && recipeId) {
               if (completed) {
                 this.craftQueueTracker.markCompleted(jobId);
                 this.craftQueueTracker.save();
                } else if (deposited.length > 0) {
                  const runsRemaining = (job.runs_remaining as number) || 0;
                  const tracked = this.craftQueueTracker.getJob(jobId);
                  // job.quantity is stored in RUNS, but the deposited payload
                  // carries OUTPUT ITEM quantities (e.g. 200 fuel_reserve per
                  // run). Adding those to `completed` corrupts the run-based
                  // progress and produces phantom "pending". Derive the completed
                  // RUN count from the server's authoritative runs_remaining.
                  const completedRuns = tracked ? Math.max(0, tracked.quantity - runsRemaining) : 0;
                  const delta = tracked ? Math.max(0, completedRuns - tracked.completed) : 0;
                  this.craftQueueTracker.updateDeposited(jobId, delta, runsRemaining);
                  this.craftQueueTracker.save();
                }
             }

            if (recipeId && deposited.length > 0) {
              const totalQuantity = deposited.reduce((sum, item) => sum + ((item.quantity as number) || 0), 0);
              const outputName = deposited[0]?.name as string || deposited[0]?.item_id as string || recipeId;
              if (completed) {
                this.log("craft", `Crafting completed: ${totalQuantity}x ${outputName}`);
                this.clearCraftingJobByRecipe(recipeId);
              } else {
                const runsRemaining = (job.runs_remaining as number) || 0;
                this.log("craft", `Crafting progress: ${totalQuantity}x ${outputName} - ${runsRemaining} runs remaining`);
              }
            }
          }
        }

        // Handle system messages
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
            playerNameStore.add(pirateName, pirateT, "", "", this.system, this.poi);
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
      }

      if (type === "combat" && data && typeof data === "object") {
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
      const nearbyResp = await this.libExec("get_nearby");
      
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

      await this.libExec("chat", { channel: "faction", content });
      this.log("combat", `Faction alert sent: ${pirateName} at ${this.system}`);
    } catch (err) {
      this.log("error", `Combat alert failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

   /** Post a faction chat warning about an imminent attack or pirate detection. */
   private async sendWarningFactionAlert(message: string): Promise<void> {
     try {
       const content = `[COMBAT WARNING] ${this.username} — ${message} | ${this.system}/${this.poi}`;
       await this.libExec("chat", { channel: "faction", content });
       this.log("combat", `Faction warning sent`);
     } catch (err) {
       this.log("error", `Warning alert failed: ${err instanceof Error ? err.message : String(err)}`);
     }
   }

/** Fetch piloting skill info (level and XP) from cached skills in get_status. */
    async getPilotingSkill(): Promise<{ level: number; xp: number } | null> {
      let result: { level: number; xp: number } | null = null;
      for (const [id, level] of this.skillLevels.entries()) {
        if (id.toLowerCase().includes('pilot')) {
          result = { level, xp: this.skillXP.get(id) ?? 0 };
          break;
        }
      }
      return result;
    }

   /**
    * Send a witty battle response to the AI chat service when attacked.
    * This gets the attacker info and sends a personality-appropriate response.
    */
   private async sendBattleResponseToAI(attackerName: string, damageTaken: number): Promise<void> {
     try {
       // Get AI Chat service from global scope
       const aiChatService = (globalThis as any).aiChatService;
       if (!aiChatService || typeof aiChatService.addChatMessage !== "function") {
         this.log("ai_chat_debug", "AI Chat service not available for battle response");
         return;
       }

       // Get nearby entities to provide context
       const nearbyResp = await this.libExec("get_nearby");
       let nearbyInfo = "";
       if (nearbyResp.result && typeof nearbyResp.result === "object") {
         const nearby = nearbyResp.result as Record<string, unknown>;
         const players = Array.isArray(nearby.players) ? nearby.players : [];
         const npcs = Array.isArray(nearby.npcs) ? nearby.npcs : [];
         const stations = Array.isArray(nearby.stations) ? nearby.stations : [];
         
         if (players.length > 0) {
           nearbyInfo += ` | Players nearby: ${players.map(p => (p as any).name || (p as any).username || "Unknown").join(", ")}`;
         }
         if (npcs.length > 0) {
           nearbyInfo += ` | NPCs nearby: ${npcs.map(n => (n as any).name || "Unknown").join(", ")}`;
         }
         if (stations.length > 0) {
           nearbyInfo += ` | Stations nearby: ${stations.map(s => (s as any).name || "Unknown").join(", ")}`;
         }
       }

        // Get battle status for more details
        const battleStatusResp = await this.libExec("get_battle_status");
        let battleInfo = "";
        let isAttackerFriendly = false;
        let ourSideId: number | undefined;
        if (battleStatusResp.result && typeof battleStatusResp.result === "object") {
          const battle = battleStatusResp.result as Record<string, unknown>;
          const participants = Array.isArray(battle.participants) ? battle.participants : [];
          
          // Find our side and enemy side
          // Explicitly check and cast your_side_id to number
          const yourSideIdRaw = battle.your_side_id;
          if (typeof yourSideIdRaw === "number") {
            ourSideId = yourSideIdRaw;
            const ourZone = battle.your_zone;
            const ourStance = battle.your_stance;
            
            // Find our participant data
            const ourParticipant = participants.find((p: any) => p.side_id === ourSideId);
            
            // Get ship info for context
            const shipResp = await this.libExec("get_ship");
            let shipInfo = "";
            if (shipResp.result && typeof shipResp.result === "object") {
              const ship = shipResp.result as Record<string, unknown>;
              const shipName = (ship as any).name || "Unknown Ship";
              const shipClass = (ship as any).class || "Unknown Class";
              shipInfo = `I'm flying a ${shipClass} named ${shipName}`;
            }
            
            // Determine if we're winning or losing based on hull/shield from our participant data
            const ourHullPct = ourParticipant?.hull_pct || ourParticipant?.hull_percent || 100;
            const ourShieldPct = ourParticipant?.shield_pct || ourParticipant?.shield_percent || 100;
            
            let statusComment = "";
            if (ourHullPct <= 30) {
              statusComment = "I'm taking heavy damage!";
            } else if (ourHullPct <= 60) {
              statusComment = "I've got some hull damage but I'm still fighting!";
            } else if (ourShieldPct <= 30) {
              statusComment = "My shields are down but hull is holding!";
            } else {
              statusComment = "I'm holding my own in this fight!";
            }
            
            // Get enemy zone info if available
            const enemyZone = battle.enemy_zone || 'unknown';
            
            battleInfo = ` | Battle status: ${shipInfo}. ${statusComment} Enemy zone: ${enemyZone}, Our zone: ${ourZone || 'unknown'}`;
          }
          // If we don't have a valid side ID, we skip battle details (can't determine friend/foe)
        }

        // Create a message that mentions the attacker (if we have their name)
        let messageContent = "";
        if (attackerName && attackerName !== "Unknown" && attackerName !== "") {
          // Check if attacker is actually on our side (to avoid friendly fire mentions)
          let isAttackerFriendly = false;
          if (this.currentBattle.participants && this.currentBattle.participants.length > 0 && ourSideId !== undefined) {
            isAttackerFriendly = this.currentBattle.participants.some(
              p => (p as any).username === attackerName && (p as any).side_id === ourSideId
            );
          }
          
          if (!isAttackerFriendly) {
            messageContent = `${attackerName} just hit me for ${damageTaken} damage! `;
          } else {
            messageContent = "Whoa! Friendly fire! ";
          }
        } else {
          messageContent = "I'm under attack! ";
        }

       // Add personality-appropriate witty response based on damage and situation
       const wittyResponses = [
         "That tickles! Is that the best you've got?",
         "Ow! My mom could hit harder than that!",
         "Is your weapon broken or are you just bad at this?",
         "You fight like a drunk federation cadet!",
         "My shields absorbed that like a sponge!",
         "Did you forget to load your weapons?",
         "Is that a peace offering or an attack?",
         "You shoot like my grandma playing laser tag!",
         "I've seen stronger hits from a peashooter!",
         "Is that all? I barely felt that!",
         "My grandfather's toupee has more firepower!",
         "You couldn't hit the broadside of a barn!",
         "Is that supposed to hurt? Adorable.",
         "My pet rock could do better than that!",
         "Are you trying to scratch my paint?",
         "That barely registered on my damage sensors!",
         "Is that a nerf gun or a real weapon?",
         "You fight like you're afraid of winning!",
         "Is that your attack or did you sneeze on my shields?"
       ];
       
       // Select a random witty response
       const randomIndex = Math.floor(Math.random() * wittyResponses.length);
       const wittyResponse = wittyResponses[randomIndex];
       
       // If we took significant damage, use a different tone
       if (damageTaken >= 50) {
         const seriousResponses = [
           "Okay, that actually hurt. Who are you working for?",
           "Not bad! You've got my attention now.",
           "Alright, you wanna dance? Let's go!",
           "That sting means you're worth fighting!",
           "Okay, okay... you've made this interesting.",
           "Now we're talking! Let's see what you've really got!",
           "You've got guts, I'll give you that.",
           "That's more like it! Now we're getting somewhere.",
           "Alright, you've earned my respect. Let's finish this.",
           "Okay, you're not completely useless after all."
         ];
         const seriousIndex = Math.floor(Math.random() * seriousResponses.length);
         messageContent += seriousResponses[seriousIndex];
       } else {
         messageContent += wittyResponse;
       }
       
       // Add battle context if available
       if (battleInfo) {
         messageContent += battleInfo;
       }
       
       // Add nearby info if available
       if (nearbyInfo) {
         messageContent += nearbyInfo;
       }
       
       // Send the message to AI chat service as a local chat message
       // This will allow any bot to respond based on their personality
       aiChatService.addChatMessage({
         sender: "System", // Mark as system message so bots know it's a battle alert
         channel: "local",
         content: messageContent,
         timestamp: Date.now(),
         botUsername: this.username,
         botSystem: this.system,
         botPoi: this.poi
       });
       
       this.log("ai_chat", `Sent battle response to AI chat: ${messageContent.substring(0, 100)}...`);
     } catch (err) {
       this.log("error", `Failed to send battle response to AI chat: ${err instanceof Error ? err.message : String(err)}`);
     }
   }

   /**
    * Extract and track player names, pirates, and empire NPCs from a get_nearby response.
    */
  trackNearbyPlayers(nearbyResult: unknown): void {
    if (!nearbyResult || typeof nearbyResult !== "object") {
      this.log("debug", "trackNearbyPlayers: no result or not object");
      return;
    }

    const data = nearbyResult as Record<string, unknown>;

    // Debug: log what keys we have
    debugLogForBot(this.username, "playernames:track", `${this.username}`, `get_nearby result keys: ${Object.keys(data).join(", ")}`);

    // First, collect all empire NPC names to exclude them from player tracking
    const empireNpcNames = new Set<string>();
    const empireNpcsArray = Array.isArray(data.empire_npcs) ? data.empire_npcs : [];
    for (const npc of empireNpcsArray as Array<Record<string, unknown>>) {
      const name = npc.name as string;
      if (name && name.trim()) {
        empireNpcNames.add(name.trim());
      }
    }

    // Track actual players (exclude pirates and empire_npcs)
    const playerArraysToCheck = [
      Array.isArray(data.objects) ? data.objects : [],
      Array.isArray(data.nearby) ? data.nearby : [],
      Array.isArray(data.ships) ? data.ships : [],
      Array.isArray(data.players) ? data.players : [],
      Array.isArray(data.nearby_players) ? data.nearby_players : [],
    ];

    let playerCount = 0;
    let totalPlayersFound = 0;
    for (const arr of playerArraysToCheck) {
      totalPlayersFound += arr.length;
      for (const entity of arr as Array<Record<string, unknown>>) {
        // Try various field names for player/ship names
        const name = (entity.username as string) ||
                     (entity.name as string) ||
                     (entity.player_name as string);

        if (name && name.trim()) {
          const trimmedName = name.trim();
          // Skip if this is an empire NPC (even if it appeared in player arrays)
          if (empireNpcNames.has(trimmedName)) {
            continue;
          }
          // Extract faction info - try faction_tag first (from nearby array), then faction/faction_id
          let faction = "";
          if (typeof entity.faction_tag === "string" && entity.faction_tag) {
            faction = entity.faction_tag;
          } else if (typeof entity.faction === "string" && entity.faction) {
            faction = entity.faction;
          } else if (typeof entity.faction_id === "string" && entity.faction_id) {
            faction = entity.faction_id;
          }
          // Extract ship info - try ship_class first (ship type), then ship/ship_type/ship_name
          let ship = "";
          if (typeof entity.ship_class === "string" && entity.ship_class) {
            ship = entity.ship_class;
          } else if (typeof entity.ship === "string" && entity.ship) {
            ship = entity.ship;
          } else if (typeof entity.ship_type === "string" && entity.ship_type) {
            ship = entity.ship_type;
          }
          // Extract ship_name separately (personalized ship name)
          const shipName = (entity.ship_name as string) || "";
          // Log status message if available
          if (typeof entity.status_message === "string" && entity.status_message) {
            debugLogForBot(this.username, "playernames:status", `${this.username}`, 
              `Player ${trimmedName}: ${entity.status_message}`);
          }
          const playerId = (entity.player_id as string) || "";
          if (playerNameStore.add(trimmedName, faction, ship, shipName, this.system, this.poi, playerId)) {
            playerCount++;
          }
        }
      }
    }

    // Track pirates separately
    let pirateCount = 0;
    const piratesArray = Array.isArray(data.pirates) ? data.pirates : [];
    for (const pirate of piratesArray as Array<Record<string, unknown>>) {
      const name = pirate.name as string;
      if (name && name.trim()) {
        const faction = (pirate.faction as string) || "";
        const ship = (pirate.ship_class as string) || (pirate.ship_type as string) || (pirate.ship as string) || "";
        const shipName = (pirate.ship_name as string) || "";
        const pirateId = (pirate.pirate_id as string) || (pirate.id as string) || "";
        if (playerNameStore.addPirate(name, faction, ship, shipName, this.system, this.poi, pirateId)) {
          pirateCount++;
        }
      }
    }

    // Track empire NPCs separately
    let empireNpcCount = 0;
    for (const npc of empireNpcsArray as Array<Record<string, unknown>>) {
      const name = npc.name as string;
      if (name && name.trim()) {
        const faction = (npc.faction as string) || "";
        const ship = (npc.ship_class as string) || (npc.ship_type as string) || (npc.ship as string) || "";
        const shipName = (npc.ship_name as string) || "";
        const npcId = (npc.npc_id as string) || "";
        if (playerNameStore.addEmpireNpc(name, faction, ship, shipName, this.system, this.poi, npcId)) {
          empireNpcCount++;
        }
      }
    }

    const totalFound = totalPlayersFound + piratesArray.length + empireNpcsArray.length;
    debugLogForBot(this.username, "playernames:track", `${this.username}`, `Found ${totalFound} entities: ${totalPlayersFound} players, ${piratesArray.length} pirates, ${empireNpcsArray.length} empire NPCs. Added ${playerCount} new players, ${pirateCount} new pirates, ${empireNpcCount} new empire NPCs`);

    if (playerCount > 0 || pirateCount > 0 || empireNpcCount > 0) {
      this.log("playernames", `Discovered ${playerCount} new player(s), ${pirateCount} new pirate(s), ${empireNpcCount} new empire NPC(s) from nearby scan`);
    }
  }

  /**
   * Feed one `get_nearby` result into the creature store.
   *
   * A nearby scan is the COMPLETE creature list for the POI we are sitting in,
   * so it is handed to `wildlifeStore.reconcile()` as a single "present set"
   * instead of one `add()` per creature: that adds what we now see and prunes
   * the creatureIds we no longer see (killed / despawned), which is what keeps
   * data/creatures from growing forever.
   */
  trackWildlife(nearbyResult: unknown): void {
    if (!nearbyResult || typeof nearbyResult !== "object") {
      return;
    }

    const data = nearbyResult as Record<string, unknown>;
    // Only a response that actually carries a creature list may reconcile —
    // a partial/unrelated payload must never be read as "no creatures here".
    if (!Array.isArray(data.creatures)) return;
    const creaturesArray = data.creatures as Array<Record<string, unknown>>;

    const observed: ObservedCreature[] = [];
    for (const entity of creaturesArray) {
      const name = (entity.name as string) || "";
      if (!name || !name.trim()) continue;
      const hull = (entity.hull as number) || 0;
      observed.push({
        name: name.trim(),
        creatureId: (entity.creature_id as string) || "",
        species: (entity.species as string) || "",
        role: (entity.role as string) || "",
        maxHull: (entity.max_hull as number) || hull,
      });
    }

    const result = wildlifeStore.reconcile(this.system, this.poi, observed);

    if (result.newTypes > 0) {
      this.log("wildlife", `Discovered ${result.newTypes} new wildlife creature(s) from nearby scan`);
    }
    if (result.prunedIds > 0 || result.prunedTypes > 0) {
      debugLogForBot(this.username, "wildlife:prune", `${this.username}`,
        `Pruned ${result.prunedIds} gone creature(s) / ${result.prunedTypes} type(s) at ${this.system}/${this.poi}`);
    }
  }

  /**
   * Extract potential-creature data from a survey_system response and persist it.
   * Unlike trackWildlife (live get_nearby sightings with creature IDs), this
   * captures the survey's `wildlife` (species that may be present, with estimate
   * and abundance) and `faint_signatures` (hints about where creatures hide).
   */
  trackSurveyWildlife(surveyResult: unknown): void {
    if (!surveyResult || typeof surveyResult !== "object") return;
    const data = surveyResult as Record<string, unknown>;

    const rawWildlife = Array.isArray(data.wildlife) ? data.wildlife : [];
    const rawSignatures = Array.isArray(data.faint_signatures) ? data.faint_signatures : [];

    if (rawWildlife.length === 0 && rawSignatures.length === 0) return;

    const wildlife: SurveyWildlifeEntry[] = rawWildlife.map((e) => {
      const w = e as Record<string, unknown>;
      return {
        species: (w.species as string) || "",
        name: (w.name as string) || "",
        role: (w.role as string) || "",
        estimate: Number(w.estimate) || 0,
        abundance: (w.abundance as string) || "",
      };
    });
    const faintSignatures: FaintSignature[] = rawSignatures.map((e) => {
      const s = e as Record<string, unknown>;
      return {
        type: (s.type as string) || "",
        hint: (s.hint as string) || "",
        difficulty: (s.difficulty as string) || undefined,
      };
    });

    wildlifeStore.recordSurvey(this.system, wildlife, faintSignatures);

    if (wildlife.length > 0) {
      this.log("wildlife", `Survey spotted ${wildlife.length} potential species in ${this.system}: ${wildlife.map((w) => w.name).join(", ")}`);
    }
    if (faintSignatures.length > 0) {
      this.log("wildlife", `Faint signatures in ${this.system}: ${faintSignatures.map((s) => s.hint).join("; ")}`);
    }
  }

  /**
   * Extract and track player names from a get_system_agents response.
   */
  trackSystemAgents(systemAgentsResult: unknown): void {
    if (!systemAgentsResult || typeof systemAgentsResult !== "object") {
      this.log("debug", "trackSystemAgents: no result or not object");
      return;
    }

    const data = systemAgentsResult as Record<string, unknown>;

    // Debug: log what keys we have
    debugLogForBot(this.username, "playernames:track_system", `${this.username}`, `get_system_agents result keys: ${Object.keys(data).join(", ")}`);

    const agentsArray = Array.isArray(data.agents) ? data.agents : [];
    let agentCount = 0;

    for (const agent of agentsArray as Array<Record<string, unknown>>) {
      const name = agent.username as string;
      if (name && name.trim()) {
        const trimmedName = name.trim();
        // Extract faction info - prefer faction_tag over faction_id
        let faction = "";
        if (typeof agent.faction_tag === "string" && agent.faction_tag) {
          faction = agent.faction_tag;
        } else if (typeof agent.faction_id === "string" && agent.faction_id) {
          faction = agent.faction_id;
        }
        // Ship class is directly available
        const ship = (agent.ship_class as string) || "";
        // System-wide, no specific POI
        if (playerNameStore.add(trimmedName, faction, ship, "", this.system, "")) {
          agentCount++;
        }
      }
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
        if (playerNameStore.add(name, '', '', '', this.system, this.poi)) {
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
   * Empire NPCs are excluded from tracking.
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
          const trimmedName = name.trim();
          const nameLower = trimmedName.toLowerCase();
          
          // Skip empire NPCs (customs, police, etc.)
          const isEmpireNpc = 
            nameLower.startsWith("[customs]") ||
            nameLower.startsWith("[police]");
          
          if (!isEmpireNpc && playerNameStore.add(trimmedName, '', '', '', this.system, this.poi)) {
            count++;
          }
        }
      }
    }

    if (count > 0) {
      this.log("playernames", `Discovered ${count} new player(s) from battle/scan`);
    }
  }

  /** Signal the bot to stop immediately, canceling all pending operations. */
  stop(): void {
    if (this._state !== "running") return;
    this._state = "stopping";
    this._abortController?.abort();
    // Abort all pending API commands immediately
    for (const controller of this.pendingCommands.values()) {
      controller.abort();
    }
    this.pendingCommands.clear();
    this.log("system", "Stop requested — canceling all pending operations immediately");
  }

  /** Signal the bot to stop after completing the current cycle. */
  stopAfterCycle(): void {
    if (this._state !== "running") return;
    this._stopAfterCycle = true;
    this.log("system", "Stop after cycle requested — will stop after current transport cycle completes");
  }

  /** Check if stop-after-cycle is pending. */
  shouldStopAfterCycle(): boolean {
    return this._stopAfterCycle;
  }

  /** Clear the stop-after-cycle flag (called when stopping is processed). */
  clearStopAfterCycle(): void {
    this._stopAfterCycle = false;
  }

  /** Initiate the stop process (used internally after stop-after-cycle is processed). */
  initiateStop(): void {
    this._state = "stopping";
    this._abortController?.abort();
    for (const controller of this.pendingCommands.values()) {
      controller.abort();
    }
    this.pendingCommands.clear();
  }

  /** Get a summary of the bot's current state. */
  /**
   * Fire the `onStateChanged` UI hook, throttled. A cargo-mover run issues many
   * storage commands back-to-back; coalescing to at most one broadcast every
   * ~150ms keeps the dashboard snappy without flooding it with redundant
   * whole-fleet status pushes.
   */
  notifyStateChanged(): void {
    if (!this.onStateChanged) return;
    if (this._stateChangedTimer) return;
    this._stateChangedTimer = setTimeout(() => {
      this._stateChangedTimer = null;
      try {
        this.onStateChanged?.();
      } catch {
        // never let a UI push break command flow
      }
    }, 150);
  }

  /**
   * Update the cached cargo hold (and derived cargo used/max + credits) directly
   * from a command response that carries the post-action state, then fire the
   * UI hook so the dashboard reflects the move immediately.
   *
   * The v2 `storage` deposit/withdraw responses (and the legacy
   * deposit_items/withdraw_items/faction_deposit_items paths) return the FULL
   * updated `cargo` array plus `ship.cargo_used`/`cargo_capacity` after the
   * transfer, so we can refresh the cargo viewer with ZERO extra network calls —
   * no waiting on a follow-up get_cargo tick. Returns true if it found a cargo
   * array to apply.
   */
  private syncCargoFromResponse(result: unknown): boolean {
    if (!result || typeof result !== "object") return false;
    let r = result as Record<string, unknown>;
    if (r.data && typeof r.data === "object") r = r.data as Record<string, unknown>;
    if (r.structuredContent && typeof r.structuredContent === "object") {
      r = r.structuredContent as Record<string, unknown>;
    }

    let applied = false;

    // Full post-action cargo hold — the authoritative new inventory.
    if (Array.isArray(r.cargo)) {
      this.inventory = this.parseItemList(r, "cargo");
      applied = true;
    }

    // Ship block carries the exact cargo used/capacity after the move.
    const ship = (r.ship as Record<string, unknown>) || {};
    if (typeof ship.cargo_used === "number") this.cargo = ship.cargo_used;
    if (typeof ship.cargo_capacity === "number") this.cargoMax = ship.cargo_capacity;

    // `details` fallbacks (cargo_remaining/cargo_total) when no ship block.
    const details = (r.details as Record<string, unknown>) || {};
    if (ship.cargo_used === undefined) {
      const used = (details.cargo_used as number) ?? (details.cargo_total as number);
      if (typeof used === "number") this.cargo = used;
    }

    // Keep credits fresh (faction credit withdraws / gifts return player.credits).
    const player = (r.player as Record<string, unknown>) || {};
    const creditsValue = (player.credits as number) ?? (r.credits as number);
    if (typeof creditsValue === "number") this.credits = creditsValue;

    if (applied) this.notifyStateChanged();
    return applied;
  }

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
      shipClass: this.shipClass,
      tier: this.tier,
      hull: this.hull,
      maxHull: this.maxHull,
      shield: this.shield,
      maxShield: this.maxShield,
      ammo: this.ammo,
      inventory: this.inventory,
      storage: this.storage,
      stats: { ...this.stats },
      stopAfterCycle: this._stopAfterCycle,
      skills: this.getSkillsSnapshot(),
      factionFuelReserve: this.factionFuelReserve,
      factionFuelCapacity: this.factionFuelCapacity,
      homeBaseFuel: this.homeBaseFuel,
      homeBaseMaxFuel: this.homeBaseMaxFuel,
      homeBaseFuelPoi: this.homeBaseFuelPoi,
      faction: this.faction,
      isCloaked: this.isCloaked,
      hasEmergencyWarpStabilizer: this.hasEmergencyWarpStabilizer,
      bounties: this.bounties,
      inBattle: this.currentBattle.inBattle,
      battleId: this.currentBattle.battleId,
    };
  }

  private getSkillsSnapshot(): Record<string, { level: number; xp: number; xpToNext?: number; totalXP?: number }> {
    const result: Record<string, { level: number; xp: number; xpToNext?: number; totalXP?: number }> = {};
    for (const [id, level] of this.skillLevels.entries()) {
      const entry: { level: number; xp: number; xpToNext?: number; totalXP?: number } = {
        level,
        xp: this.skillXP.get(id) ?? 0,
      };
      const xpToNext = this.skillXpToNext.get(id);
      if (xpToNext !== undefined) entry.xpToNext = xpToNext;
      const totalXP = this.skillTotalXP.get(id);
      if (totalXP !== undefined) entry.totalXP = totalXP;
      result[id] = entry;
    }
    return result;
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
  alert: "\x1b[91m",
};

function getCategoryColor(category: string): string {
  return CATEGORY_COLORS[category] || CATEGORY_COLORS.info;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
