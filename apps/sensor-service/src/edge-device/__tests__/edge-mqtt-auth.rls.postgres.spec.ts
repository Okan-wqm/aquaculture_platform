import { randomBytes } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import { applyTenantRlsToSchema, getTenantSchemaName } from '@aquaculture/backend-common/database';
import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { DataSource } from 'typeorm';

import { DeviceDirectoryService } from '../device-directory.service';
import { EdgeDeviceDirectory } from '../entities/edge-device-directory.entity';
import { DeviceLifecycleState, DeviceModel, EdgeDevice } from '../entities/edge-device.entity';
import { MqttAuthService } from '../mqtt-auth.service';

/**
 * SENSOR-CRITICAL-143 on real Postgres: the broker's HTTP auth hook (MQTT
 * CONNECT + ACL) and the public provisioning endpoints resolve an edge device
 * with no tenant context. Both `sensor.edge_device_directory` and the tenant
 * `edge_devices` carry the FORCED tenant-isolation policy, and the pool is
 * deny-by-default outside a request, so the previous unscoped reads saw zero
 * rows: every edge gateway was refused at CONNECT.
 *
 * Non-owner runtime role, two tenants, policies armed by the production helper
 * on both the tenant schemas and the `sensor` source schema.
 */

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RUNTIME_ROLE = 'sensor_edge_auth_rls_test';
const CLIENT_ID = 'edge-bbbbbbbb-pond01';
const PASSWORD = 'gateway-secret';

jest.setTimeout(180_000);

