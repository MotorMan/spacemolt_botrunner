import { describe, it, expect } from 'vitest';
import { detectCustomsMessage, isCustomsShip, isEmpireSystem } from '../src/customs';

describe('detectCustomsMessage', () => {
  it('detects stop_request messages', () => {
    const messages = [
      "Please wait.",
      "Hold contents here.",
      "Customs I - scanning in progress.",
    ];

    messages.forEach(msg => {
      const result = detectCustomsMessage(msg);
      expect(result.type).toBe('stop_request');
      expect(result.matchedKeywords.length).toBeGreaterThan(0);
    });
  });

  it('detects cleared messages', () => {
    const messages = [
      "Scan complete. Becky Bray, your cargo is compliant. You are cleared to proceed. Safe travels.",
      "Cargo verification complete - you may proceed.",
      "Inspection concluded. Free to continue.",
      "All clear. Carry on.",
      "Cargo is collective-compliant. Safe travels.",
    ];

    messages.forEach(msg => {
      const result = detectCustomsMessage(msg);
      expect(result.type).toBe('cleared');
      expect(result.matchedKeywords.length).toBeGreaterThan(0);
    });
  });

  it('detects contraband messages', () => {
    const messages = [
      "Found contraband in your cargo. Penalty imposed.",
      "Illegal goods detected. Cargo seized.",
      "Violation detected - you are in possession of contraband.",
    ];

    messages.forEach(msg => {
      const result = detectCustomsMessage(msg);
      expect(result.type).toBe('contraband');
      expect(result.matchedKeywords.length).toBeGreaterThan(0);
    });
  });

  it('detects evasion messages', () => {
    const messages = [
      "Noted and logged - declined to remain stationary.",
      "Evasion detected and logged.",
    ];

    messages.forEach(msg => {
      const result = detectCustomsMessage(msg);
      expect(result.type).toBe('evasion_warning');
      expect(result.matchedKeywords.length).toBeGreaterThan(0);
    });
  });

  it('returns none for non-customs messages', () => {
    const messages = [
      "Welcome to the system.",
      "Trade completed successfully.",
      "Hello there!",
    ];

    messages.forEach(msg => {
      const result = detectCustomsMessage(msg);
      expect(result.type).toBe('none');
      expect(result.matchedKeywords.length).toBe(0);
    });
  });
});

describe('isCustomsShip', () => {
  it('identifies customs ships', () => {
    const shipNames = [
      "Confederacy Customs I",
      "Police Enforcement Unit",
      "Customs Patrol",
      "Solarian Customs",
    ];

    shipNames.forEach(name => {
      expect(isCustomsShip(name)).toBe(true);
    });
  });

  it('rejects non-customs ships', () => {
    const shipNames = [
      "Trader Vessel",
      "Mining Ship",
      "Passenger Liner",
      "Pirate Raider",
    ];

    shipNames.forEach(name => {
      expect(isCustomsShip(name)).toBe(false);
    });
  });
});



describe('isEmpireSystem', () => {
  it('identifies empire systems with customs', () => {
    const systems = [
      { systemId: 'nova_terra', botEmpire: 'solarian' },
      { systemId: 'crimson_system', botEmpire: 'crimson' },
      { systemId: 'nebula_space', botEmpire: 'nebula' },
      { systemId: 'voidborn_sector', botEmpire: 'voidborn' },
      { systemId: 'collective_system', botEmpire: 'collective' },
    ];

    systems.forEach(({ systemId, botEmpire }) => {
      expect(isEmpireSystem(systemId, botEmpire)).toBe(true);
    });
  });

  it('rejects non-empire systems', () => {
    const systems = [
      { systemId: 'outer_rim', botEmpire: 'frontier' },
      { systemId: 'lawless_zone', botEmpire: 'solarian', securityLevel: 'lawless' },
      { systemId: 'alhena', botEmpire: 'crimson' },
    ];

    expect(isEmpireSystem(systems[0].systemId, systems[0].botEmpire)).toBe(false);
    expect(isEmpireSystem(systems[1].systemId, systems[1].botEmpire, systems[1].securityLevel)).toBe(false);
    expect(isEmpireSystem(systems[2].systemId, systems[2].botEmpire)).toBe(false);
  });
});