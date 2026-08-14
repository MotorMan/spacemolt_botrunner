/**
 * Shared parsing for the `get_ship` module list.
 *
 * The API returns the fitted modules in TWO places and the shapes differ:
 *
 * ```jsonc
 * {
 *   "ship":    { "modules": ["f5494eaf…", "de38b81c…"] },   // instance UUIDs
 *   "modules": [ { "id": "f5494eaf…", "type_id": "afterburner_ii", … } ]
 * }
 * ```
 *
 * Code that read `ship.modules` directly ended up matching against opaque
 * hex instance ids, so every "is module X fitted?" check silently answered
 * "no" (e.g. an Afterburner II hull logging "no afterburner module fitted").
 *
 * `extractShipModules` normalizes both shapes into detailed module objects by
 * resolving `ship.modules` instance ids against the top-level `modules`
 * detail array, and reports whatever it could NOT resolve so callers can
 * distinguish "definitely not fitted" from "could not read the module list".
 */

// ── Types ────────────────────────────────────────────────────

export interface ExtractedShipModules {
  /** Fitted modules as detailed objects (type_id / name / stats available). */
  modules: Array<Record<string, unknown>>;
  /** Fitted-module id strings that could not be resolved to a detail object. */
  unresolvedIds: string[];
  /**
   * True when the fitted list was read conclusively: every entry became a
   * detail object (an empty module list counts as conclusive). False means at
   * least one entry stayed an opaque id, so a negative match is inconclusive.
   */
  resolved: boolean;
}

// ── Internals ────────────────────────────────────────────────

/** Keys that may hold the fitted-module list, most authoritative first. */
const FITTED_KEYS = ["modules", "fitted_modules", "installed_modules", "installed_mods", "mods"] as const;

/** Matches opaque instance ids (32-char md5-style hashes, UUIDs). */
const INSTANCE_ID_RE = /^[0-9a-f]{16,}$/;

/** True for an id that is a per-instance handle rather than a module type id. */
function isInstanceIdString(value: string): boolean {
  return INSTANCE_ID_RE.test(value.replace(/-/g, "").toLowerCase());
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function arrayAt(source: Record<string, unknown> | null, key: string): unknown[] | null {
  if (!source) return null;
  const value = source[key];
  return Array.isArray(value) ? value : null;
}

// ── Public helpers ───────────────────────────────────────────

/**
 * The module *type* id (e.g. "afterburner_ii"), never the instance UUID.
 * Returns "" when the object carries no recognizable type id.
 */
export function moduleTypeId(mod: Record<string, unknown> | string): string {
  if (typeof mod === "string") return isInstanceIdString(mod) ? "" : mod.toLowerCase();
  // `type`/`slot` are category labels ("utility"), never type ids — excluded.
  const candidates = [mod.type_id, mod.module_id, mod.mod_id, mod.item_id, mod.id];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate) continue;
    if (isInstanceIdString(candidate)) continue;
    return candidate.toLowerCase();
  }
  return "";
}

/** Lowercased "type id + name + type + special" blob for substring matching. */
export function moduleHaystack(mod: Record<string, unknown> | string): string {
  if (typeof mod === "string") return mod.toLowerCase();
  const parts = [
    moduleTypeId(mod),
    mod.name,
    mod.type,
    mod.slot,
    mod.special,
    asRecord(mod.stats)?.special,
  ];
  return parts.filter(p => typeof p === "string").join(" ").toLowerCase();
}

/**
 * Normalize a `get_ship` (or `get_status`) payload into detailed fitted
 * modules. Accepts the raw response result, the `ship` object, or an already
 * extracted module array.
 */
export function extractShipModules(payload: unknown): ExtractedShipModules {
  if (Array.isArray(payload)) {
    return resolveFittedList(payload, buildDetailIndex([payload]));
  }

  const root = asRecord(payload);
  if (!root) return { modules: [], unresolvedIds: [], resolved: false };

  const ship = asRecord(root.ship) ?? root;

  // Every array that might carry detail objects feeds the lookup index, so an
  // instance id in the fitted list can be resolved no matter where the details
  // were published.
  const detailSources: unknown[][] = [];
  for (const key of FITTED_KEYS) {
    const fromRoot = arrayAt(root, key);
    if (fromRoot) detailSources.push(fromRoot);
    if (ship !== root) {
      const fromShip = arrayAt(ship, key);
      if (fromShip) detailSources.push(fromShip);
    }
  }
  if (detailSources.length === 0) return { modules: [], unresolvedIds: [], resolved: false };

  const index = buildDetailIndex(detailSources);

  // The ship's own list is the authoritative "what is fitted right now" set;
  // fall back to whichever detail array exists when the ship omits it. An
  // EMPTY ship list is not preferred over a populated top-level one: some
  // payloads (notably get_status) publish the details at the root and leave
  // `ship.modules` empty, and treating that as "no modules fitted" would clear
  // capability flags the bot already learned.
  const fitted =
    firstNonEmptyArray(ship, FITTED_KEYS)
    ?? (ship !== root ? firstNonEmptyArray(root, FITTED_KEYS) : null);

  // No non-empty list anywhere, but at least one list existed → genuinely no
  // modules fitted, which is a conclusive answer.
  if (!fitted) return { modules: [], unresolvedIds: [], resolved: true };

  return resolveFittedList(fitted, index);
}

function firstNonEmptyArray(
  source: Record<string, unknown> | null,
  keys: readonly string[],
): unknown[] | null {
  for (const key of keys) {
    const value = arrayAt(source, key);
    if (value && value.length > 0) return value;
  }
  return null;
}

interface DetailIndex {
  byInstanceId: Map<string, Record<string, unknown>>;
  byTypeId: Map<string, Record<string, unknown>>;
}

function buildDetailIndex(sources: unknown[][]): DetailIndex {
  const byInstanceId = new Map<string, Record<string, unknown>>();
  const byTypeId = new Map<string, Record<string, unknown>>();

  for (const source of sources) {
    for (const entry of source) {
      const mod = asRecord(entry);
      if (!mod) continue;
      const instanceId = typeof mod.id === "string" ? mod.id.toLowerCase() : "";
      if (instanceId && !byInstanceId.has(instanceId)) byInstanceId.set(instanceId, mod);
      const typeId = moduleTypeId(mod);
      if (typeId && !byTypeId.has(typeId)) byTypeId.set(typeId, mod);
    }
  }

  return { byInstanceId, byTypeId };
}

function resolveFittedList(fitted: unknown[], index: DetailIndex): ExtractedShipModules {
  const modules: Array<Record<string, unknown>> = [];
  const unresolvedIds: string[] = [];
  const seen = new Set<Record<string, unknown>>();

  const push = (mod: Record<string, unknown>) => {
    if (seen.has(mod)) return;
    seen.add(mod);
    modules.push(mod);
  };

  for (const entry of fitted) {
    const mod = asRecord(entry);
    if (mod) {
      push(mod);
      continue;
    }
    if (typeof entry !== "string" || !entry) continue;

    const key = entry.toLowerCase();
    const byInstance = index.byInstanceId.get(key);
    if (byInstance) {
      push(byInstance);
      continue;
    }
    const byType = index.byTypeId.get(key);
    if (byType) {
      push(byType);
      continue;
    }
    if (isInstanceIdString(entry)) {
      // Opaque handle with no matching detail object — nothing to classify.
      unresolvedIds.push(entry);
      continue;
    }
    // A bare type id (e.g. "afterburner_ii") is already classifiable.
    push({ type_id: key, name: key });
  }

  return { modules, unresolvedIds, resolved: unresolvedIds.length === 0 };
}
