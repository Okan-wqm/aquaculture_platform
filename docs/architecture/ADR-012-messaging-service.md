# ADR-012: In-App Messaging Service

**Status:** Proposed
**Date:** 2026-03-28
**Decision Makers:** Engineering Lead
**Supersedes:** None
**Related:** ADR-011 (Operations Hub), event-driven-architecture.md, security-architecture.md

---

## 1. Context & Problem Statement

Field workers on aquaculture farms operate in environments with intermittent connectivity, often wearing gloves and using devices one-handed. They currently have no way to communicate with each other, shift supervisors, or tenant administrators through the AquaMobil platform. Communication happens via external apps (WhatsApp, Telegram) which creates:

1. **Data fragmentation** -- operational context lives outside the platform
2. **Security risk** -- sensitive farm data (harvest prices, biomass figures, health issues) shared on unmanaged channels
3. **No audit trail** -- conversations about operational decisions are lost
4. **No integration** -- cannot reference tanks, batches, tasks, or alerts in messages
5. **No offline support** -- external apps require constant connectivity

**Goal:** Build a WhatsApp-like in-app messaging system native to AquaMobil that supports 1:1 direct messages, group channels, media sharing, offline-first operation, and future AI integration -- all within the existing multi-tenant architecture.

### Target Users

| User Type | Use Case | Frequency |
|-----------|----------|-----------|
| Field Worker (MODULE_USER) | Report issues with photos, shift handover notes | 10-20 messages/day |
| Shift Supervisor (MODULE_MANAGER) | Coordinate teams, distribute tasks, receive reports | 30-50 messages/day |
| Farm Manager (TENANT_ADMIN) | Broadcast announcements, monitor operations | 10-30 messages/day |
| Platform Admin (SUPER_ADMIN) | Cross-tenant support threads (Phase 2) | 5-10 messages/day |

### Scale Assumptions (Phase 1)

| Metric | Value | Rationale |
|--------|-------|-----------|
| Active tenants | 50-200 | Current platform scale |
| Users per tenant | 5-50 | Small-to-medium fish farms |
| Concurrent WebSocket connections | 200-1,000 | ~20% of total users online |
| Messages per day | 5,000-20,000 | Based on user frequency above |
| Media uploads per day | 500-2,000 | ~10% of messages include media |
| Average message size | 200 bytes (text), 2MB (media) | WhatsApp-comparable |
| Message retention | 1 year default | Configurable per tenant |

---

## 2. Decision Drivers

1. **Offline-first** -- Field workers lose connectivity for minutes to hours. Messages must queue locally and sync seamlessly.
2. **Tenant isolation** -- Messages MUST NOT leak across tenants. This is a hard security requirement enforced at database, API, and transport layers.
3. **Existing infrastructure** -- Reuse PostgreSQL, Redis, NATS JetStream, MinIO, and Socket.IO already in the stack.
4. **PWA constraints** -- No native app capabilities. Service worker + IndexedDB is the ceiling for background processing.
5. **Mobile-optimized UX** -- Large touch targets (48px minimum), one-handed use, glove-friendly. No tiny icons or precise gestures.
6. **Incremental delivery** -- Phase 1 must be deployable independently without breaking existing functionality.
7. **Cost efficiency** -- No new infrastructure services. Leverage existing NATS, Redis, MinIO, and PostgreSQL.
8. **Federation compatibility** -- Must integrate with Apollo Federation gateway for GraphQL queries/mutations.

---

## 3. Architecture Overview

```
                                    +---------------------+
                                    |   AquaMobil PWA     |
                                    |  (React + Tailwind) |
                                    +----------+----------+
                                               |
                              GraphQL (queries/mutations)
                              Socket.IO (real-time events)
                                               |
                                    +----------v----------+
                                    |    Gateway API      |
                                    | (Apollo Federation) |
                                    | + MessagingGateway  |
                                    +----+----------+-----+
                                         |          |
                            GraphQL      |          |  Socket.IO
                            Federation   |          |  (namespace: /messaging)
                                         |          |
                                    +----v----------v-----+
                                    |  Messaging Service   |
                                    |  (NestJS, port 3000) |
                                    |                      |
                                    |  +----------------+  |
                                    |  | GraphQL Module | <--- Apollo Federation subgraph
                                    |  +----------------+  |
                                    |  | WS Gateway     | <--- Socket.IO for real-time
                                    |  +----------------+  |
                                    |  | NATS Consumer  | <--- Event bus integration
                                    |  +----------------+  |
                                    |  | Media Module   | <--- MinIO presigned URLs
                                    |  +----------------+  |
                                    |  | CQRS Layer     | <--- Command/Query separation
                                    |  +----------------+  |
                                    +----+----+----+-------+
                                         |    |    |
                            +------------+    |    +------------+
                            |                 |                 |
                     +------v------+   +------v------+   +-----v------+
                     | PostgreSQL  |   |    Redis    |   |   MinIO    |
                     | (tenant_*  |   | (presence,  |   | (media     |
                     |  schemas)  |   |  typing,    |   |  bucket)   |
                     |            |   |  unread     |   |            |
                     +------+-----+   |  cache)     |   +------------+
                            |         +------+------+
                            |                |
                     +------v----------------v------+
                     |        NATS JetStream        |
                     |  (message events, delivery   |
                     |   confirmations, presence)    |
                     +------------------------------+
```

### Data Flow: Sending a Message

```
1. User composes message in ChatRoom page
2. Client calls sendMessage GraphQL mutation via authenticatedFetch
3. Gateway routes to messaging-service (Apollo Federation)
4. messaging-service:
   a. Validates sender belongs to channel + tenant
   b. Persists message to PostgreSQL (tenant schema)
   c. If media: generates presigned upload URL (MinIO)
   d. Publishes MessageSent event to NATS JetStream
   e. Returns message to sender with optimistic ID
5. NATS delivers MessageSent to:
   a. messaging-service WS gateway -> broadcasts to channel room via Socket.IO
   b. notification-service -> creates push notification for offline recipients
6. Client receives message via Socket.IO and updates local state
7. If offline: message queued in IndexedDB, synced on reconnect
```

### Data Flow: Offline Message Sync

```
1. User goes offline (detected by useNetworkStatus)
2. New messages queued in IndexedDB via offline-queue.ts (existing pattern)
3. User comes back online
4. OfflineProvider.syncNow() processes queue:
   a. For each queued message: calls sendMessage mutation
   b. Server deduplicates via idempotencyKey (client-generated UUID)
5. Client fetches missed messages via getMessagesSince(lastSyncTimestamp) query
6. IndexedDB message cache updated with server-confirmed messages
```

---

## 4. Technology Decisions

### 4.1 Service Architecture

**Decision: New dedicated microservice (`messaging-service`, internal port 3000)**

**Why not extend an existing service?**

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| New messaging-service | Independent scaling, clear domain boundary, dedicated connection pool, can optimize DB for messaging patterns (partitioning, indexes) | One more service to deploy and monitor | **Selected** |
| Extend notification-service | Already handles push, events, in-app notifications | Violates SRP -- notification dispatching is fundamentally different from message persistence + real-time delivery. Shared DB pool would starve under message load. | Rejected |
| Extend auth-service | User entity lives here | Auth is security-critical. Adding messaging bloats the attack surface. | Rejected |
| Extend gateway-api | Already has Socket.IO | Gateway is a routing layer, not a business logic layer. Adding persistence violates its architectural role. | Rejected |

**Service identity:**

```
SERVICE_NAME=messaging-service
PORT=3000                          (internal port; matches all other backend services)
DATABASE_NAME=aquaculture          (shared DB, tenant_* schemas)
NATS_STREAM_NAME=AQUACULTURE_EVENTS  (shared stream)
REDIS_DB=3                         (dedicated Redis DB index)
```

### 4.2 Database Schema

**Decision: Tables in tenant-scoped schemas (`tenant_<uuid>`) following the existing pattern**

Each tenant gets their messaging tables within their existing `tenant_<uuid>` schema. This is consistent with how farm-service, hr-service, and sensor-service store tenant-scoped data.

**Why not a separate database?**

Separate database adds operational complexity (backup, migration, monitoring) with no benefit at the current scale. The existing PostgreSQL instance with TimescaleDB has plenty of capacity. If messaging load outgrows the shared instance, table partitioning and read replicas are the correct scaling path before database separation.

**Why not the `public` schema?**

Public schema would require a `tenant_id` column on every table with composite indexes. Tenant schema separation provides inherent row-level isolation without WHERE clause overhead and cannot accidentally leak data through a missing filter.

```sql
-- =============================================================================
-- ADR-012: Messaging Service Database Schema
-- Applied to each tenant_<uuid> schema via TypeORM synchronize or migration
-- =============================================================================

-- Channels: DM pairs, group chats, future AI channels
-- A "channel" is the container for a conversation. Two users in a DM share
-- exactly one channel. A group can have N members.
CREATE TABLE channels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- 'direct' = 1:1 DM, 'group' = multi-member, 'ai' = AI assistant (Phase 2)
    type VARCHAR(20) NOT NULL DEFAULT 'group'
        CHECK (type IN ('direct', 'group', 'ai')),

    -- Human-readable name. NULL for DMs (derived from participants on client).
    name VARCHAR(255),

    -- Optional description for group channels
    description TEXT,

    -- URL to channel avatar image (MinIO presigned or public URL)
    avatar_url VARCHAR(1024),

    -- The user who created this channel. NULL for system-created channels.
    created_by UUID,

    -- Soft-delete support for compliance. Deleted channels are hidden but
    -- retained for audit. Messages within remain queryable by admins.
    is_archived BOOLEAN NOT NULL DEFAULT FALSE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- For DMs: composite of sorted user UUIDs to enforce uniqueness.
    -- Example: 'aaaa-...:bbbb-...' where aaaa < bbbb lexicographically.
    -- NULL for group/ai channels.
    dm_pair_key VARCHAR(73) UNIQUE,

    CONSTRAINT chk_dm_pair_key CHECK (
        (type = 'direct' AND dm_pair_key IS NOT NULL) OR
        (type != 'direct' AND dm_pair_key IS NULL)
    )
);

CREATE INDEX idx_channels_type ON channels (type);
CREATE INDEX idx_channels_created_by ON channels (created_by);
CREATE INDEX idx_channels_is_archived ON channels (is_archived) WHERE is_archived = FALSE;


-- Channel members: who belongs to which channel, with per-member settings
CREATE TABLE channel_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id UUID NOT NULL,

    -- 'owner' can delete channel, manage members. 'admin' can manage members.
    -- 'member' is the default. DM channels have both users as 'member'.
    role VARCHAR(20) NOT NULL DEFAULT 'member'
        CHECK (role IN ('owner', 'admin', 'member')),

    -- Per-member notification preference for this channel.
    -- 'all' = every message, 'mentions' = only @mentions, 'none' = muted.
    notification_preference VARCHAR(20) NOT NULL DEFAULT 'all'
        CHECK (notification_preference IN ('all', 'mentions', 'none')),

    -- Timestamp of the last message the user has seen. Used for unread count.
    -- Updated when client sends markAsRead mutation.
    last_read_at TIMESTAMPTZ,

    -- When the user joined this channel
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Soft-remove: user left or was removed. Row kept for history.
    left_at TIMESTAMPTZ,

    CONSTRAINT uq_channel_member UNIQUE (channel_id, user_id)
);

CREATE INDEX idx_channel_members_user_id ON channel_members (user_id);
CREATE INDEX idx_channel_members_channel_id ON channel_members (channel_id);
CREATE INDEX idx_channel_members_active ON channel_members (user_id, channel_id)
    WHERE left_at IS NULL;


-- Messages: the core table. Partitioned by month for performance at scale.
-- At 20K messages/day = ~600K/month. Monthly partitions keep each partition
-- under 1M rows for fast index scans and efficient VACUUM.
CREATE TABLE messages (
    id UUID NOT NULL DEFAULT gen_random_uuid(),

    channel_id UUID NOT NULL,
    sender_id UUID NOT NULL,

    -- Message content. NULL for media-only messages.
    content TEXT,

    -- 'text', 'image', 'file', 'voice', 'system' (join/leave notifications)
    content_type VARCHAR(20) NOT NULL DEFAULT 'text'
        CHECK (content_type IN ('text', 'image', 'file', 'voice', 'system')),

    -- For replies/threads: the message being replied to. NULL for top-level.
    parent_id UUID,

    -- For forwarded messages: original message ID. NULL for original messages.
    forwarded_from UUID,

    -- Client-generated UUID for idempotent offline sync.
    -- Ensures the same message is not persisted twice if the client retries.
    idempotency_key UUID NOT NULL,

    -- Soft-delete: message hidden from users but retained for compliance.
    -- Admin can still see deleted messages in audit view.
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE,

    -- Server-side timestamp (authoritative). Client timestamp in metadata.
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Non-null when message was edited. Shows "(edited)" indicator in UI.
    edited_at TIMESTAMPTZ,

    -- JSONB for extensible metadata without schema changes:
    -- { clientTimestamp, deviceInfo, location, editHistory[] }
    metadata JSONB,

    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Monthly partitions. A cron job or TypeORM migration creates future partitions.
-- Example for 2026:
CREATE TABLE messages_2026_01 PARTITION OF messages
    FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE messages_2026_02 PARTITION OF messages
    FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE messages_2026_03 PARTITION OF messages
    FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE messages_2026_04 PARTITION OF messages
    FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
-- ... (auto-generated quarterly by partition manager service)

-- Indexes on the parent table propagate to all partitions automatically.
CREATE INDEX idx_messages_channel_created ON messages (channel_id, created_at DESC);
CREATE INDEX idx_messages_sender ON messages (sender_id, created_at DESC);
CREATE INDEX idx_messages_parent ON messages (parent_id) WHERE parent_id IS NOT NULL;
-- NOTE: idempotency is enforced via Redis deduplication, NOT a partition-local
-- unique index. See section 15 "Idempotency Deduplication" below.
-- The old idx_messages_idempotency unique index was removed because PostgreSQL
-- unique indexes on partitioned tables are per-partition, not global. A message
-- resent across a month boundary would bypass the constraint entirely.

CREATE INDEX idx_messages_content_search ON messages USING gin (to_tsvector('english', content))
    WHERE content IS NOT NULL AND is_deleted = FALSE;


-- Media attachments: separate table because a message can have multiple files.
-- Keeps the messages table lean for fast scans.
CREATE TABLE message_attachments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    message_id UUID NOT NULL,
    -- Denormalized for partition-aware joins
    message_created_at TIMESTAMPTZ NOT NULL,

    -- MinIO object key: 'messaging/{tenant_id}/{channel_id}/{year}/{month}/{uuid}.{ext}'
    storage_key VARCHAR(512) NOT NULL,

    -- Original filename as uploaded by user
    original_filename VARCHAR(255) NOT NULL,

    -- MIME type for rendering: image/jpeg, application/pdf, audio/webm, etc.
    mime_type VARCHAR(127) NOT NULL,

    -- File size in bytes. Used for quota enforcement and UI display.
    file_size BIGINT NOT NULL,

    -- Dimensions for images/videos (nullable for non-visual files)
    width INTEGER,
    height INTEGER,

    -- Duration in seconds for voice notes and videos
    duration_seconds NUMERIC(10, 2),

    -- Thumbnail storage key for images/videos (generated server-side)
    thumbnail_key VARCHAR(512),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Foreign key references the partitioned messages table.
    -- We use (message_id, message_created_at) to match the partition key.
    CONSTRAINT fk_attachment_message
        FOREIGN KEY (message_id, message_created_at)
        REFERENCES messages (id, created_at) ON DELETE CASCADE
);

CREATE INDEX idx_attachments_message ON message_attachments (message_id);


-- Message read receipts: tracks delivery and read status per recipient.
-- Only created for recipients other than the sender.
-- PARTITIONED: receipts grow at 2x the rate of messages (one per recipient).
-- Monthly partitioning by receipt_created_at keeps each partition under 2.5M rows
-- and enables cheap DROP PARTITION for retention cleanup.
CREATE TABLE message_receipts (
    id UUID NOT NULL DEFAULT gen_random_uuid(),

    message_id UUID NOT NULL,
    message_created_at TIMESTAMPTZ NOT NULL,

    user_id UUID NOT NULL,

    -- 'delivered' = server confirmed delivery to client
    -- 'read' = client confirmed user viewed the message
    status VARCHAR(20) NOT NULL DEFAULT 'delivered'
        CHECK (status IN ('delivered', 'read')),

    delivered_at TIMESTAMPTZ,
    read_at TIMESTAMPTZ,

    -- receipt_created_at is the partition key
    receipt_created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (id, receipt_created_at),
    CONSTRAINT uq_receipt_message_user UNIQUE (message_id, user_id, receipt_created_at)
) PARTITION BY RANGE (receipt_created_at);

-- Monthly partitions co-managed by the same partition-manager.service.ts cron
CREATE TABLE message_receipts_2026_01 PARTITION OF message_receipts
    FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE message_receipts_2026_02 PARTITION OF message_receipts
    FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE message_receipts_2026_03 PARTITION OF message_receipts
    FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE message_receipts_2026_04 PARTITION OF message_receipts
    FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');

CREATE INDEX idx_receipts_user_status ON message_receipts (user_id, status);
CREATE INDEX idx_receipts_message ON message_receipts (message_id);


-- Reactions: emoji reactions on messages (Phase 2, schema created in Phase 1)
CREATE TABLE message_reactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    message_id UUID NOT NULL,
    message_created_at TIMESTAMPTZ NOT NULL,

    user_id UUID NOT NULL,

    -- Unicode emoji or shortcode. Max 32 chars to support composite emoji.
    emoji VARCHAR(32) NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_reaction_message_user_emoji UNIQUE (message_id, user_id, emoji),

    CONSTRAINT fk_reaction_message
        FOREIGN KEY (message_id, message_created_at)
        REFERENCES messages (id, created_at) ON DELETE CASCADE
);

CREATE INDEX idx_reactions_message ON message_reactions (message_id);


-- Pinned messages: channel-level pins (Phase 2, schema created in Phase 1)
CREATE TABLE pinned_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    message_id UUID NOT NULL,
    message_created_at TIMESTAMPTZ NOT NULL,

    pinned_by UUID NOT NULL,
    pinned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_pin_channel_message UNIQUE (channel_id, message_id),

    CONSTRAINT fk_pin_message
        FOREIGN KEY (message_id, message_created_at)
        REFERENCES messages (id, created_at) ON DELETE CASCADE
);

CREATE INDEX idx_pins_channel ON pinned_messages (channel_id, pinned_at DESC);
```

