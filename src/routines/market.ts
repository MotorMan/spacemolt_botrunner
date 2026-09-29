import type { Bot, Routine, RoutineContext } from "../bot.js";
import { perf } from "../perf.js";
import { marketStreamStore, type MarketStreamItem } from "../marketstreamstore.js";
import { mapStore } from "../mapstore.js";
import {
  noteMarketRoutineActive,
  noteMarketRoutineStopped,
  noteLocalMarketObservation,
} from "../market_local_source.js";
import { marketDetailsStore, type MarketOrderDetail } from "../marketdetailsstore.js";
import { updateShipListings } from "../shipsforsale.js";
import { record as recordMarketSnapshot } from "../marketSnapshotStore.js";
import { loadSettings } from "../web/server.js";
import { readSellOutcome } from "./sellOutcome.js";

function saveItemsToMarketDetails(
  systemId: string,
  stationKey: string,
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
    const presentItemIds = new Set<string>();

    for (const item of items) {
      const itemId = (item.item_id as string) || (item.id as string) || "";
      const itemName = (item.name as string) || (item.item_name as string) || itemId;
      if (!itemId) continue;
      presentItemIds.add(itemId);

      const buyOrders = ((item.buy_orders as Array<Record<string, unknown>>) || []).map((order) => ({
        price: (order.price_each as number) || (order.price as number) || 0,
        quantity: (order.quantity as number) || 0,
        source: (order.source as string) || undefined,
      })).filter((order) => order.price > 0 && order.quantity > 0);

      const sellOrders = ((item.sell_orders as Array<Record<string, unknown>>) || []).map((order) => ({
        price: (order.price_each as number) || (order.price as number) || 0,
        quantity: (order.quantity as number) || 0,
        source: (order.source as string) || undefined,
      })).filter((order) => order.price > 0 && order.quantity > 0);

      const prev = marketDetailsStore.getData().items.find(
        i => i.systemId === systemId && i.stationPoiId === stationKey && i.itemId === itemId
      );
      const prevBuyCount = prev?.buyOrders.length ?? -1;
      const prevSellCount = prev?.sellOrders.length ?? -1;
      if (prevBuyCount >= 0 && buyOrders.length === 0 && prevBuyCount > 0) {
        console.log(`[market] ${stationKey}/${itemId}: buy orders REMOVED (was ${prevBuyCount})`);
      }
      if (prevSellCount >= 0 && sellOrders.length === 0 && prevSellCount > 0) {
        console.log(`[market] ${stationKey}/${itemId}: sell orders REMOVED (was ${prevSellCount})`);
      }
      if (prevBuyCount >= 0 && buyOrders.length > 0 && prevBuyCount === 0) {
        console.log(`[market] ${stationKey}/${itemId}: buy orders ADDED (${buyOrders.length})`);
      }
      if (prevSellCount >= 0 && sellOrders.length > 0 && prevSellCount === 0) {
        console.log(`[market] ${stationKey}/${itemId}: sell orders ADDED (${sellOrders.length})`);
      }

      obs.push({ itemId, itemName, buyOrders, sellOrders });
    }

    if (obs.length) {
      const removed = marketDetailsStore.removeStationItems(systemId, stationKey, presentItemIds);
      if (removed > 0) {
        console.log(`[market] Removed ${removed} stale item(s) from ${stationKey} (not in latest update)`);
      }
      marketDetailsStore.upsertItems(systemId, stationKey, stationName, obs);
    }
    return obs;
  });

  // Publish to the in-memory overlay too, so routines in this process see
  // these prices immediately instead of waiting for the (throttled) re-parse
  // of the 10MB marketDetails.json.
  if (observations.length) {
    noteLocalMarketObservation(systemId, stationKey, stationName, observations);
  }
}

