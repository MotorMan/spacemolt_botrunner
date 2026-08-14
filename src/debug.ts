import { appendFileSync, mkdirSync, existsSync, statSync, renameSync } from "fs";
import { appendFile } from "fs/promises";
import { join } from "path";
import { perf } from "./perf.js";

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

// ── Buffered log writer ───────────────────────────────────────────────────
// Every log line used to cost an `appendFileSync` (plus an `existsSync` and a
// `statSync` for rotation) on the main thread. With 90+ bots that is thousands
// of blocking syscalls a second. Lines are now batched per file and written
// asynchronously a few times a second; rotation is decided from a running byte
// count and only stats a file once.

/** How often buffered lines are written out. */
const LOG_FLUSH_INTERVAL_MS = 250;
/** Force a flush when this much text is queued, so bursts can't balloon RAM. */
const LOG_FLUSH_MAX_BYTES = 1024 * 1024;

interface RotationSpec {
  /** Directory rotated files are moved into. */
  dir: string;
  /** File name prefix, e.g. `Bob_debug`. */
  prefix: string;
}

interface LogSink {
  lines: string[];
  bytes: number;
  /** Approximate on-disk size, seeded from one stat and kept updated. */
  fileBytes: number;
  sized: boolean;
  rotate: RotationSpec | null;
}

const sinks = new Map<string, LogSink>();
let queuedBytes = 0;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let flushing = false;

function getSink(path: string, rotate: RotationSpec | null): LogSink {
  let sink = sinks.get(path);
  if (!sink) {
    sink = { lines: [], bytes: 0, fileBytes: 0, sized: false, rotate };
    sinks.set(path, sink);
  }
  return sink;
}

function enqueueLine(path: string, line: string, rotate: RotationSpec | null): void {
  const sink = getSink(path, rotate);
  sink.lines.push(line);
  sink.bytes += line.length;
  queuedBytes += line.length;
  if (!flushTimer) {
    flushTimer = setInterval(() => void flushLogs(), LOG_FLUSH_INTERVAL_MS);
    (flushTimer as unknown as { unref?: () => void }).unref?.();
  }
  if (queuedBytes >= LOG_FLUSH_MAX_BYTES) void flushLogs();
}

function rotateIfNeeded(path: string, sink: LogSink): void {
  if (!sink.rotate || sink.fileBytes < LOG_ROTATION_SIZE) return;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rotatedPath = join(sink.rotate.dir, `${sink.rotate.prefix}_${timestamp}.log`);
  try {
    renameSync(path, rotatedPath);
    sink.fileBytes = 0;
  } catch {
    // Rotation is best-effort; keep appending to the current file.
    sink.fileBytes = 0;
  }
}

/** Write every buffered line. Never throws. */
export async function flushLogs(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    for (const [path, sink] of sinks) {
      if (sink.lines.length === 0) continue;
      const text = sink.lines.join("");
      queuedBytes -= sink.bytes;
      sink.lines = [];
      sink.bytes = 0;
      if (!sink.sized) {
        sink.sized = true;
        try {
          sink.fileBytes = existsSync(path) ? statSync(path).size : 0;
        } catch {
          sink.fileBytes = 0;
        }
      }
      try {
        await appendFile(path, text);
        sink.fileBytes += text.length;
        rotateIfNeeded(path, sink);
      } catch {
        // ignore write errors (disk full, file locked, ...)
      }
    }
    if (queuedBytes < 0) queuedBytes = 0;
  } finally {
    flushing = false;
  }
}

/** Blocking flush, for shutdown / exit handlers. */
export function flushLogsSync(): void {
  for (const [path, sink] of sinks) {
    if (sink.lines.length === 0) continue;
    const text = sink.lines.join("");
    sink.lines = [];
    sink.bytes = 0;
    try {
      appendFileSync(path, text);
    } catch {
      // ignore write errors
    }
  }
  queuedBytes = 0;
}

process.on("exit", () => flushLogsSync());

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
  enqueueLine(join(LOGS_DIR, `${botName}_combat_debug.log`), line, null);
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
  enqueueLine(join(LOGS_DIR, `${botName}_combat_debug.log`), `${timestamp} ${line}\n`, null);
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
  enqueueLine(GLOBAL_LOG_FILE, line, { dir: OLD_LOGS_DIR, prefix: "debug" });
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
  perf.timeSync("debug.appendLine", () => {
    enqueueLine(
      join(LOGS_DIR, `${botName}_debug.log`),
      line,
      { dir: OLD_LOGS_DIR, prefix: `${botName}_debug` },
    );
  });
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
  perf.timeSync("debug.appendLine", () => {
    enqueueLine(
      join(ACTIVITY_LOGS_DIR, `${botName}_activity.log`),
      line,
      { dir: OLD_ACTIVITY_LOGS_DIR, prefix: `${botName}_activity` },
    );
  });
}
