import type { Routine, RoutineContext } from "../bot.js";
import {
  ensureDocked,
  repairShip,
  ensureFueled,
  detectAndRecoverFromDeath,
} from "./common.js";
import {
  calculateMultiGoalPlan,
  formatCraftingPlan,
  isRecipeCraftable as isRecipeCraftableNew,
} from "./craft-goals.js";
import { CraftQueueTracker, ServerJobInfo } from "./craftQueueTracker.js";

// ── Settings ─────────────────────────────────────────────────

interface CraftLimit {
  recipeId: string;
  limit: number;
}

interface CrafterProfile {
  name: string;
  craftLimits: CraftLimit[];
}

async function getCrafterSettings(): Promise<{
  crafters: CrafterProfile[];
  botCrafterAssignments: Record<string, string>;
  enabledCategories: string[];
  refuelThreshold: number;
  repairThreshold: number;
  categoryAssignments: Record<string, string[]>;
  botQuotaOverrides: Record<string, Record<string, number>>;
  goalProcessingMode: string;
  autoBuy: {
    enabled: boolean;
    maxPricePercentOverBase: number;
    maxCreditsPerCycle: number;
    excludeCategories: string[];
  };
  blacklistedRecipes: string[];
  useQueuedCrafting: boolean;
}> {
  const text = await Bun.file(`${import.meta.dir}/../../data/settings.json`).text();
  const raw = JSON.parse(text || "{}");
  const c = (raw.crafter as Record<string, unknown>) || {};

  const blacklistedRecipes: string[] = ((c.blacklistedRecipes as string[]) || [
    "basic_silicon_refinement",
    "fabricate_circuit_boards",
    "synthesize_energy_crystal",
    "synthesize_xenon_power_cell",
    "chlorine_circuit_etching",
  ]) as string[];

  const useQueuedCrafting = (c.useQueuedCrafting as boolean) ?? true;

  let crafters: CrafterProfile[] = [];
  if (Array.isArray(c.crafters)) {
    crafters = (c.crafters as Array<{name: string, craftLimits: any}>).map(profile => {
      const rawLimits = profile.craftLimits || [];
      const craftLimits: CraftLimit[] = [];
      if (Array.isArray(rawLimits)) {
        for (const item of rawLimits) {
          if (item && typeof item === 'object' && item.recipeId && typeof item.limit === 'number' && item.limit > 0) {
            craftLimits.push({ recipeId: item.recipeId, limit: item.limit });
          }
        }
      } else if (typeof rawLimits === 'object') {
        for (const [recipeId, limit] of Object.entries(rawLimits)) {
          if (typeof limit === 'number' && limit > 0) {
            craftLimits.push({ recipeId, limit });
          }
        }
      }
      return { name: profile.name || 'Unnamed Crafter', craftLimits };
    });
  } else if (c.craftLimits) {
    const rawLimits = c.craftLimits;
    const craftLimits: CraftLimit[] = [];
    if (Array.isArray(rawLimits)) {
      for (const item of rawLimits) {
        if (item && typeof item === 'object' && item.recipeId && typeof item.limit === 'number' && item.limit > 0) {
          craftLimits.push({ recipeId: item.recipeId, limit: item.limit });
        }
      }
    } else if (typeof rawLimits === 'object') {
      for (const [recipeId, limit] of Object.entries(rawLimits)) {
        if (typeof limit === 'number' && limit > 0) {
          craftLimits.push({ recipeId, limit });
        }
      }
    }
    if (craftLimits.length > 0) {
      crafters.push({ name: "Default Crafter", craftLimits });
    }
  }

  if (crafters.length === 0) {
    crafters.push({ name: "Default Crafter", craftLimits: [] });
  }

  const botCrafterAssignments = ((c.botCrafterAssignments as Record<string, string>) || {}) as Record<string, string>;
  const enabledCategories = ((c.enabledCategories as string[]) || ["Refining", "Components", "Consumables"]) as string[];
  const refuelThreshold = (c.refuelThreshold as number) || 50;
  const repairThreshold = (c.repairThreshold as number) || 40;
  const categoryAssignments = ((c.categoryAssignments as Record<string, string[]>) || {}) as Record<string, string[]>;
  const botQuotaOverrides = ((c.botQuotaOverrides as Record<string, Record<string, number>>) || {}) as Record<string, Record<string, number>>;
  const goalProcessingMode = (c.goalProcessingMode as string) || "batch";
  const autoBuyConfig = (c.autoBuy as Partial<{
    enabled: boolean;
    maxPricePercentOverBase: number;
    maxCreditsPerCycle: number;
    excludeCategories: string[];
  }>) || {};
  const autoBuy = {
    enabled: autoBuyConfig.enabled ?? false,
    maxPricePercentOverBase: autoBuyConfig.maxPricePercentOverBase ?? 150,
    maxCreditsPerCycle: autoBuyConfig.maxCreditsPerCycle ?? 50000,
    excludeCategories: autoBuyConfig.excludeCategories ?? ["ammo"],
  };

  return {
    crafters,
    botCrafterAssignments,
    enabledCategories,
    refuelThreshold,
    repairThreshold,
    categoryAssignments,
    botQuotaOverrides,
    goalProcessingMode,
    autoBuy,
    blacklistedRecipes,
    useQueuedCrafting,
  };
}

