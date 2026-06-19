import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DBR-MEDIUM-002
 *
 * Scheduled plan-change snapshot fields are part of the billing audit trail.
 * The entity and database must agree on uuid/string widths instead of relying
 * on TypeORM inference or unbounded varchar.
 */
export class ScheduledPlanChangeColumnTypes1800500000000
  implements MigrationInterface
{
  name = 'ScheduledPlanChangeColumnTypes1800500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);

    await this.assertUuidCompatible(queryRunner, 'currentPlanId');
    await this.assertUuidCompatible(queryRunner, 'newPlanId');
    await this.assertVarcharLengthCompatible(queryRunner, 'currentPlanTier', 50);
    await this.assertVarcharLengthCompatible(queryRunner, 'newPlanTier', 50);
    await this.assertVarcharLengthCompatible(queryRunner, 'newPlanName', 255);

    await this.convertToUuid(queryRunner, 'currentPlanId');
    await this.convertToUuid(queryRunner, 'newPlanId');
    await this.convertToVarchar(queryRunner, 'currentPlanTier', 50);
    await this.convertToVarchar(queryRunner, 'newPlanTier', 50);
    await this.convertToVarchar(queryRunner, 'newPlanName', 255);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);

    await this.convertToUnboundedVarchar(queryRunner, 'newPlanName');
    await this.convertToUnboundedVarchar(queryRunner, 'newPlanTier');
    await this.convertToUnboundedVarchar(queryRunner, 'currentPlanTier');
  }

  private async assertUuidCompatible(
    queryRunner: QueryRunner,
    column: string,
  ): Promise<void> {
    this.assertSafeIdentifier(column);
    await queryRunner.query(`
      DO $$
      DECLARE invalid_count int;
      BEGIN
        IF to_regclass('billing.scheduled_plan_changes') IS NULL THEN
          RETURN;
        END IF;

        SELECT count(*)::int
          INTO invalid_count
          FROM "billing"."scheduled_plan_changes"
         WHERE "${column}" IS NOT NULL
           AND "${column}"::text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

        IF invalid_count > 0 THEN
          RAISE EXCEPTION 'Cannot convert billing.scheduled_plan_changes.% to uuid: % non-UUID row(s) exist',
            '${column}', invalid_count;
        END IF;
      END
      $$;
    `);
  }

  private async convertToUuid(
    queryRunner: QueryRunner,
    column: string,
  ): Promise<void> {
    this.assertSafeIdentifier(column);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
            FROM information_schema.columns
           WHERE table_schema = 'billing'
             AND table_name = 'scheduled_plan_changes'
             AND column_name = '${column}'
             AND udt_name <> 'uuid'
        ) THEN
          ALTER TABLE "billing"."scheduled_plan_changes"
            ALTER COLUMN "${column}" TYPE uuid USING "${column}"::uuid;
        END IF;
      END
      $$;
    `);
  }

  private async assertVarcharLengthCompatible(
    queryRunner: QueryRunner,
    column: string,
    length: number,
  ): Promise<void> {
    this.assertSafeIdentifier(column);
    await queryRunner.query(`
      DO $$
      DECLARE invalid_count int;
      BEGIN
        IF to_regclass('billing.scheduled_plan_changes') IS NULL THEN
          RETURN;
        END IF;

        SELECT count(*)::int
          INTO invalid_count
          FROM "billing"."scheduled_plan_changes"
         WHERE "${column}" IS NOT NULL
           AND length("${column}"::text) > ${length};

        IF invalid_count > 0 THEN
          RAISE EXCEPTION 'Cannot narrow billing.scheduled_plan_changes.% to varchar(%): % over-length row(s) exist',
            '${column}', ${length}, invalid_count;
        END IF;
      END
      $$;
    `);
  }

  private async convertToVarchar(
    queryRunner: QueryRunner,
    column: string,
    length: number,
  ): Promise<void> {
    this.assertSafeIdentifier(column);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
            FROM information_schema.columns
           WHERE table_schema = 'billing'
             AND table_name = 'scheduled_plan_changes'
             AND column_name = '${column}'
        ) THEN
          ALTER TABLE "billing"."scheduled_plan_changes"
            ALTER COLUMN "${column}" TYPE varchar(${length}) USING "${column}"::varchar(${length});
        END IF;
      END
      $$;
    `);
  }

  private async convertToUnboundedVarchar(
    queryRunner: QueryRunner,
    column: string,
  ): Promise<void> {
    this.assertSafeIdentifier(column);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
            FROM information_schema.columns
           WHERE table_schema = 'billing'
             AND table_name = 'scheduled_plan_changes'
             AND column_name = '${column}'
        ) THEN
          ALTER TABLE "billing"."scheduled_plan_changes"
            ALTER COLUMN "${column}" TYPE varchar USING "${column}"::varchar;
        END IF;
      END
      $$;
    `);
  }

  private assertSafeIdentifier(value: string): void {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
      throw new Error(`Unsafe billing migration identifier: ${value}`);
    }
  }
}
