import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
vi.mock('../src/routines/common.js', () => ({
  readSettings: vi.fn(),
  writeSettings: vi.fn(),
  findStation: vi.fn(),
  isStationPoi: vi.fn(),
  getSystemInfo: vi.fn(),
  ensureDocked: vi.fn(),
  ensureUndocked: vi.fn(),
  tryRefuel: vi.fn(),
  repairShip: vi.fn(),
  ensureFueled: vi.fn(),
  navigateToSystem: vi.fn(),
  fetchSecurityLevel: vi.fn(),
  scavengeWrecks: vi.fn(),
  depositNonFuelCargo: vi.fn(),
  ensureInsured: vi.fn(),
  detectAndRecoverFromDeath: vi.fn(),
  getModProfile: vi.fn(),
  ensureModsFitted: vi.fn(),
  logStatus: vi.fn(),
  getBattleStatus: vi.fn(),
  fleeFromBattle: vi.fn(),
  checkAndFleeFromBattle: vi.fn(),
  checkBattleAfterCommand: vi.fn(),
  collectFromStorage: vi.fn(),
  completeActiveMissions: vi.fn(),
  checkAndAcceptMissions: vi.fn(),
}));

vi.mock('../src/routines/battle.js', () => ({
  engageTarget: vi.fn(),
  parseNearby: vi.fn(),
  isPirateTarget: vi.fn(),
  ensureAmmoLoaded: vi.fn(),
}));

import { readSettings, writeSettings } from '../src/routines/common.js';
import { getFleetHunterSettings, setFleetHunterMode } from '../src/routines/fleet_hunter_commander.ts';

describe('Fleet Hunter Commander', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getFleetHunterSettings', () => {
    it('should return default settings when no settings exist', () => {
      (readSettings as any).mockReturnValue({});

      const settings = getFleetHunterSettings();

      expect(settings.mode).toBe('roam_systems');
      expect(settings.fleetId).toBe('default');
      expect(settings.huntingEnabled).toBe(true);
      expect(settings.manualMode).toBe(false);
    });

    it('should return saved settings', () => {
      (readSettings as any).mockReturnValue({
        fleet_hunter: {
          mode: 'stationary',
          fleetId: 'test-fleet',
          huntingEnabled: false,
          manualMode: true,
        },
      });

      const settings = getFleetHunterSettings();

      expect(settings.mode).toBe('stationary');
      expect(settings.fleetId).toBe('test-fleet');
      expect(settings.huntingEnabled).toBe(false);
      expect(settings.manualMode).toBe(true);
    });
  });

  describe('setFleetHunterMode', () => {
    it('should save the mode setting', () => {
      (writeSettings as any).mockImplementation(() => {});

      setFleetHunterMode('stationary');

      expect(writeSettings).toHaveBeenCalledWith({
        fleet_hunter: { mode: 'stationary' },
      });
    });
  });

  // Add more tests for routines, but since they are async generators, it's complex
  // For now, test the settings functions
});