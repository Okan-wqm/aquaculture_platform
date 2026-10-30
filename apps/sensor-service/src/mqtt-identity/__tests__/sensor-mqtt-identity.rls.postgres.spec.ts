import { runInTenantTransaction, SENSOR_SOURCE_SCHEMA } from '@aquaculture/backend-common/database';
import { SENSOR_MQTT_IDENTITY_ERROR } from '@aquaculture/shared-contracts';
import { collaborator } from '@aquaculture/testing';
import { HttpException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { OutboxPublisher } from '@platform/outbox';
import type { DataSource, QueryRunner } from 'typeorm';

import {
  bootSensorRlsHarness,
  type SensorRlsHarness,
} from '../../__tests__/support/sensor-rls-postgres.harness';
import { AddSensorMqttIdentity1826000000000 } from '../../database/migrations/1826000000000-AddSensorMqttIdentity';
import { SensorDataChannel } from '../../database/entities/sensor-data-channel.entity';
import {
  ConnectionType,
  ProtocolCategory,
  SensorProtocol,
} from '../../database/entities/sensor-protocol.entity';
import { SensorTypeDefinition } from '../../database/entities/sensor-type-definition.entity';
import { Sensor } from '../../database/entities/sensor.entity';
import { AuditLog } from '../../infrastructure/audit/audit-log.entity';
import { SensorMqttDirectory } from '../sensor-mqtt-directory.entity';
import { SensorMqttIdentityService } from '../sensor-mqtt-identity.service';
import { SensorMqttKeyringService } from '../sensor-mqtt-keyring.service';
import { SENSOR_MQTT_USERNAME_PATTERN } from '../sensor-mqtt-secret';

/**
 * A sensor's own broker principal on real Postgres, with the migration's
 * checks and trigger, FORCE RLS on the tenant schema and on the directory, and
 * a non-owner runtime role (ADR-047 §1, §6): issuing writes the username and
 * the HMAC (never the secret) and routes the username; rotating unroutes the
 * old one in the same statement; deleting the sensor unroutes it; a sensor
 * that cannot hold a principal is refused with nothing written; and a copy of
 * the row loaded before a rotation, saved after it, cannot put the old
 * username back.
 */

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OPERATOR = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
const KEYRING = JSON.stringify([{ kid: 'k-test-1', secret: 'ab'.repeat(32), status: 'active' }]);
const LEGACY_CONFIGURATION = {
  brokerUrl: 'mqtt://mosquitto',
  port: 1883,
  topic: 'sensors/farm-01/water-quality',
  username: 'typed-in-the-wizard',
  qos: 1,
  payloadFormat: 'json',
};

jest.setTimeout(180_000);

function keyringService(raw: string | undefined): SensorMqttKeyringService {
  // Untyped so it stands in for ConfigService's generic get<T>.
  const get = jest.fn();
  get.mockImplementation((key: string) =>
    key === 'MQTT_SENSOR_SECRET_KEYRING' ? raw : key === 'NODE_ENV' ? 'test' : undefined,
  );
  const service = new SensorMqttKeyringService(
    collaborator<ConfigService>({ get }, 'ConfigService'),
  );
  service.onModuleInit();
  return service;
}

function endpointConfig(): ConfigService {
  const get = jest.fn();
  get.mockImplementation((key: string, fallback?: unknown) =>
    key === 'MQTT_PUBLIC_BROKER_HOST'
      ? 'mqtt.example.test'
      : key === 'MQTT_BROKER_PORT'
        ? 8883
        : fallback,
  );
  return collaborator<ConfigService>({ get }, 'ConfigService');
}

/** One migration pass the way db-migrate runs it: its DDL authority, search_path pinned, one transaction. */
async function migrationPass(
  admin: DataSource,
  schema: string,
  run: (qr: QueryRunner) => Promise<void>,
): Promise<void> {
  const previous = process.env['DB_MIGRATE_DDL_AUTHORITY'];
  process.env['DB_MIGRATE_DDL_AUTHORITY'] = '1';
  const qr = admin.createQueryRunner();
  try {
    await qr.query(`SET search_path TO "${schema}", public`);
    await qr.startTransaction();
    await run(qr);
    await qr.commitTransaction();
  } finally {
    await qr.release();
    if (previous === undefined) delete process.env['DB_MIGRATE_DDL_AUTHORITY'];
    else process.env['DB_MIGRATE_DDL_AUTHORITY'] = previous;
  }
}

describe('SensorMqttIdentityService under FORCE RLS', () => {
  let stage: SensorRlsHarness | undefined;
  let service: SensorMqttIdentityService;
  const ids: Record<string, string> = {};
  const enqueue = jest.fn().mockResolvedValue(undefined);

  beforeAll(async () => {
    stage = await bootSensorRlsHarness({
      name: 'sensor_mqtt_identity',
      tenants: [TENANT_A],
      entities: [Sensor, SensorDataChannel, SensorProtocol, SensorTypeDefinition],
      sourceEntities: [AuditLog, SensorMqttDirectory],
      beforeRls: async ({ admin, ddl, schema }) => {
        const protocol = async (code: string): Promise<string> => {
          const saved = await ddl.manager.save(
            ddl.manager.create(SensorProtocol, {
              code,
              name: code,
              category: ProtocolCategory.IOT,
              connectionType: ConnectionType.TCP,
              configurationSchema: { type: 'object', properties: {} },
            }),
          );
          return saved.id;
        };
        const mqtt = await protocol('MQTT');
        const modbus = await protocol('MODBUS_TCP');
        const insert = async (
          name: string,
          tenantId: string,
          extra: { protocolId: string; parent?: string; isParent?: boolean },
        ): Promise<void> => {
          const [row] = await admin.query(
            `INSERT INTO "${schema}".sensors
                 (tenant_id, name, serial_number, type, status, is_active, protocol_id,
                  protocol_configuration, is_parent_device, parent_id)
               VALUES ($1, $2, $2, 'multi_parameter', 'active', true, $3, $4, $5, $6)
             RETURNING id`,
            [
              tenantId,
              name,
              extra.protocolId,
              JSON.stringify(LEGACY_CONFIGURATION),
              extra.isParent ?? false,
              extra.parent ?? null,
            ],
          );
          ids[name] = row.id;
        };
        await insert('standalone', TENANT_A, { protocolId: mqtt });
        await insert('parent', TENANT_A, { protocolId: mqtt, isParent: true });
        await insert('child', TENANT_A, { protocolId: mqtt, parent: ids['parent'] });
        await insert('modbus', TENANT_A, { protocolId: modbus });
        await insert('doomed', TENANT_A, { protocolId: mqtt });
        // Another tenant's row inside this tenant's schema: only RLS hides it.
        await insert('intruder', TENANT_B, { protocolId: mqtt });
      },
    });
    const migration = new AddSensorMqttIdentity1826000000000();
    await migrationPass(stage.admin, 'sensor', (qr) => migration.up(qr));
    await migrationPass(stage.admin, stage.schemaOf(TENANT_A), (qr) => migration.up(qr));
    service = new SensorMqttIdentityService(
      stage.runtime,
      keyringService(KEYRING),
      endpointConfig(),
      collaborator<OutboxPublisher>({ enqueue }, 'OutboxPublisher'),
    );
  });

  afterAll(async () => {
    await stage?.shutdown();
  });

  async function stored(name: string): Promise<Record<string, unknown>> {
    const [row] = await stage!.admin.query(
      `SELECT mqtt_username, mqtt_secret_hmac, mqtt_secret_key_id, protocol_configuration, name
         FROM "${stage!.schemaOf(TENANT_A)}".sensors WHERE id = $1`,
      [ids[name]],
    );
    return row;
  }

  async function routes(where: string, value: string): Promise<Array<Record<string, unknown>>> {
    return stage!.admin.query(
      `SELECT mqtt_username, sensor_id, tenant_id FROM sensor.sensor_mqtt_directory WHERE ${where} = $1`,
      [value],
    );
  }

  it('issues a credential: stores its HMAC, routes the username and drops the legacy topic', async () => {
    const issued = await service.rotate(TENANT_A, ids['standalone']!, OPERATOR);

    expect(issued).toMatchObject({
      sensorId: ids['standalone'],
      host: 'mqtt.example.test',
      port: 8883,
      tls: true,
      topic: `tenants/${TENANT_A}/sensors/${ids['standalone']}/data`,
    });
    expect(issued.username).toMatch(SENSOR_MQTT_USERNAME_PATTERN);
    expect(issued.clientId).toBe(issued.username);
    expect(issued.password).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const row = await stored('standalone');
    expect(row['mqtt_username']).toBe(issued.username);
    expect(row['mqtt_secret_key_id']).toBe('k-test-1');
    expect(row['mqtt_secret_hmac']).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(issued.password);
    expect(row['protocol_configuration']).toEqual({ payloadFormat: 'json' });
    expect(await routes('mqtt_username', issued.username)).toEqual([
      { mqtt_username: issued.username, sensor_id: ids['standalone'], tenant_id: TENANT_A },
    ]);

    const principal = await service.findPrincipal(issued.username);
    expect(principal).toMatchObject({ tenantId: TENANT_A, sensorId: ids['standalone'] });
    expect(service.verifySecret(principal!, issued.password)).toBe(true);
    expect(service.verifySecret(principal!, `${issued.password}x`)).toBe(false);

    const [audit] = await stage!.admin.query(
      `SELECT changed_by, previous_value, new_value FROM sensor.sensor_audit_logs
        WHERE entity_id = $1`,
      [ids['standalone']],
    );
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'SensorConfigurationUpdated',
        sensorId: ids['standalone'],
        changedFields: ['mqttUsername', 'protocolConfiguration'],
      }),
      expect.anything(),
    );
    expect(audit).toMatchObject({
      changed_by: OPERATOR,
      previous_value: { mqttUsername: null, mqttTopic: LEGACY_CONFIGURATION.topic },
      new_value: { mqttUsername: issued.username, mqttTopic: issued.topic },
    });
  });

  it('rotating unroutes the old username in the same statement', async () => {
    const first = await service.rotate(TENANT_A, ids['parent']!, OPERATOR);
    const second = await service.rotate(TENANT_A, ids['parent']!, OPERATOR);

    expect(second.username).not.toBe(first.username);
    expect(await service.findPrincipal(first.username)).toBeNull();
    expect(await routes('sensor_id', ids['parent']!)).toEqual([
      { mqtt_username: second.username, sensor_id: ids['parent'], tenant_id: TENANT_A },
    ]);
    const principal = await service.findPrincipal(second.username);
    expect(service.verifySecret(principal!, first.password)).toBe(false);
    expect(service.verifySecret(principal!, second.password)).toBe(true);
  });

  it('a copy loaded before a rotation, saved after it, keeps the new username', async () => {
    const stale = await runInTenantTransaction(
      stage!.runtime,
      SENSOR_SOURCE_SCHEMA,
      TENANT_A,
      (qr) => qr.manager.findOneByOrFail(Sensor, { id: ids['parent']! }),
    );
    const current = await service.rotate(TENANT_A, ids['parent']!, OPERATOR);
    await runInTenantTransaction(stage!.runtime, SENSOR_SOURCE_SCHEMA, TENANT_A, (qr) =>
      qr.manager.save(Sensor, Object.assign(stale, { name: 'renamed parent' })),
    );

    expect(await stored('parent')).toMatchObject({
      name: 'renamed parent',
      mqtt_username: current.username,
    });
    expect(await service.findPrincipal(current.username)).not.toBeNull();
  });

  it('deleting the sensor unroutes its username', async () => {
    const issued = await service.rotate(TENANT_A, ids['doomed']!, OPERATOR);
    await runInTenantTransaction(stage!.runtime, SENSOR_SOURCE_SCHEMA, TENANT_A, (qr) =>
      qr.manager.delete(Sensor, { id: ids['doomed']! }),
    );

    expect(await routes('mqtt_username', issued.username)).toEqual([]);
    expect(await service.findPrincipal(issued.username)).toBeNull();
  });

  it('revoking clears the credential and unroutes it in the suspension transaction', async () => {
    const issued = await service.rotate(TENANT_A, ids['standalone']!, OPERATOR);
    await runInTenantTransaction(stage!.runtime, SENSOR_SOURCE_SCHEMA, TENANT_A, (qr) =>
      service.revoke(qr.manager, TENANT_A, ids['standalone']!, OPERATOR),
    );

    expect(await stored('standalone')).toMatchObject({
      mqtt_username: null,
      mqtt_secret_hmac: null,
      mqtt_secret_key_id: null,
    });
    expect(await routes('mqtt_username', issued.username)).toEqual([]);
    expect(await service.findPrincipal(issued.username)).toBeNull();
    const audits: Array<{ new_value: Record<string, unknown> }> = await stage!.admin.query(
      `SELECT new_value FROM sensor.sensor_audit_logs WHERE entity_id = $1 ORDER BY changed_at`,
      [ids['standalone']],
    );
    expect(audits.at(-1)?.new_value).toEqual({ mqttUsername: null });

    // Revoking a sensor that holds none changes nothing.
    await runInTenantTransaction(stage!.runtime, SENSOR_SOURCE_SCHEMA, TENANT_A, (qr) =>
      service.revoke(qr.manager, TENANT_A, ids['standalone']!, OPERATOR),
    );
    const after: unknown[] = await stage!.admin.query(
      `SELECT 1 FROM sensor.sensor_audit_logs WHERE entity_id = $1`,
      [ids['standalone']],
    );
    expect(after).toHaveLength(audits.length);
  });

  async function refusal(promise: Promise<unknown>): Promise<unknown> {
    const error = await promise.then(
      () => null,
      (caught: unknown) => caught,
    );
    if (!(error instanceof HttpException)) {
      throw new Error(`expected a refusal, got ${String(error)}`);
    }
    return error.getResponse();
  }

  it('refuses a child and a sensor that does not speak MQTT, writing nothing', async () => {
    expect(await refusal(service.rotate(TENANT_A, ids['child']!, OPERATOR))).toMatchObject({
      code: SENSOR_MQTT_IDENTITY_ERROR.FOLLOWS_PARENT,
    });
    expect(await refusal(service.rotate(TENANT_A, ids['modbus']!, OPERATOR))).toMatchObject({
      code: SENSOR_MQTT_IDENTITY_ERROR.NOT_MQTT,
    });
    for (const name of ['child', 'modbus']) {
      expect((await stored(name))['mqtt_username']).toBeNull();
      expect(await routes('sensor_id', ids[name]!)).toEqual([]);
    }
  });

  it("does not find another tenant's sensor", async () => {
    await expect(service.rotate(TENANT_A, ids['intruder']!, OPERATOR)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('issues nothing without a keyring', async () => {
    const closed = new SensorMqttIdentityService(
      stage!.runtime,
      keyringService(undefined),
      endpointConfig(),
      collaborator<OutboxPublisher>({ enqueue }, 'OutboxPublisher'),
    );
    expect(await refusal(closed.rotate(TENANT_A, ids['standalone']!, OPERATOR))).toMatchObject({
      code: SENSOR_MQTT_IDENTITY_ERROR.UNAVAILABLE,
    });
  });

  it('keeps a username off a child sensor at the database too', async () => {
    await expect(
      stage!.admin.query(
        `UPDATE "${stage!.schemaOf(TENANT_A)}".sensors
            SET mqtt_username = $2, mqtt_secret_hmac = $3, mqtt_secret_key_id = 'k-test-1'
          WHERE id = $1`,
        [ids['child'], `s${'c'.repeat(22)}`, 'f'.repeat(64)],
      ),
    ).rejects.toThrow(/CHK_sensors_mqtt_identity_principal/);
  });
});
