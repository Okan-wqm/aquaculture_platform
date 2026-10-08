import { randomBytes, randomUUID } from 'node:crypto';

import {
  getTenantErasureTargetOptions,
  TenantErasureTargetExecutor,
} from '@aquaculture/backend-common/compliance';
import { applyTenantRlsToSchema } from '@aquaculture/backend-common/database';
import { createBaseEvent, type TenantErasureRequestedEvent } from '@platform/event-contracts';
import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { buildTenantErasureTargetProofLedgerUpSql } from '@platform/outbox';
import { DataSource } from 'typeorm';

/**
 * PLAT-CRITICAL (tenant erasure was a no-op under pool RLS), the
 * `source-schema-tenant-column` mode, on real Postgres with config-service's
 * own policy: FORCE RLS on the source tables, a non-owner NOBYPASSRLS runtime
 * role and no tenant on the pool (as RlsConnectionBootstrap leaves a session
 * outside a request). The erasure must delete the erased tenant's rows by
 * policy and leave another tenant's rows alone; unbound, every DELETE matched
 * zero rows.
 */

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RUNTIME_ROLE = 'config_erasure_rls_test';

jest.setTimeout(240_000);

describe('config-service tenant erasure under pool RLS (source-schema-tenant-column)', () => {
  let harness: HarnessContext | undefined;
  let admin: DataSource | undefined;
  let runtime: DataSource | undefined;

  async function rows(table: string, tenantId: string): Promise<number> {
    const result: Array<{ n: string }> = await admin!.query(
      `SELECT count(*) AS n FROM config.${table} WHERE tenant_id = $1`,
      [tenantId],
    );
    return Number(result[0]?.n);
  }

  beforeAll(async () => {
    harness = await bootPostgresContainer({ startTimeoutMs: 120_000 });
    admin = harness.dataSource;
    const password = randomBytes(24).toString('hex');
    await admin.query(`CREATE ROLE ${RUNTIME_ROLE} LOGIN NOBYPASSRLS PASSWORD '${password}'`);
    await admin.query('CREATE SCHEMA config');
    for (const table of ['configurations', 'configuration_history']) {
      await admin.query(
        `CREATE TABLE config.${table} (
           id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
           tenant_id uuid NOT NULL,
           value text NOT NULL
         )`,
      );
      for (const tenantId of [TENANT_A, TENANT_B]) {
        await admin.query(
          `INSERT INTO config.${table} (tenant_id, value) VALUES ($1, 'a'), ($1, 'b')`,
          [tenantId],
        );
      }
    }
    for (const sql of buildTenantErasureTargetProofLedgerUpSql({
      schema: 'config',
      tenantIndexName: 'idx_config_erasure_proofs_tenant',
      eventIndexName: 'idx_config_erasure_proofs_event',
      targetIndexName: 'idx_config_erasure_proofs_target',
    })) {
      await admin.query(sql);
    }
    const previous = process.env['DB_MIGRATE_DDL_AUTHORITY'];
    process.env['DB_MIGRATE_DDL_AUTHORITY'] = '1';
    try {
      const qr = admin.createQueryRunner();
      await applyTenantRlsToSchema(qr, { schemaOverride: 'config' });
      await qr.release();
    } finally {
      if (previous === undefined) delete process.env['DB_MIGRATE_DDL_AUTHORITY'];
      else process.env['DB_MIGRATE_DDL_AUTHORITY'] = previous;
    }
    await admin.query(`GRANT USAGE ON SCHEMA config TO ${RUNTIME_ROLE}`);
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA config TO ${RUNTIME_ROLE}`,
    );

    runtime = new DataSource({
      type: 'postgres',
      ...harness.connectionOptions,
      username: RUNTIME_ROLE,
      password,
      name: `config-erasure-runtime-${randomBytes(4).toString('hex')}`,
      entities: [],
      synchronize: false,
      logging: false,
    });
    await runtime.initialize();
  });

  afterAll(async () => {
    if (runtime?.isInitialized) await runtime.destroy();
    if (harness) await shutdownHarness(harness);
  });

  it("deletes the erased tenant's rows by policy and nothing of another tenant", async () => {
    const executor = new TenantErasureTargetExecutor(
      {
        dataSource: runtime!,
        outboxPublisher: { enqueue: jest.fn().mockResolvedValue(undefined) },
        legalHoldService: { assertNoHold: jest.fn().mockResolvedValue(undefined) },
      },
      getTenantErasureTargetOptions('config-service'),
    );
    const request: TenantErasureRequestedEvent = {
      ...createBaseEvent<TenantErasureRequestedEvent>('TenantErasureRequested', TENANT_A, {
        aggregateId: TENANT_A,
        aggregateType: 'Tenant',
      }),
      operationId: randomUUID(),
      requestedBy: 'admin-user-1',
      requestedAt: new Date().toISOString(),
      legalHoldCheckedAt: new Date().toISOString(),
      dryRun: false,
      targetServiceCount: 12,
    };

    const result = await executor.eraseFromRequest(request);

    expect(result.state).toBe('PURGED');
    expect(result.erasedRecordCount).toBe(4);
    for (const table of ['configurations', 'configuration_history']) {
      expect(await rows(table, TENANT_A)).toBe(0);
      expect(await rows(table, TENANT_B)).toBe(2);
    }
  });
});
