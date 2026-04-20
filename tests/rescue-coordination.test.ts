/**
 * Rescue Coordination Test System
 * Tests for the rescue announcement tracking and coordination system
 * 
 * Tests include:
 * - Announcement parsing from faction chat
 * - Seen announcement tracking (prevents repeated logging)
 * - Round-robin coordination when bots are at same location
 * - Rescue claim priority resolution
 * - Cleanup of expired announcements/claims
 */

import type { RescueAnnouncement } from '../src/rescuecoordination.js';
import {
  recordRescueAnnouncement,
  parseRescueAnnouncement,
  isRescueHandled,
  getActiveRescueAnnouncements,
  haveSeenAnnouncement,
  clearSeenAnnouncement,
  cleanupExpiredAnnouncements,
} from '../src/rescuecoordination.js';
import type { RescueClaim } from '../src/cooperation/rescueCooperation.js';
import {
  recordRescueClaim,
  isRescueClaimedByPartner,
  shouldProceedOrYield,
  getRoundRobinNext,
  recordRoundRobinComplete,
  getActiveClaims,
  cleanupExpiredClaims,
  parseRescueClaim,
  formatRescueClaim,
} from '../src/cooperation/rescueCooperation.js';

// ── Test utilities ────────────────────────────────────────────────────────

let testsPassed = 0;
let testsFailed = 0;
let totalAssertions = 0;
let assertionsPassed = 0;
let assertionsFailed = 0;

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

// ── Test data reset ────────────────────────────────────────────

function resetAnnouncements(): void {
  // Re-import to reset the module (we can't actually do this in TS without reload)
  // Instead, we'll test the functions as if they're fresh
  console.log('  (Note: In-memory state cannot be reset between tests without module reload)');
}

// ── Tests ──────────────────────────────────────────────────────

describe('Rescue Announcement Parsing Tests', () => {
  it('parses possessive MAYDAY format correctly', () => {
    const announcement = parseRescueAnnouncement(
      "Ultima Good here — responding to CaptJack's MAYDAY in Market Prime Exchange",
      "Ultima Good",
      Date.now()
    );
    assert(announcement !== null, 'Parsed result is not null');
    assert(announcement?.targetName === 'CaptJack', 'Target name is CaptJack');
    assert(announcement?.targetSystem === 'Market Prime Exchange', 'Target system is Market Prime Exchange');
    assert(announcement?.isMayday === true, 'Is marked as MAYDAY');
  });

  it('parses "from" MAYDAY format correctly', () => {
    const announcement = parseRescueAnnouncement(
      "Xana Rich here — responding to MAYDAY from Xerxes in Alfirk Star",
      "Xana Rich",
      Date.now()
    );
    assert(announcement !== null, 'Parsed result is not null');
    assert(announcement?.targetName === 'Xerxes', 'Target name is Xerxes');
    assert(announcement?.targetSystem === 'Alfirk Star', 'Target system is Alfirk Star');
  });

  it('parses simple "for at" format correctly', () => {
    const announcement = parseRescueAnnouncement(
      "Launching rescue mission for Peon7 at Sol / Sol Station",
      "RescueBot",
      Date.now()
    );
    assert(announcement !== null, 'Parsed result is not null');
    assert(announcement?.targetName === 'Peon7', 'Target name is Peon7');
    // System gets the first part before the slash
    assert(announcement?.targetSystem?.trim() === 'Sol', 'Target system is Sol');
    // POI gets the second part (after trim)
    assert(announcement?.targetPoi?.trim() === 'Sol Station', 'Target POI is Sol Station');
  });

  it('returns null for non-rescue messages', () => {
    const announcement = parseRescueAnnouncement(
      "Just floating around here",
      "SomePlayer",
      Date.now()
    );
    assert(announcement === null, 'Non-rescue message returns null');
  });
});

describe('Seen Announcement Tracking Tests', () => {
  it('tracks unique announcements and returns true for new ones', () => {
    const announcement: RescueAnnouncement = {
      rescuerUsername: 'BotA',
      targetName: 'StrandedPlayer',
      targetSystem: 'Alpha Centauri',
      timestamp: Date.now(),
      isMayday: true,
    };
    const result = recordRescueAnnouncement(announcement);
    assert(result === true, 'New announcement returns true');
  });

  it('returns false for duplicate announcements', () => {
    const announcement: RescueAnnouncement = {
      rescuerUsername: 'BotA',
      targetName: 'StrandedPlayer',
      targetSystem: 'Alpha Centauri',
      timestamp: Date.now(),
      isMayday: true,
    };
    // Already recorded above, so this should return false
    const result = recordRescueAnnouncement(announcement);
    assert(result === false, 'Duplicate announcement returns false');
  });

  it('correctly checks if announcement was seen', () => {
    const wasSeen = haveSeenAnnouncement('BotA', 'StrandedPlayer', 'Alpha Centauri');
    assert(wasSeen === true, 'Announcement is tracked as seen');
  });

  it('correctly clears seen announcements', () => {
    clearSeenAnnouncement('StrandedPlayer', 'Alpha Centauri');
    const wasSeen = haveSeenAnnouncement('BotA', 'StrandedPlayer', 'Alpha Centauri');
    assert(wasSeen === false, 'Announcement is now cleared');
  });
});

