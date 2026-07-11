import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DropSiteLocalityMappingsJsonb1804200000000
 *
 * Phase 4 dedup (RPT-015): the site → lokalitetsnummer mapping is now an
 * intrinsic Site attribute (sites.lokalitetsnummer, added + backfilled by
 * AddSiteRegulatoryIdentity1802600000000), which is the SSoT read by
 * getEffectiveSiteLocalityMappings and written through on saveSettings. The
 * legacy regulatory_settings.site_locality_mappings jsonb was the transition
 * duplicate and is now removed — no reader/writer touches it in the same PR.
 *
 * current_schema-relative (fans out to farm + every tenant schema), idempotent,
 * forward-only. Dropping the column takes only a brief ACCESS EXCLUSIVE lock;
 * down() restores the (empty) NOT NULL DEFAULT '{}' shape — the values live on
 * the site rows.
 */
export class DropSiteLocalityMappingsJsonb1804200000000 implements MigrationInterface {
  name = 'DropSiteLocalityMappingsJsonb1804200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(
      `ALTER TABLE "regulatory_settings" DROP COLUMN IF EXISTS "site_locality_mappings"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(
      `ALTER TABLE "regulatory_settings" ADD COLUMN IF NOT EXISTS "site_locality_mappings" jsonb NOT NULL DEFAULT '{}'`,
    );
  }
}
