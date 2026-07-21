/**
 * Support & Communication Entities
 *
 * Messaging, announcements, tickets ve onboarding için entity tanımları.
 */

import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from 'typeorm';

// ============================================================================
// Enums
// ============================================================================

export type MessageStatus = 'sent' | 'delivered' | 'read' | 'failed';
export type OnboardingStatus = 'not_started' | 'in_progress' | 'completed' | 'skipped';

// APA-213: TicketPriority / TicketStatus / TicketCategory (and the SupportTicket
// + TicketComment entities, the TicketAttachment / SLAConfig / TicketStats types,
// and the ticket controller/service) were REMOVED. Support tickets are owned by
// auth-service (auth.support_tickets / auth.ticket_comments) and served via
// GraphQL; the admin.support_tickets / admin.ticket_comments duplicate store is
// dropped by 1801800000000-MigrateSupportTicketsToAuth (rows copied into auth
// first). Message threads/messages and onboarding remain admin-owned.

// ============================================================================
// Message Thread Entity
// ============================================================================

@Entity('message_threads', { schema: 'admin' })
@Index(['tenantId'])
@Index(['lastMessageAt'])
export class MessageThread {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  tenantId!: string;

  @Column({ type: 'varchar', length: 200 })
  subject!: string;

  @Column({ type: 'uuid', nullable: true })
  lastMessageId?: string;

  @Column({ type: 'int', default: 0 })
  messageCount!: number;

  @Column({ type: 'int', default: 0 })
  unreadAdminCount!: number;

  @Column({ type: 'int', default: 0 })
  unreadTenantCount!: number;

  @Column({ type: 'boolean', default: false })
  isArchived!: boolean;

  @Column({ type: 'boolean', default: false })
  isClosed!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  lastMessageAt?: Date;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  @OneToMany(() => Message, message => message.thread)
  messages!: Message[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

// ============================================================================
// Message Entity
// ============================================================================

@Entity('messages', { schema: 'admin' })
@Index(['threadId'])
@Index(['senderId'])
@Index(['createdAt'])
export class Message {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  threadId!: string;

  @Column({ type: 'uuid' })
  senderId!: string;

  @Column({ type: 'varchar', length: 50 })
  senderType!: 'admin' | 'tenant_admin' | 'system';

  @Column({ type: 'varchar', length: 200, nullable: true })
  senderName?: string;

  @Column({ type: 'text' })
  content!: string;

  @Column({ type: 'varchar', length: 50, default: 'sent' })
  status!: MessageStatus;

  @Column({ type: 'boolean', default: false })
  isInternal!: boolean;

  @Column({ type: 'jsonb', nullable: true })
  attachments?: MessageAttachment[];

  @Column({ type: 'timestamptz', nullable: true })
  readAt?: Date;

  @Column({ type: 'boolean', default: false })
  emailSent!: boolean;

  @ManyToOne(() => MessageThread, thread => thread.messages)
  @JoinColumn({ name: 'threadId' })
  thread!: MessageThread;

  @CreateDateColumn()
  createdAt!: Date;
}

// ============================================================================
// Announcement entities (REMOVED — APA-201)
// ============================================================================
//
// The admin.announcements / admin.announcement_acknowledgments tables were a
// write-only duplicate of the auth.announcements SSoT tenants actually read.
// The Announcement + AnnouncementAcknowledgment entities, their controller and
// service, are deleted; the tables are dropped by
// 1801700000000-MigrateAnnouncementsToAuth (rows copied into auth first).
// The `AnnouncementTarget` interface below is retained — it is the jsonb shape
// for messaging bulk targeting (BulkMessageRequest), a separate silo.

// ============================================================================
// Support Ticket + Ticket Comment Entities (REMOVED — APA-213)
// ============================================================================
//
// The admin.support_tickets / admin.ticket_comments tables were a write-only
// duplicate of the auth.support_tickets / auth.ticket_comments SSoT tenants
// actually read. The SupportTicket + TicketComment entities, their controller
// and service, are deleted; the tables are dropped by
// 1801800000000-MigrateSupportTicketsToAuth (rows copied into auth first).

// ============================================================================
// Onboarding Progress Entity
// ============================================================================

@Entity('onboarding_progress', { schema: 'admin' })
@Index(['tenantId'])
@Index(['status'])
export class OnboardingProgress {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', unique: true })
  tenantId!: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  tenantName?: string;

  @Column({ type: 'varchar', length: 50, default: 'not_started' })
  status!: OnboardingStatus;

  @Column({ type: 'int', default: 0 })
  completionPercent!: number;

  @Column({ type: 'jsonb', default: [] })
  completedSteps!: string[];

  @Column({ type: 'varchar', length: 100, nullable: true })
  currentStep?: string;

  @Column({ type: 'boolean', default: false })
  welcomeEmailSent!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  welcomeEmailSentAt?: Date;

  @Column({ type: 'boolean', default: false })
  gettingStartedViewed!: boolean;

  @Column({ type: 'jsonb', nullable: true })
  viewedTutorials?: string[];

  @Column({ type: 'jsonb', nullable: true })
  scheduledTrainings?: TrainingSession[];

  @Column({ type: 'uuid', nullable: true })
  assignedGuide?: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  assignedGuideName?: string;

  @Column({ type: 'timestamptz', nullable: true })
  startedAt?: Date;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt?: Date;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

// ============================================================================
// Types
// ============================================================================

export interface MessageAttachment {
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  url: string;
  uploadedAt: string;
}

export interface AnnouncementTarget {
  plans?: string[];
  modules?: string[];
  regions?: string[];
  tenantIds?: string[];
  excludeTenantIds?: string[];
  tenantStatuses?: string[];
  includeInactive?: boolean;
}

export interface TrainingSession {
  id: string;
  title: string;
  type: 'video_call' | 'webinar' | 'in_person';
  scheduledAt: string;
  duration: number;
  trainer: string;
  status: 'scheduled' | 'completed' | 'cancelled';
  meetingUrl?: string;
  notes?: string;
}

export interface OnboardingStep {
  id: string;
  title: string;
  description: string;
  order: number;
  isRequired: boolean;
  estimatedMinutes: number;
  resourceUrl?: string;
  videoUrl?: string;
}

export interface BulkMessageRequest {
  subject: string;
  content: string;
  targetCriteria?: AnnouncementTarget;
  sendEmail: boolean;
}

export interface ThreadSummary {
  id: string;
  tenantId: string;
  tenantName: string;
  subject: string;
  lastMessage: string;
  lastMessageAt: Date;
  unreadCount: number;
  messageCount: number;
  isClosed: boolean;
}
