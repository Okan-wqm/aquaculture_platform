-- ============================================================================
-- Platform-level Trigger / Helper Functions
-- ============================================================================
--
-- Pure, dependency-free PL/pgSQL helpers that every service uses. Installed
-- ONCE per database by the superuser at bootstrap time (init-script phase),
-- BEFORE any per-service baseline migration runs.
--
-- # WHY this lives outside per-service migrations
--
-- Previously these functions were declared inside farm-service's untracked
-- raw-SQL chain (`002_create_base_functions.sql`) in the default search_path
-- — landing in `public` because the chain ran without `pinSearchPath('farm')`.
-- Every service that called them inherited the `public.*` resolution path,
-- but the chain itself never appeared in any service's migration manifest.
-- The result was a shadow contract: 14 services depended on functions that
-- only one service's untracked SQL files created.
--
-- After Faz 1.9 of the day-one baseline reset (this file), these helpers
-- live in `public` by design — `GRANT EXECUTE TO PUBLIC` lets every service
-- role resolve them through the standard search_path, and the install
-- becomes an init-script-time invariant rather than a buried migration
-- side effect.
--
-- # WHAT this file does NOT contain
--
-- Table-dependent functions stay in the owning service's baseline migration:
--   - `audit_trigger_func` — depends on `audit_logs` (per-service schema)
--   - `soft_delete_func`   — uses TG_TABLE_SCHEMA / TG_TABLE_NAME dynamic refs
--                            (per-service responsibility)
--   - `generate_entity_code` — depends on `code_sequences` (farm-service)
--
-- The boundary rule: a function with no table reference in its body is
-- platform-level; everything else is service-level.
--
-- # ORDER OF EXECUTION
--
-- Postgres Docker init runs scripts in lexicographic order:
--   00-init-schemas.sh   — extensions + roles + per-service schemas + grants
--   01-init-databases.sql — additional database setup
--   05-platform-functions.sql — THIS FILE
--   09-hr-outbox.sql     — hr-service-specific bootstrap
--   10-shared-schema.sql — shared schema population
--
-- Baseline migrations (run by aqua-db-migrate after init scripts complete)
-- can safely reference these functions immediately on first call.
-- ============================================================================

\connect aquaculture

-- ============================================================================
-- TENANT CONTEXT FUNCTIONS
-- ============================================================================

-- Get current tenant from session-level GUC.
-- Returns NULL on any failure (no tenant set, malformed UUID, missing GUC).
CREATE OR REPLACE FUNCTION public.current_tenant_id()
RETURNS uuid AS $$
BEGIN
  RETURN NULLIF(current_setting('app.current_tenant', true), '')::uuid;
EXCEPTION
  WHEN OTHERS THEN
    RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION public.current_tenant_id() IS
  'Reads app.current_tenant session GUC, returns NULL on missing/invalid UUID. Used by RLS predicates platform-wide.';

-- Set the current tenant for the session (or transaction with PERFORM set_config + true LOCAL).
-- Callers MUST use the 2-arg overload (transaction-local) inside request scope.
CREATE OR REPLACE FUNCTION public.set_tenant_id(p_tenant_id uuid)
RETURNS void AS $$
BEGIN
  PERFORM set_config('app.current_tenant', p_tenant_id::text, false);
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION public.set_tenant_id(uuid) IS
  'Sets app.current_tenant session GUC. Use SET LOCAL inside transactions in app code; this wrapper is for psql session use only.';

-- ============================================================================
-- UPDATED_AT TRIGGER FUNCTION
-- ============================================================================

-- Auto-update updated_at timestamp on every UPDATE.
-- Attach as: CREATE TRIGGER ... BEFORE UPDATE ... EXECUTE FUNCTION public.update_updated_at_column();
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION public.update_updated_at_column() IS
  'BEFORE UPDATE trigger helper — stamps NEW.updated_at = NOW(). Attached per-table by baseline migrations.';

-- ============================================================================
-- GRANT EXECUTE to all service roles
-- ============================================================================
-- PUBLIC role pseudo-grant covers every current and future *_service role
-- (auth_service, farm_service, sensor_service, hr_service, billing_service,
-- messaging_service, admin_service, etc.) without per-role enumeration.

GRANT EXECUTE ON FUNCTION public.current_tenant_id()            TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_tenant_id(uuid)            TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_updated_at_column()     TO PUBLIC;

-- ============================================================================
-- POST-INSTALL VERIFICATION
-- ============================================================================
DO $$
DECLARE
    fn_name TEXT;
BEGIN
    FOREACH fn_name IN ARRAY ARRAY['current_tenant_id','set_tenant_id','update_updated_at_column']::text[]
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_proc p
            JOIN pg_namespace n ON p.pronamespace = n.oid
            WHERE n.nspname = 'public' AND p.proname = fn_name
        ) THEN
            RAISE EXCEPTION 'Platform function public.%() did not install — baseline migrations will fail', fn_name;
        END IF;
    END LOOP;
    RAISE NOTICE 'Platform functions installed: current_tenant_id, set_tenant_id, update_updated_at_column';
END
$$;
