import { describe, it, expect, vi } from "vitest";

// common.ts (imported by craft-goals.ts) reaches into the dashboard server for
// blacklists; stub it so the module can be imported in isolation.
vi.mock("../src/web/server.js", () => ({
  getSystemBlacklist: () => [],
  getStationBlacklist: () => [],
  isCustomsDisabled: () => true,
}));

import { settingsGoalSignature } from "../src/routines/craft-goals.js";

// Minimal type mirroring CrafterSettings for test data construction.
type Settings = {
  crafters: Array<{ name: string; craftLimits: unknown; recipeTriggers?: unknown }>;
  botCrafterAssignments: Record<string, string>;
  enabledCategories: string[];
  refuelThreshold: number;
  repairThreshold: number;
  categoryAssignments: Record<string, string[]>;
  botQuotaOverrides: Record<string, Record<string, number>>;
  goalProcessingMode: string;
  autoBuy: { enabled: boolean; maxPricePercentOverBase: number; maxCreditsPerCycle: number; excludeCategories: string[] };
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
};

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    crafters: [{ name: "Default Crafter", craftLimits: [], recipeTriggers: {} }],
    botCrafterAssignments: {},
    enabledCategories: ["Refining", "Components", "Consumables"],
    refuelThreshold: 50,
    repairThreshold: 40,
    categoryAssignments: {},
    botQuotaOverrides: {},
    goalProcessingMode: "batch",
    autoBuy: {
      enabled: false,
      maxPricePercentOverBase: 150,
      maxCreditsPerCycle: 50000,
      excludeCategories: ["ammo"],
    },
    blacklistedRecipes: [],
    useQueuedCrafting: true,
    craftingPreset: "fast",
    finalItemThreshold: 1,
    allowExternalFacilities: false,
    forceOwnFacility: true,
    noFacilityFallback: "auto",
    allowRentalPurchase: false,
    rentalSpendingLimit: 0,
    cycleTimeSec: 30,
    craftingHomeBase: "",
    recipeFacilityLinks: {},
    ...overrides,
  };
}

describe("settingsGoalSignature", () => {
  it("returns a string for null settings", () => {
    expect(settingsGoalSignature(null)).toBe("null");
  });

  it("produces the same signature for identical settings", () => {
    const a = makeSettings();
    const b = makeSettings();
    expect(settingsGoalSignature(a)).toBe(settingsGoalSignature(b));
  });

  it("detects craftLimits changes (the core regression)", () => {
    const before = makeSettings({
      crafters: [
        { name: "Crafter", craftLimits: [{ recipeId: "fuel_reserve", limit: 275000 }] },
      ],
    });
    const after = makeSettings({
      crafters: [
        { name: "Crafter", craftLimits: [{ recipeId: "fuel_reserve", limit: 200 }] },
      ],
    });
    expect(settingsGoalSignature(before)).not.toBe(settingsGoalSignature(after));
  });

  it("detects recipeTriggers changes", () => {
    const before = makeSettings({
      crafters: [
        { name: "Crafter", craftLimits: [], recipeTriggers: {} },
      ],
    });
    const after = makeSettings({
      crafters: [
        {
          name: "Crafter",
          craftLimits: [],
          recipeTriggers: {
            "forge_steel": { materials: [{ item: "iron_ore", triggerAt: 1000, stopAt: 500 }], maxOutput: 10000 },
          },
        },
      ],
    });
    expect(settingsGoalSignature(before)).not.toBe(settingsGoalSignature(after));
  });

  it("detects recipeFacilityLinks changes", () => {
    const before = makeSettings({ recipeFacilityLinks: {} });
    const after = makeSettings({ recipeFacilityLinks: { "breed_plutonium": ["breeder_reactor_core"] } });
    expect(settingsGoalSignature(before)).not.toBe(settingsGoalSignature(after));
  });

  it("detects craftingHomeBase changes", () => {
    const before = makeSettings({ craftingHomeBase: "@current" });
    const after = makeSettings({ craftingHomeBase: "some-station-id" });
    expect(settingsGoalSignature(before)).not.toBe(settingsGoalSignature(after));
  });

  it("detects botQuotaOverrides changes", () => {
    const before = makeSettings({ botQuotaOverrides: {} });
    const after = makeSettings({ botQuotaOverrides: { "bot1": { "steel_plate": 1000 } } });
    expect(settingsGoalSignature(before)).not.toBe(settingsGoalSignature(after));
  });

  it("does NOT detect non-goal setting changes (preset, cycleTime)", () => {
    const before = makeSettings({ craftingPreset: "fast", cycleTimeSec: 30 });
    const after = makeSettings({ craftingPreset: "slow", cycleTimeSec: 60 });
    expect(settingsGoalSignature(before)).toBe(settingsGoalSignature(after));
  });

  it("handles crafter ordering differences as changes", () => {
    const before = makeSettings({
      crafters: [
        { name: "A", craftLimits: [{ recipeId: "recipe_1", limit: 10 }] },
        { name: "B", craftLimits: [{ recipeId: "recipe_2", limit: 20 }] },
      ],
    });
    const after = makeSettings({
      crafters: [
        { name: "A", craftLimits: [{ recipeId: "recipe_1", limit: 10 }] },
        { name: "B", craftLimits: [{ recipeId: "recipe_2", limit: 21 }] },
      ],
    });
    expect(settingsGoalSignature(before)).not.toBe(settingsGoalSignature(after));
  });

  it("detects forceOwnFacility changes", () => {
    const before = makeSettings({ forceOwnFacility: true });
    const after = makeSettings({ forceOwnFacility: false });
    expect(settingsGoalSignature(before)).not.toBe(settingsGoalSignature(after));
  });
});
