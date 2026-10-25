import { describe, it, expect } from 'vitest';
import {
  evaluateSupplies,
  clampAmmoLow,
  clampConsumableDays,
  clampSupplyRefreshMin,
  SECS_PER_MAINT_CYCLE,
  type SupplyFacility,
  type SupplyStock,
  type SupplyThresholds,
} from '../src/web/stationMonitorStore.js';

// ── helpers ────────────────────────────────────────────────────

const THRESHOLDS: SupplyThresholds = { ammoLowThreshold: 100, consumableLowDays: 2 };

function gun(name: string, ammoItem: string, active = true): SupplyFacility {
  return { name, active, maintenance: [], ammoItem };
}

function facility(
  name: string,
  maintenance: { item_id: string; quantity: number }[],
  active = true,
): SupplyFacility {
  return { name, active, maintenance, ammoItem: null };
}

function stockOf(
  entries: Record<string, number>,
  source: SupplyStock['source'] = 'live',
): SupplyStock {
  return {
    stock: new Map(Object.entries(entries)),
    names: new Map(),
    at: source === 'none' ? null : Date.now(),
    source,
  };
}

/** Units of a maintenance item that represent exactly `days` of stock at `perCycle`. */
function unitsForDays(days: number, perCycle: number): number {
  return (days * 86_400 * perCycle) / SECS_PER_MAINT_CYCLE;
}

const FACS_AT = Date.now();

// ── ammo ───────────────────────────────────────────────────────

describe('station supply evaluation — gun ammo', () => {
  it('flags OUT when an ammo item is empty (the gun cannot fire)', () => {
    const r = evaluateSupplies(
      [gun('Scrap Flak Battery', 'scrap_shot')],
      FACS_AT,
      stockOf({ scrap_shot: 0 }),
      THRESHOLDS,
    );
    expect(r.ammo).toBe('out');
    expect(r.guns).toBe(1);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ itemId: 'scrap_shot', kind: 'ammo', have: 0, level: 'out' });
  });

  it('flags OUT when the ammo item is absent from faction storage entirely', () => {
    const r = evaluateSupplies(
      [gun('Siege Lance', 'focused_plasma_cell_pack')],
      FACS_AT,
      stockOf({ scrap_shot: 5000 }),
      THRESHOLDS,
    );
    expect(r.ammo).toBe('out');
    expect(r.items[0].have).toBe(0);
  });

  it('flags LOW at or below the configured round threshold, and OK above it', () => {
    const below = evaluateSupplies([gun('A', 'scrap_shot')], FACS_AT, stockOf({ scrap_shot: 99 }), THRESHOLDS);
    const at = evaluateSupplies([gun('A', 'scrap_shot')], FACS_AT, stockOf({ scrap_shot: 100 }), THRESHOLDS);
    const above = evaluateSupplies([gun('A', 'scrap_shot')], FACS_AT, stockOf({ scrap_shot: 101 }), THRESHOLDS);
    expect(below.ammo).toBe('low');
    expect(at.ammo).toBe('low'); // "at or below" is low
    expect(above.ammo).toBe('ok');
  });

  it('measures the threshold against total stock per ammo type, not per gun', () => {
    // Three guns sharing scrap_shot with 150 rounds: above the 100 threshold, so
    // still OK. (Per-gun accounting would have called this low.)
    const r = evaluateSupplies(
      [gun('Flak 1', 'scrap_shot'), gun('Flak 2', 'scrap_shot'), gun('Flak 3', 'scrap_shot')],
      FACS_AT,
      stockOf({ scrap_shot: 150 }),
      THRESHOLDS,
    );
    expect(r.ammo).toBe('ok');
    expect(r.guns).toBe(3);
    // One row per ammo type, with the gun count as its "need".
    expect(r.items).toHaveLength(1);
    expect(r.items[0].need).toBe(3);
    expect(r.items[0].facilities).toEqual(['Flak 1', 'Flak 2', 'Flak 3']);
  });

  it('never projects a depletion time for ammo (no per-shot burn rate)', () => {
    const r = evaluateSupplies([gun('A', 'scrap_shot')], FACS_AT, stockOf({ scrap_shot: 20 }), THRESHOLDS);
    expect(r.items[0].daysLeft).toBeNull();
  });

  it('ignores guns that are inactive or under construction', () => {
    const r = evaluateSupplies(
      [gun('Offline Turret', 'scrap_shot', false)],
      FACS_AT,
      stockOf({}),
      THRESHOLDS,
    );
    expect(r.guns).toBe(0);
    expect(r.ammo).toBe('ok');
    expect(r.items).toHaveLength(0);
  });

  it('reports OK for ammo when the station has no armed guns at all', () => {
    const r = evaluateSupplies(
      [facility('Market', [{ item_id: 'power_cell', quantity: 1 }])],
      FACS_AT,
      stockOf({ power_cell: 999_999 }),
      THRESHOLDS,
    );
    expect(r.ammo).toBe('ok');
    expect(r.guns).toBe(0);
  });

  it('treats an ammoLowThreshold of 0 as "only warn when empty"', () => {
    const t: SupplyThresholds = { ammoLowThreshold: 0, consumableLowDays: 2 };
    expect(evaluateSupplies([gun('A', 'scrap_shot')], FACS_AT, stockOf({ scrap_shot: 1 }), t).ammo).toBe('ok');
    expect(evaluateSupplies([gun('A', 'scrap_shot')], FACS_AT, stockOf({ scrap_shot: 0 }), t).ammo).toBe('out');
  });
});

