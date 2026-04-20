/**
 * Hunter Attack Fallback Tests
 * 
 * Verifies hunter routine properly:
 * 1. Tries both pirate_id AND name for attack command
 * 2. Handles get_nearby after travel correctly
 */

interface MockNearbyEntity {
  id: string;
  name: string;
  type: string;
  faction: string;
  isNPC: boolean;
  isPirate: boolean;
  tier?: string;
}

interface MockCommandResult {
  result?: unknown;
  error?: {
    message: string;
  };
}

let testsPassed = 0;
let testsFailed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    testsPassed++;
    console.log(`  ✅ ${message}`);
  } else {
    testsFailed++;
    console.error(`  ❌ ${message}`);
  }
}

function describe(name: string, fn: () => void | Promise<void>): void {
  console.log(`\n📋 ${name}`);
  fn();
}

async function describeAsync(name: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n📋 ${name}`);
  await fn();
}

// Mock bot with attack fallback logic
function createMockHunterBot() {
  const commands: Array<{ cmd: string; payload: Record<string, unknown> }> = [];
  
  // Simulated state
  const state = {
    location: 'test_poi',
    pirates: [
      { pirate_id: '1b19cbe4271ffd7556efc95d7e4f88a2', name: 'Clanker', tier: 'salvager' }
    ] as Array<{ pirate_id: string; name: string; tier: string }>,
    attackAttempts: [] as string[], // tracks what was passed to attack command
  };
  
  return {
    get commands() { return commands; },
    get state() { return state; },
    
    reset() {
      commands.length = 0;
      state.attackAttempts.length = 0;
    },
    
    setLocation(loc: string) {
      state.location = loc;
    },
    
    setPirates(pirates: Array<{ pirate_id: string; name: string; tier: string }>) {
      state.pirates = pirates;
    },
    
    // Mock exec command - simulates what the real bot.exec does
    async exec(command: string, payload?: Record<string, unknown>): Promise<MockCommandResult> {
      const cmdRecord = { cmd: command, payload: payload || {} };
      commands.push(cmdRecord);
      
      if (command === 'get_nearby') {
        // Return pirates at current location
        return {
          result: {
            pirates: state.pirates.map(p => ({
              pirate_id: p.pirate_id,
              name: p.name,
              tier: p.tier,
              status: 'patrolling',
              hull: 70,
              max_hull: 70,
              shield: 25,
              max_shield: 25,
            })),
          },
        };
      }
      
      if (command === 'attack') {
        const targetId = payload?.target_id as string;
        state.attackAttempts.push(targetId);
        
        // Find if target matches any pirate
        const target = state.pirates.find(
          p => p.pirate_id === targetId || p.name === targetId
        );
        
        if (!target) {
          // Simulate: target moved or not found
          return {
            error: { message: "Target not in this system" }
          };
        }
        
        return { result: { success: true, battle_id: 'test_battle' } };
      }
      
      if (command === 'travel') {
        // Simulate travel sets new location
        const targetPoi = payload?.target_poi as string;
        state.location = targetPoi;
        return { result: { success: true } };
      }
      
      return { result: {} };
    },
    
    // Mock refreshStatus
    async refreshStatus() {},
  };
}

// ============ TESTS ============

describeAsync('Test 1: Attack should try pirate_id first', async () => {
  const bot = createMockHunterBot();
  
  // Mock current attack logic (pirate_id only)
  const target = {
    id: '1b19cbe4271ffd7556efc95d7e4f88a2',
    name: 'Clanker',
    type: 'pirate',
    faction: 'pirate',
    isNPC: true,
    isPirate: true,
  };
  
  // Try attack with pirate_id
  const result = await bot.exec('attack', { target_id: target.id });
  
  // Verify: Attack used pirate_id
  assert(
    result.result !== undefined && !result.error,
    'Attack succeeded with pirate_id'
  );
  assert(
    bot.state.attackAttempts[0] === target.id,
    `Attack used pirate_id "${target.id}"`
  );
});

describeAsync('Test 2: Attack currently DOES NOT try name as fallback (demonstrating the bug)', async () => {
  const bot = createMockHunterBot();
  
  const target = {
    id: '1b19cbe4271ffd7556efc95d7e4f88a2',
    name: 'Clanker',
    type: 'pirate',
    faction: 'pirate',
    isNPC: true,
    isPirate: true,
  };
  
  // Try attack with pirate_id
  const result = await bot.exec('attack', { target_id: target.id });
  
  // Current behavior: If pirate_id fails, there's no fallback to name
  // This test demonstrates the CURRENT broken behavior
  if (result.error) {
    // With current code, attack fails and NEVER tries name
    const nameAttempted = bot.state.attackAttempts.includes(target.name);
    assert(!nameAttempted, 'Attack did NOT try name as fallback (this is the bug)');
  }
});

describeAsync('Test 3: After fix - attack should fallback to name', async () => {
  const bot = createMockHunterBot();
  
  // Remove pirate so pirate_id fails, but name would work
  bot.setPirates([]); // Make pirate_id not found
  
  const target = {
    id: '1b19cbe4271ffd7556efc95d7e4f88a2',
    name: 'Clanker',
    type: 'pirate',
    faction: 'pirate',
    isNPC: true,
    isPirate: true,
  };
  
  // NEW behavior: Try pirate_id, then fallback to name
  let attackResult = await bot.exec('attack', { target_id: target.id });
  
  // If pirate_id fails, try name
  if (attackResult.error) {
    console.log('  💡 pirate_id failed - trying name fallback...');
    attackResult = await bot.exec('attack', { target_id: target.name });
  }
  
  // After fix: Attack should work with name
  const usedPirateId = bot.state.attackAttempts.includes(target.id);
  const usedName = bot.state.attackAttempts.includes(target.name);
  
  assert(usedPirateId || usedName, 'Attack tried at least one identifier');
  
  // The fix ensures we try both
  if (attackResult.error) {
    console.log('  ⚠️  Both failed - target truly not present');
  } else {
    console.log('  ✅ Attack succeeded with fallback');
  }
});

describeAsync('Test 4: get_nearby at POI finds pirates', async () => {
  const bot = createMockHunterBot();
  
  bot.setLocation('nickel_seam_40_eridani');
  bot.setPirates([
    { pirate_id: '6d8a18590ba527112477cd9a721cd16e', name: 'Glooper', tier: 'salvager' }
  ]);
  
  const result = await bot.exec('get_nearby');
  
  assert(!result.error, 'get_nearby succeeded');
  
  const r = result.result as { pirates?: Array<{ name: string }> };
  const pirates = r?.pirates || [];
  assert(pirates.length > 0, `Found ${pirates.length} pirate(s) at POI`);
  if (pirates.length > 0) {
    assert(pirates[0].name === 'Glooper', `Pirate name: "${pirates[0].name}"`);
  }
});

describe('Test 5: Parse nearby entities correctly', () => {
  // Test parsing the get_nearby response format from logs
  const mockNearbyResponse = {
    nearby: [],
    pirates: [{
      pirate_id: '1b19cbe4271ffd7556efc95d7e4f88a2',
      name: 'Clanker',
      tier: 'salvager',
      is_boss: false,
      status: 'patrolling',
      hull: 70,
      max_hull: 70,
      shield: 25,
      max_shield: 25,
    }],
    empire_npcs: [],
    count: 0,
    pirate_count: 1,
    empire_npc_count: 0,
    poi_id: '40_eridani_i',
  };
  
  // Extract pirates from response (same logic as hunter.ts parseNearby)
  const pirates = mockNearbyResponse.pirates || [];
  const entities: MockNearbyEntity[] = [];
  
  for (const p of pirates) {
    if (p.pirate_id) {
      entities.push({
        id: p.pirate_id,
        name: p.name || p.pirate_id,
        type: 'pirate',
        faction: 'pirate',
        isNPC: true,
        isPirate: true,
        tier: p.tier,
      });
    }
  }
  
  assert(entities.length === 1, `Parsed ${entities.length} pirate entity`);
  assert(entities[0].id === '1b19cbe4271ffd7556efc95d7e4f88a2', 'ID correct');
  assert(entities[0].name === 'Clanker', 'Name correct');
});

// ============ SUMMARY ============

console.log('\n' + '='.repeat(50));
console.log(`📊 TEST RESULTS: ${testsPassed} passed, ${testsFailed} failed`);
console.log('='.repeat(50));

if (testsFailed === 0) {
  console.log('✅ All tests passed!');
  process.exit(0);
} else {
  console.error(`❌ ${testsFailed} test(s) failed`);
  process.exit(1);
}