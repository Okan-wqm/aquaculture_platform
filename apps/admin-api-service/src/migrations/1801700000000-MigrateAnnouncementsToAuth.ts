import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * MigrateAnnouncementsToAuth — consolidate announcements onto the auth SSoT and
 * drop the admin-api duplicate (APA-201).
 *
 * BREAKING CHANGE: DROPs admin.announcements and admin.announcement_acknowledgments.
 * These tables are a write-only duplicate of auth.announcements /
 * auth.announcement_acknowledgments (the tables tenants actually read via the
 * auth-service `myAnnouncements` GraphQL lane). Their entities, controller and
 * service are removed in the same change. Column/table drop — recording it here.
 *
 * # SAFETY SHAPE (copy-before-drop, verified, idempotent)
 *
 * up() runs inside the migration's transaction, so copy + verify + drop commit
 * atomically — a failure at ANY step rolls the whole thing back and drops
 * nothing:
 *   1. If admin.announcements is absent (fresh DB built past this point), there
 *      is nothing to migrate — return early.
 *   2. If it holds rows, auth.announcements MUST exist (auth migrations ran) or
 *      we RAISE rather than drop and lose data.
 *   3. Copy every admin row into auth.announcements as scope='platform',
 *      tenantId=NULL (admin announcements were platform-wide), preserving id so
 *      the copy is idempotent (ON CONFLICT DO NOTHING) and acknowledgment FKs
 *      keep resolving. createdBy/createdByName are NOT NULL in auth, so a NULL
 *      admin value maps to the nil system-actor uuid / 'Platform Admin'.
 *   4. VERIFY every source id now exists in auth.announcements before dropping;
 *      RAISE if the copy is incomplete.
 *   5. Copy acknowledgments (only those whose announcement made it across) when
 *      both tables exist, then DROP both admin tables (acks first — FK order).
 *
 * # CROSS-SCHEMA WRITE
 *
 * The copy writes into the `auth` schema from the admin-api migration role. In
 * this single-database / multi-schema deployment the role must hold INSERT on
 * auth.announcements(+_acknowledgments). If it does not, the INSERT fails and —
 * because copy+drop are one transaction — nothing is dropped (fail-safe, loud);
 * an operator grants the privilege (or runs the copy as owner) and re-runs.
 *
 * Closes: docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/support.md#APA-201
 */
export class MigrateAnnouncementsToAuth1801700000000 implements MigrationInterface {
  name = 'MigrateAnnouncementsToAuth1801700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $migrate_announcements$
      DECLARE
        src_count bigint;
        copied_count bigint;
      BEGIN
        -- 1. Nothing to migrate if the legacy table is already gone.
        IF to_regclass('"admin"."announcements"') IS NULL THEN
          RETURN;
        END IF;

        SELECT count(*) INTO src_count FROM "admin"."announcements";

        IF src_count > 0 THEN
          -- 2. Refuse to drop (and lose rows) if the auth target is missing.
          IF to_regclass('"auth"."announcements"') IS NULL THEN
            RAISE EXCEPTION
              'auth.announcements does not exist; run auth-service migrations before admin-api MigrateAnnouncementsToAuth (refusing to drop admin.announcements and lose % row(s))',
              src_count;
          END IF;

          -- 3. Copy admin rows into the auth SSoT (scope=platform, no tenant).
          INSERT INTO "auth"."announcements" (
            "id", "title", "content", "type", "status", "scope", "tenantId",
            "isGlobal", "targetCriteria", "publishAt", "expiresAt",
            "requiresAcknowledgment", "viewCount", "acknowledgmentCount",
            "createdBy", "createdByName", "createdAt", "updatedAt"
          )
          SELECT
            a."id",
            a."title",
            a."content",
            a."type"::text::"auth"."announcements_type_enum",
            a."status"::text::"auth"."announcements_status_enum",
            'platform'::"auth"."announcements_scope_enum",
            NULL::uuid,
            a."isGlobal",
            a."targetCriteria",
            a."publishAt",
            a."expiresAt",
            a."requiresAcknowledgment",
            a."viewCount",
            a."acknowledgmentCount",
            COALESCE(a."createdBy", '00000000-0000-0000-0000-000000000000'::uuid),
            COALESCE(a."createdByName", 'Platform Admin'),
            a."createdAt",
            a."updatedAt"
          FROM "admin"."announcements" a
          ON CONFLICT DO NOTHING;

          -- 4. Verify the copy is complete before any drop.
          SELECT count(*) INTO copied_count
            FROM "admin"."announcements" a
           WHERE EXISTS (
             SELECT 1 FROM "auth"."announcements" t WHERE t."id" = a."id"
           );
          IF copied_count < src_count THEN
            RAISE EXCEPTION
              'announcement copy incomplete: % of % admin row(s) present in auth.announcements — refusing to drop',
              copied_count, src_count;
          END IF;
        END IF;

        -- 5a. Copy acknowledgments whose announcement crossed over.
        IF to_regclass('"admin"."announcement_acknowledgments"') IS NOT NULL
           AND to_regclass('"auth"."announcement_acknowledgments"') IS NOT NULL THEN
          INSERT INTO "auth"."announcement_acknowledgments" (
            "id", "announcementId", "userId", "userName", "tenantId",
            "tenantName", "viewedAt", "acknowledgedAt"
          )
          SELECT
            ack."id",
            ack."announcementId",
            ack."userId",
            COALESCE(ack."userName", 'Unknown User'),
            ack."tenantId",
            NULL::character varying,
            COALESCE(ack."viewedAt", ack."createdAt"),
            ack."acknowledgedAt"
          FROM "admin"."announcement_acknowledgments" ack
          WHERE EXISTS (
            SELECT 1 FROM "auth"."announcements" t WHERE t."id" = ack."announcementId"
          )
          ON CONFLICT DO NOTHING;
        END IF;

        -- 5b. Drop the duplicate admin tables (acks first — FK dependency).
        DROP TABLE IF EXISTS "admin"."announcement_acknowledgments";
        DROP TABLE IF EXISTS "admin"."announcements";
      END
      $migrate_announcements$;
    `);
  }

  public async down(): Promise<void> {
    // Forward-only consolidation (same contract as the other admin-api
    // drop/corrective migrations, e.g. DropImpersonationSessionsWriteGuard,
    // whose down() throws). The admin.announcements rows have been copied into
    // auth.announcements — the SSoT tenants read — and the admin entities /
    // controller / service are deleted. Re-creating the admin tables would
    // resurrect the exact write-only duplicate this migration removes and would
    // NOT restore the copied rows to admin, so a "rollback" here would silently
    // diverge the two stores again. Production runs DATABASE_MIGRATIONS_RUN with
    // a forward-only runner regardless.
    throw new Error(
      'Refusing to rollback 1801700000000-MigrateAnnouncementsToAuth: announcements ' +
        'were consolidated onto auth.announcements (the SSoT tenants read) and the ' +
        'admin duplicate was dropped after copy. This migration is forward-only.',
    );
  }
}
