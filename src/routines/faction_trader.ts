/**
 * Faction Trader routine — liquidates items from faction storage.
 *
 * Unlike the full trader, this routine never buys from markets.
 * It withdraws items from faction storage and sells them at the
 * best known buyer station, then returns home.
 */
import type { Bot, Routine, RoutineContext } from "../bot.js";
import { mapStore } from "../mapstore.js";
import { catalogStore } from "../catalogstore.js";
import { extractShipModules, moduleHaystack } from "../shipmodules.js";
import { getSystemBlacklist, getStationBlacklist } from "../web/server.js";
import { clearFactionStorageCache } from "../factionStorageCache.js";
import {
  ensureDocked,
  ensureUndocked,
  tryRefuel,
  repairShip,
  ensureFueled,
  navigateToSystem,
  recordMarketData,
  sanitizeCredits,
  factionDonateProfit,
  logFactionActivity,
  detectAndRecoverFromDeath,
  maxItemsForCargo,
  readSettings,
  writeSettings,
  isPirateSystem,
  checkAndFleeFromBattle,
  checkBattleAfterCommand,
  isFuelCellItem,
} from "./common.js";
import {
  getActiveSession,
  startTradeSession,
  updateTradeSession,
  completeTradeSession,
  failTradeSession,
  abandonTradeSession,
  createTradeSession,
  type TradeSession,
} from "./traderActivity.js";
import {
  getBuyOrderLock,
  getReservedQuantity,
  acquireBuyOrderLock,
  updateBuyOrderLock,
  releaseBuyOrderLock,
  cleanupStaleFactionLocks,
} from "./factionTraderCoordination.js";
import {
  type BattleState,
  handleBattleNotifications,
  getBattleStatus,
  fleeFromBattle,
} from "./common.js";
import {
  AfterburnerBooster,
  type AfterburnerMode,
  type AfterburnerTripPlan,
  detectAfterburnerModule,
  isAfterburnerFuelItem,
  parseAfterburnerMode,
  planAfterburnerTrip,
  stockAfterburnerConsumables,
} from "./afterburner.js";
import { queryRemoteMarket, resolveMarketSource, getMarketSourceInfo } from "../client_sync_hooks.js";
import { readSellOutcome, type SellFill } from "./sellOutcome.js";

// ── Settings ─────────────────────────────────────────────────

interface TradeItemConfig {
  itemId: string;
  maxSellQty: number;  // 0 = sell all available
  minSellPrice: number; // 0 = use global minSellPrice
  soldQty?: number;     // Track quantity sold (persisted in settings)
}

interface CategoryTradeConfig {
  category: string;
  sellPercentOfAvailable: number;  // Percentage of available quantity to sell (0-100)
  pricePercentOfBestBuy: number; // Percentage of best buy price for min sell (25 = 25%)
}

const DEFAULT_CATEGORY_SELL_PERCENT = 50;
const DEFAULT_CATEGORY_PRICE_PERCENT = 25;
const FACTION_TRADER_DEFAULT_MIN_PRICE = 969696;

/**
 * Minimum fraction of an item's best-known buy price beneath which a buy order
 * is treated as a fire-sale and excluded from a faction sale. Applied whenever
 * no explicit per-item / global min sell price is configured, so a valuable
 * item pulled from faction storage can never be dumped at 1cr just because the
 * route planner found one good buyer while a junk 1cr order also exists.
 */
const FACTION_FIRESALE_FLOOR_PERCENT = 50;

/**
 * Resolve the lowest price per unit we are willing to accept for a faction sale.
 *
 * The trader routine guards against fire-sales with a break-even floor, but
 * faction items have no purchase cost, so break-even is ~0 and would not stop a
 * 1cr dump. Instead we floor at a fraction of the item's best-known buy price
 * (or the planned sale price), unless the operator set an explicit min. With no
 * price information at all we refuse to sell (the caller holds / returns it).
 */
function getFactionMinAcceptablePrice(
  itemId: string,
  configuredMin: number,
  plannedPrice: number,
): number {
  if (configuredMin > 0) return configuredMin;
  const basis = plannedPrice > 0 ? plannedPrice : (findBestBuyForItem(itemId)?.price ?? 0);
  if (basis > 0) return Math.max(1, Math.floor((basis * FACTION_FIRESALE_FLOOR_PERCENT) / 100));
  return FACTION_TRADER_DEFAULT_MIN_PRICE;
}

/** Defaults for the afterburner boost (see routines/afterburner.ts). */
const DEFAULT_AFTERBURNER_JUMPS_PER_FUEL = 1;
const DEFAULT_AFTERBURNER_FUEL_BUFFER = 2;
const DEFAULT_AFTERBURNER_MIN_FUEL_CELLS = 10;
const DEFAULT_AFTERBURNER_MIN_JUMPS = 1;
/** A boosted trip must fill at least this fraction of the cargo hold to be worth the fuel. 0 disables the gate. */
const DEFAULT_AFTERBURNER_MIN_FILL_RATIO = 0.5;

function getFactionTraderSettings(username?: string): {
  homeSystem: string;
  homeStation: string;
  fuelCostPerJump: number;
  refuelThreshold: number;
  repairThreshold: number;
  minSellPrice: number;
  tradeItems: TradeItemConfig[];
  stationPriority: boolean;
  categoryTrade: CategoryTradeConfig[];
  sellAllItems: boolean;
  creditsToHold: number;
  disableCreditDeposit: boolean;
  useRemoteMarketQuery: boolean;
  autoCloak: boolean;
  ignorePiratesWhenCloaked: boolean;
  afterburnerMode: AfterburnerMode;
  afterburnerJumpsPerFuel: number;
  afterburnerFuelBuffer: number;
  afterburnerMinFuelCells: number;
  afterburnerMinJumps: number;
  afterburnerMinFillRatio: number;
} {
  const all = readSettings();
  const general = all.general || {};
  const t = all.faction_trader || {};
  const botOverrides = username ? (all[username] || {}) : {};

  // Migrate old format (string array) to new format if needed
  let tradeItems: TradeItemConfig[] = [];
  if (Array.isArray(t.tradeItems)) {
    if (t.tradeItems.length > 0 && typeof t.tradeItems[0] === 'string') {
      // Old format: string array
      tradeItems = (t.tradeItems as string[]).map((itemId: string) => ({
        itemId,
        maxSellQty: 0,
        minSellPrice: 0,
        soldQty: 0,
      }));
    } else {
      // New format: object array
      tradeItems = (t.tradeItems as TradeItemConfig[]).map((item: any) => ({
        itemId: item.itemId || '',
        maxSellQty: item.maxSellQty || 0,
        minSellPrice: item.minSellPrice || 0,
        soldQty: item.soldQty || 0,
      })).filter(item => item.itemId);
    }
  }

  // Load category trade configs with defaults
  const categoryTrade: CategoryTradeConfig[] = (Array.isArray(t.categoryTrade) ? t.categoryTrade : []).map((c: any) => ({
    category: c.category || '',
    sellPercentOfAvailable: c.sellPercentOfAvailable ?? DEFAULT_CATEGORY_SELL_PERCENT,
    pricePercentOfBestBuy: c.pricePercentOfBestBuy ?? DEFAULT_CATEGORY_PRICE_PERCENT,
  })).filter((c: CategoryTradeConfig) => c.category);

  return {
    // Use faction storage station from general settings as home, fallback to faction_trader-specific
    homeSystem: (botOverrides.homeSystem as string)
      || (t.homeSystem as string)
      || (general.factionStorageSystem as string) || "",
    homeStation: (botOverrides.homeStation as string)
      || (t.homeStation as string)
      || (general.factionStorageStation as string) || "",
    fuelCostPerJump: (t.fuelCostPerJump as number) || 50,
    refuelThreshold: (t.refuelThreshold as number) || 50,
    repairThreshold: (t.repairThreshold as number) || 40,
    minSellPrice: (t.minSellPrice as number) || 0,
    tradeItems,
    stationPriority: (botOverrides.stationPriority as boolean) || false,
    categoryTrade,
    sellAllItems: (t.sellAllItems as boolean) || false,
    creditsToHold: (t.creditsToHold as number) || 10000,
    disableCreditDeposit: (t.disableCreditDeposit as boolean) || false,
    useRemoteMarketQuery: (t.useRemoteMarketQuery as boolean) ?? true,
    autoCloak: (t.autoCloak as boolean) ?? true,
    ignorePiratesWhenCloaked: (t.ignorePiratesWhenCloaked as boolean) ?? true,
    // Afterburner boost — per-bot override wins so a fleet can mix boosted and
    // unboosted hulls without splitting the shared faction_trader profile.
    afterburnerMode: parseAfterburnerMode(
      botOverrides.afterburnerMode ?? t.afterburnerMode ?? "auto",
    ),
    afterburnerJumpsPerFuel:
      (botOverrides.afterburnerJumpsPerFuel as number)
      || (t.afterburnerJumpsPerFuel as number)
      || DEFAULT_AFTERBURNER_JUMPS_PER_FUEL,
    afterburnerFuelBuffer:
      (t.afterburnerFuelBuffer as number) ?? DEFAULT_AFTERBURNER_FUEL_BUFFER,
    afterburnerMinFuelCells:
      (t.afterburnerMinFuelCells as number) ?? DEFAULT_AFTERBURNER_MIN_FUEL_CELLS,
    afterburnerMinJumps:
      (t.afterburnerMinJumps as number) ?? DEFAULT_AFTERBURNER_MIN_JUMPS,
    afterburnerMinFillRatio:
      (t.afterburnerMinFillRatio as number) ?? DEFAULT_AFTERBURNER_MIN_FILL_RATIO,
  };
}

/**
 * Release the buy-order claim tied to a bot's active session, if any.
 *
 * Claims are keyed by item + POI only, so the session's destination is all that
 * is needed. The old code passed `session.sellPricePerUnit` as part of the key,
 * which meant a claim made at one price could never be released after the book
 * moved — the lock then leaked until the stale sweep found it.
 */
function releaseSessionLock(botUsername: string, reason: string): boolean {
  const session = getActiveSession(botUsername);
  if (!session) return false;
  return releaseBuyOrderLock(botUsername, session.itemId, session.destPoi, reason);
}

/**
 * Fail a faction trade session and release its buy order lock.
 */
async function failFactionSession(botUsername: string, reason: string): Promise<void> {
  releaseSessionLock(botUsername, reason);
  await failTradeSession(botUsername, reason);
}

/** Verify that a destination POI exists as a valid station with a market. */
export function isValidDestination(ctx: RoutineContext, systemId: string, poiId: string): boolean {
  const sys = mapStore.getSystem(systemId);
  if (!sys) {
    ctx.log("error", `Destination system ${systemId} not found in map data`);
    return false;
  }
  const poi = sys.pois.find(p => p.id === poiId);
  if (!poi) {
    ctx.log("error", `Destination POI ${poiId} not found in system ${systemId}`);
    return false;
  }
  // Faction-owned deployable outposts cannot host a trade market and can never
  // be docked by outsiders, so a buy demand attributed to one is bogus. They
  // cannot be told apart from stations automatically (they are not typed
  // "outpost"), so they must be listed in the station blacklist instead.
  if (getStationBlacklist().some(b => b.toLowerCase() === poiId.toLowerCase() || b.toLowerCase() === `${systemId}|${poiId}`.toLowerCase())) {
    ctx.log("error", `Destination ${poi.name} (${poiId}) in ${systemId} is a blacklisted station/outpost — rejecting as buyer`);
    return false;
  }
  // Check for either has_base OR base_id (some stations have base_id but not has_base)
  if (!poi.has_base && !poi.base_id) {
    ctx.log("error", `Destination ${poi.name} (${poiId}) in ${systemId} is not a valid station (no dock)`);
    return false;
  }
  if (!poi.market || poi.market.length === 0) {
    ctx.log("error", `Destination ${poi.name} (${poiId}) in ${systemId} has no market data`);
    return false;
  }
  return true;
}

// ── Trade Session Recovery ──────────────────────────────────

/**
 * Check for and recover an incomplete faction trade session.
 * Validates cargo, destination, and market conditions.
 * Returns the recovered session if valid, or null if recovery is not possible.
 */
