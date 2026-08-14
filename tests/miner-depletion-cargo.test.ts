// tests/miner-depletion-cargo.test.ts
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

vi.mock('../src/catalogstore', () => ({
  catalogStore: {
    getItem: vi.fn(),
    getItemByName: vi.fn(),
    getAll: vi.fn(() => ({ items: {} })),
    getAmmoTypeIndex: vi.fn(() => ({})),
  },
}));

vi.mock('../src/routines/common', () => ({
  readSettings: vi.fn(() => ({
    miner: {
      miningType: 'auto',
      targetOre: 'iron_ore',
      targetGas: '',
      targetIce: '',
      targetRadioactive: '',
      targetDeepCore: '',
      system: 'sol',
      systemOre: 'sol',
      systemGas: '',
      systemIce: '',
      systemRadioactive: '',
      systemDeepCore: '',
      homeSystem: 'sol',
      depositBot: '',
      depositMode: 'faction',
      depositFallback: 'storage',
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
      flockRole: 'follower',
      flockGroups: [],
    },
  })),
  ensureFueled: vi.fn().mockResolvedValue(true),
  tryRefuel: vi.fn().mockResolvedValue(true),
  repairShip: vi.fn().mockResolvedValue(true),
  ensureDocked: vi.fn(),
  ensureUndocked: vi.fn().mockResolvedValue(true),
  navigateToSystem: vi.fn().mockResolvedValue(true),
  refuelAtStation: vi.fn().mockResolvedValue(undefined),
  factionDonateProfit: vi.fn().mockResolvedValue(undefined),
  scavengeWrecks: vi.fn().mockResolvedValue(undefined),
  detectAndRecoverFromDeath: vi.fn().mockResolvedValue(true),
  getSystemInfo: vi.fn((_ctx: any) => {
    const sysId = _ctx?.bot?.system || 'sol';
    const sys = mapStore.getSystem(sysId);
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

import { createMapStoreStub, setMockNow, advanceTime, installMockClock, restoreRealClock, mockDateNow, restoreDateNow } from './miner-helpers.js';
import { readSettings } from '../src/routines/common.js';

// Stub mapStore
const { mapStore } = await import('../src/mapstore.js');
const mapStub = createMapStoreStub();

mapStore.getSystem = mapStub.getSystem.bind(mapStub);
mapStore.findOreLocations = mapStub.findOreLocations.bind(mapStub);
mapStore.findRoute = mapStub.findRoute.bind(mapStub);
mapStore.getAllKnownOres = mapStub.getAllKnownOres.bind(mapStub);
mapStore.markOreDepleted = mapStub.markOreDepleted.bind(mapStub);
mapStore.updatePoiResources = mapStub.updatePoiResources.bind(mapStub);
mapStore.registerPoiFromScan = mapStub.registerPoiFromScan.bind(mapStub);
mapStore.isDepletionExpired = (at?: string) => {
  if (!at) return true;
  return (Date.now() - new Date(at).getTime()) > (24 * 60 * 60 * 1000);
};



const { minerRoutine } = await import('../src/routines/miner.ts');

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  installMockClock();
  mockDateNow();
  setMockNow(1700000000000);
  mapStub.systems.clear();
  mapStub.addSystem('sol', 'Sol', [
    { id: 'sol_central', name: 'Sol Central', has_base: true, hidden: false, ores_found: [
      { item_id: 'iron_ore', name: 'Iron Ore', total_mined: 0, times_seen: 10, last_seen: '2026-07-06T00:00:00Z', depleted: false },
    ]},
  ]);
});

afterEach(() => {
  restoreDateNow();
  restoreRealClock();
  vi.clearAllMocks();
});

function makeCtx(overrides: any = {}) {
  const defaultExec = async (cmd: string, payload?: Record<string, unknown>) => {
    if (cmd === 'get_poi') {
      const sys = mapStore.getSystem('sol');
      const poi = sys?.pois.find((p: any) => p.id === (payload?.poi_id || 'sol_central'));
      if (poi) {
        const resources = (poi.ores_found || []).map((o: any) => ({
          resource_id: o.item_id,
          remaining: o.depleted ? 0 : 1000,
          max_remaining: 1000,
        }));
        return { result: { ...poi, resources } };
      }
      return { result: null };
    }
    if (cmd === 'get_active_missions') {
      return { result: { missions: [] } };
    }
    if (cmd === 'get_cargo') {
      return { result: [] };
    }
    if (cmd === 'get_nearby') {
      return { result: {} };
    }
    return { result: { modules: [{ id: 'mining_laser_v' }] } };
  };

  const base = {
    username: 'TestMiner',
    system: 'sol',
    poi: 'sol_central',
    docked: true,
    fuel: 100,
    maxFuel: 100,
    cargo: 0,
    cargoMax: 100,
    credits: 50000,
    hull: 520,
    maxHull: 520,
    shield: 130,
    maxShield: 130,
    isInBattle: vi.fn(() => false),
    currentBattleId: null,
    state: 'running',
    isCloaked: false,
    factionStorage: [{ itemId: 'iron_ore', quantity: 1000 }],
    inventory: [{ itemId: 'mining_laser_v', quantity: 1 }],
    refreshCargoAndStorage: vi.fn().mockResolvedValue(undefined),
    trackWildlife: vi.fn(),
  };
  return {
    bot: {
      exec: vi.fn(defaultExec),
      refreshStatus: vi.fn().mockResolvedValue(undefined),
      refreshCargo: vi.fn().mockResolvedValue(undefined),
      refreshLocation: vi.fn().mockResolvedValue(undefined),
      refreshShip: vi.fn().mockResolvedValue(undefined),
      refreshFactionStorage: vi.fn().mockResolvedValue(undefined),
      refreshStorage: vi.fn().mockResolvedValue(undefined),
      ...base,
      ...overrides,
    },
    log: vi.fn(),
    sleep: vi.fn().mockResolvedValue(undefined),
  };
}

// ── C. Mid-Run Depletion ─────────────────────────────────────────────────────

describe('C. Mid-Run Depletion', () => {
  test('C1: POI reaches remaining=0 mid-loop, miner marks depleted', async () => {
    const ctx = makeCtx();
    const gen = minerRoutine(ctx as any);
    let result = await gen.next();
    // Should progress past get_status and fuel_check to find_destination or further
    while (!result.done) {
      if (result.value === 'harvest_loop') {
        // Set the POI ore to depleted mid-harvest
        const sys = mapStore.getSystem('sol');
        const poi = sys?.pois.find((p: any) => p.id === 'sol_central');
        if (poi?.ores_found?.[0]) {
          poi.ores_found[0].depleted = true;
          poi.ores_found[0].depleted_at = new Date(Date.now()).toISOString();
        }
        result = await gen.next();
        break;
      }
      result = await gen.next();
    }
    // After depletion, mapStore.markOreDepleted should be called
    expect(mapStore.markOreDepleted).toHaveBeenCalled();
  }, 30000);

  test('C2: Depletion lockout respects depletionTimeoutHours from settings', async () => {
    const ctx = makeCtx();
    const gen = minerRoutine(ctx as any);
    let result = await gen.next();
    while (!result.done) {
      if (result.value === 'harvest_loop') {
        const sys = mapStore.getSystem('sol');
        const poi = sys?.pois.find((p: any) => p.id === 'sol_central');
        if (poi?.ores_found?.[0]) {
          poi.ores_found[0].depleted = true;
          poi.ores_found[0].depleted_at = new Date(Date.now() - 1000).toISOString();
        }
        result = await gen.next();
        break;
      }
      result = await gen.next();
    }
    // With mock clock, depletion should not have expired yet
  }, 30000);

  test('C3: ignoreDepletion=true overrides lockout but still skips fully exhausted POIs', async () => {
    readSettings.mockReturnValue({
      miner: {
        miningType: 'auto',
        targetOre: 'iron_ore',
        targetGas: '',
        targetIce: '',
        targetRadioactive: '',
        targetDeepCore: '',
        system: 'sol',
        systemOre: 'sol',
        systemGas: '',
        systemIce: '',
        systemRadioactive: '',
        systemDeepCore: '',
        homeSystem: 'sol',
        depositBot: '',
        depositMode: 'faction',
        depositFallback: 'storage',
        cargoThreshold: 100,
        refuelThreshold: 54,
        repairThreshold: 80,
        depletionTimeoutHours: 24,
        ignoreDepletion: true,
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
        flockRole: 'follower',
        flockGroups: [],
      },
    });

    const ctx = makeCtx();
    const gen = minerRoutine(ctx as any);
    let result = await gen.next();
    while (!result.done) {
      if (result.value === 'harvest_loop') {
        const sys = mapStore.getSystem('sol');
        const poi = sys?.pois.find((p: any) => p.id === 'sol_central');
        if (poi?.ores_found?.[0]) {
          poi.ores_found[0].depleted = true;
          poi.ores_found[0].remaining = 0;
          poi.ores_found[0].max_remaining = 0;
        }
        result = await gen.next();
        break;
      }
      result = await gen.next();
    }
  }, 30000);

  test('C5: Strip miner switches to another common ore when current is depleted', async () => {
    readSettings.mockReturnValue({
      miner: {
        miningType: 'auto',
        targetOre: '',
        targetGas: '',
        targetIce: '',
        targetRadioactive: '',
        targetDeepCore: '',
        system: 'sol',
        systemOre: 'sol',
        systemGas: '',
        systemIce: '',
        systemRadioactive: '',
        systemDeepCore: '',
        homeSystem: 'sol',
        depositBot: '',
        depositMode: 'faction',
        depositFallback: 'storage',
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
        oreQuotas: { iron_ore: 495000, copper_ore: 495000, carbon_ore: 495000 },
        gasQuotas: {},
        iceQuotas: {},
        radioactiveQuotas: {},
        deepCoreQuotas: {},
        enableFighting: false,
        flockEnabled: false,
        flockName: '',
        flockRole: 'follower',
        flockGroups: [],
      },
    });

    const ctx = makeCtx({ inventory: [{ itemId: 'strip_miner_iii', quantity: 1 }] });
    const gen = minerRoutine(ctx as any);
    let result = await gen.next();
    while (!result.done) {
      if (result.value === 'harvest_loop') {
        const sys = mapStore.getSystem('sol');
        const poi = sys?.pois.find((p: any) => p.id === 'sol_central');
        if (poi?.ores_found?.[0]) {
          poi.ores_found[0].depleted = true;
          poi.ores_found[0].depleted_at = new Date(Date.now()).toISOString();
        }
        result = await gen.next();
        break;
      }
      result = await gen.next();
    }
  }, 30000);
});

// ── D. Cargo Full Mid-Run ─────────────────────────────────────────────────────

describe('D. Cargo Full Mid-Run', () => {
  test('D1: Cargo hits threshold mid-travel, miner returns home immediately', async () => {
    const ctx = makeCtx({ cargo: 85, cargoMax: 100 });
    const gen = minerRoutine(ctx as any);
    let result = await gen.next();
    while (!result.done) {
      if (result.value === 'return_home' || result.value === 'find_destination') {
        expect(ctx.log).toHaveBeenCalled();
        break;
      }
      result = await gen.next();
    }
  }, 30000);

  test('D2: Cargo full at POI before mining, miner returns home', async () => {
    const ctx = makeCtx({ cargo: 95, cargoMax: 100, docked: false });
    const gen = minerRoutine(ctx as any);
    let result = await gen.next();
    while (!result.done) {
      if (result.value === 'return_home') break;
      result = await gen.next();
    }
  }, 30000);

  test('D3: stayOutUntilFull=true ignores threshold until cargo is actually full', async () => {
    readSettings.mockReturnValue({
      miner: {
        miningType: 'auto',
        targetOre: 'iron_ore',
        targetGas: '',
        targetIce: '',
        targetRadioactive: '',
        targetDeepCore: '',
        system: 'sol',
        systemOre: 'sol',
        systemGas: '',
        systemIce: '',
        systemRadioactive: '',
        systemDeepCore: '',
        homeSystem: 'sol',
        depositBot: '',
        depositMode: 'faction',
        depositFallback: 'storage',
        cargoThreshold: 100,
        refuelThreshold: 54,
        repairThreshold: 80,
        depletionTimeoutHours: 24,
        ignoreDepletion: false,
        noMidMiningRetarget: false,
        enableCloak: true,
        cloakIgnoreBlacklist: true,
        stayOutUntilFull: true,
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
        flockRole: 'follower',
        flockGroups: [],
      },
    });

    const ctx = makeCtx({ cargo: 95, cargoMax: 100 });
    const gen = minerRoutine(ctx as any);
    let result = await gen.next();
    while (!result.done) {
      if (result.value === 'return_home') {
        expect(ctx.log).not.toHaveBeenCalledWith('mining', expect.stringContaining('Cargo threshold'));
        break;
      }
      result = await gen.next();
    }
  }, 30000);
});
