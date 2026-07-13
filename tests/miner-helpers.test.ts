import { test, expect, vi } from 'vitest';
import { buildCapabilitiesFromModules, createMockBotState, createMapStoreStub, loadSettingsFixture } from './miner-helpers.js';

test('buildCapabilitiesFromModules detects mining type', () => {
  const caps = buildCapabilitiesFromModules([{ id: 'mining_laser_v' }]);
  expect(caps.miningType).toBe('ore');
  expect(caps.hasMiningLaser).toBe(true);
  expect(caps.hasStripMiner).toBe(false);
});

test('buildCapabilitiesFromModules detects gas', () => {
  const caps = buildCapabilitiesFromModules([{ id: 'gas_harvester_iii' }]);
  expect(caps.miningType).toBe('gas');
  expect(caps.hasGasHarvester).toBe(true);
});

test('createMapStoreStub works', () => {
  const store = createMapStoreStub();
  store.addSystem('sol', 'Sol Central');
  store.addPoi('sol', { id: 'sol_central', name: 'Sol Central', has_base: true, ores_found: [{ item_id: 'iron_ore', name: 'Iron', total_mined: 0, times_seen: 1, last_seen: new Date().toISOString(), depleted: false }] });
  const sys = store.getSystem('sol');
  expect(sys).toBeDefined();
  expect(sys!.pois.length).toBe(1);
  const locations = store.findOreLocations('iron_ore', [], true);
  expect(locations.length).toBe(1);
});

test('loadSettingsFixture reads data/settings.json', () => {
  const settings = loadSettingsFixture('spacemolt_botrunner/data/settings.json');
  expect(settings).toBeDefined();
  expect((settings as any)?.miner).toBeDefined();
  expect((settings as any).miner?.maxBotsPerSystem).toBe(3);
});
