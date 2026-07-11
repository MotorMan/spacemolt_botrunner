import { SpacemoltClient, type Account, type ClerkPlayer } from "@spacemolt/lib";

let clientSingleton: SpacemoltClient | null = null;

/**
 * Lazily create (and reuse) the single multi-account `SpacemoltClient` for the
 * whole runner. Backed by `SPACEMOLT_CLERK_API_KEY` so `connectOwned()` can
 * connect every owned account without per-bot passwords on disk.
 *
 * Migration anchor (see plans/1783739200000-spacemolt-lib-api-migration.md):
 * this replaces the hand-rolled HTTP layer in `api.ts` / `session.ts`.
 */
export function getSpacemoltClient(): SpacemoltClient {
  if (!clientSingleton) {
    clientSingleton = new SpacemoltClient({
      clerkApiKey: process.env.SPACEMOLT_CLERK_API_KEY,
    });
  }
  return clientSingleton;
}

/**
 * Connect every account owned by the Clerk user (staggered + rate-limited by
 * the library). Each connected `Account` becomes the backing for one `Bot`.
 */
export async function connectOwnedAccounts(
  filter?: (player: ClerkPlayer) => boolean,
  onConnect?: (account: Account) => void,
): Promise<Account[]> {
  return getSpacemoltClient().connectOwned({ filter, onConnect });
}

/** All currently-connected library accounts. */
export function getConnectedAccounts(): Account[] {
  return getSpacemoltClient().accounts();
}

/** Look up a connected library account by its managed id (username). */
export function getConnectedAccount(id: string): Account | undefined {
  return getSpacemoltClient().account(id);
}
