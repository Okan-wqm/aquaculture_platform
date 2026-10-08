import { randomBytes, randomUUID } from 'node:crypto';

import {
  getTenantErasureTargetOptions,
  TenantErasureTargetExecutor,
} from '@aquaculture/backend-common/compliance';
import { applyTenantRlsToSchema, getTenantSchemaName } from '@aquaculture/backend-common/database';
import { createBaseEvent, type TenantErasureRequestedEvent } from '@platform/event-contracts';
import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { buildTenantErasureTargetProofLedgerUpSql } from '@platform/outbox';
import { DataSource } from 'typeorm';

import { EdgeDeviceDirectory } from '../../../edge-device/entities/edge-device-directory.entity';
import {
  DeviceLifecycleState,
  DeviceModel,
  EdgeDevice,
} from '../../../edge-device/entities/edge-device.entity';
import { TenantProvisioningKeyDirectory } from '../../../edge-device/entities/tenant-provisioning-key-directory.entity';
import { EdgeRouteDirectoryPurgeHook } from '../edge-route-directory-purge.hook';

/**
 * PLAT-CRITICAL (tenant erasure was a no-op under pool RLS), sensor-service's
 * `tenant-schema-module` mode, on real Postgres: FORCE RLS on the tenant
 * schemas and on `sensor`, a non-owner NOBYPASSRLS runtime role, and the pool
 * session left as RlsConnectionBootstrap leaves it outside a request
 * (`app.current_tenant = ''`, bypass off). The erasure must remove the erased
 * tenant's edge devices and both route-table rows and leave the other tenant's
 * rows alone. Against the unbound executor every DELETE matched zero rows.
 */

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RUNTIME_ROLE = 'sensor_erasure_rls_test';

jest.setTimeout(240_000);

function erasureRequest(tenantId: string): TenantErasureRequestedEvent {
  return {
    ...createBaseEvent<TenantErasureRequestedEvent>('TenantErasureRequested', tenantId, {
      aggregateId: tenantId,
      aggregateType: 'Tenant',
    }),
    operationId: randomUUID(),
    requestedBy: 'admin-user-1',
    requestedAt: new Date().toISOString(),
    legalHoldCheckedAt: new Date().toISOString(),
    dryRun: false,
    targetServiceCount: 12,
  };
}

