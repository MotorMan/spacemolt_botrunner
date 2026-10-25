import { loadTraderActivity, type TradeSession } from "./traderActivity.js";
import { getFreshSnapshots, getSnapshot } from "../marketSnapshotStore.js";

const CLAIM_TTL_MS = 10 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 60 * 1000;

export interface RouteClaimKey {
  itemId: string;
  sourceSystem: string;
  sourcePoi: string;
  destSystem: string;
  destPoi: string;
}

export function claimKeyToString(key: RouteClaimKey): string {
  return [
    key.itemId,
    key.sourceSystem,
    key.sourcePoi,
    key.destSystem,
    key.destPoi,
  ].map((value) => value.toLowerCase()).join("|");
}

export function stringToClaimKey(str: string): RouteClaimKey {
  const [itemId, sourceSystem, sourcePoi, destSystem, destPoi] = str.split("|");
  return { itemId, sourceSystem, sourcePoi, destSystem, destPoi };
}

export interface LiveRouteClaim {
  key: string;
  lockedBy: string;
  quantityCommitted: number;
  sessionId: string;
  lockedAt: number;
  lastHeartbeat: number;
  sourceDepth: number;
  destDepth: number;
  reservedSourceQuantity: number;
  reservedDestQuantity: number;
}

interface LiveTradeCoordinatorState {
  claims: Map<string, LiveRouteClaim>;
}

const state: LiveTradeCoordinatorState = {
  claims: new Map(),
};

const ACTIVE_PHASES = new Set<string>(["buying", "awaiting_market", "in_transit", "at_destination", "selling", "returning_home"]);

function isClaimExpired(claim: LiveRouteClaim, now: number): boolean {
  return now - claim.lastHeartbeat > CLAIM_TTL_MS;
}

function getActiveLiveSessions(): TradeSession[] {
  const activity = loadTraderActivity();
  const sessions: TradeSession[] = [];

  for (const botData of Object.values(activity)) {
    if (botData.activeSession && ACTIVE_PHASES.has(botData.activeSession.state)) {
      sessions.push(botData.activeSession);
    }
  }

  return sessions;
}

function validateDepthAgainstSnapshots(session: TradeSession): { sourceDepth: number; destDepth: number } {
  const fresh = getFreshSnapshots(CLAIM_TTL_MS);
  let sourceDepth = 0;
  let destDepth = 0;

  for (const snapshot of fresh) {
    if (snapshot.systemId.toLowerCase() === session.sourceSystem.toLowerCase() &&
        snapshot.poiId.toLowerCase() === session.sourcePoi.toLowerCase()) {
      const item = snapshot.items.find(i => i.itemId === session.itemId);
      if (item) {
        const order = [...item.sellOrders].sort((a, b) => a.price - b.price)[0];
        if (order) sourceDepth = order.quantity;
      }
    }
    if (snapshot.systemId.toLowerCase() === session.destSystem.toLowerCase() &&
        snapshot.poiId.toLowerCase() === session.destPoi.toLowerCase()) {
      const item = snapshot.items.find(i => i.itemId === session.itemId);
      if (item) {
        const order = [...item.buyOrders].sort((a, b) => b.price - a.price)[0];
        if (order) destDepth = order.quantity;
      }
    }
  }

  return { sourceDepth, destDepth };
}

