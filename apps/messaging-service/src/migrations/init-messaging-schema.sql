-- =============================================================================
-- Messaging Service — Source Schema Initialization
--
-- Creates the 'messaging' source schema and all template tables.
-- Used by TenantSchemaSyncService to copy table definitions to new
-- tenant_<uuid> schemas during tenant provisioning.
--
-- This script is idempotent: safe to re-run on any environment.
--
-- Run as superuser or a role with CREATE SCHEMA privilege.
-- =============================================================================

-- pgvector extension for AI embeddings (Phase 2)
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================================
-- Source schema creation
-- ============================================================================
CREATE SCHEMA IF NOT EXISTS messaging;

SET search_path TO messaging;

-- ============================================================================
-- 1. channels — conversation containers (DM, group, AI)
-- ============================================================================
CREATE TABLE IF NOT EXISTS messaging.channels (
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

CREATE INDEX IF NOT EXISTS "idx_channels_type"
    ON messaging.channels ("type");
CREATE INDEX IF NOT EXISTS "idx_channels_created_by"
    ON messaging.channels ("createdBy");
CREATE INDEX IF NOT EXISTS "idx_channels_is_archived"
    ON messaging.channels ("isArchived") WHERE "isArchived" = FALSE;


-- ============================================================================
-- 2. channel_members — users belonging to channels
-- ============================================================================
CREATE TABLE IF NOT EXISTS messaging.channel_members (
    "id"                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "channelId"                UUID NOT NULL
        REFERENCES messaging.channels("id") ON DELETE CASCADE,
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

CREATE INDEX IF NOT EXISTS "idx_channel_members_user_id"
    ON messaging.channel_members ("userId");
CREATE INDEX IF NOT EXISTS "idx_channel_members_channel_id"
    ON messaging.channel_members ("channelId");
CREATE INDEX IF NOT EXISTS "idx_channel_members_active"
    ON messaging.channel_members ("userId", "channelId")
    WHERE "leftAt" IS NULL;


-- ============================================================================
-- 3. messages — partitioned by created_at (monthly RANGE)
--    Composite PK (id, createdAt) required for partition routing.
-- ============================================================================
CREATE TABLE IF NOT EXISTS messaging.messages (
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

-- Monthly partitions for 2026
CREATE TABLE IF NOT EXISTS messaging.messages_2026_01 PARTITION OF messaging.messages
    FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE IF NOT EXISTS messaging.messages_2026_02 PARTITION OF messaging.messages
    FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE IF NOT EXISTS messaging.messages_2026_03 PARTITION OF messaging.messages
    FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE IF NOT EXISTS messaging.messages_2026_04 PARTITION OF messaging.messages
    FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE IF NOT EXISTS messaging.messages_2026_05 PARTITION OF messaging.messages
    FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE IF NOT EXISTS messaging.messages_2026_06 PARTITION OF messaging.messages
    FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE IF NOT EXISTS messaging.messages_2026_07 PARTITION OF messaging.messages
    FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE IF NOT EXISTS messaging.messages_2026_08 PARTITION OF messaging.messages
    FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE IF NOT EXISTS messaging.messages_2026_09 PARTITION OF messaging.messages
    FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE IF NOT EXISTS messaging.messages_2026_10 PARTITION OF messaging.messages
    FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE IF NOT EXISTS messaging.messages_2026_11 PARTITION OF messaging.messages
    FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE IF NOT EXISTS messaging.messages_2026_12 PARTITION OF messaging.messages
    FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');

-- Indexes propagate to all partitions automatically
CREATE INDEX IF NOT EXISTS "idx_messages_channel_created"
    ON messaging.messages ("channelId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "idx_messages_sender"
    ON messaging.messages ("senderId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "idx_messages_parent"
    ON messaging.messages ("parentId")
    WHERE "parentId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "idx_messages_content_search"
    ON messaging.messages
    USING gin (to_tsvector('english', "content"))
    WHERE "content" IS NOT NULL AND "isDeleted" = FALSE;


-- ============================================================================
-- 4. message_attachments — media files attached to messages
-- ============================================================================
CREATE TABLE IF NOT EXISTS messaging.message_attachments (
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
        REFERENCES messaging.messages ("id", "createdAt") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "idx_attachments_message"
    ON messaging.message_attachments ("messageId");


-- ============================================================================
-- 5. message_receipts — delivery/read receipts, partitioned monthly
-- ============================================================================
CREATE TABLE IF NOT EXISTS messaging.message_receipts (
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

-- Monthly partitions for 2026
CREATE TABLE IF NOT EXISTS messaging.message_receipts_2026_01 PARTITION OF messaging.message_receipts
    FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE IF NOT EXISTS messaging.message_receipts_2026_02 PARTITION OF messaging.message_receipts
    FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE IF NOT EXISTS messaging.message_receipts_2026_03 PARTITION OF messaging.message_receipts
    FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE IF NOT EXISTS messaging.message_receipts_2026_04 PARTITION OF messaging.message_receipts
    FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE IF NOT EXISTS messaging.message_receipts_2026_05 PARTITION OF messaging.message_receipts
    FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE IF NOT EXISTS messaging.message_receipts_2026_06 PARTITION OF messaging.message_receipts
    FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE IF NOT EXISTS messaging.message_receipts_2026_07 PARTITION OF messaging.message_receipts
    FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE IF NOT EXISTS messaging.message_receipts_2026_08 PARTITION OF messaging.message_receipts
    FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE IF NOT EXISTS messaging.message_receipts_2026_09 PARTITION OF messaging.message_receipts
    FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE IF NOT EXISTS messaging.message_receipts_2026_10 PARTITION OF messaging.message_receipts
    FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE IF NOT EXISTS messaging.message_receipts_2026_11 PARTITION OF messaging.message_receipts
    FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE IF NOT EXISTS messaging.message_receipts_2026_12 PARTITION OF messaging.message_receipts
    FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');

CREATE INDEX IF NOT EXISTS "idx_receipts_user_status"
    ON messaging.message_receipts ("userId", "status");
CREATE INDEX IF NOT EXISTS "idx_receipts_message"
    ON messaging.message_receipts ("messageId");


-- ============================================================================
-- 6. message_reactions — emoji reactions on messages
-- ============================================================================
CREATE TABLE IF NOT EXISTS messaging.message_reactions (
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
        REFERENCES messaging.messages ("id", "createdAt") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "idx_reactions_message"
    ON messaging.message_reactions ("messageId");


-- ============================================================================
-- 7. pinned_messages — channel-level pins
-- ============================================================================
CREATE TABLE IF NOT EXISTS messaging.pinned_messages (
    "id"                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "channelId"         UUID NOT NULL
        REFERENCES messaging.channels("id") ON DELETE CASCADE,
    "messageId"         UUID NOT NULL,
    "messageCreatedAt"  TIMESTAMPTZ NOT NULL,
    "pinnedBy"          UUID NOT NULL,
    "pinnedAt"          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT "uq_pin_channel_message"
        UNIQUE ("channelId", "messageId"),

    CONSTRAINT "fk_pin_message"
        FOREIGN KEY ("messageId", "messageCreatedAt")
        REFERENCES messaging.messages ("id", "createdAt") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "idx_pins_channel"
    ON messaging.pinned_messages ("channelId", "pinnedAt" DESC);


-- ============================================================================
-- 8. messaging_outbox — transactional outbox for NATS event delivery
-- ============================================================================
CREATE TABLE IF NOT EXISTS messaging.messaging_outbox (
    "id"           BIGSERIAL PRIMARY KEY,
    "eventType"    VARCHAR(100) NOT NULL,
    "payload"      JSONB NOT NULL,
    "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "publishedAt"  TIMESTAMPTZ,
    "retryCount"   INTEGER NOT NULL DEFAULT 0,
    "lastError"    TEXT
);

CREATE INDEX IF NOT EXISTS "idx_outbox_poll"
    ON messaging.messaging_outbox ("createdAt" ASC)
    WHERE "publishedAt" IS NULL;


-- ============================================================================
-- 9. Phase 2 AI tables
-- ============================================================================

-- message_analysis — sentiment, entity, topic analysis results
CREATE TABLE IF NOT EXISTS messaging.message_analysis (
    "id"                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "messageId"         UUID NOT NULL,
    "messageCreatedAt"  TIMESTAMPTZ NOT NULL,
    "analysisType"      VARCHAR(20) NOT NULL,
    "result"            JSONB NOT NULL,
    "modelVersion"      VARCHAR(64) NOT NULL,
    "analyzedAt"        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT "chk_analysis_type"
        CHECK ("analysisType" IN ('sentiment', 'entity', 'topic')),

    CONSTRAINT "fk_analysis_message"
        FOREIGN KEY ("messageId", "messageCreatedAt")
        REFERENCES messaging.messages ("id", "createdAt") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "idx_analysis_message"
    ON messaging.message_analysis ("messageId");
CREATE INDEX IF NOT EXISTS "idx_analysis_type"
    ON messaging.message_analysis ("analysisType", "analyzedAt" DESC);
CREATE INDEX IF NOT EXISTS "idx_analysis_sentiment"
    ON messaging.message_analysis (("result"->>'score'))
    WHERE "analysisType" = 'sentiment';

-- message_entity_references — links messages to domain entities
CREATE TABLE IF NOT EXISTS messaging.message_entity_references (
    "id"                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "messageId"         UUID NOT NULL,
    "messageCreatedAt"  TIMESTAMPTZ NOT NULL,
    "entityType"        VARCHAR(30) NOT NULL,
    "entityId"          UUID NOT NULL,
    "confidence"        NUMERIC(3, 2) NOT NULL DEFAULT 1.0,
    "extractedAt"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT "chk_entity_type"
        CHECK ("entityType" IN ('tank', 'batch', 'site', 'species', 'parameter')),
    CONSTRAINT "uq_message_entity"
        UNIQUE ("messageId", "entityType", "entityId"),

    CONSTRAINT "fk_entity_ref_message"
        FOREIGN KEY ("messageId", "messageCreatedAt")
        REFERENCES messaging.messages ("id", "createdAt") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "idx_entity_refs_entity"
    ON messaging.message_entity_references ("entityType", "entityId");
CREATE INDEX IF NOT EXISTS "idx_entity_refs_message"
    ON messaging.message_entity_references ("messageId");

-- knowledge_entries — extracted operational knowledge
CREATE TABLE IF NOT EXISTS messaging.knowledge_entries (
    "id"                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "sourceMessageId"          UUID,
    "sourceMessageCreatedAt"   TIMESTAMPTZ,
    "category"                 VARCHAR(50) NOT NULL,
    "content"                  TEXT NOT NULL,
    "entities"                 JSONB,
    "confidence"               NUMERIC(3, 2) NOT NULL DEFAULT 1.0,
    "verifiedBy"               UUID,
    "createdAt"                TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT "fk_knowledge_message"
        FOREIGN KEY ("sourceMessageId", "sourceMessageCreatedAt")
        REFERENCES messaging.messages ("id", "createdAt") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "idx_knowledge_category"
    ON messaging.knowledge_entries ("category", "createdAt" DESC);

-- embeddings_metadata — tracks embedding model versions
CREATE TABLE IF NOT EXISTS messaging.embeddings_metadata (
    "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "modelName"       VARCHAR(128) NOT NULL,
    "modelVersion"    VARCHAR(64) NOT NULL,
    "dimension"       INTEGER NOT NULL,
    "distanceMetric"  VARCHAR(20) NOT NULL,
    "createdAt"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "isActive"        BOOLEAN NOT NULL DEFAULT TRUE,

    CONSTRAINT "uq_active_model"
        UNIQUE ("modelName", "isActive")
);

-- Add embedding column to messages (384 dims = all-MiniLM-L6-v2)
ALTER TABLE messaging.messages
    ADD COLUMN IF NOT EXISTS "embedding" vector(384);

-- HNSW index for fast cosine similarity search
CREATE INDEX IF NOT EXISTS "idx_messages_embedding"
    ON messaging.messages
    USING hnsw ("embedding" vector_cosine_ops)
    WITH (m = 16, ef_construction = 200);


-- ============================================================================
-- Reset search_path
-- ============================================================================
RESET search_path;
