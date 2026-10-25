import { describe, test, expect, vi, beforeEach } from "vitest";

// common.ts reaches into the dashboard server for blacklists; stub it so the
// module can be imported in isolation.
vi.mock("../src/web/server.js", () => ({
  getSystemBlacklist: () => [],
  getStationBlacklist: () => [],
  isCustomsDisabled: () => true,
}));

import {
  getFuelCellFuelValue,
  isFuelCellItem,
  getCargoFuelCells,
  ensureFuelCellReserve,
  readPurchaseEstimate,
} from "../src/routines/common.js";

interface FakeItem {
  itemId: string;
  name: string;
  quantity: number;
}

function makeCtx(opts: {
  inventory?: FakeItem[];
  factionStorage?: FakeItem[];
  storage?: FakeItem[];
  cargoMax?: number;
  credits?: number;
  exec?: (command: string, payload?: Record<string, unknown>) => Promise<any>;
}) {
  const calls: Array<{ command: string; payload?: Record<string, unknown> }> = [];
  const bot: any = {
    username: "TestBot",
    system: "arneb",
    poi: "the_obsidian_well",
    docked: true,
    credits: opts.credits ?? 1_000_000,
    cargoMax: opts.cargoMax ?? 100,
    cargo: 0,
    fuel: 100,
    maxFuel: 100,
    inventory: opts.inventory ?? [],
    factionStorage: opts.factionStorage ?? [],
    storage: opts.storage ?? [],
    state: "running",
    refreshCargo: async () => {},
    refreshStatus: async () => {},
    refreshStorage: async () => {},
    refreshFactionStorage: async () => {},
    exec: async (command: string, payload?: Record<string, unknown>) => {
      calls.push({ command, payload });
      if (opts.exec) return opts.exec(command, payload);
      return { result: {}, error: undefined, notifications: [] };
    },
  };
  const logs: string[] = [];
  const ctx: any = {
    bot,
    log: (_cat: string, msg: string) => logs.push(msg),
    sleep: async () => {},
  };
  return { ctx, bot, calls, logs };
}

describe("fuel cell accounting", () => {
  test("a cell is valued by the fuel it restores, not by its count", () => {
    expect(getFuelCellFuelValue("military_fuel_cell")).toBe(100);
    expect(getFuelCellFuelValue("premium_fuel_cell")).toBe(50);
    expect(getFuelCellFuelValue("fuel_cell")).toBe(20);
  });

  test("items that merely contain 'fuel' in the id are not fuel cells", () => {
    // The old `itemId.includes("fuel")` test counted all of these as fuel.
    expect(isFuelCellItem("fusion_fuel_rod")).toBe(false);
    expect(isFuelCellItem("reactor_fuel_assembly")).toBe(false);
    expect(isFuelCellItem("fuel_tank")).toBe(false);
    expect(isFuelCellItem("military_fuel_cell")).toBe(true);
  });

  test("3x military_fuel_cell is reported as 300 fuel", () => {
    const { bot } = makeCtx({
      inventory: [{ itemId: "military_fuel_cell", name: "Military Fuel Cell", quantity: 3 }],
    });
    const cells = getCargoFuelCells(bot);
    expect(cells.cells).toBe(3);
    expect(cells.fuel).toBe(300);
    expect(cells.summary).toContain("300 fuel");
  });
});

