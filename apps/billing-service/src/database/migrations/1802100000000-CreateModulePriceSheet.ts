import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * W4b (ADR-0013 / BILLING-CRITICAL-002): the module price sheet moves from
 * `admin` to `billing`, and its two jsonb columns become rows.
 *
 * `admin.module_pricing.pricingMetrics` was an array of
 * `{ type, price: number, includedQuantity }` and `tierMultipliers` an object
 * of `tier -> number`, both inside `jsonb`. That shape made three things
 * impossible: a CHECK on a negative price or a tier multiplier of 40, a unique
 * constraint stopping the same metric appearing twice on one sheet, and any
 * index reaching a price. Every arithmetic step also went through IEEE-754,
 * because a jsonb number IS a double.
 *
 * Here `billing.module_prices` is the sheet, `module_price_metrics` is one row
 * per metric with `numeric(19,4)`, and `module_price_tier_multipliers` is one
 * row per tier with `numeric(6,4)` bounded to (0, 10].
 *
 * The copy expands the arrays with `jsonb_array_elements` /
 * `jsonb_each_text`, and is fail-closed the same way the discount migration
 * is: a metric with no `type`, a price that is not a number, or a multiplier
 * outside the bound violates a constraint and aborts, rather than being
 * rounded or dropped. Money data is not silently repaired.
 *
 * Ordering: `SCHEMA_REGISTRY` runs billing (slot 8) before admin (slot 11), so
 * this copy always precedes the admin-side drop, which re-verifies the counts.
 */
