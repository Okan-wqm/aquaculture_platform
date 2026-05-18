-- Migration: 003_create_audit_logs_table
-- Description: Audit logs table for tracking entity changes
-- Date: 2024-11-29

-- =====================================================
-- AUDIT LOGS TABLE
-- =====================================================

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL,
  entity_type VARCHAR(100) NOT NULL,
  entity_id UUID NOT NULL,
  action VARCHAR(50) NOT NULL,
  user_id UUID,
  user_name VARCHAR(255),
  changes JSONB,
  metadata JSONB,
  entity_version INT,
  summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_entity
  ON audit_logs (tenant_id, entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_created
  ON audit_logs (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at
  ON audit_logs (created_at);

CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_action
  ON audit_logs (tenant_id, action);

CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_user
  ON audit_logs (tenant_id, user_id);

-- =====================================================
-- RETENTION POLICY
-- =====================================================

-- Function to cleanup old audit logs (90 days retention)
CREATE OR REPLACE FUNCTION cleanup_old_audit_logs(p_retention_days int DEFAULT 90)
RETURNS int AS $$
DECLARE
  v_deleted_count int;
BEGIN
  DELETE FROM audit_logs
  WHERE created_at < NOW() - (p_retention_days || ' days')::interval;

  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

  RAISE NOTICE 'Deleted % audit log records older than % days', v_deleted_count, p_retention_days;

  RETURN v_deleted_count;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- COMMENTS
-- =====================================================

COMMENT ON TABLE audit_logs IS 'Stores audit trail for all entity changes in farm module';
COMMENT ON COLUMN audit_logs.entity_type IS 'Name of the entity table (e.g., sites, tanks, batches)';
COMMENT ON COLUMN audit_logs.action IS 'Type of action: CREATE, UPDATE, DELETE, SOFT_DELETE, RESTORE';
COMMENT ON COLUMN audit_logs.changes IS 'JSONB with before, after, and changedFields';
COMMENT ON COLUMN audit_logs.metadata IS 'Additional context like IP, user agent, correlation ID';
