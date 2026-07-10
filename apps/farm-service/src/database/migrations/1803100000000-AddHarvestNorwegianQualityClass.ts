import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddHarvestNorwegianQualityClass1803100000000
 *
 * Stores the official Norwegian slaughter quality class (kvalitetsklasse) on
 * harvest_records (RPT-007) so the slakt report's per-species class split is
 * assembled from records instead of flagged MANUAL_REQUIRED.
 *
 * Blue-green safe: the column is added NOT NULL with a DEFAULT so inserts from
 * not-yet-upgraded code during cutover never fail; existing rows are then
 * backfilled from `qualityGrade` using the SAME deterministic mapping as
 * `QUALITY_GRADE_TO_CLASS` in harvest-record.entity.ts (SSoT). New rows are
 * written with the derived class by the create handler — the default is only
 * the cutover guard, corrected on the next write. `qualityGrade` stays as the
 * display alias until Phase 4 drops it.
 *
 * current_schema-relative, idempotent, forward-only.
 */
export class AddHarvestNorwegianQualityClass1803100000000 implements MigrationInterface {
  name = 'AddHarvestNorwegianQualityClass1803100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);

    await queryRunner.query(`
      DO $$
      BEGIN
        CREATE TYPE harvest_records_quality_class_enum AS ENUM (
          'superior', 'ordinaer', 'produksjonsfisk', 'utkast'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await queryRunner.query(`
      ALTER TABLE "harvest_records"
        ADD COLUMN IF NOT EXISTS "qualityClass" harvest_records_quality_class_enum
        NOT NULL DEFAULT 'ordinaer'
    `);

    // Backfill existing rows from the display grade — mirrors
    // QUALITY_GRADE_TO_CLASS (harvest-record.entity.ts).
    await queryRunner.query(`
      UPDATE "harvest_records"
         SET "qualityClass" = CASE "qualityGrade"
           WHEN 'premium' THEN 'superior'
           WHEN 'grade_a' THEN 'superior'
           WHEN 'grade_b' THEN 'ordinaer'
           WHEN 'grade_c' THEN 'produksjonsfisk'
           WHEN 'reject'  THEN 'utkast'
           ELSE 'ordinaer'
         END::harvest_records_quality_class_enum
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(`ALTER TABLE "harvest_records" DROP COLUMN IF EXISTS "qualityClass"`);
    await queryRunner.query(`DROP TYPE IF EXISTS harvest_records_quality_class_enum`);
  }
}
