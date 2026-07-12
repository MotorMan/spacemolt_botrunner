import { SpacemoltClient, type Account, type ClerkPlayer } from "@spacemolt/lib";

let clientSingleton: SpacemoltClient | null = null;
let clientKey: string | null = null;

/**
 * (Re)create the single multi-account `SpacemoltClient` for the whole runner,
 * backed by the given Clerk API key. Call this once the key is known (from the
 * env var `SPACEMOLT_CLERK_API_KEY` or the dashboard's Settings → General →
 * Clerk API Key field) before connecting owned accounts.
 *
 * Migration anchor (see plans/1783739200000-spacemolt-lib-api-migration.md):
 * this replaces the hand-rolled HTTP layer in `api.ts` / `session.ts`.
 *
 * IMPORTANT: this is idempotent with respect to the Clerk key. If a client
 * already exists for the same key, the existing instance is returned and NOT
 * recreated. Recreating the client tears down its underlying transport socket,
 * which would instantly disconnect every already-live bot (their `Account`
 * objects belong to the old client) — surfacing as "cannot send on a closed
 * socket" for all running bots and `mutation_timeout` for the newly-issued
 * commands. The dashboard's "Add Bots" / "List Players" flows call this while
 * other bots are already connected, so recreating here was the root cause of
 * those mass-disconnect and timeout storms. A new client is only built when
 * the key actually changes.
 */
export function initSpacemoltClient(clerkApiKey: string): SpacemoltClient {
  if (clientSingleton && clientKey === clerkApiKey) {
    return clientSingleton;
  }
  clientSingleton = new SpacemoltClient({ clerkApiKey });
  clientKey = clerkApiKey;
  return clientSingleton;
}

/**
 * The active multi-account client. Lazily initializes from
 * `SPACEMOLT_CLERK_API_KEY` for backward compatibility (CLI / catalog fetch),
 * but callers that want the dashboard-supplied key should call
 * `initSpacemoltClient(key)` first. Throws if no key is available.
 */
export function getSpacemoltClient(): SpacemoltClient {
  if (!clientSingleton) {
    const envKey = process.env.SPACEMOLT_CLERK_API_KEY;
    if (envKey) {
      clientSingleton = new SpacemoltClient({ clerkApiKey: envKey });
      clientKey = envKey;
    } else {
      throw new Error(
        "SpacemoltClient not initialized — set SPACEMOLT_CLERK_API_KEY or supply a Clerk API key via Settings → General.",
      );
    }
  }
  return clientSingleton;
}

/** True once a client has been initialized. */
export function hasSpacemoltClient(): boolean {
  return clientSingleton !== null;
}

/**
 * List the player accounts the Clerk user owns (requires the client to be
 * initialized with a Clerk API key). Use this to let the user pick which
 * players to add as bots — a single account can own hundreds.
 */
export async function listOwnedPlayers(): Promise<ClerkPlayer[]> {
  if (!clientSingleton) {
    throw new Error("SpacemoltClient not initialized — set the Clerk API key first.");
  }
  return clientSingleton.listOwnedPlayers();
}

/**
 * Connect the owned accounts selected by `filter` (staggered + rate-limited by
 * the library). Each connected `Account` becomes the backing for one `Bot`
 * via the `onConnect` callback. Pass a filter to avoid connecting every owned
 * player (a Clerk account can own hundreds).
 */
export async function connectOwnedAccounts(
  filter?: (player: ClerkPlayer) => boolean,
  onConnect?: (account: Account) => void,
): Promise<Account[]> {
  if (!clientSingleton) {
    throw new Error("SpacemoltClient not initialized — set the Clerk API key first.");
  }
  return clientSingleton.connectOwned({ filter, onConnect });
}

/** All currently-connected library accounts. */
export function getConnectedAccounts(): Account[] {
  return clientSingleton?.accounts() ?? [];
}

/** Look up a connected library account by its managed id (username). */
export function getConnectedAccount(id: string): Account | undefined {
  return clientSingleton?.account(id);
}
