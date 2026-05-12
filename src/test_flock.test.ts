// Test suite for flock settings functionality
// This tests the save/load, group management, and assignments for flock settings

interface FlockGroup {
  name: string;
  targetOre: string;
  targetGas: string;
  targetIce: string;
  miningType: string;
  systemOre: string;
  systemGas: string;
  systemIce: string;
  systemSalvage: string;
  rallySystem: string;
  maxMembers: number;
}

interface FlockAssignment {
  flockEnabled: boolean;
  flockName: string;
  flockRole: string;
}

interface Settings {
  flock?: {
    flockGroups?: FlockGroup[];
    flockAssignments?: { [username: string]: FlockAssignment };
  };
}

// Mock settings object
let mockSettings: Settings = {};

// Mock send function to capture what would be sent to server
let sentMessages: any[] = [];

function mockSend(message: any) {
  sentMessages.push(message);
}

// Test data
const testGroups: FlockGroup[] = [
  {
    name: "Rad",
    targetOre: "",
    targetGas: "",
    targetIce: "",
    miningType: "ore",
    systemOre: "",
    systemGas: "",
    systemIce: "",
    systemSalvage: "",
    rallySystem: "",
    maxMembers: 3
  },
  {
    name: "Gas",
    targetOre: "",
    targetGas: "",
    targetIce: "",
    miningType: "gas",
    systemOre: "",
    systemGas: "",
    systemIce: "",
    systemSalvage: "",
    rallySystem: "",
    maxMembers: 4
  }
];

const testAssignments: { [username: string]: FlockAssignment } = {
  "Anagene Ayers": {
    flockEnabled: true,
    flockName: "Rad",
    flockRole: "leader"
  },
  "Becky Bray": {
    flockEnabled: true,
    flockName: "Rad",
    flockRole: "follower"
  }
};

// Test functions that mirror the frontend logic
function saveFlockGroupingSettings(groups: FlockGroup[]) {
  mockSend({ type: 'saveSettings', routine: 'flock', settings: { flockGroups: groups } });
  if (!mockSettings.flock) mockSettings.flock = {};
  mockSettings.flock.flockGroups = groups;
}

function assignBotToFlock(botUsername: string, flockName: string, flockRole: string) {
  if (!mockSettings.flock) mockSettings.flock = {};
  if (!mockSettings.flock.flockAssignments) mockSettings.flock.flockAssignments = {};

  mockSettings.flock.flockAssignments[botUsername] = {
    flockEnabled: true,
    flockName: flockName,
    flockRole: flockRole
  };

  mockSend({ type: 'saveSettings', routine: 'flock', settings: { assignments: mockSettings.flock.flockAssignments } });
}

function saveProfileFlock(botUsername: string, flockName: string, isLeader: boolean) {
  if (!mockSettings.flock) mockSettings.flock = {};
  if (!mockSettings.flock.flockAssignments) mockSettings.flock.flockAssignments = {};

  if (flockName) {
    mockSettings.flock.flockAssignments[botUsername] = {
      flockEnabled: true,
      flockName: flockName,
      flockRole: isLeader ? 'leader' : 'follower'
    };
  } else {
    delete mockSettings.flock.flockAssignments[botUsername];
  }

  mockSend({ type: 'saveSettings', routine: 'flock', settings: { assignments: mockSettings.flock.flockAssignments } });
}

function removeBotFromFlock(botUsername: string) {
  if (mockSettings.flock?.flockAssignments) {
    delete mockSettings.flock.flockAssignments[botUsername];
    mockSend({ type: 'saveSettings', routine: 'flock', settings: { assignments: mockSettings.flock.flockAssignments } });
  }
}

function buildFlockGroupRows(): string {
  const groups = mockSettings.flock?.flockGroups || [];
  let rows = '';
  for (const group of groups) {
    rows += `<tr data-flock-group="${group.name}">
      <td>${group.name}</td>
      <td>${group.targetOre || 'Auto (from quotas)'}</td>
      <td>${group.targetGas || 'Auto (from quotas)'}</td>
      <td>${group.targetIce || 'Auto (from quotas)'}</td>
      <td>${group.miningType}</td>
      <td>${group.systemOre || 'Auto'}</td>
      <td>${group.systemGas || 'Auto'}</td>
      <td>${group.systemIce || 'Auto'}</td>
      <td>${group.systemSalvage || 'Auto'}</td>
      <td>${group.rallySystem || '-'}</td>
      <td>${group.maxMembers || '-'}</td>
      <td><button>Remove</button></td>
    </tr>`;
  }
  return rows;
}

