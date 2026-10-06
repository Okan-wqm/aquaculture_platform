import { metricTier } from '@aquaculture/shared-contracts/sensor-readings/tier-policy';

/**
 * Canonical per-tenant sensor continuous-aggregate definition.
 *
 * TimescaleDB continuous aggregates cannot be created inside the transaction
 * used by the migration runner. Both the authoritative db-migrate autocommit
 * path and the non-authoritative local-development bootstrap therefore consume
 * this definition. Keeping the SQL here prevents those two delivery paths from
 * drifting while production runtime services remain DDL-free.
 */

// Windows, offsets and retention come from the sensor-reading tier policy —
// the same table the series queries choose their store from — so a change to
// how long a tier keeps data reaches the DDL and the reads together.
const RAW_TIER = metricTier('raw');
const MINUTE_TIER = metricTier('minute');
const HOUR_TIER = metricTier('hour');
const DAY_TIER = metricTier('day');

export const SENSOR_CONTINUOUS_AGGREGATE_NAMES = [
  MINUTE_TIER.table,
  HOUR_TIER.table,
  DAY_TIER.table,
] as const;

export type SensorContinuousAggregateName = (typeof SENSOR_CONTINUOUS_AGGREGATE_NAMES)[number];

/**
 * Dedicated passwordless LOGIN owner required by TimescaleDB background jobs.
 * Ordinary schema ownership remains on the NOLOGIN sensor_schema_owner role.
 */
export const SENSOR_CONTINUOUS_AGGREGATE_OWNER_ROLE = 'sensor_aggregate_owner';
export const SENSOR_CONTINUOUS_AGGREGATE_RUNTIME_ROLE = 'sensor_service';
export const SENSOR_CONTINUOUS_AGGREGATE_LOCK_PREFIX = 'sensor-continuous-aggregate-bootstrap:';

export interface SensorContinuousAggregateStatement {
  readonly label: string;
  readonly phase: 'definition' | 'maintenance';
  readonly sql: string;
}

/**
 * Ordered lowest-to-highest rollup DDL; every operation is idempotent.
 *
 * Refresh `start_offset`s are one full retention step behind the schedule
 * (24h / 7d / 30d) rather than a few buckets: edge gateways buffer offline
 * and replay telemetry hours to days late, and a narrower window would leave
 * those late rows unrolled forever (100-tenant readiness plan, Task 4).
 */
