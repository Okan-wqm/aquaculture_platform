import { PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

import type { OutboxStoredPayload } from './outbox-routing';

/**
 * Abstract base class for transactional outbox entities.
 *
 * Each consuming service declares a concrete subclass with its own
 * `@Entity('<service>_outbox')` decorator. The base class supplies the
 * column shape that the worker and publisher rely on.
 *
 * Why an abstract class instead of a single shared entity:
 *   Each service owns its own DB schema and migrations. Sharing a single
 *   entity across services would force them to share a table, which breaks
 *   bounded-context isolation.
 *
 * @see OutboxModule.forFeature for the registration API.
 * @see Phase 2 of farm domain real-time visibility plan.
 */
export abstract class OutboxEntityBase {
  // WHY string type for bigint: PostgreSQL bigint can represent values up to 2^63-1,
  // but JavaScript's Number type safely represents integers only up to 2^53-1.
  // TypeORM's standard practice is to map bigint columns to string in TypeScript
  // to avoid silent precision loss on large IDs. The string representation is
  // safe for JSON serialization, comparison, and storage.
  //
  // Subclasses CAN override this with `@PrimaryGeneratedColumn('uuid')` and
  // `declare id: string` for services that use UUID PKs (e.g. messaging-service).
  // The worker uses raw SQL queries with `this.repo.metadata.tableName` — PK type
  // is transparent to the polling/lease logic because `id` is always string-typed.
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id!: string;

  /** PascalCase event type — e.g. 'BatchCreated', 'MortalityRecorded'. */
  @Column({ type: 'varchar', length: 100 })
  eventType!: string;

  /**
   * Tenant isolation key. Stored both in the payload (JSONB) and as a
   * first-class column for indexed filtering and NATS subject routing
   * (`events.{tenantId}.{eventType}`).
   *
   * Nullable for backward compatibility with existing services (farm, hr)
   * that don't yet populate this column. The worker reads tenantId from
   * payload.tenantId when the column is null.
   */
  @Column({ type: 'uuid', nullable: true })
  tenantId!: string | null;

  /**
   * Domain aggregate root ID for event ordering and correlation.
   * Optional — only relevant for services that need per-aggregate ordering.
   */
  @Column({ type: 'uuid', nullable: true })
  aggregateId!: string | null;

  /**
   * Full BaseEvent payload serialized as JSONB.
   *
   * NOTE: Date fields (timestamp, mortalityDate, etc.) are stored as
   * ISO 8601 strings after JSON serialization. Consumers must convert
   * back to Date objects if needed.
   */
  @Column({ type: 'jsonb' })
  payload!: OutboxStoredPayload;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  /** Set when the event has been successfully published to NATS. */
  @Column({ type: 'timestamptz', nullable: true })
  publishedAt!: Date | null;

  /** Number of failed publish attempts. Dead-lettered at OUTBOX_MAX_RETRIES. */
  @Column({ type: 'integer', default: 0 })
  retryCount!: number;

  /** Truncated error message from the last failed publish attempt. */
  @Column({ type: 'text', nullable: true })
  lastError!: string | null;

  /**
   * Earliest time this row is eligible for retry. Set by the worker on
   * failed publish attempts using exponential backoff:
   *   nextAttemptAt = NOW() + BASE * 2^retryCount + jitter
   *
   * The polling predicate includes `AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= NOW())`
   * so rows with a future nextAttemptAt are skipped until the backoff expires.
   *
   * Nullable for backward compat: existing rows without this column are
   * immediately eligible (NULL treated as "now" in the predicate).
   */
  @Column({ type: 'timestamptz', nullable: true })
  nextAttemptAt!: Date | null;

  /**
   * Deduplication key for idempotent enqueue. When set, the UNIQUE index
   * on (tenantId, idempotencyKey) prevents duplicate outbox rows for the
   * same logical operation (e.g. retry of a command handler).
   *
   * Nullable — most events don't need explicit dedup because the domain
   * transaction already prevents double-writes.
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  idempotencyKey!: string | null;

  /**
   * Explicit dead-letter flag. Set when retryCount >= MAX_RETRIES.
   * Provides a fast-path filter for the polling predicate:
   *   AND "isDeadLettered" = false
   * is cheaper than AND "retryCount" < MAX_RETRIES on large tables.
   */
  @Column({ type: 'boolean', default: false })
  isDeadLettered!: boolean;

  /**
   * Lease acquired timestamp — set by the worker when it claims a row
   * for publishing, cleared when the row is marked `publishedAt` or when
   * a transient failure releases the row for re-processing.
   *
   * # Why a lease column instead of long-held row locks
   *
   * The worker MUST not hold a row-level lock for the entire NATS publish
   * window: publish latency is dominated by network I/O (~5-30ms per
   * event), during which other replicas would be blocked from scanning
   * the table. Instead the worker acquires the lock briefly inside a
   * transaction that ONLY tags the rows (`leasedAt`, `leasedBy`), then
   * commits — releasing the lock — and publishes outside the transaction.
   * Other replicas querying the outbox see the fresh `leasedAt` value
   * and skip the row via the polling predicate, without needing a lock.
   *
   * # Crash recovery
   *
   * If the holding worker crashes mid-publish, its `leasedAt` stays
   * fresh for `OUTBOX_LEASE_DURATION_MS` (default 5 minutes). After that
   * window, the next polling worker treats the lease as expired and
   * re-claims the row. The event is eventually published; at most one
   * extra publish can occur per crash, absorbed by NATS
   * `msgID + duplicate_window`. Stuck-event worst case: 5 minutes.
   *
   * # Why nullable
   *
   * A row enters the table without a lease (`leasedAt = NULL`) and
   * returns to the unclaimed state on successful publish (cleared back
   * to `NULL` together with `publishedAt = NOW()`). Leaving a lease tag
   * on a terminal row would confuse operators reading the table.
   */
  @Column({ type: 'timestamptz', nullable: true })
  leasedAt!: Date | null;

  /**
   * Identifier of the worker that currently holds the lease on this row.
   * Format: `${hostname}-${pid}` (e.g. `farm-service-7d9f6c4b-abc12-42`).
   *
   * Purely informational — the polling predicate keys off `leasedAt`
   * expiry, not `leasedBy` identity. Operators use this field to answer
   * "which pod is stuck holding this row?" without needing to correlate
   * logs across replicas.
   */
  @Column({ type: 'varchar', length: 128, nullable: true })
  leasedBy!: string | null;
}
