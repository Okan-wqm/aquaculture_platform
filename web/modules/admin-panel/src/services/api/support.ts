/**
 * Support API (Tickets, Messaging, Announcements, Onboarding)
 */

import { apiFetch } from '../http-client';
import type {
  StandardPaginatedResult,
  PaginationParams,
  DateRangeParams,
  SupportTicket,
  TicketStats,
  TicketStatus,
  TicketPriority,
  TicketCategory,
  Announcement,
  OnboardingStep,
  TenantOnboarding,
} from '../types';
import {
  ADMIN_API_ROUTES,
  type AdminApiRouteBody,
  type AdminApiRouteQuery,
} from '../types/generated/admin-route-contracts';

type TicketsQuery = AdminApiRouteQuery<'GET /support/tickets'>;
type CreateTicketInput = AdminApiRouteBody<'POST /support/tickets'>;
type ChangeTicketStatusInput = AdminApiRouteBody<'POST /support/tickets/:id/status'>;
type ChangeTicketPriorityInput = AdminApiRouteBody<'POST /support/tickets/:id/priority'>;
type MessageThreadsQuery = AdminApiRouteQuery<'GET /support/messages/threads'>;
type AnnouncementsQuery = AdminApiRouteQuery<'GET /support/announcements'>;
type OnboardingQuery = AdminApiRouteQuery<'GET /support/onboarding'>;

