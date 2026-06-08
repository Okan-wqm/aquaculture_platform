import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { BigIntStringTransformer } from '../../event-store/transformers/bigint.transformer';

export enum ProjectionRebuildStatus {
  REQUESTED = 'requested',
  LEASED = 'leased',
  BUILDING_SHADOW = 'building_shadow',
  VALIDATING = 'validating',
  CATCHING_UP = 'catching_up',
  SWAPPING = 'swapping',
  COMPLETED = 'completed',
  ABORTED = 'aborted',
  FAILED = 'failed',
}

export const ACTIVE_PROJECTION_REBUILD_STATUSES = [
  ProjectionRebuildStatus.REQUESTED,
  ProjectionRebuildStatus.LEASED,
  ProjectionRebuildStatus.BUILDING_SHADOW,
  ProjectionRebuildStatus.VALIDATING,
  ProjectionRebuildStatus.CATCHING_UP,
  ProjectionRebuildStatus.SWAPPING,
] as const;

@Entity('projection_rebuilds', { schema: 'event_store' })
@Index('IDX_projection_rebuilds_tenant_projection_status', ['tenantId', 'projectionName', 'status'])
@Index('IDX_projection_rebuilds_lease', ['tenantId', 'projectionName', 'leaseToken'])
@Index('IDX_projection_rebuilds_one_active_job', ['tenantId', 'projectionName'], {
  unique: true,
  where:
    "\"status\" IN ('requested','leased','building_shadow','validating','catching_up','swapping')",
})
@Index('IDX_projection_rebuilds_idempotency', ['tenantId', 'projectionName', 'idempotencyKey'], {
  unique: true,
  where: '"idempotencyKey" IS NOT NULL',
})
export class ProjectionRebuild {
  @PrimaryGeneratedColumn('uuid')
  jobId!: string;

  @Column({ type: 'uuid' })
  tenantId!: string;

  @Column({ type: 'varchar', length: 255 })
  projectionName!: string;

  @Column({ type: 'bigint', transformer: new BigIntStringTransformer() })
  requestedFromPosition!: string;

  @Column({ type: 'int' })
  sourceGeneration!: number;

  @Column({ type: 'int' })
  targetGeneration!: number;

  @Column({ type: 'uuid', nullable: true })
  leaseToken?: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  leaseExpiresAt?: Date | null;

  @Column({ type: 'varchar', length: 40, default: ProjectionRebuildStatus.REQUESTED })
  status!: ProjectionRebuildStatus;

  @Column({ type: 'varchar', length: 255, nullable: true })
  requestedBy?: string | null;

  @Column({ type: 'text' })
  reason!: string;

  @Column({ type: 'uuid', nullable: true })
  correlationId?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  idempotencyKey?: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  leasedAt?: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  buildStartedAt?: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  validatedAt?: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  caughtUpAt?: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  swappedAt?: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  releasedAt?: Date | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  validationHash?: string | null;

  @Column({ type: 'bigint', nullable: true, transformer: new BigIntStringTransformer() })
  validationCount?: string | null;

  @Column({ type: 'text', nullable: true })
  abortReason?: string | null;

  @Column({ type: 'text', nullable: true })
  failureReason?: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  requestedAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
