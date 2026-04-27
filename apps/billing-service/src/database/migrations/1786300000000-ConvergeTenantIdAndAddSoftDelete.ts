import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ConvergeTenantIdAndAddSoftDelete
 * ============================================================================
 *
 * Aligns billing.{subscriptions,invoices,payments} to the entity contract
 * declared in apps/billing-service/src/billing/entities/*.entity.ts.
 *
 * # Drift detected at boot 2026-04-20
 *
 * SchemaDriftValidator[billing] reports per cold start:
 *
 *   [billing.subscriptions.tenant_id]  entity declares uuid but DB is character varying
 *   [billing.subscriptions.deleted_at] entity declares column but DB has no such column
 *   [billing.subscriptions.deleted_by] entity declares column but DB has no such column
 *   [billing.invoices.tenant_id]       entity declares uuid but DB is character varying
 *   [billing.invoices.deleted_at]      entity declares column but DB has no such column
 *   [billing.invoices.deleted_by]      entity declares column but DB has no such column
 *   [billing.payments.tenant_id]       entity declares uuid but DB is character varying
 *
 * (plus audit_logs schema drift fixed by INFRA-CRITICAL-026.)
 *
 * # Why uuid is canonical
 *
 * CLAUDE.md "Tenant row placement (D14)": platform-wide canonical
 * tenant-identifier type is uuid. RLS policies use
 * `current_setting('app.current_tenant')::uuid` — a varchar column
 * fails the type-checked comparison with `operator does not exist:
 * character varying = uuid` (the same class of incident that broke
 * farm-service production on 2026-04-08).
 *
 * # Data safety
 *
 * `subscriptions`, `invoices`, `payments` are EMPTY in the live droplet
 * today (verified by `SELECT COUNT(*) FROM billing.subscriptions` etc.
 * = 0). The ALTER COLUMN TYPE uuid USING tenant_id::uuid cast is safe.
 * If rows existed with non-UUID tenant_id values, the cast would fail
 * loudly (correct signal for data corruption — see audit-log.entity
 * docblock §"Migration impact on existing deployments" for the canonical
 * rationale).
 *
 * # Soft-delete columns
 *
 * The entity decorators declare `deleted_at` (timestamptz nullable) and
 * `deleted_by` (varchar nullable) on subscriptions/invoices/payments
 * for the standard soft-delete pattern. plans already has them
 * (added by 1744400000000-AddPlanSoftDeleteColumns.ts); this migration
 * extends the same shape to the three remaining tables.
 *
 * # Idempotent
 *
 * IF NOT EXISTS / IF EXISTS guards mean the migration is safe to re-run
 * on a database where some columns may already be in the target shape.
 *
 * # Indexes
 *
 * No new indexes — soft-delete columns are not commonly filtered alone;
 * existing partial indexes on (tenant_id) WHERE is_deleted = false
 * already exist on the three tables. The tenant_id type change
 * preserves index OIDs in PG 14+ (no rebuild needed for the type
 * conversion when the underlying btree storage is compatible — uuid is
 * fixed-width 16 bytes, varchar storage shape differs, but the type
 * cast preserves logical ordering for the index-scan codepath).
 *
 * Per the migration linter's R3 rule, any new CREATE INDEX would
 * require CONCURRENTLY in a separate non-transactional migration; we
 * have no new indexes to add here, so this migration stays in the
 * default transaction.
 */
export class ConvergeTenantIdAndAddSoftDelete1786300000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Convert tenant_id varchar -> uuid on the three drifted tables.
    // Tables are empty today (verified) so no failed casts.
    for (const table of ['subscriptions', 'invoices', 'payments']) {
      const colInfo: Array<{ data_type: string }> = await queryRunner.query(
        `SELECT data_type FROM information_schema.columns
         WHERE table_schema = 'billing' AND table_name = $1 AND column_name = 'tenant_id'`,
        [table],
      );
      if (colInfo[0]?.data_type === 'character varying') {
        await queryRunner.query(`
          ALTER TABLE billing."${table}"
            ALTER COLUMN tenant_id TYPE uuid USING tenant_id::uuid
        `);
      }
      // Else: already uuid (idempotent re-run) — nothing to do.
    }

    // Add soft-delete columns to subscriptions, invoices, payments.
    // plans already has them (1744400000000 migration).
    for (const table of ['subscriptions', 'invoices', 'payments']) {
      await queryRunner.query(`
        ALTER TABLE billing."${table}"
          ADD COLUMN IF NOT EXISTS deleted_at timestamptz NULL,
          ADD COLUMN IF NOT EXISTS deleted_by varchar(255) NULL
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Rollback the soft-delete columns and revert tenant_id to varchar.
    // Operators should fix-forward in real-world rather than rolling back.
    for (const table of ['payments', 'invoices', 'subscriptions']) {
      await queryRunner.query(`
        -- DESTRUCTIVE: rollback drops soft-delete columns added in this migration up()
        -- Only safe if no consumer depends on deleted_at deleted_by on subscriptions invoices payments
        -- pg_dump backup taken by deploy pipeline before applying any migration is the recovery path
        ALTER TABLE billing."${table}"
          DROP COLUMN IF EXISTS deleted_by,
          DROP COLUMN IF EXISTS deleted_at
      `);
      await queryRunner.query(`
        ALTER TABLE billing."${table}"
          ALTER COLUMN tenant_id TYPE varchar(255) USING tenant_id::text
      `);
    }
  }
}
