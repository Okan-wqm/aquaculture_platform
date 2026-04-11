-- V005: Create audit_logs table
-- Immutable audit trail for all user actions across the platform.
-- Entity: libs/backend-common/src/audit/audit-log.entity.ts

-- SECURITY: severity uses a CHECK constraint (not an enum type) to avoid
-- requiring ALTER TYPE when adding new severity levels.
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action VARCHAR(100) NOT NULL,
  resource VARCHAR(100) NOT NULL,
  resource_id VARCHAR(255),
  user_id VARCHAR(255),
  user_email VARCHAR(255),
  tenant_id UUID,
  schema_name VARCHAR(100),
  metadata JSONB,
  ip VARCHAR(45),
  user_agent VARCHAR(500),
  severity VARCHAR(20) NOT NULL DEFAULT 'info'
    CHECK (severity IN ('info', 'warning', 'error', 'critical')),
  correlation_id VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Indexes ──
CREATE INDEX IF NOT EXISTS "IDX_audit_log_tenant_created"
  ON public.audit_logs (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS "IDX_audit_log_user_tenant"
  ON public.audit_logs (user_id, tenant_id);
CREATE INDEX IF NOT EXISTS "IDX_audit_log_resource"
  ON public.audit_logs (resource, resource_id, tenant_id);
CREATE INDEX IF NOT EXISTS "IDX_audit_log_action"
  ON public.audit_logs (action, tenant_id);
