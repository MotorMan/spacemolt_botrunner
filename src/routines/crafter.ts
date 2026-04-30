import type { Routine, RoutineContext } from "../bot.js";
import { catalogStore } from "../catalogstore.js";
import {
  ensureDocked,
  tryRefuel,
  repairShip,
  ensureFueled,
  detectAndRecoverFromDeath,
  readSettings,
  scavengeWrecks,
  logFactionActivity,
} from "./common.js";

// ── Custom faction storage refresh for debugging ──

async function refreshFactionStorageDirectly(ctx: RoutineContext, bot: any): Promise<void> {
  const factionName = bot.faction;
  if (!factionName) {
    // But let's still try to fetch faction storage to see if it works
  }

  const resp = await bot.exec("view_storage", { target: "faction" });

  if (resp.result === null || resp.result === undefined) {
    bot.factionStorage = [];
    return;
  }

  if (Array.isArray(resp.result)) {
    // Process array directly
  } else if (typeof resp.result === 'object') {
    const r = resp.result as Record<string, unknown>;

    // Check all possible array field names
    const possibleArrays = ['items', 'cargo', 'storage', 'stored_items', 'faction_items', 'faction_storage', 'data', 'result'];
    let foundArray = false;
    for (const key of possibleArrays) {
      if (Array.isArray(r[key])) {
        foundArray = true;
        break;
      }
    }
  }

  // Try to parse the items
  const items = parseFactionStorageItems(resp.result);
  bot.factionStorage = items;
}

function parseFactionStorageItems(result: unknown): Array<{itemId: string, name: string, quantity: number}> {
  if (!result || typeof result !== "object") return [];

  const r = result as Record<string, unknown>;

  // Try different possible array locations
  let items: Array<Record<string, unknown>> = [];
  if (Array.isArray(r)) {
    items = r;
  } else {
    // Check various possible field names
    const possibleFields = ['items', 'cargo', 'storage', 'stored_items', 'faction_items', 'faction_storage', 'data', 'result'];
    for (const field of possibleFields) {
      if (Array.isArray(r[field])) {
        items = r[field] as Array<Record<string, unknown>>;
        break;
      }
    }
  }

  if (items.length === 0) return [];

  // Parse each item
  return items.map((item) => {
    // Try various field name patterns
    const itemId = (item.item_id as string) ||
                   (item.resource_id as string) ||
                   (item.id as string) ||
                   (item.itemId as string) ||
                   "";

    const name = (item.name as string) ||
                 (item.item_name as string) ||
                 (item.resource_name as string) ||
                 (item.itemId as string) ||
                 itemId ||
                 "";

    const quantity = (item.quantity as number) ||
                     (item.count as number) ||
                     (item.amount as number) ||
                     (item.qty as number) ||
                     0;

    return { itemId, name, quantity };
  }).filter(i => i.itemId && i.quantity > 0);
}
import {
  calculateCraftingPlan,
  calculateMultiGoalPlan,
  formatCraftingPlan,
  isRecipeCraftable as isRecipeCraftableNew,
} from "./craft-goals.js";

// ── Settings ─────────────────────────────────────────────────

interface CraftLimit {
  recipeId: string;
  limit: number;
}

interface AutoBuySettings {
  enabled: boolean;
  maxPricePercentOverBase: number;  // e.g., 150 = 150% of base price (50% markup)
  maxCreditsPerCycle: number;
  excludeCategories: string[];      // Never buy these categories (e.g., ["ammo"])
}

/** Ship Passive recipe IDs that run automatically and cannot be crafted manually. */
const SHIP_PASSIVE_RECIPE_IDS = new Set([
  "onboard_alloy_synthesis",
  "onboard_munitions_fabrication",
]);

/** Recipes that should NEVER be used - they are inefficient/wasteful */
const BLACKLISTED_RECIPES = new Set([
  "basic_silicon_refinement", // Noob trap - severe waste of basic materials
]);

/** Recipes that should be heavily penalized - only use as absolute last resort */
const PENALTY_RECIPES: Record<string, number> = {
  "synthesize_bio_polymer": -1000, // Massive penalty - materials better suited for other recipes
};

/** Processing mode for goal-based crafting */
type GoalProcessingMode = "batch" | "round-robin";

function getCrafterSettings(): {
  craftLimits: CraftLimit[];
  enabledCategories: string[];
  refuelThreshold: number;
  repairThreshold: number;
  categoryAssignments: Record<string, string[]>;
  botQuotaOverrides: Record<string, Record<string, number>>;
  goalProcessingMode: GoalProcessingMode;
  autoBuy: AutoBuySettings;
} {
  const all = readSettings();
  const c = all.crafter || {};
  const rawLimits = (c.craftLimits as Record<string, number>) || {};
  const craftLimits: CraftLimit[] = [];
  for (const [recipeId, limit] of Object.entries(rawLimits)) {
    if (limit > 0) {
      // Filter out Ship Passive recipes - they can't be crafted manually
      if (SHIP_PASSIVE_RECIPE_IDS.has(recipeId)) {
        continue; // Skip silently
      }
      craftLimits.push({ recipeId, limit });
    }
  }
  // Default enabled categories for when no specific recipes are configured
  const defaultCategories = ["Refining", "Components", "Consumables"];
  const enabledCategories = (c.enabledCategories as string[]) || defaultCategories;
  // Per-bot category assignments: { botName: ["Refining", "Components"] }
  const categoryAssignments = (c.categoryAssignments as Record<string, string[]>) || {};
  // Per-bot quota overrides: { botName: { recipeId: limit } }
  const botQuotaOverrides = (c.botQuotaOverrides as Record<string, Record<string, number>>) || {};
  // Goal processing mode: "batch" (complete one goal before moving to next) or "round-robin" (craft 1 of each in rotation)
  const goalProcessingMode = (c.goalProcessingMode as GoalProcessingMode) || "batch";
  // Auto-buy settings for missing materials
  const autoBuyConfig = (c.autoBuy as Partial<AutoBuySettings>) || {};
  const autoBuy: AutoBuySettings = {
    enabled: autoBuyConfig.enabled ?? false,
    maxPricePercentOverBase: autoBuyConfig.maxPricePercentOverBase ?? 150,  // 150% = 50% markup allowed
    maxCreditsPerCycle: autoBuyConfig.maxCreditsPerCycle ?? 50000,
    excludeCategories: autoBuyConfig.excludeCategories ?? ["ammo"],
  };
  return {
    craftLimits,
    enabledCategories,
    refuelThreshold: (c.refuelThreshold as number) || 50,
    repairThreshold: (c.repairThreshold as number) || 40,
    categoryAssignments,
    botQuotaOverrides,
    goalProcessingMode,
    autoBuy,
  };
}

// ── Recipe/inventory helpers ─────────────────────────────────

interface Recipe {
  recipe_id: string;
  name: string;
  components: Array<{ item_id: string; name: string; quantity: number }>;
  output_item_id: string;
  output_name: string;
  output_quantity: number;
  category?: string;
}

// ── Active facility materials tracking ─────────────────────────────────

interface ActiveFacilityMaterial {
  itemId: string;
  name: string;
  facilityName: string;
  recipeId: string;
}

let cachedActiveFacilityMaterials: ActiveFacilityMaterial[] = [];

async function getActivePlayerFacilityMaterials(
  ctx: RoutineContext,
  recipes: Recipe[],
): Promise<ActiveFacilityMaterial[]> {
  if (cachedActiveFacilityMaterials.length > 0) {
    return cachedActiveFacilityMaterials;
  }

  const { bot } = ctx;
  const materials: ActiveFacilityMaterial[] = [];

  try {
    const resp = await bot.exec("facility", { action: "list" });
    
    if (resp.error) {
      ctx.log("craft", `Facility list failed: ${resp.error.message}`);
      return materials;
    }

    const result = resp.result as Record<string, unknown> | undefined;
    const playerFacilities = (result?.player_facilities as Array<Record<string, unknown>>) || [];

    for (const facility of playerFacilities) {
      const isActive = facility.active === true;
      if (!isActive) continue;

      const recipeId = facility.recipe_id as string;
      if (!recipeId) continue;

      const facilityName = facility.name as string || "Unknown Facility";
      const facilityType = facility.type as string || "";

      const recipe = recipes.find(r => r.recipe_id === recipeId);
      if (!recipe) {
        ctx.log("craft", `Active facility "${facilityName}" uses unknown recipe: ${recipeId}`);
        continue;
      }

      for (const comp of recipe.components) {
        materials.push({
          itemId: comp.item_id,
          name: comp.name || comp.item_id,
          facilityName,
          recipeId,
        });
      }

      ctx.log("craft", `Active facility: ${facilityName} (${facilityType}) needs: ${recipe.components.map(c => `${c.quantity}x ${c.name}`).join(", ")}`);
    }

    cachedActiveFacilityMaterials = materials;

    if (materials.length > 0) {
      ctx.log("craft", `Active facilities need ${materials.length} material types: ${[...new Set(materials.map(m => m.name))].join(", ")}`);
    }

  } catch (err) {
    ctx.log("error", `Error fetching active facilities: ${err}`);
  }

  return materials;
}

