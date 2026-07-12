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
    DROP TABLE IF EXISTS shared.audit_logs CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'shared' AND tablename = 'audit_logs') THEN
    CREATE TABLE IF NOT EXISTS shared.audit_logs (
      id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      action        VARCHAR(100) NOT NULL,
      resource      VARCHAR(100) NOT NULL,
      "resourceId"  VARCHAR(255),
      "userId"      VARCHAR(255),
      "userEmail"   VARCHAR(255),
      "tenantId"    UUID,
      "schemaName"  VARCHAR(100),
      metadata      JSONB,
      ip            INET,
      "userAgent"   VARCHAR(500),
      severity      VARCHAR(20)  NOT NULL DEFAULT 'info',
      "correlationId" VARCHAR(100),
      "createdAt"   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      "legalHold"   BOOLEAN      NOT NULL DEFAULT false,
      "actorHomeTenantId" UUID,
      "actedOnTenantId"   UUID,
      method        VARCHAR(16),
      "mfaVerified" BOOLEAN      NOT NULL DEFAULT false,
      result        VARCHAR(16),
      "preStateHash"  VARCHAR(64),
      "postStateHash" VARCHAR(64),
      justification TEXT,
      "relatedAuditIds" UUID[]
    );
    CREATE INDEX "IDX_audit_log_tenant_created" ON shared.audit_logs ("tenantId", "createdAt");
    CREATE INDEX "IDX_audit_log_user_tenant"    ON shared.audit_logs ("userId", "tenantId");
    CREATE INDEX "IDX_audit_log_resource"       ON shared.audit_logs (resource, "resourceId", "tenantId");
    CREATE INDEX "IDX_audit_log_action"         ON shared.audit_logs (action, "tenantId");
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'shared' AND tablename = 'audit_logs') THEN
    ALTER TABLE shared.audit_logs
      ADD COLUMN IF NOT EXISTS "legalHold" BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS "actorHomeTenantId" UUID,
      ADD COLUMN IF NOT EXISTS "actedOnTenantId" UUID,
      ADD COLUMN IF NOT EXISTS method VARCHAR(16),
      ADD COLUMN IF NOT EXISTS "mfaVerified" BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS result VARCHAR(16),
      ADD COLUMN IF NOT EXISTS "preStateHash" VARCHAR(64),
      ADD COLUMN IF NOT EXISTS "postStateHash" VARCHAR(64),
      ADD COLUMN IF NOT EXISTS justification TEXT,
      ADD COLUMN IF NOT EXISTS "relatedAuditIds" UUID[];

    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'shared'
        AND table_name = 'audit_logs'
        AND column_name = 'ip'
        AND data_type <> 'inet'
    ) THEN
      ALTER TABLE shared.audit_logs
        ALTER COLUMN ip TYPE INET USING NULLIF(ip::text, '')::inet;
    END IF;

  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'shared' AND tablename = 'audit_logs')
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid = 'shared.audit_logs'::regclass
         AND conname = 'chk_audit_logs_method'
     )
  THEN
    ALTER TABLE shared.audit_logs
      ADD CONSTRAINT chk_audit_logs_method
      CHECK (method IS NULL OR method IN ('HTTP', 'GRAPHQL', 'NATS', 'CRON', 'CLI'));
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'shared' AND tablename = 'audit_logs')
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid = 'shared.audit_logs'::regclass
         AND conname = 'chk_audit_logs_result'
     )
  THEN
    ALTER TABLE shared.audit_logs
      ADD CONSTRAINT chk_audit_logs_result
      CHECK (result IS NULL OR result IN ('SUCCESS', 'DENIED', 'FAILED'));
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'shared' AND tablename = 'audit_logs')
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid = 'shared.audit_logs'::regclass
         AND conname = 'chk_audit_logs_pre_state_hash'
     )
  THEN
    ALTER TABLE shared.audit_logs
      ADD CONSTRAINT chk_audit_logs_pre_state_hash
      CHECK ("preStateHash" IS NULL OR "preStateHash" ~ '^[0-9a-fA-F]{64}$');
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'shared' AND tablename = 'audit_logs')
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid = 'shared.audit_logs'::regclass
         AND conname = 'chk_audit_logs_post_state_hash'
     )
  THEN
    ALTER TABLE shared.audit_logs
      ADD CONSTRAINT chk_audit_logs_post_state_hash
      CHECK ("postStateHash" IS NULL OR "postStateHash" ~ '^[0-9a-fA-F]{64}$');
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_home_tenant_created
  ON shared.audit_logs ("actorHomeTenantId", "createdAt");
CREATE INDEX IF NOT EXISTS idx_audit_logs_acted_on_tenant_created
  ON shared.audit_logs ("actedOnTenantId", "createdAt");
CREATE INDEX IF NOT EXISTS idx_audit_logs_mfa_verified_created
  ON shared.audit_logs ("createdAt")
  WHERE "mfaVerified" = true;

