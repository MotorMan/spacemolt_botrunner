import { SpacemoltClient, type Account, type ClerkPlayer } from "@spacemolt/lib";

/**
 * One `SpacemoltClient` per Clerk API key. A single Clerk key can own many
 * player accounts (managed by one client), but bots from a *different* Clerk
 * account need a *second* key — and therefore a second client. We keep a map
 * keyed by the raw API key so every owned account connects through the client
 * that actually owns it.
 */
const clients = new Map<string, SpacemoltClient>();

/**
 * Effectively-disable the library's arbitrary per-request timeout.
 *
 * By default `@spacemolt/lib` rejects a query (e.g. `get_ship`) or a mutation's
 * initial ack after `queryTimeoutMs` (15s), surfacing as
 * "No response to spacemolt/<cmd> within 15000ms" and killing the routine — even
 * though the socket is still perfectly alive and the server is just busy. We
 * don't want a fixed wall-clock deadline: the library already rejects every
 * in-flight request the instant the socket actually closes
 * (`handleClose` → `correlator.rejectAll`), so a real disconnect still fails
 * fast. Only a genuinely hung-but-open socket would wait, which is the correct
 * behavior. Node's `setTimeout` overflows (and fires immediately) past the
 * 32-bit signed ceiling, so we use that maximum as "never" rather than Infinity.
 */
const NO_REQUEST_TIMEOUT_MS = 2_147_483_647; // ~24.8 days; Node setTimeout max

/**
 * Initialize (or fetch) the client for a single Clerk API key. Idempotent: if
 * a client already exists for the same key, the existing instance is returned
 * and NOT recreated. Recreating the client tears down its underlying transport
 * socket, which would instantly disconnect every already-live bot (their
 * `Account` objects belong to the old client) — surfacing as "cannot send on a
 * closed socket" for all running bots and `mutation_timeout` for the
 * newly-issued commands. The dashboard's "Add Bots" / "List Players" flows
 * call this while other bots are already connected, so recreating here was the
 * root cause of those mass-disconnect and timeout storms. A new client is only
 * built when a previously-unseen key is supplied.
 *
 * Migration anchor (see plans/1783739200000-spacemolt-lib-api-migration.md):
 * this replaces the hand-rolled HTTP layer in `api.ts` / `session.ts`.
 */
export function initSpacemoltClient(clerkApiKey: string): SpacemoltClient {
  const existing = clients.get(clerkApiKey);
  if (existing) return existing;
  const client = new SpacemoltClient({ clerkApiKey, queryTimeoutMs: NO_REQUEST_TIMEOUT_MS });
  clients.set(clerkApiKey, client);
  return client;
}

/**
 * Initialize clients for every non-empty Clerk API key (e.g. the primary key
 * plus a second key from another account), preserving the supplied order.
 * Returns one client per key; safe to call repeatedly.
 */
export function initSpacemoltClients(clerkApiKeys: string[]): SpacemoltClient[] {
  const result: SpacemoltClient[] = [];
  for (const key of clerkApiKeys) {
    if (key) result.push(initSpacemoltClient(key));
  }
  return result;
}

/** All currently-initialized clients, in insertion order. */
export function getSpacemoltClients(): SpacemoltClient[] {
  return [...clients.values()];
}

/** Raw API keys of all initialized clients, in insertion order. */
export function getSpacemoltClientKeys(): string[] {
  return [...clients.keys()];
}

/**
 * The active multi-account client. Lazily initializes from
 * `SPACEMOLT_CLERK_API_KEY` for backward compatibility (CLI / catalog fetch),
 * but callers that want the dashboard-supplied key should call
 * `initSpacemoltClients(keys)` first. Throws if no key is available.
 *
 * When more than one key is configured (bots from multiple accounts), the
 * first-initialized client is returned — fine for tasks like catalog fetching
 * that are account-agnostic.
 */
