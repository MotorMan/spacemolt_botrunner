/**
 * Customs Inspection Service
 * 
 * Handles Confederacy Customs inspections when entering empire systems.
 * - Detects customs chat messages
 * - Waits for scan completion
 * - Logs statistics to customsStops.json
 * - Scans customs ships when they arrive
 * - Coordinates with AI Chat service for personality-based responses
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import type { Bot } from "../bot.js";

// Simple sleep helper to avoid circular dependency with common.ts
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Types ────────────────────────────────────────────────────

export interface CustomsStats {
  version: 1;
  botTotals: Record<string, number>; // botName -> total stops across all systems
  systemTotals: Record<string, number>; // systemId -> total stops by all bots
}

export interface NearbyShip {
  name: string;
  type: string;
  distance: number;
  playerId?: string;
}

// ── Constants ────────────────────────────────────────────────

const CUSTOMS_STOP_KEYWORDS = [
  "CUSTOMS",
  "Confederacy Customs",
  "Full-spectrum cargo scan",
  "Remain stationary",
  "inspection",
  "cargo scan",
  "scan underway",
  "Please wait",
  "hold contents",
  "database",
];

const CUSTOMS_CLEAR_KEYWORDS = [
  "Scan complete",
  "cargo is compliant",
  "cleared to proceed",
  "Safe travels",
  "is cleared",
  "items verified",
  "verified against",
  "Carry on",
  "hold checks out",
  "Inspection concluded",
  "free to continue",
  "nothing of concern",
  "verification complete",
];

const CUSTOMS_EVASION_KEYWORDS = [
  "declined to remain",
  "Noted and logged",
  "evasion",
];

// Contraband detection requires specific phrases indicating contraband was FOUND
// Not just mentioned (e.g., "contraband database" is NOT a contraband detection)
const CUSTOMS_CONTRABAND_KEYWORDS = [
  "found contraband",
  "contraband detected",
  "contraband found",
  "illegal goods",
  "illegal items",
  "violation detected",
  "penalty imposed",
  "fine issued",
  "cargo seized",
  "you are in possession",
];

const CUSTOMS_SHIP_KEYWORDS = [
  "CUSTOMS",
  "Customs",
  "Police",
  "Enforcement",
];

const DATA_DIR = join(process.cwd(), "data");
const CUSTOMS_FILE = join(DATA_DIR, "customsStops.json");

// ── Data persistence ─────────────────────────────────────────

function loadCustomsStats(): CustomsStats {
  try {
    if (existsSync(CUSTOMS_FILE)) {
      const data = JSON.parse(readFileSync(CUSTOMS_FILE, "utf-8")) as CustomsStats;
      return data;
    }
  } catch (err) {
    console.error("Error loading customs stats:", err);
  }
  
  return {
    version: 1,
    botTotals: {},
    systemTotals: {},
  };
}

function saveCustomsStats(stats: CustomsStats): void {
  try {
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }
    writeFileSync(CUSTOMS_FILE, JSON.stringify(stats, null, 2) + "\n", "utf-8");
  } catch (err) {
    console.error("Error saving customs stats:", err);
  }
}

/** Log a customs stop to the statistics file. */
export function logCustomsStop(
  botName: string,
  system: string,
  outcome: "cleared" | "contraband" | "evasion" | "pending" = "pending"
): void {
  const stats = loadCustomsStats();

  // Update bot totals
  stats.botTotals[botName] = (stats.botTotals[botName] || 0) + 1;

  // Update system totals
  stats.systemTotals[system] = (stats.systemTotals[system] || 0) + 1;

  saveCustomsStats(stats);
}

/** Get customs statistics for a specific bot (for AI chat context). */
export function getBotCustomsStats(botName: string): {
  totalStops: number;
} {
  const stats = loadCustomsStats();

  return {
    totalStops: stats.botTotals[botName] || 0,
  };
}

// ── Customs detection ────────────────────────────────────────

/**
 * Check if a chat message is from customs and requires stopping.
 * Returns the type of customs message detected.
 */
