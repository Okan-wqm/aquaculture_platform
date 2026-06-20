-- ============================================================================
-- Platform Bootstrap — Stage 9: Tenant Schema Provisioner Ledger
--
-- Runtime services do not create tenant schemas. They enqueue intent here; the
-- aqua-db-migrate provisioner is the sole DDL worker that claims jobs, creates
-- tenant_<uuid16>, applies tenant-aware migrations, hardens the schema, and
-- commits admin.tenant_schemas evidence.
-- ============================================================================

CREATE TABLE IF NOT EXISTS platform.tenant_schema_jobs (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id       UUID NOT NULL,
  tenant_id          UUID NOT NULL,
  schema_name        VARCHAR(100) NOT NULL,
  job_type           VARCHAR(40) NOT NULL DEFAULT 'PROVISION',
  status             VARCHAR(40) NOT NULL DEFAULT 'REQUESTED',
  requested_by       VARCHAR(120) NOT NULL DEFAULT current_user,
  request_payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_heads       JSONB NOT NULL DEFAULT '{}'::jsonb,
  tenant_heads       JSONB NOT NULL DEFAULT '{}'::jsonb,
  table_count        INTEGER NOT NULL DEFAULT 0,
  failure_residue    JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_message      TEXT,
  attempts           INTEGER NOT NULL DEFAULT 0,
  lease_token        UUID,
  leased_by          VARCHAR(120),
  heartbeat_at       TIMESTAMPTZ,
  lease_expires_at   TIMESTAMPTZ,
  started_at         TIMESTAMPTZ,
  completed_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tenant_schema_jobs_type_chk CHECK (job_type IN ('PROVISION', 'DELETE', 'RECONCILE_EXISTING_SCHEMA')),
  CONSTRAINT tenant_schema_jobs_status_chk CHECK (
    status IN (
      'REQUESTED',
      'CLAIMED',
      'CREATING_SCHEMA',
      'COPYING_TABLES',
      'APPLYING_GRANTS',
      'HARDENING_RLS',
      'SEEDING_LEDGER',
      'RECONCILING_SCHEMA',
      'DELETING_SCHEMA',
      'COMMITTED',
      'FAILED',
      'ABORTED',
      'DELETED'
    )
  ),
  CONSTRAINT tenant_schema_jobs_schema_name_chk CHECK (schema_name ~ '^tenant_[a-f0-9]{16}$')
);

ALTER TABLE platform.tenant_schema_jobs
  ADD COLUMN IF NOT EXISTS request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS source_heads JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS tenant_heads JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS table_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS failure_residue JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS error_message TEXT,
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lease_token UUID,
  ADD COLUMN IF NOT EXISTS leased_by VARCHAR(120),
  ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

ALTER TABLE platform.tenant_schema_jobs
  DROP CONSTRAINT IF EXISTS tenant_schema_jobs_type_chk,
  ADD CONSTRAINT tenant_schema_jobs_type_chk
    CHECK (job_type IN ('PROVISION', 'DELETE', 'RECONCILE_EXISTING_SCHEMA'));

