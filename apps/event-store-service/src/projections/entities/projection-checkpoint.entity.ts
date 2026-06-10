import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { BigIntTransformer } from '../../event-store/transformers/bigint.transformer';

export enum ProjectionStatus {
  RUNNING = 'running',
  PAUSED = 'paused',
  STOPPED = 'stopped',
  FAULTED = 'faulted',
}

/**
 * Projection checkpoint entity
 * Tracks the current position for each projection/subscription
 */
@Entity('projection_checkpoints', { schema: 'event_store' })
@Index(['tenantId', 'projectionName'], { unique: true })
@Index(['tenantId'])
@Index(['status'])
export class ProjectionCheckpoint {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * Unique projection name (unique per tenant)
   */
  @Column({ type: 'varchar', length: 255 })
  projectionName!: string;

  /**
   * Description of what this projection does
   */
  @Column({ type: 'varchar', length: 500, nullable: true })
  description?: string;

  /**
   * Current position in the global event log
   */
  @Column({ type: 'bigint', default: 0, transformer: new BigIntTransformer() })
  position!: number;

  @Column({ type: 'int', default: 1 })
  generation!: number;

  /**
   * Current status of the projection
   */
  @Column({
    type: 'enum',
    enum: ProjectionStatus,
    default: ProjectionStatus.RUNNING,
  })
  status!: ProjectionStatus;

  /**
   * Multi-tenant isolation
   */
  @Column({ type: 'uuid' })
  tenantId!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  leaseOwner?: string | null;

  @Column({ type: 'uuid', nullable: true })
  leaseToken?: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  leaseExpiresAt?: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  heartbeatAt?: Date | null;

  /**
   * Consumer group for shared subscriptions
   */
  @Column({ type: 'varchar', length: 100, nullable: true })
  consumerGroup?: string;

  /**
   * Event types this projection subscribes to
   */
  @Column({ type: 'jsonb', default: [] })
  eventTypes!: string[];

  /**
   * Aggregate types this projection subscribes to
   */
  @Column({ type: 'jsonb', default: [] })
  aggregateTypes!: string[];

  /**
   * Total events processed
   */
  @Column({ type: 'bigint', default: 0, transformer: new BigIntTransformer() })
  eventsProcessed!: number;

  /**
   * Total events that failed processing
   */
  @Column({ type: 'bigint', default: 0, transformer: new BigIntTransformer() })
  eventsFailed!: number;

  /**
   * Last error message if faulted (truncated to 500 chars)
   */
  @Column({ type: 'text', nullable: true })
  lastError?: string;

  /**
   * Last error timestamp
   */
  @Column({ type: 'timestamptz', nullable: true })
  lastErrorAt?: Date;

  /**
   * Average processing time in milliseconds
   */
  @Column({ type: 'float', default: 0 })
  avgProcessingTimeMs!: number;

  /**
   * When the projection was created
   */
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  /**
   * When the projection was last updated
   */
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  /**
   * When the last event was processed
   */
  @Column({ type: 'timestamptz', nullable: true })
  lastProcessedAt?: Date;
}
