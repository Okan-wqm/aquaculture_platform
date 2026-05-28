import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Enterprise tenant-isolation hardening for messaging.
 *
 * IMPORTANT: DDL is intentionally tenant-relative/unqualified. The platform
 * migration runner fans migrations out through source + tenant schemas by
 * pinning search_path; hard-coding "messaging".table would bypass that model.
 */
export class HardenMessagingTenantIsolation1800400000000 implements MigrationInterface {
  name = 'HardenMessagingTenantIsolation1800400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "tenant_principals" (
        "tenantId" uuid NOT NULL,
        "userId" uuid NOT NULL,
        "kind" varchar(20) NOT NULL,
        "isActive" boolean NOT NULL DEFAULT true,
        "source" varchar(20) NOT NULL,
        "lastValidatedAt" timestamptz,
        "deactivatedAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_tenant_principals" PRIMARY KEY ("tenantId", "userId"),
        CONSTRAINT "chk_tenant_principals_kind" CHECK ("kind" IN ('USER', 'ANONYMOUS', 'SYSTEM_AI')),
        CONSTRAINT "chk_tenant_principals_source" CHECK ("source" IN ('AUTH', 'SYSTEM', 'REMEDIATION'))
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_tenant_principals_kind_active"
      ON "tenant_principals" ("tenantId", "kind", "isActive")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "message_send_idempotency" (
        "tenantId" uuid NOT NULL,
        "channelId" uuid NOT NULL,
        "senderId" uuid NOT NULL,
        "idempotencyKey" uuid NOT NULL,
        "messageId" uuid NOT NULL,
        "messageCreatedAt" timestamptz NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_message_send_idempotency" PRIMARY KEY ("tenantId", "channelId", "senderId", "idempotencyKey")
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "message_send_idempotency"
        ADD COLUMN IF NOT EXISTS "channelId" uuid,
        ADD COLUMN IF NOT EXISTS "senderId" uuid
    `);

    await queryRunner.query(`
      UPDATE "message_send_idempotency" i
      SET "channelId" = m."channelId",
          "senderId" = m."senderId"
      FROM "messages" m
      WHERE i."tenantId" = m."tenantId"
        AND i."messageId" = m."id"
        AND i."messageCreatedAt" = m."createdAt"
        AND (i."channelId" IS NULL OR i."senderId" IS NULL)
    `);

    await queryRunner.query(`
      DELETE FROM "message_send_idempotency"
      WHERE "channelId" IS NULL OR "senderId" IS NULL
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'message_send_idempotency'
            AND column_name = 'channelId'
            AND is_nullable = 'YES'
        ) THEN
          ALTER TABLE "message_send_idempotency" ALTER COLUMN "channelId" SET NOT NULL;
        END IF;

        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'message_send_idempotency'
            AND column_name = 'senderId'
            AND is_nullable = 'YES'
        ) THEN
          ALTER TABLE "message_send_idempotency" ALTER COLUMN "senderId" SET NOT NULL;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'pk_message_send_idempotency'
            AND conrelid = 'message_send_idempotency'::regclass
        ) THEN
          ALTER TABLE "message_send_idempotency" DROP CONSTRAINT "pk_message_send_idempotency";
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      ALTER TABLE "message_send_idempotency"
      ADD CONSTRAINT "pk_message_send_idempotency"
      PRIMARY KEY ("tenantId", "channelId", "senderId", "idempotencyKey")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_message_send_idempotency_message"
      ON "message_send_idempotency" ("tenantId", "messageId", "messageCreatedAt")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "message_read_receipt_keys" (
        "tenantId" uuid NOT NULL,
        "messageId" uuid NOT NULL,
        "messageCreatedAt" timestamptz NOT NULL,
        "userId" uuid NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_message_read_receipt_keys"
          PRIMARY KEY ("tenantId", "messageId", "messageCreatedAt", "userId")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "tenant_isolation_remediation_log" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "tableName" varchar(128) NOT NULL,
        "rowId" text NOT NULL,
        "action" varchar(64) NOT NULL,
        "reason" text NOT NULL,
        "rowSnapshot" jsonb NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_tenant_isolation_remediation_log" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_tenant_isolation_remediation_log_tenant_created"
      ON "tenant_isolation_remediation_log" ("tenantId", "createdAt" DESC)
    `);

    await queryRunner.query(`
      INSERT INTO "tenant_principals" ("tenantId", "userId", "kind", "isActive", "source", "lastValidatedAt")
      SELECT DISTINCT "tenantId", "userId", 'USER', true, 'REMEDIATION', now()
      FROM "channel_members"
      WHERE "tenantId" IS NOT NULL AND "userId" IS NOT NULL
      ON CONFLICT ("tenantId", "userId") DO NOTHING
    `);

    await queryRunner.query(`
      INSERT INTO "tenant_principals" ("tenantId", "userId", "kind", "isActive", "source", "lastValidatedAt")
      SELECT DISTINCT "tenantId", "senderId", 'USER', true, 'REMEDIATION', now()
      FROM "messages"
      WHERE "tenantId" IS NOT NULL AND "senderId" IS NOT NULL
      ON CONFLICT ("tenantId", "userId") DO NOTHING
    `);

    await queryRunner.query(`
      INSERT INTO "tenant_principals" ("tenantId", "userId", "kind", "isActive", "source", "lastValidatedAt")
      SELECT DISTINCT "tenantId", "createdBy", 'USER', true, 'REMEDIATION', now()
      FROM "channels"
      WHERE "tenantId" IS NOT NULL AND "createdBy" IS NOT NULL
      ON CONFLICT ("tenantId", "userId") DO NOTHING
    `);

    await queryRunner.query(`
      INSERT INTO "tenant_principals" ("tenantId", "userId", "kind", "isActive", "source", "lastValidatedAt")
      SELECT DISTINCT "tenantId", "userId", 'USER', true, 'REMEDIATION', now()
      FROM "message_receipts"
      WHERE "tenantId" IS NOT NULL AND "userId" IS NOT NULL
      ON CONFLICT ("tenantId", "userId") DO NOTHING
    `);

    await queryRunner.query(`
      INSERT INTO "tenant_principals" ("tenantId", "userId", "kind", "isActive", "source", "lastValidatedAt")
      SELECT DISTINCT "tenantId", "userId", 'USER', true, 'REMEDIATION', now()
      FROM "message_reactions"
      WHERE "tenantId" IS NOT NULL AND "userId" IS NOT NULL
      ON CONFLICT ("tenantId", "userId") DO NOTHING
    `);

    await queryRunner.query(`
      INSERT INTO "tenant_principals" ("tenantId", "userId", "kind", "isActive", "source", "lastValidatedAt")
      SELECT DISTINCT "tenantId", "pinnedBy", 'USER', true, 'REMEDIATION', now()
      FROM "pinned_messages"
      WHERE "tenantId" IS NOT NULL AND "pinnedBy" IS NOT NULL
      ON CONFLICT ("tenantId", "userId") DO NOTHING
    `);

    await queryRunner.query(`
      WITH tenants AS (
        SELECT "tenantId" FROM "channels"
        UNION SELECT "tenantId" FROM "messages"
        UNION SELECT "tenantId" FROM "channel_members"
      )
      INSERT INTO "tenant_principals" ("tenantId", "userId", "kind", "isActive", "source")
      SELECT "tenantId", '00000000-0000-0000-0000-000000000000'::uuid, 'ANONYMOUS', true, 'SYSTEM'
      FROM tenants WHERE "tenantId" IS NOT NULL
      ON CONFLICT ("tenantId", "userId") DO NOTHING
    `);

    await queryRunner.query(`
      WITH tenants AS (
        SELECT "tenantId" FROM "channels"
        UNION SELECT "tenantId" FROM "messages"
        UNION SELECT "tenantId" FROM "channel_members"
      )
      INSERT INTO "tenant_principals" ("tenantId", "userId", "kind", "isActive", "source")
      SELECT "tenantId", '00000000-0000-0000-0000-000000000001'::uuid, 'SYSTEM_AI', true, 'SYSTEM'
      FROM tenants WHERE "tenantId" IS NOT NULL
      ON CONFLICT ("tenantId", "userId") DO NOTHING
    `);

    await queryRunner.query(`
      INSERT INTO "message_send_idempotency"
        ("tenantId", "channelId", "senderId", "idempotencyKey", "messageId", "messageCreatedAt")
      SELECT DISTINCT ON ("tenantId", "channelId", "senderId", "idempotencyKey")
        "tenantId", "channelId", "senderId", "idempotencyKey", "id", "createdAt"
      FROM "messages"
      WHERE "tenantId" IS NOT NULL AND "idempotencyKey" IS NOT NULL
      ORDER BY "tenantId", "channelId", "senderId", "idempotencyKey", "createdAt" ASC
      ON CONFLICT ("tenantId", "channelId", "senderId", "idempotencyKey") DO NOTHING
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'UQ_f09d2340f139791474c776042a8'
            AND conrelid = 'channels'::regclass
        ) THEN
          ALTER TABLE "channels" DROP CONSTRAINT "UQ_f09d2340f139791474c776042a8";
        END IF;
      END $$;
    `);

    await queryRunner.query(`DROP INDEX IF EXISTS "idx_messages_idempotency"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_messages_tenant_idempotency"`);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_messages_tenant_idempotency_lookup"
      ON "messages" ("tenantId", "channelId", "senderId", "idempotencyKey")
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'uq_channel_member'
            AND conrelid = 'channel_members'::regclass
        ) THEN
          ALTER TABLE "channel_members" DROP CONSTRAINT "uq_channel_member";
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_channels_tenant_dm_pair"
      ON "channels" ("tenantId", "dmPairKey")
      WHERE "dmPairKey" IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_channel_members_tenant_channel_user"
      ON "channel_members" ("tenantId", "channelId", "userId")
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_messages_tenant_id_created"
      ON "messages" ("tenantId", "id", "createdAt")
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_channels_tenant_id"
      ON "channels" ("tenantId", "id")
    `);

    await this.addConstraintIfMissing(
      queryRunner,
      'channel_members',
      'fk_channel_members_channel_tenant',
      `FOREIGN KEY ("tenantId", "channelId") REFERENCES "channels" ("tenantId", "id") ON DELETE CASCADE NOT VALID`,
    );
    await this.addConstraintIfMissing(
      queryRunner,
      'messages',
      'fk_messages_channel_tenant',
      `FOREIGN KEY ("tenantId", "channelId") REFERENCES "channels" ("tenantId", "id") ON DELETE CASCADE NOT VALID`,
    );
    await this.addConstraintIfMissing(
      queryRunner,
      'message_attachments',
      'fk_message_attachments_message_tenant',
      `FOREIGN KEY ("tenantId", "messageId", "messageCreatedAt") REFERENCES "messages" ("tenantId", "id", "createdAt") ON DELETE CASCADE NOT VALID`,
    );
    await this.addConstraintIfMissing(
      queryRunner,
      'message_receipts',
      'fk_message_receipts_message_tenant',
      `FOREIGN KEY ("tenantId", "messageId", "messageCreatedAt") REFERENCES "messages" ("tenantId", "id", "createdAt") ON DELETE CASCADE NOT VALID`,
    );
    await this.addConstraintIfMissing(
      queryRunner,
      'message_reactions',
      'fk_message_reactions_message_tenant',
      `FOREIGN KEY ("tenantId", "messageId", "messageCreatedAt") REFERENCES "messages" ("tenantId", "id", "createdAt") ON DELETE CASCADE NOT VALID`,
    );
    await this.addConstraintIfMissing(
      queryRunner,
      'pinned_messages',
      'fk_pinned_messages_channel_tenant',
      `FOREIGN KEY ("tenantId", "channelId") REFERENCES "channels" ("tenantId", "id") ON DELETE CASCADE NOT VALID`,
    );
    await this.addConstraintIfMissing(
      queryRunner,
      'pinned_messages',
      'fk_pinned_messages_message_tenant',
      `FOREIGN KEY ("tenantId", "messageId", "messageCreatedAt") REFERENCES "messages" ("tenantId", "id", "createdAt") ON DELETE CASCADE NOT VALID`,
    );

    await this.addConstraintIfMissing(
      queryRunner,
      'channels',
      'fk_channels_created_by_tenant_principals',
      `FOREIGN KEY ("tenantId", "createdBy") REFERENCES "tenant_principals" ("tenantId", "userId") NOT VALID`,
    );
    await this.addConstraintIfMissing(
      queryRunner,
      'channel_members',
      'fk_channel_members_user_tenant_principals',
      `FOREIGN KEY ("tenantId", "userId") REFERENCES "tenant_principals" ("tenantId", "userId") NOT VALID`,
    );
    await this.addConstraintIfMissing(
      queryRunner,
      'messages',
      'fk_messages_sender_tenant_principals',
      `FOREIGN KEY ("tenantId", "senderId") REFERENCES "tenant_principals" ("tenantId", "userId") NOT VALID`,
    );
    await this.addConstraintIfMissing(
      queryRunner,
      'message_receipts',
      'fk_message_receipts_user_tenant_principals',
      `FOREIGN KEY ("tenantId", "userId") REFERENCES "tenant_principals" ("tenantId", "userId") NOT VALID`,
    );
    await this.addConstraintIfMissing(
      queryRunner,
      'message_reactions',
      'fk_message_reactions_user_tenant_principals',
      `FOREIGN KEY ("tenantId", "userId") REFERENCES "tenant_principals" ("tenantId", "userId") NOT VALID`,
    );
    await this.addConstraintIfMissing(
      queryRunner,
      'pinned_messages',
      'fk_pinned_messages_user_tenant_principals',
      `FOREIGN KEY ("tenantId", "pinnedBy") REFERENCES "tenant_principals" ("tenantId", "userId") NOT VALID`,
    );
    await this.addConstraintIfMissing(
      queryRunner,
      'message_send_idempotency',
      'fk_message_send_idempotency_message',
      `FOREIGN KEY ("tenantId", "messageId", "messageCreatedAt") REFERENCES "messages" ("tenantId", "id", "createdAt") ON DELETE CASCADE NOT VALID`,
    );
    await this.addConstraintIfMissing(
      queryRunner,
      'message_read_receipt_keys',
      'fk_message_read_receipt_keys_message',
      `FOREIGN KEY ("tenantId", "messageId", "messageCreatedAt") REFERENCES "messages" ("tenantId", "id", "createdAt") ON DELETE CASCADE NOT VALID`,
    );
    await this.addConstraintIfMissing(
      queryRunner,
      'message_read_receipt_keys',
      'fk_message_read_receipt_keys_user_tenant_principals',
      `FOREIGN KEY ("tenantId", "userId") REFERENCES "tenant_principals" ("tenantId", "userId") NOT VALID`,
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Production-safe rollback policy: tenant-isolation hardening is
    // forward-only. Rolling back the app image is allowed; dropping security
    // FKs, idempotency tables, or principal projections is not.
  }

  private async addConstraintIfMissing(
    queryRunner: QueryRunner,
    tableName: string,
    constraintName: string,
    constraintSql: string,
  ): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('"${tableName}"') IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = '${constraintName}'
            AND conrelid = to_regclass('"${tableName}"')
        ) THEN
          ALTER TABLE "${tableName}" ADD CONSTRAINT "${constraintName}" ${constraintSql};
        END IF;
      END $$;
    `);
  }

}
