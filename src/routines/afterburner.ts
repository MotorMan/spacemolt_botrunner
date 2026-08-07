/**
 * Afterburner boost support.
 *
 * Ships fitted with an Afterburner utility module (afterburner_i/ii/iii,
 * plasma_afterburner) get a permanent `speed_bonus`. On top of that, the
 * `afterburner_fuel` consumable grants a **+100% speed buff for 3 ticks**
 * (`use_item`). Jump time in SpaceMolt is `7 - speed` ticks (1 tick = 10s), so
 * doubling a Speed 3 hull to Speed 6 collapses a 4-tick jump into a 1-tick jump.
 *
 * Because a mutation is rate limited to 1 per tick, the practical cadence is
 * "burn one afterburner_fuel, then jump" — roughly 20s per jump instead of the
 * unboosted 40-70s. That is the default (`jumpsPerFuel = 1`). Raising
 * `jumpsPerFuel` to 2 rides a single 3-tick buff across two jumps, halving fuel
 * use at the cost of a tighter timing margin.
 *
 * Boosting also burns a LOT more fuel (afterburner_ii is -60% fuel efficiency,
 * and fuel cost scales with speed), so a boosted trip must carry a much bigger
 * fuel-cell reserve than an unboosted one — hence `minMilitaryFuelCells`.
 *
 * This module is routine-agnostic; faction_trader is the first consumer.
 */
import type { Bot, RoutineContext } from "../bot.js";
import { catalogStore } from "../catalogstore.js";
import { extractShipModules, moduleHaystack, moduleTypeId } from "../shipmodules.js";

// ── Constants ────────────────────────────────────────────────

/** The consumable that grants the temporary speed buff. */
export const AFTERBURNER_FUEL_ITEM_ID = "afterburner_fuel";

/** Fuel cell we stock up on for the (much higher) boosted fuel burn. */
export const AFTERBURNER_FUEL_CELL_ITEM_ID = "military_fuel_cell";

/** Known afterburner utility module ids, weakest → strongest. */
export const AFTERBURNER_MODULE_IDS = [
  "afterburner_i",
  "afterburner_ii",
  "afterburner_iii",
  "plasma_afterburner",
] as const;

/** Buff duration of one afterburner_fuel, in engine ticks. */
export const AFTERBURNER_BUFF_TICKS = 3;

/** Maximum ship speed the engine supports (jump time = 7 - speed ticks). */
const MAX_SHIP_SPEED = 6;

/** How long a module-detection result stays cached, in ms. */
const MODULE_CACHE_TTL_MS = 5 * 60_000;

/**
 * Minimum gap between two `use_item` calls for the same logical jump. Guards
 * against burning a unit per retry when `navigateToSystem` re-attempts a jump.
 */
const REUSE_GUARD_MS = 20_000;

// ── Types ────────────────────────────────────────────────────

/** How a routine decides whether to burn afterburner fuel. */
export type AfterburnerMode = "auto" | "always" | "never";

export function parseAfterburnerMode(value: unknown): AfterburnerMode {
  if (value === "always" || value === "never" || value === "auto") return value;
  // Legacy/loose values: a bare boolean toggle maps onto always/never.
  if (value === true) return "always";
  if (value === false) return "never";
  return "auto";
}

export interface AfterburnerModuleInfo {
  /** True when an afterburner utility module is fitted. */
  hasModule: boolean;
  /** Fitted module id (e.g. "afterburner_ii"), or null. */
  moduleId: string | null;
  /** Fitted module display name, or null. */
  moduleName: string | null;
  /** Permanent speed bonus contributed by the module (from the catalog). */
  speedBonus: number;
  /** Current ship speed reported by get_ship (module included, buff excluded). */
  shipSpeed: number;
  /** Speed the ship reaches with a +100% afterburner_fuel buff, capped at 6. */
  boostedSpeed: number;
  /** True when get_ship could not be read (detection is inconclusive). */
  unknown: boolean;
}

