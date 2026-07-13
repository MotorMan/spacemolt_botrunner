import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMapStoreStub, setMockNow, advanceTime, installMockClock, restoreRealClock, mockDateNow, restoreDateNow, buildCapabilitiesFromModules } from './miner-helpers.js';

vi.mock('fs', () => ({
  promises: {
    readFileSync: vi.fn(() => JSON.stringify({ miner: { maxBotsPerSystem: 3, cargoThreshold: 100 } })),
    writeFileSync: vi.fn(),
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
    statSync: vi.fn(() => ({ mtimeMs: Date.now() })),
  },
  readFileSync: vi.fn(() => JSON.stringify({ miner: { maxBotsPerSystem: 3, cargoThreshold: 100 } })),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
  statSync: vi.fn(() => ({ mtimeMs: Date.now() })),
}));

vi.mock('path', () => ({
  join: vi.fn((...parts: unknown[]) => parts.join('/').replace('E:/code/code', 'E:\\code\\code')),
  dirname: vi.fn(),
}));

vi.mock('../src/web/server', () => ({
  loadSettings: vi.fn(() => ({})),
  saveStoppedState: vi.fn(),
  getStoppedState: vi.fn(),
  clearStoppedState: vi.fn(),
  getAllLastUsedRoutines: vi.fn(() => []),
  WebServer: class MockWebServer {},
}));

vi.mock('../src/botmanager', () => ({
  getBotChatChannel: vi.fn(() => ({
    send: vi.fn(),
    onMessage: vi.fn(),
    offMessage: vi.fn(),
    onGlobalMessage: vi.fn(),
    offGlobalMessage: vi.fn(),
  })),
  minerRoutine: undefined,
  explorerRoutine: undefined,
  main: undefined,
}));

