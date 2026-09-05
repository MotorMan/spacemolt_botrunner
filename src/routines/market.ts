import type { Routine, RoutineContext } from "../bot.js";
import { perf } from "../perf.js";
import { marketStreamStore } from "../marketstreamstore.js";
import { mapStore } from "../mapstore.js";
import {
  noteMarketRoutineActive,
  noteMarketRoutineStopped,
  noteLocalMarketObservation,
} from "../market_local_source.js";
import { marketDetailsStore, type MarketOrderDetail } from "../marketdetailsstore.js";
import { updateShipListings } from "../shipsforsale.js";

function saveItemsToMarketDetails(
  systemId: string,
  stationPoiId: string,
  stationName: string,
  items: Array<Record<string, unknown>>,
): void {
  // In-memory upsert only. `marketDetailsStore` persists the whole file on a
  // 2-minute cadence (and on shutdown) instead of rewriting ~10MB per push,
  // which was ~17 full rewrites a minute on a market client.
  const observations = perf.timeSync("market.saveItemsToMarketDetails", () => {
    const obs: Array<{
      itemId: string;
      itemName: string;
      buyOrders: MarketOrderDetail[];
      sellOrders: MarketOrderDetail[];
    }> = [];

    for (const item of items) {
      const itemId = (item.item_id as string) || (item.id as string) || "";
      const itemName = (item.name as string) || (item.item_name as string) || itemId;
      if (!itemId) continue;

      const buyOrders = ((item.buy_orders as Array<Record<string, unknown>>) || []).map((order) => ({
        price: (order.price_each as number) || (order.price as number) || 0,
        quantity: (order.quantity as number) || 0,
      })).filter((order) => order.price > 0 && order.quantity > 0);

      const sellOrders = ((item.sell_orders as Array<Record<string, unknown>>) || []).map((order) => ({
        price: (order.price_each as number) || (order.price as number) || 0,
        quantity: (order.quantity as number) || 0,
      })).filter((order) => order.price > 0 && order.quantity > 0);

      obs.push({ itemId, itemName, buyOrders, sellOrders });
    }

    if (obs.length) {
      marketDetailsStore.upsertItems(systemId, stationPoiId, stationName, obs);
    }
    return obs;
  });

  // Publish to the in-memory overlay too, so routines in this process see
  // these prices immediately instead of waiting for the (throttled) re-parse
  // of the 10MB marketDetails.json.
  if (observations.length) {
    noteLocalMarketObservation(systemId, stationPoiId, stationName, observations);
  }
}