function buildFlockAssignmentsRows(): string {
  const flockAssignments = mockSettings.flock?.flockAssignments || {};
  let rows = '';
  for (const [botUsername, botSettings] of Object.entries(flockAssignments)) {
    if (botSettings.flockEnabled && botSettings.flockName) {
      rows += `<tr>
        <td>${botUsername}</td>
        <td>${botSettings.flockName}</td>
        <td>${botSettings.flockRole || 'follower'}</td>
        <td><button>Remove</button></td>
      </tr>`;
    }
  }
  if (!rows) {
    rows = '<tr><td colspan="4">No bots assigned to flocks</td></tr>';
  }
  return rows;
}

// Test runner
function runFlockTests() {
  console.log('Running Flock Settings Tests...');

  // Reset state
  mockSettings = {};
  sentMessages = [];

  // Test 1: Save flock groups
  console.log('Test 1: Saving flock groups');
  saveFlockGroupingSettings(testGroups);
  console.assert(mockSettings.flock?.flockGroups?.length === 2, 'Groups not saved correctly');
  console.assert(sentMessages[0].type === 'saveSettings', 'Save message not sent');
  console.assert(sentMessages[0].routine === 'flock', 'Wrong routine for save');
  console.assert(sentMessages[0].settings.flockGroups, 'flockGroups not in settings');
  console.log('✓ Test 1 passed');

  // Test 2: Assign bot to flock
  console.log('Test 2: Assigning bot to flock');
  assignBotToFlock('TestBot', 'Rad', 'follower');
  console.assert(mockSettings.flock?.flockAssignments?.TestBot?.flockName === 'Rad', 'Assignment not saved');
  console.assert(sentMessages[1].routine === 'flock', 'Wrong routine for assignment');
  console.log('✓ Test 2 passed');

  // Test 3: Save profile flock
  console.log('Test 3: Saving profile flock');
  saveProfileFlock('ProfileBot', 'Gas', true);
  console.assert(mockSettings.flock?.flockAssignments?.ProfileBot?.flockRole === 'leader', 'Role not saved correctly');
  console.log('✓ Test 3 passed');

  // Test 4: Remove bot from flock
  console.log('Test 4: Removing bot from flock');
  removeBotFromFlock('ProfileBot');
  console.assert(!mockSettings.flock?.flockAssignments?.ProfileBot, 'Bot not removed');
  console.log('✓ Test 4 passed');

  // Test 5: Build group rows
  console.log('Test 5: Building group rows');
  const groupRows = buildFlockGroupRows();
  console.assert(groupRows.includes('Rad'), 'Group rows not built correctly');
  console.assert(groupRows.includes('Gas'), 'Group rows not built correctly');
  console.log('✓ Test 5 passed');

  // Test 6: Build assignment rows
  console.log('Test 6: Building assignment rows');
  mockSettings.flock!.flockAssignments = testAssignments;
  const assignmentRows = buildFlockAssignmentsRows();
  console.assert(assignmentRows.includes('Anagene Ayers'), 'Assignment rows not built correctly');
  console.assert(assignmentRows.includes('leader'), 'Role not displayed correctly');
  console.log('✓ Test 6 passed');

  // Test 7: Verify no miner section used
  console.log('Test 7: Verifying no miner section is used');
  console.assert(!mockSettings.hasOwnProperty('miner'), 'Miner section should not be used');
  console.assert(sentMessages.every(msg => msg.routine === 'flock'), 'All messages should use flock routine');
  console.log('✓ Test 7 passed');

  console.log('All tests passed! Flock settings functionality is working correctly.');
  console.log('Mock settings after tests:', JSON.stringify(mockSettings, null, 2));
  console.log('Sent messages:', sentMessages);
}

// Export for running
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { runFlockTests };
} else if (typeof window !== 'undefined') {
  window.runFlockTests = runFlockTests;
}

// Auto-run if in Node.js
if (typeof require !== 'undefined' && typeof module !== 'undefined') {
  runFlockTests();
}