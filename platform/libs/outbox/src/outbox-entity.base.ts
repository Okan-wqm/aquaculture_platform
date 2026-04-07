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
}
