import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getSpacemoltClient } from "./libClient.js";
import { debugLog } from "./debug.js";

export interface CatalogItem {
  id: string;
  name: string;
  category?: string;
  [key: string]: unknown;
}

export interface CatalogShip {
  id: string;
  name: string;
  class?: string;
  tier?: number;
  [key: string]: unknown;
}

export interface CatalogSkill {
  id: string;
  name: string;
  [key: string]: unknown;
}

export interface CatalogRecipe {
  id: string;
  name: string;
  category?: string;
  components?: Array<{ item_id?: string; name?: string; quantity?: number; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface CatalogFacility {
  id: string;
  name: string;
  category?: string;
  [key: string]: unknown;
}

/**
 * The catalog as exposed to consumers (REST / WS). It always carries the five
 * known id-keyed collections plus `version` / `lastFetched`, and — crucially —
 * forwards any other top-level section the server may add (e.g. `achievements`)
 * so nothing is ever silently stripped.
 */
export interface CatalogData {
  version: string | null;
  lastFetched: string | null;
  items: Record<string, CatalogItem>;
  ships: Record<string, CatalogShip>;
  skills: Record<string, CatalogSkill>;
  recipes: Record<string, CatalogRecipe>;
  facilities: Record<string, CatalogFacility>;
  [key: string]: unknown;
}

interface IndexedCatalog {
  items: Record<string, CatalogItem>;
  ships: Record<string, CatalogShip>;
  skills: Record<string, CatalogSkill>;
  recipes: Record<string, CatalogRecipe>;
  facilities: Record<string, CatalogFacility>;
}

// ── CatalogStore singleton ──────────────────────────────────

const DATA_DIR = join(process.cwd(), "data");
const CATALOG_FILE = join(DATA_DIR, "catalog.json");
const SAVE_DEBOUNCE_MS = 5000;
/** Floor between version-driven reconcile attempts, so a fleet of bots all
 *  reporting the same not-yet-republished gameserver version can't storm the
 *  gameserver with catalog requests during a patch window. */
const RECONCILE_COOLDOWN_MS = 30_000;

/** Top-level keys the store normalizes into id-keyed indexes. */
const KNOWN_COLLECTION_KEYS = new Set(["items", "ships", "skills", "recipes", "facilities"]);

/**
 * Fetch the raw `catalog.json` exactly as the server publishes it — arrays and
 * every top-level section included. We deliberately do NOT go through
 * `@spacemolt/lib`'s `client.catalog()`: its `fetchCatalog` rebuilds the object
 * with only `version/ships/items/recipes/skills/facilities`, which would drop
 * any new top-level key (e.g. `achievements`) before we ever see it.
 */
/**
 * Result of a raw `catalog.json` fetch. The endpoint is served with HTTP
 * caching headers (`ETag` / `Last-Modified`) — the server's intended
 * "has this changed?" signal. We surface those headers so callers can issue a
 * conditional request and cheaply detect a new release via a `304`, instead of
 * re-downloading the full payload or (worse) trusting a cached version string.
 */
interface RawCatalogResponse {
  /** HTTP status. `304` means "unchanged since your last request". */
  status: number;
  /** Server `ETag` header (quotes/weak `W/` prefix preserved verbatim). */
  etag: string | null;
  /** Server `Last-Modified` header, if no `ETag` was provided. */
  lastModified: string | null;
  /** Parsed payload — `null` on a `304` (body is intentionally empty). */
  data: Record<string, unknown> | null;
}

/**
 * Fetch the raw `catalog.json` exactly as the server publishes it — arrays and
 * every top-level section included. We deliberately do NOT go through
 * `@spacemolt/lib`'s `client.catalog()`: its `fetchCatalog` rebuilds the object
 * with only `version/ships/items/recipes/skills/facilities`, which would drop
 * any new top-level key (e.g. `achievements`) before we ever see it, AND the
 * client caches the catalog for the process lifetime so its `version` never
 * updates — which is why a new game release was never detected.
 *
 * When `ifNoneMatch` / `ifModifiedSince` are supplied we send a conditional
 * request; the server answers `304 Not Modified` (no body) when the catalog is
 * unchanged, letting us skip the download entirely.
 */
async function fetchRawCatalog(
  httpBaseUrl: string,
  opts: { ifNoneMatch?: string | null; ifModifiedSince?: string | null } = {},
): Promise<RawCatalogResponse> {
  const base = httpBaseUrl.replace(/\/$/, "");
  const url = `${base}/api/catalog.json`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.ifNoneMatch) headers["If-None-Match"] = opts.ifNoneMatch;
  else if (opts.ifModifiedSince) headers["If-Modified-Since"] = opts.ifModifiedSince;
  const res = await fetch(url, { headers });
  const etag = res.headers.get("etag");
  const lastModified = res.headers.get("last-modified");
  if (res.status === 304) {
    return { status: 304, etag, lastModified, data: null };
  }
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`catalog.json returned a non-object payload`);
  }
  return { status: 200, etag, lastModified, data: data as Record<string, unknown> };
}

