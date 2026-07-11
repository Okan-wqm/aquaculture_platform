import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddWelfareLiceCheckConstraints1804900000000
 *
 * DATA-LOW-007 — welfare_assessments and lice_counts had no DB-level range
 * guards, so a bad write (a mobile capture bug, a raw path) could store a
 * welfare score outside 0–3 or a negative lice count and it would flow straight
 * into a Mattilsynet report. Add the invariants at the database, the strongest
 * tier: welfare gill/fin/wound/deformity scores must be 0–3, lice stage counts
 * must be non-negative, and both tables require a positive fishSampled.
 *
 * Per-tenant tables → current_schema-relative (fans out to farm + every
 * tenant_<uuid>). Each ALTER is table-presence guarded (a schema without the
 * table is a no-op) and duplicate_object guarded (idempotent — PG has no
 * IF NOT EXISTS for ADD CONSTRAINT, R11). Forward-only.
 */
export class AddWelfareLiceCheckConstraints1804900000000 implements MigrationInterface {
  name = 'AddWelfareLiceCheckConstraints1804900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // One DO $$ … EXCEPTION WHEN duplicate_object per ADD CONSTRAINT (R11 needs
    // the guard adjacent to each ADD CONSTRAINT); each also table-presence
    // guarded so a schema without the table is a no-op.
    await queryRunner.query(`
      DO $$ BEGIN
        IF to_regclass(current_schema() || '.welfare_assessments') IS NOT NULL THEN
          ALTER TABLE "welfare_assessments" ADD CONSTRAINT "CHK_welfare_scores_0_3"
            CHECK ("gillScore" BETWEEN 0 AND 3 AND "finScore" BETWEEN 0 AND 3
               AND "woundScore" BETWEEN 0 AND 3 AND "deformityScore" BETWEEN 0 AND 3);
        END IF;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        IF to_regclass(current_schema() || '.welfare_assessments') IS NOT NULL THEN
          ALTER TABLE "welfare_assessments" ADD CONSTRAINT "CHK_welfare_fishSampled_pos"
            CHECK ("fishSampled" > 0);
        END IF;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        IF to_regclass(current_schema() || '.lice_counts') IS NOT NULL THEN
          ALTER TABLE "lice_counts" ADD CONSTRAINT "CHK_lice_counts_nonneg"
            CHECK ("adultFemaleLice" >= 0 AND "mobileLice" >= 0 AND "attachedLice" >= 0);
        END IF;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        IF to_regclass(current_schema() || '.lice_counts') IS NOT NULL THEN
          ALTER TABLE "lice_counts" ADD CONSTRAINT "CHK_lice_counts_fishSampled_pos"
            CHECK ("fishSampled" > 0);
        END IF;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);
  }

  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    // Where each table exists in the active schema, its CHECK constraints exist.
    const rows = (await queryRunner.query(`
      WITH expected(tbl, con) AS (VALUES
        ('welfare_assessments', 'CHK_welfare_scores_0_3'),
        ('welfare_assessments', 'CHK_welfare_fishSampled_pos'),
        ('lice_counts', 'CHK_lice_counts_nonneg'),
        ('lice_counts', 'CHK_lice_counts_fishSampled_pos'))
      SELECT COUNT(*)::text AS missing
        FROM expected x
       WHERE to_regclass(current_schema() || '.' || x.tbl) IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
             FROM pg_constraint c
             JOIN pg_class t ON t.oid = c.conrelid
             JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = current_schema()
              AND t.relname = x.tbl
              AND c.conname = x.con
         )
    `)) as Array<{ missing: string }>;

    return rows[0]?.missing === '0';
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        IF to_regclass(current_schema() || '.welfare_assessments') IS NOT NULL THEN
          ALTER TABLE "welfare_assessments" DROP CONSTRAINT IF EXISTS "CHK_welfare_scores_0_3";
          ALTER TABLE "welfare_assessments" DROP CONSTRAINT IF EXISTS "CHK_welfare_fishSampled_pos";
        END IF;
        IF to_regclass(current_schema() || '.lice_counts') IS NOT NULL THEN
          ALTER TABLE "lice_counts" DROP CONSTRAINT IF EXISTS "CHK_lice_counts_nonneg";
          ALTER TABLE "lice_counts" DROP CONSTRAINT IF EXISTS "CHK_lice_counts_fishSampled_pos";
        END IF;
      END $$;
    `);
  }
}