export const SENSOR_CONTINUOUS_AGGREGATE_STATEMENTS: readonly SensorContinuousAggregateStatement[] =
  [
    {
      label: 'create metrics_1min',
      phase: 'definition',
      sql: `
        CREATE MATERIALIZED VIEW IF NOT EXISTS ${MINUTE_TIER.table}
        WITH (timescaledb.continuous) AS
        SELECT
          time_bucket('${MINUTE_TIER.bucket.sql}', time) AS bucket,
          tenant_id, sensor_id, channel_id, tank_id,
          AVG(value) AS avg_value,
          MIN(value) AS min_value,
          MAX(value) AS max_value,
          STDDEV(value) AS stddev_value,
          FIRST(value, time) AS first_value,
          LAST(value, time) AS last_value,
          COUNT(*) AS sample_count,
          COUNT(*) FILTER (WHERE quality_code >= 192) AS good_count,
          COUNT(*) FILTER (WHERE quality_code < 192) AS bad_count
        FROM ${RAW_TIER.table}
        GROUP BY bucket, tenant_id, sensor_id, channel_id, tank_id
        WITH NO DATA`,
    },
    {
      label: 'metrics_1min real-time',
      phase: 'definition',
      sql: `ALTER MATERIALIZED VIEW ${MINUTE_TIER.table} SET (timescaledb.materialized_only = false)`,
    },
    {
      label: 'metrics_1min remove stale refresh policy',
      phase: 'maintenance',
      sql: `SELECT remove_continuous_aggregate_policy('${MINUTE_TIER.table}', if_exists => TRUE)`,
    },
    {
      label: 'metrics_1min refresh policy',
      phase: 'maintenance',
      sql: `SELECT add_continuous_aggregate_policy('${MINUTE_TIER.table}',
        start_offset => INTERVAL '${MINUTE_TIER.refresh.startOffset.sql}',
        end_offset => INTERVAL '${MINUTE_TIER.refresh.endOffset.sql}',
        schedule_interval => INTERVAL '${MINUTE_TIER.refresh.schedule.sql}',
        if_not_exists => TRUE)`,
    },
    {
      label: 'metrics_1min retention',
      phase: 'maintenance',
      sql: `SELECT add_retention_policy('${MINUTE_TIER.table}', INTERVAL '${MINUTE_TIER.retention.sql}', if_not_exists => TRUE)`,
    },
    {
      label: 'create metrics_1hour',
      phase: 'definition',
      sql: `
        CREATE MATERIALIZED VIEW IF NOT EXISTS ${HOUR_TIER.table}
        WITH (timescaledb.continuous) AS
        SELECT
          time_bucket('${HOUR_TIER.bucket.sql}', bucket) AS bucket,
          tenant_id, sensor_id, channel_id, tank_id,
          AVG(avg_value) AS avg_value,
          MIN(min_value) AS min_value,
          MAX(max_value) AS max_value,
          SQRT(GREATEST(
            SUM(sample_count * (POWER(COALESCE(stddev_value, 0), 2) + POWER(COALESCE(avg_value, 0), 2)))
              / NULLIF(SUM(sample_count), 0)
            - POWER(SUM(sample_count * COALESCE(avg_value, 0)) / NULLIF(SUM(sample_count), 0), 2),
            0
          )) AS stddev_value,
          FIRST(first_value, bucket) AS first_value,
          LAST(last_value, bucket) AS last_value,
          SUM(sample_count) AS sample_count,
          SUM(good_count) AS good_count,
          SUM(bad_count) AS bad_count,
          (SUM(good_count)::FLOAT / NULLIF(SUM(sample_count), 0) * 100) AS quality_pct
        FROM ${MINUTE_TIER.table}
        GROUP BY time_bucket('${HOUR_TIER.bucket.sql}', bucket), tenant_id, sensor_id, channel_id, tank_id
        WITH NO DATA`,
    },
    {
      label: 'metrics_1hour real-time',
      phase: 'definition',
      sql: `ALTER MATERIALIZED VIEW ${HOUR_TIER.table} SET (timescaledb.materialized_only = false)`,
    },
    {
      label: 'metrics_1hour remove stale refresh policy',
      phase: 'maintenance',
      sql: `SELECT remove_continuous_aggregate_policy('${HOUR_TIER.table}', if_exists => TRUE)`,
    },
    {
      label: 'metrics_1hour refresh policy',
      phase: 'maintenance',
      sql: `SELECT add_continuous_aggregate_policy('${HOUR_TIER.table}',
        start_offset => INTERVAL '${HOUR_TIER.refresh.startOffset.sql}',
        end_offset => INTERVAL '${HOUR_TIER.refresh.endOffset.sql}',
        schedule_interval => INTERVAL '${HOUR_TIER.refresh.schedule.sql}',
        if_not_exists => TRUE)`,
    },
    {
      label: 'metrics_1hour retention',
      phase: 'maintenance',
      sql: `SELECT add_retention_policy('${HOUR_TIER.table}', INTERVAL '${HOUR_TIER.retention.sql}', if_not_exists => TRUE)`,
    },
    {
      label: 'create metrics_1day',
      phase: 'definition',
      sql: `
        CREATE MATERIALIZED VIEW IF NOT EXISTS ${DAY_TIER.table}
        WITH (timescaledb.continuous) AS
        SELECT
          time_bucket('${DAY_TIER.bucket.sql}', bucket) AS bucket,
          tenant_id, sensor_id, channel_id, tank_id,
          AVG(avg_value) AS avg_value,
          MIN(min_value) AS min_value,
          MAX(max_value) AS max_value,
          SQRT(GREATEST(
            SUM(sample_count * (POWER(COALESCE(stddev_value, 0), 2) + POWER(COALESCE(avg_value, 0), 2)))
              / NULLIF(SUM(sample_count), 0)
            - POWER(SUM(sample_count * COALESCE(avg_value, 0)) / NULLIF(SUM(sample_count), 0), 2),
            0
          )) AS stddev_value,
          FIRST(first_value, bucket) AS first_value,
          LAST(last_value, bucket) AS last_value,
          SUM(sample_count) AS sample_count,
          SUM(good_count) AS good_count,
          SUM(bad_count) AS bad_count,
          (SUM(good_count)::FLOAT / NULLIF(SUM(sample_count), 0) * 100) AS quality_pct
        FROM ${HOUR_TIER.table}
        GROUP BY time_bucket('${DAY_TIER.bucket.sql}', bucket), tenant_id, sensor_id, channel_id, tank_id
        WITH NO DATA`,
    },
    {
      label: 'metrics_1day real-time',
      phase: 'definition',
      sql: `ALTER MATERIALIZED VIEW ${DAY_TIER.table} SET (timescaledb.materialized_only = false)`,
    },
    {
      label: 'metrics_1day remove stale refresh policy',
      phase: 'maintenance',
      sql: `SELECT remove_continuous_aggregate_policy('${DAY_TIER.table}', if_exists => TRUE)`,
    },
    {
      label: 'metrics_1day refresh policy',
      phase: 'maintenance',
      sql: `SELECT add_continuous_aggregate_policy('${DAY_TIER.table}',
        start_offset => INTERVAL '${DAY_TIER.refresh.startOffset.sql}',
        end_offset => INTERVAL '${DAY_TIER.refresh.endOffset.sql}',
        schedule_interval => INTERVAL '${DAY_TIER.refresh.schedule.sql}',
        if_not_exists => TRUE)`,
    },
    {
      label: 'metrics_1min sensor index',
      phase: 'maintenance',
      sql: `CREATE INDEX IF NOT EXISTS "IDX_metrics_1min_sensor_bucket" ON ${MINUTE_TIER.table} (sensor_id, bucket DESC)`,
    },
    {
      label: 'metrics_1min channel index',
      phase: 'maintenance',
      sql: `CREATE INDEX IF NOT EXISTS "IDX_metrics_1min_channel_bucket" ON ${MINUTE_TIER.table} (channel_id, bucket DESC)`,
    },
    {
      label: 'metrics_1hour sensor index',
      phase: 'maintenance',
      sql: `CREATE INDEX IF NOT EXISTS "IDX_metrics_1hour_sensor_bucket" ON ${HOUR_TIER.table} (sensor_id, bucket DESC)`,
    },
    {
      label: 'metrics_1day sensor index',
      phase: 'maintenance',
      sql: `CREATE INDEX IF NOT EXISTS "IDX_metrics_1day_sensor_bucket" ON ${DAY_TIER.table} (sensor_id, bucket DESC)`,
    },
  ];
