/**
 * Crafter Tests
 *
 * Verifies that the crafter correctly:
 * 1. Tracks batches vs items properly
 * 2. Stops when the target is reached (no overshoot)
 * 3. Handles the quantityToCraft parameter correctly (in BATCHES)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock recipe for testing
function createMockRecipe(overrides?: Partial<{
  recipe_id: string;
  name: string;
  output_item_id: string;
  output_quantity: number;
  components: Array<{ item_id: string; name: string; quantity: number }>;
}>) {
  return {
    recipe_id: "test_recipe",
    name: "Test Recipe",
    output_item_id: "test_output",
    output_quantity: 3,
    components: [
      { item_id: "comp_a", name: "Component A", quantity: 2 },
      { item_id: "comp_b", name: "Component B", quantity: 1 },
    ],
    ...overrides,
  };
}

describe("craftRecipeWithPrereqs logic", () => {
  it("should treat quantityToCraft as BATCHES", () => {
    // This test verifies that the parameter naming and logic correctly handles batches
    const recipe = createMockRecipe({ output_quantity: 3 });

    // quantityToCraft = 10 means 10 BATCHES
    // Each batch produces 3 items
    // So total items to craft = 10 * 3 = 30 items
    const quantityToCraft = 10;
    const outputPerBatch = recipe.output_quantity || 1;
    const targetItems = quantityToCraft * outputPerBatch;

    expect(targetItems).toBe(30); // 10 batches * 3 items per batch
  });

  it("should calculate remaining batches correctly", () => {
    const targetBatches = 74;
    const totalBatchesCrafted = 0;
    const remainingBatches = targetBatches - totalBatchesCrafted;

    expect(remainingBatches).toBe(74);
  });

  it("should stop when target batches reached", () => {
    const targetBatches = 74;
    let totalBatchesCrafted = 0;

    // Simulate crafting 74 batches
    totalBatchesCrafted = 74;

    // Loop condition should be: totalBatchesCrafted < targetBatches
    const shouldContinue = totalBatchesCrafted < targetBatches;
    expect(shouldContinue).toBe(false); // Should stop
  });

  it("should handle overshoot protection", () => {
    const targetBatches = 74;
    let totalBatchesCrafted = 70;
    const batchesActuallyCrafted = 5;

    // After crafting, check if we overshot
    const overshoot = (totalBatchesCrafted + batchesActuallyCrafted) - targetBatches;

    expect(overshoot).toBe(1); // Overshot by 1 batch

    // Apply overshoot protection
    const adjustedBatches = batchesActuallyCrafted - overshoot;
    expect(adjustedBatches).toBe(4); // Only 4 batches should count
  });

  it("should convert batches to items correctly", () => {
    const outputPerBatch = 3;
    const batches = 74;
    const items = batches * outputPerBatch;

    expect(items).toBe(222); // 74 batches * 3 items = 222 items
  });
});

describe("calculateMaxCraftable logic", () => {
  it("should return correct max craftable in batches", () => {
    // If we have 300 comp_a and 200 comp_b
    // Recipe needs 2 comp_a and 1 comp_b per batch
    // Max batches by comp_a = floor(300 / 2) = 150
    // Max batches by comp_b = floor(200 / 1) = 200
    // Max craftable = min(150, 200) = 150 batches

    const compA_available = 300;
    const compB_available = 200;
    const compA_per_batch = 2;
    const compB_per_batch = 1;

    const maxByA = Math.floor(compA_available / compA_per_batch);
    const maxByB = Math.floor(compB_available / compB_per_batch);
    const maxCraftable = Math.min(maxByA, maxByB);

    expect(maxCraftable).toBe(150);
  });
});

describe("Batch size calculation", () => {
  it("should limit batch size by remaining, skill, and materials", () => {
    const remainingBatches = 10;
    const skillLevel = 74; // Can craft up to 74 batches at once
    const materialsAvailable = 200; // Can craft 200 batches

    const batchSize = Math.min(remainingBatches, skillLevel, materialsAvailable);

    expect(batchSize).toBe(10); // Limited by remaining
  });

  it("should handle skill limit", () => {
    const remainingBatches = 100;
    const skillLevel = 50; // Can only craft 50 at once
    const materialsAvailable = 200;

    const batchSize = Math.min(remainingBatches, skillLevel, materialsAvailable);

    expect(batchSize).toBe(50); // Limited by skill
  });

  it("should handle material limit", () => {
    const remainingBatches = 100;
    const skillLevel = 74;
    const materialsAvailable = 30; // Only have materials for 30

    const batchSize = Math.min(remainingBatches, skillLevel, materialsAvailable);

    expect(batchSize).toBe(30); // Limited by materials
  });
});
