import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import type { Bot } from "./bot";

// ── Interface Definitions ─────────────────────────────────────

export interface PilotSkillEvent {
  timestamp: string;
  action: string;
  ship: string;
  level_before: number;
  level_after: number;
  xp_gained: number;
}

export interface BotPilotData {
  current_level: number;
  current_xp: number;
  ship: string;
  total_jumps: number;
  total_travels: number;
  total_xp: number;
  total_xp_jumps: number;
  total_xp_travels: number;
  first_seen: string;
  last_seen: string;
  events: PilotSkillEvent[];
  avg_xp_per_jump: number;
  avg_xp_per_travel: number;
  estimated_date_100: string | null;
}

export interface SkillGainEvent {
  timestamp: string;
  command: string;
  ship: string;
  skillId: string;
  skillName: string;
  levelBefore: number;
  levelAfter: number;
  xpBefore: number;
  xpAfter: number;
  xpGained: number;
  xpToNext?: number; // XP remaining to reach next level (after this gain)
  totalXPBefore?: number;
  totalXPAfter?: number;
}

interface BotSkillLog {
  firstSeen: string;
  lastSeen: string;
  events: SkillGainEvent[];
}

// ── File paths ─────────────────────────────────────────────────

const DATA_DIR = join(process.cwd(), "data");
const PILOT_FILE = join(DATA_DIR, "pilotSkill.json");
const SKILLS_FILE = join(DATA_DIR, "skills.json");

// ── Logging toggle ──────────────────────────────────────────────
// Set to true to re-enable file logging (currently disabled due to excessive disk writes)
const ENABLE_SKILL_FILE_LOGGING = false;

// ── In-memory stores ────────────────────────────────────────────

let pilotDataMap: Record<string, BotPilotData> = {};
let skillLogMap: Record<string, BotSkillLog> = {};
let writeQueue: Promise<void> = Promise.resolve();

// ── Helper functions ───────────────────────────────────────────

function loadPilotData(): void {
  try {
    if (existsSync(PILOT_FILE)) {
      const raw = readFileSync(PILOT_FILE, "utf8");
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) {
        pilotDataMap = parsed as Record<string, BotPilotData>;
      }
    }
  } catch (err) {
    console.error("Failed to load pilotSkill data:", err);
    pilotDataMap = {};
  }
}

function savePilotData(): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(PILOT_FILE, JSON.stringify(pilotDataMap, null, 2), "utf8");
  } catch (err) {
    console.error("Failed to save pilotSkill data:", err);
  }
}

function loadSkillLog(): void {
  try {
    if (existsSync(SKILLS_FILE)) {
      const raw = readFileSync(SKILLS_FILE, "utf8");
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) {
        skillLogMap = parsed as Record<string, BotSkillLog>;
      }
    }
  } catch (err) {
    console.error("Failed to load skills log:", err);
    skillLogMap = {};
  }
}

function saveSkillLog(): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(SKILLS_FILE, JSON.stringify(skillLogMap, null, 2), "utf8");
  } catch (err) {
    console.error("Failed to save skills log:", err);
  }
}

function computeDerivedStats(data: BotPilotData): void {
  data.avg_xp_per_jump = data.total_jumps > 0 ? data.total_xp_jumps / data.total_jumps : 0;
  data.avg_xp_per_travel = data.total_travels > 0 ? data.total_xp_travels / data.total_travels : 0;

  if (data.current_level >= 100) {
    data.estimated_date_100 = "REACHED";
  } else if (data.events.length >= 2 && data.first_seen && data.last_seen) {
    const first = new Date(data.first_seen).getTime();
    const last = new Date(data.last_seen).getTime();
    const elapsedMs = last - first;
    if (elapsedMs > 0) {
      const elapsedDays = elapsedMs / (1000 * 60 * 60 * 24);
      const xpPerDay = data.total_xp / elapsedDays;
      if (xpPerDay > 0 && data.current_level > 0) {
        const avgXPPerLevel = data.current_xp / data.current_level;
        const remainingLevels = 100 - data.current_level;
        const remainingXP = avgXPPerLevel * remainingLevels;
        const daysTo100 = remainingXP / xpPerDay;
        const est = new Date();
        est.setDate(est.getDate() + Math.ceil(daysTo100));
        data.estimated_date_100 = est.toISOString();
      } else {
        data.estimated_date_100 = null;
      }
    } else {
      data.estimated_date_100 = null;
    }
  } else {
    data.estimated_date_100 = null;
  }
}

