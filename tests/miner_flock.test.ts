// tests/miner_flock.test.ts
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fs functions
vi.mock('fs', () => ({
  promises: {
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
  },
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

// Mock path
vi.mock('path', () => ({
  join: vi.fn(),
  dirname: vi.fn(),
}));

// Mock path
jest.mock('path', () => ({
  join: jest.fn(),
  dirname: jest.fn(),
}));

// Mock the miner module to avoid importing botmanager
vi.mock('../src/routines/miner', () => ({
  readFlockState: vi.fn(),
  writeFlockState: vi.fn(),
  registerFlockMember: vi.fn(),
  unregisterFlockMember: vi.fn(),
  announceFlockTarget: vi.fn(),
  updateFlockPhase: vi.fn(),
  clearFlockState: vi.fn(),
  getFlockStatePath: vi.fn(),
}));

import {
  readFlockState,
  writeFlockState,
  registerFlockMember,
  unregisterFlockMember,
  announceFlockTarget,
  updateFlockPhase,
  clearFlockState,
  getFlockStatePath,
} from '../src/routines/miner';

describe('Flock Mining Coordination', () => {
  const mockFlockName = 'test_flock';
  const mockPath = '/data/flock_signals/test_flock.json';

  beforeEach(() => {
    vi.clearAllMocks();
    (join as any).mockReturnValue(mockPath);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('getFlockStatePath', () => {
    test('returns correct path for flock name', () => {
      const result = getFlockStatePath(mockFlockName);
      expect(join).toHaveBeenCalledWith(process.cwd(), 'data', 'flock_signals', `${mockFlockName}.json`);
      expect(result).toBe(mockPath);
    });
  });

  describe('readFlockState', () => {
    test('returns null when file does not exist', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);

      const result = await readFlockState(mockFlockName);

      expect(result).toBeNull();
    });

    test('returns null when state is stale', async () => {
      const staleState = {
        leader: 'bot1',
        members: ['bot1'],
        lastUpdate: Date.now() - 70_000, // 70 seconds ago
      };

      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify(staleState));

      const result = await readFlockState(mockFlockName);

      expect(result).toBeNull();
    });

    test('returns valid state when fresh', async () => {
      const validState = {
        leader: 'bot1',
        members: ['bot1'],
        targetSystemId: 'sol',
        lastUpdate: Date.now(),
      };

      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify(validState));

      const result = await readFlockState(mockFlockName);

      expect(result).toEqual(validState);
    });
  });

  describe('writeFlockState', () => {
    test('writes state to file', async () => {
      const state = {
        leader: 'bot1',
        members: ['bot1'],
        targetSystemId: 'sol',
      };

      await writeFlockState(mockFlockName, state as any);

      expect(fs.mkdirSync).toHaveBeenCalledWith(join(process.cwd(), 'data', 'flock_signals'), { recursive: true });
      expect(fs.writeFileSync).toHaveBeenCalledWith(mockPath, JSON.stringify({ ...state, lastUpdate: expect.any(Number) }, null, 2));
    });
  });

  describe('registerFlockMember', () => {
    test('creates new flock as leader', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);

      const result = await registerFlockMember(mockFlockName, 'bot1', true);

      expect(result).toEqual({
        leader: 'bot1',
        targetSystemId: '',
        targetPoiId: '',
        targetPoiName: '',
        targetResourceId: '',
        miningType: 'ore',
        phase: 'gathering',
        members: ['bot1'],
        lastUpdate: expect.any(Number),
      });
    });

    test('joins existing flock as follower', async () => {
      const existingState = {
        leader: 'bot1',
        members: ['bot1'],
        targetSystemId: 'sol',
        lastUpdate: Date.now(),
      };

      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify(existingState));

      const result = await registerFlockMember(mockFlockName, 'bot2', false);

      expect(result?.members).toContain('bot2');
    });

    test('returns null when trying to join non-existent flock', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);

      const result = await registerFlockMember(mockFlockName, 'bot2', false);

      expect(result).toBeNull();
    });
  });

  describe('unregisterFlockMember', () => {
    test('removes member from flock', async () => {
      const existingState = {
        leader: 'bot1',
        members: ['bot1', 'bot2'],
        targetSystemId: 'sol',
        lastUpdate: Date.now(),
      };

      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify(existingState));

      await unregisterFlockMember(mockFlockName, 'bot2');

      expect(fs.writeFileSync).toHaveBeenCalledWith(mockPath, expect.stringContaining('"members":["bot1"]'));
    });

    test('elects new leader when leader leaves', async () => {
      const existingState = {
        leader: 'bot1',
        members: ['bot1', 'bot2'],
        targetSystemId: 'sol',
        lastUpdate: Date.now(),
      };

      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify(existingState));

      await unregisterFlockMember(mockFlockName, 'bot1');

      const writtenData = JSON.parse((fs.writeFileSync as jest.Mock).mock.calls[0][1]);
      expect(writtenData.leader).toBe('bot2');
    });

    test('clears flock when last member leaves', async () => {
      const existingState = {
        leader: 'bot1',
        members: ['bot1'],
        targetSystemId: 'sol',
        lastUpdate: Date.now(),
      };

      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify(existingState));

      await unregisterFlockMember(mockFlockName, 'bot1');

      expect(fs.unlinkSync).toHaveBeenCalledWith(mockPath);
    });
  });

  describe('announceFlockTarget', () => {
    test('announces target to flock', async () => {
      const existingState = {
        leader: 'bot1',
        members: ['bot1', 'bot2'],
        targetSystemId: '',
        phase: 'gathering',
        lastUpdate: Date.now(),
      };

      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify(existingState));

      await announceFlockTarget(
        mockFlockName,
        'bot1',
        'sol',
        'sol_central',
        'Sol Central',
        'iron_ore',
        'ore'
      );

      const writtenData = JSON.parse((fs.writeFileSync as jest.Mock).mock.calls[0][1]);
      expect(writtenData.targetSystemId).toBe('sol');
      expect(writtenData.targetPoiId).toBe('sol_central');
      expect(writtenData.targetResourceId).toBe('iron_ore');
      expect(writtenData.miningType).toBe('ore');
    });
  });

  describe('updateFlockPhase', () => {
    test('updates flock phase', async () => {
      const existingState = {
        leader: 'bot1',
        members: ['bot1'],
        phase: 'gathering',
        lastUpdate: Date.now(),
      };

      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify(existingState));

      await updateFlockPhase(mockFlockName, 'mining');

      const writtenData = JSON.parse((fs.writeFileSync as jest.Mock).mock.calls[0][1]);
      expect(writtenData.phase).toBe('mining');
    });
  });

  describe('clearFlockState', () => {
    test('removes flock state file', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);

      await clearFlockState(mockFlockName);

      expect(fs.unlinkSync).toHaveBeenCalledWith(mockPath);
    });

    test('does nothing when file does not exist', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);

      await clearFlockState(mockFlockName);

      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });
  });
});