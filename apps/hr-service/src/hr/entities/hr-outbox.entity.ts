import { Entity, Index } from 'typeorm';
import { OutboxEntityBase } from '@platform/outbox';

/**
 * HR-specific transactional outbox entity.
 *
 * HR-HIGH-015: Replaces fire-and-forget event publishing with the
 * transactional outbox pattern. Leave approval, termination, and
 * certification events are now enqueued in the same transaction as
 * the domain write. The OutboxWorkerService polls this table and
 * publishes to NATS with at-least-once delivery.
 *
 * This is the HR service's concrete OutboxEntityBase subclass.
 * Each service owns its own outbox table for bounded-context isolation.
 *
 * @see OutboxModule.forFeature(HrOutbox) in app.module.ts
 * @see OutboxPublisher.enqueue() for the write-side API
 */
@Entity('hr_outbox', { schema: 'hr' })
@Index('idx_hr_outbox_poll', ['createdAt'], {
  where: '"publishedAt" IS NULL AND "isDeadLettered" = false',
})
@Index('idx_hr_outbox_tenant', ['tenantId'])
@Index('idx_hr_outbox_idempotency', ['tenantId', 'idempotencyKey'], {
  unique: true,
  where: '"idempotencyKey" IS NOT NULL',
})
@Index('idx_hr_outbox_sequence', ['sequence'], { unique: true })
@Index('idx_hr_outbox_aggregate_fifo', ['tenantId', 'aggregateId', 'sequence'], {
  where: '"publishedAt" IS NULL AND "isDeadLettered" = false AND "aggregateId" IS NOT NULL',
})
export class HrOutbox extends OutboxEntityBase {}
