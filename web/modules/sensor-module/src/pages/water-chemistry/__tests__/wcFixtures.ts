/** Systems, tanks, sources and resolved input sets as the farm API answers them. */
import type { InputSetResult, ParameterSourceAtPoint } from '@aquaculture/shared-ui';

export const SYSTEM_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
export const TANK_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
export const SENSOR_ID = '6f9619ff-8b86-4011-b42d-00cf4fc964ff';

function input(engineInput: string, value: number | null): InputSetResult['inputs'][number] {
  return {
    engineInput,
    quantity: engineInput,
    unit: 'x',
    coherenceWindow: 'SHORT',
    windowSeconds: 14_400,
    parameterConfigId: `p-${engineInput}`,
    problems: value === null ? ['NO_VALUE'] : [],
    reading: {
      parameterConfigId: `p-${engineInput}`,
      value,
      unit: 'x',
      sourceKind: value === null ? null : 'CHANNEL_PRIMARY',
      inheritedFrom: null,
      sensorId: value === null ? null : SENSOR_ID,
      channelKey: value === null ? null : engineInput,
      observedAt: value === null ? null : '2026-10-08T09:55:00.000Z',
      ageSeconds: value === null ? null : 300,
      quality: value === null ? null : 'GOOD',
      unresolved: value === null ? 'NO_SOURCE' : null,
      resolvedAt: null,
      skipped: [],
    },
  };
}

export function dosingSet(alkalinity: number | null = 120): InputSetResult {
  return {
    set: 'DOSING',
    point: { kind: 'SYSTEM', id: SYSTEM_ID },
    asOf: '2026-10-08T10:00:00.000Z',
    verdict: alkalinity === null ? 'INCOMPLETE' : 'READY',
    problems: alkalinity === null ? ['INPUTS_INCOMPLETE'] : [],
    systemType: 'RAS',
    volumeM3: 80,
    tankWaterM3: 40,
    inputs: [
      input('pH', 7.3),
      input('alkalinityMg', alkalinity),
      input('tempC', 13),
      input('salinity', 30),
      input('caMgL', 390),
    ],
  };
}

export function toxicitySet(): InputSetResult {
  return {
    set: 'TOXICITY',
    point: { kind: 'TANK', id: TANK_ID },
    asOf: '2026-10-08T10:00:00.000Z',
    verdict: 'READY',
    problems: [],
    systemType: null,
    volumeM3: null,
    tankWaterM3: null,
    inputs: [
      input('pH', 7.1),
      input('tempC', 13.5),
      input('salinity', 30),
      input('tan', 0.6),
      input('h2sUgL', 1.5),
    ],
  };
}

export function phSource(
  problems: ParameterSourceAtPoint['problems'] = [],
): ParameterSourceAtPoint {
  return {
    source: {
      id: 'source-ph',
      parameterConfigId: 'p-ph',
      siteId: null,
      systemId: null,
      tankId: TANK_ID,
      equipmentId: null,
      position: 'REPRESENTATIVE',
      depthM: null,
      sensorId: SENSOR_ID,
      channelKey: 'ph',
      priority: 'PRIMARY',
      boundAt: '2026-10-08T08:00:00.000Z',
      isActive: true,
      parameterConfig: {
        id: 'p-ph',
        code: 'ph',
        name: 'pH',
        unit: 'pH',
        precision: 2,
        chartColor: '#0ea5e9',
        quantity: 'ph',
      },
    },
    channel: {
      sensorId: SENSOR_ID,
      channelKey: 'ph',
      presence: 'FOUND',
      sensorActive: true,
      enabled: true,
      quantity: 'ph',
      unit: 'pH',
      latestValue: 7.12,
      latestAt: '2026-10-08T09:55:00.000Z',
      latestQuality: 'GOOD',
      calibrationDueAt: null,
    },
    problems,
    // The newest sample in the parameter's unit (the backend converts it).
    latestValue: 7.12,
    unit: 'pH',
  };
}

/** A query answer as usePointInputSets gives it. */
export function answer(data: InputSetResult | undefined, error: Error | null = null) {
  return { data, error, isRefetchError: false };
}

/** A second source on the same sensor (temperature), to show one series request per sensor. */
export function temperatureSource(): ParameterSourceAtPoint {
  const ph = phSource();
  return {
    ...ph,
    source: {
      ...ph.source,
      id: 'source-temp',
      parameterConfigId: 'p-temp',
      channelKey: 'temperature',
      parameterConfig: {
        ...ph.source.parameterConfig,
        id: 'p-temp',
        code: 'temperature',
        name: 'Temperature',
        unit: '°C',
        precision: 1,
      },
    },
    channel:
      ph.channel === null
        ? null
        : { ...ph.channel, channelKey: 'temperature', unit: '°F', latestValue: 55.4 },
    latestValue: 13,
    unit: '°C',
  };
}
