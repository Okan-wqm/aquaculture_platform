import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DropRetiredLegacyConfigStores — remove the three admin config stores that were
 * retired to config-service (ORPHAN-HIGH-364 items 1-3).
 *
 * WHY: `admin.global_configs`, `admin.system_settings` and
 * `admin.tenant_configurations` are the "retired-to-config-service legacy trio":
 * their entity classes are UNdecorated (no `@Entity` — TypeORM never mapped
 * them), every write path returns 410 Gone pointing at config-service, and the
 * only live rows are pre-retirement seeds (live droplet: 0 / 35 / 1 rows).
 * Physically keeping them is the reverse-drift the DB audit flagged: tables the
 * registry/drift tooling cannot see.
 *
 * SAFETY SHAPE (archive-before-drop, per-table, idempotent):
 *   1. `admin.retired_config_backups` (jsonb archive, created IF NOT EXISTS and
 *      registered in MODULE_SCHEMAS['admin'].infrastructureTables) receives a
 *      full `to_jsonb(row)` copy of every source row BEFORE its table drops.
 *   2. The archive step is guarded per source table: it runs only when the
 *      source table still exists AND no archive rows for it exist yet (a
 *      partially-failed earlier run cannot double-archive on retry).
 *   3. A count assertion RAISEs (aborting the transaction) if the archive row
 *      count does not match the source row count — the drop can never outrun
 *      the backup.
 *   4. Environments built from the consolidated Baseline may lack
 *      `global_configs` entirely (only the archived pre-baseline chain created
 *      it) — every step is IF-EXISTS-guarded, so the migration is correct on
 *      fresh, behind, and current databases alike.
 *   5. The two `system_settings_*` enum types are dropped only behind a
 *      pg_depend/pg_attribute "no dependent columns remain" gate (the harvest
 *      quality-grade outage taught us an unguarded DROP TYPE aborts the whole
 *      run on any environment where a dependent still exists).
 */
export class DropRetiredLegacyConfigStores1801400000000 implements MigrationInterface {
  name = 'DropRetiredLegacyConfigStores1801400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. The archive table (registered admin infrastructure) ──
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

    // ── 2. Archive → verify → drop, per legacy table ──
    for (const table of ['global_configs', 'system_settings', 'tenant_configurations']) {
      await queryRunner.query(`
        DO $$
        DECLARE
          source_count bigint;
          archived_count bigint;
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'admin' AND table_name = '${table}'
          ) THEN
            -- Idempotent archive: a retried run after a partial failure must not
            -- duplicate rows already copied.
            IF NOT EXISTS (
              SELECT 1 FROM "admin"."retired_config_backups"
              WHERE "sourceTable" = '${table}'
            ) THEN
              EXECUTE format(
                'INSERT INTO "admin"."retired_config_backups" ("sourceTable", "rowData")
                 SELECT %L, to_jsonb(t) FROM "admin".%I t',
                '${table}', '${table}'
              );
            END IF;

            EXECUTE format('SELECT count(*) FROM "admin".%I', '${table}') INTO source_count;
            SELECT count(*) INTO archived_count
              FROM "admin"."retired_config_backups" WHERE "sourceTable" = '${table}';
            IF archived_count < source_count THEN
              RAISE EXCEPTION
                'retired_config_backups holds % rows for % but the source still has % — refusing to drop before the archive is complete',
                archived_count, '${table}', source_count;
            END IF;

            EXECUTE format(
              -- DESTRUCTIVE: archived above into admin.retired_config_backups (jsonb, count-verified); write paths already 410-Gone; rollback = restore rows from the archive
              'DROP TABLE IF EXISTS "admin".%I',
              '${table}'
            );
          END IF;
        END $$;
      `);
    }

    // ── 3. Orphaned enum types ──
    // SHARED-ENUM-DROP-REVIEWED: both enums are admin-schema-local (created by
    // the admin Baseline solely for system_settings); tenant clones never
    // reference admin types, and the pg_depend/pg_attribute gate below verifies
    // zero dependent columns remain before each drop.
    // Both types belonged solely to system_settings; after the drop above no
    // column can reference them. The gate still verifies via pg_attribute that
    // zero dependent columns remain anywhere before dropping, so an environment
    // with an unexpected dependent keeps the type and the run continues.
    for (const enumType of ['system_settings_valuetype_enum', 'system_settings_category_enum']) {
      await queryRunner.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1
            FROM pg_attribute a
            JOIN pg_class c ON c.oid = a.attrelid AND c.relkind = 'r'
            JOIN pg_type t ON t.oid = a.atttypid
            JOIN pg_namespace tn ON tn.oid = t.typnamespace
            WHERE tn.nspname = 'admin'
              AND t.typname = '${enumType}'
              AND a.attnum > 0
              AND NOT a.attisdropped
          ) THEN
            DROP TYPE IF EXISTS "admin"."${enumType}";
          END IF;
        END $$;
      `);
    }
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Forward-only retirement. The legacy stores' write paths have been 410-Gone
    // for multiple releases and config-service owns configuration now; the full
    // row payloads live in admin.retired_config_backups (jsonb) should anything
    // ever need recovering. Recreating retired tables would resurrect the exact
    // reverse-drift this migration removes. Intentionally a no-op.
  }
}