describe("ensureFuelCellReserve", () => {
  test("does not buy anything when the carried cells already cover the trip", async () => {
    // The exact regression: 3 military cells (300 fuel) aboard, a 27-jump route
    // needing ~270 fuel. The old count-based check saw "3 cells, need 7" and
    // bought plain fuel_cells at market prices.
    const { ctx, calls } = makeCtx({
      inventory: [{ itemId: "military_fuel_cell", name: "Military Fuel Cell", quantity: 3 }],
    });
    const res = await ensureFuelCellReserve(ctx, { fuelNeeded: 270, reason: "27-jump route" });
    expect(res.ok).toBe(true);
    expect(res.fuel).toBe(300);
    expect(res.spent).toBe(0);
    expect(calls.filter((c) => c.command === "buy")).toHaveLength(0);
  });

  test("prefers free faction-storage cells over buying", async () => {
    const inventory: FakeItem[] = [];
    const { ctx, calls } = makeCtx({
      inventory,
      factionStorage: [{ itemId: "military_fuel_cell", name: "Military Fuel Cell", quantity: 10 }],
      exec: async (command, payload) => {
        if (command === "storage" && payload?.action === "withdraw") {
          inventory.push({
            itemId: String(payload.item_id),
            name: "Military Fuel Cell",
            quantity: Number(payload.quantity),
          });
        }
        return { result: {}, error: undefined, notifications: [] };
      },
    });
    const res = await ensureFuelCellReserve(ctx, { fuelNeeded: 200 });
    expect(res.ok).toBe(true);
    expect(res.spent).toBe(0);
    expect(calls.some((c) => c.command === "storage" && c.payload?.target === "faction")).toBe(true);
    expect(calls.filter((c) => c.command === "buy")).toHaveLength(0);
  });

  test("refuses to buy fuel cells priced far above their fuel value", async () => {
    const { ctx, calls, logs } = makeCtx({
      exec: async (command, payload) => {
        if (command === "get_system") {
          return {
            result: {
              id: "arneb",
              pois: [{ id: "the_obsidian_well", name: "The Obsidian Well", type: "station", has_base: true, services: ["market"] }],
            },
            error: undefined,
            notifications: [],
          };
        }
        if (command === "estimate_purchase") {
          // 20 000cr for a 20-fuel plain cell = 1000cr per point of fuel.
          const qty = Number(payload?.quantity) || 1;
          return { result: { available: qty, total_cost: 20_000 * qty }, error: undefined, notifications: [] };
        }
        return { result: {}, error: undefined, notifications: [] };
      },
    });
    const res = await ensureFuelCellReserve(ctx, { fuelNeeded: 100, maxCreditsPerFuel: 25 });
    expect(res.ok).toBe(false);
    expect(res.spent).toBe(0);
    expect(calls.filter((c) => c.command === "buy")).toHaveLength(0);
    expect(logs.some((l) => l.includes("Refusing to buy"))).toBe(true);
  });

  test("skips the buy entirely when the station reports nothing for sale", async () => {
    const { ctx, calls, logs } = makeCtx({
      exec: async (command) => {
        if (command === "get_system") {
          return {
            result: {
              id: "arneb",
              pois: [{ id: "the_obsidian_well", name: "The Obsidian Well", type: "station", has_base: true, services: ["market"] }],
            },
            error: undefined,
            notifications: [],
          };
        }
        if (command === "estimate_purchase") {
          return {
            result: { available: 0, unfilled: 5, fills: [], message: "No one is selling Fuel Cell at this station." },
            error: undefined,
            notifications: [],
          };
        }
        return { result: {}, error: undefined, notifications: [] };
      },
    });
    await ensureFuelCellReserve(ctx, { fuelNeeded: 100 });
    // The station was asked (estimate_purchase) but never blindly bought from,
    // so this cannot surface as a red item_not_available error any more.
    expect(calls.some((c) => c.command === "estimate_purchase")).toBe(true);
    expect(calls.filter((c) => c.command === "buy")).toHaveLength(0);
    expect(logs.some((l) => l.includes("No one is selling"))).toBe(true);
  });
});

describe("readPurchaseEstimate", () => {
  test("treats a no-seller reply as zero availability instead of success", () => {
    const parsed = readPurchaseEstimate({
      available: 0,
      unfilled: 1,
      fills: [],
      message: "No one is selling Capital Armor Plate at this station.",
      total_cost: 0,
    });
    expect(parsed.available).toBe(0);
    expect(parsed.unfilled).toBe(1);
    expect(parsed.message).toContain("No one is selling");
  });

  test("surfaces the counterparties we would be buying from", () => {
    const parsed = readPurchaseEstimate({
      available: 2,
      unfilled: 0,
      total_cost: 19_280,
      fills: [
        { counterparty: "SomeTrader", price_each: 9640, quantity: 1, subtotal: 9640 },
        { counterparty: "SomeTrader", price_each: 9640, quantity: 1, subtotal: 9640 },
      ],
    });
    expect(parsed.available).toBe(2);
    expect(parsed.totalCost).toBe(19_280);
    expect(parsed.counterparties).toEqual(["SomeTrader"]);
  });
});
