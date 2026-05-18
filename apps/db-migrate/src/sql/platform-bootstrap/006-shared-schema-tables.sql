-- ============================================================================
-- Platform Bootstrap — Stage 6 of 7: Shared Schema Tables (SHARED_SCHEMA_TABLES)
--
-- The 5 cross-tenant tables that live in the `shared` schema (ADR-011):
--
--   1. shared.audit_logs         — semantic-action audit (7-year forensic horizon)
--   2. shared.gdpr_data_requests — GDPR Art 17 / Art 20 request ledger
--   3. shared.user_consents      — consent ledger (GDPR Art 7)
--   4. shared.user_permissions   — RBAC permissions, read by every service
--   5. shared.access_logs        — low-level HTTP access stream (90-day horizon)
--
-- Source-of-truth for the canonical list:
--   scripts/schema-registry/generate-init-schemas.ts:87 (SHARED_SCHEMA_TABLES)
--   e2e/tests/integration/schema-invariants.spec.ts:51-56 (SHARED_SCHEMA_TABLES)
--   libs/backend-common/src/constants/protected-tables.ts
--
-- Column shapes are MIRRORED from the entity files. If an entity changes,
-- update the entity AND this file in the same PR. The schema-drift
-- validator catches divergence at runtime as a defense-in-depth backstop.
--
-- Verbatim port from infrastructure/docker/init-scripts/10-shared-schema.sql
-- — content preserved, runtime surface moved from initdb-only to
-- platform-bootstrap atom (Phase 0 of aqua-db-migrate, restart-survive).
-- ============================================================================

-- ──────────────────────────────────────────────────────────────────────────
-- Shared schema owner role
-- ──────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shared_schema_owner') THEN
    CREATE ROLE shared_schema_owner NOLOGIN;
  END IF;
END
$$;

-- Grant shared_schema_owner to every service that reads or writes the
-- 5 shared tables. This is every backend service because user_permissions
-- is platform-wide RBAC — every tenant-scoped query path consults it.
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
GRANT shared_schema_owner TO observability_service;
GRANT shared_schema_owner TO event_store_service;
GRANT shared_schema_owner TO config_service;

GRANT USAGE ON SCHEMA shared TO PUBLIC;

-- Every service needs DML on every shared table. Grant broad READ + WRITE;
-- RLS enforces tenant isolation at the row level.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA shared TO PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA shared
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO PUBLIC;

-- ──────────────────────────────────────────────────────────────────────────
-- Live-DB migration path: tables previously in `public` move to `shared`
-- ──────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'audit_logs', 'gdpr_data_requests', 'user_consents',
    'user_permissions', 'access_logs'
  ]
  LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = t)
       AND NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'shared' AND tablename = t)
    THEN
      EXECUTE format('ALTER TABLE public.%I SET SCHEMA shared', t);
    END IF;
  END LOOP;
