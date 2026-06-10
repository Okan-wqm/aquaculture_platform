-- ============================================================================
-- Platform Bootstrap — Stage 3 of 9: Service Schemas
--
-- Idempotent CREATE SCHEMA for every per-service schema + the `shared` schema
-- and the `gateway` reserved schema. Owner assignment uses AUTHORIZATION at
-- create time and ALTER SCHEMA ... OWNER TO at every run to make the ownership
-- contract restart-survive.
--
-- Previously lived in 00-init-schemas.sh — that script only ran on initdb,
-- which made the contract fragile to DROP SCHEMA + container restart.
--
-- ORDER: roles MUST be created before this file runs (stage 002). The
-- platform-bootstrap.service.ts orchestrator enforces this.
--
-- Schema → role authority map (SSoT mirrored from
-- apps/db-migrate/src/schema-registry.ts):
-- ============================================================================

-- Per-service schemas owned by their *_service role
CREATE SCHEMA IF NOT EXISTS auth          AUTHORIZATION auth_service;
CREATE SCHEMA IF NOT EXISTS farm          AUTHORIZATION farm_service;
CREATE SCHEMA IF NOT EXISTS sensor        AUTHORIZATION sensor_service;
CREATE SCHEMA IF NOT EXISTS hr            AUTHORIZATION hr_service;
CREATE SCHEMA IF NOT EXISTS messaging     AUTHORIZATION messaging_service;
CREATE SCHEMA IF NOT EXISTS hydroponics   AUTHORIZATION hydroponics_service;
CREATE SCHEMA IF NOT EXISTS alert         AUTHORIZATION alert_service;
CREATE SCHEMA IF NOT EXISTS billing       AUTHORIZATION billing_service;
CREATE SCHEMA IF NOT EXISTS notification  AUTHORIZATION notification_service;
CREATE SCHEMA IF NOT EXISTS ai            AUTHORIZATION ai_service;
CREATE SCHEMA IF NOT EXISTS admin         AUTHORIZATION admin_service;
CREATE SCHEMA IF NOT EXISTS observability AUTHORIZATION observability_service;
CREATE SCHEMA IF NOT EXISTS event_store   AUTHORIZATION event_store_service;
CREATE SCHEMA IF NOT EXISTS config        AUTHORIZATION config_service;
CREATE SCHEMA IF NOT EXISTS gateway       AUTHORIZATION gateway_service;
CREATE SCHEMA IF NOT EXISTS compliance;

-- Idempotent ownership fix — re-asserts owner on each run, in case the
-- schema already existed (IF NOT EXISTS skips AUTHORIZATION) or was
-- created by a different role at some point in history.
ALTER SCHEMA auth          OWNER TO auth_service;
ALTER SCHEMA farm          OWNER TO farm_service;
ALTER SCHEMA sensor        OWNER TO sensor_service;
ALTER SCHEMA hr            OWNER TO hr_service;
ALTER SCHEMA messaging     OWNER TO messaging_service;
ALTER SCHEMA hydroponics   OWNER TO hydroponics_service;
ALTER SCHEMA alert         OWNER TO alert_service;
ALTER SCHEMA billing       OWNER TO billing_service;
ALTER SCHEMA notification  OWNER TO notification_service;
ALTER SCHEMA ai            OWNER TO ai_service;
ALTER SCHEMA admin         OWNER TO admin_service;
ALTER SCHEMA observability OWNER TO observability_service;
ALTER SCHEMA event_store   OWNER TO event_store_service;
ALTER SCHEMA config        OWNER TO config_service;
ALTER SCHEMA gateway       OWNER TO gateway_service;

-- The `shared` schema is the cross-tenant, cross-service write surface.
-- Owned by the cluster superuser; per-service write grants come from
-- ALTER DEFAULT PRIVILEGES in stage 004.
-- Source-of-truth for shared schema table set: SHARED_SCHEMA_TABLES
-- (libs/backend-common/src/constants/protected-tables.ts).
DO $$
DECLARE
  superuser TEXT := current_user;
BEGIN
  EXECUTE format('CREATE SCHEMA IF NOT EXISTS shared AUTHORIZATION %I', superuser);
  EXECUTE format('ALTER SCHEMA shared OWNER TO %I', superuser);
END
$$;

-- Verification — every required schema must exist.
DO $$
DECLARE
  required_schema TEXT;
  required_schemas TEXT[] := ARRAY[
    'auth','farm','sensor','hr','messaging','hydroponics','alert',
    'billing','notification','ai','admin','observability','event_store',
    'config','gateway','shared','compliance'
  ];
BEGIN
  FOREACH required_schema IN ARRAY required_schemas
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = required_schema) THEN
      RAISE EXCEPTION '[platform-bootstrap] Required schema % MISSING after CREATE attempt', required_schema;
    END IF;
  END LOOP;
  RAISE NOTICE '[platform-bootstrap] All 17 platform schemas verified';
END
$$;
