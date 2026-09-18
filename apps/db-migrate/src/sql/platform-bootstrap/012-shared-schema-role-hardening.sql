-- SEC-MEDIUM-110 (2026-08-23 scan №55): replace the shared-schema PUBLIC
-- grants with explicit shared_schema_owner grants on EXISTING deployments.
--
-- The 006 bootstrap atom already carries the corrected grants for FRESH
-- deployments; this atom heals clusters bootstrapped before the fix, where
-- `GRANT ... TO PUBLIC` on the shared audit/GDPR/consent tables hands DML to
-- ANY login the cluster ever grows — the membership list of
-- shared_schema_owner (enumerated in 006) is the complete consumer set.
--
-- REVOKE ... FROM PUBLIC is safe with PUBLIC bridges: the explicit
-- shared_schema_owner grants below restore every legitimate consumer's DML
-- before the revoke runs. The audit immutability triggers (005) are
-- unaffected — they fire on row mutations regardless of the granting role.

DO $block$
BEGIN
  -- Re-grant to the legitimate consumer set FIRST (idempotent).
  GRANT USAGE ON SCHEMA shared TO shared_schema_owner;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA shared TO shared_schema_owner;
  ALTER DEFAULT PRIVILEGES IN SCHEMA shared
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO shared_schema_owner;

  -- Then close the PUBLIC hole.
  REVOKE ALL ON ALL TABLES IN SCHEMA shared FROM PUBLIC;
  REVOKE USAGE ON SCHEMA shared FROM PUBLIC;
  ALTER DEFAULT PRIVILEGES IN SCHEMA shared
    REVOKE ALL ON TABLES FROM PUBLIC;
END
$block$;