describe('edge MQTT auth under FORCE RLS (SENSOR-CRITICAL-143)', () => {
  let harness: HarnessContext | undefined;
  let admin: DataSource | undefined;
  let runtime: DataSource | undefined;
  let auth: MqttAuthService;
  let deviceId = '';

  async function armRls(schema: string): Promise<void> {
    const previousDdlAuthority = process.env['DB_MIGRATE_DDL_AUTHORITY'];
    process.env['DB_MIGRATE_DDL_AUTHORITY'] = '1';
    try {
      const qr = admin!.createQueryRunner();
      await applyTenantRlsToSchema(qr, { schemaOverride: schema });
      await qr.release();
    } finally {
      if (previousDdlAuthority === undefined) delete process.env['DB_MIGRATE_DDL_AUTHORITY'];
      else process.env['DB_MIGRATE_DDL_AUTHORITY'] = previousDdlAuthority;
    }
  }

  beforeAll(async () => {
    harness = await bootPostgresContainer({ startTimeoutMs: 120_000 });
    admin = harness.dataSource;
    const password = randomBytes(24).toString('hex');
    await admin.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await admin.query('CREATE SCHEMA sensor');
    await admin.query(`CREATE ROLE ${RUNTIME_ROLE} LOGIN PASSWORD '${password}'`);

    // The cross-tenant directory lives once in `sensor`.
    const directoryDdl = new DataSource({
      type: 'postgres',
      ...harness.connectionOptions,
      name: 'edge-auth-ddl-sensor',
      entities: [EdgeDeviceDirectory],
      synchronize: true,
      logging: false,
    });
    await directoryDdl.initialize();
    await directoryDdl.destroy();

    const hasher = new MqttAuthService(
      {
        get: (_key: string, fallback?: unknown) => fallback,
      } as Partial<ConfigService> as ConfigService,
      {} as Partial<DeviceDirectoryService> as DeviceDirectoryService,
    );

    for (const tenantId of [TENANT_A, TENANT_B]) {
      const schema = getTenantSchemaName(tenantId);
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const ddl = new DataSource({
        type: 'postgres',
        ...harness.connectionOptions,
        name: `edge-auth-ddl-${schema}`,
        schema,
        entities: [EdgeDevice],
        synchronize: true,
        logging: false,
      });
      await ddl.initialize();
      if (tenantId === TENANT_B) {
        const saved = await ddl.manager.save(
          ddl.manager.create(EdgeDevice, {
            tenantId,
            deviceCode: 'POND-01',
            deviceName: 'Havuz ağ geçidi',
            deviceModel: DeviceModel.RASPBERRY_PI_5,
            lifecycleState: DeviceLifecycleState.ACTIVE,
            mqttClientId: CLIENT_ID,
            mqttPasswordHash: hasher.hashPassword(PASSWORD, 1_000),
            isOnline: false,
          }),
        );
        deviceId = saved.id;
      }
      await ddl.destroy();
      await armRls(schema);
      await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO ${RUNTIME_ROLE}`);
      await admin.query(
        `GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA "${schema}" TO ${RUNTIME_ROLE}`,
      );
    }

    await admin.query(
      `INSERT INTO sensor.edge_device_directory (device_id, device_code, mqtt_client_id, tenant_id)
       VALUES ($1, 'POND-01', $2, $3)`,
      [deviceId, CLIENT_ID, TENANT_B],
    );
    await armRls('sensor');
    await admin.query(`GRANT USAGE ON SCHEMA sensor, public TO ${RUNTIME_ROLE}`);
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON sensor.edge_device_directory TO ${RUNTIME_ROLE}`,
    );

    await admin.query('CREATE SCHEMA IF NOT EXISTS platform');
    await admin.query(`
      CREATE OR REPLACE FUNCTION platform.list_active_tenant_schema_mappings()
      RETURNS TABLE (schema_name text, tenant_id uuid, schema_exists boolean, committed_proof boolean)
      LANGUAGE sql STABLE AS $fn$
        SELECT * FROM (VALUES
          ('${getTenantSchemaName(TENANT_A)}', '${TENANT_A}'::uuid, true, true),
          ('${getTenantSchemaName(TENANT_B)}', '${TENANT_B}'::uuid, true, true)
        ) AS t(schema_name, tenant_id, schema_exists, committed_proof)
      $fn$`);
    await admin.query(`GRANT USAGE ON SCHEMA platform TO ${RUNTIME_ROLE}`);
    await admin.query(
      `GRANT EXECUTE ON FUNCTION platform.list_active_tenant_schema_mappings() TO ${RUNTIME_ROLE}`,
    );

    runtime = new DataSource({
      type: 'postgres',
      ...harness.connectionOptions,
      username: RUNTIME_ROLE,
      password,
      name: `edge-auth-runtime-${randomBytes(4).toString('hex')}`,
      entities: [EdgeDevice, EdgeDeviceDirectory],
      synchronize: false,
      logging: false,
    });
    await runtime.initialize();

    auth = new MqttAuthService(
      new ConfigService({ NODE_ENV: 'production', MQTT_AUTH_MODE: 'http' }),
      new DeviceDirectoryService(runtime),
    );
  });

  afterAll(async () => {
    if (runtime?.isInitialized) await runtime.destroy();
    if (harness) await shutdownHarness(harness);
  });

  it('authenticates an edge gateway at CONNECT (was: refused, zero rows)', async () => {
    await expect(
      auth.verifyDeviceCredentials(CLIENT_ID, PASSWORD, `${CLIENT_ID}-POND-01`),
    ).resolves.toBe(true);
  });

  it('still rejects a wrong password', async () => {
    await expect(
      auth.verifyDeviceCredentials(CLIENT_ID, 'not-the-secret', `${CLIENT_ID}-POND-01`),
    ).resolves.toBe(false);
  });

  it('refuses the right password under a client ID that is not derived from the username (SENSOR-HIGH-144)', async () => {
    await expect(
      auth.verifyDeviceCredentials(CLIENT_ID, PASSWORD, 'aqua-sensor-service-main'),
    ).resolves.toBe(false);
    await expect(auth.verifyDeviceCredentials(CLIENT_ID, PASSWORD, undefined)).resolves.toBe(false);
  });

  it('grants the gateway its own tenant topic and nothing in another tenant', async () => {
    await expect(
      auth.checkTopicAccess(CLIENT_ID, `tenants/${TENANT_B}/devices/${CLIENT_ID}/telemetry`, 2),
    ).resolves.toBe(true);
    await expect(
      auth.checkTopicAccess(CLIENT_ID, `tenants/${TENANT_A}/devices/${CLIENT_ID}/telemetry`, 2),
    ).resolves.toBe(false);
  });

  it('resolves through the per-tenant scan on a directory miss and backfills the directory', async () => {
    await admin!.query('DELETE FROM sensor.edge_device_directory');
    const directory = new DeviceDirectoryService(runtime!);

    const device = await directory.findDevice('device_code', 'POND-01');

    expect(device?.id).toBe(deviceId);
    expect(device?.tenantId).toBe(TENANT_B);
    const rows = await admin!.query('SELECT tenant_id FROM sensor.edge_device_directory');
    expect(rows).toEqual([{ tenant_id: TENANT_B }]);
  });
});
