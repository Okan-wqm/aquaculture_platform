import { MigrationInterface, QueryRunner } from 'typeorm';

export class HrOutboxTenantScopedIndexes1800200000000 implements MigrationInterface {
  name = 'HrOutboxTenantScopedIndexes1800200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE SEQUENCE IF NOT EXISTS "hr"."hr_outbox_sequence_seq" AS BIGINT START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1`,
    );
    await queryRunner.query(
      `ALTER TABLE "hr"."hr_outbox" ADD COLUMN IF NOT EXISTS "sequence" BIGINT DEFAULT nextval('"hr"."hr_outbox_sequence_seq"')`,
    );
    await queryRunner.query(
      `ALTER TABLE "hr"."hr_outbox" ALTER COLUMN "sequence" SET DEFAULT nextval('"hr"."hr_outbox_sequence_seq"')`,
    );
    await queryRunner.query(`
      WITH ordered AS (
        SELECT ctid
        FROM "hr"."hr_outbox"
        WHERE "sequence" IS NULL
        ORDER BY "createdAt" ASC, "id" ASC
      )
      UPDATE "hr"."hr_outbox" outbox
         SET "sequence" = nextval('"hr"."hr_outbox_sequence_seq"')
        FROM ordered
       WHERE outbox.ctid = ordered.ctid
    `);
    await queryRunner.query(
      `SELECT setval(
         '"hr"."hr_outbox_sequence_seq"',
         COALESCE((SELECT MAX("sequence") FROM "hr"."hr_outbox"), 1),
         EXISTS (SELECT 1 FROM "hr"."hr_outbox")
       )`,
    );
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'hr'
            AND table_name = 'hr_outbox'
            AND column_name = 'sequence'
            AND is_nullable = 'YES'
        ) THEN
          ALTER TABLE "hr"."hr_outbox" ALTER COLUMN "sequence" SET NOT NULL;
        END IF;
      END $$;
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_hr_outbox_sequence"
         ON "hr"."hr_outbox" ("sequence")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_hr_outbox_aggregate_fifo"
         ON "hr"."hr_outbox" ("tenantId", "aggregateId", "sequence")
         WHERE "publishedAt" IS NULL AND "isDeadLettered" = false AND "aggregateId" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_hr_outbox_poll"
         ON "hr"."hr_outbox" ("createdAt")
         WHERE "publishedAt" IS NULL AND "isDeadLettered" = false`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_hr_outbox_tenant"
         ON "hr"."hr_outbox" ("tenantId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_hr_outbox_idempotency"
         ON "hr"."hr_outbox" ("tenantId", "idempotencyKey")
         WHERE "idempotencyKey" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "hr"."idx_hr_outbox_aggregate_fifo"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "hr"."idx_hr_outbox_sequence"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "hr"."idx_hr_outbox_idempotency"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "hr"."idx_hr_outbox_tenant"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "hr"."idx_hr_outbox_poll"`);
    await queryRunner.query(`ALTER TABLE "hr"."hr_outbox" DROP COLUMN IF EXISTS "sequence"`);
    await queryRunner.query(`DROP SEQUENCE IF EXISTS "hr"."hr_outbox_sequence_seq"`);
  }
}