**Partition management:** A scheduled job (`@Cron('0 0 1 * *')`) in the messaging-service creates the next month's partition before it is needed. This follows the same pattern used by audit_logs in the notification-service.

**TypeORM synchronize vs. migrations (H12):**

| Table | Strategy | Rationale |
|-------|----------|-----------|
| `messages` | **Migration-only** | Partitioned table; TypeORM synchronize does not understand `PARTITION BY RANGE` and would attempt to create a non-partitioned table, breaking all partition-aware queries. |
| `message_receipts` | **Migration-only** | Same reason: partitioned by `receipt_created_at`. |
| `channels` | TypeORM synchronize (dev only) | Simple table, no partitioning. |
| `channel_members` | TypeORM synchronize (dev only) | Simple table, no partitioning. |
| `message_attachments` | TypeORM synchronize (dev only) | Simple table, foreign key to partitioned messages is handled by migration. |
| `message_reactions` | TypeORM synchronize (dev only) | Phase 2 schema, simple table. |
| `pinned_messages` | TypeORM synchronize (dev only) | Phase 2 schema, simple table. |

**Production rule:** `DATABASE_SYNC=false` always. All schema changes go through TypeORM migrations executed by `TenantMigrationRunner`. This prevents TypeORM from attempting to reconcile partitioned tables and destroying the partition hierarchy. The messaging-service `ormconfig` explicitly sets `synchronize: false` and `migrationsRun: true` for production.

**Sizing estimates:**

| Table | Row Size (avg) | Rows/month (200 users) | Monthly Size | 1-Year Size |
|-------|---------------|------------------------|-------------|-------------|
| messages | ~400 bytes | 600,000 | ~240 MB | ~2.9 GB |
| message_attachments | ~300 bytes | 60,000 | ~18 MB | ~216 MB |
| message_receipts | ~100 bytes | 1,200,000 | ~120 MB | ~1.4 GB |
| channels | ~200 bytes | 500 (cumulative) | ~100 KB | ~100 KB |
| channel_members | ~100 bytes | 2,000 (cumulative) | ~200 KB | ~200 KB |

**Total estimated database growth: ~4.5 GB/year for 200 active users.**

### 4.3 Real-time Transport

**Decision: Socket.IO via a new namespace `/messaging` on the gateway-api, bridged to messaging-service via NATS**

**Why Socket.IO?**

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| Socket.IO (new namespace) | Already in gateway (sensor-readings.gateway.ts), proven JWT auth pattern, automatic reconnection, room-based routing, fallback to polling | Slightly heavier than raw WS | **Selected** |
| Raw WebSocket | Minimal overhead | No reconnection, no rooms, no auth middleware out of the box. Would rebuild what Socket.IO provides. | Rejected |
| GraphQL Subscriptions | Native Apollo Federation support | Requires HTTP/2 or long-polling. Not suitable for high-frequency message delivery. Apollo Federation has limited subscription support across subgraphs. | Rejected |
| NATS WebSocket bridge | Direct NATS pub/sub to client | Exposes internal message bus topology to clients. Security nightmare. | Rejected |
| Server-Sent Events | Simple, works with HTTP/1.1 | Unidirectional. Client-to-server requires separate REST/GraphQL calls. No binary frame support. | Rejected |

**Architecture:**

The messaging-service publishes NATS events when messages are sent. The gateway-api subscribes to these events via the existing NATS bridge pattern (see `nats-bridge.service.ts`) and broadcasts them to connected Socket.IO clients in the appropriate channel room.

This keeps the messaging-service stateless (no direct WebSocket connections) while leveraging the gateway's existing Socket.IO infrastructure.

```
messaging-service -> NATS (MessageSent event)
                           |
gateway-api (NATS subscriber) -> Socket.IO room: channel:{channelId}
                                       |
                              AquaMobil clients (subscribed to their channels)
```

**Socket.IO namespace: `/messaging`**

```typescript
// Gateway-side WebSocket gateway (new file)
@WebSocketGateway({
  cors: buildWsCorsConfig(),
  namespace: '/messaging',
  transports: ['websocket', 'polling'],
})
export class MessagingGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  // Reuses the same JWT auth pattern as SensorReadingsGateway
  // Rooms: channel:{channelId} for message delivery
  // Events emitted: newMessage, messageUpdated, messageDeleted, typing, presence
}
```

### 4.4 Media Storage

**Decision: MinIO with presigned upload/download URLs**

MinIO is already deployed (`aqua-minio`, port 9000/9001) and the gateway has `StorageModule` configured. Media uploads use a two-step flow:

1. **Client requests upload URL:** `requestMediaUpload` mutation returns a presigned PUT URL and the final storage key
2. **Client uploads directly to MinIO:** Browser `fetch(presignedUrl, { method: 'PUT', body: file })` -- no proxy through NestJS
3. **Client sends message with attachment reference:** `sendMessage` mutation includes the storage key
4. **Server validates:** Confirms the object exists in MinIO before persisting the message
5. **Recipients get download URL:** `getMessages` resolver generates presigned GET URLs with 1-hour TTL

**Bucket structure:**

```
aquaculture/
  messaging/
    {tenant_id}/
      {channel_id}/
        {year}/
          {month}/
            {uuid}.jpg          -- original image
            {uuid}_thumb.jpg    -- thumbnail (256x256, generated server-side)
            {uuid}.pdf          -- documents
            {uuid}.webm         -- voice notes
```

**File limits:**

| Type | Max Size | Allowed MIME Types |
|------|----------|--------------------|
| Image | 10 MB | image/jpeg, image/png, image/webp, image/gif |
| Document | 25 MB | application/pdf, application/msword, application/vnd.openxmlformats-officedocument.* |
| Voice note | 5 MB | audio/webm, audio/ogg, audio/mp4 |
| Video (Phase 2) | 50 MB | video/mp4, video/webm |

**Thumbnail generation:** A NATS-triggered worker in messaging-service generates thumbnails asynchronously after upload confirmation. Sharp.js (already a transitive dependency via NestJS) handles image resizing. Thumbnails are stored alongside originals.

**Magic byte verification (H5):**

After the client uploads a file to MinIO and sends the message with the storage key, the `SendMessageCommand` handler performs a server-side MIME validation step before persisting the attachment record:

1. Fetch the first 4,096 bytes of the uploaded object from MinIO via `getObject({ Range: 'bytes=0-4095' })`.
2. Pass the buffer to the `file-type` npm package (`fileTypeFromBuffer()`), which inspects magic bytes to determine the true MIME type.
3. Compare the detected MIME type against the declared `mimeType` from the client.
4. If they do not match (e.g., client declares `image/jpeg` but magic bytes indicate `application/x-executable`), reject the message with a `BAD_REQUEST` error, delete the uploaded object from MinIO, and log the mismatch to the audit trail.
5. If `file-type` returns `undefined` (unrecognized format), reject the file unless the declared MIME type is in the allowlist for text-based formats (`application/pdf`, `application/msword`, etc.) where magic bytes vary.

**Why:** Client-declared MIME types can be spoofed. A malicious user could upload an executable disguised as a JPEG. Magic byte verification is the server-side defense against content-type confusion attacks. The `file-type` package is zero-dependency and adds negligible overhead (sub-millisecond for 4KB buffer).

**Storage quota per tenant:** 10 GB default, configurable via tenant settings. Enforced at the `requestMediaUpload` mutation by checking cumulative `file_size` from `message_attachments`.

### 4.5 Message Delivery Pipeline

**Decision: NATS JetStream for at-least-once delivery with idempotency keys for deduplication**

The existing `AQUACULTURE_EVENTS` stream (configured in `nats-event-bus.ts`) handles all platform events. Messaging events use the same stream with dedicated subjects:

```
events.MessageSent           -- new message created
events.MessageUpdated        -- message edited
events.MessageDeleted        -- message soft-deleted
events.ChannelCreated        -- new channel created
events.ChannelMemberAdded    -- user joined channel
events.ChannelMemberRemoved  -- user left/removed from channel
events.MessageRead           -- read receipt batch update
events.TypingStarted         -- typing indicator (published to NATS core, not JetStream)
events.PresenceChanged       -- user online/offline status (NATS core, not JetStream)
```

**Why at-least-once (not exactly-once)?**

Exactly-once delivery is expensive and complex. At-least-once with client-side idempotency keys provides the same user experience:

1. Server checks Redis for existing `idempotency_key` (see section 15 for details on why a Redis-based approach is used instead of a database unique index, which does not work across partitions)
2. Client generates UUID before sending, stores it with the queued operation
3. If the mutation is retried (offline sync), the server returns the existing message instead of creating a duplicate

**Typing indicators and presence** use NATS core (non-JetStream) subjects because they are ephemeral and do not need persistence or replay. If a typing event is lost, the worst case is a missing "typing..." indicator for a few seconds.

### 4.6 Push Notifications

**Decision: Extend existing notification-service with a new `MessagingPushHandler`**

The notification-service already has:
- `PushService` with Firebase Cloud Messaging support
- `DeviceToken` entity for push registration
- `InAppNotificationService` for in-app notifications
- `MessagingEventHandler` that subscribes to `MessageSent` events

The existing `MessagingEventHandler` handles admin-to-tenant messaging (support threads). For Phase 1, we extend it to also handle peer-to-peer and group messaging notifications:

```typescript
// New handler registered in notification-service
events.MessageSent -> MessagingPushHandler:
  1. Load channel members from messaging-service (gRPC or NATS request-reply)
  2. Filter out:
     - The sender (no self-notification)
     - Members with notification_preference = 'none'
     - Members currently connected via Socket.IO (real-time delivery sufficient)
     - Members in quiet hours (from user.notificationPreferences)
  3. For remaining members:
     a. Create IN_APP notification via InAppNotificationService
     b. Send push notification via PushService (FCM)
     c. Increment unread badge count in Redis
```

**Push notification payload:**

```json
{
  "title": "John D.",
  "body": "Sent you a message",
  "data": {
    "type": "CHAT_MESSAGE",
    "channelId": "uuid",
    "messageId": "uuid"
  },
  "badge": 3,
  "sound": "default"
}
```

**Security (H-2 compliance):** Message content is NEVER included in push notification bodies. Only the sender's display name and a generic "Sent you a message" / "Sent a photo" text is used. This matches the existing pattern in `messaging-event.handler.ts`.

### 4.7 Offline Strategy

**Decision: Extend existing IndexedDB + AES-GCM encryption pattern from offline-queue.ts**

The AquaMobil app already has a production-grade offline queue (`pwa/offline-queue.ts`) with:
- AES-GCM encryption per session
- Deduplication within 5-second windows
- Queue size limits (200 items)
- Retry with backoff (max 3 retries)
- Background sync via service worker

For messaging, we add a parallel offline store specifically for messages:

**Outgoing messages (send queue):**

```typescript
// New OperationType values added to the existing queue
type OperationType = ... | 'sendMessage' | 'editMessage' | 'deleteMessage' | 'markMessagesRead';
```

These use the existing `queueOperation()` and `syncAllOperations()` infrastructure. The idempotency key ensures no duplicates on retry.

**Incoming messages (local cache):**

A separate IndexedDB store (`aquamobil-messages`) caches received messages for offline reading:

```typescript
// New IndexedDB store for message cache
const messageStore = createStore('aquamobil-messages', 'messages');

// Cache structure per channel:
// Key: `channel:{channelId}:messages`
// Value: { messages: Message[], lastSyncAt: string, channelMeta: ChannelMeta }
//
// Encrypted with the same per-session AES-GCM key as the offline queue.
```

**Sync protocol:**

1. On app launch (or reconnect), client sends `getMessagesSince` query with `lastSyncAt` timestamp
2. Server returns all messages after that timestamp for channels the user belongs to
3. Client merges server messages with local cache, resolving conflicts by server timestamp
4. Outgoing queue is processed (send pending messages)

**Cache limits:**

| Setting | Value | Rationale |
|---------|-------|-----------|
| Max cached channels | 50 | Most users participate in fewer than 20 channels |
| Max messages per channel | 200 | Enough for recent context; older messages fetched on scroll |
| Cache TTL | 7 days | Stale data purged on next sync |
| Max total cache size | 50 MB | Prevents storage quota exhaustion on mobile devices |

### 4.8 AI Integration (Phase 2)

**Decision: Dedicated `ai` channel type with MCP server bridge**

Phase 2 introduces AI-powered channels where users can chat with an AI assistant. The architecture:

1. **AI Channel:** A channel with `type = 'ai'` and a virtual AI user as a member
2. **MCP Bridge:** The existing `ai-service` (port 3008) already has chat/conversation/tools modules. The messaging-service routes messages in AI channels to `ai-service` via NATS request-reply
3. **Context injection:** AI messages include context from the tenant's farm data (tanks, batches, water quality) via the existing tool system in ai-service
4. **Async responses:** AI responses are published as regular messages from the AI virtual user, delivered through the same Socket.IO pipeline

```
User message in AI channel
    -> messaging-service persists message
    -> NATS request: commands.ai.chat
    -> ai-service processes with MCP tools
    -> NATS reply with AI response
    -> messaging-service persists AI response as message
    -> Socket.IO delivers to user
```

**Phase 2 AI features:**

- **Sentiment analysis:** Background job analyzes message sentiment in operational channels, flags negative trends to managers
- **Knowledge extraction:** AI identifies operational knowledge (feeding schedules, water quality correlations) from message history and adds to tenant knowledge base
- **Smart replies:** AI suggests contextual replies based on conversation history and farm data

### 4.9 Security Model

**Tenant isolation:**

| Layer | Mechanism |
|-------|-----------|
| Database | Tenant-scoped schemas (`tenant_<uuid>`) -- physical isolation |
| API | `@TenantGuard()` decorator validates `x-tenant-id` header matches JWT `tenantId` |
| WebSocket | Channel rooms prefixed with tenant ID; join validation checks membership |
| NATS | Events include `tenantId`; consumers filter by tenant |
| MinIO | Object keys include tenant ID; presigned URLs are tenant-scoped |
| Redis | Key prefix includes tenant ID: `msg:{tenantId}:...` |

**Authorization matrix:**

| Action | MODULE_USER | MODULE_MANAGER | TENANT_ADMIN | SUPER_ADMIN |
|--------|------------|----------------|--------------|-------------|
| Send DM | Own tenant | Own tenant | Own tenant | Any tenant (Phase 2) |
| Create group | No | Yes | Yes | Yes |
| Add group member | No | Own groups | Any group | Any group |
| Remove group member | No | Own groups | Any group | Any group |
| Delete own message | Yes | Yes | Yes | Yes |
| Delete any message | No | Own groups | Any channel | Any channel |
| View message audit | No | No | Yes | Yes |
| Pin message | No | Yes | Yes | Yes |
| Upload media | Yes (10MB) | Yes (25MB) | Yes (25MB) | Yes (25MB) |

**Rate limiting:**

| Action | Limit | Window | Enforcement |
|--------|-------|--------|-------------|
| Send message | 30 | 1 minute | Redis sliding window |
| Upload media | 10 | 1 minute | Redis sliding window |
| Create channel | 5 | 1 hour | Redis sliding window |
| Add member | 20 | 1 minute | Redis sliding window |
| Typing indicator | 3 | 10 seconds | Client-side throttle + server ignore |

**Message content security:**

