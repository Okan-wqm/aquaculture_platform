import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMessagingOutboxNotifyTrigger1800350000000 implements MigrationInterface {
  name = 'AddMessagingOutboxNotifyTrigger1800350000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('messaging.messaging_outbox') IS NULL THEN
          RETURN;
        END IF;

        CREATE OR REPLACE FUNCTION messaging.messaging_outbox_notify()
        RETURNS trigger AS $fn$
        BEGIN
          PERFORM pg_notify(
            'messaging_outbox_notify',
            json_build_object(
              'id', NEW."id",
              'tenantId', NEW."tenantId",
              'eventType', NEW."eventType"
            )::text
          );
          RETURN NEW;
        END;
        $fn$ LANGUAGE plpgsql;

        DROP TRIGGER IF EXISTS trg_messaging_outbox_notify ON messaging.messaging_outbox;
        CREATE TRIGGER trg_messaging_outbox_notify
        AFTER INSERT ON messaging.messaging_outbox
        FOR EACH ROW
        EXECUTE FUNCTION messaging.messaging_outbox_notify();
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('messaging.messaging_outbox') IS NOT NULL THEN
          DROP TRIGGER IF EXISTS trg_messaging_outbox_notify ON messaging.messaging_outbox;
        END IF;
        DROP FUNCTION IF EXISTS messaging.messaging_outbox_notify();
      END $$;
    `);
  }
}
