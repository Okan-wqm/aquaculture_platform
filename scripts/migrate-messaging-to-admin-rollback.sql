-- =============================================================================
-- REVERSE MIGRATION (ROLLBACK): auth schema → admin schema
-- =============================================================================
--
-- Purpose: Roll back the forward migration by copying data from auth-service's
--          schema (auth.*) back to admin-api-service's schema (admin.*).
--          Use this if the forward migration needs to be reverted.
--
-- Preconditions:
--   - Forward migration was previously executed
--   - Both schemas exist: admin, auth
--   - admin schema tables exist (they were NOT dropped after forward migration)
--
-- Column Mapping Notes (reverse of forward migration):
--
--   message_threads:
--     auth."unreadCountAdmin"  → admin."unreadAdminCount"
--     auth."unreadCountTenant" → admin."unreadTenantCount"
--     auth."status" enum       → admin."isClosed" / admin."isArchived" booleans
--     auth."lastMessage", "lastMessageBy", "createdBy", "createdByAdmin"
--       → dropped (admin schema does not have these columns)
--
--   messages:
--     auth."senderType" 'super_admin' → admin."senderType" 'admin'
--     auth."senderName" NOT NULL      → admin."senderName" (compatible)
--     auth has no 'failed' status     → no reverse mapping needed
--     (no source)                     → admin."emailSent" (default: false)
--
--   announcements:
--     auth."scope"    → dropped (admin schema does not have this column)
--     auth."tenantId" → dropped (admin schema does not have this column on announcements)
--     auth."createdBy" NOT NULL    → admin."createdBy" (compatible, nullable)
--     auth."createdByName" NOT NULL → admin."createdByName" (compatible, nullable)
--
--   announcement_acknowledgments:
--     auth."viewedAt" (CreateDateColumn) → admin."viewedAt" (nullable column)
--     auth."tenantName" → dropped (admin schema does not have this column)
--     (no source)       → admin."createdAt" (use auth."viewedAt" as fallback)
--
-- Idempotency: ON CONFLICT (id) DO NOTHING — safe for re-runs.
--
-- Usage:
--   psql -U aquaculture -d aquaculture -f scripts/migrate-messaging-to-admin-rollback.sql
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Pre-rollback counts
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_auth_threads    BIGINT;
  v_auth_messages    BIGINT;
  v_auth_announces   BIGINT;
  v_auth_acks        BIGINT;
BEGIN
  SELECT COUNT(*) INTO v_auth_threads    FROM auth.message_threads;
  SELECT COUNT(*) INTO v_auth_messages    FROM auth.messages;
  SELECT COUNT(*) INTO v_auth_announces   FROM auth.announcements;
  SELECT COUNT(*) INTO v_auth_acks        FROM auth.announcement_acknowledgments;

  RAISE NOTICE '=== PRE-ROLLBACK COUNTS (auth schema) ===';
  RAISE NOTICE 'message_threads:             %', v_auth_threads;
  RAISE NOTICE 'messages:                    %', v_auth_messages;
  RAISE NOTICE 'announcements:               %', v_auth_announces;
  RAISE NOTICE 'announcement_acknowledgments: %', v_auth_acks;
END $$;

-- ---------------------------------------------------------------------------
-- 1. Rollback message_threads: auth → admin
-- ---------------------------------------------------------------------------
-- Column mapping (reverse):
--   auth."id"               → admin."id"
--   auth."tenantId"         → admin."tenantId"
--   auth."subject"          → admin."subject"
--   auth."lastMessageAt"    → admin."lastMessageAt"
--   auth."status"           → admin."isClosed" + admin."isArchived"
--   auth."messageCount"     → admin."messageCount"
--   auth."unreadCountAdmin" → admin."unreadAdminCount"
--   auth."unreadCountTenant"→ admin."unreadTenantCount"
--   auth."createdAt"        → admin."createdAt"
--   auth."updatedAt"        → admin."updatedAt"
-- Dropped: auth."lastMessage", "lastMessageBy", "createdBy", "createdByAdmin"
-- Defaults: admin."lastMessageId" → NULL, admin."metadata" → NULL
-- ---------------------------------------------------------------------------

