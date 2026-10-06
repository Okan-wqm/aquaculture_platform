import { randomBytes } from 'node:crypto';

import { applyTenantRlsToSchema, getTenantSchemaName } from '@aquaculture/backend-common/database';
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
import { ChannelAlertLevel } from '../../dto/channel-reading.dto';
import { ChannelReadingQueryService } from '../channel-reading-query.service';

/**
 * SENSOR-HIGH-138 on real Postgres: the channel-generic reads behind
 * /sensor/readings. A non-owner runtime role, FORCE RLS on two tenant
 * schemas, one water-quality sensor with the simulator's five channels plus a
 * channel outside the nine-parameter vocabulary (conductivity) and one that
 * never reported. Asserts what the page renders: every enabled channel, its
 * last value, its alert level against its own thresholds, and its history.
 */

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RUNTIME_ROLE = 'sensor_channel_reads_rls_test';
const ENTITIES = [Sensor, SensorDataChannel, SensorMetric, SensorProtocol, SensorTypeDefinition];

interface ChannelSeed {
  key: string;
  unit: string;
  thresholds: Record<string, { low: number | null; high: number | null }>;
  values: number[];
  enabled?: boolean;
}

const CHANNELS: readonly ChannelSeed[] = [
  {
    key: 'temperature',
    unit: '°C',
    thresholds: { warning: { low: 10, high: 30 }, critical: { low: 5, high: 35 } },
    values: [24.0, 24.2],
  },
  {
    key: 'ph',
    unit: 'pH',
    thresholds: { warning: { low: 7, high: 8.5 }, critical: { low: 6.5, high: 9 } },
    values: [7.3, 6.8],
  },
  {
    key: 'dissolved_oxygen',
    unit: 'mg/L',
    thresholds: { warning: { low: 4.5, high: 11 }, critical: { low: 3, high: 14 } },
    values: [5.9, 2.5],
  },
  {
    key: 'salinity',
    unit: '‰',
    thresholds: { warning: { low: 15, high: 32 }, critical: { low: 10, high: 38 } },
    values: [20.1, 19.9],
  },
  // Stored null low bound: a slightly negative offset must stay "normal".
  {
    key: 'ammonia',
    unit: 'mg/L',
    thresholds: { warning: { low: null, high: 0.3 }, critical: { low: null, high: 1 } },
    values: [0.11, -0.02],
  },
  { key: 'conductivity', unit: 'µS/cm', thresholds: {}, values: [41_200, 41_350] },
  { key: 'turbidity', unit: 'NTU', thresholds: {}, values: [] },
  { key: 'orp', unit: 'mV', thresholds: {}, values: [210], enabled: false },
];

jest.setTimeout(180_000);