function isMaterialNeededByActiveFacility(
  itemId: string,
  activeMaterials: ActiveFacilityMaterial[],
): boolean {
  return activeMaterials.some(m => m.itemId === itemId);
}

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
    // Object-keyed recipes
    const values = Object.values(d).filter(v => v && typeof v === "object");
    if (values.length > 0 && Array.isArray(values[0])) {
      // Nested arrays — skip
    } else {
      raw = values as Array<Record<string, unknown>>;
    }
  }

  return raw.map(r => {
    const comps = (r.components || r.ingredients || r.inputs || r.materials || []) as Array<Record<string, unknown>>;

    // outputs may be an array (catalog) or a single object (legacy)
    const rawOutputs = r.outputs || r.output || r.result || r.produces;
    const output: Record<string, unknown> = Array.isArray(rawOutputs)
      ? (rawOutputs[0] as Record<string, unknown>) || {}
      : (rawOutputs as Record<string, unknown>) || {};

    return {
      recipe_id: (r.recipe_id as string) || (r.id as string) || "",
      name: (r.name as string) || (r.recipe_id as string) || "",
      components: comps.map(c => ({
        item_id: (c.item_id as string) || (c.id as string) || (c.item as string) || "",
        name: (c.name as string) || (c.item_name as string) || (c.item_id as string) || (c.id as string) || "",
        quantity: (c.quantity as number) || (c.amount as number) || (c.count as number) || 1,
      })),
      output_item_id: (output.item_id as string) || (output.id as string) || (output.item as string) || (r.output_item_id as string) || "",
      output_name: (output.name as string) || (output.item_name as string) || (r.name as string) || "",
      output_quantity: (output.quantity as number) || (output.amount as number) || (output.count as number) || 1,
      category: (r.category as string) || "",
    };
  }).filter(r => r.recipe_id);
}

/** Fetch all recipes from the catalog API, handling pagination. */
async function fetchAllRecipes(ctx: RoutineContext): Promise<Recipe[]> {
  const { bot } = ctx;
  const all: Recipe[] = [];
  let page = 1;
  const pageSize = 50;

  while (true) {
    const resp = await bot.exec("catalog", { type: "recipes", page, page_size: pageSize });

    if (resp.error) {
      ctx.log("error", `Catalog fetch failed (page ${page}): ${resp.error.message}`);
      break;
    }

    const r = resp.result as Record<string, unknown> | undefined;
    const totalPages = (r?.total_pages as number) || 1;
    const total = (r?.total as number) || 0;

    if (page === 1) {
      ctx.log("info", `${total} recipes loaded`);
    }

    const parsed = parseRecipes(resp.result);
    all.push(...parsed);

    if (page >= totalPages || parsed.length === 0) break;
    page++;
  }

  return all;
}

/** Count how many of an item exist in cargo + storage + faction storage. */
function countItem(ctx: RoutineContext, itemId: string, personalMode: boolean = false): number {
  const { bot } = ctx;
  let total = 0;
  for (const i of bot.inventory) {
    if (i.itemId === itemId) total += i.quantity;
  }
  for (const i of bot.storage) {
    if (i.itemId === itemId) total += i.quantity;
  }
  if (!personalMode) {
    for (const i of bot.factionStorage) {
      if (i.itemId === itemId) total += i.quantity;
    }
  }
  return total;
}

/** Count how many of an item exist in cargo only. */
function countInCargo(ctx: RoutineContext, itemId: string): number {
  let total = 0;
  for (const i of ctx.bot.inventory) {
    if (i.itemId === itemId) total += i.quantity;
  }
  return total;
}

/** Withdraw materials from station storage into cargo for a recipe. */
async function withdrawStorageMaterials(ctx: RoutineContext, recipe: Recipe, batchSize: number = 1): Promise<void> {
  // No-op: crafting automatically pulls from personal storage.
  // Materials in personal storage are already accessible, no need to move to cargo.
  // This function is kept for backward compatibility in call sites.
}

/** Withdraw materials from faction storage into personal storage for a recipe. */
async function withdrawFactionMaterials(ctx: RoutineContext, recipe: Recipe, batchSize: number = 1, personalMode: boolean = false): Promise<void> {
  if (personalMode) return; // No faction access in personal mode
  
  const { bot } = ctx;
  for (const comp of recipe.components) {
    // Check cargo + personal storage (crafting uses both)
    let have = 0;
    for (const i of bot.inventory) {
      if (i.itemId === comp.item_id) have += i.quantity;
    }
    for (const i of bot.storage) {
      if (i.itemId === comp.item_id) have += i.quantity;
    }
    const totalNeeded = comp.quantity * batchSize;
    if (have >= totalNeeded) continue;

    const needed = totalNeeded - have;
    const inFaction = bot.factionStorage.find(i => i.itemId === comp.item_id);
    if (!inFaction || inFaction.quantity <= 0) continue;

    const withdrawQty = Math.min(needed, inFaction.quantity);
    const resp = await bot.exec("storage", { action: "deposit", target: "self", item_id: comp.item_id, quantity: withdrawQty, source: "faction" });
    if (!resp.error) {
      ctx.log("craft", `Withdrew ${withdrawQty}x ${comp.name || comp.item_id} from faction storage`);
      logFactionActivity(ctx, "withdraw", `Withdrew ${withdrawQty}x ${comp.name || comp.item_id} from faction storage`);
      await bot.refreshStorage();
    } else {
      ctx.log("error", `Failed to withdraw ${comp.name || comp.item_id}: ${resp.error?.message}`);
    }
  }
}

/** Check if we have materials in cargo for a recipe. Returns missing item info or null if all present. */
function getMissingMaterial(ctx: RoutineContext, recipe: Recipe, batchSize: number = 1, personalMode: boolean = false): { name: string; need: number; have: number } | null {
  const { bot } = ctx;
  for (const comp of recipe.components) {
    // Crafting pulls from both cargo and personal storage
    let have = 0;
    for (const i of bot.inventory) {
      if (i.itemId === comp.item_id) have += i.quantity;
    }
    for (const i of bot.storage) {
      if (i.itemId === comp.item_id) have += i.quantity;
    }
    if (!personalMode) {
      for (const i of bot.factionStorage) {
        if (i.itemId === comp.item_id) have += i.quantity;
      }
    }
    const totalNeeded = comp.quantity * batchSize;
    if (have < totalNeeded) {
      return { name: comp.name || comp.item_id, need: totalNeeded, have };
    }
  }
  return null;
}

/** Check if materials exist in cargo + personal storage (accessible by craft command). */
function hasMaterialsAccessible(ctx: RoutineContext, recipe: Recipe, batchSize: number = 1, personalMode: boolean = false): boolean {
  const { bot } = ctx;
  for (const comp of recipe.components) {
    let total = 0;
    for (const i of bot.inventory) {
      if (i.itemId === comp.item_id) total += i.quantity;
    }
    for (const i of bot.storage) {
      if (i.itemId === comp.item_id) total += i.quantity;
    }
    if (!personalMode) {
      for (const i of bot.factionStorage) {
        if (i.itemId === comp.item_id) total += i.quantity;
      }
    }
    const needed = comp.quantity * batchSize;
    if (total < needed) return false;
  }
  return true;
}

/** Check if materials exist anywhere (cargo + storage + faction). */
function hasMaterialsAnywhere(ctx: RoutineContext, recipe: Recipe, batchSize: number = 1, personalMode: boolean = false): boolean {
  for (const comp of recipe.components) {
    const total = countItem(ctx, comp.item_id, personalMode);
    const needed = comp.quantity * batchSize;
    if (total < needed) return false;
  }
  return true;
}

/**
 * Calculate the maximum number of times a recipe can be crafted based on available materials.
 * Checks cargo + personal storage (what the craft command can actually access).
 * Returns 0 if any component is missing.
 */
