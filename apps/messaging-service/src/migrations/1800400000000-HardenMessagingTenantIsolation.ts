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

    await this.recordPreflightFindings(queryRunner);
    await this.dropLegacyNonTenantForeignKeys(queryRunner);
    await this.remediateBlockingFindings(queryRunner);

    await queryRunner.query(`
      DELETE FROM "message_send_idempotency"
      WHERE "channelId" IS NULL OR "senderId" IS NULL
    `);

    await queryRunner.query(`
      WITH ranked AS (
        SELECT ctid,
               row_number() OVER (
                 PARTITION BY "tenantId", "channelId", "senderId", "idempotencyKey"
                 ORDER BY "createdAt" ASC, "messageCreatedAt" ASC, "messageId" ASC
               ) AS rn
        FROM "message_send_idempotency"
        WHERE "channelId" IS NOT NULL AND "senderId" IS NOT NULL
      )
      DELETE FROM "message_send_idempotency" i
      USING ranked r
      WHERE i.ctid = r.ctid AND r.rn > 1
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

    await this.dropConstraintIfExists(
      queryRunner,
      'message_reactions',
      'uq_reaction_message_user_emoji',
    );
    await this.dropConstraintIfExists(queryRunner, 'pinned_messages', 'uq_pin_channel_message');
    await this.dropConstraintIfExists(
      queryRunner,
      'message_entity_references',
      'uq_message_entity',
    );

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
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_message_reactions_tenant_message_user_emoji"
      ON "message_reactions" ("tenantId", "messageId", "messageCreatedAt", "userId", "emoji")
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_pinned_messages_tenant_channel_message"
      ON "pinned_messages" ("tenantId", "channelId", "messageId", "messageCreatedAt")
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_message_entity_refs_tenant_message_entity"
      ON "message_entity_references" ("tenantId", "messageId", "messageCreatedAt", "entityType", "entityId")
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
    await this.addConstraintIfMissing(
      queryRunner,
      'message_analysis',
      'fk_message_analysis_message_tenant',
      `FOREIGN KEY ("tenantId", "messageId", "messageCreatedAt") REFERENCES "messages" ("tenantId", "id", "createdAt") ON DELETE CASCADE NOT VALID`,
    );
    await this.addConstraintIfMissing(
      queryRunner,
      'message_entity_references',
      'fk_message_entity_references_message_tenant',
      `FOREIGN KEY ("tenantId", "messageId", "messageCreatedAt") REFERENCES "messages" ("tenantId", "id", "createdAt") ON DELETE CASCADE NOT VALID`,
    );
    await this.addConstraintIfMissing(
      queryRunner,
      'knowledge_entries',
      'fk_knowledge_entries_message_tenant',
      `FOREIGN KEY ("tenantId", "sourceMessageId", "sourceMessageCreatedAt") REFERENCES "messages" ("tenantId", "id", "createdAt") ON DELETE SET NULL ("sourceMessageId", "sourceMessageCreatedAt") NOT VALID`,
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

  private async dropConstraintIfExists(
    queryRunner: QueryRunner,
    tableName: string,
    constraintName: string,
  ): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('"${tableName}"') IS NOT NULL AND EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = '${constraintName}'
            AND conrelid = to_regclass('"${tableName}"')
        ) THEN
          ALTER TABLE "${tableName}" DROP CONSTRAINT "${constraintName}";
        END IF;
      END $$;
    `);
  }

  private async dropLegacyNonTenantForeignKeys(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE
        fk record;
      BEGIN
        FOR fk IN
          SELECT con.conname,
                 rel.relname AS table_name,
                 array_agg(att.attname ORDER BY ord.ordinality) AS child_columns
          FROM pg_constraint con
          JOIN pg_class rel ON rel.oid = con.conrelid
          JOIN pg_namespace ns ON ns.oid = rel.relnamespace
          JOIN unnest(con.conkey) WITH ORDINALITY AS ord(attnum, ordinality) ON true
          JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = ord.attnum
          JOIN pg_class parent_rel ON parent_rel.oid = con.confrelid
          JOIN pg_namespace parent_ns ON parent_ns.oid = parent_rel.relnamespace
          WHERE con.contype = 'f'
            AND ns.nspname = current_schema()
            AND parent_ns.nspname = current_schema()
            AND rel.relname IN (
              'channel_members',
              'messages',
              'message_attachments',
              'message_receipts',
              'message_reactions',
              'pinned_messages',
              'message_analysis',
              'message_entity_references',
              'knowledge_entries',
              'message_send_idempotency',
              'message_read_receipt_keys'
            )
            AND parent_rel.relname IN ('channels', 'messages', 'tenant_principals')
          GROUP BY con.conname, con.conrelid, rel.relname
          HAVING NOT bool_or(att.attname = 'tenantId')
        LOOP
          INSERT INTO "tenant_isolation_remediation_log"
            ("tenantId", "tableName", "rowId", "action", "reason", "rowSnapshot")
          VALUES (
            '00000000-0000-0000-0000-000000000000'::uuid,
            fk.table_name,
            fk.conname,
            'DROP_LEGACY_FK',
            'legacy_non_tenant_foreign_key',
            jsonb_build_object('constraint', fk.conname, 'childColumns', fk.child_columns)
          );

          EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', fk.table_name, fk.conname);
        END LOOP;
      END $$;
    `);
  }

  private async remediateBlockingFindings(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TEMP TABLE IF NOT EXISTS tmp_messaging_duplicate_channels ON COMMIT DROP AS
      WITH ranked AS (
        SELECT "tenantId",
               "dmPairKey",
               "id" AS duplicate_channel_id,
               first_value("id") OVER (
                 PARTITION BY "tenantId", "dmPairKey"
                 ORDER BY "createdAt" ASC, "id" ASC
               ) AS keep_channel_id,
               row_number() OVER (
                 PARTITION BY "tenantId", "dmPairKey"
                 ORDER BY "createdAt" ASC, "id" ASC
               ) AS rn
        FROM "channels"
        WHERE "dmPairKey" IS NOT NULL
      )
      SELECT "tenantId", "dmPairKey", duplicate_channel_id, keep_channel_id
      FROM ranked
      WHERE rn > 1
    `);

    await queryRunner.query(`
      INSERT INTO "tenant_isolation_remediation_log"
        ("tenantId", "tableName", "rowId", "action", "reason", "rowSnapshot")
      SELECT c."tenantId",
             'channels',
             c.duplicate_channel_id::text,
             'MERGE_DUPLICATE_DM_CHANNEL',
             'duplicate_direct_message_pair',
             jsonb_build_object(
               'dmPairKey', c."dmPairKey",
               'duplicateChannelId', c.duplicate_channel_id,
               'keepChannelId', c.keep_channel_id
             )
      FROM tmp_messaging_duplicate_channels c
    `);

    await queryRunner.query(`
      DELETE FROM "channel_members" m
      USING tmp_messaging_duplicate_channels c
      WHERE m."tenantId" = c."tenantId"
        AND m."channelId" = c.duplicate_channel_id
        AND EXISTS (
          SELECT 1
          FROM "channel_members" keep
          WHERE keep."tenantId" = m."tenantId"
            AND keep."channelId" = c.keep_channel_id
            AND keep."userId" = m."userId"
        )
    `);

    await queryRunner.query(`
      UPDATE "channel_members" m
      SET "channelId" = c.keep_channel_id
      FROM tmp_messaging_duplicate_channels c
      WHERE m."tenantId" = c."tenantId"
        AND m."channelId" = c.duplicate_channel_id
    `);

    await queryRunner.query(`
      UPDATE "messages" m
      SET "channelId" = c.keep_channel_id
      FROM tmp_messaging_duplicate_channels c
      WHERE m."tenantId" = c."tenantId"
        AND m."channelId" = c.duplicate_channel_id
    `);

    await queryRunner.query(`
      DELETE FROM "pinned_messages" p
      USING tmp_messaging_duplicate_channels c
      WHERE p."tenantId" = c."tenantId"
        AND p."channelId" = c.duplicate_channel_id
        AND EXISTS (
          SELECT 1
          FROM "pinned_messages" keep
          WHERE keep."tenantId" = p."tenantId"
            AND keep."channelId" = c.keep_channel_id
            AND keep."messageId" = p."messageId"
            AND keep."messageCreatedAt" = p."messageCreatedAt"
        )
    `);

    await queryRunner.query(`
      UPDATE "pinned_messages" p
      SET "channelId" = c.keep_channel_id
      FROM tmp_messaging_duplicate_channels c
      WHERE p."tenantId" = c."tenantId"
        AND p."channelId" = c.duplicate_channel_id
    `);

    await queryRunner.query(`
      DELETE FROM "channels" ch
      USING tmp_messaging_duplicate_channels c
      WHERE ch."tenantId" = c."tenantId"
        AND ch."id" = c.duplicate_channel_id
    `);

    await queryRunner.query(`
      WITH ranked AS (
        SELECT ctid,
               row_number() OVER (
                 PARTITION BY "tenantId", "channelId", "userId"
                 ORDER BY
                   CASE WHEN "leftAt" IS NULL THEN 0 ELSE 1 END,
                   CASE "role" WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
                   "joinedAt" ASC,
                   "id" ASC
               ) AS rn
        FROM "channel_members"
      )
      DELETE FROM "channel_members" m
      USING ranked r
      WHERE m.ctid = r.ctid AND r.rn > 1
    `);

    await queryRunner.query(`
      UPDATE "messages" m
      SET "tenantId" = c."tenantId"
      FROM "channels" c
      WHERE m."channelId" = c."id"
        AND m."tenantId" <> c."tenantId"
    `);

    await queryRunner.query(`
      DELETE FROM "messages" m
      WHERE NOT EXISTS (
        SELECT 1
        FROM "channels" c
        WHERE c."tenantId" = m."tenantId"
          AND c."id" = m."channelId"
      )
    `);

    await queryRunner.query(`
      CREATE TEMP TABLE IF NOT EXISTS tmp_messaging_duplicate_messages ON COMMIT DROP AS
      WITH ranked AS (
        SELECT "tenantId",
               "channelId",
               "senderId",
               "idempotencyKey",
               "id" AS duplicate_message_id,
               "createdAt" AS duplicate_message_created_at,
               first_value("id") OVER (
                 PARTITION BY "tenantId", "channelId", "senderId", "idempotencyKey"
                 ORDER BY "createdAt" ASC, "id" ASC
               ) AS keep_message_id,
               first_value("createdAt") OVER (
                 PARTITION BY "tenantId", "channelId", "senderId", "idempotencyKey"
                 ORDER BY "createdAt" ASC, "id" ASC
               ) AS keep_message_created_at,
               row_number() OVER (
                 PARTITION BY "tenantId", "channelId", "senderId", "idempotencyKey"
                 ORDER BY "createdAt" ASC, "id" ASC
               ) AS rn
        FROM "messages"
        WHERE "idempotencyKey" IS NOT NULL
      )
      SELECT *
      FROM ranked
      WHERE rn > 1
    `);

    await queryRunner.query(`
      INSERT INTO "tenant_isolation_remediation_log"
        ("tenantId", "tableName", "rowId", "action", "reason", "rowSnapshot")
      SELECT d."tenantId",
             'messages',
             d.duplicate_message_id::text,
             'MERGE_DUPLICATE_SEND_IDEMPOTENCY',
             'duplicate_send_idempotency_key',
             jsonb_build_object(
               'channelId', d."channelId",
               'senderId', d."senderId",
               'idempotencyKey', d."idempotencyKey",
               'duplicateMessageId', d.duplicate_message_id,
               'duplicateMessageCreatedAt', d.duplicate_message_created_at,
               'keepMessageId', d.keep_message_id,
               'keepMessageCreatedAt', d.keep_message_created_at
             )
      FROM tmp_messaging_duplicate_messages d
    `);

    await queryRunner.query(`
      UPDATE "message_attachments" a
      SET "tenantId" = d."tenantId",
          "messageId" = d.keep_message_id,
          "messageCreatedAt" = d.keep_message_created_at
      FROM tmp_messaging_duplicate_messages d
      WHERE a."messageId" = d.duplicate_message_id
        AND a."messageCreatedAt" = d.duplicate_message_created_at
    `);

    await queryRunner.query(`
      UPDATE "message_receipts" r
      SET "tenantId" = d."tenantId",
          "messageId" = d.keep_message_id,
          "messageCreatedAt" = d.keep_message_created_at
      FROM tmp_messaging_duplicate_messages d
      WHERE r."messageId" = d.duplicate_message_id
        AND r."messageCreatedAt" = d.duplicate_message_created_at
    `);

    await queryRunner.query(`
      DELETE FROM "message_reactions" r
      USING tmp_messaging_duplicate_messages d
      WHERE r."messageId" = d.duplicate_message_id
        AND r."messageCreatedAt" = d.duplicate_message_created_at
        AND EXISTS (
          SELECT 1
          FROM "message_reactions" keep
          WHERE keep."tenantId" = d."tenantId"
            AND keep."messageId" = d.keep_message_id
            AND keep."messageCreatedAt" = d.keep_message_created_at
            AND keep."userId" = r."userId"
            AND keep."emoji" = r."emoji"
        )
    `);

    await queryRunner.query(`
      UPDATE "message_reactions" r
      SET "tenantId" = d."tenantId",
          "messageId" = d.keep_message_id,
          "messageCreatedAt" = d.keep_message_created_at
      FROM tmp_messaging_duplicate_messages d
      WHERE r."messageId" = d.duplicate_message_id
        AND r."messageCreatedAt" = d.duplicate_message_created_at
    `);

    await queryRunner.query(`
      DELETE FROM "pinned_messages" p
      USING tmp_messaging_duplicate_messages d
      WHERE p."messageId" = d.duplicate_message_id
        AND p."messageCreatedAt" = d.duplicate_message_created_at
        AND EXISTS (
          SELECT 1
          FROM "pinned_messages" keep
          WHERE keep."tenantId" = d."tenantId"
            AND keep."channelId" = p."channelId"
            AND keep."messageId" = d.keep_message_id
            AND keep."messageCreatedAt" = d.keep_message_created_at
        )
    `);

    await queryRunner.query(`
      UPDATE "pinned_messages" p
      SET "tenantId" = d."tenantId",
          "messageId" = d.keep_message_id,
          "messageCreatedAt" = d.keep_message_created_at
      FROM tmp_messaging_duplicate_messages d
      WHERE p."messageId" = d.duplicate_message_id
        AND p."messageCreatedAt" = d.duplicate_message_created_at
    `);

    await queryRunner.query(`
      UPDATE "message_analysis" a
      SET "tenantId" = d."tenantId",
          "messageId" = d.keep_message_id,
          "messageCreatedAt" = d.keep_message_created_at
      FROM tmp_messaging_duplicate_messages d
      WHERE a."messageId" = d.duplicate_message_id
        AND a."messageCreatedAt" = d.duplicate_message_created_at
    `);

    await queryRunner.query(`
      DELETE FROM "message_entity_references" e
      USING tmp_messaging_duplicate_messages d
      WHERE e."messageId" = d.duplicate_message_id
        AND e."messageCreatedAt" = d.duplicate_message_created_at
        AND EXISTS (
          SELECT 1
          FROM "message_entity_references" keep
          WHERE keep."tenantId" = d."tenantId"
            AND keep."messageId" = d.keep_message_id
            AND keep."messageCreatedAt" = d.keep_message_created_at
            AND keep."entityType" = e."entityType"
            AND keep."entityId" = e."entityId"
        )
    `);

    await queryRunner.query(`
      UPDATE "message_entity_references" e
      SET "tenantId" = d."tenantId",
          "messageId" = d.keep_message_id,
          "messageCreatedAt" = d.keep_message_created_at
      FROM tmp_messaging_duplicate_messages d
      WHERE e."messageId" = d.duplicate_message_id
        AND e."messageCreatedAt" = d.duplicate_message_created_at
    `);

    await queryRunner.query(`
      UPDATE "knowledge_entries" k
      SET "tenantId" = d."tenantId",
          "sourceMessageId" = d.keep_message_id,
          "sourceMessageCreatedAt" = d.keep_message_created_at
      FROM tmp_messaging_duplicate_messages d
      WHERE k."sourceMessageId" = d.duplicate_message_id
        AND k."sourceMessageCreatedAt" = d.duplicate_message_created_at
    `);

    await queryRunner.query(`
      UPDATE "message_send_idempotency" i
      SET "tenantId" = d."tenantId",
          "messageId" = d.keep_message_id,
          "messageCreatedAt" = d.keep_message_created_at,
          "channelId" = d."channelId",
          "senderId" = d."senderId"
      FROM tmp_messaging_duplicate_messages d
      WHERE i."messageId" = d.duplicate_message_id
        AND i."messageCreatedAt" = d.duplicate_message_created_at
    `);

    await queryRunner.query(`
      DELETE FROM "messages" m
      USING tmp_messaging_duplicate_messages d
      WHERE m."id" = d.duplicate_message_id
        AND m."createdAt" = d.duplicate_message_created_at
    `);

    await queryRunner.query(`
      UPDATE "message_attachments" a
      SET "tenantId" = m."tenantId"
      FROM "messages" m
      WHERE a."messageId" = m."id"
        AND a."messageCreatedAt" = m."createdAt"
        AND a."tenantId" <> m."tenantId"
    `);

    await queryRunner.query(`
      DELETE FROM "message_attachments" a
      WHERE NOT EXISTS (
        SELECT 1 FROM "messages" m
        WHERE m."tenantId" = a."tenantId"
          AND m."id" = a."messageId"
          AND m."createdAt" = a."messageCreatedAt"
      )
    `);

    await this.remediateMessageChildTable(queryRunner, 'message_receipts');
    await this.remediateMessageChildTable(queryRunner, 'message_reactions');
    await this.remediateMessageChildTable(queryRunner, 'message_analysis');
    await this.remediateMessageChildTable(queryRunner, 'message_entity_references');

    await queryRunner.query(`
      UPDATE "pinned_messages" p
      SET "tenantId" = c."tenantId"
      FROM "channels" c
      WHERE p."channelId" = c."id"
        AND p."tenantId" <> c."tenantId"
    `);

    await queryRunner.query(`
      DELETE FROM "pinned_messages" p
      WHERE NOT EXISTS (
        SELECT 1 FROM "channels" c
        WHERE c."tenantId" = p."tenantId"
          AND c."id" = p."channelId"
      )
    `);

    await queryRunner.query(`
      DELETE FROM "pinned_messages" p
      WHERE NOT EXISTS (
        SELECT 1 FROM "messages" m
        WHERE m."tenantId" = p."tenantId"
          AND m."id" = p."messageId"
          AND m."createdAt" = p."messageCreatedAt"
      )
    `);

    await queryRunner.query(`
      UPDATE "knowledge_entries" k
      SET "tenantId" = m."tenantId"
      FROM "messages" m
      WHERE k."sourceMessageId" = m."id"
        AND k."sourceMessageCreatedAt" = m."createdAt"
        AND k."tenantId" <> m."tenantId"
    `);

    await queryRunner.query(`
      DELETE FROM "knowledge_entries" k
      WHERE k."sourceMessageId" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "messages" m
          WHERE m."tenantId" = k."tenantId"
            AND m."id" = k."sourceMessageId"
            AND m."createdAt" = k."sourceMessageCreatedAt"
        )
    `);

    await queryRunner.query(`
      DELETE FROM "message_send_idempotency" i
      WHERE NOT EXISTS (
        SELECT 1 FROM "messages" m
        WHERE m."tenantId" = i."tenantId"
          AND m."id" = i."messageId"
          AND m."createdAt" = i."messageCreatedAt"
      )
    `);

    await queryRunner.query(`
      WITH ranked AS (
        SELECT ctid,
               row_number() OVER (
                 PARTITION BY "tenantId", "messageId", "messageCreatedAt", "userId", "emoji"
                 ORDER BY "createdAt" ASC, "id" ASC
               ) AS rn
        FROM "message_reactions"
      )
      DELETE FROM "message_reactions" r
      USING ranked ranked_rows
      WHERE r.ctid = ranked_rows.ctid AND ranked_rows.rn > 1
    `);

    await queryRunner.query(`
      WITH ranked AS (
        SELECT ctid,
               row_number() OVER (
                 PARTITION BY "tenantId", "channelId", "messageId", "messageCreatedAt"
                 ORDER BY "pinnedAt" ASC, "id" ASC
               ) AS rn
        FROM "pinned_messages"
      )
      DELETE FROM "pinned_messages" p
      USING ranked ranked_rows
      WHERE p.ctid = ranked_rows.ctid AND ranked_rows.rn > 1
    `);

    await queryRunner.query(`
      WITH ranked AS (
        SELECT ctid,
               row_number() OVER (
                 PARTITION BY "tenantId", "messageId", "messageCreatedAt", "entityType", "entityId"
                 ORDER BY "confidence" DESC, "extractedAt" DESC, "id" ASC
               ) AS rn
        FROM "message_entity_references"
      )
      DELETE FROM "message_entity_references" e
      USING ranked ranked_rows
      WHERE e.ctid = ranked_rows.ctid AND ranked_rows.rn > 1
    `);
  }

  private async remediateMessageChildTable(
    queryRunner: QueryRunner,
    tableName: string,
  ): Promise<void> {
    await queryRunner.query(`
      UPDATE "${tableName}" child
      SET "tenantId" = m."tenantId"
      FROM "messages" m
      WHERE child."messageId" = m."id"
        AND child."messageCreatedAt" = m."createdAt"
        AND child."tenantId" <> m."tenantId"
    `);

    await queryRunner.query(`
      DELETE FROM "${tableName}" child
      WHERE NOT EXISTS (
        SELECT 1 FROM "messages" m
        WHERE m."tenantId" = child."tenantId"
          AND m."id" = child."messageId"
          AND m."createdAt" = child."messageCreatedAt"
      )
    `);
  }

  private async recordPreflightFindings(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "tenant_isolation_remediation_log"
        ("tenantId", "tableName", "rowId", "action", "reason", "rowSnapshot")
      SELECT "tenantId", 'channels', "dmPairKey", 'REPORT', 'duplicate_direct_message_pair',
             jsonb_build_object('dmPairKey', "dmPairKey", 'count', count(*), 'channelIds', jsonb_agg("id"))
      FROM "channels"
      WHERE "dmPairKey" IS NOT NULL
      GROUP BY "tenantId", "dmPairKey"
      HAVING count(*) > 1
    `);

    await queryRunner.query(`
      INSERT INTO "tenant_isolation_remediation_log"
        ("tenantId", "tableName", "rowId", "action", "reason", "rowSnapshot")
      SELECT "tenantId", 'channel_members',
             concat("channelId", ':', "userId"), 'REPORT', 'duplicate_channel_membership',
             jsonb_build_object('channelId', "channelId", 'userId', "userId", 'count', count(*), 'memberIds', jsonb_agg("id"))
      FROM "channel_members"
      GROUP BY "tenantId", "channelId", "userId"
      HAVING count(*) > 1
    `);

    await queryRunner.query(`
      INSERT INTO "tenant_isolation_remediation_log"
        ("tenantId", "tableName", "rowId", "action", "reason", "rowSnapshot")
      SELECT "tenantId", 'messages',
             concat("channelId", ':', "senderId", ':', "idempotencyKey"),
             'REPORT', 'duplicate_send_idempotency_key',
             jsonb_build_object(
               'channelId', "channelId",
               'senderId', "senderId",
               'idempotencyKey', "idempotencyKey",
               'count', count(*),
               'messageIds', jsonb_agg("id")
             )
      FROM "messages"
      WHERE "idempotencyKey" IS NOT NULL
      GROUP BY "tenantId", "channelId", "senderId", "idempotencyKey"
      HAVING count(*) > 1
    `);

    await queryRunner.query(`
      INSERT INTO "tenant_isolation_remediation_log"
        ("tenantId", "tableName", "rowId", "action", "reason", "rowSnapshot")
      SELECT c."tenantId", c.table_name, c.row_id, 'REPORT', c.reason, c.snapshot
      FROM (
        SELECT a."tenantId", 'message_attachments' AS table_name, a."id"::text AS row_id,
               CASE WHEN m."id" IS NULL THEN 'orphan_message_child' ELSE 'cross_tenant_message_child' END AS reason,
               to_jsonb(a) AS snapshot
        FROM "message_attachments" a
        LEFT JOIN "messages" m
          ON m."id" = a."messageId"
         AND m."createdAt" = a."messageCreatedAt"
        WHERE m."id" IS NULL OR m."tenantId" <> a."tenantId"
        UNION ALL
        SELECT r."tenantId", 'message_receipts', r."id"::text,
               CASE WHEN m."id" IS NULL THEN 'orphan_message_child' ELSE 'cross_tenant_message_child' END,
               to_jsonb(r)
        FROM "message_receipts" r
        LEFT JOIN "messages" m
          ON m."id" = r."messageId"
         AND m."createdAt" = r."messageCreatedAt"
        WHERE m."id" IS NULL OR m."tenantId" <> r."tenantId"
        UNION ALL
        SELECT r."tenantId", 'message_reactions', r."id"::text,
               CASE WHEN m."id" IS NULL THEN 'orphan_message_child' ELSE 'cross_tenant_message_child' END,
               to_jsonb(r)
        FROM "message_reactions" r
        LEFT JOIN "messages" m
          ON m."id" = r."messageId"
         AND m."createdAt" = r."messageCreatedAt"
        WHERE m."id" IS NULL OR m."tenantId" <> r."tenantId"
        UNION ALL
        SELECT p."tenantId", 'pinned_messages', p."id"::text,
               CASE WHEN m."id" IS NULL THEN 'orphan_message_child' ELSE 'cross_tenant_message_child' END,
               to_jsonb(p)
        FROM "pinned_messages" p
        LEFT JOIN "messages" m
          ON m."id" = p."messageId"
         AND m."createdAt" = p."messageCreatedAt"
        WHERE m."id" IS NULL OR m."tenantId" <> p."tenantId"
      ) c
    `);

    await queryRunner.query(`
      INSERT INTO "tenant_isolation_remediation_log"
        ("tenantId", "tableName", "rowId", "action", "reason", "rowSnapshot")
      SELECT i."tenantId", 'message_send_idempotency',
             concat(i."messageId", ':', i."idempotencyKey"),
             'REPORT_DELETE_CANDIDATE', 'idempotency_row_missing_channel_or_sender',
             to_jsonb(i)
      FROM "message_send_idempotency" i
      WHERE i."channelId" IS NULL OR i."senderId" IS NULL
    `);
  }
}
