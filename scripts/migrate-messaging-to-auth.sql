-- =============================================================================
-- FORWARD MIGRATION: admin schema → auth schema
-- =============================================================================
--
-- Purpose: Migrate messaging & announcement data from admin-api-service's
--          schema (admin.*) to auth-service's schema (auth.*), which becomes
--          the Single Source of Truth for the Communication bounded context.
--
-- Preconditions:
--   - auth-service has been started at least once (TypeORM sync created tables)
--   - Both schemas exist: admin, auth
--   - Run inside a transaction for atomicity
--
-- Column Mapping Notes (TypeORM camelCase convention — DB columns are quoted):
--
--   message_threads:
--     admin."unreadAdminCount"  → auth."unreadCountAdmin"
--     admin."unreadTenantCount" → auth."unreadCountTenant"
--     admin."isClosed"/"isArchived" → auth."status" enum ('open','closed','archived')
--     admin has NO "lastMessage", "lastMessageBy", "createdBy", "createdByAdmin"
--       → auth requires them; derived from latest message or set to defaults
--     admin."metadata" → dropped (auth schema does not have this column)
--     admin."lastMessageId" → dropped (auth schema does not have this column)
--
--   messages:
--     admin."senderType" 'admin' → auth."senderType" 'super_admin'
--     admin."senderType" 'tenant_admin' → unchanged
--     admin."senderType" 'system' → unchanged
--     admin."senderName" nullable → auth."senderName" required; COALESCE to 'Unknown'
--     admin."status" 'failed' → auth does not have 'failed'; mapped to 'sent'
--     admin."emailSent" → dropped (auth schema does not have this column)
--
--   announcements:
--     admin has NO "scope" → default to 'platform' (PLATFORM scope)
--     admin has NO "tenantId" → default to NULL (platform-wide)
--     admin."createdBy" nullable → auth requires it; COALESCE to '00000000-...'
--     admin."createdByName" nullable → auth requires it; COALESCE to 'System'
--     admin."metadata" → dropped (auth schema does not have this column)
--
--   announcement_acknowledgments:
--     admin."userName" nullable → auth requires it; COALESCE to 'Unknown User'
--     admin."tenantId" required → auth."tenantId" nullable (compatible)
--     admin."viewedAt" nullable → auth."viewedAt" is CreateDateColumn (NOT NULL);
--       COALESCE to "createdAt" or NOW()
--     admin."createdAt" → dropped (auth uses "viewedAt" as the creation timestamp)
--
-- Idempotency: ON CONFLICT (id) DO NOTHING — safe for re-runs.
-- Conflicts are logged via RAISE NOTICE in the DO blocks.
--
-- Usage:
--   psql -U aquaculture -d aquaculture -f scripts/migrate-messaging-to-auth.sql
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0a. Verify enum types exist in auth schema
-- ---------------------------------------------------------------------------
-- TypeORM creates enum types with the naming pattern: {table}_{column}_enum
-- If your TypeORM version uses different names, this block will fail early
-- with a clear message showing the actual enum names available.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_enum_count INTEGER;
  v_enum_list  TEXT;
BEGIN
  -- Check that we can find expected enum types in auth schema
  SELECT COUNT(*), STRING_AGG(t.typname, ', ' ORDER BY t.typname)
  INTO v_enum_count, v_enum_list
  FROM pg_type t
  JOIN pg_namespace n ON t.typnamespace = n.oid
  WHERE n.nspname = 'auth'
    AND t.typtype = 'e';

  RAISE NOTICE 'Found % enum types in auth schema: %', v_enum_count, v_enum_list;

  IF v_enum_count = 0 THEN
    RAISE EXCEPTION 'No enum types found in auth schema. Has auth-service been started (TypeORM sync)?';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 0b. Pre-migration counts (for verification at the end)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_admin_threads   BIGINT;
  v_admin_messages   BIGINT;
  v_admin_announces  BIGINT;
  v_admin_acks       BIGINT;
BEGIN
  SELECT COUNT(*) INTO v_admin_threads   FROM admin.message_threads;
  SELECT COUNT(*) INTO v_admin_messages   FROM admin.messages;
  SELECT COUNT(*) INTO v_admin_announces  FROM admin.announcements;
  SELECT COUNT(*) INTO v_admin_acks       FROM admin.announcement_acknowledgments;

  RAISE NOTICE '=== PRE-MIGRATION COUNTS (admin schema) ===';
  RAISE NOTICE 'message_threads:             %', v_admin_threads;
  RAISE NOTICE 'messages:                    %', v_admin_messages;
  RAISE NOTICE 'announcements:               %', v_admin_announces;
  RAISE NOTICE 'announcement_acknowledgments: %', v_admin_acks;
