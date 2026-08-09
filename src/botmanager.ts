import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { Bot, type Routine, type BotStatus } from "./bot.js";
import { minerRoutine } from "./routines/miner.js";
import { explorerRoutine } from "./routines/explorer.js";
import { crafterRoutine } from "./routines/crafter.js";
import { rescueRoutine } from "./routines/rescue.js";
import { coordinatorRoutine } from "./routines/coordinator.js";
import { traderRoutine } from "./routines/trader.js";
import { salvagerRoutine } from "./routines/salvager.js";
import { hunterRoutine } from "./routines/hunter.js";
import { factionTraderRoutine } from "./routines/faction_trader.js";
import { craftTradeRoutine } from "./routines/craft_trade.js";
import { tradeBuyerRoutine } from "./routines/trade_buyer.js";
import { cleanupRoutine } from "./routines/cleanup.js";
import { aiRoutine } from "./routines/ai.js";
import { cargoMoverRoutine } from "./routines/cargo_mover.js";
import { returnHomeRoutine } from "./routines/return_home.js";
import { commandReceiverRoutine } from "./routines/command_receiver.js";
import { fleetHunterCommanderRoutine } from "./routines/fleet_hunter_commander.js";
import { fleetHunterSubordinateRoutine } from "./routines/fleet_hunter_subordinate.js";
import { escortRoutine } from "./routines/escort-fleet.js";
import { escortFlockRoutine } from "./routines/escort-flock.js";
import { fuelCellSellerRoutine } from "./routines/fuelCellSeller.js";
import { fuelTransportRoutine } from "./routines/fuelTransfer.js";
import { civilianTransportRoutine, unloadPassengersToLounge } from "./routines/civilianTransport.js";
import { pathfinderTestRoutine } from "./routines/pathfinder_test.js";
import { moduleSellerRoutine } from "./routines/moduleSeller.js";
import { fuelServiceRoutine } from "./routines/fuelService.js";
import { stealthSkillGrindRoutine } from "./routines/stealthSkillGrind.js";
import { idleRoutine } from "./routines/1-idle.js";
import { marketRoutine } from "./routines/market.js";
import { mapStore } from "./mapstore.js";
import { catalogStore } from "./catalogstore.js";
import { formatBearing, getPathfinderTravelTime } from "./pathfinder.js";
import { flushFactionStorageCache } from "./factionStorageCache.js";
import { flushStationFacilityCache } from "./stationFacilityCache.js";
import { WebServer, type WebAction, type WebActionResult, loadSettings, saveSettings, saveLastUsedRoutine, getLastUsedRoutine, getAllLastUsedRoutines, saveStoppedState, getStoppedState, clearStoppedState, getClerkApiKeys, getClerkConfig, setClerkConfig } from "./web/server.js";
import { ChatWebServer } from "./web/chatserver.js";
import { StationWebServer } from "./web/stationserver.js";
import { chatBuffer } from "./chatbuffer.js";
import { setLogSink } from "./ui.js";
import { debugLogForBot, logBotActivity } from "./debug.js";
import { isConnectionError } from "./connection.js";
import { connectOwnedAccounts, initSpacemoltClients, hasSpacemoltClient, listOwnedPlayers, listOwnedPlayersByKey, getConnectedAccounts, getSpacemoltClients, getConnectedAccount, removeConnectedAccount } from "./libClient.js";
import { CLOSE_CODE, type Account } from "@spacemolt/lib";
import { AiChatService } from "./aichat_service.js";
import { addManualRescueRequest, type ManualRescueRequest } from "./manualrescue.js";
import { botChatChannel, type BotChatMessage, type BotChatChannel } from "./bot_chat_channel.js";
import { flushMinerActivity } from "./routines/minerActivity.js";
import { type SyncSettings } from "./client_sync_types.js";
import { ClientSyncSlave } from "./client_sync_slave.js";
import { ClientSyncLightSlave } from "./client_sync_light_slave.js";
import { ClientSyncMarketSlave } from "./client_sync_market_slave.js";
import { setMarketQueryFn } from "./client_sync_hooks.js";
import { snapshotAndReset, setActivePlayers } from "./sendMetrics.js";
import { perf, snapshotAndReset as perfSnapshotAndReset, setActivePlayers as perfSetActivePlayers } from "./perf.js";
import { ensureInsured } from "./routines/common.js";
import { getInsuranceRecord, getInsuranceStatus } from "./insuranceTracker.js";
import { refreshOpenApiV2Spec } from "./openapi.js";
import { logSkills, refreshSkillNames } from "./skillTracker.js";

interface BotState {
  wasRunning: boolean;
  routine: string | null;
}

const BASE_DIR = process.cwd();
const SESSIONS_DIR = join(BASE_DIR, "sessions");

const bots: Map<string, Bot> = new Map();
let server: WebServer;
let chatServer: ChatWebServer;
let stationServer: StationWebServer;
let aiChatService: AiChatService | null = null;

/**
 * Early-login queue: routine keys to start the moment a not-yet-connected bot
 * logs in. A bot rehydrated from the persisted snapshot at startup has no live
 * `Bot`/`Account` yet, so a Start action can't run immediately — instead it's
 * queued here and flushed by `addOwnedAccountAsBot` the instant that bot's
 * account connects (initial connect or watchdog reconnect).
 */
const pendingEarlyLogin = new Map<string, string>();

/**
 * Bots whose connection was closed by the server with a *terminal* close code
 * (`session_replaced` 4001 / `auth_timeout` 4002). These mean the player is
 * already connected somewhere ELSE (another botrunner instance, or you logged in
 * as that player on the website) — the server will keep killing any new session
 * we open for it. The @spacemolt/lib client correctly refuses to reconnect on
 * these codes, but our reconnect watchdog must also honor that: blindly
 * `connectOwned`-ing a terminal-closed bot just opens a socket the server
 * immediately replaces, producing an endless "cannot send on a closed socket"
 * fight that survives restarts (the bot is persisted in `clerk.bots`) and
 * remove/re-add. While a bot is in this set we do NOT auto-reconnect it. The set
 * is cleared when the bot genuinely reconnects, when the user explicitly Starts
 * it, or when it's re-added.
 */
const terminalClosedBots = new Set<string>();

/**
 * Bots that currently have a *forced* reconnection in flight. Used to de-dup
 * the many places that can request a fresh socket for the same bot at once — the
 * `onAccountDisconnected` handler, the connection-health monitor, and the
 * per-command `sendResilient` path all fire independently, and without this guard
 * they would each call `connectOwnedAccounts` concurrently, racing to evict and
 * re-add the same account and wedging the socket. The first caller does the work;
 * the rest see the bot is already in-flight and skip.
 */
const reconnectingBots = new Set<string>();

/**
 * Per-bot reconnection backoff. Every forced reconnect for a bot that KEEPS
 * dying (a socket that connects and then is immediately closed, a server that
 * rate-limits new sessions, …) is spaced out EXPONENTIALLY so we never
 * hammer the server with a reconnect storm. A storm is actively harmful: it
 * makes the server see what looks like duplicate sessions for the same account
 * and answer with a `session_replaced` (4001) / `auth_timeout` (4002)
 * close — which the code then (wrongly) reads as "connected elsewhere"
 * and can wedge the bot for good. Backing off gives the server/library
 * room to breathe and lets a real socket actually stick.
 *
 * Keyed by bot id; `attempts` counts consecutive failures and resets to 0
 * the moment a fresh socket is observed live (see `forceReconnectBot`
 * success path and `addOwnedAccountAsBot`).
 */
const RECONNECT_BASE_MS = 5000;
const RECONNECT_MAX_MS = 120_000; // cap at 2 minutes between attempts
const reconnectBackoff = new Map<string, { lastAttempt: number; attempts: number }>();

/**
 * How long to wait for the OLD socket to finish closing on the wire before we
 * open a brand-new one for the same account.
 *
 * THIS IS THE FIX for the duplicate-login death spiral. `account.close()` (via
 * `client.remove`) only calls `ws.close()`, which merely *initiates* the
 * WebSocket close handshake and returns immediately — the server has NOT yet
 * torn down the old session. If we open the new socket right away, the server
 * still sees the previous session as live, treats our new login as a duplicate,
 * and closes the NEW connection with `session_replaced` (4001). Because WE are
 * the "other login", the recovery loop then just fights itself forever (the
 * exact storm in the logs: "Forcing a fresh socket… / Still disconnected…"
 * every 30s). The moment the routine stopped forcing reconnects, the old socket
 * finished closing and the very next login succeeded — proving the race.
 *
 * So: after closing the old socket we WAIT for it to actually reach CLOSED (the
 * ws "close" event / readyState === CLOSED) before logging in again. We also add
 * a small settle delay so the server-side session teardown completes. Bounded by
 * a timeout so a socket that never emits close can't wedge recovery forever.
 */
const OLD_SOCKET_CLOSE_TIMEOUT_MS = 8000;
/** Extra pause after the old socket is confirmed closed, to let the server free the session slot. */
const OLD_SOCKET_SETTLE_MS = 750;

/** WebSocket.CLOSED readyState (per the WHATWG/ws spec) without importing ws types. */
const WS_CLOSED = 3;

/**
 * Wait until an account's underlying WebSocket has fully closed.
 *
 * Reaches into the library's `account.socket` (a `Socket` wrapper) and its raw
 * `ws`. Resolves when the socket is observably closed (its `closed` flag flips
 * true on the ws "close" event, or the raw ws `readyState` is CLOSED), or when
 * `timeoutMs` elapses — whichever comes first. Never rejects: a best-effort
 * barrier that guarantees we don't race a half-open old socket against a new
 * login. Safe to call after `account.close()` (which starts the close but does
 * not await it).
 */
async function waitForAccountSocketClosed(
  account: unknown,
  timeoutMs = OLD_SOCKET_CLOSE_TIMEOUT_MS,
): Promise<boolean> {
  const sock = (account as { socket?: { closed?: boolean; ws?: unknown } } | null)?.socket;
  if (!sock) return true; // no socket to wait on — treat as already closed
  const isClosed = (): boolean => {
    if (sock.closed === true) return true;
    const ws = sock.ws as { readyState?: number } | null | undefined;
    // No ws (never opened) counts as closed; otherwise require CLOSED state.
    return !ws || ws.readyState === WS_CLOSED;
  };
  if (isClosed()) return true;

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (closed: boolean) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      try {
        const ws = sock.ws as { removeEventListener?: (t: string, cb: () => void) => void } | null | undefined;
        ws?.removeEventListener?.("close", onClose);
      } catch { /* best-effort */ }
      resolve(closed);
    };
    const onClose = () => finish(true);
    try {
      const ws = sock.ws as { addEventListener?: (t: string, cb: () => void) => void } | null | undefined;
      ws?.addEventListener?.("close", onClose);
    } catch { /* best-effort — fall back to polling */ }
    // Poll as a safety net in case the close event fired between our check and
    // listener attach, or the ws implementation doesn't emit a "close" event.
    const poll = setInterval(() => {
      if (isClosed()) finish(true);
    }, 100);
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}

/** Milliseconds to wait before the NEXT forced reconnect for `id`. */
function nextReconnectDelay(id: string): number {
  const b = reconnectBackoff.get(id);
  if (!b) return 0; // first attempt is immediate (instant detection)
  return Math.min(RECONNECT_BASE_MS * 2 ** b.attempts, RECONNECT_MAX_MS);
}

/** Record a (re)connect success: clear any backoff so the next drop starts fresh. */
function resetReconnectBackoff(id: string): void {
  reconnectBackoff.delete(id);
}

/** Get list of discovered bot usernames (for API use). */
export function getDiscoveredBots(): string[] {
  return [...bots.keys()].sort((a, b) => a.localeCompare(b));
}

/** Get a bot by name (for API use). */
export function getBot(name: string): Bot | undefined {
  return bots.get(name);
}

/** Get the current local bot statuses (used by client-sync bot-status pushes). */
export function getBotStatuses(): BotStatus[] {
  return [...bots.values()]
    .sort((a, b) => a.username.localeCompare(b.username))
    .map((b) => b.status());
}

// Publish the status getter on globalThis so low-level modules can ask "is a
// given routine running in this client?" WITHOUT importing botmanager (which
// is the app entry point — importing it from a leaf module boots the whole
// dashboard). Used by the local market source detection.
(globalThis as { __getBotStatuses?: () => BotStatus[] }).__getBotStatuses = getBotStatuses;

/**
 * Get the combined fleet status across EVERY connected client for fleet rescue.
 *
 * This is what the rescue routine's `getFleetStatus` is wired to. It returns the
 * local bots plus, when client-sync is active, the bots reported by every other
 * connected client — either by polling the master directly (this node is the
 * master) or by asking the slave's master for the cross-client fleet poll. The
 * result is de-duplicated by username with local data taking precedence, so a
 * rescue bot sees its own fleet plus the whole connected fleet's fuel/positions
 * in one list — without each stranded bot having to request a rescue itself.
 *
 * The cross-client poll is best-effort: any failure falls back to local-only
 * statuses so rescue across this node's own bots still works.
 */
export async function getCombinedFleetStatus(): Promise<BotStatus[]> {
  const local = getBotStatuses();
  const localNames = new Set(local.map((b) => b.username));

  let remote: Array<Record<string, unknown>> = [];
  let roster: Array<Record<string, unknown>> = [];
  const master = (globalThis as { syncMaster?: import("./client_sync_master.js").ClientSyncMaster }).syncMaster;
  const slave = (globalThis as { syncSlave?: import("./client_sync_slave.js").ClientSyncSlave }).syncSlave;
  const light = (globalThis as { syncLight?: import("./client_sync_light_slave.js").ClientSyncLightSlave }).syncLight;
  const market = (globalThis as { syncMarket?: import("./client_sync_market_slave.js").ClientSyncMarketSlave }).syncMarket;
  let pullError: string | null = null;
  try {
    if (master) {
      // Master already holds the whole combined fleet in memory (every slave's
      // pushed statuses + its own local bots), so this is always up to date and
      // needs no network round-trip.
      const poll = await master.requestFleetRescuePoll();
      remote = poll.bots;
      roster = poll.clients;
    } else if (slave) {
      // Slave/light fetch the master's fleet over the network. Clients restart
      // all the time, so a single attempt can land while this node is mid-
      // (re)registration (clientId null) and silently fall back to local-only —
      // which would make the rescue bot "lose" the whole fleet at scan time.
      // Retry a few times, forcing a fresh register between attempts, so the
      // scan always gets the real combined fleet no matter the connection state.
      const poll = await pullRemoteWithRetry(() => slave.pullFleetRescue(), async () => { await slave.forceRegister(); });
      remote = poll.bots;
      roster = poll.clients;
      pullError = slave.getLastPullError();
    } else if (light) {
      const poll = await pullRemoteWithRetry(() => light.pullFleetRescue(), async () => { await light.forceRegister(); });
      remote = poll.bots;
      roster = poll.clients;
      pullError = light.getLastPullError();
    }
  } catch (err) {
    pullError = `exception: ${err instanceof Error ? err.message : String(err)}`;
    // fall back to local-only fleet
  }

  // Surface a cross-client pull failure to the rescue routine's log so a
  // connectivity problem is visible where the user is actually looking (the
  // rescue scan), not only on this node's console.
  if (pullError && remote.length === 0) {
    console.warn(`[ClientSync] cross-client fleet pull fell back to local-only: ${pullError}`);
  }

  // Roster diagnostic: report every client the master knows about and flag any
  // that contributed 0 bots (registered but not pushing — the usual cause of a
  // "missing" client in the combined fleet). This directly answers "which
  // client is missing?" without having to open the master dashboard.
  if (roster.length > 0) {
    const missing = roster.filter((c) => Number(c.botCount ?? 0) === 0).map((c) => String(c.label || c.clientId));
    const labels = roster.map((c) => `${c.label}(${c.botCount})`).join(", ");
    console.log(`[ClientSync] master roster: ${labels}`);
    if (missing.length > 0) {
      console.warn(`[ClientSync] clients with 0 pushed bots (will be missing from fleet): ${missing.join(", ")}`);
    }
  }

  const merged: BotStatus[] = [...local];
  for (const r of remote) {
    const username = (r.username as string) || "";
    if (!username || localNames.has(username)) continue; // local wins / skip dupes
    merged.push(r as unknown as BotStatus);
  }
  merged.sort((a, b) => a.username.localeCompare(b.username));
  lastFleetRoster = roster;
  lastFleetPullError = pullError;
  return merged;
}

