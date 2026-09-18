/**
 * Support domain types (Tickets, Messaging, Announcements, Onboarding)
 */

import type { ApiSchema } from '../contract';

// ============================================================================
// Ticket Types
// ============================================================================

/**
 * The ticket unions, DERIVED from the contract rather than restated.
 *
 * Both hand-written copies carried a member the backend does not have, and
 * `TicketsPage`'s mappers are switches with no default, so each drifted in the
 * direction that renders nothing (ADMIN-MEDIUM-111):
 *
 *  - `TicketStatus` added `waiting_internal`. The status dropdown offered it,
 *    so an operator could POST a status `support.entity.ts` cannot store.
 *  - `TicketCategory` added `bug` alongside `bug_report`, and `getCategoryIcon`
 *    handles `bug` but NOT `bug_report` — exactly inverted. Every real
 *    bug-report ticket rendered with no icon while the member that can never
 *    arrive had one.
 */
export type TicketStatus = ApiSchema<'SupportTicket'>['status'];
export type TicketPriority = ApiSchema<'SupportTicket'>['priority'];
export type TicketCategory = ApiSchema<'SupportTicket'>['category'];

export interface TicketAttachmentInfo {
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  url: string;
  uploadedAt?: string;
}

export type SupportTicket = ApiSchema<'SupportTicket'>;

export type TicketCommentAuthorType = 'admin' | 'tenant_user' | 'system';

/**
 * A ticket comment, as `GET /support/tickets/:id/comments` returns it.
 *
 * DELIBERATELY NOT sourced from the contract, and the reason is a defect in the
 * OTHER direction from the rest of ADMIN-MEDIUM-111. `TicketController
 * .getComments` declares no return type, so the swagger plugin inferred the
 * ENTITY, and the contract's `TicketComment` therefore requires a `ticket`
 * property carrying a whole `SupportTicket`. The service's `findAndCount` loads
 * no relations, so that property is never in the response: the contract
 * OVERSTATES what the endpoint sends, and aliasing to it would demand a field
 * that does not arrive.
 *
 * Fixing it means giving the endpoint an explicit response DTO — a
 * response-shape change with its own review — tracked as ADMIN-MEDIUM-114.
 * Until then this stays hand-written, which is the honest state.
 */
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
 * NAMED for the subgraph it comes from, deliberately. It was called
 * `MessageThread`, which is also the name of a contract schema describing a
 * DIFFERENT thing — the admin-api `message_threads` row, aliased below as
 * {@link SupportThreadRecord}. Two unrelated shapes under one name in one
 * module is how a REST endpoint's response came to be typed as the GraphQL
 * thread (ADMIN-HIGH-110), and it is what
 * `tests/invariants/admin-panel-contract-shadowing.spec.ts` cannot tell apart
 * from a real shadow. The collision is removed rather than allowlisted.
 *
 * `status`, `unreadCountAdmin` and `unreadCountTenant` are GraphQL field names
 * (`SupportThreadStatus`, `AdminThreads`), consumed through `useMessaging`.
 * They are NOT what the admin-api REST endpoints return — see
 * {@link MessageThreadSummary}.
 */
export interface GraphQLSupportThread {
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
 * It was typed as {@link GraphQLSupportThread} — the GraphQL shape — so the page read
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
 * A third shape, distinct from both {@link GraphQLSupportThread} (GraphQL) and
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

/**
 * An announcement, as `GET /support/announcements` returns it.
 *
 * The type and status unions are DERIVED from it rather than restated. The
 * hand-written `AnnouncementType` carried a fifth member, `'success'`, that the
 * backend enum has never had — and `getTypeIcon` / `getTypeColor` in
 * `AnnouncementsPage` are four-case switches with no default, so a `success`
 * announcement would have rendered with no icon and `className={undefined}`.
 * The same silent shape as ADMIN-HIGH-110. Derived from the contract, a member
 * nothing sends cannot be written here at all.
 */
export type Announcement = ApiSchema<'Announcement'>;
export type AnnouncementType = Announcement['type'];
export type AnnouncementStatus = Announcement['status'];

export interface AnnouncementTarget {
  tenantIds?: string[];
  excludeTenantIds?: string[];
  plans?: string[];
  modules?: string[];
  regions?: string[];
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
  /**
   * The server's own union (`OnboardingStatus` in
   * `apps/admin-api-service/src/support/entities/support.entity.ts`).
   *
   * This said `stalled`, which the service never sets, and omitted `skipped`,
   * which `skipOnboarding` does set — so the status filter offered a value no
   * row can hold and every skipped tenant arrived as a status the type did not
   * admit (ADMIN-HIGH-134).
   */
  status: 'not_started' | 'in_progress' | 'completed' | 'skipped';
  completedSteps: string[];
  currentStep?: string;
  progress: number;
  startedAt?: string;
  completedAt?: string;
  lastActivityAt?: string;
  assignedTo?: string;
  notes?: string;
}
