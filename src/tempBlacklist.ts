import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { safeWriteFileSync } from "./diskSpaceGuard.js";

/**
 * Persistent, file-backed store of TEMPORARILY blacklisted systems.
 *
 * A system is banned here when a miner (or any routine) is attacked by a
 * dangerous repeater composition (see classifyDangerousRepeaters in
 * routines/common.ts). The ban outlives the routine that triggered it so the
 * miner does not keep jumping back into the same death-trap after a restart.
 *
 * The file is the source of truth and is shared by every process/bot:
 *   data/tempBlacklist.json
 */

const DATA_DIR = join(process.cwd(), "data");
const TEMP_BLACKLIST_FILE = join(DATA_DIR, "tempBlacklist.json");

/** Default ban duration: 6 hours. */
export const MIN_BAN_MS = 6 * 60 * 60 * 1000;

export interface TempBlacklistEntry {
  system: string;
  bannedAt: string;   // ISO
  expiresAt: string;  // ISO (bannedAt + duration)
  reason: string;
  lastEnemy: string;
  battleId: string;
}

interface TempBlacklistFile {
  bannedSystems: Record<string, TempBlacklistEntry>;
  lastUpdated: string;
}

function normalizeSystemId(systemId: string): string {
  return (systemId || "").trim().toLowerCase();
}

function blankFile(): TempBlacklistFile {
  return { bannedSystems: {}, lastUpdated: new Date().toISOString() };
}

/** Read the file from disk. Cached in-memory after first read. */
let cache: TempBlacklistFile | null = null;

function load(): TempBlacklistFile {
  if (cache) return cache;
  try {
    if (existsSync(TEMP_BLACKLIST_FILE)) {
      const parsed = JSON.parse(readFileSync(TEMP_BLACKLIST_FILE, "utf-8")) as TempBlacklistFile;
      if (!parsed || typeof parsed !== "object" || !parsed.bannedSystems) {
        cache = blankFile();
      } else {
        cache = parsed;
      }
    } else {
      cache = blankFile();
    }
  } catch (err) {
    console.warn(`[TempBlacklist] corrupt tempBlacklist.json, starting fresh —`, err);
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
    const ok = safeWriteFileSync(TEMP_BLACKLIST_FILE, payload, Buffer.byteLength(payload, "utf-8"));
    if (!ok) writeFileSync(TEMP_BLACKLIST_FILE, payload, "utf-8");
  } catch (err) {
    console.error(`[TempBlacklist] Failed to write tempBlacklist.json:`, err);
  }
}

/** Drop expired entries (in memory + on disk if anything changed). */
function pruneExpired(now: number): boolean {
  const data = load();
  let changed = false;
  for (const [key, entry] of Object.entries(data.bannedSystems)) {
    const exp = Date.parse(entry.expiresAt);
    if (!Number.isFinite(exp) || exp <= now) {
      delete data.bannedSystems[key];
      changed = true;
    }
  }
  if (changed) persist();
  return changed;
}

/**
 * Ban a system for `durationMs` (default 6h). Idempotent: re-banning extends
 * the expiry to the later of the existing and new expiry, never duplicates.
 */
export function addTempBlacklistSystem(
  systemId: string,
  opts: { reason: string; lastEnemy?: string; battleId?: string; durationMs?: number },
): TempBlacklistEntry {
  const data = load();
  const key = normalizeSystemId(systemId);
  const now = Date.now();
  const duration = opts.durationMs ?? MIN_BAN_MS;
  const newExpiry = now + duration;

  const existing = data.bannedSystems[key];
  let expiresAt = newExpiry;
  if (existing) {
    const existingExpiry = Date.parse(existing.expiresAt);
    if (Number.isFinite(existingExpiry) && existingExpiry > newExpiry) {
      expiresAt = existingExpiry;
    }
  }

  const entry: TempBlacklistEntry = {
    system: key,
    bannedAt: existing?.bannedAt ?? new Date(now).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    reason: opts.reason,
    lastEnemy: opts.lastEnemy ?? existing?.lastEnemy ?? "",
    battleId: opts.battleId ?? existing?.battleId ?? "",
  };
  data.bannedSystems[key] = entry;
  persist();
  return entry;
}

/** True if the system is currently temp-blacklisted (expired entries pruned). */
export function isTempBlacklisted(systemId: string, now: number = Date.now()): boolean {
  const key = normalizeSystemId(systemId);
  if (!key) return false;
  const data = load();
  const entry = data.bannedSystems[key];
  if (!entry) return false;
  const exp = Date.parse(entry.expiresAt);
  if (!Number.isFinite(exp) || exp <= now) {
    // Lazily clean up the single expired entry.
    delete data.bannedSystems[key];
    persist();
    return false;
  }
  return true;
}

/** Currently-active banned systemIds (expired pruned). */
export function getTempBlacklist(now: number = Date.now()): string[] {
  pruneExpired(now);
  const data = load();
  return Object.values(data.bannedSystems).map((e) => e.system);
}

/** All active entries (expired pruned), for UI/inspection. */
export function getTempBlacklistEntries(now: number = Date.now()): TempBlacklistEntry[] {
  pruneExpired(now);
  return Object.values(load().bannedSystems);
}

/** Remove a specific system's ban (manual clear). */
export function removeTempBlacklistSystem(systemId: string): boolean {
  const key = normalizeSystemId(systemId);
  const data = load();
  if (!data.bannedSystems[key]) return false;
  delete data.bannedSystems[key];
  persist();
  return true;
}

/** Force a reload from disk (e.g. after another process wrote the file). */
export function reloadTempBlacklist(): void {
  cache = null;
  load();
}

process.on("exit", () => {
  try {
    pruneExpired(Date.now());
  } catch {
  }
});