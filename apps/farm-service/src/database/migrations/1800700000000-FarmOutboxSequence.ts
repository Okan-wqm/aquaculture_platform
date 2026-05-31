import { MigrationInterface, QueryRunner } from 'typeorm';

export class FarmOutboxSequence1800700000000 implements MigrationInterface {
  name = 'FarmOutboxSequence1800700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE SEQUENCE IF NOT EXISTS "farm"."farm_outbox_sequence_seq" AS BIGINT START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1`,
    );
    await queryRunner.query(
      `ALTER TABLE "farm"."farm_outbox" ADD COLUMN IF NOT EXISTS "sequence" BIGINT DEFAULT nextval('"farm"."farm_outbox_sequence_seq"')`,
    );
    await queryRunner.query(
      `ALTER TABLE "farm"."farm_outbox" ALTER COLUMN "sequence" SET DEFAULT nextval('"farm"."farm_outbox_sequence_seq"')`,
    );
    await queryRunner.query(`
      WITH ordered AS (
        SELECT ctid
        FROM "farm"."farm_outbox"
        WHERE "sequence" IS NULL
        ORDER BY "createdAt" ASC, "id" ASC
      )
      UPDATE "farm"."farm_outbox" outbox
         SET "sequence" = nextval('"farm"."farm_outbox_sequence_seq"')
        FROM ordered
       WHERE outbox.ctid = ordered.ctid
    `);
    await queryRunner.query(
      `SELECT setval(
         '"farm"."farm_outbox_sequence_seq"',
         COALESCE((SELECT MAX("sequence") FROM "farm"."farm_outbox"), 1),
         EXISTS (SELECT 1 FROM "farm"."farm_outbox")
       )`,
    );
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'farm'
            AND table_name = 'farm_outbox'
            AND column_name = 'sequence'
            AND is_nullable = 'YES'
        ) THEN
          ALTER TABLE "farm"."farm_outbox" ALTER COLUMN "sequence" SET NOT NULL;
        END IF;
      END $$;
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_farm_outbox_sequence"
         ON "farm"."farm_outbox" ("sequence")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_farm_outbox_aggregate_fifo"
         ON "farm"."farm_outbox" ("tenantId", "aggregateId", "sequence")
         WHERE "publishedAt" IS NULL AND "isDeadLettered" = false AND "aggregateId" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "farm"."idx_farm_outbox_aggregate_fifo"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "farm"."idx_farm_outbox_sequence"`);
    await queryRunner.query(`ALTER TABLE "farm"."farm_outbox" DROP COLUMN IF EXISTS "sequence"`);
    await queryRunner.query(`DROP SEQUENCE IF EXISTS "farm"."farm_outbox_sequence_seq"`);
  }
}
