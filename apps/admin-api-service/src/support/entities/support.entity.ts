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
} from 'typeorm';

// ============================================================================
// Enums
// ============================================================================

export type OnboardingStatus = 'not_started' | 'in_progress' | 'completed' | 'skipped';

// APA-213: TicketPriority / TicketStatus / TicketCategory (and the SupportTicket
// + TicketComment entities, the TicketAttachment / SLAConfig / TicketStats types,
// and the ticket controller/service) were REMOVED. Support tickets are owned by
// auth-service (auth.support_tickets / auth.ticket_comments) and served via
// GraphQL; the admin.support_tickets / admin.ticket_comments duplicate store is
// dropped by 1801800000000-MigrateSupportTicketsToAuth (rows copied into auth
// first). Onboarding remains admin-owned.

// ============================================================================
// Announcement entities (REMOVED — APA-201)
// ============================================================================
//
// The admin.announcements / admin.announcement_acknowledgments tables were a
// write-only duplicate of the auth.announcements SSoT tenants actually read.
// The Announcement + AnnouncementAcknowledgment entities, their controller and
// service, are deleted; the tables are dropped by
// 1801700000000-MigrateAnnouncementsToAuth (rows copied into auth first).

// ============================================================================
// Support Ticket + Ticket Comment Entities (REMOVED — APA-213 tickets slice)
// ============================================================================
//
// The admin.support_tickets / admin.ticket_comments tables were a write-only
// duplicate of the auth.support_tickets / auth.ticket_comments SSoT tenants
// actually read. The SupportTicket + TicketComment entities, their controller
// and service, are deleted; the tables are dropped by
// 1801800000000-MigrateSupportTicketsToAuth (rows copied into auth first).

// ============================================================================
// Message Thread + Message Entities (REMOVED — APA-213 messaging slice)
// ============================================================================
//
// The admin.message_threads / admin.messages tables were a write-only duplicate
// of the auth.message_threads / auth.messages SSoT tenants actually read/write
// via the auth-service support-messaging GraphQL lane. The MessageThread +
// Message entities, their controller and service, and the now-orphaned
// MessageStatus / MessageAttachment / ThreadSummary / BulkMessageRequest /
// AnnouncementTarget helper types are deleted; the tables are dropped by
// 1801900000000-MigrateSupportMessagingToAuth (rows copied into auth first).
// Onboarding remains admin-owned.

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