WITH inserted AS (
  INSERT INTO admin.message_threads (
    "id",
    "tenantId",
    "subject",
    "lastMessageId",
    "lastMessageAt",
    "messageCount",
    "unreadAdminCount",
    "unreadTenantCount",
    "isArchived",
    "isClosed",
    "metadata",
    "createdAt",
    "updatedAt"
  )
  SELECT
    t."id",
    t."tenantId",
    t."subject",
    -- lastMessageId: auth does not have this; derive from latest message or NULL
    (
      SELECT m."id"
      FROM auth.messages m
      WHERE m."threadId" = t."id"
      ORDER BY m."createdAt" DESC
      LIMIT 1
    ),
    t."lastMessageAt",
    t."messageCount",
    -- Column rename: unreadCountAdmin → unreadAdminCount
    t."unreadCountAdmin",
    -- Column rename: unreadCountTenant → unreadTenantCount
    t."unreadCountTenant",
    -- isArchived: derive from status enum (cast to text for safe comparison)
    CASE WHEN t."status"::text = 'archived' THEN true ELSE false END,
    -- isClosed: derive from status enum (cast to text for safe comparison)
    CASE WHEN t."status"::text = 'closed' THEN true ELSE false END,
    -- metadata: admin has this column but auth does not; set to NULL
    NULL::jsonb,
    t."createdAt",
    t."updatedAt"
  FROM auth.message_threads t
  ON CONFLICT ("id") DO NOTHING
  RETURNING "id"
)
SELECT COUNT(*) AS threads_rolled_back FROM inserted;

-- ---------------------------------------------------------------------------
-- 2. Rollback messages: auth → admin
-- ---------------------------------------------------------------------------
-- Column mapping (reverse):
--   auth."id"          → admin."id"
--   auth."threadId"    → admin."threadId"
--   auth."senderId"    → admin."senderId"
--   auth."senderType"  → admin."senderType" ('super_admin' → 'admin')
--   auth."senderName"  → admin."senderName"
--   auth."content"     → admin."content"
--   auth."status"      → admin."status"
--   auth."isInternal"  → admin."isInternal"
--   auth."attachments" → admin."attachments"
--   auth."readAt"      → admin."readAt"
--   auth."createdAt"   → admin."createdAt"
-- Defaults: admin."emailSent" → false
-- ---------------------------------------------------------------------------

WITH inserted AS (
  INSERT INTO admin.messages (
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
    "emailSent",
    "createdAt"
  )
  SELECT
    m."id",
    m."threadId",
    m."senderId",
    -- senderType reverse mapping: 'super_admin' → 'admin'
    CASE m."senderType"::text
      WHEN 'super_admin'  THEN 'admin'
      WHEN 'tenant_admin' THEN 'tenant_admin'
      WHEN 'system'       THEN 'system'
      ELSE 'system'
    END,
    m."senderName",
    m."content",
    -- status: auth has no 'failed', so straight mapping is safe
    m."status"::text,
    m."isInternal",
    m."attachments",
    m."readAt",
    -- emailSent: auth does not have this column; default to false
    false,
    m."createdAt"
  FROM auth.messages m
  -- Only rollback messages whose thread exists in admin (defensive join)
  WHERE EXISTS (
    SELECT 1 FROM admin.message_threads t WHERE t."id" = m."threadId"
  )
  ON CONFLICT ("id") DO NOTHING
  RETURNING "id"
)
SELECT COUNT(*) AS messages_rolled_back FROM inserted;

-- ---------------------------------------------------------------------------
-- 3. Rollback announcements: auth → admin
-- ---------------------------------------------------------------------------
-- Column mapping (reverse):
--   auth."id"                     → admin."id"
--   auth."title"                  → admin."title"
--   auth."content"                → admin."content"
--   auth."type"                   → admin."type"
--   auth."status"                 → admin."status"
--   auth."isGlobal"               → admin."isGlobal"
--   auth."targetCriteria"         → admin."targetCriteria"
--   auth."publishAt"              → admin."publishAt"
--   auth."expiresAt"              → admin."expiresAt"
--   auth."requiresAcknowledgment" → admin."requiresAcknowledgment"
--   auth."viewCount"              → admin."viewCount"
--   auth."acknowledgmentCount"    → admin."acknowledgmentCount"
--   auth."createdBy"              → admin."createdBy"
--   auth."createdByName"          → admin."createdByName"
--   auth."createdAt"              → admin."createdAt"
--   auth."updatedAt"              → admin."updatedAt"
-- Dropped: auth."scope", auth."tenantId" (admin schema does not have these)
-- Defaults: admin."metadata" → NULL
-- Note: Only migrate PLATFORM-scoped announcements back (TENANT-scoped ones
--       were never in admin schema and should not be rolled back).
-- ---------------------------------------------------------------------------

