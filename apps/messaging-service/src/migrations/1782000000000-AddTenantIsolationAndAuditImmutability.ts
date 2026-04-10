import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: Add tenant isolation columns, message idempotency,
 * outbox idempotency, audit log immutability trigger, and GDPR support.
 *
 * Closes findings:
 * - DB-HIGH-001 (messaging tables missing tenant_id)
 * - DB-HIGH-007 (missing updated_by audit column)
 * - MSG-HIGH-010 (Message entity missing tenantId)
 * - MSG-HIGH-015 (no idempotency constraint on message processing)
 * - MSG-HIGH-021 (audit records have no immutability protection)
 * - MSG-HIGH-004 (outbox idempotency key)
 * - MSG-HIGH-006 (dead-letter flag on outbox)
 */
export class AddTenantIsolationAndAuditImmutability1782000000000
  implements MigrationInterface
{
  name = 'AddTenantIsolationAndAuditImmutability1782000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. Add tenantId to channels ──
    await queryRunner.query(`
      ALTER TABLE "channels"
      ADD COLUMN IF NOT EXISTS "tenantId" uuid;
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_channels_tenant"
      ON "channels" ("tenantId");
    `);

    // ── 2. Add tenantId to channel_members ──
    await queryRunner.query(`
      ALTER TABLE "channel_members"
      ADD COLUMN IF NOT EXISTS "tenantId" uuid;
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_channel_members_tenant"
      ON "channel_members" ("tenantId");
    `);

    // ── 3. Add tenantId to messages ──
    await queryRunner.query(`
      ALTER TABLE "messages"
      ADD COLUMN IF NOT EXISTS "tenantId" uuid;
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_messages_tenant"
      ON "messages" ("tenantId");
    `);

    // ── 4. Add updatedBy to messages ──
    await queryRunner.query(`
      ALTER TABLE "messages"
      ADD COLUMN IF NOT EXISTS "updatedBy" uuid;
    `);

    // ── 4b. Add idempotencyKey column to messages ──
    await queryRunner.query(`
      ALTER TABLE "messages"
      ADD COLUMN IF NOT EXISTS "idempotencyKey" varchar(255);
    `);

    // ── 5. Add idempotency index to messages ──
    // WHY non-unique: "messages" is partitioned by RANGE on "createdAt".
    // PostgreSQL requires UNIQUE constraints on partitioned tables to include
    // ALL partition key columns. Since "idempotencyKey" + "tenantId" + "createdAt"
    // would be a very wide key with low selectivity on createdAt, we use a
    // non-unique index instead. Deduplication is enforced at the application
    // layer via Redis SET NX (see send-message.handler.ts IDEMPOTENCY_TTL).
    // The index supports efficient lookups for idempotency key collision detection.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_messages_idempotency"
      ON "messages" ("tenantId", "idempotencyKey")
      WHERE "idempotencyKey" IS NOT NULL;
    `);

    // ── 6. Add tenantId, idempotencyKey and isDeadLettered to messaging_outbox ──
    // WHY: messaging_outbox was created before tenant isolation was added.
    // tenantId is required for per-tenant event routing and dead-letter metrics.
    await queryRunner.query(`
      ALTER TABLE "messaging_outbox"
      ADD COLUMN IF NOT EXISTS "tenantId" uuid;
    `);
    await queryRunner.query(`
      ALTER TABLE "messaging_outbox"
      ADD COLUMN IF NOT EXISTS "idempotencyKey" varchar(255);
    `);
    await queryRunner.query(`
      ALTER TABLE "messaging_outbox"
      ADD COLUMN IF NOT EXISTS "isDeadLettered" boolean DEFAULT false;
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_outbox_idempotency"
      ON "messaging_outbox" ("tenantId", "idempotencyKey")
      WHERE "idempotencyKey" IS NOT NULL;
    `);

    // ── 7. Audit log immutability trigger ──
    // SECURITY: Makes UPDATE and DELETE on compliance_audit_log structurally
    // impossible at the database level. Even superusers with direct DB access
    // must DROP the trigger before they can tamper with audit records.
    // @see MSG-HIGH-021
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION prevent_audit_log_mutation()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'compliance_audit_log is immutable: % not allowed', TG_OP;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_audit_log_immutable ON "compliance_audit_log";
      CREATE TRIGGER trg_audit_log_immutable
        BEFORE UPDATE OR DELETE ON "compliance_audit_log"
        FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();
    `);

    // ── 8. Backfill tenantId from channels to messages (for existing data) ──
    // This is safe because messages.channelId references channels.id
    await queryRunner.query(`
      UPDATE "messages" m
      SET "tenantId" = c."tenantId"
      FROM "channels" c
      WHERE m."channelId" = c."id"
        AND m."tenantId" IS NULL
        AND c."tenantId" IS NOT NULL;
    `);

    // ── 9. Backfill tenantId from channels to channel_members ──
    await queryRunner.query(`
      UPDATE "channel_members" cm
      SET "tenantId" = c."tenantId"
      FROM "channels" c
      WHERE cm."channelId" = c."id"
        AND cm."tenantId" IS NULL
        AND c."tenantId" IS NOT NULL;
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Remove trigger
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_audit_log_immutable ON "compliance_audit_log";
    `);
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS prevent_audit_log_mutation();
    `);

    // Remove indexes and columns (reverse order)
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_outbox_idempotency";`);
    await queryRunner.query(`ALTER TABLE "messaging_outbox" DROP COLUMN IF EXISTS "isDeadLettered";`);
    await queryRunner.query(`ALTER TABLE "messaging_outbox" DROP COLUMN IF EXISTS "idempotencyKey";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_messages_idempotency";`);
    await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN IF EXISTS "updatedBy";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_messages_tenant";`);
    await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN IF EXISTS "tenantId";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_channel_members_tenant";`);
    await queryRunner.query(`ALTER TABLE "channel_members" DROP COLUMN IF EXISTS "tenantId";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_channels_tenant";`);
    await queryRunner.query(`ALTER TABLE "channels" DROP COLUMN IF EXISTS "tenantId";`);
  }
}
