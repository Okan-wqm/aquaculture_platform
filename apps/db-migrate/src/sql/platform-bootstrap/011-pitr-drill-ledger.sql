-- ============================================================================
-- Platform Bootstrap — Stage 011: immutable timestamp-PITR drill ledger
--
-- A restore drill must prove that recovery stopped between two transactions;
-- application audit timestamps are not commit timestamps and are therefore
-- not a valid recovery boundary.  This append-only ledger gives the protected
-- DR workflow a canonical, run-scoped pair of rows whose source-clock and WAL
-- observations are captured immediately after each committed INSERT.
-- ============================================================================

CREATE TABLE IF NOT EXISTS platform.pitr_drill_sentinels (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  drill_run_id    VARCHAR(120) NOT NULL,
  phase           VARCHAR(8)   NOT NULL,
  main_sha        CHAR(40)     NOT NULL,
  backup_name     VARCHAR(180) NOT NULL,
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  recorded_lsn    PG_LSN      NOT NULL DEFAULT pg_current_wal_insert_lsn(),
  CONSTRAINT pitr_drill_sentinels_phase_chk
    CHECK (phase IN ('BEFORE', 'AFTER')),
  CONSTRAINT pitr_drill_sentinels_main_sha_chk
    CHECK (main_sha ~ '^[0-9a-f]{40}$'),
  CONSTRAINT pitr_drill_sentinels_run_phase_uq
    UNIQUE (drill_run_id, phase)
);

CREATE OR REPLACE FUNCTION platform.reject_pitr_drill_sentinel_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'platform.pitr_drill_sentinels is append-only';
END
$function$;

DROP TRIGGER IF EXISTS pitr_drill_sentinels_immutable
  ON platform.pitr_drill_sentinels;
CREATE TRIGGER pitr_drill_sentinels_immutable
  BEFORE UPDATE OR DELETE ON platform.pitr_drill_sentinels
  FOR EACH ROW
  EXECUTE FUNCTION platform.reject_pitr_drill_sentinel_mutation();

DROP TRIGGER IF EXISTS pitr_drill_sentinels_truncate_immutable
  ON platform.pitr_drill_sentinels;
CREATE TRIGGER pitr_drill_sentinels_truncate_immutable
  BEFORE TRUNCATE ON platform.pitr_drill_sentinels
  FOR EACH STATEMENT
  EXECUTE FUNCTION platform.reject_pitr_drill_sentinel_mutation();

REVOKE ALL ON platform.pitr_drill_sentinels FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.reject_pitr_drill_sentinel_mutation() FROM PUBLIC;

GRANT SELECT ON platform.pitr_drill_sentinels TO db_migrate;

COMMENT ON TABLE platform.pitr_drill_sentinels IS
  'Append-only before/after transaction sentinels for protected timestamp-PITR drills; INFRA-HIGH-041.';
COMMENT ON COLUMN platform.pitr_drill_sentinels.recorded_at IS
  'Server clock observed by the INSERT statement; the drill records a separate post-commit source-clock fence.';
COMMENT ON COLUMN platform.pitr_drill_sentinels.recorded_lsn IS
  'WAL insert position observed by the INSERT statement; the drill records a separate post-commit WAL fence.';
