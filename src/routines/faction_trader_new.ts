/**
 * Faction Trader routine — liquidates items from faction storage.
 *
 * Unlike the full trader, this routine never buys from markets.
 * It withdraws items from faction storage and sells them at the
 * best known buyer station, then returns home.
 */
import type { Bot, Routine, RoutineContext } from "../bot.js";
import { mapStore } from "../mapstore.js";
import { catalogStore } from "../catalogstore.js";
import { getSystemBlacklist } from "../web/server.js";
import { clearFactionStorageCache } from "../factionStorageCache.js";
import {
  ensureDocked,
  ensureUndocked,
  tryRefuel,
  repairShip,
  ensureFueled,
  navigateToSystem,
  recordMarketData,
  factionDonateProfit,
  logFactionActivity,
  detectAndRecoverFromDeath,
  maxItemsForCargo,
  readSettings,
  writeSettings,
  isPirateSystem,
  checkAndFleeFromBattle,
  checkBattleAfterCommand,
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
import {
  getBuyOrderLock,
  acquireBuyOrderLock,
  releaseBuyOrderLock,
  cleanupStaleFactionLocks,
  getBuyOrderKey,
} from "./factionTraderCoordination.js";
import {
  type BattleState,
  handleBattleNotifications,
  getBattleStatus,
  fleeFromBattle,
} from "./common.js";
import { parseFactionStorageFromV2 } from "./factionStorageV2.js";

// ── Settings ─────────────────────────────────────────

interface TradeItemConfig {
  itemId: string;
  maxSellQty: number;  // 0 = sell all available
  minSellPrice: number; // 0 = use global minSellPrice
  soldQty?: number;     // Track quantity sold (persisted in settings)
}
