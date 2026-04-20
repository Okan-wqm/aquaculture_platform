import { Entity, Index } from 'typeorm';
import { OutboxEntityBase } from '@platform/outbox';

/**
 * FarmOutbox
 *
 * Concrete outbox entity for farm-service. Stores domain events that
 * have been enqueued by command handlers and are pending publish via
 * NATS by the OutboxWorkerService.
 *
 * `synchronize: false` is critical: this table is managed exclusively
 * by the `CreateFarmOutboxTable1780300000000` migration. TypeORM's
 * runtime synchronize must NOT touch it, otherwise drift between the
 * migration DDL and the entity decorator could silently corrupt the
 * polling predicate index.
 *
 * @see Phase 2 of farm domain real-time visibility plan.
 */
@Entity({ schema: 'farm', name: 'farm_outbox', synchronize: false })
@Index('idx_farm_outbox_poll_entity', ['createdAt'], {
  where: '"publishedAt" IS NULL',
})
export class FarmOutbox extends OutboxEntityBase {}
