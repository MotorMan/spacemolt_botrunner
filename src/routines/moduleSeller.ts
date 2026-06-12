import type { Routine, RoutineContext } from "../bot.js";
import { mapStore } from "../mapstore.js";
import { catalogStore } from "../catalogstore.js";
import {
  ensureDocked,
  ensureUndocked,
  tryRefuel,
  repairShip,
  navigateToSystem,
  getSystemInfo,
  detectAndRecoverFromDeath,
  maxItemsForCargo,
  readSettings,
  logFactionActivity,
  checkAndFleeFromBattle,
  type BattleState,
  getBattleStatus,
} from "./common.js";

// ── Settings ─────────────────────────────────────────────────

interface ModuleSellConfig {
  itemId: string;
  maxQty: number;
  doNotSell: boolean;
}

interface ModuleSellerSettings {
  homeSystem: string;
  homeStation: string;
  fuelCostPerJump: number;
  refuelThreshold: number;
  repairThreshold: number;
  priceMode: "premium" | "undercut";
  premiumPct: number;
  undercutCr: number;
  sellAtHome: boolean;
  maxQtyDefault: number;
  moduleItems: ModuleSellConfig[];
}

function getModuleSellerSettings(username?: string): ModuleSellerSettings {
  const all = readSettings();
  const general = all.general || {};
  const s = all.module_seller || {};
  const botOverrides = username ? (all[username] || {}) : {};

  let moduleItems: ModuleSellConfig[] = [];
    if (Array.isArray(s.moduleItems)) {
      moduleItems = s.moduleItems.map((item: { itemId?: string; maxQty?: number; doNotSell?: boolean }) => ({
      itemId: item.itemId || "",
      maxQty: typeof item.maxQty === "number" ? item.maxQty : 0,
      doNotSell: !!item.doNotSell,
    })).filter((item: ModuleSellConfig) => item.itemId);
  }

  return {
    homeSystem: (botOverrides.homeSystem as string) || (s.homeSystem as string) || (general.factionStorageSystem as string) || "",
    homeStation: (botOverrides.homeStation as string) || (s.homeStation as string) || (general.factionStorageStation as string) || "",
    fuelCostPerJump: (s.fuelCostPerJump as number) || 50,
    refuelThreshold: (s.refuelThreshold as number) || 50,
    repairThreshold: (s.repairThreshold as number) || 40,
    priceMode: (s.priceMode as "premium" | "undercut") || "premium",
    premiumPct: (s.premiumPct as number) || 5,
    undercutCr: (s.undercutCr as number) || 100,
    sellAtHome: s.sellAtHome !== false,
    maxQtyDefault: (s.maxQtyDefault as number) || 10,
    moduleItems,
  };
}

// ── Module detection ──────────────────────────────────────────

function isShipModule(itemId: string): boolean {
  const item = catalogStore.getItem(itemId);
  const slot = (item?.slot as string | undefined)?.toLowerCase();
  return slot === "weapon" || slot === "defense" || slot === "utility";
}

// ── Price calculation ─────────────────────────────────────────

function computeSellPrice(
  itemId: string,
  priceMode: "premium" | "undercut",
  premiumPct: number,
  undercutCr: number,
): { price: number; source: string } {
  const allBuys = mapStore.getAllBuyDemand();
  const buyers = allBuys
    .filter(b => b.itemId === itemId && b.price > 0)
    .sort((a, b) => b.price - a.price);

  if (buyers.length === 0) return { price: 0, source: "none" };
  const bestBuyPrice = buyers[0].price;

  if (priceMode === "premium") {
    const price = Math.floor(bestBuyPrice * (1 + premiumPct / 100));
    return { price: Math.max(1, price), source: `premium+${premiumPct}%` };
  }

  const price = Math.floor(bestBuyPrice - undercutCr);
  return { price: Math.max(1, price), source: `undercut-${undercutCr}cr` };
}

// ── Best destination ──────────────────────────────────────────

interface BestStation {
  systemId: string;
  poiId: string;
  poiName: string;
}

function findBestSellStation(itemId: string): BestStation | null {
  const allBuys = mapStore.getAllBuyDemand();
  const buyers = allBuys
    .filter(b => b.itemId === itemId && b.price > 0)
    .sort((a, b) => b.price - a.price || (a.quantity ?? 0) - (b.quantity ?? 0));

  for (const buyer of buyers) {
    const sys = mapStore.getSystem(buyer.systemId);
    if (!sys) continue;
    const poi = sys.pois.find(p => p.id === buyer.poiId);
    if (!poi || !poi.has_base) continue;
    if (!poi.market || poi.market.length === 0) continue;
    return { systemId: buyer.systemId, poiId: buyer.poiId, poiName: buyer.poiName };
  }

  return null;
}

// ── Main routine ──────────────────────────────────────────────

