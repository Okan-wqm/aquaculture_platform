import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DropRetiredUserPermissions — retire the dead parallel permission catalog
 * `shared.user_permissions` (ADR-042, ORPHAN-HIGH-378).
 *
 * WHY: `shared.user_permissions` was a second, parallel RBAC catalog owned by
 * admin-api (JSONB checkbox permissions per user). The live, consumed RBAC
 * SSoT is the auth-service tenant RBAC
 * (`auth.tenant_role_permissions.panel_permissions`, surfaced via the auth
 * GraphQL subgraph and the tenant-admin frontend). A read-only scout across
 * every frontend surface (web shell, all federated modules incl. tenant-admin
 * and admin-panel, aquamobil, mcp) found ZERO callers of the five admin-api
 * REST endpoints backed by this table, and the live droplet held a single
 * stale row. Keeping the table alive keeps a second writable permission
 * authority nobody reads — the exact split-brain the DB audit flagged.
 *
 * The REST surface (`POST /users/tenant/invite`, `GET /users/permission-categories`,
 * `GET/PUT /users/:id/permissions`, `GET /users/tenant/users-with-permissions`),
 * the UserPermissions entity, its service and DTOs are deleted in the same PR;
 * platform-bootstrap stage 006 no longer creates the table.
 *
 * SAFETY SHAPE (archive-before-drop, idempotent — mirrors
 * 1801400000000-DropRetiredLegacyConfigStores):
 *   1. `admin.retired_config_backups` (jsonb archive, registered in
 *      MODULE_SCHEMAS['admin'].infrastructureTables) receives a full
 *      `to_jsonb(row)` copy of every source row BEFORE the drop.
 *   2. The archive step is guarded: it runs only when the source table still
 *      exists AND no archive rows for it exist yet (a partially-failed earlier
 *      run cannot double-archive on retry).
 *   3. A count assertion RAISEs (aborting the transaction) if the archive row
 *      count is below the source row count — the drop can never outrun the
 *      backup.
 *   4. `shared.user_permissions` carries FORCE ROW LEVEL SECURITY with the
 *      tenant-isolation policy; a migration session has no tenant GUC, so
 *      WITHOUT bypass both the archive SELECT and the count(*) would silently
 *      see zero rows and the count-assert could not protect the data. The DO
 *      block therefore sets `app.bypass_rls = 'on'` transaction-locally
 *      (set_config(..., true)) before touching the table.
 *   5. Both `shared` and `public` locations are handled — a database old
 *      enough to predate the public→shared move (which stage 006 no longer
 *      performs for this table) is cleaned up identically.
 */
export class DropRetiredUserPermissions1801500000000 implements MigrationInterface {
  name = 'DropRetiredUserPermissions1801500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // COMPLIANCE-WAIVER: ORPHAN-HIGH-378 shared.user_permissions retired per
    // ADR-042 (docs/adr/042-retire-shared-user-permissions.md) — dead parallel
    // permission catalog superseded by auth.tenant_role_permissions; rows are
    // count-assert archived into admin.retired_config_backups before the drop.

    // ── 1. The archive table (registered admin infrastructure; identical
    //       shape to 1801400000000 so retries and fresh DBs converge) ──
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
      CREATE INDEX IF NOT EXISTS "IDX_retired_config_backups_source"
        ON "admin"."retired_config_backups" ("sourceTable")
    `);

    // ── 2. Archive → verify → drop, per schema location ──
    for (const schema of ['shared', 'public']) {
      await queryRunner.query(`
        DO $$
        DECLARE
          source_count bigint;
          archived_count bigint;
        BEGIN
          IF EXISTS (
            SELECT 1 FROM pg_tables
            WHERE schemaname = '${schema}' AND tablename = 'user_permissions'
          ) THEN
            -- The table runs under FORCE RLS with a tenant-isolation policy;
            -- a no-tenant-GUC migration session would otherwise see 0 rows in
            -- BOTH the archive SELECT and the count assertion (silently losing
            -- data). Transaction-local bypass makes every row visible.
            PERFORM set_config('app.bypass_rls', 'on', true);

            -- Idempotent archive: a retried run after a partial failure must
            -- not duplicate rows already copied.
            IF NOT EXISTS (
              SELECT 1 FROM "admin"."retired_config_backups"
              WHERE "sourceTable" = '${schema}.user_permissions'
            ) THEN
              EXECUTE format(
                'INSERT INTO "admin"."retired_config_backups" ("sourceTable", "rowData")
                 SELECT %L, to_jsonb(t) FROM %I.user_permissions t',
                '${schema}.user_permissions', '${schema}'
              );
            END IF;

            EXECUTE format('SELECT count(*) FROM %I.user_permissions', '${schema}')
              INTO source_count;
            SELECT count(*) INTO archived_count
              FROM "admin"."retired_config_backups"
              WHERE "sourceTable" = '${schema}.user_permissions';
            IF archived_count < source_count THEN
              RAISE EXCEPTION
                'retired_config_backups holds % rows for %.user_permissions but the source still has % — refusing to drop before the archive is complete',
                archived_count, '${schema}', source_count;
            END IF;

            EXECUTE format(
              -- DESTRUCTIVE: archived above into admin.retired_config_backups (jsonb, count-verified); REST surface deleted in the same PR (ADR-042); rollback = restore rows from the archive
              'DROP TABLE IF EXISTS %I.user_permissions',
              '${schema}'
            );
          END IF;
        END $$;
      `);
    }
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Forward-only retirement (same contract as
    // 1801400000000-DropRetiredLegacyConfigStores): the catalog's REST surface
    // and entity are deleted, platform-bootstrap no longer creates the table,
    // and the auth tenant RBAC owns permissions. Recreating the table would
    // resurrect the split-brain this migration removes. The full row payloads
    // live in admin.retired_config_backups (jsonb) should anything ever need
    // recovering. Intentionally a no-op.
  }
}
