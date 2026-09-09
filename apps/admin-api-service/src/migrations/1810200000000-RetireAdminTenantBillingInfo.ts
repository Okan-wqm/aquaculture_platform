import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * RetireAdminTenantBillingInfo — the tenant's billing summary comes from
 * billing (ADMIN-HIGH-012 money class, DB-ADMIN-MEDIUM-005, D14).
 *
 * WHY THIS IS A RETIREMENT AND NOT A TYPE CONVERSION
 *
 * `admin.tenant_billing_info` holds the last two admin-owned money columns:
 * `monthlyAmount` and `lastPaymentAmount`, both `numeric(10,2)` behind a
 * `parseFloat` transformer rather than the platform's `MoneyColumn`
 * (`numeric(19,4)` + Decimal). Widening them was the obvious W6 move and it
 * would have been cosmetic, because the table has no writer:
 *
 *   - `createOrUpdateBillingInfo` (`tenant-activity.service.ts:193`) — the only
 *     INSERT/UPDATE path in the platform — has zero callers repo-wide.
 *   - `getBillingInfo` (`:189`) likewise.
 *   - The single reader is `TenantDetailService.getBillingSummary`, which
 *     returns `undefined` on a missing row, so the tenant-detail page's billing
 *     block has been blank since the table shipped (DB-ADMIN-MEDIUM-005).
 *
 * Rounding a column in an empty table to four decimal places is the kind of fix
 * that looks like progress. The defect is that admin keeps a second billing
 * store at all: rule D14 makes `billing.subscriptions` the SSoT for per-tenant
 * subscription state, and `billing.invoices` the record of what was actually
 * charged and paid. Both are already declared here as `synchronize: false`
 * read-only mirrors (`analytics/entities/external/`). So the read path moves to
 * them and the table goes, which removes the two money columns rather than
 * re-typing them, and turns a permanently blank panel into a real one.
 *
 * It also removes the last two `duplicateStripeIdentifiers` waivers:
 * `stripeCustomerId` / `stripeSubscriptionId` were a second writable home for
 * a Stripe object that billing owns.
 *
 * SAFETY SHAPE: the table is empty by construction — no INSERT exists in any
 * service — so there is nothing to archive or migrate, and the guard below
 * refuses to drop it if that premise turns out to be false. The reverse step
 * recreates the table, its unique constraint and its index exactly as
 * `1800000000000-Baseline` declared them.
 *
 * Blue-green: deploy the code change ahead of, or with, this migration. An
 * older replica reads an empty table today and would read a missing one after,
 * whose `SchemaDriftValidator` fails at cold start.
 *
 * Closes: docs/reviews/admin-expert/2026-09-05-superadmin-audit.md#ADMIN-HIGH-012
 */
export class RetireAdminTenantBillingInfo1810200000000 implements MigrationInterface {
  name = 'RetireAdminTenantBillingInfo1810200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);

    await queryRunner.query(`
      DO $$
      DECLARE
        row_count bigint;
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'admin' AND table_name = 'tenant_billing_info'
        ) THEN
          RETURN;
        END IF;

        EXECUTE 'SELECT count(*) FROM admin.tenant_billing_info' INTO row_count;
        IF row_count > 0 THEN
          RAISE EXCEPTION
            'admin.tenant_billing_info holds % row(s); the retire premise (no writer exists) is false — stop and re-audit before dropping billing state',
            row_count;
        END IF;
      END $$;
    `);

    await queryRunner.query(`DROP TABLE IF EXISTS "admin"."tenant_billing_info"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "admin"."tenant_billing_info" (
         "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
         "tenantId" uuid NOT NULL,
         "billingCycle" character varying(50) NOT NULL,
         "monthlyAmount" numeric(10,2) NOT NULL DEFAULT '0',
         "currency" character varying(3) NOT NULL DEFAULT 'USD',
         "paymentStatus" character varying(50) NOT NULL DEFAULT 'pending',
         "nextBillingDate" TIMESTAMP WITH TIME ZONE,
         "lastPaymentDate" TIMESTAMP WITH TIME ZONE,
         "lastPaymentAmount" numeric(10,2),
         "stripeCustomerId" character varying(255),
         "stripeSubscriptionId" character varying(255),
         "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
         CONSTRAINT "UQ_94bf8f5742c39d367bcf5f4f172" UNIQUE ("tenantId"),
         CONSTRAINT "PK_3c5682187654bc4d91dce6c82d3" PRIMARY KEY ("id")
       )`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_94bf8f5742c39d367bcf5f4f17" ON "admin"."tenant_billing_info" ("tenantId")`,
    );
  }
}