function calculateMaxCraftable(ctx: RoutineContext, recipe: Recipe, personalMode: boolean = false): number {
  const { bot } = ctx;
  let maxCrafts = Infinity;

  for (const comp of recipe.components) {
    // Count in cargo + personal storage only (faction storage not directly accessible by craft command)
    let totalAvailable = 0;
    for (const i of bot.inventory) {
      if (i.itemId === comp.item_id) totalAvailable += i.quantity;
    }
    for (const i of bot.storage) {
      if (i.itemId === comp.item_id) totalAvailable += i.quantity;
    }
    if (!personalMode) {
      // Include faction storage for material availability check
      for (const i of bot.factionStorage) {
        if (i.itemId === comp.item_id) totalAvailable += i.quantity;
      }
    }

    const craftsPossible = Math.floor(totalAvailable / comp.quantity);
    if (craftsPossible < maxCrafts) {
      maxCrafts = craftsPossible;
    }
  }

  return maxCrafts === Infinity ? 0 : maxCrafts;
}

/** Build a lookup: output_item_id → Recipe, so we can find what recipe produces a given item. */
function buildRecipeIndex(recipes: Recipe[]): Map<string, Recipe> {
  const index = new Map<string, Recipe>();
  for (const r of recipes) {
    if (r.output_item_id) {
      index.set(r.output_item_id, r);
    }
  }
  return index;
}

// ── Auto-buy helpers ────────────────────────────────────────

/**
 * Get the base price of an item from the catalog.
 */
function getItemBasePrice(itemId: string): number {
  const item = catalogStore.getItem(itemId);
  return (item?.base_value as number) || 0;
}

/**
 * Get the category of an item from the catalog.
 */
function getItemCategory(itemId: string): string {
  const item = catalogStore.getItem(itemId);
  return (item?.category as string) || "";
}

/**
 * Calculate the maximum price we're willing to pay for an item.
 * Based on base_value * (maxPricePercentOverBase / 100).
 */
function calculateMaxBuyPrice(itemId: string, maxPricePercentOverBase: number): number {
  const basePrice = getItemBasePrice(itemId);
  if (basePrice <= 0) return 0;
  return Math.floor(basePrice * (maxPricePercentOverBase / 100));
}

/**
 * Attempt to buy a missing item from the local station market.
 * Returns the quantity purchased, or 0 if purchase failed.
 */
async function buyMissingItem(
  ctx: RoutineContext,
  itemId: string,
  quantityNeeded: number,
  maxPricePerUnit: number,
  maxTotalSpend: number,
): Promise<number> {
  const { bot } = ctx;

  if (!bot.docked) {
    ctx.log("trade", "Cannot buy items - not docked at station");
    return 0;
  }

  // Check item category exclusions
  const category = getItemCategory(itemId);
  const item = catalogStore.getItem(itemId);
  const itemName = item?.name || itemId;

  // Estimate purchase to get actual market price
  const estResp = await bot.exec("estimate_purchase", { item_id: itemId, quantity: 1 });
  if (estResp.error) {
    ctx.log("trade", `${itemName} not available at this station`);
    return 0;
  }

  const est = estResp.result as Record<string, unknown> | undefined;
  const marketPrice = (est?.unit_price as number) || (est?.price_per_unit as number) || 0;
  const availableQty = (est?.available_quantity as number) || (est?.available as number) || 0;

  if (marketPrice <= 0 || availableQty <= 0) {
    ctx.log("trade", `${itemName} not available or invalid price (${marketPrice}cr)`);
    return 0;
  }

  // Check if price is within our limit
  if (marketPrice > maxPricePerUnit) {
    ctx.log("trade", `${itemName} too expensive: ${marketPrice}cr > max ${maxPricePerUnit}cr (base: ${getItemBasePrice(itemId)}cr)`);
    return 0;
  }

  // Calculate how many we can afford
  const affordableQty = Math.min(
    quantityNeeded,
    availableQty,
    Math.floor(maxTotalSpend / marketPrice),
  );

  if (affordableQty <= 0) {
    ctx.log("trade", `Cannot afford ${itemName} at ${marketPrice}cr each`);
    return 0;
  }

  // Execute purchase
  ctx.log("trade", `Buying ${affordableQty}x ${itemName} @ ${marketPrice}cr = ${affordableQty * marketPrice}cr (max: ${maxPricePerUnit}cr)`);
  const buyResp = await bot.exec("buy", { item_id: itemId, quantity: affordableQty });

  if (buyResp.error) {
    ctx.log("error", `Buy failed: ${buyResp.error.message}`);
    return 0;
  }

  await bot.refreshCargo();
  await bot.refreshStorage();

  const purchased = bot.inventory.find(i => i.itemId === itemId)?.quantity || 0;
  ctx.log("trade", `Purchased ${purchased}x ${itemName}`);

  return purchased;
}

/**
 * Attempt to buy missing materials for a recipe.
 * Returns total credits spent, or 0 if nothing was bought.
 */
async function tryBuyMissingMaterials(
  ctx: RoutineContext,
  recipe: Recipe,
  autoBuySettings: AutoBuySettings,
): Promise<number> {
  const { bot } = ctx;
  let totalSpent = 0;

  if (!bot.docked || !autoBuySettings.enabled) {
    return 0;
  }

  // Check each component
  for (const comp of recipe.components) {
    const have = countItem(ctx, comp.item_id, false);
    if (have >= comp.quantity) continue;

    const needed = comp.quantity - have;
    
    // Skip excluded categories
    const category = getItemCategory(comp.item_id);
    if (autoBuySettings.excludeCategories.includes(category)) {
      ctx.log("trade", `Skipping buy of ${comp.name}: category "${category}" is excluded`);
      continue;
    }

    // Calculate max price
    const maxPrice = calculateMaxBuyPrice(comp.item_id, autoBuySettings.maxPricePercentOverBase);
    if (maxPrice <= 0) {
      ctx.log("trade", `${comp.name}: no base price in catalog, cannot determine max buy price`);
      continue;
    }

    const remainingBudget = autoBuySettings.maxCreditsPerCycle - totalSpent;
    if (remainingBudget <= 0) {
      ctx.log("trade", "Auto-buy budget exhausted for this cycle");
      break;
    }

    // Try to buy
    const purchased = await buyMissingItem(
      ctx,
      comp.item_id,
      needed,
      maxPrice,
      remainingBudget,
    );

    if (purchased > 0) {
      totalSpent += purchased * maxPrice; // Approximate
    }
  }

  return totalSpent;
}

/**
 * Attempt to craft prerequisite materials that a recipe needs.
 * For each missing component, check if there's a recipe to produce it,
 * and if raw materials are available, craft it first.
 * Returns list of items crafted (for logging). Max 2 levels of recursion.
 */
