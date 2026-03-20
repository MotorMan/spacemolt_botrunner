import { existsSync, readdirSync, appendFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { Bot, type Routine } from "./bot.js";
import { SessionManager } from "./session.js";
import { minerRoutine } from "./routines/miner.js";
import { explorerRoutine } from "./routines/explorer.js";
import { crafterRoutine } from "./routines/crafter.js";
import { rescueRoutine, fuelTransferRoutine, manualPlayerRescueRoutine, maydayRescueRoutine } from "./routines/rescue.js";
import { coordinatorRoutine } from "./routines/coordinator.js";
import { traderRoutine } from "./routines/trader.js";
import { gasHarvesterRoutine } from "./routines/gas_harvester.js";
import { iceHarvesterRoutine } from "./routines/ice_harvester.js";
import { salvagerRoutine } from "./routines/salvager.js";
import { hunterRoutine } from "./routines/hunter.js";
import { factionTraderRoutine } from "./routines/faction_trader.js";
import { tradeBuyerRoutine } from "./routines/trade_buyer.js";
import { cleanupRoutine } from "./routines/cleanup.js";
import { aiRoutine } from "./routines/ai.js";
import { cargoMoverRoutine } from "./routines/cargo_mover.js";
import { returnHomeRoutine } from "./routines/return_home.js";
import { commandReceiverRoutine } from "./routines/command_receiver.js";
import { mapStore } from "./mapstore.js";
import { catalogStore } from "./catalogstore.js";
import { WebServer, type WebAction, type WebActionResult, loadSettings } from "./web/server.js";
import { setLogSink } from "./ui.js";
import { debugLog } from "./debug.js";
import { reconnectQueue } from "./reconnectqueue.js";
import { serverDisconnectDetector } from "./serverdisconnectdetector.js";
import { AiChatService } from "./aichat_service.js";

interface BotState {
  wasRunning: boolean;
  routine: string | null;
}

const BASE_DIR = process.cwd();
const SESSIONS_DIR = join(BASE_DIR, "sessions");

const bots: Map<string, Bot> = new Map();
let server: WebServer;
let aiChatService: AiChatService | null = null;

/** Get list of discovered bot usernames (for API use). */
export function getDiscoveredBots(): string[] {
  return [...bots.keys()];
}

const ROUTINES: Record<string, { name: string; fn: Routine }> = {
  miner: { name: "Miner", fn: minerRoutine },
  explorer: { name: "Explorer", fn: explorerRoutine },
  crafter: { name: "Crafter", fn: crafterRoutine },
  rescue: { name: "FuelRescue", fn: rescueRoutine },
  fuel_transfer: { name: "FuelTransfer", fn: fuelTransferRoutine },
  manual_rescue: { name: "ManualRescue", fn: manualPlayerRescueRoutine },
  mayday: { name: "MaydayRescue", fn: maydayRescueRoutine },
  coordinator: { name: "Coordinator", fn: coordinatorRoutine },
  trader: { name: "Trader", fn: traderRoutine },
  gas_harvester: { name: "GasHarvester", fn: gasHarvesterRoutine },
  ice_harvester: { name: "IceHarvester", fn: iceHarvesterRoutine },
  salvager: { name: "Salvager", fn: salvagerRoutine },
  hunter: { name: "Hunter", fn: hunterRoutine },
  faction_trader: { name: "FactionTrader", fn: factionTraderRoutine },
  trade_buyer: { name: "TradeBuyer", fn: tradeBuyerRoutine },
  cleanup: { name: "Cleanup", fn: cleanupRoutine },
  ai: { name: "AI", fn: aiRoutine },
  cargo_mover: { name: "CargoMover", fn: cargoMoverRoutine },
  return_home: { name: "ReturnHome", fn: returnHomeRoutine },
  command_receiver: { name: "CommandReceiver", fn: commandReceiverRoutine },
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
      // Register with server disconnect detector
      serverDisconnectDetector.registerBot({
        name: bot.username,
        api: bot.api,
        credentials: bot.session.loadCredentials(),
      });
    }
  }
}

/** Categories that go to the broadcast panel instead of bot log. */
const BROADCAST_CATEGORIES = new Set(["broadcast", "chat", "dm"]);

const LOGS_DIR = join(BASE_DIR, "data", "logs");

/** Append a line to a bot's persistent log file (data/logs/{username}.log). */
function appendBotLog(username: string, line: string): void {
  try {
    if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
    appendFileSync(join(LOGS_DIR, `${username}.log`), line + "\n");
  } catch { /* ignore write errors */ }
}

