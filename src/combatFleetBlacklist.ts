import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { safeWriteFileSync } from "./diskSpaceGuard.js";

/**
 * Persistent, file-backed store of PERMANENTLY blacklisted systems that are
 * only safe to enter with a combat fleet.
 *
 * A system lands here when a miner (or any routine) is ambushed by a dangerous
 * repeater composition (see classifyDangerousRepeaters in routines/common.ts).
 * Unlike the 6h temp blacklist, these entries never expire: the system is
 * considered a permanent death-trap for a solo ship.
 *
 * The ban is lifted for a miner ONLY when it is in a fleet that contains a
 * `Combat Drone NNN` member (001-999) — the user's dedicated combat bots. The
 * check is performed at miner startup (see hasCombatDroneMember in fleet.ts).
 *
 * The file is the source of truth and is shared by every process/bot:
 *   data/combatFleetBlacklist.json
 */

const DATA_DIR = join(process.cwd(), "data");
const COMBAT_FLEET_BLACKLIST_FILE = join(DATA_DIR, "combatFleetBlacklist.json");

export interface CombatFleetBlacklistEntry {
  system: string;
  addedAt: string;   // ISO
  reason: string;
  lastEnemy: string;
  battleId: string;
}

interface CombatFleetBlacklistFile {
  bannedSystems: Record<string, CombatFleetBlacklistEntry>;
  lastUpdated: string;
}

function normalizeSystemId(systemId: string): string {
  return (systemId || "").trim().toLowerCase();
}

function blankFile(): CombatFleetBlacklistFile {
  return { bannedSystems: {}, lastUpdated: new Date().toISOString() };
}

/** Read the file from disk. Cached in-memory after first read. */
let cache: CombatFleetBlacklistFile | null = null;

function load(): CombatFleetBlacklistFile {
  if (cache) return cache;
  try {
    if (existsSync(COMBAT_FLEET_BLACKLIST_FILE)) {
      const parsed = JSON.parse(readFileSync(COMBAT_FLEET_BLACKLIST_FILE, "utf-8")) as CombatFleetBlacklistFile;
      if (!parsed || typeof parsed !== "object" || !parsed.bannedSystems) {
        cache = blankFile();
      } else {
        cache = parsed;
      }
    } else {
      cache = blankFile();
    }
  } catch (err) {
    console.warn(`[CombatFleetBlacklist] corrupt combatFleetBlacklist.json, starting fresh —`, err);
    cache = blankFile();
  }
  return cache;
}

function persist(): void {
  const data = load();
  data.lastUpdated = new Date().toISOString();
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    const payload = JSON.stringify(data, null, 2) + "\n";
    // Prefer the disk-space-guarded write; fall back to a direct write so a
    // guard rejection never silently drops a safety ban.
    const ok = safeWriteFileSync(COMBAT_FLEET_BLACKLIST_FILE, payload, Buffer.byteLength(payload, "utf-8"));
    if (!ok) writeFileSync(COMBAT_FLEET_BLACKLIST_FILE, payload, "utf-8");
  } catch (err) {
    console.error(`[CombatFleetBlacklist] Failed to write combatFleetBlacklist.json:`, err);
  }
}

/**
 * Permanently ban a system (no expiry). Idempotent: re-banning keeps the
 * original `addedAt` and refreshes the reason/lastEnemy/battleId.
 */
export function addCombatFleetBlacklistSystem(
  systemId: string,
  opts: { reason: string; lastEnemy?: string; battleId?: string },
): CombatFleetBlacklistEntry {
  const data = load();
  const key = normalizeSystemId(systemId);
  if (!key) {
    return { system: "", addedAt: new Date().toISOString(), reason: opts.reason, lastEnemy: opts.lastEnemy ?? "", battleId: opts.battleId ?? "" };
  }

  const existing = data.bannedSystems[key];
  const entry: CombatFleetBlacklistEntry = {
    system: key,
    addedAt: existing?.addedAt ?? new Date().toISOString(),
    reason: opts.reason,
    lastEnemy: opts.lastEnemy ?? existing?.lastEnemy ?? "",
    battleId: opts.battleId ?? existing?.battleId ?? "",
  };
  data.bannedSystems[key] = entry;
  persist();
  return entry;
}

/** True if the system is permanently blacklisted (combat fleet required). */
export function isCombatFleetBlacklisted(systemId: string): boolean {
  const key = normalizeSystemId(systemId);
  if (!key) return false;
  return !!load().bannedSystems[key];
}

/** Currently banned systemIds. */
export function getCombatFleetBlacklist(): string[] {
  return Object.values(load().bannedSystems).map((e) => e.system);
}

/** All entries, for UI/inspection. */
export function getCombatFleetBlacklistEntries(): CombatFleetBlacklistEntry[] {
  return Object.values(load().bannedSystems);
}

/** Remove a specific system's ban (manual clear). */
export function removeCombatFleetBlacklistSystem(systemId: string): boolean {
  const key = normalizeSystemId(systemId);
  const data = load();
  if (!data.bannedSystems[key]) return false;
  delete data.bannedSystems[key];
  persist();
  return true;
}

/** Force a reload from disk (e.g. after another process wrote the file). */
export function reloadCombatFleetBlacklist(): void {
  cache = null;
  load();
}