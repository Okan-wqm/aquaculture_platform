import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationLogger } from '@aquaculture/backend-common';

/**
 * Migration: Create Continuous Aggregates for Sensor Metrics
 *
 * This migration creates materialized views for efficient time-series queries:
 * - metrics_1min: 1-minute aggregates (kept for 1 year)
 * - metrics_1hour: 1-hour aggregates (kept for 5 years)
 * - metrics_1day: Daily aggregates (kept forever)
 *
 * These aggregates are automatically refreshed by TimescaleDB and provide
 * fast queries for dashboards and historical analysis.
 *
 * Query Strategy:
 * - Last 1 hour: Use raw sensor_metrics
 * - Last 24 hours: Use metrics_1min
 * - Last 30 days: Use metrics_1hour
 * - 30+ days: Use metrics_1day
 */
export class CreateContinuousAggregates1735900001000 implements MigrationInterface {
  private readonly logger = new MigrationLogger('CreateContinuousAggregates1735900001000');
  name = 'CreateContinuousAggregates1735900001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const schema: Array<{ current_schema: string }> = await queryRunner.query(`SELECT current_schema()`);
    this.logger.log('Running CreateContinuousAggregates migration in schema:', schema);

    // Check if TimescaleDB is available
    const isTimescaleAvailable = await this.checkTimescaleDB(queryRunner);
    if (!isTimescaleAvailable) {
      this.logger.warn('TimescaleDB not available, skipping continuous aggregates');
      return;
    }

    // 1. Create 1-minute aggregate
    try {
      await queryRunner.query(`
        CREATE MATERIALIZED VIEW IF NOT EXISTS metrics_1min
        WITH (timescaledb.continuous) AS
        SELECT
          time_bucket('1 minute', time) AS bucket,
          tenant_id,
          sensor_id,
          channel_id,
          tank_id,

          -- Statistics
          AVG(value) AS avg_value,
          MIN(value) AS min_value,
          MAX(value) AS max_value,
          STDDEV(value) AS stddev_value,

          -- First/Last for trend analysis
          FIRST(value, time) AS first_value,
          LAST(value, time) AS last_value,

          -- Data quality metrics
          COUNT(*) AS sample_count,
          COUNT(*) FILTER (WHERE quality_code >= 192) AS good_count,
          COUNT(*) FILTER (WHERE quality_code < 192) AS bad_count,

          -- Latency stats
          AVG(ingestion_latency_ms) AS avg_latency_ms,
          MAX(ingestion_latency_ms) AS max_latency_ms

        FROM sensor_metrics
        GROUP BY bucket, tenant_id, sensor_id, channel_id, tank_id
        WITH NO DATA
      `);
      this.logger.log('Created metrics_1min continuous aggregate');

      // Enable real-time query pass-through so the open (un-materialized) bucket is
      // included in results without waiting for the next aggregate refresh (MEDIUM-007)
      try {
        await queryRunner.query(`
          ALTER MATERIALIZED VIEW metrics_1min SET (timescaledb.materialized_only = false)
        `);
      } catch (error) {
        this.logger.warn('Could not set materialized_only=false on metrics_1min:', error);
      }

      // Refresh policy: every 1 minute, starting from 3 minutes ago
      await queryRunner.query(`
        SELECT add_continuous_aggregate_policy('metrics_1min',
          start_offset => INTERVAL '3 minutes',
          end_offset => INTERVAL '1 minute',
          schedule_interval => INTERVAL '1 minute',
          if_not_exists => TRUE
        )
      `);

      // Retention: 1 year
      await queryRunner.query(`
        SELECT add_retention_policy('metrics_1min', INTERVAL '1 year', if_not_exists => TRUE)
      `);
      this.logger.log('Added policies for metrics_1min');

    } catch (error) {
      this.logger.warn('Failed to create metrics_1min:', error);
    }

