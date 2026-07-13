-- ============================================================================
-- Platform Bootstrap — Stage 4 of 7: Schema GRANTs + ALTER DEFAULT PRIVILEGES
--
-- Every GRANT statement here is idempotent: GRANT is a SET operation in
-- PostgreSQL — re-issuing it has no error and no net effect when the
-- privilege already exists. This file therefore runs cleanly on every
-- aqua-db-migrate invocation regardless of prior state.
--
-- Verbatim translation of the per-service grant block previously inside
-- infrastructure/docker/init-scripts/00-init-schemas.sh (lines 239-511).
-- The POSTGRES_USER placeholder is replaced at runtime by
-- platform-bootstrap.service.ts before this SQL is executed.
--
-- Privilege model:
--   - POSTGRES_USER gets USAGE plus DML/sequence-use access only. It is not
--     granted schema ownership or broad ALL PRIVILEGES in this stage.
--   - Each *_service role gets USAGE plus DML/sequence-use access only.
--   - admin_service additionally gets SELECT on auth + billing for the
--     analytics surface.
--   - Every *_service role gets USAGE on `shared` + ALTER DEFAULT
--     PRIVILEGES so future tables there are writable.
--   - notification_service + hydroponics_service get USAGE on `public`
--     (legacy ownership pre-Wave 4-A.2; tracked for cleanup).
-- ============================================================================

-- ──────────────────────────────────────────────────────────────────────────
-- Stage 4 pre-check (Tier-3 Make-Detectable, ADR-031 follow-up).
--
-- A bare `GRANT … TO <role>` whose role does not exist surfaces in postgres
-- logs as a single-line `role "<x>" does not exist` — an opaque mid-file
-- failure that leaves the operator guessing whether Stage 002 (role
-- create) actually completed. The pre-check below short-circuits that
-- failure mode with a structured diagnostic that names the missing role
-- AND points at the upstream stage to investigate.
--
-- Wrapping every individual GRANT in EXECUTE … EXCEPTION WHEN
-- undefined_object is not viable here: plpgsql does not accept bare DDL
-- statements outside EXECUTE, and EXECUTE-wrapping 200+ statements would
-- double the file size while losing the SQL-level audit shape that
-- IEC 62443 / ADR-011 reviewers expect from this stage.
-- ──────────────────────────────────────────────────────────────────────────
DO $platform_bootstrap_stage_004_precheck$
DECLARE
  missing_role text;
  expected_roles text[] := ARRAY[
    'auth_service',
    'farm_service',
    'sensor_service',
    'hr_service',
    'messaging_service',
    'hydroponics_service',
    'alert_service',
    'billing_service',
    'notification_service',
    'ai_service',
    'admin_service',
    'observability_service',
    'event_store_service',
    'config_service',
    'gateway_service'
  ];
BEGIN
  SELECT r INTO missing_role
  FROM unnest(expected_roles) AS t(r)
  WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = t.r)
  LIMIT 1;

  IF missing_role IS NOT NULL THEN
    RAISE EXCEPTION
      'Stage 004 abort: service role "%" does not exist. Stage 002 (role create) failed upstream — inspect aqua-db-migrate logs for the "Stage 002: roles" structured log block, and verify the corresponding *_SERVICE_DB_PASS env var is provisioned in /var/aqua-saas/.env.',
      missing_role;
  END IF;
END
$platform_bootstrap_stage_004_precheck$;

