import {
  pinSearchPath,
  SourceOnlyMigration,
} from '@aquaculture/backend-common/database';
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Create the auth-service transactional outbox table (DATA-HIGH-001).
 *
 * Mirrors the messaging_outbox contract: a single source-owned table in the
 * `auth` schema that every state-change writer INSERTs into within the same
 * transaction as its domain write, so the domain row and the outbox row commit
 * atomically (no dual-write event loss between commit and NATS publish). The
 * OutboxWorkerService then publishes asynchronously with at-least-once + retry
 * + dead-letter semantics.
 *
 * Columns mirror OutboxEntityBase exactly (the AuthOutbox entity is
 * synchronize:false; this migration is the schema owner).
 */
@SourceOnlyMigration({
  reason:
    'auth_outbox is source-owned infrastructure and must never be cloned into tenant schemas',
})
export class CreateAuthOutboxTable1800600000000 implements MigrationInterface {
  name = 'CreateAuthOutboxTable1800600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner, 'auth');

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS auth.auth_outbox (
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

    // Poll predicate index: the worker scans unpublished, non-dead-lettered
    // rows oldest-first. Partial index keeps it small as published rows pile up.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_auth_outbox_poll"
        ON auth.auth_outbox ("createdAt")
        WHERE "publishedAt" IS NULL AND "isDeadLettered" = false
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_auth_outbox_tenant"
        ON auth.auth_outbox ("tenantId")
    `);

    // Idempotency: at most one outbox row per (tenant, idempotencyKey) so a
    // retried command cannot enqueue the same event twice.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_auth_outbox_idempotency"
        ON auth.auth_outbox ("tenantId", "idempotencyKey")
        WHERE "idempotencyKey" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner, 'auth');
    await queryRunner.query(`DROP INDEX IF EXISTS auth."idx_auth_outbox_idempotency"`);
    await queryRunner.query(`DROP INDEX IF EXISTS auth."idx_auth_outbox_tenant"`);
    await queryRunner.query(`DROP INDEX IF EXISTS auth."idx_auth_outbox_poll"`);
    await queryRunner.query(`DROP TABLE IF EXISTS auth.auth_outbox`);
  }
}
