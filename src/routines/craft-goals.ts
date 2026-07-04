/**
 * Goal-based crafting dependency resolver.
 * 
 * Given a goal item (e.g., "communications_array"), this module:
 * 1. Recursively finds all ingredients needed to craft it
 * 2. Builds a complete crafting tree showing dependencies
 * 3. Calculates what's missing based on current inventory
 * 4. Returns a flat crafting order (prerequisites first)
 */

import { readSettings } from "./common.js";

interface Recipe {
  recipe_id: string;
  name: string;
  components: Array<{ item_id: string; name: string; quantity: number }>;
  output_item_id: string;
  output_name: string;
  output_quantity: number;
  category?: string;
}

interface CraftingNode {
  recipe: Recipe;
  quantityNeeded: number;        // Total quantity needed for parent goals (in items)
  quantityHave: number;          // Current inventory count
  quantityToCraft: number;       // Net quantity to craft (needed - have) - in ITEMS
  children: CraftingNode[];      // Prerequisite recipes
  depth: number;
}

interface CraftingPlanItem {
  recipe: Recipe;
  quantityToCraft: number;
  reason: string;                // e.g., "Need 15x for communications_array"
  depth: number;
}

interface CraftingPlan {
  goalItem: string;
  goalQuantity: number;
  nodes: CraftingNode[];
  flatOrder: CraftingPlanItem[]; // Sorted: craft these first
  totalSteps: number;
}

const DEFAULT_BLACKLISTED_RECIPES = new Set([
  "basic_silicon_refinement",
  "wrap_processed_thorium",
  "wrap_thorium_fuel_rod",
  "wrap_reactor_fuel_assembly",
  "wrap_reactor_grade_plutonium",
  "wrap_enriched_uranium_rod",
  "wrap_weapons_grade_plutonium",
  "wrap_highly_enriched_uranium",
  "wrap_low_enriched_uranium",
  "wrap_liquid_tritium",
  "wrap_uranium_hexafluoride",
  "synthesize_energy_crystal",
  "synthesize_xenon_power_cell",
  "chlorine_circuit_etching",
]);

export function getBlacklistedRecipes(): Set<string> {
  const all = readSettings();
  const c = all.crafter || {};
  const userBlacklisted = (c.blacklistedRecipes as string[]) || [];
  return new Set([...DEFAULT_BLACKLISTED_RECIPES, ...userBlacklisted]);
}

const PENALTY_RECIPES: Record<string, number> = {
  "synthesize_bio_polymer": -1000,
};

function isUnwrapRecipe(recipe: Recipe): boolean {
  return recipe.recipe_id.startsWith("unwrap_");
}

function hasDirectRecipe(recipeId: string, recipes: Recipe[]): boolean {
  const itemMatch = recipeId.match(/^unwrap_(.+)$/);
  if (!itemMatch) return false;
  const itemId = itemMatch[1];
  return recipes.some(r => r.output_item_id === itemId && !isUnwrapRecipe(r));
}

export function scoreRecipeAvailability(
  recipe: Recipe,
  countItemFn: (itemId: string) => number,
): number {
  const blacklistedRecipes = getBlacklistedRecipes();
  if (blacklistedRecipes.has(recipe.recipe_id)) {
    return -Infinity;
  }

  if (recipe.components.length === 0) return 50;

  let totalAvailability = 0;
  let totalNeeded = 0;

  for (const comp of recipe.components) {
    const have = countItemFn(comp.item_id);
    const needed = comp.quantity;
    totalNeeded += needed;
    totalAvailability += Math.min(have, needed);
  }

  if (totalNeeded === 0) return 50;
  
  let score = Math.round((totalAvailability / totalNeeded) * 100);
  
  if (recipe.recipe_id in PENALTY_RECIPES) {
    score += PENALTY_RECIPES[recipe.recipe_id];
  }
  
  return score;
}

export function hasRecipeMaterials(
  recipe: Recipe,
  countItemFn: (itemId: string) => number,
): boolean {
  for (const comp of recipe.components) {
    const have = countItemFn(comp.item_id);
    if (have < comp.quantity) return false;
  }
  return true;
}

/**
 * Find the best recipe that produces a given item.
 * Prefers recipes with materials already available in storage.
 * Optionally prioritizes recipes that can be crafted at available facilities.
 */
