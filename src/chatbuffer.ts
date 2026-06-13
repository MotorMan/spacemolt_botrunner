export interface ChatMessage {
  botUsername: string;
  channel: string;
  sender: string;
  content: string;
  timestamp: number;
  direction: "in" | "out";
  targetId?: string;
}

export interface ChannelInfo {
  name: string;
  displayName: string;
}

const MAX_MESSAGES_PER_BOT_CHANNEL = 500;

export class ChatBuffer {
  private messages: ChatMessage[] = [];
  private botChannelKeys = new Set<string>();

  addMessage(msg: ChatMessage): void {
    this.messages.push(msg);
    this.botChannelKeys.add(this.getBotChannelKey(msg.botUsername, msg.channel));
    this.prune();
  }

  getMessages(opts: {
    bot?: string;
    channel?: string;
    limit?: number;
    after?: number;
  } = {}): ChatMessage[] {
    const { bot, channel, limit = 200, after } = opts;

    let filtered = this.messages;
    if (bot) {
      filtered = filtered.filter(m => m.botUsername === bot);
    }
    if (channel) {
      filtered = filtered.filter(m => m.channel === channel);
    }
    if (after !== undefined) {
      filtered = filtered.filter(m => m.timestamp > after);
    }

    return filtered.slice(0, limit);
  }

  getBots(): string[] {
    const bots = new Set(this.messages.map(m => m.botUsername));
    return [...bots].sort((a, b) => a.localeCompare(b));
  }

  getChannels(bot?: string): ChannelInfo[] {
    const channels = new Set<string>();
    for (const m of this.messages) {
      if (!bot || m.botUsername === bot) {
        channels.add(m.channel);
      }
    }
    return [...channels]
      .sort()
      .map(name => ({
        name,
        displayName: this.getChannelDisplayName(name),
      }));
  }

  getMessageCount(opts: { bot?: string; channel?: string } = {}): number {
    let filtered = this.messages;
    if (opts.bot) {
      filtered = filtered.filter(m => m.botUsername === opts.bot);
    }
    if (opts.channel) {
      filtered = filtered.filter(m => m.channel === opts.channel);
    }
    return filtered.length;
  }

  private prune(): void {
    const keys = new Map<string, number[]>();
    for (let i = 0; i < this.messages.length; i++) {
      const m = this.messages[i];
      const key = this.getBotChannelKey(m.botUsername, m.channel);
      if (!keys.has(key)) {
        keys.set(key, []);
      }
      keys.get(key)!.push(i);
    }

    for (const [, indices] of keys) {
      while (indices.length > MAX_MESSAGES_PER_BOT_CHANNEL) {
        const removeIdx = indices.shift()!;
        this.messages.splice(removeIdx, 1);
        for (let j = 0; j < indices.length; j++) {
          indices[j]--;
        }
      }
    }
  }

  private getBotChannelKey(bot: string, channel: string): string {
    return `${bot}::${channel}`;
  }

  private getChannelDisplayName(channel: string): string {
    switch (channel) {
      case "local":
        return "Local";
      case "faction":
        return "Faction";
      case "system":
        return "System";
      case "private":
        return "Private";
      default:
        return channel.charAt(0).toUpperCase() + channel.slice(1);
    }
  }
}

export const chatBuffer = new ChatBuffer();
