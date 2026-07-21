/**
 * Support API (Tickets, Messaging, Announcements, Onboarding)
 */

import { apiFetch, buildQueryString } from '../http-client';
import type {
  PaginatedResult,
  PaginationParams,
  OnboardingStep,
  TenantOnboarding,
} from '../types';

// APA-213 (tickets): the REST ticket functions (getTickets/getTicket/createTicket/
// updateTicket/assignTicket/getTicketStats/getTicketTeam/getTicketComments/
// addTicketComment/updateTicketStatus/updateTicketPriority/…) have been removed.
// Support tickets are owned by auth-service (auth.support_tickets /
// auth.ticket_comments) and served via GraphQL; the admin-panel now reads/writes
// tickets exclusively through the auth-service hooks in ../../hooks/useTickets.
// Any lingering supportApi ticket import is now a compile error by design.
//
// APA-213 (messaging): the REST messaging functions (getMessageThreads/getThread/
// getThreadMessages/createThread/sendSupportMessage/markAsRead/archiveThread/
// closeThread/reopenThread/sendBulkMessage/getUnreadCount/getMessagingStats) have
// likewise been removed. Support messaging is owned by auth-service
// (auth.message_threads / auth.messages) and served via GraphQL; the admin-panel
// now reads/writes support threads exclusively through the auth-service hooks in
// ../../hooks/useMessaging. Any lingering supportApi messaging import is now a
// compile error by design.

export const supportApi = {
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