-- ──────────────────────────────────────────────────────────────────────────
-- Shared POSTGRES_USER access. This is intentionally DML-only; migration DDL
-- authority is asserted by db_migrate/schema owner roles in hardening stages.
-- ──────────────────────────────────────────────────────────────────────────
GRANT USAGE ON SCHEMA auth          TO ${POSTGRES_USER};
GRANT USAGE ON SCHEMA farm          TO ${POSTGRES_USER};
GRANT USAGE ON SCHEMA sensor        TO ${POSTGRES_USER};
GRANT USAGE ON SCHEMA hr            TO ${POSTGRES_USER};
GRANT USAGE ON SCHEMA messaging     TO ${POSTGRES_USER};
GRANT USAGE ON SCHEMA hydroponics   TO ${POSTGRES_USER};
GRANT USAGE ON SCHEMA alert         TO ${POSTGRES_USER};
GRANT USAGE ON SCHEMA billing       TO ${POSTGRES_USER};
GRANT USAGE ON SCHEMA notification  TO ${POSTGRES_USER};
GRANT USAGE ON SCHEMA ai            TO ${POSTGRES_USER};
GRANT USAGE ON SCHEMA admin         TO ${POSTGRES_USER};
GRANT USAGE ON SCHEMA observability TO ${POSTGRES_USER};
GRANT USAGE ON SCHEMA event_store   TO ${POSTGRES_USER};
GRANT USAGE ON SCHEMA config        TO ${POSTGRES_USER};

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA auth          TO ${POSTGRES_USER};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA farm          TO ${POSTGRES_USER};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA sensor        TO ${POSTGRES_USER};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA hr            TO ${POSTGRES_USER};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA messaging     TO ${POSTGRES_USER};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA hydroponics   TO ${POSTGRES_USER};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA alert         TO ${POSTGRES_USER};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA billing       TO ${POSTGRES_USER};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA notification  TO ${POSTGRES_USER};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ai            TO ${POSTGRES_USER};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA admin         TO ${POSTGRES_USER};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA observability TO ${POSTGRES_USER};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA event_store   TO ${POSTGRES_USER};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA config        TO ${POSTGRES_USER};

GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA auth          TO ${POSTGRES_USER};
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA farm          TO ${POSTGRES_USER};
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA sensor        TO ${POSTGRES_USER};
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA hr            TO ${POSTGRES_USER};
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA messaging     TO ${POSTGRES_USER};
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA hydroponics   TO ${POSTGRES_USER};
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA alert         TO ${POSTGRES_USER};
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA billing       TO ${POSTGRES_USER};
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA notification  TO ${POSTGRES_USER};
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ai            TO ${POSTGRES_USER};
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA admin         TO ${POSTGRES_USER};
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA observability TO ${POSTGRES_USER};
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA event_store   TO ${POSTGRES_USER};
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA config        TO ${POSTGRES_USER};

