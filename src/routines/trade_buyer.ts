import type { Bot, Routine, RoutineContext } from "../bot.js";
import { mapStore } from "../mapstore.js";
import { catalogStore } from "../catalogstore.js";
import { getSystemBlacklist } from "../web/server.js";
import {
  ensureDocked,
  ensureUndocked,
  tryRefuel,
  repairShip,
  ensureFueled,
  navigateToSystem,
  recordMarketData,
  getSystemInfo,
  findStation,
  factionDonateProfit,
  ensureInsured,
  detectAndRecoverFromDeath,
  getModProfile,
  ensureModsFitted,
  maxItemsForCargo,
  getItemSize,
  readSettings,
  logFactionActivity,
  isPirateSystem,
  type BaseServices,
  checkAndFleeFromBattle,
  checkBattleAfterCommand,
  getBattleStatus,
  type BattleState,
  handleBattleNotifications,
  fleeFromBattle,
} from "./common.js";
import {
  getActiveSession,
  startTradeSession,
  updateTradeSession,
  completeTradeSession,
  failTradeSession,
  createTradeSession,
  type TradeSession,
} from "./traderActivity.js";

/** Free cargo weight (not item count — callers must divide by item size). */
function getFreeSpace(bot: Bot): number {
  if (bot.cargoMax <= 0) return 999;
  return Math.max(0, bot.cargoMax - bot.cargo);
}

// ── Settings ─────────────────────────────────────────────────

function getTradeBuyerSettings(username?: string): {
  maxSpendPerItem: number;
  maxTotalSpend: number;
  fuelCostPerJump: number;
  refuelThreshold: number;
  repairThreshold: number;
  homeSystem: string;
  buyItems: string[];
  autoInsure: boolean;
  autoCloak: boolean;
  minQuantityToBuy: number;
  maxPrices: Record<string, number>;
} {
  const all = readSettings();
  // Read from trade_buyer settings (not trader)
  const t = all.trade_buyer || {};
  const botOverrides = username ? (all[username] || {}) : {};
  return {
    maxSpendPerItem: (t.maxSpendPerItem as number) || 5000,
    maxTotalSpend: (t.maxTotalSpend as number) || 0,
    fuelCostPerJump: (t.fuelCostPerJump as number) || 50,
    refuelThreshold: (t.refuelThreshold as number) || 50,
    repairThreshold: (t.repairThreshold as number) || 40,
    homeSystem: (botOverrides.homeSystem as string) || (t.homeSystem as string) || "",
    buyItems: Array.isArray(t.buyItems) ? (t.buyItems as string[]) : [],
    autoInsure: (t.autoInsure as boolean) !== false,
    autoCloak: (t.autoCloak as boolean) ?? false,
    minQuantityToBuy: (t.minQuantityToBuy as number) || 10,
    maxPrices: (t.maxPrices as Record<string, number>) || {},
  };
}

// ── Trade Session Recovery ──────────────────────────────────

/**
 * Check for and recover an incomplete buy session.
 * Validates cargo, destination, and market conditions.
 * Returns the recovered session if valid, or null if recovery is not possible.
 */
async function recoverBuySession(
  ctx: RoutineContext,
  session: TradeSession,
  settings: ReturnType<typeof getTradeBuyerSettings>,
): Promise<TradeSession | null> {
  const { bot } = ctx;

  ctx.log("trade", `Found incomplete buy session: ${session.itemName} (${session.state})`);

  // Verify items are in cargo (for non-cargo routes)
  if (!session.isCargoRoute) {
    await bot.refreshCargo();
    const cargoItem = bot.inventory.find(i => i.itemId === session.itemId);
    const cargoQty = cargoItem?.quantity ?? 0;

    if (session.state === "buying" || session.state === "in_transit") {
      // Should have items after buying
      if (cargoQty <= 0) {
        ctx.log("error", `Recovery failed: ${session.itemName} not in cargo after buy`);
        await failTradeSession(session.botUsername, "Items not in cargo");
        return null;
      }

      if (cargoQty < session.quantityBought) {
        ctx.log("trade", `Recovered with partial cargo: ${cargoQty}/${session.quantityBought}x ${session.itemName}`);
        const updated = await updateTradeSession(session.botUsername, {
          quantityBought: cargoQty,
          sellQuantity: cargoQty,
          notes: (session.notes || "") + ` | Partial recovery: ${cargoQty}/${session.quantityBought}x remaining`,
        });
        if (updated) session = updated;
      }
    }
  }

  // Check if we're at the destination (home station)
  if (session.state === "in_transit" || session.state === "at_destination" || session.state === "selling") {
    // Verify we're heading to a valid home station
    const homeSystem = settings.homeSystem;
    if (!homeSystem) {
      ctx.log("error", "No home system configured — cannot recover session");
      await failTradeSession(session.botUsername, "No home system configured");
      return null;
    }

    if (session.destSystem !== homeSystem) {
      ctx.log("trade", `Correcting destination to home system ${homeSystem}`);
      const updated = await updateTradeSession(session.botUsername, {
        destSystem: homeSystem,
        notes: (session.notes || "") + ` | Destination corrected to home system ${homeSystem}`,
      });
      if (updated) session = updated;
    }
  }

  ctx.log("trade", `Session recovered: ${session.quantityBought}x ${session.itemName} → ${session.destPoiName}`);
  return session;
}

// ── Types ────────────────────────────────────────────────────

interface BuyRoute {
  itemId: string;
  itemName: string;
  sourceSystem: string;
  sourcePoi: string;
  sourcePoiName: string;
  buyPrice: number;
  buyQty: number;
  destSystem: string;
  destPoi: string;
  destPoiName: string;
  jumps: number;
  totalCost: number;
}

// ── Buy route discovery ────────────────────────────────────

