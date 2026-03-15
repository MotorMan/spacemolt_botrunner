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

// ── Settings ─────────────────────────────────────────────────

interface CraftLimit {
  recipeId: string;
  limit: number;
}

function getCrafterSettings(): {
  craftLimits: CraftLimit[];
  enabledCategories: string[];
  refuelThreshold: number;
  repairThreshold: number;
} {
  const all = readSettings();
  const c = all.crafter || {};
  const rawLimits = (c.craftLimits as Record<string, number>) || {};
  const craftLimits: CraftLimit[] = [];
  for (const [recipeId, limit] of Object.entries(rawLimits)) {
    if (limit > 0) {
      craftLimits.push({ recipeId, limit });
    }
  }
  // Default enabled categories for when no specific recipes are configured
  const defaultCategories = ["Refining", "Components", "Consumables"];
  const enabledCategories = (c.enabledCategories as string[]) || defaultCategories;
  return {
    craftLimits,
    enabledCategories,
    refuelThreshold: (c.refuelThreshold as number) || 50,
    repairThreshold: (c.repairThreshold as number) || 40,
  };
}

// ── Recipe/inventory helpers ─────────────────────────────────

interface RecipeSkillReq {
  skillId: string;
  skillName: string;
  level: number;
}

interface Recipe {
  recipe_id: string;
  name: string;
  components: Array<{ item_id: string; name: string; quantity: number }>;
  output_item_id: string;
  output_name: string;
  output_quantity: number;
  requiredSkill: RecipeSkillReq | null;
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

    // Parse skill requirement from various API shapes
    let requiredSkill: RecipeSkillReq | null = null;
    const skillObj = (r.required_skill || r.skill) as Record<string, unknown> | undefined;
    if (skillObj && typeof skillObj === "object") {
      const sId = (skillObj.skill_id as string) || (skillObj.id as string) || (skillObj.name as string) || "";
      const sName = (skillObj.name as string) || sId;
      const sLevel = (skillObj.level as number) || (skillObj.min_level as number) || 0;
      if (sId && sLevel > 0) requiredSkill = { skillId: sId, skillName: sName, level: sLevel };
    }
    // Also check required_skills: Record<string, number>
    if (!requiredSkill && r.required_skills && typeof r.required_skills === "object") {
      const skills = r.required_skills as Record<string, number>;
      for (const [sId, sLevel] of Object.entries(skills)) {
        if (sLevel > 0) {
          requiredSkill = { skillId: sId, skillName: sId, level: sLevel };
          break; // use the first skill requirement
        }
      }
    }

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
      requiredSkill,
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
function countItem(ctx: RoutineContext, itemId: string): number {
  const { bot } = ctx;
  let total = 0;
  for (const i of bot.inventory) {
    if (i.itemId === itemId) total += i.quantity;
  }
  for (const i of bot.storage) {
    if (i.itemId === itemId) total += i.quantity;
  }
  for (const i of bot.factionStorage) {
    if (i.itemId === itemId) total += i.quantity;
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
  // No-op: crafting automatically pulls from both cargo and personal storage.
  // Materials in personal storage are already accessible, no need to move to cargo.
  // This function is kept for backward compatibility in call sites.
}

/** Withdraw materials from faction storage into personal storage for a recipe. */
async function withdrawFactionMaterials(ctx: RoutineContext, recipe: Recipe, batchSize: number = 1): Promise<void> {
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
    // Use unified storage command: transfer from faction storage to personal storage
    // action=deposit, target=self, source=faction moves items directly to personal storage (not cargo)
    const resp = await bot.exec("storage", { action: "deposit", target: "self", item_id: comp.item_id, quantity: withdrawQty, source: "faction" });
    if (!resp.error) {
      ctx.log("craft", `Withdrew ${withdrawQty}x ${comp.name || comp.item_id} from faction storage`);
      logFactionActivity(ctx, "withdraw", `Withdrew ${withdrawQty}x ${comp.name || comp.item_id} from faction storage`);
      // Refresh personal storage to update the cache for subsequent component checks
      await bot.refreshStorage();
      // Debug: log what we have now
      let haveAfter = 0;
      for (const i of bot.storage) {
        if (i.itemId === comp.item_id) haveAfter += i.quantity;
      }
      ctx.log("craft", `  After refresh: have ${haveAfter}x ${comp.name || comp.item_id} in storage`);
    } else {
      ctx.log("error", `Failed to withdraw ${comp.name || comp.item_id}: ${resp.error?.message}`);
    }
  }
}

/** Check if we have materials in cargo for a recipe. Returns missing item info or null if all present. */
function getMissingMaterial(ctx: RoutineContext, recipe: Recipe, batchSize: number = 1): { name: string; need: number; have: number } | null {
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
    const totalNeeded = comp.quantity * batchSize;
    if (have < totalNeeded) {
      return { name: comp.name || comp.item_id, need: totalNeeded, have };
    }
  }
  return null;
}

