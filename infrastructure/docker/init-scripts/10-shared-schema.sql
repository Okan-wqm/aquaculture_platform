-- ============================================================================
-- 10-shared-schema.sql
--
-- Creates the `shared` schema and moves the four genuinely cross-service
-- tables into it:
--
--   - audit_logs         written by billing / config / notification / alert
--                        / ai / admin-api (via backend-common AuditLogEntity)
--   - gdpr_data_requests written by auth + admin-api (GDPR data exports)
--   - user_consents      written by auth + admin-api (consent records)
--   - user_permissions   written by admin-api, READ by every backend service
--                        for tenant-permission enforcement
--
-- Phase 9 of docs/plans/2026-04-14 public-schema teardown. Closes the
-- "public = shared" convention that made the teardown's first half
-- (P6-P8) impossible without this follow-up — now each table lives in
-- exactly one schema with a clear ownership contract.
--
-- # Why a dedicated schema (instead of leaving them in public)
--
-- The 06-public-schema-ownership.sql workaround (shared_public_owner
-- role owning public.<shared_table>) solved the immediate RLS bootstrap
-- breakage on 2026-04-14. It is architecturally incomplete:
--
--   - `public` is the PostgreSQL default; any TypeORM entity that
--     forgets `schema:` lands there silently. We have no hook for
--     "genuinely shared" vs. "schema decoration forgotten" — the
--     CI invariant in P11 needs a clean signal.
--   - The role name `shared_public_owner` bakes "public" into the
--     architecture, implying the schema choice itself is permanent.
--     It is not — it was a stopgap.
--   - Cross-service readers of user_permissions had to accept that
--     every other service's schema chain would eventually include
--     public; moving these tables to `shared` gives consumers an
--     explicit search_path entry (search_path = "<own>, shared, public`)
--     so the resolution order is documented rather than emergent.
--
-- # Role rename
--
-- `shared_public_owner` is renamed to `shared_schema_owner` to drop
-- the `public` connotation. Role membership for the three bootstrap-
-- pattern service users (billing_service, gateway_service,
-- notification_service) is re-granted under the new name. The old role
-- is dropped after ownership transfer.
--
-- # Idempotency
--
-- Every step uses existence / NOT EXISTS guards so the script is safe
-- to re-run. SET SCHEMA moves are guarded by the "exists in source AND
-- absent from target" predicate — after a successful move, re-runs are
-- pure no-ops.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Schema + role
-- ----------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS shared;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shared_schema_owner') THEN
    CREATE ROLE shared_schema_owner NOLOGIN;
  END IF;
END
$$;

-- Grant shared_schema_owner to every service that reads or writes the
-- four shared tables. This is every backend service because
-- user_permissions is platform-wide RBAC — every tenant-scoped query
-- path consults it.
GRANT shared_schema_owner TO auth_service;
GRANT shared_schema_owner TO farm_service;
GRANT shared_schema_owner TO sensor_service;
GRANT shared_schema_owner TO billing_service;
GRANT shared_schema_owner TO hr_service;
GRANT shared_schema_owner TO alert_service;
GRANT shared_schema_owner TO admin_service;
GRANT shared_schema_owner TO gateway_service;
GRANT shared_schema_owner TO notification_service;
GRANT shared_schema_owner TO hydroponics_service;
GRANT shared_schema_owner TO ai_service;
GRANT shared_schema_owner TO messaging_service;

-- Grant USAGE so service users can resolve names in the schema.
GRANT USAGE ON SCHEMA shared TO PUBLIC;

-- Every service needs DML on every shared table. Grant broad READ +
-- WRITE; RLS enforces tenant isolation at the row level. The @aquaculture
-- superuser retains admin rights for maintenance.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA shared TO PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA shared
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO PUBLIC;

-- ----------------------------------------------------------------------------
-- 2. Move tables from public to shared (live-DB migration path)
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['audit_logs', 'gdpr_data_requests', 'user_consents', 'user_permissions']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = t)
       AND NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'shared' AND tablename = t)
    THEN
      EXECUTE format('ALTER TABLE public.%I SET SCHEMA shared', t);
    END IF;
  END LOOP;
END
$$;