/** Estimate fuel cost between two systems using mapStore route data. */
function estimateFuelCost(fromSystem: string, toSystem: string, costPerJump: number): { jumps: number; cost: number } {
  const blacklist = getSystemBlacklist();
  if (fromSystem === toSystem) return { jumps: 0, cost: 0 };
  const route = mapStore.findRoute(fromSystem, toSystem, blacklist);
  if (!route) return { jumps: 999, cost: 999 * costPerJump };
  const jumps = route.length - 1;
  return { jumps, cost: jumps * costPerJump };
}

/** Find the cheapest known market sell prices for items. */
function findCheapestSellers(
  ctx: RoutineContext,
  settings: ReturnType<typeof getTradeBuyerSettings>,
  currentSystem: string,
  cargoCapacity: number = 999,
): BuyRoute[] {
  const routes: BuyRoute[] = [];

  // Collect all sell listings from mapStore (where we can buy from NPC market)
  const sellListings: Array<{ itemId: string; itemName: string; systemId: string; poiId: string; poiName: string; price: number; quantity: number }> = [];

  for (const [sysId, sys] of Object.entries(mapStore.getAllSystems())) {
    // Skip pirate systems
    if (isPirateSystem(sysId)) continue;
    for (const poi of sys.pois) {
      for (const m of poi.market) {
        if (m.best_sell !== null && m.best_sell > 0 && m.sell_quantity > 0) {
          sellListings.push({
            itemId: m.item_id,
            itemName: m.item_name,
            systemId: sysId,
            poiId: poi.id,
            poiName: poi.name,
            price: m.best_sell,
            quantity: m.sell_quantity,
          });
        }
      }
    }
  }

  ctx.log("trade", `Scanning ${sellListings.length} sell listings for items: ${settings.buyItems.join(", ") || "(none)"}`);
  ctx.log("trade", `Max prices config: ${JSON.stringify(settings.maxPrices || {})}`);

  // Group by item to find cheapest sources
  const itemSellers = new Map<string, typeof sellListings>();
  for (const seller of sellListings) {
    const existing = itemSellers.get(seller.itemId) || [];
    existing.push(seller);
    itemSellers.set(seller.itemId, existing);
  }

  ctx.log("trade", `Found ${itemSellers.size} unique items for sale in cache`);

  // For each item, find the cheapest seller
  for (const [itemId, sellers] of itemSellers.entries()) {
    // Filter by allowed items - MUST be explicitly selected in buyItems list
    if (settings.buyItems.length === 0) {
      // No items selected - skip this item (don't buy anything if nothing is configured)
      continue;
    }
    
    // Check if this item is in the buy list (exact match)
    const match = settings.buyItems.some(t =>
      t.toLowerCase() === itemId.toLowerCase()
    );
    if (!match) continue;

    ctx.log("trade", `>>> Found matching item: ${itemId} (${sellers.length} sellers)`);

    // Check max price for this item
    const maxPrice = settings.maxPrices?.[itemId];
    if (maxPrice !== undefined && maxPrice > 0) {
      // Filter out sellers that are above the max price
      const filteredSellers = sellers.filter(s => s.price <= maxPrice);
      if (filteredSellers.length === 0) {
        const cheapest = Math.min(...sellers.map(s => s.price));
        ctx.log("trade", `>>> ${itemId}: No sellers at or below max price ${maxPrice}cr (cheapest available: ${cheapest}cr)`);
        continue;
      } // No sellers at acceptable price
      sellers.length = 0;
      sellers.push(...filteredSellers);
      ctx.log("trade", `>>> ${itemId}: Filtered to ${sellers.length} sellers at or below ${maxPrice}cr`);
    }

    // Sort by price ascending (cheapest first)
    sellers.sort((a, b) => a.price - b.price);

    for (const seller of sellers.slice(0, 3)) { // Top 3 cheapest per item
      const { jumps, cost: fuelCost } = estimateFuelCost(currentSystem, seller.systemId, settings.fuelCostPerJump);
      if (jumps >= 999) continue;

      const buyQty = Math.min(seller.quantity, maxItemsForCargo(cargoCapacity, itemId));
      if (buyQty < settings.minQuantityToBuy) continue;

      // Calculate total cost including fuel
      const itemCost = seller.price * buyQty;
      if (settings.maxSpendPerItem > 0 && itemCost > settings.maxSpendPerItem) continue;

      const totalCost = itemCost + fuelCost;

      routes.push({
        itemId: seller.itemId,
        itemName: seller.itemName,
        sourceSystem: seller.systemId,
        sourcePoi: seller.poiId,
        sourcePoiName: seller.poiName,
        buyPrice: seller.price,
        buyQty: buyQty,
        destSystem: settings.homeSystem || currentSystem,
        destPoi: "", // Will be filled in later
        destPoiName: "Home Station",
        jumps,
        totalCost,
      });
    }
  }

  // Sort by total cost ascending (cheapest to acquire first)
  routes.sort((a, b) => a.totalCost - b.totalCost);
  return routes;
}

/** Get the home station POI for a given home system. */
function getHomeStation(homeSystem: string): { id: string; name: string } | null {
  const system = mapStore.getSystem(homeSystem);
  if (!system) return null;

  // Prefer stations with faction storage or market
  // Cast pois to SystemPOI-compatible type for findStation
  const compatiblePois = system.pois.map(p => ({
    id: p.id,
    name: p.name,
    type: p.type,
    has_base: p.has_base,
    base_id: p.base_id,
    services: p.services.reduce((acc, s) => { acc[s as keyof BaseServices] = true; return acc; }, {} as BaseServices),
  }));

  const station = findStation(compatiblePois, "market", false);
  if (station) {
    return { id: station.id, name: station.name };
  }

  // Fallback to any station
  const anyStation = system.pois.find(p => p.type === "station" || p.has_base);
  if (anyStation) {
    return { id: anyStation.id, name: anyStation.name };
  }

  return null;
}

// ── Missions ─────────────────────────────────────────────────

/**
 * Complete any active missions that are ready, then accept new market/trade
 * missions at the current station (up to 2 per visit, respecting the 5-mission cap).
 * Must be docked.
 */
