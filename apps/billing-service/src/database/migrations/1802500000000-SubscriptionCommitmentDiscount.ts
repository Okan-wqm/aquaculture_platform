import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A subscription records the commitment discount it was SOLD at
 * (BILLING-CRITICAL-003).
 *
 * `billing.plan_cycle_prices.discount_percent` was written by the catalogue UI
 * and read back into the catalogue snapshot, but no pricing path read it: what
 * was actually charged came from a platform-wide constant. Two numbers claimed
 * to be the same thing and only one of them billed.
 *
 * Resolving that by having the invoice read the plan's row at invoice time
 * would be worse, not better — an operator editing a plan's annual terms would
 * silently re-price every customer already on it. A contracted term is
 * snapshotted at the sale, like the rest of `pricing`.
 *
 * Backfill: existing rows take the platform default for their cycle. That is
 * precisely the rate the previous commit (`invoice a longer cycle at the price
 * it was quoted`) began charging them, so the backfill records what is already
 * true rather than changing anyone's price.
 *
 * Blue-green safe: the column is added with a DEFAULT so an old process that
 * does not know the column keeps inserting valid rows; NOT NULL is set after
 * the backfill, in this same migration, because the default makes every future
 * insert well-formed regardless of which process writes it.
 */
export class SubscriptionCommitmentDiscount1802500000000 implements MigrationInterface {
  name = 'SubscriptionCommitmentDiscount1802500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "billing"."subscriptions"
        ADD COLUMN IF NOT EXISTS "commitment_discount_percent" NUMERIC(5,2) NOT NULL DEFAULT 0
    `);

    // The platform defaults, as percentages. Monthly commits to nothing.
    await queryRunner.query(`
      UPDATE "billing"."subscriptions"
         SET "commitment_discount_percent" = CASE "billing_cycle"
           WHEN 'quarterly' THEN 5
           WHEN 'semi_annual' THEN 10
           WHEN 'annual' THEN 15
           ELSE 0
         END
       WHERE "commitment_discount_percent" = 0
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.constraint_column_usage
           WHERE table_schema = 'billing'
             AND table_name = 'subscriptions'
             AND constraint_name = 'chk_billing_subscriptions_commitment_discount'
        ) THEN
          ALTER TABLE "billing"."subscriptions"
            ADD CONSTRAINT "chk_billing_subscriptions_commitment_discount"
            CHECK ("commitment_discount_percent" >= 0 AND "commitment_discount_percent" <= 100);
        END IF;
      END $$;
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Forward-only billing evidence: the column records the terms a customer
    // was sold. Dropping it would lose what they agreed to.
  }
}