/** Build an id-keyed record from either an array of entries or an id-keyed object. */
function indexCollection<T extends { id?: string }>(data: unknown): Record<string, T> {
  const out: Record<string, T> = {};
  if (data == null) return out;
  const entries = Array.isArray(data) ? data : Object.values(data as Record<string, T>);
  for (const e of entries) {
    const id = (e as { id?: unknown })?.id;
    if (typeof id === "string") out[id] = e as T;
  }
  return out;
}

function emptyIndexed(): IndexedCatalog {
  return { items: {}, ships: {}, skills: {}, recipes: {}, facilities: {} };
}

class CatalogStore {
  /** Id-keyed indexes derived from the server payload for O(1) lookups. */
  private indexed: IndexedCatalog = emptyIndexed();
  /** Any top-level section other than the known collections + version. */
  private extra: Record<string, unknown> = {};
  private version: string | null = null;
  private lastFetched: string | null = null;
  /** Server `ETag` from the last fetch — our conditional-request token. */
  private etag: string | null = null;
  /** Server `Last-Modified` — fallback validation token when no `ETag`. */
  private lastModified: string | null = null;
  /** The gameserver version we last reconciled the catalog against. */
  private lastGameServerVersion: string | null = null;
  /** Timestamp of the last version-driven reconcile attempt (cooldown gate). */
  private lastReconcileAt = 0;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private _fetchPromise: Promise<boolean> | null = null;

  constructor() {
    this.load();
  }

  // ── Persistence ─────────────────────────────────────────

