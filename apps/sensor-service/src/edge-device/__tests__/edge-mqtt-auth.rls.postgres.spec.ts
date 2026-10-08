import { randomBytes } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import { applyTenantRlsToSchema, getTenantSchemaName } from '@aquaculture/backend-common/database';
import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { DataSource, type Repository } from 'typeorm';

import { BackfillEdgeDeviceDirectory1822000000000 } from '../../database/migrations/1822000000000-BackfillEdgeDeviceDirectory';
import { createScheduledJobTestExecutor } from '@aquaculture/backend-common/scheduling/testing';
import { collaborator } from '@aquaculture/testing';

import { DeviceDirectoryService } from '../device-directory.service';
import { EdgeDeviceService } from '../edge-device.service';
import { InstallerScriptService } from '../installer-script.service';
import { EdgeDeviceDirectory } from '../entities/edge-device-directory.entity';
import { DeviceLifecycleState, DeviceModel, EdgeDevice } from '../entities/edge-device.entity';
import { DeviceIoConfig } from '../entities/device-io-config.entity';
import { LoRaDevice } from '../entities/lora-device.entity';
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
 *
 * Every refusal below is paired with an acceptance on the same fixture, so a
 * deny-everything implementation fails this spec as surely as a leaky one.
 */

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RUNTIME_ROLE = 'sensor_edge_auth_rls_test';
const CLIENT_ID = 'edge-bbbbbbbb-pond01';
const PASSWORD = 'gateway-secret';
/** TENANT_A's gateway shares TENANT_B's device_code (codes are per-tenant unique). */
const CLIENT_ID_A = 'edge-aaaaaaaa-pond01';
const PASSWORD_A = 'tenant-a-gateway-secret';
const PENDING_CLIENT_ID = 'edge-bbbbbbbb-pond02';
const REVOKED_CLIENT_ID = 'edge-bbbbbbbb-pond03';
/** A TENANT_A device whose directory row names TENANT_B. */
const MISROUTED_CLIENT_ID = 'edge-aaaaaaaa-pond04';

interface SeedDevice {
  tenantId: string;
  deviceCode: string;
  mqttClientId: string;
  password: string;
  lifecycleState: DeviceLifecycleState;
  /** Tenant the directory row names (defaults to the owning tenant). */
  directoryTenantId?: string;
}

const SEED: readonly SeedDevice[] = [
  {
    tenantId: TENANT_B,
    deviceCode: 'POND-01',
    mqttClientId: CLIENT_ID,
    password: PASSWORD,
    lifecycleState: DeviceLifecycleState.ACTIVE,
  },
  {
    tenantId: TENANT_A,
    deviceCode: 'POND-01',
    mqttClientId: CLIENT_ID_A,
    password: PASSWORD_A,
    lifecycleState: DeviceLifecycleState.ACTIVE,
  },
  {
    tenantId: TENANT_B,
    deviceCode: 'POND-02',
    mqttClientId: PENDING_CLIENT_ID,
    password: PASSWORD,
    lifecycleState: DeviceLifecycleState.PENDING_APPROVAL,
  },
  {
    tenantId: TENANT_B,
    deviceCode: 'POND-03',
    mqttClientId: REVOKED_CLIENT_ID,
    password: PASSWORD,
    lifecycleState: DeviceLifecycleState.REVOKED,
  },
  {
    tenantId: TENANT_A,
    deviceCode: 'POND-04',
    mqttClientId: MISROUTED_CLIENT_ID,
    password: PASSWORD_A,
    lifecycleState: DeviceLifecycleState.ACTIVE,
    directoryTenantId: TENANT_B,
  },
];

jest.setTimeout(180_000);

