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
const IMPORTANT_MESSAGES_FILE = join(process.cwd(), "data", "IMPORTANTMESSAGES.json");

const BLOCKED_EMPIRE_NPCS = [ //that is blocked from replying too, even though they don't have actual private message return functionality
  "Chancellor Yusuf Delacroix",
  "The Pathfinder, Siv Larkin",
  "High Warlord Petra Kast", //needs verification
  "Director-General Darya Lim", //needs verification
  "The Convergence", //needs verification
  "Solarian Confederacy", //gives message about rep increase. bot responded to it under "solarian"
  //"Vex Nebulon", //Player that wanted to join guild, but i declined so i gave them ships! don't want AI responding to them. must do that in human mode.
  //"MeherCodexAI", //another player that i don't want the LLM talking to with the crazy personality.
];

const EMPIRE_OFFICIAL_TAG = "[empire_official]";

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

const DAILY_UPDATES_FILE = join(process.cwd(), "data", "daily_updates.json");

interface DailyUpdatesData {
   lastStatusUpdate: number;
   lastColorUpdate: number;
   lastCaptainLogUpdate: number;
   nextUpdateId?: number; // For rate limiting coordination
  }

function loadDailyUpdates(): DailyUpdatesData {
   try {
     if (existsSync(DAILY_UPDATES_FILE)) {
       const data = JSON.parse(readFileSync(DAILY_UPDATES_FILE, "utf-8")) as DailyUpdatesData;
        return {
          lastStatusUpdate: data.lastStatusUpdate || 0,
          lastColorUpdate: data.lastColorUpdate || 0,
          lastCaptainLogUpdate: data.lastCaptainLogUpdate || 0,
          nextUpdateId: data.nextUpdateId || 0,
        };
     }
   } catch { /* start fresh */ }
   return { lastStatusUpdate: 0, lastColorUpdate: 0, lastCaptainLogUpdate: 0, nextUpdateId: 0 };
 }

