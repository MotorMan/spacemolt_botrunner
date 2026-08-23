// tests/fuel_cell_seller.test.ts
import { describe, test, expect, vi, beforeEach } from "vitest";

const PIRATE_SYSTEMS = ["alhena", "algol"];

vi.mock("../src/routines/common", () => ({
  ensureDocked: vi.fn(),
  ensureUndocked: vi.fn(),
  tryRefuel: vi.fn(),
  repairShip: vi.fn(),
  ensureFueled: vi.fn(),
  navigateToSystem: vi.fn(),
  detectAndRecoverFromDeath: vi.fn(),
  maxItemsForCargo: vi.fn(),
  readSettings: vi.fn(() => ({})),
  isPirateSystem: vi.fn((id: string) => PIRATE_SYSTEMS.includes(id.toLowerCase())),
  checkAndFleeFromBattle: vi.fn(),
  checkBattleAfterCommand: vi.fn(),
  travelToStationWithHint: vi.fn(),
  buildDeniedStationSet: vi.fn(() => new Set<string>()),
  markStationDenied: vi.fn(),
  getBattleStatus: vi.fn(),
  fleeFromBattle: vi.fn(),
}));

vi.mock("../src/web/server", () => ({
  getSystemBlacklist: vi.fn(() => []),
}));

const getSystem = vi.fn<(id: string) => unknown>(() => null);

vi.mock("../src/mapstore", () => ({
  mapStore: {
    getSystem: (id: string) => getSystem(id),
    getAllSystems: () => ({}),
    getMobileCapitolLocation: () => null,
    findRoute: () => null,
  },
}));

vi.mock("../src/client_sync_hooks", () => ({
  queryRemoteMarket: vi.fn(),
}));

import {
  classifyStationError,
  isStationBlacklisted,
  looksLikeOutpost,
  mapSaysNoMarket,
  evaluateStationSkip,
  partitionStations,
  describeSkips,
  type FCStationEntry,
  type FCStationsData,
} from "../src/routines/fuelCellSeller";

type FCSettings = Parameters<typeof evaluateStationSkip>[2];

const settings: FCSettings = {
  homeSystem: "sol",
  homeStation: "sol_central",
  fuelCostPerJump: 5,
  refuelThreshold: 35,
  repairThreshold: 80,
  priceMode: "auto",
  baseTargetPrice: 40,
  autoMinPrice: 30,
  autoMaxPrice: 50,
  maxFuelCellsPerStation: 20000,
  useRemoteMarketQuery: true,
  remoteCheckDelayMs: 500,
  remoteUpdateIntervalMs: 60 * 60 * 1000,
  skipOutposts: true,
  relearnMs: 168 * 60 * 60 * 1000,
};

function station(over: Partial<FCStationEntry> = {}): FCStationEntry {
  return {
    systemId: "procyon",
    poiId: "procyon_colonial_station",
    poiName: "Procyon Colonial Station",
    ordersPlaced: 0,
    ordersUnsold: 0,
    activeOrders: [],
    lastVisit: null,
    lastPrice: null,
    learnedSkip: null,
    learnedSkipAt: null,
    learnedSkipDetail: null,
    skipReason: null,
    ...over,
  };
}

function stationsData(stations: FCStationEntry[]): FCStationsData {
  return {
    version: 2,
    homeSystem: "sol",
    homeStation: "sol_central",
    stations,
    currentStationIndex: 0,
    lastStarted: new Date().toISOString(),
  };
}

const noFilters = { systems: new Set<string>(), stations: new Set<string>() };

