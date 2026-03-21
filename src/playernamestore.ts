import { debugLog } from "./debug.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const PLAYER_NAMES_FILE = join(process.cwd(), "data", "playerNames.json");

/**
 * Persistent store for known player names.
 * Used to track every player we've seen via get_nearby, chat messages, combat, etc.
 * Names are deduplicated and normalized for consistent matching.
 */
export class PlayerNameStore {
  private names = new Set<string>();
  private normalizedMap = new Map<string, string>(); // normalized -> original
  private _botName: string | null = null;
  private _initialized = false;

  constructor() {
    // Load will be called synchronously on first use if not already loaded
  }

  /** Ensure data is loaded from disk (called lazily on first use) */
  private ensureLoaded(): void {
    if (!this._initialized) {
      this._initialized = true;
      // Synchronous load using Node fs module for reliability
      try {
        if (!existsSync(PLAYER_NAMES_FILE)) {
          debugLog("playernames:load", `${this._botName || "unknown"}`, "No existing file, starting fresh");
          return;
        }

        const text = readFileSync(PLAYER_NAMES_FILE, "utf-8");
        const data = JSON.parse(text) as { names: string[] };
        
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
          debugLog("playernames:load", `${this._botName || "unknown"}`, `Loaded ${this.names.size} names`);
        } else {
          debugLog("playernames:load", `${this._botName || "unknown"}`, "File exists but no names, starting fresh");
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[PlayerNameStore] Load failed: ${msg}`);
        // Start fresh on error
        this.names.clear();
        this.normalizedMap.clear();
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
   * Add a player name to the store.
   * Returns true if this is a new name (not previously seen).
   * Handles deduplication with normalization for special characters.
   */
  add(name: string): boolean {
    this.ensureLoaded();
    
    if (!name || typeof name !== "string") {
      return false;
    }

    const normalized = this.normalize(name);
    if (!normalized) {
      return false;
    }

    // Check if we already have this name (case-insensitive, normalized)
    if (this.normalizedMap.has(normalized)) {
      debugLog("playernames:add", `${this._botName || "unknown"}`, `Duplicate ignored: "${name}"`);
      return false;
    }

    // Add to both sets
    this.names.add(name);
    this.normalizedMap.set(normalized, name);
    
    debugLog("playernames:add", `${this._botName || "unknown"}`, `Added: "${name}" (total: ${this.names.size})`);
    
    // Persist to disk
    this.save();
    return true;
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
   * Get count of known player names.
   */
  count(): number {
    this.ensureLoaded();
    return this.names.size;
  }

  /**
   * Save player names to disk.
   */
  private save(): void {
    try {
      const data = {
        names: this.getAll(),
        lastUpdated: new Date().toISOString(),
        count: this.names.size,
      };
      writeFileSync(PLAYER_NAMES_FILE, JSON.stringify(data, null, 2), "utf-8");
      debugLog("playernames:save", `${this._botName || "unknown"}`, `Saved ${this.names.size} names`);
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
    this.save();
  }
}

/** Singleton instance for global access */
export const playerNameStore = new PlayerNameStore();
