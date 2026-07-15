/**
 * Connection-loss detection shared by the command dispatch layer (bot.ts) and
 * the travel/retry helpers (routines/common.ts, routines/return_home.ts).
 *
 * When the @spacemolt/lib socket drops (server patch restart, network blip)
 * `account.send` throws a `ConnectionClosedError` whose message is one of the
 * forms below. These errors mean the command was NEVER delivered to the server
 * (the socket was already dead), so it is always safe to retry the exact same
 * command once the socket is back — unlike a genuine server/business error
 * (e.g. "no route", "no fuel cells") which must be surfaced to the routine.
 */

export const CONNECTION_ERROR_PATTERNS =
  /cannot send on a closed socket|closed socket|socket (is )?closed|not connected|web ?socket connection closed|econnreset|econnrefused|disconnected|connection (lost|closed|reset|aborted)|fresh socket|could not establish|multiple attempts|socket after|reconnect.*(failed|gave up)|transport.*(closed|lost)|no live (socket|connection)/i;

/** True when an error message indicates the transport socket is dead. */
export function isConnectionError(message?: string | null): boolean {
  if (!message) return false;
  return CONNECTION_ERROR_PATTERNS.test(message);
}
