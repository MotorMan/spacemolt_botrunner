import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { SpaceMoltAPI } from "./api.js";
import { debugLog } from "./debug.js";

const OPENAPI_BASE_URL = "https://game.spacemolt.com/api/v2";

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

export interface CatalogData {
  version: string | null;
  lastFetched: string | null;
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

class CatalogStore {
  private data: CatalogData;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private _fetchPromise: Promise<void> | null = null;

  constructor() {
    this.data = this.load();
  }

  // ── Persistence ─────────────────────────────────────────

  private load(): CatalogData {
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }
    if (existsSync(CATALOG_FILE)) {
      try {
        const raw = readFileSync(CATALOG_FILE, "utf-8");
        const parsed = JSON.parse(raw) as Partial<CatalogData> & { 
          items?: { id: string; [key: string]: unknown }[] | Record<string, { id: string; [key: string]: unknown }>;
          ships?: { id: string; [key: string]: unknown }[] | Record<string, { id: string; [key: string]: unknown }>;
          skills?: { id: string; [key: string]: unknown }[] | Record<string, { id: string; [key: string]: unknown }>;
          recipes?: { id: string; [key: string]: unknown }[] | Record<string, { id: string; [key: string]: unknown }>;
          facilities?: { id: string; [key: string]: unknown }[] | Record<string, { id: string; [key: string]: unknown }>;
        };
        
        const itemsData = parsed.items as { id: string; category?: string; [key: string]: unknown }[] | Record<string, { id: string; category?: string; [key: string]: unknown }> | undefined;
        const shipsData = parsed.ships as { id: string; [key: string]: unknown }[] | Record<string, { id: string; [key: string]: unknown }> | undefined;
        const skillsData = parsed.skills as { id: string; [key: string]: unknown }[] | Record<string, { id: string; [key: string]: unknown }> | undefined;
        const recipesData = parsed.recipes as { id: string; [key: string]: unknown }[] | Record<string, { id: string; [key: string]: unknown }> | undefined;
        const facilitiesData = parsed.facilities as { id: string; category?: string; [key: string]: unknown }[] | Record<string, { id: string; category?: string; [key: string]: unknown }> | undefined;
        
        const items: Record<string, CatalogItem> = {};
        const facilities: Record<string, CatalogFacility> = {};
        
        const itemsEntries = Array.isArray(itemsData) ? itemsData : Object.values(itemsData ?? {});
        for (const item of itemsEntries) {
          const id = (item as { id?: unknown; category?: string })?.id;
          const category = (item as { category?: string })?.category;
          if (typeof id === "string") {
            items[id] = item as CatalogItem;
            if (category === "personal" || category === "production") {
              facilities[id] = item as unknown as CatalogFacility;
            }
          }
        }
        const ships: Record<string, CatalogShip> = {};
        const shipsEntries = Array.isArray(shipsData) ? shipsData : Object.values(shipsData ?? {});
        for (const ship of shipsEntries) {
          const id = (ship as { id?: unknown })?.id;
          if (typeof id === "string") ships[id] = ship as CatalogShip;
        }
        const skills: Record<string, CatalogSkill> = {};
        const skillsEntries = Array.isArray(skillsData) ? skillsData : Object.values(skillsData ?? {});
        for (const skill of skillsEntries) {
          const id = (skill as { id?: unknown })?.id;
          if (typeof id === "string") skills[id] = skill as CatalogSkill;
        }
        const recipes: Record<string, CatalogRecipe> = {};
        const recipesEntries = Array.isArray(recipesData) ? recipesData : Object.values(recipesData ?? {});
        for (const recipe of recipesEntries) {
          const id = (recipe as { id?: unknown })?.id;
          if (typeof id === "string") recipes[id] = recipe as CatalogRecipe;
        }
        const facilitiesEntries = Array.isArray(facilitiesData) ? facilitiesData : Object.values(facilitiesData ?? {});
        for (const facility of facilitiesEntries) {
          const id = (facility as { id?: unknown })?.id;
          if (typeof id === "string") facilities[id] = facility as CatalogFacility;
        }
        
        return {
          version: parsed.version ?? null,
          lastFetched: parsed.lastFetched ?? null,
          items,
          ships,
          skills,
          recipes,
          facilities,
        };
      } catch {
        // Corrupt file — start fresh
      }
    }
    return { version: null, lastFetched: null, items: {}, ships: {}, skills: {}, recipes: {}, facilities: {} };
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
      const json = JSON.stringify(this.data, null, 2) + "\n";
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
    if (!this.data.lastFetched) return true;
    const age = Date.now() - new Date(this.data.lastFetched).getTime();
    return age > STALE_MS;
  }

