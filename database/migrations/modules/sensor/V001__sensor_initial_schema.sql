-- V001: Sensor module initial schema
-- Creates the sensor schema and foundational sensor tables.
-- Entity sources:
--   apps/sensor-service/src/database/entities/sensor.entity.ts
--   apps/sensor-service/src/database/entities/sensor-data-channel.entity.ts
--   apps/sensor-service/src/database/entities/sensor-metric.entity.ts

CREATE SCHEMA IF NOT EXISTS sensor;

-- ============================================================================
-- Sensors - IoT sensor device registry
-- ============================================================================
CREATE TABLE IF NOT EXISTS sensor.sensors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  serial_number VARCHAR(255) NOT NULL,
  type VARCHAR(50) NOT NULL,
  manufacturer VARCHAR(255),
  model VARCHAR(255),
  firmware_version VARCHAR(255),
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  tenant_id UUID NOT NULL,
  pond_id UUID,
  farm_id UUID,
  tank_id UUID,
  site_id UUID,
  department_id UUID,
  system_id UUID,
  equipment_id UUID,
  description TEXT,
  location VARCHAR(255),
  metadata JSONB,
  configuration JSONB,
  calibration_data JSONB,
  protocol_id UUID,
  protocol_configuration JSONB,
  connection_status JSONB,
  type_definition_id UUID,
  registration_status VARCHAR(20) NOT NULL DEFAULT 'draft',
  last_seen_at TIMESTAMPTZ,
  last_calibrated_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by VARCHAR(255),
  parent_id UUID REFERENCES sensor.sensors(id) ON DELETE CASCADE,
  is_parent_device BOOLEAN NOT NULL DEFAULT false,
  data_path VARCHAR(255),
  sensor_role VARCHAR(20),
  unit VARCHAR(50),
  min_value FLOAT,
  max_value FLOAT,
  calibration_enabled BOOLEAN DEFAULT false,
  calibration_multiplier DECIMAL(10, 6),
  calibration_offset DECIMAL(10, 6),
  alert_thresholds JSONB,
  display_settings JSONB,

  CONSTRAINT "UQ_sensors_serial_number" UNIQUE (serial_number)
);

CREATE INDEX IF NOT EXISTS "IDX_sensors_tenant_status"
  ON sensor.sensors (tenant_id, status);
CREATE INDEX IF NOT EXISTS "IDX_sensors_tenant"
  ON sensor.sensors (tenant_id);
CREATE INDEX IF NOT EXISTS "IDX_sensors_tenant_site"
  ON sensor.sensors (tenant_id, site_id);
CREATE INDEX IF NOT EXISTS "IDX_sensors_tenant_department"
  ON sensor.sensors (tenant_id, department_id);
CREATE INDEX IF NOT EXISTS "IDX_sensors_tenant_system"
  ON sensor.sensors (tenant_id, system_id);
CREATE INDEX IF NOT EXISTS "IDX_sensors_tenant_equipment"
  ON sensor.sensors (tenant_id, equipment_id);
CREATE INDEX IF NOT EXISTS "IDX_sensors_parent"
  ON sensor.sensors (parent_id);

-- ============================================================================
-- Sensor data channels - Individual measurement channels per sensor
-- ============================================================================
CREATE TABLE IF NOT EXISTS sensor.sensor_data_channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sensor_id UUID NOT NULL REFERENCES sensor.sensors(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL,
  channel_key VARCHAR(100) NOT NULL,
  display_label VARCHAR(200) NOT NULL,
  description TEXT,
  data_type VARCHAR(20) NOT NULL DEFAULT 'number',
  unit VARCHAR(50),
  unit_symbol VARCHAR(10),
  physical_min DOUBLE PRECISION,
  physical_max DOUBLE PRECISION,
  operational_min DOUBLE PRECISION,
  operational_max DOUBLE PRECISION,
  data_path VARCHAR(255),
  min_value DECIMAL(15, 6),
  max_value DECIMAL(15, 6),
  calibration_enabled BOOLEAN NOT NULL DEFAULT false,
  calibration_multiplier DECIMAL(15, 6) NOT NULL DEFAULT 1.0,
  calibration_offset DECIMAL(15, 6) NOT NULL DEFAULT 0.0,
  last_calibrated_at TIMESTAMPTZ,
  next_calibration_due TIMESTAMPTZ,
  calibration_polynomial JSONB,
  protocol_config JSONB,
  alert_thresholds JSONB,
  display_settings JSONB,
  discovered_at TIMESTAMPTZ,
  discovery_source VARCHAR(20),
  sample_value JSONB,
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  display_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT "UQ_sensor_data_channels_tenant_sensor_key"
    UNIQUE (tenant_id, sensor_id, channel_key)
);

CREATE INDEX IF NOT EXISTS "IDX_sensor_data_channels_sensor_enabled"
  ON sensor.sensor_data_channels (sensor_id, is_enabled);
CREATE INDEX IF NOT EXISTS "IDX_sensor_data_channels_tenant_key"
  ON sensor.sensor_data_channels (tenant_id, channel_key);
CREATE INDEX IF NOT EXISTS "IDX_sensor_data_channels_sensor"
  ON sensor.sensor_data_channels (sensor_id);

-- ============================================================================
-- Sensor metrics - Time-series hypertable (TimescaleDB)
-- ============================================================================
CREATE TABLE IF NOT EXISTS sensor.sensor_metrics (
  time TIMESTAMPTZ NOT NULL,
  sensor_id UUID NOT NULL,
  channel_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  site_id UUID,
  department_id UUID,
  system_id UUID,
  equipment_id UUID,
  tank_id UUID,
  pond_id UUID,
  farm_id UUID,
  raw_value DOUBLE PRECISION NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  quality_code SMALLINT NOT NULL DEFAULT 192,
  quality_bits SMALLINT NOT NULL DEFAULT 0,
  source_protocol VARCHAR(20),
  source_timestamp TIMESTAMPTZ,
  ingestion_latency_ms INT,
  batch_id UUID,

  PRIMARY KEY (time, sensor_id, channel_id)
);

-- IMPORTANT: sensor_metrics indexes are created AFTER hypertable conversion
-- in V002__create_hypertables.sql. TimescaleDB requires this ordering.
