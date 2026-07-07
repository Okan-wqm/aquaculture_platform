import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddSiteRegulatoryIdentity1802600000000
 *
 * The Norwegian locality number (lokalitetsnummer) is an intrinsic attribute
 * of a site, but it lived only as a side mapping in
 * regulatory_settings.site_locality_mappings (RPT-015). Adds it to `sites`
 * (plus an org-number override for sites operated under a different entity)
 * and backfills from the jsonb mapping. During the transition the code reads
 * sites-first with a jsonb fallback and writes through to BOTH; the jsonb
 * column is dropped in Phase 4 after a release soak.
 *
 * current_schema-relative (farm + every tenant_<uuid>), idempotent,
 * blue-green safe (additive; old code keeps reading the jsonb it owns).
 */
export class AddSiteRegulatoryIdentity1802600000000 implements MigrationInterface {
  name = 'AddSiteRegulatoryIdentity1802600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(
      `ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "lokalitetsnummer" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "organisationNumberOverride" character varying(20)`,
    );

    // Official range from the Akvakulturregisteret (5-digit numeric).
    // DO-block guard: PG has no IF NOT EXISTS for ADD CONSTRAINT (R11).
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "sites" ADD CONSTRAINT "CHK_sites_lokalitetsnummer_range"
          CHECK ("lokalitetsnummer" IS NULL OR ("lokalitetsnummer" BETWEEN 10000 AND 99999));
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_sites_tenant_lokalitetsnummer"
        ON "sites" ("tenantId", "lokalitetsnummer")
        WHERE "lokalitetsnummer" IS NOT NULL
    `);

    // Backfill from the settings jsonb mapping (siteId → lokalitetsnummer).
    // Both tables live in the same (pinned) schema, so the join is local.
    await queryRunner.query(`
      UPDATE "sites" s
         SET "lokalitetsnummer" = mapping.value::int
        FROM "regulatory_settings" rs,
             jsonb_each_text(COALESCE(rs."site_locality_mappings", '{}'::jsonb)) AS mapping
       WHERE mapping.key = s.id::text
         AND rs."tenant_id" = s."tenantId"
         AND s."lokalitetsnummer" IS NULL
         AND mapping.value ~ '^[0-9]+$'
         AND mapping.value::int BETWEEN 10000 AND 99999
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_sites_tenant_lokalitetsnummer"`);
    await queryRunner.query(
      `ALTER TABLE "sites" DROP CONSTRAINT IF EXISTS "CHK_sites_lokalitetsnummer_range"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sites" DROP COLUMN IF EXISTS "organisationNumberOverride"`,
    );
    await queryRunner.query(`ALTER TABLE "sites" DROP COLUMN IF EXISTS "lokalitetsnummer"`);
  }
}
