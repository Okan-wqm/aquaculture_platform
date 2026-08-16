import { MigrationInterface, QueryRunner } from 'typeorm';

export class HardenTenantOnboardingEvidence1808600000000 implements MigrationInterface {
  name = 'HardenTenantOnboardingEvidence1808600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);

    await queryRunner.query(`
      ALTER TABLE admin.tenant_provisioning_runs
        ADD COLUMN IF NOT EXISTS "onboardingAttempt" INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "onboardingRequestEventId" UUID NULL,
        ADD COLUMN IF NOT EXISTS "onboardingRequestedAt" TIMESTAMPTZ NULL
    `);
    await queryRunner.query(`
      DO $onboarding_command_constraint$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
            FROM pg_constraint
           WHERE conrelid = 'admin.tenant_provisioning_runs'::regclass
             AND conname = 'chk_tenant_provisioning_runs_onboarding_command'
        ) THEN
          ALTER TABLE admin.tenant_provisioning_runs
            ADD CONSTRAINT chk_tenant_provisioning_runs_onboarding_command CHECK (
              ("onboardingAttempt" >= 0 AND "onboardingRequestEventId" IS NULL AND "onboardingRequestedAt" IS NULL)
              OR
              ("onboardingAttempt" > 0 AND "onboardingRequestEventId" IS NOT NULL AND "onboardingRequestedAt" IS NOT NULL)
            ) NOT VALID;
          ALTER TABLE admin.tenant_provisioning_runs
            VALIDATE CONSTRAINT chk_tenant_provisioning_runs_onboarding_command;
        END IF;
      END
      $onboarding_command_constraint$
    `);

    await queryRunner.query(`
      ALTER TABLE admin.tenant_onboarding_acks
        ADD COLUMN IF NOT EXISTS "schemaVersion" INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS attempt INTEGER NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS "eventId" UUID NULL,
        ADD COLUMN IF NOT EXISTS "requestEventId" UUID NULL,
        ADD COLUMN IF NOT EXISTS "requestHash" CHAR(64) NULL,
        ADD COLUMN IF NOT EXISTS "receiptId" UUID NULL,
        ADD COLUMN IF NOT EXISTS "outcomeHash" CHAR(64) NULL
    `);
    await queryRunner.query(`
      ALTER TABLE admin.tenant_onboarding_acks
        DROP CONSTRAINT IF EXISTS uk_tenant_onboarding_acks_operation_service
    `);
    await queryRunner.query(`
      DO $onboarding_outcome_unique$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
            FROM pg_constraint
           WHERE conrelid = 'admin.tenant_onboarding_acks'::regclass
             AND conname = 'uk_tenant_onboarding_acks_operation_service_attempt'
        ) THEN
          ALTER TABLE admin.tenant_onboarding_acks
            ADD CONSTRAINT uk_tenant_onboarding_acks_operation_service_attempt
              UNIQUE ("operationId", service, attempt);
        END IF;
      END
      $onboarding_outcome_unique$
    `);
    await queryRunner.query(`
      DO $onboarding_outcome_contract$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
            FROM pg_constraint
           WHERE conrelid = 'admin.tenant_onboarding_acks'::regclass
             AND conname = 'chk_tenant_onboarding_acks_contract_v1'
        ) THEN
          ALTER TABLE admin.tenant_onboarding_acks
            ADD CONSTRAINT chk_tenant_onboarding_acks_contract_v1 CHECK (
              "schemaVersion" = 0
              OR (
                "schemaVersion" = 1
                AND attempt > 0
                AND "eventId" IS NOT NULL
                AND "requestEventId" IS NOT NULL
                AND "requestHash" ~ '^[0-9a-f]{64}$'
                AND "receiptId" IS NOT NULL
                AND "outcomeHash" ~ '^[0-9a-f]{64}$'
              )
            ) NOT VALID;
          ALTER TABLE admin.tenant_onboarding_acks
            VALIDATE CONSTRAINT chk_tenant_onboarding_acks_contract_v1;
        END IF;
      END
      $onboarding_outcome_contract$
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uk_tenant_onboarding_acks_event_id
        ON admin.tenant_onboarding_acks ("eventId")
        WHERE "eventId" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_tenant_onboarding_acks_command
        ON admin.tenant_onboarding_acks ("operationId", attempt, status)
    `);
    await queryRunner.query(`
      ALTER TABLE admin.tenant_onboarding_acks
        ALTER COLUMN "schemaVersion" SET DEFAULT 1
    `);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION admin.guard_tenant_onboarding_outcome_immutability()
      RETURNS TRIGGER AS $guard$
      BEGIN
        RAISE EXCEPTION 'tenant onboarding outcomes are immutable';
      END;
      $guard$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS guard_tenant_onboarding_outcome_immutability
        ON admin.tenant_onboarding_acks
    `);
    await queryRunner.query(`
      CREATE TRIGGER guard_tenant_onboarding_outcome_immutability
        BEFORE UPDATE OR DELETE ON admin.tenant_onboarding_acks
        FOR EACH ROW EXECUTE FUNCTION admin.guard_tenant_onboarding_outcome_immutability()
    `);
    await queryRunner.query(`
      DO $tenant_onboarding_evidence_grants$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'admin_service') THEN
          GRANT SELECT, INSERT ON admin.tenant_onboarding_acks TO "admin_service";
          REVOKE UPDATE, DELETE ON admin.tenant_onboarding_acks FROM "admin_service";
        END IF;
      END
      $tenant_onboarding_evidence_grants$
    `);
  }

  public async down(): Promise<void> {
    throw new Error('Tenant onboarding evidence and command correlation are forward-only');
  }
}
