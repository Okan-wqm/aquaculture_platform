import { MigrationInterface, QueryRunner } from 'typeorm';
import type { MigrationExecutionMetadata } from '@aquaculture/backend-common/database';

export class CreateMessagingOutboxTable1800200000000
  implements MigrationInterface, MigrationExecutionMetadata
{
  name = 'CreateMessagingOutboxTable1800200000000';
  readonly sourceOnly = true;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS messaging.messaging_outbox (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "eventType" VARCHAR(100) NOT NULL,
        "tenantId" UUID NULL,
        "aggregateId" UUID NULL,
        "payload" JSONB NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "publishedAt" TIMESTAMPTZ NULL,
        "retryCount" INTEGER NOT NULL DEFAULT 0,
        "lastError" TEXT NULL,
        "nextAttemptAt" TIMESTAMPTZ NULL,
        "idempotencyKey" VARCHAR(255) NULL,
        "isDeadLettered" BOOLEAN NOT NULL DEFAULT false,
        "leasedAt" TIMESTAMPTZ NULL,
        "leasedBy" VARCHAR(128) NULL
      )
    `);

    await queryRunner.query(`
      ALTER TABLE messaging.messaging_outbox
        ADD COLUMN IF NOT EXISTS "tenantId" UUID,
        ADD COLUMN IF NOT EXISTS "aggregateId" UUID,
        ADD COLUMN IF NOT EXISTS "nextAttemptAt" TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS "idempotencyKey" VARCHAR(255),
        ADD COLUMN IF NOT EXISTS "isDeadLettered" BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "leasedAt" TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS "leasedBy" VARCHAR(128)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_outbox_poll"
        ON messaging.messaging_outbox ("createdAt")
        WHERE "publishedAt" IS NULL AND "isDeadLettered" = false
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_outbox_tenant"
        ON messaging.messaging_outbox ("tenantId")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_outbox_idempotency"
        ON messaging.messaging_outbox ("tenantId", "idempotencyKey")
        WHERE "idempotencyKey" IS NOT NULL
    `);
  }

  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ data_type: string }> = await queryRunner.query(
      `
        SELECT data_type
          FROM information_schema.columns
         WHERE table_schema = 'messaging'
           AND table_name = 'messaging_outbox'
           AND column_name = 'id'
      `,
    );
    return rows[0]?.data_type === 'uuid';
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Forward-only repair: this table may already exist in deployed databases.
  }
}