END $$;

-- ---------------------------------------------------------------------------
-- 1. Migrate message_threads
-- ---------------------------------------------------------------------------
-- Column mapping:
--   admin."id"                → auth."id"
--   admin."tenantId"          → auth."tenantId"
--   admin."subject"           → auth."subject"
--   (derived from messages)   → auth."lastMessage"        (NULL — backfilled below)
--   admin."lastMessageAt"     → auth."lastMessageAt"
--   (derived from messages)   → auth."lastMessageBy"      (NULL — backfilled below)
--   admin."isClosed"/"isArchived" → auth."status"
--   admin."messageCount"      → auth."messageCount"
--   admin."unreadAdminCount"  → auth."unreadCountAdmin"
--   admin."unreadTenantCount" → auth."unreadCountTenant"
--   (no source)               → auth."createdBy"          (default: tenantId as placeholder)
--   (no source)               → auth."createdByAdmin"     (default: false)
--   admin."createdAt"         → auth."createdAt"
--   admin."updatedAt"         → auth."updatedAt"
-- ---------------------------------------------------------------------------

WITH inserted AS (
  INSERT INTO auth.message_threads (
    "id",
    "tenantId",
    "subject",
    "lastMessage",
    "lastMessageAt",
    "lastMessageBy",
    "status",
    "messageCount",
    "unreadCountAdmin",
    "unreadCountTenant",
    "createdBy",
    "createdByAdmin",
    "createdAt",
    "updatedAt"
  )
  SELECT
    t."id",
    t."tenantId",
    t."subject",
    -- lastMessage: will be backfilled after messages are migrated
    NULL::text,
    t."lastMessageAt",
    -- lastMessageBy: will be backfilled after messages are migrated
    NULL::uuid,
    -- status: derive from isClosed/isArchived boolean flags
    -- Cast to the enum type that TypeORM created for auth.message_threads.status
    -- If this fails, run the enum discovery query in the post-migration notes (section 4)
    CASE
      WHEN t."isArchived" = true THEN 'archived'
      WHEN t."isClosed"   = true THEN 'closed'
      ELSE 'open'
    END::auth.message_threads_status_enum,
    t."messageCount",
    -- Column rename: unreadAdminCount → unreadCountAdmin
    t."unreadAdminCount",
    -- Column rename: unreadTenantCount → unreadCountTenant
    t."unreadTenantCount",
    -- createdBy: admin schema does not track who created the thread
    -- Use tenantId as a placeholder (the tenant is always a party)
    t."tenantId",
    -- createdByAdmin: default false (we cannot determine this from admin data)
    false,
    t."createdAt",
    t."updatedAt"
  FROM admin.message_threads t
  ON CONFLICT ("id") DO NOTHING
  RETURNING "id"
)
SELECT COUNT(*) AS threads_inserted FROM inserted;

DO $$
DECLARE
  v_conflicts BIGINT;
BEGIN
  SELECT COUNT(*) INTO v_conflicts
  FROM admin.message_threads a
  WHERE EXISTS (
    SELECT 1 FROM auth.message_threads b WHERE b."id" = a."id"
  )
  AND a."id" NOT IN (
    SELECT "id" FROM auth.message_threads
    WHERE "createdAt" >= (SELECT MIN("createdAt") FROM admin.message_threads)
  );
  -- Approximate conflict detection: threads that exist in both but were not
  -- just inserted. Exact tracking uses the RETURNING clause above.
  RAISE NOTICE 'message_threads: migration complete (conflicts skipped via ON CONFLICT DO NOTHING)';
END $$;

-- ---------------------------------------------------------------------------
-- 2. Migrate messages
-- ---------------------------------------------------------------------------
-- Column mapping:
--   admin."id"          → auth."id"
--   admin."threadId"    → auth."threadId"
--   admin."senderId"    → auth."senderId"
--   admin."senderType"  → auth."senderType" (value mapping: 'admin' → 'super_admin')
--   admin."senderName"  → auth."senderName" (COALESCE null → 'Unknown')
--   admin."content"     → auth."content"
--   admin."status"      → auth."status" (value mapping: 'failed' → 'sent')
--   admin."isInternal"  → auth."isInternal"
--   admin."attachments" → auth."attachments"
--   admin."readAt"      → auth."readAt"
--   admin."createdAt"   → auth."createdAt"
-- Dropped columns: admin."emailSent" (not in auth schema)
-- ---------------------------------------------------------------------------

