import { test, expect, vi } from 'vitest';

vi.mock('fs', () => ({
  readFileSync: vi.fn(() => '{}'),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
  statSync: vi.fn(() => ({ mtimeMs: Date.now() })),
}));

vi.mock('path', () => ({ join: vi.fn(() => ''), dirname: vi.fn() }));

vi.mock('../src/botmanager', () => ({ getBotChatChannel: vi.fn(() => ({ send: vi.fn(), onMessage: vi.fn(), offMessage: vi.fn(), onGlobalMessage: vi.fn(), offGlobalMessage: vi.fn() })), main: undefined }));
vi.mock('../src/routines/flock', () => ({ readFlockSettings: vi.fn(() => ({ assignments: {}, flockGroups: [] })), readFlockState: vi.fn(), registerFlockMember: vi.fn(), unregisterFlockMember: vi.fn(), clearFlockState: vi.fn() }));
vi.mock('../src/routines/battle', () => ({ ensureAmmoLoaded: vi.fn().mockResolvedValue(true), getWeaponModules: vi.fn().mockReturnValue([]) }));
vi.mock('../src/catalogstore', () => ({ catalogStore: { getAmmoTypeIndex: vi.fn(() => ({})) } }));
vi.mock('../src/routines/minerCoordination', () => ({ loadMinerCoordination: vi.fn(() => ({})), saveMinerCoordination: vi.fn(), registerMinerTarget: vi.fn(), unregisterMinerTarget: vi.fn(), announceMinerTarget: vi.fn(), getMinerCountForSystem: vi.fn(() => 0), isSystemOvercrowded: vi.fn(() => false) }));

const mockReadSettings = vi.fn(() => ({
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
}));

vi.mock('../src/routines/common', async () => {
  const actual: any = await vi.importActual('../src/routines/common.js');
  return { ...actual, readSettings: mockReadSettings };
});

vi.mock('../src/mapstore', () => ({
  mapStore: {
    getSystem: vi.fn(() => ({ pois: [], name: 'Sol' })),
    findOreLocations: vi.fn(() => []),
    findRoute: vi.fn(() => []),
    getAllKnownOres: vi.fn(() => []),
    isMapSeeded: vi.fn(() => true),
    isDepletionExpired: vi.fn(() => false),
    markOreDepleted: vi.fn(),
  },
}));

const { minerRoutine } = await import('../src/routines/miner.ts');

test('C1 log yields', async () => {
  const ctx: any = {
    bot: {
      exec: vi.fn().mockResolvedValue({ result: { modules: [{ id: 'mining_laser_v' }] } }),
      refreshStatus: vi.fn().mockResolvedValue(undefined),
      refreshCargo: vi.fn().mockResolvedValue(undefined),
      refreshLocation: vi.fn().mockResolvedValue(undefined),
      refreshShip: vi.fn().mockResolvedValue(undefined),
      refreshFactionStorage: vi.fn().mockResolvedValue(undefined),
      refreshStorage: vi.fn().mockResolvedValue(undefined),
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
    },
    log: (...args: any[]) => { console.log('[LOG]', ...args); },
    sleep: vi.fn().mockResolvedValue(undefined),
  };
  const gen = minerRoutine(ctx as any);
  for (let i = 0; i < 5; i++) {
    const r = await gen.next();
    console.log('yield', i, r.value);
    if (r.done) break;
  }
}, 10000);
