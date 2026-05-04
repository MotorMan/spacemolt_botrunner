import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { cachedFetch } from "./httpcache.js";
import { log } from "./ui.js";

// ── Data model ──────────────────────────────────────────────

export interface StoredConnection {
  system_id: string;
  system_name: string;
  security_level?: string;
  jump_cost?: number;
  distance?: number;
}

export interface OreRecord {
  item_id: string;
  name: string;
  total_mined: number;
  times_seen: number;
  last_seen: string;
  depleted?: boolean;
  depleted_at?: string;
}

/** Resource data from get_poi scan */
export interface ResourceRecord {
  resource_id: string;
  name: string;
  richness: number;
  remaining: number;
  max_remaining: number;
  depletion_percent: number;
  last_scanned: string;
}

/** Depletion timeout in milliseconds - POIs can be re-checked after this long. */
export const DEPLETION_TIMEOUT_MS = 3 * 60 * 60 * 1000; // 3 hours

/** Check if an ore depletion has expired (can be re-mined). */
export function isDepletionExpired(depletedAt: string | undefined, timeoutMs: number = DEPLETION_TIMEOUT_MS): boolean {
  if (!depletedAt) return true;
  const depletedTime = new Date(depletedAt).getTime();
  const now = Date.now();
  return (now - depletedTime) > timeoutMs;
}

/** Parse expiry text like "36477d 20h" into an ISO timestamp. */
function calculateExpiryFromText(text: string): string {
  const match = text.match(/(\d+)\s*d\s*(\d+)\s*h/i);
  if (!match) return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // Default 1 day if parsing fails

  const days = parseInt(match[1], 10);
  const hours = parseInt(match[2], 10);
  const msFromNow = (days * 24 * 60 * 60 + hours * 60 * 60) * 1000;
  return new Date(Date.now() + msFromNow).toISOString();
}

/** Check if a wormhole is still active (not expired). */
function isWormholeActive(wormhole: { expires_at: string | null }): boolean {
  if (!wormhole.expires_at) return true; // No expiry = always active
  const expiryTime = new Date(wormhole.expires_at).getTime();
  return Date.now() < expiryTime;
}

/** Calculate human-readable time remaining until expiry. */
function calculateTimeRemaining(expiryIso: string): string {
  const expiryTime = new Date(expiryIso).getTime();
  const diff = expiryTime - Date.now();

  if (diff <= 0) return "expired";

  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  const days = Math.floor(hrs / 24);
  const remainingHours = hrs % 24;
  return `${days}d ${remainingHours}h`;
}

export interface MarketRecord {
  item_id: string;
  item_name: string;
  best_buy: number | null;
  best_sell: number | null;
  buy_quantity: number;
  sell_quantity: number;
  last_updated: string;
}

export interface OrderRecord {
  order_id: string;
  player_name?: string;
  item_id: string;
  item_name: string;
  order_type: "buy" | "sell";
  price: number;
  quantity: number;
  last_seen: string;
}

export interface MissionRecord {
  mission_id: string;
  title: string;
  description?: string;
  type?: string;
  reward_credits?: number;
  reward_items?: string;
  level_required?: number;
  expires_at?: string;
  last_seen: string;
}

export interface StoredPOI {
  id: string;
  name: string;
  type: string;
  has_base: boolean;
  base_id: string | null;
  base_name: string | null;
  base_type: string | null;
  services: string[];
  ores_found: OreRecord[];
  resources: ResourceRecord[];
  market: MarketRecord[];
  orders: OrderRecord[];
  missions: MissionRecord[];
  last_explored: string | null;
  last_updated: string;
  /** Whether this POI is hidden (not visible on get_system, only discovered via get_poi or scanning) */
  hidden?: boolean;
  /** Difficulty to reveal this hidden POI (0-100) */
  reveal_difficulty?: number;
}

export interface PirateSighting {
  player_id?: string;
  name?: string;
  count: number;
  last_seen: string;
}

/** Wormhole exit POI data from survey */
export interface WormholeExitPOI {
  id: string;
  system_id: string;
  type: string; // "wormhole_exit"
  name: string;
  description: string;
  position?: { x: number; y: number };
  hidden: boolean;
  reveal_difficulty: number;
}

/** Wormhole record stored in map - tracks both entrance and exit */
export interface WormholeRecord {
  /** Unique wormhole identifier */
  id: string;
  /** Wormhole name (usually from exit POI) */
  name: string;
  /** System where the wormhole entrance is located */
  entrance_system_id: string;
  entrance_system_name: string;
  /** System where the wormhole exit is located */
  exit_system_id: string;
  exit_system_name: string;
  /** Exit POI ID in the exit system */
  exit_poi_id: string;
  /** Exit POI name */
  exit_poi_name: string;
  /** System ID that the wormhole leads TO (from exit POI perspective) */
  destination_system_id: string;
  destination_system_name: string;
  /** When the wormhole was discovered/recorded */
  discovered_at: string;
  /** When the wormhole expires (ISO timestamp) */
  expires_at: string | null;
  /** Whether this wormhole is still active */
  is_active: boolean;
}

export interface WreckRecord {
  id: string;
  ship_type: string;
  wreck_type?: string;
  poi_id?: string;
  expires_at?: string;
  last_seen: string;
}

export interface StoredSystem {
  id: string;
  name: string;
  security_level?: string;
  connections: StoredConnection[];
  pois: StoredPOI[];
  /** Wormholes that have an exit in this system */
  wormhole_exits: WormholeRecord[];
  pirate_sightings: PirateSighting[];
  wrecks: WreckRecord[];
  last_updated: string;
}

export interface MapData {
  version: 1;
  last_saved: string;
  systems: Record<string, StoredSystem>;
  /** Track the mobile_capitol station's current location. Updated when discovered by bots. */
  mobile_capitol?: {
    system_id: string;
    system_name: string;
    poi_id: string;
    discovered_at: string;
  };
}

// ── MapStore singleton ──────────────────────────────────────

const DATA_DIR = join(process.cwd(), "data");
const MAP_FILE = join(DATA_DIR, "map.json");
const SAVE_DEBOUNCE_MS = 5000;