// ── Recipe helpers ────────────────────────────────────────────

interface Recipe {
  recipe_id: string;
  name: string;
  components: Array<{ item_id: string; name: string; quantity: number }>;
  output_item_id: string;
  output_name: string;
  output_quantity: number;
  category?: string;
  effective_time_per_run?: number;
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
    const parsed = parseRecipes(resp.result);
    all.push(...parsed);
    const r = resp.result as Record<string, unknown> | undefined;
    const totalPages = (r?.total_pages as number) || 1;
    if (page >= totalPages || parsed.length === 0) break;
    page++;
  }
  return all;
}

// ── Queue-focused crafting logic ──────────────────────────────

async function checkCraftingQueue(bot: any, recipes: Recipe[]): Promise<ServerJobInfo[]> {
  const resp = await bot.exec("craft", { action: "queue" });
  if (resp.error) return [];
  const result = resp.result as Record<string, unknown> | undefined;
  const jobs = (result?.jobs as Array<Record<string, unknown>>) || [];
  const recipeNameToId = new Map<string, string>();
  const recipeOutputNameToId = new Map<string, string>();
  const recipeOutputItemToId = new Map<string, string>();
  const recipeIdToId = new Map<string, string>();
  for (const r of recipes) {
    recipeNameToId.set(r.name.toLowerCase(), r.recipe_id);
    if (r.output_name) {
      recipeOutputNameToId.set(r.output_name.toLowerCase(), r.recipe_id);
    }
    if (r.output_item_id) {
      recipeOutputItemToId.set(r.output_item_id.toLowerCase(), r.recipe_id);
    }
    recipeIdToId.set(r.recipe_id, r.recipe_id);
  }
  return jobs.map((job: Record<string, unknown>) => {
    const recipeName = ((job.recipe as string) || "").toLowerCase();
    const recipeFromId = (job.recipe as string) || "";
    const recipeId = recipeNameToId.get(recipeName) 
      || recipeOutputNameToId.get(recipeName) 
      || recipeOutputItemToId.get(recipeName)
      || recipeIdToId.get(recipeFromId)
      || recipeFromId;
    return {
      jobId: (job.job_id as string) || "",
      recipeId,
      quantity: (job.runs_total as number) || 0,
      runsDone: (job.runs_done as number) || 0,
      runsRemaining: (job.runs_remaining as number) || 0,
    };
  }).filter(j => j.jobId && j.recipeId);
}

async function getEstimatedCraftingTime(recipeId: string, recipes: Recipe[]): Promise<number> {
  const recipe = recipes.find(r => r.recipe_id === recipeId);
  return recipe?.effective_time_per_run || 0;
}

async function syncCraftingQueue(ctx: RoutineContext, tracker: CraftQueueTracker, recipes: Recipe[]): Promise<void> {
  const { bot } = ctx;
  const serverJobs = await checkCraftingQueue(bot, recipes);
  ctx.log("craft", `DEBUG: syncCraftingQueue - Found ${serverJobs.length} jobs from server`);
  for (const job of serverJobs) {
    ctx.log("craft", `DEBUG:   Job ${job.jobId.substring(0, 8)}... recipe=${job.recipeId}, quantity=${job.quantity}, done=${job.runsDone}, remaining=${job.runsRemaining}`);
  }
  tracker.syncWithServer(serverJobs);
  tracker.save();
}

