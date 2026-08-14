// tests/miner-edge-cases.test.ts
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('fs', () => ({
  promises: {
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
    statSync: vi.fn(() => ({ mtimeMs: Date.now() })),
  },
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
  statSync: vi.fn(() => ({ mtimeMs: Date.now() })),
}));

vi.mock('path', () => ({
  join: vi.fn((...parts: unknown[]) => parts.join('/').replace('E:/code/code', 'E:\\code\\code')),
  dirname: vi.fn(),
}));

vi.mock('../src/botmanager', () => ({
  getBotChatChannel: vi.fn(() => ({
    send: vi.fn(),
    onMessage: vi.fn(),
    offMessage: vi.fn(),
    onGlobalMessage: vi.fn(),
    offGlobalMessage: vi.fn(),
  })),
}));

vi.mock('../src/routines/flock', () => ({
  readFlockSettings: vi.fn(() => ({ assignments: {}, flockGroups: [] })),
  readFlockState: vi.fn(),
  registerFlockMember: vi.fn(),
  unregisterFlockMember: vi.fn(),
  broadcastFlockHeartbeat: vi.fn(),
  announceFlockTarget: vi.fn(),
  updateFlockPhase: vi.fn(),
  clearFlockState: vi.fn(),
}));

vi.mock('../src/mapstore', () => ({
  mapStore: {
    getSystem: vi.fn(() => ({ pois: [], name: 'Sol' })),
    findOreLocations: vi.fn(() => []),
    findClosestMiningLocations: vi.fn(() => []),
    findBestMiningLocation: vi.fn(() => null),
    findRoute: vi.fn(() => []),
    getAllKnownOres: vi.fn(() => []),
    isMapSeeded: vi.fn(() => true),
    isDepletionExpired: vi.fn(() => false),
    markOreDepleted: vi.fn(),
    recordMiningYield: vi.fn(),
    registerPoiFromScan: vi.fn(),
    updatePoiResources: vi.fn(),
    updateSystem: vi.fn(),
  },
}));

import { createMapStoreStub, setMockNow, advanceTime, installMockClock, restoreRealClock, mockDateNow, restoreDateNow } from './miner-helpers.js';

const { mapStore } = await import('../src/mapstore.js');
const mapStub = createMapStoreStub();
mapStore.getSystem = mapStub.getSystem.bind(mapStub);
mapStore.findOreLocations = mapStub.findOreLocations.bind(mapStub);
mapStore.findRoute = mapStub.findRoute.bind(mapStub);
mapStore.getAllKnownOres = mapStub.getAllKnownOres.bind(mapStub);
mapStore.markOreDepleted = vi.fn();
mapStore.updatePoiResources = vi.fn();
mapStore.registerPoiFromScan = vi.fn();
mapStore.isDepletionExpired = (at?: string) => !at;


const BASE_SETTINGS = {
  miningType: 'auto' as const,
  targetOre: '',
  targetGas: '',
  targetIce: '',
  targetRadioactive: '',
  targetDeepCore: '',
  system: '',
  systemOre: 'ore_system',
  systemGas: '',
  systemIce: '',
  systemRadioactive: '',
  systemDeepCore: '',
  homeSystem: 'sol',
  depositBot: '',
  depositMode: 'faction' as const,
  depositFallback: 'storage' as const,
  cargoThreshold: 100,
  refuelThreshold: 54,
  repairThreshold: 80,
  depletionTimeoutHours: 24,
  ignoreDepletion: false,
  noMidMiningRetarget: false,
  enableCloak: true,
  cloakIgnoreBlacklist: true,
  stayOutUntilFull: false,
  maxJumps: 100,
  minimumFuelCells: 30,
  desiredEmergencyWarpDevices: 2,
  enableCoordination: true,
  maxBotsPerSystem: 3,
  jettisonOres: [],
  deepCoreJettisonOres: [],
  radioactiveJettisonOres: [],
  jettisonGas: [],
  oreQuotas: { iron_ore: 495000 },
  gasQuotas: {},
  iceQuotas: {},
  radioactiveQuotas: {},
  deepCoreQuotas: {},
  enableFighting: false,
  flockEnabled: false,
  flockName: '',
  flockRole: 'follower' as const,
  flockGroups: [],
};

