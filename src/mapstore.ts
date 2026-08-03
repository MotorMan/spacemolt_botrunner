import { existsSync, mkdirSync, readFileSync, writeFileSync, writeFile, copyFileSync } from "fs";
import { join } from "path";
import { cachedFetch } from "./httpcache.js";
import { log } from "./ui.js";
import { calculatePathfinderBearing, computePathfinderBearingToTarget, simulatePathfinderLanding, reverseBearing, formatBearing, getPathfinderTravelTime, PATHFINDER_LANDING_MARGIN, PATHFINDER_SPEED, type SystemPosition, type PathfinderResult } from "./pathfinder.js";
import { onPoiUpdate } from "./client_sync_hooks.js";
import { perf } from "./perf.js";

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
  /** True for ore entries seeded from seed_map.json (static hints, not real scan data). */
  seed?: boolean;
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
  depleted?: boolean;
  depleted_at?: string;
  supported_power?: number;
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
  /** Undefined when a POI has never been scan-scanned (or is a seed hint). An empty [] means a real scan found nothing. */
  resources?: ResourceRecord[];
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
  /** Galactic coordinates (from get_map or public /api/map) */
  position?: { x: number; y: number };
  connections: StoredConnection[];
  pois: StoredPOI[];
  /** Wormholes that have an exit in this system */
  wormhole_exits: WormholeRecord[];
  pirate_sightings: PirateSighting[];
  wrecks: WreckRecord[];
  last_updated: string;
  /** Server-verified visited status from get_map */
  visited?: boolean;
  /** ISO timestamp of first visit from get_map */
  visited_at?: string | null;
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

// ── Station identity cross-referencing ─────────────────────
//
// A station can be referenced several ways: by its POI hex id (e.g.
// "d1c54e3a473f4d3ce9c7603c5e0c6b38"), by its friendly POI name (e.g.
// "crosshaven_station"), by its base id/name, or as a "system|poi" pair. The
// game occasionally reports a station only as an unresolved hex id, while the
// user's config may use a friendly name (or vice versa). Comparing those
// references with a raw string equality check makes the bot think it is NOT at
// the destination and can misroute or lose cargo. These helpers resolve any
// station reference into a single canonical identity (carrying BOTH the hex id
// and the friendly name) and compare two references so that a hex id and a name
// that point at the same station are treated as equal.

export interface ResolvedStation {
  /** Resolved system id, or null if unknown. */
  systemId: string | null;
  /** Resolved POI hex id, or the raw token if unresolved. */
  poiId: string | null;
  /** Resolved friendly POI name, or null if not known. */
  poiName: string | null;
  /** True if the reference matched a POI in the map. */
  matched: boolean;
}

// ── MapStore singleton ──────────────────────────────────────

const DATA_DIR = join(process.cwd(), "data");
const MAP_FILE = join(DATA_DIR, "map.json");
const SAVE_DEBOUNCE_MS = 5000;
const BACKUP_DIR = join(DATA_DIR, "Backups");
const BACKUP_FILES = [
  'map.json',
  'customsStops.json',
  'factionTradeCoordination.json',
  'fcStations.json',
  'fullPlayerInfo.json',
  'marketDetails.json',
  'rawMissions.json',
  'rescueActivity.json',
  'rescueBlackBook.json',
  'settings.json',
  'shipsForSale.json',
  'traderActivity.json',
  'traderProfitDebug.csv',
  'transportProfitDebug.csv',
];

class MapStore {
  private data: MapData;
  private dirty = false;
  private mapGeneration = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private backupTimer: ReturnType<typeof setInterval> | null = null;
  // Guard so two async disk writes never overlap (which would race on the file).
  private writeInFlight = false;
  private writeQueued = false;
  private precalcRoutes: Record<string, Record<string, string[] | null>> = {};
  private precalcNoPirateRoutes: Record<string, Record<string, string[] | null>> = {};

  constructor() {
    this.data = this.load();
    // Only seed when the live map is empty (fresh bootstrap). A populated
    // data/map.json is never modified here, so the running client is safe.
    if (Object.keys(this.data.systems).length === 0) {
      this.mergeSeedMap();
    }
    this.loadPrecalcRoutes();
    if (!existsSync(BACKUP_DIR)) {
      mkdirSync(BACKUP_DIR, { recursive: true });
    }
    this.backupTimer = setInterval(() => this.performBackup(), 30 * 60 * 1000);
  }

  /**
   * Merge the static seed map (seed_map.json in the project root) into the
   * in-memory store. Seed POIs carry ores_found entries flagged `seed: true`
   * and omit `resources`, so findOreLocations treats them as ore hints that a
   * real get_poi scan later overrides. No save is scheduled here — persistence
   * happens via the client's own normal update/save flow, so data/map.json is
   * never written by this method.
   */
  private mergeSeedMap(): void {
    const seedFile = join(process.cwd(), "seed_map.json");
    if (!existsSync(seedFile)) return;
    try {
      const raw = readFileSync(seedFile, "utf-8");
      const seed = JSON.parse(raw) as MapData;
      for (const [sid, seedSys] of Object.entries(seed.systems)) {
        const existing = this.data.systems[sid];
        if (!existing) {
          this.data.systems[sid] = seedSys;
          continue;
        }
        const existingPois = new Map(existing.pois.map((p) => [p.id, p]));
        for (const seedPoi of seedSys.pois) {
          const ep = existingPois.get(seedPoi.id);
          if (!ep) {
            existing.pois.push(seedPoi);
            continue;
          }
          const have = new Set((ep.ores_found || []).map((o) => o.item_id));
          for (const so of seedPoi.ores_found || []) {
            if (!have.has(so.item_id)) ep.ores_found.push(so);
          }
        }
      }
      log("info", `Merged seed map (${Object.keys(seed.systems).length} systems) into empty store`);
    } catch (e) {
      log("error", `Failed to merge seed map: ${e}`);
    }
  }

