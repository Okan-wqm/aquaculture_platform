import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddEmployeeLaborCategory — structured workforce category on `employees`.
 *
 * The free-text `position` column cannot answer "how many managers /
 * technicians / unskilled workers?" (the Personnel Table and Labour Cost
 * finance read models need exactly that). This migration:
 *
 *   1. creates `employees_laborcategory_enum('manager','technical','unskilled')`;
 *   2. adds the nullable `laborCategory` column (NULL = unclassified —
 *      surfaced explicitly in the UI, never silently bucketed);
 *   3. auto-maps existing rows from the position text + department enum
 *      (product-owner decision: auto-map then hand-correct in the form).
 *      Patterns cover English and Turkish position spellings observed in
 *      the domain; unmatched rows stay NULL;
 *   4. indexes (tenantId, laborCategory) for the head-count aggregation.
 *
 * Blue-green safe: nullable column add (no table rewrite), idempotent
 * enum + column + index, backfill touches only NULL rows so replay is a
 * no-op.
 */
export class AddEmployeeLaborCategory1801600000000 implements MigrationInterface {
  name = 'AddEmployeeLaborCategory1801600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DO $$ BEGIN CREATE TYPE "employees_laborcategory_enum" AS ENUM('manager', 'technical', 'unskilled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
    );

    await queryRunner.query(
      `ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "laborCategory" "employees_laborcategory_enum" NULL`,
    );

    // Auto-map pass 1 — MANAGER: management-flavoured position text or the
    // management department.
    await queryRunner.query(`
      UPDATE "employees"
      SET "laborCategory" = 'manager'
      WHERE "laborCategory" IS NULL
        AND (
          "position" ~* '(manager|director|supervisor|lead|chief|head of|yönetici|müdür|şef)'
          OR "department" = 'management'
        )
    `);

    // Auto-map pass 2 — TECHNICAL: technician / biologist / water-quality
    // expert / engineer / veterinary flavoured position text.
    await queryRunner.query(`
      UPDATE "employees"
      SET "laborCategory" = 'technical'
      WHERE "laborCategory" IS NULL
        AND "position" ~* '(technician|technical|biolog|engineer|veterinar|water.?quality|quality.?expert|specialist|analyst|tekniker|teknisyen|mühendis|uzman|veteriner)'
    `);

    // Auto-map pass 3 — UNSKILLED: general labour flavoured position text.
    await queryRunner.query(`
      UPDATE "employees"
      SET "laborCategory" = 'unskilled'
      WHERE "laborCategory" IS NULL
        AND "position" ~* '(worker|labor|labour|operative|helper|cleaner|general hand|işçi|eleman|yardımcı)'
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_employees_tenant_labor_category" ON "employees" ("tenantId", "laborCategory")`,
    );
  }

  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows = (await queryRunner.query(`
      SELECT
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'employees'
            AND column_name = 'laborCategory'
        )
        AND EXISTS (
          SELECT 1 FROM pg_indexes
          WHERE schemaname = current_schema()
            AND indexname = 'IDX_employees_tenant_labor_category'
        ) AS ok
    `)) as Array<{ ok: boolean }>;
    return rows[0]?.ok === true;
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_employees_tenant_labor_category"`);
    await queryRunner.query(`ALTER TABLE "employees" DROP COLUMN IF EXISTS "laborCategory"`);
  }
}