    // 2. Create 1-hour aggregate (cascading from 1-min)
    try {
      await queryRunner.query(`
        CREATE MATERIALIZED VIEW IF NOT EXISTS metrics_1hour
        WITH (timescaledb.continuous) AS
        SELECT
          time_bucket('1 hour', bucket) AS bucket,
          tenant_id,
          sensor_id,
          channel_id,
          tank_id,

          -- Aggregated stats
          AVG(avg_value) AS avg_value,
          MIN(min_value) AS min_value,
          MAX(max_value) AS max_value,

          -- Pooled standard deviation (corrects for across-bucket variance):
          -- σ = SQRT( Σ n_i*(σ_i² + μ_i²) / Σ n_i  -  μ_total² )
          SQRT(
            GREATEST(
              SUM(sample_count * (POWER(COALESCE(stddev_value, 0), 2) + POWER(COALESCE(avg_value, 0), 2)))
              / NULLIF(SUM(sample_count), 0)
              - POWER(
                  SUM(sample_count * COALESCE(avg_value, 0)) / NULLIF(SUM(sample_count), 0),
                  2
                ),
              0
            )
          ) AS stddev_value,

          -- First/Last
          FIRST(first_value, bucket) AS first_value,
          LAST(last_value, bucket) AS last_value,

          -- Volume
          SUM(sample_count) AS sample_count,
          SUM(good_count) AS good_count,
          SUM(bad_count) AS bad_count,

          -- Quality percentage
          (SUM(good_count)::FLOAT / NULLIF(SUM(sample_count), 0) * 100) AS quality_pct,

          -- Latency
          AVG(avg_latency_ms) AS avg_latency_ms,
          MAX(max_latency_ms) AS max_latency_ms

        FROM metrics_1min
        GROUP BY time_bucket('1 hour', bucket), tenant_id, sensor_id, channel_id, tank_id
        WITH NO DATA
      `);
      this.logger.log('Created metrics_1hour continuous aggregate');

      // Enable real-time query pass-through (MEDIUM-007)
      try {
        await queryRunner.query(`
          ALTER MATERIALIZED VIEW metrics_1hour SET (timescaledb.materialized_only = false)
        `);
      } catch (error) {
        this.logger.warn('Could not set materialized_only=false on metrics_1hour:', error);
      }

      // Refresh policy: every 1 hour
      await queryRunner.query(`
        SELECT add_continuous_aggregate_policy('metrics_1hour',
          start_offset => INTERVAL '3 hours',
          end_offset => INTERVAL '1 hour',
          schedule_interval => INTERVAL '1 hour',
          if_not_exists => TRUE
        )
      `);

      // Retention: 5 years
      await queryRunner.query(`
        SELECT add_retention_policy('metrics_1hour', INTERVAL '5 years', if_not_exists => TRUE)
      `);
      this.logger.log('Added policies for metrics_1hour');

    } catch (error) {
      this.logger.warn('Failed to create metrics_1hour:', error);
    }

    // 3. Create daily aggregate (cascading from 1-hour)
    try {
      await queryRunner.query(`
        CREATE MATERIALIZED VIEW IF NOT EXISTS metrics_1day
        WITH (timescaledb.continuous) AS
        SELECT
          time_bucket('1 day', bucket) AS bucket,
          tenant_id,
          sensor_id,
          channel_id,
          tank_id,

          -- Daily stats
          AVG(avg_value) AS avg_value,
          MIN(min_value) AS min_value,
          MAX(max_value) AS max_value,
          -- Pooled standard deviation (same formula as metrics_1hour)
          SQRT(
            GREATEST(
              SUM(sample_count * (POWER(COALESCE(stddev_value, 0), 2) + POWER(COALESCE(avg_value, 0), 2)))
              / NULLIF(SUM(sample_count), 0)
              - POWER(
                  SUM(sample_count * COALESCE(avg_value, 0)) / NULLIF(SUM(sample_count), 0),
                  2
                ),
              0
            )
          ) AS stddev_value,

          -- Open/Close for trend analysis (like stock charts)
          FIRST(first_value, bucket) AS open_value,
          LAST(last_value, bucket) AS close_value,

          -- Volume
          SUM(sample_count) AS sample_count,
          SUM(good_count) AS good_count,
          SUM(bad_count) AS bad_count,

          -- Quality percentage
          (SUM(good_count)::FLOAT / NULLIF(SUM(sample_count), 0) * 100) AS quality_pct

        FROM metrics_1hour
        GROUP BY time_bucket('1 day', bucket), tenant_id, sensor_id, channel_id, tank_id
        WITH NO DATA
      `);
      this.logger.log('Created metrics_1day continuous aggregate');

      // Enable real-time query pass-through (MEDIUM-007)
      try {
        await queryRunner.query(`
          ALTER MATERIALIZED VIEW metrics_1day SET (timescaledb.materialized_only = false)
        `);
      } catch (error) {
        this.logger.warn('Could not set materialized_only=false on metrics_1day:', error);
      }

      // Refresh policy: every 1 day
      await queryRunner.query(`
        SELECT add_continuous_aggregate_policy('metrics_1day',
          start_offset => INTERVAL '3 days',
          end_offset => INTERVAL '1 day',
          schedule_interval => INTERVAL '1 day',
          if_not_exists => TRUE
        )
      `);

      // No retention for daily - keep forever
      this.logger.log('Added policies for metrics_1day (no retention - kept forever)');

    } catch (error) {
      this.logger.warn('Failed to create metrics_1day:', error);
    }

