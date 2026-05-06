import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * Stripe webhook idempotency record (BILLING-HIGH-001 cure).
 *
 * Persistent row keyed by Stripe's `evt_*` event ID. INSERT-on-receive
 * is the dedup primitive — UNIQUE constraint on PRIMARY KEY makes
 * concurrent or replayed webhook deliveries process exactly once,
 * regardless of Redis instance lifetime.
 *
 * Migration: 1788500000000-CreateStripeWebhookDedup.
 */
@Entity('stripe_webhook_events', { schema: 'billing' })
@Index('idx_stripe_webhook_events_type_received', ['eventType', 'receivedAt'])
export class StripeWebhookEventEntity {
  /**
   * Stripe's globally-unique event identifier (`evt_*` shape).
   * Used directly as PK — eliminates auto-generated column and makes
   * the UNIQUE constraint structurally impossible to forget.
   */
  @PrimaryColumn({ name: 'event_id', type: 'varchar', length: 255 })
  eventId!: string;

  /**
   * Stripe event type (`payment_intent.succeeded`,
   * `subscription.updated`, etc.). Denormalised for dashboard filter
   * speed; the secondary index covers (event_type, received_at DESC).
   */
  @Column({ name: 'event_type', type: 'varchar', length: 64 })
  eventType!: string;

  /**
   * First-receive timestamp. Survives retry replays — only set on the
   * INSERT path; UNIQUE-violation replay path never touches this row.
   */
  @Column({ name: 'received_at', type: 'timestamptz', default: () => 'now()' })
  receivedAt!: Date;

  /**
   * Set when the handler completes successfully. Null = received but
   * handler not yet committed. Replays during the
   * received-but-not-processed window still see the row and dedup,
   * but operators can pair the (received_at, processed_at) gap with
   * audit log handler-error rows for triage.
   */
  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt!: Date | null;

  /**
   * One of: 'pending' | 'success' | 'handler-error' | 'unsupported-event'.
   * Mirror vocabulary of the audit row outcomes for cross-store joins.
   */
  @Column({ name: 'outcome', type: 'varchar', length: 32, default: 'pending' })
  outcome!: string;
}
