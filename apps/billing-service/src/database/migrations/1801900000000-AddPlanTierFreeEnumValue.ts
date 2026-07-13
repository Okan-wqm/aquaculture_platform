import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddPlanTierFreeEnumValue1801900000000
 *
 * Billing Revival Faz B (D4): add the 'free' label to billing's two plan-tier
 * enums so a FREE tenant provisions a real $0 subscription row.
 *
 *   - billing.subscriptions_plan_tier_enum → subscriptions.plan_tier column
 *   - billing.plans_tier_enum              → plans.tier column (FREE seed row)
 *
 * Both are required: the plan-seed writes a FREE catalog row (plans.tier='free')
 * and the provisioning handler inserts the subscription (subscriptions.plan_tier=
 * 'free'). Missing either label fails the insert with a 22P02 invalid-enum error.
 *
 * # Blue-green safety
 *
 * Additive enum labels are inherently blue-green safe — no NOT NULL backfill, and
 * old code simply never emits 'free'. MIGRATION FIRST, CODE SECOND: db-migrate is
 * the sole schema writer and runs before billing-service restart, so 'free' exists
 * in the enum before any handler can persist it.
 *
 * # Transaction discipline
 *
 * `ALTER TYPE ... ADD VALUE` cannot be consumed later in the SAME transaction, so
 * the migration opts out of the wrapping transaction (statement-level autocommit).
 * `IF NOT EXISTS` makes each ALTER idempotent on re-run. billing is a cross-tenant
 * platform schema (no per-tenant clones), so the types are addressed directly with
 * their `billing`-qualified names — no per-schema fan-out guard is needed.
 */
export class AddPlanTierFreeEnumValue1801900000000 implements MigrationInterface {
  name = 'AddPlanTierFreeEnumValue1801900000000';

  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "billing"."subscriptions_plan_tier_enum" ADD VALUE IF NOT EXISTS 'free'`,
    );
    await queryRunner.query(
      `ALTER TYPE "billing"."plans_tier_enum" ADD VALUE IF NOT EXISTS 'free'`,
    );
  }

  /**
   * Fail-closed: both enums must carry the 'free' label after the run.
   */
  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows = (await queryRunner.query(`
      WITH expected(typ, label) AS (VALUES
        ('subscriptions_plan_tier_enum', 'free'),
        ('plans_tier_enum', 'free'))
      SELECT COUNT(*)::text AS missing
        FROM expected x
       WHERE NOT EXISTS (
         SELECT 1
           FROM pg_type t
           JOIN pg_namespace n ON n.oid = t.typnamespace
           JOIN pg_enum e ON e.enumtypid = t.oid
          WHERE n.nspname = 'billing'
            AND t.typname = x.typ
            AND e.enumlabel = x.label
       )
    `)) as Array<{ missing: string }>;
    return rows[0]?.missing === '0';
  }

  public async down(): Promise<void> {
    // PostgreSQL cannot drop an enum value without recreating the type; additive
    // labels are forward-only (matches the platform's enum-value migration norm).
  }
}