- Messages are stored as-is in PostgreSQL (no client-side E2E encryption in Phase 1 -- would break search, AI, and compliance features)
- Database encryption at rest via PostgreSQL TDE or volume-level encryption
- TLS 1.3 for all transport (API, WebSocket, NATS, MinIO)
- Media files stored with private ACLs in MinIO; access only via time-limited presigned URLs
- No message content in push notifications or NATS events (generic text only)

**Server-side content sanitization (H2):**

Content sanitization is enforced in the `SendMessageCommand` handler and `EditMessageCommand` handler BEFORE the message is persisted to PostgreSQL. The client is never trusted to sanitize.

1. **HTML stripping:** Use the `sanitize-html` npm package with an empty allowlist (`allowedTags: [], allowedAttributes: {}`) to strip ALL HTML tags from message content. Messages are plain text only in Phase 1.
2. **URL scheme validation:** Extract URLs from content via regex. Only `http://` and `https://` schemes are permitted. URLs with `javascript:`, `data:`, `ftp:`, `file:`, or any other scheme are stripped and replaced with `[link removed]`.
3. **Maximum content length:** 4,000 characters enforced server-side via a `@MaxLength(4000)` class-validator decorator on `SendMessageInput.content`. Messages exceeding this limit are rejected with a `BAD_REQUEST` error before reaching the database.
4. **File name sanitization:** `originalFilename` on attachments is sanitized via `path.basename()` to prevent directory traversal, and non-ASCII characters are replaced with underscores.

**Why server-side:** Client-side sanitization can be bypassed by crafting direct GraphQL requests. Server-side enforcement is the only reliable defense. The `sanitize-html` library is well-maintained, handles edge cases (nested tags, encoded entities), and adds < 1ms per message.

**GDPR Phase 1 (H3):**

Phase 1 includes baseline GDPR compliance for messaging data:

1. **`exportMyMessages` query:** Returns all messages authored by the requesting user across all channels as a JSON array. Includes message content, timestamps, channel IDs, and attachment metadata (not the files themselves). Available to any authenticated user for their own data. Rate-limited to 1 export per 24 hours per user.

    ```graphql
    type Query {
      """Export all messages authored by the current user (GDPR Article 20)"""
      exportMyMessages: JSON!
    }
    ```

2. **`anonymizeMyData` mutation:** Replaces the user's `sender_id` with a tombstone UUID (`00000000-0000-0000-0000-000000000000`), clears `content` to `[message deleted by user]`, and deletes all associated `message_attachments` from both PostgreSQL and MinIO. The message row is retained for conversation continuity but is no longer attributable. Cascades to `message_receipts`, `message_reactions`, and `channel_members` (sets `left_at = NOW()`). Requires the user to confirm via a re-authentication step (password entry).

    ```graphql
    type Mutation {
      """Anonymize all messaging data for the current user (GDPR Article 17)"""
      anonymizeMyData(confirmPassword: String!): Boolean!
    }
    ```

3. **Audit trail:** All `anonymizeMyData` executions are logged via a `UserDataAnonymized` NATS event, consumed by the existing audit_log table in notification-service. The log entry records the user ID, timestamp, and count of affected records.

**Why Phase 1:** GDPR right-to-erasure and right-to-portability are legal requirements in the EU. Since the platform operates in Turkey and EU markets, these must be available from day one, not deferred to Phase 3.

**Phase 3 compliance:**

- Message retention policies per tenant (configurable: 90 days, 1 year, 3 years, indefinite)
- Compliance hold: prevent message deletion when legal hold is active
- Audit log: all message operations (create, edit, delete, read) logged with user ID and timestamp
- Data export: CSV/JSON export of channel history for compliance officers

---

## 5. Mobile App Changes

### 5.1 New Tab: Messages

The bottom navigation bar currently has 4 tabs (Home, Operations, Tasks, Account). Material Design guidelines recommend a maximum of 5 tabs. Messages becomes the 5th tab, placed between Tasks and Account for thumb reachability.

**Updated tab order:**

| Position | Tab | Icon | Color |
|----------|-----|------|-------|
| 1 | Home | `Home` | ocean-600 |
| 2 | Operations | `ClipboardList` | orange-600 |
| 3 | Tasks | `CheckSquare` | green-600 |
| 4 | **Messages** | **`MessageSquare`** | **indigo-600** |
| 5 | Account | `User` | gray-600 |

The Messages tab shows a badge with the total unread message count across all channels.

### 5.2 New Pages

| Page | Route | Purpose | Est. Lines |
|------|-------|---------|-----------|
| `ChannelListPage.tsx` | `/messages` | List of channels sorted by last message. Search bar. FAB for new chat. Unread indicators per channel. | ~320 |
| `ChatRoomPage.tsx` | `/messages/:channelId` | Full-screen chat room with message list, input bar, attachment picker. Infinite scroll for history. | ~450 |
| `NewChatPage.tsx` | `/messages/new` | User picker for starting a DM or creating a group. Search by name/email. | ~220 |
| `ChannelSettingsPage.tsx` | `/messages/:channelId/settings` | Channel name, avatar, members list, notification preference, leave/delete. | ~280 |
| `MediaViewerPage.tsx` | `/messages/media/:attachmentId` | Full-screen image/document viewer with pinch-to-zoom, download button. | ~180 |

### 5.3 New Hooks

| Hook | Purpose | Est. Lines |
|------|---------|-----------|
| `useChannels.ts` | React Query hook for channel list with unread counts. IndexedDB cache fallback. Refetch on Socket.IO event. | ~120 |
| `useMessages.ts` | React Query infinite query for paginated messages in a channel. IndexedDB cache. Optimistic send. | ~180 |
| `useMessageSocket.ts` | Socket.IO connection to `/messaging` namespace. Joins channel rooms. Emits/receives typing, presence, newMessage events. Reconnection handling. | ~200 |
| `useSendMessage.ts` | Mutation hook for sending messages. Handles offline queue, optimistic update, media upload flow. | ~150 |
| `useChannelMembers.ts` | Query hook for channel member list with online status. | ~80 |
| `useUnreadCount.ts` | Lightweight hook for total unread count (badge). Redis-backed, polled every 60s + Socket.IO push. | ~60 |
| `useMediaUpload.ts` | Presigned URL request + direct MinIO upload + progress tracking. Compression for images > 2MB. | ~140 |
| `useTypingIndicator.ts` | Throttled typing event emission (max 1 per 3 seconds). Display logic for received typing events. | ~70 |

### 5.4 New Components

| Component | Purpose | Est. Lines |
|-----------|---------|-----------|
| `ChannelListItem.tsx` | Single channel row: avatar, name, last message preview, timestamp, unread badge. | ~90 |
| `MessageBubble.tsx` | Single message: sender avatar, content, timestamp, read receipts, reply indicator. Long-press context menu (500ms threshold) with Reply, Copy, Forward, Delete options. All touch targets >= 48dp. Swipe-to-reply intentionally omitted because it conflicts with system back-swipe on iOS and is not discoverable for glove-wearing users. | ~180 |
| `MessageInput.tsx` | Input bar: text field (auto-resize), send button (minimum 48x48dp), attachment button (camera, gallery, file), voice note button (Phase 2). Uses `position: sticky; bottom: 0` with VisualViewport API for iOS keyboard handling: `window.visualViewport.addEventListener('resize', adjustPosition)` ensures the input bar remains visible above the virtual keyboard. Fallback for browsers without VisualViewport: `window.addEventListener('resize', ...)` with 100ms debounce. | ~220 |
| `AttachmentPicker.tsx` | Bottom sheet with camera, gallery, file options. Uses `input[type=file]` with accept filters. | ~120 |
| `ImagePreview.tsx` | Image attachment preview before send. Crop/resize option. | ~100 |
| `TypingIndicator.tsx` | Animated "..." dots with typing user names. | ~40 |
| `ReadReceipt.tsx` | Single/double checkmark icons for delivered/read status. | ~30 |
| `ChannelAvatar.tsx` | Channel avatar with fallback to initials. Group avatar shows stacked member avatars. | ~60 |
| `MessageDateSeparator.tsx` | "Today", "Yesterday", "March 25" separator between message groups. | ~30 |
| `SystemMessage.tsx` | Centered gray text for "John joined the channel" type messages. | ~20 |
| `EmptyChat.tsx` | Empty state for new channels: illustration + "Send your first message" prompt. | ~40 |
| `UnreadBadge.tsx` | Reusable unread count badge (channel list + tab bar). | ~25 |

### 5.5 New Types

```typescript
// =============================================================================
// ADR-012: Messaging Types
// Added to src/types/index.ts
// =============================================================================

// Channel types
export type ChannelType = 'direct' | 'group' | 'ai';
export type ChannelMemberRole = 'owner' | 'admin' | 'member';
export type NotificationPreference = 'all' | 'mentions' | 'none';

export interface Channel {
  id: string;
  type: ChannelType;
  name: string | null;
  description: string | null;
  avatarUrl: string | null;
  createdBy: string | null;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
  // Computed fields from resolver
  lastMessage: Message | null;
  unreadCount: number;
  memberCount: number;
  members: ChannelMember[];
}

export interface ChannelMember {
  id: string;
  channelId: string;
  userId: string;
  role: ChannelMemberRole;
  notificationPreference: NotificationPreference;
  lastReadAt: string | null;
  joinedAt: string;
  leftAt: string | null;
  // Resolved from auth service
  user: MessageUser;
}

export interface MessageUser {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
  profileImageUrl: string | null;
  isOnline: boolean;
}

// Message types
export type MessageContentType = 'text' | 'image' | 'file' | 'voice' | 'system';
export type ReceiptStatus = 'delivered' | 'read';

export interface Message {
  id: string;
  channelId: string;
  senderId: string;
  content: string | null;
  contentType: MessageContentType;
  parentId: string | null;
  parent: Message | null;
  forwardedFrom: string | null;
  isDeleted: boolean;
  createdAt: string;
  editedAt: string | null;
  metadata: Record<string, unknown> | null;
  // Resolved fields
  sender: MessageUser;
  attachments: MessageAttachment[];
  receipts: MessageReceipt[];
  reactions: MessageReaction[];
}

export interface MessageAttachment {
  id: string;
  messageId: string;
  storageKey: string;
  originalFilename: string;
  mimeType: string;
  fileSize: number;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
  downloadUrl: string;
}

export interface MessageReceipt {
  id: string;
  messageId: string;
  userId: string;
  status: ReceiptStatus;
  deliveredAt: string | null;
  readAt: string | null;
}

export interface MessageReaction {
  id: string;
  messageId: string;
  userId: string;
  emoji: string;
  createdAt: string;
}

// Input types for mutations
export interface SendMessageInput {
  channelId: string;
  content: string | null;
  contentType: MessageContentType;
  parentId?: string;
  attachmentKeys?: string[];
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}

export interface CreateChannelInput {
  type: ChannelType;
  name?: string;
  description?: string;
  memberIds: string[];
}

export interface RequestMediaUploadInput {
  channelId: string;
  filename: string;
  mimeType: string;
  fileSize: number;
}

export interface MediaUploadResponse {
  uploadUrl: string;
  storageKey: string;
  expiresAt: string;
}

// Socket.IO event types
export interface SocketNewMessageEvent {
  channelId: string;
  message: Message;
}

export interface SocketTypingEvent {
  channelId: string;
  userId: string;
  userName: string;
  isTyping: boolean;
}

export interface SocketPresenceEvent {
  userId: string;
  isOnline: boolean;
  lastSeenAt: string;
}

export interface SocketMessageReadEvent {
  channelId: string;
  messageId: string;
  userId: string;
  readAt: string;
}

// Offline queue additions
export type OperationType =
  | ... // existing types
  | 'sendMessage'
  | 'editMessage'
  | 'deleteMessage'
  | 'markMessagesRead';

export interface SendMessagePayload {
  channelId: string;
  content: string | null;
  contentType: MessageContentType;
  parentId?: string;
  attachmentKeys?: string[];
  idempotencyKey: string;
}
```

### 5.6 Routes

```typescript
// Added to App.tsx within the protected MobileLayout routes

// Lazy-loaded page imports
const ChannelListPage = lazy(() =>
  import('./pages/messaging/ChannelListPage').then((m) => ({ default: m.ChannelListPage }))
);
const ChatRoomPage = lazy(() =>
  import('./pages/messaging/ChatRoomPage').then((m) => ({ default: m.ChatRoomPage }))
);
const NewChatPage = lazy(() =>
  import('./pages/messaging/NewChatPage').then((m) => ({ default: m.NewChatPage }))
);
const ChannelSettingsPage = lazy(() =>
  import('./pages/messaging/ChannelSettingsPage').then((m) => ({ default: m.ChannelSettingsPage }))
);
const MediaViewerPage = lazy(() =>
  import('./pages/messaging/MediaViewerPage').then((m) => ({ default: m.MediaViewerPage }))
);

// Routes (no FeatureRoute wrapper -- messaging is available to all authenticated users)
<Route path="/messages" element={<ChannelListPage />} />
<Route path="/messages/new" element={<NewChatPage />} />
<Route path="/messages/:channelId" element={<ChatRoomPage />} />
<Route path="/messages/:channelId/settings" element={<ChannelSettingsPage />} />
<Route path="/messages/media/:attachmentId" element={<MediaViewerPage />} />
```

---

## 6. Backend Service Design

### 6.1 Module Structure

```
apps/messaging-service/
  src/
    main.ts                                  -- Bootstrap, port 3000
    app.module.ts                            -- Root module (see tenant providers below)
    health/
      health.controller.ts                   -- /health, /ready endpoints
      health.module.ts
    channel/
      entities/
        channel.entity.ts                    -- TypeORM entity (~80 lines)
        channel-member.entity.ts             -- TypeORM entity (~60 lines)
      dto/
        create-channel.input.ts              -- GraphQL input type (~40 lines)
        update-channel.input.ts              -- GraphQL input type (~30 lines)
        channel-filter.input.ts              -- Pagination/filter input (~25 lines)
      commands/
        create-channel.command.ts            -- CQRS command (~15 lines)
        create-channel.handler.ts            -- Handler: validate, persist, publish event (~80 lines)
        add-member.command.ts
        add-member.handler.ts
        remove-member.command.ts
        remove-member.handler.ts
        update-channel.command.ts
        update-channel.handler.ts
      queries/
        get-channels.query.ts               -- CQRS query (~15 lines)
        get-channels.handler.ts             -- Handler: paginated channel list (~60 lines)
        get-channel.query.ts
        get-channel.handler.ts
      resolvers/
        channel.resolver.ts                  -- GraphQL resolver (~120 lines)
      services/
        channel.service.ts                   -- Domain logic (~150 lines)
      channel.module.ts                      -- NestJS module (~30 lines)
    message/
      entities/
        message.entity.ts                    -- TypeORM entity (~90 lines)
        message-attachment.entity.ts         -- TypeORM entity (~60 lines)
        message-receipt.entity.ts            -- TypeORM entity (~40 lines)
        message-reaction.entity.ts           -- TypeORM entity (~35 lines)
        pinned-message.entity.ts             -- TypeORM entity (~30 lines)
      dto/
        send-message.input.ts                -- GraphQL input type (~40 lines)
        edit-message.input.ts                -- GraphQL input type (~20 lines)
        message-filter.input.ts              -- Cursor pagination input (~30 lines)
        request-media-upload.input.ts        -- GraphQL input type (~25 lines)
      commands/
        send-message.command.ts
        send-message.handler.ts              -- Validate, persist, publish event (~120 lines)
        edit-message.command.ts
        edit-message.handler.ts
        delete-message.command.ts
        delete-message.handler.ts
        mark-read.command.ts
        mark-read.handler.ts
      queries/
        get-messages.query.ts
        get-messages.handler.ts              -- Cursor-based pagination (~80 lines)
        get-messages-since.query.ts
        get-messages-since.handler.ts        -- Offline sync query (~60 lines)
        search-messages.query.ts
        search-messages.handler.ts           -- Full-text search (~70 lines)
      resolvers/
        message.resolver.ts                  -- GraphQL resolver (~180 lines)
      services/
        message.service.ts                   -- Domain logic (~200 lines)
        media.service.ts                     -- MinIO presigned URL generation (~120 lines)
        thumbnail.service.ts                 -- Sharp.js thumbnail generation (~80 lines)
      message.module.ts
    presence/
      presence.service.ts                    -- Redis-backed online/offline tracking (~100 lines)
      presence.module.ts
    partition/
      partition-manager.service.ts           -- Monthly partition creation cron job (~80 lines)
      partition.module.ts
    event-handlers/
      messaging-nats.handler.ts              -- NATS event subscriber for cross-service events (~60 lines)
    shared/
      guards/
        channel-member.guard.ts              -- Validates user is channel member (~40 lines)
        message-owner.guard.ts               -- Validates user owns the message (~30 lines)
      decorators/
        current-channel.decorator.ts         -- Parameter decorator for channel context (~15 lines)
      interceptors/
        messaging-rate-limit.interceptor.ts  -- Redis sliding window rate limiter (~60 lines)
```

**Tenant infrastructure providers (C3):**

