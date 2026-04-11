-- V002: Convert sensor_metrics to TimescaleDB hypertable and create indexes
-- TimescaleDB hypertable conversion MUST happen after table creation and
-- BEFORE index creation on the hypertable.

-- ============================================================================
-- 1. Enable TimescaleDB extension
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ============================================================================
-- 2. Convert to hypertable (7-day chunks)
-- ============================================================================
-- IMPORTANT: chunk_time_interval = 7 days balances query performance and
-- compression efficiency. Smaller chunks = faster pruning for recent queries.
-- Larger chunks = better compression ratio for historical data.
SELECT create_hypertable(
  'sensor.sensor_metrics',
  'time',
  chunk_time_interval => INTERVAL '7 days',
  if_not_exists => TRUE
);

-- ============================================================================
-- 3. Indexes on the hypertable
-- ============================================================================
-- TimescaleDB automatically creates an index on (time) as part of the
-- hypertable. We add composite indexes for the most common query patterns.

CREATE INDEX IF NOT EXISTS "IDX_sensor_metrics_sensor_time"
  ON sensor.sensor_metrics (sensor_id, time DESC);
CREATE INDEX IF NOT EXISTS "IDX_sensor_metrics_channel_time"
  ON sensor.sensor_metrics (channel_id, time DESC);
CREATE INDEX IF NOT EXISTS "IDX_sensor_metrics_tenant_time"
  ON sensor.sensor_metrics (tenant_id, time DESC);
CREATE INDEX IF NOT EXISTS "IDX_sensor_metrics_tank_time"
  ON sensor.sensor_metrics (tank_id, time DESC)
  WHERE tank_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS "IDX_sensor_metrics_equipment_time"
  ON sensor.sensor_metrics (equipment_id, time DESC)
  WHERE equipment_id IS NOT NULL;

-- ============================================================================
-- 4. Enable compression (after 7 days)
-- ============================================================================
ALTER TABLE sensor.sensor_metrics SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'sensor_id, channel_id, tenant_id',
  timescaledb.compress_orderby = 'time DESC'
);

SELECT add_compression_policy(
  'sensor.sensor_metrics',
  compress_after => INTERVAL '7 days',
  if_not_exists => TRUE
);
