import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';

// ── Deterministic Clock ───────────────────────────────────────────────────────

let mockNow: number;
const originalDateNow = Date.now.bind(Date);
const originalSetTimeout = globalThis.setTimeout.bind(globalThis);
const originalSetInterval = globalThis.setInterval.bind(globalThis);
const originalClearTimeout = globalThis.clearTimeout.bind(globalThis);
const originalClearInterval = globalThis.clearInterval.bind(globalThis);
const timers: { id: number; fn: (...args: unknown[]) => void; delay: number; args: unknown[] }[] = [];
let timerId = 0;

export function setMockNow(now: number) {
  mockNow = now;
}

export function advanceTime(ms: number) {
  mockNow += ms;
  const nowCopy = mockNow;
  const due: typeof timers = [];
  for (const t of timers) {
    t.delay -= ms;
    if (t.delay <= 0) due.push(t);
  }
  for (const t of due) {
    timers.splice(timers.indexOf(t), 1);
    try { t.fn(...t.args); } catch (e) { console.error(e); }
  }
}

export function createMockSleep() {
  return (ms: number) => new Promise<void>((resolve) => {
    timers.push({ id: ++timerId, fn: resolve, delay: ms, args: [] });
  });
}

export function installMockClock() {
  mockNow = 1700000000000;
  vi.useFakeTimers();
  vi.setSystemTime(mockNow);
}

export function restoreRealClock() {
  vi.useRealTimers();
  timers.length = 0;
  timerId = 0;
}

// Provide a controllable clock for tests that rely on Date.now() inside production code.
// Mock Date.now once globally after vitest fake timers are installed.
export function mockDateNow() {
  vi.spyOn(Date, 'now').mockImplementation(() => mockNow);
}

export function restoreDateNow() {
  (Date.now as any).mockRestore?.();
}

// ── Module Loadout Factory ────────────────────────────────────────────────────

export interface ModuleCapabilities {
  miningType: 'ore' | 'gas' | 'ice' | 'radioactive' | null;
  cargoMax: number;
  totalMiningPower: number;
  hasStripMiner: boolean;
  hasDeepCoreExtractor: boolean;
  hasDeepCoreSurveyScanner: boolean;
  hasCloak: boolean;
  hasLeadLinedCargo: boolean;
  hasRadHarvester: boolean;
  hasGasHarvester: boolean;
  hasIceHarvester: boolean;
  hasMiningLaser: boolean;
}

const CARGO_PER_EXPANDER = 4000;
const MINING_POWER_LASER = 500;
const MINING_POWER_STRIP = 1200;
const MINING_POWER_GAS = 800;
const MINING_POWER_ICE = 600;
const MINING_POWER_RAD = 400;
const BASE_CARGO = 10000;

export function buildCapabilitiesFromModules(modules: Array<{ id?: string; name?: string; type?: string; special?: string }>): ModuleCapabilities {
  const all = modules.map(m => `${m.id || ''} ${m.name || ''} ${m.type || ''} ${m.special || ''}`.toLowerCase()).join(' ');
  const hasMiningLaser = /mining_laser|mining laser/.test(all);
  const hasStripMiner = /strip_miner|strip miner/.test(all);
  const hasGasHarvester = /gas_harvester|gas harvester/.test(all);
  const hasIceHarvester = /ice_harvester|ice harvester/.test(all);
  const hasRadHarvester = /rad_harvester|rad harvester|rad_harvesting/.test(all);
  const hasLeadLinedCargo = /lead_lined_cargo|lead lined cargo|hazmat_cargo/.test(all);
  const hasDeepCoreExtractor = /deep_core_extractor/.test(all);
  const hasDeepCoreSurveyScanner = /deep_core_survey_scanner|deep core survey scanner|deep_core_detection/.test(all);
  const hasCloak = /cloak/.test(all);

  const expanders = (all.match(/cargo_expander/g) || []).length;
  const cargoMax = BASE_CARGO + expanders * CARGO_PER_EXPANDER;

  let miningType: ModuleCapabilities['miningType'] = null;
  if (hasLeadLinedCargo && hasRadHarvester) miningType = 'radioactive';
  else if (hasIceHarvester) miningType = 'ice';
  else if (hasGasHarvester) miningType = 'gas';
  else if (hasStripMiner || hasMiningLaser) miningType = 'ore';

  let totalMiningPower = 0;
  if (hasMiningLaser) totalMiningPower += MINING_POWER_LASER;
  if (hasStripMiner) totalMiningPower += MINING_POWER_STRIP;
  if (hasGasHarvester) totalMiningPower += MINING_POWER_GAS;
  if (hasIceHarvester) totalMiningPower += MINING_POWER_ICE;
  if (hasRadHarvester) totalMiningPower += MINING_POWER_RAD;

  return {
    miningType, cargoMax, totalMiningPower, hasStripMiner,
    hasDeepCoreExtractor, hasDeepCoreSurveyScanner, hasCloak,
    hasLeadLinedCargo, hasRadHarvester, hasGasHarvester, hasIceHarvester,
    hasMiningLaser,
  };
}

