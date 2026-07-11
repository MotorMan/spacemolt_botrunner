import { existsSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { Bot, type Routine } from "./bot.js";
import { SessionManager } from "./session.js";
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
import { mapStore } from "./mapstore.js";
import { catalogStore } from "./catalogstore.js";
import { formatBearing, getPathfinderTravelTime } from "./pathfinder.js";
import { flushFactionStorageCache } from "./factionStorageCache.js";
import { WebServer, type WebAction, type WebActionResult, loadSettings, saveLastUsedRoutine, getLastUsedRoutine, getAllLastUsedRoutines, saveStoppedState, getStoppedState, clearStoppedState } from "./web/server.js";
import { ChatWebServer } from "./web/chatserver.js";
import { chatBuffer } from "./chatbuffer.js";
import { setLogSink } from "./ui.js";
import { debugLogForBot, logBotActivity } from "./debug.js";
import { reconnectQueue } from "./reconnectqueue.js";
import { AiChatService } from "./aichat_service.js";
import { massDisconnectDetector } from "./massdisconnect.js";
import { addManualRescueRequest, type ManualRescueRequest } from "./manualrescue.js";
import { botChatChannel, type BotChatMessage, type BotChatChannel } from "./bot_chat_channel.js";
import { flushMinerActivity } from "./routines/minerActivity.js";
import { type SyncSettings } from "./client_sync_types.js";
import { ClientSyncSlave } from "./client_sync_slave.js";
import { ensureInsured } from "./routines/common.js";
import { getInsuranceRecord, getInsuranceStatus } from "./insuranceTracker.js";
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
let aiChatService: AiChatService | null = null;

// Track failed session restore attempts per bot (timestamps in ms)
const sessionRestoreFailures: Map<string, number[]> = new Map();

/** Get list of discovered bot usernames (for API use). */
export function getDiscoveredBots(): string[] {
  return [...bots.keys()].sort((a, b) => a.localeCompare(b));
}

/** Get a bot by name (for API use). */
export function getBot(name: string): Bot | undefined {
  return bots.get(name);
}

/** Get the bot-to-bot chat channel service (for routines to use). */
export function getBotChatChannel() {
  return botChatChannel;
}

/** Get total bandwidth usage across all bots in KB/s */
export function getTotalBandwidth(): { inKBps: number; outKBps: number } {
  let totalIn = 0;
  let totalOut = 0;
  for (const bot of bots.values()) {
    const usage = bot.api.getBandwidthUsage();
    totalIn += usage.inKBps;
    totalOut += usage.outKBps;
  }
  return { inKBps: totalIn, outKBps: totalOut };
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
};

// ── Auto-discover existing sessions ─────────────────────────

function discoverBots(): void {
  if (!existsSync(SESSIONS_DIR)) return;
  const dirs = readdirSync(SESSIONS_DIR, { withFileTypes: true });
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const name = d.name;
    if (bots.has(name)) continue;
    const credPath = join(SESSIONS_DIR, name, "credentials.json");
    if (existsSync(credPath)) {
      const bot = new Bot(name, BASE_DIR);
      setupBotLogging(bot);
      bots.set(name, bot);
    }
  }
}

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

function refreshStatusTable(): void {
  const statuses = [...bots.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, b]) => b.status());
  server.updateBotStatus(statuses);
}

// ── Action handlers ─────────────────────────────────────────

async function handleAction(action: WebAction): Promise<WebActionResult> {
  switch (action.type) {
    case "start":
      return handleStart(action);
    case "stop":
      return handleStop(action);
    case "stop_after_cycle":
      return handleStopAfterCycle(action);
    case "add":
      return handleAdd(action);
    case "register":
      return handleRegister(action);
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
    };
    const syncSlave = (globalThis as any).syncSlave as ClientSyncSlave | undefined;
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
  }
  
  return { ok: true, message: `${routine} settings saved`, settings: server.settings };
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

