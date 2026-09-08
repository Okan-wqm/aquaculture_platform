/**
 * Support domain types (Tickets, Messaging, Announcements, Onboarding)
 */

import type { ApiSchema } from '../contract';

// ============================================================================
// Ticket Types
// ============================================================================

export type TicketStatus = 'open' | 'in_progress' | 'waiting_customer' | 'waiting_internal' | 'resolved' | 'closed';
export type TicketPriority = 'low' | 'medium' | 'high' | 'critical';
export type TicketCategory = 'technical' | 'billing' | 'feature_request' | 'bug_report' | 'bug' | 'general' | 'account';

export interface TicketAttachmentInfo {
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  url: string;
  uploadedAt?: string;
}

export interface SupportTicket {
  id: string;
  ticketNumber: string;
  tenantId: string;
  tenantName?: string;
  createdBy: string;
  createdByName?: string;
  createdByEmail?: string;
  subject: string;
  description: string;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  assignedTo?: string;
  assignedToName?: string;
  tags?: string[];
  firstResponseAt?: string;
  resolvedAt?: string;
  closedAt?: string;
  dueAt?: string;
  slaResponseMinutes?: number;
  slaResolutionMinutes?: number;
  slaBreached?: boolean;
  satisfactionRating?: number;
  satisfactionFeedback?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type TicketCommentAuthorType = 'admin' | 'tenant_user' | 'system';

export interface TicketComment {
  id: string;
  ticketId: string;
  authorId: string;
  authorType: TicketCommentAuthorType;
  authorName?: string;
  content: string;
  isInternal: boolean;
  attachments?: TicketAttachmentInfo[];
  emailSent?: boolean;
  createdAt: string;
}

export interface TicketReply {
  id: string;
  ticketId: string;
  content: string;
  isInternal: boolean;
  createdBy: string;
  createdByEmail: string;
  createdByRole: 'customer' | 'support' | 'admin';
  attachments: Array<{ id: string; filename: string; url: string }>;
  createdAt: string;
}

export interface TicketStats {
  total: number;
  open: number;
  inProgress: number;
  waitingCustomer?: number;
  resolved: number;
  closed?: number;
  avgFirstResponseMinutes?: number;
  avgResolutionMinutes?: number;
  avgResponseTime?: number;
  avgResolutionTime?: number;
  slaBreachCount?: number;
  avgSatisfactionRating?: number;
  satisfactionScore?: number;
  byCategory?: Array<{ category: string; count: number }>;
  byPriority?: Array<{ priority: string; count: number }>;
}

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

/**
 * The GraphQL support thread, as the messaging subgraph declares it.
 *
 * `status`, `unreadCountAdmin` and `unreadCountTenant` are GraphQL field names
 * (`SupportThreadStatus`, `AdminThreads`), consumed through `useMessaging`.
 * They are NOT what the admin-api REST endpoints return — see
 * {@link MessageThreadSummary}.
 */
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

/**
 * One row of `GET /support/messages/threads`, as admin-api builds it.
 *
 * This is a PROJECTION, not the `message_threads` row: `MessagingService.getAllThreads`
 * flattens `unreadAdminCount` to `unreadCount`, resolves `tenantName` out of the
 * thread's metadata, and fills `lastMessage` from a DISTINCT ON lookup of the
 * newest message. The entity's `unreadTenantCount`, `isArchived`, `metadata`,
 * `lastMessageId` and `messages` are not in the response at all.
 *
 * It was typed as {@link MessageThread} — the GraphQL shape — so the page read
 * `unreadCountAdmin` and `status`, which this endpoint never sends, and wrote
 * `undefined || 0` and `undefined === 'closed'` over the correct `unreadCount`
 * and `isClosed` that were already on the payload. Every thread showed zero
 * unread and none showed as closed (ADMIN-HIGH-110).
 */
export type MessageThreadSummary = ApiSchema<'ThreadSummaryDto'>;

/**
 * The `admin.message_threads` row, as `GET /support/messages/threads/:id` and
 * `POST /support/messages/threads` return it.
 *
 * A third shape, distinct from both {@link MessageThread} (GraphQL) and
 * {@link MessageThreadSummary} (the list projection): it carries
 * `unreadAdminCount` / `unreadTenantCount`, `isArchived` / `isClosed`,
 * `lastMessageId` and the `messages` relation. Both REST detail methods were
 * typed as the GraphQL thread, the same mistake that made the list read fields
 * the API never sends — it caused no live defect only because neither method's
 * result is consumed today (ADMIN-HIGH-110).
 */
export type SupportThreadRecord = ApiSchema<'MessageThread'>;

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

export interface Announcement {
  id: string;
  title: string;
  content: string;
  type: AnnouncementType;
  status: AnnouncementStatus;
  isGlobal: boolean;
  targetCriteria?: AnnouncementTarget;
  createdBy?: string;
  createdByName?: string;
  publishAt?: string;
  expiresAt?: string;
  requiresAcknowledgment: boolean;
  viewCount: number;
  acknowledgmentCount: number;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt?: string;
}

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
