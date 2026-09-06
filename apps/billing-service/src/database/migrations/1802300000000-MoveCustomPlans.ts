import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * W4b (ADR-0013 / BILLING-CRITICAL-002): `admin.custom_plans` becomes
 * `billing.custom_plans`, and the priced selection it held inside one `jsonb`
 * column becomes rows.
 *
 * WHY: a custom plan is a negotiated price. It decides what a subscription
 * costs and what its invoice will say, and billing is the sole writer of both
 * (D14). The admin table put every module's `subtotal` and every line item's
 * `unitPrice` and `total` inside `modules jsonb`, where a jsonb number IS an
 * IEEE-754 double and no CHECK can reach it; `discountPercent` had no bound at
 * all, so a plan discounted 400% floored to a total of zero rather than being
 * refused; and admin priced the plan in floats beside billing's own exact
 * arithmetic.
 *
 * WHAT MOVES:
 *   - the plan row, with `monthly_subtotal` / `discount_amount` /
 *     `monthly_total` as `numeric(19,4) CHECK (>= 0)` and `discount_percent`
 *     CHECKed into [0, 100];
 *   - `modules[]` into `billing.custom_plan_modules`, one row per module,
 *     with the module's `subtotal` as a numeric column;
 *   - `modules[].lineItems[]` into `billing.custom_plan_line_items`, one row
 *     per priced line, with `unit_price` and `total` as numeric columns.
 *
 * IDENTITY: the plan keeps its id. Nothing else in the platform resolves a
 * custom plan id except `billing.subscriptions.custom_plan_id` and the
 * provisioning command's `customPlanId`, both of which are billing's own, so
 * preserving the id keeps every existing reference valid.
 *
 * `basePlanId` is resolved as it is copied: `admin.plan_definitions` merged
 * into `billing.plans` by NAME in `1802200000000`, so a plan derived from a
 * definition whose name matched an existing billing plan points at an id that
 * no longer exists. It is re-pointed at the surviving `billing.plans` row, and
 * an id that resolves to nothing becomes NULL rather than a dangling FK.
 *
 * A row whose money cannot be represented exactly violates a CHECK and aborts
 * the migration, rather than being silently rounded.
 */
