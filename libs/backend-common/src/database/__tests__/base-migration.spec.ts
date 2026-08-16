import { defined } from '@aquaculture/testing';
import type { QueryRunner } from 'typeorm';

import {
  dropDependentPartialIndexes,
  parseAlterColumnTypeTargets,
  withDdlSafety,
} from '../base-migration';

describe('parseAlterColumnTypeTargets', () => {
  it('extracts (schema, table, column) from TypeORM-emitted ALTER COLUMN TYPE statements', () => {
    const sql = [
      `ALTER TABLE "hr"."employee_certifications" ALTER COLUMN "status" TYPE "hr"."employee_certifications_status_enum" USING "status"::"text"::"hr"."employee_certifications_status_enum"`,
      `ALTER TABLE "hr"."training_enrollments" ALTER COLUMN "status" TYPE "hr"."training_enrollments_status_enum" USING "status"::"text"::"hr"."training_enrollments_status_enum"`,
    ];
    expect(parseAlterColumnTypeTargets(sql)).toEqual([
      { schema: 'hr', table: 'employee_certifications', column: 'status' },
      { schema: 'hr', table: 'training_enrollments', column: 'status' },
    ]);
  });

  it('ignores ALTER COLUMN statements that are not TYPE changes', () => {
    const sql = [
      `ALTER TABLE "hr"."payrolls" ALTER COLUMN "status" SET NOT NULL`,
      `ALTER TABLE "hr"."payrolls" ALTER COLUMN "status" DROP DEFAULT`,
      `ALTER TABLE "hr"."payrolls" ALTER COLUMN "status" SET DEFAULT 'pending'`,
    ];
    expect(parseAlterColumnTypeTargets(sql)).toEqual([]);
  });

  it('accepts the SET DATA TYPE alias Postgres also supports', () => {
    const sql = [`ALTER TABLE "hr"."payrolls" ALTER COLUMN "amount" SET DATA TYPE numeric(12,2)`];
    expect(parseAlterColumnTypeTargets(sql)).toEqual([
      { schema: 'hr', table: 'payrolls', column: 'amount' },
    ]);
  });

  it('de-duplicates repeated targets across the input list', () => {
    const sql = [
      `ALTER TABLE "hr"."payrolls" ALTER COLUMN "status" TYPE "hr"."payroll_status"`,
      `ALTER TABLE "hr"."payrolls" ALTER COLUMN "status" TYPE "hr"."payroll_status"`,
    ];
    expect(parseAlterColumnTypeTargets(sql)).toHaveLength(1);
  });

  it('ignores unrelated statements', () => {
    const sql = [
      `CREATE TABLE "hr"."foo" ("id" uuid)`,
      `ALTER TABLE "hr"."foo" ADD "bar" text`,
      `CREATE INDEX ON "hr"."foo" ("bar")`,
    ];
    expect(parseAlterColumnTypeTargets(sql)).toEqual([]);
  });

  it('tolerates leading whitespace and case variation', () => {
    const sql = [`   alter table "hr"."payrolls" alter column "status" type "hr"."payroll_status"`];
    expect(parseAlterColumnTypeTargets(sql)).toEqual([
      { schema: 'hr', table: 'payrolls', column: 'status' },
    ]);
  });
});