/** Last cross-client fleet roster the master reported (client label → botCount
 *  + lastSeen), captured on the most recent `getCombinedFleetStatus()` call.
 *  Exposed so the rescue routine can show WHICH clients the master sees (and
 *  which are missing) directly in its scan log, instead of only on the node
 *  console where nobody is watching. */
let lastFleetRoster: Array<Record<string, unknown>> = [];
let lastFleetPullError: string | null = null;
export function getLastFleetRoster(): Array<Record<string, unknown>> {
  return lastFleetRoster;
}
export function getLastFleetPullError(): string | null {
  return lastFleetPullError;
}

/**
 * Pull a remote fleet status, retrying across transient "not registered yet"
 * states. `pull` returns {bots:[],clients:[]} when this node has no clientId
 * (local-only fallback); we retry up to a few times, calling `register` between
 * attempts so a rescue scan that coincides with a client restart still gets the
 * master's full combined fleet instead of only the local bots. Never throws.
 */
async function pullRemoteWithRetry(
  pull: () => Promise<{ bots: Array<Record<string, unknown>>; clients: Array<Record<string, unknown>> }>,
  register: () => Promise<void>,
): Promise<{ bots: Array<Record<string, unknown>>; clients: Array<Record<string, unknown>> }> {
  let last: { bots: Array<Record<string, unknown>>; clients: Array<Record<string, unknown>> } = { bots: [], clients: [] };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      last = await pull();
    } catch {
      last = { bots: [], clients: [] };
    }
    // A non-empty result means we got the remote fleet (or at least our own
    // pushed bot). Good enough — stop retrying.
    if (last.bots.length > 0) return last;
    // Empty → likely not registered / master unreachable. Register then retry.
    try { await register(); } catch { /* next attempt */ }
  }
  return last;
}

/** Get the bot-to-bot chat channel service (for routines to use). */
export function getBotChatChannel() {
  return botChatChannel;
}

/** Get total bandwidth usage across all bots in KB/s.
 *  The legacy HTTP transport tracked per-bot bandwidth; the @spacemolt/lib
 *  transport has no equivalent counter, so this currently reports zero. */
export function getTotalBandwidth(): { inKBps: number; outKBps: number } {
  return { inKBps: 0, outKBps: 0 };
}

/** Send a chat message from a bot to other bots. */
export function sendBotChatMessage(
  sender: string,
  content: string,
  channel: BotChatChannel,
  recipients: string[] = [],
  metadata?: Record<string, unknown>
): void {
  botChatChannel.send({
    sender,
    recipients,
    channel,
    content,
    metadata,
  });
}

const ROUTINES: Record<string, { name: string; fn: Routine }> = {
  miner: { name: "Miner", fn: minerRoutine },
  explorer: { name: "Explorer", fn: explorerRoutine },
  crafter: { name: "Crafter", fn: crafterRoutine },
  rescue: { name: "FuelRescue", fn: rescueRoutine },
  coordinator: { name: "Coordinator", fn: coordinatorRoutine },
  trader: { name: "Trader", fn: traderRoutine },
  salvager: { name: "Salvager", fn: salvagerRoutine },
  hunter: { name: "Hunter", fn: hunterRoutine },
  fleet_hunter_commander: { name: "FleetHunterCmd", fn: fleetHunterCommanderRoutine },
  fleet_hunter_subordinate: { name: "FleetHunterWing", fn: fleetHunterSubordinateRoutine },
  faction_trader: { name: "FactionTrader", fn: factionTraderRoutine },
  craft_trade: { name: "CraftTrade", fn: craftTradeRoutine },
  trade_buyer: { name: "TradeBuyer", fn: tradeBuyerRoutine },
  fuel_cell_seller: { name: "FuelCellSeller", fn: fuelCellSellerRoutine },
  fuel_transport: { name: "FuelTransport", fn: fuelTransportRoutine },
  cleanup: { name: "Cleanup", fn: cleanupRoutine },
  ai: { name: "AI", fn: aiRoutine },
  cargo_mover: { name: "CargoMover", fn: cargoMoverRoutine },
  return_home: { name: "ReturnHome", fn: returnHomeRoutine },
  command_receiver: { name: "CommandReceiver", fn: commandReceiverRoutine },
  escort: { name: "Escort (Fleet)", fn: escortRoutine },
  escort_flock: { name: "Escort (Flock)", fn: escortFlockRoutine },
  pathfinder_test: { name: "PathfinderTest", fn: pathfinderTestRoutine },
  civilian_transport: { name: "CivilianTransport", fn: civilianTransportRoutine },
  module_seller: { name: "ModuleSeller", fn: moduleSellerRoutine },
  fuel_service: { name: "FuelService", fn: fuelServiceRoutine },
  stealth_skill_grind: { name: "StealthSkillGrind", fn: stealthSkillGrindRoutine },
  "1-idle": { name: "1-Idle", fn: idleRoutine },
  market: { name: "Market", fn: marketRoutine },
};

/** Categories that go to the broadcast panel instead of bot log. */
const BROADCAST_CATEGORIES = new Set(["broadcast", "chat", "dm"]);

function setupBotLogging(bot: Bot): void {
  bot.onLog = (username, category, message) => {
    const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false });
    const line = `${timestamp} [${username}] [${category}] ${message}`;
    debugLogForBot(username, "bot:onLog", `${username} cat=${category}`, message);
    logBotActivity(username, category, message);
    if (category === "system" || category === "error") {
      server.logSystem(line);
    }
    server.logActivity(line);
    // Per-bot log for profile page activity log
    const botLine = `${timestamp} [${category}] ${message}`;
    server.logBot(username, botLine);
  };
  bot.onFactionLog = (_username, line) => {
    server.logFaction(line);
  };
}

let lastStatusKey = "";

function refreshStatusTable(): void {
  const key = [...bots.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, b]) =>
      `${b.username}:${b.state}:${b.routineName}:${b.credits}:${b.fuel}:${b.maxFuel}:${b.cargo}:${b.cargoMax}:${b.location}:${b.system}:${b.poi}:${b.docked}:${b.shipName}:${b.shipClass}:${b.tier}:${b.hull}:${b.maxHull}:${b.shield}:${b.maxShield}:${b.isCloaked}:${b.faction}:${b.inventory?.length ?? 0}:${b.storage?.length ?? 0}:${b.homeBaseFuel}:${b.currentBattle.inBattle}:${b.currentBattle.battleId}`
    )
    .join("|");
  if (key === lastStatusKey) return;
  lastStatusKey = key;

  const statuses = [...bots.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, b]) => b.status());
  server.updateBotStatus(statuses);
}

type ClerkPlayerLike = { id: string; username: string };

/**
 * The selected-bot list (`settings.clerk.bots`) and the `bots` map must agree
 * on identity. The map (and the dashboard) are keyed by `account.id` — the
 * library's *managed id* (the username). Historically clerk.bots was seeded
 * with `ClerkPlayer.id`, which is the account's separate `player_id`. Those two
 * ids are NOT the same string, so a value stored as a `player_id` never matched
 * a `bots`-map lookup keyed by `account.id`. That mismatch made "remove" fail to
 * actually drop the bot from the persisted list, and made the periodic
 * reconnect treat every connected bot as "missing" (reconnect storms / bots
 * reappearing on their own).
 *
 * This rewrites any legacy `player_id` entries in clerk.bots to the
 * corresponding username, using the id→username map from a `listOwnedPlayers`
 * result. Idempotent; returns true if a change was persisted.
 */
function normalizeClerkBotsToUsernames(players: ClerkPlayerLike[]): boolean {
  const idToName = new Map<string, string>();
  for (const p of players) idToName.set(p.id, p.username);
  const cfg = getClerkConfig();
  if (!cfg.bots.length) return false;
  let changed = false;
  const next = cfg.bots.map((id) => {
    const name = idToName.get(id);
    if (name && name !== id) {
      changed = true;
      return name;
    }
    return id;
  });
  if (changed) setClerkConfig({ bots: next });
  return changed;
}

/**
 * Wire a freshly connected library `Account` into a `Bot` and register it.
 * Shared by the startup connect and the dashboard "Add Selected" flow so both
 * paths behave identically.
 */
/**
 * Wire a freshly connected (or reconnected) library `Account` into a `Bot`.
 *
 * On a *reconnect* — the library dropped the bot's old socket for good
 * (`onAccountDisconnected`) or a watchdog detected a dead socket — the `Bot`
 * already exists in the `bots` map, so instead of creating a duplicate we swap
 * the fresh `Account` into the existing `Bot` and re-wire its event
 * subscriptions. The `Bot` instance (and any routine currently holding it)
 * keeps working transparently against the new socket.
 *
 * On a *first* connect there is no `Bot` yet, so we create one as before.
 */
/**
 * Post-connect initialization for a bot: pull a fresh canonical seed and
 * populate the cached game state so the dashboard shows real data immediately
 * (idle bots aren't touched by the periodic refresh). Fire-and-forget so a
 * fleet-wide connect kicks every bot off at once without blocking.
 */
function initBot(bot: Bot, account: Account): void {
  void (async () => {
    try {
      await account.refresh();
    } catch { /* fall back to whatever the library already seeded */ }
    await bot.refreshStatus().catch(() => {});
    await bot.refreshShip().catch(() => {});
    const addedStation = await registerBotStation(bot).catch(() => false);
    refreshStatusTable();
    // Broadcast the now-updated map so the dashboard's station pickers
    // (faction storage, approved fuel stations, …) show the new options.
    if (addedStation) server.updateMapData();
  })();
}

/**
 * Start any routine that was queued via the early-login flow (see
 * `pendingEarlyLogin`) now that `id`'s account has connected. Skipped if the
 * bot was intentionally stopped, so a queued routine can't override a Stop.
 */
function flushEarlyLogin(id: string): void {
  const routineKey = pendingEarlyLogin.get(id);
  if (!routineKey) return;
  pendingEarlyLogin.delete(id);
  const bot = bots.get(id);
  if (!bot || !bot.isConnected() || getStoppedState(id)) return;
  server.logSystem(`Early-login: starting queued ${routineKey} routine for ${id}.`);
  handleStart({ type: "start", bot: id, routine: routineKey }).catch(() => {});
}

function addOwnedAccountAsBot(account: Account): void {
  const id = account.id || "";
  if (!id) return;

  // This account successfully connected/reconnected, so clear any terminal-close
  // guard we may have set (a previous session_replaced/auth_timeout). If it gets
  // terminal-closed again, the disconnect handler will re-add it.
  terminalClosedBots.delete(id);
  // …and reset the reconnect backoff: a live socket means we're healthy
  // again, so the next drop should start with an immediate (not backed-off)
  // reconnect instead of inheriting a long cooldown from the previous outage.
  resetReconnectBackoff(id);

  const existing = bots.get(id);
  if (existing) {
    existing.account = account;
    existing.instrumentSend();
    existing.unsubscribeEvents();
    existing.subscribeEvents();
    existing.onDocked = () => void maybeAutoPrepayTax(existing, "dock");
    existing.onStateChanged = () => refreshStatusTable();
    server.logSystem(`Reconnected owned account: ${id}`);
    initBot(existing, account);
    flushEarlyLogin(id);
    return;
  }

  const bot = new Bot(id, BASE_DIR, account);
  setupBotLogging(bot);
  bot.subscribeEvents();
  bot.onDocked = () => void maybeAutoPrepayTax(bot, "dock");
  bot.onStateChanged = () => refreshStatusTable();
  bots.set(id, bot);
  server.logSystem(`Connected owned account: ${id}`);

  // Populate the cached game state once so the dashboard shows real data
  // immediately instead of looking "broken" (all zeroed/unknown) until the bot
  // is opened or started. Idle bots aren't touched by the periodic refresh
  // (which only refreshes running bots), so without this they'd stay empty.
  // refreshStatus() reads the library's seeded account.state; refreshShip()
  // fetches get_ship for the ship name, hull/shield, modules, and ammo, which
  // the seeded state alone doesn't always carry. account.refresh() forces a
  // fresh canonical seed in case seeding hasn't settled by the onConnect call.
  initBot(bot, account);
  flushEarlyLogin(id);
}

/**
 * Register the bot's current docked station into the shared map store.
 *
 * The galaxy map seeded from the public /api/map has systems + connections but
 * no POIs, and POIs are otherwise only discovered during gameplay exploration.
 * That left the web UI's station selectors (faction storage, approved fuel
 * stations, rescue systems, …) empty ("(not set)") until a routine happened to
 * explore. Bots are normally docked when they connect, so recording their
 * current station gives the pickers real options immediately.
 *
 * Returns true if a new station POI was added to the map.
 */
async function registerBotStation(bot: Bot): Promise<boolean> {
  const systemId = bot.system;
  const poiId = bot.poi;
  if (!systemId || !poiId || !bot.docked) return false;

  // Don't re-add a station we already know about.
  const known = mapStore.getSystem(systemId)?.pois.find((p) => p.id === poiId);
  if (known?.has_base || known?.base_id) return false;

  let name = poiId;
  let baseId = poiId;
  let baseName: string | null = null;
  let baseType: string | null = null;
  let services: string[] = [];
  try {
    const resp = await bot.exec("get_poi", {});
    if (!resp.error && resp.result) {
      const r = resp.result as Record<string, unknown>;
      const poi = (r.poi as Record<string, unknown>) || r;
      name = (poi.name as string) || name;
      baseId = (poi.base_id as string) || (poi.id as string) || baseId;
      baseName = (poi.base_name as string) || (poi.name as string) || null;
      baseType = (poi.base_type as string) || null;
      services = (poi.services as string[]) || [];
    }
  } catch { /* best-effort; fall back to ids */ }

  mapStore.updateSystem({
    id: systemId,
    pois: [{
      id: poiId,
      name,
      type: "station",
      has_base: true,
      base_id: baseId,
      base_name: baseName,
      base_type: baseType,
      services,
    }],
  });
  return true;
}

/**
 * Connect the `Bot`s selected in Settings → General → Add Bots from Account
 * through `@spacemolt/lib`. A Clerk account can own hundreds of players, so we
 * connect ONLY the ids the user has explicitly chosen (persisted in
 * `settings.clerk.bots`) rather than every owned account.
 *
 * If no Clerk API key is configured (neither env var nor dashboard key), or no
 * players have been selected yet, no bots start — the dashboard is where
 * selection happens. A second key (Settings → General → Clerk API Key 2) is
 * initialized too, so players owned by a different Clerk account can be added
 * alongside the primary account's players.
 */
async function connectLibraryAccounts(): Promise<void> {
  const keys = getClerkApiKeys();
  if (!keys.length) {
    server.logSystem(
      "No Clerk API key configured — set SPACEMOLT_CLERK_API_KEY (or SPACEMOLT_CLERK_API_KEY_2) or add it in Settings → General → Clerk API Key, then choose players to add.",
    );
    return;
  }
  initSpacemoltClients(keys);

  const selected = getClerkConfig().bots;
  if (!selected.length) {
    server.logSystem(
      "Clerk API key set but no players selected. Open Settings → General → Add Bots from Account to choose which players to run.",
    );
    return;
  }

  // Normalize the persisted selected-bot list (settings.clerk.bots) so it
  // stores usernames (the account id / `bots`-map key) rather than the legacy
  // player_id form. Without this, removal/uncheck never matched and bots kept
  // reconnecting on their own.
  try {
    const players = await listOwnedPlayers();
    normalizeClerkBotsToUsernames(players);
  } catch { /* best-effort; the connect filter below also accepts player_id */ }

  const selectedNow = getClerkConfig().bots;
  server.logSystem(`Connecting ${selectedNow.length} selected owned account(s) across ${keys.length} Clerk key(s) via @spacemolt/lib...`);
  registerClientDisconnectHandlers();
  try {
    const accounts = await connectOwnedAccounts(
      (player) => selectedNow.includes(player.username) || selectedNow.includes(player.id),
      (account) => addOwnedAccountAsBot(account),
    );
    server.logSystem(`Connected ${accounts.length} owned account(s) via @spacemolt/lib`);
  } catch (err) {
    server.logSystem(`Library-owned-account connect failed: ${err}`);
  }
}

/**
 * Clients whose `onAccountDisconnected` listener we've already wired, so we
 * register each client exactly once no matter how many times init/re-init runs.
 */
const registeredClients = new Set<ReturnType<typeof getSpacemoltClients>[number]>();

