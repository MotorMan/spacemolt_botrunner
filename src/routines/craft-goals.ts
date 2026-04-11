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
 * Find the recipe that produces a given item.
 */
function findRecipeForItem(itemId: string, recipes: Recipe[]): Recipe | null {
  return recipes.find(r => r.output_item_id === itemId) || null;
}

/**
 * Recursively build a crafting tree for a goal item.
 * 
 * @param goalRecipe - The recipe for the final goal item
 * @param quantityNeeded - How many of the goal item we need
 * @param quantityHave - How many we already have in inventory
 * @param recipes - All available recipes
 * @param countItemFn - Function to count items in inventory
 * @param depth - Current recursion depth (for cycle detection)
 * @param visited - Set of already-visited item IDs (cycle detection)
 */
function buildCraftingTree(
  goalRecipe: Recipe,
  quantityNeeded: number,
  quantityHave: number,
  recipes: Recipe[],
  countItemFn: (itemId: string) => number,
  depth: number = 0,
  visited: Set<string> = new Set(),
): CraftingNode | null {
  // Cycle detection
  if (visited.has(goalRecipe.output_item_id)) {
    return null;
  }

  const quantityToCraft = Math.max(0, quantityNeeded - quantityHave);
  
  // If we don't need to craft any, skip this branch
  if (quantityToCraft <= 0) {
    return null;
  }

  visited.add(goalRecipe.output_item_id);

  const node: CraftingNode = {
    recipe: goalRecipe,
    quantityNeeded,
    quantityHave,
    quantityToCraft,
    children: [],
    depth,
  };

  // Find prerequisites for each component
  for (const comp of goalRecipe.components) {
    const totalCompNeeded = comp.quantity * quantityToCraft;
    const compHave = countItemFn(comp.item_id);
    const compToCraft = Math.max(0, totalCompNeeded - compHave);

    if (compToCraft <= 0) continue;

    // Find recipe for this component
    const prereqRecipe = findRecipeForItem(comp.item_id, recipes);
    
    if (!prereqRecipe) {
      // No recipe to craft this - it's a base material
      // We'll handle it as a missing material in the plan
      continue;
    }

    // Recursively build tree for prerequisite
    // compToCraft is already the deficit, so pass 0 as quantityHave to avoid double-counting
    const childNode = buildCraftingTree(
      prereqRecipe,
      Math.ceil(compToCraft / (prereqRecipe.output_quantity || 1)),
      0,  // compToCraft is already the net amount needed, don't subtract compHave again
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
  const goalRecipe = findRecipeForItem(goalItemId, recipes);

  if (!goalRecipe) {
    return null;
  }

  // goalQuantity is already the deficit (limit - currentStock), so we don't subtract quantityHave again
  // Pass 0 as quantityHave to avoid double-counting
  const tree = buildCraftingTree(
    goalRecipe,
    goalQuantity,
    0,  // quantityHave is already accounted for in goalQuantity (the deficit)
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
 * Calculate crafting plans for multiple goal items.
 * Plans are calculated in order (FIFO), and inventory is updated
 * after each plan to account for items that will be crafted.
 */
export function calculateMultiGoalPlan(
  goals: Array<{ itemId: string; quantity: number }>,
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
    const plan = calculateCraftingPlan(
      goal.itemId,
      goal.quantity,
      recipes,
      (itemId) => inventory.get(itemId) || 0,
    );

    if (plan && plan.flatOrder.length > 0) {
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
