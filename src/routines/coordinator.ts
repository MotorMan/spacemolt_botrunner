import type { Routine, RoutineContext } from "../bot.js";
import { mapStore } from "../mapstore.js";
import { catalogStore } from "../catalogstore.js";
import { cachedFetch } from "../httpcache.js";
import {
  ensureDocked,
  tryRefuel,
  repairShip,
  readSettings,
  writeSettings,
  sleep,
  logFactionActivity,
  isOreBeltPoi,
} from "./common.js";

// ── Settings ─────────────────────────────────────────────────

function getCoordinatorSettings(): {
  cycleIntervalSec: number;
  minProfitMargin: number;
  maxCraftLimit: number;
  autoAdjustOre: boolean;
  autoAdjustCraft: boolean;
  targetItems: string[];
  useGlobalMarket: boolean;
  enableOrders: boolean;
  maxOrderBudget: number;
  maxFactionBudget: number;
  orderExpiryHours: number;
  maxBuyOrders: number;
  maxSellOrders: number;
} {
  const all = readSettings();
  const c = all.coordinator || {};
  return {
    cycleIntervalSec: (c.cycleIntervalSec as number) || 300,
    minProfitMargin: (c.minProfitMargin as number) || 20,
    maxCraftLimit: (c.maxCraftLimit as number) || 50,
    autoAdjustOre: c.autoAdjustOre !== false,
    autoAdjustCraft: c.autoAdjustCraft !== false,
    targetItems: Array.isArray(c.targetItems) ? (c.targetItems as string[]) : [],
    useGlobalMarket: c.useGlobalMarket !== false,
    enableOrders: (c.enableOrders as boolean) ?? false,
    maxOrderBudget: (c.maxOrderBudget as number) || 5000,
    maxFactionBudget: (c.maxFactionBudget as number) || 10000,
    orderExpiryHours: (c.orderExpiryHours as number) || 24,
    maxBuyOrders: (c.maxBuyOrders as number) || 5,
    maxSellOrders: (c.maxSellOrders as number) || 5,
  };
}

// ── Types ────────────────────────────────────────────────────

interface Recipe {
  recipe_id: string;
  name: string;
  components: Array<{ item_id: string; name: string; quantity: number }>;
  output_item_id: string;
  output_name: string;
  output_quantity: number;
}

interface DemandEntry {
  totalValue: number;
  bestPrice: number;
  stations: string[];
}

interface GlobalMarketEntry {
  item_id: string;
  item_name: string;
  category: string;
  base_value: number;
  empire: string;
  best_bid: number;
  best_ask: number;
  bid_quantity: number;
  ask_quantity: number;
}

interface GlobalMarketData {
  /** Best buy demand across all empires per item. */
  bidByItem: Map<string, { bestPrice: number; totalQty: number; empires: string[] }>;
  /** Lowest ask (cheapest to buy) per item — used for material cost estimation. */
  askByItem: Map<string, number>;
  /** Reference base values per item — fallback when ask is unknown. */
  baseValues: Map<string, number>;
}

const GLOBAL_MARKET_URL = "https://game.spacemolt.com/api/market";

