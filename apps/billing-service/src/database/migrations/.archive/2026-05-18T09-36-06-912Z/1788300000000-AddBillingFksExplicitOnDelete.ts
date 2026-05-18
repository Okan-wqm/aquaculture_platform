import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddBillingFksExplicitOnDelete1788300000000
 * ============================================================================
 *
 * Replaces TypeORM's auto-generated foreign keys on
 * `billing.invoices.subscription_id → billing.subscriptions.id` and
 * `billing.payments.invoice_id → billing.invoices.id` with explicit
 * `ON DELETE RESTRICT` constraints.
 *
 * # Why this migration exists
 *
 * Pre-fix the entity decorators (`@ManyToOne('Subscription', ...)` /
 * `@ManyToOne('Invoice', ...)`) carried no `onDelete` clause. TypeORM
 * therefore generated FK constraints with `ON DELETE NO ACTION` — which
 * happens to behave like RESTRICT in most cases, but reads identically to
 * a forgotten declaration. DBR-MEDIUM-005 captured the gap: regulated
 * cross-table relations between billing entities MUST encode their
 * business intent in the constraint itself.
 *
 * RESTRICT is the right semantics here:
 *   - A paid Invoice with linked Payment rows MUST NOT be deletable —
 *     deletion would orphan immutable financial records.
 *   - A Subscription with Invoice history MUST NOT be deletable —
 *     soft-delete via deleted_at is the only allowed lifecycle (already
 *     enforced by the partial unique index added in
 *     1788200000000-FixSubscriptionsTenantUniquePartial).
 *
 * # What this migration does
 *
 *   1. DROP each auto-generated FK by lookup against
 *      information_schema.table_constraints (TypeORM names them
 *      FK_<hash>; we resolve dynamically rather than hard-code).
 *   2. ADD CONSTRAINT with the canonical name
 *      `fk_<child>_<col>_<parent>` and explicit ON DELETE RESTRICT.
 *
 * # Why CONCURRENTLY is NOT used here
 *
 * FK constraints (ALTER TABLE ADD CONSTRAINT FOREIGN KEY) are not subject
 * to the CONCURRENTLY index rule (R3) — they take a brief AccessExclusive
 * lock to validate but do not require a separate concurrent index build.
 * Validation happens against rows already in the table; on a healthy DB
 * with the predicate already satisfied (as it is — TypeORM enforced it),
 * the lock is held for milliseconds.
 *
 * # Down-rollback
 *
 * down() restores the auto-generated TypeORM constraint by dropping
 * the explicit constraint and letting the next schema sync regenerate.
 * For idempotency, use the same lookup-by-pattern shape.
 *
 * Closes: docs/reviews/database-reviewer/2026-04-28-core-platform-review.md#DBR-MEDIUM-005
 */
export class AddBillingFksExplicitOnDelete1788300000000
  implements MigrationInterface
{
  name = 'AddBillingFksExplicitOnDelete1788300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Step 1: drop existing auto-generated FK on
    // billing.invoices.subscription_id, if any. Look up by referenced-table
    // shape rather than hard-coding the FK_<hash> name (TypeORM names vary
    // across deploys). Each `up()` step is idempotent so re-runs after a
    // partial migration succeed.
    //
    // WHY: Hard-coding `FK_<hash>` would couple the migration to whatever
    // TypeORM happened to generate at the previous deploy; re-runs from a
    // fresh DB (e.g. CI) would mismatch and fail loudly.
    await queryRunner.query(`
      DO $$
      DECLARE
        constraint_record RECORD;
      BEGIN
        FOR constraint_record IN
          SELECT tc.constraint_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.referential_constraints rc
            ON tc.constraint_name = rc.constraint_name
            AND tc.constraint_schema = rc.constraint_schema
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
            AND tc.constraint_schema = kcu.constraint_schema
          WHERE tc.table_schema = 'billing'
            AND tc.table_name = 'invoices'
            AND tc.constraint_type = 'FOREIGN KEY'
            AND kcu.column_name = 'subscription_id'
            AND tc.constraint_name <> 'fk_invoices_subscription_id_subscriptions'
        LOOP
          EXECUTE format('ALTER TABLE billing.invoices DROP CONSTRAINT %I', constraint_record.constraint_name);
        END LOOP;
      END $$;
    `);

    // Step 2: add canonical FK with explicit ON DELETE RESTRICT.
    //
    // WHY: RESTRICT is the right semantics — a subscription with invoice
    // history must NOT be deletable; soft-delete via deleted_at is the
    // only allowed lifecycle. Encoding this at the DB level is Tier-1
    // defense-in-depth: even if application code drifts, the DB refuses.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = 'billing'
            AND table_name = 'invoices'
            AND constraint_name = 'fk_invoices_subscription_id_subscriptions'
        ) THEN
          ALTER TABLE billing.invoices
            ADD CONSTRAINT fk_invoices_subscription_id_subscriptions
            FOREIGN KEY (subscription_id)
            REFERENCES billing.subscriptions (id)
            ON DELETE RESTRICT;
        END IF;
      END $$;
    `);

    // Step 3: same shape for billing.payments.invoice_id.
    await queryRunner.query(`
      DO $$
      DECLARE
        constraint_record RECORD;
      BEGIN
        FOR constraint_record IN
          SELECT tc.constraint_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.referential_constraints rc
            ON tc.constraint_name = rc.constraint_name
            AND tc.constraint_schema = rc.constraint_schema
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
            AND tc.constraint_schema = kcu.constraint_schema
          WHERE tc.table_schema = 'billing'
            AND tc.table_name = 'payments'
            AND tc.constraint_type = 'FOREIGN KEY'
            AND kcu.column_name = 'invoice_id'
            AND tc.constraint_name <> 'fk_payments_invoice_id_invoices'
        LOOP
          EXECUTE format('ALTER TABLE billing.payments DROP CONSTRAINT %I', constraint_record.constraint_name);
        END LOOP;
      END $$;
    `);

    // Step 4: add canonical FK with explicit ON DELETE RESTRICT for payments.
    //
    // WHY: A paid invoice with linked Payment rows must NOT be deletable.
    // Deletion would orphan financial records that downstream reconciliation
    // (tenant_cost_rollup, Stripe MeterEvent ledger) treats as authoritative.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = 'billing'
            AND table_name = 'payments'
            AND constraint_name = 'fk_payments_invoice_id_invoices'
        ) THEN
          ALTER TABLE billing.payments
            ADD CONSTRAINT fk_payments_invoice_id_invoices
            FOREIGN KEY (invoice_id)
            REFERENCES billing.invoices (id)
            ON DELETE RESTRICT;
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // WHY: Down rolls back to the auto-generated FK shape by dropping the
    // explicit constraint. The next service boot regenerates a TypeORM
    // FK_<hash> via the entity decorator. Operators who run down() on
    // these need to be aware that the post-down state is FUNCTIONALLY
    // identical (NO ACTION ≈ RESTRICT in most cases) but the explicit
    // intent is lost.
    await queryRunner.query(`
      ALTER TABLE billing.payments DROP CONSTRAINT IF EXISTS fk_payments_invoice_id_invoices
    `);
    await queryRunner.query(`
      ALTER TABLE billing.invoices DROP CONSTRAINT IF EXISTS fk_invoices_subscription_id_subscriptions
    `);
  }
}
