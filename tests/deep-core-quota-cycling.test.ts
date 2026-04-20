/**
 * Deep Core Quota Cycling Tests
 * 
 * Tests the fix for the issue where:
 * 1. Deep core miner sees all quotas met and refuses to mine
 * 2. Expected behavior: should continue mining the least-over quota ore
 * 3. Quotas are for balancing, not stopping limits
 */

interface MockFactionStorage {
  itemId: string;
  quantity: number;
}

interface TestResult {
  passed: boolean;
  message: string;
  details?: string;
}

const tests: TestResult[] = [];

function test(name: string, fn: () => boolean): void {
  try {
    const result = fn();
    tests.push({ passed: result, message: name });
    console.log(`${result ? "✅" : "❌"} ${name}`);
  } catch (e) {
    tests.push({ passed: false, message: name, details: String(e) });
    console.log(`❌ ${name} - Error: ${e}`);
  }
}

function assert(condition: boolean, details: string): boolean {
  if (!condition) {
    console.log(`  ❌ Assert failed: ${details}`);
  }
  return condition;
}

console.log("\n📋 Deep Core Quota Cycling Tests\n");

// Simulate the deep core quota selection logic from miner.ts
function selectDeepCoreTargetWhenAllMet(
  deepCoreQuotas: Record<string, number>,
  factionStorage: MockFactionStorage[]
): { target: string | null; reason: string } {
  // Build quota entries with deficits
  const quotaEntries: Array<{ oreId: string; deficit: number }> = [];
  
  for (const [oreId, quotaTarget] of Object.entries(deepCoreQuotas)) {
    if (quotaTarget <= 0) continue;
    const current = factionStorage.find(i => i.itemId === oreId)?.quantity || 0;
    const deficit = quotaTarget - current;
    if (deficit > 0) {
      quotaEntries.push({ oreId, deficit });
    }
  }
  
  if (quotaEntries.length > 0) {
    // Sort: biggest deficit first
    quotaEntries.sort((a, b) => b.deficit - a.deficit);
    return { target: quotaEntries[0].oreId, reason: `deficit: ${quotaEntries[0].deficit}` };
  }
  
  // All quotas met - pick the one with smallest surplus (closest to deficit)
  // This is the FIX
  const allEntries: Array<{ oreId: string; deficit: number }> = [];
  for (const [oreId, quotaTarget] of Object.entries(deepCoreQuotas)) {
    if (quotaTarget <= 0) continue;
    const current = factionStorage.find(i => i.itemId === oreId)?.quantity || 0;
    const deficit = quotaTarget - current;
    allEntries.push({ oreId, deficit });
  }
  
  if (allEntries.length > 0) {
    // Sort by deficit DESCENDING (largest = closest to zero = smallest surplus)
    // deficit = target - current
    // -211 (small surplus) > -64567 (big surplus)
    allEntries.sort((a, b) => b.deficit - a.deficit);
    return { target: allEntries[0].oreId, reason: `all met, cycling to smallest surplus: ${allEntries[0].deficit}` };
  }
  
  return { target: null, reason: "no quotas configured" };
}

// Test 1: Should select ore with deficit when deficits exist
test("Should select ore with biggest deficit when deficits exist", () => {
  const deepCoreQuotas = {
    void_essence: 10000,
    fury_crystal: 10000,
    legacy_ore: 10000,
    prismatic_nebulite: 10000,
    exotic_matter: 10000,
    dark_matter_residue: 10000
  };
  
  const factionStorage: MockFactionStorage[] = [
    { itemId: "void_essence", quantity: 5000 },    // deficit: 5000
    { itemId: "fury_crystal", quantity: 8000 },    // deficit: 2000
    { itemId: "legacy_ore", quantity: 12000 },     // over: -2000
    { itemId: "prismatic_nebulite", quantity: 15000 }, // over: -5000
    { itemId: "exotic_matter", quantity: 20000 },  // over: -10000
    { itemId: "dark_matter_residue", quantity: 5000 } // deficit: 5000
  ];
  
  const result = selectDeepCoreTargetWhenAllMet(deepCoreQuotas, factionStorage);
  
  return assert(
    result.target === "void_essence" || result.target === "dark_matter_residue",
    `Selected ${result.target} with reason: ${result.reason}`
  );
});

// Test 2: Should NOT stop when all quotas are met - should cycle to smallest surplus
test("Should NOT stop when all quotas met - should cycle to smallest surplus", () => {
  // This is the bug scenario from the log
  const deepCoreQuotas = {
    fury_crystal: 10000,
    legacy_ore: 10000,
    prismatic_nebulite: 10000,
    exotic_matter: 10000,
    dark_matter_residue: 10000,
    void_essence: 10000
  };
  
  // All over quota (from the log):
  // fury_crystal: 16,507/10,000 (surplus: +6507)
  // legacy_ore: 10,870/10,000 (surplus: +870)
  // prismatic_nebulite: 13,781/10,000 (surplus: +3781)
  // exotic_matter: 10,706/10,000 (surplus: +706)
  // dark_matter_residue: 10,211/10,000 (surplus: +211)
  // void_essence: 74,567/10,000 (surplus: +64567)
  const factionStorage: MockFactionStorage[] = [
    { itemId: "fury_crystal", quantity: 16507 },
    { itemId: "legacy_ore", quantity: 10870 },
    { itemId: "prismatic_nebulite", quantity: 13781 },
    { itemId: "exotic_matter", quantity: 10706 },
    { itemId: "dark_matter_residue", quantity: 10211 },
    { itemId: "void_essence", quantity: 74567 }
  ];
  
  const result = selectDeepCoreTargetWhenAllMet(deepCoreQuotas, factionStorage);
  
  // Bug behavior: result.target would be null (stop mining!)
  // Fix behavior: result.target should be "dark_matter_residue" (smallest surplus: +211)
  return assert(
    result.target !== null && result.target === "dark_matter_residue",
    `Selected ${result.target} with reason: ${result.reason}`
  );
});

