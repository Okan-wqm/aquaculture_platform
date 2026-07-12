import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DropFarmDocuments1805300000000
 *
 * ORPHAN-HIGH-369 (FARMPLAT-HIGH-001, owner decision: DROP): `farm_documents`
 * was a fully built but UNWIRED document-management surface — entity + module +
 * migration + MinIO cleanup integration, with NO resolver/controller and NO
 * frontend reference. The platform owner chose to remove it rather than wire
 * it. This migration retires the physical table; the same PR deletes the
 * entity, its module, and the file-cleanup provider that read it.
 *
 * WHY current_schema-relative: the db-migrate fan-out runs this migration once
 * per schema (source `farm` pass first, then each `tenant_<uuid>` pass), and
 * every schema owns its OWN `farm_documents` clone AND its own local copies of
 * the three `farm_documents_*_enum` types (CreateFarmDocuments1800800000000
 * created them unqualified in each pass — verified against the live catalog:
 * tenant columns reference tenant-local types, not farm's). Each pass therefore
 * only ever touches objects inside current_schema(); there is NO cross-schema
 * DDL here (the #926 overreach class, HealBehindTenantQualityGrade docblock).
 * A behind tenant that has not yet run CreateFarmDocuments simply creates the
 * table in its own pass and drops it again here — both passes are local.
 *
 * Guards (data-loss safety — another environment might have rows even though
 * the audited live DB has 0 across farm + every tenant schema):
 *   (a) skip when the table does not exist in current_schema(),
 *   (b) RAISE EXCEPTION when the table has ANY rows — a non-empty clone means
 *       the "orphan, unwired" premise is false THERE and a human must look,
 *   (c) otherwise DROP TABLE (policies/indexes/triggers go with it).
 *
 * Enum reclaim: after the local table is gone, the three enum types in
 * current_schema() are dropped ONLY behind a pg_depend zero-dependents probe;
 * if anything still references a type (e.g. a clone created via
 * CREATE TABLE … LIKE cross-referencing the source type in some environment),
 * the drop is SKIPPED with a NOTICE — degrading to the sanctioned
 * orphaned-enum outcome (no-unguarded-drop-type-in-migration invariant) rather
 * than aborting the fan-out (the 2026-07-07 outage class).
 *
 * down() is an honest no-op: recreating a dropped orphan surface is not
 * meaningful — the authoritative recreate path would be a new forward
 * migration, not a rollback of this one (matches the forward-only stance of
 * sibling drop migrations in this directory).
 */
export class DropFarmDocuments1805300000000 implements MigrationInterface {
  name = 'DropFarmDocuments1805300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);

    // (a) skip if absent, (b) refuse on rows, (c) drop — every reference is
    // pinned to current_schema() so each fan-out pass is strictly self-scoped.
    await queryRunner.query(`
      DO $$
      DECLARE row_count bigint;
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.tables
           WHERE table_schema = current_schema() AND table_name = 'farm_documents'
        ) THEN
          RAISE NOTICE 'DropFarmDocuments: %.farm_documents absent — nothing to drop',
            current_schema();
          RETURN;
        END IF;

        EXECUTE format('SELECT count(*) FROM %I.farm_documents', current_schema())
          INTO row_count;
        IF row_count > 0 THEN
          RAISE EXCEPTION 'DropFarmDocuments: %.farm_documents holds % row(s); '
            'refusing to drop — the ORPHAN-HIGH-369 premise (unwired, empty '
            'surface) does not hold in this environment. Investigate before '
            'rerunning db-migrate.',
            current_schema(), row_count;
        END IF;

        -- DESTRUCTIVE: ORPHAN-HIGH-369 — orphan surface, zero rows asserted above;
        -- forward recreate path is a new migration, not a rollback.
        EXECUTE format('DROP TABLE IF EXISTS %I.farm_documents', current_schema());
      END $$;
    `);

    // Reclaim the three enum types ONLY when they live in current_schema() AND
    // no column anywhere still references them. Fails open to a skip (orphaned
    // enum is harmless and sanctioned), never to a fan-out abort.
    await queryRunner.query(`
      -- SHARED-ENUM-DROP-REVIEWED: per-schema local enums (live-catalog
      -- verified — each tenant clone references its OWN type copy, created by
      -- CreateFarmDocuments1800800000000 in that schema's own pass). The
      -- pg_depend probe below skips the drop when ANY dependent remains, so a
      -- cross-referenced type in another environment is left orphaned instead
      -- of aborting db-migrate.
      DO $$
      DECLARE enum_name text; dependents int;
      BEGIN
        FOREACH enum_name IN ARRAY ARRAY[
          'farm_documents_state_enum',
          'farm_documents_owner_type_enum',
          'farm_documents_scan_state_enum'
        ] LOOP
          IF NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_type t
            JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
            WHERE n.nspname = current_schema() AND t.typname = enum_name
          ) THEN
            CONTINUE;
          END IF;

          SELECT count(*)::int INTO dependents
            FROM pg_catalog.pg_depend d
            JOIN pg_catalog.pg_type t ON t.oid = d.refobjid
            JOIN pg_catalog.pg_namespace tn ON tn.oid = t.typnamespace
            JOIN pg_catalog.pg_attribute a ON a.attrelid = d.objid AND a.attnum = d.objsubid
           WHERE tn.nspname = current_schema() AND t.typname = enum_name;

          IF dependents > 0 THEN
            RAISE NOTICE 'DropFarmDocuments: %.% still has % dependent column(s) — leaving orphaned enum',
              current_schema(), enum_name, dependents;
            CONTINUE;
          END IF;

          EXECUTE format('DROP TYPE IF EXISTS %I.%I', current_schema(), enum_name);
        END LOOP;
      END $$;
    `);
  }

  /** The runner refuses the ledger row unless the local table is really gone. */
  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows = (await queryRunner.query(`
      SELECT NOT EXISTS (
        SELECT 1 FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_name = 'farm_documents'
      ) AS ok
    `)) as Array<{ ok: boolean }>;

    return rows[0]?.ok === true;
  }

  public async down(): Promise<void> {
    // Honest no-op. The dropped surface was an unwired orphan with zero rows
    // (guarded in up()); resurrecting it would require the entity/module code
    // deleted in the same PR, so the only meaningful recreate path is a new
    // forward migration alongside restored application code — not a rollback.
  }
}
