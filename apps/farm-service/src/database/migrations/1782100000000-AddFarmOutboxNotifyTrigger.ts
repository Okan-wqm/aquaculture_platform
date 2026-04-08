import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationLogger } from '@aquaculture/backend-common';

/**
 * AddFarmOutboxNotifyTrigger1782100000000
 * ============================================================================
 *
 * Installs a PostgreSQL `AFTER INSERT` trigger on `farm_outbox` that
 * fires `pg_notify('farm_outbox_notify', '')` after every row is
 * committed. The shared outbox library's `OutboxNotifyListener` holds
 * a long-lived `LISTEN farm_outbox_notify` session and wakes the
 * worker within ~5 ms of each new row — collapsing the enqueue-to-
 * publish latency from the previous cron cadence (up to 1 s) to
 * near-real-time.
 *
 * # Channel name convention
 *
 * The channel name is derived from the concrete outbox table name
 * plus `_notify` — `farm_outbox_notify` here. The listener in the
 * shared library reads its entity metadata and subscribes to the
 * same derived name, so drift between the trigger and the listener
 * is impossible without touching both sides.
 *
 * # Empty payload on pg_notify
 *
 * `pg_notify` accepts a text payload up to 8000 bytes. We send an
 * empty string because the listener does not consume the payload —
 * it treats every notification as a pure wake signal, then the
 * worker's `acquireLease()` transaction reads whatever rows are
 * ready via `FOR UPDATE SKIP LOCKED`. Passing the newly-inserted
 * row data would duplicate work (the worker already has to SELECT
 * for the lease transaction) and risk stale/already-leased rows
 * slipping through on re-delivery.
 *
 * # Idempotency
 *
 * Both the function and the trigger use `CREATE OR REPLACE` /
 * `DROP IF EXISTS + CREATE` forms, so the migration is safe to
 * re-run on environments where it has already been applied
 * (manually, in staging, after a rollback).
 *
 * # Locking
 *
 * `CREATE TRIGGER ... AFTER INSERT` takes a `SHARE ROW EXCLUSIVE`
 * lock on the table for the duration of the catalog update only.
 * On an outbox table — which holds at most a few thousand
 * unpublished events — this completes in single-digit milliseconds
 * and does not block concurrent INSERTs (those take `ROW EXCLUSIVE`
 * and are compatible with the trigger install lock).
 *
 * # Downgrade safety
 *
 * The matching `down()` drops the trigger and the function. On
 * rollback, the listener stops receiving wake-ups and the worker
 * falls back to its 5-second cron cadence — no event loss, only a
 * latency degradation.
 */
export class AddFarmOutboxNotifyTrigger1782100000000
  implements MigrationInterface
{
  name = 'AddFarmOutboxNotifyTrigger1782100000000';
  private readonly logger = new MigrationLogger(this.name);

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schemaRows: Array<{ current_schema: string }> =
      await queryRunner.query(`SELECT current_schema()`);
    const schema = schemaRows[0]?.current_schema;
    if (!schema) {
      throw new Error(
        'SELECT current_schema() returned no rows — cannot proceed with migration',
      );
    }
    this.logger.log(
      `Installing farm_outbox NOTIFY trigger in schema "${schema}"`,
    );

    // Create or replace the trigger function. `CREATE OR REPLACE`
    // is idempotent for functions — if the function already exists
    // with the same signature, this updates its body in place.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "${schema}"."notify_farm_outbox_new"()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        -- Single-character payload: listeners only need the wake
        -- signal. The outbox worker's acquireLease() transaction
        -- will SELECT the next batch itself via FOR UPDATE SKIP
        -- LOCKED, so the NOTIFY channel does not carry row data.
        PERFORM pg_notify('farm_outbox_notify', '');
        RETURN NULL;
      END;
      $$;
    `);

    // Drop any pre-existing trigger before creating the new one.
    // `CREATE TRIGGER` is not `OR REPLACE`-compatible in PostgreSQL
    // until version 14 where the syntax exists but is discouraged;
    // drop+create is the portable idempotent idiom across all
    // PG versions the platform supports.
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "farm_outbox_notify_trigger" ON "${schema}"."farm_outbox"`,
    );

    await queryRunner.query(`
      CREATE TRIGGER "farm_outbox_notify_trigger"
        AFTER INSERT ON "${schema}"."farm_outbox"
        FOR EACH ROW
        EXECUTE FUNCTION "${schema}"."notify_farm_outbox_new"();
    `);

    this.logger.log(
      `farm_outbox NOTIFY trigger installed in schema "${schema}"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const schemaRows: Array<{ current_schema: string }> =
      await queryRunner.query(`SELECT current_schema()`);
    const schema = schemaRows[0]?.current_schema;
    if (!schema) {
      throw new Error('SELECT current_schema() returned no rows');
    }
    this.logger.warn(
      `Dropping farm_outbox NOTIFY trigger in schema "${schema}" — ` +
        `worker falls back to 5-second cron cadence.`,
    );

    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "farm_outbox_notify_trigger" ON "${schema}"."farm_outbox"`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS "${schema}"."notify_farm_outbox_new"()`,
    );

    this.logger.warn(
      `farm_outbox NOTIFY trigger removed in schema "${schema}"`,
    );
  }
}
