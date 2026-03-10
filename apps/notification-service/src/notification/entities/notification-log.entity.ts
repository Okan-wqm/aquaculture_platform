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
}

/**
 * Notification Log Entity
 * Records all sent notifications for audit and tracking
 */
@Entity('notification_logs')
@Index(['tenantId', 'sentAt'])
@Index(['channel', 'status'])
export class NotificationLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'tenant_id' })
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
