import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationLogger } from '@aquaculture/backend-common/database';

/**
 * AddDailyBatchFeedingMaterializedView
 * ============================================================================
 *
 * Phase 7.2 of the "Farm modülü kalan kör noktalar" plan. Closes
 * the analytics-pipeline side of Girdi 15-C12.
 *
 * Before this migration every batch-performance / feeding-summary
 * dashboard query scanned `farm.feeding_records` row-by-row for a
 * date range, then GROUP BY'd by day in the app layer. For a two-
 * year batch the raw table carries O(3 meals × 365 days × tanks)
 * rows = ~2000 rows per batch per analytics request. An average
 * tenant with 50 batches re-runs the same query pattern on every
 * dashboard page view — O(100k rows) per refresh when the
 * analytics are really only asking "give me the per-day totals."
 *
 * # Design choice — plain materialized view, not continuous aggregate
 *
 * `database/migrations/modules/sensor/V003__create_continuous_aggregates.sql`
 * uses TimescaleDB's `CREATE MATERIALIZED VIEW WITH
 * (timescaledb.continuous)` because `sensor.sensor_metrics` is a
 * hypertable. `farm.feeding_records` is NOT a hypertable — it is a
 * plain PostgreSQL table. TimescaleDB rejects continuous aggregates
 * on plain tables. Converting feeding_records to a hypertable is
 * a separate decision with its own migration path.
 *
 * The architectural move is plain MATERIALIZED VIEW +
 * UNIQUE index + REFRESH MATERIALIZED VIEW CONCURRENTLY on a cron.
 * Refresh CONCURRENTLY takes a per-row lock instead of ACCESS
 * EXCLUSIVE, so readers keep querying during the refresh.
 *
 * When feeding_records graduates to a hypertable (phase 4.1
 * retention follow-up or a dedicated phase), the migration gets a
 * `WITH (timescaledb.continuous)` upgrade without touching the
 * consumer code — the view name stays `farm.mv_daily_batch_feeding`.
 *
 * # Columns
 *
 *   (tenantId, batchId, feedingDate) → sum(actualAmount) as total_kg,
 *                                        sum(variance) as variance_kg,
 *                                        count(*) as meal_count,
 *                                        avg(variancePercent) as avg_variance_pct,
 *                                        max(feedingDate) as last_fed_date
 *
 * The UNIQUE (tenantId, batchId, feedingDate) index is required for
 * REFRESH CONCURRENTLY — without it Postgres refuses. It also
 * doubles as the hot-path index for the cost calculator's
 * per-day-per-batch lookup.
 *
 * # Refresh strategy
 *
 * Nightly cron (`farm.scheduler.cron-jobs.service.ts`) issues
 * `REFRESH MATERIALIZED VIEW CONCURRENTLY farm.mv_daily_batch_feeding`
 * at 03:00 local. Worst-case staleness 24h on a dashboard metric —
 * acceptable because dashboards drive operational decisions, not
 * real-time control. Ops can trigger a manual refresh via the
 * admin-api explorer for urgent cases.
 */
export class AddDailyBatchFeedingMaterializedView1787400000000
  implements MigrationInterface
{
  /**
   * Required for `CREATE INDEX CONCURRENTLY` — the unique index on
   * the materialized view enables CONCURRENTLY-safe refresh, and
   * CONCURRENTLY cannot run inside TypeORM's default migration
   * transaction. Opting the migration out via `transaction = false`
   * lets CREATE INDEX CONCURRENTLY succeed. `IF NOT EXISTS` keeps
   * both statements idempotent so a re-run after a partial failure
   * finishes the job.
   */
  public transaction = false;

  private readonly logger = new MigrationLogger(
    'AddDailyBatchFeedingMaterializedView1787400000000',
  );

  /**
   * Wave 4-A.2 Dalga 3 bootstrap-restoration guard.
   *
   * `farm.feeding_records` is created by the source-schema baseline.
   * The hardcoded `farm.` prefix bypasses the runner's search_path
   * pinning so we check `information_schema.tables` with an explicit
   * schema filter.
   */
  private async hasFarmFeedingRecords(
    queryRunner: QueryRunner,
  ): Promise<boolean> {
    const rows: Array<{ exists: boolean }> = await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'farm'
          AND table_name = 'feeding_records'
      ) AS exists
    `);
    return rows[0]?.exists === true;
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.hasFarmFeedingRecords(queryRunner))) {
      this.logger.log(
        'Skipping AddDailyBatchFeedingMaterializedView — farm.feeding_records not present on this DB (installed by sibling baseline migration)',
      );
      return;
    }

    // CREATE MATERIALIZED VIEW — read-mostly view over
    // feeding_records. `WITH NO DATA` keeps the migration fast;
    // the first cron refresh populates the view.
    await queryRunner.query(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS farm.mv_daily_batch_feeding AS
      SELECT
        "tenantId"           AS tenant_id,
        "batchId"            AS batch_id,
        "feedingDate"        AS feeding_date,
        SUM("actualAmount")::numeric(14,3)     AS total_kg,
        SUM("variance")::numeric(14,3)          AS variance_kg,
        COUNT(*)::int                           AS meal_count,
        AVG("variancePercent")::numeric(6,2)    AS avg_variance_pct,
        MAX("createdAt")                        AS last_recorded_at
      FROM farm.feeding_records
      GROUP BY "tenantId", "batchId", "feedingDate"
      WITH NO DATA
    `);

    // UNIQUE index is required for REFRESH CONCURRENTLY. It also
    // doubles as the hot-path composite for the batch-performance
    // per-day lookup, so no extra cost beyond the view itself.
    // CONCURRENTLY keeps the migration non-blocking even on a busy
    // server where other migrations are running in parallel — the
    // MV is empty at this point (WITH NO DATA) so the cost is
    // effectively zero, but CONCURRENTLY satisfies the R3 lint
    // rule and future-proofs against re-runs on a populated view.
    await queryRunner.query(`
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ux_mv_daily_batch_feeding_tenant_batch_date
      ON farm.mv_daily_batch_feeding (tenant_id, batch_id, feeding_date)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS farm.ux_mv_daily_batch_feeding_tenant_batch_date`,
    );
    await queryRunner.query(
      `DROP MATERIALIZED VIEW IF EXISTS farm.mv_daily_batch_feeding`,
    );
  }
}
