import { ConfigService } from '@nestjs/config';
import { OutboxPublisher } from '@platform/outbox';

import {
  bootSensorRlsHarness,
  type SensorRlsHarness,
} from '../../__tests__/support/sensor-rls-postgres.harness';
import { SensorDataChannel } from '../../database/entities/sensor-data-channel.entity';
import { SensorMetric } from '../../database/entities/sensor-metric.entity';
import { SensorProtocol } from '../../database/entities/sensor-protocol.entity';
import { SensorTypeDefinition } from '../../database/entities/sensor-type-definition.entity';
import { Sensor } from '../../database/entities/sensor.entity';
import {
  ConnectionHandle,
  DataSubscription,
  SensorReadingData,
} from '../../protocol/adapters/base-protocol.adapter';
import { MqttAdapter } from '../../protocol/adapters/iot/mqtt.adapter';
import { CalibrationService } from '../../sensor/services/calibration.service';
import { DataQualityService } from '../../sensor/services/data-quality.service';
import { ReadingMapperRegistry } from '../../sensor/services/reading-mapper.service';
import { SensorIngestionService } from '../../sensor/services/sensor-ingestion.service';
import { DataIngestionService } from '../data-ingestion.service';
import { SensorMetaCacheService } from '../sensor-meta-cache.service';
import { SensorMetricWriterService } from '../sensor-metric-writer.service';

/**
 * SENSOR-HIGH-148 on real Postgres: every non-MQTT ingestion path, as a
 * non-owner runtime role, against tenant schemas with FORCE RLS armed by the
 * platform helper. On main these paths read `sensors` / `sensor_data_channels`
 * through bare repositories, saw zero rows, and either failed before the
 * writer or stored values uncalibrated. The production tenant has FORCE RLS
 * on exactly these two tables.
 *
 * - GraphQL ingest (SensorIngestionService + CalibrationService): calibration
 *   from the channel config, channel auto-provisioning, last_seen_at, and a
 *   mixed-tenant batch.
 * - NATS sidecar consumer cache (SensorMetaCacheService): tenant-bound reads,
 *   and another tenant's sensor id is invisible.
 * - Legacy data plane (DataIngestionService): the boot scan finds each
 *   tenant's MQTT parent sensor through the platform mapping, and a delivered
 *   payload is stored under that tenant.
 */

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ENTITIES = [Sensor, SensorDataChannel, SensorMetric, SensorProtocol, SensorTypeDefinition];

const SENSORS: Record<string, string> = {
  [TENANT_A]: '11111111-1111-4111-8111-111111111111',
  [TENANT_B]: '22222222-2222-4222-8222-222222222222',
};
const PARENTS: Record<string, string> = {
  [TENANT_A]: '33333333-3333-4333-8333-333333333333',
};

jest.setTimeout(240_000);

