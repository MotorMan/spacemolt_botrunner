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
import { extractShipModules, moduleHaystack } from "../shipmodules.js";

// ── Settings ─────────────────────────────────────────────────

const QUEUE_REFRESH_COOLDOWN = 60000;
// NOTE: the queue cache used to live here at MODULE level (lastQueueCheck /
// cachedQueueJobs). Because all drones share one module scope when run in a
// single process, that leaked one drone's queue into every other drone (the
// "148k phantom fuel pending" bug). The cache now lives PER-BOT on
// `bot.craftQueueCache` — see checkCraftingQueue().

// HTML markup for log lines rendered in the web UI.
// The dashboard's ANSI parser is unreliable for inline spans, so we inject
// explicit <span class="ansi-..."> tags directly. The CSS classes are defined
// in index.css.
const HTML_RESET = '</span>';
const HTML_BOLD_RED = '<span class="ansi-red ansi-bright">';
const HTML_RED = '<span class="ansi-red">';
const HTML_GREEN = '<span class="ansi-green">';
const HTML_YELLOW = '<span class="ansi-yellow">';
const HTML_CYAN = '<span class="ansi-cyan">';

/** Wrap `value` in a colored HTML span. */
function span(value: string, cls: string): string {
  return `<span class="${cls}">${value}</span>`;
}

/** Markup for `NOT Crafting: Name (id): item: LOW:N of M` lines. */
function markupNotCrafting(recipeName: string, recipeId: string, lowMaterials: string[]): string {
  const colored = lowMaterials
    .map(s => {
      const [mat, rest] = s.split(": ");
      const m = rest.match(/^(LOW:\d+)\s+(of)\s+(\d+)$/);
      if (!m) return `${mat}: ${span(rest, "ansi-red")}`;
      const [, lowPart, ofPart, triggerStr] = m;
      return `${mat}: ${span(lowPart, "ansi-red ansi-bright")} ${ofPart} ${span(triggerStr, "ansi-green")}`;
    })
    .join(", ");
  return `${span("NOT Crafting:", "ansi-yellow")} ${recipeName} (${recipeId}): ${colored}`;
}

/** Markup for held/cap log lines (`... at N >= cap M`). */
function markupHeld(prefix: string, outItem: string, have: number, cap: number): string {
  return `${prefix} output ${outItem} at ${span(`${have} >= cap ${cap}`, "ansi-green")}`;
}

/** Markup for a fired trigger summary (`item>N->stop M`). */
function markupSummary(items: { item: string; triggerAt: number; stopAt: number }[]): string {
  return items.map(t => `${t.item}>${span(String(t.triggerAt), "ansi-cyan")}→stop ${span(String(t.stopAt), "ansi-green")}`).join(", ");
}

// Sentinel for the "crafting home base storage" setting. When a crafter's
// craftingHomeBase equals this, it reads the faction storage of the station it
// is CURRENTLY docked at instead of a fixed global station. This lets multiple
// crafters stationed at different bases each pull materials from their own
// station rather than all sharing one configured home base (which made roaming
// crafters "lose" their stock and wrongly re-smelt everything).
const CRAFTER_USE_DOCKED_STATION = "@current";

// Resolve the args for refreshFactionStorage so a "@current" home base reads the
// docked station, while a real station id (or empty -> bot default) reads that.
function factionStorageRefreshArgs(homeBase: string): {
  stationId?: string;
  readCurrentStation: boolean;
} {
  if (homeBase === CRAFTER_USE_DOCKED_STATION) {
    return { stationId: undefined, readCurrentStation: true };
  }
  return { stationId: homeBase || undefined, readCurrentStation: false };
}

// Read the docked/base station fuel into bot.homeBaseFuel so fuel_reserve goals
// compare against accurate data. A "@current" home base reads the station the
// bot is docked at (get_base with no base_id); a real id reads that station; an
// empty string leaves the fuel untouched (preserving previous behavior).
async function refreshCrafterBaseFuel(
  bot: any,
  homeBase: string,
  log?: (level: string, msg: string) => void,
): Promise<void> {
  if (!homeBase) return;
  const useCurrent = homeBase === CRAFTER_USE_DOCKED_STATION;
  const baseResp = await (useCurrent
    ? bot.exec("get_base", {})
    : bot.exec("get_base", { base_id: homeBase })
  ).catch(() => ({ error: { message: "get_base failed" }, result: undefined }));
  if (baseResp.error || !baseResp.result) {
    if (log && baseResp.error) {
      log("warn", `[get_base] failed for ${useCurrent ? "docked station" : homeBase}: ${baseResp.error.message}`);
    }
    return;
  }
  const baseObj = baseResp.result as Record<string, unknown>;
  const baseInner = (baseObj.base as Record<string, unknown>) || baseObj;
  const newFuel = (baseInner.fuel as number) ?? bot.homeBaseFuel ?? 0;
  const newMaxFuel = (baseInner.max_fuel as number) ?? bot.homeBaseMaxFuel ?? 0;
  if (log && (newFuel !== bot.homeBaseFuel || newMaxFuel !== bot.homeBaseMaxFuel)) {
    log("craft", `[get_base] ${useCurrent ? "docked station" : homeBase}: fuel=${newFuel}/${newMaxFuel}`);
  }
  bot.homeBaseFuel = newFuel;
  bot.homeBaseMaxFuel = newMaxFuel;
}

// Round-robin cursor and missing-facility dedupe used to live at MODULE level
// here, but that shared them across every drone in a process. They are now
// per-bot on `bot.facilityRoundRobin` / `bot.notifiedMissingFacilities`
// (see pickRoundRobinFacility / queueCraftJob / the main routine).

// Cumulative rental spend since the bot started (gated by rentalSpendingLimit).
// NOTE: this is intentionally shared/session-wide is NOT per-bot; if multiple
// drones each rent, the cap should be the operator's global budget anyway.
let rentalSpentThisSession = 0;

interface CraftLimit {
  recipeId: string;
  limit: number;
}

// A single material threshold that arms a recipe's auto-craft "trigger" mode.
// When the live count of `item` rises ABOVE `triggerAt`, the recipe is eligible
// to start; once started it queues enough runs to bring `item` back DOWN to
// `stopAt`. Multiple entries (one per required component) are ANDed: every
// material must be above its own trigger before the recipe fires, and the run
// count is sized so the *limiting* material lands exactly on its stop point.
export interface MaterialTrigger {
  item: string;
  triggerAt: number;
  stopAt: number;
}

// Per-recipe material-trigger configuration.
export interface RecipeTriggerConfig {
  // One entry per required INPUT material. The recipe fires only when ALL are
  // above their `triggerAt`, and queues enough runs to bring each down to its
  // `stopAt` (the limiting material wins).
  materials: MaterialTrigger[];
  // Optional cap on the recipe's OUTPUT item. When the output stock is at or
  // above this, the trigger will NOT fire — hysteresis so we stop producing once
  // we already have enough of the result (e.g. hold at 20k of a grown good and
  // only re-trigger once stock drops back below that).
  maxOutput?: number;
  // Optional firing priority within a cycle. Lower number fires first. Used to
  // arbitrate when several recipes share the same INPUT materials: the
  // highest-priority one consumes the surplus first, and lower-priority ones see
  // the reduced stock (via the in-cycle budget) and hold off when there isn't
  // enough left to reach their own stop point.
  priority?: number;
}

interface CrafterProfile {
  name: string;
  craftLimits: CraftLimit[];
  // Per-recipe material triggers (see RecipeTriggerConfig). Keyed by recipe id.
  recipeTriggers?: Record<string, RecipeTriggerConfig>;
}

