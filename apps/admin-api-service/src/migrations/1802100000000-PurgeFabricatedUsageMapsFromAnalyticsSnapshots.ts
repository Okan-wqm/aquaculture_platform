import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PurgeFabricatedUsageMapsFromAnalyticsSnapshots — empty the invented
 * per-module / per-feature usage maps in the durable trend record (APA-133).
 *
 * `getUsageMetrics()` emitted a fully-keyed `moduleUsage` (7 modules) and
 * `featureAdoption` (6 features) map in which every value was a literal zero —
 * except `dashboard.activeUsers`, which carried the PLATFORM-WIDE daily-active
 * count attributed to a single module. Neither map has a producer: per-module
 * usage needs the audit-log analysis pipeline, which is not wired. The bare
 * `Record<string, …>` contract could not express "not instrumented", so the
 * only way to satisfy it was to invent the entries.
 *
 * The contract now encodes absence structurally (`Partial<Record<ModuleKey, …>>`,
 * "presence means measured") and the producer returns empty maps. Code alone is
 * not enough: the daily snapshot cron persisted the fabricated maps into
 * `admin.analytics_snapshots`, so they also sit in the historical record that
 * trend queries and the usage reports read back. This migration empties them so
 * no consumer — current or future — can resurface invented usage as data.
 *
 * # SAFETY SHAPE (data-only, idempotent, blue-green safe)
 *   * Touches ONLY `category = 'usage'` rows that still carry a non-empty map,
 *     so a re-run is a genuine no-op and other categories
 *     (tenant/user/financial/system) are untouched.
 *   * Sets the two keys to `{}` rather than dropping them: the `UsageMetrics`
 *     contract declares both as required properties, and an empty map is the
 *     canonical encoding of "nothing was measured". Every other metric in the
 *     snapshot — including the genuinely-queried `avgDailyActiveUsers` — is
 *     preserved byte-for-byte.
 *   * No schema change, no column drop, no lock beyond the updated rows — safe
 *     to run while the previous release is still serving.
 *   * Returns early when the table is absent (fresh DB built past this point).
 *
 * down() is intentionally a no-op: the purged values were fabricated, never
 * measured. Restoring them would re-introduce the defect this migration exists
 * to remove.
 */
export class PurgeFabricatedUsageMapsFromAnalyticsSnapshots1802100000000
  implements MigrationInterface
{
  name = 'PurgeFabricatedUsageMapsFromAnalyticsSnapshots1802100000000';

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
            jsonb_set(metrics, '{moduleUsage}', '{}'::jsonb, true),
            '{featureAdoption}', '{}'::jsonb, true
          )
      WHERE category = 'usage'
        AND (
          COALESCE(metrics -> 'moduleUsage', '{}'::jsonb) <> '{}'::jsonb
          OR COALESCE(metrics -> 'featureAdoption', '{}'::jsonb) <> '{}'::jsonb
        )
    `);
  }

  public async down(): Promise<void> {
    // No-op by design: the purged maps were fabricated constants, not
    // measurements. Re-adding them would restore the defect this migration
    // exists to remove.
  }
}
