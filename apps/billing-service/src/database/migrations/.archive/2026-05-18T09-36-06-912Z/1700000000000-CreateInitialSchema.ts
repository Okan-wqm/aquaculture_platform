import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationLogger } from '@aquaculture/backend-common/database';

/**
 * CreateInitialSchema1700000000000
 * ============================================================================
 *
 * Restores the billing-service migration baseline that never existed in
 * source. After the Wave-2-C init-script slim-down (the legacy
 * `04-billing-tables.sql` is being retired), the migration chain
 * (1744400000000+) assumes baseline tables/columns that no creation step
 * ever provides. Concrete failure on a fresh DB:
 * `1744400000000-AddPlanSoftDeleteColumns` ALTERs `billing.plans` which
 * was never created. Three downstream migrations have the same shape:
 * `1788400000000` adds FKs to `billing.scheduled_plan_changes`,
 * `1788500000000` creates `billing.stripe_webhook_events` (already
 * idempotent so re-running it is fine) and the entity surface assumes
 * `billing.payments`, `billing.tenant_usage_metrics`, `billing.subscriptions`,
 * `billing.subscription_module_items`, and `billing.invoices` exist.
 *
 * # Scope
 *
 *   Create 8 `billing.*` tables idempotently (Wave 4-A.1 extends the
 *   original 5 with the 3 init-script-owned tables — subscriptions,
 *   subscription_module_items, invoices — so ownership is unambiguous
 *   after `04-billing-tables.sql` is retired):
 *     plans, payments, tenant_usage_metrics, scheduled_plan_changes,
 *     stripe_webhook_events,
 *     subscriptions, subscription_module_items, invoices.
 *
 * The 4 admin.* tables that `04-billing-tables.sql` also created
 * (module_pricing, analytics_snapshots, report_definitions,
 * report_executions) are owned by admin-api-service's baseline migration
 * and NOT touched here.
 *
 * # Why entity-canonical column names (snake_case)
 *
 * `subscription.entity.ts`, `invoice.entity.ts`, `payment.entity.ts`,
 * `subscription-module-item.entity.ts` declare every persisted column
 * with `@Column({ name: 'snake_case' })`. The legacy init script created
 * the same tables with camelCase identifiers (`"tenantId"`, `"isDeleted"`,
 * `"subscriptionId"`, ...) — this is documented schema drift that
 * SchemaDriftValidator surfaces at every cold start. The baseline
 * migration is the place to land the entity-canonical names so a fresh
 * DB starts free of drift.
 *
 * KNOWN-DRIFT-OUT-OF-SCOPE: migration `1788200000000-FixSubscriptionsTenantUniquePartial`
 * still queries `"tenantId"` / `"isDeleted"` (camelCase) — written
 * against the legacy column names before the entity moved to snake_case.
 * On a fresh DB built via THIS baseline, that migration's pre-flight
 * `SELECT "tenantId" ...` fails with `column "tenantId" does not exist`.
 * Fixing 1788200000000 is a separate orphan finding (BILLING-MIGR-DRIFT-001
 * in `docs/reviews/orphan-findings.md`) — out of Wave 4-A.1 scope.
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
 * steps are no-ops, and `subscriptions` / `invoices` / `payments` carry
 * `tenant_id uuid` + `deleted_at` + `deleted_by` inline so the later
 * `1786300000000-ConvergeTenantIdAndAddSoftDelete` lookup-by-data-type
 * branches are also no-ops.
 *
 * # Order
 *
 * Tables are created in topological order (parents before FK children):
 *   plans, tenant_usage_metrics, stripe_webhook_events  (no billing.* FKs)
 *   subscriptions                                       (parent of items, invoices, payments)
 *     -> subscription_module_items (FK to subscriptions, ON DELETE CASCADE,
 *        installed inline because no later migration touches this FK)
 *     -> invoices (FK to subscriptions installed by
 *        1788300000000-AddBillingFksExplicitOnDelete; created here without FK)
 *     -> payments (FK to invoices installed by
 *        1788300000000-AddBillingFksExplicitOnDelete; created here without FK)
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
      'Creating baseline billing.* tables (8): plans, tenant_usage_metrics, ' +
        'stripe_webhook_events, subscriptions, subscription_module_items, ' +
        'invoices, payments, scheduled_plan_changes',
    );

    // The billing schema itself is created by infrastructure/docker/init-scripts.
    // Defensive guard for direct CLI runs against a bare database — this is a
    // no-op when the schema already exists.
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS billing`);

    await this.createEnumTypes(queryRunner);
    await this.createPlansTable(queryRunner);
    await this.createTenantUsageMetricsTable(queryRunner);
    await this.createStripeWebhookEventsTable(queryRunner);
    await this.createSubscriptionsTable(queryRunner);
    await this.createSubscriptionModuleItemsTable(queryRunner);
    await this.createInvoicesTable(queryRunner);
    await this.createPaymentsTable(queryRunner);
    await this.createScheduledPlanChangesTable(queryRunner);

    this.logger.log('Baseline billing schema initialised.');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse FK order — children first, then parents, then the enum
    // types. Wave 4-A.1: subscriptions / subscription_module_items /
    // invoices are now owned by THIS migration (init script no longer
    // creates them) so we drop them too. CASCADE drops dependent FKs
    // installed by 1788300000000 / 1788400000000 in the same step.
    this.logger.warn(
      'Reverting baseline billing.* tables. This is destructive and is ' +
        'intended for ephemeral test environments only.',
    );

    const tablesInDropOrder = [
      // children first
      'scheduled_plan_changes',
      'payments',
      'invoices',
      'subscription_module_items',
      'subscriptions',
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
      // Wave 4-A.1 enums (created in billing schema, not public)
      'subscriptions_status_enum',
      'subscriptions_billing_cycle_enum',
      'subscriptions_plan_tier_enum',
      'subscription_module_items_status_enum',
      'invoices_status_enum',
    ];
    for (const enumType of enumTypes) {
      await queryRunner.query(
        `DROP TYPE IF EXISTS billing."${enumType}" CASCADE`,
      );
    }
  }

  /**
   * Create Postgres enum types used by the plans / payments /
   * tenant_usage_metrics / scheduled_plan_changes / subscriptions /
   * subscription_module_items / invoices tables.
   *
   * Enum names follow TypeORM's `{table}_{column}_enum` auto-generation
   * convention (lowercase, no camelCase) so SchemaDriftValidator's
   * `resolveEnumTypeName` finds exactly these types when it introspects
   * pg_enum.
   *
   * `DO $$ ... EXCEPTION WHEN duplicate_object` makes each block
   * idempotent without depending on `CREATE TYPE IF NOT EXISTS` (which
   * Postgres does not support).
   *
   * # Schema decision: enums live in `billing`, NOT `public`
   *
   * The legacy `04-billing-tables.sql` created `subscription_status`,
   * `billing_cycle`, `plan_tier`, `invoice_status` in the `public`
   * schema (no schema qualifier). Wave 4-A.1 instead places every
   * billing-owned enum in `billing.*` — this matches the
   * schema-qualified entity decorator pattern (`@Entity('subscriptions',
   * { schema: 'billing' })`) and avoids `public` namespace pollution
   * (CLAUDE.md ADR-011: never add to `public`). TypeORM resolves
   * unqualified enum names against the `search_path` which the
   * MigrationRunnerService pins to `billing, public` — so
   * `subscriptions_status_enum` resolves to `billing.subscriptions_status_enum`
   * for both new entity-driven INSERTs and SchemaDriftValidator
   * introspection.
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
      // subscription.entity.ts: SubscriptionStatus / BillingCycle / PlanTier
      // (separate from plans_*_enum because TypeORM auto-names per table)
      {
        name: 'subscriptions_status_enum',
        values: ['trial', 'active', 'past_due', 'cancelled', 'suspended', 'expired'],
      },
      {
        name: 'subscriptions_billing_cycle_enum',
        values: ['monthly', 'quarterly', 'semi_annual', 'annual'],
      },
      {
        name: 'subscriptions_plan_tier_enum',
        values: ['starter', 'professional', 'enterprise', 'custom'],
      },
      // subscription-module-item.entity.ts: SubscriptionModuleStatus
      {
        name: 'subscription_module_items_status_enum',
        values: ['active', 'suspended', 'cancelled', 'upgraded', 'downgraded'],
      },
      // invoice.entity.ts: InvoiceStatus
      {
        name: 'invoices_status_enum',
        values: ['draft', 'pending', 'sent', 'paid', 'partially_paid', 'overdue', 'void', 'refunded'],
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
   * billing.subscriptions — billing/entities/subscription.entity.ts
   *
   * The "tenant subscription" aggregate root. Parent of:
   *   - subscription_module_items (CASCADE on delete)
   *   - invoices (RESTRICT on delete — installed by 1788300000000)
   *   - scheduled_plan_changes (RESTRICT on delete — installed by 1788400000000)
   *
   * # Column shape: snake_case, entity-canonical
   *
   * Every persisted column on the entity declares `@Column({ name:
   * 'snake_case' })`. This baseline matches that — `tenant_id` (uuid),
   * `plan_id`, `plan_tier`, `plan_name`, `billing_cycle`, `start_date`,
   * `end_date`, `current_period_start`, `current_period_end`,
   * `trial_end_date`, `cancelled_at`, `cancellation_reason`, `auto_renew`,
   * `stripe_subscription_id`, `stripe_customer_id`, `created_by`,
   * `updated_by`, `is_deleted`, `deleted_at`, `deleted_by`. The legacy
   * `04-billing-tables.sql` shape (camelCase `"tenantId"` text + no
   * soft-delete) is replaced.
   *
   * # tenant_id is uuid, not varchar
   *
   * CLAUDE.md "Tenant row placement (D14)": the canonical tenant
   * identifier type is uuid platform-wide. The entity declares
   * `@Column({ name: 'tenant_id', type: 'uuid' })`. Creating uuid here
   * makes `1786300000000-ConvergeTenantIdAndAddSoftDelete`'s
   * varchar→uuid branch a no-op (its `colInfo[0]?.data_type === 'character
   * varying'` check fails the truthy branch since it's already uuid).
   *
   * # No FKs installed inline (subscriptions has no outgoing FKs)
   *
   * Subscriptions is a parent — only the child tables (invoices,
   * subscription_module_items, payments via invoice, scheduled_plan_changes)
   * declare FKs. Entity has only `OneToMany` relations on this table.
   *
   * # Indexes match the entity decorators
   *
   *   - IDX_subscriptions_tenantId (non-unique, [tenantId])
   *   - UQ_subscriptions_tenantId_active (UNIQUE, [tenantId], WHERE
   *     is_deleted = false) — DBR-HIGH-001 cure for soft-delete-compatible
   *     uniqueness. Re-installing this here makes the later
   *     1788200000000-FixSubscriptionsTenantUniquePartial drop-and-recreate
   *     a no-op-ish on fresh DBs.
   *   - IDX_subscriptions_status (single status column)
   *   - IDX_subscriptions_currentPeriodEnd
   *   - IDX_subscriptions_isDeleted (entity bare @Index() on isDeleted)
   *
   * NOTE: the WHERE predicate of UQ_subscriptions_tenantId_active uses
   * the actual snake_case column name `is_deleted` — the entity's
   * `where: '"isDeleted" = false'` decorator string is INCORRECT (the
   * persisted column is `is_deleted`, not `"isDeleted"`). Following the
   * entity-canonical name aligns the index with the actual data and
   * with the migration linter.
   */
  private async createSubscriptionsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    // CREATE TABLE + sibling indexes bundled per R3 lint chunk rule.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS billing.subscriptions (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "plan_id" uuid NULL,
        "plan_tier" billing.subscriptions_plan_tier_enum NOT NULL,
        "plan_name" varchar NOT NULL,
        "status" billing.subscriptions_status_enum NOT NULL DEFAULT 'trial',
        "billing_cycle" billing.subscriptions_billing_cycle_enum NOT NULL,
        "limits" jsonb NOT NULL,
        "pricing" jsonb NOT NULL,
        "start_date" timestamptz NOT NULL,
        "end_date" timestamptz NULL,
        "current_period_start" timestamptz NOT NULL,
        "current_period_end" timestamptz NOT NULL,
        "trial_end_date" timestamptz NULL,
        "cancelled_at" timestamptz NULL,
        "cancellation_reason" text NULL,
        "auto_renew" boolean NOT NULL DEFAULT true,
        "stripe_subscription_id" varchar NULL,
        "stripe_customer_id" varchar NULL,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW(),
        "created_by" varchar NULL,
        "updated_by" varchar NULL,
        "version" integer NOT NULL DEFAULT 1,
        "is_deleted" boolean NOT NULL DEFAULT false,
        "deleted_at" timestamptz NULL,
        "deleted_by" varchar NULL
      );
      CREATE INDEX IF NOT EXISTS "IDX_subscriptions_tenantId"
        ON billing.subscriptions ("tenant_id");
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_subscriptions_tenantId_active"
        ON billing.subscriptions ("tenant_id")
        WHERE "is_deleted" = false;
      CREATE INDEX IF NOT EXISTS "IDX_subscriptions_status"
        ON billing.subscriptions ("status");
      CREATE INDEX IF NOT EXISTS "IDX_subscriptions_currentPeriodEnd"
        ON billing.subscriptions ("current_period_end");
      CREATE INDEX IF NOT EXISTS "IDX_subscriptions_isDeleted"
        ON billing.subscriptions ("is_deleted");
    `);
  }

  /**
   * billing.subscription_module_items — billing/entities/subscription-module-item.entity.ts
   *
   * Per-subscription per-module pricing line items (FK to subscriptions
   * with ON DELETE CASCADE, matching `@ManyToOne('Subscription',
   * 'moduleItems', { onDelete: 'CASCADE' })`).
   *
   * # FK installed inline
   *
   * Unlike invoices.subscription_id and payments.invoice_id (which
   * 1788300000000 explicitly takes over), no later migration touches
   * subscription_module_items.subscription_id. We therefore install the
   * FK directly in the CREATE TABLE — entity intent + DB enforcement
   * arrive together.
   *
   * # Composite UNIQUE matches @Unique(['subscriptionId', 'moduleId'])
   *
   * One module per subscription — no duplicates.
   */
  private async createSubscriptionModuleItemsTable(
    queryRunner: QueryRunner,
  ): Promise<void> {
    // CREATE TABLE + sibling indexes bundled per R3 lint chunk rule.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS billing.subscription_module_items (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "subscription_id" uuid NOT NULL REFERENCES billing.subscriptions(id) ON DELETE CASCADE,
        "module_id" uuid NOT NULL,
        "module_code" varchar(50) NOT NULL,
        "module_name" varchar(100) NOT NULL,
        "quantities" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "line_items" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "subtotal" numeric(19, 4) NOT NULL,
        "discount_amount" numeric(19, 4) NOT NULL DEFAULT 0,
        "total" numeric(19, 4) NOT NULL,
        "currency" varchar(3) NOT NULL DEFAULT 'USD',
        "status" billing.subscription_module_items_status_enum NOT NULL DEFAULT 'active',
        "activated_at" timestamptz NOT NULL DEFAULT NOW(),
        "cancelled_at" timestamptz NULL,
        "configuration" jsonb NULL,
        "notes" text NULL,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT "UQ_subscription_module_items_sub_module"
          UNIQUE ("subscription_id", "module_id")
      );
      CREATE INDEX IF NOT EXISTS "IDX_subscription_module_items_subscription_id"
        ON billing.subscription_module_items ("subscription_id");
      CREATE INDEX IF NOT EXISTS "IDX_subscription_module_items_module_id"
        ON billing.subscription_module_items ("module_id");
      CREATE INDEX IF NOT EXISTS "IDX_subscription_module_items_status"
        ON billing.subscription_module_items ("status");
    `);
  }

  /**
   * billing.invoices — billing/entities/invoice.entity.ts
   *
   * Tenant invoice — finalized financial document. FK to subscriptions
   * with ON DELETE RESTRICT is installed by
   * 1788300000000-AddBillingFksExplicitOnDelete. We do NOT install the
   * FK inline — same pattern as payments.invoice_id. That migration's
   * lookup-and-replace pattern (drop auto-generated FK, install
   * canonical-named FK) needs the FK to be absent at first run on
   * fresh DBs.
   *
   * # MoneyColumn columns render as numeric(19, 4)
   *
   * subtotal, discount, total, amount_paid, amount_due — all use
   * `@MoneyColumn()` which the @aquaculture/backend-common decorator
   * renders as numeric(19, 4) with a Decimal.js transformer. Lossless
   * arithmetic for tax / refund / balance calculations.
   *
   * # Soft-delete columns inline
   *
   * Same rationale as payments — `1786300000000-ConvergeTenantIdAndAddSoftDelete`
   * `ADD COLUMN IF NOT EXISTS deleted_at / deleted_by` becomes a no-op
   * on fresh DBs because the columns are already present.
   *
   * # Indexes match entity decorators
   *
   *   - UQ on (tenant_id, invoice_number) — invoice numbers are unique
   *     per tenant, NOT globally; the index is composite, not single-column.
   *   - IDX (tenant_id, status), (tenant_id, due_date), (subscription_id),
   *     (is_deleted)
   */
  private async createInvoicesTable(queryRunner: QueryRunner): Promise<void> {
    // CREATE TABLE + sibling indexes bundled per R3 lint chunk rule.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS billing.invoices (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "invoice_number" varchar NOT NULL,
        "subscription_id" uuid NULL,
        "status" billing.invoices_status_enum NOT NULL DEFAULT 'draft',
        "billing_address" jsonb NOT NULL,
        "line_items" jsonb NOT NULL,
        "subtotal" numeric(19, 4) NOT NULL,
        "tax" jsonb NULL,
        "discount" numeric(19, 4) NULL,
        "discount_code" varchar NULL,
        "total" numeric(19, 4) NOT NULL,
        "amount_paid" numeric(19, 4) NOT NULL DEFAULT 0,
        "amount_due" numeric(19, 4) NOT NULL,
        "currency" varchar NOT NULL DEFAULT 'USD',
        "issue_date" timestamptz NOT NULL,
        "due_date" timestamptz NOT NULL,
        "paid_at" timestamptz NULL,
        "period_start" date NOT NULL,
        "period_end" date NOT NULL,
        "notes" text NULL,
        "stripe_invoice_id" varchar NULL,
        "pdf_url" varchar NULL,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW(),
        "created_by" varchar NULL,
        "updated_by" varchar NULL,
        "version" integer NOT NULL DEFAULT 1,
        "is_deleted" boolean NOT NULL DEFAULT false,
        "deleted_at" timestamptz NULL,
        "deleted_by" varchar NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_invoices_tenant_invoiceNumber"
        ON billing.invoices ("tenant_id", "invoice_number");
      CREATE INDEX IF NOT EXISTS "IDX_invoices_tenant_status"
        ON billing.invoices ("tenant_id", "status");
      CREATE INDEX IF NOT EXISTS "IDX_invoices_tenant_dueDate"
        ON billing.invoices ("tenant_id", "due_date");
      CREATE INDEX IF NOT EXISTS "IDX_invoices_subscriptionId"
        ON billing.invoices ("subscription_id");
      CREATE INDEX IF NOT EXISTS "IDX_invoices_isDeleted"
        ON billing.invoices ("is_deleted");
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
