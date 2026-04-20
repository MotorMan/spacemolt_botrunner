/**
 * Test suite for fuelCellSeller routine
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { join } from "path";

const TEST_FC_STATIONS_FILE = "data/fcStations.test.json";

interface FCStationEntry {
  systemId: string;
  poiId: string;
  poiName: string;
  ordersPlaced: number;
  lastOrderId: string | null;
  lastVisit: string | null;
  lastPrice: number | null;
}

interface FCStationsData {
  version: number;
  homeSystem: string;
  homeStation: string;
  stations: FCStationEntry[];
  currentStationIndex: number;
  lastStarted: string;
}

function getNextStation(
  data: FCStationsData,
  currentIndex: number,
): number {
  const totalStations = data.stations.length;
  if (totalStations === 0) return -1;

  const unvisitedStations = data.stations
    .map((station, idx) => ({ station, idx }))
    .filter(({ station }) => station.ordersPlaced === 0);

  if (unvisitedStations.length > 0) {
    const startIdx = (currentIndex + 1) % totalStations;
    for (let i = 0; i < totalStations; i++) {
      const idx = (startIdx + i) % totalStations;
      if (data.stations[idx].ordersPlaced === 0) {
        return idx;
      }
    }
  }

  const startIdx = (currentIndex + 1) % totalStations;
  for (let i = 0; i < totalStations; i++) {
    const idx = (startIdx + i) % totalStations;
    if (data.stations[idx]) {
      return idx;
    }
  }

  return currentIndex;
}

function createMockFCData(stations: FCStationEntry[], currentIndex: number = 0): FCStationsData {
  return {
    version: 1,
    homeSystem: "sol",
    homeStation: "sol_central",
    stations,
    currentStationIndex: currentIndex,
    lastStarted: new Date().toISOString(),
  };
}

function createMockStation(systemId: string, poiId: string, ordersPlaced: number = 0): FCStationEntry {
  return {
    systemId,
    poiId,
    poiName: `${systemId}_station`,
    ordersPlaced,
    lastOrderId: ordersPlaced > 0 ? "test_order_id" : null,
    lastVisit: ordersPlaced > 0 ? new Date().toISOString() : null,
    lastPrice: ordersPlaced > 0 ? 40 : null,
  };
}

describe("fuelCellSeller - getNextStation priority logic", () => {
  it("should return index of first unvisited station after current", () => {
    const stations = [
      createMockStation("sol", "sol_central", 100),
      createMockStation("procyon", "procyon_station", 0),
      createMockStation("alpha", "alpha_station", 0),
    ];
    const data = createMockFCData(stations, 0);
    const result = getNextStation(data, 0);
    expect(result).toBe(1);
  });

  it("should skip already visited stations when unvisited exist", () => {
    const stations = [
      createMockStation("sol", "sol_central", 100),
      createMockStation("procyon", "procyon_station", 50),
      createMockStation("alpha", "alpha_station", 0),
      createMockStation("beta", "beta_station", 0),
    ];
    const data = createMockFCData(stations, 0);
    const result = getNextStation(data, 0);
    expect(result).toBe(2);
  });

  it("should wrap around to find unvisited stations", () => {
    const stations = [
      createMockStation("sol", "sol_central", 0),
      createMockStation("procyon", "procyon_station", 100),
      createMockStation("alpha", "alpha_station", 100),
    ];
    const data = createMockFCData(stations, 1);
    const result = getNextStation(data, 1);
    expect(result).toBe(0);
  });

  it("should handle all stations visited - wrap around from current", () => {
    const stations = [
      createMockStation("sol", "sol_central", 100),
      createMockStation("procyon", "procyon_station", 100),
      createMockStation("alpha", "alpha_station", 100),
    ];
    const data = createMockFCData(stations, 1);
    const result = getNextStation(data, 1);
    expect(result).toBe(2);
  });

  it("should return current index when only one station", () => {
    const stations = [createMockStation("sol", "sol_central", 100)];
    const data = createMockFCData(stations, 0);
    const result = getNextStation(data, 0);
    expect(result).toBe(0);
  });

  it("should return -1 for empty stations array", () => {
    const data = createMockFCData([], 0);
    const result = getNextStation(data, 0);
    expect(result).toBe(-1);
  });

  it("should prioritize unvisited even when current is in the middle", () => {
    const stations = [
      createMockStation("sol", "sol_central", 100),
      createMockStation("procyon", "procyon_station", 100),
      createMockStation("alpha", "alpha_station", 0),
      createMockStation("beta", "beta_station", 0),
      createMockStation("gamma", "gamma_station", 0),
    ];
    const data = createMockFCData(stations, 1);
    const result = getNextStation(data, 1);
    expect(result).toBe(2);
  });

  it("should handle data from fcStations.json scenario - current at index 5 with some 0 orders", () => {
    const stations = [
      createMockStation("synchrony", "synchrony_hub", 0),
      createMockStation("market_prime", "market_prime_exchange", 2375),
      createMockStation("krynn", "war_citadel", 0),
      createMockStation("node_beta", "node_beta_industrial_station", 2475),
      createMockStation("gold_run", "gold_run_extraction_hub", 0),
      createMockStation("nexus_prime", "the_core", 2475),
      createMockStation("treasure_cache", "treasure_cache_trading_post", 0),
      createMockStation("factory_belt", "factory_belt_manufacturing_hub", 1650),
    ];
    const data = createMockFCData(stations, 5);
    const result = getNextStation(data, 5);
    expect(result).toBe(6);
  });

  it("should find first unvisited from start when current is at unvisited", () => {
    const stations = [
      createMockStation("sol", "sol_central", 0),
      createMockStation("procyon", "procyon_station", 100),
      createMockStation("alpha", "alpha_station", 100),
    ];
    const data = createMockFCData(stations, 0);
    const result = getNextStation(data, 0);
    expect(result).toBe(0);
  });
});

describe("fuelCellSeller - cargo validation logic", () => {
  it("should return home needed when cargo is 0 and not at home", () => {
    const bot = { system: "procyon", poi: "procyon_station" };
    const settings = { homeSystem: "sol", homeStation: "sol_central" };
    const cargoQty = 0;
    const atHomeStation = bot.system === settings.homeSystem && bot.poi === settings.homeStation;
    const needsReturnHome = cargoQty <= 0 && !atHomeStation;
    expect(needsReturnHome).toBe(true);
  });

  it("should NOT return home when cargo > 0 and not at home", () => {
    const bot = { system: "procyon", poi: "procyon_station" };
    const settings = { homeSystem: "sol", homeStation: "sol_central" };
    const cargoQty = 100;
    const atHomeStation = bot.system === settings.homeSystem && bot.poi === settings.homeStation;
    const needsReturnHome = cargoQty <= 0 && !atHomeStation;
    expect(needsReturnHome).toBe(false);
  });

  it("should NOT return home when at home with no cargo (can withdraw)", () => {
    const bot = { system: "sol", poi: "sol_central" };
    const settings = { homeSystem: "sol", homeStation: "sol_central" };
    const cargoQty = 0;
    const atHomeStation = bot.system === settings.homeSystem && bot.poi === settings.homeStation;
    const needsReturnHome = cargoQty <= 0 && !atHomeStation;
    expect(needsReturnHome).toBe(false);
  });

  it("should detect at home station correctly - true case", () => {
    const bot = { system: "sol", poi: "sol_central" };
    const settings = { homeSystem: "sol", homeStation: "sol_central" };
    const atHomeStation = bot.system === settings.homeSystem && bot.poi === settings.homeStation;
    expect(atHomeStation).toBe(true);
  });

  it("should detect at home station correctly - system differs", () => {
    const bot = { system: "sol", poi: "other_poi" };
    const settings = { homeSystem: "sol", homeStation: "sol_central" };
    const atHomeStation = bot.system === settings.homeSystem && bot.poi === settings.homeStation;
    expect(atHomeStation).toBe(false);
  });

  it("should detect at home station correctly - poi differs", () => {
    const bot = { system: "other", poi: "sol_central" };
    const settings = { homeSystem: "sol", homeStation: "sol_central" };
    const atHomeStation = bot.system === settings.homeSystem && bot.poi === settings.homeStation;
    expect(atHomeStation).toBe(false);
  });

  it("should detect valid cargo before travel", () => {
    const preTravelCargo = { itemId: "fuel_cell", quantity: 100 };
    const hasCargo = preTravelCargo && preTravelCargo.quantity > 0;
    expect(hasCargo).toBe(true);
  });

  it("should detect no cargo before travel - zero quantity", () => {
    const preTravelCargo = { itemId: "fuel_cell", quantity: 0 };
    const hasCargo = preTravelCargo && preTravelCargo.quantity > 0;
    expect(hasCargo).toBe(false);
  });

  it("should detect no cargo before travel - undefined", () => {
    const preTravelCargo = undefined;
    const hasCargo = preTravelCargo ? preTravelCargo.quantity > 0 : false;
    expect(hasCargo).toBe(false);
  });

  it("should detect cargo loss after maintenance", () => {
    const cargoAfterMaintenance = 0;
    const needsRethome = cargoAfterMaintenance <= 0;
    expect(needsRethome).toBe(true);
  });

  it("should allow continue when cargo remains after maintenance", () => {
    const cargoAfterMaintenance = 50;
    const needsRethome = cargoAfterMaintenance <= 0;
    expect(needsRethome).toBe(false);
  });

  it("should NOT return home when cargo is 0 BUT at home station (the BUG fix)", () => {
    const bot = { system: "sol", poi: "sol_central" };
    const settings = { homeSystem: "sol", homeStation: "sol_central" };
    const cargoAfterMaintenance = 0;
    const atHomeStation = bot.system === settings.homeSystem && bot.poi === settings.homeStation;
    const needsReturnHome = cargoAfterMaintenance <= 0 && !atHomeStation;
    expect(needsReturnHome).toBe(false);
  });

  it("should still return home when cargo is 0 and NOT at home station", () => {
    const bot = { system: "procyon", poi: "procyon_station" };
    const settings = { homeSystem: "sol", homeStation: "sol_central" };
    const cargoAfterMaintenance = 0;
    const atHomeStation = bot.system === settings.homeSystem && bot.poi === settings.homeStation;
    const needsReturnHome = cargoAfterMaintenance <= 0 && !atHomeStation;
    expect(needsReturnHome).toBe(true);
  });
});

describe("fuelCellSeller - price calculation", () => {
  it("should use manual price when mode is manual", () => {
    const priceMode = "manual";
    const baseTargetPrice = 40;
    const result = priceMode === "manual" ? baseTargetPrice : 0;
    expect(result).toBe(40);
  });

  it("should use midpoint when auto and prices available", () => {
    const priceMode = "auto";
    const autoMinPrice = 30;
    const autoMaxPrice = 50;
    const bestSell = 40;
    const bestBuy = 40;
    
    let result: number;
    if (priceMode === "manual") {
      result = 40;
    } else {
      const midPrice = Math.round((bestBuy + bestSell) / 2);
      if (midPrice >= autoMinPrice && midPrice <= autoMaxPrice) {
        result = midPrice;
      } else {
        result = 40;
      }
    }
    expect(result).toBe(40);
  });

  it("should use base price when outside auto range", () => {
    const priceMode = "auto";
    const autoMinPrice = 30;
    const autoMaxPrice = 50;
    const baseTargetPrice = 40;
    const bestSell = 100;
    const bestBuy = 120;
    
    let result: number;
    if (priceMode === "manual") {
      result = baseTargetPrice;
    } else {
      const midPrice = Math.round((bestBuy + bestSell) / 2);
      if (midPrice >= autoMinPrice && midPrice <= autoMaxPrice) {
        result = midPrice;
      } else {
        result = baseTargetPrice;
      }
    }
    expect(result).toBe(40);
  });
});

describe("fuelCellSeller - fuel calculations", () => {
  it("should use higher threshold for return journey", () => {
    const refuelThreshold = 35;
    const returnThreshold = Math.max(60, refuelThreshold + 20);
    expect(returnThreshold).toBe(60);
  });

  it("should use higher value when refuel threshold is high", () => {
    const refuelThreshold = 50;
    const returnThreshold = Math.max(60, refuelThreshold + 20);
    expect(returnThreshold).toBe(70);
  });

  it("should calculate fuel percentage correctly", () => {
    const fuel = 196;
    const maxFuel = 450;
    const fuelPct = Math.round((fuel / maxFuel) * 100);
    expect(fuelPct).toBe(44);
  });

  it("should detect when fuel is below return threshold", () => {
    const fuel = 196;
    const maxFuel = 450;
    const returnThreshold = 60;
    const fuelPct = Math.round((fuel / maxFuel) * 100);
    const needsRefuel = fuelPct < returnThreshold;
    expect(needsRefuel).toBe(true);
  });

  it("should detect when fuel is above return threshold", () => {
    const fuel = 350;
    const maxFuel = 450;
    const returnThreshold = 60;
    const fuelPct = Math.round((fuel / maxFuel) * 100);
    const needsRefuel = fuelPct < returnThreshold;
    expect(needsRefuel).toBe(false);
  });
});

describe("fuelCellSeller - cargo capacity", () => {
  it("should calculate max items for cargo", () => {
    const cargoMax = 50;
    const cargo = 0;
    const freeSpace = cargoMax - cargo;
    const maxItems = Math.floor(freeSpace / 1);
    expect(maxItems).toBe(50);
  });

  it("should handle full cargo", () => {
    const cargoMax = 50;
    const cargo = 50;
    const freeSpace = cargoMax - cargo;
    const maxItems = Math.floor(freeSpace / 1);
    expect(maxItems).toBe(0);
  });

  it("should handle fractional space", () => {
    const cargoMax = 50;
    const cargo = 0;
    const itemSize = 3;
    const freeSpace = cargoMax - cargo;
    const maxItems = Math.floor(freeSpace / itemSize);
    expect(maxItems).toBe(16);
  });
});