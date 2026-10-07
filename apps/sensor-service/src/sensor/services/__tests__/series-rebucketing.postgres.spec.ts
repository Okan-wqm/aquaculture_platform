import {
  getTenantSchemaName,
  SENSOR_CONTINUOUS_AGGREGATE_STATEMENTS,
} from '@aquaculture/backend-common/database';
import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { DataSource } from 'typeorm';

import { SensorDataChannel } from '../../../database/entities/sensor-data-channel.entity';
import { SensorMetric } from '../../../database/entities/sensor-metric.entity';
import { SensorProtocol } from '../../../database/entities/sensor-protocol.entity';
import { SensorTypeDefinition } from '../../../database/entities/sensor-type-definition.entity';
import { Sensor } from '../../../database/entities/sensor.entity';
import { MetricSourceTier } from '../../dto/channel-reading.dto';
import { ChannelReadingQueryService } from '../channel-reading-query.service';

/**
 * SENSOR-HIGH-162 on real TimescaleDB with the production rollup DDL: a
 * series read from a rollup comes back re-bucketed to the width it reports.
 * The rollups carry their own `bucket` column, which wins over the output
 * alias in `GROUP BY bucket`; the query then grouped by the rollup's own
 * buckets and returned every minute (or hour) as a separate point stamped
 * with the wider bucket's start.
 */

const TENANT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ENTITIES = [Sensor, SensorDataChannel, SensorMetric, SensorProtocol, SensorTypeDefinition];
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('sensor series re-bucketing on rollups (real TimescaleDB)', () => {
  let harness: HarnessContext;
  let reads: DataSource;
  let service: ChannelReadingQueryService;
  let sensorId: string;
  const schema = getTenantSchemaName(TENANT);
  // Whole hours, two days back, so both rollups hold the samples.
  const end = new Date(Math.floor((Date.now() - 2 * 24 * HOUR) / HOUR) * HOUR);
  const start = new Date(end.getTime() - 3 * 24 * HOUR);

  beforeAll(async () => {
    harness = await bootPostgresContainer({ startTimeoutMs: 120_000 });
    const admin = harness.dataSource;
    await admin.query('CREATE EXTENSION IF NOT EXISTS timescaledb');
    await admin.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await admin.query('CREATE SCHEMA sensor');
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const ddl = new DataSource({
      type: 'postgres',
      ...harness.connectionOptions,
      name: `rebucketing-ddl-${schema}`,
      schema,
      entities: ENTITIES,
      synchronize: true,
      logging: false,
    });
    await ddl.initialize();
    await ddl.destroy();
    await admin.query(
      `SELECT create_hypertable('"${schema}".sensor_metrics', 'time', migrate_data => true)`,
    );
    const runner = admin.createQueryRunner();
    await runner.connect();
    await runner.query(`SET search_path TO "${schema}", public`);
    for (const statement of SENSOR_CONTINUOUS_AGGREGATE_STATEMENTS) {
      if (statement.phase === 'definition') await runner.query(statement.sql);
    }

    const [sensor] = (await admin.query(
      `INSERT INTO "${schema}".sensors (tenant_id, name, serial_number, type, status)
       VALUES ($1, 'Probe', 'SN-1', 'temperature', 'active') RETURNING id`,
      [TENANT],
    )) as Array<{ id: string }>;
    sensorId = sensor?.id ?? '';
    const [channel] = (await admin.query(
      `INSERT INTO "${schema}".sensor_data_channels
         (sensor_id, tenant_id, channel_key, display_label, data_type, unit, "dataPath",
          is_enabled, display_order)
       VALUES ($1, $2, 'temperature', 'Temperature', 'number', '°C', 'temperature', true, 1)
       RETURNING id`,
      [sensorId, TENANT],
    )) as Array<{ id: string }>;
    // One sample a minute for three days.
    await admin.query(
      `INSERT INTO "${schema}".sensor_metrics
         (time, sensor_id, channel_id, tenant_id, value, raw_value, quality_code, source_protocol)
       SELECT t, $1, $2, $3, 20, 20, 192, 'mqtt'
         FROM generate_series($4::timestamptz, $5::timestamptz - interval '1 second', interval '1 minute') AS t`,
      [sensorId, channel?.id, TENANT, start, end],
    );
    for (const view of ['metrics_1min', 'metrics_1hour', 'metrics_1day']) {
      await runner.query(`CALL refresh_continuous_aggregate('${view}', NULL, NULL)`);
    }
    await runner.release();

    reads = new DataSource({
      type: 'postgres',
      ...harness.connectionOptions,
      name: `rebucketing-reads-${schema}`,
      entities: ENTITIES,
      synchronize: false,
      logging: false,
    });
    await reads.initialize();
    service = new ChannelReadingQueryService(reads);
  }, 300_000);

  afterAll(async () => {
    if (reads?.isInitialized) await reads.destroy();
    if (harness) await shutdownHarness(harness);
  });

  it('returns one point per 15-minute bucket from the minute rollup', async () => {
    const windowEnd = new Date(start.getTime() + 6 * HOUR);
    const series = await service.getSeries(sensorId, TENANT, start, windowEnd, '15 minutes');
    expect(series.sourceTier).toBe(MetricSourceTier.MINUTE);
    const points = series.channels[0]?.points ?? [];
    expect(points).toHaveLength(24);
    expect(new Set(points.map((point) => point.count))).toEqual(new Set([15]));
    expect(series.channels[0]?.gaps).toEqual([]);
  });

  it('returns one point per 4-hour bucket from the hourly rollup', async () => {
    const series = await service.getSeries(sensorId, TENANT, start, end, '4 hours');
    expect(series.sourceTier).toBe(MetricSourceTier.HOUR);
    const points = series.channels[0]?.points ?? [];
    // Three days of 4-hour buckets; a bucket overlapping the window's start
    // is aligned to UTC and still whole, since the window starts on the hour.
    const timestamps = points.map((point) => point.bucket.getTime());
    expect(new Set(timestamps).size).toBe(timestamps.length);
    const total = points.reduce((sum, point) => sum + point.count, 0);
    expect(total).toBe((end.getTime() - start.getTime()) / MINUTE);
    expect(points.every((point) => point.count <= 4 * 60)).toBe(true);
  });
});
