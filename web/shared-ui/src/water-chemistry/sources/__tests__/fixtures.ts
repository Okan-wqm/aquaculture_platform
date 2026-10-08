/**
 * Resolved input sets in the backend's real shape (water-chemistry-input-set.ts):
 * a flagged input KEEPS its value (NOT_SAME_SAMPLE, NOT_AT_SAME_POINT), and a
 * REFUSED dosing set still carries the loop's volume.
 */
import type {
  WaterChemistryInputProblem,
  WaterChemistrySetProblem,
  WaterChemistryVerdict,
} from '../../../generated/graphql-types';
import type { InputSetResult, InputStatusResult, ReadingResult } from '../operations';

export function reading(
  value: number | null,
  overrides: Partial<ReadingResult> = {},
): ReadingResult {
  return {
    parameterConfigId: 'param',
    value,
    unit: 'x',
    sourceKind: value === null ? null : 'CHANNEL_PRIMARY',
    inheritedFrom: null,
    sensorId: value === null ? null : 'sensor-1',
    channelKey: value === null ? null : 'key',
    observedAt: value === null ? null : '2026-10-08T10:00:00.000Z',
    ageSeconds: value === null ? null : 60,
    quality: value === null ? null : 'GOOD',
    unresolved: value === null ? 'NO_SOURCE' : null,
    resolvedAt: null,
    skipped: [],
    ...overrides,
  };
}

export function input(
  engineInput: string,
  value: number | null,
  problems: readonly WaterChemistryInputProblem[] = value === null ? ['NO_VALUE'] : [],
): InputStatusResult {
  return {
    engineInput,
    quantity: engineInput,
    unit: 'x',
    coherenceWindow: 'SHORT',
    windowSeconds: 14_400,
    parameterConfigId: 'param',
    problems: [...problems],
    reading: reading(value),
  };
}

export function dosingSet(
  inputs: readonly InputStatusResult[],
  options: {
    volumeM3: number | null;
    verdict?: WaterChemistryVerdict;
    problems?: readonly WaterChemistrySetProblem[];
  },
): InputSetResult {
  return {
    set: 'DOSING',
    point: { kind: 'SYSTEM', id: 'system-1' },
    asOf: '2026-10-08T10:01:00.000Z',
    verdict: options.verdict ?? 'READY',
    problems: [...(options.problems ?? [])],
    systemType: 'RAS',
    volumeM3: options.volumeM3,
    tankWaterM3: 10,
    inputs,
  };
}

export function readyDosingInputs(): InputStatusResult[] {
  return [
    input('pH', 7.4),
    input('alkalinityMg', 120),
    input('tempC', 14),
    input('salinity', 30),
    input('caMgL', 380),
  ];
}

export function toxicitySet(inputs: readonly InputStatusResult[]): InputSetResult {
  return {
    set: 'TOXICITY',
    point: { kind: 'TANK', id: 'tank-1' },
    asOf: '2026-10-08T10:01:00.000Z',
    verdict: inputs.some((entry) => entry.problems.length > 0) ? 'INCOMPLETE' : 'READY',
    problems: inputs.some((entry) => entry.problems.length > 0) ? ['INPUTS_INCOMPLETE'] : [],
    systemType: null,
    volumeM3: null,
    tankWaterM3: null,
    inputs,
  };
}

export function readyToxicityInputs(): InputStatusResult[] {
  return [
    input('pH', 6.9),
    input('tempC', 15),
    input('salinity', 31),
    input('tan', 0.8),
    input('h2sUgL', 2),
  ];
}