async function craftPrerequisites(
  ctx: RoutineContext,
  recipe: Recipe,
  recipes: Recipe[],
  depth: number = 0,
  personalMode: boolean = false,
): Promise<string[]> {
  if (depth > 2) return []; // prevent infinite recursion
  const { bot } = ctx;
  const crafted: string[] = [];

  for (const comp of recipe.components) {
    const totalAvailable = countItem(ctx, comp.item_id, personalMode);
    if (totalAvailable >= comp.quantity) continue; // have enough

    // Find all recipes that can produce this component, pick the one with most materials
    const allRecipesForComp = recipes.filter(r => r.output_item_id === comp.item_id);
    if (allRecipesForComp.length === 0) continue; // no recipe to craft this item

    // Score each recipe by material availability
    let bestRecipe: Recipe | null = null;
    let bestScore = -Infinity;
    for (const r of allRecipesForComp) {
      // Skip blacklisted recipes
      if (BLACKLISTED_RECIPES.has(r.recipe_id)) continue;

      let score = 0;
      let totalNeeded = 0;
      for (const c of r.components) {
        const have = countItem(ctx, c.item_id, personalMode);
        totalNeeded += c.quantity;
        score += Math.min(have, c.quantity);
      }
      // Prefer recipes where we have more complete materials
      if (totalNeeded > 0) {
        const pctScore = Math.round((score / totalNeeded) * 100);
        score = pctScore;
      } else {
        // No ingredients needed - this is a simple recipe
        score = 50;
      }
      // Apply penalties for undesirable recipes
      if (r.recipe_id in PENALTY_RECIPES) {
        score += PENALTY_RECIPES[r.recipe_id];
      }
      if (score > bestScore) {
        bestScore = score;
        bestRecipe = r;
      }
    }

    if (!bestRecipe) continue;

    const deficit = comp.quantity - totalAvailable;
    const prereqRecipe = bestRecipe;

    // How many batches do we need? (each batch produces output_quantity)
    const batchesNeeded = Math.ceil(deficit / (prereqRecipe.output_quantity || 1));

    // Recursively craft sub-prerequisites first
    const subCrafted = await craftPrerequisites(ctx, prereqRecipe, recipes, depth + 1, personalMode);
    crafted.push(...subCrafted);

      // Refresh inventories after sub-crafting
      await bot.refreshCargo();
      if (bot.docked) {
        await bot.refreshStorage();
        await refreshFactionStorageDirectly(ctx, bot);
      }

    // Check if we can craft the prerequisite now
    const prereqMaterialsExist = hasMaterialsAnywhere(ctx, prereqRecipe, 1, personalMode);
    if (!prereqMaterialsExist) {
      continue;
    }

    // Withdraw materials for the prerequisite
    // First deposit any crafted items in cargo to make space
    for (const item of [...bot.inventory]) {
      if (item.quantity <= 0) continue;
      const lower = item.itemId.toLowerCase();
      if (lower.includes("fuel") || lower.includes("energy_cell")) continue;
      // Don't deposit items we need as components for this prereq
      if (prereqRecipe.components.some(c => c.item_id === item.itemId)) continue;
      // Use unified storage command: deposit from cargo to faction storage
      const dResp = await bot.exec("faction_deposit_items", { faction_id: bot.faction, item_id: item.itemId, quantity: item.quantity, source: "cargo" });
      if (dResp.error) {
        // Fallback: deposit to personal storage
        await bot.exec("deposit_items", { storage_unit_id: bot.poi, item_id: item.itemId, quantity: item.quantity, source: "cargo" });
      }
    }
    await bot.refreshCargo();
    await bot.refreshStatus();

    await withdrawFactionMaterials(ctx, prereqRecipe, 1, personalMode);
    await withdrawStorageMaterials(ctx, prereqRecipe);

    const stillMissing = getMissingMaterial(ctx, prereqRecipe, 1, personalMode);
    if (stillMissing) {
      continue; // can't get all materials into cargo
    }

    // Craft the prerequisite
    for (let batch = 0; batch < batchesNeeded && bot.state === "running"; batch++) {
      const craftResp = await bot.exec("craft", { recipe_id: prereqRecipe.recipe_id, count: 1 });
      if (craftResp.error) {
        break;
      }

      const result = craftResp.result as Record<string, unknown> | undefined;
      let qty = 0;
      if (result) {
        qty = (result.count as number) || (result.quantity as number) || 0;
        if (qty === 0) {
          const items = (result.items as Array<Record<string, unknown>>) ||
                       (result.output as Array<Record<string, unknown>>) ||
                       (result.produced as Array<Record<string, unknown>>);
          if (items && items.length > 0) {
            for (const item of items) {
              qty += (item.quantity as number) || (item.count as number) || 0;
            }
          }
        }
      }
      if (qty === 0) qty = prereqRecipe.output_quantity || 1;

      ctx.log("craft", `Crafted ${qty}x ${prereqRecipe.output_name || prereqRecipe.name}`);
      crafted.push(`${qty}x ${prereqRecipe.output_name || prereqRecipe.name}`);
      bot.stats.totalCrafted += qty;

      // Refresh after each craft to update inventory counts
      await bot.refreshCargo();
      if (bot.docked) {
        await bot.refreshStorage();
        await refreshFactionStorageDirectly(ctx, bot);
      }

      // Re-check if we still need more
      const newTotal = countItem(ctx, comp.item_id, personalMode);
      if (newTotal >= comp.quantity) break;

      // Check if we still have materials for another batch
      const prereqMissing = getMissingMaterial(ctx, prereqRecipe, 1, personalMode);
      if (prereqMissing) {
        // Try to withdraw more materials
        await withdrawFactionMaterials(ctx, prereqRecipe, 1, personalMode);
        await withdrawStorageMaterials(ctx, prereqRecipe);
        if (getMissingMaterial(ctx, prereqRecipe, 1, personalMode)) break;
      }
    }
  }

  return crafted;
}

/**
 * Craft useful items from enabled categories when no specific recipes are configured.
 * Prioritizes valuable outputs (refining, components) over simple XP-grinding recipes.
 * Returns list of items crafted for logging.
 */
