/**
 * Per-tick read gate for the game's `read_repeat_limited` rule.
 *
 * The server (patch: "New error read_repeat_limited on get_state, get_ship,
 * get_cargo and storage") refuses a second read of one of those commands within
 * the same 10-second game tick once it has seen unchanged data on 5 of the last
 * 10 ticks. Reading state once per tick is the intended usage: the game state
 * only changes once per tick, and every action already returns the new state.
 *
 * The bot historically re-read `get_ship`/`get_cargo`/`get_status`/storage many
 * times inside a single routine iteration (miners, civilian transport, customs
 * all fan out several reads per loop), which trips the limit and crashes the
 * routine. This module centralises the fix at the one chokepoint every outbound
 * command funnels through (`Bot.sendResilient` wrapping `account.send`):
 *
 *   - a repeated limited read inside one tick is served from a short-lived
 *     per-bot cache instead of re-hitting the server;
 *   - concurrent duplicate reads are coalesced ("single flight") so a
 *     `Promise.all` fan-out can't fire the same read N times;
 *   - any state-changing command invalidates the cache so the next read after a
 *     mutation always reflects the post-mutation state.
 *
 * The query/mutation classification comes straight from the library's generated
 * `ACTIONS` table, so it is authoritative and never drifts from the server spec.
 */

import { ACTIONS } from "@spacemolt/lib";

/** The game's tick length. The read-repeat limit is evaluated per tick. */
export const GAME_TICK_MS = 10_000;

/**
 * How long a cached limited-read result is served without re-hitting the
 * server. Kept just under one tick so any repeat read within the same tick is
 * always a cache hit (two reads in one tick are strictly < 10s apart), while a
 * read in a fresh tick re-fetches. A little staleness is harmless: the state
 * only changes once per tick, so this is exactly "read once per tick".
 */
export const READ_REPEAT_TTL_MS = 9_900;

/** Hard cap on cache entries before the whole cache is dropped (safety valve). */
const READ_CACHE_MAX_ENTRIES = 64;

/** Max in-place retries after a `read_repeat_limited` refusal. */
export const READ_REPEAT_MAX_RETRIES = 2;

/**
 * The limited reads, keyed by `tool/action`. These are the exact commands the
 * patch names: `get_state`, `get_ship`, `get_cargo` and storage (`view`).
 *
 * `get_status` is deliberately NOT gated: the fleet polls it every ~5s across
 * every bot and has never drawn a `read_repeat_limited` on it, so the server
 * does not throttle it (the patch names `get_state`, not `get_status`). Gating
 * it would only make the dashboard/credits up to one tick staler. It is still
 * protected by the `doSend` backstop, which retries any `read_repeat_limited`
 * refusal on any command.
 */
const LIMITED_READ_KEYS = new Set<string>([
  "spacemolt/get_ship",
  "spacemolt/get_cargo",
  "spacemolt/get_state",
  "spacemolt_storage/view",
]);

/** True when this command is one of the per-tick-limited state reads. */
export function isLimitedRead(tool: string, action: string): boolean {
  return LIMITED_READ_KEYS.has(`${tool}/${action}`);
}

/** Deterministic, order-independent serialisation of a command payload. */
function stablePayload(payload?: Record<string, unknown>): string {
  if (!payload) return "";
  const parts: string[] = [];
  for (const key of Object.keys(payload).sort()) {
    const value = payload[key];
    if (value === undefined) continue;
    parts.push(`${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
  }
  return parts.join("&");
}

/**
 * Cache key for a limited read, or null when the command is not limited.
 * Reads that take no parameters (`get_ship`/`get_cargo`/`get_status`/
 * `get_state`) collapse to a single key regardless of an empty vs. undefined
 * payload; storage `view` keeps its `target`/`source`/`station_id` in the key so
 * station-scoped views never alias each other.
 */
export function limitedReadKey(
  tool: string,
  action: string,
  payload?: Record<string, unknown>,
): string | null {
  const base = `${tool}/${action}`;
  if (!LIMITED_READ_KEYS.has(base)) return null;
  return `${base}?${stablePayload(payload)}`;
}

/**
 * True when a command changes game state and therefore invalidates the read
 * cache. Classification comes from the library's generated `ACTIONS` table
 * (`kind: 'query' | 'mutation'`). Unknown commands are treated as
 * state-changing so a stale read can never outlive a mutation we failed to
 * recognise — an extra re-read is always cheaper than acting on stale state.
 */
export function isStateChanging(tool: string, action: string): boolean {
  const def = ACTIONS[`${tool}/${action}`];
  if (!def) return true;
  return def.kind === "mutation";
}

/**
 * True when an error is the server's `read_repeat_limited` refusal. Matches the
 * machine-readable `code` the library surfaces on `SpacemoltError` as well as
 * the human-readable message, so it works regardless of which one the transport
 * preserved.
 */
export function isReadRepeatError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "string" && /read_repeat_limited/i.test(code)) return true;
  const message = err instanceof Error ? err.message : String(err ?? "");
  return /read_repeat_limited|more than once per tick|read it at most once per tick/i.test(message);
}

/** Whether a cache map has grown past the safety valve and should be dropped. */
export function shouldDropReadCache(size: number): boolean {
  return size > READ_CACHE_MAX_ENTRIES;
}

/**
 * Per-bot read cache + single-flight coalescer for the limited reads.
 *
 * `run(key, send)` returns a cached result when a fresh one exists, otherwise
 * performs `send()` at most once per key and shares the in-flight promise with
 * any concurrent caller. `clear()` (called on every state-changing command)
 * drops the cache and bumps a generation counter so a read that was already in
 * flight when a mutation landed can never be cached as if it were current.
 *
 * Kept deliberately tiny and free of any game/bot dependency so it is trivially
 * unit-testable; `Bot` owns one instance and delegates to it.
 */
export class ReadGate {
  private cache = new Map<string, { result: unknown; at: number }>();
  private inflight = new Map<string, Promise<unknown>>();
  private generation = 0;

  /** Drop every cached/in-flight read. Called whenever game state may change. */
  clear(): void {
    this.cache.clear();
    this.inflight.clear();
    this.generation++;
  }

  /**
   * Return a fresh cached result for `key`, or `undefined` when there is none.
   * Exposed for callers/tests that need to peek without triggering a send.
   */
  peek<T = unknown>(key: string): T | undefined {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < READ_REPEAT_TTL_MS) {
      return cached.result as T;
    }
    return undefined;
  }

  /**
   * Run a limited read. A repeat inside one tick is served from cache; a
   * concurrent duplicate shares the same in-flight request; otherwise `send()`
   * runs once and its result is cached (unless a mutation invalidated it while
   * the request was in flight).
   */
  async run<T>(key: string, send: () => Promise<T>): Promise<T> {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < READ_REPEAT_TTL_MS) {
      return cached.result as T;
    }
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;

    const generation = this.generation;
    const pending = send();
    this.inflight.set(key, pending);
    // Bookkeeping only — the caller still awaits `pending` and sees any error.
    // A rejection here must not surface as an unhandled promise rejection.
    void pending.then(
      (result) => {
        if (this.inflight.get(key) === pending) this.inflight.delete(key);
        // A mutation that landed while this read was in flight already cleared
        // the cache; caching now would resurrect stale data.
        if (generation === this.generation) {
          if (shouldDropReadCache(this.cache.size)) this.cache.clear();
          this.cache.set(key, { result, at: Date.now() });
        }
      },
      () => {
        if (this.inflight.get(key) === pending) this.inflight.delete(key);
      },
    );
    return pending;
  }
}