/**
 * Goal-based crafting dependency resolver.
 * 
 * Given a goal item (e.g., "communications_array"), this module:
 * 1. Recursively finds all ingredients needed to craft it
 * 2. Builds a complete crafting tree showing dependencies
 * 3. Calculates what's missing based on current inventory
 * 4. Returns a flat crafting order (prerequisites first)
 */

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
  quantityNeeded: number;        // Total quantity needed for parent goals
  quantityHave: number;          // Current inventory count
  quantityToCraft: number;       // Net quantity to craft (needed - have)
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

/**
 * Score a recipe based on material availability.
 * Returns a score from 0-100 where higher means more materials are available.
 */
function scoreRecipeAvailability(
  recipe: Recipe,
  countItemFn: (itemId: string) => number,
): number {
  if (recipe.components.length === 0) return 50; // No ingredients needed

  let totalAvailability = 0;
  let totalNeeded = 0;

  for (const comp of recipe.components) {
    const have = countItemFn(comp.item_id);
    const needed = comp.quantity;
    totalNeeded += needed;
    // Count available materials (capped at what's needed)
    totalAvailability += Math.min(have, needed);
  }

  if (totalNeeded === 0) return 50;
  
  // Return percentage of materials available (0-100)
  return Math.round((totalAvailability / totalNeeded) * 100);
}

/**
 * Check if a recipe has all materials available (at least 1 batch worth).
 */
function hasRecipeMaterials(
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
 */
function findRecipeForItem(
  itemId: string,
  recipes: Recipe[],
  countItemFn: (itemId: string) => number,
): Recipe | null {
  // Find all recipes that produce this item
  const candidates = recipes.filter(r => r.output_item_id === itemId);
  
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  
  // Score each recipe by material availability
  const scored = candidates.map(recipe => ({
    recipe,
    score: scoreRecipeAvailability(recipe, countItemFn),
  }));
  
  // Sort by score descending - prefer recipes with more materials available
  scored.sort((a, b) => b.score - a.score);
  
  // Return the recipe with highest material availability score
  return scored[0].recipe;
}

/**
 * Recursively build a crafting tree for a goal item.
 *
 * @param goalRecipe - The recipe for the final goal item
 * @param quantityToCraftInItems - How many output items we need to craft (already net deficit)
 * @param recipes - All available recipes
 * @param countItemFn - Function to count items in inventory
 * @param depth - Current recursion depth (for cycle detection)
 * @param visited - Set of already-visited item IDs (cycle detection)
 */
function buildCraftingTree(
  goalRecipe: Recipe,
  quantityToCraftInItems: number,
  recipes: Recipe[],
  countItemFn: (itemId: string) => number,
  depth: number = 0,
  visited: Set<string> = new Set(),
): CraftingNode | null {
  // Cycle detection
  if (visited.has(goalRecipe.output_item_id)) {
    return null;
  }

  // Convert items needed to recipe batches
  const outputQty = goalRecipe.output_quantity || 1;
  const batchesToCraft = Math.ceil(quantityToCraftInItems / outputQty);

  // If we don't need to craft any batches, skip this branch
  if (batchesToCraft <= 0) {
    return null;
  }

  visited.add(goalRecipe.output_item_id);

  const node: CraftingNode = {
    recipe: goalRecipe,
    quantityNeeded: quantityToCraftInItems,
    quantityHave: 0,
    quantityToCraft: batchesToCraft,
    children: [],
    depth,
  };

  // Find prerequisites for each component
  // Calculate total components needed for all batches
  for (const comp of goalRecipe.components) {
    const totalCompNeeded = comp.quantity * batchesToCraft;
    const compHave = countItemFn(comp.item_id);
    const compToCraft = Math.max(0, totalCompNeeded - compHave);

    if (compToCraft <= 0) continue;

    // Find recipe for this component, preferring recipes with available materials
    const prereqRecipe = findRecipeForItem(comp.item_id, recipes, countItemFn);

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
      : `Need ${node.quantityToCraft * (node.recipe.output_quantity || 1)}x ${node.recipe.output_name} for ${parentNames}`,
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
 * @returns Complete crafting plan or null if no recipe exists
 */
export function calculateCraftingPlan(
  goalItemId: string,
  goalQuantity: number,
  recipes: Recipe[],
  countItemFn: (itemId: string) => number,
): CraftingPlan | null {
  const goalRecipe = findRecipeForItem(goalItemId, recipes, countItemFn);

  if (!goalRecipe) {
    return null;
  }

  // goalQuantity is already the deficit (limit - currentStock), so we pass it directly as items to craft
  const tree = buildCraftingTree(
    goalRecipe,
    goalQuantity,
    recipes,
    countItemFn,
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
 */
export function findAllRecipesForItem(
  itemId: string,
  recipes: Recipe[],
  countItemFn: (itemId: string) => number,
): Recipe[] {
  const candidates = recipes.filter(r => r.output_item_id === itemId);
  if (candidates.length === 0) return [];

  const scored = candidates.map(recipe => ({
    recipe,
    score: scoreRecipeAvailability(recipe, countItemFn),
  }));

  scored.sort((a, b) => b.score - a.score);
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
    // Find the best recipe for this goal item, considering current materials
    // If user specified a recipe, try that first, but fall back to better alternatives if no materials
    let goalRecipe: Recipe | null = null;
    
    if (goal.recipe) {
      // Check if the specified recipe has materials available
      const hasMaterials = hasRecipeMaterials(goal.recipe, (itemId) => inventory.get(itemId) || 0);
      if (hasMaterials) {
        goalRecipe = goal.recipe;
      } else {
        // Specified recipe has no materials - find better alternative
        const alternatives = findAllRecipesForItem(goal.itemId, recipes, (itemId) => inventory.get(itemId) || 0);
        if (alternatives.length > 0 && alternatives[0] !== goal.recipe) {
          goalRecipe = alternatives[0];
        } else {
          goalRecipe = goal.recipe;
        }
      }
    } else {
      goalRecipe = findRecipeForItem(goal.itemId, recipes, (itemId) => inventory.get(itemId) || 0);
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
