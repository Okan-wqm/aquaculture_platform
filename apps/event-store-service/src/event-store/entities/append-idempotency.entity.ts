import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum AppendIdempotencyStatus {
  STARTED = 'started',
  COMPLETED = 'completed',
}

@Entity('append_idempotency', { schema: 'event_store' })
@Index(
  'IDX_append_idempotency_tenant_producer_key',
  ['tenantId', 'producer', 'idempotencyKey'],
  { unique: true },
)
export class AppendIdempotency {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  tenantId!: string;

  @Column({ type: 'varchar', length: 100 })
  producer!: string;

  @Column({ type: 'varchar', length: 255 })
  idempotencyKey!: string;

  @Column({ type: 'char', length: 64 })
  requestHash!: string;

  @Column({
    type: 'enum',
    enum: AppendIdempotencyStatus,
    default: AppendIdempotencyStatus.STARTED,
  })
  status!: AppendIdempotencyStatus;

  @Column({ type: 'jsonb', nullable: true })
  result?: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
