import { applyTenantRlsToSchema } from '@aquaculture/backend-common/database';
import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateHrMobileCommandReceipts1800100000000 implements MigrationInterface {
  name = 'CreateHrMobileCommandReceipts1800100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS hr_mobile_command_receipts (
        "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "tenantId" UUID NOT NULL,
        "clientCommandId" UUID NOT NULL,
        "payloadHash" VARCHAR(128) NOT NULL,
        "operationType" VARCHAR(80) NOT NULL,
        "deviceId" UUID NULL,
        "clientCreatedAt" TIMESTAMPTZ NULL,
        "status" VARCHAR(20) NOT NULL DEFAULT 'IN_PROGRESS',
        "responseType" VARCHAR(120) NULL,
        "responseId" UUID NULL,
        "responsePayload" JSONB NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "uq_hr_mobile_command_receipt_tenant_command"
          UNIQUE ("tenantId", "clientCommandId")
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "idx_hr_mobile_command_receipts_tenant_command" ON hr_mobile_command_receipts ("tenantId", "clientCommandId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "idx_hr_mobile_command_receipts_tenant_status" ON hr_mobile_command_receipts ("tenantId", "status")`);

    await applyTenantRlsToSchema(queryRunner, {
      tenantIdColumns: ['tenant_id', 'tenantId'],
    });
  }

  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const result: unknown = await queryRunner.query(`
      SELECT
        to_regclass(current_schema() || '.hr_mobile_command_receipts') IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM pg_indexes
          WHERE schemaname = current_schema()
            AND indexname = 'idx_hr_mobile_command_receipts_tenant_command'
        )
        AND EXISTS (
          SELECT 1 FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = current_schema()
            AND c.relname = 'hr_mobile_command_receipts'
            AND c.relrowsecurity = true
            AND c.relforcerowsecurity = true
        ) AS ok
    `);
    if (!Array.isArray(result)) {
      return false;
    }
    const [first] = result as Array<{ ok?: unknown }>;
    return first?.ok === true;
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Forward-only expand migration.
  }
}