export function detectCustomsMessage(content: string): {
  type: "stop_request" | "evasion_warning" | "cleared" | "contraband" | "none";
  matchedKeywords: string[];
} {
  const lowerContent = content.toLowerCase();

  // Check for contraband detection (highest priority) - must be specific phrases
  const contrabandMatches = CUSTOMS_CONTRABAND_KEYWORDS.filter(k => lowerContent.includes(k.toLowerCase()));
  if (contrabandMatches.length > 0) {
    return { type: "contraband", matchedKeywords: contrabandMatches };
  }

  // Check for clearance message
  const clearMatches = CUSTOMS_CLEAR_KEYWORDS.filter(k => lowerContent.includes(k.toLowerCase()));
  if (clearMatches.length > 0) {
    return { type: "cleared", matchedKeywords: clearMatches };
  }

  // Check for evasion warning
  const evasionMatches = CUSTOMS_EVASION_KEYWORDS.filter(k => lowerContent.includes(k.toLowerCase()));
  if (evasionMatches.length > 0) {
    return { type: "evasion_warning", matchedKeywords: evasionMatches };
  }

  // Check for stop request (scan in progress)
  const stopMatches = CUSTOMS_STOP_KEYWORDS.filter(k => lowerContent.includes(k.toLowerCase()));
  if (stopMatches.length > 0) {
    return { type: "stop_request", matchedKeywords: stopMatches };
  }

  return { type: "none", matchedKeywords: [] };
}

/** Check if a ship name belongs to customs/police. */
export function isCustomsShip(shipName: string): boolean {
  const lowerName = shipName.toLowerCase();
  return CUSTOMS_SHIP_KEYWORDS.some(k => lowerName.includes(k.toLowerCase()));
}

// ── Customs inspection handler ───────────────────────────────

/**
 * Check if a chat message mentions the bot's ship name.
 * Only trigger customs handling when the bot is specifically addressed.
 */
function messageMentionsBotShip(content: string, botShipName: string): boolean {
  if (!botShipName) return false;
  
  const lowerContent = content.toLowerCase();
  const lowerShipName = botShipName.toLowerCase();
  
  // Check for exact ship name match
  if (lowerContent.includes(lowerShipName)) return true;
  
  // Check for ship name without spaces (handles some formatting variations)
  const shipNameNoSpaces = lowerShipName.replace(/\s+/g, "");
  if (shipNameNoSpaces && lowerContent.includes(shipNameNoSpaces)) return true;
  
  return false;
}

/**
 * Wait for customs inspection to complete.
 * Should be called when entering a new system.
 *
 * @param bot - The bot instance
 * @param log - Logging function
 * @param targetSystem - The system we jumped to (use this instead of bot.system which may be unstable during jumps)
 * @param maxWaitMs - Maximum time to wait for customs message (default 5000ms)
 * @returns Object with inspection result
 */