export function findRecipeForItem(
  itemId: string,
  recipes: Recipe[],
  countItemFn: (itemId: string) => number,
  facilityAvailableRecipes?: Set<string>,
): Recipe | null {
  const blacklistedRecipes = getBlacklistedRecipes();
  const candidates = recipes.filter(r => r.output_item_id === itemId && isRecipeCraftable(r).ok && !blacklistedRecipes.has(r.recipe_id));

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const unwrapCandidates = candidates.filter(isUnwrapRecipe);
  const nonUnwrapCandidates = candidates.filter(r => !isUnwrapRecipe(r));

  if (unwrapCandidates.length > 0 && nonUnwrapCandidates.length > 0) {
    const hasDirect = hasDirectRecipe(unwrapCandidates[0].recipe_id, recipes);
    if (hasDirect) {
      const scored = nonUnwrapCandidates.map(recipe => ({
        recipe,
        canCraft: hasRecipeMaterials(recipe, countItemFn),
        score: scoreRecipeAvailability(recipe, countItemFn),
        isFacilityRecipe: facilityAvailableRecipes?.has(recipe.recipe_id) ?? false,
      }));

      scored.sort((a, b) => {
        if (a.isFacilityRecipe && !b.isFacilityRecipe) return -1;
        if (!a.isFacilityRecipe && b.isFacilityRecipe) return 1;
        if (a.score !== b.score) {
          return b.score - a.score;
        }
        return a.canCraft ? -1 : 1;
      });

      return scored[0].recipe;
    }
  }

  const scored = candidates.map(recipe => ({
    recipe,
    canCraft: hasRecipeMaterials(recipe, countItemFn),
    score: scoreRecipeAvailability(recipe, countItemFn),
    isFacilityRecipe: facilityAvailableRecipes?.has(recipe.recipe_id) ?? false,
  }));

  scored.sort((a, b) => {
    if (a.isFacilityRecipe && !b.isFacilityRecipe) return -1;
    if (!a.isFacilityRecipe && b.isFacilityRecipe) return 1;
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    return a.canCraft ? -1 : 1;
  });

  return scored[0].recipe;
}

/**
 * Recursively build a crafting tree for a goal item.
 *
 * @param goalRecipe - The recipe for the final goal item
 * @param quantityToCraftInItems - How many output items we need to craft (already net deficit)
 * @param recipes - All available recipes
 * @param countItemFn - Function to count items in inventory
 * @param facilityAvailableRecipes - Set of recipe IDs available at facilities
 * @param depth - Current recursion depth (for cycle detection)
 * @param visited - Set of already-visited item IDs (cycle detection)
 */
function buildCraftingTree(
  goalRecipe: Recipe,
  quantityToCraftInItems: number,
  recipes: Recipe[],
  countItemFn: (itemId: string) => number,
  facilityAvailableRecipes?: Set<string>,
  depth: number = 0,
  visited: Set<string> = new Set(),
): CraftingNode | null {
  // Cycle detection
  if (visited.has(goalRecipe.output_item_id)) {
    return null;
  }

  // quantityToCraftInItems is already the deficit in items
  // If we don't need to craft any items, skip this branch
  if (quantityToCraftInItems <= 0) {
    return null;
  }

  visited.add(goalRecipe.output_item_id);

  const node: CraftingNode = {
    recipe: goalRecipe,
    quantityNeeded: quantityToCraftInItems,
    quantityHave: countItemFn(goalRecipe.output_item_id),
    quantityToCraft: quantityToCraftInItems,
    children: [],
    depth,
  };

  // Find prerequisites for each component
  // Calculate total components needed for all items
  for (const comp of goalRecipe.components) {
    const totalCompNeeded = comp.quantity * quantityToCraftInItems;
    const compHave = countItemFn(comp.item_id);
    const compToCraft = Math.max(0, totalCompNeeded - compHave);

    if (compToCraft <= 0) continue;

    // Find recipe for this component, preferring recipes with available materials
    const prereqRecipe = findRecipeForItem(comp.item_id, recipes, countItemFn, facilityAvailableRecipes);

    if (!prereqRecipe) {
      // No recipe to craft this - it's a base material
      continue;
    }

    // Recursively build tree for prerequisite
    // compToCraft is already the deficit in items
    const childNode = buildCraftingTree(
      prereqRecipe,
      compToCraft,
      recipes,
      countItemFn,
      facilityAvailableRecipes,
      depth + 1,
      new Set(visited),
    );

    if (childNode) {
      node.children.push(childNode);
    }
  }

  visited.delete(goalRecipe.output_item_id);
  return node;
}

