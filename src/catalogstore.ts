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
const STALE_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Top-level keys the store normalizes into id-keyed indexes. */
const KNOWN_COLLECTION_KEYS = new Set(["items", "ships", "skills", "recipes", "facilities"]);

/**
 * Fetch the raw `catalog.json` exactly as the server publishes it — arrays and
 * every top-level section included. We deliberately do NOT go through
 * `@spacemolt/lib`'s `client.catalog()`: its `fetchCatalog` rebuilds the object
 * with only `version/ships/items/recipes/skills/facilities`, which would drop
 * any new top-level key (e.g. `achievements`) before we ever see it.
 */
async function fetchRawCatalog(httpBaseUrl: string): Promise<Record<string, unknown>> {
  const base = httpBaseUrl.replace(/\/$/, "");
  const url = `${base}/api/catalog.json`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`catalog.json returned a non-object payload`);
  }
  return data as Record<string, unknown>;
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
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private _fetchPromise: Promise<void> | null = null;

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
        // `lastFetched` is metadata we add on write — strip it so `raw` stays
        // server-faithful and never re-persists a stale copy of itself.
        const { lastFetched, ...serverRaw } = parsed;
        this.lastFetched = typeof lastFetched === "string" ? lastFetched : null;
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

  /** Flush pending writes to disk immediately. Call on shutdown. */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.writeToDisk();
  }

  // ── Staleness check ───────────────────────────────────────

  /** True if catalog data is missing or older than 24 hours. */
  isStale(): boolean {
    if (!this.lastFetched) return true;
    const age = Date.now() - new Date(this.lastFetched).getTime();
    return age > STALE_MS;
  }

  // ── Fetch the raw catalog.json (preserves all sections) ───

  /**
   * Fetch the catalog directly from the server's `catalog.json` endpoint and
   * store it verbatim. Replaces the previous `client.catalog()` path, which
   * silently dropped any top-level key it didn't explicitly model.
   */
  async fetchFromLib(): Promise<void> {
    if (this._fetchPromise) return this._fetchPromise;
    this._fetchPromise = this._doFetchFromLib().finally(() => {
      this._fetchPromise = null;
    });
    return this._fetchPromise;
  }

  private async _doFetchFromLib(): Promise<void> {
    const raw = await fetchRawCatalog(getSpacemoltClient().httpBaseUrl);
    this.applyRaw(raw);
    this.lastFetched = new Date().toISOString();
    this.dirty = true;
    this.writeToDisk();
    debugLog("catalog", `Fetched raw catalog.json: ${this.getSummary()}`);
  }

  /**
   * Compare the server's catalog version against what we have. Uses the
   * library's `catalog()` (cached, cheap) purely to read the `version` string;
   * the actual payload is fetched separately via `_doFetchFromLib` so we keep
   * the full, un-stripped file.
   */
  async checkVersionChangedLib(): Promise<boolean> {
    if (this.version === null) return true;
    try {
      const cache = await getSpacemoltClient().catalog();
      return (cache.version ?? null) !== this.version;
    } catch {
      return false;
    }
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