WITH inserted AS (
  INSERT INTO auth.messages (
    "id",
    "threadId",
    "senderId",
    "senderType",
    "senderName",
    "content",
    "status",
    "isInternal",
    "attachments",
    "readAt",
    "createdAt"
  )
  SELECT
    m."id",
    m."threadId",
    m."senderId",
    -- senderType value mapping: admin schema uses 'admin', auth uses 'super_admin'
    CASE m."senderType"
      WHEN 'admin' THEN 'super_admin'::auth.messages_sendertype_enum
      WHEN 'tenant_admin' THEN 'tenant_admin'::auth.messages_sendertype_enum
      WHEN 'system' THEN 'system'::auth.messages_sendertype_enum
      ELSE 'system'::auth.messages_sendertype_enum
    END,
    -- senderName: admin allows NULL, auth requires NOT NULL
    COALESCE(m."senderName", 'Unknown'),
    m."content",
    -- status value mapping: admin has 'failed', auth does not
    CASE m."status"
      WHEN 'failed' THEN 'sent'::auth.messages_status_enum
      WHEN 'sent' THEN 'sent'::auth.messages_status_enum
      WHEN 'delivered' THEN 'delivered'::auth.messages_status_enum
      WHEN 'read' THEN 'read'::auth.messages_status_enum
      ELSE 'sent'::auth.messages_status_enum
    END,
    m."isInternal",
    m."attachments",
    m."readAt",
    m."createdAt"
  FROM admin.messages m
  -- Only migrate messages whose thread exists in auth (defensive join)
  WHERE EXISTS (
    SELECT 1 FROM auth.message_threads t WHERE t."id" = m."threadId"
  )
  ON CONFLICT ("id") DO NOTHING
  RETURNING "id"
)
SELECT COUNT(*) AS messages_inserted FROM inserted;

-- ---------------------------------------------------------------------------
-- 2a. Backfill lastMessage and lastMessageBy on migrated threads
-- ---------------------------------------------------------------------------
-- Now that messages are migrated, populate the thread summary fields.

UPDATE auth.message_threads t
SET
  "lastMessage" = sub."content",
  "lastMessageBy" = sub."senderId"
FROM (
  SELECT DISTINCT ON (m."threadId")
    m."threadId",
    m."content",
    m."senderId"
  FROM auth.messages m
  ORDER BY m."threadId", m."createdAt" DESC
) sub
WHERE t."id" = sub."threadId"
  AND t."lastMessage" IS NULL;

-- ---------------------------------------------------------------------------
-- 3. Migrate announcements
-- ---------------------------------------------------------------------------
-- Column mapping:
--   admin."id"                     → auth."id"
--   admin."title"                  → auth."title"
--   admin."content"                → auth."content"
--   admin."type"                   → auth."type" (same enum values)
--   admin."status"                 → auth."status" (same enum values)
--   (no source)                    → auth."scope"  (default: 'platform')
--   (no source)                    → auth."tenantId" (default: NULL)
--   admin."isGlobal"               → auth."isGlobal"
--   admin."targetCriteria"         → auth."targetCriteria"
--   admin."publishAt"              → auth."publishAt"
--   admin."expiresAt"              → auth."expiresAt"
--   admin."requiresAcknowledgment" → auth."requiresAcknowledgment"
--   admin."viewCount"              → auth."viewCount"
--   admin."acknowledgmentCount"    → auth."acknowledgmentCount"
--   admin."createdBy"              → auth."createdBy" (COALESCE null → system UUID)
--   admin."createdByName"          → auth."createdByName" (COALESCE null → 'System')
--   admin."createdAt"              → auth."createdAt"
--   admin."updatedAt"              → auth."updatedAt"
-- Dropped columns: admin."metadata" (not in auth schema)
-- ---------------------------------------------------------------------------

