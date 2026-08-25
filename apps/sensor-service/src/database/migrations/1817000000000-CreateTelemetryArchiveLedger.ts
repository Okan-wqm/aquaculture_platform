import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Task 4 (100-tenant readiness plan, SENSOR-HIGH-094): the append-only
 * archive ledger.
 *
 * `sensor.telemetry_archive_events` is the cross-tenant state machine that
 * gates EVERY raw chunk drop: a range may only be dropped when its newest
 * ledger event is VERIFIED (independently re-read and compared to the
 * manifest). Rows are append-only — a FAILED hop is a NEW event, never an
 * UPDATE — and the current state per (operation) is derived as the newest
 * transition. The raw `sensor_metrics` hypertable therefore NEVER receives
 * add_retention_policy: deletion is ledger-driven or it does not happen.
 *
 * UNQUALIFIED DDL on purpose: replayed into tenant schemas? No — this table
 * lives in the shared `sensor` schema explicitly (cross-tenant by design,
 * like sensor_outbox), so the DDL IS schema-qualified to `sensor` and the
 * entity declares schema: 'sensor' (infrastructureTables registration in
 * MODULE_SCHEMAS follows in the same commit).
 */
export class CreateTelemetryArchiveLedger1817000000000 implements MigrationInterface {
  name = 'CreateTelemetryArchiveLedger1817000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // Enum first (duplicate-guarded) so CREATE TABLE can use the typed
    // column directly — no ALTER COLUMN, nothing to replay-guard.
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE sensor.telemetry_archive_state AS ENUM
          ('EXPORT_STARTED', 'EXPORTED', 'VERIFIED', 'DROPPED', 'FAILED');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS sensor.telemetry_archive_events (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        operation_id uuid NOT NULL,
        tenant_id uuid NOT NULL,
        tenant_schema varchar(23) NOT NULL,
        range_start timestamptz NOT NULL,
        range_end timestamptz NOT NULL,
        state sensor.telemetry_archive_state NOT NULL,
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
        ON sensor.telemetry_archive_events (operation_id, occurred_at DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_telemetry_archive_events_tenant_range
        ON sensor.telemetry_archive_events (tenant_id, range_start, range_end)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS sensor.telemetry_archive_events`);
    await queryRunner.query(`DROP TYPE IF EXISTS sensor.telemetry_archive_state`);
  }
}
