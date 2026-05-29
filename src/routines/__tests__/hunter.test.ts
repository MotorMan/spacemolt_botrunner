import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { RoutineContext } from "../../bot.js";
import { hunterRoutine, setHunterMode, type HunterMode } from "../hunter.js";

// Mock the bot and context
const mockBot = {
  exec: vi.fn(),
  system: "test_system",
  poi: "test_poi",
  username: "test_bot",
  state: "running",
  hull: 100,
  maxHull: 100,
  fuel: 100,
  maxFuel: 100,
  credits: 1000,
  ammo: 50,
  docked: false,
  inventory: [],
  trackNearbyPlayers: vi.fn(),
  refreshStatus: vi.fn(),
  refreshCargo: vi.fn(),
  checkSkills: vi.fn(),
  log: vi.fn(),
};

const mockCtx: RoutineContext = {
  api: {} as any, // Mock API
  bot: mockBot as any,
  log: vi.fn(),
  sendBotChat: vi.fn(),
  sleep: vi.fn(),
};

describe("Hunter Routine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset bot state
    mockBot.system = "test_system";
    mockBot.poi = "test_poi";
    mockBot.state = "running";
    mockBot.hull = 100;
    mockBot.maxHull = 100;
    mockBot.fuel = 100;
    mockBot.maxFuel = 100;
    mockBot.docked = false;
    mockBot.exec.mockResolvedValue({ result: {} });
    mockBot.refreshStatus.mockResolvedValue();
    mockBot.refreshCargo.mockResolvedValue();
    mockBot.checkSkills.mockResolvedValue();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Stationary Mode", () => {
    it("should stay in the original POI and system", async () => {
      // Set mode to stationary
      setHunterMode("test_bot", "stationary");

      // Mock getSystemInfo to return POIs
      mockBot.exec.mockImplementation((command: string, params?: any) => {
        if (command === "get_nearby") {
          return Promise.resolve({ result: { entities: [] } });
        }
        if (command === "get_ship") {
          return Promise.resolve({ result: { modules: [] } });
        }
        if (command === "get_system_info") {
          return Promise.resolve({
            result: {
              pois: [
                { id: "test_poi", name: "Test POI", type: "asteroid_belt" },
                { id: "station", name: "Station", type: "station" }
              ]
            }
          });
        }
        if (command === "travel") {
          // Track travel calls
          mockBot.poi = params.target_poi;
          return Promise.resolve({ result: {} });
        }
        return Promise.resolve({ result: {} });
      });

      // Mock sleep to resolve immediately to speed up test
      mockCtx.sleep = vi.fn().mockResolvedValue();

      // Mock detectAndRecoverFromDeath to return true
      vi.doMock("../common.js", () => ({
        detectAndRecoverFromDeath: vi.fn().mockResolvedValue(true),
        getHunterSettings: vi.fn().mockReturnValue({
          mode: "stationary",
          system: "",
          refuelThreshold: 40,
          repairThreshold: 30,
          fleeThreshold: 20,
          onlyNPCs: true,
          autoCloak: false,
          ammoThreshold: 5,
          maxReloadAttempts: 3,
          responseRange: 3,
          maxAttackTier: "large",
          fleeFromTier: "boss",
          minPiratesToFlee: 3,
        }),
        ensureFueled: vi.fn().mockResolvedValue(true),
        logStatus: vi.fn(),
        checkFactionAlerts: vi.fn().mockResolvedValue(null),
        getSystemInfo: vi.fn().mockResolvedValue({
          pois: [
            { id: "test_poi", name: "Test POI", type: "asteroid_belt" },
            { id: "station", name: "Station", type: "station" }
          ]
        }),
        fetchSecurityLevel: vi.fn().mockResolvedValue(),
        ensureAmmoLoaded: vi.fn().mockResolvedValue(true),
        scavengeWrecks: vi.fn().mockResolvedValue(),
      }));

      // Import after mocking
      const { detectAndRecoverFromDeath, getHunterSettings, ensureFueled, logStatus, checkFactionAlerts, getSystemInfo, fetchSecurityLevel, ensureAmmoLoaded, scavengeWrecks } = await import("../common.js");

      // Run the routine generator
      const generator = hunterRoutine(mockCtx);
      let iterations = 0;
      let maxIterations = 3; // Limit to prevent infinite loop

      while (iterations < maxIterations) {
        const { value, done } = await generator.next();
        if (done) break;
        iterations++;

        // Simulate some iterations
        if (value === "scan_for_targets") {
          // Break after a few scans
          break;
        }
      }

      // Verify that travel was not called (except possibly for initial setup, but in stationary it shouldn't)
      const travelCalls = mockBot.exec.mock.calls.filter(call => call[0] === "travel");
      expect(travelCalls.length).toBeLessThanOrEqual(0); // Should not travel in stationary mode

      // Verify bot stayed in original position
      expect(mockBot.system).toBe("test_system");
      expect(mockBot.poi).toBe("test_poi");
    });

    it("should return to original position after repairs", async () => {
      // Set mode to stationary
      setHunterMode("test_bot", "stationary");

      // Set low hull to trigger repair
      mockBot.hull = 20;
      mockBot.maxHull = 100;

      // Mock navigateToSafeStation to change system
      const mockNavigateToSafeStation = vi.fn().mockImplementation(async () => {
        mockBot.system = "safe_system";
        mockBot.docked = true;
        return true;
      });

      // Mock navigateToSystem to return to original
      const mockNavigateToSystem = vi.fn().mockImplementation(async (ctx, system) => {
        mockBot.system = system;
        return true;
      });

      // Mock commands
      mockBot.exec.mockImplementation((command: string, params?: any) => {
        if (command === "get_nearby") {
          return Promise.resolve({ result: { entities: [] } });
        }
        if (command === "get_ship") {
          return Promise.resolve({ result: { modules: [] } });
        }
        if (command === "get_system_info") {
          return Promise.resolve({
            result: {
              pois: [
                { id: "test_poi", name: "Test POI", type: "asteroid_belt" },
                { id: "station", name: "Station", type: "station" }
              ]
            }
          });
        }
        if (command === "travel") {
          mockBot.poi = params.target_poi;
          return Promise.resolve({ result: {} });
        }
        return Promise.resolve({ result: {} });
      });

      // Mock sleep
      mockCtx.sleep = vi.fn().mockResolvedValue();

      // Mock common functions
      vi.doMock("../common.js", () => ({
        detectAndRecoverFromDeath: vi.fn().mockResolvedValue(true),
        getHunterSettings: vi.fn().mockReturnValue({
          mode: "stationary",
          system: "",
          refuelThreshold: 40,
          repairThreshold: 30,
          fleeThreshold: 20,
          onlyNPCs: true,
          autoCloak: false,
          ammoThreshold: 5,
          maxReloadAttempts: 3,
          responseRange: 3,
          maxAttackTier: "large",
          fleeFromTier: "boss",
          minPiratesToFlee: 3,
          disableScanCommandForPirates: false,
          disableWreckSalvaging: false,
        }),
        ensureFueled: vi.fn().mockResolvedValue(true),
        logStatus: vi.fn(),
        checkFactionAlerts: vi.fn().mockResolvedValue(null),
        getSystemInfo: vi.fn().mockResolvedValue({
          pois: [
            { id: "test_poi", name: "Test POI", type: "asteroid_belt" },
            { id: "station", name: "Station", type: "station" }
          ]
        }),
        fetchSecurityLevel: vi.fn().mockResolvedValue(),
        navigateToSafeStation: mockNavigateToSafeStation,
        completeActiveMissions: vi.fn().mockResolvedValue(),
        repairShip: vi.fn().mockResolvedValue(),
        tryRefuel: vi.fn().mockResolvedValue(),
        checkAndAcceptMissions: vi.fn().mockResolvedValue(),
        ensureInsured: vi.fn().mockResolvedValue(),
        ensureUndocked: vi.fn().mockResolvedValue(),
        navigateToSystem: mockNavigateToSystem,
        ensureAmmoLoaded: vi.fn().mockResolvedValue(true),
        scavengeWrecks: vi.fn().mockResolvedValue(),
      }));

      // Run the routine until it processes repairs
      const generator = hunterRoutine(mockCtx);

      // Skip initial steps
      await generator.next(); // get_status
      await generator.next(); // fuel_check
      await generator.next(); // emergency_repair

      // Verify navigateToSafeStation was called and system changed
      expect(mockNavigateToSafeStation).toHaveBeenCalled();
      expect(mockBot.system).toBe("safe_system");

      // The routine should continue and call navigateToSystem to return
      // Since it's a generator, we need to advance it properly
      // But for simplicity, check that after the repair process, navigateToSystem was called
      expect(mockNavigateToSystem).toHaveBeenCalledWith(mockCtx, "test_system", expect.any(Object));
    });

    it("should perform scanning even when scan command for pirates is disabled", async () => {
      // Set mode to roam_system with scanning disabled
      setHunterMode("test_bot", "roam_system");

      let scanCalled = false;

      // Mock commands
      mockBot.exec.mockImplementation((command: string, params?: any) => {
        if (command === "get_nearby") {
          scanCalled = true;
          return Promise.resolve({ result: { entities: [] } });
        }
        if (command === "get_ship") {
          return Promise.resolve({ result: { modules: [] } });
        }
        if (command === "get_system_info") {
          return Promise.resolve({
            result: {
              pois: [
                { id: "test_poi", name: "Test POI", type: "asteroid_belt" },
                { id: "station", name: "Station", type: "station" }
              ]
            }
          });
        }
        return Promise.resolve({ result: {} });
      });

      // Mock sleep
      mockCtx.sleep = vi.fn().mockResolvedValue();

      // Mock common functions with disableScanCommandForPirates: true
      vi.doMock("../common.js", () => ({
        detectAndRecoverFromDeath: vi.fn().mockResolvedValue(true),
        getHunterSettings: vi.fn().mockReturnValue({
          mode: "roam_system",
          system: "",
          refuelThreshold: 40,
          repairThreshold: 30,
          fleeThreshold: 20,
          onlyNPCs: true,
          autoCloak: false,
          ammoThreshold: 5,
          maxReloadAttempts: 3,
          responseRange: 3,
          maxAttackTier: "large",
          fleeFromTier: "boss",
          minPiratesToFlee: 3,
          disableScanCommandForPirates: true, // Disabled
        }),
        ensureFueled: vi.fn().mockResolvedValue(true),
        logStatus: vi.fn(),
        checkFactionAlerts: vi.fn().mockResolvedValue(null),
        getSystemInfo: vi.fn().mockResolvedValue({
          pois: [
            { id: "test_poi", name: "Test POI", type: "asteroid_belt" },
            { id: "station", name: "Station", type: "station" }
          ]
        }),
        fetchSecurityLevel: vi.fn().mockResolvedValue(),
        ensureAmmoLoaded: vi.fn().mockResolvedValue(true),
        scavengeWrecks: vi.fn().mockResolvedValue(),
      }));

      // Run a few iterations
      const generator = hunterRoutine(mockCtx);
      await generator.next(); // get_status
      await generator.next(); // fuel_check
      await generator.next(); // scan_system or similar

      // Verify that get_nearby (scanning) was called
      expect(scanCalled).toBe(true);
    });

    it("should skip wreck salvaging when disabled", async () => {
      // Set mode to roam_system with wreck salvaging disabled
      setHunterMode("test_bot", "roam_system");

      let scavengeCalled = false;

      // Mock commands
      mockBot.exec.mockImplementation((command: string, params?: any) => {
        if (command === "get_nearby") {
          return Promise.resolve({ result: { entities: [] } });
        }
        if (command === "get_ship") {
          return Promise.resolve({ result: { modules: [] } });
        }
        if (command === "get_system_info") {
          return Promise.resolve({
            result: {
              pois: [
                { id: "test_poi", name: "Test POI", type: "asteroid_belt" },
                { id: "station", name: "Station", type: "station" }
              ]
            }
          });
        }
        return Promise.resolve({ result: {} });
      });

      // Mock sleep
      mockCtx.sleep = vi.fn().mockResolvedValue();

      // Mock common functions with disableWreckSalvaging: true
      vi.doMock("../common.js", () => ({
        detectAndRecoverFromDeath: vi.fn().mockResolvedValue(true),
        getHunterSettings: vi.fn().mockReturnValue({
          mode: "roam_system",
          system: "",
          refuelThreshold: 40,
          repairThreshold: 30,
          fleeThreshold: 20,
          onlyNPCs: true,
          autoCloak: false,
          ammoThreshold: 5,
          maxReloadAttempts: 3,
          responseRange: 3,
          maxAttackTier: "large",
          fleeFromTier: "boss",
          minPiratesToFlee: 3,
          disableScanCommandForPirates: false,
          disableWreckSalvaging: true, // Disabled
        }),
        ensureFueled: vi.fn().mockResolvedValue(true),
        logStatus: vi.fn(),
        checkFactionAlerts: vi.fn().mockResolvedValue(null),
        getSystemInfo: vi.fn().mockResolvedValue({
          pois: [
            { id: "test_poi", name: "Test POI", type: "asteroid_belt" },
            { id: "station", name: "Station", type: "station" }
          ]
        }),
        fetchSecurityLevel: vi.fn().mockResolvedValue(),
        ensureAmmoLoaded: vi.fn().mockResolvedValue(true),
        scavengeWrecks: vi.fn().mockImplementation(() => {
          scavengeCalled = true;
        }),
      }));

      // Run a few iterations
      const generator = hunterRoutine(mockCtx);
      await generator.next(); // get_status
      await generator.next(); // fuel_check
      await generator.next(); // scan_system or similar

      // Verify that scavengeWrecks was not called
      expect(scavengeCalled).toBe(false);
    });
  });
});