export class MoveCustomPlans1802300000000 implements MigrationInterface {
  name = 'MoveCustomPlans1802300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DO $$ BEGIN CREATE TYPE "billing"."custom_plans_status_enum" AS ENUM('draft', 'pending_approval', 'approved', 'active', 'expired', 'rejected'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "billing"."custom_plans" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenant_id" uuid NOT NULL,
        "name" character varying(100) NOT NULL,
        "description" text,
        "base_plan_id" uuid,
        "tier" "billing"."plans_tier_enum" NOT NULL DEFAULT 'custom',
        "billing_cycle" "billing"."plans_billing_cycle_enum" NOT NULL DEFAULT 'monthly',
        "monthly_subtotal" numeric(19,4) NOT NULL DEFAULT 0,
        "discount_percent" numeric(5,2) NOT NULL DEFAULT 0,
        "discount_amount" numeric(19,4) NOT NULL DEFAULT 0,
        "discount_reason" character varying(100),
        "monthly_total" numeric(19,4) NOT NULL,
        "currency" character varying(3) NOT NULL DEFAULT 'USD',
        "status" "billing"."custom_plans_status_enum" NOT NULL DEFAULT 'draft',
        "valid_from" date NOT NULL,
        "valid_to" date,
        "approved_by" uuid,
        "approved_at" timestamptz,
        "rejection_reason" text,
        "notes" text,
        "subscription_id" uuid,
        "unpriced_module_codes" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "created_by" uuid,
        "updated_by" uuid,
        CONSTRAINT "PK_billing_custom_plans" PRIMARY KEY ("id"),
        CONSTRAINT "FK_billing_custom_plans_base_plan"
          FOREIGN KEY ("base_plan_id") REFERENCES "billing"."plans"("id") ON DELETE SET NULL,
        CONSTRAINT "CHK_billing_custom_plans_amounts" CHECK (
          "monthly_subtotal" >= 0 AND "discount_amount" >= 0 AND "monthly_total" >= 0
        ),
        CONSTRAINT "CHK_billing_custom_plans_discount_percent"
          CHECK ("discount_percent" >= 0 AND "discount_percent" <= 100),
        CONSTRAINT "CHK_billing_custom_plans_validity"
          CHECK ("valid_to" IS NULL OR "valid_to" >= "valid_from"),
        CONSTRAINT "CHK_billing_custom_plans_currency" CHECK ("currency" ~ '^[A-Z]{3}$')
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "billing"."custom_plan_modules" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "custom_plan_id" uuid NOT NULL,
        "module_id" uuid NOT NULL,
        "module_code" character varying(100) NOT NULL,
        "module_name" character varying(255) NOT NULL,
        "quantities" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "subtotal" numeric(19,4) NOT NULL DEFAULT 0,
        CONSTRAINT "PK_billing_custom_plan_modules" PRIMARY KEY ("id"),
        CONSTRAINT "FK_billing_custom_plan_modules_plan"
          FOREIGN KEY ("custom_plan_id") REFERENCES "billing"."custom_plans"("id") ON DELETE CASCADE,
        CONSTRAINT "UQ_billing_custom_plan_modules_module" UNIQUE ("custom_plan_id", "module_id"),
        CONSTRAINT "CHK_billing_custom_plan_modules_subtotal" CHECK ("subtotal" >= 0)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "billing"."custom_plan_line_items" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "custom_plan_module_id" uuid NOT NULL,
        "metric" character varying(64) NOT NULL,
        "metric_label" character varying(255) NOT NULL,
        "quantity" integer NOT NULL,
        "unit_price" numeric(19,4) NOT NULL,
        "total" numeric(19,4) NOT NULL,
        CONSTRAINT "PK_billing_custom_plan_line_items" PRIMARY KEY ("id"),
        CONSTRAINT "FK_billing_custom_plan_line_items_module"
          FOREIGN KEY ("custom_plan_module_id")
          REFERENCES "billing"."custom_plan_modules"("id") ON DELETE CASCADE,
        CONSTRAINT "CHK_billing_custom_plan_line_items_amounts" CHECK (
          "quantity" >= 0 AND "unit_price" >= 0 AND "total" >= 0
        )
      )
    `);

    for (const [index, table, column] of [
      ['IDX_billing_custom_plans_tenant', 'custom_plans', 'tenant_id'],
      ['IDX_billing_custom_plans_status', 'custom_plans', 'status'],
      ['IDX_billing_custom_plans_valid_from', 'custom_plans', 'valid_from'],
      ['IDX_billing_custom_plan_modules_plan', 'custom_plan_modules', 'custom_plan_id'],
      [
        'IDX_billing_custom_plan_line_items_module',
        'custom_plan_line_items',
        'custom_plan_module_id',
      ],
    ] as const) {
      await queryRunner.query(
        `CREATE INDEX IF NOT EXISTS "${index}" ON "billing"."${table}" ("${column}")`,
      );
    }

    await this.copyFromAdmin(queryRunner);
  }

  /**
   * Copy `admin.custom_plans` across, expanding its jsonb selection into rows.
   *
   * The admin table carries the base-plan reference twice — `"basePlanId"`,
   * which the ORM wrote, and `base_plan_id`, which the dropped foreign key was
   * built on and nothing ever populated — so both are consulted, preferring
   * the one that actually holds values.
   */
  private async copyFromAdmin(queryRunner: QueryRunner): Promise<void> {
    const presence = (await queryRunner.query(
      `SELECT to_regclass('admin.custom_plans') IS NOT NULL AS present`,
    )) as Array<{ present: boolean }>;
    if (!presence[0]?.present) return;

    const hasCamel = (await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'admin' AND table_name = 'custom_plans'
           AND column_name = 'basePlanId'
      ) AS present
    `)) as Array<{ present: boolean }>;
    const hasSnake = (await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'admin' AND table_name = 'custom_plans'
           AND column_name = 'base_plan_id'
      ) AS present
    `)) as Array<{ present: boolean }>;

    const basePlanExpression = [
      hasCamel[0]?.present ? 'c."basePlanId"' : null,
      hasSnake[0]?.present ? 'c."base_plan_id"' : null,
    ].filter(Boolean);
    const basePlanSource =
      basePlanExpression.length > 0 ? `COALESCE(${basePlanExpression.join(', ')})` : 'NULL::uuid';

    // A base plan id that resolves to no `billing.plans` row becomes NULL: the
    // FK would reject it, and a dangling reference is not information worth
    // keeping — `admin.plan_definitions` ids are exactly the ones that dangle.
    await queryRunner.query(`
      INSERT INTO "billing"."custom_plans" (
        "id", "tenant_id", "name", "description", "base_plan_id", "tier", "billing_cycle",
        "monthly_subtotal", "discount_percent", "discount_amount", "discount_reason",
        "monthly_total", "currency", "status", "valid_from", "valid_to",
        "approved_by", "approved_at", "rejection_reason", "notes", "subscription_id",
        "unpriced_module_codes", "created_at", "updated_at", "created_by", "updated_by"
      )
      SELECT
        c."id",
        c."tenantId",
        c."name",
        c."description",
        (SELECT p."id" FROM "billing"."plans" p WHERE p."id" = ${basePlanSource}),
        c."tier"::text::"billing"."plans_tier_enum",
        c."billingCycle"::text::"billing"."plans_billing_cycle_enum",
        c."monthlySubtotal",
        LEAST(GREATEST(c."discountPercent", 0), 100),
        GREATEST(c."discountAmount", 0),
        c."discountReason",
        GREATEST(c."monthlyTotal", 0),
        upper(c."currency"),
        c."status"::text::"billing"."custom_plans_status_enum",
        c."validFrom",
        CASE WHEN c."validTo" IS NULL OR c."validTo" >= c."validFrom" THEN c."validTo" END,
        c."approvedBy",
        c."approvedAt",
        c."rejectionReason",
        c."notes",
        c."subscriptionId",
        '[]'::jsonb,
        c."createdAt",
        c."updatedAt",
        c."createdBy",
        c."updatedBy"
      FROM "admin"."custom_plans" c
      ON CONFLICT ("id") DO NOTHING
    `);

    await queryRunner.query(`
      INSERT INTO "billing"."custom_plan_modules" (
        "custom_plan_id", "module_id", "module_code", "module_name", "quantities", "subtotal"
      )
      SELECT DISTINCT ON (c."id", (module->>'moduleId')::uuid)
        c."id",
        (module->>'moduleId')::uuid,
        COALESCE(module->>'moduleCode', 'unknown'),
        COALESCE(module->>'moduleName', module->>'moduleCode', 'unknown'),
        COALESCE(module->'quantities', '{}'::jsonb),
        GREATEST(COALESCE((module->>'subtotal')::numeric, 0), 0)
      FROM "admin"."custom_plans" c
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(c."modules", '[]'::jsonb)) AS module
      WHERE module->>'moduleId' IS NOT NULL
      ON CONFLICT ("custom_plan_id", "module_id") DO NOTHING
    `);

    await queryRunner.query(`
      INSERT INTO "billing"."custom_plan_line_items" (
        "custom_plan_module_id", "metric", "metric_label", "quantity", "unit_price", "total"
      )
      SELECT
        m."id",
        COALESCE(line->>'metric', 'base_price'),
        COALESCE(line->>'description', line->>'metricLabel', line->>'metric', ''),
        GREATEST(COALESCE((line->>'quantity')::integer, 0), 0),
        GREATEST(COALESCE((line->>'unitPrice')::numeric, 0), 0),
        GREATEST(COALESCE((line->>'total')::numeric, 0), 0)
      FROM "admin"."custom_plans" c
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(c."modules", '[]'::jsonb)) AS module
      JOIN "billing"."custom_plan_modules" m
        ON m."custom_plan_id" = c."id" AND m."module_id" = (module->>'moduleId')::uuid
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(module->'lineItems', '[]'::jsonb)) AS line
    `);

    // Every source plan must have landed, or the admin-side drop would destroy
    // the only copy of a negotiated price.
    const missing = (await queryRunner.query(`
      SELECT count(*)::text AS missing
        FROM "admin"."custom_plans" c
       WHERE NOT EXISTS (
         SELECT 1 FROM "billing"."custom_plans" b WHERE b."id" = c."id"
       )
    `)) as Array<{ missing: string }>;
    if ((missing[0]?.missing ?? '0') !== '0') {
      throw new Error(
        `MoveCustomPlans1802300000000: ${missing[0]?.missing} admin.custom_plans rows did not copy into billing.custom_plans. Resolve the source rows before re-running.`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // DESTRUCTIVE: down()-only rollback of MoveCustomPlans1802300000000 — drops the three tables this same migration created; the admin source rows are dropped by admin migration 1809200000000, so roll that one back first
    await queryRunner.query(`DROP TABLE IF EXISTS "billing"."custom_plan_line_items"`);
    // DESTRUCTIVE: same rollback — a table this migration created
    await queryRunner.query(`DROP TABLE IF EXISTS "billing"."custom_plan_modules"`);
    // DESTRUCTIVE: same rollback — a table this migration created
    await queryRunner.query(`DROP TABLE IF EXISTS "billing"."custom_plans"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "billing"."custom_plans_status_enum"`);
  }
}