// ── maintenance consumables ────────────────────────────────────

describe('station supply evaluation — maintenance consumables', () => {
  it('flags OUT when a maintenance input is depleted', () => {
    const r = evaluateSupplies(
      [facility('Repair Dock', [{ item_id: 'power_cell', quantity: 1 }])],
      FACS_AT,
      stockOf({ power_cell: 0 }),
      THRESHOLDS,
    );
    expect(r.maintenance).toBe('out');
    expect(r.items[0].level).toBe('out');
  });

  it('projects days remaining from the once-per-1000-tick draw', () => {
    // 1 unit/cycle, 10000s per cycle => 8.64 cycles per day.
    const r = evaluateSupplies(
      [facility('Repair Dock', [{ item_id: 'power_cell', quantity: 1 }])],
      FACS_AT,
      stockOf({ power_cell: 86.4 }),
      { ammoLowThreshold: 100, consumableLowDays: 0 },
    );
    expect(r.items[0].daysLeft).toBeCloseTo(10, 5);
  });

  it('flags LOW at or below the configured days-left threshold', () => {
    const perCycle = 2;
    const mk = (days: number) =>
      evaluateSupplies(
        [facility('Bulwark', [{ item_id: 'armor_plate', quantity: perCycle }])],
        FACS_AT,
        stockOf({ armor_plate: unitsForDays(days, perCycle) }),
        THRESHOLDS, // consumableLowDays: 2
      );
    expect(mk(1.9).maintenance).toBe('low');
    expect(mk(2).maintenance).toBe('low'); // "at or below"
    expect(mk(2.1).maintenance).toBe('ok');
  });

  it('sums the per-cycle need across every facility sharing an input', () => {
    const r = evaluateSupplies(
      [
        facility('Dock A', [{ item_id: 'power_cell', quantity: 1 }]),
        facility('Dock B', [{ item_id: 'power_cell', quantity: 3 }]),
      ],
      FACS_AT,
      stockOf({ power_cell: 40 }),
      THRESHOLDS,
    );
    expect(r.items).toHaveLength(1);
    expect(r.items[0].need).toBe(4);
    // 40 units / 4 per cycle = 10 cycles = 100000s ≈ 1.157 days -> low at 2d.
    expect(r.items[0].daysLeft).toBeCloseTo(1.16, 2);
    expect(r.maintenance).toBe('low');
  });

  it('excludes inactive facilities from the maintenance draw', () => {
    const r = evaluateSupplies(
      [
        facility('Live', [{ item_id: 'power_cell', quantity: 1 }]),
        facility('Halted', [{ item_id: 'power_cell', quantity: 99 }], false),
      ],
      FACS_AT,
      stockOf({ power_cell: 500 }),
      THRESHOLDS,
    );
    expect(r.items[0].need).toBe(1);
    expect(r.items[0].facilities).toEqual(['Live']);
  });

  it('treats a consumableLowDays of 0 as "only warn when empty"', () => {
    const t: SupplyThresholds = { ammoLowThreshold: 100, consumableLowDays: 0 };
    const f = [facility('Dock', [{ item_id: 'power_cell', quantity: 10 }])];
    expect(evaluateSupplies(f, FACS_AT, stockOf({ power_cell: 1 }), t).maintenance).toBe('ok');
    expect(evaluateSupplies(f, FACS_AT, stockOf({ power_cell: 0 }), t).maintenance).toBe('out');
  });
});

// ── unknown / never-false-alarm behaviour ──────────────────────