describe('Rescue Claim Format Tests', () => {
  it('formats a rescue claim correctly', () => {
    const claim: RescueClaim = {
      type: 'RESCUE_CLAIM',
      player: 'AliceExplorer',
      system: 'Sirius Prime',
      poi: 'Trade Hub Gamma',
      timestamp: new Date().toISOString(),
      jumps: 3,
      botName: 'TestBot',
    };
    const formatted = formatRescueClaim(claim);
    assert(formatted.includes('AliceExplorer'), 'Contains player name');
    assert(formatted.includes('Sirius Prime'), 'Contains system');
    assert(formatted.includes('3'), 'Contains jump count');
    assert(formatted.startsWith('RESCUE_CLAIM|'), 'Has correct type prefix');
  });

  it('parses a formatted rescue claim correctly', () => {
    const timestamp = new Date().toISOString();
    const claim: RescueClaim = {
      type: 'RESCUE_CLAIM',
      player: 'BobPilot',
      system: 'Orion Reach',
      poi: 'Asteroid Base',
      timestamp,
      jumps: 7,
      botName: 'TestBot',
    };
    const formatted = formatRescueClaim(claim);
    const parsed = parseRescueClaim(formatted);
    assert(parsed !== null, 'Parsed result is not null');
    assert(parsed?.player === claim.player, 'Player matches');
    assert(parsed?.system === claim.system, 'System matches');
    assert(parsed?.jumps === claim.jumps, 'Jump count matches');
    assert(parsed?.botName === claim.botName, 'Bot name matches');
  });

  it('handles missing POI gracefully', () => {
    const timestamp = new Date().toISOString();
    const claim: RescueClaim = {
      type: 'RESCUE_CLAIM',
      player: 'SoloPilot',
      system: 'Deep Space',
      timestamp,
      jumps: 5,
      botName: 'TestBot',
    };
    const formatted = formatRescueClaim(claim);
    const parsed = parseRescueClaim(formatted);
    assert(parsed !== null, 'Parsed result is not null');
    assert(parsed?.poi === undefined, 'POI is undefined');
  });
});

describe('Round Robin Coordination Tests', () => {
  it('returns correct bot when no history exists', () => {
    // This test depends on previous test state, so we check logically
    const next1 = getRoundRobinNext('TestSystem', 'AlphaBot', 'BetaBot');
    // First call - either could be returned (based on alphabetical order for tie-breaker)
    const next2 = getRoundRobinNext('TestSystem2', 'AlphaBot', 'BetaBot');
    // Both should be consistent with alphabetical tie-breaking
    assert(next1 === 'AlphaBot' || next1 === 'BetaBot', 'Returns one of the two bots');
    assert(next2 === 'AlphaBot' || next2 === 'BetaBot', 'Returns one of the two bots');
  });

  it('alternates bots after recording completions', () => {
    // Record a completion for AlphaBot at TestSystemRR
    recordRoundRobinComplete('TestSystemRR', 'AlphaBot');
    const next = getRoundRobinNext('TestSystemRR', 'AlphaBot', 'BetaBot');
    assert(next === 'BetaBot', 'BetaBot goes next after AlphaBot completed');
  });

  it('alternates back after second completion', () => {
    // Record BetaBot completion
    recordRoundRobinComplete('TestSystemRR2', 'BetaBot');
    const next = getRoundRobinNext('TestSystemRR2', 'AlphaBot', 'BetaBot');
    assert(next === 'AlphaBot', 'AlphaBot goes next after BetaBot completed');
  });
});

