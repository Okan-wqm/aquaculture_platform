import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DropSubscriptionProvisioningRetries — retire the dead event-driven
 * subscription-provisioning retry store (ORPHAN-MEDIUM-395).
 *
 * WHY: `billing.subscription_provisioning_retries` existed solely to back the
 * `TenantSubscriptionRequestedHandler` — a handler registered NOWHERE
 * (`billing.module.ts` `EventHandlers: never[] = []`) whose triggering event
 * `TenantSubscriptionRequested` had ZERO emitters repo-wide. The live tenant
 * provisioning path is the `PROVISION_TENANT_SUBSCRIPTION` NATS request-reply
 * command + `billing.command_receipts` (idempotent, receipt-confirmed); this
 * retry table and its `@Cron` loop were a Potemkin second model. The handler,
 * its retry/cron machinery, and the event contract are deleted in the same PR.
 *
 * NO ARCHIVE — evidence: the live production database was read (read-only)
 * on 2026-07-13 and held ZERO rows
 * (`SELECT count(*) FROM billing.subscription_provisioning_retries` = 0). The
 * table never carried application state on any known environment (its only
 * writer was the never-registered handler), so a jsonb archive-before-drop
 * would preserve nothing. The house archive pattern
 * (1801700000000-DropRetiredTenantUsageMetrics) is intentionally NOT applied
 * here because there is no data to preserve.
 *
 * SHAPE:
 *   - IF-EXISTS-guarded, so it is correct on fresh (Baseline-built), behind,
 *     and current databases alike.
 *   - `status` is a plain VARCHAR(20) (no enum type), so no orphaned enum to
 *     drop — unlike the tenant_usage_metrics retirement.
 *   - Forward-only: `down()` is a no-op; recreating the table would resurrect
 *     the dead parallel model this migration removes.
 */
export class DropSubscriptionProvisioningRetries1801800000000 implements MigrationInterface {
  name = 'DropSubscriptionProvisioningRetries1801800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS billing.idx_spr_status_next_retry`);
    // DESTRUCTIVE: dead event-driven retry store — never registered handler, zero emitters, 0 live rows (verified 2026-07-13); no archive because there is no application state to preserve; rollback = re-run 1800300000000 (intentionally not automated).
    await queryRunner.query(`DROP TABLE IF EXISTS billing.subscription_provisioning_retries`);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Forward-only retirement. The table backed a handler that was never
    // registered and an event with no emitter — there is no application state
    // to restore. Recreating it would resurrect the dead parallel provisioning
    // model. Intentionally a no-op.
  }
}
