// tests/flock_settings.test.ts
import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock the send function
const mockSend = vi.fn();

// Test interfaces matching the frontend code
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
    assignments?: { [username: string]: FlockAssignment };
  };
  miner?: any; // Should not be used
}

// Mock settings object
let mockSettings: Settings = {};

// Simulate the frontend functions with mock send
function saveFlockGroupingSettings(groups: FlockGroup[]) {
  mockSend({ type: 'saveSettings', routine: 'flock', settings: {
    flockGroups: groups,
    assignments: mockSettings.flock?.assignments || {}
  } });
  if (!mockSettings.flock) mockSettings.flock = {};
  mockSettings.flock.flockGroups = groups;
}

function assignBotToFlock(botUsername: string, flockName: string, flockRole: string) {
  if (!mockSettings.flock) mockSettings.flock = {};
  if (!mockSettings.flock.assignments) mockSettings.flock.assignments = {};

  mockSettings.flock.assignments[botUsername] = {
    flockEnabled: true,
    flockName: flockName,
    flockRole: flockRole
  };

  mockSend({ type: 'saveSettings', routine: 'flock', settings: {
    flockGroups: mockSettings.flock.flockGroups || [],
    assignments: mockSettings.flock.assignments
  } });
}

function saveProfileFlock(botUsername: string, flockName: string, isLeader: boolean) {
  if (!mockSettings.flock) mockSettings.flock = {};
  if (!mockSettings.flock.assignments) mockSettings.flock.assignments = {};

  if (flockName) {
    mockSettings.flock.assignments[botUsername] = {
      flockEnabled: true,
      flockName: flockName,
      flockRole: isLeader ? 'leader' : 'follower'
    };
  } else {
    delete mockSettings.flock.assignments[botUsername];
  }

  mockSend({ type: 'saveSettings', routine: 'flock', settings: {
    flockGroups: mockSettings.flock.flockGroups || [],
    assignments: mockSettings.flock.assignments
  } });
}

function removeBotFromFlock(botUsername: string) {
  if (mockSettings.flock?.assignments) {
    delete mockSettings.flock.assignments[botUsername];
    mockSend({ type: 'saveSettings', routine: 'flock', settings: {
      flockGroups: mockSettings.flock.flockGroups || [],
      assignments: mockSettings.flock.assignments
    } });
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
  const flockAssignments = mockSettings.flock?.assignments || {};
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

describe('Flock Settings Frontend Logic', () => {
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

  beforeEach(() => {
    mockSettings = {};
    mockSend.mockClear();
  });

  test('saveFlockGroupingSettings saves groups to flock section', () => {
    saveFlockGroupingSettings(testGroups);

    expect(mockSettings.flock?.flockGroups).toEqual(testGroups);
    expect(mockSend).toHaveBeenCalledWith({
      type: 'saveSettings',
      routine: 'flock',
      settings: {
        flockGroups: testGroups,
        assignments: {}
      }
    });
    expect(mockSettings.miner).toBeUndefined(); // Should not use miner section
  });

  test('assignBotToFlock saves assignment to flock section', () => {
    assignBotToFlock('TestBot', 'Rad', 'follower');

    expect(mockSettings.flock?.assignments?.TestBot).toEqual({
      flockEnabled: true,
      flockName: 'Rad',
      flockRole: 'follower'
    });
    expect(mockSend).toHaveBeenCalledWith({
      type: 'saveSettings',
      routine: 'flock',
      settings: {
        flockGroups: [],
        assignments: mockSettings.flock?.assignments
      }
    });
  });

  test('saveProfileFlock saves profile assignment correctly', () => {
    saveProfileFlock('ProfileBot', 'Gas', true);

    expect(mockSettings.flock?.assignments?.ProfileBot).toEqual({
      flockEnabled: true,
      flockName: 'Gas',
      flockRole: 'leader'
    });

    // Test removing assignment
    saveProfileFlock('ProfileBot', '', false);
    expect(mockSettings.flock?.assignments?.ProfileBot).toBeUndefined();
  });

  test('removeBotFromFlock removes assignment', () => {
    mockSettings.flock = { assignments: { 'TestBot': { flockEnabled: true, flockName: 'Rad', flockRole: 'follower' } } };

    removeBotFromFlock('TestBot');

    expect(mockSettings.flock?.assignments?.TestBot).toBeUndefined();
    expect(mockSend).toHaveBeenCalledWith({
      type: 'saveSettings',
      routine: 'flock',
      settings: {
        flockGroups: [],
        assignments: {}
      }
    });
  });

  test('buildFlockGroupRows generates correct HTML', () => {
    mockSettings.flock = { flockGroups: testGroups };

    const rows = buildFlockGroupRows();

    expect(rows).toContain('data-flock-group="Rad"');
    expect(rows).toContain('data-flock-group="Gas"');
    expect(rows).toContain('<td>Rad</td>');
    expect(rows).toContain('<td>Gas</td>');
    expect(rows).toContain('<td>ore</td>');
    expect(rows).toContain('<td>gas</td>');
    expect(rows).toContain('<td>3</td>');
    expect(rows).toContain('<td>4</td>');
  });

  test('buildFlockAssignmentsRows generates correct HTML', () => {
    mockSettings.flock = { assignments: testAssignments };

    const rows = buildFlockAssignmentsRows();

    expect(rows).toContain('Anagene Ayers');
    expect(rows).toContain('Becky Bray');
    expect(rows).toContain('Rad');
    expect(rows).toContain('leader');
    expect(rows).toContain('follower');
  });

  test('buildFlockAssignmentsRows shows empty message when no assignments', () => {
    mockSettings.flock = { assignments: {} };

    const rows = buildFlockAssignmentsRows();

    expect(rows).toContain('No bots assigned to flocks');
  });

  test('all operations use flock routine, not miner', () => {
    saveFlockGroupingSettings(testGroups);
    assignBotToFlock('TestBot', 'Rad', 'follower');
    saveProfileFlock('ProfileBot', 'Gas', true);
    removeBotFromFlock('TestBot');

    const allCalls = mockSend.mock.calls;
    expect(allCalls.every(call => call[0].routine === 'flock')).toBe(true);
    expect(allCalls.some(call => call[0].routine === 'miner')).toBe(false);
  });

  test('settings structure matches expected JSON format', () => {
    saveFlockGroupingSettings(testGroups);
    assignBotToFlock('Anagene Ayers', 'Rad', 'leader');
    assignBotToFlock('Becky Bray', 'Rad', 'follower');

    expect(mockSettings).toEqual({
      flock: {
        flockGroups: testGroups,
        assignments: {
          'Anagene Ayers': { flockEnabled: true, flockName: 'Rad', flockRole: 'leader' },
          'Becky Bray': { flockEnabled: true, flockName: 'Rad', flockRole: 'follower' }
        }
      }
    });
  });
});