async function handleAutoRestart(botName: string): Promise<void> {
  const stoppedState = getStoppedState(botName);
  if (stoppedState) {
    server.logSystem(`Bot ${botName} was stopped intentionally (${stoppedState}), skipping auto-restart`);
    return;
  }

  const bot = bots.get(botName);
  if (!bot || bot.state !== "error") return;
  
  const lastRoutine = getLastUsedRoutine(botName);
  if (!lastRoutine || !ROUTINES[lastRoutine]) {
    server.logSystem(`Bot ${botName} in ERROR state but no last-used routine found, defaulting to miner`);
    await handleStart({ type: "start", bot: botName, routine: "miner" });
    return;
  }
  server.logSystem(`Bot ${botName} in ERROR state, auto-restarting with last-used routine: ${lastRoutine}`);
  await handleStart({ type: "start", bot: botName, routine: lastRoutine });
}

async function handleStart(action: WebAction): Promise<WebActionResult> {
  const botName = action.bot;
  if (!botName) return { ok: false, error: "No bot specified" };

  const bot = bots.get(botName);
  if (!bot) return { ok: false, error: `Bot not found: ${botName}` };
  if (bot.state === "running") return { ok: false, error: `${botName} is already running` };
  if (bot.state === "error") {
    bot.clearError();
  }

  // Clear any stopped state when manually starting the bot
  clearStoppedState(botName);

  const routineKey = action.routine || "miner";
  const routine = ROUTINES[routineKey];
  if (!routine) return { ok: false, error: `Unknown routine: ${routineKey}` };

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

  // Store routine parameters on bot object if provided (for manual_rescue etc.)
  if (action.params) {
    (bot as unknown as Record<string, unknown>).routineParams = action.params;
  }

  const startOpts = (routineKey === "rescue" || routineKey === "coordinator" || routineKey === "escort")
    ? { getFleetStatus: () => [...bots.values()].map(b => b.status()) }
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
      if (!targetBot || !targetBot.api.getSession()) return null;
      await targetBot.refreshLocation();
      return targetBot.status();
    },
  };

  bot.start(routineKey, routine.fn, chatStartOpts).then(() => {
    server.logSystem(`Bot ${bot.username} routine finished.`);
    server.clearBotAssignment(botName);
    clearStoppedState(botName);
    // Clear params after routine completes
    (bot as unknown as Record<string, unknown>).routineParams = undefined;
  }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    server.logSystem(`Bot ${bot.username} stopped with error: ${msg}`);
    server.clearBotAssignment(botName);
    // Clear params after error
    (bot as unknown as Record<string, unknown>).routineParams = undefined;
    // Auto-restart on ERROR state
    handleAutoRestart(botName);
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
  if (!bot) return { ok: false, error: `Bot not found: ${botName}` };

  // Stop if running
  if (bot.state === "running") {
    bot.stop();
    await new Promise((r) => setTimeout(r, 3000));
  }

  bots.delete(botName);
  server.clearBotAssignment(botName);
  server.removePerBotSettings(botName);
  clearStoppedState(botName);

  // Delete session directory
  const sessionDir = join(SESSIONS_DIR, botName);
  try {
    rmSync(sessionDir, { recursive: true, force: true });
  } catch { /* ignore if already gone */ }

  server.logSystem(`Removed bot: ${botName}`);
  refreshStatusTable();
  return { ok: true, message: `Removed ${botName}` };
}

async function handleAdd(action: WebAction): Promise<WebActionResult> {
  const { username, password } = action;
  if (!username || !password) return { ok: false, error: "Username and password required" };

  if (bots.has(username)) return { ok: false, error: `Bot already exists: ${username}` };

  const session = new SessionManager(username, BASE_DIR);
  session.saveCredentials({ username, password, empire: "", playerId: "" });

  const bot = new Bot(username, BASE_DIR);
  setupBotLogging(bot);
  bots.set(username, bot);

  server.logSystem(`Verifying credentials for ${username}...`);
  const ok = await bot.login();
  if (ok) {
    const s = bot.status();
    server.logSystem(`Added ${username}! Location: ${s.location}, Credits: ${s.credits}`);
  } else {
    server.logSystem(`Login failed for ${username} -- credentials saved, retry later.`);
  }
  refreshStatusTable();
  return { ok: true, message: `Bot added: ${username}` };
}