/**
 * Wire a one-time listener on every initialized client that fires when the
 * library gives up on a bot's socket for good (terminal close, or its
 * in-place reconnect retries exhausted). We log it and let the periodic
 * watchdog batch-reconnect the dead bot(s) on its next tick — re-requesting a
 * fresh socket rather than leaving the `Bot` welded to a dead one.
 */
function registerClientDisconnectHandlers(): void {
  for (const client of getSpacemoltClients()) {
    if (registeredClients.has(client)) continue;
    registeredClients.add(client);

    // The library reconnects a dropped account IN PLACE (same `Account`
    // instance, fresh socket, re-authenticated). When that succeeds it fires
    // `onAccountReconnected` — NOT `onAccountConnected` (the instance never
    // changed), so our per-connect wiring doesn't re-run. We only need to clear
    // our guards + backoff and refresh the table; the `Bot` already holds the
    // (same) live `Account`. This is the happy path we want to WIN — so we must
    // never race it with a forced evict/reconnect (that produced the duplicate
    // `session_replaced` login storm).
    client.onAccountReconnected((account) => {
      const id = account.id || "";
      if (!id) return;
      terminalClosedBots.delete(id);
      const bot = bots.get(id);
      if (bot) bot.clearTerminalClosed();
      resetReconnectBackoff(id);
      server.logSystem(`Library reconnected "${id}" in place (same session) — socket restored.`);
      refreshStatusTable();
    });

    client.onAccountDisconnected((id, err) => {
      const code = (err && (err as { code?: number }).code) ?? undefined;
      const detail = code ?? (err && (err as { message?: string }).message) ?? "closed";

      // IMPORTANT: per @spacemolt/lib, `onAccountDisconnected` fires ONLY when
      // the account is dropped for good — a terminal close (session_replaced /
      // auth_timeout) OR the library's own in-place reconnect exhausted its
      // retries. It does NOT fire for an ordinary blip (the library silently
      // reconnects the same Account in place and fires `onAccountReconnected`
      // instead). So by the time we're here, the library is DONE trying.
      //
      // We do NOT immediately fire a competing reconnect from this handler. The
      // old code did, and combined with the per-command `sendResilient` loops +
      // the health monitor it produced a storm of `client.remove()` +
      // `connectOwned()` calls — each new socket looked like a duplicate login,
      // the server answered `session_replaced` (4001), and the bot could never
      // reconnect until the routine stopped. Instead we mark the bot's recovery
      // as terminal; the single coalesced `runRecovery` loop in bot.ts then asks
      // for exactly ONE forced fresh socket (deduped + backed off). A running
      // bot recovers via that one path; an idle bot is picked up by the
      // watchdog.
      const terminal = code === CLOSE_CODE.SESSION_REPLACED || code === CLOSE_CODE.AUTH_TIMEOUT;
      terminalClosedBots.add(id);
      const bot = bots.get(id);
      if (bot) bot.markTerminalClosed();

      if (terminal) {
        server.logSystem(
          `Connection to "${id}" closed by server (${detail}). ` +
          `The single recovery path will request one fresh socket (backed off). ` +
          `If ${id} is genuinely connected elsewhere, disconnect it there and it will resume automatically.`,
        );
      } else {
        server.logSystem(
          `Library gave up reconnecting "${id}" (${detail}). ` +
          `The single recovery path will request one fresh socket (backed off).`,
        );
      }
    });
  }
}

/**
 * Reconnect any selected bot whose library socket is dead (closed and not
 * coming back).
 *
 * This ONLY opens a fresh socket for bots that are *genuinely missing* from the
 * library's `connected` map and were NOT terminal-closed. The @spacemolt/lib
 * client already auto-reconnects in place for ordinary drops (client-managed
 * `reconnectOnce`), so if a bot is still cached there we leave it alone — the
 * library owns its reconnect and we must not open a competing second connection
 * (that would just fight the library's own reconnect and can wedge the socket).
 *
 * We also do NOT retry bots in `terminalClosedBots`: those were closed by the
 * server with `session_replaced` (4001) / `auth_timeout` (4002), meaning the
 * player is connected ELSEWHERE. The server will keep killing any new session
 * we open, so retrying only produces an endless "cannot send on a closed socket"
 * loop. The user must disconnect the other session first (then click Start, or
 * remove + re-add). This is what makes a terminal close survive restarts and
 * remove/re-add: the bot is persisted in `clerk.bots` and the watchdog would
 * otherwise re-fight it forever.
 *
 * `ids`, when given, limits the reconnect to those bots; when omitted, every
 * selected bot that is genuinely missing + not terminal is connected in one
 * batched call (used by the watchdog). Intentionally-stopped bots are skipped.
 */
async function reconnectDeadBots(ids?: string[]): Promise<void> {
  const selected = perf.timeSync("botmanager.getClerkConfig", () => getClerkConfig()).bots;
  if (!selected.length) return;

  // Lazily (re)initialize clients from the configured keys so a bot added via a
  // second Clerk key after startup can still reconnect even if the dashboard
  // "Save Key" flow didn't run.
  if (!hasSpacemoltClient()) {
    const keys = getClerkApiKeys();
    if (!keys.length) return;
    initSpacemoltClients(keys);
    registerClientDisconnectHandlers();
  }

  const targets = (ids ?? selected).filter((id) => {
    if (perf.timeSync("botmanager.getStoppedState", () => getStoppedState(id))) return false;
    if (!bots.has(id)) return false;
    // Library is already managing this account (cached, possibly mid-reconnect).
    // Let it do its in-place reconnect; do NOT open a competing connection.
    if (getConnectedAccount(id)) return false;
    // Terminal close (connected elsewhere) — do not fight it.
    if (terminalClosedBots.has(id)) return false;
    return true;
  });
  if (!targets.length) return;

  server.logSystem(`Reconnecting ${targets.length} bot(s) with a missing socket: ${targets.join(", ")}`);
  try {
    const accounts = await connectOwnedAccounts(
      (player) => targets.includes(player.username) || targets.includes(player.id),
      (account) => addOwnedAccountAsBot(account),
    );
    refreshStatusTable();
    server.logSystem(`Reconnected ${accounts.length} bot(s) via @spacemolt/lib`);
  } catch (err) {
    // Transient failure — the next watchdog pass will try again.
    server.logSystem(`Reconnect of missing bot(s) failed (will retry): ${err}`);
  }
}

/**
 * Force a brand-new socket for a single bot, RIGHT NOW.
 *
 * Called by `Bot.sendResilient` the instant it hits the FIRST "cannot send on a
 * closed socket" error for an account. The previous behavior was to *passively*
 * `waitForReconnect` — hoping the library's own auto-reconnect (`reconnectOnce`
 * / client-managed `reconnectAccountInPlace`) would revive the socket. But after
 * a server restart the socket can stay dead: the library's reconnect may not fire,
 * or it re-welds us to the *same* permanently-closed `Account` still cached in the
 * client's `connected` map — so we'd sit there "pounding our heads against a
 * closed door" while every command failed. This instead INSTANTLY tells
 * @spacemolt/lib to drop the dead socket and build a fresh one: evict the dead
 * `Account` from the client (so `connectOwned` can't hand us the same closed
 * socket back) and then reconnect it.
 *
 * We also clear any terminal-close guard first. A `session_replaced` (4001) /
 * `auth_timeout` (4002) close is usually a *zombie* session after a server
 * restart — the server still thinks the pre-restart socket is "the" live session,
 * not a genuinely-somewhere-else login — so clearing it here lets our fresh socket
 * win, exactly like the user wants. A truly-elsewhere session will just get
 * replaced again and re-arm the guard behind the routine's back-off restart, which
 * is a correct, bounded retry rather than a silent permanent give-up.
 */
export async function forceReconnectBot(id: string): Promise<void> {
  const now = Date.now();

  // De-dup in-flight: if a reconnect is currently running for this bot,
  // don't start a second concurrent one (we'd race connectOwnedAccounts).
  if (reconnectingBots.has(id)) return;

  // Shared exponential backoff: if the last attempt was too recent, skip.
  // First drop → immediate (instant detection, as wanted). Repeated drops
  // → 5s, 10s, 20s, 40s, 80s, capped at 120s. This is
  // what stops the reconnect STORM: a socket that keeps dying is retried
  // gently instead of hammered every few seconds (which itself provokes
  // the server's "duplicate session" close and wedges the bot for good).
  const b = reconnectBackoff.get(id);
  const delay = b ? Math.min(RECONNECT_BASE_MS * 2 ** b.attempts, RECONNECT_MAX_MS) : 0;
  if (b && now - b.lastAttempt < delay) return;

  reconnectingBots.add(id);
  // Record/advance the backoff tracker up front so a concurrent caller that
  // slips past the in-flight check still respects the window.
  if (!b) reconnectBackoff.set(id, { lastAttempt: now, attempts: 0 });
  else { b.lastAttempt = now; b.attempts++; }

  const RECCONNECT_TIMEOUT_MS = 15_000;
  try {
    // Clear the terminal-close guard so this fresh attempt isn't skipped by
    // reconnectDeadBots / waitForReconnect.
    terminalClosedBots.delete(id);
    const bot = bots.get(id);
    if (bot) bot.clearTerminalClosed();

    // Aggressively evict the dead Account from EVERY client's in-memory
    // `connected` map. The library's `connect()` short-circuits on any cached
    // `Account` for an id *regardless of socket state*, so a subsequent
    // `connectOwned` would hand us back the exact same permanently-dead socket
    // and every command would fail forever. Evicting here guarantees a brand-new
    // `Account` with a live socket is built. Clerk creds are re-stored by
    // connectOwned, so dropping them is safe.
    //
    // CRITICAL ORDERING: capture the old Account references FIRST, then close +
    // evict them, then WAIT for their sockets to actually finish closing on the
    // wire BEFORE we open the replacement. `client.remove` → `account.close()`
    // only calls `ws.close()`, which *starts* the WebSocket close handshake and
    // returns immediately — the server has NOT yet torn down the old session.
    // Opening the new socket before the old one is gone is exactly what made the
    // server answer our own new login with `session_replaced` (4001) and killed
    // it, spinning the recovery loop forever. We control this login, so we make
    // absolutely sure the old socket is dead before the new one is born.
    const oldAccounts: unknown[] = [];
    for (const client of getSpacemoltClients()) {
      const acct = client.account(id);
      if (acct) {
        oldAccounts.push(acct);
        try { client.remove(id); } catch { /* best-effort */ }
      }
    }
    {
      const acct = getConnectedAccount(id);
      if (acct) {
        oldAccounts.push(acct);
        try { removeConnectedAccount(id); } catch { /* best-effort */ }
      }
    }

    // Barrier: block until every old socket for this bot is confirmed CLOSED
    // (or a bounded timeout elapses), then let the server settle. Only after
    // this do we open the fresh socket — guaranteeing the server never sees two
    // concurrent sessions for the same account.
    if (oldAccounts.length) {
      await Promise.all(oldAccounts.map((a) => waitForAccountSocketClosed(a)));
      await new Promise<void>((r) => setTimeout(r, OLD_SOCKET_SETTLE_MS));
    }

    // Attempt the reconnect with a hard timeout so a hanging connectOwned can
    // never block this bot's recovery (or the caller's event loop) forever.
    await Promise.race([
      reconnectDeadBots([id]),
      new Promise<void>((_, reject) =>
        setTimeout(
          () => reject(new Error("reconnect timed out after " + RECCONNECT_TIMEOUT_MS + "ms")),
          RECCONNECT_TIMEOUT_MS,
        ),
      ),
    ]);

    const rebot = bots.get(id);
    if (rebot?.isConnected()) {
      // Success — reset the backoff so the next drop starts immediately again.
      resetReconnectBackoff(id);
      server.logSystem(`Reconnected bot ${id} with a fresh socket.`);
    } else {
      server.logSystem(
        `Reconnect of ${id} did not produce a live socket yet ` +
          `(next attempt in ~${Math.round(
            Math.min(RECONNECT_BASE_MS * 2 ** reconnectBackoff.get(id)!.attempts, RECONNECT_MAX_MS) / 1000,
          )}s) — watchdog/backoff will keep retrying.`,
      );
    }
    refreshStatusTable();
  } finally {
    reconnectingBots.delete(id);
  }
}

/**
 * Reconnect any selected (saved) bot that isn't currently connected.
 *
 * `connectLibraryAccounts` only runs once at startup. If an account failed to
 * connect then — e.g. a transient @spacemolt/lib timeout while many bots were
 * being added — it would otherwise stay missing forever. This periodically
 * retries just the missing ids so a bot can never be left permanently
 * disconnected. `addOwnedAccountAsBot` de-dupes, so already-connected bots are
 * untouched.
 */
async function ensureSelectedBotsConnected(): Promise<void> {
  const selected = perf.timeSync("botmanager.getClerkConfig", () => getClerkConfig()).bots;
  if (!selected.length) return;

  // First, breathe life back into any bot whose socket died but whose Bot
  // object is still around (the library gave up on it / it was dropped).
  await reconnectDeadBots();

  const missing = selected.filter((id) => !bots.has(id));
  if (!missing.length) return;

  // Lazily (re)initialize clients from the configured keys so a bot added via a
  // second Clerk key after startup can still reconnect even if the dashboard
  // "Save Key" flow didn't run.
  if (!hasSpacemoltClient()) {
    const keys = getClerkApiKeys();
    if (!keys.length) return;
    initSpacemoltClients(keys);
  }

  server.logSystem(`Reconnecting ${missing.length} selected bot(s) not currently connected: ${missing.join(", ")}`);
  try {
    await connectOwnedAccounts(
      (player) => missing.includes(player.username) || missing.includes(player.id),
      (account) => addOwnedAccountAsBot(account),
    );
    refreshStatusTable();
  } catch (err) {
    // Transient failure — the next interval pass will try again.
    server.logSystem(`Reconnect of missing bots failed (will retry): ${err}`);
  }
}

/**
 * Proactive connection-health monitor.
 *
 * The `onAccountDisconnected` handler + the per-command `sendResilient` path
 * catch most drops, but a socket can also go *silently* dead (the library
 * neither fires a disconnect event nor flips `account.authenticated`, yet every
 * `send` will throw "cannot send on a closed socket"). Without a watchdog that
 * actually inspects the live connection, such a bot would sit there "doing
 * nothing" until a command happened to fail — the exact symptom reported.
 *
 * This timer polls every bot's live `account.authenticated` flag but is now a
 * BACKSTOP ONLY. A running bot's dropped socket is handled by the single
 * coalesced `runRecovery` loop in bot.ts (driven by `sendResilient`), which
 * first WAITS for @spacemolt/lib's own in-place reconnect before ever forcing a
 * fresh socket. The health monitor must therefore NOT force-reconnect a bot the
 * moment `authenticated` briefly flips false — that flag is transiently false
 * during the library's normal in-place reconnect, and evicting then created the
 * duplicate-login (`session_replaced`) storm that stopped the bot from ever
 * reconnecting. So this only acts on a socket that has been dead for a SUSTAINED
 * period (several consecutive checks), is NOT already being recovered, and whose
 * bot has an active routine driving `runRecovery` OR is idle (nothing else will
 * revive it). It stays purely additive to the existing watchdogs.
 */
const HEALTH_CHECK_INTERVAL_MS = 15_000;
const HEALTH_CHECK_THROTTLE_MS = 120_000; // at most one forced reconnect per bot per 2 min
// A socket must look dead across this many consecutive checks before the
// backstop acts — long enough that the library's own in-place reconnect (paced
// through its rate-limited queue) has had a fair chance to restore it first.
const HEALTH_DEAD_STREAK_REQUIRED = 4; // 4 × 15s = ~60s sustained-dead
const lastHealthReconnect = new Map<string, number>();
const healthDeadStreak = new Map<string, number>();

