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

  // ── Fetch from @spacemolt/lib (replaces the HTTP bulk fetch) ─

  /**
   * Fetch the catalog through `@spacemolt/lib`'s bulk catalog cache
   * (`client.catalog()`). Replaces the manual `get_version` + `/catalog.json`
   * fetch used by `fetchAll`.
   */
  async fetchFromLib(): Promise<void> {
    if (this._fetchPromise) return this._fetchPromise;
    this._fetchPromise = this._doFetchFromLib().finally(() => {
      this._fetchPromise = null;
    });
    return this._fetchPromise;
  }

  private async _doFetchFromLib(): Promise<void> {
    const cache = await getSpacemoltClient().catalog();
    const toRecord = <T extends CatalogItem>(arr: readonly { id?: string; [k: string]: unknown }[]): Record<string, T> => {
      const out: Record<string, T> = {};
      for (const e of arr) {
        const id = typeof e.id === "string" ? e.id : "";
        if (id) out[id] = e as T;
      }
      return out;
    };
    const items = toRecord<CatalogItem>(cache.items as unknown as { id?: string; [k: string]: unknown }[]);
    const facilitiesFromItems: Record<string, CatalogFacility> = {};
    for (const [id, it] of Object.entries(items)) {
      if (it.category === "personal" || it.category === "production") {
        facilitiesFromItems[id] = it as unknown as CatalogFacility;
      }
    }
    this.data = {
      version: cache.version ?? null,
      lastFetched: new Date().toISOString(),
      items,
      ships: toRecord<CatalogShip>(cache.ships as unknown as { id?: string; [k: string]: unknown }[]),
      skills: toRecord<CatalogSkill>(cache.skills as unknown as { id?: string; [k: string]: unknown }[]),
      recipes: toRecord<CatalogRecipe>(cache.recipes as unknown as { id?: string; [k: string]: unknown }[]),
      facilities: { ...toRecord<CatalogFacility>(cache.facilities as unknown as { id?: string; [k: string]: unknown }[]), ...facilitiesFromItems },
    };
    this.dirty = true;
    this.writeToDisk();
    debugLog("catalog", `Fetched from @spacemolt/lib: ${this.getSummary()}`);
  }

  /** Check server version via the library catalog cache. */
  async checkVersionChangedLib(): Promise<boolean> {
    if (this.data.version === null) return true;
    try {
      const cache = await getSpacemoltClient().catalog();
      return (cache.version ?? null) !== this.data.version;
    } catch {
      return false;
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

/** Singleton instance shared across the application. */
export const catalogStore = new CatalogStore();
