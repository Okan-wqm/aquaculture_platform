import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  MigrationLogger,
  tableExists,
} from '@aquaculture/backend-common/database';

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
 *
 * # Bootstrap-restoration guards (Wave 4-A.2 Dalga 3)
 *
 * Each ALTER block below references a table created by sibling
 * baseline migrations (channels, channel_members, messages,
 * messaging_outbox by 1711800000000-CreateMessagingTables;
 * compliance_audit_log by 1711800000003-CreateComplianceTables).
 * On fresh-volume bootstrap the ALTER blocks crash if any of those
 * tables are absent. Each block is now wrapped with `tableExists`;
 * legacy DBs behave identically, fresh DBs proceed once the parent
 * tables are in place.
 */
export class AddTenantIsolationAndAuditImmutability1782000000000
  implements MigrationInterface
{
  name = 'AddTenantIsolationAndAuditImmutability1782000000000';

  private readonly logger = new MigrationLogger(
    'AddTenantIsolationAndAuditImmutability1782000000000',
  );

  async up(queryRunner: QueryRunner): Promise<void> {
    const hasChannels = await tableExists(queryRunner, 'channels');
    const hasChannelMembers = await tableExists(queryRunner, 'channel_members');
    const hasMessages = await tableExists(queryRunner, 'messages');
    const hasOutbox = await tableExists(queryRunner, 'messaging_outbox');
    const hasComplianceAuditLog = await tableExists(
      queryRunner,
      'compliance_audit_log',
    );

    // ── 1. Add tenantId to channels ──
    if (hasChannels) {
      await queryRunner.query(`
        ALTER TABLE "channels"
        ADD COLUMN IF NOT EXISTS "tenantId" uuid;
      `);
      await queryRunner.query(`
        CREATE INDEX IF NOT EXISTS "idx_channels_tenant"
        ON "channels" ("tenantId");
      `);
    } else {
      this.logger.log(
        'Skipping channels tenantId — channels table not present on this DB (installed by sibling baseline migration)',
      );
    }

    // ── 2. Add tenantId to channel_members ──
    if (hasChannelMembers) {
      await queryRunner.query(`
        ALTER TABLE "channel_members"
        ADD COLUMN IF NOT EXISTS "tenantId" uuid;
      `);
      await queryRunner.query(`
        CREATE INDEX IF NOT EXISTS "idx_channel_members_tenant"
        ON "channel_members" ("tenantId");
      `);
    } else {
      this.logger.log(
        'Skipping channel_members tenantId — channel_members table not present on this DB (installed by sibling baseline migration)',
      );
    }

    // ── 3. Add tenantId to messages + 4/4b/5 message column blocks ──
    if (hasMessages) {
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
    } else {
      this.logger.log(
        'Skipping messages tenant/idempotency block — messages table not present on this DB (installed by sibling baseline migration)',
      );
    }

    // ── 6. Add tenantId, idempotencyKey and isDeadLettered to messaging_outbox ──
    // WHY: messaging_outbox was created before tenant isolation was added.
    // tenantId is required for per-tenant event routing and dead-letter metrics.
    if (hasOutbox) {
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
    } else {
      this.logger.log(
        'Skipping messaging_outbox tenant/idempotency block — messaging_outbox table not present on this DB (installed by sibling baseline migration)',
      );
    }

    // ── 7. Audit log immutability trigger ──
    // SECURITY: Makes UPDATE and DELETE on compliance_audit_log structurally
    // impossible at the database level. Even superusers with direct DB access
    // must DROP the trigger before they can tamper with audit records.
    // @see MSG-HIGH-021
    if (hasComplianceAuditLog) {
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
    } else {
      this.logger.log(
        'Skipping compliance_audit_log immutability trigger — table not present on this DB (installed by sibling baseline migration)',
      );
    }

    // ── 8. Backfill tenantId from channels to messages (for existing data) ──
    // This is safe because messages.channelId references channels.id
    if (hasChannels && hasMessages) {
      await queryRunner.query(`
        UPDATE "messages" m
        SET "tenantId" = c."tenantId"
        FROM "channels" c
        WHERE m."channelId" = c."id"
          AND m."tenantId" IS NULL
          AND c."tenantId" IS NOT NULL;
      `);
    }

    // ── 9. Backfill tenantId from channels to channel_members ──
    if (hasChannels && hasChannelMembers) {
      await queryRunner.query(`
        UPDATE "channel_members" cm
        SET "tenantId" = c."tenantId"
        FROM "channels" c
        WHERE cm."channelId" = c."id"
          AND cm."tenantId" IS NULL
          AND c."tenantId" IS NOT NULL;
      `);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Remove trigger
    if (await tableExists(queryRunner, 'compliance_audit_log')) {
      await queryRunner.query(`
        DROP TRIGGER IF EXISTS trg_audit_log_immutable ON "compliance_audit_log";
      `);
    }
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS prevent_audit_log_mutation();
    `);

    // Remove indexes and columns (reverse order)
    if (await tableExists(queryRunner, 'messaging_outbox')) {
      await queryRunner.query(`DROP INDEX IF EXISTS "idx_outbox_idempotency";`);
      await queryRunner.query(`ALTER TABLE "messaging_outbox" DROP COLUMN IF EXISTS "isDeadLettered";`);
      await queryRunner.query(`ALTER TABLE "messaging_outbox" DROP COLUMN IF EXISTS "idempotencyKey";`);
    }
    if (await tableExists(queryRunner, 'messages')) {
      await queryRunner.query(`DROP INDEX IF EXISTS "idx_messages_idempotency";`);
      await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN IF EXISTS "updatedBy";`);
      await queryRunner.query(`DROP INDEX IF EXISTS "idx_messages_tenant";`);
      await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN IF EXISTS "tenantId";`);
    }
    if (await tableExists(queryRunner, 'channel_members')) {
      await queryRunner.query(`DROP INDEX IF EXISTS "idx_channel_members_tenant";`);
      await queryRunner.query(`ALTER TABLE "channel_members" DROP COLUMN IF EXISTS "tenantId";`);
    }
    if (await tableExists(queryRunner, 'channels')) {
      await queryRunner.query(`DROP INDEX IF EXISTS "idx_channels_tenant";`);
      await queryRunner.query(`ALTER TABLE "channels" DROP COLUMN IF EXISTS "tenantId";`);
    }
  }
}