async function tryMissions(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;
  if (!bot.docked) return;

  // Try to complete active missions
  const activeResp = await bot.exec("get_active_missions");
  let activeMissionCount = 0;
  if (!activeResp.error && activeResp.result) {
    const ar = activeResp.result as Record<string, unknown>;
    const active = (
      Array.isArray(ar.missions) ? ar.missions :
      Array.isArray(ar) ? ar :
      []
    ) as Array<Record<string, unknown>>;
    activeMissionCount = active.length;

    for (const mission of active) {
      const missionId = (mission.mission_id as string) || (mission.id as string) || "";
      if (!missionId) continue;
      const status = ((mission.status as string) || "").toLowerCase();
      if (status === "incomplete" || status === "in_progress") continue;
      const completeResp = await bot.exec("complete_mission", { mission_id: missionId });
      if (completeResp.error) {
        if (completeResp.error.code === "mission_incomplete") continue;
      }
      if (!completeResp.error && completeResp.result) {
        const cr = completeResp.result as Record<string, unknown>;
        const earned = (cr.credits_earned as number) ?? 0;
        ctx.log("trade", `Mission complete! +${earned}cr`);
        activeMissionCount--;
        await bot.refreshStatus();
      }
    }
  }

  // Accept new market/trade missions (cap at 5 total active)
  if (activeMissionCount >= 5) return;

  const availResp = await bot.exec("get_missions");
  if (availResp.error || !availResp.result) return;

  const vr = availResp.result as Record<string, unknown>;
  const available = (
    Array.isArray(vr.missions) ? vr.missions :
    Array.isArray(vr) ? vr :
    []
  ) as Array<Record<string, unknown>>;

  let accepted = 0;
  for (const mission of available) {
    if (activeMissionCount + accepted >= 5 || accepted >= 2) break;

    const missionId = (mission.mission_id as string) || (mission.id as string) || "";
    const type = ((mission.type as string) || "").toLowerCase();
    const title = ((mission.title as string) || "").toLowerCase();

    const isTradeRelated =
      type === "market_participation" || type === "trade" || type === "delivery" ||
      type === "procurement" ||
      title.includes("market") || title.includes("trade") ||
      title.includes("buy") || title.includes("purchase") || title.includes("deliver");

    if (!isTradeRelated || !missionId) continue;

    const acceptResp = await bot.exec("accept_mission", { mission_id: missionId });
    if (!acceptResp.error) {
      ctx.log("trade", `Accepted mission: ${(mission.title as string) || missionId}`);
      accepted++;
    }
  }
}

// ── Trade Buyer routine ─────────────────────────────────────

/**
 * Trade Buyer routine — travels between stations, buys items cheaply,
 * and deposits them at home station faction storage:
 *
 * 1. Dock at current station, refresh market data
 * 2. Scan mapStore for cheapest sellers of desired items
 * 3. Pick best buy opportunity (lowest total cost including fuel)
 * 4. Travel to source station, buy items
 * 5. Travel to home station, deposit items to faction storage
 * 6. Refuel, repair, repeat
 */
