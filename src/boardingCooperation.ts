import type { NearbyEntity } from "./routines/battle.js";

/**
 * Boarding cooperation state shared across the process.
 *
 * When a hunter starts boarding a target it broadcasts a claim on the
 * in-memory bot chat channel. Other hunters honour the claim: with
 * multiple targets they pick a different ship, and with only one target
 * they switch to brace stance so they do not damage the prize.
 */

export const BOARDING_CLAIM_TTL_MS = 90 * 1000;
export const boardingClaims = new Map<string, { claimer: string; expires: number }>();

export function releaseExpiredBoardingClaims(): void {
  const now = Date.now();
  for (const [id, claim] of boardingClaims) {
    if (claim.expires <= now) boardingClaims.delete(id);
  }
}

export function isBoardingClaimedByOther(targetId: string, username: string): boolean {
  const claim = boardingClaims.get(targetId);
  if (!claim) return false;
  if (claim.expires <= Date.now()) {
    boardingClaims.delete(targetId);
    return false;
  }
  return claim.claimer !== username;
}

export function pickUnclaimedBoardingTarget(
  targets: NearbyEntity[],
  username: string,
): NearbyEntity[] {
  releaseExpiredBoardingClaims();
  if (targets.length <= 1) return targets;
  const unclaimed = targets.filter(t => !isBoardingClaimedByOther(t.id, username));
  if (unclaimed.length === 0) return targets;
  return unclaimed;
}