describe('sensor ingestion paths under FORCE RLS (SENSOR-HIGH-148)', () => {
  let stage: SensorRlsHarness | undefined;

  beforeAll(async () => {
    stage = await bootSensorRlsHarness({
      name: 'ingest_paths',
      tenants: [TENANT_A, TENANT_B],
      entities: ENTITIES,
      beforeRls: async ({ admin, tenantId, schema }) => {
        const sensorId = SENSORS[tenantId];
        await admin.query(
          `INSERT INTO "${schema}".sensors (id, tenant_id, name, serial_number, type, status)
           VALUES ($1, $2, 'Sonde', $3, 'temperature', 'active')`,
          [sensorId, tenantId, `SONDE-${schema}`],
        );
        // temperature is calibrated ×2 + 1; ph has no channel yet.
        await admin.query(
          `INSERT INTO "${schema}".sensor_data_channels
             (sensor_id, tenant_id, channel_key, display_label, data_type, unit, "dataPath",
              is_enabled, display_order, calibration_enabled, calibration_multiplier,
              calibration_offset)
           VALUES ($1, $2, 'temperature', 'temperature', 'number', '°C', 'temperature',
                   true, 1, true, 2, 1)`,
          [sensorId, tenantId],
        );

        const parentId = PARENTS[tenantId];
        if (parentId !== undefined) {
          const [protocol] = await admin.query(
            `INSERT INTO "${schema}".sensor_protocols
               (code, name, category, "connectionType", "configurationSchema")
             VALUES ('MQTT', 'MQTT', 'iot', 'tcp', '{}'::jsonb)
             RETURNING id`,
          );
          await admin.query(
            `INSERT INTO "${schema}".sensors
               (id, tenant_id, name, serial_number, type, status, registration_status,
                is_active, is_parent_device, protocol_id, protocol_configuration)
             VALUES ($1, $2, 'Gateway', $3, 'temperature', 'active', 'active', true, true, $4,
                     '{"brokerUrl":"mqtt://broker.invalid","topic":"farm/gw"}'::jsonb)`,
            [parentId, tenantId, `GW-${schema}`, protocol.id],
          );
          await admin.query(
            `INSERT INTO "${schema}".sensor_data_channels
               (sensor_id, tenant_id, channel_key, display_label, data_type, unit, "dataPath",
                is_enabled, display_order)
             VALUES ($1, $2, 'oxygen', 'oxygen', 'number', 'mg/L', 'oxygen', true, 1)`,
            [parentId, tenantId],
          );
        }

        await admin.query(
          `SELECT create_hypertable('"${schema}".sensor_metrics', 'time', migrate_data => true)`,
        );
      },
    });
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await stage?.shutdown();
  });

  async function storedByChannel(
    tenantId: string,
    sensorId: string,
  ): Promise<Record<string, number[]>> {
    const schema = stage!.schemaOf(tenantId);
    const rows: Array<{ channel_key: string; value: string }> = await stage!.admin.query(
      `SELECT c.channel_key, m.value
         FROM "${schema}".sensor_metrics m
         JOIN "${schema}".sensor_data_channels c ON c.id = m.channel_id
        WHERE m.sensor_id = $1
        ORDER BY m.time, c.channel_key`,
      [sensorId],
    );
    const byChannel: Record<string, number[]> = {};
    for (const row of rows) (byChannel[row.channel_key] ??= []).push(Number(row.value));
    return byChannel;
  }

  async function lastSeen(tenantId: string, sensorId: string): Promise<Date | null> {
    const [row] = await stage!.admin.query(
      `SELECT last_seen_at FROM "${stage!.schemaOf(tenantId)}".sensors WHERE id = $1`,
      [sensorId],
    );
    return row.last_seen_at;
  }

  async function eventually(probe: () => Promise<boolean>): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await probe()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('condition not reached within 5 s');
  }

  describe('GraphQL ingest', () => {
    let ingestion: SensorIngestionService;

    beforeAll(() => {
      const runtime = stage!.runtime;
      const outbox: Partial<OutboxPublisher> = { enqueue: jest.fn().mockResolvedValue(undefined) };
      ingestion = new SensorIngestionService(
        runtime,
        outbox as OutboxPublisher,
        new CalibrationService(runtime),
        new DataQualityService(),
        new ReadingMapperRegistry(),
        new SensorMetricWriterService(runtime),
      );
    });

    it('stores a calibrated reading, provisions the missing channel and stamps last_seen_at', async () => {
      const sensorId = SENSORS[TENANT_A]!;

      await ingestion.ingestReading({
        sensorId,
        tenantId: TENANT_A,
        readings: { temperature: 10, ph: 7.2 },
        timestamp: new Date('2026-10-06T10:00:00Z'),
      });

      // temperature calibrated 10 × 2 + 1; ph stored on its auto-provisioned channel.
      expect(await storedByChannel(TENANT_A, sensorId)).toEqual({ ph: [7.2], temperature: [21] });
      await eventually(async () => (await lastSeen(TENANT_A, sensorId)) !== null);
    });

    it('stores a mixed-tenant batch in each owning tenant only', async () => {
      await ingestion.ingestBatch([
        {
          sensorId: SENSORS[TENANT_A]!,
          tenantId: TENANT_A,
          readings: { temperature: 20 },
          timestamp: new Date('2026-10-06T10:01:00Z'),
        },
        {
          sensorId: SENSORS[TENANT_B]!,
          tenantId: TENANT_B,
          readings: { temperature: 30 },
          timestamp: new Date('2026-10-06T10:01:00Z'),
        },
      ]);

      expect((await storedByChannel(TENANT_A, SENSORS[TENANT_A]!))['temperature']).toEqual([
        21, 41,
      ]);
      expect(await storedByChannel(TENANT_B, SENSORS[TENANT_B]!)).toEqual({ temperature: [61] });
      expect(await lastSeen(TENANT_B, SENSORS[TENANT_B]!)).not.toBeNull();
    });
  });

  describe('NATS sidecar consumer cache', () => {
    it("reads a sensor and its channels in the event's tenant, and nothing across tenants", async () => {
      const cache = new SensorMetaCacheService(stage!.runtime);
      const sensorA = SENSORS[TENANT_A]!;

      expect((await cache.getSensor(sensorA, TENANT_A))?.tenantId).toBe(TENANT_A);
      expect((await cache.getChannels(sensorA, TENANT_A)).map((c) => c.channelKey).sort()).toEqual([
        'ph',
        'temperature',
      ]);
      expect(await cache.getSensor(sensorA, TENANT_B)).toBeNull();
      expect(await cache.getChannels(sensorA, TENANT_B)).toEqual([]);
    });
  });

  describe('legacy data plane', () => {
    it("starts each tenant's MQTT parent sensor and stores its payload under that tenant", async () => {
      const handle: ConnectionHandle = {
        id: 'h-1',
        sensorId: PARENTS[TENANT_A]!,
        tenantId: TENANT_A,
        protocolCode: 'MQTT',
        createdAt: new Date(),
        lastActivityAt: new Date(),
      };
      const delivered: Array<(data: SensorReadingData) => void> = [];
      jest.spyOn(MqttAdapter.prototype, 'connect').mockResolvedValue(handle);
      jest.spyOn(MqttAdapter.prototype, 'disconnect').mockResolvedValue(undefined);
      jest
        .spyOn(MqttAdapter.prototype, 'subscribeToData')
        .mockImplementation(async (_handle, onData): Promise<DataSubscription> => {
          delivered.push(onData);
          return { id: 's-1', unsubscribe: async () => undefined, isActive: () => true };
        });
      const config: Partial<ConfigService> = { get: () => undefined };
      const plane = new DataIngestionService(
        stage!.runtime,
        new SensorMetricWriterService(stage!.runtime),
        config as ConfigService,
        null,
      );

      await plane.startAllActiveSensors();
      expect(plane.getActiveConnections().map((c) => c.sensorId)).toEqual([PARENTS[TENANT_A]]);

      const payload: SensorReadingData = {
        timestamp: new Date('2026-10-06T10:02:00Z'),
        values: { oxygen: 6.4 },
        source: 'mqtt',
      };
      delivered[0]!(payload);
      await eventually(
        async () => (await storedByChannel(TENANT_A, PARENTS[TENANT_A]!))['oxygen'] !== undefined,
      );
      expect(await storedByChannel(TENANT_A, PARENTS[TENANT_A]!)).toEqual({ oxygen: [6.4] });

      await plane.onModuleDestroy();
      expect(await lastSeen(TENANT_A, PARENTS[TENANT_A]!)).not.toBeNull();
    });
  });
});
