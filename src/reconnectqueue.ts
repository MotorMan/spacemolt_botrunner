import { log } from "./ui.js";
import { debugLogForBot } from "./debug.js";

/**
 * Global reconnection queue - ensures only ONE bot attempts to reconnect at a time.
 * Processes bots sequentially with 25s delays to avoid rate limiting.
 * When a bot fails, it stays in the queue for retry.
 */

interface ReconnectTask {
  botName: string;
  api: {
    setCredentials(username: string, password: string): void;
    getSession(): { id: string } | null;
    execute(command: string, payload?: Record<string, unknown>): Promise<unknown>;
  };
  credentials: { username: string; password: string } | null;
  resolve: (success: boolean) => void;
  reject: (error: Error) => void;
}

const RECONNECT_DELAY_MS = 25_000; // 25s delay between bot reconnections (CRITICAL: prevents rate limiting)
const MAX_RECONNECT_ATTEMPTS = 30; // ~12.5 minutes of retry attempts

class ReconnectQueue {
  private queue: ReconnectTask[] = [];
  private processing = false;
  private attemptCounts = new Map<string, number>();

  /**
   * Add a reconnection request to the queue.
   * Returns a promise that resolves when the bot successfully reconnects.
   */
  async enqueue(task: Omit<ReconnectTask, "resolve" | "reject">): Promise<boolean> {
    return new Promise((resolve, reject) => {
      this.queue.push({ ...task, resolve, reject });
      debugLogForBot(task.botName, "reconnect:queue", `Added ${task.botName} to queue (position: ${this.queue.length})`);
      log("system", `${task.botName} added to reconnection queue (position: ${this.queue.length})`);

      // Process queue if not already running
      if (!this.processing) {
        this.processQueue();
      }
    });
  }

  /**
   * Process the queue one item at a time.
   * First bot waits 25s before attempting (gives server time to start).
   * After each bot completes, wait 25s before next.
   */
  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;

    while (this.queue.length > 0) {
      const task = this.queue[0];

      // First bot always waits full 25s (server may be restarting)
      log("system", `Waiting ${RECONNECT_DELAY_MS / 1000}s before reconnection attempt...`);
      await sleep(RECONNECT_DELAY_MS);

      debugLogForBot(task.botName, "reconnect:process", `Processing ${task.botName} (queue: ${this.queue.length})`);

      try {
        const success = await this.attemptReconnect(task);
        
        if (success) {
          // Bot reconnected successfully - remove from queue
          task.resolve(true);
          this.queue.shift();
          this.attemptCounts.delete(task.botName);
          log("system", `✅ ${task.botName} reconnected successfully, removed from queue`);
        } else {
          // Reconnect failed - keep in queue for retry, move to back
          log("system", `${task.botName} reconnection failed, will retry later (queue position: ${this.queue.length})`);
          this.queue.shift();
          this.queue.push(task);
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        log("error", `${task.botName} reconnection error: ${error.message}`);
        
        // Check if max attempts exceeded
        const attempts = this.attemptCounts.get(task.botName) || 0;
        if (attempts >= MAX_RECONNECT_ATTEMPTS) {
          log("error", `${task.botName} exceeded max reconnection attempts (${MAX_RECONNECT_ATTEMPTS}), removing from queue`);
          task.reject(error);
          this.queue.shift();
          this.attemptCounts.delete(task.botName);
        } else {
          // Keep in queue for retry
          this.queue.shift();
          this.queue.push(task);
        }
      }

      // Continue to next bot in queue (will wait 25s at start of loop)
    }

    this.processing = false;
    debugLogForBot("SYSTEM", "reconnect:process", "Queue empty, processing complete");
  }

  /**
   * Attempt to reconnect for a single bot.
   * Tests session validity with get_status command.
   * Returns true if successful, false if should retry.
   */
  private async attemptReconnect(task: Omit<ReconnectTask, "resolve" | "reject">): Promise<boolean> {
    log("system", `Attempting reconnection for ${task.botName}...`);

    try {
      // Set credentials if available
      if (task.credentials) {
        task.api.setCredentials(task.credentials.username, task.credentials.password);
      }

      // Try to execute get_status to verify connection and session
      log("system", `Testing connection for ${task.botName} with get_status...`);
      const resp = await task.api.execute("get_status");
      
      // Check if response indicates success
      if (resp && typeof resp === "object" && !("error" in resp)) {
        log("system", `✅ ${task.botName} connection verified successfully`);
        return true;
      }
      
      // Response has error - check if it's a connection error
      const apiResp = resp as { error?: { code?: string; message?: string } };
      if (apiResp.error) {
        const errorCode = apiResp.error.code || "";
        const errorMsg = apiResp.error.message || "";
        
        // Connection errors - should retry
        if (errorCode === "connection_failed" || 
            errorCode === "server_down" || 
            errorCode === "network_error" ||
            errorMsg.includes("ECONNREFUSED") ||
            errorMsg.includes("ENOTFOUND") ||
            errorMsg.includes("connection")) {
          log("system", `${task.botName} connection failed: ${errorMsg}`);
          return false;
        }
        
        // Session/auth errors - session may still be valid on server, try anyway
        // The game auto-renews sessions on command
        log("system", `${task.botName} got ${errorCode}, but session may still work`);
        return true;
      }
      
      return true;
      
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log("system", `${task.botName} reconnection attempt failed: ${msg}`);
      
      // Track attempt count
      const attempts = (this.attemptCounts.get(task.botName) || 0) + 1;
      this.attemptCounts.set(task.botName, attempts);
      
      return false;
    }
  }

  /**
   * Get current queue status.
   */
  getStatus(): { queued: number; processing: boolean } {
    return {
      queued: this.queue.length,
      processing: this.processing,
    };
  }

  /**
   * Clear the queue (used on shutdown).
   */
  clear(): void {
    while (this.queue.length > 0) {
      const task = this.queue.pop();
      if (task) {
        task.reject(new Error("Queue cleared - shutting down"));
      }
    }
    this.attemptCounts.clear();
  }
  
  /**
   * Get queue length.
   */
  get length(): number {
    return this.queue.length;
  }
}

// Singleton instance - shared across all bots
export const reconnectQueue = new ReconnectQueue();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
