/**
 * Process-level cache for external HTTP fetches.
 * Respects Cache-Control / Expires response headers.
 * Supports ETag / If-None-Match for conditional requests.
 * Falls back to caller-provided TTL when headers are absent.
 */

interface HttpCacheEntry {
  data: unknown;
  expiresAt: number;
  etag?: string;
  lastModified?: string;
}

const cache = new Map<string, HttpCacheEntry>();

/** Parse TTL (ms) from Cache-Control or Expires headers. Returns null if not present. */
function parseCacheTtl(headers: Headers): number | null {
  const cc = headers.get("cache-control");
  if (cc) {
    if (/no-store|no-cache/i.test(cc)) return 0;
    const match = /max-age=(\d+)/i.exec(cc);
    if (match) return parseInt(match[1], 10) * 1000;
  }
  const expires = headers.get("expires");
  if (expires) {
    const ms = new Date(expires).getTime() - Date.now();
    if (!isNaN(ms)) return Math.max(0, ms);
  }
  return null;
}

/**
 * Fetch a URL and cache the JSON response.
 * TTL is taken from the server's Cache-Control/Expires headers when present,
 * otherwise falls back to the provided `fallbackTtlMs`.
 * Uses ETag/If-None-Match for efficient revalidation on stale entries.
 * Throws on HTTP error or network failure.
 */
export async function cachedFetch<T = unknown>(
  url: string,
  fallbackTtlMs: number,
  fetchOptions?: RequestInit,
): Promise<T> {
  const existing = cache.get(url);

  // Fresh hit — return without a network request
  if (existing && Date.now() < existing.expiresAt) {
    return existing.data as T;
  }

  // Build conditional request headers for revalidation
  const condHeaders: Record<string, string> = {};
  if (existing?.etag) condHeaders["If-None-Match"] = existing.etag;
  else if (existing?.lastModified) condHeaders["If-Modified-Since"] = existing.lastModified;

  const init: RequestInit = {
    ...fetchOptions,
    headers: { ...fetchOptions?.headers as Record<string, string>, ...condHeaders },
  };

  const resp = await fetch(url, init);

  // 304 Not Modified — cached data is still valid; refresh TTL
  if (resp.status === 304 && existing) {
    const serverTtl = parseCacheTtl(resp.headers);
    const ttl = serverTtl ?? fallbackTtlMs;
    cache.set(url, { ...existing, expiresAt: Date.now() + ttl });
    return existing.data as T;
  }

  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);

  const data = (await resp.json()) as T;
  const serverTtl = parseCacheTtl(resp.headers);
  const ttl = serverTtl ?? fallbackTtlMs;

  cache.set(url, {
    data,
    expiresAt: Date.now() + ttl,
    etag: resp.headers.get("etag") ?? undefined,
    lastModified: resp.headers.get("last-modified") ?? undefined,
  });

  return data;
}
