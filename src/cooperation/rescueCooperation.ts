// ── Rescue Cooperation Module ───────────────────────────────
/**
 * Enables coordination between two rescue bots via private messages.
 * 
 * Message format (pipe-delimited, easy to parse):
 * RESCUE_CLAIM|<player>|<system>|<timestamp>|<jumps>|<bot_name>
 * 
 * Example:
 * RESCUE_CLAIM|CaptJack|Market Prime Exchange|2026-03-24T17:36:31.666Z|5|BotAlpha
 * 
 * Priority rules:
 * - Distance-based: closer bot (fewer jumps) takes priority
 * - Timestamps used to resolve ties and handle delayed messages
 */

import type { Bot } from "../bot.js";
import { readSettings } from "../routines/common.js";

// ── Types ────────────────────────────────────────────────────

export interface RescueClaim {
  type: "RESCUE_CLAIM";
  player: string;
  system: string;
  poi?: string;
  timestamp: string; // ISO 8601 format
  jumps: number;
  botName: string;
}

export interface CooperationSettings {
  enabled: boolean;
  partnerBotName: string;
  maxDelaySeconds: number; // Max acceptable delay for claims (default: 30s)
}

// ── In-memory claim tracking ────────────────────────────────

const recentClaims: RescueClaim[] = [];
const CLAIM_EXPIRY_MS = 5 * 60 * 1000; // Claims expire after 5 minutes

// Cache for partner bot's player ID (hex ID used by game API)
// Key: bot username, Value: player ID (hex string)
const partnerBotIds = new Map<string, string>();

/**
 * Record a rescue claim (from partner bot).
 */
export function recordRescueClaim(claim: RescueClaim): void {
  recentClaims.push(claim);
  cleanupExpiredClaims();
}

/**
 * Cache the partner bot's player ID for sending private messages.
 * Called when we receive a private message from the partner.
 */
export function cachePartnerBotId(botUsername: string, playerId: string): void {
  const settings = getCooperationSettings();
  if (botUsername === settings.partnerBotName) {
    partnerBotIds.set(botUsername, playerId);
    console.log(`[Cooperation] Cached player ID for ${botUsername}: ${playerId}`);
  }
}

/**
 * Get the cached player ID for the partner bot.
 */
export function getPartnerBotId(): string | undefined {
  const settings = getCooperationSettings();
  return partnerBotIds.get(settings.partnerBotName);
}

/**
 * Check if a rescue is already claimed by partner bot.
 * Returns the claim if found and valid, null otherwise.
 */
export function isRescueClaimedByPartner(
  player: string,
  system: string,
  poi?: string,
  excludeBot?: string
): RescueClaim | null {
  const now = Date.now();

  // Normalize for comparison
  const normalize = (s: string) => s.toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

  console.log(`[Cooperation] Checking for partner claims: player="${player}", system="${system}", poi="${poi || 'any'}"`);
  console.log(`[Cooperation] Current active claims: ${recentClaims.length}`);
  
  for (const claim of recentClaims) {
    // Skip expired claims
    const claimTime = new Date(claim.timestamp).getTime();
    if (now - claimTime > CLAIM_EXPIRY_MS) {
      continue;
    }

    // Skip claims from excluded bot
    if (excludeBot && claim.botName === excludeBot) {
      continue;
    }

    // Check if this matches the target
    const playerMatch = normalize(claim.player) === normalize(player);
    const systemMatch = normalize(claim.system) === normalize(system);
    
    // POI matching is optional
    const poiMatch = !poi || !claim.poi || normalize(claim.poi) === normalize(poi);

    console.log(`[Cooperation] Checking claim: ${claim.player} at ${claim.system}/${claim.poi || 'any'} by ${claim.botName} (${claim.jumps} jumps) - playerMatch=${playerMatch}, systemMatch=${systemMatch}, poiMatch=${poiMatch}`);

    if (playerMatch && systemMatch && poiMatch) {
      console.log(`[Cooperation] FOUND matching claim from ${claim.botName}`);
      return claim;
    }
  }

  console.log(`[Cooperation] No matching partner claim found`);
  return null;
}

