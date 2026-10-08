/** Resolved input sets as the API answers them, for the adapter and tile specs. */
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
  overrides: Partial<InputStatusResult> = {},
): InputStatusResult {
  return {
    engineInput,
    quantity: engineInput,
    unit: 'x',
    coherenceWindow: 'SHORT',
    windowSeconds: 14_400,
    parameterConfigId: 'param',
    problems: value === null ? ['NO_VALUE'] : [],
    reading: reading(value),
    ...overrides,
  };
}

export function dosingSet(
  values: {
    pH: number | null;
    alkalinityMg: number | null;
    tempC: number | null;
    salinity: number | null;
    caMgL: number | null;
  },
  volumeM3: number | null,
): InputSetResult {
  return {
    set: 'DOSING',
    point: { kind: 'SYSTEM', id: 'system-1' },
    asOf: '2026-10-08T10:01:00.000Z',
    verdict: 'READY',
    problems: [],
    systemType: 'RAS',
    volumeM3,
    tankWaterM3: 10,
    inputs: Object.entries(values).map(([field, value]) => input(field, value)),
  };
}

export function toxicitySet(values: {
  pH: number | null;
  tempC: number | null;
  salinity: number | null;
  tan: number | null;
  h2sUgL: number | null;
}): InputSetResult {
  return {
    set: 'TOXICITY',
    point: { kind: 'TANK', id: 'tank-1' },
    asOf: '2026-10-08T10:01:00.000Z',
    verdict: 'READY',
    problems: [],
    systemType: null,
    volumeM3: null,
    tankWaterM3: null,
    inputs: Object.entries(values).map(([field, value]) => input(field, value)),
  };
}
