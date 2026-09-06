import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * RetireAdminCustomPlans — `admin.custom_plans` leaves the admin schema
 * (ADR-0013, BILLING-CRITICAL-002).
 *
 * WHY: a custom plan is a negotiated price. It decides what a subscription
 * costs and what its invoice will say, and billing is the sole writer of both
 * (D14). The admin table put every module's `subtotal` and every line item's
 * `unitPrice` and `total` inside `modules jsonb` — where a jsonb number IS an
 * IEEE-754 double and no CHECK can reach it — and `discountPercent` had no
 * bound at all. `MoveCustomPlans1802300000000` copied the rows into
 * `billing.custom_plans` + `custom_plan_modules` + `custom_plan_line_items`.
 *
 * SAFETY SHAPE: no archive table — the rows were COPIED and EXPANDED into
 * billing first (`SCHEMA_REGISTRY` runs billing at slot 8, admin at slot 11).
 * This migration re-verifies BY ID that every plan has a counterpart AND that
 * every module in every plan's jsonb array became a row, and RAISES rather
 * than dropping if one is missing, so a partially-applied deploy stops loudly
 * instead of destroying the only copy of a negotiated price.
 */
export class RetireAdminCustomPlans1809200000000 implements MigrationInterface {
  name = 'RetireAdminCustomPlans1809200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);

    await queryRunner.query(`
      DO $$
      DECLARE
        missing_plans bigint;
        missing_modules bigint;
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'admin' AND table_name = 'custom_plans'
        ) THEN
          RETURN;
        END IF;

        IF to_regclass('billing.custom_plans') IS NULL THEN
          RAISE EXCEPTION
            'billing.custom_plans does not exist — run the billing migrations (MoveCustomPlans1802300000000) before retiring the admin table';
        END IF;

        SELECT count(*) INTO missing_plans
          FROM "admin"."custom_plans" c
         WHERE NOT EXISTS (
           SELECT 1 FROM "billing"."custom_plans" b WHERE b."id" = c."id"
         );
        IF missing_plans > 0 THEN
          RAISE EXCEPTION
            '% admin.custom_plans rows have no counterpart in billing.custom_plans — refusing to drop the only copy',
            missing_plans;
        END IF;

        SELECT count(*) INTO missing_modules
          FROM "admin"."custom_plans" c
          CROSS JOIN LATERAL jsonb_array_elements(COALESCE(c."modules", '[]'::jsonb)) AS module
         WHERE module->>'moduleId' IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM "billing"."custom_plan_modules" m
              WHERE m."custom_plan_id" = c."id"
                AND m."module_id" = (module->>'moduleId')::uuid
           );
        IF missing_modules > 0 THEN
          RAISE EXCEPTION
            '% admin.custom_plans modules have no row in billing.custom_plan_modules — refusing to drop the only copy of a price',
            missing_modules;
        END IF;

        -- DESTRUCTIVE: every plan and every priced module verified present in billing.custom_plans / custom_plan_modules by id above; rollback = re-copy from billing (see this migration's docblock)
        DROP TABLE IF EXISTS "admin"."custom_plans";
      END $$;
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Forward-only. The rows are in billing.custom_plans and its two child
    // tables, which is now their only home; recreating the admin table would
    // reinstate the float pricing path ADR-0013 removes.
  }
}