async function tryProcessSellableItems(
  bot: Bot,
  items: MarketStreamItem[],
  placedOrders: Map<string, { price: number; quantity: number }>,
  ctx: RoutineContext,
): Promise<void> {
  try {
    const settings = loadSettings();
    const globalItems =
      (((settings.market_routine as Record<string, unknown>) || {}).globalItems as Array<{ itemId: string; itemName: string; minSellPrice: number; preloadToStation: number }>) ||
      [];
    const sellToStationOrdersOnly = !!((settings.market_routine as Record<string, unknown>) || {}).sellToStationOrdersOnly;
    const botSettings = (settings[bot.username] as Record<string, unknown>) || {};
    const perBotItems =
      (botSettings.marketRoutineItems as Array<{ itemId: string; itemName: string; minSellPrice: number; preloadToStation: number }>) || [];
    const effectiveItems = perBotItems.length > 0 ? perBotItems : globalItems;

    if (effectiveItems.length === 0) return;

    const itemSize = (itemId: string): number => {
      const invItem = bot.inventory.find(c => c.itemId === itemId);
      if (invItem && invItem.quantity > 0 && bot.cargo > 0) {
        const size = bot.cargo / bot.inventory.reduce((s, i) => s + i.quantity, 0);
        return Math.max(1, Math.round(size));
      }
      return 10;
    };

    for (const watchedItem of effectiveItems) {
      const marketItem = items.find(i => (i.item_id as string) === watchedItem.itemId);
      if (!marketItem || !marketItem.buy_orders || marketItem.buy_orders.length === 0) continue;

      const allSources = [...new Set(marketItem.buy_orders.map(o => (o.source as string) || "").filter(Boolean))];

      const qualifyingBuyOrders = marketItem.buy_orders
        .map(o => ({
          price: (o.price_each as number) || (o.price as number) || 0,
          quantity: (o.quantity as number) || 0,
          source: (o.source as string) || "",
        }))
        .filter(o => o.price > 0 && o.quantity > 0)
        .filter(o => {
          if (!sellToStationOrdersOnly) return true;
          return String(o.source || "").toLowerCase() === "station";
        })
        .sort((a, b) => b.price - a.price);

      if (qualifyingBuyOrders.length === 0) {
        if (sellToStationOrdersOnly && marketItem.buy_orders.length > 0) {
          ctx.log(
            "trade",
            `Market routine: ${watchedItem.itemName} - no station buy orders at ${bot.poi} (${marketItem.buy_orders.length} total, sources: ${allSources.join(", ") || "none"})`,
          );
        }
        continue;
      }

      const qualifyingAboveFloor = qualifyingBuyOrders.filter(o => o.price >= watchedItem.minSellPrice);

      if (qualifyingAboveFloor.length === 0) continue;

      const totalQty = qualifyingAboveFloor.reduce((sum, o) => sum + o.quantity, 0);
      const minBuyPrice = Math.min(...qualifyingAboveFloor.map(o => o.price));

      const lastOrder = placedOrders.get(watchedItem.itemId);
      if (lastOrder && lastOrder.price === minBuyPrice && lastOrder.quantity === totalQty) continue;

      const cargoItem = bot.inventory.find(c => c.itemId === watchedItem.itemId);
      const cargoQty = cargoItem?.quantity || 0;
      const freeSpace = (bot.cargoMax || 0) - (bot.cargo || 0);

      if (freeSpace <= 0 && cargoQty <= 0) continue;

      let sellQty = totalQty;

      if (sellQty <= 0) continue;

      const preloadTarget = Math.max(0, watchedItem.preloadToStation || 0);

      if (preloadTarget > 0) {
        try {
          const parsedStorage = bot.parseItemList((await bot.exec("view_storage")).result, "storage");
          const stationItem = parsedStorage.find(s => s.itemId === watchedItem.itemId);
          const stationQty = stationItem?.quantity || 0;
          const needPreload = Math.max(0, preloadTarget - stationQty);

          if (needPreload > 0) {
            const freeSpace = (bot.cargoMax || 0) - (bot.cargo || 0);
            const itemS = itemSize(watchedItem.itemId);
            const maxFit = Math.floor(freeSpace / Math.max(1, itemS));
            const canMove = Math.min(needPreload, cargoQty, maxFit);

            if (canMove > 0) {
              const depResp = await bot.exec("storage", {
                action: "deposit",
                target: "station",
                item_id: watchedItem.itemId,
                quantity: canMove,
              });
              if (!depResp.error) {
                ctx.log("trade", `Market routine: preloaded ${canMove}x ${watchedItem.itemName} to station storage (target ${preloadTarget})`);
                if (cargoItem) cargoItem.quantity = Math.max(0, cargoQty - canMove);
              }
            }
          }
        } catch {
          /* ignore preload errors, continue to sell attempt */
        }
      }

      const cargoAfterPreload = bot.inventory.find(c => c.itemId === watchedItem.itemId)?.quantity || 0;
      let needWithdraw = Math.max(0, totalQty - cargoAfterPreload);

      if (needWithdraw > 0) {
        try {
          const parsedStorage = bot.parseItemList((await bot.exec("view_storage", { target: "faction" })).result, "storage");
          const storageItem = parsedStorage.find(s => s.itemId === watchedItem.itemId);
          const storageQty = storageItem?.quantity || 0;
          const itemS = itemSize(watchedItem.itemId);
          const availableSpace = Math.max(0, (bot.cargoMax || 0) - (bot.cargo || 0));
          const maxFit = Math.floor(availableSpace / itemS);
          const actualWithdraw = Math.min(needWithdraw, storageQty, maxFit);

          if (actualWithdraw > 0) {
            const wResp = await bot.exec("storage", {
              action: "withdraw",
              target: "faction",
              item_id: watchedItem.itemId,
              quantity: actualWithdraw,
            });
            if (wResp.error) {
              ctx.log("warn", `Market routine: failed to withdraw ${watchedItem.itemName}: ${wResp.error.message}`);
              continue;
            }
            ctx.log("trade", `Market routine: withdrew ${actualWithdraw}x ${watchedItem.itemName} from faction storage to cargo`);
            const invItem = bot.inventory.find(c => c.itemId === watchedItem.itemId);
            if (invItem) {
              invItem.quantity += actualWithdraw;
            } else {
              bot.inventory.push({ itemId: watchedItem.itemId, name: watchedItem.itemName, quantity: actualWithdraw });
            }
          } else {
            ctx.log("warn", `Market routine: insufficient faction storage (${storageQty} avail, need ${needWithdraw}) for ${watchedItem.itemName}`);
            continue;
          }
        } catch (e) {
          ctx.log("warn", `Market routine: withdraw exception for ${watchedItem.itemName}: ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
      }

      const cargoAfterWithdraw = bot.inventory.find(c => c.itemId === watchedItem.itemId)?.quantity || 0;

      if (sellQty <= 0) continue;

      const stationDepositQty = cargoAfterWithdraw;
      if (stationDepositQty > 0) {
        const depResp = await bot.exec("storage", {
          action: "deposit",
          target: "station",
          item_id: watchedItem.itemId,
          quantity: stationDepositQty,
        });
        if (depResp.error) {
          ctx.log("warn", `Market routine: failed to deposit ${watchedItem.itemName} to station storage: ${depResp.error.message}`);
          continue;
        }
        ctx.log("trade", `Market routine: deposited ${stationDepositQty}x ${watchedItem.itemName} to station storage`);
      }

      try {
        const sellResp = await bot.exec("create_sell_order", {
          item_id: watchedItem.itemId,
          quantity: totalQty,
          price_each: minBuyPrice,
        });
        if (sellResp.error) {
          ctx.log(
            "error",
            `Market routine: create_sell_order failed for ${watchedItem.itemName}: ${sellResp.error.message}`,
          );
        } else {
          const invItem = bot.inventory.find(c => c.itemId === watchedItem.itemId);
          if (invItem) {
            invItem.quantity = Math.max(0, invItem.quantity - Math.min(cargoAfterWithdraw, totalQty));
          }
          ctx.log(
            "trade",
            `Market routine: listed ${totalQty}x ${watchedItem.itemName} @ ${minBuyPrice}cr (floor ${watchedItem.minSellPrice}cr, ${qualifyingAboveFloor.length} buy orders)`,
          );
          placedOrders.set(watchedItem.itemId, { price: minBuyPrice, quantity: totalQty });
        }
      } catch (e) {
        ctx.log("error", `Market routine: sell exception for ${watchedItem.itemName}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } catch {
    /* ignore market routine processing errors */
  }
}

export const marketRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;
  let lastBaseId: string | null = null;
  let currentBaseId: string | null = null;
  let marketUpdateCb: ((entry: import("../marketstreamstore.js").MarketStreamEntry | null) => void) | null = null;
  let lastShipBrowseAt = 0;
  const SHIP_BROWSE_INTERVAL_MS = 10 * 60 * 1000;
  let wasConnected = bot.isConnected();
  const placedOrders = new Map<string, { price: number; quantity: number }>();

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
      if (!entry) return;
      try {
        const prevEntry = marketStreamStore.getMarket(entry.baseId || "");
        const prevItems = prevEntry?.items ?? [];
        const prevItemIds = new Set(prevItems.map(i => (i.item_id as string) || (i.id as string) || ""));
        const newItemIds = new Set(entry.items.map(i => (i.item_id as string) || (i.id as string) || ""));
        const added = [...newItemIds].filter(id => id && !prevItemIds.has(id));
        const removed = [...prevItemIds].filter(id => id && !newItemIds.has(id));
        if (added.length > 0 || removed.length > 0) {
          console.log(`[market] ${entry.baseId}: +${added.length}/-${removed.length} items (${added.slice(0,3).join(", ")}${added.length > 3 ? "..." : ""} / ${removed.slice(0,3).join(", ")}${removed.length > 3 ? "..." : ""})`);
        }
        const isMobileCapital = entry.baseId === "frontier_station" || entry.poiId === "frontier_station" || entry.poiId === "mobile_capital" || entry.poiId === "mobile_capitol";
        const stationKey = isMobileCapital ? "frontier_station" : entry.poiId || entry.baseId || "";
        const stationName = entry.poiName || entry.baseId || "";
        saveItemsToMarketDetails(entry.systemId || "", stationKey, stationName, entry.items as Array<Record<string, unknown>>);
        recordMarketSnapshot(entry.baseId || "", {
          baseId: entry.baseId,
          systemId: entry.systemId,
          poiId: entry.poiId,
          poiName: entry.poiName,
          updatedAt: entry.updatedAt,
        }, entry.tick ?? 0, entry.items as Array<{
          item_id: string;
          item_name?: string;
          sell_orders?: Array<{ price?: number; price_each?: number; quantity?: number; source?: string; order_id?: string; id?: string }>;
          buy_orders?: Array<{ price?: number; price_each?: number; quantity?: number; source?: string; order_id?: string; id?: string }>;
          [key: string]: unknown;
        }>);
        
        void tryProcessSellableItems(bot, entry.items, placedOrders, ctx);
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

    const isConnected = bot.isConnected();
    if (!isConnected) {
      wasConnected = false;
    } else if (!wasConnected) {
      wasConnected = true;
      lastBaseId = null;
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
          const mappedPoi = mapStore.getSystem(bot.system)?.pois.find((p) => p.id === bot.poi);
          const stationName = mappedPoi?.name
            || (snapshot.base_name as string)
            || (snapshot.station_name as string)
            || bot.poi;

          marketStreamStore.update(baseId, 0, items as any, {
            baseId,
            systemId: bot.system,
            poiId: bot.poi,
            poiName: stationName,
            updatedAt: Date.now(),
          });

          recordMarketSnapshot(baseId, {
            baseId,
            systemId: bot.system,
            poiId: bot.poi,
            poiName: stationName,
            updatedAt: Date.now(),
          }, 0, items as Array<{
            item_id: string;
            item_name?: string;
            sell_orders?: Array<{ price?: number; price_each?: number; quantity?: number; source?: string; order_id?: string; id?: string }>;
            buy_orders?: Array<{ price?: number; price_each?: number; quantity?: number; source?: string; order_id?: string; id?: string }>;
            [key: string]: unknown;
          }>);

          const isMobileCapital =
            baseId === "frontier_station" ||
            bot.poi === "frontier_station" ||
            bot.poi === "mobile_capital" ||
            bot.poi === "mobile_capitol";
          const stationKey = isMobileCapital ? "frontier_station" : bot.poi;

          if (isMobileCapital) {
            marketDetailsStore.clearStation(bot.system, "frontier_station");
            marketDetailsStore.clearStation(bot.system, "mobile_capital");
            marketDetailsStore.clearStation(bot.system, "mobile_capitol");
          } else {
            marketDetailsStore.clearStation(bot.system, stationKey);
          }

          try {
            saveItemsToMarketDetails(bot.system, stationKey, stationName, items);
            ctx.log("info", `Saved ${items.length} items to marketDetails.json`);
          } catch {
            /* ignore marketDetails errors */
          }

          void tryProcessSellableItems(bot, items as MarketStreamItem[], placedOrders, ctx);

          subscribeMarketUpdates(baseId, bot.system, bot.poi, stationName);
          currentBaseId = baseId;
          placedOrders.clear();

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

    await ctx.sleep(10000);
  }

  unsubscribeMarketUpdates();
  unsubscribeObservation();
  noteMarketRoutineStopped(bot.username);
};
