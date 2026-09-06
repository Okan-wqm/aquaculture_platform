import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * RetireAdminDiscountCatalogue — `admin.discount_codes` and
 * `admin.discount_redemptions` leave the admin schema (ADR-0013,
 * BILLING-CRITICAL-002).
 *
 * WHY: a discount decides what a subscription and an invoice are worth, and
 * billing is the sole writer of both (D14). Two catalogues meant two sets of
 * eligibility rules and money stored in a column that could not be
 * constrained; billing now owns the rows, admin authors them over
 * `request.billing.admin.*Discount*` and reads them back through a read-only
 * mapping.
 *
 * SAFETY SHAPE: no archive table here — the rows are not discarded, they were
 * COPIED into `billing.discount_codes` / `billing.discount_redemptions` by
 * `CreateDiscountCatalogue1802000000000`, which `SCHEMA_REGISTRY` runs first
 * (billing is slot 8, admin is slot 11). This migration re-verifies, row by
 * row and by id, that every source row has a counterpart in billing, and
 * RAISES rather than dropping if even one is missing. A partially-applied
 * deploy therefore stops loudly instead of destroying the only copy.
 */
export class RetireAdminDiscountCatalogue1808900000000 implements MigrationInterface {
  name = 'RetireAdminDiscountCatalogue1808900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);

    await queryRunner.query(`
      DO $$
      DECLARE
        missing_codes bigint;
        missing_redemptions bigint;
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'admin' AND table_name = 'discount_codes'
        ) THEN
          RETURN;
        END IF;

        IF to_regclass('billing.discount_codes') IS NULL THEN
          RAISE EXCEPTION
            'billing.discount_codes does not exist — run the billing migrations (CreateDiscountCatalogue1802000000000) before retiring the admin catalogue';
        END IF;

        SELECT count(*) INTO missing_codes
          FROM "admin"."discount_codes" a
         WHERE NOT EXISTS (
           SELECT 1 FROM "billing"."discount_codes" b WHERE b."id" = a."id"
         );
        IF missing_codes > 0 THEN
          RAISE EXCEPTION
            '% admin.discount_codes rows have no counterpart in billing.discount_codes — refusing to drop the only copy',
            missing_codes;
        END IF;

        SELECT count(*) INTO missing_redemptions
          FROM "admin"."discount_redemptions" a
         WHERE NOT EXISTS (
           SELECT 1 FROM "billing"."discount_redemptions" b WHERE b."id" = a."id"
         );
        IF missing_redemptions > 0 THEN
          RAISE EXCEPTION
            '% admin.discount_redemptions rows have no counterpart in billing.discount_redemptions — refusing to drop the only copy',
            missing_redemptions;
        END IF;

        -- DESTRUCTIVE: every row verified present in billing.discount_redemptions by id above; rollback = re-copy from billing (see this migration's docblock)
        DROP TABLE IF EXISTS "admin"."discount_redemptions";
        -- DESTRUCTIVE: every row verified present in billing.discount_codes by id above; rollback = re-copy from billing (see this migration's docblock)
        DROP TABLE IF EXISTS "admin"."discount_codes";
      END $$;
    `);

    await queryRunner.query(`DROP TYPE IF EXISTS "admin"."discount_codes_discounttype_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "admin"."discount_codes_appliesto_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "admin"."discount_codes_duration_enum"`);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Forward-only. The rows are in billing.discount_codes /
    // billing.discount_redemptions, which is now their only home; recreating
    // the admin tables would reinstate the second catalogue ADR-0013 removes.
  }
}