/**
 * Flatten a crafting tree into a list sorted by craft order (prerequisites first).
 * Uses post-order traversal: children before parents.
 */
function flattenTree(node: CraftingNode, result: CraftingPlanItem[] = []): CraftingPlanItem[] {
  // First, process all children (prerequisites)
  for (const child of node.children) {
    flattenTree(child, result);
  }

  // Then add this node
  const parentNames = node.children.map(c => c.recipe.output_name).join(", ");
  result.push({
    recipe: node.recipe,
    quantityToCraft: node.quantityToCraft,
    reason: node.depth === 0 
      ? `Goal item` 
      : `Need ${node.quantityToCraft}x ${node.recipe.output_name} for ${parentNames}`,
    depth: node.depth,
  });

  return result;
}

/**
 * Calculate a complete crafting plan for a goal item.
 * 
 * @param goalItemId - The item ID we want to craft
 * @param goalQuantity - How many we want
 * @param recipes - All available recipes
 * @param countItemFn - Function to count items in inventory
 * @param facilityAvailableRecipes - Set of recipe IDs available at facilities
 * @returns Complete crafting plan or null if no recipe exists
 */
export function calculateCraftingPlan(
  goalItemId: string,
  goalQuantity: number,
  recipes: Recipe[],
  countItemFn: (itemId: string) => number,
  facilityAvailableRecipes?: Set<string>,
): CraftingPlan | null {
  const goalRecipe = findRecipeForItem(goalItemId, recipes, countItemFn, facilityAvailableRecipes);

  if (!goalRecipe) {
    return null;
  }

  // goalQuantity is already the deficit (limit - currentStock), so we pass it directly as items to craft
  const tree = buildCraftingTree(
    goalRecipe,
    goalQuantity,
    recipes,
    countItemFn,
    facilityAvailableRecipes,
  );

  if (!tree) {
    // Already have enough
    return {
      goalItem: goalRecipe.output_name,
      goalQuantity,
      nodes: [],
      flatOrder: [],
      totalSteps: 0,
    };
  }

  const flatOrder = flattenTree(tree);
  
  return {
    goalItem: goalRecipe.output_name,
    goalQuantity,
    nodes: [tree],
    flatOrder,
    totalSteps: flatOrder.length,
  };
}

/**
 * Find all recipes that produce a given item and return them sorted by material availability.
 * This allows callers to pick the best recipe based on current materials.
 * Optionally prioritizes recipes that can be crafted at available facilities.
 */
export function findAllRecipesForItem(
  itemId: string,
  recipes: Recipe[],
  countItemFn: (itemId: string) => number,
  facilityAvailableRecipes?: Set<string>,
): Recipe[] {
  const blacklistedRecipes = getBlacklistedRecipes();
  const candidates = recipes.filter(r => r.output_item_id === itemId && isRecipeCraftable(r).ok && !blacklistedRecipes.has(r.recipe_id));
  if (candidates.length === 0) return [];

  const unwrapCandidates = candidates.filter(isUnwrapRecipe);
  const nonUnwrapCandidates = candidates.filter(r => !isUnwrapRecipe(r));

  if (unwrapCandidates.length > 0 && nonUnwrapCandidates.length > 0) {
    const hasDirect = hasDirectRecipe(unwrapCandidates[0].recipe_id, recipes);
    if (hasDirect) {
      const scored = nonUnwrapCandidates.map(recipe => ({
        recipe,
        canCraft: hasRecipeMaterials(recipe, countItemFn),
        score: scoreRecipeAvailability(recipe, countItemFn),
        isFacilityRecipe: facilityAvailableRecipes?.has(recipe.recipe_id) ?? false,
      }));

      scored.sort((a, b) => {
        if (a.isFacilityRecipe && !b.isFacilityRecipe) return -1;
        if (!a.isFacilityRecipe && b.isFacilityRecipe) return 1;
        if (a.score !== b.score) {
          return b.score - a.score;
        }
        return a.canCraft ? -1 : 1;
      });

      return scored.map(s => s.recipe);
    }
  }

  const scored = candidates.map(recipe => ({
    recipe,
    canCraft: hasRecipeMaterials(recipe, countItemFn),
    score: scoreRecipeAvailability(recipe, countItemFn),
    isFacilityRecipe: facilityAvailableRecipes?.has(recipe.recipe_id) ?? false,
  }));

  scored.sort((a, b) => {
    if (a.isFacilityRecipe && !b.isFacilityRecipe) return -1;
    if (!a.isFacilityRecipe && b.isFacilityRecipe) return 1;
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    return a.canCraft ? -1 : 1;
  });

  return scored.map(s => s.recipe);
}