/** Check if materials exist anywhere (cargo + storage + faction). */
function hasMaterialsAnywhere(ctx: RoutineContext, recipe: Recipe, batchSize: number = 1): boolean {
  for (const comp of recipe.components) {
    if (countItem(ctx, comp.item_id) < comp.quantity * batchSize) return false;
  }
  return true;
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
): Promise<string[]> {
  if (depth > 2) return []; // prevent infinite recursion
  const { bot } = ctx;
  const crafted: string[] = [];

  for (const comp of recipe.components) {
    const totalAvailable = countItem(ctx, comp.item_id);
    if (totalAvailable >= comp.quantity) continue; // have enough

    const deficit = comp.quantity - totalAvailable;
    const prereqRecipe = recipeIndex.get(comp.item_id);
    if (!prereqRecipe) continue; // no recipe to craft this item

    // How many batches do we need? (each batch produces output_quantity)
    const batchesNeeded = Math.ceil(deficit / (prereqRecipe.output_quantity || 1));

    // Recursively craft sub-prerequisites first
    const subCrafted = await craftPrerequisites(ctx, prereqRecipe, recipeIndex, depth + 1);
    crafted.push(...subCrafted);

    // Refresh inventories after sub-crafting
    await bot.refreshCargo();
    if (bot.docked) {
      await bot.refreshStorage();
      await bot.refreshFactionStorage();
    }

    // Check if we can craft the prerequisite now
    if (!hasMaterialsAnywhere(ctx, prereqRecipe)) continue;

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

    await withdrawFactionMaterials(ctx, prereqRecipe);
    await withdrawStorageMaterials(ctx, prereqRecipe);

    const stillMissing = getMissingMaterial(ctx, prereqRecipe);
    if (stillMissing) continue; // can't get all materials into cargo

    // Craft the prerequisite
    for (let batch = 0; batch < batchesNeeded && bot.state === "running"; batch++) {
      const craftResp = await bot.exec("craft", { recipe_id: prereqRecipe.recipe_id, count: 1 });
      if (craftResp.error) break;

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
      const newTotal = countItem(ctx, comp.item_id);
      if (newTotal >= comp.quantity) break;

      // Check if we still have materials for another batch
      const prereqMissing = getMissingMaterial(ctx, prereqRecipe);
      if (prereqMissing) {
        // Try to withdraw more materials
        await withdrawFactionMaterials(ctx, prereqRecipe);
        await withdrawStorageMaterials(ctx, prereqRecipe);
        if (getMissingMaterial(ctx, prereqRecipe)) break;
      }
    }
  }

  return crafted;
}

/**
 * Grind crafting XP by crafting the simplest recipes we have materials for.
 * Tries up to 5 crafts of the cheapest available recipe to level up skill.
 * Returns list of items crafted for logging.
 */
