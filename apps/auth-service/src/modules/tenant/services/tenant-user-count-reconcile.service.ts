import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/**
 * TenantUserCountReconcileService — DBR-LOW-001 cure.
 * ============================================================================
 *
 * # Why this service exists
 *
 * `auth.tenants.userCount` is a denormalized counter incremented at
 * user-invite time (`apps/auth-service/src/modules/tenant/services/
 * user-lifecycle.service.ts:750`) via atomic SQL `INCREMENT`. The
 * decrement path runs on user soft-delete. Several edge cases let
 * drift accumulate silently:
 *
 *   1. A transaction rollback AFTER the increment but BEFORE the
 *      surrounding statement commits — Postgres rolls back the
 *      increment automatically, but if the increment ran in a
 *      separate transaction (it doesn't, today, but a future refactor
 *      could split it), drift accrues.
 *   2. Manual DB intervention (`DELETE FROM auth.users WHERE id=...`
 *      via psql) bypasses the application-side decrement entirely.
 *   3. GDPR right-to-erasure runs `UPDATE` on the user row to
 *      anonymise (NOT a DELETE), so userCount is correctly preserved
 *      — but a future hard-erasure path would skip the decrement.
 *   4. Tenant data import / replication runs may set userCount
 *      without auth.users insertion happening at the same time.
 *
 * Reconcile job is the architectural backstop: a periodic recompute
 * from auth.users is authoritative. Without one, drift silently
 * propagates forward and operator dashboards report wrong totals.
 *
 * # Architectural choices
 *
 *   - Daily cron at 04:00 UTC — late enough to be after most
 *     timezone business hours, early enough to surface drift before
 *     an operator's morning dashboard read.
 *   - Replace-with-computed semantics, NOT delta. A single drift
 *     ring would otherwise propagate forward; replacing with the
 *     authoritative count makes the recovery idempotent.
 *   - Drift > 1% between observed and stored count is logged at WARN
 *     so the operations team has a tripwire signal, not just a
 *     silent fixup.
 *   - Single SQL statement using GROUP BY — bounded by the number
 *     of tenants, not the number of users. Indexed scan on
 *     auth.users(tenantId) makes it cheap on a few-hundred-tenant
 *     deploy and still acceptable on a few-thousand-tenant deploy.
 *
 * Closes: docs/reviews/database-reviewer/2026-04-28-core-platform-review.md#DBR-LOW-001
 */
@Injectable()
export class TenantUserCountReconcileService {
  private readonly logger = new Logger(TenantUserCountReconcileService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async reconcileScheduled(): Promise<void> {
    try {
      const result = await this.reconcile();
      this.logger.log(
        `Tenant userCount reconcile: ${result.scanned} tenants scanned, ` +
          `${result.drifted} drifted (>1%), ${result.corrected} corrected.`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Tenant userCount reconcile failed: ${msg}`);
    }
  }

  /**
   * Public entry — exported for tests + operator manual invocation.
   * Returns a summary of the reconcile pass.
   */
  async reconcile(): Promise<{
    scanned: number;
    drifted: number;
    corrected: number;
  }> {
    // Single query that produces (tenantId, observedUserCount,
    // storedUserCount) tuples. LEFT JOIN over auth.tenants so
    // tenants with zero users (legitimate post-onboarding state)
    // also reconcile to 0 if their stored value drifted upward.
    const rows: Array<{
      tenant_id: string;
      observed: string;
      stored: string;
    }> = await this.dataSource.query(`
      SELECT
        t.id::text AS tenant_id,
        COALESCE(u.observed, 0)::text AS observed,
        t."userCount"::text AS stored
      FROM auth.tenants t
      LEFT JOIN (
        SELECT "tenantId", COUNT(*)::int AS observed
        FROM auth.users
        WHERE "isActive" = true
        GROUP BY "tenantId"
      ) u ON u."tenantId" = t.id
    `);

    let drifted = 0;
    let corrected = 0;

    for (const row of rows) {
      const observed = Number(row.observed);
      const stored = Number(row.stored);
      if (observed === stored) continue;

      // Drift threshold: 1% (relative) OR >= 2 absolute (small-tenant
      // case where a 1-user drift on a 50-user tenant is 2% but on a
      // 500-user tenant it's 0.2%). Either trips the WARN.
      const absDrift = Math.abs(observed - stored);
      const relDriftPct = stored > 0 ? (absDrift / stored) * 100 : 100;
      if (absDrift >= 2 || relDriftPct >= 1) {
        drifted++;
        this.logger.warn(
          `Tenant ${row.tenant_id} userCount drift: stored=${stored} observed=${observed} ` +
            `(absolute=${absDrift}, relative=${relDriftPct.toFixed(2)}%) — correcting.`,
        );
      }

      // Replace-with-computed semantics. Single UPDATE per drifted row;
      // no streaming because total tenant count is bounded.
      await this.dataSource.query(
        `UPDATE auth.tenants SET "userCount" = $1 WHERE id = $2`,
        [observed, row.tenant_id],
      );
      corrected++;
    }

    return { scanned: rows.length, drifted, corrected };
  }
}
