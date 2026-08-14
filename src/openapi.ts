import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

/** Live V2 OpenAPI spec URL. */
export const OPENAPI_V2_URL = "https://game.spacemolt.com/api/v2/openapi.json";

/**
 * Minimum spacing between network requests. The gameserver allows roughly one
 * spec download per minute and blocks (HTTP 429) any extra attempts, so we
 * never issue a second request inside this window.
 */
export const OPENAPI_MIN_INTERVAL_MS = 60_000;

/** Process-wide state so every caller shares one download cadence. */
let lastSpec: any = null;
let lastEtag: string | undefined;
let lastFetchAt = 0;
let inFlight: Promise<OpenApiFetchResult> | null = null;

export interface OpenApiSpecMeta {
  /** `info.version`, e.g. "2.0.0". */
  apiVersion: string;
  /** Major API version derived from `info.version`, e.g. "2". */
  apiMajor: string;
  /** `info.x-gameserver-version` without a leading "v", e.g. "0.501.0". */
  gameServerVersion: string;
  /** Versioned filename, e.g. "openapi-V2-V0.501.0.json". */
  fileName: string;
}

/**
 * Derive the versioned filename from a parsed OpenAPI spec.
 * Uses `info.version` for the API major and `info.x-gameserver-version`
 * for the gameserver version, matching `openapi-V2-V0.501.0.json`.
 */
export function deriveOpenApiMeta(spec: any): OpenApiSpecMeta {
  const info = spec?.info ?? {};
  const apiVersion = info.version != null ? String(info.version) : "2.0.0";
  const apiMajor = apiVersion.split(".")[0] || "2";
  const gsRaw = info["x-gameserver-version"];
  const gameServerVersion = gsRaw != null ? String(gsRaw).replace(/^v/i, "") : "unknown";
  const fileName = `openapi-V${apiMajor}-V${gameServerVersion}.json`;
  return { apiVersion, apiMajor, gameServerVersion, fileName };
}

export interface OpenApiFetchResult {
  spec: any;
  /** ETag returned by the server (if any). */
  etag?: string;
  /** true when the server returned a fresh body (200); false on 304 / throttle / 429-reuse. */
  changed: boolean;
  /** true when a network request was skipped because we fetched within OPENAPI_MIN_INTERVAL_MS. */
  throttled: boolean;
  /** HTTP status, or 0 when no request was made (throttled). */
  status: number;
}

/**
 * Fetch the V2 OpenAPI spec, honouring change detection and the per-minute
 * rate limit:
 *  - Sends `If-None-Match: <last etag>`; the server replies `304 Not Modified`
 *    when the spec is unchanged (no body re-downloaded).
 *  - Skips the network entirely when called again within OPENAPI_MIN_INTERVAL_MS,
 *    reusing the in-memory spec. Concurrent callers share a single in-flight request.
 *  - On `429` (rate limited) it reuses the cached or persisted spec instead of failing.
 */
export async function fetchOpenApiV2Spec(opts?: { force?: boolean; destDir?: string }): Promise<OpenApiFetchResult> {
  const force = opts?.force ?? false;
  const now = Date.now();

  // Reuse an in-progress request so concurrent callers issue only one download.
  if (inFlight && !force) return inFlight;

  // Throttle: within the rate-limit window, serve the cached spec without a request.
  if (!force && lastSpec !== null && now - lastFetchAt < OPENAPI_MIN_INTERVAL_MS) {
    return { spec: lastSpec, etag: lastEtag, changed: false, throttled: true, status: 0 };
  }

  const headers: Record<string, string> = {};
  if (lastEtag) headers["If-None-Match"] = lastEtag;

  const run = (async (): Promise<OpenApiFetchResult> => {
    let resp: Response;
    try {
      resp = await fetch(OPENAPI_V2_URL, { headers, signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      const fallback = lastSpec ?? (opts?.destDir ? loadLatestOpenApiV2Spec(opts.destDir) : null);
      if (fallback) return { spec: fallback, etag: lastEtag, changed: false, throttled: true, status: 0 };
      throw err;
    }
    lastFetchAt = Date.now();

    // Unchanged — server compared our ETag and found no diff.
    if (resp.status === 304) {
      return { spec: lastSpec, etag: lastEtag, changed: false, throttled: false, status: 304 };
    }

    // Rate limited — reuse cached/persisted spec rather than failing.
    if (resp.status === 429) {
      const fallback = lastSpec ?? (opts?.destDir ? loadLatestOpenApiV2Spec(opts.destDir) : null);
      if (fallback) return { spec: fallback, etag: lastEtag, changed: false, throttled: true, status: 429 };
      throw new Error(`GET ${OPENAPI_V2_URL} -> 429 (rate limited) and no cached spec available`);
    }

    if (!resp.ok) throw new Error(`GET ${OPENAPI_V2_URL} -> ${resp.status} ${resp.statusText}`);

    const spec = await resp.json();
    lastEtag = resp.headers.get("etag") ?? undefined;
    lastSpec = spec;
    return { spec, etag: lastEtag, changed: true, throttled: false, status: 200 };
  })();

  inFlight = run;
  run.finally(() => { inFlight = null; }).catch(() => { /* surfaced to caller */ });
  return run;
}

/** Load the most recently saved versioned V2 spec from disk, or null if none. */
export function loadLatestOpenApiV2Spec(destDir: string = process.cwd()): any | null {
  if (!existsSync(destDir)) return null;
  const files = readdirSync(destDir)
    .filter((f) => /^openapi-V2-V.*\.json$/.test(f))
    .sort();
  if (files.length === 0) return null;
  try {
    return JSON.parse(readFileSync(join(destDir, files[files.length - 1]), "utf8"));
  } catch {
    return null;
  }
}

export interface SavedOpenApiSpec {
  meta: OpenApiSpecMeta;
  path: string;
  /** false when a file with this version already existed (skipped write). */
  saved: boolean;
}

/**
 * Persist a V2 OpenAPI spec under its versioned filename. Idempotent: if a file
 * with the same version already exists it is left untouched and `saved` is false.
 */
export function saveOpenApiV2Spec(spec: any, destDir: string = process.cwd()): SavedOpenApiSpec {
  const meta = deriveOpenApiMeta(spec);
  const filePath = join(destDir, meta.fileName);
  let saved = false;
  if (!existsSync(filePath)) {
    mkdirSync(destDir, { recursive: true });
    writeFileSync(filePath, JSON.stringify(spec, null, 2));
    saved = true;
  }
  return { meta, path: filePath, saved };
}

export interface RefreshedOpenApiSpec extends SavedOpenApiSpec {
  spec: any;
  changed: boolean;
  throttled: boolean;
  status: number;
  etag?: string;
}

/** Fetch the V2 spec (with change detection + rate-limit handling) and persist it. */
export async function refreshOpenApiV2Spec(destDir: string = process.cwd(), force = false): Promise<RefreshedOpenApiSpec> {
  const { spec, etag, changed, throttled, status } = await fetchOpenApiV2Spec({ force, destDir });
  const saved = saveOpenApiV2Spec(spec, destDir);
  return { spec, ...saved, changed, throttled, status, etag };
}