async function craftFromCategories(
  ctx: RoutineContext,
  recipes: Recipe[],
  enabledCategories: string[],
  craftingSkillLevel: number,
  personalMode: boolean = false,
): Promise<string[]> {
  const { bot } = ctx;
  const crafted: string[] = [];

  // Priority order for categories - most useful first
  const categoryPriority: Record<string, number> = {
    "Refining": 1,
    "Components": 2,
    "Consumables": 3,
    "Modules": 4,
    "Equipment": 5,
    "Weapons": 6,
    "Defense": 7,
    "Ice Refining": 8,
    "Gas Processing": 9,
    "Electronic Warfare": 10,
    "Stealth": 11,
  };

  // Find recipes we can craft, sorted by category priority then complexity
  const candidates: Array<{ recipe: Recipe; priority: number; complexity: number }> = [];

  // Refresh storage before checking materials to ensure we have fresh data
  if (bot.docked) {
    await bot.refreshStorage();
    if (!personalMode) {
      await refreshFactionStorageDirectly(ctx, bot);
    }
  }



  for (const recipe of recipes) {
    // Only allow recipes from enabled categories
    const recipeCategory = recipe.category || "";
    if (!enabledCategories.includes(recipeCategory)) continue;

    // Skip blacklisted recipes
    if (BLACKLISTED_RECIPES.has(recipe.recipe_id)) continue;

    // Skip recipes with no ingredients
    if (recipe.components.length === 0) continue;
    // Skip recipes that cannot be crafted manually
    if (!isRecipeCraftable(recipe).ok) continue;
    // Skip if we don't have materials
    const hasMats = hasMaterialsAnywhere(ctx, recipe, 1, personalMode);
    if (!hasMats) continue;

    // Calculate material availability score for this recipe
    let materialScore = 0;
    let totalNeeded = 0;
    for (const c of recipe.components) {
      const have = countItem(ctx, c.item_id, personalMode);
      totalNeeded += c.quantity;
      materialScore += Math.min(have, c.quantity);
    }
    let materialPct = totalNeeded > 0 ? Math.round((materialScore / totalNeeded) * 100) : 50;

    // Apply penalties for undesirable recipes
    if (recipe.recipe_id in PENALTY_RECIPES) {
      materialPct += PENALTY_RECIPES[recipe.recipe_id];
    }

    const priority = categoryPriority[recipeCategory] || 99;
    candidates.push({ recipe, priority, complexity: materialPct }); // Use complexity field to store material score
  }

  if (candidates.length === 0) return crafted;

  // Sort by category priority first, then by material availability (higher = better)
  candidates.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return b.complexity - a.complexity; // Higher material score first
  });

  // Deposit non-essential cargo to make space before crafting (only in faction mode)
  if (!personalMode) {
    for (const item of [...bot.inventory]) {
      if (item.quantity <= 0) continue;
      const lower = item.itemId.toLowerCase();
      if (lower.includes("fuel") || lower.includes("energy_cell")) continue;
      const dResp = await bot.exec("faction_deposit_items", { faction_id: bot.faction, item_id: item.itemId, quantity: item.quantity, source: "cargo" });
      if (dResp.error) {
        await bot.exec("deposit_items", { storage_unit_id: bot.poi, item_id: item.itemId, quantity: item.quantity, source: "cargo" });
      }
    }
  }
  await bot.refreshCargo();
  await bot.refreshStatus();

  // Craft up to 10 batches total, iterating through available recipes
  const MAX_CRAFTS = 10;
  let totalCrafted = 0;

  while (totalCrafted < MAX_CRAFTS && bot.state === "running") {
    // Refresh cargo only - storage was already loaded and should persist
    // (refreshStorage would re-query and might lose items from other stations)
    await bot.refreshCargo();
    if (bot.docked && !personalMode) {
      // Only refresh faction storage in faction mode
      await refreshFactionStorageDirectly(ctx, bot);
    }

    // Find the first recipe we can craft
    let target: Recipe | null = null;
    for (const candidate of candidates) {
      if (hasMaterialsAnywhere(ctx, candidate.recipe, 1, personalMode)) {
        target = candidate.recipe;
        break;
      }
    }

    // If there are multiple recipes producing same output, pick the one with best score (including penalties)
    if (target) {
      const outputId = target.output_item_id;
      const targetCandidate = candidates.find(c => c.recipe === target);
      const alternatives = candidates.filter(c => c.recipe.output_item_id === outputId && c.recipe !== target);
      for (const alt of alternatives) {
        if (hasMaterialsAnywhere(ctx, alt.recipe, 1, personalMode)) {
          // Compare using pre-calculated complexity score (includes penalties)
          const targetScore = targetCandidate?.complexity ?? 0;
          const altScore = alt.complexity;
          if (altScore > targetScore) {
            ctx.log("craft", `Switching from ${target.name} to ${alt.recipe.name} (better score: ${altScore} vs ${targetScore})`);
            target = alt.recipe;
          }
        }
      }
    }

    if (!target) {
      ctx.log("info", `No materials available for any recipe in assigned categories. Waiting 60s...`);
      break;
    }

    ctx.log("craft", `Crafting from ${target.category}: ${target.name} (${target.components.map(c => `${c.quantity}x ${c.name}`).join(", ")})...`);

    // Calculate max craftable including faction storage (total available across all locations)
    let maxCraftable = Infinity;
    for (const comp of target.components) {
      let totalAvailable = 0;
      for (const i of bot.inventory) {
        if (i.itemId === comp.item_id) totalAvailable += i.quantity;
      }
      for (const i of bot.storage) {
        if (i.itemId === comp.item_id) totalAvailable += i.quantity;
      }
      if (!personalMode) {
        const inFaction = bot.factionStorage.find(i => i.itemId === comp.item_id);
        if (inFaction) totalAvailable += inFaction.quantity;
      }

      const maxFromThisComp = Math.floor(totalAvailable / comp.quantity);
      if (maxFromThisComp < maxCraftable) {
        maxCraftable = maxFromThisComp;
      }
    }
    if (maxCraftable === Infinity) maxCraftable = 0;

    // Determine batch size: limited by skill level and available materials
    // Note: craftingSkillLevel of 0 still allows crafting 1 at a time
    const maxBatchFromSkill = Math.max(1, craftingSkillLevel);
    const actualBatchSize = Math.min(maxBatchFromSkill, maxCraftable);

    if (actualBatchSize <= 0) {
      ctx.log("warn", `No materials available for ${target.name}, skipping`);
      const idx = candidates.findIndex(c => c.recipe === target);
      if (idx !== -1) candidates.splice(idx, 1);
      if (candidates.length === 0) break;
      continue;
    }

    ctx.log("craft", `Crafting ${actualBatchSize}x ${target.name} (skill: ${craftingSkillLevel}, maxCraftable: ${maxCraftable})...`);
    ctx.log("craft", `Recipe requires: ${target.components.map(c => `${c.quantity}x ${c.name || c.item_id}`).join(', ')}`);

    // Withdraw ALL materials needed for the full batch upfront
    await withdrawFactionMaterials(ctx, target, actualBatchSize, personalMode);
    await bot.refreshStorage();
    await refreshFactionStorageDirectly(ctx, bot);

    // Verify we have materials after withdrawal
    const missing = getMissingMaterial(ctx, target, actualBatchSize, personalMode);
    if (missing) {
      ctx.log("warn", `Missing ${missing.need}x ${missing.name} after withdrawal for ${target.name} (batch: ${actualBatchSize}), skipping`);
      const idx = candidates.findIndex(c => c.recipe === target);
      if (idx !== -1) candidates.splice(idx, 1);
      if (candidates.length === 0) break;
      continue;
    }

    // Craft the full batch
    const craftResp = await bot.exec("craft", { recipe_id: target.recipe_id, count: actualBatchSize });

    if (craftResp.error) {
      ctx.log("error", `craft: ${craftResp.error.message}`);
      // Remove this recipe from candidates and try next
      const idx = candidates.findIndex(c => c.recipe === target);
      if (idx !== -1) candidates.splice(idx, 1);
      if (candidates.length === 0) break;
      continue;
    }

    const result = craftResp.result as Record<string, unknown> | undefined;
    let qty = 0;
    if (result) {
      qty = (result.count as number) || (result.quantity as number) || 0;
      if (qty === 0) {
        const items = (result.items as Array<Record<string, unknown>>) ||
                     (result.output as Array<Record<string, unknown>>) ||
                     (result.produced as Array<Record<string, unknown>>);
        if (items && items.length > 0) {
          for (const item of items) {
            qty += (item.quantity as number) || (item.count as number) || 0;
          }
        }
      }
    }
    if (qty === 0) qty = target.output_quantity || 1;

    ctx.log("craft", `Crafted ${qty}x ${target.output_name || target.name}`);
    crafted.push(`${qty}x ${target.output_name || target.name}`);
    bot.stats.totalCrafted += qty;
    totalCrafted++;

    // Refresh inventories after craft to update material counts
    await bot.refreshStorage();
    await refreshFactionStorageDirectly(ctx, bot);
  }

  return crafted;
}

/** Check if a recipe can be crafted manually (not ship-only or facility-only). */
function isRecipeCraftable(recipe: Recipe): { ok: boolean; reason: string } {
  const category = (recipe.category || "").toLowerCase();

  // Ship Passive recipes run automatically and cannot be crafted manually
  if (category.includes("ship passive")) {
    return { ok: false, reason: "Recipe runs automatically on ships, cannot be crafted manually" };
  }

  // Also check by recipe ID as a fallback (in case category field is missing from API)
  if (SHIP_PASSIVE_RECIPE_IDS.has(recipe.recipe_id)) {
    return { ok: false, reason: "Recipe runs automatically on ships, cannot be crafted manually" };
  }

  // Facility Only recipes can only be crafted at facilities
  if (category.includes("facility only")) {
    return { ok: false, reason: "Recipe can only be crafted at facilities" };
  }

  return { ok: true, reason: "" };
}

// ── Goal-based crafting execution ────────────────────────────

/**
 * Execute a crafting plan by crafting each recipe in order.
 * Supports both batch mode (complete each recipe fully) and round-robin (craft 1 of each in rotation).
 */
async function executeCraftingPlan(
  ctx: RoutineContext,
  planItems: Array<{ recipe: Recipe; quantityToCraft: number; reason: string; depth: number }>,
  craftingSkillLevel: number,
  processingMode: "batch" | "round-robin",
  personalMode: boolean,
  autoBuySettings?: AutoBuySettings,
): Promise<{ crafted: string[]; prereqs: string[] }> {
  const { bot } = ctx;
  const crafted: string[] = [];
  const prereqs: string[] = [];

  ctx.log("craft", `📋 Crafting plan: ${planItems.length} steps (${processingMode} mode)`);

  // Log the plan
  for (const item of planItems) {
    const indent = "  ".repeat(item.depth);
    const itemCount = item.quantityToCraft * (item.recipe.output_quantity || 1);
    ctx.log("craft", `${indent}→ ${item.quantityToCraft}x batches (${itemCount} items): ${item.recipe.name} (${item.reason})`);
  }

  if (processingMode === "batch") {
    // Craft each recipe completely before moving to the next
    for (const planItem of planItems) {
      if (bot.state !== "running") break;

      const result = await craftRecipeWithPrereqs(
        ctx,
        planItem.recipe,
        planItem.quantityToCraft,
        craftingSkillLevel,
        personalMode,
        autoBuySettings,
      );

      if (result.crafted > 0) {
        crafted.push(`${result.crafted}x ${planItem.recipe.output_name}`);
      }
      if (result.prereqsCrafted.length > 0) {
        prereqs.push(...result.prereqsCrafted);
      }
    }
  } else {
    // ── Round-robin: craft in rotation, using full skill-based batches ──
    let iterations = 0;
    const MAX_ITERATIONS = 100; // Safety limit

    while (planItems.some(item => item.quantityToCraft > 0) && iterations < MAX_ITERATIONS && bot.state === "running") {
      iterations++;

      for (const planItem of planItems) {
        if (bot.state !== "running") break;
        
        if (planItem.quantityToCraft <= 0) continue;

        // Calculate batch size: limited by remaining batches and skill level
        const itemsPerBatch = planItem.recipe.output_quantity || 1;
        const maxBatchesByRemaining = planItem.quantityToCraft; // remaining batches
        const maxBatchesBySkill = Math.max(1, Math.floor(craftingSkillLevel || 1));
        
        const batchSize = Math.min(maxBatchesByRemaining, maxBatchesBySkill);

        const result = await craftRecipeWithPrereqs(
          ctx,
          planItem.recipe,
          batchSize,
          craftingSkillLevel,
          personalMode,
          autoBuySettings,
        );

        if (result.crafted > 0) {
          // Subtract batches crafted from our goal
          const itemsCrafted = result.crafted;
          const batchesCompleted = Math.floor(itemsCrafted / itemsPerBatch);
          planItem.quantityToCraft = Math.max(0, planItem.quantityToCraft - batchesCompleted);
          crafted.push(`${itemsCrafted}x ${planItem.recipe.output_name}`);
        }
        if (result.prereqsCrafted.length > 0) {
          prereqs.push(...result.prereqsCrafted);
        }

        // Small delay between crafts in round-robin mode
        if (result.crafted > 0) {
          await ctx.sleep(500);
        }
      }
    }
  }

  return { crafted, prereqs };
}