describe('ChannelReadingQueryService under FORCE RLS (SENSOR-HIGH-138)', () => {
  let harness: HarnessContext | undefined;
  let runtime: DataSource | undefined;
  let service: ChannelReadingQueryService;
  const sensorIds: Record<string, string> = {};
  const now = Date.now();

  beforeAll(async () => {
    harness = await bootPostgresContainer({ startTimeoutMs: 120_000 });
    const password = randomBytes(24).toString('hex');
    const admin = harness.dataSource;

    await admin.query('CREATE EXTENSION IF NOT EXISTS timescaledb');
    await admin.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await admin.query('CREATE SCHEMA sensor');
    await admin.query(`CREATE ROLE ${RUNTIME_ROLE} LOGIN PASSWORD '${password}'`);

    for (const tenantId of [TENANT_A, TENANT_B]) {
      const schema = getTenantSchemaName(tenantId);
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const ddl = new DataSource({
        type: 'postgres',
        ...harness.connectionOptions,
        name: `channel-reads-ddl-${schema}`,
        schema,
        entities: ENTITIES,
        synchronize: true,
        logging: false,
      });
      await ddl.initialize();
      await ddl.destroy();

      const [sensor] = await admin.query(
        `INSERT INTO "${schema}".sensors (tenant_id, name, serial_number, type, status)
         VALUES ($1, 'Water quality sonde', $2, 'multi_parameter', 'active') RETURNING id`,
        [tenantId, `WQ-${schema}`],
      );
      sensorIds[tenantId] = sensor.id;

      for (const [order, channel] of CHANNELS.entries()) {
        const [row] = await admin.query(
          `INSERT INTO "${schema}".sensor_data_channels
             (sensor_id, tenant_id, channel_key, display_label, data_type, unit, "dataPath",
              "alertThresholds", "displaySettings", is_enabled, display_order)
           VALUES ($1, $2, $3, $3, 'number', $4, $3, $5::jsonb, $6::jsonb, $7, $8)
           RETURNING id`,
          [
            sensor.id,
            tenantId,
            channel.key,
            channel.unit,
            JSON.stringify(channel.thresholds),
            JSON.stringify({ precision: 2 }),
            channel.enabled ?? true,
            order + 1,
          ],
        );
        // Oldest value first, 10 minutes apart; the last one is 2 minutes old.
        for (const [index, value] of channel.values.entries()) {
          const time = new Date(now - (channel.values.length - index) * 10 * 60_000 + 8 * 60_000);
          await admin.query(
            `INSERT INTO "${schema}".sensor_metrics
               (time, sensor_id, channel_id, tenant_id, value, raw_value, quality_code, source_protocol)
             VALUES ($1, $2, $3, $4, $5, $5, 192, 'mqtt')`,
            [time, sensor.id, row.id, tenantId, value],
          );
        }
      }

      const previousDdlAuthority = process.env['DB_MIGRATE_DDL_AUTHORITY'];
      process.env['DB_MIGRATE_DDL_AUTHORITY'] = '1';
      try {
        const qr = admin.createQueryRunner();
        await applyTenantRlsToSchema(qr, { schemaOverride: schema });
        await qr.release();
      } finally {
        if (previousDdlAuthority === undefined) delete process.env['DB_MIGRATE_DDL_AUTHORITY'];
        else process.env['DB_MIGRATE_DDL_AUTHORITY'] = previousDdlAuthority;
      }
      await admin.query(`GRANT USAGE ON SCHEMA "${schema}", sensor, public TO ${RUNTIME_ROLE}`);
      await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA "${schema}" TO ${RUNTIME_ROLE}`);
    }

    runtime = new DataSource({
      type: 'postgres',
      ...harness.connectionOptions,
      username: RUNTIME_ROLE,
      password,
      name: `channel-reads-runtime-${randomBytes(4).toString('hex')}`,
      entities: ENTITIES,
      synchronize: false,
      logging: false,
    });
    await runtime.initialize();
    service = new ChannelReadingQueryService(runtime);
  });

  afterAll(async () => {
    if (runtime?.isInitialized) await runtime.destroy();
    if (harness) await shutdownHarness(harness);
  });

  it('returns every enabled channel with its last value and alert level, in display order', async () => {
    const latest = await service.getLatestValues([sensorIds[TENANT_A]!], TENANT_A);

    expect(
      latest.map(({ channelKey, value, alertLevel, unit, precision }) => ({
        channelKey,
        value,
        alertLevel,
        unit,
        precision,
      })),
    ).toEqual([
      {
        channelKey: 'temperature',
        value: 24.2,
        alertLevel: ChannelAlertLevel.NORMAL,
        unit: '°C',
        precision: 2,
      },
      {
        channelKey: 'ph',
        value: 6.8,
        alertLevel: ChannelAlertLevel.WARNING,
        unit: 'pH',
        precision: 2,
      },
      {
        channelKey: 'dissolved_oxygen',
        value: 2.5,
        alertLevel: ChannelAlertLevel.CRITICAL,
        unit: 'mg/L',
        precision: 2,
      },
      {
        channelKey: 'salinity',
        value: 19.9,
        alertLevel: ChannelAlertLevel.NORMAL,
        unit: '‰',
        precision: 2,
      },
      {
        channelKey: 'ammonia',
        value: -0.02,
        alertLevel: ChannelAlertLevel.NORMAL,
        unit: 'mg/L',
        precision: 2,
      },
      {
        channelKey: 'conductivity',
        value: 41_350,
        alertLevel: ChannelAlertLevel.NORMAL,
        unit: 'µS/cm',
        precision: 2,
      },
      {
        channelKey: 'turbidity',
        value: undefined,
        alertLevel: undefined,
        unit: 'NTU',
        precision: 2,
      },
    ]);
    expect(latest[0]?.time).toBeInstanceOf(Date);
    expect(latest[6]?.time).toBeUndefined();
  });

  it("does not read another tenant's sensor", async () => {
    await expect(service.getLatestValues([sensorIds[TENANT_B]!], TENANT_A)).resolves.toEqual([]);
  });

  it('returns bucketed history per channel, including keys outside the nine parameters', async () => {
    const response = await service.getSeries(
      sensorIds[TENANT_A]!,
      TENANT_A,
      new Date(now - 60 * 60_000),
      new Date(now),
    );

    expect(response.interval).toBe('1 minute');
    const byKey = Object.fromEntries(
      response.channels.map((channel) => [channel.channelKey, channel.points.map((p) => p.avg)]),
    );
    expect(byKey).toEqual({
      temperature: [24.0, 24.2],
      ph: [7.3, 6.8],
      dissolved_oxygen: [5.9, 2.5],
      salinity: [20.1, 19.9],
      ammonia: [0.11, -0.02],
      conductivity: [41_200, 41_350],
      turbidity: [],
    });
  });
});
