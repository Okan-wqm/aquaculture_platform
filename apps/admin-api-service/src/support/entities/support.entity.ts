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
export type AnnouncementType = 'info' | 'warning' | 'critical' | 'maintenance';
export type AnnouncementStatus = 'draft' | 'scheduled' | 'published' | 'expired' | 'cancelled';
export type TicketPriority = 'low' | 'medium' | 'high' | 'critical';
export type TicketStatus = 'open' | 'in_progress' | 'waiting_customer' | 'resolved' | 'closed';
export type TicketCategory = 'technical' | 'billing' | 'feature_request' | 'bug_report' | 'general' | 'account';
export type OnboardingStatus = 'not_started' | 'in_progress' | 'completed' | 'skipped';

// ============================================================================
// Message Thread Entity
// ============================================================================

@Entity('message_threads')
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

  @Column({ type: 'timestamp', nullable: true })
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

@Entity('messages')
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

  @Column({ type: 'timestamp', nullable: true })
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
// Announcement Entity
// ============================================================================

@Entity('announcements')
@Index(['status'])
@Index(['type'])
@Index(['publishAt'])
@Index(['expiresAt'])
export class Announcement {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 200 })
  title!: string;

  @Column({ type: 'text' })
  content!: string;

  @Column({ type: 'varchar', length: 50, default: 'info' })
  type!: AnnouncementType;

  @Column({ type: 'varchar', length: 50, default: 'draft' })
  status!: AnnouncementStatus;

  @Column({ type: 'boolean', default: false })
  isGlobal!: boolean;

  @Column({ type: 'jsonb', nullable: true })
  targetCriteria?: AnnouncementTarget;

  @Column({ type: 'uuid', nullable: true })
  createdBy?: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  createdByName?: string;

  @Column({ type: 'timestamp', nullable: true })
  publishAt?: Date;

  @Column({ type: 'timestamp', nullable: true })
  expiresAt?: Date;

  @Column({ type: 'boolean', default: false })
  requiresAcknowledgment!: boolean;

  @Column({ type: 'int', default: 0 })
  viewCount!: number;

  @Column({ type: 'int', default: 0 })
  acknowledgmentCount!: number;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  @OneToMany(() => AnnouncementAcknowledgment, ack => ack.announcement)
  acknowledgments!: AnnouncementAcknowledgment[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

// ============================================================================
// Announcement Acknowledgment Entity
// ============================================================================

@Entity('announcement_acknowledgments')
@Index(['announcementId'])
@Index(['tenantId'])
@Index(['userId'])
export class AnnouncementAcknowledgment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  announcementId!: string;

  @Column({ type: 'uuid' })
  tenantId!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  userName?: string;

  @Column({ type: 'timestamp', nullable: true })
  viewedAt?: Date;

  @Column({ type: 'timestamp', nullable: true })
  acknowledgedAt?: Date;

  @ManyToOne(() => Announcement, announcement => announcement.acknowledgments)
  @JoinColumn({ name: 'announcementId' })
  announcement!: Announcement;

  @CreateDateColumn()
  createdAt!: Date;
}

// ============================================================================
// Support Ticket Entity
// ============================================================================

@Entity('support_tickets')
@Index(['tenantId'])
@Index(['status'])
@Index(['priority'])
@Index(['category'])
@Index(['assignedTo'])
@Index(['dueAt'])
export class SupportTicket {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 20, unique: true })
  ticketNumber!: string;

  @Column({ type: 'uuid' })
  tenantId!: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  tenantName?: string;

  @Column({ type: 'uuid' })
  createdBy!: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  createdByName?: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  createdByEmail?: string;

  @Column({ type: 'varchar', length: 200 })
  subject!: string;

  @Column({ type: 'text' })
  description!: string;

  @Column({ type: 'varchar', length: 50, default: 'general' })
  category!: TicketCategory;

  @Column({ type: 'varchar', length: 50, default: 'medium' })
  priority!: TicketPriority;

  @Column({ type: 'varchar', length: 50, default: 'open' })
  status!: TicketStatus;

  @Column({ type: 'uuid', nullable: true })
  assignedTo?: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  assignedToName?: string;

  @Column({ type: 'jsonb', nullable: true })
  tags?: string[];

  @Column({ type: 'timestamp', nullable: true })
  firstResponseAt?: Date;

  @Column({ type: 'timestamp', nullable: true })
  resolvedAt?: Date;

  @Column({ type: 'timestamp', nullable: true })
  closedAt?: Date;

  @Column({ type: 'timestamp', nullable: true })
  dueAt?: Date;

  @Column({ type: 'int', nullable: true })
  slaResponseMinutes?: number;

  @Column({ type: 'int', nullable: true })
  slaResolutionMinutes?: number;

  @Column({ type: 'boolean', default: false })
  slaBreached!: boolean;

  @Column({ type: 'int', default: 0 })
  satisfactionRating!: number;

  @Column({ type: 'text', nullable: true })
  satisfactionFeedback?: string | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  @OneToMany(() => TicketComment, comment => comment.ticket)
  comments!: TicketComment[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

// ============================================================================
// Ticket Comment Entity
// ============================================================================

@Entity('ticket_comments')
@Index(['ticketId'])
@Index(['authorId'])
@Index(['createdAt'])
export class TicketComment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  ticketId!: string;

  @Column({ type: 'uuid' })
  authorId!: string;

  @Column({ type: 'varchar', length: 50 })
  authorType!: 'admin' | 'tenant_user' | 'system';

  @Column({ type: 'varchar', length: 200, nullable: true })
  authorName?: string;

  @Column({ type: 'text' })
  content!: string;

  @Column({ type: 'boolean', default: false })
  isInternal!: boolean;

  @Column({ type: 'jsonb', nullable: true })
  attachments?: TicketAttachment[];

  @Column({ type: 'boolean', default: false })
  emailSent!: boolean;

  @ManyToOne(() => SupportTicket, ticket => ticket.comments)
  @JoinColumn({ name: 'ticketId' })
  ticket!: SupportTicket;

  @CreateDateColumn()
  createdAt!: Date;
}

// ============================================================================
// Onboarding Progress Entity
// ============================================================================

@Entity('onboarding_progress')
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

  @Column({ type: 'timestamp', nullable: true })
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

  @Column({ type: 'timestamp', nullable: true })
  startedAt?: Date;

  @Column({ type: 'timestamp', nullable: true })
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

export interface TicketAttachment {
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  url: string;
  uploadedAt: string;
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

export interface SLAConfig {
  priority: TicketPriority;
  firstResponseMinutes: number;
  resolutionMinutes: number;
}

export interface TicketStats {
  total: number;
  open: number;
  inProgress: number;
  waitingCustomer: number;
  resolved: number;
  closed: number;
  avgFirstResponseMinutes: number;
  avgResolutionMinutes: number;
  slaBreachCount: number;
  avgSatisfactionRating: number;
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
