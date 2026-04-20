/**
 * Test script for mining location scoring.
 * Run with: npx ts-node src/test_scoring.ts
 * 
 * Tests various scenarios to verify the scoring formula:
 * - Distance vs richness balance
 * - Ship speed effects
 * - Cargo capacity effects
 * - Mining ship bonus
 */

interface MockLocation {
  systemId: string;
  systemName: string;
  poiId: string;
  poiName: string;
  resourceId: string;
  totalMined: number;
  hasStation: boolean;
  remaining: number;
  maxRemaining: number;
  depletionPercent: number;
  minutesSinceScan: number;
  jumpsAway: number;
  isHidden: boolean;
  richness: number;
}

function calculateScore(
  loc: MockLocation,
  speed: number = 1,
  cargo: number = 8000,
  isMiningShip: boolean = false
): number {
  const fromSystem = "sol"; // Faction home
  const jumpsAway = loc.jumpsAway;
  const effectiveCargo = isMiningShip ? cargo * 2 : cargo;
  
  // 1. Resource abundance
  let abundanceScore = Math.min(100, Math.log10(loc.remaining + 1) * 15);
  if (loc.depletionPercent >= 95) abundanceScore += 20;
  
  // 2. Availability bonus
  const availabilityScore = (loc.depletionPercent / 100) * 30;
  
  // 3. Distance with ship adjustments
  const speedFactor = speed >= 5 ? 0.4 : speed >= 4 ? 0.6 : speed >= 3 ? 0.75 : speed >= 2 ? 0.85 : 1.0;
  const cargoFactor = Math.min(1.5, effectiveCargo / 8000);
  let basePenalty = 50 - jumpsAway * 3;
  if (jumpsAway > 10) {
    basePenalty -= (jumpsAway - 10) * 4;
  }
  const adjustedPenalty = basePenalty * speedFactor * (2 - cargoFactor * 0.5);
  const distanceScore = Math.max(-60, Math.round(adjustedPenalty));
  
  // 3b. Richness efficiency
  const maxEfficiencyJumps = speed >= 5 ? 18 : speed >= 4 ? 15 : speed >= 3 ? 14 : 12;
  const richnessEfficiencyScore = jumpsAway <= maxEfficiencyJumps && loc.richness > 25
    ? Math.min(35, (loc.richness - 25) * (1 - jumpsAway / maxEfficiencyJumps) * 0.6)
    : 0;
  
  // 4. Freshness
  let freshnessScore = loc.minutesSinceScan === Infinity ? 5 : loc.minutesSinceScan > 180 ? 10 : 20;
  
  // 5. Depletion penalty
  let depletionPenalty = 0;
  if (loc.depletionPercent < 25) {
    depletionPenalty = -30 * ((25 - loc.depletionPercent) / 15);
  }
  
  // 6. Hidden POI bonus
  const hiddenPoiBonus = loc.isHidden ? 200 : 0;
  
  // 7. Richness
  const richnessScore = Math.min(60, loc.richness * 1.5);
  
  const total = abundanceScore + availabilityScore + distanceScore + richnessEfficiencyScore + 
              freshnessScore + depletionPenalty + hiddenPoiBonus + richnessScore;
  
  return Math.round(total * 100) / 100;
}

function testScenario(
  name: string,
  locations: MockLocation[],
  speed: number = 1,
  cargo: number = 8000,
  isMiningShip: boolean = false
): void {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`TEST: ${name}`);
  console.log(`Ship: speed=${speed}, cargo=${cargo}, miningShip=${isMiningShip}`);
  console.log("=".repeat(60));
  
  const scored = locations.map(loc => ({
    ...loc,
    score: calculateScore(loc, speed, cargo, isMiningShip)
  })).sort((a, b) => b.score - a.score);
  
  console.log("\nRanked locations:");
  for (let i = 0; i < scored.length; i++) {
    const loc = scored[i];
    console.log(`  ${i + 1}. ${loc.systemName} - ${loc.poiName}`);
    console.log(`     ${loc.jumpsAway} jumps, richness ${loc.richness}, ${loc.remaining.toLocaleString()} remaining`);
    console.log(`     Score: ${loc.score}`);
  }
  
  console.log(`\n>>> WINNER: ${scored[0].systemName} - ${scored[0].poiName} <<<`);
}

