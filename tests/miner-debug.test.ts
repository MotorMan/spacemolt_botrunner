import { test, expect, vi } from 'vitest';

vi.mock('fs', () => ({
  promises: { readFileSync: vi.fn(() => '{}'), writeFileSync: vi.fn(), existsSync: vi.fn(() => false), mkdirSync: vi.fn(), unlinkSync: vi.fn(), statSync: vi.fn(() => ({ mtimeMs: Date.now() })) },
  readFileSync: vi.fn(() => '{}'),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
  statSync: vi.fn(() => ({ mtimeMs: Date.now() })),
}));

vi.mock('path', () => ({ join: vi.fn(), dirname: vi.fn() }));

vi.mock('../src/web/server', () => ({ loadSettings: vi.fn(() => ({})), WebServer: class {}, getSystemBlacklist: vi.fn(() => []) }));
vi.mock('../src/botmanager', () => ({ getBotChatChannel: vi.fn(() => ({ send: vi.fn(), onMessage: vi.fn(), offMessage: vi.fn(), onGlobalMessage: vi.fn(), offGlobalMessage: vi.fn() })), main: undefined }));
vi.mock('../src/routines/minerCoordination', () => ({ loadMinerCoordination: vi.fn(() => ({})), saveMinerCoordination: vi.fn(), registerMinerTarget: vi.fn(), unregisterMinerTarget: vi.fn(), announceMinerTarget: vi.fn(), getMinerCountForSystem: vi.fn(() => 0), isSystemOvercrowded: vi.fn(() => false) }));
vi.mock('../src/routines/flock', () => ({ readFlockSettings: vi.fn(() => ({})), readFlockState: vi.fn(), registerFlockMember: vi.fn(), unregisterFlockMember: vi.fn(), clearFlockState: vi.fn() }));
vi.mock('../src/mapstore', () => ({
  mapStore: {
    getSystem: vi.fn(() => ({ pois: [{ id: 'sol_central', name: 'Sol Central', has_base: true, hidden: false, ores_found: [{ item_id: 'iron_ore', name: 'Iron Ore', total_mined: 0, times_seen: 10, last_seen: '2026-07-06T00:00:00Z', depleted: false }] }], name: 'Sol' })),
    findOreLocations: vi.fn(() => [{ poiId: 'sol_central', systemId: 'sol', systemName: 'Sol', poiName: 'Sol Central', richness: 500, remaining: 1000, maxRemaining: 2000, supportedPower: 100, minutesSinceScan: 10 }]),
    findClosestMiningLocations: vi.fn(() => []),
    findBestMiningLocation: vi.fn(() => null),
    findRoute: vi.fn(() => ['sol', 'ore_system']),
    getAllKnownOres: vi.fn(() => [{ item_id: 'iron_ore', name: 'Iron Ore' }]),
    isMapSeeded: vi.fn(() => true),
    isDepletionExpired: vi.fn(() => false),
    markOreDepleted: vi.fn(),
    recordMiningYield: vi.fn(),
    registerPoiFromScan: vi.fn(),
    updatePoiResources: vi.fn(),
    updateSystem: vi.fn(),
  },
}));
vi.mock('../src/routines/battle', () => ({ ensureAmmoLoaded: vi.fn().mockResolvedValue(true), getWeaponModules: vi.fn().mockReturnValue([]) }));
vi.mock('../src/routines/miner_radioactive', () => ({ getRadioactiveCapabilityCached: vi.fn(() => ({})), hasRadioactiveEquipmentCached: vi.fn(() => false), logRadioactiveCapability: vi.fn(), isRadioactiveOre: vi.fn(() => false), RADIOACTIVE_ORES: [] }));
vi.mock('../src/catalogstore', () => ({ catalogStore: { getItem: vi.fn(), getItemByName: vi.fn(), getAll: vi.fn(() => ({ items: {} })), getAmmoTypeIndex: vi.fn(() => ({})) } }));
vi.mock('../src/routines/common', () => ({
  readSettings: vi.fn(() => ({ miner: { miningType: 'auto', cargoThreshold: 100, refuelThreshold: 54, repairThreshold: 80, homeSystem: 'sol', maxBotsPerSystem: 3 } })),
  ensureFueled: vi.fn().mockResolvedValue(true), tryRefuel: vi.fn().mockResolvedValue(true), repairShip: vi.fn().mockResolvedValue(true), ensureDocked: vi.fn(), ensureUndocked: vi.fn().mockResolvedValue(true), navigateToSystem: vi.fn().mockResolvedValue(undefined), refuelAtStation: vi.fn().mockResolvedValue(undefined), factionDonateProfit: vi.fn().mockResolvedValue(undefined), scavengeWrecks: vi.fn().mockResolvedValue(undefined), detectAndRecoverFromDeath: vi.fn().mockResolvedValue(true), getSystemInfo: vi.fn().mockResolvedValue({ pois: [], connections: [] }), parseOreFromMineResult: vi.fn(() => []), collectFromStorage: vi.fn(() => []), handleBattleNotifications: vi.fn(), getBattleStatus: vi.fn(), fleeFromBattle: vi.fn(), shouldEngagePlayersInCombat: vi.fn(() => false), engageInBattle: vi.fn(), getItemSize: vi.fn(() => 1), EMERGENCY_WARP_STABILIZER_MESSAGE: 'msg', shouldStopForEmergency: vi.fn(() => false), refreshNotifications: vi.fn().mockResolvedValue({}), checkAndFleeFromPirates: vi.fn().mockResolvedValue(false), parseNearbyEntities: vi.fn(() => []),
}));

const { minerRoutine } = await import('../src/routines/miner.ts');

test('debug single step B1', async () => {
  const ctx: any = {
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
      factionStorage: [{ itemId: 'iron_ore', quantity: 1000 }],
      inventory: [{ itemId: 'mining_laser_v', quantity: 1 }],
      credits: 50000,
    },
    log: vi.fn(),
    sleep: vi.fn().mockResolvedValue(undefined),
  };
  const gen = minerRoutine(ctx as any);
  const r1 = await gen.next();
  console.log('step1', r1);
  expect(r1.done).toBe(false);
  const r2 = await gen.next();
  console.log('step2', r2);
  expect(r2.done).toBe(false);
}, 10000);