async function fetchGlobalMarket(
  log: (tag: string, msg: string) => void,
): Promise<GlobalMarketData | null> {
  let raw: unknown;
  try {
    raw = await cachedFetch(GLOBAL_MARKET_URL, 5 * 60_000, { // 5min fallback TTL
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    log("error", `Global market fetch failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }

  const entries: GlobalMarketEntry[] = Array.isArray(raw)
    ? (raw as GlobalMarketEntry[])
    : Array.isArray((raw as Record<string, unknown>).items)
      ? ((raw as Record<string, unknown>).items as GlobalMarketEntry[])
      : [];

  const bidByItem = new Map<string, { bestPrice: number; totalQty: number; empires: string[] }>();
  const askByItem = new Map<string, number>();
  const baseValues = new Map<string, number>();

  for (const entry of entries) {
    const id = entry.item_id;
    if (!id) continue;

    if (entry.base_value > 0) baseValues.set(id, entry.base_value);

    if (entry.best_bid > 0 && entry.bid_quantity > 0) {
      const existing = bidByItem.get(id);
      if (!existing) {
        bidByItem.set(id, {
          bestPrice: entry.best_bid,
          totalQty: entry.bid_quantity,
          empires: [entry.empire],
        });
      } else {
        if (entry.best_bid > existing.bestPrice) existing.bestPrice = entry.best_bid;
        existing.totalQty += entry.bid_quantity;
        if (!existing.empires.includes(entry.empire)) existing.empires.push(entry.empire);
      }
    }

    if (entry.best_ask > 0 && entry.ask_quantity > 0) {
      const existing = askByItem.get(id);
      if (existing === undefined || entry.best_ask < existing) {
        askByItem.set(id, entry.best_ask);
      }
    }
  }

  log("coord", `Global market: ${entries.length} entries, ${bidByItem.size} items with buy demand`);
  return { bidByItem, askByItem, baseValues };
}

// ── Recipe parsing ───────────────────────────────────────────

function parseRecipes(data: unknown): Recipe[] {
  if (!data || typeof data !== "object") return [];
  const d = data as Record<string, unknown>;

  let raw: Array<Record<string, unknown>> = [];
  if (Array.isArray(d)) {
    raw = d;
  } else if (Array.isArray(d.items)) {
    raw = d.items as Array<Record<string, unknown>>;
  } else if (Array.isArray(d.recipes)) {
    raw = d.recipes as Array<Record<string, unknown>>;
  } else {
    const values = Object.values(d).filter(v => v && typeof v === "object");
    if (values.length > 0 && !Array.isArray(values[0])) {
      raw = values as Array<Record<string, unknown>>;
    }
  }

  return raw.map(r => {
    const comps = (r.components || r.ingredients || r.inputs || r.materials || []) as Array<Record<string, unknown>>;
    const rawOutputs = r.outputs || r.output || r.result || r.produces;
    const output: Record<string, unknown> = Array.isArray(rawOutputs)
      ? (rawOutputs[0] as Record<string, unknown>) || {}
      : (rawOutputs as Record<string, unknown>) || {};

    return {
      recipe_id: (r.recipe_id as string) || (r.id as string) || "",
      name: (r.name as string) || (r.recipe_id as string) || "",
      components: comps.map(c => ({
        item_id: (c.item_id as string) || (c.id as string) || (c.item as string) || "",
        name: (c.name as string) || (c.item_name as string) || (c.item_id as string) || "",
        quantity: (c.quantity as number) || (c.amount as number) || (c.count as number) || 1,
      })),
      output_item_id: (output.item_id as string) || (output.id as string) || (r.output_item_id as string) || "",
      output_name: (output.name as string) || (output.item_name as string) || (r.name as string) || "",
      output_quantity: (output.quantity as number) || (output.amount as number) || 1,
    };
  }).filter(r => r.recipe_id);
}

/** Fetch all recipes from the catalog API, handling pagination. */
async function fetchAllRecipes(ctx: RoutineContext): Promise<Recipe[]> {
  const { bot } = ctx;
  const all: Recipe[] = [];
  let page = 1;

  while (true) {
    const resp = await bot.exec("catalog", { type: "recipes", page, page_size: 50 });
    if (resp.error) {
      ctx.log("error", `Catalog fetch failed (page ${page}): ${resp.error.message}`);
      break;
    }

    const r = resp.result as Record<string, unknown> | undefined;
    const totalPages = (r?.total_pages as number) || 1;
    const parsed = parseRecipes(resp.result);
    all.push(...parsed);

    if (page >= totalPages || parsed.length === 0) break;
    page++;
  }

  return all;
}

// ── Demand analysis helpers ──────────────────────────────────

/** Build a map of items with buy orders across all known markets. */
function buildDemandMap(global?: GlobalMarketData): Map<string, DemandEntry> {
  const demand = new Map<string, DemandEntry>();
  const allBuys = mapStore.getAllBuyDemand();

  for (const buy of allBuys) {
    const existing = demand.get(buy.itemId);
    const value = buy.price * buy.quantity;
    if (existing) {
      existing.totalValue += value;
      if (buy.price > existing.bestPrice) existing.bestPrice = buy.price;
      if (!existing.stations.includes(buy.poiName)) existing.stations.push(buy.poiName);
    } else {
      demand.set(buy.itemId, {
        totalValue: value,
        bestPrice: buy.price,
        stations: [buy.poiName],
      });
    }
  }

  // Supplement with global API data — adds items not seen locally, and
  // updates bestPrice when global buyers are paying more than local ones.
  if (global) {
    for (const [itemId, bid] of global.bidByItem) {
      const existing = demand.get(itemId);
      if (!existing) {
        demand.set(itemId, {
          totalValue: bid.bestPrice * bid.totalQty,
          bestPrice: bid.bestPrice,
          stations: bid.empires.map(e => `[${e}]`),
        });
      } else if (bid.bestPrice > existing.bestPrice) {
        existing.bestPrice = bid.bestPrice;
        for (const empire of bid.empires) {
          const tag = `[${empire}]`;
          if (!existing.stations.includes(tag)) existing.stations.push(tag);
        }
      }
    }
  }

  return demand;
}

/** Calculate profit margin for crafting a recipe and selling at the demand price. */
function calculateCraftProfit(
  recipe: Recipe,
  demandPrice: number,
  globalAskMap?: Map<string, number>,
  baseValues?: Map<string, number>,
): { profitPct: number; materialCost: number } {
  let materialCost = 0;

  for (const comp of recipe.components) {
    const bestSell = mapStore.findBestSellPrice(comp.item_id);
    let unitPrice: number | null = null;

    if (bestSell) {
      unitPrice = bestSell.price;
    } else if (globalAskMap) {
      unitPrice = globalAskMap.get(comp.item_id) ?? null;
    }
    if (unitPrice === null && baseValues) {
      unitPrice = baseValues.get(comp.item_id) ?? null;
    }

    if (unitPrice === null) {
      // Unknown material cost — can't estimate profitability
      return { profitPct: -1, materialCost: -1 };
    }
    materialCost += unitPrice * comp.quantity;
  }

  if (materialCost <= 0) return { profitPct: -1, materialCost: 0 };

  const revenue = demandPrice * recipe.output_quantity;
  const profitPct = ((revenue - materialCost) / materialCost) * 100;
  return { profitPct, materialCost };
}

/** Find which ore is most consumed by the active craft limits. */
function findMostNeededOre(
  recipes: Recipe[],
  craftLimits: Record<string, number>,
): string {
  const oreConsumption = new Map<string, number>();

  for (const [recipeId, limit] of Object.entries(craftLimits)) {
    if (limit <= 0) continue;
    const recipe = recipes.find(r => r.recipe_id === recipeId || r.name === recipeId);
    if (!recipe) continue;

    for (const comp of recipe.components) {
      // Check if this component is a raw ore (exists in mapStore ore data)
      const oreLocations = mapStore.findOreLocations(comp.item_id);
      if (oreLocations.length > 0) {
        oreConsumption.set(
          comp.item_id,
          (oreConsumption.get(comp.item_id) || 0) + comp.quantity * limit,
        );
      }
    }
  }

  let bestOre = "";
  let bestConsumption = 0;
  for (const [oreId, consumption] of oreConsumption) {
    if (consumption > bestConsumption) {
      bestConsumption = consumption;
      bestOre = oreId;
    }
  }

  return bestOre;
}

// ── Recipe index + material analysis ─────────────────────────

/** Build a lookup: output_item_id → Recipe. */
function buildRecipeIndex(recipes: Recipe[]): Map<string, Recipe> {
  const index = new Map<string, Recipe>();
  for (const r of recipes) {
    if (r.output_item_id) index.set(r.output_item_id, r);
  }
  return index;
}

/** Recursively resolve a recipe's ingredient tree down to raw materials (items with no recipe). */
function flattenToRawMaterials(
  recipe: Recipe,
  recipeIndex: Map<string, Recipe>,
  quantity: number = 1,
  depth: number = 0,
): Map<string, number> {
  if (depth > 5) return new Map();
  const raw = new Map<string, number>();
  for (const comp of recipe.components) {
    const totalNeeded = comp.quantity * quantity;
    const subRecipe = recipeIndex.get(comp.item_id);
    if (subRecipe) {
      const batchesNeeded = Math.ceil(totalNeeded / (subRecipe.output_quantity || 1));
      const subRaw = flattenToRawMaterials(subRecipe, recipeIndex, batchesNeeded, depth + 1);
      for (const [id, qty] of subRaw) {
        raw.set(id, (raw.get(id) || 0) + qty);
      }
    } else {
      raw.set(comp.item_id, (raw.get(comp.item_id) || 0) + totalNeeded);
    }
  }
  return raw;
}

/** Collect intermediate recipes needed to craft a recipe, with required batch counts. */
function collectIntermediateRecipes(
  recipe: Recipe,
  recipeIndex: Map<string, Recipe>,
  batchCount: number,
  depth: number = 0,
): Map<string, number> {
  if (depth > 5) return new Map();
  const intermediates = new Map<string, number>();

  for (const comp of recipe.components) {
    const subRecipe = recipeIndex.get(comp.item_id);
    if (!subRecipe) continue; // raw material, skip

    const totalNeeded = comp.quantity * batchCount;
    const batchesNeeded = Math.ceil(totalNeeded / (subRecipe.output_quantity || 1));

    intermediates.set(
      subRecipe.recipe_id,
      (intermediates.get(subRecipe.recipe_id) || 0) + batchesNeeded,
    );

    // Recurse for deeper intermediates
    const deeper = collectIntermediateRecipes(subRecipe, recipeIndex, batchesNeeded, depth + 1);
    for (const [id, qty] of deeper) {
      intermediates.set(id, (intermediates.get(id) || 0) + qty);
    }
  }

  return intermediates;
}

/** Check if faction storage has enough raw materials. Returns max craftable batches. */
function checkMaterialAvailability(
  rawNeeds: Map<string, number>,
  factionStorage: Array<{ itemId: string; quantity: number }>,
): { canCraft: boolean; maxBatches: number } {
  let maxBatches = Infinity;
  for (const [itemId, neededPerBatch] of rawNeeds) {
    const available = factionStorage.find(i => i.itemId === itemId)?.quantity || 0;
    const batches = Math.floor(available / neededPerBatch);
    if (batches < maxBatches) maxBatches = batches;
  }
  if (maxBatches === Infinity) maxBatches = 0;
  return { canCraft: maxBatches > 0, maxBatches };
}

/** Compute ore quotas from active craft limits — sum raw ore needs per recipe. */
function computeOreQuotas(
  recipes: Recipe[],
  recipeIndex: Map<string, Recipe>,
  craftLimits: Record<string, number>,
): Record<string, number> {
  const oreNeeds: Record<string, number> = {};

  for (const [recipeId, limit] of Object.entries(craftLimits)) {
    if (limit <= 0) continue;
    const recipe = recipes.find(r => r.recipe_id === recipeId || r.name === recipeId);
    if (!recipe) continue;

    const rawMaterials = flattenToRawMaterials(recipe, recipeIndex);
    for (const [itemId, qtyPerBatch] of rawMaterials) {
      // Only include items that are minable at ore belts (not ice fields or gas clouds)
      const oreLocations = mapStore.findOreLocations(itemId);
      const oreBeltLocations = oreLocations.filter(loc => {
        const sys = mapStore.getSystem(loc.systemId);
        const poi = sys?.pois.find(p => p.id === loc.poiId);
        return poi ? isOreBeltPoi(poi.type) : false;
      });
      if (oreBeltLocations.length > 0) {
        oreNeeds[itemId] = (oreNeeds[itemId] || 0) + qtyPerBatch * limit;
      }
    }
  }

  return oreNeeds;
}

// ── Market orders ────────────────────────────────────────────

interface ActiveOrder {
  orderId: string;
  itemId: string;
  orderType: "buy" | "sell";
  price: number;
  quantity: number;
  placedAt: string;
}

/** Parse orders from view_orders response, handling various response shapes. */
function parseOrders(result: unknown): ActiveOrder[] {
  if (!result || typeof result !== "object") return [];
  const r = result as Record<string, unknown>;

  const orders: ActiveOrder[] = [];

  // Handle combined list or separate buy/sell lists
  const combined = (
    Array.isArray(r) ? r :
    Array.isArray(r.orders) ? r.orders :
    []
  ) as Array<Record<string, unknown>>;

  const buyOrders = Array.isArray(r.buy_orders) ? r.buy_orders as Array<Record<string, unknown>> : [];
  const sellOrders = Array.isArray(r.sell_orders) ? r.sell_orders as Array<Record<string, unknown>> : [];

  function mapOrder(o: Record<string, unknown>, defaultType: "buy" | "sell"): ActiveOrder | null {
    const orderId = (o.order_id as string) || (o.id as string) || "";
    if (!orderId) return null;
    const typeStr = ((o.type as string) || (o.order_type as string) || defaultType).toLowerCase();
    return {
      orderId,
      itemId: (o.item_id as string) || "",
      orderType: typeStr === "sell" ? "sell" : "buy",
      price: (o.price as number) || (o.unit_price as number) || 0,
      quantity: (o.quantity as number) || (o.remaining as number) || 0,
      placedAt: (o.placed_at as string) || (o.created_at as string) || "",
    };
  }

  for (const o of combined) {
    const mapped = mapOrder(o, "buy");
    if (mapped) orders.push(mapped);
  }
  for (const o of buyOrders) {
    const mapped = mapOrder(o, "buy");
    if (mapped) orders.push(mapped);
  }
  for (const o of sellOrders) {
    const mapped = mapOrder(o, "sell");
    if (mapped) orders.push(mapped);
  }

  return orders;
}

/** Cancel orders older than expiryHours. Returns count of cancelled orders. */
async function cancelStaleOrders(ctx: RoutineContext, expiryHours: number): Promise<number> {
  const { bot } = ctx;
  const orderData = await bot.viewOrders();
  const orders = parseOrders(orderData);
  if (orders.length === 0) return 0;

  const now = Date.now();
  const expiryMs = expiryHours * 60 * 60 * 1000;
  let cancelled = 0;

  for (const order of orders) {
    if (!order.placedAt) continue;
    const placedTime = new Date(order.placedAt).getTime();
    if (isNaN(placedTime)) continue;
    if (now - placedTime < expiryMs) continue;

    const resp = await bot.exec("cancel_order", { order_id: order.orderId });
    if (!resp.error) {
      cancelled++;
      ctx.log("coord", `Cancelled stale ${order.orderType} order: ${order.quantity}x ${order.itemId} at ${order.price}cr`);
    }
  }

  return cancelled;
}

/** Place market buy and sell orders based on arbitrage and faction storage. */
async function placeMarketOrders(
  ctx: RoutineContext,
  settings: ReturnType<typeof getCoordinatorSettings>,
  demandMap: Map<string, DemandEntry>,
  globalMarket?: GlobalMarketData,
): Promise<void> {
  const { bot } = ctx;

  // Get existing orders to avoid duplicates
  const orderData = await bot.viewOrders();
  const existingOrders = parseOrders(orderData);
  const existingBuyItems = new Set(existingOrders.filter(o => o.orderType === "buy").map(o => o.itemId));
  const existingSellItems = new Set(existingOrders.filter(o => o.orderType === "sell").map(o => o.itemId));
  const currentBuyCount = existingOrders.filter(o => o.orderType === "buy").length;
  const currentSellCount = existingOrders.filter(o => o.orderType === "sell").length;

  // Get local market
  const marketResp = await bot.exec("view_market");
  if (!marketResp.result || typeof marketResp.result !== "object") return;
  const md = marketResp.result as Record<string, unknown>;
  const listings = (
    Array.isArray(md) ? md :
    Array.isArray(md.items) ? md.items :
    Array.isArray(md.listings) ? md.listings : []
  ) as Array<Record<string, unknown>>;

  // ── Buy orders (arbitrage) ──
  let walletBudgetUsed = 0;
  let factionBudgetUsed = 0;
  let buyOrdersPlaced = currentBuyCount;

  for (const listing of listings) {
    if (buyOrdersPlaced >= settings.maxBuyOrders) break;

    const itemId = (listing.item_id as string) || "";
    if (!itemId) continue;
    if (existingBuyItems.has(itemId)) continue;

    // Skip crafting components / fuel
    const lower = itemId.toLowerCase();
    if (lower.includes("fuel") || lower.includes("energy_cell")) continue;

    const localSellPrice = (listing.sell_price as number) || (listing.best_sell as number) || 0;
    if (localSellPrice <= 0) continue;

    // Find if this item sells for more elsewhere
    const demand = demandMap.get(itemId);
    const globalBid = globalMarket?.bidByItem.get(itemId);
    const bestElsewhere = Math.max(demand?.bestPrice || 0, globalBid?.bestPrice || 0);

    const margin = bestElsewhere - localSellPrice;
    if (margin < settings.minProfitMargin) continue;

    // Determine funding tier
    const isHighProfit = margin >= settings.minProfitMargin * 2;
    let fundingSource: "wallet" | "faction" | null = null;
    const orderCost = localSellPrice * 10; // buy ~10 units

    if (walletBudgetUsed + orderCost <= settings.maxOrderBudget && bot.credits >= orderCost + 500) {
      fundingSource = "wallet";
    } else if (isHighProfit && factionBudgetUsed + orderCost <= settings.maxFactionBudget) {
      fundingSource = "faction";
    }

    if (!fundingSource) continue;

    // Withdraw from faction if needed
    if (fundingSource === "faction") {
      const wResp = await bot.exec("faction_withdraw_credits", { amount: orderCost });
      if (wResp.error) continue;
      logFactionActivity(ctx, "withdraw", `Withdrew ${orderCost}cr for buy order on ${itemId}`);
    }

    const qty = Math.max(1, Math.floor(orderCost / localSellPrice));
    const resp = await bot.exec("create_buy_order", {
      item_id: itemId,
      quantity: qty,
      price: localSellPrice,
    });

    if (!resp.error) {
      buyOrdersPlaced++;
      if (fundingSource === "wallet") walletBudgetUsed += orderCost;
      else factionBudgetUsed += orderCost;
      ctx.log("coord", `Buy order placed: ${qty}x ${itemId} at ${localSellPrice}cr (sells for ${bestElsewhere}cr elsewhere, +${margin}cr margin)`);
    } else {
      // Refund faction credits on failure
      if (fundingSource === "faction") {
        await bot.exec("faction_deposit_credits", { amount: orderCost });
      }
    }
  }

  // ── Sell orders (faction storage liquidation) ──
  await bot.refreshFactionStorage();
  let sellOrdersPlaced = currentSellCount;

  for (const item of bot.factionStorage) {
    if (sellOrdersPlaced >= settings.maxSellOrders) break;
    if (item.quantity <= 0) continue;
    if (existingSellItems.has(item.itemId)) continue;

    const lower = item.itemId.toLowerCase();
    if (lower.includes("fuel") || lower.includes("energy_cell")) continue;

    // Find best known sell price
    const bestSell = mapStore.findBestSellPrice(item.itemId);
    const globalAsk = globalMarket?.askByItem.get(item.itemId);
    const basePrice = bestSell?.price || globalAsk || 0;
    if (basePrice <= 0) continue;

    const sellPrice = Math.ceil(basePrice * 1.15); // 15% markup
    const qty = Math.min(item.quantity, 50); // cap at 50

    // Withdraw items from faction storage
    const wResp = await bot.exec("faction_withdraw_items", { item_id: item.itemId, quantity: qty });
    if (wResp.error) continue;

    const resp = await bot.exec("create_sell_order", {
      item_id: item.itemId,
      quantity: qty,
      price: sellPrice,
    });

    if (!resp.error) {
      sellOrdersPlaced++;
      logFactionActivity(ctx, "withdraw", `Listed ${qty}x ${item.name} for sale at ${sellPrice}cr/ea`);
      ctx.log("coord", `Sell order placed: ${qty}x ${item.name} at ${sellPrice}cr (base: ${basePrice}cr)`);
    } else {
      // Re-deposit on failure
      await bot.exec("faction_deposit_items", { item_id: item.itemId, quantity: qty });
    }
  }
}

// ── Coordinator routine ──────────────────────────────────────

/**
 * Coordinator routine — stays docked, analyzes market demand, and auto-adjusts
 * crafter craftLimits and miner targetOre in settings.json.
 *
 * 1. Fetch global market data from /api/market (no auth needed)
 * 2. Scan mapStore for all local market data across visited stations
 * 3. Build demand map: merge local (priority) + global (supplement)
 * 4. Fetch recipe catalog
 * 5. For each in-demand item that can be crafted, calculate profitability
 *    (uses global ask prices / base_values as material cost fallback)
 * 6. Update crafter craftLimits for profitable recipes
 * 7. Update miner targetOre for most-needed raw material
 * 8. Sleep, repeat
 */
export const coordinatorRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  await bot.refreshStatus();

  while (bot.state === "running") {
    const settings = getCoordinatorSettings();

    // ── Ensure docked ──
    yield "dock";
    await ensureDocked(ctx);

    // ── Refresh market data at current station ──
    yield "refresh_market";
    if (bot.docked) {
      const marketResp = await bot.exec("view_market");
      if (marketResp.result && typeof marketResp.result === "object" && bot.system && bot.poi) {
        mapStore.updateMarket(bot.system, bot.poi, marketResp.result as Record<string, unknown>);
      }
    }

    // ── Fetch global market data ──
    let globalMarket: GlobalMarketData | undefined;
    if (settings.useGlobalMarket) {
      yield "fetch_global_market";
      globalMarket = (await fetchGlobalMarket(ctx.log)) ?? undefined;
    }

    // ── Build demand map ──
    yield "analyze_demand";
    const demandMap = buildDemandMap(globalMarket);

    if (demandMap.size === 0) {
      ctx.log("coord", "No buy demand found on any known market — waiting for explorer/market data");
      await sleep(settings.cycleIntervalSec * 1000);
      continue;
    }

    const localCount = mapStore.getAllBuyDemand().length;
    const globalCount = demandMap.size - localCount;
    ctx.log("coord", `Found demand for ${demandMap.size} item(s) (${localCount} local, ${globalCount > 0 ? `+${globalCount} from global API` : "0 global supplement"})`);

    // ── Fetch recipes ──
    yield "fetch_recipes";
    const recipes = await fetchAllRecipes(ctx);
    if (recipes.length === 0) {
      ctx.log("error", "No recipes available — waiting for next cycle");
      await sleep(settings.cycleIntervalSec * 1000);
      continue;
    }
    ctx.log("coord", `Loaded ${recipes.length} recipes`);

    // ── Analyze profitability ──
    yield "calculate_profit";
    const profitable: Array<{ recipe: Recipe; profitPct: number; demandPrice: number; usedFallback: boolean }> = [];

    for (const recipe of recipes) {
      const outputId = recipe.output_item_id || recipe.recipe_id;
      const demand = demandMap.get(outputId);
      if (!demand) continue;

      // Filter by targetItems if configured
      if (settings.targetItems.length > 0) {
        const match = settings.targetItems.some(t =>
          outputId.toLowerCase().includes(t.toLowerCase()) ||
          recipe.name.toLowerCase().includes(t.toLowerCase())
        );
        if (!match) continue;
      }

      // First try without fallback (fully locally-priced)
      const { profitPct: localProfitPct } = calculateCraftProfit(recipe, demand.bestPrice);
      const usedFallback = localProfitPct < 0;

      // If local data is incomplete, retry with global fallbacks
      const { profitPct } = usedFallback
        ? calculateCraftProfit(recipe, demand.bestPrice, globalMarket?.askByItem, globalMarket?.baseValues)
        : { profitPct: localProfitPct };

      if (profitPct >= settings.minProfitMargin) {
        profitable.push({ recipe, profitPct, demandPrice: demand.bestPrice, usedFallback });
      }
    }

    // Sort by profit descending
    profitable.sort((a, b) => b.profitPct - a.profitPct);

    // ── Update crafter settings (material-aware) ──
    const recipeIndex = buildRecipeIndex(recipes);

    if (settings.autoAdjustCraft) {
      yield "update_craft_limits";

      // Refresh faction storage to check material availability
      await bot.refreshFactionStorage();

      const allSettings = readSettings();
      const crafterSettings = allSettings.crafter || {};
      const currentLimits = (crafterSettings.craftLimits as Record<string, number>) || {};
      const newLimits: Record<string, number> = { ...currentLimits };

      const adjustments: string[] = [];
      const skipped: string[] = [];
      const profitableIds = new Set<string>();

      for (const { recipe, profitPct, usedFallback } of profitable) {
        const recipeId = recipe.recipe_id;
        profitableIds.add(recipeId);

        // Check if faction storage has raw materials
        const rawNeeds = flattenToRawMaterials(recipe, recipeIndex);
        const { canCraft, maxBatches } = checkMaterialAvailability(rawNeeds, bot.factionStorage);

        if (!canCraft) {
          skipped.push(recipe.name);
          // Zero out existing limit if materials are gone
          if (newLimits[recipeId] && newLimits[recipeId] > 0) {
            newLimits[recipeId] = 0;
            adjustments.push(`${recipe.name}: ${currentLimits[recipeId] || 0} → 0 (no materials)`);
          }
          continue;
        }

        // Scale limit by profit margin — higher profit = higher limit
        const scaledLimit = Math.min(
          settings.maxCraftLimit,
          Math.max(5, Math.round(profitPct / 10) * 5),
        );
        // Cap at what we can actually craft from available materials
        const materialCap = maxBatches * recipe.output_quantity;
        const finalLimit = Math.min(scaledLimit, materialCap);

        const prev = newLimits[recipeId] || 0;
        if (finalLimit !== prev) {
          newLimits[recipeId] = finalLimit;
          const suffix = usedFallback ? " ~est" : "";
          adjustments.push(`${recipe.name}: ${prev} → ${finalLimit} (${Math.round(profitPct)}%${suffix}, ${maxBatches} batches avail)`);
        }
      }

      // Add intermediate recipes needed by profitable final products
      const intermediateIds = new Set<string>();
      const intermediateNeeds = new Map<string, number>();
      for (const [recipeId, limit] of Object.entries(newLimits)) {
        if (limit <= 0) continue;
        const recipe = recipes.find(r => r.recipe_id === recipeId);
        if (!recipe) continue;
        const intermediates = collectIntermediateRecipes(recipe, recipeIndex, limit);
        for (const [intId, intQty] of intermediates) {
          intermediateIds.add(intId);
          intermediateNeeds.set(intId, Math.max(intermediateNeeds.get(intId) || 0, intQty));
        }
      }

      for (const [intRecipeId, intQty] of intermediateNeeds) {
        if (profitableIds.has(intRecipeId)) continue; // already set by direct demand
        const prev = newLimits[intRecipeId] || 0;
        const capped = Math.min(intQty, settings.maxCraftLimit);
        if (capped !== prev && capped > 0) {
          newLimits[intRecipeId] = capped;
          const intName = recipes.find(r => r.recipe_id === intRecipeId)?.name || intRecipeId;
          adjustments.push(`${intName}: ${prev} → ${capped} (intermediate)`);
        }
      }

      // Zero out limits for recipes that no longer have demand, profitability, or intermediate need
      for (const [recipeId, limit] of Object.entries(currentLimits)) {
        if (limit > 0 && !profitableIds.has(recipeId) && !intermediateIds.has(recipeId)) {
          newLimits[recipeId] = 0;
          const recipeName = recipes.find(r => r.recipe_id === recipeId)?.name || recipeId;
          adjustments.push(`${recipeName}: ${limit} → 0 (no demand/profit)`);
        }
      }

      if (adjustments.length > 0) {
        writeSettings({ crafter: { craftLimits: newLimits } });
        ctx.log("coord", `Adjusted craft limits: ${adjustments.join(", ")}`);
      } else {
        ctx.log("coord", "Craft limits already optimal — no changes");
      }
      if (skipped.length > 0) {
        ctx.log("coord", `Skipped (no materials): ${skipped.join(", ")}`);
      }
    }

    // ── Update miner targetOre + oreQuotas ──
    if (settings.autoAdjustOre) {
      yield "update_ore_target";
      const allSettings = readSettings();
      const crafterLimits = ((allSettings.crafter || {}).craftLimits as Record<string, number>) || {};
      const bestOre = findMostNeededOre(recipes, crafterLimits);

      // Compute ore quotas from active craft limits
      const oreQuotas = computeOreQuotas(recipes, recipeIndex, crafterLimits);
      const currentQuotas = ((allSettings.miner || {}).oreQuotas as Record<string, number>) || {};
      const quotasChanged = JSON.stringify(oreQuotas) !== JSON.stringify(currentQuotas);

      const minerUpdates: Record<string, unknown> = {};
      if (bestOre) {
        const currentOre = ((allSettings.miner || {}).targetOre as string) || "";
        if (bestOre !== currentOre) {
          minerUpdates.targetOre = bestOre;
          ctx.log("coord", `Miner target ore: ${currentOre || "(none)"} → ${bestOre}`);
        } else {
          ctx.log("coord", `Miner target ore unchanged: ${bestOre}`);
        }
      }
      if (quotasChanged) {
        minerUpdates.oreQuotas = oreQuotas;
        const quotaList = Object.entries(oreQuotas)
          .map(([id, qty]) => `${catalogStore.resolveItemName(id)}: ${qty}`)
          .join(", ");
        ctx.log("coord", `Miner ore quotas: ${quotaList || "(cleared)"}`);
      }
      if (Object.keys(minerUpdates).length > 0) {
        writeSettings({ miner: minerUpdates });
      }
    }

    // ── Summary ──
    const demandSummary = [...demandMap.entries()]
      .sort((a, b) => b[1].totalValue - a[1].totalValue)
      .slice(0, 5)
      .map(([id, d]) => `${id} (${d.bestPrice}cr × ${Math.round(d.totalValue / d.bestPrice)} qty)`)
      .join(", ");
    ctx.log("coord", `Top demand: ${demandSummary}`);

    // ── Credit redistribution: top off bots below 10,000cr from faction treasury ──
    yield "redistribute_credits";
    const fleet = ctx.getFleetStatus?.() || [];
    const BOT_WORKING_BALANCE = 10_000;
    for (const member of fleet) {
      if (member.username === bot.username) continue;
      if (member.state !== "running") continue;
      if (member.credits >= BOT_WORKING_BALANCE) continue;
      const needed = BOT_WORKING_BALANCE - member.credits;
      // Withdraw from faction treasury
      const withdrawResp = await bot.exec("faction_withdraw_credits", { amount: needed });
      if (withdrawResp.error) {
        ctx.log("coord", `Cannot withdraw ${needed}cr for ${member.username}: ${withdrawResp.error.message}`);
        break; // treasury likely empty
      }
      logFactionActivity(ctx, "withdraw", `Withdrew ${needed}cr from treasury for ${member.username}`);
      const giftResp = await bot.exec("send_gift", { recipient: member.username, credits: needed });
      if (giftResp.error) {
        ctx.log("coord", `Gift to ${member.username} failed: ${giftResp.error.message}`);
        // Re-deposit withdrawn credits back
        await bot.exec("faction_deposit_credits", { amount: needed });
      } else {
        ctx.log("coord", `Sent ${needed}cr to ${member.username} (topped off to ${BOT_WORKING_BALANCE}cr)`);
        logFactionActivity(ctx, "gift", `Sent ${needed}cr to ${member.username} (top-off to ${BOT_WORKING_BALANCE}cr)`);
      }
    }

    // ── Market orders ──
    if (settings.enableOrders) {
      yield "cancel_stale_orders";
      const cancelled = await cancelStaleOrders(ctx, settings.orderExpiryHours);
      if (cancelled > 0) ctx.log("coord", `Cancelled ${cancelled} stale order(s)`);

      yield "place_orders";
      await placeMarketOrders(ctx, settings, demandMap, globalMarket);
    }

    // ── Maintenance ──
    yield "maintenance";
    await tryRefuel(ctx);
    await repairShip(ctx);

    // ── Wait for next cycle ──
    ctx.log("info", `Next analysis in ${settings.cycleIntervalSec}s...`);
    await sleep(settings.cycleIntervalSec * 1000);
  }
};
