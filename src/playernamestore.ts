import { debugLogForBot } from "./debug.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const PLAYER_NAMES_FILE = join(process.cwd(), "data", "playerNames.json");
const FULL_PLAYER_INFO_FILE = join(process.cwd(), "data", "fullPlayerInfo.json");

/**
 * Ship history entry for tracking previously seen ships.
 */
export interface ShipHistoryEntry {
  ship: string; // Ship name/type
  lastSeen: string; // ISO timestamp when this ship was last seen
}

/**
 * Full detail information for a player/pirate/empire NPC.
 */
export interface EntityDetail {
  name: string;
  type: "player" | "pirate" | "empire_npc";
  faction: string; // 4-letter faction code (e.g., "SOLR", "CRMS", "NEBU", "VOID")
  ship: string; // Last seen ship name/type
  lastSeen: string; // ISO timestamp of last sighting
  system: string; // Last known system
  poi: string; // Last known POI/location
  normalized: string; // Normalized name for lookup
  shipHistory?: ShipHistoryEntry[]; // Previously seen ships (no duplicates)
}

/**
 * Data stored in fullPlayerInfo.json.
 */
interface FullPlayerInfoData {
  players: Record<string, EntityDetail>;
  pirates: Record<string, EntityDetail>;
  empire_npcs: Record<string, EntityDetail>;
  lastUpdated: string;
  counts: {
    players: number;
    pirates: number;
    empire_npcs: number;
  };
}

/**
 * Persistent store for known player names, pirates, and empire NPCs.
 * Used to track every entity we've seen via get_nearby, chat messages, combat, etc.
 * Names are deduplicated and normalized for consistent matching.
 */
export class PlayerNameStore {
  private names = new Set<string>(); // Player names
  private normalizedMap = new Map<string, string>(); // normalized -> original (players)
  private pirates = new Set<string>(); // Pirate names
  private pirateNormalizedMap = new Map<string, string>(); // normalized -> original (pirates)
  private empireNpcs = new Set<string>(); // Empire NPC names
  private empireNpcNormalizedMap = new Map<string, string>(); // normalized -> original (empire NPCs)
  private _botName: string | null = null;
  private _initialized = false;

  // Full detail tracking
  private fullPlayerInfo: FullPlayerInfoData = {
    players: {},
    pirates: {},
    empire_npcs: {},
    lastUpdated: new Date().toISOString(),
    counts: {
      players: 0,
      pirates: 0,
      empire_npcs: 0,
    },
  };

  constructor() {
    // Load will be called synchronously on first use if not already loaded
    this.loadFullPlayerInfo();
  }

  /** Load full player info from disk (lazy, called on first access) */
  private loadFullPlayerInfo(): void {
    try {
      if (!existsSync(FULL_PLAYER_INFO_FILE)) {
        debugLogForBot(this._botName || "unknown", "fullplayerinfo:load", `${this._botName || "unknown"}`, "No full player info file, starting fresh");
        this.saveFullPlayerInfo();
        return;
      }
      const text = readFileSync(FULL_PLAYER_INFO_FILE, "utf-8");
      const data = JSON.parse(text) as FullPlayerInfoData;
      this.fullPlayerInfo = {
        players: data.players || {},
        pirates: data.pirates || {},
        empire_npcs: data.empire_npcs || {},
        lastUpdated: data.lastUpdated || new Date().toISOString(),
        counts: data.counts || { players: 0, pirates: 0, empire_npcs: 0 },
      };
      // Recalculate counts
      this.fullPlayerInfo.counts.players = Object.keys(this.fullPlayerInfo.players).length;
      this.fullPlayerInfo.counts.pirates = Object.keys(this.fullPlayerInfo.pirates).length;
      this.fullPlayerInfo.counts.empire_npcs = Object.keys(this.fullPlayerInfo.empire_npcs).length;
      debugLogForBot(this._botName || "unknown", "fullplayerinfo:load", `${this._botName || "unknown"}`, 
        `Loaded ${this.fullPlayerInfo.counts.players} players, ${this.fullPlayerInfo.counts.pirates} pirates, ${this.fullPlayerInfo.counts.empire_npcs} empire NPCs`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[PlayerNameStore] Load full player info failed: ${msg}`);
      this.fullPlayerInfo = {
        players: {},
        pirates: {},
        empire_npcs: {},
        lastUpdated: new Date().toISOString(),
        counts: { players: 0, pirates: 0, empire_npcs: 0 },
      };
    }
  }

  /** Save full player info to disk */
  private saveFullPlayerInfo(): void {
    try {
      this.fullPlayerInfo.lastUpdated = new Date().toISOString();
      writeFileSync(FULL_PLAYER_INFO_FILE, JSON.stringify(this.fullPlayerInfo, null, 2), "utf-8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[PlayerNameStore] Save full player info failed: ${msg}`);
    }
  }

