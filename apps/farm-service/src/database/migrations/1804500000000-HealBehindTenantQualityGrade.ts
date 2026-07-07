import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * HealBehindTenantQualityGrade1804500000000
 *
 * One-time repair for the DropOrphanQualityGradeEnum1804400000000 (#926)
 * regression. #926's source-only cross-schema loop dropped `qualityGrade` from
 * EVERY tenant clone in the FARM pass. A tenant that was BEHIND — its own fan-out
 * had not yet run AddHarvestNorwegianQualityClass1803100000000, which backfills
 * `qualityClass` FROM `qualityGrade` — was left with harvest_records carrying
 * NEITHER column. Its fan-out then aborts on AddHarvestNorwegianQualityClass
 * ("column qualityGrade does not exist"), blocking db-migrate for the whole
 * platform.
 *
 * Root lesson: a shared farm-schema enum's dependent column must be dropped in
 * EACH schema's OWN pass (after that schema's own AddHarvestNorwegianQualityClass
 * has run) — never cross-schema from the source pass. DropHarvestQualityGrade-
 * 1804300000000 already does that correctly; #926 overreached and this heals it.
 *
 * This SOURCE-ONLY migration runs in the farm pass (BEFORE the tenant fan-out)
 * and re-adds `qualityGrade` (baseline default) to exactly the damaged tenants,
 * so their pending AddHarvestNorwegianQualityClass can backfill quality_class and
 * DropHarvestQualityGrade can then drop qualityGrade in the tenant's own pass —
 * the healthy path. It touches ONLY tenants missing BOTH columns (the #926-damage
 * signature); healthy/caught-up tenants and fresh bootstraps are a no-op.
 * Idempotent, forward-only.
 *
 * TENANT_AWARE_SOURCE_SCHEMA_DDL_OK: the cross-schema column re-add + farm-
 * qualified enum re-create ARE the repair — the damage lives in tenant schemas
 * and only a source-pass step runs before the tenant fan-out that needs the
 * column back.
 */
export class HealBehindTenantQualityGrade1804500000000 implements MigrationInterface {
  name = 'HealBehindTenantQualityGrade1804500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    const current: Array<{ s: string }> = await queryRunner.query(`SELECT current_schema() AS s`);
    if (current[0]?.s !== 'farm') {
      return; // source-only: repair the damaged tenant state once, in the farm pass
    }

    // Idempotently ensure the shared enum exists — it is the type of the column
    // re-added below. CREATE TYPE has no IF NOT EXISTS form, so the canonical
    // DO $$ BEGIN … EXCEPTION WHEN duplicate_object … END $$ idiom is the
    // replay-safe idempotency guard (matches AddHarvestNorwegianQualityClass).
    await queryRunner.query(`
      DO $$
      BEGIN
        CREATE TYPE "farm"."harvest_records_qualitygrade_enum" AS ENUM (
          'premium', 'grade_a', 'grade_b', 'grade_c', 'reject'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await queryRunner.query(`
      DO $$
      DECLARE r record; healed int := 0;
      BEGIN
        FOR r IN
          SELECT n.nspname
            FROM pg_catalog.pg_namespace n
           WHERE n.nspname ~ '^tenant_[a-f0-9]{16}$'
        LOOP
          -- #926-damage signature: harvest_records exists but carries NEITHER the
          -- qualityGrade column (dropped prematurely) NOR the qualityClass column
          -- (its own AddHarvestNorwegianQualityClass never ran). Heal only those;
          -- a healthy behind-tenant still has qualityGrade and is left untouched.
          IF EXISTS (
              SELECT 1 FROM information_schema.tables
               WHERE table_schema = r.nspname AND table_name = 'harvest_records'
            )
            AND NOT EXISTS (
              SELECT 1 FROM information_schema.columns
               WHERE table_schema = r.nspname AND table_name = 'harvest_records'
                 AND column_name IN ('qualityGrade', 'qualityClass')
            )
          THEN
            EXECUTE format(
              'ALTER TABLE %I.harvest_records ADD COLUMN IF NOT EXISTS "qualityGrade" '
                || '"farm"."harvest_records_qualitygrade_enum" NOT NULL DEFAULT ''grade_a''',
              r.nspname
            );
            healed := healed + 1;
          END IF;
        END LOOP;
        RAISE NOTICE 'HealBehindTenantQualityGrade: re-added qualityGrade to % damaged tenant(s)', healed;
      END $$;
    `);
  }

  public async down(): Promise<void> {
    // Forward-only repair migration; nothing to roll back.
  }
}