export const moduleSellerRoutine: Routine = async function* (ctx: RoutineContext) {
  const { bot } = ctx;

  await bot.refreshStatus();

  const battleState: BattleState = {
    inBattle: false,
    battleId: null,
    battleStartTick: null,
    lastHitTick: null,
    isFleeing: false,
    lastFleeTime: undefined,
  };

  while (bot.state === "running") {
    const alive = await detectAndRecoverFromDeath(ctx);
    if (!alive) { await ctx.sleep(30000); continue; }

    if (await checkAndFleeFromBattle(ctx, "module_seller")) {
      await ctx.sleep(5000);
      continue;
    }

    if (bot.isInBattle()) {
      const now = Date.now();
      const timeSinceLastFlee = battleState.lastFleeTime ? now - battleState.lastFleeTime : Infinity;
      if (timeSinceLastFlee > 10000) {
        ctx.log("combat", "PERIODIC CHECK: IN BATTLE! - initiating IMMEDIATE flee!");
        battleState.inBattle = true;
        battleState.isFleeing = false;
        await bot.exec("battle", { action: "stance", stance: "flee" });
        battleState.lastFleeTime = now;
        ctx.log("combat", "Flee stance issued - will re-issue every cycle until disengaged!");
      }
    }

    if (battleState.inBattle) {
      const now = Date.now();
      const timeSinceLastFlee = battleState.lastFleeTime ? now - battleState.lastFleeTime : Infinity;
      if (timeSinceLastFlee > 10000) {
        ctx.log("combat", "Re-issuing flee stance (ensuring we stay in flee mode)...");
        const fleeResp = await bot.exec("battle", { action: "stance", stance: "flee" });
        if (fleeResp.error) {
          ctx.log("error", `Flee re-issue failed: ${fleeResp.error.message}`);
        } else {
          battleState.lastFleeTime = now;
        }
      }
      const currentBattleStatus = await getBattleStatus(ctx);
      if (!currentBattleStatus || !currentBattleStatus.is_participant) {
        ctx.log("combat", "Battle cleared - no longer in combat!");
        battleState.inBattle = false;
        battleState.battleId = null;
        battleState.isFleeing = false;
        battleState.lastFleeTime = undefined;
        await ctx.sleep(2000);
        continue;
      }
      await ctx.sleep(2000);
      continue;
    }

    const settings = getModuleSellerSettings();

    if (!settings.homeSystem || !settings.homeStation) {
      ctx.log("error", "ModuleSeller: homeSystem and homeStation must be configured in settings");
      await ctx.sleep(30000);
      continue;
    }

    const docked = await ensureDocked(ctx);
    if (!docked) {
      ctx.log("error", "ModuleSeller: failed to dock at station");
      await ctx.sleep(30000);
      continue;
    }

    await tryRefuel(ctx);
    await repairShip(ctx);

    await bot.refreshFactionStorage();
    if (bot.factionStorage.length === 0) {
      ctx.log("trade", "ModuleSeller: faction storage empty — waiting for items");
      await ctx.sleep(60000);
      continue;
    }

    const moduleStorage = bot.factionStorage.filter(item => {
      if (!isShipModule(item.itemId)) return false;
      const config = settings.moduleItems.find(m => m.itemId === item.itemId);
      if (config?.doNotSell) return false;
      return true;
    });

    if (moduleStorage.length === 0) {
      ctx.log("trade", "ModuleSeller: no ship modules in faction storage — waiting");
      await ctx.sleep(60000);
      continue;
    }

    const freeCargo = bot.cargoMax - bot.cargo;
    ctx.log("trade", `ModuleSeller: free cargo ${freeCargo.toFixed(0)}/${bot.cargoMax}`);

    const itemsToSell: Array<{
      itemId: string;
      name: string;
      availableQty: number;
      sellQty: number;
      price: number;
      priceSource: string;
      station: BestStation;
    }> = [];

    for (const storageItem of moduleStorage) {
      const { price, source: priceSource } = computeSellPrice(
        storageItem.itemId,
        settings.priceMode,
        settings.premiumPct,
        settings.undercutCr,
      );

      if (price <= 0) {
        ctx.log("trade", `ModuleSeller: no buy demand for ${storageItem.itemId} — skipping`);
        continue;
      }

      let station: BestStation | null = null;
      if (settings.sellAtHome) {
        const homePoiId = settings.homeStation.includes("|") 
          ? settings.homeStation.split("|")[1] 
          : settings.homeStation;
        station = { systemId: settings.homeSystem, poiId: homePoiId, poiName: "Home" };
      } else {
        station = findBestSellStation(storageItem.itemId);
        if (!station) {
          ctx.log("warn", `ModuleSeller: no valid sell station for ${storageItem.itemId} — skipping`);
          continue;
        }
      }

      const config = settings.moduleItems.find(m => m.itemId === storageItem.itemId);
      let maxSellQty = config ? config.maxQty : settings.maxQtyDefault;
      let qtyToSell = storageItem.quantity;

      if (maxSellQty > 0) {
        qtyToSell = Math.min(qtyToSell, maxSellQty);
      }

      const cargoLimit = maxItemsForCargo(freeCargo, storageItem.itemId);
      qtyToSell = Math.min(qtyToSell, cargoLimit);

      if (qtyToSell <= 0) continue;

      itemsToSell.push({
        itemId: storageItem.itemId,
        name: storageItem.name,
        availableQty: storageItem.quantity,
        sellQty: qtyToSell,
        price,
        priceSource,
        station,
      });
    }

    if (itemsToSell.length === 0) {
      ctx.log("trade", "ModuleSeller: no items to sell this cycle");
      await ctx.sleep(60000);
      continue;
    }

    for (const sellItem of itemsToSell) {
      if (bot.state !== "running") break;
      if (sellItem.sellQty <= 0) continue;

      const targetSystem = sellItem.station.systemId;
      const targetPoi = sellItem.station.poiId;

      if (normalizeSystemId(targetSystem) !== normalizeSystemId(bot.system) || normalizePoiId(targetPoi) !== normalizePoiId(bot.poi)) {
        ctx.log("travel", `ModuleSeller: traveling to ${sellItem.station.poiName} in ${targetSystem}...`);

        if (normalizeSystemId(targetSystem) !== normalizeSystemId(bot.system)) {
          const ok = await navigateToSystem(ctx, targetSystem, { fuelThresholdPct: settings.refuelThreshold, hullThresholdPct: settings.repairThreshold });
          if (!ok) {
            ctx.log("warn", `ModuleSeller: failed to reach ${targetSystem} — skipping ${sellItem.name}`);
            continue;
          }
        }

        const { pois } = await getSystemInfo(ctx);
        const targetStationPoi = pois.find(p => normalizePoiId(p.id) === normalizePoiId(targetPoi));
        if (!targetStationPoi || !targetStationPoi.has_base) {
          ctx.log("warn", `ModuleSeller: target POI ${targetPoi} not found in ${targetSystem} — skipping ${sellItem.name}`);
          continue;
        }

        if (bot.poi !== targetPoi) {
          await ensureUndocked(ctx);
          const travelResp = await bot.exec("travel", { target_poi: targetPoi });
          if (travelResp.error && !travelResp.error.message.includes("already")) {
            ctx.log("warn", `ModuleSeller: travel to ${targetPoi} failed: ${travelResp.error.message} — skipping ${sellItem.name}`);
            continue;
          }
          bot.poi = targetPoi;
        }

        const dockResp = await bot.exec("dock");
        if (dockResp.error && !dockResp.error.message.includes("already")) {
          ctx.log("warn", `ModuleSeller: dock at ${targetPoi} failed: ${dockResp.error.message} — skipping ${sellItem.name}`);
          continue;
        }
        bot.docked = true;

        await tryRefuel(ctx);
        await repairShip(ctx);
      }

      ctx.log("trade", `ModuleSeller: selling ${sellItem.sellQty}x ${sellItem.name} @ ${sellItem.price}cr (${sellItem.priceSource})`);

      const orderResp = await bot.exec("create_sell_order", {
        item_id: sellItem.itemId,
        price_each: sellItem.price,
        quantity: sellItem.sellQty,
      });

      if (orderResp.error) {
        ctx.log("error", `ModuleSeller: sell order failed for ${sellItem.name}: ${orderResp.error.message}`);
        continue;
      }

      ctx.log("trade", `ModuleSeller: sold ${sellItem.sellQty}x ${sellItem.name} @ ${sellItem.price}cr (total: ${(sellItem.sellQty * sellItem.price).toLocaleString()}cr)`);
      logFactionActivity(ctx, "sell", `Sold ${sellItem.sellQty}x ${sellItem.name} @ ${sellItem.price}cr`);
    }

    const returnHome = normalizeSystemId(settings.homeSystem) !== normalizeSystemId(bot.system);
    if (returnHome) {
      ctx.log("travel", "ModuleSeller: returning home...");
      const ok = await navigateToSystem(ctx, settings.homeSystem, { fuelThresholdPct: settings.refuelThreshold, hullThresholdPct: settings.repairThreshold });
      if (!ok) {
        ctx.log("error", "ModuleSeller: failed to return home — will retry next cycle");
      }
    }

    await ctx.sleep(30000);
  }
};

function normalizeSystemId(id: string): string {
  return id.toLowerCase().replace(/[\s-]/g, "_");
}

function normalizePoiId(id: string): string {
  return id.toLowerCase().replace(/[\s-]/g, "_");
}