-- ──────────────────────────────────────────────────────────────────────────
-- shared.gdpr_data_requests
-- Mirrors libs/backend-common/src/security/gdpr/entities/data-request.entity.ts
-- ──────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname IN ('public','shared') AND tablename = 'gdpr_data_requests') THEN
    CREATE TABLE IF NOT EXISTS shared.gdpr_data_requests (
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
      "updatedAt"       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      CONSTRAINT chk_shared_gdpr_data_requests_request_type
        CHECK ("requestType" IN ('export', 'deletion', 'rectification', 'restriction', 'portability')),
      CONSTRAINT chk_shared_gdpr_data_requests_status
        CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled'))
    );
    CREATE INDEX "IDX_data_request_user"   ON shared.gdpr_data_requests ("userId");
    CREATE INDEX "IDX_data_request_tenant" ON shared.gdpr_data_requests ("tenantId");
    CREATE INDEX "IDX_data_request_type"   ON shared.gdpr_data_requests ("requestType");
    CREATE INDEX "IDX_data_request_status" ON shared.gdpr_data_requests (status);
  END IF;
END
$$;

DO $$
BEGIN
  IF to_regclass('shared.gdpr_data_requests') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM pg_constraint
        WHERE conrelid = 'shared.gdpr_data_requests'::regclass
          AND conname = 'chk_shared_gdpr_data_requests_request_type'
     )
  THEN
    ALTER TABLE shared.gdpr_data_requests
      ADD CONSTRAINT chk_shared_gdpr_data_requests_request_type
      CHECK ("requestType" IN ('export', 'deletion', 'rectification', 'restriction', 'portability'))
      NOT VALID;
    ALTER TABLE shared.gdpr_data_requests
      VALIDATE CONSTRAINT chk_shared_gdpr_data_requests_request_type;
  END IF;

  IF to_regclass('shared.gdpr_data_requests') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM pg_constraint
        WHERE conrelid = 'shared.gdpr_data_requests'::regclass
          AND conname = 'chk_shared_gdpr_data_requests_status'
     )
  THEN
    ALTER TABLE shared.gdpr_data_requests
      ADD CONSTRAINT chk_shared_gdpr_data_requests_status
      CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled'))
      NOT VALID;
    ALTER TABLE shared.gdpr_data_requests
      VALIDATE CONSTRAINT chk_shared_gdpr_data_requests_status;
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
    CREATE TABLE IF NOT EXISTS shared.user_consents (
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
    CREATE UNIQUE INDEX "UQ_consent_user_type_version"
      ON shared.user_consents ("userId", "consentType", version);
  END IF;
END
$$;

-- Live-DB repair path for pre-index duplicate consent decisions.
--
-- `UQ_consent_user_type_version` is the entity-level SSoT: a
-- (userId, consentType, version) tuple represents exactly one consent
-- decision. Some legacy production rows predate that invariant and can
-- contain duplicate tuples. Keep the newest row as the canonical decision,
-- preserve every duplicate row under metadata.bootstrapDeduplicatedRows,
-- then delete the duplicate rows before the unique index is installed.
WITH ranked_consents AS (
  SELECT
    ctid AS row_ctid,
    id,
    "userId",
    "tenantId",
    "consentType",
    granted,
    version,
    "ipAddress",
    "userAgent",
    "expiresAt",
    metadata,
    "withdrawalReason",
    "createdAt",
    row_number() OVER (
      PARTITION BY "userId", "consentType", version
      ORDER BY "createdAt" DESC NULLS LAST, id DESC
    ) AS rn
  FROM shared.user_consents
),
duplicate_consents AS (
  SELECT *
  FROM ranked_consents
  WHERE rn > 1
),
archived_duplicates AS (
  SELECT
    keep.id AS keep_id,
    jsonb_agg(
      jsonb_build_object(
        'id', dup.id::text,
        'userId', dup."userId"::text,
        'tenantId', dup."tenantId"::text,
        'consentType', dup."consentType",
        'granted', dup.granted,
        'version', dup.version,
        'ipAddress', dup."ipAddress",
        'userAgent', dup."userAgent",
        'expiresAt', dup."expiresAt",
        'metadata', dup.metadata,
        'withdrawalReason', dup."withdrawalReason",
        'createdAt', dup."createdAt",
        'archivedAt', now(),
        'reason', 'duplicate (userId, consentType, version) before UQ_consent_user_type_version'
      )
      ORDER BY dup."createdAt" DESC NULLS LAST, dup.id DESC
    ) AS archived_rows
  FROM ranked_consents keep
  JOIN duplicate_consents dup
    ON dup."userId" = keep."userId"
   AND dup."consentType" = keep."consentType"
   AND dup.version = keep.version
  WHERE keep.rn = 1
  GROUP BY keep.id
),
archive_update AS (
  UPDATE shared.user_consents c
  SET metadata = jsonb_set(
    CASE
      WHEN c.metadata IS NULL THEN '{}'::jsonb
      WHEN jsonb_typeof(c.metadata) = 'object' THEN c.metadata
      ELSE jsonb_build_object('legacyMetadata', c.metadata)
    END,
    '{bootstrapDeduplicatedRows}',
    (
      CASE
        WHEN jsonb_typeof(c.metadata->'bootstrapDeduplicatedRows') = 'array'
          THEN c.metadata->'bootstrapDeduplicatedRows'
        ELSE '[]'::jsonb
      END
    ) || archived_duplicates.archived_rows,
    true
  )
  FROM archived_duplicates
  WHERE c.id = archived_duplicates.keep_id
  RETURNING c.id
)
DELETE FROM shared.user_consents c
USING duplicate_consents dup
WHERE c.ctid = dup.row_ctid;

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_consent_user_type_version"
  ON shared.user_consents ("userId", "consentType", version);

-- ──────────────────────────────────────────────────────────────────────────
-- shared.user_permissions
-- Mirrors apps/admin-api-service/src/users/entities/user-permissions.entity.ts
-- ──────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname IN ('public','shared') AND tablename = 'user_permissions') THEN
    CREATE TABLE IF NOT EXISTS shared.user_permissions (
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
    CREATE TABLE IF NOT EXISTS shared.access_logs (
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
-- Install tenant_isolation_policy on each shared.* COMPLIANCE-STATE table.
-- Canonical predicate from
-- libs/backend-common/src/database/rls/apply-tenant-rls.helper.ts.
--
-- shared.audit_logs AND shared.access_logs are DELIBERATELY EXCLUDED here
-- (ORPHAN-HIGH-308 / ORPHAN-MEDIUM-324 / ORPHAN-HIGH-367): it is a CROSS-TENANT append-only audit ledger written
-- from no-tenant-context paths (billing's unauthenticated Stripe webhook,
-- cross-service admin actions, platform SUPER_ADMIN with tenantId NULL). Under
-- tenant_isolation_policy those INSERTs are silently RLS-denied — the exact
-- defect. It gets the canonical infrastructure-ledger policy in the next block
-- (byte-for-byte identical to applyInfrastructureLedgerRls in backend-common,
-- the SSoT for every OTHER audit ledger's policy; parity is enforced by
-- tests/invariants/infrastructure-ledger-ssot.spec.ts).
-- ──────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  entry record;
BEGIN
  FOR entry IN
    SELECT * FROM (VALUES
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

-- ──────────────────────────────────────────────────────────────────────────
-- Canonical INFRASTRUCTURE-LEDGER policy for shared.audit_logs (cross-tenant,
-- append-only, system-written). Mirrors applyInfrastructureLedgerRls exactly:
--   - infra_ledger_append : FOR INSERT WITH CHECK (true) — a system / pre-auth
--     / NULL-tenant write always lands.
--   - infra_ledger_read   : FOR SELECT with the system-aware clause — any
--     no-tenant-context connection (and INSERT … RETURNING) reads back the row;
--     a tenant-scoped connection still sees only its own rows.
--   - NO update/delete policy → immutable under FORCE RLS (belt-and-suspenders
--     with the immutability trigger installed below).
-- Drops the legacy tenant_isolation_policy + the auth-only audit_append_system
-- prior so the canonical pair is the sole policy set.
-- ──────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'shared' AND tablename = 'audit_logs') THEN
    DROP POLICY IF EXISTS tenant_isolation_policy ON shared.audit_logs;
    DROP POLICY IF EXISTS audit_append_system ON shared.audit_logs;
    DROP POLICY IF EXISTS infra_ledger_append ON shared.audit_logs;
    DROP POLICY IF EXISTS infra_ledger_read ON shared.audit_logs;
    CREATE POLICY infra_ledger_append ON shared.audit_logs
      FOR INSERT WITH CHECK (true);
    CREATE POLICY infra_ledger_read ON shared.audit_logs
      FOR SELECT USING (
        current_setting('app.bypass_rls', true) = 'on'
        OR NULLIF(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid
      );
  END IF;
END
$$;

-- ──────────────────────────────────────────────────────────────────────────
-- Canonical INFRASTRUCTURE-LEDGER policy for shared.access_logs
-- (ORPHAN-HIGH-367, live-verified 2026-07-12): the gateway's AccessLogMiddleware
-- writes one row per HTTP request for ALL tenants + anonymous (tenantId NULL)
-- requests on a single no-tenant-GUC connection — under tenant_isolation_policy
-- every INSERT failed ("new row violates row-level security policy",
-- ACCESS_LOG_FAILURE in prod gateway logs). Same append-ledger class as
-- shared.audit_logs above; NOTE the per-schema db-migrate hardening pass does
-- NOT cover `shared` (main.ts routes shared here, to platform-bootstrap), so
-- THIS block — not INFRASTRUCTURE_AUDIT_LEDGERS alone — is what heals the live
-- table on each deploy.
-- ──────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'shared' AND tablename = 'access_logs') THEN
    DROP POLICY IF EXISTS tenant_isolation_policy ON shared.access_logs;
    DROP POLICY IF EXISTS infra_ledger_append ON shared.access_logs;
    DROP POLICY IF EXISTS infra_ledger_read ON shared.access_logs;
    CREATE POLICY infra_ledger_append ON shared.access_logs
      FOR INSERT WITH CHECK (true);
    CREATE POLICY infra_ledger_read ON shared.access_logs
      FOR SELECT USING (
        current_setting('app.bypass_rls', true) = 'on'
        OR NULLIF(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid
      );
  END IF;
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
