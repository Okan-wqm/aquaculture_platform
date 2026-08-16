import type { MigrationInterface, QueryRunner } from 'typeorm';

import {
  FEEDING_MIGRATION_AUTHORITY_V1,
  assertFeedingMigrationAuthorityV1,
} from './feeding-migration-authority.v1';

const MIGRATION_AUTHORITY_DIGEST =
  '0f23c8d97804e652410c049efe33ef8ad8138e00a06aa908256d74ad54a264f8';
const DAY_PLAN_RECALC_AUDIT_POLICY_V1 = FEEDING_MIGRATION_AUTHORITY_V1.dayPlanRecalculationAudit;

/** Keeps a monotonic total while bounding the recent JSON projection. */
export class BoundDayPlanRecalculationAudit1809200000000 implements MigrationInterface {
  name = 'BoundDayPlanRecalculationAudit1809200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    assertFeedingMigrationAuthorityV1(MIGRATION_AUTHORITY_DIGEST);
    const presence: Array<{ plans: string | null }> = await queryRunner.query(
      `SELECT to_regclass('feeding_day_plans')::text AS plans`,
    );
    if (!presence[0]?.plans) return;
    await queryRunner.query(
      `ALTER TABLE "feeding_day_plans"
         ADD COLUMN IF NOT EXISTS "recalcCount" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `
      UPDATE "feeding_day_plans"
         SET "recalcCount" = GREATEST("recalcCount", jsonb_array_length("recalcLog")),
             "recalcLog" = COALESCE((
               SELECT jsonb_agg(entry.value ORDER BY entry.ordinality)
                 FROM jsonb_array_elements("recalcLog") WITH ORDINALITY entry(value, ordinality)
                WHERE entry.ordinality > GREATEST(
                  jsonb_array_length("recalcLog") - $1,
                  0
                )
             ), '[]'::jsonb)
    `,
      [DAY_PLAN_RECALC_AUDIT_POLICY_V1.retainedEntries],
    );
    await queryRunner.query(`
      ALTER TABLE "feeding_day_plans"
        ADD CONSTRAINT "CHK_fdp_recalc_log_bounded"
        CHECK (jsonb_array_length("recalcLog") <= ${DAY_PLAN_RECALC_AUDIT_POLICY_V1.retainedEntries})
    `);
  }

  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ ok: boolean }> = await queryRunner.query(
      `
      SELECT to_regclass('feeding_day_plans') IS NULL OR NOT EXISTS (
        SELECT 1 FROM "feeding_day_plans"
         WHERE jsonb_array_length("recalcLog") > $1 OR "recalcCount" < jsonb_array_length("recalcLog")
      ) AS ok
    `,
      [DAY_PLAN_RECALC_AUDIT_POLICY_V1.retainedEntries],
    );
    return rows[0]?.ok === true;
  }

  public async down(): Promise<void> {
    // Forward-only: recalcCount is the only retained proof once old log entries
    // have been deliberately compacted.
  }
}