The messaging-service MUST include all five tenant-scoping providers from `@aquaculture/backend-common`. These are not optional -- without them, the service will write to the `public` schema instead of the tenant schema, causing data leaks across tenants. This matches the pattern used by `sensor-service`, `farm-service`, `hr-service`, `hydroponics-service`, and `alert-engine`.

```typescript
// apps/messaging-service/src/app.module.ts
import {
  SourceSchemaBootstrapService,
  TenantSchemaSyncService,
  SourceSchemaWriteGuardService,
  createTenantConnectionBootstrap,
  createTenantSchemaMiddleware,
} from '@aquaculture/backend-common';

const TenantSchemaMiddleware = createTenantSchemaMiddleware('messaging');
const TenantConnectionBootstrap = createTenantConnectionBootstrap('messaging');

@Module({
  imports: [
    // TypeORM with messaging entities
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get('DATABASE_HOST', 'localhost'),
        port: config.get<number>('DATABASE_PORT', 5432),
        username: config.get('DATABASE_USER', 'aquaculture'),
        password: config.get('DATABASE_PASSWORD', 'devpassword'),
        database: config.get('DATABASE_NAME', 'aquaculture'),
        entities: [
          Channel, ChannelMember, Message, MessageAttachment,
          MessageReceipt, MessageReaction, PinnedMessage,
        ],
        synchronize: false,  // ALWAYS false — partitioned tables require migrations
        migrationsRun: config.get('DATABASE_MIGRATIONS_RUN', 'true') === 'true',
        migrations: ['dist/migrations/*.js'],
      }),
    }),
    // GraphQL Federation subgraph
    GraphQLModule.forRoot<ApolloFederationDriverConfig>({
      driver: ApolloFederationDriver,
      autoSchemaFile: { federation: 2 },
    }),
    // NATS transport
    ClientsModule.register([{
      name: 'NATS_SERVICE',
      transport: Transport.NATS,
      options: { servers: [process.env.NATS_URL || 'nats://localhost:4222'] },
    }]),
    // Redis
    RedisModule.forRoot({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      db: parseInt(process.env.REDIS_DB || '3', 10),
    }),
    // Feature modules
    HealthModule,
    ChannelModule,
    MessageModule,
    PresenceModule,
    PartitionModule,
  ],
  providers: [
    // 1. Bootstrap source schema tables on startup (creates template tables if missing)
    SourceSchemaBootstrapService,
    // 2. Pool-level tenant schema routing (patches pg Pool.connect for search_path injection)
    TenantConnectionBootstrap,
    // 3. Auto-sync tenant schemas with source schema (creates missing tables/columns)
    TenantSchemaSyncService,
    // 4. DB-level write guards on source schema (defense-in-depth: prevents accidental
    //    writes to the 'messaging' source schema instead of tenant_* schemas)
    SourceSchemaWriteGuardService,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // 5. Tenant schema middleware: extracts tenantId from JWT/header,
    //    sets search_path to tenant_<uuid> for the request lifetime
    consumer.apply(TenantSchemaMiddleware).forRoutes('*');
  }
}
```

**MODULE_SCHEMAS registry update:**

The `schema-manager.service.ts` in `@aquaculture/backend-common` maintains a `MODULE_SCHEMAS` array that lists every module's tables. The messaging module MUST be registered here so that tenant provisioning (`createTenantSchema`) and sync (`syncTenantSchema`) include messaging tables.

```typescript
// libs/backend-common/src/database/schema-manager.service.ts
// Add to MODULE_SCHEMAS array:
{
  moduleName: 'messaging',
  sourceSchema: 'messaging',
  tables: [
    'channels',
    'channel_members',
    'messages',           // partitioned — migration creates partitions
    'message_attachments',
    'message_receipts',   // partitioned — migration creates partitions
    'message_reactions',
    'pinned_messages',
  ],
  referenceDataTables: [],  // no reference/seed data for messaging
},
```

**Why all five providers are required:**

| Provider | Consequence if Missing |
|----------|----------------------|
| `SourceSchemaBootstrapService` | Source `messaging` schema never created; TypeORM entities have no template to copy to tenant schemas |
| `TenantConnectionBootstrap` | Every SQL query runs against `public` schema instead of `tenant_<uuid>`; complete tenant isolation failure |
| `TenantSchemaSyncService` | New tenants provisioned after messaging-service deploy will not have messaging tables |
| `SourceSchemaWriteGuardService` | Bugs could write messages to the source schema instead of tenant schemas; no defense-in-depth |
| `TenantSchemaMiddleware` | `search_path` never set; all queries target wrong schema |

**Estimated total: ~2,800 lines across ~45 files**

### 6.2 GraphQL Schema

```graphql
# =============================================================================
# messaging-service Federation Subgraph Schema
# =============================================================================

# --- Enums ---

enum ChannelType {
  DIRECT
  GROUP
  AI
}

enum ChannelMemberRole {
  OWNER
  ADMIN
  MEMBER
}

enum NotificationPreference {
  ALL
  MENTIONS
  NONE
}

enum MessageContentType {
  TEXT
  IMAGE
  FILE
  VOICE
  SYSTEM
}

enum ReceiptStatus {
  DELIVERED
  READ
}

# --- Types ---

type Channel {
  id: ID!
  type: ChannelType!
  name: String
  description: String
  avatarUrl: String
  createdBy: String
  isArchived: Boolean!
  createdAt: DateTime!
  updatedAt: DateTime!
  lastMessage: Message
  unreadCount: Int!
  memberCount: Int!
  members: [ChannelMember!]!
}

type ChannelMember {
  id: ID!
  channelId: String!
  userId: String!
  role: ChannelMemberRole!
  notificationPreference: NotificationPreference!
  lastReadAt: DateTime
  joinedAt: DateTime!
  leftAt: DateTime
  user: MessageUser!
}

type MessageUser @key(fields: "id") {
  id: ID!
  firstName: String
  lastName: String
  email: String!
  profileImageUrl: String
  isOnline: Boolean!
}

type Message {
  id: ID!
  channelId: String!
  senderId: String!
  content: String
  contentType: MessageContentType!
  parentId: String
  parent: Message
  forwardedFrom: String
  isDeleted: Boolean!
  createdAt: DateTime!
  editedAt: DateTime
  sender: MessageUser!
  attachments: [MessageAttachment!]!
  receipts: [MessageReceipt!]!
  reactionSummary: [ReactionSummary!]!
}

type MessageAttachment {
  id: ID!
  originalFilename: String!
  mimeType: String!
  fileSize: Int!
  width: Int
  height: Int
  durationSeconds: Float
  thumbnailUrl: String
  downloadUrl: String!
}

type MessageReceipt {
  userId: String!
  status: ReceiptStatus!
  deliveredAt: DateTime
  readAt: DateTime
}

type ReactionSummary {
  emoji: String!
  count: Int!
  userIds: [String!]!
  hasReacted: Boolean!
}

type PinnedMessage {
  id: ID!
  channelId: String!
  message: Message!
  pinnedBy: String!
  pinnedAt: DateTime!
}

type MediaUploadResponse {
  uploadUrl: String!
  storageKey: String!
  expiresAt: DateTime!
}

"""Response for allMessagesSince bulk offline sync (H7)"""
type AllMessagesSinceResponse {
  """Messages across all channels, capped at 50 per channel within the global limit"""
  items: [Message!]!
  """True if more messages exist beyond the limit — client should re-request with syncToken"""
  hasMore: Boolean!
  """Opaque token encoding the last processed (channelId, messageId, createdAt) tuple.
  Pass this back as syncToken to continue paging."""
  syncToken: String
}

type MessagePage {
  items: [Message!]!
  hasMore: Boolean!
  cursor: String
}

type ChannelPage {
  items: [Channel!]!
  total: Int!
}

# --- Inputs ---

input CreateChannelInput {
  type: ChannelType!
  name: String
  description: String
  memberIds: [String!]!
}

input UpdateChannelInput {
  name: String
  description: String
  avatarUrl: String
}

input SendMessageInput {
  channelId: String!
  content: String
  contentType: MessageContentType! = TEXT
  parentId: String
  attachmentKeys: [String!]
  idempotencyKey: String!
  metadata: JSON
}

input EditMessageInput {
  content: String!
}

input RequestMediaUploadInput {
  channelId: String!
  filename: String!
  mimeType: String!
  fileSize: Int!
}

input MarkReadInput {
  channelId: String!
  messageId: String!
}

input MessageFilterInput {
  cursor: String
  limit: Int = 50
  before: DateTime
  after: DateTime
}

input SearchMessagesInput {
  query: String!
  channelId: String
  limit: Int = 20
}

# --- Queries ---

type Query {
  """List channels for the current user, sorted by last message timestamp"""
  myChannels(limit: Int = 50, offset: Int = 0): ChannelPage!

  """Get a single channel by ID (must be a member)"""
  channel(id: String!): Channel

  """Get paginated messages in a channel (cursor-based, newest first)"""
  messages(channelId: String!, filter: MessageFilterInput): MessagePage!

  """Get messages since a timestamp (for offline sync)"""
  messagesSince(channelId: String!, since: DateTime!): [Message!]!

  """
  Get all new messages across all channels since timestamp (bulk offline sync).
  Per-channel cap of 50 messages prevents a single high-traffic channel from
  consuming the entire budget. Returns hasMore + syncToken for incremental paging.
  """
  allMessagesSince(since: DateTime!, limit: Int = 500, syncToken: String): AllMessagesSinceResponse!

  """Get total unread message count across all channels"""
  totalUnreadMessageCount: Int!

  """Search messages by content (full-text search)"""
  searchMessages(input: SearchMessagesInput!): [Message!]!

  """Get pinned messages in a channel"""
  pinnedMessages(channelId: String!): [PinnedMessage!]!

  """Get online/offline status for a list of user IDs"""
  userPresence(userIds: [String!]!): [MessageUser!]!

  """Get or create a DM channel with another user"""
  directChannel(userId: String!): Channel!
}

# --- Mutations ---

type Mutation {
  """Create a new group channel"""
  createChannel(input: CreateChannelInput!): Channel!

  """Update channel name, description, or avatar"""
  updateChannel(id: String!, input: UpdateChannelInput!): Channel!

  """Archive (soft-delete) a channel"""
  archiveChannel(id: String!): Boolean!

  """Add a member to a channel"""
  addChannelMember(channelId: String!, userId: String!, role: ChannelMemberRole = MEMBER): ChannelMember!

  """Remove a member from a channel (or leave)"""
  removeChannelMember(channelId: String!, userId: String!): Boolean!

  """Update notification preference for a channel"""
  updateNotificationPreference(channelId: String!, preference: NotificationPreference!): ChannelMember!

  """Send a message to a channel"""
  sendMessage(input: SendMessageInput!): Message!

  """Edit a message (own messages only)"""
  editMessage(id: String!, input: EditMessageInput!): Message!

  """Soft-delete a message"""
  deleteMessage(id: String!): Boolean!

  """Mark messages as read up to a given message"""
  markMessagesRead(input: MarkReadInput!): Boolean!

  """Request a presigned URL for media upload"""
  requestMediaUpload(input: RequestMediaUploadInput!): MediaUploadResponse!

  """Pin a message in a channel"""
  pinMessage(channelId: String!, messageId: String!): PinnedMessage!

  """Unpin a message"""
  unpinMessage(channelId: String!, messageId: String!): Boolean!

  """Add a reaction to a message"""
  addReaction(messageId: String!, emoji: String!): Boolean!

  """Remove a reaction from a message"""
  removeReaction(messageId: String!, emoji: String!): Boolean!

  """Export all messages authored by the current user (GDPR Article 20, H3)"""
  exportMyMessages: JSON! @rateLimit(window: "24h", max: 1)

  """Anonymize all messaging data for the current user (GDPR Article 17, H3)"""
  anonymizeMyData(confirmPassword: String!): Boolean!
}
```

**MessageUser resolution strategy (H9):**

`MessageUser` is a federation reference type (`@key(fields: "id")`). The user data (firstName, lastName, email, profileImageUrl) does not live in the messaging database -- it lives in auth-service. Resolution follows this strategy:

1. **GraphQL resolver** for `Message.sender` and `ChannelMember.user` uses a **DataLoader** pattern to batch user ID lookups within a single request. This prevents N+1 queries when loading a page of 50 messages (50 individual resolver calls are batched into one lookup).

2. **Data source:** NATS request-reply to auth-service on subject `request.auth.getUsersBatch` with payload `{ userIds: string[] }`. Auth-service returns `{ users: MessageUser[] }`.

3. **Redis cache:** Resolved users are cached at `msg:{tenantId}:user:{userId}` with a 5-minute TTL. The DataLoader checks Redis first; only cache misses are sent to auth-service via NATS.

4. **Fallback:** If auth-service is unavailable (NATS timeout after 3 seconds), the resolver returns a minimal `MessageUser` with `id` populated but `firstName = null`, `lastName = null`, `email = 'unknown'`, `isOnline = false`. The client displays "Unknown User" and retries on next page load.

**Why NATS request-reply instead of a direct database query:** The messaging-service must not have a direct connection to the auth database. Cross-service data access goes through APIs (GraphQL federation) or NATS request-reply. Redis caching keeps the 95th percentile latency under 5ms for user resolution.

### 6.3 NATS Events

Events published by messaging-service to the `AQUACULTURE_EVENTS` JetStream stream:

| Subject | Payload | Consumers |
|---------|---------|-----------|
| `events.MessageSent` | `{ eventId, tenantId, channelId, messageId, senderId, contentType, hasAttachments }` | notification-service (push), gateway-api (Socket.IO broadcast) |
| `events.MessageUpdated` | `{ eventId, tenantId, channelId, messageId, senderId }` | gateway-api (Socket.IO broadcast) |
| `events.MessageDeleted` | `{ eventId, tenantId, channelId, messageId, senderId }` | gateway-api (Socket.IO broadcast) |
| `events.ChannelCreated` | `{ eventId, tenantId, channelId, channelType, memberIds }` | gateway-api (Socket.IO: join room) |
| `events.ChannelMemberAdded` | `{ eventId, tenantId, channelId, userId }` | gateway-api (Socket.IO: join room) |
| `events.ChannelMemberRemoved` | `{ eventId, tenantId, channelId, userId }` | gateway-api (Socket.IO: leave room) |
| `events.MessageRead` | `{ eventId, tenantId, channelId, messageId, userId, readAt }` | gateway-api (Socket.IO: read receipt) |

Ephemeral events (NATS core, not JetStream -- no persistence needed):

| Subject | Payload | Consumers |
|---------|---------|-----------|
| `messaging.typing.{tenantId}.{channelId}` | `{ userId, userName, isTyping }` | gateway-api (Socket.IO forward) |
| `messaging.presence.{tenantId}` | `{ userId, isOnline, lastSeenAt }` | gateway-api (Socket.IO forward) |

**Security:** NATS event payloads NEVER contain message content. Only IDs and metadata are transmitted over the event bus. Content is fetched via the GraphQL API only by authorized channel members.

### 6.4 WebSocket Gateway

New gateway class in `gateway-api/src/websocket/messaging.gateway.ts`:

```typescript
@WebSocketGateway({
  cors: buildWsCorsConfig(),
  namespace: '/messaging',
  transports: ['websocket', 'polling'],
})
export class MessagingGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  // Connection handling:
  // 1. JWT validation (reuse SensorReadingsGateway pattern)
  // 2. Load user's channels from messaging-service (NATS request-reply or Redis cache)
  // 3. Join Socket.IO rooms: channel:{channelId} for each channel
  // 4. Update presence in Redis: SET msg:{tenantId}:presence:{userId} ONLINE EX 300
  //
  // Inbound events from clients:
  // - 'joinChannel': join a specific channel room (validated against membership)
  // - 'leaveChannel': leave a channel room
  // - 'typing': broadcast typing indicator to channel room (throttled)
  // - 'markRead': update last_read_at (delegated to messaging-service via NATS)
  //
  // Outbound events to clients (from NATS bridge):
  // - 'newMessage': new message in a channel
  // - 'messageUpdated': edited message
  // - 'messageDeleted': deleted message
  // - 'typing': typing indicator from another user
  // - 'presence': user online/offline status change
  // - 'readReceipt': read receipt update
  // - 'channelUpdated': channel metadata changed
  // - 'memberAdded': new member joined channel
  // - 'memberRemoved': member left/removed
}
```

**WebSocket token refresh protocol (H1):**

JWT access tokens expire every 15 minutes, but WebSocket connections persist for hours. Without token refresh, a connected user's claims become stale (e.g., role changes, tenant switches, account suspension are not reflected).

1. **Server-initiated re-auth:** Every 5 minutes, the server emits a `reAuth` event to the client.
2. **Client responds:** Client calls `authenticatedFetch` to obtain a fresh `accessToken` from the auth-service refresh endpoint, then emits `reAuthResponse` with the new token.
3. **Server validates:** The gateway validates the new token (signature, expiry, tenantId). If valid, it updates the socket's session claims (roles, tenantId, userId). If the user's tenant or roles changed, the gateway re-evaluates channel room memberships (joins new rooms, leaves revoked ones).
4. **Failure handling:** If the client fails to respond to `reAuth` within 30 seconds, or if the provided token is invalid, the server increments a failure counter. After 3 consecutive failures, the server disconnects the socket with a `4401 Unauthorized` close code. The client's reconnection handler will prompt a full re-login.
5. **Suspension detection:** If the refreshed token reveals the user is suspended (`status = 'suspended'`), the server immediately disconnects with `4403 Forbidden`.

