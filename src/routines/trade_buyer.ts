import type { Bot, Routine, RoutineContext } from "../bot.js";
import { mapStore } from "../mapstore.js";
import { catalogStore } from "../catalogstore.js";
import { getSystemBlacklist } from "../web/server.js";
import {
  ensureDocked,
  ensureUndocked,
  tryRefuel,
  repairShip,
  ensureFueled,
  navigateToSystem,
  recordMarketData,
  getSystemInfo,
  findStation,
  factionDonateProfit,
  ensureInsured,
  detectAndRecoverFromDeath,
  getModProfile,
  ensureModsFitted,
  maxItemsForCargo,
  getItemSize,
  readSettings,
  logFactionActivity,
  isPirateSystem,
  buildDeniedStationSet,
  type BaseServices,
  checkAndFleeFromBattle,
  checkBattleAfterCommand,
  getBattleStatus,
  type BattleState,
  handleBattleNotifications,
  sanitizeCredits,
  fleeFromBattle,
} from "./common.js";
import {
  getActiveSession,
  startTradeSession,
  updateTradeSession,
  completeTradeSession,
  failTradeSession,
  createTradeSession,
  type TradeSession,
} from "./traderActivity.js";
import { queryRemoteMarket, resolveMarketSource } from "../client_sync_hooks.js";

/** Free cargo weight (not item count — callers must divide by item size). */
function getFreeSpace(bot: Bot): number {
  if (bot.cargoMax <= 0) return 999;
  return Math.max(0, bot.cargoMax - bot.cargo);
}

// ── Settings ─────────────────────────────────────────────────

function getTradeBuyerSettings(username?: string): {
  maxSpendPerItem: number;
  maxTotalSpend: number;
  fuelCostPerJump: number;
  refuelThreshold: number;
  repairThreshold: number;
  homeSystem: string;
  homeStation: string;
  buyItems: string[];
  autoInsure: boolean;
  autoCloak: boolean;
  minQuantityToBuy: number;
  maxBuyQuantity: number;
  maxPrices: Record<string, number>;
  useRemoteMarketQuery: boolean;
  maxMarketAgeHours: number;
} {
  const all = readSettings();
  // Read from trade_buyer settings (not trader)
  const t = all.trade_buyer || {};
  const botOverrides = username ? (all[username] || {}) : {};
  const rawAge = t.maxMarketAgeHours;
  return {
    maxSpendPerItem: (t.maxSpendPerItem as number) || 5000,
    maxTotalSpend: (t.maxTotalSpend as number) || 0,
    fuelCostPerJump: (t.fuelCostPerJump as number) || 50,
    refuelThreshold: (t.refuelThreshold as number) || 50,
    repairThreshold: (t.repairThreshold as number) || 40,
    homeSystem: (botOverrides.homeSystem as string) || (t.homeSystem as string) || "",
    // Explicit home station wins over "any station in the home system". The
    // per-bot override is checked first so a single bot can be pointed at a
    // different station than the rest of the fleet.
    homeStation: (botOverrides.homeStation as string) || (t.homeStation as string) || "",
    buyItems: Array.isArray(t.buyItems) ? (t.buyItems as string[]) : [],
    autoInsure: (t.autoInsure as boolean) !== false,
    autoCloak: (t.autoCloak as boolean) ?? false,
    minQuantityToBuy: (t.minQuantityToBuy as number) || 10,
    // 0 = unlimited. Upper bound on how many of an item are bought per trip,
    // independent of cargo/budget. Lets you grab tiny deals (min=1) without the
    // bot draining a whole station into one over-long haul.
    maxBuyQuantity: (t.maxBuyQuantity as number) || 0,
    maxPrices: (t.maxPrices as Record<string, number>) || {},
    useRemoteMarketQuery: (t.useRemoteMarketQuery as boolean) ?? true,
    // 0 = accept market data of any age (old behaviour). Default 24h: anything
    // older is a ghost listing that will almost certainly fail on arrival.
    maxMarketAgeHours: typeof rawAge === "number" && rawAge >= 0 ? rawAge : 24,
  };
}

/**
 * Effective credit budget for a single buy trip.
 * `maxSpendPerItem` caps spend on one item type, `maxTotalSpend` caps the whole
 * run — since a trip buys exactly one item type, the tighter of the two applies.
 * Returns 0 when both are unlimited.
 */
function getSpendBudget(settings: ReturnType<typeof getTradeBuyerSettings>): number {
  const caps = [settings.maxSpendPerItem, settings.maxTotalSpend].filter(v => typeof v === "number" && v > 0);
  return caps.length > 0 ? Math.min(...caps) : 0;
}

// ── Trade Session Recovery ──────────────────────────────────

/**
 * Check for and recover an incomplete buy session.
 * Validates cargo, destination, and market conditions.
 * Returns the recovered session if valid, or null if recovery is not possible.
 */
async function recoverBuySession(
  ctx: RoutineContext,
  session: TradeSession,
  homeSystem: string,
): Promise<TradeSession | null> {
  const { bot } = ctx;

  ctx.log("trade", `Found incomplete buy session: ${session.itemName} (${session.state})`);

  // Verify items are in cargo (for non-cargo routes)
  if (!session.isCargoRoute) {
    await bot.refreshCargo();
    const cargoItem = bot.inventory.find(i => i.itemId === session.itemId);
    const cargoQty = cargoItem?.quantity ?? 0;

    if (session.state === "buying" || session.state === "in_transit") {
      // Should have items after buying
      if (cargoQty <= 0) {
        ctx.log("error", `Recovery failed: ${session.itemName} not in cargo after buy`);
        await failTradeSession(session.botUsername, "Items not in cargo");
        return null;
      }

      if (cargoQty < session.quantityBought) {
        ctx.log("trade", `Recovered with partial cargo: ${cargoQty}/${session.quantityBought}x ${session.itemName}`);
        const updated = await updateTradeSession(session.botUsername, {
          quantityBought: cargoQty,
          sellQuantity: cargoQty,
          notes: (session.notes || "") + ` | Partial recovery: ${cargoQty}/${session.quantityBought}x remaining`,
        });
        if (updated) session = updated;
      }
    }
  }

  // Check if we're at the destination (home station)
  if (session.state === "in_transit" || session.state === "at_destination" || session.state === "selling") {
    // Verify we're heading to a valid home station
    if (!homeSystem) {
      ctx.log("error", "No home system configured — cannot recover session");
      await failTradeSession(session.botUsername, "No home system configured");
      return null;
    }

    if (session.destSystem !== homeSystem) {
      ctx.log("trade", `Correcting destination to home system ${homeSystem}`);
      const updated = await updateTradeSession(session.botUsername, {
        destSystem: homeSystem,
        notes: (session.notes || "") + ` | Destination corrected to home system ${homeSystem}`,
      });
      if (updated) session = updated;
    }
  }

  ctx.log("trade", `Session recovered: ${session.quantityBought}x ${session.itemName} → ${session.destPoiName}`);
  return session;
}

// ── Types ────────────────────────────────────────────────────

interface BuyRoute {
  itemId: string;
  itemName: string;
  sourceSystem: string;
  sourcePoi: string;
  sourcePoiName: string;
  buyPrice: number;
  buyQty: number;
  destSystem: string;
  destPoi: string;
  destPoiName: string;
  jumps: number;
  totalCost: number;
}

/** A "this item is for sale here" observation, normalised across data sources. */
interface SellListing {
  itemId: string;
  itemName: string;
  systemId: string;
  poiId: string;
  poiName: string;
  price: number;
  quantity: number;
  /** Age of the observation in ms, or null when the source didn't say. */
  ageMs: number | null;
  /** `market` = market routine data (marketDetails.json / live observations),
   *  `map`    = the galaxy map's cached market rows. */
  origin: "market" | "map";
}

const HOUR_MS = 3_600_000;

// ── Failure memory ───────────────────────────────────────────
//
// A station that just refused to sell us an item must not be re-picked on the
// very next 60s re-scan. The old routine only remembered failures for the
// current cycle, so a ghost listing produced the same doomed round-trip over
// and over.

const RECENT_FAILURE_TTL_MS = 30 * 60 * 1000;
const recentBuyFailures = new Map<string, number>();

function failureKey(systemId: string, poiId: string, itemId: string): string {
  return `${systemId}:${poiId}:${itemId}`.toLowerCase();
}

function noteBuyFailure(systemId: string, poiId: string, itemId: string): void {
  recentBuyFailures.set(failureKey(systemId, poiId, itemId), Date.now());
}

function isRecentBuyFailure(systemId: string, poiId: string, itemId: string): boolean {
  const key = failureKey(systemId, poiId, itemId);
  const at = recentBuyFailures.get(key);
  if (at === undefined) return false;
  if (Date.now() - at > RECENT_FAILURE_TTL_MS) {
    recentBuyFailures.delete(key);
    return false;
  }
  return true;
}

