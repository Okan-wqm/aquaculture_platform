import { ConfigService } from '@nestjs/config';
import { RedisService } from '@aquaculture/backend-common/redis';
import { IEventBus } from '@platform/event-bus';
import { DataSource } from 'typeorm';

import {
  bootSensorRlsHarness,
  type SensorRlsHarness,
} from '../../__tests__/support/sensor-rls-postgres.harness';
import { SensorDataChannel } from '../../database/entities/sensor-data-channel.entity';
import { SensorMetric } from '../../database/entities/sensor-metric.entity';
import { SensorProtocol } from '../../database/entities/sensor-protocol.entity';
import { SensorTypeDefinition } from '../../database/entities/sensor-type-definition.entity';
import { Sensor } from '../../database/entities/sensor.entity';
import { MqttClientService, MqttMessageHandler } from '../../shared-mqtt/mqtt-client.service';
import { MqttListenerService } from '../mqtt-listener.service';
import { SensorMetricWriterService } from '../sensor-metric-writer.service';
import { SensorTopicCacheService } from '../sensor-topic-cache.service';

/**
 * SENSOR-HIGH-137 on real Postgres: the MQTT ingestion hop AFTER topic
 * resolution. SENSOR-HIGH-119 made the topic cache read each tenant inside
 * runInTenantRead, and its spec proved the cache resolves under FORCE RLS —
 * but the listener then reloaded the sensor with only search_path pinned, so
 * on the deny-by-default pool the reload returned null and every reading was
 * dropped at debug level (prod: no sensor_metrics row since 2026-09-19 23:55Z).
 *
 * This spec drives a message through the listener's registered handler — the
 * same entry point MqttClientService calls — against a non-owner runtime role
 * with FORCE RLS on two tenant schemas, and asserts the end result the
 * operator cares about: one sensor_metrics row per configured channel, in the
 * owning tenant only, plus the sensor's last_seen_at.
 */

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TOPIC_A = 'sensors/rls-e2e/water-quality-a';
const TOPIC_B = 'sensors/rls-e2e/water-quality-b';
const ENTITIES = [Sensor, SensorDataChannel, SensorMetric, SensorProtocol, SensorTypeDefinition];

/** The five parameters the prod water-quality simulator publishes. */
const CHANNELS: ReadonlyArray<{ key: string; unit: string; min: number; max: number }> = [
  { key: 'temperature', unit: '°C', min: -10, max: 60 },
  { key: 'ph', unit: 'pH', min: 0, max: 14 },
  { key: 'dissolved_oxygen', unit: 'mg/L', min: 0, max: 20 },
  { key: 'salinity', unit: '‰', min: 0, max: 45 },
  { key: 'ammonia', unit: 'mg/L', min: 0, max: 5 },
];

const PAYLOAD = {
  deviceId: 'WT-RLS-01',
  timestamp: '2026-10-06T10:31:57.802Z',
  temperature: 24.2,
  ph: 7.34,
  dissolved_oxygen: 5.86,
  salinity: 19.9,
  ammonia: 0.114,
};

jest.setTimeout(180_000);