/**
 * Determine if this bot should proceed with rescue or yield to partner.
 * 
 * Returns:
 * - "proceed": This bot should handle the rescue
 * - "yield": Partner bot should handle it (they're closer)
 * - "uncertain": Can't determine (e.g., no partner claim yet)
 */
export function shouldProceedOrYield(
  myClaim: RescueClaim,
  partnerClaim: RescueClaim | null
): "proceed" | "yield" | "uncertain" {
  if (!partnerClaim) {
    return "proceed"; // No competition
  }

  // Compare jump distances - closer bot wins
  if (myClaim.jumps < partnerClaim.jumps) {
    return "proceed"; // We're closer
  } else if (myClaim.jumps > partnerClaim.jumps) {
    return "yield"; // Partner is closer
  } else {
    // Same distance - use timestamp as tiebreaker
    // Earlier claim wins (but account for potential delays)
    const myTime = new Date(myClaim.timestamp).getTime();
    const partnerTime = new Date(partnerClaim.timestamp).getTime();
    const timeDiff = Math.abs(myTime - partnerTime);
    
    // If claims are within 5 seconds, consider it a tie - let both decide independently
    // This prevents both bots from yielding in case of near-simultaneous claims
    if (timeDiff < 5000) {
      return "proceed"; // Both go for it, first to arrive wins
    }
    
    return myTime < partnerTime ? "proceed" : "yield";
  }
}

/**
 * Clean up expired claims.
 */
export function cleanupExpiredClaims(): void {
  const now = Date.now();
  const valid = recentClaims.filter(c => {
    const claimTime = new Date(c.timestamp).getTime();
    return now - claimTime < CLAIM_EXPIRY_MS;
  });
  
  if (valid.length !== recentClaims.length) {
    recentClaims.length = 0;
    recentClaims.push(...valid);
  }
}

/**
 * Get all active claims (for debugging).
 */
export function getActiveClaims(): RescueClaim[] {
  const now = Date.now();
  return recentClaims.filter(c => {
    const claimTime = new Date(c.timestamp).getTime();
    return now - claimTime < CLAIM_EXPIRY_MS;
  });
}

// ── Message formatting ──────────────────────────────────────

/**
 * Format a rescue claim as a pipe-delimited string.
 * Format: RESCUE_CLAIM|player|system|poi|timestamp|jumps|bot_name
 */
export function formatRescueClaim(claim: RescueClaim): string {
  const poi = claim.poi || "unknown";
  return `RESCUE_CLAIM|${claim.player}|${claim.system}|${poi}|${claim.timestamp}|${claim.jumps}|${claim.botName}`;
}

/**
 * Parse a pipe-delimited rescue claim string.
 * Returns null if parsing fails.
 */
export function parseRescueClaim(message: string): RescueClaim | null {
  const parts = message.split('|');
  
  if (parts.length < 7) {
    return null;
  }

  const [type, player, system, poi, timestamp, jumpsStr, botName] = parts;

  if (type !== "RESCUE_CLAIM") {
    return null;
  }

  const jumps = parseInt(jumpsStr, 10);
  if (isNaN(jumps)) {
    return null;
  }

  // Validate timestamp format (ISO 8601)
  const parsedTime = Date.parse(timestamp);
  if (isNaN(parsedTime)) {
    return null;
  }

  return {
    type: "RESCUE_CLAIM",
    player: player.trim(),
    system: system.trim(),
    poi: poi === "unknown" ? undefined : poi.trim(),
    timestamp,
    jumps,
    botName: botName.trim(),
  };
}

// ── Settings helpers ────────────────────────────────────────

/**
 * Get cooperation settings from rescue configuration.
 */
export function getCooperationSettings(): CooperationSettings {
  const all = readSettings();
  const rescue = all.rescue || {};
  
  return {
    enabled: (rescue.cooperationEnabled as boolean) ?? false,
    partnerBotName: (rescue.partnerBotName as string) || "",
    maxDelaySeconds: (rescue.cooperationMaxDelaySeconds as number) || 30,
  };
}

/**
 * Check if cooperation is enabled and partner is configured.
 */