async function grindCraftingXP(
  ctx: RoutineContext,
  recipes: Recipe[],
  recipeIndex: Map<string, Recipe>,
  allowedRecipeIds?: Set<string>,
  enabledCategories?: string[],
): Promise<string[]> {
  const { bot } = ctx;
  const crafted: string[] = [];

  // Find recipes we can actually craft right now (have materials, not skill-blocked)
  // Only consider recipes from settings (or their prerequisites) — not random items
  const candidates: Array<{ recipe: Recipe; complexity: number }> = [];

  for (const recipe of recipes) {
    // If settings specify allowed recipes, only grind those (or their components)
    if (allowedRecipeIds && allowedRecipeIds.size > 0) {
      const isAllowed = allowedRecipeIds.has(recipe.recipe_id) ||
        allowedRecipeIds.has(recipe.name) ||
        allowedRecipeIds.has(recipe.name.toLowerCase());
      // Also allow recipes whose output is a component of an allowed recipe
      const isPrereq = [...allowedRecipeIds].some(id => {
        const parent = recipeIndex.get(id);
        return parent?.components.some(c => c.item_id === recipe.output_item_id);
      });
      if (!isAllowed && !isPrereq) continue;
    }
    // If enabled categories are specified, only allow recipes from those categories
    if (enabledCategories && enabledCategories.length > 0 && (!allowedRecipeIds || allowedRecipeIds.size === 0)) {
      const recipeCategory = recipe.category || "";
      if (!enabledCategories.includes(recipeCategory)) continue;
    }
    // Skip recipes with no ingredients — they grant no skill XP
    if (recipe.components.length === 0) continue;
    // Skip recipes that cannot be crafted manually (ship-only or facility-only)
    if (!isRecipeCraftable(recipe).ok) continue;
    if (!hasMaterialsAnywhere(ctx, recipe)) continue;
    // Only grind recipes we have the skill for
    if (!canCraftSkillwise(ctx, recipe).ok) continue;
    // Complexity = total number of component items needed
    const complexity = recipe.components.reduce((sum, c) => sum + c.quantity, 0);
    candidates.push({ recipe, complexity });
  }

  if (candidates.length === 0) return crafted;

  // Sort by complexity (simplest first — basic refining recipes)
  candidates.sort((a, b) => a.complexity - b.complexity);

  // Try the simplest recipe
  const target = candidates[0].recipe;
  ctx.log("craft", `Grinding XP: crafting ${target.name} (${target.components.map(c => `${c.quantity}x ${c.name}`).join(", ")})...`);

  // Deposit non-essential cargo to make space
  for (const item of [...bot.inventory]) {
    if (item.quantity <= 0) continue;
    const lower = item.itemId.toLowerCase();
    if (lower.includes("fuel") || lower.includes("energy_cell")) continue;
    if (target.components.some(c => c.item_id === item.itemId)) continue;
    // Use unified storage command: deposit from cargo to faction storage
    const dResp = await bot.exec("storage", { action: "deposit", target: "faction", item_id: item.itemId, quantity: item.quantity, source: "cargo" });
    if (dResp.error) {
      // Fallback: deposit to personal storage
      await bot.exec("storage", { action: "deposit", target: "self", item_id: item.itemId, quantity: item.quantity, source: "cargo" });
    }
  }
  await bot.refreshCargo();
  await bot.refreshStatus();

  const MAX_XP_CRAFTS = 5;
  for (let i = 0; i < MAX_XP_CRAFTS && bot.state === "running"; i++) {
    await bot.refreshCargo();
    if (bot.docked) {
      await bot.refreshStorage();
      await bot.refreshFactionStorage();
    }

    if (!hasMaterialsAnywhere(ctx, target)) break;

    await withdrawFactionMaterials(ctx, target);
    await withdrawStorageMaterials(ctx, target);

    if (getMissingMaterial(ctx, target)) break;

    const craftResp = await bot.exec("craft", { recipe_id: target.recipe_id, count: 1 });
    if (craftResp.error) break;

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
  }

  return crafted;
}

/** Check if the bot has the required skill level to craft a recipe. */
function canCraftSkillwise(ctx: RoutineContext, recipe: Recipe): { ok: boolean; reason: string } {
  if (!recipe.requiredSkill) return { ok: true, reason: "" };
  const { skillId, skillName, level } = recipe.requiredSkill;
  const myLevel = ctx.bot.getSkillLevel(skillId);
  if (myLevel >= level) return { ok: true, reason: "" };
  return { ok: false, reason: `${skillName} Lv${level} required (have Lv${myLevel})` };
}