async function queueCraftJob(
  ctx: RoutineContext,
  recipeId: string,
  quantity: number,
  bot: any,
  tracker: CraftQueueTracker,
  recipes?: Recipe[],
): Promise<{ success: boolean; error?: string; jobId?: string }> {
  const { log } = ctx;

  const recipe = recipes?.find(r => r.recipe_id === recipeId);
  const outputQty = recipe?.output_quantity || 1;
  const runs = Math.ceil(quantity / outputQty);

  if (tracker.hasPendingJob(recipeId, runs)) {
    return { success: true, error: "Job already queued" };
  }

  const serverJobs = await checkCraftingQueue(bot, recipes || []);
  tracker.syncWithServer(serverJobs);
  if (tracker.hasPendingJob(recipeId, runs)) {
    return { success: true, error: "Job already queued" };
  }

  log("craft", `Queueing ${runs} runs of ${recipeId} (preset=workshop)...`);
  const craftResp = await bot.exec("craft", {
    id: recipeId,
    quantity: runs,
    preset: "workshop",
  });

  if (craftResp.error) {
    const msg = craftResp.error.message;
    if (msg.toLowerCase().includes("insufficient")) {
      return { success: false, error: "insufficient_inputs" };
    }
    return { success: false, error: msg };
  }

  const result = craftResp.result as Record<string, unknown> | undefined;
  const details = (result as Record<string, unknown> | undefined)?.details as Record<string, unknown> | undefined;
  const jobId = (details?.job_id as string) || (result?.job_id as string) || "";

  if (!jobId) {
    return { success: false, error: "No job_id returned from craft command" };
  }

  tracker.trackJob(jobId, recipeId, runs);
  bot.queueCraftingJob(recipeId, runs);
  tracker.save();

  log("craft", `Queued ${runs} runs of ${recipeId} (job_id=${jobId})`);
  return { success: true, jobId };
}

// ── Wait for completion ───────────────────────────────────────

async function waitForCompletion(
  ctx: RoutineContext,
  recipeId: string,
  quantityItems: number,
  tracker: CraftQueueTracker,
  bot: any,
  estimatedTicks: number = 0,
  outputQty: number = 1,
  recipes: Recipe[] = [],
): Promise<boolean> {
  const { log } = ctx;
  const timeoutMs = (estimatedTicks ? estimatedTicks * 2 + 10 : 10) * 10000;
  const startTime = Date.now();

  const serverJobIds = await checkCraftingQueue(bot, recipes);
  tracker.syncWithServer(serverJobIds);
  tracker.save();

  const progress = tracker.getProgress(recipeId);
  const queuedItems = progress.queued * outputQty;
  const completedItems = progress.completed * outputQty;
  if (queuedItems >= quantityItems) {
    return true;
  }

  while (bot.state === "running") {
    if (Date.now() - startTime > timeoutMs) {
      const latestJobIds = await checkCraftingQueue(bot, recipes);
      tracker.syncWithServer(latestJobIds);
      tracker.save();
      const progress = tracker.getProgress(recipeId);
      const currentCompletedItems = progress.completed * outputQty;
      if (currentCompletedItems >= quantityItems) {
        log("craft", `Crafting complete for ${recipeId} (timeout verification)`);
        return true;
      }
    }

    await ctx.sleep(5000);

    const currentJobIds = await checkCraftingQueue(bot, recipes);
    tracker.syncWithServer(currentJobIds);
    tracker.save();

    const progress = tracker.getProgress(recipeId);
    const currentCompletedItems = progress.completed * outputQty;
    if (currentCompletedItems >= quantityItems) {
      log("craft", `Crafting complete for ${recipeId}`);
      return true;
    }
  }

  return false;
}

// ── Goal-based crafting execution ─────────────────────────────

