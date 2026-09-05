import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const DATA_DIR = join(process.cwd(), "data");
const SHIPS_FOR_SALE_FILE = join(DATA_DIR, "shipsForSale.json");

export interface ShipListing {
  systemId: string;
  stationPoiId: string;
  stationName: string;
  listing_id: string;
  ship_id: string;
  class_id: string;
  price: number;
  listed_at: string;
  seller: string;
  ship_name: string;
  tier: number;
  hull: number;
  max_hull: number;
  shield: number;
  modules_count: number;
  scale: number;
  category: string;
  custom_name?: string;
  last_updated: string;
}

export interface ShipsForSaleData {
  lastSaved: string;
  listings: Record<string, ShipListing>;
}

const SHIP_LISTING_EXPIRY_DAYS = 30;

export function now(): string {
  return new Date().toISOString();
}

export function loadShipsForSale(log?: (cat: string, msg: string) => void): ShipsForSaleData {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  if (existsSync(SHIPS_FOR_SALE_FILE)) {
    try {
      const raw = readFileSync(SHIPS_FOR_SALE_FILE, "utf-8");
      const data = JSON.parse(raw) as ShipsForSaleData;
      const removed = cleanupExpiredShipListings(data);
      if (removed > 0 && log) {
        log("info", `Removed ${removed} expired ship listing(s) from shipsForSale.json`);
        saveShipsForSale(data);
      }
      return data;
    } catch {
      // Corrupt file — start fresh
    }
  }
  return { lastSaved: now(), listings: {} };
}

export function saveShipsForSale(data: ShipsForSaleData): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  data.lastSaved = now();
  writeFileSync(SHIPS_FOR_SALE_FILE, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

export function cleanupExpiredShipListings(data: ShipsForSaleData): number {
  const cutoff = Date.now() - SHIP_LISTING_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const [listingId, listing] of Object.entries(data.listings)) {
    const lastUpdated = new Date(listing.last_updated).getTime();
    if (isNaN(lastUpdated) || lastUpdated < cutoff) {
      delete data.listings[listingId];
      removed++;
    }
  }
  return removed;
}

export function processShipListings(
  data: ShipsForSaleData,
  systemId: string,
  stationPoiId: string,
  stationName: string,
  listings: Array<Record<string, unknown>>,
  log?: (cat: string, msg: string) => void,
): { updated: number; soldRemoved: number; expiredRemoved: number } {
  let updated = 0;
  const expiredRemoved = cleanupExpiredShipListings(data);
  const currentListingIds = new Set<string>();

  for (const listing of listings) {
    const listing_id = (listing.listing_id as string) || "";
    if (!listing_id) continue;
    currentListingIds.add(listing_id);

    const shipListing: ShipListing = {
      systemId,
      stationPoiId,
      stationName,
      listing_id,
      ship_id: (listing.ship_id as string) || "",
      class_id: (listing.class_id as string) || "",
      price: (listing.price as number) || 0,
      listed_at: (listing.listed_at as string) || "",
      seller: (listing.seller as string) || "",
      ship_name: (listing.ship_name as string) || "",
      tier: (listing.tier as number) || 0,
      hull: (listing.hull as number) || 0,
      max_hull: (listing.max_hull as number) || 0,
      shield: (listing.shield as number) || 0,
      modules_count: (listing.modules_count as number) || 0,
      scale: (listing.scale as number) || 0,
      category: (listing.category as string) || "",
      custom_name: listing.custom_name as string | undefined,
      last_updated: now(),
    };

    data.listings[listing_id] = shipListing;
    updated++;
  }

  let soldRemoved = 0;
  for (const listingId of Object.keys(data.listings)) {
    const listing = data.listings[listingId];
    if (!currentListingIds.has(listingId) && listing.systemId === systemId && listing.stationPoiId === stationPoiId) {
      delete data.listings[listingId];
      soldRemoved++;
    }
  }

  if (updated > 0 || soldRemoved > 0 || expiredRemoved > 0) {
    saveShipsForSale(data);
    const msgs: string[] = [];
    if (updated > 0) msgs.push(`${updated} added/updated`);
    if (soldRemoved > 0) msgs.push(`${soldRemoved} sold/removed`);
    if (expiredRemoved > 0) msgs.push(`${expiredRemoved} expired`);
    if (log) log("info", `Saved ship listings to shipsForSale.json (${msgs.join(", ")})`);
  }

  return { updated, soldRemoved, expiredRemoved };
}

export function updateShipListings(
  systemId: string,
  stationPoiId: string,
  stationName: string,
  listings: Array<Record<string, unknown>>,
  log?: (cat: string, msg: string) => void,
): { updated: number; soldRemoved: number; expiredRemoved: number } {
  const data = loadShipsForSale(log);
  return processShipListings(data, systemId, stationPoiId, stationName, listings, log);
}
