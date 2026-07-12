import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * HrFinanceEntrySoftDeletePartialIndexes — align the HR finance ledger's hot
 * indexes with their dominant predicate.
 *
 * Every HR finance summary/catalog read on `hr_finance_entries` filters
 * `"isDeleted" = false` (soft-deleted rows leave aggregates but keep audit
 * history), yet the three composite indexes were full-table. Rebuilding them
 * as PARTIAL (`WHERE "isDeleted" = false`) keeps them exactly the shape the
 * read path probes; soft-deleted rows remain reachable by primary key for
 * restore/audit. Mirrors the farm-side
 * FinanceEntrySoftDeletePartialIndexes1804900000000.
 *
 * New partial indexes are created BEFORE the full originals are dropped, so
 * no statement ever runs without index coverage. Idempotent + replay-safe;
 * a short lock/statement timeout bounds the DDL.
 */
export class HrFinanceEntrySoftDeletePartialIndexes1802100000000
  implements MigrationInterface
{
  name = 'HrFinanceEntrySoftDeletePartialIndexes1802100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_hr_finance_entries_tenant_date_active"
         ON "hr_finance_entries" ("tenantId", "entryDate")
         WHERE "isDeleted" = false`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_hr_finance_entries_tenant_category_date_active"
         ON "hr_finance_entries" ("tenantId", "categoryId", "entryDate")
         WHERE "isDeleted" = false`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_hr_finance_entries_tenant_department_active"
         ON "hr_finance_entries" ("tenantId", "departmentHrId")
         WHERE "isDeleted" = false`,
    );

    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_hr_finance_entries_tenant_date"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_hr_finance_entries_tenant_category_date"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_hr_finance_entries_tenant_department"`);
  }

  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows = (await queryRunner.query(`
      SELECT
        COUNT(*) FILTER (
          WHERE indexname IN (
            'IDX_hr_finance_entries_tenant_date_active',
            'IDX_hr_finance_entries_tenant_category_date_active',
            'IDX_hr_finance_entries_tenant_department_active'
          )
        ) AS created,
        COUNT(*) FILTER (
          WHERE indexname IN (
            'IDX_hr_finance_entries_tenant_date',
            'IDX_hr_finance_entries_tenant_category_date',
            'IDX_hr_finance_entries_tenant_department'
          )
        ) AS leftover
      FROM pg_indexes
      WHERE schemaname = current_schema()
    `)) as Array<{ created: string | number; leftover: string | number }>;
    return Number(rows[0]?.created) === 3 && Number(rows[0]?.leftover) === 0;
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_hr_finance_entries_tenant_date"
         ON "hr_finance_entries" ("tenantId", "entryDate")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_hr_finance_entries_tenant_category_date"
         ON "hr_finance_entries" ("tenantId", "categoryId", "entryDate")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_hr_finance_entries_tenant_department"
         ON "hr_finance_entries" ("tenantId", "departmentHrId")`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_hr_finance_entries_tenant_date_active"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_hr_finance_entries_tenant_category_date_active"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_hr_finance_entries_tenant_department_active"`,
    );
  }
}
