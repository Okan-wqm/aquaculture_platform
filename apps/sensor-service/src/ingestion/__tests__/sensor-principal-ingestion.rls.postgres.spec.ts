import { collaborator } from '@aquaculture/testing';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';

import {
  bootSensorRlsHarness,
  type SensorRlsHarness,
} from '../../__tests__/support/sensor-rls-postgres.harness';
import { ErasedTenantTombstoneService } from '../../compliance/erasure/erased-tenant-tombstone.service';
import { SensorDataChannel } from '../../database/entities/sensor-data-channel.entity';
import { SensorMetric } from '../../database/entities/sensor-metric.entity';
import { SensorProtocol } from '../../database/entities/sensor-protocol.entity';
import { SensorTypeDefinition } from '../../database/entities/sensor-type-definition.entity';
import { Sensor } from '../../database/entities/sensor.entity';
import { CreateSensorOutbox1800400000000 } from '../../database/migrations/1800400000000-CreateSensorOutbox';
import { AuditLog } from '../../infrastructure/audit/audit-log.entity';
import { SensorDataPromotion } from '../../mqtt-identity/sensor-data-promotion.service';
import { sensorMqttDataTopic } from '../../mqtt-identity/sensor-mqtt-topic';
import { SensorOutbox } from '../../outbox/sensor-outbox.entity';
import { SensorMetricWriterService } from '../sensor-metric-writer.service';
import { SensorPrincipalIngestion } from '../sensor-principal-ingestion.service';
import { SensorReadingRecorder } from '../sensor-reading-recorder.service';

/**
 * The route of a sensor publishing with its own broker principal
 * (ADR-047 §4, §5) on real Postgres, FORCE RLS on, non-owner runtime role:
 * the first message that stores a reading promotes the sensor and its child
 * to ACTIVE and enqueues one SensorRegistrationCompleted with it; later
 * messages only store readings; numeric strings, retained messages, a topic
 * naming another tenant, a suspended or credential-less sensor, an erased
 * tenant and a flood are dropped without writing; an untrusted timestamp
 * falls back to the receive time.
 */

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ENTITIES = [
  Sensor,
  SensorDataChannel,
  SensorMetric,
  SensorProtocol,
  SensorTypeDefinition,
  SensorOutbox,
];

jest.setTimeout(180_000);

