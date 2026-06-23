import { EncryptedAtRest, addMissingColumns, sql } from '@aquaculture/backend-common/database';
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

@Entity({ name: 'employees_enc', schema: 'addcol_test' })
class EmployeeEnc {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'bytea', name: 'national_id', nullable: false })
  @EncryptedAtRest({ keyId: 'tenant-pii-v1', algorithm: 'pgp_sym' })
  nationalId!: Buffer;
}

describe('addMissingColumns — Phase 3 Class D primitive', () => {
  let ctx: HarnessContext | undefined;

  beforeAll(async () => {
    ctx = await bootPostgresContainer();
  }, 90_000);

  afterAll(async () => {
    await shutdownHarness(ctx);
  }, 30_000);

  it('adds a nullable text column to an existing table', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS addcol_test`);
      try {
        await qr.query(
          `CREATE TABLE addcol_test.widget (id uuid PRIMARY KEY)`,
        );
        const result = await addMissingColumns(qr, {
          schema: 'addcol_test',
          table: 'widget',
          columns: [{ name: 'preferred_name', type: 'text', nullable: true }],
        });
        expect(result.added).toEqual(['preferred_name']);
        expect(result.skipped).toEqual([]);
        // Verify the column exists + is nullable.
        const rows = await queryRows<{
          column_name: string;
          data_type: string;
          is_nullable: string;
        }>(
          qr,
          `SELECT column_name, data_type, is_nullable FROM information_schema.columns
            WHERE table_schema = 'addcol_test' AND table_name = 'widget'
              AND column_name = 'preferred_name'`,
        );
        expect(rows).toHaveLength(1);
        expect(rowAt(rows, 0).data_type).toBe('text');
        expect(rowAt(rows, 0).is_nullable).toBe('YES');
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS addcol_test CASCADE`);
      }
    });
  });

  it('is idempotent — running twice produces added=[] + skipped=[existing]', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS addcol_test`);
      try {
        await qr.query(
          `CREATE TABLE addcol_test.widget (id uuid PRIMARY KEY)`,
        );
        await addMissingColumns(qr, {
          schema: 'addcol_test',
          table: 'widget',
          columns: [{ name: 'score', type: 'int', nullable: true }],
        });
        const second = await addMissingColumns(qr, {
          schema: 'addcol_test',
          table: 'widget',
          columns: [{ name: 'score', type: 'int', nullable: true }],
        });
        expect(second.added).toEqual([]);
        expect(second.skipped).toEqual(['score']);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS addcol_test CASCADE`);
      }
    });
  });

  it('applies literal DEFAULT expression (PG DDL semantics — evaluated at ALTER time)', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS addcol_test`);
      try {
        await qr.query(
          `CREATE TABLE addcol_test.widget (id uuid PRIMARY KEY)`,
        );
        await qr.query(
          `INSERT INTO addcol_test.widget (id) VALUES ('11111111-1111-1111-1111-111111111111')`,
        );
        // DEFAULT must be a literal SQL expression — PG does NOT bind
        // parameters for ALTER TABLE DDL. The SqlFragment carries only
        // literal SQL text, no sql.value() placeholders.
        await addMissingColumns(qr, {
          schema: 'addcol_test',
          table: 'widget',
          columns: [
            {
              name: 'status',
              type: 'text',
              nullable: false,
              defaultExpr: sql.fragment`'pending'`,
            },
          ],
        });
        const row = await queryRequiredRow<{ status: string }>(
          qr,
          `SELECT status FROM addcol_test.widget WHERE id = '11111111-1111-1111-1111-111111111111'`,
        );
        expect(row.status).toBe('pending');
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS addcol_test CASCADE`);
      }
    });
  });

  it('rejects DEFAULT containing bound parameters (PG DDL semantics)', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS addcol_test`);
      try {
        await qr.query(
          `CREATE TABLE addcol_test.widget (id uuid PRIMARY KEY)`,
        );
        await expect(
          addMissingColumns(qr, {
            schema: 'addcol_test',
            table: 'widget',
            columns: [
              {
                name: 'status',
                type: 'text',
                nullable: true,
                // This fragment carries a $1 placeholder — PG refuses
                // at bind time with a cryptic error. Primitive must
                // surface that constraint up-front.
                defaultExpr: sql.fragment`${sql.value('pending')}`,
              },
            ],
          }),
        ).rejects.toThrow(/parameter|bind|literal/i);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS addcol_test CASCADE`);
      }
    });
  });

  it('supports SQL-function DEFAULT expressions (NOW, gen_random_uuid)', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS addcol_test`);
      try {
        await qr.query(
          `CREATE TABLE addcol_test.widget (id uuid PRIMARY KEY)`,
        );
        await addMissingColumns(qr, {
          schema: 'addcol_test',
          table: 'widget',
          columns: [
            {
              name: 'created_at',
              type: 'timestamptz',
              nullable: false,
              defaultExpr: sql.fragment`NOW()`,
            },
          ],
        });
        // Verify we can insert a row without specifying created_at —
        // DEFAULT fills it in.
        await qr.query(
          `INSERT INTO addcol_test.widget (id) VALUES ('22222222-2222-2222-2222-222222222222')`,
        );
        const row = await queryRequiredRow<{ created_at: Date }>(
          qr,
          `SELECT created_at FROM addcol_test.widget WHERE id = '22222222-2222-2222-2222-222222222222'`,
        );
        expect(row.created_at).toBeInstanceOf(Date);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS addcol_test CASCADE`);
      }
    });
  });

  it('adds multiple columns in one invocation', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS addcol_test`);
      try {
        await qr.query(
          `CREATE TABLE addcol_test.widget (id uuid PRIMARY KEY)`,
        );
        const result = await addMissingColumns(qr, {
          schema: 'addcol_test',
          table: 'widget',
          columns: [
            { name: 'a', type: 'text', nullable: true },
            { name: 'b', type: 'int', nullable: true },
            { name: 'c', type: 'boolean', nullable: true },
          ],
        });
        // result.added is `readonly string[]`; .sort() mutates so it
        // can't be called on readonly arrays. Copy first.
        expect([...result.added].sort()).toEqual(['a', 'b', 'c']);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS addcol_test CASCADE`);
      }
    });
  });

  it('REFUSES to add a column that matches an @EncryptedAtRest property', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS addcol_test`);
      try {
        await qr.query(
          `CREATE TABLE addcol_test.employees_enc (id uuid PRIMARY KEY)`,
        );
        await expect(
          addMissingColumns(qr, {
            schema: 'addcol_test',
            table: 'employees_enc',
            entity: EmployeeEnc,
            columns: [{ name: 'national_id', type: 'bytea', nullable: false }],
          }),
        ).rejects.toThrow(/REFUSAL|EncryptedAtRest/i);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS addcol_test CASCADE`);
      }
    });
  });

  it('throws at call site on unsafe identifier (SQL injection guard)', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS addcol_test`);
      try {
        await qr.query(
          `CREATE TABLE addcol_test.widget (id uuid PRIMARY KEY)`,
        );
        await expect(
          addMissingColumns(qr, {
            schema: 'addcol_test',
            table: 'widget',
            columns: [
              { name: `name"; DROP TABLE users;--`, type: 'text' },
            ],
          }),
        ).rejects.toThrow(/SAFE_IDENT_RE/);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS addcol_test CASCADE`);
      }
    });
  });

  it('returns empty result set when columns=[]', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS addcol_test`);
      try {
        await qr.query(
          `CREATE TABLE addcol_test.widget (id uuid PRIMARY KEY)`,
        );
        const result = await addMissingColumns(qr, {
          schema: 'addcol_test',
          table: 'widget',
          columns: [],
        });
        expect(result).toEqual({ added: [], skipped: [] });
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS addcol_test CASCADE`);
      }
    });
  });
});