END
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- shared.audit_logs — semantic-action audit (canonical column shape from
-- libs/backend-common/src/audit/audit-log.entity.ts)
-- ──────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  -- Recovery from wrong-shape live DB: legacy admin-api shape lacks `resource`.
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
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname IN ('public','shared') AND tablename = 'audit_logs') THEN
    CREATE TABLE shared.audit_logs (
      id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      action        VARCHAR(100) NOT NULL,
      resource      VARCHAR(100) NOT NULL,
      "resourceId"  VARCHAR(255),
      "userId"      VARCHAR(255),
      "userEmail"   VARCHAR(255),
      "tenantId"    UUID,
      "schemaName"  VARCHAR(100),
      metadata      JSONB,
      ip            VARCHAR(45),
      "userAgent"   VARCHAR(500),
      severity      VARCHAR(20)  NOT NULL DEFAULT 'info',
      "correlationId" VARCHAR(100),
      "createdAt"   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
    CREATE INDEX "IDX_audit_log_tenant_created" ON shared.audit_logs ("tenantId", "createdAt");
    CREATE INDEX "IDX_audit_log_user_tenant"    ON shared.audit_logs ("userId", "tenantId");
    CREATE INDEX "IDX_audit_log_resource"       ON shared.audit_logs (resource, "resourceId", "tenantId");
    CREATE INDEX "IDX_audit_log_action"         ON shared.audit_logs (action, "tenantId");
  END IF;
END
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- shared.gdpr_data_requests
-- Mirrors libs/backend-common/src/security/gdpr/entities/data-request.entity.ts
-- ──────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname IN ('public','shared') AND tablename = 'gdpr_data_requests') THEN
    CREATE TABLE shared.gdpr_data_requests (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "userId"          UUID         NOT NULL,
      "tenantId"        UUID,
      "requestType"     VARCHAR(50)  NOT NULL,
      status            VARCHAR(50)  NOT NULL DEFAULT 'pending',
      reason            TEXT,
      "ipAddress"       VARCHAR(50),
      "userAgent"       VARCHAR(500),
      "requestDetails"  JSONB,
      "processingDetails" JSONB,
      "downloadUrl"     VARCHAR(500),
      "downloadExpiresAt" TIMESTAMPTZ,
      "processedAt"     TIMESTAMPTZ,
      "processedBy"     UUID,
      "errorMessage"    TEXT,
      "recordsAffected" INT          NOT NULL DEFAULT 0,
      "createdAt"       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      "updatedAt"       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
    CREATE INDEX "IDX_data_request_user"   ON shared.gdpr_data_requests ("userId");
    CREATE INDEX "IDX_data_request_tenant" ON shared.gdpr_data_requests ("tenantId");
    CREATE INDEX "IDX_data_request_type"   ON shared.gdpr_data_requests ("requestType");
    CREATE INDEX "IDX_data_request_status" ON shared.gdpr_data_requests (status);
  END IF;
END
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- shared.user_consents
-- Mirrors libs/backend-common/src/security/gdpr/entities/consent.entity.ts
-- ──────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname IN ('public','shared') AND tablename = 'user_consents') THEN
    CREATE TABLE shared.user_consents (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "userId"          UUID         NOT NULL,
      "tenantId"        UUID,
      "consentType"     VARCHAR(50)  NOT NULL,
      granted           BOOLEAN      NOT NULL,
      version           VARCHAR(50)  NOT NULL,
      "ipAddress"       VARCHAR(50),
      "userAgent"       VARCHAR(500),
      "expiresAt"       TIMESTAMPTZ,
      metadata          JSONB,
      "withdrawalReason" TEXT,
      "createdAt"       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
    CREATE INDEX "IDX_consent_user"      ON shared.user_consents ("userId");
    CREATE INDEX "IDX_consent_tenant"    ON shared.user_consents ("tenantId");
    CREATE INDEX "IDX_consent_type"      ON shared.user_consents ("consentType");
    CREATE INDEX "IDX_consent_user_type" ON shared.user_consents ("userId", "consentType");
  END IF;
END
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- shared.user_permissions
-- Mirrors apps/admin-api-service/src/users/entities/user-permissions.entity.ts
-- ──────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname IN ('public','shared') AND tablename = 'user_permissions') THEN
    CREATE TABLE shared.user_permissions (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "userId"     UUID         NOT NULL,
      "tenantId"   UUID         NOT NULL,
      permissions  JSONB        NOT NULL DEFAULT '{}'::jsonb,
      "isActive"   BOOLEAN      NOT NULL DEFAULT true,
      "grantedBy"  UUID,
      "createdAt"  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      "updatedAt"  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
    CREATE INDEX        idx_user_permissions_user   ON shared.user_permissions ("userId");
    CREATE INDEX        idx_user_permissions_tenant ON shared.user_permissions ("tenantId");
    CREATE UNIQUE INDEX idx_user_permissions_user_tenant_unique ON shared.user_permissions ("userId", "tenantId");
  END IF;
END
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- shared.access_logs — low-level HTTP request stream
-- Mirrors libs/backend-common/src/audit/access-log.entity.ts (AUDITTRAIL-HIGH-004)
-- ──────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname IN ('public','shared') AND tablename = 'access_logs') THEN
    CREATE TABLE shared.access_logs (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      method          VARCHAR(8)    NOT NULL,
      path            VARCHAR(2048) NOT NULL,
      status          INTEGER       NOT NULL,
      "durationMs"    INTEGER       NOT NULL,
      "userId"        VARCHAR(255),
      "tenantId"      UUID,
      "correlationId" VARCHAR(100),
      ip              INET,
      "userAgent"     VARCHAR(500),
      "createdAt"     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    );
    CREATE INDEX "IDX_access_log_tenant_created" ON shared.access_logs ("tenantId", "createdAt" DESC);
    CREATE INDEX "IDX_access_log_user_created"   ON shared.access_logs ("userId", "createdAt" DESC);
    CREATE INDEX "IDX_access_log_path_created"   ON shared.access_logs (path, "createdAt" DESC);
    CREATE INDEX "IDX_access_log_status_created" ON shared.access_logs (status, "createdAt" DESC);
  END IF;
END
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- Live-DB timestamp → timestamptz drift correction (legacy DBs only)
-- ──────────────────────────────────────────────────────────────────────────
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

-- ──────────────────────────────────────────────────────────────────────────
-- Apply ownership + FORCE RLS to every shared.* table
-- ──────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'audit_logs', 'gdpr_data_requests', 'user_consents',
    'user_permissions', 'access_logs'
  ]
  LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'shared' AND tablename = t) THEN
      EXECUTE format('ALTER TABLE shared.%I OWNER TO shared_schema_owner', t);
      EXECUTE format('ALTER TABLE shared.%I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('ALTER TABLE shared.%I FORCE  ROW LEVEL SECURITY', t);
    END IF;
  END LOOP;
END
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- Install tenant_isolation_policy on each shared.* table that has tenantId.
-- Canonical predicate from
-- libs/backend-common/src/database/rls/apply-tenant-rls.helper.ts.
-- ──────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  entry record;
BEGIN
  FOR entry IN
    SELECT * FROM (VALUES
      ('audit_logs',         'tenantId'),
      ('gdpr_data_requests', 'tenantId'),
      ('user_consents',      'tenantId'),
      ('user_permissions',   'tenantId'),
      ('access_logs',        'tenantId')
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

-- ──────────────────────────────────────────────────────────────────────────
-- Install append-only immutability trigger on audit + access tables.
-- Uses public.audit_immutability_guard() installed in stage 005.
-- ──────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['audit_logs', 'access_logs']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'shared' AND tablename = t) THEN
      EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_immutable_update ON shared.%I', t, t);
      EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_immutable_delete ON shared.%I', t, t);
      EXECUTE format(
        'CREATE TRIGGER trg_%s_immutable_update BEFORE UPDATE ON shared.%I ' ||
        'FOR EACH ROW EXECUTE FUNCTION public.audit_immutability_guard()',
        t, t
      );
      EXECUTE format(
        'CREATE TRIGGER trg_%s_immutable_delete BEFORE DELETE ON shared.%I ' ||
        'FOR EACH ROW EXECUTE FUNCTION public.audit_immutability_guard()',
        t, t
      );
    END IF;
  END LOOP;
END
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- Drop the legacy shared_public_owner role (post-Wave 4-A.2 cleanup).
-- ──────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shared_public_owner') THEN
    REASSIGN OWNED BY shared_public_owner TO shared_schema_owner;
    DROP OWNED BY shared_public_owner;
    DROP ROLE shared_public_owner;
  END IF;
END
$$;