// ── Quick Loadout References (from moduleLoadouts.json + shipsForSale) ────────

export const LOADOUT_PRESETS: Record<string, { shipId: string; modules: Array<{ id?: string; name?: string }> }> = {
  lithosphere_ore: {
    shipId: 'lithosphere',
    modules: [
      { id: 'mining_laser_v' },
      { id: 'cargo_expander_iii' }, { id: 'cargo_expander_iii' },
      { id: 'cargo_expander_iii' }, { id: 'cargo_expander_iii' },
      { id: 'fuel_optimizer' },
    ],
  },
  grandtransit_rad: {
    shipId: 'exosphere',
    modules: [
      { id: 'rad_harvester_iv' },
      { id: 'lead_lined_cargo_ii' },
      { id: 'cargo_expander_iii' },
      { id: 'cargo_expander_iii' },
    ],
  },
  tellurian_strip: {
    shipId: 'tellurian',
    modules: [
      { id: 'strip_miner_iii' },
      { id: 'cargo_expander_iii' }, { id: 'cargo_expander_iii' },
    ],
  },
  glacialis_ice: {
    shipId: 'glacialis',
    modules: [
      { id: 'ice_harvester_iv' },
      { id: 'cargo_expander_iii' }, { id: 'cargo_expander_iii' },
    ],
  },
  riftdeep_core: {
    shipId: 'rift',
    modules: [
      { id: 'deep_core_extractor_mki' },
      { id: 'deep_core_survey_scanner' },
      { id: 'cargo_expander_iii' }, { id: 'cargo_expander_iii' },
    ],
  },
};

// ── Bot Mock Helpers ──────────────────────────────────────────────────────────

export interface MockBotState {
  username: string;
  system: string;
  poi: string | null;
  docked: boolean;
  fuel: number;
  maxFuel: number;
  cargo: number;
  cargoMax: number;
  credits: number;
  hull: number;
  maxHull: number;
  shield: number;
  maxShield: number;
  isInBattle: boolean;
  currentBattleId: string | null;
  state: 'running' | 'stopped' | 'dead';
  isCloaked: boolean;
  factionStorage: Array<{ itemId: string; quantity: number }>;
  inventory: Array<{ itemId: string; quantity: number }>;
}

export function createMockBotState(overrides: Partial<MockBotState> = {}): MockBotState {
  return {
    username: overrides.username || 'TestBot_001',
    system: overrides.system || 'sol',
    poi: overrides.poi || null,
    docked: overrides.docked ?? false,
    fuel: overrides.fuel ?? 100,
    maxFuel: overrides.maxFuel ?? 100,
    cargo: overrides.cargo ?? 0,
    cargoMax: overrides.cargoMax ?? 100,
    credits: overrides.credits ?? 10000,
    hull: overrides.hull ?? 520,
    maxHull: overrides.maxHull ?? 520,
    shield: overrides.shield ?? 130,
    maxShield: overrides.maxShield ?? 130,
    isInBattle: overrides.isInBattle ?? false,
    currentBattleId: overrides.currentBattleId ?? null,
    state: overrides.state || 'running',
    isCloaked: overrides.isCloaked ?? false,
    factionStorage: overrides.factionStorage || [],
    inventory: overrides.inventory || [],
  };
}

