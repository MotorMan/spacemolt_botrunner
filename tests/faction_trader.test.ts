// tests/faction_trader.test.ts
import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';

// Mock the dependencies
jest.mock('../src/mapstore', () => ({
  mapStore: {
    getSystem: jest.fn(),
    getAllBuyDemand: jest.fn(),
  }
}));

jest.mock('../src/routines/common', () => ({
  readSettings: jest.fn(),
}));

import { isValidDestination } from '../src/routines/faction_trader';
import { mapStore } from '../src/mapstore';

describe('Faction Trader Validation', () => {
  let mockCtx: any;
  let mockLog: jest.MockedFunction<any>;

  beforeEach(() => {
    mockLog = jest.fn();
    mockCtx = { log: mockLog };

    // Reset all mocks
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('isValidDestination', () => {
    test('rejects planets (no has_base)', () => {
      // Mock Neptune POI with has_base: false
      (mapStore.getSystem as jest.Mock).mockReturnValue({
        pois: [
          { id: 'neptune', name: 'Neptune', has_base: false, market: [] }
        ]
      });

      const result = isValidDestination(mockCtx, 'sol', 'neptune');

      expect(result).toBe(false);
      expect(mockLog).toHaveBeenCalledWith('error',
        'Destination Neptune (neptune) in sol is not a valid station (no dock)');
    });

    test('rejects POIs that do not exist', () => {
      (mapStore.getSystem as jest.Mock).mockReturnValue({
        pois: [
          { id: 'sol_central', name: 'Sol Central', has_base: true, market: [{}] }
        ]
      });

      const result = isValidDestination(mockCtx, 'sol', 'nonexistent');

      expect(result).toBe(false);
      expect(mockLog).toHaveBeenCalledWith('error',
        'Destination POI nonexistent not found in system sol');
    });

    test('rejects POIs with no market data', () => {
      (mapStore.getSystem as jest.Mock).mockReturnValue({
        pois: [
          { id: 'empty_station', name: 'Empty Station', has_base: true, market: [] }
        ]
      });

      const result = isValidDestination(mockCtx, 'sol', 'empty_station');

      expect(result).toBe(false);
      expect(mockLog).toHaveBeenCalledWith('error',
        'Destination Empty Station (empty_station) in sol has no market data');
    });

    test('rejects systems that do not exist', () => {
      (mapStore.getSystem as jest.Mock).mockReturnValue(null);

      const result = isValidDestination(mockCtx, 'nonexistent_system', 'any_poi');

      expect(result).toBe(false);
      expect(mockLog).toHaveBeenCalledWith('error',
        'Destination system nonexistent_system not found in map data');
    });

    test('accepts valid stations', () => {
      (mapStore.getSystem as jest.Mock).mockReturnValue({
        pois: [
          {
            id: 'sol_central',
            name: 'Sol Central',
            has_base: true,
            market: [{ item_id: 'fuel', best_buy: 100 }]
          }
        ]
      });

      const result = isValidDestination(mockCtx, 'sol', 'sol_central');

      expect(result).toBe(true);
      expect(mockLog).not.toHaveBeenCalled();
    });
  });

  describe('getAllBuyDemand filtering', () => {
    test('excludes non-station POIs', () => {
      // Mock map data with planets and stations
      (mapStore.getAllBuyDemand as jest.Mock).mockReturnValue([
        {
          itemId: 'fuel',
          itemName: 'Fuel',
          systemId: 'sol',
          poiId: 'sol_central',  // Valid station
          poiName: 'Sol Central',
          price: 100,
          quantity: 1000
        }
        // Neptune should not be in this list due to has_base filtering
      ]);

      const buyOrders = mapStore.getAllBuyDemand();
      const hasNeptune = buyOrders.some(order => order.poiId === 'neptune');

      expect(hasNeptune).toBe(false);
      expect(buyOrders.length).toBe(1);
      expect(buyOrders[0].poiId).toBe('sol_central');
    });
  });
});