**Why:** A long-lived WebSocket connection without token refresh is a security gap. A user whose account is suspended or whose role is downgraded continues to receive messages and maintain presence until they manually disconnect. The 5-minute re-auth interval balances security (stale claims detected within 5 minutes) with overhead (one lightweight event per 5 minutes per connection).

**Connection lifecycle:**

```
Client connects -> JWT verified -> channels loaded -> rooms joined -> presence SET
Every 5 min -> server sends reAuth -> client responds with fresh token -> claims updated
Client disconnects -> rooms left -> presence DEL -> offline event published
Heartbeat (30s) -> presence TTL refreshed (EXPIRE 300s)
3 failed reAuth -> server disconnects client -> client prompts re-login
```

### 6.5 CQRS Commands and Queries

The messaging-service uses the existing `@platform/cqrs` library for command/query separation:

**Commands (write side):**

| Command | Handler | Side Effects |
|---------|---------|--------------|
| `CreateChannelCommand` | Validates members exist in tenant, creates channel + members, publishes `ChannelCreated` | DB write, NATS publish |
| `SendMessageCommand` | Validates membership + idempotency, persists message, publishes `MessageSent` | DB write, NATS publish |
| `EditMessageCommand` | Validates ownership, updates content + edited_at, publishes `MessageUpdated` | DB write, NATS publish |
| `DeleteMessageCommand` | Validates ownership or admin role, soft-deletes, publishes `MessageDeleted` | DB write, NATS publish |
| `MarkReadCommand` | Updates `last_read_at` on channel_members, creates/updates receipt | DB write, NATS publish |
| `AddChannelMemberCommand` | Validates role hierarchy (see below), adds member, publishes `ChannelMemberAdded` | DB write, NATS publish |
| `RemoveMemberCommand` | Validates admin role or self-leave, soft-removes, publishes `ChannelMemberRemoved` | DB write, NATS publish |

**Role assignment validation rules (H4):**

The `AddChannelMemberCommand` handler enforces a strict role hierarchy to prevent privilege escalation:

| Assigner's Channel Role | Can Assign MEMBER | Can Assign ADMIN | Can Assign OWNER |
|------------------------|-------------------|------------------|------------------|
| OWNER | Yes | Yes | Yes |
| ADMIN | Yes | Yes | No |
| MEMBER | No | No | No |

Additional authorization rules:

- `createChannel` mutation for `type = GROUP` is restricted to users with platform role `MODULE_MANAGER` or higher. This prevents field workers from creating unlimited group channels.
- `createChannel` mutation for `type = DIRECT` (via `directChannel` query) is available to all authenticated users with `MODULE_USER` or higher.
- `archiveChannel` is restricted to the channel OWNER or users with platform role `TENANT_ADMIN`.
- These rules are enforced in the command handlers, not in GraphQL guards, to ensure they apply regardless of how the command is dispatched (GraphQL mutation, NATS event, or future REST endpoint).

**Why:** Without role hierarchy enforcement, any channel admin could assign OWNER role to themselves or others, effectively taking over channels. The OWNER role must be a deliberate assignment by the current OWNER only.

**Queries (read side):**

| Query | Handler | Optimization |
|-------|---------|-------------|
| `GetChannelsQuery` | Paginated channel list with last message + unread count | Redis cached unread counts; single SQL with JOIN + subquery |
| `GetMessagesQuery` | Cursor-based pagination (keyset pagination on `created_at, id`) | Index scan on `idx_messages_channel_created`; presigned URLs generated in batch |
| `GetMessagesSinceQuery` | Offline sync: all messages after timestamp | Partition-pruned scan; limit 500 per request |
| `SearchMessagesQuery` | Full-text search via `to_tsvector` | GIN index; restricted to user's channels |
| `GetUnreadCountQuery` | Total unread across all channels | Redis counter: `msg:{tenantId}:unread:{userId}` |

---

## 7. File Inventory

### 7.1 New Files to Create

**Backend -- messaging-service (new service):**

| # | File Path | Purpose | Est. Lines |
|---|-----------|---------|-----------|
| 1 | `apps/messaging-service/project.json` | NX project configuration | ~40 |
| 2 | `apps/messaging-service/tsconfig.app.json` | TypeScript config | ~15 |
| 3 | `apps/messaging-service/tsconfig.json` | TypeScript base config | ~10 |
| 4 | `apps/messaging-service/jest.config.ts` | Jest test config | ~15 |
| 5 | `apps/messaging-service/Dockerfile` | Symlink or copy of `Dockerfile.backend.simple` (shared) | ~5 |
| 6 | `apps/messaging-service/.env.example` | Environment variable reference | ~30 |
| 7 | `apps/messaging-service/src/main.ts` | Bootstrap + port 3000 | ~50 |
| 8 | `apps/messaging-service/src/app.module.ts` | Root module (TypeORM, GraphQL, NATS, Redis, JWT) | ~130 |
| 9 | `apps/messaging-service/src/health/health.controller.ts` | Health + readiness endpoints | ~40 |
| 10 | `apps/messaging-service/src/health/health.module.ts` | Health module | ~15 |
| 11 | `apps/messaging-service/src/channel/entities/channel.entity.ts` | Channel TypeORM entity | ~80 |
| 12 | `apps/messaging-service/src/channel/entities/channel-member.entity.ts` | ChannelMember TypeORM entity | ~60 |
| 13 | `apps/messaging-service/src/channel/dto/create-channel.input.ts` | CreateChannel GraphQL input | ~40 |
| 14 | `apps/messaging-service/src/channel/dto/update-channel.input.ts` | UpdateChannel GraphQL input | ~30 |
| 15 | `apps/messaging-service/src/channel/dto/channel-filter.input.ts` | Channel list filter/pagination | ~25 |
| 16 | `apps/messaging-service/src/channel/commands/create-channel.command.ts` | CQRS command | ~15 |
| 17 | `apps/messaging-service/src/channel/commands/create-channel.handler.ts` | CQRS handler | ~80 |
| 18 | `apps/messaging-service/src/channel/commands/add-member.command.ts` | CQRS command | ~15 |
| 19 | `apps/messaging-service/src/channel/commands/add-member.handler.ts` | CQRS handler | ~60 |
| 20 | `apps/messaging-service/src/channel/commands/remove-member.command.ts` | CQRS command | ~15 |
| 21 | `apps/messaging-service/src/channel/commands/remove-member.handler.ts` | CQRS handler | ~50 |
| 22 | `apps/messaging-service/src/channel/commands/update-channel.command.ts` | CQRS command | ~15 |
| 23 | `apps/messaging-service/src/channel/commands/update-channel.handler.ts` | CQRS handler | ~50 |
| 24 | `apps/messaging-service/src/channel/queries/get-channels.query.ts` | CQRS query | ~15 |
| 25 | `apps/messaging-service/src/channel/queries/get-channels.handler.ts` | CQRS handler | ~60 |
| 26 | `apps/messaging-service/src/channel/queries/get-channel.query.ts` | CQRS query | ~15 |
| 27 | `apps/messaging-service/src/channel/queries/get-channel.handler.ts` | CQRS handler | ~40 |
| 28 | `apps/messaging-service/src/channel/resolvers/channel.resolver.ts` | GraphQL resolver | ~120 |
| 29 | `apps/messaging-service/src/channel/services/channel.service.ts` | Domain logic | ~150 |
| 30 | `apps/messaging-service/src/channel/channel.module.ts` | NestJS module | ~30 |
| 31 | `apps/messaging-service/src/message/entities/message.entity.ts` | Message TypeORM entity | ~90 |
| 32 | `apps/messaging-service/src/message/entities/message-attachment.entity.ts` | Attachment TypeORM entity | ~60 |
| 33 | `apps/messaging-service/src/message/entities/message-receipt.entity.ts` | Receipt TypeORM entity | ~40 |
| 34 | `apps/messaging-service/src/message/entities/message-reaction.entity.ts` | Reaction TypeORM entity | ~35 |
| 35 | `apps/messaging-service/src/message/entities/pinned-message.entity.ts` | PinnedMessage TypeORM entity | ~30 |
| 36 | `apps/messaging-service/src/message/dto/send-message.input.ts` | SendMessage GraphQL input | ~40 |
| 37 | `apps/messaging-service/src/message/dto/edit-message.input.ts` | EditMessage GraphQL input | ~20 |
| 38 | `apps/messaging-service/src/message/dto/message-filter.input.ts` | Cursor pagination input | ~30 |
| 39 | `apps/messaging-service/src/message/dto/request-media-upload.input.ts` | Media upload input | ~25 |
| 40 | `apps/messaging-service/src/message/commands/send-message.command.ts` | CQRS command | ~15 |
| 41 | `apps/messaging-service/src/message/commands/send-message.handler.ts` | CQRS handler | ~120 |
| 42 | `apps/messaging-service/src/message/commands/edit-message.command.ts` | CQRS command | ~15 |
| 43 | `apps/messaging-service/src/message/commands/edit-message.handler.ts` | CQRS handler | ~50 |
| 44 | `apps/messaging-service/src/message/commands/delete-message.command.ts` | CQRS command | ~15 |
| 45 | `apps/messaging-service/src/message/commands/delete-message.handler.ts` | CQRS handler | ~50 |
| 46 | `apps/messaging-service/src/message/commands/mark-read.command.ts` | CQRS command | ~15 |
| 47 | `apps/messaging-service/src/message/commands/mark-read.handler.ts` | CQRS handler | ~70 |
| 48 | `apps/messaging-service/src/message/queries/get-messages.query.ts` | CQRS query | ~15 |
| 49 | `apps/messaging-service/src/message/queries/get-messages.handler.ts` | CQRS handler (cursor pagination) | ~80 |
| 50 | `apps/messaging-service/src/message/queries/get-messages-since.query.ts` | CQRS query | ~15 |
| 51 | `apps/messaging-service/src/message/queries/get-messages-since.handler.ts` | CQRS handler (offline sync) | ~60 |
| 52 | `apps/messaging-service/src/message/queries/search-messages.query.ts` | CQRS query | ~15 |
| 53 | `apps/messaging-service/src/message/queries/search-messages.handler.ts` | Full-text search handler | ~70 |
| 54 | `apps/messaging-service/src/message/resolvers/message.resolver.ts` | GraphQL resolver | ~180 |
| 55 | `apps/messaging-service/src/message/services/message.service.ts` | Domain logic | ~200 |
| 56 | `apps/messaging-service/src/message/services/media.service.ts` | MinIO presigned URL generation | ~120 |
| 57 | `apps/messaging-service/src/message/services/thumbnail.service.ts` | Sharp.js thumbnail generation | ~80 |
| 58 | `apps/messaging-service/src/message/message.module.ts` | NestJS module | ~30 |
| 59 | `apps/messaging-service/src/presence/presence.service.ts` | Redis presence tracking | ~100 |
| 60 | `apps/messaging-service/src/presence/presence.module.ts` | Presence module | ~15 |
| 61 | `apps/messaging-service/src/partition/partition-manager.service.ts` | Monthly partition cron | ~80 |
| 62 | `apps/messaging-service/src/partition/partition.module.ts` | Partition module | ~15 |
| 63 | `apps/messaging-service/src/event-handlers/messaging-nats.handler.ts` | NATS subscriber | ~60 |
| 64 | `apps/messaging-service/src/shared/guards/channel-member.guard.ts` | Channel membership guard | ~40 |
| 65 | `apps/messaging-service/src/shared/guards/message-owner.guard.ts` | Message ownership guard | ~30 |
| 66 | `apps/messaging-service/src/shared/decorators/current-channel.decorator.ts` | Parameter decorator | ~15 |
| 67 | `apps/messaging-service/src/shared/interceptors/messaging-rate-limit.interceptor.ts` | Rate limiter | ~60 |

**Backend subtotal: ~67 files, ~2,800 lines**

**Backend -- gateway-api (modifications + new files):**

| # | File Path | Purpose | Est. Lines |
|---|-----------|---------|-----------|
| 68 | `apps/gateway-api/src/websocket/messaging.gateway.ts` | **NEW** -- Socket.IO /messaging namespace | ~250 |
| 69 | `apps/gateway-api/src/websocket/messaging-nats-bridge.service.ts` | **NEW** -- NATS to Socket.IO bridge for messaging events | ~120 |

**Frontend -- AquaMobil (new + modified files):**

| # | File Path | Purpose | Est. Lines |
|---|-----------|---------|-----------|
| 70 | `web/apps/aquamobil/src/pages/messaging/ChannelListPage.tsx` | **NEW** -- Channel list page | ~320 |
| 71 | `web/apps/aquamobil/src/pages/messaging/ChatRoomPage.tsx` | **NEW** -- Chat room page | ~450 |
| 72 | `web/apps/aquamobil/src/pages/messaging/NewChatPage.tsx` | **NEW** -- New chat/group creation | ~220 |
| 73 | `web/apps/aquamobil/src/pages/messaging/ChannelSettingsPage.tsx` | **NEW** -- Channel settings | ~280 |
| 74 | `web/apps/aquamobil/src/pages/messaging/MediaViewerPage.tsx` | **NEW** -- Full-screen media viewer | ~180 |
| 75 | `web/apps/aquamobil/src/hooks/useChannels.ts` | **NEW** -- Channel list hook | ~120 |
| 76 | `web/apps/aquamobil/src/hooks/useMessages.ts` | **NEW** -- Paginated messages hook | ~180 |
| 77 | `web/apps/aquamobil/src/hooks/useMessageSocket.ts` | **NEW** -- Socket.IO messaging hook | ~200 |
| 78 | `web/apps/aquamobil/src/hooks/useSendMessage.ts` | **NEW** -- Send message mutation | ~150 |
| 79 | `web/apps/aquamobil/src/hooks/useChannelMembers.ts` | **NEW** -- Channel members hook | ~80 |
| 80 | `web/apps/aquamobil/src/hooks/useUnreadCount.ts` | **NEW** -- Total unread count hook | ~60 |
| 81 | `web/apps/aquamobil/src/hooks/useMediaUpload.ts` | **NEW** -- Media upload hook | ~140 |
| 82 | `web/apps/aquamobil/src/hooks/useTypingIndicator.ts` | **NEW** -- Typing indicator hook | ~70 |
| 83 | `web/apps/aquamobil/src/components/messaging/ChannelListItem.tsx` | **NEW** | ~90 |
| 84 | `web/apps/aquamobil/src/components/messaging/MessageBubble.tsx` | **NEW** | ~160 |
| 85 | `web/apps/aquamobil/src/components/messaging/MessageInput.tsx` | **NEW** | ~200 |
| 86 | `web/apps/aquamobil/src/components/messaging/AttachmentPicker.tsx` | **NEW** | ~120 |
| 87 | `web/apps/aquamobil/src/components/messaging/ImagePreview.tsx` | **NEW** | ~100 |
| 88 | `web/apps/aquamobil/src/components/messaging/TypingIndicator.tsx` | **NEW** | ~40 |
| 89 | `web/apps/aquamobil/src/components/messaging/ReadReceipt.tsx` | **NEW** | ~30 |
| 90 | `web/apps/aquamobil/src/components/messaging/ChannelAvatar.tsx` | **NEW** | ~60 |
| 91 | `web/apps/aquamobil/src/components/messaging/MessageDateSeparator.tsx` | **NEW** | ~30 |
| 92 | `web/apps/aquamobil/src/components/messaging/SystemMessage.tsx` | **NEW** | ~20 |
| 93 | `web/apps/aquamobil/src/components/messaging/EmptyChat.tsx` | **NEW** | ~40 |
| 94 | `web/apps/aquamobil/src/components/messaging/UnreadBadge.tsx` | **NEW** | ~25 |
| 95 | `web/apps/aquamobil/src/graphql/messaging-operations.ts` | **NEW** -- GraphQL queries/mutations for messaging | ~200 |

**Frontend subtotal: ~26 new files, ~3,565 lines**

### 7.2 Existing Files to Modify