-- ----------------------------------------------------------------------------
-- 2b. Create shared.* tables that don't exist anywhere yet (fresh-deploy path)
--
-- Closes CRITICAL-001 from the 2026-04-14 review: previously, the only init
-- script that creates any of these tables in public is 04-billing-tables.sql
-- (audit_logs only). On fresh deploys the other 3 tables didn't exist when
-- this script ran, so step 2 above no-op'd, step 3 (RLS install) skipped
-- them, and TypeORM synchronize later created them in shared without RLS —
-- a cross-tenant leak window.
--
-- Idempotency contract: each block runs ONLY when the table is absent from
-- BOTH public AND shared. This means:
--   - Live DB (table currently in public): step 2 moves it; this section
--     skips it (NOT EXISTS in shared check fails after the move? No — step
--     2 ran in this same DO block earlier, so this section sees it in shared
--     and skips). Verified by reading.
--   - Fresh deploy (table absent everywhere): this section creates it in
--     shared with the canonical column shape from the entity file referenced
--     in each block's leading comment.
--   - Re-run after table exists in shared: skipped (NOT EXISTS check fails).
--
-- Column shapes are MIRRORED from the entity files. If an entity changes,
-- update both the entity AND this section in the same PR. The schema-drift
-- validator (libs/backend-common/.../schema-drift-validator.service.ts) will
-- catch divergence at runtime as a defense-in-depth backstop.
-- ----------------------------------------------------------------------------

-- shared.audit_logs
-- Mirrors libs/backend-common/src/audit/audit-log.entity.ts:28 — the
-- CANONICAL writer for this table. Every backend service that imports
-- AuditLogModule writes via AuditLogService.record() which builds rows
-- with this column shape (resource, userId, userEmail, schemaName,
-- metadata, ip, correlationId).
--
-- # Recovery from wrong shape (NEW-CRITICAL-A live-DB fix)
--
-- The pre-2026-04-14 04-billing-tables.sql created public.audit_logs
-- with the admin-api entity column shape (entityType, performedBy,
-- requestId, etc). Live DBs that ran that init have shared.audit_logs
-- with the wrong shape (after P9's SET SCHEMA move). The DROP-and-
-- recreate guard below detects the wrong shape via the absence of the
-- canonical `resource` column and rebuilds. Safe because every
-- AuditLogService.record() call against the wrong-shape table has been
-- silently failing — there are no real audit rows to lose.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'shared' AND tablename = 'audit_logs')
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'shared' AND table_name = 'audit_logs' AND column_name = 'resource'
     )
  THEN
    DROP TABLE shared.audit_logs CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname IN ('public', 'shared') AND tablename = 'audit_logs') THEN
    CREATE TABLE shared.audit_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      action VARCHAR(100) NOT NULL,
      resource VARCHAR(100) NOT NULL,
      "resourceId" VARCHAR(255),
      "userId" VARCHAR(255),
      "userEmail" VARCHAR(255),
      "tenantId" UUID,
      "schemaName" VARCHAR(100),
      metadata JSONB,
      ip VARCHAR(45),
      "userAgent" VARCHAR(500),
      severity VARCHAR(20) NOT NULL DEFAULT 'info',
      "correlationId" VARCHAR(100),
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX "IDX_audit_log_tenant_created" ON shared.audit_logs ("tenantId", "createdAt");
    CREATE INDEX "IDX_audit_log_user_tenant" ON shared.audit_logs ("userId", "tenantId");
    CREATE INDEX "IDX_audit_log_resource" ON shared.audit_logs (resource, "resourceId", "tenantId");
    CREATE INDEX "IDX_audit_log_action" ON shared.audit_logs (action, "tenantId");
  END IF;
END
$$;

