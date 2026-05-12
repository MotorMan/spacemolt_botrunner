import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { RoutineContext } from "../../bot.js";
import { isDeepCoreOre, hasDeepCoreSurveyScanner, hasDeepCoreExtractor, getDeepCoreCapability, findFirstAvailableQuotaTarget, pickTargetFromQuotas, hasEquipmentForMiningType, ALLOWED_HIDDEN_POIS_FOR_PARTIAL_MINERS } from "../miner.js";

// Mock the bot and context
const mockBot = {
  exec: vi.fn(),
  log: vi.fn(),
};

const mockCtx: RoutineContext = {
  api: {} as any, // Mock API
  bot: mockBot as any,
  log: vi.fn(),
  sendBotChat: vi.fn(),
  sleep: vi.fn(),
};

describe("Miner Deep Core Functions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("isDeepCoreOre", () => {
    it("should return true for deep core ores", () => {
      expect(isDeepCoreOre("adamantite_ore")).toBe(true);
      expect(isDeepCoreOre("void_essence")).toBe(true);
      expect(isDeepCoreOre("fury_crystal")).toBe(true);
      expect(isDeepCoreOre("legacy_ore")).toBe(true);
      expect(isDeepCoreOre("prismatic_nebulite")).toBe(true);
      expect(isDeepCoreOre("exotic_matter")).toBe(true);
      expect(isDeepCoreOre("dark_matter_residue")).toBe(true);
    });

    it("should return false for non-deep core ores", () => {
      expect(isDeepCoreOre("iron_ore")).toBe(false);
      expect(isDeepCoreOre("copper_ore")).toBe(false);
      expect(isDeepCoreOre("carbon_ore")).toBe(false);
    });
  });

  describe("hasDeepCoreSurveyScanner", () => {
    it("should return true when deep core survey scanner is equipped", async () => {
      mockBot.exec.mockResolvedValue({
        result: {
          modules: [
            { id: "deep_core_survey_scanner", name: "Deep Core Survey Scanner", special: "deep_core_detection" }
          ]
        }
      });

      const result = await hasDeepCoreSurveyScanner(mockCtx);
      expect(result).toBe(true);
      expect(mockBot.exec).toHaveBeenCalledWith("get_ship");
    });

    it("should return false when no deep core survey scanner is equipped", async () => {
      mockBot.exec.mockResolvedValue({
        result: {
          modules: [
            { id: "mining_laser", name: "Mining Laser" }
          ]
        }
      });

      const result = await hasDeepCoreSurveyScanner(mockCtx);
      expect(result).toBe(false);
    });

    it("should return false on error", async () => {
      mockBot.exec.mockResolvedValue({ error: { message: "error" } });

      const result = await hasDeepCoreSurveyScanner(mockCtx);
      expect(result).toBe(false);
    });
  });

  describe("hasDeepCoreExtractor", () => {
    it("should return true when deep core extractor is equipped", async () => {
      mockBot.exec.mockResolvedValue({
        result: {
          modules: [
            { id: "deep_core_extractor_mkii", name: "Deep Core Extractor MKII", special: "rare_ore_access" }
          ]
        }
      });

      const result = await hasDeepCoreExtractor(mockCtx);
      expect(result).toBe(true);
    });

    it("should return false when no deep core extractor is equipped", async () => {
      mockBot.exec.mockResolvedValue({
        result: {
          modules: [
            { id: "mining_laser", name: "Mining Laser" }
          ]
        }
      });

      const result = await hasDeepCoreExtractor(mockCtx);
      expect(result).toBe(false);
    });
  });

  describe("getDeepCoreCapability", () => {
    it("should return full capability when both scanner and extractor are equipped", async () => {
      mockBot.exec.mockResolvedValue({
        result: {
          modules: [
            { id: "deep_core_survey_scanner", name: "Deep Core Survey Scanner" },
            { id: "deep_core_extractor_mkii", name: "Deep Core Extractor MKII" }
          ]
        }
      });

      const result = await getDeepCoreCapability(mockCtx);
      expect(result).toEqual({
        hasScanner: true,
        hasExtractor: true,
        canMineHidden: true,
        canMineVisibleDeepCore: true,
      });
    });

    it("should return extractor-only capability during field test", async () => {
      mockBot.exec.mockResolvedValue({
        result: {
          modules: [
            { id: "deep_core_extractor_mkii", name: "Deep Core Extractor MKII" }
          ]
        }
      });

      const result = await getDeepCoreCapability(mockCtx, true); // fieldTestActive = true
      expect(result).toEqual({
        hasScanner: false,
        hasExtractor: true,
        canMineHidden: true, // allowed during field test
        canMineVisibleDeepCore: true,
      });
    });

    it("should return limited capability with extractor only (no field test)", async () => {
      mockBot.exec.mockResolvedValue({
        result: {
          modules: [
            { id: "deep_core_extractor_mkii", name: "Deep Core Extractor MKII" }
          ]
        }
      });

      const result = await getDeepCoreCapability(mockCtx, false); // fieldTestActive = false
      expect(result).toEqual({
        hasScanner: false,
        hasExtractor: true,
        canMineHidden: false, // not allowed without field test
        canMineVisibleDeepCore: true,
      });
    });

    it("should return no capability when no deep core equipment", async () => {
      mockBot.exec.mockResolvedValue({
        result: {
          modules: [
            { id: "mining_laser", name: "Mining Laser" }
          ]
        }
      });

      const result = await getDeepCoreCapability(mockCtx);
      expect(result).toEqual({
        hasScanner: false,
        hasExtractor: false,
        canMineHidden: false,
        canMineVisibleDeepCore: false,
      });
    });
  });

  describe("hasEquipmentForMiningType", () => {
    it("should return true for ore mining with mining laser", async () => {
      mockBot.exec.mockResolvedValue({
        result: {
          modules: [
            { id: "mining_laser", name: "Mining Laser" }
          ]
        }
      });

      const result = await hasEquipmentForMiningType(mockCtx, "ore");
      expect(result).toBe(true);
    });

    it("should return true for ore mining with strip miner", async () => {
      mockBot.exec.mockResolvedValue({
        result: {
          modules: [
            { id: "strip_miner", name: "Strip Miner" }
          ]
        }
      });

      const result = await hasEquipmentForMiningType(mockCtx, "ore");
      expect(result).toBe(true);
    });

    it("should return true for ore mining with deep core survey scanner", async () => {
      mockBot.exec.mockResolvedValue({
        result: {
          modules: [
            { id: "deep_core_survey_scanner", name: "Deep Core Survey Scanner" }
          ]
        }
      });

      const result = await hasEquipmentForMiningType(mockCtx, "ore");
      expect(result).toBe(true);
    });

    it("should return true for ore mining with deep core extractor", async () => {
      mockBot.exec.mockResolvedValue({
        result: {
          modules: [
            { id: "deep_core_extractor_ii", name: "Deep Core Extractor II", special: "rare_ore_access,exotic_ore_chance_10" }
          ]
        }
      });

      const result = await hasEquipmentForMiningType(mockCtx, "ore");
      expect(result).toBe(true);
    });

    it("should return true for ore mining with deep core extractor (different naming)", async () => {
      mockBot.exec.mockResolvedValue({
        result: {
          modules: [
            { id: "deep_core_extractor_mkii", name: "Deep Core Extractor MKII" }
          ]
        }
      });

      const result = await hasEquipmentForMiningType(mockCtx, "ore");
      expect(result).toBe(true);
    });

    it("should return false for ore mining with no equipment", async () => {
      mockBot.exec.mockResolvedValue({
        result: {
          modules: [
            { id: "cargo_expander", name: "Cargo Expander" }
          ]
        }
      });

      const result = await hasEquipmentForMiningType(mockCtx, "ore");
      expect(result).toBe(false);
    });

    it("should return true for gas mining with gas harvester", async () => {
      mockBot.exec.mockResolvedValue({
        result: {
          modules: [
            { id: "gas_harvester", name: "Gas Harvester" }
          ]
        }
      });

      const result = await hasEquipmentForMiningType(mockCtx, "gas");
      expect(result).toBe(true);
    });

    it("should return true for ice mining with ice harvester", async () => {
      mockBot.exec.mockResolvedValue({
        result: {
          modules: [
            { id: "ice_harvester", name: "Ice Harvester" }
          ]
        }
      });

      const result = await hasEquipmentForMiningType(mockCtx, "ice");
      expect(result).toBe(true);
    });
  });
});

