import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddPayrollCurrencyProjectionWatermark — monotonic ordering guard for the
 * currency projection.
 *
 * `hr_payroll_cost_settings.defaultCurrency` is projected from the farm
 * finance_settings SSoT by FinanceSettingsUpdatedConsumer. Without a
 * watermark, an out-of-order NATS redelivery could overwrite the current
 * currency with a stale value. This adds a nullable `currencyProjectedAt`
 * timestamp: the consumer applies an event only when its source timestamp
 * is newer than the recorded watermark, making the projection idempotent
 * and order-insensitive.
 *
 * Blue-green safe: nullable column add (no table rewrite), idempotent, and
 * replay is a no-op. A short lock/statement timeout bounds the DDL so a
 * deploy can never hold locks unboundedly.
 */
export class AddPayrollCurrencyProjectionWatermark1801800000000
  implements MigrationInterface
{
  name = 'AddPayrollCurrencyProjectionWatermark1801800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);
    await queryRunner.query(
      `ALTER TABLE "hr_payroll_cost_settings" ADD COLUMN IF NOT EXISTS "currencyProjectedAt" timestamptz NULL`,
    );
  }

  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows = (await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'hr_payroll_cost_settings'
          AND column_name = 'currencyProjectedAt'
      ) AS ok
    `)) as Array<{ ok: boolean }>;
    return rows[0]?.ok === true;
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "hr_payroll_cost_settings" DROP COLUMN IF EXISTS "currencyProjectedAt"`,
    );
  }
}