// ── Context Factory ───────────────────────────────────────────────────────────

export interface MockRoutineContext {
  bot: {
    exec: (cmd: string, payload?: Record<string, unknown>) => Promise<{ result?: unknown; error?: { code: string; message: string }; notifications?: Array<Record<string, unknown>> }>;
    refreshStatus: () => Promise<void>;
    refreshCargo: () => Promise<void>;
    refreshLocation: () => Promise<void>;
    refreshShip: () => Promise<void>;
    refreshFactionStorage: () => Promise<void>;
    refreshStorage: () => Promise<void>;
    state: string;
    username: string;
    system: string;
    poi: string | null;
    docked: boolean;
    fuel: number;
    maxFuel: number;
    cargo: number;
    cargoMax: number;
    hull: number;
    maxHull: number;
    shield: number;
    maxShield: number;
    isCloaked: boolean;
    factionStorage: Array<{ itemId: string; quantity: number }>;
    inventory: Array<{ itemId: string; quantity: number }>;
    credits: number;
  };
  log: (category: string, message: string) => void;
  sleep: (ms: number) => Promise<void>;
}

export function createMockCtx(state: Partial<MockBotState> = {}, execResponses?: Map<string, { result?: unknown; error?: { code: string; message: string } }>): MockRoutineContext {
  const s = createMockBotState(state);
  const commandHistory: Array<{ command: string; payload: Record<string, unknown> }> = [];

  const exec = async (cmd: string, payload: Record<string, unknown> = {}): Promise<{ result?: unknown; error?: { code: string; message: string }; notifications?: Array<Record<string, unknown>> }> => {
    commandHistory.push({ command: cmd, payload });
    if (execResponses?.has(cmd)) return execResponses.get(cmd)!;
    return {};
  };

  const ctx: MockRoutineContext = {
    bot: {
      exec,
      async refreshStatus() { s.system = s.system; },
      async refreshCargo() {},
      async refreshLocation() {},
      async refreshShip() {},
      async refreshFactionStorage() {},
      async refreshStorage() {},
      state: s.state,
      username: s.username,
      system: s.system,
      poi: s.poi,
      docked: s.docked,
      fuel: s.fuel,
      maxFuel: s.maxFuel,
      cargo: s.cargo,
      cargoMax: s.cargoMax,
      hull: s.hull,
      maxHull: s.maxHull,
      shield: s.shield,
      maxShield: s.maxShield,
      isCloaked: s.isCloaked,
      factionStorage: s.factionStorage,
      inventory: s.inventory,
      credits: s.credits,
    },
    log: vi.fn(),
    sleep: createMockSleep() as (ms: number) => Promise<void>,
  };

  return ctx;
}

// ── MapStore Stub ─────────────────────────────────────────────────────────────

