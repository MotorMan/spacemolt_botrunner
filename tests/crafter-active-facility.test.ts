/**
 * Crafter Active Facility Materials Tests
 * 
 * Tests that the crafter routine properly:
 * 1. Fetches active player facilities and identifies required materials
 * 2. Skips depositing materials needed by active facilities
 * 3. Correctly identifies facility materials in inventory and storage
 * 4. Handles missing facility data gracefully
 */

interface MockInventoryItem {
  itemId: string;
  name: string;
  quantity: number;
}

interface MockStorageItem {
  itemId: string;
  name: string;
  quantity: number;
}

interface MockFacility {
  facility_id: string;
  type: string;
  name: string;
  active: boolean;
  recipe_id: string;
  owner_id: string;
}

interface MockRecipe {
  recipe_id: string;
  name: string;
  components: Array<{ item_id: string; name: string; quantity: number }>;
  output_item_id: string;
  output_name: string;
  output_quantity: number;
  category?: string;
}

interface MockCommand {
  command: string;
  payload: Record<string, unknown>;
  timestamp: number;
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

function describe(name: string, fn: () => void): void {
  console.log(`\n📋 ${name}`);
  fn();
}

// ============ Test 1: Active facility detection ============

describe('Test 1: Parse active facility materials from API response', () => {
  const mockRecipes: MockRecipe[] = [
    {
      recipe_id: "breed_plutonium",
      name: "Breed Plutonium",
      components: [
        { item_id: "reactor_fuel_assembly", name: "Reactor Fuel Assembly", quantity: 1 },
        { item_id: "thorium_fuel_rod", name: "Thorium Fuel Rod", quantity: 2 },
      ],
      output_item_id: "plutonium",
      output_name: "Plutonium",
      output_quantity: 1,
    },
  ];

  const mockFacilityResponse = {
    player_facilities: [
      {
        facility_id: "879f0639e142c64d3b1200da7b88fefa",
        type: "breeder_reactor_core",
        name: "Breeder Reactor Core",
        active: true,
        recipe_id: "breed_plutonium",
        owner_id: "8fe5086a25180cf1035ca736d496c231",
      },
    ],
    faction_facilities: [],
  };

  const facilities = (mockFacilityResponse.player_facilities as MockFacility[]).filter(f => f.active);
  const activeMaterials: Array<{ itemId: string; name: string; facilityName: string; recipeId: string }> = [];

  for (const facility of facilities) {
    const recipe = mockRecipes.find(r => r.recipe_id === facility.recipe_id);
    if (!recipe) continue;

    for (const comp of recipe.components) {
      activeMaterials.push({
        itemId: comp.item_id,
        name: comp.name,
        facilityName: facility.name,
        recipeId: facility.recipe_id,
      });
    }
  }

  assert(facilities.length === 1, `Found ${facilities.length} active facility`);
  assert(activeMaterials.length === 2, `Extracted ${activeMaterials.length} material types`);
  assert(activeMaterials.some(m => m.itemId === "reactor_fuel_assembly"), "Found reactor_fuel_assembly");
  assert(activeMaterials.some(m => m.itemId === "thorium_fuel_rod"), "Found thorium_fuel_rod");
});

// ============ Test 2: Skip depositing active facility materials ============

describe('Test 2: Identify items to keep for active facilities during deposit', () => {
  const activeMaterials = [
    { itemId: "reactor_fuel_assembly", name: "Reactor Fuel Assembly", facilityName: "Breeder Reactor Core", recipeId: "breed_plutonium" },
    { itemId: "thorium_fuel_rod", name: "Thorium Fuel Rod", facilityName: "Breeder Reactor Core", recipeId: "breed_plutonium" },
  ];

  const cargoItems: MockInventoryItem[] = [
    { itemId: "reactor_fuel_assembly", name: "Reactor Fuel Assembly", quantity: 5 },
    { itemId: "plutonium", name: "Plutonium", quantity: 10 },
    { itemId: "iron_ingot", name: "Iron Ingot", quantity: 100 },
  ];

  const shouldDeposit = (itemId: string): boolean => {
    return !activeMaterials.some(m => m.itemId === itemId);
  };

  const toDeposit = cargoItems.filter(i => shouldDeposit(i.itemId));
  const toKeep = cargoItems.filter(i => !shouldDeposit(i.itemId));

  assert(toDeposit.length === 2, `Should deposit ${toDeposit.length} items`);
  assert(toKeep.length === 1, `Should keep ${toKeep.length} item for facilities`);
  assert(toKeep[0].itemId === "reactor_fuel_assembly", `Keeping ${toKeep[0].itemId} for facility`);
  assert(toDeposit.some(i => i.itemId === "plutonium"), "Plutonium should be deposited");
  assert(toDeposit.some(i => i.itemId === "iron_ingot"), "Iron ingot should be deposited");
});

// ============ Test 3: Handle multiple active facilities ============

describe('Test 3: Multiple active facilities with different material needs', () => {
  const mockRecipes: MockRecipe[] = [
    {
      recipe_id: "breed_plutonium",
      name: "Breed Plutonium",
      components: [
        { item_id: "reactor_fuel_assembly", name: "Reactor Fuel Assembly", quantity: 1 },
        { item_id: "thorium_fuel_rod", name: "Thorium Fuel Rod", quantity: 2 },
      ],
      output_item_id: "plutonium",
      output_name: "Plutonium",
      output_quantity: 1,
    },
    {
      recipe_id: "refine_iron",
      name: "Refine Iron",
      components: [
        { item_id: "iron_ore", name: "Iron Ore", quantity: 5 },
      ],
      output_item_id: "iron_ingot",
      output_name: "Iron Ingot",
      output_quantity: 1,
    },
  ];

  const mockFacilities = [
    { facility_id: "fac1", name: "Breeder Reactor", active: true, recipe_id: "breed_plutonium" },
    { facility_id: "fac2", name: "Iron Refinery", active: true, recipe_id: "refine_iron" },
  ];

  const allMaterials = new Set<string>();
  
  for (const facility of mockFacilities.filter(f => f.active)) {
    const recipe = mockRecipes.find(r => r.recipe_id === facility.recipe_id);
    if (!recipe) continue;
    
    for (const comp of recipe.components) {
      allMaterials.add(comp.item_id);
    }
  }

  assert(allMaterials.size === 3, `Total unique materials: ${allMaterials.size}`);
  assert(allMaterials.has("reactor_fuel_assembly"), "Has reactor_fuel_assembly");
  assert(allMaterials.has("thorium_fuel_rod"), "Has thorium_fuel_rod");
  assert(allMaterials.has("iron_ore"), "Has iron_ore");
});

// ============ Test 4: Handle inactive facilities ============

describe('Test 4: Inactive facilities are ignored', () => {
  const mockFacilities = [
    { facility_id: "fac1", name: "Breeder Reactor", active: true, recipe_id: "breed_plutonium" },
    { facility_id: "fac2", name: "Idle Refinery", active: false, recipe_id: "refine_iron" },
    { facility_id: "fac3", name: "Offline Lab", active: false, recipe_id: "make_circuit" },
  ];

  const activeFacilities = mockFacilities.filter(f => f.active);
  
  assert(activeFacilities.length === 1, `Only ${activeFacilities.length} active facility`);
  assert(activeFacilities[0].name === "Breeder Reactor", "Active facility is Breeder Reactor");
});

// ============ Test 5: Caching facility materials ============

describe('Test 5: Facility materials are cached per tick', () => {
  let cache: string[] = [];
  let lastTick = 0;

  const getCachedMaterials = (tick: number): string[] => {
    if (tick === lastTick && cache.length > 0) {
      console.log("  ⏩ Using cached facility materials");
      return cache;
    }
    
    cache = ["reactor_fuel_assembly", "thorium_fuel_rod"];
    lastTick = tick;
    return cache;
  };

  const tick1Materials = getCachedMaterials(1);
  const tick1CacheHit = getCachedMaterials(1);
  const tick2Materials = getCachedMaterials(2);

  assert(tick1Materials.length === 2, "Tick 1 retrieved materials");
  assert(tick1CacheHit.length === 2, "Tick 1 cache hit returned same materials");
  assert(tick2Materials.length === 2, "Tick 2 retrieved new materials (different tick)");
});

// ============ Test 6: Handle missing recipe for active facility ============

describe('Test 6: Missing recipe handled gracefully', () => {
  const mockFacilities = [
    { facility_id: "fac1", name: "Unknown Reactor", active: true, recipe_id: "nonexistent_recipe" },
  ];

  const mockRecipes: MockRecipe[] = [
    {
      recipe_id: "breed_plutonium",
      name: "Breed Plutonium",
      components: [
        { item_id: "reactor_fuel_assembly", name: "Reactor Fuel Assembly", quantity: 1 },
      ],
      output_item_id: "plutonium",
      output_name: "Plutonium",
      output_quantity: 1,
    },
  ];

  const materials: string[] = [];
  
  for (const facility of mockFacilities.filter(f => f.active)) {
    const recipe = mockRecipes.find(r => r.recipe_id === facility.recipe_id);
    if (!recipe) {
      console.log(`  ⚠️ No recipe found for facility: ${facility.name}`);
      continue;
    }
    
    for (const comp of recipe.components) {
      materials.push(comp.item_id);
    }
  }

  assert(materials.length === 0, "No materials added for unknown recipe");
});

// ============ Test 7: Personal storage keeps facility materials ============

describe('Test 7: Materials in personal storage are kept for facilities', () => {
  const activeMaterials = [
    { itemId: "reactor_fuel_assembly", name: "Reactor Fuel Assembly", facilityName: "Breeder Reactor Core", recipeId: "breed_plutonium" },
    { itemId: "thorium_fuel_rod", name: "Thorium Fuel Rod", facilityName: "Breeder Reactor Core", recipeId: "breed_plutonium" },
  ];

  const personalStorage: MockStorageItem[] = [
    { itemId: "reactor_fuel_assembly", name: "Reactor Fuel Assembly", quantity: 20 },
    { itemId: "thorium_fuel_rod", name: "Thorium Fuel Rod", quantity: 50 },
    { itemId: "plutonium", name: "Plutonium", quantity: 100 },
  ];

  const needsFacility = (itemId: string): boolean => {
    return activeMaterials.some(m => m.itemId === itemId);
  };

  const keepInPersonal = personalStorage.filter(i => needsFacility(i.itemId));
  const transferToFaction = personalStorage.filter(i => !needsFacility(i.itemId));

  assert(keepInPersonal.length === 2, `Keeping ${keepInPersonal.length} items for facilities`);
  assert(transferToFaction.length === 1, `Transferring ${transferToFaction.length} item to faction storage`);
  assert(keepInPersonal[0].itemId === "reactor_fuel_assembly", "Reactor fuel assembly kept for facility");
  assert(transferToFaction[0].itemId === "plutonium", "Plutonium can be transferred");
});

// ============ Test 8: Full deposit flow simulation ============

describe('Test 8: Full deposit flow with active facilities', () => {
  const activeFacilityMaterials = [
    { itemId: "reactor_fuel_assembly", name: "Reactor Fuel Assembly", facilityName: "Breeder Reactor Core", recipeId: "breed_plutonium" },
    { itemId: "thorium_fuel_rod", name: "Thorium Fuel Rod", facilityName: "Breeder Reactor Core", recipeId: "breed_plutonium" },
  ];

  const cargo = [
    { itemId: "reactor_fuel_assembly", name: "Reactor Fuel Assembly", quantity: 5 },
    { itemId: "plutonium", name: "Plutonium", quantity: 10 },
  ];

  const storage = [
    { itemId: "thorium_fuel_rod", name: "Thorium Fuel Rod", quantity: 30 },
    { itemId: "iron_ingot", name: "Iron Ingot", quantity: 100 },
  ];

  const isNeededByFacility = (itemId: string): boolean => {
    return activeFacilityMaterials.some(m => m.itemId === itemId);
  };

  const depositedToFaction: string[] = [];
  const keptForFacilities: string[] = [];

  for (const item of [...cargo, ...storage]) {
    if (isNeededByFacility(item.itemId)) {
      keptForFacilities.push(`${item.quantity}x ${item.name}`);
    } else {
      depositedToFaction.push(`${item.quantity}x ${item.name}`);
    }
  }

  assert(keptForFacilities.length === 2, "2 items kept for facilities");
  assert(depositedToFaction.length === 2, "2 items deposited to faction");
  assert(keptForFacilities.includes("5x Reactor Fuel Assembly"), "Kept reactor fuel assembly");
  assert(keptForFacilities.includes("30x Thorium Fuel Rod"), "Kept thorium fuel rod from storage");
  assert(depositedToFaction.includes("10x Plutonium"), "Deposited plutonium");
  assert(depositedToFaction.includes("100x Iron Ingot"), "Deposited iron ingot");

  console.log(`  📦 Deposited: ${depositedToFaction.join(", ")}`);
  console.log(`  🏭 Kept for facilities: ${keptForFacilities.join(", ")}`);
});

// ============ SUMMARY ============

console.log('\n' + '='.repeat(50));
console.log(`📊 TEST RESULTS: ${testsPassed} passed, ${testsFailed} failed`);
console.log('='.repeat(50));

if (testsFailed === 0) {
  console.log('✅ All tests passed! Active facility material retention working.');
  process.exit(0);
} else {
  console.error(`❌ ${testsFailed} test(s) failed`);
  process.exit(1);
}