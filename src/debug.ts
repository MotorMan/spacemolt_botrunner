import { appendFileSync, mkdirSync, existsSync, statSync, renameSync } from "fs";
import { join } from "path";

const DATA_DIR = join(process.cwd(), "data");
const LOGS_DIR = join(DATA_DIR, "logs");
const ACTIVITY_LOGS_DIR = join(LOGS_DIR, "activity");
const GLOBAL_LOG_FILE = join(LOGS_DIR, "debug.log");
const OLD_LOGS_DIR = join(process.cwd(), "old-logs");
const OLD_ACTIVITY_LOGS_DIR = join(OLD_LOGS_DIR, "activity");

const LOG_ROTATION_SIZE = 50 * 1024 * 1024;  // 50MB rotation threshold

// Ensure directories exist once at module load
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}
if (!existsSync(LOGS_DIR)) {
  mkdirSync(LOGS_DIR, { recursive: true });
}
if (!existsSync(ACTIVITY_LOGS_DIR)) {
  mkdirSync(ACTIVITY_LOGS_DIR, { recursive: true });
}
if (!existsSync(OLD_LOGS_DIR)) {
  mkdirSync(OLD_LOGS_DIR, { recursive: true });
}
if (!existsSync(OLD_ACTIVITY_LOGS_DIR)) {
  mkdirSync(OLD_ACTIVITY_LOGS_DIR, { recursive: true });
}

let debugEnabled = true;
let activityEnabled = true;
let combatDebugEnabled = false;

export function setCombatDebugLog(on: boolean): void {
  combatDebugEnabled = on;
}

export function getCombatDebugLog(): boolean {
  return combatDebugEnabled;
}

export function shouldCombatDebugLog(botName: string): boolean {
  return combatDebugEnabled;
}

/**
 * Write raw combat JSON to data/logs/{botName}_combat_debug.log
 * No filtering — dumps the entire object as-is for post-battle analysis.
 */
export function combatDebugLog(botName: string, source: string, data: unknown): void {
  if (!shouldCombatDebugLog(botName)) return;
  const timestamp = new Date().toISOString();
  let line = `${timestamp} [${source}] `;
  try {
    line += JSON.stringify(data);
  } catch {
    line += "[unserializable]";
  }
  line += "\n";
  try {
    const botLogFile = join(LOGS_DIR, `${botName}_combat_debug.log`);
    appendFileSync(botLogFile, line);
  } catch {
    // ignore write errors
  }
}

/**
 * Write raw combat JSON to data/logs/{botName}_combat_debug.log
 * Auto-resolves botName from settings when only a username is provided.
 */
export function combatDebugLogForBot(username: string, source: string, data: unknown): void {
  combatDebugLog(username, source, data);
}

/**
 * Write a plain combat debug line to data/logs/{botName}_combat_debug.log
 */
export function combatDebugLogLine(botName: string, line: string): void {
  if (!shouldCombatDebugLog(botName)) return;
  const timestamp = new Date().toISOString();
  const fullLine = `${timestamp} ${line}\n`;
  try {
    const botLogFile = join(LOGS_DIR, `${botName}_combat_debug.log`);
    appendFileSync(botLogFile, fullLine);
  } catch {
    // ignore write errors
  }
}

function shouldRotateLog(logPath: string): boolean {
  if (!existsSync(logPath)) return false;
  try {
    const stats = statSync(logPath);
    return stats.size >= LOG_ROTATION_SIZE;
  } catch {
    return false;
  }
}

function rotateBotLog(botName: string): void {
  const botLogFile = join(LOGS_DIR, `${botName}_debug.log`);
  
  if (shouldRotateLog(botLogFile)) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const rotatedPath = join(OLD_LOGS_DIR, `${botName}_debug_${timestamp}.log`);
    try {
      renameSync(botLogFile, rotatedPath);
    } catch { /* ignore */ }
  }
}

export function setDebugLog(on: boolean): void {
  debugEnabled = on;
}

export function setActivityLog(on: boolean): void {
  activityEnabled = on;
}

/**
 * Write to the global debug log (legacy behavior).
 * @deprecated Use debugLogForBot instead for per-bot logging.
 */
export function debugLog(source: string, message: string, data?: unknown): void {
  if (!debugEnabled) return;
  const timestamp = new Date().toISOString();
  let line = `${timestamp} [${source}] ${message}`;
  if (data !== undefined) {
    try {
      line += " " + JSON.stringify(data);
    } catch {
      line += " [unserializable]";
    }
  }
  line += "\n";
  try {
    appendFileSync(GLOBAL_LOG_FILE, line);
  } catch {
    // ignore write errors
  }
}

/**
 * Write to a specific bot's debug log file.
 * This creates per-bot log files in data/logs/{botName}_debug.log
 */
export function debugLogForBot(botName: string, source: string, message: string, data?: unknown): void {
  if (!debugEnabled) return;
  const timestamp = new Date().toISOString();
  let line = `${timestamp} [${source}] ${message}`;
  if (data !== undefined) {
    try {
      line += " " + JSON.stringify(data);
    } catch {
      line += " [unserializable]";
    }
  }
  line += "\n";
  try {
    const botLogFile = join(LOGS_DIR, `${botName}_debug.log`);
    appendFileSync(botLogFile, line);
    rotateBotLog(botName);
  } catch {
    // ignore write errors
  }
}

/**
 * Write to a specific bot's activity log file.
 * This creates compact, human/LLM-readable activity logs in data/logs/activity/{botName}_activity.log
 * Designed for song lyric generation - contains only the essential activity information.
 */
export function logBotActivity(botName: string, category: string, message: string): void {
  if (!activityEnabled) return;
  const timestamp = new Date().toISOString();
  const line = `${timestamp} [${botName}] [${category}] ${message}\n`;
  try {
    const botLogFile = join(ACTIVITY_LOGS_DIR, `${botName}_activity.log`);
    appendFileSync(botLogFile, line);
    if (shouldRotateLog(botLogFile)) {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const rotatedPath = join(OLD_ACTIVITY_LOGS_DIR, `${botName}_activity_${ts}.log`);
      try {
        renameSync(botLogFile, rotatedPath);
      } catch { /* ignore rotation errors */ }
    }
  } catch {
    // ignore write errors
  }
}