export function createMapStoreStub() {
  const systems = new Map<string, {
    pois: Array<{
      id: string;
      name: string;
      has_base: boolean;
      hidden?: boolean;
      ores_found?: Array<{
        item_id: string;
        name: string;
        total_mined: number; times_seen: number; last_seen: string;
        depleted?: boolean;
        depleted_at?: string;
      }>;
    }>;
    name: string;
  }>();

  const store: any = {
    systems,
    getSystem(id: string) { return systems.get(id) || null; },
    addSystem(id: string, name: string, pois: any[] = []) {
      systems.set(id, { id, name, pois });
    },
    addPoi(systemId: string, poi: { id: string; name: string; has_base: boolean; hidden?: boolean; ores_found?: any[] }) {
      const sys = systems.get(systemId);
      if (!sys) return;
      sys.pois.push(poi);
    },
    findOreLocations(oreId: string, blacklist: string[] = [], includeHidden = false) {
      const results: any[] = [];
      for (const [sysId, sys] of systems) {
        if (blacklist.includes(sysId)) continue;
        for (const poi of sys.pois) {
          if (poi.hidden && !includeHidden) continue;
          const ore = poi.ores_found?.find((o: any) => o.item_id === oreId);
          const remaining = ore?.depleted ? 0 : (ore ? 1000 : 0);
          const maxRemaining = ore ? 2000 : 0;
          results.push({
            poiId: poi.id,
            poiName: poi.name,
            systemId: sysId,
            systemName: sys.name,
            richness: 500,
            remaining,
            maxRemaining,
            supportedPower: 100,
            minutesSinceScan: 10,
          });
        }
      }
      return results;
    },
    findRoute(from: string, to: string, blacklist: string[] = []) {
      if (from === to) return [from];
      return [from, to];
    },
    getAllKnownOres() {
      const ores = new Map<string, { item_id: string; name: string }>();
      for (const [, sys] of systems) {
        for (const poi of sys.pois) {
          for (const o of poi.ores_found || []) ores.set(o.item_id, o);
        }
      }
      return Array.from(ores.values());
    },
    registerPoiFromScan: vi.fn(),
    markOreDepleted: vi.fn(),
    updatePoiResources: vi.fn(),
    isDepletionExpired: vi.fn((at?: string) => !at),
  };
  return store;
}

// ── Chat Channel Mock ─────────────────────────────────────────────────────────

export function createMockChatChannel() {
  const messages: Array<{ sender: string; recipients: string[]; channel: string; content: string }> = [];
  const handlers = new Map<string, Array<(m: any) => void>>();

  return {
    send: (msg: any) => messages.push(msg),
    onMessage: (_username: string, handler: (m: any) => void) => {
      const key = _username;
      if (!handlers.has(key)) handlers.set(key, []);
      handlers.get(key)!.push(handler);
    },
    offMessage: (_username: string, handler: (m: any) => void) => {
      const arr = handlers.get(_username);
      if (arr) {
        const idx = arr.indexOf(handler);
        if (idx >= 0) arr.splice(idx, 1);
      }
    },
    getMessages: () => messages,
    emit: (msg: any) => {
      const key = msg.recipients?.length ? msg.recipients.join(',') : msg.channel;
      const h = handlers.get(key);
      if (h) h.forEach(fn => fn(msg));
    },
    reset() { messages.length = 0; handlers.clear(); },
  };
}

// ── Import After Mock ─────────────────────────────────────────────────────────

export async function importMinerAfterMocks() {
  await vi.importActual?.('src/routines/miner.ts') || (await import('../src/routines/miner.js'));
  return (await import('../src/routines/miner.ts')).minerRoutine;
}

// ── Fixture Loaders ───────────────────────────────────────────────────────────

export function loadSettingsFixture(path = 'data/settings.json'): Record<string, unknown> {
  const fs = require('fs');
  const pathMod = require('path');
  const candidates = [
    pathMod.join(process.cwd(), path),
    pathMod.join(__dirname, '..', 'data', 'settings.json'),
    'E:/code/code/spacemolt_botrunner/' + path.replace(/^\.?\//, '')
  ];
  for (const candidate of candidates) {
    try {
      const raw = fs.readFileSync(candidate, 'utf-8');
      return JSON.parse(raw);
    } catch {}
  }
  return {};
}

export function writeSettingsFixture(data: Record<string, unknown>, path = 'data/settings.json') {
  require('fs').writeFileSync(require('path').join(process.cwd(), path), JSON.stringify(data, null, 2), 'utf-8');
}

export function loadMapFixture(path = 'data/map.json'): any {
  try {
    const raw = require('fs').readFileSync(require('path').join(process.cwd(), path), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { systems: {} };
  }
}
