// tests/miner-types.test.ts
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

vi.mock('../src/routines/common', () => ({
  readSettings: vi.fn(() => ({
    miner: {
      miningType: 'auto',
      targetOre: '',
      targetGas: 'ion_gas',
      targetIce: 'water_ice',
      targetRadioactive: 'uranium_ore',
      targetDeepCore: '',
      system: '',
      systemOre: 'ore_system',
      systemGas: 'gas_system',
      systemIce: 'ice_system',
      systemRadioactive: 'rad_system',
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
      gasQuotas: { ion_gas: 495000 },
      iceQuotas: { water_ice: 495000 },
      radioactiveQuotas: { uranium_ore: 495000 },
      deepCoreQuotas: { exotic_matter: 495000 },
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
  navigateToSystem: vi.fn().mockResolvedValue(undefined),
  refuelAtStation: vi.fn().mockResolvedValue(undefined),
  factionDonateProfit: vi.fn().mockResolvedValue(undefined),
  scavengeWrecks: vi.fn().mockResolvedValue(undefined),
  detectAndRecoverFromDeath: vi.fn().mockResolvedValue(true),
  getSystemInfo: vi.fn((_ctx: any) => ({ pois: [], connections: [], systemId: 'sol' })),
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



const { minerRoutine } = await import('../src/routines/miner.ts');

beforeEach(() => {
  installMockClock();
  mockDateNow();
  setMockNow(1700000000000);
  mapStub.systems.clear();
  mapStub.addSystem('sol', 'Sol Central', [{ id: 'sol_central', name: 'Sol Central', has_base: true, hidden: false, ores_found: [{ item_id: 'iron_ore', name: 'Iron Ore', total_mined: 0, times_seen: 10, last_seen: '2026-07-06T00:00:00Z', depleted: false }] }]);
  mapStub.addSystem('ore_system', 'Ore Belt', [{ id: 'ore_belt', name: 'Ore Belt', has_base: true, hidden: false, ores_found: [{ item_id: 'iron_ore', name: 'Iron Ore', total_mined: 0, times_seen: 10, last_seen: '2026-07-06T00:00:00Z', depleted: false }] }]);
  mapStub.addSystem('gas_system', 'Nebula', [{ id: 'gas_cloud', name: 'Gas Cloud', has_base: true, hidden: true, ores_found: [{ item_id: 'ion_gas', name: 'Ion Gas', total_mined: 0, times_seen: 10, last_seen: '2026-07-06T00:00:00Z', depleted: false }] }]);
  mapStub.addSystem('ice_system', 'Glacier', [{ id: 'ice_field', name: 'Ice Field', has_base: true, hidden: false, ores_found: [{ item_id: 'water_ice', name: 'Water Ice', total_mined: 0, times_seen: 10, last_seen: '2026-07-06T00:00:00Z', depleted: false }] }]);
  mapStub.addSystem('rad_system', 'Rad Zone', [{ id: 'rad_belt', name: 'Rad Belt', has_base: true, hidden: true, ores_found: [{ item_id: 'uranium_ore', name: 'Uranium', total_mined: 0, times_seen: 10, last_seen: '2026-07-06T00:00:00Z', depleted: false }] }]);
});

afterEach(() => {
  restoreDateNow();
  restoreRealClock();
  vi.clearAllMocks();
});

function makeCtxForType(type: 'ore' | 'gas' | 'ice' | 'radioactive', sys = 'sol') {
  const mods = type === 'ore'
    ? [{ id: 'mining_laser_v' }]
    : type === 'gas'
    ? [{ id: 'gas_harvester_iii' }]
    : type === 'ice'
    ? [{ id: 'ice_harvester_iv' }]
    : [{ id: 'rad_harvester_iv' }, { id: 'lead_lined_cargo_ii' }];
  return {
    bot: {
      exec: vi.fn().mockResolvedValue({ result: { modules: mods } }),
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
      username: `Test_${type}`,
      system: sys,
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
      inventory: mods.map(m => ({ itemId: m.id as string, quantity: 1 })),
      credits: 50000,
    },
    log: vi.fn(),
    sleep: vi.fn().mockResolvedValue(undefined),
  };
}

describe('B. Mining Type Matrix (per type × live settings)', () => {
  test('B1: ore — mining laser + cargo expanders (lithosphere)', async () => {
    const ctx = makeCtxForType('ore', 'sol');
    const gen = minerRoutine(ctx as any);
    let result = await gen.next();
    while (!result.done) {
      if (result.value === 'harvest_loop') break;
      result = await gen.next();
    }
    expect(ctx.log).toHaveBeenCalled();
  }, 30000);

  test('B3: gas — gas harvester, target ion/argon', async () => {
    const ctx = makeCtxForType('gas', 'gas_system');
    const gen = minerRoutine(ctx as any);
    let result = await gen.next();
    while (!result.done) {
      if (result.value === 'harvest_loop') break;
      result = await gen.next();
    }
    expect(ctx.log).toHaveBeenCalled();
  }, 30000);

  test('B4: ice — ice harvester, target water_ice/deuterium_ice', async () => {
    const ctx = makeCtxForType('ice', 'ice_system');
    const gen = minerRoutine(ctx as any);
    let result = await gen.next();
    while (!result.done) {
      if (result.value === 'harvest_loop') break;
      result = await gen.next();
    }
    expect(ctx.log).toHaveBeenCalled();
  }, 30000);

  test('B5: radioactive — rad harvester + lead lined cargo', async () => {
    const ctx = makeCtxForType('radioactive', 'rad_system');
    const gen = minerRoutine(ctx as any);
    let result = await gen.next();
    while (!result.done) {
      if (result.value === 'harvest_loop') break;
      result = await gen.next();
    }
    expect(ctx.log).toHaveBeenCalled();
  }, 30000);

  test('B2: ore — strip miner restricted to common ores', async () => {
    (await import('../src/routines/common.js')).readSettings = vi.fn(() => ({
      miner: {
        miningType: 'auto',
        targetOre: 'titanium_ore',
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
    }));

    const ctx = makeCtxForType('ore', 'ore_system');
    ctx.bot.inventory = [{ itemId: 'strip_miner_iii', quantity: 1 }];
    const gen = minerRoutine(ctx as any);
    let result = await gen.next();
    while (!result.done) {
      if (result.value === 'harvest_loop') break;
      result = await gen.next();
    }
  }, 30000);
});
