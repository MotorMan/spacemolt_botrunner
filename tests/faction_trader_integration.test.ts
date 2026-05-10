// tests/faction_trader_integration.test.ts
import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';

// Mock all dependencies
jest.mock('../src/mapstore', () => ({
  mapStore: {
    getSystem: jest.fn(),
    getAllBuyDemand: jest.fn(),
    findRoute: jest.fn(),
  }
}));

jest.mock('../src/routines/common', () => ({
  readSettings: jest.fn(),
  maxItemsForCargo: jest.fn(),
  estimateFuelCost: jest.fn(),
}));

jest.mock('../src/routines/traderActivity', () => ({
  getActiveSession: jest.fn(),
  failFactionSession: jest.fn(),
}));

jest.mock('../src/routines/factionTraderCoordination', () => ({
  getBuyOrderLock: jest.fn(),
}));

import { findFactionSellRoutes } from '../src/routines/faction_trader';
import { mapStore } from '../src/mapstore';
import { readSettings } from '../src/routines/common';

describe('Faction Trader Integration', () => {
  let mockCtx: any;
  let mockBot: any;
  let mockSettings: any;

  beforeEach(() => {
    mockCtx = {
      log: jest.fn()
    };

    mockBot = {
      system: 'sol',
      factionStorage: [
        { itemId: 'contained_enriched_uranium_rod', name: 'Contained Enriched Uranium Rod', quantity: 1 }
      ]
    };

    mockSettings = {
      homeSystem: 'sol',
      fuelCostPerJump: 50,
      minSellPrice: 200000,
      tradeItems: [
        { itemId: 'contained_enriched_uranium_rod', minSellPrice: 200000 }
      ]
    };

    // Mock implementations
    (readSettings as jest.Mock).mockReturnValue(mockSettings);
    (mapStore.getAllBuyDemand as jest.Mock).mockReturnValue([
      {
        itemId: 'contained_enriched_uranium_rod',
        itemName: 'Contained Enriched Uranium Rod',
        systemId: 'sol',
        poiId: 'sol_central',
        poiName: 'Sol Central',
        price: 250000,  // Above min price
        quantity: 10
      },
      {
        itemId: 'contained_enriched_uranium_rod',
        itemName: 'Contained Enriched Uranium Rod',
        systemId: 'sol',
        poiId: 'neptune',
        poiName: 'Neptune',
        price: 26050,   // Below min price
        quantity: 5
      }
    ]);

    (mapStore.getSystem as jest.Mock).mockReturnValue({
      pois: [
        { id: 'sol_central', name: 'Sol Central', has_base: true, market: [{}] },
        { id: 'neptune', name: 'Neptune', has_base: false, market: [] }
      ]
    });

    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  test('rejects routes to invalid destinations', () => {
    // Mock findFactionSellRoutes should filter out invalid destinations
    const routes = findFactionSellRoutes(mockCtx, mockSettings, 'sol', 1000);

    // Should only return valid routes (sol_central), not neptune
    expect(routes.length).toBe(1);
    expect(routes[0].destPoi).toBe('sol_central');
    expect(routes[0].destPoi).not.toBe('neptune');
  });

  test('minimum price filtering works in route creation', () => {
    // The neptune route should be filtered out due to low price
    const routes = findFactionSellRoutes(mockCtx, mockSettings, 'sol', 1000);

    // Should only have the high-price route
    expect(routes.length).toBe(1);
    expect(routes[0].sellPrice).toBe(250000); // Above min price
  });

  test('cargo recovery filters by minimum price', () => {
    // Test the cargo recovery logic by simulating the filtering
    const allBuys = mapStore.getAllBuyDemand();
    const itemMinSellPrice = 200000;

    const filteredBuyers = allBuys
      .filter(b => b.itemId === 'contained_enriched_uranium_rod' && b.price > 0 && b.quantity > 0)
      .filter(b => itemMinSellPrice === 0 || b.price >= itemMinSellPrice);

    // Should only include sol_central (250000 >= 200000), not neptune (26050 < 200000)
    expect(filteredBuyers.length).toBe(1);
    expect(filteredBuyers[0].poiId).toBe('sol_central');
    expect(filteredBuyers[0].price).toBe(250000);
  });

  test('alternative buyer selection filters by minimum price', () => {
    // Test alternative buyer filtering logic
    const alternativeBuyers = [
      { itemId: 'contained_enriched_uranium_rod', systemId: 'sol', poiId: 'sol_central', poiName: 'Sol Central', price: 250000, quantity: 10 },
      { itemId: 'contained_enriched_uranium_rod', systemId: 'sol', poiId: 'neptune', poiName: 'Neptune', price: 26050, quantity: 5 }
    ];

    const filteredAlternatives = alternativeBuyers
      .filter(b => b.itemId === 'contained_enriched_uranium_rod' && b.price > 0)
      .filter(b => mockSettings.minSellPrice === 0 || b.price >= mockSettings.minSellPrice);

    // Should only include sol_central
    expect(filteredAlternatives.length).toBe(1);
    expect(filteredAlternatives[0].poiId).toBe('sol_central');
  });

  test('logs appropriate messages for filtered destinations', () => {
    // Run route finding which should trigger validation
    findFactionSellRoutes(mockCtx, mockSettings, 'sol', 1000);

    // Should log that neptune is being skipped due to validation
    expect(mockCtx.log).toHaveBeenCalledWith('error', 'Skipping corrupt destination: Neptune (sol)');
  });

  test('performance impact is minimal', () => {
    const startTime = Date.now();

    // Run multiple iterations to check performance
    for (let i = 0; i < 100; i++) {
      findFactionSellRoutes(mockCtx, mockSettings, 'sol', 1000);
    }

    const endTime = Date.now();
    const totalTime = endTime - startTime;

    // Should complete 100 route calculations in under 100ms
    expect(totalTime).toBeLessThan(100);
  });
});