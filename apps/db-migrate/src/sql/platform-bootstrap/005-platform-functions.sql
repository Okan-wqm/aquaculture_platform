-- ============================================================================
-- Platform Bootstrap — Stage 5 of 7: Platform Trigger / Helper Functions
--
-- Pure, dependency-free PL/pgSQL helpers that every service uses. Installed
-- ONCE per database by the platform-bootstrap atom (Phase 0), BEFORE any
-- per-service baseline migration runs. CREATE OR REPLACE FUNCTION is fully
-- idempotent — every invocation is safe.
--
-- # WHY this lives in platform-bootstrap (not per-service migration)
--
-- Previously these functions were declared inside farm-service's untracked
-- raw-SQL chain (`002_create_base_functions.sql`) in the default search_path
-- — landing in `public` because the chain ran without `pinSearchPath('farm')`.
-- Every service that called them inherited the `public.*` resolution path,
-- but the chain itself never appeared in any service's migration manifest.
-- The result was a shadow contract: 14 services depended on functions that
-- only one service's untracked SQL files created.
--
-- After Faz 1.9 + ADR-031, these helpers live in `public` by design —
-- `GRANT EXECUTE TO PUBLIC` lets every service role resolve them through
-- the standard search_path, and the install is a Phase-0 invariant rather
-- than a buried migration side effect.
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
-- ============================================================================

-- ──────────────────────────────────────────────────────────────────────────
-- Tenant context functions (consumed by RLS predicates platform-wide)
-- ──────────────────────────────────────────────────────────────────────────

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

-- Set the current tenant for the session.
-- Callers MUST use the 2-arg overload (transaction-local) inside request scope.
CREATE OR REPLACE FUNCTION public.set_tenant_id(p_tenant_id uuid)
RETURNS void AS $$
BEGIN
  PERFORM set_config('app.current_tenant', p_tenant_id::text, false);
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION public.set_tenant_id(uuid) IS
  'Sets app.current_tenant session GUC. Use SET LOCAL inside transactions in app code; this wrapper is for psql session use only.';

-- ──────────────────────────────────────────────────────────────────────────
-- Updated_at trigger helper
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION public.update_updated_at_column() IS
  'BEFORE UPDATE trigger helper — stamps NEW.updated_at = NOW(). Attached per-table by baseline migrations.';

-- ──────────────────────────────────────────────────────────────────────────
-- Append-only audit guard — used by 9 per-service audit tables
-- (shared.audit_logs + 8 per-service audit tables).
--
-- Attached as a BEFORE UPDATE / BEFORE DELETE trigger on every audit
-- table to raise an exception if any rewrite or removal is attempted.
-- This is the platform's structural defense against audit tampering.
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.audit_immutability_guard()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Audit table %.% is append-only; %/% refused (row id=%)',
    TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP, TG_WHEN,
    COALESCE(OLD.id::text, '<unknown>')
    USING ERRCODE = 'integrity_constraint_violation',
          HINT = 'Audit rewrites or removals MUST go through GDPR Art 17 erasure cascade with explicit audit trail.';
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION public.audit_immutability_guard() IS
  'BEFORE UPDATE/DELETE trigger helper — refuses any mutation on append-only audit tables. Attached by baseline migrations of every service that owns a protected audit table.';

-- ──────────────────────────────────────────────────────────────────────────
-- GRANT EXECUTE — PUBLIC reaches every present and future *_service role
-- without per-role enumeration.
-- ──────────────────────────────────────────────────────────────────────────
GRANT EXECUTE ON FUNCTION public.current_tenant_id()        TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_tenant_id(uuid)        TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_updated_at_column() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.audit_immutability_guard() TO PUBLIC;

-- ──────────────────────────────────────────────────────────────────────────
-- Verification — every required function must be installed.
-- ──────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  fn_name TEXT;
BEGIN
  FOREACH fn_name IN ARRAY ARRAY[
    'current_tenant_id',
    'set_tenant_id',
    'update_updated_at_column',
    'audit_immutability_guard'
  ]::text[]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON p.pronamespace = n.oid
      WHERE n.nspname = 'public' AND p.proname = fn_name
    ) THEN
      RAISE EXCEPTION '[platform-bootstrap] Platform function public.%() did not install', fn_name;
    END IF;
  END LOOP;
  RAISE NOTICE '[platform-bootstrap] Platform functions verified: current_tenant_id, set_tenant_id, update_updated_at_column, audit_immutability_guard';
END
$$;