// ── Core functions ─────────────────────────────────────────────

/**
 * Record piloting activity (jump/travel/etc.) aggregated stats.
 * XP gain already computed, no API calls inside.
 */
export function recordPilotingActivity(
  bot: Bot,
  command: string,
  xpGained: number,
  levelAfter: number,
  xpAfterTotal: number,
  ship: string
): void {
  const now = new Date().toISOString();
  const task = async (): Promise<void> => {
    try {
      let data = pilotDataMap[bot.username];
      const isNew = !data;
      if (isNew) {
        data = {
          current_level: levelAfter,
          current_xp: xpAfterTotal, // within-level XP after this gain
          ship,
          total_jumps: 0,
          total_travels: 0,
          total_xp: xpGained, // this first observed gain
          total_xp_jumps: 0,
          total_xp_travels: 0,
          first_seen: now,
          last_seen: now,
          events: [],
          avg_xp_per_jump: 0,
          avg_xp_per_travel: 0,
          estimated_date_100: null,
        };
      } else {
        const prevLevel = data.current_level;
        data.last_seen = now;
        data.current_level = levelAfter;
        // Set current_xp to the new within-level XP after gain
        data.current_xp = xpAfterTotal;
        data.total_xp += xpGained;
        if (xpGained > 0) {
          const event: PilotSkillEvent = {
            timestamp: now,
            action: command,
            ship,
            level_before: prevLevel,
            level_after: levelAfter,
            xp_gained: xpGained,
          };
          data.events.push(event);
        }
      }

      if (command === "jump") {
        data.total_jumps++;
        data.total_xp_jumps += xpGained;
      } else if (command === "travel") {
        data.total_travels++;
        data.total_xp_travels += xpGained;
      }

      data.ship = ship;
      computeDerivedStats(data);
      pilotDataMap[bot.username] = data;
      if (ENABLE_SKILL_FILE_LOGGING) savePilotData();
    } catch (err) {
      console.error(`Piloting tracking error for ${bot.username}:`, err);
    }
  };

  const p = writeQueue.then(() => task()).catch((err) => {
    console.error("Tracking queue error:", err);
  });
  writeQueue = p.catch(() => {});
}

/**
 * Record skill gains for any command across all skills.
 */
export function recordSkillGains(
  bot: Bot,
  command: string,
  ship: string,
  gains: Array<{
    id: string;
    name: string;
    levelBefore: number;
    levelAfter: number;
    xpBefore: number;
    xpAfter: number;
    xpGained: number;
    xpToNext?: number;
    totalXPBefore?: number;
    totalXPAfter?: number;
  }>
): void {
  const now = new Date().toISOString();
  let entry = skillLogMap[bot.username];
  if (!entry) {
    entry = { firstSeen: now, lastSeen: now, events: [] };
    skillLogMap[bot.username] = entry;
  } else {
    entry.lastSeen = now;
  }
   for (const g of gains) {
     entry.events.push({
       timestamp: now,
       command,
       ship,
       skillId: g.id,
       skillName: g.name,
       levelBefore: g.levelBefore,
       levelAfter: g.levelAfter,
       xpBefore: g.xpBefore,
       xpAfter: g.xpAfter,
       xpGained: g.xpGained,
       xpToNext: g.xpToNext,
       totalXPBefore: g.totalXPBefore,
       totalXPAfter: g.totalXPAfter,
     });
   }
   if (ENABLE_SKILL_FILE_LOGGING) saveSkillLog();
 }

 // ── Initialize ────────────────────────────────────────────────

 loadPilotData();
 loadSkillLog();
