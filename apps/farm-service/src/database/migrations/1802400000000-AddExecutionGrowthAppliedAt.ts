import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddExecutionGrowthAppliedAt1802400000000
 *
 * Adds `daily_feeding_executions.growthAppliedAt` — the timestamp at which an
 * execution's FCR-based weight growth was rolled into the tank/batch. PER_FEEDING
 * programs stamp it inline at recording time; DAILY programs leave it null until
 * the daily roll-up job applies the aggregate growth. It is the idempotency key
 * that prevents growth being double-applied (Phase 8).
 *
 * current_schema-relative: db-migrate fans farm migrations out with search_path
 * pinned to `farm` and each `tenant_<uuid>`, so the unqualified table name is the
 * only correct target. Idempotent, forward-only, blue-green safe (nullable).
 */
export class AddExecutionGrowthAppliedAt1802400000000 implements MigrationInterface {
  name = 'AddExecutionGrowthAppliedAt1802400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(`
      ALTER TABLE "daily_feeding_executions"
        ADD COLUMN IF NOT EXISTS "growthAppliedAt" timestamptz
    `);

    // Backfill: every EXISTING completed execution already had its growth applied
    // inline by the pre-Phase-8 recorder, so stamp it as applied. Without this the
    // new daily roll-up would scan them as "pending" and double-apply the growth.
    await queryRunner.query(`
      UPDATE "daily_feeding_executions"
         SET "growthAppliedAt" = COALESCE("completedAt", "updatedAt")
       WHERE "status" = 'completed' AND "growthAppliedAt" IS NULL
    `);

    // Partial index over the pending (null) rows the daily roll-up job scans.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_dfe_growth_pending"
        ON "daily_feeding_executions" ("executionDate")
        WHERE "growthAppliedAt" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query('DROP INDEX IF EXISTS "IDX_dfe_growth_pending"');
    await queryRunner.query(`
      ALTER TABLE "daily_feeding_executions" DROP COLUMN IF EXISTS "growthAppliedAt"
    `);
  }
}