export async function waitForCustomsInspection(
  bot: Bot,
  log: (category: string, message: string) => void,
  targetSystem: string,
  maxWaitMs: number = 5000
): Promise<{
  wasStopped: boolean;
  outcome: "cleared" | "contraband" | "evasion" | "timeout" | "none";
  chatMessages: string[];
}> {
  const chatMessages: string[] = [];
  let wasStopped = false;
  let outcome: "cleared" | "contraband" | "evasion" | "timeout" | "none" = "none";
  let stopRequestProcessed = false;
  let clearanceProcessed = false;

  log("customs", "Waiting for potential customs inspection...");

  // Wait for customs message (1-5 seconds)
  const startTime = Date.now();
  const initialWaitMs = 1000; // Minimum wait for customs message

  await sleep(initialWaitMs);

  // Check bot's recent chat log for customs messages mentioning THIS bot's ship
  const recentLogs = bot.actionLog.slice(-50); // Last 50 log entries
  const customsLogs = recentLogs.filter((line: string) => {
    if (!line.includes("[chat]")) return false;
    if (!line.includes("CUSTOMS")) return false;
    // Only process messages that mention this bot's ship name
    return messageMentionsBotShip(line, bot.shipName);
  });

  if (customsLogs.length > 0) {
    wasStopped = true;
    log("customs", `Customs stop detected! Messages: ${customsLogs.length}`);

    // Process only the FIRST stop_request message to avoid duplicate AI responses
    for (const logLine of customsLogs) {
      chatMessages.push(logLine);

      // Detect message type
      const msgMatch = logLine.match(/\[chat\].*CUSTOMS.*:\s*(.*)/i);
      if (msgMatch) {
        const content = msgMatch[1];
        const detection = detectCustomsMessage(content);

        // Only process the first stop_request - ignore duplicates
        if (detection.type === "stop_request" && !stopRequestProcessed) {
          stopRequestProcessed = true;
          outcome = "timeout"; // Still waiting
          log("customs", `🛑 CUSTOMS HOLD: Awaiting inspection at ${targetSystem}`);
        } else if (detection.type === "stop_request" && stopRequestProcessed) {
          // Skip duplicate stop requests
          log("customs_debug", "Skipping duplicate customs stop request");
        } else if (detection.type === "cleared" && !clearanceProcessed) {
          clearanceProcessed = true;
          outcome = "cleared";
        } else if (detection.type === "contraband" && !clearanceProcessed) {
          clearanceProcessed = true;
          outcome = "contraband";
        } else if (detection.type === "evasion_warning" && !clearanceProcessed) {
          clearanceProcessed = true;
          outcome = "evasion";
        }
      }
    }

    // If we got a stop request, wait for completion
    if (outcome === "timeout") {
      log("customs", "⏳ Customs hold ACTIVE - blocking travel until clearance...");

      // Poll for completion (up to maxWaitMs total)
      while (Date.now() - startTime < maxWaitMs) {
        await sleep(1000);

        const updatedLogs = bot.actionLog.slice(-20);
        const newCustomsLogs = updatedLogs.filter((line: string) => {
          if (!line.includes("[chat]")) return false;
          if (!line.includes("CUSTOMS")) return false;
          // Only process messages that mention this bot's ship name
          return messageMentionsBotShip(line, bot.shipName);
        });

        for (const logLine of newCustomsLogs) {
          if (!chatMessages.includes(logLine)) {
            chatMessages.push(logLine);

            const msgMatch = logLine.match(/\[chat\].*CUSTOMS.*:\s*(.*)/i);
            if (msgMatch) {
              const content = msgMatch[1];
              const detection = detectCustomsMessage(content);

              // Only process clearance/contraband if we haven't already
              if ((detection.type === "cleared" || detection.type === "contraband") && !clearanceProcessed) {
                clearanceProcessed = true;
                if (detection.type === "cleared") {
                  outcome = "cleared";
                  log("customs", "Customs scan complete - cleared!");
                } else {
                  outcome = "contraband";
                  log("customs", "CUSTOMS: CONTRABAND DETECTED!");
                }
                break;
              } else if (detection.type === "stop_request" && stopRequestProcessed) {
                // Ignore additional stop requests while hold is active
                log("customs_debug", "Ignoring duplicate stop request - hold already active");
              }
            }
          }
        }

        if (outcome === "cleared" || outcome === "contraband") {
          break;
        }
      }

      if (outcome === "timeout") {
        log("customs", "⏰ Customs scan timeout - proceeding");
      }
    }

    // Log the stop
    if (wasStopped) {
      const logOutcome: "cleared" | "contraband" | "evasion" | "pending" =
        outcome === "timeout" || outcome === "none" ? "cleared" : outcome;
      logCustomsStop(bot.username, targetSystem, logOutcome);
    }
  } else {
    log("customs", "No customs inspection required");
  }

  return { wasStopped, outcome, chatMessages };
}

// ── Customs ship scanning ────────────────────────────────────

/**
 * Poll for nearby ships and detect customs/police arrivals.
 * Should be called periodically when waiting for customs.
 */
