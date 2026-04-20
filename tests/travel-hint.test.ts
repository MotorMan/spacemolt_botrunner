/**
 * Travel Hint Tests - parseTravelHint only
 */
import { vi, describe, it, expect } from "vitest";

// Mock modules with side effects to prevent initialization errors
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

import { parseTravelHint } from "../src/routines/common.js";

describe("parseTravelHint", () => {
  it("should parse hint 'Starfall' from Mobile Capital error message", () => {
    const errorMsg = "It's called a Mobile Capital for a reason — it's not here right now. Jump to Starfall to find it.";
    const hint = parseTravelHint(errorMsg);
    expect(hint).toBe("Starfall");
  });

  it("should parse hint with different system name", () => {
    const errorMsg = "It's called a Mobile Capital for a reason — it's not here right now. Jump to Orion to find it.";
    const hint = parseTravelHint(errorMsg);
    expect(hint).toBe("Orion");
  });

  it("should return null for regular error message without hint", () => {
    const errorMsg = "Travel failed: Unknown destination";
    const hint = parseTravelHint(errorMsg);
    expect(hint).toBeNull();
  });

  it("should return null for empty error message", () => {
    const hint = parseTravelHint("");
    expect(hint).toBeNull();
  });

  it("should handle case-insensitive matching", () => {
    const errorMsg = "it's called a mobile capital for a reason — it's not here right now. JUMP to ALDERAAN to find it.";
    const hint = parseTravelHint(errorMsg);
    expect(hint).toBe("ALDERAAN");
  });

  it("should handle error message without period", () => {
    const errorMsg = "It's called a Mobile Capital for a reason — it's not here right now Jump to Vega to find it";
    const hint = parseTravelHint(errorMsg);
    expect(hint).toBe("Vega");
  });

  const MOBILE_CAPITAL_ROAMING_SYSTEMS = [
    "last_light",
    "unknown_edge", 
    "distant_light",
    "the_telescope",
    "frontier",
    "deep_range",
    "horizon",
    "first_step",
    "starfall",
    "void_gate",
    "markeb",
    "altais"
  ];

  it("should have coverage for all Mobile Capital roaming systems", () => {
    for (const systemName of MOBILE_CAPITAL_ROAMING_SYSTEMS) {
      const errorMsg = `It's called a Mobile Capital for a reason — it's not here right now. Jump to ${systemName} to find it.`;
      const hint = parseTravelHint(errorMsg);
      expect(hint).toBe(systemName);
    }
  });
});
