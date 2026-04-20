/**
 * Rescue Bot Assignment Test System
 * Tests for the new multi-bot rescue assignment feature
 * 
 * This is a standalone test that validates the logic without importing from rescue.ts
 * since the helper functions are not exported from that module.
 */

console.log('🧪 Rescue Bot Assignment Test System');
console.log('='.repeat(60));

// Test results
let testsPassed = 0;
let testsFailed = 0;
let totalAssertions = 0;
let assertionsPassed = 0;
let assertionsFailed = 0;

// Mock settings storage
interface RescueSettings {
  creditTopOffBot: string;
  fleetRescueBot: string;
  maydayRescueBot: string;
  creditTopOffAmount: number;
  creditTopOffMinThreshold: number;
  fuelThreshold: number;
  maydayMaxJumps: number;
  homeSystem?: string;
  homeStation?: string;
  costPerJump?: number;
  costPerFuel?: number;
  rescueFuelCells?: number;
  rescueCredits?: number;
  scanIntervalSec?: number;
  refuelThreshold?: number;
  maydayFuelThreshold?: number;
  maydayPirateProximityThreshold?: number;
  maydayPirateLockoutMinutes?: number;
}

interface AllSettings {
  rescue?: Partial<RescueSettings>;
  fuel_transfer?: { homeSystem?: string };
  general?: { homeSystem?: string };
}

let mockSettings: AllSettings = {};

// Mock readSettings function (mimics the actual function in rescue.ts)
function readSettings(): AllSettings {
  return mockSettings;
}

// Replicate getRescueSettings from rescue.ts
function getRescueSettings(): RescueSettings {
  const all = readSettings();
  const r = all.rescue || {};
  const ft = all.fuel_transfer || {};
  const general = all.general || {};
  return {
    creditTopOffBot: (r.creditTopOffBot as string) || '',
    fleetRescueBot: (r.fleetRescueBot as string) || '',
    maydayRescueBot: (r.maydayRescueBot as string) || '',
    creditTopOffAmount: (r.creditTopOffAmount as number) || 10000,
    creditTopOffMinThreshold: (r.creditTopOffMinThreshold as number) || 10000,
    fuelThreshold: (r.fuelThreshold as number) || 10,
    maydayMaxJumps: (r.maydayMaxJumps as number) || 12,
    homeSystem: (r.homeSystem as string) || (ft.homeSystem as string) || (general.homeSystem as string),
    homeStation: (r.homeStation as string) || '',
    costPerJump: (r.costPerJump as number) || 50,
    costPerFuel: (r.costPerFuel as number) || 2,
    rescueFuelCells: (r.rescueFuelCells as number) || 10,
    rescueCredits: (r.rescueCredits as number) || 500,
    scanIntervalSec: (r.scanIntervalSec as number) || 30,
    refuelThreshold: (r.refuelThreshold as number) || 60,
    maydayFuelThreshold: (r.maydayFuelThreshold as number) || 15,
    maydayPirateProximityThreshold: (r.maydayPirateProximityThreshold as number) || 5,
    maydayPirateLockoutMinutes: (r.maydayPirateLockoutMinutes as number) || 30,
  };
}

// Replicate helper functions from rescue.ts
function isPrimaryCreditTopOffBot(botUsername: string): boolean {
  const settings = getRescueSettings();
  if (!settings.creditTopOffBot) {
    return true;
  }
  return botUsername === settings.creditTopOffBot;
}

function isPrimaryFleetRescueBot(botUsername: string): boolean {
  const settings = getRescueSettings();
  if (!settings.fleetRescueBot) {
    return true;
  }
  return botUsername === settings.fleetRescueBot;
}

function isPrimaryMaydayRescueBot(botUsername: string): boolean {
  const settings = getRescueSettings();
  if (!settings.maydayRescueBot) {
    return true;
  }
  return botUsername === settings.maydayRescueBot;
}

interface BotStatus {
  username: string;
  state: string;
}

function getBackupBotForRescue(botUsername: string, rescueType: 'fleet' | 'mayday' | 'creditTopOff'): string {
  const settings = getRescueSettings();
  const fleet: BotStatus[] = (globalThis as any).getFleetStatus?.() || [];
  
  let primaryBot: string;
  if (rescueType === 'fleet') {
    primaryBot = settings.fleetRescueBot;
  } else if (rescueType === 'mayday') {
    primaryBot = settings.maydayRescueBot;
  } else {
    primaryBot = settings.creditTopOffBot;
  }
  
  if (botUsername === primaryBot || !primaryBot) {
    for (const b of fleet) {
      if (b.username !== botUsername && b.state === 'running') {
        return b.username;
      }
    }
  }
  
  return '';
}

