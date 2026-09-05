import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * RetireImpersonationAndDebugTools — the impersonation subsystem and the
 * debug-tools sub-module that lived under it are deleted (ADR-0007,
 * SEC-CRITICAL-057).
 *
 * WHY: the impersonation token had no consumer anywhere in the fleet — the
 * gateway never read it — so an "impersonation session" changed nothing about
 * what a request could do. The table carried the canonical WORM trigger while
 * six code paths issued UPDATE against it, so every session lifecycle write
 * failed at the database. Cross-tenant operator access is the kernel act-as
 * middleware (X-Act-As-Tenant, reason + ticket audited in shared.audit_logs);
 * this store was decoration around it.
 *
 * SAFETY SHAPE:
 *   - impersonation_sessions / impersonation_permissions are archived into
 *     `admin.retired_config_backups` (jsonb, count-verified) with the two
 *     token columns stripped — an archive must not carry bearer material.
 *   - the five debug-tools tables (debug_sessions, captured_queries,
 *     captured_api_calls, cache_entries_snapshot, feature_flag_overrides) are
 *     DISCARDED, not archived: they hold raw tenant SQL, request bodies and
 *     Set-Cookie headers captured during debugging, which no archive should
 *     retain (ADR-0007 consequences).
 *   - the impersonation_sessions WORM trigger + function are dropped with the
 *     table; the table leaves PROTECTED_TABLES because it no longer exists,
 *     not because the invariant relaxed (ADR-0008).
 */
export class RetireImpersonationAndDebugTools1808500000000 implements MigrationInterface {
  name = 'RetireImpersonationAndDebugTools1808500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "admin"."retired_config_backups" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "sourceTable" character varying(64) NOT NULL,
        "rowData" jsonb NOT NULL,
        "archivedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_retired_config_backups" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      DO $$
      DECLARE
        source_count bigint;
        archived_count bigint;
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'admin' AND table_name = 'impersonation_sessions'
        ) THEN
          IF NOT EXISTS (
            SELECT 1 FROM "admin"."retired_config_backups"
            WHERE "sourceTable" = 'impersonation_sessions'
          ) THEN
            INSERT INTO "admin"."retired_config_backups" ("sourceTable", "rowData")
            SELECT 'impersonation_sessions',
                   to_jsonb(t) - 'impersonationToken' - 'originalSessionToken'
              FROM "admin"."impersonation_sessions" t;
          END IF;

          SELECT count(*) INTO source_count FROM "admin"."impersonation_sessions";
          SELECT count(*) INTO archived_count
            FROM "admin"."retired_config_backups" WHERE "sourceTable" = 'impersonation_sessions';
          IF archived_count < source_count THEN
            RAISE EXCEPTION
              'retired_config_backups holds % rows for impersonation_sessions but the source still has % — refusing to drop before the archive is complete',
              archived_count, source_count;
          END IF;

          -- DESTRUCTIVE: WORM guard of a table that is dropped in this same block (ADR-0007/ADR-0008); rollback = the table itself is retired, nothing to guard
          DROP TRIGGER IF EXISTS trg_impersonation_sessions_prevent_update ON "admin"."impersonation_sessions";
          -- DESTRUCTIVE: rows archived above into admin.retired_config_backups (jsonb, token columns stripped, count-verified); rollback = restore rows from the archive
          DROP TABLE IF EXISTS "admin"."impersonation_sessions";
        END IF;

        -- DESTRUCTIVE: trigger function of the retired impersonation_sessions table (ADR-0007); rollback = none, its table no longer exists
        DROP FUNCTION IF EXISTS "admin".impersonation_sessions_prevent_update_or_delete();

        IF EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'admin' AND table_name = 'impersonation_permissions'
        ) THEN
          IF NOT EXISTS (
            SELECT 1 FROM "admin"."retired_config_backups"
            WHERE "sourceTable" = 'impersonation_permissions'
          ) THEN
            INSERT INTO "admin"."retired_config_backups" ("sourceTable", "rowData")
            SELECT 'impersonation_permissions', to_jsonb(t) FROM "admin"."impersonation_permissions" t;
          END IF;

          SELECT count(*) INTO source_count FROM "admin"."impersonation_permissions";
          SELECT count(*) INTO archived_count
            FROM "admin"."retired_config_backups" WHERE "sourceTable" = 'impersonation_permissions';
          IF archived_count < source_count THEN
            RAISE EXCEPTION
              'retired_config_backups holds % rows for impersonation_permissions but the source still has % — refusing to drop before the archive is complete',
              archived_count, source_count;
          END IF;

          -- DESTRUCTIVE: rows archived above into admin.retired_config_backups (jsonb, count-verified); rollback = restore rows from the archive
          DROP TABLE IF EXISTS "admin"."impersonation_permissions";
        END IF;
      END $$;
    `);

    // Debug captures are discarded on purpose: raw tenant SQL, request bodies
    // and Set-Cookie headers must not outlive the module that captured them.
    // -- DESTRUCTIVE: debug capture discarded by design (ADR-0007 — sensitive residue, never archived); rollback = none, the capturing module is deleted
    await queryRunner.query(`DROP TABLE IF EXISTS "admin"."captured_queries"`);
    // -- DESTRUCTIVE: debug capture discarded by design (ADR-0007 — sensitive residue, never archived); rollback = none, the capturing module is deleted
    await queryRunner.query(`DROP TABLE IF EXISTS "admin"."captured_api_calls"`);
    // -- DESTRUCTIVE: debug capture discarded by design (ADR-0007 — sensitive residue, never archived); rollback = none, the capturing module is deleted
    await queryRunner.query(`DROP TABLE IF EXISTS "admin"."cache_entries_snapshot"`);
    // -- DESTRUCTIVE: debug capture discarded by design (ADR-0007 — sensitive residue, never archived); rollback = none, the capturing module is deleted
    await queryRunner.query(`DROP TABLE IF EXISTS "admin"."feature_flag_overrides"`);
    // -- DESTRUCTIVE: debug capture discarded by design (ADR-0007 — sensitive residue, never archived); rollback = none, the capturing module is deleted
    await queryRunner.query(`DROP TABLE IF EXISTS "admin"."debug_sessions"`);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Forward-only retirement. Recreating the impersonation store would
    // reinstate a second cross-tenant authority beside the kernel act-as
    // middleware (ADR-0007). Session and permission payloads live in
    // admin.retired_config_backups; debug captures are gone by design.
  }
}