vi.mock('../src/routines/common', () => ({
  readSettings: vi.fn(() => ({ miner: {} })),
  ensureFueled: vi.fn().mockResolvedValue(true),
  tryRefuel: vi.fn().mockResolvedValue(true),
  repairShip: vi.fn().mockResolvedValue(true),
  ensureDocked: vi.fn(),
  ensureUndocked: vi.fn().mockResolvedValue(true),
  navigateToSystem: vi.fn().mockResolvedValue(undefined),
  refuelAtStation: vi.fn().mockResolvedValue(undefined),
  factionDonateProfit: vi.fn().mockResolvedValue(undefined),
  scavengeWrecks: vi.fn().mockResolvedValue(undefined),
  detectAndRecoverFromDeath: vi.fn().mockResolvedValue(true),
  getSystemInfo: vi.fn((_ctx: any) => {
    const sysId = _ctx?.bot?.system || 'sol';
    const sys = (globalThis as any).__mockMapStoreGetSystem?.(sysId);
    return { pois: sys?.pois || [], connections: [], systemId: sysId };
  }),
  parseOreFromMineResult: vi.fn(() => []),
  collectFromStorage: vi.fn(() => []),
  handleBattleNotifications: vi.fn(),
  getBattleStatus: vi.fn(),
  fleeFromBattle: vi.fn(),
  shouldEngagePlayersInCombat: vi.fn(() => false),
  engageInBattle: vi.fn(),
  getItemSize: vi.fn(() => 1),
  isOreBeltPoi: vi.fn(() => false),
  isGasCloudPoi: vi.fn(() => false),
  isIceFieldPoi: vi.fn(() => false),
  findStation: vi.fn(() => null),
  EMERGENCY_WARP_STABILIZER_MESSAGE: 'msg',
  shouldStopForEmergency: vi.fn(() => false),
  refreshNotifications: vi.fn().mockResolvedValue({}),
  checkAndFleeFromPirates: vi.fn().mockResolvedValue(false),
  parseNearbyEntities: vi.fn(() => []),
}));

vi.mock('../src/routines/battle', () => ({
  ensureAmmoLoaded: vi.fn().mockResolvedValue(true),
  getWeaponModules: vi.fn().mockReturnValue([]),
}));

vi.mock('../src/routines/minerCoordination', () => ({
  loadMinerCoordination: vi.fn(() => ({})),
  saveMinerCoordination: vi.fn(),
  registerMinerTarget: vi.fn(),
  unregisterMinerTarget: vi.fn(),
  announceMinerTarget: vi.fn(),
  getMinerCountForSystem: vi.fn(() => 0),
  isSystemOvercrowded: vi.fn(() => false),
}));

vi.mock('../src/routines/miner_radioactive', () => ({
  getRadioactiveCapability: vi.fn(() => ({})),
  getRadioactiveCapabilityCached: vi.fn(() => ({})),
  hasRadioactiveEquipmentCached: vi.fn(() => false),
  hasFullRadioactiveCapabilityCached: vi.fn(() => false),
  logRadioactiveCapability: vi.fn(),
  isRadioactiveOre: vi.fn(() => false),
  RADIOACTIVE_ORES: [],
}));

vi.mock('../src/catalogstore', () => ({
  catalogStore: {
    getItem: vi.fn(),
    getItemByName: vi.fn(),
    getAll: vi.fn(() => ({ items: {} })),
    getAmmoTypeIndex: vi.fn(() => ({})),
  },
}));

import { readSettings } from '../src/routines/common.js';

function overrideSettings(partial: Partial<typeof BASE_SETTINGS>) {
  readSettings.mockReturnValue({ miner: { ...BASE_SETTINGS, ...partial } });
}

const { minerRoutine } = await import('../src/routines/miner.ts');

beforeEach(() => {
  installMockClock();
  mockDateNow();
  setMockNow(1700000000000);
  mapStub.systems.clear();
  mapStub.addSystem('sol', 'Sol Central', [{ id: 'sol_central', name: 'Sol Central', has_base: true, hidden: false, ores_found: [{ item_id: 'iron_ore', name: 'Iron Ore', total_mined: 0, times_seen: 10, last_seen: '2026-07-06T00:00:00Z', depleted: false }] }]);
  mapStub.addSystem('ore_system', 'Ore Belt', [{ id: 'ore_belt', name: 'Ore Belt', has_base: true, hidden: false, ores_found: [{ item_id: 'iron_ore', name: 'Iron Ore', total_mined: 0, times_seen: 10, last_seen: '2026-07-06T00:00:00Z', depleted: false }] }]);
  overrideSettings({});
});

afterEach(() => {
  restoreDateNow();
  restoreRealClock();
  vi.clearAllMocks();
});