// Test utilities
function assert(condition: boolean, message: string): void {
  totalAssertions++;
  if (condition) {
    assertionsPassed++;
    testsPassed++;
    console.log(`  ✅ ${message}`);
  } else {
    assertionsFailed++;
    testsFailed++;
    console.error(`  ❌ ${message}`);
  }
}

function describe(name: string, fn: () => void): void {
  console.log(`\n📋 ${name}`);
  fn();
}

function it(name: string, fn: () => void): void {
  try {
    fn();
  } catch (e: any) {
    testsFailed++;
    assertionsFailed++;
    console.error(`  ❌ ${name}: ${e && e.message ? e.message : String(e)}`);
  }
}

function beforeEach(fn: () => void): void {
  fn();
}

// ── Tests ────────────────────────────────────────────────────────

describe('Rescue Settings Retrieval Tests', () => {
  it('returns default values when no settings exist', () => {
    mockSettings = { rescue: {} };
    const settings = getRescueSettings();
    assert(settings.creditTopOffBot === '', 'Credit top-off bot defaults to empty string');
    assert(settings.fleetRescueBot === '', 'Fleet rescue bot defaults to empty string');
    assert(settings.maydayRescueBot === '', 'MAYDAY rescue bot defaults to empty string');
  });

  it('returns configured bot assignments', () => {
    mockSettings = {
      rescue: {
        creditTopOffBot: 'RescueAlpha',
        fleetRescueBot: 'RescueBeta',
        maydayRescueBot: 'RescueGamma',
      }
    };
    const settings = getRescueSettings();
    assert(settings.creditTopOffBot === 'RescueAlpha', 'Credit top-off bot is configured');
    assert(settings.fleetRescueBot === 'RescueBeta', 'Fleet rescue bot is configured');
    assert(settings.maydayRescueBot === 'RescueGamma', 'MAYDAY rescue bot is configured');
  });

  it('returns other rescue settings correctly', () => {
    mockSettings = {
      rescue: {
        creditTopOffAmount: 20000,
        creditTopOffMinThreshold: 15000,
        fuelThreshold: 15,
        maydayMaxJumps: 8,
        homeSystem: 'alpha_centauri',
      }
    };
    const settings = getRescueSettings();
    assert(settings.creditTopOffAmount === 20000, 'Credit top-off amount is correct');
    assert(settings.creditTopOffMinThreshold === 15000, 'Credit top-off min threshold is correct');
    assert(settings.fuelThreshold === 15, 'Fuel threshold is correct');
    assert(settings.maydayMaxJumps === 8, 'MAYDAY max jumps is correct');
    assert(settings.homeSystem === 'alpha_centauri', 'Home system is correct');
  });
});

describe('Credit Top-Off Bot Assignment Tests', () => {
  beforeEach(() => {
    mockSettings = {
      rescue: {
        creditTopOffBot: 'BotAlpha',
      }
    };
  });

  it('returns true when bot is the primary credit top-off bot', () => {
    const result = isPrimaryCreditTopOffBot('BotAlpha');
    assert(result === true, 'BotAlpha is primary credit top-off bot');
  });

  it('returns false when bot is not the primary credit top-off bot', () => {
    const result = isPrimaryCreditTopOffBot('BotBeta');
    assert(result === false, 'BotBeta is not primary credit top-off bot');
  });

  it('returns true when no credit top-off bot is assigned (legacy behavior)', () => {
    mockSettings = { rescue: {} };
    const result = isPrimaryCreditTopOffBot('AnyBot');
    assert(result === true, 'All bots can do credit top-off when not configured');
  });
});

