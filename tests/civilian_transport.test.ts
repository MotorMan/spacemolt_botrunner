import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = join(process.cwd(), 'spacemolt_botrunner');

function repoPath(p: string): string {
  return join(REPO_ROOT, p);
}

// ── Inline copies of the pure helpers we want to test ────────

interface TransportPassenger {
  citizenId: string;
  name: string;
  accommodationClass: 'economy' | 'business' | 'first';
  citizenship: string;
  destination: string;
  destinationName: string;
  fare: number;
  bio: string;
  routeData: unknown;
  loadedAt: string;
  status: 'boarded' | 'delivered' | 'stranded';
  ticksRemaining?: number;
}

interface TransportState {
  botUsername: string;
  status: 'idle' | 'traveling_to_ship' | 'loading' | 'in_transit' | 'unloading' | 'completed';
  shipId: string;
  shipName: string;
  tier: number | null;
  berths: { economy: number; business: number; first: number };
  onboardPassengers: TransportPassenger[];
  pickupStation: string | null;
  pickupSystem: string | null;
  route: Array<{ system: string; poi: string; poiName: string }>;
  currentRouteIndex: number;
  revenue: number;
  totalFaresEarned: number;
  currentDestination: string | null;
  lastUpdated: string;
}

function makeNewState(
  botUsername: string,
  shipId: string,
  shipName: string,
  tier: number | null,
  berths: { economy: number; business: number; first: number },
): TransportState {
  return {
    botUsername,
    status: 'idle',
    shipId,
    shipName,
    tier,
    berths,
    onboardPassengers: [],
    pickupStation: null,
    pickupSystem: null,
    route: [],
    currentRouteIndex: 0,
    revenue: 0,
    totalFaresEarned: 0,
    currentDestination: null,
    lastUpdated: new Date().toISOString(),
  };
}

function parseStationPassengers(result: unknown): { station: string; waiting: any[]; count: number } | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  const inner =
    r.structuredContent && typeof r.structuredContent === 'object'
      ? (r.structuredContent as Record<string, unknown>)
      : r;
  const waiting = Array.isArray(inner.waiting) ? (inner.waiting as any[]) : [];
  return {
    station: (inner.station as string) || '',
    waiting,
    count: (inner.count as number) || waiting.length,
  };
}

function parseListPassengers(result: unknown): { passengers: any[]; berths: Record<string, number>; berths_used: Record<string, number> } | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  const inner =
    r.structuredContent && typeof r.structuredContent === 'object'
      ? (r.structuredContent as Record<string, unknown>)
      : r;
  const passengers = Array.isArray(inner.passengers) ? (inner.passengers as any[]) : [];
  const berths = (inner.berths || {}) as Record<string, number>;
  const berthsUsed = (inner.berths_used || {}) as Record<string, number>;
  return {
    passengers,
    berths,
    berths_used: berthsUsed,
  };
}

function planTourRoute(
  current: string,
  destinations: Array<{ system: string; poi: string; poiName: string }>,
): Array<{ system: string; poi: string; poiName: string }> {
  if (destinations.length <= 1) return destinations;
  const remaining = destinations.slice();
  const planned: typeof destinations = [];
  let cur = current;
  while (remaining.length > 0) {
    remaining.sort((a, b) => {
      // Mock hops: same system = 0, different = 1
      const ha = a.system.toLowerCase() === cur.toLowerCase() ? 0 : 1;
      const hb = b.system.toLowerCase() === cur.toLowerCase() ? 0 : 1;
      return ha - hb;
    });
    const next = remaining.shift()!;
    planned.push(next);
    cur = next.system;
  }
  return planned;
}

// JSON persistence helpers for the fixture file
const DATA_FILE = repoPath('spacemolt_botrunner/data/civilianTransport.json');

