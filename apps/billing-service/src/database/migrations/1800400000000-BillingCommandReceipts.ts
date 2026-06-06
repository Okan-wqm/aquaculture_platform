import { MigrationInterface, QueryRunner } from 'typeorm';

export class BillingCommandReceipts1800400000000 implements MigrationInterface {
  name = 'BillingCommandReceipts1800400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "billing"."command_receipts" (
        "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "operationId" UUID NOT NULL,
        "tenantId" UUID NOT NULL,
        "commandType" VARCHAR(120) NOT NULL,
        "idempotencyKey" VARCHAR(255) NOT NULL,
        "payloadHash" VARCHAR(64) NOT NULL,
        "status" VARCHAR(20) NOT NULL DEFAULT 'STARTED',
        "entityType" VARCHAR(80) NOT NULL DEFAULT 'subscription',
        "entityId" UUID NULL,
        "resultHash" VARCHAR(64) NULL,
        "resultSummary" JSONB NULL,
        "errorCode" VARCHAR(80) NULL,
        "error" TEXT NULL,
        "completedAt" TIMESTAMPTZ NULL,
        "actorId" UUID NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "chk_billing_command_receipts_status"
          CHECK ("status" IN ('STARTED', 'SUCCEEDED', 'FAILED'))
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "billing"."command_receipts"
        ADD COLUMN IF NOT EXISTS "resultSummary" JSONB NULL,
        ADD COLUMN IF NOT EXISTS "errorCode" VARCHAR(80) NULL,
        ADD COLUMN IF NOT EXISTS "error" TEXT NULL,
        ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMPTZ NULL
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uk_billing_command_receipts_operation_tenant_command_idem"
        ON "billing"."command_receipts" (
          "operationId",
          "tenantId",
          "commandType",
          "idempotencyKey"
        )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_billing_command_receipts_tenant"
        ON "billing"."command_receipts" ("tenantId", "createdAt" DESC)
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Forward-only billing evidence. Receipts are part of tenant provisioning audit.
  }
}