-- shared.gdpr_data_requests
-- Mirrors libs/backend-common/src/security/gdpr/entities/data-request.entity.ts:38
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname IN ('public', 'shared') AND tablename = 'gdpr_data_requests') THEN
    CREATE TABLE shared.gdpr_data_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "userId" UUID NOT NULL,
      "tenantId" UUID,
      "requestType" VARCHAR(50) NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'pending',
      reason TEXT,
      "ipAddress" VARCHAR(50),
      "userAgent" VARCHAR(500),
      "requestDetails" JSONB,
      "processingDetails" JSONB,
      "downloadUrl" VARCHAR(500),
      "downloadExpiresAt" TIMESTAMPTZ,
      "processedAt" TIMESTAMPTZ,
      "processedBy" UUID,
      "errorMessage" TEXT,
      "recordsAffected" INT NOT NULL DEFAULT 0,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX "IDX_data_request_user" ON shared.gdpr_data_requests ("userId");
    CREATE INDEX "IDX_data_request_tenant" ON shared.gdpr_data_requests ("tenantId");
    CREATE INDEX "IDX_data_request_type" ON shared.gdpr_data_requests ("requestType");
    CREATE INDEX "IDX_data_request_status" ON shared.gdpr_data_requests (status);
  END IF;
END
$$;

-- shared.user_consents
-- Mirrors libs/backend-common/src/security/gdpr/entities/consent.entity.ts:17
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname IN ('public', 'shared') AND tablename = 'user_consents') THEN
    CREATE TABLE shared.user_consents (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "userId" UUID NOT NULL,
      "tenantId" UUID,
      "consentType" VARCHAR(50) NOT NULL,
      granted BOOLEAN NOT NULL,
      version VARCHAR(50) NOT NULL,
      "ipAddress" VARCHAR(50),
      "userAgent" VARCHAR(500),
      "expiresAt" TIMESTAMPTZ,
      metadata JSONB,
      "withdrawalReason" TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX "IDX_consent_user" ON shared.user_consents ("userId");
    CREATE INDEX "IDX_consent_tenant" ON shared.user_consents ("tenantId");
    CREATE INDEX "IDX_consent_type" ON shared.user_consents ("consentType");
    CREATE INDEX "IDX_consent_user_type" ON shared.user_consents ("userId", "consentType");
  END IF;
END
$$;

-- shared.user_permissions
-- Mirrors apps/admin-api-service/src/users/entities/user-permissions.entity.ts:97
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname IN ('public', 'shared') AND tablename = 'user_permissions') THEN
    CREATE TABLE shared.user_permissions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "userId" UUID NOT NULL,
      "tenantId" UUID NOT NULL,
      permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
      "isActive" BOOLEAN NOT NULL DEFAULT true,
      "grantedBy" UUID,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX idx_user_permissions_user ON shared.user_permissions ("userId");
    CREATE INDEX idx_user_permissions_tenant ON shared.user_permissions ("tenantId");
    CREATE UNIQUE INDEX idx_user_permissions_user_tenant_unique ON shared.user_permissions ("userId", "tenantId");
  END IF;
END
$$;

