import { MigrationInterface, QueryRunner } from 'typeorm';

export class TenantCommandReceiptLedger1800100000000 implements MigrationInterface {
  name = 'TenantCommandReceiptLedger1800100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "auth"."tenant_command_receipts" (
        "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "operationId" UUID NOT NULL,
        "tenantId" UUID NOT NULL,
        "commandType" VARCHAR(100) NOT NULL,
        "entityType" VARCHAR(100) NOT NULL,
        "entityId" UUID NULL,
        "idempotencyKey" VARCHAR(255) NOT NULL,
        "payloadHash" VARCHAR(64) NOT NULL,
        "status" VARCHAR(20) NOT NULL DEFAULT 'STARTED',
        "resultHash" VARCHAR(64) NULL,
        "resultSummary" JSONB NULL,
        "error" TEXT NULL,
        "completedAt" TIMESTAMPTZ NULL,
        "actor" JSONB NOT NULL DEFAULT '{}',
        "auditMetadata" JSONB NOT NULL DEFAULT '{}',
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "chk_tenant_command_receipts_status"
          CHECK ("status" IN ('STARTED', 'SUCCEEDED', 'FAILED'))
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "auth"."tenant_command_receipts"
        ADD COLUMN IF NOT EXISTS "status" VARCHAR(20) NOT NULL DEFAULT 'STARTED',
        ADD COLUMN IF NOT EXISTS "resultSummary" JSONB NULL,
        ADD COLUMN IF NOT EXISTS "error" TEXT NULL,
        ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMPTZ NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "auth"."tenant_command_receipts"
        DROP COLUMN IF EXISTS "resultPayload"
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        ALTER TABLE "auth"."tenant_command_receipts"
          DROP CONSTRAINT IF EXISTS "chk_tenant_command_receipts_status";
        ALTER TABLE "auth"."tenant_command_receipts"
          ADD CONSTRAINT "chk_tenant_command_receipts_status"
            CHECK ("status" IN ('STARTED', 'SUCCEEDED', 'FAILED'));
      EXCEPTION WHEN duplicate_object THEN
        NULL;
      END $$;
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "auth"."uk_tenant_command_receipts_idempotency"
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uk_tenant_command_receipts_operation_tenant_command_idem"
        ON "auth"."tenant_command_receipts" (
          "operationId",
          "tenantId",
          "commandType",
          "idempotencyKey"
        )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_tenant_command_receipts_operation"
        ON "auth"."tenant_command_receipts" ("operationId", "commandType")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_tenant_command_receipts_tenant"
        ON "auth"."tenant_command_receipts" ("tenantId", "createdAt" DESC)
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Forward-only lifecycle evidence. Command receipts are part of the tenant audit trail.
  }
}
