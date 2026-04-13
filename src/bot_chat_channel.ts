/**
 * Bot-to-Bot Chat Channel
 * 
 * In-memory, client-side only communication channel for bots to coordinate
 * without using the game API. Used for:
 * - Escort coordination
 * - Fleet combat management  
 * - Multi-bot orchestration
 * - Quick status updates
 */

export type BotChatChannel = "fleet" | "escort" | "coordination" | "general";

export interface BotChatMessage {
  /** Bot username who sent the message */
  sender: string;
  /** Target bot usernames (empty = broadcast to all) */
  recipients: string[];
  /** Channel/category for filtering */
  channel: BotChatChannel;
  /** Message content */
  content: string;
  /** Timestamp when message was sent */
  timestamp: number;
  /** Optional metadata for structured data */
  metadata?: Record<string, unknown>;
}

export type BotChatHandler = (message: BotChatMessage) => void;

class BotChatChannelService {
  private messageHistory: BotChatMessage[] = [];
  private handlers: Map<string, Set<BotChatHandler>> = new Map();
  private globalHandlers: Set<BotChatHandler> = new Set();
  
  /** Maximum messages to keep in history per channel */
  private static readonly MAX_HISTORY = 100;

  /**
   * Send a message from one bot to others
   */
  send(message: Omit<BotChatMessage, "timestamp">): void {
    const fullMessage: BotChatMessage = {
      ...message,
      timestamp: Date.now(),
    };

    // Add to history
    this.messageHistory.push(fullMessage);
    
    // Trim history if needed
    if (this.messageHistory.length > BotChatChannelService.MAX_HISTORY) {
      this.messageHistory = this.messageHistory.slice(-BotChatChannelService.MAX_HISTORY);
    }

    // Deliver to handlers
    this.deliverMessage(fullMessage);
  }

  /**
   * Register a handler for a specific bot's incoming messages
   * @param botUsername - Bot that will receive messages
   * @param handler - Callback when messages arrive
   */
  onMessage(botUsername: string, handler: BotChatHandler): void {
    if (!this.handlers.has(botUsername)) {
      this.handlers.set(botUsername, new Set());
    }
    this.handlers.get(botUsername)!.add(handler);
  }

  /**
   * Remove a handler for a bot
   */
  offMessage(botUsername: string, handler: BotChatHandler): void {
    this.handlers.get(botUsername)?.delete(handler);
  }

  /**
   * Register a handler that receives ALL messages (for logging/debugging)
   */
  onGlobalMessage(handler: BotChatHandler): void {
    this.globalHandlers.add(handler);
  }

  /**
   * Remove a global handler
   */
  offGlobalMessage(handler: BotChatHandler): void {
    this.globalHandlers.delete(handler);
  }

  /**
   * Get recent message history for a channel
   */
  getHistory(channel?: BotChatChannel, limit = 20): BotChatMessage[] {
    const filtered = channel
      ? this.messageHistory.filter(m => m.channel === channel)
      : this.messageHistory;
    
    return filtered.slice(-limit);
  }

  /**
   * Clear all message history
   */
  clearHistory(): void {
    this.messageHistory = [];
  }

  /**
   * Get all active channels with message counts
   */
  getChannelStats(): Record<BotChatChannel, number> {
    const stats: Record<string, number> = {
      fleet: 0,
      escort: 0,
      coordination: 0,
      general: 0,
    };
    
    for (const msg of this.messageHistory) {
      stats[msg.channel] = (stats[msg.channel] || 0) + 1;
    }
    
    return stats as Record<BotChatChannel, number>;
  }

  private deliverMessage(message: BotChatMessage): void {
    // Call global handlers first
    for (const handler of this.globalHandlers) {
      try {
        handler(message);
      } catch (err) {
        console.error(`[BotChat] Global handler error:`, err);
      }
    }

    // Call bot-specific handlers
    // If recipients is empty, broadcast to all registered bots
    // Otherwise, only deliver to specified recipients
    const targets = message.recipients.length > 0 
      ? message.recipients 
      : [...this.handlers.keys()];

    for (const target of targets) {
      const botHandlers = this.handlers.get(target);
      if (botHandlers) {
        for (const handler of botHandlers) {
          try {
            handler(message);
          } catch (err) {
            console.error(`[BotChat] Handler error for ${target}:`, err);
          }
        }
      }
    }
  }
}

// Singleton instance
export const botChatChannel = new BotChatChannelService();
