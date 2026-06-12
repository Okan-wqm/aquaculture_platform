import {
  pinSearchPath,
  SourceOnlyMigration,
} from '@aquaculture/backend-common/database';
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Authoritative send-idempotency ledger (cluster-8 / PR#354 DİLİM-1).
 *
 * WHY: the partitioned `messages` table cannot carry a global UNIQUE on
 * (tenantId, idempotencyKey) — PostgreSQL requires the partition key
 * (createdAt) inside every unique constraint — and the Redis SET NX path
 * is a deliberately fail-open cache, not an authority. This
 * partition-free ledger gives SendMessageHandler a durable claim row
 * (INSERT ... ON CONFLICT DO NOTHING in the same transaction as the
 * message insert).
 *
 * Composite PRIMARY KEY is declared inline with the table (no bare
 * ADD CONSTRAINT — migration-sql-lint R11).
 */
@SourceOnlyMigration({
  reason:
    'message_send_idempotency is source-owned cross-tenant infrastructure ' +
    '(explicit schema, like messaging_outbox) and must never be cloned ' +
    'into tenant schemas',
})
export class CreateMessageSendIdempotencyLedger1800600000000
  implements MigrationInterface
{
  name = 'CreateMessageSendIdempotencyLedger1800600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner, 'messaging');

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS messaging.message_send_idempotency (
        "tenantId" UUID NOT NULL,
        "channelId" UUID NOT NULL,
        "senderId" UUID NOT NULL,
        "idempotencyKey" UUID NOT NULL,
        "messageId" UUID NOT NULL,
        "messageCreatedAt" TIMESTAMPTZ NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY ("tenantId", "channelId", "senderId", "idempotencyKey")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_message_send_idempotency_message
        ON messaging.message_send_idempotency ("tenantId", "messageId", "messageCreatedAt")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner, 'messaging');
    await queryRunner.query(
      `DROP INDEX IF EXISTS messaging.idx_message_send_idempotency_message`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS messaging.message_send_idempotency`,
    );
  }
}