/**
 * Craft a specific quantity of a recipe, handling prerequisites and material withdrawal.
 * Optionally tries to buy missing materials if auto-buy is enabled.
 */
async function craftRecipeWithPrereqs(
  ctx: RoutineContext,
  recipe: Recipe,
  quantityToCraft: number,
  craftingSkillLevel: number,
  personalMode: boolean,
  autoBuySettings?: AutoBuySettings,
): Promise<{ crafted: number; prereqsCrafted: string[] }> {
  const { bot } = ctx;
  const prereqsCrafted: string[] = [];

  if (quantityToCraft <= 0) {
    return { crafted: 0, prereqsCrafted: [] };
  }

  // quantityToCraft is in BATCHES (from craft-goals.ts planning)
  // targetBatches tracks how many batches we still need to craft
  const targetBatches = quantityToCraft;
  const outputPerBatch = recipe.output_quantity || 1;
  const targetItems = targetBatches * outputPerBatch;

  ctx.log("craft", `Crafting ${targetBatches}x batches (${targetItems} items): ${recipe.name}...`);

  let totalBatchesCrafted = 0;
  let totalItemsCrafted = 0;
  let failedWithdrawals = 0;
  const MAX_FAILED_WITHDRAWALS = 3;
  let totalSpentOnBuys = 0;

  while (totalBatchesCrafted < targetBatches && bot.state === "running" && failedWithdrawals < MAX_FAILED_WITHDRAWALS) {
    // Refresh inventories
    await bot.refreshCargo();
    if (bot.docked) {
      await bot.refreshStorage();
      await refreshFactionStorageDirectly(ctx, bot);
    }

    // Calculate remaining batches and how many we can craft with current materials
    const remainingBatches = targetBatches - totalBatchesCrafted;
    const maxCraftableNow = calculateMaxCraftable(ctx, recipe, personalMode);

    if (maxCraftableNow <= 0) {
      ctx.log("craft", `${recipe.name}: no materials available`);

      // Try auto-buy if enabled and we're docked
      if (autoBuySettings?.enabled && bot.docked && totalSpentOnBuys < autoBuySettings.maxCreditsPerCycle) {
        ctx.log("trade", `${recipe.name}: attempting to buy missing materials...`);
        const boughtSomething = await tryBuyMissingMaterials(ctx, recipe, autoBuySettings);
        if (boughtSomething) {
          ctx.log("trade", `${recipe.name}: successfully bought materials, retrying craft`);
          totalSpentOnBuys += boughtSomething;
          await bot.refreshCargo();
          await bot.refreshStorage();
          continue;
        }
      }

      break;
    }

    // Determine batch size: limited by remaining batches needed, skill level, and available materials
    const maxBatchesByRemaining = remainingBatches;
    const maxBatchesBySkill = Math.max(1, Math.floor(craftingSkillLevel || 1));
    const maxBatchesByMaterials = Math.max(1, Math.floor(maxCraftableNow));

    // Use the minimum of remaining needed, skill level, and available materials
    let batchSize = Math.min(maxBatchesByRemaining, maxBatchesBySkill, maxBatchesByMaterials);
    batchSize = Math.max(1, batchSize);

    ctx.log("craft", `  Batch: ${batchSize}x (skill: ${craftingSkillLevel}, remaining: ${remainingBatches} batches, canCraft: ${maxCraftableNow} batches)`);

    // Withdraw materials for this batch
    await withdrawFactionMaterials(ctx, recipe, batchSize, personalMode);
    await withdrawStorageMaterials(ctx, recipe, batchSize);
    await bot.refreshStorage();

    // Check if we have materials in cargo/storage after withdrawal
    const missingAfterWithdraw = getMissingMaterial(ctx, recipe, batchSize, personalMode);
    if (missingAfterWithdraw) {
      ctx.log("warn", `${recipe.name}: missing ${missingAfterWithdraw.need}x ${missingAfterWithdraw.name} after withdrawal`);

      // Try auto-buy for the missing component if enabled
      if (autoBuySettings?.enabled && bot.docked && totalSpentOnBuys < autoBuySettings.maxCreditsPerCycle) {
        const maxPrice = calculateMaxBuyPrice(missingAfterWithdraw.name, autoBuySettings.maxPricePercentOverBase);
        if (maxPrice > 0) {
          const remainingBudget = autoBuySettings.maxCreditsPerCycle - totalSpentOnBuys;
          const purchased = await buyMissingItem(
            ctx,
            missingAfterWithdraw.name,
            missingAfterWithdraw.need,
            maxPrice,
            remainingBudget,
          );
          if (purchased > 0) {
            totalSpentOnBuys += purchased * maxPrice;
            ctx.log("trade", `Bought ${purchased}x ${missingAfterWithdraw.name}, retrying craft`);
            await bot.refreshCargo();
            await bot.refreshStorage();
            continue;
          }
        }
      }

      failedWithdrawals++;
      if (batchSize === 1) break;
      continue;
    }

    // Small delay after withdrawal
    if (batchSize > 1) {
      await ctx.sleep(300);
    }

    // Execute the craft command
    const craftResp = await bot.exec("craft", { recipe_id: recipe.recipe_id, count: batchSize });

    if (craftResp.error) {
      const msg = craftResp.error.message.toLowerCase();
      if (msg.includes("material") || msg.includes("component") || msg.includes("insufficient")) {
        ctx.log("craft", `${recipe.name}: ran out of materials during craft`);
        failedWithdrawals++;
        continue;
      } else {
        ctx.log("error", `Craft ${recipe.name}: ${craftResp.error.message}`);
        break;
      }
    }

    // Server guarantees at least output_quantity items per batch.
    // Trust batchSize: we crafted exactly batchSize batches, producing at least batchSize * outputPerBatch items.
    let batchesActuallyCrafted = batchSize;
    let itemsActuallyCrafted = batchesActuallyCrafted * outputPerBatch;

    // Log successful craft
    ctx.log("craft", `Crafted ${itemsActuallyCrafted}x ${recipe.output_name || recipe.name}`);

    // Parse actual output for logging (optional) - may include skill bonuses
    const result = craftResp.result as Record<string, unknown> | undefined;
    if (result) {
      const parsedCount = (result.count as number) || (result.quantity as number) || 0;
      if (parsedCount > itemsActuallyCrafted) {
        // Bonus items detected
        itemsActuallyCrafted = parsedCount;
        batchesActuallyCrafted = Math.floor(itemsActuallyCrafted / outputPerBatch);
        ctx.log("craft", `Bonus items: crafted ${itemsActuallyCrafted}x (expected ${batchSize * outputPerBatch}x)`);
      } else if (parsedCount > 0 && parsedCount < itemsActuallyCrafted) {
        // This shouldn't happen per server guarantee, but log if it does
        ctx.log("warn", `Unexpected low output: ${parsedCount}x (expected at least ${itemsActuallyCrafted}x)`);
      } else {
        // Try to parse from items array
        const items = (result.items as Array<Record<string, unknown>>) ||
                     (result.output as Array<Record<string, unknown>>) ||
                     (result.produced as Array<Record<string, unknown>>);
        if (items && items.length > 0) {
          let totalFromArray = 0;
          for (const item of items) {
            totalFromArray += (item.quantity as number) || (item.count as number) || 0;
          }
          if (totalFromArray > itemsActuallyCrafted) {
            itemsActuallyCrafted = totalFromArray;
            batchesActuallyCrafted = Math.floor(itemsActuallyCrafted / outputPerBatch);
            ctx.log("craft", `Bonus items from array: ${itemsActuallyCrafted}x`);
          }
        }
      }
    }

    // Cap at targetBatches to avoid exceeding the goal
    const overshootBatches = (totalBatchesCrafted + batchesActuallyCrafted) - targetBatches;
    if (overshootBatches > 0) {
      batchesActuallyCrafted -= overshootBatches;
      itemsActuallyCrafted = batchesActuallyCrafted * outputPerBatch;
      ctx.log("craft", `Capped output to target: ${batchesActuallyCrafted} batches (${itemsActuallyCrafted} items)`);
    }

    totalBatchesCrafted += batchesActuallyCrafted;
    totalItemsCrafted += itemsActuallyCrafted;
    bot.stats.totalCrafted += itemsActuallyCrafted;

    // Progress logging - show both batches and items
    const batchPct = Math.round((totalBatchesCrafted / targetBatches) * 100);
    const itemPct = Math.round((totalItemsCrafted / targetItems) * 100);
    ctx.log("craft", `${recipe.name}: ${totalItemsCrafted}/${targetItems} items (${itemPct}%) - produced ${itemsActuallyCrafted}x (${totalBatchesCrafted}/${targetBatches} batches, ${batchPct}%)`);

    // Refresh after craft
    await bot.refreshCargo();
    if (bot.docked) {
      await bot.refreshStorage();
      await refreshFactionStorageDirectly(ctx, bot);
    }
  }

  return { crafted: totalItemsCrafted, prereqsCrafted };
}