async function executeCraftingPlan(
  ctx: RoutineContext,
  planItems: Array<{ recipe: Recipe; quantityToCraft: number; reason: string; depth: number }>,
  tracker: CraftQueueTracker,
  recipes: Recipe[],
): Promise<{ crafted: string[]; prereqs: string[] }> {
  const { bot } = ctx;
  const crafted: string[] = [];
  const prereqs: string[] = [];

  ctx.log("craft", `Queue-based crafting plan: ${planItems.length} steps`);

  await syncCraftingQueue(ctx, tracker, recipes);

  for (const item of planItems) {
    if (bot.state !== "running") break;

    const outputQty = item.recipe.output_quantity || 1;
    const progress = tracker.getProgress(item.recipe.recipe_id);
    const queuedItems = progress.queued * outputQty;
    const completedItems = progress.completed * outputQty;
    const totalScheduledItems = queuedItems + completedItems;

    const detailedProgress = tracker.getDetailedProgress(item.recipe.recipe_id);
    ctx.log("craft", `DEBUG: Recipe=${item.recipe.recipe_id}, Item=${item.recipe.output_name}, OutputQty=${outputQty}`);
    ctx.log("craft", `DEBUG:   Total: queuedRuns=${progress.queued}, completedRuns=${progress.completed}, queuedItems=${queuedItems}, completedItems=${completedItems}, TotalScheduled=${totalScheduledItems}, Goal=${item.quantityToCraft}`);
    for (const job of detailedProgress.jobs) {
      const jobItems = job.quantity * outputQty;
      ctx.log("craft", `DEBUG:   Job ${job.jobId.substring(0, 8)}... runs=${job.quantity}, done=${job.completed}, remaining=${job.runsRemaining}, produces=${jobItems} items`);
    }

    if (queuedItems >= item.quantityToCraft) {
      ctx.log("craft", `Already queued: ${item.recipe.name} (${queuedItems} items queued)`);
      continue;
    }

    const remainingItems = item.quantityToCraft - completedItems - queuedItems;
    if (remainingItems <= 0) {
      ctx.log("craft", `Already completed or queued: ${item.recipe.name}`);
      continue;
    }

    ctx.log("craft", `Queueing ${remainingItems}x ${item.recipe.name} (${item.reason})`);
    const estTime = await getEstimatedCraftingTime(item.recipe.recipe_id, recipes);
    const queueResult = await queueCraftJob(ctx, item.recipe.recipe_id, remainingItems, bot, tracker, recipes);
    if (!queueResult.success) {
      if (queueResult.error === "insufficient_inputs") {
        ctx.log("error", `Insufficient materials for ${item.recipe.name} - need ${remainingItems}x output`);
      } else if (queueResult.error !== "Job already queued") {
        ctx.log("error", `Failed to queue ${item.recipe.name}: ${queueResult.error}`);
      }
      continue;
    }

    await waitForCompletion(ctx, item.recipe.recipe_id, remainingItems, tracker, bot, estTime, outputQty, recipes);
    crafted.push(`${remainingItems}x ${item.recipe.output_name}`);
    bot.stats.totalCrafted += remainingItems;
  }

  return { crafted, prereqs };
}

// ── Craft from enabled categories ─────────────────────────────

async function craftFromCategories(
  ctx: RoutineContext,
  recipes: Recipe[],
  enabledCategories: string[],
  tracker: CraftQueueTracker,
): Promise<string[]> {
  const { bot } = ctx;
  const crafted: string[] = [];

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
  };

  const candidates: Array<{ recipe: Recipe; priority: number }> = [];

  for (const recipe of recipes) {
    const recipeCategory = recipe.category || "";
    if (!enabledCategories.includes(recipeCategory)) continue;

    const blacklisted = new Set((await getCrafterSettings()).blacklistedRecipes);
    if (blacklisted.has(recipe.recipe_id)) continue;
    if (recipe.components.length === 0) continue;
    if (!isRecipeCraftableNew(recipe).ok) continue;

    const priority = categoryPriority[recipeCategory] || 99;
    candidates.push({ recipe, priority });
  }

  if (candidates.length === 0) return crafted;

  candidates.sort((a, b) => a.priority - b.priority);

  const MAX_CRAFTS = 10;
  let totalCrafted = 0;

  while (totalCrafted < MAX_CRAFTS && bot.state === "running") {
    const serverJobIds = await checkCraftingQueue(bot, recipes);
    tracker.syncWithServer(serverJobIds);
    tracker.save();

    let target: Recipe | null = null;
    for (const candidate of candidates) {
      const outputQty = candidate.recipe.output_quantity || 1;
      const runsNeeded = Math.ceil(1 / outputQty);
      if (!tracker.hasPendingJob(candidate.recipe.recipe_id, runsNeeded)) {
        target = candidate.recipe;
        break;
      }
    }

    if (!target) {
      ctx.log("info", "No available recipes to queue");
      break;
    }

    const outputQty = target.output_quantity || 1;
    const runs = Math.ceil(1 / outputQty);
    ctx.log("craft", `Queueing ${runs} run(s) of ${target.name} (category: ${target.category})`);
    const queueResult = await queueCraftJob(ctx, target.recipe_id, 1, bot, tracker, recipes);
    if (!queueResult.success && queueResult.error !== "Job already queued") {
      const idx = candidates.findIndex(c => c.recipe === target);
      if (idx !== -1) candidates.splice(idx, 1);
      if (candidates.length === 0) break;
      continue;
    }

    crafted.push(`1x ${target.output_name}`);
    totalCrafted++;
    bot.stats.totalCrafted++;

    await ctx.sleep(2000);
  }

  return crafted;
}