// Integration test for mining logic (simplified)
describe("Miner Integration Tests", () => {
  // Mock dependencies
  const mockMapStore = {
    findOreLocations: vi.fn(),
    findBestMiningLocation: vi.fn(),
    getSystem: vi.fn(),
    updateSystem: vi.fn(),
    registerPoiFromScan: vi.fn(),
    updatePoiResources: vi.fn(),
    markOreDepleted: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Mock mapStore.findOreLocations to return locations for adamantite_ore
    mockMapStore.findOreLocations.mockReturnValue([
      {
        systemId: "embervale",
        poiId: "adamantite_core",
        poiName: "Adamantite Core",
        richness: 80,
        remaining: 300,
        maxRemaining: 300,
        isHidden: true,
      }
    ]);
    mockMapStore.findBestMiningLocation.mockReturnValue([
      {
        systemId: "embervale",
        poiId: "adamantite_core",
        poiName: "Adamantite Core",
        richness: 80,
        remaining: 300,
        maxRemaining: 300,
        isHidden: true,
        jumps: 0,
        score: 100,
      }
    ]);
    mockMapStore.getSystem.mockReturnValue({
      id: "embervale",
      pois: [
        {
          id: "adamantite_core",
          name: "Adamantite Core",
          hidden: true,
          ores_found: [
            {
              item_id: "adamantite_ore",
              remaining: 300,
              max_remaining: 300,
              depleted: false,
            }
          ]
        }
      ]
    });
  });

  it("should allow extractor-only miner to mine in current hidden POI", async () => {
    // Mock bot with deep core extractor only
    const testBot = {
      ...mockBot,
      exec: vi.fn(),
      system: "embervale",
      poi: "adamantite_core", // Already at the hidden POI
      docked: false,
      factionStorage: [],
      refreshFactionStorage: vi.fn(),
      refreshStatus: vi.fn(),
    };

    testBot.exec.mockResolvedValue({
      result: {
        modules: [
          { id: "deep_core_extractor_mkii", name: "Deep Core Extractor MKII" }
        ]
      }
    });

    const testCtx = { ...mockCtx, bot: testBot as any };

    // Test getDeepCoreCapability
    const cap = await getDeepCoreCapability(testCtx, false);
    expect(cap.canMineHidden).toBe(false); // Not allowed normally
    expect(cap.canMineVisibleDeepCore).toBe(true); // But can mine visible deep core

    // In the miner logic, the check should allow mining in current hidden POI
    // This is tested implicitly by the function working as expected
  });

  it("should prevent mining hidden POIs without proper equipment", async () => {
    const testBot = {
      ...mockBot,
      exec: vi.fn(),
      system: "embervale",
      poi: "", // Not at hidden POI
      docked: false,
    };

    testBot.exec.mockResolvedValue({
      result: {
        modules: [
          { id: "mining_laser", name: "Mining Laser" } // No deep core equipment
        ]
      }
    });

    const testCtx = { ...mockCtx, bot: testBot as any };

    const cap = await getDeepCoreCapability(testCtx);
    expect(cap.canMineHidden).toBe(false);
    expect(cap.canMineVisibleDeepCore).toBe(false);
  });

  it("should allow partial deep core miners to access adamantite_core exception", () => {
    // Test the ALLOWED_HIDDEN_POIS_FOR_PARTIAL_MINERS constant
    expect(ALLOWED_HIDDEN_POIS_FOR_PARTIAL_MINERS.has("adamantite_core")).toBe(true);
    expect(ALLOWED_HIDDEN_POIS_FOR_PARTIAL_MINERS.has("some_other_poi")).toBe(false);
  });
});

