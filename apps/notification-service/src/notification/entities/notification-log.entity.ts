import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
} from 'typeorm';

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

  @Column({ name: 'status', type: 'enum', enum: NotificationStatus, default: NotificationStatus.PENDING })
  status!: NotificationStatus;

  @Column({ name: 'external_id', nullable: true })
  externalId?: string; // ID from email/SMS provider

  /**
   * Caller-supplied delivery receipt key (W7 — FARM-LOW-282).
   *
   * The PUSH leg of a fan-out is already idempotent via
   * `notification.command_receipts`; the IN_APP row was not, so a NATS
   * redelivery after a push failure wrote the digest into the user's bell a
   * second time. A partial unique index on
   * `(tenant_id, recipient, delivery_id) WHERE channel = 'in_app'` makes the
   * duplicate impossible at the database rather than merely unlikely in the
   * handler.
   *
   * Nullable on purpose: ad-hoc in-app rows (alerts, messaging pings) carry no
   * receipt identity and stay outside the index.
   */
  @Column({ name: 'delivery_id', nullable: true })
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
