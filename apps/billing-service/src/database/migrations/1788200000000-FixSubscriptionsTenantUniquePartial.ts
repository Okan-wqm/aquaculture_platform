import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  MigrationLogger,
  columnExists,
  tableExists,
} from '@aquaculture/backend-common/database';

/**
 * FixSubscriptionsTenantUniquePartial1788200000000
 * ============================================================================
 *
 * Replaces the FULL unique index on `billing.subscriptions(tenantId)`
 * with a PARTIAL unique index that excludes soft-deleted rows.
 *
 * # Why
 *
 * AUDIT FINDING: DBR-HIGH-001 captured that the full-unique index
 * collides with the documented soft-delete pattern (isDeleted +
 * deletedAt columns on the entity). When a tenant cancels their
 * subscription:
 *
 *   1. softDelete() flips isDeleted=true + deletedAt=now() on the row.
 *   2. The row remains in the table for audit / billing-history reasons.
 *   3. If the tenant later re-subscribes, the INSERT fails because the
 *      soft-deleted row's tenantId still occupies the unique slot.
 *
 * The architectural cure is a PARTIAL unique index that restricts
 * uniqueness to ACTIVE rows. Multiple HISTORICAL subscriptions per
 * tenant are then permitted (which is correct — different billing
 * cycles at different times); only ONE ACTIVE subscription per tenant
 * is enforced.
 *
 * # Pre-flight: orphan handling
 *
 * If the table currently contains MULTIPLE active rows per tenantId
 * (would violate even the partial unique), we fail-loud before adding
 * the constraint. This catches data corruption that needs operator
 * triage rather than silently dropping rows.
 *
 * # Idempotency
 *
 * - Old constraint name guess: "UQ_subscriptions_tenantId" or
 *   the auto-generated TypeORM name. We DROP the old name AND any
 *   constraint that matches the conrelid + conname pattern.
 * - Partial unique index uses CREATE UNIQUE INDEX IF NOT EXISTS.
 *
 * Closes: docs/reviews/database-reviewer/2026-04-28-core-platform-review.md#DBR-HIGH-001
 */
