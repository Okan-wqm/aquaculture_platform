import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Task 4 (100-tenant readiness plan, SENSOR-HIGH-094): the append-only
 * archive ledger.
 *
 * `telemetry_archive_events` is the state machine that gates EVERY raw
 * chunk drop: a range may only be dropped when its newest ledger event is
 * VERIFIED (independently re-read and compared to the manifest). Rows are
 * append-only — a FAILED hop is a NEW event, never an UPDATE — and the
 * current state per (operation) is derived as the newest transition. The
 * raw `sensor_metrics` hypertable therefore NEVER receives
 * add_retention_policy: deletion is ledger-driven or it does not happen.
 *
 * PER-TENANT (ADR-011): the ledger carries a tenant_id discriminator, so it
 * lives in EVERY tenant_<16hex> schema (MODULE_SCHEMAS.tables registration)
 * and a tenant's archive history drops with its schema at erasure. The DDL
 * below is UNQUALIFIED on purpose (provisioner replay, ADR-033) AND fanned
 * out to already-provisioned tenant schemas (1810 pattern) so existing
 * tenants get the table without re-journaling.
 */
export class CreateTelemetryArchiveLedger1817000000000 implements MigrationInterface {
  name = 'CreateTelemetryArchiveLedger1817000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // Enum first (duplicate-guarded) so CREATE TABLE can use the typed
    // column directly — no ALTER COLUMN, nothing to replay-guard.
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE telemetry_archive_state AS ENUM
          ('EXPORT_STARTED', 'EXPORTED', 'VERIFIED', 'DROPPED', 'FAILED');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS telemetry_archive_events (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        operation_id uuid NOT NULL,
        tenant_id uuid NOT NULL,
        tenant_schema varchar(23) NOT NULL,
        range_start timestamptz NOT NULL,
        range_end timestamptz NOT NULL,
        state telemetry_archive_state NOT NULL,
        source_row_count bigint,
        source_snapshot text,
        object_key text,
        parquet_sha256 char(64),
        occurred_at timestamptz NOT NULL DEFAULT now(),
        actor text NOT NULL
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_telemetry_archive_events_operation
        ON telemetry_archive_events (operation_id, occurred_at DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_telemetry_archive_events_tenant_range
        ON telemetry_archive_events (tenant_id, range_start, range_end)
    `);

    // Fan out to every already-provisioned tenant schema (provisioner
    // replay covers tenants provisioned after this migration).
    await queryRunner.query(`
      DO $$
      DECLARE r record;
      BEGIN
        FOR r IN
          SELECT nspname FROM pg_namespace WHERE nspname LIKE 'tenant\\_%'
        LOOP
          BEGIN
            EXECUTE format('CREATE TYPE %I.telemetry_archive_state AS ENUM (''EXPORT_STARTED'', ''EXPORTED'', ''VERIFIED'', ''DROPPED'', ''FAILED'')', r.nspname);
          EXCEPTION WHEN duplicate_object THEN NULL; END;
        END LOOP;
      END $$;
    `);
    await queryRunner.query(`
      DO $$
      DECLARE r record;
      BEGIN
        FOR r IN
          SELECT nspname FROM pg_namespace WHERE nspname LIKE 'tenant\\_%'
        LOOP
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = r.nspname AND table_name = 'telemetry_archive_events'
          ) THEN
            EXECUTE format('
              CREATE TABLE %I.telemetry_archive_events (
                id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
                operation_id uuid NOT NULL,
                tenant_id uuid NOT NULL,
                tenant_schema varchar(23) NOT NULL,
                range_start timestamptz NOT NULL,
                range_end timestamptz NOT NULL,
                state %I.telemetry_archive_state NOT NULL,
                source_row_count bigint,
                source_snapshot text,
                object_key text,
                parquet_sha256 char(64),
                occurred_at timestamptz NOT NULL DEFAULT now(),
                actor text NOT NULL
              )',
              r.nspname, r.nspname);
            EXECUTE format('CREATE INDEX idx_telemetry_archive_events_operation ON %I.telemetry_archive_events (operation_id, occurred_at DESC)', r.nspname);
            EXECUTE format('CREATE INDEX idx_telemetry_archive_events_tenant_range ON %I.telemetry_archive_events (tenant_id, range_start, range_end)', r.nspname);
          END IF;
        END LOOP;
      END $$;
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE r record;
      BEGIN
        FOR r IN
          SELECT nspname FROM pg_namespace WHERE nspname LIKE 'tenant\\_%'
        LOOP
          EXECUTE format('DROP TABLE IF EXISTS %I.telemetry_archive_events', r.nspname);
          EXECUTE format('DROP TYPE IF EXISTS %I.telemetry_archive_state', r.nspname);
        END LOOP;
      END $$;
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS telemetry_archive_events`);
    await queryRunner.query(`DROP TYPE IF EXISTS telemetry_archive_state`);
  }
}
