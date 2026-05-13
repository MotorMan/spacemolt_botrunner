import { describe, it, expect, vi, beforeEach, afterEach, Mock } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "fs";
import type { Bot } from "./bot.js";
import {
  loadCustomsStats,
  saveCustomsStats,
  logCustomsStop,
  getBotCustomsStats,
  detectCustomsMessage,
  isCustomsShip,
  waitForCustomsInspection,
  pollForCustomsShip,
  scanCustomsShip,
  sendCustomsChatResponse,
  isEmpireSystem,
} from "./customs.ts";

// Mock fs functions
vi.mock("fs", () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
}));

// Mock path
vi.mock("path", () => ({
  join: vi.fn((...args) => {
    const joined = args.join("/");
    // For DATA_DIR and CUSTOMS_FILE
    if (joined.includes("data/customsStops.json")) return "data/customsStops.json";
    return joined;
  }),
}));

// Mock the sleep function from common.ts (but it's in customs.ts now)
const mockSleep = vi.fn();

// Mock bot
const mockBot = {
  username: "TestBot",
  shipName: "TestBot", // Ship name matches username for testing
  actionLog: [] as string[],
  exec: vi.fn(),
  empire: "voidborn",
  system: "test_system",
  poi: "test_poi",
} as any as Bot;

const mockLog = vi.fn();

