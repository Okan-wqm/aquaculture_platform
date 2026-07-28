import { DataSource } from 'typeorm';

import {
  decodeSensorReadingId,
  encodeSensorReadingId,
} from '@aquaculture/backend-common/sensor';

import { SensorQueryService } from '../sensor-query.service';
import { DataQualityService } from '../data-quality.service';

/**
 * The as-of reads (getLatestReading / getReadingsInRange / getLatestReadingsForSensors
 * / reconstructAsOf) run inside runInTenantRead. Mock ONLY that export (keeping
 * the rest of backend-common/database real so the entity's DecimalTransformer
 * still loads), delegating the callback to a jest-controlled query runner.
 */
const mockQrQuery = jest.fn();
const mockRunInTenantRead = jest.fn(
  (
    _dataSource: unknown,
    _sourceSchema: string,
    _tenantId: string,
    fn: (qr: { query: jest.Mock }) => unknown,
  ) => fn({ query: mockQrQuery }),
);

jest.mock('@aquaculture/backend-common/database', () => {
  const actual = jest.requireActual('@aquaculture/backend-common/database');
  // Wrap in an arrow so mockRunInTenantRead is dereferenced at call time (during
  // a test), not when this factory runs at import time (before the const inits).
  return {
    ...actual,
    runInTenantRead: (...args: Parameters<typeof mockRunInTenantRead>) =>
      mockRunInTenantRead(...args),
  };
});

const SENSOR_ID = '11111111-1111-4111-8111-111111111111';
const SENSOR_ID_2 = '33333333-3333-4333-8333-333333333333';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';

/**
 * SENSOR-MEDIUM-066/068 (reads convergence): getAggregatedReadings aggregates
 * over the channel-keyed sensor.sensor_metrics store (+ continuous aggregates
 * for large ranges) and pivots channel_key → parameter via the event-contract
 * SSoT.
 */
type AggRow = {
  bucket: string;
  channel_key: string;
  avg_value: number | null;
  min_value: number | null;
  max_value: number | null;
  sample_count: number | null;
};

function createService(aggRows: AggRow[]): { service: SensorQueryService; query: jest.Mock } {
  const query = jest.fn((sql: string): Promise<unknown> => {
    if (sql.includes('SELECT name FROM sensors')) {
      return Promise.resolve([{ name: 'Test Sensor' }]);
    }
    return Promise.resolve(aggRows);
  });
  const dataSource: Partial<DataSource> = { query: query as DataSource['query'] };
  const service = new SensorQueryService(dataSource as DataSource, new DataQualityService());
  return { service, query };
}

/** The channel-keyed aggregation SQL (the one that carries time_bucket). */
function aggregationSql(query: jest.Mock): string {
  const call = query.mock.calls.find((c) => String(c[0]).includes('time_bucket'));
  return String(call?.[0] ?? '');
}

