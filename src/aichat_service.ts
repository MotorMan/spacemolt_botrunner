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
}

interface BotLockInfo {
  botName: string;
  lockedUntil: number;
  lastSender: string;
  channelId: string;
}

// ── Settings ─────────────────────────────────────────────────

const PERSONALITIES_DIR = join(process.cwd(), "data", "personalities");

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
  personality: string;
  lockDurationSec: number;
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
    personality: (s.personality as string) || DEFAULT_PERSONALITY,
    lockDurationSec: (s.lockDurationSec as number) || 60,
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
  private conversationCooldowns = new Map<string, number>();
  private readonly CONVERSATION_COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes between AI responses in same conversation
  
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
   * Now includes botUsername to allow same message to different bots.
   */
  private getMessageHash(msg: ChatMessage): string {
    const minute = Math.floor(msg.timestamp / 60000);
    // Include botUsername in hash so same message to different bots isn't marked as duplicate
    return `${msg.sender}|${msg.channel}|${msg.content}|${minute}|${msg.botUsername || "unknown"}`;
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
  private isDuplicate(msg: ChatMessage): boolean {
    const now = Date.now();
    const hash = this.getMessageHash(msg);
    
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
    
    // Check cooldown
    const lastResponse = this.conversationCooldowns.get(convKey);
    if (lastResponse !== undefined) {
      const timeSinceLast = now - lastResponse;
      if (timeSinceLast < this.CONVERSATION_COOLDOWN_MS) {
        const remaining = Math.round((this.CONVERSATION_COOLDOWN_MS - timeSinceLast) / 1000);
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
        if (now - timestamp > this.CONVERSATION_COOLDOWN_MS * 2) {
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
    // Check for duplicates first
    if (this.isDuplicate(msg)) {
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
    // Only monitor local and faction chat
    if (msg.channel !== "local" && msg.channel !== "faction") {
      return;
    }

    // Skip messages from AI bots (prevent self-talk loops)
    const bots = AiChatService.getBots();
    if (bots?.some(b => b.username === msg.sender)) {
      this.logFn("ai_chat_debug", `Ignoring message from AI bot: ${msg.sender}`);
      return;
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
      if (receivingBot !== mentionedBotName) {
        // This bot received the message but wasn't the one mentioned - skip silently
        this.logFn("ai_chat_debug", `Received by ${receivingBot} but mentions ${mentionedBotName} - skipping`);
        return;
      }
      
      // The receiving bot IS the mentioned bot - proceed with mention response
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
    const responder = this.selectResponder(msg, "");
    if (!responder) {
      this.logFn("ai_chat", "No available bot to respond");
      return;
    }

    this.logFn("ai_chat", `Selected responder: ${responder.username}`);
    await this.handleResponse(responder, msg, settings, msg.sender, true);
  }

  /**
   * Handle response logic (lock, limits, send).
   */
  private async handleResponse(
    responder: Bot,
    msg: ChatMessage,
    settings: ReturnType<typeof getAiChatSettings>,
    humanSender: string,
    isHumanSender: boolean
  ): Promise<void> {
    // Check conversation limits (cooldown, consecutive responses)
    const participants = [humanSender, responder.username];
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

    // Try to acquire lock
    if (!this.tryAcquireLock(responder.username, humanSender, channelId, settings.lockDurationSec)) {
      this.logFn("ai_chat", `Failed to acquire lock`);
      return;
    }

    // Generate and send response
    await this.sendResponse(responder, msg, settings, humanSender);
    
    // Record this response for conversation tracking
    this.recordResponse(msg.channel, participants, isHumanSender);
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
    humanSender: string
  ): Promise<void> {
    const mem = loadMemory();
    mem.responseCount++;

    // Load bot-specific personality
    const personality = getBotPersonality(bot.username);
    const hasCustomPersonality = personality !== DEFAULT_PERSONALITY;
    this.logFn("ai_chat_debug", `Using ${hasCustomPersonality ? "custom" : "default"} personality for ${bot.username}`);

    const systemPrompt = `${personality}

Current context:
- Your name in the game is: ${bot.username}
- You are currently in system: ${bot.system || "unknown"}
- Chat channel: ${msg.channel}

Response rules:
- Keep responses short (1-3 sentences max)
- Be natural and conversational
- Don't spam or be repetitive
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

      const chatResp = await bot.exec("chat", {
        channel: msg.channel,
        content: cleanResponse,
      });

      if (!chatResp.error) {
        this.logFn("ai_chat", `→ ${bot.username} responded: ${cleanResponse}`);

        // Log outgoing message
        this.logChat({
          timestamp: new Date().toISOString(),
          direction: "OUT",
          channel: msg.channel,
          sender: bot.username,
          content: cleanResponse,
        });

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
      } else {
        this.logFn("error", `Chat send failed: ${chatResp.error.message}`);
      }
    } catch (llmErr) {
      this.logFn("error", `LLM error: ${llmErr instanceof Error ? llmErr.message : String(llmErr)}`);
    }
  }

  // Static reference to bots array from botmanager
  private static getBots: () => Bot[] = () => [];
  
  static setGetBotsFn(fn: () => Bot[]): void {
    AiChatService.getBots = fn;
  }
}