async function runTests() {
  console.log("Mining Location Scoring Tests");
  console.log("=".repeat(60));
  
  // Test 1: Basic - slow ship, should prefer closer/higher richness
  testScenario("SLOW SHIP (speed 1, cargo 8K)", [
    { systemId: "hd_10647", systemName: "HD 10647", poiId: "belt1", poiName: "HD 10647 Belt", resourceId: "titanium_ore", totalMined: 0, hasStation: false, remaining: 8000, maxRemaining: 8000, depletionPercent: 100, minutesSinceScan: 60, jumpsAway: 16, isHidden: false, richness: 15 },
    { systemId: "alphecca", systemName: "Alphecca", poiId: "deep_titanium", poiName: "Deep Titanium Vein", resourceId: "titanium_ore", totalMined: 0, hasStation: false, remaining: 19501, maxRemaining: 25000, depletionPercent: 78, minutesSinceScan: 30, jumpsAway: 12, isHidden: false, richness: 34 },
  ]);
  
  // Test 2: Fast ship - can travel further efficiently
  testScenario("FAST SHIP (speed 6, cargo 8K)", [
    { systemId: "hd_10647", systemName: "HD 10647", poiId: "belt1", poiName: "HD 10647 Belt", resourceId: "titanium_ore", totalMined: 0, hasStation: false, remaining: 8000, maxRemaining: 8000, depletionPercent: 100, minutesSinceScan: 60, jumpsAway: 16, isHidden: false, richness: 15 },
    { systemId: "alphecca", systemName: "Alphecca", poiId: "deep_titanium", poiName: "Deep Titanium Vein", resourceId: "titanium_ore", totalMined: 0, hasStation: false, remaining: 19501, maxRemaining: 25000, depletionPercent: 78, minutesSinceScan: 30, jumpsAway: 12, isHidden: false, richness: 34 },
  ], 6, 8000, false);
  
  // Test 3: Mining ship with double cargo
  testScenario("MINING SHIP (speed 3, cargo 8K, double cargo)", [
    { systemId: "hd_10647", systemName: "HD 10647", poiId: "belt1", poiName: "HD 10647 Belt", resourceId: "titanium_ore", totalMined: 0, hasStation: false, remaining: 8000, maxRemaining: 8000, depletionPercent: 100, minutesSinceScan: 60, jumpsAway: 16, isHidden: false, richness: 15 },
    { systemId: "alphecca", systemName: "Alphecca", poiId: "deep_titanium", poiName: "Deep Titanium Vein", resourceId: "titanium_ore", totalMined: 0, hasStation: false, remaining: 19501, maxRemaining: 25000, depletionPercent: 78, minutesSinceScan: 30, jumpsAway: 12, isHidden: false, richness: 34 },
  ], 3, 8000, true);
  
  // Test 4: Compare very far but very rich vs close but poor
  testScenario("FAR RICH vs CLOSE POOR", [
    { systemId: "far_system", systemName: "Far System", poiId: "belt1", poiName: "Far Belt", resourceId: "titanium_ore", totalMined: 0, hasStation: false, remaining: 50000, maxRemaining: 50000, depletionPercent: 100, minutesSinceScan: 10, jumpsAway: 35, isHidden: false, richness: 60 },
    { systemId: "near_system", systemName: "Near System", poiId: "belt1", poiName: "Near Belt", resourceId: "titanium_ore", totalMined: 0, hasStation: false, remaining: 5000, maxRemaining: 5000, depletionPercent: 100, minutesSinceScan: 60, jumpsAway: 5, isHidden: false, richness: 15 },
  ]);
  
  // Test 5: Fast ship with large cargo
  testScenario("FAST CARGO SHIP (speed 5, cargo 20K)", [
    { systemId: "hd_10647", systemName: "HD 10647", poiId: "belt1", poiName: "HD 10647 Belt", resourceId: "titanium_ore", totalMined: 0, hasStation: false, remaining: 8000, maxRemaining: 8000, depletionPercent: 100, minutesSinceScan: 60, jumpsAway: 16, isHidden: false, richness: 15 },
    { systemId: "alphecca", systemName: "Alphecca", poiId: "deep_titanium", poiName: "Deep Titanium Vein", resourceId: "titanium_ore", totalMined: 0, hasStation: false, remaining: 19501, maxRemaining: 25000, depletionPercent: 78, minutesSinceScan: 30, jumpsAway: 12, isHidden: false, richness: 34 },
  ], 5, 20000, false);
  
  // Test 6: All scenarios at once
  console.log(`\n${"=".repeat(60)}`);
  console.log("SUMMARY: Score differences");
  console.log("=".repeat(60));
  
  const scenarios = [
    { name: "Slow basic", speed: 1, cargo: 8000, isMining: false },
    { name: "Speed 3", speed: 3, cargo: 8000, isMining: false },
    { name: "Speed 5", speed: 5, cargo: 8000, isMining: false },
    { name: "Speed 6", speed: 6, cargo: 8000, isMining: false },
    { name: "Mining ship", speed: 3, cargo: 8000, isMining: true },
    { name: "Large cargo", speed: 3, cargo: 20000, isMining: false },
  ];
  
  const short = { systemId: "alphecca", systemName: "Alphecca", poiId: "deep", poiName: "Deep", resourceId: "titanium_ore", totalMined: 0, hasStation: false, remaining: 19501, maxRemaining: 25000, depletionPercent: 78, minutesSinceScan: 30, jumpsAway: 12, isHidden: false, richness: 34 };
  const far = { systemId: "hd_10647", systemName: "HD 10647", poiId: "belt", poiName: "Belt", resourceId: "titanium_ore", totalMined: 0, hasStation: false, remaining: 8000, maxRemaining: 8000, depletionPercent: 100, minutesSinceScan: 60, jumpsAway: 16, isHidden: false, richness: 15 };
  
  for (const sc of scenarios) {
    const shortScore = calculateScore(short, sc.speed, sc.cargo, sc.isMining);
    const farScore = calculateScore(far, sc.speed, sc.cargo, sc.isMining);
    const diff = shortScore - farScore;
    const winner = diff > 0 ? "SHORT (Alphecca)" : diff < 0 ? "FAR (HD 10647)" : "TIE";
    console.log(`${sc.name.padEnd(15)}: Alphecca=${shortScore.toFixed(1)}, HD10647=${farScore.toFixed(1)}, diff=${diff > 0 ? "+" : ""}${diff.toFixed(1)} -> ${winner}`);
  }
}

runTests().catch(console.error);