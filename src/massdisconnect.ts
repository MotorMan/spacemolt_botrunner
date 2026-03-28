/**
 * Mass Session Loss Detector
 * 
 * Monitors for mass session invalidations across multiple bots.
 * When 15+ unique bots lose sessions within 5 seconds, triggers a graceful shutdown
 * with restart flag to recover from server-side session invalidation events.
 */

import { debugLog } from "./debug.js";

export interface MassDisconnectDetector {
  setTriggerCallback(callback: (affectedBots: string[]) => void): void;
  trackSessionLoss(botName: string): void;
  isShutdownInitiated(): boolean;
}

const MASS_DISCONNECT_THRESHOLD = 5;  // Trigger if 5+ unique bots lose sessions
const DISCONNECT_WINDOW_MS = 5000;     // Within 5 seconds

interface SessionLossEvent {
  botName: string;
  timestamp: number;
}

class MassDisconnectDetectorImpl implements MassDisconnectDetector {
  private sessionLossEvents: SessionLossEvent[] = [];
  private shutdownInitiated = false;
  private onTrigger?: (affectedBots: string[]) => void;

  setTriggerCallback(callback: (affectedBots: string[]) => void): void {
    this.onTrigger = callback;
  }

  trackSessionLoss(botName: string): void {
    if (this.shutdownInitiated) {
      debugLog("mass_disconnect", "skip", `${botName} - shutdown already initiated`);
      return;
    }

    const now = Date.now();
    
    // Add new session loss event
    this.sessionLossEvents.push({ botName, timestamp: now });
    
    // Remove old events outside the window
    this.sessionLossEvents = this.sessionLossEvents.filter(e => now - e.timestamp < DISCONNECT_WINDOW_MS);
    
    // Count UNIQUE bots that lost sessions in the window
    const uniqueBots = new Set(this.sessionLossEvents.map(e => e.botName));
    
    debugLog("mass_disconnect", "track", `${botName} - ${this.sessionLossEvents.length} events, ${uniqueBots.size} unique bots (threshold: ${MASS_DISCONNECT_THRESHOLD})`);
    
    // Check if threshold exceeded
    if (uniqueBots.size >= MASS_DISCONNECT_THRESHOLD) {
      this.shutdownInitiated = true;
      const affectedBots = [...uniqueBots];
      debugLog("mass_disconnect", "TRIGGER", `Shutdown triggered by ${botName}, affected: ${affectedBots.join(", ")}`);
      if (this.onTrigger) {
        this.onTrigger(affectedBots);
      }
    }
  }

  isShutdownInitiated(): boolean {
    return this.shutdownInitiated;
  }

  reset(): void {
    this.sessionLossEvents = [];
    this.shutdownInitiated = false;
  }
}

// Singleton instance
export const massDisconnectDetector: MassDisconnectDetector = new MassDisconnectDetectorImpl();