function loadAllData() {
  try {
    const raw = readFileSync(DATA_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { version: 1, runs: {}, fleet: { version: 1, bots: {} } };
  }
}

function saveAllData(data: Record<string, unknown>) {
  try {
    mkdirSync(join(REPO_ROOT, 'spacemolt_botrunner/data'), { recursive: true });
    writeFileSync(DATA_FILE, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  } catch (err) {
    console.error('saveAllData failed:', err);
  }
}

function saveTransportState(state: TransportState) {
  const data = loadAllData();
  (data.runs as Record<string, TransportState>)[state.botUsername] = state;
  data.lastUpdated = new Date().toISOString();
  saveAllData(data);
}

function loadTransportState(username: string): TransportState | null {
  const data = loadAllData();
  return (data.runs as Record<string, TransportState> | undefined)?.[username] || null;
}

function clearTransportState(username: string) {
  const data = loadAllData();
  delete (data.runs as Record<string, TransportState | undefined>)[username];
  saveAllData(data);
}

// ── Tests ────────────────────────────────────────────────────

describe('parseStationPassengers', () => {
  it('parses standard response', () => {
    const input = {
      station: 'Confederacy Central Command',
      waiting: [
        {
          citizen_id: 'mirana_tarrbrook',
          name: 'Mirana Tarrbrook',
          class: 'economy',
          citizenship: 'solarian',
          destination: 'nova_terra_central',
          destination_name: 'Nova Terra Central',
        },
      ],
      count: 1,
    };
    const result = parseStationPassengers(input);
    expect(result).not.toBeNull();
    expect(result!.station).toBe('Confederacy Central Command');
    expect(result!.count).toBe(1);
    expect(result!.waiting).toHaveLength(1);
    expect(result!.waiting[0].citizen_id).toBe('mirana_tarrbrook');
    expect(result!.waiting[0].destination_name).toBe('Nova Terra Central');
  });

  it('parses nested structuredContent response', () => {
    const input = {
      structuredContent: {
        station: 'Alpha Station',
        waiting: [
          {
            citizen_id: 'jdoe',
            name: 'John Doe',
            class: 'business',
            citizenship: 'solarian',
            destination: 'beta_hub',
            destination_name: 'Beta Hub',
          },
        ],
        count: 1,
      },
    };
    const result = parseStationPassengers(input);
    expect(result).not.toBeNull();
    expect(result!.station).toBe('Alpha Station');
    expect(result!.waiting[0].name).toBe('John Doe');
  });

  it('returns null for non-object input', () => {
    expect(parseStationPassengers(null)).toBeNull();
    expect(parseStationPassengers('string')).toBeNull();
    expect(parseStationPassengers(undefined)).toBeNull();
  });

  it('returns empty waiting array for zero-count station', () => {
    const result = parseStationPassengers({ station: 'Empty Station', waiting: [], count: 0 });
    expect(result!.waiting).toHaveLength(0);
  });
});

describe('parseListPassengers', () => {
  it('parses list_passengers response with fares and bios', () => {
    const input = {
      passengers: [
        {
          citizen_id: 'mirana_tarrbrook',
          name: 'Mirana Tarrbrook',
          class: 'economy',
          citizenship: 'solarian',
          destination: 'nova_terra_central',
          destination_name: 'Nova Terra Central',
          fare: 12500,
          bio: 'A seasoned diplomat from the outer rim.',
          ticks_remaining: 45,
          route_data: { via: ['alpha_centauri'], estimated_ticks: 30 },
        },
      ],
      berths: { economy: 4, business: 2, first: 1 },
      berths_used: { economy: 1, business: 0, first: 0 },
    };
    const result = parseListPassengers(input);
    expect(result).not.toBeNull();
    expect(result!.passengers).toHaveLength(1);
    expect(result!.passengers[0].fare).toBe(12500);
    expect(result!.passengers[0].bio).toBe('A seasoned diplomat from the outer rim.');
    expect(result!.berths.economy).toBe(4);
    expect(result!.berths_used.first).toBe(0);
  });

  it('parses nested structuredContent', () => {
    const input = {
      structuredContent: {
        passengers: [],
        berths: { economy: 0, business: 0, first: 0 },
        berths_used: { economy: 0, business: 0, first: 0 },
      },
    };
    const result = parseListPassengers(input);
    expect(result).not.toBeNull();
    expect(result!.passengers).toHaveLength(0);
    expect(result!.berths.economy).toBe(0);
  });

  it('returns null for non-object input', () => {
    expect(parseListPassengers(null)).toBeNull();
    expect(parseListPassengers({})).not.toBeNull();
    expect(parseListPassengers({}).passengers).toHaveLength(0);
  });
});

describe('planTourRoute', () => {
  it('returns single-element array as-is', () => {
    const dests = [{ system: 'sol', poi: 'sol_central', poiName: 'Sol Central' }];
    expect(planTourRoute('sol', dests)).toEqual(dests);
  });

  it('returns empty array for empty input', () => {
    expect(planTourRoute('sol', [])).toEqual([]);
  });

  it('plans a nearest-first tour by closest system', () => {
    const dests = [
      { system: 'alpha_centauri', poi: 'alpha_station', poiName: 'Alpha Station' },
      { system: 'procyon', poi: 'procyon_station', poiName: 'Procyon Station' },
      { system: 'sol', poi: 'sol_central', poiName: 'Sol Central' },
    ];
    // With mocked same-system priority, from 'sol' the nearest is 'sol' first, then the rest
    const planned = planTourRoute('sol', dests);
    expect(planned).toHaveLength(3);
    expect(planned[0].system.toLowerCase()).toBe('sol');
  });

  it('does not modify the original destination array', () => {
    const dests = [
      { system: 'alpha_centauri', poi: 'alpha_station', poiName: 'Alpha Station' },
      { system: 'procyon', poi: 'procyon_station', poiName: 'Procyon Station' },
    ];
    const original = JSON.stringify(dests);
    planTourRoute('sol', dests);
    expect(JSON.stringify(dests)).toBe(original);
  });
});

describe('makeNewState', () => {
  it('creates a valid idle transport state', () => {
    const state = makeNewState('test_bot', 'ship_1', 'Test Ship', 2, { economy: 4, business: 2, first: 1 });
    expect(state.botUsername).toBe('test_bot');
    expect(state.status).toBe('idle');
    expect(state.shipId).toBe('ship_1');
    expect(state.shipName).toBe('Test Ship');
    expect(state.tier).toBe(2);
    expect(state.berths.economy).toBe(4);
    expect(state.onboardPassengers).toHaveLength(0);
    expect(state.revenue).toBe(0);
  });
});

describe('TransportState persistence', () => {
  beforeEach(() => {
    try { mkdirSync(join(REPO_ROOT, 'spacemolt_botrunner/data'), { recursive: true }); } catch {}
    writeFileSync(DATA_FILE, JSON.stringify({ version: 1, runs: {}, fleet: { version: 1, bots: {} } }, null, 2) + '\n');
  });

  afterEach(() => {
    try { unlinkSync(DATA_FILE); } catch {}
  });

  it('saves and loads a transport state from the JSON file', () => {
    const state = makeNewState('persist_bot', 'ship_99', 'Persist Ship', 1, { economy: 5, business: 2, first: 0 });
    state.status = 'in_transit';
    state.revenue = 1234;
    state.onboardPassengers = [
      {
        citizenId: 'p1',
        name: 'Passenger One',
        accommodationClass: 'economy',
        citizenship: 'solarian',
        destination: 'dest_1',
        destinationName: 'Dest One',
        fare: 5000,
        bio: 'Bio here.',
        routeData: null,
        loadedAt: new Date().toISOString(),
        status: 'boarded',
        ticksRemaining: 30,
      },
    ];
    saveTransportState(state);

    const loaded = loadTransportState('persist_bot');
    expect(loaded).not.toBeNull();
    expect(loaded!.status).toBe('in_transit');
    expect(loaded!.shipName).toBe('Persist Ship');
    expect(loaded!.berths.economy).toBe(5);
    expect(loaded!.onboardPassengers).toHaveLength(1);
    expect(loaded!.onboardPassengers[0].name).toBe('Passenger One');
    expect(loaded!.onboardPassengers[0].fare).toBe(5000);
    expect(loaded!.revenue).toBe(1234);

    clearTransportState('persist_bot');
    expect(loadTransportState('persist_bot')).toBeNull();
  });

  it('handles corrupt JSON gracefully during load', () => {
    writeFileSync(DATA_FILE, '{ not valid json }');
    let threw = false;
    let result: TransportState | null = null;
    try {
      result = loadTransportState('any_bot');
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result).toBeNull();
  });
});
