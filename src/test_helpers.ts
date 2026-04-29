/**
 * Test Helpers for Bot Routines
 *
 * Provides common mock objects and utilities for testing bot routines
 * and their battle integration.
 */

import { vi } from "vitest";

import type { Bot, RoutineContext } from "./bot.js";
import type { ApiResponse } from "./api.js";

// Mock Bot Factory
export function createMockBot(options: {
  username?: string;
  system?: string;
  poi?: string | null;
  docked?: boolean;
  fuel?: number;
  maxFuel?: number;
  cargo?: number;
  cargoMax?: number;
  credits?: number;
  hull?: number;
  maxHull?: number;
  shield?: number;
  maxShield?: number;
  isInBattle?: boolean;
  currentBattleId?: string | null;
  state?: 'running' | 'stopped' | 'dead';
} = {}): Bot {
  const {
    username = "MockBot",
    system = "sol",
    poi = "sol_central",
    docked = true,
    fuel = 100,
    maxFuel = 100,
    cargo = 0,
    cargoMax = 50,
    credits = 1000,
    hull = 100,
    maxHull = 100,
    shield = 50,
    maxShield = 50,
    isInBattle = false,
    currentBattleId = null,
    state = 'running',
  } = options;

  return {
    username,
    system,
    poi,
    docked,
    fuel,
    maxFuel,
    cargo,
    cargoMax,
    credits,
    hull,
    maxHull,
    shield,
    maxShield,
    isInBattle: () => isInBattle,
    currentBattleId,
    state,
    // Mock other required properties
    inventory: [],
    api: {} as any,
    session: {} as any,
    // Add mock methods as needed
    refreshStatus: vi.fn(),
    refreshCargo: vi.fn(),
  } as Bot;
}

// Mock Context Factory
export function createMockContext(bot: Bot): RoutineContext {
  return {
    bot,
    log: vi.fn(),
    sleep: vi.fn(),
  };
}

// Mock API Response Factory
export function createMockApiResponse(options: {
  error?: { code: string; message: string } | null;
  result?: unknown;
  notifications?: unknown[];
} = {}): ApiResponse {
  const {
    error = null,
    result = null,
    notifications = [],
  } = options;

  return {
    error,
    result,
    notifications,
  };
}

// Battle State Mock Factory
export function createMockBattleState(options: {
  inBattle?: boolean;
  battleId?: string | null;
  lastFleeTime?: number | undefined;
} = {}) {
  const {
    inBattle = false,
    battleId = null,
    lastFleeTime = undefined,
  } = options;

  return {
    state: {
      inBattle,
      battleId,
      battleStartTick: null,
      lastHitTick: null,
      isFleeing: false,
      lastFleeTime,
    },
  };
}

// Weapon Mock Factory
export function createMockWeapon(options: {
  name?: string;
  range?: number;
  damage?: number;
} = {}) {
  const {
    name = "Mock Weapon",
    range = 1,
    damage = 10,
  } = options;

  return {
    name,
    stats: {
      range,
      damage,
    },
  };
}

// Fleet Command Mock Factory
export function createMockFleetCommand(options: {
  type?: string;
  params?: Record<string, unknown>;
  from?: string;
} = {}) {
  const {
    type = "ATTACK",
    params = {},
    from = "commander",
  } = options;

  return {
    type,
    params,
    from,
    timestamp: Date.now(),
  };
}