describe('edge MQTT auth under FORCE RLS (SENSOR-CRITICAL-143)', () => {
  let harness: HarnessContext | undefined;
  let admin: DataSource | undefined;
  let runtime: DataSource | undefined;
  let auth: MqttAuthService;
  const deviceIds = new Map<string, string>();
  const edgeServices: EdgeDeviceService[] = [];

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
      for (const seed of SEED.filter((candidate) => candidate.tenantId === tenantId)) {
        const saved = await ddl.manager.save(
          ddl.manager.create(EdgeDevice, {
            tenantId,
            deviceCode: seed.deviceCode,
            deviceName: 'Havuz ağ geçidi',
            deviceModel: DeviceModel.RASPBERRY_PI_5,
            lifecycleState: seed.lifecycleState,
            mqttClientId: seed.mqttClientId,
            mqttPasswordHash: await hasher.hashPassword(seed.password, 1_000),
            isOnline: false,
          }),
        );
        deviceIds.set(seed.mqttClientId, saved.id);
      }
      await ddl.destroy();
      await armRls(schema);
      await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO ${RUNTIME_ROLE}`);
      await admin.query(
        `GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA "${schema}" TO ${RUNTIME_ROLE}`,
      );
    }

    for (const seed of SEED) {
      await admin.query(
        `INSERT INTO sensor.edge_device_directory (device_id, device_code, mqtt_client_id, tenant_id)
         VALUES ($1, $2, $3, $4)`,
        [
          deviceIds.get(seed.mqttClientId),
          seed.deviceCode,
          seed.mqttClientId,
          seed.directoryTenantId ?? seed.tenantId,
        ],
      );
    }
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
    for (const service of edgeServices) service.onModuleDestroy();
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

  it('refuses the right password under a client ID that is not exactly its own (SENSOR-HIGH-144)', async () => {
    await expect(
      auth.verifyDeviceCredentials(CLIENT_ID, PASSWORD, 'aqua-sensor-service-main'),
    ).resolves.toBe(false);
    await expect(
      auth.verifyDeviceCredentials(CLIENT_ID, PASSWORD, `${CLIENT_ID}-POND-02`),
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

  it("keeps two tenants' gateways with the same device_code apart", async () => {
    // Each authenticates with its own password, never with the other's.
    await expect(
      auth.verifyDeviceCredentials(CLIENT_ID_A, PASSWORD_A, `${CLIENT_ID_A}-POND-01`),
    ).resolves.toBe(true);
    await expect(
      auth.verifyDeviceCredentials(CLIENT_ID_A, PASSWORD, `${CLIENT_ID_A}-POND-01`),
    ).resolves.toBe(false);
    await expect(
      auth.verifyDeviceCredentials(CLIENT_ID, PASSWORD_A, `${CLIENT_ID}-POND-01`),
    ).resolves.toBe(false);

    // Each publishes only under its own tenant, by client ID or by UUID.
    const idA = deviceIds.get(CLIENT_ID_A);
    const idB = deviceIds.get(CLIENT_ID);
    await expect(
      auth.checkTopicAccess(CLIENT_ID_A, `tenants/${TENANT_A}/devices/${idA}/telemetry`, 2),
    ).resolves.toBe(true);
    await expect(
      auth.checkTopicAccess(CLIENT_ID_A, `tenants/${TENANT_B}/devices/${idA}/telemetry`, 2),
    ).resolves.toBe(false);
    await expect(
      auth.checkTopicAccess(CLIENT_ID_A, `tenants/${TENANT_B}/devices/${idB}/telemetry`, 2),
    ).resolves.toBe(false);
    await expect(
      auth.checkTopicAccess(CLIENT_ID, `tenants/${TENANT_B}/devices/${idB}/telemetry`, 2),
    ).resolves.toBe(true);
    await expect(
      auth.checkTopicAccess(CLIENT_ID, `tenants/${TENANT_A}/devices/${idA}/telemetry`, 2),
    ).resolves.toBe(false);
  });

  it('refuses a device whose directory row names the wrong tenant, and admits it once the route is right', async () => {
    const id = deviceIds.get(MISROUTED_CLIENT_ID);
    const clientId = `${MISROUTED_CLIENT_ID}-POND-04`;
    await expect(
      auth.verifyDeviceCredentials(MISROUTED_CLIENT_ID, PASSWORD_A, clientId),
    ).resolves.toBe(false);
    await expect(
      auth.checkTopicAccess(MISROUTED_CLIENT_ID, `tenants/${TENANT_B}/devices/${id}/telemetry`, 2),
    ).resolves.toBe(false);

    await admin!.query(
      'UPDATE sensor.edge_device_directory SET tenant_id = $1 WHERE device_id = $2',
      [TENANT_A, id],
    );
    // A fresh service: the first one cached the miss for 30 s.
    const fresh = new MqttAuthService(
      new ConfigService({ NODE_ENV: 'production', MQTT_AUTH_MODE: 'http' }),
      new DeviceDirectoryService(runtime!),
    );
    await expect(
      fresh.verifyDeviceCredentials(MISROUTED_CLIENT_ID, PASSWORD_A, clientId),
    ).resolves.toBe(true);
  });

  it('refuses a PENDING_APPROVAL device holding a valid password until it is approved', async () => {
    const id = deviceIds.get(PENDING_CLIENT_ID);
    const clientId = `${PENDING_CLIENT_ID}-POND-02`;
    const ownTopic = `tenants/${TENANT_B}/devices/${id}/telemetry`;
    await expect(auth.verifyDeviceCredentials(PENDING_CLIENT_ID, PASSWORD, clientId)).resolves.toBe(
      false,
    );
    await expect(auth.checkTopicAccess(PENDING_CLIENT_ID, ownTopic, 2)).resolves.toBe(false);

    // Approval (edge-device.service approveDevice) — the very next CONNECT and
    // ACL check see it; nothing cached the refusal.
    await admin!.query(
      `UPDATE "${getTenantSchemaName(TENANT_B)}".edge_devices SET lifecycle_state = 'active' WHERE id = $1`,
      [id],
    );
    await expect(auth.verifyDeviceCredentials(PENDING_CLIENT_ID, PASSWORD, clientId)).resolves.toBe(
      true,
    );
    await expect(auth.checkTopicAccess(PENDING_CLIENT_ID, ownTopic, 2)).resolves.toBe(true);
  });

  it('refuses a REVOKED device at CONNECT and on its own topic', async () => {
    const id = deviceIds.get(REVOKED_CLIENT_ID);
    await expect(
      auth.verifyDeviceCredentials(REVOKED_CLIENT_ID, PASSWORD, `${REVOKED_CLIENT_ID}-POND-03`),
    ).resolves.toBe(false);
    await expect(
      auth.checkTopicAccess(REVOKED_CLIENT_ID, `tenants/${TENANT_B}/devices/${id}/telemetry`, 2),
    ).resolves.toBe(false);
  });

  /** EdgeDeviceService over the runtime role; only the tenant-boundary paths are live. */
  function edgeDevices(): EdgeDeviceService {
    const service = new EdgeDeviceService(
      collaborator<Repository<EdgeDevice>>({}, 'EdgeDeviceRepository'),
      collaborator<Repository<DeviceIoConfig>>({}, 'DeviceIoConfigRepository'),
      collaborator<Repository<LoRaDevice>>({}, 'LoRaDeviceRepository'),
      runtime!,
      createScheduledJobTestExecutor().executor,
      null,
      collaborator<InstallerScriptService>({}, 'InstallerScriptService'),
      new ConfigService({}),
      new DeviceDirectoryService(runtime!),
    );
    edgeServices.push(service);
    return service;
  }

  async function deviceRow(
    tenantId: string,
    mqttClientId: string,
  ): Promise<{ is_online: boolean; lifecycle_state: string; cpu_usage: number | null }> {
    const rows: Array<{ is_online: boolean; lifecycle_state: string; cpu_usage: number | null }> =
      await admin!.query(
        `SELECT is_online, lifecycle_state, cpu_usage
           FROM "${getTenantSchemaName(tenantId)}".edge_devices WHERE mqtt_client_id = $1`,
        [mqttClientId],
      );
    const row = rows[0];
    if (row === undefined) throw new Error(`no seeded device ${mqttClientId}`);
    return row;
  }

  it('records a heartbeat in the publishing tenant only (was: dropped as unknown under FORCE RLS)', async () => {
    const service = edgeDevices();
    const idB = deviceIds.get(CLIENT_ID)!;
    const idA = deviceIds.get(CLIENT_ID_A)!;

    const updated = await service.updateHeartbeat({
      deviceCode: idB,
      tenantId: TENANT_B,
      isOnline: true,
      cpuUsage: 42,
    });
    expect(updated?.id).toBe(idB);
    expect(await deviceRow(TENANT_B, CLIENT_ID)).toMatchObject({ is_online: true, cpu_usage: 42 });

    // TENANT_A's device UUID published under TENANT_B's topic resolves nothing
    // and writes nothing.
    await expect(
      service.updateHeartbeat({
        deviceCode: idA,
        tenantId: TENANT_B,
        isOnline: true,
        cpuUsage: 99,
      }),
    ).resolves.toBeNull();
    expect(await deviceRow(TENANT_A, CLIENT_ID_A)).toMatchObject({
      is_online: false,
      cpu_usage: null,
    });

    // A tenant-less (legacy) heartbeat resolves the owning tenant through the directory.
    await expect(
      service.updateHeartbeat({ deviceCode: idA, isOnline: true, cpuUsage: 7 }),
    ).resolves.toMatchObject({ id: idA, tenantId: TENANT_A });
    expect(await deviceRow(TENANT_A, CLIENT_ID_A)).toMatchObject({ is_online: true, cpu_usage: 7 });
  });

  it('marks stale in-service devices offline in every tenant, and leaves a revoked one revoked', async () => {
    for (const [tenantId, clientId] of [
      [TENANT_A, CLIENT_ID_A],
      [TENANT_B, CLIENT_ID],
      [TENANT_B, REVOKED_CLIENT_ID],
    ] as const) {
      await admin!.query(
        `UPDATE "${getTenantSchemaName(tenantId)}".edge_devices
            SET is_online = true, last_seen_at = now() - interval '10 minutes'
          WHERE mqtt_client_id = $1`,
        [clientId],
      );
    }

    await expect(edgeDevices().markStaleDevicesOffline(5)).resolves.toBe(2);

    expect(await deviceRow(TENANT_A, CLIENT_ID_A)).toMatchObject({
      is_online: false,
      lifecycle_state: 'offline',
    });
    expect(await deviceRow(TENANT_B, CLIENT_ID)).toMatchObject({
      is_online: false,
      lifecycle_state: 'offline',
    });
    expect(await deviceRow(TENANT_B, REVOKED_CLIENT_ID)).toMatchObject({
      is_online: true,
      lifecycle_state: 'revoked',
    });
  });

  it('denies on a directory miss (no tenant scan), and the backfill migration restores the route', async () => {
    await admin!.query('DELETE FROM sensor.edge_device_directory');
    const fresh = (): MqttAuthService =>
      new MqttAuthService(
        new ConfigService({ NODE_ENV: 'production', MQTT_AUTH_MODE: 'http' }),
        new DeviceDirectoryService(runtime!),
      );

    await expect(
      fresh().verifyDeviceCredentials(CLIENT_ID, PASSWORD, `${CLIENT_ID}-POND-01`),
    ).resolves.toBe(false);

    // The migration runner's per-tenant pass, as the non-owner runtime role
    // under FORCE RLS on both tables, plus the source-schema pass (a no-op).
    for (const schema of ['sensor', getTenantSchemaName(TENANT_A), getTenantSchemaName(TENANT_B)]) {
      const qr = runtime!.createQueryRunner();
      await qr.connect();
      try {
        await qr.query(`SET search_path TO "${schema}", public`);
        await qr.startTransaction();
        await new BackfillEdgeDeviceDirectory1822000000000().up(qr);
        await qr.commitTransaction();
        // Re-run: idempotent.
        await new BackfillEdgeDeviceDirectory1822000000000().up(qr);
      } finally {
        await qr.release();
      }
    }

    const rows: Array<{ tenant_id: string; n: string }> = await admin!.query(
      `SELECT tenant_id, count(*) AS n FROM sensor.edge_device_directory
        GROUP BY tenant_id ORDER BY tenant_id`,
    );
    expect(rows).toEqual([
      { tenant_id: TENANT_A, n: '2' },
      { tenant_id: TENANT_B, n: '3' },
    ]);
    await expect(
      fresh().verifyDeviceCredentials(CLIENT_ID, PASSWORD, `${CLIENT_ID}-POND-01`),
    ).resolves.toBe(true);
    await expect(
      fresh().verifyDeviceCredentials(CLIENT_ID_A, PASSWORD_A, `${CLIENT_ID_A}-POND-01`),
    ).resolves.toBe(true);
  });
});
