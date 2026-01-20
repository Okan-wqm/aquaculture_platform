import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  CreateDateColumn,
} from 'typeorm';

/**
 * Stored event entity for event sourcing
 * This is the core entity that stores all domain events
 */
@Entity('stored_events')
@Index(['aggregateType', 'aggregateId', 'version'], { unique: true })
@Index(['streamName'])
@Index(['eventType'])
@Index(['tenantId'])
@Index(['occurredAt'])
@Index(['correlationId'])
export class StoredEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * Stream identification for event grouping
   */
  @Column({ type: 'varchar', length: 255 })
  streamName!: string;

  /**
   * Sequential position within the global event log
   */
  @Column({ type: 'bigint' })
  globalPosition!: number;

  /**
   * Position within the specific stream
   */
  @Column({ type: 'bigint' })
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
   * When the event was stored
   */
  @CreateDateColumn({ type: 'timestamptz' })
  storedAt!: Date;

  /**
   * Schema version for event evolution
   */
  @Column({ type: 'int', default: 1 })
  schemaVersion!: number;
}