describe('Fleet Rescue Bot Assignment Tests', () => {
  beforeEach(() => {
    mockSettings = {
      rescue: {
        fleetRescueBot: 'FleetBot',
      }
    };
  });

  it('returns true when bot is the primary fleet rescue bot', () => {
    const result = isPrimaryFleetRescueBot('FleetBot');
    assert(result === true, 'FleetBot is primary fleet rescue bot');
  });

  it('returns false when bot is not the primary fleet rescue bot', () => {
    const result = isPrimaryFleetRescueBot('OtherBot');
    assert(result === false, 'OtherBot is not primary fleet rescue bot');
  });

  it('returns true when no fleet rescue bot is assigned (legacy behavior)', () => {
    mockSettings = { rescue: {} };
    const result = isPrimaryFleetRescueBot('AnyBot');
    assert(result === true, 'All bots can do fleet rescue when not configured');
  });
});

describe('MAYDAY Rescue Bot Assignment Tests', () => {
  beforeEach(() => {
    mockSettings = {
      rescue: {
        maydayRescueBot: 'MaydayBot',
      }
    };
  });

  it('returns true when bot is the primary MAYDAY rescue bot', () => {
    const result = isPrimaryMaydayRescueBot('MaydayBot');
    assert(result === true, 'MaydayBot is primary MAYDAY rescue bot');
  });

  it('returns false when bot is not the primary MAYDAY rescue bot', () => {
    const result = isPrimaryMaydayRescueBot('OtherBot');
    assert(result === false, 'OtherBot is not primary MAYDAY rescue bot');
  });

  it('returns true when no MAYDAY rescue bot is assigned (legacy behavior)', () => {
    mockSettings = { rescue: {} };
    const result = isPrimaryMaydayRescueBot('AnyBot');
    assert(result === true, 'All bots can do MAYDAY rescue when not configured');
  });
});

describe('Backup Bot Retrieval Tests', () => {
  beforeEach(() => {
    (globalThis as any).getFleetStatus = () => [
      { username: 'RescueBot1', state: 'running' },
      { username: 'RescueBot2', state: 'running' },
      { username: 'IdleBot', state: 'idle' },
    ];
  });

  it('returns backup bot when current bot is primary', () => {
    mockSettings = {
      rescue: {
        creditTopOffBot: 'RescueBot1',
      }
    };
    const backup = getBackupBotForRescue('RescueBot1', 'creditTopOff');
    assert(backup === 'RescueBot2', 'Returns RescueBot2 as backup');
  });

  it('returns empty string when current bot is not primary', () => {
    mockSettings = {
      rescue: {
        creditTopOffBot: 'RescueBot1',
      }
    };
    const backup = getBackupBotForRescue('RescueBot2', 'creditTopOff');
    assert(backup === '', 'Returns empty when not primary and primary exists');
  });

  it('returns first running bot when no assignment exists', () => {
    mockSettings = { rescue: {} };
    const backup = getBackupBotForRescue('RescueBot1', 'fleet');
    assert(backup === 'RescueBot2', 'Returns first running bot as backup');
  });

  it('returns empty string when no other bots in fleet', () => {
    (globalThis as any).getFleetStatus = () => [
      { username: 'SoloBot', state: 'running' },
    ];
    mockSettings = { rescue: {} };
    const backup = getBackupBotForRescue('SoloBot', 'mayday');
    assert(backup === '', 'Returns empty when no other bots');
  });

  it('skips non-running bots when finding backup', () => {
    (globalThis as any).getFleetStatus = () => [
      { username: 'RunningBot', state: 'running' },
      { username: 'StoppedBot', state: 'stopped' },
    ];
    mockSettings = { rescue: {} };
    const backup = getBackupBotForRescue('StoppedBot', 'fleet');
    assert(backup === 'RunningBot', 'Skips stopped bot, returns running bot');
  });
});

