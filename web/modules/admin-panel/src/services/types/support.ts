/**
 * Support domain types (Tickets, Messaging, Announcements, Onboarding)
 */

import type { ApiQuery, ApiSchema } from '../contract';

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
 * A ticket comment, as `GET /support/tickets/:id/comments` returns it
 * (ADMIN-MEDIUM-114, closed).
 *
 * This was hand-written, and the note here said why: `TicketController
 * .getComments` declared no return type, so the swagger plugin inferred the
 * ENTITY and the contract's `TicketComment` required a whole `SupportTicket`
 * inside every comment — a field `findAndCount` never loads. Aliasing to it
 * would have demanded data that does not arrive.
 *
 * The endpoint has a response DTO now (`TicketCommentPageDto`), so this is
 * derived. What the hand-written version got wrong while it stood: it declared
 * a FLAT ARRAY where the route returns a PAGE, so `(data || []).map(...)` ran
 * `.map` on an object and threw into a `console.error` — every ticket's
 * comment thread rendered empty, silently (ADMIN-CRITICAL-156).
 */
export type TicketComment = ApiSchema<'TicketCommentResponseDto'>;

/** One page of a ticket's comments. */
export type TicketCommentPage = ApiSchema<'TicketCommentPageDto'>;

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

/**
 * The ticket aggregate, from the contract (ADMIN-CRITICAL-156).
 *
 * The hand-written version declared TWENTY fields where the endpoint sends
 * ten: half were optional aliases the server has never sent
 * (`avgResponseTime`, `avgResolutionTime`, `satisfactionScore`, `byCategory`,
 * `byPriority` — the last two are separate endpoints), and the four real
 * averages were marked optional. That is where `TicketsPage`'s `a || b || 0`
 * chains and its `slaBreachCount ? … : 100` came from: the type said the truth
 * might be missing, so the page invented a value for when it was.
 *
 * The three averages are NULLABLE here because they are null on the wire when
 * there is nothing to average — no first response yet, nothing resolved,
 * nobody has rated. A page must render an em dash for those, not a zero.
 */
export type TicketStats = ApiSchema<'TicketStatsResponseDto'>;

// ============================================================================
// Messaging Types
// ============================================================================

export type ThreadStatus = 'open' | 'closed' | 'archived';

/**
 * One `admin.messages` row, as `/support/messages` returns it
 * (ADMIN-CRITICAL-157).
 *
 * SOURCED from the contract, because the hand-written copy disagreed with the
 * server on all three fields that decide what the operator sees, and the panel
 * only has one messaging page — so all three defects were live at once:
 *
 *  - `senderType` was `'super_admin' | 'tenant_admin' | 'system'`. That is the
 *    OTHER messaging stack's union (see {@link GraphQLSupportMessage});
 *    admin-api writes `'admin'`. `MessagingPage`'s `senderType ===
 *    'super_admin'` test was therefore false for every message ever written:
 *    the platform's own replies drew left-aligned in tenant styling, and the
 *    read receipt keyed on that same test never drew at all.
 *  - `status` omitted `'failed'`, so a message that failed to send drew as one
 *    that had been sent and not yet read.
 *  - the attachment fields were `filename` and `size`; the wire carries
 *    `fileName` and `fileSize`. Every attachment rendered as a nameless link
 *    reading "NaN MB".
 *
 * Two of these were unrepresentable defects, not typos — a union member the
 * server cannot send and a field name it does not use — which is exactly what
 * sourcing from the contract makes a compile error.
 */
export type SupportMessageAttachment = ApiSchema<'MessageAttachmentResponseDto'>;
export type SupportMessage = ApiSchema<'SupportMessageResponseDto'>;
export type MessageSenderType = SupportMessage['senderType'];
export type MessageStatus = SupportMessage['status'];

/** One page of a thread's messages, with the total the bare array never sent. */
export type SupportMessagePage = ApiSchema<'SupportMessagePageDto'>;

/** The messaging rollup. `avgResponseTimeMinutes` is null when nothing has been answered. */
export type MessagingStats = ApiSchema<'MessagingStatsResponseDto'>;

/** What a broadcast actually did — `failed > 0` is a partial send. */
export type BulkMessageResult = ApiSchema<'BulkMessageResultDto'>;

/**
 * Who a broadcast reaches. Required on the request, and `{}` is a MEANING —
 * every active tenant — not an omission (ADMIN-CRITICAL-157).
 */
export type BulkMessageAudience = ApiSchema<'BulkMessageAudienceDto'>;

/**
 * @deprecated Use {@link SupportMessageAttachment} instead.
 * Kept temporarily for backward compatibility with REST-based code.
 */
