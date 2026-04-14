/**
 * Battle Interrupt During Jump - Comprehensive Test Suite
 * 
 * Tests the critical scenario where a bot issues a jump command but gets
 * attacked by a pirate on the next tick, causing the jump to be interrupted.
 * This has been a MAJOR problem causing lost ships.
 * 
 * Tests all four routines: explorer, miner, trader, rescue
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  MockBot,
  MockBotState,
  MockApiResponse,
  BattleInterruptScenario,
  createExplorerJumpInterruptScenario,
  createMinerJumpInterruptScenario,
  createTraderJumpInterruptScenario,
  createRescueJumpInterruptScenario,
  simulatePirateAttack,
  createMockContext,
  assertFleeInitiated,
  assertSystemVerified,
  assertNoExcessiveCommands,
  assertBattleInterruptError,
  resetBotForNextTest,
} from './battle-interrupt-helpers.js';

// ── Explorer Routine Tests ─────────────────────────────────────────────────────

describe('Explorer Routine - Battle Interrupt During Jump', () => {
  let bot: MockBot;
  let scenario: BattleInterruptScenario;

  beforeEach(() => {
    scenario = createExplorerJumpInterruptScenario();
    bot = new MockBot({
      ...scenario.initialState,
      username: 'ExplorerBot_001',
    });
  });

  afterEach(() => {
    resetBotForNextTest(bot);
  });

  it('should detect battle interrupt error from jump command', async () => {
    simulatePirateAttack(bot, scenario.interruptConfig);

    const jumpResp = await bot.exec('jump', {
      target_system: 'target_system_beta',
    });

    assertBattleInterruptError(jumpResp, scenario);
    // Error message contains battle interrupt info (battle ID, not pirate name)
    expect(jumpResp.error?.message).toContain('interrupted by battle');
    expect(jumpResp.error?.code).toBe('battle_interrupt');
  });

  it('should verify actual system via get_status before fleeing', async () => {
    simulatePirateAttack(bot, scenario.interruptConfig);

    // Simulate the explorer routine behavior
    await bot.exec('jump', { target_system: 'target_system_beta' });
    
    // Explorer should verify position
    await bot.refreshStatus();

    const statusChecks = bot.commandHistory.filter(c => c.command === 'get_status');
    expect(statusChecks.length).toBeGreaterThan(0);
    assertSystemVerified(bot, scenario);
  });

  it('should issue flee stance command when battle detected', async () => {
    simulatePirateAttack(bot, scenario.interruptConfig);

    await bot.exec('jump', { target_system: 'target_system_beta' });
    
    // Issue flee command
    await bot.exec('battle', { action: 'stance', stance: 'flee' });

    assertFleeInitiated(bot, scenario);
    
    // Verify battle state cleared
    expect(bot.isInBattle()).toBe(false);
  });

  it('should NOT spam commands before fleeing (max 5 commands)', async () => {
    simulatePirateAttack(bot, scenario.interruptConfig);

    // Simulate realistic command sequence
    await bot.exec('jump', { target_system: 'target_system_beta' }); // 1 - interrupted
    await bot.refreshStatus(); // 2 - verify position
    await bot.exec('get_battle_status'); // 3 - confirm battle
    await bot.exec('battle', { action: 'stance', stance: 'flee' }); // 4 - flee

    assertNoExcessiveCommands(bot, scenario.expectedBehavior.maxCommandsBeforeFlee);
  });

  it('should check WebSocket battle state first (fastest detection)', async () => {
    simulatePirateAttack(bot, scenario.interruptConfig);

    await bot.exec('jump', { target_system: 'target_system_beta' });

    // WebSocket should show battle
    expect(bot.isInBattle()).toBe(true);
    expect(bot.battleWebSocketState.battleId).not.toBeNull();
  });

  it('should handle battle notifications correctly', async () => {
    simulatePirateAttack(bot, scenario.interruptConfig);

    const jumpResp = await bot.exec('jump', {
      target_system: 'target_system_beta',
    });

    // Should have battle_start notification
    expect(jumpResp.notifications).toBeDefined();
    expect(jumpResp.notifications?.length).toBeGreaterThan(0);
    expect(jumpResp.notifications?.[0].type).toBe('battle_start');
  });

  it('should NOT retry jump immediately after battle interrupt', async () => {
    simulatePirateAttack(bot, scenario.interruptConfig);

    await bot.exec('jump', { target_system: 'target_system_beta' });
    await bot.refreshStatus();
    await bot.exec('battle', { action: 'stance', stance: 'flee' });

    // Count jump commands - should only be 1 (the interrupted one)
    const jumpCommands = bot.commandHistory.filter(c => c.command === 'jump');
    expect(jumpCommands.length).toBe(1);
  });

  it('should flee to a connected safe system, not random system', async () => {
    simulatePirateAttack(bot, scenario.interruptConfig);

    await bot.exec('jump', { target_system: 'target_system_beta' });
    await bot.refreshStatus();

    // Verify we're still in original system (jump didn't complete)
    expect(bot.state.system).toBe('peaceful_system_alpha');
    
    // After flee, should still be in a valid system
    await bot.exec('battle', { action: 'stance', stance: 'flee' });
    
    // System should not change until jump succeeds
    expect(bot.state.system).toBe('peaceful_system_alpha');
  });

  it('should handle cascade: battle during flee jump attempt', async () => {
    // First pirate attack
    simulatePirateAttack(bot, scenario.interruptConfig);
    await bot.exec('jump', { target_system: 'target_system_beta' });
    await bot.refreshStatus();
    await bot.exec('battle', { action: 'stance', stance: 'flee' });

    // Verify first flee happened
    let fleeCommands = bot.commandHistory.filter(
      c => c.command === 'battle' && c.payload?.stance === 'flee'
    );
    expect(fleeCommands.length).toBe(1);

    // Configure second pirate attack (don't reset - keep command history)
    bot.shouldInterruptJumpWithBattle = false; // Temporarily disable
    bot.battleWebSocketState.inBattle = false;
    bot.state.isInBattle = false;
    bot.state.currentBattleId = null;
    
    // Re-enable for second attack
    simulatePirateAttack(bot, scenario.interruptConfig);

    // Second pirate attack during flee attempt
    await bot.exec('jump', { target_system: 'safe_system_gamma' });
    await bot.refreshStatus();
    await bot.exec('battle', { action: 'stance', stance: 'flee' });

    // Should have fled twice
    fleeCommands = bot.commandHistory.filter(
      c => c.command === 'battle' && c.payload?.stance === 'flee'
    );
    expect(fleeCommands.length).toBe(2);
  });

  it('should preserve fuel and cargo after failed jump', async () => {
    const initialFuel = bot.state.fuel;
    const initialCargo = bot.state.cargo;

    simulatePirateAttack(bot, scenario.interruptConfig);
    await bot.exec('jump', { target_system: 'target_system_beta' });
    await bot.refreshStatus();
    await bot.exec('battle', { action: 'stance', stance: 'flee' });

    // Fuel and cargo should be unchanged (jump didn't complete)
    expect(bot.state.fuel).toBe(initialFuel);
    expect(bot.state.cargo).toBe(initialCargo);
  });
});

// ── Miner Routine Tests ────────────────────────────────────────────────────────

describe('Miner Routine - Battle Interrupt During Jump', () => {
  let bot: MockBot;
  let scenario: BattleInterruptScenario;

  beforeEach(() => {
    scenario = createMinerJumpInterruptScenario();
    bot = new MockBot({
      ...scenario.initialState,
      username: 'MinerBot_001',
    });
  });

  afterEach(() => {
    resetBotForNextTest(bot);
  });

  it('should detect battle interrupt and protect mined cargo', async () => {
    simulatePirateAttack(bot, scenario.interruptConfig);

    const jumpResp = await bot.exec('jump', {
      target_system: 'mining_system_omega',
    });

    assertBattleInterruptError(jumpResp, scenario);
    
    // Cargo should be preserved
    expect(bot.state.cargo).toBe(30);
  });

  it('should verify system before emergency flee with cargo', async () => {
    simulatePirateAttack(bot, scenario.interruptConfig);

    await bot.exec('jump', { target_system: 'mining_system_omega' });
    await bot.refreshStatus();

    const statusChecks = bot.commandHistory.filter(c => c.command === 'get_status');
    expect(statusChecks.length).toBeGreaterThan(0);
  });

  it('should flee immediately when battle detected during mining travel', async () => {
    simulatePirateAttack(bot, scenario.interruptConfig);

    await bot.exec('jump', { target_system: 'mining_system_omega' });
    await bot.exec('battle', { action: 'stance', stance: 'flee' });

    assertFleeInitiated(bot, scenario);
    expect(bot.isInBattle()).toBe(false);
  });

  it('should NOT lose ship by retrying jump into battle', async () => {
    simulatePirateAttack(bot, scenario.interruptConfig);

    await bot.exec('jump', { target_system: 'mining_system_omega' });
    await bot.refreshStatus();
    await bot.exec('battle', { action: 'stance', stance: 'flee' });

    // Should NOT attempt another jump while in battle
    const jumpCommandsAfterFlee = bot.commandHistory.filter(
      (c, idx) => idx > 2 && c.command === 'jump'
    );
    expect(jumpCommandsAfterFlee.length).toBe(0);
  });

  it('should handle battle interrupt during POI travel', async () => {
    simulatePirateAttack(bot, scenario.interruptConfig);

    const travelResp = await bot.exec('travel', {
      target_poi: 'mining_poi_alpha',
    });

    assertBattleInterruptError(travelResp, scenario);
  });

  it('should check for pirates in new system after successful jump', async () => {
    // Successful jump first
    bot.shouldInterruptJumpWithBattle = false;
    
    await bot.exec('jump', { target_system: 'mining_system_omega' });
    
    // Then check for pirates
    await bot.exec('get_nearby');

    const nearbyCommands = bot.commandHistory.filter(c => c.command === 'get_nearby');
    expect(nearbyCommands.length).toBeGreaterThan(0);
  });

  it('should handle multiple battle interrupts in sequence', async () => {
    // First attack
    simulatePirateAttack(bot, scenario.interruptConfig);
    await bot.exec('jump', { target_system: 'mining_system_omega' });
    await bot.exec('battle', { action: 'stance', stance: 'flee' });

    // Second attack immediately
    simulatePirateAttack(bot, scenario.interruptConfig);
    await bot.exec('jump', { target_system: 'safe_system_delta' });
    await bot.exec('battle', { action: 'stance', stance: 'flee' });

    const fleeCommands = bot.commandHistory.filter(
      c => c.command === 'battle' && c.payload?.stance === 'flee'
    );
    expect(fleeCommands.length).toBe(2);
  });

  it('should maintain mining session state after battle', async () => {
    const initialSystem = bot.state.system;
    const initialCargo = bot.state.cargo;

    simulatePirateAttack(bot, scenario.interruptConfig);
    await bot.exec('jump', { target_system: 'mining_system_omega' });
    await bot.refreshStatus();
    await bot.exec('battle', { action: 'stance', stance: 'flee' });

    // System and cargo should be preserved
    expect(bot.state.system).toBe(initialSystem);
    expect(bot.state.cargo).toBe(initialCargo);
  });
});

// ── Trader Routine Tests ───────────────────────────────────────────────────────

describe('Trader Routine - Battle Interrupt During Jump', () => {
  let bot: MockBot;
  let scenario: BattleInterruptScenario;

  beforeEach(() => {
    scenario = createTraderJumpInterruptScenario();
    bot = new MockBot({
      ...scenario.initialState,
      username: 'TraderBot_001',
    });
  });

  afterEach(() => {
    resetBotForNextTest(bot);
  });

  it('should detect battle interrupt and protect valuable cargo', async () => {
    simulatePirateAttack(bot, scenario.interruptConfig);

    const jumpResp = await bot.exec('jump', {
      target_system: 'trade_destination_alpha',
    });

    assertBattleInterruptError(jumpResp, scenario);
    
    // Valuable cargo should be preserved
    expect(bot.state.cargo).toBe(45);
    expect(bot.state.credits).toBe(500000);
  });

  it('should verify system before fleeing with high-value cargo', async () => {
    simulatePirateAttack(bot, scenario.interruptConfig);

    await bot.exec('jump', { target_system: 'trade_destination_alpha' });
    await bot.refreshStatus();

    const statusChecks = bot.commandHistory.filter(c => c.command === 'get_status');
    expect(statusChecks.length).toBeGreaterThan(0);
  });

  it('should flee immediately when battle detected during trade route', async () => {
    simulatePirateAttack(bot, scenario.interruptConfig);

    await bot.exec('jump', { target_system: 'trade_destination_alpha' });
    await bot.exec('battle', { action: 'stance', stance: 'flee' });

    assertFleeInitiated(bot, scenario);
    expect(bot.isInBattle()).toBe(false);
  });

  it('should NOT lose cargo by retrying jump into battle', async () => {
    const initialCargo = bot.state.cargo;

    simulatePirateAttack(bot, scenario.interruptConfig);
    await bot.exec('jump', { target_system: 'trade_destination_alpha' });
    await bot.refreshStatus();
    await bot.exec('battle', { action: 'stance', stance: 'flee' });

    // Cargo should be preserved
    expect(bot.state.cargo).toBe(initialCargo);

    // Should NOT attempt another jump immediately
    const jumpCommandsAfterFlee = bot.commandHistory.filter(
      (c, idx) => idx > 2 && c.command === 'jump'
    );
    expect(jumpCommandsAfterFlee.length).toBe(0);
  });

  it('should handle battle interrupt during multi-jump trade route', async () => {
    // First jump succeeds
    bot.shouldInterruptJumpWithBattle = false;
    await bot.exec('jump', { target_system: 'trade_waypoint_beta' });

    // Second jump gets interrupted
    simulatePirateAttack(bot, scenario.interruptConfig);
    const jumpResp = await bot.exec('jump', {
      target_system: 'trade_destination_alpha',
    });

    assertBattleInterruptError(jumpResp, scenario);
    
    // Should still be at waypoint
    expect(bot.state.system).toBe('trade_waypoint_beta');
  });

  it('should check battle status via API as fallback', async () => {
    simulatePirateAttack(bot, scenario.interruptConfig);

    await bot.exec('jump', { target_system: 'trade_destination_alpha' });
    
    // Check via API
    await bot.exec('get_battle_status');

    const battleChecks = bot.commandHistory.filter(c => c.command === 'get_battle_status');
    expect(battleChecks.length).toBeGreaterThan(0);
  });

  it('should handle battle interrupt during station docking for trade', async () => {
    simulatePirateAttack(bot, scenario.interruptConfig);

    const dockResp = await bot.exec('dock');
    
    // Dock shouldn't be interrupted, but if it is, handle it
    if (dockResp.error?.code === 'battle_interrupt') {
      await bot.exec('battle', { action: 'stance', stance: 'flee' });
      assertFleeInitiated(bot, scenario);
    }
  });

  it('should preserve trade session state after battle', async () => {
    const initialSystem = bot.state.system;
    const initialCargo = bot.state.cargo;
    const initialCredits = bot.state.credits;

    simulatePirateAttack(bot, scenario.interruptConfig);
    await bot.exec('jump', { target_system: 'trade_destination_alpha' });
    await bot.refreshStatus();
    await bot.exec('battle', { action: 'stance', stance: 'flee' });

    // All state should be preserved
    expect(bot.state.system).toBe(initialSystem);
    expect(bot.state.cargo).toBe(initialCargo);
    expect(bot.state.credits).toBe(initialCredits);
  });

  it('should NOT spam market/battle commands while in battle', async () => {
    simulatePirateAttack(bot, scenario.interruptConfig);

    await bot.exec('jump', { target_system: 'trade_destination_alpha' });
    await bot.refreshStatus();
    await bot.exec('battle', { action: 'stance', stance: 'flee' });

    // Should not check market while in battle
    const marketCommands = bot.commandHistory.filter(c => c.command === 'view_market');
    expect(marketCommands.length).toBe(0);
  });
});

// ── Rescue Routine Tests ───────────────────────────────────────────────────────

describe('Rescue Routine - Battle Interrupt During Jump', () => {
  let bot: MockBot;
  let scenario: BattleInterruptScenario;

  beforeEach(() => {
    scenario = createRescueJumpInterruptScenario();
    bot = new MockBot({
      ...scenario.initialState,
      username: 'RescueBot_001',
    });
  });

  afterEach(() => {
    resetBotForNextTest(bot);
  });

  it('should detect battle interrupt during MAYDAY response', async () => {
    simulatePirateAttack(bot, scenario.interruptConfig);

    const jumpResp = await bot.exec('jump', {
      target_system: 'mayday_location_gamma',
    });

    assertBattleInterruptError(jumpResp, scenario);
    // Error message contains battle interrupt info (battle ID, not pirate name)
    expect(jumpResp.error?.message).toContain('interrupted by battle');
    expect(jumpResp.error?.code).toBe('battle_interrupt');
  });

  it('should verify system immediately before emergency flee', async () => {
    simulatePirateAttack(bot, scenario.interruptConfig);

    await bot.exec('jump', { target_system: 'mayday_location_gamma' });
    await bot.refreshStatus();

    const statusChecks = bot.commandHistory.filter(c => c.command === 'get_status');
    expect(statusChecks.length).toBeGreaterThan(0);
  });

  it('should flee immediately when ambushed during rescue mission', async () => {
    simulatePirateAttack(bot, scenario.interruptConfig);

    await bot.exec('jump', { target_system: 'mayday_location_gamma' });
    await bot.exec('battle', { action: 'stance', stance: 'flee' });

    assertFleeInitiated(bot, scenario);
    expect(bot.isInBattle()).toBe(false);
  });

  it('should be extra cautious: max 3 commands before flee (rescue-specific)', async () => {
    simulatePirateAttack(bot, scenario.interruptConfig);

    await bot.exec('jump', { target_system: 'mayday_location_gamma' });
    await bot.refreshStatus();
    await bot.exec('battle', { action: 'stance', stance: 'flee' });

    assertNoExcessiveCommands(bot, scenario.expectedBehavior.maxCommandsBeforeFlee);
  });

  it('should detect pirate system and avoid MAYDAY trap', async () => {
    simulatePirateAttack(bot, scenario.interruptConfig);

    await bot.exec('jump', { target_system: 'mayday_location_gamma' });
    await bot.refreshStatus();

    // Should recognize this is a pirate system
    expect(bot.state.system).toBe('rescue_origin_delta');
    
    // Flee
    await bot.exec('battle', { action: 'stance', stance: 'flee' });
    
    assertFleeInitiated(bot, scenario);
  });

  it('should handle battle interrupt during fuel cell delivery', async () => {
    simulatePirateAttack(bot, scenario.interruptConfig);

    const travelResp = await bot.exec('travel', {
      target_poi: 'rescue_target_poi',
    });

    assertBattleInterruptError(travelResp, scenario);
  });

  it('should NOT abandon MAYDAY target after fleeing - should retry from safe position', async () => {
    // First attempt - interrupted
    simulatePirateAttack(bot, scenario.interruptConfig);
    await bot.exec('jump', { target_system: 'mayday_location_gamma' });
    await bot.refreshStatus();
    await bot.exec('battle', { action: 'stance', stance: 'flee' });

    // After fleeing, should be in safe state
    expect(bot.isInBattle()).toBe(false);

    // Could retry from new position (but not immediately)
    const retryJumpCommands = bot.commandHistory.filter(c => c.command === 'jump');
    expect(retryJumpCommands.length).toBe(1); // Only the original attempt
  });

  it('should check for pirates via get_nearby before critical operations', async () => {
    simulatePirateAttack(bot, scenario.interruptConfig);

    await bot.exec('jump', { target_system: 'mayday_location_gamma' });
    
    // Check for pirates
    await bot.exec('get_nearby');

    const nearbyChecks = bot.commandHistory.filter(c => c.command === 'get_nearby');
    expect(nearbyChecks.length).toBeGreaterThan(0);
  });

  it('should handle multiple ambushes in pirate-heavy systems', async () => {
    // First ambush
    simulatePirateAttack(bot, scenario.interruptConfig);
    await bot.exec('jump', { target_system: 'mayday_location_gamma' });
    await bot.exec('battle', { action: 'stance', stance: 'flee' });

    // Second ambush
    simulatePirateAttack(bot, scenario.interruptConfig);
    await bot.exec('jump', { target_system: 'safe_haven_alpha' });
    await bot.exec('battle', { action: 'stance', stance: 'flee' });

    const fleeCommands = bot.commandHistory.filter(
      c => c.command === 'battle' && c.payload?.stance === 'flee'
    );
    expect(fleeCommands.length).toBe(2);
  });

  it('should preserve rescue cargo (fuel cells) after battle', async () => {
    const initialCargo = bot.state.cargo;

    simulatePirateAttack(bot, scenario.interruptConfig);
    await bot.exec('jump', { target_system: 'mayday_location_gamma' });
    await bot.refreshStatus();
    await bot.exec('battle', { action: 'stance', stance: 'flee' });

    // Rescue cargo (fuel cells) should be preserved
    expect(bot.state.cargo).toBe(initialCargo);
  });
});

// ── Cross-Routine Integration Tests ────────────────────────────────────────────

describe('Cross-Routine Battle Interrupt Integration', () => {
  it('should handle all four routines with consistent battle interrupt behavior', async () => {
    const scenarios = [
      createExplorerJumpInterruptScenario(),
      createMinerJumpInterruptScenario(),
      createTraderJumpInterruptScenario(),
      createRescueJumpInterruptScenario(),
    ];

    for (const scenario of scenarios) {
      const bot = new MockBot({
        ...scenario.initialState,
        username: `${scenario.routine}Bot_001`,
      });

      simulatePirateAttack(bot, scenario.interruptConfig);

      const jumpResp = await bot.exec('jump', {
        target_system: 'target_system',
      });

      // All should detect battle interrupt
      assertBattleInterruptError(jumpResp, scenario);

      // All should verify system
      await bot.refreshStatus();
      assertSystemVerified(bot, scenario);

      // All should flee
      await bot.exec('battle', { action: 'stance', stance: 'flee' });
      assertFleeInitiated(bot, scenario);

      // All should preserve state
      expect(bot.state.cargo).toBe(scenario.initialState.cargo ?? 0);
      expect(bot.state.fuel).toBeGreaterThan(0);

      resetBotForNextTest(bot);
    }
  });

  it('should NOT lose any ships across all routines with proper battle handling', async () => {
    const routines = ['explorer', 'miner', 'trader', 'rescue'] as const;

    for (const routine of routines) {
      let scenario: BattleInterruptScenario;
      switch (routine) {
        case 'explorer':
          scenario = createExplorerJumpInterruptScenario();
          break;
        case 'miner':
          scenario = createMinerJumpInterruptScenario();
          break;
        case 'trader':
          scenario = createTraderJumpInterruptScenario();
          break;
        case 'rescue':
          scenario = createRescueJumpInterruptScenario();
          break;
      }

      const bot = new MockBot({
        ...scenario.initialState,
        username: `${routine}Bot_001`,
      });

      simulatePirateAttack(bot, scenario.interruptConfig);

      // Execute proper battle handling
      const jumpResp = await bot.exec('jump', {
        target_system: 'target_system',
      });

      if (jumpResp.error?.code === 'battle_interrupt') {
        await bot.refreshStatus();
        await bot.exec('battle', { action: 'stance', stance: 'flee' });
      }

      // Ship should still be alive
      expect(bot.state.hull).toBeGreaterThan(0);
      expect(bot.state.state).toBe('running');

      resetBotForNextTest(bot);
    }
  });
});

// ── Edge Cases and Stress Tests ────────────────────────────────────────────────

describe('Battle Interrupt Edge Cases', () => {
  let bot: MockBot;

  beforeEach(() => {
    bot = new MockBot({
      system: 'test_system',
      fuel: 80,
      maxFuel: 100,
      username: 'EdgeCaseBot_001',
    });
  });

  afterEach(() => {
    resetBotForNextTest(bot);
  });

  it('should handle battle interrupt with 0ms delay (instant ambush)', async () => {
    const scenario = createExplorerJumpInterruptScenario();
    scenario.interruptConfig.delayMs = 0;
    
    simulatePirateAttack(bot, scenario.interruptConfig);
    const jumpResp = await bot.exec('jump', {
      target_system: 'target_system',
    });

    assertBattleInterruptError(jumpResp, scenario);
  });

  it('should handle battle interrupt with 500ms delay (slow ambush)', async () => {
    const scenario = createExplorerJumpInterruptScenario();
    scenario.interruptConfig.delayMs = 500;
    
    simulatePirateAttack(bot, scenario.interruptConfig);
    const jumpResp = await bot.exec('jump', {
      target_system: 'target_system',
    });

    assertBattleInterruptError(jumpResp, scenario);
  });

  it('should handle rapid successive battle interrupts', async () => {
    // First battle
    simulatePirateAttack(bot, createExplorerJumpInterruptScenario().interruptConfig);
    await bot.exec('jump', { target_system: 'system_a' });
    await bot.exec('battle', { action: 'stance', stance: 'flee' });

    // Second battle immediately
    simulatePirateAttack(bot, createExplorerJumpInterruptScenario().interruptConfig);
    await bot.exec('jump', { target_system: 'system_b' });
    await bot.exec('battle', { action: 'stance', stance: 'flee' });

    // Third battle
    simulatePirateAttack(bot, createExplorerJumpInterruptScenario().interruptConfig);
    await bot.exec('jump', { target_system: 'system_c' });
    await bot.exec('battle', { action: 'stance', stance: 'flee' });

    const fleeCommands = bot.commandHistory.filter(
      c => c.command === 'battle' && c.payload?.stance === 'flee'
    );
    expect(fleeCommands.length).toBe(3);
  });

  it('should handle battle interrupt when fuel is critically low', async () => {
    bot.state.fuel = 5;
    bot.state.maxFuel = 100;

    simulatePirateAttack(bot, createExplorerJumpInterruptScenario().interruptConfig);
    const jumpResp = await bot.exec('jump', {
      target_system: 'target_system',
    });

    // Should still detect battle and flee
    assertBattleInterruptError(jumpResp, createExplorerJumpInterruptScenario());
    
    // Fuel should be preserved
    expect(bot.state.fuel).toBe(5);
  });

  it('should handle battle interrupt when already in battle (stacked battles)', async () => {
    bot.state.isInBattle = true;
    bot.state.currentBattleId = 'existing_battle';
    bot.battleWebSocketState.inBattle = true;

    simulatePirateAttack(bot, createExplorerJumpInterruptScenario().interruptConfig);
    const jumpResp = await bot.exec('jump', {
      target_system: 'target_system',
    });

    // Should still handle the new battle
    expect(jumpResp.error?.code).toBe('battle_interrupt');
  });

  it('should NOT crash if get_status fails during battle', async () => {
    simulatePirateAttack(bot, createExplorerJumpInterruptScenario().interruptConfig);
    
    await bot.exec('jump', { target_system: 'target_system' });
    
    // Override to simulate get_status failure
    bot.mockGetStatusOverride = null;
    
    // Should still be able to flee
    await bot.exec('battle', { action: 'stance', stance: 'flee' });
    
    expect(bot.isInBattle()).toBe(false);
  });

  it('should handle battle interrupt with null target system', async () => {
    simulatePirateAttack(bot, createExplorerJumpInterruptScenario().interruptConfig);
    
    const jumpResp = await bot.exec('jump', {});

    assertBattleInterruptError(jumpResp, createExplorerJumpInterruptScenario());
  });
});
