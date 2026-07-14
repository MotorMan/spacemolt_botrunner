import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { dirname, join, normalize, relative } from "path";

/**
 * File-based client sync.
 *
 * Goal: every connected client ends up holding the *combined* data of all
 * clients, as if they were one giant client. The master owns the canonical
 * combined repository (its own `data/` dir, restricted to the synced subset).
 * Clients push their local writes to the master; the master deep-merges them by
 * key into its repo; clients pull the merged repo back so they can see (and
 * act on) every other client's bots/players/data.
 *
 * Sync set:
 *   - every top-level `.json` file in the data dir, EXCEPT an explicit deny list
 *   - the contents of a fixed set of subdirectories, EXCEPT junk files
 *   - never: settings.json, main_logs.json, bot_positions.csv, chat.log, and
 *     non-data junk (Backups/, logs/, *.bak, *.csv, *.jsonl, *.bmp, *.log, …)
 */

/** Top-level files that must NEVER be synced (they're local per-client state). */
export const EXCLUDE_TOPLEVEL = new Set([
  "settings.json",
  "main_logs.json",
  "bot_positions.csv",
  "chat.log",
]);

/** Subdirectories (relative to data dir) whose contents ARE synced. */
export const INCLUDE_SUBDIRS = ["CivTransportLogs", "creatures", "factionStorage", "personalities"];

/** File extensions that are never synced. */
const EXCLUDE_EXT = new Set([".csv", ".jsonl", ".bak", ".bmp", ".log", ".tmp"]);

export interface FileEntry {
  /** Relative path within the data dir, using forward slashes (e.g. `creatures/adhafera.json`). */
  path: string;
  /** mtime in ms. */
  mtime: number;
  /** byte size. */
  size: number;
  /** sha1 of the file content. */
  hash: string;
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i).toLowerCase();
}

export function hashContent(content: string): string {
  return createHash("sha1").update(content, "utf-8").digest("hex");
}

/** True if a relative path belongs to the sync set (path-traversal safe). */
export function isPathSynced(relPath: string): boolean {
  const norm = normalize(relPath).replace(/\\/g, "/");
  if (norm.startsWith(".") || norm.startsWith("/") || norm.includes("..")) return false;
  const parts = norm.split("/").filter((p) => p.length > 0);
  if (parts.length === 0) return false;
  if (parts.length === 1) {
    const name = parts[0];
    if (EXCLUDE_TOPLEVEL.has(name)) return false;
    return extOf(name) === ".json";
  }
  if (!INCLUDE_SUBDIRS.includes(parts[0])) return false;
  // Only descend one level into the included subdirs.
  if (parts.length > 2) return false;
  const name = parts[parts.length - 1];
  return !EXCLUDE_EXT.has(extOf(name));
}

