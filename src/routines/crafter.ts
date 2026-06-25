import type { Routine, RoutineContext, CargoItem } from "../bot.js";
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
  findRecipeForItem,
} from "./craft-goals.js";
import { CraftQueueTracker, ServerJobInfo } from "./craftQueueTracker.js";
import { catalogStore } from "../catalogstore.js";

// ── Settings ─────────────────────────────────────────────────

const QUEUE_REFRESH_COOLDOWN = 60000;
let lastQueueCheck = 0;
let cachedQueueJobs: ServerJobInfo[] = [];

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
  craftingPreset: string;
}> {
  const { join } = require("path");
  const { readFileSync, existsSync } = require("fs");
  const file = join(process.cwd(), "data", "settings.json");
  const text = existsSync(file) ? readFileSync(file, "utf-8") : "";
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
    craftingPreset: (c.craftingPreset as string) || "fast",
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

interface FactionFacility {
  facility_id: string;
  type: string;
  name: string;
  level: number;
  faction_service: string;
  rent_per_cycle: number;
  status: string;
}

interface FacilityRecipeMap {
  facilityType: string;
  recipeId: string;
}

async function fetchFactionFacilities(bot: any): Promise<FactionFacility[]> {
  const resp = await bot.exec("facility", { action: "faction_list" });
  if (resp.error) {
    bot.log("error", `facility faction_list error: ${resp.error.message}`);
    return [];
  }
  const result = resp.result as Record<string, unknown> | undefined;
  if (!result) {
    bot.log("error", `facility faction_list: no result`);
    return [];
  }
  
  let facilities: Array<Record<string, unknown>> = [];
  if (Array.isArray(result.faction_facilities)) {
    facilities = result.faction_facilities as Array<Record<string, unknown>>;
  } else if (Array.isArray(result.facilities)) {
    facilities = result.facilities as Array<Record<string, unknown>>;
  } else if (Array.isArray(result)) {
    facilities = result as Array<Record<string, unknown>>;
  } else {
    const facilitiesKey = Object.keys(result).find(k => k.includes("facility"));
    if (facilitiesKey) {
      facilities = (result[facilitiesKey] as Array<Record<string, unknown>>) || [];
    }
  }
  
  bot.log("debug", `facility faction_list: found ${facilities.length} facilities`);
  if (facilities.length > 0) {
    bot.log("debug", `facility sample: ${JSON.stringify(facilities[0])}`);
  }
  
  return facilities.map(f => ({
    facility_id: (f.facility_id as string) || (f.id as string) || "",
    type: (f.type as string) || (f.facility_type as string) || "",
    name: (f.name as string) || "",
    level: (f.level as number) || 0,
    faction_service: (f.faction_service as string) || "",
    rent_per_cycle: (f.rent_per_cycle as number) || 0,
    status: (f.status as string) || "",
  }));
}

function getFacilityRecipeMap(): FacilityRecipeMap[] {
  const facilities = catalogStore.getAll().facilities;
  const map: FacilityRecipeMap[] = [];
  for (const [facilityId, facility] of Object.entries(facilities)) {
    const catFac = facility as Record<string, unknown>;
    const recipeId = (catFac.recipe_id as string) || "";
    const facId = (catFac.id as string) || facilityId;
    if (recipeId && facId) {
      map.push({ facilityType: facId, recipeId });
    }
  }
  return map;
}

function getRecipesAvailableAtFacilities(
  factionFacilities: FactionFacility[],
  facilityRecipeMap: FacilityRecipeMap[]
): Set<string> {
  const facilityTypes = new Set(
    factionFacilities
      .filter(f => f.faction_service === "")
      .map(f => f.type)
  );
  const availableRecipes = new Set<string>();
  for (const entry of facilityRecipeMap) {
    if (facilityTypes.has(entry.facilityType)) {
      availableRecipes.add(entry.recipeId);
    }
  }
  return availableRecipes;
}

// ── Queue-focused crafting logic ──────────────────────────────

async function checkCraftingQueue(bot: any, recipes: Recipe[], forceRefresh = false): Promise<ServerJobInfo[]> {
  const now = Date.now();
  if (!forceRefresh && now - lastQueueCheck < QUEUE_REFRESH_COOLDOWN) {
    return cachedQueueJobs;
  }
  
  const resp = await bot.exec("craft", { action: "queue" });
  if (resp.error) {
    return [];
  }
  lastQueueCheck = now;
  
  const result = resp.result as Record<string, unknown> | undefined;
  const details = (result as Record<string, unknown>)?.details as Record<string, unknown> | undefined;
  const jobs = (details?.jobs as Array<Record<string, unknown>>) || (result?.jobs as Array<Record<string, unknown>>) || [];
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
  cachedQueueJobs = jobs.map((job: Record<string, unknown>) => {
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
  return cachedQueueJobs;
}

async function getEstimatedCraftingTime(recipeId: string, recipes: Recipe[]): Promise<number> {
  const recipe = recipes.find(r => r.recipe_id === recipeId);
  return recipe?.effective_time_per_run || 0;
}

function reportQueueStatus(ctx: RoutineContext, tracker: CraftQueueTracker, recipes: Recipe[]): void {
  const { log } = ctx;
  const recipeNames = new Map<string, string>();
  for (const r of recipes) {
    recipeNames.set(r.recipe_id, r.name);
  }
  const progressSummaries: string[] = [];
  for (const [recipeId, progress] of Array.from(tracker.getProgressByRecipe().entries())) {
    const outputQty = recipes.find(r => r.recipe_id === recipeId)?.output_quantity || 1;
    const completed = progress.completed * outputQty;
    const queued = progress.queued * outputQty;
    const remaining = progress.remaining;
    const name = recipeNames.get(recipeId) || recipeId;
    progressSummaries.push(`${completed}/${queued} ${name} (${remaining} remaining)`);
  }
  if (progressSummaries.length > 0) {
    log("craft", `[Queue Status] ${progressSummaries.join(", ")}`);
  } else {
    log("craft", "[Queue Status] No active jobs in queue");
  }
}

async function syncCraftingQueue(ctx: RoutineContext, tracker: CraftQueueTracker, recipes: Recipe[], forceRefresh = false): Promise<void> {
  const { bot } = ctx;
  const serverJobs = await checkCraftingQueue(bot, recipes, forceRefresh);
  tracker.syncWithServer(serverJobs);
  tracker.save();
}

function calculateMaxCraftable(
  recipe: Recipe | undefined,
  factionStorage: CargoItem[],
): number {
  if (!recipe) return 0;
  
  const storageMap = new Map<string, number>();
  for (const i of factionStorage) {
    storageMap.set(i.itemId.toLowerCase(), i.quantity);
  }
  let maxRuns = Infinity;
  
  for (const comp of recipe.components) {
    const available = storageMap.get(comp.item_id.toLowerCase()) || 0;
    const neededPerRun = comp.quantity;
    const runsPossible = Math.floor(available / neededPerRun);
    maxRuns = Math.min(maxRuns, runsPossible);
  }
  
  if (maxRuns === Infinity) return 0;
  return maxRuns;
}

async function queueCraftJob(
  ctx: RoutineContext,
  recipeId: string,
  quantity: number,
  bot: any,
  tracker: CraftQueueTracker,
  recipes?: Recipe[],
  preset: string = "fast",
): Promise<{ success: boolean; error?: string; jobId?: string }> {
  const { log } = ctx;

  const recipe = recipes?.find(r => r.recipe_id === recipeId);
  const outputQty = recipe?.output_quantity || 1;
  const originalRuns = Math.ceil(quantity / outputQty);

  if (tracker.hasPendingJob(recipeId, originalRuns)) {
    return { success: true, error: "Job already queued" };
  }

  const serverJobs = await checkCraftingQueue(bot, recipes || [], true);
  tracker.syncWithServer(serverJobs);
  if (tracker.hasPendingJob(recipeId, originalRuns)) {
    return { success: true, error: "Job already queued" };
  }

  const maxCraftable = calculateMaxCraftable(recipe, bot.factionStorage);
  const maxRunsPossible = maxCraftable;
  let runs = Math.min(originalRuns, maxRunsPossible);
  
  if (runs <= 0) {
    log("craft", `Cannot craft ${recipeId}: need materials but storage empty or insufficient`);
    return { success: false, error: "insufficient_inputs" };
  }

  while (runs > 0) {
    log("craft", `Queueing ${runs} runs of ${recipeId} (preset=${preset})...`);
    const craftResp = await bot.exec("craft", {
      id: recipeId,
      quantity: runs,
      preset: preset,
    });

    if (!craftResp.error) {
      return handleSuccess(craftResp, recipeId, runs, log, tracker, bot);
    }

    const msg = craftResp.error.message;
    if (!msg.toLowerCase().includes("insufficient") && !msg.toLowerCase().includes("cannot_craft")) {
      return { success: false, error: msg };
    }

    runs = Math.ceil(runs / 2);
    if (runs === 0) break;
    
    log("craft", `Retrying ${recipeId} with ${runs} runs...`);
  }

  return { success: false, error: "Could not queue any runs after multiple attempts" };
}

function handleSuccess(
  resp: any,
  recipeId: string,
  runs: number,
  log: any,
  tracker: CraftQueueTracker,
  bot: any,
): { success: boolean; error?: string; jobId?: string } {
  const result = resp.result as Record<string, unknown> | undefined;
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
  const timeoutMs = (estimatedTicks ? estimatedTicks * 2 + 10 : 30) * 10000;
  const startTime = Date.now();
  let lastStatusReport = Date.now();

  const serverJobIds = await checkCraftingQueue(bot, recipes);
  tracker.syncWithServer(serverJobIds);
  tracker.save();

  const progress = tracker.getProgress(recipeId);
  const completedItems = progress.completed * outputQty;
  if (completedItems >= quantityItems) {
    return true;
  }

  while (bot.state === "running") {
    await ctx.sleep(5000);

    const now = Date.now();
    if (now - lastQueueCheck >= QUEUE_REFRESH_COOLDOWN) {
      const currentJobIds = await checkCraftingQueue(bot, recipes);
      tracker.syncWithServer(currentJobIds);
      tracker.save();
    }

    const progress = tracker.getProgress(recipeId);
    const currentCompletedItems = progress.completed * outputQty;
    if (currentCompletedItems >= quantityItems) {
      log("craft", `Crafting complete for ${recipeId}`);
      return true;
    }

    if (Date.now() - startTime > timeoutMs) {
      log("craft", `Crafting timeout for ${recipeId} - marking as complete (server may have finished)`);
      return true;
    }

    if (Date.now() - lastStatusReport >= 60000) {
      reportQueueStatus(ctx, tracker, recipes);
      lastStatusReport = Date.now();
    }
  }

  return false;
}

async function queueAllRecipes(
  ctx: RoutineContext,
  planItems: Array<{ recipe: Recipe; quantityToCraft: number; reason: string; depth: number }>,
  tracker: CraftQueueTracker,
  recipes: Recipe[],
  preset: string,
): Promise<Array<{ recipeId: string; quantity: number; outputQty: number }>> {
  const { bot } = ctx;
  const queued: Array<{ recipeId: string; quantity: number; outputQty: number }> = [];

  await syncCraftingQueue(ctx, tracker, recipes, true);

  for (const item of planItems) {
    if (bot.state !== "running") break;

    const outputQty = item.recipe.output_quantity || 1;
    const progress = tracker.getProgress(item.recipe.recipe_id);
    const queuedItems = progress.queued * outputQty;
    const completedItems = progress.completed * outputQty;

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
    const queueResult = await queueCraftJob(ctx, item.recipe.recipe_id, remainingItems, bot, tracker, recipes, preset);
    if (!queueResult.success) {
      if (queueResult.error === "insufficient_inputs") {
        ctx.log("error", `Insufficient materials for ${item.recipe.name} - need ${remainingItems}x output`);
      } else if (queueResult.error !== "Job already queued") {
        ctx.log("error", `Failed to queue ${item.recipe.name}: ${queueResult.error}`);
      }
      continue;
    }

    queued.push({ recipeId: item.recipe.recipe_id, quantity: remainingItems, outputQty });
  }

  return queued;
}

async function waitForAllCompletions(
  ctx: RoutineContext,
  queuedItems: Array<{ recipeId: string; quantity: number; outputQty: number }>,
  tracker: CraftQueueTracker,
  bot: any,
  recipes: Recipe[],
): Promise<string[]> {
  const { log } = ctx;
  const crafted: string[] = [];

  const recipeNames = new Map<string, string>();
  for (const r of recipes) {
    recipeNames.set(r.recipe_id, r.name);
  }

  let lastSync = 0;

  while (bot.state === "running" && queuedItems.length > 0) {
    await ctx.sleep(5000);

    const now = Date.now();
    if (now - lastSync >= QUEUE_REFRESH_COOLDOWN) {
      const serverJobs = await checkCraftingQueue(bot, recipes);
      tracker.syncWithServer(serverJobs);
      tracker.save();
      lastSync = now;
    }

    const stillQueued: typeof queuedItems = [];
    for (const item of queuedItems) {
      const progress = tracker.getProgress(item.recipeId);
      const completedItems = progress.completed * item.outputQty;
      if (completedItems >= item.quantity) {
        crafted.push(`${item.quantity}x ${recipeNames.get(item.recipeId) || item.recipeId}`);
        bot.stats.totalCrafted += item.quantity;
      } else {
        stillQueued.push(item);
      }
    }
    queuedItems = stillQueued;

    if (queuedItems.length > 0) {
      reportQueueStatus(ctx, tracker, recipes);
    }
  }

  return crafted;
}

async function executeCraftingPlan(
  ctx: RoutineContext,
  planItems: Array<{ recipe: Recipe; quantityToCraft: number; reason: string; depth: number }>,
  tracker: CraftQueueTracker,
  recipes: Recipe[],
  preset: string = "fast",
): Promise<{ crafted: string[]; prereqs: string[] }> {
  const { bot } = ctx;
  const crafted: string[] = [];
  const prereqs: string[] = [];

  ctx.log("craft", `Queue-based crafting plan: ${planItems.length} steps`);

  const queuedItems = await queueAllRecipes(ctx, planItems, tracker, recipes, preset);

  const completed = await waitForAllCompletions(ctx, queuedItems, tracker, bot, recipes);
  crafted.push(...completed);

  return { crafted, prereqs };
}

// ── Craft from enabled categories ─────────────────────────────

async function craftFromCategories(
  ctx: RoutineContext,
  recipes: Recipe[],
  enabledCategories: string[],
  tracker: CraftQueueTracker,
  preset: string = "fast",
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
  let lastStatusReport = Date.now();

  while (totalCrafted < MAX_CRAFTS && bot.state === "running") {
    const serverJobIds = await checkCraftingQueue(bot, recipes);
    tracker.syncWithServer(serverJobIds);
    tracker.save();

    if (Date.now() - lastStatusReport >= 60000) {
      reportQueueStatus(ctx, tracker, recipes);
      lastStatusReport = Date.now();
    }

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
    const queueResult = await queueCraftJob(ctx, target.recipe_id, 1, bot, tracker, recipes, preset);
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

    const factionFacilities = await fetchFactionFacilities(bot);
    const facilityRecipeMap = getFacilityRecipeMap();
    const facilityAvailableRecipes = getRecipesAvailableAtFacilities(factionFacilities, facilityRecipeMap);
    ctx.log("craft", `Faction facilities: ${factionFacilities.length} total, ${facilityAvailableRecipes.size} production recipes available`);

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
      const progress = tracker.getProgress(recipe.recipe_id);
      const queuedItems = progress.queued * (recipe.output_quantity || 1);
      const stockIncludingQueue = currentStock + queuedItems;
      const needed = limit - stockIncludingQueue;
      if (needed <= 0) {
        ctx.log("craft", `✓ ${recipe.name}: already have ${currentStock}/${limit} (plus ${queuedItems} in queue)`);
        continue;
      }

      ctx.log("craft", `Goal: ${needed}x ${recipe.name} (have ${currentStock}/${limit}, plus ${queuedItems} in queue)`);
      goalItems.push({ itemId: recipe.output_item_id, quantity: needed, recipe: isItemGoal ? undefined : recipe });
    }

    if (goalItems.length === 0 && !isSpecializedBot) {
      if (settings.enabledCategories.length > 0) {
        ctx.log("craft", "No goal items configured - crafting from enabled categories");
      }
      const categoryCrafted = await craftFromCategories(ctx, recipes, settings.enabledCategories, tracker!, settings.craftingPreset);
      if (categoryCrafted.length > 0) {
        ctx.log("craft", `Crafted: ${categoryCrafted.join(", ")}`);
      } else {
        ctx.log("info", "No materials available for enabled categories");
      }
      await ctx.sleep(60000);
      continue;
    }

    if (goalItems.length === 0 && isSpecializedBot) {
      if (assignedCategories.length > 0) {
        ctx.log("craft", "No goals match assigned categories - crafting from categories");
      }
      const categoryCrafted = await craftFromCategories(ctx, recipes, assignedCategories, tracker!, settings.craftingPreset);
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
      facilityAvailableRecipes,
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
    const result = await executeCraftingPlan(ctx, allPlanItems, tracker!, recipes, settings.craftingPreset);
    const { crafted: craftedSummary } = result;

    const parts: string[] = [];
    if (craftedSummary.length > 0) parts.push(`Crafted ${craftedSummary.join(", ")}`);

    if (parts.length === 0) {
      const recipeNames = new Map<string, string>();
      for (const r of recipes) {
        recipeNames.set(r.recipe_id, r.name);
      }
      const progressSummaries: string[] = [];
      for (const [recipeId, progress] of Array.from(tracker.getProgressByRecipe().entries())) {
        const outputQty = recipes.find(r => r.recipe_id === recipeId)?.output_quantity || 1;
        const completed = progress.completed * outputQty;
        const queued = progress.queued * outputQty;
        const remaining = progress.remaining;
        const name = recipeNames.get(recipeId) || recipeId;
        progressSummaries.push(`${completed}/${queued} ${name} (${remaining} remaining)`);
      }
      if (progressSummaries.length > 0) {
        ctx.log("craft", `In progress: ${progressSummaries.join(", ")}`);
      } else {
        ctx.log("info", "Nothing crafted this cycle");
      }
    } else {
      ctx.log("craft", parts.join(". "));
    }

    yield "refuel";
    await ensureFueled(ctx, settings.refuelThreshold);
    yield "repair";
    await repairShip(ctx);

    ctx.log("info", "Waiting 60s before next crafting cycle...");
    await ctx.sleep(60000);
  }
};
