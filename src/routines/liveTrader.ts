import type { Bot, Routine, RoutineContext } from "../bot.js";
import type { ApiResponse } from "../commandBridge.js";
import {
  checkBattleAfterCommand,
  ensureDocked,
  ensureUndocked,
  navigateToSystem,
  depositCargoAtHome,
  isPirateSystem,
  readSettings,
  stationHasMarket,
} from "./common.js";
import { getSystemBlacklist, getStationBlacklist } from "../web/server.js";
import { mapStore } from "../mapstore.js";
import {
  getFreshSnapshots,
  getSnapshot,
  record as recordMarketSnapshot,
  type MarketBookOrder,
  type MarketStationSnapshot,
} from "../marketSnapshotStore.js";
import { marketStreamStore, type MarketStreamEntry } from "../marketstreamstore.js";
import {
  abandonLiveTradeSession,
  completeLiveTradeSession,
  failLiveTradeSession,
  getActiveSession,
  startLiveTradeSession,
  updateLiveTradeSession,
  type TradeSession,
  type TradeSessionState,
} from "./traderActivity.js";
import {
  acquire,
  cleanupExpired,
  getClaim,
  heartbeat,
  release,
  restoreActiveClaims,
  updateClaimQuantity,
  type LiveRouteClaim,
} from "./liveTradeCoordinator.js";
import { planLiveTradeRoutes, type LiveTradeCandidate, type LiveTradeSettings } from "./liveTraderPlanning.js";
import { readSellOutcome } from "./sellOutcome.js";

const FRESHNESS_WINDOW_MS = 120_000;
const ROUTINE_SLEEP_MS = 5_000;
const RETRY_SLEEP_MS = 5_000;
const BUY_RETRIES = 3;
const SELL_RETRIES = 3;

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function getLiveTraderSettings(bot: Bot, botUsername: string): LiveTradeSettings {
  const all = readSettings();
  const trader = (all.trader || {}) as Record<string, unknown>;
  const user = (all[botUsername] || {}) as Record<string, unknown>;
  const general = (all.general || {}) as Record<string, unknown>;
  return {
    minProfitPerUnit: asNumber(user.minProfitPerUnit ?? trader.minProfitPerUnit, 0),
    maxCargoValue: asNumber(user.maxCargoValue ?? trader.maxCargoValue, 0),
    fuelCostPerJump: asNumber(user.fuelCostPerJump ?? trader.fuelCostPerJump, 50),
    freeCargoWeight: Math.max(0, bot.cargoMax - bot.cargo),
    homeSystem: typeof general.homeSystem === "string" ? general.homeSystem : "",
    homeStation: typeof general.homeStation === "string" ? general.homeStation : "",
  };
}

function getTradeItemIds(settings: Record<string, unknown>): Set<string> {
  const value = settings.tradeItems;
  if (!Array.isArray(value)) return new Set();
  const ids = new Set<string>();
  for (const entry of value) {
    const itemId = typeof entry === "string" ? entry : (entry as Record<string, unknown>).itemId;
    if (typeof itemId === "string" && itemId) ids.add(itemId);
  }
  return ids;
}

