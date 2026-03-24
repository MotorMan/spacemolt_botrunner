/**
 * AI Chat Service — Global background service for chat responses.
 * 
 * Runs independently of bot routines, monitoring chat messages from all bots
 * and coordinating responses through a single bot at a time.
 */

import { readSettings } from "./routines/common.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import type { Bot } from "./bot.js";
import { sleep } from "./routines/common.js";

// ── Types ────────────────────────────────────────────────────

interface AiChatMemory {
  version: 1;
  lastResponse: string;
  responseCount: number;
  conversationHistory: Array<{
    timestamp: string;
    sender: string;
    channel: string;
    message: string;
    response: string;
    botName: string;
  }>;
}

interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string | null;
}

export interface ChatMessage {
  sender: string;
  channel: "local" | "faction" | "system" | "private";
  content: string;
  timestamp: number;
  botUsername?: string; // Which bot received this
  botSystem?: string;   // System where message was received (for local chat)
  botPoi?: string;      // POI where message was received (for local chat)
  targetId?: string;    // Target player for private messages
}

interface BotLockInfo {
  botName: string;
  lockedUntil: number;
  lastSender: string;
  channelId: string;
}

// ── Settings ─────────────────────────────────────────────────

const PERSONALITIES_DIR = join(process.cwd(), "data", "personalities");
const MAP_FILE = join(process.cwd(), "data", "map.json");

/**
 * Load and summarize map data for LLM context.
 * Creates a concise summary of systems, connections, and resources.
 */
function getMapSummary(): string {
  try {
    if (!existsSync(MAP_FILE)) {
      return "Map data not available.";
    }
    
    const mapData = JSON.parse(readFileSync(MAP_FILE, "utf-8")) as {
      systems?: Record<string, {
        id: string;
        name: string;
        connections?: Array<{ system_id: string; system_name: string }>;
        pois?: Array<{
          id: string;
          name: string;
          type: string;
          has_base: boolean;
          ores_found?: Array<{ name: string; item_id: string }>;
        }>;
      }>;
    };
    
    const systems = mapData.systems || {};
    const systemCount = Object.keys(systems).length;
    
    // Build summary
    const lines: string[] = [];
    lines.push(`Galaxy Map Summary (${systemCount} systems total):`);
    lines.push("");
    
    // List systems with their connections and notable POIs
    const systemEntries = Object.entries(systems).slice(0, 100); // Limit to first 100 for context
    
    for (const [sysId, sys] of systemEntries) {
      const connNames = sys.connections?.map(c => c.system_name).join(", ") || "none";
      const stations = sys.pois?.filter(p => p.has_base).map(p => p.name).join(", ") || "";
      const resourcePois = sys.pois?.filter(p => p.ores_found && p.ores_found.length > 0) || [];
      
      let sysLine = `- ${sys.name} (${sysId})`;
      if (stations) sysLine += ` | Station: ${stations}`;
      if (resourcePois.length > 0) {
        const ores = resourcePois.flatMap(p => p.ores_found?.map(o => o.name || o.item_id) || []);
        if (ores.length > 0) sysLine += ` | Resources: ${[...new Set(ores)].slice(0, 5).join(", ")}`;
      }
      lines.push(sysLine);
      lines.push(`  Connections: ${connNames}`);
    }
    
    if (systemCount > 100) {
      lines.push(`... and ${systemCount - 100} more systems (use get_system command in-game for details)`);
    }
    
    return lines.join("\n");
  } catch (err) {
    console.error("Error loading map data:", err);
    return "Map data unavailable (error loading).";
  }
}

// Cache the map summary (it doesn't change often)
let cachedMapSummary: string | null = null;

function getCachedMapSummary(): string {
  if (!cachedMapSummary) {
    cachedMapSummary = getMapSummary();
  }
  return cachedMapSummary;
}

/**
 * Load a bot's personality from data/personalities/{bot-name}.md
 * Falls back to default personality if file doesn't exist.
 */
function getBotPersonality(botName: string): string {
  // Try different name formats: "Hannah Hollo.md", "hannah_hollo.md", "Hannah_Hollo.md"
  const possibleFiles = [
    join(PERSONALITIES_DIR, `${botName}.md`),
    join(PERSONALITIES_DIR, `${botName.toLowerCase().replace(/\s+/g, "_")}.md`),
    join(PERSONALITIES_DIR, `${botName.replace(/\s+/g, "_")}.md`),
  ];
  
  for (const filePath of possibleFiles) {
    if (existsSync(filePath)) {
      try {
        const content = readFileSync(filePath, "utf-8").trim();
        if (content) {
          return content;
        }
      } catch (err) {
        console.error(`Error reading personality file ${filePath}:`, err);
      }
    }
  }
  
  // Fall back to default
  return DEFAULT_PERSONALITY;
}

function getAiChatSettings(): {
  enabled: boolean;
  model: string;
  baseUrl: string;
  apiKey: string;
  cycleIntervalSec: number;
  respondToMentions: boolean;
  respondToQuestions: boolean;
  respondToAll: boolean;
  respondToSystem: boolean;
  respondToMayday: boolean;
  personality: string;
  lockDurationSec: number;
  conversationCooldownSec: number;
} {
  const all = readSettings();
  const s = (all.ai_chat || {}) as Record<string, unknown>;

  const baseUrl =
    process.env.AI_CHAT_BASE_URL ||
    (s.baseUrl as string) ||
    "http://localhost:11434/v1";

  const apiKey =
    process.env.AI_CHAT_API_KEY ||
    (s.apiKey as string) ||
    "ollama";

  const model =
    process.env.AI_CHAT_MODEL ||
    (s.model as string) ||
    "llama3.2";

  return {
    enabled: (s.enabled as boolean) ?? false,
    model,
    baseUrl,
    apiKey,
    cycleIntervalSec: (s.cycleIntervalSec as number) || 5,
    respondToMentions: (s.respondToMentions as boolean) ?? true,
    respondToQuestions: (s.respondToQuestions as boolean) ?? false,
    respondToAll: (s.respondToAll as boolean) ?? false,
    respondToSystem: (s.respondToSystem as boolean) ?? false,
    respondToMayday: (s.respondToMayday as boolean) ?? true,
    personality: (s.personality as string) || DEFAULT_PERSONALITY,
    lockDurationSec: (s.lockDurationSec as number) || 60,
    conversationCooldownSec: (s.conversationCooldownSec as number) ?? 15,
  };
}

