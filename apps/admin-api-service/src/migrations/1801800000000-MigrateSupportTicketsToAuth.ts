import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * MigrateSupportTicketsToAuth — consolidate support tickets onto the auth SSoT
 * and drop the admin-api duplicate (APA-213 / ADMIN-CRITICAL-022).
 *
 * BREAKING CHANGE: DROPs admin.support_tickets and admin.ticket_comments. These
 * tables are a write-only duplicate of auth.support_tickets / auth.ticket_comments
 * (the tables tenants + the real SSoT read via the auth-service `myTickets` /
 * `ticket` / `ticketComments` GraphQL lane). Their entities, controller and
 * service are removed in the same change. Column/table drop — recording it here.
 *
 * # SAFETY SHAPE (copy-before-drop, verified, idempotent)
 *
 * up() runs inside the migration's transaction, so copy + verify + drop commit
 * atomically — a failure at ANY step rolls the whole thing back and drops
 * nothing:
 *   1. If admin.support_tickets is absent (fresh DB built past this point),
 *      there is nothing to migrate — return early.
 *   2. If it holds rows, auth.support_tickets MUST exist (auth migrations ran)
 *      or we RAISE rather than drop and lose data.
 *   3. Copy every admin row into auth.support_tickets preserving id so the copy
 *      is idempotent (ON CONFLICT DO NOTHING) and comment FKs keep resolving.
 *      Enum/model mapping (admin's minutes-model → auth's deadline-model):
 *        - admin.dueAt                     → slaResolutionDeadline
 *        - createdAt + slaResponseMinutes  → slaResponseDeadline (NULL if the
 *          minutes are unavailable)
 *        - category 'bug_report' → 'bug', 'account' → 'general' (auth's
 *          category enum has neither 'bug_report' nor 'account'); priority +
 *          status enum values are identical across admin and auth.
 *        - createdBy → reportedBy, createdByName → reportedByName (NOT NULL in
 *          auth, so a NULL admin value maps to 'Unknown').
 *        - commentCount is recomputed from the admin comment rows (auth requires
 *          it NOT NULL; admin never stored it).
 *        - satisfactionRating 0 (admin's "unrated" sentinel) → NULL (auth's).
 *        - satisfactionFeedback → satisfactionComment; tags jsonb-array → the
 *          text/simple-array auth column.
 *        - slaBreached is DROPPED — auth computes breach on read from the
 *          deadline getters (isResponseSLABreached / isResolutionSLABreached).
 *        - createdByEmail / closedAt / slaResolutionMinutes / metadata have no
 *          auth column and are not carried.
 *   4. VERIFY every source ticket id now exists in auth.support_tickets before
 *      dropping; RAISE if the copy is incomplete.
 *   5. Copy comments (map admin authorType 'admin'→'super_admin',
 *      'tenant_user'→'tenant_admin', 'system'→'system'; authorName NOT NULL →
 *      'Unknown' fallback). VERIFY completeness, then DROP both admin tables
 *      (comments first — FK dependency on admin.support_tickets).
 *
 * # COMMENT ATTACHMENTS ARE NOT CARRIED
 *
 * admin.ticket_comments.attachments (jsonb {id,fileName,fileSize,mimeType,url,
 * uploadedAt}) has a DIFFERENT shape from auth.ticket_comments.attachments
 * ({id,filename,url,size}) and was never populated from the admin support UI
 * (the ticket panel only ever posted {content,isInternal}). Copying the raw
 * admin jsonb would inject wrong-shaped attachment objects into the auth SSoT,
 * so attachments are intentionally left NULL — matching the field set APA-213
 * consolidates (authorId/authorType/isInternal/content/ticketId).
 *
 * # CROSS-SCHEMA WRITE
 *
 * The copy writes into the `auth` schema from the admin-api migration role. In
 * this single-database / multi-schema deployment the role must hold INSERT on
 * auth.support_tickets(+auth.ticket_comments). If it does not, the INSERT fails
 * and — because copy+drop are one transaction — nothing is dropped (fail-safe,
 * loud); an operator grants the privilege (or runs the copy as owner) and
 * re-runs. Same tracked caveat as APA-201's MigrateAnnouncementsToAuth.
 *
 * Closes: docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/support.md#APA-213
 */
