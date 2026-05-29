/**
 * Salvage cooperation via Bot Chat Channel.
 * Lightweight claiming so multiple independent salvagers (non-flock)
 * don't all pounce on the same wrecks and strip them before anyone can tow.
 *
 * Uses the in-memory "coordination" channel (works for all bots in same botrunner process).
 */

import { getBotChatChannel } from "../botmanager.js";
import type { BotChatMessage, BotChatChannel } from "../bot_chat_channel.js";

export interface SalvageClaim {
  wreckId: string;
  poiId: string;
  action: "loot" | "tow" | "release";
  by: string;
  at: number;
}

const claims = new Map<string, SalvageClaim>(); // key = wreckId
const CLAIM_TTL_MS = 180_000; // 3 minutes

function cleanupClaims(): void {
  const now = Date.now();
  for (const [k, c] of claims) {
    if (now - c.at > CLAIM_TTL_MS) claims.delete(k);
  }
}

export function isWreckClaimedByOther(wreckId: string, myUsername: string): boolean {
  cleanupClaims();
  const c = claims.get(wreckId);
  if (!c) return false;
  return c.by !== myUsername;
}

export function getClaim(wreckId: string): SalvageClaim | undefined {
  cleanupClaims();
  return claims.get(wreckId);
}

function recordClaim(claim: SalvageClaim): void {
  claims.set(claim.wreckId, claim);
}

/**
 * Broadcast a salvage claim (or release) over the coordination chat channel.
 * All other salvagers in the same process will receive it instantly via their handlers.
 */
export function broadcastSalvageClaim(
  wreckId: string,
  poiId: string,
  action: "loot" | "tow" | "release",
  username: string,
): void {
  const chat = getBotChatChannel();
  const content = `SALVAGE_CLAIM ${wreckId} ${poiId} ${action} ${username}`;
  chat.send({
    sender: username,
    recipients: [], // broadcast
    channel: "coordination" as BotChatChannel,
    content,
  });
  // Record our own claim immediately (optimistic)
  recordClaim({ wreckId, poiId, action, by: username, at: Date.now() });
}

/**
 * Register the chat handler for this bot so it receives SALVAGE_CLAIM messages
 * from other salvagers.
 */
export function registerSalvageChatHandler(
  username: string,
  ctxLog?: (cat: string, msg: string) => void,
): (msg: BotChatMessage) => void {
  const handler = (message: BotChatMessage) => {
    if (message.channel !== "coordination") return;
    if (message.sender === username) return; // ignore own
    if (!message.content.startsWith("SALVAGE_CLAIM ")) return;

    const parts = message.content.split(/\s+/);
    if (parts.length < 5) return;

    const [, wreckId, poiId, action, by] = parts;
    if (!wreckId || !action || !by) return;

    if (action !== "loot" && action !== "tow" && action !== "release") return;

    recordClaim({
      wreckId,
      poiId: poiId || "",
      action: action as any,
      by,
      at: Date.now(),
    });

    if (ctxLog) {
      ctxLog("flock", `Received chat claim: ${by} → ${wreckId} (${action})`);
    } else {
      console.log(`[salvage-coop] ${by} claimed ${wreckId} for ${action}`);
    }
  };

  const chat = getBotChatChannel();
  chat.onMessage(username, handler);
  return handler;
}

/**
 * Unregister (for cleanup if routine stops).
 */
export function unregisterSalvageChatHandler(
  username: string,
  handler: (msg: BotChatMessage) => void,
): void {
  const chat = getBotChatChannel();
  chat.offMessage(username, handler);
}
