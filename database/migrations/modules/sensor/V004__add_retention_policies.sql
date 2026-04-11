-- V004: Add data retention policies for sensor metrics
-- Automatic data lifecycle management via TimescaleDB retention policies.
--
-- Retention strategy:
--   Raw data (sensor_metrics): 90 days — after this, only aggregates are needed.
--   1-minute aggregates:       365 days — year of minute-level detail.
--   1-hour aggregates:         3 years — historical trend analysis.
--   1-day aggregates:          indefinite — never dropped.
--
-- IMPORTANT: Retention policies drop ENTIRE chunks. A chunk is only dropped
-- when ALL rows in it are older than the retention threshold. This means
-- actual retention may extend up to one chunk_time_interval beyond the policy.

-- ============================================================================
-- 1. Raw data retention: 90 days
-- ============================================================================
SELECT add_retention_policy(
  'sensor.sensor_metrics',
  drop_after => INTERVAL '90 days',
  if_not_exists => TRUE
);

-- ============================================================================
-- 2. 1-minute aggregate retention: 365 days
-- ============================================================================
SELECT add_retention_policy(
  'sensor.metrics_1min',
  drop_after => INTERVAL '365 days',
  if_not_exists => TRUE
);

-- ============================================================================
-- 3. 1-hour aggregate retention: 3 years
-- ============================================================================
SELECT add_retention_policy(
  'sensor.metrics_1hour',
  drop_after => INTERVAL '1095 days',
  if_not_exists => TRUE
);

-- Note: metrics_1day has no retention policy — kept indefinitely for
-- long-term trend analysis and regulatory compliance reporting.
