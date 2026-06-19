import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  Check,
} from 'typeorm';

/**
 * Data Request Type
 */
export enum DataRequestType {
  EXPORT = 'export',
  DELETION = 'deletion',
  RECTIFICATION = 'rectification',
  RESTRICTION = 'restriction',
  PORTABILITY = 'portability',
}

/**
 * Data Request Status
 */
export enum DataRequestStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

/**
 * GDPR Data Request Entity
 *
 * Tracks user requests for data access, deletion, etc.
 * Required for GDPR compliance to prove request handling.
 */
@Entity('gdpr_data_requests', { schema: 'shared' })
@Check(`"requestType" IN ('export', 'deletion', 'rectification', 'restriction', 'portability')`)
@Check(`status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')`)
@Index('IDX_data_request_user', ['userId'])
@Index('IDX_data_request_tenant', ['tenantId'])
@Index('IDX_data_request_type', ['requestType'])
@Index('IDX_data_request_status', ['status'])
export class GdprDataRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'uuid', nullable: true })
  tenantId?: string | null;

  @Column({
    type: 'varchar',
    length: 50,
  })
  requestType!: DataRequestType;

  @Column({
    type: 'varchar',
    length: 50,
    default: DataRequestStatus.PENDING,
  })
  status!: DataRequestStatus;

  @Column({ type: 'text', nullable: true })
  reason?: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  ipAddress?: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  userAgent?: string | null;

  @Column({ type: 'jsonb', nullable: true })
  requestDetails?: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  processingDetails?: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  downloadUrl?: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  downloadExpiresAt?: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  processedAt?: Date | null;

  @Column({ type: 'uuid', nullable: true })
  processedBy?: string | null;

  @Column({ type: 'text', nullable: true })
  errorMessage?: string | null;

  @Column({ type: 'int', default: 0 })
  recordsAffected!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  /**
   * Check if request is still pending
   */
  isPending(): boolean {
    return this.status === DataRequestStatus.PENDING;
  }

  /**
   * Check if request can be downloaded
   */
  canDownload(): boolean {
    if (this.status !== DataRequestStatus.COMPLETED) return false;
    if (!this.downloadUrl) return false;
    if (this.downloadExpiresAt && this.downloadExpiresAt < new Date()) return false;
    return true;
  }
}
