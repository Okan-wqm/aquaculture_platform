import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateSubscriptionProvisioningRetries1800300000000 implements MigrationInterface {
  name = 'CreateSubscriptionProvisioningRetries1800300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS billing.subscription_provisioning_retries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL,
        event_payload JSONB NOT NULL,
        error_message TEXT,
        retry_count INT NOT NULL DEFAULT 0,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_spr_status_next_retry
        ON billing.subscription_provisioning_retries (status, next_retry_at)
        WHERE status = 'pending'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS billing.idx_spr_status_next_retry');
    await queryRunner.query('DROP TABLE IF EXISTS billing.subscription_provisioning_retries');
  }
}