export const tradeBuyerRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  // Persistent battle state across cycles
  const battleRef = { state: null as BattleState | null };
  battleRef.state = {
    inBattle: false,
    battleId: null,
    battleStartTick: null,
    lastHitTick: null,
    isFleeing: false,
    lastFleeTime: undefined,
  };

  await bot.refreshStatus();
  const startSystem = bot.system;

  // Load settings
  let settings = getTradeBuyerSettings(bot.username);

  // Validate home system is configured
  if (!settings.homeSystem) {
    ctx.log("error", "No home system configured for trade buyer — please set homeSystem in settings");
    await ctx.sleep(60000);
    return;
  }

  // Get home station info
  const homeStation = getHomeStation(settings.homeSystem);
  if (!homeStation) {
    ctx.log("error", `Cannot find station in home system ${settings.homeSystem}`);
    await ctx.sleep(60000);
    return;
  }

  while (bot.state === "running") {
    // Refresh settings each cycle
    settings = getTradeBuyerSettings(bot.username);

    ctx.log("trade", `Settings loaded: homeSystem=${settings.homeSystem || "(not set)"}, buyItems=[${settings.buyItems.join(", ") || "(none)"}], maxPrices=${JSON.stringify(settings.maxPrices || {})}`);

    // ── Death recovery ──
    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) { await ctx.sleep(30000); continue; }

    // ── Battle check ──
    if (await checkAndFleeFromBattle(ctx, "trade_buyer")) {
      await ctx.sleep(5000);
      continue;
    }

    // Periodic battle status check (backup detection in case notifications fail)
    // Check every cycle for fast detection
    if (bot.isInBattle()) {
      const now = Date.now();
      if (!battleRef.state!.lastFleeTime || now - battleRef.state!.lastFleeTime > 10000) { // Only issue if more than 10 seconds since last flee
        ctx.log("combat", `PERIODIC CHECK: IN BATTLE! - initiating IMMEDIATE flee!`);
        battleRef.state!.inBattle = true;
        battleRef.state!.isFleeing = false;

        await bot.exec("battle", { action: "stance", stance: "flee" });
        battleRef.state!.lastFleeTime = now;
        ctx.log("combat", "Flee stance issued - will re-issue every cycle until disengaged!");
      }
    }

    // If we're in battle, re-issue flee command to ensure we stay in flee stance
    if (battleRef.state!.inBattle) {
      const now = Date.now();
      if (!battleRef.state!.lastFleeTime || now - battleRef.state!.lastFleeTime > 10000) { // Only issue if more than 10 seconds since last flee
        ctx.log("combat", "Re-issuing flee stance (ensuring we stay in flee mode)...");
        const fleeResp = await bot.exec("battle", { action: "stance", stance: "flee" });
        if (fleeResp.error) {
          ctx.log("error", `Flee re-issue failed: ${fleeResp.error.message}`);
        } else {
          battleRef.state!.lastFleeTime = now;
        }
      }
      // Check if we've successfully disengaged
      const currentBattleStatus = await getBattleStatus(ctx);
      if (!currentBattleStatus || !currentBattleStatus.is_participant) {
        ctx.log("combat", "Battle cleared - no longer in combat!");
        battleRef.state!.inBattle = false;
        battleRef.state!.battleId = null;
        battleRef.state!.isFleeing = false;
        battleRef.state!.lastFleeTime = undefined;
        await ctx.sleep(2000); // Brief pause before next check
        continue;
      }
      // Still in battle - continue to next cycle
      await ctx.sleep(2000); // Brief pause before next check
      continue;
    }

    // ── Trade session recovery ──
    const activeSession = getActiveSession(bot.username);
    let recoveredSession: TradeSession | null = null;
    if (activeSession) {
      recoveredSession = await recoverBuySession(ctx, activeSession, settings);
      if (recoveredSession) {
        ctx.log("trade", `Resuming buy session: ${recoveredSession.itemName} (${recoveredSession.state})`);
      }
    }

    const safetyOpts = {
      fuelThresholdPct: settings.refuelThreshold,
      hullThresholdPct: settings.repairThreshold,
      autoCloak: settings.autoCloak,
    };
    let extraSpent = 0;
    let route: BuyRoute | null = null;
    let buyQty = 0;
    let totalSpent = 0;

    // ── Handle recovered session ──
    if (recoveredSession && (recoveredSession.state === "in_transit" || recoveredSession.state === "at_destination")) {
      ctx.log("trade", `Recovered session is ${recoveredSession.state} — proceeding directly to home`);

      if (bot.docked) {
        await tryRefuel(ctx);
      }

      // Set up route for immediate execution
      route = {
        itemId: recoveredSession.itemId,
        itemName: recoveredSession.itemName,
        sourceSystem: recoveredSession.sourceSystem,
        sourcePoi: recoveredSession.sourcePoi,
        sourcePoiName: recoveredSession.sourcePoiName,
        buyPrice: recoveredSession.buyPricePerUnit,
        buyQty: recoveredSession.quantityBought,
        destSystem: settings.homeSystem,
        destPoi: homeStation.id,
        destPoiName: homeStation.name,
        jumps: recoveredSession.totalJumps - recoveredSession.jumpsCompleted,
        totalCost: recoveredSession.investedCredits,
      };
      buyQty = recoveredSession.quantityBought;
      totalSpent = recoveredSession.investedCredits;

      await ensureUndocked(ctx);
      const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
      if (!fueled) {
        ctx.log("error", "Cannot refuel for recovered session — will retry next cycle");
        await ctx.sleep(30000);
        continue;
      }

      ctx.log("travel", `Resuming route to home...`);
      const arrived = await navigateToSystem(ctx, settings.homeSystem, {
        ...safetyOpts,
        noJettison: true,
        onJump: async (jumpNum) => {
          const session = getActiveSession(bot.username);
          if (session) {
            await updateTradeSession(bot.username, { jumpsCompleted: jumpNum });
          }
          return true;
        },
      });

      if (!arrived) {
        ctx.log("error", "Failed to reach home system — will retry");
        await ensureDocked(ctx);
        await ctx.sleep(60000);
        continue;
      }

      await updateTradeSession(bot.username, { state: "at_destination" });
      bot.system = settings.homeSystem;

      if (bot.poi !== homeStation.id) {
        ctx.log("travel", `Traveling to ${homeStation.name}...`);
        await bot.exec("travel", { target_poi: homeStation.id });
        bot.poi = homeStation.id;
      }

      await ensureDocked(ctx);
      ctx.log("trade", "Arrived at home — proceeding to deposit items");
    }

    // ── Ensure docked (also records market data) ──
    yield "dock";
    await ensureDocked(ctx);
    if (bot.docked) {
      await tryMissions(ctx);
    }

    // ── Fuel + hull check + mods ──
    yield "maintenance";
    await tryRefuel(ctx);
    await repairShip(ctx);
    const modProfile = getModProfile("trader");
    if (modProfile.length > 0) await ensureModsFitted(ctx, modProfile);

    // ── Handle leftover cargo items ──
    yield "handle_cargo";
    await bot.refreshStatus();
    await bot.refreshCargo();

    const protectedItemId = activeSession?.itemId || recoveredSession?.itemId;
    if (protectedItemId) {
      ctx.log("trade", `Protecting buy session item: ${protectedItemId} (not depositing yet)`);
    }

    const cargoItems = bot.inventory.filter(i => {
      if (i.quantity <= 0) return false;
      const lower = i.itemId.toLowerCase();
      if (lower.includes("fuel") || lower.includes("energy_cell")) return false;
      if (protectedItemId && i.itemId === protectedItemId) {
        ctx.log("trade", `Skipping ${i.quantity}x ${i.name} - part of active buy session`);
        return false;
      }
      return true;
    });

    if (cargoItems.length > 0 && bot.docked) {
      // Deposit all non-trade items to faction storage at current location
      const deposited: string[] = [];
      for (const item of cargoItems) {
        const dResp = await bot.exec("faction_deposit_items", { item_id: item.itemId, quantity: item.quantity });
        if (!dResp.error) {
          deposited.push(`${item.quantity}x ${item.name}`);
          logFactionActivity(ctx, "deposit", `Deposited ${item.quantity}x ${item.name} from cargo`);
        }
      }
      if (deposited.length > 0) {
        ctx.log("trade", `Deposited to faction storage: ${deposited.join(", ")}`);
      }
    }

    await bot.refreshStatus();

    // ── Find new buy opportunities ──
    yield "find_buys";
    let routes: BuyRoute[] = [];

    await bot.refreshStatus();
    await bot.refreshCargo();

    // Subtract fuel cell weight from cargo capacity
    let fuelCellWeight = 0;
    for (const item of bot.inventory) {
      const lower = item.itemId.toLowerCase();
      if (lower.includes("fuel") || lower.includes("energy_cell")) {
        fuelCellWeight += item.quantity * getItemSize(item.itemId);
      }
    }
    const cargoCapacity = Math.max(0, (bot.cargoMax > 0 ? bot.cargoMax : 50) - fuelCellWeight);

    routes = findCheapestSellers(ctx, settings, bot.system, cargoCapacity);

    // Update routes with home station info
    routes = routes.map(r => ({
      ...r,
      destPoi: homeStation.id,
      destPoiName: homeStation.name,
    }));

    ctx.log("trade", `DEBUG: routes found = ${routes.length}`);
    if (routes.length > 0) {
      ctx.log("trade", `Found ${routes.length} buy opportunities`);
      for (const r of routes.slice(0, 5)) {
        ctx.log("trade", `  - ${r.itemName}: ${r.buyQty}x @ ${r.buyPrice}cr in ${r.sourceSystem}`);
      }
    }

    if (routes.length === 0 && !recoveredSession) {
      ctx.log("trade", "No profitable buy opportunities found — waiting 60s before re-scanning");
      await ctx.sleep(60000);
      continue;
    }

    const failedSources = new Set<string>();
    let attempts = 0;

    // Battle state tracking for buy route loop
    const battleState: BattleState = {
      inBattle: false,
      battleId: null,
      battleStartTick: null,
      lastHitTick: null,
      isFleeing: false,
    };

    // If we have a recovered session, execute it
    if (recoveredSession) {
      ctx.log("trade", `Executing recovered buy session: ${recoveredSession.itemName} (${recoveredSession.quantityBought}x @ ${recoveredSession.buyPricePerUnit}cr)`);

      route = {
        itemId: recoveredSession.itemId,
        itemName: recoveredSession.itemName,
        sourceSystem: recoveredSession.sourceSystem,
        sourcePoi: recoveredSession.sourcePoi,
        sourcePoiName: recoveredSession.sourcePoiName,
        buyPrice: recoveredSession.buyPricePerUnit,
        buyQty: recoveredSession.quantityBought,
        destSystem: settings.homeSystem,
        destPoi: homeStation.id,
        destPoiName: homeStation.name,
        jumps: recoveredSession.totalJumps - recoveredSession.jumpsCompleted,
        totalCost: recoveredSession.investedCredits,
      };

      buyQty = recoveredSession.quantityBought;
      totalSpent = recoveredSession.investedCredits;

      if (bot.system === settings.homeSystem) {
        await updateTradeSession(bot.username, { state: "at_destination" });
      } else if (recoveredSession.jumpsCompleted > 0) {
        await updateTradeSession(bot.username, { state: "in_transit" });
      }
    }

    // Try up to 3 routes
    if (!recoveredSession) {
      for (let ri = 0; ri < routes.length && attempts < 3; ri++) {
        if (bot.state !== "running") break;
        const candidate = routes[ri];

        // If we're in battle, re-issue flee command every cycle
        if (battleState.inBattle) {
          ctx.log("combat", "Re-issuing flee stance during trade operations (ensuring we stay in flee mode)...");
          const fleeResp = await bot.exec("battle", { action: "stance", stance: "flee" });
          if (fleeResp.error) {
            ctx.log("error", `Flee re-issue failed: ${fleeResp.error.message}`);
          }
          // Check if we've successfully disengaged
          const currentBattleStatus = await getBattleStatus(ctx);
          if (!currentBattleStatus || !currentBattleStatus.is_participant) {
            ctx.log("combat", "Battle cleared - no longer in combat! Resuming trade operations...");
            battleState.inBattle = false;
            battleState.battleId = null;
            battleState.isFleeing = false;
          } else {
            // Still in battle - wait briefly and continue to next cycle to re-flee
            await ctx.sleep(2000);
            continue;
          }
        }

        const sourceKey = `${candidate.sourceSystem}:${candidate.sourcePoi}:${candidate.itemId}`;
        if (failedSources.has(sourceKey)) continue;
        attempts++;

        ctx.log("trade", `Route #${ri + 1}: ${candidate.itemName} — buy ${candidate.buyQty}x at ${candidate.sourcePoiName} (${candidate.buyPrice}cr) — total cost ${Math.round(candidate.totalCost)}cr (${candidate.jumps} jumps)`);

        // Travel to source and buy
        yield "travel_to_source";

        if (bot.system !== candidate.sourceSystem) {
          await ensureUndocked(ctx);
          
          // Pre-travel battle check - prevents travel from being interrupted
          const preTravelBattleCheck = await getBattleStatus(ctx);
          if (preTravelBattleCheck && preTravelBattleCheck.is_participant) {
            ctx.log("combat", `PRE-TRAVEL CHECK: IN BATTLE! Battle ID: ${preTravelBattleCheck.battle_id} - initiating flee!`);
            battleState.inBattle = true;
            battleState.battleId = preTravelBattleCheck.battle_id;
            battleState.isFleeing = false;
            await fleeFromBattle(ctx, false, 5000);
            continue;
          }
          
          const fueled = await ensureFueled(ctx, safetyOpts.fuelThresholdPct);
          if (!fueled) {
            ctx.log("error", "Cannot refuel for buy run — waiting 30s");
            await ctx.sleep(30000);
            break;
          }

          ctx.log("travel", `Heading to ${candidate.sourcePoiName} in ${candidate.sourceSystem}...`);
          const arrived = await navigateToSystem(ctx, candidate.sourceSystem, safetyOpts);
          if (!arrived) {
            ctx.log("error", "Failed to reach source system — trying next route");
            continue;
          }
        }

        if (bot.poi !== candidate.sourcePoi) {
          await ensureUndocked(ctx);
          
          // Check battle after undock
          const undockBattleCheck = await getBattleStatus(ctx);
          if (undockBattleCheck && undockBattleCheck.is_participant) {
            ctx.log("combat", `POST-UNDOCK CHECK: IN BATTLE! Battle ID: ${undockBattleCheck.battle_id} - initiating flee!`);
            battleState.inBattle = true;
            battleState.battleId = undockBattleCheck.battle_id;
            battleState.isFleeing = false;
            await fleeFromBattle(ctx, false, 5000);
            continue;
          }
          
          ctx.log("travel", `Traveling to ${candidate.sourcePoiName}...`);
          const tResp = await bot.exec("travel", { target_poi: candidate.sourcePoi });
          // Check for battle notifications after travel
          if (tResp.notifications && Array.isArray(tResp.notifications)) {
            const battleDetected = await handleBattleNotifications(ctx, tResp.notifications, battleState);
            if (battleDetected) {
              ctx.log("combat", "Battle detected during travel - initiating flee!");
              battleState.isFleeing = false;
            }
          }
          // Also check battle status directly (in case we missed notifications)
          const directBattleCheck = await getBattleStatus(ctx);
          if (directBattleCheck && directBattleCheck.is_participant) {
            ctx.log("combat", `DIRECT CHECK: IN BATTLE after travel! Battle ID: ${directBattleCheck.battle_id} - fleeing!`);
            battleState.inBattle = true;
            battleState.battleId = directBattleCheck.battle_id;
            await fleeFromBattle(ctx, true, 35000);
            ctx.log("error", "Battle detected - fled, will retry route");
            continue;
          }
          if (tResp.error && !tResp.error.message.includes("already")) {
            ctx.log("error", `Travel to source failed: ${tResp.error.message}`);
            continue;
          }
          bot.poi = candidate.sourcePoi;

          // Check for pirates at source location
          const nearbyResp = await bot.exec("get_nearby");
          if (nearbyResp.result && typeof nearbyResp.result === "object") {
            const { checkAndFleeFromPirates } = await import("./common.js");
            const fled = await checkAndFleeFromPirates(ctx, nearbyResp.result);
            if (fled) {
              ctx.log("error", "Pirates detected at source - fled, will retry");
              await ctx.sleep(30000);
              continue;
            }
          }
        }

        yield "dock_source";
        await ensureDocked(ctx);
        bot.docked = true;

        // Withdraw credits from storage
        await bot.refreshStorage();
        const storageResp = await bot.exec("view_storage");
        if (storageResp.result && typeof storageResp.result === "object") {
          const sr = storageResp.result as Record<string, unknown>;
          const storedCredits = (sr.credits as number) || (sr.stored_credits as number) || 0;
          if (storedCredits > 0) {
            await bot.exec("withdraw_credits", { amount: storedCredits });
            ctx.log("trade", `Withdrew ${storedCredits} credits from storage`);
          }
        }

        await recordMarketData(ctx);
        await tryMissions(ctx);

        // Verify item is actually available
        yield "verify_availability";
        const estResp = await bot.exec("estimate_purchase", { item_id: candidate.itemId, quantity: 1 });
        if (estResp.error) {
          failedSources.add(sourceKey);
          mapStore.removeMarketItem(candidate.sourceSystem, candidate.sourcePoi, candidate.itemId);
          ctx.log("trade", `${candidate.itemName} not available at ${candidate.sourcePoiName} (stale data) — trying next route`);
          continue;
        }

        // Reserve fuel cells for the trip home
        const maxFuelSlots = bot.cargoMax > 0 ? Math.max(3, Math.floor(bot.cargoMax * 0.1)) : 5;
        const RESERVE_FUEL_CELLS = Math.min(Math.max(3, Math.ceil(candidate.jumps / 4)), maxFuelSlots);

        // Clear cargo: keep fuel cells only
        await bot.refreshCargo();
        const depositSummary: string[] = [];
        for (const item of [...bot.inventory]) {
          if (item.itemId === candidate.itemId) continue;
          const lower = item.itemId.toLowerCase();
          const isFuel = lower.includes("fuel") || lower.includes("energy_cell");
          if (isFuel) {
            const excess = item.quantity - RESERVE_FUEL_CELLS;
            if (excess > 0) {
              await bot.exec("deposit_items", { item_id: item.itemId, quantity: excess });
              depositSummary.push(`${excess}x ${item.name}`);
            }
          } else {
            await bot.exec("deposit_items", { item_id: item.itemId, quantity: item.quantity });
            depositSummary.push(`${item.quantity}x ${item.name}`);
          }
        }
        if (depositSummary.length > 0) {
          ctx.log("trade", `Cleared cargo: ${depositSummary.join(", ")}`);
        }

        // Ensure we have enough fuel cells
        await bot.refreshCargo();
        await bot.refreshStatus();
        let fuelInCargo = 0;
        for (const item of bot.inventory) {
          const lower = item.itemId.toLowerCase();
          if (lower.includes("fuel") || lower.includes("energy_cell")) fuelInCargo += item.quantity;
        }
        if (fuelInCargo < RESERVE_FUEL_CELLS) {
          const freeSpace = getFreeSpace(bot);
          const needed = Math.min(RESERVE_FUEL_CELLS - fuelInCargo, maxItemsForCargo(freeSpace, "fuel_cell"));
          if (needed > 0) {
            ctx.log("trade", `Buying ${needed} fuel cells for ${candidate.jumps}-jump route...`);
            await bot.exec("buy", { item_id: "fuel_cell", quantity: needed });
          }
        }

        // Determine buy quantity
        await bot.refreshStatus();
        const freeSpace = getFreeSpace(bot);
        let qty = Math.min(candidate.buyQty, maxItemsForCargo(freeSpace, candidate.itemId));
        if (settings.maxSpendPerItem > 0) {
          qty = Math.min(qty, Math.floor(settings.maxSpendPerItem / candidate.buyPrice));
        }
        if (qty > 0) {
          qty = Math.min(qty, Math.floor(bot.credits / candidate.buyPrice));
        }

        // Pre-buy validation
        if (qty > 0) {
          const estCheck = await bot.exec("estimate_purchase", { item_id: candidate.itemId, quantity: qty });
          if (!estCheck.error && estCheck.result && typeof estCheck.result === "object") {
            const est = estCheck.result as Record<string, unknown>;
            const avail = (est.available_quantity as number) || (est.available as number) || (est.max_quantity as number) || 0;
            if (avail > 0 && avail < qty) {
              ctx.log("trade", `Market only has ${avail}x available (wanted ${qty}) — adjusting`);
              qty = avail;
            }
            const totalCost = (est.total_cost as number) || (est.total as number) || (est.cost as number) || 0;
            if (totalCost > 0 && totalCost > bot.credits - 500) {
              const affordQty = Math.max(0, Math.floor(qty * ((bot.credits - 500) / totalCost)));
              if (affordQty < qty) {
                ctx.log("trade", `Actual cost ${totalCost}cr exceeds budget — reducing to ${affordQty}x`);
                qty = affordQty;
              }
            }
            const totalWeight = (est.total_weight as number) || (est.cargo_required as number) || (est.weight as number) || 0;
            if (totalWeight > 0 && qty > 0) {
              const realItemWeight = totalWeight / qty;
              const fitsInCargo = Math.floor(freeSpace / realItemWeight);
              if (fitsInCargo < qty) {
                ctx.log("trade", `Cargo can fit ${fitsInCargo}x at ${realItemWeight} weight/ea (not ${qty}) — adjusting`);
                qty = fitsInCargo;
              }
            }
          }
        }

        if (qty <= 0) {
          ctx.log("trade", "Cannot afford any items or cargo full — trying next route");
          continue;
        }

        // Buy items
        yield "buy";
        const creditsBefore = bot.credits;
        ctx.log("trade", `Buying ${qty}x ${candidate.itemName} at ${candidate.buyPrice}cr/ea...`);
        const buyResp = await bot.exec("buy", { item_id: candidate.itemId, quantity: qty });
        // Check for battle notifications after buy
        if (buyResp.notifications && Array.isArray(buyResp.notifications)) {
          const battleDetected = await handleBattleNotifications(ctx, buyResp.notifications, battleState);
          if (battleDetected) {
            ctx.log("combat", "Battle detected during buy - initiating flee!");
            battleState.isFleeing = false;
          }
        }
        // Also check battle status directly after buy (in case we missed notifications)
        const postBuyBattleCheck = await getBattleStatus(ctx);
        if (postBuyBattleCheck && postBuyBattleCheck.is_participant) {
          ctx.log("combat", `POST-BUY CHECK: IN BATTLE! Battle ID: ${postBuyBattleCheck.battle_id} - fleeing!`);
          battleState.inBattle = true;
          battleState.battleId = postBuyBattleCheck.battle_id;
          await fleeFromBattle(ctx, true, 35000);
          ctx.log("error", "Battle detected after buy - fled, will continue to home with cargo");
          // Don't continue - we have items in cargo, need to proceed to home
        }
        if (buyResp.error) {
          failedSources.add(sourceKey);
          if (buyResp.error.message.includes("item_not_available") || buyResp.error.message.includes("not_available")) {
            mapStore.removeMarketItem(candidate.sourceSystem, candidate.sourcePoi, candidate.itemId);
          }
          ctx.log("error", `Buy failed: ${buyResp.error.message} — trying next route`);
          continue;
        }

        await bot.refreshStatus();
        await bot.refreshCargo();
        const actualInCargo = bot.inventory.find(i => i.itemId === candidate.itemId)?.quantity ?? 0;
        const actualSpent = Math.max(0, creditsBefore - bot.credits);

        route = candidate;
        buyQty = actualInCargo;
        totalSpent = actualSpent;
        ctx.log("trade", `Purchased ${actualInCargo}x ${candidate.itemName} for ${actualSpent}cr (${actualSpent > 0 ? Math.round(actualSpent / Math.max(actualInCargo, 1)) : candidate.buyPrice}cr/ea)`);

        // Start trade session tracking
        const session = createTradeSession({
          botUsername: bot.username,
          route: {
            ...candidate,
            sellPrice: 0,
            sellQty: actualInCargo,
            profitPerUnit: 0,
            totalProfit: -actualSpent,
          },
          isCargoRoute: false,
          investedCredits: actualSpent,
        });
        await startTradeSession(session);
        ctx.log("trade", `Buy session started: ${session.sessionId}`);

        mapStore.reserveTradeQuantity(
          candidate.sourceSystem, candidate.sourcePoi,
          settings.homeSystem, homeStation.id,
          candidate.itemId, buyQty,
        );
        break;
      }
    }

    // No route worked — wait and retry
    if (!route || buyQty <= 0) {
      const activeSession = getActiveSession(bot.username);
      if (activeSession) {
        await failTradeSession(bot.username, "No valid route found");
      }

      ctx.log("trade", "All routes failed — waiting 60s before re-scanning");
      await ctx.sleep(60000);
      continue;
    }

    // ── Phase 2: Travel to home and deposit ──
    yield "travel_to_home";
    await ensureUndocked(ctx);

    // Post-undock battle check
    const postUndockBattleCheck = await getBattleStatus(ctx);
    if (postUndockBattleCheck && postUndockBattleCheck.is_participant) {
      ctx.log("combat", `POST-UNDOCK (HOME): IN BATTLE! Battle ID: ${postUndockBattleCheck.battle_id} - initiating flee!`);
      battleState.inBattle = true;
      battleState.battleId = postUndockBattleCheck.battle_id;
      battleState.isFleeing = false;
      await fleeFromBattle(ctx, false, 5000);
      await ensureDocked(ctx);
      await ctx.sleep(30000);
      continue;
    }

    const cargoSafetyOpts = { ...safetyOpts, noJettison: true };
    const fueled2 = await ensureFueled(ctx, safetyOpts.fuelThresholdPct, { noJettison: true });
    if (!fueled2) {
      ctx.log("error", "Cannot refuel for delivery — will retry next cycle");
      await ensureDocked(ctx);
      await ctx.sleep(30000);
      continue;
    }

    if (bot.system !== settings.homeSystem) {
      ctx.log("travel", `Heading home to ${homeStation.name}...`);

      const activeSession = getActiveSession(bot.username);
      if (activeSession) {
        await updateTradeSession(bot.username, {
          state: "in_transit",
          jumpsCompleted: 0,
        });
      }

      const arrived2 = await navigateToSystem(ctx, settings.homeSystem, {
        ...cargoSafetyOpts,
        onJump: async (jumpNum) => {
          if (jumpNum % 3 !== 0) return true;

          const session = getActiveSession(bot.username);
          if (session) {
            await updateTradeSession(bot.username, { jumpsCompleted: jumpNum });
          }

          try {
            ctx.log("trade", `Mid-route check (jump ${jumpNum}): cargo valid (${buyQty}x ${route!.itemName})`);
            return true;
          } catch (err) {
            ctx.log("trade", `Mid-route check (jump ${jumpNum}): validation error — continuing anyway`);
            return true;
          }
        },
      });

      if (!arrived2) {
        ctx.log("error", "Failed to reach home system — will retry on next cycle");

        const session = getActiveSession(bot.username);
        if (session) {
          await updateTradeSession(bot.username, {
            state: "in_transit",
            notes: (session.notes || "") + " | Network interruption - will retry",
          });
        }

        await ensureDocked(ctx);
        ctx.log("trade", "Docked and waiting for network recovery — buy session preserved");
        await ctx.sleep(60000);
        continue;
      }
    }

    // Travel to home station POI
    await ensureUndocked(ctx);
    
    // Pre-travel to home station battle check
    const preHomeStationBattleCheck = await getBattleStatus(ctx);
    if (preHomeStationBattleCheck && preHomeStationBattleCheck.is_participant) {
      ctx.log("combat", `PRE-HOME-STATION: IN BATTLE! Battle ID: ${preHomeStationBattleCheck.battle_id} - initiating flee!`);
      battleState.inBattle = true;
      battleState.battleId = preHomeStationBattleCheck.battle_id;
      battleState.isFleeing = false;
      await fleeFromBattle(ctx, false, 5000);
      await ctx.sleep(5000);
      continue;
    }
    
    if (bot.poi !== homeStation.id) {
      ctx.log("travel", `Traveling to ${homeStation.name}...`);
      const t2Resp = await bot.exec("travel", { target_poi: homeStation.id });
      // Check for battle notifications after travel
      if (t2Resp.notifications && Array.isArray(t2Resp.notifications)) {
        const battleDetected = await handleBattleNotifications(ctx, t2Resp.notifications, battleState);
        if (battleDetected) {
          ctx.log("combat", "Battle detected during travel to home station - initiating flee!");
          battleState.isFleeing = false;
        }
      }
      // Direct battle check after travel
      const travelHomeBattleCheck = await getBattleStatus(ctx);
      if (travelHomeBattleCheck && travelHomeBattleCheck.is_participant) {
        ctx.log("combat", `TRAVEL HOME: IN BATTLE! Battle ID: ${travelHomeBattleCheck.battle_id} - fleeing!`);
        battleState.inBattle = true;
        battleState.battleId = travelHomeBattleCheck.battle_id;
        await fleeFromBattle(ctx, true, 35000);
        ctx.log("trade", "Battle detected during travel home - fled, will retry");
        continue;
      }
      if (t2Resp.error && !t2Resp.error.message.includes("already")) {
        ctx.log("error", `Travel to home station failed: ${t2Resp.error.message}`);
      } else {
        bot.poi = homeStation.id;
      }
    }

    // Dock at home station
    yield "dock_home";
    const d2Resp = await bot.exec("dock");
    if (d2Resp.error && !d2Resp.error.message.includes("already")) {
      ctx.log("error", `Dock failed at home: ${d2Resp.error.message}`);
      continue;
    }
    bot.docked = true;
    await tryMissions(ctx);

    // ── Deposit items to faction storage ──
    yield "deposit";
    let totalDeposited = 0;

    await bot.refreshCargo();
    const itemToDeposit = bot.inventory.find(i => i.itemId === route.itemId);
    const depositQty = itemToDeposit?.quantity ?? 0;

    if (depositQty <= 0) {
      ctx.log("error", `No ${route.itemName} left in cargo (bought ${buyQty}, all consumed during travel)`);
    } else {
      if (depositQty < buyQty) {
        ctx.log("trade", `Only ${depositQty}/${buyQty}x ${route.itemName} left (${buyQty - depositQty} consumed during travel)`);
      }
      ctx.log("trade", `Depositing ${depositQty}x ${route.itemName} to faction storage...`);
      const depositResp = await bot.exec("faction_deposit_items", { item_id: route.itemId, quantity: depositQty });
      if (!depositResp.error) {
        totalDeposited = depositQty;
        logFactionActivity(ctx, "deposit", `Deposited ${depositQty}x ${route.itemName} from buy run (cost: ${totalSpent}cr)`);
        ctx.log("trade", `Deposited ${totalDeposited}x ${route.itemName} to faction storage`);
      } else {
        ctx.log("error", `Deposit failed: ${depositResp.error.message}`);
      }
    }

    // Complete trade session
    const actualProfit = -totalSpent; // Negative since we're spending, not profiting
    bot.stats.totalTrades++;
    bot.stats.totalProfit += actualProfit;

    await recordMarketData(ctx);

    // ── Buy summary ──
    const depositedLabel = totalDeposited < buyQty ? `${totalDeposited}/${buyQty}` : `${buyQty}`;
    ctx.log("trade", `Buy run complete: ${depositedLabel}x ${route.itemName} — spent ${totalSpent}cr (${route.jumps} jumps)`);

    const actualRevenue = 0;
    const completedSession = await completeTradeSession(bot.username, actualRevenue, actualProfit);
    if (completedSession) {
      ctx.log("trade", `Session completed: ${completedSession.sessionId}`);
    }

    // ── Maintenance ──
    yield "post_buy_maintenance";
    await tryRefuel(ctx);
    await repairShip(ctx);

    // ── Check skills ──
    yield "check_skills";
    await bot.checkSkills();

    await bot.refreshStatus();
    const endFuel = bot.maxFuel > 0 ? Math.round((bot.fuel / bot.maxFuel) * 100) : 100;
    ctx.log("info", `Credits: ${bot.credits} | Fuel: ${endFuel}% | Cargo: ${bot.cargo}/${bot.cargoMax}`);
  }
};
