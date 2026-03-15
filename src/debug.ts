import { appendFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const DATA_DIR = join(process.cwd(), "data");
const LOG_FILE = join(DATA_DIR, "debug.log");
const COMMANDS_LOG = join(DATA_DIR, "debugCommands.log");

// Ensure data directory exists once at module load
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

let enabled = true;

export function setDebugLog(on: boolean): void {
  enabled = on;
}

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
  
  // Route command-related logs to debugCommands.log
  const isCommandLog = source === "bot:exec" || source === "bot:response";
  const targetFile = isCommandLog ? COMMANDS_LOG : LOG_FILE;
  
  try {
    appendFileSync(targetFile, line);
  } catch {
    // ignore write errors
  }
}
