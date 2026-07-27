import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PurgeChurnProxyFromAnalyticsSnapshots — null out the proxied churn figures in
 * the durable trend record (APA-135).
 *
 * `getTenantMetrics()` derived churn from
 * `status IN ('CANCELLED','SUSPENDED') AND "updatedAt" >= date_trunc('month', NOW())`.
 * Both halves were wrong. `updatedAt` is an `@UpdateDateColumn` on
 * `auth.tenants`, so it means "last touched": any unrelated write re-dated a
 * long-suspended tenant into the current month, and the billing plan projection
 * does exactly that on every plan or trial change. `'CANCELLED'` is meanwhile
 * unreachable on `auth.tenants` — the lifecycle machine never targets it — so
 * the filter collapsed to the REVERSIBLE suspended state, which is not churn.
 *
 * `churnRate` and `growthRate` were computed from that count, so all three
 * values in every stored snapshot are proxied rather than measured.
 *
 * The contract now types them `number | null` and the producer emits null. Code
 * alone is not enough: the daily cron persisted the proxy into
 * `admin.analytics_snapshots`, and `getTrendFromSnapshots` reads those rows
 * back, so the fabrication would keep surfacing as a trend line long after the
 * producer stopped creating it.
 *
 * # SAFETY SHAPE (data-only, idempotent, blue-green safe)
 *   * Touches ONLY `category = 'tenant'` rows that still hold a non-null value
 *     for one of the three keys, so a re-run is a genuine no-op and other
 *     categories are untouched.
 *   * Sets the three keys to JSON `null` rather than removing them: the
 *     `TenantMetrics` contract declares all three as required properties, and
 *     `null` is the canonical encoding of "not measured". Every other metric in
 *     the snapshot — including the genuinely-queried `total`, `active` and
 *     `newThisMonth` — is preserved byte-for-byte.
 *   * No schema change, no column drop, no lock beyond the updated rows.
 *   * Returns early when the table is absent (fresh DB built past this point).
 *
 * down() is intentionally a no-op: the purged values were a proxy, never a
 * measurement. Restoring them would re-introduce the defect.
 */
export class PurgeChurnProxyFromAnalyticsSnapshots1802200000000 implements MigrationInterface {
  name = 'PurgeChurnProxyFromAnalyticsSnapshots1802200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const tableExists: Array<{ exists: boolean }> = await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'admin' AND table_name = 'analytics_snapshots'
      ) AS exists
    `);
    if (!tableExists[0]?.exists) {
      return;
    }

    await queryRunner.query(`
      UPDATE admin.analytics_snapshots
      SET metrics = jsonb_set(
            jsonb_set(
              jsonb_set(metrics, '{churnedThisMonth}', 'null'::jsonb, true),
              '{churnRate}', 'null'::jsonb, true
            ),
            '{growthRate}', 'null'::jsonb, true
          )
      WHERE category = 'tenant'
        AND (
          metrics -> 'churnedThisMonth' IS DISTINCT FROM 'null'::jsonb
          OR metrics -> 'churnRate' IS DISTINCT FROM 'null'::jsonb
          OR metrics -> 'growthRate' IS DISTINCT FROM 'null'::jsonb
        )
    `);
  }

  public async down(): Promise<void> {
    // No-op by design: the purged values were a timestamp proxy, not a
    // measurement. Re-adding them would restore the defect this migration
    // exists to remove.
  }
}
