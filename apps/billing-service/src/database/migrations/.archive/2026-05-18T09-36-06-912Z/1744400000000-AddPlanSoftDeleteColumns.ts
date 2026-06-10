import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddPlanSoftDeleteColumns1744400000000
 * ============================================================================
 *
 * Closes G5 (soft-delete drift) from the 2026-04-14 log audit. The Plan
 * entity at `apps/billing-service/src/billing/entities/plan.entity.ts:115-124`
 * declares three soft-delete columns (`is_deleted BOOLEAN DEFAULT false`,
 * `deleted_at TIMESTAMPTZ NULL`, `deleted_by VARCHAR NULL`) plus the
 * partial index `idx_plan_is_deleted_partial`. None of these existed in
 * the production DB because billing-service had no migration runner —
 * the entity declarations drifted silently until the plan seeder tripped:
 *
 *   billing-service: Failed to seed plan "Starter":
 *     column Plan.deleted_at does not exist
 *
 * This migration reconciles the DB with the entity. All statements use
 * `IF NOT EXISTS` guards so it's safe to re-run on environments that
 * applied the columns manually before the migration landed (dev, staging
 * patched via psql, etc.).
 *
 * # Why a partial index
 *
 * Boolean is_deleted columns are extremely skewed (~99% false in normal
 * operation). A full B-tree index over the whole table indexes the
 * common case, blowing up index size with limited selectivity gain. The
 * partial index `WHERE is_deleted = false` restricts itself to active
 * plans — which is exactly the population every tenant-facing query
 * filters for. Ref entity comment at plan.entity.ts:109-113 and the
 * tracking finding DB-MEDIUM-008.
 *
 * # Why schema-qualified `billing.Plan`
 *
 * The billing-service TypeORM config uses `schema: 'billing'` but the
 * MigrationRunnerService pins `SET search_path TO "billing", public`
 * before every migration runs, so unqualified names would resolve first
 * against billing. Qualifying explicitly removes ambiguity for operators
 * reading the SQL and hardens the migration against any future change
 * that moves billing entities across schemas.
 */
export class AddPlanSoftDeleteColumns1744400000000 implements MigrationInterface {
  name = 'AddPlanSoftDeleteColumns1744400000000';

  public async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      ALTER TABLE IF EXISTS billing.plans
        ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT false;
    `);
    await qr.query(`
      ALTER TABLE IF EXISTS billing.plans
        ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL;
    `);
    await qr.query(`
      ALTER TABLE IF EXISTS billing.plans
        ADD COLUMN IF NOT EXISTS deleted_by VARCHAR NULL;
    `);
    await qr.query(`
      CREATE INDEX IF NOT EXISTS idx_plan_is_deleted_partial
        ON billing.plans (is_deleted)
        WHERE is_deleted = false;
    `);
  }

  public async down(qr: QueryRunner): Promise<void> {
    // Order matters: drop dependent index before its columns.
    await qr.query(`DROP INDEX IF EXISTS billing.idx_plan_is_deleted_partial;`);
    await qr.query(
      `ALTER TABLE IF EXISTS billing.plans DROP COLUMN IF EXISTS deleted_by;`,
    );
    await qr.query(
      `ALTER TABLE IF EXISTS billing.plans DROP COLUMN IF EXISTS deleted_at;`,
    );
    await qr.query(
      `ALTER TABLE IF EXISTS billing.plans DROP COLUMN IF EXISTS is_deleted;`,
    );
  }
}
