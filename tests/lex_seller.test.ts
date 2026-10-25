// tests/lex_seller.test.ts
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/routines/common", () => ({
  ensureDocked: vi.fn(),
  ensureUndocked: vi.fn(),
  tryRefuel: vi.fn(),
  repairShip: vi.fn(),
  ensureFueled: vi.fn(),
  navigateToSystem: vi.fn(),
  detectAndRecoverFromDeath: vi.fn(),
  maxItemsForCargo: vi.fn(),
  readSettings: vi.fn(),
  checkAndFleeFromBattle: vi.fn(),
}));

vi.mock("../src/client_sync_hooks", () => ({
  queryRemoteMarket: vi.fn(),
}));

vi.mock("../src/catalogstore", () => ({
  catalogStore: { getItem: vi.fn() },
}));

import {
  computeDesiredAsk,
  reconcileOrders,
  parseOrders,
  type LexOrder,
  type LexDesiredItem,
} from "../src/routines/lex_seller";

describe("lex_seller pure helpers", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.resetAllMocks());

  describe("parseOrders", () => {
    test("returns sell orders with mapped fields", () => {
      const result = {
        result: {
          orders: [
            { order_id: "o1", item_id: "fuel_cell", side: "sell", quantity: 10, remaining: 7, filled_quantity: 3, price_each: 42, created_at: "t1" },
            { order_id: "o2", item_id: "ore", side: "buy", quantity: 5, remaining: 5, filled_quantity: 0, price_each: 1, created_at: "t2" },
          ],
        },
      };
      const orders = parseOrders(result);
      expect(orders).toHaveLength(1);
      expect(orders[0]).toMatchObject({ orderId: "o1", itemId: "fuel_cell", quantity: 10, remaining: 7, filledQuantity: 3, priceEach: 42 });
    });

    test("returns [] on error / no result", () => {
      expect(parseOrders({ error: { message: "x" } })).toEqual([]);
      expect(parseOrders({})).toEqual([]);
      expect(parseOrders(null)).toEqual([]);
    });
  });

  describe("computeDesiredAsk", () => {
    const band = { autoMin: 30, autoMax: 60, globalMinPrice: 0 };

    test("manual price wins when autoPrice off", () => {
      const md = { items: [{ item_id: "x", best_buy: 50, best_sell: 55 }] };
      expect(computeDesiredAsk(md, { itemId: "x", askPrice: 99, autoPrice: false }, band)).toBe(99);
    });

    test("midpoint used when inside band", () => {
      const md = { items: [{ item_id: "x", best_buy: 40, best_sell: 60 }] };
      expect(computeDesiredAsk(md, { itemId: "x", askPrice: 0, autoPrice: true }, band)).toBe(50);
    });

    test("falls back to globalMinPrice when market out of band", () => {
      const md = { items: [{ item_id: "x", best_buy: 5, best_sell: 5 }] };
      expect(computeDesiredAsk(md, { itemId: "x", askPrice: 0, autoPrice: true }, band)).toBe(0);
    });

    test("falls back to manual when no market data", () => {
      expect(computeDesiredAsk(null, { itemId: "x", askPrice: 12, autoPrice: true }, band)).toBe(12);
    });
  });

  describe("reconcileOrders", () => {
    const mkDesired = (over: Partial<LexDesiredItem>): LexDesiredItem => ({
      itemId: "fuel_cell",
      source: "faction",
      qtyAvailable: 100,
      desiredAsk: 50,
      floor: 10,
      bestBuy: 55,
      ...over,
    });

    test("lists when no current order and units available", () => {
      const actions = reconcileOrders([], [mkDesired({})]);
      expect(actions).toEqual([{ kind: "list", itemId: "fuel_cell", source: "faction", qty: 100, price: 50 }]);
    });

    test("does nothing when no current order and no units", () => {
      const actions = reconcileOrders([], [mkDesired({ qtyAvailable: 0 })]);
      expect(actions).toEqual([]);
    });

    test("appends when price matches and more units available", () => {
      const cur: LexOrder[] = [{ orderId: "o1", itemId: "fuel_cell", quantity: 40, remaining: 40, filledQuantity: 0, priceEach: 50, createdAt: "t" }];
      const actions = reconcileOrders(cur, [mkDesired({ qtyAvailable: 100 })]);
      expect(actions).toEqual([{ kind: "append", itemId: "fuel_cell", source: "faction", qty: 60, price: 50 }]);
    });

    test("repricerem when price differs", () => {
      const cur: LexOrder[] = [{ orderId: "o1", itemId: "fuel_cell", quantity: 40, remaining: 30, filledQuantity: 10, priceEach: 45, createdAt: "t" }];
      const actions = reconcileOrders(cur, [mkDesired({ desiredAsk: 50, qtyAvailable: 40 })]);
      expect(actions).toEqual([{ kind: "repricerem", itemId: "fuel_cell", source: "faction", orderId: "o1", price: 50, qty: 40 }]);
    });

    test("cancels when market best-buy drops below floor", () => {
      const cur: LexOrder[] = [{ orderId: "o1", itemId: "fuel_cell", quantity: 40, remaining: 40, filledQuantity: 0, priceEach: 50, createdAt: "t" }];
      const actions = reconcileOrders(cur, [mkDesired({ floor: 40, bestBuy: 20 })]);
      expect(actions).toEqual([{ kind: "cancel", itemId: "fuel_cell", orderId: "o1" }]);
    });

    test("no action when price matches and no extra units", () => {
      const cur: LexOrder[] = [{ orderId: "o1", itemId: "fuel_cell", quantity: 40, remaining: 40, filledQuantity: 0, priceEach: 50, createdAt: "t" }];
      const actions = reconcileOrders(cur, [mkDesired({ qtyAvailable: 40 })]);
      expect(actions).toEqual([]);
    });
  });
});
