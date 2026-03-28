import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const BASE_DIR = process.cwd();
const LOG_FILE = join(BASE_DIR, "data", "sessionDebug.log");

// Ensure log directory exists
if (!existsSync(join(BASE_DIR, "data"))) {
  mkdirSync(join(BASE_DIR, "data"), { recursive: true });
}

/** Write a line to the session debug log */
export function logSession(message: string): void {
  const timestamp = new Date().toISOString();
  const line = `${timestamp} ${message}\n`;
  try {
    appendFileSync(LOG_FILE, line, "utf-8");
  } catch (err) {
    // Silently ignore log write errors
  }
}

/** Log session creation/renewal with full response details */
export function logSessionCreate(
  botName: string,
  sessionId: string,
  expiresAt: string,
  source: "initial" | "renewal" | "recovery" | "v2",
  response?: unknown
): void {
  logSession(
    `[CREATE] ${botName} - Session ${sessionId.slice(0, 8)}... created (${source})` +
    ` | expires: ${expiresAt}` +
    (response ? ` | response: ${JSON.stringify(response)}` : "")
  );
}

/** Log session invalidation with reason */
export function logSessionInvalidate(
  botName: string,
  reason: string,
  errorCode?: string,
  errorMessage?: string,
  oldSessionId?: string
): void {
  logSession(
    `[INVALIDATE] ${botName} - Session ${oldSessionId?.slice(0, 8) || "unknown"} invalidated` +
    ` | reason: ${reason}` +
    (errorCode ? ` | code: ${errorCode}` : "") +
    (errorMessage ? ` | message: ${errorMessage}` : "")
  );
}

/** Log session state change */
export function logSessionChange(
  botName: string,
  fromSessionId: string | null,
  toSessionId: string,
  reason: string
): void {
  logSession(
    `[CHANGE] ${botName} - Session changed` +
    ` | from: ${fromSessionId?.slice(0, 8) || "null"}` +
    ` | to: ${toSessionId.slice(0, 8)}...` +
    ` | reason: ${reason}`
  );
}

/** Log API command that returned session error */
export function logSessionError(
  botName: string,
  command: string,
  payload: unknown,
  errorCode: string,
  errorMessage: string,
  fullResponse: unknown
): void {
  logSession(
    `[ERROR] ${botName} - Command "${command}" returned session error` +
    ` | code: ${errorCode}` +
    ` | message: ${errorMessage}` +
    ` | payload: ${JSON.stringify(payload)}` +
    ` | fullResponse: ${JSON.stringify(fullResponse)}`
  );
}

/** Log session check result */
export function logSessionCheck(
  botName: string,
  hasSession: boolean,
  sessionId: string | null,
  expiresAt: string | null,
  timeRemaining?: number
): void {
  logSession(
    `[CHECK] ${botName} - Session status` +
    ` | hasSession: ${hasSession}` +
    ` | id: ${sessionId?.slice(0, 8) || "none"}` +
    ` | expiresAt: ${expiresAt || "none"}` +
    (timeRemaining !== undefined ? ` | timeRemaining: ${timeRemaining}s` : "")
  );
}

/** Log renewal cooldown status */
export function logRenewalCooldown(
  botName: string,
  timeSinceLastRenewal: number,
  cooldownMs: number,
  allowed: boolean
): void {
  logSession(
    `[COOLDOWN] ${botName} - Renewal check` +
    ` | timeSinceLast: ${Math.round(timeSinceLastRenewal / 1000)}s` +
    ` | cooldown: ${cooldownMs / 1000}s` +
    ` | allowed: ${allowed}`
  );
}

/** Log periodic renewal queue processing */
export function logRenewalQueue(
  botName: string,
  queuePosition: number,
  queueLength: number,
  success: boolean,
  error?: string
): void {
  logSession(
    `[QUEUE] ${botName} - Renewal queue processed` +
    ` | position: ${queuePosition}/${queueLength}` +
    ` | success: ${success}` +
    (error ? ` | error: ${error}` : "")
  );
}

/** Log session restore from disk */
export function logSessionRestore(
  botName: string,
  sessionId: string,
  loaded: boolean,
  error?: string
): void {
  logSession(
    `[RESTORE] ${botName} - Session restore from disk` +
    ` | id: ${sessionId.slice(0, 8)}...` +
    ` | loaded: ${loaded}` +
    (error ? ` | error: ${error}` : "")
  );
}

/** Log session save to disk */
export function logSessionSave(
  botName: string,
  sessionId: string,
  v2SessionId?: string | null
): void {
  logSession(
    `[SAVE] ${botName} - Session saved to disk` +
    ` | id: ${sessionId.slice(0, 8)}...` +
    (v2SessionId ? ` | v2: ${v2SessionId.slice(0, 8)}...` : "")
  );
}

/** Generic detailed session log */
export function logSessionDetail(
  botName: string,
  category: string,
  message: string,
  details?: Record<string, unknown>
): void {
  const detailStr = details ? ` | ${JSON.stringify(details)}` : "";
  logSession(`[${category}] ${botName} - ${message}${detailStr}`);
}
