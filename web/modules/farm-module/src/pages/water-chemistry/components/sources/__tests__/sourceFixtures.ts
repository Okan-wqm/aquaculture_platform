/** Parameters, sources and an input set as the API answers them, for the Sources specs. */
export const TANK_ID = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';
export const SENSOR_ID = '6f9619ff-8b86-4011-b42d-00cf4fc964ff';

export function parameterConfig(id: string, code: string, name: string, quantity: string | null) {
  return {
    id,
    code,
    name,
    unit: code === 'ph' ? 'pH' : 'mg/L',
    quantity,
    dataType: 'NUMBER',
    precision: 2,
    group: 'BASIC',
    optimalMin: null,
    optimalMax: null,
    warningMin: null,
    warningMax: null,
    criticalMin: null,
    criticalMax: null,
    speciesLimits: null,
    enumValues: null,
    chartColor: '#0ea5e9',
    icon: null,
    displayOrder: 1,
    isVisible: true,
    isRequired: false,
    isActive: true,
    chartAxisGroup: 'left',
    isQuickAccess: false,
    templateSource: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
}

export function channelSource(
  id: string,
  parameter: { id: string; code: string; name: string },
  channelKey: string,
  priority: 'PRIMARY' | 'BACKUP',
) {
  return {
    id,
    parameterConfigId: parameter.id,
    siteId: null,
    systemId: null,
    tankId: TANK_ID,
    equipmentId: null,
    position: 'REPRESENTATIVE',
    depthM: null,
    sensorId: SENSOR_ID,
    channelKey,
    priority,
    boundAt: '2026-10-08T08:00:00.000Z',
    isActive: true,
  };
}

export function sourceAtPoint(
  row: ReturnType<typeof channelSource>,
  parameter: { id: string; code: string; name: string },
  latestValue: number,
  problems: string[] = [],
) {
  return {
    source: {
      ...row,
      parameterConfig: {
        id: parameter.id,
        code: parameter.code,
        name: parameter.name,
        unit: 'mg/L',
        precision: 2,
        chartColor: '#0ea5e9',
        quantity: 'tan',
      },
    },
    channel: {
      sensorId: SENSOR_ID,
      channelKey: row.channelKey,
      presence: 'FOUND',
      sensorActive: true,
      enabled: problems.includes('CHANNEL_DISABLED') ? false : true,
      quantity: 'tan',
      unit: 'mg/L',
      latestValue,
      latestAt: '2026-10-08T09:55:00.000Z',
      latestQuality: 'GOOD',
      calibrationDueAt: null,
    },
    problems,
  };
}