describe('Integration Tests - Multi-Bot Scenario', () => {
  it('correctly assigns different bots to different rescue types', () => {
    mockSettings = {
      rescue: {
        creditTopOffBot: 'CreditBot',
        fleetRescueBot: 'FleetBot',
        maydayRescueBot: 'MaydayBot',
      }
    };

    // Credit bot
    assert(isPrimaryCreditTopOffBot('CreditBot') === true, 'CreditBot handles credit top-off');
    assert(isPrimaryCreditTopOffBot('FleetBot') === false, 'FleetBot does not handle credit top-off');
    assert(isPrimaryCreditTopOffBot('MaydayBot') === false, 'MaydayBot does not handle credit top-off');

    // Fleet rescue
    assert(isPrimaryFleetRescueBot('CreditBot') === false, 'CreditBot does not handle fleet rescue');
    assert(isPrimaryFleetRescueBot('FleetBot') === true, 'FleetBot handles fleet rescue');
    assert(isPrimaryFleetRescueBot('MaydayBot') === false, 'MaydayBot does not handle fleet rescue');

    // MAYDAY rescue
    assert(isPrimaryMaydayRescueBot('CreditBot') === false, 'CreditBot does not handle MAYDAY');
    assert(isPrimaryMaydayRescueBot('FleetBot') === false, 'FleetBot does not handle MAYDAY');
    assert(isPrimaryMaydayRescueBot('MaydayBot') === true, 'MaydayBot handles MAYDAY');
  });

  it('backup bot correctly identifies the other bot in 2-bot setup', () => {
    (globalThis as any).getFleetStatus = () => [
      { username: 'RescueAlpha', state: 'running' },
      { username: 'RescueBeta', state: 'running' },
    ];

    // When RescueAlpha is primary for fleet, RescueBeta is backup
    mockSettings = { rescue: { fleetRescueBot: 'RescueAlpha' } };
    const backup = getBackupBotForRescue('RescueAlpha', 'fleet');
    assert(backup === 'RescueBeta', 'RescueBeta is backup when RescueAlpha is primary');

    // When roles swap
    mockSettings = { rescue: { fleetRescueBot: 'RescueBeta' } };
    const backup2 = getBackupBotForRescue('RescueBeta', 'fleet');
    assert(backup2 === 'RescueAlpha', 'RescueAlpha is backup when RescueBeta is primary');
  });

  it('single bot handles all rescue types when no assignments configured', () => {
    mockSettings = { rescue: {} };
    (globalThis as any).getFleetStatus = () => [{ username: 'SoloBot', state: 'running' }];

    assert(isPrimaryCreditTopOffBot('SoloBot') === true, 'SoloBot handles credit top-off');
    assert(isPrimaryFleetRescueBot('SoloBot') === true, 'SoloBot handles fleet rescue');
    assert(isPrimaryMaydayRescueBot('SoloBot') === true, 'SoloBot handles MAYDAY');
  });
});

describe('Settings Persistence Tests', () => {
  it('saves and retrieves bot assignments correctly', () => {
    // Simulate saving settings
    const savedSettings = {
      rescue: {
        creditTopOffBot: 'SavedCreditBot',
        fleetRescueBot: 'SavedFleetBot',
        maydayRescueBot: 'SavedMaydayBot',
        creditTopOffAmount: 15000,
      }
    };
    
    // Simulate loading settings
    mockSettings = savedSettings;
    const loaded = getRescueSettings();
    
    assert(loaded.creditTopOffBot === 'SavedCreditBot', 'Credit top-off bot persists');
    assert(loaded.fleetRescueBot === 'SavedFleetBot', 'Fleet rescue bot persists');
    assert(loaded.maydayRescueBot === 'SavedMaydayBot', 'MAYDAY rescue bot persists');
    assert(loaded.creditTopOffAmount === 15000, 'Other settings persist');
  });

  it('handles partial settings updates correctly', () => {
    mockSettings = {
      rescue: {
        creditTopOffBot: 'PartialBot',
      }
    };
    const settings = getRescueSettings();
    
    assert(settings.creditTopOffBot === 'PartialBot', 'Updated field is set');
    assert(settings.fleetRescueBot === '', 'Non-updated field defaults to empty');
    assert(settings.maydayRescueBot === '', 'Non-updated field defaults to empty');
    assert(settings.creditTopOffAmount === 10000, 'Non-set fields use defaults');
  });
});

// ── Test Summary ─────────────────────────────────────────────────

console.log('\n' + '='.repeat(60));
console.log('📊 TEST SUMMARY');
console.log('='.repeat(60));
console.log(`Total Tests: ${testsPassed + testsFailed}`);
console.log(`  ✅ Passed: ${testsPassed}`);
console.log(`  ❌ Failed: ${testsFailed}`);
console.log(`\nTotal Assertions: ${totalAssertions}`);
console.log(`  ✅ Passed: ${assertionsPassed}`);
console.log(`  ❌ Failed: ${assertionsFailed}`);
console.log('='.repeat(60));

if (assertionsFailed > 0) {
  console.log('\n⚠️  SOME TESTS FAILED - Review the errors above');
  process.exit(1);
} else {
  console.log('\n🎉 ALL TESTS PASSED!');
  process.exit(0);
}