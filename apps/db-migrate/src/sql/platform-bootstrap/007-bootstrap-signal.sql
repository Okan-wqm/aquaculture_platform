-- ============================================================================
-- Platform Bootstrap — Stage 7 of 7: Bootstrap signal table
--
-- Persistent record of every successful platform-bootstrap run. Services
-- read this table at boot via SchemaVersionGate.assertPlatformBootstrapComplete()
-- — if the row is missing OR the schema_count diverges from the registry,
-- the service refuses to start.
--
-- # WHY this exists
--
-- Postgres docker-entrypoint init-scripts ran ONCE on initdb. There was no
-- structural way for an app service to learn whether the platform DDL
-- contract (schemas, extensions, roles, functions, shared tables) had been
-- (re-)applied after a DROP SCHEMA + restart cycle. Services booted and
-- crashed on the first query against a missing schema, dragging the entire
-- deploy through a partial-up state.
--
-- The bootstrap_signal row turns a tacit precondition into a load-bearing
-- assertion. ADR-031 Tier 1 ("make it impossible"): an app service cannot
-- proceed past the gate without observing this signal.
-- ============================================================================

-- The signal table lives in the `platform` schema — created here on demand,
-- owned by the cluster superuser. Single-row table (PK is a constant) so
-- INSERT ON CONFLICT DO UPDATE rewrites the same row every run.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'platform') THEN
    CREATE SCHEMA platform;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS platform.bootstrap_signal (
  id                INTEGER     PRIMARY KEY CHECK (id = 1),
  -- ISO-8601 timestamp of last successful bootstrap run.
  last_run_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- How many schemas the bootstrap targets right now (declarative SSoT).
  -- Service-side gate compares this to its own expectation.
  schema_count      INTEGER     NOT NULL,
  -- How many platform functions the bootstrap installed.
  function_count    INTEGER     NOT NULL,
  -- How many shared-schema tables (SHARED_SCHEMA_TABLES) installed.
  shared_table_count INTEGER    NOT NULL,
  -- Git ref / image tag of the aqua-db-migrate binary that ran. NULL
  -- when not provided.
  bootstrap_version VARCHAR(120),
  -- Always 1 (the only row).
  CONSTRAINT bootstrap_signal_singleton UNIQUE (id)
);

-- Grant read access so every service role can probe the signal.
GRANT USAGE ON SCHEMA platform TO PUBLIC;
GRANT SELECT ON platform.bootstrap_signal TO PUBLIC;

COMMENT ON TABLE platform.bootstrap_signal IS
  'Single-row record of last successful aqua-db-migrate Phase 0 run. Services gate boot on its presence + schema_count match. ADR-031.';
