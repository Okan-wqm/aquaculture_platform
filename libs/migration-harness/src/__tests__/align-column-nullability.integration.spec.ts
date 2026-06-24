import { EncryptedAtRest, alignColumnNullability, sql } from '@aquaculture/backend-common/database';
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

@Entity({ name: 'secret_table', schema: 'nullable_test' })
class SecretEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'bytea', name: 'secret_blob', nullable: false })
  @EncryptedAtRest({ keyId: 'pii-v1', algorithm: 'pgp_sym' })
  secretBlob!: Buffer;
}

describe('alignColumnNullability — Phase 3 Class C primitive', () => {
  let ctx: HarnessContext | undefined;

  beforeAll(async () => {
    ctx = await bootPostgresContainer();
  }, 90_000);

  afterAll(async () => {
    await shutdownHarness(ctx);
  }, 30_000);

  it('flips a nullable column to NOT NULL on an empty table', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS nullable_test`);
      try {
        await qr.query(
          `CREATE TABLE nullable_test.widget (id uuid PRIMARY KEY, name text)`,
        );
        const result = await alignColumnNullability(qr, {
          schema: 'nullable_test',
          table: 'widget',
          columns: [{ name: 'name' }],
        });
        expect(result.aligned).toEqual(['name']);
        expect(result.skipped).toEqual([]);
        expect(result.backfilled).toEqual([]);
        const row = await queryRequiredRow<{ is_nullable: string }>(
          qr,
          `SELECT is_nullable FROM information_schema.columns
            WHERE table_schema = 'nullable_test' AND table_name = 'widget'
              AND column_name = 'name'`,
        );
        expect(row.is_nullable).toBe('NO');
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS nullable_test CASCADE`);
      }
    });
  });

  it('is a no-op when the column is already NOT NULL', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS nullable_test`);
      try {
        await qr.query(
          `CREATE TABLE nullable_test.widget (id uuid PRIMARY KEY, name text NOT NULL)`,
        );
        const result = await alignColumnNullability(qr, {
          schema: 'nullable_test',
          table: 'widget',
          columns: [{ name: 'name' }],
        });
        expect(result.aligned).toEqual([]);
        expect(result.skipped).toEqual(['name']);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS nullable_test CASCADE`);
      }
    });
  });

  it('rejects when NULL rows exist and no backfill supplied', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS nullable_test`);
      try {
        await qr.query(
          `CREATE TABLE nullable_test.widget (id uuid PRIMARY KEY, name text)`,
        );
        await qr.query(
          `INSERT INTO nullable_test.widget (id, name) VALUES
             ('11111111-1111-1111-1111-111111111111', NULL),
             ('22222222-2222-2222-2222-222222222222', 'ok')`,
        );
        await expect(
          alignColumnNullability(qr, {
            schema: 'nullable_test',
            table: 'widget',
            columns: [{ name: 'name' }],
          }),
        ).rejects.toThrow(/1 NULL row/);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS nullable_test CASCADE`);
      }
    });
  });

  it('applies backfill + flips to NOT NULL when backfillExpr supplied', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS nullable_test`);
      try {
        await qr.query(
          `CREATE TABLE nullable_test.widget (id uuid PRIMARY KEY, name text)`,
        );
        await qr.query(
          `INSERT INTO nullable_test.widget (id, name) VALUES
             ('11111111-1111-1111-1111-111111111111', NULL),
             ('22222222-2222-2222-2222-222222222222', 'existing')`,
        );
        const result = await alignColumnNullability(qr, {
          schema: 'nullable_test',
          table: 'widget',
          columns: [
            {
              name: 'name',
              backfillExpr: sql.fragment`${sql.value('backfilled')}`,
            },
          ],
        });
        expect(result.aligned).toEqual(['name']);
        expect(result.backfilled).toEqual(['name']);

        // The pre-existing non-NULL row must be preserved.
        const rows = await queryRows<{ id: string; name: string }>(
          qr,
          `SELECT id, name FROM nullable_test.widget ORDER BY id`,
        );
        expect(rowAt(rows, 0).name).toBe('backfilled');
        expect(rowAt(rows, 1).name).toBe('existing');
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS nullable_test CASCADE`);
      }
    });
  });

  it('rejects if backfill expression leaves residual NULLs', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS nullable_test`);
      try {
        await qr.query(
          `CREATE TABLE nullable_test.widget (id uuid PRIMARY KEY, name text, fallback text)`,
        );
        // Insert a row whose fallback is also NULL — so backfill-from-
        // fallback would leave name NULL.
        await qr.query(
          `INSERT INTO nullable_test.widget (id, name, fallback) VALUES
             ('11111111-1111-1111-1111-111111111111', NULL, NULL)`,
        );
        await expect(
          alignColumnNullability(qr, {
            schema: 'nullable_test',
            table: 'widget',
            columns: [
              {
                name: 'name',
                backfillExpr: sql.fragment`${sql.ident('fallback')}`,
              },
            ],
          }),
        ).rejects.toThrow(/residual NULL/);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS nullable_test CASCADE`);
      }
    });
  });

  it('REFUSES @EncryptedAtRest column', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS nullable_test`);
      try {
        await qr.query(
          `CREATE TABLE nullable_test.secret_table (
             id uuid PRIMARY KEY,
             secret_blob bytea
           )`,
        );
        await expect(
          alignColumnNullability(qr, {
            schema: 'nullable_test',
            table: 'secret_table',
            entity: SecretEntity,
            columns: [{ name: 'secret_blob' }],
          }),
        ).rejects.toThrow(/REFUSAL|EncryptedAtRest/i);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS nullable_test CASCADE`);
      }
    });
  });

  it('throws when the target column does not exist', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS nullable_test`);
      try {
        await qr.query(
          `CREATE TABLE nullable_test.widget (id uuid PRIMARY KEY)`,
        );
        await expect(
          alignColumnNullability(qr, {
            schema: 'nullable_test',
            table: 'widget',
            columns: [{ name: 'missing_col' }],
          }),
        ).rejects.toThrow(/does not exist/);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS nullable_test CASCADE`);
      }
    });
  });

  it('returns empty result when columns=[]', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS nullable_test`);
      try {
        const result = await alignColumnNullability(qr, {
          schema: 'nullable_test',
          table: 'anything',
          columns: [],
        });
        expect(result).toEqual({ aligned: [], skipped: [], backfilled: [] });
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS nullable_test CASCADE`);
      }
    });
  });

  it('rejects unsafe identifier at call site', async () => {
    const qr = {} as never;
    await expect(
      alignColumnNullability(qr, {
        schema: 'nullable_test',
        table: 'widget',
        columns: [{ name: `bad"; DROP--` }],
      }),
    ).rejects.toThrow(/SAFE_IDENT_RE/);
  });
});
