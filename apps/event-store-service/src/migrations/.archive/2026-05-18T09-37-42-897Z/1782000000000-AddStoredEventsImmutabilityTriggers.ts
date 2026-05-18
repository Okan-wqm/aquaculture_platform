import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddStoredEventsImmutabilityTriggers1782000000000
 * ============================================================================
 *
 * SECURITY: Enforces event store immutability at the database level.
 *
 * Event sourcing's fundamental invariant is that stored events are
 * immutable facts — once appended they must never be modified or deleted.
 * Application-level guards are insufficient because:
 *   1. A bug in any code path with write access can corrupt the log.
 *   2. An attacker with DB credentials can tamper with audit history.
 *   3. ORM bulk operations (e.g. TypeORM cascades) can silently update.
 *
 * This migration adds BEFORE UPDATE and BEFORE DELETE triggers on the
 * `stored_events` table that unconditionally raise an exception,
 * preventing any modification or deletion regardless of the caller.
 *
 * @see PLAT-CRITICAL-005
 */
export class AddStoredEventsImmutabilityTriggers1782000000000 implements MigrationInterface {
  name = 'AddStoredEventsImmutabilityTriggers1782000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Create the trigger function ──
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION prevent_stored_events_mutation()
      RETURNS TRIGGER
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'stored_events table is immutable: % operations are forbidden',
          TG_OP
          USING HINT = 'Events are append-only. Do not UPDATE or DELETE stored events.';
        RETURN NULL;
      END;
      $$;
    `);

    // ── BEFORE UPDATE trigger ──
    await queryRunner.query(`
      CREATE TRIGGER stored_events_no_update
      BEFORE UPDATE ON stored_events
      FOR EACH ROW
      EXECUTE FUNCTION prevent_stored_events_mutation();
    `);

    // ── BEFORE DELETE trigger ──
    await queryRunner.query(`
      CREATE TRIGGER stored_events_no_delete
      BEFORE DELETE ON stored_events
      FOR EACH ROW
      EXECUTE FUNCTION prevent_stored_events_mutation();
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER IF EXISTS stored_events_no_delete ON stored_events;`);
    await queryRunner.query(`DROP TRIGGER IF EXISTS stored_events_no_update ON stored_events;`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS prevent_stored_events_mutation();`);
  }
}