describe('sensor-service tenant erasure under pool RLS (tenant-schema-module)', () => {
  let harness: HarnessContext | undefined;
  let admin: DataSource | undefined;
  let runtime: DataSource | undefined;

  async function armRls(schema: string): Promise<void> {
    const previous = process.env['DB_MIGRATE_DDL_AUTHORITY'];
    process.env['DB_MIGRATE_DDL_AUTHORITY'] = '1';
    try {
      const qr = admin!.createQueryRunner();
      await applyTenantRlsToSchema(qr, { schemaOverride: schema });
      await qr.release();
    } finally {
      if (previous === undefined) delete process.env['DB_MIGRATE_DDL_AUTHORITY'];
      else process.env['DB_MIGRATE_DDL_AUTHORITY'] = previous;
    }
  }

  async function count(sql: string, params: unknown[] = []): Promise<number> {
    const rows: Array<{ n: string }> = await admin!.query(sql, params);
    return Number(rows[0]?.n);
  }

  beforeAll(async () => {
    harness = await bootPostgresContainer({ startTimeoutMs: 120_000 });
    admin = harness.dataSource;
    const password = randomBytes(24).toString('hex');
    await admin.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await admin.query('CREATE SCHEMA sensor');
    await admin.query(`CREATE ROLE ${RUNTIME_ROLE} LOGIN NOBYPASSRLS PASSWORD '${password}'`);

    const sensorDdl = new DataSource({
      type: 'postgres',
      ...harness.connectionOptions,
      name: 'erasure-ddl-sensor',
      entities: [EdgeDeviceDirectory, TenantProvisioningKeyDirectory],
      synchronize: true,
      logging: false,
    });
    await sensorDdl.initialize();
    await sensorDdl.destroy();
    for (const sql of buildTenantErasureTargetProofLedgerUpSql({
      schema: 'sensor',
      tenantIndexName: 'idx_sensor_erasure_proofs_tenant',
      eventIndexName: 'idx_sensor_erasure_proofs_event',
      targetIndexName: 'idx_sensor_erasure_proofs_target',
    })) {
      await admin.query(sql);
    }

    for (const tenantId of [TENANT_A, TENANT_B]) {
      const schema = getTenantSchemaName(tenantId);
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const ddl = new DataSource({
        type: 'postgres',
        ...harness.connectionOptions,
        name: `erasure-ddl-${schema}`,
        schema,
        entities: [EdgeDevice],
        synchronize: true,
        logging: false,
      });
      await ddl.initialize();
      for (const code of ['POND-01', 'POND-02']) {
        const saved = await ddl.manager.save(
          ddl.manager.create(EdgeDevice, {
            tenantId,
            deviceCode: code,
            deviceName: code,
            deviceModel: DeviceModel.CUSTOM,
            lifecycleState: DeviceLifecycleState.ACTIVE,
            mqttClientId: `edge-${tenantId.slice(0, 8)}-${code.toLowerCase()}`,
            isOnline: false,
          }),
        );
        await admin.query(
          `INSERT INTO sensor.edge_device_directory (device_id, device_code, mqtt_client_id, tenant_id)
           VALUES ($1, $2, $3, $4)`,
          [saved.id, code, saved.mqttClientId, tenantId],
        );
      }
      await admin.query(
        `INSERT INTO sensor.tenant_provisioning_key_directory (route_hash, key_id, tenant_id)
         VALUES ($1, $2, $3)`,
        [randomBytes(32).toString('hex'), randomUUID(), tenantId],
      );
      await ddl.destroy();
      await armRls(schema);
      await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO ${RUNTIME_ROLE}`);
      await admin.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO ${RUNTIME_ROLE}`,
      );
    }
    await armRls('sensor');
    await admin.query(`GRANT USAGE ON SCHEMA sensor, public TO ${RUNTIME_ROLE}`);
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA sensor TO ${RUNTIME_ROLE}`,
    );

    runtime = new DataSource({
      type: 'postgres',
      ...harness.connectionOptions,
      username: RUNTIME_ROLE,
      password,
      name: `erasure-runtime-${randomBytes(4).toString('hex')}`,
      entities: [],
      synchronize: false,
      logging: false,
    });
    // No tenant on the pool, as RlsConnectionBootstrap leaves a session
    // outside a request: the policy denies every row until the executor binds.
    await runtime.initialize();
  });

  afterAll(async () => {
    if (runtime?.isInitialized) await runtime.destroy();
    if (harness) await shutdownHarness(harness);
  });

  it("erases the tenant's edge devices and both route tables, and nothing of another tenant", async () => {
    const executor = new TenantErasureTargetExecutor(
      {
        dataSource: runtime!,
        outboxPublisher: { enqueue: jest.fn().mockResolvedValue(undefined) },
        legalHoldService: { assertNoHold: jest.fn().mockResolvedValue(undefined) },
        postErasureHooks: [new EdgeRouteDirectoryPurgeHook()],
      },
      getTenantErasureTargetOptions('sensor-service'),
    );

    const result = await executor.eraseFromRequest(erasureRequest(TENANT_A));

    expect(result.state).toBe('PURGED');
    expect(result.erasedRecordCount).toBe(2);
    const schemaA = getTenantSchemaName(TENANT_A);
    const schemaB = getTenantSchemaName(TENANT_B);
    expect(await count(`SELECT count(*) AS n FROM "${schemaA}".edge_devices`)).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM "${schemaB}".edge_devices`)).toBe(2);
    for (const table of ['edge_device_directory', 'tenant_provisioning_key_directory']) {
      expect(
        await count(`SELECT count(*) AS n FROM sensor.${table} WHERE tenant_id = $1`, [TENANT_A]),
      ).toBe(0);
      expect(
        await count(`SELECT count(*) AS n FROM sensor.${table} WHERE tenant_id = $1`, [TENANT_B]),
      ).toBeGreaterThan(0);
    }
    expect(
      await count(
        `SELECT count(*) AS n FROM sensor.tenant_erasure_target_proofs
          WHERE "tenantId" = $1 AND "erasedRecordCount" = 2`,
        [TENANT_A],
      ),
    ).toBe(1);
  });
});
