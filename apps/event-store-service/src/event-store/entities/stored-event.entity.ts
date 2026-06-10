import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  CreateDateColumn,
} from 'typeorm';
import { BigIntTransformer } from '../transformers/bigint.transformer';

/**
 * Stored event entity for event sourcing
 * This is the core entity that stores all domain events
 */
@Entity('stored_events', { schema: 'event_store' })
@Index(
  'IDX_stored_events_tenant_aggregate_type_id_version',
  ['tenantId', 'aggregateType', 'aggregateId', 'version'],
  { unique: true },
)
@Index(['globalPosition'], { unique: true })
@Index(['streamName'])
@Index(['eventType'])
@Index(['tenantId'])
@Index(['occurredAt'])
@Index(['correlationId'])
@Index(['tenantId', 'streamName', 'version'])
@Index(['tenantId', 'globalPosition'])
@Index(['tenantId', 'eventType'])
@Index(['tenantId', 'storedAt'])
@Index(
  'IDX_stored_events_tenant_producer_event',
  ['tenantId', 'producer', 'producerEventId'],
  { unique: true },
)
/**
 * Composite index for tenant-scoped aggregate event replay.
 * Event store queries filter by tenant_id + aggregate_id + version
 * for event-sourced replay of a specific aggregate within a tenant.
 * Without this index, the query planner cannot use the existing
 * (aggregateType, aggregateId, version) unique index when tenant_id
 * is part of the WHERE clause (common in multi-tenant queries).
 * @see DATA-MEDIUM-013
 */
@Index('IDX_stored_events_tenant_aggregate_version', ['tenantId', 'aggregateId', 'version'])
export class StoredEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * Calling service that produced the event. Nullable for historical rows.
   */
  @Column({ type: 'varchar', length: 100, nullable: true })
  producer?: string | null;

  /**
   * Producer-owned immutable event identity. Distinct from request-level
   * idempotencyKey so a batch retry cannot hide per-event identity drift.
   */
  @Column({ type: 'uuid', nullable: true })
  producerEventId?: string | null;

  /**
   * Stream identification for event grouping
   */
  @Column({ type: 'varchar', length: 255 })
  streamName!: string;

  /**
   * Sequential position within the global event log
   */
  @Column({ type: 'bigint', transformer: new BigIntTransformer() })
  globalPosition!: number;

  /**
   * Position within the specific stream
   */
  @Column({ type: 'bigint', transformer: new BigIntTransformer() })
  streamPosition!: number;

  /**
   * Aggregate root type (e.g., 'Farm', 'Sensor', 'Alert')
   */
  @Column({ type: 'varchar', length: 255 })
  aggregateType!: string;

  /**
   * Unique identifier of the aggregate root
   */
  @Column({ type: 'uuid' })
  aggregateId!: string;

  /**
   * Version number for optimistic concurrency
   */
  @Column({ type: 'int' })
  version!: number;

  /**
   * Event type name (e.g., 'FarmCreated', 'SensorReadingRecorded')
   */
  @Column({ type: 'varchar', length: 255 })
  eventType!: string;

  /**
   * Serialized event payload
   */
  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  /**
   * Event metadata (tracing info, user info, etc.)
   */
  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  /**
   * Multi-tenant isolation
   */
  @Column({ type: 'uuid' })
  tenantId!: string;

  /**
   * Correlation ID for request tracing
   */
  @Column({ type: 'uuid', nullable: true })
  correlationId?: string;

  /**
   * Causation ID linking to the causing event
   */
  @Column({ type: 'uuid', nullable: true })
  causationId?: string;

  /**
   * User who triggered the event
   */
  @Column({ type: 'uuid', nullable: true })
  userId?: string;

  /**
   * When the event occurred in the domain
   */
  @Column({ type: 'timestamptz' })
  occurredAt!: Date;

  /**
   * When the event was stored in the event store.
   *
   * WHY "storedAt" instead of "createdAt": In event sourcing, an event has two
   * timestamps with different semantics — `occurredAt` (when the domain event
   * happened) and `storedAt` (when it was persisted to the store). Using the
   * generic `createdAt` would conflate these two concepts and invite future
   * "consistency" refactors that would break the semantic distinction.
   */
  @CreateDateColumn({ type: 'timestamptz' })
  storedAt!: Date;

  /**
   * Schema version for event evolution
   */
  @Column({ type: 'int', default: 1 })
  schemaVersion!: number;
}