export interface AfterburnerTripPlan {
  /** Whether this trip should run boosted. */
  boost: boolean;
  /** Human-readable explanation for the decision (logged once per trip). */
  reason: string;
  /** Round-trip jump count the plan was sized for. */
  roundTripJumps: number;
  /** afterburner_fuel units to have aboard before departing. */
  fuelUnitsNeeded: number;
  /** military_fuel_cell count to have aboard before departing. */
  militaryFuelCellsNeeded: number;
  /** Jumps each afterburner_fuel unit is expected to cover. */
  jumpsPerFuel: number;
  /** Module detection that produced this plan. */
  module: AfterburnerModuleInfo;
}

export interface AfterburnerPlanOptions {
  mode: AfterburnerMode;
  roundTripJumps: number;
  /** Jumps covered per afterburner_fuel unit (1 = burn one per jump). */
  jumpsPerFuel?: number;
  /** Spare units withdrawn on top of the computed need. */
  fuelBuffer?: number;
  /** Floor for military fuel cells carried on a boosted trip. */
  minMilitaryFuelCells?: number;
  /** Skip boosting for very short hops (0 disables the check). */
  minJumpsToBoost?: number;
}

// ── Item helpers ─────────────────────────────────────────────

export function isAfterburnerFuelItem(itemId: string): boolean {
  return (itemId || "").toLowerCase() === AFTERBURNER_FUEL_ITEM_ID;
}

/** True for any afterburner *module* item id (not the consumable). */
export function isAfterburnerModuleItem(itemId: string): boolean {
  const lower = (itemId || "").toLowerCase();
  return (AFTERBURNER_MODULE_IDS as readonly string[]).includes(lower);
}

// ── Module detection ─────────────────────────────────────────

const moduleCache = new Map<string, { at: number; info: AfterburnerModuleInfo }>();

function unknownModuleInfo(shipSpeed: number): AfterburnerModuleInfo {
  return {
    hasModule: false,
    moduleId: null,
    moduleName: null,
    speedBonus: 0,
    shipSpeed,
    boostedSpeed: Math.min(MAX_SHIP_SPEED, shipSpeed * 2),
    unknown: true,
  };
}

/** Catalog `speed_bonus` for a module id (0 when unknown). */
function catalogSpeedBonus(moduleId: string): number {
  const entry = catalogStore.getItem(moduleId) as Record<string, unknown> | undefined;
  const bonus = entry?.speed_bonus;
  return typeof bonus === "number" ? bonus : 0;
}

/**
 * Detect whether the bot's ship has an afterburner utility module fitted.
 *
 * `get_ship` reports the fitted list as instance UUIDs under `ship.modules`
 * and publishes the detail objects separately under the top-level `modules`,
 * so the raw ids must be resolved first (see shipmodules.ts) — matching
 * `ship.modules` directly only ever sees opaque hashes and always answers
 * "no afterburner fitted".
 *
 * Matching is by module `type_id` against the known afterburner ids with a
 * substring fallback so a future "Afterburner IV" is still recognised.
 * Results are cached per bot for `MODULE_CACHE_TTL_MS` because refits are rare
 * and `get_ship` is called on every trade cycle.
 */