| # | File Path | Change | Est. Delta |
|---|-----------|--------|-----------|
| 1 | `web/apps/aquamobil/src/App.tsx` | Add 5 lazy imports + 5 routes for messaging pages | +25 lines |
| 2 | `web/apps/aquamobil/src/layouts/MobileLayout.tsx` | Add Messages tab (5th tab) with `MessageSquare` icon + unread badge; add `/messages` to active detection | +20 lines |
| 3 | `web/apps/aquamobil/src/types/index.ts` | Add messaging types (Channel, Message, etc.) + new OperationType values | +130 lines |
| 4 | `web/apps/aquamobil/src/hooks/useOfflineQueue.tsx` | Add MUTATIONS for `sendMessage`, `editMessage`, `deleteMessage`, `markMessagesRead` | +30 lines |
| 5 | `web/apps/aquamobil/src/pwa/offline-queue.ts` | Add message-specific cache store (`aquamobil-messages`) | +40 lines |
| 6 | `apps/gateway-api/src/app.module.ts` | Add messaging-service subgraph URL to federation config | +5 lines |
| 7 | `apps/gateway-api/src/websocket/websocket.module.ts` | Import and register MessagingGateway + MessagingNatsBridgeService | +10 lines |
| 8 | `apps/notification-service/src/notification/event-handlers/messaging-event.handler.ts` | Extend to handle peer messaging push notifications (not just admin messaging) | +60 lines |
| 9 | `docker-compose.yml` | Add messaging-service container definition | +25 lines |
| 10 | `docker-compose.dev.yml` | Add messaging-service dev definition | +15 lines |
| 11 | `docker-compose.infra.yml` | No change (all infra already present) | 0 |
| 12 | `.github/workflows/ci.yml` (or equivalent) | Add messaging-service build + test job | +20 lines |
| 13 | `infrastructure/docker/init-scripts/00-init-schemas.sh` | Add messaging-service DB user + per-tenant messaging tables in schema template | +15 lines |

**Total modifications: ~13 files, ~395 lines delta**

### 7.3 Grand Total

| Category | New Files | Modified Files | New Lines | Modified Lines |
|----------|-----------|----------------|-----------|---------------|
| Backend (messaging-service) | 67 | 0 | ~2,800 | 0 |
| Backend (gateway-api) | 2 | 2 | ~370 | +15 |
| Backend (notification-service) | 0 | 1 | 0 | +60 |
| Frontend (pages) | 5 | 0 | ~1,450 | 0 |
| Frontend (hooks) | 8 | 2 | ~1,000 | +70 |
| Frontend (components) | 12 | 0 | ~915 | 0 |
| Frontend (types/graphql) | 1 | 1 | ~200 | +130 |
| Frontend (other) | 0 | 2 | 0 | +65 |
| Infrastructure | 0 | 4 | 0 | +55 |
| **Total** | **95** | **12** | **~6,735** | **~395** |

---

## 8. Implementation Phases

### Phase 1: MVP (Weeks 1-6)

**Week 1-2: Backend Foundation**
- [ ] Scaffold messaging-service (NX project, Dockerfile, health module)
- [ ] Implement database entities (channels, messages, attachments, receipts)
- [ ] Implement partition manager for monthly message partitions
- [ ] Add messaging-service to Apollo Federation gateway config
- [ ] Create NATS event contracts for messaging events

**Week 3-4: Core Messaging API**
- [ ] Channel CQRS: create/update/archive channels, add/remove members
- [ ] Message CQRS: send/edit/delete messages with idempotency
- [ ] Read receipts: mark-read mutation + unread count query
- [ ] Media service: presigned upload/download URLs via MinIO
- [ ] Thumbnail generation service
- [ ] GraphQL resolvers with federation references

**Week 4-5: Real-time + Notifications**
- [ ] MessagingGateway in gateway-api (Socket.IO /messaging namespace)
- [ ] NATS-to-Socket.IO bridge for message delivery
- [ ] Presence service (Redis-backed online/offline tracking)
- [ ] Extend notification-service for messaging push notifications
- [ ] Typing indicators (NATS core ephemeral events)

**Week 5-6: Frontend MVP**
- [ ] Add Messages tab to MobileLayout (5th tab with unread badge)
- [ ] ChannelListPage: channel list with last message preview + unread count
- [ ] ChatRoomPage: message list with infinite scroll, send bar, image picker
- [ ] NewChatPage: user picker for DMs and groups
- [ ] Offline message queue integration (send when reconnected)
- [ ] Socket.IO hook for real-time message delivery
- [ ] Message cache in IndexedDB for offline reading

### Phase 2: Enhanced Features (Weeks 7-10)

**Week 7-8: AI Integration + Rich Messaging**
- [ ] AI channel type with MCP bridge to ai-service
- [ ] Message reactions (emoji)
- [ ] Reply threads (parent_id)
- [ ] @mentions with notification routing
- [ ] Message forwarding between channels

**Week 9-10: Advanced UX**
- [ ] Voice notes (MediaRecorder API + audio/webm upload)
- [ ] Full-text message search (GIN index)
- [ ] Pin messages
- [ ] Channel settings page (name, avatar, members, notification preference)
- [ ] Typing indicators UI
- [ ] Online/offline presence indicators

### Phase 3: Enterprise Compliance (Weeks 11-14)

**Week 11-12: Compliance**
- [ ] Message retention policies per tenant (configurable)
- [ ] Admin message monitoring dashboard (read-only view for TENANT_ADMIN)
- [ ] Compliance audit log (all message operations)
- [ ] Legal hold support (prevent deletion when hold is active)

**Week 13-14: Intelligence + Export**
- [ ] AI sentiment analysis on operational channels
- [ ] Knowledge extraction from message history
- [ ] Data export (CSV/JSON) for compliance officers
- [ ] Message encryption at rest (PostgreSQL pgcrypto or column-level)
- [ ] Storage quota enforcement per tenant

---

## 9. Database Sizing and Performance

### Query Performance Benchmarks

| Query | Expected Rows Scanned | Index Used | Target Latency |
|-------|----------------------|-----------|----------------|
| `myChannels (50 channels)` | 50 channel_members + 50 channels (JOIN) | `idx_channel_members_active` | < 15ms |
| `messages (50 per page)` | 50 messages (keyset pagination) | `idx_messages_channel_created` | < 10ms |
| `messagesSince (sync 100 msgs)` | 100 messages (partition-pruned) | `idx_messages_channel_created` + partition pruning | < 20ms |
| `allMessagesSince (500 msgs)` | Up to 500 messages across channels | `idx_messages_channel_created` + membership filter | < 50ms |
| `totalUnreadMessageCount` | 0 (Redis cache hit) | Redis GET | < 2ms |
| `searchMessages` | GIN index scan + channel membership filter | `idx_messages_content_search` | < 100ms |
| `sendMessage` | 1 Redis GET (idempotency) + 1 INSERT + 1 outbox INSERT | Redis `msg:{tid}:idem:{key}` + `idx_messages_channel_created` | < 15ms |

### Connection Pool Sizing

| Resource | Pool Size | Rationale |
|----------|-----------|-----------|
| PostgreSQL connections | min: 5, max: 30 | 200-1000 concurrent users; most queries < 15ms |
| Redis connections | 10 | Presence + unread counts + rate limiting |
| NATS connections | 1 (multiplexed) | NATS multiplexes all operations over one TCP connection |

### Redis Memory Estimates

| Key Pattern | Count (200 users, 50 tenants) | Size per Key | Total |
|-------------|-------------------------------|-------------|-------|
| `msg:{tid}:presence:{uid}` | 200 | 20 bytes | ~4 KB |
| `msg:{tid}:unread:{uid}` | 200 | 8 bytes | ~2 KB |
| `msg:{tid}:typing:{cid}` | 50 (peak) | 50 bytes | ~3 KB |
| Rate limit windows | 1000 | 50 bytes | ~50 KB |
| **Total Redis memory for messaging** | | | **< 100 KB** |

### NATS JetStream Impact

| Metric | Estimate | Within Limits |
|--------|----------|---------------|
| Messages/day | 20,000 | Yes (stream max_bytes: 10GB) |
| Avg message size (NATS) | 200 bytes (metadata only) | Yes (max_msg_size: 1MB) |
| Daily NATS data | ~4 MB | Yes |
| 7-day retention | ~28 MB | Yes (max_file_store: 1GB, shared) |

---

## 10. Migration Plan

### Database Migration

```typescript
// apps/messaging-service/src/migrations/1711800000000-CreateMessagingTables.ts
//
// This migration is applied PER TENANT SCHEMA.
// The TenantMigrationRunner iterates over all tenant_<uuid> schemas
// and runs this migration in each.
//
// For new tenants, the schema template in 00-init-schemas.sh includes
// the messaging tables.

export class CreateMessagingTables1711800000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Get current schema
    const schema = queryRunner.getCurrentSchema();

    // Create channels table
    await queryRunner.query(`
      CREATE TABLE "${schema}".channels ( ... );
      -- indexes
    `);

    // Create channel_members table
    await queryRunner.query(`
      CREATE TABLE "${schema}".channel_members ( ... );
      -- indexes
    `);

    // Create partitioned messages table
    await queryRunner.query(`
      CREATE TABLE "${schema}".messages ( ... ) PARTITION BY RANGE (created_at);
      -- Create initial partitions for current + next 3 months
      -- indexes
    `);

    // Create message_attachments, message_receipts, message_reactions, pinned_messages
    // ...
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const schema = queryRunner.getCurrentSchema();
    await queryRunner.query(`DROP TABLE IF EXISTS "${schema}".pinned_messages CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "${schema}".message_reactions CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "${schema}".message_receipts CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "${schema}".message_attachments CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "${schema}".messages CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "${schema}".channel_members CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "${schema}".channels CASCADE`);
  }
}
```

### Docker Compose Addition (Production)

The production docker-compose entry uses the shared `Dockerfile.backend.simple` (same as all other backend services), internal port 3000, and explicit resource limits to stay within the droplet memory budget (see section 13.1).

```yaml
# Added to docker-compose.yml
aqua-messaging:
  image: ghcr.io/okan-wqm/aquaculture_platform/messaging-service:latest
  container_name: aqua-messaging
  restart: unless-stopped
  networks: [aqua-internal]
  depends_on: [aqua-postgres, aqua-redis, aqua-nats]
  environment:
    PORT: "3000"
    DATABASE_HOST: aqua-postgres
    DATABASE_SYNC: "false"
    REDIS_HOST: aqua-redis
    REDIS_DB: "3"
    NATS_URL: nats://aqua-nats:4222
    MINIO_ENDPOINT: aqua-minio
    NODE_OPTIONS: "--max-old-space-size=256"
  deploy:
    resources:
      limits: { memory: 384M, cpus: '0.5' }
  healthcheck:
    test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3000/health/live"]
    interval: 30s
    timeout: 5s
    retries: 3
```

**Why this differs from the dev docker-compose:**
- Uses the GHCR image (not local build) to match the CI/CD pipeline.
- Internal port 3000 (not the old 4009) because all backend services use port 3000 internally; the gateway routes to them by service name.
- `NODE_OPTIONS: "--max-old-space-size=256"` caps V8 heap to 256MB, well within the 384MB container limit.
- `wget` for healthcheck instead of `curl` because the production base image (`node:18-alpine`) has `wget` but not `curl`.
- Container name follows the `aqua-*` convention matching all other services.

### Gateway Configuration Update

```typescript
// In apps/gateway-api/src/app.module.ts, add to subgraphs array:
{
  name: 'messaging',
  url: configService.get('MESSAGING_SERVICE_URL', 'http://messaging-service:3000/graphql'),
},
```

Add to the gateway-api environment variables (docker-compose and deploy workflow):

```
MESSAGING_SERVICE_URL=http://messaging-service:3000/graphql
```

### 10.3 CI/CD Pipeline Changes (C2)

The messaging-service MUST be added to the CI/CD pipeline in `.github/workflows/deploy-digitalocean.yml` to be built, pushed, and deployed alongside all other backend services. Without this, the service will never reach production.

**Required changes:**

**1. Add to `ALL_BACKEND` array (line 90 of `deploy-digitalocean.yml`):**

```bash
# BEFORE:
ALL_BACKEND=(gateway-api auth-service farm-service sensor-service admin-api-service alert-engine billing-service hr-service hydroponics-service notification-service observability-service config-service)

# AFTER:
ALL_BACKEND=(gateway-api auth-service farm-service sensor-service admin-api-service alert-engine billing-service hr-service hydroponics-service notification-service observability-service config-service messaging-service)
```

**2. Use shared `Dockerfile.backend.simple`:**

The messaging-service does NOT get a custom Dockerfile. It uses the shared `infrastructure/docker/Dockerfile.backend.simple` which is the standard for all backend services. This Dockerfile:
- Copies the NX build output
- Sets `PORT=3000` as default
- Runs `node main.js`

The deploy workflow already handles this: it builds each service in `ALL_BACKEND` using the shared Dockerfile, tags as `ghcr.io/okan-wqm/aquaculture_platform/messaging-service:latest`, and pushes to GHCR.

**3. Add gateway environment variable to deploy script:**

In the DigitalOcean deploy step where gateway-api environment variables are configured, add:

```bash
MESSAGING_SERVICE_URL=http://messaging-service:3000/graphql
```

**Why port 3000:** All backend services use port 3000 internally. The old port 4009 was a design-time placeholder. Using a non-standard port would require custom Dockerfile modifications and break the shared build pipeline. The gateway connects to services by Docker DNS name (`messaging-service:3000`), not by exposed host ports.

### Rollback Plan

1. **Database:** All messaging tables are in isolated schema. `DROP TABLE ... CASCADE` removes all data without affecting other services.
2. **Gateway:** Remove messaging subgraph from federation config. 30-second schema reload propagates.
3. **Frontend:** Remove Messages tab from MobileLayout. Feature flag (`FEATURE_MESSAGING=false`) can hide the tab without code deployment.
4. **Docker:** Remove messaging-service container. No other service depends on it.

---

## 11. Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| **WebSocket scalability** -- 1000+ concurrent connections overwhelm gateway | Medium | High | Socket.IO with Redis adapter enables horizontal scaling. Gateway already handles sensor WebSockets at scale. Load testing at 2x projected load before Phase 1 launch. |
| **Message partition exhaustion** -- partition manager fails, inserts blocked | Low | Critical | Partition manager creates partitions 3 months ahead. Alert if partition creation fails. Manual partition creation documented in runbook. |
| **Offline sync data loss** -- IndexedDB full or corrupted | Low | Medium | 50MB cache limit with LRU eviction. Encrypted cache entries gracefully degrade (return null, trigger re-fetch). Server is source of truth; client cache is disposable. |
| **Cross-tenant data leak** -- bug in tenant isolation | Very Low | Critical | Triple isolation: schema separation (DB), middleware validation (API), room prefixing (WS). Automated integration tests verify isolation. Security review before each phase launch. |
| **Push notification spam** -- high-volume channels trigger excessive pushes | Medium | Medium | Notification deduplication: batch updates per channel (max 1 push per 30 seconds per channel per user). Respect quiet hours. Mute controls per channel. |
| **MinIO storage quota** -- tenants upload excessive media | Medium | Low | Per-tenant quota enforcement in `requestMediaUpload` mutation. Default 10GB, configurable. Alert at 80% capacity. |
| **NATS JetStream backpressure** -- messaging events flood the shared stream | Low | Medium | Messaging events are lightweight (metadata only, no content). Separate consumer group prevents starvation of other services. Backpressure via semaphore in event handlers (existing pattern). |
| **Mobile performance** -- large channel lists or message histories cause jank | Medium | Medium | Virtualized list rendering (react-window or react-virtuoso). Pagination limits (50 channels, 50 messages per page). Image lazy loading with thumbnails. |
| **Phase 2 AI latency** -- AI responses take too long | Medium | Low | AI responses are async (published as regular messages). Loading indicator in chat. 30-second timeout with "AI is taking longer than expected" fallback. |
| **Database growth** -- messages accumulate beyond projections | Low | Medium | Monthly partitioning enables cheap DROP PARTITION for old data. Retention policies (Phase 3) automate cleanup. Read replicas if query load grows. |

---

## 12. AI Integration Architecture

This section replaces the brief Phase 2 notes in section 4.8 with a complete, production-grade AI integration design. AI features are opt-in at both tenant and user levels and run entirely on local models to preserve data privacy.

### 12.1 Embedding Pipeline (C4)

**Vector extension:**

```sql
-- Added to init-scripts/00-init-schemas.sh, executed once per database
CREATE EXTENSION IF NOT EXISTS vector;
```

**Schema changes:**

```sql
-- Add nullable embedding column to messages table.
-- Populated asynchronously by ai-service; NULL until processed.
-- 384 dimensions matches the all-MiniLM-L6-v2 model output.
ALTER TABLE messages ADD COLUMN embedding VECTOR(384);

-- HNSW index for fast cosine similarity search.
-- HNSW chosen over IVFFlat because:
-- 1. No training step required (IVFFlat needs a representative sample to build clusters)
-- 2. Better recall at low latency for our scale (< 1M vectors per tenant)
-- 3. Acceptable insert overhead (~2x slower than IVFFlat) given our 20K msg/day rate
CREATE INDEX idx_messages_embedding ON messages
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 200);

-- Embedding metadata table: tracks model versions for re-embedding on model upgrades
CREATE TABLE embeddings_metadata (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model_name VARCHAR(128) NOT NULL,     -- 'all-MiniLM-L6-v2'
    model_version VARCHAR(64) NOT NULL,   -- 'v1.0'
    dimension INTEGER NOT NULL,           -- 384
    distance_metric VARCHAR(20) NOT NULL, -- 'cosine'
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_active_model UNIQUE (model_name, is_active) -- only one active version per model
);
```