class MapStore {
  private data: MapData;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.data = this.load();
  }

  // ── Pirate System Check ─────────────────────────────────

  /** Check if a system is a pirate system (hostile). */
  private isPirateSystem(systemId: string): boolean {
    const lower = systemId.toLowerCase();
    const pirateSystems = [
      "alhena",
      "xamidimura",
      "algol",
      "zaniah",
      "sheratan",
      "bellatrix",
      "barnard_44",
      "gsc_0008",
      "gliese_581",
    ];
    return pirateSystems.some(ps => lower === ps || lower.includes(ps));
  }

  // ── Persistence ─────────────────────────────────────────

  private load(): MapData {
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }
    if (existsSync(MAP_FILE)) {
      try {
        const raw = readFileSync(MAP_FILE, "utf-8");
        return JSON.parse(raw) as MapData;
      } catch {
        // Corrupt file — start fresh
      }
    }
    return { version: 1, last_saved: now(), systems: {} };
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.writeToDisk();
    }, SAVE_DEBOUNCE_MS);
  }

  private writeToDisk(): void {
    if (!this.dirty) return;
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }
    this.data.last_saved = now();
    writeFileSync(MAP_FILE, JSON.stringify(this.data, null, 2) + "\n", "utf-8");
    this.dirty = false;
  }

  /** Flush pending writes to disk immediately. Call on shutdown. */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.writeToDisk();
  }

  // ── Update methods ──────────────────────────────────────

  /** Merge system data from a get_system API response. */
  updateSystem(systemData: Record<string, unknown>): void {
    const id = (systemData.system_id as string) || (systemData.id as string);
    if (!id) return;

    const existing = this.data.systems[id];
    const sys: StoredSystem = existing || {
      id,
      name: "",
      connections: [],
      pois: [],
      wormhole_exits: [],
      pirate_sightings: [],
      wrecks: [],
      last_updated: now(),
    };

    sys.name = (systemData.name as string) || (systemData.system_name as string) || sys.name;
    sys.security_level = (systemData.security_level as string)
      || (systemData.security_status as string)
      || (systemData.lawfulness as string)
      || (systemData.security as string)
      || (systemData.police_level as string)
      || sys.security_level;
    sys.last_updated = now();

    // Merge connections
    const conns = systemData.connections as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(conns)) {
      sys.connections = conns.map((c) => ({
        system_id: (c.system_id as string) || (c.id as string) || "",
        system_name: (c.system_name as string) || (c.name as string) || "",
        security_level: (c.security_level as string) || (c.security_status as string) || (c.lawfulness as string) || (c.security as string) || undefined,
        jump_cost: c.jump_cost as number | undefined,
        distance: c.distance as number | undefined,
      }));
    }

    // Merge POIs — preserve existing ore & market data AND hidden POIs
    const pois = systemData.pois as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(pois)) {
      const existingPois = new Map(sys.pois.map((p) => [p.id, p]));
      const updatedPoiIds = new Set<string>();

      // Update/create POIs from the API response
      const updatedPois = pois.map((p) => {
        const poiId = (p.id as string) || "";
        updatedPoiIds.add(poiId);
        const prev = existingPois.get(poiId);
        return {
          id: poiId,
          name: (p.name as string) || prev?.name || "",
          type: (p.type as string) || prev?.type || "",
          has_base: !!(p.has_base || p.base_id),
          base_id: (p.base_id as string) ?? prev?.base_id ?? null,
          base_name: (p.base_name as string) ?? prev?.base_name ?? null,
          base_type: (p.base_type as string) ?? prev?.base_type ?? null,
          services: (p.services as string[]) ?? prev?.services ?? [],
          ores_found: prev?.ores_found ?? [],
          resources: prev?.resources ?? [],
          market: prev?.market ?? [],
          orders: prev?.orders ?? [],
          missions: prev?.missions ?? [],
          last_explored: prev?.last_explored ?? null,
          last_updated: now(),
          // Preserve hidden flag: once a POI is marked hidden, it stays hidden
          // even if the API doesn't return the flag (hidden POIs revealed by survey
          // should remain tracked as hidden for explorer reference)
          hidden: (p.hidden as boolean) || prev?.hidden || false,
          reveal_difficulty: (p.reveal_difficulty as number) ?? prev?.reveal_difficulty,
        };
      });

      // Preserve hidden POIs that aren't in the API response
      // (hidden POIs only appear via get_poi scans, not get_system)
      for (const [poiId, existingPoi] of existingPois) {
        if (!updatedPoiIds.has(poiId) && existingPoi.hidden) {
          updatedPois.push(existingPoi as typeof updatedPois[number]);
        }
      }

      sys.pois = updatedPois;

      // Auto-detect mobile_capitol station and update its location
      const mobileCapitolPoi = sys.pois.find((p) => p.id === "mobile_capital");
      if (mobileCapitolPoi) {
        this.updateMobileCapitolLocation(id, sys.name || id, mobileCapitolPoi.id);
      }
    }

    // Merge wrecks from system data
    const wrecks = systemData.wrecks as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(wrecks)) {
      const existingWrecks = new Map(sys.wrecks.map((w) => [w.id, w]));
      for (const w of wrecks) {
        const wId = (w.id as string) || (w.wreck_id as string) || "";
        if (!wId) continue;
        existingWrecks.set(wId, {
          id: wId,
          ship_type: (w.ship_type as string) || "",
          wreck_type: w.wreck_type as string | undefined,
          poi_id: w.poi_id as string | undefined,
          expires_at: w.expires_at as string | undefined,
          last_seen: now(),
        });
      }
      sys.wrecks = [...existingWrecks.values()];
    }

    this.data.systems[id] = sys;
    this.scheduleSave();
  }

  /** Update market prices for a station POI from view_market response. */
  updateMarket(systemId: string, poiId: string, marketData: Record<string, unknown>): void {
    const sys = this.data.systems[systemId];
    if (!sys) return;

    const poi = sys.pois.find((p) => p.id === poiId);
    if (!poi) return;

    const items = (
      Array.isArray(marketData) ? marketData :
      Array.isArray(marketData.items) ? marketData.items :
      Array.isArray(marketData.market) ? marketData.market :
      []
    ) as Array<Record<string, unknown>>;

    const existingMarket = new Map(poi.market.map((m) => [m.item_id, m]));
    const freshItemIds = new Set<string>();

    for (const item of items) {
      const itemId = (item.item_id as string) || (item.id as string) || "";
      if (!itemId) continue;
      freshItemIds.add(itemId);

      const prev = existingMarket.get(itemId);

      // Calculate best buy price (highest price from buy orders, or use provided buy_price)
      let buyPrice = item.buy_price as number ?? item.buy as number ?? null;
      let buyQty = (item.buy_quantity as number) ?? (item.buy_volume as number) ?? 0;

      // If we have buy_orders array, calculate best price and total quantity from it
      if (Array.isArray(item.buy_orders)) {
        let maxBuyPrice = 0;
        let totalBuyQty = 0;
        for (const order of item.buy_orders) {
          const price = (order.price as number) ?? (order.unit_price as number) ?? 0;
          const qty = (order.quantity as number) ?? (order.remaining as number) ?? 0;
          if (price > 0 && qty > 0) {
            maxBuyPrice = Math.max(maxBuyPrice, price);
            totalBuyQty += qty;
          }
        }
        if (maxBuyPrice > 0) {
          buyPrice = buyPrice ?? maxBuyPrice;
          buyQty = buyQty || totalBuyQty;
        }
      } else if ((item.buy_orders as number) > 0) {
        // Fallback for cases where buy_orders is a number (count of orders)
        buyQty = buyQty || (item.buy_orders as number);
      }

      // Calculate best sell price (lowest price from sell orders, or use provided sell_price)
      let sellPrice = item.sell_price as number ?? item.sell as number ?? null;
      let sellQty = (item.sell_quantity as number) ?? (item.sell_volume as number) ?? 0;

      // If we have sell_orders array, calculate best price and total quantity from it
      if (Array.isArray(item.sell_orders)) {
        let minSellPrice = Infinity;
        let totalSellQty = 0;
        for (const order of item.sell_orders) {
          const price = (order.price as number) ?? (order.unit_price as number) ?? 0;
          const qty = (order.quantity as number) ?? (order.remaining as number) ?? 0;
          if (price > 0 && qty > 0) {
            minSellPrice = Math.min(minSellPrice, price);
            totalSellQty += qty;
          }
        }
        if (minSellPrice !== Infinity) {
          sellPrice = sellPrice ?? minSellPrice;
          sellQty = sellQty || totalSellQty;
        }
      } else if ((item.sell_orders as number) > 0) {
        // Fallback for cases where sell_orders is a number (count of orders)
        sellQty = sellQty || (item.sell_orders as number);
      }

      existingMarket.set(itemId, {
        item_id: itemId,
        item_name: (item.name as string) || (item.item_name as string) || prev?.item_name || itemId,
        best_buy: buyPrice,
        best_sell: sellPrice,
        buy_quantity: buyQty,
        sell_quantity: sellQty,
        last_updated: now(),
      });
    }

    // Remove items not in the fresh API response — they're no longer on this market
    if (freshItemIds.size > 0) {
      for (const [id] of existingMarket) {
        if (!freshItemIds.has(id)) existingMarket.delete(id);
      }
    }

    poi.market = [...existingMarket.values()];
    poi.last_updated = now();
    this.scheduleSave();
  }

  /** Remove an item from a station's cached market data (e.g. when buy fails with item_not_available). */
  removeMarketItem(systemId: string, poiId: string, itemId: string): void {
    const sys = this.data.systems[systemId];
    if (!sys) return;
    const poi = sys.pois.find((p) => p.id === poiId);
    if (!poi) return;
    const before = poi.market.length;
    poi.market = poi.market.filter((m) => m.item_id !== itemId);
    if (poi.market.length < before) this.scheduleSave();
  }

  /** Reduce cached market quantities when a bot commits to a trade route.
   *  Decrements sell_quantity at source (fewer items for sale) and
   *  buy_quantity at dest (less demand to fill). Prevents other bots
   *  from chasing the same trade. */
  reserveTradeQuantity(
    sourceSystem: string, sourcePoi: string,
    destSystem: string, destPoi: string,
    itemId: string, quantity: number,
  ): void {
    // Reduce supply at source
    const srcSys = this.data.systems[sourceSystem];
    if (srcSys) {
      const srcStation = srcSys.pois.find(p => p.id === sourcePoi);
      const srcItem = srcStation?.market.find(m => m.item_id === itemId);
      if (srcItem) {
        srcItem.sell_quantity = Math.max(0, srcItem.sell_quantity - quantity);
        if (srcItem.sell_quantity === 0) srcItem.best_sell = null;
      }
    }
    // Reduce demand at dest
    const dstSys = this.data.systems[destSystem];
    if (dstSys) {
      const dstStation = dstSys.pois.find(p => p.id === destPoi);
      const dstItem = dstStation?.market.find(m => m.item_id === itemId);
      if (dstItem) {
        dstItem.buy_quantity = Math.max(0, dstItem.buy_quantity - quantity);
        if (dstItem.buy_quantity === 0) dstItem.best_buy = null;
      }
    }
    this.scheduleSave();
  }

  /** Update player buy/sell orders at a station POI. */
  updateOrders(systemId: string, poiId: string, orders: Array<Record<string, unknown>>): void {
    const sys = this.data.systems[systemId];
    if (!sys) return;

    const poi = sys.pois.find((p) => p.id === poiId);
    if (!poi) return;

    const existingOrders = new Map((poi.orders || []).map((o) => [o.order_id, o]));

    for (const order of orders) {
      const orderId = (order.order_id as string) || (order.id as string) || "";
      if (!orderId) continue;

      const orderType = (order.order_type as string) || (order.type as string) || "";
      const isBuy = orderType.toLowerCase().includes("buy");

      existingOrders.set(orderId, {
        order_id: orderId,
        player_name: (order.player_name as string) || (order.username as string) || undefined,
        item_id: (order.item_id as string) || "",
        item_name: (order.item_name as string) || (order.name as string) || (order.item_id as string) || "",
        order_type: isBuy ? "buy" : "sell",
        price: (order.price as number) || (order.unit_price as number) || 0,
        quantity: (order.quantity as number) || (order.remaining as number) || 0,
        last_seen: now(),
      });
    }

    poi.orders = [...existingOrders.values()];
    poi.last_updated = now();
    this.scheduleSave();
  }

  /** Mark a POI as explored (sets last_explored timestamp). */
  markExplored(systemId: string, poiId: string): void {
    const sys = this.data.systems[systemId];
    if (!sys) return;

    const poi = sys.pois.find((p) => p.id === poiId);
    if (!poi) return;

    poi.last_explored = now();
    poi.last_updated = now();
    this.scheduleSave();
  }

  /** Get minutes since a POI was last explored. Returns Infinity if never explored. */
  minutesSinceExplored(systemId: string, poiId: string): number {
    const sys = this.data.systems[systemId];
    if (!sys) return Infinity;

    const poi = sys.pois.find((p) => p.id === poiId);
    if (!poi || !poi.last_explored) return Infinity;

    return (Date.now() - new Date(poi.last_explored).getTime()) / 60000;
  }

  /** Update available missions at a station POI. */
  updateMissions(systemId: string, poiId: string, missions: Array<Record<string, unknown>>): void {
    const sys = this.data.systems[systemId];
    if (!sys) return;

    const poi = sys.pois.find((p) => p.id === poiId);
    if (!poi) return;

    poi.missions = missions.map((m) => {
      // Extract reward — handles multiple API formats
      let rewardCredits: number | undefined;
      let rewardItems: string | undefined;
      const reward = m.reward ?? m.rewards ?? m.payout;

      if (typeof reward === "number") {
        rewardCredits = reward;
      } else if (reward && typeof reward === "object") {
        const rObj = reward as Record<string, unknown>;
        rewardCredits = (rObj.credits as number) || (rObj.credit as number) || (rObj.amount as number) || undefined;
        const items = rObj.items ?? rObj.item;
        if (items) rewardItems = typeof items === "string" ? items : JSON.stringify(items);
      }
      rewardCredits = rewardCredits || (m.reward_credits as number) || (m.credits as number) || undefined;
      rewardItems = rewardItems || (m.reward_items as string) || undefined;

      return {
        mission_id: (m.mission_id as string) || (m.id as string) || "",
        title: (m.title as string) || (m.name as string) || "",
        description: (m.description as string) || (m.summary as string) || undefined,
        type: (m.type as string) || (m.mission_type as string) || undefined,
        reward_credits: rewardCredits,
        reward_items: rewardItems,
        level_required: (m.level_required as number) || (m.min_level as number) || undefined,
        expires_at: (m.expires_at as string) || undefined,
        last_seen: now(),
      };
    });

    poi.last_updated = now();
    this.scheduleSave();
  }

  /** Record ore mined at a POI. Increments totals. */
  recordMiningYield(systemId: string, poiId: string, oreItem: { item_id: string; name: string }): void {
    const sys = this.data.systems[systemId];
    if (!sys) return;

    const poi = sys.pois.find((p) => p.id === poiId);
    if (!poi) return;

    const existing = poi.ores_found.find((o) => o.item_id === oreItem.item_id);
    if (existing) {
      existing.total_mined++;
      existing.times_seen++;
      existing.last_seen = now();
      existing.depleted = false; // Reset depleted flag on successful mining
    } else {
      poi.ores_found.push({
        item_id: oreItem.item_id,
        name: oreItem.name,
        total_mined: 1,
        times_seen: 1,
        last_seen: now(),
      });
    }

    this.scheduleSave();
  }

  /** Update POI resource data from get_poi scan. */
  updatePoiResources(systemId: string, poiId: string, resources: Array<{
    resource_id: string;
    name: string;
    richness: number;
    remaining: number;
    max_remaining: number;
    depletion_percent: number;
  }>): void {
    const sys = this.data.systems[systemId];
    if (!sys) return;

    const poi = sys.pois.find((p) => p.id === poiId);
    if (!poi) return;

    poi.resources = resources.map((r) => ({
      resource_id: r.resource_id,
      name: r.name,
      richness: r.richness,
      remaining: r.remaining,
      max_remaining: r.max_remaining,
      depletion_percent: r.depletion_percent,
      last_scanned: now(),
    }));

    poi.last_updated = now();
    this.scheduleSave();
  }

  /** Register or update a POI discovered via get_poi (including hidden POIs). */
  registerPoiFromScan(systemId: string, poiData: {
    id: string;
    name: string;
    type: string;
    hidden?: boolean;
    reveal_difficulty?: number;
    resources?: Array<{
      resource_id: string;
      name: string;
      richness: number;
      remaining: number;
      max_remaining: number;
      depletion_percent: number;
    }>;
  }): void {
    let sys = this.data.systems[systemId];
    if (!sys) {
      // Create system entry if it doesn't exist
      sys = {
        id: systemId,
        name: systemId,
        connections: [],
        pois: [],
        wormhole_exits: [],
        pirate_sightings: [],
        wrecks: [],
        last_updated: now(),
      };
      this.data.systems[systemId] = sys;
    }

    let poi = sys.pois.find((p) => p.id === poiData.id);
    if (!poi) {
      // New POI - create it
      poi = {
        id: poiData.id,
        name: poiData.name,
        type: poiData.type,
        has_base: false,
        base_id: null,
        base_name: null,
        base_type: null,
        services: [],
        ores_found: [],
        resources: [],
        market: [],
        orders: [],
        missions: [],
        last_explored: null,
        last_updated: now(),
        hidden: poiData.hidden ?? false,
        reveal_difficulty: poiData.reveal_difficulty,
      };
      sys.pois.push(poi);
    }

    // Update POI metadata (in case it changed)
    poi.name = poiData.name || poi.name;
    poi.type = poiData.type || poi.type;
    // Once a POI is marked hidden, it stays hidden - don't overwrite with false
    if (poiData.hidden) poi.hidden = poiData.hidden;
    if (poiData.reveal_difficulty !== undefined) poi.reveal_difficulty = poiData.reveal_difficulty;
    poi.last_updated = now();

    // Update resources if provided
    if (poiData.resources && poiData.resources.length > 0) {
      poi.resources = poiData.resources.map((r) => ({
        resource_id: r.resource_id,
        name: r.name,
        richness: r.richness,
        remaining: r.remaining,
        max_remaining: r.max_remaining,
        depletion_percent: r.depletion_percent,
        last_scanned: now(),
      }));
    }

    this.scheduleSave();
  }

  /** Mark an ore as depleted at a POI. */
  markOreDepleted(systemId: string, poiId: string, oreId: string): void {
    const sys = this.data.systems[systemId];
    if (!sys) return;

    const poi = sys.pois.find((p) => p.id === poiId);
    if (!poi) return;

    const existing = poi.ores_found.find((o) => o.item_id === oreId);
    if (existing) {
      existing.depleted = true;
      existing.depleted_at = now();
      this.scheduleSave();
    }
  }

  /** Record a pirate sighting in a system. */
  recordPirate(systemId: string, info: { player_id?: string; name?: string }): void {
    const sys = this.data.systems[systemId];
    if (!sys) return;

    const key = info.player_id || info.name || "unknown";
    const existing = sys.pirate_sightings.find(
      (p) => (p.player_id && p.player_id === info.player_id) || (p.name && p.name === info.name)
    );

    if (existing) {
      existing.count++;
      existing.last_seen = now();
    } else {
      sys.pirate_sightings.push({
        player_id: info.player_id,
        name: info.name || key,
        count: 1,
        last_seen: now(),
      });
    }

    this.scheduleSave();
  }

  /** Record a wreck in a system. */
  recordWreck(systemId: string, wreck: { id: string; ship_type: string; wreck_type?: string; poi_id?: string; expires_at?: string }): void {
    const sys = this.data.systems[systemId];
    if (!sys) return;

    const existing = sys.wrecks.find((w) => w.id === wreck.id);
    if (existing) {
      existing.last_seen = now();
      existing.ship_type = wreck.ship_type || existing.ship_type;
    } else {
      sys.wrecks.push({
        id: wreck.id,
        ship_type: wreck.ship_type,
        wreck_type: wreck.wreck_type,
        poi_id: wreck.poi_id,
        expires_at: wreck.expires_at,
        last_seen: now(),
      });
    }

    this.scheduleSave();
  }

  /**
   * Register a wormhole discovered via survey_system.
   * @param exitSystemId - The system where the wormhole exit is located
   * @param wormholeData - The wormhole data from survey response
   */
  registerWormhole(exitSystemId: string, wormholeData: {
    id: string;
    name: string;
    exit_system_id: string;
    exit_system_name: string;
    exit_poi_id: string;
    exit_poi_name: string;
    destination_system_id: string;
    destination_system_name: string;
    expires_in_text?: string; // e.g., "36477d 20h"
    expires_at?: string; // ISO timestamp if provided directly
  }): void {
    // Get or create the exit system
    let exitSys = this.data.systems[exitSystemId];
    if (!exitSys) {
      exitSys = {
        id: exitSystemId,
        name: wormholeData.exit_system_name || exitSystemId,
        connections: [],
        pois: [],
        wormhole_exits: [],
        pirate_sightings: [],
        wrecks: [],
        last_updated: now(),
      };
      this.data.systems[exitSystemId] = exitSys;
    }

    // Calculate expiry from expires_in_text or expires_at
    let expiresAt: string | null = null;
    if (wormholeData.expires_at) {
      expiresAt = wormholeData.expires_at;
    } else if (wormholeData.expires_in_text) {
      // Parse "36477d 20h" format
      expiresAt = calculateExpiryFromText(wormholeData.expires_in_text);
    }

    // Create wormhole record
    const wormhole: WormholeRecord = {
      id: wormholeData.id,
      name: wormholeData.name,
      entrance_system_id: wormholeData.destination_system_id, // Entrance is in the destination system
      entrance_system_name: wormholeData.destination_system_name,
      exit_system_id: exitSystemId,
      exit_system_name: exitSys.name || exitSystemId,
      exit_poi_id: wormholeData.exit_poi_id,
      exit_poi_name: wormholeData.exit_poi_name,
      destination_system_id: wormholeData.destination_system_id,
      destination_system_name: wormholeData.destination_system_name,
      discovered_at: now(),
      expires_at: expiresAt,
      is_active: true,
    };

    // Check if wormhole already exists
    const existingIndex = exitSys.wormhole_exits.findIndex((w) => w.id === wormholeData.id);
    if (existingIndex >= 0) {
      // Update existing wormhole
      exitSys.wormhole_exits[existingIndex] = {
        ...exitSys.wormhole_exits[existingIndex],
        ...wormhole,
        discovered_at: exitSys.wormhole_exits[existingIndex].discovered_at, // Preserve original discovery time
      };
    } else {
      // Add new wormhole
      exitSys.wormhole_exits.push(wormhole);
    }

    // Also ensure the entrance (destination) system exists
    const entranceSystemId = wormholeData.destination_system_id;
    let entranceSys = this.data.systems[entranceSystemId];
    if (!entranceSys) {
      entranceSys = {
        id: entranceSystemId,
        name: wormholeData.destination_system_name || entranceSystemId,
        connections: [],
        pois: [],
        wormhole_exits: [],
        pirate_sightings: [],
        wrecks: [],
        last_updated: now(),
      };
      this.data.systems[entranceSystemId] = entranceSys;
    }

    this.scheduleSave();
  }

  /**
   * Get all active (non-expired) wormholes.
   */
  getActiveWormholes(): WormholeRecord[] {
    const wormholes: WormholeRecord[] = [];
    for (const sys of Object.values(this.data.systems)) {
      for (const wh of sys.wormhole_exits || []) {
        if (isWormholeActive(wh)) {
          wormholes.push(wh);
        }
      }
    }
    return wormholes;
  }

  /**
   * Get remaining time on a wormhole as a human-readable string.
   * Returns null if wormhole doesn't exist or has no expiry.
   */
  getWormholeRemainingTime(wormholeId: string, systemId?: string): string | null {
    let wormhole: WormholeRecord | null = null;

    if (systemId) {
      const sys = this.data.systems[systemId];
      wormhole = sys?.wormhole_exits?.find((w) => w.id === wormholeId) || null;
    } else {
      // Search all systems
      for (const sys of Object.values(this.data.systems)) {
        const found = sys.wormhole_exits?.find((w) => w.id === wormholeId);
        if (found) {
          wormhole = found;
          break;
        }
      }
    }

    if (!wormhole || !wormhole.expires_at) return null;

    return calculateTimeRemaining(wormhole.expires_at);
  }

  // ── Query methods ───────────────────────────────────────

  /** Get stored system data by ID. */
  getSystem(id: string): StoredSystem | null {
    return this.data.systems[id] ?? null;
  }

  /** Return all stored system IDs. */
  getAllSystemIds(): string[] {
    return Object.keys(this.data.systems);
  }

  /** Return all stored systems with their data. */
  getSystems(): StoredSystem[] {
    return Object.values(this.data.systems);
  }

  /** Find nearest station POI within a known system. */
  findNearestStation(systemId: string): StoredPOI | null {
    const sys = this.data.systems[systemId];
    if (!sys) return null;
    return sys.pois.find((p) => p.has_base) ?? null;
  }

  /** BFS to find the nearest known system that has a station (excluding pirate and blacklisted systems). Returns { systemId, poiId, poiName, hops } or null. */
  findNearestStationSystem(fromSystemId: string, blacklist?: string[]): { systemId: string; poiId: string; poiName: string; hops: number } | null {
    const blacklistArr = Array.isArray(blacklist) ? blacklist : [];
    const blacklistSet = new Set(blacklistArr.map(s => s.toLowerCase()));
    
    // Check current system first (but skip if it's a pirate or blacklisted system)
    if (!this.isPirateSystem(fromSystemId) && !blacklistSet.has(fromSystemId.toLowerCase())) {
      const localStation = this.findNearestStation(fromSystemId);
      if (localStation) return { systemId: fromSystemId, poiId: localStation.id, poiName: localStation.name, hops: 0 };
    }

    const visited = new Set<string>([fromSystemId]);
    const queue: Array<{ id: string; hops: number }> = [{ id: fromSystemId, hops: 0 }];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const conns = this.data.systems[current.id]?.connections ?? [];

      for (const conn of conns) {
        const nextId = conn.system_id;
        if (!nextId || visited.has(nextId)) continue;
        // Skip pirate systems
        if (this.isPirateSystem(nextId)) continue;
        // Skip blacklisted systems
        if (blacklistSet.has(nextId.toLowerCase())) continue;
        visited.add(nextId);

        const station = this.findNearestStation(nextId);
        if (station) {
          return { systemId: nextId, poiId: station.id, poiName: station.name, hops: current.hops + 1 };
        }
        queue.push({ id: nextId, hops: current.hops + 1 });
      }
    }

    return null;
  }

  /** Find the best sell price for an item across all known markets (excluding pirate systems). */
  findBestSellPrice(itemId: string): { systemId: string; poiId: string; poiName: string; price: number } | null {
    let best: { systemId: string; poiId: string; poiName: string; price: number } | null = null;

    for (const [sysId, sys] of Object.entries(this.data.systems)) {
      if (this.isPirateSystem(sysId)) continue;
      for (const poi of sys.pois) {
        for (const m of poi.market) {
          if (m.item_id === itemId && m.best_sell !== null) {
            if (!best || m.best_sell > best.price) {
              best = { systemId: sysId, poiId: poi.id, poiName: poi.name, price: m.best_sell };
            }
          }
        }
      }
    }

    return best;
  }

  /** Get list of all known system IDs. */
  getKnownSystems(): string[] {
    return Object.keys(this.data.systems);
  }

  /** Get connections for a system. */
  getConnections(systemId: string): StoredConnection[] {
    return this.data.systems[systemId]?.connections ?? [];
  }

  /** Find all locations where a specific ore/resource has been mined or scanned. Checks both ores_found (mining history) and resources (scan data) so hidden POIs are included. */
  findOreLocations(oreId: string): Array<{
    systemId: string;
    systemName: string;
    poiId: string;
    poiName: string;
    totalMined: number;
    hasStation: boolean;
    /** Current remaining units from last get_poi scan (0 if never scanned) */
    remaining: number;
    /** Max remaining units from last get_poi scan */
    maxRemaining: number;
    /** Depletion percent from last get_poi scan (0-100) */
    depletionPercent: number;
    /** Minutes since last resource scan */
    minutesSinceScan: number;
    /** Whether this POI is hidden (deep core mining location) */
    isHidden: boolean;
    /** Richness of the resource (mining efficiency) */
    richness: number;
  }> {
    const results: Array<{
      systemId: string;
      systemName: string;
      poiId: string;
      poiName: string;
      totalMined: number;
      hasStation: boolean;
      remaining: number;
      maxRemaining: number;
      depletionPercent: number;
      minutesSinceScan: number;
      isHidden: boolean;
      richness: number;
    }> = [];

    for (const [sysId, sys] of Object.entries(this.data.systems)) {
      if (this.isPirateSystem(sysId)) continue;
      const hasStation = sys.pois.some((p) => p.has_base);
      for (const poi of sys.pois) {
        // Check both ores_found (mining history) AND resources (scan data)
        // Hidden POIs often only have data in resources (from get_poi scans)
        const ore = poi.ores_found.find((o) => o.item_id === oreId);
        const resource = poi.resources?.find((r) => r.resource_id === oreId);

        // Skip if resource not found in either source
        if (!ore && !resource) continue;

        const remaining = resource?.remaining ?? 0;
        const maxRemaining = resource?.max_remaining ?? 0;
        const depletionPercent = resource?.depletion_percent ?? 0;
        const richness = resource?.richness ?? 0;
        const minutesSinceScan = resource?.last_scanned
          ? (Date.now() - new Date(resource.last_scanned).getTime()) / 60000
          : Infinity;
        const totalMined = ore?.total_mined ?? 0;

        results.push({
          systemId: sysId,
          systemName: sys.name || sysId,
          poiId: poi.id,
          poiName: poi.name || poi.id,
          totalMined,
          hasStation,
          remaining,
          maxRemaining,
          depletionPercent,
          minutesSinceScan,
          isHidden: poi.hidden ?? false,
          richness,
        });
      }
    }

    results.sort((a, b) => b.totalMined - a.totalMined);
    return results;
  }

  /**
   * Estimate minutes until a resource regenerates based on availability level.
   * Model: resources regen ~25% every 3 hours (180 minutes).
   * depletion_percent from game API means "% depleted" (0 = full, 100 = empty).
   * Returns 0 if resource is not depleted enough to need regen.
   */
  estimateRegenTime(depletionPercent: number, minutesSinceScan: number): number {
    // If less than 25% depleted (more than 75% available), no regen needed
    if (depletionPercent < 25) return 0;

    // Base regen: 25% per 180 minutes
    // For every 25% depleted beyond 25% threshold, need 180 more minutes
    const depletedBeyondThreshold = depletionPercent - 25;
    const regenCycles = Math.ceil(depletedBeyondThreshold / 25);
    return regenCycles * 180;
  }

  /**
   * Find the best mining location for a resource, scored by abundance and accessibility.
   * Prefers POIs with high remaining resources, low depletion, and recent scans.
   * HEAVILY priorit hidden POIs (deep core mining) over regular POIs.
   * 
   * @param oreId - The ore/resource ID to find locations for
   * @param fromSystem - System to calculate distance from (default: faction home)
   * @param blacklist - Systems to exclude
   * @param shipSpeed - Ship jump speed (1-6, default 1). Speed 1=120s/jump, 2=110s, 3=100s, 4=80s, 5=50s, 6=30s
   * @param shipCargo - Ship cargo capacity (default 8000)
   * @param isMiningShip - Whether ship has mining ship double-cargo bonus (default false)
   */
  findBestMiningLocation(oreId: string, fromSystem?: string, blacklist?: string[], shipSpeed?: number, shipCargo?: number, isMiningShip?: boolean): Array<{
    systemId: string;
    systemName: string;
    poiId: string;
    poiName: string;
    resourceId: string;
    totalMined: number;
    hasStation: boolean;
    remaining: number;
    maxRemaining: number;
    depletionPercent: number;
    minutesSinceScan: number;
    jumpsAway: number;
    /** Whether this POI is hidden (deep core mining location) */
    isHidden: boolean;
    /** Richness of the resource (mining efficiency) */
    richness: number;
    /** Composite score: higher = better. Factors in remaining, depletion, distance, scan freshness, hidden status */
    score: number;
  }> {
    const locations = this.findOreLocations(oreId);
    const blacklistArr = Array.isArray(blacklist) ? blacklist : [];
    const blacklistSet = new Set(blacklistArr.map(s => s.toLowerCase()));
    
    // Ship parameters with defaults
    const speed = shipSpeed || 1;
    const cargo = shipCargo || 8000;
    const isMining = isMiningShip || false;
    const effectiveCargo = isMining ? cargo * 2 : cargo;
    
    // Jump times lookup for later use
    const jumpTimes: Record<number, number> = { 1: 120, 2: 110, 3: 100, 4: 80, 5: 50, 6: 30 };
    const jumpTime = jumpTimes[speed] || 120;

    const scored = locations
      .filter(loc => !blacklistSet.has(loc.systemId.toLowerCase()))
      .filter(loc => {
        // Skip completely exhausted locations (0% available = empty)
        if (loc.depletionPercent <= 0 && loc.remaining <= 0) return false;
        // Skip nearly-depleted locations (<10% available) — not worth traveling to
        if (loc.depletionPercent < 10) return false;
        return true;
      })
      .map(loc => {
        // Calculate jumps from origin
        let jumpsAway = 0;
        if (fromSystem && fromSystem !== loc.systemId) {
          const route = this.findRoute(fromSystem, loc.systemId, blacklistArr);
          jumpsAway = route ? route.length - 1 : 999;
        }

        // Score components:
        // 1. Resource abundance — based on TOTAL remaining, not percentage
        // This way, 19K remaining beats 8K remaining regardless of percentage mined
        // Capped at 100 points (equivalent to maxRemaining >= 10000)
        let abundanceScore = Math.min(100, Math.log10(loc.remaining + 1) * 15);

        // But also give bonus for high percentage (virgin systems)
        const percentAvailable = 100 - loc.depletionPercent;
        if (percentAvailable >= 95) {
          abundanceScore += 20; // Virgin system bonus
        }

        // 2. Availability bonus (0-30 points) — lower weight, just to prefer healthier systems
        const availabilityScore = (percentAvailable / 100) * 30;

        // 3. Distance penalty — Adjusted for ship speed and cargo capacity
        // Faster ships can travel further efficiently, larger cargo means fewer returns
        // Speed bonus: speed 6 is ~4x faster than speed 1, so reduce penalty by up to 60%
        // Cargo bonus: larger cargo = fewer trips back, reduce penalty proportionally
        const speedFactor = speed >= 5 ? 0.4 : speed >= 4 ? 0.6 : speed >= 3 ? 0.75 : speed >= 2 ? 0.85 : 1.0;
        const cargoFactor = Math.min(1.5, effectiveCargo / 8000); // Up to 1.5x bonus for large cargo
        
        // Base penalty (for speed 1, cargo 8000), then apply factors
        let basePenalty = 50 - jumpsAway * 3;
        if (jumpsAway > 10) {
          basePenalty -= (jumpsAway - 10) * 4;
        }
        // Apply ship bonuses
        const adjustedPenalty = basePenalty * speedFactor * (2 - cargoFactor * 0.5);
        const distanceScore = Math.max(-60, Math.round(adjustedPenalty));

        // 3b. Richness efficiency bonus (0-35 points) — rewards high richness CLOSE to current position
        // Faster ships get bonus for distant rich POIs
        const maxEfficiencyJumps = speed >= 5 ? 18 : speed >= 4 ? 15 : speed >= 3 ? 14 : 12;
        const richnessEfficiencyScore = jumpsAway <= maxEfficiencyJumps && loc.richness > 25
          ? Math.min(35, (loc.richness - 25) * (1 - jumpsAway / maxEfficiencyJumps) * 0.6)
          : 0;

        // 4. Scan freshness bonus (0-20 points)
        let freshnessScore = 20;
        if (loc.minutesSinceScan === Infinity) {
          freshnessScore = 5; // Never scanned — uncertain
        } else if (loc.minutesSinceScan > 180) {
          freshnessScore = 10; // Stale data
        }

        // 5. Depletion penalty — heavily penalize low-availability systems
        // This discourages selecting systems that are nearly empty
        // Even if they pass the 10% threshold, we still want to prefer healthier systems
        let depletionPenalty = 0;
        if (percentAvailable < 25) {
          // Linear penalty: 0% at 25% availability, -30 points at 10%
          depletionPenalty = -30 * ((25 - percentAvailable) / 15);
        }

        // 6. HIDDEN POI BONUS (CRITICAL for deep core mining)
        // Hidden POIs are exclusive, high-value locations that should be prioritized
        // They typically have: single ore type, high richness, large pools
        // Score bonus: +200 points (guarantees they beat regular POIs)
        const hiddenPoiBonus = loc.isHidden ? 200 : 0;

        // 7. Richness bonus (0-60 points)
        // Higher richness = more efficient mining (more ore per action)
        // Key insight: richness 34 is ~2x better than 15, not just additive
        // Use stronger scaling: richness * 1.5, capped at 60
        const richnessScore = Math.min(60, loc.richness * 1.5);

        const score = abundanceScore + availabilityScore + distanceScore + freshnessScore + 
                   depletionPenalty + hiddenPoiBonus + richnessScore + richnessEfficiencyScore;

        return {
          ...loc,
          resourceId: oreId,
          jumpsAway,
          score: Math.round(score * 100) / 100,
        };
      });

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  /** BFS pathfinding between two systems using known connections. Returns system IDs in order, or null if no path. */
  findRoute(fromSystemId: string, toSystemId: string, blacklist?: string[]): string[] | null {
    if (fromSystemId === toSystemId) return [fromSystemId];

    const blacklistArr = Array.isArray(blacklist) ? blacklist : [];
    const blacklistSet = new Set(blacklistArr.map(s => s.toLowerCase()));
    
    // First, check if we can use a wormhole as a shortcut
    const wormholeRoute = this.tryFindWormholeRoute(fromSystemId, toSystemId, blacklistArr);
    if (wormholeRoute) {
      return wormholeRoute;
    }
    
    // Fall back to regular BFS
    const visited = new Set<string>([fromSystemId]);
    const queue: Array<{ id: string; path: string[] }> = [
      { id: fromSystemId, path: [fromSystemId] },
    ];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const conns = this.data.systems[current.id]?.connections ?? [];

      for (const conn of conns) {
        const nextId = conn.system_id;
        if (!nextId || visited.has(nextId)) continue;
        // Skip blacklisted systems
        if (blacklistSet.has(nextId.toLowerCase())) continue;

        const newPath = [...current.path, nextId];
        if (nextId === toSystemId) return newPath;

        visited.add(nextId);
        queue.push({ id: nextId, path: newPath });
      }
    }

    return null; // No path found in known map
  }

  /**
   * Try to find a route using wormholes as shortcuts.
   * Strategy: Check if we can reach a wormhole entrance, jump through, then reach the destination.
   */
  private tryFindWormholeRoute(fromSystemId: string, toSystemId: string, blacklist: string[]): string[] | null {
    const blacklistSet = new Set(blacklist.map(s => s.toLowerCase()));
    
    // Get all active wormholes
    const activeWormholes = this.getActiveWormholes();
    
    // Find the best wormhole route (shortest total path)
    let bestRoute: string[] | null = null;
    let bestRouteLength = Infinity;
    
    for (const wormhole of activeWormholes) {
      // Check if wormhole is expired
      if (!isWormholeActive(wormhole)) continue;
      
      // Strategy 1: Can we use this wormhole to get closer to destination?
      // Route: fromSystem -> wormhole entrance (destination_system_id) -> wormhole exit (exit_system_id) -> toSystemId
      
      const entranceSystem = wormhole.destination_system_id;
      const exitSystem = wormhole.exit_system_id;
      
      // Check if entrance system is accessible
      if (blacklistSet.has(entranceSystem.toLowerCase())) continue;
      if (blacklistSet.has(exitSystem.toLowerCase())) continue;
      
      // Calculate path segments
      const toEntrance = this.findRegularBfsRoute(fromSystemId, entranceSystem, blacklist);
      const fromExitToDest = this.findRegularBfsRoute(exitSystem, toSystemId, blacklist);
      
      if (toEntrance && fromExitToDest) {
        // Valid wormhole route
        // Full route: [...toEntrance (excluding last), exitSystem, ...fromExitToDest]
        const fullRoute = [
          ...toEntrance.slice(0, -1), // Exclude entrance system itself
          exitSystem, // Jump through wormhole
          ...fromExitToDest,
        ];
        
        if (fullRoute.length < bestRouteLength) {
          bestRoute = fullRoute;
          bestRouteLength = fullRoute.length;
        }
      }
      
      // Strategy 2: Maybe the destination IS the entrance system
      // Route: fromSystem -> entrance -> (wormhole) -> exit (= destination)
      if (toSystemId === entranceSystem) {
        const toEntrance = this.findRegularBfsRoute(fromSystemId, entranceSystem, blacklist);
        if (toEntrance && toEntrance.length < bestRouteLength) {
          // Actually, no wormhole needed - just go directly
          // But we could still use the wormhole if it creates a shortcut
        }
      }
    }
    
    return bestRoute;
  }

  /** Regular BFS route finding (without wormholes) - used internally by tryFindWormholeRoute */
  private findRegularBfsRoute(fromSystemId: string, toSystemId: string, blacklist: string[]): string[] | null {
    if (fromSystemId === toSystemId) return [fromSystemId];
    
    const blacklistSet = new Set(blacklist.map(s => s.toLowerCase()));
    const visited = new Set<string>([fromSystemId]);
    const queue: Array<{ id: string; path: string[] }> = [
      { id: fromSystemId, path: [fromSystemId] },
    ];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const conns = this.data.systems[current.id]?.connections ?? [];

      for (const conn of conns) {
        const nextId = conn.system_id;
        if (!nextId || visited.has(nextId)) continue;
        if (blacklistSet.has(nextId.toLowerCase())) continue;

        const newPath = [...current.path, nextId];
        if (nextId === toSystemId) return newPath;

        visited.add(nextId);
        queue.push({ id: nextId, path: newPath });
      }
    }

    return null;
  }

  /** Get all unique ores found across all systems. Returns [{item_id, name}]. */
  getAllKnownOres(): Array<{ item_id: string; name: string }> {
    const ores = new Map<string, string>();
    for (const sys of Object.values(this.data.systems)) {
      for (const poi of sys.pois) {
        // From mining results (ores_found)
        for (const ore of poi.ores_found) {
          if (ore.item_id && !ores.has(ore.item_id)) {
            ores.set(ore.item_id, ore.name || ore.item_id);
          }
        }
        // From POI scans (resources)
        for (const res of poi.resources || []) {
          if (res.resource_id && !ores.has(res.resource_id)) {
            ores.set(res.resource_id, res.name || res.resource_id);
          }
        }
      }
    }
    return [...ores.entries()]
      .map(([item_id, name]) => ({ item_id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Find the best buy price (highest buyer) for an item across all known markets (excluding pirate systems). */
  findBestBuyPrice(itemId: string): { systemId: string; poiId: string; poiName: string; price: number; quantity: number } | null {
    let best: { systemId: string; poiId: string; poiName: string; price: number; quantity: number } | null = null;

    for (const [sysId, sys] of Object.entries(this.data.systems)) {
      if (this.isPirateSystem(sysId)) continue;
      for (const poi of sys.pois) {
        for (const m of poi.market) {
          if (m.item_id === itemId && m.best_buy !== null && m.buy_quantity > 0) {
            if (!best || m.best_buy > best.price) {
              best = { systemId: sysId, poiId: poi.id, poiName: poi.name, price: m.best_buy, quantity: m.buy_quantity };
            }
          }
        }
      }
    }

    return best;
  }

  /** Find all items with buy orders across all known stations (excluding pirate systems). */
  getAllBuyDemand(): Array<{ itemId: string; itemName: string; systemId: string; poiId: string; poiName: string; price: number; quantity: number }> {
    const results: Array<{ itemId: string; itemName: string; systemId: string; poiId: string; poiName: string; price: number; quantity: number }> = [];

    for (const [sysId, sys] of Object.entries(this.data.systems)) {
      // Skip pirate systems
      if (this.isPirateSystem(sysId)) continue;
      for (const poi of sys.pois) {
        // Only include POIs with a dockable station (has_base)
        if (!poi.has_base) continue;
        for (const m of poi.market) {
          if (m.best_buy !== null && m.buy_quantity > 0) {
            results.push({
              itemId: m.item_id,
              itemName: m.item_name,
              systemId: sysId,
              poiId: poi.id,
              poiName: poi.name,
              price: m.best_buy,
              quantity: m.buy_quantity,
            });
          }
        }
      }
    }

    return results;
  }

  /** Find price spreads for an item or all items between stations (excluding pirate systems).
   *  Returns opportunities where an item can be bought cheaply and sold at a higher price. */
  findPriceSpreads(itemId?: string): Array<{
    itemId: string; itemName: string;
    sourceSystem: string; sourcePoi: string; sourcePoiName: string; buyAt: number; buyQty: number;
    destSystem: string; destPoi: string; destPoiName: string; sellAt: number; sellQty: number;
    spread: number;
  }> {
    // Collect all sell listings (where we can buy from NPC market)
    const sellListings: Array<{ itemId: string; itemName: string; systemId: string; poiId: string; poiName: string; price: number; quantity: number }> = [];
    // Collect all buy listings (where we can sell to NPC market / fill buy orders)
    const buyListings: Array<{ itemId: string; itemName: string; systemId: string; poiId: string; poiName: string; price: number; quantity: number }> = [];

    for (const [sysId, sys] of Object.entries(this.data.systems)) {
      // Skip pirate systems
      if (this.isPirateSystem(sysId)) continue;
      for (const poi of sys.pois) {
        // Only include POIs with a dockable station
        if (!poi.has_base) continue;
        for (const m of poi.market) {
          if (itemId && m.item_id !== itemId) continue;
          if (m.best_sell !== null && m.best_sell > 0 && m.sell_quantity > 0) {
            sellListings.push({ itemId: m.item_id, itemName: m.item_name, systemId: sysId, poiId: poi.id, poiName: poi.name, price: m.best_sell, quantity: m.sell_quantity });
          }
          if (m.best_buy !== null && m.best_buy > 0 && m.buy_quantity > 0) {
            buyListings.push({ itemId: m.item_id, itemName: m.item_name, systemId: sysId, poiId: poi.id, poiName: poi.name, price: m.best_buy, quantity: m.buy_quantity });
          }
        }
      }
    }

    const results: Array<{
      itemId: string; itemName: string;
      sourceSystem: string; sourcePoi: string; sourcePoiName: string; buyAt: number; buyQty: number;
      destSystem: string; destPoi: string; destPoiName: string; sellAt: number; sellQty: number;
      spread: number;
    }> = [];

    // Match: buy cheaply at source (sell listing), sell expensively at dest (buy listing)
    for (const sell of sellListings) {
      for (const buy of buyListings) {
        if (sell.itemId !== buy.itemId) continue;
        if (sell.systemId === buy.systemId && sell.poiId === buy.poiId) continue; // same station
        const spread = buy.price - sell.price;
        if (spread <= 0) continue;

        results.push({
          itemId: sell.itemId,
          itemName: sell.itemName,
          sourceSystem: sell.systemId,
          sourcePoi: sell.poiId,
          sourcePoiName: sell.poiName,
          buyAt: sell.price,
          buyQty: sell.quantity,
          destSystem: buy.systemId,
          destPoi: buy.poiId,
          destPoiName: buy.poiName,
          sellAt: buy.price,
          sellQty: buy.quantity,
          spread,
        });
      }
    }

    results.sort((a, b) => b.spread - a.spread);
    return results;
  }

  /**
   * Seed the galaxy map from the public /api/map endpoint.
   * Adds all systems and their connections without requiring any bot session.
   * Existing POI, market, and ore data is preserved — only system metadata
   * and connection graphs are updated.
   */
  async seedFromMapAPI(): Promise<{ seeded: number; known: number; failed: boolean }> {
    const MAP_API_URL = "https://game.spacemolt.com/api/map";
    let raw: Record<string, unknown>;
    try {
      raw = await cachedFetch<Record<string, unknown>>(MAP_API_URL, 30 * 60_000, { // 30min fallback TTL
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return { seeded: 0, known: 0, failed: true };
    }
    try {
      const systems = Array.isArray(raw.systems)
        ? (raw.systems as Array<Record<string, unknown>>)
        : [];

      if (systems.length === 0) return { seeded: 0, known: 0, failed: true };

      // Build ID → name lookup so connections can be resolved to names
      const nameById = new Map<string, string>();
      for (const sys of systems) {
        const id = sys.id as string;
        const name = sys.name as string;
        if (id && name) nameById.set(id, name);
      }

      let seeded = 0;
      let known = 0;

      for (const sys of systems) {
        const id = sys.id as string;
        if (!id) continue;

        if (this.data.systems[id]) {
          known++;
        } else {
          seeded++;
        }

        // Transform connection ID array → StoredConnection objects
        const rawConns = sys.connections;
        const connections: Array<Record<string, unknown>> = Array.isArray(rawConns)
          ? (rawConns as string[]).map((connId) => ({
              system_id: connId,
              system_name: nameById.get(connId) || connId,
            }))
          : [];

        this.updateSystem({ ...sys, connections });
      }

      return { seeded, known, failed: false };
    } catch {
      return { seeded: 0, known: 0, failed: true };
    }
  }

  /** Return the full systems map for the web dashboard. */
  getAllSystems(): Record<string, StoredSystem> {
    return this.data.systems;
  }

  // ── Mobile Capitol Tracking ───────────────────────────────

  /**
   * Update the mobile_capitol station's current location.
   * Call this when a bot visits the mobile_capitol and discovers its new system.
   */
  updateMobileCapitolLocation(systemId: string, systemName: string, poiId: string): void {
    const previous = this.data.mobile_capitol;
    if (previous && previous.system_id === systemId && previous.poi_id === poiId) {
      // Already at this location, just refresh timestamp
      this.data.mobile_capitol = { ...previous, discovered_at: now() };
    } else {
      if (previous) {
        log("map", `Mobile capitol moved: ${previous.system_name} → ${systemName}`);
      }
      this.data.mobile_capitol = {
        system_id: systemId,
        system_name: systemName,
        poi_id: poiId,
        discovered_at: now(),
      };
    }
    this.scheduleSave();
  }

  /**
   * Get the current known location of the mobile_capitol station.
   * Returns null if the location has not been discovered yet.
   */
  getMobileCapitolLocation(): { systemId: string; systemName: string; poiId: string; discoveredAt: string } | null {
    if (!this.data.mobile_capitol) return null;
    const mc = this.data.mobile_capitol;
    return {
      systemId: mc.system_id,
      systemName: mc.system_name,
      poiId: mc.poi_id,
      discoveredAt: mc.discovered_at,
    };
  }

  /**
   * Check if a POI is the mobile_capitol station.
   * Returns true if the system_id and poi_id match the current known location.
   */
  isMobileCapitol(systemId: string, poiId: string): boolean {
    if (!this.data.mobile_capitol) return false;
    return this.data.mobile_capitol.system_id === systemId && 
           this.data.mobile_capitol.poi_id === poiId;
  }

  findStationInSystem(systemId: string, stationIdPattern?: string): { poiId: string; poiName: string; baseId: string } | null {
    const sys = this.data.systems[systemId];
    if (!sys) return null;
    
    for (const poi of sys.pois) {
      if (!poi.has_base) continue;
      
      if (stationIdPattern) {
        const normalizedPattern = stationIdPattern.toLowerCase().replace(/_/g, ' ');
        const normalizedPoiId = poi.id.toLowerCase().replace(/_/g, ' ');
        const normalizedBaseId = (poi.base_id || '').toLowerCase().replace(/_/g, ' ');
        
        if (normalizedPoiId.includes(normalizedPattern) || 
            normalizedBaseId.includes(normalizedPattern) ||
            poi.name.toLowerCase().replace(/_/g, ' ').includes(normalizedPattern)) {
          return {
            poiId: poi.id,
            poiName: poi.name,
            baseId: poi.base_id || poi.id,
          };
        }
      } else {
        return {
          poiId: poi.id,
          poiName: poi.name,
          baseId: poi.base_id || poi.id,
        };
      }
    }
    
    return null;
  }

  /** Formatted summary string for menu display. */
  getSummary(): string {
    const systems = Object.values(this.data.systems);
    if (systems.length === 0) {
      return "Galaxy map is empty. Start a bot to begin mapping!";
    }

    const lines: string[] = [];
    lines.push(`=== Galaxy Map ===`);
    lines.push(`Known systems: ${systems.length}`);
    lines.push(`Last saved: ${this.data.last_saved}`);
    lines.push("");

    for (const sys of systems) {
      const security = sys.security_level ? ` [${sys.security_level}]` : "";
      lines.push(`--- ${sys.name || sys.id}${security} ---`);

      if (sys.connections.length > 0) {
        lines.push(`  Connections: ${sys.connections.map((c) => c.system_name || c.system_id).join(", ")}`);
      }

      // Show asteroid belts first with ore details
      const belts = sys.pois.filter((p) => p.type.toLowerCase().includes("asteroid"));
      const others = sys.pois.filter((p) => !p.type.toLowerCase().includes("asteroid"));

      for (const poi of belts) {
        const oreList = poi.ores_found.length > 0
          ? poi.ores_found.map((o) => `${o.name} x${o.total_mined}`).join(", ")
          : "no data yet";
        lines.push(`  * ${poi.name} [${poi.type}]`);
        lines.push(`    Ores: ${oreList}`);
      }

      for (const poi of others) {
        const base = poi.has_base ? ` (${poi.base_name || "base"})` : "";
        lines.push(`  ${poi.name} [${poi.type}]${base}`);

        if (poi.market.length > 0) {
          const prices = poi.market
            .filter((m) => m.best_sell !== null || m.best_buy !== null)
            .map((m) => {
              const parts = [m.item_name];
              if (m.best_buy !== null) parts.push(`buy:${m.best_buy}`);
              if (m.best_sell !== null) parts.push(`sell:${m.best_sell}`);
              return parts.join(" ");
            });
          if (prices.length > 0) {
            lines.push(`    Market: ${prices.join(" | ")}`);
          }
        }
      }

      if (sys.pirate_sightings.length > 0) {
        const pirates = sys.pirate_sightings.map((p) => `${p.name || p.player_id} (x${p.count})`).join(", ");
        lines.push(`  Pirates: ${pirates}`);
      }

      if (sys.wrecks.length > 0) {
        lines.push(`  Wrecks: ${sys.wrecks.length}`);
      }

      lines.push("");
    }

    return lines.join("\n");
  }
}

function now(): string {
  return new Date().toISOString();
}

/** Singleton instance shared by all bots. */
export const mapStore = new MapStore();
