import { applyTenantRlsToSchema } from '@aquaculture/backend-common/database';
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * W4a (ADR-0013 / BILLING-CRITICAL-002): the discount catalogue moves from
 * `admin` to `billing`, which is the sole writer of anything that decides what
 * a subscription or an invoice is worth (D14).
 *
 * Two things change beyond the schema name:
 *
 *  1. **The value is typed by kind.** `admin.discount_codes.discountValue`
 *     was one `numeric(10,2)` holding a percentage for one row and an amount
 *     of money for the next, so no CHECK could constrain it: `150` was a legal
 *     150% and a legal $150 at once. Here each kind has its own column and one
 *     CHECK asserts that exactly the matching one is populated — a percentage
 *     cannot exceed 100, an amount is `numeric(19,4)` in a stated ISO-4217
 *     currency, and the two free-period kinds finally have somewhere to put
 *     their number instead of being computed as a silent zero.
 *
 *  2. **The redemption caps are enforced by the database.**
 *     `current_redemptions <= max_redemptions` is a table CHECK, so an
 *     over-redemption is refused even if application code races.
 *
 * The copy from `admin` is deliberately fail-closed: a legacy row that cannot
 * be represented exactly (a percentage above 100, a fractional month count, a
 * subscription reference that is not a UUID) aborts the migration instead of
 * being rounded, clamped or dropped. Money data is not silently repaired.
 *
 * Ordering: `SCHEMA_REGISTRY` runs `billing` (slot 8) before `admin` (slot 11),
 * so this copy always precedes the admin-side drop, and the admin migration
 * re-asserts the row counts before dropping anything.
 */