async function handleRegister(action: WebAction): Promise<WebActionResult> {
  const { username, empire, registration_code } = action;
  if (!username) return { ok: false, error: "Username required" };
  if (!registration_code) return { ok: false, error: "Registration code required (get one from spacemolt.com/dashboard)" };

  const selectedEmpire = empire || "solarian";
  server.logSystem(`Registering ${username} in ${selectedEmpire}...`);

  const tempBot = new Bot(username, BASE_DIR);
  const resp = await tempBot.exec("register", { username, empire: selectedEmpire, registration_code });

  if (resp.error) {
    server.logSystem(`Registration failed: ${resp.error.message}`);
    return { ok: false, error: `Registration failed: ${resp.error.message}` };
  }

  const result = resp.result as Record<string, unknown> | undefined;
  const password = (result?.password as string) || "";
  const playerId = (result?.player_id as string) || "";

  if (!password) {
    server.logSystem("Registration succeeded but no password returned.");
    return { ok: false, error: "No password returned" };
  }

  server.logSystem(`Registration successful for ${username} — password returned to dashboard only.`);

  const session = new SessionManager(username, BASE_DIR);
  session.saveCredentials({ username, password, empire: selectedEmpire, playerId });

  const bot = new Bot(username, BASE_DIR);
  setupBotLogging(bot);
  bots.set(username, bot);
  server.logSystem(`Bot added: ${username}`);
  refreshStatusTable();

  return { ok: true, message: `Registered ${username}`, password };
}

