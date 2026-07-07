import { MigrationInterface, QueryRunner } from 'typeorm';

import { OFFICIAL_SPECIES_CODES } from '../../species/data/official-species-codes';

/**
 * AddSpeciesOfficialCode1802500000000
 *
 * Norwegian regulatory reports key species by an official artskode (FAO
 * 3-alpha for grow-out, USB/BER/GRO/BNB for cleaner fish) — the internal
 * free-text `species.code` is not that. Adds `officialCode` and backfills it
 * from the seed-map SSoT (species/data/official-species-codes.ts) by
 * scientific name. Nullable BY DESIGN: tenants legitimately keep
 * non-reportable species; report assembly fails closed on unmapped
 * reportable species (blocking MANUAL_REQUIRED pointing at Setup → Species).
 *
 * current_schema-relative: db-migrate fans farm migrations out with
 * search_path pinned to `farm` and each `tenant_<uuid>`. Idempotent,
 * forward-only, blue-green safe (pure additive column).
 */
export class AddSpeciesOfficialCode1802500000000 implements MigrationInterface {
  name = 'AddSpeciesOfficialCode1802500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(
      `ALTER TABLE "species" ADD COLUMN IF NOT EXISTS "officialCode" character varying(16)`,
    );

    for (const entry of OFFICIAL_SPECIES_CODES) {
      await queryRunner.query(
        `UPDATE "species"
            SET "officialCode" = $1
          WHERE lower("scientificName") = lower($2)
            AND "officialCode" IS NULL`,
        [entry.officialCode, entry.scientificName],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(`ALTER TABLE "species" DROP COLUMN IF EXISTS "officialCode"`);
  }
}
