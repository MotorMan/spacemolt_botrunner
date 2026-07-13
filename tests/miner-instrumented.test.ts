import { test, expect, vi } from 'vitest';

vi.mock('fs', () => ({
  readFileSync: vi.fn(() => '{}'),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
  statSync: vi.fn(() => ({ mtimeMs: 0 })),
}));

vi.mock('path', () => ({ join: vi.fn(() => ''), dirname: vi.fn() }));

vi.mock('../src/web/server', () => ({ loadSettings: vi.fn(() => ({})), WebServer: class {} }));
vi.mock('../src/botmanager', () => ({ getBotChatChannel: vi.fn(() => ({ send: vi.fn(), onMessage: vi.fn(), offMessage: vi.fn(), onGlobalMessage: vi.fn(), offGlobalMessage: vi.fn() })), main: undefined }));
vi.mock('../src/routines/minerCoordination', () => ({ loadMinerCoordination: vi.fn(() => ({})), saveMinerCoordination: vi.fn(), registerMinerTarget: vi.fn(), unregisterMinerTarget: vi.fn(), announceMinerTarget: vi.fn(), getMinerCountForSystem: vi.fn(() => 0), isSystemOvercrowded: vi.fn(() => false) }));
vi.mock('../src/routines/flock', () => ({
  readFlockSettings: vi.fn(() => ({ assignments: {}, flockGroups: [] })),
  readFlockState: vi.fn(),
  registerFlockMember: vi.fn(),
  unregisterFlockMember: vi.fn(),
  clearFlockState: vi.fn(),
}));
vi.mock('../src/routines/battle', () => ({ ensureAmmoLoaded: vi.fn().mockResolvedValue(true), getWeaponModules: vi.fn().mockReturnValue([]) }));
vi.mock('../src/routines/miner_radioactive', () => ({ getRadioactiveCapabilityCached: vi.fn(() => ({})), hasRadioactiveEquipmentCached: vi.fn(() => false), logRadioactiveCapability: vi.fn(), isRadioactiveOre: vi.fn(() => false), RADIOACTIVE_ORES: [] }));
vi.mock('../src/catalogstore', () => ({ catalogStore: { getAmmoTypeIndex: vi.fn(() => ({})) } }));
vi.mock('../src/routines/common', () => ({
  readSettings: vi.fn(() => ({ miner: { miningType: 'auto', cargoThreshold: 100, refuelThreshold: 54, repairThreshold: 80, homeSystem: 'sol', maxBotsPerSystem: 3 } })),
  ensureFueled: vi.fn().mockResolvedValue(true), tryRefuel: vi.fn().mockResolvedValue(true), repairShip: vi.fn().mockResolvedValue(true), ensureDocked: vi.fn(), ensureUndocked: vi.fn().mockResolvedValue(true), navigateToSystem: vi.fn().mockResolvedValue(undefined), refuelAtStation: vi.fn().mockResolvedValue(undefined), factionDonateProfit: vi.fn().mockResolvedValue(undefined), scavengeWrecks: vi.fn().mockResolvedValue(undefined), detectAndRecoverFromDeath: vi.fn().mockResolvedValue(false), getSystemInfo: vi.fn().mockResolvedValue({ pois: [], connections: [] }), parseOreFromMineResult: vi.fn(() => []), collectFromStorage: vi.fn(() => []), handleBattleNotifications: vi.fn(), getBattleStatus: vi.fn(), fleeFromBattle: vi.fn(), shouldEngagePlayersInCombat: vi.fn(() => false), engageInBattle: vi.fn(), getItemSize: vi.fn(() => 1), enableCloakingIfPossible: vi.fn().mockResolvedValue(false),
}));
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

test('instrumented', async () => {
  const ctx: any = {
    bot: {
      exec: vi.fn().mockResolvedValue({ result: { modules: [{ id: 'mining_laser_v' }] } }),
      state: 'running',
      username: 'TestBot',
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
      factionStorage: [],
      inventory: [],
      credits: 50000,
      refreshStatus: vi.fn(),
      refreshCargo: vi.fn(),
      refreshLocation: vi.fn(),
      refreshShip: vi.fn(),
      refreshFactionStorage: vi.fn(),
      refreshStorage: vi.fn(),
    },
    log: ((...args: unknown[]) => { console.log('[LOG]', ...args); }) as any,
    sleep: vi.fn().mockResolvedValue(undefined),
  };
  const gen: any = minerRoutine(ctx);
  console.log('created');
  const step1 = gen.next();
  console.log('step1 done');
  const r1 = await Promise.race([
    step1,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
  ]);
  console.log('result1', r1);
});
