import { pinSearchPath, SourceOnlyMigration } from '@aquaculture/backend-common/database';
import { MigrationInterface, QueryRunner } from 'typeorm';

@SourceOnlyMigration({
  reason:
    'messaging_outbox is source-owned infrastructure and must keep one canonical FIFO sequence in the source schema',
})
export class MessagingOutboxSequence1800500000000 implements MigrationInterface {
  name = 'MessagingOutboxSequence1800500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner, 'messaging');

    await queryRunner.query(
      `CREATE SEQUENCE IF NOT EXISTS messaging.messaging_outbox_sequence_seq AS BIGINT START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1`,
    );
    await queryRunner.query(
      `ALTER TABLE messaging.messaging_outbox ADD COLUMN IF NOT EXISTS "sequence" BIGINT DEFAULT nextval('messaging.messaging_outbox_sequence_seq')`,
    );
    await queryRunner.query(
      `ALTER TABLE messaging.messaging_outbox ALTER COLUMN "sequence" SET DEFAULT nextval('messaging.messaging_outbox_sequence_seq')`,
    );
    await queryRunner.query(`
      WITH ordered AS (
        SELECT ctid
        FROM messaging.messaging_outbox
        WHERE "sequence" IS NULL
        ORDER BY "createdAt" ASC, "id"::text ASC
      )
      UPDATE messaging.messaging_outbox outbox
         SET "sequence" = nextval('messaging.messaging_outbox_sequence_seq')
        FROM ordered
       WHERE outbox.ctid = ordered.ctid
    `);
    await queryRunner.query(
      `SELECT setval(
         'messaging.messaging_outbox_sequence_seq',
         COALESCE((SELECT MAX("sequence") FROM messaging.messaging_outbox), 1),
         EXISTS (SELECT 1 FROM messaging.messaging_outbox)
       )`,
    );
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'messaging'
            AND table_name = 'messaging_outbox'
            AND column_name = 'sequence'
            AND is_nullable = 'YES'
        ) THEN
          ALTER TABLE messaging.messaging_outbox ALTER COLUMN "sequence" SET NOT NULL;
        END IF;
      END $$;
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_outbox_sequence"
         ON messaging.messaging_outbox ("sequence")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_outbox_aggregate_fifo"
         ON messaging.messaging_outbox ("tenantId", "aggregateId", "sequence")
         WHERE "publishedAt" IS NULL AND "isDeadLettered" = false AND "aggregateId" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner, 'messaging');
    await queryRunner.query(`DROP INDEX IF EXISTS messaging.idx_outbox_aggregate_fifo`);
    await queryRunner.query(`DROP INDEX IF EXISTS messaging.idx_outbox_sequence`);
    await queryRunner.query(
      `ALTER TABLE messaging.messaging_outbox DROP COLUMN IF EXISTS "sequence"`,
    );
    await queryRunner.query(`DROP SEQUENCE IF EXISTS messaging.messaging_outbox_sequence_seq`);
  }
}