function resultRecord(response: ApiResponse): Record<string, unknown> | undefined {
  let value = response.result;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.structuredContent && typeof record.structuredContent === "object") value = record.structuredContent;
    else if (record.delta && typeof record.delta === "object") {
      const delta = record.delta as Record<string, unknown>;
      if (delta.details && typeof delta.details === "object") value = delta.details;
      else value = delta;
    }
    else if (record.details && typeof record.details === "object") value = record.details;
    else if (record.result && typeof record.result === "object") value = record.result;
  }
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function cargoQuantity(bot: Bot, itemId: string): number {
  return bot.inventory.find((item) => item.itemId === itemId)?.quantity || 0;
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function itemFromSnapshot(snapshot: MarketStationSnapshot, itemId: string): import("../marketSnapshotStore.js").MarketBookItem | null {
  return snapshot.items.find((item) => item.itemId === itemId) || null;
}

function orderFromSnapshot(snapshot: MarketStationSnapshot, itemId: string, orderId?: string): MarketBookOrder | null {
  const item = itemFromSnapshot(snapshot, itemId);
  if (!item) return null;
  if (orderId) {
    const exact = [...item.sellOrders, ...item.buyOrders].find((order) => order.orderId === orderId || order.source === orderId);
    if (exact) return exact;
  }
  const orders = itemId ? item.sellOrders : item.buyOrders;
  return [...orders].sort((a, b) => a.price - b.price || b.quantity - a.quantity)[0] || null;
}

function destinationOrderFromSnapshot(snapshot: MarketStationSnapshot, itemId: string, orderId?: string): MarketBookOrder | null {
  const item = itemFromSnapshot(snapshot, itemId);
  if (!item) return null;
  if (orderId) {
    const exact = item.buyOrders.find((order) => order.orderId === orderId || order.source === orderId);
    if (exact) return exact;
  }
  return [...item.buyOrders].sort((a, b) => b.price - a.price || b.quantity - a.quantity)[0] || null;
}

function snapshotMatches(snapshot: MarketStationSnapshot, session: TradeSession, side: "source" | "destination"): boolean {
  if (side === "source") {
    return snapshot.systemId.toLowerCase() === session.sourceSystem.toLowerCase() &&
      snapshot.poiId.toLowerCase() === session.sourcePoi.toLowerCase();
  }
  return snapshot.systemId.toLowerCase() === session.destSystem.toLowerCase() &&
    snapshot.poiId.toLowerCase() === session.destPoi.toLowerCase();
}

function findSessionSnapshot(snapshots: MarketStationSnapshot[], session: TradeSession, side: "source" | "destination"): MarketStationSnapshot | null {
  return snapshots.find((snapshot) => snapshotMatches(snapshot, session, side)) || null;
}

function isUsableStation(snapshot: MarketStationSnapshot): boolean {
  if (!snapshot.systemId || !snapshot.poiId || !snapshot.baseId) return false;
  const system = mapStore.getSystem(snapshot.systemId);
  const poi = system?.pois.find((candidate) => candidate.id === snapshot.poiId);
  if (!poi?.has_base) return false;
  if (snapshot.baseId === "frontier_station") return mapStore.isMobileCapitol(snapshot.systemId, snapshot.poiId);
  return stationHasMarket(poi as any);
}

function isSystemAllowed(systemId: string): boolean {
  const blacklist = new Set(getSystemBlacklist().map((system: string) => system.toLowerCase()));
  const stations = new Set(getStationBlacklist().map((station: string) => station.toLowerCase()));
  return !blacklist.has(systemId.toLowerCase()) && !isPirateSystem(systemId) &&
    ![...stations].some((station: string) => station === systemId.toLowerCase() || station.endsWith(`|${systemId.toLowerCase()}`));
}

function routeJumps(fromSystem: string, toSystem: string): number {
  const route = mapStore.findRoute(fromSystem, toSystem) || [fromSystem, toSystem];
  return Math.max(0, route.length - 1);
}

function createLiveSession(bot: Bot, candidate: LiveTradeCandidate): TradeSession {
  const now = new Date().toISOString();
  const quantity = candidate.quantity;
  const invested = candidate.sourcePrice * quantity;
  return {
    sessionId: `${bot.username}_${Date.now()}`,
    botUsername: bot.username,
    routine: "live_trader",
    phase: "buying",
    state: "buying",
    itemId: candidate.itemId,
    itemName: candidate.itemName,
    sourceSystem: candidate.sourceSnapshot.systemId,
    sourcePoi: candidate.sourceSnapshot.poiId,
    sourcePoiName: candidate.sourceSnapshot.poiName,
    sourceBaseId: candidate.sourceSnapshot.baseId,
    buyPricePerUnit: candidate.sourcePrice,
    quantityBought: quantity,
    totalSpent: invested,
    destSystem: candidate.destSnapshot.systemId,
    destPoi: candidate.destSnapshot.poiId,
    destOriginalPoi: candidate.destSnapshot.poiId,
    destBaseId: candidate.destSnapshot.baseId,
    destPoiName: candidate.destSnapshot.poiName,
    sellPricePerUnit: candidate.destinationPrice,
    sellQuantity: quantity,
    totalJumps: candidate.jumps,
    jumpsCompleted: 0,
    estimatedFuelCost: candidate.fuelCost,
    investedCredits: invested,
    expectedRevenue: candidate.destinationPrice * quantity,
    expectedProfit: candidate.totalProfit,
    actualQuantityAboard: 0,
    actualCreditsSpent: 0,
    actualSoldQuantity: 0,
    actualRevenue: 0,
    actualProfit: 0,
    creditsBeforeBuy: bot.credits,
    sourceOrderId: candidate.sourceOrderId,
    destOrderId: candidate.destOrderId,
    sourceDepth: candidate.sourceOrder.quantity,
    destDepth: candidate.destOrder.quantity,
    snapshotTick: candidate.sourceSnapshot.snapshotTick ?? candidate.destSnapshot.snapshotTick,
    snapshotUpdatedAt: Math.min(candidate.sourceSnapshot.updatedAt, candidate.destSnapshot.updatedAt),
    routeClaimKey: candidate.routeClaimKey,
    startedAt: now,
    lastUpdatedAt: now,
    lastHeartbeat: Date.now(),
    notes: "Live market buy route",
  };
}

async function refreshBotState(ctx: RoutineContext): Promise<void> {
  const { bot } = ctx;
  await bot.refreshStatus();
  await bot.refreshShip();
  await bot.refreshCargoAndStorage();
  await bot.refreshLocation();
  await bot.refreshFactionStorage(false);
}

async function transitionSession(ctx: RoutineContext, session: TradeSession, phase: TradeSessionState, updates: Partial<TradeSession> = {}): Promise<TradeSession | null> {
  return updateLiveTradeSession(session.botUsername, { ...updates, phase, state: phase });
}

async function reconcileActiveSession(ctx: RoutineContext, session: TradeSession): Promise<TradeSession | null> {
  const { bot } = ctx;
  await refreshBotState(ctx);
  const cargoQty = cargoQuantity(bot, session.itemId);
  if (cargoQty > 0) {
    const creditedSpent = session.creditsBeforeBuy === undefined
      ? session.actualCreditsSpent
      : Math.max(0, session.creditsBeforeBuy - bot.credits);
    session.actualQuantityAboard = cargoQty;
    session.actualCreditsSpent = Math.max(session.actualCreditsSpent, creditedSpent);
    if (session.phase === "buying" && cargoQty >= session.quantityBought) {
      session.phase = "in_transit";
      session.state = "in_transit";
      return transitionSession(ctx, session, "in_transit");
    }
    return transitionSession(ctx, session, session.phase);
  }

  if (session.phase === "buying" || session.phase === "awaiting_market") return session;
  await failLiveTradeSession(session.botUsername, "Trade cargo is not aboard");
  release(claimParams(session));
  return null;
}

async function ensureRouteClaim(ctx: RoutineContext, session: TradeSession): Promise<boolean> {
  cleanupExpired();
  const params = {
    botUsername: session.botUsername,
    itemId: session.itemId,
    sourceSystem: session.sourceSystem,
    sourcePoi: session.sourcePoi,
    destSystem: session.destSystem,
    destPoi: session.destPoi,
  };
  const existing = getClaim(params);
  if (existing) {
    if (existing.lockedBy !== session.botUsername) return false;
    heartbeat(params);
    return true;
  }
  const quantity = session.quantityBought || session.sellQuantity || 0;
  const result = acquire({
    ...params,
    itemName: session.itemName,
    quantity,
    sessionId: session.sessionId,
    sourceDepth: session.sourceDepth || quantity,
    destDepth: session.destDepth || quantity,
  });
  if (!result.success) {
    ctx.log("trade", `Route claim unavailable: ${result.reason}`);
    return false;
  }
  return true;
}

function claimParams(session: TradeSession) {
  return {
    botUsername: session.botUsername,
    itemId: session.itemId,
    sourceSystem: session.sourceSystem,
    sourcePoi: session.sourcePoi,
    destSystem: session.destSystem,
    destPoi: session.destPoi,
  };
}

function isTransientError(response: ApiResponse): boolean {
  const message = response.error?.message?.toLowerCase() || "";
  return response.error?.code === "timeout" ||
    /timeout|524|520|502|bad gateway|connection|network|hiccup|temporarily|try again|busy|systems are not connected|mid-jump|mid-travel|already in transit|pending/i.test(message);
}

async function travelToStation(ctx: RoutineContext, systemId: string, poiId: string): Promise<boolean> {
  const { bot } = ctx;
  await bot.refreshLocation();
  if (bot.system.toLowerCase() !== systemId.toLowerCase()) {
    const traveled = await navigateToSystem(ctx, systemId, {
      fuelThresholdPct: 20,
      hullThresholdPct: 20,
      noJettison: true,
      autoCloak: true,
      ignorePiratesWhenCloaked: true,
      ignoreBlacklistWhenCloaked: true,
    });
    if (!traveled) return false;
    await bot.refreshLocation();
  }
  if (bot.poi.toLowerCase() !== poiId.toLowerCase()) {
    await ensureUndocked(ctx);
    const travel = await bot.exec("travel", { target_poi: poiId });
    if (travel.error && !/already/i.test(travel.error.message)) return false;
    bot.poi = poiId;
    await bot.refreshLocation();
  }
  return ensureDocked(ctx, true, 0, { targetStationId: poiId });
}

async function buyAtSource(ctx: RoutineContext, session: TradeSession, sourceSnapshot: MarketStationSnapshot): Promise<"done" | "retry" | "lost"> {
  const { bot } = ctx;
  const sourceOrder = orderFromSnapshot(sourceSnapshot, session.itemId, session.sourceOrderId);
  if (!sourceOrder || sourceOrder.price <= 0 || sourceOrder.quantity <= 0) return "lost";
  const beforeCargo = cargoQuantity(bot, session.itemId);
  const beforeCredits = bot.credits;
  const remaining = Math.max(0, session.quantityBought - session.actualQuantityAboard);
  const quantity = Math.min(remaining, sourceOrder.quantity);
  if (quantity <= 0) {
    session.actualQuantityAboard = beforeCargo;
    await transitionSession(ctx, session, "in_transit");
    return "done";
  }

  const response = await bot.exec("buy", { item_id: session.itemId, quantity });
  await checkBattleAfterCommand(ctx, response.notifications, "buy");
  await bot.refreshCargo();
  await bot.refreshStatus();
  const afterCargo = cargoQuantity(bot, session.itemId);
  const bought = Math.max(0, afterCargo - beforeCargo);
  const spent = Math.max(0, beforeCredits - bot.credits);
  session.actualQuantityAboard = afterCargo;
  session.actualCreditsSpent = Math.max(session.actualCreditsSpent, spent);
  session.totalSpent = session.actualCreditsSpent;
  session.actualProfit = session.actualRevenue - session.actualCreditsSpent - session.estimatedFuelCost;
  await updateLiveTradeSession(session.botUsername, {
    actualQuantityAboard: session.actualQuantityAboard,
    actualCreditsSpent: session.actualCreditsSpent,
    totalSpent: session.totalSpent,
    actualProfit: session.actualProfit,
  });
  if (bought > 0) {
    updateClaimQuantity({ ...claimParams(session), quantity: session.quantityBought });
    if (session.actualQuantityAboard >= session.quantityBought) {
    return "done";
    }
    return "retry";
  }
  if (!response.error || isTransientError(response)) return "retry";
  return /not_available|item_not_available|no_market/i.test(response.error.message || "") ? "lost" : "retry";
}

function findFreshDestinationBuyer(ctx: RoutineContext, session: TradeSession, settings: LiveTradeSettings): { snapshot: MarketStationSnapshot; order: MarketBookOrder; jumps: number } | null {
  const { bot } = ctx;
  const fresh = getFreshSnapshots(FRESHNESS_WINDOW_MS);
  const available = Math.max(0, session.actualQuantityAboard - session.actualSoldQuantity);
  if (available <= 0) return null;
  const costPerUnit = session.actualCreditsSpent / Math.max(1, session.actualQuantityAboard);
  let best: { snapshot: MarketStationSnapshot; order: MarketBookOrder; jumps: number; profit: number; profitPerUnit: number } | null = null;
  for (const snapshot of fresh) {
    if (snapshot.systemId.toLowerCase() === bot.system.toLowerCase() && snapshot.poiId.toLowerCase() === bot.poi.toLowerCase()) continue;
    const item = itemFromSnapshot(snapshot, session.itemId);
    if (!item) continue;
    for (const order of [...item.buyOrders].sort((a, b) => b.price - a.price)) {
      if (order.price <= 0 || order.quantity <= 0) continue;
      const jumps = routeJumps(bot.system, snapshot.systemId);
      const fuelCost = jumps * settings.fuelCostPerJump;
      const quantity = Math.min(available, order.quantity);
      const profit = (order.price - costPerUnit) * quantity - fuelCost;
      const profitPerUnit = quantity > 0 ? profit / quantity : 0;
      if (profit <= 0 || profitPerUnit < settings.minProfitPerUnit) continue;
      if (!best || profit > best.profit) best = { snapshot, order, jumps, profit, profitPerUnit };
    }
  }
  return best ? { snapshot: best.snapshot, order: best.order, jumps: best.jumps } : null;
}

async function rerouteToFreshBuyer(ctx: RoutineContext, session: TradeSession, settings: LiveTradeSettings): Promise<boolean> {
  const found = findFreshDestinationBuyer(ctx, session, settings);
  if (!found) return false;
  const oldKey = claimParams(session);
  release(oldKey);
  const oldSession = { ...session };
  session.destSystem = found.snapshot.systemId;
  session.destPoi = found.snapshot.poiId;
  session.destPoiName = found.snapshot.poiName;
  session.destBaseId = found.snapshot.baseId;
  session.sellPricePerUnit = found.order.price;
  session.sellQuantity = Math.min(session.sellQuantity, found.order.quantity);
  session.destOrderId = found.order.orderId || found.order.source;
  session.snapshotTick = found.snapshot.snapshotTick;
  session.snapshotUpdatedAt = found.snapshot.updatedAt;
  session.totalJumps = session.jumpsCompleted + found.jumps;
  session.estimatedFuelCost += found.jumps * settings.fuelCostPerJump;
  session.expectedRevenue = session.sellPricePerUnit * session.sellQuantity;
  session.expectedProfit = session.expectedRevenue - session.actualCreditsSpent - session.estimatedFuelCost;
  session.routeClaimKey = [
    session.itemId,
    session.sourceSystem.toLowerCase(),
    session.sourcePoi.toLowerCase(),
    session.destSystem.toLowerCase(),
    session.destPoi.toLowerCase(),
  ].join("|");
  const acquired = acquire({
    botUsername: session.botUsername,
    itemName: session.itemName,
    itemId: session.itemId,
    sourceSystem: session.sourceSystem,
    sourcePoi: session.sourcePoi,
    destSystem: session.destSystem,
    destPoi: session.destPoi,
    quantity: session.sellQuantity,
    sessionId: session.sessionId,
    sourceDepth: session.sourceDepth || session.quantityBought,
    destDepth: found.order.quantity,
  });
  if (!acquired.success) {
    Object.assign(session, oldSession);
    return false;
  }
  await updateLiveTradeSession(session.botUsername, {
    destSystem: session.destSystem,
    destPoi: session.destPoi,
    destPoiName: session.destPoiName,
    destBaseId: session.destBaseId,
    sellPricePerUnit: session.sellPricePerUnit,
    sellQuantity: session.sellQuantity,
    destOrderId: session.destOrderId,
    snapshotTick: session.snapshotTick,
    snapshotUpdatedAt: session.snapshotUpdatedAt,
    totalJumps: session.totalJumps,
    estimatedFuelCost: session.estimatedFuelCost,
    expectedRevenue: session.expectedRevenue,
    expectedProfit: session.expectedProfit,
    routeClaimKey: session.routeClaimKey,
  });
  return true;
}

async function sellAtDestination(ctx: RoutineContext, session: TradeSession, destinationSnapshot: MarketStationSnapshot, settings: LiveTradeSettings): Promise<"done" | "retry" | "return"> {
  const { bot } = ctx;
  let order = destinationOrderFromSnapshot(destinationSnapshot, session.itemId, session.destOrderId);
  if (!order || order.price <= 0 || order.quantity <= 0) {
    if (!await rerouteToFreshBuyer(ctx, session, settings)) return "return";
    const refreshed = getSnapshot(session.destSystem, session.destPoi) || findSessionSnapshot(getFreshSnapshots(FRESHNESS_WINDOW_MS), session, "destination");
    if (!refreshed) return "return";
    order = destinationOrderFromSnapshot(refreshed, session.itemId, session.destOrderId);
    if (!order) return "return";
  }

  const beforeCargo = cargoQuantity(bot, session.itemId);
  const beforeCredits = bot.credits;
  const available = Math.max(0, beforeCargo - session.actualSoldQuantity);
  const quantity = Math.min(available, order.quantity);
  if (quantity <= 0) {
    if (session.actualSoldQuantity >= session.actualQuantityAboard) {
      const revenue = session.actualRevenue;
      const profit = revenue - session.actualCreditsSpent - session.estimatedFuelCost;
      await completeLiveTradeSession(session.botUsername, revenue, profit);
      release(claimParams(session));
      return "done";
    }
    return "return";
  }

  const response = await bot.exec("sell", { item_id: session.itemId, quantity });
  await checkBattleAfterCommand(ctx, response.notifications, "sell");
  await bot.refreshCargo();
  await bot.refreshStatus();
  const afterCargo = cargoQuantity(bot, session.itemId);
  const cargoSold = Math.max(0, beforeCargo - afterCargo);
  const outcome = readSellOutcome(resultRecord(response));
  const sold = Math.max(cargoSold, Math.min(available, outcome.soldQty));
  const creditDelta = Math.max(0, bot.credits - beforeCredits);
  const revenue = outcome.verified ? outcome.revenue : creditDelta;
  if (sold <= 0) {
    if (!response.error || isTransientError(response)) return "retry";
    return "retry";
  }

  session.actualSoldQuantity += sold;
  session.actualRevenue += revenue;
  session.actualProfit = session.actualRevenue - session.actualCreditsSpent - session.estimatedFuelCost;
  await updateLiveTradeSession(session.botUsername, {
    actualSoldQuantity: session.actualSoldQuantity,
    actualRevenue: session.actualRevenue,
    actualProfit: session.actualProfit,
  });
  if (session.actualSoldQuantity >= session.actualQuantityAboard) {
    const completed = await completeLiveTradeSession(session.botUsername, session.actualRevenue, session.actualProfit);
    if (completed) release(claimParams(session));
    return "done";
  }
  if (findFreshDestinationBuyer(ctx, session, settings)) return "retry";
  return "return";
}

async function returnCargoHome(ctx: RoutineContext, session: TradeSession, settings: LiveTradeSettings): Promise<boolean> {
  const { bot } = ctx;
  await transitionSession(ctx, session, "returning_home");
  if (cargoQuantity(bot, session.itemId) <= 0) return false;
  const homeSystem = settings.homeSystem || session.sourceSystem;
  const traveled = await navigateToSystem(ctx, homeSystem, {
    fuelThresholdPct: 20,
    hullThresholdPct: 20,
    noJettison: true,
    autoCloak: true,
    ignorePiratesWhenCloaked: true,
    ignoreBlacklistWhenCloaked: true,
  });
  if (!traveled) return false;
  return depositCargoAtHome(ctx, { fuelThresholdPct: 20, hullThresholdPct: 20 });
}

async function abandonAndReplan(ctx: RoutineContext, session: TradeSession, reason: string): Promise<boolean> {
  release(claimParams(session));
  await abandonLiveTradeSession(session.botUsername, reason);
  return false;
}

export const liveTraderRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;
  const subscriptions = new Map<string, (entry: MarketStreamEntry | null) => void>();
  const syncSnapshotSubscriptions = (): void => {
    for (const [baseId, entry] of Object.entries(marketStreamStore.getAll())) {
      if (!baseId || subscriptions.has(baseId)) continue;
      const subscriber = (next: MarketStreamEntry | null): void => {
        if (!next?.baseId) return;
        recordMarketSnapshot(next.baseId, {
          baseId: next.baseId,
          systemId: next.systemId,
          poiId: next.poiId,
          poiName: next.poiName,
          updatedAt: next.updatedAt,
        }, next.tick ?? 0, next.items);
      };
      subscriptions.set(baseId, subscriber);
      marketStreamStore.subscribe(baseId, subscriber);
    }
  };
  syncSnapshotSubscriptions();

  try {
    restoreActiveClaims(bot.username);
    while (bot.state === "running") {
      await refreshBotState(ctx);
      const settings = getLiveTraderSettings(bot, bot.username);
      let session = getActiveSession(bot.username);
      if (!session || session.routine !== "live_trader") {
        const fresh = getFreshSnapshots(FRESHNESS_WINDOW_MS);
        const candidate = planLiveTradeRoutes(fresh, settings)
          .filter((route) => {
            const tradeItems = getTradeItemIds(readSettings()[bot.username] || readSettings().trader || {});
            return (!tradeItems.size || tradeItems.has(route.itemId)) &&
              isSystemAllowed(route.sourceSnapshot.systemId) &&
              isSystemAllowed(route.destSnapshot.systemId) &&
              isUsableStation(route.sourceSnapshot) &&
              isUsableStation(route.destSnapshot);
          })[0];
        if (!candidate) {
          await ctx.sleep(ROUTINE_SLEEP_MS);
          continue;
        }
        const acquired = acquire({
          botUsername: bot.username,
          itemName: candidate.itemName,
          itemId: candidate.itemId,
          sourceSystem: candidate.sourceSnapshot.systemId,
          sourcePoi: candidate.sourceSnapshot.poiId,
          destSystem: candidate.destSnapshot.systemId,
          destPoi: candidate.destSnapshot.poiId,
          quantity: candidate.quantity,
          sessionId: `${bot.username}_${Date.now()}`,
          sourceDepth: candidate.sourceOrder.quantity,
          destDepth: candidate.destOrder.quantity,
        });
        if (!acquired.success) {
          await ctx.sleep(ROUTINE_SLEEP_MS);
          continue;
        }
        const liveSession = createLiveSession(bot, candidate);
        await startLiveTradeSession(liveSession);
        session = liveSession;
      }

      session = await reconcileActiveSession(ctx, session) || session;
      if (!await ensureRouteClaim(ctx, session)) {
        if (cargoQuantity(bot, session.itemId) > 0) {
          if (await returnCargoHome(ctx, session, settings)) {
            await failLiveTradeSession(session.botUsername, "Route claim held by another bot");
          }
        } else {
          await failLiveTradeSession(session.botUsername, "Route claim held by another bot");
        }
        continue;
      }

      const fresh = getFreshSnapshots(FRESHNESS_WINDOW_MS);
      const sourceSnapshot = findSessionSnapshot(fresh, session, "source");
      const destinationSnapshot = findSessionSnapshot(fresh, session, "destination");
      switch (session.phase) {
        case "buying":
        case "awaiting_market": {
          if (!sourceSnapshot) {
            await transitionSession(ctx, session, "awaiting_market");
            await ctx.sleep(ROUTINE_SLEEP_MS);
            continue;
          }
          await updateLiveTradeSession(session.botUsername, {
            sourceOrderId: session.sourceOrderId,
            snapshotTick: sourceSnapshot.snapshotTick,
            snapshotUpdatedAt: sourceSnapshot.updatedAt,
          });
          const bought = await buyAtSource(ctx, session, sourceSnapshot);
          if (bought === "lost") {
            await abandonAndReplan(ctx, session, "Source sell order disappeared");
            break;
          }
          if (bought === "done") break;
          await ctx.sleep(RETRY_SLEEP_MS);
          continue;
        }
        case "in_transit": {
          if (cargoQuantity(bot, session.itemId) <= 0) {
            await failLiveTradeSession(session.botUsername, "Cargo lost during transit");
            break;
          }
          heartbeat(claimParams(session));
          const traveled = await navigateToSystem(ctx, session.destSystem, {
            fuelThresholdPct: 20,
            hullThresholdPct: 20,
            noJettison: true,
            autoCloak: true,
            ignorePiratesWhenCloaked: true,
            ignoreBlacklistWhenCloaked: true,
            onJump: async () => {
              session.jumpsCompleted += 1;
              await updateLiveTradeSession(session.botUsername, { jumpsCompleted: session.jumpsCompleted });
              heartbeat(claimParams(session));
              return true;
            },
          });
          if (!traveled) {
            await transitionSession(ctx, session, "in_transit");
            await ctx.sleep(RETRY_SLEEP_MS);
            continue;
          }
          session.jumpsCompleted = session.totalJumps;
          await transitionSession(ctx, session, "at_destination", { jumpsCompleted: session.jumpsCompleted });
          break;
        }
        case "at_destination": {
          if (cargoQuantity(bot, session.itemId) <= 0) {
            release(claimParams(session));
            await failLiveTradeSession(session.botUsername, "Cargo missing at destination");
            break;
          }
          if (!destinationSnapshot) {
            if (await returnCargoHome(ctx, session, settings)) await failLiveTradeSession(session.botUsername, "Destination market snapshot unavailable");
            continue;
          }
          if (!await travelToStation(ctx, session.destSystem, session.destPoi)) {
            await transitionSession(ctx, session, "at_destination");
            await ctx.sleep(RETRY_SLEEP_MS);
            continue;
          }
          const sold = await sellAtDestination(ctx, session, destinationSnapshot, settings);
          if (sold === "done") break;
          if (sold === "return") {
            if (await returnCargoHome(ctx, session, settings)) await failLiveTradeSession(session.botUsername, "No profitable destination buyer");
            continue;
          }
          await ctx.sleep(RETRY_SLEEP_MS);
          continue;
        }
        case "selling": {
          if (cargoQuantity(bot, session.itemId) <= 0) {
            release(claimParams(session));
            await failLiveTradeSession(session.botUsername, "Cargo missing while selling");
            break;
          }
          if (!destinationSnapshot) {
            if (await returnCargoHome(ctx, session, settings)) await failLiveTradeSession(session.botUsername, "Destination market snapshot unavailable");
            continue;
          }
          if (!await travelToStation(ctx, session.destSystem, session.destPoi)) {
            await transitionSession(ctx, session, "selling");
            await ctx.sleep(RETRY_SLEEP_MS);
            continue;
          }
          const sold = await sellAtDestination(ctx, session, destinationSnapshot, settings);
          if (sold === "done") break;
          if (sold === "return") {
            if (await returnCargoHome(ctx, session, settings)) await failLiveTradeSession(session.botUsername, "No profitable destination buyer");
            continue;
          }
          await ctx.sleep(RETRY_SLEEP_MS);
          continue;
        }
        case "returning_home": {
          if (cargoQuantity(bot, session.itemId) <= 0) {
            release(claimParams(session));
            await failLiveTradeSession(session.botUsername, "Cargo missing while returning home");
            break;
          }
          if (await returnCargoHome(ctx, session, settings)) {
            await completeLiveTradeSession(session.botUsername, session.actualRevenue, session.actualProfit);
            release(claimParams(session));
          } else {
            await transitionSession(ctx, session, "returning_home");
            await ctx.sleep(RETRY_SLEEP_MS);
          }
          continue;
        }
        default:
          await ctx.sleep(ROUTINE_SLEEP_MS);
      }
    }
  } finally {
    for (const [baseId, subscriber] of subscriptions) marketStreamStore.unsubscribe(baseId, subscriber);
    subscriptions.clear();
  }
};