// ── Station validation ───────────────────────────────────────

/** Blacklist lookups hit settings on every call, and route scanning resolves
 *  thousands of listings, so cache them for the duration of a scan. */
const BLACKLIST_CACHE_MS = 10_000;
let blacklistCache: { at: number; systems: Set<string>; stations: Set<string> } | null = null;

function getBlacklists(): { systems: Set<string>; stations: Set<string> } {
  const now = Date.now();
  if (blacklistCache && now - blacklistCache.at < BLACKLIST_CACHE_MS) return blacklistCache;
  blacklistCache = {
    at: now,
    systems: new Set(getSystemBlacklist().map(s => s.toLowerCase())),
    // Already folds in Settings → General → stationBlacklist plus any station
    // that denied us docking this session.
    stations: buildDeniedStationSet(),
  };
  return blacklistCache;
}

/**
 * Resolve a market listing's location to a station the bot can actually dock at.
 *
 * The galaxy map carries market rows for POIs that have no base at all — ice
 * fields, planets, asteroid belts — left over from older scans or seeded data.
 * A route to one of those is unexecutable: the bot flies out, `ensureDocked()`
 * quietly diverts it to the nearest real station, and the buy then fails
 * against a market that never listed the item (exactly the
 * "Kuiper Ice Fields → Sol Central → item_not_available" loop).
 *
 * Every listing must therefore prove it points at a dockable, non-pirate,
 * non-blacklisted station before it is allowed to become a route.
 */
function resolveBuyStation(
  systemId: string,
  poiId: string,
  fallbackName: string,
): { systemId: string; poiId: string; poiName: string } | null {
  if (!systemId || !poiId) return null;
  if (isPirateSystem(systemId)) return null;
  const { systems: systemBlacklist, stations: stationBlacklist } = getBlacklists();
  if (systemBlacklist.has(systemId.toLowerCase())) return null;

  const system = mapStore.getSystem(systemId);
  if (!system) return null;

  let poi = system.pois.find(p => p.id === poiId);
  if (!poi) {
    // Market data may name the station by base id / friendly name instead of
    // POI id; resolve it against the map before giving up.
    const resolved = mapStore.resolveStationIdentity(`${systemId}|${poiId}`);
    if (resolved.matched && resolved.systemId === systemId && resolved.poiId) {
      poi = system.pois.find(p => p.id === resolved.poiId);
    }
  }

  // The mobile capital moves; only its currently tracked location is real.
  if (!poi && poiId === "mobile_capital") {
    const loc = mapStore.getMobileCapitolLocation();
    if (!loc || loc.systemId !== systemId) return null;
    return { systemId, poiId: loc.poiId || "mobile_capital", poiName: fallbackName || "Mobile Capital" };
  }

  if (!poi) return null;
  // No base = nothing to dock with = nothing to buy from. Matches isStationPoi().
  if (!(poi.has_base || poi.base_id || (poi.type || "").toLowerCase() === "station")) return null;
  if (stationBlacklist.has(poi.id.toLowerCase())) return null;
  if (stationBlacklist.has(`${systemId}|${poi.id}`.toLowerCase())) return null;

  return { systemId, poiId: poi.id, poiName: poi.name || fallbackName || poi.id };
}

// ── Market data sourcing ─────────────────────────────────────

function parseAgeMs(iso: string | undefined | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Date.now() - t);
}

function describeAge(ageMs: number | null): string {
  if (ageMs === null) return "age unknown";
  if (ageMs < 60_000) return `${Math.round(ageMs / 1000)}s old`;
  if (ageMs < HOUR_MS) return `${Math.round(ageMs / 60_000)}min old`;
  if (ageMs < 48 * HOUR_MS) return `${Math.round(ageMs / HOUR_MS)}h old`;
  return `${Math.round(ageMs / (24 * HOUR_MS))}d old`;
}

/**
 * Ask the market routine's data (this client's `data/marketDetails.json` plus
 * its live in-memory observations, or a connected market client) where each
 * wanted item is actually on sale right now.
 *
 * This is the authoritative source. The galaxy map's market cache is only a
 * last-resort backfill: it is written opportunistically by every routine that
 * happens to dock somewhere, it keeps rows for POIs that are not stations, and
 * entries there can be months old.
 */
