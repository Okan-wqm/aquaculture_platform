import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * RetireAdminModulePricing — `admin.module_pricing` leaves the admin schema
 * (ADR-0013, BILLING-CRITICAL-002).
 *
 * WHY: a module's price decides what a subscription and an invoice are worth,
 * and billing is the sole writer of both (D14). The sheet also carried its
 * metrics and tier multipliers as `number`s inside two `jsonb` columns, where
 * no CHECK could reach them, and four separate places multiplied it out in
 * floats. `billing.module_prices` + `module_price_metrics` +
 * `module_price_tier_multipliers` replace it, and the multiplication happens
 * once, in billing, in exact decimals.
 *
 * SAFETY SHAPE: no archive table — the rows were COPIED and EXPANDED into
 * billing by `CreateModulePriceSheet1802100000000`, which `SCHEMA_REGISTRY`
 * runs first (billing is slot 8, admin is slot 11). This migration re-verifies,
 * by id, that every source sheet has a counterpart AND that every metric in
 * every source sheet's jsonb array became a row, and RAISES rather than
 * dropping if one is missing. A partially-applied deploy stops loudly instead
 * of destroying the only copy of a price.
 */
export class RetireAdminModulePricing1809000000000 implements MigrationInterface {
  name = 'RetireAdminModulePricing1809000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);

    await queryRunner.query(`
      DO $$
      DECLARE
        missing_sheets bigint;
        missing_metrics bigint;
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'admin' AND table_name = 'module_pricing'
        ) THEN
          RETURN;
        END IF;

        IF to_regclass('billing.module_prices') IS NULL THEN
          RAISE EXCEPTION
            'billing.module_prices does not exist — run the billing migrations (CreateModulePriceSheet1802100000000) before retiring the admin price sheet';
        END IF;

        SELECT count(*) INTO missing_sheets
          FROM "admin"."module_pricing" p
         WHERE NOT EXISTS (
           SELECT 1 FROM "billing"."module_prices" b WHERE b."id" = p."id"
         );
        IF missing_sheets > 0 THEN
          RAISE EXCEPTION
            '% admin.module_pricing rows have no counterpart in billing.module_prices — refusing to drop the only copy',
            missing_sheets;
        END IF;

        SELECT count(*) INTO missing_metrics
          FROM "admin"."module_pricing" p
          CROSS JOIN LATERAL jsonb_array_elements(COALESCE(p."pricingMetrics", '[]'::jsonb)) AS metric
         WHERE NOT EXISTS (
           SELECT 1 FROM "billing"."module_price_metrics" m
            WHERE m."module_price_id" = p."id" AND m."metric_type" = metric->>'type'
         );
        IF missing_metrics > 0 THEN
          RAISE EXCEPTION
            '% admin.module_pricing metrics have no row in billing.module_price_metrics — refusing to drop the only copy of a price',
            missing_metrics;
        END IF;

        -- DESTRUCTIVE: every sheet and every metric verified present in billing.module_prices / module_price_metrics by id above; rollback = re-copy from billing (see this migration's docblock)
        DROP TABLE IF EXISTS "admin"."module_pricing";
      END $$;
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Forward-only. The rows are in billing.module_prices and its two child
    // tables, which is now their only home; recreating the admin table would
    // reinstate the second price sheet ADR-0013 removes.
  }
}