export const marketRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;
  let lastBaseId: string | null = null;
  let currentBaseId: string | null = null;
  let marketUpdateCb: ((entry: import("../marketstreamstore.js").MarketStreamEntry | null) => void) | null = null;
  let lastShipBrowseAt = 0;
  const SHIP_BROWSE_INTERVAL_MS = 10 * 60 * 1000;

  // Observation subscription: collect the player/pirate/empire-NPC data this bot
  // sees at every station (same intent as the get_nearby feed, but via the live
  // observation change-feed so we don't have to poll). The feed is pushed into
  // the shared player tracker (playerNameStore) via trackNearbyPlayers, exactly
  // like the get_nearby result handled in botmanager.ts.
  let observationUnsub: (() => void) | null = null;

  // Advertise that THIS client produces its own market data. Traders running in
  // this same client then read data/marketDetails.json directly instead of
  // calling out to a remote market client that may not even exist.
  noteMarketRoutineActive(bot.username);

  function unsubscribeMarketUpdates() {
    if (currentBaseId && marketUpdateCb) {
      marketStreamStore.unsubscribe(currentBaseId, marketUpdateCb);
    }
    marketUpdateCb = null;
  }

  function subscribeMarketUpdates(baseId: string, systemId: string, poiId: string, stationName: string) {
    unsubscribeMarketUpdates();
    const cb = (entry: import("../marketstreamstore.js").MarketStreamEntry | null) => {
      if (!entry || !entry.items.length) return;
      try {
        // Record against the POI we are actually docked at, captured at
        // subscribe time. Using `baseId` as the station POI id (as this used to)
        // wrote entries under an id that does not exist in the galaxy map for
        // every station whose base id differs from its POI id (e.g. Sol Central
        // / confederacy_central_command), producing market rows no routine
        // could ever travel to.
        saveItemsToMarketDetails(systemId, poiId, stationName, entry.items as Array<Record<string, unknown>>);
      } catch {
        /* ignore marketDetails errors from push updates */
      }
    };
    marketUpdateCb = cb;
    marketStreamStore.subscribe(baseId, cb);
  }

  // Remove our observation_update listener (the server watch itself ends
  // automatically on travel/jump, so we only tear down our local hook here).
  function unsubscribeObservation() {
    if (observationUnsub) {
      try {
        observationUnsub();
      } catch {
        /* ignore */
      }
      observationUnsub = null;
    }
  }

  // Subscribe to the live observation feed for the station we are docked at and
  // push every update (plus the initial baseline snapshot) into the shared
  // player tracker, the same way get_nearby results are handled downstream.
  async function subscribeObservation() {
    unsubscribeObservation();
    if (!bot.account) {
      ctx.log("warn", "Observation subscription skipped: no account handle (player tracking disabled)");
      return;
    }

    // Register the listener first so we catch the initial update.
    try {
      // @ts-ignore: account.on exists on the spacemolt lib
      const off = bot.account.on("observation_update", () => {
        try {
          bot.trackNearbyPlayers(bot.getObservationResult());
        } catch {
          /* ignore player-tracking errors from observation updates */
        }
      });
      observationUnsub = off;
    } catch (err) {
      ctx.log("warn", `observation_update listener failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      const obsResp = await bot.subscribeToObservation(false);
      if (obsResp.error) {
        ctx.log("error", `subscribe_observation failed: ${obsResp.error.message}`);
        return;
      }
      // Feed the baseline snapshot into the player tracker (get_nearby-shaped).
      try {
        bot.trackNearbyPlayers(bot.getObservationResult());
        ctx.log("info", `Observation baseline player data tracked at ${bot.system}/${bot.poi}`);
      } catch {
        /* ignore player-tracking errors from the baseline */
      }
    } catch (err) {
      ctx.log("error", `subscribe_observation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  while (bot.state === "running") {
    yield "market_monitor";

    // Heartbeat: keeps the "market routine is running locally" detection alive
    // for as long as this routine keeps cycling.
    noteMarketRoutineActive(bot.username);

    if (!bot.docked) {
      ctx.log("warn", "Market routine requires being docked — waiting...");
      await ctx.sleep(5000);
      continue;
    }

      const nextBaseId = bot.poi;
      if (nextBaseId && nextBaseId !== lastBaseId) {
        unsubscribeMarketUpdates();
        unsubscribeObservation();

        ctx.log("info", `Subscribing to market at ${bot.system}/${bot.poi}...`);

      const subResp = await bot.exec("subscribe_market");
      if (subResp.error) {
        ctx.log("error", `subscribe_market failed: ${subResp.error.message}`);
        await ctx.sleep(10000);
        continue;
      }

      let snapshot = subResp.result as Record<string, unknown> | undefined;
      if (
        snapshot &&
        typeof snapshot === "object" &&
        "structuredContent" in (snapshot as Record<string, unknown>) &&
        (snapshot as Record<string, unknown>).structuredContent &&
        typeof (snapshot as Record<string, unknown>).structuredContent === "object"
      ) {
        const sc = (snapshot as Record<string, unknown>).structuredContent as Record<string, unknown> | undefined;
        if (sc && typeof sc === "object") snapshot = sc;
      }

      if (snapshot && typeof snapshot === "object") {
        const baseId = snapshot.base_id as string | undefined;
        const items = Array.isArray(snapshot.items)
          ? (snapshot.items as Array<Record<string, unknown>>)
          : [];

        if (baseId && items.length > 0) {
          marketStreamStore.update(baseId, 0, items as any);

          // Friendly station name, matching what the explorer writes, so both
          // producers key marketDetails.json the same way.
          const mappedPoi = mapStore.getSystem(bot.system)?.pois.find((p) => p.id === bot.poi);
          const stationName = mappedPoi?.name
            || (snapshot.base_name as string)
            || (snapshot.station_name as string)
            || bot.poi;

          try {
            saveItemsToMarketDetails(bot.system, bot.poi, stationName, items);
            ctx.log("info", `Saved ${items.length} items to marketDetails.json`);
          } catch {
            /* ignore marketDetails errors */
          }

          subscribeMarketUpdates(baseId, bot.system, bot.poi, stationName);
          currentBaseId = baseId;

          ctx.log("info", `Market subscription active: ${items.length} items at ${baseId}`);

          // Also collect the player/pirate/empire-NPC data visible at this
          // station via the live observation feed.
          void subscribeObservation();
        } else {
          ctx.log("warn", `subscribe_market returned no data: baseId=${baseId} items=${items.length}`);
        }
      }

      lastBaseId = nextBaseId;
    }

    if (Date.now() - lastShipBrowseAt >= SHIP_BROWSE_INTERVAL_MS) {
      try {
        yield `browse_ships_${bot.poi}`;
        const browseResp = await bot.exec("browse_ships");
        if (browseResp.error) {
          ctx.log("error", `browse_ships failed: ${browseResp.error.message}`);
        } else if (browseResp.result && typeof browseResp.result === "object") {
          const result = browseResp.result as Record<string, unknown>;
          const listings = (
            Array.isArray(result.listings) ? result.listings : []
          ) as Array<Record<string, unknown>>;

          if (listings.length > 0) {
            const mappedPoi = mapStore.getSystem(bot.system)?.pois.find((p) => p.id === bot.poi);
            const stationName = mappedPoi?.name
              || (result.base_name as string)
              || (result.station_name as string)
              || bot.poi;
            updateShipListings(bot.system, bot.poi, stationName, listings, ctx.log);
          }
        }
      } catch (err) {
        ctx.log("error", `browse_ships error: ${err instanceof Error ? err.message : String(err)}`);
      }
      lastShipBrowseAt = Date.now();
    }

    await ctx.sleep(30000);
  }

  unsubscribeMarketUpdates();
  unsubscribeObservation();
  noteMarketRoutineStopped(bot.username);
};
