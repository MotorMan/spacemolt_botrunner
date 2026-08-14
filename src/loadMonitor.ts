/**
 * Lightweight event-loop lag monitor.
 *
 * With a four-figure bot fleet the Node event loop can be saturated for tens to
 * hundreds of ms at a time (mass login, mass mine kickoff, fleet-wide status
 * pushes). When that happens timers — recovery polls, the socket-close barrier
 * in forceReconnectBot, reconnect backoffs — fire LATE, so a socket that "dropped
 * 30s ago" by our clock may in wall-clock terms have been handled much sooner,
 * and our fixed grace windows / backoffs end up either racing @spacemolt/lib's own
 * reconnect or giving up before the library had a fair chance to restore it.
 *
 * We sample the loop's lag and expose a `loadScale()` multiplier so recovery can
 * be *lenient under load* (wait longer for the library, back off more gently)
 * instead of brittle. The sampler is a single unref'd interval, so it never
 * keeps the process alive and costs ~one timer tick per second.
 */

let sampleStart = Date.now();
let smoothedLag = 0;
let started = false;

function tick(): void {
  const now = Date.now();
  // Drift between when this tick was *due* and when it actually ran is the loop
  // lag (how long the event loop was blocked by other work).
  const expected = sampleStart + LOOP_INTERVAL_MS;
  const drift = now - expected;
  sampleStart = now;
  // Smooth it (EWMA) so a single spike doesn't cause a wild multiplier.
  const inst = drift > 0 ? drift : 0;
  smoothedLag = smoothedLag === 0 ? inst : smoothedLag * 0.7 + inst * 0.3;
}

const LOOP_INTERVAL_MS = 1000;

function ensureStarted(): void {
  if (started) return;
  started = true;
  sampleStart = Date.now();
  const h = setInterval(tick, LOOP_INTERVAL_MS);
  // Don't let the sampler keep the process alive during shutdown.
  (h as unknown as { unref?: () => void }).unref?.();
}

/** Current estimated event-loop lag in ms (0 when idle). */
export function eventLoopLagMs(): number {
  ensureStarted();
  return smoothedLag;
}

/**
 * A multiplier >= 1 applied to a timing constant to make it lenient under load.
 *
 * `base` is roughly the lag (in ms) at which we consider the loop "under
 * meaningful pressure". At idle (lag ~0) the scale is 1. As lag grows toward
 * `base` the scale climbs toward 2, and beyond that it keeps growing but is
 * capped at `cap` so recovery never waits absurdly long. Callers pass their own
 * base so different timings react proportionally to their sensitivity.
 */
export function loadScale(base: number, cap = 8): number {
  ensureStarted();
  if (base <= 0) return 1;
  return Math.min(cap, 1 + smoothedLag / base);
}
