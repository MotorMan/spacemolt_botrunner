import type { Routine, RoutineContext } from "../bot.js";
import {
  ensureDocked,
  ensureUndocked,
  repairShip,
  ensureFueled,
  detectAndRecoverFromDeath,
} from "./common.js";
import {
  calculateMultiGoalPlan,
  formatCraftingPlan,
  isRecipeCraftable as isRecipeCraftableNew,
  findRecipeForItem,
  hasRecipeMaterials,
} from "./craft-goals.js";
import { CraftQueueTracker, ServerJobInfo } from "./craftQueueTracker.js";
import { catalogStore } from "../catalogstore.js";

// ── Settings ─────────────────────────────────────────────────

const QUEUE_REFRESH_COOLDOWN = 60000;
let lastQueueCheck = 0;
let cachedQueueJobs: ServerJobInfo[] = [];

// Round-robin cursor per recipe so multiple same-type facilities share the load.
const facilityRoundRobin = new Map<string, number>();
// Recipes we've already warned about not having an owned facility for (dedupe per run).
const notifiedMissingFacilities = new Set<string>();
// Cumulative rental spend since the bot started (gated by rentalSpendingLimit).
let rentalSpentThisSession = 0;

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
  finalItemThreshold: number;
  allowExternalFacilities: boolean;
  forceOwnFacility: boolean;
  noFacilityFallback: string;
  allowRentalPurchase: boolean;
  rentalSpendingLimit: number;
  cycleTimeSec: number;
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
    finalItemThreshold: (c.finalItemThreshold as number) || 1,
    allowExternalFacilities: (c.allowExternalFacilities as boolean) ?? false,
    forceOwnFacility: (c.forceOwnFacility as boolean) ?? true,
    noFacilityFallback: (c.noFacilityFallback as string) || "auto",
    allowRentalPurchase: (c.allowRentalPurchase as boolean) ?? false,
    rentalSpendingLimit: (c.rentalSpendingLimit as number) || 0,
    cycleTimeSec: (c.cycleTimeSec as number) || 30,
  };
}

// ── Recipe helpers ────────────────────────────────────────────

export interface Recipe {
  recipe_id: string;
  name: string;
  components: Array<{ item_id: string; name: string; quantity: number }>;
  output_item_id: string;
  output_name: string;
  output_quantity: number;
  category?: string;
  effective_time_per_run?: number;
}