describe('dropDependentPartialIndexes', () => {
  /**
   * Fake QueryRunner that routes the two read queries (pg_indexes,
   * pg_constraint) through supplied row sets and records every DDL
   * issued for assertion.
   */
  const makeQueryRunner = (
    pgIndexRows: Array<{
      indexname: string;
      indexdef: string;
      conname: string | null;
      contype: string | null;
    }>,
    pgCheckRows: Array<{ conname: string; condef: string }> = [],
  ): { qr: QueryRunner; query: jest.Mock } => {
    const query = jest.fn((sql: string): Promise<unknown> => {
      if (/FROM pg_indexes/i.test(sql)) return Promise.resolve(pgIndexRows);
      if (/FROM pg_constraint/i.test(sql)) return Promise.resolve(pgCheckRows);
      if (/^DROP INDEX/i.test(sql)) return Promise.resolve([]);
      if (/^ALTER\s+TABLE.*DROP\s+CONSTRAINT/i.test(sql)) return Promise.resolve([]);
      return Promise.reject(new Error(`Unexpected SQL: ${sql}`));
    });
    return { qr: { query } as unknown as QueryRunner, query };
  };

  it('drops standalone partial indexes whose WHERE predicate references the target column', async () => {
    const { qr, query } = makeQueryRunner([
      {
        indexname: 'IDX_emp_cert_expiry',
        indexdef: `CREATE INDEX "IDX_emp_cert_expiry" ON "hr"."employee_certifications" ("tenant_id", "expiry_date") WHERE (status = 'active'::hr.certification_status)`,
        conname: null,
        contype: null,
      },
      {
        indexname: 'IDX_emp_cert_pk',
        indexdef: `CREATE UNIQUE INDEX "IDX_emp_cert_pk" ON "hr"."employee_certifications" ("id")`,
        conname: null,
        contype: null,
      },
    ]);

    const dropped = await dropDependentPartialIndexes(qr, [
      { schema: 'hr', table: 'employee_certifications', column: 'status' },
    ]);

    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({
      schema: 'hr',
      table: 'employee_certifications',
      column: 'status',
      kind: 'partial_index',
      name: 'IDX_emp_cert_expiry',
    });
    expect(dropped[0]?.definition).toContain('WHERE');
    expect(query).toHaveBeenCalledWith(`DROP INDEX IF EXISTS "hr"."IDX_emp_cert_expiry"`);
    expect(
      query.mock.calls.some(([sql]) => typeof sql === 'string' && sql.includes('IDX_emp_cert_pk')),
    ).toBe(false);
  });

  it('drops EXCLUDE-constraint-backed partial indexes via DROP CONSTRAINT (not DROP INDEX)', async () => {
    const { qr, query } = makeQueryRunner([
      {
        indexname: 'leave_no_overlap',
        indexdef: `CREATE INDEX "leave_no_overlap" ON "hr"."leave_requests" USING gist (tenant_id, period) WHERE (status = 'approved'::hr.leave_status)`,
        conname: 'leave_no_overlap',
        contype: 'x',
      },
    ]);

    const dropped = await dropDependentPartialIndexes(qr, [
      { schema: 'hr', table: 'leave_requests', column: 'status' },
    ]);

    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({
      schema: 'hr',
      table: 'leave_requests',
      column: 'status',
      kind: 'excl_or_unique_constraint',
      name: 'leave_no_overlap',
    });
    expect(dropped[0]?.definition).toContain('leave_no_overlap');
    expect(query).toHaveBeenCalledWith(
      `ALTER TABLE "hr"."leave_requests" DROP CONSTRAINT "leave_no_overlap"`,
    );
    // Must NOT attempt DROP INDEX — PG rejects that on constraint-backed indexes.
    expect(
      query.mock.calls.some(
        ([sql]) =>
          typeof sql === 'string' && /^DROP INDEX/i.test(sql) && sql.includes('leave_no_overlap'),
      ),
    ).toBe(false);
  });

  it('drops CHECK constraints whose definition references the target column', async () => {
    const { qr, query } = makeQueryRunner(
      [],
      [
        {
          conname: 'chk_status_valid',
          condef: `CHECK ((status = 'active'::hr.leave_status OR status = 'closed'::hr.leave_status))`,
        },
      ],
    );

    const dropped = await dropDependentPartialIndexes(qr, [
      { schema: 'hr', table: 'leave_requests', column: 'status' },
    ]);

    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({
      schema: 'hr',
      table: 'leave_requests',
      column: 'status',
      kind: 'check_constraint',
      name: 'chk_status_valid',
    });
    expect(dropped[0]?.definition).toContain('status');
    expect(query).toHaveBeenCalledWith(
      `ALTER TABLE "hr"."leave_requests" DROP CONSTRAINT "chk_status_valid"`,
    );
  });

  it('does not double-drop a constraint that appears as both a backed index and in the CHECK list', async () => {
    const { qr, query } = makeQueryRunner(
      [
        {
          indexname: 'idx_backed',
          indexdef: `CREATE INDEX "idx_backed" ON "hr"."t" ("id") WHERE (status = 'open'::hr.st)`,
          conname: 'shared_name',
          contype: 'u',
        },
      ],
      [
        {
          conname: 'shared_name',
          condef: `CHECK (status = 'open'::hr.st)`,
        },
      ],
    );

    const dropped = await dropDependentPartialIndexes(qr, [
      { schema: 'hr', table: 't', column: 'status' },
    ]);

    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.kind).toBe('excl_or_unique_constraint');
    const dropConstraintCalls = query.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && /DROP\s+CONSTRAINT\s+"shared_name"/i.test(sql),
    );
    expect(dropConstraintCalls).toHaveLength(1);
  });

  it('leaves partial indexes that do not reference the target column intact', async () => {
    const { qr, query } = makeQueryRunner([
      {
        indexname: 'IDX_by_tenant_not_deleted',
        indexdef: `CREATE INDEX "IDX_by_tenant_not_deleted" ON "hr"."employee_certifications" ("tenant_id") WHERE (deleted_at IS NULL)`,
        conname: null,
        contype: null,
      },
    ]);

    const dropped = await dropDependentPartialIndexes(qr, [
      { schema: 'hr', table: 'employee_certifications', column: 'status' },
    ]);

    expect(dropped).toEqual([]);
    expect(
      query.mock.calls.some(
        ([sql]) =>
          typeof sql === 'string' &&
          (sql.startsWith('DROP INDEX') || /DROP\s+CONSTRAINT/i.test(sql)),
      ),
    ).toBe(false);
  });

  it('issues one pg_indexes lookup + one pg_constraint lookup per (schema, table) group', async () => {
    const { qr, query } = makeQueryRunner([]);
    await dropDependentPartialIndexes(qr, [
      { schema: 'hr', table: 'employee_certifications', column: 'status' },
      { schema: 'hr', table: 'employee_certifications', column: 'category' },
      { schema: 'hr', table: 'training_enrollments', column: 'status' },
    ]);
    const indexLookups = query.mock.calls.filter(([sql]) => /FROM pg_indexes/i.test(String(sql)));
    const constraintLookups = query.mock.calls.filter(([sql]) =>
      /FROM pg_constraint/i.test(String(sql)),
    );
    expect(indexLookups).toHaveLength(2);
    expect(constraintLookups).toHaveLength(2);
  });

  it('rejects unsafe schema, table, or column identifiers', async () => {
    const { qr } = makeQueryRunner([]);
    await expect(
      dropDependentPartialIndexes(qr, [
        { schema: 'hr"; DROP TABLE users; --', table: 't', column: 'c' },
      ]),
    ).rejects.toThrow(/Unsafe schema identifier/);
    await expect(
      dropDependentPartialIndexes(qr, [{ schema: 'hr', table: 't"; DROP --', column: 'c' }]),
    ).rejects.toThrow(/Unsafe table identifier/);
    await expect(
      dropDependentPartialIndexes(qr, [{ schema: 'hr', table: 't', column: 'c"; DROP --' }]),
    ).rejects.toThrow(/Unsafe column identifier/);
  });

  it('does not match column name appearing as a substring of another identifier', async () => {
    const { qr, query } = makeQueryRunner([
      {
        indexname: 'IDX_combined',
        indexdef: `CREATE INDEX "IDX_combined" ON "hr"."t" ("id") WHERE (status_extended = 'active'::text)`,
        conname: null,
        contype: null,
      },
    ]);
    const dropped = await dropDependentPartialIndexes(qr, [
      { schema: 'hr', table: 't', column: 'status' },
    ]);
    expect(dropped).toEqual([]);
    expect(
      query.mock.calls.some(([sql]) => typeof sql === 'string' && /DROP\s+INDEX/i.test(sql)),
    ).toBe(false);
  });
});

