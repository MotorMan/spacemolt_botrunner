// ── Manual Rescue Request Queue ──────────────────────────

export interface ManualRescueRequest {
  targetPlayer: string;
  targetSystem: string;
  targetPOI: string;
  timestamp: number;
  botUsername?: string; // Which bot received this
}

const manualRescueQueue: ManualRescueRequest[] = [];

/**
 * Add a manual rescue request to the queue.
 * Returns true if added, false if duplicate.
 */
export function addManualRescueRequest(request: ManualRescueRequest): boolean {
  // Check for duplicate (same target within 5 minutes)
  const isDuplicate = manualRescueQueue.some(
    r => r.targetPlayer === request.targetPlayer &&
         r.targetSystem === request.targetSystem &&
         r.targetPOI === request.targetPOI &&
         (Date.now() - r.timestamp) < 300000
  );

  if (isDuplicate) {
    return false;
  }

  manualRescueQueue.push(request);

  // Keep queue size reasonable
  if (manualRescueQueue.length > 10) {
    manualRescueQueue.shift();
  }

  return true;
}

/**
 * Get the next pending manual rescue request.
 * Returns null if no pending requests.
 */
export function getNextManualRescue(): ManualRescueRequest | null {
  if (manualRescueQueue.length === 0) {
    return null;
  }
  return manualRescueQueue[0];
}

/**
 * Mark a manual rescue request as being handled.
 */
export function markManualRescueHandled(request: ManualRescueRequest): void {
  // Remove from queue
  const index = manualRescueQueue.indexOf(request);
  if (index >= 0) {
    manualRescueQueue.splice(index, 1);
  }
}

/**
 * Clear all pending manual rescue requests.
 */
export function clearManualRescueQueue(): void {
  manualRescueQueue.length = 0;
}
