import { addColumnWithIndex, dropColumnWithIndex } from '@aquaculture/backend-common/database';
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddDepartmentHrModuleCode — which module a department belongs to.
 *
 * Production, Greenhouse and Control & sensors each run their own Team area
 * (departments, people, schedule, leave). `departments_hr` had no module, so
 * every department was visible to every module. This migration:
 *
 *   1. creates `departments_hr_modulecode_enum('farm','hydroponics','sensor')`
 *      — the tenant module codes a workspace is built on;
 *   2. adds the nullable `moduleCode` column (NULL = company-wide; every
 *      existing department stays company-wide until an admin assigns it —
 *      nothing in the data says which module a department served);
 *   3. indexes (tenantId, moduleCode) for the per-module department and
 *      employee listings (employees reach their module through the department).
 *
 * Blue-green safe: nullable column add (no table rewrite), idempotent enum +
 * column + index (through the shared addColumnWithIndex pair), no backfill.
 */
export class AddDepartmentHrModuleCode1802400000000 implements MigrationInterface {
  name = 'AddDepartmentHrModuleCode1802400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // A bounded wait: an open transaction on departments_hr must fail this migration closed (the
    // deploy aborts and an operator re-runs it) rather than queue every reader behind the ALTER.
    await queryRunner.query(`SET LOCAL lock_timeout = '10s'`);

    await queryRunner.query(
      `DO $$ BEGIN CREATE TYPE "departments_hr_modulecode_enum" AS ENUM('farm', 'hydroponics', 'sensor'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
    );

    // The shared add-column-then-index pair (DEBT-2026-05-07-001): both halves
    // guarded, nullable column, unqualified DDL so tenant search_path routes it.
    await addColumnWithIndex(queryRunner, {
      table: 'departments_hr',
      column: 'moduleCode',
      columnType: { enumType: 'departments_hr_modulecode_enum' },
      indexName: 'IDX_departments_hr_tenant_module',
      indexColumns: ['tenantId', 'moduleCode'],
    });
  }

  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows = (await queryRunner.query(`
      SELECT
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'departments_hr'
            AND column_name = 'moduleCode'
        )
        AND EXISTS (
          SELECT 1 FROM pg_indexes
          WHERE schemaname = current_schema()
            AND indexname = 'IDX_departments_hr_tenant_module'
        ) AS ok
    `)) as Array<{ ok: boolean }>;
    return rows[0]?.ok === true;
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await dropColumnWithIndex(queryRunner, {
      table: 'departments_hr',
      column: 'moduleCode',
      indexName: 'IDX_departments_hr_tenant_module',
    });
    await queryRunner.query(`DROP TYPE IF EXISTS "departments_hr_modulecode_enum"`);
  }
}