describe('MqttListenerService ingestion under FORCE RLS (SENSOR-HIGH-137)', () => {
  let stage: SensorRlsHarness | undefined;
  let admin: DataSource | undefined;
  let runtime: DataSource | undefined;
  let listener: MqttListenerService | undefined;
  let handler: MqttMessageHandler | undefined;
  let SCHEMA_A = '';
  let SCHEMA_B = '';
  const sensorIds: Record<string, string> = {};

  beforeAll(async () => {
    const topics: Record<string, string> = { [TENANT_A]: TOPIC_A, [TENANT_B]: TOPIC_B };
    stage = await bootSensorRlsHarness({
      name: 'mqtt_listener',
      tenants: [TENANT_A, TENANT_B],
      entities: ENTITIES,
      beforeRls: async ({ admin: bootstrap, tenantId, schema }) => {
        const topic = topics[tenantId];
        // Seed as the owner: one sensor per tenant, each with the five channels.
        const [sensor] = await bootstrap.query(
          `INSERT INTO "${schema}".sensors
               (tenant_id, name, serial_number, type, status, protocol_configuration)
             VALUES ($1, 'Water quality sonde', $2, 'temperature', 'active', $3::jsonb)
             RETURNING id`,
          [tenantId, `WT-RLS-${schema}`, JSON.stringify({ topic, payloadFormat: 'json' })],
        );
        sensorIds[tenantId] = sensor.id;
        for (const [order, channel] of CHANNELS.entries()) {
          await bootstrap.query(
            `INSERT INTO "${schema}".sensor_data_channels
                 (sensor_id, tenant_id, channel_key, display_label, data_type, unit, "dataPath",
                  "minValue", "maxValue", is_enabled, display_order)
               VALUES ($1, $2, $3, $3, 'number', $4, $3, $5, $6, true, $7)`,
            [sensor.id, tenantId, channel.key, channel.unit, channel.min, channel.max, order + 1],
          );
        }
      },
    });
    admin = stage.admin;
    runtime = stage.runtime;
    SCHEMA_A = stage.schemaOf(TENANT_A);
    SCHEMA_B = stage.schemaOf(TENANT_B);

    const redisService = {
      getJson: jest.fn().mockResolvedValue(null),
      setJson: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
      keys: jest.fn().mockResolvedValue([]),
    } as Partial<RedisService> as RedisService;
    const config = {
      get: (key: string, fallback?: string): string | undefined =>
        ({ MQTT_ENABLED: 'true', LEGACY_EDGE_TOPICS_ENABLED: 'false' })[key] ?? fallback,
    } as Partial<ConfigService> as ConfigService;
    const mqttClient = {
      addMessageHandler: (registered: MqttMessageHandler): void => {
        handler = registered;
      },
      removeMessageHandler: jest.fn(),
      isConnectedToBroker: () => true,
      subscribe: jest.fn().mockResolvedValue(undefined),
      recordMessageReceived: jest.fn(),
      recordMessageProcessed: jest.fn(),
      recordMessageFailed: jest.fn(),
    } as Partial<MqttClientService> as MqttClientService;

    listener = new MqttListenerService(
      config,
      runtime,
      new SensorMetricWriterService(runtime),
      { publish: jest.fn().mockResolvedValue(undefined) } as Partial<IEventBus> as IEventBus,
      null,
      new SensorTopicCacheService(redisService, runtime),
      mqttClient,
      null,
      null,
      null,
      null,
      null,
    );
    await listener.onModuleInit();
  });

  afterAll(async () => {
    await stage?.shutdown();
  });

  async function channelValues(schema: string): Promise<Record<string, number>> {
    const rows: Array<{ channel_key: string; value: string }> = await admin!.query(
      `SELECT c.channel_key, m.value
         FROM "${schema}".sensor_metrics m
         JOIN "${schema}".sensor_data_channels c ON c.id = m.channel_id`,
    );
    return Object.fromEntries(rows.map((row) => [row.channel_key, Number(row.value)]));
  }

  it('persists one sensor_metrics row per configured channel (was: zero rows)', async () => {
    await handler!(TOPIC_A, Buffer.from(JSON.stringify(PAYLOAD)));

    expect(await channelValues(SCHEMA_A)).toEqual({
      temperature: 24.2,
      ph: 7.34,
      dissolved_oxygen: 5.86,
      salinity: 19.9,
      ammonia: 0.114,
    });
  });

  it('keeps the reading inside the owning tenant', async () => {
    expect(await channelValues(SCHEMA_B)).toEqual({});
  });

  it('stamps last_seen_at on the owning tenant sensor when the debounce flushes', async () => {
    await listener!.onModuleDestroy();

    const [sensorA] = await admin!.query(
      `SELECT last_seen_at FROM "${SCHEMA_A}".sensors WHERE id = $1`,
      [sensorIds[TENANT_A]],
    );
    const [sensorB] = await admin!.query(
      `SELECT last_seen_at FROM "${SCHEMA_B}".sensors WHERE id = $1`,
      [sensorIds[TENANT_B]],
    );
    expect(sensorA.last_seen_at).not.toBeNull();
    expect(sensorB.last_seen_at).toBeNull();
  });
});