describe('SensorQueryService.getAggregatedReadings — metric-store convergence', () => {
  afterEach(() => jest.restoreAllMocks());

  it('pivots channel rows into parameter-keyed points (aliases resolved via the SSoT)', async () => {
    const bucket = '2026-03-14T00:00:00.000Z';
    const { service } = createService([
      { bucket, channel_key: 'temperature', avg_value: 24.5, min_value: 24, max_value: 25, sample_count: 10 },
      { bucket, channel_key: 'ph', avg_value: 7.1, min_value: 7.0, max_value: 7.2, sample_count: 10 },
      // 'do' is a device alias for dissolvedOxygen in the SSoT.
      { bucket, channel_key: 'do', avg_value: 8.2, min_value: 8, max_value: 8.5, sample_count: 10 },
    ]);

    const res = await service.getAggregatedReadings(
      SENSOR_ID,
      TENANT_ID,
      new Date('2026-03-14T00:00:00Z'),
      new Date('2026-03-14T00:30:00Z'),
    );

    expect(res.data).toHaveLength(1);
    const point = res.data[0]!;
    expect(point.avgTemperature).toBeCloseTo(24.5);
    expect(point.minTemperature).toBeCloseTo(24);
    expect(point.maxTemperature).toBeCloseTo(25);
    expect(point.avgPh).toBeCloseTo(7.1);
    expect(point.avgDissolvedOxygen).toBeCloseTo(8.2);
    expect(res.sensorName).toBe('Test Sensor');
  });

  it('skips channels outside the nine-parameter vocabulary', async () => {
    const bucket = '2026-03-14T00:00:00.000Z';
    const { service } = createService([
      { bucket, channel_key: 'flow_rate', avg_value: 12, min_value: 10, max_value: 14, sample_count: 5 },
    ]);

    const res = await service.getAggregatedReadings(
      SENSOR_ID,
      TENANT_ID,
      new Date('2026-03-14T00:00:00Z'),
      new Date('2026-03-14T00:30:00Z'),
    );

    // The only channel is out-of-vocabulary → no bucket point emitted.
    expect(res.data).toHaveLength(0);
  });

  it('merges two channels that map to the same parameter (sample-count-weighted avg)', async () => {
    const bucket = '2026-03-14T00:00:00.000Z';
    const { service } = createService([
      { bucket, channel_key: 'temperature', avg_value: 20, min_value: 18, max_value: 22, sample_count: 10 },
      { bucket, channel_key: 'temp', avg_value: 30, min_value: 28, max_value: 33, sample_count: 30 },
    ]);

    const res = await service.getAggregatedReadings(
      SENSOR_ID,
      TENANT_ID,
      new Date('2026-03-14T00:00:00Z'),
      new Date('2026-03-14T00:30:00Z'),
    );

    const point = res.data[0]!;
    // (20*10 + 30*30) / 40 = 27.5
    expect(point.avgTemperature).toBeCloseTo(27.5);
    expect(point.minTemperature).toBeCloseTo(18);
    expect(point.maxTemperature).toBeCloseTo(33);
  });

  it('does not emit min/max for avg-only parameters', async () => {
    const bucket = '2026-03-14T00:00:00.000Z';
    const { service } = createService([
      { bucket, channel_key: 'nitrite', avg_value: 0.3, min_value: 0.1, max_value: 0.5, sample_count: 4 },
    ]);

    const res = await service.getAggregatedReadings(
      SENSOR_ID,
      TENANT_ID,
      new Date('2026-03-14T00:00:00Z'),
      new Date('2026-03-14T00:30:00Z'),
    );

    const point = res.data[0]!;
    expect(point.avgNitrite).toBeCloseTo(0.3);
    // nitrite is avg-only — no min/max fields are grafted onto the point.
    expect(Object.keys(point)).not.toContain('minNitrite');
    expect(Object.keys(point)).not.toContain('maxNitrite');
  });

  it('reads the raw hypertable for a ≤1h range', async () => {
    const { service, query } = createService([]);
    await service.getAggregatedReadings(
      SENSOR_ID,
      TENANT_ID,
      new Date('2026-03-14T00:00:00Z'),
      new Date('2026-03-14T00:30:00Z'),
    );
    const sql = aggregationSql(query);
    expect(sql).toContain('sensor.sensor_metrics');
    expect(sql).toContain('AVG(s.value)');
  });

  it('reads a continuous aggregate (weighted) for a multi-day range', async () => {
    const { service, query } = createService([]);
    await service.getAggregatedReadings(
      SENSOR_ID,
      TENANT_ID,
      new Date('2026-03-01T00:00:00Z'),
      new Date('2026-03-10T00:00:00Z'),
    );
    const sql = aggregationSql(query);
    expect(sql).toContain('sensor.metrics_1hour');
    expect(sql).toContain('SUM(s.avg_value * s.sample_count)');
  });
});

/**
 * SENSOR-HIGH-085: the per-reading reads are as-of projections over
 * sensor.sensor_metrics. These pin the channel→parameter pivot, the anchor +
 * codec id, the DataQualityService-recomputed quality (D4), the modal source
 * (D5), and the tenant-pinned execution (D8).
 */