ALTER TABLE platform.tenant_schema_jobs
  DROP CONSTRAINT IF EXISTS tenant_schema_jobs_status_chk,
  ADD CONSTRAINT tenant_schema_jobs_status_chk CHECK (
    status IN (
      'REQUESTED',
      'CLAIMED',
      'CREATING_SCHEMA',
      'COPYING_TABLES',
      'APPLYING_GRANTS',
      'HARDENING_RLS',
      'SEEDING_LEDGER',
      'RECONCILING_SCHEMA',
      'DELETING_SCHEMA',
      'COMMITTED',
      'FAILED',
      'ABORTED',
      'DELETED'
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_schema_jobs_operation
  ON platform.tenant_schema_jobs (operation_id);
DROP INDEX IF EXISTS platform.idx_tenant_schema_jobs_active_tenant;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_schema_jobs_active_tenant
  ON platform.tenant_schema_jobs (tenant_id)
  WHERE status IN (
    'REQUESTED',
    'CLAIMED',
    'CREATING_SCHEMA',
    'COPYING_TABLES',
    'APPLYING_GRANTS',
    'HARDENING_RLS',
    'SEEDING_LEDGER',
    'RECONCILING_SCHEMA',
    'DELETING_SCHEMA'
  );
CREATE INDEX IF NOT EXISTS idx_tenant_schema_jobs_claim
  ON platform.tenant_schema_jobs (status, created_at)
  WHERE status IN ('REQUESTED', 'CLAIMED');

CREATE OR REPLACE FUNCTION platform.request_tenant_schema_provisioning(
  p_operation_id UUID,
  p_tenant_id UUID,
  p_schema_name TEXT,
  p_payload JSONB DEFAULT '{}'::jsonb
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
-- Pinned search_path: mandatory hardening for SECURITY DEFINER (the body
-- references only schema-qualified objects, so the pin is behavior-neutral).
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_job_id UUID;
BEGIN
  IF p_operation_id IS NULL OR p_tenant_id IS NULL OR p_schema_name IS NULL THEN
    RAISE EXCEPTION 'Tenant schema provisioning requires operation_id, tenant_id, and schema_name';
  END IF;

  IF p_schema_name !~ '^tenant_[a-f0-9]{16}$' THEN
    RAISE EXCEPTION 'Invalid tenant schema name: %', p_schema_name;
  END IF;

  IF p_schema_name IS DISTINCT FROM ('tenant_' || LEFT(REPLACE(p_tenant_id::text, '-', ''), 16)) THEN
    RAISE EXCEPTION 'Tenant schema name % does not match tenant_id %', p_schema_name, p_tenant_id;
  END IF;

  p_payload := COALESCE(p_payload, '{}'::jsonb);

  INSERT INTO platform.tenant_schema_jobs (
    operation_id,
    tenant_id,
    schema_name,
    job_type,
    status,
    requested_by,
    request_payload
  ) VALUES (
    p_operation_id,
    p_tenant_id,
    p_schema_name,
    'PROVISION',
    'REQUESTED',
    session_user,
    p_payload
  )
  ON CONFLICT (operation_id) DO UPDATE SET
    status = CASE
      WHEN platform.tenant_schema_jobs.status IN ('FAILED', 'ABORTED') THEN 'REQUESTED'
      ELSE platform.tenant_schema_jobs.status
    END,
    lease_token = CASE
      WHEN platform.tenant_schema_jobs.status IN ('FAILED', 'ABORTED') THEN NULL
      ELSE platform.tenant_schema_jobs.lease_token
    END,
    leased_by = CASE
      WHEN platform.tenant_schema_jobs.status IN ('FAILED', 'ABORTED') THEN NULL
      ELSE platform.tenant_schema_jobs.leased_by
    END,
    lease_expires_at = CASE
      WHEN platform.tenant_schema_jobs.status IN ('FAILED', 'ABORTED') THEN NULL
      ELSE platform.tenant_schema_jobs.lease_expires_at
    END,
    error_message = CASE
      WHEN platform.tenant_schema_jobs.status IN ('FAILED', 'ABORTED') THEN NULL
      ELSE platform.tenant_schema_jobs.error_message
    END,
    request_payload = CASE
      WHEN platform.tenant_schema_jobs.status IN ('FAILED', 'ABORTED') THEN EXCLUDED.request_payload
      ELSE platform.tenant_schema_jobs.request_payload
    END,
    source_heads = CASE
      WHEN platform.tenant_schema_jobs.status IN ('FAILED', 'ABORTED') THEN '{}'::jsonb
      ELSE platform.tenant_schema_jobs.source_heads
    END,
    tenant_heads = CASE
      WHEN platform.tenant_schema_jobs.status IN ('FAILED', 'ABORTED') THEN '{}'::jsonb
      ELSE platform.tenant_schema_jobs.tenant_heads
    END,
    table_count = CASE
      WHEN platform.tenant_schema_jobs.status IN ('FAILED', 'ABORTED') THEN 0
      ELSE platform.tenant_schema_jobs.table_count
    END,
    failure_residue = CASE
      WHEN platform.tenant_schema_jobs.status IN ('FAILED', 'ABORTED') THEN '{}'::jsonb
      ELSE platform.tenant_schema_jobs.failure_residue
    END,
    updated_at = NOW()
  WHERE platform.tenant_schema_jobs.tenant_id = EXCLUDED.tenant_id
    AND platform.tenant_schema_jobs.schema_name = EXCLUDED.schema_name
  RETURNING id INTO v_job_id;

  IF v_job_id IS NULL THEN
    RAISE EXCEPTION 'operation_id % already belongs to a different tenant schema job', p_operation_id;
  END IF;

  RETURN v_job_id;
END;
$$;

CREATE OR REPLACE FUNCTION platform.request_tenant_schema_deletion(
  p_operation_id UUID,
  p_tenant_id UUID,
  p_schema_name TEXT,
  p_payload JSONB DEFAULT '{}'::jsonb
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
-- Pinned search_path: mandatory hardening for SECURITY DEFINER (the body
-- references only schema-qualified objects, so the pin is behavior-neutral).
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_job_id UUID;
BEGIN
  IF p_operation_id IS NULL OR p_tenant_id IS NULL OR p_schema_name IS NULL THEN
    RAISE EXCEPTION 'Tenant schema deletion requires operation_id, tenant_id, and schema_name';
  END IF;

  IF p_schema_name !~ '^tenant_[a-f0-9]{16}$' THEN
    RAISE EXCEPTION 'Invalid tenant schema name: %', p_schema_name;
  END IF;

  IF p_schema_name IS DISTINCT FROM ('tenant_' || LEFT(REPLACE(p_tenant_id::text, '-', ''), 16)) THEN
    RAISE EXCEPTION 'Tenant schema name % does not match tenant_id %', p_schema_name, p_tenant_id;
  END IF;

  p_payload := COALESCE(p_payload, '{}'::jsonb);

  IF p_payload->'cleanupProof' IS NULL THEN
    RAISE EXCEPTION 'Tenant schema deletion requires cleanupProof evidence';
  END IF;

  IF p_payload->'cleanupProof'->>'operationId' IS DISTINCT FROM p_operation_id::text
     OR p_payload->'cleanupProof'->>'tenantId' IS DISTINCT FROM p_tenant_id::text THEN
    RAISE EXCEPTION 'Tenant schema deletion cleanupProof does not match the requested operation/tenant';
  END IF;

  IF p_payload->'cleanupProof'->>'purpose' NOT IN ('tenant_deprovision', 'tenant_erasure') THEN
    RAISE EXCEPTION 'Tenant schema deletion requires tenant_deprovision or tenant_erasure cleanupProof';
  END IF;

  IF COALESCE(p_payload->'cleanupProof'->>'legalHoldCheckedAt', '') = '' THEN
    RAISE EXCEPTION 'Tenant schema deletion requires legal-hold evidence';
  END IF;

  IF p_payload->'cleanupProof'->>'purpose' = 'tenant_deprovision'
     AND (
       COALESCE((p_payload->'cleanupProof'->'backup'->>'isEncrypted')::boolean, false) IS DISTINCT FROM true
       OR COALESCE(p_payload->'cleanupProof'->'backup'->>'checksum', '') = ''
       OR COALESCE((p_payload->'cleanupProof'->'backup'->>'sizeBytes')::numeric, 0) <= 0
     ) THEN
    RAISE EXCEPTION 'Tenant schema deletion requires encrypted backup evidence';
  END IF;

  IF jsonb_typeof(p_payload->'cleanupProof'->'preCounts'->'existingSchemas') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Tenant schema deletion requires pre-delete count evidence';
  END IF;

  IF p_payload->'tombstone'->>'cleanupRunId' IS DISTINCT FROM p_operation_id::text THEN
    RAISE EXCEPTION 'Tenant schema deletion requires matching tombstone evidence';
  END IF;

  INSERT INTO platform.tenant_schema_jobs (
    operation_id,
    tenant_id,
    schema_name,
    job_type,
    status,
    requested_by,
    request_payload
  ) VALUES (
    p_operation_id,
    p_tenant_id,
    p_schema_name,
    'DELETE',
    'REQUESTED',
    session_user,
    p_payload
  )
  ON CONFLICT (operation_id) DO UPDATE SET
    status = CASE
      WHEN platform.tenant_schema_jobs.status IN ('FAILED', 'ABORTED') THEN 'REQUESTED'
      ELSE platform.tenant_schema_jobs.status
    END,
    request_payload = CASE
      WHEN platform.tenant_schema_jobs.status IN ('FAILED', 'ABORTED') THEN EXCLUDED.request_payload
      ELSE platform.tenant_schema_jobs.request_payload
    END,
    lease_token = CASE
      WHEN platform.tenant_schema_jobs.status IN ('FAILED', 'ABORTED') THEN NULL
      ELSE platform.tenant_schema_jobs.lease_token
    END,
    leased_by = CASE
      WHEN platform.tenant_schema_jobs.status IN ('FAILED', 'ABORTED') THEN NULL
      ELSE platform.tenant_schema_jobs.leased_by
    END,
    lease_expires_at = CASE
      WHEN platform.tenant_schema_jobs.status IN ('FAILED', 'ABORTED') THEN NULL
      ELSE platform.tenant_schema_jobs.lease_expires_at
    END,
    source_heads = CASE
      WHEN platform.tenant_schema_jobs.status IN ('FAILED', 'ABORTED') THEN '{}'::jsonb
      ELSE platform.tenant_schema_jobs.source_heads
    END,
    tenant_heads = CASE
      WHEN platform.tenant_schema_jobs.status IN ('FAILED', 'ABORTED') THEN '{}'::jsonb
      ELSE platform.tenant_schema_jobs.tenant_heads
    END,
    table_count = CASE
      WHEN platform.tenant_schema_jobs.status IN ('FAILED', 'ABORTED') THEN 0
      ELSE platform.tenant_schema_jobs.table_count
    END,
    failure_residue = CASE
      WHEN platform.tenant_schema_jobs.status IN ('FAILED', 'ABORTED') THEN '{}'::jsonb
      ELSE platform.tenant_schema_jobs.failure_residue
    END,
    error_message = CASE
      WHEN platform.tenant_schema_jobs.status IN ('FAILED', 'ABORTED') THEN NULL
      ELSE platform.tenant_schema_jobs.error_message
    END,
    updated_at = NOW()
  WHERE platform.tenant_schema_jobs.tenant_id = EXCLUDED.tenant_id
    AND platform.tenant_schema_jobs.schema_name = EXCLUDED.schema_name
    AND platform.tenant_schema_jobs.job_type = 'DELETE'
  RETURNING id INTO v_job_id;

  IF v_job_id IS NULL THEN
    RAISE EXCEPTION 'operation_id % already belongs to a different tenant schema job', p_operation_id;
  END IF;

  RETURN v_job_id;
END;
$$;

CREATE OR REPLACE FUNCTION platform.request_tenant_schema_reconciliation(
  p_operation_id UUID,
  p_tenant_id UUID,
  p_schema_name TEXT,
  p_payload JSONB DEFAULT '{}'::jsonb
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
-- Pinned search_path: mandatory hardening for SECURITY DEFINER (the body
-- references only schema-qualified objects, so the pin is behavior-neutral).
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_job_id UUID;
BEGIN
  IF p_operation_id IS NULL OR p_tenant_id IS NULL OR p_schema_name IS NULL THEN
    RAISE EXCEPTION 'Tenant schema reconciliation requires operation_id, tenant_id, and schema_name';
  END IF;

  IF p_schema_name !~ '^tenant_[a-f0-9]{16}$' THEN
    RAISE EXCEPTION 'Invalid tenant schema name: %', p_schema_name;
  END IF;

  IF p_schema_name IS DISTINCT FROM ('tenant_' || LEFT(REPLACE(p_tenant_id::text, '-', ''), 16)) THEN
    RAISE EXCEPTION 'Tenant schema name % does not match tenant_id %', p_schema_name, p_tenant_id;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = p_schema_name) THEN
    RAISE EXCEPTION 'Tenant schema reconciliation requires an existing schema: %', p_schema_name;
  END IF;

  p_payload := COALESCE(p_payload, '{}'::jsonb);

  INSERT INTO platform.tenant_schema_jobs (
    operation_id,
    tenant_id,
    schema_name,
    job_type,
    status,
    requested_by,
    request_payload
  ) VALUES (
    p_operation_id,
    p_tenant_id,
    p_schema_name,
    'RECONCILE_EXISTING_SCHEMA',
    'REQUESTED',
    session_user,
    p_payload
  )
  ON CONFLICT (operation_id) DO UPDATE SET
    status = CASE
      WHEN platform.tenant_schema_jobs.status IN ('FAILED', 'ABORTED') THEN 'REQUESTED'
      ELSE platform.tenant_schema_jobs.status
    END,
    request_payload = CASE
      WHEN platform.tenant_schema_jobs.status IN ('FAILED', 'ABORTED') THEN EXCLUDED.request_payload
      ELSE platform.tenant_schema_jobs.request_payload
    END,
    lease_token = CASE
      WHEN platform.tenant_schema_jobs.status IN ('FAILED', 'ABORTED') THEN NULL
      ELSE platform.tenant_schema_jobs.lease_token
    END,
    leased_by = CASE
      WHEN platform.tenant_schema_jobs.status IN ('FAILED', 'ABORTED') THEN NULL
      ELSE platform.tenant_schema_jobs.leased_by
    END,
    lease_expires_at = CASE
      WHEN platform.tenant_schema_jobs.status IN ('FAILED', 'ABORTED') THEN NULL
      ELSE platform.tenant_schema_jobs.lease_expires_at
    END,
    source_heads = CASE
      WHEN platform.tenant_schema_jobs.status IN ('FAILED', 'ABORTED') THEN '{}'::jsonb
      ELSE platform.tenant_schema_jobs.source_heads
    END,
    tenant_heads = CASE
      WHEN platform.tenant_schema_jobs.status IN ('FAILED', 'ABORTED') THEN '{}'::jsonb
      ELSE platform.tenant_schema_jobs.tenant_heads
    END,
    table_count = CASE
      WHEN platform.tenant_schema_jobs.status IN ('FAILED', 'ABORTED') THEN 0
      ELSE platform.tenant_schema_jobs.table_count
    END,
    failure_residue = CASE
      WHEN platform.tenant_schema_jobs.status IN ('FAILED', 'ABORTED') THEN '{}'::jsonb
      ELSE platform.tenant_schema_jobs.failure_residue
    END,
    error_message = CASE
      WHEN platform.tenant_schema_jobs.status IN ('FAILED', 'ABORTED') THEN NULL
      ELSE platform.tenant_schema_jobs.error_message
    END,
    updated_at = NOW()
  WHERE platform.tenant_schema_jobs.tenant_id = EXCLUDED.tenant_id
    AND platform.tenant_schema_jobs.schema_name = EXCLUDED.schema_name
    AND platform.tenant_schema_jobs.job_type = 'RECONCILE_EXISTING_SCHEMA'
  RETURNING id INTO v_job_id;

  IF v_job_id IS NULL THEN
    RAISE EXCEPTION 'operation_id % already belongs to a different tenant schema job', p_operation_id;
  END IF;

  RETURN v_job_id;
END;
$$;

REVOKE ALL ON platform.tenant_schema_jobs FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.request_tenant_schema_provisioning(UUID, UUID, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.request_tenant_schema_deletion(UUID, UUID, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.request_tenant_schema_reconciliation(UUID, UUID, TEXT, JSONB) FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE ON platform.tenant_schema_jobs TO db_migrate;
GRANT USAGE ON SCHEMA platform TO admin_service;
GRANT USAGE ON SCHEMA platform TO auth_service;
GRANT SELECT ON platform.tenant_schema_jobs TO admin_service;
GRANT SELECT ON platform.tenant_schema_jobs TO auth_service;
GRANT EXECUTE ON FUNCTION platform.request_tenant_schema_provisioning(UUID, UUID, TEXT, JSONB) TO admin_service;
GRANT EXECUTE ON FUNCTION platform.request_tenant_schema_provisioning(UUID, UUID, TEXT, JSONB) TO auth_service;
GRANT EXECUTE ON FUNCTION platform.request_tenant_schema_deletion(UUID, UUID, TEXT, JSONB) TO admin_service;
GRANT EXECUTE ON FUNCTION platform.request_tenant_schema_reconciliation(UUID, UUID, TEXT, JSONB) TO admin_service;

COMMENT ON TABLE platform.tenant_schema_jobs IS
  'Durable tenant schema provision/delete FSM. Runtime services write intent; aqua-db-migrate owns DDL and admin.tenant_schemas commit evidence.';
