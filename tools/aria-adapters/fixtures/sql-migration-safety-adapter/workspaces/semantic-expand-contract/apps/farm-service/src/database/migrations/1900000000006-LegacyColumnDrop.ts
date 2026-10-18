import { MigrationInterface, QueryRunner } from 'typeorm';

// GRANDFATHERED (breaking_ddl_without_expand_contract must not be a finding):
// this migration is not in the case's change set, and the expand-contract
// marker is advisory, so an applied migration is recorded on its observation
// instead of asking for an edit to a migration production already ran.
export class LegacyColumnDrop1900000000006 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE ponds DROP COLUMN IF EXISTS "old_flag"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE ponds ADD COLUMN IF NOT EXISTS "old_flag" boolean`);
  }
}