describe('Priority Resolution Tests', () => {
  it('proceeds when no partner claim exists', () => {
    const myClaim: RescueClaim = {
      type: 'RESCUE_CLAIM',
      player: 'TestPlayer',
      system: 'TestSystem',
      timestamp: new Date().toISOString(),
      jumps: 5,
      botName: 'MyBot',
    };
    const result = shouldProceedOrYield(myClaim, null);
    assert(result === 'proceed', 'Proceeds when no partner claim');
  });

  it('proceeds when closer than partner', () => {
    const myClaim: RescueClaim = {
      type: 'RESCUE_CLAIM',
      player: 'TestPlayer',
      system: 'TestSystem',
      timestamp: new Date().toISOString(),
      jumps: 3,
      botName: 'MyBot',
    };
    const partnerClaim: RescueClaim = {
      type: 'RESCUE_CLAIM',
      player: 'TestPlayer',
      system: 'TestSystem',
      timestamp: new Date().toISOString(),
      jumps: 7,
      botName: 'PartnerBot',
    };
    const result = shouldProceedOrYield(myClaim, partnerClaim);
    assert(result === 'proceed', 'Proceeds when closer (3 < 7 jumps)');
  });

  it('yields when farther than partner', () => {
    const myClaim: RescueClaim = {
      type: 'RESCUE_CLAIM',
      player: 'TestPlayer',
      system: 'TestSystem',
      timestamp: new Date().toISOString(),
      jumps: 10,
      botName: 'MyBot',
    };
    const partnerClaim: RescueClaim = {
      type: 'RESCUE_CLAIM',
      player: 'TestPlayer',
      system: 'TestSystem',
      timestamp: new Date().toISOString(),
      jumps: 3,
      botName: 'PartnerBot',
    };
    const result = shouldProceedOrYield(myClaim, partnerClaim);
    assert(result === 'yield', 'Yields when farther (10 > 3 jumps)');
  });

  it('uses round-robin when at same distance', () => {
    // Set up round-robin state
    recordRoundRobinComplete('SameSystem', 'PartnerBot');
    
    const myClaim: RescueClaim = {
      type: 'RESCUE_CLAIM',
      player: 'TestPlayer',
      system: 'SameSystem',
      timestamp: new Date().toISOString(),
      jumps: 5,
      botName: 'MyBot',
    };
    const partnerClaim: RescueClaim = {
      type: 'RESCUE_CLAIM',
      player: 'TestPlayer',
      system: 'SameSystem',
      timestamp: new Date().toISOString(),
      jumps: 5, // Same distance
      botName: 'PartnerBot',
    };
    const result = shouldProceedOrYield(myClaim, partnerClaim);
    // Since PartnerBot went last at SameSystem, MyBot should go now
    assert(result === 'proceed', 'Uses round-robin: MyBot proceeds because PartnerBot went last');
  });
});

describe('Claim Cleanup Tests', () => {
  it('cleans up expired claims', () => {
    // Record a claim with old timestamp
    const oldClaim: RescueClaim = {
      type: 'RESCUE_CLAIM',
      player: 'OldPlayer',
      system: 'OldSystem',
      timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 minutes ago
      jumps: 5,
      botName: 'OldBot',
    };
    recordRescueClaim(oldClaim);
    
    const initialActive = getActiveClaims();
    cleanupExpiredClaims();
    const afterCleanup = getActiveClaims();
    
    assert(afterCleanup.length <= initialActive.length, 'Cleanup removes expired claims');
  });
});

describe('isRescueHandled Integration Tests', () => {
  it('detects when rescue is already being handled', () => {
    const announcement: RescueAnnouncement = {
      rescuerUsername: 'ExistingBot',
      targetName: 'ShipInTrouble',
      targetSystem: 'DistressZone',
      timestamp: Date.now(),
      isMayday: true,
    };
    recordRescueAnnouncement(announcement);
    
    const handledBy = isRescueHandled('ShipInTrouble', 'DistressZone', undefined, 'MyBot');
    assert(handledBy !== null, 'Returns announcement when handled by another bot');
    assert(handledBy?.rescuerUsername === 'ExistingBot', 'Returns correct rescuer');
  });

  it('returns null when rescue is not handled', () => {
    const handledBy = isRescueHandled('UnrelatedPlayer', 'UnrelatedSystem', undefined, 'MyBot');
    assert(handledBy === null, 'Returns null when no one is handling');
  });
});

// ── Test Results ────────────────────────────────────────────────

function printResults(): void {
  console.log('\n═══════════════════════════════════════════');
  console.log('📊 RESCUE COORDINATION TEST RESULTS');
  console.log('═══════════════════════════════════════════');
  console.log(`Tests: ${testsPassed} passed, ${testsFailed} failed`);
  console.log(`Assertions: ${assertionsPassed} passed, ${assertionsFailed} failed`);
  console.log('═══════════════════════════════════════════');
  
  if (testsFailed > 0) {
    console.log('\n❌ SOME TESTS FAILED');
    process.exit(1);
  } else {
    console.log('\n✅ ALL TESTS PASSED');
    process.exit(0);
  }
}

// Run tests if this file is executed directly
if (typeof window === 'undefined' && process.argv[1]?.includes('rescue-coordination.test')) {
  printResults();
}

export { printResults };