// Normalize the (possibly legacy / loosely-shaped) recipeTriggers map into the
// typed RecipeTriggerConfig form. Accepts either the new object form
// { materials: [...], maxOutput, priority } or the legacy bare-array form
// ([{ item, triggerAt, stopAt }]).
function normalizeRecipeTriggers(
  raw: Record<string, unknown> | undefined,
): Record<string, RecipeTriggerConfig> {
  const out: Record<string, RecipeTriggerConfig> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [recipeId, val] of Object.entries(raw)) {
    if (!recipeId || !val) continue;
    const validMaterial = (t: any): t is { item: unknown; triggerAt: unknown; stopAt: unknown } =>
      !!t && typeof t.item === "string" && t.item &&
      typeof t.triggerAt === "number" && typeof t.stopAt === "number" &&
      t.triggerAt >= t.stopAt;
    let materials: MaterialTrigger[] = [];
    let maxOutput: number | undefined;
    let priority: number | undefined;
    if (Array.isArray(val)) {
      materials = (val as unknown[])
        .filter(validMaterial)
        .map(t => ({ item: (t.item as string).toLowerCase(), triggerAt: t.triggerAt as number, stopAt: t.stopAt as number }));
    } else if (typeof val === "object") {
      const obj = val as Record<string, unknown>;
      const rawMats = (obj.materials as unknown[]) || [];
      materials = (Array.isArray(rawMats) ? rawMats : [])
        .filter(validMaterial)
        .map(t => ({ item: (t.item as string).toLowerCase(), triggerAt: t.triggerAt as number, stopAt: t.stopAt as number }));
      if (typeof obj.maxOutput === "number" && obj.maxOutput >= 0) maxOutput = obj.maxOutput;
      if (typeof obj.priority === "number") priority = obj.priority;
    }
    if (materials.length > 0) {
      const cfg: RecipeTriggerConfig = { materials };
      if (maxOutput !== undefined) cfg.maxOutput = maxOutput;
      if (priority !== undefined) cfg.priority = priority;
      out[recipeId] = cfg;
    }
  }
  return out;
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
  craftingHomeBase: string;
  // Explicit recipe -> facility-type links for "facility only" recipes that the
  // catalog may not auto-associate (or where we want to pin the venue). e.g.
  // { "breed_plutonium": ["breeder_reactor_core", "enhanced_breeder_reactor",
  // "industrial_breeder_complex", "advanced_breeder_array"] }. These unblock the
  // recipe in the planner and let the crafter route it to the correct facility.
  recipeFacilityLinks: Record<string, string[]>;
}> {
  const { join } = require("path");
  const { readFileSync, existsSync } = require("fs");
  const file = join(process.cwd(), "data", "settings.json");
  const text = existsSync(file) ? readFileSync(file, "utf-8") : "";
  const raw = JSON.parse(text || "{}");
  const c = (raw.crafter as Record<string, unknown>) || {};
  const general = (raw.general as Record<string, unknown>) || {};
  const generalFactionStorageStation = (general.factionStorageStation as string) || "";

  const blacklistedRecipes: string[] = ((c.blacklistedRecipes as string[]) || [
    "basic_silicon_refinement",
    "fabricate_circuit_boards",
    "synthesize_energy_crystal",
    "synthesize_xenon_power_cell",
    "chlorine_circuit_etching",
  ]) as string[];

  const useQueuedCrafting = (c.useQueuedCrafting as boolean) ?? true;

  // Recipe -> facility-type links for facility-only recipes (see CrafterSettings).
  const rawRecipeFacilityLinks = (c.recipeFacilityLinks as Record<string, unknown>) || {};
  const recipeFacilityLinks: Record<string, string[]> = {};
  for (const [recipeId, facTypes] of Object.entries(rawRecipeFacilityLinks)) {
    if (typeof recipeId !== "string" || !recipeId) continue;
    const list = Array.isArray(facTypes)
      ? (facTypes as unknown[]).filter(t => typeof t === "string").map(t => t as string)
      : (typeof facTypes === "string" ? [facTypes as string] : []);
    if (list.length > 0) {
      recipeFacilityLinks[recipeId] = list;
    }
  }

  let crafters: CrafterProfile[] = [];
  if (Array.isArray(c.crafters)) {
    crafters = (c.crafters as Array<{name: string, craftLimits: any, recipeTriggers?: any}>).map(profile => {
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
      // Material triggers: { [recipeId]: { materials, maxOutput, priority } }.
      const recipeTriggers = normalizeRecipeTriggers(profile.recipeTriggers as any);
      return { name: profile.name || 'Unnamed Crafter', craftLimits, recipeTriggers };
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
      // Legacy global recipeTriggers key (flat object), for configs that still
      // use the old flat craftLimits format. New configs nest it under each
      // crafter profile instead.
      const recipeTriggers = normalizeRecipeTriggers(c.recipeTriggers as any);
      crafters.push({ name: "Default Crafter", craftLimits, recipeTriggers });
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
    // The faction-storage station the crafter reads its materials from. A
    // crafter can roam away from the faction home base, so this must be set
    // explicitly (falling back to general.factionStorageStation) — otherwise it
    // reads the wrong station and "loses" its stock, holding the whole chain.
    craftingHomeBase: (c.craftingHomeBase as string) || generalFactionStorageStation || "",
    recipeFacilityLinks,
  };
}

// ── Recipe helpers ────────────────────────────────────────────

export interface RecipeOutput {
  item_id: string;
  name: string;
  quantity: number;
}

function isFuelReserveItem(itemId: string): boolean {
  return itemId.toLowerCase() === "fuel_reserve";
}

function outputsFuelReserve(recipe: Recipe): boolean {
  if (!recipe.outputs || recipe.outputs.length === 0) {
    return isFuelReserveItem(recipe.output_item_id);
  }
  return recipe.outputs.some(o => isFuelReserveItem(o.item_id));
}

export interface Recipe {
  recipe_id: string;
  name: string;
  components: Array<{ item_id: string; name: string; quantity: number }>;
  output_item_id: string;
  output_name: string;
  output_quantity: number;
  // All outputs of the recipe (1+ entries). `output_item_id`/`output_quantity`
  // keep pointing at the FIRST output for backward compatibility; `outputs`
  // carries every produced item so multi-output recipes (e.g. electrolyze_water
  // -> hydrogen_gas + oxygen_gas) are tracked and requested correctly.
  outputs: RecipeOutput[];
  category?: string;
  effective_time_per_run?: number;
}

// The output with the LOWEST quantity per run is the limiting factor: a recipe
// that yields 4x hydrogen and 2x oxygen only advances both by runs, so the
// effective throughput is bounded by the smaller output. Requests must be sized
// against this item, otherwise the high-output item (hydrogen) alone makes the
// planner think the goal is already satisfied while the other (oxygen) stays at
// zero.
export function lowestOutputItem(recipe: Recipe): RecipeOutput {
  if (!recipe.outputs || recipe.outputs.length === 0) {
    return { item_id: recipe.output_item_id, name: recipe.output_name, quantity: recipe.output_quantity || 1 };
  }
  return recipe.outputs.reduce((min, o) =>
    (o.quantity || 1) < (min.quantity || 1) ? o : min
  );
}

// Human-readable list of all outputs, e.g. "4x hydrogen_gas, 2x oxygen_gas".
export function formatOutputs(recipe: Recipe): string {
  if (!recipe.outputs || recipe.outputs.length === 0) {
    return `${recipe.output_quantity || 1}x ${recipe.output_name || recipe.output_item_id}`;
  }
  return recipe.outputs
    .map(o => `${o.quantity}x ${o.name || o.item_id}`)
    .join(", ");
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
    const outputList: Array<Record<string, unknown>> = Array.isArray(rawOutputs)
      ? (rawOutputs as Array<Record<string, unknown>>)
      : (rawOutputs ? [rawOutputs as Record<string, unknown>] : []);
    const output: Record<string, unknown> = outputList[0] || {};
    const outputs: RecipeOutput[] = outputList.map(o => ({
      item_id: (o.item_id as string) || (o.id as string) || (o.item as string) || "",
      name: (o.name as string) || (o.item_name as string) || (o.item_id as string) || (o.id as string) || "",
      quantity: (o.quantity as number) || (o.amount as number) || (o.count as number) || 1,
    })).filter(o => o.item_id);
    return {
      recipe_id: (r.recipe_id as string) || (r.id as string) || "",
      name: (r.name as string) || (r.recipe_id as string) || "",
      components: comps.map(c => ({
        item_id: (c.item_id as string) || (c.id as string) || (c.item as string) || "",
        name: (c.name as string) || (c.item_name as string) || (c.item_id as string) || (c.id as string) || "",
        quantity: (c.quantity as number) || (c.amount as number) || (c.count as number) || 1,
      })),
      output_item_id: (output.item_id as string) || (output.id as string) || (output.item as string) || (r.output_item_id as string) || (outputs[0]?.item_id ?? ""),
      output_name: (output.name as string) || (output.item_name as string) || (r.name as string) || (outputs[0]?.name ?? ""),
      output_quantity: (output.quantity as number) || (output.amount as number) || (output.count as number) || (outputs[0]?.quantity ?? 1),
      outputs,
      category: (r.category as string) || "",
    };
  }).filter(r => r.recipe_id);
}

