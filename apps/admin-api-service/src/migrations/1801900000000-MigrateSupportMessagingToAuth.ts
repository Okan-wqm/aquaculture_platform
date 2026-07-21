import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * MigrateSupportMessagingToAuth — consolidate admin-to-tenant support messaging
 * onto the auth SSoT and drop the admin-api duplicate (APA-213 / ADMIN-CRITICAL-022,
 * the MESSAGING slice; direct mirror of 1801800000000-MigrateSupportTicketsToAuth).
 *
 * BREAKING CHANGE: DROPs admin.message_threads and admin.messages. These tables
 * are a write-only duplicate of auth.message_threads / auth.messages (the tables
 * tenants + the real SSoT read/write via the auth-service `mySupportThreads` /
 * `supportThread` / `supportThreadMessages` GraphQL lane). Their entities,
 * controller and service are removed in the same change. Column/table drop —
 * recording it here.
 *
 * # SAFETY SHAPE (copy-before-drop, verified, idempotent)
 *
 * up() runs inside the migration's transaction, so copy + verify + drop commit
 * atomically — a failure at ANY step rolls the whole thing back and drops
 * nothing:
 *   1. If admin.message_threads is absent (fresh DB built past this point),
 *      there is nothing to migrate — return early.
 *   2. If it holds rows, auth.message_threads MUST exist (auth migrations ran)
 *      or we RAISE rather than drop and lose data.
 *   3. Copy every admin thread into auth.message_threads preserving id so the
 *      copy is idempotent (ON CONFLICT DO NOTHING) and message FKs keep
 *      resolving. Column/model mapping (admin's flags-model → auth's model):
 *        - unreadAdminCount   → unreadCountAdmin
 *        - unreadTenantCount  → unreadCountTenant
 *        - isArchived / isClosed → status enum: isArchived → 'archived',
 *          else isClosed → 'closed', else 'open' (auth folds the two admin
 *          booleans into a single message_threads_status_enum).
 *        - lastMessageId (admin's pointer to the last message row) is resolved
 *          into auth's denormalized pair: lastMessage ← that message's content,
 *          lastMessageBy ← that message's senderId (both nullable; NULL when the
 *          pointer is NULL).
 *        - createdBy (auth: NOT NULL uuid) and createdByAdmin (auth: NOT NULL
 *          bool) have NO admin thread-level column. admin never tracked a thread
 *          owner; the creator is the FIRST message's sender. So createdBy ←
 *          earliest message senderId, createdByAdmin ← (earliest message
 *          senderType = 'admin'). Every admin thread is created WITH an initial
 *          message (createThread always calls addMessage) and messages are never
 *          deleted, so the earliest message always exists; the COALESCE to the
 *          nil uuid / false is a NOT-NULL guard for a degenerate empty thread
 *          that cannot occur in practice (mirrors the tickets migration's
 *          'Unknown' guard for a NOT-NULL text column).
 *        - lastMessageId / metadata have no auth column and are not carried
 *          (metadata held only a denormalized tenantName cache; auth derives
 *          tenantName from the tenant relation).
 *   4. VERIFY every source thread id now exists in auth.message_threads before
 *      dropping; RAISE if the copy is incomplete.
 *   5. Copy messages (map admin senderType 'admin'→'super_admin',
 *      'tenant_admin'→'tenant_admin', 'system'→'system'; senderName NOT NULL →
 *      'Unknown' fallback; status folded to auth's 3-value enum — admin's
 *      terminal 'failed' → 'sent'). VERIFY completeness, then DROP both admin
 *      tables (messages first — FK dependency on admin.message_threads).
 *
 * # MESSAGE ATTACHMENTS ARE NOT CARRIED
 *
 * admin.messages.attachments (jsonb {id,fileName,fileSize,mimeType,url,
 * uploadedAt}) has a DIFFERENT shape from auth.messages.attachments
 * ({id,filename,url,size,mimeType}) and was never populated from the admin
 * support UI (the messaging panel only ever posted {content,senderName}; the
 * addMessage default stored an empty [] array). Copying the raw admin jsonb
 * would inject wrong-shaped attachment objects into the auth SSoT, so
 * attachments are intentionally left NULL — matching the field set APA-213
 * consolidates. admin.messages.emailSent likewise has no auth counterpart and
 * is not carried.
 *
 * # CROSS-SCHEMA WRITE
 *
 * The copy writes into the `auth` schema from the admin-api migration role. In
 * this single-database / multi-schema deployment the role must hold INSERT on
 * auth.message_threads(+auth.messages). If it does not, the INSERT fails and —
 * because copy+drop are one transaction — nothing is dropped (fail-safe, loud);
 * an operator grants the privilege (or runs the copy as owner) and re-runs.
 * Same tracked caveat as APA-201's MigrateAnnouncementsToAuth and APA-213's
 * MigrateSupportTicketsToAuth. auth.message_threads.tenantId additionally
 * carries an ON-DELETE-RESTRICT FK to auth.tenants; every admin thread targets a
 * real tenant that exists in the auth SSoT, so the FK holds — and if an orphaned
 * admin thread ever referenced a purged tenant, the INSERT fails loudly and
 * nothing is dropped.
 *
 * Closes: docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/support.md#APA-213
 */
