/**
 * Support API (Tickets, Messaging, Announcements, Onboarding)
 */

import { apiFetch, buildQueryString } from '../http-client';
import type {
  PaginatedResult,
  PaginationParams,
  MessageThread,
  SupportMessage,
  OnboardingStep,
  TenantOnboarding,
} from '../types';

// APA-213: the REST ticket functions (getTickets/getTicket/createTicket/
// updateTicket/assignTicket/getTicketStats/getTicketTeam/getTicketComments/
// addTicketComment/updateTicketStatus/updateTicketPriority/…) have been removed.
// Support tickets are owned by auth-service (auth.support_tickets /
// auth.ticket_comments) and served via GraphQL; the admin-panel now reads/writes
// tickets exclusively through the auth-service hooks in ../../hooks/useTickets.
// Any lingering supportApi ticket import is now a compile error by design.

export const supportApi = {
  // Messaging - Backend: /support/messages
  getMessageThreads: (params?: { tenantId?: string; status?: string } & PaginationParams) =>
    apiFetch<PaginatedResult<MessageThread>>(`/support/messages/threads?${buildQueryString(params || {})}`),
  getThread: (threadId: string) => apiFetch<MessageThread>(`/support/messages/threads/${threadId}`),
  getThreadMessages: (threadId: string) => apiFetch<SupportMessage[]>(`/support/messages/threads/${threadId}/messages`),
  createThread: (data: { tenantId: string; subject: string; content: string; senderName: string }) =>
    apiFetch<MessageThread>('/support/messages/threads', { method: 'POST', body: JSON.stringify(data) }),
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

  // Announcements — APA-201: consolidated onto the auth.announcements SSoT.
  // The admin-panel now reads/writes announcements exclusively through the
  // auth-service GraphQL hooks in ../../hooks/useAnnouncements. The legacy REST
  // functions (getAnnouncements/createAnnouncement/publishAnnouncement/…) and
  // their admin-api vertical have been removed; any lingering supportApi
  // announcement import is now a compile error by design.

  // Onboarding - Backend: /support/onboarding
  getOnboardingSteps: () => apiFetch<OnboardingStep[]>('/support/onboarding/steps'),
  getTenantOnboardings: (params?: { status?: string } & PaginationParams) =>
    apiFetch<PaginatedResult<TenantOnboarding>>(`/support/onboarding?${buildQueryString(params || {})}`),
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
  getOnboardingStats: () =>
    apiFetch<{ notStarted: number; inProgress: number; completed: number; stalled: number; avgCompletionDays: number }>('/support/onboarding/stats'),
  getTenantsNeedingAttention: () => apiFetch<TenantOnboarding[]>('/support/onboarding/needs-attention'),
  getTrainingResources: (category?: string) =>
    apiFetch<Array<{ id: string; title: string; type: string; category: string; url: string }>>(`/support/onboarding/resources/all${category ? `?category=${category}` : ''}`),
};
