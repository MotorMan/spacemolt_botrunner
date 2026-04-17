// ── Rescue Cooperation Module ───────────────────────────────
/**
 * Enables coordination between two rescue bots via Bot Chat Channel.
 * This replaces the previous DM-based system for better reliability.
 * 
 * Message format (pipe-delimited, easy to parse):
 * RESCUE_CLAIM|<player>|<system>|<poi>|<timestamp>|<jumps>|<bot_name>
 * 
 * Example:
 * RESCUE_CLAIM|CaptJack|Market Prime Exchange|Station Alpha|2026-03-24T17:36:31.666Z|5|BotAlpha
 * 
 * Priority rules:
 * - Distance-based: closer bot (fewer jumps) takes priority
 * - Timestamps used to resolve ties and handle delayed messages
 */

import type { Bot } from "../bot.js";
import { readSettings } from "../routines/common.js";
import { getSystemBlacklist } from "../web/server.js";
import { mapStore } from "../mapstore.js";
import { getBotChatChannel } from "../botmanager.js";
import type { BotChatMessage, BotChatChannel } from "../bot_chat_channel.js";

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

/**
 * Record a rescue claim (from partner bot via Bot Chat Channel).
 */
export function recordRescueClaim(claim: RescueClaim): void {
  recentClaims.push(claim);
  cleanupExpiredClaims();
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
 * Send a rescue claim to the partner bot via Bot Chat Channel.
 * Uses the in-memory bot-to-bot chat for coordination (replaces DM system).
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
  
  console.log(`[Cooperation] Sending claim via Bot Chat: ${formattedClaim}`);
  
  try {
    // Send via Bot Chat Channel (coordination channel)
    const botChat = getBotChatChannel();
    botChat.send({
      sender: bot.username,
      recipients: [settings.partnerBotName], // Direct to partner
      channel: "coordination" as BotChatChannel,
      content: formattedClaim,
    });

    console.log(`[Cooperation] Claim sent via Bot Chat to ${settings.partnerBotName}`);
    
    // Also record locally
    recordRescueClaim(claim);

    return { ok: true };
  } catch (err) {
    console.log(`[Cooperation] Send error: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Register a handler to receive Bot Chat messages for rescue coordination.
 * Call this in the rescue routine to process incoming coordination messages.
 */
export function registerCooperationHandler(
  botUsername: string,
  handler: (message: BotChatMessage) => void
): void {
  const botChat = getBotChatChannel();
  botChat.onMessage(botUsername, handler);
}

/**
 * Unregister the cooperation handler.
 * Call this when the rescue routine stops.
 */
export function unregisterCooperationHandler(
  botUsername: string,
  handler: (message: BotChatMessage) => void
): void {
  const botChat = getBotChatChannel();
  botChat.offMessage(botUsername, handler);
}

/**
 * Process incoming Bot Chat messages for rescue claims.
 * Call this from the handler registered with registerCooperationHandler.
 */
export function processBotChatMessage(
  message: BotChatMessage
): ProcessPrivateMessageResult {
  const settings = getCooperationSettings();
  
  // Normalize names for comparison (case-insensitive, handle spaces/underscores)
  const normalizeName = (name: string) => name.toLowerCase().replace(/[\s_]/g, '').trim();
  const senderNormalized = normalizeName(message.sender);
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
    return { isClaim: false, claim: null, skipReason: `Sender "${message.sender}" does not match partner "${settings.partnerBotName}"` };
  }

  // Only process coordination channel messages
  if (message.channel !== "coordination") {
    return { isClaim: false, claim: null, skipReason: `Wrong channel: ${message.channel}` };
  }

  const claim = parseRescueClaim(message.content);
  if (claim) {
    recordRescueClaim(claim);
    console.log(`[Cooperation] Processed claim from Bot Chat: ${claim.player} at ${claim.system} (${claim.jumps} jumps) by ${claim.botName}`);
    return { isClaim: true, claim };
  }

  return { isClaim: false, claim: null, skipReason: 'Not a valid rescue claim format' };
}

/**
 * Calculate jumps to a target system, respecting the system blacklist.
 * Returns -1 if no valid route exists.
 */
export async function calculateJumpsToTarget(
  bot: Bot,
  targetSystem: string
): Promise<number> {
  if (bot.system === targetSystem) {
    return 0;
  }

  // First try mapStore with blacklist validation
  const blacklist = getSystemBlacklist();
  const mappedRoute = mapStore.findRoute(bot.system, targetSystem, blacklist);
  if (mappedRoute && mappedRoute.length > 1) {
    return mappedRoute.length - 1;
  }

  // No mapped route — try server route, but validate against blacklist
  try {
    const routeResp = await bot.exec("find_route", {
      target_system: targetSystem
    });

    if (!routeResp.error && routeResp.result) {
      const route = routeResp.result as Record<string, unknown>;
      const routeData = route.route as Array<{ system_id: string; name: string }> | undefined;

      if (routeData) {
        // Validate server route against blacklist
        const blacklistedOnRoute = routeData.find(
          (sys: { system_id: string; name: string }) => blacklist.some((b: string) => b.toLowerCase() === sys.system_id.toLowerCase())
        );
        if (blacklistedOnRoute) {
          // Server route passes through blacklisted system — reject it
          return -1;
        }
        return (route.total_jumps as number) || -1;
      }
    }
  } catch (e) {
    // Route calculation failed
  }

  return -1;
}

/**
 * Result of processing a private message for cooperation.
 */
export interface ProcessPrivateMessageResult {
  isClaim: boolean;
  claim: RescueClaim | null;
  skipReason?: string;
}
