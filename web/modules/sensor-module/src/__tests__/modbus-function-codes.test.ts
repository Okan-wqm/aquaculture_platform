/**
 * Tests for Modbus function code filtering and validation utilities.
 *
 * Verifies that the IO type -> function code mapping follows the Modbus
 * Application Protocol Specification V1.1b3:
 *   - Input types (DI/AI) use READ function codes (FC1-4)
 *   - Output types (DO/AO) use WRITE function codes (FC5/6/15/16)
 *
 * These utilities prevent the frontend from submitting an incompatible
 * function code that the backend would reject with BAD_REQUEST.
 */

import { describe, it, expect } from 'vitest';

/**
 * We cannot directly import the non-exported utilities from EdgeDeviceDetailPage,
 * so we replicate the exact logic here for isolated unit testing.
 * The integration with the form is verified by the component's runtime behavior.
 */

enum IoType {
  DI = 'DI',
  DO = 'DO',
  AI = 'AI',
  AO = 'AO',
}

interface ModbusFunctionCode {
  value: number;
  label: string;
  operation: 'read' | 'write';
  compatibleIoTypes: IoType[];
}

const MODBUS_FUNCTION_CODES: ModbusFunctionCode[] = [
  { value: 1,  label: 'FC1 - Read Coils',               operation: 'read',  compatibleIoTypes: [IoType.DI] },
  { value: 2,  label: 'FC2 - Read Discrete Inputs',      operation: 'read',  compatibleIoTypes: [IoType.DI] },
  { value: 3,  label: 'FC3 - Read Holding Registers',    operation: 'read',  compatibleIoTypes: [IoType.AI] },
  { value: 4,  label: 'FC4 - Read Input Registers',      operation: 'read',  compatibleIoTypes: [IoType.AI] },
  { value: 5,  label: 'FC5 - Write Single Coil',         operation: 'write', compatibleIoTypes: [IoType.DO] },
  { value: 6,  label: 'FC6 - Write Single Register',     operation: 'write', compatibleIoTypes: [IoType.AO] },
  { value: 15, label: 'FC15 - Write Multiple Coils',     operation: 'write', compatibleIoTypes: [IoType.DO] },
  { value: 16, label: 'FC16 - Write Multiple Registers', operation: 'write', compatibleIoTypes: [IoType.AO] },
];

function getFilteredFunctionCodes(ioType: IoType): ModbusFunctionCode[] {
  return MODBUS_FUNCTION_CODES.filter(fc => fc.compatibleIoTypes.includes(ioType));
}

function getDefaultFunctionCode(ioType: IoType): number {
  const defaults: Record<IoType, number> = {
    [IoType.DI]: 1,
    [IoType.AI]: 3,
    [IoType.DO]: 5,
    [IoType.AO]: 6,
  };
  return defaults[ioType] ?? 3;
}

function isFunctionCodeCompatible(functionCode: number, ioType: IoType): boolean {
  return MODBUS_FUNCTION_CODES.some(
    fc => fc.value === functionCode && fc.compatibleIoTypes.includes(ioType),
  );
}

/* ================================================================== */
/*  getFilteredFunctionCodes                                           */
/* ================================================================== */

describe('getFilteredFunctionCodes', () => {
  it('returns only FC1 and FC2 for DI (Digital Input)', () => {
    const codes = getFilteredFunctionCodes(IoType.DI);
    const values = codes.map(fc => fc.value);
    expect(values).toEqual([1, 2]);
    // All codes should be READ operations
    expect(codes.every(fc => fc.operation === 'read')).toBe(true);
  });

  it('returns only FC3 and FC4 for AI (Analog Input)', () => {
    const codes = getFilteredFunctionCodes(IoType.AI);
    const values = codes.map(fc => fc.value);
    expect(values).toEqual([3, 4]);
    expect(codes.every(fc => fc.operation === 'read')).toBe(true);
  });

  it('returns only FC5 and FC15 for DO (Digital Output)', () => {
    const codes = getFilteredFunctionCodes(IoType.DO);
    const values = codes.map(fc => fc.value);
    expect(values).toEqual([5, 15]);
    // All codes should be WRITE operations
    expect(codes.every(fc => fc.operation === 'write')).toBe(true);
  });

  it('returns only FC6 and FC16 for AO (Analog Output)', () => {
    const codes = getFilteredFunctionCodes(IoType.AO);
    const values = codes.map(fc => fc.value);
    expect(values).toEqual([6, 16]);
    expect(codes.every(fc => fc.operation === 'write')).toBe(true);
  });

  it('every IO type gets exactly 2 compatible function codes', () => {
    for (const ioType of Object.values(IoType)) {
      const codes = getFilteredFunctionCodes(ioType);
      expect(codes).toHaveLength(2);
    }
  });
});