export const supportApi = {
  // Tickets
  getTickets: (params: TicketsQuery = {}) =>
    apiFetch(ADMIN_API_ROUTES['GET /support/tickets'], { query: params }),
  getTicket: (id: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /support/tickets/:id'], { path: { id: id } }),
  createTicket: (data: CreateTicketInput) =>
    apiFetch(ADMIN_API_ROUTES['POST /support/tickets'], { body: data }),
  // Fix: backend uses PUT (not PATCH)
  updateTicket: (
    id: string,
    data: Partial<{
      status: TicketStatus;
      priority: TicketPriority;
      assignedTo: string;
      tags: string[];
    }>,
  ) => apiFetch(ADMIN_API_ROUTES['PUT /support/tickets/:id'], { path: { id: id }, body: data }),
  assignTicket: (id: string, assignedTo: string, assignedToName: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /support/tickets/:id/assign'], {
      path: { id: id },
      body: { assignedTo, assignedToName },
    }),
  // Fix: backend uses POST /support/tickets/:id/status with { status: 'closed' } (no /close endpoint)
  closeTicket: (id: string, _resolution?: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /support/tickets/:id/status'], {
      path: { id: id },
      body: { status: 'closed' },
    }),
  getTicketStats: () => apiFetch(ADMIN_API_ROUTES['GET /support/tickets/stats']),
  getTicketStatsByCategory: () =>
    apiFetch(ADMIN_API_ROUTES['GET /support/tickets/stats/by-category']),
  getTicketStatsByPriority: () =>
    apiFetch(ADMIN_API_ROUTES['GET /support/tickets/stats/by-priority']),
  getUnassignedTickets: (params?: PaginationParams) =>
    apiFetch(ADMIN_API_ROUTES['GET /support/tickets/unassigned'], { query: params || {} }),
  getSlaRiskTickets: () => apiFetch(ADMIN_API_ROUTES['GET /support/tickets/sla-risk']),
  submitSatisfaction: (
    ticketId: string,
    data: { rating: number; feedback?: string; submittedBy: string },
  ) =>
    apiFetch(ADMIN_API_ROUTES['POST /support/tickets/:id/satisfaction'], {
      path: { id: ticketId },
      body: data,
    }),
  getTicketTeam: () => apiFetch(ADMIN_API_ROUTES['GET /support/tickets/team']),
  getTicketComments: (ticketId: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /support/tickets/by-id/:id/comments'], {
      path: { id: ticketId },
      query: {  },
    }),
  addTicketComment: (ticketId: string, data: { content: string; isInternal?: boolean }) =>
    apiFetch(ADMIN_API_ROUTES['POST /support/tickets/by-id/:id/comments'], {
      path: { id: ticketId },
      body: data,
    }),
  updateTicketStatus: (
    ticketId: string,
    status: ChangeTicketStatusInput['status'],
    changedByName?: string,
  ) =>
    apiFetch(ADMIN_API_ROUTES['POST /support/tickets/:id/status'], {
      path: { id: ticketId },
      body: { status, changedByName },
    }),
  updateTicketPriority: (
    ticketId: string,
    priority: ChangeTicketPriorityInput['priority'],
    changedByName?: string,
  ) =>
    apiFetch(ADMIN_API_ROUTES['POST /support/tickets/:id/priority'], {
      path: { id: ticketId },
      body: { priority, changedByName },
    }),

  // Messaging - Backend: /support/messages
  getMessageThreads: (params: MessageThreadsQuery = {}) =>
    apiFetch(ADMIN_API_ROUTES['GET /support/messages/threads'], { query: params }),
  getThread: (threadId: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /support/messages/threads/:threadId'], {
      path: { threadId: threadId },
    }),
  getThreadMessages: (threadId: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /support/messages/threads/:threadId/messages'], {
      path: { threadId: threadId },
      query: {  },
    }),
  createThread: (data: {
    tenantId: string;
    subject: string;
    content: string;
    senderName: string;
  }) => apiFetch(ADMIN_API_ROUTES['POST /support/messages/threads'], { body: data }),
  sendSupportMessage: (threadId: string, data: { content: string; senderName: string }) =>
    apiFetch(ADMIN_API_ROUTES['POST /support/messages/threads/:threadId/messages'], {
      path: { threadId: threadId },
      body: data,
    }),
  markAsRead: (threadId: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /support/messages/threads/:threadId/read'], {
      path: { threadId: threadId },
    }),
  archiveThread: (threadId: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /support/messages/threads/:threadId/archive'], {
      path: { threadId: threadId },
    }),
  closeThread: (threadId: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /support/messages/threads/:threadId/close'], {
      path: { threadId: threadId },
    }),
  reopenThread: (threadId: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /support/messages/threads/:threadId/reopen'], {
      path: { threadId: threadId },
    }),
  sendBulkMessage: (data: {
    subject: string;
    content: string;
    tenantIds?: string[];
    sendEmail: boolean;
  }) => apiFetch(ADMIN_API_ROUTES['POST /support/messages/bulk'], { body: data }),
  getUnreadCount: () => apiFetch(ADMIN_API_ROUTES['GET /support/messages/unread-count']),
  getMessagingStats: () => apiFetch(ADMIN_API_ROUTES['GET /support/messages/stats']),

  // Announcements
  getAnnouncements: (params: AnnouncementsQuery = {}) =>
    apiFetch(ADMIN_API_ROUTES['GET /support/announcements'], { query: params }),
  getAnnouncement: (id: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /support/announcements/:id'], { path: { id: id } }),
  createAnnouncement: (
    data: Omit<Announcement, 'id' | 'viewCount' | 'acknowledgedCount' | 'createdAt' | 'updatedAt'>,
  ) => apiFetch(ADMIN_API_ROUTES['POST /support/announcements'], { body: data }),
  updateAnnouncement: (id: string, data: Partial<Announcement>) =>
    apiFetch(ADMIN_API_ROUTES['PUT /support/announcements/:id'], { path: { id: id }, body: data }),
  publishAnnouncement: (id: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /support/announcements/:id/publish'], { path: { id: id } }),
  // Fix: H18 -- backend path uyumu (unpublish -> cancel)
  unpublishAnnouncement: (id: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /support/announcements/:id/cancel'], { path: { id: id } }),
  deleteAnnouncement: (id: string) =>
    apiFetch(ADMIN_API_ROUTES['DELETE /support/announcements/:id'], { path: { id: id } }),
  getAnnouncementStats: () => apiFetch(ADMIN_API_ROUTES['GET /support/announcements/stats']),
  getAnnouncementAcknowledgments: (id: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /support/announcements/:id/acknowledgments'], {
      path: { id: id },
    }),

  // Onboarding - Backend: /support/onboarding
  getOnboardingSteps: () => apiFetch(ADMIN_API_ROUTES['GET /support/onboarding/steps']),
  getTenantOnboardings: (params: OnboardingQuery = {}) =>
    apiFetch(ADMIN_API_ROUTES['GET /support/onboarding'], { query: params }),
  getTenantOnboarding: (tenantId: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /support/onboarding/:tenantId'], {
      path: { tenantId: tenantId },
    }),
  initializeOnboarding: (tenantId: string, tenantName: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /support/onboarding/initialize'], {
      body: { tenantId, tenantName },
    }),
  completeOnboardingStep: (tenantId: string, stepId: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /support/onboarding/:tenantId/step/:stepId/complete'], {
      path: { tenantId: tenantId, stepId: stepId },
    }),
  skipOnboardingStep: (tenantId: string, stepId: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /support/onboarding/:tenantId/step/:stepId/skip'], {
      path: { tenantId: tenantId, stepId: stepId },
    }),
  skipOnboarding: (tenantId: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /support/onboarding/:tenantId/skip'], {
      path: { tenantId: tenantId },
    }),
  assignOnboardingGuide: (tenantId: string, guideId: string, guideName: string) =>
    apiFetch(ADMIN_API_ROUTES['POST /support/onboarding/:tenantId/assign-guide'], {
      path: { tenantId: tenantId },
      body: { guideId, guideName },
    }),
  getOnboardingStats: () => apiFetch(ADMIN_API_ROUTES['GET /support/onboarding/stats']),
  getTenantsNeedingAttention: () =>
    apiFetch(ADMIN_API_ROUTES['GET /support/onboarding/needs-attention']),
  getTrainingResources: (category?: string) =>
    apiFetch(ADMIN_API_ROUTES['GET /support/onboarding/resources/all'], {
      query: { category: category },
    }),
};
