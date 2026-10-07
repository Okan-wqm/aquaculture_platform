import { randomUUID } from 'node:crypto';

import { getTenantSchemaName } from '@aquaculture/backend-common/database';
import { SENSOR_CONTINUOUS_AGGREGATE_STATEMENTS } from '@aquaculture/backend-common/database';
import type { CircuitBreakerService } from '@aquaculture/backend-common/resilience';
import { stub } from '@aquaculture/testing';
import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import type { NatsRequestReply } from '@platform/event-bus';
import { DataSource } from 'typeorm';

import { SensorDataChannel } from '../../../database/entities/sensor-data-channel.entity';
import { SensorMetric } from '../../../database/entities/sensor-metric.entity';
import { SensorProtocol } from '../../../database/entities/sensor-protocol.entity';
import { SensorTypeDefinition } from '../../../database/entities/sensor-type-definition.entity';
import { Sensor } from '../../../database/entities/sensor.entity';
import { MetricSourceTier, SeriesTimeZoneSource } from '../../dto/channel-reading.dto';
import { ChannelReadingQueryService } from '../channel-reading-query.service';
import { SeriesTimeZoneService } from '../series-time-zone.service';

/**
 * SENSOR-HIGH-160 on real TimescaleDB with the production rollup DDL: a
 * series' days are the site's local days.
 *
 * - Asia/Kolkata (+05:30): days come from hourly rows plus the minute rows of
 *   the hour that straddles local midnight, and hold exactly a day's samples.
 * - Europe/Oslo on its 25-hour autumn day, America/Santiago on a day whose
 *   local midnight does not exist (23 hours): one bucket per local day, the
 *   day's real sample count, and no false gap.
 * - A UTC site keeps UTC days.
 * - Rollup rows are re-bucketed: a day of hourly rows is one point, not 24.
 */

const TENANT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ENTITIES = [Sensor, SensorDataChannel, SensorMetric, SensorProtocol, SensorTypeDefinition];
const HOUR = 3_600_000;

/** A breaker that only runs the call: these specs test the read, not resilience. */
const passThroughBreaker = (): CircuitBreakerService =>
  stub<CircuitBreakerService>({
    execute: <T>(args: { fn: () => Promise<T> }): Promise<T> => args.fn(),
  });

interface Scenario {
  zone: string;
  siteId: string;
  sensorId?: string;
  channelId?: string;
  /** Local days covered: [start of day 1, start of day 4). */
  dayStarts?: Date[];
}