export function acquire(params: {
  botUsername: string;
  itemId: string;
  itemName: string;
  sourceSystem: string;
  sourcePoi: string;
  destSystem: string;
  destPoi: string;
  quantity: number;
  sessionId: string;
  sourceDepth: number;
  destDepth: number;
}): { success: boolean; reason?: string; existingClaim?: LiveRouteClaim } {
  const now = Date.now();
  const keyObj: RouteClaimKey = { itemId: params.itemId, sourceSystem: params.sourceSystem, sourcePoi: params.sourcePoi, destSystem: params.destSystem, destPoi: params.destPoi };
  const key = claimKeyToString(keyObj);

  const existing = state.claims.get(key);

  if (existing) {
    if (isClaimExpired(existing, now)) {
      state.claims.delete(key);
    } else if (existing.lockedBy !== params.botUsername) {
      return { success: false, reason: `Route claimed by another bot: ${existing.lockedBy}`, existingClaim: existing };
    } else {
      const sourceDelta = Math.max(0, params.quantity - existing.reservedSourceQuantity);
      const destDelta = Math.max(0, params.quantity - existing.reservedDestQuantity);
      if (existing.reservedSourceQuantity + sourceDelta > existing.sourceDepth) {
        return { success: false, reason: `Quantity ${params.quantity} exceeds reserved source depth ${existing.sourceDepth}` };
      }
      if (existing.reservedDestQuantity + destDelta > existing.destDepth) {
        return { success: false, reason: `Quantity ${params.quantity} exceeds reserved destination depth ${existing.destDepth}` };
      }
      existing.quantityCommitted = params.quantity;
      existing.reservedSourceQuantity += sourceDelta;
      existing.reservedDestQuantity += destDelta;
      existing.lastHeartbeat = now;
      existing.sourceDepth = params.sourceDepth;
      existing.destDepth = params.destDepth;
      return { success: true };
    }
  }

  if (params.quantity > params.sourceDepth) {
    return { success: false, reason: `Quantity ${params.quantity} exceeds source depth ${params.sourceDepth}` };
  }
  if (params.quantity > params.destDepth) {
    return { success: false, reason: `Quantity ${params.quantity} exceeds destination depth ${params.destDepth}` };
  }

  const claim: LiveRouteClaim = {
    key,
    lockedBy: params.botUsername,
    quantityCommitted: params.quantity,
    sessionId: params.sessionId,
    lockedAt: now,
    lastHeartbeat: now,
    sourceDepth: params.sourceDepth,
    destDepth: params.destDepth,
    reservedSourceQuantity: params.quantity,
    reservedDestQuantity: params.quantity,
  };

  state.claims.set(key, claim);
  return { success: true };
}

export function heartbeat(params: { botUsername: string; itemId: string; sourceSystem: string; sourcePoi: string; destSystem: string; destPoi: string }): { success: boolean; reason?: string } {
  const now = Date.now();
  const keyObj: RouteClaimKey = { itemId: params.itemId, sourceSystem: params.sourceSystem, sourcePoi: params.sourcePoi, destSystem: params.destSystem, destPoi: params.destPoi };
  const key = claimKeyToString(keyObj);

  const existing = state.claims.get(key);

  if (!existing) {
    return { success: false, reason: "No claim found for this route" };
  }

  if (existing.lockedBy !== params.botUsername) {
    return { success: false, reason: `Claim held by another bot: ${existing.lockedBy}` };
  }

  if (isClaimExpired(existing, now)) {
    state.claims.delete(key);
    return { success: false, reason: "Claim expired" };
  }

  existing.lastHeartbeat = now;
  return { success: true };
}

export function release(params: { botUsername: string; itemId: string; sourceSystem: string; sourcePoi: string; destSystem: string; destPoi: string }): { success: boolean; reason?: string } {
  const keyObj: RouteClaimKey = { itemId: params.itemId, sourceSystem: params.sourceSystem, sourcePoi: params.sourcePoi, destSystem: params.destSystem, destPoi: params.destPoi };
  const key = claimKeyToString(keyObj);

  const existing = state.claims.get(key);

  if (!existing) {
    return { success: false, reason: "No claim found for this route" };
  }

  if (existing.lockedBy !== params.botUsername) {
    return { success: false, reason: `Claim held by another bot: ${existing.lockedBy}` };
  }

  state.claims.delete(key);
  return { success: true };
}

export function cleanupExpired(): number {
  const now = Date.now();
  let cleaned = 0;

  for (const [key, claim] of state.claims) {
    if (isClaimExpired(claim, now)) {
      state.claims.delete(key);
      cleaned++;
    }
  }

  return cleaned;
}

export function restoreActiveClaims(currentBotUsername: string): { restored: number; skipped: number; failed: Array<{ sessionId: string; reason: string }> } {
  const sessions = getActiveLiveSessions();
  let restored = 0;
  let skipped = 0;
  const failed: Array<{ sessionId: string; reason: string }> = [];

  for (const session of sessions) {
    const keyObj: RouteClaimKey = {
      itemId: session.itemId,
      sourceSystem: session.sourceSystem,
      sourcePoi: session.sourcePoi,
      destSystem: session.destSystem,
      destPoi: session.destPoi,
    };
    const key = claimKeyToString(keyObj);

    const existing = state.claims.get(key);

    if (existing) {
      if (existing.lockedBy === session.botUsername) {
        skipped++;
        continue;
      } else {
        failed.push({ sessionId: session.sessionId, reason: `Route already claimed in-memory by ${existing.lockedBy}` });
        continue;
      }
    }

    const now = Date.now();
    const sessionUpdated = new Date(session.lastUpdatedAt).getTime();
    const timeSinceUpdate = now - sessionUpdated;

    if (timeSinceUpdate > CLAIM_TTL_MS) {
      failed.push({ sessionId: session.sessionId, reason: `Session stale (last updated ${Math.round(timeSinceUpdate / 60000)} min ago)` });
      continue;
    }

    const depths = validateDepthAgainstSnapshots(session);

    const claim: LiveRouteClaim = {
      key,
      lockedBy: session.botUsername,
      quantityCommitted: session.quantityBought || 0,
      sessionId: session.sessionId,
      lockedAt: new Date(session.startedAt).getTime(),
      lastHeartbeat: now,
      sourceDepth: depths.sourceDepth || session.quantityBought || 0,
      destDepth: depths.destDepth || session.sellQuantity || 0,
      reservedSourceQuantity: session.quantityBought || 0,
      reservedDestQuantity: session.sellQuantity || 0,
    };

    state.claims.set(key, claim);
    restored++;
  }

  return { restored, skipped, failed };
}

