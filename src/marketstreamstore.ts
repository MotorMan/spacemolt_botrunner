import { debugLog } from "./debug.js";

export interface MarketStreamOrderLevel {
  price_each?: number;
  price?: number;
  quantity?: number;
  source?: string;
  [key: string]: unknown;
}

export interface MarketStreamItem {
  item_id: string;
  item_name?: string;
  sell_orders?: MarketStreamOrderLevel[];
  buy_orders?: MarketStreamOrderLevel[];
  [key: string]: unknown;
}

export interface MarketStreamMetadata {
  baseId?: string;
  systemId?: string;
  poiId?: string;
  poiName?: string;
  updatedAt?: number;
}

export interface MarketStreamEntry {
  tick: number;
  items: MarketStreamItem[];
  updatedAt: number;
  baseId?: string;
  systemId?: string;
  poiId?: string;
  poiName?: string;
}

type MarketStreamSubscriber = (entry: MarketStreamEntry | null) => void;
type MarketStreamAllSubscriber = (entry: MarketStreamEntry) => void;

const allSubscribers = new Set<MarketStreamAllSubscriber>();

/**
 * In-memory realtime market sink fed by the library's `market_update` push
 * frames. Kept fully separate from the HTTP `mapStore` cache; the dashboard
 * market view reads from here.
 */
class MarketStreamStore {
  private markets = new Map<string, MarketStreamEntry>();
  private subscribers = new Map<string, Set<MarketStreamSubscriber>>();

  /** Record a market_update for a base. */
  update(baseId: string, tick: number, items: MarketStreamItem[], metadata?: MarketStreamMetadata): void {
    const updatedAt = metadata?.updatedAt ?? Date.now();
    const entry: MarketStreamEntry = { tick, items, updatedAt, baseId, ...metadata };
    this.markets.set(baseId, entry);
    debugLog("marketstream", `market_update ${baseId} tick ${tick} (${items.length} items)`);
    const subs = this.subscribers.get(baseId);
    if (subs) {
      for (const cb of subs) {
        try { cb(entry); } catch { /* ignore bad subscriber */ }
      }
    }
  }

  getMarket(baseId: string): MarketStreamEntry | null {
    return this.markets.get(baseId) || null;
  }

  getAll(): Record<string, MarketStreamEntry> {
    const out: Record<string, MarketStreamEntry> = {};
    for (const [baseId, entry] of this.markets) out[baseId] = entry;
    return out;
  }

  subscribe(baseId: string, cb: MarketStreamSubscriber): void {
    let set = this.subscribers.get(baseId);
    if (!set) {
      set = new Set();
      this.subscribers.set(baseId, set);
    }
    set.add(cb);
  }

  unsubscribe(baseId: string, cb: MarketStreamSubscriber): void {
    const set = this.subscribers.get(baseId);
    if (set) {
      set.delete(cb);
      if (set.size === 0) this.subscribers.delete(baseId);
    }
  }
}

export const marketStreamStore = new MarketStreamStore();
