/**
 * Support domain types (Tickets, Messaging, Announcements, Onboarding)
 */

import type { AdminApiRouteResponse } from './generated/admin-route-contracts';

// ============================================================================
// Ticket Types
// ============================================================================

export type SupportTicket = AdminApiRouteResponse<'GET /support/tickets'>['items'][number];
export type TicketStatus = SupportTicket['status'];
export type TicketPriority = SupportTicket['priority'];
export type TicketCategory = SupportTicket['category'];

export interface TicketAttachmentInfo {
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  url: string;
  uploadedAt?: string;
}

export type TicketCommentAuthorType = 'admin' | 'tenant_user' | 'system';

export type TicketComment =
  AdminApiRouteResponse<'GET /support/tickets/by-id/:id/comments'>['items'][number];

export type TicketStats = AdminApiRouteResponse<'GET /support/tickets/stats'>;

// ============================================================================
// Messaging Types
// ============================================================================

export type MessageThread = AdminApiRouteResponse<'GET /support/messages/threads'>['items'][number];
export type SupportMessage =
  AdminApiRouteResponse<'GET /support/messages/threads/:threadId/messages'>[number];
export type SupportMessageAttachment = NonNullable<SupportMessage['attachments']>[number];
export type MessageSenderType = SupportMessage['senderType'];
export type MessageStatus = SupportMessage['status'];

// ============================================================================
// Announcement Types
// ============================================================================

export type Announcement = AdminApiRouteResponse<'GET /support/announcements'>['items'][number];
export type AnnouncementType = Announcement['type'];
export type AnnouncementStatus = Announcement['status'];
export type AnnouncementTarget = NonNullable<Announcement['targetCriteria']>;

// ============================================================================
// Onboarding Types
// ============================================================================

export type OnboardingStep = AdminApiRouteResponse<'GET /support/onboarding/steps'>[number];

export type TenantOnboarding = AdminApiRouteResponse<'GET /support/onboarding'>['items'][number];
