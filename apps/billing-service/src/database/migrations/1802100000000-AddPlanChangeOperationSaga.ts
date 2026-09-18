import { pinSearchPath } from '@aquaculture/backend-common/database';
import { MigrationInterface, QueryRunner } from 'typeorm';

interface MissingCountRow {
  missing: string;
}

/**
 * Turns billing.scheduled_plan_changes into the durable operation journal for
 * both immediate and future plan changes.
 *
 * The additive PROCESSING lease is what permits Stripe traffic to happen with
 * no open database transaction or pessimistic row lock. A crashed worker leaves
 * a recoverable row; retrying uses the row id as the Stripe idempotency key.
 */
export class AddPlanChangeOperationSaga1802100000000 implements MigrationInterface {
  name = 'AddPlanChangeOperationSaga1802100000000';

  // PostgreSQL enum labels must become visible before later statements use
  // them in the partial unique-index predicate.
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner, 'billing');

    await queryRunner.query(`
      ALTER TYPE billing.scheduled_plan_changes_status_enum
      ADD VALUE IF NOT EXISTS 'PROCESSING'
    `);
    await queryRunner.query(`
      ALTER TYPE billing.scheduled_plan_changes_status_enum
      ADD VALUE IF NOT EXISTS 'RECONCILIATION_REQUIRED'
    `);

    await queryRunner.query(`
      ALTER TABLE billing.scheduled_plan_changes
        ADD COLUMN IF NOT EXISTS "expectedSubscriptionVersion" integer,
        ADD COLUMN IF NOT EXISTS "targetStripePriceId" varchar(255),
        ADD COLUMN IF NOT EXISTS "currentPlanName" varchar(255),
        ADD COLUMN IF NOT EXISTS "proRataCredit" numeric(19,4) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "isUpgrade" boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "processingStartedAt" timestamptz,
        ADD COLUMN IF NOT EXISTS "processingToken" uuid,
        ADD COLUMN IF NOT EXISTS "attemptCount" integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "lastAttemptErrorCode" varchar(64)
    `);
    // R10-alter-column-unguarded: replay-guarded (no-op on second pass).
    await queryRunner.query(`
      DO $block$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'billing'
             AND table_name = 'scheduled_plan_changes'
             AND column_name = 'currentPlanId'
             AND is_nullable = 'NO'
        ) THEN
          ALTER TABLE billing.scheduled_plan_changes
            ALTER COLUMN "currentPlanId" DROP NOT NULL;
        END IF;
      END
      $block$
    `);

    await queryRunner.query(`
      UPDATE billing.scheduled_plan_changes change
         SET "expectedSubscriptionVersion" = subscription.version,
             "currentPlanName" = subscription.plan_name,
             "targetStripePriceId" = COALESCE(
               change."targetStripePriceId",
               plan.stripe_price_ids ->> subscription.billing_cycle::text
             )
        FROM billing.subscriptions subscription,
             billing.plans plan
       WHERE subscription.id = change."subscriptionId"
         AND subscription.tenant_id = change."tenantId"
         AND plan.id = change."newPlanId"
         AND change."expectedSubscriptionVersion" IS NULL
    `);

    const missingVersions = (await queryRunner.query(`
      SELECT COUNT(*)::text AS missing
        FROM billing.scheduled_plan_changes
       WHERE "expectedSubscriptionVersion" IS NULL
    `)) as MissingCountRow[];
    if (missingVersions[0]?.missing !== '0') {
      throw new Error(
        `plan-change saga backfill failed: ${missingVersions[0]?.missing ?? 'unknown'} operation(s) lack a subscription version`,
      );
    }

    // R10-alter-column-unguarded: guard the NOT NULL tightening for replay
    // safety — the second pass must be a no-op, not a crash.
    await queryRunner.query(`
      DO $block$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'billing'
             AND table_name = 'scheduled_plan_changes'
             AND column_name = 'expectedSubscriptionVersion'
             AND is_nullable = 'YES'
        ) THEN
          ALTER TABLE billing.scheduled_plan_changes
            ALTER COLUMN "expectedSubscriptionVersion" SET NOT NULL,
            ALTER COLUMN "currentPlanName" SET NOT NULL;
        END IF;
      END
      $block$
    `);

    await queryRunner.query(`
      UPDATE billing.scheduled_plan_changes
         SET "processingStartedAt" = NULL,
             "processingToken" = NULL,
             "attemptCount" = GREATEST("attemptCount", 0),
             "appliedAt" = CASE
               WHEN status = 'APPLIED' THEN COALESCE("appliedAt", "updatedAt")
               ELSE "appliedAt"
             END
       WHERE status <> 'PROCESSING'
          OR "attemptCount" < 0
          OR (status = 'APPLIED' AND "appliedAt" IS NULL)
    `);

    await queryRunner.query(`
      DO $block$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'CHK_scheduled_plan_change_attempt_count'
             AND conrelid = 'billing.scheduled_plan_changes'::regclass
        ) THEN
          ALTER TABLE billing.scheduled_plan_changes
            ADD CONSTRAINT "CHK_scheduled_plan_change_attempt_count"
            CHECK ("attemptCount" >= 0);
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'CHK_scheduled_plan_change_processing_lease'
             AND conrelid = 'billing.scheduled_plan_changes'::regclass
        ) THEN
          ALTER TABLE billing.scheduled_plan_changes
            ADD CONSTRAINT "CHK_scheduled_plan_change_processing_lease"
            CHECK (
              (
                status = 'PROCESSING'
                AND "processingStartedAt" IS NOT NULL
                AND "processingToken" IS NOT NULL
              ) OR (
                status <> 'PROCESSING'
                AND "processingStartedAt" IS NULL
                AND "processingToken" IS NULL
              )
            );
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'CHK_scheduled_plan_change_applied_timestamp'
             AND conrelid = 'billing.scheduled_plan_changes'::regclass
        ) THEN
          ALTER TABLE billing.scheduled_plan_changes
            ADD CONSTRAINT "CHK_scheduled_plan_change_applied_timestamp"
            CHECK (status <> 'APPLIED' OR "appliedAt" IS NOT NULL);
        END IF;
      END
      $block$
    `);

    const duplicateActiveOperations = (await queryRunner.query(`
      SELECT COUNT(*)::text AS missing
        FROM (
          SELECT "tenantId", "subscriptionId"
            FROM billing.scheduled_plan_changes
           WHERE status IN ('PENDING', 'PROCESSING', 'RECONCILIATION_REQUIRED')
           GROUP BY "tenantId", "subscriptionId"
          HAVING COUNT(*) > 1
        ) duplicate
    `)) as MissingCountRow[];
    if (duplicateActiveOperations[0]?.missing !== '0') {
      throw new Error(
        `plan-change saga activation failed: ${duplicateActiveOperations[0]?.missing ?? 'unknown'} subscription(s) have multiple active operations`,
      );
    }

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_scheduled_plan_changes_active_operation"
          ON billing.scheduled_plan_changes ("tenantId", "subscriptionId")
       WHERE status IN ('PENDING', 'PROCESSING', 'RECONCILIATION_REQUIRED')
    `);
  }

  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows = (await queryRunner.query(`
      SELECT COUNT(*)::text AS missing
        FROM (
          VALUES
            ('enum-processing', EXISTS (
              SELECT 1
                FROM pg_enum enum_value
                JOIN pg_type enum_type ON enum_type.oid = enum_value.enumtypid
                JOIN pg_namespace namespace ON namespace.oid = enum_type.typnamespace
               WHERE namespace.nspname = 'billing'
                 AND enum_type.typname = 'scheduled_plan_changes_status_enum'
                 AND enum_value.enumlabel = 'PROCESSING'
            )),
            ('enum-reconciliation', EXISTS (
              SELECT 1
                FROM pg_enum enum_value
                JOIN pg_type enum_type ON enum_type.oid = enum_value.enumtypid
                JOIN pg_namespace namespace ON namespace.oid = enum_type.typnamespace
               WHERE namespace.nspname = 'billing'
                 AND enum_type.typname = 'scheduled_plan_changes_status_enum'
                 AND enum_value.enumlabel = 'RECONCILIATION_REQUIRED'
            )),
            ('version-column', EXISTS (
              SELECT 1
                FROM information_schema.columns
               WHERE table_schema = 'billing'
                 AND table_name = 'scheduled_plan_changes'
                 AND column_name = 'expectedSubscriptionVersion'
                 AND is_nullable = 'NO'
            )),
            ('current-plan-name-column', EXISTS (
              SELECT 1
                FROM information_schema.columns
               WHERE table_schema = 'billing'
                 AND table_name = 'scheduled_plan_changes'
                 AND column_name = 'currentPlanName'
                 AND is_nullable = 'NO'
            )),
            ('active-operation-index', to_regclass(
              'billing."UQ_scheduled_plan_changes_active_operation"'
            ) IS NOT NULL),
            ('attempt-check', EXISTS (
              SELECT 1 FROM pg_constraint
               WHERE conname = 'CHK_scheduled_plan_change_attempt_count'
                 AND conrelid = 'billing.scheduled_plan_changes'::regclass
            )),
            ('lease-check', EXISTS (
              SELECT 1 FROM pg_constraint
               WHERE conname = 'CHK_scheduled_plan_change_processing_lease'
                 AND conrelid = 'billing.scheduled_plan_changes'::regclass
            )),
            ('applied-check', EXISTS (
              SELECT 1 FROM pg_constraint
               WHERE conname = 'CHK_scheduled_plan_change_applied_timestamp'
                 AND conrelid = 'billing.scheduled_plan_changes'::regclass
            ))
        ) checks(name, present)
       WHERE present = false
    `)) as MissingCountRow[];
    return rows[0]?.missing === '0';
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner, 'billing');
    await queryRunner.query(`
      DROP INDEX IF EXISTS billing."UQ_scheduled_plan_changes_active_operation"
    `);
    await queryRunner.query(`
      ALTER TABLE billing.scheduled_plan_changes
        DROP CONSTRAINT IF EXISTS "CHK_scheduled_plan_change_applied_timestamp",
        DROP CONSTRAINT IF EXISTS "CHK_scheduled_plan_change_processing_lease",
        DROP CONSTRAINT IF EXISTS "CHK_scheduled_plan_change_attempt_count"
    `);
    await queryRunner.query(`
      ALTER TABLE billing.scheduled_plan_changes
        DROP COLUMN IF EXISTS "lastAttemptErrorCode",
        DROP COLUMN IF EXISTS "attemptCount",
        DROP COLUMN IF EXISTS "processingToken",
        DROP COLUMN IF EXISTS "processingStartedAt",
        DROP COLUMN IF EXISTS "isUpgrade",
        DROP COLUMN IF EXISTS "proRataCredit",
        DROP COLUMN IF EXISTS "currentPlanName",
        DROP COLUMN IF EXISTS "targetStripePriceId",
        DROP COLUMN IF EXISTS "expectedSubscriptionVersion"
    `);
    // The pre-saga application created nullable plan_id subscriptions, so
    // restoring NOT NULL here could make rollback fail on valid legacy rows.
    // PostgreSQL enum labels are forward-only without recreating the type.
  }
}