// ── Main routine ──────────────────────────────────────────────

export const crafterRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  await bot.refreshLocation();
  
  // Initialize the queue tracker for this bot
  await bot.initCraftQueueTracker();

  while (bot.state === "running") {
    await detectAndRecoverFromDeath(ctx);
    if (bot.state !== "running") break;

    const settings = await getCrafterSettings();

    yield "scavenge";

    yield "dock";
    await ensureDocked(ctx);

    yield "fetch_recipes";
    const recipes = await fetchAllRecipes(ctx);
    if (recipes.length === 0) {
      ctx.log("error", "No recipes available - waiting 60s");
      await ctx.sleep(60000);
      continue;
    }

    yield "check_crafting_queue";
    const tracker = bot.craftQueueTracker!;
    await syncCraftingQueue(ctx, tracker, recipes);

    yield "refresh_storage";
    await bot.refreshFactionStorage();

    const recipeIndex = new Map<string, Recipe>();
    for (const r of recipes) {
      recipeIndex.set(r.recipe_id, r);
    }

    const botName = bot.username;
    const assignedCategories = (settings.categoryAssignments as Record<string, string[]>)[botName];
    const isSpecializedBot = assignedCategories && assignedCategories.length > 0;

    const assignedCrafterName = (settings.botCrafterAssignments as Record<string, string>)[botName] || "Default Crafter";
    const assignedCrafter = settings.crafters.find(c => c.name === assignedCrafterName) || settings.crafters[0];

    ctx.log("craft", `crafter bot=${botName} assignment=${assignedCrafterName} profileFound=${!!assignedCrafter} craftersCount=${settings.crafters.length}`);
    ctx.log("craft", `crafter craftLimits_raw type=${typeof assignedCrafter.craftLimits} isArray=${Array.isArray(assignedCrafter.craftLimits)} length=${(assignedCrafter.craftLimits as any).length}`);

    const effectiveQuotas = new Map<string, number>();
    const rawLimits = assignedCrafter.craftLimits;
    if (Array.isArray(rawLimits)) {
      for (const limit of rawLimits) {
        if (limit && typeof limit === 'object' && (limit as any).recipeId && typeof (limit as any).limit === 'number' && (limit as any).limit > 0) {
          effectiveQuotas.set((limit as any).recipeId, (limit as any).limit);
        }
      }
    } else if (typeof rawLimits === 'object' && rawLimits !== null) {
      for (const [recipeId, limit] of Object.entries(rawLimits as Record<string, number>)) {
        if (typeof limit === 'number' && limit > 0) {
          effectiveQuotas.set(recipeId, limit);
        }
      }
    }
    const botOverrides = (settings.botQuotaOverrides as Record<string, Record<string, number>>)[botName] || {};
    for (const [recipeId, limit] of Object.entries(botOverrides)) {
      if (typeof limit === 'number' && limit > 0) {
        effectiveQuotas.set(recipeId, limit);
      } else {
        effectiveQuotas.delete(recipeId);
      }
    }

    const factionStorage = bot.factionStorage || [];
    function countItem(itemId: string): number {
      let total = 0;
      for (const i of bot.inventory) { if (i.itemId === itemId) total += i.quantity; }
      for (const i of bot.storage) { if (i.itemId === itemId) total += i.quantity; }
      for (const i of factionStorage) { if (i.itemId === itemId) total += i.quantity; }
      return total;
    }

    ctx.log("craft", "Processing crafting goals...");
    const goalItems: Array<{ itemId: string; quantity: number; recipe?: Recipe }> = [];

    for (const [recipeId, limit] of Array.from(effectiveQuotas.entries())) {
      if (bot.state !== "running") break;

      const recipe = recipeIndex.get(recipeId) ||
        recipes.find(r =>
          r.recipe_id === recipeId ||
          r.name === recipeId ||
          r.name.toLowerCase() === recipeId.toLowerCase() ||
          r.output_item_id === recipeId ||
          r.output_item_id.toLowerCase() === recipeId.toLowerCase()
        );

      if (!recipe) {
        ctx.log("error", `Recipe "${recipeId}" not found`);
        continue;
      }

      const isItemGoal = recipe.output_item_id === recipeId || recipe.output_item_id.toLowerCase() === recipeId.toLowerCase();
      const craftableCheck = isRecipeCraftableNew(recipe);
      if (!craftableCheck.ok) {
        ctx.log("error", `Recipe "${recipeId}" (${recipe.name}) is not craftable: ${craftableCheck.reason}`);
        continue;
      }

      const recipeCategory = recipe.category || "";
      if (isSpecializedBot && !assignedCategories.includes(recipeCategory)) {
        ctx.log("craft", `Skipping "${recipeId}" (${recipe.name}): category not assigned to this bot`);
        continue;
      }

      const currentStock = countItem(recipe.output_item_id);
      const needed = limit - currentStock;
      if (needed <= 0) {
        ctx.log("craft", `✓ ${recipe.name}: already have ${currentStock}/${limit}`);
        continue;
      }

      ctx.log("craft", `Goal: ${needed}x ${recipe.name} (have ${currentStock}/${limit})`);
      goalItems.push({ itemId: recipe.output_item_id, quantity: needed, recipe: isItemGoal ? undefined : recipe });
    }

    if (goalItems.length === 0 && !isSpecializedBot) {
      ctx.log("craft", "No goal items configured - crafting from enabled categories");
      const categoryCrafted = await craftFromCategories(ctx, recipes, settings.enabledCategories, tracker!);
      if (categoryCrafted.length > 0) {
        ctx.log("craft", `Crafted: ${categoryCrafted.join(", ")}`);
      } else {
        ctx.log("info", "No materials available for enabled categories");
      }
      await ctx.sleep(60000);
      continue;
    }

    if (goalItems.length === 0 && isSpecializedBot) {
      ctx.log("craft", "No goals match assigned categories - crafting from categories");
      const categoryCrafted = await craftFromCategories(ctx, recipes, assignedCategories, tracker!);
      if (categoryCrafted.length > 0) {
        ctx.log("craft", `Crafted: ${categoryCrafted.join(", ")}`);
      } else {
        ctx.log("info", "No materials available for assigned categories");
      }
      await ctx.sleep(60000);
      continue;
    }

    const plans = calculateMultiGoalPlan(
      goalItems.map(g => ({ itemId: g.itemId, quantity: g.quantity, recipe: g.recipe })),
      recipes,
      countItem,
    );

    const allPlanItems: Array<{ recipe: Recipe; quantityToCraft: number; reason: string; depth: number }> = [];
    for (const plan of plans) {
      ctx.log("craft", formatCraftingPlan(plan));
      for (const item of plan.flatOrder) {
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
      ctx.log("info", "No crafting goals to execute");
      await ctx.sleep(60000);
      continue;
    }

    ctx.log("craft", `Executing queue-based plan (${settings.goalProcessingMode} mode)`);
    const result = await executeCraftingPlan(ctx, allPlanItems, tracker!, recipes);
    const { crafted: craftedSummary } = result;

    const parts: string[] = [];
    if (craftedSummary.length > 0) parts.push(`Crafted ${craftedSummary.join(", ")}`);
    if (parts.length > 0) {
      ctx.log("craft", parts.join(". "));
    } else {
      ctx.log("craft", "Nothing crafted this cycle");
    }

    yield "refuel";
    await ensureFueled(ctx, settings.refuelThreshold);
    yield "repair";
    await repairShip(ctx);

    ctx.log("info", "Waiting 60s before next crafting cycle...");
    await ctx.sleep(60000);
  }
};