function startConnectionHealthMonitor(): ReturnType<typeof setInterval> {
  return setInterval(() => {
    const now = Date.now();
    for (const bot of bots.values()) {
      // Only running bots have a live routine that would otherwise mask a dead
      // socket behind "idle" — but a dead idle bot should also be revived so its
      // next Start/login works instantly. Cover both, skip stopped ones.
      if (perf.timeSync("botmanager.getStoppedState", () => getStoppedState(bot.username))) continue;

      const acct = bot.account;
      if (!acct) continue;

      const looksDead =
        !acct.authenticated ||
        // Some library builds expose a readyState (0=CONNECTING,1=OPEN,
        // 2=CLOSING,3=CLOSED). Anything other than OPEN means we are not
        // delivering commands, so treat it as needing a fresh socket.
        ((acct as unknown as { readyState?: number }).readyState !== undefined &&
          (acct as unknown as { readyState?: number }).readyState !== 1);

      if (!looksDead) {
        healthDeadStreak.delete(bot.username);
        continue;
      }

      // A running bot already has `runRecovery` driving reconnection (via
      // sendResilient). Let that single path own it — the backstop must not race
      // it. Only step in for bots with no active recovery in flight.
      if (bot.hasActiveRecovery()) {
        continue;
      }

      // Require a SUSTAINED dead streak so the library's in-place reconnect has
      // had time to restore the socket before we ever consider forcing one.
      const streak = (healthDeadStreak.get(bot.username) ?? 0) + 1;
      healthDeadStreak.set(bot.username, streak);
      if (streak < HEALTH_DEAD_STREAK_REQUIRED) continue;

      // Throttle: don't force-reconnect the same bot more than once per
      // HEALTH_CHECK_THROTTLE_MS, and never while one is already in flight.
      if (reconnectingBots.has(bot.username)) continue;
      const last = lastHealthReconnect.get(bot.username) ?? 0;
      if (now - last < HEALTH_CHECK_THROTTLE_MS) continue;
      lastHealthReconnect.set(bot.username, now);
      healthDeadStreak.delete(bot.username);

      server.logSystem(
        `Health monitor: socket for "${bot.username}" has been dead ~${streak * (HEALTH_CHECK_INTERVAL_MS / 1000)}s ` +
          `with no recovery in flight — requesting one fresh socket (backed off).`,
      );
      forceReconnectBot(bot.username).catch((err) => {
        server.logSystem(`Health monitor reconnect failed for "${bot.username}": ${err}`);
      });
    }
  }, HEALTH_CHECK_INTERVAL_MS);
}

// ── Action handlers ──────────────────────────────────────────

async function handleAction(action: WebAction): Promise<WebActionResult> {
  switch (action.type) {
    case "start":
      return handleStart(action);
    case "stop":
      return handleStop(action);
    case "stop_after_cycle":
      return handleStopAfterCycle(action);
    case "chat":
      return handleChat(action);
    case "saveSettings":
      return handleSaveSettings(action);
    case "exec":
      return handleExec(action);
    case "remove":
      return handleRemove(action);
    case "emergencyReturn":
      return handleEmergencyReturn();
    case "shutdown":
      return handleShutdown();
    case "manual_rescue_request":
      return handleManualRescueRequest(action);
    case "pathfinder_calc":
      return handlePathfinderCalc(action);
    case "setClerkKey":
      return handleSetClerkKey(action);
    case "listClerkPlayers":
      return handleListClerkPlayers();
    case "addClerkBots":
      return handleAddClerkBots(action);
    case "setPerformanceMonitoring":
      return handleSetPerformanceMonitoring(action);
    case "bulkSetHunterMode":
      return handleBulkSetHunterMode(action);
    default:
      return { ok: false, error: `Unknown action: ${(action as any).type}` };
  }
}

async function handleShutdown(): Promise<WebActionResult> {
  server.logSystem("Shutdown requested from web UI");
  // Use globalThis shutdown function if available, otherwise trigger manually
  const shutdownFn = (globalThis as any).shutdownServer;
  if (shutdownFn) {
    shutdownFn("web-ui");
  }
  return { ok: true, message: "Server shutting down..." };
}

async function handleSaveSettings(action: WebAction): Promise<WebActionResult> {
  const routine = (action as any).routine as string;
  const s = action.settings;
  if (!routine || !s) return { ok: false, error: "Routine and settings required" };

  // Persist the Clerk "Add Bots" selection when the General settings are saved.
  // Unchecking a bot in that list and pressing Save must remove it from the
  // persisted selected-bot list so it doesn't reconnect on the next restart.
  const sel = action.clerkSelection;
  if (sel && Array.isArray(sel.displayed) && Array.isArray(sel.checked)) {
    // Normalize any legacy player_id entries to usernames first (best-effort),
    // so an unchecked-but-legacy entry can actually be matched against the
    // displayed usernames and dropped below.
    try {
      const players = await listOwnedPlayers();
      normalizeClerkBotsToUsernames(players);
    } catch { /* best-effort */ }
    const displayed = new Set(sel.displayed);
    const checked = new Set(sel.checked);
    // Keep everything already persisted EXCEPT a bot the user explicitly showed
    // in the list AND left unticked (that's the "uncheck + Save = remove"
    // gesture). Always re-add the ticked bots too — this way a freshly-added bot
    // whose checkbox state hasn't settled in the DOM can never be silently
    // dropped from the persisted list (which would make it vanish on restart).
    // Bots that were never shown in this list (e.g. owned by a Clerk key the
    // user hasn't listed right now) are left untouched.
    const nextBots = [...new Set([
      ...getClerkConfig().bots.filter((id) => !displayed.has(id) || checked.has(id)),
      ...checked,
    ])];
    setClerkConfig({ bots: nextBots });
    server.logSystem(`Updated selected-bot list (${nextBots.length} kept) from General settings save.`);
  }

  if (routine === "flock") {
    const { writeFileSync, existsSync, mkdirSync } = await import("fs");
    const { join } = await import("path");
    const flockFile = join(process.cwd(), "data", "flock.json");
    const dir = join(process.cwd(), "data");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const current = existsSync(flockFile) ? JSON.parse(require("fs").readFileSync(flockFile, "utf-8")) : { flockGroups: [], assignments: {} };
    if (s.flockGroups !== undefined) current.flockGroups = s.flockGroups;
    if (s.assignments !== undefined) current.assignments = s.assignments;
    writeFileSync(flockFile, JSON.stringify(current, null, 2) + "\n", "utf-8");
    server.logSystem(`Flock settings saved`);
    return { ok: true, message: `flock settings saved` };
  }

  server.saveRoutineSettings(routine, s);
  server.logSystem(`Settings saved for ${routine}`);
  
  // Update client sync slave settings if changed
  if (routine === "clientSync") {
    const newSettings: SyncSettings = {
      enabled: (s.enabled as boolean) ?? false,
      mode: ((s.mode as string) || "slave"),
      masterUrl: ((s.masterUrl as string) || ""),
      apiKey: ((s.apiKey as string) || ""),
      password: ((s.password as string) || ""),
      label: ((s.label as string) || ""),
      pollIntervalSec: ((s.pollIntervalSec as number) || 15),
      syncMap: ((s.syncMap as boolean) ?? true),
      syncMarket: ((s.syncMarket as boolean) ?? true),
      syncCatalog: ((s.syncCatalog as boolean) ?? true),
      syncStats: ((s.syncStats as boolean) ?? true),
      syncBotChat: ((s.syncBotChat as boolean) ?? true),
      syncPlayerNames: ((s.syncPlayerNames as boolean) ?? true),
      syncCoordination: ((s.syncCoordination as boolean) ?? true),
      syncCivilianTransport: ((s.syncCivilianTransport as boolean) ?? true),
      syncRescue: ((s.syncRescue as boolean) ?? true),
      syncWildlife: ((s.syncWildlife as boolean) ?? true),
      allowRemoteBotsInDropdowns: ((s.allowRemoteBotsInDropdowns as boolean) ?? true),
      remoteBotNameStyle: ((s.remoteBotNameStyle as "prefix" | "suffix") || "prefix"),
      pushLocalDiscoveries: ((s.pushLocalDiscoveries as boolean) ?? true),
      selfUrl: ((s.selfUrl as string) || ""),
      disabledSyncFiles: Array.isArray(s.disabledSyncFiles) ? (s.disabledSyncFiles as string[]) : [],
    };
    const syncSlave = (globalThis as any).syncSlave as ClientSyncSlave | undefined;
    const syncLight = (globalThis as any).syncLight as ClientSyncLightSlave | undefined;
    if (newSettings.enabled && newSettings.mode === "slave" && newSettings.masterUrl) {
      if (syncSlave) {
        syncSlave.updateSettings(newSettings);
      } else {
        const newSlave = new ClientSyncSlave(newSettings);
        newSlave.start();
        (globalThis as any).syncSlave = newSlave;
        server.logSystem(`Client sync slave started`);
      }
    } else {
      if (syncSlave) {
        syncSlave.stop();
        delete (globalThis as any).syncSlave;
        server.logSystem(`Client sync slave stopped`);
      }
    }

    // Lightweight client connect: shares only bot names/statuses + the non-API
    // bot chat channel. No file sync at all.
    if (newSettings.enabled && newSettings.mode === "light" && newSettings.masterUrl) {
      if (syncLight) {
        syncLight.updateSettings(newSettings);
      } else {
        const newLight = new ClientSyncLightSlave(newSettings);
        newLight.start();
        (globalThis as any).syncLight = newLight;
        setMarketQueryFn((query) => newLight.queryRemoteMarket(query));
        server.logSystem(`Client sync light started`);
      }
    } else {
      if (syncLight) {
        syncLight.stop();
        delete (globalThis as any).syncLight;
        server.logSystem(`Client sync light stopped`);
      }
    }

    // Market sync client: lightweight connect that additionally supports low-BW
    // market data queries. No file sync.
    const syncMarket = (globalThis as any).syncMarket as ClientSyncMarketSlave | undefined;
    if (newSettings.enabled && newSettings.mode === "market" && newSettings.masterUrl) {
      if (syncMarket) {
        syncMarket.updateSettings(newSettings);
      } else {
        const newMarket = new ClientSyncMarketSlave(newSettings);
        newMarket.start();
        (globalThis as any).syncMarket = newMarket;
        setMarketQueryFn((query) => newMarket.queryRemoteMarket(query));
        server.logSystem(`Client sync market started`);
      }
    } else {
      if (syncMarket) {
        syncMarket.stop();
        delete (globalThis as any).syncMarket;
        server.logSystem(`Client sync market stopped`);
      }
    }

    // Keep a live master in sync with edited settings (per-file opt-out list,
    // api key, password, mode) so changes apply without a restart.
    const syncMaster = (globalThis as any).syncMaster as import("./client_sync_master.js").ClientSyncMaster | undefined;
    if (syncMaster) {
      syncMaster.updateSettings(s);
    }
  }
  
  return { ok: true, message: `${routine} settings saved`, settings: server.settings };
}

/** Live toggle for CPU performance monitoring (no full settings save round-trip). */
async function handleSetPerformanceMonitoring(action: WebAction): Promise<WebActionResult> {
  const enabled = !!(action as any).enabled;
  perf.setEnabled(enabled);
  server.logSystem(`Performance monitoring ${enabled ? "enabled" : "disabled"}`);
  return { ok: true, message: `performance monitoring ${enabled ? "enabled" : "disabled"}` };
}

async function handleBulkSetHunterMode(action: WebAction): Promise<WebActionResult> {
  const mode = (action as any).mode as string;
  if (!mode) return { ok: false, error: "Missing mode" };

  const allBots = [...bots.values()];
  if (allBots.length === 0) return { ok: true, message: "No bots to update" };

  for (const bot of allBots) {
    const existing = server.settings[bot.username] || {};
    server.settings[bot.username] = { ...existing, hunterMode: mode };
  }

  if (!server.settings.hunter) server.settings.hunter = {};
  server.settings.hunter.mode = mode;

  saveSettings(server.settings);
  server.logSystem(`Bulk set hunter mode to "${mode}" for ${allBots.length} bot(s)`);
  return { ok: true, message: `Updated hunter mode to "${mode}" for ${allBots.length} bot(s)` };
}

async function handleManualRescueRequest(action: WebAction): Promise<WebActionResult> {
  const botName = action.bot;
  if (!botName) return { ok: false, error: "No bot specified" };

  const bot = bots.get(botName);
  if (!bot) return { ok: false, error: `Bot not found: ${botName}` };

  const targetSystem = (action as any).targetSystem as string;
  const targetPOI = (action as any).targetPOI as string;
  const targetPlayer = (action as any).targetPlayer as string;

  if (!targetSystem) return { ok: false, error: "No target system specified" };
  if (!targetPOI) return { ok: false, error: "No target POI specified" };
  if (!targetPlayer) return { ok: false, error: "No target player specified" };

  // Check if the bot is running the rescue routine
  const botStatus = bot.status();
  if (botStatus.routine !== "rescue") {
    return { ok: false, error: `Bot is not running the rescue routine (current: ${botStatus.routine || "idle"})` };
  }

  // Add the manual rescue request to the queue
  const request: ManualRescueRequest = {
    targetPlayer,
    targetSystem,
    targetPOI,
    timestamp: Date.now(),
    botUsername: botName,
  };

  const added = addManualRescueRequest(request);
  if (!added) {
    return { ok: false, error: "Duplicate rescue request - already queued" };
  }

  server.logSystem(`Manual rescue request queued: ${targetPlayer} at ${targetSystem}/${targetPOI} (for bot ${botName})`);
  return { ok: true, message: `Rescue request queued for ${targetPlayer}` };
}

async function handlePathfinderCalc(action: WebAction): Promise<WebActionResult> {
  const p = (action.params || {}) as Record<string, unknown>;
  const from = (p.from || p.origin || p.originSystem) as string | undefined;
  const to = (p.to || p.target || p.targetSystem) as string | undefined;
  const bearing = typeof p.bearing === "number" ? p.bearing : (typeof p.simulateBearing === "number" ? p.simulateBearing : undefined);
  const originForSim = (p.originSystem || p.from || from) as string | undefined;
  const precision = typeof p.precision === "number" ? Math.max(0, Math.min(20, p.precision)) : 12;

  if (from && to) {
    const res = mapStore.computeSafePathfinderBearing(from, to);
    if (!res) return { ok: false, error: "Missing positions for one or both systems in map data" };
    const travel = res.landing ? mapStore.getPathfinderTravelTime(res.landing.proj) : null;
    return {
      ok: true,
      data: {
        bearing: res.bearing,
        bearingFormatted: formatBearing(res.bearing, precision),
        safe: res.safe,
        landing: res.landing,
        blocker: res.blocker,
        margin: mapStore.getPathfinderLandingMargin(),
        precisionUsed: precision,
        travelTime: travel,   // { ticks, seconds } — independent of ship speed
      },
    };
  }

  if (typeof bearing === "number" && originForSim) {
    const landing = mapStore.simulatePathfinderLanding(originForSim, bearing);
    const travel = landing ? mapStore.getPathfinderTravelTime(landing.proj) : null;
    return {
      ok: true,
      data: {
        bearing,
        bearingFormatted: formatBearing(bearing, precision),
        landing,
        void: !landing,
        margin: mapStore.getPathfinderLandingMargin(),
        precisionUsed: precision,
        travelTime: travel,
      },
    };
  }

  if (typeof bearing === "number") {
    return {
      ok: true,
      data: {
        bearing,
        bearingFormatted: formatBearing(bearing, precision),
        reverse: (bearing + 180) % 360,
        reverseFormatted: formatBearing((bearing + 180) % 360, precision),
        precisionUsed: precision,
      },
    };
  }

  return { ok: false, error: "Provide from+to for bearing calc, or originSystem+bearing to simulate, or just bearing for reverse" };
}

async function handleSetClerkKey(action: WebAction): Promise<WebActionResult> {
  const key = (action as any).clerkApiKey as string | undefined;
  const key2 = (action as any).clerkApiKey2 as string | undefined;
  if (!key && !key2) return { ok: false, error: "No Clerk API key provided" };

  // Only overwrite the fields the dashboard actually sent (so saving the second
  // key alone doesn't blank out the first, and vice versa).
  const partial: { apiKey?: string; apiKey2?: string } = {};
  if (key !== undefined) partial.apiKey = key;
  if (key2 !== undefined) partial.apiKey2 = key2;
  setClerkConfig(partial);

  const keys = getClerkApiKeys();
  try {
    initSpacemoltClients(keys);
  } catch (err) {
    return { ok: false, error: `Failed to initialize client: ${err instanceof Error ? err.message : String(err)}` };
  }
  server.logSystem("Clerk API key(s) saved. Use 'List Players' to choose accounts to add.");
  return { ok: true, message: "Clerk API key(s) saved. Use 'List Players' to choose accounts to add." };
}