describe("Customs Module Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBot.actionLog = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("loadCustomsStats", () => {
    it("should return default stats when file does not exist", () => {
      (existsSync as Mock).mockReturnValue(false);

      const stats = loadCustomsStats();

      expect(stats).toEqual({
        version: 1,
        botTotals: {},
        systemTotals: {},
      });
    });

    it("should load and parse existing stats file", () => {
      const mockStats = {
        version: 1,
        botTotals: { bot1: 5 },
        systemTotals: { system1: 10 },
      };
      (existsSync as Mock).mockReturnValue(true);
      (readFileSync as Mock).mockReturnValue(JSON.stringify(mockStats));

      const stats = loadCustomsStats();

      expect(stats).toEqual(mockStats);
    });

    it("should return default stats on parse error", () => {
      (existsSync as Mock).mockReturnValue(true);
      (readFileSync as Mock).mockReturnValue("invalid json");

      const stats = loadCustomsStats();

      expect(stats).toEqual({
        version: 1,
        botTotals: {},
        systemTotals: {},
      });
    });
  });

  describe("saveCustomsStats", () => {
    it("should create directory and save stats", () => {
      const stats = {
        version: 1,
        botTotals: { bot1: 5 },
        systemTotals: { system1: 10 },
      };

      saveCustomsStats(stats);

      expect(mkdirSync).toHaveBeenCalledWith("data", { recursive: true });
      expect(writeFileSync).toHaveBeenCalledWith(
        "data/customsStops.json",
        JSON.stringify(stats, null, 2) + "\n",
        "utf-8"
      );
    });
  });

  describe("logCustomsStop", () => {
    it("should update bot and system totals", () => {
      const initialStats = {
        version: 1,
        botTotals: { bot1: 5 },
        systemTotals: { system1: 10 },
      };
      (existsSync as Mock).mockReturnValue(true);
      (readFileSync as Mock).mockReturnValue(JSON.stringify(initialStats));

      logCustomsStop("bot1", "system1", "cleared");

      expect(writeFileSync).toHaveBeenCalledWith(
        "data/customsStops.json",
        JSON.stringify({
          version: 1,
          botTotals: { bot1: 6 },
          systemTotals: { system1: 11 },
        }, null, 2) + "\n",
        "utf-8"
      );
    });
  });

  describe("getBotCustomsStats", () => {
    it("should return bot stats", () => {
      const stats = {
        version: 1,
        botTotals: { TestBot: 7 },
        systemTotals: {},
      };
      (existsSync as Mock).mockReturnValue(true);
      (readFileSync as Mock).mockReturnValue(JSON.stringify(stats));

      const result = getBotCustomsStats("TestBot");

      expect(result).toEqual({ totalStops: 7 });
    });

    it("should return 0 for unknown bot", () => {
      const stats = {
        version: 1,
        botTotals: {},
        systemTotals: {},
      };
      (existsSync as Mock).mockReturnValue(true);
      (readFileSync as Mock).mockReturnValue(JSON.stringify(stats));

      const result = getBotCustomsStats("UnknownBot");

      expect(result).toEqual({ totalStops: 0 });
    });
  });

  describe("detectCustomsMessage", () => {
    it("should detect contraband keywords", () => {
      const result = detectCustomsMessage("found contraband in cargo");

      expect(result).toEqual({
        type: "contraband",
        matchedKeywords: ["found contraband"],
      });
    });

    it("should detect clearance keywords", () => {
      const result = detectCustomsMessage("cargo is cleared to proceed");

      expect(result).toEqual({
        type: "cleared",
        matchedKeywords: ["cleared to proceed", "is cleared"],
      });
    });

    it("should detect evasion keywords", () => {
      const result = detectCustomsMessage("evasion detected");

      expect(result).toEqual({
        type: "evasion_warning",
        matchedKeywords: ["evasion"],
      });
    });

    it("should detect stop request keywords", () => {
      const result = detectCustomsMessage("please remain stationary");

      expect(result).toEqual({
        type: "stop_request",
        matchedKeywords: ["remain stationary"],
      });
    });

    it("should return none for unrecognized messages", () => {
      const result = detectCustomsMessage("hello world");

      expect(result).toEqual({
        type: "none",
        matchedKeywords: [],
      });
    });
  });

  describe("isCustomsShip", () => {
    it("should return true for customs ships", () => {
      expect(isCustomsShip("Federation Customs I")).toBe(true);
      expect(isCustomsShip("Police Enforcement")).toBe(true);
    });

    it("should return false for non-customs ships", () => {
      expect(isCustomsShip("Trading Vessel")).toBe(false);
      expect(isCustomsShip("Mining Ship")).toBe(false);
    });
  });

  describe("waitForCustomsInspection", () => {
    it("should return none when no customs messages found", async () => {
      mockBot.actionLog = ["[info] normal message"];

      const result = await waitForCustomsInspection(mockBot, mockLog, "test_system");

      expect(result).toEqual({
        wasStopped: false,
        outcome: "none",
        chatMessages: [],
      });
    });

    it("should detect customs stop and wait for clearance", async () => {
      mockBot.actionLog = [
        "[chat] [CUSTOMS] Federation Customs I - The Levy Customs Station: Running TestBot's cargo against the Federation trade registry. Please hold — cross-referencing takes a moment.",
      ];

      // Mock the sleep function
      const originalSleep = global.setTimeout;
      global.setTimeout = vi.fn((cb) => {
        cb();
        return {} as any;
      }) as any;

      const result = await waitForCustomsInspection(mockBot, mockLog, "test_system", 1000);

      expect(result.wasStopped).toBe(true);
      expect(result.outcome).toBe("timeout");

      global.setTimeout = originalSleep;
    });
  });

  describe("pollForCustomsShip", () => {
    it("should find customs ship", async () => {
      mockBot.exec.mockResolvedValue({
        result: {
          ships: [
            { name: "Federation Customs I", type: "Customs", distance: 100 },
          ],
        },
      });

      const result = await pollForCustomsShip(mockBot, mockLog);

      expect(result.customsShipFound).toBe(true);
      expect(result.shipName).toBe("Federation Customs I");
    });

    it("should return not found when no customs ships", async () => {
      mockBot.exec.mockResolvedValue({
        result: {
          ships: [
            { name: "Trading Vessel", type: "Trader", distance: 100 },
          ],
        },
      });

      const result = await pollForCustomsShip(mockBot, mockLog, 5000, 1);

      expect(result.customsShipFound).toBe(false);
      expect(result.shipName).toBe(null);
    });
  });

  describe("scanCustomsShip", () => {
    it("should scan customs ship successfully", async () => {
      mockBot.exec.mockResolvedValue({
        result: {
          message: "Scan complete: Customs ship detected",
        },
      });

      const result = await scanCustomsShip(mockBot, "Customs Ship", mockLog);

      expect(result).toBe("Scan complete: Customs ship detected");
    });

    it("should return null on scan failure", async () => {
      mockBot.exec.mockResolvedValue({
        error: { message: "Scan failed" },
      });

      const result = await scanCustomsShip(mockBot, "Customs Ship", mockLog);

      expect(result).toBe(null);
    });
  });

  describe("sendCustomsChatResponse", () => {
    it("should send response when AI service available", async () => {
      const mockAiService = {
        triggerCustomsResponse: vi.fn(),
      };
      (globalThis as any).aiChatService = mockAiService;

      await sendCustomsChatResponse(mockBot, mockLog, {
        messageType: "stop_request",
        customsMessage: "Please hold",
        botStops: 5,
      });

      expect(mockAiService.triggerCustomsResponse).toHaveBeenCalledWith("TestBot", {
        messageType: "stop_request",
        customsMessage: "Please hold",
        botStops: 5,
      });
    });

    it("should not send when AI service not available", async () => {
      (globalThis as any).aiChatService = undefined;

      await sendCustomsChatResponse(mockBot, mockLog, {
        messageType: "stop_request",
        customsMessage: "Please hold",
        botStops: 5,
      });

      // Should not throw
      expect(mockLog).toHaveBeenCalledWith("customs", "AI Chat service not available for customs response");
    });
  });

  describe("isEmpireSystem", () => {
    it("should return true for empire systems", () => {
      expect(isEmpireSystem("sol_system", "solarian")).toBe(true);
      expect(isEmpireSystem("nebula_system", "nebula")).toBe(true);
    });

    it("should return false for non-empire systems", () => {
      expect(isEmpireSystem("outer_rim", "frontier")).toBe(false);
      expect(isEmpireSystem("pirate_system", "voidborn")).toBe(false);
    });

    it("should return false for pirate systems", () => {
      expect(isEmpireSystem("algol", "voidborn")).toBe(false);
    });

    it("should return false for lawless systems", () => {
      expect(isEmpireSystem("lawless_system", "voidborn", "lawless")).toBe(false);
    });

    it("should return false when no empire provided", () => {
      expect(isEmpireSystem("any_system", undefined)).toBe(false);
    });
  });
});