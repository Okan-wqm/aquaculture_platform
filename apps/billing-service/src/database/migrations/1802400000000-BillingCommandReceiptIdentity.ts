import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ADR-0014: a billing command receipt is identified by
 * `(tenantId, commandType, idempotencyKey)` — NOT by `operationId`.
 *
 * The original unique index led with `operationId`, so a caller that minted a
 * fresh operationId on its retry (which the admin provisioning workflow does)
 * inserted a SECOND receipt for the same idempotency key and the command ran
 * again. The key was decorative.
 *
 * Two further changes make the receipt usable by every admin billing command,
 * not just tenant provisioning:
 *
 *  - `operationId` and `tenantId` become nullable. The catalogue commands
 *    (plans, discount codes, module prices) are platform-scoped: they have no
 *    tenant, and inventing a sentinel UUID to satisfy NOT NULL would make the
 *    receipt lie about who the row belongs to. `NULLS NOT DISTINCT` (PG15+)
 *    keeps the unique index total over those rows.
 *  - `correlationId` is recorded so a receipt, its audit row and its log line
 *    join on one value.
 *
 * Duplicates that already exist are NOT deleted — they are the evidence that a
 * command executed twice. They are marked `supersededAt` and the unique index
 * is partial on `"supersededAt" IS NULL`, so history survives and exactly one
 * receipt per identity is live.
 */
export class BillingCommandReceiptIdentity1802400000000 implements MigrationInterface {
  name = 'BillingCommandReceiptIdentity1802400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "billing"."command_receipts"
        ADD COLUMN IF NOT EXISTS "correlationId" VARCHAR(120) NULL,
        ADD COLUMN IF NOT EXISTS "supersededAt" TIMESTAMPTZ NULL
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'billing'
             AND table_name = 'command_receipts'
             AND column_name = 'operationId'
             AND is_nullable = 'NO'
        ) THEN
          ALTER TABLE "billing"."command_receipts" ALTER COLUMN "operationId" DROP NOT NULL;
        END IF;
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'billing'
             AND table_name = 'command_receipts'
             AND column_name = 'tenantId'
             AND is_nullable = 'NO'
        ) THEN
          ALTER TABLE "billing"."command_receipts" ALTER COLUMN "tenantId" DROP NOT NULL;
        END IF;
      END $$;
    `);

    // Keep the newest receipt per identity live; retire the rest as evidence.
    await queryRunner.query(`
      UPDATE "billing"."command_receipts" AS r
         SET "supersededAt" = NOW()
       WHERE r."supersededAt" IS NULL
         AND EXISTS (
           SELECT 1
             FROM "billing"."command_receipts" AS n
            WHERE n."supersededAt" IS NULL
              AND n."commandType" = r."commandType"
              AND n."idempotencyKey" = r."idempotencyKey"
              AND n."tenantId" IS NOT DISTINCT FROM r."tenantId"
              AND (n."createdAt", n."id") > (r."createdAt", r."id")
         )
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "billing"."uk_billing_command_receipts_operation_tenant_command_idem"
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uk_billing_command_receipts_identity"
        ON "billing"."command_receipts" ("tenantId", "commandType", "idempotencyKey")
        NULLS NOT DISTINCT
        WHERE "supersededAt" IS NULL
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_billing_command_receipts_correlation"
        ON "billing"."command_receipts" ("correlationId")
        WHERE "correlationId" IS NOT NULL
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Forward-only billing evidence. Restoring the operationId-led index would
    // reopen the duplicate-execution path this migration closed.
  }
}
