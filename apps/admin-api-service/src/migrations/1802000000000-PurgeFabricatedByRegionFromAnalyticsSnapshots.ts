import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PurgeFabricatedByRegionFromAnalyticsSnapshots — remove the fabricated
 * regional distribution from the durable trend record (APA-132).
 *
 * `getTenantMetrics()` built `byRegion` as `{ TR: total, EU: 0, US: 0, APAC: 0 }`
 * — every tenant assigned to Turkey by a literal. There is no region/country
 * column anywhere on the tenant SSoT (`auth.tenants`), so the platform never had
 * the data; the REQUIRED `byRegion` field on the `TenantMetrics` contract left
 * the compiler no option but a constant. The contract field, the producer and
 * the "Bolgesel Dagilim" card are deleted in the same change.
 *
 * Code alone is not enough: the daily snapshot cron persisted that constant into
 * `admin.analytics_snapshots`, so the fabrication also sits in the historical
 * record that trend queries read. This migration strips the key from the stored
 * jsonb so no consumer — current or future — can resurface it as data.
 *
 * # SAFETY SHAPE (data-only, idempotent, blue-green safe)
 *   * Touches ONLY `category = 'tenant'` rows that actually carry the key
 *     (`metrics ? 'byRegion'`), so re-running is a no-op and other categories
 *     (user/financial/system/usage) are untouched.
 *   * `metrics - 'byRegion'` removes a single jsonb key; every other metric in
 *     the snapshot is preserved byte-for-byte.
 *   * No schema change, no column drop, no lock beyond the updated rows — safe
 *     to run while the previous release is still serving.
 *   * Returns early when the table is absent (fresh DB built past this point).
 *
 * down() is intentionally a no-op: the removed value was fabricated, never
 * measured. Restoring it would re-introduce the defect, and the original
 * constant is reconstructible from `total` anyway if anyone ever needed it.
 */
export class PurgeFabricatedByRegionFromAnalyticsSnapshots1802000000000
  implements MigrationInterface
{
  name = 'PurgeFabricatedByRegionFromAnalyticsSnapshots1802000000000';

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
      SET metrics = metrics - 'byRegion'
      WHERE category = 'tenant'
        AND metrics ? 'byRegion'
    `);
  }

  public async down(): Promise<void> {
    // No-op by design: the purged value was a fabricated constant, not a
    // measurement. Re-adding it would restore the defect this migration exists
    // to remove.
  }
}
