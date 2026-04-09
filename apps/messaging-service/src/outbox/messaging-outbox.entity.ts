import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

/**
 * Transactional outbox for guaranteed event delivery.
 * Message INSERT + outbox INSERT occur in the same DB transaction.
 * A background worker polls unpublished rows and publishes to NATS.
 *
 * Aligned with platform OutboxEntityBase pattern from
 * `platform/libs/outbox/src/outbox-entity.base.ts`.
 *
 * BREAKING CHANGE: PK changed from BIGINT (per-database sequence, collision-prone
 * across replicas) to UUID (globally unique, safe for cross-replica deduplication).
 */
@Entity('messaging_outbox')
@Index('idx_outbox_poll', ['createdAt'], {
  where: '"publishedAt" IS NULL AND "nextAttemptAt" <= NOW()',
})
@Index('idx_outbox_tenant', ['tenantId'])
@Index('idx_outbox_idempotency', ['tenantId', 'idempotencyKey'], {
  unique: true,
  where: '"idempotencyKey" IS NOT NULL',
})
export class MessagingOutbox {
  /** UUID PK -- globally unique across replicas, safe for NATS Msg-Id dedup. */
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * Tenant identifier for multi-tenant isolation.
   * NOT NULL -- every outbox row belongs to exactly one tenant.
   */
  @Column({ type: 'uuid' })
  tenantId!: string;

  /** PascalCase event type -- e.g. 'UserDataAnonymized', 'MessageSent'. */
  @Column({ type: 'varchar', length: 100 })
  eventType!: string;

  /**
   * ID of the domain aggregate this event belongs to.
   * Used for per-aggregate ordering and event replay.
   */
  @Column({ type: 'uuid', nullable: true })
  aggregateId!: string | null;

  /**
   * Full BaseEvent payload serialized as JSONB.
   *
   * NOTE: Date fields are stored as ISO 8601 strings after JSON serialization.
   * Consumers must convert back to Date objects if needed.
   */
  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  /** Set when the event has been successfully published to NATS. */
  @Column({ type: 'timestamptz', nullable: true })
  publishedAt!: Date | null;

  /** Number of failed publish attempts. Dead-lettered at MAX_RETRIES. */
  @Column({ type: 'integer', default: 0 })
  retryCount!: number;

  /** Truncated error message from the last failed publish attempt. */
  @Column({ type: 'text', nullable: true })
  lastError!: string | null;

  /**
   * Earliest time this row is eligible for the next publish attempt.
   * Used for exponential backoff: nextAttemptAt = NOW() + base * 2^retryCount.
   * Defaults to creation time (immediately eligible).
   */
  @Column({ type: 'timestamptz', default: () => 'NOW()' })
  nextAttemptAt!: Date;

  /**
   * Optional idempotency key for deduplication.
   * UNIQUE constraint on (tenantId, idempotencyKey) prevents duplicate
   * outbox entries for the same business operation.
   * @see MSG-HIGH-004 (outbox deduplication)
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  idempotencyKey!: string | null;

  /**
   * Whether this event has been dead-lettered after exceeding MAX_RETRIES.
   * Dead-lettered events are excluded from polling and tracked via metrics.
   * @see MSG-HIGH-006 (dead-letter metric counter)
   */
  @Column({ type: 'boolean', default: false })
  isDeadLettered!: boolean;

  /**
   * Lease acquired timestamp -- set by the worker when it claims a row
   * for publishing, cleared on success or lease expiry.
   *
   * WHY: avoids holding row-level locks during NATS publish I/O (~5-30ms).
   * Other replicas see the fresh leasedAt and skip the row via the polling
   * predicate, without needing a DB lock.
   */
  @Column({ type: 'timestamptz', nullable: true })
  leasedAt!: Date | null;

  /**
   * Identifier of the worker that currently holds the lease.
   * Format: `${hostname}-${pid}`. Purely informational for debugging.
   */
  @Column({ type: 'varchar', length: 128, nullable: true })
  leasedBy!: string | null;
}
