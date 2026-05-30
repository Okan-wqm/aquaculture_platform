import {
  Entity,
  PrimaryGeneratedColumn,
  Index,
} from 'typeorm';
import { OutboxEntityBase } from '@platform/outbox';

/**
 * Concrete outbox entity for messaging-service.
 *
 * Extends the shared OutboxEntityBase from @platform/outbox with:
 *   - UUID primary key (base uses BIGINT — messaging needs globally unique
 *     IDs for cross-replica NATS Msg-Id deduplication)
 *   - Indexes optimized for messaging's polling and tenant patterns
 *
 * All columns (tenantId, aggregateId, nextAttemptAt, isDeadLettered,
 * idempotencyKey, payload, etc.) are inherited from OutboxEntityBase.
 *
 * synchronize: false — DDL is managed by migrations, not TypeORM sync.
 */
@Entity({ name: 'messaging_outbox', schema: 'messaging', synchronize: false })
@Index('idx_outbox_poll', ['createdAt'], {
  where: '"publishedAt" IS NULL AND "isDeadLettered" = false',
})
@Index('idx_outbox_tenant', ['tenantId'])
@Index('idx_outbox_idempotency', ['tenantId', 'idempotencyKey'], {
  unique: true,
  where: '"idempotencyKey" IS NOT NULL',
})
export class MessagingOutbox extends OutboxEntityBase {
  /** Override PK to UUID — base uses BIGINT increment. */
  @PrimaryGeneratedColumn('uuid')
  declare id: string;
}
