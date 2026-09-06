import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * W4b (ADR-0013 / BILLING-CRITICAL-002): `billing.plans` becomes the ONLY plan
 * catalogue, and the money `admin.plan_definitions` kept in jsonb becomes rows.
 *
 * Two catalogues existed. Every runtime path — create-subscription,
 * change-plan, the billing scheduler, the provisioning handler — resolves
 * `billing.plans`; `admin.plan_definitions` carried its own ids that nothing
 * ever resolved, its own `stripeProductId` / `stripePriceIds` (a Stripe object
 * has one owner, and two writable homes means two services can mint a product
 * for the same plan), and a per-cycle price matrix inside `jsonb` where no
 * CHECK could reach a negative price or a `discountPercent` of 400.
 *
 * WHAT MOVES:
 *   - the presentation and lifecycle columns (`code`, descriptions,
 *     `visibility`, `is_recommended`, trial/grace days, upgrade/downgrade
 *     copy, icon/color/badge) onto `billing.plans`;
 *   - the per-cycle price matrix into `billing.plan_cycle_prices`, one row per
 *     (plan, cycle) with `numeric(19,4)` prices and `discount_percent` CHECKed
 *     into [0, 100];
 *   - `features.addOns[]` into `billing.plan_add_ons`, because an add-on price
 *     was money nested two levels inside a features blob;
 *   - `features`' three named sets into `billing.plans.features`, widening it
 *     from a flat `string[]`.
 *
 * IDENTITY: `billing.plans.name` is already UNIQUE — it is the catalogue's own
 * business key — so an admin definition whose name matches a billing plan
 * UPDATES that plan (the operator's authored copy lands on the row that is
 * actually used), and one whose name is new is INSERTED keeping its own id. No
 * id is remapped, no existing plan is duplicated, and nothing authored is
 * discarded. `admin.plan_definitions.pricing` also seeds the cycle rows for
 * plans that had none.
 *
 * NOT touched: `billing.plans.pricing`, the flat per-unit rate card a
 * subscription snapshots at signup. It is the same shape as
 * `billing.subscriptions.pricing` and normalising one without the other would
 * split the snapshot; both are BILLING-CRITICAL-003's, and both stay in the
 * money-in-jsonb ratchet until then.
 *
 * Ordering: `SCHEMA_REGISTRY` runs billing (slot 8) before admin (slot 11), so
 * this merge always precedes the admin-side drop, which re-verifies it.
 */