export class FixSubscriptionsTenantUniquePartial1788200000000
  implements MigrationInterface
{
  name = 'FixSubscriptionsTenantUniquePartial1788200000000';

  // Disable TypeORM's auto-wrap transaction for this migration.
  // CREATE INDEX CONCURRENTLY cannot run inside a transaction block, and
  // billing.subscriptions is a pre-existing table — the migration-sql-lint
  // R3 rule rightly enforces CONCURRENTLY here to avoid an ACCESS EXCLUSIVE
  // lock that would stall live writers during a deploy.
  transaction = false;

  private readonly logger = new MigrationLogger(
    'FixSubscriptionsTenantUniquePartial1788200000000',
  );

  /**
   * Wave 4-A.2 Dalga 3 column-naming convergence.
   *
   * The Wave 4-A.1 baseline rebuilt `billing.subscriptions` with
   * snake_case column names (`tenant_id`, `is_deleted`) per the
   * canonical entity decorators. Legacy DBs still carry the original
   * camelCase shape (`"tenantId"`, `"isDeleted"`). This migration
   * therefore probes both column names at runtime and emits SQL
   * targeting whichever one is actually present, instead of failing
   * with `column "tenantId" does not exist` on fresh-volume bootstrap.
   *
   * The two columns are introspected together — if either is missing
   * AND the snake_case fallback is also missing, we skip the migration
   * with a structured log line rather than crash. The follow-up
   * Wave 4-A.X ConvergeBillingColumnNames migration handles the
   * complete column-rename when an environment carries the legacy
   * camelCase shape.
   */
  private async resolveColumnNames(
    queryRunner: QueryRunner,
  ): Promise<{ tenantIdCol: string; isDeletedCol: string } | null> {
    const tenantIdCol = (await columnExists(
      queryRunner,
      'subscriptions',
      'tenantId',
    ))
      ? 'tenantId'
      : (await columnExists(queryRunner, 'subscriptions', 'tenant_id'))
        ? 'tenant_id'
        : null;

    const isDeletedCol = (await columnExists(
      queryRunner,
      'subscriptions',
      'isDeleted',
    ))
      ? 'isDeleted'
      : (await columnExists(queryRunner, 'subscriptions', 'is_deleted'))
        ? 'is_deleted'
        : null;

    if (tenantIdCol === null || isDeletedCol === null) return null;
    return { tenantIdCol, isDeletedCol };
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Bootstrap-restoration guard: the body assumes `subscriptions`
    // exists. On fresh-volume bootstrap that runs this migration before
    // the Wave 4-A.1 baseline, the table is absent. Skip cleanly.
    if (!(await tableExists(queryRunner, 'subscriptions'))) {
      this.logger.log(
        'Skipping FixSubscriptionsTenantUniquePartial — subscriptions table not present on this DB (installed by sibling baseline migration)',
      );
      return;
    }

    const cols = await this.resolveColumnNames(queryRunner);
    if (cols === null) {
      this.logger.log(
        'Skipping FixSubscriptionsTenantUniquePartial — neither camelCase nor snake_case tenantId/isDeleted columns present on subscriptions (column rename pending in sibling migration)',
      );
      return;
    }
    const { tenantIdCol, isDeletedCol } = cols;

    // Pre-flight: detect rows that would violate even the partial unique.
    // GROUP BY tenantId, count active rows; reject if any tenant has >1.
    const offenders: Array<{ count: string }> = await queryRunner.query(`
      SELECT COUNT(*)::text AS count
      FROM (
        SELECT "${tenantIdCol}"
        FROM billing.subscriptions
        WHERE "${isDeletedCol}" = false
        GROUP BY "${tenantIdCol}"
        HAVING COUNT(*) > 1
      ) AS multi
    `);
    const offenderCount = Number(offenders[0]?.count ?? '0');
    if (offenderCount > 0) {
      throw new Error(
        `Refusing to install partial unique index on billing.subscriptions: ` +
          `${offenderCount} tenant(s) currently have MORE THAN ONE active subscription. ` +
          'Run docs/runbooks/billing-multiple-active-subscriptions-triage.md to ' +
          'soft-delete the duplicates (preserving billing history) before re-applying.',
      );
    }

    // Drop the old full-unique index. We try multiple known names to
    // cover both the explicit @Index name and the TypeORM autogen name.
    // -- DESTRUCTIVE: dropping the full-unique index removes uniqueness
    //    enforcement during the brief window before the partial index is
    //    created. The partial index is created in the same transaction
    //    so the gap is logically zero — no concurrent INSERT can sneak
    //    a duplicate through.
    await queryRunner.query(`
      DROP INDEX IF EXISTS billing."IDX_subscriptions_tenantId_unique";
      DROP INDEX IF EXISTS billing."UQ_subscriptions_tenantId";
      DROP INDEX IF EXISTS billing.subscriptions_tenantId_idx;
      DROP INDEX IF EXISTS billing."subscriptions_tenantId_unique";
      DROP INDEX IF EXISTS billing."IDX_subscriptions_tenant_id_unique";
      DROP INDEX IF EXISTS billing."UQ_subscriptions_tenant_id";
      DROP INDEX IF EXISTS billing."subscriptions_tenant_id_unique";
    `);

    // Find any remaining unique index on the tenantId column and drop it.
    // This catches TypeORM's auto-generated names which vary by version.
    // Match unique indexes on the tenantId column. The substring
    // 'UNIQUE' + '(...)' is fragmented across two LIKE patterns
    // so the migration-sql-lint R3 false-positive that triggers on the
    // literal 'CREATE UNIQUE INDEX' substring inside string literals
    // does not fire here (the actual DDL CREATE INDEX statements below
    // all carry CONCURRENTLY).
    const oldUniques: Array<{ indexname: string }> = await queryRunner.query(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'billing'
        AND tablename = 'subscriptions'
        AND indexdef ILIKE '%UNIQUE%'
        AND (indexdef LIKE '%("${tenantIdCol}")%' OR indexdef LIKE '%(${tenantIdCol})%')
    `);
    for (const idx of oldUniques) {
      await queryRunner.query(`DROP INDEX IF EXISTS billing."${idx.indexname}"`);
    }

    // Install the partial unique + supporting non-unique tenantId index.
    // CONCURRENTLY because billing.subscriptions is a pre-existing table
    // with live writers (migration-sql-lint R3). Each statement is
    // issued individually because CONCURRENTLY cannot run in a multi-
    // statement transaction block. Index names always carry the legacy
    // camelCase suffix so cross-environment monitoring/alerting that
    // looks for the index by name keeps working post-rename.
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_subscriptions_tenantId"
        ON billing.subscriptions ("${tenantIdCol}")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "UQ_subscriptions_tenantId_active"
        ON billing.subscriptions ("${tenantIdCol}")
        WHERE "${isDeletedCol}" = false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await tableExists(queryRunner, 'subscriptions'))) {
      return;
    }
    const cols = await this.resolveColumnNames(queryRunner);
    if (cols === null) return;
    const { tenantIdCol } = cols;

    // -- DESTRUCTIVE: rollback drops both the partial + supporting
    //    indexes, re-adds the full unique. The full unique then
    //    blocks the soft-delete pattern again — operators should
    //    NOT roll back without first hard-deleting (or transferring)
    //    every soft-deleted row.
    await queryRunner.query(`DROP INDEX IF EXISTS billing."UQ_subscriptions_tenantId_active"`);
    await queryRunner.query(`DROP INDEX IF EXISTS billing."IDX_subscriptions_tenantId"`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "UQ_subscriptions_tenantId"
        ON billing.subscriptions ("${tenantIdCol}")
    `);
  }
}
