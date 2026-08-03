import type { Routine, RoutineContext } from "../bot.js";
import { marketStreamStore } from "../marketstreamstore.js";
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
  const marketDetails = loadMarketDetails();
  let detailsUpdated = false;

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

    detailsUpdated = true;
  }

  if (detailsUpdated) {
    saveMarketDetails(marketDetails);
  }
}

export const marketRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;
  let lastBaseId: string | null = null;
  let currentBaseId: string | null = null;
  let marketUpdateCb: ((entry: import("../marketstreamstore.js").MarketStreamEntry | null) => void) | null = null;

  function unsubscribeMarketUpdates() {
    if (currentBaseId && marketUpdateCb) {
      marketStreamStore.unsubscribe(currentBaseId, marketUpdateCb);
    }
    marketUpdateCb = null;
  }

  function subscribeMarketUpdates(baseId: string) {
    unsubscribeMarketUpdates();
    const cb = (entry: import("../marketstreamstore.js").MarketStreamEntry | null) => {
      if (!entry || !entry.items.length) return;
      try {
        saveItemsToMarketDetails(bot.system, baseId, baseId, entry.items as Array<Record<string, unknown>>);
      } catch {
        /* ignore marketDetails errors from push updates */
      }
    };
    marketUpdateCb = cb;
    marketStreamStore.subscribe(baseId, cb);
  }

  while (bot.state === "running") {
    yield "market_monitor";

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

      ctx.log("debug", `subscribe_market raw result: ${JSON.stringify(subResp.result)}`);

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

          try {
            saveItemsToMarketDetails(bot.system, bot.poi, baseId, items);
            ctx.log("info", `Saved ${items.length} items to marketDetails.json`);
          } catch {
            /* ignore marketDetails errors */
          }

          subscribeMarketUpdates(baseId);
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
};