describe('sensor series in the site time zone (real TimescaleDB)', () => {
  let harness: HarnessContext;
  let admin: DataSource;
  let reads: DataSource;
  let service: ChannelReadingQueryService;
  const schema = getTenantSchemaName(TENANT);
  const scenarios: Record<'kolkata' | 'oslo' | 'santiago' | 'utc', Scenario> = {
    kolkata: { zone: 'Asia/Kolkata', siteId: randomUUID() },
    oslo: { zone: 'Europe/Oslo', siteId: randomUUID() },
    santiago: { zone: 'America/Santiago', siteId: randomUUID() },
    utc: { zone: 'UTC', siteId: randomUUID() },
  };

  /** Starts of four consecutive local days beginning `firstDay` (yyyy-mm-dd), per Postgres. */
  async function localDayStarts(zone: string, firstDay: string): Promise<Date[]> {
    const rows = (await admin.query(
      `SELECT ((($1::date + d)::timestamp) AT TIME ZONE $2) AS start
         FROM generate_series(0, 3) AS d ORDER BY d`,
      [firstDay, zone],
    )) as Array<{ start: Date }>;
    return rows.map((row) => new Date(row.start));
  }

  /** The most recent local date in the last year whose day lasts `hours` hours. */
  async function lastDayLasting(zone: string, hours: number): Promise<string> {
    const rows = (await admin.query(
      `SELECT d::date::text AS day
         FROM generate_series(now()::date - 360, now()::date - 3, interval '1 day') AS d
        WHERE ((d::date + 1)::timestamp AT TIME ZONE $1) - ((d::date)::timestamp AT TIME ZONE $1)
              = make_interval(hours => $2)
        ORDER BY d DESC LIMIT 1`,
      [zone, hours],
    )) as Array<{ day: string }>;
    const day = rows[0]?.day;
    if (day === undefined) throw new Error(`No ${hours}-hour day in ${zone} in the last year`);
    return day;
  }

  beforeAll(async () => {
    harness = await bootPostgresContainer({ startTimeoutMs: 120_000 });
    admin = harness.dataSource;
    await admin.query('CREATE EXTENSION IF NOT EXISTS timescaledb');
    await admin.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await admin.query('CREATE SCHEMA sensor');
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const ddl = new DataSource({
      type: 'postgres',
      ...harness.connectionOptions,
      name: `local-buckets-ddl-${schema}`,
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
    // The production rollup DDL, created in the tenant schema.
    const runner = admin.createQueryRunner();
    await runner.connect();
    await runner.query(`SET search_path TO "${schema}", public`);
    for (const statement of SENSOR_CONTINUOUS_AGGREGATE_STATEMENTS) {
      if (statement.phase === 'definition') await runner.query(statement.sql);
    }

    // Kolkata: three local days ten days back, a sample every 15 minutes.
    const kolkataDay = (
      (await admin.query(`SELECT (now()::date - 10)::text AS day`)) as Array<{ day: string }>
    )[0]?.day;
    if (kolkataDay === undefined) throw new Error('no date');
    scenarios.kolkata.dayStarts = await localDayStarts('Asia/Kolkata', kolkataDay);
    // Oslo: the day before, of and after its last 25-hour day; hourly samples.
    const osloDay = await lastDayLasting('Europe/Oslo', 25);
    scenarios.oslo.dayStarts = await localDayStarts(
      'Europe/Oslo',
      (
        (await admin.query(`SELECT ($1::date - 1)::text AS day`, [osloDay])) as Array<{
          day: string;
        }>
      )[0]?.day ?? osloDay,
    );
    // Santiago: around its last 23-hour day (local midnight skipped).
    const santiagoDay = await lastDayLasting('America/Santiago', 23);
    scenarios.santiago.dayStarts = await localDayStarts(
      'America/Santiago',
      (
        (await admin.query(`SELECT ($1::date - 1)::text AS day`, [santiagoDay])) as Array<{
          day: string;
        }>
      )[0]?.day ?? santiagoDay,
    );
    scenarios.utc.dayStarts = scenarios.kolkata.dayStarts.map(
      (start) =>
        new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 1)),
    );

    for (const [name, scenario] of Object.entries(scenarios)) {
      const [sensor] = (await admin.query(
        `INSERT INTO "${schema}".sensors (tenant_id, name, serial_number, type, status, site_id)
         VALUES ($1, $2, $3, 'temperature', 'active', $4) RETURNING id`,
        [TENANT, `Probe ${name}`, `SN-${name}`, scenario.siteId],
      )) as Array<{ id: string }>;
      const [channel] = (await admin.query(
        `INSERT INTO "${schema}".sensor_data_channels
           (sensor_id, tenant_id, channel_key, display_label, data_type, unit, "dataPath",
            is_enabled, display_order)
         VALUES ($1, $2, 'temperature', 'Temperature', 'number', '°C', 'temperature', true, 1)
         RETURNING id`,
        [sensor?.id, TENANT],
      )) as Array<{ id: string }>;
      scenario.sensorId = sensor?.id;
      scenario.channelId = channel?.id;
      const [first, , , last] = scenario.dayStarts ?? [];
      const step = name === 'kolkata' || name === 'utc' ? '15 minutes' : '1 hour';
      await admin.query(
        `INSERT INTO "${schema}".sensor_metrics
           (time, sensor_id, channel_id, tenant_id, value, raw_value, quality_code, source_protocol)
         SELECT t, $1, $2, $3, 20, 20, 192, 'mqtt'
           FROM generate_series($4::timestamptz, $5::timestamptz - interval '1 second', $6::interval) AS t`,
        [scenario.sensorId, scenario.channelId, TENANT, first, last, step],
      );
    }
    for (const view of ['metrics_1min', 'metrics_1hour', 'metrics_1day']) {
      await runner.query(`CALL refresh_continuous_aggregate('${view}', NULL, NULL)`);
    }
    await runner.release();

    const zones = Object.fromEntries(
      Object.values(scenarios).map((scenario) => [scenario.siteId, scenario.zone]),
    );
    const requestReply = stub<NatsRequestReply>({
      requestTyped: jest.fn().mockResolvedValue({ tenantZone: 'UTC', siteZones: zones }),
    });
    const breaker = passThroughBreaker();
    reads = new DataSource({
      type: 'postgres',
      ...harness.connectionOptions,
      name: `local-buckets-reads-${schema}`,
      entities: ENTITIES,
      synchronize: false,
      logging: false,
    });
    await reads.initialize();
    service = new ChannelReadingQueryService(
      reads,
      new SeriesTimeZoneService(requestReply, breaker),
    );
  }, 300_000);

  afterAll(async () => {
    if (reads?.isInitialized) await reads.destroy();
    if (harness) await shutdownHarness(harness);
  });

  async function dailySeries(name: keyof typeof scenarios) {
    const scenario = scenarios[name];
    const [first, , , last] = scenario.dayStarts ?? [];
    if (!scenario.sensorId || !first || !last) throw new Error('scenario not seeded');
    return service.getSeries(scenario.sensorId, TENANT, first, last, '1 day');
  }

  it('counts an India day from local midnight to local midnight, exactly', async () => {
    const series = await dailySeries('kolkata');
    expect([series.displayTimeZone, series.bucketTimeZone, series.displayTimeZoneSource]).toEqual([
      'Asia/Kolkata',
      'Asia/Kolkata',
      SeriesTimeZoneSource.SITE,
    ]);
    // Read from the hourly rollup (plus the boundary hour's minute rows).
    expect(series.sourceTier).toBe(MetricSourceTier.HOUR);
    const points = series.channels[0]?.points ?? [];
    expect(points.map((point) => [point.bucket.toISOString(), point.count])).toEqual(
      (scenarios.kolkata.dayStarts ?? []).slice(0, 3).map((start) => [start.toISOString(), 96]),
    );
    expect(series.channels[0]?.gaps).toEqual([]);
  });

  it('keeps the 25-hour autumn day whole in Oslo, with no false gap', async () => {
    const series = await dailySeries('oslo');
    const points = series.channels[0]?.points ?? [];
    expect(points.map((point) => [point.bucket.toISOString(), point.count])).toEqual(
      (scenarios.oslo.dayStarts ?? [])
        .slice(0, 3)
        .map((start, index) => [start.toISOString(), index === 1 ? 25 : 24]),
    );
    expect(series.channels[0]?.gaps).toEqual([]);
  });

  it('starts a Santiago day where Postgres says when its local midnight does not exist', async () => {
    const series = await dailySeries('santiago');
    const points = series.channels[0]?.points ?? [];
    expect(points.map((point) => [point.bucket.toISOString(), point.count])).toEqual(
      (scenarios.santiago.dayStarts ?? [])
        .slice(0, 3)
        .map((start, index) => [start.toISOString(), index === 1 ? 23 : 24]),
    );
    expect(series.channels[0]?.gaps).toEqual([]);
  });

  it('keeps UTC days for a UTC site, re-bucketed from the hourly rollup', async () => {
    const series = await dailySeries('utc');
    expect([series.displayTimeZone, series.bucketTimeZone]).toEqual(['UTC', 'UTC']);
    const points = series.channels[0]?.points ?? [];
    // One point per day — the hourly rows are re-bucketed, not passed through.
    expect(points.map((point) => point.bucket.getUTCHours())).toEqual([0, 0, 0]);
    expect(points.map((point) => point.count)).toEqual([96, 96, 96]);
  });

  it('shows UTC, and says so, when farm cannot answer', async () => {
    const offline = new ChannelReadingQueryService(
      reads,
      new SeriesTimeZoneService(
        stub<NatsRequestReply>({
          requestTyped: jest.fn().mockRejectedValue(new Error('no responders')),
        }),
        passThroughBreaker(),
      ),
    );
    const [first, , , last] = scenarios.kolkata.dayStarts ?? [];
    const series = await offline.getSeries(
      scenarios.kolkata.sensorId ?? '',
      TENANT,
      first ?? new Date(),
      last ?? new Date(),
      '1 day',
    );
    expect([series.displayTimeZone, series.bucketTimeZone, series.displayTimeZoneSource]).toEqual([
      'UTC',
      'UTC',
      SeriesTimeZoneSource.UNAVAILABLE,
    ]);
  });

  it('never leaves a straddling hour out: every sample of the window is counted once', async () => {
    const series = await dailySeries('kolkata');
    const total = (series.channels[0]?.points ?? []).reduce((sum, point) => sum + point.count, 0);
    const span =
      (scenarios.kolkata.dayStarts?.[3]?.getTime() ?? 0) -
      (scenarios.kolkata.dayStarts?.[0]?.getTime() ?? 0);
    expect(total).toBe(span / (HOUR / 4));
  });

  it.each([
    ['15 minutes', 12],
    ['1 hour', 12],
  ])(
    'counts each sample once at %s across the repeated autumn hour in Oslo',
    async (interval, samples) => {
      // Twelve hourly samples from the local midnight of the 25-hour day: the
      // clock goes 03:00 → 02:00, so two samples share the local time 02:00.
      const start = scenarios.oslo.dayStarts?.[1] ?? new Date();
      const series = await service.getSeries(
        scenarios.oslo.sensorId ?? '',
        TENANT,
        start,
        new Date(start.getTime() + 12 * HOUR),
        interval,
      );
      const points = series.channels[0]?.points ?? [];
      const instants = points.map((point) => point.bucket.getTime());
      expect(new Set(instants).size).toBe(points.length);
      expect(points.map((point) => point.count)).toEqual(Array(samples).fill(1));
    },
  );

  it('keeps 4-hour buckets contiguous across the repeated autumn hour in Oslo', async () => {
    const start = scenarios.oslo.dayStarts?.[1] ?? new Date();
    const series = await service.getSeries(
      scenarios.oslo.sensorId ?? '',
      TENANT,
      start,
      new Date(start.getTime() + 12 * HOUR),
      '4 hours',
    );
    const points = series.channels[0]?.points ?? [];
    expect(points.map((point) => point.count)).toEqual([4, 4, 4]);
    // Fixed-length buckets from the local midnight: no fold, no false gap.
    expect(points.map((point) => point.bucket.getTime() - start.getTime())).toEqual([
      0,
      4 * HOUR,
      8 * HOUR,
    ]);
    expect(series.channels[0]?.gaps).toEqual([]);
  });

  it('gives a page one zone: the shared site zone, else the tenant zone', async () => {
    const kolkata = scenarios.kolkata.sensorId ?? '';
    const oslo = scenarios.oslo.sensorId ?? '';
    expect(await service.getDisplayTimeZone([kolkata], TENANT)).toEqual({
      displayTimeZone: 'Asia/Kolkata',
      source: SeriesTimeZoneSource.SITE,
    });
    expect(await service.getDisplayTimeZone([kolkata, oslo], TENANT)).toEqual({
      displayTimeZone: 'UTC',
      source: SeriesTimeZoneSource.TENANT,
    });
  });

  it("finds a quiet channel's last sample to the minute, not its UTC day", async () => {
    const bounds = await service.getDataBounds([scenarios.kolkata.sensorId ?? ''], TENANT);
    // Samples every 15 minutes up to the end of the third local day.
    const lastSample = (scenarios.kolkata.dayStarts?.[3]?.getTime() ?? 0) - 15 * 60_000;
    expect(bounds[0]?.lastSampleAt?.getTime()).toBe(lastSample);
  });
});
