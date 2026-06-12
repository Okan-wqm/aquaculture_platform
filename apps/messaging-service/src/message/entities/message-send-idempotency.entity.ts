import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

/**
 * Authoritative send-idempotency ledger (cluster-8 / PR#354 DİLİM-1).
 *
 * WHY a DB ledger when Redis already dedupes: the Redis SET NX path in
 * SendMessageHandler is a fast-path CACHE whose error handling is
 * deliberately fail-open (`safeRedisSetNx` swallows Redis outages so
 * messaging keeps accepting writes) — which means Redis alone cannot be
 * the idempotency AUTHORITY: a Redis outage window re-opens duplicate
 * sends. A global UNIQUE on messages(tenantId, idempotencyKey) is
 * impossible because `messages` is RANGE-partitioned by createdAt and
 * PostgreSQL requires the partition key inside every unique constraint.
 * This partition-FREE ledger is the durable uniqueness anchor: the
 * handler claims (tenantId, channelId, senderId, idempotencyKey) with
 * INSERT ... ON CONFLICT DO NOTHING inside the SAME transaction that
 * inserts the message, making duplicates structurally impossible even
 * with Redis down (Tier-1).
 *
 * WHY explicit `schema: 'messaging'` (ADR-011 Wave 4-A.2): this is a
 * cross-tenant infrastructure table like messaging_outbox — it must NOT
 * be cloned into tenant_<uuid> schemas, so it declares its schema
 * explicitly instead of riding search_path tenant routing. The matching
 * migration is @SourceOnlyMigration for the same reason.
 *
 * messageCreatedAt is denormalized so the duplicate path can load the
 * original message with partition pruning (createdAt is the partition
 * key of `messages`).
 */
@Entity('message_send_idempotency', { schema: 'messaging' })
@Index('idx_message_send_idempotency_message', ['tenantId', 'messageId', 'messageCreatedAt'])
export class MessageSendIdempotency {
  @PrimaryColumn({ type: 'uuid' })
  tenantId!: string;

  @PrimaryColumn({ type: 'uuid' })
  channelId!: string;

  @PrimaryColumn({ type: 'uuid' })
  senderId!: string;

  @PrimaryColumn({ type: 'uuid' })
  idempotencyKey!: string;

  @Column({ type: 'uuid' })
  messageId!: string;

  @Column({ type: 'timestamptz' })
  messageCreatedAt!: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
