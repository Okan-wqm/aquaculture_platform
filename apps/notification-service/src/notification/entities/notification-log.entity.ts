import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm';

/**
 * Notification status enum
 */
export enum NotificationStatus {
  PENDING = 'pending',
  SENT = 'sent',
  FAILED = 'failed',
  RETRYING = 'retrying',
  BOUNCED = 'bounced',
  DEAD_LETTER = 'dead_letter',
}

/**
 * Notification channel enum
 */
export enum NotificationChannel {
  EMAIL = 'email',
  SMS = 'sms',
  PUSH = 'push',
  WEBHOOK = 'webhook',
  IN_APP = 'in_app',
  SYSTEM = 'system',
}

/**
 * Notification Log Entity
 * Records all sent notifications for audit and tracking
 */
@Entity('notification_logs', { schema: 'notification' })
@Index(['tenantId', 'sentAt'])
@Index(['channel', 'status'])
@Index('uq_notification_logs_in_app_delivery', ['tenantId', 'recipient', 'deliveryId'], {
  unique: true,
  where: `"channel" = 'in_app' AND "delivery_id" IS NOT NULL`,
})
/**
 * Composite index for unread notification queries:
 *   WHERE tenant_id = ? AND recipient = ? AND channel = 'in_app'
 * Without this index, the unread badge count query performs a full table scan.
 * @see DATA-MEDIUM-021
 */
@Index('IDX_notification_tenant_recipient_channel', ['tenantId', 'recipient', 'channel'])
export class NotificationLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  @Column({ name: 'channel', type: 'enum', enum: NotificationChannel })
  channel!: NotificationChannel;

  @Column({ name: 'recipient' })
  recipient!: string;

  @Column({ name: 'subject' })
  subject!: string;

  @Column({ name: 'content', type: 'text' })
  content!: string;

  @Column({
    name: 'status',
    type: 'enum',
    enum: NotificationStatus,
    default: NotificationStatus.PENDING,
  })
  status!: NotificationStatus;

  @Column({ name: 'external_id', nullable: true })
  externalId?: string; // ID from email/SMS provider

  /** Durable identity for idempotent channel delivery. */
  @Column({ name: 'delivery_id', type: 'varchar', length: 255, nullable: true })
  deliveryId?: string;

  @Column({ name: 'metadata', type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>; // Alert context, user preferences, etc.

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage?: string;

  @Column({ name: 'retry_count', type: 'int', default: 0 })
  retryCount!: number;

  @Column({ name: 'next_retry_at', type: 'timestamptz', nullable: true })
  nextRetryAt?: Date;

  @Column({ name: 'sent_at', type: 'timestamptz', nullable: true })
  sentAt?: Date;

  @Column({ name: 'delivered_at', type: 'timestamptz', nullable: true })
  deliveredAt?: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
