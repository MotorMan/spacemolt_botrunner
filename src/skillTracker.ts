import { existsSync, mkdirSync, appendFileSync } from "fs";
import { join } from "path";
import type { Bot } from "./bot.js";
import { catalogStore } from "./catalogstore.js";

const DATA_DIR = join(process.cwd(), "data");
const SKILLS_LOG_DIR = join(DATA_DIR, "skillsLog");

let lastLoggedAt: Record<string, number> = {};
let cachedSkillNames: string[] | null = null;

function getSkillNames(): string[] {
  if (cachedSkillNames) return cachedSkillNames;
  
  const skills = catalogStore.getAll().skills;
  const names = Object.keys(skills).sort();
  
  if (names.length === 0) {
    return [];
  }
  
  cachedSkillNames = names;
  return names;
}

export function refreshSkillNames(): void {
  cachedSkillNames = null;
}

function ensureLogDir(): void {
  if (!existsSync(SKILLS_LOG_DIR)) {
    mkdirSync(SKILLS_LOG_DIR, { recursive: true });
  }
}

function getLogPath(botName: string): string {
  return join(SKILLS_LOG_DIR, `${botName}-skillLog.csv`);
}

function writeHeader(botName: string, skillNames: string[]): void {
  const header = ["botName", ...skillNames.flatMap(name => [`${name}Level`, `${name}XP`])].join(",");
  const logPath = getLogPath(botName);
  ensureLogDir();
  appendFileSync(logPath, header + "\n", "utf8");
}

export function logSkills(bot: Bot): void {
  const now = Date.now();
  const lastLogged = lastLoggedAt[bot.username] || 0;
  const timeSinceLastLog = now - lastLogged;
  
  if (timeSinceLastLog < 60000 && lastLogged > 0) {
    return;
  }
  
  lastLoggedAt[bot.username] = now;
  
  let skillNames = getSkillNames();
  
  const skills = bot.status().skills || {};
  
  if (skillNames.length === 0) {
    skillNames = Object.keys(skills).sort();
    cachedSkillNames = skillNames;
  }
  
  const values = skillNames.map(name => {
    const skill = skills[name];
    if (skill) {
      return [skill.level, skill.xp].join(",");
    }
    return "0,0";
  });
  
  const line = [bot.username, ...values].join(",");
  const logPath = getLogPath(bot.username);
  
  ensureLogDir();
  if (!existsSync(logPath)) {
    writeHeader(bot.username, skillNames);
  }
  
  appendFileSync(logPath, line + "\n", "utf8");
}