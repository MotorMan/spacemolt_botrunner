import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { returnHomeRoutine } from "../return_home.js";
import { createMockBot, createMockContext } from "../../test_helpers.js";

describe("Return Home Routine", () => {
  let mockBot: any;
  let mockCtx: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create fresh mock bot and context
    mockBot = createMockBot({
      username: "testBot",
      system: "testSystem",
      poi: "testStation",
      docked: false,
      fuel: 50,
      maxFuel: 100,
      hull: 80,
      maxHull: 100,
      shield: 40,
      maxShield: 50,
      credits: 1000,
      cargo: 10,
      cargoMax: 100,
      state: "running",
    });

    mockCtx = {
      ...createMockContext(mockBot),
      sendBotChat: vi.fn(),
    };

    // Mock exec method
    mockBot.exec = vi.fn();

    // Default mock implementations
    mockBot.refreshStatus.mockResolvedValue(undefined);
    checkAndFleeFromBattle.mockResolvedValue(false);
    readSettings.mockReturnValue({
      return_home: { homeSystem: "homeSystem", homeStation: "homeStation" },
    });
    getSystemInfo.mockResolvedValue({
      pois: [
        { id: "homeStation", name: "Home Station", type: "station" },
        { id: "otherStation", name: "Other Station", type: "station" },
      ],
    });
    isStationPoi.mockReturnValue(true);
    findStation.mockReturnValue({ id: "homeStation", name: "Home Station", type: "station" });
    ensureDocked.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  describe("Settings handling", () => {
    it("should read return_home settings correctly", async () => {
      readSettings.mockReturnValue({
        return_home: { homeSystem: "globalHome", homeStation: "globalStation" },
        testBot: { homeSystem: "botHome", homeStation: "botStation" },
      });

      const generator = returnHomeRoutine(mockCtx);
      await generator.next(); // Wait for initial setup

      expect(readSettings).toHaveBeenCalled();
    });

    it("should use bot-specific settings over global defaults", async () => {
      readSettings.mockReturnValue({
        return_home: { homeSystem: "globalHome", homeStation: "globalStation" },
        testBot: { homeSystem: "botHome", homeStation: "botStation" },
      });

      const generator = returnHomeRoutine(mockCtx);
      await generator.next(); // Initial wait_idle

      // Should use botHome and botStation
      expect(mockCtx.log).toHaveBeenCalledWith("travel", expect.stringContaining("botStation"));
    });
  });

  describe("Already at home checks", () => {
    it("should exit early if already at home station", async () => {
      mockBot.system = "homeSystem";
      mockBot.poi = "homeStation";
      mockBot.docked = true;

      readSettings.mockReturnValue({
        return_home: { homeSystem: "homeSystem", homeStation: "homeStation" },
      });

      const generator = returnHomeRoutine(mockCtx);
      await generator.next(); // wait_idle
      await generator.next(); // refresh status

      expect(mockCtx.log).toHaveBeenCalledWith("travel", "Already at home station — checking repair status...");
      expect(mockCtx.log).toHaveBeenCalledWith("travel", "Already at home station — routine complete");
    });

    it("should exit early if already docked in home system with no specific station", async () => {
      mockBot.system = "homeSystem";
      mockBot.docked = true;

      readSettings.mockReturnValue({
        return_home: { homeSystem: "homeSystem", homeStation: "" },
      });

      const generator = returnHomeRoutine(mockCtx);
      await generator.next(); // wait_idle
      await generator.next(); // refresh status

      expect(mockCtx.log).toHaveBeenCalledWith("travel", "Already docked in home system — checking repair status...");
      expect(mockCtx.log).toHaveBeenCalledWith("travel", "Already docked in home system — routine complete");
    });
  });

  describe("Battle handling", () => {
    it("should flee from battle before starting return home", async () => {
      checkAndFleeFromBattle.mockResolvedValue(true); // In battle

      const generator = returnHomeRoutine(mockCtx);
      await generator.next(); // wait_idle
      await generator.next(); // check battle

      expect(checkAndFleeFromBattle).toHaveBeenCalledWith(mockCtx, "return_home");
      expect(mockCtx.log).toHaveBeenCalledWith("combat", "Cannot return home while in battle — fleeing first");
    });
  });

  describe("Fuel management", () => {
    it("should refuel before journey if fuel is low", async () => {
      mockBot.fuel = 20; // Below 50%
      mockBot.docked = true;

      refuelAtStation.mockResolvedValue(true);

      const generator = returnHomeRoutine(mockCtx);
      // Skip to fuel check
      await generator.next(); // wait_idle
      await generator.next(); // battle check
      await generator.next(); // settings
      await generator.next(); // not at home
      await generator.next(); // docked check
      await generator.next(); // fuel check

      expect(mockCtx.log).toHaveBeenCalledWith("system", expect.stringContaining("Fuel low"));
      expect(refuelAtStation).toHaveBeenCalled();
    });

    it("should ensure docked if not docked for refueling", async () => {
      mockBot.fuel = 20; // Below 50%
      mockBot.docked = false;

      ensureDocked.mockResolvedValue(true);
      mockBot.exec.mockResolvedValue({ error: null });

      const generator = returnHomeRoutine(mockCtx);
      // Skip to fuel check
      await generator.next(); // wait_idle
      await generator.next(); // battle check
      await generator.next(); // settings
      await generator.next(); // not at home
      await generator.next(); // docked check
      await generator.next(); // fuel check

      expect(ensureDocked).toHaveBeenCalled();
      expect(mockBot.exec).toHaveBeenCalledWith("refuel");
      expect(ensureUndocked).toHaveBeenCalled();
    });
  });

  describe("Navigation", () => {
    it("should navigate to home system if not already there", async () => {
      mockBot.system = "differentSystem";
      navigateToSystem.mockResolvedValue(true);

      const generator = returnHomeRoutine(mockCtx);
      // Skip to navigation
      await generator.next(); // wait_idle
      await generator.next(); // battle check
      await generator.next(); // settings
      await generator.next(); // not at home
      await generator.next(); // fuel checks
      await generator.next(); // navigation

      expect(navigateToSystem).toHaveBeenCalledWith(mockCtx, "homeSystem", expect.any(Object));
    });

    it("should pass ignoreBlacklist parameter to navigateToSystem", async () => {
      mockBot.system = "differentSystem";
      navigateToSystem.mockResolvedValue(true);

      // Mock routineParams with ignoreBlacklist
      (mockBot as any).routineParams = { ignoreBlacklist: true };

      const generator = returnHomeRoutine(mockCtx);
      // Skip to navigation
      await generator.next(); // wait_idle
      await generator.next(); // battle check
      await generator.next(); // settings
      await generator.next(); // not at home
      await generator.next(); // fuel checks
      await generator.next(); // navigation

      expect(navigateToSystem).toHaveBeenCalledWith(mockCtx, "homeSystem", {
        fuelThresholdPct: 30,
        hullThresholdPct: 40,
        skipBlacklist: true,
      });
    });

    it("should not pass skipBlacklist when ignoreBlacklist is false", async () => {
      mockBot.system = "differentSystem";
      navigateToSystem.mockResolvedValue(true);

      // Mock routineParams without ignoreBlacklist
      (mockBot as any).routineParams = {};

      const generator = returnHomeRoutine(mockCtx);
      // Skip to navigation
      await generator.next(); // wait_idle
      await generator.next(); // battle check
      await generator.next(); // settings
      await generator.next(); // not at home
      await generator.next(); // fuel checks
      await generator.next(); // navigation

      expect(navigateToSystem).toHaveBeenCalledWith(mockCtx, "homeSystem", {
        fuelThresholdPct: 30,
        hullThresholdPct: 40,
        skipBlacklist: false,
      });
    });
  });

  describe("Station travel and docking", () => {
    it("should travel to home station and dock", async () => {
      mockBot.system = "homeSystem";
      mockBot.poi = "differentStation";

      mockBot.exec.mockResolvedValue({ error: null });

      const generator = returnHomeRoutine(mockCtx);
      // Skip to station travel
      await generator.next(); // wait_idle
      await generator.next(); // battle check
      await generator.next(); // settings
      await generator.next(); // not at home
      await generator.next(); // fuel checks
      await generator.next(); // already in system
      await generator.next(); // find station
      await generator.next(); // travel to station

      expect(mockBot.exec).toHaveBeenCalledWith("travel", { target_poi: "homeStation" });
      expect(ensureDocked).toHaveBeenCalledWith(mockCtx, true);
    });

    it("should find alternative station if home station not found", async () => {
      mockBot.system = "homeSystem";
      mockBot.poi = "differentStation";

      // Home station not found
      getSystemInfo.mockResolvedValue({
        pois: [
          { id: "otherStation", name: "Other Station", type: "station" },
        ],
      });

      isStationPoi.mockImplementation((poi) => poi.id === "otherStation");

      mockBot.exec.mockResolvedValue({ error: null });

      const generator = returnHomeRoutine(mockCtx);
      // Skip to station finding
      await generator.next(); // wait_idle
      await generator.next(); // battle check
      await generator.next(); // settings
      await generator.next(); // not at home
      await generator.next(); // fuel checks
      await generator.next(); // already in system
      await generator.next(); // find station

      expect(mockCtx.log).toHaveBeenCalledWith("error", "Home station \"homeStation\" not found in homeSystem — finding alternative");
      expect(findStation).toHaveBeenCalled();
    });
  });

  describe("Final repairs and refuel", () => {
    it("should repair and refuel at home station", async () => {
      mockBot.system = "homeSystem";
      mockBot.poi = "homeStation";
      mockBot.docked = true;
      mockBot.hull = 50; // Needs repair
      mockBot.fuel = 30; // Needs refuel

      repairShip.mockResolvedValue(undefined);
      refuelAtStation.mockResolvedValue(true);

      const generator = returnHomeRoutine(mockCtx);
      // Skip to final steps
      await generator.next(); // wait_idle
      await generator.next(); // battle check
      await generator.next(); // settings
      await generator.next(); // not at home
      await generator.next(); // fuel checks
      await generator.next(); // already in system
      await generator.next(); // find station
      await generator.next(); // already at station
      await generator.next(); // dock
      await generator.next(); // refresh status
      await generator.next(); // final repair
      await generator.next(); // final refuel

      expect(repairShip).toHaveBeenCalledWith(mockCtx);
      expect(refuelAtStation).toHaveBeenCalled();
      expect(mockCtx.log).toHaveBeenCalledWith("travel", expect.stringContaining("Return Home complete"));
    });
  });

  describe("Error handling", () => {
    it("should cancel routine if no home system configured", async () => {
      readSettings.mockReturnValue({
        return_home: { homeSystem: "", homeStation: "" },
      });

      const generator = returnHomeRoutine(mockCtx);
      await generator.next(); // wait_idle
      await generator.next(); // battle check
      await generator.next(); // settings

      expect(mockCtx.log).toHaveBeenCalledWith("error", "No home system configured — cannot return home");
    });

    it("should cancel if navigation fails", async () => {
      mockBot.system = "differentSystem";
      navigateToSystem.mockResolvedValue(false);

      const generator = returnHomeRoutine(mockCtx);
      // Skip to navigation
      await generator.next(); // wait_idle
      await generator.next(); // battle check
      await generator.next(); // settings
      await generator.next(); // not at home
      await generator.next(); // fuel checks
      await generator.next(); // navigation

      expect(mockCtx.log).toHaveBeenCalledWith("error", expect.stringContaining("Failed to reach homeSystem"));
    });

    it("should cancel if cannot dock at home station", async () => {
      mockBot.system = "homeSystem";
      mockBot.poi = "homeStation";
      ensureDocked.mockResolvedValue(false);

      const generator = returnHomeRoutine(mockCtx);
      // Skip to docking
      await generator.next(); // wait_idle
      await generator.next(); // battle check
      await generator.next(); // settings
      await generator.next(); // not at home
      await generator.next(); // fuel checks
      await generator.next(); // already in system
      await generator.next(); // find station
      await generator.next(); // already at station
      await generator.next(); // dock

      expect(mockCtx.log).toHaveBeenCalledWith("error", "Failed to dock at home station — routine cancelled");
    });
  });
});