/**
 * Calculate crafting plans for multiple goal items.
 * Plans are calculated in order (FIFO), and inventory is updated
 * after each plan to account for items that will be crafted.
 * 
 * Each goal can specify either a specific recipe or just an item ID.
 * When a recipe is specified, that exact recipe will be used UNLESS
 * materials are not available - then it will try alternatives.
 */
export function calculateMultiGoalPlan(
  goals: Array<{ itemId: string; quantity: number; recipe?: Recipe }>,
  recipes: Recipe[],
  countItemFn: (itemId: string) => number,
  facilityAvailableRecipes?: Set<string>,
): CraftingPlan[] {
  const plans: CraftingPlan[] = [];

  // Create a mutable inventory counter that updates as we plan
  const inventory = new Map<string, number>();
  const baseCount = countItemFn;

  // Initialize inventory
  const allItemIds = new Set<string>();
  recipes.forEach(r => {
    allItemIds.add(r.output_item_id);
    r.components.forEach(c => allItemIds.add(c.item_id));
  });

  allItemIds.forEach(id => {
    inventory.set(id, baseCount(id));
  });

  // Calculate plans in order
  for (const goal of goals) {
    // Use the specified recipe if provided, otherwise find the best recipe for the goal item
    let goalRecipe: Recipe | null = null;

    if (goal.recipe) {
      // Always use the specified recipe exactly as requested
      goalRecipe = goal.recipe;
    } else {
      goalRecipe = findRecipeForItem(goal.itemId, recipes, (itemId) => inventory.get(itemId) || 0, facilityAvailableRecipes);
    }
    
    if (!goalRecipe) continue;
    
    // goal.quantity is already the deficit (limit - currentStock),
    // so use it directly without subtracting quantityHave again
    const quantityToCraft = goal.quantity;
    
    if (quantityToCraft <= 0) continue;

    const tree = buildCraftingTree(
      goalRecipe,
      quantityToCraft,
      recipes,
      (itemId) => inventory.get(itemId) || 0,
      facilityAvailableRecipes,
    );

    if (tree) {
      const flatOrder = flattenTree(tree);
      const plan: CraftingPlan = {
        goalItem: goalRecipe.output_name,
        goalQuantity: goal.quantity,
        nodes: [tree],
        flatOrder,
        totalSteps: flatOrder.length,
      };
      plans.push(plan);

      // Update inventory as if we crafted everything in this plan
      for (const item of plan.flatOrder) {
        const craftedQty = item.quantityToCraft * (item.recipe.output_quantity || 1);
        const current = inventory.get(item.recipe.output_item_id) || 0;
        inventory.set(item.recipe.output_item_id, current + craftedQty);
      }
    }
  }

  return plans;
}

/**
 * Format a crafting plan as a visual tree for logging.
 */
export function formatCraftingTree(node: CraftingNode, prefix: string = ""): string {
  const lines: string[] = [];
  
  const haveStr = node.quantityHave > 0 ? ` (have ${node.quantityHave})` : "";
  lines.push(`${prefix}├─ ${node.recipe.output_name}: craft ${node.quantityToCraft}x${haveStr}`);
  
  for (const child of node.children) {
    lines.push(formatCraftingTree(child, prefix + "│  "));
  }
  
  return lines.join("\n");
}

/**
 * Format a complete crafting plan for display.
 */
export function formatCraftingPlan(plan: CraftingPlan): string {
  if (plan.flatOrder.length === 0) {
    return `✓ ${plan.goalItem}: Already have ${plan.goalQuantity}x`;
  }

  const lines = [
    `🎯 Goal: ${plan.goalQuantity}x ${plan.goalItem}`,
    `   Steps: ${plan.totalSteps} recipes to craft`,
  ];

  for (const node of plan.nodes) {
    lines.push(formatCraftingTree(node));
  }

  return lines.join("\n");
}

/**
 * Check if a recipe is craftable (not ship passive or facility only).
 */
export function isRecipeCraftable(recipe: Recipe): { ok: boolean; reason: string } {
  const category = (recipe.category || "").toLowerCase();

  if (category.includes("ship passive")) {
    return { ok: false, reason: "Recipe runs automatically on ships" };
  }

  if (category.includes("facility only")) {
    return { ok: false, reason: "Recipe can only be crafted at facilities" };
  }

  return { ok: true, reason: "" };
}
