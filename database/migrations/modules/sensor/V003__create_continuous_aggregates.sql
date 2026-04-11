-- V003: Create continuous aggregates for sensor metrics
-- TimescaleDB continuous aggregates pre-compute rollups at 1-minute, 1-hour,
-- and 1-day granularity. MetricQueryService selects the optimal aggregate
-- based on the requested time range.

-- ============================================================================
-- 1-minute aggregate (metrics_1min)
-- Used for queries spanning 1-24 hours
-- ============================================================================
CREATE MATERIALIZED VIEW IF NOT EXISTS sensor.metrics_1min
  WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 minute', time) AS bucket,
  sensor_id,
  channel_id,
  tenant_id,
  AVG(value) AS avg_value,
  MIN(value) AS min_value,
  MAX(value) AS max_value,
  STDDEV(value) AS stddev_value,
  first(value, time) AS first_value,
  last(value, time) AS last_value,
  COUNT(*) AS sample_count,
  COUNT(*) FILTER (WHERE quality_code >= 192) AS good_count,
  CASE
    WHEN COUNT(*) > 0
    THEN (COUNT(*) FILTER (WHERE quality_code >= 192))::FLOAT / COUNT(*) * 100
    ELSE 0
  END AS quality_pct
FROM sensor.sensor_metrics
GROUP BY bucket, sensor_id, channel_id, tenant_id
WITH NO DATA;

-- Refresh policy: keep last 24 hours materialized, refresh every 1 minute
SELECT add_continuous_aggregate_policy('sensor.metrics_1min',
  start_offset    => INTERVAL '2 hours',
  end_offset      => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute',
  if_not_exists   => TRUE
);

-- ============================================================================
-- 1-hour aggregate (metrics_1hour)
-- Used for queries spanning 1-30 days
-- ============================================================================
CREATE MATERIALIZED VIEW IF NOT EXISTS sensor.metrics_1hour
  WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 hour', time) AS bucket,
  sensor_id,
  channel_id,
  tenant_id,
  AVG(value) AS avg_value,
  MIN(value) AS min_value,
  MAX(value) AS max_value,
  STDDEV(value) AS stddev_value,
  first(value, time) AS first_value,
  last(value, time) AS last_value,
  COUNT(*) AS sample_count,
  COUNT(*) FILTER (WHERE quality_code >= 192) AS good_count,
  CASE
    WHEN COUNT(*) > 0
    THEN (COUNT(*) FILTER (WHERE quality_code >= 192))::FLOAT / COUNT(*) * 100
    ELSE 0
  END AS quality_pct
FROM sensor.sensor_metrics
GROUP BY bucket, sensor_id, channel_id, tenant_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy('sensor.metrics_1hour',
  start_offset    => INTERVAL '2 days',
  end_offset      => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists   => TRUE
);

-- ============================================================================
-- 1-day aggregate (metrics_1day)
-- Used for queries spanning 30+ days
-- ============================================================================
CREATE MATERIALIZED VIEW IF NOT EXISTS sensor.metrics_1day
  WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 day', time) AS bucket,
  sensor_id,
  channel_id,
  tenant_id,
  AVG(value) AS avg_value,
  MIN(value) AS min_value,
  MAX(value) AS max_value,
  STDDEV(value) AS stddev_value,
  first(value, time) AS first_value,
  last(value, time) AS last_value,
  COUNT(*) AS sample_count,
  COUNT(*) FILTER (WHERE quality_code >= 192) AS good_count,
  CASE
    WHEN COUNT(*) > 0
    THEN (COUNT(*) FILTER (WHERE quality_code >= 192))::FLOAT / COUNT(*) * 100
    ELSE 0
  END AS quality_pct
FROM sensor.sensor_metrics
GROUP BY bucket, sensor_id, channel_id, tenant_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy('sensor.metrics_1day',
  start_offset    => INTERVAL '7 days',
  end_offset      => INTERVAL '1 day',
  schedule_interval => INTERVAL '1 day',
  if_not_exists   => TRUE
);
