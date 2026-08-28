import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateFindingEventsLedger1801200000000 implements MigrationInterface {
  name = 'CreateFindingEventsLedger1801200000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS event_store.finding_events (
        ledger_seq   BIGSERIAL   PRIMARY KEY,
        event_id     UUID        NOT NULL,
        finding_id   VARCHAR(80) NOT NULL,
        version      INTEGER     NOT NULL,
        event_type   VARCHAR(32) NOT NULL,
        payload      JSONB       NOT NULL,
        main_sha     CHAR(40)    NOT NULL,
        occurred_at  TIMESTAMPTZ NOT NULL,
        prev_hash    CHAR(64)    NOT NULL,
        content_hash CHAR(64)    NOT NULL,
        CONSTRAINT finding_events_event_id_uq UNIQUE (event_id),
        CONSTRAINT finding_events_finding_version_uq UNIQUE (finding_id, version),
        CONSTRAINT finding_events_content_hash_uq UNIQUE (content_hash),
        CONSTRAINT finding_events_version_chk CHECK (version > 0),
        CONSTRAINT finding_events_event_type_chk CHECK (
          event_type IN (
            'CREATED',
            'EVIDENCE_ADDED',
            'OWNER_ASSIGNED',
            'STATE_TRANSITIONED',
            'SUPERSEDED'
          )
        ),
        CONSTRAINT finding_events_main_sha_chk CHECK (main_sha ~ '^[0-9a-f]{40}$'),
        CONSTRAINT finding_events_prev_hash_chk CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
        CONSTRAINT finding_events_content_hash_chk CHECK (content_hash ~ '^[0-9a-f]{64}$')
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS finding_events_finding_order_idx
        ON event_store.finding_events (finding_id, version)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS finding_events_main_sha_idx
        ON event_store.finding_events (main_sha, ledger_seq)
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS event_store.finding_ledger_parity_runs (
        parity_seq        BIGSERIAL   PRIMARY KEY,
        run_id            UUID        NOT NULL UNIQUE,
        main_sha          CHAR(40)    NOT NULL,
        registry_tip_hash CHAR(64)    NOT NULL,
        ledger_tip_hash   CHAR(64)    NOT NULL,
        registry_entries  INTEGER     NOT NULL,
        ledger_findings   INTEGER     NOT NULL,
        passed            BOOLEAN     NOT NULL,
        checked_at        TIMESTAMPTZ NOT NULL,
        CONSTRAINT finding_ledger_parity_main_sha_chk CHECK (main_sha ~ '^[0-9a-f]{40}$'),
        CONSTRAINT finding_ledger_parity_registry_tip_chk CHECK (
          registry_tip_hash ~ '^[0-9a-f]{64}$'
        ),
        CONSTRAINT finding_ledger_parity_ledger_tip_chk CHECK (
          ledger_tip_hash ~ '^[0-9a-f]{64}$'
        ),
        CONSTRAINT finding_ledger_parity_counts_chk CHECK (
          registry_entries >= 0 AND ledger_findings >= 0
        ),
        CONSTRAINT finding_ledger_parity_commit_tip_uq UNIQUE (main_sha, registry_tip_hash)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS finding_ledger_parity_runs_order_idx
        ON event_store.finding_ledger_parity_runs (parity_seq DESC)
    `);

    await queryRunner.query(`
      CREATE FUNCTION event_store.reject_finding_ledger_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        RAISE EXCEPTION 'finding event and parity ledgers are immutable';
      END
      $function$
    `);
    for (const table of ['finding_events', 'finding_ledger_parity_runs']) {
      await queryRunner.query(`
        CREATE TRIGGER ${table}_immutable
          BEFORE UPDATE OR DELETE ON event_store.${table}
          FOR EACH ROW EXECUTE FUNCTION event_store.reject_finding_ledger_mutation()
      `);
      await queryRunner.query(`
        CREATE TRIGGER ${table}_truncate_immutable
          BEFORE TRUNCATE ON event_store.${table}
          FOR EACH STATEMENT EXECUTE FUNCTION event_store.reject_finding_ledger_mutation()
      `);
      await queryRunner.query(
        `REVOKE UPDATE, DELETE, TRUNCATE ON event_store.${table} FROM PUBLIC`,
      );
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // protected-tables-guard: migration rollback removes the complete finding-event
    // subsystem atomically; production closure does not authorize this down path.
    await queryRunner.query(
      `-- DESTRUCTIVE: rollback drops the parity ledger; restore per docs/runbooks/database-restore-drill.md
       DROP TABLE IF EXISTS event_store.finding_ledger_parity_runs`,
    );
    await queryRunner.query(
      `-- DESTRUCTIVE: rollback drops the finding event ledger; restore per docs/runbooks/database-restore-drill.md
       DROP TABLE IF EXISTS event_store.finding_events`,
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS event_store.reject_finding_ledger_mutation()`);
  }
}
