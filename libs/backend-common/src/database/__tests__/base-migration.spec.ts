import type { QueryRunner } from 'typeorm';
import {
  dropDependentPartialIndexes,
  parseAlterColumnTypeTargets,
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
    const sql = [
      `ALTER TABLE "hr"."payrolls" ALTER COLUMN "amount" SET DATA TYPE numeric(12,2)`,
    ];
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
    const sql = [
      `   alter table "hr"."payrolls" alter column "status" type "hr"."payroll_status"`,
    ];
    expect(parseAlterColumnTypeTargets(sql)).toEqual([
      { schema: 'hr', table: 'payrolls', column: 'status' },
    ]);
  });
});

describe('dropDependentPartialIndexes', () => {
  const makeQueryRunner = (
    pgIndexesRows: Array<{ indexname: string; indexdef: string }>,
  ): { qr: QueryRunner; query: jest.Mock } => {
    const query = jest.fn(async (sql: string) => {
      if (/FROM pg_indexes/i.test(sql)) return pgIndexesRows;
      if (/^DROP INDEX/i.test(sql)) return [];
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    return { qr: { query } as unknown as QueryRunner, query };
  };

  it('drops partial indexes whose WHERE predicate references the target column', async () => {
    const { qr, query } = makeQueryRunner([
      {
        indexname: 'IDX_emp_cert_expiry',
        indexdef: `CREATE INDEX "IDX_emp_cert_expiry" ON "hr"."employee_certifications" ("tenant_id", "expiry_date") WHERE (status = 'active'::hr.certification_status)`,
      },
      {
        indexname: 'IDX_emp_cert_pk',
        indexdef: `CREATE UNIQUE INDEX "IDX_emp_cert_pk" ON "hr"."employee_certifications" ("id")`,
      },
    ]);

    const dropped = await dropDependentPartialIndexes(qr, [
      { schema: 'hr', table: 'employee_certifications', column: 'status' },
    ]);

    expect(dropped).toEqual([
      {
        schema: 'hr',
        table: 'employee_certifications',
        column: 'status',
        indexName: 'IDX_emp_cert_expiry',
        indexDef: expect.stringContaining('WHERE'),
      },
    ]);
    expect(query).toHaveBeenCalledWith(
      `DROP INDEX IF EXISTS "hr"."IDX_emp_cert_expiry"`,
    );
    // Non-partial index must not be dropped.
    expect(
      query.mock.calls.some(
        ([sql]) =>
          typeof sql === 'string' && sql.includes('IDX_emp_cert_pk'),
      ),
    ).toBe(false);
  });

  it('leaves partial indexes that do not reference the target column intact', async () => {
    const { qr, query } = makeQueryRunner([
      {
        indexname: 'IDX_emp_cert_active_by_tenant',
        indexdef: `CREATE INDEX "IDX_emp_cert_active_by_tenant" ON "hr"."employee_certifications" ("tenant_id") WHERE (deleted_at IS NULL)`,
      },
    ]);

    const dropped = await dropDependentPartialIndexes(qr, [
      { schema: 'hr', table: 'employee_certifications', column: 'status' },
    ]);

    expect(dropped).toEqual([]);
    expect(
      query.mock.calls.some(
        ([sql]) => typeof sql === 'string' && sql.startsWith('DROP INDEX'),
      ),
    ).toBe(false);
  });

  it('issues one pg_indexes lookup per (schema, table) group', async () => {
    const { qr, query } = makeQueryRunner([]);
    await dropDependentPartialIndexes(qr, [
      { schema: 'hr', table: 'employee_certifications', column: 'status' },
      { schema: 'hr', table: 'employee_certifications', column: 'category' },
      { schema: 'hr', table: 'training_enrollments', column: 'status' },
    ]);
    const lookupCalls = query.mock.calls.filter(([sql]) =>
      /FROM pg_indexes/i.test(String(sql)),
    );
    expect(lookupCalls).toHaveLength(2);
  });

  it('rejects unsafe schema, table, or column identifiers', async () => {
    const { qr } = makeQueryRunner([]);
    await expect(
      dropDependentPartialIndexes(qr, [
        { schema: 'hr"; DROP TABLE users; --', table: 't', column: 'c' },
      ]),
    ).rejects.toThrow(/Unsafe schema identifier/);
    await expect(
      dropDependentPartialIndexes(qr, [
        { schema: 'hr', table: 't"; DROP --', column: 'c' },
      ]),
    ).rejects.toThrow(/Unsafe table identifier/);
    await expect(
      dropDependentPartialIndexes(qr, [
        { schema: 'hr', table: 't', column: 'c"; DROP --' },
      ]),
    ).rejects.toThrow(/Unsafe column identifier/);
  });

  it('does not match column name appearing as a substring of another identifier', async () => {
    const { qr, query } = makeQueryRunner([
      {
        indexname: 'IDX_combined',
        indexdef: `CREATE INDEX "IDX_combined" ON "hr"."t" ("id") WHERE (status_extended = 'active'::text)`,
      },
    ]);
    const dropped = await dropDependentPartialIndexes(qr, [
      { schema: 'hr', table: 't', column: 'status' },
    ]);
    expect(dropped).toEqual([]);
    expect(
      query.mock.calls.some(
        ([sql]) => typeof sql === 'string' && sql.startsWith('DROP INDEX'),
      ),
    ).toBe(false);
  });
});
