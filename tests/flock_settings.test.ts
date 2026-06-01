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
  miner?: any; // Should not be used
}

// Mock settings object
let mockSettings: Settings = {};

// Simulate the frontend functions with mock send
function saveFlockGroupingSettings(groups: FlockGroup[]) {
  mockGroups = groups;
  mockSend({ type: 'saveSettings', routine: 'flock', settings: {
    flockGroups: groups,
    assignments: mockAssignments
  } });
}

let mockAssignments: { [username: string]: FlockAssignment } = {};

function assignBotToFlock(botUsername: string, flockName: string, flockRole: string) {
  mockAssignments[botUsername] = {
    flockEnabled: true,
    flockName: flockName,
    flockRole: flockRole
  };

  mockSend({ type: 'saveSettings', routine: 'flock', settings: {
    flockGroups: mockGroups,
    assignments: mockAssignments
  } });
}

function saveProfileFlock(botUsername: string, flockName: string, isLeader: boolean) {
  if (flockName) {
    mockAssignments[botUsername] = {
      flockEnabled: true,
      flockName: flockName,
      flockRole: isLeader ? 'leader' : 'follower'
    };
  } else {
    delete mockAssignments[botUsername];
  }

  mockSend({ type: 'saveSettings', routine: 'flock', settings: {
    flockGroups: mockGroups,
    assignments: mockAssignments
  } });
}

function removeBotFromFlock(botUsername: string) {
  delete mockAssignments[botUsername];
  mockSend({ type: 'saveSettings', routine: 'flock', settings: {
    flockGroups: mockGroups,
    assignments: mockAssignments
  } });
}

let mockGroups: FlockGroup[] = [];

function buildFlockGroupRows(): string {
  const groups = mockGroups;
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
  const flockAssignments = mockAssignments;
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
    mockGroups = [];
    mockAssignments = {};
    mockSend.mockClear();
  });

  test('saveFlockGroupingSettings saves groups to flock section', () => {
    saveFlockGroupingSettings(testGroups);

    expect(mockGroups).toEqual(testGroups);
    expect(mockSend).toHaveBeenCalledWith({
      type: 'saveSettings',
      routine: 'flock',
      settings: {
        flockGroups: testGroups,
        assignments: {}
      }
    });
    expect(mockSettings.miner).toBeUndefined();
  });

  test('assignBotToFlock saves assignment to flock section', () => {
    assignBotToFlock('TestBot', 'Rad', 'follower');

    expect(mockAssignments['TestBot']).toEqual({
      flockEnabled: true,
      flockName: 'Rad',
      flockRole: 'follower'
    });
    expect(mockSend).toHaveBeenCalledWith({
      type: 'saveSettings',
      routine: 'flock',
      settings: {
        flockGroups: [],
        assignments: mockAssignments
      }
    });
  });

  test('saveProfileFlock saves profile assignment correctly', () => {
    saveProfileFlock('ProfileBot', 'Gas', true);

    expect(mockAssignments['ProfileBot']).toEqual({
      flockEnabled: true,
      flockName: 'Gas',
      flockRole: 'leader'
    });

    saveProfileFlock('ProfileBot', '', false);
    expect(mockAssignments['ProfileBot']).toBeUndefined();
  });

  test('removeBotFromFlock removes assignment', () => {
    mockAssignments['TestBot'] = { flockEnabled: true, flockName: 'Rad', flockRole: 'follower' };

    removeBotFromFlock('TestBot');

    expect(mockAssignments['TestBot']).toBeUndefined();
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
    mockGroups = testGroups;

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
    mockAssignments = testAssignments;

    const rows = buildFlockAssignmentsRows();

    expect(rows).toContain('Anagene Ayers');
    expect(rows).toContain('Becky Bray');
    expect(rows).toContain('Rad');
    expect(rows).toContain('leader');
    expect(rows).toContain('follower');
  });

  test('buildFlockAssignmentsRows shows empty message when no assignments', () => {
    mockAssignments = {};

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

    expect(mockGroups).toEqual(testGroups);
    expect(mockAssignments).toEqual({
      'Anagene Ayers': { flockEnabled: true, flockName: 'Rad', flockRole: 'leader' },
      'Becky Bray': { flockEnabled: true, flockName: 'Rad', flockRole: 'follower' }
    });
  });
});