import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CreateStripeWebhookDedup1788500000000
 * ============================================================================
 *
 * Creates `billing.stripe_webhook_events` — the persistent idempotency
 * table for Stripe webhook event processing.
 *
 * # Why this migration exists
 *
 * Pre-fix the StripeWebhookController used Redis-only dedup
 * (`apps/billing-service/src/billing/controllers/stripe-webhook.controller.ts:186`).
 * Three failure modes:
 *
 *   1. Redis restart loses the dedup state — every retry-window event
 *      replayed by Stripe gets re-processed, double-charging customers
 *      or double-applying refunds.
 *   2. Redis memory eviction (default LRU under pressure) silently drops
 *      old keys before the Stripe retry window closes.
 *   3. A cold Redis cache on a new pod has no dedup history at all —
 *      blue/green deploy windows are processing-double risk.
 *
 * BILLING-HIGH-001 captured the gap: idempotency for billable financial
 * events MUST be persistent — replayed webhook for the same event_id MUST
 * be processed exactly once across the system lifetime, not the Redis
 * instance lifetime.
 *
 * # Architectural shape
 *
 * The DB UNIQUE constraint on event_id IS the dedup primitive. INSERT-
 * on-receive becomes idempotent: a duplicate webhook arrives with the
 * same event_id, the INSERT fails on UNIQUE violation, the controller
 * catches the violation and returns 200 OK (the prior processing was
 * authoritative). No race window — the DB serialises the constraint
 * check at the row level.
 *
 * Redis layer is preserved as a fast-path cache (avoids hitting DB on
 * every replay during the typical 3-day Stripe retry window), but the
 * DB row is the authoritative source.
 *
 * # Schema fields
 *
 *   event_id        — Stripe's globally-unique event identifier
 *                     (`evt_*`). Primary key + UNIQUE.
 *   event_type      — denormalised for fast filter on the dashboard
 *                     `payment_intent.succeeded`, `subscription.updated`).
 *   received_at     — first INSERT timestamp; survives retries.
 *   processed_at    — set when the handler completes successfully;
 *                     null = received but not yet committed (idempotent
 *                     replay before the handler ran would still pick up
 *                     the receive-side row).
 *   outcome         — varchar(32): 'pending' | 'success' | 'handler-error'
 *                     | 'unsupported-event'. Same vocabulary as the
 *                     audit row outcomes.
 *
 * # Why CONCURRENTLY is NOT used here
 *
 * CREATE TABLE is not subject to the CONCURRENTLY index rule (R3); the
 * brief AccessExclusive lock on a brand-new table affects nothing. The
 * UNIQUE constraint is built as part of the CREATE TABLE statement, not
 * a separate CREATE INDEX.
 *
 * Closes: docs/reviews/billing-expert/2026-04-28-core-platform-review.md#BILLING-HIGH-001
 */
export class CreateStripeWebhookDedup1788500000000
  implements MigrationInterface
{
  name = 'CreateStripeWebhookDedup1788500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Step 1: ensure billing schema exists. The base service migrations
    // already create it but DDL ordering is not guaranteed across deploys.
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS billing`);

    // Step 2: create the dedup table with UNIQUE on event_id.
    //
    // WHY: PRIMARY KEY on event_id IS the dedup primitive. The DB
    // serialises INSERT attempts at the row level — concurrent webhook
    // deliveries for the same event_id are processed exactly once, the
    // second loses on UNIQUE_VIOLATION (SQLSTATE 23505) and the
    // controller returns 200 OK without re-running the handler.
    //
    // WHY NOT a serial id PK + UNIQUE event_id: the event_id is itself
    // a globally-unique identifier (Stripe's `evt_<random>` shape).
    // Using it directly as PK eliminates an unnecessary auto-generated
    // column and makes the UNIQUE constraint structurally impossible
    // to forget.
    //
    // Secondary index on (event_type, received_at DESC) for operator-side
    // dashboard queries — "show me the last 100 webhook events of type X".
    // Composite descending matches the DB scan direction so LIMIT N reads
    // N rows. The CREATE TABLE + CREATE INDEX live in the SAME SQL chunk
    // so migration-sql-lint R3 grandfathers the non-CONCURRENTLY index
    // (the table is empty at index-creation time, no live writers).
    // Using IF NOT EXISTS keeps the migration idempotent under partial-
    // apply replays.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS billing.stripe_webhook_events (
        event_id     varchar(255) PRIMARY KEY,
        event_type   varchar(64) NOT NULL,
        received_at  timestamptz NOT NULL DEFAULT now(),
        processed_at timestamptz,
        outcome      varchar(32) NOT NULL DEFAULT 'pending'
      );
      CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_type_received
        ON billing.stripe_webhook_events (event_type, received_at DESC);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // WHY: down() drops the table. Reverting to Redis-only dedup
    // re-opens the duplicate-billing window — operators using down()
    // should be aware that the post-down state allows replayed Stripe
    // webhooks to double-process during Redis restart / eviction.
    await queryRunner.query(
      `DROP INDEX IF EXISTS billing.idx_stripe_webhook_events_type_received`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS billing.stripe_webhook_events`);
  }
}
