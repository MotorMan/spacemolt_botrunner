import type { Routine, RoutineContext } from "../bot.js";
import {
  ensureDocked,
  tryRefuel,
  repairShip,
  ensureFueled,
  detectAndRecoverFromDeath,
  readSettings,
  scavengeWrecks,
  sleep,
  logFactionActivity,
} from "./common.js";
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

/** Ship Passive recipe IDs that run automatically and cannot be crafted manually. */
const SHIP_PASSIVE_RECIPE_IDS = new Set([
  "onboard_alloy_synthesis",
  "onboard_munitions_fabrication",
]);

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
  return {
    craftLimits,
    enabledCategories,
    refuelThreshold: (c.refuelThreshold as number) || 50,
    repairThreshold: (c.repairThreshold as number) || 40,
    categoryAssignments,
    botQuotaOverrides,
    goalProcessingMode,
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

/**
 * Attempt to craft prerequisite materials that a recipe needs.
 * For each missing component, check if there's a recipe to produce it,
 * and if raw materials are available, craft it first.
 * Returns list of items crafted (for logging). Max 2 levels of recursion.
 */
async function craftPrerequisites(
  ctx: RoutineContext,
  recipe: Recipe,
  recipeIndex: Map<string, Recipe>,
  depth: number = 0,
  personalMode: boolean = false,
): Promise<string[]> {
  if (depth > 2) return []; // prevent infinite recursion
  const { bot } = ctx;
  const crafted: string[] = [];

  for (const comp of recipe.components) {
    const totalAvailable = countItem(ctx, comp.item_id, personalMode);
    if (totalAvailable >= comp.quantity) continue; // have enough

    const deficit = comp.quantity - totalAvailable;
    const prereqRecipe = recipeIndex.get(comp.item_id);
    if (!prereqRecipe) {
      // DEBUG: No recipe found to craft this component
      // ctx.log("craft", `  No recipe found to craft ${comp.name || comp.item_id}`);
      continue; // no recipe to craft this item
    }

    // How many batches do we need? (each batch produces output_quantity)
    const batchesNeeded = Math.ceil(deficit / (prereqRecipe.output_quantity || 1));

    // Recursively craft sub-prerequisites first
    const subCrafted = await craftPrerequisites(ctx, prereqRecipe, recipeIndex, depth + 1, personalMode);
    crafted.push(...subCrafted);

    // Refresh inventories after sub-crafting
    await bot.refreshCargo();
    if (bot.docked) {
      await bot.refreshStorage();
      await bot.refreshFactionStorage();
    }

    // Check if we can craft the prerequisite now
    const prereqMaterialsExist = hasMaterialsAnywhere(ctx, prereqRecipe, 1, personalMode);
    if (!prereqMaterialsExist) {
      // DEBUG: Raw materials not available
      // ctx.log("craft", `  Cannot craft ${prereqRecipe.name}: raw materials not available anywhere`);
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
      const dResp = await bot.exec("storage", { action: "deposit", target: "faction", item_id: item.itemId, quantity: item.quantity, source: "cargo" });
      if (dResp.error) {
        // Fallback: deposit to personal storage
        await bot.exec("storage", { action: "deposit", target: "self", item_id: item.itemId, quantity: item.quantity, source: "cargo" });
      }
    }
    await bot.refreshCargo();
    await bot.refreshStatus();

    await withdrawFactionMaterials(ctx, prereqRecipe, 1, personalMode);
    await withdrawStorageMaterials(ctx, prereqRecipe);

    const stillMissing = getMissingMaterial(ctx, prereqRecipe, 1, personalMode);
    if (stillMissing) {
      // DEBUG: Still missing materials after withdrawal
      // ctx.log("craft", `  Cannot craft ${prereqRecipe.name}: still missing ${stillMissing.need}x ${stillMissing.name} after withdrawal`);
      continue; // can't get all materials into cargo
    }

    // Craft the prerequisite
    for (let batch = 0; batch < batchesNeeded && bot.state === "running"; batch++) {
      const craftResp = await bot.exec("craft", { recipe_id: prereqRecipe.recipe_id, count: 1 });
      if (craftResp.error) {
        // DEBUG: Craft failed
        // ctx.log("craft", `  Failed to craft ${prereqRecipe.name}: ${craftResp.error?.message}`);
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

      crafted.push(`${qty}x ${prereqRecipe.output_name || prereqRecipe.name}`);
      bot.stats.totalCrafted += qty;

      // Refresh after each craft to update inventory counts
      await bot.refreshCargo();
      if (bot.docked) {
        await bot.refreshStorage();
        await bot.refreshFactionStorage();
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
  recipeIndex: Map<string, Recipe>,
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
      await bot.refreshFactionStorage();
    }
  }

  // Debug: log storage counts
  ctx.log("craft", `PERSONAL MODE ${personalMode}: Storage has ${bot.storage.length} items, Cargo has ${bot.inventory.length} items`);
  if (bot.storage.length > 0) {
    const sampleItems = bot.storage.slice(0, 5).map(i => `${i.name} (${i.itemId}) [${i.quantity}]`).join(", ");
    ctx.log("craft", `Storage sample: ${sampleItems}${bot.storage.length > 5 ? "..." : ""}`);
  }

  for (const recipe of recipes) {
    // Only allow recipes from enabled categories
    const recipeCategory = recipe.category || "";
    if (!enabledCategories.includes(recipeCategory)) continue;

    // Skip recipes with no ingredients
    if (recipe.components.length === 0) continue;
    // Skip recipes that cannot be crafted manually
    if (!isRecipeCraftable(recipe).ok) continue;
    // Skip if we don't have materials
    const hasMats = hasMaterialsAnywhere(ctx, recipe, 1, personalMode);
    if (!hasMats) continue;

    const priority = categoryPriority[recipeCategory] || 99;
    const complexity = recipe.components.reduce((sum, c) => sum + c.quantity, 0);
    candidates.push({ recipe, priority, complexity });
  }

  if (candidates.length === 0) return crafted;

  // Sort by category priority first, then by complexity (prefer simpler within same category)
  candidates.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.complexity - b.complexity;
  });

  // Deposit non-essential cargo to make space before crafting (only in faction mode)
  if (!personalMode) {
    for (const item of [...bot.inventory]) {
      if (item.quantity <= 0) continue;
      const lower = item.itemId.toLowerCase();
      if (lower.includes("fuel") || lower.includes("energy_cell")) continue;
      const dResp = await bot.exec("storage", { action: "deposit", target: "faction", item_id: item.itemId, quantity: item.quantity, source: "cargo" });
      if (dResp.error) {
        await bot.exec("storage", { action: "deposit", target: "self", item_id: item.itemId, quantity: item.quantity, source: "cargo" });
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
      await bot.refreshFactionStorage();
    }

    // Find the first recipe we can craft
    let target: Recipe | null = null;
    for (const candidate of candidates) {
      if (hasMaterialsAnywhere(ctx, candidate.recipe, 1, personalMode)) {
        target = candidate.recipe;
        break;
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

    // Withdraw ALL materials needed for the full batch upfront
    await withdrawFactionMaterials(ctx, target, actualBatchSize, personalMode);
    await bot.refreshStorage();
    await bot.refreshFactionStorage();

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

    crafted.push(`${qty}x ${target.output_name || target.name}`);
    bot.stats.totalCrafted += qty;
    totalCrafted++;

    // Refresh inventories after craft to update material counts
    await bot.refreshStorage();
    await bot.refreshFactionStorage();
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
): Promise<{ crafted: string[]; prereqs: string[] }> {
  const { bot } = ctx;
  const crafted: string[] = [];
  const prereqs: string[] = [];

  ctx.log("craft", `📋 Crafting plan: ${planItems.length} steps (${processingMode} mode)`);

  // Log the plan
  for (const item of planItems) {
    const indent = "  ".repeat(item.depth);
    ctx.log("craft", `${indent}→ ${item.quantityToCraft}x ${item.recipe.name} (${item.reason})`);
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
      );

      if (result.crafted > 0) {
        crafted.push(`${result.crafted}x ${planItem.recipe.output_name}`);
      }
      if (result.prereqsCrafted.length > 0) {
        prereqs.push(...result.prereqsCrafted);
      }
    }
  } else {
    // Round-robin: craft 1 batch of each recipe in rotation until all are done
    const remaining = (planItem: { recipe: Recipe; quantityToCraft: number }) => {
      return planItem.quantityToCraft > 0;
    };

    let iterations = 0;
    const MAX_ITERATIONS = 100; // Safety limit

    while (planItems.some(remaining) && iterations < MAX_ITERATIONS && bot.state === "running") {
      iterations++;

      for (const planItem of planItems) {
        if (bot.state !== "running") break;
        if (planItem.quantityToCraft <= 0) continue;

        // Craft one batch at a time
        const batchSize = Math.min(planItem.quantityToCraft, craftingSkillLevel || 1);

        const result = await craftRecipeWithPrereqs(
          ctx,
          planItem.recipe,
          batchSize,
          craftingSkillLevel,
          personalMode,
        );

        if (result.crafted > 0) {
          planItem.quantityToCraft -= result.crafted / (planItem.recipe.output_quantity || 1);
          if (planItem.quantityToCraft <= 0) planItem.quantityToCraft = 0;
          crafted.push(`${result.crafted}x ${planItem.recipe.output_name}`);
        }
        if (result.prereqsCrafted.length > 0) {
          prereqs.push(...result.prereqsCrafted);
        }

        // Small delay between crafts in round-robin mode
        if (result.crafted > 0) {
          await sleep(500);
        }
      }
    }
  }

  return { crafted, prereqs };
}

/**
 * Craft a specific quantity of a recipe, handling prerequisites and material withdrawal.
 */
async function craftRecipeWithPrereqs(
  ctx: RoutineContext,
  recipe: Recipe,
  quantityToCraft: number,
  craftingSkillLevel: number,
  personalMode: boolean,
): Promise<{ crafted: number; prereqsCrafted: string[] }> {
  const { bot } = ctx;
  const prereqsCrafted: string[] = [];

  if (quantityToCraft <= 0) {
    return { crafted: 0, prereqsCrafted: [] };
  }

  ctx.log("craft", `Crafting ${quantityToCraft}x ${recipe.name}...`);

  let totalCrafted = 0;
  let failedWithdrawals = 0;
  const MAX_FAILED_WITHDRAWALS = 3;

  while (totalCrafted < quantityToCraft && bot.state === "running" && failedWithdrawals < MAX_FAILED_WITHDRAWALS) {
    // Refresh inventories
    await bot.refreshCargo();
    if (bot.docked) {
      await bot.refreshStorage();
      await bot.refreshFactionStorage();
    }

    // Calculate remaining to craft and how many we can craft with current materials
    const remaining = quantityToCraft - totalCrafted;
    const maxCraftableNow = calculateMaxCraftable(ctx, recipe, personalMode);

    if (maxCraftableNow <= 0) {
      ctx.log("craft", `${recipe.name}: no materials, checking prerequisites...`);
      // Note: With goal-based crafting, prerequisites should already be in the plan
      // This is a fallback for edge cases
      break;
    }

    // Determine batch size: min of (remaining, maxCraftableNow, craftingSkillLevel)
    const batchSize = Math.min(remaining, maxCraftableNow, craftingSkillLevel || 1);
    if (batchSize <= 0) break;

    ctx.log("craft", `  Batch: ${batchSize}x (skill: ${craftingSkillLevel}, remaining: ${remaining}, canCraft: ${maxCraftableNow})`);

    // Withdraw materials for this batch
    await withdrawFactionMaterials(ctx, recipe, batchSize, personalMode);
    await withdrawStorageMaterials(ctx, recipe, batchSize);
    await bot.refreshStorage();

    // Check if we have materials in cargo/storage after withdrawal
    const missingAfterWithdraw = getMissingMaterial(ctx, recipe, batchSize, personalMode);
    if (missingAfterWithdraw) {
      ctx.log("warn", `${recipe.name}: missing ${missingAfterWithdraw.need}x ${missingAfterWithdraw.name} after withdrawal`);
      failedWithdrawals++;
      if (batchSize === 1) break;
      continue;
    }

    // Small delay after withdrawal
    if (batchSize > 1) {
      await sleep(300);
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

    // Parse actual output quantity from craft response
    const result = craftResp.result as Record<string, unknown> | undefined;
    let actualOutputQty = 0;
    if (result) {
      actualOutputQty = (result.count as number) || (result.quantity as number) || 0;
      if (actualOutputQty === 0) {
        const items = (result.items as Array<Record<string, unknown>>) ||
                     (result.output as Array<Record<string, unknown>>) ||
                     (result.produced as Array<Record<string, unknown>>);
        if (items && items.length > 0) {
          for (const item of items) {
            actualOutputQty += (item.quantity as number) || (item.count as number) || 0;
          }
        }
      }
      if (actualOutputQty === 0) {
        actualOutputQty = (recipe.output_quantity || 1) * batchSize;
      }
    } else {
      actualOutputQty = (recipe.output_quantity || 1) * batchSize;
    }

    const batchesCompleted = Math.ceil(actualOutputQty / (recipe.output_quantity || 1));
    totalCrafted += batchesCompleted;
    bot.stats.totalCrafted += actualOutputQty;

    // Progress logging
    const pct = Math.round((totalCrafted / quantityToCraft) * 100);
    ctx.log("craft", `${recipe.name}: ${totalCrafted}/${quantityToCraft} (${pct}%) - produced ${actualOutputQty}x`);

    // Refresh after craft
    await bot.refreshCargo();
    if (bot.docked) {
      await bot.refreshStorage();
      await bot.refreshFactionStorage();
    }
  }

  return { crafted: totalCrafted, prereqsCrafted };
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
    // ── Death recovery ──
    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) { await sleep(30000); continue; }

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
      await sleep(10000);
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
      const factionResp = await bot.exec("view_faction_storage");
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
        if (!personalMode) {
          const dResp = await bot.exec("storage", { action: "deposit", target: "faction", item_id: item.itemId, quantity: item.quantity, source: "cargo" });
          if (dResp.error) {
            await bot.exec("storage", { action: "deposit", target: "self", item_id: item.itemId, quantity: item.quantity, source: "cargo" });
          }
        } else {
          await bot.exec("storage", { action: "deposit", target: "self", item_id: item.itemId, quantity: item.quantity, source: "cargo" });
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
        await bot.refreshFactionStorage();
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

    // ── Build list of goal items to craft ──
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
      goalItems.push({ itemId: recipe.output_item_id, quantity: needed, recipe });
    }

    // ── If no goals configured, craft from enabled categories ──
    if (goalItems.length === 0 && !isSpecializedBot) {
      ctx.log("craft", `No goal items configured — crafting from enabled categories: ${settings.enabledCategories.join(", ")}`);
      const categoryCrafted = await craftFromCategories(ctx, recipes, recipeIndex, settings.enabledCategories, craftingSkillLevel, personalMode);
      if (categoryCrafted.length > 0) {
        ctx.log("craft", `Crafted: ${categoryCrafted.join(", ")}`);
      } else {
        ctx.log("info", `No materials available for enabled categories. Waiting 60s...`);
        await sleep(60000);
      }
      continue;
    }

    // ── If no goals match assigned categories, craft from assigned categories ──
    if (goalItems.length === 0 && isSpecializedBot) {
      ctx.log("craft", `No goal items match assigned categories — crafting from assigned categories: ${assignedCategories.join(", ")}`);
      const categoryCrafted = await craftFromCategories(ctx, recipes, recipeIndex, assignedCategories, craftingSkillLevel, personalMode);
      if (categoryCrafted.length > 0) {
        ctx.log("craft", `Crafted: ${categoryCrafted.join(", ")}`);
      } else {
        ctx.log("info", `No materials available for assigned categories. Waiting 60s...`);
        await sleep(60000);
      }
      continue;
    }

    // ── Calculate crafting plans for all goal items ──
    ctx.log("craft", `════════════════════════════════════════`);
    ctx.log("craft", `📋 GOAL-BASED CRAFTING PLAN`);
    ctx.log("craft", `════════════════════════════════════════`);

    const plans = calculateMultiGoalPlan(
      goalItems.map(g => ({ itemId: g.itemId, quantity: g.quantity })),
      recipes,
      (itemId) => countItem(ctx, itemId, personalMode),
    );

    // Combine all plan items into a single execution list
    const allPlanItems: Array<{ recipe: Recipe; quantityToCraft: number; reason: string; depth: number }> = [];
    
    for (const plan of plans) {
      ctx.log("craft", "");
      ctx.log("craft", formatCraftingPlan(plan));
      
      for (const item of plan.flatOrder) {
        allPlanItems.push({
          recipe: item.recipe,
          quantityToCraft: item.quantityToCraft,
          reason: item.reason,
          depth: item.depth,
        });
      }
    }

    if (allPlanItems.length === 0) {
      ctx.log("craft", `✓ All goals already met - nothing to craft`);
      await sleep(60000);
      continue;
    }

    ctx.log("craft", "");
    ctx.log("craft", `════════════════════════════════════════`);

    // ── Execute the crafting plan ──
    const { crafted: craftedSummary, prereqs: prereqSummary } = await executeCraftingPlan(
      ctx,
      allPlanItems,
      craftingSkillLevel,
      settings.goalProcessingMode,
      personalMode,
    );

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

    // ── Deposit crafted goods to faction storage (only if in faction mode) ──
    if (bot.docked && !personalMode) {
      await bot.refreshCargo();
      await bot.refreshStorage();
      const depositedItems: string[] = [];

      // First, deposit all crafted items from cargo to faction storage
      for (const item of [...bot.inventory]) {
        if (item.quantity <= 0) continue;
        // Use unified storage command: deposit from cargo to faction storage
        const dResp = await bot.exec("storage", { action: "deposit", target: "faction", item_id: item.itemId, quantity: item.quantity, source: "cargo" });
        if (!dResp.error) {
          depositedItems.push(`${item.quantity}x ${item.name}`);
          logFactionActivity(ctx, "deposit", `Deposited ${item.quantity}x ${item.name} (crafted)`);
        } else {
          // Fallback: deposit to personal storage
          await bot.exec("storage", { action: "deposit", target: "self", item_id: item.itemId, quantity: item.quantity, source: "cargo" });
        }
      }

      // Transfer ALL items from personal storage to faction storage (including fuel/energy cells)
      // This ensures the dedicated crafter bot's personal storage stays empty
      await bot.refreshStorage();
      for (const item of [...bot.storage]) {
        if (item.quantity <= 0) continue;
        // Use unified storage command: transfer from personal storage to faction storage
        const transferResp = await bot.exec("storage", { action: "deposit", target: "faction", item_id: item.itemId, quantity: item.quantity, source: "storage" });
        if (!transferResp.error) {
          depositedItems.push(`${item.quantity}x ${item.name} (from storage)`);
          logFactionActivity(ctx, "deposit", `Transferred ${item.quantity}x ${item.name} from personal storage to faction storage`);
        }
      }

      if (depositedItems.length > 0) {
        ctx.log("trade", `Deposited to faction: ${depositedItems.join(", ")}`);
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
    await sleep(10000);
  }
};