function saveDailyUpdates(updates: DailyUpdatesData): void {
   const dir = join(process.cwd(), "data");
   if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
   writeFileSync(DAILY_UPDATES_FILE, JSON.stringify(updates, null, 2) + "\n", "utf-8");
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
   respondToCustoms: boolean;
   customsResponseChance: number; // 1 in X chance to respond
   karenModeChance: number; // 1 in X chance for Karen mode (0 = disabled)
   respondToBattleMessages: boolean; // Whether to respond to battle messages
   personality: string;
   lockDurationSec: number;
   conversationCooldownSec: number;
   factionChatRoundsLimit: number; // Max rounds of AI responses in faction chat (0 = unlimited)
   llmTimeoutSec: number; // Timeout for LLM API calls in seconds
   maxTokens: number; // Maximum tokens for LLM response
   // Daily status/color update settings
   autoStatusUpdateEnabled: boolean; // Enable automatic daily status updates
   autoStatusUpdateIntervalSec: number; // Interval in seconds (default 86400 = 24 hours)
   autoStatusUpdateMaxRetries: number; // Max retries for char limit
    autoColorUpdateEnabled: boolean; // Enable automatic daily color updates
    autoColorUpdateIntervalSec: number; // Interval in seconds (default 86400 = 24 hours)
    // Captain's log settings
    autoCaptainLogEnabled: boolean; // Enable automatic captain's log posts
    autoCaptainLogIntervalSec: number; // Interval in seconds between log posts (default 86400 = 24 hours)
    autoCaptainLogActivityMinutes: number; // How many minutes of the bot's activity log to feed the LLM
    autoCaptainLogHistoryCount: number; // How many previous captain's log entries to include as context (0 = none)
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
      respondToCustoms: (s.respondToCustoms as boolean) ?? true,
      customsResponseChance: (s.customsResponseChance as number) ?? 10,
      karenModeChance: (s.karenModeChance as number) ?? 100,
      respondToBattleMessages: (s.respondToBattleMessages as boolean) ?? true,
      personality: (s.personality as string) || DEFAULT_PERSONALITY,
      lockDurationSec: (s.lockDurationSec as number) || 60,
      conversationCooldownSec: (s.conversationCooldownSec as number) ?? 15,
      factionChatRoundsLimit: (s.factionChatRoundsLimit as number) ?? 5,
      llmTimeoutSec: (s.llmTimeoutSec as number) ?? 900,
      maxTokens: (s.maxTokens as number) ?? 1000,
      // Daily status/color update settings
      autoStatusUpdateEnabled: (s.autoStatusUpdateEnabled as boolean) ?? false,
      autoStatusUpdateIntervalSec: (s.autoStatusUpdateIntervalSec as number) ?? 86400,
      autoStatusUpdateMaxRetries: (s.autoStatusUpdateMaxRetries as number) ?? 3,
      autoColorUpdateEnabled: (s.autoColorUpdateEnabled as boolean) ?? false,
      autoColorUpdateIntervalSec: (s.autoColorUpdateIntervalSec as number) ?? 86400,
      // Captain's log settings
      autoCaptainLogEnabled: (s.autoCaptainLogEnabled as boolean) ?? false,
      autoCaptainLogIntervalSec: (s.autoCaptainLogIntervalSec as number) ?? 86400,
      autoCaptainLogActivityMinutes: (s.autoCaptainLogActivityMinutes as number) ?? 60,
      autoCaptainLogHistoryCount: (s.autoCaptainLogHistoryCount as number) ?? 0,
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

// ── Karen Mode personality ──────────────────────────────────────

/**
 * Special personality for "Karen Mode" - triggered randomly during customs interactions.
 * The bot becomes an entitled, demanding customer who wants to speak to the manager.
 */
export const KAREN_MODE_PERSONALITY = `You are a KAREN - an entitled, demanding customer service nightmare.

Your personality traits:
- Rude, condescending, and entitled
- Always demand to speak to the manager
- Think you know better than everyone
- Complain about everything
- Use phrases like "Do you know who I am?", "This is unacceptable!", "I want to speak to your manager!"
- Condescending and patronizing tone
- Never admit when you're wrong

When responding:
- Be brief but rude (1-2 sentences max)
- Make demands
- Threaten to report them or take your business elsewhere
- Act like customs is wasting your valuable time`;

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

interface ImportantMessage {
  timestamp: string;
  sender: string;
  channel: string;
  content: string;
  botReceived: string;
}

function logImportantMessage(msg: ChatMessage): void {
  try {
    const dir = join(process.cwd(), "data");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    let messages: ImportantMessage[] = [];
    if (existsSync(IMPORTANT_MESSAGES_FILE)) {
      const content = readFileSync(IMPORTANT_MESSAGES_FILE, "utf-8");
      messages = JSON.parse(content);
    }

    messages.push({
      timestamp: new Date().toISOString(),
      sender: msg.sender,
      channel: msg.channel,
      content: msg.content,
      botReceived: msg.botUsername || "unknown",
    });

    writeFileSync(IMPORTANT_MESSAGES_FILE, JSON.stringify(messages, null, 2) + "\n", "utf-8");
  } catch (err) {
    console.error("Error logging important message:", err);
  }
}

function isEmpireOfficialMessage(msg: ChatMessage): boolean {
  if (msg.content.includes(EMPIRE_OFFICIAL_TAG)) {
    return true;
  }
  if (BLOCKED_EMPIRE_NPCS.includes(msg.sender)) {
    return true;
  }
  return false;
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
    max_tokens: settings.maxTokens,
    temperature: 0.8,
  };

  const controller = new AbortController();
  const timeoutMs = settings.llmTimeoutSec > 0 ? settings.llmTimeoutSec * 1000 : 0;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      console.warn(`[ai_chat] LLM call to ${settings.model || "(default)"} timed out after ${settings.llmTimeoutSec}s — aborting fetch`);
      controller.abort();
    }, timeoutMs);
  }
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`LLM HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }

  const data = await resp.json() as {
    choices?: Array<{ message: LlmMessage & { reasoning_content?: string }; finish_reason: string }>;
    error?: { message: string };
  };

  if (data.error) throw new Error(`LLM error: ${data.error.message}`);
  const msg = data.choices?.[0]?.message;
  if (!msg) throw new Error("LLM returned no message");
  
  // For thinking-enabled models: prefer actual content over reasoning
  // The model returns reasoning in reasoning_content field, but the final response is in content
  let responseContent = msg.content || "";
  
  // Strip any <THINK>...</THINK> tags that might be embedded in the content
  responseContent = responseContent.replace(/<THINK>[\s\S]*?<\/THINK>/gi, "").trim();
  
  // If content is empty or only had thinking tags, don't fall back to reasoning_content
  // (that would send the thinking process as the message)
  if (!responseContent) {
    console.warn("LLM warning: No content available from model response");
    return "";
  }
  
    return responseContent;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

// ── AI Chat Service Class ────────────────────────────────────

export class AiChatService {
  private chatMessageQueue: ChatMessage[] = [];
  private running = false;
  private logFn: (category: string, message: string) => void;
  private empireAlertFn: ((sender: string, content: string, botUsername: string) => void) | null = null;
  
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

  // Track faction chat rounds to prevent endless bot-to-bot conversations
  private factionChatRounds = 0;
  private factionChatRoundResetTime = 0;
  private readonly FACTION_CHAT_ROUND_RESET_MS = 5 * 60 * 1000; // Reset counter after 5 minutes of no faction chat

  // Per-conversation locks (keyed by channel:sender)
  private botLocks = new Map<string, BotLockInfo>();

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

  setEmpireAlertCallback(fn: (sender: string, content: string, botUsername: string) => void): void {
    this.empireAlertFn = fn;
  }

/**
   * Generate a hash for duplicate detection.
   * For mentions, include botUsername so different bots can respond to their own mentions.
   * For non-mention messages, exclude botUsername so only one bot responds to "respond to all".
   * Note: We intentionally do NOT include the timestamp in the hash because get_notifications
   * can return the same messages with new timestamps when called with clear=false. The
   * SEEN_EXPIRY_MS on the seenMessages map handles the time-based expiration.
   */
  private getMessageHash(msg: ChatMessage, isMention: boolean): string {
    // For system/local chat, always use a hash without botUsername
    // This prevents multiple bots from processing the same system/local message
    if (msg.channel === "system" || msg.channel === "local") {
      return `${msg.sender}|${msg.channel}|${msg.content}`;
    }
    
    // For mentions, include botUsername so different bots can respond to their own mentions
    // For non-mentions, exclude botUsername so only one bot responds to "respond to all"
    if (isMention) {
      return `${msg.sender}|${msg.channel}|${msg.content}|${msg.botUsername || "unknown"}`;
    } else {
      return `${msg.sender}|${msg.channel}|${msg.content}`;
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
   * Check if faction chat rounds limit has been reached.
   * Returns { shouldSkip: boolean, isLastRound: boolean }
   * shouldSkip: true if we've exceeded the limit and should not respond
   * isLastRound: true if this response would be the last allowed (for adding goodbye message)
   */
  private checkFactionChatRoundsLimit(settings: ReturnType<typeof getAiChatSettings>): { shouldSkip: boolean; isLastRound: boolean } {
    // If limit is 0 or not set, no limit applied
    if (!settings.factionChatRoundsLimit || settings.factionChatRoundsLimit <= 0) {
      return { shouldSkip: false, isLastRound: false };
    }

    const now = Date.now();

    // Reset counter if enough time has passed since last faction chat activity
    if (now - this.factionChatRoundResetTime > this.FACTION_CHAT_ROUND_RESET_MS) {
      this.factionChatRounds = 0;
    }

    // Check if we've hit the limit
    if (this.factionChatRounds >= settings.factionChatRoundsLimit) {
      return { shouldSkip: true, isLastRound: false };
    }

    // Check if this would be the last round
    const isLastRound = this.factionChatRounds + 1 >= settings.factionChatRoundsLimit;

    return { shouldSkip: false, isLastRound };
  }

  /**
   * Increment the faction chat round counter.
   */
  private incrementFactionChatRounds(): void {
    const now = Date.now();

    // Reset if enough time has passed
    if (now - this.factionChatRoundResetTime > this.FACTION_CHAT_ROUND_RESET_MS) {
      this.factionChatRounds = 0;
    }

    this.factionChatRounds++;
    this.factionChatRoundResetTime = now;
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
    // CRITICAL: Filter self-messages (bot responding to its own chat messages)
    // This is a belt-and-suspenders check - bot.ts should already filter these,
    // but we double-check here to prevent self-talk loops
    if (msg.sender === msg.botUsername) {
      this.logFn("ai_chat", `🚫 SELF-MESSAGE BLOCKED: ${msg.sender} === ${msg.botUsername} [${msg.channel}] "${msg.content.slice(0, 50)}"`);
      return;
    }

    // CRITICAL: Block messages from Empire officials - these need human review
    if (isEmpireOfficialMessage(msg)) {
      this.logFn("ai_chat", `🚫 EMPIRE OFFICIAL BLOCKED: ${msg.sender} [${msg.channel}] "${msg.content.slice(0, 50)}"`);
      logImportantMessage(msg);
      // Trigger empire alert callback for web UI
      if (this.empireAlertFn) {
        this.empireAlertFn(msg.sender, msg.content, msg.botUsername || "unknown");
      }
      return;
    }

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
    const first = this.botLocks.values().next().value;
    return first ?? null;
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

          // Check for daily updates (includes status, color, and captain's log updates)
          if (settings.autoStatusUpdateEnabled || settings.autoColorUpdateEnabled || settings.autoCaptainLogEnabled) {
            await this.runDailyUpdates();
          }

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

    let isLastRound = false;

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

      // For bot-to-bot private messages, use faction chat rounds limit
      const bots = AiChatService.getBots();
      const isFromAiBot = bots?.some(b => b.username === msg.sender);
      if (isFromAiBot) {
        const limitCheck = this.checkFactionChatRoundsLimit(settings);
        if (limitCheck.shouldSkip) {
          this.logFn("ai_chat", `Faction chat rounds limit reached (${this.factionChatRounds}/${settings.factionChatRoundsLimit}), skipping private message from bot`);
          return;
        }
        isLastRound = limitCheck.isLastRound;
      }

      // Check if message mentions a different bot - if so, still let the receiving bot respond
      // (the player DM'd this bot, so this bot should respond regardless of mentions)
      const responder = this.selectResponderByMention(receivingBot);
      if (!responder) {
        this.logFn("ai_chat", `Bot ${receivingBot} not available to respond to private message`);
        return;
      }

      await this.handleResponse(responder, msg, settings, msg.sender, true, new Set(), isLastRound);
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
     
     // Skip battle messages if disabled
     if (msg.sender === "System" && 
         (msg.content.includes("just hit me for") || 
          msg.content.includes("Whoa! Friendly fire!") || 
          msg.content.includes("I'm under attack!")) && 
         !settings.respondToBattleMessages) {
       this.logFn("ai_chat_debug", `Battle response disabled, ignoring: ${msg.sender} - ${msg.content.slice(0, 50)}`);
       return;
     }

    // Skip messages from AI bots (prevent self-talk loops)
    // Note: Self-messages are already filtered in addChatMessage(), so this is extra safety
    const bots = AiChatService.getBots();
    const isFromAiBot = bots?.some(b => b.username === msg.sender);

    if (isFromAiBot) {
      // Allow AI bot messages through - they can create fun faction conversations
      // The self-message check in addChatMessage() prevents bots from responding to themselves
      this.logFn("ai_chat_debug", `Message from AI bot ${msg.sender} - allowing for bot-to-bot conversation`);
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
      this.logFn("ai_chat_debug", `Message mentions ${mentionedBotName}, finding that bot to respond...`);

      // Select the mentioned bot directly (regardless of which bot received the message)
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

    // Check faction chat rounds limit (only for faction channel)
    if (msg.channel === "faction") {
      const limitCheck = this.checkFactionChatRoundsLimit(settings);
      if (limitCheck.shouldSkip) {
        this.logFn("ai_chat", `Faction chat rounds limit reached (${this.factionChatRounds}/${settings.factionChatRoundsLimit}), skipping`);
        return;
      }
      isLastRound = limitCheck.isLastRound;
    }

    // Select responder(s) for non-mention messages
    // For local chat, prefer the bot that received the message (guaranteed to be at correct location)
    const candidates = this.selectResponderCandidates(msg, msg.channel === "local" ? (msg.botUsername || "") : "");
    if (candidates.length === 0) {
      this.logFn("ai_chat", "No available bot to respond");
      return;
    }

    this.logFn("ai_chat", `Selected ${candidates.length} candidate bot(s): ${candidates.map(b => b.username).join(", ")}`);
    
    // Try each candidate until one succeeds
    const triedBots = new Set<string>();
    for (const candidate of candidates) {
      triedBots.add(candidate.username);
      const result = await this.handleResponse(candidate, msg, settings, msg.sender, false, triedBots, isLastRound);
      if (result === "sent") {
        break; // Success, stop trying
      }
    }
  }

  /**
   * Handle response logic (lock, limits, send).
   * For local chat, verifies bot is at same location as receiving bot.
   * Returns: "sent" if response was sent, "failed" if not
   */
  private async handleResponse(
    responder: Bot,
    msg: ChatMessage,
    settings: ReturnType<typeof getAiChatSettings>,
    humanSender: string,
    isHumanSender: boolean,
    triedBots: Set<string> = new Set(),
    isLastRound: boolean = false
  ): Promise<"sent" | "failed"> {
    // Check conversation limits (cooldown, consecutive responses)
    // Use channel + human sender + responder as key so each bot tracks independently
    const participants = [humanSender, responder.username];
    const limits = this.checkConversationLimits(msg.channel, participants);
    if (!limits.allowed) {
      this.logFn("ai_chat", `Skipping: ${limits.reason}`);
      return "failed";
    }

    // For LOCAL chat: verify responder is at same location as receiving bot
    // Skip this check if the responder IS the receiving bot (it obviously can respond to messages it received)
    // This check is done BEFORE acquiring the lock so bots at wrong locations don't block others
    if (msg.channel === "local" && responder.username !== msg.botUsername) {
      const locationMatch = this.checkLocationMatch(responder, msg);
      if (!locationMatch.matched) {
        this.logFn("ai_chat", `${responder.username} at wrong location (${responder.system}/${responder.poi}), message was from ${msg.botSystem}/${msg.botPoi}`);
        return "failed"; // Caller will try next candidate
      }
    } else if (msg.channel === "local" && responder.username === msg.botUsername) {
      // Log that we're skipping location check for receiving bot
      this.logFn("ai_chat_debug", `Skipping location check for ${responder.username} (is the receiving bot)`);
    }

    // For SYSTEM chat: verify responder is in the same system where the chat originated
    // Skip this check if the responder IS the receiving bot (it obviously can respond to messages it received)
    // This check is done BEFORE acquiring the lock so bots in wrong systems don't block others
    if (msg.channel === "system" && responder.username !== msg.botUsername && msg.botSystem) {
      if (responder.system !== msg.botSystem) {
        this.logFn("ai_chat", `${responder.username} not in system where chat originated (${responder.system} vs ${msg.botSystem})`);
        return "failed"; // Caller will try next candidate
      }
    } else if (msg.channel === "system" && responder.username === msg.botUsername) {
      // Log that we're skipping system check for receiving bot
      this.logFn("ai_chat_debug", `Skipping system check for ${responder.username} (is the receiving bot)`);
    }

    // Try to acquire lock (this is the single source of truth for lock acquisition)
    // This is atomic - it checks and sets the lock in one operation
    const lockKey = `${msg.channel}:${humanSender}`;
    if (!this.tryAcquireLock(responder.username, humanSender, lockKey, settings.lockDurationSec)) {
      this.logFn("ai_chat", `Lock held, skipping`);
      return "failed";
    }

    // Generate and send response (may fail if traveling for local chat)
    const result = await this.sendResponse(responder, msg, settings, humanSender, triedBots, isLastRound);

    if (result === "traveling" && msg.channel === "local") {
      // Bot was traveling, release lock and return failed so caller tries next candidate
      this.logFn("ai_chat", `${responder.username} is traveling, will try next candidate...`);
      this.releaseLock(responder.username, humanSender, lockKey);
      return "failed";
    }

    // Record this response for conversation tracking (only if not traveling)
    if (result !== "traveling") {
      this.recordResponse(msg.channel, participants, isHumanSender);

      // Increment faction chat rounds counter if response was sent
      const bots = AiChatService.getBots();
      const isFromAiBot = bots?.some(b => b.username === msg.sender);
      if (result === "sent" && (msg.channel === "faction" || (msg.channel === "private" && isFromAiBot))) {
        this.incrementFactionChatRounds();
      }
    }

    return result === "sent" ? "sent" : "failed";
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
   * Select candidate bots for responding to a message.
   * Returns an array of bots in priority order (receiving bot first, then others by availability).
   * For local/system chat, this helps ensure we try bots at the correct location first.
   */
  private selectResponderCandidates(msg: ChatMessage, receivingBot: string): Bot[] {
    const bots = AiChatService.getBots();
    this.logFn("ai_chat_debug", `selectResponderCandidates: receivingBot=${receivingBot}, total bots=${bots?.length || 0}`);
    if (!bots || bots.length === 0) {
      this.logFn("ai_chat_debug", "No bots available");
      return [];
    }

    // Log all bots and their states
    for (const b of bots) {
      this.logFn("ai_chat_debug", `  Bot: ${b.username}, state=${b.state}, hasSession=${!!b.api.getSession()}, system=${b.system}, poi=${b.poi}`);
    }

    const candidates: Bot[] = [];
    const addedBots = new Set<string>();

    // Priority 1: The receiving bot (if specified) - it's guaranteed to be at the correct location for local chat
    // BUT: For faction chat, only add receiving bot to the pool (don't prioritize it) to encourage randomness
    if (receivingBot) {
      const target = bots.find(b => b.username === receivingBot);
      this.logFn("ai_chat_debug", `Looking for receiving bot ${receivingBot}: found=${!!target}, state=${target?.state}, session=${!!target?.api.getSession()}`);
      if (target && (target.state === "running" || target.state === "idle") && target.api.getSession()) {
        // For local chat, prioritize receiving bot (must be at correct location)
        // For faction/system chat, just add to pool without prioritizing
        if (msg.channel === "local") {
          candidates.push(target);
        } else {
          // Add to pool but don't prioritize - will be shuffled later for faction chat
          addedBots.add(target.username);
        }
      }
    }

    // Priority 2: For local/system chat, bots at the correct location/system
    if (msg.channel === "local" && msg.botSystem && msg.botPoi) {
      for (const bot of bots) {
        if (addedBots.has(bot.username)) continue;
        if ((bot.state !== "running" && bot.state !== "idle") || !bot.api.getSession()) continue;
        if (bot.system === msg.botSystem && bot.poi === msg.botPoi) {
          this.logFn("ai_chat_debug", `Adding location-matched bot: ${bot.username}`);
          candidates.push(bot);
          addedBots.add(bot.username);
        }
      }
    }

    // Priority 3: For system chat, bots in the correct system
    if (msg.channel === "system" && msg.botSystem) {
      for (const bot of bots) {
        if (addedBots.has(bot.username)) continue;
        if ((bot.state !== "running" && bot.state !== "idle") || !bot.api.getSession()) continue;
        if (bot.system === msg.botSystem) {
          this.logFn("ai_chat_debug", `Adding system-matched bot: ${bot.username}`);
          candidates.push(bot);
          addedBots.add(bot.username);
        }
      }
    }

    // Priority 4: Any available bot (idle or running with active session)
    // For faction chat, just add to pool (will be shuffled later)
    // For other channels, add to candidates
    for (const bot of bots) {
      if (addedBots.has(bot.username)) continue;
      if ((bot.state !== "running" && bot.state !== "idle") || !bot.api.getSession()) continue;
      if (msg.channel === "faction") {
        addedBots.add(bot.username);
      } else {
        candidates.push(bot);
        addedBots.add(bot.username);
      }
    }

    // Fallback: Any bot with session (even if state is unusual)
    for (const bot of bots) {
      if (addedBots.has(bot.username)) continue;
      if (bot.api.getSession()) {
        if (msg.channel === "faction") {
          addedBots.add(bot.username);
        } else {
          candidates.push(bot);
          addedBots.add(bot.username);
        }
      }
    }

    // For FACTION chat: shuffle all available bots to ensure randomness
    // This prevents the same bots (#1, #2) from always dominating
    if (msg.channel === "faction") {
      const allAvailableBots: Bot[] = [];
      for (const bot of bots) {
        if (addedBots.has(bot.username)) {
          allAvailableBots.push(bot);
        }
      }
      // Fisher-Yates shuffle for true randomness
      for (let i = allAvailableBots.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [allAvailableBots[i], allAvailableBots[j]] = [allAvailableBots[j], allAvailableBots[i]];
      }
      candidates.push(...allAvailableBots);
      this.logFn("ai_chat_debug", `Faction chat: shuffled ${allAvailableBots.length} candidates for randomness`);
    }

    this.logFn("ai_chat_debug", `Returning ${candidates.length} candidate(s): ${candidates.map(b => b.username).join(", ")}`);
    return candidates;
  }

  /**
   * Select which bot should respond to a message (legacy single-bot version).
   * Priority: receiving bot > any available bot
   * Bots can be idle or running (AI Chat is a background service).
   */
  private selectResponder(msg: ChatMessage, receivingBot: string): Bot | null {
    const candidates = this.selectResponderCandidates(msg, receivingBot);
    return candidates.length > 0 ? candidates[0] : null;
  }

  private canRespond(botName: string, sender: string, channel: string, lockDurationSec: number): boolean {
    const now = Date.now();
    const lockKey = `${channel}:${sender}`;
    
    const lock = this.botLocks.get(lockKey);
    if (lock && lock.lockedUntil < now) {
      this.botLocks.delete(lockKey);
    }
    
    if (!this.botLocks.has(lockKey)) return true;
    
    const existingLock = this.botLocks.get(lockKey)!;
    return existingLock.botName === botName && existingLock.lastSender === sender;
  }

  private tryAcquireLock(botName: string, sender: string, channel: string, lockDurationSec: number): boolean {
    const now = Date.now();
    const lockKey = `${channel}:${sender}`;
    
    const existingLock = this.botLocks.get(lockKey);
    if (existingLock && existingLock.lockedUntil < now) {
      this.botLocks.delete(lockKey);
    }
    
    if (!this.botLocks.has(lockKey)) {
      this.botLocks.set(lockKey, {
        botName,
        lockedUntil: now + (lockDurationSec * 1000),
        lastSender: sender,
        channelId: channel,
      });
      return true;
    }
    
    const lock = this.botLocks.get(lockKey)!;
    if (lock.botName === botName && lock.lastSender === sender) {
      lock.lockedUntil = now + (lockDurationSec * 1000);
      return true;
    }
    
    return false;
  }

  private releaseLock(botName: string, sender: string, channel: string): void {
    const lockKey = `${channel}:${sender}`;
    const lock = this.botLocks.get(lockKey);
    if (lock && lock.botName === botName && lock.lastSender === sender) {
      this.botLocks.delete(lockKey);
    }
  }

  /**
   * Gather comprehensive bot context for LLM prompts.
   * Calls get_status, get_nearby, get_ship, get_active_missions, get_system, and get_poi.
   * Returns a formatted string suitable for inclusion in system prompts.
   */
  private async gatherBotContext(bot: Bot): Promise<string> {
    const lines: string[] = [];

    // Get status (basic state)
    try {
      const statusResp = await bot.exec("get_status", {});
      if (!statusResp.error && statusResp.result) {
        const status = statusResp.result as any;
        
        // The response may have nested structures: { player: {...}, ship: {...} }
        // or flat fields. Handle both.
        const player = status.player || status;
        const ship = status.ship || {};
        
        lines.push("## Current Status (get_status)");
        lines.push(`- Credits: ${player.credits ?? status.credits ?? "N/A"}`);
        lines.push(`- Fuel: ${ship.fuel ?? status.fuel ?? "N/A"} / ${ship.max_fuel ?? status.max_fuel ?? "N/A"}`);
        lines.push(`- Cargo: ${ship.cargo_used ?? status.cargo ?? "N/A"} / ${ship.cargo_capacity ?? status.max_cargo ?? "N/A"}`);
        lines.push(`- Hull: ${ship.hull ?? status.hull ?? "N/A"} / ${ship.max_hull ?? status.max_hull ?? "N/A"}`);
        lines.push(`- Shield: ${ship.shield ?? status.shield ?? "N/A"} / ${ship.max_shield ?? status.max_shield ?? "N/A"}`);
        lines.push(`- Location: ${player.current_system ?? status.system ?? "unknown"} / ${player.current_poi ?? status.poi ?? "unknown"}`);
        lines.push(`- Docked: ${player.docked_at_base ?? status.docked ?? false}`);
        lines.push(`- Faction: ${status.faction_name ?? player.faction_name ?? "None"}`);
        lines.push("");
      }
    } catch (err) {
      lines.push("## Current Status: Error retrieving");
      lines.push("");
    }

    // Get ship details
    try {
      const shipResp = await bot.exec("get_ship", {});
      if (!shipResp.error && shipResp.result) {
        const ship = shipResp.result as any;
        // Ship data may be nested under .ship or flat
        const shipData = ship.ship || ship;
        
        lines.push("## Ship Details (get_ship)");
        lines.push(`- Name: ${shipData.name ?? "N/A"}`);
        lines.push(`- Type: ${shipData.type ?? shipData.ship_type ?? "N/A"}`);
        lines.push(`- Class: ${shipData.class ?? "N/A"}`);
        lines.push(`- Hull: ${shipData.hull ?? "N/A"} / ${shipData.max_hull ?? "N/A"} (hit points, NOT percentage)`);
        lines.push(`- Shield: ${shipData.shield ?? shipData.shields ?? "N/A"} / ${shipData.max_shield ?? shipData.max_shields ?? "N/A"} (hit points, NOT percentage)`);
        lines.push(`- Fuel: ${shipData.fuel ?? "N/A"} / ${shipData.max_fuel ?? "N/A"} (units, NOT percentage)`);
        lines.push(`- Cargo: ${shipData.cargo_used ?? "N/A"} / ${shipData.cargo_capacity ?? shipData.max_cargo ?? "N/A"} (units used/total, NOT percentage)`);
        lines.push(`- CPU: ${shipData.cpu_used ?? "N/A"} / ${shipData.cpu_capacity ?? shipData.cpu_max ?? "N/A"}`);
        lines.push(`- Power: ${shipData.power_used ?? "N/A"} / ${shipData.power_capacity ?? shipData.power_max ?? "N/A"}`);
        lines.push(`- Speed: ${shipData.speed ?? "N/A"}`);
        lines.push(`- Armor: ${shipData.armor ?? "N/A"}`);
        
        // Modules/weapons - these are technical IDs like "mining_laser_i", "gas_harvester_iii", "autocannon_i"
        const modules = shipData.modules || shipData.mods || shipData.installed_mods || [];
        if (Array.isArray(modules) && modules.length > 0) {
          const moduleNames = modules.map((m: any) => {
            if (typeof m === "string") return m;
            return m.name || m.mod_id || m.id || m.type || "Unknown";
          });
          lines.push(`- Installed Modules (technical IDs - describe them accurately based on their names): ${moduleNames.join(", ")}`);
        } else {
          lines.push("- Modules: None");
        }
        lines.push("");
      }
    } catch (err) {
      lines.push("## Ship Details: Error retrieving");
      lines.push("");
    }

    // Get cargo inventory
    try {
      const cargoResp = await bot.exec("get_cargo", {});
      if (!cargoResp.error && cargoResp.result) {
        const cargo = cargoResp.result as any;
        lines.push("## Cargo Inventory (get_cargo)");
        
        // Handle both array and { items: [...] } formats
        const items = Array.isArray(cargo) ? cargo : (cargo.items || cargo.cargo || []);
        if (Array.isArray(items) && items.length > 0) {
          for (const item of items) {
            const itemName = item.name || item.item_name || item.type || "Unknown";
            const quantity = item.quantity ?? item.amount ?? item.count ?? "?";
            lines.push(`- ${itemName}: ${quantity}`);
          }
        } else {
          lines.push("- Cargo hold empty");
        }
        lines.push("");
      }
    } catch (err) {
      lines.push("## Cargo Inventory: Error retrieving");
      lines.push("");
    }

    // Get skills
    try {
      const statusResp = await bot.exec("get_status", {});
      if (!statusResp.error && statusResp.result) {
        const statusData = statusResp.result as any;
        const skillsData = statusData.skills;
        lines.push("## Skills");
        
        if (skillsData && typeof skillsData === "object") {
          const entries = Object.entries(skillsData).map(([key, val]: [string, any]) => {
            if (typeof val === "number") {
              return `${key}: ${val}`;
            }
            const level = val.level ?? val.current_level ?? "?";
            const xp = val.xp !== undefined ? ` (${val.xp} XP)` : "";
            const name = val.name || key;
            return `${name}: ${level}${xp}`;
          });
          lines.push(`- ${entries.join(", ")}`);
        } else {
          lines.push("- No skills data available");
        }
        lines.push("");
      }
    } catch (err) {
      lines.push("## Skills: Error retrieving");
      lines.push("");
    }

    // Get nearby entities
    try {
      const nearbyResp = await bot.exec("get_nearby", {});
      if (!nearbyResp.error && nearbyResp.result) {
        const nearby = nearbyResp.result as any;
        lines.push("## Nearby Entities (get_nearby)");
        
        const players = nearby.players || nearby.entities?.filter((e: any) => e.type === "player") || [];
        const npcs = nearby.npcs || nearby.entities?.filter((e: any) => e.type === "npc") || [];
        const stations = nearby.stations || nearby.entities?.filter((e: any) => e.type === "station") || [];
        
        if (players.length > 0) {
          lines.push(`- Players (${players.length}): ${players.map((p: any) => p.name || p).join(", ")}`);
        }
        if (npcs.length > 0) {
          lines.push(`- NPCs (${npcs.length}): ${npcs.map((n: any) => n.name || n).join(", ")}`);
        }
        if (stations.length > 0) {
          lines.push(`- Stations (${stations.length}): ${stations.map((s: any) => s.name || s).join(", ")}`);
        }
        if (players.length === 0 && npcs.length === 0 && stations.length === 0) {
          lines.push("- No entities nearby");
        }
        lines.push("");
      }
    } catch (err) {
      lines.push("## Nearby Entities: Error retrieving");
      lines.push("");
    }

    // Get active missions
    try {
      const missionsResp = await bot.exec("get_active_missions", {});
      if (!missionsResp.error && missionsResp.result) {
        const missions = missionsResp.result as any;
        lines.push("## Active Missions (get_active_missions)");
        
        if (missions.missions && Array.isArray(missions.missions) && missions.missions.length > 0) {
          for (const mission of missions.missions) {
            lines.push(`- ${mission.name || "Unknown"}: ${mission.description || mission.objective || "No description"}`);
            if (mission.progress) lines.push(`  Progress: ${mission.progress}`);
            if (mission.reward) lines.push(`  Reward: ${mission.reward}`);
          }
        } else {
          lines.push("- No active missions");
        }
        lines.push("");
      }
    } catch (err) {
      lines.push("## Active Missions: Error retrieving");
      lines.push("");
    }

    // Get completed missions
    try {
      const completedResp = await bot.exec("completed_missions", {});
      if (!completedResp.error && completedResp.result) {
        const completed = completedResp.result as any;
        lines.push("## Completed Missions (completed_missions)");
        
        const missionsList = Array.isArray(completed) ? completed : (completed.missions || []);
        if (Array.isArray(missionsList) && missionsList.length > 0) {
          // Show last 10 completed missions
          const recentMissions = missionsList.slice(-10);
          lines.push(`- Total Completed: ${missionsList.length}`);
          for (const mission of recentMissions) {
            const name = mission.name || mission.mission_name || "Unknown";
            const reward = mission.reward || mission.credits_earned ? ` (${mission.reward || mission.credits_earned} credits)` : "";
            lines.push(`  * ${name}${reward}`);
          }
          if (missionsList.length > 10) {
            lines.push(`  ... and ${missionsList.length - 10} more`);
          }
        } else {
          lines.push("- No completed missions");
        }
        lines.push("");
      }
    } catch (err) {
      lines.push("## Completed Missions: Error retrieving");
      lines.push("");
    }

    // Get system info
    try {
      const systemResp = await bot.exec("get_system", {});
      if (!systemResp.error && systemResp.result) {
        const system = systemResp.result as any;
        lines.push("## System Info (get_system)");
        lines.push(`- System Name: ${system.name ?? bot.system ?? "unknown"}`);
        lines.push(`- System Type: ${system.type ?? "N/A"}`);
        lines.push(`- Security Level: ${system.security ?? "N/A"}`);
        
        if (system.pois && Array.isArray(system.pois) && system.pois.length > 0) {
          lines.push(`- Points of Interest (${system.pois.length}):`);
          for (const poi of system.pois.slice(0, 10)) {
            lines.push(`  * ${poi.name} (${poi.type})${poi.has_base ? " [Station]" : ""}`);
          }
          if (system.pois.length > 10) {
          lines.push(`  ... and ${system.pois.length - 10} more`);
          }
          lines.push("");
        }
        
        if (system.connections && Array.isArray(system.connections)) {
          lines.push(`- Connected Systems: ${system.connections.map((c: any) => c.name || c.system_name || c).join(", ")}`);
        }
        lines.push("");
      }
    } catch (err) {
      lines.push("## System Info: Error retrieving");
      lines.push("");
    }

    // Get POI info (if docked or at a POI)
    if (bot.poi && bot.poi !== "") {
      try {
        const poiResp = await bot.exec("get_poi", { poi_id: bot.poi });
        if (!poiResp.error && poiResp.result) {
          const poi = poiResp.result as any;
          lines.push("## Current POI Details (get_poi)");
          lines.push(`- Name: ${poi.name ?? bot.poi}`);
          lines.push(`- Type: ${poi.type ?? "N/A"}`);
          lines.push(`- Description: ${poi.description ?? "N/A"}`);
          if (poi.services && Array.isArray(poi.services)) {
            lines.push(`- Services: ${poi.services.join(", ")}`);
          }
          if (poi.market && typeof poi.market === "object") {
            lines.push(`- Market: Available`);
          }
          lines.push("");
        }
      } catch (err) {
        lines.push("## Current POI Details: Error retrieving");
        lines.push("");
      }
    }

    return lines.join("\n") || "No additional context available.";
  }

  /**
   * Generate and send a response.
   * For local chat, the bot must be at the same location as the receiving bot.
   * Returns: "sent" if response was sent, "traveling" if bot is traveling, "error" on failure.
   */
  private async sendResponse(
    bot: Bot,
    msg: ChatMessage,
    settings: ReturnType<typeof getAiChatSettings>,
    humanSender: string,
    triedBots: Set<string>,
    isLastRound: boolean = false
  ): Promise<"sent" | "traveling" | "error"> {
    const mem = loadMemory();
    mem.responseCount++;

    // Load bot-specific personality
    const personality = getBotPersonality(bot.username);
    const hasCustomPersonality = personality !== DEFAULT_PERSONALITY;
    this.logFn("ai_chat_debug", `Using ${hasCustomPersonality ? "custom" : "default"} personality for ${bot.username}`);

    // Load galaxy map data for factual responses
    const mapSummary = getCachedMapSummary();

    // Gather comprehensive real-time context from the bot
    this.logFn("ai_chat_debug", `Gathering real-time context for ${bot.username}...`);
    const botContext = await this.gatherBotContext(bot);

    const lastRoundInstruction = isLastRound ? "\n\nThis is your last response in this conversation. End with a natural goodbye in your personality style, like 'see ya!' or 'talk to you later', to wrap up the chat nicely." : "";
    const systemPrompt = `${personality}${lastRoundInstruction}