export async function detectAfterburnerModule(
  ctx: RoutineContext,
  opts: { force?: boolean } = {},
): Promise<AfterburnerModuleInfo> {
  const { bot } = ctx;

  if (!opts.force) {
    const cached = moduleCache.get(bot.username);
    if (cached && Date.now() - cached.at < MODULE_CACHE_TTL_MS) return cached.info;
  }

  const resp = await bot.exec("get_ship");
  if (resp.error || !resp.result || typeof resp.result !== "object") {
    return unknownModuleInfo(bot.shipSpeed || 1);
  }

  const root = resp.result as Record<string, unknown>;
  const ship = ((root.ship as Record<string, unknown>) || root) as Record<string, unknown>;
  const shipSpeed = (ship.speed as number) || bot.shipSpeed || 1;

  const { modules, unresolvedIds, resolved } = extractShipModules(resp.result);

  let matched = false;
  let moduleId: string | null = null;
  let moduleName: string | null = null;
  let moduleSpeedBonus = 0;
  let bestRank = -2;

  for (const mod of modules) {
    if (!moduleHaystack(mod).includes("afterburner")) continue;

    const normalizedId = moduleTypeId(mod);
    const name = typeof mod.name === "string" ? mod.name : "";
    // Prefer the strongest afterburner if somehow more than one is fitted.
    const rank = (AFTERBURNER_MODULE_IDS as readonly string[]).indexOf(normalizedId);
    if (matched && rank <= bestRank) continue;

    matched = true;
    bestRank = rank;
    moduleId = normalizedId || moduleId;
    moduleName = name || normalizedId || moduleName;
    const bonus = mod.speed_bonus;
    moduleSpeedBonus = typeof bonus === "number" ? bonus : 0;
  }

  // No match AND unreadable entries → inconclusive, not "definitely absent".
  // Don't cache that, so the next cycle re-checks instead of running unboosted
  // for the full TTL on a ship that does have an afterburner.
  if (!matched && !resolved) {
    ctx.log(
      "debug",
      `Afterburner detection inconclusive: ${unresolvedIds.length} unresolved module id(s) in get_ship`,
    );
    return unknownModuleInfo(shipSpeed);
  }

  const info: AfterburnerModuleInfo = {
    hasModule: matched,
    moduleId,
    moduleName,
    speedBonus: moduleSpeedBonus || (moduleId ? catalogSpeedBonus(moduleId) : 0),
    shipSpeed,
    boostedSpeed: Math.min(MAX_SHIP_SPEED, shipSpeed * 2),
    unknown: false,
  };

  moduleCache.set(bot.username, { at: Date.now(), info });
  return info;
}

/** Drop the cached detection for a bot (call after a refit). */
export function clearAfterburnerModuleCache(username?: string): void {
  if (username) moduleCache.delete(username);
  else moduleCache.clear();
}

/** Estimated jump time in seconds at a given speed (7 - speed ticks, 10s/tick). */
export function jumpSecondsAtSpeed(speed: number): number {
  const clamped = Math.max(1, Math.min(MAX_SHIP_SPEED, Math.round(speed)));
  return (7 - clamped) * 10;
}

// ── Trip planning ────────────────────────────────────────────

/**
 * Decide whether a trip should run boosted and how many consumables it needs.
 *
 * `fuelUnitsNeeded` covers the WHOLE round trip (out + back home) so the bot
 * never withdraws more afterburner fuel than the run actually consumes.
 */
export function planAfterburnerTrip(
  module: AfterburnerModuleInfo,
  opts: AfterburnerPlanOptions,
): AfterburnerTripPlan {
  const jumpsPerFuel = Math.max(1, Math.floor(opts.jumpsPerFuel ?? 1));
  const fuelBuffer = Math.max(0, Math.floor(opts.fuelBuffer ?? 2));
  const minMilitaryFuelCells = Math.max(0, Math.floor(opts.minMilitaryFuelCells ?? 10));
  const minJumpsToBoost = Math.max(0, Math.floor(opts.minJumpsToBoost ?? 1));
  const roundTripJumps = Math.max(0, Math.floor(opts.roundTripJumps || 0));

  const off = (reason: string): AfterburnerTripPlan => ({
    boost: false,
    reason,
    roundTripJumps,
    fuelUnitsNeeded: 0,
    militaryFuelCellsNeeded: 0,
    jumpsPerFuel,
    module,
  });

  if (opts.mode === "never") return off("afterburner disabled in settings");
  if (roundTripJumps <= 0) return off("in-station trade — no jumps to boost");
  if (minJumpsToBoost > 0 && roundTripJumps < minJumpsToBoost) {
    return off(`round trip is only ${roundTripJumps} jump(s), below minimum ${minJumpsToBoost}`);
  }

  if (opts.mode === "auto") {
    if (module.unknown) return off("could not read ship modules — skipping boost this trip");
    if (!module.hasModule) return off("no afterburner module fitted");
    if (module.shipSpeed >= MAX_SHIP_SPEED) {
      return off(`ship already at max speed ${module.shipSpeed} — boost would be wasted`);
    }
  }

  const fuelUnitsNeeded = Math.ceil(roundTripJumps / jumpsPerFuel) + fuelBuffer;
  // Boosted jumps burn far more fuel per jump, so size the cell reserve off the
  // round trip and never drop below the configured floor.
  const militaryFuelCellsNeeded = Math.max(minMilitaryFuelCells, roundTripJumps + 2);

  const moduleLabel = module.moduleName || module.moduleId || "afterburner";
  const speedLabel = `speed ${module.shipSpeed} → ${module.boostedSpeed}`;
  const timeLabel = `~${jumpSecondsAtSpeed(module.shipSpeed)}s → ~${jumpSecondsAtSpeed(module.boostedSpeed)}s per jump`;
  const reason = opts.mode === "always" && !module.hasModule
    ? `forced on (no module detected) — ${speedLabel}`
    : `${moduleLabel} detected — ${speedLabel}, ${timeLabel}`;

  return {
    boost: true,
    reason,
    roundTripJumps,
    fuelUnitsNeeded,
    militaryFuelCellsNeeded,
    jumpsPerFuel,
    module,
  };
}