**Model selection: `all-MiniLM-L6-v2`**

| Property | Value | Rationale |
|----------|-------|-----------|
| Dimensions | 384 | Compact enough for PostgreSQL storage (~1.5KB per vector), expressive enough for semantic search |
| Model size | 22M parameters | Fits in 90MB RAM; runs on CPU without GPU |
| Inference speed | ~5ms per sentence (CPU) | Fast enough for batch processing 20K messages/day |
| License | Apache 2.0 | No commercial restrictions |
| Privacy | Runs locally | No data leaves the server; no external API calls |

**Pipeline architecture:**

1. `events.MessageSent` NATS event includes `{ tenantId, channelId, messageId }`.
2. ai-service subscribes to this event via a durable consumer (`messaging-embedding-consumer`).
3. Every 5 minutes, the consumer batches accumulated message IDs, fetches content from messaging-service via NATS request-reply (`request.messaging.getMessageBatch`), and generates embeddings.
4. Embeddings are written back to the `messages` table via a direct PostgreSQL connection (ai-service has read-write access to the `embedding` column only, enforced by a database role with column-level GRANT).
5. If the model is upgraded (new version in `embeddings_metadata`), a backfill job re-embeds all messages with `embedding IS NOT NULL` using the new model. Old embeddings are overwritten.

**Why batch every 5 minutes instead of real-time:** Batching amortizes model loading overhead (the first inference is slower due to model initialization). At 20K messages/day, the average batch size is ~70 messages, processed in < 1 second. Real-time embedding would add 5ms latency to every message send with no user-visible benefit.

### 12.2 Sentiment Analysis Architecture (C6)

**Model: `distilbert-base-uncased-finetuned-sst-2-english`**

| Property | Value | Rationale |
|----------|-------|-----------|
| Parameters | 67M | Small enough for CPU inference |
| Inference speed | < 200ms per message | Acceptable for async background processing |
| Output | `{ label: 'POSITIVE' | 'NEGATIVE', score: 0.0-1.0 }` | Binary sentiment sufficient for operational alerting |
| License | Apache 2.0 | No commercial restrictions |

**Schema:**

```sql
CREATE TYPE analysis_type AS ENUM ('sentiment', 'entity', 'topic');

CREATE TABLE message_analysis (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID NOT NULL,
    message_created_at TIMESTAMPTZ NOT NULL,
    analysis_type analysis_type NOT NULL,
    result JSONB NOT NULL,
    -- Example sentiment result: { "label": "NEGATIVE", "score": 0.15, "confidence": 0.92 }
    -- Example entity result: { "entities": [{ "text": "Tank A3", "type": "tank", "entityId": "uuid" }] }
    -- Example topic result: { "topics": ["water_quality", "feeding"], "confidence": [0.8, 0.6] }
    model_version VARCHAR(64) NOT NULL,
    analyzed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_analysis_message
        FOREIGN KEY (message_id, message_created_at)
        REFERENCES messages (id, created_at) ON DELETE CASCADE
);

CREATE INDEX idx_analysis_message ON message_analysis (message_id);
CREATE INDEX idx_analysis_type ON message_analysis (analysis_type, analyzed_at DESC);
CREATE INDEX idx_analysis_sentiment ON message_analysis ((result->>'score'))
    WHERE analysis_type = 'sentiment';
```

**Pipeline:**

1. ai-service subscribes to `events.MessageSent` via durable consumer `messaging-sentiment-consumer`.
2. For each message, check privacy gates (see 12.5): `tenant.aiAnalysisEnabled` AND `user.aiAnalysisConsent`. Skip if either is false.
3. Run sentiment model on message content. Store result in `message_analysis`.
4. **Alert trigger:** If 3 or more consecutive messages from the same `sender_id` in the same channel have `score < 0.3` (strongly negative), publish `events.SentimentAlert` to NATS with `{ tenantId, channelId, userId, avgScore, messageCount }`.
5. notification-service delivers the alert to users with `TENANT_ADMIN` role as an in-app notification: "Negative sentiment trend detected from [user] in [channel]".

**Visibility rules:** Sentiment data is NEVER shown per-message to any user. It is surfaced only as weekly aggregate trends in the TENANT_ADMIN analytics dashboard:
- Average sentiment per channel per week (bar chart)
- Channels with declining sentiment trends (alert list)
- No individual message-level sentiment is exposed in the UI

### 12.3 Knowledge Extraction

```sql
-- Junction table linking messages to domain entities (tanks, batches, sites, etc.)
CREATE TABLE message_entity_references (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID NOT NULL,
    message_created_at TIMESTAMPTZ NOT NULL,
    entity_type VARCHAR(30) NOT NULL
        CHECK (entity_type IN ('tank', 'batch', 'site', 'species', 'parameter')),
    entity_id UUID NOT NULL,
    confidence NUMERIC(3, 2) NOT NULL DEFAULT 1.0,
    extracted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_entity_ref_message
        FOREIGN KEY (message_id, message_created_at)
        REFERENCES messages (id, created_at) ON DELETE CASCADE,

    CONSTRAINT uq_message_entity UNIQUE (message_id, entity_type, entity_id)
);

CREATE INDEX idx_entity_refs_entity ON message_entity_references (entity_type, entity_id);
CREATE INDEX idx_entity_refs_message ON message_entity_references (message_id);

-- Extracted operational knowledge from message history
CREATE TABLE knowledge_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_message_id UUID,
    source_message_created_at TIMESTAMPTZ,
    category VARCHAR(50) NOT NULL,   -- 'feeding_schedule', 'water_quality_note', 'incident_report'
    content TEXT NOT NULL,
    entities JSONB,                  -- [{ type: 'tank', id: 'uuid', name: 'A3' }]
    confidence NUMERIC(3, 2) NOT NULL DEFAULT 1.0,
    verified_by UUID,                -- user who confirmed the extraction
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_knowledge_message
        FOREIGN KEY (source_message_id, source_message_created_at)
        REFERENCES messages (id, created_at) ON DELETE SET NULL
);

CREATE INDEX idx_knowledge_category ON knowledge_entries (category, created_at DESC);
```

**NER pipeline:**

1. **Regex-first pass:** Match known tank codes (e.g., `A3`, `B12`, `Tank-7`) against the tenant's tank registry (fetched from farm-service via NATS). High confidence (1.0) for exact matches.
2. **Lightweight NER model:** For dates, quantities, and species names, use a spaCy-based NER model running in the ai-service Python sidecar. Extracts `DATE`, `QUANTITY`, `SPECIES` entities.
3. **Batch processing:** Runs hourly via NATS consumer (`messaging-knowledge-consumer`). Processes messages created in the last hour.
4. **Knowledge entry creation:** When a message contains both an entity reference AND actionable content (e.g., "Fed Tank A3 at 3kg/m2 today"), the pipeline creates a `knowledge_entries` row for operator review.

### 12.4 AI Chat Bridge

**Port correction:** The ai-service runs on port 3008, NOT 4010. The old ADR referenced an incorrect port.

**Communication protocol:**

```
User sends message in AI channel (type = 'ai')
  -> messaging-service persists message
  -> messaging-service sends NATS request: commands.ai.chat
     Payload: { tenantId, channelId, messageId, content, userId }
     Timeout: 60 seconds
  -> ai-service processes:
     1. Load context: last 50 messages from current AI channel
     2. Optional: cross-channel embedding search for relevant context
        (SELECT * FROM messages ORDER BY embedding <=> $queryVector LIMIT 10
         WHERE channel_id IN (user's channels) AND embedding IS NOT NULL)
     3. Build prompt with tenant context + tool descriptions
     4. Generate AI response via Claude API (streaming)
  -> ai-service streams partial responses via Socket.IO:
     Emits 'aiTyping' event to channel room with { token, isComplete }
     Client renders tokens as they arrive (typewriter effect)
  -> ai-service sends final NATS reply with complete response
  -> messaging-service persists AI response as message from AI virtual user
  -> Socket.IO delivers final message to channel room
```

**Tool whitelist:**

AI channels have access to a curated set of MCP tools. All 13 read-only tools are allowed by default:

| Tool | Access | Rationale |
|------|--------|-----------|
| `get_tanks`, `get_tank_details` | Read | Tank status lookup |
| `get_water_quality`, `get_latest_readings` | Read | WQ data queries |
| `get_batches`, `get_batch_details` | Read | Batch information |
| `get_tasks`, `get_task_details` | Read | Task tracking |
| `get_alerts`, `get_alert_history` | Read | Alert status |
| `get_feeding_records` | Read | Feeding history |
| `get_site_overview` | Read | Site summary |
| `create_task` | **Write (proposed)** | AI proposes, user confirms |
| `add_observation` | **Write (proposed)** | AI proposes, user confirms |

**"Proposed action" pattern for write tools:**

When the AI determines a write action is appropriate (e.g., "Create a task to check Tank A3"), it does NOT execute the tool directly. Instead:

1. AI generates an **action card** message with type `system` and metadata `{ actionType: 'create_task', params: { ... }, status: 'proposed' }`.
2. The client renders this as a card with a "Confirm" and "Cancel" button.
3. User clicks "Confirm" -> client calls `confirmAiAction` mutation -> messaging-service executes the tool via NATS request to the target service.
4. Result is posted as a follow-up system message: "Task created: Check water quality in Tank A3".

**Why proposed actions:** Autonomous AI write actions in a production aquaculture environment are dangerous. A misinterpreted message could trigger incorrect feeding schedules or generate false alerts. The human-in-the-loop confirmation step is a hard requirement.

### 12.5 AI Privacy Framework (C5)

**Consent model:**

| Setting | Level | Default | Description |
|---------|-------|---------|-------------|
| `aiAnalysisEnabled` | Tenant | `false` | Master switch for all AI analysis in the tenant. Set by TENANT_ADMIN in tenant settings. |
| `aiAnalysisConsent` | User | `false` | Per-user opt-in for AI analysis of their messages. Set by user in account preferences. |

**Both must be `true` for any AI analysis to process a user's messages.** This is a dual-consent model:

1. The tenant admin enables AI analysis for the organization (business decision).
2. Each user individually consents to their messages being analyzed (personal decision).

**UI indicators:**

- `ChannelSettingsPage` shows a visible indicator when AI analysis is active for the channel: "AI analysis is enabled for this channel. Your messages may be analyzed for sentiment and entity extraction."
- The indicator is only shown when `tenant.aiAnalysisEnabled = true`. Users who have not consented (`aiAnalysisConsent = false`) see an additional note: "You have not opted in. Your messages are excluded from AI analysis."

**Data lifecycle:**

- **Cascade deletion:** When a message is purged (via retention policy or `anonymizeMyData`), all associated records are cascade-deleted: embeddings (the `embedding` column is set to NULL), `message_analysis` rows, `message_entity_references` rows, and `knowledge_entries` (source_message_id set to NULL).
- **No cross-tenant model training:** The platform uses pre-trained models (all-MiniLM-L6-v2, DistilBERT) with no fine-tuning on tenant data. Prompt-based AI (Claude API for chat) does not retain conversation history beyond the session.
- **Sentiment visibility:** Weekly aggregate trends visible to TENANT_ADMIN only. Never per-message. Never to the message author's direct manager without TENANT_ADMIN role.
- **Embedding search scope:** Cross-channel embedding search in AI chat is scoped to the requesting user's channels only. A user cannot search embeddings from channels they do not belong to.

---

## 13. Infrastructure

### 13.1 Infrastructure Upgrade Plan (C1)

**Current state:**

The DigitalOcean droplet runs 13 backend services + 10 frontend containers + 4 infrastructure services (PostgreSQL, Redis, NATS, Mosquitto). Current resource utilization:

| Resource | Allocated | Used | Available |
|----------|-----------|------|-----------|
| CPU | 4 vCPU | ~3.2 vCPU (80%) | 0.8 vCPU |
| RAM | 8 GB | ~6.9 GB (86%) | 1.1 GB |
| Disk | 160 GB | ~45 GB (28%) | 115 GB |

Adding messaging-service at 384MB would push RAM to 7.3 GB, leaving only 700MB for OS and spikes. This is dangerously close to OOM-kill territory.

**Required upgrade: 8 vCPU / 16 GB RAM droplet BEFORE messaging-service deployment.**

**Memory budget (post-upgrade):**

| Category | Service | Memory Limit | Notes |
|----------|---------|-------------|-------|
| **Infrastructure** | PostgreSQL | 2,048 MB | shared_buffers=512MB, effective_cache=1.5GB |
| | Redis | 256 MB | maxmemory=256mb |
| | NATS | 128 MB | JetStream file store |
| | Mosquitto | 64 MB | Lightweight MQTT broker |
| | PgBouncer (new) | 64 MB | Connection pooler (see H6) |
| | **Infra subtotal** | **2,560 MB** | |
| **Backend services** | gateway-api | 512 MB | Apollo Federation + Socket.IO |
| | auth-service | 384 MB | JWT validation, user management |
| | farm-service | 384 MB | Farm domain logic |
| | sensor-service | 384 MB | Sensor data ingestion |
| | admin-api-service | 256 MB | Admin operations |
| | alert-engine | 256 MB | Alert evaluation |
| | billing-service | 256 MB | Billing/invoicing |
| | hr-service | 256 MB | HR module |
| | hydroponics-service | 256 MB | Hydroponics module |
| | notification-service | 256 MB | Push + in-app notifications |
| | observability-service | 256 MB | Metrics collection |
| | config-service | 128 MB | Configuration management |
| | ai-service | 512 MB | ML models + Claude API |
| | **messaging-service (new)** | **384 MB** | Messages + media + presence |
| | **Backend subtotal** | **4,480 MB** | |
| **Frontend** | 10 containers @ 128MB | 1,280 MB | Static file servers |
| | **Frontend subtotal** | **1,280 MB** | |
| **OS + system** | Linux kernel + systemd | 2,048 MB | Buffer for spikes, page cache |
| **TOTAL** | | **10,368 MB** | **65% of 16GB -- safe margin** |

**Remaining headroom:** 5,632 MB (35%) available for future services and traffic spikes.

**Upgrade procedure:**

1. Take a droplet snapshot (backup).
2. Power off the droplet.
3. Resize to `s-8vcpu-16gb` ($96/month, up from $48/month for `s-4vcpu-8gb`).
4. Power on. All containers restart automatically (`restart: unless-stopped`).
5. Verify all healthchecks pass.
6. Deploy messaging-service.

### 13.2 PgBouncer (H6)

**Problem:** 14 backend services (13 existing + messaging) each maintain their own TypeORM connection pool. At `max: 30` connections per service, the theoretical maximum is 420 PostgreSQL connections. PostgreSQL's `max_connections` default is 100, and even at 300, each connection costs ~10MB of RAM.

**Solution:** Deploy PgBouncer in transaction pooling mode between all services and PostgreSQL.

```yaml
# docker-compose.yml addition
aqua-pgbouncer:
  image: edoburu/pgbouncer:1.21.0
  container_name: aqua-pgbouncer
  restart: unless-stopped
  networks: [aqua-internal]
  depends_on: [aqua-postgres]
  environment:
    DATABASE_URL: postgres://aquaculture:${DB_PASSWORD}@aqua-postgres:5432/aquaculture
    MAX_CLIENT_CONN: "500"
    DEFAULT_POOL_SIZE: "20"
    MIN_POOL_SIZE: "5"
    POOL_MODE: "transaction"
    SERVER_RESET_QUERY: "DISCARD ALL"
  ports:
    - "6432:6432"
  deploy:
    resources:
      limits: { memory: 64M, cpus: '0.25' }
```

**Configuration:**

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `MAX_CLIENT_CONN` | 500 | Supports all 14 services at max pool size with headroom |
| `DEFAULT_POOL_SIZE` | 20 | Actual PostgreSQL connections shared across all services |
| `MIN_POOL_SIZE` | 5 | Pre-warmed connections for instant query execution |
| `POOL_MODE` | transaction | Connections returned to pool after each transaction (not session) |
| `SERVER_RESET_QUERY` | `DISCARD ALL` | Cleans session state between transactions |

**Migration:** Update all backend service `DATABASE_HOST` environment variables from `aqua-postgres` to `aqua-pgbouncer` and `DATABASE_PORT` from `5432` to `6432`. This is a zero-downtime change: deploy PgBouncer first, then update services one at a time.

**Impact:** Reduces actual PostgreSQL connections from ~200 (current) to ~20 (pooled). Recovers approximately 1.8 GB of PostgreSQL RAM (each idle connection holds ~10MB of memory for session state). This directly supports the memory budget in section 13.1.

**Why:** Without PgBouncer, adding messaging-service (with its own pool of 5-30 connections) risks exhausting PostgreSQL's connection limit. PgBouncer is the standard solution used by every multi-service PostgreSQL deployment.

---

## 14. Transactional Outbox Pattern (H10)

### Problem

The current design publishes NATS events AFTER the database INSERT in the `SendMessageCommand` handler. If NATS is temporarily down or the process crashes between INSERT and NATS publish, the message is persisted but never delivered to Socket.IO clients or notification-service. The message exists in the database but is invisible to recipients until they manually refresh.