export type MessageAttachment = SupportMessageAttachment;

/**
 * @deprecated Use {@link SupportMessage} instead.
 * Kept temporarily for backward compatibility with REST-based code.
 */
export type Message = SupportMessage;

/**
 * A message from the OTHER support-messaging stack — auth-service's GraphQL
 * subgraph, which owns its own threads and messages and is reached through
 * `useMessaging` / `graphql/messaging-operations.ts`.
 *
 * NAMED for the subgraph it comes from, deliberately, for the same reason
 * {@link GraphQLSupportThread} is: one name over two unrelated shapes is how
 * the REST message shape came to be declared with the GraphQL stack's
 * `senderType` union (ADMIN-CRITICAL-157). auth-service really does write
 * `SenderType.SUPER_ADMIN`
 * (`apps/auth-service/src/modules/messaging/services/messaging.service.ts:216`);
 * admin-api really does write `'admin'`. Both are correct about their own
 * table, and neither is correct about the other's.
 */
export type GraphQLMessageSenderType = 'super_admin' | 'tenant_admin' | 'system';
export type GraphQLMessageStatus = 'sent' | 'delivered' | 'read';

export interface GraphQLMessageAttachment {
  id: string;
  filename: string;
  url: string;
  size: number;
  mimeType: string;
}

export interface GraphQLSupportMessage {
  id: string;
  threadId: string;
  senderId: string;
  senderType: GraphQLMessageSenderType;
  senderName: string;
  content: string;
  status: GraphQLMessageStatus;
  isInternal: boolean;
  attachments: GraphQLMessageAttachment[] | null;
  readAt: string | null;
  createdAt: string;
}

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

/**
 * The thread row `POST /support/messages/threads` replies with.
 *
 * Distinct from {@link SupportThreadRecord} by ONE field: `createThread` saves
 * the row and returns it, so the `messages` relation is not loaded, while
 * `GET /support/messages/threads/:id` does load it. Inferring both from the
 * entity made the create reply demand a `messages` array that never arrives
 * (ADMIN-CRITICAL-157).
 */
export type CreatedMessageThread = ApiSchema<'CreatedMessageThreadDto'>;

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

/**
 * What `POST /support/announcements` accepts (ADMIN-HIGH-145).
 *
 * This was previously derived by SUBTRACTION from the read shape —
 * `Omit<Announcement, 'id' | 'viewCount' | 'acknowledgedCount' | 'createdAt' |
 * 'updatedAt'>` — and `acknowledgedCount` is not one of its keys; the field is
 * `acknowledgmentCount`. So the subtraction removed nothing there, and the
 * create type went on requiring `status`, `acknowledgmentCount` and a full
 * `acknowledgments` roster, none of which `CreateAnnouncementDto` accepts. The
 * page compiled only by casting its form output, and the compiler could no
 * longer tell it which fields the endpoint actually wants.
 *
 * A create payload is its own contract, not a read shape minus guesses.
 */
export type CreateAnnouncementInput = ApiSchema<'CreateAnnouncementDto'>;

/**
 * What `PUT /support/announcements/:id` accepts. Every field optional, as the
 * DTO declares them — `Partial<Announcement>` would have offered `status`,
 * `viewCount` and `acknowledgmentCount`, which the endpoint ignores, so a
 * caller could believe it had reset a counter.
 */
export type UpdateAnnouncementInput = ApiSchema<'UpdateAnnouncementDto'>;

/**
 * The aggregate behind the header strip, as `GET /support/announcements/stats`
 * declares it. `byType` has the four keys the backend enum has — the previous
 * hand-written copy widened it to `Record<string, number>`.
 */
export type AnnouncementStats = ApiSchema<'AnnouncementStatsResponseDto'>;

/** One roster row: a view, and possibly an acknowledgment, by one user. */
export type AnnouncementAcknowledgment = ApiSchema<'AnnouncementAcknowledgment'>;

/** The roster of an announcement, with its two counters. */
export type AnnouncementAcknowledgmentStatus =
  ApiSchema<'AnnouncementAcknowledgmentStatusDto'>;

/**
 * The query string `GET /support/announcements` accepts, bound to the route.
 *
 * The hand-built version declared `isPublished` — a parameter this controller
 * has never had — and omitted `status`, the only filter the page actually
 * sends. A query key the server does not know is not an error; it is ignored
 * (the ADMIN-HIGH-123 class), so the two could never disagree loudly.
 */
export type AnnouncementListQuery = ApiQuery<'AnnouncementController_getAllAnnouncements'>;

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
