/**
 * Canonical per-tenant sensor continuous-aggregate definition.
 *
 * TimescaleDB continuous aggregates cannot be created inside the transaction
 * used by the migration runner. Both the authoritative db-migrate autocommit
 * path and the non-authoritative local-development bootstrap therefore consume
 * this definition. Keeping the SQL here prevents those two delivery paths from
 * drifting while production runtime services remain DDL-free.
 */

export const SENSOR_CONTINUOUS_AGGREGATE_NAMES = [
  'metrics_1min',
  'metrics_1hour',
  'metrics_1day',
] as const;

export type SensorContinuousAggregateName = (typeof SENSOR_CONTINUOUS_AGGREGATE_NAMES)[number];

export const SENSOR_CONTINUOUS_AGGREGATE_OWNER_ROLE = 'sensor_schema_owner';
export const SENSOR_CONTINUOUS_AGGREGATE_RUNTIME_ROLE = 'sensor_service';
export const SENSOR_CONTINUOUS_AGGREGATE_LOCK_PREFIX = 'sensor-continuous-aggregate-bootstrap:';

export interface SensorContinuousAggregateStatement {
  readonly label: string;
  readonly phase: 'definition' | 'maintenance';
  readonly sql: string;
}

/** Ordered lowest-to-highest rollup DDL; every operation is idempotent. */
export const SENSOR_CONTINUOUS_AGGREGATE_STATEMENTS: readonly SensorContinuousAggregateStatement[] =
  [
    {
      label: 'create metrics_1min',
      phase: 'definition',
      sql: `
        CREATE MATERIALIZED VIEW IF NOT EXISTS metrics_1min
        WITH (timescaledb.continuous) AS
        SELECT
          time_bucket('1 minute', time) AS bucket,
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
        FROM sensor_metrics
        GROUP BY bucket, tenant_id, sensor_id, channel_id, tank_id
        WITH NO DATA`,
    },
    {
      label: 'metrics_1min real-time',
      phase: 'definition',
      sql: `ALTER MATERIALIZED VIEW metrics_1min SET (timescaledb.materialized_only = false)`,
    },
    {
      label: 'metrics_1min refresh policy',
      phase: 'maintenance',
      sql: `SELECT add_continuous_aggregate_policy('metrics_1min',
        start_offset => INTERVAL '3 minutes',
        end_offset => INTERVAL '1 minute',
        schedule_interval => INTERVAL '1 minute',
        if_not_exists => TRUE)`,
    },
    {
      label: 'metrics_1min retention',
      phase: 'maintenance',
      sql: `SELECT add_retention_policy('metrics_1min', INTERVAL '1 year', if_not_exists => TRUE)`,
    },
    {
      label: 'create metrics_1hour',
      phase: 'definition',
      sql: `
        CREATE MATERIALIZED VIEW IF NOT EXISTS metrics_1hour
        WITH (timescaledb.continuous) AS
        SELECT
          time_bucket('1 hour', bucket) AS bucket,
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
        FROM metrics_1min
        GROUP BY time_bucket('1 hour', bucket), tenant_id, sensor_id, channel_id, tank_id
        WITH NO DATA`,
    },
    {
      label: 'metrics_1hour real-time',
      phase: 'definition',
      sql: `ALTER MATERIALIZED VIEW metrics_1hour SET (timescaledb.materialized_only = false)`,
    },
    {
      label: 'metrics_1hour refresh policy',
      phase: 'maintenance',
      sql: `SELECT add_continuous_aggregate_policy('metrics_1hour',
        start_offset => INTERVAL '3 hours',
        end_offset => INTERVAL '1 hour',
        schedule_interval => INTERVAL '1 hour',
        if_not_exists => TRUE)`,
    },
    {
      label: 'metrics_1hour retention',
      phase: 'maintenance',
      sql: `SELECT add_retention_policy('metrics_1hour', INTERVAL '5 years', if_not_exists => TRUE)`,
    },
    {
      label: 'create metrics_1day',
      phase: 'definition',
      sql: `
        CREATE MATERIALIZED VIEW IF NOT EXISTS metrics_1day
        WITH (timescaledb.continuous) AS
        SELECT
          time_bucket('1 day', bucket) AS bucket,
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
        FROM metrics_1hour
        GROUP BY time_bucket('1 day', bucket), tenant_id, sensor_id, channel_id, tank_id
        WITH NO DATA`,
    },
    {
      label: 'metrics_1day real-time',
      phase: 'definition',
      sql: `ALTER MATERIALIZED VIEW metrics_1day SET (timescaledb.materialized_only = false)`,
    },
    {
      label: 'metrics_1day refresh policy',
      phase: 'maintenance',
      sql: `SELECT add_continuous_aggregate_policy('metrics_1day',
        start_offset => INTERVAL '3 days',
        end_offset => INTERVAL '1 day',
        schedule_interval => INTERVAL '1 day',
        if_not_exists => TRUE)`,
    },
    {
      label: 'metrics_1min sensor index',
      phase: 'maintenance',
      sql: `CREATE INDEX IF NOT EXISTS "IDX_metrics_1min_sensor_bucket" ON metrics_1min (sensor_id, bucket DESC)`,
    },
    {
      label: 'metrics_1min channel index',
      phase: 'maintenance',
      sql: `CREATE INDEX IF NOT EXISTS "IDX_metrics_1min_channel_bucket" ON metrics_1min (channel_id, bucket DESC)`,
    },
    {
      label: 'metrics_1hour sensor index',
      phase: 'maintenance',
      sql: `CREATE INDEX IF NOT EXISTS "IDX_metrics_1hour_sensor_bucket" ON metrics_1hour (sensor_id, bucket DESC)`,
    },
    {
      label: 'metrics_1day sensor index',
      phase: 'maintenance',
      sql: `CREATE INDEX IF NOT EXISTS "IDX_metrics_1day_sensor_bucket" ON metrics_1day (sensor_id, bucket DESC)`,
    },
  ];
