import { OutboxEntityBase } from '@platform/outbox';
import { Entity, PrimaryGeneratedColumn, Index } from 'typeorm';

/**
 * Concrete transactional-outbox entity for auth-service (DATA-HIGH-001).
 *
 * Extends the shared OutboxEntityBase from @platform/outbox with:
 *   - UUID primary key (base uses BIGINT) so every row carries a globally
 *     unique id usable as a cross-replica NATS Msg-Id for deduplication.
 *   - Indexes tuned for the worker's poll predicate + tenant + idempotency.
 *
 * All columns (eventType, tenantId, aggregateId, payload, publishedAt,
 * retryCount, lastError, nextAttemptAt, idempotencyKey, isDeadLettered,
 * leasedAt, leasedBy) are inherited from OutboxEntityBase.
 *
 * `synchronize: false` — the table DDL is owned by the
 * CreateAuthOutboxTable migration (single-writer deploy contract), not
 * TypeORM sync. This is a cross-tenant infrastructure table in the `auth`
 * schema (schema declared explicitly — it is NOT cloned into tenant_<uuid>
 * schemas; @SourceOnlyMigration on the migration enforces that).
 */
@Entity({ name: 'auth_outbox', schema: 'auth', synchronize: false })
@Index('idx_auth_outbox_poll', ['createdAt'], {
  where: '"publishedAt" IS NULL AND "isDeadLettered" = false',
})
@Index('idx_auth_outbox_tenant', ['tenantId'])
@Index('idx_auth_outbox_idempotency', ['tenantId', 'idempotencyKey'], {
  unique: true,
  where: '"idempotencyKey" IS NOT NULL',
})
@Index('idx_auth_outbox_system_idempotency', ['idempotencyKey'], {
  unique: true,
  where: '"tenantId" IS NULL AND "idempotencyKey" IS NOT NULL',
})
export class AuthOutbox extends OutboxEntityBase {
  /** Override PK to UUID — base uses BIGINT increment. */
  @PrimaryGeneratedColumn('uuid')
  declare id: string;
}
