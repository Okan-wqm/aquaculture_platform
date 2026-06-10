import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationLogger } from '@aquaculture/backend-common/database';

/**
 * AddDailyTankWaterQualityMaterializedView
 * ============================================================================
 *
 * Phase 7.2.2 — second materialized view in the analytics pipeline
 * introduced by phase 7.2. Pre-computes per-(tenant, tank, day)
 * avg / min / max / sample_count rollups over the scalar water-
 * quality columns so dashboard cards stop scanning
 * `farm.water_quality_measurements` row-by-row.
 *
 * Volume motivation: a single operator runs ~12 measurements per
 * tank per day (hourly during daylight) × 100 tanks = 1200 rows
 * per day per tenant. A year's dashboard view over raw rows reads
 * ~438k rows; the MV reads 36.5k rows.
 *
 * # Columns
 *
 *   (tenantId, tankId, bucket_day) →
 *     avg_temperature, min_temperature, max_temperature,
 *     avg_dissolved_oxygen, min_dissolved_oxygen, max_dissolved_oxygen,
 *     avg_ph, min_ph, max_ph,
 *     avg_ammonia, min_ammonia, max_ammonia,
 *     avg_nitrite, min_nitrite, max_nitrite,
 *     sample_count
 *
 * Pond-only measurements (tankId IS NULL) are excluded — phase
 * 7.2.3 can add a parallel MV for ponds when the dashboard
 * surfaces that dimension.
 *
 * # Refresh + upgrade path
 *
 * Nightly `REFRESH MATERIALIZED VIEW CONCURRENTLY` at 03:00 via
 * `CronJobsService.refreshAnalyticsViews` (phase 7.2 baseline).
 * The view name stays stable if `water_quality_measurements`
 * later graduates to a TimescaleDB hypertable — the definition
 * simply gains `WITH (timescaledb.continuous)` without touching
 * dashboard consumers.
 *
 * # Transactional policy
 *
 * `transaction = false` so `CREATE INDEX CONCURRENTLY` can run —
 * matches the phase-7.2 pattern.
 */
export class AddDailyTankWaterQualityMaterializedView1787500000000
  implements MigrationInterface
{
  public transaction = false;

  private readonly logger = new MigrationLogger(
    'AddDailyTankWaterQualityMaterializedView1787500000000',
  );

  /**
   * Wave 4-A.2 Dalga 3 bootstrap-restoration guard.
   *
   * `farm.water_quality_measurements` is created by the source-schema
   * baseline (or a sibling per-tenant migration on tenant fan-out). On
   * a fresh-volume bootstrap the table may not exist when this MV
   * migration runs. The hardcoded `farm.` prefix bypasses search_path
   * pinning so we check `information_schema.tables` with an explicit
   * schema filter.
   */
  private async hasFarmWaterQualityMeasurements(
    queryRunner: QueryRunner,
  ): Promise<boolean> {
    const rows: Array<{ exists: boolean }> = await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'farm'
          AND table_name = 'water_quality_measurements'
      ) AS exists
    `);
    return rows[0]?.exists === true;
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.hasFarmWaterQualityMeasurements(queryRunner))) {
      this.logger.log(
        'Skipping AddDailyTankWaterQualityMaterializedView — farm.water_quality_measurements not present on this DB (installed by sibling baseline migration)',
      );
      return;
    }

    await queryRunner.query(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS farm.mv_daily_tank_water_quality AS
      SELECT
        "tenantId"                                 AS tenant_id,
        "tankId"                                   AS tank_id,
        date_trunc('day', "measuredAt")::date      AS bucket_day,
        AVG("temperature")::numeric(6,2)           AS avg_temperature,
        MIN("temperature")::numeric(6,2)           AS min_temperature,
        MAX("temperature")::numeric(6,2)           AS max_temperature,
        AVG("dissolvedOxygen")::numeric(6,2)       AS avg_dissolved_oxygen,
        MIN("dissolvedOxygen")::numeric(6,2)       AS min_dissolved_oxygen,
        MAX("dissolvedOxygen")::numeric(6,2)       AS max_dissolved_oxygen,
        AVG("pH")::numeric(5,2)                    AS avg_ph,
        MIN("pH")::numeric(5,2)                    AS min_ph,
        MAX("pH")::numeric(5,2)                    AS max_ph,
        AVG("ammonia")::numeric(7,3)               AS avg_ammonia,
        MIN("ammonia")::numeric(7,3)               AS min_ammonia,
        MAX("ammonia")::numeric(7,3)               AS max_ammonia,
        AVG("nitrite")::numeric(7,3)               AS avg_nitrite,
        MIN("nitrite")::numeric(7,3)               AS min_nitrite,
        MAX("nitrite")::numeric(7,3)               AS max_nitrite,
        COUNT(*)::int                              AS sample_count
      FROM farm.water_quality_measurements
      WHERE "tankId" IS NOT NULL
      GROUP BY "tenantId", "tankId", date_trunc('day', "measuredAt")::date
      WITH NO DATA
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ux_mv_daily_tank_water_quality_tenant_tank_day
      ON farm.mv_daily_tank_water_quality (tenant_id, tank_id, bucket_day)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS farm.ux_mv_daily_tank_water_quality_tenant_tank_day`,
    );
    await queryRunner.query(
      `DROP MATERIALIZED VIEW IF EXISTS farm.mv_daily_tank_water_quality`,
    );
  }
}
