/**
 * Support domain types (Tickets, Messaging, Announcements, Onboarding)
 */

// GENERATED backend contracts — tools/codegen/admin-contracts/manifest.ts.
// Imported so shapes below can reference them; re-exported so import sites
// are unchanged.
import type {
  OnboardingStep,
} from './generated/admin-contracts';

export type {
  OnboardingStep,
};

// ============================================================================
// Ticket Types — REMOVED (APA-213)
// ============================================================================
//
// The REST ticket types (SupportTicket, TicketComment, TicketReply, TicketStats,
// TicketStatus/Priority/Category, TicketAttachmentInfo, TicketCommentAuthorType)
// have been removed. Support tickets are served by the auth-service GraphQL lane;
// the admin-panel view types live with the hooks (../../hooks/useTickets →
// GqlTicket / GqlTicketComment / TicketStats / TicketTeamMember). Any lingering
// REST ticket-type import is now a compile error by design.

// ============================================================================
// Messaging Types — REMOVED (APA-213 messaging slice)
// ============================================================================
//
// The REST messaging types (MessageThread, SupportMessage, Message,
// SupportMessageAttachment, MessageAttachment, MessageSenderType, MessageStatus,
// ThreadStatus) have been removed. Support messaging is served by the
// auth-service GraphQL lane; the admin-panel view types live with the hooks
// (../../hooks/useMessaging → ThreadSummary / MessageItem / MessagingStats /
// SupportMessageAttachment / ThreadStatus / MessageSenderType / MessageStatus).
// Any lingering REST messaging-type import is now a compile error by design.

// ============================================================================
// Announcement Types
// ============================================================================

export type AnnouncementType = 'info' | 'warning' | 'critical' | 'maintenance' | 'success';
export type AnnouncementStatus = 'draft' | 'scheduled' | 'published' | 'expired' | 'cancelled';

export interface AnnouncementTarget {
  tenantIds?: string[];
  excludeTenantIds?: string[];
  plans?: string[];
  modules?: string[];
  regions?: string[];
}

// APA-201: the REST `Announcement` interface has been removed. Announcements
// are served by the auth-service GraphQL lane; the admin-panel view types live
// with the hooks (../../hooks/useAnnouncements → GqlAnnouncementListItem /
// GqlAcknowledgment). AnnouncementType / AnnouncementStatus / AnnouncementTarget
// remain here because those hooks re-export them.

// ============================================================================
// Onboarding Types
// ============================================================================

export interface TenantOnboarding {
  tenantId: string;
  tenantName: string;
  status: 'not_started' | 'in_progress' | 'completed' | 'stalled';
  completedSteps: string[];
  currentStep?: string;
  progress: number;
  startedAt?: string;
  completedAt?: string;
  lastActivityAt?: string;
  assignedTo?: string;
  notes?: string;
}