vi.mock('../src/routines/minerCoordination', () => ({
  loadMinerCoordination: vi.fn(() => ({ systemAssignments: {}, poiAssignments: {}, lastUpdate: Date.now() })),
  saveMinerCoordination: vi.fn(),
  announceMinerTarget: vi.fn(),
  getMinerCountForSystem: vi.fn(() => 0),
  isSystemOvercrowded: vi.fn(() => false),
  registerMinerTarget: vi.fn(),
  unregisterMinerTarget: vi.fn(),
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

vi.mock('../src/routines/battle', () => ({
  ensureAmmoLoaded: vi.fn().mockResolvedValue(true),
  getWeaponModules: vi.fn().mockReturnValue([]),
}));

vi.mock('../src/routines/miner_radioactive', () => ({
  getRadioactiveCapability: vi.fn(() => ({})),
  getRadioactiveCapabilityCached: vi.fn(() => ({ canMineBasicRadioactive: false, canMineDeepCoreRadioactive: false, canMineHiddenRadioactive: false })),
  hasRadioactiveEquipmentCached: vi.fn(() => false),
  hasFullRadioactiveCapabilityCached: vi.fn(() => false),
  logRadioactiveCapability: vi.fn(),
  isRadioactiveOre: vi.fn(() => false),
  RADIOACTIVE_ORES: [],
}));

vi.mock('../src/catalogstore', () => ({
  catalogStore: { getAmmoTypeIndex: vi.fn(() => ({})) },
}));

vi.mock('../src/routines/common', () => ({
  readSettings: vi.fn(() => ({
    miner: {
      miningType: 'auto',
      targetOre: '',
      targetGas: '',
      targetIce: '',
      targetRadioactive: '',
      targetDeepCore: '',
      system: '',
      systemOre: '',
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
  ensureDocked: vi.fn().mockResolvedValue(undefined),
  ensureUndocked: vi.fn().mockResolvedValue(true),
  navigateToSystem: vi.fn().mockResolvedValue(undefined),
  refuelAtStation: vi.fn().mockResolvedValue(undefined),
  factionDonateProfit: vi.fn().mockResolvedValue(undefined),
  scavengeWrecks: vi.fn().mockResolvedValue(undefined),
  detectAndRecoverFromDeath: vi.fn().mockResolvedValue(false),
  getSystemInfo: vi.fn().mockResolvedValue({ pois: [], connections: [] }),
  isOreBeltPoi: vi.fn(() => false),
  isGasCloudPoi: vi.fn(() => false),
  isIceFieldPoi: vi.fn(() => false),
  findStation: vi.fn(() => null),
  parseOreFromMineResult: vi.fn(() => []),
  collectFromStorage: vi.fn(() => []),
  handleBattleNotifications: vi.fn(),
  getBattleStatus: vi.fn(),
  fleeFromBattle: vi.fn(),
  shouldEngagePlayersInCombat: vi.fn(() => false),
  engageInBattle: vi.fn(),
  getItemSize: vi.fn(() => 1),
  EMERGENCY_WARP_STABILIZER_MESSAGE: 'msg',
  shouldStopForEmergency: vi.fn(() => false),
  refreshNotifications: vi.fn().mockResolvedValue({}),
}));

const { mapStore } = await import('../src/mapstore.js');
const mapStub = createMapStoreStub();
mapStore.getSystem = mapStub.getSystem.bind(mapStub);
mapStore.findOreLocations = mapStub.findOreLocations.bind(mapStub);
mapStore.findRoute = mapStub.findRoute.bind(mapStub);
mapStore.getAllKnownOres = mapStub.getAllKnownOres.bind(mapStub);
mapStore.markOreDepleted = mapStub.markOreDepleted.bind(mapStub);
mapStore.updatePoiResources = mapStub.updatePoiResources.bind(mapStub);
mapStore.registerPoiFromScan = mapStub.registerPoiFromScan.bind(mapStub);
mapStore.isDepletionExpired = (at?: string) => !at;

const { minerRoutine } = await import('../src/routines/miner.ts');

describe('A. Startup Concurrency (40 bots)', () => {
  beforeEach(() => {
    installMockClock();
    mockDateNow();
    setMockNow(1700000000000);
    mapStub.systems.clear();
  });

  afterEach(() => {
    restoreDateNow();
    restoreRealClock();
    vi.clearAllMocks();
  });

  test('A1-A5: 40 bots start without exceptions', async () => {
    const generators: any[] = [];
    for (let t = 0; t < 4; t++) {
      const type = ['ore', 'gas', 'ice', 'radioactive'][t] as 'ore' | 'gas' | 'ice' | 'radioactive';
      const mods = type === 'ore'
        ? [{ id: 'mining_laser_v' }]
        : type === 'gas'
        ? [{ id: 'gas_harvester_iii' }]
        : type === 'ice'
        ? [{ id: 'ice_harvester_iv' }]
        : [{ id: 'rad_harvester_iv' }, { id: 'lead_lined_cargo_ii' }];

      for (let i = 0; i < 10; i++) {
        const ctx: any = {
          bot: {
            exec: vi.fn().mockResolvedValue({ result: { modules: mods } }),
            refreshStatus: vi.fn().mockResolvedValue(undefined),
            refreshCargo: vi.fn().mockResolvedValue(undefined),
            refreshLocation: vi.fn().mockResolvedValue(undefined),
            refreshShip: vi.fn().mockResolvedValue(undefined),
            refreshFactionStorage: vi.fn().mockResolvedValue(undefined),
            refreshStorage: vi.fn().mockResolvedValue(undefined),
            state: 'running',
            username: `Miner_${type}_${i}`,
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
            inventory: mods.map(m => ({ itemId: m.id as string, quantity: 1 })),
            credits: 50000,
          },
          log: vi.fn(),
          sleep: vi.fn().mockResolvedValue(undefined),
        };
        generators.push(minerRoutine(ctx));
      }
    }

    for (const gen of generators) {
      const first = await gen.next();
      if (first.done) throw new Error('Generator finished early');
    }
    advanceTime(5000);
    for (const gen of generators) {
      await gen.next();
    }

    expect(generators.length).toBe(40);
  }, 60000);
});
