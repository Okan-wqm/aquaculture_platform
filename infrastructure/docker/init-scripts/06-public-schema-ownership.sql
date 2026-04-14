-- ============================================================================
-- 002-public-schema-ownership.sql
--
-- Shared-role ownership for cross-service `public` schema tables so that
-- billing/config/notification services can bootstrap their tenant RLS policies
-- at startup.
--
-- # Problem addressed
--
-- billing-service, config-service, and notification-service bootstrap RLS on
-- the `public` schema via `RlsSchemaBootstrap` (backend-common). The helper
-- runs `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` on every tenant-scoped
-- table in `current_schema()`. These services connect as per-service users
-- (billing_service / gateway_service / notification_service — see
-- `DATABASE_USER` in docker-compose.yml) but the tables were historically
-- created by the `aquaculture` superuser. PostgreSQL requires table
-- ownership (or superuser) to ALTER, so every startup produced:
--
--   rls.bootstrap.failed service="billing" — must be owner of table audit_logs
--
-- and the affected services ran WITHOUT tenant RLS until the next attempt.
--
-- # Architectural choice: group role + membership (not superuser bootstrap)
--
-- Two alternatives were considered and rejected:
--
--   (a) Give each service a second "admin" connection (superuser) used only
--       for RLS bootstrap. — Rejected: superuser credentials sprawling across
--       every service is an unnecessary security exposure for a bootstrap
--       concern.
--
--   (b) Transfer ownership to ONE of the services. — Rejected: `audit_logs`,
--       `gdpr_data_requests`, `user_consents` etc. are deliberately shared
--       cross-service infrastructure (see libs/backend-common/src/audit/
--       audit-log.entity.ts line 23: "Stored in public/shared schema so
--       audit records survive even if a tenant schema is dropped"). Single
--       ownership would break the other writers' ability to ALTER.
--
-- Chosen: a `shared_public_owner` group role owns the tables; the three
-- bootstrap-capable service users are members. PostgreSQL's INHERIT default
-- gives each member role the owner's privileges automatically, so ALTER
-- works without explicit `SET ROLE`. This keeps DDL concerns separated from
-- DML (each service still uses its own user for queries) while allowing
-- shared bootstrap authority.
--
-- # Column-type fix in the same migration
--
-- Three legacy tables had `tenantId`/`tenant_id` declared as `text` or
-- `varchar` while the canonical platform type (and every entity decorator
-- in the repo) is `uuid`. The RLS policy predicate casts the session GUC to
-- `uuid`, so a text-typed column produced:
--
--   rls.bootstrap.failed — operator does not exist: text = uuid
--
-- This was documented and predicted by the entity itself
-- (libs/backend-common/src/audit/audit-log.entity.ts lines 81-100). The
-- ALTER COLUMN TYPE casts to uuid with USING ::uuid, which surfaces any
-- non-UUID residue loudly (correct behaviour — audit rows should only ever
-- contain tenant UUIDs).
--
-- # Idempotency
--
-- Safe to re-run. Role/membership/ownership statements use existence checks
-- or re-assign to the same value when already applied. Column-type ALTERs
-- are no-ops when the column is already `uuid`.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Shared group role (NOLOGIN — membership only, no direct connections)
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shared_public_owner') THEN
    CREATE ROLE shared_public_owner NOLOGIN;
  END IF;
END
$$;

-- ----------------------------------------------------------------------------
-- 2. Grant membership to every service that bootstraps RLS on `public`
--
-- Derived from `RlsModule.forRoot({ autoApply: true })` in each AppModule:
--   - apps/billing-service/src/app.module.ts        → billing_service
--   - apps/config-service/src/app.module.ts         → gateway_service
--   - apps/notification-service/src/app.module.ts   → notification_service
--
-- If a new service bootstraps RLS on public, add a GRANT here.
-- ----------------------------------------------------------------------------
GRANT shared_public_owner TO billing_service;
GRANT shared_public_owner TO gateway_service;
GRANT shared_public_owner TO notification_service;

-- ----------------------------------------------------------------------------
-- 3. Transfer ownership of all tenant-scoped `public` tables
--
-- Discovered via:
--   SELECT table_name FROM information_schema.columns
--   WHERE table_schema='public' AND column_name IN ('tenantId','tenant_id');
--
-- If a new tenant-scoped table lands in `public`, add an ALTER TABLE here.
-- Better long-term: move the table to its owning service's schema.
-- ----------------------------------------------------------------------------
ALTER TABLE IF EXISTS public.audit_logs              OWNER TO shared_public_owner;
ALTER TABLE IF EXISTS public.channel_detection_log   OWNER TO shared_public_owner;
ALTER TABLE IF EXISTS public.device_tokens           OWNER TO shared_public_owner;
ALTER TABLE IF EXISTS public.employees               OWNER TO shared_public_owner;
ALTER TABLE IF EXISTS public.feeder_calibrations     OWNER TO shared_public_owner;
ALTER TABLE IF EXISTS public.gdpr_data_requests      OWNER TO shared_public_owner;
ALTER TABLE IF EXISTS public.marine_observations     OWNER TO shared_public_owner;
ALTER TABLE IF EXISTS public.notification_logs       OWNER TO shared_public_owner;
ALTER TABLE IF EXISTS public.sensor_type_definitions OWNER TO shared_public_owner;
ALTER TABLE IF EXISTS public.tenant_roles            OWNER TO shared_public_owner;
ALTER TABLE IF EXISTS public.user_consents           OWNER TO shared_public_owner;
ALTER TABLE IF EXISTS public.user_permissions        OWNER TO shared_public_owner;
ALTER TABLE IF EXISTS public.weather_observations    OWNER TO shared_public_owner;
ALTER TABLE IF EXISTS public.weather_settings        OWNER TO shared_public_owner;

-- ----------------------------------------------------------------------------
-- 4. Fix tenant_id / tenantId column-type drift (text/varchar → uuid)
--
-- The USING clause casts existing values; fails loudly on any non-UUID row,
-- which is the correct signal for data corruption (per entity docblock).
-- Idempotent: a no-op when already uuid (PostgreSQL skips the rewrite).
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='audit_logs'
      AND column_name='tenantId' AND data_type <> 'uuid'
  ) THEN
    ALTER TABLE public.audit_logs
      ALTER COLUMN "tenantId" TYPE uuid USING "tenantId"::uuid;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='employees'
      AND column_name='tenantId' AND data_type <> 'uuid'
  ) THEN
    ALTER TABLE public.employees
      ALTER COLUMN "tenantId" TYPE uuid USING "tenantId"::uuid;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='notification_logs'
      AND column_name='tenant_id' AND data_type <> 'uuid'
  ) THEN
    ALTER TABLE public.notification_logs
      ALTER COLUMN tenant_id TYPE uuid USING tenant_id::uuid;
  END IF;
END
$$;
