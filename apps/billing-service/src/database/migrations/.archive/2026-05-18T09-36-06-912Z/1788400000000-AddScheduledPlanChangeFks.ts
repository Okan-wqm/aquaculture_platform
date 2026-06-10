import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddScheduledPlanChangeFks1788400000000
 * ============================================================================
 *
 * Adds explicit foreign-key constraints to
 * `billing.scheduled_plan_changes` for `subscriptionId`, `currentPlanId`,
 * and `newPlanId` — three bare uuid columns that reference
 * `billing.subscriptions(id)` and `billing.plans(id)` semantically but
 * had no DB-level constraint enforcing the reference.
 *
 * # Why this migration exists
 *
 * Pre-fix the entity declared each column as `@Column({ type: 'uuid' })`
 * with no relation decorator and no migration-side FK. This means a
 * subscription row could be deleted while a ScheduledPlanChange still
 * references it — leaving the change to fire against a vanished
 * subscription at currentPeriodEnd. DBR-MEDIUM-002 captured the gap.
 *
 * RESTRICT semantics is the right answer for all three:
 *   - subscriptionId → subscriptions(id) ON DELETE RESTRICT — a
 *     subscription with pending plan-change rows must not be hard-
 *     deletable; soft-delete via deleted_at is the only allowed lifecycle.
 *   - currentPlanId → plans(id) ON DELETE RESTRICT — the plan snapshot
 *     at scheduling time is operationally meaningful; deleting the row
 *     would lose audit history.
 *   - newPlanId → plans(id) ON DELETE RESTRICT — same rationale; the
 *     scheduled change CANNOT fire against a plan that no longer exists.
 *
 * # Pre-flight check
 *
 * Before installing the FKs, verify there are no orphan rows. Orphans
 * would cause the ALTER TABLE to fail mid-validation; we surface the
 * count fail-loud with a runbook pointer so operators triage rather
 * than silently re-run.
 *
 * # Down-rollback
 *
 * Drops the three FKs. Reverting to the pre-fix unconstrained state is
 * a regression; operators using down() should be aware that the
 * post-down state allows orphan rows.
 *
 * Closes: docs/reviews/database-reviewer/2026-04-28-core-platform-review.md#DBR-MEDIUM-002
 */
export class AddScheduledPlanChangeFks1788400000000
  implements MigrationInterface
{
  name = 'AddScheduledPlanChangeFks1788400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Step 1: pre-flight orphan scan.
    //
    // WHY: ALTER TABLE ADD CONSTRAINT validates against the existing rows.
    // If a referenced row already vanished (e.g., a hard-deleted plan in
    // a dev environment), the validation fails halfway and rolls back —
    // operators get a generic FK violation error instead of an actionable
    // count. Pre-flight surfaces the problem fail-loud with a triage
    // pointer.
    // The W4-A2 billing baseline (1700000000000-CreateInitialSchema)
    // creates `scheduled_plan_changes.currentPlanId` and `newPlanId` as
    // `uuid` directly (matching `billing.plans.id`'s uuid PK) even
    // though the entity declares plain `@Column() … !: string`. The
    // baseline docblock at lines 731-755 codifies this deliberate
    // override of TypeORM's varchar default. The original migration
    // was authored against legacy DBs where these columns were varchar
    // and `plans.id::text` was the cast bridge — on a fresh post-W4-A2
    // DB both sides are uuid, so the cast triggers
    // `operator does not exist: uuid = text`. Drop the cast: both sides
    // are uuid now and the IN comparison resolves natively.
    const orphans: Array<{
      orphan_subs: string;
      orphan_current: string;
      orphan_new: string;
    }> = await queryRunner.query(`
      SELECT
        COUNT(*) FILTER (
          WHERE spc."subscriptionId" NOT IN (SELECT id FROM billing.subscriptions)
        )::text AS orphan_subs,
        COUNT(*) FILTER (
          WHERE spc."currentPlanId" NOT IN (SELECT id FROM billing.plans)
        )::text AS orphan_current,
        COUNT(*) FILTER (
          WHERE spc."newPlanId" NOT IN (SELECT id FROM billing.plans)
        )::text AS orphan_new
      FROM billing.scheduled_plan_changes spc
    `);
    const o = orphans[0] ?? { orphan_subs: '0', orphan_current: '0', orphan_new: '0' };
    const total =
      Number(o.orphan_subs) + Number(o.orphan_current) + Number(o.orphan_new);
    if (total > 0) {
      throw new Error(
        `Refusing to install FKs on billing.scheduled_plan_changes: ` +
          `${o.orphan_subs} row(s) reference deleted subscriptions, ` +
          `${o.orphan_current} reference deleted currentPlanId, ` +
          `${o.orphan_new} reference deleted newPlanId. ` +
          'Run docs/runbooks/billing-scheduled-plan-change-orphan-triage.md ' +
          'to cancel or repair the orphan rows before re-applying.',
      );
    }

    // Step 2: subscriptionId FK. Idempotent via IF NOT EXISTS guard.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = 'billing'
            AND table_name = 'scheduled_plan_changes'
            AND constraint_name = 'fk_spc_subscriptionId_subscriptions'
        ) THEN
          ALTER TABLE billing.scheduled_plan_changes
            ADD CONSTRAINT fk_spc_subscriptionId_subscriptions
            FOREIGN KEY ("subscriptionId")
            REFERENCES billing.subscriptions (id)
            ON DELETE RESTRICT;
        END IF;
      END $$;
    `);

    // Step 3: currentPlanId FK. Both currentPlanId and plans.id are
    // uuid in fresh W4-A2 DBs (baseline migration codifies the column
    // type override at apps/billing-service/src/database/migrations/
    // 1700000000000-CreateInitialSchema.ts:759). Native uuid-to-uuid
    // FK resolution; no cast required.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = 'billing'
            AND table_name = 'scheduled_plan_changes'
            AND constraint_name = 'fk_spc_currentPlanId_plans'
        ) THEN
          ALTER TABLE billing.scheduled_plan_changes
            ADD CONSTRAINT fk_spc_currentPlanId_plans
            FOREIGN KEY ("currentPlanId")
            REFERENCES billing.plans (id)
            ON DELETE RESTRICT;
        END IF;
      END $$;
    `);

    // Step 4: newPlanId FK.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = 'billing'
            AND table_name = 'scheduled_plan_changes'
            AND constraint_name = 'fk_spc_newPlanId_plans'
        ) THEN
          ALTER TABLE billing.scheduled_plan_changes
            ADD CONSTRAINT fk_spc_newPlanId_plans
            FOREIGN KEY ("newPlanId")
            REFERENCES billing.plans (id)
            ON DELETE RESTRICT;
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE billing.scheduled_plan_changes DROP CONSTRAINT IF EXISTS fk_spc_newPlanId_plans
    `);
    await queryRunner.query(`
      ALTER TABLE billing.scheduled_plan_changes DROP CONSTRAINT IF EXISTS fk_spc_currentPlanId_plans
    `);
    await queryRunner.query(`
      ALTER TABLE billing.scheduled_plan_changes DROP CONSTRAINT IF EXISTS fk_spc_subscriptionId_subscriptions
    `);
  }
}
