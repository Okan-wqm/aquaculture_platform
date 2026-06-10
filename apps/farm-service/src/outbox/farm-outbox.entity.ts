import { Entity, Index } from 'typeorm';
import { OutboxEntityBase } from '@platform/outbox';

/**
 * FarmOutbox
 *
 * Concrete outbox entity for farm-service. The class name stays stable for
 * existing imports, but new writes target the canonical farm.outbox_events
 * table. farm.farm_outbox is legacy compatibility only.
 *
 * `synchronize: false` is critical: this table is managed exclusively by
 * farm-service migrations. TypeORM's runtime synchronize must NOT touch it,
 * otherwise drift between the migration DDL and the entity decorator could
 * silently corrupt the polling predicate index.
 *
 * @see 1800700000000-CreateCanonicalOutboxInbox
 */
@Entity({ schema: 'farm', name: 'outbox_events', synchronize: false })
@Index('idx_outbox_events_poll_entity', ['createdAt'], {
  where: '"publishedAt" IS NULL AND "isDeadLettered" = false',
})
export class FarmOutbox extends OutboxEntityBase {}
