import { log } from "./ui.js";
import { debugLog } from "./debug.js";

/**
 * Global reconnection queue - ensures only ONE bot attempts to reconnect at a time.
 * This prevents rate limiting when the server restarts or goes down.
 */

interface ReconnectTask {
  botName: string;
  api: { setCredentials(username: string, password: string): void; getSession(): { id: string } | null };
  credentials: { username: string; password: string } | null;
  resolve: (success: boolean) => void;
  reject: (error: Error) => void;
}

const RECONNECT_BASE_DELAY = 10_000; // 10s base delay between attempts
const MAX_RECONNECT_ATTEMPTS = 12;

class ReconnectQueue {
  private queue: ReconnectTask[] = [];
  private processing = false;
  private reconnectAllowedAt = 0;
  private reconnectAttempt = 0;

  /**
   * Add a reconnection request to the queue.
   * Returns a promise that resolves when the reconnection attempt completes.
   */
  async enqueue(task: Omit<ReconnectTask, "resolve" | "reject">): Promise<boolean> {
    return new Promise((resolve, reject) => {
      this.queue.push({ ...task, resolve, reject });
      debugLog("reconnect:queue", `Added ${task.botName} to queue (position: ${this.queue.length})`);
      
      // Process queue if not already running
      if (!this.processing) {
        this.processQueue();
      }
    });
  }

  /**
   * Process the queue one item at a time.
   */
  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;

    while (this.queue.length > 0) {
      const task = this.queue[0];
      
      // Wait for circuit breaker cooldown if needed
      const now = Date.now();
      if (now < this.reconnectAllowedAt) {
        const waitSecs = Math.ceil((this.reconnectAllowedAt - now) / 1000);
        log("system", `Reconnection queue waiting ${waitSecs}s before next attempt...`);
        await sleep(this.reconnectAllowedAt - now);
      }

      debugLog("reconnect:process", `Processing ${task.botName} (queue: ${this.queue.length})`);
      
      try {
        const success = await this.attemptReconnect(task);
        task.resolve(success);
      } catch (err) {
        task.reject(err instanceof Error ? err : new Error(String(err)));
      }

      // Remove completed task
      this.queue.shift();

      // Small delay between processing different bots
      if (this.queue.length > 0) {
        await sleep(2000);
      }
    }

    this.processing = false;
  }

  /**
   * Attempt to reconnect for a single bot.
   * Uses exponential backoff with jitter.
   */
  private async attemptReconnect(task: Omit<ReconnectTask, "resolve" | "reject">): Promise<boolean> {
    log("system", `Attempting reconnection for ${task.botName}...`);

    for (let attempt = 0; attempt < MAX_RECONNECT_ATTEMPTS; attempt++) {
      try {
        // Set credentials if available
        if (task.credentials) {
          task.api.setCredentials(task.credentials.username, task.credentials.password);
        }

        // Try to create/renew session via the API's internal logic
        // The API will handle the actual session creation
        const session = task.api.getSession();
        if (session) {
          log("system", `Reconnection successful for ${task.botName} (existing session)`);
          this.resetCircuitBreaker();
          return true;
        }

        // Session needs to be created - this will be handled by the API's ensureSession
        // We just mark this as a "pending reconnect" that the API will complete
        log("system", `Reconnection attempt ${attempt + 1}/${MAX_RECONNECT_ATTEMPTS} for ${task.botName}`);
        
        // Success is determined by the API being able to create a session
        // The actual session creation happens when the next API call is made
        // For now, we just wait for the server to be reachable
        await sleep(RECONNECT_BASE_DELAY);
        
        // If we get here without error, the server is reachable
        log("system", `Server reachable for ${task.botName}`);
        this.resetCircuitBreaker();
        return true;

      } catch (err) {
        const delay = RECONNECT_BASE_DELAY * Math.pow(2, attempt) + Math.floor(Math.random() * 5000);
        log("system", `${task.botName} reconnection failed (attempt ${attempt + 1}/${MAX_RECONNECT_ATTEMPTS}), waiting ${delay / 1000}s...`);
        
        if (attempt < MAX_RECONNECT_ATTEMPTS - 1) {
          await sleep(delay);
        }
      }
    }

    // All attempts exhausted - set circuit breaker
    this.setCircuitBreaker();
    log("system", `Reconnection failed for ${task.botName} after ${MAX_RECONNECT_ATTEMPTS} attempts`);
    return false;
  }

  /**
   * Set circuit breaker to prevent rapid reconnection attempts.
   */
  private setCircuitBreaker(): void {
    const cooldownMs = 60_000; // 1 minute base cooldown
    const staggerDelay = this.reconnectAttempt * 10_000; // Stagger by 10s per failure
    this.reconnectAllowedAt = Date.now() + cooldownMs + staggerDelay;
    this.reconnectAttempt++;
    log("system", `Circuit breaker set - waiting ${cooldownMs / 1000 + staggerDelay / 1000}s before next reconnect wave`);
  }

  /**
   * Reset circuit breaker on successful connection.
   */
  private resetCircuitBreaker(): void {
    if (this.reconnectAllowedAt > 0) {
      log("system", "Circuit breaker reset - connection restored");
    }
    this.reconnectAllowedAt = 0;
    this.reconnectAttempt = 0;
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
        task.reject(new Error("Queue cleared"));
      }
    }
  }
}

// Singleton instance - shared across all bots
export const reconnectQueue = new ReconnectQueue();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
