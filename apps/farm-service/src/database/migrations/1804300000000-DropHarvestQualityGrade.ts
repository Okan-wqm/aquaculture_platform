import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DropHarvestQualityGrade1804300000000
 *
 * Phase 4 (RPT-007, operator decision): retire the 5-level display grade.
 * `harvest_records.quality_class` (added + backfilled by
 * AddHarvestNorwegianQualityClass1803100000000) is now the SOLE stored quality
 * taxonomy and the slakt-report truth. The `qualityGrade` column is dropped;
 * the GraphQL `qualityGrade` field survives only as a DERIVED read alias on the
 * entity (classToDisplayGrade), so read clients keep working.
 *
 * Accepted tradeoff: the grade→class map was lossy (PREMIUM+GRADE_A→SUPERIOR),
 * so historical premium-vs-A granularity is not recoverable. The COLUMN drop is
 * current_schema-relative and fans out to farm + every tenant schema; the shared
 * `farm.harvest_records_qualitygrade_enum` TYPE is deliberately left in place
 * (see up() — a cross-schema-shared enum cannot be dropped inside the source-
 * first fan-out). Idempotent, forward-only. down() restores the column
 * (defaulted 'grade_a') — values are not recovered.
 */
export class DropHarvestQualityGrade1804300000000 implements MigrationInterface {
  name = 'DropHarvestQualityGrade1804300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    // Drop the column in the current schema. This DOES fan out correctly — every
    // schema (farm + each tenant clone) owns its own `qualityGrade` column, so
    // the source pass drops farm's and the tenant fan-out drops each tenant's.
    await queryRunner.query(`ALTER TABLE "harvest_records" DROP COLUMN IF EXISTS "qualityGrade"`);

    // The enum TYPE is intentionally NOT dropped here (production outage
    // 2026-07-07). `harvest_records_qualitygrade_enum` is a SINGLE farm-schema
    // type — hard-qualified in 1800000000000-Baseline.ts as
    // `"farm"."harvest_records_qualitygrade_enum"`. Tenant schemas are cloned with
    // `CREATE TABLE … LIKE … INCLUDING ALL`, which copies the column but does NOT
    // clone the type, so every tenant `harvest_records.qualityGrade` cross-
    // references the one farm enum. The db-migrate fan-out runs the SOURCE (farm)
    // schema FIRST and aborts the whole run on failure, so a `DROP TYPE` here
    // failed with "cannot drop type … because other objects depend on it" (every
    // tenant clone still had the column) → db-migrate exit 1 → all gated services
    // couldn't start → total outage. The shared type can also only be seen in the
    // farm pass (a tenant pass's unqualified DROP TYPE is a no-op — not on its
    // search_path), so no per-schema fan-out can express "drop one shared object
    // after all N+1 references are gone". Leaving the now-orphaned, unused enum is
    // the established forward-only stance (AddCullMortalityAuditEnumValues no-ops
    // its own type drop for the same shared-enum reason); an unused enum is harmless.
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = current_schema()
            AND t.typname = 'harvest_records_qualitygrade_enum'
        ) THEN
          CREATE TYPE harvest_records_qualitygrade_enum AS ENUM (
            'premium', 'grade_a', 'grade_b', 'grade_c', 'reject'
          );
        END IF;
      END $$;
    `);
    await queryRunner.query(
      `ALTER TABLE "harvest_records" ADD COLUMN IF NOT EXISTS "qualityGrade" ` +
        `harvest_records_qualitygrade_enum NOT NULL DEFAULT 'grade_a'`,
    );
  }
}
