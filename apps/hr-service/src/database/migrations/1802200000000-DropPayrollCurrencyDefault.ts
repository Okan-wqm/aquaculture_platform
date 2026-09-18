import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DropPayrollCurrencyDefault — remove the last hardcoded currency literal on
 * the payroll write path (HR-HIGH-008).
 *
 * `payrolls.currency` carried `DEFAULT 'USD'` from the Baseline. The platform
 * default is NOK (`HR_PLATFORM_DEFAULT_CURRENCY`) and the real answer is
 * per-tenant, projected from the farm `finance_settings` SSoT into
 * `hr_payroll_cost_settings`. A column default cannot know the tenant, so
 * whatever it holds is wrong for someone; the only correct default is none.
 *
 * `CreatePayrollHandler` is the single writer of this table and now resolves
 * the currency through `PayrollCostSettingsService.getDefaultCurrencyInTx`
 * before the INSERT, so nothing relies on the default any more. Dropping it
 * makes a currency-less payroll row structurally impossible (the column stays
 * NOT NULL) rather than silently USD-denominated.
 *
 * Blue-green safe in both directions: the previous release also always
 * supplied a currency on INSERT (it supplied the `'USD'` literal), so a
 * pre-deploy pod cannot hit a NOT NULL violation against the defaultless
 * column. Existing rows are untouched — this changes only what a future
 * INSERT that omits the column does, and there is no such INSERT.
 *
 * Idempotent: `DROP DEFAULT` on a column with no default is a no-op, so a
 * replay against an already-migrated schema succeeds unchanged.
 */
export class DropPayrollCurrencyDefault1802200000000 implements MigrationInterface {
  name = 'DropPayrollCurrencyDefault1802200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);
    await queryRunner.query(`ALTER TABLE "payrolls" ALTER COLUMN "currency" DROP DEFAULT`);
  }

  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows = (await queryRunner.query(`
      SELECT column_default IS NULL AS ok
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'payrolls'
        AND column_name = 'currency'
    `)) as Array<{ ok: boolean }>;
    return rows[0]?.ok === true;
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "payrolls" ALTER COLUMN "currency" SET DEFAULT 'USD'`);
  }
}
