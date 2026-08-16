/**
 * Support API (Tickets, Messaging, Announcements, Onboarding)
 */

import { apiFetch, buildQueryString } from '../http-client';
import type {
  PaginatedResult,
  PaginationParams,
  DateRangeParams,
  SupportTicket,
  TicketComment,
  TicketStats,
  TicketStatus,
  TicketPriority,
  TicketCategory,
  MessageThread,
  SupportMessage,
  Announcement,
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
  } & PaginationParams & DateRangeParams) =>
    apiFetch<PaginatedResult<SupportTicket>>(`/support/tickets?${buildQueryString(params || {})}`),
  getTicket: (id: string) => apiFetch<SupportTicket>(`/support/tickets/${id}`),
  getTicketReplies: (ticketId: string) =>
    apiFetch<PaginatedResult<TicketComment>>(`/support/tickets/${ticketId}/replies`),
  createTicket: (data: { subject: string; description: string; category: TicketCategory; priority: TicketPriority; tenantId: string; createdBy: string }) =>
    apiFetch<SupportTicket>('/support/tickets', { method: 'POST', body: JSON.stringify(data) }),
  // Fix: backend uses PUT (not PATCH)
  updateTicket: (id: string, data: Partial<{ status: TicketStatus; priority: TicketPriority; assignedTo: string; tags: string[] }>) =>
    apiFetch<SupportTicket>(`/support/tickets/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  addReply: (ticketId: string, data: { content: string; isInternal?: boolean; createdBy: string }) =>
    apiFetch<TicketComment>(`/support/tickets/${ticketId}/replies`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  assignTicket: (id: string, assignedTo: string, assignedToName: string) =>
    apiFetch<SupportTicket>(`/support/tickets/${id}/assign`, { method: 'POST', body: JSON.stringify({ assignedTo, assignedToName }) }),
  // Fix: backend uses POST /support/tickets/:id/status with { status: 'closed' } (no /close endpoint)
  closeTicket: (id: string, _resolution?: string) =>
    apiFetch<SupportTicket>(`/support/tickets/${id}/status`, { method: 'POST', body: JSON.stringify({ status: 'closed' }) }),
  getTicketStats: () => apiFetch<TicketStats>('/support/tickets/stats'),
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
  getTicketTeam: () => apiFetch<Array<{ id: string; name: string; activeTickets: number }>>('/support/tickets/team'),
  getTicketComments: (ticketId: string) =>
    apiFetch<PaginatedResult<TicketComment>>(`/support/tickets/${ticketId}/comments`),
  addTicketComment: (ticketId: string, data: { content: string; isInternal?: boolean }) =>
    apiFetch<unknown>(`/support/tickets/${ticketId}/comments`, { method: 'POST', body: JSON.stringify(data) }),
  updateTicketStatus: (ticketId: string, status: string, changedByName?: string) =>
    apiFetch<unknown>(`/support/tickets/${ticketId}/status`, { method: 'POST', body: JSON.stringify({ status, changedByName }) }),
  updateTicketPriority: (ticketId: string, priority: string, changedByName?: string) =>
    apiFetch<unknown>(`/support/tickets/${ticketId}/priority`, { method: 'POST', body: JSON.stringify({ priority, changedByName }) }),

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

  // Announcements
  getAnnouncements: (params?: { type?: string; isPublished?: boolean } & PaginationParams) =>
    apiFetch<PaginatedResult<Announcement>>(`/support/announcements?${buildQueryString(params || {})}`),
  getAnnouncement: (id: string) => apiFetch<Announcement>(`/support/announcements/${id}`),
  createAnnouncement: (data: Omit<Announcement, 'id' | 'viewCount' | 'acknowledgedCount' | 'createdAt' | 'updatedAt'>) =>
    apiFetch<Announcement>('/support/announcements', { method: 'POST', body: JSON.stringify(data) }),
  updateAnnouncement: (id: string, data: Partial<Announcement>) =>
    apiFetch<Announcement>(`/support/announcements/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  publishAnnouncement: (id: string) =>
    apiFetch<Announcement>(`/support/announcements/${id}/publish`, { method: 'POST' }),
  // Fix: H18 -- backend path uyumu (unpublish -> cancel)
  unpublishAnnouncement: (id: string) =>
    apiFetch<Announcement>(`/support/announcements/${id}/cancel`, { method: 'POST' }),
  deleteAnnouncement: (id: string) =>
    apiFetch<void>(`/support/announcements/${id}`, { method: 'DELETE' }),
  getAnnouncementStats: () =>
    apiFetch<{ total: number; published: number; scheduled: number; draft: number; expired: number; totalViews: number; totalAcknowledgments: number; byType: Record<string, number> }>('/support/announcements/stats'),
  getAnnouncementAcknowledgments: (id: string) =>
    apiFetch<{ acknowledgments: Array<{ userId: string; userName: string; tenantId: string; viewedAt: string; acknowledgedAt: string | null }> }>(`/support/announcements/${id}/acknowledgments`),

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
