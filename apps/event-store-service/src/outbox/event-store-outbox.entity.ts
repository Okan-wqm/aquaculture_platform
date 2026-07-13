import { Entity, Index } from 'typeorm';
import { OutboxEntityBase } from '@platform/outbox';

/**
 * event-store-service transactional outbox (DB-INFRA-HIGH-003).
 *
 * event-store-service was onboarded to the event backbone to be a GDPR
 * tenant-erasure target: the executor enqueues its erasure proof events here and
 * the shared worker relays them to NATS. Mirrors billing_outbox — all columns
 * inherited from OutboxEntityBase; `synchronize:false` (migration owns the DDL).
 */
@Entity({ schema: 'event_store', name: 'event_store_outbox', synchronize: false })
@Index('idx_event_store_outbox_poll_entity', ['createdAt'], {
  where: '"publishedAt" IS NULL AND "isDeadLettered" = false',
})
@Index('idx_event_store_outbox_tenant_entity', ['tenantId'])
@Index('idx_event_store_outbox_idempotency_entity', ['tenantId', 'idempotencyKey'], {
  unique: true,
  where: '"idempotencyKey" IS NOT NULL',
})
export class EventStoreOutbox extends OutboxEntityBase {}