export function parseRecipes(data: unknown): Recipe[] {
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

export async function fetchAllRecipes(ctx: RoutineContext): Promise<Recipe[]> {
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

export interface FactionFacility {
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

export async function fetchFactionFacilities(bot: any): Promise<FactionFacility[]> {
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

export function getFacilityRecipeMap(): FacilityRecipeMap[] {
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

// ── Own-facility → recipe matching ──────────────────────────
//
// The catalog stores, per facility TYPE, the single recipe it can produce
// (facility.recipe_id). faction_list tells us which facilities we actually
// OWN (faction_service === "") and their live server facility_id. We join the
// two on the facility type so we know exactly which owned facility_id can
// build a given recipe — that is what we hand to the craft command as
// `facility_id`, which forces the server to use OUR facility instead of
// auto-routing (the bug: when our facility already had a job, auto-routing
// "fast" skipped it for an external rental).

export type OwnFacilityMap = Map<string, FactionFacility[]>;

export function buildOwnFacilityRecipeMap(factionFacilities: FactionFacility[]): OwnFacilityMap {
  const map: OwnFacilityMap = new Map();
  const catalogFacilities = catalogStore.getAll().facilities;
  for (const f of factionFacilities) {
    if (f.faction_service !== "") continue; // only facilities we personally own
    if (f.status && f.status.toLowerCase() === "inactive") continue; // skip non-functional ones
    if (!f.facility_id || !f.type) continue;
    const catFac = catalogFacilities[f.type] as Record<string, unknown> | undefined;
    if (!catFac) continue;
    const recipeId = (catFac.recipe_id as string) || "";
    if (!recipeId) continue;
    const list = map.get(recipeId) || [];
    list.push(f);
    map.set(recipeId, list);
  }
  return map;
}

// Distribute jobs across multiple owned facilities of the same type by
// round-robining through them in a stable order.
function pickRoundRobinFacility(recipeId: string, facilities: FactionFacility[]): FactionFacility {
  const idx = (facilityRoundRobin.get(recipeId) || 0) % facilities.length;
  facilityRoundRobin.set(recipeId, idx + 1);
  return facilities[idx];
}

export interface ResolvedVenue {
  facilityId?: string;
  preset: string;
  allowRental: boolean;
  usedOwnFacility: boolean;
  missingFacility: boolean;
  ownFacilities?: FactionFacility[];
}

export interface CrafterSettings {
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
  finalItemThreshold: number;
  allowExternalFacilities: boolean;
  forceOwnFacility: boolean;
  noFacilityFallback: string;
  allowRentalPurchase: boolean;
  rentalSpendingLimit: number;
  cycleTimeSec: number;
}

function isRentalAllowed(settings: CrafterSettings): boolean {
  if (settings.allowExternalFacilities) return true;
  if (!settings.allowRentalPurchase) return false;
  if (settings.rentalSpendingLimit <= 0) return true;
  return rentalSpentThisSession < settings.rentalSpendingLimit;
}

// Decide where a single recipe should be crafted given the owned-facility map
// and the operator's settings.
export function resolveVenueForRecipe(
  recipeId: string,
  recipeName: string,
  ownFacilityMap: OwnFacilityMap,
  settings: CrafterSettings,
): ResolvedVenue {
  if (settings.forceOwnFacility) {
    const facs = ownFacilityMap.get(recipeId) || [];
    if (facs.length > 0) {
      const fac = pickRoundRobinFacility(recipeId, facs);
      return {
        facilityId: fac.facility_id,
        preset: settings.craftingPreset,
        allowRental: isRentalAllowed(settings),
        usedOwnFacility: true,
        missingFacility: false,
        ownFacilities: facs,
      };
    }
    // We wanted to use our own facility but don't have one for this recipe.
    // The warning is emitted (once per recipe per run) by the caller, which
    // has access to the logger.
    const missingFacility = true;

    if (settings.noFacilityFallback === "workshop") {
      return { preset: "workshop", allowRental: false, usedOwnFacility: false, missingFacility };
    }
    return {
      preset: settings.craftingPreset,
      allowRental: isRentalAllowed(settings),
      usedOwnFacility: false,
      missingFacility,
    };
  }

  // forceOwnFacility disabled: just use the configured preset / auto-routing.
  return {
    preset: settings.craftingPreset,
    allowRental: isRentalAllowed(settings),
    usedOwnFacility: false,
    missingFacility: false,
  };
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
  // Drop any job we track locally whose recipe no longer resolves to a known
  // catalog recipe — these are phantom jobs (stale session state, or jobs the
  // queue poller couldn't match) that would otherwise inflate "pending" output.
  tracker.prunePhantomJobs(new Set(recipes.map(r => r.recipe_id)));
  tracker.save();
}

function calculateMaxCraftable(
  recipe: Recipe | undefined,
  countItemFn: (itemId: string) => number,
): number {
  if (!recipe) return 0;

  let maxRuns = Infinity;

  for (const comp of recipe.components) {
    const available = countItemFn(comp.item_id.toLowerCase());
    const neededPerRun = comp.quantity;
    const runsPossible = Math.floor(available / neededPerRun);
    maxRuns = Math.min(maxRuns, runsPossible);
  }

  if (maxRuns === Infinity) return 0;
  return maxRuns;
}

// ── External facility guard (dry-run cost check) ──────────────

interface CraftQuote {
  external: boolean;
  fee: number;
  labor: number;
  creditsTotal: number;
  venue: string;
  venueType: string;
  recipe: string;
}

function parseCraftQuote(result: unknown): CraftQuote {
  const r = (result || {}) as Record<string, unknown>;
  const cost = (r.cost as Record<string, unknown>) || {};
  return {
    external: r.external === true,
    fee: typeof cost.fee === "number" ? (cost.fee as number) : 0,
    labor: typeof cost.labor === "number" ? (cost.labor as number) : 0,
    creditsTotal: typeof r.credits_total === "number" ? (r.credits_total as number) : 0,
    venue: (r.venue as string) || "",
    venueType: (r.venue_type as string) || "",
    recipe: (r.recipe as string) || "",
  };
}

interface FinalVenue {
  facilityId?: string;
  preset?: string;
  blocked: boolean;
  rentalFee: number;
  label: string;
}

// Resolve the final craft venue via a dry-run, applying all the safety rules:
//  - an explicitly targeted OWN facility is always honored (never external)
//  - if auto-routing would hit an external rental but rental isn't allowed, we
//    transparently fall back to the Station Workshop (hand-crafting) instead of
//    blocking, so we still produce the item without an accidental rental
//  - if rental IS allowed but would breach the spending limit, fall back to workshop
//  - the prefer_own preset is handled server-side (own -> faction -> rental-as-
//    last-resort); client-side we still gate every external rental on
//    allowRental, so a disabled rental always falls back to hand-crafting
export async function resolveFinalVenue(
  ctx: RoutineContext,
  bot: any,
  recipeId: string,
  recipeName: string,
  runs: number,
  v: ResolvedVenue,
  settings: CrafterSettings,
): Promise<FinalVenue> {
  const { log } = ctx;

  const dryRun = async (preset?: string, facilityId?: string) => {
    const payload: Record<string, unknown> = { id: recipeId, quantity: runs, dry_run: true };
    if (preset) payload.preset = preset;
    if (facilityId) payload.facility_id = facilityId;
    let r = await bot.exec("craft", payload);
    if (r.error) {
      const m = (r.error.message || "").toLowerCase();
      if (r.error.code === "429" || m.includes("rate") || m.includes("limit")) {
        await ctx.sleep(2000);
        r = await bot.exec("craft", payload);
      }
    }
    return r;
  };

  let attemptedFacility = v.facilityId;
  let attemptedPreset: string | undefined = v.facilityId ? undefined : v.preset;

  let resp = await dryRun(attemptedPreset, attemptedFacility);

  if (resp.error) {
    const errMsg = resp.error.message;
    // If our own facility was unusable (busy/offline) and rental is allowed,
    // fall back to normal auto-routing.
    if (attemptedFacility && v.allowRental) {
      log("warn", `Own facility ${attemptedFacility} unavailable for ${recipeName} (${errMsg}) - falling back to auto-routing`);
      attemptedFacility = undefined;
      attemptedPreset = settings.craftingPreset;
      resp = await dryRun(attemptedPreset, undefined);
    } else if (!v.allowRental) {
      // Couldn't verify a safe venue and we can't rent — try workshop as a last resort.
      log("warn", `Craft venue unusable for ${recipeName} (${errMsg}) - trying workshop fallback`);
      attemptedFacility = undefined;
      attemptedPreset = "workshop";
      resp = await dryRun("workshop", undefined);
      if (resp.error) {
        log("error", `🔴 CRAFT VENUE UNVERIFIED: dry_run failed for ${recipeName} (${resp.error.message}). Blocking to avoid an accidental external facility rental.`);
        return { blocked: true, rentalFee: 0, label: "unverified" };
      }
      return { facilityId: undefined, preset: "workshop", blocked: false, rentalFee: 0, label: "workshop (fallback)" };
    } else {
      // Rental allowed but venue still errored unexpectedly — block closed.
      log("error", `🔴 CRAFT VENUE UNVERIFIED: dry_run failed for ${recipeName} (${errMsg}). Blocking to avoid an accidental external facility rental.`);
      return { blocked: true, rentalFee: 0, label: "unverified" };
    }
  }

  let quote = parseCraftQuote(resp.result);

  // If auto-routing would rent an external facility but rental isn't allowed,
  // fall back to the Station Workshop (hand-crafting) so we still produce it.
  // This applies regardless of preset (incl. prefer_own): a disabled rental is
  // always honored and never bypassed.
  if (!attemptedFacility && quote.external && !v.allowRental) {
    log("warn", `Would rent external facility "${quote.venue || recipeName}" for ${quote.fee}cr but rental is not allowed - falling back to workshop (hand-crafting)`);
    attemptedFacility = undefined;
    attemptedPreset = "workshop";
    const ws = await dryRun("workshop", undefined);
    if (ws.error) {
      log("error", `🔴 CRAFT VENUE UNVERIFIED: workshop dry_run failed for ${recipeName} (${ws.error.message}). Blocking.`);
      return { blocked: true, rentalFee: 0, label: "workshop-failed" };
    }
    quote = parseCraftQuote(ws.result);
    return { facilityId: undefined, preset: "workshop", blocked: false, rentalFee: 0, label: "workshop (rental avoided)" };
  }

  // External rental is allowed — enforce the spending limit.
  let rentalFee = 0;
  if (!attemptedFacility && quote.external && v.allowRental) {
    rentalFee = quote.fee;
    if (settings.allowRentalPurchase && settings.rentalSpendingLimit > 0) {
      if (rentalSpentThisSession + rentalFee > settings.rentalSpendingLimit) {
        log("warn", `Rental fee ${rentalFee}cr would exceed spending limit ${settings.rentalSpendingLimit}cr for ${recipeName} - falling back to workshop (hand-crafting)`);
        attemptedFacility = undefined;
        attemptedPreset = "workshop";
        const ws = await dryRun("workshop", undefined);
        if (ws.error) {
          log("error", `🔴 CRAFT VENUE UNVERIFIED: workshop dry_run failed for ${recipeName} (${ws.error.message}). Blocking.`);
          return { blocked: true, rentalFee: 0, label: "workshop-failed" };
        }
        quote = parseCraftQuote(ws.result);
        return { facilityId: undefined, preset: "workshop", blocked: false, rentalFee: 0, label: "workshop (limit reached)" };
      }
    }
  }

  const label = attemptedFacility
    ? `facility ${attemptedFacility}`
    : `preset=${attemptedPreset}`;
  return {
    facilityId: attemptedFacility,
    preset: attemptedPreset,
    blocked: false,
    rentalFee,
    label,
  };
}

// Split a bulk run count across the owned facilities that can produce a recipe.
// When a user owns more than one facility of the same type (e.g. 3 platinum
// mints), the entire bulk would otherwise land on a single facility. Splitting
// the runs across all of them lets the work proceed in parallel for N times the
// throughput of a single facility.
function buildFacilityChunks(
  recipeId: string,
  runs: number,
  venue: ResolvedVenue,
  ownFacilityMap: OwnFacilityMap,
): Array<{ facilityId?: string; preset?: string; runs: number }> {
  const ownFacs = venue.usedOwnFacility
    ? (ownFacilityMap.get(recipeId) || venue.ownFacilities || [])
    : [];

  if (ownFacs.length <= 1) {
    return [{ facilityId: venue.facilityId, preset: venue.preset, runs }];
  }

  const chunks: Array<{ facilityId?: string; preset?: string; runs: number }> = [];
  const base = Math.floor(runs / ownFacs.length);
  let remainder = runs - base * ownFacs.length;
  for (const f of ownFacs) {
    const chunkRuns = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder--;
    if (chunkRuns <= 0) continue;
    chunks.push({ facilityId: f.facility_id, runs: chunkRuns });
  }
  return chunks;
}

export async function queueCraftJob(
  ctx: RoutineContext,
  recipeId: string,
  quantity: number,
  bot: any,
  tracker: CraftQueueTracker,
  countItemFn: (itemId: string) => number,
  recipes: Recipe[],
  venue: ResolvedVenue,
  settings: CrafterSettings,
  ownFacilityMap: OwnFacilityMap = new Map(),
): Promise<{ success: boolean; error?: string; jobId?: string; queuedRuns?: number }> {
  const { log } = ctx;

  const recipe = recipes?.find(r => r.recipe_id === recipeId);
  const outputQty = recipe?.output_quantity || 1;
  const originalRuns = Math.ceil(quantity / outputQty);

  if (tracker.hasPendingJob(recipeId, originalRuns)) {
    return { success: true, error: "Job already queued", queuedRuns: originalRuns };
  }

  const serverJobs = await checkCraftingQueue(bot, recipes || [], true);
  tracker.syncWithServer(serverJobs);
  if (tracker.hasPendingJob(recipeId, originalRuns)) {
    return { success: true, error: "Job already queued", queuedRuns: originalRuns };
  }

  const maxCraftable = calculateMaxCraftable(recipe, countItemFn);
  const runs = Math.min(originalRuns, maxCraftable);

  if (runs <= 0) {
    log("craft", `Cannot craft ${recipeId}: need materials but storage empty or insufficient`);
    return { success: false, error: "insufficient_inputs" };
  }

  if (runs < originalRuns) {
    log("craft", `Only ${runs}/${originalRuns} runs possible due to materials - queuing what's available`);
  }

  // Notify (once per recipe per run) when we wanted our own facility but lack one.
  if (venue.missingFacility) {
    const key = recipe?.name || recipeId;
    if (!notifiedMissingFacilities.has(key)) {
      notifiedMissingFacilities.add(key);
      log("warn", `⚠ No OWNED facility produces "${key}" - falling back per noFacilityFallback=${settings.noFacilityFallback}`);
    }
  }

  // Distribute the bulk run count across every owned facility that can produce
  // this recipe so multiple facilities run in parallel.
  const chunks = buildFacilityChunks(recipeId, runs, venue, ownFacilityMap);
  if (chunks.length > 1) {
    log("craft", `Splitting ${runs} runs of ${recipeId} across ${chunks.length} owned facilities for parallel production`);
  }

  let totalQueuedRuns = 0;
  let firstError: string | undefined;

  for (const chunk of chunks) {
    const chunkVenue: ResolvedVenue = {
      facilityId: chunk.facilityId,
      preset: chunk.preset ?? venue.preset,
      allowRental: venue.allowRental,
      usedOwnFacility: !!chunk.facilityId,
      missingFacility: false,
    };

    const finalVenue = await resolveFinalVenue(ctx, bot, recipeId, recipe?.name || recipeId, chunk.runs, chunkVenue, settings);
    if (finalVenue.blocked) {
      firstError = firstError || "external_facility_blocked";
      continue;
    }

    log("craft", `Queueing ${chunk.runs} runs of ${recipeId} (${finalVenue.label})...`);
    const craftPayload: Record<string, unknown> = { id: recipeId, quantity: chunk.runs };
    if (finalVenue.facilityId) craftPayload.facility_id = finalVenue.facilityId;
    if (finalVenue.preset) craftPayload.preset = finalVenue.preset;

    const craftResp = await bot.exec("craft", craftPayload);

    if (!craftResp.error) {
      if (finalVenue.rentalFee > 0) {
        rentalSpentThisSession += finalVenue.rentalFee;
        const limitNote = settings.rentalSpendingLimit > 0
          ? ` (session rental spend ${rentalSpentThisSession}/${settings.rentalSpendingLimit}cr)`
          : "";
        log("craft", `Rented external facility for ${recipe?.name || recipeId}: ${finalVenue.rentalFee}cr${limitNote}`);
      }
      const res = handleSuccess(craftResp, recipeId, chunk.runs, log, tracker, bot);
      if (res.success) {
        totalQueuedRuns += chunk.runs;
      } else {
        firstError = firstError || res.error;
      }
    } else {
      const msg = craftResp.error.message;
      if (msg.toLowerCase().includes("insufficient") || msg.toLowerCase().includes("cannot_craft")) {
        log("craft", `Insufficient materials for ${recipeId} - will retry next cycle`);
        return { success: false, error: "insufficient_inputs" };
      }
      firstError = firstError || msg;
    }
  }

  if (totalQueuedRuns === 0) {
    return { success: false, error: firstError || "no_jobs_queued" };
  }
  return { success: true, queuedRuns: totalQueuedRuns };
}


function handleSuccess(
  resp: any,
  recipeId: string,
  runs: number,
  log: any,
  tracker: CraftQueueTracker,
  bot: any,
): { success: boolean; error?: string; jobId?: string; queuedRuns?: number } {
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
  return { success: true, jobId, queuedRuns: runs };
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

async function waitForAllCompletions(
   ctx: RoutineContext,
   initialQueuedItems: Array<{ recipeId: string; quantity: number; outputQty: number }>,
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
    let lastStatusReport = Date.now();
    let remainingItems = [...initialQueuedItems];

    while (bot.state === "running" && remainingItems.length > 0) {
      await ctx.sleep(5000);

      const now = Date.now();
      if (now - lastSync >= QUEUE_REFRESH_COOLDOWN) {
        const serverJobs = await checkCraftingQueue(bot, recipes);
        tracker.syncWithServer(serverJobs);
        tracker.save();
        lastSync = now;
      }

      const stillQueued: typeof remainingItems = [];
      for (const item of remainingItems) {
        const progress = tracker.getProgress(item.recipeId);
        const completedItems = progress.completed * item.outputQty;
        if (completedItems >= item.quantity) {
          crafted.push(`${item.quantity}x ${recipeNames.get(item.recipeId) || item.recipeId}`);
          bot.stats.totalCrafted += item.quantity;
        } else {
          stillQueued.push(item);
        }
      }
      remainingItems = stillQueued;

      if (remainingItems.length > 0 && Date.now() - lastStatusReport >= 60000) {
        reportQueueStatus(ctx, tracker, recipes);
        lastStatusReport = Date.now();
      }
    }

   return crafted;
 }

async function queueAllRecipesOnce(
    ctx: RoutineContext,
    allPlanItems: Array<{ recipe: Recipe; quantityToCraft: number; reason: string; depth: number }>,
    tracker: CraftQueueTracker,
    recipes: Recipe[],
    availableFn: (itemId: string) => number,
    ownFacilityMap: OwnFacilityMap,
    settings: CrafterSettings,
): Promise<{ queued: Array<{ recipeId: string; quantity: number; outputQty: number }>; queuedItems: number }> {
    const { bot } = ctx;
    const queued: Array<{ recipeId: string; quantity: number; outputQty: number }> = [];
    let queuedItemsTotal = 0;

    await syncCraftingQueue(ctx, tracker, recipes, true);

    for (const item of allPlanItems) {
      if (bot.state !== "running") break;

      const outputQty = item.recipe.output_quantity || 1;
      const progress = tracker.getProgress(item.recipe.recipe_id);
      const queuedItems = progress.queued * outputQty;
      const completedItems = progress.completed * outputQty;

      const remainingItems = item.quantityToCraft - completedItems - queuedItems;
      if (remainingItems <= 0) {
        const actualQueued = Math.ceil(item.quantityToCraft / outputQty);
        queued.push({ recipeId: item.recipe.recipe_id, quantity: actualQueued * outputQty, outputQty });
        continue;
      }

       const venue = resolveVenueForRecipe(item.recipe.recipe_id, item.recipe.name, ownFacilityMap, settings);
       const queueResult = await queueCraftJob(ctx, item.recipe.recipe_id, remainingItems, bot, tracker, availableFn, recipes, venue, settings, ownFacilityMap);
       if (!queueResult.success) {
         if (queueResult.error === "insufficient_inputs") {
           ctx.log("craft", `Holding ${item.recipe.name}: awaiting sub-materials, will retry next pass`);
         } else if (queueResult.error && queueResult.error.includes("aborted")) {
           ctx.log("warn", `Crafting halted: ${queueResult.error}`);
           break;
         } else if (queueResult.error !== "Job already queued") {
           ctx.log("error", `Failed to queue ${item.recipe.name}: ${queueResult.error}`);
         }
         continue;
       }

      const actualQueued = queueResult.queuedRuns || 0;
      queued.push({ recipeId: item.recipe.recipe_id, quantity: actualQueued * outputQty, outputQty });
      queuedItemsTotal += actualQueued * outputQty;
      if (actualQueued * outputQty < remainingItems) {
        ctx.log("craft", `Partially queued ${item.recipe.name}: ${actualQueued * outputQty}/${remainingItems}x (awaiting sub-materials)`);
      }
    }

    return { queued, queuedItems: queuedItemsTotal };
}

async function executeCraftingPlan(
    ctx: RoutineContext,
    goalsToAchieve: Array<{ itemId: string; quantity: number; limit: number; recipe?: Recipe }>,
    tracker: CraftQueueTracker,
    recipes: Recipe[],
    preset: string = "fast",
    finalItemThreshold: number = 1,
    countItemFn?: (itemId: string) => number,
    facilityAvailableRecipes?: Set<string>,
    ownFacilityMap: OwnFacilityMap = new Map(),
    settings: CrafterSettings | null = null,
): Promise<{ crafted: string[]; prereqs: string[] }> {
   const { log, bot } = ctx;
   const crafted: string[] = [];
   const prereqs: string[] = [];

   const recipeIndex = new Map(recipes.map(r => [r.recipe_id, r]));
   const outputQtyOf = (recipeId: string) => recipeIndex.get(recipeId)?.output_quantity || 1;

   const recipeIdForGoal = (g: { itemId: string; recipe?: Recipe }): string => {
     if (g.recipe) return g.recipe.recipe_id;
     const r = findRecipeForItem(g.itemId, recipes, countItemFn!, facilityAvailableRecipes);
     return r ? r.recipe_id : "";
   };

    // Credit outputs that in-flight jobs will produce so we can keep building
    // higher-tier items as soon as their sub-materials appear. We must NOT also
    // subtract the materials those jobs consume: the server deducts a job's
    // inputs up-front when it is queued, so the live faction-storage count we
    // read each pass ALREADY excludes them. Subtracting them again here would
    // double-count and could zero out a material we genuinely have (e.g. a
    // shared base material reserved by an unrelated in-flight job), which
    // blocked perfectly valid partial crafts of leaf recipes.
    const accountPending = (): { hasPending: boolean; produced: Map<string, number> } => {
      let hasPending = false;
      const produced = new Map<string, number>();
      // Iterate the actual jobs (not just the aggregated progress) so we can use
      // each job's server-reported `runsRemaining` directly. A job can only still
      // produce what the server says is left to run; crediting the full
      // `quantity - completed` would let a stale/over-reported job (e.g. one the
      // server already finished but still echoes a huge runs_total) flood the
      // planner with fake stock — that's what made water ice read as ~299k.
      for (const job of tracker.getActiveJobs()) {
        const r = recipeIndex.get(job.recipeId);
        if (!r) continue;
        const pending = Math.max(
          0,
          Math.min(job.quantity - job.completed, job.runsRemaining),
        );
        if (pending <= 0) continue;
        hasPending = true;
        const outId = r.output_item_id.toLowerCase();
        produced.set(outId, (produced.get(outId) || 0) + (r.output_quantity || 1) * pending);
      }
      return { hasPending, produced };
    };

    let lastStatusReport = Date.now();
    let stagnationIterations = 0;
    let stagnationMs = 0;
    const STAGNATION_BUDGET_MS = 60000;
    const ACTIVE_LOOP_CAP = 600;
    let loopCount = 0;
    const cycleWaitMs = ((settings && settings.cycleTimeSec) || 30) * 1000;

   // Active loop: keep re-planning and queueing as sub-materials become available.
    while (bot.state === "running" && loopCount < ACTIVE_LOOP_CAP) {
      loopCount++;
      await syncCraftingQueue(ctx, tracker, recipes, true);
      // Re-read faction storage LIVE each pass. As queued jobs consume/produce
      // materials on the server, the holdings change continuously; a stale count
      // here is what makes the planner think it needs to re-refine materials it
      // already has enough of (e.g. steel_plate).
      await bot.refreshFactionStorage(true);


     // Recompute which goals still need production using live stock + in-flight output.
     const remainingGoals: Array<{ itemId: string; quantity: number; recipe?: Recipe }> = [];
     for (const g of goalsToAchieve) {
       const recipeId = recipeIdForGoal(g);
       if (!recipeId) continue;
       const liveStock = countItemFn!(g.itemId.toLowerCase());
       const prog = tracker.getProgress(recipeId);
       const queuedOutput = prog.queued * outputQtyOf(recipeId);
       if (liveStock + queuedOutput < g.limit) {
         remainingGoals.push({ itemId: g.itemId, quantity: g.limit - (liveStock + queuedOutput), recipe: g.recipe });
       }
     }

     if (remainingGoals.length === 0) {
       log("craft", "All goals covered by stock + in-flight queue - waiting for production to finish");
       break;
     }

      // Whether anything is still in production (including sub-materials we're waiting on).
      const { hasPending, produced } = accountPending();
      const anyPending = hasPending;
      const availableFn = (itemId: string): number => {
        const id = itemId.toLowerCase();
        return Math.max(0, countItemFn!(id) + (produced.get(id) || 0));
      };

      const plans = calculateMultiGoalPlan(remainingGoals, recipes, availableFn, facilityAvailableRecipes, countItemFn!);
     const allPlanItems: Array<{ recipe: Recipe; quantityToCraft: number; reason: string; depth: number }> = [];
     for (const plan of plans) {
       log("craft", formatCraftingPlan(plan));
       for (const item of plan.flatOrder) {
         allPlanItems.push({
           recipe: item.recipe,
           quantityToCraft: Math.max(1, Math.floor(item.quantityToCraft)),
           reason: item.reason,
           depth: item.depth,
         });
       }
     }

      const effectiveSettings = settings || await getCrafterSettings();
      const { queuedItems } = await queueAllRecipesOnce(ctx, allPlanItems, tracker, recipes, availableFn, ownFacilityMap, effectiveSettings);

      // Progress is being made if we queued something this pass, or if the queue
      // still has jobs producing sub-materials we're waiting on.
      if (queuedItems > 0 || anyPending) {
        stagnationIterations = 0;
        stagnationMs = 0;
      } else {
        stagnationIterations++;
        stagnationMs += cycleWaitMs;
      }

      if (Date.now() - lastStatusReport >= 60000) {
        reportQueueStatus(ctx, tracker, recipes);
        lastStatusReport = Date.now();
      }

      if (stagnationIterations >= ACTIVE_LOOP_CAP || stagnationMs >= STAGNATION_BUDGET_MS) {
        log("craft", "No new materials to progress crafting - pausing active crafting until next cycle");
        break;
      }

      log("craft", `Active plan pass ${loopCount} done - waiting ${cycleWaitMs / 1000}s before next pass`);
      await ctx.sleep(cycleWaitMs);
    }

   // Wait for the final goal items to actually be produced before returning.
   const finalItems = goalsToAchieve.map(g => {
     const recipeId = recipeIdForGoal(g);
     if (!recipeId) return null;
     const outputQty = outputQtyOf(recipeId);
     const prog = tracker.getProgress(recipeId);
     const target = prog.queued * outputQty;
     return { recipeId, quantity: target, outputQty };
   }).filter((x): x is { recipeId: string; quantity: number; outputQty: number } => !!x && x.quantity > 0);

   const completed = await waitForAllCompletions(ctx, finalItems, tracker, bot, recipes);
   crafted.push(...completed);

   for (const g of goalsToAchieve) {
     const recipeId = recipeIdForGoal(g);
     if (recipeId) prereqs.push(`${g.limit}x ${recipeIndex.get(recipeId)?.name || recipeId}`);
   }

   return { crafted, prereqs };
}

// ── Craft from enabled categories ─────────────────────────────

async function craftFromCategories(
  ctx: RoutineContext,
  recipes: Recipe[],
  enabledCategories: string[],
  tracker: CraftQueueTracker,
  ownFacilityMap: OwnFacilityMap,
  settings: CrafterSettings,
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

  // Create countItem function for this bot
  function countItemForCraft(itemId: string): number {
    const lowerId = itemId.toLowerCase();
    let total = 0;
    for (const i of bot.inventory) { if (i.itemId.toLowerCase() === lowerId) total += i.quantity; }
    for (const i of bot.storage) { if (i.itemId.toLowerCase() === lowerId) total += i.quantity; }
    for (const i of bot.factionStorage || []) { if (i.itemId.toLowerCase() === lowerId) total += i.quantity; }
    return total;
  }

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
    let targetHasMaterials = false;
    for (const candidate of candidates) {
      const outputQty = candidate.recipe.output_quantity || 1;
      const runsNeeded = Math.ceil(1 / outputQty);
      if (!tracker.hasPendingJob(candidate.recipe.recipe_id, runsNeeded)) {
        target = candidate.recipe;
        // Check if we have materials for at least one run
        targetHasMaterials = hasRecipeMaterials(candidate.recipe, countItemForCraft);
        break;
      }
    }

    if (!target) {
      ctx.log("info", "No available recipes to queue");
      break;
    }

    if (!targetHasMaterials) {
      ctx.log("craft", `Materials not yet available for ${target.name} - will retry`);
      await ctx.sleep(2000);
      continue;
    }

    const outputQty = target.output_quantity || 1;
    const runs = Math.ceil(1 / outputQty);
    ctx.log("craft", `Queueing ${runs} run(s) of ${target.name} (category: ${target.category})`);
    const venue = resolveVenueForRecipe(target.recipe_id, target.name, ownFacilityMap, settings);
    const queueResult = await queueCraftJob(ctx, target.recipe_id, 1, bot, tracker, countItemForCraft, recipes, venue, settings, ownFacilityMap);
    if (!queueResult.success) {
      if (queueResult.error && queueResult.error.includes("aborted")) {
        ctx.log("warn", `Crafting halted: ${queueResult.error}`);
        break;
      }
      ctx.log("error", `Failed to queue ${target.name}: ${queueResult.error}`);
      await ctx.sleep(2000);
      continue;
    }

    crafted.push(`1x ${target.output_name}`);
    totalCrafted++;
    bot.stats.totalCrafted++;

    await ctx.sleep(2000);
  }

  return crafted;
}

// ── Cloaking refuel helpers ───────────────────────────────────

async function hasCloakingModule(ctx: RoutineContext): Promise<boolean> {
  const { bot } = ctx;
  const shipResp = await bot.exec("get_ship");
  if (shipResp.error || !shipResp.result) return false;
  const shipData = shipResp.result as Record<string, unknown>;
  const modules = Array.isArray(shipData.modules) ? shipData.modules : [];
  for (const mod of modules) {
    const modObj = typeof mod === "object" && mod !== null ? mod as Record<string, unknown> : null;
    const checkStr = `${(modObj?.id as string) || (modObj?.type_id as string) || ""} ${(modObj?.name as string) || ""} ${(modObj?.special as string) || ""}`.toLowerCase();
    if (checkStr.includes("cloak")) return true;
  }
  return false;
}

async function enableCloakingIfPossible(ctx: RoutineContext): Promise<boolean> {
  const { bot } = ctx;
  if (bot.isCloaked) {
    ctx.log("craft", "Bot is already cloaked - no action needed");
    return true;
  }
  if (!(await hasCloakingModule(ctx))) {
    ctx.log("craft", "No cloaking module detected - cannot enable cloak");
    return false;
  }
  ctx.log("craft", "Enabling cloaking module...");
  const resp = await bot.exec("cloak", { enable: true });
  if (resp.error) {
    const msg = resp.error.message.toLowerCase();
    if (msg.includes("already cloaked") || msg.includes("already_cloaked")) {
      ctx.log("craft", "Bot is already cloaked");
      return true;
    }
    ctx.log("error", `Failed to enable cloak: ${resp.error.message}`);
    return false;
  }
  ctx.log("craft", "Cloaking enabled successfully");
  return true;
}

async function checkAndRefuelWithCloak(ctx: RoutineContext, threshold: number): Promise<void> {
  const { bot } = ctx;
  await bot.refreshShip();
  const fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;

  if (fuelPct >= threshold) return;

  if (bot.isCloaked) {
    ctx.log("craft", `Fuel low (${fuelPct}%) while cloaked - refueling directly`);
    await ensureFueled(ctx, threshold);
    return;
  }

  // Get to a station for cloak/refuel
  await ensureUndocked(ctx);
  const cloaked = await enableCloakingIfPossible(ctx);
  if (!cloaked) {
    ctx.log("warn", "Could not enable cloak - attempting to refuel undocked");
  }
  await ensureFueled(ctx, threshold);
  if (!bot.docked) {
    ctx.log("craft", "Redocking after refuel...");
    await ensureDocked(ctx);
  }
}

async function cloakAwareRefuel(ctx: RoutineContext, threshold: number): Promise<void> {
  const { bot } = ctx;
  await bot.refreshShip();
  const fuelPct = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;

  if (fuelPct >= threshold) {
    ctx.log("craft", `Fuel at ${fuelPct}% - above refuel threshold ${threshold}%`);
    return;
  }

  if (bot.isCloaked) {
    ctx.log("craft", `Fuel low (${fuelPct}%) while cloaked - refueling directly`);
    await ensureFueled(ctx, threshold);
    return;
  }

  ctx.log("craft", `Fuel low (${fuelPct}%) - enabling cloak before refueling`);
  await ensureUndocked(ctx);
  const cloaked = await enableCloakingIfPossible(ctx);
  if (!cloaked) {
    ctx.log("warn", "Could not enable cloak - attempting to refuel undocked");
  }
  await ensureFueled(ctx, threshold);
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
    const cycleWaitMs = (settings.cycleTimeSec || 30) * 1000;

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
    // Force a LIVE view_faction_storage read every round. The crafter must never
    // plan against a stale snapshot — its own jobs are constantly changing the
    // station's holdings, so a cached read undercounts materials (e.g. steel).
    await bot.refreshFactionStorage(true);

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

    function countItem(itemId: string): number {
      const lowerId = itemId.toLowerCase();
      let total = 0;
      for (const i of bot.inventory) { if (i.itemId.toLowerCase() === lowerId) total += i.quantity; }
      for (const i of bot.storage) { if (i.itemId.toLowerCase() === lowerId) total += i.quantity; }
      // Read bot.factionStorage live (do NOT capture a snapshot const) so that
      // re-refreshing it mid-loop in executeCraftingPlan is reflected here.
      for (const i of (bot.factionStorage || [])) { if (i.itemId.toLowerCase() === lowerId) total += i.quantity; }
      return total;
    }

    const factionFacilities = await fetchFactionFacilities(bot);
    const facilityRecipeMap = getFacilityRecipeMap();
    const facilityAvailableRecipes = getRecipesAvailableAtFacilities(factionFacilities, facilityRecipeMap);
    const ownFacilityMap = buildOwnFacilityRecipeMap(factionFacilities);
    ctx.log("craft", `Faction facilities: ${factionFacilities.length} total, ${facilityAvailableRecipes.size} production recipes available`);
    ctx.log("craft", `Own facilities: ${[...ownFacilityMap.values()].reduce((n, l) => n + l.length, 0)} covering ${ownFacilityMap.size} recipes (forceOwnFacility=${settings.forceOwnFacility})`);
    if (settings.allowRentalPurchase) {
      const remaining = settings.rentalSpendingLimit > 0
        ? `${settings.rentalSpendingLimit - rentalSpentThisSession}cr remaining of ${settings.rentalSpendingLimit}cr`
        : "no spending limit";
      ctx.log("craft", `Rental purchase enabled: ${remaining} (session spent ${rentalSpentThisSession}cr)`);
    }

    ctx.log("craft", "Processing crafting goals...");
    const goalItems: Array<{ itemId: string; quantity: number; limit: number; recipe?: Recipe }> = [];

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
      goalItems.push({ itemId: recipe.output_item_id, quantity: needed, limit, recipe: isItemGoal ? undefined : recipe });
    }

    if (goalItems.length === 0 && !isSpecializedBot) {
      if (settings.enabledCategories.length > 0) {
        ctx.log("craft", "No goal items configured - crafting from enabled categories");
      }
      const categoryCrafted = await craftFromCategories(ctx, recipes, settings.enabledCategories, tracker!, ownFacilityMap, settings);
      if (categoryCrafted.length > 0) {
        ctx.log("craft", `Crafted: ${categoryCrafted.join(", ")}`);
      } else {
        ctx.log("info", "No materials available for enabled categories");
      }
       await ctx.sleep(cycleWaitMs);
      continue;
    }

    if (goalItems.length === 0 && isSpecializedBot) {
      if (assignedCategories.length > 0) {
        ctx.log("craft", "No goals match assigned categories - crafting from categories");
      }
      const categoryCrafted = await craftFromCategories(ctx, recipes, assignedCategories, tracker!, ownFacilityMap, settings);
      if (categoryCrafted.length > 0) {
        ctx.log("craft", `Crafted: ${categoryCrafted.join(", ")}`);
      } else {
        ctx.log("info", "No materials available for assigned categories");
      }
      await ctx.sleep(cycleWaitMs);
      continue;
    }

    if (goalItems.length === 0) {
      ctx.log("info", "No crafting goals to execute");
      await ctx.sleep(cycleWaitMs);
      continue;
    }

    ctx.log("craft", `Executing active queue-based plan (${settings.goalProcessingMode} mode)`);
    const result = await executeCraftingPlan(ctx, goalItems, tracker!, recipes, settings.craftingPreset, settings.finalItemThreshold, countItem, facilityAvailableRecipes, ownFacilityMap, settings);
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
    await cloakAwareRefuel(ctx, settings.refuelThreshold);
    yield "repair";
    await repairShip(ctx);

    ctx.log("info", `Waiting ${settings.cycleTimeSec}s before next crafting cycle...`);
    await ctx.sleep(cycleWaitMs);
  }
};