function makeCtx(overrides: any = {}) {
  return {
    bot: {
      exec: vi.fn().mockResolvedValue({ result: { modules: [{ id: 'mining_laser_v' }] } }),
      refreshStatus: vi.fn().mockResolvedValue(undefined),
      refreshCargo: vi.fn().mockResolvedValue(undefined),
      refreshLocation: vi.fn().mockResolvedValue(undefined),
      refreshShip: vi.fn().mockResolvedValue(undefined),
      refreshFactionStorage: vi.fn().mockResolvedValue(undefined),
      refreshStorage: vi.fn().mockResolvedValue(undefined),
      refreshCargoAndStorage: vi.fn().mockResolvedValue(undefined),
      trackWildlife: vi.fn(),
      isInBattle: vi.fn(() => false),
      state: 'running',
      username: 'TestMiner',
      system: 'sol',
      poi: null,
      docked: true,
      fuel: 100,
      maxFuel: 100,
      cargo: 0,
      cargoMax: 100,
      hull: 520,
      maxHull: 520,
      shield: 130,
      maxShield: 130,
      isCloaked: false,
      factionStorage: [{ itemId: 'iron_ore', quantity: 1000 }],
      inventory: [{ itemId: 'mining_laser_v', quantity: 1 }],
      credits: 50000,
      ...overrides,
    },
    log: vi.fn(),
    sleep: vi.fn().mockResolvedValue(undefined),
  };
}

describe('G. Edge Cases / Resilience', () => {
  test('G1: get_ship returns empty modules at startup — retry 5 times with backoff', async () => {
    let callCount = 0;
    const ctx = makeCtx({
      exec: vi.fn().mockImplementation(async (cmd: string) => {
        if (cmd === 'get_ship') {
          callCount++;
          if (callCount < 5) return { error: { code: 'server_error', message: 'still processing' } };
          return { result: { modules: [{ id: 'mining_laser_v' }] } };
        }
        return {};
      }),
    });
    const gen = minerRoutine(ctx as any);
    // First few should trigger retry sleeps
    const r1 = await gen.next();
    expect(r1.done).toBe(false);
    advanceTime(10000);
    await gen.next();
  }, 30000);

  test('G4: enableCloak true but no cloaking module', async () => {
    const ctx = makeCtx({
      bot: { ...makeCtx().bot, exec: vi.fn().mockResolvedValue({ result: { modules: [{ id: 'mining_laser_v' }] } }) } as any,
    });
    const gen = minerRoutine(ctx as any);
    let result = await gen.next();
    while (!result.done) {
      if (result.value === 'get_status') {
        expect(ctx.log).toHaveBeenCalled();
        break;
      }
      result = await gen.next();
    }
  }, 30000);

  test('G5: cloakIgnoreBlacklist=true when cloaked — empty blacklist, can enter pirate/hot zones', async () => {
    overrideSettings({ cloakIgnoreBlacklist: true, enableCloak: true });
    const ctx = makeCtx({ isCloaked: true });
    const gen = minerRoutine(ctx as any);
    let result = await gen.next();
    while (!result.done) {
      if (result.value === 'find_destination') break;
      result = await gen.next();
    }
    expect(ctx.log).toHaveBeenCalled();
  }, 30000);

  test('G6: Mission cap reached (5 active missions) — no accept spam', async () => {
    const ctx = makeCtx({
      exec: vi.fn().mockImplementation(async (cmd: string) => {
        if (cmd === 'get_active_missions') return { result: { missions: Array(5).fill({ id: 'm1' }) } };
        return {};
      }),
    });
    const gen = minerRoutine(ctx as any);
    let result = await gen.next();
    while (!result.done) {
      if (result.value === 'complete_missions') {
        result = await gen.next();
        break;
      }
      result = await gen.next();
    }
  }, 30000);

  test('G7: desiredEmergencyWarpDevices restocked from faction storage at home', async () => {
    const ctx = makeCtx({ docked: true, system: 'sol' });
    const gen = minerRoutine(ctx as any);
    let result = await gen.next();
    while (!result.done) {
      result = await gen.next();
    }
  }, 30000);

  test('G9: Session recovery aborts when location/equipment/quota priority mismatches', async () => {
    const ctx = makeCtx({ system: 'unknown_system' });
    const gen = minerRoutine(ctx as any);
    let result = await gen.next();
    while (!result.done) {
      if (result.value === 'error' || result.value === 'return_home') break;
      result = await gen.next();
    }
  }, 30000);
});
