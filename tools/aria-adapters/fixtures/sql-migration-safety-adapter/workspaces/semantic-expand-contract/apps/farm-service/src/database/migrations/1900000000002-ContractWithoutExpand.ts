import { MigrationInterface, QueryRunner } from 'typeorm';

import { ExpandContract } from '@aquaculture/backend-common';

// TRUE POSITIVE (expand_contract_missing_depends_on): a contract phase that
// names no expand phase, so nothing orders it after the code stopped reading
// the column.
@ExpandContract({ phase: 'contract' })
export class ContractWithoutExpand1900000000002 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE ponds DROP COLUMN IF EXISTS "obsolete_code"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE ponds ADD COLUMN IF NOT EXISTS "obsolete_code" varchar(16)`,
    );
  }
}