export function getSpacemoltClient(): SpacemoltClient {
  const envKey = process.env.SPACEMOLT_CLERK_API_KEY;
  if (envKey && clients.has(envKey)) return clients.get(envKey)!;
  const first = getSpacemoltClients()[0];
  if (first) return first;
  if (envKey) {
    return initSpacemoltClient(envKey);
  }
  throw new Error(
    "SpacemoltClient not initialized — set SPACEMOLT_CLERK_API_KEY or supply a Clerk API key via Settings → General.",
  );
}

/** True once at least one client has been initialized. */
export function hasSpacemoltClient(): boolean {
  return clients.size > 0;
}

/**
 * List the player accounts owned across all configured Clerk keys (requires at
 * least one client to be initialized). Use this to let the user pick which
 * players to add as bots — a single account can own hundreds, and a second key
 * adds yet more. Player ids are unique across accounts, so callers can treat
 * the merged list as one set.
 */
export async function listOwnedPlayers(): Promise<ClerkPlayer[]> {
  const all = getSpacemoltClients();
  if (!all.length) {
    throw new Error("SpacemoltClient not initialized — set the Clerk API key first.");
  }
  const results = await Promise.all(all.map((c) => c.listOwnedPlayers()));
  return results.flat();
}

/** A group of owned players belonging to a single Clerk API key. */
export interface ClerkPlayerGroup {
  /** 0-based index of the Clerk API key (initialization order). */
  keyIndex: number;
  /** Human-readable label for the key (masked) for the dashboard. */
  keyLabel: string;
  /** Players owned by this key's account. */
  players: ClerkPlayer[];
}

/**
 * Like `listOwnedPlayers` but grouped per Clerk API key, so the dashboard can
 * show each account's owned players in a separate, independently-scrollable and
 * filterable list (a single account can own hundreds). Each group is keyed by
 * the client that owns it; `connectOwnedAccounts` still fans out across every
 * client, so selection and connection keep working against the merged set.
 */
export async function listOwnedPlayersByKey(): Promise<ClerkPlayerGroup[]> {
  const entries = [...clients.entries()];
  if (!entries.length) {
    throw new Error("SpacemoltClient not initialized — set the Clerk API key first.");
  }
  const results = await Promise.all(entries.map(([, c]) => c.listOwnedPlayers()));
  return entries.map(([key], i) => ({
    keyIndex: i,
    keyLabel: maskClerkKey(key),
    players: results[i],
  }));
}

/** Mask a Clerk API key for display (keep a prefix + suffix, hide the middle). */
function maskClerkKey(key: string): string {
  if (!key) return "(no key)";
  if (key.length <= 10) return key;
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

/**
 * Connect the owned accounts selected by `filter` (staggered + rate-limited by
 * the library). Each connected `Account` becomes the backing for one `Bot`
 * via the `onConnect` callback. Pass a filter to avoid connecting every owned
 * player (a Clerk account can own hundreds, and a second key adds more).
 *
 * Runs across every initialized client so a player from any configured key is
 * connected; each client only yields the accounts it actually owns.
 */
export async function connectOwnedAccounts(
  filter?: (player: ClerkPlayer) => boolean,
  onConnect?: (account: Account) => void,
): Promise<Account[]> {
  const all = getSpacemoltClients();
  if (!all.length) {
    throw new Error("SpacemoltClient not initialized — set the Clerk API key first.");
  }
  const results = await Promise.all(
    all.map((c) => c.connectOwned({ filter, onConnect })),
  );
  return results.flat();
}

/** All currently-connected library accounts across every initialized client. */
export function getConnectedAccounts(): Account[] {
  return getSpacemoltClients().flatMap((c) => c.accounts());
}

/** Look up a connected library account by its managed id (username), across all clients. */
export function getConnectedAccount(id: string): Account | undefined {
  for (const c of getSpacemoltClients()) {
    const acc = c.account(id);
    if (acc) return acc;
  }
  return undefined;
}
