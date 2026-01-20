import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  CreateDateColumn,
} from 'typeorm';

/**
 * Snapshot entity for aggregate state caching
 * Used to optimize event replay by storing periodic aggregate states
 */
@Entity('snapshots')
@Index(['aggregateType', 'aggregateId'], { unique: true })
@Index(['tenantId'])
export class Snapshot {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

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
   * Version at which snapshot was taken
   */
  @Column({ type: 'int' })
  version!: number;

  /**
   * Serialized aggregate state
   */
  @Column({ type: 'jsonb' })
  state!: Record<string, unknown>;

  /**
   * Multi-tenant isolation
   */
  @Column({ type: 'uuid' })
  tenantId!: string;

  /**
   * When the snapshot was created
   */
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  /**
   * Schema version for snapshot evolution
   */
  @Column({ type: 'int', default: 1 })
  schemaVersion!: number;
}
