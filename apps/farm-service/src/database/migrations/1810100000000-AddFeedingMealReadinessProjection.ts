import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Forward projection for the typed pre-meal oxygen readiness snapshot. */
export class AddFeedingMealReadinessProjection1810100000000 implements MigrationInterface {
  readonly name = 'AddFeedingMealReadinessProjection1810100000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "feeding_meals"
        ADD COLUMN IF NOT EXISTS "readiness" jsonb NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "feeding_meals"
        DROP CONSTRAINT IF EXISTS "CHK_feeding_meal_readiness_v1"
    `);
    await queryRunner.query(`
      ALTER TABLE "feeding_meals"
        ADD CONSTRAINT "CHK_feeding_meal_readiness_v1"
        CHECK (
          "readiness" IS NULL OR (
            "readiness"->>'schemaVersion' = 'feeding-meal-readiness/v1'
            AND "readiness"->>'status' IN (
              'ready', 'low_oxygen', 'no_reading', 'not_instrumented'
            )
            AND jsonb_typeof("readiness"->'minDissolvedOxygen') = 'number'
            AND NULLIF("readiness"->>'evaluatedAt', '') IS NOT NULL
            AND NULLIF("readiness"->>'sourceWindowEventId', '') IS NOT NULL
          )
        ) NOT VALID
    `);
    await queryRunner.query(`
      ALTER TABLE "feeding_meals"
        VALIDATE CONSTRAINT "CHK_feeding_meal_readiness_v1"
    `);
  }

  async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ ok: boolean }> = await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'feeding_meals'
           AND column_name = 'readiness'
      ) AS ok
    `);
    return rows[0]?.ok === true;
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "feeding_meals"
        DROP CONSTRAINT IF EXISTS "CHK_feeding_meal_readiness_v1",
        DROP COLUMN IF EXISTS "readiness"
    `);
  }
}
