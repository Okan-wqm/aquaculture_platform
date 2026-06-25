import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * W1.1 (ADR-016 / BILLING-CRITICAL-001): denormalize the Stripe product/price
 * identifiers onto billing.plans so create-subscription resolves a real Stripe
 * price from billing's own SSoT (D14) instead of a cross-service hot-path call
 * to admin.plan_definitions.
 *
 * Blue-green safe: both columns are nullable — existing plans (created before
 * Stripe go-live) keep NULL, and the money handlers fail-closed when a price is
 * required but absent. No backfill / NOT NULL step in this migration.
 */
export class AddPlanStripeIdentifiers1801100000000 implements MigrationInterface {
  name = 'AddPlanStripeIdentifiers1801100000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "billing"."plans" ADD COLUMN IF NOT EXISTS "stripe_product_id" character varying(255)`,
    );
    await queryRunner.query(
      `ALTER TABLE "billing"."plans" ADD COLUMN IF NOT EXISTS "stripe_price_ids" jsonb`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "billing"."plans" DROP COLUMN IF EXISTS "stripe_price_ids"`,
    );
    await queryRunner.query(
      `ALTER TABLE "billing"."plans" DROP COLUMN IF EXISTS "stripe_product_id"`,
    );
  }
}
