/**
 * Process-wide IP rate-limit gate.
 *
 * The game server temporarily blocks an *IP* — not a single account — for
 * excessive command rate: "Your IP has been temporarily blocked due to
 * excessive rate limit violations. Try again in N seconds." Every bot in this
 * runner shares that IP, so when the block trips it applies to the WHOLE fleet
 * at once, and every command any bot fires while the block is live is rejected
 * (which only extends the block — the death spiral in the log: six
 * `find_route` failures in the same second, each "backing off 300s" while
 * nothing actually waited).
 *
 * The old handling slept inside one `libExec` call and then returned the error.
 * That papered over the problem instead of fixing it:
 *   - routines fan out commands concurrently (`Promise.all` batches), so N
 *     in-flight commands each hit the block and each slept on its OWN timer
 *     while the routine loop kept issuing new commands straight into the block;
 *   - the server's stated delay ("try again in N seconds") was ignored in favor
 *     of a private 30s-step counter up to 300s — logging one number while
 *     waiting for a different one;
 *   - worse, the library's own internal `rate_limited` retry re-sends after
 *     only ~1s (it can't parse "Try again in N seconds"), so each blocked
 *     command still produced several extra frames before we ever saw the error.
 *
 * This module is the fix: ONE shared gate that EVERY outbound command awaits
 * before sending (wired into `Bot.sendResilient`, the single chokepoint every
 * `account.send` funnels through). The first caller to see a block parses the
 * delay the server actually asked for and opens the gate for that long (bounded
 * by a 30s floor and a 5min ceiling, escalating per consecutive hit); every
 * other command — from any bot, in flight or newly issued — parks on the same
 * gate until it opens. A clean command from any bot eases the escalation back
 * to its base so normal operation resumes promptly.
 */

/** Never park shorter than this after a hit, even if the server reports less. */
const MIN_PENALTY_MS = 30_000;

/** Hard ceiling on any penalty (the escalating floor's cap). */
const MAX_PENALTY_MS = 300_000;

/** Extra floor added per consecutive hit, so repeated hits back off harder. */
const ESCALATION_STEP_MS = 30_000;

/** The floor's base value — restored after any clean command. */
const BASE_PENALTY_MS = 30_000;

/** Suppress repeat "gate closed" log lines within this window of each other. */
const LOG_SUPPRESS_MS = 15_000;

/** Epoch ms the gate opens at; 0/<= now means open. */
let gateUntil = 0;

/** Escalating floor (ms) applied when the server states no delay. */
let backoff = BASE_PENALTY_MS;

/** Last time a "gate closed" warning was allowed through (log dedupe). */
let lastLoggedAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True when an error (message OR `code`) indicates an IP/rate-limit block. */
export function isRateLimitError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "string" && /rate/i.test(code)) return true;
  const message = err instanceof Error ? err.message : String(err ?? "");
  return isRateLimitMessage(message);
}

/** True when an error message indicates an IP/rate-limit block. */
export function isRateLimitMessage(message?: string | null): boolean {
  if (!message) return false;
  return /excessive rate limit|temporarily blocked|rate.?limit|too many requests/i.test(message);
}

/**
 * Parse the retry delay the server asked for. Handles the live server's
 * "Try again in 30 seconds" phrasing, the library's "retry in N seconds", and
 * the "in 103 seconds" form. Returns milliseconds, or null when the message
 * states no usable delay.
 */
export function parseServerDelayMs(message?: string | null): number | null {
  if (!message) return null;
  const match = message.match(/(\d+)\s*s(?:ec|econd)/i);
  return match ? Number(match[1]) * 1000 : null;
}

/** Epoch ms the gate currently opens at (<= Date.now() means open). */
export function gateOpensAt(): number {
  return gateUntil;
}

/** True while the gate is closed — commands should be parked. */
export function gateIsClosed(): boolean {
  return gateUntil > Date.now();
}

/**
 * Park the caller until the gate opens. The deadline is re-read after every
 * wait, so a hit that extends the block while we are parked keeps us waiting
 * instead of resuming early.
 */
export async function waitForGate(): Promise<void> {
  for (;;) {
    const remaining = gateUntil - Date.now();
    if (remaining <= 0) return;
    await sleep(remaining);
  }
}

/**
 * Record a rate-limit/IP-block failure. Opens the gate for the longest of the
 * server's stated delay and the current escalating floor (clamped to
 * [30s, 5min]), escalates the floor for the next hit, and returns the penalty
 * (ms) that was applied. Never shortens a gate that is already open for longer.
 */
export function reportRateLimitHit(message?: string | null): number {
  const now = Date.now();
  const serverMs = parseServerDelayMs(message);
  let penalty = backoff;
  if (serverMs !== null) penalty = Math.max(penalty, serverMs);
  penalty = Math.min(Math.max(penalty, MIN_PENALTY_MS), MAX_PENALTY_MS);

  backoff = Math.min(backoff + ESCALATION_STEP_MS, MAX_PENALTY_MS);
  gateUntil = Math.max(gateUntil, now + penalty);
  return penalty;
}

/** A command completed cleanly — ease the escalation back to its base. */
export function reportCleanSend(): void {
  backoff = BASE_PENALTY_MS;
}

/**
 * True at most once per LOG_SUPPRESS_MS window, so a burst of failing commands
 * logs ONE "gate closed" line instead of the old six-identical-warnings-per-
 * second spam. First caller wins the slot; everyone else stays quiet.
 */
export function shouldLogGateClosed(): boolean {
  const now = Date.now();
  if (now - lastLoggedAt < LOG_SUPPRESS_MS) return false;
  lastLoggedAt = now;
  return true;
}
