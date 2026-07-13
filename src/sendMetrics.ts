/**
 * Lightweight, read-only outbound command metrics.
 *
 * This module does NOT throttle, delay, or gate anything. `Bot.instrumentSend()`
 * installs a measurement-only shim over the library `Account.send`, so every
 * command — both `Bot.libExec` and the direct `bot.commands.spacemolt.*()` calls
 * the routines make — is timed through `measureSend()` here. We record:
 *   - per-command round-trip latency,
 *   - live in-flight concurrency (how many sends are outstanding at once), and
 *   - error counts bucketed by category (closed socket / timeout / rate limited).
 *
 * The point is to find the real per-client player ceiling empirically: run more
 * and more players and watch where latency climbs and `closed_socket` /
 * `timeout` errors begin. `botmanager` samples `snapshotAndReset()` on a fixed
 * interval, tags each window with the current active-player count, logs a terse
 * summary, and appends the row to `data/send_metrics.jsonl` for later analysis.
 */

export type SendErrorCategory =
  | "closed_socket"
  | "timeout"
  | "rate_limited"
  | "other";

export interface SendMetricsSnapshot {
  /** Wall-clock time this snapshot was taken. */
  ts: number;
  /** Length of the window this snapshot covers (ms since the previous reset). */
  windowMs: number;
  /** Active players (running + connected bots) at snapshot time — the bucket. */
  activePlayers: number;
  /** Total `account.send` calls that completed (success or error) in the window. */
  sends: number;
  /** Successful completions in the window. */
  ok: number;
  errClosedSocket: number;
  errTimeout: number;
  errRateLimited: number;
  errOther: number;
  /** Latency stats over completed sends in the window (ms). */
  latAvgMs: number;
  latP50Ms: number;
  latP95Ms: number;
  latP99Ms: number;
  latMaxMs: number;
  /** Peak simultaneous in-flight sends observed during the window. */
  maxInFlight: number;
  /** In-flight sends still outstanding at snapshot time. */
  inFlightNow: number;
}

// --- live state -------------------------------------------------------------

let inFlight = 0;
let activePlayers = 0;

// per-window accumulators (reset by snapshotAndReset)
let windowStart = Date.now();
let latencies: number[] = [];
let ok = 0;
let errClosedSocket = 0;
let errTimeout = 0;
let errRateLimited = 0;
let errOther = 0;
let maxInFlight = 0;

// Guardrail: cap the retained latency reservoir so a very hot window can't grow
// the array without bound before the next snapshot resets it. At 424 bots on a
// 10s tick this is generous headroom; extra samples past the cap are counted
// (for the `sends` total) but not stored for percentiles.
const MAX_LATENCY_SAMPLES = 100_000;
let sampledOverflow = 0;

function categorize(err: unknown): SendErrorCategory {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (/closed socket|socket is closed|connection closed|not open/i.test(msg)) return "closed_socket";
  if (/within \d+\s*ms|timed?\s*out|timeout/i.test(msg)) return "timeout";
  if (/rate.?limit/i.test(msg)) return "rate_limited";
  return "other";
}

/** Number of players (running + connected bots) currently in the fleet. */
export function setActivePlayers(n: number): void {
  activePlayers = n;
}

/**
 * Measure a single `account.send` call. Pure passthrough: it runs `fn`, records
 * timing/concurrency/error category, then returns `fn`'s value or rethrows its
 * error unchanged. No delay or backpressure is ever introduced.
 */
export async function measureSend<T>(fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  inFlight++;
  if (inFlight > maxInFlight) maxInFlight = inFlight;
  try {
    const r = await fn();
    record(Date.now() - start, null);
    return r;
  } catch (err) {
    record(Date.now() - start, err);
    throw err;
  } finally {
    inFlight--;
  }
}

function record(latencyMs: number, err: unknown): void {
  if (latencies.length < MAX_LATENCY_SAMPLES) latencies.push(latencyMs);
  else sampledOverflow++;
  if (err == null) {
    ok++;
    return;
  }
  switch (categorize(err)) {
    case "closed_socket": errClosedSocket++; break;
    case "timeout": errTimeout++; break;
    case "rate_limited": errRateLimited++; break;
    default: errOther++; break;
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/**
 * Return the accumulated metrics for the window since the last call and reset
 * the window accumulators. In-flight and active-player counts are live values
 * (not reset). Returns `null` if nothing was recorded in the window.
 */
export function snapshotAndReset(): SendMetricsSnapshot | null {
  const now = Date.now();
  const windowMs = now - windowStart;
  const errors = errClosedSocket + errTimeout + errRateLimited + errOther;
  const sends = ok + errors + sampledOverflow;
  if (sends === 0) {
    // Nothing happened; still slide the window forward so windowMs stays honest.
    windowStart = now;
    maxInFlight = inFlight;
    return null;
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const snap: SendMetricsSnapshot = {
    ts: now,
    windowMs,
    activePlayers,
    sends,
    ok,
    errClosedSocket,
    errTimeout,
    errRateLimited,
    errOther,
    latAvgMs: sorted.length ? Math.round(sum / sorted.length) : 0,
    latP50Ms: percentile(sorted, 50),
    latP95Ms: percentile(sorted, 95),
    latP99Ms: percentile(sorted, 99),
    latMaxMs: sorted.length ? sorted[sorted.length - 1] : 0,
    maxInFlight,
    inFlightNow: inFlight,
  };

  // reset window
  windowStart = now;
  latencies = [];
  ok = 0;
  errClosedSocket = 0;
  errTimeout = 0;
  errRateLimited = 0;
  errOther = 0;
  sampledOverflow = 0;
  maxInFlight = inFlight; // start next window at the current live in-flight

  return snap;
}
