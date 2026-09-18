import {
  clampListLimit,
  isoOrNull,
  toBoundedList,
} from '../../../common/nats/ai-query-responder';
import { WaterQualityMeasurement } from '../../entities/water-quality-measurement.entity';
import { WaterQualityParameterConfig } from '../../entities/water-quality-parameter-config.entity';
import {
  projectCriticalWaterQuality,
  projectWaterQualityMeasurement,
  projectWaterQualityStats,
  projectWaterQualityThreshold,
} from '../projections';

const TENANT = '33333333-3333-4333-8333-333333333333';
const TANK = '11111111-1111-4111-8111-111111111111';

/** The PII ban list — none of these keys may appear anywhere in a reply. */
const BANNED_KEYS = [
  'reportedBy',
  'assignedTo',
  'createdBy',
  'completedBy',
  'approvedBy',
  'verifiedBy',
  'vet',
  'vetConsultation',
  'veterinarianWorkerId',
  'externalVetName',
  'recordedBy',
  'assessedBy',
  'countedBy',
  'measuredBy',
  'userId',
  'userName',
  'notes',
  'attachments',
  'specifications',
  'checklist',
  'description',
  'beskrivelse',
];

function collectKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      collectKeys(child, into);
    }
  }
  return into;
}

/** ISO strings look like ISO strings — never Date objects, never undefined. */
function isIsoOrNull(value: unknown): boolean {
  return value === null || (typeof value === 'string' && !Number.isNaN(Date.parse(value)));
}

const FULL_MEASUREMENT = {
  id: 'm1',
  tenantId: TENANT,
  tankId: TANK,
  pondId: null,
  measuredAt: new Date('2026-09-01T06:00:00.000Z'),
  temperature: 18.4,
  dissolvedOxygen: 7.1,
  pH: 7.9,
  ammonia: 0.03,
  nitrite: null,
  overallStatus: 'critical',
  hasAlarm: true,
  measuredBy: 'operator-user-id',
  notes: 'operator note',
  sensorInfo: { sensorId: 's1' },
  parameters: { temperature: 18.4 },
  createdAt: new Date('2026-09-01T06:00:00.000Z'),
  updatedAt: new Date('2026-09-01T06:00:00.000Z'),
} as unknown as WaterQualityMeasurement;

describe('water-quality farm-AI projections (PR-3 read-only namespace)', () => {
  it('strips PII, entity metadata, and PII-bearing blobs — deep key scan', () => {
    const stats = projectWaterQualityStats(
      {
        avgTemperature: 18.5,
        avgDO: 7.2,
        avgPH: 7.8,
        avgAmmonia: 0.02,
        avgNitrite: null,
        measurementCount: 42,
        criticalCount: 1,
        warningCount: 3,
        lastMeasurement: FULL_MEASUREMENT,
      },
      30,
    );
    const critical = projectCriticalWaterQuality({
      ...FULL_MEASUREMENT,
      tank: { code: 'TNK-001', name: 'Havuz 1' },
    } as WaterQualityMeasurement);
    const history = projectWaterQualityMeasurement(FULL_MEASUREMENT);
    const thresholds = projectWaterQualityThreshold({
      id: 'c1',
      tenantId: TENANT,
      code: 'temperature',
      name: 'Temperature',
      unit: '°C',
      dataType: 'number',
      group: 'basic',
      optimalMin: 12,
      optimalMax: 18,
      warningMin: null,
      warningMax: 20,
      criticalMin: null,
      criticalMax: 24,
      speciesLimits: { [TANK]: { optimalMin: 8 } },
      isActive: true,
      isVisible: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as WaterQualityParameterConfig);

    for (const projection of [stats, critical, history, thresholds]) {
      const keys = collectKeys(projection);
      for (const banned of BANNED_KEYS) {
        expect({ banned, present: keys.has(banned) }).toEqual({ banned, present: false });
      }
      // entity metadata never crosses the AI boundary either
      expect(keys.has('tenantId')).toBe(false);
      expect(keys.has('createdAt')).toBe(false);
      expect(keys.has('updatedAt')).toBe(false);
      expect(keys.has('parameters')).toBe(false);
      expect(keys.has('sensorInfo')).toBe(false);
    }
  });

  it('serializes every date as an ISO string (or null)', () => {
    const point = projectWaterQualityMeasurement(FULL_MEASUREMENT);
    expect(point.measuredAt).toBe('2026-09-01T06:00:00.000Z');

    const stats = projectWaterQualityStats(
      {
        avgTemperature: null,
        avgDO: null,
        avgPH: null,
        avgAmmonia: null,
        avgNitrite: null,
        measurementCount: 0,
        criticalCount: 0,
        warningCount: 0,
        lastMeasurement: null,
      },
      7,
    );
    expect(stats.lastMeasurement).toBeNull();

    const critical = projectCriticalWaterQuality(FULL_MEASUREMENT);
    expect(isIsoOrNull(critical.measuredAt)).toBe(true);
  });

  it('bounds lists to MAX_LIST_LIMIT and flags truncation', () => {
    const rows: Array<{ id: string }> = Array.from({ length: 120 }, (_, i) => ({ id: `m${i}` }));
    const bounded = toBoundedList(rows, 50, (row) => ({ id: row.id }));
    expect(bounded.items).toHaveLength(50);
    expect(bounded.truncated).toBe(true);
    expect(bounded.total).toBe(120);

    // an oversized limit request is still capped at 50 by toBoundedList
    const oversized = toBoundedList(rows, 500, (row) => row);
    expect(oversized.items).toHaveLength(50);

    const exact = toBoundedList(rows.slice(0, 50), 50, (row) => row);
    expect(exact.truncated).toBe(false);
  });

  it('clampListLimit applies DEFAULT/MAX bounds', () => {
    expect(clampListLimit(undefined, 20)).toBe(20);
    expect(clampListLimit('x', 20)).toBe(20);
    expect(clampListLimit(0, 20)).toBe(1);
    expect(clampListLimit(500, 20)).toBe(50);
    expect(clampListLimit(7.5, 20)).toBe(20);
    expect(clampListLimit(30, 20)).toBe(30);
  });

  it('isoOrNull accepts Date/ISO-string and rejects junk', () => {
    expect(isoOrNull(new Date('2026-09-01T06:00:00Z'))).toBe('2026-09-01T06:00:00.000Z');
    expect(isoOrNull('2026-09-01')).toBe('2026-09-01T00:00:00.000Z');
    expect(isoOrNull(null)).toBeNull();
    expect(isoOrNull(undefined)).toBeNull();
    expect(isoOrNull(new Date('not a date'))).toBeNull();
    expect(isoOrNull('junk')).toBeNull();
  });

  it('species threshold override wins over the global band when present', () => {
    const config = {
      code: 'temperature',
      optimalMin: 12,
      optimalMax: 18,
      speciesLimits: { [TANK]: { optimalMin: 8, optimalMax: 14 } },
    } as unknown as WaterQualityParameterConfig;

    const speciesView = projectWaterQualityThreshold(config, TANK);
    expect(speciesView.optimalMin).toBe(8);
    expect(speciesView.optimalMax).toBe(14);

    const globalView = projectWaterQualityThreshold(config);
    expect(globalView.optimalMin).toBe(12);
    expect(globalView.optimalMax).toBe(18);
  });
});
