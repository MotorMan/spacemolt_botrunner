/**
 * Combat Decision Logic Tests
 *
 * Tests the new player-vs-pirate combat decision system:
 * 1. hasWeapons() - detects weapon-equipped ships
 * 2. getShipTier() - gets ship tier from catalog
 * 3. parseNearbyEntities() - parses get_nearby for pirates/players
 * 4. shouldEngagePlayersInCombat() - decides whether to fight players
 * 5. engageInBattle() - battle engagement sequence
 * 6. monitorAndHandleBattleFlee() - battle monitoring and fleeing
 */

import { expect, test } from 'vitest';
import { hasWeapons, getShipTier, parseNearbyEntities, shouldEngagePlayersInCombat, engageInBattle, monitorAndHandleBattleFlee } from '../src/routines/common.ts';

// Mock types and interfaces
interface MockAPIResponse {
  error?: { message: string };
  result?: unknown;
}

interface MockBot {
  exec: (command: string, params?: Record<string, unknown>) => Promise<MockAPIResponse>;
  settings?: Record<string, unknown>;
  hull: number;
  maxHull: number;
  refreshStatus: () => Promise<void>;
}

interface MockRoutineContext {
  bot: MockBot;
  log: (category: string, message: string) => void;
}

// Test helpers

// Test helper: Create mock bot
function createMockBot(responses: Record<string, MockAPIResponse>): MockBot {
  return {
    exec: async (command: string) => {
      return responses[command] || { error: { message: 'Unknown command' } };
    },
    settings: {
      general: {
        fightTier0Ships: true,
        fightTier1Ships: true,
        maxTier0Ships: 8,
        hullFleeThreshold: 20,
      }
    },
    hull: 80,
    maxHull: 100,
    refreshStatus: async () => { /* mock */ },
  };
}

// Test helper: Create mock context
function createMockContext(bot: MockBot): MockRoutineContext {
  return {
    bot,
    log: (category: string, message: string) => {
      console.log(`[${category}] ${message}`);
    },
  };
}

console.log('⚔️  Combat Decision Logic Tests\n');

// ── Test hasWeapons ──────────────────────────────────────────────

test('hasWeapons detects weapon-equipped ships', async () => {
  // Test: Ship with weapons
  const mockBot = createMockBot({
    get_ship: {
      result: {
        modules: [
          { category: 'weapon', name: 'pulse_laser_iii' },
          { category: 'engine', name: 'fusion_drive' },
        ]
      }
    }
  });
  const ctx = createMockContext(mockBot);

  const hasWeaponsResult = await hasWeapons(ctx);
  expect(hasWeaponsResult).toBe(true);
});

test('hasWeapons detects ships without weapons', async () => {
  // Test: Ship without weapons
  const mockBot = createMockBot({
    get_ship: {
      result: {
        modules: [
          { category: 'engine', name: 'fusion_drive' },
          { category: 'cargo', name: 'cargo_bay' },
        ]
      }
    }
  });
  const ctx = createMockContext(mockBot);

  const hasWeaponsResult = await hasWeapons(ctx);
  expect(hasWeaponsResult).toBe(false);
});

// ── Test getShipTier ─────────────────────────────────────────────

test('getShipTier returns correct tier for known ships', () => {
  // Test: Known T0 ship
  const tier = getShipTier('cobble');
  expect(tier).toBe(0);
});

test('getShipTier returns null for unknown ships', () => {
  // Test: Unknown ship
  const tier = getShipTier('unknown_ship_123');
  expect(tier).toBeNull();
});

// ── Test parseNearbyEntities ─────────────────────────────────────

test('parseNearbyEntities detects pirates only', () => {
  const nearbyData = {
    entities: [
      { id: 'pirate_1', pirate_id: 'pirate_1', type: 'pirate', tier: 'small' },
      { id: 'pirate_2', pirate_id: 'pirate_2', type: 'pirate', tier: 'medium' },
    ]
  };

  const result = parseNearbyEntities(nearbyData);
  expect(result.hasPirates).toBe(true);
  expect(result.hasPlayers).toBe(false);
  expect(result.pirateCount).toBe(2);
  expect(result.playerCount).toBe(0);
});