describe('SensorPrincipalIngestion under FORCE RLS', () => {
  let stage: SensorRlsHarness | undefined;
  let admin: DataSource | undefined;
  let ingestion: SensorPrincipalIngestion;
  let tombstone: ErasedTenantTombstoneService;
  let schemaA = '';
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    stage = await bootSensorRlsHarness({
      name: 'sensor_principal_ingestion',
      tenants: [TENANT_A, TENANT_B],
      entities: ENTITIES,
      sourceEntities: [AuditLog],
      beforeRls: async ({ admin: owner, tenantId, schema }) => {
        if (tenantId !== TENANT_A) {
          return;
        }
        const insert = async (
          name: string,
          extra: { username?: string; parent?: string; status?: string } = {},
        ): Promise<string> => {
          const [row] = await owner.query(
            `INSERT INTO "${schema}".sensors
                 (tenant_id, name, serial_number, type, status, is_active, registration_status,
                  parent_id, is_parent_device, mqtt_username, mqtt_secret_hmac, mqtt_secret_key_id)
               VALUES ($1, $2, $2, 'multi_parameter', 'inactive', false, $3, $4, $5, $6, $7, $8)
             RETURNING id`,
            [
              tenantId,
              name,
              extra.status ?? 'draft',
              extra.parent ?? null,
              name === 'principal',
              extra.username ?? null,
              extra.username ? 'f'.repeat(64) : null,
              extra.username ? 'k1' : null,
            ],
          );
          ids[name] = row.id;
          return row.id;
        };
        const channel = async (sensorId: string, key: string, order: number): Promise<void> => {
          await owner.query(
            `INSERT INTO "${schema}".sensor_data_channels
                 (sensor_id, tenant_id, channel_key, display_label, data_type, unit, "dataPath",
                  "minValue", "maxValue", is_enabled, display_order)
               VALUES ($1, $2, $3, $3, 'number', 'u', $3, -100, 100, true, $4)`,
            [sensorId, tenantId, key, order],
          );
        };
        const principal = await insert('principal', { username: `s${'a'.repeat(22)}` });
        await insert('child', { parent: principal });
        await channel(principal, 'ph', 1);
        await channel(principal, 'temperature', 2);
        const suspended = await insert('suspended', {
          username: `s${'b'.repeat(22)}`,
          status: 'suspended',
        });
        await channel(suspended, 'ph', 1);
        const legacy = await insert('legacy');
        await channel(legacy, 'ph', 1);
        const flooded = await insert('flooded', { username: `s${'c'.repeat(22)}` });
        await channel(flooded, 'ph', 1);
      },
    });
    admin = stage.admin;
    schemaA = stage.schemaOf(TENANT_A);

    const outboxDdl = admin.createQueryRunner();
    try {
      await new CreateSensorOutbox1800400000000().up(outboxDdl);
    } finally {
      await outboxDdl.release();
    }
    await admin.query(`GRANT SELECT, INSERT ON sensor.sensor_outbox TO ${stage.runtimeRole}`);

    const outbox = new OutboxPublisher(SensorOutbox);
    tombstone = new ErasedTenantTombstoneService(
      collaborator<DataSource>({}, 'DataSource (the tombstone is asked in memory only)'),
    );
    ingestion = new SensorPrincipalIngestion(
      stage.runtime,
      new SensorReadingRecorder(new SensorMetricWriterService(stage.runtime), outbox),
      new SensorDataPromotion(outbox),
      tombstone,
    );
  });

  afterAll(async () => {
    await stage?.shutdown();
  });

  const topicOf = (name: string, tenantId = TENANT_A): string =>
    sensorMqttDataTopic(tenantId, ids[name]!);
  const send = (topic: string, payload: unknown, retain = false, at = new Date()) =>
    ingestion.handle(topic, Buffer.from(JSON.stringify(payload)), { retain }, at);

  async function sensorRow(name: string): Promise<Record<string, unknown>> {
    const [row] = await admin!.query(
      `SELECT registration_status, is_active, last_seen_at FROM "${schemaA}".sensors WHERE id = $1`,
      [ids[name]],
    );
    return row;
  }

  async function metricsOf(name: string): Promise<Array<{ time: Date; value: string }>> {
    return admin!.query(
      `SELECT time, value FROM "${schemaA}".sensor_metrics WHERE sensor_id = $1 ORDER BY time`,
      [ids[name]],
    );
  }

  async function outboxEvents(eventType: string): Promise<Array<Record<string, unknown>>> {
    return admin!.query(
      `SELECT payload FROM sensor.sensor_outbox WHERE "eventType" = $1 AND payload->>'sensorId' = $2`,
      [eventType, ids['principal']],
    );
  }

  it('stores the first reading, and promotes the sensor and its child with it, once', async () => {
    const receivedAt = new Date();
    const sampled = new Date(receivedAt.getTime() - 10_000);

    await expect(
      send(
        topicOf('principal'),
        { ph: 7.1, temperature: 18.4, timestamp: sampled.toISOString() },
        false,
        receivedAt,
      ),
    ).resolves.toEqual({
      kind: 'recorded',
      tenantId: TENANT_A,
      sensorId: ids['principal'],
      rows: 2,
      promoted: true,
    });

    const metrics = await metricsOf('principal');
    expect(metrics.map((row) => Number(row.value)).sort()).toEqual([18.4, 7.1].sort());
    expect(metrics.every((row) => row.time.getTime() === sampled.getTime())).toBe(true);
    for (const name of ['principal', 'child']) {
      expect(await sensorRow(name)).toMatchObject({
        registration_status: 'active',
        is_active: true,
      });
    }
    expect((await sensorRow('principal'))['last_seen_at']).not.toBeNull();
    const completed = await outboxEvents('SensorRegistrationCompleted');
    expect(completed).toHaveLength(1);
    expect(completed[0]!['payload']).toMatchObject({
      protocolCode: 'MQTT',
      connectionTestPassed: true,
    });
    const audits: unknown[] = await admin!.query(
      `SELECT 1 FROM sensor.sensor_audit_logs WHERE entity_id = ANY($1::uuid[])`,
      [[ids['principal'], ids['child']]],
    );
    expect(audits).toHaveLength(2);

    await expect(send(topicOf('principal'), { ph: 7.2 })).resolves.toMatchObject({
      kind: 'recorded',
      promoted: false,
    });
    expect(await outboxEvents('SensorRegistrationCompleted')).toHaveLength(1);
  });

  it('refuses numeric strings on this route', async () => {
    const before = (await metricsOf('principal')).length;
    await expect(send(topicOf('principal'), { ph: '7.3' })).resolves.toEqual({
      kind: 'dropped',
      reason: 'no_channel_value',
    });
    expect(await metricsOf('principal')).toHaveLength(before);
  });

  it('drops a retained message and a payload outside the schema before reading anything', async () => {
    await expect(send(topicOf('principal'), { ph: 7 }, true)).resolves.toEqual({
      kind: 'dropped',
      reason: 'retained',
    });
    await expect(send(topicOf('principal'), [7])).resolves.toEqual({
      kind: 'dropped',
      reason: 'schema',
    });
  });

  it("finds nothing under another tenant's id, a suspended sensor or one without a credential", async () => {
    await expect(send(topicOf('principal', TENANT_B), { ph: 7 })).resolves.toEqual({
      kind: 'dropped',
      reason: 'no_sensor',
    });
    for (const name of ['suspended', 'legacy']) {
      await expect(send(topicOf(name), { ph: 7 })).resolves.toEqual({
        kind: 'dropped',
        reason: 'no_sensor',
      });
      expect(await metricsOf(name)).toEqual([]);
    }
  });

  it('stores a reading at its receive time when the payload time is outside the trusted skew', async () => {
    const receivedAt = new Date(Date.now() + 5_000);
    const stale = new Date(receivedAt.getTime() - 2 * 3_600_000);
    await send(
      topicOf('principal'),
      { ph: 6.9, timestamp: stale.toISOString() },
      false,
      receivedAt,
    );

    const metrics = await metricsOf('principal');
    expect(metrics.some((row) => row.time.getTime() === stale.getTime())).toBe(false);
    expect(metrics.some((row) => row.time.getTime() === receivedAt.getTime())).toBe(true);
  });

  it('caps one sensor at its burst before any database work', async () => {
    const at = new Date();
    const outcomes = [];
    for (let i = 0; i < 11; i += 1) {
      outcomes.push(await send(topicOf('flooded'), { ph: 7 }, false, at));
    }
    expect(outcomes.filter((outcome) => outcome.kind === 'recorded')).toHaveLength(10);
    expect(outcomes[10]).toEqual({ kind: 'dropped', reason: 'rate_limited' });
  });

  it("drops an erased tenant's message first", async () => {
    tombstone.markErased(TENANT_A);
    await expect(send(topicOf('principal'), { ph: 7 })).resolves.toEqual({
      kind: 'dropped',
      reason: 'erased_tenant',
    });
  });
});