/** Ship Passive recipe IDs that run automatically and cannot be crafted manually. */
const SHIP_PASSIVE_RECIPE_IDS = new Set([
  "onboard_alloy_synthesis",
  "onboard_munitions_fabrication",
]);

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

    // ── Refresh skills for pre-craft skill checks ──
    yield "check_skills";
    await bot.checkSkills();

    // ── Clear cargo space for material withdrawal ──
    await bot.refreshCargo();
    if (bot.docked && bot.inventory.length > 0) {
      for (const item of [...bot.inventory]) {
        if (item.quantity <= 0) continue;
        const lower = item.itemId.toLowerCase();
        if (lower.includes("fuel") || lower.includes("energy_cell")) continue;
        // Use unified storage command: deposit from cargo to faction storage
        const dResp = await bot.exec("storage", { action: "deposit", target: "faction", item_id: item.itemId, quantity: item.quantity, source: "cargo" });
        if (dResp.error) {
          // Fallback: deposit to personal storage
          await bot.exec("storage", { action: "deposit", target: "self", item_id: item.itemId, quantity: item.quantity, source: "cargo" });
        }
      }
      await bot.refreshCargo();
      await bot.refreshStatus();
    }

    // ── Refresh inventory (cargo + personal storage + faction storage) ──
    if (bot.docked) {
      await bot.refreshStorage();
      await bot.refreshFactionStorage();
    }

    // ── Build recipe index for prerequisite lookup ──
    const recipeIndex = buildRecipeIndex(recipes);

    // ── If no specific recipes configured, use enabled categories to craft useful items ──
    if (settings.craftLimits.length === 0) {
      ctx.log("craft", `No specific recipes configured — crafting from enabled categories: ${settings.enabledCategories.join(", ")}`);
      const xpCrafted = await grindCraftingXP(ctx, recipes, recipeIndex, undefined, settings.enabledCategories);
      if (xpCrafted.length > 0) {
        ctx.log("craft", `Crafted: ${xpCrafted.join(", ")}`);
      } else {
        ctx.log("info", `No materials available for enabled categories. Waiting 60s...`);
        await sleep(60000);
      }
      continue;
    }

    // ── Process each configured limit ──
    let totalCrafted = 0;
    const craftedSummary: string[] = [];   // "5x Fuel Cells"
    const prereqSummary: string[] = [];    // "3x Refined Alloy (prereq)"
    const missingSummary: string[] = [];   // "Armor Plate (2x refined_titanium)"
    const skillSummary: string[] = [];     // "Solarian Composite (skill too low, crafted 5x Refined Iron for XP)"
    const atLimitCount = { count: 0 };

    for (const { recipeId, limit } of settings.craftLimits) {
      if (bot.state !== "running") break;

      const recipe = recipes.find(r =>
        r.recipe_id === recipeId ||
        r.name === recipeId ||
        r.name.toLowerCase() === recipeId.toLowerCase()
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
        ctx.log("error", `Recipe "${recipeId}" (${recipe.name}) is not craftable: ${craftableCheck.reason}`);
        continue;
      }

      const outputId = recipe.output_item_id || recipeId;
      const currentStock = countItem(ctx, outputId);
      const needed = limit - currentStock;

      if (needed <= 0) {
        atLimitCount.count++;
        continue;
      }

      // ── Skill check: don't withdraw materials if we can't craft this yet ──
      const skillCheck = canCraftSkillwise(ctx, recipe);
      if (!skillCheck.ok) {
        // Skill too low — grind XP on simpler recipes instead of pulling materials
        const allowedIds = new Set(settings.craftLimits.map(cl => cl.recipeId));
        let xpCrafted = await grindCraftingXP(ctx, recipes, recipeIndex, allowedIds);
        if (xpCrafted.length === 0) {
          // Fallback: search all recipes for anything we have ingredients for right now
          xpCrafted = await grindCraftingXP(ctx, recipes, recipeIndex);
        }
        if (xpCrafted.length > 0) {
          skillSummary.push(`${recipe.name} (${skillCheck.reason}, ground ${xpCrafted.join(", ")} for XP)`);
        } else {
          skillSummary.push(`${recipe.name} (${skillCheck.reason})`);
        }
        continue;
      }

      // Craft in batches - use adaptive batch sizes (100x → 10x → 1x fallback)
      // Personal storage has 100k per item limit, so we can't withdraw millions at once
      let crafted = 0;
      let hitSkillBlock = false;

      while (crafted < needed && bot.state === "running") {
        const remaining = needed - crafted;
        // Start with 100x batch target, fall back to 10x, then 1x if withdrawal fails
        let cycleTarget = Math.min(remaining, 100);

        // Refresh inventories at start of each cycle
        await bot.refreshCargo();
        if (bot.docked) {
          await bot.refreshStorage();
          await bot.refreshFactionStorage();
        }

        // Try to get materials for the batch, with fallback to smaller sizes
        let gotMaterials = false;
        let missingForCycle: { name: string; need: number; have: number } | null = null;

        while (!gotMaterials && cycleTarget >= 1) {
          missingForCycle = getMissingMaterial(ctx, recipe, cycleTarget);

          if (!missingForCycle) {
            gotMaterials = true;
            break;
          }

          // Check if materials are available somewhere (cargo + storage + faction)
          if (hasMaterialsAnywhere(ctx, recipe, cycleTarget)) {
            ctx.log("craft", `${recipe.name}: withdrawing materials for ${cycleTarget}x batch...`);
            await withdrawFactionMaterials(ctx, recipe, cycleTarget);
            await withdrawStorageMaterials(ctx, recipe, cycleTarget);
            // Refresh storage after withdrawal to update cache
            await bot.refreshStorage();
            missingForCycle = getMissingMaterial(ctx, recipe, cycleTarget);

            if (!missingForCycle) {
              gotMaterials = true;
              break;
            }

            // Still missing - try prerequisites
            ctx.log("craft", `${recipe.name}: still missing ${missingForCycle.need}x ${missingForCycle.name} after withdrawal, trying prerequisites...`);
            const preCrafted = await craftPrerequisites(ctx, recipe, recipeIndex);
            if (preCrafted.length > 0) {
              prereqSummary.push(...preCrafted);
              await bot.refreshCargo();
              if (bot.docked) { await bot.refreshStorage(); await bot.refreshFactionStorage(); }
              await withdrawFactionMaterials(ctx, recipe, cycleTarget);
              await withdrawStorageMaterials(ctx, recipe, cycleTarget);
              await bot.refreshStorage();
              missingForCycle = getMissingMaterial(ctx, recipe, cycleTarget);
              if (!missingForCycle) {
                gotMaterials = true;
                break;
              }
            }
          } else {
            // Materials don't exist anywhere — try crafting prerequisites
            ctx.log("craft", `${recipe.name}: materials not available anywhere, trying prerequisites...`);
            const preCrafted = await craftPrerequisites(ctx, recipe, recipeIndex);
            if (preCrafted.length > 0) {
              prereqSummary.push(...preCrafted);
              await bot.refreshCargo();
              if (bot.docked) { await bot.refreshStorage(); await bot.refreshFactionStorage(); }
              await withdrawFactionMaterials(ctx, recipe, cycleTarget);
              await withdrawStorageMaterials(ctx, recipe, cycleTarget);
              await bot.refreshStorage();
              missingForCycle = getMissingMaterial(ctx, recipe, cycleTarget);
              if (!missingForCycle) {
                gotMaterials = true;
                break;
              }
            }
          }

          // Failed to get materials for this batch size - try smaller
          if (cycleTarget === 100) {
            cycleTarget = 10;
            ctx.log("craft", `${recipe.name}: cannot get materials for 100x batch, trying 10x...`);
          } else if (cycleTarget === 10) {
            cycleTarget = 1;
            ctx.log("craft", `${recipe.name}: cannot get materials for 10x batch, trying 1x...`);
          } else {
            break; // Already at 1x, give up
          }
        }

        if (!gotMaterials && missingForCycle) {
          ctx.log("craft", `${recipe.name}: cannot get materials for even 1x batch, skipping`);
          missingSummary.push(`${recipe.name} (${missingForCycle.need}x ${missingForCycle.name} for ${cycleTarget}x batch)`);
          break;
        }

        // Small delay after withdrawal to ensure server has processed everything
        if (cycleTarget > 1) {
          await sleep(300);
        }

        // Now craft in small batches from the withdrawn materials
        let craftedInCycle = 0;
        while (craftedInCycle < cycleTarget && bot.state === "running") {
          const remainingInCycle = cycleTarget - craftedInCycle;
          const batchSize = Math.min(remainingInCycle, 10);

          yield `craft_${recipeId}`;
          const craftResp = await bot.exec("craft", { recipe_id: recipeId, count: batchSize });

          if (craftResp.error) {
            const msg = craftResp.error.message.toLowerCase();
            if (msg.includes("skill")) {
              hitSkillBlock = true;
              break;
            } else if (msg.includes("material") || msg.includes("component") || msg.includes("insufficient")) {
              // Out of materials in cargo - stop crafting this cycle, will withdraw more next outer iteration
              ctx.log("craft", `${recipe.name}: ran out of materials in cargo after ${craftedInCycle}x in this cycle`);
              break;
            } else {
              ctx.log("error", `Craft ${recipe.name}: ${craftResp.error.message}`);
              break;
            }
          }

          const result = craftResp.result as Record<string, unknown> | undefined;

          // Parse actual output quantity from craft response
          // Response may have: { count, quantity, items: [{ quantity }], output: { quantity }, produced: [...] }
          let actualOutputQty = 0;
          if (result) {
            // Try direct count/quantity fields first
            actualOutputQty = (result.count as number) || (result.quantity as number) || 0;

            // If no direct count, check for items/output arrays
            if (actualOutputQty === 0) {
              const items = (result.items as Array<Record<string, unknown>>) ||
                           (result.output as Array<Record<string, unknown>>) ||
                           (result.produced as Array<Record<string, unknown>>);
              if (items && items.length > 0) {
                // Sum up quantities from all output items
                for (const item of items) {
                  actualOutputQty += (item.quantity as number) || (item.count as number) || 0;
                }
              }
            }

            // Fallback: use recipe's output_quantity * batchSize
            if (actualOutputQty === 0) {
              actualOutputQty = (recipe.output_quantity || 1) * batchSize;
            }
          } else {
            actualOutputQty = (recipe.output_quantity || 1) * batchSize;
          }

          craftedInCycle += actualOutputQty;
          crafted += actualOutputQty;
          totalCrafted += actualOutputQty;
          bot.stats.totalCrafted += actualOutputQty;

          // Progress logging
          const pct = Math.round((crafted / needed) * 100);
          ctx.log("craft", `${recipe.name}: ${crafted}/${needed} (${pct}%) - crafted ${actualOutputQty}x`);
        }

        // If we couldn't craft anything in this cycle, break out
        if (craftedInCycle === 0) break;
      }

      if (crafted > 0) {
        craftedSummary.push(`${crafted}x ${recipe.name}`);
      }

      // ── Skill too low: try grinding XP on configured recipes only ──
      if (hitSkillBlock && bot.state === "running") {
        const allowedIds = new Set(settings.craftLimits.map(cl => cl.recipeId));
        let xpCrafted = await grindCraftingXP(ctx, recipes, recipeIndex, allowedIds);
        if (xpCrafted.length === 0) {
          // Fallback: search all recipes for anything we have ingredients for right now
          xpCrafted = await grindCraftingXP(ctx, recipes, recipeIndex);
        }
        if (xpCrafted.length > 0) {
          skillSummary.push(`${recipe.name} (skill too low, ground ${xpCrafted.join(", ")} for XP)`);
        } else {
          skillSummary.push(`${recipe.name} (skill too low, no XP recipes available)`);
        }
      }
    }

    // ── Deposit crafted goods and clear personal storage to faction storage ──
    if (bot.docked) {
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
    }

    // ── Single summary line ──
    const parts: string[] = [];
    if (craftedSummary.length > 0) parts.push(`Crafted ${craftedSummary.join(", ")}`);
    if (prereqSummary.length > 0) parts.push(`Prereqs: ${prereqSummary.join(", ")}`);
    if (atLimitCount.count > 0) parts.push(`${atLimitCount.count} at limit`);
    if (skillSummary.length > 0) parts.push(`Skill: ${skillSummary.join(", ")}`);
    if (missingSummary.length > 0) parts.push(`Missing: ${missingSummary.join(", ")}`);
    if (parts.length > 0) {
      ctx.log("craft", parts.join(". "));
    } else {
      ctx.log("craft", "Nothing to craft");
    }

    // ── Refuel + Repair ──
    yield "refuel";
    await ensureFueled(ctx, settings.refuelThreshold);
    yield "repair";
    await repairShip(ctx);

    // ── Check for skill level-ups ──
    yield "check_skills";
    await bot.checkSkills();

    // ── Wait before next cycle ──
    ctx.log("info", "Waiting 60s before next crafting cycle...");
    await sleep(10000);
  }
};