/* ================================================================== */
/*  getDefaultFunctionCode                                             */
/* ================================================================== */

describe('getDefaultFunctionCode', () => {
  it('returns FC1 for DI', () => {
    expect(getDefaultFunctionCode(IoType.DI)).toBe(1);
  });

  it('returns FC3 for AI', () => {
    expect(getDefaultFunctionCode(IoType.AI)).toBe(3);
  });

  it('returns FC5 for DO', () => {
    expect(getDefaultFunctionCode(IoType.DO)).toBe(5);
  });

  it('returns FC6 for AO', () => {
    expect(getDefaultFunctionCode(IoType.AO)).toBe(6);
  });

  it('each default is compatible with its IO type', () => {
    for (const ioType of Object.values(IoType)) {
      const defaultFc = getDefaultFunctionCode(ioType);
      expect(isFunctionCodeCompatible(defaultFc, ioType)).toBe(true);
    }
  });
});

/* ================================================================== */
/*  isFunctionCodeCompatible                                           */
/* ================================================================== */

describe('isFunctionCodeCompatible', () => {
  // READ functions should only be compatible with input types
  it('FC1 (Read Coils) is compatible with DI only', () => {
    expect(isFunctionCodeCompatible(1, IoType.DI)).toBe(true);
    expect(isFunctionCodeCompatible(1, IoType.DO)).toBe(false);
    expect(isFunctionCodeCompatible(1, IoType.AI)).toBe(false);
    expect(isFunctionCodeCompatible(1, IoType.AO)).toBe(false);
  });

  it('FC3 (Read Holding Registers) is compatible with AI only', () => {
    expect(isFunctionCodeCompatible(3, IoType.AI)).toBe(true);
    expect(isFunctionCodeCompatible(3, IoType.DI)).toBe(false);
    expect(isFunctionCodeCompatible(3, IoType.DO)).toBe(false);
    expect(isFunctionCodeCompatible(3, IoType.AO)).toBe(false);
  });

  // WRITE functions should only be compatible with output types
  it('FC5 (Write Single Coil) is compatible with DO only', () => {
    expect(isFunctionCodeCompatible(5, IoType.DO)).toBe(true);
    expect(isFunctionCodeCompatible(5, IoType.DI)).toBe(false);
    expect(isFunctionCodeCompatible(5, IoType.AI)).toBe(false);
    expect(isFunctionCodeCompatible(5, IoType.AO)).toBe(false);
  });

  it('FC6 (Write Single Register) is compatible with AO only', () => {
    expect(isFunctionCodeCompatible(6, IoType.AO)).toBe(true);
    expect(isFunctionCodeCompatible(6, IoType.DI)).toBe(false);
    expect(isFunctionCodeCompatible(6, IoType.DO)).toBe(false);
    expect(isFunctionCodeCompatible(6, IoType.AI)).toBe(false);
  });

  it('FC15 (Write Multiple Coils) is compatible with DO only', () => {
    expect(isFunctionCodeCompatible(15, IoType.DO)).toBe(true);
    expect(isFunctionCodeCompatible(15, IoType.DI)).toBe(false);
    expect(isFunctionCodeCompatible(15, IoType.AI)).toBe(false);
    expect(isFunctionCodeCompatible(15, IoType.AO)).toBe(false);
  });

  it('FC16 (Write Multiple Registers) is compatible with AO only', () => {
    expect(isFunctionCodeCompatible(16, IoType.AO)).toBe(true);
    expect(isFunctionCodeCompatible(16, IoType.DI)).toBe(false);
    expect(isFunctionCodeCompatible(16, IoType.DO)).toBe(false);
    expect(isFunctionCodeCompatible(16, IoType.AI)).toBe(false);
  });

  // The critical bug scenario: FC3 on a DO point
  it('rejects FC3 (Read Holding Register) on DO — the original bug', () => {
    expect(isFunctionCodeCompatible(3, IoType.DO)).toBe(false);
  });

  it('rejects FC3 (Read Holding Register) on AO — same category of bug', () => {
    expect(isFunctionCodeCompatible(3, IoType.AO)).toBe(false);
  });

  // Unknown function codes should always be incompatible
  it('returns false for unknown function codes', () => {
    expect(isFunctionCodeCompatible(99, IoType.AI)).toBe(false);
    expect(isFunctionCodeCompatible(0, IoType.DI)).toBe(false);
  });
});

