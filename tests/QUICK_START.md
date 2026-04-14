# Quick Start: Battle Interrupt Testing

## 🚀 Run Tests Immediately

### Windows (PowerShell)
```powershell
cd e:\code\code\spacemolt_botrunner

# Run all tests
.\tests\run-battle-interrupt-tests.ps1

# Run specific routine tests
.\tests\run-battle-interrupt-tests.ps1 -Explorer
.\tests\run-battle-interrupt-tests.ps1 -Miner
.\tests\run-battle-interrupt-tests.ps1 -Trader
.\tests\run-battle-interrupt-tests.ps1 -Rescue

# Run with verbose output
.\tests\run-battle-interrupt-tests.ps1 -Verbose

# Watch mode (auto-rerun on changes)
.\tests\run-battle-interrupt-tests.ps1 -Watch
```

### Alternative: Direct Bun Command
```bash
cd e:\code\code\spacemolt_botrunner

# Run all tests
bun test tests/battle-interrupt-routines.test.ts

# Run specific tests
bun test tests/battle-interrupt-routines.test.ts -t "Explorer Routine"
bun test tests/battle-interrupt-routines.test.ts -t "Miner Routine"
bun test tests/battle-interrupt-routines.test.ts -t "Trader Routine"
bun test tests/battle-interrupt-routines.test.ts -t "Rescue Routine"
```

## 📊 What You'll See

### If All Tests Pass ✅
```
═══════════════════════════════════════════════════════════
  Battle Interrupt Test Suite
  Testing critical jump interrupt handling
═══════════════════════════════════════════════════════════

Running tests...
[... 46 test results ...]

═══════════════════════════════════════════════════════════
  ✅ All tests passed!
  Battle interrupt handling is working correctly.
═══════════════════════════════════════════════════════════
```

### If Tests Fail ❌
```
═══════════════════════════════════════════════════════════
  ❌ Some tests failed!
  Review the failures above and fix the routine implementations.
  See tests/BATTLE_INTERRUPT_TESTING.md for details.
═══════════════════════════════════════════════════════════
```

## 🎯 What's Being Tested

The test suite verifies that when a **pirate attacks your bot during a jump command**:

1. ✅ Bot detects the `battle_interrupt` error
2. ✅ Bot verifies its actual position via `get_status`
3. ✅ Bot immediately issues `battle stance flee`
4. ✅ Bot does NOT spam commands (max 3-5 before fleeing)
5. ✅ Bot does NOT retry the jump immediately
6. ✅ Bot preserves fuel, cargo, and system state
7. ✅ Bot uses WebSocket battle state for fastest detection

## 🔍 Understanding Test Results

Each test verifies a specific aspect of battle interrupt handling:

### Example Test Output
```
✓ Explorer Routine - Battle Interrupt During Jump > should detect battle interrupt error from jump command (12ms)
✓ Explorer Routine - Battle Interrupt During Jump > should verify actual system via get_status before fleeing (8ms)
✓ Explorer Routine - Battle Interrupt During Jump > should issue flee stance command when battle detected (10ms)
```

- **✓** = Test passed, behavior is correct
- **✗** = Test failed, this could cause ship losses in production

## 🛠️ Fixing Failed Tests

If a test fails:

1. **Read the failure message** - it tells you what was expected
2. **Check the routine implementation** in `src/routines/{routine}.ts`
3. **Look for the battle interrupt handling** pattern:

```typescript
// CORRECT pattern (should be in all routines):
const jumpResp = await bot.exec("jump", { target_system: target });

if (jumpResp.error?.code === "battle_interrupt" || 
    jumpResp.error?.message?.includes("interrupted by battle")) {
  ctx.log("combat", "Battle interrupt detected!");
  await bot.refreshStatus();  // Verify position
  await fleeFromBattle(ctx, true, 35000);  // Flee immediately
  continue;  // Do NOT retry jump
}
```

4. **Common issues:**
   - Not checking for `battle_interrupt` error code
   - Not calling `bot.refreshStatus()` before fleeing
   - Retrying the jump command immediately after interrupt
   - Sending too many commands before fleeing

## 📝 Test Files Overview

| File | Purpose |
|------|---------|
| `battle-interrupt-helpers.ts` | Mock infrastructure and test utilities |
| `battle-interrupt-routines.test.ts` | 46 comprehensive test cases |
| `BATTLE_INTERRUPT_TESTING.md` | Full documentation |
| `run-battle-interrupt-tests.ps1` | PowerShell test runner |
| `run-battle-interrupt-tests.sh` | Bash test runner |

## 🎓 Learn More

- **Full documentation**: `tests/BATTLE_INTERRUPT_TESTING.md`
- **Existing battle tests**: `tests/battle-logic.test.ts`, `tests/battle-integration.test.ts`
- **Battle handling code**: `src/routines/common.ts` (functions: `fleeFromBattle`, `checkBattleAfterCommand`, `emergencyFleeFromPirates`)

## 🚨 Why This Matters

Battle interrupts during jumps have been causing **MAJOR ship losses**. This test suite ensures:

- **No lost ships** - Bots always flee battles instead of fighting
- **No lost cargo** - Valuable mining/trading goods are preserved
- **No wasted fuel** - Interrupted jumps don't consume fuel
- **Accurate state tracking** - Bots always know their actual position

## 📈 Next Steps

1. **Run the tests** to see current behavior
2. **Fix any failures** by updating routine implementations
3. **Add custom tests** for edge cases specific to your bots
4. **Integrate into CI/CD** to prevent regressions
5. **Monitor production** with battle interrupt logging

## 💡 Tips

- Run tests frequently while modifying battle handling code
- Use `-Verbose` mode to see detailed command sequences
- Watch mode (`-Watch`) is great for TDD (test-driven development)
- All tests are independent - you can run them in any order
- Tests complete in ~2-3 seconds total

## 🆘 Need Help?

If you're unsure about:
- **Why a test failed**: Check the assertion message in the test output
- **What the correct behavior should be**: See the expected pattern in `BATTLE_INTERRUPT_TESTING.md`
- **How to fix a routine**: Compare your code to the test expectations
- **Adding new tests**: Follow the pattern in existing test blocks

Remember: **These tests prevent ship losses**. Treat any failure as a critical bug!
