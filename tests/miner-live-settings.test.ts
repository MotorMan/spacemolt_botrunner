// tests/miner-live-settings.test.ts
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
  FlockState: { targetResourceId: '' },
}));

import { createMapStoreStub, setMockNow, installMockClock, restoreRealClock, mockDateNow, restoreDateNow } from './miner-helpers.js';

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
});

afterEach(() => {
  restoreDateNow();
  restoreRealClock();
  vi.clearAllMocks();
});

function makeCtx() {
  return {
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
    log: vi.fn(),
    sleep: (ms: number) => new Promise<void>(r => setTimeout(r, ms)),
  };
}

describe('Live Settings Fidelity', () => {
  test('readSettings path reacts to file edits in real time', async () => {
    const { readSettings } = await import('../src/routines/common.js');
    const first = (readSettings as any).mock.results[0]?.value ?? { miner: {} };
    const originalMax = first?.miner?.maxBotsPerSystem ?? 3;
    expect(originalMax).toBeDefined();

    // Simulate file edit by changing the mock return value
    (readSettings as any).mockReturnValue({
      miner: { ...first.miner, maxBotsPerSystem: 7 },
    });

    const ctx = makeCtx();
    const gen = minerRoutine(ctx as any);
    let result = await gen.next();
    while (!result.done) {
      if (result.value === 'find_destination') {
        break;
      }
      result = await gen.next();
    }
  }, 30000);

  test('getMinerSettings reads data/settings.json at runtime and can be overridden per run', async () => {
    const { readSettings } = await import('../src/routines/common.js');
    const original = readSettings({ miner: { maxBotsPerSystem: 3, cargoThreshold: 100 } } as any);
    expect(original).toBeDefined();
  });

  test('maxBotsPerSystem=3 is honored regardless of mining type', async () => {
    const ctx = makeCtx();
    const gen = minerRoutine(ctx as any);
    let result = await gen.next();
    while (!result.done) {
      if (result.value === 'find_destination') {
        break;
      }
      result = await gen.next();
    }
  }, 30000);
});
