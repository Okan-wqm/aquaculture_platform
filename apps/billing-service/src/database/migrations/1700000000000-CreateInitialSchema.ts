import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationLogger } from '@aquaculture/backend-common/database';

/**
 * CreateInitialSchema1700000000000
 * ============================================================================
 *
 * Restores the billing-service migration baseline that never existed in
 * source. On a fresh-volume bootstrap (init scripts mounted, but only
 * supplying the legacy partial set: `subscriptions`, `subscription_module_items`,
 * `invoices` from `04-billing-tables.sql`), the remaining migration chain
 * (1744400000000+) assumes baseline tables/columns that no creation step
 * ever provided. Concrete failure on a fresh DB:
 * `1744400000000-AddPlanSoftDeleteColumns` ALTERs `billing.plans` which
 * was never created. Three downstream migrations have the same shape:
 * `1788400000000` adds FKs to `billing.scheduled_plan_changes`,
 * `1788500000000` creates `billing.stripe_webhook_events` (already
 * idempotent so re-running it is fine) and the entity surface assumes
 * `billing.payments` and `billing.tenant_usage_metrics` exist.
 *
 * # Scope
 *
 *   Create 5 missing `billing.*` tables idempotently:
 *     plans, payments, tenant_usage_metrics, scheduled_plan_changes,
 *     stripe_webhook_events.
 *
 * Tables already created by `infrastructure/docker/init-scripts/04-billing-tables.sql`
 * (subscriptions, subscription_module_items, invoices) are NOT re-created
 * here — that boundary is owned by the init script. This migration only
 * fills the gap between the init-script snapshot and the current entity
 * surface.
 *
 * # Idempotency
 *
 * Every DDL statement uses `IF NOT EXISTS` (tables, columns, indexes) and
 * `DO $$ ... EXCEPTION WHEN duplicate_object` blocks for enum types. A
 * second run is a no-op. The `stripe_webhook_events` table is created
 * here with the same shape that `1788500000000-CreateStripeWebhookDedup`
 * later expects — that migration's `CREATE TABLE IF NOT EXISTS` becomes a
 * no-op on fresh DBs and a duplicate-safe re-create on legacy ones.
 * Likewise the `plans` table is created here WITH the soft-delete columns
 * (`is_deleted`, `deleted_at`, `deleted_by`) so the later
 * `1744400000000-AddPlanSoftDeleteColumns` `ADD COLUMN IF NOT EXISTS`
 * steps are no-ops.
 *
 * # Order
 *
 * Tables are created in topological order (parents before FK children):
 *   plans, tenant_usage_metrics, stripe_webhook_events  (no billing.* FKs)
 *     -> payments (FK to invoices, which the init script already created)
 *     -> scheduled_plan_changes (FKs to subscriptions + plans installed
 *        by 1788400000000-AddScheduledPlanChangeFks; this migration only
 *        creates the table without FKs).
 *
 * # Why TIMESTAMPTZ for every date column
 *
 * Matches the entity decorators (`type: 'timestamptz'`). The billing
 * schema standardises on TIMESTAMPTZ across the board.
 *
 * # Why per-table CREATE TABLE + CREATE INDEX bundled in one query call
 *
 * `tools/gates/migration-sql-lint.ts` rule R3 (create-index-not-concurrent)
 * flags non-CONCURRENTLY `CREATE INDEX` on pre-existing tables. The linter
 * scans each `queryRunner.query(...)` call as one SQL chunk and exempts a
 * `CREATE INDEX` if a sibling `CREATE TABLE` lives in the same chunk
 * (the just-created-table is empty and non-concurrent indexing is safe).
 * We bundle accordingly. R5 (overbroad-exception-catch) bans
 * `EXCEPTION WHEN others THEN NULL`; we use only `duplicate_object`.
 *
 * Closes: docs/plans/bootstrap-restoration-and-factory-reset-2026-05-07.md
 */
export class CreateInitialSchema1700000000000 implements MigrationInterface {
  name = 'CreateInitialSchema1700000000000';
  private readonly logger = new MigrationLogger(this.name);