function readFileForHash(absPath: string): { content: string; hash: string; mtime: number; size: number } | null {
  try {
    const st = statSync(absPath);
    if (!st.isFile()) return null;
    const content = readFileSync(absPath, "utf-8");
    return { content, hash: hashContent(content), mtime: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

/** List every file in the sync set under `dataDir`. */
export function listSyncedFiles(dataDir: string): FileEntry[] {
  const out: FileEntry[] = [];
  if (!existsSync(dataDir)) return out;

  // Top-level .json files.
  for (const name of readdirSync(dataDir)) {
    const abs = join(dataDir, name);
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (!st.isFile()) continue;
    if (EXCLUDE_TOPLEVEL.has(name)) continue;
    if (extOf(name) !== ".json") continue;
    const r = readFileForHash(abs);
    if (r) out.push({ path: name, mtime: r.mtime, size: r.size, hash: r.hash });
  }

  // Included subdirectories (one level deep).
  for (const sub of INCLUDE_SUBDIRS) {
    const subAbs = join(dataDir, sub);
    if (!existsSync(subAbs)) continue;
    let entries: string[];
    try { entries = readdirSync(subAbs); } catch { continue; }
    for (const name of entries) {
      const abs = join(subAbs, name);
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (!st.isFile()) continue;
      if (EXCLUDE_EXT.has(extOf(name))) continue;
      const r = readFileForHash(abs);
      if (r) out.push({ path: `${sub}/${name}`, mtime: r.mtime, size: r.size, hash: r.hash });
    }
  }

  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

/**
 * Deep-merge `source` into `target`, returning a NEW value (target untouched).
 * Objects merge by key; arrays merge by index (objects merged, primitives
 * replaced, extras appended); primitives are overwritten by `source`.
 */
export function deepMerge(target: unknown, source: unknown): unknown {
  if (Array.isArray(source)) {
    const out: unknown[] = Array.isArray(target) ? (target as unknown[]).map(clone) : [];
    for (let i = 0; i < source.length; i++) {
      const s = source[i];
      if (i < out.length && isPlainObject(out[i]) && isPlainObject(s)) {
        out[i] = deepMerge(out[i], s);
      } else if (i < out.length) {
        out[i] = clone(s);
      } else {
        out.push(clone(s));
      }
    }
    return out;
  }
  if (isPlainObject(source)) {
    const out: Record<string, unknown> = isPlainObject(target) ? { ...target } : {};
    for (const k of Object.keys(source)) {
      const sv = source[k];
      if (isPlainObject(sv) || Array.isArray(sv)) {
        out[k] = deepMerge(out[k], sv);
      } else {
        out[k] = sv;
      }
    }
    return out;
  }
  return source;
}

function safeParse(content: string): unknown {
  try { return JSON.parse(content); } catch { return undefined; }
}

/**
 * Merge `incoming` JSON content into the file at `relPath` under `dataDir`.
 * If the file does not exist or is invalid JSON, the incoming content becomes
 * the file. Returns the new sha1 hash, or null on error.
 */
export function mergeIntoFile(dataDir: string, relPath: string, incoming: string): string | null {
  if (!isPathSynced(relPath)) return null;
  const abs = join(dataDir, relPath);
  const parsedIncoming = safeParse(incoming);
  if (parsedIncoming === undefined) return null;

  let current: unknown = parsedIncoming;
  if (existsSync(abs)) {
    const existing = readFileForHash(abs);
    if (existing) {
      const parsedExisting = safeParse(existing.content);
      if (parsedExisting !== undefined) {
        current = deepMerge(parsedExisting, parsedIncoming);
      }
    }
  }

  const out = JSON.stringify(current, null, 2) + "\n";
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, out, "utf-8");
  return hashContent(out);
}

/**
 * Write `content` to `relPath` under `dataDir` only if the file does not
 * already exist (initial seeding). Returns the sha1 hash on write, or the
 * existing hash if it was already present, or null on error / not-synced.
 */
export function seedIntoFile(dataDir: string, relPath: string, content: string): string | null {
  if (!isPathSynced(relPath)) return null;
  const abs = join(dataDir, relPath);
  if (existsSync(abs)) {
    const existing = readFileForHash(abs);
    return existing ? existing.hash : null;
  }
  const out = JSON.stringify(safeParse(content) ?? content, null, 2) + "\n";
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, out, "utf-8");
  return hashContent(out);
}

/** Read a synced file's raw content, or null if missing/invalid path. */
export function readSyncedFile(dataDir: string, relPath: string): string | null {
  if (!isPathSynced(relPath)) return null;
  const abs = join(dataDir, relPath);
  const r = readFileForHash(abs);
  return r ? r.content : null;
}

export interface FileUpdatePayload {
  path: string;
  content: string;
  mtime?: number;
}

/**
 * Simple authenticated fetch against a peer (master or slave). Adds the API key
 * and password as headers and JSON-encodes the body. Throws on transport
 * error or non-2xx status so callers can retry on the next cycle.
 */
export async function peerRequest(
  baseUrl: string,
  path: string,
  apiKey: string,
  password: string,
  init?: RequestInit,
  body?: unknown,
): Promise<any> {
  const url = `${baseUrl.replace(/\/+$/, "")}${path}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["X-API-Key"] = apiKey;
  if (password) headers["X-Password"] = password;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {
      ...init,
      headers,
      body: body !== undefined ? JSON.stringify(body) : init?.body,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    const text = await res.text();
    try { return JSON.parse(text); } catch { return text; }
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Like `peerRequest` but returns the raw response text (for file bodies that
 * are themselves JSON and must not be double-parsed by the caller).
 */
export async function peerRequestText(
  baseUrl: string,
  path: string,
  apiKey: string,
  password: string,
  init?: RequestInit,
  body?: unknown,
): Promise<string> {
  const url = `${baseUrl.replace(/\/+$/, "")}${path}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["X-API-Key"] = apiKey;
  if (password) headers["X-Password"] = password;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {
      ...init,
      headers,
      body: body !== undefined ? JSON.stringify(body) : init?.body,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Resolve a relative data-dir path to an absolute, in-bounds path. */
export function resolveDataPath(dataDir: string, relPath: string): string | null {
  if (!isPathSynced(relPath)) return null;
  const abs = normalize(join(dataDir, relPath));
  const rel = relative(dataDir, abs);
  if (rel.startsWith("..") || rel.startsWith("/") || rel.includes("..")) return null;
  return abs;
}
