import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DropModulePriceFromAuthModules1807200000000
 * (A5 / DB-IDENT-MEDIUM-003 / ORPHAN-MEDIUM-383)
 *
 * WHY: subscription pricing was forked across services. auth.modules carried
 * a `price` column whose entity comment claimed "Billing resolver sums module
 * prices to compute total plan cost" — that resolver does not exist. The live
 * total-cost computations read billing-owned data instead: the tenant-create
 * quote flow prices from the module-pricing catalog (admin.module_pricing,
 * BASE_PRICE metric + usage metrics + tier multipliers) and subscription
 * provisioning prices from billing.plans / billing.subscriptions. Platform
 * rule D14 makes billing the pricing SSoT, so the auth fork is collapsed:
 * auth.modules keeps catalogue metadata only (code/name/description/icon/
 * enablement/is_core) and the dead `price` column is dropped.
 *
 * `is_core` is intentionally KEPT: it is catalogue metadata (an admin-UI
 * classification flag: filter/badge/stats), not a price input — no pricing
 * logic reads it anywhere.
 *
 * DATA NOTE (archive, verified on the production droplet 2026-07-13):
 * auth.modules.price was NULL for ALL 6 rows — no real pricing data ever
 * lived in this column, so there is nothing to migrate into billing:
 *   code=ai          price=NULL  is_core=f
 *   code=alert       price=NULL  is_core=f
 *   code=farm        price=NULL  is_core=f   (catalog base_price: 50 USD)
 *   code=hr          price=NULL  is_core=f   (catalog base_price: 40 USD)
 *   code=hydroponics price=NULL  is_core=f   (catalog base_price: 45 USD)
 *   code=sensor      price=NULL  is_core=f   (catalog base_price: 75 USD)
 * The parenthesized catalog prices are the already-live admin.module_pricing
 * BASE_PRICE values — the authority the admin surface now reads.
 *
 * Blue-green: single DROP COLUMN of a nullable, all-NULL column. The code
 * that referenced it (Module entity field, NATS module CRUD, event-contract
 * fields, admin-api pass-through) is removed in the same release, and the
 * platform's deploy runs db-migrate before starting the new images.
 *
 * Idempotent via IF EXISTS / IF NOT EXISTS guards.
 *
 * Timestamp note: db-migrate aggregates all services' migrations into one
 * ordered stream; 1807100000000 (auth tenant-suspension audit) was the
 * repo-wide max, so this takes the next free slot, 1807200000000.
 */
export class DropModulePriceFromAuthModules1807200000000 implements MigrationInterface {
  name = 'DropModulePriceFromAuthModules1807200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "auth"."modules" DROP COLUMN IF EXISTS "price"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restores the column shape from the 1800000000000 baseline. The values
    // are NOT restorable — but per the data note above every row was NULL,
    // so the default-shape restore is lossless for all known deployments.
    await queryRunner.query(
      `ALTER TABLE "auth"."modules" ADD COLUMN IF NOT EXISTS "price" numeric(10,2) DEFAULT '0'`,
    );
  }
}
