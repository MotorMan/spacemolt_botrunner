import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { getBotChatChannel } from "../botmanager.js";
import type { BotChatMessage } from "../bot_chat_channel.js";

/**
 * Miner coordination state stored in minerCoordination.json
 */
export interface MinerCoordinationState {
  /// Map of systemId to set of bot usernames going there
  systemAssignments: Record<string, string[]>;
  /// Map of poiId to set of bot usernames going there
  poiAssignments: Record<string, string[]>;
  /// Last update timestamp
  lastUpdate: number;
}

/**
 * Default coordination state file path
 */
const COORDINATION_FILE = join(process.cwd(), "data", "minerCoordination.json");

/**
 * Load miner coordination state from file
 */
export function loadMinerCoordination(): MinerCoordinationState {
  try {
    if (existsSync(COORDINATION_FILE)) {
      const data = readFileSync(COORDINATION_FILE, "utf-8");
      const parsed = JSON.parse(data) as MinerCoordinationState;
      // Clean up stale entries (older than 5 minutes)
      const now = Date.now();
      const staleThreshold = 5 * 60 * 1000; // 5 minutes
      if (now - parsed.lastUpdate > staleThreshold) {
        return { systemAssignments: {}, poiAssignments: {}, lastUpdate: now };
      }
      return parsed;
    }
  } catch {
    // Ignore errors, return default
  }
  return { systemAssignments: {}, poiAssignments: {}, lastUpdate: Date.now() };
}

/**
 * Save miner coordination state to file
 */
export function saveMinerCoordination(state: MinerCoordinationState): void {
  try {
    const dir = join(process.cwd(), "data");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(COORDINATION_FILE, JSON.stringify(state, null, 2), "utf-8");
  } catch (err) {
    console.error("[MinerCoordination] Failed to save coordination state:", err);
  }
}

/**
 * Announce that a miner is going to a specific system (for coordination)
 */
export function announceMinerTarget(botUsername: string, systemId: string, poiId?: string): void {
  const chatChannel = getBotChatChannel();
  chatChannel.send({
    sender: botUsername,
    recipients: [],
    channel: "coordination",
    content: `TARGET:${systemId}${poiId ? `:${poiId}` : ""}`,
  });
}

/**
 * Query how many miners are going to a specific system (excluding ourselves)
 */
export function getMinerCountForSystem(systemId: string, excludeBot?: string): number {
  const state = loadMinerCoordination();
  const miners = state.systemAssignments[systemId] || [];
  return miners.filter(bot => bot !== excludeBot).length;
}

/**
 * Check if a system has too many miners assigned
 */
export function isSystemOvercrowded(systemId: string, maxBots: number, excludeBot?: string): boolean {
  return getMinerCountForSystem(systemId, excludeBot) >= maxBots;
}

/**
 * Register a miner's target in the coordination system
 */
export function registerMinerTarget(botUsername: string, systemId: string, poiId?: string): void {
  const state = loadMinerCoordination();
  
  // Add to system assignments
  if (!state.systemAssignments[systemId]) {
    state.systemAssignments[systemId] = [];
  }
  if (!state.systemAssignments[systemId].includes(botUsername)) {
    state.systemAssignments[systemId].push(botUsername);
  }
  
  // Add to POI assignments if provided
  if (poiId) {
    if (!state.poiAssignments[poiId]) {
      state.poiAssignments[poiId] = [];
    }
    if (!state.poiAssignments[poiId].includes(botUsername)) {
      state.poiAssignments[poiId].push(botUsername);
    }
  }
  
  state.lastUpdate = Date.now();
  saveMinerCoordination(state);
}

/**
 * Unregister a miner's target from the coordination system
 */
export function unregisterMinerTarget(botUsername: string, systemId: string, poiId?: string): void {
  const state = loadMinerCoordination();
  
  // Remove from system assignments
  if (state.systemAssignments[systemId]) {
    state.systemAssignments[systemId] = state.systemAssignments[systemId].filter(bot => bot !== botUsername);
    if (state.systemAssignments[systemId].length === 0) {
      delete state.systemAssignments[systemId];
    }
  }
  
  // Remove from POI assignments if provided
  if (poiId && state.poiAssignments[poiId]) {
    state.poiAssignments[poiId] = state.poiAssignments[poiId].filter(bot => bot !== botUsername);
    if (state.poiAssignments[poiId].length === 0) {
      delete state.poiAssignments[poiId];
    }
  }
  
  state.lastUpdate = Date.now();
  saveMinerCoordination(state);
}

/**
 * Get all systems sorted by miner count (most to least)
 */
export function getSystemsByMinerCount(): string[] {
  const state = loadMinerCoordination();
  return Object.entries(state.systemAssignments)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([systemId]) => systemId);
}

// Setup coordination message handler when this module is imported
const chatChannel = getBotChatChannel();
chatChannel.onGlobalMessage((msg: BotChatMessage) => {
  if (msg.channel === "coordination") {
    // Handle TARGET announcements
    if (msg.content.startsWith("TARGET:")) {
      const targetStr = msg.content.slice(7); // Remove "TARGET:" prefix
      const parts = targetStr.split(":");
      const systemId = parts[0];
      const poiId = parts.length > 1 ? parts[1] : undefined;
      
      registerMinerTarget(msg.sender, systemId, poiId);
    }
  }
});