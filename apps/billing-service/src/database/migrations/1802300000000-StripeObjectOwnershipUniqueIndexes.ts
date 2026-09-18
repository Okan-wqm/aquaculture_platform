import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SECREV-CRITICAL-001 cure (structural half).
 *
 * Inbound Stripe webhooks now resolve the owning tenant from the local row
 * that owns the Stripe object rather than from attacker-writable Stripe
 * metadata. That resolution is a `findOne` keyed on a single Stripe
 * identifier column, so it is only sound while that column is single-valued:
 * with a duplicate, `findOne` would pick an arbitrary row and the handler
 * would write into the wrong tenant's billing records.
 *
 * `payments.stripe_payment_intent_id` already carried this constraint
 * (`IDX_payment_stripe_pi`, baseline). The other three resolution keys carried
 * no index at all — neither a uniqueness guarantee nor a lookup path, so every
 * webhook resolution would also have been a sequential scan.
 *
 * Partial (`WHERE ... IS NOT NULL`) so the columns stay nullable: local-only
 * invoices, non-Stripe payment methods, and subscriptions that never reached
 * Stripe keep NULL and do not contend for the unique slot.
 *
 * Blue-green: additive, no column or type change; the old code path does not
 * write these columns at all (the webhook handlers returned early before any
 * write), so no backfill step is required. If a duplicate somehow exists the
 * CREATE fails and the deploy stops — the correct fail-closed outcome for a
 * financial-record integrity constraint; resolve the duplicate rows first.
 */
export class StripeObjectOwnershipUniqueIndexes1802300000000 implements MigrationInterface {
  name = 'StripeObjectOwnershipUniqueIndexes1802300000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_payment_stripe_charge" ON "billing"."payments" ("stripe_charge_id") WHERE "stripe_charge_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_subscription_stripe_sub" ON "billing"."subscriptions" ("stripe_subscription_id") WHERE "stripe_subscription_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_invoice_stripe_invoice" ON "billing"."invoices" ("stripe_invoice_id") WHERE "stripe_invoice_id" IS NOT NULL`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "billing"."IDX_invoice_stripe_invoice"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "billing"."IDX_subscription_stripe_sub"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "billing"."IDX_payment_stripe_charge"`);
  }
}