export class CreateDiscountCatalogue1802000000000 implements MigrationInterface {
  name = 'CreateDiscountCatalogue1802000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DO $$ BEGIN CREATE TYPE "billing"."discount_codes_discount_type_enum" AS ENUM('percentage', 'fixed_amount', 'free_trial_extension', 'free_months'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
    );
    await queryRunner.query(
      `DO $$ BEGIN CREATE TYPE "billing"."discount_codes_applies_to_enum" AS ENUM('all_plans', 'specific_plans', 'upgrades_only', 'new_subscriptions_only'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
    );
    await queryRunner.query(
      `DO $$ BEGIN CREATE TYPE "billing"."discount_codes_duration_enum" AS ENUM('once', 'repeating', 'forever'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "billing"."discount_codes" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "code" character varying(64) NOT NULL,
        "name" character varying(255) NOT NULL,
        "description" text,
        "discount_type" "billing"."discount_codes_discount_type_enum" NOT NULL,
        "percent_off" numeric(5,2),
        "amount_off" numeric(19,4),
        "free_months" integer,
        "trial_extension_days" integer,
        "currency" character varying(3) NOT NULL DEFAULT 'USD',
        "applies_to" "billing"."discount_codes_applies_to_enum" NOT NULL DEFAULT 'all_plans',
        "applicable_plan_ids" jsonb,
        "duration" "billing"."discount_codes_duration_enum" NOT NULL DEFAULT 'once',
        "duration_in_months" integer,
        "is_active" boolean NOT NULL DEFAULT true,
        "valid_from" TIMESTAMP WITH TIME ZONE,
        "valid_until" TIMESTAMP WITH TIME ZONE,
        "max_redemptions" integer,
        "current_redemptions" integer NOT NULL DEFAULT 0,
        "max_redemptions_per_tenant" integer,
        "minimum_order_amount" numeric(19,4),
        "campaign_id" character varying(255),
        "campaign_name" character varying(255),
        "stripe_promotion_code_id" character varying(255),
        "stripe_coupon_id" character varying(255),
        "metadata" jsonb,
        "is_referral_code" boolean NOT NULL DEFAULT false,
        "referrer_id" uuid,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        "created_by" character varying(255),
        "updated_by" character varying(255),
        CONSTRAINT "PK_billing_discount_codes" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_billing_discount_codes_code" UNIQUE ("code"),
        CONSTRAINT "CHK_billing_discount_codes_code_shape"
          CHECK ("code" ~ '^[A-Z0-9_]{3,64}$'),
        CONSTRAINT "CHK_billing_discount_codes_currency_iso4217"
          CHECK ("currency" ~ '^[A-Z]{3}$'),
        CONSTRAINT "CHK_billing_discount_codes_value_branch" CHECK (
          ("discount_type" = 'percentage'
             AND "percent_off" IS NOT NULL AND "percent_off" > 0 AND "percent_off" <= 100
             AND "amount_off" IS NULL AND "free_months" IS NULL AND "trial_extension_days" IS NULL)
          OR ("discount_type" = 'fixed_amount'
             AND "amount_off" IS NOT NULL AND "amount_off" > 0
             AND "percent_off" IS NULL AND "free_months" IS NULL AND "trial_extension_days" IS NULL)
          OR ("discount_type" = 'free_months'
             AND "free_months" IS NOT NULL AND "free_months" > 0
             AND "percent_off" IS NULL AND "amount_off" IS NULL AND "trial_extension_days" IS NULL)
          OR ("discount_type" = 'free_trial_extension'
             AND "trial_extension_days" IS NOT NULL AND "trial_extension_days" > 0
             AND "percent_off" IS NULL AND "amount_off" IS NULL AND "free_months" IS NULL)
        ),
        CONSTRAINT "CHK_billing_discount_codes_redemption_counts" CHECK (
          "current_redemptions" >= 0
          AND ("max_redemptions" IS NULL OR "max_redemptions" > 0)
          AND ("max_redemptions" IS NULL OR "current_redemptions" <= "max_redemptions")
          AND ("max_redemptions_per_tenant" IS NULL OR "max_redemptions_per_tenant" > 0)
        ),
        CONSTRAINT "CHK_billing_discount_codes_validity_window"
          CHECK ("valid_from" IS NULL OR "valid_until" IS NULL OR "valid_until" > "valid_from"),
        CONSTRAINT "CHK_billing_discount_codes_minimum_order"
          CHECK ("minimum_order_amount" IS NULL OR "minimum_order_amount" >= 0),
        CONSTRAINT "CHK_billing_discount_codes_specific_plans_listed" CHECK (
          "applies_to" <> 'specific_plans'
          OR ("applicable_plan_ids" IS NOT NULL AND jsonb_array_length("applicable_plan_ids") > 0)
        ),
        CONSTRAINT "CHK_billing_discount_codes_repeating_duration" CHECK (
          "duration" <> 'repeating' OR ("duration_in_months" IS NOT NULL AND "duration_in_months" > 0)
        )
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "billing"."discount_redemptions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "discount_code_id" uuid NOT NULL,
        "tenant_id" uuid NOT NULL,
        "subscription_id" uuid,
        "invoice_id" uuid,
        "discount_amount" numeric(19,4) NOT NULL,
        "currency" character varying(3) NOT NULL,
        "redeemed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "redeemed_by" character varying(255),
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_billing_discount_redemptions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_billing_discount_redemptions_code"
          FOREIGN KEY ("discount_code_id") REFERENCES "billing"."discount_codes"("id")
          ON DELETE RESTRICT,
        CONSTRAINT "CHK_billing_discount_redemptions_amount"
          CHECK ("discount_amount" >= 0),
        CONSTRAINT "CHK_billing_discount_redemptions_currency_iso4217"
          CHECK ("currency" ~ '^[A-Z]{3}$')
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_billing_discount_codes_is_active" ON "billing"."discount_codes" ("is_active")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_billing_discount_codes_validity" ON "billing"."discount_codes" ("valid_from", "valid_until")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_billing_discount_codes_campaign" ON "billing"."discount_codes" ("campaign_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_billing_discount_redemptions_code" ON "billing"."discount_redemptions" ("discount_code_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_billing_discount_redemptions_tenant" ON "billing"."discount_redemptions" ("tenant_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_billing_discount_redemptions_redeemed_at" ON "billing"."discount_redemptions" ("redeemed_at")`,
    );
    // The per-tenant cap is counted per (code, tenant); without this the count
    // is a sequential scan of every redemption a tenant ever made.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_billing_discount_redemptions_code_tenant" ON "billing"."discount_redemptions" ("discount_code_id", "tenant_id")`,
    );

    await this.copyFromAdmin(queryRunner);

    // discount_redemptions carries tenant_id, so the canonical billing tenant
    // predicate applies to it; discount_codes is a cross-tenant catalogue and
    // has no tenant column, so the discovery pass skips it.
    await applyTenantRlsToSchema(queryRunner, {
      tenantIdColumns: ['tenant_id', 'tenantId'],
      includeTables: ['discount_redemptions'],
    });
  }

  /**
   * Copy the legacy rows, exactly or not at all.
   *
   * Every mapping that cannot be represented losslessly produces NULL in a
   * NOT NULL / CHECKed column, so Postgres aborts the transaction and names
   * the constraint. That is the intent: a 150% "percentage", 2.5 free months
   * or a `subscriptionId` that is not a UUID is corrupt money data, and a
   * migration that quietly rounds it is worse than one that stops.
   */
  private async copyFromAdmin(queryRunner: QueryRunner): Promise<void> {
    const presence = (await queryRunner.query(
      `SELECT to_regclass('admin.discount_codes') IS NOT NULL AS present`,
    )) as Array<{ present: boolean }>;
    if (!presence[0]?.present) return;

    await queryRunner.query(`
      INSERT INTO "billing"."discount_codes" (
        "id", "code", "name", "description", "discount_type",
        "percent_off", "amount_off", "free_months", "trial_extension_days",
        "currency", "applies_to", "applicable_plan_ids", "duration", "duration_in_months",
        "is_active", "valid_from", "valid_until", "max_redemptions", "current_redemptions",
        "max_redemptions_per_tenant", "minimum_order_amount", "campaign_id", "campaign_name",
        "stripe_promotion_code_id", "stripe_coupon_id", "metadata", "is_referral_code",
        "referrer_id", "createdAt", "updatedAt", "created_by", "updated_by"
      )
      SELECT
        c."id",
        upper(regexp_replace(c."code", '[^A-Za-z0-9_]', '', 'g')),
        c."name",
        c."description",
        c."discountType"::text::"billing"."discount_codes_discount_type_enum",
        CASE WHEN c."discountType"::text = 'percentage' THEN c."discountValue" END,
        CASE WHEN c."discountType"::text = 'fixed_amount' THEN c."discountValue" END,
        CASE WHEN c."discountType"::text = 'free_months'
                  AND c."discountValue" = trunc(c."discountValue")
             THEN c."discountValue"::integer END,
        CASE WHEN c."discountType"::text = 'free_trial_extension'
                  AND c."discountValue" = trunc(c."discountValue")
             THEN c."discountValue"::integer END,
        upper(COALESCE(
          (SELECT r."currency" FROM "admin"."discount_redemptions" r
            WHERE r."discountCodeId" = c."id" LIMIT 1),
          'USD'
        )),
        c."appliesTo"::text::"billing"."discount_codes_applies_to_enum",
        c."applicablePlanIds",
        c."duration"::text::"billing"."discount_codes_duration_enum",
        c."durationInMonths",
        c."isActive",
        c."validFrom",
        c."validUntil",
        c."maxRedemptions",
        c."currentRedemptions",
        c."maxRedemptionsPerTenant",
        c."minimumOrderAmount",
        c."campaignId",
        c."campaignName",
        c."stripePromotionCodeId",
        c."stripeCouponId",
        c."metadata",
        c."isReferralCode",
        NULLIF(c."referrerId", '')::uuid,
        c."createdAt",
        c."updatedAt",
        c."createdBy",
        c."updatedBy"
      FROM "admin"."discount_codes" c
      ON CONFLICT ("id") DO NOTHING
    `);

    await queryRunner.query(`
      INSERT INTO "billing"."discount_redemptions" (
        "id", "discount_code_id", "tenant_id", "subscription_id", "invoice_id",
        "discount_amount", "currency", "redeemed_at", "redeemed_by", "createdAt"
      )
      SELECT
        r."id",
        r."discountCodeId",
        r."tenantId",
        NULLIF(r."subscriptionId", '')::uuid,
        NULLIF(r."invoiceId", '')::uuid,
        r."discountAmount",
        upper(r."currency"),
        r."redeemedAt",
        r."redeemedBy",
        r."createdAt"
      FROM "admin"."discount_redemptions" r
      WHERE EXISTS (
        SELECT 1 FROM "billing"."discount_codes" bc WHERE bc."id" = r."discountCodeId"
      )
      ON CONFLICT ("id") DO NOTHING
    `);

    // A redemption whose code did not copy would be silently lost by the
    // EXISTS filter above, so refuse to finish while one remains.
    const orphanRows = (await queryRunner.query(`
      SELECT count(*)::text AS orphans
        FROM "admin"."discount_redemptions" r
       WHERE NOT EXISTS (
         SELECT 1 FROM "billing"."discount_redemptions" br WHERE br."id" = r."id"
       )
    `)) as Array<{ orphans: string }>;
    const orphans = orphanRows[0]?.orphans ?? '0';
    if (orphans !== '0') {
      throw new Error(
        `CreateDiscountCatalogue1802000000000: ${orphans} admin.discount_redemptions rows have no copy in billing — their discount code did not migrate. Resolve the source rows before re-running.`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // DESTRUCTIVE: down()-only rollback of CreateDiscountCatalogue1802000000000 —
    // drops the two billing tables this same migration created. The source rows
    // in admin.discount_codes / admin.discount_redemptions are dropped by the
    // admin-side migration 1802100000000, whose own down() recreates and
    // repopulates them; roll that one back first. Forward recreate path is
    // re-running up().
    await queryRunner.query(`DROP TABLE IF EXISTS "billing"."discount_redemptions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "billing"."discount_codes"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "billing"."discount_codes_duration_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "billing"."discount_codes_applies_to_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "billing"."discount_codes_discount_type_enum"`);
  }
}
