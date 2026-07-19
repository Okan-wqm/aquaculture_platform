import { DataSource, Repository } from 'typeorm';

import { SensorReading } from '../../../database/entities/sensor-reading.entity';
import { SensorQueryService } from '../sensor-query.service';

/**
 * SENSOR-MEDIUM-066/068 (reads convergence): getAggregatedReadings now
 * aggregates over the channel-keyed sensor.sensor_metrics store (+ continuous
 * aggregates for large ranges) and pivots channel_key → parameter via the
 * event-contract SSoT. These tests lock the pivot, the vocabulary filter, the
 * same-parameter merge, and the range→source tier selection.
 */
type AggRow = {
  bucket: string;
  channel_key: string;
  avg_value: number | null;
  min_value: number | null;
  max_value: number | null;
  sample_count: number | null;
};

const SENSOR_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';

function createService(aggRows: AggRow[]): { service: SensorQueryService; query: jest.Mock } {
  const query = jest.fn((sql: string): Promise<unknown> => {
    if (sql.includes('SELECT name FROM sensors')) {
      return Promise.resolve([{ name: 'Test Sensor' }]);
    }
    return Promise.resolve(aggRows);
  });
  const dataSource: Partial<DataSource> = { query: query as DataSource['query'] };
  const readingRepository: Partial<Repository<SensorReading>> = {};
  const service = new SensorQueryService(
    readingRepository as Repository<SensorReading>,
    dataSource as DataSource,
  );
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
