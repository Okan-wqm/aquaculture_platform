import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddHrFinanceEntryDeletedBy — audit attribution for soft-deleted HR
 * finance rows.
 *
 * `hr_finance_entries` recorded `isDeleted` + `deletedAt` but not WHO
 * deleted the row. This adds the nullable `deletedBy` uuid column; the HR
 * delete handler now populates it.
 *
 * Blue-green safe: nullable column add (no table rewrite), idempotent, and
 * replay is a no-op. A short lock/statement timeout bounds the DDL.
 */
export class AddHrFinanceEntryDeletedBy1801900000000 implements MigrationInterface {
  name = 'AddHrFinanceEntryDeletedBy1801900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);
    await queryRunner.query(
      `ALTER TABLE "hr_finance_entries" ADD COLUMN IF NOT EXISTS "deletedBy" uuid NULL`,
    );
  }

  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows = (await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'hr_finance_entries'
          AND column_name = 'deletedBy'
      ) AS ok
    `)) as Array<{ ok: boolean }>;
    return rows[0]?.ok === true;
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "hr_finance_entries" DROP COLUMN IF EXISTS "deletedBy"`);
  }
}