export async function fetchAllRecipes(ctx: RoutineContext): Promise<Recipe[]> {
  const { bot } = ctx;
  const all: Recipe[] = [];
  let page = 1;
  let totalPages = 1;
  while (true) {
    const resp = await bot.exec("catalog", { type: "recipes", page, page_size: 50 });
    if (resp.error) {
      ctx.log("error", `Catalog fetch failed (page ${page}): ${resp.error.message}`);
      break;
    }
    const parsed = parseRecipes(resp.result);
    all.push(...parsed);
    const r = resp.result as Record<string, unknown> | undefined;
    totalPages = (r?.total_pages as number) || 1;
    if (page === 1 && totalPages === 1 && all.length < 50) {
      ctx.log("warn", `Catalog API returned only ${all.length} recipes on page 1 with total_pages=1 — pagination may be broken (expected ${r?.total || "?"} total)`);
    }
    if (page >= totalPages || parsed.length === 0) break;
    page++;
  }
  if (all.length > 0) {
    ctx.log("debug", `fetchAllRecipes: ${all.length} total across ${page} page(s), total_pages=${totalPages}`);
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

// Normalize a recipeFacilityLinks config into a facility-type -> recipeId index.
// This is what lets an explicit link (e.g. breed_plutonium -> breeder_reactor_core)
// drive venue resolution even when the catalog doesn't carry the recipe_id.
function buildLinkIndex(recipeFacilityLinks: Record<string, string[]>): Map<string, string> {
  const idx = new Map<string, string>();
  for (const [recipeId, facTypes] of Object.entries(recipeFacilityLinks || {})) {
    for (const ft of facTypes || []) {
      idx.set(ft, recipeId);
    }
  }
  return idx;
}

function getRecipesAvailableAtFacilities(
  factionFacilities: FactionFacility[],
  facilityRecipeMap: FacilityRecipeMap[],
  recipeFacilityLinks: Record<string, string[]> = {},
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
  // Also count any explicitly linked facility we own, even if the catalog has
  // no recipe_id for it (the whole point of the linking feature).
  const linkIdx = buildLinkIndex(recipeFacilityLinks);
  for (const ft of facilityTypes) {
    const linkedRecipe = linkIdx.get(ft);
    if (linkedRecipe) availableRecipes.add(linkedRecipe);
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

export function buildOwnFacilityRecipeMap(
  factionFacilities: FactionFacility[],
  recipeFacilityLinks: Record<string, string[]> = {},
): OwnFacilityMap {
  const map: OwnFacilityMap = new Map();
  const catalogFacilities = catalogStore.getAll().facilities;
  const linkIdx = buildLinkIndex(recipeFacilityLinks);
  for (const f of factionFacilities) {
    if (f.faction_service !== "") continue; // only facilities we personally own
    if (f.status && f.status.toLowerCase() === "inactive") continue; // skip non-functional ones
    if (!f.facility_id || !f.type) continue;
    const catFac = catalogFacilities[f.type] as Record<string, unknown> | undefined;
    // Prefer the catalog's recipe_id, then fall back to an explicit link so a
    // facility-only recipe (e.g. breed_plutonium) still maps to its facility
    // even when the catalog doesn't carry the association.
    const recipeId = ((catFac?.recipe_id as string) || linkIdx.get(f.type) || "");
    if (!recipeId) continue;
    const list = map.get(recipeId) || [];
    list.push(f);
    map.set(recipeId, list);
  }
  return map;
}

// Re-query the live faction facility list and rebuild the derived maps. The
// crafter can run for a long time (the active plan loop below waits on jobs for
// hours), and a facility can be upgraded mid-run — which changes its level and
// possibly its type/recipe. Callers must re-resolve these every pass so a
// freshly upgraded facility is actually used instead of the stale snapshot.
async function refreshFacilityMaps(
  bot: any,
  settings: CrafterSettings,
): Promise<{
  factionFacilities: FactionFacility[];
  facilityAvailableRecipes: Set<string>;
  ownFacilityMap: OwnFacilityMap;
}> {
  const factionFacilities = await fetchFactionFacilities(bot);
  const facilityRecipeMap = getFacilityRecipeMap();
  const facilityAvailableRecipes = getRecipesAvailableAtFacilities(
    factionFacilities,
    facilityRecipeMap,
    settings.recipeFacilityLinks,
  );
  const ownFacilityMap = buildOwnFacilityRecipeMap(factionFacilities, settings.recipeFacilityLinks);
  return { factionFacilities, facilityAvailableRecipes, ownFacilityMap };
}

// Distribute jobs across multiple owned facilities of the same type by
// round-robining through them in a stable order. The cursor is per-bot
// (bot.facilityRoundRobin) so drones in a shared process don't collide on the
// same facility index for the same recipe.
function pickRoundRobinFacility(recipeId: string, facilities: FactionFacility[], bot: any): FactionFacility {
  const cursor = bot.facilityRoundRobin;
  const idx = (cursor.get(recipeId) || 0) % facilities.length;
  cursor.set(recipeId, idx + 1);
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
  craftingHomeBase: string;
  recipeFacilityLinks: Record<string, string[]>;
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
  bot?: any,
): ResolvedVenue {
  if (settings.forceOwnFacility) {
    const facs = ownFacilityMap.get(recipeId) || [];
    if (facs.length > 0) {
      const fac = pickRoundRobinFacility(recipeId, facs, bot);
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

interface CraftQueueRead {
  // False when the `craft queue` read itself failed (transport error / server
  // error). Callers must NOT treat that as "the queue is empty": doing so made
  // the tracker count missing syncs against real in-flight jobs and eventually
  // forget them, after which the planner re-queued work that was already running.
  ok: boolean;
  jobs: ServerJobInfo[];
}

async function checkCraftingQueue(bot: any, recipes: Recipe[], forceRefresh = false): Promise<CraftQueueRead> {
  const now = Date.now();
  const cache = bot.craftQueueCache;
  if (!forceRefresh && now - cache.lastQueueCheck < QUEUE_REFRESH_COOLDOWN) {
    return { ok: cache.lastQueueCheck > 0, jobs: cache.jobs };
  }

  const resp = await bot.exec("craft", { action: "queue" }).catch((e: any) => ({
    error: { message: (e as Error)?.message || String(e) },
    result: undefined,
  }));
  if (resp.error) {
    // Hand back the last known jobs but flag the read as failed so nobody
    // mistakes a failed fetch for an empty queue.
    return { ok: false, jobs: cache.jobs };
  }
  cache.lastQueueCheck = now;
  
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
  cache.jobs = jobs.map((job: Record<string, unknown>) => {
    const recipeName = ((job.recipe as string) || "").toLowerCase();
    const recipeFromId = (job.recipe as string) || "";
    // The `craft` queue response carries an authoritative server `recipe_id`
    // (the same id the crafting_update websocket events use). Prefer it over the
    // display `recipe` name: matching on the display name is fragile — when it
    // fails (e.g. "Fuel Reserve" vs "Manufacture Fuel (H2O2)") the job gets
    // keyed under a junk string, so `tracker.getProgress(recipeId)` reports 0
    // pending even though the job is live. That was the root cause of the
    // crafter endlessly re-queuing the same recipe and blowing past its limit.
    const serverRecipeId = (job.recipe_id as string) || "";
    const recipeId = (serverRecipeId && (recipeIdToId.get(serverRecipeId.toLowerCase()) || recipeIdToId.get(serverRecipeId)))
      || recipeNameToId.get(recipeName)
      || recipeOutputNameToId.get(recipeName)
      || recipeOutputItemToId.get(recipeName)
      || recipeIdToId.get(recipeFromId)
      || serverRecipeId
      || recipeFromId;
    return {
      jobId: (job.job_id as string) || "",
      recipeId,
      quantity: (job.runs_total as number) || 0,
      runsDone: (job.runs_done as number) || 0,
      runsRemaining: (job.runs_remaining as number) || 0,
    };
  }).filter((j: ServerJobInfo) => j.jobId && j.recipeId);
  return { ok: true, jobs: cache.jobs };
}

// Aggregate, per recipe_id, how many RUNS are still pending in the live `craft`
// queue (server-authoritative). This is the single source of truth for "how much
// is already in flight" and must NOT depend on the in-memory tracker's
// recipeIndex (which can be wiped by a transiently-incomplete fetch — see
// syncWithServer). Everything that needs pending (goal deficits, dedup, the
// hard limit clamp) should read from here so the crafter always "respects the
// live queue info from craft".
async function computeLivePendingRuns(
  bot: any,
  recipes: Recipe[],
  forceRefresh = true,
): Promise<Map<string, number>> {
  const { ok, jobs: serverJobs } = await checkCraftingQueue(bot, recipes, forceRefresh);
  const pending = new Map<string, number>();
  // A failed read means "unknown", not "nothing pending". Returning an empty map
  // makes every call site fall back to the in-memory tracker (`?? tracker...`),
  // which is the closest thing we have to the truth until the next good read.
  if (!ok) return pending;
  for (const j of serverJobs) {
    if (!j.recipeId) continue;
    const remain = Math.max(0, Math.min(j.quantity - j.runsDone, j.runsRemaining));
    pending.set(j.recipeId, (pending.get(j.recipeId) || 0) + remain);
  }
  return pending;
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
    const recipe = recipes.find(r => r.recipe_id === recipeId);
    const completedOutputs = (recipe && recipe.outputs.length > 0)
      ? recipe.outputs.map(o => `${o.quantity * progress.completed}x ${o.name || o.item_id}`).join("+")
      : `${progress.completed * (recipe?.output_quantity || 1)}x ${recipe?.name || recipeId}`;
    const queuedOutputs = (recipe && recipe.outputs.length > 0)
      ? recipe.outputs.map(o => `${o.quantity * progress.queued}x ${o.name || o.item_id}`).join("+")
      : `${progress.queued * (recipe?.output_quantity || 1)}x ${recipe?.name || recipeId}`;
    const name = recipeNames.get(recipeId) || recipeId;
    progressSummaries.push(`${completedOutputs}/${queuedOutputs} ${name} (${progress.remaining} runs remaining)`);
  }
  if (progressSummaries.length > 0) {
    log("craft", `[Queue Status] ${progressSummaries.join(", ")}`);
  } else {
    log("craft", "[Queue Status] No active jobs in queue");
  }
}

async function syncCraftingQueue(ctx: RoutineContext, tracker: CraftQueueTracker, recipes: Recipe[], forceRefresh = false): Promise<void> {
  const { bot } = ctx;
  const { ok, jobs: serverJobs } = await checkCraftingQueue(bot, recipes, forceRefresh);
  if (!ok) {
    // Do NOT reconcile against a failed read: syncWithServer would count this as
    // a "missing sync" for every live job and eventually forget them.
    ctx.log("warn", "craft queue read failed - keeping previously tracked jobs (not treating the queue as empty)");
    return;
  }
  tracker.syncWithServer(serverJobs);
  // Drop any job we track locally whose recipe no longer resolves to a known
  // catalog recipe — these are phantom jobs (stale session state, or jobs the
  // queue poller couldn't match) that would otherwise inflate "pending" output.
  tracker.prunePhantomJobs(new Set(recipes.map(r => r.recipe_id)));

  // PRESERVE the stall timestamp for fuel jobs that are undrainable (tank full).
  // syncWithServer() above "refreshes" lastProgressAt every read even when a job
  // hasn't actually advanced; a full-tank fuel job would otherwise never look
  // stalled and we'd never cancel it. If the tank is full and the job still has
  // runs left, keep counting the stall from when it first got wedged.
  const maxFuel = bot.homeBaseMaxFuel || 0;
  const fuel = bot.homeBaseFuel || 0;
  const tankFull = maxFuel > 0 && fuel >= maxFuel * 0.98;
  if (tankFull) {
    const recipeById = new Map(recipes.map(r => [r.recipe_id, r]));
    for (const job of tracker.getActiveJobs()) {
      if (job.completed >= job.quantity) continue;
      const recipe = recipeById.get(job.recipeId);
      if (recipe && outputsFuelReserve(recipe)) {
        tracker.pinStallSince(job.jobId, job.lastProgressAt);
      }
    }
  }

  // Auto-cancel jobs the server keeps listing but that have made NO progress for
  // a long time AND are genuinely blocked from completing (their output has
  // nowhere to go). A fuel_reserve job whose station tank is already full is the
  // classic case: the remaining runs can never deposit, so the server holds them
  // "queued" forever. That both blocks fresh top-up work and pollutes the
  // "pending" count — which is exactly what wedged this crafter for hours.
  //
  // We only cancel when ALL of: the job lists runs left, it has been stalled well
  // past any legitimate craft time, and it is for a fuel_reserve recipe whose
  // station tank is essentially full. We deliberately do NOT cancel every long-
  // stalled job: many recipes simply sit waiting for an input and are fine to
  // leave queued, and cancelling would waste whatever was reserved for them.
  await autoCancelUndrainableJobs(ctx, tracker, recipes, bot);
}

// Cancel fuel_reserve jobs whose output literally cannot be deposited: when the
// station's fuel tank is essentially full the server parks those remaining runs
// "queued" forever. Left alone that job (a) blocks the crafter from queueing the
// next top-up (the deficit logic treats it as in-flight forever) and (b) keeps a
// fake "pending" count alive — which is precisely why the crafter could sit for
// hours never issuing a new fuel run even though the tank wasn't being topped
// up. We only cancel after a long stall so a run that is merely being produced
// quickly, or waiting on an input, is never disturbed.
async function autoCancelUndrainableJobs(
  ctx: RoutineContext,
  tracker: CraftQueueTracker,
  recipes: Recipe[],
  bot: any,
): Promise<void> {
  const { log } = ctx;
  const maxFuel = bot.homeBaseMaxFuel || 0;
  const fuel = bot.homeBaseFuel || 0;
  // Tank must be essentially full or this run is not undrainable — leave it.
  if (maxFuel <= 0 || fuel < maxFuel * 0.98) return;

  const recipeById = new Map(recipes.map(r => [r.recipe_id, r]));
  const STALL_CANCEL_MS = 30 * 60 * 1000;
  for (const job of tracker.findStalledJobs(STALL_CANCEL_MS)) {
    if (job.completed >= job.quantity) continue;
    const recipe = recipeById.get(job.recipeId);
    if (!recipe || !outputsFuelReserve(recipe)) continue;
    // One warning per job before we act, so it isn't a silent cancellation.
    const firstSeen = tracker.markStallWarned(job.jobId);
    if (firstSeen) {
      const mins = Math.round((Date.now() - job.lastProgressAt) / 60000);
      log(
        "warn",
        `Crafting job ${job.jobId} (${recipe.name}) has not advanced in ${mins}m and the fuel tank is full ` +
        `(${fuel}/${maxFuel}) - its remaining ${job.runsRemaining} run(s) cannot deposit, so it will be cancelled in a moment ` +
        `to let the crafter top up again.`,
      );
    }
    // Give the operator one sync cycle to notice, then cancel.
    const resp = await bot.exec("craft", { job_id: job.jobId }).catch(() => ({ error: { message: "cancel failed" } }));
    if (resp.error) {
      log("warn", `Failed to cancel undrainable job ${job.jobId}: ${resp.error.message}`);
      continue;
    }
    tracker.forgetJob(job.jobId);
    log("craft", `Cancelled undrainable fuel job ${job.jobId} (${job.runsRemaining} run(s) could not deposit into a full tank)`);
  }
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

// ── Material-triggered crafting ───────────────────────────────
//
// A material trigger lets a recipe auto-fire when its INPUT materials pile up
// past a "trigger" threshold and craft back down to a "stop" threshold. This is
// the inverse of the normal craftLimit (which maintains a stock of OUTPUT): it
// is for "I keep mining iron_ore and want to convert the surplus into steel,
// but stop before I run the stock dry — e.g. wait until iron_ore > 490k, then
// refine until iron_ore drops to 200k."
//
// `evaluateRecipeTrigger` is pure (no I/O) so it can be unit-tested directly.

export function evaluateRecipeTrigger(
  recipe: Recipe,
  triggers: MaterialTrigger[] | undefined,
  countItemFn: (itemId: string) => number,
): number | null {
  if (!triggers || triggers.length === 0) return null;
  let runs = Infinity;
  let matchedAnyComponent = false;
  for (const t of triggers) {
    const current = countItemFn(t.item.toLowerCase());
    // The trigger item must actually be a component of this recipe, otherwise we
    // have no way to convert it. Skip (don't count) entries that don't match
    // BEFORE checking the threshold: a non-component material in the trigger
    // config (e.g. a stale or typo'd entry) must NOT cause the whole recipe to
    // fail to fire when the real components are above their triggers.
    const comp = recipe.components.find(
      c => c.item_id.toLowerCase() === t.item.toLowerCase(),
    );
    if (!comp) continue;
    matchedAnyComponent = true;
    // Every material must be ABOVE its trigger point before we start. Because
    // queued jobs immediately remove their materials from storage, `countItemFn`
    // already reflects only the FREE stock — so re-firing while a previous batch
    // is in flight is safe: we simply size from whatever is still free.
    if (!(current > t.triggerAt)) return null;
    const perRun = comp.quantity || 1;
    // How many runs would bring this material from `current` down to `stopAt`.
    const toCraft = Math.floor((current - t.stopAt) / perRun);
    if (toCraft <= 0) return null; // already at/below the stop point
    runs = Math.min(runs, toCraft);
  }
  if (!matchedAnyComponent) return null;
  return runs === Infinity ? null : runs;
}

/**
 * Evaluate and queue every material-triggered recipe for the active crafter
 * profile. Returns how many recipes fired and how many successfully queued.
 *
 * A recipe fires when all of its material triggers are above their `triggerAt`
 * on the RAW live stock, and we size the run count from the AVAILABLE material
 * (raw stock minus what is already committed by in-flight and same-cycle jobs)
 * so it brings the LIMITING material down to its `stopAt` without ever draining
 * below it. Because sizing is based on uncommitted material, a recipe can
 * re-fire while a previous batch is still in flight — it simply won't queue more
 * than the surplus that hasn't already been claimed. The whole batch is queued
 * in one shot (exactly like the user's "just put that all in one queue"
 * expectation).
 */
export async function processRecipeTriggers(
  ctx: RoutineContext,
  bot: any,
  recipes: Recipe[],
  recipeTriggers: Record<string, RecipeTriggerConfig> | undefined,
  ownFacilityMap: OwnFacilityMap,
  settings: CrafterSettings,
  countItemFn: (itemId: string) => number,
  tracker: CraftQueueTracker,
  livePendingRuns?: Map<string, number>,
  outputLimits?: Map<string, number>,
): Promise<{ fired: number; queued: number }> {
  const { log } = ctx;
  const result = { fired: 0, queued: 0 };
  if (!recipeTriggers || Object.keys(recipeTriggers).length === 0) return result;

  const recipeIndex = new Map(recipes.map(r => [r.recipe_id, r]));
  const allowedFacilityRecipeIds = new Set(
    Object.keys(settings.recipeFacilityLinks || {}),
  );
  const livePending =
    livePendingRuns ?? (await computeLivePendingRuns(bot, recipes, false));

  // Resolve every configured trigger to its recipe up front, dropping anything
  // unresolvable or not craftable. Keep the priority so we can order them.
  interface TriggerEntry {
    recipeId: string;
    recipe: Recipe;
    config: RecipeTriggerConfig;
    priority: number;
  }
  const entries: TriggerEntry[] = [];
  for (const [recipeId, config] of Object.entries(recipeTriggers)) {
    if (!config || !config.materials || config.materials.length === 0) continue;
    const recipe =
      recipeIndex.get(recipeId) ||
      recipes.find(r =>
        r.recipe_id === recipeId ||
        r.name.toLowerCase() === recipeId.toLowerCase() ||
        r.output_item_id.toLowerCase() === recipeId.toLowerCase(),
      );
    if (!recipe) {
      log("warn", `Material trigger: recipe "${recipeId}" not found - skipping`);
      continue;
    }
    const craftableCheck = isRecipeCraftableNew(recipe, allowedFacilityRecipeIds);
    if (!craftableCheck.ok) {
      log("warn", `Material trigger: recipe "${recipeId}" (${recipe.name}) not craftable: ${craftableCheck.reason}`);
      continue;
    }
    entries.push({ recipeId, recipe, config, priority: config.priority ?? 100 });
  }

  if (entries.length === 0) return result;

  // In-cycle material budget: a working copy of every involved INPUT's stock so
  // that when several recipes share a material, the higher-priority recipe
  // consumes the surplus first and lower-priority ones see the reduced stock
  // (and hold off if there isn't enough left to reach their own stop point).
  // Without this, two recipes both armed on the same ore would each size a full
  // drain in the same cycle and over-commit the shared stock.
  //
  // Key insight (per the crafting-queue model): once a recipe is queued, its
  // materials are IMMEDIATELY removed from faction storage and locked to that
  // job. So `countItem()` already reports only the FREE stock — in-flight jobs
  // do NOT hold materials in storage. We therefore seed the budget straight from
  // `countItem()` and only debit runs queued *this cycle*; we must NOT also
  // subtract in-flight runs, or we'd double-count and under-queue.
  const budget = new Map<string, number>();
  for (const e of entries) {
    for (const c of e.recipe.components) {
      const key = c.item_id.toLowerCase();
      if (!budget.has(key)) budget.set(key, countItemFn(key));
    }
  }
  const budgetCount = (item: string) => budget.get(item.toLowerCase()) ?? 0;

  // Process highest-priority first (lower number = earlier).
  entries.sort((a, b) => a.priority - b.priority);

  // Aggregate output limits by item so recipes that share the same output
  // collectively respect the limit (e.g. multiple superconductor recipes).
  const itemLimits = new Map<string, number>();
  if (outputLimits && outputLimits.size > 0) {
    for (const e of entries) {
      const limiter = lowestOutputItem(e.recipe);
      const outItem = limiter.item_id.toLowerCase();
      const recipeLimit = outputLimits.get(e.recipeId);
      if (recipeLimit === undefined) continue;
      const prev = itemLimits.get(outItem);
      if (prev === undefined || recipeLimit < prev) {
        itemLimits.set(outItem, recipeLimit);
      }
    }
  }

  // Build a combined pending map (server + tracker) keyed by recipeId, then
  // aggregate by output item so limit checks see total committed output.
  const combinedPendingByRecipe = new Map<string, number>();
  for (const [recipeId, runs] of livePending.entries()) {
    combinedPendingByRecipe.set(recipeId, (combinedPendingByRecipe.get(recipeId) || 0) + runs);
  }
  for (const job of tracker.getActiveJobs()) {
    const pending = Math.max(0, Math.min(job.quantity - job.completed, job.runsRemaining));
    combinedPendingByRecipe.set(job.recipeId, (combinedPendingByRecipe.get(job.recipeId) || 0) + pending);
  }

  const pendingOutputByItem = new Map<string, number>();
  for (const [recipeId, pendingRuns] of combinedPendingByRecipe.entries()) {
    const r = recipeIndex.get(recipeId);
    if (!r) continue;
    const outs = (r.outputs && r.outputs.length > 0) ? r.outputs : [{ item_id: r.output_item_id, quantity: r.output_quantity || 1 }];
    for (const o of outs) {
      const outId = o.item_id.toLowerCase();
      pendingOutputByItem.set(outId, (pendingOutputByItem.get(outId) || 0) + (o.quantity || 1) * pendingRuns);
    }
  }

  for (const e of entries) {
    if (bot.state !== "running") break;
    const { recipe, config } = e;

    // Output cap: don't (re)start if we already have enough of the result. This
    // is the hysteresis the user asked for — hold at e.g. 20k of a grown good and
    // only re-trigger once stock drops back below it. Checked against the LIVE
    // stock (output isn't consumed by crafting, so the budget doesn't track it).
    if (config.maxOutput !== undefined && config.maxOutput > 0) {
      const outItem = (recipe.output_item_id || "").toLowerCase();
      const haveOutput = outItem ? countItemFn(outItem) : 0;
      if (haveOutput >= config.maxOutput) {
        log("craft", markupHeld(`Material trigger held for ${recipe.name}:`, outItem, haveOutput, config.maxOutput));
        continue;
      }
    }

    // No "pending > 0" guard: a recipe may re-fire while a previous batch is
    // still in flight. Run sizing is based on uncommitted material (see the
    // budget above), so this can never drain below the stop point — it just
    // won't queue more than the surplus that hasn't already been claimed.

    let runs = evaluateRecipeTrigger(recipe, config.materials, budgetCount);
     if (runs === null) {
       const lowMaterials = config.materials
         .map(t => {
           const current = countItemFn(t.item.toLowerCase());
           const comp = recipe.components.find(
             c => c.item_id.toLowerCase() === t.item.toLowerCase(),
           );
           if (!comp || current > t.triggerAt) return null;
           return `${t.item}: LOW:${current} of ${t.triggerAt}`;
         })
         .filter((s): s is string => s !== null);
        if (lowMaterials.length > 0) {
          log("craft", markupNotCrafting(recipe.name, recipe.recipe_id, lowMaterials));
        }
       continue;
     }

     // Respect the recipe's output cap (the craftLimit / "make N outputs" target):
     // a material trigger should fill the surplus but never produce past the
     // user's stated maximum. If the cap is already met (or will be by in-flight
     // work), hold off instead of over-producing. Limits are aggregated by output
     // item so multiple recipes producing the same item share the cap.
     if (itemLimits.size > 0) {
       const limiter = lowestOutputItem(recipe);
       const outPerRun = limiter.quantity || 1;
       const outItem = limiter.item_id.toLowerCase();
       const itemLimit = itemLimits.get(outItem);
       if (itemLimit !== undefined) {
         const haveOut = countItemFn(outItem);
         const pendingOut = pendingOutputByItem.get(outItem) || 0;
         const room = itemLimit - (haveOut + pendingOut);
         if (room <= 0) {
           log("craft", `Material trigger held for ${recipe.name}: output ${outItem} at ${HTML_GREEN}${haveOut}+${pendingOut} pending >= cap ${itemLimit}${HTML_RESET}`);
           continue;
         }
         const maxRuns = Math.floor(room / outPerRun);
         if (maxRuns <= 0) continue;
         if (runs > maxRuns) {
           log("craft", `Material trigger for ${recipe.name}: capping ${runs} runs to ${HTML_CYAN}${maxRuns}${HTML_RESET} (output cap ${HTML_GREEN}${itemLimit}${HTML_RESET})`);
           runs = maxRuns;
         }
       }
     }

     // maxOutput cap configured on the trigger itself: a fired trigger must never
     // produce more than this many of the output item. The hold gate above only
     // skips firing when LIVE stock already exceeds the cap, but it does NOT clamp
     // the run count — so a recipe with a large input surplus would fire and blow
     // well past the user's stated maximum (e.g. queue 3784 runs with maxOutput
     // 1000). Cap the run count here too, accounting for in-flight work.
     if (config.maxOutput !== undefined && config.maxOutput > 0) {
       const limiter = lowestOutputItem(recipe);
       const outPerRun = limiter.quantity || 1;
       const outItem = limiter.item_id.toLowerCase();
       const haveOut = countItemFn(outItem);
       const pendingRuns = livePending.get(recipe.recipe_id) ?? tracker.getProgress(recipe.recipe_id).remaining;
       const pendingOut = pendingRuns * outPerRun;
       const room = config.maxOutput - (haveOut + pendingOut);
       if (room <= 0) {
         log("craft", `Material trigger held for ${recipe.name}: output ${outItem} at ${HTML_GREEN}${haveOut}+${pendingOut} pending >= cap ${config.maxOutput}${HTML_RESET}`);
         continue;
       }
      const maxRuns = Math.floor(room / outPerRun);
      if (maxRuns <= 0) continue;
      if (runs > maxRuns) {
        log("craft", `Material trigger for ${recipe.name}: capping ${runs} runs to ${maxRuns} (maxOutput ${config.maxOutput})`);
        runs = maxRuns;
      }
    }

    result.fired++;
    const limiter = lowestOutputItem(recipe);
    const outputPerRun = limiter.quantity || 1;
    const venue = resolveVenueForRecipe(recipe.recipe_id, recipe.name, ownFacilityMap, settings, bot);
    const summary = config.materials.map(t => `${t.item}>${span(String(t.triggerAt), "ansi-cyan")}→stop ${span(String(t.stopAt), "ansi-green")}`).join(", ");
    log("craft", `${span("⚡", "ansi-yellow")} Material trigger ${span("FIRED", "ansi-green")} (pri ${span(String(e.priority), "ansi-cyan")}) for ${recipe.name}: ${summary} -> queueing ${span(String(runs), "ansi-cyan")} run(s) (limiting output ${span(`${outputPerRun}x ${limiter.name}`, "ansi-cyan")})`);

    const queueResult = await queueCraftJob(
      ctx,
      recipe.recipe_id,
      runs * outputPerRun,
      bot,
      tracker,
      countItemFn,
      recipes,
      venue,
      settings,
      ownFacilityMap,
      outputPerRun,
      countItemFn,
    );
    if (queueResult.success) {
      result.queued++;
      log("craft", `${span("✓", "ansi-green")} Queued ${span(String(queueResult.queuedRuns), "ansi-cyan")} run(s) of ${recipe.name} via material trigger`);
      // Debit the budget for every component this batch will consume, so later
      // (lower-priority) triggers sharing any input see the reduced availability.
      for (const c of recipe.components) {
        const key = c.item_id.toLowerCase();
        budget.set(key, Math.max(0, (budget.get(key) ?? 0) - runs * (c.quantity || 1)));
      }
    } else if (queueResult.error && queueResult.error !== "Job already queued") {
      log("error", `Failed to queue material-trigger run for ${recipe.name}: ${queueResult.error}`);
    }
  }

  return result;
}

// ── External facility guard (dry-run cost check) ──────────────

interface CraftQuote {
  external: boolean;
  fee: number;
  labor: number;
  creditsTotal: number;
  // Server-authoritative affordability for the whole quoted job. This already
  // accounts for faction storage/treasury coverage (when deliver_to is omitted
  // the server auto-draws from the faction when personal funds can't cover it),
  // so it is the correct signal to gate on — not a naive fee-vs-limit compare.
  haveCredits: boolean;
  haveInputs: boolean;
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
    // Only treat the job as affordable/faction-covered when the server says so
    // explicitly. Absence must NOT auto-cover a paid rental (that would bypass
    // the personal spending limit), so default to false when the field is missing.
    haveCredits: r.have_credits === true,
    haveInputs: r.have_inputs === true,
    venue: (r.venue as string) || "",
    venueType: (r.venue_type as string) || "",
    recipe: (r.recipe as string) || "",
  };
}

// Some recipes can only be produced at a real facility and error out when we
// try preset=workshop (hand-crafting). Detect that specific server error so we
// don't treat an impossible workshop fallback as a hard block.
function isFacilityOnlyError(msg: string | undefined): boolean {
  const m = (msg || "").toLowerCase();
  return m.includes("can only be made at a facility") ||
    (m.includes("can't be hand-crafted") || m.includes("cant be hand-crafted")) ||
    m.includes("drop preset=workshop");
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
  primaryOutputQty: number = 1,
): Promise<FinalVenue> {
  const { log } = ctx;

  const dryRun = async (preset?: string, facilityId?: string) => {
    const payload: Record<string, unknown> = { id: recipeId, quantity: runs * primaryOutputQty, dry_run: true };
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
      // Facility-only recipes can't be hand-crafted, so the workshop fallback is
      // impossible. Since rental is disabled by config, we can't run this here.
      if (isFacilityOnlyError(ws.error.message)) {
        log("warn", `${recipeName} can only be made at a facility and rental is disabled - skipping (enable allowRentalPurchase/allowExternalFacilities to craft it).`);
        return { blocked: true, rentalFee: 0, label: "facility-only (rental disabled)" };
      }
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
        log("warn", `Rental fee ${rentalFee}cr would exceed spending limit ${settings.rentalSpendingLimit}cr for ${recipeName} - trying workshop (hand-crafting)`);
        const ws = await dryRun("workshop", undefined);
        if (ws.error) {
          // Facility-only recipe: hand-crafting is impossible, so there is no
          // cheaper venue. Rather than hard-blocking the whole crafting chain,
          // honor the auto-routed facility when the server confirms the job is
          // actually affordable (have_credits — this already includes faction
          // storage/treasury coverage when personal funds fall short). The
          // spending limit still applies to recipes that CAN hand-craft.
          if (isFacilityOnlyError(ws.error.message)) {
            if (quote.haveCredits) {
              log("warn", `${recipeName} can only be made at a facility (${rentalFee}cr) and exceeds the rental spending limit (${settings.rentalSpendingLimit}cr), but the job is affordable (faction/treasury may cover it) - proceeding at the facility.`);
              // Don't count faction-covered facility jobs against the personal
              // rental spend; the limit is about capping bot-initiated rentals.
              rentalFee = 0;
            } else {
              log("warn", `${recipeName} can only be made at a facility (${rentalFee}cr), exceeds the rental spending limit (${settings.rentalSpendingLimit}cr, spent ${rentalSpentThisSession}cr), and isn't affordable - blocking. Raise rentalSpendingLimit or fund the faction treasury to craft it.`);
              return { blocked: true, rentalFee: 0, label: "facility-only (limit reached)" };
            }
          } else {
            log("error", `🔴 CRAFT VENUE UNVERIFIED: workshop dry_run failed for ${recipeName} (${ws.error.message}). Blocking.`);
            return { blocked: true, rentalFee: 0, label: "workshop-failed" };
          }
        } else {
          quote = parseCraftQuote(ws.result);
          return { facilityId: undefined, preset: "workshop", blocked: false, rentalFee: 0, label: "workshop (limit reached)" };
        }
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
  // Per-run quantity of the OUTPUT we are sizing the request against. For
  // multi-output recipes the caller must pass the limiting output's quantity
  // (lowestOutputItem().quantity); otherwise runs are mis-sized against the
  // first output and the smaller secondary outputs never get produced.
  outputPerRun: number = 0,
  rawCountItemFn?: (itemId: string) => number,
): Promise<{ success: boolean; error?: string; jobId?: string; queuedRuns?: number }> {
  const { log } = ctx;

   const recipe = recipes?.find(r => r.recipe_id === recipeId);
   // Prefer the explicitly-passed limiting output quantity; fall back to the
   // recipe's first output for single-output recipes.
   const outputQty = outputPerRun > 0
     ? outputPerRun
     : (recipe?.output_quantity || 1);
   const originalRuns = Math.ceil(quantity / outputQty);

   if (tracker.hasPendingJob(recipeId, originalRuns)) {
     return { success: true, error: "Job already queued", queuedRuns: originalRuns };
   }

   const { ok: queueOk, jobs: serverJobs } = await checkCraftingQueue(bot, recipes || [], true);
   if (queueOk) tracker.syncWithServer(serverJobs);
   if (tracker.hasPendingJob(recipeId, originalRuns)) {
     return { success: true, error: "Job already queued", queuedRuns: originalRuns };
   }

    const maxCraftable = calculateMaxCraftable(recipe, rawCountItemFn || countItemFn);
   const runs = Math.min(originalRuns, maxCraftable);

   if (runs <= 0) {
     log("craft", `Cannot craft ${recipeId}: need materials but storage empty or insufficient`);
     return { success: false, error: "insufficient_inputs" };
   }

   if (runs < originalRuns) {
     log("craft", `Only ${runs}/${originalRuns} runs possible due to materials - queuing what's available`);
   }

   // The craft command's `quantity` is the TOTAL OUTPUT of the PRIMARY output,
   // not a run count. Convert runs -> output units so the server sizes the job
   // correctly, especially for recipes with high per-run output (e.g. 200x).
   const primaryOutputQty = recipe?.output_quantity || 1;
   const craftCommandQuantity = runs * primaryOutputQty;

  // Notify (once per recipe per run) when we wanted our own facility but lack one.
  // Per-bot (bot.notifiedMissingFacilities) so one drone's dedup doesn't silence
  // the warning for every other drone.
  if (venue.missingFacility) {
    const key = recipe?.name || recipeId;
    if (!bot.notifiedMissingFacilities.has(key)) {
      bot.notifiedMissingFacilities.add(key);
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

    const finalVenue = await resolveFinalVenue(ctx, bot, recipeId, recipe?.name || recipeId, chunk.runs, chunkVenue, settings, primaryOutputQty);
    if (finalVenue.blocked) {
      firstError = firstError || "external_facility_blocked";
      continue;
    }

    log("craft", `Queueing ${chunk.runs} runs of ${recipeId} (${finalVenue.label})...`);
    const craftPayload: Record<string, unknown> = { id: recipeId, quantity: craftCommandQuantity };
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

  const { ok: firstReadOk, jobs: serverJobIds } = await checkCraftingQueue(bot, recipes);
  if (firstReadOk) tracker.syncWithServer(serverJobIds);

  // Measure completion RELATIVE to where the job started. `progress.completed`
  // is cumulative for the life of the tracked job, so comparing it directly
  // against the freshly-requested quantity reported "done" the instant an older
  // job for the same recipe had already produced that much.
  const baselineRuns = tracker.getProgress(recipeId).completed;

  while (bot.state === "running") {
    await ctx.sleep(5000);

    const now = Date.now();
    if (now - bot.craftQueueCache.lastQueueCheck >= QUEUE_REFRESH_COOLDOWN) {
      const { ok, jobs: currentJobIds } = await checkCraftingQueue(bot, recipes);
      if (ok) tracker.syncWithServer(currentJobIds);
    }

    const progress = tracker.getProgress(recipeId);
    const currentCompletedItems = Math.max(0, progress.completed - baselineRuns) * outputQty;
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

async function queueAllRecipesOnce(
    ctx: RoutineContext,
    allPlanItems: Array<{ recipe: Recipe; quantityToCraft: number; reason: string; depth: number }>,
    tracker: CraftQueueTracker,
    recipes: Recipe[],
    availableFn: (itemId: string) => number,
    ownFacilityMap: OwnFacilityMap,
    settings: CrafterSettings,
    rawCountItemFn: (itemId: string) => number,
    // Live in-flight pending, per recipe_id (RUNS), read authoritatively from the
    // `craft` queue. When omitted we re-derive it here. This is what stops the
    // crafter from ignoring already-queued work and re-queueing past the limit.
    livePendingRuns?: Map<string, number>,
    // Hard ceiling per recipe_id (in limiting-output ITEMS) from the craftLimit.
    // When set, the total queued runs for a recipe are clamped so completed +
    // pending + queued can never exceed it.
    limitByRecipe?: Map<string, number>,
): Promise<{ queued: Array<{ recipeId: string; quantity: number; outputQty: number }>; queuedItems: number }> {
    const { bot } = ctx;
    const queued: Array<{ recipeId: string; quantity: number; outputQty: number }> = [];
    let queuedItemsTotal = 0;

    await syncCraftingQueue(ctx, tracker, recipes, true);
    // Authoritative in-flight pending, straight from the live `craft` queue —
    // never trust the in-memory tracker's recipeIndex alone (it can be wiped by a
    // transiently-incomplete fetch, which is what let the crafter stack 28M fuel
    // against a 275k limit).
    const livePending = livePendingRuns ?? await computeLivePendingRuns(bot, recipes, true);
    // Runs we queue during THIS pass, per recipe. `livePending` is read once at
    // the top of the pass, so without this a recipe that appears twice in the
    // plan (two goals sharing a sub-material) would be sized against pre-queue
    // pending and could be queued twice.
    const queuedRunsThisPass = new Map<string, number>();

    for (const item of allPlanItems) {
      if (bot.state !== "running") break;

      // Size everything in RUNS and against the LIMITING output so multi-output
      // recipes produce every output (e.g. electrolyze_water -> both hydrogen and
      // oxygen), instead of letting the largest output mask the deficit.
      const limiter = lowestOutputItem(item.recipe);
      const outputPerRun = limiter.quantity || 1;
      // Prefer the authoritative live pending; only fall back to the in-memory
      // tracker if the live read lacks this recipe.
      const pendingRuns = livePending.get(item.recipe.recipe_id) ?? tracker.getProgress(item.recipe.recipe_id).remaining;
      const alreadyQueuedThisPass = queuedRunsThisPass.get(item.recipe.recipe_id) || 0;

      // item.quantityToCraft is expressed in LIMITING-output items: the goal loop
      // sizes deficits against lowestOutputItem(), and buildCraftingTree converts
      // it to runs with `ceil(items / limiterQty)`. It must therefore NOT be
      // rescaled by (output_quantity / outputPerRun) — for a multi-output recipe
      // (e.g. 4x hydrogen + 2x oxygen) that inflated the request by the ratio
      // between the outputs and queued twice the runs actually needed.
      const targetLimiterItems = item.quantityToCraft;
      // `quantityToCraft` is ALREADY a net deficit: the planner sized it as
      // limit - (live stock + in-flight output) for goals, and as
      // needed - available (which also credits in-flight output) for
      // sub-materials. Subtracting the tracker's `completed`/`pending` AGAIN here
      // double-counted work that is already reflected in the deficit and is what
      // wedged the crafter: a job that had finished 100 of 101 runs made
      // `completed * outputPerRun` (20 000 items) larger than any remaining
      // deficit, so `runsToQueue` was 0 on EVERY pass and nothing was ever
      // queued again until the process was restarted (which reset the tracker).
      let runsToQueue = Math.max(0, Math.ceil(targetLimiterItems / outputPerRun) - alreadyQueuedThisPass);

      // HARD LIMIT CLAMP: never queue so much that stock + pending + queued
      // exceeds the configured craftLimit (in limiting-output items). This is the
      // guaranteed safety net — even if the deficit is somehow miscounted, a
      // recipe can never blow past its cap (e.g. 275k fuel_reserve). It is sized
      // against LIVE STOCK (not the tracker's cumulative `completed`, which
      // keeps counting output that is already sitting in storage and therefore
      // clamped the crafter to zero forever).
      const limitItems = limitByRecipe?.get(item.recipe.recipe_id);
      if (limitItems !== undefined) {
        const limitRuns = Math.ceil(limitItems / outputPerRun);
        const stockRuns = Math.floor(Math.max(0, rawCountItemFn(limiter.item_id.toLowerCase())) / outputPerRun);
        const maxQueueable = Math.max(0, limitRuns - stockRuns - pendingRuns - alreadyQueuedThisPass);
        if (runsToQueue > maxQueueable) {
          if (maxQueueable <= 0) {
            ctx.log("craft", `✓ ${item.recipe.name}: at/over limit (stock ${stockRuns} + pending ${pendingRuns} runs >= ${limitRuns} run limit) - not queueing more`);
            // nothing to do; record what's already in flight so waiters still see it
            const actualQueued = tracker.getProgress(item.recipe.recipe_id).queued;
            queued.push({ recipeId: item.recipe.recipe_id, quantity: actualQueued * outputPerRun, outputQty: outputPerRun });
            continue;
          }
          ctx.log("craft", `Capping ${item.recipe.name}: ${runsToQueue} runs requested but only ${maxQueueable} fit under the ${limitItems}-item limit (stock ${stockRuns} + pending ${pendingRuns} runs, limit ${limitRuns} runs)`);
          runsToQueue = maxQueueable;
        }
      }
      if (runsToQueue <= 0) {
        // Log it: this used to be a silent `continue`, which is exactly why the
        // wedged crafter looked like it was "planning" every pass while never
        // queueing a single run.
        ctx.log("craft", `${item.recipe.name}: nothing to queue this pass (deficit ${Math.ceil(targetLimiterItems)} items, ${pendingRuns} runs already in flight)`);
        const actualQueued = tracker.getProgress(item.recipe.recipe_id).queued;
        queued.push({ recipeId: item.recipe.recipe_id, quantity: actualQueued * outputPerRun, outputQty: outputPerRun });
        continue;
      }

       const venue = resolveVenueForRecipe(item.recipe.recipe_id, item.recipe.name, ownFacilityMap, settings, bot);
        const queueResult = await queueCraftJob(ctx, item.recipe.recipe_id, runsToQueue * outputPerRun, bot, tracker, availableFn, recipes, venue, settings, ownFacilityMap, outputPerRun, rawCountItemFn);
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
      queuedRunsThisPass.set(item.recipe.recipe_id, alreadyQueuedThisPass + actualQueued);
      queued.push({ recipeId: item.recipe.recipe_id, quantity: actualQueued * outputPerRun, outputQty: outputPerRun });
      queuedItemsTotal += actualQueued * outputPerRun;
      if (actualQueued * outputPerRun < runsToQueue * outputPerRun) {
        ctx.log("craft", `Partially queued ${item.recipe.name}: ${actualQueued} runs / ${runsToQueue} (limits: ${formatOutputs(item.recipe)}) (awaiting sub-materials)`);
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

   // Facility-only recipes that have been explicitly linked to a facility via
   // recipeFacilityLinks are permitted in the planner (otherwise breed_plutonium
   // and friends are rejected by isRecipeCraftable as "facility only").
    let allowedFacilityRecipeIds = new Set(
      Object.keys(settings?.recipeFacilityLinks || {})
    );

    let recipeIndex = new Map(recipes.map(r => [r.recipe_id, r]));
    const outputQtyOf = (recipeId: string) => recipeIndex.get(recipeId)?.output_quantity || 1;

   const recipeIdForGoal = (g: { itemId: string; recipe?: Recipe }): string => {
     if (g.recipe) return g.recipe.recipe_id;
      const r = findRecipeForItem(g.itemId, recipes, countItemFn!, facilityAvailableRecipes, allowedFacilityRecipeIds);
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
        const outs = (r.outputs && r.outputs.length > 0)
          ? r.outputs
          : [{ item_id: r.output_item_id, name: r.output_name, quantity: r.output_quantity || 1 }];
        for (const o of outs) {
          const outId = o.item_id.toLowerCase();
          produced.set(outId, (produced.get(outId) || 0) + (o.quantity || 1) * pending);
        }
      }
      return { hasPending, produced };
    };

    // Per-recipe hard ceiling (in limiting-output ITEMS) taken from the
    // configured craftLimit. Used by queueAllRecipesOnce to clamp how much we
    // ever queue, so a recipe can NEVER exceed its limit even if pending tracking
    // glitches (this is the safety net that prevents the 28M-fuel disaster).
    const limitByRecipe = new Map<string, number>();
    for (const g of goalsToAchieve) {
      const recipeId = recipeIdForGoal(g);
      if (recipeId && g.limit > 0) {
        // Keep the smallest limit if a recipe is targeted by multiple goals.
        const prev = limitByRecipe.get(recipeId);
        limitByRecipe.set(recipeId, prev === undefined ? g.limit : Math.min(prev, g.limit));
      }
    }

    // Single-pass plan: sync the server queue, compute remaining goal deficits,
    // build the full multi-goal crafting tree, and queue every recipe in one
    // shot. Sub-materials that can't be queued yet (their inputs haven't been
    // produced) are skipped — the next outer cycle (after cycleTimeSec seconds)
    // re-reads fresh stock/storage and queues them then. This keeps the crafter
    // simple and predictable: queue once, wait cycleTimeSec, full restart.
    await syncCraftingQueue(ctx, tracker, recipes, true);

    // Recompute which goals still need production using live stock + in-flight
    // output. Read pending straight from the authoritative `craft` queue so a
    // transiently-stale tracker (which would report 0 pending) can never make
    // us think we're short and re-queue past the limit.
    const livePendingRuns = await computeLivePendingRuns(bot, recipes, true);
    const remainingGoals: Array<{ itemId: string; quantity: number; recipe?: Recipe }> = [];
    for (const g of goalsToAchieve) {
      const recipeId = recipeIdForGoal(g);
      if (!recipeId) continue;
      const liveStock = countItemFn!(g.itemId.toLowerCase());
      const pendingRuns = livePendingRuns.get(recipeId) ?? tracker.getProgress(recipeId).remaining;
      const queuedOutput = pendingRuns * outputQtyOf(recipeId);
      if (liveStock + queuedOutput < g.limit) {
        remainingGoals.push({ itemId: g.itemId, quantity: g.limit - (liveStock + queuedOutput), recipe: g.recipe });
      }
    }

    if (remainingGoals.length > 0) {
      // Credit outputs that in-flight jobs will produce so we can keep building
      // higher-tier items as soon as their sub-materials appear. We must NOT also
      // subtract the materials those jobs consume: the server deducts a job's
      // inputs up-front when it is queued, so the live faction-storage count we
      // read each pass ALREADY excludes them. Subtracting them again here would
      // double-count and could zero out a material we genuinely have.
      const { hasPending, produced } = accountPending();
      const availableFn = (itemId: string): number => {
        const id = itemId.toLowerCase();
        return Math.max(0, countItemFn!(id) + (produced.get(id) || 0));
      };

      const plans = calculateMultiGoalPlan(remainingGoals, recipes, availableFn, facilityAvailableRecipes, countItemFn!, allowedFacilityRecipeIds);
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
      const { queuedItems } = await queueAllRecipesOnce(ctx, allPlanItems, tracker, recipes, availableFn, ownFacilityMap, effectiveSettings, countItemFn!, livePendingRuns, limitByRecipe);

      if (queuedItems > 0) {
        log("craft", `Queued ${queuedItems} item(s) this pass - waiting ${settings?.cycleTimeSec || 30}s for the next cycle to re-evaluate`);
      }
      if (hasPending && queuedItems === 0) {
        log("craft", "Sub-materials in production - will be ready next cycle");
      }
    } else {
      log("craft", "All goals covered by stock + in-flight queue - nothing to queue this cycle");
    }

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
    if (!isRecipeCraftableNew(recipe, new Set(Object.keys(settings.recipeFacilityLinks || {}))).ok) continue;

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
    const { ok: queueOk, jobs: serverJobIds } = await checkCraftingQueue(bot, recipes);
    if (queueOk) tracker.syncWithServer(serverJobIds);

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
    ctx.log("craft", `Queueing ${runs} run(s) of ${target.name} (outputs: ${formatOutputs(target)}; category: ${target.category})`);
    const venue = resolveVenueForRecipe(target.recipe_id, target.name, ownFacilityMap, settings, bot);
     const queueResult = await queueCraftJob(ctx, target.recipe_id, 1, bot, tracker, countItemForCraft, recipes, venue, settings, ownFacilityMap, 0, countItemForCraft);
    if (!queueResult.success) {
      if (queueResult.error && queueResult.error.includes("aborted")) {
        ctx.log("warn", `Crafting halted: ${queueResult.error}`);
        break;
      }
      ctx.log("error", `Failed to queue ${target.name}: ${queueResult.error}`);
      await ctx.sleep(2000);
      continue;
    }

    crafted.push(formatOutputs(target));
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
  const { modules } = extractShipModules(shipResp.result);
  for (const mod of modules) {
    if (moduleHaystack(mod).includes("cloak")) return true;
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
    // Re-evaluate missing-facility warnings each cycle. The dedupe set is
    // process-lifetime, so clearing it lets a facility that became available
    // (e.g. after an upgrade) stop being silently treated as permanently missing.
    // Per-bot now (bot.notifiedMissingFacilities), so clearing one drone's dedupe
    // doesn't affect the others.
    bot.notifiedMissingFacilities.clear();
    await detectAndRecoverFromDeath(ctx);
    if (bot.state !== "running") break;

    const settings = await getCrafterSettings();
    const cycleWaitMs = (settings.cycleTimeSec || 30) * 1000;

    // Facility-only recipes that have been explicitly linked to a facility via
    // recipeFacilityLinks. These are allowed through isRecipeCraftable even
    // though their category is "Facility Only" (e.g. breed_plutonium).
    const allowedFacilityRecipeIds = new Set(Object.keys(settings.recipeFacilityLinks || {}));

    yield "scavenge";

    yield "dock";
    await ensureDocked(ctx);

    // Refresh home station fuel via get_base so fuel_reserve goals compare against accurate data.
    // A "@current" home base reads the docked station; a fixed id reads that station; empty leaves
    // the fuel untouched (preserving prior behavior).
    if (settings.craftingHomeBase) {
      await refreshCrafterBaseFuel(bot, settings.craftingHomeBase, ctx.log);
    }

    yield "fetch_recipes";
    const recipes = await fetchAllRecipes(ctx);
    ctx.log("craft", `Fetched ${recipes.length} recipes from catalog API`);
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
    // Target the crafting home base station explicitly: a roaming crafter may be
    // docked elsewhere, and reading the current station's (near-empty) storage
    // would make the planner "lose" its stock and wrongly re-smelt everything.
    // A "@current" home base reads the station the crafter is docked at.
    const fsArgs = factionStorageRefreshArgs(settings.craftingHomeBase || "");
    await bot.refreshFactionStorage(true, fsArgs.stationId, fsArgs.readCurrentStation);

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
      if (isFuelReserveItem(lowerId)) {
        total += (bot.homeBaseFuel || 0);
      }
      return total;
    }

    // Grab a FRESH facility list every round: facilities can be upgraded (new
    // level/type) while the crafter runs, and we must route to the current one.
    const { factionFacilities, facilityAvailableRecipes, ownFacilityMap } = await refreshFacilityMaps(bot, settings);
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

    // Authoritative in-flight pending, read straight from the live `craft`
    // queue. The in-memory tracker can momentarily lose jobs (an incomplete
    // fetch), which would make `tracker.getProgress()` report 0 pending and lead
    // to re-queueing past the limit — so always size deficits against this.
    const livePendingRuns = await computeLivePendingRuns(bot, recipes, true);

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
      const craftableCheck = isRecipeCraftableNew(recipe, allowedFacilityRecipeIds);
      if (!craftableCheck.ok) {
        ctx.log("error", `Recipe "${recipeId}" (${recipe.name}) is not craftable: ${craftableCheck.reason}`);
        continue;
      }

      const recipeCategory = recipe.category || "";
      if (isSpecializedBot && !assignedCategories.includes(recipeCategory)) {
        ctx.log("craft", `Skipping "${recipeId}" (${recipe.name}): category not assigned to this bot`);
        continue;
      }

      // Base the request on the LOWEST output (limiting factor): a multi-output
      // recipe only advances all outputs by whole runs, so we must size the goal
      // against the smallest per-run output. Otherwise the large output alone
      // (e.g. 4x hydrogen) makes the planner think the goal is met while the
      // other output (e.g. 2x oxygen) stays at zero.
      const limiter = lowestOutputItem(recipe);
      const limitRuns = Math.ceil(limit / (limiter.quantity || 1));
      const currentStock = countItem(limiter.item_id);
      // Prefer the authoritative live pending; fall back to the in-memory tracker
      // only if the live read lacks this recipe.
      const pendingRuns = livePendingRuns.get(recipe.recipe_id) ?? tracker.getProgress(recipe.recipe_id).remaining;
      const pendingItems = pendingRuns * (limiter.quantity || 1);
      const stockIncludingQueue = currentStock + pendingItems;
      const needed = limitRuns * (limiter.quantity || 1) - stockIncludingQueue;
      if (needed <= 0) {
        ctx.log("craft", `✓ ${recipe.name}: already have ${currentStock}/${limit} of limiting output ${limiter.name} (outputs: ${formatOutputs(recipe)}; plus ${pendingItems} pending)`);
        continue;
      }

      ctx.log("craft", `Goal: ${limitRuns} runs of ${recipe.name} -> ${formatOutputs(recipe)} (limiting: ${limiter.quantity}x ${limiter.name}, have ${currentStock}/${limit}, plus ${pendingItems} pending)`);
      // Track the goal by the limiting output item so every produced item
      // (including the secondary ones) is actually requested and counted.
      goalItems.push({ itemId: limiter.item_id, quantity: needed, limit, recipe: isItemGoal ? undefined : recipe });
    }

    // ── Material-triggered crafting ──
    // Auto-craft recipes whose INPUT materials have piled up past their trigger
    // threshold, draining them back down to the stop threshold. This runs every
    // cycle regardless of the goal/limit configuration (and independently of it):
    // triggers are about converting a raw-material surplus, goals are about
    // maintaining a finished-goods stock. Both can coexist.
    const recipeTriggers = (assignedCrafter.recipeTriggers as
      | Record<string, RecipeTriggerConfig>
      | undefined) || {};
    if (Object.keys(recipeTriggers).length > 0) {
      const trigResult = await processRecipeTriggers(
        ctx,
        bot,
        recipes,
        recipeTriggers,
        ownFacilityMap,
        settings,
        countItem,
        tracker!,
        livePendingRuns,
        effectiveQuotas,
      );
      if (trigResult.fired > 0) {
        ctx.log("craft", `Material triggers fired: ${trigResult.fired} recipe(s), ${trigResult.queued} queued this cycle`);
      }
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
        const recipe = recipes.find(r => r.recipe_id === recipeId);
        const completedOutputs = (recipe && recipe.outputs.length > 0)
          ? recipe.outputs.map(o => `${o.quantity * progress.completed}x ${o.name || o.item_id}`).join("+")
          : `${progress.completed * (recipe?.output_quantity || 1)}x ${recipe?.name || recipeId}`;
        const queuedOutputs = (recipe && recipe.outputs.length > 0)
          ? recipe.outputs.map(o => `${o.quantity * progress.queued}x ${o.name || o.item_id}`).join("+")
          : `${progress.queued * (recipe?.output_quantity || 1)}x ${recipe?.name || recipeId}`;
        const name = recipeNames.get(recipeId) || recipeId;
        progressSummaries.push(`${completedOutputs}/${queuedOutputs} ${name} (${progress.remaining} runs remaining)`);
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
