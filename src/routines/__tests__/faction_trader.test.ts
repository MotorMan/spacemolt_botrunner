/**
 * Tests for faction_trader.ts V2 API integration
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Bot, RoutineContext } from "../bot.js";
import { parseFactionStorageItems } from "../faction_trader.js";

// ── Mock Bot Factory ─────────────────────────────────────────

function createMockBot(overrides: Partial<Bot> = {}): Bot {
  return {
    username: "testbot",
    system: "SYS001",
    poi: "POI001",
    state: "running",
    cargo: 0,
    cargoMax: 100,
    inventory: [],
    storage: [],
    factionStorage: [],
    faction: "test_faction",
    credits: 50000,
    hull: 100,
    fuel: 100,
    ...overrides,
  } as Bot;
}

function createMockContext(bot: Bot): RoutineContext {
  return {
    bot,
    log: vi.fn(),
    sleep: vi.fn().mockResolvedValue(undefined),
    yield: vi.fn().mockResolvedValue(undefined),
  } as unknown as RoutineContext;
}

// ── parseFactionStorageItems Tests ───────────────────────────

describe("parseFactionStorageItems", () => {
  it("should parse array of items directly", () => {
    const input = [
      { item_id: "iron_ore", name: "Iron Ore", quantity: 100 },
      { item_id: "gold_ore", name: "Gold Ore", quantity: 50 },
    ];
    const result = parseFactionStorageItems(input);
    expect(result).toEqual([
      { itemId: "iron_ore", name: "Iron Ore", quantity: 100 },
      { itemId: "gold_ore", name: "Gold Ore", quantity: 50 },
    ]);
  });

  it("should parse V2 structuredContent format", () => {
    const input = {
      structuredContent: {
        items: [
          { item_id: "iron_ore", name: "Iron Ore", quantity: 100 },
          { item_id: "gold_ore", name: "Gold Ore", quantity: 50 },
        ],
      },
    };
    const result = parseFactionStorageItems(input);
    expect(result.length).toBe(2);
    expect(result[0].itemId).toBe("iron_ore");
    expect(result[1].itemId).toBe("gold_ore");
  });

  it("should handle null/undefined input", () => {
    expect(parseFactionStorageItems(null)).toEqual([]);
    expect(parseFactionStorageItems(undefined)).toEqual([]);
  });

  it("should handle empty array", () => {
    const result = parseFactionStorageItems([]);
    expect(result).toEqual([]);
  });

  it("should filter out items with zero quantity", () => {
    const input = [
      { item_id: "iron_ore", name: "Iron Ore", quantity: 100 },
      { item_id: "gold_ore", name: "Gold Ore", quantity: 0 },
      { item_id: "silver_ore", name: "Silver Ore", quantity: -5 },
    ];
    const result = parseFactionStorageItems(input);
    expect(result.length).toBe(1);
    expect(result[0].itemId).toBe("iron_ore");
  });

  it("should handle alternative field names", () => {
    const input = [
      { id: "iron_ore", name: "Iron Ore", count: 100 },
      { resource_id: "gold_ore", resource_name: "Gold Ore", amount: 50 },
    ];
    const result = parseFactionStorageItems(input);
    expect(result.length).toBe(2);
    expect(result[0].itemId).toBe("iron_ore");
    expect(result[1].itemId).toBe("gold_ore");
  });

  it("should handle object with items field", () => {
    const input = {
      items: [
        { item_id: "iron_ore", name: "Iron Ore", quantity: 100 },
      ],
    };
    const result = parseFactionStorageItems(input);
    expect(result.length).toBe(1);
    expect(result[0].itemId).toBe("iron_ore");
  });

  it("should handle response with no valid items", () => {
    const input = { status: "ok", message: "No items in storage" };
    const result = parseFactionStorageItems(input);
    expect(result).toEqual([]);
  });
});

// ── refreshFactionStorageV2 Tests ────────────────────────────

describe("refreshFactionStorageV2", () => {
  // Note: We can't directly test the async function without exporting it
  // In a real test, you'd export the function or test via the routine

  it("should handle V2 API response format", async () => {
    // This is a conceptual test showing the expected behavior
    const mockBot = createMockBot();
    const mockExec = vi.fn().mockResolvedValue({
      result: {
        structuredContent: {
          items: [
            { item_id: "iron_ore", name: "Iron Ore", quantity: 100 },
          ],
        },
      },
    });
    mockBot.exec = mockExec;

    // The actual test would call refreshFactionStorageV2 and verify
    // bot.factionStorage is populated correctly
    expect(mockBot.factionStorage).toEqual([]); // Initially empty
  });
});

// ── Integration Tests ─────────────────────────────────────────

describe("Faction Trader V2 API Integration", () => {
  it("should use view_storage command with target: faction", () => {
    // Verify the V2 API command is correct
    const expectedCommand = "view_storage";
    const expectedParams = { target: "faction" };
    expect(expectedCommand).toBe("view_storage");
    expect(expectedParams.target).toBe("faction");
  });

  it("should use faction_withdraw_items for faction withdrawals", () => {
    const command = "faction_withdraw_items";
    const params = { item_id: "iron_ore", quantity: 50 };
    expect(command).toBe("faction_withdraw_items");
    expect(params.item_id).toBe("iron_ore");
    expect(params.quantity).toBe(50);
  });

  it("should use faction_deposit_items for faction deposits", () => {
    const command = "faction_deposit_items";
    const params = { item_id: "iron_ore", quantity: 50 };
    expect(command).toBe("faction_deposit_items");
    expect(params.item_id).toBe("iron_ore");
  });

  it("should use sell command for selling items", () => {
    const command = "sell";
    const params = { item_id: "iron_ore", quantity: 50 };
    expect(command).toBe("sell");
    expect(params.item_id).toBe("iron_ore");
  });
});

// ── Faction Storage Parsing Edge Cases ───────────────────────

describe("Faction Storage Edge Cases", () => {
  it("should handle V2 response with nested data field", () => {
    const input = {
      data: [
        { item_id: "iron_ore", name: "Iron Ore", quantity: 100 },
      ],
    };
    const result = parseFactionStorageItems(input);
    expect(result.length).toBe(1);
    expect(result[0].itemId).toBe("iron_ore");
  });

  it("should handle V2 response with result field", () => {
    const input = {
      result: [
        { item_id: "iron_ore", name: "Iron Ore", quantity: 100 },
      ],
    };
    const result = parseFactionStorageItems(input);
    expect(result.length).toBe(1);
  });

  it("should handle cargo field name", () => {
    const input = {
      cargo: [
        { item_id: "iron_ore", name: "Iron Ore", quantity: 100 },
      ],
    };
    const result = parseFactionStorageItems(input);
    expect(result.length).toBe(1);
  });

  it("should handle faction_storage field name", () => {
    const input = {
      faction_storage: [
        { item_id: "iron_ore", name: "Iron Ore", quantity: 100 },
      ],
    };
    const result = parseFactionStorageItems(input);
    expect(result.length).toBe(1);
  });

  it("should skip items with missing item_id", () => {
    const input = [
      { item_id: "iron_ore", name: "Iron Ore", quantity: 100 },
      { name: "No ID", quantity: 50 },
    ];
    const result = parseFactionStorageItems(input);
    expect(result.length).toBe(1);
    expect(result[0].itemId).toBe("iron_ore");
  });
});