async function handleListClerkPlayers(): Promise<WebActionResult> {
  const keys = getClerkApiKeys();
  if (!keys.length) {
    return { ok: false, error: "No Clerk API key set. Add it in Settings → General → Clerk API Key first." };
  }
  try {
    initSpacemoltClients(keys);
  } catch {
    // already initialized is fine
  }
  try {
    const groups = await listOwnedPlayersByKey();
    const allPlayers = groups.flatMap((g) => g.players);
    normalizeClerkBotsToUsernames(allPlayers);
    const selected = new Set(getClerkConfig().bots);
    const connected = new Set(getConnectedAccounts().map((a) => a.id));
    const data = groups.map((g) => ({
      keyIndex: g.keyIndex,
      keyLabel: g.keyLabel,
      players: g.players.map((p) => ({
        id: p.id,
        username: p.username,
        empire: p.empire,
        hidden: p.hidden,
        // The selected list may hold either the username (account id) or the
        // legacy player_id form, so accept both.
        selected: selected.has(p.id) || selected.has(p.username),
        connected: connected.has(p.id) || connected.has(p.username),
      })),
    }));
    const count = data.reduce((n, g) => n + g.players.length, 0);
    return { ok: true, data: { groups: data, count } };
  } catch (err) {
    return { ok: false, error: `Failed to list owned players: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function handleAddClerkBots(action: WebAction): Promise<WebActionResult> {
  const ids = (action as any).ids as string[] | undefined;
  if (!ids || !ids.length) return { ok: false, error: "No players selected" };
  const keys = getClerkApiKeys();
  if (!keys.length) {
    return { ok: false, error: "No Clerk API key set. Add it in Settings → General → Clerk API Key first." };
  }
  try {
    initSpacemoltClients(keys);
  } catch {
    // already initialized is fine
  }

  // Persist the selection so these bots reconnect on next restart.
  // ids arrive as usernames (account ids) from the dashboard. Normalize any
  // legacy player_id entries already in the list to usernames too.
  const prev = getClerkConfig().bots;
  const idsAsUsernames = Array.from(new Set(ids));
  let merged = Array.from(new Set([...prev, ...idsAsUsernames]));
  try {
    const players = await listOwnedPlayers();
    const idToName = new Map(players.map((p) => [p.id, p.username]));
    merged = merged.map((id) => idToName.get(id) ?? id);
    const mergedSet = new Set(merged);
    merged = [...mergedSet];
  } catch { /* best-effort */ }
  setClerkConfig({ bots: merged });
  // Re-adding is an explicit attempt to bring these bots online, so clear any
  // terminal-close guard and let them try once.
  for (const id of idsAsUsernames) terminalClosedBots.delete(id);

  try {
    registerClientDisconnectHandlers();
    const accounts = await connectOwnedAccounts(
      (player) => merged.includes(player.username) || merged.includes(player.id),
      (account) => addOwnedAccountAsBot(account),
    );
    refreshStatusTable();
    server.logSystem(`Added ${accounts.length} bot(s) from Clerk account.`);
    return { ok: true, message: `Added ${accounts.length} bot(s).`, data: { added: accounts.length, ids: merged } };
  } catch (err) {
    return { ok: false, error: `Failed to add bots: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Auto-restart bookkeeping, per bot.
 *
 * A routine that dies with a *connection* error (e.g. "cannot send on a closed
 * socket") would otherwise be restarted synchronously and fail instantly again,
 * producing an unbounded fire-and-forget microtask loop. That flood saturates
 * the event loop so the web UI locks up and even Ctrl-C can't get a word in.
 *
 * To prevent that we:
 *   - schedule the restart via setTimeout (so the event loop always yields
 *     between attempts — the client stays responsive and can be interrupted),
 *   - back the delay off exponentially, and
 *   - back a connection-loss off exponentially but NEVER give up on it, so a
 *     bot can't be left permanently disconnected — it keeps retrying with a
 *     delay until the socket is restored, and
 *   - give up entirely after a bounded number of consecutive *non-connection*
 *     failures (a routine that keeps crashing on its own logic shouldn't retry
 *     forever, and the user can press Start to retry manually).
 */
interface RestartState {
  consecutiveFailures: number;
  connectionRetries: number;
  timer: ReturnType<typeof setTimeout> | null;
}
const restartStates = new Map<string, RestartState>();

/** Max consecutive *non-connection* failures before we give up auto-restarting
 *  (a routine that keeps crashing on its own logic shouldn't retry forever). */
const MAX_CONSECUTIVE_FAILURES = 6;
/** Initial backoff (ms); doubles each attempt up to RESTART_MAX_BACKOFF_MS. */
const RESTART_BASE_BACKOFF_MS = 2000;
const RESTART_MAX_BACKOFF_MS = 60000;

/** Errors indicating the underlying transport socket is dead. We NEVER give up
 *  on these — the bot keeps retrying with a delay until the connection comes
 *  back, so it can never be left permanently disconnected. The matcher is
 *  shared with the command dispatch layer via ./connection.js (isConnectionError)
 *  so the two stay in lockstep. */

/** Call when a routine finishes successfully so the failure counters reset. */
function recordSuccessfulRun(botName: string): void {
  const s = restartStates.get(botName);
  if (s) {
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }
    s.consecutiveFailures = 0;
    s.connectionRetries = 0;
  }
}

/**
 * (Re)launch the bot's last-used routine. Shared by every retry timer so the
 * actual start logic lives in exactly one place.
 */
function fireRestart(botName: string): void {
  const b = bots.get(botName);
  if (!b) return;
  if (getStoppedState(botName)) return;
  if (b.state !== "error") return;
  // A terminal-closed bot (session_replaced / auth_timeout) may have been killed
  // by a post-restart zombie session rather than a genuine elsewhere login, so
  // we DO auto-restart it here (the backoff retry in scheduleAutoRestart already
  // governs how often). Clearing the guard lets this attempt open a fresh socket;
  // a genuinely-elsewhere account simply re-dies and re-arms the guard + backoff.
  if (terminalClosedBots.has(botName)) {
    terminalClosedBots.delete(botName);
    const bot2 = bots.get(botName);
    if (bot2) bot2.clearTerminalClosed();
  }
  const lastRoutine = getLastUsedRoutine(botName);
  const routineKey = (lastRoutine && ROUTINES[lastRoutine]) ? lastRoutine : "miner";
  if (!lastRoutine) {
    server.logSystem(`Bot ${botName} in ERROR state but no last-used routine found, defaulting to miner`);
  } else {
    server.logSystem(`Bot ${botName} in ERROR state, auto-restarting with last-used routine: ${lastRoutine}`);
  }
  handleStart({ type: "start", bot: botName, routine: routineKey });
}

function scheduleAutoRestart(botName: string, errorMsg: string): void {
  const bot = bots.get(botName);
  if (!bot) return;

  const stoppedState = getStoppedState(botName);
  if (stoppedState) {
    server.logSystem(`Bot ${botName} was stopped intentionally (${stoppedState}), skipping auto-restart`);
    return;
  }

  // Terminal-close guard: the server closed this account with session_replaced /
  // auth_timeout, meaning it believes the player is connected ELSEWHERE. That is
  // usually a *zombie* session after a server restart — the old socket is gone
  // but the server still treats it as "the" live session — and a fresh socket
  // reconnects immediately. It can also be a genuine elsewhere login. Either way
  // we keep retrying to drop + reconnect (just on a long, gentle backoff so we
  // recover automatically without flooding the server or the other session),
  // rather than permanently giving up and leaving the bot dead.
  let s = restartStates.get(botName);
  if (terminalClosedBots.has(botName)) {
    if (s?.timer) { clearTimeout(s.timer); s.timer = null; }
    if (!s) { s = { consecutiveFailures: 0, connectionRetries: 0, timer: null }; restartStates.set(botName, s); }
    s.connectionRetries++;
    const delay = Math.min(
      RESTART_BASE_BACKOFF_MS * 2 ** (s.connectionRetries - 1),
      RESTART_MAX_BACKOFF_MS * 5,
    );
    server.logSystem(
      `Bot ${botName} was closed (connected elsewhere) — will keep trying to drop + reconnect in ` +
      `${Math.round(delay / 1000)}s (attempt ${s.connectionRetries}). Reconnects automatically once the socket sticks.`,
    );
    s.timer = setTimeout(() => {
      s!.timer = null;
      fireRestart(botName);
    }, delay);
    return;
  }

  if (bot.state !== "error") return;

  // If a retry is already pending for this bot, leave it (avoids the periodic
  // checker and the .catch double-scheduling and resetting the backoff).
  if (s?.timer) return;
  if (!s) { s = { consecutiveFailures: 0, connectionRetries: 0, timer: null }; restartStates.set(botName, s); }

  const lostConnection = isConnectionError(errorMsg);

  if (lostConnection) {
    // Lost connection: keep retrying forever (with a delay) so the bot comes
    // back automatically when the socket is restored — never permanently stuck.
    s.connectionRetries++;
    const delay = Math.min(
      RESTART_BASE_BACKOFF_MS * 2 ** (s.connectionRetries - 1),
      RESTART_MAX_BACKOFF_MS,
    );
    server.logSystem(
      `Bot ${botName} lost connection (${errorMsg}) — will auto-retry in ${Math.round(delay / 1000)}s ` +
      `(attempt ${s.connectionRetries}). It will keep retrying until reconnected.`,
    );
    s.timer = setTimeout(() => {
      s!.timer = null;
      fireRestart(botName);
    }, delay);
    return;
  }

  s.consecutiveFailures++;
  if (s.consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
    server.logSystem(
      `Bot ${botName} failed ${MAX_CONSECUTIVE_FAILURES} times in a row — giving up auto-restart. ` +
      `Press Start to retry manually.`,
    );
    if (s.timer) clearTimeout(s.timer);
    s.consecutiveFailures = 0;
    s.timer = null;
    bot.clearError();
    return;
  }

  const backoff = Math.min(
    RESTART_BASE_BACKOFF_MS * 2 ** (s.consecutiveFailures - 1),
    RESTART_MAX_BACKOFF_MS,
  );
  server.logSystem(
    `Bot ${botName} in ERROR state — auto-restart scheduled in ${Math.round(backoff / 1000)}s ` +
    `(attempt ${s.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}).`,
  );

  s.timer = setTimeout(() => {
    s!.timer = null;
    fireRestart(botName);
  }, backoff);
}

/**
 * If tax auto-prepay is enabled (settings.general.tax.autoPrepayOnStartup) and
 * the bot is currently docked, top up its personal tax-prepayment pool to cover
 * the current estimated bill. Only the shortfall over what is already prepaid is
 * ever sent, so re-running can never stack a huge over-payment on a small bill.
 * Pulls from faction storage only when the wallet can't cover the shortfall and
 * the operator left useFactionStorage enabled.
 *
 * Fire-and-forget safe: never throws. Used on bot startup, routine start, and
 * the daily recheck so a docked bot always has its pool topped up regardless of
 * when/why it came online.
 */
async function maybeAutoPrepayTax(bot: Bot, label: string): Promise<void> {
  const generalSettings = (server.settings as Record<string, unknown>).general as Record<string, unknown> | undefined;
  const taxSettings = (generalSettings?.tax as Record<string, unknown> | undefined) || {};
  if (!taxSettings.autoPrepayOnStartup) return;
  if (!bot.docked) return;

  // Make sure docked/credit state is fresh before deciding.
  try {
    await bot.refreshStatus();
  } catch {
    /* best-effort */
  }
  if (!bot.docked) return;

  const maxPrepayRaw = typeof taxSettings.autoPrepayMax === "number" ? taxSettings.autoPrepayMax : 0;
  // 0 means "no cap" in the UI — map it back to Infinity.
  const maxPrepay = maxPrepayRaw > 0 ? maxPrepayRaw : Infinity;
  try {
    const prepaid = await bot.prepayTaxShortfall({
      maxPrepay,
      useFactionStorage: taxSettings.autoPrepayUseFactionStorage !== false,
    });
    if (prepaid > 0) {
      server.logSystem(`[${label}] Auto-prepaid ${prepaid}cr of tax for ${bot.username}`);
    }
  } catch (err) {
    server.logSystem(`[${label}] Tax auto-prepay failed for ${bot.username}: ${err}`);
  }
}

export async function handleStart(action: WebAction): Promise<WebActionResult> {
  const botName = action.bot;
  if (!botName) return { ok: false, error: "No bot specified" };

  const routineKey = action.routine || "miner";
  const routine = ROUTINES[routineKey];
  if (!routine) return { ok: false, error: `Unknown routine: ${routineKey}` };

  const bot = bots.get(botName);
  if (!bot) {
    // The bot isn't connected yet (e.g. it's a rehydrated bot from the
    // persisted snapshot that hasn't logged in this session). If it's in the
    // selected-bot list it WILL reconnect, so queue the routine to start the
    // moment it logs in ("early login") instead of erroring out.
    if (getClerkConfig().bots.includes(botName)) {
      pendingEarlyLogin.set(botName, routineKey);
      server.saveBotAssignment(botName, routineKey);
      saveLastUsedRoutine(botName, routineKey);
      server.logSystem(`Queued early-login for ${botName} with ${routineKey} — starts on login.`);
      return { ok: true, message: `Queued ${routineKey} for ${botName} — starts automatically on login.` };
    }
    return { ok: false, error: `Bot not found: ${botName}` };
  }
  if (bot.state === "running") return { ok: false, error: `${botName} is already running` };
  if (bot.state === "error") {
    bot.clearError();
  }

  // Clear any stopped state when manually starting the bot
  clearStoppedState(botName);
  // A manual Start is an explicit attempt to bring the bot online, so clear any
  // terminal-close guard (session_replaced/auth_timeout) and let this one try.
  terminalClosedBots.delete(botName);

  // Check insurance status using persistent log before starting routine
  // This avoids the 10sec delay of calling get_insurance_quote on every start
  const insuranceRecord = getInsuranceRecord(botName);
  if (insuranceRecord && bot.shipId) {
    const status = getInsuranceStatus(botName, bot.shipId);
    const timestamp = new Date(insuranceRecord.timestamp).toLocaleString("en-US", { hour12: false });
    
    if (!status.needsRepurchase && status.isInsured) {
      server.logSystem(`${botName}: Ship ${bot.shipId} has valid insurance (${status.timeRemaining} remaining, purchased: ${timestamp})`);
    } else if (bot.shipId !== insuranceRecord.shipId) {
      server.logSystem(`${botName}: Ship changed from ${insuranceRecord.shipId} to ${bot.shipId} - needs insurance check`);
    } else {
      server.logSystem(`${botName}: Insurance expiring soon (${status.timeRemaining}) - will check on dock`);
    }
  }

  saveLastUsedRoutine(botName, routineKey);
  server.logSystem(`Starting ${bot.username} with ${routine.name} routine...`);

  // Top up this bot's personal tax-prepayment pool on routine start (idempotent:
  // only the shortfall over what is already prepaid is sent). Gated by the
  // tax.autoPrepayOnStartup setting and requires the bot be docked (so it can
  // pull from faction storage if the wallet is short). Non-blocking on the
  // routine launch — fire-and-forget so a slow/failed prepay never delays the
  // routine itself.
  void maybeAutoPrepayTax(bot, "routine-start").then(() => refreshStatusTable());

  // Store routine parameters on bot object if provided (for manual_rescue etc.)
  if (action.params) {
    (bot as unknown as Record<string, unknown>).routineParams = action.params;
  }

  const startOpts = (routineKey === "rescue" || routineKey === "coordinator" || routineKey === "escort")
    ? {
        getFleetStatus: () => [...bots.values()].map(b => b.status()),
        getFleetStatusAsync: () => getCombinedFleetStatus(),
      }
    : undefined;

  // Add bot chat functions to all routines
  const chatStartOpts = {
    ...startOpts,
    sendBotChat: (content: string, channel: string, recipients?: string[], metadata?: Record<string, unknown>) => {
      sendBotChatMessage(botName, content, channel as BotChatChannel, recipients, metadata);
    },
    getAllBotNames: () => [...bots.keys()],
    getBotAssignments: () => server.getBotAssignments(),
    log: (category: string, message: string) => server.logBot(botName, `[${category}] ${message}`),
    getBotFreshStatus: async (targetBotName: string): Promise<import("./bot.js").BotStatus | null> => {
      const targetBot = bots.get(targetBotName);
      if (!targetBot || !targetBot.isConnected()) return null;
      // NOTE: must use refreshStatus() (a real get_status), NOT refreshLocation().
      // refreshLocation() reads account.state, which the library only keeps
      // current from push events and does NOT update credits (see bot.ts). Idle
      // bots never fetch get_status on their own, so their cached credit balance
      // would stay stale (usually 0) — which is exactly what made the rescue
      // routine keep topping the same bot off every cycle. A real get_status
      // updates the cached credits so the next read sees the true balance.
      await targetBot.refreshStatus();
      return targetBot.status();
    },
  };

  bot.start(routineKey, routine.fn, chatStartOpts).then(() => {
    server.logSystem(`Bot ${bot.username} routine finished.`);
    server.clearBotAssignment(botName);
    clearStoppedState(botName);
    // Clear params after routine completes
    (bot as unknown as Record<string, unknown>).routineParams = undefined;
    // A successful run resets the auto-restart failure counter.
    recordSuccessfulRun(botName);
  }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    server.logSystem(`Bot ${bot.username} stopped with error: ${msg}`);
    server.clearBotAssignment(botName);
    // Clear params after error
    (bot as unknown as Record<string, unknown>).routineParams = undefined;
    // Auto-restart on ERROR state (backed off + capped so a dead connection
    // can't flood the log and lock up the client).
    scheduleAutoRestart(botName, msg);
  });

  server.saveBotAssignment(botName, routineKey);
  saveLastUsedRoutine(botName, routineKey);

  return { ok: true, message: `Started ${botName} with ${routine.name}` };
}

async function handleStop(action: WebAction): Promise<WebActionResult> {
  const botName = action.bot;
  if (!botName) return { ok: false, error: "No bot specified" };

  const bot = bots.get(botName);
  if (!bot) return { ok: false, error: `Bot not found: ${botName}` };
  if (bot.state !== "running") return { ok: false, error: `${botName} is not running` };

  bot.stop();
  server.clearBotAssignment(botName);
  saveStoppedState(botName, "user");
  server.logSystem(`Stop signal sent to ${bot.username}`);
  return { ok: true, message: `Stop signal sent to ${botName}` };
}

async function handleStopAfterCycle(action: WebAction): Promise<WebActionResult> {
  const botName = action.bot;
  if (!botName) return { ok: false, error: "No bot specified" };

  const bot = bots.get(botName);
  if (!bot) return { ok: false, error: `Bot not found: ${botName}` };
  if (bot.state !== "running") return { ok: false, error: `${botName} is not running` };

  bot.stopAfterCycle();
  saveStoppedState(botName, "user");
  server.logSystem(`Stop after cycle requested for ${bot.username}`);
  return { ok: true, message: `Stop after cycle requested for ${botName} — will stop after current transport cycle` };
}

async function handleEmergencyReturn(): Promise<WebActionResult> {
  server.logSystem("EMERGENCY RETURN HOME: Stopping all bots and setting to return_home routine...");
  
  const runningBots = [...bots.values()].filter(b => b.state === "running");
  if (runningBots.length === 0) {
    server.logSystem("EMERGENCY RETURN HOME: No running bots to stop");
    return { ok: true, message: "No running bots to stop" };
  }

  // Stop all running bots
  for (const bot of runningBots) {
    bot.stop();
    server.clearBotAssignment(bot.username);
    saveStoppedState(bot.username, "emergency");
    server.logSystem(`Stop requested for ${bot.username}`);
  }

  // Wait for all bots to fully stop (state changes from "stopping" to "idle")
  server.logSystem("Waiting for bots to stop current actions...");
  const STOP_TIMEOUT = 15000; // 15 seconds max wait
  const CHECK_INTERVAL = 500; // Check every 500ms
  
  const startTime = Date.now();
  for (const bot of runningBots) {
    while (bot.state === "stopping" && (Date.now() - startTime) < STOP_TIMEOUT) {
      await new Promise(r => setTimeout(r, CHECK_INTERVAL));
    }
    if (bot.state === "stopping") {
      server.logSystem(`${bot.username} did not stop gracefully — forcing restart`);
      // Force reset the state
      (bot as any)._state = "idle";
      (bot as any)._routine = null;
    } else {
      server.logSystem(`${bot.username} stopped successfully`);
    }
  }

  // Additional delay to ensure any in-progress API calls complete
  await new Promise(r => setTimeout(r, 2000));

  // Start all bots with return_home routine
  for (const bot of runningBots) {
    const routineKey = "return_home";
    const routine = ROUTINES[routineKey];

    server.logSystem(`Starting ${bot.username} with ${routine.name} routine...`);

    const botName = bot.username;
    const chatStartOpts = {
      sendBotChat: (content: string, channel: string, recipients?: string[], metadata?: Record<string, unknown>) => {
        sendBotChatMessage(botName, content, channel as BotChatChannel, recipients, metadata);
      },
    getAllBotNames: () => [...bots.keys()].sort((a, b) => a.localeCompare(b)),
      getBotAssignments: () => server.getBotAssignments(),
    };

    bot.start(routineKey, routine.fn, chatStartOpts).then(() => {
      server.logSystem(`Bot ${bot.username} return_home routine finished.`);
      server.clearBotAssignment(bot.username);
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      server.logSystem(`Bot ${bot.username} stopped with error: ${msg}`);
      server.clearBotAssignment(bot.username);
    });

    server.saveBotAssignment(bot.username, routineKey);
  }

  server.logSystem(`EMERGENCY RETURN HOME: ${runningBots.length} bot(s) set to return_home`);
  return { ok: true, message: `Emergency Return Home initiated for ${runningBots.length} bot(s)` };
}

async function handleRemove(action: WebAction): Promise<WebActionResult> {
  const botName = action.bot;
  if (!botName) return { ok: false, error: "No bot specified" };

  const bot = bots.get(botName);
  if (!bot) {
    // Not connected yet (e.g. a rehydrated bot from the persisted snapshot
    // that hasn't logged in this session). Just drop it from the displayed
    // fleet, the selected-bot list, and any queued early-login so it doesn't
    // reappear on the next restart.
    if (getClerkConfig().bots.includes(botName)) {
      server.clearSeededOffline(botName);
      pendingEarlyLogin.delete(botName);
      clearStoppedState(botName);
      const removeIds = new Set<string>([botName]);
      const clerkBots = getClerkConfig().bots.filter((id) => !removeIds.has(id));
      setClerkConfig({ bots: clerkBots });
      server.logSystem(`Removed (not yet connected) bot: ${botName}`);
      refreshStatusTable();
      return { ok: true, message: `Removed ${botName}` };
    }
    return { ok: false, error: `Bot not found: ${botName}` };
  }

  // Stop the routine (aborts the running loop if any) and tear down the library
  // connection so the bot stops "playing" in the background.
  if (bot.state === "running") {
    bot.stop();
    await new Promise((r) => setTimeout(r, 3000));
  }
  bot.unsubscribeEvents();
  // Clear any terminal-close guard so a future re-add starts clean.
  terminalClosedBots.delete(botName);

  // IMPORTANT: evict the Account from the library's in-memory `connected` map
  // (close + drop cached instance), NOT just `account.close()`. `close()` only
  // sets the socket's permanent `closed` flag + `userClosing` guard and leaves
  // the dead Account cached under this id. Because `SpacemoltClient.connect()`
  // returns any cached Account for an id regardless of socket state, a later
  // re-add/reconnect would hand back that same permanently-dead socket and every
  // command would fail with "cannot send on a closed socket" — forever, and
  // across a browser/dashboard restart (the node process + its cache survive).
  // Evicting guarantees the next connect builds a fresh Account with a live
  // socket. (`client.remove` also drops stored creds, which `connectOwned`
  // re-stores on re-add, so this is safe for Clerk-managed bots.)
  removeConnectedAccount(botName);

  bots.delete(botName);
  server.clearBotAssignment(botName);
  server.removePerBotSettings(botName);
  server.clearSeededOffline(botName);
  pendingEarlyLogin.delete(botName);
  clearStoppedState(botName);

  // Keep the selected-bot list (settings.clerk.bots) in sync so a removed bot
  // isn't re-added on the next restart. clerk.bots may hold either the username
  // (account id / map key) OR a legacy `player_id`, so drop every entry matching
  // either identity for this bot — otherwise the watchdog reconnects it.
  let pid: string | undefined;
  const acct = bot?.account as
    | { state?: { player?: { player_id?: string } }; player?: { id?: string; player_id?: string } }
    | undefined;
  if (acct) {
    pid = acct?.state?.player?.player_id ?? acct?.player?.player_id ?? acct?.player?.id;
  }
  // Normalize any legacy player_id entries to usernames (best-effort) so the
  // filter below can match the stored form even if this bot is stored as a
  // player_id rather than a username.
  try {
    const players = await listOwnedPlayers();
    normalizeClerkBotsToUsernames(players);
  } catch { /* best-effort; the player_id fallback below still covers it */ }
  const removeIds = new Set<string>([botName, ...(pid ? [pid] : [])]);
  const clerkBots = getClerkConfig().bots.filter((id) => !removeIds.has(id));
  setClerkConfig({ bots: clerkBots });

  // Delete session directory
  const sessionDir = join(SESSIONS_DIR, botName);
  try {
    rmSync(sessionDir, { recursive: true, force: true });
  } catch { /* ignore if already gone */ }

  server.logSystem(`Removed bot: ${botName}`);
  refreshStatusTable();
  return { ok: true, message: `Removed ${botName}` };
}


async function handleChat(action: WebAction): Promise<WebActionResult> {
  const { bot: botName, message, channel } = action;
  if (!botName || !message) return { ok: false, error: "Bot and message required" };

  const bot = bots.get(botName);
  if (!bot) return { ok: false, error: `Bot not found: ${botName}` };

  if (!bot.isConnected()) {
    await bot.login();
  }

  const resp = await bot.exec("chat", { content: message, channel: channel || "system" });
  if (resp.error) {
    return { ok: false, error: `Chat failed: ${resp.error.message}` };
  }

  server.logSystem(`[${channel || "system"}] ${bot.username}: ${message}`);

  const targetId = (action as any).targetId as string | undefined;
  if (targetId) {
    chatBuffer.addMessage({
      botUsername: botName,
      channel: channel || "system",
      sender: bot.username,
      content: message,
      timestamp: Date.now(),
      direction: "out",
      targetId,
    });
  } else {
    chatBuffer.addMessage({
      botUsername: botName,
      channel: channel || "system",
      sender: bot.username,
      content: message,
      timestamp: Date.now(),
      direction: "out",
    });
  }

  return { ok: true, message: `Message sent as ${bot.username}` };
}

async function handleExec(action: WebAction): Promise<WebActionResult> {
  const { bot: botName, command, params } = action;
  if (!botName || !command) return { ok: false, error: "Bot and command required" };

  const bot = bots.get(botName);
  if (!bot) return { ok: false, error: `Bot not found: ${botName}` };

  // Ensure session exists before executing command
  if (!bot.isConnected()) {
    await bot.login();
  }

  debugLogForBot(botName, "exec:handler", `${botName} > ${command}`, params);

  // Manual connecting-flight handoff: unload_passenger target=lounge
  // navigates the bot to the faction home base and checks all (or the named)
  // aboard passengers into the faction Transit Lounge for another bot to pick up.
  if (command === "unload_passenger") {
    const target = (params as Record<string, unknown> | undefined)?.target as string | undefined;
    if (target && target.toLowerCase() === "lounge") {
      const result = await unloadPassengersToLounge(bot, {
        id: (params as Record<string, unknown> | undefined)?.id as string | undefined,
      });
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
      refreshStatusTable();
      return { ok: true, message: result.message };
    }
  }

  let resp = await bot.exec(command, params);

  // Broadcast a live storage-change event whenever a faction deposit/withdraw
  // succeeds (local docked OR remote station_id path), so the Station Command
  // Center can refresh near-instantly. The station reference is the param
  // station_id when a remote station was targeted, otherwise the bot's current
  // docked "system|poi".
  if (!resp.error && (command === "faction_deposit_items" || command === "faction_withdraw_items")) {
    const p = (params as Record<string, unknown> | undefined) || {};
    const stationId = (p.station_id as string | undefined) ||
      (bot.docked ? `${bot.system}|${bot.poi}` : "");
    if (stationId) {
      const itemId = (p.item_id as string | undefined) || (p.itemId as string | undefined) || "";
      const action = command === "faction_deposit_items" ? "deposit" : "withdraw";
      server.broadcastJson({
        type: "station_storage_change",
        station: stationId,
        itemId,
        action,
        bot: botName,
      });
    }
  }

  // Persist the per-station facility list cache when a docked bot queries its
  // facilities (these calls already return the data we want to cache). The
  // station key is the docked bot's "system|poi".
  if (!resp.error && (command === "facility") && bot.docked) {
    const action = ((params as Record<string, unknown> | undefined)?.action as string) || "";
    if (action === "faction_list" || action === "list") {
      const stationKey = `${bot.system}|${bot.poi}`;
      try {
        const { updateStationFacilityCache } = await import("./stationFacilityCache.js");
        const d = resp.result as Record<string, unknown> | undefined;
        const toEntries = (arr: unknown): any[] =>
          Array.isArray(arr) ? arr : [];
        updateStationFacilityCache(
          stationKey,
          toEntries(d?.faction_facilities),
          toEntries(d?.player_facilities),
        );
      } catch (e) {
        // best-effort cache write
      }
    }
  }

  // Track player names from get_nearby responses
  if (!resp.error && resp.result && command === "get_nearby") {
    bot.trackNearbyPlayers(resp.result);
    bot.trackWildlife(resp.result);
  }

// Broadcast skills update for get_skills command
  if (!resp.error && resp.result && command === "get_skills") {
    // The API returns skills directly in resp.result (normalized from structuredContent)
    const r = resp.result as Record<string, unknown>;
const skillsObj: Record<string, unknown> | null = 
      (r.skills && typeof r.skills === "object") 
        ? r.skills as Record<string, unknown>
        : r;
    
    if (skillsObj) {
      const skillData: Record<string, { level: number; xp: number; nextLevelXp: number }> = {};
      for (const [skillId, s] of Object.entries(skillsObj)) {
        if (skillId === 'message' || skillId === 'status' || skillId === 'error') continue;
        
        if (s && typeof s === "object") {
          const skillObj = s as Record<string, unknown>;
          const level = (skillObj.level as number) ?? (skillObj.current_level as number) ?? 0;
          const xp = (skillObj.xp as number) ?? (skillObj.experience as number) ?? (skillObj.current_xp as number) ?? 0;
          const xpToNext = (skillObj.xp_to_next_level as number) ?? (skillObj.next_level_xp as number) ?? (skillObj.xp_to_next as number) ?? (skillObj.xp_needed as number) ?? (skillObj.xp_remaining as number) ?? 0;
          skillData[skillId] = {
            level: level || 0,
            xp: xp || 0,
            nextLevelXp: xpToNext || 0
          };
        }
      }
      server.broadcastSkillsUpdate(botName, skillData);
    }
    logSkills(bot);
  }

  // Refresh cached state after mutating commands
  const refreshCommands = new Set([
    "mine", "sell", "buy", "dock", "undock", "travel", "jump",
    "refuel", "repair", "deposit_items", "withdraw_items", "faction_deposit_items", "faction_withdraw_items", "jettison",
    "attack", "loot_wreck", "salvage_wreck", "send_gift", "craft",
    "accept_mission", "complete_mission", "abandon_mission",
    "buy_ship", "sell_ship", "switch_ship", "install_mod", "uninstall_mod", "set_colors",
    "set_home_base",
  ]);
  const stateRefreshCommands = new Set(["get_cargo", "get_ship", "get_location", "view_storage", "view_faction_storage"]);
  
  if (refreshCommands.has(command)) {
    await bot.refreshStatus();

    if (command === "switch_ship" && !resp.error) {
      await ensureInsured({ bot, log: (cat, msg) => bot.log(cat, msg), sleep: (ms: number) => new Promise(r => setTimeout(r, ms)) });
    }

    // Also refresh the recipient bot after gift/trade
    if (command === "send_gift" || command === "trade_offer") {
      const recipient = (params as Record<string, unknown> | undefined)?.recipient as string | undefined;
      const recipientBot = recipient ? bots.get(recipient) : undefined;
      if (recipientBot) {
        // Credits go to recipient's storage locker — auto-withdraw if docked
        if (recipientBot.docked && recipientBot.isConnected()) {
          const giftCredits = (params as Record<string, unknown> | undefined)?.credits as number | undefined;
          if (giftCredits && giftCredits > 0) {
            server.logSystem(`Auto-withdrawing ${giftCredits} credits from storage for ${recipient}...`);
            await recipientBot.exec("withdraw_credits", { amount: giftCredits });
          }
        }
        await recipientBot.refreshStatus();
      }
    }

    refreshStatusTable();
  }

  if (stateRefreshCommands.has(command)) {
    if (command === "get_cargo") {
      await bot.refreshCargoAndStorage();
    } else if (command === "get_ship") {
      await bot.refreshShip();
    } else if (command === "get_location") {
      await bot.refreshLocation();
    } else if (command === "view_storage" || command === "view_faction_storage") {
      await bot.refreshStorage();
    }
    refreshStatusTable();
  }

  // Log manual faction operations to faction activity log
  if (!resp.error) {
    const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false });
    const p = params as Record<string, unknown> | undefined;
    switch (command) {
      case "faction_deposit_credits": {
        const amt = p?.amount as number | undefined;
        if (amt) server.logFaction(`${timestamp} [deposit] ${botName}: Deposited ${amt}cr to faction treasury`);
        break;
      }
      case "faction_withdraw_credits": {
        const amt = p?.amount as number | undefined;
        if (amt) server.logFaction(`${timestamp} [withdraw] ${botName}: Withdrew ${amt}cr from faction treasury`);
        break;
      }
      case "deposit_items": {
        const itemId = p?.item_id as string | undefined;
        const qty = p?.quantity as number | undefined;
        const target = p?.target as string | undefined;
        if (itemId) server.logFaction(`${timestamp} [deposit] ${botName}: Deposited ${qty || 1}x ${itemId} ${target === 'faction' ? 'to faction storage' : 'to station storage'}`);
        break;
      }
      case "withdraw_items": {
        const itemId = p?.item_id as string | undefined;
        const qty = p?.quantity as number | undefined;
        const source = p?.source as string | undefined;
        if (itemId) server.logFaction(`${timestamp} [withdraw] ${botName}: Withdrew ${qty || 1}x ${itemId} ${source === 'faction' ? 'from faction storage' : 'from station storage'}`);
        break;
      }
    }
  }

  if (resp.error) {
    debugLogForBot(botName, "exec:result", `${botName} > ${command} ERROR`, { error: resp.error.message, hasResult: resp.result !== undefined });
    return { ok: false, error: resp.error.message, data: resp.result };
  }

  debugLogForBot(botName, "exec:result", `${botName} > ${command} OK`, { hasResult: resp.result !== undefined, resultType: typeof resp.result });
  return { ok: true, message: `${command} executed`, data: resp.result };
}

