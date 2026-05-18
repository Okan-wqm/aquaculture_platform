import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddMessagingOutboxNotifyTrigger1782100000000
 * ============================================================================
 *
 * Installs a PostgreSQL AFTER INSERT trigger on `messaging_outbox` that
 * fires `pg_notify('messaging_outbox_notify', '')` after every new row.
 *
 * The shared outbox library's OutboxNotifyListener holds a long-lived
 * `LISTEN messaging_outbox_notify` session and wakes the worker within
 * ~5ms of each new row — collapsing enqueue-to-publish latency from
 * the previous 1s cron cadence to near-real-time.
 *
 * Channel name convention: `${tableName}_notify` — derived algorithmically
 * by OutboxNotifyListener from entity metadata, so the trigger and listener
 * stay in sync without configuration.
 *
 * Idempotent: CREATE OR REPLACE for the function, DROP IF EXISTS + CREATE
 * for the trigger.
 */
export class AddMessagingOutboxNotifyTrigger1782100000000
  implements MigrationInterface
{
  name = 'AddMessagingOutboxNotifyTrigger1782100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schemaRows: Array<{ current_schema: string }> =
      await queryRunner.query(`SELECT current_schema()`);
    const schema = schemaRows[0]?.current_schema;
    if (!schema) {
      throw new Error(
        'SELECT current_schema() returned no rows — cannot proceed with migration',
      );
    }

    // Create or replace the trigger function
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "${schema}"."notify_messaging_outbox_new"()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        PERFORM pg_notify('messaging_outbox_notify', '');
        RETURN NULL;
      END;
      $$;
    `);

    // Drop any pre-existing trigger before creating the new one
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "messaging_outbox_notify_trigger" ON "${schema}"."messaging_outbox"`,
    );

    await queryRunner.query(`
      CREATE TRIGGER "messaging_outbox_notify_trigger"
        AFTER INSERT ON "${schema}"."messaging_outbox"
        FOR EACH ROW
        EXECUTE FUNCTION "${schema}"."notify_messaging_outbox_new"();
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const schemaRows: Array<{ current_schema: string }> =
      await queryRunner.query(`SELECT current_schema()`);
    const schema = schemaRows[0]?.current_schema;
    if (!schema) {
      throw new Error('SELECT current_schema() returned no rows');
    }

    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "messaging_outbox_notify_trigger" ON "${schema}"."messaging_outbox"`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS "${schema}"."notify_messaging_outbox_new"()`,
    );
  }
}