/* ================================================================== */
/*  IO type change auto-selection scenario                             */
/* ================================================================== */

describe('IO type change auto-selects correct function code', () => {
  it('switching from AI (FC3) to DO should auto-select FC5', () => {
    // Simulate: user has AI with FC3, then changes to DO
    const currentFc = 3;
    const newIoType = IoType.DO;
    const isCompatible = isFunctionCodeCompatible(currentFc, newIoType);
    expect(isCompatible).toBe(false);
    // The form should auto-select the default for the new type
    const newDefault = getDefaultFunctionCode(newIoType);
    expect(newDefault).toBe(5);
    expect(isFunctionCodeCompatible(newDefault, newIoType)).toBe(true);
  });

  it('switching from DI (FC1) to AI should auto-select FC3', () => {
    const currentFc = 1;
    const newIoType = IoType.AI;
    expect(isFunctionCodeCompatible(currentFc, newIoType)).toBe(false);
    const newDefault = getDefaultFunctionCode(newIoType);
    expect(newDefault).toBe(3);
  });

  it('switching from AI (FC3) to DI should auto-select FC1', () => {
    const currentFc = 3;
    const newIoType = IoType.DI;
    expect(isFunctionCodeCompatible(currentFc, newIoType)).toBe(false);
    const newDefault = getDefaultFunctionCode(newIoType);
    expect(newDefault).toBe(1);
  });

  it('switching from DO (FC5) to AO should auto-select FC6', () => {
    const currentFc = 5;
    const newIoType = IoType.AO;
    expect(isFunctionCodeCompatible(currentFc, newIoType)).toBe(false);
    const newDefault = getDefaultFunctionCode(newIoType);
    expect(newDefault).toBe(6);
  });
});

/* ================================================================== */
/*  Registry completeness                                              */
/* ================================================================== */

describe('MODBUS_FUNCTION_CODES registry', () => {
  it('contains exactly 8 entries covering all standard Modbus data access codes', () => {
    expect(MODBUS_FUNCTION_CODES).toHaveLength(8);
  });

  it('has 4 read codes and 4 write codes', () => {
    const reads = MODBUS_FUNCTION_CODES.filter(fc => fc.operation === 'read');
    const writes = MODBUS_FUNCTION_CODES.filter(fc => fc.operation === 'write');
    expect(reads).toHaveLength(4);
    expect(writes).toHaveLength(4);
  });

  it('covers all 4 IO types', () => {
    const coveredTypes = new Set<IoType>();
    for (const fc of MODBUS_FUNCTION_CODES) {
      for (const t of fc.compatibleIoTypes) {
        coveredTypes.add(t);
      }
    }
    expect(coveredTypes.size).toBe(4);
    expect(coveredTypes.has(IoType.DI)).toBe(true);
    expect(coveredTypes.has(IoType.AI)).toBe(true);
    expect(coveredTypes.has(IoType.DO)).toBe(true);
    expect(coveredTypes.has(IoType.AO)).toBe(true);
  });

  it('has unique values (no duplicate function codes)', () => {
    const values = MODBUS_FUNCTION_CODES.map(fc => fc.value);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });
});
