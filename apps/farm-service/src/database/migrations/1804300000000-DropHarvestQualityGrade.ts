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
 * so historical premium-vs-A granularity is not recoverable. current_schema-
 * relative (fans out to farm + every tenant schema), idempotent, forward-only.
 * down() restores the column (defaulted 'grade_a') — values are not recovered.
 */
export class DropHarvestQualityGrade1804300000000 implements MigrationInterface {
  name = 'DropHarvestQualityGrade1804300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(`ALTER TABLE "harvest_records" DROP COLUMN IF EXISTS "qualityGrade"`);
    await queryRunner.query(`DROP TYPE IF EXISTS harvest_records_qualitygrade_enum`);
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
