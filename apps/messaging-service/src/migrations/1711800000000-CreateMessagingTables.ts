import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationLogger } from '@aquaculture/backend-common';

/**
 * Creates all messaging tables in the current schema context.
 *
 * This migration is designed to run in:
 *   - The 'messaging' source schema (template for new tenants)
 *   - Each tenant_<uuid> schema (via TenantMigrationRunner)
 *
 * All table references are schema-qualified using the current search_path.
 *
 * Partitioned tables (messages, message_receipts) use PARTITION BY RANGE.
 * Initial partitions are created for Jan-Dec 2026.
 *
 * IMPORTANT: TypeORM synchronize=false for this service. All schema changes
 * go through migrations. See ADR-012 section 4.2.
 */
export class CreateMessagingTables1711800000000 implements MigrationInterface {
  private readonly logger = new MigrationLogger('CreateMessagingTables1711800000000');
  name = 'CreateMessagingTables1711800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Ensure the messaging schema exists before creating tables.
    // On fresh databases the init script may not have created it yet.
    // This is a no-op if the schema already exists.
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS "messaging"`);

    // Re-apply search_path so PostgreSQL resolves current_schema() correctly.
    // If the schema was just created, the connection's cached resolution may
    // still point to 'public'. This explicit SET forces re-resolution.
    await queryRunner.query(`SET search_path TO "messaging", "public"`);

    // Determine which schema we are operating in (messaging or tenant_*)
    // With search_path = 'messaging,public', current_schema() returns 'messaging'
    // now that we've ensured it exists above.
    const [{ current_schema }] = await queryRunner.query(
      'SELECT current_schema()',
    );
    const s = current_schema;

    // ------------------------------------------------------------------
    // 1. channels — conversation containers (DM, group, AI)
    // ------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${s}"."channels" (
        "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "type"         VARCHAR(20) NOT NULL DEFAULT 'group',
        "name"         VARCHAR(255),
        "description"  TEXT,
        "avatarUrl"    VARCHAR(1024),
        "createdBy"    UUID,
        "isArchived"   BOOLEAN NOT NULL DEFAULT FALSE,
        "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "dmPairKey"    VARCHAR(73) UNIQUE,

        CONSTRAINT "chk_channels_type"
          CHECK ("type" IN ('direct', 'group', 'ai')),
        CONSTRAINT "chk_dm_pair_key"
          CHECK (
            ("type" = 'direct' AND "dmPairKey" IS NOT NULL)
            OR ("type" != 'direct' AND "dmPairKey" IS NULL)
          )
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_channels_type"
        ON "${s}"."channels" ("type");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_channels_created_by"
        ON "${s}"."channels" ("createdBy");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_channels_is_archived"
        ON "${s}"."channels" ("isArchived") WHERE "isArchived" = FALSE;
    `);

    // ------------------------------------------------------------------
    // 2. channel_members — users belonging to channels
    // ------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${s}"."channel_members" (
        "id"                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "channelId"                UUID NOT NULL
          REFERENCES "${s}"."channels"("id") ON DELETE CASCADE,
        "userId"                   UUID NOT NULL,
        "role"                     VARCHAR(20) NOT NULL DEFAULT 'member',
        "notificationPreference"   VARCHAR(20) NOT NULL DEFAULT 'all',
        "lastReadAt"               TIMESTAMPTZ,
        "joinedAt"                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "leftAt"                   TIMESTAMPTZ,

        CONSTRAINT "chk_member_role"
          CHECK ("role" IN ('owner', 'admin', 'member')),
        CONSTRAINT "chk_notification_pref"
          CHECK ("notificationPreference" IN ('all', 'mentions', 'none')),
        CONSTRAINT "uq_channel_member"
          UNIQUE ("channelId", "userId")
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_channel_members_user_id"
        ON "${s}"."channel_members" ("userId");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_channel_members_channel_id"
        ON "${s}"."channel_members" ("channelId");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_channel_members_active"
        ON "${s}"."channel_members" ("userId", "channelId")
        WHERE "leftAt" IS NULL;
    `);

    // ------------------------------------------------------------------
    // 3. messages — partitioned by created_at (monthly ranges)
    //    Composite PK (id, createdAt) required for partition routing.
    // ------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${s}"."messages" (
        "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
        "channelId"       UUID NOT NULL,
        "senderId"        UUID NOT NULL,
        "content"         TEXT,
        "contentType"     VARCHAR(20) NOT NULL DEFAULT 'text',
        "parentId"        UUID,
        "forwardedFrom"   UUID,
        "idempotencyKey"  UUID NOT NULL,
        "isDeleted"       BOOLEAN NOT NULL DEFAULT FALSE,
        "createdAt"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "editedAt"        TIMESTAMPTZ,
        "metadata"        JSONB,

        PRIMARY KEY ("id", "createdAt"),

        CONSTRAINT "chk_content_type"
          CHECK ("contentType" IN ('text', 'image', 'file', 'voice', 'system'))
      ) PARTITION BY RANGE ("createdAt");
    `);

    // Create monthly partitions for 2026 (Jan through Dec)
    const months = [
      { name: '2026_01', from: '2026-01-01', to: '2026-02-01' },
      { name: '2026_02', from: '2026-02-01', to: '2026-03-01' },
      { name: '2026_03', from: '2026-03-01', to: '2026-04-01' },
      { name: '2026_04', from: '2026-04-01', to: '2026-05-01' },
      { name: '2026_05', from: '2026-05-01', to: '2026-06-01' },
      { name: '2026_06', from: '2026-06-01', to: '2026-07-01' },
      { name: '2026_07', from: '2026-07-01', to: '2026-08-01' },
      { name: '2026_08', from: '2026-08-01', to: '2026-09-01' },
      { name: '2026_09', from: '2026-09-01', to: '2026-10-01' },
      { name: '2026_10', from: '2026-10-01', to: '2026-11-01' },
      { name: '2026_11', from: '2026-11-01', to: '2026-12-01' },
      { name: '2026_12', from: '2026-12-01', to: '2027-01-01' },
    ];

    for (const m of months) {
      await queryRunner.query(`
        CREATE TABLE IF NOT EXISTS "${s}"."messages_${m.name}"
          PARTITION OF "${s}"."messages"
          FOR VALUES FROM ('${m.from}') TO ('${m.to}');
      `);
    }

    // Indexes on the parent table propagate to all partitions automatically
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_messages_channel_created"
        ON "${s}"."messages" ("channelId", "createdAt" DESC);
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_messages_sender"
        ON "${s}"."messages" ("senderId", "createdAt" DESC);
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_messages_parent"
        ON "${s}"."messages" ("parentId")
        WHERE "parentId" IS NOT NULL;
    `);
    // GIN index for full-text search on message content
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_messages_content_search"
        ON "${s}"."messages"
        USING gin (to_tsvector('english', "content"))
        WHERE "content" IS NOT NULL AND "isDeleted" = FALSE;
    `);

    // ------------------------------------------------------------------
    // 4. message_attachments — media files attached to messages
    //    FK references the partitioned messages table via composite key.
    //    NOTE: PostgreSQL supports FK from non-partitioned to partitioned
    //    tables only when the FK includes the partition key. We include
    //    (messageId, messageCreatedAt) which matches messages PK.
    // ------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${s}"."message_attachments" (
        "id"                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "messageId"         UUID NOT NULL,
        "messageCreatedAt"  TIMESTAMPTZ NOT NULL,
        "storageKey"        VARCHAR(512) NOT NULL,
        "originalFilename"  VARCHAR(255) NOT NULL,
        "mimeType"          VARCHAR(127) NOT NULL,
        "fileSize"          BIGINT NOT NULL,
        "width"             INTEGER,
        "height"            INTEGER,
        "durationSeconds"   NUMERIC(10, 2),
        "thumbnailKey"      VARCHAR(512),
        "createdAt"         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT "fk_attachment_message"
          FOREIGN KEY ("messageId", "messageCreatedAt")
          REFERENCES "${s}"."messages" ("id", "createdAt") ON DELETE CASCADE
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_attachments_message"
        ON "${s}"."message_attachments" ("messageId");
    `);

    // ------------------------------------------------------------------
    // 5. message_receipts — delivery/read receipts, partitioned monthly
    //    Composite PK (id, receiptCreatedAt) for partition routing.
    //    No FK to messages because PG does not support FK from a
    //    partitioned table to another partitioned table.
    // ------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${s}"."message_receipts" (
        "id"                  UUID NOT NULL DEFAULT gen_random_uuid(),
        "messageId"           UUID NOT NULL,
        "messageCreatedAt"    TIMESTAMPTZ NOT NULL,
        "userId"              UUID NOT NULL,
        "status"              VARCHAR(20) NOT NULL DEFAULT 'delivered',
        "deliveredAt"         TIMESTAMPTZ,
        "readAt"              TIMESTAMPTZ,
        "receiptCreatedAt"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        PRIMARY KEY ("id", "receiptCreatedAt"),

        CONSTRAINT "chk_receipt_status"
          CHECK ("status" IN ('delivered', 'read')),
        CONSTRAINT "uq_receipt_message_user"
          UNIQUE ("messageId", "userId", "receiptCreatedAt")
      ) PARTITION BY RANGE ("receiptCreatedAt");
    `);

    // Create monthly partitions matching messages partitions
    for (const m of months) {
      await queryRunner.query(`
        CREATE TABLE IF NOT EXISTS "${s}"."message_receipts_${m.name}"
          PARTITION OF "${s}"."message_receipts"
          FOR VALUES FROM ('${m.from}') TO ('${m.to}');
      `);
    }

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_receipts_user_status"
        ON "${s}"."message_receipts" ("userId", "status");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_receipts_message"
        ON "${s}"."message_receipts" ("messageId");
    `);

    // ------------------------------------------------------------------
    // 6. message_reactions — emoji reactions (Phase 2 schema, created now)
    //    FK to partitioned messages via composite key.
    // ------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${s}"."message_reactions" (
        "id"                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "messageId"         UUID NOT NULL,
        "messageCreatedAt"  TIMESTAMPTZ NOT NULL,
        "userId"            UUID NOT NULL,
        "emoji"             VARCHAR(32) NOT NULL,
        "createdAt"         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT "uq_reaction_message_user_emoji"
          UNIQUE ("messageId", "userId", "emoji"),

        CONSTRAINT "fk_reaction_message"
          FOREIGN KEY ("messageId", "messageCreatedAt")
          REFERENCES "${s}"."messages" ("id", "createdAt") ON DELETE CASCADE
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_reactions_message"
        ON "${s}"."message_reactions" ("messageId");
    `);

    // ------------------------------------------------------------------
    // 7. pinned_messages — channel-level pins (Phase 2 schema, created now)
    //    FK to channels (non-partitioned) and messages (composite).
    // ------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${s}"."pinned_messages" (
        "id"                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "channelId"         UUID NOT NULL
          REFERENCES "${s}"."channels"("id") ON DELETE CASCADE,
        "messageId"         UUID NOT NULL,
        "messageCreatedAt"  TIMESTAMPTZ NOT NULL,
        "pinnedBy"          UUID NOT NULL,
        "pinnedAt"          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT "uq_pin_channel_message"
          UNIQUE ("channelId", "messageId"),

        CONSTRAINT "fk_pin_message"
          FOREIGN KEY ("messageId", "messageCreatedAt")
          REFERENCES "${s}"."messages" ("id", "createdAt") ON DELETE CASCADE
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_pins_channel"
        ON "${s}"."pinned_messages" ("channelId", "pinnedAt" DESC);
    `);

    // ------------------------------------------------------------------
    // 8. messaging_outbox — transactional outbox for NATS event delivery
    //    Message INSERT + outbox INSERT in same transaction guarantees
    //    at-least-once delivery even if NATS is temporarily down.
    // ------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${s}"."messaging_outbox" (
        "id"           BIGSERIAL PRIMARY KEY,
        "eventType"    VARCHAR(100) NOT NULL,
        "payload"      JSONB NOT NULL,
        "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "publishedAt"  TIMESTAMPTZ,
        "retryCount"   INTEGER NOT NULL DEFAULT 0,
        "lastError"    TEXT
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_outbox_poll"
        ON "${s}"."messaging_outbox" ("createdAt" ASC)
        WHERE "publishedAt" IS NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [{ current_schema }] = await queryRunner.query(
      'SELECT current_schema()',
    );
    const s = current_schema;

    // Drop in reverse dependency order.
    // Partitions are dropped automatically when the parent table is dropped.

    await queryRunner.query(
      `DROP TABLE IF EXISTS "${s}"."messaging_outbox" CASCADE;`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "${s}"."pinned_messages" CASCADE;`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "${s}"."message_reactions" CASCADE;`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "${s}"."message_receipts" CASCADE;`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "${s}"."message_attachments" CASCADE;`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "${s}"."messages" CASCADE;`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "${s}"."channel_members" CASCADE;`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "${s}"."channels" CASCADE;`,
    );
  }
}
