import type { Routine, RoutineContext } from "../bot.js";
import { catalogStore } from "../catalogstore.js";
import { updateFactionStorageCache, getFactionStorageCache, getFactionStorageCacheByStationOnly } from "../factionStorageCache.js";
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
import {
  calculateCraftingPlan,
  calculateMultiGoalPlan,
  formatCraftingPlan,
  isRecipeCraftable as isRecipeCraftableNew,
} from "./craft-goals.js";

// ── Custom faction storage refresh for debugging ──

function parseFactionStorageItems(result: unknown): Array<{itemId: string, name: string, quantity: number}> {
  if (!result || typeof result !== "object") return [];

  const r = result as Record<string, unknown>;

  let items: Array<Record<string, unknown>> = [];
  if (Array.isArray(r)) {
    items = r;
  } else {
    const possibleFields = ['items', 'cargo', 'storage', 'stored_items', 'faction_items', 'faction_storage', 'data', 'result'];
    for (const field of possibleFields) {
      if (Array.isArray(r[field])) {
        items = r[field] as Array<Record<string, unknown>>;
        break;
      }
    }
  }

  if (items.length === 0) return [];

  return items.map((item) => {
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

async function refreshFactionStorageDirectly(ctx: RoutineContext, bot: any): Promise<void> {
  const station = bot.poi;
  const resp = await bot.exec("view_storage", { target: "faction" });

  if (resp.error) {
    if (bot.faction) {
      ctx.log("craft", `Could not refresh faction storage: ${resp.error.message}`);
    }
    return;
  }

  if (resp.result === null || resp.result === undefined) {
    bot.factionStorage = [];
    return;
  }

  const result = resp.result as Record<string, unknown>;
  const items = parseFactionStorageItems(result);

  let factionName = (result.faction_name as string) || (result.faction_id as string) || bot.faction;
  if (!factionName && station) {
    const cached = getFactionStorageCacheByStationOnly(station);
    if (cached) {
      factionName = cached.factionName;
    }
  }
  if (!factionName) {
    return;
  }

  bot.factionStorage = items;
  if (bot.faction !== factionName) {
    bot.faction = factionName;
  }
  updateFactionStorageCache(factionName, items, station);
}

// ── Settings ─────────────────────────────────────────────────

interface CraftLimit {
  recipeId: string;
  limit: number;
}

interface CrafterProfile {
  name: string;
  craftLimits: CraftLimit[];
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
const DEFAULT_BLACKLISTED_RECIPES = new Set([
  "basic_silicon_refinement", // Noob trap - severe waste of basic materials
  "fabricate_circuit_boards", // Force base materials only - never use expensive alternate paths
  "synthesize_energy_crystal", // Extremely wasteful - raw materials are easier to obtain
  "synthesize_xenon_power_cell", // Extremely wasteful - raw materials are easier to obtain
  "chlorine_circuit_etching", // Extremely wasteful - raw materials are easier to obtain
]);

/** Get the current set of blacklisted recipes (combines defaults with user-configured). */
export function getBlacklistedRecipes(): Set<string> {
  const all = readSettings();
  const c = all.crafter || {};
  const userBlacklisted = (c.blacklistedRecipes as string[]) || [];
  return new Set([...DEFAULT_BLACKLISTED_RECIPES, ...userBlacklisted]);
}

/** Recipes that should be heavily penalized - only use as absolute last resort */
const PENALTY_RECIPES: Record<string, number> = {
  "synthesize_bio_polymer": -1000, // Massive penalty - materials better suited for other recipes
};

/** Processing mode for goal-based crafting */
type GoalProcessingMode = "batch" | "round-robin";

export function getCrafterSettings(): {
  crafters: CrafterProfile[];
  botCrafterAssignments: Record<string, string>; // botName -> crafterName
  enabledCategories: string[];
  refuelThreshold: number;
  repairThreshold: number;
  categoryAssignments: Record<string, string[]>;
  botQuotaOverrides: Record<string, Record<string, number>>;
  goalProcessingMode: GoalProcessingMode;
  autoBuy: AutoBuySettings;
  blacklistedRecipes: string[];
  useQueuedCrafting: boolean;
} {
  const all = readSettings();
  const c = all.crafter || {};

  const blacklistedRecipes: string[] = (c.blacklistedRecipes as string[]) || [
    "basic_silicon_refinement",
    "fabricate_circuit_boards",
    "synthesize_energy_crystal",
    "synthesize_xenon_power_cell",
    "chlorine_circuit_etching",
  ];

  const useQueuedCrafting: boolean = (c.useQueuedCrafting as boolean) ?? true;



  // Handle migration from old single crafter format
  let crafters: CrafterProfile[] = [];
  if (Array.isArray(c.crafters)) {
    // New format with multiple crafters
    crafters = (c.crafters as Array<{name: string, craftLimits: any}>).map((profile, index) => {
      const rawLimits = profile.craftLimits || [];
      const craftLimits: CraftLimit[] = [];

      if (Array.isArray(rawLimits)) {
        // New array format: [{ recipeId: string, limit: number }, ...]
        for (const item of rawLimits) {
          if (item && typeof item === 'object' && item.recipeId && typeof item.limit === 'number' && item.limit > 0) {
            // Filter out Ship Passive recipes - they can't be crafted manually
            if (SHIP_PASSIVE_RECIPE_IDS.has(item.recipeId)) {
              continue; // Skip silently
            }
            craftLimits.push({ recipeId: item.recipeId, limit: item.limit });
          } else {
            // Invalid item
          }
        }
      } else if (typeof rawLimits === 'object') {
        // Old object format: { recipeId: limit, ... }
        for (const [recipeId, limit] of Object.entries(rawLimits)) {
          if (typeof limit === 'number' && limit > 0) {
            // Filter out Ship Passive recipes - they can't be crafted manually
            if (SHIP_PASSIVE_RECIPE_IDS.has(recipeId)) {
              continue; // Skip silently
            }
            craftLimits.push({ recipeId, limit });
          }
        }
      }
      return { name: profile.name || 'Unnamed Crafter', craftLimits };
    });
  } else if (c.craftLimits) {
    // Migrate old single crafter format
    const rawLimits = c.craftLimits;
    const craftLimits: CraftLimit[] = [];

    if (Array.isArray(rawLimits)) {
      // Array format
      for (const item of rawLimits) {
        if (item && typeof item === 'object' && item.recipeId && typeof item.limit === 'number' && item.limit > 0) {
          if (SHIP_PASSIVE_RECIPE_IDS.has(item.recipeId)) {
            continue;
          }
          craftLimits.push({ recipeId: item.recipeId, limit: item.limit });
        }
      }
    } else if (typeof rawLimits === 'object') {
      // Object format
      for (const [recipeId, limit] of Object.entries(rawLimits)) {
        if (typeof limit === 'number' && limit > 0) {
          if (SHIP_PASSIVE_RECIPE_IDS.has(recipeId)) {
            continue;
          }
          craftLimits.push({ recipeId, limit });
        }
      }
    }

    if (craftLimits.length > 0) {
      crafters.push({ name: "Default Crafter", craftLimits });
    }
  }

  // If no crafters exist, create a default one
  if (crafters.length === 0) {
    crafters.push({ name: "Default Crafter", craftLimits: [] });
  }

  // Per-bot crafter assignments
  const botCrafterAssignments = (c.botCrafterAssignments as Record<string, string>) || {};

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
    crafters,
    botCrafterAssignments,
    enabledCategories,
    refuelThreshold: (c.refuelThreshold as number) || 50,
    repairThreshold: (c.repairThreshold as number) || 40,
    categoryAssignments,
    botQuotaOverrides,
    goalProcessingMode,
    autoBuy,
    blacklistedRecipes,
    useQueuedCrafting,
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

/**
 * Check the current crafting queue status.
 * Returns an array of active job IDs.
 */
async function checkCraftingQueue(bot: any): Promise<string[]> {
  const resp = await bot.exec("craft", { action: "queue" });
  
  if (resp.error) {
    return [];
  }
  
  const result = resp.result as Record<string, unknown> | undefined;
  const jobs = (result?.jobs as Array<Record<string, unknown>>) || [];
  
  return jobs.map((job: Record<string, unknown>) => {
    // Handle both 'recipe' and 'recipe_id' field names
    const recipeId = (job.recipe_id as string) || (job.recipe as string) || "";
    const qty = (job.quantity as number) || 0;
    return `${recipeId}:${qty}`;
  });
}

/**
 * Queue a bulk crafting job.
 * Returns { success: true } or { success: false, error: string }.
 * Uses preset="workshop" to force hand-crafting and avoid facility rental fees.
 * Generates local job IDs since the server may not return them.
 */
async function queueBulkCraftJob(
  ctx: RoutineContext,
  jobs: Array<{ recipe_id: string; quantity: number; recipe_name?: string }>,
  bot: any,
): Promise<{ success: boolean; error?: string; jobIds?: string[] }> {
  const { log } = ctx;
  
  if (jobs.length === 0) {
    return { success: true };
  }

  if (jobs.length > 50) {
    log("craft", `Bulk job truncated: ${jobs.length} > 50 max`);
    jobs = jobs.slice(0, 50);
  }

  log("craft", `Queueing bulk craft: ${jobs.map(j => `${j.quantity}x ${j.recipe_id}`).join(", ")}`);

  const craftResp = await bot.exec("craft", {
    jobs: jobs.map(j => ({
      recipe_id: j.recipe_id,
      quantity: j.quantity,
      preset: "workshop",
    })),
  });

  if (craftResp.error) {
    log("error", `Failed to queue bulk craft: ${craftResp.error.message}`);
    return { success: false, error: craftResp.error.message };
  }

  const result = craftResp.result as Record<string, unknown> | undefined;
  const serverJobIds = (result?.job_ids as string[]) || [];
  
  // Generate local job IDs if server didn't return them
  const jobIds: string[] = [];
  for (const j of jobs) {
    // Use recipe_name if available, otherwise fall back to recipe_id
    const recipeName = j.recipe_name || j.recipe_id;
    const localId = `${recipeName}:${j.quantity}`;
    jobIds.push(localId);
    bot.queuedCraftingJobs?.add(localId);
  }
  
  if (serverJobIds.length > 0) {
    log("craft", `Queued ${serverJobIds.length} crafting job(s) from server`);
  } else {
    log("craft", `Queued ${jobIds.length} crafting job(s) (local IDs)`);
  }

  return { success: true, jobIds };
}

/**
 * Perform a dry run to check costs before queuing a craft job.
 * Returns { affordable: boolean, cost?: number, error?: string }.
 */
async function dryRunCraftCost(
  ctx: RoutineContext,
  recipeId: string,
  quantity: number,
  bot: any,
): Promise<{ affordable: boolean; cost?: number; error?: string }> {
  const { log } = ctx;

  const resp = await bot.exec("craft", {
    id: recipeId,
    quantity: quantity,
    preset: "workshop",
    dry_run: true,
  });

  if (resp.error) {
    const msg = resp.error.message.toLowerCase();
    if (msg.includes("afford") || msg.includes("cost") || msg.includes("insufficient")) {
      return { affordable: false, error: resp.error.message };
    }
    return { affordable: false, error: resp.error.message };
  }

  const result = resp.result as Record<string, unknown> | undefined;
  const cost = (result?.cost as number) || (result?.total_cost as number) || 0;
  const canAfford = (result?.can_afford as boolean) ?? (bot.credits >= cost);

  return { affordable: canAfford, cost };
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
    const blacklistedRecipes = getBlacklistedRecipes();
    for (const r of allRecipesForComp) {
      // Skip blacklisted recipes
      if (blacklistedRecipes.has(r.recipe_id)) continue;

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

    // Deficit is in items, need to convert to batches for the plan
    const outputQty = prereqRecipe.output_quantity || 1;
    const batchesNeeded = Math.ceil(deficit / outputQty);

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

    const totalItemsNeeded = batchesNeeded * outputQty;

    // Queue the prerequisite craft job
    const queueResult = await queueBulkCraftJob(ctx, [
      { recipe_id: prereqRecipe.recipe_id, quantity: totalItemsNeeded },
    ], bot);

    if (!queueResult.success) {
      ctx.log("craft", `Failed to queue prerequisite ${prereqRecipe.name}: ${queueResult.error}`);
      continue;
    }

    ctx.log("craft", `Queued prerequisite ${totalItemsNeeded}x ${prereqRecipe.name}`);
    crafted.push(`${totalItemsNeeded}x ${prereqRecipe.output_name || prereqRecipe.name}`);
    bot.stats.totalCrafted += totalItemsNeeded;
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
    const blacklistedRecipes = getBlacklistedRecipes();
    if (blacklistedRecipes.has(recipe.recipe_id)) continue;

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
      const dResp = await bot.exec("storage", { action: "deposit", target: "faction", item_id: item.itemId, quantity: item.quantity, source: "cargo" });
      if (dResp.error) {
        await bot.exec("deposit_items", { storage_unit_id: bot.poi, item_id: item.itemId, quantity: item.quantity, source: "cargo" });
      }
    }
  }
  await bot.refreshCargo();
  await bot.refreshLocation();

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

    ctx.log("craft", `Queueing craft for ${target.category}: ${target.name} (${target.components.map(c => `${c.quantity}x ${c.name}`).join(", ")})...`);

    // Queue 1 item at a time in categories mode
    const actualItems = 1;

    // Queue the craft job
    const queueResult = await queueBulkCraftJob(ctx, [
      { recipe_id: target.recipe_id, quantity: actualItems },
    ], bot);

    if (!queueResult.success) {
      ctx.log("error", `Failed to queue ${target.name}: ${queueResult.error}`);
      const idx = candidates.findIndex(c => c.recipe === target);
      if (idx !== -1) candidates.splice(idx, 1);
      if (candidates.length === 0) break;
      continue;
    }

    ctx.log("craft", `Queued ${actualItems}x ${target.name}`);
    crafted.push(`${actualItems}x ${target.output_name || target.name}`);
    bot.stats.totalCrafted += actualItems;
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
    ctx.log("craft", `${indent}→ ${item.quantityToCraft}x ${item.recipe.name} (${item.reason})`);
  }

  // Process each recipe in order (prerequisites first due to flattenTree ordering)
  // Queue full quantities - server will process one-by-one and notify on completion
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

  return { crafted, prereqs };
}


/**
 * Craft a specific quantity of a recipe, handling prerequisites and material withdrawal.
 * Uses the new queued crafting system with bulk mode and preset="workshop".
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

  // quantityToCraft is in ITEMS (from craft-goals.ts planning)
  const totalItemsToCraft = quantityToCraft;

  ctx.log("craft", `Queueing ${totalItemsToCraft}x ${recipe.name}...`);

  // Check if already queued (use recipe_id since that's what notifications return)
  if (bot.isCraftingJobQueued(recipe.recipe_id, totalItemsToCraft)) {
    ctx.log("craft", `Job already queued for ${recipe.name}, skipping`);
    return { crafted: 0, prereqsCrafted: [] };
  }

  // Check materials (station storage is now the source for crafting)
  const maxCraftable = calculateMaxCraftable(ctx, recipe, personalMode);
  if (maxCraftable <= 0) {
    ctx.log("craft", `${recipe.name}: no materials available in station storage`);
    return { crafted: 0, prereqsCrafted: [] };
  }

  // Queue the full quantity in one job - server will process one by one
  const actualItems = Math.min(totalItemsToCraft, maxCraftable);

  // Queue the craft job using bulk mode with full quantity
  const queueResult = await queueBulkCraftJob(ctx, [
    { recipe_id: recipe.recipe_id, quantity: actualItems, recipe_name: recipe.name },
  ], bot);

  if (!queueResult.success) {
    ctx.log("error", `Failed to queue ${recipe.name}: ${queueResult.error}`);
    return { crafted: 0, prereqsCrafted: [] };
  }

  // Mark as queued using recipe_id (matches notification format)
  bot.queueCraftingJob(recipe.recipe_id, actualItems);
  ctx.log("craft", `Queued ${actualItems}x ${recipe.name}`);
  bot.stats.totalCrafted += actualItems;

  return { crafted: actualItems, prereqsCrafted };
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

  await bot.refreshLocation();

  while (bot.state === "running") {
    // Clear facility cache at start of each cycle
    cachedActiveFacilityMaterials = [];

    // ── Death recovery ──
    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) { await ctx.sleep(30000); continue; }

    let settings = getCrafterSettings();

    // ── Scavenge wrecks before docking ──
    yield "scavenge";
    await scavengeWrecks(ctx);

    // ── Dock at station ──
    yield "dock";
    await bot.refreshLocation();
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
        if (!personalMode) {
          const dResp = await bot.exec("storage", { action: "deposit", target: "faction", item_id: item.itemId, quantity: item.quantity, source: "cargo" });
          if (dResp.error) {
            await bot.exec("deposit_items", { storage_unit_id: bot.poi, item_id: item.itemId, quantity: item.quantity, source: "cargo" });
          }
        } else {
          await bot.exec("deposit_items", { storage_unit_id: bot.poi, item_id: item.itemId, quantity: item.quantity, source: "cargo" });
        }
      }
      await bot.refreshCargo();
      await bot.refreshLocation();
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

    // ── Re-read settings to pick up any changes made during the cycle ──
    settings = getCrafterSettings();

    // ── Determine which crafter profile this bot should use ──
    const assignedCrafterName = settings.botCrafterAssignments[botName] || "Default Crafter";
    const assignedCrafter = settings.crafters.find(c => c.name === assignedCrafterName) || settings.crafters[0];
    ctx.log("craft", `Bot assigned to crafter profile: ${assignedCrafter.name}`);

    // ── Determine effective quotas for this bot (crafter profile + bot-specific overrides) ──
    const effectiveQuotas = new Map<string, number>();
    // First, add crafter profile quotas
    if (assignedCrafter && Array.isArray(assignedCrafter.craftLimits)) {
      for (const { recipeId, limit } of assignedCrafter.craftLimits) {
        if (recipeId && typeof limit === 'number' && limit > 0) {
          effectiveQuotas.set(recipeId, limit);
        }
      }
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

    // ── Check existing crafting queue to avoid duplicate submissions ──
    const queuedJobs = bot.docked ? await checkCraftingQueue(bot) : [];
    if (queuedJobs.length > 0) {
      ctx.log("craft", `Found ${queuedJobs.length} jobs in queue`);
      for (const jobId of queuedJobs) {
        bot.queueCraftingJob(jobId.split(":")[0], parseInt(jobId.split(":")[1]) || 0);
      }
    }

    // ── Build list of goal items to craft ──
    ctx.log("craft", `🎯 Processing ${effectiveQuotas.size} crafting goals...`);
    const goalItems: Array<{ itemId: string; quantity: number; recipe?: Recipe }> = [];

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

      // If the match was on output_item_id, treat it as an item goal, not a specific recipe
      const isItemGoal = recipe.output_item_id === recipeId || recipe.output_item_id.toLowerCase() === recipeId.toLowerCase();

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
      goalItems.push({ itemId: recipe.output_item_id, quantity: needed, recipe: isItemGoal ? undefined : recipe });
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
        
        const dResp = await bot.exec("storage", { action: "deposit", target: "faction", item_id: item.itemId, quantity: item.quantity, source: "cargo" });
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

        const transferResp = await bot.exec("storage", { action: "deposit", target: "faction", item_id: item.itemId, quantity: item.quantity, source: "storage" });
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
      const withdrawResp = await bot.exec("storage", { action: 'withdraw', target: 'faction', item_id: 'credits', quantity: needed }); // NEVER CHANGE THIS - credits must be withdrawn from faction storage using target=faction
      if (withdrawResp.error) {
        ctx.log("coord", `Cannot withdraw ${needed}cr for ${member.username}: ${withdrawResp.error.message}`);
        break; // treasury likely empty
      }
      logFactionActivity(ctx, "withdraw", `Withdrew ${needed}cr from treasury for ${member.username}`);
      const giftResp = await bot.exec("storage", { action: 'deposit', target: member.username, item_id: 'credits', quantity: needed }); // NEVER CHANGE THIS - deposit credits to member's storage
      if (giftResp.error) {
        ctx.log("coord", `Gift to ${member.username} failed: ${giftResp.error.message}`);
        // Re-deposit withdrawn credits back
        await bot.exec("storage", { action: 'deposit', target: 'faction', item_id: 'credits', quantity: needed }); // NEVER CHANGE THIS - refund to faction storage
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