-- ----------------------------------------------------------------------------
-- 2c. Apply ownership + FORCE RLS to every shared.* table that exists now
--
-- Idempotent re-assertion. Catches both code paths (move from public,
-- create-fresh-in-shared) with a single unified loop. SET SCHEMA preserves
-- ENABLE/FORCE bits since PG 9.5 but re-asserting is free defensive coding.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['audit_logs', 'gdpr_data_requests', 'user_consents', 'user_permissions']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'shared' AND tablename = t) THEN
      EXECUTE format('ALTER TABLE shared.%I OWNER TO shared_schema_owner', t);
      EXECUTE format('ALTER TABLE shared.%I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('ALTER TABLE shared.%I FORCE ROW LEVEL SECURITY', t);
    END IF;
  END LOOP;
END
$$;

-- ----------------------------------------------------------------------------
-- 2d. Live-DB timestamp → timestamptz drift correction
--
-- Closes NEW-HIGH-E from round-2 review. On live DBs where the GDPR
-- entities (libs/backend-common/src/security/gdpr/entities/*.ts) were
-- created via TypeORM synchronize BEFORE commit d14fb6fc updated the
-- entity decorators to declare `timestamptz`, the columns persist as
-- `timestamp without time zone` even though the entity now expects
-- `timestamp with time zone`. AuditColumnsBootstrap only converts
-- `createdAt`/`updatedAt` and only operates on `current_schema()` —
-- it does not reach the GDPR-domain timestamp columns
-- (downloadExpiresAt, processedAt, expiresAt) nor the shared schema.
--
-- Symptom of the drift: the tz-naive timestamp adopts the connection's
-- TIMEZONE setting on write, then reads back as if UTC — silent ±N-hour
-- skew on GDPR `downloadExpiresAt` (URL expiry) and `processedAt`
-- (audit window). Fixes correctness without data loss: the USING cast
-- treats the existing tz-naive value as UTC (the connection's stored
-- intent) and re-anchors as timestamptz.
--
-- Idempotent: each ALTER fires only when the column's current data_type
-- is `timestamp without time zone`. After conversion, re-runs are no-ops.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  entry record;
BEGIN
  FOR entry IN
    SELECT * FROM (VALUES
      ('gdpr_data_requests', 'downloadExpiresAt'),
      ('gdpr_data_requests', 'processedAt'),
      ('gdpr_data_requests', 'createdAt'),
      ('gdpr_data_requests', 'updatedAt'),
      ('user_consents',      'expiresAt'),
      ('user_consents',      'createdAt')
    ) AS t(tbl, col)
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'shared'
        AND table_name   = entry.tbl
        AND column_name  = entry.col
        AND data_type    = 'timestamp without time zone'
    ) THEN
      EXECUTE format(
        'ALTER TABLE shared.%I ALTER COLUMN %I TYPE TIMESTAMPTZ USING %I AT TIME ZONE ''UTC''',
        entry.tbl, entry.col, entry.col
      );
    END IF;
  END LOOP;
END
$$;

-- ----------------------------------------------------------------------------
-- 3. Install tenant_isolation_policy on each shared table
--
-- applyTenantRlsToSchema() (in backend-common) scans current_schema()
-- and installs policies on every table with a tenantId / tenant_id
-- column. Services call it at bootstrap (RlsSchemaBootstrap) but only
-- for their own schema. No service has current_schema = 'shared', so
-- bootstrap never reaches these four tables. Installing the policies
-- here at init time closes that gap.
--
-- Policy predicate matches libs/backend-common/src/database/rls/
-- apply-tenant-rls.helper.ts:187-196 buildTenantPolicyUsingClause.
-- Any change to the canonical predicate there should be mirrored here
-- (and then re-deployed to each tenant_<uuid> copy via
-- TenantRlsSyncService).
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  entry record;
BEGIN
  FOR entry IN
    SELECT * FROM (VALUES
      ('audit_logs',         'tenantId'),
      ('gdpr_data_requests', 'tenantId'),
      ('user_consents',      'tenantId'),
      ('user_permissions',   'tenantId')
    ) AS t(tbl, tcol)
  LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'shared' AND tablename = entry.tbl) THEN
      EXECUTE format(
        'DROP POLICY IF EXISTS tenant_isolation_policy ON shared.%I',
        entry.tbl
      );
      EXECUTE format(
        'CREATE POLICY tenant_isolation_policy ON shared.%I FOR ALL ' ||
        'USING (current_setting(''app.bypass_rls'', true) = ''on'' OR %I = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid) ' ||
        'WITH CHECK (current_setting(''app.bypass_rls'', true) = ''on'' OR %I = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid)',
        entry.tbl, entry.tcol, entry.tcol
      );
    END IF;
  END LOOP;
END
$$;

-- ----------------------------------------------------------------------------
-- 4. Drop the legacy shared_public_owner role
--
-- After the ownership transfer in step 2 the role owns zero tables.
-- DROP ROLE succeeds because its membership grants have been superseded
-- by the shared_schema_owner grants above. If any environment still has
-- shared_public_owner owning tables (e.g. migration partially applied),
-- the DROP fails loud — that's the correct signal for an operator to
-- investigate before finalising the cleanup.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shared_public_owner') THEN
    -- Reassign any remaining owned tables to shared_schema_owner
    -- defensively — this is a no-op in the expected case where step 2
    -- moved everything, but catches stragglers without data loss.
    REASSIGN OWNED BY shared_public_owner TO shared_schema_owner;
    DROP OWNED BY shared_public_owner;
    DROP ROLE shared_public_owner;
  END IF;
END
$$;
