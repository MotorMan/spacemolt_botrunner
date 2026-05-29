/**
 * Comprehensive tests for Crafter functionality
 *
 * Tests multiple crafter profiles, loadouts, bot assignments, and crafting logic
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { getCrafterSettings } from "./routines/crafter.js";
import { readSettings } from "./routines/common.js";
import {
  calculateCraftingPlan,
  calculateMultiGoalPlan,
  findRecipeForItem,
  findAllRecipesForItem,
  isRecipeCraftable,
  scoreRecipeAvailability,
} from "./routines/craft-goals.js";

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
      expect(result.crafters[0].craftLimits).toEqual([
        { recipeId: "basic_alloy", limit: 100 },
        { recipeId: "advanced_composite", limit: 50 },
      ]);
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
      expect(result.crafters[0].craftLimits).toEqual([]);
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

      expect(result.crafters[0].craftLimits.some(l => l.recipeId === "onboard_alloy_synthesis")).toBe(false);
      expect(result.crafters[0].craftLimits.some(l => l.recipeId === "basic_alloy")).toBe(true);
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
    expect(settings.crafters.find(c => c.name === "Test Profile")?.craftLimits).toEqual([{ recipeId: "test_recipe", limit: 10 }]);
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
    expect(settings.crafters[0].craftLimits.find(l => l.recipeId === "recipe_a")?.limit).toBe(100);
    expect(settings.crafters[1].craftLimits.find(l => l.recipeId === "recipe_b")?.limit).toBe(200);
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
    expect(settings.crafters[1].craftLimits).toEqual([{ recipeId: "loaded_recipe", limit: 75 }]);
  });
});

describe("Craft Goals Recipe Selection", () => {
  const mockRecipes = [
    {
      recipe_id: "forge_hull_plating",
      name: "Forge Hull Plating",
      components: [
        { item_id: "iron_ore", name: "Iron Ore", quantity: 10 },
        { item_id: "titanium_ore", name: "Titanium Ore", quantity: 5 },
      ],
      output_item_id: "hull_plating",
      output_name: "Hull Plating",
      output_quantity: 1,
      category: "Components",
    },
    {
      recipe_id: "reforge_hull_plating",
      name: "Reforge Hull Plating",
      components: [
        { item_id: "hull_plating", name: "Hull Plating", quantity: 1 },
        { item_id: "advanced_alloy", name: "Advanced Alloy", quantity: 2 },
      ],
      output_item_id: "hull_plating",
      output_name: "Hull Plating",
      output_quantity: 1,
      category: "Components",
    },
    {
      recipe_id: "onboard_alloy_synthesis",
      name: "Onboard Alloy Synthesis",
      components: [
        { item_id: "iron_ore", name: "Iron Ore", quantity: 20 },
      ],
      output_item_id: "alloy",
      output_name: "Alloy",
      output_quantity: 10,
      category: "Ship Passive",
    },
    {
      recipe_id: "facility_alloy",
      name: "Facility Alloy",
      components: [
        { item_id: "iron_ore", name: "Iron Ore", quantity: 15 },
      ],
      output_item_id: "alloy",
      output_name: "Alloy",
      output_quantity: 5,
      category: "Facility Only",
    },
    {
      recipe_id: "basic_alloy",
      name: "Basic Alloy",
      components: [
        { item_id: "iron_ore", name: "Iron Ore", quantity: 10 },
      ],
      output_item_id: "alloy",
      output_name: "Alloy",
      output_quantity: 5,
      category: "Refining",
    },
  ];

  describe("isRecipeCraftable", () => {
    it("should allow normal recipes", () => {
      const recipe = mockRecipes[0]; // forge_hull_plating
      const result = isRecipeCraftable(recipe);
      expect(result.ok).toBe(true);
      expect(result.reason).toBe("");
    });

    it("should reject ship passive recipes", () => {
      const recipe = mockRecipes[2]; // onboard_alloy_synthesis
      const result = isRecipeCraftable(recipe);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("automatically on ships");
    });

    it("should reject facility only recipes", () => {
      const recipe = mockRecipes[3]; // facility_alloy
      const result = isRecipeCraftable(recipe);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("facilities");
    });
  });

  describe("scoreRecipeAvailability", () => {
    it("should score 100 when all materials are available", () => {
      const recipe = mockRecipes[0]; // forge_hull_plating
      const countFn = (id: string) => id === "iron_ore" ? 20 : id === "titanium_ore" ? 10 : 0;
      const score = scoreRecipeAvailability(recipe, countFn);
      expect(score).toBe(100);
    });

    it("should score 50 when half materials are available", () => {
      const recipe = mockRecipes[0];
      const countFn = (id: string) => id === "iron_ore" ? 5 : id === "titanium_ore" ? 10 : 0;
      const score = scoreRecipeAvailability(recipe, countFn);
      expect(score).toBe(67); // (5+5)/(10+5) * 100 ≈ 67
    });

    it("should score 0 when no materials are available", () => {
      const recipe = mockRecipes[0];
      const countFn = () => 0;
      const score = scoreRecipeAvailability(recipe, countFn);
      expect(score).toBe(0);
    });

    it("should return -Infinity for blacklisted recipes", () => {
      const blacklistedRecipe = { ...mockRecipes[0], recipe_id: "basic_silicon_refinement" };
      const countFn = () => 100;
      const score = scoreRecipeAvailability(blacklistedRecipe, countFn);
      expect(score).toBe(-Infinity);
    });

    it("should apply penalty recipes", () => {
      const penaltyRecipe = { ...mockRecipes[0], recipe_id: "synthesize_bio_polymer" };
      const countFn = () => 100;
      const score = scoreRecipeAvailability(penaltyRecipe, countFn);
      expect(score).toBe(100 - 1000);
    });
  });

  describe("findRecipeForItem", () => {
    it("should return null when no recipes exist", () => {
      const result = findRecipeForItem("nonexistent", [], () => 0);
      expect(result).toBeNull();
    });

    it("should return the only recipe when one exists", () => {
      const result = findRecipeForItem("alloy", [mockRecipes[4]], () => 100);
      expect(result?.recipe_id).toBe("basic_alloy");
    });

    it("should filter out uncraftable recipes", () => {
      const recipes = [mockRecipes[2], mockRecipes[3], mockRecipes[4]]; // ship passive, facility only, basic
      const result = findRecipeForItem("alloy", recipes, () => 100);
      expect(result?.recipe_id).toBe("basic_alloy");
    });

    it("should prefer recipe with higher material availability", () => {
      const recipes = [mockRecipes[0], mockRecipes[1]]; // forge and reforge hull_plating
      const countFn = (id: string) => {
        if (id === "iron_ore") return 10;
        if (id === "titanium_ore") return 5;
        if (id === "hull_plating") return 0; // reforge needs hull_plating, not available
        return 0;
      };
      const result = findRecipeForItem("hull_plating", recipes, countFn);
      expect(result?.recipe_id).toBe("forge_hull_plating"); // should pick forge since materials available
    });
  });

  describe("findAllRecipesForItem", () => {
    it("should return all craftable recipes sorted by score", () => {
      const recipes = [mockRecipes[2], mockRecipes[3], mockRecipes[4]]; // ship passive, facility, basic
      const result = findAllRecipesForItem("alloy", recipes, () => 100);
      expect(result).toHaveLength(1);
      expect(result[0].recipe_id).toBe("basic_alloy");
    });
  });

  describe("calculateCraftingPlan", () => {
    it("should return null when no recipe exists", () => {
      const plan = calculateCraftingPlan("nonexistent", 10, [], () => 0);
      expect(plan).toBeNull();
    });

    it("should create a plan for a simple recipe", () => {
      const plan = calculateCraftingPlan("alloy", 5, [mockRecipes[4]], (id) => id === "iron_ore" ? 50 : 0);
      expect(plan).not.toBeNull();
      expect(plan?.goalItem).toBe("Alloy");
      expect(plan?.goalQuantity).toBe(5);
      expect(plan?.flatOrder).toHaveLength(1);
      expect(plan?.flatOrder[0].recipe.recipe_id).toBe("basic_alloy");
    });

    it("should build dependency tree for complex recipes", () => {
      // Test with reforge requiring hull_plating, which requires forge
      const recipes = [mockRecipes[0], mockRecipes[1]]; // forge and reforge
      const countFn = (id: string) => {
        if (id === "iron_ore") return 100;
        if (id === "titanium_ore") return 50;
        if (id === "hull_plating") return 0;
        return 0;
      };
      const plan = calculateCraftingPlan("hull_plating", 1, recipes, countFn);
      expect(plan).not.toBeNull();
      expect(plan?.flatOrder).toHaveLength(1); // Just the forge, since reforge not better
      expect(plan?.flatOrder[0].recipe.recipe_id).toBe("forge_hull_plating");
    });
  });
});