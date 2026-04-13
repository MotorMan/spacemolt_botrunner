import { appendFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const DATA_DIR = join(process.cwd(), "data");
const LOGS_DIR = join(DATA_DIR, "logs");
const ACTIVITY_LOGS_DIR = join(LOGS_DIR, "activity");
const GLOBAL_LOG_FILE = join(LOGS_DIR, "debug.log");

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

let enabled = true;

export function setDebugLog(on: boolean): void {
  enabled = on;
}

/**
 * Write to the global debug log (legacy behavior).
 * @deprecated Use debugLogForBot instead for per-bot logging.
 */
export function debugLog(source: string, message: string, data?: unknown): void {
  if (!enabled) return;
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
  if (!enabled) return;
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
  if (!enabled) return;
  const timestamp = new Date().toISOString();
  const line = `${timestamp} [${botName}] [${category}] ${message}\n`;
  try {
    const botLogFile = join(ACTIVITY_LOGS_DIR, `${botName}_activity.log`);
    appendFileSync(botLogFile, line);
  } catch {
    // ignore write errors
  }
}