// ── Main ────────────────────────────────────────────────────

async function main(): Promise<void> {
  // ── Process-level safety net ──────────────────────────────────────────
  // @spacemolt/lib can surface a late rejection from its internal mutation
  // timeout (e.g. when our execWithTimeout abandons an in-flight account.send,
  // or a response arrives after the request was already cancelled). That
  // rejection otherwise bubbles up as an unhandledRejection and kills the
  // whole process (exit code 1) — taking down every bot and the web UI.
  // Never let a single stray library error take the whole client down; log it
  // and keep running so bots can self-heal / auto-reconnect.
  process.on("uncaughtException", (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[FATAL] Uncaught exception — keeping process alive:", err);
    try { server?.logSystem?.(`Uncaught exception (ignored to stay alive): ${msg}`); } catch { /* ignore */ }
  });
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    console.error("[WARN] Unhandled promise rejection — ignored to keep process alive:", reason);
    try { server?.logSystem?.(`Unhandled rejection ignored (staying alive): ${msg}`); } catch { /* ignore */ }
  });

  // Periodic timers (store IDs for cleanup). Declared up front — BEFORE
  // server.start()/onShutdown — so gracefulShutdown can safely clear them even
  // if a shutdown is requested during the startup sequence. Previously this was
  // declared much later in main(), so an early shutdown threw
  // "Cannot access 'intervals' before initialization" (temporal dead zone).
  const intervals: ReturnType<typeof setInterval>[] = [];

  // Set true once main() has finished wiring everything up. Used to ignore
  // stray /api/shutdown POSTs that arrive from a previous session's open tab
  // during the first moments after a restart (which would otherwise tear the
  // freshly-started server down). Legitimate shutdowns work normally afterwards.
  let startupComplete = false;

  // Load port from settings.json (general.port), env var, or default to 3000
  const settings = loadSettings();
  const port = parseInt(process.env.PORT || String(settings.general?.port || 3000), 10);
  server = new WebServer(port);
  server.routines = Object.keys(ROUTINES).sort();
  server.onAction = handleAction;
  server.onShutdown = async (restart: boolean = false) => {
    // gracefulShutdown is a hoisted function declaration in main(), so it is
    // safe to call directly here. Previously this went through
    // globalThis.shutdownServer, which is only assigned later in main() (after
    // the full startup sequence); if a shutdown was requested before that
    // assignment ran, it threw "globalThis.shutdownServer is not a function"
    // and the request failed.
    // Ignore shutdown requests that arrive before startup has finished — these
    // are almost always a stale POST from a tab left open across a restart, and
    // honoring them would kill the freshly-started server. Throw so the client
    // sees a failed shutdown (not a false "Server Stopped") and the server, and
    // its bots, stay alive.
    if (!startupComplete) {
      server.logSystem("Shutdown ignored: server still starting up (stale request from a previous session?)");
      throw new Error("Server still starting up — shutdown ignored");
    }
    // restart=true means the user asked to restart (re-pull updates / fresh
    // state) rather than fully shut down. gracefulShutdown exits with code 101
    // in that case so the watchdog knows to bring the client back up.
    gracefulShutdown("web-ui", restart);
  };

  // Start the web server BEFORE anything else so the UI can connect and
  // render immediately (showing bots as idle while they load). Previously
  // this ran last, after every account was connected and every routine
  // auto-resumed — which blocked the UI until all players finished loading.
  server.start();

  // Expose the shutdown function on globalThis early (gracefulShutdown is a
  // hoisted function declaration, so it is already defined here). This must be
  // set before any request can reach it, not at the end of main() after the
  // long startup sequence, otherwise web-triggered shutdowns fail with
  // "globalThis.shutdownServer is not a function".
  (globalThis as any).shutdownServer = gracefulShutdown;

  server.logSystem("SpaceMolt Bot Manager v0.2");
  server.logSystem("Connecting owned accounts via @spacemolt/lib...");
  await connectLibraryAccounts();

  const chatPort = parseInt(process.env.CHAT_PORT || String(Number(settings.general?.port || 3000) + 1000), 10);
  chatServer = new ChatWebServer(chatPort);
  chatServer.start();

  const stationPort = parseInt(
    process.env.STATION_PORT || String(Number(settings.general?.port || 3000) + 2000),
    10,
  );
  stationServer = new StationWebServer(stationPort);
  stationServer.start();

  // Initialize client sync slave if configured
  const csSettings = settings.clientSync as Record<string, unknown> | undefined;
  if (csSettings) {
    const clientSyncSettings: SyncSettings = {
      enabled: csSettings.enabled as boolean ?? false,
      mode: (csSettings.mode as string) || "slave",
      masterUrl: (csSettings.masterUrl as string) || "",
      apiKey: (csSettings.apiKey as string) || "",
      password: (csSettings.password as string) || "",
      label: (csSettings.label as string) || "",
      pollIntervalSec: (csSettings.pollIntervalSec as number) || 15,
      syncMap: (csSettings.syncMap as boolean) ?? true,
      syncMarket: (csSettings.syncMarket as boolean) ?? true,
      syncCatalog: (csSettings.syncCatalog as boolean) ?? true,
      syncStats: (csSettings.syncStats as boolean) ?? true,
      syncBotChat: (csSettings.syncBotChat as boolean) ?? true,
      syncPlayerNames: (csSettings.syncPlayerNames as boolean) ?? true,
      syncCoordination: (csSettings.syncCoordination as boolean) ?? true,
      syncCivilianTransport: (csSettings.syncCivilianTransport as boolean) ?? true,
      syncRescue: (csSettings.syncRescue as boolean) ?? true,
      syncWildlife: (csSettings.syncWildlife as boolean) ?? true,
      allowRemoteBotsInDropdowns: (csSettings.allowRemoteBotsInDropdowns as boolean) ?? true,
      remoteBotNameStyle: (csSettings.remoteBotNameStyle as "prefix" | "suffix") || "prefix",
      pushLocalDiscoveries: (csSettings.pushLocalDiscoveries as boolean) ?? true,
      selfUrl: (csSettings.selfUrl as string) || "",
      disabledSyncFiles: Array.isArray(csSettings.disabledSyncFiles) ? (csSettings.disabledSyncFiles as string[]) : [],
    };
    if (clientSyncSettings.enabled && clientSyncSettings.mode === "slave" && clientSyncSettings.masterUrl) {
      const syncSlave = new ClientSyncSlave(clientSyncSettings);
      syncSlave.start();
      (globalThis as any).syncSlave = syncSlave;
      server.logSystem(`Client sync slave enabled, connecting to ${clientSyncSettings.masterUrl}`);
    }
    if (clientSyncSettings.enabled && clientSyncSettings.mode === "light" && clientSyncSettings.masterUrl) {
      const syncLight = new ClientSyncLightSlave(clientSyncSettings);
      syncLight.start();
      (globalThis as any).syncLight = syncLight;
      setMarketQueryFn((query) => syncLight.queryRemoteMarket(query));
      server.logSystem(`Client sync light enabled, connecting to ${clientSyncSettings.masterUrl}`);
    }
    if (clientSyncSettings.enabled && clientSyncSettings.mode === "market" && clientSyncSettings.masterUrl) {
      const syncMarket = new ClientSyncMarketSlave(clientSyncSettings);
      syncMarket.start();
      (globalThis as any).syncMarket = syncMarket;
      setMarketQueryFn((query) => syncMarket.queryRemoteMarket(query));
      server.logSystem(`Client sync market enabled, connecting to ${clientSyncSettings.masterUrl}`);
    }
  }

  // Route global ui.log() calls through the web server
  setLogSink((category, message) => {
    const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false });
    debugLogForBot("SYSTEM", "sink:route", `category=${category}`, message);
    if (BROADCAST_CATEGORIES.has(category)) {
      const tagMatch = message.match(/^\[([^\]]+)\]\s*(.*)/s);
      if (tagMatch) {
        const [, tag, content] = tagMatch;
        debugLogForBot("SYSTEM", "sink:broadcast", `tag=${tag}`, content);
        server.logBroadcast(`${tag} ${timestamp}`);
        server.logBroadcast(content);
        server.logBroadcast("");
      } else {
        server.logBroadcast(`${timestamp} ${message}`);
      }
      return;
    }
    const line = `${timestamp} [${category}] ${message}`;
    if (category === "error") {
      debugLogForBot("SYSTEM", "sink:system", "error routed to system panel", line);
      server.logSystem(line);
    }
    debugLogForBot("SYSTEM", "sink:activity", "routed to bot log", line);
    server.logActivity(line);
  });

  // Initialize and start AI Chat service
  aiChatService = new AiChatService((category, message) => {
    const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false });
    const line = `${timestamp} [AI_CHAT] [${category}] ${message}`;
    server.logSystem(line);
  });
  AiChatService.setGetBotsFn(() => [...bots.values()]);
  // Set up empire alert callback
  aiChatService.setEmpireAlertCallback((sender, content, botUsername) => {
    server.sendEmpireAlert(sender, content, botUsername);
  });
  aiChatService.start();
  // Expose on globalThis for bot.ts to access
  (globalThis as any).aiChatService = aiChatService;
  server.logSystem("AI Chat service initialized");

  // Set up bot-to-bot chat channel logging
  botChatChannel.onGlobalMessage((msg: BotChatMessage) => {
    const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false });
    const recipientInfo = msg.recipients.length > 0 
      ? ` -> ${msg.recipients.join(", ")}` 
      : " -> [broadcast]";
    const line = `${timestamp} [BOT_CHAT] [${msg.channel}] ${msg.sender}${recipientInfo}: ${msg.content}`;
    server.logSystem(line);
  });
  server.logSystem("Bot-to-bot chat channel initialized");

  // Seed galaxy map from public API so pathfinding works from first run
  server.logSystem("Seeding galaxy map from /api/map...");
  mapStore.seedFromMapAPI().then(({ seeded, known, failed }) => {
    if (failed) {
      server.logSystem("Galaxy map seed failed — will rely on exploration data");
    } else {
      server.logSystem(`Galaxy map seeded: ${seeded} new system(s), ${known} already known`);
    }
    console.log(`[MAP_SEED] Completed: seeded=${seeded}, known=${known}, failed=${failed}`);
    console.log(`[MAP_SEED] Total systems in map: ${Object.keys(mapStore.getAllSystems()).length}`);
  }).catch((err) => {
    console.log(`[MAP_SEED] Failed: ${err}`);
    server.logSystem("Galaxy map seed failed — will rely on exploration data");
  });

  // Resolve + persist the V2 OpenAPI spec under a versioned filename
  // (e.g. openapi-V2-V0.501.0.json) for offline websocket / spacemolt-lib / CLI
  // use. Its `gameServerVersion` drives the version-based catalog refresh — there
  // is no more fixed 24h timer; the catalog is re-fetched the moment the live
  // gameserver version (from the spec or any bot's get_state) differs from the
  // catalog we hold.
  const specPromise = refreshOpenApiV2Spec();
  specPromise.then(({ meta, path, saved, changed, throttled }) => {
    const changeNote = changed ? "changed" : throttled ? "throttled — reused cached" : "unchanged (304)";
    console.log(`[OPENAPI] V2 spec ${meta.gameServerVersion} ${changeNote} ${saved ? "saved" : "already present"} -> ${path}`);
  }).catch((err) => {
    console.log(`[OPENAPI] Refresh failed: ${err}`);
  });

  if (bots.size > 0) {
    const assignments = server.getBotAssignments();
    const existingLastUsedRoutines = getAllLastUsedRoutines();
    
    // Migrate any missing last-used routines from assignments (one-time migration)
    for (const [botName, routine] of Object.entries(assignments)) {
      if (!existingLastUsedRoutines[botName] && routine && ROUTINES[routine]) {
        saveLastUsedRoutine(botName, routine);
      }
    }
    
    server.logSystem(`Found ${bots.size} saved bot(s): ${[...bots.keys()].sort((a, b) => a.localeCompare(b)).join(", ")}`);
    server.logSystem(`Bot assignments: ${JSON.stringify(assignments)}`);
    server.logSystem(`Last-used routines: ${JSON.stringify(getAllLastUsedRoutines())}`);
    // Push initial bot list to UI immediately (shows as "idle" with default values)
    refreshStatusTable();

    // Library-owned accounts are already connected & authenticated by
    // connectLibraryAccounts() — no HTTP login/resume is needed. Fetch the
    // catalog, then auto-resume each bot's last-used routine (unless it was
    // stopped intentionally). Run this in the BACKGROUND: for a large fleet it
    // can take minutes, and awaiting it here would (a) block the event loop so
    // WebSocket handshakes / UI updates stall, (b) delay registration of the
    // periodic intervals (status push + reconnect watchdog) — which is exactly
    // why bots looked "not connected" for many minutes after a restart — and
    // (c) leave `intervals` uninitialized so a shutdown during this window
    // threw a TDZ error. Running it fire-and-forget keeps startup instant and
    // lets the 2s status push + watchdog start immediately.
    void (async () => {
      try {
        // Reconcile the catalog against the live gameserver version (from the
        // OpenAPI spec we just resolved). If the server has patched since our
        // cached catalog was written, a fresh catalog.json is fetched; otherwise
        // this is a cheap no-op (version already matches).
        const { meta } = await specPromise;
        if (await catalogStore.noteGameServerVersion(meta.gameServerVersion)) {
          server.logSystem(`Catalog fetched (${catalogStore.getSummary()})`);
        } else {
          server.logSystem(`Catalog up to date (${catalogStore.getSummary()})`);
        }
      } catch (err) {
        server.logSystem(`Catalog sync failed: ${err}`);
      }

      for (const [name, bot] of [...bots.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        try {
          await bot.updateTaxEstimate();
          await bot.updateFactionTaxEstimate();
        } catch (err) {
          server.logSystem(`Tax collection failed for ${name}: ${err}`);
        }

        const routineKey = getLastUsedRoutine(name) || assignments[name];
        if (!routineKey || !ROUTINES[routineKey]) {
          server.logSystem(`${name}: no routine assigned, skipping auto-resume`);
          continue;
        }
        const stoppedState = getStoppedState(name);
        if (stoppedState) {
          server.logSystem(`Bot ${name} was stopped intentionally (${stoppedState}), skipping auto-resume`);
        } else {
          server.logSystem(`Auto-resuming ${name} with ${ROUTINES[routineKey].name}...`);
          await handleStart({ type: "start", bot: name, routine: routineKey });
        }
      }
    })();
  }

  refreshStatusTable();

  // Catalog freshness is now version-driven (see `catalogStore.noteGameServerVersion`):
  // whenever the live gameserver version — from the OpenAPI spec at startup or any
  // bot's get_state at runtime — differs from the catalog we hold, a fresh
  // catalog.json is fetched. No fixed 24h timer.
  if (catalogStore.isStale()) {
    server.logSystem("No cached catalog — will fetch once the gameserver version is known.");
  } else {
    server.logSystem(`Catalog loaded from cache (${catalogStore.getSummary()})`);
  }

  // Periodic timers (store IDs for cleanup). `intervals` is declared at the top
  // of main() so gracefulShutdown can clear them even during startup.
  // Periodic UI push (cached data → websocket clients)
  intervals.push(setInterval(() => {
    try {
      refreshStatusTable();
    } catch (err) {
      console.error('Error in periodic status update:', err);
    }
  }, 2000));

  // Outbound send metrics sampler (read-only; no throttling). Every 10s tag the
  // window with the current active-player count, log a terse summary, and append
  // the row to data/send_metrics.jsonl so we can find the per-client player
  // ceiling by plotting latency/error onset against active players.
  {
    const metricsPath = join(BASE_DIR, "data", "send_metrics.jsonl");
    intervals.push(setInterval(() => {
      try {
        const activePlayers = [...bots.values()].filter(
          (b) => b.state === "running" && b.isConnected(),
        ).length;
        setActivePlayers(activePlayers);
        const snap = snapshotAndReset();
        if (!snap) return;
        const errs = snap.errClosedSocket + snap.errTimeout + snap.errRateLimited + snap.errOther;
        if (errs > 0 || snap.latP95Ms >= 3000) {
          server.logSystem(
            `Send metrics: ${snap.activePlayers} players, ${snap.sends} sends, ` +
            `p50 ${snap.latP50Ms}ms / p95 ${snap.latP95Ms}ms / max ${snap.latMaxMs}ms, ` +
            `maxInFlight ${snap.maxInFlight}, errors ${errs} ` +
            `(closed ${snap.errClosedSocket}, timeout ${snap.errTimeout}, rate ${snap.errRateLimited}, other ${snap.errOther}).`,
          );
        }
        try {
          mkdirSync(join(BASE_DIR, "data"), { recursive: true });
          appendFileSync(metricsPath, JSON.stringify(snap) + "\n");
        } catch { /* metrics file is best-effort; never break the runner */ }
      } catch (err) {
        console.error('Error sampling send metrics:', err);
      }
    }, 10000));
  }

  // CPU/perf metrics sampler (read-only; no throttling). Mirrors the send-metrics
  // sampler: every 10s tag the window with the current active-player count, log a
  // terse summary, and append the row to data/perf_metrics.jsonl so a fleet
  // operator can find which functions/routines burn the most CPU. Disabled by
  // default — only runs when performance monitoring is turned on.
  {
    const perfMetricsPath = join(BASE_DIR, "data", "perf_metrics.jsonl");
    intervals.push(setInterval(() => {
      try {
        if (!perf.isEnabled()) return;
        const activePlayers = [...bots.values()].filter(
          (b) => b.state === "running" && b.isConnected(),
        ).length;
        perfSetActivePlayers(activePlayers);
        const snap = perfSnapshotAndReset();
        if (!snap) return;
        const topHot = snap.hotFunctions.slice(0, 5)
          .map((h) => `${h.name} ${h.wallMs}ms/${h.calls}x`)
          .join(", ");
        const topRoutines = [...snap.routines]
          .sort((a, b) => b.cpuMs - a.cpuMs)
          .slice(0, 5)
          .map((r) => `${r.bot}/${r.routine} ${r.cpuMs}ms/${r.ticks}t`)
          .join(", ");
        server.logSystem(
          `Perf: ${snap.activePlayers} players, EL p95 ${snap.eventLoop.p95Ms}ms / max ${snap.eventLoop.maxMs}ms | ` +
          `hot: ${topHot || "none"} | routines: ${topRoutines || "none"}`,
        );
        try {
          mkdirSync(join(BASE_DIR, "data"), { recursive: true });
          appendFileSync(perfMetricsPath, JSON.stringify(snap) + "\n");
        } catch { /* metrics file is best-effort; never break the runner */ }
      } catch (err) {
        console.error('Error sampling perf metrics:', err);
      }
    }, 10000));
  }

  // Start performance monitoring if it was persisted as enabled in General settings.
  if ((settings.general as Record<string, unknown>)?.performanceMonitoring === true) {
    perf.setEnabled(true);
    server.logSystem("Performance monitoring restored from settings (enabled)");
  }

  // Periodic live refresh (hit API for bots that are running routines only)
  // Set periodicRefreshSec to 0 to disable
  const periodicRefreshSec = (settings.general as Record<string, unknown>)?.periodicRefreshSec as number || 30;
  if (periodicRefreshSec > 0) {
    intervals.push(setInterval(async () => {
      try {
        const refreshPromises = [];
        let refreshCount = 0;
        for (const [, bot] of bots) {
          // Only refresh bots that are actively running a routine
          if (bot.state === "running" && bot.isConnected()) {
            refreshPromises.push(bot.refreshShip().catch(() => {}));
            refreshPromises.push(bot.refreshLocation().catch(() => {}));
            // Library-backed bots receive notifications via push events
            // (Bot.subscribeEvents), so polling get_notifications is redundant
            // and just wastes a round-trip. The HTTP path still needs it.
            if (!bot.account) {
              // Also do a lightweight notification check to keep session alive
              // Use bot.exec() instead of api.execute() to process notifications properly
              refreshPromises.push(bot.exec("get_notifications", { limit: 1, clear: true }).then((resp) => {
                if (resp.notifications && Array.isArray(resp.notifications) && resp.notifications.length > 0) {
                  debugLogForBot(bot.username, "periodic:notifications", `Received ${resp.notifications.length} notification(s) during refresh`);
                }
              }).catch(() => {}));
            }
            refreshCount++;
          }
        }
        if (refreshCount > 0) {
          debugLogForBot("SYSTEM", "periodic:refresh", `Refreshing ${refreshCount} running bot(s)`);
        }
        await Promise.allSettled(refreshPromises);
        refreshStatusTable();
      } catch (err) {
        console.error('Error in periodic live refresh:', err);
      }
    }, periodicRefreshSec * 1000));
  }

  // Daily tax auto-prepay recheck: for docked, running bots, top up each bot's
  // personal tax-prepayment pool to cover its current estimated bill. Because
  // maybeAutoPrepayTax only sends the shortfall over what is already prepaid,
  // re-running daily can never stack a huge over-payment on a small bill — the
  // escrowed credits only refund after Sunday's assessment. Gated by
  // settings.general.tax.autoPrepayOnStartup so it never drains faction credits
  // unless the operator opted in.
  const generalSettingsDaily = (settings as Record<string, unknown>).general as Record<string, unknown> | undefined;
  const taxSettingsDaily = (generalSettingsDaily?.tax as Record<string, unknown> | undefined) || {};
  if (taxSettingsDaily.autoPrepayOnStartup) {
    intervals.push(setInterval(async () => {
      try {
        for (const [name, bot] of [...bots.entries()].sort(([a], [b]) => a.localeCompare(b))) {
          if (bot.state !== "running" || !bot.isConnected()) continue;
          await maybeAutoPrepayTax(bot, "daily");
        }
      } catch (err) {
        console.error("Error in daily tax prepay recheck:", err);
      }
    }, 24 * 60 * 60 * 1000));
  }

  // Periodic get_status for running bots - every 2 minutes to keep credit data fresh
  // This ensures the web UI has current credit information for manual control pages
  intervals.push(setInterval(async () => {
    try {
      const statusPromises = [];
      let statusCount = 0;
      for (const [, bot] of bots) {
        if (bot.state === "running" && bot.isConnected()) {
          statusPromises.push(bot.refreshStatus().catch(() => {}));
          statusCount++;
        }
      }
      if (statusCount > 0) {
        debugLogForBot("SYSTEM", "periodic:status", `Getting fresh status for ${statusCount} running bot(s)`);
      }
      await Promise.allSettled(statusPromises);
      refreshStatusTable();
    } catch (err) {
      console.error('Error in periodic status refresh:', err);
    }
  }, 120 * 1000));

  // Periodic skill logging for all bots with active sessions - every 60 seconds
  intervals.push(setInterval(() => {
    for (const bot of bots.values()) {
      if (bot.isConnected()) {
        logSkills(bot);
      }
    }
  }, 60 * 1000));

  // Low-bandwidth session keep-alive for idle bots (every 40s). This is what
  // keeps the server from timing the socket out while a bot is sitting idle.
  // For HTTP-backed bots we poll get_notifications (also surfaces any pending
  // notifications). For library-backed bots the WebSocket would otherwise go
  // completely silent while idle — and the game server's idle timeout then CLOSES
  // the socket (the "cannot send on a closed socket" deaths). A lightweight
  // get_status is outbound traffic that resets the server idle timer AND keeps
  // the dashboard's cached state current, so idle library bots get pinged too.
  intervals.push(setInterval(async () => {
    try {
      const keepAlivePromises = [];
      let keepAliveCount = 0;
      for (const [name, bot] of bots) {
        // Only hit API for idle bots (not already doing heavy refresh)
        if (bot.state === "idle" && bot.isConnected()) {
          if (!bot.account) {
            // HTTP-backed: poll notifications to keep the session alive
            keepAlivePromises.push(bot.exec("get_notifications", { limit: 1, clear: true }).then((resp) => {
              if (resp.notifications && Array.isArray(resp.notifications) && resp.notifications.length > 0) {
                debugLogForBot(name, "keepalive:notifications", `Received ${resp.notifications.length} notification(s) for idle bot`);
              }
            }).catch(() => {}));
            keepAliveCount++;
          } else {
            // Library-backed: lightweight status ping keeps the idle socket alive
            keepAlivePromises.push(bot.refreshStatus().catch(() => {}));
            keepAliveCount++;
          }
        }
      }
      if (keepAliveCount > 0) {
        debugLogForBot("SYSTEM", "periodic:keepalive", `Session keep-alive for ${keepAliveCount} idle bot(s)`);
      }
      await Promise.allSettled(keepAlivePromises);
    } catch (err) {
      console.error('Error in periodic session keep-alive:', err);
    }
  }, 40 * 1000));

  // Periodic map data push (every 15s so dashboard stays current)
  let lastMapGeneration = mapStore.getMapGeneration();
  intervals.push(setInterval(() => {
    const generation = mapStore.getMapGeneration();
    if (generation === lastMapGeneration) return;
    lastMapGeneration = generation;
    server.updateMapData();
  }, 15000));

  // Periodic stats flush (every 60s)
  intervals.push(setInterval(() => {
    const statuses = [...bots.values()].map(b => b.status());
    server.flushBotStats(statuses);
  }, 60000));

  // Periodic ERROR state check - auto-restart bots that crashed. This is a
  // safety net; the routine's own .catch already schedules a backed-off
  // restart. scheduleAutoRestart() is idempotent while a retry timer is pending,
  // so this won't pile on extra restarts or reset the backoff.
  intervals.push(setInterval(() => {
    for (const [name, bot] of bots) {
      if (bot.state === "error") {
        server.logSystem(`Detected ${name} in ERROR state, ensuring auto-restart is scheduled...`);
        scheduleAutoRestart(name, (bot as unknown as Record<string, unknown>)._error as string || "error state");
      }
    }
  }, 30000));

  // Proactive connection-health monitor: every 15s it inspects each bot's
  // live `account.authenticated` / socket state and force-drops-and-rebuilds
  // any socket that has gone silently dead — so a bot can never sit there
  // "doing nothing" on a closed socket. De-duped + throttled inside.
  intervals.push(startConnectionHealthMonitor());

  // Fast watchdog: re-request a fresh socket for any selected bot whose
  // connection died and the library has given up on (or that was dropped).
  // Batches every dead bot into one reconnect call every 15s, so a bot can
  // never be left welded to a dead "cannot send on a closed socket" socket.
  intervals.push(setInterval(() => {
    reconnectDeadBots().catch(() => {});
  }, 15 * 1000));

  // Periodic reconnect of selected bots that aren't currently connected.
  // Guarantees a bot can never be left permanently disconnected just because
  // its initial connection attempt failed (e.g. a lib timeout while adding
  // many bots at once). Retries the missing ids every 2 minutes.
  intervals.push(setInterval(() => {
    ensureSelectedBotsConnected().catch(() => {});
  }, 2 * 60 * 1000));

  // All periodic timers are registered and the server is fully wired up. From
  // here on, a /api/shutdown POST will be honored (see server.onShutdown).
  startupComplete = true;

  // Graceful shutdown handler
  function gracefulShutdown(signal: string, restart: boolean = false): void {
    console.log(`\nShutting down (${signal})...`);
    server.logSystem(`Server shutdown requested (${signal}${restart ? ", restart requested" : ""})`);
    // Clear intervals
    for (const id of intervals) clearInterval(id);
    // Flush stats before stopping bots
    const statuses = [...bots.values()].map(b => b.status());
    server.flushBotStats(statuses);
    // Flush the active-bots dashboard snapshot (long debounce may have pending write)
    server.flushActiveBots();
    // Stop all running bots
    for (const [, bot] of bots) {
      if (bot.state === "running") bot.stop();
    }
    // Stop AI Chat service
    if (aiChatService) {
      aiChatService.stop();
      aiChatService = null;
    }
    // Flush persistent data
    mapStore.flush();
    catalogStore.flush();
    flushFactionStorageCache();
    flushStationFacilityCache();
    // Flush miner activity data to ensure no data loss
    flushMinerActivity().then(success => {
      if (success) {
        server.logSystem("Miner activity data flushed successfully");
      } else {
        server.logSystem("WARNING: Failed to flush miner activity data");
      }
    }).catch(err => {
      server.logSystem(`ERROR flushing miner activity data: ${err}`);
    });
    server.stop();
    chatServer?.stop();
    stationServer?.stop();

    // If restarting due to mass session loss, clear all session files
    // This forces fresh logins on restart, avoiding the invalid session loop
    // But only if the setting allows it (default: true for backward compatibility)
    const generalSettings = server.getSettings("general");
    const clearSession = generalSettings.clearSessionOnRestart !== false;
    if (restart && signal === "mass_session_loss" && clearSession) {
      server.logSystem(`Clearing session files for all bots...`);
      const sessionsDir = join(BASE_DIR, "sessions");
      if (existsSync(sessionsDir)) {
        const botDirs = readdirSync(sessionsDir, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name);
        
        for (const botName of botDirs) {
          const sessionFile = join(sessionsDir, botName, "session.json");
          if (existsSync(sessionFile)) {
            try {
              rmSync(sessionFile);
              debugLogForBot(botName, "shutdown", `Deleted session file for ${botName}`);
            } catch (err) {
              server.logSystem(`Warning: Failed to delete session file for ${botName}: ${err}`);
            }
          }
        }
        server.logSystem(`Session files cleared for ${botDirs.length} bot(s)`);
      }
    }

    // Exit with a special code so the watchdog knows what to do on exit:
    //   Code 0   = normal shutdown (no restart — user fully stopped the client)
    //   Code 100 = restart requested (mass disconnect / session loss)
    //   Code 101 = restart requested (user-initiated, e.g. to apply updates)
    // The watchdog treats 100 and 101 identically (both restart, after a git
    // pull), but the distinct codes let it log *why* the restart happened so we
    // can tell a deliberate user restart apart from a mass disconnect or a full
    // exit in the watchdog log.
    const exitCode = restart ? (signal === "mass_session_loss" ? 100 : 101) : 0;
    process.exit(exitCode);
  }

  // Graceful shutdown on SIGINT (Ctrl+C) and SIGTERM (Windows/taskkill)
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});


