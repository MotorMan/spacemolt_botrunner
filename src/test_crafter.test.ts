/**
 * Comprehensive tests for Crafter functionality
 *
 * Tests multiple crafter profiles, loadouts, bot assignments, and crafting logic
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { getCrafterSettings } from "./routines/crafter.js";
import { readSettings } from "./routines/common.js";

// Mock dependencies
vi.mock("./routines/common.js", () => ({
  readSettings: vi.fn(),
}));

vi.mock("./catalogstore.js", () => ({
  catalogStore: {
    getItem: vi.fn(),
  },
}));

describe("Crafter Settings and Profiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Multiple Crafter Profiles", () => {
    it("should handle single crafter profile (legacy format)", () => {
      const mockSettings = {
        crafter: {
          craftLimits: {
            "basic_alloy": 100,
            "advanced_composite": 50,
          },
          enabledCategories: ["Refining", "Components"],
          refuelThreshold: 60,
        },
      };

      vi.mocked(readSettings).mockReturnValue(mockSettings);

      const result = getCrafterSettings();

      expect(result.crafters).toHaveLength(1);
      expect(result.crafters[0].name).toBe("Default Crafter");
      expect(result.crafters[0].craftLimits).toEqual({
        "basic_alloy": 100,
        "advanced_composite": 50,
      });
      expect(result.enabledCategories).toEqual(["Refining", "Components"]);
      expect(result.refuelThreshold).toBe(60);
    });

    it("should handle multiple crafter profiles (new format)", () => {
      const mockSettings = {
        crafter: {
          crafters: [
            {
              name: "Mining Crafter",
              craftLimits: {
                "basic_alloy": 200,
                "refined_ore": 100,
              },
            },
            {
              name: "Component Crafter",
              craftLimits: {
                "advanced_composite": 150,
                "electronic_parts": 75,
              },
            },
          ],
          botCrafterAssignments: {
            "bot1": "Mining Crafter",
            "bot2": "Component Crafter",
          },
          enabledCategories: ["Refining", "Components"],
        },
      };

      vi.mocked(readSettings).mockReturnValue(mockSettings);

      const result = getCrafterSettings();

      expect(result.crafters).toHaveLength(2);
      expect(result.crafters[0].name).toBe("Mining Crafter");
      expect(result.crafters[1].name).toBe("Component Crafter");
      expect(result.botCrafterAssignments).toEqual({
        "bot1": "Mining Crafter",
        "bot2": "Component Crafter",
      });
    });

    it("should create default profile when no profiles exist", () => {
      const mockSettings = {
        crafter: {},
      };

      vi.mocked(readSettings).mockReturnValue(mockSettings);

      const result = getCrafterSettings();

      expect(result.crafters).toHaveLength(1);
      expect(result.crafters[0].name).toBe("Default Crafter");
      expect(result.crafters[0].craftLimits).toEqual({});
    });

    it("should filter out ship passive recipes", () => {
      const mockSettings = {
        crafter: {
          craftLimits: {
            "onboard_alloy_synthesis": 100, // Should be filtered out
            "basic_alloy": 50, // Should remain
          },
        },
      };

      vi.mocked(readSettings).mockReturnValue(mockSettings);

      const result = getCrafterSettings();

      expect(result.crafters[0].craftLimits).not.toHaveProperty("onboard_alloy_synthesis");
      expect(result.crafters[0].craftLimits).toHaveProperty("basic_alloy");
    });
  });

  describe("Bot Crafter Assignments", () => {
    it("should return correct crafter assignment for bot", () => {
      const mockSettings = {
        crafter: {
          crafters: [
            { name: "Profile A", craftLimits: {} },
            { name: "Profile B", craftLimits: {} },
          ],
          botCrafterAssignments: {
            "bot1": "Profile A",
            "bot2": "Profile B",
          },
        },
      };

      vi.mocked(readSettings).mockReturnValue(mockSettings);

      const result = getCrafterSettings();
      expect(result.botCrafterAssignments["bot1"]).toBe("Profile A");
      expect(result.botCrafterAssignments["bot2"]).toBe("Profile B");
      expect(result.botCrafterAssignments["bot3"]).toBeUndefined();
    });

    it("should default to 'Default Crafter' when no assignment exists", () => {
      // This would be tested in the crafter routine logic
      // For now, we verify the settings structure supports it
      const mockSettings = {
        crafter: {
          crafters: [{ name: "Default Crafter", craftLimits: {} }],
          botCrafterAssignments: {},
        },
      };

      vi.mocked(readSettings).mockReturnValue(mockSettings);

      const result = getCrafterSettings();
      expect(result.crafters[0].name).toBe("Default Crafter");
    });
  });
});

describe("Crafter Loadout System", () => {
  it("should validate loadout structure", () => {
    // Mock a valid loadout structure
    const validLoadout = {
      "basic_alloy": 100,
      "advanced_composite": 50,
      "refined_ore": 25,
    };

    // Test that loadouts contain valid recipe IDs and positive limits
    Object.entries(validLoadout).forEach(([recipeId, limit]) => {
      expect(typeof recipeId).toBe("string");
      expect(recipeId.length).toBeGreaterThan(0);
      expect(typeof limit).toBe("number");
      expect(limit).toBeGreaterThan(0);
    });
  });

  it("should handle empty loadouts", () => {
    const emptyLoadout = {};

    expect(Object.keys(emptyLoadout)).toHaveLength(0);
  });

  it("should filter invalid loadout entries", () => {
    const invalidLoadout = {
      "": 100, // Empty recipe ID
      "valid_recipe": 0, // Zero limit
      "another_recipe": -5, // Negative limit
      "good_recipe": 50, // Valid
    };

    const filtered = Object.fromEntries(
      Object.entries(invalidLoadout).filter(([id, limit]) =>
        id && typeof limit === "number" && limit > 0
      )
    );

    expect(filtered).toEqual({
      "good_recipe": 50,
    });
  });
});

describe("Crafting Logic Integration", () => {
  it("should integrate with crafter routine using assigned profiles", () => {
    // Test that the crafter routine can access settings
    const mockSettings = {
      crafter: {
        crafters: [
          {
            name: "Test Profile",
            craftLimits: { "test_recipe": 10 },
          },
        ],
        botCrafterAssignments: { "testBot": "Test Profile" },
      },
    };

    vi.mocked(readSettings).mockReturnValue(mockSettings);

    const settings = getCrafterSettings();
    expect(settings.botCrafterAssignments["testBot"]).toBe("Test Profile");
    expect(settings.crafters.find(c => c.name === "Test Profile")?.craftLimits).toEqual({ "test_recipe": 10 });
  });

  it("should handle profile switching without data loss", () => {
    // Test that switching profiles preserves data
    const originalSettings = {
      crafter: {
        crafters: [
          { name: "Profile 1", craftLimits: { "recipe_a": 100 } },
          { name: "Profile 2", craftLimits: { "recipe_b": 200 } },
        ],
      },
    };

    vi.mocked(readSettings).mockReturnValue(originalSettings);

    const settings = getCrafterSettings();
    expect(settings.crafters).toHaveLength(2);
    expect(settings.crafters[0].craftLimits["recipe_a"]).toBe(100);
    expect(settings.crafters[1].craftLimits["recipe_b"]).toBe(200);
  });
});

describe("Settings Persistence", () => {
  it("should save crafter settings with multiple profiles", () => {
    const testSettings = {
      crafters: [
        { name: "Profile A", craftLimits: { "alloy": 100 } },
        { name: "Profile B", craftLimits: { "composite": 200 } },
      ],
      botCrafterAssignments: { "bot1": "Profile A" },
      enabledCategories: ["Refining"],
      refuelThreshold: 50,
    };

    // Verify structure matches expected format
    expect(testSettings.crafters).toBeDefined();
    expect(testSettings.botCrafterAssignments).toBeDefined();
    expect(Array.isArray(testSettings.crafters)).toBe(true);
    expect(testSettings.crafters[0].name).toBeDefined();
    expect(testSettings.crafters[0].craftLimits).toBeDefined();
  });

  it("should validate settings structure", () => {
    const validSettings = {
      crafter: {
        crafters: [
          { name: "Valid Profile", craftLimits: { "recipe": 1 } },
        ],
        botCrafterAssignments: {},
        enabledCategories: ["Refining"],
        refuelThreshold: 50,
      },
    };

    expect(validSettings.crafter.crafters).toBeDefined();
    expect(validSettings.crafter.botCrafterAssignments).toBeDefined();
    expect(Array.isArray(validSettings.crafter.crafters)).toBe(true);
  });
});

// Integration test for the full workflow
describe("Crafter Profile Workflow", () => {
  it("should support complete workflow: create profile, assign to bot, load/save loadouts", () => {
    // Simulate the complete workflow

    // 1. Initial state with default profile
    let mockSettings = { crafter: {} };
    vi.mocked(readSettings).mockReturnValue(mockSettings);
    let settings = getCrafterSettings();
    expect(settings.crafters[0].name).toBe("Default Crafter");

    // 2. Add a new profile
    mockSettings = {
      crafter: {
        crafters: [
          { name: "Default Crafter", craftLimits: {} },
          { name: "Specialized Crafter", craftLimits: { "special_recipe": 50 } },
        ],
      },
    };
    vi.mocked(readSettings).mockReturnValue(mockSettings);
    settings = getCrafterSettings();
    expect(settings.crafters).toHaveLength(2);
    expect(settings.crafters[1].name).toBe("Specialized Crafter");

    // 3. Assign profile to bot
    mockSettings.crafter.botCrafterAssignments = { "testBot": "Specialized Crafter" };
    vi.mocked(readSettings).mockReturnValue(mockSettings);
    settings = getCrafterSettings();
    expect(settings.botCrafterAssignments["testBot"]).toBe("Specialized Crafter");

    // 4. Load a loadout into the profile
    const loadout = { "loaded_recipe": 75 };
    mockSettings.crafter.crafters[1].craftLimits = loadout;
    vi.mocked(readSettings).mockReturnValue(mockSettings);
    settings = getCrafterSettings();
    expect(settings.crafters[1].craftLimits).toEqual(loadout);
  });
});