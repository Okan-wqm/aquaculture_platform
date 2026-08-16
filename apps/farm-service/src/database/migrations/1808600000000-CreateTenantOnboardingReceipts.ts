import { SourceOnlyMigration } from '@aquaculture/backend-common/database';
import { MigrationInterface, QueryRunner } from 'typeorm';

@SourceOnlyMigration({
  reason:
    'tenant_onboarding_receipts is a farm-owned cross-tenant command ledger and must not be cloned into tenant schemas',
})
export class CreateTenantOnboardingReceipts1808600000000 implements MigrationInterface {
  name = 'CreateTenantOnboardingReceipts1808600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS farm.tenant_onboarding_receipts (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        "operationId" UUID NOT NULL,
        attempt INTEGER NOT NULL,
        "tenantId" UUID NOT NULL,
        "requestEventId" UUID NOT NULL,
        "requestHash" CHAR(64) NOT NULL,
        "requestFingerprint" CHAR(64) NOT NULL,
        state VARCHAR(20) NOT NULL,
        "leaseToken" UUID NULL,
        "leaseExpiresAt" TIMESTAMPTZ NULL,
        "processingAttempts" INTEGER NOT NULL DEFAULT 1,
        "outcomeHash" CHAR(64) NULL,
        evidence JSONB NULL,
        error TEXT NULL,
        "completedAt" TIMESTAMPTZ NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT chk_farm_tenant_onboarding_receipt_attempt CHECK (attempt > 0),
        CONSTRAINT chk_farm_tenant_onboarding_receipt_processing_attempts
          CHECK ("processingAttempts" > 0),
        CONSTRAINT chk_farm_tenant_onboarding_receipt_state
          CHECK (state IN ('PROCESSING', 'ACKNOWLEDGED', 'FAILED')),
        CONSTRAINT chk_farm_tenant_onboarding_receipt_hashes
          CHECK (
            "requestHash" ~ '^[0-9a-f]{64}$'
            AND "requestFingerprint" ~ '^[0-9a-f]{64}$'
            AND ("outcomeHash" IS NULL OR "outcomeHash" ~ '^[0-9a-f]{64}$')
          ),
        CONSTRAINT chk_farm_tenant_onboarding_receipt_terminal_shape
          CHECK (
            (state = 'PROCESSING' AND "completedAt" IS NULL AND "outcomeHash" IS NULL)
            OR
            (state IN ('ACKNOWLEDGED', 'FAILED') AND "completedAt" IS NOT NULL AND "outcomeHash" IS NOT NULL)
          ),
        CONSTRAINT uk_farm_tenant_onboarding_receipt_operation_attempt
          UNIQUE ("operationId", attempt),
        CONSTRAINT uk_farm_tenant_onboarding_receipt_request_event
          UNIQUE ("requestEventId")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_farm_tenant_onboarding_receipt_lease
        ON farm.tenant_onboarding_receipts (state, "leaseExpiresAt")
        WHERE state = 'PROCESSING'
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION farm.guard_terminal_tenant_onboarding_receipt()
      RETURNS TRIGGER AS $guard$
      BEGIN
        IF OLD.state IN ('ACKNOWLEDGED', 'FAILED') THEN
          RAISE EXCEPTION 'terminal tenant onboarding receipts are immutable';
        END IF;
        RETURN NEW;
      END;
      $guard$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS guard_terminal_tenant_onboarding_receipt
        ON farm.tenant_onboarding_receipts
    `);
    await queryRunner.query(`
      CREATE TRIGGER guard_terminal_tenant_onboarding_receipt
        BEFORE UPDATE ON farm.tenant_onboarding_receipts
        FOR EACH ROW EXECUTE FUNCTION farm.guard_terminal_tenant_onboarding_receipt()
    `);
    await queryRunner.query(`
      DO $grant_farm_tenant_onboarding_receipts$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'farm_service') THEN
          GRANT SELECT, INSERT, UPDATE ON farm.tenant_onboarding_receipts TO "farm_service";
          REVOKE DELETE ON farm.tenant_onboarding_receipts FROM "farm_service";
        END IF;
      END
      $grant_farm_tenant_onboarding_receipts$
    `);
  }

  public async down(): Promise<void> {
    throw new Error(
      'Tenant onboarding receipts are durable recovery evidence and cannot be rolled back',
    );
  }
}
