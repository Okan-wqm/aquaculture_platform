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
}

/**
 * Notification channel enum
 */
export enum NotificationChannel {
  EMAIL = 'email',
  SMS = 'sms',
  PUSH = 'push',
  WEBHOOK = 'webhook',
}

/**
 * Notification Log Entity
 * Records all sent notifications for audit and tracking
 */
@Entity('notification_logs')
@Index(['tenantId', 'sentAt'])
@Index(['status'])
@Index(['channel', 'status'])
export class NotificationLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  @Index()
  tenantId: string;

  @Column({ type: 'enum', enum: NotificationChannel })
  channel: NotificationChannel;

  @Column()
  recipient: string;

  @Column()
  subject: string;

  @Column('text')
  content: string;

  @Column({ type: 'enum', enum: NotificationStatus, default: NotificationStatus.PENDING })
  @Index()
  status: NotificationStatus;

  @Column({ nullable: true })
  externalId?: string; // ID from email/SMS provider

  @Column('jsonb', { nullable: true })
  metadata?: Record<string, unknown>; // Alert context, user preferences, etc.

  @Column({ type: 'text', nullable: true })
  errorMessage?: string;

  @Column({ type: 'int', default: 0 })
  retryCount: number;

  @Column({ type: 'timestamptz', nullable: true })
  sentAt?: Date;

  @Column({ type: 'timestamptz', nullable: true })
  deliveredAt?: Date;

  @CreateDateColumn()
  createdAt: Date;
}
