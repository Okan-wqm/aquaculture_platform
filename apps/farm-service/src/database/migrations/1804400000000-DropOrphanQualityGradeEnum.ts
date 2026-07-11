import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DropOrphanQualityGradeEnum1804400000000
 *
 * Completes DropHarvestQualityGrade1804300000000. That migration dropped the
 * `qualityGrade` COLUMN from farm + every tenant clone (tenant-clone-safe, via
 * the per-schema fan-out) but deliberately LEFT the enum type
 * `farm.harvest_records_qualitygrade_enum`. WHY it had to leave it: the enum is a
 * SINGLE farm-schema type that every tenant clone cross-references — `CREATE
 * TABLE … LIKE … INCLUDING ALL` shares the type, it does NOT clone it — so the
 * shared type cannot be dropped inside the source-first fan-out (the farm pass
 * runs before tenant passes, and a tenant pass cannot even see a farm-schema
 * type). A per-schema fan-out simply cannot express "clear all N+1 references,
 * then drop one shared object".
 *
 * This migration reclaims that orphaned type in a SOURCE-ONLY pass — the only
 * place the shared type is visible AND the only point at which every dependent
 * column across all schemas can be guaranteed gone. It does its work in the farm
 * (source) pass and no-ops in every tenant pass. Idempotent, forward-only.
 *
 * TENANT_AWARE_SOURCE_SCHEMA_DDL_OK: the cross-schema column clear + the
 * farm-qualified DROP TYPE are the whole point — the shared enum's dependents
 * live in tenant schemas and the fan-out cannot reach across them in order.
 */
export class DropOrphanQualityGradeEnum1804400000000 implements MigrationInterface {
  name = 'DropOrphanQualityGradeEnum1804400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    // Source-only: the shared type lives in farm; no-op in every tenant pass.
    const current: Array<{ s: string }> = await queryRunner.query(`SELECT current_schema() AS s`);
    if (current[0]?.s !== 'farm') {
      return;
    }

    // Clear the dependent column from the source schema AND every tenant clone so
    // nothing references the shared enum. 1804300000000 already drops these via
    // the fan-out, but its tenant passes run AFTER this farm pass inside the same
    // db-migrate invocation, so clear any straggler here. Idempotent; format('%I')
    // safely quotes the catalog-derived, regex-validated schema names.
    await queryRunner.query(`
      DO $$
      DECLARE r record;
      BEGIN
        FOR r IN
          SELECT n.nspname
            FROM pg_catalog.pg_namespace n
           WHERE n.nspname = 'farm' OR n.nspname ~ '^tenant_[a-f0-9]{16}$'
        LOOP
          EXECUTE format(
            'ALTER TABLE IF EXISTS %I.%I DROP COLUMN IF EXISTS %I',
            r.nspname, 'harvest_records', 'qualityGrade'
          );
        END LOOP;
      END $$;
    `);

    // Assert no column anywhere still depends on the shared type before dropping.
    const dependents: Array<{ n: number }> = await queryRunner.query(`
      -- SHARED-ENUM-DROP-REVIEWED: every dependent column across farm + all tenant
      -- clones is cleared above; this pg_depend probe fails closed if one remains.
      SELECT count(*)::int AS n
        FROM pg_catalog.pg_depend d
        JOIN pg_catalog.pg_type t ON t.oid = d.refobjid
        JOIN pg_catalog.pg_namespace tn ON tn.oid = t.typnamespace
        JOIN pg_catalog.pg_attribute a ON a.attrelid = d.objid AND a.attnum = d.objsubid
       WHERE tn.nspname = 'farm' AND t.typname = 'harvest_records_qualitygrade_enum'
    `);
    if ((dependents[0]?.n ?? 0) > 0) {
      throw new Error(
        `harvest_records_qualitygrade_enum still has ${dependents[0]?.n} dependent column(s) ` +
          `after the cross-schema clear; refusing DROP TYPE`,
      );
    }

    await queryRunner.query(`DROP TYPE IF EXISTS "farm"."harvest_records_qualitygrade_enum"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    // Source-only rollback: re-create the shared type so 1804300000000.down() can
    // re-add the column that references it. Values are not recovered (forward-only).
    const current: Array<{ s: string }> = await queryRunner.query(`SELECT current_schema() AS s`);
    if (current[0]?.s !== 'farm') {
      return;
    }
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_type t
          JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = 'farm' AND t.typname = 'harvest_records_qualitygrade_enum'
        ) THEN
          CREATE TYPE "farm"."harvest_records_qualitygrade_enum" AS ENUM (
            'premium', 'grade_a', 'grade_b', 'grade_c', 'reject'
          );
        END IF;
      END $$;
    `);
  }
}
