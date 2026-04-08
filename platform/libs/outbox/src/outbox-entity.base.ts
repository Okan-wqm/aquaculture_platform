import {
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

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
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id!: string;

  /** PascalCase event type — e.g. 'BatchCreated', 'MortalityRecorded'. */
  @Column({ type: 'varchar', length: 100 })
  eventType!: string;

  /**
   * Full BaseEvent payload serialized as JSONB.
   *
   * NOTE: Date fields (timestamp, mortalityDate, etc.) are stored as
   * ISO 8601 strings after JSON serialization. Consumers must convert
   * back to Date objects if needed.
   */
  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

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
