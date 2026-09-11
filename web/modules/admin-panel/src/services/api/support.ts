/**
 * Support API (Tickets, Messaging, Announcements, Onboarding)
 */

import { apiFetch, buildQueryString } from '../http-client';
import type {
  PaginatedResult,
  PaginationParams,
  DateRangeParams,
  SupportTicket,
  TicketReply,
  TicketStats,
  TicketStatus,
  TicketPriority,
  TicketCategory,
  TicketComment,
  MessageThreadSummary,
  SupportThreadRecord,
  SupportMessage,
  Announcement,
  AnnouncementAcknowledgmentStatus,
  AnnouncementListQuery,
  AnnouncementStats,
  CreateAnnouncementInput,
  UpdateAnnouncementInput,
  OnboardingStep,
  TenantOnboarding,
} from '../types';

export const supportApi = {
  // Tickets
  getTickets: (params?: {
    status?: TicketStatus[];
    priority?: TicketPriority[];
    category?: TicketCategory[];
    tenantId?: string;
    assignedTo?: string;
    search?: string;
  } & PaginationParams & DateRangeParams, signal?: AbortSignal) =>
    apiFetch<PaginatedResult<SupportTicket>>(`/support/tickets?${buildQueryString(params || {})}`, {
      signal,
    }),
  getTicket: (id: string) => apiFetch<SupportTicket>(`/support/tickets/${id}`),
  getTicketReplies: (ticketId: string) => apiFetch<TicketReply[]>(`/support/tickets/${ticketId}/replies`),
  createTicket: (data: { subject: string; description: string; category: TicketCategory; priority: TicketPriority; tenantId: string }) =>
    apiFetch<SupportTicket>('/support/tickets', { method: 'POST', body: JSON.stringify(data) }),
  // Fix: backend uses PUT (not PATCH)
  updateTicket: (id: string, data: Partial<{ status: TicketStatus; priority: TicketPriority; assignedTo: string; tags: string[] }>) =>
    apiFetch<SupportTicket>(`/support/tickets/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  addReply: (ticketId: string, data: { content: string; isInternal?: boolean; createdBy: string }) =>
    apiFetch<TicketReply>(`/support/tickets/${ticketId}/replies`, { method: 'POST', body: JSON.stringify(data) }),
  assignTicket: (id: string, assignedTo: string, assignedToName: string) =>
    apiFetch<SupportTicket>(`/support/tickets/${id}/assign`, { method: 'POST', body: JSON.stringify({ assignedTo, assignedToName }) }),
  // Fix: backend uses POST /support/tickets/:id/status with { status: 'closed' } (no /close endpoint)
  closeTicket: (id: string, _resolution?: string) =>
    apiFetch<SupportTicket>(`/support/tickets/${id}/status`, { method: 'POST', body: JSON.stringify({ status: 'closed' }) }),
  getTicketStats: (signal?: AbortSignal) =>
    apiFetch<TicketStats>('/support/tickets/stats', { signal }),
  getTicketStatsByCategory: () =>
    apiFetch<Array<{ category: string; count: number; avgResolutionTime: number }>>('/support/tickets/stats/by-category'),
  getTicketStatsByPriority: () =>
    apiFetch<Array<{ priority: string; count: number; avgResolutionTime: number }>>('/support/tickets/stats/by-priority'),
  getUnassignedTickets: (params?: PaginationParams) =>
    apiFetch<PaginatedResult<SupportTicket>>(`/support/tickets/unassigned?${buildQueryString(params || {})}`),
  getSlaRiskTickets: () =>
    apiFetch<Array<{ id: string; subject: string; priority: string; hoursUntilBreach: number; tenantName: string }>>('/support/tickets/sla-risk'),
  submitSatisfaction: (ticketId: string, data: { rating: number; feedback?: string; submittedBy: string }) =>
    apiFetch<{ success: boolean }>(`/support/tickets/${ticketId}/satisfaction`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  getTicketTeam: (signal?: AbortSignal) =>
    apiFetch<Array<{ id: string; name: string; activeTickets: number }>>(
      '/support/tickets/team',
      { signal },
    ),
  /**
   * One page of a ticket's comments (ADMIN-CRITICAL-156).
   *
   * A PAGE, not an array: `TicketService.getComments` returns
   * `createStandardPaginatedResult`, so this arrives as the decoded envelope.
   * Declaring it an array is what made `TicketsPage` call `.map` on an object
   * and swallow the TypeError, rendering every thread empty.
   */
  getTicketComments: (ticketId: string, signal?: AbortSignal) =>
    apiFetch<PaginatedResult<TicketComment>>(`/support/tickets/${ticketId}/comments`, { signal }),
  addTicketComment: (ticketId: string, data: { content: string; isInternal?: boolean }) =>
    apiFetch<unknown>(`/support/tickets/${ticketId}/comments`, { method: 'POST', body: JSON.stringify(data) }),
  updateTicketStatus: (ticketId: string, status: string) =>
    apiFetch<unknown>(`/support/tickets/${ticketId}/status`, { method: 'POST', body: JSON.stringify({ status }) }),
  updateTicketPriority: (ticketId: string, priority: string) =>
    apiFetch<unknown>(`/support/tickets/${ticketId}/priority`, { method: 'POST', body: JSON.stringify({ priority }) }),

  // Messaging - Backend: /support/messages
  // The list returns MessagingService.getAllThreads's projection, not the
  // thread row and not the GraphQL shape (ADMIN-HIGH-110).
  getMessageThreads: (params?: { tenantId?: string; status?: string } & PaginationParams) =>
    apiFetch<PaginatedResult<MessageThreadSummary>>(
      `/support/messages/threads?${buildQueryString(params || {})}`,
    ),
  getThread: (threadId: string) =>
    apiFetch<SupportThreadRecord>(`/support/messages/threads/${threadId}`),
  getThreadMessages: (threadId: string) => apiFetch<SupportMessage[]>(`/support/messages/threads/${threadId}/messages`),
  createThread: (data: { tenantId: string; subject: string; content: string; senderName: string }) =>
    apiFetch<SupportThreadRecord>('/support/messages/threads', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  sendSupportMessage: (threadId: string, data: { content: string; senderName: string }) =>
    apiFetch<SupportMessage>(`/support/messages/threads/${threadId}/messages`, { method: 'POST', body: JSON.stringify(data) }),
  markAsRead: (threadId: string) =>
    apiFetch<void>(`/support/messages/threads/${threadId}/read`, { method: 'POST' }),
  archiveThread: (threadId: string) =>
    apiFetch<void>(`/support/messages/threads/${threadId}/archive`, { method: 'POST' }),
  closeThread: (threadId: string) =>
    apiFetch<void>(`/support/messages/threads/${threadId}/close`, { method: 'POST' }),
  reopenThread: (threadId: string) =>
    apiFetch<void>(`/support/messages/threads/${threadId}/reopen`, { method: 'POST' }),
  sendBulkMessage: (data: { subject: string; content: string; tenantIds?: string[]; sendEmail: boolean }) =>
    apiFetch<void>('/support/messages/bulk', { method: 'POST', body: JSON.stringify(data) }),
  getUnreadCount: () => apiFetch<{ unreadCount: number }>('/support/messages/unread-count'),
  getMessagingStats: () => apiFetch<Record<string, unknown>>('/support/messages/stats'),

  // Announcements
  //
  // The filter object is the ROUTE's own query type (ADMIN-HIGH-145). The
  // hand-written one declared `isPublished`, which this controller has never
  // accepted, and omitted `status`, the only filter the page sends — a
  // disagreement the server cannot report, because an unknown query key is
  // silently ignored.
  getAnnouncements: (params?: AnnouncementListQuery, signal?: AbortSignal) =>
    apiFetch<PaginatedResult<Announcement>>(
      `/support/announcements?${buildQueryString(params || {})}`,
      { signal },
    ),
  getAnnouncement: (id: string) => apiFetch<Announcement>(`/support/announcements/${id}`),
  createAnnouncement: (data: CreateAnnouncementInput) =>
    apiFetch<Announcement>('/support/announcements', { method: 'POST', body: JSON.stringify(data) }),
  updateAnnouncement: (id: string, data: UpdateAnnouncementInput) =>
    apiFetch<Announcement>(`/support/announcements/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  publishAnnouncement: (id: string) =>
    apiFetch<Announcement>(`/support/announcements/${id}/publish`, { method: 'POST' }),
  // Fix: H18 -- backend path uyumu (unpublish -> cancel)
  unpublishAnnouncement: (id: string) =>
    apiFetch<Announcement>(`/support/announcements/${id}/cancel`, { method: 'POST' }),
  deleteAnnouncement: (id: string) =>
    apiFetch<void>(`/support/announcements/${id}`, { method: 'DELETE' }),
  getAnnouncementStats: (signal?: AbortSignal) =>
    apiFetch<AnnouncementStats>('/support/announcements/stats', { signal }),
  getAnnouncementAcknowledgments: (id: string, signal?: AbortSignal) =>
    apiFetch<AnnouncementAcknowledgmentStatus>(
      `/support/announcements/${id}/acknowledgments`,
      { signal },
    ),

  // Onboarding - Backend: /support/onboarding
  getOnboardingSteps: (signal?: AbortSignal) =>
    apiFetch<OnboardingStep[]>('/support/onboarding/steps', { signal }),
  getTenantOnboardings: (params?: { status?: string } & PaginationParams, signal?: AbortSignal) =>
    apiFetch<PaginatedResult<TenantOnboarding>>(
      `/support/onboarding?${buildQueryString(params || {})}`,
      { signal },
    ),
  getTenantOnboarding: (tenantId: string) => apiFetch<TenantOnboarding>(`/support/onboarding/${tenantId}`),
  initializeOnboarding: (tenantId: string, tenantName: string) =>
    apiFetch<TenantOnboarding>('/support/onboarding/initialize', {
      method: 'POST',
      body: JSON.stringify({ tenantId, tenantName })
    }),
  completeOnboardingStep: (tenantId: string, stepId: string) =>
    apiFetch<TenantOnboarding>(`/support/onboarding/${tenantId}/step/${stepId}/complete`, { method: 'POST' }),
  skipOnboardingStep: (tenantId: string, stepId: string) =>
    apiFetch<TenantOnboarding>(`/support/onboarding/${tenantId}/step/${stepId}/skip`, { method: 'POST' }),
  skipOnboarding: (tenantId: string) =>
    apiFetch<TenantOnboarding>(`/support/onboarding/${tenantId}/skip`, { method: 'POST' }),
  assignOnboardingGuide: (tenantId: string, guideId: string, guideName: string) =>
    apiFetch<TenantOnboarding>(`/support/onboarding/${tenantId}/assign-guide`, {
      method: 'POST',
      body: JSON.stringify({ guideId, guideName })
    }),
  /**
   * The onboarding rollup, as the service actually returns it.
   *
   * This declared `stalled` — a field `getOnboardingStats` has never returned —
   * and omitted `total`, `skipped`, `avgCompletionPercent` and
   * `completionByStep`, which it does (ADMIN-HIGH-134). So the page's "Stalled"
   * card read `undefined` on every load and its zero-default rendered `0`
   * forever, while the page summed four fields to get a total the server was
   * already sending.
   */
  getOnboardingStats: (signal?: AbortSignal) =>
    apiFetch<{
      total: number;
      notStarted: number;
      inProgress: number;
      completed: number;
      skipped: number;
      avgCompletionPercent: number;
      avgCompletionDays: number;
      completionByStep: Record<string, number>;
    }>('/support/onboarding/stats', { signal }),
  getTenantsNeedingAttention: () => apiFetch<TenantOnboarding[]>('/support/onboarding/needs-attention'),
  getTrainingResources: (category?: string, signal?: AbortSignal) =>
    apiFetch<Array<{ id: string; title: string; type: string; category: string; url: string }>>(
      `/support/onboarding/resources/all${category ? `?category=${category}` : ''}`,
      { signal },
    ),
};