  /** Check if the server version has changed since last fetch. */
  async checkVersionChanged(api: SpaceMoltAPI): Promise<boolean> {
    if (this.data.version === null) return true;
    try {
      const versionResp = await api.execute("get_version");
      if (!versionResp.error && versionResp.result) {
        const v = versionResp.result as Record<string, unknown>;
        const currentVersion = (v.version as string) || String(versionResp.result);
        return currentVersion !== this.data.version;
      }
    } catch {
      // If we can't check, assume no change to avoid unnecessary fetch
    }
    return false;
  }

  // ── Fetch from API ────────────────────────────────────────

  /**
   * Fetch catalog from the API. Returns a promise that resolves when complete.
   * Also fetches the OpenAPI spec if this was a version change.
   */
  async fetchAll(api: SpaceMoltAPI): Promise<void> {
    if (this._fetchPromise) return this._fetchPromise;
    this._fetchPromise = this._doFetchAll(api).then(async () => {
      if (this.data.version) {
        await this.fetchOpenApi();
      }
    }).finally(() => {
      this._fetchPromise = null;
    });
    return this._fetchPromise;
  }
  private async _doFetchAll(api: SpaceMoltAPI): Promise<void> {
    let serverVersion: string | null = null;
    try {
      const versionResp = await api.execute("get_version");
      if (!versionResp.error && versionResp.result) {
        const v = versionResp.result as Record<string, unknown>;
        serverVersion = (v.version as string) || null;
        debugLog("catalog", `Server version: ${serverVersion}`);
      }
    } catch (err) {
      debugLog("catalog", `Failed to fetch server version: ${err}`);
    }

    debugLog("catalog", `Fetching catalog from /api/catalog.json`);
    try {
      const baseUrl = api.baseUrl.replace(/\/api\/v2$/, "/api");
      const resp = await fetch(`${baseUrl}/catalog.json`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      const catalogData = await resp.json() as Record<string, unknown>;
      const versionFromCatalog = catalogData.version as string | null;
      
      // Handle both array format (from catalog.json file) and keyed format (from API)
      const itemsData = catalogData.items as Record<string, { id: string; category?: string; [key: string]: unknown }> | { id: string; category?: string; [key: string]: unknown }[] | undefined;
      const shipsData = catalogData.ships as Record<string, { id: string; [key: string]: unknown }> | { id: string; [key: string]: unknown }[] | undefined;
      const skillsData = catalogData.skills as Record<string, { id: string; [key: string]: unknown }> | { id: string; [key: string]: unknown }[] | undefined;
      const recipesData = catalogData.recipes as Record<string, { id: string; [key: string]: unknown }> | { id: string; [key: string]: unknown }[] | undefined;
      const facilitiesData = catalogData.facilities as Record<string, { id: string; category?: string; [key: string]: unknown }> | { id: string; category?: string; [key: string]: unknown }[] | undefined;
      
      const items: Record<string, CatalogItem> = {};
      const facilities: Record<string, CatalogFacility> = {};
      
      // Extract items from either array or keyed format
      const itemsEntries = Array.isArray(itemsData) ? itemsData : Object.values(itemsData ?? {});
      for (const item of itemsEntries) {
        const id = (item as { id?: unknown; category?: string })?.id;
        const category = (item as { category?: string })?.category;
        if (typeof id === "string") {
          items[id] = item as CatalogItem;
          if (category === "personal" || category === "production") {
            facilities[id] = item as unknown as CatalogFacility;
          }
        }
      }
      
      const ships: Record<string, CatalogShip> = {};
      const shipsEntries = Array.isArray(shipsData) ? shipsData : Object.values(shipsData ?? {});
      for (const ship of shipsEntries) {
        const id = (ship as { id?: unknown })?.id;
        if (typeof id === "string") ships[id] = ship as CatalogShip;
      }
      const skills: Record<string, CatalogSkill> = {};
      const skillsEntries = Array.isArray(skillsData) ? skillsData : Object.values(skillsData ?? {});
      for (const skill of skillsEntries) {
        const id = (skill as { id?: unknown })?.id;
        if (typeof id === "string") skills[id] = skill as CatalogSkill;
      }
      const recipes: Record<string, CatalogRecipe> = {};
      const recipesEntries = Array.isArray(recipesData) ? recipesData : Object.values(recipesData ?? {});
      for (const recipe of recipesEntries) {
        const id = (recipe as { id?: unknown })?.id;
        if (typeof id === "string") recipes[id] = recipe as CatalogRecipe;
      }
      
      const facilitiesEntries = Array.isArray(facilitiesData) ? facilitiesData : Object.values(facilitiesData ?? {});
      for (const facility of facilitiesEntries) {
        const id = (facility as { id?: unknown })?.id;
        if (typeof id === "string") facilities[id] = facility as CatalogFacility;
      }

      this.data.version = serverVersion;
      this.data.lastFetched = new Date().toISOString();
      this.data.items = items;
      this.data.ships = ships;
      this.data.skills = skills;
      this.data.recipes = recipes;
      this.data.facilities = facilities;

      this.dirty = true;
      this.writeToDisk();

      const counts = [
        `${Object.keys(this.data.items).length} items`,
        `${Object.keys(this.data.ships).length} ships`,
        `${Object.keys(this.data.skills).length} skills`,
        `${Object.keys(this.data.recipes).length} recipes`,
        `${Object.keys(this.data.facilities).length} facilities`,
      ];
      debugLog("catalog", `Fetch complete: ${counts.join(", ")}`);

      if (versionFromCatalog && versionFromCatalog !== serverVersion) {
        debugLog("catalog", `Catalog version ${versionFromCatalog} differs from server version ${serverVersion}`);
      }

      return void counts;
    } catch (err) {
      debugLog("catalog", `Catalog fetch failed, falling back to paginated approach: ${err}`);
      await this._doFetchAllPaginated(api);
    }
  }

  /**
   * Fallback: Paginate all 5 catalog types and store results.
   * Used when the new /api/catalog.json endpoint is unavailable.
   */
  private async _doFetchAllPaginated(api: SpaceMoltAPI): Promise<void> {
    let serverVersion: string | null = null;
    try {
      const versionResp = await api.execute("get_version");
      if (!versionResp.error && versionResp.result) {
        const v = versionResp.result as Record<string, unknown>;
        serverVersion = (v.version as string) || null;
        debugLog("catalog", `Server version: ${serverVersion}`);
      }
    } catch (err) {
      debugLog("catalog", `Failed to fetch server version: ${err}`);
    }

    const types = ["items", "ships", "skills", "recipes", "facilities"] as const;
    const results: Record<string, Record<string, unknown>> = {
      items: {},
      ships: {},
      skills: {},
      recipes: {},
      facilities: {},
    };

    for (const type of types) {
      let page = 1;
      let totalPages = 1;

      while (page <= totalPages) {
        debugLog("catalog", `Fetching ${type} page ${page}/${totalPages}`);
        const resp = await api.execute("catalog", { type, page, page_size: 50 });
        if (resp.error) {
          debugLog("catalog", `Fetch error for ${type} page ${page}: ${resp.error.message}`);
          break;
        }

        const data = resp.result as Record<string, unknown> | undefined;
        if (!data) {
          debugLog("catalog", `No result data for ${type} page ${page}`);
          break;
        }

        const dataKeys = Object.keys(data);
        debugLog("catalog", `Response keys for ${type} page ${page}: ${dataKeys.join(", ")}`);

        const entries = extractArray(data, type);
        debugLog("catalog", `Extracted ${entries.length} entries for ${type} page ${page}`);

        for (const entry of entries) {
          const id = (entry.id as string) || (entry.item_id as string) || (entry.recipe_id as string) || (entry.skill_id as string) || (entry.ship_id as string) || (entry.facility_id as string) || "";
          if (id) {
            entry.id = id;
            results[type][id] = entry;
          }
        }

        totalPages = (data.total_pages as number) || (data.totalPages as number) || 1;
        page++;

        if (page <= totalPages) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
      debugLog("catalog", `Finished ${type}: ${Object.keys(results[type]).length} total entries`);
    }

    this.data.items = results.items as Record<string, CatalogItem>;
    this.data.ships = results.ships as Record<string, CatalogShip>;
    this.data.skills = results.skills as Record<string, CatalogSkill>;
    this.data.recipes = results.recipes as Record<string, CatalogRecipe>;
    this.data.facilities = results.facilities as Record<string, CatalogFacility>;
    this.data.version = serverVersion;
    this.data.lastFetched = new Date().toISOString();

    this.dirty = true;
    this.writeToDisk();

    const counts = [
      `${Object.keys(this.data.items).length} items`,
      `${Object.keys(this.data.ships).length} ships`,
      `${Object.keys(this.data.skills).length} skills`,
      `${Object.keys(this.data.recipes).length} recipes`,
      `${Object.keys(this.data.facilities).length} facilities`,
    ];
    debugLog("catalog", `Fetch complete: ${counts.join(", ")}`);
    return void counts;
  }

  // ── OpenAPI fetch ──────────────────────────────────────────

  /**
   * Download openapi.json from the server and save as openapi-V2-{version}.json in the root.
   * Only downloads if the version has changed since last save.
   */
  async fetchOpenApi(): Promise<void> {
    const version = this.data.version;
    if (!version) {
      debugLog("catalog", "Cannot fetch OpenAPI: no version available");
      return;
    }

    const openapiPath = join(process.cwd(), `openapi-V2-${version}.json`);

    if (existsSync(openapiPath)) {
      debugLog("catalog", `OpenAPI already exists at ${openapiPath}`);
      return;
    }

    debugLog("catalog", `Fetching OpenAPI spec for version ${version}`);
    try {
      const resp = await fetch(`${OPENAPI_BASE_URL}/openapi.json`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      const spec = await resp.text();
      writeFileSync(openapiPath, spec, "utf-8");
      debugLog("catalog", `OpenAPI spec saved to ${openapiPath} (${spec.length} bytes)`);
    } catch (err) {
      debugLog("catalog", `Failed to fetch OpenAPI: ${err}`);
    }
  }

  // ── Lookup methods ────────────────────────────────────────

  getItem(id: string): CatalogItem | undefined {
    return this.data.items[id];
  }

  getItemByName(name: string): CatalogItem | undefined {
    const lower = name.toLowerCase();
    for (const item of Object.values(this.data.items)) {
      if ((item.name || "").toLowerCase() === lower) {
        return item;
      }
    }
    return undefined;
  }

  getShip(id: string): CatalogShip | undefined {
    return this.data.ships[id];
  }

  getSkill(id: string): CatalogSkill | undefined {
    return this.data.skills[id];
  }

  getRecipe(id: string): CatalogRecipe | undefined {
    return this.data.recipes[id];
  }

  getFacility(id: string): CatalogFacility | undefined {
    return this.data.facilities[id];
  }

  /** Resolve a human-readable name for any catalog ID. Falls back to formatted ID. */
  resolveItemName(id: string): string {
    const entry = this.data.items[id] || this.data.ships[id] || this.data.skills[id] || this.data.recipes[id] || this.data.facilities[id];
    if (entry?.name) return entry.name as string;
    return id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Return full catalog data for WS broadcast / REST endpoint. */
  getAll(): { version: string | null; items: Record<string, CatalogItem>; ships: Record<string, CatalogShip>; skills: Record<string, CatalogSkill>; recipes: Record<string, CatalogRecipe>; facilities: Record<string, CatalogFacility>; lastFetched: string | null } {
    return {
      version: this.data.version,
      items: this.data.items,
      ships: this.data.ships,
      skills: this.data.skills,
      recipes: this.data.recipes,
      facilities: this.data.facilities,
      lastFetched: this.data.lastFetched,
    };
  }

  /** Check if catalog is empty (no data loaded at all). */
  isEmpty(): boolean {
    return Object.keys(this.data.items).length === 0
      && Object.keys(this.data.ships).length === 0
      && Object.keys(this.data.skills).length === 0
      && Object.keys(this.data.recipes).length === 0
      && Object.keys(this.data.facilities).length === 0;
  }

  /** Check if an item appears as a component in any crafting recipe. */
  isCraftingComponent(itemId: string): boolean {
    for (const recipe of Object.values(this.data.recipes)) {
      if (!recipe.components) continue;
      if (recipe.components.some(c => c.item_id === itemId)) return true;
    }
    return false;
  }

  /** Check if an item is the output of any crafting recipe. */
  isCraftedItem(itemId: string): boolean {
    for (const recipe of Object.values(this.data.recipes)) {
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

    for (const [itemId, item] of Object.entries(this.data.items)) {
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
    return `${Object.keys(this.data.items).length} items, ${Object.keys(this.data.ships).length} ships, ${Object.keys(this.data.skills).length} skills, ${Object.keys(this.data.recipes).length} recipes, ${Object.keys(this.data.facilities).length} facilities`;
  }
}

/** Extract an array of entries from a catalog API response. */
function extractArray(data: Record<string, unknown>, type: string): Array<Record<string, unknown>> {
  if (!data) return [];
  // V2 format: { type: "ships", items: [...] }
  if (typeof data.type === 'string' && Array.isArray(data.items)) {
    return data.items as Array<Record<string, unknown>>;
  }
  // Direct array response
  if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
  // Keyed by type name
  if (Array.isArray(data[type])) return data[type] as Array<Record<string, unknown>>;
  // Common alternate keys
  for (const key of ["items", "catalog", "results", "data", "entries", "list"]) {
    if (Array.isArray(data[key])) return data[key] as Array<Record<string, unknown>>;
  }
  return [];
}

/** Singleton instance shared across the application. */
export const catalogStore = new CatalogStore();