    // 4. Create indexes for faster lookups on aggregates
    try {
      await queryRunner.query(`
        CREATE INDEX IF NOT EXISTS "IDX_metrics_1min_sensor_bucket"
        ON metrics_1min (sensor_id, bucket DESC)
      `);
      await queryRunner.query(`
        CREATE INDEX IF NOT EXISTS "IDX_metrics_1min_channel_bucket"
        ON metrics_1min (channel_id, bucket DESC)
      `);
      await queryRunner.query(`
        CREATE INDEX IF NOT EXISTS "IDX_metrics_1hour_sensor_bucket"
        ON metrics_1hour (sensor_id, bucket DESC)
      `);
      await queryRunner.query(`
        CREATE INDEX IF NOT EXISTS "IDX_metrics_1day_sensor_bucket"
        ON metrics_1day (sensor_id, bucket DESC)
      `);
      this.logger.log('Created indexes for continuous aggregates');
    } catch (error) {
      this.logger.warn('Failed to create aggregate indexes:', error);
    }

    // 5. Create real-time view for current readings (optional)
    try {
      await queryRunner.query(`
        CREATE OR REPLACE VIEW current_readings AS
        SELECT DISTINCT ON (sensor_id, channel_id)
          sensor_id,
          channel_id,
          tenant_id,
          tank_id,
          time AS last_reading_at,
          value,
          raw_value,
          quality_code,
          source_protocol
        FROM sensor_metrics
        ORDER BY sensor_id, channel_id, time DESC
      `);
      this.logger.log('Created current_readings view');
    } catch (error) {
      this.logger.warn('Failed to create current_readings view:', error);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Remove views in reverse order
    try {
      await queryRunner.query(`DROP VIEW IF EXISTS current_readings`);
    } catch (error) {
      this.logger.warn('Failed to drop current_readings view:', error);
    }

    // Remove continuous aggregate policies and views
    const aggregates = ['metrics_1day', 'metrics_1hour', 'metrics_1min'];

    for (const agg of aggregates) {
      try {
        // Remove policies first
        await queryRunner.query(`
          SELECT remove_continuous_aggregate_policy('${agg}', if_exists => TRUE)
        `);
        await queryRunner.query(`
          SELECT remove_retention_policy('${agg}', if_exists => TRUE)
        `);
        // Drop the materialized view
        await queryRunner.query(`DROP MATERIALIZED VIEW IF EXISTS ${agg} CASCADE`);
        this.logger.log(`Dropped ${agg} and its policies`);
      } catch (error) {
        this.logger.warn(`Failed to drop ${agg}:`, error);
      }
    }

    this.logger.log('Rolled back CreateContinuousAggregates migration');
  }

  private async checkTimescaleDB(queryRunner: QueryRunner): Promise<boolean> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const result: Array<{ exists: boolean }> = await queryRunner.query(`
        SELECT EXISTS (
          SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'
        )
      `);
      return result[0]?.exists === true;
    } catch {
      return false;
    }
  }
}
