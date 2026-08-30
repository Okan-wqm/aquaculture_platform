import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * FinanceEntrySoftDeletePartialIndexes — align the finance ledger's hot
 * indexes with their dominant predicate.
 *
 * Every ledger/summary/batch-totals read on `finance_expense_entries`
 * filters `"isDeleted" = false` (soft-deleted rows leave aggregates but keep
 * audit history), yet the four composite indexes were full-table. As deleted
 * rows accumulate they bloat the index and every range scan wades through
 * dead entries. Rebuilding the composites as PARTIAL (`WHERE "isDeleted" =
 * false`) keeps them exactly the shape the read path probes; soft-deleted
 * rows remain reachable by primary key for restore/audit.
 *
 * New partial indexes are created BEFORE the full originals are dropped, so
 * no statement ever runs without index coverage. Idempotent + replay-safe
 * (IF NOT EXISTS / IF EXISTS); a short lock/statement timeout bounds the DDL
 * so a deploy fails fast rather than blocking writes.
 */
export class FinanceEntrySoftDeletePartialIndexes1805800000000 implements MigrationInterface {
  name = 'FinanceEntrySoftDeletePartialIndexes1805800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_finance_entries_tenant_date_active"
         ON "finance_expense_entries" ("tenantId", "entryDate")
         WHERE "isDeleted" = false`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_finance_entries_tenant_category_date_active"
         ON "finance_expense_entries" ("tenantId", "categoryId", "entryDate")
         WHERE "isDeleted" = false`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_finance_entries_tenant_batch_active"
         ON "finance_expense_entries" ("tenantId", "batchId")
         WHERE "isDeleted" = false`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_finance_entries_tenant_site_active"
         ON "finance_expense_entries" ("tenantId", "siteId")
         WHERE "isDeleted" = false`,
    );

    await queryRunner.query(`DROP INDEX IF EXISTS "idx_finance_entries_tenant_date"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_finance_entries_tenant_category_date"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_finance_entries_tenant_batch"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_finance_entries_tenant_site"`);
  }

  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows = (await queryRunner.query(`
      SELECT
        COUNT(*) FILTER (
          WHERE indexname IN (
            'idx_finance_entries_tenant_date_active',
            'idx_finance_entries_tenant_category_date_active',
            'idx_finance_entries_tenant_batch_active',
            'idx_finance_entries_tenant_site_active'
          )
        ) AS created,
        COUNT(*) FILTER (
          WHERE indexname IN (
            'idx_finance_entries_tenant_date',
            'idx_finance_entries_tenant_category_date',
            'idx_finance_entries_tenant_batch',
            'idx_finance_entries_tenant_site'
          )
        ) AS leftover
      FROM pg_indexes
      WHERE schemaname = current_schema()
    `)) as Array<{ created: string | number; leftover: string | number }>;
    return Number(rows[0]?.created) === 4 && Number(rows[0]?.leftover) === 0;
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_finance_entries_tenant_date"
         ON "finance_expense_entries" ("tenantId", "entryDate")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_finance_entries_tenant_category_date"
         ON "finance_expense_entries" ("tenantId", "categoryId", "entryDate")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_finance_entries_tenant_batch"
         ON "finance_expense_entries" ("tenantId", "batchId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_finance_entries_tenant_site"
         ON "finance_expense_entries" ("tenantId", "siteId")`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_finance_entries_tenant_date_active"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_finance_entries_tenant_category_date_active"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_finance_entries_tenant_batch_active"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_finance_entries_tenant_site_active"`);
  }
}