  public async up(queryRunner: QueryRunner): Promise<void> {
    this.logger.log(
      'Creating baseline billing.* tables (5): plans, payments, ' +
        'tenant_usage_metrics, scheduled_plan_changes, stripe_webhook_events',
    );

    // The billing schema itself is created by infrastructure/docker/init-scripts.
    // Defensive guard for direct CLI runs against a bare database — this is a
    // no-op when the schema already exists.
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS billing`);

    await this.createEnumTypes(queryRunner);
    await this.createPlansTable(queryRunner);
    await this.createTenantUsageMetricsTable(queryRunner);
    await this.createStripeWebhookEventsTable(queryRunner);
    await this.createPaymentsTable(queryRunner);
    await this.createScheduledPlanChangesTable(queryRunner);

    this.logger.log('Baseline billing schema initialised.');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse FK order — children first, then parents, then the enum
    // types. Init-script-owned tables (subscriptions, subscription_module_items,
    // invoices) are NOT touched.
    this.logger.warn(
      'Reverting baseline billing.* tables. This is destructive and is ' +
        'intended for ephemeral test environments only.',
    );

    const tablesInDropOrder = [
      'scheduled_plan_changes',
      'payments',
      'stripe_webhook_events',
      'tenant_usage_metrics',
      'plans',
    ];

    for (const table of tablesInDropOrder) {
      await queryRunner.query(`DROP TABLE IF EXISTS billing."${table}" CASCADE`);
    }

    // Drop enum types last — table drops above already removed dependent
    // columns, so these should be free.
    const enumTypes = [
      'plans_tier_enum',
      'plans_billing_cycle_enum',
      'payments_status_enum',
      'payments_payment_method_enum',
      'tenant_usage_metrics_periodtype_enum',
      'scheduled_plan_changes_status_enum',
    ];
    for (const enumType of enumTypes) {
      await queryRunner.query(
        `DROP TYPE IF EXISTS billing."${enumType}" CASCADE`,
      );
    }
  }

  /**
   * Create Postgres enum types used by the plans / payments /
   * tenant_usage_metrics / scheduled_plan_changes tables.
   *
   * Enum names follow TypeORM's `{table}_{column}_enum` auto-generation
   * convention (lowercase, no camelCase) so SchemaDriftValidator's
   * `resolveEnumTypeName` finds exactly these types when it introspects
   * pg_enum.
   *
   * `DO $$ ... EXCEPTION WHEN duplicate_object` makes each block
   * idempotent without depending on `CREATE TYPE IF NOT EXISTS` (which
   * Postgres does not support). Note: the `subscription_status`,
   * `billing_cycle`, `plan_tier`, `invoice_status` enums in the public
   * schema are created by `04-billing-tables.sql` for the subscriptions/
   * invoices tables and are NOT re-created here. The plans table uses
   * its own `billing.plans_tier_enum` / `billing.plans_billing_cycle_enum`
   * so the schema-qualified entity decorator's TypeORM-generated names
   * resolve correctly.
   */
  private async createEnumTypes(queryRunner: QueryRunner): Promise<void> {
    const enums: ReadonlyArray<{ name: string; values: readonly string[] }> = [
      // plan.entity.ts: PlanTier (subscription.entity.ts) / BillingCycle
      { name: 'plans_tier_enum', values: ['starter', 'professional', 'enterprise', 'custom'] },
      { name: 'plans_billing_cycle_enum', values: ['monthly', 'quarterly', 'semi_annual', 'annual'] },
      // payment.entity.ts: PaymentStatus / PaymentMethod
      {
        name: 'payments_status_enum',
        values: ['pending', 'processing', 'succeeded', 'failed', 'cancelled', 'refunded', 'partially_refunded'],
      },
      {
        name: 'payments_payment_method_enum',
        values: [
          'credit_card',
          'debit_card',
          'bank_transfer',
          'wire_transfer',
          'ach',
          'sepa',
          'paypal',
          'check',
          'cash',
          'other',
        ],
      },
      // tenant-usage-metrics.entity.ts: UsagePeriodType (column dbName: periodType -> periodtype)
      {
        name: 'tenant_usage_metrics_periodtype_enum',
        values: ['daily', 'weekly', 'monthly', 'billing_period'],
      },
      // scheduled-plan-change.entity.ts: ScheduledChangeStatus
      {
        name: 'scheduled_plan_changes_status_enum',
        values: ['PENDING', 'APPLIED', 'CANCELLED'],
      },
    ];

    for (const enumType of enums) {
      const literals = enumType.values.map((v) => `'${v}'`).join(', ');
      await queryRunner.query(`
        DO $$ BEGIN
          CREATE TYPE billing."${enumType.name}" AS ENUM (${literals});
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$
      `);
    }
  }

  /**
   * billing.plans — billing/entities/plan.entity.ts
   *
   * Soft-delete columns (is_deleted, deleted_at, deleted_by) are created
   * inline here so the later 1744400000000-AddPlanSoftDeleteColumns
   * `ADD COLUMN IF NOT EXISTS` steps become no-ops on fresh DBs. The
   * partial index `idx_plan_is_deleted_partial` is also created here for
   * the same reason.
   *
   * MoneyColumn renders as `numeric(19,4)` — the `MoneyColumn` decorator
   * in @aquaculture/backend-common/monetary uses `type: 'numeric',
   * precision: 19, scale: 4` with a Decimal.js transformer.
   */
  private async createPlansTable(queryRunner: QueryRunner): Promise<void> {
    // CREATE TABLE + sibling indexes bundled per R3 lint chunk rule.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS billing.plans (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "name" varchar(100) NOT NULL,
        "tier" billing.plans_tier_enum NOT NULL,
        "base_price" numeric(19, 4) NOT NULL,
        "currency" varchar(3) NOT NULL DEFAULT 'USD',
        "billing_cycle" billing.plans_billing_cycle_enum NOT NULL DEFAULT 'monthly',
        "limits" jsonb NOT NULL,
        "pricing" jsonb NOT NULL,
        "features" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "is_active" boolean NOT NULL DEFAULT true,
        "is_public" boolean NOT NULL DEFAULT true,
        "sort_order" integer NOT NULL DEFAULT 0,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW(),
        "created_by" varchar,
        "updated_by" varchar,
        "version" integer NOT NULL DEFAULT 1,
        "is_deleted" boolean NOT NULL DEFAULT false,
        "deleted_at" timestamptz NULL,
        "deleted_by" varchar NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_plans_name"
        ON billing.plans ("name");
      CREATE INDEX IF NOT EXISTS "IDX_plans_tier"
        ON billing.plans ("tier");
      CREATE INDEX IF NOT EXISTS "IDX_plans_is_active"
        ON billing.plans ("is_active");
      CREATE INDEX IF NOT EXISTS "IDX_plans_is_public"
        ON billing.plans ("is_public");
      CREATE INDEX IF NOT EXISTS "IDX_plans_sort_order"
        ON billing.plans ("sort_order");
      CREATE INDEX IF NOT EXISTS idx_plan_is_deleted_partial
        ON billing.plans ("is_deleted")
        WHERE "is_deleted" = false;
    `);
  }

  /**
   * billing.tenant_usage_metrics — billing/entities/tenant-usage-metrics.entity.ts
   *
   * Per-tenant per-module usage rollup, keyed by (tenantId, moduleId,
   * periodStart, periodType) — composite UNIQUE matches the @Unique
   * decorator on the entity. Used for usage-based billing and overage
   * calculations.
   *
   * `calculatedCost` uses `decimal(12, 2)` directly (not MoneyColumn) per
   * the entity's `@Column('decimal', { precision: 12, scale: 2, ...
   * transformer: new DecimalTransformer() })`.
   */
  private async createTenantUsageMetricsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    // CREATE TABLE + sibling indexes bundled per R3 lint chunk rule.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS billing.tenant_usage_metrics (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "module_id" uuid,
        "moduleCode" varchar(50),
        "periodType" billing.tenant_usage_metrics_periodtype_enum NOT NULL,
        "periodStart" date NOT NULL,
        "periodEnd" date NOT NULL,
        "metrics" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "calculatedCost" decimal(12, 2),
        "includedQuantities" jsonb,
        "overageQuantities" jsonb,
        "isFinalized" boolean NOT NULL DEFAULT false,
        "finalizedAt" timestamptz,
        "invoiceId" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT "UQ_tenant_usage_metrics_tenant_module_period"
          UNIQUE ("tenant_id", "module_id", "periodStart", "periodType")
      );
      CREATE INDEX IF NOT EXISTS "IDX_tenant_usage_metrics_tenant_id"
        ON billing.tenant_usage_metrics ("tenant_id");
      CREATE INDEX IF NOT EXISTS "IDX_tenant_usage_metrics_module_id"
        ON billing.tenant_usage_metrics ("module_id");
      CREATE INDEX IF NOT EXISTS "IDX_tenant_usage_metrics_periodStart"
        ON billing.tenant_usage_metrics ("periodStart");
      CREATE INDEX IF NOT EXISTS "IDX_tenant_usage_metrics_periodType"
        ON billing.tenant_usage_metrics ("periodType");
    `);
  }

  /**
   * billing.stripe_webhook_events — billing/entities/stripe-webhook-event.entity.ts
   *
   * Persistent dedup table — INSERT-on-receive is the dedup primitive.
   * Created here with the same shape that the later
   * 1788500000000-CreateStripeWebhookDedup migration expects so its
   * `CREATE TABLE IF NOT EXISTS` becomes a no-op on fresh DBs.
   *
   * `event_id` is the PRIMARY KEY (Stripe's globally-unique `evt_*`
   * identifier) — this IS the dedup primitive. Concurrent or replayed
   * webhook deliveries fail on UNIQUE_VIOLATION (SQLSTATE 23505) and the
   * controller returns 200 OK.
   */
  private async createStripeWebhookEventsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    // CREATE TABLE + sibling indexes bundled per R3 lint chunk rule.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS billing.stripe_webhook_events (
        "event_id" varchar(255) PRIMARY KEY,
        "event_type" varchar(64) NOT NULL,
        "received_at" timestamptz NOT NULL DEFAULT NOW(),
        "processed_at" timestamptz,
        "outcome" varchar(32) NOT NULL DEFAULT 'pending'
      );
      CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_type_received
        ON billing.stripe_webhook_events ("event_type", "received_at" DESC);
    `);
  }

  /**
   * billing.payments — billing/entities/payment.entity.ts
   *
   * Payment record (FK to invoices). The FK to billing.invoices is
   * installed by 1788300000000-AddBillingFksExplicitOnDelete with
   * explicit ON DELETE RESTRICT. We do NOT install the FK here — that
   * migration's lookup-and-replace pattern needs the FK to be absent at
   * its run time on fresh DBs. Pre-existing TypeORM auto-FKs would be
   * dropped by 1788300000000 anyway; on fresh DBs the explicit FK is the
   * first one installed.
   *
   * Soft-delete columns (deleted_at, deleted_by) are added by
   * 1786300000000-ConvergeTenantIdAndAddSoftDelete via `ADD COLUMN IF
   * NOT EXISTS` — we DO create them inline here so that migration's step
   * is a no-op on fresh DBs (the entity's `is_deleted` partial index is
   * also installed inline). MoneyColumn renders as `numeric(19, 4)`.
   *
   * The partial unique on `stripe_payment_intent_id` (where IS NOT NULL)
   * matches the entity's `@Index('IDX_payment_stripe_pi', { unique: true,
   * where: '"stripe_payment_intent_id" IS NOT NULL' })`.
   *
   * Composite unique on (tenant_id, transaction_id) matches the entity's
   * `@Index(['tenantId', 'transactionId'], { unique: true })`.
   */
  private async createPaymentsTable(queryRunner: QueryRunner): Promise<void> {
    // CREATE TABLE + sibling indexes bundled per R3 lint chunk rule.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS billing.payments (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "transaction_id" varchar NOT NULL,
        "invoice_id" uuid NOT NULL,
        "amount" numeric(19, 4) NOT NULL,
        "currency" varchar NOT NULL DEFAULT 'USD',
        "status" billing.payments_status_enum NOT NULL DEFAULT 'pending',
        "payment_method" billing.payments_payment_method_enum NOT NULL,
        "payment_method_details" jsonb,
        "payment_date" timestamptz NOT NULL,
        "processed_at" timestamptz,
        "failure_reason" text,
        "stripe_payment_intent_id" varchar,
        "stripe_charge_id" varchar,
        "refunds" jsonb,
        "refunded_amount" numeric(19, 4) NOT NULL DEFAULT 0,
        "notes" text,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW(),
        "created_by" varchar,
        "updated_by" varchar,
        "version" integer NOT NULL DEFAULT 1,
        "is_deleted" boolean NOT NULL DEFAULT false,
        "deleted_at" timestamptz NULL,
        "deleted_by" varchar NULL,
        CONSTRAINT "UQ_payments_tenant_transaction"
          UNIQUE ("tenant_id", "transaction_id")
      );
      CREATE INDEX IF NOT EXISTS "IDX_payments_tenant_status"
        ON billing.payments ("tenant_id", "status");
      CREATE INDEX IF NOT EXISTS "IDX_payments_tenant_paymentDate"
        ON billing.payments ("tenant_id", "payment_date");
      CREATE INDEX IF NOT EXISTS "IDX_payments_invoice_id"
        ON billing.payments ("invoice_id");
      CREATE INDEX IF NOT EXISTS "IDX_payments_is_deleted"
        ON billing.payments ("is_deleted");
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_payment_stripe_pi"
        ON billing.payments ("stripe_payment_intent_id")
        WHERE "stripe_payment_intent_id" IS NOT NULL;
    `);
  }

  /**
   * billing.scheduled_plan_changes — billing/entities/scheduled-plan-change.entity.ts
   *
   * Plan-change scheduling. The FKs to subscriptions(id) /
   * plans(id) are installed by 1788400000000-AddScheduledPlanChangeFks
   * — we do NOT install them here. That migration's pre-flight
   * orphan-check assumes no FK exists yet, so omitting the FK at create
   * time keeps both fresh-DB and re-run paths consistent.
   *
   * # currentPlanId / newPlanId column type
   *
   * The entity declares `@Column() currentPlanId!: string` (no explicit
   * `type:`). TypeORM's default for `string` is `varchar`, but the
   * downstream FK migration 1788400000000 attaches a FOREIGN KEY ON
   * billing.plans(id) — and plans(id) is `uuid`. PostgreSQL rejects an
   * FK between mismatched types ("foreign key constraint cannot be
   * implemented"). The entity's intent is uuid (the column stores plan
   * IDs which are uuid PKs). We create as `uuid` so the downstream FK
   * works on fresh DBs without a separate type-conversion migration.
   *
   * NOTE on entity-vs-spec ambiguity: `scheduled-plan-change.entity.ts:62-64`
   * and `:80-82` declare `@Column() currentPlanId!: string` /
   * `@Column() newPlanId!: string` without `type: 'uuid'`. The
   * subscriptionId column above uses `@Column({ type: 'uuid' })`
   * explicitly. The decorator omission appears to be an entity bug; we
   * follow the FK contract (uuid) over the literal decorator default
   * (varchar) because the downstream migration would otherwise fail.
   */
  private async createScheduledPlanChangesTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    // CREATE TABLE + sibling indexes bundled per R3 lint chunk rule.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS billing.scheduled_plan_changes (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "subscriptionId" uuid NOT NULL,
        "currentPlanId" uuid NOT NULL,
        "currentPlanTier" varchar NOT NULL,
        "newPlanId" uuid NOT NULL,
        "newPlanTier" varchar NOT NULL,
        "newPlanName" varchar NOT NULL,
        "newLimits" jsonb NOT NULL,
        "newPricing" jsonb NOT NULL,
        "status" billing.scheduled_plan_changes_status_enum NOT NULL DEFAULT 'PENDING',
        "effectiveDate" timestamptz NOT NULL,
        "reason" text,
        "scheduledBy" uuid,
        "appliedAt" timestamptz,
        "cancelledAt" timestamptz,
        "cancellationReason" text,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS "IDX_scheduled_plan_changes_tenantId"
        ON billing.scheduled_plan_changes ("tenantId");
      CREATE INDEX IF NOT EXISTS "IDX_scheduled_plan_changes_tenant_status"
        ON billing.scheduled_plan_changes ("tenantId", "status");
      CREATE INDEX IF NOT EXISTS "IDX_scheduled_plan_changes_effective_status"
        ON billing.scheduled_plan_changes ("effectiveDate", "status");
    `);
  }
}