// ── Crafter routine ──────────────────────────────────────────

/**
 * Crafter routine — maintains stock of crafted/refined items:
 *
 * 1. Dock at station
 * 2. Fetch recipes and inventory
 * 3. For each configured recipe with a limit:
 *    - Count current stock (cargo + storage) of output item
 *    - If below limit, craft until limit reached or materials exhausted
 * 4. Refuel, repair
 * 5. Wait, then repeat
 */
export const crafterRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  await bot.refreshStatus();

  while (bot.state === "running") {
    // Clear facility cache at start of each cycle
    cachedActiveFacilityMaterials = [];

    // ── Death recovery ──
    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) { await ctx.sleep(30000); continue; }

    const settings = getCrafterSettings();

    // ── Scavenge wrecks before docking ──
    yield "scavenge";
    await scavengeWrecks(ctx);

    // ── Dock at station ──
    yield "dock";
    await bot.refreshStatus();
    await ensureDocked(ctx);

    // ── Fetch recipes via catalog ──
    yield "fetch_recipes";
    const recipes = await fetchAllRecipes(ctx);
    if (recipes.length === 0) {
      ctx.log("error", "No recipes available — waiting 60s");
      await ctx.sleep(10000);
      continue;
    }

    // ── Refresh skills (for crafting skill level tracking) ──
    yield "check_skills";
    await bot.checkSkills();

    // ── Get crafting skill level (determines max craft quantity per command) ──
    const craftingSkillLevel = bot.getSkillLevel("crafting");

    // ── Detect faction membership early ──
    // Check if bot is in a faction by attempting to view faction storage
    let personalMode = false;
    if (bot.docked) {
      const factionResp = await bot.exec("view_storage", { target: "faction" });
      personalMode = !!factionResp.error;
    } else {
      personalMode = true;
    }

    // ── Clear cargo space for material withdrawal ──
    await bot.refreshCargo();
    if (bot.docked && bot.inventory.length > 0) {
      for (const item of [...bot.inventory]) {
        if (item.quantity <= 0) continue;
        const lower = item.itemId.toLowerCase();
        if (lower.includes("fuel") || lower.includes("energy_cell")) continue;
        // In faction mode, try faction storage first; in personal mode, use personal storage directly
      // In faction mode, try faction storage first; in personal mode, use personal storage directly
        if (!personalMode) {
          const dResp = await bot.exec("faction_deposit_items", { faction_id: bot.faction, item_id: item.itemId, quantity: item.quantity, source: "cargo" });
          if (dResp.error) {
            await bot.exec("deposit_items", { storage_unit_id: bot.poi, item_id: item.itemId, quantity: item.quantity, source: "cargo" });
          }
        } else {
          await bot.exec("deposit_items", { storage_unit_id: bot.poi, item_id: item.itemId, quantity: item.quantity, source: "cargo" });
        }
      }
      await bot.refreshCargo();
      await bot.refreshStatus();
    }

    // ── Refresh inventory (cargo + personal storage + faction storage) ──
    if (bot.docked) {
      await bot.refreshStorage();
      if (!personalMode) {
        // Successfully accessed faction storage - bot is in a faction
        await refreshFactionStorageDirectly(ctx, bot);
        ctx.log("craft", `FACTION MODE: Bot is in a faction, using faction storage`);
      } else {
        // Failed to access faction storage - bot is not in a faction
        bot.factionStorage = [];
        ctx.log("craft", `PERSONAL MODE: Bot is not in a faction, using only personal storage`);
      }
    } else {
      ctx.log("craft", `PERSONAL MODE: Bot is not docked, using only personal storage`);
    }

    // ── Build recipe index for prerequisite lookup ──
    const recipeIndex = buildRecipeIndex(recipes);

    // ── Determine which categories this bot should craft from ──
    const botName = bot.username;
    const assignedCategories = settings.categoryAssignments[botName];
    const isSpecializedBot = assignedCategories && assignedCategories.length > 0;

    if (isSpecializedBot) {
      ctx.log("craft", `Bot is assigned to categories: ${assignedCategories.join(", ")}`);
    }

    // ── Determine effective quotas for this bot (global + bot-specific overrides) ──
    const effectiveQuotas = new Map<string, number>();
    // First, add global quotas
    for (const { recipeId, limit } of settings.craftLimits) {
      effectiveQuotas.set(recipeId, limit);
    }
    // Then apply bot-specific overrides
    const botOverrides = settings.botQuotaOverrides[botName] || {};
    for (const [recipeId, limit] of Object.entries(botOverrides)) {
      if (limit > 0) {
        effectiveQuotas.set(recipeId, limit);
      } else {
        effectiveQuotas.delete(recipeId);
      }
    }

    // ── Refresh faction storage before goal calculation (ensure fresh data) ──
    if (bot.docked && !personalMode) {
      await refreshFactionStorageDirectly(ctx, bot);

    }

    // ── Build list of goal items to craft ──
    ctx.log("craft", `🎯 Processing ${effectiveQuotas.size} crafting goals...`);
    const goalItems: Array<{ itemId: string; quantity: number; recipe: Recipe }> = [];

    for (const [recipeId, limit] of Array.from(effectiveQuotas.entries())) {
      if (bot.state !== "running") break;

      // Find the recipe - user can specify either recipe_id or output item name
      const recipe = recipes.find(r =>
        r.recipe_id === recipeId ||
        r.name === recipeId ||
        r.name.toLowerCase() === recipeId.toLowerCase() ||
        r.output_item_id === recipeId ||
        r.output_item_id.toLowerCase() === recipeId.toLowerCase()
      );

      if (!recipe) {
        const similar = recipes
          .filter(r => r.recipe_id.toLowerCase().includes(recipeId.toLowerCase()) || r.name.toLowerCase().includes(recipeId.toLowerCase()))
          .slice(0, 5)
          .map(r => `${r.recipe_id} (${r.name})`);
        ctx.log("error", `Recipe "${recipeId}" not found${similar.length > 0 ? ` — similar: ${similar.join(", ")}` : ""}`);
        continue;
      }

      // Skip recipes that cannot be crafted manually (ship-only or facility-only)
      const craftableCheck = isRecipeCraftable(recipe);
      if (!craftableCheck.ok) {
        if (craftableCheck.reason.includes("automatically on ships")) {
          ctx.log("warn", `Skipping "${recipeId}" (${recipe.name}): ${craftableCheck.reason}`);
        } else {
          ctx.log("error", `Recipe "${recipeId}" (${recipe.name}) is not craftable: ${craftableCheck.reason}`);
        }
        continue;
      }

      // Check if recipe matches bot's assigned categories
      const recipeCategory = recipe.category || "";
      if (isSpecializedBot && !assignedCategories.includes(recipeCategory)) {
        ctx.log("craft", `Skipping "${recipeId}" (${recipe.name}): category "${recipeCategory}" not assigned to this bot`);
        continue;
      }

      // Check current stock of the output item
      const currentStock = countItem(ctx, recipe.output_item_id, personalMode);
      const needed = limit - currentStock;



      if (needed <= 0) {
        ctx.log("craft", `✓ ${recipe.name}: already have ${currentStock}/${limit} (goal met)`);
        continue;
      }

      ctx.log("craft", `🎯 Goal: ${needed}x ${recipe.name} (have ${currentStock}/${limit})`);
      // Show inventory breakdown for transparency
      if (!personalMode) {
        const facItem = bot.factionStorage.find(i => i.itemId === recipe.output_item_id);
        const storageItem = bot.storage.find(i => i.itemId === recipe.output_item_id);
        const cargoItem = ctx.bot.inventory.find(i => i.itemId === recipe.output_item_id);
        const cargoQty = cargoItem?.quantity || 0;
        const storageQty = storageItem?.quantity || 0;
        const factionQty = facItem?.quantity || 0;
        ctx.log("craft", `   Inventory: cargo=${cargoQty}, storage=${storageQty}, faction=${factionQty} (total: ${currentStock})`);
      }
      goalItems.push({ itemId: recipe.output_item_id, quantity: needed, recipe });
    }

    // ── If no goals configured, craft from enabled categories ──
    if (goalItems.length === 0 && !isSpecializedBot) {
      ctx.log("craft", `No goal items configured — crafting from enabled categories: ${settings.enabledCategories.join(", ")}`);
      const categoryCrafted = await craftFromCategories(ctx, recipes, settings.enabledCategories, craftingSkillLevel, personalMode);
      if (categoryCrafted.length > 0) {
        ctx.log("craft", `Crafted: ${categoryCrafted.join(", ")}`);
      } else {
        ctx.log("info", `No materials available for enabled categories. Waiting 60s...`);
        await ctx.sleep(60000);
      }
      continue;
    }

    // ── If no goals match assigned categories, craft from assigned categories ──
    if (goalItems.length === 0 && isSpecializedBot) {
      ctx.log("craft", `No goal items match assigned categories — crafting from assigned categories: ${assignedCategories.join(", ")}`);
      const categoryCrafted = await craftFromCategories(ctx, recipes, assignedCategories, craftingSkillLevel, personalMode);
      if (categoryCrafted.length > 0) {
        ctx.log("craft", `Crafted: ${categoryCrafted.join(", ")}`);
      } else {
        ctx.log("info", `No materials available for assigned categories. Waiting 60s...`);
        await ctx.sleep(60000);
      }
      continue;
    }

    // ── Calculate crafting plans for all goal items ──
    ctx.log("craft", `════════════════════════════════════════`);
    ctx.log("craft", `📋 GOAL-BASED CRAFTING PLAN`);
    ctx.log("craft", `════════════════════════════════════════`);

    // Refresh faction storage again before plan calculation (ensure fresh data)
    if (bot.docked && !personalMode) {
      await refreshFactionStorageDirectly(ctx, bot);
    }

    const plans = calculateMultiGoalPlan(
      goalItems.map(g => ({ itemId: g.itemId, quantity: g.quantity, recipe: g.recipe })),
      recipes,
      (itemId) => countItem(ctx, itemId, personalMode),
    );

    ctx.log("craft", `📋 Generated ${plans.length} crafting plans for ${goalItems.length} goals`);

    // Combine all plan items into a single execution list
    const allPlanItems: Array<{ recipe: Recipe; quantityToCraft: number; reason: string; depth: number }> = [];

    for (const plan of plans) {
      ctx.log("craft", "");
      ctx.log("craft", formatCraftingPlan(plan));
      
      for (const item of plan.flatOrder) {
        // Ensure quantityToCraft is always an integer >= 1
        const qty = Math.max(1, Math.floor(item.quantityToCraft));
        allPlanItems.push({
          recipe: item.recipe,
          quantityToCraft: qty,
          reason: item.reason,
          depth: item.depth,
        });
      }
    }

    if (allPlanItems.length === 0) {
      ctx.log("info", "No crafting goals to execute. Waiting 60s...");
      await ctx.sleep(60000);
      continue;
    }

    // Execute the crafting plan
    ctx.log("craft", `Executing crafting plan in ${settings.goalProcessingMode} mode`);
    const result = await executeCraftingPlan(
      ctx,
      allPlanItems,
      craftingSkillLevel,
      settings.goalProcessingMode,
      personalMode,
      settings.autoBuy,
    );

    const { crafted: craftedSummary, prereqs: prereqSummary } = result;

    // ── Summary logging ──
    const atLimitCount = { count: goalItems.filter(g => {
      const currentStock = countItem(ctx, g.itemId, personalMode);
      return currentStock >= g.quantity;
    }).length };

    // ── Summary line ──
    const parts: string[] = [];
    if (craftedSummary.length > 0) parts.push(`Crafted ${craftedSummary.join(", ")}`);
    if (prereqSummary.length > 0) parts.push(`Prereqs: ${prereqSummary.join(", ")}`);
    if (atLimitCount.count > 0) parts.push(`${atLimitCount.count} goals at limit`);
    if (parts.length > 0) {
      ctx.log("craft", parts.join(". "));
    } else {
      ctx.log("craft", "Nothing to craft");
    }

    // ── Get active facility materials before deposit ─────────────────────
    let activeFacilityMaterials: ActiveFacilityMaterial[] = [];
    if (bot.docked && !personalMode) {
      activeFacilityMaterials = await getActivePlayerFacilityMaterials(ctx, recipes);
    }

    // ── Deposit crafted goods to faction storage (only if in faction mode) ──
    if (bot.docked && !personalMode) {
      await bot.refreshCargo();
      await bot.refreshStorage();
      const depositedItems: string[] = [];
      const skippedForFacility: string[] = [];

      // First, deposit all crafted items from cargo to faction storage
      for (const item of [...bot.inventory]) {
        if (item.quantity <= 0) continue;
        
        if (isMaterialNeededByActiveFacility(item.itemId, activeFacilityMaterials)) {
          skippedForFacility.push(`${item.quantity}x ${item.name}`);
          continue;
        }
        
        const dResp = await bot.exec("faction_deposit_items", { faction_id: bot.faction, item_id: item.itemId, quantity: item.quantity, source: "cargo" });
        if (!dResp.error) {
          depositedItems.push(`${item.quantity}x ${item.name} (crafted)`);
          logFactionActivity(ctx, "deposit", `Deposited ${item.quantity}x ${item.name} (crafted)`);
        } else {
          await bot.exec("deposit_items", { storage_unit_id: bot.poi, item_id: item.itemId, quantity: item.quantity, source: "cargo" });
        }
      }

        // Transfer items from personal storage to faction storage (skip materials needed by active facilities)
      await bot.refreshStorage();
      for (const item of [...bot.storage]) {
        if (item.quantity <= 0) continue;
        
        if (isMaterialNeededByActiveFacility(item.itemId, activeFacilityMaterials)) {
          skippedForFacility.push(`${item.quantity}x ${item.name}`);
          continue;
        }

        const transferResp = await bot.exec("faction_deposit_items", { faction_id: bot.faction, item_id: item.itemId, quantity: item.quantity, source: "storage" });
        if (!transferResp.error) {
          depositedItems.push(`${item.quantity}x ${item.name} (from storage)`);
          logFactionActivity(ctx, "deposit", `Transferred ${item.quantity}x ${item.name} from personal storage to faction storage`);
        }
      }

      if (depositedItems.length > 0) {
        ctx.log("trade", `Deposited to faction: ${depositedItems.join(", ")}`);
      }
      if (skippedForFacility.length > 0) {
        ctx.log("craft", `Kept for active facilities: ${skippedForFacility.join(", ")}`);
      }
      await bot.refreshCargo();
      await bot.refreshStorage();
    } else if (bot.docked && personalMode) {
      ctx.log("craft", `PERSONAL MODE: Skipping faction deposit (bot not in faction)`);
    }

    // ── Refuel + Repair ──
    yield "refuel";
    await ensureFueled(ctx, settings.refuelThreshold);
    yield "repair";
    await repairShip(ctx);

    // ── Credit top-up: ensure all running bots have at least 10k credits ──
    yield "topup_credits";
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

    // ── Check for skill level-ups ──
    yield "check_skills";
    await bot.checkSkills();

    // ── Wait before next cycle ──
    ctx.log("info", "Waiting 60s before next crafting cycle...");
    await ctx.sleep(10000);
  }
};
