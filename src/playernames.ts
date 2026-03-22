/**
 * Player name verification utility.
 * Loads known player names from data/playerNames.json to help identify
 * legitimate players vs potential ambushes.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

const PLAYER_NAMES_FILE = join(process.cwd(), "data", "playerNames.json");

let cachedNames: Set<string> | null = null;
let lastLoadTime = 0;
const CACHE_DURATION_MS = 30000; // Reload every 30 seconds

/**
 * Load known player names from the JSON file.
 * Returns a Set of lowercase player names for case-insensitive matching.
 */
export function loadPlayerNames(): Set<string> {
  try {
    if (!existsSync(PLAYER_NAMES_FILE)) {
      return new Set();
    }

    const content = readFileSync(PLAYER_NAMES_FILE, "utf-8");
    const data = JSON.parse(content);
    
    const names = Array.isArray(data.names) ? data.names : [];
    // Store lowercase versions for case-insensitive matching
    return new Set(names.map((n: string) => n.toLowerCase()));
  } catch (err) {
    console.warn("Could not load playerNames.json:", err);
    return new Set();
  }
}

/**
 * Get the set of known player names (cached).
 */
function getKnownNamesSet(): Set<string> {
  const now = Date.now();
  
  // Reload if cache is stale or not loaded
  if (!cachedNames || (now - lastLoadTime) > CACHE_DURATION_MS) {
    cachedNames = loadPlayerNames();
    lastLoadTime = now;
  }
  
  return cachedNames;
}

/**
 * Check if a player name is known (has been seen before).
 * Performs case-insensitive matching.
 * 
 * @param playerName - The player name to check
 * @returns true if the player is known, false otherwise
 */
export function isKnownPlayer(playerName: string): boolean {
  if (!playerName) return false;
  
  const knownNames = getKnownNamesSet();
  const normalizedName = playerName.toLowerCase().trim();
  
  // Check exact match
  if (knownNames.has(normalizedName)) {
    return true;
  }
  
  // Check if any known name contains this name (handles partial matches)
  for (const known of knownNames) {
    if (known.includes(normalizedName) || normalizedName.includes(known)) {
      return true;
    }
  }
  
  return false;
}

/**
 * Get the count of known players.
 */
export function getKnownPlayerCount(): number {
  return getKnownNamesSet().size;
}

/**
 * Force reload of player names (useful after file is updated).
 */
export function reloadPlayerNames(): void {
  cachedNames = loadPlayerNames();
  lastLoadTime = Date.now();
}
