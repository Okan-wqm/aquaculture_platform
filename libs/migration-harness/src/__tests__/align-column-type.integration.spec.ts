import { EncryptedAtRest, alignColumnType, sql } from '@aquaculture/backend-common/database';
import { Column, Entity, PrimaryColumn } from 'typeorm';

import {
  type HarnessContext,
  bootPostgresContainer,
  shutdownHarness,
} from '../index';

import {
  expectHarnessContext,
  queryRequiredRow,
  queryRows,
  rowAt,
  withHarnessSchema,
} from './test-helpers';

@Entity({ name: 'secret', schema: 'type_test' })
class SecretEnc {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'bytea', name: 'secret_blob', nullable: false })
  @EncryptedAtRest({ keyId: 'pii-v1', algorithm: 'pgp_sym' })
  secretBlob!: Buffer;
}

describe('alignColumnType — Phase 3 Class B primitive', () => {
  let ctx: HarnessContext | undefined;

  beforeAll(async () => {
    ctx = await bootPostgresContainer();
  }, 90_000);

  afterAll(async () => {
    await shutdownHarness(ctx);
  }, 30_000);

  it('aligns text → uuid (the 2026-04-14 RLS-break regression class)', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS type_test`);
      try {
        // Seed: tenant_id was historically provisioned as text.
        await qr.query(
          `CREATE TABLE type_test.audit_logs (
             id uuid PRIMARY KEY,
             tenant_id text NOT NULL
           )`,
        );
        await qr.query(
          `INSERT INTO type_test.audit_logs (id, tenant_id) VALUES
             ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222')`,
        );
        const result = await alignColumnType(qr, {
          schema: 'type_test',
          table: 'audit_logs',
          columns: [{ name: 'tenant_id', targetType: 'uuid' }],
        });
        expect(result.aligned).toEqual(['tenant_id']);
        const row = await queryRequiredRow<{ data_type: string }>(
          qr,
          `SELECT data_type FROM information_schema.columns
            WHERE table_schema = 'type_test' AND table_name = 'audit_logs' AND column_name = 'tenant_id'`,
        );
        expect(row.data_type).toBe('uuid');
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS type_test CASCADE`);
      }
    });
  });

  it('is a no-op when the column already has the desired type', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS type_test`);
      try {
        await qr.query(
          `CREATE TABLE type_test.audit_logs (
             id uuid PRIMARY KEY,
             tenant_id uuid NOT NULL
           )`,
        );
        const result = await alignColumnType(qr, {
          schema: 'type_test',
          table: 'audit_logs',
          columns: [{ name: 'tenant_id', targetType: 'uuid' }],
        });
        expect(result.aligned).toEqual([]);
        expect(result.skipped).toEqual(['tenant_id']);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS type_test CASCADE`);
      }
    });
  });

  it('drops dependent partial indexes before ALTER (2026-04 enum-drift incident pattern)', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS type_test`);
      try {
        await qr.query(
          `CREATE TABLE type_test.tasks (
             id uuid PRIMARY KEY,
             status text NOT NULL
           )`,
        );
        // Partial index references status — would block ALTER without pruning.
        // Double-quote the index name so PG preserves case exactly — the
        // helper's name-comparison is case-sensitive (pg_indexes.indexname
        // reports the literal stored case).
        await qr.query(
          `CREATE INDEX "IDX_tasks_active" ON type_test.tasks (id) WHERE status = 'active'`,
        );
        // Align status text → varchar(32). The partial-index drop is
        // triggered by the helper.
        const result = await alignColumnType(qr, {
          schema: 'type_test',
          table: 'tasks',
          columns: [{ name: 'status', targetType: 'varchar(32)' }],
        });
        expect(result.aligned).toEqual(['status']);
        expect(result.droppedBlockingDependencies).toContain('IDX_tasks_active');
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS type_test CASCADE`);
      }
    });
  });

  it('supports custom USING expression', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS type_test`);
      try {
        await qr.query(
          `CREATE TABLE type_test.widget (
             id uuid PRIMARY KEY,
             count_str text NOT NULL
           )`,
        );
        await qr.query(
          `INSERT INTO type_test.widget (id, count_str) VALUES
             ('11111111-1111-1111-1111-111111111111', '42'),
             ('22222222-2222-2222-2222-222222222222', 'invalid')`,
        );
        // Custom USING: non-numeric strings → 0.
        await alignColumnType(qr, {
          schema: 'type_test',
          table: 'widget',
          columns: [
            {
              name: 'count_str',
              targetType: 'int',
              usingExpr: sql.fragment`CASE WHEN ${sql.ident('count_str')} ~ '^[0-9]+$' THEN ${sql.ident('count_str')}::int ELSE 0 END`,
            },
          ],
        });
        const rows = await queryRows<{ count_str: number }>(
          qr,
          `SELECT count_str FROM type_test.widget ORDER BY id`,
        );
        expect(rowAt(rows, 0).count_str).toBe(42);
        expect(rowAt(rows, 1).count_str).toBe(0);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS type_test CASCADE`);
      }
    });
  });

  it('REFUSES to alter an @EncryptedAtRest column', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS type_test`);
      try {
        await qr.query(
          `CREATE TABLE type_test.secret (
             id uuid PRIMARY KEY,
             secret_blob bytea NOT NULL
           )`,
        );
        await expect(
          alignColumnType(qr, {
            schema: 'type_test',
            table: 'secret',
            entity: SecretEnc,
            columns: [{ name: 'secret_blob', targetType: 'text' }],
          }),
        ).rejects.toThrow(/REFUSAL|EncryptedAtRest/i);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS type_test CASCADE`);
      }
    });
  });

  it('throws when target column does not exist', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS type_test`);
      try {
        await qr.query(
          `CREATE TABLE type_test.widget (id uuid PRIMARY KEY)`,
        );
        await expect(
          alignColumnType(qr, {
            schema: 'type_test',
            table: 'widget',
            columns: [{ name: 'ghost', targetType: 'text' }],
          }),
        ).rejects.toThrow(/does not exist/);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS type_test CASCADE`);
      }
    });
  });

  it('surfaces Class H incompat-cast failure as a PG error (no swallow)', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS type_test`);
      try {
        await qr.query(
          `CREATE TABLE type_test.widget (
             id uuid PRIMARY KEY,
             count_str text NOT NULL
           )`,
        );
        await qr.query(
          `INSERT INTO type_test.widget (id, count_str) VALUES
             ('11111111-1111-1111-1111-111111111111', 'not-a-number')`,
        );
        // Default USING generates `count_str::int` which fails on this row.
        await expect(
          alignColumnType(qr, {
            schema: 'type_test',
            table: 'widget',
            columns: [{ name: 'count_str', targetType: 'int' }],
          }),
        ).rejects.toThrow();
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS type_test CASCADE`);
      }
    });
  });

  it('returns empty result when columns=[]', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      const result = await alignColumnType(qr, {
        schema: 'type_test',
        table: 'widget',
        columns: [],
      });
      expect(result).toEqual({
        aligned: [],
        skipped: [],
        droppedBlockingDependencies: [],
      });
    });
  });

  it('rejects unsafe identifier at call site', async () => {
    const qr = {} as never;
    await expect(
      alignColumnType(qr, {
        schema: 'type_test',
        table: 'widget',
        columns: [{ name: `bad"; DROP--`, targetType: 'uuid' }],
      }),
    ).rejects.toThrow(/SAFE_IDENT_RE/);
  });
});