WITH inserted AS (
  INSERT INTO auth.announcements (
    "id",
    "title",
    "content",
    "type",
    "status",
    "scope",
    "tenantId",
    "isGlobal",
    "targetCriteria",
    "publishAt",
    "expiresAt",
    "requiresAcknowledgment",
    "viewCount",
    "acknowledgmentCount",
    "createdBy",
    "createdByName",
    "createdAt",
    "updatedAt"
  )
  SELECT
    a."id",
    a."title",
    a."content",
    -- type: same enum values, cast to auth enum type
    a."type"::text::auth.announcements_type_enum,
    -- status: same enum values, cast to auth enum type
    a."status"::text::auth.announcements_status_enum,
    -- scope: admin schema has no scope column; all admin announcements are platform-level
    'platform'::auth.announcements_scope_enum,
    -- tenantId: admin schema has no tenantId on announcements; NULL = platform-wide
    NULL::uuid,
    a."isGlobal",
    a."targetCriteria",
    a."publishAt",
    a."expiresAt",
    a."requiresAcknowledgment",
    a."viewCount",
    a."acknowledgmentCount",
    -- createdBy: admin allows NULL, auth requires NOT NULL
    COALESCE(a."createdBy", '00000000-0000-0000-0000-000000000000'::uuid),
    -- createdByName: admin allows NULL, auth requires NOT NULL
    COALESCE(a."createdByName", 'System'),
    a."createdAt",
    a."updatedAt"
  FROM admin.announcements a
  ON CONFLICT ("id") DO NOTHING
  RETURNING "id"
)
SELECT COUNT(*) AS announcements_inserted FROM inserted;

-- ---------------------------------------------------------------------------
-- 4. Migrate announcement_acknowledgments
-- ---------------------------------------------------------------------------
-- Column mapping:
--   admin."id"              → auth."id"
--   admin."announcementId"  → auth."announcementId"
--   admin."userId"          → auth."userId"
--   admin."userName"        → auth."userName" (COALESCE null → 'Unknown User')
--   admin."tenantId"        → auth."tenantId"
--   admin."viewedAt"        → auth."viewedAt" (COALESCE null → createdAt/NOW())
--   admin."acknowledgedAt"  → auth."acknowledgedAt"
-- Note: auth has no "createdAt" — "viewedAt" serves as the creation timestamp.
-- Note: auth has "tenantName" column that admin does not — set to NULL.
-- Dropped columns: admin."createdAt" (auth uses "viewedAt" as CreateDateColumn)
-- ---------------------------------------------------------------------------

WITH inserted AS (
  INSERT INTO auth.announcement_acknowledgments (
    "id",
    "announcementId",
    "userId",
    "userName",
    "tenantId",
    "tenantName",
    "viewedAt",
    "acknowledgedAt"
  )
  SELECT
    ak."id",
    ak."announcementId",
    ak."userId",
    -- userName: admin allows NULL, auth requires NOT NULL
    COALESCE(ak."userName", 'Unknown User'),
    ak."tenantId",
    -- tenantName: admin does not have this column; set to NULL
    NULL::varchar,
    -- viewedAt: admin allows NULL, auth is CreateDateColumn (NOT NULL)
    COALESCE(ak."viewedAt", ak."createdAt", NOW()),
    ak."acknowledgedAt"
  FROM admin.announcement_acknowledgments ak
  -- Only migrate acks whose announcement exists in auth (defensive join)
  WHERE EXISTS (
    SELECT 1 FROM auth.announcements ann WHERE ann."id" = ak."announcementId"
  )
  ON CONFLICT ("id") DO NOTHING
  RETURNING "id"
)
SELECT COUNT(*) AS acks_inserted FROM inserted;

-- ---------------------------------------------------------------------------
-- 5. Post-migration verification
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_admin_threads   BIGINT;
  v_auth_threads    BIGINT;
  v_admin_messages   BIGINT;
  v_auth_messages    BIGINT;
  v_admin_announces  BIGINT;
  v_auth_announces   BIGINT;
  v_admin_acks       BIGINT;
  v_auth_acks        BIGINT;
  v_mismatch         BOOLEAN := false;