// ── Memory ────────────────────────────────────────────────────

const MEMORY_FILE = join(process.cwd(), "data", "ai_chat_memory.json");

function loadMemory(): AiChatMemory {
  try {
    if (existsSync(MEMORY_FILE)) {
      return JSON.parse(readFileSync(MEMORY_FILE, "utf-8")) as AiChatMemory;
    }
  } catch { /* start fresh */ }
  return {
    version: 1,
    lastResponse: "",
    responseCount: 0,
    conversationHistory: [],
  };
}

function saveMemory(mem: AiChatMemory): void {
  const dir = join(process.cwd(), "data");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(MEMORY_FILE, JSON.stringify(mem, null, 2) + "\n", "utf-8");
}

// ── Default personality ──────────────────────────────────────

export const DEFAULT_AI_CHAT_PERSONALITY = `You are a friendly and helpful AI assistant playing SpaceMolt.
Your personality traits:
- Friendly and welcoming to all players
- Knowledgeable about the game but humble
- Concise in responses (1-3 sentences max)
- Uses casual gaming chat language
- Helpful with tips when asked
- Never rude or dismissive

When responding:
- Keep it brief and natural for chat
- Don't reveal you're an AI unless directly asked
- If you don't know something, admit it honestly
- Use emojis sparingly if at all`;

const DEFAULT_PERSONALITY = DEFAULT_AI_CHAT_PERSONALITY;

// Export getBotPersonality for use by customs service
export { getBotPersonality };

// ── Chat message detection ───────────────────────────────────

/**
 * Check if a message mentions a bot's name.
 * Handles full name, first name only, last name only, and underscores.
 */