ALTER DEFAULT PRIVILEGES IN SCHEMA auth          GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${POSTGRES_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA farm          GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${POSTGRES_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA sensor        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${POSTGRES_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA hr            GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${POSTGRES_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA messaging     GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${POSTGRES_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA hydroponics   GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${POSTGRES_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA alert         GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${POSTGRES_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA billing       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${POSTGRES_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA notification  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${POSTGRES_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA ai            GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${POSTGRES_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA admin         GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${POSTGRES_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA observability GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${POSTGRES_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA event_store   GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${POSTGRES_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA config        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${POSTGRES_USER};

ALTER DEFAULT PRIVILEGES IN SCHEMA auth          GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${POSTGRES_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA farm          GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${POSTGRES_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA sensor        GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${POSTGRES_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA hr            GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${POSTGRES_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA messaging     GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${POSTGRES_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA hydroponics   GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${POSTGRES_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA alert         GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${POSTGRES_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA billing       GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${POSTGRES_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA notification  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${POSTGRES_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA ai            GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${POSTGRES_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA admin         GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${POSTGRES_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA observability GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${POSTGRES_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA event_store   GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${POSTGRES_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA config        GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${POSTGRES_USER};

-- ──────────────────────────────────────────────────────────────────────────
-- Shared schema grants — cross-service write surface (ADR-011).
-- 4 SHARED_SCHEMA_TABLES: audit_logs, gdpr_data_requests, user_consents,
-- access_logs (created in stage 006).
-- Per-table GRANTs intentionally absent here — ALTER DEFAULT PRIVILEGES
-- below covers future tables (no ordering hazard with stage 006).
-- ──────────────────────────────────────────────────────────────────────────
GRANT USAGE ON SCHEMA shared TO auth_service;
GRANT USAGE ON SCHEMA shared TO farm_service;
GRANT USAGE ON SCHEMA shared TO sensor_service;
GRANT USAGE ON SCHEMA shared TO hr_service;
GRANT USAGE ON SCHEMA shared TO messaging_service;
GRANT USAGE ON SCHEMA shared TO hydroponics_service;
GRANT USAGE ON SCHEMA shared TO alert_service;
GRANT USAGE ON SCHEMA shared TO billing_service;
GRANT USAGE ON SCHEMA shared TO notification_service;
GRANT USAGE ON SCHEMA shared TO ai_service;
GRANT USAGE ON SCHEMA shared TO admin_service;
GRANT USAGE ON SCHEMA shared TO observability_service;
GRANT USAGE ON SCHEMA shared TO event_store_service;
GRANT USAGE ON SCHEMA shared TO config_service;

ALTER DEFAULT PRIVILEGES IN SCHEMA shared GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO auth_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA shared GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO farm_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA shared GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sensor_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA shared GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hr_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA shared GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO messaging_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA shared GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hydroponics_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA shared GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO alert_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA shared GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO billing_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA shared GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO notification_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA shared GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ai_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA shared GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO admin_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA shared GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO observability_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA shared GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO event_store_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA shared GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO config_service;

ALTER DEFAULT PRIVILEGES IN SCHEMA shared GRANT USAGE, SELECT ON SEQUENCES TO auth_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA shared GRANT USAGE, SELECT ON SEQUENCES TO farm_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA shared GRANT USAGE, SELECT ON SEQUENCES TO sensor_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA shared GRANT USAGE, SELECT ON SEQUENCES TO hr_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA shared GRANT USAGE, SELECT ON SEQUENCES TO messaging_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA shared GRANT USAGE, SELECT ON SEQUENCES TO hydroponics_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA shared GRANT USAGE, SELECT ON SEQUENCES TO alert_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA shared GRANT USAGE, SELECT ON SEQUENCES TO billing_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA shared GRANT USAGE, SELECT ON SEQUENCES TO notification_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA shared GRANT USAGE, SELECT ON SEQUENCES TO ai_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA shared GRANT USAGE, SELECT ON SEQUENCES TO admin_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA shared GRANT USAGE, SELECT ON SEQUENCES TO observability_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA shared GRANT USAGE, SELECT ON SEQUENCES TO event_store_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA shared GRANT USAGE, SELECT ON SEQUENCES TO config_service;

-- ──────────────────────────────────────────────────────────────────────────
-- Compliance schema grants (INFRA-HIGH-015)
--
-- `compliance` is a cross-service schema in the same class as `shared`:
-- it carries the platform-wide legal-hold registry
-- (compliance.legal_holds — DDL owned by the admin-api migration chain)
-- consulted by destructive flows across services (messaging,
-- observability, admin today). Stage 003 has always created the schema,
-- but no stage ever granted access — the 2026-06-11 production opening
-- surfaced it as the last schema running on unowned manual ceremony
-- grants (admin-api drift validator fatal at boot). Same grant shape as
-- `shared` above; the least-privilege boundary lands in stage 008.
-- ──────────────────────────────────────────────────────────────────────────
GRANT USAGE ON SCHEMA compliance TO auth_service;
GRANT USAGE ON SCHEMA compliance TO farm_service;
GRANT USAGE ON SCHEMA compliance TO sensor_service;
GRANT USAGE ON SCHEMA compliance TO hr_service;
GRANT USAGE ON SCHEMA compliance TO messaging_service;
GRANT USAGE ON SCHEMA compliance TO hydroponics_service;
GRANT USAGE ON SCHEMA compliance TO alert_service;
GRANT USAGE ON SCHEMA compliance TO billing_service;
GRANT USAGE ON SCHEMA compliance TO notification_service;
GRANT USAGE ON SCHEMA compliance TO ai_service;
GRANT USAGE ON SCHEMA compliance TO admin_service;
GRANT USAGE ON SCHEMA compliance TO observability_service;
GRANT USAGE ON SCHEMA compliance TO event_store_service;
GRANT USAGE ON SCHEMA compliance TO config_service;

ALTER DEFAULT PRIVILEGES IN SCHEMA compliance GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO auth_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA compliance GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO farm_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA compliance GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sensor_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA compliance GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hr_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA compliance GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO messaging_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA compliance GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hydroponics_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA compliance GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO alert_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA compliance GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO billing_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA compliance GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO notification_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA compliance GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ai_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA compliance GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO admin_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA compliance GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO observability_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA compliance GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO event_store_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA compliance GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO config_service;

ALTER DEFAULT PRIVILEGES IN SCHEMA compliance GRANT USAGE, SELECT ON SEQUENCES TO auth_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA compliance GRANT USAGE, SELECT ON SEQUENCES TO farm_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA compliance GRANT USAGE, SELECT ON SEQUENCES TO sensor_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA compliance GRANT USAGE, SELECT ON SEQUENCES TO hr_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA compliance GRANT USAGE, SELECT ON SEQUENCES TO messaging_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA compliance GRANT USAGE, SELECT ON SEQUENCES TO hydroponics_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA compliance GRANT USAGE, SELECT ON SEQUENCES TO alert_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA compliance GRANT USAGE, SELECT ON SEQUENCES TO billing_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA compliance GRANT USAGE, SELECT ON SEQUENCES TO notification_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA compliance GRANT USAGE, SELECT ON SEQUENCES TO ai_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA compliance GRANT USAGE, SELECT ON SEQUENCES TO admin_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA compliance GRANT USAGE, SELECT ON SEQUENCES TO observability_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA compliance GRANT USAGE, SELECT ON SEQUENCES TO event_store_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA compliance GRANT USAGE, SELECT ON SEQUENCES TO config_service;

-- ──────────────────────────────────────────────────────────────────────────
-- Gateway schema grants
-- ──────────────────────────────────────────────────────────────────────────
GRANT USAGE ON SCHEMA gateway TO ${POSTGRES_USER};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA gateway TO ${POSTGRES_USER};
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA gateway TO ${POSTGRES_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA gateway GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${POSTGRES_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA gateway GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${POSTGRES_USER};

-- ──────────────────────────────────────────────────────────────────────────
-- Cross-schema read access — admin-api-service analytics on auth + billing.
-- ──────────────────────────────────────────────────────────────────────────
GRANT SELECT ON ALL TABLES IN SCHEMA auth    TO ${POSTGRES_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA auth    GRANT SELECT ON TABLES TO ${POSTGRES_USER};
GRANT SELECT ON ALL TABLES IN SCHEMA billing TO ${POSTGRES_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA billing GRANT SELECT ON TABLES TO ${POSTGRES_USER};

-- ──────────────────────────────────────────────────────────────────────────
-- Per-service self-schema grants
-- ──────────────────────────────────────────────────────────────────────────
GRANT USAGE                 ON SCHEMA auth          TO auth_service;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA auth          TO auth_service;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA auth       TO auth_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA auth          GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES    TO auth_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA auth          GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO auth_service;

GRANT USAGE                 ON SCHEMA farm          TO farm_service;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA farm          TO farm_service;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA farm       TO farm_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA farm          GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES    TO farm_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA farm          GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO farm_service;

GRANT USAGE                 ON SCHEMA sensor        TO sensor_service;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA sensor        TO sensor_service;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA sensor     TO sensor_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA sensor        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES    TO sensor_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA sensor        GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO sensor_service;

GRANT USAGE                 ON SCHEMA billing       TO billing_service;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA billing       TO billing_service;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA billing    TO billing_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA billing       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES    TO billing_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA billing       GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO billing_service;

GRANT USAGE                 ON SCHEMA hr            TO hr_service;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA hr            TO hr_service;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA hr         TO hr_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA hr            GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES    TO hr_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA hr            GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO hr_service;

GRANT USAGE                 ON SCHEMA alert         TO alert_service;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA alert         TO alert_service;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA alert      TO alert_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA alert         GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES    TO alert_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA alert         GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO alert_service;

GRANT USAGE                 ON SCHEMA admin         TO admin_service;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA admin         TO admin_service;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA admin      TO admin_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA admin         GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES    TO admin_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA admin         GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO admin_service;

-- admin_service cross-read for analytics (auth.users, billing.subscriptions)
GRANT USAGE  ON SCHEMA auth    TO admin_service;
GRANT SELECT ON ALL TABLES IN SCHEMA auth    TO admin_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA auth    GRANT SELECT ON TABLES TO admin_service;
GRANT USAGE  ON SCHEMA billing TO admin_service;
GRANT SELECT ON ALL TABLES IN SCHEMA billing TO admin_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA billing GRANT SELECT ON TABLES TO admin_service;

GRANT USAGE                 ON SCHEMA gateway       TO gateway_service;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA gateway       TO gateway_service;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA gateway    TO gateway_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA gateway       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES    TO gateway_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA gateway       GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO gateway_service;

GRANT USAGE                 ON SCHEMA notification  TO notification_service;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA notification  TO notification_service;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA notification TO notification_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA notification  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES    TO notification_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA notification  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO notification_service;
-- Legacy public-schema cross-grant (notification_service tables landed there
-- pre-Wave 4-A.2). Retained for backwards-compat — tracked for cleanup.
GRANT USAGE ON SCHEMA public TO notification_service;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO notification_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO notification_service;

GRANT USAGE                 ON SCHEMA hydroponics   TO hydroponics_service;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA hydroponics   TO hydroponics_service;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA hydroponics TO hydroponics_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA hydroponics   GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES    TO hydroponics_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA hydroponics   GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO hydroponics_service;
GRANT CREATE ON DATABASE ${POSTGRES_DB} TO hydroponics_service;
GRANT USAGE  ON SCHEMA public TO hydroponics_service;

GRANT USAGE                 ON SCHEMA ai            TO ai_service;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ai            TO ai_service;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ai         TO ai_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA ai            GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES    TO ai_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA ai            GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ai_service;

GRANT USAGE                 ON SCHEMA messaging     TO messaging_service;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA messaging     TO messaging_service;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA messaging  TO messaging_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA messaging     GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES    TO messaging_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA messaging     GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO messaging_service;
-- messaging_service needs CREATE on database for per-tenant schema creation
-- (CREATE SCHEMA tenant_<uuid> at TenantCreated event)
GRANT CREATE ON DATABASE ${POSTGRES_DB} TO messaging_service;

-- farm_service, sensor_service, hr_service, hydroponics_service, ai_service,
-- alert_service all need CREATE on database for the same per-tenant fan-out
-- (TenantSchemaSyncService). Added here so the privilege model is uniform
-- across every tenant-scoped service — prior gap was a hidden source of
-- "permission denied for database aquaculture" failures during tenant create.
GRANT CREATE ON DATABASE ${POSTGRES_DB} TO farm_service;
GRANT CREATE ON DATABASE ${POSTGRES_DB} TO sensor_service;
GRANT CREATE ON DATABASE ${POSTGRES_DB} TO hr_service;
GRANT CREATE ON DATABASE ${POSTGRES_DB} TO ai_service;
GRANT CREATE ON DATABASE ${POSTGRES_DB} TO alert_service;

GRANT USAGE                 ON SCHEMA config        TO config_service;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA config        TO config_service;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA config     TO config_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA config        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES    TO config_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA config        GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO config_service;

GRANT USAGE                 ON SCHEMA observability TO observability_service;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA observability TO observability_service;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA observability TO observability_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA observability GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES    TO observability_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA observability GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO observability_service;

GRANT USAGE                 ON SCHEMA event_store   TO event_store_service;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA event_store   TO event_store_service;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA event_store TO event_store_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA event_store   GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES    TO event_store_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA event_store   GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO event_store_service;