describe('station supply evaluation — unknown data must not raise alarms', () => {
  it('grades everything unknown when faction storage could not be read', () => {
    const r = evaluateSupplies(
      [gun('Turret', 'scrap_shot'), facility('Dock', [{ item_id: 'power_cell', quantity: 1 }])],
      FACS_AT,
      stockOf({}, 'none'),
      THRESHOLDS,
    );
    expect(r.ammo).toBe('unknown');
    expect(r.maintenance).toBe('unknown');
    expect(r.items.every((i) => i.level === 'unknown')).toBe(true);
    expect(r.note).toMatch(/faction storage/i);
  });

  it('grades both categories unknown when the facility list is unavailable', () => {
    const r = evaluateSupplies([], null, stockOf({}, 'none'), THRESHOLDS);
    expect(r.ammo).toBe('unknown');
    expect(r.maintenance).toBe('unknown');
    expect(r.note).toMatch(/facility list/i);
  });

  it('reports OK (not unknown) for a station with a known-empty facility list', () => {
    const r = evaluateSupplies([], FACS_AT, stockOf({}), THRESHOLDS);
    expect(r.ammo).toBe('ok');
    expect(r.maintenance).toBe('ok');
    expect(r.note).toBeNull();
  });

  it('keeps a genuinely empty faction storage as OUT rather than unknown', () => {
    // source "live"/"cache" with no entries means we really did read it and the
    // shelves are bare — that is an outage, not missing data.
    const r = evaluateSupplies([gun('Turret', 'scrap_shot')], FACS_AT, stockOf({}, 'live'), THRESHOLDS);
    expect(r.ammo).toBe('out');
    expect(r.note).toBeNull();
  });
});

// ── category aggregation + ordering ────────────────────────────

describe('station supply evaluation — aggregation', () => {
  it('reports the worst level per category independently', () => {
    const r = evaluateSupplies(
      [
        gun('Turret', 'scrap_shot'), // 5000 rounds -> ok
        facility('Dock', [{ item_id: 'power_cell', quantity: 1 }]), // depleted -> out
      ],
      FACS_AT,
      stockOf({ scrap_shot: 5000, power_cell: 0 }),
      THRESHOLDS,
    );
    expect(r.ammo).toBe('ok');
    expect(r.maintenance).toBe('out');
  });

  it('lets OUT outrank LOW within a category', () => {
    const r = evaluateSupplies(
      [gun('Turret A', 'scrap_shot'), gun('Turret B', 'ferrous_slug_case')],
      FACS_AT,
      stockOf({ scrap_shot: 10, ferrous_slug_case: 0 }),
      THRESHOLDS,
    );
    expect(r.ammo).toBe('out');
  });

  it('lists ammo rows before maintenance rows', () => {
    const r = evaluateSupplies(
      [
        facility('Dock', [{ item_id: 'aaa_power_cell', quantity: 1 }]),
        gun('Turret', 'zzz_scrap_shot'),
      ],
      FACS_AT,
      stockOf({ aaa_power_cell: 10, zzz_scrap_shot: 10 }),
      THRESHOLDS,
    );
    expect(r.items.map((i) => i.kind)).toEqual(['ammo', 'maintenance']);
  });

  it('resolves display names from the storage read, then the item catalog', () => {
    const stock = stockOf({ scrap_shot: 10, power_cell: 10 });
    stock.names.set('scrap_shot', 'Scrap Shot (from storage)');
    const r = evaluateSupplies(
      [gun('Turret', 'scrap_shot'), facility('Dock', [{ item_id: 'power_cell', quantity: 1 }])],
      FACS_AT,
      stock,
      THRESHOLDS,
      { power_cell: 'Power Cell (from catalog)' },
    );
    const byId = Object.fromEntries(r.items.map((i) => [i.itemId, i.name]));
    expect(byId.scrap_shot).toBe('Scrap Shot (from storage)');
    expect(byId.power_cell).toBe('Power Cell (from catalog)');
  });

  it('falls back to the raw item id when no name is known', () => {
    const r = evaluateSupplies([gun('Turret', 'mystery_ammo')], FACS_AT, stockOf({ mystery_ammo: 5 }), THRESHOLDS);
    expect(r.items[0].name).toBe('mystery_ammo');
  });
});

// ── threshold clamps ───────────────────────────────────────────

describe('threshold clamps', () => {
  it('clamps ammo thresholds and rejects nonsense', () => {
    expect(clampAmmoLow(250)).toBe(250);
    expect(clampAmmoLow(0)).toBe(0);
    expect(clampAmmoLow(12.6)).toBe(13);
    expect(clampAmmoLow(-5)).toBe(100); // default
    expect(clampAmmoLow(NaN)).toBe(100);
    expect(clampAmmoLow(99_999_999)).toBe(10_000_000);
  });

  it('clamps consumable days to one decimal', () => {
    expect(clampConsumableDays(2)).toBe(2);
    expect(clampConsumableDays(0.5)).toBe(0.5);
    expect(clampConsumableDays(0.46)).toBe(0.5);
    expect(clampConsumableDays(0)).toBe(0);
    expect(clampConsumableDays(-1)).toBe(2); // default
    expect(clampConsumableDays(99_999)).toBe(3650);
  });

  it('clamps the supply re-read interval to a sane minute range', () => {
    expect(clampSupplyRefreshMin(10)).toBe(10);
    expect(clampSupplyRefreshMin(0)).toBe(10); // default
    expect(clampSupplyRefreshMin(-3)).toBe(10);
    expect(clampSupplyRefreshMin(5000)).toBe(1440);
  });
});