function messageMentionsBot(message: string, botName: string): boolean {
  const lowerMsg = message.toLowerCase().trim();
  const lowerName = botName.toLowerCase().trim();
  
  // Generate all name variations to check
  const nameVariations = new Set<string>();
  
  // Full name variations
  nameVariations.add(lowerName);
  nameVariations.add(lowerName.replace(/_/g, " "));
  nameVariations.add(lowerName.replace(/_/g, ""));
  
  // Split on space or underscore to get first/last names
  const nameParts = lowerName.split(/[\s_]+/).filter(p => p.length > 0);
  
  // Add individual parts (first name, last name, etc.)
  for (const part of nameParts) {
    if (part.length >= 3) {
      nameVariations.add(part);
    }
  }
  
  // Check if any variation is mentioned in the message
  for (const variation of nameVariations) {
    if (variation.length <= 4) {
      const wordBoundaryRegex = new RegExp(`\\b${escapeRegex(variation)}\\b`, "i");
      if (wordBoundaryRegex.test(lowerMsg)) return true;
    } else {
      if (lowerMsg.includes(variation)) return true;
    }
  }
  
  return false;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Check if a message is a general question.
 */
function isGeneralQuestion(message: string): boolean {
  const lower = message.toLowerCase();
  
  const questionPatterns = [
    /\?$/,
    /\b(how|what|where|when|why|who|can|could|would|should|is|are|does|do)\b/i,
  ];
  
  const greetingPatterns = [
    /\b(hi|hello|hey|greetings|yo|sup)\b/i,
  ];
  
  return questionPatterns.some(p => p.test(lower)) ||
         greetingPatterns.some(p => p.test(lower));
}

// ── LLM client ───────────────────────────────────────────────

async function callLlm(
  messages: LlmMessage[],
  settings: ReturnType<typeof getAiChatSettings>,
): Promise<string> {
  const url = `${settings.baseUrl.replace(/\/$/, "")}/chat/completions`;

  const body: Record<string, unknown> = {
    model: settings.model,
    messages,
    max_tokens: 300,
    temperature: 0.8,
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`LLM HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }

  const data = await resp.json() as {
    choices?: Array<{ message: LlmMessage; finish_reason: string }>;
    error?: { message: string };
  };

  if (data.error) throw new Error(`LLM error: ${data.error.message}`);
  const msg = data.choices?.[0]?.message;
  if (!msg || !msg.content) throw new Error("LLM returned no message");
  return msg.content;
}

// ── AI Chat Service Class ────────────────────────────────────

export class AiChatService {
  private chatMessageQueue: ChatMessage[] = [];
  private globalChatLock: BotLockInfo | null = null;
  private running = false;
  private logFn: (category: string, message: string) => void;
  
  // Duplicate detection: track message hashes seen in last 10 minutes
  private seenMessages = new Map<string, number>();
  private readonly SEEN_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes
  
  // Conversation tracking: prevent infinite loops
  // Track last AI response time per channel+sender pair
  // Cooldown is configurable via settings (default 15 seconds)
  private conversationCooldowns = new Map<string, number>();
  private getConversationCooldownMs(): number {
    try {
      const settings = getAiChatSettings();
      return (settings.conversationCooldownSec || 15) * 1000;
    } catch {
      return 15 * 1000; // fallback to 15 seconds
    }
  }
  
  // Track consecutive AI responses to prevent loops
  private consecutiveResponses = new Map<string, number>();
  private readonly MAX_CONSECUTIVE_RESPONSES = 3; // Max 3 AI responses in a row before requiring human input
  
  // Chat log file
  private readonly CHAT_LOG_FILE = join(process.cwd(), "data", "chat.log");

  constructor(logFn: (category: string, message: string) => void) {
    this.logFn = logFn;
    // Ensure data directory exists
    const dataDir = join(process.cwd(), "data");
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }
  }

  /**
   * Generate a hash for duplicate detection.
   * For mentions, include botUsername so different bots can respond to their own mentions.
   * For non-mention messages, exclude botUsername so only one bot responds.
   */
  private getMessageHash(msg: ChatMessage, isMention: boolean): string {
    const minute = Math.floor(msg.timestamp / 60000);
    // For mentions, include botUsername so different bots can respond to their own mentions
    // For non-mentions, exclude botUsername so only one bot responds to "respond to all"
    if (isMention) {
      return `${msg.sender}|${msg.channel}|${msg.content}|${minute}|${msg.botUsername || "unknown"}`;
    } else {
      return `${msg.sender}|${msg.channel}|${msg.content}|${minute}`;
    }
  }

  /**
   * Get conversation key for tracking.
   */
  private getConversationKey(channel: string, participants: string[]): string {
    return `${channel}|${[...participants].sort().join('|')}`;
  }

  /**
   * Check if this is a duplicate message.
   */
  private isDuplicate(msg: ChatMessage, isMention: boolean = false): boolean {
    const now = Date.now();
    const hash = this.getMessageHash(msg, isMention);

    // Clean up expired entries
    for (const [key, timestamp] of this.seenMessages.entries()) {
      if (now - timestamp > this.SEEN_EXPIRY_MS) {
        this.seenMessages.delete(key);
      }
    }

    const prevTime = this.seenMessages.get(hash);
    if (prevTime !== undefined) {
      return true;
    }

    this.seenMessages.set(hash, now);
    return false;
  }

  /**
   * Check if we should respond based on conversation cooldown and loop prevention.
   * Returns: { allowed: boolean, reason: string }
   */
  private checkConversationLimits(channel: string, participants: string[]): { allowed: boolean; reason: string } {
    const now = Date.now();
    const convKey = this.getConversationKey(channel, participants);
    const cooldownMs = this.getConversationCooldownMs();

    // Check cooldown
    const lastResponse = this.conversationCooldowns.get(convKey);
    if (lastResponse !== undefined) {
      const timeSinceLast = now - lastResponse;
      if (timeSinceLast < cooldownMs) {
        const remaining = Math.round((cooldownMs - timeSinceLast) / 1000);
        return { allowed: false, reason: `cooldown (${remaining}s remaining)` };
      }
    }

    // Check consecutive responses
    const consecutive = this.consecutiveResponses.get(convKey) || 0;
    if (consecutive >= this.MAX_CONSECUTIVE_RESPONSES) {
      return { allowed: false, reason: `max consecutive responses (${consecutive})` };
    }

    return { allowed: true, reason: 'ok' };
  }

  /**
   * Record that AI responded to a conversation.
   */
  private recordResponse(channel: string, participants: string[], isHumanSender: boolean): void {
    const now = Date.now();
    const convKey = this.getConversationKey(channel, participants);
    const cooldownMs = this.getConversationCooldownMs();

    // Update cooldown
    this.conversationCooldowns.set(convKey, now);

    // Update consecutive counter
    if (isHumanSender) {
      // Human spoke, reset counter
      this.consecutiveResponses.set(convKey, 1);
    } else {
      // AI spoke, increment counter
      const current = this.consecutiveResponses.get(convKey) || 0;
      this.consecutiveResponses.set(convKey, current + 1);
    }

    // Clean up old entries periodically
    if (this.conversationCooldowns.size > 100) {
      for (const [key, timestamp] of this.conversationCooldowns.entries()) {
        if (now - timestamp > cooldownMs * 2) {
          this.conversationCooldowns.delete(key);
          this.consecutiveResponses.delete(key);
        }
      }
    }
  }

  /**
   * Log chat message to file (both received and sent).
   */
  private logChat(entry: {
    timestamp: string;
    direction: "IN" | "OUT";
    channel: string;
    sender: string;
    content: string;
    botName?: string;
  }): void {
    try {
      const line = `${entry.timestamp} [${entry.channel}] ${entry.direction} ${entry.sender}${entry.botName ? ` via ${entry.botName}` : ""}: ${entry.content}`;
      appendFileSync(this.CHAT_LOG_FILE, line + "\n", "utf-8");
    } catch (err) {
      this.logFn("error", `Failed to write chat log: ${err}`);
    }
  }

  /**
   * Add a chat message to the queue.
   */
  addChatMessage(msg: ChatMessage): void {
    // Check if message mentions any bot
    const bots = AiChatService.getBots();
    let isMention = false;
    if (bots) {
      for (const bot of bots) {
        if (messageMentionsBot(msg.content, bot.username)) {
          isMention = true;
          break;
        }
      }
    }

    // Check for duplicates
    // For mentions: allow same message to different bots (each mentioned bot can respond)
    // For non-mentions: deduplicate across all bots (only one bot should respond to "respond to all")
    if (this.isDuplicate(msg, isMention)) {
      this.logFn("ai_chat_debug", `Duplicate message ignored: ${msg.sender} - ${msg.content.slice(0, 50)}`);
      return;
    }

    // Log incoming message
    this.logChat({
      timestamp: new Date().toISOString(),
      direction: "IN",
      channel: msg.channel,
      sender: msg.sender,
      content: msg.content,
      botName: msg.botUsername,
    });

    this.logFn("ai_chat_debug", `Message added to queue: channel=${msg.channel}, sender=${msg.sender}, botUsername=${msg.botUsername}, content=${msg.content.slice(0, 50)}`);
    this.chatMessageQueue.push(msg);
    if (this.chatMessageQueue.length > 100) {
      this.chatMessageQueue = this.chatMessageQueue.slice(-100);
    }
  }

  /**
   * Start the AI Chat service background loop.
   */
  start(): void {
    if (this.running) {
      this.logFn("ai_chat", "Service already running");
      return;
    }
    
    this.running = true;
    this.logFn("ai_chat", "Service started");
    this.runLoop().catch(err => {
      this.logFn("error", `AI Chat service error: ${err}`);
      this.running = false;
    });
  }

  /**
   * Stop the AI Chat service.
   */
  stop(): void {
    this.running = false;
    this.logFn("ai_chat", "Service stopped");
  }

  /**
   * Check if service is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get lock info (for debugging).
   */
  getLockInfo(): BotLockInfo | null {
    return this.globalChatLock;
  }

  private async runLoop(): Promise<void> {
    let lastCycleTime = 0;

    while (this.running) {
      try {
        const settings = getAiChatSettings();

        // Check if enabled
        if (!settings.enabled) {
          // Clear the queue to prevent processing stale messages when re-enabled
          this.chatMessageQueue = [];
          await sleep(5000);
          continue;
        }

        // Rate limit cycles
        const now = Date.now();
        if (now - lastCycleTime < settings.cycleIntervalSec * 1000) {
          await sleep(500);
          continue;
        }
        lastCycleTime = now;

        if (!settings.baseUrl) {
          this.logFn("error", "AI Chat: Base URL not set — check settings");
          await sleep(30_000);
          continue;
        }

        // Get new chat messages
        const messages = [...this.chatMessageQueue];
        this.chatMessageQueue = [];

        if (messages.length === 0) {
          await sleep(settings.cycleIntervalSec * 1000);
          continue;
        }

        this.logFn("ai_chat", `Processing ${messages.length} chat message(s)`);

        // Process each message
        for (const msg of messages) {
          this.logFn("ai_chat_debug", `About to process message: channel=${msg.channel}, sender=${msg.sender}, content=${msg.content.slice(0, 30)}`);
          await this.processMessage(msg, settings);
        }
      } catch (err) {
        this.logFn("error", `AI Chat loop error: ${err instanceof Error ? err.message : String(err)}`);
        await sleep(5000);
      }
    }
  }

  private async processMessage(
    msg: ChatMessage,
    settings: ReturnType<typeof getAiChatSettings>
  ): Promise<void> {
    // Log message details for debugging
    this.logFn("ai_chat_debug", `Processing message: channel=${msg.channel}, sender=${msg.sender}, botUsername=${msg.botUsername}, botSystem=${msg.botSystem}, botPoi=${msg.botPoi}`);

    // Monitor local, faction, system, and private chat
    if (msg.channel !== "local" && msg.channel !== "faction" && msg.channel !== "system" && msg.channel !== "private") {
      return;
    }

    // For private messages: ALWAYS respond with the bot that received the message
    // This prevents bot2 from responding to a DM intended for bot1
    if (msg.channel === "private") {
      const receivingBot = msg.botUsername;
      if (!receivingBot) {
        this.logFn("ai_chat_debug", "Private message received but no botUsername set - cannot respond");
        return;
      }

      this.logFn("ai_chat_debug", `Private message to ${receivingBot} from ${msg.sender}`);

      // Check if message mentions a different bot - if so, still let the receiving bot respond
      // (the player DM'd this bot, so this bot should respond regardless of mentions)
      const responder = this.selectResponderByMention(receivingBot);
      if (!responder) {
        this.logFn("ai_chat", `Bot ${receivingBot} not available to respond to private message`);
        return;
      }

      await this.handleResponse(responder, msg, settings, msg.sender, true);
      return;
    }

    // For system chat, check if enabled
    if (msg.channel === "system" && !settings.respondToSystem) {
      this.logFn("ai_chat_debug", `System chat disabled, ignoring: ${msg.sender} - ${msg.content.slice(0, 50)}`);
      return;
    }

    // Skip MAYDAY messages if disabled (player won't see responses anyway)
    if (msg.content.includes("MAYDAY") && !settings.respondToMayday) {
      this.logFn("ai_chat_debug", `MAYDAY response disabled, ignoring: ${msg.sender} - ${msg.content.slice(0, 50)}`);
      return;
    }

    // Skip messages from AI bots (prevent self-talk loops)
    // BUT: Allow the mentioned bot to respond even if it recently sent messages
    const bots = AiChatService.getBots();
    const isFromAiBot = bots?.some(b => b.username === msg.sender);
    
    if (isFromAiBot) {
      // Check if this message mentions a different bot - if so, allow it through
      // This prevents AI-to-AI loops while allowing mentioned bots to respond
      let mentionedBotName: string | null = null;
      for (const bot of bots || []) {
        if (messageMentionsBot(msg.content, bot.username)) {
          mentionedBotName = bot.username;
          break;
        }
      }
      
      // If message mentions a bot, it's likely a human message that got attributed wrong
      // OR it's an AI responding to a human - either way, let it through for mention processing
      if (mentionedBotName) {
        this.logFn("ai_chat_debug", `Message from AI bot ${msg.sender} mentions ${mentionedBotName} - processing for mention`);
      } else {
        this.logFn("ai_chat_debug", `Ignoring message from AI bot: ${msg.sender}`);
        return;
      }
    }

    // Check if message mentions ANY of our bots
    let mentionedBotName: string | null = null;
    for (const bot of bots || []) {
      if (messageMentionsBot(msg.content, bot.username)) {
        mentionedBotName = bot.username;
        this.logFn("ai_chat_debug", `Message mentions bot: ${bot.username}`);
        break; // First match wins
      }
    }

    // If a specific bot is mentioned, ONLY that bot can respond
    // This prevents other bots from responding even with "respond to all" enabled
    if (mentionedBotName) {
      this.logFn("ai_chat_debug", `Message mentions ${mentionedBotName}, checking if it should respond...`);
      
      // Check if the receiving bot is the mentioned bot
      const receivingBot = msg.botUsername || "";
      this.logFn("ai_chat_debug", `Receiving bot: ${receivingBot}, mentioned bot: ${mentionedBotName}`);
      
      if (receivingBot !== mentionedBotName) {
        // This bot received the message but wasn't the one mentioned - skip silently
        this.logFn("ai_chat_debug", `Received by ${receivingBot} but mentions ${mentionedBotName} - skipping`);
        return;
      }
      
      // The receiving bot IS the mentioned bot - proceed with mention response
      this.logFn("ai_chat", `Processing mention: ${mentionedBotName} received message mentioning them`);
      const responder = this.selectResponderByMention(mentionedBotName);
      if (!responder) {
        this.logFn("ai_chat", `Mentioned bot ${mentionedBotName} not available to respond`);
        return;
      }
      
      this.logFn("ai_chat", `Responding to mention: ${mentionedBotName}`);
      await this.handleResponse(responder, msg, settings, msg.sender, true);
      return;
    }

    // No bot mentioned - check normal response rules
    let shouldRespond = false;
    let reason = "";

    if (settings.respondToAll) {
      shouldRespond = true;
      reason = "all messages";
    } else if (settings.respondToQuestions && isGeneralQuestion(msg.content)) {
      shouldRespond = true;
      reason = "question";
    }

    if (!shouldRespond) {
      this.logFn("ai_chat_debug", `Ignored [${msg.channel}] ${msg.sender}: ${msg.content.slice(0, 50)}`);
      return;
    }

    this.logFn("ai_chat", `Should respond to [${msg.channel}] ${msg.sender}: ${reason}`);

    // Select responder for non-mention messages
    // For local chat, prefer the bot that received the message (guaranteed to be at correct location)
    const responder = this.selectResponder(msg, msg.channel === "local" ? (msg.botUsername || "") : "");
    if (!responder) {
      this.logFn("ai_chat", "No available bot to respond");
      return;
    }

    this.logFn("ai_chat", `Selected responder: ${responder.username}`);
    await this.handleResponse(responder, msg, settings, msg.sender, true);
  }

  /**
   * Handle response logic (lock, limits, send).
   * For local chat, verifies bot is at same location as receiving bot.
   */
  private async handleResponse(
    responder: Bot,
    msg: ChatMessage,
    settings: ReturnType<typeof getAiChatSettings>,
    humanSender: string,
    isHumanSender: boolean,
    triedBots: Set<string> = new Set()
  ): Promise<void> {
    // Check conversation limits (cooldown, consecutive responses)
    // Use channel + human sender as key (not responder) so only one bot responds per conversation
    const participants = [humanSender]; // Don't include responder - conversation is per channel+sender
    const limits = this.checkConversationLimits(msg.channel, participants);
    if (!limits.allowed) {
      this.logFn("ai_chat", `Skipping: ${limits.reason}`);
      return;
    }

    // Check global lock
    const channelId = `${msg.channel}:${responder.system || "unknown"}`;
    if (!this.canRespond(responder.username, humanSender, channelId, settings.lockDurationSec)) {
      this.logFn("ai_chat", `Lock held, skipping`);
      return;
    }

    // For LOCAL chat: verify responder is at same location as receiving bot
    // Skip this check if the responder IS the receiving bot (it obviously can respond to messages it received)
    if (msg.channel === "local" && responder.username !== msg.botUsername) {
      const locationMatch = this.checkLocationMatch(responder, msg);
      if (!locationMatch.matched) {
        this.logFn("ai_chat", `${responder.username} at wrong location (${responder.system}/${responder.poi}), message was from ${msg.botSystem}/${msg.botPoi}`);

        // Try to find a bot at the correct location
        const locationBot = this.findBotAtLocation(msg, triedBots);
        if (locationBot) {
          this.logFn("ai_chat", `Found bot at correct location: ${locationBot.username}`);
          triedBots.add(responder.username);
          await this.handleResponse(locationBot, msg, settings, humanSender, isHumanSender, triedBots);
          return;
        } else {
          this.logFn("ai_chat", "No bot at correct location, skipping response");
          return;
        }
      }
    } else if (msg.channel === "local" && responder.username === msg.botUsername) {
      // Log that we're skipping location check for receiving bot
      this.logFn("ai_chat_debug", `Skipping location check for ${responder.username} (is the receiving bot)`);
    }

    // Try to acquire lock
    if (!this.tryAcquireLock(responder.username, humanSender, channelId, settings.lockDurationSec)) {
      this.logFn("ai_chat", `Failed to acquire lock`);
      return;
    }

    // Generate and send response (may fail if traveling for local chat)
    const result = await this.sendResponse(responder, msg, settings, humanSender, triedBots);
    
    if (result === "traveling" && msg.channel === "local") {
      // Bot was traveling, try to find another bot that received this message
      this.logFn("ai_chat", `${responder.username} is traveling, trying to find alternative bot...`);
      
      const alternativeBot = this.findAlternativeBot(msg, responder.username, triedBots);
      if (alternativeBot) {
        this.logFn("ai_chat", `Found alternative: ${alternativeBot.username}`);
        triedBots.add(responder.username);
        await this.handleResponse(alternativeBot, msg, settings, humanSender, isHumanSender, triedBots);
        return;
      } else {
        this.logFn("ai_chat", "No alternative bot available, skipping response");
      }
    }
    
    // Record this response for conversation tracking (only if not traveling)
    if (result !== "traveling") {
      this.recordResponse(msg.channel, participants, isHumanSender);
    }
  }

  /**
   * Check if responder bot is at same location as the message's receiving bot.
   */
  private checkLocationMatch(responder: Bot, msg: ChatMessage): { matched: boolean; reason: string } {
    // If message has no location info, assume it's ok
    if (!msg.botSystem || !msg.botPoi) {
      return { matched: true, reason: "no location info" };
    }
    
    // Check if responder is at same system and POI
    if (responder.system !== msg.botSystem) {
      return { matched: false, reason: `different system: ${responder.system} vs ${msg.botSystem}` };
    }
    
    if (responder.poi !== msg.botPoi) {
      return { matched: false, reason: `different POI: ${responder.poi} vs ${msg.botPoi}` };
    }
    
    return { matched: true, reason: "location matches" };
  }

  /**
   * Find a bot at the same location as the original message receiver.
   */
  private findBotAtLocation(msg: ChatMessage, triedBots: Set<string>): Bot | null {
    const bots = AiChatService.getBots();
    if (!bots || bots.length === 0) return null;
    if (!msg.botSystem || !msg.botPoi) return null;

    for (const bot of bots) {
      if (triedBots.has(bot.username)) continue;
      if (bot.state !== "running" && bot.state !== "idle") continue;
      if (!bot.api.getSession()) continue;
      
      // Check if bot is at same location
      if (bot.system === msg.botSystem && bot.poi === msg.botPoi) {
        return bot;
      }
    }
    
    return null;
  }

  /**
   * Find an alternative bot that also received the message and isn't traveling.
   * For local chat, also verifies location match.
   */
  private findAlternativeBot(msg: ChatMessage, excludeBot: string, triedBots: Set<string>): Bot | null {
    const bots = AiChatService.getBots();
    if (!bots || bots.length === 0) return null;

    // Find bots that aren't traveling and haven't been tried
    for (const bot of bots) {
      if (bot.username === excludeBot) continue;
      if (triedBots.has(bot.username)) continue;
      if (bot.state !== "running" && bot.state !== "idle") continue;
      if (!bot.api.getSession()) continue;
      
      // Check if bot is traveling
      if (!bot.poi || bot.poi === "") {
        this.logFn("ai_chat_debug", `${bot.username} is traveling (no POI), skipping`);
        continue;
      }
      
      // For local chat, also check location match
      if (msg.channel === "local") {
        if (msg.botSystem && msg.botPoi) {
          if (bot.system !== msg.botSystem || bot.poi !== msg.botPoi) {
            this.logFn("ai_chat_debug", `${bot.username} at wrong location (${bot.system}/${bot.poi}), skipping`);
            continue;
          }
        }
      }
      
      return bot;
    }
    
    return null;
  }

  /**
   * Select a specific bot by name (for mention-based responses).
   */
  private selectResponderByMention(botName: string): Bot | null {
    const bots = AiChatService.getBots();
    if (!bots || bots.length === 0) return null;

    const target = bots.find(b => b.username === botName);
    if (target && (target.state === "running" || target.state === "idle") && target.api.getSession()) {
      return target;
    }
    return null;
  }

  /**
   * Select which bot should respond to a message.
   * Priority: mentioned bot > receiving bot > any available bot
   * Bots can be idle or running (AI Chat is a background service).
   */
  private selectResponder(msg: ChatMessage, receivingBot: string): Bot | null {
    const bots = AiChatService.getBots();
    this.logFn("ai_chat_debug", `selectResponder: receivingBot=${receivingBot}, total bots=${bots?.length || 0}`);
    if (!bots || bots.length === 0) {
      this.logFn("ai_chat_debug", "No bots available");
      return null;
    }

    // Log all bots and their states
    for (const b of bots) {
      this.logFn("ai_chat_debug", `  Bot: ${b.username}, state=${b.state}, hasSession=${!!b.api.getSession()}`);
    }

    // Find the receiving bot if specified
    if (receivingBot) {
      const target = bots.find(b => b.username === receivingBot);
      this.logFn("ai_chat_debug", `Looking for ${receivingBot}: found=${!!target}, state=${target?.state}, session=${!!target?.api.getSession()}`);
      if (target && (target.state === "running" || target.state === "idle") && target.api.getSession()) {
        return target;
      }
    }

    // Find any available bot (idle or running with active session)
    // Prefer bots that aren't currently locked
    for (const bot of bots) {
      this.logFn("ai_chat_debug", `Checking bot ${bot.username}: state=${bot.state}, locked=${this.globalChatLock?.botName === bot.username}`);
      if ((bot.state !== "running" && bot.state !== "idle") || !bot.api.getSession()) continue;
      if (this.globalChatLock && this.globalChatLock.botName === bot.username) continue;
      this.logFn("ai_chat_debug", `Selected ${bot.username} as responder`);
      return bot;
    }

    // Fallback to first bot with session
    const fallback = bots.find(b => (b.state === "running" || b.state === "idle") && b.api.getSession());
    this.logFn("ai_chat_debug", `Fallback: ${fallback?.username || "none"}`);
    return fallback || null;
  }

  private canRespond(botName: string, sender: string, channel: string, lockDurationSec: number): boolean {
    const now = Date.now();
    
    if (this.globalChatLock && this.globalChatLock.lockedUntil < now) {
      this.globalChatLock = null;
    }
    
    if (!this.globalChatLock) return true;
    
    if (this.globalChatLock.botName === botName && 
        this.globalChatLock.lastSender === sender && 
        this.globalChatLock.channelId === channel) {
      return true;
    }
    
    return false;
  }

  private tryAcquireLock(botName: string, sender: string, channel: string, lockDurationSec: number): boolean {
    const now = Date.now();
    
    if (this.globalChatLock && this.globalChatLock.lockedUntil < now) {
      this.globalChatLock = null;
    }
    
    if (!this.globalChatLock) {
      this.globalChatLock = {
        botName,
        lockedUntil: now + (lockDurationSec * 1000),
        lastSender: sender,
        channelId: channel,
      };
      return true;
    }
    
    if (this.globalChatLock.botName === botName && 
        this.globalChatLock.lastSender === sender && 
        this.globalChatLock.channelId === channel) {
      this.globalChatLock.lockedUntil = now + (lockDurationSec * 1000);
      return true;
    }
    
    return false;
  }

  private async sendResponse(
    bot: Bot,
    msg: ChatMessage,
    settings: ReturnType<typeof getAiChatSettings>,
    humanSender: string,
    triedBots: Set<string>
  ): Promise<"sent" | "traveling" | "error"> {
    const mem = loadMemory();
    mem.responseCount++;

    // Load bot-specific personality
    const personality = getBotPersonality(bot.username);
    const hasCustomPersonality = personality !== DEFAULT_PERSONALITY;
    this.logFn("ai_chat_debug", `Using ${hasCustomPersonality ? "custom" : "default"} personality for ${bot.username}`);

    // Load galaxy map data for factual responses
    const mapSummary = getCachedMapSummary();

    const systemPrompt = `${personality}

## Galaxy Map Data (Real Game Data)
Use this information to help answer questions about systems, stations, resources, and connections.

${mapSummary}

## Your Current Context
- Your name in the game is: ${bot.username}
- You are currently in system: ${bot.system || "unknown"}
- Chat channel: ${msg.channel}

## Response Rules
- Keep responses short (1-3 sentences max)
- Be natural and conversational
- Don't spam or be repetitive
- Use the map data above to provide accurate information about systems and resources
- If asked about a system not listed, mention there are many more systems and suggest using /get_system in-game
- If asked about game mechanics, share what you know`;

    const recentHistory = mem.conversationHistory
      .filter(h => h.channel.startsWith(msg.channel))
      .slice(-5)
      .map(h => `${h.sender}: ${h.message} → You: ${h.response}`)
      .join("\n");

    const userMessage = `${recentHistory ? `Recent conversation:\n${recentHistory}\n\n` : ""}New message from ${msg.sender} in #${msg.channel}:\n"${msg.content}"\n\nRespond naturally:`;

    const llmMessages: LlmMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];

    try {
      const response = await callLlm(llmMessages, settings);
      const cleanResponse = response.trim().replace(/^["']|["']$/g, "");

      // Build chat command parameters
      const chatParams: Record<string, string> = {
        channel: msg.channel,
        content: cleanResponse,
      };

      // Add target_id for private messages
      if (msg.channel === "private" && msg.targetId) {
        chatParams.target_id = msg.targetId;
      }

      const chatResp = await bot.exec("chat", chatParams);

      if (!chatResp.error) {
        this.logFn("ai_chat", `→ ${bot.username} responded: ${cleanResponse}`);

        // Log outgoing message to chat log file
        this.logChat({
          timestamp: new Date().toISOString(),
          direction: "OUT",
          channel: msg.channel,
          sender: bot.username,
          content: cleanResponse,
        });

        // Log to bot's activity log for private messages
        if (msg.channel === "private") {
          bot.log("chat", `📤 Private to ${msg.sender}: ${cleanResponse}`);
        }

        mem.lastResponse = cleanResponse;
        mem.conversationHistory.push({
          timestamp: new Date().toISOString(),
          sender: msg.sender,
          channel: msg.channel,
          message: msg.content,
          response: cleanResponse,
          botName: bot.username,
        });

        if (mem.conversationHistory.length > 50) {
          mem.conversationHistory = mem.conversationHistory.slice(-50);
        }
        saveMemory(mem);
        return "sent";
      } else {
        // Check if error is due to traveling
        const errorMsg = chatResp.error.message || "";
        if (msg.channel === "local" && (
          errorMsg.includes("traveling") || 
          errorMsg.includes("Cannot send local chat")
        )) {
          this.logFn("ai_chat_debug", `${bot.username} is traveling (error: ${errorMsg})`);
          return "traveling";
        }
        
        this.logFn("error", `Chat send failed: ${errorMsg}`);
        return "error";
      }
    } catch (llmErr) {
      this.logFn("error", `LLM error: ${llmErr instanceof Error ? llmErr.message : String(llmErr)}`);
      return "error";
    }
  }

  /**
   * Send a private/direct message with LLM-generated content.
   * Used for out-of-faction communication (e.g., MAYDAY responses).
   */
  async sendPrivateMessage(
    bot: Bot,
    targetPlayer: string,
    context: {
      situation: string;
      currentSystem: string;
      targetSystem: string;
      jumps?: number;
      fuelRefueled?: number;
      playerFuelPct?: number;
    },
    personality?: string
  ): Promise<{ ok: boolean; message?: string; error?: string }> {
    const settings = getAiChatSettings();

    // Check if AI Chat is enabled
    if (!settings.enabled) {
      this.logFn("ai_chat_debug", `Private message skipped: AI Chat is disabled (enabled=${settings.enabled})`);
      return { ok: false, error: "AI Chat is disabled" };
    }
    
    this.logFn("ai_chat_debug", `AI Chat enabled: ${settings.enabled}, sending private message...`);

    // Build system prompt for private message generation
    const systemPrompt = `${personality || "You are a helpful rescue pilot in SpaceMolt."}

Context:
- Your callsign: ${bot.username}
- You are currently in: ${context.currentSystem}
- Stranded pilot is in: ${context.targetSystem}${context.jumps ? ` (${context.jumps} jumps away)` : ""}
- ${context.situation}

Task:
Generate a brief radio transmission message (max 2 sentences) to send via private chat to the stranded pilot.

Style:
- Keep it natural and in-character
- Be concise (this is a radio transmission)
- Include relevant details (ETA, jumps, etc.) if provided
- Don't be overly verbose`;

    const userMessage = `Generate a private message to ${targetPlayer}:

Situation: ${context.situation}
${context.jumps ? `Jumps remaining: ${context.jumps}` : ""}
${context.fuelRefueled ? `Fuel transferred: ${context.fuelRefueled}` : ""}
${context.playerFuelPct ? `Their fuel before: ${context.playerFuelPct}%` : ""}

Message:`;

    const llmMessages: LlmMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];

    try {
      const response = await callLlm(llmMessages, settings);
      const cleanResponse = response.trim().replace(/^["']|["']$/g, "");

      // Send private message using: chat channel=private target_id="PlayerName" content="message"
      const chatResp = await bot.exec("chat", {
        channel: "private",
        target_id: targetPlayer,
        content: cleanResponse,
      });

      if (!chatResp.error) {
        this.logFn("ai_chat", `→ Private message to ${targetPlayer}: ${cleanResponse}`);

        // Log outgoing message to chat log file
        this.logChat({
          timestamp: new Date().toISOString(),
          direction: "OUT",
          channel: "private",
          sender: bot.username,
          content: cleanResponse,
        });

        // Log to bot's activity log
        bot.log("chat", `📤 Private to ${targetPlayer}: ${cleanResponse}`);

        return { ok: true, message: cleanResponse };
      } else {
        this.logFn("error", `Private message to ${targetPlayer} failed: ${chatResp.error.message}`);
        return { ok: false, error: chatResp.error.message };
      }
    } catch (llmErr) {
      this.logFn("error", `LLM error: ${llmErr instanceof Error ? llmErr.message : String(llmErr)}`);
      return { ok: false, error: llmErr instanceof Error ? llmErr.message : String(llmErr) };
    }
  }

  /**
   * Send a faction chat message with LLM-generated content.
   * Used for announcing rescue operations to faction members.
   */
  async sendFactionMessage(
    bot: Bot,
    context: {
      messageType: "rescue_start" | "rescue_arrived" | "rescue_complete" | "rescue_no_show";
      targetName: string;
      isMayday?: boolean;
      isBot?: boolean;
      currentSystem: string;
      targetSystem: string;
      targetPoi?: string;
      targetFuelPct?: number;
      jumps?: number;
    },
    personality?: string
  ): Promise<{ ok: boolean; message?: string; error?: string }> {
    const settings = getAiChatSettings();

    // Check if AI Chat is enabled
    if (!settings.enabled) {
      this.logFn("ai_chat_debug", `Faction message skipped: AI Chat is disabled (enabled=${settings.enabled})`);
      return { ok: false, error: "AI Chat is disabled" };
    }
    
    this.logFn("ai_chat_debug", `AI Chat enabled: ${settings.enabled}, sending faction message...`);

    const { messageType, targetName, isMayday = false, isBot = false, targetFuelPct, jumps } = context;

    // Build situation description based on message type
    let situation: string;
    let styleGuide: string;

    switch (messageType) {
      case "rescue_start":
        situation = isMayday
          ? `You received a MAYDAY distress call from ${targetName} and are launching a rescue mission.`
          : `One of your faction bots (${targetName}) needs emergency fuel rescue.`;
        styleGuide = isMayday
          ? "Be heroic and reassuring. Let faction members know you're responding to an emergency."
          : "Be helpful and team-oriented. Let faction members know you're helping a fellow bot.";
        break;
      case "rescue_arrived":
        situation = `You have arrived at ${context.targetSystem}${context.targetPoi ? `/${context.targetPoi}` : ""} to assist ${targetName}.`;
        styleGuide = "Be confident and professional. Announce your arrival.";
        break;
      case "rescue_complete":
        situation = `You have successfully refueled ${targetName} and they are now safe.`;
        styleGuide = "Be triumphant and positive. Celebrate the successful rescue.";
        break;
      case "rescue_no_show":
        situation = `You traveled all the way to ${context.targetSystem}${context.targetPoi ? `/${context.targetPoi}` : ""} to help ${targetName}, but they were not there.`;
        styleGuide = "Be grumpy and annoyed. Express frustration about the wasted trip. Maybe mutter about being ghosted.";
        break;
    }

    // Build system prompt for faction message generation
    const systemPrompt = `${personality || "You are a rescue pilot in SpaceMolt."}

Context:
- Your callsign: ${bot.username}
- You are currently in: ${context.currentSystem}
- Target is in: ${context.targetSystem}${context.targetPoi ? `/${context.targetPoi}` : ""}${jumps ? ` (${jumps} jumps from your previous location)` : ""}
- ${situation}
- This message goes to FACTION chat (all faction members can see it)

Task:
Generate a brief faction chat message (max 2 sentences) about the rescue operation.

Style:
- Keep it natural and in-character
- Be concise (faction chat is public)
- ${styleGuide}
- ${messageType === "rescue_no_show" ? "Show genuine annoyance - you wasted fuel and time!" : "Include relevant details (who, where, status) if appropriate"}
- Don't be overly verbose`;

    const userMessage = `Generate a faction chat message:

Message type: ${messageType}
Target: ${targetName} (${isBot ? "faction bot" : "player"}${isMayday ? ", MAYDAY distress call" : ""})
${targetFuelPct ? `Their fuel level: ${targetFuelPct}%` : ""}
Location: ${context.targetSystem}${context.targetPoi ? `/${context.targetPoi}` : ""}
${jumps ? `Jumps to get there: ${jumps}` : ""}

Message:`;

    const llmMessages: LlmMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];

    try {
      const response = await callLlm(llmMessages, settings);
      const cleanResponse = response.trim().replace(/^["']|["']$/g, "");

      // Send faction chat message
      const chatResp = await bot.exec("chat", {
        channel: "faction",
        content: cleanResponse,
      });

      if (!chatResp.error) {
        this.logFn("ai_chat", `→ Faction chat: ${cleanResponse}`);
        return { ok: true, message: cleanResponse };
      } else {
        this.logFn("error", `Faction message failed: ${chatResp.error.message}`);
        return { ok: false, error: chatResp.error.message };
      }
    } catch (llmErr) {
      this.logFn("error", `LLM error: ${llmErr instanceof Error ? llmErr.message : String(llmErr)}`);
      return { ok: false, error: llmErr instanceof Error ? llmErr.message : String(llmErr) };
    }
  }

  // Static reference to bots array from botmanager
  private static getBots: () => Bot[] = () => [];

  static setGetBotsFn(fn: () => Bot[]): void {
    AiChatService.getBots = fn;
  }

  /**
   * Get current AI Chat settings.
   */
  getSettings(): ReturnType<typeof getAiChatSettings> {
    return getAiChatSettings();
  }

  /**
   * Trigger a customs inspection response via AI Chat.
   * Called by the customs service when a customs interaction occurs.
   */
  async triggerCustomsResponse(
    botName: string,
    context: {
      messageType: "stop_request" | "cleared" | "contraband" | "evasion";
      customsMessage: string;
      botStops: number;
    }
  ): Promise<void> {
    const settings = getAiChatSettings();

    // Check if AI Chat is enabled
    if (!settings.enabled) {
      this.logFn("ai_chat_debug", "Customs response skipped: AI Chat is disabled");
      return;
    }

    const bots = AiChatService.getBots();
    const bot = bots.find(b => b.username === botName);

    if (!bot) {
      this.logFn("error", `Customs response: Bot ${botName} not found`);
      return;
    }
    const personality = getBotPersonality(botName);
    
    // Build context for the LLM
    const systemPrompt = `${personality}

Context:
- You are ${botName} in SpaceMolt
- You are currently in an empire system
- Customs has stopped you for a cargo scan
- This has happened ${context.botStops} time(s) to you

Task:
Generate a brief chat message response to the customs agent.

Style:
- Keep it in-character with your personality
- Be concise (1-2 sentences max)
- For stop_request: Acknowledge compliance or express mild annoyance
- For cleared: Express relief or gratitude
- For contraband: Show surprise, denial, or acceptance depending on personality
- For evasion: Be defensive or apologetic`;

    let userMessage = "";
    switch (context.messageType) {
      case "stop_request":
        userMessage = `Customs said: "${context.customsMessage}"
Respond acknowledging you'll comply (or expressing your personality about having to wait).`;
        break;
      case "cleared":
        userMessage = `Customs said: "${context.customsMessage}"
Respond to being cleared (relief, gratitude, or your typical personality).`;
        break;
      case "contraband":
        userMessage = `Customs said: "${context.customsMessage}"
They found contraband! Respond with your personality (denial, acceptance, surprise, etc.).`;
        break;
      case "evasion":
        userMessage = `Customs said: "${context.customsMessage}"
They're warning you for not staying still. Respond defensively or apologetically.`;
        break;
    }

    const llmMessages: LlmMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];

    try {
      const response = await callLlm(llmMessages, settings);
      const cleanResponse = response.trim().replace(/^["']|["']$/g, "");

      // Send chat message to system channel
      const chatResp = await bot.exec("chat", {
        channel: "system",
        content: cleanResponse,
      });

      if (!chatResp.error) {
        this.logFn("ai_chat", `→ Customs response: ${cleanResponse}`);
      } else {
        this.logFn("error", `Customs response failed: ${chatResp.error.message}`);
      }
    } catch (llmErr) {
      this.logFn("error", `Customs LLM error: ${llmErr instanceof Error ? llmErr.message : String(llmErr)}`);
    }
  }
}