describe('SensorQueryService — as-of reading projection', () => {
  beforeEach(() => {
    mockQrQuery.mockReset();
    mockRunInTenantRead.mockClear();
  });

  function newService(): SensorQueryService {
    const dataSource: Partial<DataSource> = { query: jest.fn() };
    return new SensorQueryService(dataSource as DataSource, new DataQualityService());
  }

  describe('getLatestReading', () => {
    it('assembles the latest value per channel into one reading anchored at the newest time', async () => {
      mockQrQuery.mockResolvedValueOnce([
        {
          channel_key: 'temperature',
          value: 24.5,
          time: new Date('2026-03-14T00:05:00Z'),
          time_text: '2026-03-14 00:05:00+00',
          quality_code: 192,
          source_protocol: 'rust-sidecar',
          pond_id: 'pond-1',
          farm_id: 'farm-1',
        },
        {
          channel_key: 'ph',
          value: 7.1,
          time: new Date('2026-03-14T00:04:00Z'),
          time_text: '2026-03-14 00:04:00+00',
          quality_code: 192,
          source_protocol: 'rust-sidecar',
          pond_id: 'pond-1',
          farm_id: 'farm-1',
        },
      ]);

      const reading = await newService().getLatestReading(SENSOR_ID, TENANT_ID);

      expect(reading).not.toBeNull();
      expect(reading!.readings.temperature).toBeCloseTo(24.5);
      expect(reading!.readings.ph).toBeCloseTo(7.1);
      // Anchored at the NEWEST channel time (00:05), not 00:04.
      expect(reading!.timestamp).toEqual(new Date('2026-03-14T00:05:00Z'));
      expect(decodeSensorReadingId(reading!.id)).toEqual({
        sensorId: SENSOR_ID,
        timeText: '2026-03-14 00:05:00+00',
      });
      expect(reading!.source).toBe('rust-sidecar');
      expect(reading!.pondId).toBe('pond-1');
      expect(reading!.quality).toBe(100); // both values in range
      // Executed tenant-pinned on the sensor source schema (D8).
      expect(mockRunInTenantRead).toHaveBeenCalledWith(
        expect.anything(),
        'sensor',
        TENANT_ID,
        expect.any(Function),
      );
    });

    it('returns null when the sensor has no metric data', async () => {
      mockQrQuery.mockResolvedValueOnce([]);

      const reading = await newService().getLatestReading(SENSOR_ID, TENANT_ID);

      expect(reading).toBeNull();
    });

    it('skips out-of-vocabulary channels but keeps mapped ones', async () => {
      mockQrQuery.mockResolvedValueOnce([
        {
          channel_key: 'flow_rate', // outside the nine-parameter vocabulary
          value: 12,
          time: new Date('2026-03-14T00:06:00Z'),
          time_text: '2026-03-14 00:06:00+00',
          quality_code: 192,
          source_protocol: 'modbus',
          pond_id: null,
          farm_id: null,
        },
        {
          channel_key: 'temperature',
          value: 21,
          time: new Date('2026-03-14T00:05:00Z'),
          time_text: '2026-03-14 00:05:00+00',
          quality_code: 192,
          source_protocol: 'modbus',
          pond_id: null,
          farm_id: null,
        },
      ]);

      const reading = await newService().getLatestReading(SENSOR_ID, TENANT_ID);

      expect(reading!.readings.temperature).toBeCloseTo(21);
      expect(reading!.readings).not.toHaveProperty('flowRate');
      // Anchor is still the newest metric time regardless of vocabulary.
      expect(reading!.timestamp).toEqual(new Date('2026-03-14T00:06:00Z'));
    });
  });

  describe('getReadingsInRange', () => {
    it('groups the forward-filled rows into one reading per observation instant, newest-first', async () => {
      mockQrQuery.mockResolvedValueOnce([
        // instant 2 (newest) first — the SQL returns rows ORDER BY o.time DESC
        { as_of: new Date('2026-03-14T00:10:00Z'), as_of_text: '2026-03-14 00:10:00+00', channel_key: 'temperature', value: 25, quality_code: 192, source_protocol: 'mqtt', pond_id: 'p', farm_id: 'f' },
        { as_of: new Date('2026-03-14T00:10:00Z'), as_of_text: '2026-03-14 00:10:00+00', channel_key: 'ph', value: 7.0, quality_code: 192, source_protocol: 'mqtt', pond_id: 'p', farm_id: 'f' },
        { as_of: new Date('2026-03-14T00:05:00Z'), as_of_text: '2026-03-14 00:05:00+00', channel_key: 'temperature', value: 24, quality_code: 192, source_protocol: 'mqtt', pond_id: 'p', farm_id: 'f' },
      ]);

      const readings = await newService().getReadingsInRange(
        SENSOR_ID,
        TENANT_ID,
        new Date('2026-03-14T00:00:00Z'),
        new Date('2026-03-14T00:30:00Z'),
      );

      expect(readings).toHaveLength(2);
      expect(readings[0]!.timestamp).toEqual(new Date('2026-03-14T00:10:00Z'));
      expect(readings[0]!.readings.temperature).toBeCloseTo(25);
      expect(readings[0]!.readings.ph).toBeCloseTo(7.0);
      expect(readings[1]!.timestamp).toEqual(new Date('2026-03-14T00:05:00Z'));
      expect(readings[1]!.readings.temperature).toBeCloseTo(24);
      // Each reading's id encodes its own observation anchor.
      expect(decodeSensorReadingId(readings[0]!.id)!.timeText).toBe('2026-03-14 00:10:00+00');
    });
  });

  describe('getLatestReadingsForSensors', () => {
    it('returns one reading per sensor, each anchored at its own newest channel time', async () => {
      mockQrQuery.mockResolvedValueOnce([
        { sensor_id: SENSOR_ID, channel_key: 'temperature', value: 22, time: new Date('2026-03-14T00:08:00Z'), time_text: '2026-03-14 00:08:00+00', quality_code: 192, source_protocol: 'mqtt', pond_id: null, farm_id: null },
        { sensor_id: SENSOR_ID_2, channel_key: 'ph', value: 6.9, time: new Date('2026-03-14T00:09:00Z'), time_text: '2026-03-14 00:09:00+00', quality_code: 192, source_protocol: 'graphql', pond_id: null, farm_id: null },
      ]);

      const readings = await newService().getLatestReadingsForSensors(
        [SENSOR_ID, SENSOR_ID_2],
        TENANT_ID,
      );

      expect(readings).toHaveLength(2);
      const bySensor = new Map(readings.map((r) => [r.sensorId, r]));
      expect(bySensor.get(SENSOR_ID)!.readings.temperature).toBeCloseTo(22);
      expect(bySensor.get(SENSOR_ID_2)!.readings.ph).toBeCloseTo(6.9);
      expect(bySensor.get(SENSOR_ID_2)!.source).toBe('graphql');
    });

    it('returns [] for an empty sensor list without querying', async () => {
      const readings = await newService().getLatestReadingsForSensors([], TENANT_ID);

      expect(readings).toEqual([]);
      expect(mockRunInTenantRead).not.toHaveBeenCalled();
    });

    it('rejects a batch larger than 100 sensors', async () => {
      const many = Array.from({ length: 101 }, () => SENSOR_ID);

      await expect(
        newService().getLatestReadingsForSensors(many, TENANT_ID),
      ).rejects.toThrow('Maximum 100 sensors');
    });
  });

  describe('query shape guarantees (SENSOR-HIGH-085 audit)', () => {
    /** Run every as-of read once and collect the SQL each one emitted. */
    async function collectAsOfSql(): Promise<string[]> {
      mockQrQuery.mockResolvedValue([]);
      const service = newService();
      await service.getLatestReading(SENSOR_ID, TENANT_ID);
      await service.getLatestReadingsForSensors([SENSOR_ID], TENANT_ID);
      await service.getReadingsInRange(
        SENSOR_ID,
        TENANT_ID,
        new Date('2026-03-14T00:00:00Z'),
        new Date('2026-03-14T01:00:00Z'),
      );
      await service.reconstructAsOf(SENSOR_ID, '2026-03-14 00:07:00+00', TENANT_ID);
      return mockQrQuery.mock.calls.map(([sql]) => String(sql));
    }

    it('bounds every as-of query on time so TimescaleDB can prune chunks', async () => {
      // An unbounded "latest value" read scans the sensor's whole retention
      // window on a path the dashboard polls every 45s.
      for (const sql of await collectAsOfSql()) {
        expect(sql).toMatch(/m\.time\s*>=/);
      }
    });

    it('never uses an unbounded DISTINCT ON for the latest value', async () => {
      for (const sql of await collectAsOfSql()) {
        expect(sql).not.toContain('DISTINCT ON');
      }
    });

    it('excludes disabled channels from every projection', async () => {
      for (const sql of await collectAsOfSql()) {
        expect(sql).toContain('c.is_enabled = true');
      }
    });

    it('orders by channel_key so a same-parameter collision has a deterministic winner', async () => {
      for (const sql of await collectAsOfSql()) {
        expect(sql).toMatch(/ORDER BY[\s\S]*c\.channel_key/);
      }
    });

    it('addresses sensor_metrics unqualified so it routes to the tenant schema', async () => {
      for (const sql of await collectAsOfSql()) {
        expect(sql).not.toContain('sensor.sensor_metrics');
        expect(sql).toContain('sensor_metrics');
      }
    });

    it('picks the first channel_key deterministically when two channels share a parameter', async () => {
      // 'temp' and 'temperature' both map to the parameter `temperature`;
      // rows arrive ordered by channel_key, so 'temp' wins every time.
      mockQrQuery.mockResolvedValueOnce([
        {
          channel_key: 'temp',
          value: 20,
          time: new Date('2026-03-14T00:05:00Z'),
          time_text: '2026-03-14 00:05:00+00',
          quality_code: 192,
          source_protocol: 'mqtt',
          pond_id: null,
          farm_id: null,
        },
        {
          channel_key: 'temperature',
          value: 30,
          time: new Date('2026-03-14T00:05:00Z'),
          time_text: '2026-03-14 00:05:00+00',
          quality_code: 192,
          source_protocol: 'mqtt',
          pond_id: null,
          farm_id: null,
        },
      ]);

      const reading = await newService().getLatestReading(SENSOR_ID, TENANT_ID);

      expect(reading!.readings.temperature).toBeCloseTo(20);
    });
  });

  describe('reconstructAsOf', () => {
    it('reconstructs the snapshot at the requested anchor and round-trips the id', async () => {
      const timeText = '2026-03-14 00:07:00.123456+00';
      mockQrQuery.mockResolvedValueOnce([
        { as_of: new Date('2026-03-14T00:07:00.123Z'), channel_key: 'temperature', value: 23, quality_code: 192, source_protocol: 'mqtt', pond_id: null, farm_id: null },
        { as_of: new Date('2026-03-14T00:07:00.123Z'), channel_key: 'dissolved_oxygen', value: 8.0, quality_code: 192, source_protocol: 'modbus', pond_id: null, farm_id: null },
      ]);

      const reading = await newService().reconstructAsOf(SENSOR_ID, timeText, TENANT_ID);

      expect(reading).not.toBeNull();
      expect(reading!.readings.temperature).toBeCloseTo(23);
      expect(reading!.readings.dissolvedOxygen).toBeCloseTo(8.0);
      // The reconstructed id equals the id it was decoded from — federation-stable.
      expect(reading!.id).toBe(encodeSensorReadingId(SENSOR_ID, timeText));
      expect(decodeSensorReadingId(reading!.id)).toEqual({ sensorId: SENSOR_ID, timeText });
    });

    it('returns null when no channel has a value at or before the anchor', async () => {
      mockQrQuery.mockResolvedValueOnce([]);

      const reading = await newService().reconstructAsOf(
        SENSOR_ID,
        '2026-03-14 00:07:00+00',
        TENANT_ID,
      );

      expect(reading).toBeNull();
    });

    it('recomputes quality from the projected readings via DataQualityService (D4)', async () => {
      // ph 20 is outside [0,14] and critical → the recomputed score drops below 100.
      mockQrQuery.mockResolvedValueOnce([
        { as_of: new Date('2026-03-14T00:07:00Z'), channel_key: 'ph', value: 20, quality_code: 192, source_protocol: 'mqtt', pond_id: null, farm_id: null },
      ]);

      const reading = await newService().reconstructAsOf(
        SENSOR_ID,
        '2026-03-14 00:07:00+00',
        TENANT_ID,
      );

      expect(reading!.quality).toBeLessThan(100);
    });

    it('reports the modal source protocol across the channels (D5)', async () => {
      mockQrQuery.mockResolvedValueOnce([
        { as_of: new Date('2026-03-14T00:07:00Z'), channel_key: 'temperature', value: 21, quality_code: 192, source_protocol: 'mqtt', pond_id: null, farm_id: null },
        { as_of: new Date('2026-03-14T00:07:00Z'), channel_key: 'ph', value: 7, quality_code: 192, source_protocol: 'mqtt', pond_id: null, farm_id: null },
        { as_of: new Date('2026-03-14T00:07:00Z'), channel_key: 'salinity', value: 30, quality_code: 192, source_protocol: 'modbus', pond_id: null, farm_id: null },
      ]);

      const reading = await newService().reconstructAsOf(
        SENSOR_ID,
        '2026-03-14 00:07:00+00',
        TENANT_ID,
      );

      expect(reading!.source).toBe('mqtt');
    });
  });
});
