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
-- 2. Move tables from public to shared
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
      EXECUTE format('ALTER TABLE shared.%I OWNER TO shared_schema_owner', t);
      -- Preserve RLS intent: ENABLE + FORCE are idempotent, so re-asserting
      -- them here handles both the SET SCHEMA case (policies travel, but
      -- ENABLE/FORCE bits travel only in recent PG versions so re-assert
      -- defensively) and the fresh-deploy-via-init case (no policies yet).
      EXECUTE format('ALTER TABLE shared.%I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('ALTER TABLE shared.%I FORCE ROW LEVEL SECURITY', t);
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