// ── Stocking consumables ─────────────────────────────────────

function cargoQty(bot: Bot, itemId: string): number {
  return bot.inventory.find(i => i.itemId === itemId)?.quantity ?? 0;
}

function storageQty(bot: Bot, itemId: string, personalMode: boolean): number {
  const storage = personalMode ? bot.storage : bot.factionStorage;
  return storage.find(i => i.itemId === itemId)?.quantity ?? 0;
}

/**
 * Withdraw `quantity` of an item from faction (or personal) storage to cargo.
 * Returns the quantity actually added to cargo.
 */
async function withdrawToCargo(
  ctx: RoutineContext,
  itemId: string,
  quantity: number,
  personalMode: boolean,
): Promise<number> {
  const { bot } = ctx;
  if (quantity <= 0) return 0;

  const before = cargoQty(bot, itemId);
  const target = personalMode ? "self" : "faction";
  const resp = await bot.exec("storage", {
    action: "withdraw",
    target,
    item_id: itemId,
    quantity,
  });

  if (resp.error) {
    ctx.log("warn", `Afterburner: could not withdraw ${quantity}x ${itemId} from ${target} storage: ${resp.error.message}`);
    return 0;
  }

  await bot.refreshCargo();
  return Math.max(0, cargoQty(bot, itemId) - before);
}

export interface AfterburnerStockResult {
  afterburnerFuel: number;
  militaryFuelCells: number;
  /** True when both consumables reached their targets. */
  ready: boolean;
}

/**
 * Make sure the ship carries enough afterburner fuel and military fuel cells
 * for the planned round trip. Pulls from faction (or personal) storage first;
 * military fuel cells fall back to a market buy when storage is short.
 *
 * Must be called while docked at the storage station.
 */