export class MigrateSupportMessagingToAuth1801900000000
  implements MigrationInterface
{
  name = 'MigrateSupportMessagingToAuth1801900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $migrate_support_messaging$
      DECLARE
        src_count bigint;
        copied_count bigint;
        src_message_count bigint;
        copied_message_count bigint;
      BEGIN
        -- 1. Nothing to migrate if the legacy table is already gone.
        IF to_regclass('"admin"."message_threads"') IS NULL THEN
          RETURN;
        END IF;

        SELECT count(*) INTO src_count FROM "admin"."message_threads";

        IF src_count > 0 THEN
          -- 2. Refuse to drop (and lose rows) if the auth target is missing.
          IF to_regclass('"auth"."message_threads"') IS NULL THEN
            RAISE EXCEPTION
              'auth.message_threads does not exist; run auth-service migrations before admin-api MigrateSupportMessagingToAuth (refusing to drop admin.message_threads and lose % row(s))',
              src_count;
          END IF;

          -- 3. Copy admin threads into the auth SSoT (id-preserving, idempotent).
          INSERT INTO "auth"."message_threads" (
            "id", "tenantId", "subject", "lastMessage", "lastMessageAt",
            "lastMessageBy", "status", "messageCount", "unreadCountAdmin",
            "unreadCountTenant", "createdBy", "createdByAdmin", "createdAt",
            "updatedAt"
          )
          SELECT
            a."id",
            a."tenantId",
            a."subject",
            (SELECT lm."content" FROM "admin"."messages" lm
              WHERE lm."id" = a."lastMessageId"),
            a."lastMessageAt",
            (SELECT lm."senderId" FROM "admin"."messages" lm
              WHERE lm."id" = a."lastMessageId"),
            (CASE
               WHEN a."isArchived" THEN 'archived'
               WHEN a."isClosed" THEN 'closed'
               ELSE 'open'
             END)::"auth"."message_threads_status_enum",
            a."messageCount",
            a."unreadAdminCount",
            a."unreadTenantCount",
            COALESCE(
              (SELECT fm."senderId" FROM "admin"."messages" fm
                WHERE fm."threadId" = a."id"
                ORDER BY fm."createdAt" ASC, fm."id" ASC
                LIMIT 1),
              '00000000-0000-0000-0000-000000000000'
            ),
            COALESCE(
              (SELECT (fm."senderType" = 'admin') FROM "admin"."messages" fm
                WHERE fm."threadId" = a."id"
                ORDER BY fm."createdAt" ASC, fm."id" ASC
                LIMIT 1),
              false
            ),
            a."createdAt",
            a."updatedAt"
          FROM "admin"."message_threads" a
          ON CONFLICT DO NOTHING;

          -- 4. Verify the copy is complete before any drop.
          SELECT count(*) INTO copied_count
            FROM "admin"."message_threads" a
           WHERE EXISTS (
             SELECT 1 FROM "auth"."message_threads" t WHERE t."id" = a."id"
           );
          IF copied_count < src_count THEN
            RAISE EXCEPTION
              'message_thread copy incomplete: % of % admin row(s) present in auth.message_threads — refusing to drop',
              copied_count, src_count;
          END IF;
        END IF;

        -- 5a. Copy messages whose thread crossed over.
        IF to_regclass('"admin"."messages"') IS NOT NULL THEN
          SELECT count(*) INTO src_message_count FROM "admin"."messages";

          IF src_message_count > 0 THEN
            IF to_regclass('"auth"."messages"') IS NULL THEN
              RAISE EXCEPTION
                'auth.messages does not exist; run auth-service migrations before admin-api MigrateSupportMessagingToAuth (refusing to drop admin.messages and lose % row(s))',
                src_message_count;
            END IF;

            INSERT INTO "auth"."messages" (
              "id", "threadId", "senderId", "senderType", "senderName",
              "content", "status", "isInternal", "attachments", "readAt",
              "createdAt"
            )
            SELECT
              m."id",
              m."threadId",
              m."senderId",
              (CASE m."senderType"
                 WHEN 'admin' THEN 'super_admin'
                 ELSE m."senderType"
               END)::"auth"."messages_sendertype_enum",
              COALESCE(m."senderName", 'Unknown'),
              m."content",
              (CASE
                 WHEN m."status" IN ('sent', 'delivered', 'read') THEN m."status"
                 ELSE 'sent'
               END)::"auth"."messages_status_enum",
              m."isInternal",
              NULL::jsonb,
              m."readAt",
              m."createdAt"
            FROM "admin"."messages" m
            WHERE EXISTS (
              SELECT 1 FROM "auth"."message_threads" t WHERE t."id" = m."threadId"
            )
            ON CONFLICT DO NOTHING;

            SELECT count(*) INTO copied_message_count
              FROM "admin"."messages" m
             WHERE EXISTS (
               SELECT 1 FROM "auth"."messages" am WHERE am."id" = m."id"
             );
            IF copied_message_count < src_message_count THEN
              RAISE EXCEPTION
                'message copy incomplete: % of % admin row(s) present in auth.messages — refusing to drop',
                copied_message_count, src_message_count;
            END IF;
          END IF;
        END IF;

        -- 5b. Drop the duplicate admin tables (messages first — FK dependency).
        DROP TABLE IF EXISTS "admin"."messages";
        DROP TABLE IF EXISTS "admin"."message_threads";
      END
      $migrate_support_messaging$;
    `);
  }

  public async down(): Promise<void> {
    // Forward-only consolidation (same contract as the sibling drop/corrective
    // migrations, e.g. MigrateSupportTicketsToAuth, whose down() throws). The
    // admin.message_threads / admin.messages rows have been copied into
    // auth.message_threads / auth.messages (the SSoT tenants read) and the admin
    // entities / controller / service are deleted. Re-creating the admin tables
    // would resurrect the exact write-only duplicate this migration removes and
    // would NOT restore the copied rows to admin, so a "rollback" here would
    // silently diverge the two stores again. Production runs
    // DATABASE_MIGRATIONS_RUN with a forward-only runner regardless.
    throw new Error(
      'Refusing to rollback 1801900000000-MigrateSupportMessagingToAuth: support ' +
        'messaging was consolidated onto auth.message_threads / auth.messages ' +
        '(the SSoT tenants read) and the admin duplicate was dropped after copy. ' +
        'This migration is forward-only.',
    );
  }
}
