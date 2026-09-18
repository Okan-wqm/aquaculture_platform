import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Task 1.5 (100-tenant readiness plan): alert idempotency key.
 *
 * `alert_history` gains `source_event_id` — the SensorReading event's own
 * deterministic eventId (Task 1.4) — and a UNIQUE (rule_id, source_event_id)
 * index so a redelivered reading cannot double-fire an operator
 * notification. Legacy rows keep NULL (Postgres permits multiple NULLs in a
 * unique index), so no backfill is required.
 *
 * UNQUALIFIED table names on purpose: `alert_history` is a per-tenant table
 * and this migration is replayed into every tenant schema by the
 * provisioner; a schema-qualified name would re-target the source `alert`
 * schema instead (the defect class migration 1815 documents).
 */
export class AddAlertHistorySourceEventId1801100000000 implements MigrationInterface {
  name = 'AddAlertHistorySourceEventId1801100000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE alert_history ADD COLUMN IF NOT EXISTS source_event_id uuid`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_alert_history_rule_source_event
         ON alert_history (rule_id, source_event_id)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS uq_alert_history_rule_source_event`);
    await queryRunner.query(`ALTER TABLE alert_history DROP COLUMN IF EXISTS source_event_id`);
  }
}