async function collectMarketListings(
  ctx: RoutineContext,
  settings: ReturnType<typeof getTradeBuyerSettings>,
  currentSystem: string,
): Promise<SellListing[]> {
  const out: SellListing[] = [];
  if (settings.buyItems.length === 0) return out;

  const source = await resolveMarketSource();
  if (source.mode === "none") {
    ctx.log("trade", `[Market] No market data source: ${source.reason}`);
    return out;
  }
  ctx.log("trade", `[${source.label}] ${source.reason}`);

  const wanted = settings.buyItems.slice(0, 20);
  const perItem = await Promise.all(wanted.map(async (itemId) => {
    try {
      return { itemId, res: await queryRemoteMarket({ itemId, tradeType: "buy", requesterSystemId: currentSystem }) };
    } catch (err) {
      ctx.log("trade", `[${source.label}] Query failed for ${itemId}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }));

  let rejectedStations = 0;
  for (const entry of perItem) {
    if (!entry || !entry.res.ok) continue;
    for (const r of entry.res.results) {
      if (!(r.price > 0) || !(r.quantity > 0)) continue;
      const station = resolveBuyStation(r.systemId, r.stationPoiId, r.stationName);
      if (!station) {
        rejectedStations++;
        continue;
      }
      out.push({
        itemId: entry.itemId,
        itemName: r.itemName || catalogStore.resolveItemName(entry.itemId) || entry.itemId,
        systemId: station.systemId,
        poiId: station.poiId,
        poiName: station.poiName,
        price: r.price,
        quantity: r.quantity,
        ageMs: parseAgeMs(r.lastUpdated),
        origin: "market",
      });
    }
  }

  ctx.log(
    "trade",
    `[${source.label}] ${out.length} live sell listing(s) for ${wanted.length} item(s)` +
    (rejectedStations > 0 ? ` (${rejectedStations} skipped: not a dockable station in our map)` : ""),
  );
  return out;
}

/** Sell listings from the galaxy map cache — station-filtered, used as backfill. */
function collectMapListings(ctx: RoutineContext, settings: ReturnType<typeof getTradeBuyerSettings>): SellListing[] {
  const wanted = new Set(settings.buyItems.map(i => i.toLowerCase()));
  if (wanted.size === 0) return [];

  const out: SellListing[] = [];
  let nonStationRows = 0;

  for (const [sysId, sys] of Object.entries(mapStore.getAllSystems())) {
    if (isPirateSystem(sysId)) continue;
    for (const poi of sys.pois) {
      let stationChecked: ReturnType<typeof resolveBuyStation> | undefined;
      for (const m of poi.market) {
        if (!wanted.has(m.item_id.toLowerCase())) continue;
        if (m.best_sell === null || m.best_sell <= 0 || m.sell_quantity <= 0) continue;
        if (stationChecked === undefined) stationChecked = resolveBuyStation(sysId, poi.id, poi.name);
        if (!stationChecked) {
          nonStationRows++;
          continue;
        }
        out.push({
          itemId: m.item_id,
          itemName: m.item_name || m.item_id,
          systemId: stationChecked.systemId,
          poiId: stationChecked.poiId,
          poiName: stationChecked.poiName,
          price: m.best_sell,
          quantity: m.sell_quantity,
          ageMs: parseAgeMs(m.last_updated),
          origin: "map",
        });
      }
    }
  }

  if (nonStationRows > 0) {
    ctx.log("trade", `[MapCache] Ignored ${nonStationRows} cached sell row(s) at POIs with no dockable station`);
  }
  return out;
}

// ── Buy route discovery ────────────────────────────────────

/** Estimate fuel cost between two systems using mapStore route data. */
function estimateFuelCost(fromSystem: string, toSystem: string, costPerJump: number): { jumps: number; cost: number } {
  const blacklist = getSystemBlacklist();
  if (fromSystem === toSystem) return { jumps: 0, cost: 0 };
  const route = mapStore.findRoute(fromSystem, toSystem, blacklist);
  if (!route) return { jumps: 999, cost: 999 * costPerJump };
  const jumps = route.length - 1;
  return { jumps, cost: jumps * costPerJump };
}

/**
 * Find the cheapest place to buy each wanted item.
 *
 * `marketListings` (from the market routine) is authoritative; map-cache rows
 * for the same station/item are discarded in its favour so a months-old cached
 * price can never outbid a live one.
 */
function findCheapestSellers(
  ctx: RoutineContext,
  settings: ReturnType<typeof getTradeBuyerSettings>,
  currentSystem: string,
  cargoCapacity: number = 999,
  marketListings: SellListing[] = [],
): BuyRoute[] {
  const routes: BuyRoute[] = [];

  if (settings.buyItems.length === 0) {
    ctx.log("trade", "No items selected in \"Items to Buy\" — nothing to scan for");
    return routes;
  }

  // Merge sources, one row per station+item, market data always wins.
  const merged = new Map<string, SellListing>();
  for (const l of collectMapListings(ctx, settings)) {
    merged.set(`${l.systemId}/${l.poiId}/${l.itemId}`, l);
  }
  let overridden = 0;
  for (const l of marketListings) {
    const key = `${l.systemId}/${l.poiId}/${l.itemId}`;
    if (merged.has(key)) overridden++;
    merged.set(key, l);
  }
  const sellListings = [...merged.values()];

  const fromMarket = sellListings.filter(l => l.origin === "market").length;
  ctx.log(
    "trade",
    `Scanning ${sellListings.length} dockable sell listing(s) — ${fromMarket} from the market routine` +
    `, ${sellListings.length - fromMarket} from the map cache` +
    (overridden > 0 ? ` (${overridden} stale cache row(s) replaced by live data)` : ""),
  );
  ctx.log("trade", `Max prices config: ${JSON.stringify(settings.maxPrices || {})}`);

  const maxAgeMs = settings.maxMarketAgeHours > 0 ? settings.maxMarketAgeHours * HOUR_MS : 0;

  // Group by item to find cheapest sources
  const itemSellers = new Map<string, SellListing[]>();
  for (const seller of sellListings) {
    const existing = itemSellers.get(seller.itemId) || [];
    existing.push(seller);
    itemSellers.set(seller.itemId, existing);
  }

  for (const buyItem of settings.buyItems) {
    const itemId = buyItem;
    const sellers = itemSellers.get(itemId)
      // Fall back to a case-insensitive lookup for legacy config entries.
      || [...itemSellers.entries()].find(([k]) => k.toLowerCase() === itemId.toLowerCase())?.[1];

    if (!sellers || sellers.length === 0) {
      ctx.log("trade", `>>> ${itemId}: no station is selling this in any known market data`);
      continue;
    }

    ctx.log("trade", `>>> Found matching item: ${itemId} (${sellers.length} sellers)`);

    // Freshness gate — a listing nobody has confirmed for weeks is a ghost, and
    // chasing it costs a full round trip plus fuel.
    let candidates = sellers;
    if (maxAgeMs > 0) {
      const fresh = candidates.filter(s => s.ageMs !== null && s.ageMs <= maxAgeMs);
      if (fresh.length === 0) {
        const best = candidates.reduce<number | null>(
          (acc, s) => (s.ageMs === null ? acc : acc === null ? s.ageMs : Math.min(acc, s.ageMs)),
          null,
        );
        ctx.log(
          "trade",
          `>>> ${itemId}: REJECTED all ${candidates.length} seller(s) — market data older than ` +
          `${settings.maxMarketAgeHours}h (freshest is ${describeAge(best)}). Run the market routine at those ` +
          `stations, or raise "Max Market Data Age" (0 = accept any age)`,
        );
        continue;
      }
      if (fresh.length < candidates.length) {
        ctx.log("trade", `>>> ${itemId}: dropped ${candidates.length - fresh.length} seller(s) with market data older than ${settings.maxMarketAgeHours}h`);
      }
      candidates = fresh;
    }

    // Recently-failed stations are skipped so a bad listing can't produce the
    // same doomed round trip every 60s.
    const notRecentlyFailed = candidates.filter(s => !isRecentBuyFailure(s.systemId, s.poiId, s.itemId));
    if (notRecentlyFailed.length < candidates.length) {
      ctx.log("trade", `>>> ${itemId}: skipping ${candidates.length - notRecentlyFailed.length} station(s) that recently refused this buy`);
    }
    candidates = notRecentlyFailed;
    if (candidates.length === 0) continue;

    // Check max price for this item
    const maxPrice = settings.maxPrices?.[itemId];
    if (maxPrice !== undefined && maxPrice > 0) {
      // Filter out sellers that are above the max price
      const filteredSellers = candidates.filter(s => s.price <= maxPrice);
      if (filteredSellers.length === 0) {
        const cheapest = Math.min(...candidates.map(s => s.price));
        ctx.log("trade", `>>> ${itemId}: No sellers at or below max price ${maxPrice}cr (cheapest available: ${cheapest}cr)`);
        continue;
      } // No sellers at acceptable price
      candidates = filteredSellers;
      ctx.log("trade", `>>> ${itemId}: Filtered to ${candidates.length} sellers at or below ${maxPrice}cr`);
    }

    // Sort by price ascending (cheapest first)
    candidates = [...candidates].sort((a, b) => a.price - b.price);

    const itemSize = getItemSize(itemId);
    const cargoFits = maxItemsForCargo(cargoCapacity, itemId);
    const budget = getSpendBudget(settings);
    const minQty = Math.max(1, settings.minQuantityToBuy);

    // Cargo is a hard, seller-independent limit — report it once and move on
    if (cargoFits < minQty) {
      ctx.log("trade", `>>> ${itemId}: REJECTED — cargo holds only ${cargoFits}x (capacity ${cargoCapacity}, item size ${itemSize}), need at least ${minQty}x (minQuantityToBuy)`);
      continue;
    }

    for (const seller of candidates.slice(0, 3)) { // Top 3 cheapest per item
      const where = `${seller.poiName} (${seller.systemId}) @ ${seller.price}cr [${seller.origin}, ${describeAge(seller.ageMs)}]`;
      const { jumps, cost: fuelCost } = estimateFuelCost(currentSystem, seller.systemId, settings.fuelCostPerJump);
      if (jumps >= 999) {
        ctx.log("trade", `>>> ${itemId}: REJECTED ${where} — no route from ${currentSystem} (unreachable or blacklisted)`);
        continue;
      }

      // Budget limits HOW MANY we buy — it must never silently discard the route
      let buyQty = Math.min(seller.quantity, cargoFits);
      if (settings.maxBuyQuantity > 0) {
        if (settings.maxBuyQuantity < minQty) {
          ctx.log(
            "trade",
            `>>> ${itemId}: REJECTED ${where} — max buy quantity ${settings.maxBuyQuantity} is below min quantity ${minQty}; raise "Max Buy Quantity"`,
          );
          continue;
        }
        buyQty = Math.min(buyQty, settings.maxBuyQuantity);
      }
      if (budget > 0) {
        const affordable = Math.floor(budget / seller.price);
        if (affordable < minQty) {
          ctx.log(
            "trade",
            `>>> ${itemId}: REJECTED ${where} — spend budget ${budget}cr only affords ${affordable}x (need ${minQty}x). ` +
            `Raise "Max Spend Per Item"${settings.maxTotalSpend > 0 && settings.maxTotalSpend <= settings.maxSpendPerItem ? ` / "Max Total Spend"` : ""} to at least ${seller.price * minQty}cr`,
          );
          continue;
        }
        buyQty = Math.min(buyQty, affordable);
      }

      if (buyQty < minQty) {
        ctx.log("trade", `>>> ${itemId}: REJECTED ${where} — only ${buyQty}x obtainable (stock ${seller.quantity}, cargo fits ${cargoFits}), need ${minQty}x`);
        continue;
      }

      // Calculate total cost including fuel
      const itemCost = seller.price * buyQty;
      const totalCost = itemCost + fuelCost;
      ctx.log("trade", `>>> ${itemId}: ACCEPTED ${where} — ${buyQty}x for ${itemCost}cr + ${fuelCost}cr fuel (${jumps} jumps)`);

      routes.push({
        itemId: seller.itemId,
        itemName: seller.itemName,
        sourceSystem: seller.systemId,
        sourcePoi: seller.poiId,
        sourcePoiName: seller.poiName,
        buyPrice: seller.price,
        buyQty: buyQty,
        destSystem: settings.homeSystem || currentSystem,
        destPoi: "", // Will be filled in later
        destPoiName: "Home Station",
        jumps,
        totalCost,
      });
    }
  }

  // Sort by effective cost per unit (item price + amortized fuel), then prefer
  // the larger haul. Sorting by raw total cost would rank a 2x purchase above a
  // cheaper-per-unit 20x purchase, which is wrong for a stockpiling routine.
  routes.sort((a, b) => {
    const aPer = a.totalCost / Math.max(1, a.buyQty);
    const bPer = b.totalCost / Math.max(1, b.buyQty);
    if (aPer !== bPer) return aPer - bPer;
    return b.buyQty - a.buyQty;
  });
  return routes;
}

/** Get the home station POI for a given home system. */
function getHomeStation(homeSystem: string): { id: string; name: string } | null {
  const system = mapStore.getSystem(homeSystem);
  if (!system) return null;

  // Prefer stations with faction storage or market
  // Cast pois to SystemPOI-compatible type for findStation
  const compatiblePois = system.pois.map(p => ({
    id: p.id,
    name: p.name,
    type: p.type,
    has_base: p.has_base,
    base_id: p.base_id,
    services: p.services.reduce((acc, s) => { acc[s as keyof BaseServices] = true; return acc; }, {} as BaseServices),
  }));

  const station = findStation(compatiblePois, "market", false);
  if (station) {
    return { id: station.id, name: station.name };
  }

  // Fallback to any station (outposts excluded — never dockable by non-faction members)
  const anyStation = findStation(compatiblePois, undefined, false);
  if (anyStation) {
    return { id: anyStation.id, name: anyStation.name };
  }

  return null;
}

/**
 * Resolve where "home" actually is for this bot.
 *
 * Precedence:
 *   1. An explicit `homeStation` setting (per-bot override first, then the
 *      routine's own setting). Every format the UI writes is accepted:
 *      "system|poi", a bare POI id/hex, a base id, or a station name.
 *   2. Otherwise auto-pick a market station inside `homeSystem`.
 *
 * The system of an explicitly configured station is authoritative — without
 * this, configuring a home station outside the (often stale) `homeSystem` value
 * silently sent the bot back to whatever station the home system happened to
 * resolve to, e.g. flying to Sol Central after Arneb had been configured.
 */
function resolveHomeStation(
  ctx: RoutineContext,
  settings: ReturnType<typeof getTradeBuyerSettings>,
): { id: string; name: string; systemId: string } | null {
  const raw = (settings.homeStation || "").trim();
  let systemId = (settings.homeSystem || "").trim();

  if (raw) {
    const resolved = mapStore.resolveStationIdentity(raw);

    if (resolved.systemId) {
      if (systemId && resolved.systemId !== systemId) {
        ctx.log(
          "trade",
          `Home station "${raw}" lives in ${resolved.systemId} — using that instead of homeSystem=${systemId}`,
        );
      }
      systemId = resolved.systemId;
    }

    if (resolved.poiId) {
      if (!systemId) {
        ctx.log("error", `Home station "${raw}" is not in the galaxy map and no home system is set — cannot resolve home`);
        return null;
      }
      if (!resolved.matched) {
        ctx.log("trade", `Home station "${raw}" is not in the galaxy map yet — using it as-is in ${systemId}`);
      }
      return { id: resolved.poiId, name: resolved.poiName || resolved.poiId, systemId };
    }
    // `raw` named a bare system (or nothing usable) — fall through and auto-pick
    // a station inside it.
  }

  if (!systemId) return null;

  const auto = getHomeStation(systemId);
  if (!auto) return null;
  return { id: auto.id, name: auto.name, systemId };
}

// ── Missions ─────────────────────────────────────────────────
//
// INTENTIONALLY NOT IMPLEMENTED. The trade buyer never accepts, completes or
// tracks missions. It exists purely to buy items cheaply and stockpile them in
// faction storage. Mission handling previously lived here and was harmful:
// every station visit burned rate-limited `get_missions` / `accept_mission`
// calls, and once the 5-mission cap was hit it spammed `too_many_missions`
// errors for ~10s per attempt while blocking the buy loop.
// Do not re-add mission logic to this routine.

// ── Trade Buyer routine ─────────────────────────────────────

/**
 * Trade Buyer routine — travels between stations, buys items cheaply,
 * and deposits them at home station faction storage:
 *
 * 1. Dock at current station, refresh market data
 * 2. Scan mapStore for cheapest sellers of desired items
 * 3. Pick best buy opportunity (lowest total cost including fuel)
 * 4. Travel to source station, buy items
 * 5. Travel to home station, deposit items to faction storage
 * 6. Refuel, repair, repeat
 */
export const tradeBuyerRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  // Persistent battle state across cycles
  const battleRef = { state: null as BattleState | null };
  battleRef.state = {
    inBattle: false,
    battleId: null,
    battleStartTick: null,
    lastHitTick: null,
    isFleeing: false,
    lastFleeTime: undefined,
  };

  await bot.refreshStatus();
  const startSystem = bot.system;

  // Load settings
  let settings = getTradeBuyerSettings(bot.username);

  // Validate a home destination is configured. The station itself is resolved
  // once per cycle below so editing the setting takes effect without a restart.
  if (!settings.homeSystem && !settings.homeStation) {
    ctx.log("error", "No home configured for trade buyer — please set a home station (or at least a home system) in settings");
    await ctx.sleep(60000);
    return;
  }

  let lastHomeKey = "";

  while (bot.state === "running") {
    // Refresh settings each cycle
    settings = getTradeBuyerSettings(bot.username);

    // Re-resolve home every cycle — a settings change must not require a restart.
    const home = resolveHomeStation(ctx, settings);
    if (!home) {
      ctx.log(
        "error",
        `Cannot resolve a home station (homeStation=${settings.homeStation || "(not set)"}, homeSystem=${settings.homeSystem || "(not set)"}) — check settings`,
      );
      await ctx.sleep(60000);
      continue;
    }
    const homeStation = { id: home.id, name: home.name };
    const homeSystemId = home.systemId;

    const homeKey = `${homeSystemId}/${homeStation.id}`;
    if (lastHomeKey && lastHomeKey !== homeKey) {
      ctx.log("trade", `Home station changed to ${homeStation.name} (${homeSystemId}) — future deliveries go there`);
    }
    lastHomeKey = homeKey;

    ctx.log("trade", `Settings loaded: home=${homeStation.name} (${homeSystemId})${settings.homeStation ? " [configured]" : " [auto-picked from home system]"}, buyItems=[${settings.buyItems.join(", ") || "(none)"}], maxPrices=${JSON.stringify(settings.maxPrices || {})}, maxMarketAge=${settings.maxMarketAgeHours > 0 ? settings.maxMarketAgeHours + "h" : "any"}`);

    // ── Death recovery ──
    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) { await ctx.sleep(30000); continue; }

    // ── Battle check ──
    if (await checkAndFleeFromBattle(ctx, "trade_buyer")) {
      await ctx.sleep(5000);
      continue;
    }

    // Periodic battle status check (backup detection in case notifications fail)
    // Check every cycle for fast detection
    if (bot.isInBattle()) {
      const now = Date.now();
      if (!battleRef.state!.lastFleeTime || now - battleRef.state!.lastFleeTime > 10000) { // Only issue if more than 10 seconds since last flee
        ctx.log("combat", `PERIODIC CHECK: IN BATTLE! - initiating IMMEDIATE flee!`);
        battleRef.state!.inBattle = true;
        battleRef.state!.isFleeing = false;

        await bot.exec("battle", { action: "stance", stance: "flee" });
        battleRef.state!.lastFleeTime = now;
        ctx.log("combat", "Flee stance issued - will re-issue every cycle until disengaged!");
      }
    }

    // If we're in battle, re-issue flee command to ensure we stay in flee stance
    if (battleRef.state!.inBattle) {
      const now = Date.now();
      if (!battleRef.state!.lastFleeTime || now - battleRef.state!.lastFleeTime > 10000) { // Only issue if more than 10 seconds since last flee
        ctx.log("combat", "Re-issuing flee stance (ensuring we stay in flee mode)...");
        const fleeResp = await bot.exec("battle", { action: "stance", stance: "flee" });
        if (fleeResp.error) {
          ctx.log("error", `Flee re-issue failed: ${fleeResp.error.message}`);
        } else {
          battleRef.state!.lastFleeTime = now;
        }
      }
      // Check if we've successfully disengaged
      const currentBattleStatus = await getBattleStatus(ctx);
      if (!currentBattleStatus || !currentBattleStatus.is_participant) {
        ctx.log("combat", "Battle cleared - no longer in combat!");
        battleRef.state!.inBattle = false;
        battleRef.state!.battleId = null;
        battleRef.state!.isFleeing = false;
        battleRef.state!.lastFleeTime = undefined;
        await ctx.sleep(2000); // Brief pause before next check
        continue;
      }
      // Still in battle - continue to next cycle
      await ctx.sleep(2000); // Brief pause before next check
      continue;
    }

    // ── Trade session recovery ──
    const activeSession = getActiveSession(bot.username);
    let recoveredSession: TradeSession | null = null;
    if (activeSession) {
      recoveredSession = await recoverBuySession(ctx, activeSession, homeSystemId);
      if (recoveredSession) {
        ctx.log("trade", `Resuming buy session: ${recoveredSession.itemName} (${recoveredSession.state})`);
      }
    }

    const safetyOpts = {
      fuelThresholdPct: settings.refuelThreshold,
      hullThresholdPct: settings.repairThreshold,
      autoCloak: settings.autoCloak,
    };
    let route: BuyRoute | null = null;
    let buyQty = 0;
    let totalSpent = 0;

    // ── Handle recovered session ──
    if (recoveredSession && (recoveredSession.state === "in_transit" || recoveredSession.state === "at_destination")) {
      ctx.log("trade", `Recovered session is ${recoveredSession.state} — proceeding directly to home`);

      if (bot.docked) {
        await tryRefuel(ctx);
      }

      // Set up route for immediate execution
      route = {
        itemId: recoveredSession.itemId,
        itemName: recoveredSession.itemName,
        sourceSystem: recoveredSession.sourceSystem,
        sourcePoi: recoveredSession.sourcePoi,
        sourcePoiName: recoveredSession.sourcePoiName,
        buyPrice: recoveredSession.buyPricePerUnit,
        buyQty: recoveredSession.quantityBought,
        destSystem: homeSystemId,
        destPoi: homeStation.id,
        destPoiName: homeStation.name,
        jumps: recoveredSession.totalJumps - recoveredSession.jumpsCompleted,
        totalCost: recoveredSession.investedCredits,
      };
      buyQty = recoveredSession.quantityBought;
      totalSpent = recoveredSession.investedCredits;

      await ensureUndocked(ctx);
      const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
      if (!fueled) {
        ctx.log("error", "Cannot refuel for recovered session — will retry next cycle");
        await ctx.sleep(30000);
        continue;
      }

      ctx.log("travel", `Resuming route to home (${homeStation.name} in ${homeSystemId})...`);
      const arrived = await navigateToSystem(ctx, homeSystemId, {
        ...safetyOpts,
        noJettison: true,
        onJump: async (jumpNum) => {
          const session = getActiveSession(bot.username);
          if (session) {
            await updateTradeSession(bot.username, { jumpsCompleted: jumpNum });
          }
          return true;
        },
      });

      if (!arrived) {
        ctx.log("error", "Failed to reach home system — will retry");
        await ensureDocked(ctx);
        await ctx.sleep(60000);
        continue;
      }

      await updateTradeSession(bot.username, { state: "at_destination" });
      bot.system = homeSystemId;

      // `bot.poi` may report the friendly name while the config holds the hex id
      // (or vice versa) — compare through the map so we don't re-travel in place.
      if (!mapStore.sameStation(bot.poi, homeStation.id)) {
        ctx.log("travel", `Traveling to ${homeStation.name}...`);
        await bot.exec("travel", { target_poi: homeStation.id });
        bot.poi = homeStation.id;
      }

      await ensureDocked(ctx);
      ctx.log("trade", "Arrived at home — proceeding to deposit items");
    }

    // ── Ensure docked (also records market data) ──
    yield "dock";
    await ensureDocked(ctx);

    // ── Fuel + hull check + mods ──
    yield "maintenance";
    await tryRefuel(ctx);
    await repairShip(ctx);
    const modProfile = getModProfile("trader");
    if (modProfile.length > 0) await ensureModsFitted(ctx, modProfile);

    // ── Handle leftover cargo items ──
    yield "handle_cargo";
    await bot.refreshStatus();
    await bot.refreshCargo();

    const protectedItemId = activeSession?.itemId || recoveredSession?.itemId;
    if (protectedItemId) {
      ctx.log("trade", `Protecting buy session item: ${protectedItemId} (not depositing yet)`);
    }

    const cargoItems = bot.inventory.filter(i => {
      if (i.quantity <= 0) return false;
      const lower = i.itemId.toLowerCase();
      if (lower.includes("fuel") || lower.includes("energy_cell")) return false;
      if (protectedItemId && i.itemId === protectedItemId) {
        ctx.log("trade", `Skipping ${i.quantity}x ${i.name} - part of active buy session`);
        return false;
      }
      return true;
    });

    if (cargoItems.length > 0 && bot.docked) {
      // Deposit all non-trade items to faction storage at current location
      const deposited: string[] = [];
      for (const item of cargoItems) {
        const dResp = await bot.exec("faction_deposit_items", { item_id: item.itemId, quantity: item.quantity });
        if (!dResp.error) {
          deposited.push(`${item.quantity}x ${item.name}`);
          logFactionActivity(ctx, "deposit", `Deposited ${item.quantity}x ${item.name} from cargo`);
        }
      }
      if (deposited.length > 0) {
        ctx.log("trade", `Deposited to faction storage: ${deposited.join(", ")}`);
      }
    }

    await bot.refreshStatus();

    // ── Find new buy opportunities ──
    yield "find_buys";
    let routes: BuyRoute[] = [];

    await bot.refreshStatus();
    await bot.refreshCargo();

    // Subtract fuel cell weight from cargo capacity
    let fuelCellWeight = 0;
    for (const item of bot.inventory) {
      const lower = item.itemId.toLowerCase();
      if (lower.includes("fuel") || lower.includes("energy_cell")) {
        fuelCellWeight += item.quantity * getItemSize(item.itemId);
      }
    }
    const cargoCapacity = Math.max(0, (bot.cargoMax > 0 ? bot.cargoMax : 50) - fuelCellWeight);

    // Market routine data (data/marketDetails.json + its live in-memory
    // observations, or a connected market client) is the authoritative source
    // for what is actually on sale where. The galaxy map cache is only used to
    // backfill stations the market routine has never visited.
    let marketListings: SellListing[] = [];
    if (settings.useRemoteMarketQuery !== false) {
      marketListings = await collectMarketListings(ctx, settings, bot.system);
    } else {
      ctx.log("trade", "Market query disabled in settings — falling back to the galaxy map cache only");
    }

    routes = findCheapestSellers(ctx, settings, bot.system, cargoCapacity, marketListings);

    // Update routes with home station info (the resolved station is
    // authoritative — findCheapestSellers only fills a placeholder)
    routes = routes.map(r => ({
      ...r,
      destSystem: homeSystemId,
      destPoi: homeStation.id,
      destPoiName: homeStation.name,
    }));

    ctx.log("trade", `DEBUG: routes found = ${routes.length}`);
    if (routes.length > 0) {
      ctx.log("trade", `Found ${routes.length} buy opportunities`);
      for (const r of routes.slice(0, 5)) {
        ctx.log("trade", `  - ${r.itemName}: ${r.buyQty}x @ ${r.buyPrice}cr in ${r.sourceSystem}`);
      }
    }

    if (routes.length === 0 && !recoveredSession) {
      const budget = getSpendBudget(settings);
      ctx.log(
        "trade",
        `No buy routes passed the filters (see REJECTED lines above) — ` +
        `buyItems=[${settings.buyItems.join(", ") || "(none)"}], spend budget=${budget > 0 ? budget + "cr" : "unlimited"}, ` +
        `minQty=${Math.max(1, settings.minQuantityToBuy)}, cargo=${cargoCapacity}, ` +
        `maxMarketAge=${settings.maxMarketAgeHours > 0 ? settings.maxMarketAgeHours + "h" : "any"}. Waiting 60s before re-scanning`,
      );
      await ctx.sleep(60000);
      continue;
    }

    const failedSources = new Set<string>();
    let attempts = 0;

    // Battle state tracking for buy route loop
    const battleState: BattleState = {
      inBattle: false,
      battleId: null,
      battleStartTick: null,
      lastHitTick: null,
      isFleeing: false,
    };

    // If we have a recovered session, execute it
    if (recoveredSession) {
      ctx.log("trade", `Executing recovered buy session: ${recoveredSession.itemName} (${recoveredSession.quantityBought}x @ ${recoveredSession.buyPricePerUnit}cr)`);

      route = {
        itemId: recoveredSession.itemId,
        itemName: recoveredSession.itemName,
        sourceSystem: recoveredSession.sourceSystem,
        sourcePoi: recoveredSession.sourcePoi,
        sourcePoiName: recoveredSession.sourcePoiName,
        buyPrice: recoveredSession.buyPricePerUnit,
        buyQty: recoveredSession.quantityBought,
        destSystem: homeSystemId,
        destPoi: homeStation.id,
        destPoiName: homeStation.name,
        jumps: recoveredSession.totalJumps - recoveredSession.jumpsCompleted,
        totalCost: recoveredSession.investedCredits,
      };

      buyQty = recoveredSession.quantityBought;
      totalSpent = recoveredSession.investedCredits;

      if (bot.system === homeSystemId) {
        await updateTradeSession(bot.username, { state: "at_destination" });
      } else if (recoveredSession.jumpsCompleted > 0) {
        await updateTradeSession(bot.username, { state: "in_transit" });
      }
    }

    // Try up to 3 routes
    if (!recoveredSession) {
      for (let ri = 0; ri < routes.length && attempts < 3; ri++) {
        if (bot.state !== "running") break;
        const candidate = routes[ri];

        // If we're in battle, re-issue flee command every cycle
        if (battleState.inBattle) {
          ctx.log("combat", "Re-issuing flee stance during trade operations (ensuring we stay in flee mode)...");
          const fleeResp = await bot.exec("battle", { action: "stance", stance: "flee" });
          if (fleeResp.error) {
            ctx.log("error", `Flee re-issue failed: ${fleeResp.error.message}`);
          }
          // Check if we've successfully disengaged
          const currentBattleStatus = await getBattleStatus(ctx);
          if (!currentBattleStatus || !currentBattleStatus.is_participant) {
            ctx.log("combat", "Battle cleared - no longer in combat! Resuming trade operations...");
            battleState.inBattle = false;
            battleState.battleId = null;
            battleState.isFleeing = false;
          } else {
            // Still in battle - wait briefly and continue to next cycle to re-flee
            await ctx.sleep(2000);
            continue;
          }
        }

        const sourceKey = `${candidate.sourceSystem}:${candidate.sourcePoi}:${candidate.itemId}`;
        if (failedSources.has(sourceKey)) continue;
        attempts++;

        ctx.log("trade", `Route #${ri + 1}: ${candidate.itemName} — buy ${candidate.buyQty}x at ${candidate.sourcePoiName} (${candidate.buyPrice}cr) — total cost ${Math.round(candidate.totalCost)}cr (${candidate.jumps} jumps)`);

        // Travel to source and buy
        yield "travel_to_source";

        if (bot.system !== candidate.sourceSystem) {
          await ensureUndocked(ctx);
          
          // Pre-travel battle check - prevents travel from being interrupted
          const preTravelBattleCheck = await getBattleStatus(ctx);
          if (preTravelBattleCheck && preTravelBattleCheck.is_participant) {
            ctx.log("combat", `PRE-TRAVEL CHECK: IN BATTLE! Battle ID: ${preTravelBattleCheck.battle_id} - initiating flee!`);
            battleState.inBattle = true;
            battleState.battleId = preTravelBattleCheck.battle_id;
            battleState.isFleeing = false;
            await fleeFromBattle(ctx, false, 5000);
            continue;
          }
          
          const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
          if (!fueled) {
            ctx.log("error", "Cannot refuel for buy run — waiting 30s");
            await ctx.sleep(30000);
            break;
          }

          ctx.log("travel", `Heading to ${candidate.sourcePoiName} in ${candidate.sourceSystem}...`);
          const arrived = await navigateToSystem(ctx, candidate.sourceSystem, safetyOpts);
          if (!arrived) {
            ctx.log("error", "Failed to reach source system — trying next route");
            continue;
          }
        }

        if (bot.poi !== candidate.sourcePoi) {
          await ensureUndocked(ctx);
          
          // Check battle after undock
          const undockBattleCheck = await getBattleStatus(ctx);
          if (undockBattleCheck && undockBattleCheck.is_participant) {
            ctx.log("combat", `POST-UNDOCK CHECK: IN BATTLE! Battle ID: ${undockBattleCheck.battle_id} - initiating flee!`);
            battleState.inBattle = true;
            battleState.battleId = undockBattleCheck.battle_id;
            battleState.isFleeing = false;
            await fleeFromBattle(ctx, false, 5000);
            continue;
          }
          
          ctx.log("travel", `Traveling to ${candidate.sourcePoiName}...`);
          const tResp = await bot.exec("travel", { target_poi: candidate.sourcePoi });
          // Check for battle notifications after travel
          if (tResp.notifications && Array.isArray(tResp.notifications)) {
            const battleDetected = await handleBattleNotifications(ctx, tResp.notifications, battleState);
            if (battleDetected) {
              ctx.log("combat", "Battle detected during travel - initiating flee!");
              battleState.isFleeing = false;
            }
          }
          // Also check battle status directly (in case we missed notifications)
          const directBattleCheck = await getBattleStatus(ctx);
          if (directBattleCheck && directBattleCheck.is_participant) {
            ctx.log("combat", `DIRECT CHECK: IN BATTLE after travel! Battle ID: ${directBattleCheck.battle_id} - fleeing!`);
            battleState.inBattle = true;
            battleState.battleId = directBattleCheck.battle_id;
            await fleeFromBattle(ctx, true, 35000);
            ctx.log("error", "Battle detected - fled, will retry route");
            continue;
          }
          if (tResp.error && !tResp.error.message.includes("already")) {
            ctx.log("error", `Travel to source failed: ${tResp.error.message}`);
            continue;
          }
          bot.poi = candidate.sourcePoi;

          // Check for pirates at source location
          const nearbyResp = await bot.exec("get_nearby");
          if (nearbyResp.result && typeof nearbyResp.result === "object") {
            const { checkAndFleeFromPirates } = await import("./common.js");
            const fled = await checkAndFleeFromPirates(ctx, nearbyResp.result);
            if (fled) {
              ctx.log("error", "Pirates detected at source - fled, will retry");
              await ctx.sleep(30000);
              continue;
            }
          }
        }

        yield "dock_source";
        await ensureDocked(ctx);
        bot.docked = true;

        // ── Confirm we are standing where the route said to buy ──
        // `ensureDocked()` silently diverts to the nearest usable station when
        // the target POI turns out to have no base. Everything after this point
        // (fuel top-up, estimate_purchase, buy) is written for the ROUTE's
        // station, so buying at whatever station we happened to land on is
        // always wrong — it is what produced the
        // "flew to an ice field, docked at Sol Central, item_not_available" loop.
        await bot.refreshLocation();
        const atRightSystem = bot.system.toLowerCase() === candidate.sourceSystem.toLowerCase();
        const atRightStation = atRightSystem && !!bot.poi && mapStore.sameStation(bot.poi, candidate.sourcePoi);
        if (!atRightStation) {
          failedSources.add(sourceKey);
          noteBuyFailure(candidate.sourceSystem, candidate.sourcePoi, candidate.itemId);
          // The listing pointed at somewhere we cannot dock — drop it from the
          // map cache so it cannot be re-picked on the next scan.
          mapStore.removeMarketItem(candidate.sourceSystem, candidate.sourcePoi, candidate.itemId);
          ctx.log(
            "error",
            `Expected to dock at ${candidate.sourcePoiName} (${candidate.sourceSystem}) but ended up at ` +
            `${bot.poi || "?"} (${bot.system}) — that listing has no dockable station. Dropping it and trying next route`,
          );
          continue;
        }

        // Withdraw credits from storage
        await bot.refreshStorage();
        const storageResp = await bot.exec("view_storage");
        if (storageResp.result && typeof storageResp.result === "object") {
          const sr = storageResp.result as Record<string, unknown>;
          const storedCredits = (sr.credits as number) || (sr.stored_credits as number) || 0;
          if (storedCredits > 0) {
            await bot.exec("withdraw_credits", { amount: storedCredits });
            ctx.log("trade", `Withdrew ${storedCredits} credits from storage`);
          }
        }

        await recordMarketData(ctx);

        // Verify item is actually available
        yield "verify_availability";
        const estResp = await bot.exec("estimate_purchase", { item_id: candidate.itemId, quantity: 1 });
        if (estResp.error) {
          failedSources.add(sourceKey);
          noteBuyFailure(candidate.sourceSystem, candidate.sourcePoi, candidate.itemId);
          mapStore.removeMarketItem(candidate.sourceSystem, candidate.sourcePoi, candidate.itemId);
          ctx.log("trade", `${candidate.itemName} not available at ${candidate.sourcePoiName} (stale data) — trying next route`);
          continue;
        }

        // Reserve fuel cells for the trip home
        const maxFuelSlots = bot.cargoMax > 0 ? Math.max(3, Math.floor(bot.cargoMax * 0.1)) : 5;
        const RESERVE_FUEL_CELLS = Math.min(Math.max(3, Math.ceil(candidate.jumps / 4)), maxFuelSlots);

        // Clear cargo: keep fuel cells only
        await bot.refreshCargo();
        const depositSummary: string[] = [];
        for (const item of [...bot.inventory]) {
          if (item.itemId === candidate.itemId) continue;
          const lower = item.itemId.toLowerCase();
          const isFuel = lower.includes("fuel") || lower.includes("energy_cell");
          if (isFuel) {
            const excess = item.quantity - RESERVE_FUEL_CELLS;
            if (excess > 0) {
              await bot.exec("deposit_items", { item_id: item.itemId, quantity: excess });
              depositSummary.push(`${excess}x ${item.name}`);
            }
          } else {
            await bot.exec("deposit_items", { item_id: item.itemId, quantity: item.quantity });
            depositSummary.push(`${item.quantity}x ${item.name}`);
          }
        }
        if (depositSummary.length > 0) {
          ctx.log("trade", `Cleared cargo: ${depositSummary.join(", ")}`);
        }

        // Ensure we have enough fuel cells
        await bot.refreshCargo();
        await bot.refreshStatus();
        let fuelInCargo = 0;
        for (const item of bot.inventory) {
          const lower = item.itemId.toLowerCase();
          if (lower.includes("fuel") || lower.includes("energy_cell")) fuelInCargo += item.quantity;
        }
        if (fuelInCargo < RESERVE_FUEL_CELLS) {
          const freeSpace = getFreeSpace(bot);
          const needed = Math.min(RESERVE_FUEL_CELLS - fuelInCargo, maxItemsForCargo(freeSpace, "fuel_cell"));
          if (needed > 0) {
            ctx.log("trade", `Buying ${needed} fuel cells for ${candidate.jumps}-jump route...`);
            await bot.exec("buy", { item_id: "fuel_cell", quantity: needed });
          }
        }

        // Determine buy quantity
        await bot.refreshStatus();
        const freeSpace = getFreeSpace(bot);
        let qty = Math.min(candidate.buyQty, maxItemsForCargo(freeSpace, candidate.itemId));
        const tripBudget = getSpendBudget(settings);
        if (tripBudget > 0) {
          qty = Math.min(qty, Math.floor(tripBudget / candidate.buyPrice));
        }
        if (qty > 0) {
          qty = Math.min(qty, Math.floor(bot.credits / candidate.buyPrice));
        }

        // Pre-buy validation
        if (qty > 0) {
          const estCheck = await bot.exec("estimate_purchase", { item_id: candidate.itemId, quantity: qty });
          if (!estCheck.error && estCheck.result && typeof estCheck.result === "object") {
            const est = estCheck.result as Record<string, unknown>;
            const avail = (est.available_quantity as number) || (est.available as number) || (est.max_quantity as number) || 0;
            if (avail > 0 && avail < qty) {
              ctx.log("trade", `Market only has ${avail}x available (wanted ${qty}) — adjusting`);
              qty = avail;
            }
            const totalCost = (est.total_cost as number) || (est.total as number) || (est.cost as number) || 0;
            if (totalCost > 0 && totalCost > bot.credits - 500) {
              const affordQty = Math.max(0, Math.floor(qty * ((bot.credits - 500) / totalCost)));
              if (affordQty < qty) {
                ctx.log("trade", `Actual cost ${totalCost}cr exceeds budget — reducing to ${affordQty}x`);
                qty = affordQty;
              }
            }
            const totalWeight = (est.total_weight as number) || (est.cargo_required as number) || (est.weight as number) || 0;
            if (totalWeight > 0 && qty > 0) {
              const realItemWeight = totalWeight / qty;
              const fitsInCargo = Math.floor(freeSpace / realItemWeight);
              if (fitsInCargo < qty) {
                ctx.log("trade", `Cargo can fit ${fitsInCargo}x at ${realItemWeight} weight/ea (not ${qty}) — adjusting`);
                qty = fitsInCargo;
              }
            }
          }
        }

        if (qty <= 0) {
          ctx.log("trade", "Cannot afford any items or cargo full — trying next route");
          continue;
        }

        // Buy items
        yield "buy";
        const creditsBefore = bot.credits;
        ctx.log("trade", `Buying ${qty}x ${candidate.itemName} at ${candidate.buyPrice}cr/ea...`);
        const buyResp = await bot.exec("buy", { item_id: candidate.itemId, quantity: qty });
        // Check for battle notifications after buy
        if (buyResp.notifications && Array.isArray(buyResp.notifications)) {
          const battleDetected = await handleBattleNotifications(ctx, buyResp.notifications, battleState);
          if (battleDetected) {
            ctx.log("combat", "Battle detected during buy - initiating flee!");
            battleState.isFleeing = false;
          }
        }
        // Also check battle status directly after buy (in case we missed notifications)
        const postBuyBattleCheck = await getBattleStatus(ctx);
        if (postBuyBattleCheck && postBuyBattleCheck.is_participant) {
          ctx.log("combat", `POST-BUY CHECK: IN BATTLE! Battle ID: ${postBuyBattleCheck.battle_id} - fleeing!`);
          battleState.inBattle = true;
          battleState.battleId = postBuyBattleCheck.battle_id;
          await fleeFromBattle(ctx, true, 35000);
          ctx.log("error", "Battle detected after buy - fled, will continue to home with cargo");
          // Don't continue - we have items in cargo, need to proceed to home
        }
        if (buyResp.error) {
          failedSources.add(sourceKey);
          noteBuyFailure(candidate.sourceSystem, candidate.sourcePoi, candidate.itemId);
          if (buyResp.error.message.includes("item_not_available") || buyResp.error.message.includes("not_available")) {
            mapStore.removeMarketItem(candidate.sourceSystem, candidate.sourcePoi, candidate.itemId);
          }
          ctx.log("error", `Buy failed: ${buyResp.error.message} — trying next route`);
          continue;
        }

        await bot.refreshStatus();
        await bot.refreshCargo();
        const actualInCargo = bot.inventory.find(i => i.itemId === candidate.itemId)?.quantity ?? 0;
        const actualSpent = Math.max(0, creditsBefore - bot.credits);

        route = candidate;
        buyQty = actualInCargo;
        totalSpent = actualSpent;
        ctx.log("trade", `Purchased ${actualInCargo}x ${candidate.itemName} for ${actualSpent}cr (${actualSpent > 0 ? Math.round(actualSpent / Math.max(actualInCargo, 1)) : candidate.buyPrice}cr/ea)`);

        // ── Exhaust the sell order in one visit ──
        // Multi-item sell orders cap each order item (e.g. max 1/order), so the
        // first buy only chips away at it. Loop re-buys at the same station until
        // the order is gone, the per-trip max is hit, cargo is full, or credits
        // run out — instead of flying home and making wasteful return trips.
        const maxQ = settings.maxBuyQuantity > 0 ? settings.maxBuyQuantity : Infinity;
        let purchased = actualInCargo;
        let spent = actualSpent;
        let safety = 0;
        while (purchased < maxQ) {
          if (bot.state !== "running") break;
          if (++safety > 100) {
            ctx.log("trade", `Safety stop after 100 re-buys at ${candidate.sourcePoiName}`);
            break;
          }
          // Battle can break out mid-drain — bail with what we have.
          const rb = await getBattleStatus(ctx);
          if (rb && rb.is_participant) {
            ctx.log("combat", "Battle detected while draining order — fleeing with cargo");
            battleState.inBattle = true;
            battleState.battleId = rb.battle_id;
            await fleeFromBattle(ctx, true, 35000);
            break;
          }

          await bot.refreshStatus();
          await bot.refreshCargo();
          const freeSpaceRe = getFreeSpace(bot);
          const fitsRe = maxItemsForCargo(freeSpaceRe, candidate.itemId);
          if (fitsRe <= 0) {
            ctx.log("trade", `Cargo full after ${purchased}x — stopping drain`);
            break;
          }

          const estRe = await bot.exec("estimate_purchase", { item_id: candidate.itemId, quantity: 1 });
          if (estRe.error) {
            ctx.log("trade", `Order exhausted at ${candidate.sourcePoiName} (${purchased}x total)`);
            break;
          }
          let avail = 0;
          if (estRe.result && typeof estRe.result === "object") {
            const est = estRe.result as Record<string, unknown>;
            avail = (est.available_quantity as number) || (est.available as number) || (est.max_quantity as number) || 0;
          }
          if (avail <= 0) {
            ctx.log("trade", `No more ${candidate.itemName} at ${candidate.sourcePoiName} — drained ${purchased}x`);
            break;
          }

          let reQty = Math.min(avail, fitsRe, maxQ - purchased);
          const tripBudgetRe = getSpendBudget(settings);
          if (tripBudgetRe > 0) reQty = Math.min(reQty, Math.floor(tripBudgetRe / candidate.buyPrice));
          if (reQty > 0) reQty = Math.min(reQty, Math.floor(bot.credits / candidate.buyPrice));
          if (reQty <= 0) {
            ctx.log("trade", `Cannot afford more ${candidate.itemName} (credits/full) — stopping drain at ${purchased}x`);
            break;
          }

          const creditsBeforeRe = bot.credits;
          const reResp = await bot.exec("buy", { item_id: candidate.itemId, quantity: reQty });
          if (reResp.error) {
            if (reResp.error.message.includes("item_not_available") || reResp.error.message.includes("not_available")) {
              ctx.log("trade", `Order exhausted at ${candidate.sourcePoiName} (${purchased}x total)`);
            } else {
              ctx.log("error", `Re-buy failed: ${reResp.error.message} — stopping drain`);
            }
            if (reResp.error.message.includes("item_not_available") || reResp.error.message.includes("not_available")) {
              mapStore.removeMarketItem(candidate.sourceSystem, candidate.sourcePoi, candidate.itemId);
            }
            break;
          }
          await bot.refreshStatus();
          await bot.refreshCargo();
          const haveNow = bot.inventory.find(i => i.itemId === candidate.itemId)?.quantity ?? 0;
          const reGot = Math.max(0, haveNow - purchased);
          if (reGot <= 0) {
            ctx.log("trade", `Re-buy returned 0 ${candidate.itemName} — order likely drained (${purchased}x total)`);
            break;
          }
          purchased += reGot;
          spent += Math.max(0, creditsBeforeRe - bot.credits);
          ctx.log("trade", `Drained ${reGot}x more (${purchased}x total, ${spent}cr spent)`);
        }

        buyQty = purchased;
        totalSpent = spent;

        // Start trade session tracking
        const session = createTradeSession({
          botUsername: bot.username,
          route: {
            ...candidate,
            sellPrice: 0,
            sellQty: actualInCargo,
            profitPerUnit: 0,
            totalProfit: -actualSpent,
          },
          isCargoRoute: false,
          investedCredits: actualSpent,
        });
        await startTradeSession(session);
        ctx.log("trade", `Buy session started: ${session.sessionId}`);

        mapStore.reserveTradeQuantity(
          candidate.sourceSystem, candidate.sourcePoi,
          homeSystemId, homeStation.id,
          candidate.itemId, buyQty,
        );
        break;
      }
    }

    // No route worked — wait and retry
    if (!route || buyQty <= 0) {
      const activeSession = getActiveSession(bot.username);
      if (activeSession) {
        await failTradeSession(bot.username, "No valid route found");
      }

      ctx.log("trade", "All routes failed — waiting 60s before re-scanning");
      await ctx.sleep(60000);
      continue;
    }

    // ── Phase 2: Travel to home and deposit ──
    yield "travel_to_home";
    await ensureUndocked(ctx);

    // Post-undock battle check
    const postUndockBattleCheck = await getBattleStatus(ctx);
    if (postUndockBattleCheck && postUndockBattleCheck.is_participant) {
      ctx.log("combat", `POST-UNDOCK (HOME): IN BATTLE! Battle ID: ${postUndockBattleCheck.battle_id} - initiating flee!`);
      battleState.inBattle = true;
      battleState.battleId = postUndockBattleCheck.battle_id;
      battleState.isFleeing = false;
      await fleeFromBattle(ctx, false, 5000);
      await ensureDocked(ctx);
      await ctx.sleep(30000);
      continue;
    }

    const cargoSafetyOpts = { ...safetyOpts, noJettison: true };
    const fueled2 = await ensureFueled(ctx, safetyOpts.fuelThresholdPct, { noJettison: true });
    if (!fueled2) {
      ctx.log("error", "Cannot refuel for delivery — will retry next cycle");
      await ensureDocked(ctx);
      await ctx.sleep(30000);
      continue;
    }

    if (bot.system !== homeSystemId) {
      ctx.log("travel", `Heading home to ${homeStation.name} (${homeSystemId})...`);

      const activeSession = getActiveSession(bot.username);
      if (activeSession) {
        await updateTradeSession(bot.username, {
          state: "in_transit",
          jumpsCompleted: 0,
        });
      }

      const arrived2 = await navigateToSystem(ctx, homeSystemId, {
        ...cargoSafetyOpts,
        onJump: async (jumpNum) => {
          if (jumpNum % 3 !== 0) return true;

          const session = getActiveSession(bot.username);
          if (session) {
            await updateTradeSession(bot.username, { jumpsCompleted: jumpNum });
          }

          try {
            ctx.log("trade", `Mid-route check (jump ${jumpNum}): cargo valid (${buyQty}x ${route!.itemName})`);
            return true;
          } catch (err) {
            ctx.log("trade", `Mid-route check (jump ${jumpNum}): validation error — continuing anyway`);
            return true;
          }
        },
      });

      if (!arrived2) {
        ctx.log("error", "Failed to reach home system — will retry on next cycle");

        const session = getActiveSession(bot.username);
        if (session) {
          await updateTradeSession(bot.username, {
            state: "in_transit",
            notes: (session.notes || "") + " | Network interruption - will retry",
          });
        }

        await ensureDocked(ctx);
        ctx.log("trade", "Docked and waiting for network recovery — buy session preserved");
        await ctx.sleep(60000);
        continue;
      }
    }

    // Travel to home station POI
    await ensureUndocked(ctx);
    
    // Pre-travel to home station battle check
    const preHomeStationBattleCheck = await getBattleStatus(ctx);
    if (preHomeStationBattleCheck && preHomeStationBattleCheck.is_participant) {
      ctx.log("combat", `PRE-HOME-STATION: IN BATTLE! Battle ID: ${preHomeStationBattleCheck.battle_id} - initiating flee!`);
      battleState.inBattle = true;
      battleState.battleId = preHomeStationBattleCheck.battle_id;
      battleState.isFleeing = false;
      await fleeFromBattle(ctx, false, 5000);
      await ctx.sleep(5000);
      continue;
    }
    
    if (!mapStore.sameStation(bot.poi, homeStation.id)) {
      ctx.log("travel", `Traveling to ${homeStation.name}...`);
      const t2Resp = await bot.exec("travel", { target_poi: homeStation.id });
      // Check for battle notifications after travel
      if (t2Resp.notifications && Array.isArray(t2Resp.notifications)) {
        const battleDetected = await handleBattleNotifications(ctx, t2Resp.notifications, battleState);
        if (battleDetected) {
          ctx.log("combat", "Battle detected during travel to home station - initiating flee!");
          battleState.isFleeing = false;
        }
      }
      // Direct battle check after travel
      const travelHomeBattleCheck = await getBattleStatus(ctx);
      if (travelHomeBattleCheck && travelHomeBattleCheck.is_participant) {
        ctx.log("combat", `TRAVEL HOME: IN BATTLE! Battle ID: ${travelHomeBattleCheck.battle_id} - fleeing!`);
        battleState.inBattle = true;
        battleState.battleId = travelHomeBattleCheck.battle_id;
        await fleeFromBattle(ctx, true, 35000);
        ctx.log("trade", "Battle detected during travel home - fled, will retry");
        continue;
      }
      if (t2Resp.error && !t2Resp.error.message.includes("already")) {
        ctx.log("error", `Travel to home station failed: ${t2Resp.error.message}`);
      } else {
        bot.poi = homeStation.id;
      }
    }

    // Dock at home station
    yield "dock_home";
    const d2Resp = await bot.exec("dock");
    if (d2Resp.error && !d2Resp.error.message.includes("already")) {
      ctx.log("error", `Dock failed at home: ${d2Resp.error.message}`);
      continue;
    }
    bot.docked = true;

    // ── Deposit items to faction storage ──
    yield "deposit";
    let totalDeposited = 0;

    await bot.refreshCargo();
    const itemToDeposit = bot.inventory.find(i => i.itemId === route.itemId);
    const depositQty = itemToDeposit?.quantity ?? 0;

    if (depositQty <= 0) {
      ctx.log("error", `No ${route.itemName} left in cargo (bought ${buyQty}, all consumed during travel)`);
    } else {
      if (depositQty < buyQty) {
        ctx.log("trade", `Only ${depositQty}/${buyQty}x ${route.itemName} left (${buyQty - depositQty} consumed during travel)`);
      }
      ctx.log("trade", `Depositing ${depositQty}x ${route.itemName} to faction storage...`);
      const depositResp = await bot.exec("faction_deposit_items", { item_id: route.itemId, quantity: depositQty });
      if (!depositResp.error) {
        totalDeposited = depositQty;
        logFactionActivity(ctx, "deposit", `Deposited ${depositQty}x ${route.itemName} from buy run (cost: ${totalSpent}cr)`);
        ctx.log("trade", `Deposited ${totalDeposited}x ${route.itemName} to faction storage`);
      } else {
        ctx.log("error", `Deposit failed: ${depositResp.error.message}`);
      }
    }

    // Complete trade session
    const actualProfit = sanitizeCredits(-totalSpent); // Negative since we're spending, not profiting
    bot.stats.totalTrades++;
    bot.stats.totalProfit = sanitizeCredits(bot.stats.totalProfit + actualProfit);

    await recordMarketData(ctx);

    // ── Buy summary ──
    const depositedLabel = totalDeposited < buyQty ? `${totalDeposited}/${buyQty}` : `${buyQty}`;
    ctx.log("trade", `Buy run complete: ${depositedLabel}x ${route.itemName} — spent ${totalSpent}cr (${route.jumps} jumps)`);

    const actualRevenue = 0;
    const completedSession = await completeTradeSession(bot.username, actualRevenue, actualProfit);
    if (completedSession) {
      ctx.log("trade", `Session completed: ${completedSession.sessionId}`);
    }

    // ── Maintenance ──
    yield "post_buy_maintenance";
    await tryRefuel(ctx);
    await repairShip(ctx);

    // ── Check skills ──
    yield "check_skills";
    await bot.checkSkills();

    await bot.refreshStatus();
    const endFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    ctx.log("info", `Credits: ${bot.credits} | Fuel: ${endFuel}% | Cargo: ${bot.cargo}/${bot.cargoMax}`);
  }
};