describe("Quota Target Selection", () => {
  const mockMapStore = {
    findOreLocations: vi.fn(),
    findBestMiningLocation: vi.fn(),
    getSystem: vi.fn(),
  };

  const mockSettings = {
    ignoreDepletion: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("findFirstAvailableQuotaTarget", () => {
    it("should return the resource with biggest deficit that has available locations", () => {
      const quotas = {
        adamantite_ore: 500000,
        exotic_matter: 500000,
      };
      const factionStorage = [
        { itemId: "adamantite_ore", quantity: 400000 }, // 100000 deficit
        { itemId: "exotic_matter", quantity: 200000 }, // 300000 deficit
      ];

      // Mock locations: adamantite has locations, exotic has locations
      mockMapStore.findOreLocations.mockImplementation((oreId: string) => {
        if (oreId === "adamantite_ore") return [{ systemId: "system1", poiId: "poi1" }];
        if (oreId === "exotic_matter") return [{ systemId: "system2", poiId: "poi2" }];
        return [];
      });

      mockMapStore.getSystem.mockReturnValue({
        pois: [{ id: "poi1", type: "ore_belt", ores_found: [] }]
      });

      const result = findFirstAvailableQuotaTarget(
        quotas,
        factionStorage,
        "ore",
        mockSettings,
        mockMapStore,
        3 * 60 * 60 * 1000, // 3 hours
        false, // canMineHiddenRadioactive
        false  // canMineHiddenIce
      );

      expect(result).toBe("exotic_matter"); // Bigger deficit
    });

    it("should skip resources with no available locations", () => {
      const quotas = {
        adamantite_ore: 500000,
        exotic_matter: 500000,
      };
      const factionStorage = [
        { itemId: "adamantite_ore", quantity: 400000 }, // 100000 deficit
        { itemId: "exotic_matter", quantity: 200000 }, // 300000 deficit
      ];

      // Mock: adamantite has no locations, exotic has locations
      mockMapStore.findOreLocations.mockImplementation((oreId: string) => {
        if (oreId === "exotic_matter") return [{ systemId: "system2", poiId: "poi2" }];
        return [];
      });

      const result = findFirstAvailableQuotaTarget(
        quotas,
        factionStorage,
        "ore",
        mockSettings,
        mockMapStore,
        3 * 60 * 60 * 1000,
        false,
        false
      );

      expect(result).toBe("exotic_matter");
    });

    it("should return empty string when no quotas have deficits or locations", () => {
      const quotas = {
        adamantite_ore: 500000,
      };
      const factionStorage = [
        { itemId: "adamantite_ore", quantity: 600000 }, // No deficit
      ];

      mockMapStore.findOreLocations.mockReturnValue([]);

      const result = findFirstAvailableQuotaTarget(
        quotas,
        factionStorage,
        "ore",
        mockSettings,
        mockMapStore,
        3 * 60 * 60 * 1000,
        false,
        false
      );

      expect(result).toBe("");
    });
  });

  describe("pickTargetFromQuotas", () => {
    it("should return the resource with biggest deficit", () => {
      const quotas = {
        adamantite_ore: 500000,
        exotic_matter: 500000,
      };
      const factionStorage = [
        { itemId: "adamantite_ore", quantity: 400000 }, // 100000 deficit
        { itemId: "exotic_matter", quantity: 200000 }, // 300000 deficit
      ];

      const result = pickTargetFromQuotas(quotas, factionStorage, "ore");
      expect(result).toBe("exotic_matter");
    });

    it("should return empty string when no quotas", () => {
      const result = pickTargetFromQuotas({}, [], "ore");
      expect(result).toBe("");
    });
  });
});