### Solution: Outbox Table

```sql
-- Created in each tenant_* schema alongside messaging tables
CREATE TABLE messaging_outbox (
    id BIGSERIAL PRIMARY KEY,
    event_type VARCHAR(100) NOT NULL,       -- 'MessageSent', 'MessageUpdated', etc.
    payload JSONB NOT NULL,                 -- Full event payload
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at TIMESTAMPTZ,               -- NULL until published to NATS
    retry_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,                         -- Error message from last publish attempt

    -- Index for the polling query: unpublished events in creation order
    CONSTRAINT idx_outbox_unpublished
        CHECK (published_at IS NULL)
);

CREATE INDEX idx_outbox_poll ON messaging_outbox (created_at ASC)
    WHERE published_at IS NULL;
```

### Write Path

```typescript
// In SendMessageCommand handler (simplified)
async execute(command: SendMessageCommand): Promise<Message> {
  return this.dataSource.transaction(async (manager) => {
    // 1. Persist message
    const message = await manager.save(Message, { ...command.payload });

    // 2. Write outbox event IN THE SAME TRANSACTION
    await manager.save(MessagingOutbox, {
      eventType: 'MessageSent',
      payload: {
        eventId: uuidv4(),
        tenantId: command.tenantId,
        channelId: message.channelId,
        messageId: message.id,
        senderId: message.senderId,
        contentType: message.contentType,
        hasAttachments: (command.payload.attachmentKeys?.length ?? 0) > 0,
      },
    });

    // 3. Return message. NATS publish happens OUTSIDE this transaction
    //    by the outbox worker (see below).
    return message;
  });
}
```

### Outbox Worker

A background service in messaging-service polls the outbox table every 1 second:

```typescript
@Injectable()
export class OutboxWorkerService {
  private readonly POLL_INTERVAL = 1000; // 1 second
  private readonly BATCH_SIZE = 100;
  private readonly MAX_RETRIES = 5;

  @Cron(CronExpression.EVERY_SECOND)
  async processOutbox(): Promise<void> {
    const events = await this.outboxRepo
      .createQueryBuilder('o')
      .where('o.published_at IS NULL')
      .andWhere('o.retry_count < :maxRetries', { maxRetries: this.MAX_RETRIES })
      .orderBy('o.created_at', 'ASC')
      .limit(this.BATCH_SIZE)
      .getMany();

    for (const event of events) {
      try {
        await this.natsClient.emit(
          `events.${event.eventType}`,
          event.payload,
        );
        event.publishedAt = new Date();
        await this.outboxRepo.save(event);
      } catch (error) {
        event.retryCount += 1;
        event.lastError = error.message;
        await this.outboxRepo.save(event);
        this.logger.warn(
          `Outbox publish failed for event ${event.id}: ${error.message} (retry ${event.retryCount}/${this.MAX_RETRIES})`,
        );
      }
    }
  }
}
```

**Guarantees:**
- Message INSERT and outbox INSERT are in the same transaction. Either both succeed or neither does.
- If NATS is down, events accumulate in the outbox and are published when NATS recovers.
- If the process crashes after INSERT but before outbox worker runs, the next startup processes the backlog.
- After `MAX_RETRIES` (5) failures, the event is dead-lettered (remains in outbox with `retry_count = 5`). An alert fires (see monitoring section).

**Cleanup:** A daily cron job deletes outbox rows where `published_at IS NOT NULL` and `published_at < NOW() - INTERVAL '7 days'`.

---

## 15. Idempotency Deduplication (C7)

### Problem

The original design used a PostgreSQL unique index on `idempotency_key` for deduplication. However, the `messages` table is partitioned by `created_at`. PostgreSQL unique indexes on partitioned tables are per-partition, NOT global. A message sent on January 31st and retried on February 1st would land in different partitions, bypassing the unique constraint entirely.

### Solution: Redis-Based Deduplication

```
Key:    msg:{tenantId}:idem:{idempotencyKey}
Value:  {messageId}:{channelId}
TTL:    7 days (604800 seconds)
```

**Deduplication flow in `SendMessageCommand`:**

```typescript
async execute(command: SendMessageCommand): Promise<Message> {
  const redisKey = `msg:${command.tenantId}:idem:${command.idempotencyKey}`;

  // 1. Check Redis for existing message
  const existing = await this.redis.get(redisKey);
  if (existing) {
    const [messageId, channelId] = existing.split(':');
    // Return the existing message instead of creating a duplicate
    return this.messageRepo.findOneOrFail({
      where: { id: messageId, channelId },
    });
  }

  // 2. No duplicate found — proceed with insert
  const message = await this.dataSource.transaction(async (manager) => {
    const msg = await manager.save(Message, { ...command.payload });
    await manager.save(MessagingOutbox, { /* outbox event */ });
    return msg;
  });

  // 3. Set Redis deduplication key AFTER successful insert
  await this.redis.set(redisKey, `${message.id}:${message.channelId}`, 'EX', 604800);

  return message;
}
```

**Why Redis instead of a database constraint:**

| Approach | Cross-Partition? | Latency | Failure Mode |
|----------|-----------------|---------|-------------|
| PostgreSQL unique index (per-partition) | No -- duplicates across months | ~2ms | Silent duplicate on month boundary |
| PostgreSQL unique index (global, non-partitioned lookup table) | Yes | ~5ms | Extra table, extra JOIN, complex migration |
| Redis SET with TTL | Yes | < 1ms | If Redis is down, falls through to INSERT (at-least-once is acceptable) |

**7-day TTL rationale:** The offline queue retries messages for up to 3 days (72 hours). A 7-day TTL provides 2x safety margin. After 7 days, the idempotency key expires and a retry would create a new message -- but a 7-day-old retry is a bug in the client, not a normal offline sync scenario.

**Redis failure mode:** If Redis is unavailable during the deduplication check, the handler logs a warning and proceeds with the INSERT. This means a duplicate could be created in the rare case of Redis outage + client retry within the same request. This is acceptable because:
1. The client UI already handles duplicate messages (dedup by ID in the local state).
2. A periodic background job can scan for duplicates by `idempotency_key` within each partition and delete extras.

---

## 16. Redis Graceful Degradation (H11)

When Redis is unavailable, the messaging-service must continue operating with degraded functionality rather than failing entirely. Redis is used for 4 features in the messaging-service:

| Feature | Normal (Redis Up) | Degraded (Redis Down) | Impact |
|---------|-------------------|----------------------|--------|
| **Presence tracking** | SET/GET `msg:{tid}:presence:{uid}` | All users show "unknown" status (neither online nor offline) | Presence indicators hidden in UI |
| **Unread counts** | INCR/GET `msg:{tid}:unread:{uid}` | Fall back to SQL `COUNT(*)` query on `channel_members.last_read_at` vs `messages.created_at` | ~50ms instead of ~2ms per query |
| **Rate limiting** | Sliding window counters | Rate limiting bypassed with WARNING log | Brief window of unlimited sends |
| **Idempotency dedup** | GET `msg:{tid}:idem:{key}` | Skip dedup check, proceed with INSERT | Possible duplicate on retry |

**Circuit breaker pattern:**

```typescript
@Injectable()
export class RedisCircuitBreaker {
  private failureCount = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  private lastFailure: Date | null = null;

  private readonly FAILURE_THRESHOLD = 3;
  private readonly RECOVERY_WINDOW = 30_000; // 30 seconds

  async execute<T>(operation: () => Promise<T>, fallback: () => T): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailure!.getTime() > this.RECOVERY_WINDOW) {
        this.state = 'half-open';
      } else {
        return fallback();
      }
    }

    try {
      const result = await operation();
      if (this.state === 'half-open') {
        this.state = 'closed';
        this.failureCount = 0;
      }
      return result;
    } catch (error) {
      this.failureCount++;
      this.lastFailure = new Date();
      if (this.failureCount >= this.FAILURE_THRESHOLD) {
        this.state = 'open';
        this.logger.error(
          `Redis circuit breaker OPEN after ${this.failureCount} failures. Degrading for ${this.RECOVERY_WINDOW}ms.`,
        );
      }
      return fallback();
    }
  }
}
```

**Why:** Redis is a single point of failure for real-time features. Without graceful degradation, a Redis restart (which happens during updates) would cause the entire messaging feature to return 500 errors. With degradation, users experience slower unread counts and missing presence -- but messaging continues to work.

---

## 17. Service Worker Extensions (H15)

### Precache Manifest

The 5 new messaging pages must be added to the service worker precache manifest in `web/apps/aquamobil/public/sw.js` (or the Workbox configuration):

```typescript
// workbox-config.js additions
additionalManifestEntries: [
  { url: '/messages', revision: null },
  { url: '/messages/new', revision: null },
  // Dynamic routes handled by the app shell pattern:
  // /messages/:channelId, /messages/:channelId/settings, /messages/media/:attachmentId
],
```

### Background Sync for Offline Messages

When the user sends a message while offline, the service worker queues the operation for background sync:

```typescript
// In useSendMessage.ts
if (!navigator.onLine) {
  // Queue in IndexedDB (existing offline-queue.ts pattern)
  await queueOperation({
    type: 'sendMessage',
    payload: { channelId, content, idempotencyKey, ... },
    timestamp: Date.now(),
  });

  // Register for background sync
  const registration = await navigator.serviceWorker.ready;
  await registration.sync.register('messaging-outbox');
  return; // Optimistic UI already shows the message
}

// sw.js
self.addEventListener('sync', (event) => {
  if (event.tag === 'messaging-outbox') {
    event.waitUntil(processMessagingOutbox());
  }
});

async function processMessagingOutbox() {
  const queue = await getQueuedOperations('sendMessage');
  for (const op of queue) {
    try {
      await fetch('/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await getToken()}` },
        body: JSON.stringify({
          query: SEND_MESSAGE_MUTATION,
          variables: { input: op.payload },
        }),
      });
      await removeFromQueue(op.id);
    } catch (error) {
      // sync event will be retried by the browser
      break;
    }
  }
}
```

### MobileFeature Integration

The `MobileFeature` enum and tab filtering must include messaging:

```typescript
// In feature-access.ts
export type MobileFeature =
  | 'dashboard'
  | 'farm'
  | 'sensor'
  | 'hr'
  | 'hydroponics'
  | 'tasks'
  | 'messaging';  // NEW

// In MobileLayout.tsx tab filter
const tabs = allTabs.filter(tab => canAccess(tab.feature as MobileFeature));
```

**Why:** Without adding `'messaging'` to the `MobileFeature` type and the access control check, the messaging tab would either be visible to all users regardless of module access or would be filtered out entirely. The `canAccess` function checks the user's module assignments.

---

## 18. Monitoring

### Prometheus Scrape Target

```yaml
# prometheus.yml addition
scrape_configs:
  - job_name: 'messaging-service'
    metrics_path: '/metrics'
    static_configs:
      - targets: ['aqua-messaging:3000']
    scrape_interval: 15s
```

The messaging-service exposes metrics via the `@willsoto/nestjs-prometheus` package (already used by other services):

### Key Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `messaging_messages_total` | Counter | `tenant_id`, `channel_type`, `content_type` | Total messages sent |
| `messaging_messages_per_minute` | Gauge | `tenant_id` | Messages sent in the last 60 seconds |
| `messaging_websocket_connections` | Gauge | `tenant_id` | Active WebSocket connections |
| `messaging_unread_distribution` | Histogram | `tenant_id` | Distribution of unread counts per user |
| `messaging_delivery_latency_seconds` | Histogram | `quantile` | Time from sendMessage mutation to Socket.IO delivery (p50, p95, p99) |
| `messaging_outbox_pending` | Gauge | `tenant_id` | Outbox events awaiting NATS publish |
| `messaging_redis_circuit_state` | Gauge | | 0=closed, 1=open, 2=half-open |
| `messaging_media_upload_bytes_total` | Counter | `tenant_id`, `mime_type` | Total bytes uploaded via presigned URLs |

### Grafana Dashboard

Dashboard ID: `messaging-overview` with the following panels:

1. **Messages/min** (time series) -- `rate(messaging_messages_total[1m]) * 60`
2. **WebSocket connections** (gauge) -- `messaging_websocket_connections`
3. **Unread distribution** (heatmap) -- `messaging_unread_distribution`
4. **Delivery latency** (time series with p50/p95/p99) -- `histogram_quantile(0.50, messaging_delivery_latency_seconds)` etc.
5. **Outbox backlog** (time series) -- `messaging_outbox_pending`
6. **Redis circuit breaker state** (state timeline) -- `messaging_redis_circuit_state`
7. **Media upload rate** (bar chart) -- `rate(messaging_media_upload_bytes_total[5m])`

### Alert Rules

```yaml
# alertmanager rules
groups:
  - name: messaging
    rules:
      - alert: MessagingPartitionNotCreated
        expr: time() - messaging_last_partition_created_at > 86400 * 60
        for: 1h
        labels:
          severity: critical
        annotations:
          summary: "Message partition for next month has not been created"
          description: "The partition manager cron has not created a new partition in over 60 days. INSERT operations will fail when the current month's partition is exhausted."

      - alert: MessagingHealthCheckFailure
        expr: up{job="messaging-service"} == 0
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "messaging-service is unreachable"

      - alert: MessagingDeliveryLatencyHigh
        expr: histogram_quantile(0.95, rate(messaging_delivery_latency_seconds_bucket[5m])) > 0.5
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Message delivery p95 latency exceeds 500ms"
          description: "Current p95: {{ $value }}s. Check NATS throughput and Socket.IO connection count."

      - alert: MessagingWebSocketConnectionsHigh
        expr: messaging_websocket_connections > 800
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "WebSocket connections approaching capacity (>800)"
          description: "Current connections: {{ $value }}. Consider horizontal scaling if this persists."

      - alert: MessagingOutboxBacklog
        expr: messaging_outbox_pending > 100
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Outbox has >100 pending events"
          description: "NATS may be unreachable. Check NATS health and outbox worker logs."

      - alert: MessagingRedisCircuitOpen
        expr: messaging_redis_circuit_state == 1
        for: 1m
        labels:
          severity: warning
        annotations:
          summary: "Redis circuit breaker is OPEN"
          description: "Messaging is running in degraded mode. Presence and unread counts are unavailable."
```

---

## Appendix: Review Finding Resolution Matrix

| # | Finding | Severity | Section | Status |
|---|---------|----------|---------|--------|
| C1 | Droplet memory exhaustion | CRITICAL | 13.1 Infrastructure Upgrade Plan | RESOLVED |
| C2 | CI/CD pipeline missing | CRITICAL | 10.3 CI/CD Pipeline Changes | RESOLVED |
| C3 | Tenant infrastructure providers missing | CRITICAL | 6.1 Module Structure (Tenant providers) | RESOLVED |
| C4 | pgvector + embedding strategy | CRITICAL | 12.1 Embedding Pipeline | RESOLVED |
| C5 | AI consent model | CRITICAL | 12.5 AI Privacy Framework | RESOLVED |
| C6 | Sentiment architecture | CRITICAL | 12.2 Sentiment Analysis Architecture | RESOLVED |
| C7 | Idempotency bug (partition-local unique index) | CRITICAL | 15. Idempotency Deduplication | RESOLVED |
| H1 | WebSocket token refresh | HIGH | 6.4 WebSocket Gateway (token refresh protocol) | RESOLVED |
| H2 | Server-side content sanitization | HIGH | 4.9 Security Model (content sanitization) | RESOLVED |
| H3 | GDPR Phase 1 | HIGH | 4.9 Security Model (GDPR) + 6.2 GraphQL Schema | RESOLVED |
| H4 | Role assignment validation | HIGH | 6.5 CQRS (role hierarchy rules) | RESOLVED |
| H5 | Magic byte verification | HIGH | 4.4 Media Storage (magic byte verification) | RESOLVED |
| H6 | PgBouncer connection pooling | HIGH | 13.2 PgBouncer | RESOLVED |
| H7 | allMessagesSince pagination | HIGH | 6.2 GraphQL Schema (AllMessagesSinceResponse) | RESOLVED |
| H8 | message_receipts partitioning | HIGH | 4.2 Database Schema (receipts partitioned) | RESOLVED |
| H9 | MessageUser resolution via NATS | HIGH | 6.2 GraphQL Schema (MessageUser resolution) | RESOLVED |
| H10 | Outbox pattern for NATS reliability | HIGH | 14. Transactional Outbox Pattern | RESOLVED |
| H11 | Redis graceful degradation | HIGH | 16. Redis Graceful Degradation | RESOLVED |
| H12 | TypeORM sync vs partition conflict | HIGH | 4.2 Database Schema (TypeORM sync table) | RESOLVED |
| H13 | iOS keyboard handling | HIGH | 5.4 Components (MessageInput) | RESOLVED |
| H14 | Swipe-to-reply replaced with long-press | HIGH | 5.4 Components (MessageBubble) | RESOLVED |
| H15 | Service worker extensions | HIGH | 17. Service Worker Extensions | RESOLVED |