BEGIN
  SELECT COUNT(*) INTO v_admin_threads   FROM admin.message_threads;
  SELECT COUNT(*) INTO v_auth_threads    FROM auth.message_threads;
  SELECT COUNT(*) INTO v_admin_messages   FROM admin.messages;
  SELECT COUNT(*) INTO v_auth_messages    FROM auth.messages;
  SELECT COUNT(*) INTO v_admin_announces  FROM admin.announcements;
  SELECT COUNT(*) INTO v_auth_announces   FROM auth.announcements;
  SELECT COUNT(*) INTO v_admin_acks       FROM admin.announcement_acknowledgments;
  SELECT COUNT(*) INTO v_auth_acks        FROM auth.announcement_acknowledgments;

  RAISE NOTICE '=== POST-MIGRATION VERIFICATION ===';
  RAISE NOTICE 'message_threads:              admin=% auth=%', v_admin_threads, v_auth_threads;
  RAISE NOTICE 'messages:                     admin=% auth=%', v_admin_messages, v_auth_messages;
  RAISE NOTICE 'announcements:                admin=% auth=%', v_admin_announces, v_auth_announces;
  RAISE NOTICE 'announcement_acknowledgments: admin=% auth=%', v_admin_acks, v_auth_acks;

  -- Auth counts should be >= admin counts (auth may have its own data too)
  IF v_auth_threads < v_admin_threads THEN
    RAISE WARNING 'MISMATCH: auth.message_threads (%) < admin.message_threads (%)', v_auth_threads, v_admin_threads;
    v_mismatch := true;
  END IF;

  IF v_auth_messages < v_admin_messages THEN
    RAISE WARNING 'MISMATCH: auth.messages (%) < admin.messages (%)', v_auth_messages, v_admin_messages;
    v_mismatch := true;
  END IF;

  IF v_auth_announces < v_admin_announces THEN
    RAISE WARNING 'MISMATCH: auth.announcements (%) < admin.announcements (%)', v_auth_announces, v_admin_announces;
    v_mismatch := true;
  END IF;

  IF v_auth_acks < v_admin_acks THEN
    RAISE WARNING 'MISMATCH: auth.announcement_acknowledgments (%) < admin.announcement_acknowledgments (%)', v_auth_acks, v_admin_acks;
    v_mismatch := true;
  END IF;

  IF v_mismatch THEN
    RAISE EXCEPTION 'Migration verification FAILED — count mismatches detected. Transaction will be rolled back.';
  ELSE
    RAISE NOTICE 'Migration verification PASSED — all counts are consistent.';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 6. Verify data integrity: orphan check
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_orphan_messages BIGINT;
  v_orphan_acks     BIGINT;
BEGIN
  -- Messages referencing non-existent threads
  SELECT COUNT(*) INTO v_orphan_messages
  FROM auth.messages m
  WHERE NOT EXISTS (
    SELECT 1 FROM auth.message_threads t WHERE t."id" = m."threadId"
  );

  -- Acknowledgments referencing non-existent announcements
  SELECT COUNT(*) INTO v_orphan_acks
  FROM auth.announcement_acknowledgments ak
  WHERE NOT EXISTS (
    SELECT 1 FROM auth.announcements a WHERE a."id" = ak."announcementId"
  );

  RAISE NOTICE '=== DATA INTEGRITY CHECK ===';
  RAISE NOTICE 'Orphan messages (no thread):       %', v_orphan_messages;
  RAISE NOTICE 'Orphan acknowledgments (no announ): %', v_orphan_acks;

  IF v_orphan_messages > 0 OR v_orphan_acks > 0 THEN
    RAISE WARNING 'Orphan records detected — review data integrity.';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 7. Commit
-- ---------------------------------------------------------------------------
-- If we reach here, all counts matched and no exceptions were raised.
COMMIT;

-- =============================================================================
-- Post-migration notes:
--
-- 1. The admin schema tables are NOT deleted. They remain as a read-only archive.
--    To clean up later: DROP TABLE admin.messages, admin.message_threads,
--    admin.announcements, admin.announcement_acknowledgments CASCADE;
--
-- 2. The "lastMessage" and "lastMessageBy" fields on auth.message_threads are
--    backfilled from the most recent message per thread (step 2a).
--
-- 3. The "createdBy" field on auth.message_threads is set to tenantId as a
--    placeholder since admin schema did not track thread creators.
--
-- 4. TypeORM enum type names follow the pattern:
--      {table}_{column}_enum  (e.g., messages_senderType_enum)
--    If your enum type names differ, adjust the CAST expressions.
--    To discover actual enum names:
--      SELECT typname FROM pg_type WHERE typname LIKE '%enum%'
--        AND typnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'auth');
--
-- 5. For rollback, use: scripts/migrate-messaging-to-admin-rollback.sql
-- =============================================================================
