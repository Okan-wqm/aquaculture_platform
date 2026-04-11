-- V001: Alert module initial schema
-- Creates the alert schema and the alert_rules table.
-- Entity: apps/alert-engine/src/database/entities/alert-rule.entity.ts

CREATE SCHEMA IF NOT EXISTS alert;

CREATE TABLE IF NOT EXISTS alert.alert_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  tenant_id UUID NOT NULL,
  farm_id UUID,
  pond_id UUID,
  sensor_id UUID,
  conditions JSONB NOT NULL,
  severity VARCHAR(20) DEFAULT 'medium',
  is_active BOOLEAN NOT NULL DEFAULT true,
  notification_channels JSONB,
  recipients JSONB,
  cooldown_minutes INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by VARCHAR(255),

  CONSTRAINT "UQ_alert_rules_name_tenant" UNIQUE (name, tenant_id)
);

-- ── Indexes ──
CREATE INDEX IF NOT EXISTS "IDX_alert_rules_tenant_active"
  ON alert.alert_rules (tenant_id, is_active);
CREATE INDEX IF NOT EXISTS "IDX_alert_rules_tenant"
  ON alert.alert_rules (tenant_id);
CREATE INDEX IF NOT EXISTS "IDX_alert_rules_farm"
  ON alert.alert_rules (farm_id);
CREATE INDEX IF NOT EXISTS "IDX_alert_rules_pond"
  ON alert.alert_rules (pond_id);
CREATE INDEX IF NOT EXISTS "IDX_alert_rules_sensor"
  ON alert.alert_rules (sensor_id);

-- Alert incidents table
-- Entity: apps/alert-engine/src/database/entities/alert-incident.entity.ts
CREATE TABLE IF NOT EXISTS alert.alert_incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  rule_id UUID REFERENCES alert.alert_rules(id) ON DELETE SET NULL,
  title VARCHAR(500) NOT NULL,
  description TEXT,
  severity VARCHAR(20) NOT NULL DEFAULT 'medium',
  status VARCHAR(20) NOT NULL DEFAULT 'NEW',
  triggered_value DOUBLE PRECISION,
  threshold_value DOUBLE PRECISION,
  parameter VARCHAR(100),
  farm_id UUID,
  pond_id UUID,
  sensor_id UUID,
  assigned_to UUID,
  acknowledged_by UUID,
  acknowledged_at TIMESTAMPTZ,
  resolved_by UUID,
  resolved_at TIMESTAMPTZ,
  resolution_notes TEXT,
  escalation_level INT NOT NULL DEFAULT 0,
  notification_count INT NOT NULL DEFAULT 0,
  last_notified_at TIMESTAMPTZ,
  fingerprint VARCHAR(255),
  timeline JSONB DEFAULT '[]'::jsonb,
  metadata JSONB,
  is_suppressed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "IDX_alert_incidents_tenant_status"
  ON alert.alert_incidents (tenant_id, status);
CREATE INDEX IF NOT EXISTS "IDX_alert_incidents_fingerprint"
  ON alert.alert_incidents (fingerprint);
CREATE INDEX IF NOT EXISTS "IDX_alert_incidents_rule"
  ON alert.alert_incidents (rule_id);