describe("fuelCellSeller station screening", () => {
  beforeEach(() => {
    getSystem.mockReset();
    getSystem.mockReturnValue(null);
  });

  describe("classifyStationError", () => {
    test("recognizes the no-market answer", () => {
      expect(
        classifyStationError(
          "That station does not have a market. Use 'get_base' to see available services.",
        ),
      ).toBe("no_market");
      expect(classifyStationError("This base has no market")).toBe("no_market");
    });

    test("recognizes docking refusals", () => {
      expect(classifyStationError("Access denied")).toBe("dock_denied");
      expect(classifyStationError("Docking denied: base is restricted")).toBe("dock_denied");
      expect(classifyStationError("This base is not public")).toBe("dock_denied");
    });

    test("recognizes unknown stations", () => {
      expect(classifyStationError("Station not found")).toBe("unknown_station");
    });

    test("returns null for unrelated errors", () => {
      expect(classifyStationError("Rate limit exceeded")).toBeNull();
      expect(classifyStationError(undefined)).toBeNull();
      expect(classifyStationError("")).toBeNull();
    });

    test("never turns a transient condition into a permanent verdict", () => {
      expect(classifyStationError("Docking is restricted while in battle")).toBeNull();
      expect(classifyStationError("Access denied — command on cooldown, try again")).toBeNull();
    });
  });

  describe("isStationBlacklisted", () => {
    test("matches bare poi ids case-insensitively", () => {
      const set = new Set(["fortress_blackthorn"]);
      expect(isStationBlacklisted("blackthorn", "Fortress_Blackthorn", set)).toBe(true);
      expect(isStationBlacklisted("blackthorn", "other_station", set)).toBe(false);
    });

    test("matches system|poi keys", () => {
      const set = new Set(["blackthorn|fortress_blackthorn"]);
      expect(isStationBlacklisted("blackthorn", "fortress_blackthorn", set)).toBe(true);
      expect(isStationBlacklisted("sol", "fortress_blackthorn", set)).toBe(false);
    });

    test("an empty blacklist matches nothing", () => {
      expect(isStationBlacklisted("sol", "sol_central", new Set())).toBe(false);
    });
  });

  describe("looksLikeOutpost", () => {
    test("only the map base_type 'outpost' counts — never the player-chosen name", () => {
      // A faction outpost is only knowable from get_base (base_type: "outpost").
      // The name is meaningless: a player could call a real station "ENDL:libertas".
      expect(
        looksLikeOutpost({ systemId: "libertas", poiId: "abc123", poiName: "ENDL:libertas" }),
      ).toBe(false);
      getSystem.mockImplementation((id: string) => ({
        id,
        pois: [
          { id: "abc123", name: "ENDL:libertas", type: "station", base_type: "outpost", services: [], market: [] },
        ],
      }));
      expect(
        looksLikeOutpost({ systemId: "libertas", poiId: "abc123", poiName: "ENDL:libertas" }),
      ).toBe(true);
    });

    test("an ordinary station name is never flagged", () => {
      expect(
        looksLikeOutpost({ systemId: "crosshaven", poiId: "abc123", poiName: "Carnegie Hall" }),
      ).toBe(false);
      expect(
        looksLikeOutpost({ systemId: "void_gate", poiId: "void_gate_outpost", poiName: "Void Gate Outpost" }),
      ).toBe(false);
    });

    test("exempts NPC stations even when the map POI type looks like an outpost", () => {
      getSystem.mockImplementation((id: string) => ({
        id,
        pois: [
          { id: "void_gate_outpost", name: "Void Gate Outpost", type: "outpost", services: [], market: [] },
        ],
      }));
      // Void Gate Outpost is a real NPC station — never skip it.
      expect(
        looksLikeOutpost({ systemId: "void_gate", poiId: "void_gate_outpost", poiName: "Void Gate Outpost" }),
      ).toBe(false);
    });

    test("stations with recorded market data are never treated as outposts", () => {
      getSystem.mockImplementation((id: string) => ({
        id,
        pois: [
          {
            id: "abc123",
            name: "Whatever:name",
            type: "station",
            base_type: "outpost",
            services: [],
            market: [{ item_id: "fuel_cell" }],
          },
        ],
      }));
      expect(
        looksLikeOutpost({ systemId: "somewhere", poiId: "abc123", poiName: "Whatever:name" }),
      ).toBe(false);
    });
  });


  describe("mapSaysNoMarket", () => {
    test("only trusts an explicit service list", () => {
      expect(mapSaysNoMarket({ services: ["refuel", "repair"] } as never)).toBe(true);
      expect(mapSaysNoMarket({ services: ["refuel", "market"] } as never)).toBe(false);
      expect(mapSaysNoMarket({ services: [] } as never)).toBe(false);
      expect(mapSaysNoMarket(undefined)).toBe(false);
    });
  });

  describe("evaluateStationSkip", () => {
    test("passes an ordinary station", () => {
      const entry = station();
      expect(evaluateStationSkip(entry, stationsData([entry]), settings, noFilters)).toBeNull();
      expect(entry.skipReason).toBeNull();
    });

    test("skips pirate systems, blacklisted systems and blacklisted stations", () => {
      const pirate = station({ systemId: "algol", poiId: "dross_citadel", poiName: "Dross Citadel" });
      expect(evaluateStationSkip(pirate, stationsData([pirate]), settings, noFilters)).toBe("pirate_system");

      const inBadSystem = station({ systemId: "crosshaven", poiId: "carnegie_hall", poiName: "Carnegie Hall" });
      expect(
        evaluateStationSkip(inBadSystem, stationsData([inBadSystem]), settings, {
          systems: new Set(["crosshaven"]),
          stations: new Set<string>(),
        }),
      ).toBe("system_blacklisted");

      const blacklisted = station({ systemId: "blackthorn", poiId: "fortress_blackthorn", poiName: "Fortress Blackthorn" });
      expect(
        evaluateStationSkip(blacklisted, stationsData([blacklisted]), settings, {
          systems: new Set<string>(),
          stations: new Set(["fortress_blackthorn"]),
        }),
      ).toBe("station_blacklisted");
    });

    test("skips faction outposts (via map base_type) unless the setting is disabled", () => {
      const outpost = station({ systemId: "libertas", poiId: "endl_libertas", poiName: "ENDL:libertas" });
      getSystem.mockImplementation((id: string) => ({
        id,
        pois: [
          { id: "endl_libertas", name: "ENDL:libertas", type: "station", base_type: "outpost", services: [], market: [] },
        ],
      }));
      expect(evaluateStationSkip(outpost, stationsData([outpost]), settings, noFilters)).toBe("outpost");
      expect(
        evaluateStationSkip(outpost, stationsData([outpost]), { ...settings, skipOutposts: false }, noFilters),
      ).toBeNull();
    });

    test("honours a learned no-market verdict until the relearn window expires", () => {
      const now = Date.now();
      const entry = station({
        poiId: "carnegie_hall",
        poiName: "Carnegie Hall",
        learnedSkip: "no_market",
        learnedSkipAt: new Date(now - 60_000).toISOString(),
        learnedSkipDetail: "That station does not have a market.",
      });
      const data = stationsData([entry]);
      expect(evaluateStationSkip(entry, data, settings, noFilters, now)).toBe("no_market");

      // Past the window the verdict is cleared so the station gets one more try.
      const later = now + settings.relearnMs + 1000;
      expect(evaluateStationSkip(entry, data, settings, noFilters, later)).toBeNull();
      expect(entry.learnedSkip).toBeNull();
      expect(entry.learnedSkipAt).toBeNull();
      expect(entry.learnedSkipDetail).toBeNull();
    });

    test("retries unknown stations after a day, not a week", () => {
      const now = Date.now();
      const entry = station({
        learnedSkip: "unknown_station",
        learnedSkipAt: new Date(now - 25 * 60 * 60 * 1000).toISOString(),
      });
      expect(evaluateStationSkip(entry, stationsData([entry]), settings, noFilters, now)).toBeNull();
    });

    test("the configured home station ignores config-based exclusions", () => {
      const home = station({ systemId: "sol", poiId: "sol_central", poiName: "Sol Central" });
      expect(
        evaluateStationSkip(home, stationsData([home]), settings, {
          systems: new Set(["sol"]),
          stations: new Set(["sol_central"]),
        }),
      ).toBeNull();
    });

    test("the home station still respects a proven no-market answer", () => {
      const home = station({
        systemId: "sol",
        poiId: "sol_central",
        poiName: "Sol Central",
        learnedSkip: "no_market",
        learnedSkipAt: new Date().toISOString(),
      });
      expect(evaluateStationSkip(home, stationsData([home]), settings, noFilters)).toBe("no_market");
    });
  });

  describe("partitionStations", () => {
    test("splits sellable stations from skipped ones and tallies reasons", () => {
      const good = station();
      const alsoGood = station({ systemId: "sirius", poiId: "sirius_observatory_station", poiName: "Sirius Observatory Station" });
      const outpost = station({ systemId: "libertas", poiId: "endl_libertas", poiName: "ENDL:libertas" });
      getSystem.mockImplementation((id: string) => ({
        id,
        pois: [
          { id: "endl_libertas", name: "ENDL:libertas", type: "station", base_type: "outpost", services: [], market: [] },
        ],
      }));
      const noMarket = station({
        systemId: "crosshaven",
        poiId: "carnegie_hall",
        poiName: "Carnegie Hall",
        learnedSkip: "no_market",
        learnedSkipAt: new Date().toISOString(),
      });
      const restricted = station({ systemId: "blackthorn", poiId: "fortress_blackthorn", poiName: "Fortress Blackthorn" });

      const data = stationsData([good, outpost, alsoGood, noMarket, restricted]);
      const { eligible, skipped } = partitionStations(data, settings, {
        systems: new Set<string>(),
        stations: new Set(["fortress_blackthorn"]),
      });

      expect(eligible.map(e => e.entry.poiId)).toEqual([
        "procyon_colonial_station",
        "sirius_observatory_station",
      ]);
      expect(eligible.map(e => e.idx)).toEqual([0, 2]);
      expect(Object.fromEntries(skipped)).toEqual({
        outpost: 1,
        no_market: 1,
        station_blacklisted: 1,
      });
      expect(describeSkips(skipped)).toContain("1 faction outpost");
      expect(describeSkips(new Map())).toBe("none");
    });
  });
});
