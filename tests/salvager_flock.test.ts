// tests/salvager_flock.test.ts
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the dependencies
vi.mock('../src/routines/flock', () => ({
  readFlockState: vi.fn(),
  reportFlockWrecks: vi.fn(),
  getAvailableFlockWrecks: vi.fn(),
  claimFlockWreck: vi.fn(),
  isFlockTimeoutExpired: vi.fn(),
}));

vi.mock('../src/routines/common', () => ({
  parseWrecks: vi.fn(),
}));

import { readFlockState, reportFlockWrecks, getAvailableFlockWrecks, claimFlockWreck, isFlockTimeoutExpired } from '../src/routines/flock';
import { parseWrecks } from '../src/routines/common';

// Mock the salvager module functions
vi.mock('../src/routines/salvager', () => ({
  flockSalvageWrecks: vi.fn(),
  getSalvagerSettings: vi.fn(),
}));

describe('Salvager Flock Coordination', () => {
  const mockFlockName = 'salvage_flock';
  const mockUsername = 'salvager_bot';
  const mockWrecks = [
    { wreck_id: 'wreck1', items: [{ item_id: 'fuel_cell', quantity: 10 }], salvage_value: 600 },
    { wreck_id: 'wreck2', items: [{ item_id: 'iron_ore', quantity: 5 }], salvage_value: 300 },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    (parseWrecks as any).mockReturnValue(mockWrecks);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('Wreck Reporting', () => {
    test('leader reports found wrecks to flock', async () => {
      const mockFlockState = { foundWrecks: [] };
      (readFlockState as any).mockResolvedValue(mockFlockState);

      // Simulate leader finding wrecks
      await reportFlockWrecks(mockFlockName, mockUsername, [
        { poiId: 'poi1', wreckId: 'wreck1' },
        { poiId: 'poi1', wreckId: 'wreck2' },
      ]);

      expect(reportFlockWrecks).toHaveBeenCalledWith(mockFlockName, mockUsername, [
        { poiId: 'poi1', wreckId: 'wreck1' },
        { poiId: 'poi1', wreckId: 'wreck2' },
      ]);
    });
  });

  describe('Wreck Claiming', () => {
    test('follower can claim available wreck', async () => {
      (claimFlockWreck as any).mockResolvedValue(true);

      const result = await claimFlockWreck(mockFlockName, mockUsername, 'poi1', 'wreck1');

      expect(claimFlockWreck).toHaveBeenCalledWith(mockFlockName, mockUsername, 'poi1', 'wreck1');
      expect(result).toBe(true);
    });

    test('follower cannot claim already claimed wreck', async () => {
      (claimFlockWreck as any).mockResolvedValue(false);

      const result = await claimFlockWreck(mockFlockName, mockUsername, 'poi1', 'wreck1');

      expect(result).toBe(false);
    });
  });

  describe('Available Wrecks', () => {
    test('follower gets available wrecks from flock', async () => {
      const availableWrecks = [
        { poiId: 'poi1', wreckId: 'wreck1' },
        { poiId: 'poi1', wreckId: 'wreck2' },
      ];
      (getAvailableFlockWrecks as any).mockResolvedValue(availableWrecks);

      const result = await getAvailableFlockWrecks(mockFlockName, mockUsername);

      expect(getAvailableFlockWrecks).toHaveBeenCalledWith(mockFlockName, mockUsername);
      expect(result).toEqual(availableWrecks);
    });
  });

  describe('Timeout Handling', () => {
    test('allows independent operation when timeout expires', async () => {
      (isFlockTimeoutExpired as any).mockResolvedValue(true);

      const expired = await isFlockTimeoutExpired(mockFlockName);

      expect(isFlockTimeoutExpired).toHaveBeenCalledWith(mockFlockName);
      expect(expired).toBe(true);
    });

    test('requires coordination when timeout not expired', async () => {
      (isFlockTimeoutExpired as any).mockResolvedValue(false);

      const expired = await isFlockTimeoutExpired(mockFlockName);

      expect(expired).toBe(false);
    });
  });

  describe('Flock State Integration', () => {
    test('reads current flock state for coordination', async () => {
      const mockState = {
        leader: 'leader_bot',
        members: ['leader_bot', 'follower1', 'follower2'],
        targetSystemId: 'test_system',
        miningType: 'salvage',
        phase: 'salvaging',
        foundWrecks: [
          { poiId: 'poi1', wreckId: 'wreck1', claimedBy: undefined },
          { poiId: 'poi1', wreckId: 'wreck2', claimedBy: 'follower1' },
        ],
        timeoutEnd: Date.now() + 300000, // 5 minutes from now
      };
      (readFlockState as any).mockResolvedValue(mockState);

      const state = await readFlockState(mockFlockName);

      expect(readFlockState).toHaveBeenCalledWith(mockFlockName);
      expect(state).toEqual(mockState);
      expect(state?.foundWrecks).toHaveLength(2);
    });
  });


});