export async function pollForCustomsShip(
  bot: Bot,
  log: (category: string, message: string) => void,
  pollIntervalMs: number = 5000,
  maxPolls: number = 10
): Promise<{
  customsShipFound: boolean;
  shipName: string | null;
  scanResult: string | null;
}> {
  let customsShipFound = false;
  let shipName: string | null = null;
  let scanResult: string | null = null;
  
  log("customs", `Polling for customs ships (interval: ${pollIntervalMs}ms, max: ${maxPolls} polls)`);
  
  for (let i = 0; i < maxPolls; i++) {
    await sleep(pollIntervalMs);
    
    const resp = await bot.exec("get_nearby", {});
    if (resp.error) {
      log("customs", `Failed to get nearby ships: ${resp.error.message}`);
      continue;
    }
    
    const result = resp.result as Record<string, unknown> | undefined;
    const ships = (result?.ships as Array<Record<string, unknown>>) || [];
    
    for (const ship of ships) {
      const name = (ship.name as string) || "";
      const type = (ship.type as string) || "";
      
      if (isCustomsShip(name) || isCustomsShip(type)) {
        customsShipFound = true;
        shipName = name;
        log("customs", `🚨 Customs ship detected: ${name} (${type})`);
        
        // Scan the customs ship
        scanResult = await scanCustomsShip(bot, name, log);
        return { customsShipFound, shipName, scanResult };
      }
    }
  }
  
  log("customs", "No customs ships detected during polling");
  return { customsShipFound, shipName, scanResult };
}

/**
 * Scan a customs/police ship.
 */
export async function scanCustomsShip(
  bot: Bot,
  shipName: string,
  log: (category: string, message: string) => void
): Promise<string | null> {
  log("customs", `Scanning customs ship: ${shipName}`);
  
  const resp = await bot.exec("scan", { target: shipName });
  if (resp.error) {
    log("customs", `Scan failed: ${resp.error.message}`);
    return null;
  }
  
  const result = resp.result as Record<string, unknown> | undefined;
  const scanMessage = (result?.message as string) || (result?.scan_result as string) || "";
  
  log("customs", `Scan result: ${scanMessage}`);
  return scanMessage;
}

// ── AI Chat integration ──────────────────────────────────────

/**
 * Send a chat response to customs via AI Chat service.
 */
export async function sendCustomsChatResponse(
  bot: Bot,
  log: (category: string, message: string) => void,
  context: {
    messageType: "stop_request" | "cleared" | "contraband" | "evasion";
    customsMessage: string;
    botStops: number;
  }
): Promise<void> {
  const aiChatService = (globalThis as any).aiChatService;
  
  if (!aiChatService || typeof aiChatService.triggerCustomsResponse !== "function") {
    log("customs", "AI Chat service not available for customs response");
    return;
  }
  
  try {
    await aiChatService.triggerCustomsResponse(bot.username, context);
    log("customs", "Customs response sent via AI Chat");
  } catch (err) {
    log("customs", `Failed to send customs response: ${err}`);
  }
}

// ── Empire system detection ─────────────────────────────────

/**
 * Check if the current system belongs to an empire that has customs/police.
 * Frontier empire does NOT have customs scans (per developer confirmation).
 * 
 * @param systemId - The system ID to check
 * @param botEmpire - The bot's empire affiliation (optional, for extra filtering)
 */
export function isEmpireSystem(systemId: string, botEmpire?: string): boolean {
  // Frontier empire has NO customs or police scans
  if (botEmpire && botEmpire.toLowerCase() === "frontier") {
    return false;
  }

  // Pirate systems have no customs (hostile territory)
  const pirateSystems = [
    "alhena",
    "xamidimura",
    "algol",
    "zaniah",
    "sheratan",
    "bellatrix",
    "barnard_44",
    "gsc_0008",
    "gliese_581",
  ];

  const lower = systemId.toLowerCase();
  return !pirateSystems.some(ps => lower === ps || lower.includes(ps));
}