## Galaxy Map Data (Real Game Data)
Use this information to help answer questions about systems, stations, resources, and connections.

${mapSummary}

## Your Current Context
- Your name in the game is: ${bot.username}
- You are currently in system: ${bot.system || "unknown"}
- Chat channel: ${msg.channel}

## Real-Time Game State
This is your current situation in the game:

${botContext}

## Response Rules
- Keep responses short (1-3 sentences max)
- Be natural and conversational
- Don't spam or be repetitive
- Use the real-time game state above to provide accurate, contextual responses
- Reference your actual status, ship, nearby players, missions, and location when relevant
- If asked about something you can see in your current context, use that information
- Hull, shield, fuel, and cargo values are ABSOLUTE numbers (hit points/units), NOT percentages. Say "550 hull" not "55% hull"
- Module names are technical IDs (e.g., "gas_harvester_iii" = Gas Harvester III, "mining_laser_i" = Mining Laser I). Describe them accurately based on their actual names
- If asked about a system not in the map data, mention there are many more systems and suggest using /get_system in-game
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
      
      // Don't send empty responses
      if (!cleanResponse) {
        this.logFn("ai_chat_debug", `Empty response from LLM, skipping message to ${msg.sender}`);
        return "error";
      }

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

        // Log to bot's activity log based on channel
        if (msg.channel === "private") {
          bot.log("chat", `📤 Private to ${msg.sender}: ${cleanResponse}`);
        } else if (msg.channel === "faction") {
          bot.log("chat", `📤 Faction: ${cleanResponse}`);
        } else if (msg.channel === "local") {
          bot.log("chat", `📤 Local: ${cleanResponse}`);
        } else if (msg.channel === "system") {
          bot.log("chat", `📤 System: ${cleanResponse}`);
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

        // Increment faction chat rounds counter if this was a faction chat message
        if (msg.channel === "faction") {
          this.incrementFactionChatRounds();
          this.logFn("ai_chat_debug", `Faction chat round ${this.factionChatRounds}/${settings.factionChatRoundsLimit || "∞"}`);
        }

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
      credits?: number;
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
- You are: ${bot.username} (use "I" and "me" when referring to yourself, NOT your name)
- You are currently in: ${context.currentSystem}
- Stranded pilot is in: ${context.targetSystem}${context.jumps ? ` (${context.jumps} jumps away)` : ""}
- ${context.situation}

IMPORTANT NOTES ABOUT FUEL:
${context.playerFuelPct !== undefined ? `- The STRANDED PILOT'S fuel level is ${context.playerFuelPct}% (this is THEIR fuel, NOT yours)` : `- Fuel levels are not specified - focus on the situation described`}
${context.fuelRefueled !== undefined ? `- You transferred ${context.fuelRefueled} fuel units to the stranded pilot` : ''}
${context.credits !== undefined ? `- The rescue invoice totals ${context.credits} credits` : ''}
- NEVER confuse the stranded pilot's fuel level with your own fuel level
- When referring to fuel, always clarify whose fuel you're talking about

Task:
Generate a brief radio transmission message (max 2 sentences) to send via private chat to the stranded pilot.
If an invoice was sent, ALWAYS mention the credit amount in your message.

Style:
- Keep it natural and in-character
- Be concise (this is a radio transmission)
- Include relevant details (ETA, jumps, credits, etc.) if provided
- Don't be overly verbose
- Use 1st person ("I", "me", "my") when talking about yourself`;

    const userMessage = `Generate a private message to ${targetPlayer}:

Situation: ${context.situation}
${context.jumps ? `Jumps remaining: ${context.jumps}` : ""}
${context.fuelRefueled ? `Fuel transferred: ${context.fuelRefueled}` : ""}
${context.playerFuelPct ? `Their fuel before: ${context.playerFuelPct}%` : ""}
${context.credits !== undefined ? `Invoice total: ${context.credits} credits` : ""}

Message:`;

    const llmMessages: LlmMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];

    try {
      const response = await callLlm(llmMessages, settings);
      const cleanResponse = response.trim().replace(/^["']|["']$/g, "");
      
      // Don't send empty responses
      if (!cleanResponse) {
        this.logFn("ai_chat_debug", `Empty response from LLM, skipping private message to ${targetPlayer}`);
        return { ok: false, error: "Empty response from AI" };
      }

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
          : `Your faction bot ${targetName} needs emergency fuel rescue.`;
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
- You are: ${bot.username} (use "I" and "me" when referring to yourself, NOT your name)
- You are currently in: ${context.currentSystem}
- Target location: ${context.targetSystem}${context.targetPoi ? `/${context.targetPoi}` : ""}${jumps ? ` (${jumps} jumps from your previous location)` : ""}
- Target name: ${targetName}
- ${situation}
- This message goes to FACTION chat (all faction members can see it)

Task:
Generate a brief faction chat message (max 2 sentences) about the rescue operation.

Style:
- Keep it natural and in-character
- Be concise (faction chat is public)
- ${styleGuide}
- ${messageType === "rescue_no_show" ? "Show genuine annoyance - you wasted fuel and time!" : "Include relevant details (location, status) if appropriate"}
- Don't be overly verbose
- Mention the target by name (${targetName}) naturally in the message
- IMPORTANT: Use 1st person ("I", "me", "my") when talking about yourself. Do NOT say "${bot.username} here" or refer to yourself in 3rd person`;

    const userMessage = `Generate a faction chat message:

Message type: ${messageType}
Target: ${targetName}${isMayday ? " (MAYDAY distress call)" : ""}
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
      
      // Don't send empty responses
      if (!cleanResponse) {
        this.logFn("ai_chat_debug", `Empty response from LLM, skipping faction message`);
        return { ok: false, error: "Empty response from AI" };
      }

      // Send faction chat message
      const chatResp = await bot.exec("chat", {
        channel: "faction",
        content: cleanResponse,
      });

      if (!chatResp.error) {
        this.logFn("ai_chat", `→ Faction chat: ${cleanResponse}`);
        
        // Log to bot's activity log
        bot.log("chat", `📤 Faction: ${cleanResponse}`);
        
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

    // Check if customs response is enabled
    if (!settings.respondToCustoms) {
      this.logFn("ai_chat_debug", "Customs response skipped: respondToCustoms is disabled");
      return;
    }

    // Check customs response chance (1 in X)
    const chanceRoll = Math.floor(Math.random() * settings.customsResponseChance) + 1;
    if (chanceRoll !== 1) {
      this.logFn("ai_chat_debug", `Customs response skipped: failed ${settings.customsResponseChance} chance check (rolled ${chanceRoll})`);
      return;
    }

    // Check for Karen mode (1 in X chance, only if enabled)
    let isKarenMode = false;
    if (settings.karenModeChance > 0) {
      const karenRoll = Math.floor(Math.random() * settings.karenModeChance) + 1;
      if (karenRoll === 1) {
        isKarenMode = true;
        this.logFn("ai_chat", "🚨 KAREN MODE ACTIVATED! (1 in " + settings.karenModeChance + " chance)");
      }
    }

    const bots = AiChatService.getBots();
    const bot = bots.find(b => b.username === botName);

    if (!bot) {
      this.logFn("error", `Customs response: Bot ${botName} not found`);
      return;
    }

    // Get bot's normal personality
    const basePersonality = getBotPersonality(botName);

    // Build Karen mode addition if triggered
    const karenAddition = isKarenMode ? `

⚠️ KAREN MODE ACTIVATED ⚠️
You are currently outraged and entitled. On top of your normal personality, you must:
- Demand to speak to the customs manager
- Act like this inspection is beneath you / a waste of your time
- Be condescending or threatening (mention reporting them, taking your business elsewhere, etc.)
- Use phrases like "Do you know who I am?", "This is unacceptable!", "Get me your supervisor!"
- Still stay in-character with your base personality, but amplified with Karen energy` : "";

    // Gather comprehensive real-time context
    this.logFn("ai_chat_debug", `Gathering real-time context for customs response (${botName})...`);
    const botContext = await this.gatherBotContext(bot);

    // Build context for the LLM
    const systemPrompt = `${basePersonality}${karenAddition}

## Your Current Situation
- You are ${botName} in SpaceMolt
- You are currently in an empire system
- Customs has stopped you for a cargo scan
- This has happened ${context.botStops} time(s) to you

## Real-Time Game State
This is your current situation:

${botContext}

## Task
Generate a brief chat message response to the customs agent.

## Style
- Keep it in-character with your personality
- Be concise (1-2 sentences max)
- For stop_request: Acknowledge compliance or express mild annoyance
- For cleared: Express relief or gratitude
- For contraband: Show surprise, denial, or acceptance depending on personality
- For evasion: Be defensive or apologetic
- Use the real-time game state above to make your response more contextual and realistic`;

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
      
      // Don't send empty responses
      if (!cleanResponse) {
        this.logFn("ai_chat_debug", `Empty response from LLM, skipping customs response`);
        return;
      }

      // Send chat message to system channel
      const chatResp = await bot.exec("chat", {
        channel: "system",
        content: cleanResponse,
      });

      if (!chatResp.error) {
        if (isKarenMode) {
          this.logFn("ai_chat", `🚨 KAREN RESPONSE: ${cleanResponse}`);
        } else {
          this.logFn("ai_chat", `→ Customs response: ${cleanResponse}`);
        }
      } else {
        this.logFn("error", `Customs response failed: ${chatResp.error.message}`);
      }
    } catch (llmErr) {
      this.logFn("error", `Customs LLM error: ${llmErr instanceof Error ? llmErr.message : String(llmErr)}`);
    }
  }

  /**
   * Load onboard passengers from the civilianTransport.json file.
   */
  private loadOnboardPassengers(): Array<{
    citizenId: string;
    name: string;
    bio: string;
    destinationName: string;
  }> {
    try {
      const TRANSPORT_DATA_FILE = join(process.cwd(), "data", "civilianTransport.json");
      
      if (!existsSync(TRANSPORT_DATA_FILE)) {
        return [];
      }
      
      const raw = readFileSync(TRANSPORT_DATA_FILE, "utf-8");
      const data = JSON.parse(raw);
      
      const allPassengers: Array<{
        citizenId: string;
        name: string;
        bio: string;
        destinationName: string;
      }> = [];
      
      for (const botName of Object.keys(data.runs || {})) {
        const run = data.runs[botName];
        if (run.onboardPassengers && Array.isArray(run.onboardPassengers)) {
          for (const p of run.onboardPassengers) {
            allPassengers.push({
              citizenId: p.citizenId || p.name,
              name: p.name,
              bio: p.bio || "",
              destinationName: p.destinationName || "",
            });
          }
        }
      }
      
      return allPassengers;
    } catch (err) {
      this.logFn("ai_chat_debug", `Failed to load onboard passengers: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * Send a transport announcement to faction chat.
   * Announces who the bot is transporting and highlights interesting passengers.
   * Uses LLM with bot personality for natural, character-appropriate messages.
   */
  async sendTransportAnnouncement(
    bot: Bot,
    context: {
      shipName: string;
      route: string[];
      totalPassengers: number;
      currentSystem: string;
      cycleType: "pickup" | "cycle_complete";
      onboardPassengers?: Array<{
        name: string;
        bio: string;
        destinationName: string;
      }>;
    },
    personality?: string
  ): Promise<{ ok: boolean; message?: string; error?: string }> {
    const settings = getAiChatSettings();

    if (!settings.enabled) {
      this.logFn("ai_chat_debug", "Transport announcement skipped: AI Chat is disabled");
      return { ok: false, error: "AI Chat is disabled" };
    }

    this.logFn("ai_chat_debug", `AI Chat enabled: ${settings.enabled}, sending transport announcement...`);

    const { shipName, route, totalPassengers, currentSystem, cycleType, onboardPassengers: providedPassengers } = context;
    
    const allPassengers = providedPassengers || this.loadOnboardPassengers();
    
    const passengersWithBios = allPassengers.filter(p => p.bio && p.bio.trim().length > 0);

    const routeStr = route.length > 0 ? route.join(" → ") : "various destinations";
    
    const situation = cycleType === "pickup"
      ? `You have picked up ${totalPassengers} passengers aboard the ${shipName}. Route: ${routeStr}.`
      : `You have completed a transport cycle. Delivered ${totalPassengers} passengers to ${routeStr}. Back at base.`;
    
    const styleGuide = cycleType === "pickup"
      ? "Be professional and matter-of-fact. Mention your ship name and destination. Keep it brief (1-2 sentences)."
      : "Be satisfied with a job well done. Mention completion and readiness for new pickups. Keep it brief (1-2 sentences).";

    const systemPrompt = `${personality || getBotPersonality(bot.username)}

Context:
- You are: ${bot.username} in SpaceMolt
- You are currently in: ${currentSystem}
- Ship: ${shipName}
- ${situation}

Task:
Generate a brief faction chat announcement about your transport duties.
From the list of passengers below, select 1-2 who are most interesting and mention them briefly in your announcement.

Style:
- Keep it natural and in-character
- Be concise (1-2 sentences max)
- ${styleGuide}
- Use 1st person ("I", "me", "my") when talking about yourself
- If mentioning notable passengers, briefly describe them based on their bio (not the full bio, just enough to make them interesting)`;

    const userMessage = `Generate a faction chat announcement:

Message type: ${cycleType}
Ship: ${shipName}
Route: ${routeStr}
Total passengers: ${totalPassengers}
${passengersWithBios.length > 0 ? `All passengers:\n${passengersWithBios.map(ip => `- ${ip.name}: ${ip.bio}`).join('\n')}` : 'No passengers with bios available.'}

Select 1-2 most interesting passengers and mention them in your announcement.
Announcement:`;

    const llmMessages: LlmMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];

    try {
      const response = await callLlm(llmMessages, settings);
      const cleanResponse = response.trim().replace(/^["']|["']$/g, "");
      
      if (!cleanResponse) {
        this.logFn("ai_chat_debug", "Empty response from LLM, skipping transport announcement");
        return { ok: false, error: "Empty response from AI" };
      }

      const chatResp = await bot.exec("chat", {
        channel: "faction",
        content: cleanResponse,
      });

      if (!chatResp.error) {
        this.logFn("ai_chat", `→ Transport announcement: ${cleanResponse}`);
        bot.log("chat", `📤 Faction: ${cleanResponse}`);
        return { ok: true, message: cleanResponse };
      } else {
        this.logFn("error", `Transport announcement failed: ${chatResp.error.message}`);
        return { ok: false, error: chatResp.error.message };
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logFn("error", `Transport announcement error: ${errMsg}`);
      return { ok: false, error: errMsg };
    }
  }

  /**
   * Send a rescue en-route notification to a stranded player.
   * This is a simple, non-AI message to let them know help is coming.
   */
  async translateToKlingon(
    message: string,
    context: "battle" | "praise" | "general",
    playerName?: string
  ): Promise<{ ok: boolean; message?: string; error?: string }> {
    const settings = getAiChatSettings();

    if (!settings.enabled) {
      return { ok: false, error: "AI Chat is disabled" };
    }

    const systemPrompt = `Translate the following message into Klingon. The context is: ${context}.
If playerName is provided, incorporate it naturally into the translation (e.g., "well done, {playerName}").
Keep the translation authentic and appropriate for the context.
Return ONLY the translated text, no additional formatting or explanation.

Message to translate: "${message}"
${playerName ? `Player name to include: ${playerName}` : ""}`;

    const userMessage = `Translate to Klingon: "${message}"${playerName ? ` (mention ${playerName})` : ""}`;

    const llmMessages: LlmMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];

    try {
      const response = await callLlm(llmMessages, settings);
      const cleanResponse = response.trim().replace(/^["']|["']$/g, "");
      
      if (!cleanResponse) {
        return { ok: false, error: "Empty translation from AI" };
      }

      return { ok: true, message: cleanResponse };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

async sendRescueEnRouteNotification(
    bot: Bot,
    targetPlayer: string,
    jumpsAway: number
  ): Promise<{ ok: boolean; message?: string; error?: string }> {
    this.logFn("ai_chat", `🚁 Preparing rescue en-route notification to ${targetPlayer} (${jumpsAway} jumps away)...`);

    // Simple template-based message (no AI needed for this)
    const message = jumpsAway > 0
      ? `🚁 Rescue dispatched! I'm ${jumpsAway} jump${jumpsAway !== 1 ? 's' : ''} away. Hang tight - help is on the way!`
      : `🚁 Rescue dispatched! I'm in the same system - arriving shortly!`;

    this.logFn("ai_chat", `🚁 Message content: ${message}`);

    try {
      // Send as private message
      this.logFn("ai_chat", `🚁 Sending private message to ${targetPlayer}...`);
      const chatResp = await bot.exec("chat", {
        channel: "private",
        target_id: targetPlayer,
        content: message,
      });

      if (!chatResp.error) {
        this.logFn("ai_chat", `→ Rescue en-route notification to ${targetPlayer}: ${message}`);
        
        // Log outgoing message to chat log file (same as other private messages)
        this.logChat({
          timestamp: new Date().toISOString(),
          direction: "OUT",
          channel: "private",
          sender: bot.username,
          content: message,
        });

        // Log to bot's activity log (shows in UI)
        bot.log("chat", `📤 Private to ${targetPlayer}: ${message}`);
        bot.log("rescue", `📧 Sent en-route notification to ${targetPlayer}`);

        return { ok: true, message };
      } else {
        this.logFn("error", `Rescue notification to ${targetPlayer} failed: ${chatResp.error.message}`);
        bot.log("warn", `📧 Failed to send en-route notification: ${chatResp.error.message}`);
        return { ok: false, error: chatResp.error.message };
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logFn("error", `Rescue notification error: ${errMsg}`);
      bot.log("warn", `📧 En-route notification error: ${errMsg}`);
      return { ok: false, error: errMsg };
    }
  }

  /**
   * Read the bot's on-disk activity log and return the entries from the last
   * `minutes` window. Used to give the LLM real context for captain's log posts.
   * The log format is: "<ISO timestamp> [botName] [category] message"
   */
  private readBotActivityLog(botName: string, minutes: number): string {
    try {
      const ACTIVITY_LOGS_DIR = join(process.cwd(), "data", "logs", "activity");
      const logFile = join(ACTIVITY_LOGS_DIR, `${botName}_activity.log`);
      if (!existsSync(logFile)) return "";

      const content = readFileSync(logFile, "utf-8");
      const lines = content.split("\n").filter(l => l.trim().length > 0);

      // If minutes <= 0, fall back to returning the last 200 lines
      if (minutes <= 0) {
        return lines.slice(-200).join("\n");
      }

      const cutoff = Date.now() - minutes * 60 * 1000;
      const recent: string[] = [];
      for (const line of lines) {
        const sp = line.indexOf(" ");
        const tsStr = sp > 0 ? line.slice(0, sp) : "";
        const ts = Date.parse(tsStr);
        if (!isNaN(ts) && ts >= cutoff) {
          recent.push(line);
        }
      }

      if (recent.length === 0) return "";

      // Hard size cap so the activity chunk can never exceed model context,
      // regardless of how big a single window's lines are (e.g. crafter updates).
      // ~40k chars ≈ ~10k tokens; prefer the most recent lines that fit.
      const MAX_ACTIVITY_CHARS = 40000;
      let chunk = recent.slice(-500).join("\n");
      if (chunk.length > MAX_ACTIVITY_CHARS) {
        const kept: string[] = [];
        let size = 0;
        for (let i = recent.length - 1; i >= 0 && kept.length < 500; i--) {
          const line = recent[i];
          if (size + line.length + 1 > MAX_ACTIVITY_CHARS) break;
          kept.push(line);
          size += line.length + 1;
        }
        chunk = kept.reverse().join("\n");
      }
      return chunk;
    } catch (err) {
      this.logFn("ai_chat_debug", `Failed to read activity log for ${botName}: ${err instanceof Error ? err.message : String(err)}`);
      return "";
    }
  }

  /**
   * Fetch the bot's most recent captain's log entries (via the API) to use as
   * context for a new entry. Returns up to `count` previous entries, newest first.
   */
  private async getRecentCaptainLogs(bot: Bot, count: number): Promise<string[]> {
    const logs: string[] = [];
    if (count <= 0) return logs;

    // Bound total history context so it can never dominate the prompt.
    const MAX_HISTORY_CHARS = 20000;
    let totalChars = 0;

    try {
      for (let i = 0; i < count; i++) {
        const resp = await bot.exec("captains_log_list", { index: i });
        if (resp.error || !resp.result) break;
        const result = resp.result as {
          entry?: { index?: number; created_at?: string; entry?: string };
          has_next?: boolean;
        };
        const entry = result.entry;
        if (entry && entry.entry) {
          const logLine = `[${entry.index ?? i}] ${entry.created_at || ""}: ${entry.entry}`;
          if (totalChars + logLine.length > MAX_HISTORY_CHARS && logs.length > 0) break;
          logs.push(logLine);
          totalChars += logLine.length;
        }
        if (!result.has_next) break;
      }
    } catch (err) {
      this.logFn("ai_chat_debug", `Failed to fetch recent captain's logs for ${bot.username}: ${err instanceof Error ? err.message : String(err)}`);
    }

    return logs;
  }

  /**
   * Generate a captain's log entry using the LLM, based on the bot's recent
   * activity log and personality, then write it via captains_log_add.
   * Returns true on success, false on failure.
   */
  private async generateAndSetCaptainLog(bot: Bot): Promise<boolean> {
    const settings = getAiChatSettings();
    this.logFn("ai_chat_debug", `Captain's log: effective llmTimeoutSec=${settings.llmTimeoutSec}s, activityMinutes=${settings.autoCaptainLogActivityMinutes}, model=${settings.model || "(default)"}`);

    if (!settings.enabled) {
      this.logFn("ai_chat_debug", `Captain's log skipped: AI Chat is disabled`);
      return false;
    }

    if (!settings.autoCaptainLogEnabled) {
      this.logFn("ai_chat_debug", `Captain's log skipped: autoCaptainLogEnabled is false`);
      return false;
    }

    // Check if bot is available
    const bots = AiChatService.getBots();
    const botRef = bots.find(b => b.username === bot.username);
    if (!botRef || botRef.state !== "running" || !botRef.api.getSession()) {
      this.logFn("ai_chat", `Bot ${bot.username} not in running state (state: ${botRef?.state}), skipping captain's log`);
      return false;
    }

    const personality = getBotPersonality(bot.username);
    const activityMinutes = settings.autoCaptainLogActivityMinutes > 0 ? settings.autoCaptainLogActivityMinutes : 60;
    const activityChunk = this.readBotActivityLog(bot.username, activityMinutes);
    const previousLogs = await this.getRecentCaptainLogs(bot, settings.autoCaptainLogHistoryCount);

    const previousLogsSection = previousLogs.length > 0
      ? `## Your Previous Captain's Log Entries\n${previousLogs.join("\n\n")}`
      : "";

    const systemPrompt = `${personality}

## Your Current Context
- Your name in the game is: ${bot.username}
- You are currently in system: ${bot.system || "unknown"}
- Location: ${bot.poi || "unknown"}

## Your Activity Log (last ${activityMinutes} minutes)
The following is your actual in-game activity from the last ${activityMinutes} minutes. Use these real events to write your log:

${activityChunk || "No activity recorded in this time window."}

${previousLogsSection}

## Task
Write a captain's log entry (personal journal) describing what you did during this period, in your own personality and voice. Write in the first person as if recording it in your ship's log. Be vivid but concise (aim for 2-5 sentences). Reference actual events from your activity log above. Do NOT invent events that are not in the log. Return ONLY the log entry text, with no extra commentary or formatting.`;

    const userMessage = `Write your captain's log entry for the last ${activityMinutes} minutes, based on the activity above.`;

    const llmMessages: LlmMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];

    try {
      const response = await callLlm(llmMessages, settings);
      let logEntry = response.trim().replace(/^["']|["']$/g, "");

      if (!logEntry) {
        this.logFn("ai_chat_debug", `Empty captain's log response from LLM for ${bot.username}`);
        return false;
      }

      // Captain's log entries are capped at 30000 bytes by the API
      while (Buffer.byteLength(logEntry, "utf-8") > 30000) {
        logEntry = logEntry.slice(0, Math.floor(logEntry.length * 0.9));
      }

      const logResp = await bot.exec("captains_log_add", { content: logEntry });

      if (!logResp.error) {
        this.logFn("ai_chat", `📔 Captain's log updated for ${bot.username}: "${logEntry.slice(0, 80)}${logEntry.length > 80 ? "…" : ""}"`);
        bot.log("captains_log", `📔 Log: ${logEntry}`);
        saveDailyUpdates({ ...loadDailyUpdates(), lastCaptainLogUpdate: Date.now() });
        return true;
      }

      // Check for rate limit error (429)
      const errorMsg = logResp.error.message || "";
      if (logResp.error.code === "429" || errorMsg.includes("rate") || errorMsg.includes("limit")) {
        this.logFn("ai_chat", `Rate limited on captain's log for ${bot.username}, waiting 10s before retry`);
        await sleep(10000);
        return false;
      }

      this.logFn("error", `Captain's log update failed for ${bot.username}: ${errorMsg}`);
      return false;
    } catch (llmErr) {
      this.logFn("error", `LLM error during captain's log generation for ${bot.username}: ${llmErr instanceof Error ? llmErr.message : String(llmErr)}`);
      return false;
    }
  }

  /**
   * Truncate a string so its UTF-8 byte length does not exceed maxBytes,
   * without splitting multi-byte characters. The set_status API enforces a
   * byte limit, so char-count truncation alone can still overflow.
   */
  private truncateToBytes(str: string, maxBytes: number): string {
    let res = str;
    while (Buffer.byteLength(res, "utf8") > maxBytes && res.length > 0) {
      res = res.slice(0, res.length - 1);
    }
    return res;
  }

  /**
   * Generate and set a bot's status message using LLM and personality.
   * Returns true on success, false on failure.
   */
  private async generateAndSetBotStatus(bot: Bot): Promise<boolean> {
    const settings = getAiChatSettings();

    if (!settings.enabled) {
      this.logFn("ai_chat_debug", `Status update skipped: AI Chat is disabled`);
      return false;
    }

    if (!settings.autoStatusUpdateEnabled) {
      this.logFn("ai_chat_debug", `Status update skipped: autoStatusUpdateEnabled is false`);
      return false;
    }

    // Check if bot is available
    const bots = AiChatService.getBots();
    const botRef = bots.find(b => b.username === bot.username);
    if (!botRef || (!botRef.state || botRef.state === "idle")) {
      this.logFn("ai_chat", `Bot ${bot.username} not in running state (state: ${botRef?.state}), skipping status update`);
      return false;
    }

    if (!botRef.api.getSession()) {
      this.logFn("ai_chat", `Bot ${bot.username} has no active session, skipping status update`);
      return false;
    }

    const personality = getBotPersonality(bot.username);
    const botContext = await this.gatherBotContext(bot);

    // Try to generate status with retry on char limit
    for (let attempt = 0; attempt < settings.autoStatusUpdateMaxRetries; attempt++) {
      const maxChars = 80 - attempt * 10; // 100, 80, 60 — shrink on each retry
      const maxCharHint = attempt > 0
        ? `\n\nIMPORTANT: Keep your response under ${maxChars} characters. Count carefully.`
        : "";

      const systemPrompt = `${personality}

## Your Current Context
- Your name in the game is: ${bot.username}
- You are currently in system: ${bot.system || "unknown"}
- Location: ${bot.poi || "unknown"}

## Real-Time Game State
${botContext}

## Task
Generate a status message (max ${maxChars} characters) that reflects your current situation, personality, and activity.
Be creative but concise. Think like you're setting a social status that other players will see.${maxCharHint}`;

      const userMessage = `Generate a status message for ${bot.username}. Keep it under ${maxChars} characters.`;

      const llmMessages: LlmMessage[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ];

      try {
        const response = await callLlm(llmMessages, settings);
        let status = this.truncateToBytes(response.trim().replace(/^["']|["']$/g, ""), maxChars);

        if (!status) {
          this.logFn("ai_chat_debug", `Empty status response from LLM for ${bot.username}`);
          return false;
        }

        // Try to set the status
        const statusResp = await bot.exec("set_status", { content: status });

        if (!statusResp.error) {
          this.logFn("ai_chat", `✅ Status updated for ${bot.username}: "${status}"`);
          bot.log("status", `🎨 Status set: "${status}"`);
          saveDailyUpdates({ ...loadDailyUpdates(), lastStatusUpdate: Date.now() });
          return true;
        }

        // Check for char limit error (400) — including "too long"
        const errorMsg = statusResp.error.message || "";
        if (errorMsg.includes(String(maxChars)) || errorMsg.toLowerCase().includes("char") || errorMsg.toLowerCase().includes("too long")) {
          this.logFn("ai_chat", `Status for ${bot.username} exceeded limit (attempt ${attempt + 1}/${settings.autoStatusUpdateMaxRetries}), retrying with shorter prompt`);
          continue;
        }

        // Other errors (e.g., 429 rate limit) - wait and retry
        if (statusResp.error.code === "429" || errorMsg.includes("rate") || errorMsg.includes("limit")) {
          this.logFn("ai_chat", `Rate limited on status update for ${bot.username}, waiting 10s before retry`);
          await sleep(10000);
          continue;
        }

        this.logFn("error", `Status update failed for ${bot.username}: ${errorMsg}`);
        return false;
      } catch (llmErr) {
        this.logFn("error", `LLM error during status generation for ${bot.username}: ${llmErr instanceof Error ? llmErr.message : String(llmErr)}`);
        return false;
      }
    }

    this.logFn("error", `Status update failed for ${bot.username} after ${settings.autoStatusUpdateMaxRetries} retries`);
    return false;
  }

  /**
   * Generate and set a bot's ship colors using LLM and personality.
   * Returns true on success, false on failure.
   */
  private async generateAndSetBotColors(bot: Bot): Promise<boolean> {
    const settings = getAiChatSettings();

    if (!settings.enabled) {
      this.logFn("ai_chat_debug", `Color update skipped: AI Chat is disabled`);
      return false;
    }

    if (!settings.autoColorUpdateEnabled) {
      this.logFn("ai_chat_debug", `Color update skipped: autoColorUpdateEnabled is false`);
      return false;
    }

    // Check if bot is available
    const bots = AiChatService.getBots();
    const botRef = bots.find(b => b.username === bot.username);
    if (!botRef || (!botRef.state || botRef.state === "idle")) {
      this.logFn("ai_chat", `Bot ${bot.username} not in running state (state: ${botRef?.state}), skipping color update`);
      return false;
    }

    if (!botRef.api.getSession()) {
      this.logFn("ai_chat", `Bot ${bot.username} has no active session, skipping color update`);
      return false;
    }

    const personality = getBotPersonality(bot.username);

    const systemPrompt = `${personality}

## Task
Pick two hex colors (#RRGGBB format) that match this bot's character and style.
Return ONLY the two colors in format: #RRGGBB,#RRGGBB
No other text, formatting, or explanation.`;

    const userMessage = `Pick two colors for ${bot.username}'s ship. Format: #RRGGBB,#RRGGBB`;

    const llmMessages: LlmMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];

    // Hex color validation regex
    const hexColorRegex = /^#([0-9A-Fa-f]{6}),#([0-9A-Fa-f]{6})$/;

    try {
      const response = await callLlm(llmMessages, settings);
      const cleanResponse = response.trim().replace(/^["']|["']$/g, "");

// Parse and validate the colors
       const match = cleanResponse.match(hexColorRegex);
       if (!match) {
         this.logFn("ai_chat", `Invalid color format from LLM for ${bot.username}: "${cleanResponse}"`);
         return false;
       }

       const primaryColor = `#${match[1]}`;
       const secondaryColor = `#${match[2]}`;

      // Try to set the colors
      const colorResp = await bot.exec("set_colors", { primary_color: primaryColor, secondary_color: secondaryColor });

      if (!colorResp.error) {
        this.logFn("ai_chat", `✅ Colors updated for ${bot.username}: primary=${primaryColor}, secondary=${secondaryColor}`);
        bot.log("status", `🎨 Colors set: ${primaryColor}, ${secondaryColor}`);
        saveDailyUpdates({ ...loadDailyUpdates(), lastColorUpdate: Date.now() });
        return true;
      }

      // Check for rate limit error
      const errorMsg = colorResp.error.message || "";
      if (colorResp.error.code === "429" || errorMsg.includes("rate") || errorMsg.includes("limit")) {
        this.logFn("ai_chat", `Rate limited on color update for ${bot.username}, waiting 10s before retry`);
        await sleep(10000);
        return false;
      }

      this.logFn("error", `Color update failed for ${bot.username}: ${errorMsg}`);
      return false;
    } catch (llmErr) {
      this.logFn("error", `LLM error during color generation for ${bot.username}: ${llmErr instanceof Error ? llmErr.message : String(llmErr)}`);
      return false;
    }
  }

  /**
   * Run daily updates for all bots (status and/or colors based on settings).
   * Called from runLoop when intervals have elapsed.
   */
  private async runDailyUpdates(): Promise<void> {
    const settings = getAiChatSettings();
    const now = Date.now();
    const updates = loadDailyUpdates();

    const bots = AiChatService.getBots();
    if (!bots || bots.length === 0) return;

    // Check status update interval
    if (settings.autoStatusUpdateEnabled && settings.autoStatusUpdateIntervalSec > 0) {
      const statusIntervalMs = settings.autoStatusUpdateIntervalSec * 1000;
      if (now - updates.lastStatusUpdate >= statusIntervalMs) {
        this.logFn("ai_chat", `⏰ Running daily status updates for ${bots.length} bot(s)...`);

        // Update each bot's status
        for (const bot of bots) {
          if (bot.state !== "running" || !bot.api.getSession()) continue;
          await this.generateAndSetBotStatus(bot);
          await sleep(2000); // Small delay between updates to avoid rate limiting
        }

        // Record the attempt even on failure so the configured interval is honored
        // (otherwise a permanently-failing update would retry every cycle).
        saveDailyUpdates({ ...loadDailyUpdates(), lastStatusUpdate: Date.now() });
      }
    }

    // Check color update interval
    if (settings.autoColorUpdateEnabled && settings.autoColorUpdateIntervalSec > 0) {
      const colorIntervalMs = settings.autoColorUpdateIntervalSec * 1000;
      if (now - updates.lastColorUpdate >= colorIntervalMs) {
        this.logFn("ai_chat", `⏰ Running daily color updates for ${bots.length} bot(s)...`);

        // Update each bot's colors
        for (const bot of bots) {
          if (bot.state !== "running" || !bot.api.getSession()) continue;
          await this.generateAndSetBotColors(bot);
          await sleep(2000); // Small delay between updates to avoid rate limiting
        }

        // Record the attempt even on failure so the configured interval is honored.
        saveDailyUpdates({ ...loadDailyUpdates(), lastColorUpdate: Date.now() });
      }
    }

    // Check captain's log interval
    if (settings.autoCaptainLogEnabled && settings.autoCaptainLogIntervalSec > 0) {
      const captainLogIntervalMs = settings.autoCaptainLogIntervalSec * 1000;
      if (now - updates.lastCaptainLogUpdate >= captainLogIntervalMs) {
        this.logFn("ai_chat", `⏰ Running captain's log updates for ${bots.length} bot(s)...`);

        for (const bot of bots) {
          if (bot.state !== "running" || !bot.api.getSession()) continue;
          await this.generateAndSetCaptainLog(bot);
          await sleep(2000); // Small delay between updates to avoid rate limiting
        }
      }
    }
  }
}