function setupBotLogging(bot: Bot): void {
  bot.onLog = (username, category, message) => {
    const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false });
    const datestamp = new Date().toISOString().slice(0, 10);
    const line = `${timestamp} [${username}] [${category}] ${message}`;
    debugLog("bot:onLog", `${username} cat=${category}`, message);
    if (category === "system" || category === "error") {
      server.logSystem(line);
    }
    server.logActivity(line);
    // Per-bot log for profile page activity log
    const botLine = `${timestamp} [${category}] ${message}`;
    server.logBot(username, botLine);
    // Persistent per-bot log file
    appendBotLog(username, `${datestamp} ${botLine}`);
  };
  bot.onFactionLog = (_username, line) => {
    server.logFaction(line);
  };
}

function refreshStatusTable(): void {
  const statuses = [...bots.values()].map((b) => b.status());
  server.updateBotStatus(statuses);
}

// ── Action handlers ─────────────────────────────────────────

async function handleAction(action: WebAction): Promise<WebActionResult> {
  switch (action.type) {
    case "start":
      return handleStart(action);
    case "stop":
      return handleStop(action);
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

  server.saveRoutineSettings(routine, s);
  server.logSystem(`Settings saved for ${routine}`);
  return { ok: true, message: `${routine} settings saved`, settings: server.settings };
}

async function handleStart(action: WebAction): Promise<WebActionResult> {
  const botName = action.bot;
  if (!botName) return { ok: false, error: "No bot specified" };

  const bot = bots.get(botName);
  if (!bot) return { ok: false, error: `Bot not found: ${botName}` };
  if (bot.state === "running") return { ok: false, error: `${botName} is already running` };

  const routineKey = action.routine || "miner";
  const routine = ROUTINES[routineKey];
  if (!routine) return { ok: false, error: `Unknown routine: ${routineKey}` };

  server.logSystem(`Starting ${bot.username} with ${routine.name} routine...`);

  // Store routine parameters on bot object if provided (for manual_rescue etc.)
  if (action.params) {
    (bot as unknown as Record<string, unknown>).routineParams = action.params;
  }

  const startOpts = (routineKey === "rescue" || routineKey === "coordinator")
    ? { getFleetStatus: () => [...bots.values()].map(b => b.status()) }
    : undefined;

  bot.start(routineKey, routine.fn, startOpts).then(() => {
    server.logSystem(`Bot ${bot.username} routine finished.`);
    server.clearBotAssignment(botName);
    // Clear params after routine completes
    (bot as unknown as Record<string, unknown>).routineParams = undefined;
  }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    server.logSystem(`Bot ${bot.username} stopped with error: ${msg}`);
    server.clearBotAssignment(botName);
    // Clear params after error
    (bot as unknown as Record<string, unknown>).routineParams = undefined;
  });

  server.saveBotAssignment(botName, routineKey);

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
  server.logSystem(`Stop signal sent to ${bot.username}`);
  return { ok: true, message: `Stop signal sent to ${botName}` };
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
    
    bot.start(routineKey, routine.fn, undefined).then(() => {
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
  // Unregister from server disconnect detector
  serverDisconnectDetector.unregisterBot(botName);
  server.clearBotAssignment(botName);
  server.removePerBotSettings(botName);

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
  // Register with server disconnect detector
  serverDisconnectDetector.registerBot({
    name: bot.username,
    api: bot.api,
    credentials: { username, password },
  });

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
  // Register with server disconnect detector
  serverDisconnectDetector.registerBot({
    name: bot.username,
    api: bot.api,
    credentials: { username, password },
  });
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

  debugLog("exec:handler", `${botName} > ${command}`, params);
  let resp = await bot.exec(command, params);

  // Refresh cached state after mutating commands
  const refreshCommands = new Set([
    "mine", "sell", "buy", "dock", "undock", "travel", "jump",
    "refuel", "repair", "deposit_items", "withdraw_items", "jettison",
    "attack", "loot_wreck", "salvage_wreck", "send_gift", "craft",
    "accept_mission", "complete_mission", "abandon_mission",
    "buy_ship", "sell_ship", "switch_ship", "install_mod", "uninstall_mod", "set_colors",
  ]);
  if (refreshCommands.has(command)) {
    await bot.refreshStatus();

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
      case "faction_deposit_items": {
        const itemId = p?.item_id as string | undefined;
        const qty = p?.quantity as number | undefined;
        if (itemId) server.logFaction(`${timestamp} [deposit] ${botName}: Deposited ${qty || 1}x ${itemId} to faction storage`);
        break;
      }
      case "faction_withdraw_items": {
        const itemId = p?.item_id as string | undefined;
        const qty = p?.quantity as number | undefined;
        if (itemId) server.logFaction(`${timestamp} [withdraw] ${botName}: Withdrew ${qty || 1}x ${itemId} from faction storage`);
        break;
      }
    }
  }

  if (resp.error) {
    debugLog("exec:result", `${botName} > ${command} ERROR`, { error: resp.error.message, hasResult: resp.result !== undefined });
    return { ok: false, error: resp.error.message, data: resp.result };
  }

  debugLog("exec:result", `${botName} > ${command} OK`, { hasResult: resp.result !== undefined, resultType: typeof resp.result });
  return { ok: true, message: `${command} executed`, data: resp.result };
}

// ── Main ────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Load port from settings.json (general.port), env var, or default to 3000
  const settings = loadSettings();
  const port = parseInt(process.env.PORT || String(settings.general?.port || 3000), 10);
  server = new WebServer(port);
  server.routines = Object.keys(ROUTINES);
  server.onAction = handleAction;
  server.onShutdown = async () => {
    (globalThis as any).shutdownServer("web-ui");
  };

  // Route global ui.log() calls through the web server
  setLogSink((category, message) => {
    const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false });
    debugLog("sink:route", `category=${category}`, message);
    if (BROADCAST_CATEGORIES.has(category)) {
      const tagMatch = message.match(/^\[([^\]]+)\]\s*(.*)/s);
      if (tagMatch) {
        const [, tag, content] = tagMatch;
        debugLog("sink:broadcast", `tag=${tag}`, content);
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
      debugLog("sink:system", "error routed to system panel", line);
      server.logSystem(line);
    }
    debugLog("sink:activity", "routed to bot log", line);
    server.logActivity(line);
  });

  // Initialize and start AI Chat service
  aiChatService = new AiChatService((category, message) => {
    const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false });
    const line = `${timestamp} [AI_CHAT] [${category}] ${message}`;
    server.logSystem(line);
  });
  AiChatService.setGetBotsFn(() => [...bots.values()]);
  aiChatService.start();
  // Expose on globalThis for bot.ts to access
  (globalThis as any).aiChatService = aiChatService;
  server.logSystem("AI Chat service initialized");

  // Set up server-wide disconnect detection callback
  serverDisconnectDetector.onServerDown({
    stopBots: async (affectedBots: string[]) => {
      server.logSystem(`Server disconnect detected affecting ${affectedBots.length} bot(s): ${affectedBots.join(", ")}`);
      const botStates = new Map<string, BotState>();

      // Save state of all bots and stop running ones
      for (const [, bot] of bots) {
        const assignments = server.getBotAssignments();
        botStates.set(bot.username, {
          wasRunning: bot.state === "running",
          routine: assignments[bot.username] || null,
        });

        if (bot.state === "running") {
          bot.stop();
          server.logSystem(`Stopped ${bot.username} during server reconnection`);
        }
      }

      return botStates;
    },
    restartBots: async (botStates: Map<string, BotState>) => {
      const assignments = server.getBotAssignments();
      let restartedCount = 0;
      const BOT_RESTART_DELAY_MS = 25000; // CRITICAL: 25s delay between bot restarts to prevent login rate limiting

      // Convert to array and process with delays - filter ensures routine is not null
      const botsToRestart = [...botStates.entries()]
        .filter(([_, state]) => state.wasRunning && state.routine !== null) as Array<[string, BotState & { routine: string }]>;

      for (let i = 0; i < botsToRestart.length; i++) {
        const [botName, state] = botsToRestart[i];
        const routine = ROUTINES[state.routine];

        if (!routine) {
          server.logSystem(`Skipping ${botName}: routine ${state.routine} no longer exists`);
          continue;
        }

        // CRITICAL: Delay before each bot restart (except first) - prevents login storm
        if (i > 0) {
          server.logSystem(`Waiting ${BOT_RESTART_DELAY_MS / 1000}s before restarting ${botName}...`);
          await new Promise(r => setTimeout(r, BOT_RESTART_DELAY_MS));
        }

        server.logSystem(`Restarting ${botName} with ${routine.name} routine...`);

        const bot = bots.get(botName);
        if (!bot) continue;

        // Start routine immediately after login - gameplay commands don't have the same rate limits as login
        bot.start(state.routine, routine.fn).then(() => {
          server.logSystem(`Bot ${botName} routine finished.`);
          server.clearBotAssignment(botName);
        }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          server.logSystem(`Bot ${botName} stopped with error: ${msg}`);
          server.clearBotAssignment(botName);
        });

        server.saveBotAssignment(botName, state.routine);
        restartedCount++;
      }

      server.logSystem(`Restarted ${restartedCount} bot(s) with their saved routines`);
    },
  });

  server.logSystem("SpaceMolt Bot Manager v0.2");
  server.logSystem("Loading saved sessions...");

  discoverBots();

  // Seed galaxy map from public API so pathfinding works from first run
  server.logSystem("Seeding galaxy map from /api/map...");
  mapStore.seedFromMapAPI().then(({ seeded, known, failed }) => {
    if (failed) {
      server.logSystem("Galaxy map seed failed — will rely on exploration data");
    } else {
      server.logSystem(`Galaxy map seeded: ${seeded} new system(s), ${known} already known`);
    }
  }).catch(() => {
    server.logSystem("Galaxy map seed failed — will rely on exploration data");
  });

  if (bots.size > 0) {
    const assignments = server.getBotAssignments();
    server.logSystem(`Found ${bots.size} saved bot(s): ${[...bots.keys()].join(", ")}`);
    // Push initial bot list to UI immediately (shows as "idle" with default values)
    refreshStatusTable();

    // Session resume is fast (1s delay), full login requires rate limiting (25s delay)
    const SESSION_RESUME_DELAY_MS = 1000;
    const FULL_LOGIN_DELAY_MS = 25000;
    let botIndex = 0;

    for (const [name, bot] of bots) {
      const delay = botIndex * SESSION_RESUME_DELAY_MS;
      botIndex++;
      setTimeout(() => {
        // Try session resume first (fast, no rate limit)
        bot.resumeSession().then(async (ok) => {
          refreshStatusTable();
          if (ok) {
            server.logSystem(`${name} session resumed (no login delay)`);
            // Session resumed, start routine if assigned
            const routineKey = assignments[name];
            if (routineKey && ROUTINES[routineKey]) {
              server.logSystem(`Auto-resuming ${name} with ${ROUTINES[routineKey].name}...`);
              await handleStart({ type: "start", bot: name, routine: routineKey });
            }
            return;
          }

          // Session resume failed, need full login with rate-limited delay
          server.logSystem(`${name} session expired, scheduling full login...`);
          const loginDelay = botIndex * FULL_LOGIN_DELAY_MS;
          setTimeout(() => {
            bot.login().then(async (loginOk) => {
              refreshStatusTable();
              if (!loginOk) return;
              // Fetch catalog data if stale (first logged-in bot triggers it)
              if (catalogStore.isStale()) {
                try {
                  await catalogStore.fetchAll(bot.api);
                  server.logSystem(`Catalog fetched (${catalogStore.getSummary()})`);
                } catch (err) {
                  server.logSystem(`Catalog fetch failed: ${err}`);
                }
              }
              const routineKey = assignments[name];
              if (!routineKey || !ROUTINES[routineKey]) return;
              server.logSystem(`Auto-resuming ${name} with ${ROUTINES[routineKey].name}...`);
              await handleStart({ type: "start", bot: name, routine: routineKey });
            }).catch((err) => {
              server.logSystem(`Login failed for ${name}: ${err}`);
              refreshStatusTable();
            });
          }, loginDelay);
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
    refreshStatusTable();
  }, 2000));

  // Periodic live refresh (hit API for all logged-in bots)
  intervals.push(setInterval(async () => {
    for (const [, bot] of bots) {
      if (bot.api.getSession()) {
        await bot.refreshStatus().catch(() => {});
      }
    }
    refreshStatusTable();
  }, 30000));

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
    if (!catalogStore.isStale()) return;
    // Find first bot with an active session
    for (const [, bot] of bots) {
      if (bot.api.getSession()) {
        try {
          await catalogStore.fetchAll(bot.api);
          server.logSystem(`Catalog refreshed (${catalogStore.getSummary()})`);
        } catch (err) {
          server.logSystem(`Catalog refresh failed: ${err}`);
        }
        break;
      }
    }
  }, 24 * 60 * 60 * 1000));

  // Start HTTP + WebSocket server
  server.start();

  // Graceful shutdown handler
  function gracefulShutdown(signal: string): void {
    console.log(`\nShutting down (${signal})...`);
    server.logSystem(`Server shutdown requested (${signal})`);
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
    // Reset server disconnect detector
    serverDisconnectDetector.reset();
    // Flush persistent data
    mapStore.flush();
    catalogStore.flush();
    server.stop();
    process.exit(0);
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


