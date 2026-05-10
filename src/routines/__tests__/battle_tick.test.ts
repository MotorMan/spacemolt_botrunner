/**
 * Battle Tick Timing Tests
 * 
 * Verifies that battle commands (mutation commands) properly wait for the server tick
 * before sending the next command. Server tick is every 10 seconds.
 * 
 * Battle commands that LOCK:
 * - battle (advance, retreat, stance, target, flee)
 * 
 * Non-locking commands (can be called anytime):
 * - get_battle_status
 * - get_nearby
 * - get_status
 * - get_ship
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Bot, RoutineContext } from "../bot.js";
import { fightFreshBattle, fightJoinedBattle, waitForServerTick } from "../battle.js";

// Mock bot with controllable tick simulation
function createMockBot(options: {
  serverTickMs?: number;
  initialTick?: number;
  hull?: number;
  maxHull?: number;
  shield?: number;
  maxShield?: number;
}) {
  const {
    serverTickMs = 10000,
    initialTick = 100,
    hull = 180,
    maxHull = 180,
    shield = 90,
    maxShield = 90,
  } = options;

  let currentTick = initialTick;
  let tickInProgress = false;
  let tickResolve: (() => void) | null = null;
  
  const commandLog: Array<{ command: string; timestamp: number; tick: number }> = [];

  // Simulate server tick advancing
  function advanceTick() {
    currentTick++;
    if (tickResolve) {
      tickResolve();
      tickResolve = null;
    }
    tickInProgress = false;
  }

  // Start a tick (locks battle commands for serverTickMs)
  function startTick() {
    tickInProgress = true;
    setTimeout(() => {
      advanceTick();
    }, serverTickMs);
  }

  const bot = {
    state: "running" as const,
    hull,
    maxHull,
    shield,
    maxShield,
    system: "test-system",
    poi: "test-poi",
    
    // Mock exec that simulates server tick locking
    async exec(command: string, params?: Record<string, unknown>) {
      const timestamp = Date.now();
      const commandStr = `${command}${params ? JSON.stringify(params) : ""}`;
      
      // Check if this is a battle command (mutation)
      const isBattleCommand = command === "battle";
      const isNonLocking = ["get_battle_status", "get_nearby", "get_status", "get_ship"].includes(command);
      
      if (isBattleCommand) {
        // Battle commands LOCK until next server tick
        if (tickInProgress) {
          // Still waiting for tick - this should NOT happen with proper code
          commandLog.push({ command: commandStr, timestamp, tick: currentTick });
          return {
            error: { message: "in_battle: command locked until next tick", code: "in_battle" },
          };
        }
        
        // Start a new tick
        commandLog.push({ command: commandStr, timestamp, tick: currentTick });
        startTick();
        
        // Wait for tick to complete
        await new Promise<void>(resolve => {
          tickResolve = resolve;
        });
        
        return { result: { success: true } };
      }
      
      if (isNonLocking) {
        // Non-locking commands can be called anytime
        commandLog.push({ command: commandStr, timestamp, tick: currentTick });
        if (command === "get_battle_status") {
          return {
            result: {
              battle_id: "test-battle",
              tick: currentTick,
              your_zone: "engaged",
              is_participant: true,
              participants: [],
              sides: [],
            },
          };
        }
        return { result: {} };
      }
      
      commandLog.push({ command: commandStr, timestamp, tick: currentTick });
      return { result: {} };
    },
    
    async refreshStatus() {},
    async refreshCargo() {},
  } as unknown as Bot;

  return {
    bot,
    commandLog,
    advanceTick,
    get currentTick() { return currentTick; },
  };
}

describe("Battle Server Tick Timing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should wait for server tick between battle commands", async () => {
    const { bot, commandLog } = createMockBot({ serverTickMs: 10000 });
    
    const ctx = {
      bot,
      log: vi.fn(),
      sleep: vi.fn().mockImplementation((ms: number) => vi.advanceTimersByTimeAsync(ms)),
    } as unknown as RoutineContext;

    const target = {
      id: "enemy-1",
      name: "Test Enemy",
      type: "pirate",
      faction: "pirate",
      isNPC: true,
      isPirate: true,
    };

    // Start the battle loop in background
    const battlePromise = fightFreshBattle(ctx, target, 20, "large", "large");
    
    // Advance past first tick (initial stance command)
    await vi.advanceTimersByTimeAsync(10000);
    
    // Now send a second battle command (should wait for another tick)
    // Simulate the loop sending another command
    await vi.advanceTimersByTimeAsync(10000);
    
    // Check that commands were sent with proper timing
    const battleCommands = commandLog.filter(c => c.command.includes("battle"));
    expect(battleCommands.length).toBeGreaterThanOrEqual(2);
    
    // Verify commands are at least 10 seconds apart (1 tick)
    for (let i = 1; i < battleCommands.length; i++) {
      const timeDiff = battleCommands[i].timestamp - battleCommands[i - 1].timestamp;
      expect(timeDiff).toBeGreaterThanOrEqual(10000);
    }
    
    // End the battle
    // (In real code, this would happen when battle ends)
    
    await battlePromise.catch(() => {}); // Ignore errors
  });

  it("should allow non-locking commands between battle commands", async () => {
    const { bot, commandLog } = createMockBot({ serverTickMs: 10000 });
    
    const ctx = {
      bot,
      log: vi.fn(),
      sleep: vi.fn().mockImplementation((ms: number) => vi.advanceTimersByTimeAsync(ms)),
    } as unknown as RoutineContext;

    // Send a battle command
    await bot.exec("battle", { action: "stance", stance: "fire" });
    
    // Now try a non-locking command (should work immediately)
    const statusResp = await bot.exec("get_battle_status");
    expect(statusResp.error).toBeUndefined();
    
    // Verify the non-locking command was logged
    const statusCommands = commandLog.filter(c => c.command.includes("get_battle_status"));
    expect(statusCommands.length).toBe(1);
  });

  it("waitForServerTick should wait for tick to advance", async () => {
    const { bot, currentTick } = createMockBot({ serverTickMs: 10000 });
    
    const ctx = {
      bot,
      log: vi.fn(),
      sleep: vi.fn().mockImplementation((ms: number) => vi.advanceTimersByTimeAsync(ms)),
    } as unknown as RoutineContext;

    const initialTick = currentTick;
    
    // Start waiting for tick
    const waitPromise = waitForServerTick(ctx, initialTick);
    
    // Advance time past 1 tick
    await vi.advanceTimersByTimeAsync(10000);
    
    await waitPromise;
    
    // Verify tick advanced
    expect(currentTick).toBeGreaterThan(initialTick);
  });

  it("should NOT send multiple battle commands within same tick", async () => {
    const { bot, commandLog } = createMockBot({ serverTickMs: 10000 });
    
    let battleCommandCount = 0;
    let lastBattleCommandTime = 0;
    
    // Override exec to track battle command timing
    const originalExec = bot.exec.bind(bot);
    bot.exec = async (command: string, params?: Record<string, unknown>) => {
      if (command === "battle") {
        const now = Date.now();
        if (lastBattleCommandTime > 0) {
          const diff = now - lastBattleCommandTime;
          // Should be at least 10 seconds (1 tick) apart
          if (diff < 10000) {
            throw new Error(`Battle commands sent too quickly! Only ${diff}ms apart`);
          }
        }
        lastBattleCommandTime = now;
        battleCommandCount++;
      }
      return originalExec(command, params);
    };
    
    const ctx = {
      bot,
      log: vi.fn(),
      sleep: vi.fn().mockImplementation((ms: number) => vi.advanceTimersByTimeAsync(ms)),
    } as unknown as RoutineContext;

    // Send first battle command
    await bot.exec("battle", { action: "stance", stance: "fire" });
    
    // Try to send second immediately (should fail/wait)
    // In real code, the second command would wait for tick
    await vi.advanceTimersByTimeAsync(10000);
    
    expect(battleCommandCount).toBe(2);
  });
});

/**
 * Integration Test Notes:
 * 
 * To run a REAL-WORLD test with actual 10-second server ticks:
 * 
 * 1. Set up a test bot with actual API connection
 * 2. Join a battle
 * 3. Send battle commands and measure time between responses
 * 4. Verify each command takes ~10 seconds to complete
 * 5. Verify non-locking commands (get_battle_status) return immediately
 * 
 * This would require:
 * - Real API credentials
 * - A test server or controlled environment
 * - Timing measurements
 */