test('parseNearbyEntities detects players with correct ship tiers', () => {
  const nearbyData = {
    entities: [
      { id: 'player_1', type: 'player', ship_id: 'cobble', username: 'starter1' }, // T0
      { id: 'player_2', type: 'player', ship_id: 'loose_change', username: 'starter2' }, // T1
    ]
  };

  const result = parseNearbyEntities(nearbyData);
  expect(result.hasPirates).toBe(false);
  expect(result.hasPlayers).toBe(true);
  expect(result.pirateCount).toBe(0);
  expect(result.playerCount).toBe(2);
  expect(result.players[0].shipTier).toBe(0);
  expect(result.players[1].shipTier).toBe(1);
});

test('parseNearbyEntities handles mixed pirates and players', () => {
  const nearbyData = {
    entities: [
      { id: 'pirate_1', pirate_id: 'pirate_1', type: 'pirate', tier: 'boss' },
      { id: 'player_1', type: 'player', ship_id: 'cobble', username: 'starter' },
    ]
  };

  const result = parseNearbyEntities(nearbyData);
  expect(result.hasPirates).toBe(true);
  expect(result.hasPlayers).toBe(true);
  expect(result.pirateCount).toBe(1);
  expect(result.playerCount).toBe(1);
});

// ── Test shouldEngagePlayersInCombat ────────────────────────────

test('shouldEngagePlayersInCombat fights T0 players with weapons', async () => {
  const players = [
    { id: 'p1', name: 'player1', shipTier: 0 } as any,
    { id: 'p2', name: 'player2', shipTier: 0 } as any,
  ];

  const mockBot = createMockBot({
    get_ship: {
      result: {
        modules: [{ category: 'weapon', name: 'pulse_laser_iii' }]
      }
    }
  });
  const ctx = createMockContext(mockBot);

  const shouldFight = await shouldEngagePlayersInCombat(ctx, players);
  expect(shouldFight).toBe(true);
});

test('shouldEngagePlayersInCombat does not fight without weapons', async () => {
  const players = [
    { id: 'p1', name: 'player1', shipTier: 0 } as any,
  ];

  const mockBot = createMockBot({
    get_ship: {
      result: {
        modules: [{ category: 'engine', name: 'fusion_drive' }]
      }
    }
  });
  const ctx = createMockContext(mockBot);

  const shouldFight = await shouldEngagePlayersInCombat(ctx, players);
  expect(shouldFight).toBe(false);
});

test('shouldEngagePlayersInCombat does not fight too many T0 ships', async () => {
  const manyPlayers = Array(10).fill(null).map((_, i) => ({
    id: `p${i}`,
    name: `player${i}`,
    shipTier: 0
  })) as any[];

  const mockBot = createMockBot({
    get_ship: {
      result: {
        modules: [{ category: 'weapon', name: 'pulse_laser_iii' }]
      }
    }
  });
  const ctx = createMockContext(mockBot);

  const shouldFight = await shouldEngagePlayersInCombat(ctx, manyPlayers);
  expect(shouldFight).toBe(false);
});

test('shouldEngagePlayersInCombat does not fight T2+ ships', async () => {
  const highTierPlayers = [
    { id: 'p1', name: 'player1', shipTier: 2 } as any,
  ];

  const mockBot = createMockBot({
    get_ship: {
      result: {
        modules: [{ category: 'weapon', name: 'pulse_laser_iii' }]
      }
    }
  });
  const ctx = createMockContext(mockBot);

  const shouldFight = await shouldEngagePlayersInCombat(ctx, highTierPlayers);
  expect(shouldFight).toBe(false);
});

// ── Test engageInBattle ──────────────────────────────────────────

test('engageInBattle sends correct battle engagement sequence', async () => {
  let commandsSent: string[] = [];
  const mockBot = createMockBot({
    'battle': { result: { success: true } }
  });

  // Override exec to capture commands
  mockBot.exec = async (command: string, params?: any) => {
    if (command === 'battle') {
      commandsSent.push(`${params.action} ${params.stance || ''}`.trim());
    }
    return { result: { success: true } };
  };

  const ctx = createMockContext(mockBot);

  await engageInBattle(ctx);

  // Should send: advance, advance, advance, stance fire
  expect(commandsSent).toEqual(['advance', 'advance', 'advance', 'stance fire']);
});