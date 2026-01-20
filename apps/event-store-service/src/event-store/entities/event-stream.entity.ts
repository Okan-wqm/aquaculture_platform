import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Event stream metadata entity
 * Tracks stream information and current position
 */
@Entity('event_streams')
@Index(['streamName'], { unique: true })
@Index(['tenantId'])
@Index(['aggregateType'])
export class EventStream {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * Unique stream name (typically: {aggregateType}-{aggregateId})
   */
  @Column({ type: 'varchar', length: 255, unique: true })
  streamName!: string;

  /**
   * Aggregate root type
   */
  @Column({ type: 'varchar', length: 255 })
  aggregateType!: string;

  /**
   * Aggregate root identifier
   */
  @Column({ type: 'uuid' })
  aggregateId!: string;

  /**
   * Current version of the aggregate
   */
  @Column({ type: 'int', default: 0 })
  currentVersion!: number;

  /**
   * Total number of events in this stream
   */
  @Column({ type: 'bigint', default: 0 })
  eventCount!: number;

  /**
   * Multi-tenant isolation
   */
  @Column({ type: 'uuid' })
  tenantId!: string;

  /**
   * Whether the stream is soft deleted
   */
  @Column({ type: 'boolean', default: false })
  isDeleted!: boolean;

  /**
   * Stream creation timestamp
   */
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  /**
   * Last update timestamp
   */
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  /**
   * Last event timestamp
   */
  @Column({ type: 'timestamptz', nullable: true })
  lastEventAt?: Date;
}
