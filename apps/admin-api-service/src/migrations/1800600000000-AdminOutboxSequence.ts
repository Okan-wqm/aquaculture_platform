import { MigrationInterface, QueryRunner } from 'typeorm';

export class AdminOutboxSequence1800600000000 implements MigrationInterface {
  name = 'AdminOutboxSequence1800600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE SEQUENCE IF NOT EXISTS "admin"."admin_outbox_sequence_seq" AS BIGINT START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1`,
    );
    await queryRunner.query(
      `ALTER TABLE "admin"."admin_outbox" ADD COLUMN IF NOT EXISTS "sequence" BIGINT DEFAULT nextval('"admin"."admin_outbox_sequence_seq"')`,
    );
    await queryRunner.query(
      `ALTER TABLE "admin"."admin_outbox" ALTER COLUMN "sequence" SET DEFAULT nextval('"admin"."admin_outbox_sequence_seq"')`,
    );
    await queryRunner.query(`
      WITH ordered AS (
        SELECT ctid
        FROM "admin"."admin_outbox"
        WHERE "sequence" IS NULL
        ORDER BY "createdAt" ASC, "id" ASC
      )
      UPDATE "admin"."admin_outbox" outbox
         SET "sequence" = nextval('"admin"."admin_outbox_sequence_seq"')
        FROM ordered
       WHERE outbox.ctid = ordered.ctid
    `);
    await queryRunner.query(
      `SELECT setval(
         '"admin"."admin_outbox_sequence_seq"',
         COALESCE((SELECT MAX("sequence") FROM "admin"."admin_outbox"), 1),
         EXISTS (SELECT 1 FROM "admin"."admin_outbox")
       )`,
    );
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'admin'
            AND table_name = 'admin_outbox'
            AND column_name = 'sequence'
            AND is_nullable = 'YES'
        ) THEN
          ALTER TABLE "admin"."admin_outbox" ALTER COLUMN "sequence" SET NOT NULL;
        END IF;
      END $$;
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_admin_outbox_sequence"
         ON "admin"."admin_outbox" ("sequence")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_admin_outbox_aggregate_fifo"
         ON "admin"."admin_outbox" ("tenantId", "aggregateId", "sequence")
         WHERE "publishedAt" IS NULL AND "isDeadLettered" = false AND "aggregateId" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "admin"."idx_admin_outbox_aggregate_fifo"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "admin"."idx_admin_outbox_sequence"`);
    await queryRunner.query(`ALTER TABLE "admin"."admin_outbox" DROP COLUMN IF EXISTS "sequence"`);
    await queryRunner.query(`DROP SEQUENCE IF EXISTS "admin"."admin_outbox_sequence_seq"`);
  }
}
