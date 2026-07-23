/**
 * Anti-Idle routine — keeps a bot's session alive by issuing lightweight
 * activity at a fixed interval.
 *
 * Every 30 seconds it performs a get_nearby (to keep the connection active)
 * and refreshes the bot's cargo + location so its dashboard/status stays
> current. It takes no game actions and never moves the ship, so it is safe to
> leave running on any idle bot.
 *
 * Additionally, this routine subscribes to passive observation to receive live
 * updates about nearby objects, system agents, and signatures. It resubscribes
 * whenever the bot's location (system/POI) changes.
 */
import type { Routine, RoutineContext } from "../bot.js";

const IDLE_INTERVAL_MS = 30_000;

export const idleRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  // Track observation subscription state
  let observationUnsub: (() => void) | null = null;
  let lastObservationPoiId: string = bot.poi;
  let lastObservationSystemId: string = bot.system;

  // Define the observation handler
  const handleObservation = (payload: any) => {
     ctx.log('info', 'Observation update received');
     ctx.log('info', `Payload type: ${typeof payload}`);
     if (typeof payload === 'object' && payload !== null) {
       const payloadStr = JSON.stringify(payload).toLowerCase();
       ctx.log('info', `Payload keys: ${Object.keys(payload).join(', ')}`);
       ctx.log('info', `Payload: ${payloadStr.substring(0, 200)}${payloadStr.length > 200 ? '...' : ''}`);
       if (payloadStr.includes('pirate')) {
         ctx.log('info', '🚨 PIRATE DETECTED! 🚨');
         ctx.log('info', `Full payload: ${JSON.stringify(payload)}`);
       }
     } else {
       ctx.log('info', `Payload: ${payload}`);
     }
   };
// Set up listener for observation updates BEFORE subscribing so we catch initial update
   if (bot.account) {
     // Set up listener for observation updates
     // @ts-ignore: account.on exists
     const off = bot.account.on("observation_update", handleObservation);
     observationUnsub = off;
     ctx.log("info", "Listening for observation updates");
     
     try {
       await bot.subscribeToObservation(false);
       ctx.log("info", "Subscribed to observation (passive)");
     } catch (err) {
       ctx.log("error", `Failed to subscribe to observation: ${err}`);
     }
   } else {
     ctx.log("warn", "Bot account not available, skipping observation subscription");
   }

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
    if (nearbyResp && nearbyResp.error) {
      ctx.log("warn", `Anti-idle get_nearby failed: ${nearbyResp.error.message}`);
    }

    // Refresh cargo + location so the bot's status stays up to date.
    await bot.refreshCargo().catch(() => {
      ctx.log("warn", "Anti-idle cargo refresh failed");
    });
    await bot.refreshLocation().catch(() => {
      ctx.log("warn", "Anti-idle location refresh failed");
    });

    // Check if location (system/POI) has changed since last observation subscription
    if (
      bot.poi !== lastObservationPoiId ||
      bot.system !== lastObservationSystemId
    ) {
      ctx.log("info", `Location changed from ${lastObservationSystemId}/${lastObservationPoiId} to ${bot.system}/${bot.poi}`);

      // Clean up existing observation subscription
      if (observationUnsub) {
        try {
          observationUnsub();
          ctx.log("info", "Unsubscribed from observation updates due to location change");
        } catch (err) {
          ctx.log("error", `Error unsubscribing from observation updates: ${err}`);
        }
        observationUnsub = null;
      }

      // Attempt to resubscribe to observation for new location
      if (bot.account) {
        try {
await bot.subscribeToObservation(false);
           ctx.log("info", `Subscribed to observation (passive) for new location: ${bot.system}/${bot.poi}`);

          // Set up listener for observation updates
          // @ts-ignore: account.on exists
          const off = bot.account.on("observation_update", handleObservation);
          observationUnsub = off;
          ctx.log("info", "Listening for observation updates");

          // Update last known location
          lastObservationPoiId = bot.poi;
          lastObservationSystemId = bot.system;
        } catch (err) {
          ctx.log("error", `Failed to subscribe to observation for new location: ${err}`);
        }
      } else {
        ctx.log("warn", "Bot account not available, skipping observation resubscription");
      }
    }

    await ctx.sleep(IDLE_INTERVAL_MS);
  }

  // Clean up observation subscription on routine exit
  if (observationUnsub) {
    try {
      observationUnsub();
      ctx.log("info", "Unsubscribed from observation updates");
    } catch (err) {
      ctx.log("error", `Error unsubscribing from observation updates: ${err}`);
    }
  }
};