export class CreateModulePriceSheet1802100000000 implements MigrationInterface {
  name = 'CreateModulePriceSheet1802100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "billing"."module_prices" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "module_id" uuid NOT NULL,
        "module_code" character varying(50) NOT NULL,
        "currency" character varying(3) NOT NULL DEFAULT 'USD',
        "effective_from" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "effective_to" TIMESTAMP WITH TIME ZONE,
        "is_active" boolean NOT NULL DEFAULT true,
        "notes" text,
        "version" integer NOT NULL DEFAULT 1,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        "created_by" uuid,
        "updated_by" uuid,
        CONSTRAINT "PK_billing_module_prices" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_billing_module_prices_module_effective"
          UNIQUE ("module_id", "effective_from"),
        CONSTRAINT "CHK_billing_module_prices_currency_iso4217"
          CHECK ("currency" ~ '^[A-Z]{3}$'),
        CONSTRAINT "CHK_billing_module_prices_effective_window"
          CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from"),
        CONSTRAINT "CHK_billing_module_prices_version" CHECK ("version" >= 1)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "billing"."module_price_metrics" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "module_price_id" uuid NOT NULL,
        "metric_type" character varying(32) NOT NULL,
        "price" numeric(19,4) NOT NULL,
        "description" text,
        "min_quantity" integer,
        "max_quantity" integer,
        "included_quantity" integer,
        CONSTRAINT "PK_billing_module_price_metrics" PRIMARY KEY ("id"),
        CONSTRAINT "FK_billing_module_price_metrics_sheet"
          FOREIGN KEY ("module_price_id") REFERENCES "billing"."module_prices"("id")
          ON DELETE CASCADE,
        CONSTRAINT "UQ_billing_module_price_metrics_type"
          UNIQUE ("module_price_id", "metric_type"),
        CONSTRAINT "CHK_billing_module_price_metrics_price" CHECK ("price" >= 0),
        CONSTRAINT "CHK_billing_module_price_metrics_quantities" CHECK (
          ("min_quantity" IS NULL OR "min_quantity" >= 0)
          AND ("max_quantity" IS NULL OR "max_quantity" >= 0)
          AND ("included_quantity" IS NULL OR "included_quantity" >= 0)
          AND ("min_quantity" IS NULL OR "max_quantity" IS NULL OR "max_quantity" >= "min_quantity")
        ),
        CONSTRAINT "CHK_billing_module_price_metrics_type" CHECK ("metric_type" IN (
          'base_price', 'per_user', 'per_farm', 'per_pond', 'per_sensor', 'per_device',
          'per_gb_storage', 'per_gb_transfer', 'per_api_call', 'per_alert', 'per_report',
          'per_sms', 'per_email', 'per_integration', 'per_workflow'
        ))
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "billing"."module_price_tier_multipliers" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "module_price_id" uuid NOT NULL,
        "tier" character varying(32) NOT NULL,
        "multiplier" numeric(6,4) NOT NULL,
        CONSTRAINT "PK_billing_module_price_tier_multipliers" PRIMARY KEY ("id"),
        CONSTRAINT "FK_billing_module_price_tier_multipliers_sheet"
          FOREIGN KEY ("module_price_id") REFERENCES "billing"."module_prices"("id")
          ON DELETE CASCADE,
        CONSTRAINT "UQ_billing_module_price_tier_multipliers_tier"
          UNIQUE ("module_price_id", "tier"),
        CONSTRAINT "CHK_billing_module_price_tier_multipliers_tier"
          CHECK ("tier" IN ('free', 'starter', 'professional', 'enterprise', 'custom')),
        -- A multiplier scales a list price. Zero would make the metric free by
        -- accident rather than by an explicit price of 0, and anything above 10
        -- is a data-entry error, not a surcharge anyone intends.
        CONSTRAINT "CHK_billing_module_price_tier_multipliers_bounds"
          CHECK ("multiplier" > 0 AND "multiplier" <= 10)
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_billing_module_prices_module" ON "billing"."module_prices" ("module_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_billing_module_prices_code" ON "billing"."module_prices" ("module_code")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_billing_module_prices_active" ON "billing"."module_prices" ("is_active")`,
    );
    // The hot read is "the sheet in force for this module code, now".
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_billing_module_prices_lookup" ON "billing"."module_prices" ("module_code", "is_active", "effective_from")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_billing_module_price_metrics_sheet" ON "billing"."module_price_metrics" ("module_price_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_billing_module_price_tier_multipliers_sheet" ON "billing"."module_price_tier_multipliers" ("module_price_id")`,
    );

    await this.copyFromAdmin(queryRunner);
  }

  /**
   * Expand the two jsonb columns into rows, exactly or not at all.
   *
   * `(metric->>'price')::numeric` raises rather than coercing when the value
   * is not a number, the metric CHECK rejects a type the platform does not
   * know, and the multiplier bound rejects a rate outside (0, 10]. A migration
   * that quietly repaired any of those would be publishing a price nobody
   * chose.
   */
  private async copyFromAdmin(queryRunner: QueryRunner): Promise<void> {
    const presence = (await queryRunner.query(
      `SELECT to_regclass('admin.module_pricing') IS NOT NULL AS present`,
    )) as Array<{ present: boolean }>;
    if (!presence[0]?.present) return;

    await queryRunner.query(`
      INSERT INTO "billing"."module_prices" (
        "id", "module_id", "module_code", "currency", "effective_from", "effective_to",
        "is_active", "notes", "version", "createdAt", "updatedAt", "created_by", "updated_by"
      )
      SELECT
        p."id",
        p."moduleId",
        p."moduleCode",
        upper(COALESCE(p."currency", 'USD')),
        p."effectiveFrom",
        p."effectiveTo",
        p."isActive",
        p."notes",
        GREATEST(p."version", 1),
        p."createdAt",
        p."updatedAt",
        p."createdBy",
        p."updatedBy"
      FROM "admin"."module_pricing" p
      ON CONFLICT ("id") DO NOTHING
    `);

    await queryRunner.query(`
      INSERT INTO "billing"."module_price_metrics" (
        "module_price_id", "metric_type", "price", "description",
        "min_quantity", "max_quantity", "included_quantity"
      )
      SELECT
        p."id",
        metric->>'type',
        (metric->>'price')::numeric,
        metric->>'description',
        NULLIF(metric->>'minQuantity', '')::integer,
        NULLIF(metric->>'maxQuantity', '')::integer,
        NULLIF(metric->>'includedQuantity', '')::integer
      FROM "admin"."module_pricing" p
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(p."pricingMetrics", '[]'::jsonb)) AS metric
      WHERE EXISTS (SELECT 1 FROM "billing"."module_prices" mp WHERE mp."id" = p."id")
      ON CONFLICT ("module_price_id", "metric_type") DO NOTHING
    `);

    await queryRunner.query(`
      INSERT INTO "billing"."module_price_tier_multipliers" ("module_price_id", "tier", "multiplier")
      SELECT p."id", tier_entry.key, tier_entry.value::numeric
      FROM "admin"."module_pricing" p
      CROSS JOIN LATERAL jsonb_each_text(COALESCE(p."tierMultipliers", '{}'::jsonb)) AS tier_entry
      WHERE EXISTS (SELECT 1 FROM "billing"."module_prices" mp WHERE mp."id" = p."id")
      ON CONFLICT ("module_price_id", "tier") DO NOTHING
    `);

    // A sheet whose metrics did not all land would price a module wrongly and
    // silently, so refuse to finish while one is missing.
    const missing = (await queryRunner.query(`
      SELECT count(*)::text AS missing
        FROM "admin"."module_pricing" p
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(p."pricingMetrics", '[]'::jsonb)) AS metric
       WHERE NOT EXISTS (
         SELECT 1 FROM "billing"."module_price_metrics" m
          WHERE m."module_price_id" = p."id" AND m."metric_type" = metric->>'type'
       )
    `)) as Array<{ missing: string }>;
    const missingCount = missing[0]?.missing ?? '0';
    if (missingCount !== '0') {
      throw new Error(
        `CreateModulePriceSheet1802100000000: ${missingCount} admin.module_pricing metrics have no row in billing.module_price_metrics. Resolve the source rows before re-running.`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // DESTRUCTIVE: down()-only rollback of CreateModulePriceSheet1802100000000 — drops the three billing tables this same migration created; the source rows in admin.module_pricing are dropped by the admin-side migration 1809000000000, so roll that one back first
    await queryRunner.query(`DROP TABLE IF EXISTS "billing"."module_price_tier_multipliers"`);
    // DESTRUCTIVE: same rollback, child table of module_prices created above
    await queryRunner.query(`DROP TABLE IF EXISTS "billing"."module_price_metrics"`);
    // DESTRUCTIVE: same rollback, the sheet table created above
    await queryRunner.query(`DROP TABLE IF EXISTS "billing"."module_prices"`);
  }
}
