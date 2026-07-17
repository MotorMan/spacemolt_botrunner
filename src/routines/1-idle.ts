/**
 * Anti-Idle routine — keeps a bot's session alive by issuing lightweight
 * activity at a fixed interval.
 *
 * Every 30 seconds it performs a get_nearby (to keep the connection active)
 * and refreshes the bot's cargo + location so its dashboard/status stays
 * current. It takes no game actions and never moves the ship, so it is safe to
 * leave running on any idle bot.
 */
import type { Routine, RoutineContext } from "../bot.js";

const IDLE_INTERVAL_MS = 30_000;

export const idleRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  while (bot.state === "running") {
    yield "anti_idle";

    // Stop may have been requested while we were awaiting the previous cycle
    // (the sleep resolves immediately on "stopping"). Bail out before doing any
    // more work so Stop is processed the instant it's pressed.
    if (bot.state !== "running") break;

    // get_nearby: cheap activity to keep the session from going idle/timed out.
    // Abort-safe: if Stop cancels this in-flight command, treat it as a clean
    // exit rather than surfacing as a routine error.
    const nearbyResp = await bot.exec("get_nearby", {}).catch((err: unknown) => {
      if (bot.state !== "running") return null;
      ctx.log("warn", `Anti-idle get_nearby failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
    if (nearbyResp) {
      if (nearbyResp.error) {
        ctx.log("warn", `Anti-idle get_nearby failed: ${nearbyResp.error.message}`);
      } else {
        ctx.log("system", "Anti-idle ping (get_nearby) sent");
      }
    }

    // Refresh cargo + location so the bot's status stays up to date.
    await bot.refreshCargo().catch(() => {
      ctx.log("warn", "Anti-idle cargo refresh failed");
    });
    await bot.refreshLocation().catch(() => {
      ctx.log("warn", "Anti-idle location refresh failed");
    });

    await ctx.sleep(IDLE_INTERVAL_MS);
  }
};
