/**
 * Tests for travelToStationWithHint function
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

// Mock side-effect modules to prevent initialization
vi.mock("../src/catalogstore.js", () => ({
  catalogStore: {},
}));

vi.mock("../src/mapstore.js", () => ({
  mapStore: {
    findRoute: vi.fn(),
    getSystem: vi.fn(),
  },
}));

vi.mock("../src/web/server.js", () => ({
  getSystemBlacklist: () => [],
}));

// Import mocked mapStore to configure in tests
import { mapStore } from "../src/mapstore.js";
const mockFindRoute = (mapStore.findRoute as any);
const mockGetSystem = (mapStore.getSystem as any);

// Import function under test
import * as common from "../src/routines/common.js";
const { travelToStationWithHint } = common;

// Mock bot factory
function createMockBot(overrides: Record<string, any> = {}) {
  return {
    system: "first_step",
    poi: "first_step_station",
    docked: false,
    fuel: 100,
    maxFuel: 100,
    hull: 100,
    maxHull: 100,
    state: "running",
    refreshStatus: vi.fn().mockResolvedValue(undefined),
    exec: vi.fn(),
    log: vi.fn(),
    ...overrides,
  };
}

function createMockContext(bot: ReturnType<typeof createMockBot>) {
  return { bot, log: vi.fn() };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: mapStore methods should not be called; throw if they are
  mockFindRoute.mockImplementation(() => { throw new Error("findRoute unexpected"); });
  mockGetSystem.mockImplementation(() => { throw new Error("getSystem unexpected"); });
});

describe("travelToStationWithHint", () => {
  it("should succeed immediately on successful travel", async () => {
    const bot = createMockBot();
    const ctx = createMockContext(bot);

    bot.exec.mockResolvedValueOnce({ error: null, result: {} });

    const result = await travelToStationWithHint(ctx, "mobile_capital", "Mobile Capital", "starfall", {
      fuelThresholdPct: 40,
      hullThresholdPct: 30,
      maxRetries: 3,
    });

    expect(result.success).toBe(true);
    expect(result.usedHint).toBe(false);
    expect(bot.exec).toHaveBeenCalledTimes(1);
    expect(bot.exec).toHaveBeenCalledWith("travel", { target_poi: "mobile_capital", target_system: "starfall" });
  });

  it("should parse Mobile Capital hint, navigate there, then succeed", async () => {
    const hintSystem = "Starfall";
    const errorMsg = "It's called a Mobile Capital for a reason — it's not here right now. Jump to Starfall to find it.";
    const bot = createMockBot({ system: hintSystem }); // already at hint system: navigateToSystem returns immediately
    const ctx = createMockContext(bot);

    bot.exec
      .mockResolvedValueOnce({ error: { message: errorMsg }, notifications: [] }) // initial travel fails
      .mockResolvedValueOnce({ error: null, result: {} }); // second travel succeeds

    const result = await travelToStationWithHint(ctx, "mobile_capital", "Mobile Capital", "the_telescope", {
      fuelThresholdPct: 40,
      hullThresholdPct: 30,
      maxRetries: 3,
    });

    expect(result.success).toBe(true);
    expect(result.usedHint).toBe(true);
    expect(result.hintSystem).toBeUndefined();
    expect(bot.exec).toHaveBeenCalledTimes(2);
    expect(bot.exec).toHaveBeenNthCalledWith(1, "travel", { target_poi: "mobile_capital", target_system: "the_telescope" });
    expect(bot.exec).toHaveBeenNthCalledWith(2, "travel", { target_poi: "mobile_capital", target_system: hintSystem });
  });

  it("should fail when navigation to hint fails", async () => {
    const hintSystem = "Starfall";
    const errorMsg = "It's called a Mobile Capital for a reason — it's not here right now. Jump to Starfall to find it.";
    const bot = createMockBot({ system: "original_system" }); // not at hint system
    const ctx = createMockContext(bot);

    bot.exec
      .mockResolvedValueOnce({ error: { message: errorMsg }, notifications: [] }) // travel fails
      .mockResolvedValueOnce({ error: null, result: { found: false } }); // find_route returns not found

    // Force navigateToSystem to return false by providing no route and no system info
    mockFindRoute.mockReturnValue(null);
    mockGetSystem.mockReturnValue(null);

    const result = await travelToStationWithHint(ctx, "mobile_capital", "Mobile Capital", "the_telescope", {
      fuelThresholdPct: 40,
      hullThresholdPct: 30,
      maxRetries: 3,
    });

    expect(result.success).toBe(false);
    expect(result.usedHint).toBe(true);
    expect(result.hintSystem).toBe(hintSystem);
    expect(bot.exec).toHaveBeenCalledTimes(2);
    expect(bot.exec).toHaveBeenCalledWith("travel", { target_poi: "mobile_capital", target_system: "the_telescope" });
    // navigateToSystem should attempt to find route to the hint system (Starfall)
    expect(bot.exec).toHaveBeenCalledWith("find_route", { target_system: hintSystem });
  });

  it("should retry same target on non-hint errors and succeed", async () => {
    const bot = createMockBot();
    const ctx = createMockContext(bot);

    bot.exec
      .mockResolvedValueOnce({ error: { message: "Travel failed: Temporary" }, notifications: [] })
      .mockResolvedValueOnce({ error: null, result: {} });

    const result = await travelToStationWithHint(ctx, "station", "Station", "system", {
      fuelThresholdPct: 40,
      hullThresholdPct: 30,
      maxRetries: 3,
    });

    expect(result.success).toBe(true);
    expect(result.usedHint).toBe(false);
    expect(bot.exec).toHaveBeenCalledTimes(2);
    expect(bot.exec).toHaveBeenNthCalledWith(1, "travel", { target_poi: "station", target_system: "system" });
    expect(bot.exec).toHaveBeenNthCalledWith(2, "travel", { target_poi: "station", target_system: "system" });
  });

  it("should use provided hint after first failure without parsing", async () => {
    const hintSystem = "Starfall";
    const bot = createMockBot({ system: hintSystem }); // already at hint system
    const ctx = createMockContext(bot);

    bot.exec
      .mockResolvedValueOnce({ error: { message: "Some other error" }, notifications: [] })
      .mockResolvedValueOnce({ error: null, result: {} });

    const result = await travelToStationWithHint(ctx, "mobile_capital", "Mobile Capital", "orig_system", {
      fuelThresholdPct: 40,
      hullThresholdPct: 30,
      hint: hintSystem,
      maxRetries: 3,
    });

    expect(result.success).toBe(true);
    expect(result.usedHint).toBe(false);
    expect(result.hintSystem).toBeUndefined();
    expect(bot.exec).toHaveBeenCalledTimes(2);
    expect(bot.exec).toHaveBeenNthCalledWith(1, "travel", { target_poi: "mobile_capital", target_system: "orig_system" });
    expect(bot.exec).toHaveBeenNthCalledWith(2, "travel", { target_poi: "mobile_capital", target_system: hintSystem });
  });

  it("should fail after exhausting retries with no hint", async () => {
    const bot = createMockBot();
    const ctx = createMockContext(bot);

    bot.exec.mockResolvedValue({ error: { message: "Persistent error" }, notifications: [] });

    const result = await travelToStationWithHint(ctx, "s", "S", "sys", {
      fuelThresholdPct: 40,
      hullThresholdPct: 30,
      maxRetries: 2,
    });

    expect(result.success).toBe(false);
    expect(result.usedHint).toBe(false);
    expect(bot.exec).toHaveBeenCalledTimes(2);
  });
});
