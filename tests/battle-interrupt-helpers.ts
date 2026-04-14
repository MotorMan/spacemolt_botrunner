/**
 * Battle Interrupt During Jump - Test Infrastructure
 * 
 * This file provides mock infrastructure for testing battle interrupts
 * that occur during jump commands across all routines (explorer, miner, trader, rescue).
 * 
 * The scenario: A bot issues a jump command, but on the next tick gets attacked
 * by a pirate, causing the jump to be interrupted. This has been a MAJOR problem
 * causing lost ships.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface MockBotState {
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
  username: string;
}

export interface MockCommandCall {
  command: string;
  payload: Record<string, unknown>;
  timestamp: number;
  responseTime: number; // Simulated delay in ms
}

export interface MockBattleNotification {
  type: 'battle_start' | 'battle_tick' | 'battle_hit' | 'battle_end' | 'battle_disengage';
  battleId: string;
  tick?: number;
  message?: string;
  participants?: Array<Record<string, unknown>>;
}

export interface MockApiResponse<T = unknown> {
  result?: T;
  error?: { code: string; message: string };
  notifications?: MockBattleNotification[];
}

export interface MockRoutineContext {
  bot: MockBot;
  logs: Array<{ level: string; message: string; timestamp: number }>;
  getFleetStatus?: () => Array<MockBotState>;
}

// ── Mock Bot ───────────────────────────────────────────────────────────────────

export class MockBot {
  state: MockBotState;
  commandHistory: MockCommandCall[] = [];
  battleWebSocketState: {
    inBattle: boolean;
    battleId: string | null;
    lastUpdate: number;
    participants: Array<Record<string, unknown>>;
  } = { inBattle: false, battleId: null, lastUpdate: 0, participants: [] };

  // Simulation controls
  shouldInterruptJumpWithBattle = false;
  battleInterruptDelay = 0; // ms before battle interrupt occurs
  jumpSuccessRate = 1.0; // 1.0 = always succeeds, 0.0 = always fails
  mockBattleNotifications: MockBattleNotification[] = [];
  mockGetStatusOverride: Partial<MockBotState> | null = null;

  constructor(initialState: Partial<MockBotState>) {
    this.state = {
      system: initialState.system || 'test_system_alpha',
      poi: initialState.poi || null,
      docked: initialState.docked ?? false,
      fuel: initialState.fuel ?? 100,
      maxFuel: initialState.maxFuel ?? 100,
      cargo: initialState.cargo ?? 0,
      cargoMax: initialState.cargoMax ?? 50,
      credits: initialState.credits ?? 100000,
      hull: initialState.hull ?? 520,
      maxHull: initialState.maxHull ?? 520,
      shield: initialState.shield ?? 130,
      maxShield: initialState.maxShield ?? 130,
      isInBattle: initialState.isInBattle ?? false,
      currentBattleId: initialState.currentBattleId ?? null,
      state: initialState.state ?? 'running',
      username: initialState.username || 'TestBot_001',
    };
  }

  async exec(command: string, payload?: Record<string, unknown>): Promise<MockApiResponse> {
    const call: MockCommandCall = {
      command,
      payload: payload || {},
      timestamp: Date.now(),
      responseTime: Math.floor(Math.random() * 100) + 50, // 50-150ms
    };
    this.commandHistory.push(call);

    // Handle different commands
    switch (command) {
      case 'jump': {
        return await this.handleJump(payload);
      }
      case 'travel': {
        return await this.handleTravel(payload);
      }
      case 'get_status': {
        return this.handleGetStatus();
      }
      case 'get_battle_status': {
        return this.handleGetBattleStatus();
      }
      case 'battle': {
        return this.handleBattleAction(payload);
      }
      case 'get_nearby': {
        return this.handleGetNearby();
      }
      case 'dock': {
        return this.handleDock();
      }
      case 'undock': {
        return this.handleUndock();
      }
      default: {
        return { result: {} };
      }
    }
  }

  private async handleJump(payload?: Record<string, unknown>): Promise<MockApiResponse> {
    // Simulate battle interrupt if configured
    if (this.shouldInterruptJumpWithBattle) {
      await this.sleep(this.battleInterruptDelay);
      
      // Trigger battle via WebSocket
      this.battleWebSocketState.inBattle = true;
      this.battleWebSocketState.battleId = `battle_${Date.now()}`;
      this.battleWebSocketState.lastUpdate = Date.now();
      
      this.state.isInBattle = true;
      this.state.currentBattleId = this.battleWebSocketState.battleId;

      return {
        error: {
          code: 'battle_interrupt',
          message: `Jump interrupted by battle ${this.battleWebSocketState.battleId}`,
        },
        notifications: this.mockBattleNotifications.length > 0 
          ? this.mockBattleNotifications 
          : [{
              type: 'battle_start',
              battleId: this.battleWebSocketState.battleId!,
              tick: 1,
              message: 'You have been attacked by Aggressor Clause!',
            }],
      };
    }

    // Normal jump success/failure
    if (Math.random() > this.jumpSuccessRate) {
      return {
        error: { code: 'jump_failed', message: 'Jump failed due to insufficient fuel' },
      };
    }

    // Successful jump
    const targetSystem = payload?.target_system as string;
    if (targetSystem) {
      this.state.system = targetSystem;
      this.state.poi = null;
    }

    return {
      result: {
        success: true,
        system: this.state.system,
      },
    };
  }

  private async handleTravel(payload?: Record<string, unknown>): Promise<MockApiResponse> {
    if (this.shouldInterruptJumpWithBattle) {
      await this.sleep(this.battleInterruptDelay);
      
      this.battleWebSocketState.inBattle = true;
      this.battleWebSocketState.battleId = `battle_${Date.now()}`;
      this.battleWebSocketState.lastUpdate = Date.now();
      
      this.state.isInBattle = true;
      this.state.currentBattleId = this.battleWebSocketState.battleId;

      return {
        error: {
          code: 'battle_interrupt',
          message: `Travel interrupted by battle ${this.battleWebSocketState.battleId}`,
        },
        notifications: [{
          type: 'battle_start',
          battleId: this.battleWebSocketState.battleId!,
          tick: 1,
          message: 'You have been attacked by Aggressor Clause!',
        }],
      };
    }

    const targetPoi = payload?.target_poi as string;
    if (targetPoi) {
      this.state.poi = targetPoi;
    }

    return {
      result: { success: true, poi: this.state.poi },
    };
  }

  private handleGetStatus(): MockApiResponse {
    const status = this.mockGetStatusOverride || this.state;
    return {
      result: {
        system_id: status.system,
        system_name: status.system,
        poi_id: status.poi,
        docked: status.docked,
        fuel: status.fuel,
        max_fuel: status.maxFuel,
        cargo: status.cargo,
        max_cargo: status.cargoMax,
        credits: status.credits,
        hull: status.hull,
        max_hull: status.maxHull,
        shield: status.shield,
        max_shield: status.maxShield,
      },
    };
  }

  private handleGetBattleStatus(): MockApiResponse {
    return {
      result: {
        battle_id: this.battleWebSocketState.battleId,
        is_participant: this.battleWebSocketState.inBattle,
        tick: 1,
        your_stance: 'fire',
        your_zone: 'engaged',
        participants: this.battleWebSocketState.participants,
      },
    };
  }

  private handleBattleAction(payload?: Record<string, unknown>): Promise<MockApiResponse> {
    const action = payload?.action as string;
    
    if (action === 'stance' && payload?.stance === 'flee') {
      // Flee successful
      this.battleWebSocketState.inBattle = false;
      this.battleWebSocketState.battleId = null;
      this.state.isInBattle = false;
      this.state.currentBattleId = null;

      return Promise.resolve({
        result: { success: true, stance: 'flee' },
        notifications: [{
          type: 'battle_disengage',
          battleId: 'previous_battle',
          message: 'You have disengaged from battle',
        }],
      });
    }

    return Promise.resolve({ result: { success: true } });
  }

  private handleGetNearby(): MockApiResponse {
    // Return pirates if we want to simulate pirate detection
    const hasPirates = this.mockBattleNotifications.length > 0;
    
    return {
      result: {
        entities: hasPirates ? [{
          type: 'ship',
          name: 'Aggressor Clause',
          is_pirate: true,
          distance: 5000,
        }] : [],
      },
    };
  }

  private async handleDock(): Promise<MockApiResponse> {
    this.state.docked = true;
    return { result: { success: true, docked: true } };
  }

  private async handleUndock(): Promise<MockApiResponse> {
    this.state.docked = false;
    return { result: { success: true, docked: false } };
  }

  isInBattle(): boolean {
    // Check if battle state is recent (within 60 seconds)
    const isRecent = Date.now() - this.battleWebSocketState.lastUpdate < 60000;
    return this.battleWebSocketState.inBattle && isRecent;
  }

  async refreshStatus(): Promise<void> {
    // Simulates API call to update bot state
    const statusResp = await this.exec('get_status');
    if (statusResp.result) {
      const result = statusResp.result as Record<string, unknown>;
      this.state.system = result.system_name as string;
      this.state.poi = result.poi_id as string | null;
      this.state.docked = result.docked as boolean;
      this.state.fuel = result.fuel as number;
      this.state.maxFuel = result.max_fuel as number;
      this.state.cargo = result.cargo as number;
      this.state.cargoMax = result.max_cargo as number;
      this.state.hull = result.hull as number;
      this.state.maxHull = result.max_hull as number;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  reset(): void {
    this.commandHistory = [];
    this.battleWebSocketState = { 
      inBattle: false, 
      battleId: null, 
      lastUpdate: 0, 
      participants: [] 
    };
    this.shouldInterruptJumpWithBattle = false;
    this.battleInterruptDelay = 0;
    this.jumpSuccessRate = 1.0;
    this.mockBattleNotifications = [];
    this.mockGetStatusOverride = null;
  }
}

// ── Test Scenario Builders ─────────────────────────────────────────────────────

export interface BattleInterruptScenario {
  name: string;
  description: string;
  routine: 'explorer' | 'miner' | 'trader' | 'rescue';
  initialState: Partial<MockBotState>;
  interruptConfig: {
    delayMs: number;
    pirateName: string;
    pirateTier: string;
    systemIsPirateSystem: boolean;
  };
  expectedBehavior: {
    shouldFlee: boolean;
    shouldVerifySystem: boolean;
    shouldRetryJump: boolean;
    maxCommandsBeforeFlee: number;
  };
}

export class BattleInterruptScenarioBuilder {
  private scenario: Partial<BattleInterruptScenario> = {};

  forRoutine(routine: 'explorer' | 'miner' | 'trader' | 'rescue'): this {
    this.scenario.routine = routine;
    return this;
  }

  named(name: string): this {
    this.scenario.name = name;
    return this;
  }

  describedAs(description: string): this {
    this.scenario.description = description;
    return this;
  }

  withInitialState(state: Partial<MockBotState>): this {
    this.scenario.initialState = state;
    return this;
  }

  withInterruptConfig(config: BattleInterruptScenario['interruptConfig']): this {
    this.scenario.interruptConfig = config;
    return this;
  }

  withExpectedBehavior(behavior: BattleInterruptScenario['expectedBehavior']): this {
    this.scenario.expectedBehavior = behavior;
    return this;
  }

  build(): BattleInterruptScenario {
    return {
      name: this.scenario.name || 'Unnamed Scenario',
      description: this.scenario.description || '',
      routine: this.scenario.routine!,
      initialState: this.scenario.initialState || {},
      interruptConfig: this.scenario.interruptConfig || {
        delayMs: 100,
        pirateName: 'Aggressor Clause',
        pirateTier: 'elite',
        systemIsPirateSystem: false,
      },
      expectedBehavior: this.scenario.expectedBehavior || {
        shouldFlee: true,
        shouldVerifySystem: true,
        shouldRetryJump: false,
        maxCommandsBeforeFlee: 5,
      },
    };
  }
}

// ── Common Scenario Factories ──────────────────────────────────────────────────

export function createExplorerJumpInterruptScenario(): BattleInterruptScenario {
  return new BattleInterruptScenarioBuilder()
    .forRoutine('explorer')
    .named('Explorer Jump Interrupt')
    .describedAs('Explorer issues jump command but gets attacked by pirate mid-jump')
    .withInitialState({
      system: 'peaceful_system_alpha',
      fuel: 80,
      maxFuel: 100,
      isInBattle: false,
      state: 'running',
    })
    .withInterruptConfig({
      delayMs: 50,
      pirateName: 'Aggressor Clause',
      pirateTier: 'elite',
      systemIsPirateSystem: false,
    })
    .withExpectedBehavior({
      shouldFlee: true,
      shouldVerifySystem: true,
      shouldRetryJump: false,
      maxCommandsBeforeFlee: 5,
    })
    .build();
}

export function createMinerJumpInterruptScenario(): BattleInterruptScenario {
  return new BattleInterruptScenarioBuilder()
    .forRoutine('miner')
    .named('Miner Jump Interrupt')
    .describedAs('Miner traveling to mining POI gets ambushed by pirates')
    .withInitialState({
      system: 'mining_system_beta',
      fuel: 60,
      maxFuel: 100,
      cargo: 30,
      cargoMax: 50,
      isInBattle: false,
      state: 'running',
    })
    .withInterruptConfig({
      delayMs: 100,
      pirateName: 'Void Reaper',
      pirateTier: 'master',
      systemIsPirateSystem: false,
    })
    .withExpectedBehavior({
      shouldFlee: true,
      shouldVerifySystem: true,
      shouldRetryJump: false,
      maxCommandsBeforeFlee: 5,
    })
    .build();
}

export function createTraderJumpInterruptScenario(): BattleInterruptScenario {
  return new BattleInterruptScenarioBuilder()
    .forRoutine('trader')
    .named('Trader Jump Interrupt')
    .describedAs('Trader with valuable cargo gets intercepted during jump')
    .withInitialState({
      system: 'trade_hub_gamma',
      fuel: 90,
      maxFuel: 100,
      cargo: 45,
      cargoMax: 50,
      credits: 500000,
      isInBattle: false,
      state: 'running',
    })
    .withInterruptConfig({
      delayMs: 75,
      pirateName: 'Star Marauder',
      pirateTier: 'veteran',
      systemIsPirateSystem: false,
    })
    .withExpectedBehavior({
      shouldFlee: true,
      shouldVerifySystem: true,
      shouldRetryJump: false,
      maxCommandsBeforeFlee: 5,
    })
    .build();
}

export function createRescueJumpInterruptScenario(): BattleInterruptScenario {
  return new BattleInterruptScenarioBuilder()
    .forRoutine('rescue')
    .named('Rescue Jump Interrupt')
    .describedAs('Rescue ship responding to MAYDAY gets ambushed en route')
    .withInitialState({
      system: 'rescue_origin_delta',
      fuel: 70,
      maxFuel: 100,
      cargo: 10,
      cargoMax: 50,
      isInBattle: false,
      state: 'running',
    })
    .withInterruptConfig({
      delayMs: 150,
      pirateName: 'Shadow Hunter',
      pirateTier: 'elite',
      systemIsPirateSystem: true,
    })
    .withExpectedBehavior({
      shouldFlee: true,
      shouldVerifySystem: true,
      shouldRetryJump: false,
      maxCommandsBeforeFlee: 3, // Rescue should be extra cautious
    })
    .build();
}

// ── Test Assertions ────────────────────────────────────────────────────────────

export function assertFleeInitiated(bot: MockBot, scenario: BattleInterruptScenario): void {
  const fleeCommands = bot.commandHistory.filter(
    c => c.command === 'battle' && c.payload?.stance === 'flee'
  );
  
  expect(fleeCommands.length).toBeGreaterThan(0);
}

export function assertSystemVerified(bot: MockBot, scenario: BattleInterruptScenario): void {
  const statusChecks = bot.commandHistory.filter(c => c.command === 'get_status');
  
  // Should check status at least once before/after flee
  expect(statusChecks.length).toBeGreaterThan(0);
}

export function assertNoExcessiveCommands(
  bot: MockBot, 
  maxCommands: number
): void {
  // Ensure bot didn't spam commands before fleeing
  expect(bot.commandHistory.length).toBeLessThanOrEqual(maxCommands);
}

export function assertBattleInterruptError(
  response: MockApiResponse,
  scenario: BattleInterruptScenario
): void {
  expect(response.error).toBeDefined();
  expect(response.error?.code).toBe('battle_interrupt');
  expect(response.error?.message).toContain('interrupted by battle');
}

// ── Helper Functions ───────────────────────────────────────────────────────────

export function createMockContext(bot: MockBot): MockRoutineContext {
  return {
    bot,
    logs: [],
    getFleetStatus: () => [bot.state],
  };
}

export function simulatePirateAttack(
  bot: MockBot,
  config: BattleInterruptScenario['interruptConfig']
): void {
  bot.shouldInterruptJumpWithBattle = true;
  bot.battleInterruptDelay = config.delayMs;
  bot.mockBattleNotifications = [{
    type: 'battle_start',
    battleId: `battle_${Date.now()}`,
    tick: 1,
    message: `You have been attacked by ${config.pirateName}!`,
    participants: [{
      username: config.pirateName,
      is_pirate: true,
      tier: config.pirateTier,
    }],
  }];
}

export function resetBotForNextTest(bot: MockBot): void {
  bot.reset();
}