export function isCooperationEnabled(): boolean {
  const settings = getCooperationSettings();
  return settings.enabled && settings.partnerBotName.length > 0;
}

// ── Bot integration helpers ─────────────────────────────────

/**
 * Send a rescue claim to the partner bot via private message.
 * Uses the bot's exec() method to send a private chat message.
 */
export async function sendRescueClaim(
  bot: Bot,
  claim: RescueClaim
): Promise<{ ok: boolean; error?: string }> {
  const settings = getCooperationSettings();

  if (!settings.partnerBotName) {
    return { ok: false, error: "Partner bot name not configured" };
  }

  const formattedClaim = formatRescueClaim(claim);
  
  console.log(`[Cooperation] Sending claim: ${formattedClaim}`);
  
  // Try to get cached player ID for the partner bot
  let targetId = getPartnerBotId();
  
  if (!targetId) {
    // No cached ID - try using username as fallback (works sometimes)
    targetId = settings.partnerBotName;
    console.log(`[Cooperation] No cached player ID, using username as fallback: ${targetId}`);
  } else {
    console.log(`[Cooperation] Using cached player ID: ${targetId}`);
  }

  try {
    // Send as private message
    const chatResp = await bot.exec("chat", {
      channel: "private",
      target_id: targetId,
      content: formattedClaim,
    });

    if (chatResp.error) {
      console.log(`[Cooperation] Send failed: ${chatResp.error.message}`);
      return { ok: false, error: chatResp.error.message };
    }

    console.log(`[Cooperation] Claim sent successfully to ${settings.partnerBotName}`);
    
    // Also record locally
    recordRescueClaim(claim);

    return { ok: true };
  } catch (err) {
    console.log(`[Cooperation] Send error: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Result of processing a private message for cooperation.
 */
export interface ProcessPrivateMessageResult {
  isClaim: boolean;
  claim: RescueClaim | null;
  skipReason?: string;
}

/**
 * Parse incoming private messages for rescue claims.
 * Call this when processing private messages from the partner bot.
 */
export function processPrivateMessage(
  sender: string,
  content: string,
  senderId?: string
): ProcessPrivateMessageResult {
  const settings = getCooperationSettings();
  
  // Normalize names for comparison (case-insensitive, handle spaces/underscores)
  const normalizeName = (name: string) => name.toLowerCase().replace(/[\s_]/g, '').trim();
  const senderNormalized = normalizeName(sender);
  const partnerNormalized = normalizeName(settings.partnerBotName);
  
  // Check if cooperation is enabled
  if (!settings.enabled) {
    return { isClaim: false, claim: null, skipReason: 'Cooperation is disabled' };
  }
  
  // Check if partner bot name is configured
  if (!settings.partnerBotName || settings.partnerBotName.trim() === '') {
    return { isClaim: false, claim: null, skipReason: 'Partner bot name not configured' };
  }
  
  // Only process messages from partner bot (case-insensitive comparison)
  if (senderNormalized !== partnerNormalized) {
    return { isClaim: false, claim: null, skipReason: `Sender "${sender}" does not match partner "${settings.partnerBotName}"` };
  }

  // Cache the sender's player ID if provided (for sending replies)
  if (senderId) {
    cachePartnerBotId(sender, senderId);
  }

  const claim = parseRescueClaim(content);
  if (claim) {
    recordRescueClaim(claim);
    return { isClaim: true, claim };
  }

  return { isClaim: false, claim: null, skipReason: 'Not a valid rescue claim format' };
}

/**
 * Calculate jumps to a target system.
 * Returns -1 if route cannot be calculated.
 */
export async function calculateJumpsToTarget(
  bot: Bot,
  targetSystem: string
): Promise<number> {
  if (bot.system === targetSystem) {
    return 0;
  }

  try {
    const routeResp = await bot.exec("find_route", { 
      target_system: targetSystem 
    });
    
    if (!routeResp.error && routeResp.result) {
      const route = routeResp.result as Record<string, unknown>;
      return (route.total_jumps as number) || -1;
    }
  } catch (e) {
    // Route calculation failed
  }

  return -1;
}