export class MigrateSupportTicketsToAuth1801800000000
  implements MigrationInterface
{
  name = 'MigrateSupportTicketsToAuth1801800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $migrate_support_tickets$
      DECLARE
        src_count bigint;
        copied_count bigint;
        src_comment_count bigint;
        copied_comment_count bigint;
      BEGIN
        -- 1. Nothing to migrate if the legacy table is already gone.
        IF to_regclass('"admin"."support_tickets"') IS NULL THEN
          RETURN;
        END IF;

        SELECT count(*) INTO src_count FROM "admin"."support_tickets";

        IF src_count > 0 THEN
          -- 2. Refuse to drop (and lose rows) if the auth target is missing.
          IF to_regclass('"auth"."support_tickets"') IS NULL THEN
            RAISE EXCEPTION
              'auth.support_tickets does not exist; run auth-service migrations before admin-api MigrateSupportTicketsToAuth (refusing to drop admin.support_tickets and lose % row(s))',
              src_count;
          END IF;

          -- 3. Copy admin rows into the auth SSoT (id-preserving, idempotent).
          INSERT INTO "auth"."support_tickets" (
            "id", "ticketNumber", "tenantId", "subject", "description",
            "category", "priority", "status", "assignedTo", "assignedToName",
            "reportedBy", "reportedByName", "commentCount",
            "slaResponseDeadline", "slaResolutionDeadline", "firstResponseAt",
            "resolvedAt", "satisfactionRating", "satisfactionComment", "tags",
            "createdAt", "updatedAt"
          )
          SELECT
            a."id",
            a."ticketNumber",
            a."tenantId",
            a."subject",
            a."description",
            (CASE a."category"
               WHEN 'bug_report' THEN 'bug'
               WHEN 'account' THEN 'general'
               ELSE a."category"
             END)::"auth"."support_tickets_category_enum",
            a."priority"::"auth"."support_tickets_priority_enum",
            a."status"::"auth"."support_tickets_status_enum",
            a."assignedTo",
            a."assignedToName",
            a."createdBy",
            COALESCE(a."createdByName", 'Unknown'),
            COALESCE(
              (SELECT count(*) FROM "admin"."ticket_comments" tc
                WHERE tc."ticketId" = a."id"),
              0
            )::int,
            CASE
              WHEN a."slaResponseMinutes" IS NOT NULL
                THEN a."createdAt" + (a."slaResponseMinutes" || ' minutes')::interval
              ELSE NULL
            END,
            a."dueAt",
            a."firstResponseAt",
            a."resolvedAt",
            NULLIF(a."satisfactionRating", 0),
            a."satisfactionFeedback",
            CASE
              WHEN a."tags" IS NULL THEN NULL
              WHEN jsonb_typeof(a."tags") <> 'array' THEN NULL
              WHEN jsonb_array_length(a."tags") = 0 THEN NULL
              ELSE array_to_string(ARRAY(SELECT jsonb_array_elements_text(a."tags")), ',')
            END,
            a."createdAt",
            a."updatedAt"
          FROM "admin"."support_tickets" a
          ON CONFLICT DO NOTHING;

          -- 4. Verify the copy is complete before any drop.
          SELECT count(*) INTO copied_count
            FROM "admin"."support_tickets" a
           WHERE EXISTS (
             SELECT 1 FROM "auth"."support_tickets" t WHERE t."id" = a."id"
           );
          IF copied_count < src_count THEN
            RAISE EXCEPTION
              'support_ticket copy incomplete: % of % admin row(s) present in auth.support_tickets — refusing to drop',
              copied_count, src_count;
          END IF;
        END IF;

        -- 5a. Copy comments whose ticket crossed over.
        IF to_regclass('"admin"."ticket_comments"') IS NOT NULL THEN
          SELECT count(*) INTO src_comment_count FROM "admin"."ticket_comments";

          IF src_comment_count > 0 THEN
            IF to_regclass('"auth"."ticket_comments"') IS NULL THEN
              RAISE EXCEPTION
                'auth.ticket_comments does not exist; run auth-service migrations before admin-api MigrateSupportTicketsToAuth (refusing to drop admin.ticket_comments and lose % row(s))',
                src_comment_count;
            END IF;

            INSERT INTO "auth"."ticket_comments" (
              "id", "ticketId", "authorId", "authorName", "authorType",
              "content", "isInternal", "createdAt"
            )
            SELECT
              c."id",
              c."ticketId",
              c."authorId",
              COALESCE(c."authorName", 'Unknown'),
              (CASE c."authorType"
                 WHEN 'admin' THEN 'super_admin'
                 WHEN 'tenant_user' THEN 'tenant_admin'
                 ELSE c."authorType"
               END)::"auth"."ticket_comments_authortype_enum",
              c."content",
              c."isInternal",
              c."createdAt"
            FROM "admin"."ticket_comments" c
            WHERE EXISTS (
              SELECT 1 FROM "auth"."support_tickets" t WHERE t."id" = c."ticketId"
            )
            ON CONFLICT DO NOTHING;

            SELECT count(*) INTO copied_comment_count
              FROM "admin"."ticket_comments" c
             WHERE EXISTS (
               SELECT 1 FROM "auth"."ticket_comments" tc WHERE tc."id" = c."id"
             );
            IF copied_comment_count < src_comment_count THEN
              RAISE EXCEPTION
                'ticket_comment copy incomplete: % of % admin row(s) present in auth.ticket_comments — refusing to drop',
                copied_comment_count, src_comment_count;
            END IF;
          END IF;
        END IF;

        -- 5b. Drop the duplicate admin tables (comments first — FK dependency).
        DROP TABLE IF EXISTS "admin"."ticket_comments";
        DROP TABLE IF EXISTS "admin"."support_tickets";
      END
      $migrate_support_tickets$;
    `);
  }

  public async down(): Promise<void> {
    // Forward-only consolidation (same contract as the sibling drop/corrective
    // migrations, e.g. MigrateAnnouncementsToAuth, whose down() throws). The
    // admin.support_tickets / admin.ticket_comments rows have been copied into
    // auth.support_tickets / auth.ticket_comments — the SSoT tenants read — and
    // the admin entities / controller / service are deleted. Re-creating the
    // admin tables would resurrect the exact write-only duplicate this migration
    // removes and would NOT restore the copied rows to admin, so a "rollback"
    // here would silently diverge the two stores again. Production runs
    // DATABASE_MIGRATIONS_RUN with a forward-only runner regardless.
    throw new Error(
      'Refusing to rollback 1801800000000-MigrateSupportTicketsToAuth: support ' +
        'tickets were consolidated onto auth.support_tickets / auth.ticket_comments ' +
        '(the SSoT tenants read) and the admin duplicate was dropped after copy. ' +
        'This migration is forward-only.',
    );
  }
}