  /** Ensure data is loaded from disk (called lazily on first use) */
  private ensureLoaded(): void {
    if (!this._initialized) {
      this._initialized = true;
      // Synchronous load using Node fs module for reliability
      try {
        if (!existsSync(PLAYER_NAMES_FILE)) {
          debugLogForBot(this._botName || "unknown", "playernames:load", `${this._botName || "unknown"}`, "No existing file, starting fresh");
          return;
        }

        const text = readFileSync(PLAYER_NAMES_FILE, "utf-8");
        const data = JSON.parse(text) as { names?: string[]; pirates?: string[]; empire_npcs?: string[] };

        // Load player names
        if (Array.isArray(data.names) && data.names.length > 0) {
          this.names.clear();
          this.normalizedMap.clear();
          for (const name of data.names) {
            if (typeof name === "string" && name.trim()) {
              const normalized = this.normalize(name);
              this.names.add(name);
              this.normalizedMap.set(normalized, name);
            }
          }
          debugLogForBot(this._botName || "unknown", "playernames:load", `${this._botName || "unknown"}`, `Loaded ${this.names.size} player names`);
        }

        // Load pirate names
        if (Array.isArray(data.pirates) && data.pirates.length > 0) {
          this.pirates.clear();
          this.pirateNormalizedMap.clear();
          for (const name of data.pirates) {
            if (typeof name === "string" && name.trim()) {
              const normalized = this.normalize(name);
              this.pirates.add(name);
              this.pirateNormalizedMap.set(normalized, name);
            }
          }
          debugLogForBot(this._botName || "unknown", "playernames:load", `${this._botName || "unknown"}`, `Loaded ${this.pirates.size} pirate names`);
        }

        // Load empire NPC names
        if (Array.isArray(data.empire_npcs) && data.empire_npcs.length > 0) {
          this.empireNpcs.clear();
          this.empireNpcNormalizedMap.clear();
          for (const name of data.empire_npcs) {
            if (typeof name === "string" && name.trim()) {
              const normalized = this.normalize(name);
              this.empireNpcs.add(name);
              this.empireNpcNormalizedMap.set(normalized, name);
            }
          }
          debugLogForBot(this._botName || "unknown", "playernames:load", `${this._botName || "unknown"}`, `Loaded ${this.empireNpcs.size} empire NPC names`);
        }

        if (!data.names?.length && !data.pirates?.length && !data.empire_npcs?.length) {
          debugLogForBot(this._botName || "unknown", "playernames:load", `${this._botName || "unknown"}`, "File exists but no names, starting fresh");
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[PlayerNameStore] Load failed: ${msg}`);
        // Start fresh on error
        this.names.clear();
        this.normalizedMap.clear();
        this.pirates.clear();
        this.pirateNormalizedMap.clear();
        this.empireNpcs.clear();
        this.empireNpcNormalizedMap.clear();
      }
    }
  }

  setBotName(name: string): void {
    this._botName = name;
  }

  /**
   * Normalize a player name for comparison and storage.
   * Handles spaces, special characters, and case-insensitivity.
   * Returns lowercase, trimmed version with internal spaces preserved.
   */
  private normalize(name: string): string {
    return name.trim().toLowerCase();
  }

  /**
   * Update an entity's ship, tracking history without duplicates.
   * Only adds to history if the ship actually changed and isn't already logged.
   */
  private updateShipWithHistory(entity: EntityDetail, newShip: string, timestamp: string): void {
    if (!newShip || newShip === entity.ship) {
      return; // No change or empty ship
    }

    // If entity has an existing ship, add it to history
    if (entity.ship && entity.ship !== newShip) {
      if (!entity.shipHistory) {
        entity.shipHistory = [];
      }

      // Check if this ship is already in history
      const alreadyLogged = entity.shipHistory.some(entry => entry.ship === entity.ship);
      if (!alreadyLogged) {
        entity.shipHistory.push({ ship: entity.ship, lastSeen: entity.lastSeen });
      }
    }

    // Update to new ship
    entity.ship = newShip;
  }

  /**
   * Add/update a player with full details.
   * Returns true if this is a new player (not previously seen).
   */
  add(name: string, faction = "", ship = "", system = "", poi = ""): boolean {
    this.ensureLoaded();

    if (!name || typeof name !== "string") {
      return false;
    }

    const normalized = this.normalize(name);
    if (!normalized) {
      return false;
    }

    const isNew = !this.normalizedMap.has(normalized);
    const now = new Date().toISOString();

    if (!isNew && this.fullPlayerInfo.players[normalized]) {
      // Update existing player - track ship history
      const entity = this.fullPlayerInfo.players[normalized];
      this.updateShipWithHistory(entity, ship, entity.lastSeen);
      entity.faction = faction || entity.faction;
      entity.system = system || entity.system;
      entity.poi = poi || entity.poi;
      entity.lastSeen = now;
    } else {
      // New player
      this.fullPlayerInfo.players[normalized] = {
        name: name,
        type: "player",
        faction: faction,
        ship: ship,
        lastSeen: now,
        system: system,
        poi: poi,
        normalized: normalized,
      };
    }

    // Check if we already have this name (case-insensitive, normalized)
    if (!isNew) {
      debugLogForBot(this._botName || "unknown", "playernames:add", `${this._botName || "unknown"}`, `Updated: "${name}" (faction: ${faction || "unknown"}, ship: ${ship || "unknown"})`);
    } else {
      // Add to both sets
      this.names.add(name);
      this.normalizedMap.set(normalized, name);
      debugLogForBot(this._botName || "unknown", "playernames:add", `${this._botName || "unknown"}`, `Added: "${name}" (total: ${this.names.size}, faction: ${faction || "unknown"}, ship: ${ship || "unknown"})`);
    }

    this.fullPlayerInfo.counts.players = Object.keys(this.fullPlayerInfo.players).length;
    this.saveFullPlayerInfo();
    this.save();
    return isNew;
  }

  /**
   * Add/update a pirate with full details.
   * Returns true if this is a new pirate (not previously seen).
   */
  addPirate(name: string, faction = "", ship = "", system = "", poi = ""): boolean {
    this.ensureLoaded();

    if (!name || typeof name !== "string") {
      return false;
    }

    const normalized = this.normalize(name);
    if (!normalized) {
      return false;
    }

    const isNew = !this.pirateNormalizedMap.has(normalized);
    const now = new Date().toISOString();

    if (!isNew && this.fullPlayerInfo.pirates[normalized]) {
      // Update existing pirate - track ship history
      const entity = this.fullPlayerInfo.pirates[normalized];
      this.updateShipWithHistory(entity, ship, entity.lastSeen);
      entity.faction = faction || entity.faction;
      entity.system = system || entity.system;
      entity.poi = poi || entity.poi;
      entity.lastSeen = now;
    } else {
      // New pirate
      this.fullPlayerInfo.pirates[normalized] = {
        name: name,
        type: "pirate",
        faction: faction,
        ship: ship,
        lastSeen: now,
        system: system,
        poi: poi,
        normalized: normalized,
      };
    }

    // Check if we already have this name (case-insensitive, normalized)
    if (!isNew) {
      debugLogForBot(this._botName || "unknown", "playernames:add", `${this._botName || "unknown"}`, `Pirate updated: "${name}" (faction: ${faction || "unknown"}, ship: ${ship || "unknown"})`);
    } else {
      // Add to both sets
      this.pirates.add(name);
      this.pirateNormalizedMap.set(normalized, name);
      debugLogForBot(this._botName || "unknown", "playernames:add", `${this._botName || "unknown"}`, `Added pirate: "${name}" (total: ${this.pirates.size}, faction: ${faction || "unknown"}, ship: ${ship || "unknown"})`);
    }

    this.fullPlayerInfo.counts.pirates = Object.keys(this.fullPlayerInfo.pirates).length;
    this.saveFullPlayerInfo();
    this.save();
    return isNew;
  }

  /**
   * Add/update an empire NPC with full details.
   * Returns true if this is a new empire NPC (not previously seen).
   */
  addEmpireNpc(name: string, faction = "", ship = "", system = "", poi = ""): boolean {
    this.ensureLoaded();

    if (!name || typeof name !== "string") {
      return false;
    }

    const normalized = this.normalize(name);
    if (!normalized) {
      return false;
    }

    const isNew = !this.empireNpcNormalizedMap.has(normalized);
    const now = new Date().toISOString();

    if (!isNew && this.fullPlayerInfo.empire_npcs[normalized]) {
      // Update existing empire NPC - track ship history
      const entity = this.fullPlayerInfo.empire_npcs[normalized];
      this.updateShipWithHistory(entity, ship, entity.lastSeen);
      entity.faction = faction || entity.faction;
      entity.system = system || entity.system;
      entity.poi = poi || entity.poi;
      entity.lastSeen = now;
    } else {
      // New empire NPC
      this.fullPlayerInfo.empire_npcs[normalized] = {
        name: name,
        type: "empire_npc",
        faction: faction,
        ship: ship,
        lastSeen: now,
        system: system,
        poi: poi,
        normalized: normalized,
      };
    }

    // Check if we already have this name (case-insensitive, normalized)
    if (!isNew) {
      debugLogForBot(this._botName || "unknown", "playernames:add", `${this._botName || "unknown"}`, `Empire NPC updated: "${name}" (faction: ${faction || "unknown"}, ship: ${ship || "unknown"})`);
    } else {
      // Add to both sets
      this.empireNpcs.add(name);
      this.empireNpcNormalizedMap.set(normalized, name);
      debugLogForBot(this._botName || "unknown", "playernames:add", `${this._botName || "unknown"}`, `Added empire NPC: "${name}" (total: ${this.empireNpcs.size}, faction: ${faction || "unknown"}, ship: ${ship || "unknown"})`);
    }

    this.fullPlayerInfo.counts.empire_npcs = Object.keys(this.fullPlayerInfo.empire_npcs).length;
    this.saveFullPlayerInfo();
    this.save();
    return isNew;
  }

  /**
   * Add multiple player names at once.
   * Returns count of new names added.
   */
  addMany(names: Iterable<string>): number {
    let added = 0;
    for (const name of names) {
      if (this.add(name)) {
        added++;
      }
    }
    return added;
  }

  /**
   * Check if a player name is known.
   * Uses normalized comparison for matching.
   */
  has(name: string): boolean {
    this.ensureLoaded();
    const normalized = this.normalize(name);
    return this.normalizedMap.has(normalized);
  }

  /**
   * Get all known player names.
   * Returns array of original (non-normalized) names.
   */
  getAll(): string[] {
    this.ensureLoaded();
    return Array.from(this.names).sort((a, b) => a.localeCompare(b));
  }

  /**
   * Get all known pirate names.
   * Returns array of original (non-normalized) names.
   */
  getAllPirates(): string[] {
    this.ensureLoaded();
    return Array.from(this.pirates).sort((a, b) => a.localeCompare(b));
  }

  /**
   * Get all known empire NPC names.
   * Returns array of original (non-normalized) names.
   */
  getAllEmpireNpcs(): string[] {
    this.ensureLoaded();
    return Array.from(this.empireNpcs).sort((a, b) => a.localeCompare(b));
  }

  /**
   * Get count of known player names.
   */
  count(): number {
    this.ensureLoaded();
    return this.names.size;
  }

  /**
   * Get count of known pirate names.
   */
  countPirates(): number {
    this.ensureLoaded();
    return this.pirates.size;
  }

  /**
   * Get count of known empire NPC names.
   */
  countEmpireNpcs(): number {
    this.ensureLoaded();
    return this.empireNpcs.size;
  }

  /**
   * Get detailed information for a player.
   * Returns EntityDetail or null if not found.
   */
  getPlayerDetail(name: string): EntityDetail | null {
    this.ensureLoaded();
    const normalized = this.normalize(name);
    return this.fullPlayerInfo.players[normalized] || null;
  }

  /**
   * Get detailed information for a pirate.
   * Returns EntityDetail or null if not found.
   */
  getPirateDetail(name: string): EntityDetail | null {
    this.ensureLoaded();
    const normalized = this.normalize(name);
    return this.fullPlayerInfo.pirates[normalized] || null;
  }

  /**
   * Get detailed information for an empire NPC.
   * Returns EntityDetail or null if not found.
   */
  getEmpireNpcDetail(name: string): EntityDetail | null {
    this.ensureLoaded();
    const normalized = this.normalize(name);
    return this.fullPlayerInfo.empire_npcs[normalized] || null;
  }

  /**
   * Get detailed information for any entity (player, pirate, or empire NPC).
   * Returns EntityDetail or null if not found.
   */
  getEntityDetail(name: string): EntityDetail | null {
    this.ensureLoaded();
    const normalized = this.normalize(name);
    return this.fullPlayerInfo.players[normalized] ||
           this.fullPlayerInfo.pirates[normalized] ||
           this.fullPlayerInfo.empire_npcs[normalized] ||
           null;
  }

  /**
   * Get all player details, sorted by name.
   */
  getAllPlayerDetails(): EntityDetail[] {
    this.ensureLoaded();
    return Object.values(this.fullPlayerInfo.players)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Get all pirate details, sorted by name.
   */
  getAllPirateDetails(): EntityDetail[] {
    this.ensureLoaded();
    return Object.values(this.fullPlayerInfo.pirates)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Get all empire NPC details, sorted by name.
   */
  getAllEmpireNpcDetails(): EntityDetail[] {
    this.ensureLoaded();
    return Object.values(this.fullPlayerInfo.empire_npcs)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Update an existing entity's details (for when we see them again with new info).
   * Returns true if entity was found and updated.
   */
  updateEntity(name: string, updates: Partial<Omit<EntityDetail, "name" | "type" | "normalized">>): boolean {
    this.ensureLoaded();
    const normalized = this.normalize(name);
    const now = new Date().toISOString();

    // Try each category
    for (const category of ["players", "pirates", "empire_npcs"] as const) {
      const entity = this.fullPlayerInfo[category][normalized];
      if (entity) {
        entity.faction = updates.faction || entity.faction;
        // Handle ship update with history tracking
        if (updates.ship !== undefined && updates.ship !== entity.ship) {
          this.updateShipWithHistory(entity, updates.ship, entity.lastSeen);
        }
        entity.system = updates.system || entity.system;
        entity.poi = updates.poi || entity.poi;
        entity.lastSeen = now;
        this.saveFullPlayerInfo();
        return true;
      }
    }
    return false;
  }

  /**
   * Search for entities by name (partial match, case-insensitive).
   * Returns array of EntityDetail matches.
   */
  search(query: string): EntityDetail[] {
    this.ensureLoaded();
    const queryLower = query.toLowerCase().trim();
    if (!queryLower) return [];

    const results: EntityDetail[] = [];
    for (const category of ["players", "pirates", "empire_npcs"] as const) {
      for (const entity of Object.values(this.fullPlayerInfo[category])) {
        if (entity.name.toLowerCase().includes(queryLower) ||
            entity.normalized.includes(queryLower)) {
          results.push(entity);
        }
      }
    }
    return results.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Get full player info data (for export or analysis).
   */
  getFullPlayerInfo(): FullPlayerInfoData {
    this.ensureLoaded();
    return JSON.parse(JSON.stringify(this.fullPlayerInfo));
  }

  /**
   * Save player names, pirates, and empire NPCs to disk.
   */
  private save(): void {
    try {
      const data = {
        names: this.getAll(),
        pirates: this.getAllPirates(),
        empire_npcs: this.getAllEmpireNpcs(),
        lastUpdated: new Date().toISOString(),
        count: this.names.size,
        pirate_count: this.pirates.size,
        empire_npc_count: this.empireNpcs.size,
      };
      writeFileSync(PLAYER_NAMES_FILE, JSON.stringify(data, null, 2), "utf-8");
      debugLogForBot(this._botName || "unknown", "playernames:save", `${this._botName || "unknown"}`, `Saved ${this.names.size} players, ${this.pirates.size} pirates, ${this.empireNpcs.size} empire NPCs`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[PlayerNameStore] Save failed: ${msg}`);
    }
  }

  /**
   * Clear all names (useful for testing).
   */
  clear(): void {
    this.names.clear();
    this.normalizedMap.clear();
    this.pirates.clear();
    this.pirateNormalizedMap.clear();
    this.empireNpcs.clear();
    this.empireNpcNormalizedMap.clear();
    this.fullPlayerInfo = {
      players: {},
      pirates: {},
      empire_npcs: {},
      lastUpdated: new Date().toISOString(),
      counts: { players: 0, pirates: 0, empire_npcs: 0 },
    };
    this.save();
    this.saveFullPlayerInfo();
  }
}

/** Singleton instance for global access */
export const playerNameStore = new PlayerNameStore();