WITH inserted AS (
  INSERT INTO admin.announcements (
    "id",
    "title",
    "content",
    "type",
    "status",
    "isGlobal",
    "targetCriteria",
    "createdBy",
    "createdByName",
    "publishAt",
    "expiresAt",
    "requiresAcknowledgment",
    "viewCount",
    "acknowledgmentCount",
    "metadata",
    "createdAt",
    "updatedAt"
  )
  SELECT
    a."id",
    a."title",
    a."content",
    -- type: same enum values, cast to text (admin uses varchar, not enum)
    a."type"::text,
    -- status: same enum values
    a."status"::text,
    a."isGlobal",
    a."targetCriteria",
    -- createdBy: system placeholder UUID maps back as-is (nullable in admin)
    CASE
      WHEN a."createdBy" = '00000000-0000-0000-0000-000000000000' THEN NULL
      ELSE a."createdBy"
    END,
    -- createdByName: 'System' placeholder maps back to NULL
    CASE
      WHEN a."createdByName" = 'System'
           AND a."createdBy" = '00000000-0000-0000-0000-000000000000' THEN NULL
      ELSE a."createdByName"
    END,
    a."publishAt",
    a."expiresAt",
    a."requiresAcknowledgment",
    a."viewCount",
    a."acknowledgmentCount",
    -- metadata: admin has this column but auth does not; set to NULL
    NULL::jsonb,
    a."createdAt",
    a."updatedAt"
  FROM auth.announcements a
  -- Only roll back PLATFORM-scoped announcements (TENANT-scoped were never in admin)
  WHERE a."scope"::text = 'platform'
  ON CONFLICT ("id") DO NOTHING
  RETURNING "id"
)
SELECT COUNT(*) AS announcements_rolled_back FROM inserted;

-- ---------------------------------------------------------------------------
-- 4. Rollback announcement_acknowledgments: auth → admin
-- ---------------------------------------------------------------------------
-- Column mapping (reverse):
--   auth."id"              → admin."id"
--   auth."announcementId"  → admin."announcementId"
--   auth."userId"          → admin."userId"
--   auth."userName"        → admin."userName"
--   auth."tenantId"        → admin."tenantId"
--   auth."viewedAt"        → admin."viewedAt"
--   auth."acknowledgedAt"  → admin."acknowledgedAt"
--   auth."viewedAt"        → admin."createdAt" (auth has no separate createdAt)
-- Dropped: auth."tenantName" (admin does not have this column)
-- ---------------------------------------------------------------------------

WITH inserted AS (
  INSERT INTO admin.announcement_acknowledgments (
    "id",
    "announcementId",
    "tenantId",
    "userId",
    "userName",
    "viewedAt",
    "acknowledgedAt",
    "createdAt"
  )
  SELECT
    ak."id",
    ak."announcementId",
    ak."tenantId",
    ak."userId",
    -- userName: auth requires NOT NULL, admin allows NULL
    -- 'Unknown User' placeholder maps back to NULL
    CASE
      WHEN ak."userName" = 'Unknown User' THEN NULL
      ELSE ak."userName"
    END,
    ak."viewedAt",
    ak."acknowledgedAt",
    -- createdAt: admin has this but auth does not; use viewedAt as fallback
    ak."viewedAt"
  FROM auth.announcement_acknowledgments ak
  -- Only rollback acks whose announcement exists in admin (defensive join)
  WHERE EXISTS (
    SELECT 1 FROM admin.announcements ann WHERE ann."id" = ak."announcementId"
  )
  ON CONFLICT ("id") DO NOTHING
  RETURNING "id"
)
SELECT COUNT(*) AS acks_rolled_back FROM inserted;

-- ---------------------------------------------------------------------------
-- 5. Post-rollback verification
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_auth_threads    BIGINT;
  v_admin_threads   BIGINT;
  v_auth_messages    BIGINT;
  v_admin_messages   BIGINT;
  v_auth_announces   BIGINT;
  v_admin_announces  BIGINT;
  v_auth_acks        BIGINT;
  v_admin_acks       BIGINT;
  v_auth_platform_announces BIGINT;
  v_mismatch         BOOLEAN := false;