export async function stockAfterburnerConsumables(
  ctx: RoutineContext,
  plan: AfterburnerTripPlan,
  opts: { personalMode: boolean },
): Promise<AfterburnerStockResult> {
  const { bot } = ctx;
  const { personalMode } = opts;

  if (!plan.boost) {
    return { afterburnerFuel: 0, militaryFuelCells: 0, ready: false };
  }

  await bot.refreshCargo();

  // ── afterburner_fuel: withdraw only what the round trip needs ──
  let haveFuel = cargoQty(bot, AFTERBURNER_FUEL_ITEM_ID);
  if (haveFuel < plan.fuelUnitsNeeded) {
    const available = storageQty(bot, AFTERBURNER_FUEL_ITEM_ID, personalMode);
    const want = plan.fuelUnitsNeeded - haveFuel;
    const qty = available > 0 ? Math.min(want, available) : want;
    if (qty > 0) {
      const got = await withdrawToCargo(ctx, AFTERBURNER_FUEL_ITEM_ID, qty, personalMode);
      haveFuel += got;
    }
  }

  if (haveFuel <= 0) {
    ctx.log("warn", `Afterburner: no ${AFTERBURNER_FUEL_ITEM_ID} available — running this trip unboosted`);
    return { afterburnerFuel: 0, militaryFuelCells: cargoQty(bot, AFTERBURNER_FUEL_CELL_ITEM_ID), ready: false };
  }

  // ── military_fuel_cell: boosted jumps burn much more fuel ──
  let haveCells = cargoQty(bot, AFTERBURNER_FUEL_CELL_ITEM_ID);
  if (haveCells < plan.militaryFuelCellsNeeded) {
    const want = plan.militaryFuelCellsNeeded - haveCells;
    const available = storageQty(bot, AFTERBURNER_FUEL_CELL_ITEM_ID, personalMode);
    if (available > 0) {
      const got = await withdrawToCargo(ctx, AFTERBURNER_FUEL_CELL_ITEM_ID, Math.min(want, available), personalMode);
      haveCells += got;
    }
    if (haveCells < plan.militaryFuelCellsNeeded) {
      // Last resort: buy the shortfall from the station market.
      const stillNeed = plan.militaryFuelCellsNeeded - haveCells;
      const buyResp = await bot.exec("buy", {
        item_id: AFTERBURNER_FUEL_CELL_ITEM_ID,
        quantity: stillNeed,
      });
      if (!buyResp.error) {
        await bot.refreshCargo();
        haveCells = cargoQty(bot, AFTERBURNER_FUEL_CELL_ITEM_ID);
      }
    }
  }

  const ready = haveFuel >= plan.fuelUnitsNeeded && haveCells >= plan.militaryFuelCellsNeeded;
  ctx.log(
    "trade",
    `Afterburner stocked: ${haveFuel}/${plan.fuelUnitsNeeded}x afterburner fuel, ` +
    `${haveCells}/${plan.militaryFuelCellsNeeded}x military fuel cells ` +
    `(${plan.roundTripJumps} round-trip jumps)`,
  );
  if (!ready) {
    ctx.log("warn", "Afterburner: consumables below target — boost may run out mid-route");
  }

  return { afterburnerFuel: haveFuel, militaryFuelCells: haveCells, ready };
}

// ── Per-jump boosting ────────────────────────────────────────

/**
 * Burns `afterburner_fuel` before jumps to keep the +100% speed buff up.
 *
 * Hook `burnBeforeJump` into `navigateToSystem({ onPreJump })`. The booster
 * dedupes retries of the same jump (navigateToSystem retries a failed jump up
 * to 10 times with the same jump number) so a single unit is not wasted per
 * retry, and it stops cleanly the moment the ship runs out of fuel.
 */
export class AfterburnerBooster {
  private readonly ctx: RoutineContext;
  private enabled: boolean;
  private readonly jumpsPerFuel: number;
  private unitsRemaining: number;
  private jumpsOnCurrentBuff = Number.POSITIVE_INFINITY;
  private lastUseAt = 0;
  private lastJumpKey: string | null = null;
  private exhaustedLogged = false;
  private unitsUsed = 0;
  private jumpsBoosted = 0;

  constructor(
    ctx: RoutineContext,
    opts: { enabled: boolean; jumpsPerFuel?: number; unitsInCargo?: number },
  ) {
    this.ctx = ctx;
    this.enabled = opts.enabled;
    this.jumpsPerFuel = Math.max(1, Math.floor(opts.jumpsPerFuel ?? 1));
    this.unitsRemaining = Math.max(0, Math.floor(opts.unitsInCargo ?? 0));
  }

  /** True when the booster will still attempt to burn fuel. */
  get active(): boolean {
    return this.enabled && this.unitsRemaining > 0;
  }

  get remainingUnits(): number {
    return this.unitsRemaining;
  }

  get usedUnits(): number {
    return this.unitsUsed;
  }

  /** Overwrite the believed unit count (e.g. right after a withdrawal). */
  setUnitsInCargo(units: number): void {
    this.unitsRemaining = Math.max(0, Math.floor(units));
    if (this.unitsRemaining > 0) this.exhaustedLogged = false;
  }

