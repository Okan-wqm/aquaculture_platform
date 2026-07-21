/**
 * Support domain types (Tickets, Messaging, Announcements, Onboarding)
 */

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
// Messaging Types
// ============================================================================

export type MessageSenderType = 'super_admin' | 'tenant_admin' | 'system';
export type MessageStatus = 'sent' | 'delivered' | 'read';
export type ThreadStatus = 'open' | 'closed' | 'archived';

export interface SupportMessageAttachment {
  id: string;
  filename: string;
  url: string;
  size: number;
  mimeType: string;
}

/**
 * @deprecated Use {@link SupportMessageAttachment} instead.
 * Kept temporarily for backward compatibility with REST-based code.
 */
export type MessageAttachment = SupportMessageAttachment;

export interface SupportMessage {
  id: string;
  threadId: string;
  senderId: string;
  senderType: MessageSenderType;
  senderName: string;
  content: string;
  status: MessageStatus;
  isInternal: boolean;
  attachments: SupportMessageAttachment[] | null;
  readAt: string | null;
  createdAt: string;
}

/**
 * @deprecated Use {@link SupportMessage} instead.
 * Kept temporarily for backward compatibility with REST-based code.
 */
export type Message = SupportMessage;

export interface MessageThread {
  id: string;
  tenantId: string;
  tenantName?: string;
  subject: string;
  lastMessage: string | null;
  lastMessageAt: string | null;
  lastMessageBy: string | null;
  status: ThreadStatus;
  messageCount: number;
  unreadCountAdmin: number;
  unreadCountTenant: number;
  createdBy: string;
  createdByAdmin: boolean;
  createdAt: string;
  updatedAt: string;
}

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

export interface OnboardingStep {
  id: string;
  code: string;
  name: string;
  description: string;
  order: number;
  isRequired: boolean;
  estimatedMinutes: number;
  helpUrl?: string;
  videoUrl?: string;
}

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
