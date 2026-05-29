// tests/hunter.test.ts
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the dependencies
vi.mock('../src/routines/common', () => ({
  readSettings: vi.fn(),
}));

import { getHunterSettings } from '../src/routines/hunter';
import { readSettings } from '../src/routines/common';

describe('Hunter Settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  test('getHunterSettings returns default values when no settings exist', () => {
    (readSettings as any).mockReturnValue({});

    const settings = getHunterSettings();

    expect(settings.disableWreckSalvaging).toBe(false);
    expect(settings.disableScanCommandForPirates).toBe(false);
    expect(settings.onlyNPCs).toBe(true);
    expect(settings.refuelThreshold).toBe(40);
    expect(settings.repairThreshold).toBe(30);
    expect(settings.fleeThreshold).toBe(20);
  });

  test('getHunterSettings reads disableWreckSalvaging from settings', () => {
    (readSettings as any).mockReturnValue({
      hunter: { disableWreckSalvaging: true }
    });

    const settings = getHunterSettings();

    expect(settings.disableWreckSalvaging).toBe(true);
  });

  test('getHunterSettings reads disableScanCommandForPirates from settings', () => {
    (readSettings as any).mockReturnValue({
      hunter: { disableScanCommandForPirates: true }
    });

    const settings = getHunterSettings();

    expect(settings.disableScanCommandForPirates).toBe(true);
  });

  test('getHunterSettings prioritizes bot overrides', () => {
    (readSettings as any).mockReturnValue({
      hunter: { disableWreckSalvaging: false },
      testbot: { disableWreckSalvaging: true }
    });

    const settings = getHunterSettings('testbot');

    expect(settings.disableWreckSalvaging).toBe(true);
  });
});