  disable(reason?: string): void {
    if (!this.enabled) return;
    this.enabled = false;
    if (reason) this.ctx.log("travel", `Afterburner boost off: ${reason}`);
  }

  /**
   * Burn one afterburner fuel immediately before a jump so the +100% speed buff
   * is active when the jump command executes. Hook this into `navigateToSystem`
   * via `onPreJump`, which fires right before `exec("jump")` — NOT `onBeforeJump`,
   * which runs at the top of the loop and lets the ~3-tick buff expire during
   * the pre-jump fueling / route / dock work (the jump would then land
   * unboosted).
   *
   * Safe to call unconditionally — it no-ops when the booster is disabled or
   * out of fuel.
   */
  burnBeforeJump = async (nextSystem: string, jumpNumber: number): Promise<void> => {
    if (!this.enabled) return;

    const key = `${jumpNumber}:${nextSystem}`;
    const isRetry = key === this.lastJumpKey;
    const sinceLastUse = Date.now() - this.lastUseAt;

    // A retry of the same jump only re-burns fuel once the previous buff has
    // realistically lapsed; otherwise we'd waste a unit per retry.
    if (isRetry && sinceLastUse < REUSE_GUARD_MS) return;

    // Ride the existing buff when jumpsPerFuel > 1.
    if (!isRetry && this.jumpsOnCurrentBuff < this.jumpsPerFuel) {
      this.jumpsOnCurrentBuff++;
      this.jumpsBoosted++;
      return;
    }

    if (this.unitsRemaining <= 0) {
      if (!this.exhaustedLogged) {
        this.exhaustedLogged = true;
        this.ctx.log("warn", "Afterburner fuel exhausted — remaining jumps run at normal speed");
      }
      return;
    }

    const resp = await this.ctx.bot.exec("use_item", {
      id: AFTERBURNER_FUEL_ITEM_ID,
      quantity: 1,
    });

    if (resp.error) {
      const msg = (resp.error.message || "").toLowerCase();
      if (msg.includes("not_found") || msg.includes("not found") ||
          msg.includes("insufficient") || msg.includes("do not have") ||
          msg.includes("don't have") || msg.includes("no such item")) {
        this.unitsRemaining = 0;
        this.disable("no afterburner fuel left in cargo");
      } else {
        this.ctx.log("warn", `Afterburner use_item failed: ${resp.error.message}`);
      }
      return;
    }

    const result = (resp.result || {}) as Record<string, unknown>;
    const remaining = result.quantity_remaining;
    this.unitsRemaining = typeof remaining === "number"
      ? Math.max(0, remaining)
      : Math.max(0, this.unitsRemaining - 1);

    this.unitsUsed++;
    this.jumpsBoosted++;
    this.jumpsOnCurrentBuff = 1;
    this.lastUseAt = Date.now();
    this.lastJumpKey = key;

    const buffs = Array.isArray(result.active_buffs)
      ? result.active_buffs as Array<Record<string, unknown>>
      : [];
    const speedBuff = buffs.find(b => (b.stat as string) === "speed");
    const ticksLeft = typeof speedBuff?.ticks_left === "number"
      ? speedBuff.ticks_left as number
      : AFTERBURNER_BUFF_TICKS;

    this.ctx.log(
      "travel",
      `Afterburner engaged for jump to ${nextSystem} ` +
      `(+${(speedBuff?.amount as number) ?? 100}% speed, ${ticksLeft} tick(s) left, ${this.unitsRemaining} fuel remaining)`,
    );

    if (this.unitsRemaining <= 0 && !this.exhaustedLogged) {
      this.exhaustedLogged = true;
      this.ctx.log("warn", "Afterburner fuel exhausted — remaining jumps run at normal speed");
    }
  };

  /** One-line summary for end-of-trip logging. */
  summary(): string {
    return `${this.unitsUsed} afterburner fuel burned across ${this.jumpsBoosted} jump(s), ${this.unitsRemaining} left in cargo`;
  }
}
