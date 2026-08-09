/**
 * Read-only CPU / performance instrumentation for the bot runner.
 *
 * Zero overhead when disabled: every recorder (`timeSync`, `timeAsync`,
 * `startSpan`, `markRoutineTick`) short-circuits to a single boolean check when
 * the toggle is off, so the production fleet pays nothing until a fleet operator
 * enables "performance monitoring" in Settings → General.
 *
 * Design mirrors `sendMetrics.ts`: accumulators are reset on every
 * `snapshotAndReset()`, and `botmanager` samples the snapshot on a fixed 10s
 * interval, logs a terse summary, and appends a JSON row to
 * `data/perf_metrics.jsonl`.
 *
 * This module has NO internal dependencies, so importing it from hot paths
 * (bot.ts, trader.ts, mapstore.ts) cannot create a circular-import cycle.
 */

import { monitorEventLoopDelay, type Histogram } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";

export interface EventLoopStats {
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface HotFunctionStat {
  name: string;
  calls: number;
  wallMs: number;
  cpuMs: number;
  maxMs: number;
}

export interface RoutineStat {
  bot: string;
  routine: string;
  cpuMs: number;
  wallMs: number;
  ticks: number;
}

/** A single synchronously-executed call that exceeded the stall threshold. */
export interface StallRecord {
  name: string;
  wallMs: number;
  cpuMs: number;
  ts: number;
  heapUsed: number;
  rss: number;
}

export interface MemoryStat {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
  heapSizeLimit: number;
}

export interface PerfSnapshot {
  /** Wall-clock time this snapshot was taken. */
  ts: number;
  /** Length of the window this snapshot covers (ms since the previous reset). */
  windowMs: number;
  /** Active players (running + connected bots) at snapshot time — the bucket. */
  activePlayers: number;
  eventLoop: EventLoopStats;
  hotFunctions: HotFunctionStat[];
  routines: RoutineStat[];
  /** Heap/memory snapshot at the end of the window. */
  memory: MemoryStat;
  /** `memory.heapUsed` delta vs the previous window's snapshot (bytes). */
  memDeltaHeapUsed: number;
  /** Synchronous calls in this window whose wall time breached the threshold. */
  stalls: StallRecord[];
  /** True when the event-loop stall is NOT explained by a captured sync op,
   * suggesting a GC pause correlated with a heap drop in this window. */
  suspectedGcStall: boolean;
}

/** Wall time (ms) above which a call is recorded as a stall candidate. */
const STALL_THRESHOLD_MS = 250;

/** Max number of stall records kept per window (kept bounded for jsonl size). */
const MAX_STALLS_PER_WINDOW = 20;

interface SpanAcc {
  wallMs: number;
  calls: number;
  maxMs: number;
  cpuMs: number;
}

interface RoutineAcc {
  cpuMs: number;
  wallMs: number;
  ticks: number;
}

// ── live state ───────────────────────────────────────────────

let enabled = false;
let elHistogram: (Histogram & { enable(): void; disable(): void }) | null = null;
let windowStart = Date.now();
let activePlayers = 0;

const spans = new Map<string, SpanAcc>();
const routines = new Map<string, RoutineAcc>();
const stalls: StallRecord[] = [];

/** Heap used (bytes) captured at the previous snapshot, for delta math. */
let lastHeapUsed: number | null = null;

function roundMs(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Whether instrumentation is currently active (fast guard for call sites). */
export function isEnabled(): boolean {
  return enabled;
}

/** Start/stop all instrumentation. Idempotent — calling repeatedly is safe. */
export function setEnabled(v: boolean): void {
  if (v === enabled) return;

  enabled = v;
  if (v) {
    // Guard against double-enabling (would throw on monitorEventLoopDelay).
    if (elHistogram) {
      try { elHistogram.disable(); } catch { /* ignore */ }
      elHistogram = null;
    }
    elHistogram = monitorEventLoopDelay({ resolution: 1000 });
    elHistogram.enable();
    // Start a fresh window and clear any stale accumulators.
    windowStart = Date.now();
    spans.clear();
    routines.clear();
    stalls.length = 0;
    lastHeapUsed = null;
  } else {
    if (elHistogram) {
      try { elHistogram.disable(); } catch { /* ignore */ }
      elHistogram = null;
    }
    // Leave accumulators; they are cleared on the next snapshot. The sampler
    // skips when disabled, so no dangling histogram remains.
  }
}

/** Number of players (running + connected bots) currently in the fleet. */
export function setActivePlayers(n: number): void {
  activePlayers = n;
}

function recordSpan(name: string, wallMs: number, cpuMs: number): void {
  let acc = spans.get(name);
  if (!acc) {
    acc = { wallMs: 0, calls: 0, maxMs: 0, cpuMs: 0 };
    spans.set(name, acc);
  }
  acc.calls++;
  acc.wallMs += wallMs;
  acc.cpuMs += cpuMs;
  if (wallMs > acc.maxMs) acc.maxMs = wallMs;

  // Capture stalls (slow synchronously-blocking calls) for attribution. Bounded
  // here is unnecessary: we only keep the top MAX_STALLS_PER_WINDOW at snapshot
  // time. Sampling every over-threshold call keeps the attribution honest.
  if (wallMs >= STALL_THRESHOLD_MS) {
    const mem = process.memoryUsage();
    stalls.push({
      name,
      wallMs: roundMs(wallMs),
      cpuMs: roundMs(cpuMs),
      ts: Date.now(),
      heapUsed: mem.heapUsed,
      rss: mem.rss,
    });
  }
}

/**
 * Measure a synchronous function. When disabled, runs `fn` with no overhead
 * beyond the boolean check. When enabled, accumulates wall + CPU time per name.
 */
export function timeSync<T>(name: string, fn: () => T): T {
  if (!enabled) return fn();
  const cpuStart = process.cpuUsage();
  const wallStart = performance.now();
  try {
    return fn();
  } finally {
    const wallMs = performance.now() - wallStart;
    const cpu = process.cpuUsage(cpuStart);
    recordSpan(name, wallMs, (cpu.user + cpu.system) / 1000);
  }
}

/**
 * Measure an async function. When disabled, awaits `fn` with no overhead.
 * Captures CPU on the calling thread across the await.
 */
export async function timeAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (!enabled) return fn();
  const cpuStart = process.cpuUsage();
  const wallStart = performance.now();
  try {
    return await fn();
  } finally {
    const wallMs = performance.now() - wallStart;
    const cpu = process.cpuUsage(cpuStart);
    recordSpan(name, wallMs, (cpu.user + cpu.system) / 1000);
  }
}

/**
 * Begin a manual span over a block of code (e.g. a method body with early
 * returns). Returns a stop function, or `null` when disabled. Always call the
 * returned function (e.g. in a `finally`) to record the span.
 */
export function startSpan(name: string): { end: () => void } | null {
  if (!enabled) return null;
  const cpuStart = process.cpuUsage();
  const wallStart = performance.now();
  return {
    end() {
      const wallMs = performance.now() - wallStart;
      const cpu = process.cpuUsage(cpuStart);
      recordSpan(name, wallMs, (cpu.user + cpu.system) / 1000);
    },
  };
}

/** Accumulate per-routine CPU + wall totals for the current window. */
export function markRoutineTick(botName: string, routineName: string, cpuMs: number, wallMs: number): void {
  if (!enabled) return;
  const key = `${botName}::${routineName}`;
  let acc = routines.get(key);
  if (!acc) {
    acc = { cpuMs: 0, wallMs: 0, ticks: 0 };
    routines.set(key, acc);
  }
  acc.cpuMs += cpuMs;
  acc.wallMs += wallMs;
  acc.ticks++;
}

/**
 * Return the accumulated metrics for the window since the last call and reset
 * the window accumulators. The event-loop histogram is read and **reset** so its
 * lag stats are genuinely *per-window* (not lifetime). Returns `null` when
 * nothing was recorded in the window (so the sampler can skip empty rows).
 */
export function snapshotAndReset(): PerfSnapshot | null {
  const now = Date.now();
  const windowMs = now - windowStart;

  const el = elHistogram;
  const eventLoop: EventLoopStats = el
    ? {
        meanMs: roundMs(el.mean / 1e6),
        p50Ms: roundMs(el.percentile(50) / 1e6),
        p95Ms: roundMs(el.percentile(95) / 1e6),
        p99Ms: roundMs(el.percentile(99) / 1e6),
        maxMs: roundMs(el.max / 1e6),
      }
    : { meanMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 };

  // Reset the histogram so the next snapshot starts a fresh *per-window* window
  // (it was previously never reset, making every stat a lifetime aggregate).
  if (el) el.reset();

  // Memory snapshot (process + v8 heap limits) for GC/delta correlation.
  const mem = process.memoryUsage();
  const heap = getHeapStatistics();
  const memDeltaHeapUsed =
    lastHeapUsed === null ? 0 : mem.heapUsed - lastHeapUsed;
  const memory: MemoryStat = {
    rss: mem.rss,
    heapTotal: mem.heapTotal,
    heapUsed: mem.heapUsed,
    external: mem.external,
    arrayBuffers: mem.arrayBuffers,
    heapSizeLimit: heap.heap_size_limit,
  };
  lastHeapUsed = mem.heapUsed;

  // Keep only the top MAX_STALLS_PER_WINDOW stalls by wall time, then clear.
  const windowStalls = stalls
    .sort((a, b) => b.wallMs - a.wallMs)
    .slice(0, MAX_STALLS_PER_WINDOW);
  const totalStallMs = windowStalls.reduce((s, r) => s + r.wallMs, 0);
  stalls.length = 0;

  // Heuristic: a large event-loop stall that is NOT explained by any captured
  // synchronous op, paired with a heap drop, points at a GC pause rather than a
  // slow file write. Correlation hint only — intentionally fuzzy.
  const suspectedGcStall =
    eventLoop.maxMs >= STALL_THRESHOLD_MS &&
    totalStallMs < eventLoop.maxMs * 0.5 &&
    memDeltaHeapUsed < 0;

  const hotFunctions: HotFunctionStat[] = [...spans.entries()]
    .map(([name, a]) => ({
      name,
      calls: a.calls,
      wallMs: roundMs(a.wallMs),
      cpuMs: roundMs(a.cpuMs),
      maxMs: roundMs(a.maxMs),
    }))
    .sort((x, y) => y.wallMs - x.wallMs);

  const routineSnaps: RoutineStat[] = [...routines.entries()].map(([k, a]) => {
    const idx = k.indexOf("::");
    return {
      bot: idx >= 0 ? k.slice(0, idx) : k,
      routine: idx >= 0 ? k.slice(idx + 2) : "",
      cpuMs: roundMs(a.cpuMs),
      wallMs: roundMs(a.wallMs),
      ticks: a.ticks,
    };
  });

  // reset window
  windowStart = now;
  spans.clear();
  routines.clear();

  if (hotFunctions.length === 0 && routineSnaps.length === 0 && !el) return null;

  return {
    ts: now,
    windowMs,
    activePlayers,
    eventLoop,
    hotFunctions,
    routines: routineSnaps,
    memory,
    memDeltaHeapUsed,
    stalls: windowStalls,
    suspectedGcStall,
  };
}

/** Convenience namespace object for call sites (`perf.timeSync(...)`, etc.). */
export const perf = {
  isEnabled,
  setEnabled,
  timeSync,
  timeAsync,
  startSpan,
  markRoutineTick,
  setActivePlayers,
  snapshotAndReset,
};