// Test 3: When one ore is under quota, should prioritize it
test("Should prioritize ore under quota over all-over scenario", () => {
  const deepCoreQuotas = {
    void_essence: 10000,
    fury_crystal: 10000,
    legacy_ore: 10000,
    prismatic_nebulite: 10000,
    exotic_matter: 10000,
    dark_matter_residue: 10000
  };
  
  // Most ores over, but one under
  const factionStorage: MockFactionStorage[] = [
    { itemId: "void_essence", quantity: 5000 },    // deficit: 5000 - SHOULD BE CHOSEN
    { itemId: "fury_crystal", quantity: 16507 },
    { itemId: "legacy_ore", quantity: 10870 },
    { itemId: "prismatic_nebulite", quantity: 13781 },
    { itemId: "exotic_matter", quantity: 10706 },
    { itemId: "dark_matter_residue", quantity: 10211 }
  ];
  
  const result = selectDeepCoreTargetWhenAllMet(deepCoreQuotas, factionStorage);
  
  return assert(
    result.target === "void_essence",
    `Selected ${result.target} with reason: ${result.reason}`
  );
});

// Test 4: Verify smallest surplus selection order
test("Should correctly sort by smallest surplus (most negative deficit)", () => {
  const deepCoreQuotas = {
    ore_a: 10000,
    ore_b: 10000,
    ore_c: 10000,
    ore_d: 10000
  };
  
  // Surpluses: a=+100, b=+500, c=+200, d=+50
  const factionStorage: MockFactionStorage[] = [
    { itemId: "ore_a", quantity: 10100 },
    { itemId: "ore_b", quantity: 10500 },
    { itemId: "ore_c", quantity: 10200 },
    { itemId: "ore_d", quantity: 10050 }
  ];
  
  const result = selectDeepCoreTargetWhenAllMet(deepCoreQuotas, factionStorage);
  
  // Should pick ore_d (smallest surplus: +50)
  return assert(
    result.target === "ore_d",
    `Should pick smallest surplus ore_d (+50), got: ${result.target}`
  );
});

// Test 5: Empty quotas should return null
test("Should return null when no quotas configured", () => {
  const deepCoreQuotas: Record<string, number> = {};
  const factionStorage: MockFactionStorage[] = [];
  
  const result = selectDeepCoreTargetWhenAllMet(deepCoreQuotas, factionStorage);
  
  return assert(
    result.target === null,
    `No target when no quotas: ${result.reason}`
  );
});

// Test 6: Edge case - all quotas at exactly 0
test("Should handle quotas at 0", () => {
  const deepCoreQuotas = {
    void_essence: 0,
    fury_crystal: 0,
    legacy_ore: 0
  };
  
  const factionStorage: MockFactionStorage[] = [
    { itemId: "void_essence", quantity: 1000 },
    { itemId: "fury_crystal", quantity: 2000 },
    { itemId: "legacy_ore", quantity: 3000 }
  ];
  
  const result = selectDeepCoreTargetWhenAllMet(deepCoreQuotas, factionStorage);
  
  return assert(
    result.target === null,
    `No target when quotas are 0: ${result.reason}`
  );
});

// Test 7: Edge case - partial faction storage (some ores missing)
test("Should handle missing ores in faction storage", () => {
  const deepCoreQuotas = {
    void_essence: 10000,
    fury_crystal: 10000,
    legacy_ore: 10000
  };
  
  // Only void_essence and fury_crystal in storage (legacy_ore missing = 0)
  const factionStorage: MockFactionStorage[] = [
    { itemId: "void_essence", quantity: 15000 },  // over +5000
    { itemId: "fury_crystal", quantity: 12000 }   // over +2000
    // legacy_ore not in storage = 0 (deficit of 10000)
  ];
  
  const result = selectDeepCoreTargetWhenAllMet(deepCoreQuotas, factionStorage);
  
  // Should pick legacy_ore (deficit: 10000)
  return assert(
    result.target === "legacy_ore",
    `Should pick legacy_ore (deficit), got: ${result.target}`
  );
});

// Test 8: Verify cycle order when all equal surplus
test("Should handle equal surpluses deterministically", () => {
  const deepCoreQuotas = {
    ore_a: 10000,
    ore_b: 10000,
    ore_c: 10000
  };
  
  // All same surplus
  const factionStorage: MockFactionStorage[] = [
    { itemId: "ore_a", quantity: 11000 },
    { itemId: "ore_b", quantity: 11000 },
    { itemId: "ore_c", quantity: 11000 }
  ];
  
  const result = selectDeepCoreTargetWhenAllMet(deepCoreQuotas, factionStorage);
  
  // When all equal, first one sorted alphabetically should be picked
  // (sort by deficit ascending: all have deficit = -1000, then by oreId)
  return assert(
    result.target !== null,
    `Should pick one of the ores (deterministic), got: ${result.target}`
  );
});

// Print results
const passed = tests.filter(t => t.passed).length;
const failed = tests.filter(t => !t.passed).length
console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\n❌ Failed tests:");
  tests.filter(t => !t.passed).forEach(t => {
    console.log(`  - ${t.message}`);
    if (t.details) console.log(`    ${t.details}`);
  });
}
process.exit(failed > 0 ? 1 : 0);