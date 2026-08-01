import { randomBytes } from 'node:crypto';

import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import type { DataSource, QueryRunner } from 'typeorm';

import { AddSentinelCredentialCutoverMetadata1807000000000 } from '../../database/migrations/1807000000000-AddSentinelCredentialCutoverMetadata';
import { SENTINEL_ERASURE_AUTHORIZATION_V1 } from '../../sentinel-hub/contracts/sentinel-erasure-authorization.v1';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OPERATION_ID = '33333333-3333-4333-8333-333333333333';

jest.setTimeout(120_000);

describe('legacy Sentinel credential tenant-erasure authorization on real Postgres', () => {
  let harness: HarnessContext | undefined;
  let tenantSchema: string;

  beforeAll(async () => {
    harness = await bootPostgresContainer({ startTimeoutMs: 90_000 });
    tenantSchema = `tenant_${randomBytes(8).toString('hex')}`;
    const admin = requireAdmin();
    await admin.query(`CREATE SCHEMA "${tenantSchema}"`);
    await admin.query(`
      CREATE TABLE "${tenantSchema}".sentinel_hub_settings (
        id uuid PRIMARY KEY,
        "tenantId" uuid NOT NULL,
        client_id text,
        client_secret text,
        instance_id text,
        is_configured boolean NOT NULL DEFAULT false,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await inTenantSchemaTransaction(async (queryRunner) => {
      await new AddSentinelCredentialCutoverMetadata1807000000000().up(queryRunner);
    });
  });

  afterAll(async () => {
    await shutdownHarness(harness);
  });

  beforeEach(async () => {
    const admin = requireAdmin();
    await admin.query(`TRUNCATE TABLE "${tenantSchema}".sentinel_hub_settings`);
    await admin.query(
      `
        INSERT INTO "${tenantSchema}".sentinel_hub_settings (
          id, "tenantId", client_id, client_secret, instance_id, is_configured
        ) VALUES ($1, $2, NULL, NULL, NULL, false)
      `,
      ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', TENANT_ID],
    );
  });

  it('rejects deletion without the operation GUCs and two-key lock', async () => {
    await expect(
      requireAdmin().query(`DELETE FROM "${tenantSchema}".sentinel_hub_settings`),
    ).rejects.toThrow(/authorized tenant erasure/u);
    await expect(rowCount()).resolves.toBe(1);
  });

  it('keeps the row during a tenant-pinned dry run that presents no deletion authorization', async () => {
    await inTenantSchemaTransaction(async (queryRunner) => {
      await queryRunner.query(`SELECT pg_catalog.set_config('app.current_tenant', $1, true)`, [
        TENANT_ID,
      ]);
      const rows: Array<{ count: string }> = await queryRunner.query(
        'SELECT COUNT(*)::text AS count FROM sentinel_hub_settings',
      );
      expect(rows[0]?.count).toBe('1');
    });
    await expect(rowCount()).resolves.toBe(1);
  });

  it('allows deletion only when the shared V1 transaction proof is complete', async () => {
    await inTenantSchemaTransaction(async (queryRunner) => {
      await queryRunner.query(`SELECT pg_catalog.set_config('app.current_tenant', $1, true)`, [
        TENANT_ID,
      ]);
      await queryRunner.query(
        `
          SELECT pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtext($1),
            pg_catalog.hashtext($2)
          )
        `,
        [SENTINEL_ERASURE_AUTHORIZATION_V1.advisoryNamespace, OPERATION_ID],
      );
      await queryRunner.query(
        `
          SELECT
            pg_catalog.set_config($1, $2, true),
            pg_catalog.set_config($3, $4, true),
            pg_catalog.set_config($5, $6, true)
        `,
        [
          SENTINEL_ERASURE_AUTHORIZATION_V1.targetServiceGuc,
          SENTINEL_ERASURE_AUTHORIZATION_V1.targetService,
          SENTINEL_ERASURE_AUTHORIZATION_V1.tenantIdGuc,
          TENANT_ID,
          SENTINEL_ERASURE_AUTHORIZATION_V1.operationIdGuc,
          OPERATION_ID,
        ],
      );
      await queryRunner.query('DELETE FROM sentinel_hub_settings');
    });

    await expect(rowCount()).resolves.toBe(0);
  });

  function requireAdmin(): DataSource {
    if (!harness) {
      throw new Error('Postgres harness is unavailable');
    }
    return harness.dataSource;
  }

  async function inTenantSchemaTransaction(
    operation: (queryRunner: QueryRunner) => Promise<void>,
  ): Promise<void> {
    const queryRunner = requireAdmin().createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      await queryRunner.query(`SET LOCAL search_path TO "${tenantSchema}", public`);
      await operation(queryRunner);
      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async function rowCount(): Promise<number> {
    const rows: Array<{ count: string }> = await requireAdmin().query(
      `SELECT COUNT(*)::text AS count FROM "${tenantSchema}".sentinel_hub_settings`,
    );
    return Number.parseInt(rows[0]?.count ?? '0', 10);
  }
});
