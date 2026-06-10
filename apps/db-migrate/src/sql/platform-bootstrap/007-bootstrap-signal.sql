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

CREATE TABLE IF NOT EXISTS platform.release_ledger (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  release_id            VARCHAR(120) NOT NULL,
  git_sha               VARCHAR(80)  NOT NULL,
  db_migrate_image      TEXT,
  migration_manifest_hash TEXT,
  expected_heads        JSONB        NOT NULL DEFAULT '{}'::jsonb,
  applied_heads         JSONB        NOT NULL DEFAULT '{}'::jsonb,
  tenant_schema_set     JSONB        NOT NULL DEFAULT '[]'::jsonb,
  tenant_fanout         JSONB        NOT NULL DEFAULT '{}'::jsonb,
  image_digests         JSONB        NOT NULL DEFAULT '{}'::jsonb,
  deploy_metadata       JSONB        NOT NULL DEFAULT '{}'::jsonb,
  rollback_manifest_sha256 TEXT,
  schema_may_be_forward BOOLEAN      NOT NULL DEFAULT false,
  rollback_skipped_reason TEXT,
  status                VARCHAR(40)  NOT NULL,
  failure_phase         VARCHAR(120),
  rollback_attempted    BOOLEAN      NOT NULL DEFAULT false,
  rollback_verified     BOOLEAN      NOT NULL DEFAULT false,
  rollback_failed       BOOLEAN      NOT NULL DEFAULT false,
  operator              VARCHAR(120),
  started_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  completed_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT release_ledger_status_chk CHECK (
    status IN (
      'prepared',
      'migrating',
      'db_complete',
      'apps_restarting',
      'promoted',
      'failed',
      'rollback_attempted',
      'rollback_verified',
      'rollback_failed',
      'rolled_back'
    )
  )
);

ALTER TABLE platform.release_ledger
  ADD COLUMN IF NOT EXISTS applied_heads JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS tenant_schema_set JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS tenant_fanout JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS deploy_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS rollback_manifest_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS schema_may_be_forward BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS rollback_skipped_reason TEXT,
  ADD COLUMN IF NOT EXISTS rollback_attempted BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS rollback_verified BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS rollback_failed BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE platform.release_ledger
  DROP CONSTRAINT IF EXISTS release_ledger_status_chk;

ALTER TABLE platform.release_ledger
  ADD CONSTRAINT release_ledger_status_chk CHECK (
    status IN (
      'prepared',
      'migrating',
      'db_complete',
      'apps_restarting',
      'promoted',
      'failed',
      'rollback_attempted',
      'rollback_verified',
      'rollback_failed',
      'rolled_back'
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_release_ledger_release_id
  ON platform.release_ledger (release_id);
CREATE INDEX IF NOT EXISTS idx_release_ledger_status_started
  ON platform.release_ledger (status, started_at DESC);

GRANT SELECT ON platform.release_ledger TO PUBLIC;

COMMENT ON TABLE platform.release_ledger IS
  'Canonical deploy record: git SHA, image digests, migration manifest hash, expected/applied heads, tenant fan-out, rollback verification state, status, failure phase, and operator. Supersedes deployed/production as release truth.';

COMMENT ON COLUMN platform.release_ledger.deploy_metadata IS
  'Deploy/runtime metadata such as capacity snapshots, image-pull manifests, GC decisions, and safety reserves.';

COMMENT ON COLUMN platform.release_ledger.schema_may_be_forward IS
  'True when db-migrate may have applied forward schema changes before an app rollback or deploy failure.';
