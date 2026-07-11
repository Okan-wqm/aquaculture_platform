import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DropRegulatorySettingsSlaughterApprovalNumber1804100000000
 *
 * Phase 4 dedup (RPT-007): the slaughter approval number (godkjenningsnummer)
 * now lives ONLY in the slaughter_facilities catalog (CreateSlaughterFacilities
 * 1803450000000, which backfilled the default facility from this column). The
 * legacy regulatory_settings.slaughter_approval_number column was the transition
 * fallback and is now removed — the assembler, resolver, DTOs and settings form
 * no longer read or write it in the same PR, so no live reader remains.
 *
 * current_schema-relative (fans out to farm + every tenant schema), idempotent,
 * forward-only. Dropping a nullable column takes only a brief ACCESS EXCLUSIVE
 * lock; the down() restores the (empty) column so a rollback re-exposes the
 * shape without data (the values live in the facility catalog).
 */
export class DropRegulatorySettingsSlaughterApprovalNumber1804100000000
  implements MigrationInterface
{
  name = 'DropRegulatorySettingsSlaughterApprovalNumber1804100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(
      `ALTER TABLE "regulatory_settings" DROP COLUMN IF EXISTS "slaughter_approval_number"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(
      `ALTER TABLE "regulatory_settings" ADD COLUMN IF NOT EXISTS "slaughter_approval_number" character varying(50)`,
    );
  }
}