  private loadPrecalcRoutes(): void {
    const precalcFile = join(DATA_DIR, "preCalcMap.json");
    const precalcNoPirateFile = join(DATA_DIR, "preCalcMap_noPirate.json");
    
    if (existsSync(precalcFile)) {
      try {
        const raw = readFileSync(precalcFile, "utf-8");
        const parsed = JSON.parse(raw) as { routes: Record<string, Record<string, string[] | null>> };
        this.precalcRoutes = parsed.routes || {};
      } catch {}
    }
    
    if (existsSync(precalcNoPirateFile)) {
      try {
        const raw = readFileSync(precalcNoPirateFile, "utf-8");
        const parsed = JSON.parse(raw) as { routes: Record<string, Record<string, string[] | null>> };
        this.precalcNoPirateRoutes = parsed.routes || {};
      } catch {}
    }
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
    // First-time bootstrap: if map.json doesn't exist yet, copy the seed map
    // so miners have ore locations available from the very first start.
    if (!existsSync(MAP_FILE)) {
      const seedFile = join(DATA_DIR, "seed_map.json");
      if (existsSync(seedFile)) {
        try {
          copyFileSync(seedFile, MAP_FILE);
          log("info", "Initialized data/map.json from seed_map.json (first start)");
        } catch (e) {
          log("error", `Failed to bootstrap map from seed: ${e}`);
        }
      }
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
    this.mapGeneration++;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.writeToDisk();
    }, SAVE_DEBOUNCE_MS);
  }

  private writeToDisk(): void {
    if (!this.dirty) return;
    if (this.writeInFlight) {
      // A write is already in progress; mark that we still have pending
      // changes so another write runs once the current one finishes.
      this.writeQueued = true;
      return;
    }
    this.writeInFlight = true;
    this.dirty = false;
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }
    this.data.last_saved = now();
    const payload = JSON.stringify(this.data, null, 2) + "\n";
    // Write asynchronously so the (single-threaded) event loop is never blocked
    // by a multi-MB map write — otherwise active bots exploring+save map would
    // stall the web server and delay every other client's connection.
    writeFile(MAP_FILE, payload, "utf-8", (err) => {
      this.writeInFlight = false;
      if (err) {
        this.dirty = true;
        log("error", `Failed to write map.json: ${err}`);
      }
      if (this.writeQueued) {
        this.writeQueued = false;
        this.writeToDisk();
      }
    });
  }

  /** Flush pending writes to disk immediately. Call on shutdown. */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.backupTimer) {
      clearInterval(this.backupTimer);
      this.backupTimer = null;
    }
    // Synchronous flush on shutdown so pending changes are guaranteed on disk.
    if (this.dirty) {
      this.dirty = false;
      this.data.last_saved = now();
      if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(MAP_FILE, JSON.stringify(this.data, null, 2) + "\n", "utf-8");
    }
  }

  getMapGeneration(): number {
    return this.mapGeneration;
  }

  private getTimestamp(): string {
    const now = new Date();
    return now.getFullYear() + '-' +
      (now.getMonth() + 1).toString().padStart(2, '0') + '-' +
      now.getDate().toString().padStart(2, '0') + '_' +
      now.getHours().toString().padStart(2, '0') + '-' +
      now.getMinutes().toString().padStart(2, '0') + '-' +
      now.getSeconds().toString().padStart(2, '0');
  }

  private performBackup(): void {
    const timestamp = this.getTimestamp();
    for (const file of BACKUP_FILES) {
      const src = join(DATA_DIR, file);
      if (existsSync(src)) {
        const dest = join(BACKUP_DIR, `${file}_${timestamp}`);
        try {
          copyFileSync(src, dest);
        } catch (e) {
          log("error", `Failed to backup ${file}: ${e}`);
        }
      }
    }
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

    // Merge position (supports nested "position": {x,y} from get_map and flat x,y from public /api/map)
    let posX: number | undefined;
    let posY: number | undefined;
    const nestedPos = systemData.position as Record<string, unknown> | undefined;
    if (nestedPos && typeof nestedPos.x === "number" && typeof nestedPos.y === "number") {
      posX = nestedPos.x;
      posY = nestedPos.y;
    } else if (typeof systemData.x === "number" && typeof systemData.y === "number") {
      posX = systemData.x as number;
      posY = systemData.y as number;
    }
    if (typeof posX === "number" && typeof posY === "number") {
      sys.position = { x: posX, y: posY };
    }

    sys.last_updated = now();

    // Merge visited status from get_map
    if (systemData.visited !== undefined) {
      sys.visited = Boolean(systemData.visited);
    }
    if (systemData.visited_at !== undefined) {
      sys.visited_at = (systemData.visited_at as string) || null;
    }

    // Merge connections
    const conns = systemData.connections as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(conns)) {
      sys.connections = conns.map((c) => {
        // Handle both string format and object format for connections
        let id: string;
        let name: string;
        let jumpCost: number | undefined;
        
        if (typeof c === "string") {
          id = c;
          name = c;
          jumpCost = undefined;
        } else if (typeof c === "object" && c !== null) {
          const connObj = c as Record<string, unknown>;
          id = (connObj.system_id as string) || (connObj.id as string) || "";
          name = (connObj.system_name as string) || (connObj.name as string) || id;
          jumpCost = connObj.jump_cost as number | undefined;
        } else {
          id = "";
          name = "";
          jumpCost = undefined;
        }
        
        return {
          system_id: id,
          system_name: name,
          security_level: (c && typeof c === "object" ? ((c as Record<string, unknown>).security_level as string) || (c as Record<string, unknown>).security_status as string || (c as Record<string, unknown>).lawfulness as string || (c as Record<string, unknown>).security as string : undefined),
          jump_cost: jumpCost,
          distance: c && typeof c === "object" ? (c as Record<string, unknown>).distance as number | undefined : undefined,
        };
      }).filter(conn => conn.system_id !== ""); // Filter out connections with empty IDs
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
          // Preserve undefined (not default to []) so seeded POIs that omit
          // `resources` remain authoritative via ores_found until a real get_poi
          // scan populates `resources`. A genuinely scanned-empty POI gets []
          // from updatePoiResources, preserving the "ore not present" guard.
          resources: prev?.resources,
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
    void onPoiUpdate(id, systemData as Record<string, unknown>);
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
  }

  /** Remove an item from a station's cached market data (e.g. when buy fails with item_not_available). */
  removeMarketItem(systemId: string, poiId: string, itemId: string): void {
    const sys = this.data.systems[systemId];
    if (!sys) return;
    const poi = sys.pois.find((p) => p.id === poiId);
    if (!poi) return;
    const before = poi.market.length;
    poi.market = poi.market.filter((m) => m.item_id !== itemId);
    if (poi.market.length < before) {
      // Intentionally no scheduleSave() here — market data is persisted
      // exclusively through marketDetails.json, not map.json.
    }
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

  /** Mark a system as visited (sets visited=true and visited_at timestamp). */
  markSystemVisited(systemId: string): void {
    const sys = this.data.systems[systemId];
    if (!sys) return;

    sys.visited = true;
    sys.visited_at = now();
    sys.last_updated = now();
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
      existing.seed = false; // Real mining converts a seed hint into real data
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
    supported_power?: number;
 }>): void {
    const sys = this.data.systems[systemId];
    if (!sys) return;

    const poi = sys.pois.find((p) => p.id === poiId);
    if (!poi) return;

    const timestamp = now();
    poi.resources = resources
      .filter((r) => r.remaining <= r.max_remaining)
      .map((r) => ({
        resource_id: r.resource_id,
        name: r.name,
        richness: r.richness,
        remaining: r.remaining,
        max_remaining: r.max_remaining,
        depletion_percent: r.depletion_percent,
        last_scanned: timestamp,
        supported_power: r.supported_power,
      }));

    poi.last_updated = timestamp;
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
      supported_power?: number;
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
      poi.resources = poiData.resources
        .filter((r) => r.remaining <= r.max_remaining)
        .map((r) => ({
          resource_id: r.resource_id,
          name: r.name,
          richness: r.richness,
          remaining: r.remaining,
          max_remaining: r.max_remaining,
          depletion_percent: r.depletion_percent,
          last_scanned: now(),
          supported_power: r.supported_power,
        }));
    }

    this.scheduleSave();
    void onPoiUpdate(systemId, poiData as Record<string, unknown>);
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

  /** Clear all resource data from a POI. Use when POI data is known to be corrupted or outdated. */
  clearPoiResources(systemId: string, poiId: string): void {
    const sys = this.data.systems[systemId];
    if (!sys) return;

    const poi = sys.pois.find((p) => p.id === poiId);
    if (!poi) return;

    poi.resources = [];
    poi.ores_found = [];
    poi.last_updated = now();
    this.scheduleSave();
  }

  /** Reset a POI to its initial state, clearing all discovered data. */
  resetPoi(systemId: string, poiId: string): void {
    const sys = this.data.systems[systemId];
    if (!sys) return;

    const poi = sys.pois.find((p) => p.id === poiId);
    if (!poi) return;

    poi.ores_found = [];
    poi.resources = [];
    poi.market = [];
    poi.orders = [];
    poi.missions = [];
    poi.last_explored = null;
    poi.last_updated = now();
    this.scheduleSave();
  }

  /** Check if a resource record has corrupted data (remaining > max_remaining). */
  private isResourceCorrupted(resource: ResourceRecord): boolean {
    return resource.remaining > resource.max_remaining;
  }

  /** Check if a POI has any corrupted resource data. */
  hasCorruptedResources(systemId: string, poiId: string): boolean {
    const sys = this.data.systems[systemId];
    if (!sys) return false;

    const poi = sys.pois.find((p) => p.id === poiId);
    if (!poi || !poi.resources) return false;

    return poi.resources.some((r) => this.isResourceCorrupted(r));
  }

  /** Reset all POIs with corrupted resource data across the entire map. */
  resetCorruptedPois(): { reset: number; total: number } {
    let resetCount = 0;
    let totalCount = 0;

    for (const [sysId, sys] of Object.entries(this.data.systems)) {
      for (const poi of sys.pois) {
        if (poi.resources && poi.resources.some((r) => this.isResourceCorrupted(r))) {
          totalCount++;
          this.clearPoiResources(sysId, poi.id);
          resetCount++;
        }
      }
    }

    return { reset: resetCount, total: totalCount };
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

  /** Get stored system data by ID (case-insensitive lookup). */
  getSystem(id: string): StoredSystem | null {
    if (!id) return null;
    // First try exact match (most common case)
    if (this.data.systems[id]) return this.data.systems[id];
    // Then try case-insensitive match
    const lower = id.toLowerCase();
    for (const sysId of Object.keys(this.data.systems)) {
      if (sysId.toLowerCase() === lower) return this.data.systems[sysId];
    }
    return null;
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
    return sys.pois.find((p) => (p.has_base || !!p.base_id) && p.market && p.market.length > 0) ?? null;
  }

  /** BFS to find the nearest known system that has a station (excluding pirate and blacklisted systems).
   *  If approvedSet is provided, only stations whose poiId or "system|poiId" is in the set are considered.
   *  Returns { systemId, poiId, poiName, hops } or null. */
  findNearestStationSystem(fromSystemId: string, blacklist?: string[], approvedSet?: Set<string>): { systemId: string; poiId: string; poiName: string; hops: number } | null {
    const blacklistArr = Array.isArray(blacklist) ? blacklist : [];
    const blacklistSet = new Set(blacklistArr.map(s => s.toLowerCase()));

    const isApproved = (sysId: string, poiId: string): boolean => {
      if (!approvedSet || approvedSet.size === 0) return true;
      if (approvedSet.has(poiId)) return true;
      if (approvedSet.has(`${sysId}|${poiId}`)) return true;
      return false;
    };

    // Check current system first (but skip if it's a pirate or blacklisted system)
    if (!this.isPirateSystem(fromSystemId) && !blacklistSet.has(fromSystemId.toLowerCase())) {
      const sys = this.data.systems[fromSystemId];
      if (sys) {
        const localStation = sys.pois.find((p) => (p.has_base || !!p.base_id) && isApproved(fromSystemId, p.id));
        if (localStation) return { systemId: fromSystemId, poiId: localStation.id, poiName: localStation.name, hops: 0 };
      }
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

        const nextSys = this.data.systems[nextId];
        const station = nextSys?.pois.find((p) => (p.has_base || !!p.base_id) && isApproved(nextId, p.id));
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

  /** Get connections for a system (case-insensitive lookup). */
  getConnections(systemId: string): StoredConnection[] {
    const sys = this.getSystem(systemId);
    return sys?.connections ?? [];
  }

/** Find all locations where a specific ore/resource has been mined or scanned. Checks both ores_found (mining history) and resources (scan data) so hidden POIs are included.
   *  @param blacklist - Optional blacklist for route calculation.
   *  @param skipPirateSystems - Whether to skip pirate systems (default: true). Set to false when cloaked with cloakIgnoreBlacklist.
   */
  findOreLocations(oreId: string, blacklist?: string[], skipPirateSystems: boolean = true): Array<{
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
    /** Supported power - max mining power that can extract from this deposit */
    supportedPower: number;
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
      supportedPower: number;
    }> = [];

    const blacklistArr = Array.isArray(blacklist) ? blacklist : [];
    const blacklistSet = new Set(blacklistArr.map(s => s.toLowerCase()));

    for (const [sysId, sys] of Object.entries(this.data.systems)) {
      if (skipPirateSystems && this.isPirateSystem(sysId)) {
        continue;
      }
      const hasStation = sys.pois.some((p) => p.has_base || !!p.base_id);
      for (const poi of sys.pois) {
        // Skip POIs with corrupted resource data
        if (poi.resources && poi.resources.some((r) => r.remaining > r.max_remaining)) {
          continue;
        }

        // CRITICAL FIX: Only skip POIs where the SPECIFIC oreId being searched is exhausted.
        // Previously this skipped any POI with ANY exhausted resource, so a POI containing
        // iron_ore + copper_ore would be skipped when searching for iron_ore if copper was depleted.
        const targetOre = poi.ores_found.find((o) => o.item_id === oreId);
        const targetResource = poi.resources?.find((r) => r.resource_id === oreId);
        const targetRemaining = targetResource?.remaining ?? 0;
        const targetMaxRemaining = targetResource?.max_remaining ?? 0;
        if (targetRemaining <= 0 && targetMaxRemaining > 0) {
          continue;
        }
        if (targetOre?.depleted && !isDepletionExpired(targetOre.depleted_at)) {
          continue;
        }

        // Check both ores_found (mining history) AND resources (scan data)
        // Hidden POIs often only have data in resources (from get_poi scans)
        const ore = poi.ores_found.find((o) => o.item_id === oreId);
        const resource = poi.resources?.find((r) => r.resource_id === oreId);

        // Skip POIs that don't have this specific ore/resource
        // CRITICAL FIX: If resources data exists (from get_poi scans), the ore MUST be in resources.
        // ores_found alone is stale history and can lead to death loops when the ore is no longer there.
        // Only trust ores_found if resources data doesn't exist for this POI at all (undefined, not empty array).
        const hasResourcesData = poi.resources !== undefined;
        if (hasResourcesData) {
          // We have scan data - ore must be in resources to be valid
          // An empty resources array [] means the ore was scanned and is NOT present
          if (!resource) {
            continue;
          }
        } else {
          // No scan data - fall back to mining history (ores_found)
          if (!ore && !resource) {
            continue;
          }
        }

        const remaining = resource?.remaining ?? 0;
        const maxRemaining = resource?.max_remaining ?? 0;
        const depletionPercent = resource?.depletion_percent ?? 0;
        const richness = resource?.richness ?? 0;
        const supportedPower = resource?.supported_power ?? 0;
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
           supportedPower,
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
const locations = this.findOreLocations(oreId, blacklist);
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
        // Skip completely exhausted locations (0 remaining AND was scanned with maxRemaining > 0)
        // Don't filter out unsurveyed locations (where maxRemaining is also 0)
        if (loc.remaining <= 0 && loc.maxRemaining > 0) return false;
        // Skip nearly-depleted locations (>90% depleted = <10% available)
        if (loc.depletionPercent > 90) return false;
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

  /** Return best scored, non-depleted location restricted to a single system, or [] if none. */
  findBestMiningLocationInSystem(
    oreId: string,
    systemId: string,
    fromSystem?: string,
    blacklist?: string[],
    shipSpeed?: number,
    shipCargo?: number,
    isMiningShip?: boolean,
  ): Array<{
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
    isHidden: boolean;
    richness: number;
    score: number;
  }> {
    const allScored = this.findBestMiningLocation(oreId, fromSystem, blacklist, shipSpeed, shipCargo, isMiningShip);
    return allScored.filter(loc => loc.systemId === systemId);
  }

  /** Simple selector for common ores: closest system first, then biggest remaining pool.
   *  Skips POIs where the specific ore is fully exhausted or on depletion timer.
   *  Used for strip-miner ores (iron, copper, carbon, lead, silicon, aluminum) which are plentiful. */
  findClosestMiningLocations(
    oreId: string,
    fromSystem?: string,
    blacklist?: string[],
  ): Array<{
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
    isHidden: boolean;
    richness: number;
    score: number;
  }> {
const locations = this.findOreLocations(oreId, blacklist);
    const blacklistArr = Array.isArray(blacklist) ? blacklist : [];
    const blacklistSet = new Set(blacklistArr.map(s => s.toLowerCase()));

    const results: Array<{
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
      isHidden: boolean;
      richness: number;
      score: number;
    }> = [];

    for (const loc of locations) {
      if (blacklistSet.has(loc.systemId.toLowerCase())) continue;
      if (loc.remaining <= 0 && loc.maxRemaining > 0) continue;
      const sys = this.data.systems[loc.systemId];
      const poi = sys?.pois.find(p => p.id === loc.poiId);
      const oreEntry = poi?.ores_found.find(o => o.item_id === oreId);
      if (oreEntry?.depleted && !isDepletionExpired(oreEntry.depleted_at)) continue;

      let jumpsAway = 0;
      if (fromSystem && fromSystem !== loc.systemId) {
        const route = this.findRoute(fromSystem, loc.systemId, blacklistArr);
        jumpsAway = route ? route.length - 1 : -1;
      }

      results.push({
        ...loc,
        resourceId: oreId,
        jumpsAway,
        score: 0,
      });
    }

    results.sort((a, b) => {
      if (a.jumpsAway !== b.jumpsAway) return a.jumpsAway - b.jumpsAway;
      return b.remaining - a.remaining;
    });
    return results;
  }

  /** Like findClosestMiningLocations but restricted to a single system. */
  findClosestMiningLocationsInSystem(
    oreId: string,
    systemId: string,
    fromSystem?: string,
    blacklist?: string[],
  ): Array<{
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
    isHidden: boolean;
    richness: number;
    score: number;
  }> {
    const all = this.findClosestMiningLocations(oreId, fromSystem, blacklist);
    return all.filter(loc => loc.systemId === systemId);
  }

  /** BFS pathfinding between two systems using known connections. Returns system IDs in order, or null if no path. */
  findRoute(fromSystemId: string, toSystemId: string, blacklist?: string[]): string[] | null {
    const blacklistArr = Array.isArray(blacklist) ? blacklist : [];
    const useNoPirate = blacklistArr.length > 0;
    return perf.timeSync("mapStore.findRoute", () => this.findRouteWithMode(fromSystemId, toSystemId, blacklist, useNoPirate));
  }

  /** Pathfinding with mode selection: useNoPirate=false for full routes (cloaked bots), useNoPirate=true for pirate-avoiding routes. */
  findRouteWithMode(fromSystemId: string, toSystemId: string, blacklist?: string[], useNoPirate: boolean = false): string[] | null {
    if (fromSystemId === toSystemId) return [fromSystemId];

    const blacklistArr = Array.isArray(blacklist) ? blacklist : [];
    const blacklistSet = new Set(blacklistArr.map(s => s.toLowerCase()));
    
    const fromId = this.findSystemIdCaseInsensitive(fromSystemId);
    const toId = this.findSystemIdCaseInsensitive(toSystemId);
    
    if (!fromId || !toId) {
      return null;
    }

    const precalcRoutes = useNoPirate ? this.precalcNoPirateRoutes : this.precalcRoutes;
    if (precalcRoutes[fromId] && precalcRoutes[fromId][toId] !== undefined) {
      const route = precalcRoutes[fromId][toId];
      if (route && !route.some(s => blacklistSet.has(s.toLowerCase()))) {
        return route;
      }
    }
    
    const fromSys = this.data.systems[fromId];
    const toSys = this.data.systems[toId];
    
    if (!fromSys || !toSys) {
      return null;
    }
    
    const wormholeRoute = this.tryFindWormholeRoute(fromId, toId, blacklistArr);
    if (wormholeRoute) {
      return wormholeRoute;
    }
    
    const visited = new Set<string>([fromId]);
    const queue: Array<{ id: string; path: string[] }> = [
      { id: fromId, path: [fromId] },
    ];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const conns = this.data.systems[current.id]?.connections ?? [];

      for (const conn of conns) {
        const nextId = typeof conn === 'string' ? conn : (this.findSystemIdCaseInsensitive(conn.system_id) || conn.system_id);
        if (!nextId || visited.has(nextId)) continue;
        if (blacklistSet.has(nextId.toLowerCase())) continue;

        const newPath = [...current.path, nextId];
        if (nextId === toId) {
          return newPath;
        }

        visited.add(nextId);
        queue.push({ id: nextId, path: newPath });
      }
    }

    return null;
  }
  
  /** Find system ID with case-insensitive matching. Returns the actual stored ID or null if not found. */
  private findSystemIdCaseInsensitive(systemId: string): string | null {
    if (!systemId) return null;
    const lower = systemId.toLowerCase();
    // First try exact match (most common case)
    if (this.data.systems[systemId]) return systemId;
    // Then try case-insensitive match
    for (const id of Object.keys(this.data.systems)) {
      if (id.toLowerCase() === lower) return id;
    }
    return null;
  }

  /** Debug function: Get detailed explanation of why a route wasn't found. */
  getRouteDebugInfo(fromSystemId: string, toSystemId: string, blacklist?: string[]): {
    fromExists: boolean;
    toExists: boolean;
    fromHasConnections: boolean;
    blacklist: string[];
    blockedSystems: string[];
    reachableSystems: string[];
    message: string;
  } {
    const blacklistArr = Array.isArray(blacklist) ? blacklist : [];
    const blacklistSet = new Set(blacklistArr.map(s => s.toLowerCase()));
    
    // Normalize system IDs for case-insensitive matching
    const fromId = this.findSystemIdCaseInsensitive(fromSystemId);
    const toId = this.findSystemIdCaseInsensitive(toSystemId);
    
    const fromSys = fromId ? this.data.systems[fromId] : null;
    const toSys = toId ? this.data.systems[toId] : null;
    
    const fromExists = !!fromSys;
    const toExists = !!toSys;
    const fromHasConnections = !!(fromSys?.connections?.length);
    
    // Find blocked systems (blacklisted or pirate)
    const blockedSystems: string[] = [];
    for (const [sysId, sys] of Object.entries(this.data.systems)) {
      if (blacklistSet.has(sysId.toLowerCase()) || this.isPirateSystem(sysId)) {
        blockedSystems.push(sysId);
      }
    }
    
    // Find reachable systems from fromSystem
    const reachableSystems: string[] = [];
    if (fromSys && fromId) {
      const visited = new Set<string>();
      const queue = [fromId];
      visited.add(fromId);
      while (queue.length > 0 && reachableSystems.length < 50) {
        const current = queue.shift()!;
        const conns = this.data.systems[current]?.connections ?? [];
        for (const conn of conns) {
          const nextId = this.findSystemIdCaseInsensitive(conn.system_id) || conn.system_id;
          if (nextId && !visited.has(nextId) && !blacklistSet.has(nextId.toLowerCase()) && !this.isPirateSystem(nextId)) {
            visited.add(nextId);
            reachableSystems.push(nextId);
            queue.push(nextId);
          }
        }
      }
    }
    
    let message = "";
    if (fromId === toId) {
      message = "Already in destination system";
    } else if (!fromExists) {
      message = `From system "${fromSystemId}" not found in map`;
    } else if (!toExists) {
      message = `To system "${toSystemId}" not found in map`;
    } else if (!fromHasConnections) {
      message = `From system "${fromSystemId}" has no known connections`;
    } else if (reachableSystems.length === 0) {
      message = `From system "${fromSystemId}" has all connections blocked (blacklist or pirate systems)`;
    } else if (!reachableSystems.includes(toId!)) {
      message = `Destination "${toSystemId}" not reachable from "${fromSystemId}" - no connection path found`;
    } else {
      message = "Route should be reachable";
    }
    
    return {
      fromExists,
      toExists,
      fromHasConnections,
      blacklist: blacklistArr,
      blockedSystems,
      reachableSystems,
      message,
    };
  }

/**
    * Try to find a route using wormholes as shortcuts.
    * Strategy: Check if we can reach a wormhole entrance, jump through, then reach the destination.
    */
  private tryFindWormholeRoute(fromSystemId: string, toSystemId: string, blacklist: string[]): string[] | null {
    const blacklistSet = new Set(blacklist.map(s => s.toLowerCase()));
    
    // Normalize system IDs
    const fromId = this.findSystemIdCaseInsensitive(fromSystemId);
    const toId = this.findSystemIdCaseInsensitive(toSystemId);
    if (!fromId || !toId) return null;
    
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
      const toEntrance = this.findRegularBfsRoute(fromId, entranceSystem, blacklist);
      const fromExitToDest = this.findRegularBfsRoute(exitSystem, toId, blacklist);
      
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
      if (toId === entranceSystem) {
        const toEntrance = this.findRegularBfsRoute(fromId, entranceSystem, blacklist);
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
        const nextId = this.findSystemIdCaseInsensitive(conn.system_id) || conn.system_id;
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
    const stop = perf.isEnabled() ? perf.startSpan("mapStore.findBestBuyPrice") : null;
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

    stop?.end();
    return best;
  }

  /** Find all items with buy orders across all known stations (excluding pirate systems). */
  getAllBuyDemand(): Array<{ itemId: string; itemName: string; systemId: string; poiId: string; poiName: string; price: number; quantity: number }> {
    const stop = perf.isEnabled() ? perf.startSpan("mapStore.getAllBuyDemand") : null;
    const results: Array<{ itemId: string; itemName: string; systemId: string; poiId: string; poiName: string; price: number; quantity: number }> = [];

    for (const [sysId, sys] of Object.entries(this.data.systems)) {
      // Skip pirate systems
      if (this.isPirateSystem(sysId)) continue;
      for (const poi of sys.pois) {
        // Only include POIs with a dockable station (has_base or base_id)
        if (!(poi.has_base || poi.base_id)) continue;
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

    stop?.end();
    return results;
  }

  getAllSellSupply(): Array<{ itemId: string; itemName: string; systemId: string; poiId: string; poiName: string; price: number; quantity: number }> {
    const stop = perf.isEnabled() ? perf.startSpan("mapStore.getAllSellSupply") : null;
    const results: Array<{ itemId: string; itemName: string; systemId: string; poiId: string; poiName: string; price: number; quantity: number }> = [];

    for (const [sysId, sys] of Object.entries(this.data.systems)) {
      // Skip pirate systems
      if (this.isPirateSystem(sysId)) continue;
      for (const poi of sys.pois) {
        // Only include POIs with a dockable station (has_base or base_id)
        if (!(poi.has_base || poi.base_id)) continue;
        for (const m of poi.market) {
          if (m.best_sell !== null && m.sell_quantity > 0) {
            results.push({
              itemId: m.item_id,
              itemName: m.item_name,
              systemId: sysId,
              poiId: poi.id,
              poiName: poi.name,
              price: m.best_sell,
              quantity: m.sell_quantity,
            });
          }
        }
      }
    }

    stop?.end();
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
    const stop = perf.isEnabled() ? perf.startSpan("mapStore.findPriceSpreads") : null;
    // Collect all sell listings (where we can buy from NPC market)
    const sellListings: Array<{ itemId: string; itemName: string; systemId: string; poiId: string; poiName: string; price: number; quantity: number }> = [];
    // Collect all buy listings (where we can sell to NPC market / fill buy orders)
    const buyListings: Array<{ itemId: string; itemName: string; systemId: string; poiId: string; poiName: string; price: number; quantity: number }> = [];

    for (const [sysId, sys] of Object.entries(this.data.systems)) {
      // Skip pirate systems
      if (this.isPirateSystem(sysId)) continue;
      for (const poi of sys.pois) {
        // Only include POIs with a dockable station (has_base or base_id)
        if (!(poi.has_base || poi.base_id)) continue;
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
    stop?.end();
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

        // Transform connection data → StoredConnection objects
        // Handle both string array format (["system_id", ...]) and object format ({system_id: "...", ...})
        const rawConns = sys.connections;
        const connections: Array<Record<string, unknown>> = Array.isArray(rawConns)
          ? rawConns.map((conn) => {
              if (typeof conn === "string") {
                // String format: just the system ID
                return {
                  system_id: conn,
                  system_name: nameById.get(conn) || conn,
                };
              } else if (typeof conn === "object" && conn !== null) {
                // Object format: already has system_id/system_name
                const connObj = conn as Record<string, unknown>;
                const connId = (connObj.system_id as string) || (connObj.id as string) || "";
                const connName = (connObj.system_name as string) || (connObj.name as string) || connId;
                return {
                  system_id: connId,
                  system_name: connName,
                  security_level: connObj.security_level ?? connObj.security_status ?? connObj.lawfulness ?? connObj.security ?? undefined,
                  jump_cost: connObj.jump_cost as number | undefined,
                  distance: connObj.distance as number | undefined,
                };
              }
              return null;
            }).filter(Boolean) as Array<Record<string, unknown>>
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

  // ── Station identity cross-referencing ───────────────────

  /**
   * Resolve a station reference into a canonical identity carrying BOTH the POI
   * hex id and the friendly POI name (when known). The reference may be:
   *   - "system|poi"        (e.g. "crosshaven|d1c54e3a...")
   *   - "system|name"       (e.g. "crosshaven|crosshaven_station")
   *   - "poi" (hex or name) e.g. "d1c54e3a..." or "crosshaven_station"
   *   - a bare system id     (no POI)
   * If nothing in the map matches (e.g. an unresolved hex id the server hasn't
   * fully described yet), the raw token is preserved in `poiId` so callers can
   * still compare/travel. This is what lets a hex id and a friendly name for the
   * same station be treated as equal.
   */
  resolveStationIdentity(stationRef: string): ResolvedStation {
    if (!stationRef) return { systemId: null, poiId: null, poiName: null, matched: false };

    let systemPart: string | null = null;
    let token = stationRef;
    if (stationRef.includes("|")) {
      const parts = stationRef.split("|");
      systemPart = (parts[0] || "").trim() || null;
      token = (parts[1] || parts[0] || "").trim();
    }
    if (!token) return { systemId: systemPart, poiId: null, poiName: null, matched: false };

    const tokenLower = token.toLowerCase();

    const poiMatches = (poi: StoredPOI): boolean =>
      poi.id.toLowerCase() === tokenLower ||
      (poi.base_id !== null && poi.base_id.toLowerCase() === tokenLower) ||
      (poi.name !== null && poi.name.toLowerCase() === tokenLower) ||
      (poi.base_name !== null && poi.base_name.toLowerCase() === tokenLower);

    // 1) Preferred: search within the named system first.
    if (systemPart) {
      const sys = this.getSystem(systemPart);
      const poi = sys?.pois.find(poiMatches);
      if (poi) {
        return { systemId: sys!.id, poiId: poi.id, poiName: poi.name, matched: true };
      }
    }

    // 2) Global search by poi id / base id / name (handles a stale or missing
    //    system part, and resolves an unresolved hex id to its friendly name).
    for (const sys of this.getSystems()) {
      const poi = sys.pois.find(poiMatches);
      if (poi) {
        return { systemId: sys.id, poiId: poi.id, poiName: poi.name, matched: true };
      }
    }

    // 3) A bare token that is itself a known system (no POI specified).
    if (!systemPart) {
      const asSystem = this.getSystem(token);
      if (asSystem) {
        return { systemId: asSystem.id, poiId: null, poiName: null, matched: true };
      }
    }

    // 4) Unresolved — preserve the raw token so the caller can still travel to
    //    / compare against it.
    return { systemId: systemPart, poiId: token, poiName: null, matched: false };
  }

  /**
   * Return the best POI token to hand to commands like `travel`/`dock` for the
   * given station reference. Prefers the resolved POI hex id (what the server
   * expects), falling back to the friendly name, then to the raw token.
   */
  resolveStationTarget(stationRef: string): string {
    const resolved = this.resolveStationIdentity(stationRef);
    if (resolved.matched && resolved.poiId) return resolved.poiId;
    if (stationRef.includes("|")) {
      const parts = stationRef.split("|");
      return (parts[1] || parts[0] || "").trim();
    }
    return stationRef;
  }

  /**
   * Compare two station references and return true if they point at the SAME
   * station, matching on either the hex POI id OR the friendly POI name (and
   * respecting system when both sides know their system). This is safe against
   * the game intermittently reporting a station as an unresolved hex id while
   * the config uses its friendly name.
   */
  sameStation(a: string, b: string): boolean {
    if (!a || !b) return false;
    if (a.toLowerCase() === b.toLowerCase()) return true;

    const ra = this.resolveStationIdentity(a);
    const rb = this.resolveStationIdentity(b);

    // If neither resolved to the map, fall back to a raw token compare.
    if (!ra.matched && !rb.matched) {
      return a.toLowerCase() === b.toLowerCase();
    }

    // System compatibility: if both sides know their system and they differ,
    // they are not the same station.
    if (ra.systemId && rb.systemId &&
        ra.systemId.toLowerCase() !== rb.systemId.toLowerCase()) {
      return false;
    }

    const na = (ra.poiName || "").toLowerCase();
    const nb = (rb.poiName || "").toLowerCase();

    // Strongest signal: POI hex id match (works even when names are blank).
    if (ra.poiId && rb.poiId &&
        ra.poiId.toLowerCase() === rb.poiId.toLowerCase()) return true;

    // Friendly name match.
    if (na && nb && na === nb) return true;

    // Cross check: one side resolved to an id, the other to a name that equals it.
    if (ra.poiId && nb && ra.poiId.toLowerCase() === nb) return true;
    if (rb.poiId && na && rb.poiId.toLowerCase() === na) return true;

    return false;
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

  /**
   * Find system ID by system name (case-insensitive). Returns null if not found.
   */
  findSystemIdByName(systemName: string): string | null {
    const lower = systemName.toLowerCase().replace(/_/g, " ");
    for (const [id, sys] of Object.entries(this.data.systems)) {
      const name = (sys.name || sys.id || "").toLowerCase().replace(/_/g, " ");
      if (name === lower) return id;
    }
    return null;
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

  getAllSystemPositions(): SystemPosition[] {
    return Object.values(this.data.systems)
      .filter((s) => s.position && typeof s.position.x === "number" && typeof s.position.y === "number")
      .map((s) => ({
        id: s.id,
        x: s.position!.x,
        y: s.position!.y,
        name: s.name,
      }));
  }

  /** Get all system positions as a record keyed by system ID. */
  getAllSystemPositionsRecord(): Record<string, { x: number; y: number }> {
    const result: Record<string, { x: number; y: number }> = {};
    for (const [id, sys] of Object.entries(this.data.systems)) {
      if (sys.position && typeof sys.position.x === "number" && typeof sys.position.y === "number") {
        result[id] = { x: sys.position.x, y: sys.position.y };
      }
    }
    return result;
  }

  calculatePathfinderBearing(fromSystemId: string, toSystemId: string): number | null {
    const from = this.data.systems[fromSystemId.toLowerCase()];
    const to = this.data.systems[toSystemId.toLowerCase()];
    if (!from?.position || !to?.position) return null;
    return calculatePathfinderBearing(from.position.x, from.position.y, to.position.x, to.position.y);
  }

  simulatePathfinderLanding(originSystemId: string, bearingDegrees: number): PathfinderResult | null {
    const originSys = this.data.systems[originSystemId.toLowerCase()];
    if (!originSys?.position) return null;
    const origin: SystemPosition = {
      id: originSys.id,
      x: originSys.position.x,
      y: originSys.position.y,
      name: originSys.name,
    };
    const all = this.getAllSystemPositions();
    return simulatePathfinderLanding(origin, bearingDegrees, all);
  }

  computeSafePathfinderBearing(fromSystemId: string, toSystemId: string): { bearing: number; safe: boolean; landing: PathfinderResult | null; blocker?: PathfinderResult } | null {
    const fromSys = this.data.systems[fromSystemId.toLowerCase()];
    const toSys = this.data.systems[toSystemId.toLowerCase()];
    if (!fromSys?.position || !toSys?.position) return null;
    const origin: SystemPosition = { id: fromSys.id, x: fromSys.position.x, y: fromSys.position.y, name: fromSys.name };
    const target: SystemPosition = { id: toSys.id, x: toSys.position.x, y: toSys.position.y, name: toSys.name };
    const all = this.getAllSystemPositions();
    return computePathfinderBearingToTarget(origin, target, all);
  }

  getPathfinderLandingMargin(): number {
    return PATHFINDER_LANDING_MARGIN;
  }

  getPathfinderSpeed(): number {
    return PATHFINDER_SPEED;
  }

  reversePathfinderBearing(bearing: number): number {
    return reverseBearing(bearing);
  }

  formatPathfinderBearing(bearing: number, decimals?: number): string {
    return formatBearing(bearing, decimals);
  }

  getPathfinderTravelTime(proj: number): { ticks: number; seconds: number } {
    return getPathfinderTravelTime(proj);
  }

  /** Get systems that have not been visited according to the server's visited flag. */
  getUnvisitedSystems(): Array<{ systemId: string; systemName: string; visited: boolean; visited_at: string | null }> {
    const unvisited: Array<{ systemId: string; systemName: string; visited: boolean; visited_at: string | null }> = [];
    for (const [sysId, sys] of Object.entries(this.data.systems)) {
      if (!sys.visited) {
        unvisited.push({
          systemId: sysId,
          systemName: sys.name || sysId,
          visited: sys.visited ?? false,
          visited_at: sys.visited_at ?? null,
        });
      }
    }
    return unvisited;
  }

  /** Get count of visited vs unvisited systems. */
  getVisitStats(): { total: number; visited: number; unvisited: number } {
    let visitedCount = 0;
    for (const sys of Object.values(this.data.systems)) {
      if (sys.visited) visitedCount++;
    }
    const total = Object.keys(this.data.systems).length;
    return {
      total,
      visited: visitedCount,
      unvisited: total - visitedCount,
    };
  }

  /** Check if the map has any systems with connections (i.e., is seeded). */
  isMapSeeded(): boolean {
    return Object.keys(this.data.systems).length > 0;
  }

  /** Get debug info about the map state. */
  getDebugInfo(): {
    totalSystems: number;
    systemsWithConnections: number;
    systemsWithPOIs: number;
    sampleSystems: string[];
  } {
    const systems = Object.values(this.data.systems);
    const systemsWithConnections = systems.filter(s => s.connections && s.connections.length > 0).length;
    const systemsWithPOIs = systems.filter(s => s.pois && s.pois.length > 0).length;
    const sampleSystems = systems.slice(0, 5).map(s => `${s.id} (${s.connections?.length || 0} conns, ${s.pois?.length || 0} POIs)`);
    
    return {
      totalSystems: systems.length,
      systemsWithConnections,
      systemsWithPOIs,
      sampleSystems,
    };
  }
}

function now(): string {
  return new Date().toISOString();
}

/** Singleton instance shared by all bots. */
export const mapStore = new MapStore();