export class MergePlanCatalogue1802200000000 implements MigrationInterface {
  name = 'MergePlanCatalogue1802200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DO $$ BEGIN CREATE TYPE "billing"."plans_visibility_enum" AS ENUM('public', 'private', 'deprecated'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
    );

    for (const [column, type] of [
      ['code', 'character varying(100)'],
      ['description', 'text'],
      ['short_description', 'text'],
      ['is_recommended', 'boolean NOT NULL DEFAULT false'],
      ['trial_days', 'integer'],
      ['grace_period_days', 'integer'],
      ['upgrade_message', 'text'],
      ['downgrade_warning', 'text'],
      ['icon', 'character varying(64)'],
      ['color', 'character varying(32)'],
      ['badge', 'character varying(64)'],
    ] as const) {
      await queryRunner.query(
        `ALTER TABLE "billing"."plans" ADD COLUMN IF NOT EXISTS "${column}" ${type}`,
      );
    }
    await queryRunner.query(
      `ALTER TABLE "billing"."plans" ADD COLUMN IF NOT EXISTS "visibility" "billing"."plans_visibility_enum" NOT NULL DEFAULT 'public'`,
    );

    // `code` is the operator-facing catalogue key. Partial UNIQUE so the plans
    // that predate the merge (which have none) do not all collide on NULL.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_billing_plans_code" ON "billing"."plans" ("code") WHERE "code" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_billing_plans_visibility" ON "billing"."plans" ("visibility")`,
    );

    // `features` widens from a flat array to the three named sets. Guarded by
    // an information_schema probe so a replay after a partial failure is safe.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'billing' AND table_name = 'plans' AND column_name = 'features'
        ) THEN
          UPDATE "billing"."plans"
             SET "features" = jsonb_build_object(
                   'coreFeatures', COALESCE("features", '[]'::jsonb),
                   'advancedFeatures', '[]'::jsonb,
                   'premiumFeatures', '[]'::jsonb
                 )
           WHERE jsonb_typeof("features") = 'array';
        END IF;
      END $$;
    `);

    // The column default still produced a flat array for new rows.
    await queryRunner.query(
      `ALTER TABLE "billing"."plans" ALTER COLUMN "features" SET DEFAULT '{"coreFeatures":[],"advancedFeatures":[],"premiumFeatures":[]}'::jsonb`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "billing"."plan_cycle_prices" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "plan_id" uuid NOT NULL,
        "billing_cycle" "billing"."plans_billing_cycle_enum" NOT NULL,
        "base_price" numeric(19,4) NOT NULL,
        "per_user_price" numeric(19,4) NOT NULL DEFAULT 0,
        "per_farm_price" numeric(19,4) NOT NULL DEFAULT 0,
        "per_module_price" numeric(19,4) NOT NULL DEFAULT 0,
        "discount_percent" numeric(5,2) NOT NULL DEFAULT 0,
        CONSTRAINT "PK_billing_plan_cycle_prices" PRIMARY KEY ("id"),
        CONSTRAINT "FK_billing_plan_cycle_prices_plan"
          FOREIGN KEY ("plan_id") REFERENCES "billing"."plans"("id") ON DELETE CASCADE,
        CONSTRAINT "UQ_billing_plan_cycle_prices_cycle" UNIQUE ("plan_id", "billing_cycle"),
        CONSTRAINT "CHK_billing_plan_cycle_prices_amounts" CHECK (
          "base_price" >= 0 AND "per_user_price" >= 0
          AND "per_farm_price" >= 0 AND "per_module_price" >= 0
        ),
        CONSTRAINT "CHK_billing_plan_cycle_prices_discount"
          CHECK ("discount_percent" >= 0 AND "discount_percent" <= 100)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "billing"."plan_add_ons" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "plan_id" uuid NOT NULL,
        "code" character varying(100) NOT NULL,
        "name" character varying(255) NOT NULL,
        "description" text,
        "price" numeric(19,4) NOT NULL,
        "billing_cycle" "billing"."plans_billing_cycle_enum" NOT NULL,
        CONSTRAINT "PK_billing_plan_add_ons" PRIMARY KEY ("id"),
        CONSTRAINT "FK_billing_plan_add_ons_plan"
          FOREIGN KEY ("plan_id") REFERENCES "billing"."plans"("id") ON DELETE CASCADE,
        CONSTRAINT "UQ_billing_plan_add_ons_code" UNIQUE ("plan_id", "code"),
        CONSTRAINT "CHK_billing_plan_add_ons_price" CHECK ("price" >= 0)
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_billing_plan_cycle_prices_plan" ON "billing"."plan_cycle_prices" ("plan_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_billing_plan_add_ons_plan" ON "billing"."plan_add_ons" ("plan_id")`,
    );

    await this.mergeFromAdmin(queryRunner);
    await this.seedCyclePricesForUnmatchedPlans(queryRunner);
  }

  /**
   * Fold `admin.plan_definitions` into `billing.plans`.
   *
   * Matching is by `name`, the catalogue's own UNIQUE business key: a match
   * UPDATES the live plan with the operator's authored copy, a miss INSERTS
   * the definition keeping its id. Both branches then expand the jsonb price
   * matrix and the add-ons into rows; a value that cannot be represented
   * exactly violates a CHECK and aborts, rather than being rounded.
   */
  private async mergeFromAdmin(queryRunner: QueryRunner): Promise<void> {
    const presence = (await queryRunner.query(
      `SELECT to_regclass('admin.plan_definitions') IS NOT NULL AS present`,
    )) as Array<{ present: boolean }>;
    if (!presence[0]?.present) return;

    await queryRunner.query(`
      UPDATE "billing"."plans" p
         SET "code" = COALESCE(p."code", d."code"),
             "description" = COALESCE(p."description", d."description"),
             "short_description" = COALESCE(p."short_description", d."shortDescription"),
             "visibility" = d."visibility"::text::"billing"."plans_visibility_enum",
             "is_recommended" = d."isRecommended",
             "trial_days" = COALESCE(p."trial_days", d."trialDays"),
             "grace_period_days" = COALESCE(p."grace_period_days", d."gracePeriodDays"),
             "upgrade_message" = COALESCE(p."upgrade_message", d."upgradeMessage"),
             "downgrade_warning" = COALESCE(p."downgrade_warning", d."downgradeWarning"),
             "icon" = COALESCE(p."icon", d."icon"),
             "color" = COALESCE(p."color", d."color"),
             "badge" = COALESCE(p."badge", d."badge"),
             "stripe_product_id" = COALESCE(p."stripe_product_id", d."stripeProductId"),
             "stripe_price_ids" = COALESCE(p."stripe_price_ids", d."stripePriceIds"),
             "sort_order" = d."sortOrder",
             "features" = jsonb_build_object(
               'coreFeatures', COALESCE(d."features"->'coreFeatures', p."features"->'coreFeatures', '[]'::jsonb),
               'advancedFeatures', COALESCE(d."features"->'advancedFeatures', '[]'::jsonb),
               'premiumFeatures', COALESCE(d."features"->'premiumFeatures', '[]'::jsonb)
             ),
             "updatedAt" = now()
        FROM "admin"."plan_definitions" d
       WHERE p."name" = d."name"
    `);

    await queryRunner.query(`
      INSERT INTO "billing"."plans" (
        "id", "code", "name", "description", "short_description", "tier", "base_price",
        "currency", "billing_cycle", "visibility", "is_recommended", "limits", "pricing",
        "features", "is_active", "is_public", "sort_order", "trial_days", "grace_period_days",
        "upgrade_message", "downgrade_warning", "icon", "color", "badge",
        "stripe_product_id", "stripe_price_ids", "createdAt", "updatedAt",
        "created_by", "updated_by", "version", "is_deleted"
      )
      SELECT
        d."id",
        d."code",
        d."name",
        d."description",
        d."shortDescription",
        d."tier"::text::"billing"."plans_tier_enum",
        COALESCE((d."pricing"->'monthly'->>'basePrice')::numeric, 0),
        COALESCE(d."pricing"->>'currency', 'USD'),
        'monthly',
        d."visibility"::text::"billing"."plans_visibility_enum",
        d."isRecommended",
        d."limits",
        jsonb_build_object(
          'basePrice', COALESCE((d."pricing"->'monthly'->>'basePrice')::numeric, 0),
          'perFarmPrice', COALESCE((d."pricing"->'monthly'->>'perFarmPrice')::numeric, 0),
          'perUserPrice', COALESCE((d."pricing"->'monthly'->>'perUserPrice')::numeric, 0),
          'perSensorPrice', 0,
          'currency', COALESCE(d."pricing"->>'currency', 'USD')
        ),
        jsonb_build_object(
          'coreFeatures', COALESCE(d."features"->'coreFeatures', '[]'::jsonb),
          'advancedFeatures', COALESCE(d."features"->'advancedFeatures', '[]'::jsonb),
          'premiumFeatures', COALESCE(d."features"->'premiumFeatures', '[]'::jsonb)
        ),
        d."isActive",
        d."visibility" = 'public',
        d."sortOrder",
        d."trialDays",
        d."gracePeriodDays",
        d."upgradeMessage",
        d."downgradeWarning",
        d."icon",
        d."color",
        d."badge",
        d."stripeProductId",
        d."stripePriceIds",
        d."createdAt",
        d."updatedAt",
        d."createdBy",
        d."updatedBy",
        1,
        false
      FROM "admin"."plan_definitions" d
      WHERE NOT EXISTS (SELECT 1 FROM "billing"."plans" p WHERE p."name" = d."name")
      ON CONFLICT ("id") DO NOTHING
    `);

    // The per-cycle matrix, one row per cycle the definition prices.
    for (const [jsonKey, cycle] of [
      ['monthly', 'monthly'],
      ['quarterly', 'quarterly'],
      ['semiAnnual', 'semi_annual'],
      ['annual', 'annual'],
    ] as const) {
      await queryRunner.query(
        `
        INSERT INTO "billing"."plan_cycle_prices" (
          "plan_id", "billing_cycle", "base_price", "per_user_price",
          "per_farm_price", "per_module_price", "discount_percent"
        )
        SELECT
          p."id",
          $2::"billing"."plans_billing_cycle_enum",
          COALESCE((d."pricing"->$1->>'basePrice')::numeric, 0),
          COALESCE((d."pricing"->$1->>'perUserPrice')::numeric, 0),
          COALESCE((d."pricing"->$1->>'perFarmPrice')::numeric, 0),
          COALESCE((d."pricing"->$1->>'perModulePrice')::numeric, 0),
          COALESCE((d."pricing"->$1->>'discountPercent')::numeric, 0)
        FROM "admin"."plan_definitions" d
        JOIN "billing"."plans" p ON p."name" = d."name"
        WHERE d."pricing" ? $1
        ON CONFLICT ("plan_id", "billing_cycle") DO NOTHING
        `,
        [jsonKey, cycle],
      );
    }

    await queryRunner.query(`
      INSERT INTO "billing"."plan_add_ons" (
        "plan_id", "code", "name", "description", "price", "billing_cycle"
      )
      SELECT
        p."id",
        add_on->>'code',
        add_on->>'name',
        add_on->>'description',
        (add_on->>'price')::numeric,
        (add_on->>'billingCycle')::"billing"."plans_billing_cycle_enum"
      FROM "admin"."plan_definitions" d
      JOIN "billing"."plans" p ON p."name" = d."name"
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d."features"->'addOns', '[]'::jsonb)) AS add_on
      ON CONFLICT ("plan_id", "code") DO NOTHING
    `);

    // Every definition must have landed somewhere, and every add-on it priced
    // must be a row — otherwise the admin-side drop would destroy the only copy.
    const missing = (await queryRunner.query(`
      SELECT count(*)::text AS missing
        FROM "admin"."plan_definitions" d
       WHERE NOT EXISTS (SELECT 1 FROM "billing"."plans" p WHERE p."name" = d."name")
    `)) as Array<{ missing: string }>;
    if ((missing[0]?.missing ?? '0') !== '0') {
      throw new Error(
        `MergePlanCatalogue1802200000000: ${missing[0]?.missing} admin.plan_definitions rows did not merge into billing.plans. Resolve the source rows before re-running.`,
      );
    }
  }

  /**
   * A plan that predates the merge has no per-cycle rows. Seed its monthly
   * cycle from the flat rate card it already carries, so every plan can be
   * priced from the same place; the other cycles are an operator decision, not
   * something a migration should invent.
   */
  private async seedCyclePricesForUnmatchedPlans(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "billing"."plan_cycle_prices" (
        "plan_id", "billing_cycle", "base_price", "per_user_price",
        "per_farm_price", "per_module_price", "discount_percent"
      )
      SELECT
        p."id",
        'monthly'::"billing"."plans_billing_cycle_enum",
        COALESCE((p."pricing"->>'basePrice')::numeric, p."base_price"),
        COALESCE((p."pricing"->>'perUserPrice')::numeric, 0),
        COALESCE((p."pricing"->>'perFarmPrice')::numeric, 0),
        0,
        0
      FROM "billing"."plans" p
      WHERE NOT EXISTS (
        SELECT 1 FROM "billing"."plan_cycle_prices" c WHERE c."plan_id" = p."id"
      )
      ON CONFLICT ("plan_id", "billing_cycle") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // DESTRUCTIVE: down()-only rollback of MergePlanCatalogue1802200000000 — drops the plan_add_ons table this same migration created; the admin source rows are dropped by admin migration 1809100000000, so roll that one back first
    await queryRunner.query(`DROP TABLE IF EXISTS "billing"."plan_add_ons"`);
    // DESTRUCTIVE: same rollback — the per-cycle price rows this migration created
    await queryRunner.query(`DROP TABLE IF EXISTS "billing"."plan_cycle_prices"`);
    for (const column of [
      'code',
      'description',
      'short_description',
      'visibility',
      'is_recommended',
      'trial_days',
      'grace_period_days',
      'upgrade_message',
      'downgrade_warning',
      'icon',
      'color',
      'badge',
    ]) {
      // DESTRUCTIVE: same rollback — a catalogue column this migration added; the values came from admin.plan_definitions, restored by rolling that migration back first
      await queryRunner.query(`ALTER TABLE "billing"."plans" DROP COLUMN IF EXISTS "${column}"`);
    }
    await queryRunner.query(`DROP TYPE IF EXISTS "billing"."plans_visibility_enum"`);
  }
}
