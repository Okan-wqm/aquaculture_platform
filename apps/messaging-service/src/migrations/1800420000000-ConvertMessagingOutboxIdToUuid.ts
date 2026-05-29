import { MigrationInterface, QueryRunner } from 'typeorm';
import type { MigrationExecutionMetadata } from '@aquaculture/backend-common/database';

export class ConvertMessagingOutboxIdToUuid1800420000000
  implements MigrationInterface, MigrationExecutionMetadata
{
  name = 'ConvertMessagingOutboxIdToUuid1800420000000';
  readonly sourceOnly = true;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE
        current_id_type TEXT;
        current_pk_name TEXT;
      BEGIN
        SELECT data_type
          INTO current_id_type
          FROM information_schema.columns
         WHERE table_schema = 'messaging'
           AND table_name = 'messaging_outbox'
           AND column_name = 'id';

        IF current_id_type IS NULL THEN
          RAISE EXCEPTION 'messaging.messaging_outbox.id is missing';
        END IF;

        IF current_id_type <> 'uuid' THEN
          SELECT conname
            INTO current_pk_name
            FROM pg_constraint
           WHERE conrelid = 'messaging.messaging_outbox'::regclass
             AND contype = 'p'
           LIMIT 1;

          IF current_pk_name IS NOT NULL THEN
            EXECUTE format(
              'ALTER TABLE messaging.messaging_outbox DROP CONSTRAINT %I',
              current_pk_name
            );
          END IF;

          ALTER TABLE messaging.messaging_outbox
            RENAME COLUMN "id" TO "legacyId";

          ALTER TABLE messaging.messaging_outbox
            ADD COLUMN IF NOT EXISTS "id" UUID;

          UPDATE messaging.messaging_outbox
             SET "id" = gen_random_uuid()
           WHERE "id" IS NULL;

          ALTER TABLE messaging.messaging_outbox
            ALTER COLUMN "id" SET DEFAULT gen_random_uuid(),
            ALTER COLUMN "id" SET NOT NULL;

          ALTER TABLE messaging.messaging_outbox
            ADD PRIMARY KEY ("id");

          ALTER TABLE messaging.messaging_outbox
            -- DESTRUCTIVE: forward-only canonical UUID conversion, rollback requires restore from pre-migration pg_dump.
            DROP COLUMN "legacyId";
        END IF;
      END
      $$;
    `);
  }

  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ data_type: string }> = await queryRunner.query(
      `
        SELECT data_type
          FROM information_schema.columns
         WHERE table_schema = 'messaging'
           AND table_name = 'messaging_outbox'
           AND column_name = 'id'
      `,
    );
    return rows[0]?.data_type === 'uuid';
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Forward-only contract migration: UUID is the canonical outbox id type.
  }
}
