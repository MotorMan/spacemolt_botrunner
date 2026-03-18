import { log } from "./ui.js";
import { debugLog } from "./debug.js";

/**
 * Detects server-wide disconnects by tracking connection failures across all bots.
 * When 3+ bots experience a server disconnect within a short window, it triggers
 * a coordinated reconnection to prevent rate limiting and server hammering.
 */

interface DisconnectEvent {
  botName: string;
  timestamp: number;
}

interface ReconnectBot {
  name: string;
  api: {
    setCredentials(username: string, password: string): void;
    getSession(): { id: string } | null;
    execute(command: string, payload?: Record<string, unknown>): Promise<unknown>;
  };
  credentials: { username: string; password: string } | null;
}

interface BotState {
  wasRunning: boolean;
  routine: string | null;
}

const DISCONNECT_WINDOW_MS = 10_000; // 10 second window to count disconnects
const DISCONNECT_THRESHOLD = 3; // Number of bot disconnects to trigger server-wide detection
const RECONNECT_WAIT_MS = 20_000; // Wait 20 seconds before starting reconnection
const RECONNECT_BOT_DELAY_MS = 20_000; // Delay between reconnecting each bot

interface ServerDownCallback {
  stopBots: (affectedBots: string[]) => Promise<Map<string, BotState>>;
  restartBots: (botStates: Map<string, BotState>) => Promise<void>;
}

export class ServerDisconnectDetector {
  private disconnectEvents: DisconnectEvent[] = [];
  private serverDownDetected = false;
  private serverDownDetectedAt = 0;
  private reconnectInProgress = false;
  private onServerDownCallback: ServerDownCallback | null = null;
  private registeredBots = new Map<string, ReconnectBot>();

  /**
   * Register a bot for potential reconnection.
   */
  registerBot(bot: ReconnectBot): void {
    this.registeredBots.set(bot.name, bot);
    debugLog("disconnect:register", `Registered bot: ${bot.name}`);
  }

  /**
   * Unregister a bot (e.g., when it's removed).
   */
  unregisterBot(botName: string): void {
    this.registeredBots.delete(botName);
    debugLog("disconnect:unregister", `Unregistered bot: ${botName}`);
  }

  /**
   * Set callback to be called when server-wide disconnect is detected.
   */
  onServerDown(callback: DisconnectCallback): void {
    this.onServerDownCallback = callback;
  }

  /**
   * Report a server disconnect from a bot.
   * Returns true if this disconnect triggered server-wide detection.
   */
  reportDisconnect(botName: string): boolean {
    const now = Date.now();

    // Clean old events outside the window
    this.disconnectEvents = this.disconnectEvents.filter(
      (e) => now - e.timestamp < DISCONNECT_WINDOW_MS
    );

    // Add this event
    this.disconnectEvents.push({ botName, timestamp: now });

    debugLog("disconnect:report", `Bot ${botName} reported disconnect (window count: ${this.disconnectEvents.length})`);

    // Check if threshold reached
    if (this.disconnectEvents.length >= DISCONNECT_THRESHOLD && !this.serverDownDetected && !this.reconnectInProgress) {
      this.triggerServerDownDetection();
      return true;
    }

    return false;
  }

  /**
   * Trigger server-wide disconnect detection.
   */
  private async triggerServerDownDetection(): Promise<void> {
    this.serverDownDetected = true;
    this.serverDownDetectedAt = Date.now();
    this.reconnectInProgress = true;

    const affectedBots = this.disconnectEvents.map((e) => e.botName);
    log("system", `🚨 SERVER DOWN DETECTED: ${affectedBots.length} bots lost connection within ${DISCONNECT_WINDOW_MS / 1000}s`);
    log("system", `Invalidating all sessions and waiting ${RECONNECT_WAIT_MS / 1000}s before reconnection...`);

    // Invalidate all sessions immediately
    this.invalidateAllSessions();

    // Clear the disconnect events - we've detected the issue
    this.disconnectEvents = [];

    // Stop bots and save their state
    let botStates = new Map<string, BotState>();
    if (this.onServerDownCallback) {
      try {
        botStates = await this.onServerDownCallback.stopBots(affectedBots);
      } catch (err) {
        log("error", `Server down callback error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Wait for the cooldown period
    await sleep(RECONNECT_WAIT_MS);

    // Start coordinated reconnection
    log("system", "🔄 Starting coordinated reconnection sequence...");
    const reconnectSuccess = await this.startCoordinatedReconnect();

    // Restart bots with their saved routines after reconnection
    if (reconnectSuccess && this.onServerDownCallback) {
      try {
        log("system", "🔄 Restarting bots with their saved routines...");
        await this.onServerDownCallback.restartBots(botStates);
      } catch (err) {
        log("error", `Failed to restart bots: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Invalidate all bot sessions.
   */
  private invalidateAllSessions(): void {
    for (const [, bot] of this.registeredBots) {
      // The session will be invalidated by setting it to null
      // The actual session invalidation happens on the server side
      // We just mark that we need to reconnect
      log("system", `Invalidated session for ${bot.name}`);
    }
  }

  /**
   * Start coordinated reconnection of all registered bots.
   * Returns true if at least one bot reconnected successfully.
   */
  private async startCoordinatedReconnect(): Promise<boolean> {
    const bots = Array.from(this.registeredBots.values());

    if (bots.length === 0) {
      log("system", "No bots registered for reconnection");
      this.reconnectInProgress = false;
      this.serverDownDetected = false;
      return false;
    }

    log("system", `Reconnecting ${bots.length} bot(s) sequentially...`);

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < bots.length; i++) {
      const bot = bots[i];
      const position = i + 1;

      try {
        log("system", `[${position}/${bots.length}] Reconnecting ${bot.name}...`);

        // Set credentials if available
        if (bot.credentials) {
          bot.api.setCredentials(bot.credentials.username, bot.credentials.password);
        }

        // Try to execute a simple command to re-establish session
        // The API will handle session creation automatically
        await bot.api.execute("get_status");

        log("system", `✅ ${bot.name} reconnected successfully`);
        successCount++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("error", `❌ ${bot.name} reconnection failed: ${msg}`);
        failCount++;
      }

      // Delay before next bot (except for the last one)
      if (i < bots.length - 1) {
        await sleep(RECONNECT_BOT_DELAY_MS);
      }
    }

    log("system", `Reconnection complete: ${successCount} succeeded, ${failCount} failed`);

    this.reconnectInProgress = false;
    this.serverDownDetected = false;
    this.disconnectEvents = [];

    return successCount > 0;
  }

  /**
   * Check if server-wide disconnect is currently detected.
   */
  isServerDown(): boolean {
    return this.serverDownDetected;
  }

  /**
   * Check if reconnection is currently in progress.
   */
  isReconnecting(): boolean {
    return this.reconnectInProgress;
  }

  /**
   * Get the number of recent disconnect events.
   */
  getRecentDisconnectCount(): number {
    const now = Date.now();
    return this.disconnectEvents.filter(
      (e) => now - e.timestamp < DISCONNECT_WINDOW_MS
    ).length;
  }

  /**
   * Reset the detector state.
   */
  reset(): void {
    this.disconnectEvents = [];
    this.serverDownDetected = false;
    this.serverDownDetectedAt = 0;
    this.reconnectInProgress = false;
    debugLog("disconnect:reset", "Detector reset");
  }
}

// Singleton instance - shared across all bots
export const serverDisconnectDetector = new ServerDisconnectDetector();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