BEGIN
  SELECT COUNT(*) INTO v_auth_threads    FROM auth.message_threads;
  SELECT COUNT(*) INTO v_admin_threads   FROM admin.message_threads;
  SELECT COUNT(*) INTO v_auth_messages    FROM auth.messages;
  SELECT COUNT(*) INTO v_admin_messages   FROM admin.messages;
  SELECT COUNT(*) INTO v_auth_announces   FROM auth.announcements;
  SELECT COUNT(*) INTO v_admin_announces  FROM admin.announcements;
  SELECT COUNT(*) INTO v_auth_acks        FROM auth.announcement_acknowledgments;
  SELECT COUNT(*) INTO v_admin_acks       FROM admin.announcement_acknowledgments;

  -- Only PLATFORM-scoped announcements should be rolled back
  SELECT COUNT(*) INTO v_auth_platform_announces
  FROM auth.announcements WHERE "scope"::text = 'platform';

  RAISE NOTICE '=== POST-ROLLBACK VERIFICATION ===';
  RAISE NOTICE 'message_threads:              auth=% admin=%', v_auth_threads, v_admin_threads;
  RAISE NOTICE 'messages:                     auth=% admin=%', v_auth_messages, v_admin_messages;
  RAISE NOTICE 'announcements:                auth=% (platform=%) admin=%', v_auth_announces, v_auth_platform_announces, v_admin_announces;
  RAISE NOTICE 'announcement_acknowledgments: auth=% admin=%', v_auth_acks, v_admin_acks;

  -- Admin counts should be >= auth counts for threads/messages
  -- For announcements, admin should be >= auth PLATFORM-scoped only
  IF v_admin_threads < v_auth_threads THEN
    RAISE WARNING 'MISMATCH: admin.message_threads (%) < auth.message_threads (%)', v_admin_threads, v_auth_threads;
    v_mismatch := true;
  END IF;

  IF v_admin_messages < v_auth_messages THEN
    RAISE WARNING 'MISMATCH: admin.messages (%) < auth.messages (%)', v_admin_messages, v_auth_messages;
    v_mismatch := true;
  END IF;

  IF v_admin_announces < v_auth_platform_announces THEN
    RAISE WARNING 'MISMATCH: admin.announcements (%) < auth platform announcements (%)', v_admin_announces, v_auth_platform_announces;
    v_mismatch := true;
  END IF;

  IF v_mismatch THEN
    RAISE EXCEPTION 'Rollback verification FAILED — count mismatches detected. Transaction will be rolled back.';
  ELSE
    RAISE NOTICE 'Rollback verification PASSED — all counts are consistent.';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 6. Data integrity check
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_orphan_messages BIGINT;
  v_orphan_acks     BIGINT;
BEGIN
  -- Messages referencing non-existent threads
  SELECT COUNT(*) INTO v_orphan_messages
  FROM admin.messages m
  WHERE NOT EXISTS (
    SELECT 1 FROM admin.message_threads t WHERE t."id" = m."threadId"
  );

  -- Acknowledgments referencing non-existent announcements
  SELECT COUNT(*) INTO v_orphan_acks
  FROM admin.announcement_acknowledgments ak
  WHERE NOT EXISTS (
    SELECT 1 FROM admin.announcements a WHERE a."id" = ak."announcementId"
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
COMMIT;

-- =============================================================================
-- Post-rollback notes:
--
-- 1. The auth schema tables are NOT deleted. Both schemas now contain data.
--
-- 2. TENANT-scoped announcements (created natively in auth-service) are NOT
--    rolled back to admin schema because they never existed there.
--
-- 3. The admin."lastMessageId" is derived from the most recent message in
--    each thread via a subquery during rollback.
--
-- 4. Placeholder values used during forward migration are reversed:
--    - '00000000-0000-0000-0000-000000000000' → NULL for createdBy
--    - 'System' → NULL for createdByName (only when paired with system UUID)
--    - 'Unknown User' → NULL for userName
--
-- 5. admin."emailSent" defaults to false (auth does not track this).
--
-- 6. admin."metadata" defaults to NULL (auth does not have this column).
--
-- 7. After rollback, you may need to restart admin-api-service to re-enable
--    the REST messaging/announcement endpoints.
-- =============================================================================