export function getClaim(params: { itemId: string; sourceSystem: string; sourcePoi: string; destSystem: string; destPoi: string }): LiveRouteClaim | null {
  const keyObj: RouteClaimKey = { itemId: params.itemId, sourceSystem: params.sourceSystem, sourcePoi: params.sourcePoi, destSystem: params.destSystem, destPoi: params.destPoi };
  const key = claimKeyToString(keyObj);
  return state.claims.get(key) || null;
}

export function getAllClaims(): LiveRouteClaim[] {
  return Array.from(state.claims.values());
}

export function getClaimsForBot(botUsername: string): LiveRouteClaim[] {
  const claims: LiveRouteClaim[] = [];
  for (const claim of state.claims.values()) {
    if (claim.lockedBy === botUsername) {
      claims.push(claim);
    }
  }
  return claims;
}

export function updateClaimQuantity(params: { botUsername: string; itemId: string; sourceSystem: string; sourcePoi: string; destSystem: string; destPoi: string; quantity: number }): { success: boolean; reason?: string } {
  const now = Date.now();
  const keyObj: RouteClaimKey = { itemId: params.itemId, sourceSystem: params.sourceSystem, sourcePoi: params.sourcePoi, destSystem: params.destSystem, destPoi: params.destPoi };
  const key = claimKeyToString(keyObj);

  const existing = state.claims.get(key);

  if (!existing) {
    return { success: false, reason: "No claim found for this route" };
  }

  if (existing.lockedBy !== params.botUsername) {
    return { success: false, reason: `Claim held by another bot: ${existing.lockedBy}` };
  }

  if (isClaimExpired(existing, now)) {
    state.claims.delete(key);
    return { success: false, reason: "Claim expired" };
  }

  if (params.quantity > existing.sourceDepth) {
    return { success: false, reason: `Quantity ${params.quantity} exceeds source depth ${existing.sourceDepth}` };
  }
  if (params.quantity > existing.destDepth) {
    return { success: false, reason: `Quantity ${params.quantity} exceeds destination depth ${existing.destDepth}` };
  }

  const sourceDelta = params.quantity - existing.reservedSourceQuantity;
  const destDelta = params.quantity - existing.reservedDestQuantity;
  if (sourceDelta > 0 && existing.reservedSourceQuantity + sourceDelta > existing.sourceDepth) {
    return { success: false, reason: `Quantity ${params.quantity} exceeds reserved source depth ${existing.sourceDepth}` };
  }
  if (destDelta > 0 && existing.reservedDestQuantity + destDelta > existing.destDepth) {
    return { success: false, reason: `Quantity ${params.quantity} exceeds reserved destination depth ${existing.destDepth}` };
  }

  existing.quantityCommitted = params.quantity;
  existing.reservedSourceQuantity += sourceDelta;
  existing.reservedDestQuantity += destDelta;
  existing.lastHeartbeat = now;
  return { success: true };
}

export function isRouteAvailable(params: { itemId: string; sourceSystem: string; sourcePoi: string; destSystem: string; destPoi: string; excludeBot?: string }): { available: boolean; reason?: string; existingClaim?: LiveRouteClaim } {
  const keyObj: RouteClaimKey = { itemId: params.itemId, sourceSystem: params.sourceSystem, sourcePoi: params.sourcePoi, destSystem: params.destSystem, destPoi: params.destPoi };
  const key = claimKeyToString(keyObj);

  const existing = state.claims.get(key);

  if (!existing) {
    return { available: true };
  }

  const now = Date.now();
  if (isClaimExpired(existing, now)) {
    state.claims.delete(key);
    return { available: true };
  }

  if (params.excludeBot && existing.lockedBy === params.excludeBot) {
    return { available: true };
  }

  return { available: false, reason: `Route claimed by ${existing.lockedBy}`, existingClaim: existing };
}