import type { Routine, RoutineContext } from "../bot.js";
import { perf } from "../perf.js";
import { marketStreamStore } from "../marketstreamstore.js";
import { mapStore } from "../mapstore.js";
import {
  noteMarketRoutineActive,
  noteMarketRoutineStopped,
  noteLocalMarketObservation,
} from "../market_local_source.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const DATA_DIR = join(process.cwd(), "data");
const MARKET_DETAILS_FILE = join(DATA_DIR, "marketDetails.json");

interface MarketOrderDetail {
  price: number;
  quantity: number;
}

interface MarketItemDetails {
  systemId: string;
  stationPoiId: string;
  stationName: string;
  itemId: string;
  itemName: string;
  buyOrders: MarketOrderDetail[];
  sellOrders: MarketOrderDetail[];
  lastUpdated: string;
}

interface MarketDetailsData {
  lastSaved: string;
  items: MarketItemDetails[];
}

function now(): string {
  return new Date().toISOString();
}

function loadMarketDetails(): MarketDetailsData {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  if (existsSync(MARKET_DETAILS_FILE)) {
    try {
      const raw = readFileSync(MARKET_DETAILS_FILE, "utf-8");
      return JSON.parse(raw) as MarketDetailsData;
    } catch {
      // Corrupt file — start fresh
    }
  }
  return { lastSaved: now(), items: [] };
}

function saveMarketDetails(data: MarketDetailsData): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  data.lastSaved = now();
  writeFileSync(MARKET_DETAILS_FILE, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function saveItemsToMarketDetails(
  systemId: string,
  stationPoiId: string,
  stationName: string,
  items: Array<Record<string, unknown>>,
): void {
  // Measure only the (disk-bound) load + parse + rewrite of marketDetails.json.
  // The in-memory overlay publish (`noteLocalMarketObservation`) is kept outside
  // the timer so it doesn't inflate the FS cost measurement.
  const observations = perf.timeSync("market.saveItemsToMarketDetails", () => {
    const marketDetails = loadMarketDetails();
    let detailsUpdated = false;
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

      const existingIndex = marketDetails.items.findIndex(
        (m) => m.systemId === systemId && m.stationPoiId === stationPoiId && m.itemId === itemId,
      );

      const marketItemDetail: MarketItemDetails = {
        systemId,
        stationPoiId,
        stationName,
        itemId,
        itemName,
        buyOrders,
        sellOrders,
        lastUpdated: now(),
      };

      if (existingIndex >= 0) {
        marketDetails.items[existingIndex] = marketItemDetail;
      } else {
        marketDetails.items.push(marketItemDetail);
      }

      obs.push({ itemId, itemName, buyOrders, sellOrders });
      detailsUpdated = true;
    }

    if (detailsUpdated) {
      saveMarketDetails(marketDetails);
    }
    return detailsUpdated ? obs : [];
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
        } else {
          ctx.log("warn", `subscribe_market returned no data: baseId=${baseId} items=${items.length}`);
        }
      }

      lastBaseId = nextBaseId;
    }

    await ctx.sleep(30000);
  }

  unsubscribeMarketUpdates();
  noteMarketRoutineStopped(bot.username);
};
