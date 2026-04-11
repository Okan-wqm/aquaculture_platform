-- V002: Add escalation policies table
-- Entity: apps/alert-engine/src/database/entities/escalation-policy.entity.ts

CREATE TABLE IF NOT EXISTS alert.escalation_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  severity JSONB NOT NULL,
  levels JSONB NOT NULL,
  on_call_schedule JSONB,
  suppression_windows JSONB,
  repeat_interval_minutes INT NOT NULL DEFAULT 5,
  max_repeats INT NOT NULL DEFAULT 3,
  is_active BOOLEAN NOT NULL DEFAULT true,
  is_default BOOLEAN NOT NULL DEFAULT false,
  priority INT NOT NULL DEFAULT 0,
  conditions JSONB,
  timezone VARCHAR(100),
  rule_ids JSONB,
  farm_ids JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by VARCHAR(255)
);

-- ── Indexes ──
CREATE INDEX IF NOT EXISTS "IDX_escalation_policies_tenant_active"
  ON alert.escalation_policies (tenant_id, is_active);
CREATE INDEX IF NOT EXISTS "IDX_escalation_policies_tenant"
  ON alert.escalation_policies (tenant_id);
CREATE INDEX IF NOT EXISTS "IDX_escalation_policies_severity"
  ON alert.escalation_policies USING gin (severity);

-- Alert history table
-- Entity: apps/alert-engine/src/alert/entities/alert-history.entity.ts
CREATE TABLE IF NOT EXISTS alert.alert_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  incident_id UUID REFERENCES alert.alert_incidents(id) ON DELETE CASCADE,
  event_type VARCHAR(50) NOT NULL,
  actor_id UUID,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "IDX_alert_history_incident"
  ON alert.alert_history (incident_id);
CREATE INDEX IF NOT EXISTS "IDX_alert_history_tenant_created"
  ON alert.alert_history (tenant_id, created_at);