async function recoverFactionTradeSession(
  ctx: RoutineContext,
  session: TradeSession,
  settings: ReturnType<typeof getFactionTraderSettings>,
): Promise<TradeSession | null> {
  const { bot } = ctx;

  ctx.log("trade", `Found incomplete trade session: ${session.itemName} (${session.state})`);

  // Verify items are still in cargo (for in_transit and beyond)
  if (session.state === "in_transit" || session.state === "at_destination" || session.state === "selling") {
    await bot.refreshCargo();
    const cargoItem = bot.inventory.find(i => i.itemId === session.itemId);
    const cargoQty = cargoItem?.quantity ?? 0;

  if (cargoQty <= 0) {
    ctx.log("error", `Recovery failed: ${session.itemName} no longer in cargo`);
    await failFactionSession(session.botUsername, "Items not in cargo");
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

  // Check if we're at the destination
  if (session.state === "in_transit" || session.state === "at_destination" || session.state === "selling") {
    // Verify the destination buyer still exists and price is still profitable
    const allBuys = mapStore.getAllBuyDemand();
    const destBuyer = allBuys.find(b =>
      b.itemId === session.itemId &&
      b.systemId === session.destSystem &&
      b.poiId === session.destPoi
    );

      if (!destBuyer || destBuyer.quantity <= 0) {
        // The buyer vanished before we could sell. Do NOT reroute to the
        // nearest/highest-price station and dump the cargo there — we'd lose
        // track of a valuable item forever. Put it back where we got it.
        const originSystem = session.sourceSystem || settings.homeSystem;
        const originPoi = session.sourcePoi || getHomeStationPoi(settings.homeStation);
        const originName = session.sourcePoiName || originPoi || originSystem;

        ctx.log("trade", `Destination buyer gone at ${session.destPoiName} — returning cargo to origin (${originName}) instead of dumping it elsewhere`);

        // Release the stale lock for the original destination BEFORE mutating the
        // session's destination, or the lock leaks and blocks other bots.
        releaseBuyOrderLock(
          bot.username,
          session.itemId,
          session.destPoi,
          "buyer_gone_returning_to_origin",
        );

        const updated = await updateTradeSession(session.botUsername, {
          destSystem: originSystem,
          destPoi: originPoi,
          destPoiName: originName,
          returnToSource: true,
          sellQuantity: session.quantityBought,
          totalJumps: session.jumpsCompleted + estimateFuelCost(bot.system, originSystem, settings.fuelCostPerJump).jumps,
          notes: (session.notes || "") + ` | Buyer gone — returning to ${originName}`,
        });
        if (updated) session = updated;
      } else if (destBuyer.price < session.buyPricePerUnit) {
        // For faction trades, buyPricePerUnit is 0 (no purchase cost), so this
        // only fires when the price dropped to 0/unprofitable. Return home too.
        if (destBuyer.price <= 0) {
          const originSystem = session.sourceSystem || settings.homeSystem;
          const originPoi = session.sourcePoi || getHomeStationPoi(settings.homeStation);
          const originName = session.sourcePoiName || originPoi || originSystem;

          ctx.log("trade", `Price dropped to ${destBuyer.price}cr at ${session.destPoiName} — returning cargo to origin (${originName})`);
          releaseBuyOrderLock(
            bot.username,
            session.itemId,
            session.destPoi,
            "price_zero_returning_to_origin",
          );
          const updated = await updateTradeSession(session.botUsername, {
            destSystem: originSystem,
            destPoi: originPoi,
            destPoiName: originName,
            returnToSource: true,
            sellQuantity: session.quantityBought,
            totalJumps: session.jumpsCompleted + estimateFuelCost(bot.system, originSystem, settings.fuelCostPerJump).jumps,
            notes: (session.notes || "") + ` | Price zero — returning to origin`,
          });
          if (updated) session = updated;
        }
      }
  }

  ctx.log("trade", `Session recovered: ${session.quantityBought}x ${session.itemName} → ${session.destPoiName}`);

  // When returning cargo to origin we deposit (not sell), so no buy order lock
  // is needed — skip straight through.
  if (session.returnToSource) {
    return session;
  }

  // Reacquire buy order lock for recovered session
  const existingLock = getBuyOrderLock(session.itemId, session.destPoi);
  
  if (existingLock && existingLock.lockedBy !== bot.username) {
    ctx.log("trade", `Buy order lock held by ${existingLock.lockedBy} — attempting to reacquire`);
    const reacquired = acquireBuyOrderLock({
      botUsername: bot.username,
      itemId: session.itemId,
      itemName: session.itemName,
      destSystem: session.destSystem,
      destPoi: session.destPoi,
      destPoiName: session.destPoiName,
      pricePerUnit: session.sellPricePerUnit,
      quantityCommitted: session.sellQuantity,
      sessionId: session.sessionId,
    });
    if (!reacquired) {
      ctx.log("error", "Failed to reacquire buy order lock — abandoning session");
      await failFactionSession(session.botUsername, "Could not reacquire buy order lock");
      return null;
    }
  } else if (!existingLock) {
    // No lock exists — acquire new one
    const acquired = acquireBuyOrderLock({
      botUsername: bot.username,
      itemId: session.itemId,
      itemName: session.itemName,
      destSystem: session.destSystem,
      destPoi: session.destPoi,
      destPoiName: session.destPoiName,
      pricePerUnit: session.sellPricePerUnit,
      quantityCommitted: session.sellQuantity,
      sessionId: session.sessionId,
    });
    if (!acquired) {
      ctx.log("error", "Failed to acquire buy order lock — abandoning session");
      await failFactionSession(session.botUsername, "Could not acquire buy order lock");
      return null;
    }
  }

  return session;
}

// ── Types ────────────────────────────────────────────────────

interface FactionSellRoute {
  itemId: string;
  itemName: string;
  availableQty: number;
  destSystem: string;
  destPoi: string;
  destPoiName: string;
  sellPrice: number;
  sellQty: number;
  jumps: number;           // one-way jumps to destination
  roundTripJumps: number;  // dest + return home
  totalRevenue: number;
  totalProfit: number;     // revenue minus material cost and round-trip fuel
  /** True when this route is a "buyer vanished — return cargo home" run. */
  returningToSource?: boolean;
}

// ── Helpers ──────────────────────────────────────────────────

/** Find the cheapest known market sell price for an item (replacement/acquisition cost). */
function getItemMarketCost(itemId: string): number {
  let cheapest = Infinity;
  const systems = mapStore.getAllSystems();
  for (const sys of Object.values(systems)) {
    // Skip pirate systems
    if (isPirateSystem(sys.id)) continue;
    for (const poi of sys.pois) {
      for (const m of poi.market) {
        if (m.item_id === itemId && m.best_sell !== null && m.best_sell > 0) {
          if (m.best_sell < cheapest) cheapest = m.best_sell;
        }
      }
    }
  }
  return cheapest === Infinity ? 0 : cheapest;
}

/** Check if an item is a high-value item (potential profit > threshold). */
function isHighValueItem(itemId: string, minProfitThreshold: number = 1000000): boolean {
  const bestBuy = findBestBuyForItem(itemId);
  if (!bestBuy || bestBuy.price <= 0) return false;
  const marketCost = getItemMarketCost(itemId);
  const potentialProfit = bestBuy.price - (marketCost > 0 ? marketCost : 0);
  return potentialProfit >= minProfitThreshold;
}

/**
 * Calculate optimal sell quantity based on actual buy orders at destination.
 * Calls view_market to get real buy orders with quantities.
 */
export async function calculateFactionOptimalSellQuantity(
  ctx: RoutineContext,
  itemId: string,
  itemName: string,
  availableQuantity: number,
  minPricePerUnit: number,
): Promise<{
  sellQty: number;
  heldQty: number;
  expectedRevenue: number;
  priceBreakdown: string;
  weightedAvgPrice: number;
  /** The resolved price floor actually applied, so the sell path can enforce the same number. */
  floor: number;
  buyOrders: Array<{ priceEach: number; orderQty: number; qtyToSell: number }>;
}> {
  const { bot } = ctx;

  // Fire-sale guard: if no explicit floor was configured, derive one from the
  // item's value so a valuable item is never dumped at a junk (e.g. 1cr) price.
  let floor = minPricePerUnit;
  if (floor <= 0) {
    floor = getFactionMinAcceptablePrice(itemId, 0, 0);
  }

  // Check the market for this specific item
  const marketResp = await bot.exec("view_market", { item_id: itemId });
  if (marketResp.error || !marketResp.result) {
    ctx.log("trade", `view_market failed for ${itemName} — using cached data`);
    return {
      sellQty: availableQuantity,
      heldQty: 0,
      expectedRevenue: availableQuantity * floor,
      priceBreakdown: "cached",
      weightedAvgPrice: floor,
      floor,
      buyOrders: [],
    };
  }

  const marketData = marketResp.result as Record<string, unknown>;
  const items = (
    Array.isArray(marketData) ? marketData :
    Array.isArray((marketData as Record<string, unknown>).items) ? (marketData as Record<string, unknown>).items :
    []
  ) as Array<Record<string, unknown>>;

  const itemMarket = items.find(i => (i.item_id as string) === itemId);
  if (!itemMarket) {
    ctx.log("trade", `No market data for ${itemName} — using cached data`);
    return {
      sellQty: availableQuantity,
      heldQty: 0,
      expectedRevenue: availableQuantity * floor,
      priceBreakdown: "cached",
      weightedAvgPrice: floor,
      floor,
      buyOrders: [],
    };
  }

  const rawBuyOrders = (itemMarket.buy_orders as Array<Record<string, unknown>>) || [];
  if (rawBuyOrders.length === 0) {
    ctx.log("trade", `No buy orders for ${itemName} — cannot sell`);
    return { sellQty: 0, heldQty: availableQuantity, expectedRevenue: 0, priceBreakdown: "no buy orders", weightedAvgPrice: 0, floor, buyOrders: [] };
  }

  // Fill best-priced orders first — exactly how the in-game sell behaves.
  const sorted = rawBuyOrders
    .map(o => ({
      priceEach: (o.price_each as number) || (o.price as number) || 0,
      orderQty: (o.quantity as number) || (o.remaining as number) || 0,
    }))
    .filter(o => o.orderQty > 0 && o.priceEach > 0)
    .sort((a, b) => b.priceEach - a.priceEach);

  // Sell ONLY units priced at or above the floor. Anything below the floor is
  // held (and routed to an alternate buyer) instead of being dumped at a
  // fire-sale price that destroys the whole trade's profit — mirroring the
  // trader routine's sellUpToFloor guard.
  let remaining = availableQuantity;
  let totalRevenue = 0;
  let totalSold = 0;
  let heldQty = 0;
  const priceDetails: string[] = [];
  const eligibleBuyOrders: Array<{ priceEach: number; orderQty: number; qtyToSell: number }> = [];

  for (const order of sorted) {
    if (remaining <= 0) break;

    const qtyAtThisPrice = Math.min(remaining, order.orderQty);

    if (order.priceEach >= floor) {
      totalRevenue += qtyAtThisPrice * order.priceEach;
      totalSold += qtyAtThisPrice;
      remaining -= qtyAtThisPrice;
      priceDetails.push(`${qtyAtThisPrice}x @ ${order.priceEach}cr`);
      eligibleBuyOrders.push({
        priceEach: order.priceEach,
        orderQty: order.orderQty,
        qtyToSell: qtyAtThisPrice,
      });
    } else {
      // Below our floor — do not sell here.
      heldQty += qtyAtThisPrice;
      remaining -= qtyAtThisPrice;
    }
  }

  const weightedAvgPrice = totalSold > 0 ? totalRevenue / totalSold : 0;
  const priceBreakdown = priceDetails.join(", ");

  if (heldQty > 0) {
    ctx.log("warn", `Market check: ${totalSold}/${availableQuantity}x ${itemName} at >=${floor}cr (${priceBreakdown || "none"}), ${heldQty}x only available below floor — holding`);
  } else if (totalSold < availableQuantity) {
    ctx.log("trade", `Market check: can sell ${totalSold}/${availableQuantity}x ${itemName} (${priceBreakdown})`);
  }

  return { sellQty: totalSold, heldQty, expectedRevenue: totalRevenue, priceBreakdown, weightedAvgPrice, floor, buyOrders: eligibleBuyOrders };
}

// ── Sell execution & realized-price verification ─────────────

export interface FactionSellResult {
  /** Units that left the hold at market. */
  sold: number;
  /** Credits actually received. 0 for a listing — nothing is earned until it fills. */
  revenue: number;
  /** Units handed to a limit order instead of sold at market. */
  listed: number;
  /** Realized average price per unit. */
  avgPrice: number;
  /** A fill landed below the floor: the book was swept out from under us. */
  belowFloor: boolean;
  fills: SellFill[];
  /** Raw notifications from the sell command, so callers keep their battle checks. */
  notifications: unknown[];
  error?: string;
}

/** Compact, honest description of what a sale actually returned. */
function describeFills(result: FactionSellResult): string {
  if (result.fills.length === 0) {
    return `${result.sold}x for ${result.revenue}cr`;
  }
  const detail = result.fills.map(f => `${f.quantity}x @ ${f.priceEach}cr`).join(", ");
  return `${result.sold}x for ${result.revenue}cr (${detail})`;
}

/**
 * The single chokepoint for turning faction cargo into credits.
 *
 * Two protections live here, both learned from the Node Alpha fuel-cell incident:
 *
 * 1. **Contested books get a limit order, not a market order.** The `sell`
 *    endpoint takes only `id`/`quantity`/`auto_list` — there is no min-price
 *    parameter, so a market order will happily sweep past every good bid into a
 *    junk one if someone empties the book between our `view_market` and our
 *    `sell`. When another of our bots holds a claim on this station's book we
 *    use `create_sell_order` with an explicit `price_each` instead, which cannot
 *    fill below that price.
 *
 * 2. **Realized prices are verified against the floor.** Whatever path ran, the
 *    per-fill prices are checked and a breach is reported loudly instead of
 *    being papered over with the quoted average.
 */
async function executeFactionSell(
  ctx: RoutineContext,
  params: {
    itemId: string;
    itemName: string;
    quantity: number;
    /** Lowest acceptable price per unit. 0 disables both the limit path and the check. */
    floor: number;
    /** Best eligible bid seen in the pre-sale market check, used as the limit ask. */
    bestQuotedPrice: number;
    destPoi: string;
    destPoiName: string;
    /** Skip the post-sell settle wait when the caller does its own. */
    settleMs?: number;
  },
): Promise<FactionSellResult> {
  const { bot } = ctx;
  const { itemId, itemName, quantity, floor, bestQuotedPrice, destPoi, destPoiName } = params;
  const settleMs = params.settleMs ?? 12000;

  const none: FactionSellResult = {
    sold: 0, revenue: 0, listed: 0, avgPrice: 0, belowFloor: false, fills: [], notifications: [],
  };
  if (quantity <= 0) return none;

  const cargoBefore = bot.inventory.find(i => i.itemId === itemId)?.quantity ?? 0;
  const contender = getBuyOrderLock(itemId, destPoi, bot.username);

  // ── Contested: list at a protected price instead of sweeping the book ──
  if (contender && floor > 0) {
    const askPrice = Math.max(floor, Math.floor(bestQuotedPrice) || floor);
    ctx.log(
      "warn",
      `${itemName} book at ${destPoiName} is also claimed by ${contender.lockedBy} — listing ${quantity}x @ ${askPrice}cr instead of a market sell (a market order could sweep below the ${floor}cr floor)`,
    );

    const listResp = await bot.exec("create_sell_order", {
      item_id: itemId,
      quantity,
      price_each: askPrice,
    });

    if (listResp.error) {
      ctx.log("error", `Limit sell order failed for ${itemName}: ${listResp.error.message}`);
      return { ...none, error: listResp.error.message };
    }

    await ctx.sleep(settleMs);
    await bot.refreshCargo();

    ctx.log("trade", `Listed ${quantity}x ${itemName} @ ${askPrice}cr at ${destPoiName} — no credits until it fills`);
    return { ...none, listed: quantity, notifications: listResp.notifications ?? [] };
  }

  // ── Uncontested: market sell ──
  const creditsBefore = bot.credits;
  const sResp = await bot.exec("sell", { item_id: itemId, quantity });
  if (sResp.error) {
    return { ...none, error: sResp.error.message, notifications: sResp.notifications ?? [] };
  }

  await ctx.sleep(settleMs);
  await bot.refreshCargo();

  const outcome = readSellOutcome(sResp.result as Record<string, unknown> | undefined);
  const creditDelta = sanitizeCredits(bot.credits - creditsBefore);

  // The response is authoritative; the credit delta is the cross-check. If the
  // response carried nothing usable, fall back to the delta — never to a quote.
  let sold = outcome.soldQty;
  let revenue = outcome.revenue;
  if (!outcome.verified || revenue <= 0) {
    if (creditDelta > 0) {
      revenue = creditDelta;
      if (sold <= 0) sold = quantity;
      ctx.log("warn", `Sell response carried no totals for ${itemName} — using verified credit delta of ${revenue}cr`);
    } else {
      ctx.log("warn", `Sell of ${quantity}x ${itemName} reported no revenue and no credit change — treating as 0cr earned`);
    }
  } else if (creditDelta > 0 && Math.abs(creditDelta - revenue) > 1) {
    ctx.log(
      "warn",
      `Sell revenue mismatch for ${itemName}: response says ${revenue}cr, credit delta says ${creditDelta}cr — trusting the response`,
    );
  }

  const result: FactionSellResult = {
    sold,
    revenue,
    listed: 0,
    avgPrice: sold > 0 ? revenue / sold : 0,
    belowFloor: false,
    fills: outcome.fills,
    notifications: sResp.notifications ?? [],
  };

  // The cargo endpoint sometimes lags a tick behind the sale. The server's
  // `quantity_sold` is authoritative, so reconcile the local hold against it
  // rather than making every caller re-implement the same patch-up.
  if (sold > 0) {
    const item = bot.inventory.find(i => i.itemId === itemId);
    const cargoNow = item?.quantity ?? 0;
    if (cargoNow > Math.max(0, cargoBefore - sold)) {
      ctx.log("warn", `Cargo endpoint still shows ${cargoNow}x ${itemName} after selling ${sold}x — correcting locally`);
      if (item) {
        item.quantity = Math.max(0, cargoBefore - sold);
        if (item.quantity <= 0) bot.inventory = bot.inventory.filter(i => i.itemId !== itemId);
      }
    }
  }

  // ── Slippage guard ──
  if (floor > 0 && sold > 0) {
    const worst = outcome.worstFillPrice > 0 ? outcome.worstFillPrice : result.avgPrice;
    if (worst < floor) {
      result.belowFloor = true;
      const quoted = bestQuotedPrice > 0 ? `${bestQuotedPrice}cr` : "unknown";
      ctx.log(
        "error",
        `FIRE-SALE: ${itemName} at ${destPoiName} filled at ${Math.round(result.avgPrice)}cr/unit (worst ${worst}cr) against a ${floor}cr floor and a ${quoted} quote — the book was swept before our order landed. Realized ${describeFills(result)}`,
      );
      const thief = outcome.fills.find(f => f.priceEach < floor)?.counterparty;
      if (thief) ctx.log("error", `Below-floor units went to ${thief}`);
    }
  }

  return result;
}

/**
 * Restate a route's profit against what the sale actually earned.
 *
 * Faction stock has no acquisition cost, so the planner's
 * `totalProfit = totalRevenue - roundTripFuel`; recovering the fuel figure that
 * way lets us re-derive profit from realized revenue without threading the fuel
 * estimate through every call site.
 *
 * Reporting the *planned* `route.totalProfit` is what turned a 400cr fire-sale
 * into a logged 7412cr win — and made `factionDonateProfit` pay 741cr out of the
 * treasury on a trade that grossed 400cr.
 */
function realizedFactionProfit(route: FactionSellRoute, realizedRevenue: number): number {
  const roundTripFuelCost = Math.max(0, route.totalRevenue - route.totalProfit);
  return sanitizeCredits(realizedRevenue - roundTripFuelCost);
}

/** Free cargo weight (not item count — callers must divide by item size). */
function getFreeSpace(bot: Bot): number {
  if (bot.cargoMax <= 0) return 999;
  return Math.max(0, bot.cargoMax - bot.cargo);
}

/**
 * Resolve the bare POI id for the configured home station.
 *
 * `homeStation` is stored as "system|poi" (e.g. general.factionStorageStation)
 * but `bot.poi` is only the bare POI id. Comparing/using them directly causes
 * the bot to think it is "home" whenever `bot.poi` gets set to the malformed
 * "system|poi" string (or to never match a real home station). Always normalize.
 */
export function getHomeStationPoi(homeStation: string): string {
  if (!homeStation) return "";
  return homeStation.includes("|") ? homeStation.split("|")[1] : homeStation;
}

/**
 * Detect whether the bot's ship has a cloaking module installed.
 * Cloaking modules have "cloak" in their name, id, or special fields.
 * Returns true if a cloaking module is detected.
 */
async function hasCloakingModule(ctx: RoutineContext): Promise<boolean> {
  const { bot } = ctx;
  const shipResp = await bot.exec("get_ship");
  if (shipResp.error || !shipResp.result) return false;
  const { modules } = extractShipModules(shipResp.result);

  for (const mod of modules) {
    if (moduleHaystack(mod).includes("cloak")) return true;
  }
  return false;
}

/**
 * Enable cloaking on the bot if not already cloaked.
 * Once enabled, it stays on until fuel runs out.
 * Returns true if cloaking was enabled (or already was), false if no cloak module.
 */
async function enableCloakingIfPossible(ctx: RoutineContext): Promise<boolean> {
  const { bot } = ctx;

  if (bot.isCloaked) {
    ctx.log("trade", "Bot is already cloaked - no action needed");
    return true;
  }

  const hasCloak = await hasCloakingModule(ctx);
  if (!hasCloak) {
    ctx.log("trade", "No cloaking module detected - cannot enable cloak");
    return false;
  }

  ctx.log("trade", "Enabling cloaking module...");
  const resp = await bot.exec("cloak", { enable: true });
  if (resp.error) {
    ctx.log("error", `Failed to enable cloak: ${resp.error.message}`);
    return false;
  }

  ctx.log("trade", "Cloaking enabled successfully");
  return true;
}

// ── Afterburner boost ────────────────────────────────────────

/**
 * Decide whether this trip runs boosted, and how many consumables it needs.
 *
 * Detection-first: unless the mode is forced to "always"/"never" the bot only
 * boosts when an afterburner utility module is actually fitted, so a shared
 * faction_trader profile can be enabled fleet-wide without breaking traders
 * that have no module (or already fly Speed 6 hulls).
 */
async function planTripAfterburner(
  ctx: RoutineContext,
  settings: ReturnType<typeof getFactionTraderSettings>,
  roundTripJumps: number,
): Promise<AfterburnerTripPlan> {
  const module = await detectAfterburnerModule(ctx);
  const plan = planAfterburnerTrip(module, {
    mode: settings.afterburnerMode,
    roundTripJumps,
    jumpsPerFuel: settings.afterburnerJumpsPerFuel,
    fuelBuffer: settings.afterburnerFuelBuffer,
    minMilitaryFuelCells: settings.afterburnerMinFuelCells,
    minJumpsToBoost: settings.afterburnerMinJumps,
  });

  if (plan.boost) {
    ctx.log(
      "trade",
      `Afterburner boost ON — ${plan.reason}; needs ${plan.fuelUnitsNeeded}x afterburner fuel ` +
      `and ${plan.militaryFuelCellsNeeded}x military fuel cells for ${roundTripJumps} round-trip jump(s)`,
    );
  } else {
    ctx.log("trade", `Afterburner boost off — ${plan.reason}`);
  }
  return plan;
}

/**
 * Build the booster for a leg using whatever afterburner fuel is already in
 * cargo. Used when resuming an interrupted session away from home, where we
 * cannot withdraw anything.
 */
async function boosterFromCargo(
  ctx: RoutineContext,
  plan: AfterburnerTripPlan,
): Promise<AfterburnerBooster | null> {
  const { bot } = ctx;
  if (!plan.boost) return null;

  await bot.refreshCargo();
  const units = bot.inventory.find(i => isAfterburnerFuelItem(i.itemId))?.quantity ?? 0;
  if (units <= 0) {
    ctx.log("trade", "Afterburner boost off — no afterburner fuel in cargo for this leg");
    return null;
  }
  ctx.log("trade", `Afterburner boost ON — ${units}x afterburner fuel already in cargo`);
  return new AfterburnerBooster(ctx, {
    enabled: true,
    jumpsPerFuel: plan.jumpsPerFuel,
    unitsInCargo: units,
  });
}

/** Estimate fuel cost between two systems using mapStore route data. */
function estimateFuelCost(fromSystem: string, toSystem: string, costPerJump: number = 50): { jumps: number; cost: number } {
  const blacklist = getSystemBlacklist();
  if (fromSystem === toSystem) return { jumps: 0, cost: 0 };
  const route = mapStore.findRoute(fromSystem, toSystem, blacklist);
  if (!route) return { jumps: 999, cost: 999 * costPerJump };
  const jumps = route.length - 1;
  return { jumps, cost: jumps * costPerJump };
}

/** Get items from faction storage filtered by categories. */
function getItemsByCategories(
  storage: Array<{ itemId: string; name: string; quantity: number }>,
  categories: string[],
): Array<{ itemId: string; name: string; quantity: number }> {
  if (categories.length === 0) return storage;
  
  const result: Array<{ itemId: string; name: string; quantity: number }> = [];
  const categorySet = new Set(categories.map(c => c.toLowerCase()));
  
  for (const item of storage) {
    const catalogItem = catalogStore.getItem(item.itemId);
    const itemCategory = (catalogItem?.category as string) || '';
    if (categorySet.has(itemCategory.toLowerCase())) {
      result.push(item);
    }
  }
  
  return result;
}

/** Find the best buy price for an item across all markets. */
function findBestBuyForItem(itemId: string): { price: number; systemId: string; poiId: string; poiName: string; quantity: number } | null {
  const allBuys = mapStore.getAllBuyDemand();
  const buyers = allBuys
    .filter(b => b.itemId === itemId && b.price > 0)
    .sort((a, b) => b.price - a.price);
  
  if (buyers.length === 0) return null;
  return buyers[0];
}

/** Calculate min sell price for category-based items. */
function calculateCategoryMinSellPrice(itemId: string, pricePercent: number): number {
  const bestBuy = findBestBuyForItem(itemId);
  if (!bestBuy || bestBuy.price <= 0) {
    return FACTION_TRADER_DEFAULT_MIN_PRICE;
  }
  return Math.floor(bestBuy.price * (pricePercent / 100));
}

/**
 * The subset of settings that decides what may be sold and at what floor.
 * Narrower than the full settings blob so the pure helpers below stay easy to
 * reason about (and to test).
 */
export type SellPolicySettings = Pick<
  ReturnType<typeof getFactionTraderSettings>,
  "tradeItems" | "categoryTrade" | "minSellPrice"
>;

/**
 * Resolve the minimum sell price this routine applies to an item, using the
 * SAME precedence as the storage planner: explicit per-item config → category
 * config (a percentage of the best known buy price) → global minimum.
 *
 * The cargo-recovery path used to only ever consult the per-item/global values.
 * A category item withdrawn against a category floor could therefore be judged
 * unsellable the instant it landed in the hold, so the bot would carry it back,
 * stow it, withdraw it again next cycle and bounce forever.
 */
export function getEffectiveMinSellPrice(
  itemId: string,
  settings: SellPolicySettings,
): number {
  const lower = itemId.toLowerCase();
  const itemConfig = settings.tradeItems.find(t => t.itemId.toLowerCase() === lower);
  if (itemConfig) {
    return itemConfig.minSellPrice > 0 ? itemConfig.minSellPrice : settings.minSellPrice;
  }
  if (settings.categoryTrade.length > 0) {
    const category = ((catalogStore.getItem(itemId)?.category as string) || "").toLowerCase();
    const catConfig = category
      ? settings.categoryTrade.find(c => c.category.toLowerCase() === category)
      : undefined;
    if (catConfig) return calculateCategoryMinSellPrice(itemId, catConfig.pricePercentOfBestBuy);
  }
  return settings.minSellPrice;
}

/**
 * Ship consumables (fuel cells, afterburner fuel) that the trader deliberately
 * keeps aboard for the trip. They are NOT leftover trade goods: treating them
 * as such put the bot into "cargo recovery" on every cycle, so it never looked
 * at storage again and kept hunting for buyers for the very fuel it needs to fly.
 *
 * Detection is catalog-driven (`isFuelCellItem` = "the refuel command can burn
 * this"). A substring test on "fuel" would be wrong in both directions and
 * would quietly strand real trade goods such as fusion_fuel_rod,
 * reactor_fuel_assembly or dark_energy_cell in the hold forever.
 */
function isShipConsumableItem(itemId: string): boolean {
  return isAfterburnerFuelItem(itemId) || isFuelCellItem(itemId);
}

/**
 * True when a cargo item is trade goods this routine must sell or stow.
 * Consumables only count when the operator explicitly listed them as a trade
 * item or trade category (a faction that really does sell fuel cells).
 */
export function isTradeCargoItem(
  itemId: string,
  settings: SellPolicySettings,
): boolean {
  if (!isShipConsumableItem(itemId)) return true;
  const lower = itemId.toLowerCase();
  if (settings.tradeItems.some(t => t.itemId.toLowerCase() === lower)) return true;
  if (settings.categoryTrade.length > 0) {
    const category = ((catalogStore.getItem(itemId)?.category as string) || "").toLowerCase();
    if (category && settings.categoryTrade.some(c => c.category.toLowerCase() === category)) {
      return true;
    }
  }
  return false;
}

/**
 * Put cargo back into storage: faction first, personal storage as a fallback so
 * a station without faction storage still gets the hold emptied instead of the
 * bot idling with a full hold forever.
 */
async function depositCargoItem(
  ctx: RoutineContext,
  itemId: string,
  quantity: number,
  personalMode: boolean,
): Promise<{ ok: boolean; target?: "faction" | "personal"; error?: string }> {
  const { bot } = ctx;
  if (quantity <= 0) return { ok: true, target: personalMode ? "personal" : "faction" };

  if (personalMode) {
    const resp = await bot.exec("storage", { action: 'deposit', target: 'storage', item_id: itemId, quantity });
    return resp.error ? { ok: false, error: resp.error.message } : { ok: true, target: "personal" };
  }

  const factionResp = await bot.exec("storage", { action: 'deposit', target: 'faction', item_id: itemId, quantity });
  if (!factionResp.error) return { ok: true, target: "faction" };
  const personalResp = await bot.exec("storage", { action: 'deposit', target: 'storage', item_id: itemId, quantity });
  if (!personalResp.error) return { ok: true, target: "personal" };
  return {
    ok: false,
    error: `${factionResp.error.message} (personal storage fallback: ${personalResp.error.message})`,
  };
}

/** Find sell routes for items currently in faction storage. Factors round-trip fuel cost. */
function findFactionSellRoutes(
  ctx: RoutineContext,
  settings: ReturnType<typeof getFactionTraderSettings>,
  currentSystem: string,
  cargoCapacity: number,
  personalMode: boolean = false,
  extraBuyDemand: Array<{ itemId: string; itemName: string; systemId: string; poiId: string; poiName: string; price: number; quantity: number }> = [],
): FactionSellRoute[] {
  const { bot } = ctx;
  const routes: FactionSellRoute[] = [];

  // Use personal storage in personal mode, faction storage otherwise
  const storage = personalMode ? bot.storage : bot.factionStorage;
  if (storage.length === 0) return routes;

  let allBuys = mapStore.getAllBuyDemand();
  if (allBuys.length === 0 && extraBuyDemand.length === 0) return routes;
  if (extraBuyDemand.length > 0) {
    allBuys = [...allBuys, ...extraBuyDemand];
  }

  const homeSystem = settings.homeSystem || currentSystem;
  const costPerJump = settings.fuelCostPerJump;

  // Collect items to process: explicit trade items + category-based items
  const itemsToProcess: Array<{ item: typeof storage[0]; source: 'explicit' | 'category' | 'all'; categoryConfig?: CategoryTradeConfig }> = [];
  const processedItemIds = new Set<string>();

  // First, add explicit trade items
  for (const item of storage) {
    if (item.quantity <= 0) continue;

    // Check if in explicit trade items list
    if (settings.tradeItems.length > 0) {
      const itemIdLower = item.itemId.toLowerCase();
      const match = settings.tradeItems.some(t => t.itemId.toLowerCase() === itemIdLower);
      if (match) {
        itemsToProcess.push({ item, source: 'explicit' });
        processedItemIds.add(item.itemId);
        continue;
      }
    }
  }

  // Then, add category-based items (items not already in explicit list)
  if (settings.categoryTrade && settings.categoryTrade.length > 0) {
    for (const catConfig of settings.categoryTrade) {
      for (const item of storage) {
        if (item.quantity <= 0) continue;
        if (processedItemIds.has(item.itemId)) continue;

        const catalogItem = catalogStore.getItem(item.itemId);
        const itemCategory = (catalogItem?.category as string) || '';
        if (itemCategory.toLowerCase() === catConfig.category.toLowerCase()) {
          itemsToProcess.push({ item, source: 'category', categoryConfig: catConfig });
          processedItemIds.add(item.itemId);
        }
      }
    }
  }

  // Finally, if sellAllItems is enabled, add remaining storage items
  if (settings.sellAllItems) {
    for (const item of storage) {
      if (item.quantity <= 0) continue;
      if (processedItemIds.has(item.itemId)) continue;

      itemsToProcess.push({ item, source: 'all' });
      processedItemIds.add(item.itemId);
    }
  }

  // Sort items by potential profit (highest first) to prioritize valuable items
  // This ensures we process high-value items first, even before category items
  itemsToProcess.sort((a, b) => {
    const bestBuyA = findBestBuyForItem(a.item.itemId);
    const bestBuyB = findBestBuyForItem(b.item.itemId);
    const priceA = bestBuyA?.price || 0;
    const priceB = bestBuyB?.price || 0;
    return priceB - priceA;
  });
  
  ctx.log("trade", `Processing ${itemsToProcess.length} items (global min: ${settings.minSellPrice})`);

  // Now process all collected items
  for (const { item, source, categoryConfig } of itemsToProcess) {
    // Get per-item settings (case-insensitive match)
    const itemIdLower = item.itemId.toLowerCase();
    const itemConfig = settings.tradeItems.find(t => t.itemId.toLowerCase() === itemIdLower);
    
    let itemMinSellPrice: number;
    let itemMaxSellQty: number;
    let itemSoldQty: number;
    
    if (source === 'explicit' && itemConfig) {
      // Explicit item settings take precedence
      itemMinSellPrice = (itemConfig.minSellPrice > 0) ? itemConfig.minSellPrice : settings.minSellPrice;
      itemMaxSellQty = itemConfig.maxSellQty || 0;
      itemSoldQty = itemConfig.soldQty || 0;
    } else if (source === 'category' && categoryConfig) {
      // Category-based: calculate quantity and price from category config
      const sellPercent = categoryConfig.sellPercentOfAvailable;
      itemMaxSellQty = Math.floor(item.quantity * (sellPercent / 100));
      itemSoldQty = 0; // Category items don't track sold quantity
      
      // Calculate min sell price from best buy price
      itemMinSellPrice = calculateCategoryMinSellPrice(item.itemId, categoryConfig.pricePercentOfBestBuy);
    } else {
      // 'all' source - use global minSellPrice
      itemMinSellPrice = settings.minSellPrice;
      itemMaxSellQty = 0; // 0 = sell all
      itemSoldQty = 0;
    }
    
    const remainingSellQty = itemMaxSellQty > 0 ? Math.max(0, itemMaxSellQty - itemSoldQty) : item.quantity;

    // Skip if we've already sold the max quantity
    if (itemMaxSellQty > 0 && remainingSellQty <= 0) continue;

    // Find best buyer for this item
    const buyers = allBuys
      .filter(b => b.itemId === item.itemId && b.price > 0)
      .sort((a, b) => b.price - a.price);

    if (buyers.length === 0) {
      ctx.log("trade", `No buyers for ${item.name} - skipping`);
      continue;
    }

    // Material cost = 0 for faction items (we already own them)
    const materialCost = 0;

    for (const buy of buyers) {
      if (itemMinSellPrice > 0 && buy.price < itemMinSellPrice) {
        continue;
      }

      // Verify destination is still valid
      if (!isValidDestination(ctx, buy.systemId, buy.poiId)) {
        continue;
      }

      // Book depth another bot has already committed to consume at this station.
      // Planning against the raw demand is what let two bots size the same 8-unit
      // fuel-cell book: the first swept every good level, the second's market
      // order fell straight through to a junk bid.
      const reserved = getReservedQuantity(item.itemId, buy.poiId, bot.username);
      const availableDepth = Math.max(0, buy.quantity - reserved);
      if (availableDepth <= 0) continue;

      // Round-trip fuel: current → dest + dest → home
      const toDest = estimateFuelCost(currentSystem, buy.systemId, costPerJump);
      const returnHome = estimateFuelCost(buy.systemId, homeSystem, costPerJump);
      if (toDest.jumps >= 999) continue;
      const roundTripJumps = toDest.jumps + (returnHome.jumps < 999 ? returnHome.jumps : 0);
      const roundTripFuel = toDest.cost + (returnHome.jumps < 999 ? returnHome.cost : 0);

      // Calculate quantity to sell, respecting max sell qty and the depth other
      // bots have not already claimed.
      const maxQty = itemMaxSellQty > 0 ? Math.min(remainingSellQty, item.quantity) : item.quantity;
      const qty = Math.min(maxQty, availableDepth, maxItemsForCargo(cargoCapacity, item.itemId));
      if (qty <= 0) continue;

      // Skip routes that sell below material cost + round-trip fuel (would lose money)
      const costPerUnit = materialCost + (roundTripJumps > 0 ? roundTripFuel / qty : 0);
      if (materialCost > 0 && buy.price <= costPerUnit) continue;

      const totalProfit = (buy.price - costPerUnit) * qty;

      routes.push({
        itemId: item.itemId,
        itemName: item.name,
        availableQty: item.quantity,
        destSystem: buy.systemId,
        destPoi: buy.poiId,
        destPoiName: buy.poiName,
        sellPrice: buy.price,
        sellQty: qty,
        jumps: toDest.jumps,
        roundTripJumps,
        totalRevenue: qty * buy.price,
        totalProfit,
      });
      break; // best buyer for this item
    }
  }

  // Sort by profit (not raw revenue) to pick the most profitable after fuel
  routes.sort((a, b) => b.totalProfit - a.totalProfit);
  
  return routes;
}

// ── Faction membership detection ─────────────────────────────

/**
 * The server phrases "you have no faction" in several different ways
 * ("You must be in a faction to ...", "not_in_faction", "You are not in a
 * faction", ...). Matching them in one place matters: a missed match silently
 * flips the whole routine into the wrong storage mode for a full cycle.
 */
const NOT_IN_FACTION_RE = /not[\s_]?in[\s_]?(a[\s_])?faction|must be in a faction|not a member of (a |any )?faction/i;

/**
 * Decide whether this cycle trades out of faction storage or personal storage.
 *
 * Faction membership is a property of the PLAYER, not of where the ship happens
 * to be parked, and `get_status` already carries `faction_id` — so being
 * undocked is never evidence of "not in a faction".
 *
 * The previous implementation assumed personal mode whenever the bot was not
 * docked yet, and the post-dock re-check only ever *reassigned* that flag when
 * the storage probe returned an error. A successful probe left the stale
 * assumption untouched, so a bot restarted in open space stayed in "PERSONAL
 * MODE" for the entire cycle — ignoring a full faction storage, finding nothing
 * to sell, and flying home for no reason.
 */
async function detectFactionMode(
  ctx: RoutineContext,
): Promise<{ personalMode: boolean; factionError: string | null; probed: boolean }> {
  const { bot } = ctx;

  // get_status is authoritative and works while undocked. Only re-poll when we
  // have no cached membership so a genuinely factionless bot doesn't spam it.
  if (!bot.faction) await bot.refreshStatus();

  if (bot.docked) {
    // Docked: probe faction storage too. It confirms membership AND surfaces
    // "this station has no faction storage", which the caller handles
    // separately by heading home.
    const factionResp = await bot.exec("storage", { action: "view", target: "faction" });
    if (!factionResp.error) {
      const result = (factionResp.result ?? {}) as Record<string, unknown>;
      const factionId = result.faction_id as string | undefined;
      if (factionId && !bot.faction) bot.faction = factionId;
      return { personalMode: false, factionError: null, probed: true };
    }
    const message = factionResp.error.message || "";
    if (factionResp.error.code === "not_in_faction" || NOT_IN_FACTION_RE.test(message)) {
      return { personalMode: true, factionError: message, probed: true };
    }
    // Any other failure (no faction storage at this station, rate limit,
    // transport hiccup) says nothing about membership — keep what get_status
    // told us rather than silently downgrading to personal storage.
    return { personalMode: !bot.faction, factionError: message, probed: true };
  }

  // Undocked: no storage probe is possible, so get_status is all we have and
  // the caller must re-check once it has docked.
  return { personalMode: !bot.faction, factionError: null, probed: false };
}

// ── Main routine ─────────────────────────────────────────────

export const factionTraderRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  await bot.refreshStatus();
  const startSystem = bot.system;

  // ── Cloaking setup (one-time at routine start) ──
  // Only cloak now if already undocked. If docked, the bot must stay docked for
  // the docked-only phases; navigateToSystem() will cloak it before travel.
  const startSettings = getFactionTraderSettings(bot.username);
  if (startSettings.autoCloak && !bot.docked) {
    await enableCloakingIfPossible(ctx);
  }

  // Persistent battle state across cycles
  const battleState: BattleState = {
    inBattle: false,
    battleId: null,
    battleStartTick: null,
    lastHitTick: null,
    isFleeing: false,
    lastFleeTime: undefined,
  };

  while (bot.state === "running") {
    // ── Death recovery ──
    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) { await ctx.sleep(30000); continue; }

    // ── Battle check ──
    if (await checkAndFleeFromBattle(ctx, "faction_trader")) {
      await ctx.sleep(5000);
      continue;
    }

    // Periodic battle status check (backup detection in case notifications fail)
    // Check every cycle for fast detection
    if (bot.isInBattle()) {
      const now = Date.now();
      const timeSinceLastFlee = battleState.lastFleeTime ? now - battleState.lastFleeTime : Infinity;
      if (timeSinceLastFlee > 10000) { // Only issue if more than 10 seconds since last flee
        ctx.log("combat", `PERIODIC CHECK: IN BATTLE! - initiating IMMEDIATE flee!`);
        battleState.inBattle = true;
        battleState.isFleeing = false;

        await bot.exec("battle", { action: "stance", stance: "flee" });
        battleState.lastFleeTime = now;
        ctx.log("combat", "Flee stance issued - will re-issue every cycle until disengaged!");
      }
    }

    // If we're in battle, re-issue flee command to ensure we stay in flee stance
    if (battleState.inBattle) {
      const now = Date.now();
      const timeSinceLastFlee = battleState.lastFleeTime ? now - battleState.lastFleeTime : Infinity;
      if (timeSinceLastFlee > 10000) { // Only issue if more than 10 seconds since last flee
        ctx.log("combat", "Re-issuing flee stance (ensuring we stay in flee mode)...");
        const fleeResp = await bot.exec("battle", { action: "stance", stance: "flee" });
        if (fleeResp.error) {
          ctx.log("error", `Flee re-issue failed: ${fleeResp.error.message}`);
        } else {
          battleState.lastFleeTime = now;
        }
      }
      // Check if we've successfully disengaged
      const currentBattleStatus = await getBattleStatus(ctx);
      if (!currentBattleStatus || !currentBattleStatus.is_participant) {
        ctx.log("combat", "Battle cleared - no longer in combat!");
        battleState.inBattle = false;
        battleState.battleId = null;
        battleState.isFleeing = false;
        battleState.lastFleeTime = undefined;
        await ctx.sleep(2000); // Brief pause before next check
        continue;
      }
      // Still in battle - continue to next cycle
      await ctx.sleep(2000); // Brief pause before next check
      continue;
    }

    // ── Buy order lock cleanup (periodic stale lock cleanup) ──
    const cleanedLocks = cleanupStaleFactionLocks();
    if (cleanedLocks > 0) {
      ctx.log("trade", `Faction coordination: cleaned up ${cleanedLocks} stale buy order lock(s)`);
    }

    // ── Detect faction membership early ──
    // Membership comes from get_status (works undocked); when docked we also
    // probe faction storage so `factionError` can distinguish "not in a
    // faction" from "this station holds no faction storage".
    const initialMode = await detectFactionMode(ctx);
    let personalMode = initialMode.personalMode;
    let factionError: string | null = initialMode.factionError;
    /** True once the docked faction-storage probe has run for this station. */
    let factionModeProbed = initialMode.probed;

    // ── Trade session recovery ──
    const activeSession = getActiveSession(bot.username);
    let recoveredSession: TradeSession | null = null;
    // Recover sessions that are either faction routes OR cargo routes (interrupted trades)
    // Also recover any session that has a valid state (even if flags aren't set correctly)
    if (activeSession) {
      const settings = getFactionTraderSettings(bot.username);
      recoveredSession = await recoverFactionTradeSession(ctx, activeSession, settings);
      if (recoveredSession) {
        ctx.log("trade", `Resuming trade session: ${recoveredSession.itemName} (${recoveredSession.state})`);
      }
    }

    const settings = getFactionTraderSettings(bot.username);

    // ── Cloak status check (every cycle when autoCloak enabled) ──
    // A customs patrol or combat can force the cloak down while bot.isCloaked is
    // still cached as true, so actually re-read the ship state before trusting
    // the cache. Re-enable when needed — but ONLY while undocked, because
    // cloaking undocks the ship and re-enabling while docked would break the
    // docked-only operations below (storage, market, etc.) via a stale docked
    // flag. navigateToSystem() also re-cloaks before each jump, so while docked
    // we intentionally leave the cloak alone.
    if (settings.autoCloak && !bot.docked && bot.fuel > 0) {
      await bot.refreshStatus();
      if (!bot.isCloaked) {
        ctx.log("trade", "Cloak status check: bot undocked and not cloaked — re-enabling cloak");
        await enableCloakingIfPossible(ctx);
      }
    }

    // ── Afterburner boost ──
    // `abBooster` is created once the trip is planned (see below) and burns one
    // afterburner_fuel before each jump, doubling ship speed. Every
    // navigateToSystem() call in this routine goes through `safetyOpts`, so the
    // hook below covers the outbound leg, the return leg and every recovery path.
    let abBooster: AfterburnerBooster | null = null;

    const safetyOpts = {
      fuelThresholdPct: settings.refuelThreshold,
      hullThresholdPct: settings.repairThreshold,
      autoCloak: settings.autoCloak,
      ignorePiratesWhenCloaked: settings.ignorePiratesWhenCloaked,
      ignoreBlacklistWhenCloaked: settings.autoCloak,
      onBeforeJump: async (nextSystem: string, jumpNumber: number) => {
        // Keep the cloak up across every jump: a force-drop mid-route must not
        // leave the ship exposed. enableCloakingIfPossible() is a no-op when
        // already cloaked, so this is safe to call before each jump.
        if (settings.autoCloak && !bot.isCloaked && !bot.docked) {
          await enableCloakingIfPossible(ctx);
        }
      },
      // Fire the afterburner fuel WITHOUT awaiting, then navigateToSystem
      // issues `jump` immediately after — both queue in the same server tick so
      // the +100% speed buff is active when the jump resolves. Awaiting here
      // would push the buff a tick ahead of the jump and it would lapse before
      // the jump acts (unboosted transit).
      onPreJump: (nextSystem: string, jumpNumber: number) => {
        if (abBooster) abBooster.fireUseItem(nextSystem, jumpNumber);
      },
    };
    let recoveredSessionHandled = false;
    let route: FactionSellRoute | null = null;
    let withdrawQty = 0;
    /** Cargo is already loaded with sellable goods — sell that before planning anything new. */
    let pendingCargoRecovery = false;

    // ── Always prioritize pending cargo or active session on restart ──
    // This prevents using stale cached storage data when we're not at home.
    await bot.refreshCargo();
    // Only real trade goods count as "a hold that still needs selling". Fuel
    // cells and afterburner fuel are the ship's own supplies: counting them
    // here forced every cycle into cargo recovery, which meant the bot never
    // planned a storage trade again and kept looking for buyers for its fuel.
    const pendingCargo = bot.inventory.filter(i => {
      return i.quantity > 0 && isTradeCargoItem(i.itemId, settings);
    });
    if (pendingCargo.length > 0 && !recoveredSession) {
      ctx.log("trade", `Found ${pendingCargo.length} trade item(s) in cargo on startup — treating as recovery`);
      clearFactionStorageCache();
      bot.factionStorage = [];
      recoveredSessionHandled = false;
      // Emptying bot.factionStorage used to be the only thing stopping the
      // storage planner from starting a brand new trade on top of a full hold.
      // That "worked" only while the bot was wrongly stuck in personal mode;
      // with faction mode correctly detected away from home, the planner would
      // happily pick a route out of the home hub's storage and then fail to
      // withdraw anything at the station we're actually docked at. Selling what
      // we're already carrying comes first — always.
      pendingCargoRecovery = true;
    }

    // ── Handle recovered session ──
    // If we have a recovered session that's in transit, at destination, selling, OR in buying state with cargo already loaded
    if (recoveredSession && (recoveredSession.state === "in_transit" || recoveredSession.state === "at_destination" || recoveredSession.state === "selling")) {
      ctx.log("trade", `Recovered session is ${recoveredSession.state} — proceeding directly to destination`);

      // Verify the destination is still valid
      if (!isValidDestination(ctx, recoveredSession.destSystem, recoveredSession.destPoi)) {
        ctx.log("error", `Cannot recover session: destination ${recoveredSession.destPoiName} is invalid`);
        await failFactionSession(bot.username, "Invalid destination in recovered session");
        recoveredSession = null;
      } else {
        // Quick fuel check only if we're at a station
        if (bot.docked) {
          await tryRefuel(ctx);
        }

        // Set up route for immediate execution
        route = {
          itemId: recoveredSession!.itemId,
          itemName: recoveredSession!.itemName,
          availableQty: recoveredSession!.quantityBought,
          destSystem: recoveredSession!.destSystem,
          destPoi: recoveredSession!.destPoi,
          destPoiName: recoveredSession!.destPoiName,
          sellPrice: recoveredSession!.sellPricePerUnit,
          sellQty: recoveredSession!.sellQuantity,
          jumps: recoveredSession!.totalJumps - recoveredSession!.jumpsCompleted,
          roundTripJumps: recoveredSession!.totalJumps,
          totalRevenue: recoveredSession!.expectedRevenue,
          totalProfit: recoveredSession!.expectedProfit,
          returningToSource: !!recoveredSession!.returnToSource,
        };
      withdrawQty = recoveredSession.quantityBought;
      recoveredSessionHandled = true;

      // Afterburner: resuming away from home, so we can only use whatever
      // afterburner fuel is still in cargo from the interrupted run.
      const recoveryAbPlan = await planTripAfterburner(ctx, settings, route.roundTripJumps);
      abBooster = await boosterFromCargo(ctx, recoveryAbPlan);

      // Skip dock/maintenance and go straight to travel
      await ensureUndocked(ctx);
      const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
      if (!fueled) {
        ctx.log("error", "Cannot refuel for recovered session — will retry next cycle");
        await ctx.sleep(30000);
        continue;
      }

      // Jump directly to destination
      ctx.log("travel", `Resuming route to ${recoveredSession!.destPoiName}...`);
      const arrived = await navigateToSystem(ctx, recoveredSession!.destSystem, {
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
        ctx.log("error", "Failed to reach destination for recovered session — will retry");
        await ensureDocked(ctx);
        await ctx.sleep(60000);
        continue;
      }

      // Arrived at destination - update session state and continue to sell phase
      await updateTradeSession(bot.username, { state: "at_destination" });
      bot.system = recoveredSession!.destSystem;

      // Travel to destination POI and dock
      if (bot.poi !== recoveredSession!.destPoi) {
        ctx.log("travel", `Traveling to ${recoveredSession!.destPoiName}...`);
        const travelResp = await bot.exec("travel", { target_poi: recoveredSession!.destPoi });

        // Check for battle after travel
        if (await checkBattleAfterCommand(ctx, travelResp.notifications, "travel")) {
          ctx.log("combat", "Battle detected during travel - fleeing!");
          await ctx.sleep(5000);
          continue;
        }

        // CRITICAL: Check for battle interrupt error
        if (travelResp.error) {
          const errMsg = travelResp.error.message.toLowerCase();
          if (travelResp.error.code === "battle_interrupt" || errMsg.includes("interrupted by battle") || errMsg.includes("interrupted by combat")) {
            ctx.log("combat", `Travel to destination interrupted by battle! ${travelResp.error.message} - fleeing!`);
            await ctx.sleep(5000);
            continue;
          }
        }

        bot.poi = recoveredSession!.destPoi;

        // Check for pirates at destination
        const nearbyResp = await bot.exec("get_nearby");
        if (nearbyResp.result && typeof nearbyResp.result === "object") {
          const { checkAndFleeFromPirates } = await import("./common.js");
          const fled = await checkAndFleeFromPirates(ctx, nearbyResp.result);
          if (fled) {
            ctx.log("error", "Pirates detected at destination - fled, will retry");
            await ctx.sleep(30000);
            continue;
          }
        }
      }

      await ensureDocked(ctx);
      ctx.log("trade", "Arrived at destination — proceeding to sell trade items");

      // Mark as handled and skip remaining setup phases
      recoveredSessionHandled = true;
      // route, withdrawQty already set - will proceed to sell phase
    }

    // ── Handle recovered session in "buying" state with cargo already loaded ──
    // This happens when the session was created but the bot was interrupted before traveling
    if (!recoveredSessionHandled && recoveredSession && recoveredSession.state === "buying") {
      // Verify the destination is still valid
      if (!isValidDestination(ctx, recoveredSession.destSystem, recoveredSession.destPoi)) {
        ctx.log("error", `Cannot recover session: destination ${recoveredSession.destPoiName} is invalid`);
        await failFactionSession(bot.username, "Invalid destination in recovered session");
        recoveredSession = null;
      } else {
        // Check if cargo is already loaded (from previous interrupted attempt)
        await bot.refreshCargo();
        const cargoItem = bot.inventory.find(i => i.itemId === recoveredSession!.itemId);
        const cargoQty = cargoItem?.quantity ?? 0;

          if (cargoQty > 0) {
            ctx.log("trade", `Recovered session in "buying" state with cargo already loaded: ${cargoQty}x ${recoveredSession!.itemName}`);

            // Set up route from session
            route = {
              itemId: recoveredSession!.itemId,
              itemName: recoveredSession!.itemName,
              availableQty: cargoQty,
              destSystem: recoveredSession!.destSystem,
              destPoi: recoveredSession!.destPoi,
              destPoiName: recoveredSession!.destPoiName,
              sellPrice: recoveredSession!.sellPricePerUnit,
              sellQty: recoveredSession!.sellQuantity,
            jumps: recoveredSession!.totalJumps,
            roundTripJumps: recoveredSession!.totalJumps,
            totalRevenue: recoveredSession!.expectedRevenue,
            totalProfit: recoveredSession!.expectedProfit,
            returningToSource: !!recoveredSession!.returnToSource,
          };
            withdrawQty = cargoQty;
            recoveredSessionHandled = true;

            // Afterburner: reuse whatever afterburner fuel survived the interruption.
            const buyingAbPlan = await planTripAfterburner(ctx, settings, route.roundTripJumps);
            abBooster = await boosterFromCargo(ctx, buyingAbPlan);

            // Skip dock/maintenance and go straight to travel
            await ensureUndocked(ctx);
            const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
            if (!fueled) {
              ctx.log("error", "Cannot refuel for recovered session — will retry next cycle");
              await ctx.sleep(30000);
              continue;
            }

            // Jump directly to destination
            ctx.log("travel", `Resuming route to ${recoveredSession!.destPoiName}...`);
            const arrived = await navigateToSystem(ctx, recoveredSession!.destSystem, {
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
              ctx.log("error", "Failed to reach destination for recovered session — will retry");
              await ensureDocked(ctx);
              await ctx.sleep(60000);
              continue;
            }

            // Arrived at destination - update session state and continue to sell phase
            await updateTradeSession(bot.username, { state: "at_destination" });
            bot.system = recoveredSession!.destSystem;

            // Travel to destination POI and dock
            if (bot.poi !== recoveredSession!.destPoi) {
              ctx.log("travel", `Traveling to ${recoveredSession!.destPoiName}...`);
              const travelResp = await bot.exec("travel", { target_poi: recoveredSession!.destPoi });

              // Check for battle after travel
              if (await checkBattleAfterCommand(ctx, travelResp.notifications, "travel")) {
                ctx.log("combat", "Battle detected during travel - fleeing!");
                await ctx.sleep(5000);
                continue;
              }

              // CRITICAL: Check for battle interrupt error
              if (travelResp.error) {
                const errMsg = travelResp.error.message.toLowerCase();
                if (travelResp.error.code === "battle_interrupt" || errMsg.includes("interrupted by battle") || errMsg.includes("interrupted by combat")) {
                  ctx.log("combat", `Travel to destination interrupted by battle! ${travelResp.error.message} - fleeing!`);
                  await ctx.sleep(5000);
                  continue;
                }
              }

              bot.poi = recoveredSession!.destPoi;
            }

            await ensureDocked(ctx);
            ctx.log("trade", "Arrived at destination — proceeding to sell trade items");
            // route, withdrawQty already set - will proceed to sell phase
          }
        }
      }
  }

    // ── Dock (also records market data + analyzes market) ──
    if (!recoveredSessionHandled) {
      yield "dock";
      await ensureDocked(ctx);

      // Re-check faction membership now that we're docked: only here can the
      // probe also report whether THIS station holds faction storage. Skipped
      // when the cycle already started docked (same station, same answer).
      // Both values are always reassigned — the old code only updated them when
      // the probe failed, so a successful probe left a stale personal-mode
      // assumption in place for the rest of the cycle.
      if (bot.docked && !factionModeProbed) {
        const recheck = await detectFactionMode(ctx);
        if (recheck.personalMode !== personalMode) {
          ctx.log("trade", recheck.personalMode
            ? `PERSONAL MODE: Bot is not in a faction, using personal storage`
            : `FACTION MODE: faction membership confirmed after docking, using faction storage`);
        }
        personalMode = recheck.personalMode;
        factionError = recheck.factionError;
        factionModeProbed = recheck.probed;
      }

      // ── Maintenance ──
      yield "maintenance";
      await tryRefuel(ctx);
      await repairShip(ctx);
    } // End if (!recoveredSessionHandled)

    // ── Ensure we are at the faction home base before trading ──
    // Faction storage is per-station: reading the home base's storage remotely
    // (via refreshFactionStorage) is fine for planning, but items can ONLY be
    // withdrawn from the home base station itself. If we are not physically at
    // the home base — and we are not resuming an in-progress session or selling
    // items already in cargo — return home first instead of trying to withdraw
    // items that don't exist at this station (which would loop forever failing).
    if (!recoveredSessionHandled && pendingCargo.length === 0) {
      const homeStationRaw = settings.homeStation || "";
      const homeStationPoi = getHomeStationPoi(homeStationRaw) || null;
      const homeSystem = settings.homeSystem ||
        (homeStationRaw.includes("|") ? homeStationRaw.split("|")[0] : startSystem);
      const atHomeBase = (!homeSystem || bot.system === homeSystem) &&
        (!homeStationPoi || bot.poi === homeStationPoi);

      if (!atHomeBase) {
        ctx.log("travel", `Not at faction home base (currently at ${bot.system}${bot.poi ? "/" + bot.poi : ""}) — returning home to trade`);
        yield "return_home";
        if (homeSystem && bot.system !== homeSystem) {
          await ensureUndocked(ctx);
          const homeFueled = await ensureFueled(ctx, settings.refuelThreshold);
          if (homeFueled) {
            await navigateToSystem(ctx, homeSystem, {
              fuelThresholdPct: settings.refuelThreshold,
              hullThresholdPct: settings.repairThreshold,
            });
          }
        }
        if (homeStationPoi && bot.poi !== homeStationPoi) {
          await ensureUndocked(ctx);
          const tResp = await bot.exec("travel", { target_poi: homeStationPoi });

          if (await checkBattleAfterCommand(ctx, tResp.notifications, "travel")) {
            ctx.log("combat", "Battle detected during travel home - fleeing!");
            await ctx.sleep(5000);
            continue;
          }
          if (tResp.error) {
            const errMsg = tResp.error.message.toLowerCase();
            if (tResp.error.code === "battle_interrupt" || errMsg.includes("interrupted by battle") || errMsg.includes("interrupted by combat")) {
              ctx.log("combat", `Travel home interrupted by battle! ${tResp.error.message} - fleeing!`);
              await ctx.sleep(5000);
              continue;
            }
          }
          if (!tResp.error || tResp.error.message.includes("already")) {
            bot.poi = homeStationPoi;
          }
        }
        await ctx.sleep(2000);
        continue;
      }
    }

    // ── Find sell routes from faction storage ──
    yield "find_sales";

    // Ensure docked before refreshing storage
    if (!bot.docked) {
      ctx.log("warn", "Not docked for find_sales phase — attempting to dock...");
      await ensureDocked(ctx);
    }

    // Last chance to settle the storage mode before we act on it. Recovery
    // paths skip the dock phase entirely, so a cycle that began undocked can
    // reach this point with nothing but the get_status guess — and picking the
    // wrong storage here is what sends a faction bot home empty-handed.
    if (bot.docked && !factionModeProbed) {
      const recheck = await detectFactionMode(ctx);
      if (recheck.personalMode !== personalMode) {
        ctx.log("trade", recheck.personalMode
          ? `PERSONAL MODE: Bot is not in a faction, using personal storage`
          : `FACTION MODE: faction membership confirmed after docking, using faction storage`);
      }
      personalMode = recheck.personalMode;
      factionError = recheck.factionError;
      factionModeProbed = recheck.probed;
    }

    // Refresh storage based on mode
    if (pendingCargoRecovery) {
      // Nothing to plan out of storage: the hold is already loaded and the only
      // job this cycle is finding it a buyer. Skipping the read also skips the
      // "no faction storage at this station — head home" detour below, which
      // must never outrank selling cargo we are already carrying.
      ctx.log("trade", `${personalMode ? "PERSONAL" : "FACTION"} MODE: cargo recovery — selling the loaded hold before touching storage`);
    } else if (personalMode) {
      await bot.refreshStorage();
      ctx.log("trade", `PERSONAL MODE: Bot is not in a faction, using personal storage`);
    } else {
      await bot.refreshFactionStorage();
      // Show helpful message if faction storage is empty at this station
      if (factionError && (factionError.includes("no_faction_storage") || factionError.includes("no storage"))) {
        ctx.log("trade", `FACTION MODE: Bot is in a faction, but no faction storage at this station — returning home`);
        clearFactionStorageCache();
        bot.factionStorage = [];
        const homeSystem = settings.homeSystem || startSystem;
        const homeStationPoi = getHomeStationPoi(settings.homeStation) || null;
        if (homeSystem && (bot.system !== homeSystem || (homeStationPoi && bot.poi !== homeStationPoi))) {
          ctx.log("travel", `Heading home to access faction storage...`);
          yield "return_home";
          if (bot.system !== homeSystem) {
            await ensureUndocked(ctx);
            const homeFueled = await ensureFueled(ctx, settings.refuelThreshold);
            if (homeFueled) {
              await navigateToSystem(ctx, homeSystem, {
                fuelThresholdPct: settings.refuelThreshold,
                hullThresholdPct: settings.repairThreshold,
                autoCloak: settings.autoCloak,
                ignorePiratesWhenCloaked: settings.ignorePiratesWhenCloaked,
                ignoreBlacklistWhenCloaked: settings.autoCloak,
              });
            }
          }
          if (homeStationPoi && bot.poi !== homeStationPoi) {
            await ensureUndocked(ctx);
            const tResp = await bot.exec("travel", { target_poi: homeStationPoi });
            if (!tResp.error || tResp.error.message.includes("already")) {
              bot.poi = homeStationPoi;
            }
          }
          await ctx.sleep(5000);
          continue;
        }
      } else {
        ctx.log("trade", `FACTION MODE: Bot is in a faction, using faction storage`);
      }
    }
    
    await bot.refreshStatus();
    const cargoCapacity = bot.cargoMax > 0 ? bot.cargoMax : 50;

    // Market query: augment local buy demand with fresh prices from another
    // connected client, or — when the market routines run in this same client
    // (or no remote client is reachable) — straight from the local
    // data/marketDetails.json. Each buy order found becomes an extra buyer.
    let remoteBuyDemand: Array<{ itemId: string; itemName: string; systemId: string; poiId: string; poiName: string; price: number; quantity: number }> = [];
    if (settings.useRemoteMarketQuery !== false) {
      const storageItems = (personalMode ? bot.storage : bot.factionStorage).map(i => i.itemId);
      // When recovering a loaded hold the storage list is irrelevant — the
      // items that need a buyer are the ones already in cargo. map.json can be
      // minutes behind the real market (and is still syncing right after a
      // restart), which is exactly how a full hold ends up "no buyers found".
      const cargoItems = pendingCargoRecovery ? pendingCargo.map(i => i.itemId) : [];
      const uniqueItems = Array.from(new Set([...cargoItems, ...storageItems])).slice(0, 20);
      const marketSource = await resolveMarketSource();
      if (uniqueItems.length > 0 && marketSource.mode === "none") {
        ctx.log("trade", `[Market] Faction trader: no market data source — ${marketSource.reason}`);
      } else if (uniqueItems.length > 0) {
        const results = await Promise.all(uniqueItems.map(async (itemId) => {
          try {
            const res = await queryRemoteMarket({ itemId, tradeType: "sell", requesterSystemId: bot.system });
            if (!res.ok || res.results.length === 0) return null;
            const r = res.results[0];
            return {
              itemId,
              itemName: itemId,
              systemId: r.systemId,
              poiId: r.stationPoiId,
              poiName: r.stationName,
              price: r.price,
              quantity: r.quantity,
            };
          } catch {
            return null;
          }
        }));
        remoteBuyDemand = results.filter(Boolean) as typeof remoteBuyDemand;
        const src = getMarketSourceInfo();
        const origin = src.mode === "local" ? "local market data" : "connected clients";
        if (remoteBuyDemand.length > 0) {
          ctx.log("trade", `[${src.label}] Faction trader: found ${remoteBuyDemand.length} buyer(s) from ${origin}`);
        } else {
          ctx.log("trade", `[${src.label}] Faction trader: no buyers in ${origin} for ${uniqueItems.length} item(s)`);
        }
      }
    }

    // A hold that still contains goods always outranks a new trade: withdrawing
    // more items at a station we only stopped at by accident either overfills
    // the hold or fails outright (faction storage is per-station).
    const foundRoutes = pendingCargoRecovery
      ? []
      : findFactionSellRoutes(ctx, settings, bot.system, cargoCapacity, personalMode, remoteBuyDemand);

    // Station priority: put routes whose destination is the home station first
    // BUT maintain profit ordering within each group
    if (settings.stationPriority && settings.homeSystem) {
      const homeStationId = getHomeStationPoi(settings.homeStation);
      if (homeStationId) {
        const homeRoutes = foundRoutes.filter(r => r.destSystem === settings.homeSystem && r.destPoi === homeStationId);
        const otherRoutes = foundRoutes.filter(r => !(r.destSystem === settings.homeSystem && r.destPoi === homeStationId));
        if (homeRoutes.length > 0) {
          foundRoutes.length = 0;
          foundRoutes.push(...homeRoutes, ...otherRoutes);
          ctx.log("trade", `Station priority: ${homeRoutes.length} route(s) to home station`);
        }
      }
    }

    if (foundRoutes.length === 0) {
      // Check if bot has cargo items that need to be sold (recovery from interrupted session)
      await bot.refreshCargo();
      const nonFuelCargo = bot.inventory.filter(i => {
        return i.quantity > 0 && isTradeCargoItem(i.itemId, settings);
      });
      
      if (nonFuelCargo.length > 0) {
        ctx.log("trade", `Found ${nonFuelCargo.length} item(s) in cargo — finding buyers for recovery`);
        // Find best buyers for cargo items. Include the market-source demand:
        // map.json alone is often stale or incompletely synced right after a
        // restart, and a hold full of goods must not be written off as
        // "unsellable" just because the local map hasn't caught up yet.
        const allBuys = [...mapStore.getAllBuyDemand(), ...remoteBuyDemand];
        const cargoRoutes: FactionSellRoute[] = [];
        const cargoCapacity = bot.cargoMax > 0 ? bot.cargoMax : 50;
        
        for (const item of nonFuelCargo) {
          // Same floor the storage planner used when it withdrew the item, or
          // recovery could refuse to sell what planning was happy to withdraw.
          const itemMinSellPrice = getEffectiveMinSellPrice(item.itemId, settings);

          const knownBuyers = allBuys
            .filter(b => b.itemId === item.itemId && b.price > 0 && b.quantity > 0)
            .sort((a, b) => b.price - a.price);
          const buyers = knownBuyers.filter(b => itemMinSellPrice === 0 || b.price >= itemMinSellPrice);

          if (buyers.length === 0) {
            // Say WHY there is no buyer: "market has nobody buying this" and
            // "the price is too low" are very different problems, and so is
            // "we know of no buy orders at all" (stale/unsynced market data).
            const best = knownBuyers[0];
            const known = best
              ? `best of ${knownBuyers.length} known buy order(s): ${best.price}cr at ${best.poiName} (${best.systemId})`
              : `no buy orders known for this item — market data may be stale or still syncing`;
            if (itemMinSellPrice > 0) {
              ctx.log("trade", `No buyers meet min price (${itemMinSellPrice}cr) for ${item.quantity}x ${item.name} in cargo — ${known}`);
            } else {
              ctx.log("trade", `No buyers found for ${item.quantity}x ${item.name} in cargo — ${known}`);
            }
            continue;
          }

          // Walk the buyers in price order instead of giving up on the item as
          // soon as the single best buyer turns out to be blacklisted/unknown.
          // Capped so a run of rejects can't spam the log with red errors.
          const bestBuyer = buyers.slice(0, 10).find(b => isValidDestination(ctx, b.systemId, b.poiId));
          if (!bestBuyer) {
            ctx.log("trade", `No valid destination among the top ${Math.min(buyers.length, 10)} of ${buyers.length} buyer(s) for ${item.quantity}x ${item.name} in cargo`);
            continue;
          }

          const toDest = estimateFuelCost(bot.system, bestBuyer.systemId, settings.fuelCostPerJump);
          const returnHome = estimateFuelCost(bestBuyer.systemId, settings.homeSystem || bot.system, settings.fuelCostPerJump);
          const roundTripJumps = toDest.jumps + (returnHome.jumps < 999 ? returnHome.jumps : 0);
          const roundTripFuel = toDest.cost + (returnHome.jumps < 999 ? returnHome.cost : 0);
          const qty = Math.min(item.quantity, bestBuyer.quantity, maxItemsForCargo(cargoCapacity, item.itemId));

          const totalRevenue = qty * bestBuyer.price;
          const costPerUnit = roundTripJumps > 0 ? roundTripFuel / qty : 0;
          const totalProfit = totalRevenue - costPerUnit;

          cargoRoutes.push({
            itemId: item.itemId,
            itemName: item.name,
            availableQty: item.quantity,
            destSystem: bestBuyer.systemId,
            destPoi: bestBuyer.poiId,
            destPoiName: bestBuyer.poiName,
            sellPrice: bestBuyer.price,
            sellQty: qty,
            jumps: toDest.jumps,
            roundTripJumps,
            totalRevenue,
            totalProfit,
          });
        }

        if (cargoRoutes.length > 0) {
          cargoRoutes.sort((a, b) => b.totalProfit - a.totalProfit);
          route = cargoRoutes[0];
          ctx.log("trade", `Recovery route: ${route.sellQty}x ${route.itemName} → ${route.destPoiName} (${route.sellPrice}cr/ea)`);
          // Skip to selling this cargo
          recoveredSessionHandled = true; // Skip storage withdrawal
        } else {
          ctx.log("error", `No buyers found for cargo items: ${nonFuelCargo.map(i => `${i.quantity}x ${i.name}`).join(", ")}`);
        }
      }
      
      // If still no route, check storage and potentially return home
      if (!route) {
        // If not at home, go there — storage is only visible at the home station
        const storageType = personalMode ? "personal" : "faction";
      const homeSystem = settings.homeSystem || startSystem;
      const homeStationPoi = getHomeStationPoi(settings.homeStation) || null;
      const atHome = (!homeSystem || bot.system === homeSystem) && (!homeStationPoi || bot.poi === homeStationPoi);
        if (!atHome) {
          ctx.log("trade", pendingCargoRecovery
            ? `No buyer for the cargo we're carrying — returning home to stow it in ${storageType} storage`
            : `No ${storageType} storage items to sell — returning home to check ${storageType} storage`);
          yield "return_home";
          if (homeSystem && bot.system !== homeSystem) {
            await ensureUndocked(ctx);
            const homeFueled = await ensureFueled(ctx, settings.refuelThreshold);
            if (homeFueled) {
              await navigateToSystem(ctx, homeSystem, {
                fuelThresholdPct: settings.refuelThreshold,
                hullThresholdPct: settings.repairThreshold,
                autoCloak: settings.autoCloak,
                ignorePiratesWhenCloaked: settings.ignorePiratesWhenCloaked,
                ignoreBlacklistWhenCloaked: settings.autoCloak,
              });
            }
          }
          if (homeStationPoi && bot.poi !== homeStationPoi) {
            await ensureUndocked(ctx);
            const tResp = await bot.exec("travel", { target_poi: homeStationPoi });

            // Check for battle after travel
            if (await checkBattleAfterCommand(ctx, tResp.notifications, "travel")) {
              ctx.log("combat", "Battle detected during travel home - fleeing!");
              await ctx.sleep(5000);
              continue;
            }

            // CRITICAL: Check for battle interrupt error
            if (tResp.error) {
              const errMsg = tResp.error.message.toLowerCase();
              if (tResp.error.code === "battle_interrupt" || errMsg.includes("interrupted by battle") || errMsg.includes("interrupted by combat")) {
                ctx.log("combat", `Travel home interrupted by battle! ${tResp.error.message} - fleeing!`);
                await ctx.sleep(5000);
                continue;
              }
            }

            if (!tResp.error || tResp.error.message.includes("already")) {
              bot.poi = homeStationPoi;
            }
          }
          continue;
        }

        // ── At home with goods nobody will buy: stow them ──
        // This is the branch that used to be missing. The bot arrived home with
        // a loaded hold, found no buyer, and fell straight through to the idle
        // timer below — so every cycle re-ran "cargo recovery → no buyers →
        // wait 60s" forever while the cargo sat in the hold. Putting the goods
        // back in storage ends the loop and lets the next cycle plan normally.
        if (nonFuelCargo.length > 0) {
          yield "deposit_cargo";
          const docked = await ensureDocked(ctx);
          if (!docked) {
            ctx.log("error", `Cannot dock at home to stow unsellable cargo — retrying in 60s`);
            await ctx.sleep(60000);
            continue;
          }

          let depositedAny = false;
          const failures: string[] = [];
          const unitsBefore = nonFuelCargo.reduce((sum, i) => sum + i.quantity, 0);
          for (const item of nonFuelCargo) {
            const res = await depositCargoItem(ctx, item.itemId, item.quantity, personalMode);
            if (res.ok) {
              depositedAny = true;
              ctx.log("trade", `Stowed ${item.quantity}x ${item.name} in ${res.target ?? storageType} storage — no buyer for it right now`);
            } else {
              failures.push(`${item.quantity}x ${item.name} (${res.error})`);
            }
          }

          if (failures.length > 0) {
            ctx.log("error", `Failed to stow unsellable cargo: ${failures.join("; ")}`);
          }

          // Trust the hold, not the response: a deposit that reports success
          // without moving anything would otherwise put us straight back here
          // on the next cycle, trading one busy-loop for another.
          await bot.refreshCargo();
          const unitsAfter = bot.inventory
            .filter(i => i.quantity > 0 && isTradeCargoItem(i.itemId, settings))
            .reduce((sum, i) => sum + i.quantity, 0);

          if (depositedAny && unitsAfter < unitsBefore) {
            // Storage just changed — drop the cache so the next cycle plans
            // against what is actually in there.
            clearFactionStorageCache();
            bot.factionStorage = [];
            await ctx.sleep(2000);
            continue;
          }

          // Nothing left the hold (no storage at this station, deposit
          // rejected, ...). Wait before retrying so the routine cannot spin.
          ctx.log("error", `Cargo still holds ${unitsAfter} unsellable unit(s) after the deposit attempt — retrying in 60s`);
          await ctx.sleep(60000);
          continue;
        }

        ctx.log("trade", `No ${storageType} storage items to sell — waiting 60s`);
        await ctx.sleep(60000);
        continue;
      }
    }

    // Use existing route if recovered session is being handled, otherwise pick the best found route
    if (!recoveredSessionHandled) {
      ctx.log("trade", `Found ${foundRoutes.length} routes, selecting best available`);

      // Detect the afterburner module once (cached 5 min in afterburner.ts) so
      // we can apply the boosted-trip minimum-fill gate below without spamming
      // get_ship for every candidate route.
      const abModule = await detectAfterburnerModule(ctx);
      const minFillRatio = settings.afterburnerMinFillRatio;

      // Iterate through found routes to find one we can claim that also
      // satisfies the afterburner minimum-fill rule.
      for (const candidateRoute of foundRoutes) {
        // Verify destination is still valid
        if (!isValidDestination(ctx, candidateRoute.destSystem, candidateRoute.destPoi)) {
          ctx.log("error", `Skipping route to invalid destination: ${candidateRoute.destPoiName}`);
          continue;
        }

        const existingLock = getBuyOrderLock(candidateRoute.itemId, candidateRoute.destPoi, bot.username);

        if (existingLock) {
          ctx.log("trade", `Skipping route to ${candidateRoute.destPoiName} — ${candidateRoute.itemName} book claimed by ${existingLock.lockedBy} (${existingLock.quantityCommitted}x committed)`);
          continue;
        }

        // Afterburner fill gate: a boosted trip must actually use the cargo, or
        // the speed boost burns expensive fuel for a loss. When the module is
        // fitted (or forced on) and this route would run boosted, only accept it
        // if the trade goods fill at least `minFillRatio` of the hold — otherwise
        // wait for a fatter deal.
        if (minFillRatio > 0) {
          const plan = planAfterburnerTrip(abModule, {
            mode: settings.afterburnerMode,
            roundTripJumps: candidateRoute.roundTripJumps,
            jumpsPerFuel: settings.afterburnerJumpsPerFuel,
            fuelBuffer: settings.afterburnerFuelBuffer,
            minMilitaryFuelCells: settings.afterburnerMinFuelCells,
            minJumpsToBoost: settings.afterburnerMinJumps,
          });
          if (plan.boost) {
            const fill = cargoCapacity > 0 ? candidateRoute.sellQty / cargoCapacity : 1;
            if (fill < minFillRatio) {
              ctx.log("trade", `Skipping ${candidateRoute.itemName} → ${candidateRoute.destPoiName}: boosted trip fills only ${Math.round(fill * 100)}% of cargo (min ${Math.round(minFillRatio * 100)}%)`);
              continue;
            }
          }
        }

        // Claim the book NOW, before withdrawing cargo. Previously the claim was
        // only taken ~700 lines later, just before departure, so two bots could
        // both pass the check above and both commit to the same buyer. The
        // session id is filled in once the session exists; until then the claim
        // is protected by the sessionless grace window in the coordination store.
        const claimed = acquireBuyOrderLock({
          botUsername: bot.username,
          itemId: candidateRoute.itemId,
          itemName: candidateRoute.itemName,
          destSystem: candidateRoute.destSystem,
          destPoi: candidateRoute.destPoi,
          destPoiName: candidateRoute.destPoiName,
          pricePerUnit: candidateRoute.sellPrice,
          quantityCommitted: candidateRoute.sellQty,
        });
        if (!claimed) {
          ctx.log("trade", `Lost the race for ${candidateRoute.itemName} at ${candidateRoute.destPoiName} — trying the next route`);
          continue;
        }

        route = candidateRoute;
        ctx.log("trade", `Selected route: ${route.itemName} (${Math.round(route.totalProfit)}cr profit) — claimed ${route.sellQty}x of the book at ${route.destPoiName}`);
        break;
      }

      if (!route) {
        ctx.log("trade", "No eligible route this cycle — every boosted candidate fills less than the minimum or buy orders are locked; waiting 60s for a fatter deal");
        await ctx.sleep(60000);
        continue;
      }
    }
    // route is guaranteed to be non-null here: either from recoveredSession or from foundRoutes
    const routeLabel = route!.roundTripJumps > route!.jumps
      ? `${route!.jumps} jumps out, ${route!.roundTripJumps} round-trip`
      : `${route!.jumps} jumps`;
    ctx.log("trade", `Faction sale: ${route!.sellQty}x ${route!.itemName} → ${route!.destPoiName} (${route!.sellPrice}cr/ea, ${routeLabel}, profit ~${Math.round(route!.totalProfit)}cr)`);

    const isInStation = route!.jumps === 0 && route!.destSystem === bot.system;

    if (isInStation) {
      // If this route is a "buyer vanished — return cargo home" run, just put
      // the items back where they came from and clear the session. Never sell
      // them or dump them at a random station.
      if (route!.returningToSource) {
        await ensureDocked(ctx);
        await bot.refreshCargo();
        const retQty = bot.inventory.find(i => i.itemId === route!.itemId)?.quantity ?? 0;
        if (retQty > 0) {
          let dResp;
          if (personalMode) {
            dResp = await bot.exec("storage", { action: 'deposit', target: 'storage', item_id: route!.itemId, quantity: retQty });
          } else {
            dResp = await bot.exec("storage", { action: 'deposit', target: 'faction', item_id: route!.itemId, quantity: retQty });
            if (dResp.error) {
              dResp = await bot.exec("storage", { action: 'deposit', target: 'storage', item_id: route!.itemId, quantity: retQty });
            }
          }
          if (dResp.error) {
            ctx.log("error", `Failed to return ${retQty}x ${route!.itemName} to origin storage: ${dResp.error.message}`);
          } else {
            ctx.log("trade", `Returned ${retQty}x ${route!.itemName} to origin storage (${route!.destPoiName})`);
          }
        } else {
          ctx.log("trade", `No ${route!.itemName} in cargo to return — nothing to deposit`);
        }
        const retSession = getActiveSession(bot.username);
        if (retSession) {
          await abandonTradeSession(bot.username, "Cargo returned to origin (buyer vanished)");
        }
        await ctx.sleep(2000);
        continue;
      }
      // ── In-station: batch withdraw→sell loop ──
      let totalSold = 0;
      let totalRevenue = 0;
      let remaining = route!.availableQty;

      // Check if items are already in cargo (recovery from interrupted session)
      await bot.refreshCargo();
      const existingCargoItem = bot.inventory.find(i => i.itemId === route!.itemId);
      const isCargoRecovery = !!(existingCargoItem && existingCargoItem.quantity > 0);

      while (remaining > 0 && bot.state === "running") {
        await bot.refreshStatus();

        // Check battle status at start of each cycle
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

        // For cargo recovery, sell directly from cargo
        if (isCargoRecovery) {
          await bot.refreshCargo();
          const inCargo = bot.inventory.find(i => i.itemId === route!.itemId);
          if (!inCargo || inCargo.quantity <= 0) {
            ctx.log("error", "Cargo recovery: item no longer in cargo!");
            break;
          }
          // Fire-sale guard: only sell what the market will actually pay at/above
          // a sensible floor. Never dump the whole hold into a junk 1cr order.
          const itemMinSellPrice = getEffectiveMinSellPrice(route!.itemId, settings);
          const mCheck = await calculateFactionOptimalSellQuantity(
            ctx, route!.itemId, route!.itemName, Math.min(inCargo.quantity, remaining), itemMinSellPrice
          );
          if (mCheck.sellQty <= 0) {
            ctx.log("warn", `Cargo recovery: no profitable buy orders for ${route!.itemName} at >= floor (${mCheck.priceBreakdown || "none"}) — depositing back to storage instead of fire-selling`);
            const depQty = Math.min(inCargo.quantity, remaining);
            const dep = await depositCargoItem(ctx, route!.itemId, depQty, personalMode);
            if (!dep.ok) {
              ctx.log("error", `Cargo recovery: failed to deposit unsold ${route!.itemName}: ${dep.error}`);
            } else {
              ctx.log("trade", `Cargo recovery: deposited ${depQty}x unsold ${route!.itemName} back to storage`);
              remaining -= depQty;
            }
            break;
          }
          const sellQty = Math.min(inCargo.quantity, remaining, mCheck.sellQty);
          ctx.log("trade", `Cargo recovery: selling ${sellQty}x ${route!.itemName} (${mCheck.priceBreakdown})...`);
          const sale = await executeFactionSell(ctx, {
            itemId: route!.itemId,
            itemName: route!.itemName,
            quantity: sellQty,
            floor: mCheck.floor,
            bestQuotedPrice: mCheck.buyOrders[0]?.priceEach ?? route!.sellPrice,
            destPoi: route!.destPoi,
            destPoiName: route!.destPoiName,
          });

          if (sale.error) {
            ctx.log("error", `Cargo recovery sell failed: ${sale.error}`);
            break;
          }

          if (sale.listed > 0) {
            ctx.log("trade", `Cargo recovery: listed ${sale.listed}x ${route!.itemName} at a protected price — 0cr realized until it fills`);
            remaining -= sale.listed;
            break;
          }

          if (sale.sold <= 0) {
            ctx.log("error", `Cargo recovery: sell command succeeded but no items were sold (floor ${mCheck.floor}cr)`);
            break;
          }

          totalSold += sale.sold;
          totalRevenue += sale.revenue;
          remaining -= sale.sold;
          ctx.log("trade", `Cargo recovery: sold ${describeFills(sale)} (${totalSold} total, ${remaining} remaining)`);
          if (sale.belowFloor) break; // book was swept — stop feeding it
          continue;
        }

        const freeSpace = getFreeSpace(bot);
        if (freeSpace <= 0) {
          await bot.refreshCargo();
          // First try to sell the trade item we already have
          const inCargo = bot.inventory.find(i => i.itemId === route!.itemId);
          if (inCargo && inCargo.quantity > 0) {
            // Get actual market data before selling
            const itemConfig = settings.tradeItems.find(t => t.itemId === route!.itemId);
            const itemMinSellPrice = (itemConfig && itemConfig.minSellPrice > 0) ? itemConfig.minSellPrice : settings.minSellPrice;

            const marketCheck = await calculateFactionOptimalSellQuantity(
              ctx, route!.itemId, route!.itemName, inCargo.quantity, itemMinSellPrice
            );

            if (marketCheck.sellQty > 0) {
            ctx.log("trade", `Selling ${marketCheck.sellQty}x ${route!.itemName} (${marketCheck.priceBreakdown})...`);
            const sale = await executeFactionSell(ctx, {
              itemId: route!.itemId,
              itemName: route!.itemName,
              quantity: marketCheck.sellQty,
              floor: marketCheck.floor,
              bestQuotedPrice: marketCheck.buyOrders[0]?.priceEach ?? route!.sellPrice,
              destPoi: route!.destPoi,
              destPoiName: route!.destPoiName,
            });

            if (sale.error) {
              ctx.log("error", `Sell from full cargo failed: ${sale.error}`);
            } else if (sale.listed > 0) {
              ctx.log("trade", `Listed ${sale.listed}x ${route!.itemName} from full cargo at a protected price — 0cr realized until it fills`);
            } else if (sale.sold > 0) {
              totalSold += sale.sold;
              totalRevenue += sale.revenue;
              ctx.log("trade", `Sold ${describeFills(sale)} from full cargo`);
            } else {
              ctx.log("warn", `Sell from full cargo moved no ${route!.itemName} and earned nothing`);
            }
            } else {
              if (itemMinSellPrice > 0) {
                ctx.log("trade", `No viable buy orders for ${route!.itemName} — all below minimum price of ${itemMinSellPrice}cr`);
              } else {
                ctx.log("trade", `No viable buy orders for ${route!.itemName} — skipping`);
              }
            }
            continue;
          }
          // Cargo full of other items (including fuel) — dump all to storage
          let freed = false;
          for (const item of [...bot.inventory]) {
            if (item.quantity <= 0) continue;
            let dResp;
            if (personalMode) {
              // Personal storage - use deposit_items command
              //dResp = await bot.exec("deposit_items", { item_id: item.itemId, quantity: item.quantity });
              dResp = await bot.exec("storage", { action: 'deposit', target: 'station', item_id: item.itemId, quantity: item.quantity }); //fixed by human!
            } else {
              // Faction storage
              //dResp = await bot.exec("faction_deposit_items", { item_id: item.itemId, quantity: item.quantity });
              dResp = await bot.exec("storage", { action: 'deposit', target: 'faction', item_id: item.itemId, quantity: item.quantity }); //fixed by human!
              if (dResp.error) {
                //dResp = await bot.exec("deposit_items", { item_id: item.itemId, quantity: item.quantity });
                dResp = await bot.exec("storage", { action: 'deposit', target: 'station', item_id: item.itemId, quantity: item.quantity }); //fixed by human!
              }
            }
            if (!dResp.error) {
              freed = true;
            }
          }
          if (!freed) break;
          continue;
        }

        let wQty = Math.min(remaining, maxItemsForCargo(freeSpace, route!.itemId));
        if (wQty <= 0) break;

        // Withdraw from storage based on mode
        let wResp;
        if (personalMode) {
          // Personal storage - use withdraw_items command
          //wResp = await bot.exec("withdraw_items", { item_id: route!.itemId, quantity: wQty });
          wResp = await bot.exec("storage", { action: 'withdraw', target: 'storage', item_id: route!.itemId, quantity: wQty }); //fixed by human, this should take from storage to cargo.
          // Check for battle notifications after withdraw
          if (wResp.notifications && Array.isArray(wResp.notifications)) {
            const battleDetected = await handleBattleNotifications(ctx, wResp.notifications, battleState);
            if (battleDetected) {
              ctx.log("combat", "Battle detected during withdraw - initiating flee!");
              battleState.isFleeing = false;
            }
          }
        } else {
          // Faction storage
          //wResp = await bot.exec("faction_withdraw_items", { item_id: route!.itemId, quantity: wQty });
          wResp = await bot.exec("storage", { action: 'withdraw', target: 'faction', item_id: route!.itemId, quantity: wQty }); //fixed by human! withdraws to cargo from faction.
          // Check for battle notifications after faction withdraw
          if (wResp.notifications && Array.isArray(wResp.notifications)) {
            const battleDetected = await handleBattleNotifications(ctx, wResp.notifications, battleState);
            if (battleDetected) {
              ctx.log("combat", "Battle detected during faction withdraw - initiating flee!");
              battleState.isFleeing = false;
            }
          }
          if (wResp.error && wResp.error.message.includes("cargo_full")) {
            wQty = Math.max(1, Math.floor(wQty / 2));
            //wResp = await bot.exec("faction_withdraw_items", { item_id: route!.itemId, quantity: wQty });
            wResp = await bot.exec("storage", { action: 'withdraw', target: 'faction', item_id: route!.itemId, quantity: wQty }); //fixed by human! withdraw from faction to cargo.
          }
          // Handle no_faction_storage error — abort current route and return home
           if (wResp.error && wResp.error.message.includes("no_faction_storage")) {
             ctx.log("error", `No faction storage here — aborting route and returning home`);
             clearFactionStorageCache();
             bot.factionStorage = [];
             await ctx.sleep(10000);
             // break out of in-station loop so we hit the final return-home block
             break;
           }
         }
 
         if (wResp.error) {
           if (totalSold > 0) break;
           ctx.log("error", `Withdraw failed: ${wResp.error.message}`);
           break;
         }

        // Verify item was actually withdrawn to cargo
        await bot.refreshCargo();
        const afterWithdraw = bot.inventory.find(i => i.itemId === route!.itemId)?.quantity ?? 0;
        if (afterWithdraw <= 0) {
          ctx.log("error", `Withdraw returned no items - item may not exist in storage`);
          break;
        }

        // remaining adjusted after sell based on actual quantity sold

        // Get actual market data before selling
        const itemConfig = settings.tradeItems.find(t => t.itemId === route!.itemId);
        const itemMinSellPrice = (itemConfig && itemConfig.minSellPrice > 0) ? itemConfig.minSellPrice : settings.minSellPrice;

        // Get initial market check to list eligible buy orders
        const initialMarketCheck = await calculateFactionOptimalSellQuantity(
          ctx, route!.itemId, route!.itemName, wQty, itemMinSellPrice
        );

        if (initialMarketCheck.buyOrders.length === 0) {
          if (itemMinSellPrice > 0) {
            ctx.log("trade", `No viable buy orders for ${route!.itemName} — all below minimum price of ${itemMinSellPrice}cr`);
          } else {
            ctx.log("trade", `No viable buy orders for ${route!.itemName} — skipping`);
          }
          break;
        }

        ctx.log("trade", `Processing ${initialMarketCheck.buyOrders.length} buy orders for ${route!.itemName} (min price: ${itemMinSellPrice}cr)`);

        // Process each buy order individually, highest price first
        for (const buyOrder of initialMarketCheck.buyOrders) {
          const { priceEach, qtyToSell: targetQty } = buyOrder;
          ctx.log("trade", `[DEBUG] Processing buy order: ${targetQty}x @ ${priceEach}cr`);

          let orderTotalSold = 0;
          const maxRetries = 3;

          // Retry loop for this buy order
          for (let retry = 0; retry < maxRetries; retry++) {
            // Refresh market data to confirm buy order still exists
            const marketResp = await bot.exec("view_market", { item_id: route!.itemId });
            if (marketResp.error || !marketResp.result) {
              ctx.log("warn", `[DEBUG] Failed to refresh market for ${route!.itemName} (retry ${retry + 1}/${maxRetries})`);
              await ctx.sleep(1000);
              continue;
            }

            const marketData = marketResp.result as Record<string, unknown>;
            const items = Array.isArray(marketData) ? marketData :
              Array.isArray((marketData as any).items) ? (marketData as any).items : [];
            const itemMarket = items.find((i: any) => i.item_id === route!.itemId);
            if (!itemMarket) {
              ctx.log("warn", `[DEBUG] No market data for ${route!.itemName} (retry ${retry + 1}/${maxRetries})`);
              await ctx.sleep(1000);
              continue;
            }

            const currentBuyOrders = (itemMarket.buy_orders as Array<Record<string, unknown>>) || [];
            // Find matching buy order (same price, still has quantity)
            const matchingOrder = currentBuyOrders.find(o => 
              (o.price_each as number) === priceEach && (o.quantity as number) > 0
            );

            if (!matchingOrder) {
              ctx.log("trade", `[DEBUG] Buy order at ${priceEach}cr no longer available — skipping`);
              break; // Exit retry loop for this order
            }

            const currentOrderQty = (matchingOrder.quantity as number) || 0;
            const currentPrice = (matchingOrder.price_each as number) || 0;

            // Check current cargo
            await bot.refreshCargo();
            const cargoQty = bot.inventory.find(i => i.itemId === route!.itemId)?.quantity ?? 0;
            if (cargoQty <= 0) {
              ctx.log("trade", `No ${route!.itemName} remaining in cargo — stopping`);
              break;
            }

            // Calculate quantity to sell now
            const sellNow = Math.min(targetQty - orderTotalSold, currentOrderQty, cargoQty);
            if (sellNow <= 0) {
              ctx.log("trade", `[DEBUG] Buy order at ${priceEach}cr has no remaining quantity — skipping`);
              break;
            }

            ctx.log("trade", `Attempting to sell ${sellNow}x ${route!.itemName} at ${currentPrice}cr (retry ${retry + 1}/${maxRetries})...`);

            const sale = await executeFactionSell(ctx, {
              itemId: route!.itemId,
              itemName: route!.itemName,
              quantity: sellNow,
              // This loop walks the book one price level at a time, so the level
              // being targeted IS the floor — anything cheaper means the level
              // was taken between the refresh above and our order landing.
              floor: Math.max(initialMarketCheck.floor, currentPrice),
              bestQuotedPrice: currentPrice,
              destPoi: route!.destPoi,
              destPoiName: route!.destPoiName,
            });

            // Check for battle notifications
            if (Array.isArray(sale.notifications) && sale.notifications.length > 0) {
              const battleDetected = await handleBattleNotifications(ctx, sale.notifications, battleState);
              if (battleDetected) {
                ctx.log("combat", "Battle detected during sell - initiating flee!");
                battleState.isFleeing = false;
                await ctx.sleep(5000);
                break;
              }
            }

            if (sale.error) {
              ctx.log("error", `Sell failed: ${sale.error} (retry ${retry + 1}/${maxRetries})`);
              await ctx.sleep(1000);
              continue;
            }

            if (sale.listed > 0) {
              ctx.log("trade", `Listed ${sale.listed}x ${route!.itemName} at a protected price instead of racing the book`);
              break;
            }

            if (sale.sold <= 0) {
              ctx.log("error", `Sell succeeded but no items sold and no revenue earned (retry ${retry + 1}/${maxRetries})`);
              await ctx.sleep(1000);
              continue;
            }

            orderTotalSold += sale.sold;
            totalSold += sale.sold;
            totalRevenue += sale.revenue;
            ctx.log("trade", `Sold ${describeFills(sale)} (order total: ${orderTotalSold}/${targetQty}, overall total: ${totalSold})`);

            if (sale.belowFloor) {
              ctx.log("error", `Stopping further sales of ${route!.itemName} at ${route!.destPoiName} — the book is being swept out from under us`);
              break;
            }

            // If we've sold the target quantity for this order, break
            if (orderTotalSold >= targetQty) {
              break;
            }
            await ctx.sleep(500); // Short delay before next attempt on same order
          }

          if (orderTotalSold === 0) {
            ctx.log("error", `Failed to sell any items for buy order at ${priceEach}cr after ${maxRetries} retries`);
          } else if (orderTotalSold < targetQty) {
            ctx.log("trade", `Partially sold buy order at ${priceEach}cr: ${orderTotalSold}/${targetQty}`);
          }
        }

        // After processing all buy orders, check if we sold anything
        if (totalSold === 0) {
          ctx.log("error", `No items were sold for ${route!.itemName} — failing session`);
          const session = getActiveSession(bot.username);
          if (session) {
            await failFactionSession(bot.username, "No items were actually sold");
          }
          break;
        } else {
          ctx.log("trade", `Finished selling ${route!.itemName}: ${totalSold}x total, ${totalRevenue}cr revenue`);
          remaining -= totalSold;
          // Deposit any unsold cargo back to storage
          await bot.refreshCargo();
          const remainingCargo = bot.inventory.find(i => i.itemId === route!.itemId)?.quantity ?? 0;
          if (remainingCargo > 0) {
            ctx.log("trade", `Depositing ${remainingCargo}x unsold ${route!.itemName} back to storage`);
            let dResp;
            if (personalMode) {
              //dResp = await bot.exec("deposit_items", { item_id: route!.itemId, quantity: remainingCargo });
              dResp = await bot.exec("storage", { action: 'deposit', target: 'storage', item_id: route!.itemId, quantity: remainingCargo }); //fixed by human!
            } else {
              //dResp = await bot.exec("faction_deposit_items", { item_id: route!.itemId, quantity: remainingCargo });
              dResp = await bot.exec("storage", { action: 'deposit', target: 'faction', item_id: route!.itemId, quantity: remainingCargo }); //fixed by human!
            }
            if (dResp.error) {
              ctx.log("error", `Failed to deposit unsold items: ${dResp.error.message}`);
            } else {
              remaining += remainingCargo; // Add back to remaining to sell
            }
          }
          continue;
        }
      }

      if (totalSold > 0) {
        await bot.refreshStatus();
        await recordMarketData(ctx);
        // In-station sales have no travel leg, so realized profit is simply the
        // realized revenue. Never report or donate against the planned figure.
        const realizedProfit = sanitizeCredits(totalRevenue);
        bot.stats.totalTrades++;
        bot.stats.totalProfit = sanitizeCredits(bot.stats.totalProfit + realizedProfit);
        ctx.log("trade", `Faction sale complete: ${totalSold}x ${route!.itemName} — ${totalRevenue}cr revenue realized (planned ${route!.totalRevenue}cr)`);
        await factionDonateProfit(ctx, realizedProfit, settings.creditsToHold);
        await completeTradeSession(bot.username, totalRevenue, realizedProfit);
        releaseSessionLock(bot.username, "completed");
      } else if (route) {
        // No items sold - fail any existing session
        const session = getActiveSession(bot.username);
        if (session) {
          await failFactionSession(bot.username, "No items were actually sold");
        }
      }
    } else {
      // ── Cross-system: withdraw, travel, sell ──
      yield "withdraw_faction";
      await ensureDocked(ctx);

      // Check if items are already in cargo (recovery from interrupted session)
      await bot.refreshCargo();
      const existingCargoItem = bot.inventory.find(i => i.itemId === route!.itemId);
      const isCargoRecovery = !!(existingCargoItem && existingCargoItem.quantity > 0);
      let qty = 0; // Declare at higher scope for session creation

      // ── Afterburner plan for this round trip ──
      // Planned BEFORE the cargo purge so the purge knows how much afterburner
      // fuel and how many military fuel cells to keep aboard.
      const abPlan = await planTripAfterburner(ctx, settings, route!.roundTripJumps);

      // For cargo recovery, skip clearing cargo and withdrawal - items are already in cargo
      if (!isCargoRecovery) {
        // Clear ALL cargo to make room — keep only fuel cells needed for the round trip
        await bot.refreshCargo();
        if (bot.inventory.length > 0) {
          // Boosted jumps burn far more fuel (afterburner_ii is -60% fuel
          // efficiency and fuel cost scales with speed), so a boosted run keeps
          // a much deeper fuel-cell reserve.
          const fuelReserve = abPlan.boost
            ? Math.max(abPlan.militaryFuelCellsNeeded, route!.roundTripJumps + 2)
            : Math.max(3, route!.roundTripJumps + 2); // round trip + buffer
          // afterburner_fuel is a consumable, NOT a fuel cell — it must be
          // reserved separately or it eats into the fuel-cell allowance (its
          // item id contains "fuel", which the generic check below matches).
          const abFuelReserve = abPlan.boost ? abPlan.fuelUnitsNeeded : 0;
          let fuelKept = 0;
          let abFuelKept = 0;
          const deposited: string[] = [];
          for (const item of [...bot.inventory]) {
            if (item.quantity <= 0) continue;
            const lower = item.itemId.toLowerCase();
            const isAbFuel = isAfterburnerFuelItem(item.itemId);
            const isFuel = !isAbFuel && (lower.includes("fuel") || lower.includes("energy_cell"));
            if (isAbFuel) {
              const keep = Math.min(item.quantity, Math.max(0, abFuelReserve - abFuelKept));
              abFuelKept += keep;
              const excess = item.quantity - keep;
              if (excess <= 0) continue;
              let dResp;
              if (personalMode) {
                dResp = await bot.exec("storage", { action: 'deposit', target: 'storage', item_id: item.itemId, quantity: excess });
              } else {
                dResp = await bot.exec("storage", { action: 'deposit', target: 'faction', item_id: item.itemId, quantity: excess });
                if (dResp.error) {
                  dResp = await bot.exec("storage", { action: 'deposit', target: 'storage', item_id: item.itemId, quantity: excess });
                }
              }
              deposited.push(`${excess}x ${item.name}`);
            } else if (isFuel) {
              const keep = Math.min(item.quantity, Math.max(0, fuelReserve - fuelKept));
              fuelKept += keep;
              const excess = item.quantity - keep;
              if (excess <= 0) continue;
              // Deposit to storage based on mode
              let dResp;
              if (personalMode) {
                //dResp = await bot.exec("deposit_items", { item_id: item.itemId, quantity: excess });
                dResp = await bot.exec("storage", { action: 'deposit', target: 'storage', item_id: item.itemId, quantity: excess }); //fixed by human!
              } else {
                //dResp = await bot.exec("faction_deposit_items", { item_id: item.itemId, quantity: excess });
                dResp = await bot.exec("storage", { action: 'deposit', target: 'faction', item_id: item.itemId, quantity: excess }); //fixed by human!
                if (dResp.error) {
                  //dResp = await bot.exec("deposit_items", { item_id: item.itemId, quantity: excess });
                  dResp = await bot.exec("storage", { action: 'deposit', target: 'storage', item_id: item.itemId, quantity: excess }); //fixed by human!
                }
              }
              deposited.push(`${excess}x ${item.name}`);
            } else {
              // Deposit to storage based on mode
              let dResp;
              if (personalMode) {
                //dResp = await bot.exec("deposit_items", { item_id: item.itemId, quantity: item.quantity });
                dResp = await bot.exec("storage", { action: 'deposit', target: 'storage', item_id: item.itemId, quantity: item.quantity }); //fixed by human!
              } else {
                //dResp = await bot.exec("faction_deposit_items", { item_id: item.itemId, quantity: item.quantity });
                dResp = await bot.exec("storage", { action: 'deposit', target: 'faction', item_id: item.itemId, quantity: item.quantity }); //fixed by human!
                if (dResp.error) {
                  //dResp = await bot.exec("deposit_items", { item_id: item.itemId, quantity: item.quantity });
                  dResp = await bot.exec("storage", { action: 'deposit', target: 'storage', item_id: item.itemId, quantity: item.quantity }); //fixed by human!
                }
              }
              deposited.push(`${item.quantity}x ${item.name}`);
            }
          }
          if (deposited.length > 0) {
            const storageType = personalMode ? "personal storage" : "storage";
            const abNote = abFuelKept > 0 ? `, ${abFuelKept} afterburner fuel` : "";
            ctx.log("trade", `Cleared cargo: ${deposited.join(", ")} → ${storageType} (kept ${fuelKept} fuel cells${abNote})`);
          }
        }
        await bot.refreshCargo();
        await bot.refreshStatus();

        // ── Stock afterburner consumables before loading trade goods ──
        // Done first so the boost fuel and the deeper fuel-cell reserve are
        // guaranteed a slot; the trade item then fills whatever remains.
        if (abPlan.boost) {
          const stocked = await stockAfterburnerConsumables(ctx, abPlan, { personalMode });
          if (stocked.afterburnerFuel > 0) {
            abBooster = new AfterburnerBooster(ctx, {
              enabled: true,
              jumpsPerFuel: abPlan.jumpsPerFuel,
              unitsInCargo: stocked.afterburnerFuel,
            });
          }
          await bot.refreshCargo();
          await bot.refreshStatus();
        }

        const freeSpace = getFreeSpace(bot);
        qty = Math.min(route!.sellQty, route!.availableQty, maxItemsForCargo(freeSpace, route!.itemId));
        if (qty <= 0) {
          ctx.log("trade", "No cargo space for withdrawal — skipping");
          await ctx.sleep(30000);
          continue;
        }

        // Withdraw from storage based on mode
        let wResp;
        if (personalMode) {
          // Personal storage - use withdraw_items command
          //wResp = await bot.exec("withdraw_items", { item_id: route!.itemId, quantity: qty });
          wResp = await bot.exec("storage", { action: 'withdraw', target: 'station', item_id: route!.itemId, quantity: qty }); //fixed by human! should withdraw from station to cargo.
        } else {
          // Faction storage
          //wResp = await bot.exec("faction_withdraw_items", { item_id: route!.itemId, quantity: qty });
          wResp = await bot.exec("storage", { action: 'withdraw', target: 'faction', item_id: route!.itemId, quantity: qty }); //fixed by human! should withdraw from faction to storage.
          if (wResp.error && wResp.error.message.includes("cargo_full")) {
            qty = Math.max(1, Math.floor(qty / 2));
            //wResp = await bot.exec("faction_withdraw_items", { item_id: route!.itemId, quantity: qty });
            wResp = await bot.exec("storage", { action: 'withdraw', target: 'faction', item_id: route!.itemId, quantity: qty }); //fixed by human! should withdraw from faction to storage.
          }
          // Handle no_faction_storage error — abort current route and return home
           if (wResp.error && wResp.error.message.includes("no_faction_storage")) {
             ctx.log("error", `No faction storage here — aborting route and returning home`);
             clearFactionStorageCache();
             bot.factionStorage = [];
             await ctx.sleep(10000);
             // continue will let us hit the final return-home block
             continue;
           }
         }
 
         if (wResp.error) {
           ctx.log("error", `Withdraw failed: ${wResp.error.message}`);
           await ctx.sleep(30000);
           continue;
         }

        const storageType = personalMode ? "personal storage" : "faction storage";
        ctx.log("trade", `Withdrew ${qty}x ${route!.itemName} from ${storageType}`);
      } else {
        // Cargo recovery - verify items are in cargo
        await bot.refreshCargo();
        const inCargo = bot.inventory.find(i => i.itemId === route!.itemId);
        if (!inCargo || inCargo.quantity <= 0) {
          ctx.log("error", "Cargo recovery: items not in cargo!");
          await ctx.sleep(30000);
          continue;
        }
        qty = inCargo.quantity;
        ctx.log("trade", `Cargo recovery: ${qty}x ${route!.itemName} in cargo — proceeding to destination`);
        // Cargo recovery may be running from a non-home station where nothing
        // can be withdrawn — boost with whatever afterburner fuel is aboard.
        abBooster = await boosterFromCargo(ctx, abPlan);
      }

      // Create trade session for crash recovery
      const session = createTradeSession({
        botUsername: bot.username,
        route: {
          itemId: route!.itemId,
          itemName: route!.itemName,
          sourceSystem: bot.system,
          sourcePoi: bot.poi,
          sourcePoiName: bot.poi || "Unknown",
          buyPrice: 0, // Faction items have no purchase cost
          buyQty: qty,
          destSystem: route!.destSystem,
          destPoi: route!.destPoi,
          destPoiName: route!.destPoiName,
          sellPrice: route!.sellPrice,
          sellQty: route!.sellQty,
          jumps: route!.jumps,
          profitPerUnit: route!.sellQty > 0 ? route!.totalProfit / route!.sellQty : 0,
          totalProfit: route!.totalProfit,
        },
        isFactionRoute: !personalMode,
        isCargoRoute: isCargoRecovery, // Mark as cargo route for recovery
        investedCredits: 0,
      });
      session.state = isCargoRecovery ? "in_transit" : "buying"; // Cargo recovery is already past buying phase

      // Bind the claim taken at route-selection time to this session, and
      // correct the committed depth to what we actually loaded. Acquiring here
      // (as the old code did) was far too late — the cargo was already aboard,
      // so losing the race meant flying home loaded or dumping into a swept book.
      const bound = updateBuyOrderLock(bot.username, session.itemId, session.destPoi, {
        sessionId: session.sessionId,
        quantityCommitted: qty,
        pricePerUnit: session.sellPricePerUnit,
      });

      if (!bound) {
        // No claim of ours survives — either it was reaped or another bot holds
        // the book now. Re-acquire; only give up if someone else owns it.
        const reclaimed = acquireBuyOrderLock({
          botUsername: bot.username,
          itemId: session.itemId,
          itemName: session.itemName,
          destSystem: session.destSystem,
          destPoi: session.destPoi,
          destPoiName: session.destPoiName,
          pricePerUnit: session.sellPricePerUnit,
          quantityCommitted: qty,
          sessionId: session.sessionId,
        });

        if (!reclaimed) {
          const holder = getBuyOrderLock(session.itemId, session.destPoi, bot.username);
          ctx.log("trade", `Failed to claim the ${session.itemName} book at ${session.destPoiName} (held by ${holder?.lockedBy ?? "another bot"}) — picking next route`);
          await failFactionSession(bot.username, "Buy order locked by another bot");
          continue;
        }
      }

      await startTradeSession(session);
      ctx.log("trade", `Trade session started: ${session.sessionId}`);

      // Travel to destination
      yield "travel_to_dest";
      await ensureUndocked(ctx);
      const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct, { noJettison: true });
      if (!fueled) {
        ctx.log("error", "Cannot refuel — trade paused until fuel is available");

        // CRITICAL: Do NOT fail the session or sell cargo prematurely!
        // The bot may be rescued by a fuel rescue bot, or fuel may become available later.
        // Keep the session active for recovery.

        // Update session state to reflect we're waiting for fuel
        const session = getActiveSession(bot.username);
        if (session) {
          await updateTradeSession(bot.username, {
            state: "in_transit",
            notes: (session.notes || "") + " | Waiting for fuel",
          });
        }

        // Dock and wait - next cycle may have fuel from rescue or scavenging
        await ensureDocked(ctx);
        ctx.log("trade", "Docked and waiting for fuel — trade session preserved");
        ctx.log("trade", `Session will resume when fueled: ${session?.itemId} (${session?.quantityBought}x) → ${session?.destPoiName}`);

        // Wait 60 seconds before next cycle
        await ctx.sleep(60000);
        continue;
      }

      // Update session state to in_transit
      await updateTradeSession(bot.username, { state: "in_transit" });

      if (bot.system !== route!.destSystem) {
        ctx.log("travel", `Heading to ${route!.destPoiName} in ${route!.destSystem}...`);
        const arrived = await navigateToSystem(ctx, route!.destSystem, {
          ...safetyOpts,
          noJettison: true,
          onJump: async (jumpNum) => {
            if (jumpNum % 3 !== 0) return true;
            // When returning cargo to origin there is no buyer to validate —
            // skip the "buyer gone" abort check or it would loop forever.
            if (route!.returningToSource) return true;
            const buys = mapStore.getAllBuyDemand();
            const destBuyer = buys.find(b =>
              b.itemId === route!.itemId && b.systemId === route!.destSystem && b.poiId === route!.destPoi
            );
            if (!destBuyer || destBuyer.quantity <= 0) {
              ctx.log("trade", `Mid-route check (jump ${jumpNum}): buyer gone at ${route!.destPoiName} — aborting`);
              // Flip this run to return-to-origin right now so we head home with
              // the cargo instead of parking at the nearest random (possibly
              // undockable) station. The bot must put it back where it got it.
              const sess = getActiveSession(bot.username);
              if (sess) {
                const originSystem = sess.sourceSystem || settings.homeSystem;
                const originPoi = sess.sourcePoi || getHomeStationPoi(settings.homeStation);
                const originName = sess.sourcePoiName || originPoi || originSystem;
                releaseBuyOrderLock(bot.username, sess.itemId, sess.destPoi, "buyer_gone_returning_to_origin");
                await updateTradeSession(bot.username, {
                  destSystem: originSystem,
                  destPoi: originPoi,
                  destPoiName: originName,
                  returnToSource: true,
                  notes: (sess.notes || "") + ` | Buyer gone mid-route — returning to ${originName}`,
                });
              }
              return false;
            }
            ctx.log("trade", `Mid-route check (jump ${jumpNum}): trade valid (${destBuyer.price}cr × ${destBuyer.quantity} at dest)`);
            return true;
          },
        });
        if (!arrived) {
          ctx.log("error", "Failed to reach destination — will retry on next cycle");

          // If the buyer vanished mid-route we already flipped this session to
          // return-to-origin (see onJump above). In that case go HOME directly —
          // do NOT use ensureDocked's "nearest station" fallback, which would
          // strand the cargo at a random, possibly undockable station.
          const session = getActiveSession(bot.username);
          if (session?.returnToSource) {
            ctx.log("travel", `Buyer gone — returning cargo to origin (${session.sourcePoiName || session.sourceSystem || "home"}) instead of parking at a random station`);
            const homeSystem = settings.homeSystem || startSystem;
            const homeStationPoi = getHomeStationPoi(settings.homeStation) || null;
            if (homeSystem && bot.system !== homeSystem) {
              await ensureUndocked(ctx);
              const homeFueled = await ensureFueled(ctx, settings.refuelThreshold);
              if (homeFueled) {
                await navigateToSystem(ctx, homeSystem, { ...safetyOpts });
              }
            }
            if (homeStationPoi && bot.poi !== homeStationPoi) {
              await ensureUndocked(ctx);
              const tResp = await bot.exec("travel", { target_poi: homeStationPoi });
              if (!tResp.error || tResp.error.message.includes("already")) bot.poi = homeStationPoi;
            }
            await ctx.sleep(5000);
            continue;
          }

          // CRITICAL: Do NOT fail the session or sell cargo prematurely!
          // Network issues, server hiccups, and temporary disconnections are common.
          // The session remains active and will be recovered on the next cycle.
          // The bot will retry the jump with exponential backoff in navigateToSystem().

          // Update session state to reflect we're still in transit
          if (session) {
            await updateTradeSession(bot.username, {
              state: "in_transit",
              notes: (session.notes || "") + " | Network interruption - will retry",
            });
          }

          // Find a station to dock at and wait for network recovery
          await ensureDocked(ctx);
          ctx.log("trade", "Docked and waiting for network recovery — trade session preserved");
          ctx.log("trade", `Session will resume: ${session?.itemId} (${session?.quantityBought}x) → ${session?.destPoiName}`);

          // Wait 60 seconds before next cycle will retry (gives network time to recover)
          await ctx.sleep(60000);
          continue;
        }
      }

      await ensureUndocked(ctx);
      if (bot.poi !== route!.destPoi) {
        const travelResp = await bot.exec("travel", { target_poi: route!.destPoi });
        
        // Check for battle after travel
        if (await checkBattleAfterCommand(ctx, travelResp.notifications, "travel")) {
          ctx.log("combat", "Battle detected during travel to destination - fleeing!");
          await ctx.sleep(5000);
          continue;
        }

        // CRITICAL: Check for battle interrupt error
        if (travelResp.error) {
          const errMsg = travelResp.error.message.toLowerCase();
          if (travelResp.error.code === "battle_interrupt" || errMsg.includes("interrupted by battle") || errMsg.includes("interrupted by combat")) {
            ctx.log("combat", `Travel to destination interrupted by battle! ${travelResp.error.message} - fleeing!`);
            await ctx.sleep(5000);
            continue;
          }
        }
        
        if (!travelResp.error || travelResp.error.message.includes("already")) {
          bot.poi = route!.destPoi;
        }
      }

      // Dock and sell
      yield "sell";
      await ensureDocked(ctx);
      await bot.refreshCargo();
      const inCargo = bot.inventory.find(i => i.itemId === route!.itemId)?.quantity ?? 0;
      if (route!.returningToSource) {
        // Buyer vanished before we could sell — put the cargo back where we got
        // it instead of dumping it at a random station.
        if (inCargo > 0) {
          let dResp;
          if (personalMode) {
            dResp = await bot.exec("storage", { action: 'deposit', target: 'storage', item_id: route!.itemId, quantity: inCargo });
          } else {
            dResp = await bot.exec("storage", { action: 'deposit', target: 'faction', item_id: route!.itemId, quantity: inCargo });
            if (dResp.error) {
              dResp = await bot.exec("storage", { action: 'deposit', target: 'storage', item_id: route!.itemId, quantity: inCargo });
            }
          }
          if (dResp.error) {
            ctx.log("error", `Failed to return ${inCargo}x ${route!.itemName} to origin storage: ${dResp.error.message}`);
          } else {
            ctx.log("trade", `Returned ${inCargo}x ${route!.itemName} to origin storage (${route!.destPoiName})`);
          }
        } else {
          ctx.log("trade", `No ${route!.itemName} in cargo to return — nothing to deposit`);
        }
        const retSession = getActiveSession(bot.username);
        if (retSession) {
          await abandonTradeSession(bot.username, "Cargo returned to origin (buyer vanished)");
        }
      } else if (inCargo > 0) {
        // Get actual market data to calculate real expected revenue
        const itemConfig = settings.tradeItems.find(t => t.itemId === route!.itemId);
        const itemMinSellPrice = (itemConfig && itemConfig.minSellPrice > 0) ? itemConfig.minSellPrice : settings.minSellPrice;

        const marketCheck = await calculateFactionOptimalSellQuantity(
          ctx, route!.itemId, route!.itemName, inCargo, itemMinSellPrice
        );

        if (marketCheck.sellQty <= 0) {
          const minPrice = itemMinSellPrice > 0 ? ` (minimum: ${itemMinSellPrice}cr)` : "";
          ctx.log("trade", `No viable buy orders for ${route!.itemName} at ${route!.destPoiName}${minPrice} — skipping sell`);
          await failFactionSession(bot.username, "No viable buy orders at destination");
        } else {
          ctx.log("trade", `Selling ${marketCheck.sellQty}x ${route!.itemName} (${marketCheck.priceBreakdown})...`);
          const sale = await executeFactionSell(ctx, {
            itemId: route!.itemId,
            itemName: route!.itemName,
            quantity: marketCheck.sellQty,
            floor: marketCheck.floor,
            bestQuotedPrice: marketCheck.buyOrders[0]?.priceEach ?? route!.sellPrice,
            destPoi: route!.destPoi,
            destPoiName: route!.destPoiName,
          });

          if (sale.error) {
            ctx.log("error", `Sell failed: ${sale.error}`);
            await failFactionSession(bot.username, `Sell failed: ${sale.error}`);
          } else if (sale.listed > 0) {
            // Cargo went into a price-protected listing instead of a market
            // order. No credits are earned until it fills, so the session ends
            // with zero realized revenue and nothing is donated.
            ctx.log("trade", `${sale.listed}x ${route!.itemName} listed at ${route!.destPoiName} — 0cr realized until it fills`);
            releaseSessionLock(bot.username, "listed_contested_book");
            await abandonTradeSession(bot.username, `Listed ${sale.listed}x at ${route!.destPoiName} (contested book)`);
          } else if (sale.sold <= 0) {
            ctx.log("error", `Sell command succeeded but no items were sold and no revenue earned - item still in cargo (${inCargo}x)`);
            await failFactionSession(bot.username, "Sell command did not remove items from cargo");
          } else {
            const revenue = sale.revenue;
            const profit = realizedFactionProfit(route!, revenue);
            const actuallySold = sale.sold;

            bot.stats.totalTrades++;
            bot.stats.totalProfit = sanitizeCredits(bot.stats.totalProfit + profit);
            ctx.log("trade", `Sold ${describeFills(sale)} at ${route!.destPoiName} — ${profit}cr profit`);

            // Only ever donate against realized profit. A swept book yields a
            // loss, and paying a cut of an imaginary profit compounds it.
            await factionDonateProfit(ctx, profit, settings.creditsToHold);
            await completeTradeSession(bot.username, revenue, profit);

            // Release buy order lock
            releaseSessionLock(bot.username, sale.belowFloor ? "completed_below_floor" : "completed");

            ctx.log("trade", "Trade session completed successfully");

            // Update sold quantity tracking in settings
            try {
              const allSettings = readSettings();
              const ftSettings = (allSettings["faction_trader"] as Record<string, unknown>) || {};
              const tradeItems = (ftSettings.tradeItems as TradeItemConfig[]) || [];
              const itemIndex = tradeItems.findIndex(t => t.itemId === route!.itemId);
              if (itemIndex >= 0) {
                tradeItems[itemIndex].soldQty = (tradeItems[itemIndex].soldQty || 0) + actuallySold;
                writeSettings({ faction_trader: { tradeItems } as Record<string, unknown> });
                ctx.log("trade", `Updated sold quantity for ${route!.itemName}: ${tradeItems[itemIndex].soldQty} total`);
              }
            } catch (err) {
              ctx.log("error", `Failed to update sold quantity tracking: ${err}`);
            }

            // Always refuel after selling before heading home (especially important for long return trips)
            ctx.log("system", "Topping off fuel before return journey...");
            await tryRefuel(ctx);
          }
        }
      } else {
        // No cargo - session recovery needed
        ctx.log("error", "No cargo found at destination — trade session may need recovery");
        await failFactionSession(bot.username, "Cargo missing at destination");
      }
      await recordMarketData(ctx);
    } // End else (cross-system)

    // ── Return to home station ──
    const homeSystem = settings.homeSystem || startSystem;
    const homeStationPoi = getHomeStationPoi(settings.homeStation) || null;
    const needsReturn = homeSystem && (bot.system !== homeSystem || (homeStationPoi && bot.poi !== homeStationPoi));

    if (needsReturn) {
      yield "return_home";
      if (bot.system !== homeSystem) {
        ctx.log("travel", `Returning to home system ${homeSystem}...`);
        await ensureUndocked(ctx);
        const homeFueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
        if (homeFueled) {
          await navigateToSystem(ctx, homeSystem, safetyOpts);
        }
      }

      // Dock at the specific home station POI
      if (homeStationPoi && bot.poi !== homeStationPoi) {
        await ensureUndocked(ctx);
        const tResp = await bot.exec("travel", { target_poi: homeStationPoi });

        // Check for battle after travel
        if (await checkBattleAfterCommand(ctx, tResp.notifications, "travel")) {
          ctx.log("combat", "Battle detected during travel home - fleeing!");
          await ctx.sleep(5000);
          continue;
        }

        // CRITICAL: Check for battle interrupt error
        if (tResp.error) {
          const errMsg = tResp.error.message.toLowerCase();
          if (tResp.error.code === "battle_interrupt" || errMsg.includes("interrupted by battle") || errMsg.includes("interrupted by combat")) {
            ctx.log("combat", `Travel home interrupted by battle! ${tResp.error.message} - fleeing!`);
            await ctx.sleep(5000);
            continue;
          }
        }

        if (!tResp.error || tResp.error.message.includes("already")) {
          bot.poi = homeStationPoi;
        }
      }
    }

    // Maintenance between runs
    yield "post_trade_maintenance";
    if (abBooster && abBooster.usedUnits > 0) {
      ctx.log("trade", `Afterburner run complete: ${abBooster.summary()}`);
    }
    await ensureDocked(ctx);
    await tryRefuel(ctx);
    await repairShip(ctx);

    // ── Deposit excess credits: keep only creditsToHold, deposit rest to faction ──
    yield "deposit_credits";
    if (settings.disableCreditDeposit) {
      ctx.log("trade", `Credit deposit to faction storage disabled — keeping ${bot.credits}cr`);
    } else {
      const BOT_WORKING_BALANCE = settings.creditsToHold || 10_000;
      if (bot.credits > BOT_WORKING_BALANCE) {
        const excessCredits = bot.credits - BOT_WORKING_BALANCE;
        //const depositResp = await bot.exec("faction_deposit_credits", { amount: excessCredits });
        const depositResp = await bot.exec("storage", { action: 'deposit', target: 'faction', item_id: 'credits', quantity: excessCredits }); //fixed by human!
        if (!depositResp.error) {
          ctx.log("trade", `Deposited ${excessCredits}cr to faction treasury (retained ${BOT_WORKING_BALANCE}cr)`);
          logFactionActivity(ctx, "deposit", `Deposited ${excessCredits}cr (excess credits above ${BOT_WORKING_BALANCE}cr)`);
        }
      }
    }
  }
};
