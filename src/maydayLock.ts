// ── Cross-process MAYDAY claim lock ─────────────────────────
/**
 * Ensures that ONLY ONE rescue bot across all running bot processes ever
 * launches a response to a given MAYDAY distress call.
 *
 * The rescue routines coordinate MAYDAY handling via `rescueActivity.json`,
 * but the active rescue session is only written AFTER a bot has finished
 * validating the MAYDAY (route checks, jump limits, etc.). That leaves a
 * race window where two bots can both pass validation and both fly out.
 *
 * This module closes that window with an atomic, per-MAYDAY claim file:
 * whichever bot successfully creates the lock file owns the MAYDAY. The
 * other bot detects the lock and yields immediately, so the two bots can
 * cooperate on *different* MAYDAYs instead of both going out to the same one.
 *
 * The lock auto-expires (TTL) so a bot that crashes mid-rescue does not
 * permanently block the distress call.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, openSync, closeSync, mkdirSync } from "fs";
import { join } from "path";

const LOCK_DIR = join(process.cwd(), "data", "mayday_locks");
const LOCK_TTL_MS = 2 * 60 * 1000; // 2 minutes

interface LockRecord {
  botName: string;
  claimedAt: number;
}

function keyFor(player: string, system: string, poi?: string): string {
  const normalize = (s: string) => s.toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ").trim();
  return `${normalize(player)}__${normalize(system)}__${normalize(poi || "")}`;
}

function safeName(key: string): string {
  return key.replace(/[^a-z0-9_]/g, "_");
}

function lockPath(key: string): string {
  return join(LOCK_DIR, safeName(key) + ".lock");
}

function ensureDir(): void {
  if (!existsSync(LOCK_DIR)) {
    try {
      mkdirSync(LOCK_DIR, { recursive: true });
    } catch {
      // Another process may have created it concurrently; ignore.
    }
  }
}

/**
 * Attempt to exclusively claim a MAYDAY across all bot processes.
 *
 * Uses an atomic exclusive file create (`wx`) so that if two bots race on
 * the same MAYDAY, exactly one wins and the other gets `false`.
 *
 * Re-entrant: if THIS bot already owns a still-valid lock it returns `true`
 * again, so a bot that loops back (e.g. after fleeing a battle) keeps its
 * claim instead of yielding to its own stale lock.
 *
 * @returns true if this bot now owns the claim (or already did).
 */
export function tryClaimMayday(
  player: string,
  system: string,
  poi: string | undefined,
  botName: string,
): boolean {
  const lp = lockPath(keyFor(player, system, poi));
  ensureDir();

  if (existsSync(lp)) {
    try {
      const rec = JSON.parse(readFileSync(lp, "utf-8")) as LockRecord;
      if (Date.now() - rec.claimedAt < LOCK_TTL_MS) {
        // Still valid: same bot re-claims, another bot must yield.
        return rec.botName === botName;
      }
      // Expired - clear and re-claim below.
      unlinkSync(lp);
    } catch {
      try { unlinkSync(lp); } catch { /* ignore */ }
    }
  }

  try {
    const fd = openSync(lp, "wx"); // Atomic: fails if the file already exists.
    closeSync(fd);
    writeFileSync(lp, JSON.stringify({ botName, claimedAt: Date.now() } as LockRecord));
    return true;
  } catch {
    // EEXIST or other error - another process won the race.
    return false;
  }
}

/**
 * Returns the name of the bot currently holding the claim, or null if none.
 */
export function getMaydayLockHolder(
  player: string,
  system: string,
  poi: string | undefined,
): string | null {
  const lp = lockPath(keyFor(player, system, poi));
  if (!existsSync(lp)) return null;
  try {
    const rec = JSON.parse(readFileSync(lp, "utf-8")) as LockRecord;
    if (Date.now() - rec.claimedAt < LOCK_TTL_MS) {
      return rec.botName;
    }
    unlinkSync(lp);
  } catch {
    try { unlinkSync(lp); } catch { /* ignore */ }
  }
  return null;
}

/**
 * Release a claim. Only releases if it is owned by this bot (or already
 * expired), so a bot never accidentally frees a claim held by its partner.
 */
export function releaseMayday(
  player: string,
  system: string,
  poi: string | undefined,
  botName: string,
): void {
  const lp = lockPath(keyFor(player, system, poi));
  if (!existsSync(lp)) return;
  try {
    const rec = JSON.parse(readFileSync(lp, "utf-8")) as LockRecord;
    if (rec.botName === botName || Date.now() - rec.claimedAt >= LOCK_TTL_MS) {
      unlinkSync(lp);
    }
  } catch {
    try { unlinkSync(lp); } catch { /* ignore */ }
  }
}