async function handleChat(action: WebAction): Promise<WebActionResult> {
  const { bot: botName, message, channel } = action;
  if (!botName || !message) return { ok: false, error: "Bot and message required" };

  const bot = bots.get(botName);
  if (!bot) return { ok: false, error: `Bot not found: ${botName}` };

  if (!bot.api.getSession()) {
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
  if (!bot.api.getSession()) {
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
    "refuel", "repair", "deposit_items", "withdraw_items", "jettison",
    "attack", "loot_wreck", "salvage_wreck", "send_gift", "craft",
    "accept_mission", "complete_mission", "abandon_mission",
    "buy_ship", "sell_ship", "switch_ship", "install_mod", "uninstall_mod", "set_colors",
    "set_home_base",
  ]);
  const stateRefreshCommands = new Set(["get_cargo", "get_ship", "get_location", "view_storage", "view_faction_storage"]);
  
  if (refreshCommands.has(command)) {
    await bot.refreshStatus();

    if (command === "switch_ship" && !resp.error) {
      await ensureInsured({ bot, log: (cat, msg) => bot.log(cat, msg), sleep: (ms: number) => new Promise(r => setTimeout(r, ms)), api: bot.api });
    }

    // Also refresh the recipient bot after gift/trade
    if (command === "send_gift" || command === "trade_offer") {
      const recipient = (params as Record<string, unknown> | undefined)?.recipient as string | undefined;
      const recipientBot = recipient ? bots.get(recipient) : undefined;
      if (recipientBot) {
        // Credits go to recipient's storage locker — auto-withdraw if docked
        if (recipientBot.docked && recipientBot.api.getSession()) {
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
  // Load port from settings.json (general.port), env var, or default to 3000
  const settings = loadSettings();
  const port = parseInt(process.env.PORT || String(settings.general?.port || 3000), 10);
  server = new WebServer(port);
  server.routines = Object.keys(ROUTINES).sort();
  server.onAction = handleAction;
  server.onShutdown = async () => {
    (globalThis as any).shutdownServer("web-ui");
  };

  server.logSystem("SpaceMolt Bot Manager v0.2");
  server.logSystem("Loading saved sessions...");
  discoverBots();

  const chatPort = parseInt(process.env.CHAT_PORT || String(Number(settings.general?.port || 3000) + 1000), 10);
  chatServer = new ChatWebServer(chatPort);
  chatServer.start();

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
    };
    if (clientSyncSettings.enabled && clientSyncSettings.mode === "slave" && clientSyncSettings.masterUrl) {
      const syncSlave = new ClientSyncSlave(clientSyncSettings);
      syncSlave.start();
      (globalThis as any).syncSlave = syncSlave;
      server.logSystem(`Client sync slave enabled, connecting to ${clientSyncSettings.masterUrl}`);
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

  // Set up mass disconnect detector callback
  massDisconnectDetector.setTriggerCallback((affectedBots) => {
    server.logSystem(`⚠️ MASS SESSION INVALIDATION DETECTED: ${affectedBots.length} unique bots lost sessions within 5s`);
    server.logSystem(`Affected bots: ${affectedBots.join(", ")}`);
    server.logSystem(`Initiating graceful shutdown for restart...`);
    (globalThis as any).shutdownServer("mass_session_loss", true);
  });
  server.logSystem("Mass disconnect detector initialized");

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

    // Session resume is fast (5s delay to match renewal queue), full login requires rate limiting (25s delay)
    const SESSION_RESUME_DELAY_MS = 7000;
    const FULL_LOGIN_DELAY_MS = 13000;
    let botIndex = 0;

 for (const [name, bot] of [...bots.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const delay = botIndex * SESSION_RESUME_DELAY_MS;
      const loginIndex = botIndex;
      botIndex++;
      setTimeout(() => {
        bot.resumeSession().then(async (ok) => {
          refreshStatusTable();
          if (ok) {
            sessionRestoreFailures.delete(name);
            server.logSystem(`${name} session resumed (no login delay)`);
            try {
              await bot.updateTaxEstimate();
              await bot.updateFactionTaxEstimate();
            } catch (err) {
              server.logSystem(`Tax collection failed for ${name}: ${err}`);
            }
            if (catalogStore.isStale() || await catalogStore.checkVersionChanged(bot.api)) {
              try {
                await catalogStore.fetchAll(bot.api);
                server.logSystem(`Catalog fetched (${catalogStore.getSummary()})`);
              } catch (err) {
                server.logSystem(`Catalog fetch failed: ${err}`);
              }
            }
            const routineKey = getLastUsedRoutine(name) || assignments[name];
            if (routineKey && ROUTINES[routineKey]) {
              const stoppedState = getStoppedState(name);
              if (stoppedState) {
                server.logSystem(`Bot ${name} was stopped intentionally (${stoppedState}), skipping auto-resume`);
              } else {
                server.logSystem(`Auto-resuming ${name} with ${ROUTINES[routineKey].name}...`);
                await handleStart({ type: "start", bot: name, routine: routineKey });
              }
            }
            return;
          }

          const now = Date.now();
          const failures = sessionRestoreFailures.get(name) || [];
          failures.push(now);
          const recentFailures = failures.filter(ts => now - ts < 60000);
          sessionRestoreFailures.set(name, recentFailures);

          if (recentFailures.length >= 3) {
            server.logSystem(`${name} session restore failed 3+ times in past minute, forcing immediate full login...`);
            bot.login().then(async (loginOk) => {
              sessionRestoreFailures.delete(name);
              refreshStatusTable();
              if (!loginOk) {
                server.logSystem(`${name} forced login failed`);
                return;
              }
              try {
                await bot.updateTaxEstimate();
                await bot.updateFactionTaxEstimate();
              } catch (err) {
                server.logSystem(`Tax collection failed for ${name}: ${err}`);
              }
              if (catalogStore.isStale() || await catalogStore.checkVersionChanged(bot.api)) {
                try {
                  await catalogStore.fetchAll(bot.api);
                  server.logSystem(`Catalog fetched (${catalogStore.getSummary()})`);
                  refreshSkillNames();
                } catch (err) {
                  server.logSystem(`Catalog fetch failed: ${err}`);
                }
              }
              const routineKey = getLastUsedRoutine(name) || assignments[name];
              if (!routineKey || !ROUTINES[routineKey]) {
                server.logSystem(`${name} logged in but no routine assigned`);
                return;
              }
              const stoppedState = getStoppedState(name);
              if (stoppedState) {
                server.logSystem(`Bot ${name} was stopped intentionally (${stoppedState}), skipping auto-resume`);
              } else {
                server.logSystem(`Auto-resuming ${name} with ${ROUTINES[routineKey].name}...`);
                await handleStart({ type: "start", bot: name, routine: routineKey });
              }
            }).catch((err) => {
              server.logSystem(`Forced login failed for ${name}: ${err}`);
              refreshStatusTable();
            });
          } else {
            const loginDelay = loginIndex * FULL_LOGIN_DELAY_MS;
            server.logSystem(`${name} session expired (${recentFailures.length}/3 failures in past minute), scheduling full login in ${loginDelay / 1000}s...`);
            setTimeout(() => {
              bot.login().then(async (loginOk) => {
                sessionRestoreFailures.delete(name);
                refreshStatusTable();
                if (!loginOk) {
                  server.logSystem(`${name} login failed`);
                  return;
                }
                try {
                  await bot.updateTaxEstimate();
                  await bot.updateFactionTaxEstimate();
                } catch (err) {
                  server.logSystem(`Tax collection failed for ${name}: ${err}`);
                }
                if (catalogStore.isStale() || await catalogStore.checkVersionChanged(bot.api)) {
                  try {
                    await catalogStore.fetchAll(bot.api);
                    server.logSystem(`Catalog fetched (${catalogStore.getSummary()})`);
                    refreshSkillNames();
                  } catch (err) {
                    server.logSystem(`Catalog fetch failed: ${err}`);
                  }
                }
                const routineKey = getLastUsedRoutine(name) || assignments[name];
                if (!routineKey || !ROUTINES[routineKey]) {
                  server.logSystem(`${name} logged in but no routine assigned`);
                  return;
                }
                const stoppedState = getStoppedState(name);
                if (stoppedState) {
                  server.logSystem(`Bot ${name} was stopped intentionally (${stoppedState}), skipping auto-resume`);
                } else {
                  server.logSystem(`Auto-resuming ${name} with ${ROUTINES[routineKey].name}...`);
                  await handleStart({ type: "start", bot: name, routine: routineKey });
                }
              }).catch((err) => {
                server.logSystem(`Login failed for ${name}: ${err}`);
                refreshStatusTable();
              });
            }, loginDelay);
          }
        }).catch((err) => {
          server.logSystem(`Session resume failed for ${name}: ${err}`);
          refreshStatusTable();
        });
      }, delay);
    }
  }

  refreshStatusTable();

  // Load catalog data (fetch if stale, using first available bot session)
  if (!catalogStore.isStale()) {
    server.logSystem(`Catalog loaded from cache (${catalogStore.getSummary()})`);
  } else {
    server.logSystem("Catalog data is stale, will fetch after first bot login...");
  }

  // Periodic timers (store IDs for cleanup)
  const intervals: ReturnType<typeof setInterval>[] = [];

  // Periodic UI push (cached data → websocket clients)
  intervals.push(setInterval(() => {
    try {
      refreshStatusTable();
    } catch (err) {
      console.error('Error in periodic status update:', err);
    }
  }, 2000));

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
          if (bot.state === "running" && bot.api.getSession()) {
            refreshPromises.push(bot.refreshShip().catch(() => {}));
            refreshPromises.push(bot.refreshLocation().catch(() => {}));
            // Also do a lightweight notification check to keep session alive
            // Use bot.exec() instead of api.execute() to process notifications properly
            refreshPromises.push(bot.exec("get_notifications", { limit: 1, clear: true }).then((resp) => {
              if (resp.notifications && Array.isArray(resp.notifications) && resp.notifications.length > 0) {
                debugLogForBot(bot.username, "periodic:notifications", `Received ${resp.notifications.length} notification(s) during refresh`);
              }
            }).catch(() => {}));
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

  // Periodic get_status for running bots - every 2 minutes to keep credit data fresh
  // This ensures the web UI has current credit information for manual control pages
  intervals.push(setInterval(async () => {
    try {
      const statusPromises = [];
      let statusCount = 0;
      for (const [, bot] of bots) {
        if (bot.state === "running" && bot.api.getSession()) {
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
      if (bot.api.getSession()) {
        logSkills(bot);
      }
    }
  }, 60 * 1000));

  // Low-bandwidth session keep-alive: get_notifications every 40s for idle bots
  // This keeps sessions alive and fetches notifications without heavy API calls
  intervals.push(setInterval(async () => {
    try {
      const keepAlivePromises = [];
      let keepAliveCount = 0;
      for (const [name, bot] of bots) {
        // Only hit API for idle bots (not already doing heavy refresh)
        if (bot.state === "idle" && bot.api.getSession()) {
          // Use bot.exec() instead of api.execute() to process notifications properly
          keepAlivePromises.push(bot.exec("get_notifications", { limit: 1, clear: true }).then((resp) => {
            if (resp.notifications && Array.isArray(resp.notifications) && resp.notifications.length > 0) {
              debugLogForBot(name, "keepalive:notifications", `Received ${resp.notifications.length} notification(s) for idle bot`);
            }
          }).catch(() => {}));
          keepAliveCount++;
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
  intervals.push(setInterval(() => {
    server.updateMapData();
  }, 15000));

  // Periodic stats flush (every 60s)
  intervals.push(setInterval(() => {
    const statuses = [...bots.values()].map(b => b.status());
    server.flushBotStats(statuses);
  }, 60000));

  // Daily catalog refresh (24h)
  intervals.push(setInterval(async () => {
    // Check if stale OR server version changed
    let needsRefresh = catalogStore.isStale();
    if (!needsRefresh && bots.size > 0) {
      const firstBot = bots.values().next().value;
      if (firstBot?.api.getSession()) {
        needsRefresh = await catalogStore.checkVersionChanged(firstBot.api);
      }
    }
    if (!needsRefresh) return;
    // Find first bot with an active session
    for (const [, bot] of bots) {
      if (bot.api.getSession()) {
        try {
          await catalogStore.fetchAll(bot.api);
          server.logSystem(`Catalog refreshed (${catalogStore.getSummary()})`);
          refreshSkillNames();
        } catch (err) {
          server.logSystem(`Catalog refresh failed: ${err}`);
        }
        break;
      }
    }
  }, 24 * 60 * 60 * 1000));

  // Periodic ERROR state check - auto-restart bots that crashed
  intervals.push(setInterval(() => {
    for (const [name, bot] of bots) {
      if (bot.state === "error") {
        server.logSystem(`Detected ${name} in ERROR state, attempting auto-restart...`);
        handleAutoRestart(name);
      }
    }
  }, 30000));

  // Start HTTP + WebSocket server
  server.start();

  // Graceful shutdown handler
  function gracefulShutdown(signal: string, restart: boolean = false): void {
    console.log(`\nShutting down (${signal})...`);
    server.logSystem(`Server shutdown requested (${signal}${restart ? ", restart requested" : ""})`);
    // Clear intervals
    for (const id of intervals) clearInterval(id);
    // Flush stats before stopping bots
    const statuses = [...bots.values()].map(b => b.status());
    server.flushBotStats(statuses);
    // Stop all running bots
    for (const [, bot] of bots) {
      if (bot.state === "running") bot.stop();
    }
    // Stop AI Chat service
    if (aiChatService) {
      aiChatService.stop();
      aiChatService = null;
    }
    // Clear reconnection queue to release any pending reconnection attempts
    reconnectQueue.clear();
    // Flush persistent data
    mapStore.flush();
    catalogStore.flush();
    flushFactionStorageCache();
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
    chatServer.stop();
    
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

    // Exit with special code to signal watchdog to restart
    // Code 100 = restart requested, code 0 = normal shutdown
    process.exit(restart ? 100 : 0);
  }

  // Graceful shutdown on SIGINT (Ctrl+C) and SIGTERM (Windows/taskkill)
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

  // Expose shutdown function for web UI
  (globalThis as any).shutdownServer = gracefulShutdown;
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});