  private load(): void {
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }
    if (existsSync(CATALOG_FILE)) {
      try {
        const parsed = JSON.parse(readFileSync(CATALOG_FILE, "utf-8")) as Record<string, unknown>;
        // `lastFetched`/`etag`/`lastModified` are metadata we add on write —
        // strip them so `raw` stays server-faithful and never re-persists a
        // stale copy of itself, and so the validation tokens survive reload.
        const { lastFetched, etag, lastModified, ...serverRaw } = parsed;
        this.lastFetched = typeof lastFetched === "string" ? lastFetched : null;
        this.etag = typeof etag === "string" ? etag : null;
        this.lastModified = typeof lastModified === "string" ? lastModified : null;
        this.applyRaw(serverRaw);
        return;
      } catch {
        // Corrupt file — start fresh
      }
    }
    this.indexed = emptyIndexed();
    this.extra = {};
    this.version = null;
    this.lastFetched = null;
    this.etag = null;
    this.lastModified = null;
  }

  /** Fold a verbatim server payload into our indexed + extra views. */
  private applyRaw(raw: Record<string, unknown>): void {
    const items = indexCollection<CatalogItem>(raw.items);
    const facilitiesFromItems: Record<string, CatalogFacility> = {};
    for (const [id, it] of Object.entries(items)) {
      if (it.category === "personal" || it.category === "production") {
        facilitiesFromItems[id] = it as unknown as CatalogFacility;
      }
    }
    this.indexed = {
      items,
      ships: indexCollection<CatalogShip>(raw.ships),
      skills: indexCollection<CatalogSkill>(raw.skills),
      recipes: indexCollection<CatalogRecipe>(raw.recipes),
      facilities: { ...indexCollection<CatalogFacility>(raw.facilities), ...facilitiesFromItems },
    };

    this.version = typeof raw.version === "string" ? raw.version : null;

    const extra: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (KNOWN_COLLECTION_KEYS.has(k) || k === "version" || k === "lastFetched") continue;
      extra[k] = v;
    }
    this.extra = extra;
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.writeToDisk();
    }, SAVE_DEBOUNCE_MS);
  }

  private writeToDisk(): void {
    if (!this.dirty) return;
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }
    try {
      // Write every section the server sent. The five known collections are
      // persisted as id-keyed records (what the web UI expects) — a lossless
      // transform — while any other top-level key (e.g. `achievements`) is
      // forwarded verbatim so nothing is ever stripped.
      const out = {
        version: this.version,
        lastFetched: this.lastFetched,
        etag: this.etag,
        lastModified: this.lastModified,
        items: this.indexed.items,
        ships: this.indexed.ships,
        skills: this.indexed.skills,
        recipes: this.indexed.recipes,
        facilities: this.indexed.facilities,
        ...this.extra,
      };
      const json = JSON.stringify(out, null, 2) + "\n";
      writeFileSync(CATALOG_FILE, json, "utf-8");
      debugLog("catalog", `Catalog written to ${CATALOG_FILE} (${json.length} bytes)`);
    } catch (err) {
      // Log error but don't throw - catalog is still usable from memory
      console.error("Error writing catalog:", err);
      debugLog("catalog", `Error writing catalog: ${err}`);
    }
    this.dirty = false;
  }

  /**
   * Replace the in-memory catalog (and on-disk file) with a verbatim payload
   * received from a peer (the client-sync master relays a single
   * fleet-converged `catalog.json` so only one node ever downloads it from the
   * gameserver). The payload is treated exactly like a server payload — every
   * top-level section is preserved and `lastFetched` is refreshed.
   */
  replaceWith(raw: Record<string, unknown>): void {
    this.applyRaw(raw);
    this.lastFetched = typeof raw.lastFetched === "string" ? raw.lastFetched : new Date().toISOString();
    // Data came from a peer, not the gameserver — our HTTP validation tokens
    // are no longer meaningful for this payload. Clear them so the next
    // gameserver fetch revalidates unconditionally.
    this.etag = null;
    this.lastModified = null;
    this.dirty = true;
    this.writeToDisk();
    debugLog("catalog", `Replaced catalog from remote sync: ${this.getSummary()}`);
  }

  /** Flush pending writes to disk immediately. Call on shutdown. */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.writeToDisk();
  }

  // ── Version-driven refresh ───────────────────────────────

  /** The catalog's `version` field (the gameserver version it matches), or null. */
  getVersion(): string | null {
    return this.version;
  }

  /**
   * True if we have never loaded a catalog (first run / corrupt file). Used only
   * for bootstrap — there is deliberately NO time-based staleness check anymore:
   * the gameserver can ship multiple patches a day, so the catalog is kept fresh
   * purely by reacting to gameserver-version changes (see `noteGameServerVersion`).
   */
  isStale(): boolean {
    return this.version === null;
  }

  /**
   * React to learning the current gameserver version. If it differs from the
   * catalog we already hold, reconcile: a *conditional* GET fetches the fresh
   * `catalog.json` only once the file has actually been republished (a `304`
   * keeps us cheap until then), so a new patch lands within moments of the
   * first version report — no 24h wait, no download storm.
   *
   * @returns `true` if a fresh catalog was downloaded.
   */
  async noteGameServerVersion(gsVersion: string | null): Promise<boolean> {
    if (!gsVersion) return false;
    // Already holding a catalog that matches the live gameserver version.
    if (this.version === gsVersion) {
      this.lastGameServerVersion = gsVersion;
      return false;
    }
    const now = Date.now();
    // A different version is in play but we already reconciled for THIS exact
    // version recently (server may not have republished the catalog file yet) —
    // back off until the cooldown elapses so the fleet doesn't hammer it.
    if (gsVersion === this.lastGameServerVersion && now - this.lastReconcileAt < RECONCILE_COOLDOWN_MS) {
      return false;
    }
    this.lastGameServerVersion = gsVersion;
    this.lastReconcileAt = now;
    try {
      return await this.fetchFromLib(false);
    } catch {
      return false;
    }
  }

  // ── Fetch the raw catalog.json (preserves all sections) ───

  /**
   * Fetch the catalog directly from the server's `catalog.json` endpoint and
   * store it verbatim. Replaces the previous `client.catalog()` path, which
   * silently dropped any top-level key it didn't explicitly model AND cached
   * the catalog for the process lifetime — so the version never updated and a
   * new game release went unnoticed.
   *
   * Uses the server's `ETag`/`Last-Modified` headers to issue a *conditional*
   * request: if the catalog hasn't changed since our last fetch the server
   * answers `304` with no body and we keep the cached copy (just bumping
   * `lastFetched`). This is what reliably detects a new game version — both on
   * a scheduled refresh and on every client restart — without re-downloading.
   *
   * @param force When true, ignore any cached validation token and always
   *   re-download (used by master/slave sync that must publish a fresh copy).
   * @returns `true` if the catalog was actually updated, `false` on a `304`.
   */
  async fetchFromLib(force = false): Promise<boolean> {
    if (this._fetchPromise) return this._fetchPromise;
    this._fetchPromise = this._doFetchFromLib(force).finally(() => {
      this._fetchPromise = null;
    });
    return this._fetchPromise;
  }

  private async _doFetchFromLib(force: boolean): Promise<boolean> {
    const ifNoneMatch = force ? null : this.etag;
    const ifModifiedSince = force ? null : this.lastModified;
    const res = await fetchRawCatalog(getSpacemoltClient().httpBaseUrl, { ifNoneMatch, ifModifiedSince });

    // `304 Not Modified` — server's "it hasn't changed" signal. Keep the
    // cached payload; only refresh the staleness timestamp (and re-persist the
    // surviving validation tokens). No body was returned to apply.
    if (res.status === 304) {
      this.lastFetched = new Date().toISOString();
      this.dirty = true;
      this.writeToDisk();
      debugLog("catalog", "Catalog unchanged (HTTP 304) — kept cached copy");
      return false;
    }

    this.applyRaw(res.data!);
    this.etag = res.etag;
    this.lastModified = res.lastModified;
    this.lastFetched = new Date().toISOString();
    this.dirty = true;
    this.writeToDisk();
    debugLog("catalog", `Fetched raw catalog.json: ${this.getSummary()}`);
    return true;
  }



  // ── Lookup methods ────────────────────────────────────────

  getItem(id: string): CatalogItem | undefined {
    return this.indexed.items[id];
  }

  getItemByName(name: string): CatalogItem | undefined {
    const lower = name.toLowerCase();
    for (const item of Object.values(this.indexed.items)) {
      if ((item.name || "").toLowerCase() === lower) {
        return item;
      }
    }
    return undefined;
  }

  getShip(id: string): CatalogShip | undefined {
    return this.indexed.ships[id];
  }

  getSkill(id: string): CatalogSkill | undefined {
    return this.indexed.skills[id];
  }

  getRecipe(id: string): CatalogRecipe | undefined {
    return this.indexed.recipes[id];
  }

  getFacility(id: string): CatalogFacility | undefined {
    return this.indexed.facilities[id];
  }

  /** Resolve a human-readable name for any catalog ID. Falls back to formatted ID. */
  resolveItemName(id: string): string {
    const entry = this.indexed.items[id] || this.indexed.ships[id] || this.indexed.skills[id] || this.indexed.recipes[id] || this.indexed.facilities[id];
    if (entry?.name) return entry.name as string;
    return id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Return full catalog data for WS broadcast / REST endpoint. */
  getAll(): CatalogData {
    return {
      version: this.version,
      lastFetched: this.lastFetched,
      items: this.indexed.items,
      ships: this.indexed.ships,
      skills: this.indexed.skills,
      recipes: this.indexed.recipes,
      facilities: this.indexed.facilities,
      ...this.extra,
    };
  }

  /** Check if catalog is empty (no data loaded at all). */
  isEmpty(): boolean {
    return Object.keys(this.indexed.items).length === 0
      && Object.keys(this.indexed.ships).length === 0
      && Object.keys(this.indexed.skills).length === 0
      && Object.keys(this.indexed.recipes).length === 0
      && Object.keys(this.indexed.facilities).length === 0;
  }

  /** Check if an item appears as a component in any crafting recipe. */
  isCraftingComponent(itemId: string): boolean {
    for (const recipe of Object.values(this.indexed.recipes)) {
      if (!recipe.components) continue;
      if (recipe.components.some(c => c.item_id === itemId)) return true;
    }
    return false;
  }

  /** Check if an item is the output of any crafting recipe. */
  isCraftedItem(itemId: string): boolean {
    for (const recipe of Object.values(this.indexed.recipes)) {
      const outputId = (recipe as Record<string, unknown>).output_item_id as string | undefined;
      if (outputId === itemId) return true;
    }
    return false;
  }

  /**
   * Build a lookup map: ammo_type -> [item_ids that provide that ammo].
   * E.g., { "autocannon": ["armor_piercing_rounds_box", "high_explosive_box"], "missile": [...] }
   * Cached after first build to avoid repeated scanning.
   */
  private _ammoTypeIndex: Record<string, string[]> | null = null;

  getAmmoTypeIndex(): Record<string, string[]> {
    if (this._ammoTypeIndex) return this._ammoTypeIndex;

    const index: Record<string, string[]> = {};

    for (const [itemId, item] of Object.entries(this.indexed.items)) {
      const effect = item.effect as Record<string, unknown> | undefined;
      if (effect?.type === "ammo" && typeof effect.subtype === "string") {
        const ammoType = effect.subtype;
        if (!index[ammoType]) {
          index[ammoType] = [];
        }
        index[ammoType].push(itemId);
      }
    }

    this._ammoTypeIndex = index;
    return index;
  }

  /**
   * Find ammo items in cargo that match a weapon's ammo_type.
   * Returns matching cargo item IDs.
   */
  findMatchingAmmoInCargo(cargoItems: Array<{ itemId: string; quantity: number }>, weaponAmmoType: string): Array<{ itemId: string; quantity: number }> {
    const ammoIndex = this.getAmmoTypeIndex();
    const validAmmoIds = new Set(ammoIndex[weaponAmmoType] || []);

    return cargoItems.filter(item => validAmmoIds.has(item.itemId));
  }

  /** Summary string for logging. */
  getSummary(): string {
    const base = `${Object.keys(this.indexed.items).length} items, ${Object.keys(this.indexed.ships).length} ships, ${Object.keys(this.indexed.skills).length} skills, ${Object.keys(this.indexed.recipes).length} recipes, ${Object.keys(this.indexed.facilities).length} facilities`;
    const extraCount = Object.keys(this.extra).length;
    return extraCount > 0 ? `${base}, +${extraCount} other section(s)` : base;
  }
}

/** Singleton instance shared across the application. */
export const catalogStore = new CatalogStore();
