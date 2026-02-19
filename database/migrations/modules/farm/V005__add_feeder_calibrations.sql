-- V005: Add feeder_calibrations table
-- Stores feed-size-specific calibration data for feeders
-- Each row = one feed size calibration for one equipment

CREATE TABLE IF NOT EXISTS feeder_calibrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  equipment_id UUID NOT NULL,
  feed_size_mm DECIMAL(5,2) NOT NULL,
  feed_size_label VARCHAR(100),
  grams_per_dispensing DECIMAL(8,2) NOT NULL,
  silo_capacity_kg DECIMAL(8,2) NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_feeder_cal UNIQUE (tenant_id, equipment_id, feed_size_mm)
);

CREATE INDEX idx_feeder_cal_tenant ON feeder_calibrations (tenant_id);
CREATE INDEX idx_feeder_cal_equipment ON feeder_calibrations (tenant_id, equipment_id);