describe('withDdlSafety', () => {
  /**
   * Mock QueryRunner that records every query and supports an
   * `isTransactionActive` toggle so we can exercise both the in-tx
   * and non-tx paths.
   */
  const makeQr = (
    inTx: boolean,
    fail?: { onSql: RegExp; error: Error },
  ): { qr: QueryRunner; queries: Array<{ sql: string; params?: unknown[] }> } => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const query = jest.fn((sql: string, params?: unknown[]): Promise<unknown[]> => {
      queries.push({ sql, params });
      if (fail && fail.onSql.test(sql)) return Promise.reject(fail.error);
      return Promise.resolve([]);
    });
    return {
      qr: { query, isTransactionActive: inTx } as unknown as QueryRunner,
      queries,
    };
  };

  it('pins search_path via set_config parameterised when inside a transaction', async () => {
    const { qr, queries } = makeQr(true);
    await withDdlSafety(qr, { schema: 'hr' }, () => Promise.resolve(undefined));
    const pin = queries.find((q) => /set_config\(.search_path/.test(q.sql));
    expect(pin).toBeDefined();
    expect(pin?.params).toEqual(['hr,public']);
  });

  it('skips search_path pin when not in a transaction (SET LOCAL is a no-op there)', async () => {
    const { qr, queries } = makeQr(false);
    await withDdlSafety(qr, { schema: 'hr', nonTransactionalDdl: true }, () =>
      Promise.resolve(undefined),
    );
    const pin = queries.find((q) => /set_config\(.search_path/.test(q.sql));
    expect(pin).toBeUndefined();
  });

  it('applies SET LOCAL lock_timeout inside a transaction', async () => {
    const { qr, queries } = makeQr(true);
    await withDdlSafety(qr, { schema: 'hr', lockTimeoutMs: 5000 }, () =>
      Promise.resolve(undefined),
    );
    const lt = queries.find((q) => /SET LOCAL lock_timeout/i.test(q.sql));
    expect(lt?.sql).toContain("'5000ms'");
  });

  it('applies session-scoped SET lock_timeout + RESET outside a transaction', async () => {
    const { qr, queries } = makeQr(false);
    await withDdlSafety(
      qr,
      { schema: 'hr', nonTransactionalDdl: true, lockTimeoutMs: 10_000 },
      () => Promise.resolve(undefined),
    );
    const setLt = queries.find(
      (q) => /^SET lock_timeout/i.test(q.sql) && !/^SET LOCAL/i.test(q.sql),
    );
    const resetLt = queries.find((q) => /RESET lock_timeout/i.test(q.sql));
    expect(setLt?.sql).toContain("'10000ms'");
    expect(resetLt).toBeDefined();
  });

  it('acquires AND releases the advisory lock even when the inner fn throws', async () => {
    const { qr, queries } = makeQr(true);
    await expect(
      withDdlSafety(qr, { schema: 'hr' }, () => Promise.reject(new Error('inner failure'))),
    ).rejects.toThrow('inner failure');

    const locks = queries.filter((q) => /pg_advisory_lock/.test(q.sql));
    const unlocks = queries.filter((q) => /pg_advisory_unlock/.test(q.sql));
    expect(locks.length).toBe(1);
    expect(unlocks.length).toBe(1);
  });

  it('derives the advisory key from hashtext(aqua-db-migrate:<schema>)', async () => {
    const { qr, queries } = makeQr(true);
    await withDdlSafety(qr, { schema: 'messaging' }, () => Promise.resolve(undefined));
    const lock = queries.find((q) => /pg_advisory_lock/.test(q.sql));
    expect(lock?.sql).toContain("hashtext('aqua-db-migrate:messaging')");
  });

  it('escapes single-quote characters in the lock-key suffix (injection guard)', async () => {
    const { qr, queries } = makeQr(true);
    await withDdlSafety(qr, { schema: `hr'; DROP TABLE users;--` }, () =>
      Promise.resolve(undefined),
    );
    const lock = defined(
      queries.find((q) => /pg_advisory_lock/.test(q.sql)),
      'Expected advisory-lock query',
    );
    // Single quote gets doubled inside the literal — no statement break.
    expect(lock.sql).toContain("hr''; DROP TABLE users;--");
  });

  it('throws when nonTransactionalDdl=true but the runner is in a transaction', async () => {
    const { qr } = makeQr(true);
    await expect(
      withDdlSafety(qr, { schema: 'hr', nonTransactionalDdl: true }, () =>
        Promise.resolve(undefined),
      ),
    ).rejects.toThrow(/nonTransactionalDdl/);
  });

  it('returns the inner function result unchanged', async () => {
    const { qr } = makeQr(true);
    const result = await withDdlSafety(qr, { schema: 'hr' }, () => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it('releases the lock even when pg_advisory_unlock itself fails', async () => {
    const queries: Array<{ sql: string }> = [];
    const query = jest.fn((sql: string): Promise<unknown[]> => {
      queries.push({ sql });
      if (/pg_advisory_unlock/.test(sql)) {
        return Promise.reject(new Error('unlock failure — should be swallowed'));
      }
      return Promise.resolve([]);
    });
    const qr = { query, isTransactionActive: true } as unknown as QueryRunner;
    // Inner fn succeeds; unlock fails. Outer must NOT throw because
    // the caller's return value is the true result.
    const result = await withDdlSafety(qr, { schema: 'hr' }, () => Promise.resolve('ok'));
    expect(result).toBe('ok');
  });
});
