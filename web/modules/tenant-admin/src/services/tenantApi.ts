/**
 * Tenant Admin API Service
 * Backend API integration for tenant-specific features
 */

import { getTenantId, getAccessToken } from '@aquaculture/shared-ui';

// API URL - Shell nginx routes /api to admin-api-service
const API_URL = import.meta.env.VITE_API_URL || '/api';

// ============================================================================
// Types
// ============================================================================

export interface MessageThread {
  id: string;
  tenantId: string;
  tenantName: string;
  subject: string;
  lastMessage: string;
  lastMessageAt: string;
  unreadCount: number;
  messageCount: number;
  isClosed: boolean;
}

export interface Message {
  id: string;
  threadId: string;
  senderId: string;
  senderType: 'admin' | 'tenant_admin' | 'system';
  senderName: string;
  content: string;
  status: 'sent' | 'delivered' | 'read';
  isInternal: boolean;
  attachments: MessageAttachment[];
  readAt?: string;
  createdAt: string;
}

export interface MessageAttachment {
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  url: string;
}

export interface Announcement {
  id: string;
  title: string;
  content: string;
  type: 'info' | 'warning' | 'success' | 'error' | 'maintenance';
  priority: 'low' | 'normal' | 'high';
  isPublished: boolean;
  publishedAt?: string;
  expiresAt?: string;
  viewCount: number;
  acknowledgedCount: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface MessagingStats {
  totalThreads: number;
  activeThreads: number;
  closedThreads: number;
  totalMessages: number;
  unreadMessages: number;
  avgResponseTimeMinutes: number;
}

// ============================================================================
// Helper Functions
// ============================================================================

async function apiFetch<T>(
  endpoint: string,
  options?: RequestInit
): Promise<T> {
  const token = getAccessToken();
  const tenantId = getTenantId();

  const response = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(tenantId ? { 'X-Tenant-Id': tenantId } : {}),
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({ message: 'API Error' }));
    throw new Error(errorBody.message || `HTTP ${response.status}`);
  }

  // Handle empty responses
  const text = await response.text();
  if (!text) {
    return {} as T;
  }

  return JSON.parse(text);
}

// ============================================================================
// Messaging API
// ============================================================================

export const messagingApi = {
  /**
   * Get message threads for current tenant
   */
  getThreads: async (): Promise<{ data: MessageThread[] }> => {
    const tenantId = getTenantId();
    if (!tenantId) {
      throw new Error('Tenant ID not found');
    }
    
    return apiFetch<{ data: MessageThread[] }>(
      `/support/messages/threads/tenant/${tenantId}`
    );
  },

  /**
   * Get messages for a specific thread
   */
  getThreadMessages: async (threadId: string): Promise<Message[]> => {
    return apiFetch<Message[]>(
      `/support/messages/threads/${threadId}/messages?includeInternal=false`
    );
  },

  /**
   * Send a message to a thread
   */
  sendMessage: async (
    threadId: string,
    content: string,
    senderName: string
  ): Promise<Message> => {
    return apiFetch<Message>(
      `/support/messages/threads/${threadId}/messages`,
      {
        method: 'POST',
        body: JSON.stringify({ content, senderName }),
      }
    );
  },

  /**
   * Mark thread messages as read
   */
  markAsRead: async (threadId: string): Promise<void> => {
    return apiFetch<void>(
      `/support/messages/threads/${threadId}/read`,
      {
        method: 'POST',
      }
    );
  },

  /**
   * Create a new thread (tenant initiating conversation with admin)
   */
  createThread: async (
    subject: string,
    content: string,
    senderName: string
  ): Promise<MessageThread> => {
    const tenantId = getTenantId();
    if (!tenantId) {
      throw new Error('Tenant ID not found');
    }

    return apiFetch<MessageThread>(
      '/support/messages/threads',
      {
        method: 'POST',
        body: JSON.stringify({ tenantId, subject, content, senderName }),
      }
    );
  },

  /**
   * Get messaging statistics
   */
  getStats: async (): Promise<MessagingStats> => {
    return apiFetch<MessagingStats>('/support/messages/stats');
  },
};

// ============================================================================
// Announcements API
// ============================================================================

export const announcementsApi = {
  /**
   * Get published announcements for tenant
   */
  getAnnouncements: async (): Promise<Announcement[]> => {
    const result = await apiFetch<{ data: Announcement[] }>(
      '/support/announcements?isPublished=true&limit=100'
    );
    return result.data || [];
  },

  /**
   * Acknowledge an announcement
   */
  acknowledgeAnnouncement: async (announcementId: string): Promise<void> => {
    // Note: This endpoint might need to be created on the backend
    // For now, we'll use a POST request
    return apiFetch<void>(
      `/support/announcements/${announcementId}/acknowledge`,
      {
        method: 'POST',
      }
    );
  },

  /**
   * Mark announcement as viewed
   */
  markAsViewed: async (announcementId: string): Promise<void> => {
    return apiFetch<void>(
      `/support/announcements/${announcementId}/view`,
      {
        method: 'POST',
      }
    );
  },
};

// ============================================================================
// Tickets API
// ============================================================================

export type TicketCategory = 'technical' | 'billing' | 'feature_request' | 'general' | 'account' | 'security';
export type TicketPriority = 'low' | 'medium' | 'high' | 'critical';
export type TicketStatus = 'open' | 'in_progress' | 'pending_customer' | 'resolved' | 'closed';

export interface SupportTicket {
  id: string;
  ticketNumber: string;
  tenantId: string;
  tenantName?: string;
  subject: string;
  description: string;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  assignedTo?: string;
  assignedToName?: string;
  createdBy: string;
  createdByName: string;
  createdByEmail?: string;
  tags?: string[];
  dueAt?: string;
  resolvedAt?: string;
  closedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TicketComment {
  id: string;
  ticketId: string;
  content: string;
  authorId: string;
  authorName: string;
  authorType: 'admin' | 'tenant_admin' | 'system';
  isInternal: boolean;
  attachments?: Array<{
    id: string;
    fileName: string;
    fileSize: number;
    mimeType: string;
    url: string;
  }>;
  createdAt: string;
}

export interface TicketStats {
  total: number;
  open: number;
  inProgress: number;
  resolved: number;
  closed: number;
  avgResolutionTimeHours: number;
}

export const ticketsApi = {
  /**
   * Get tickets for current tenant
   */
  getTickets: async (status?: TicketStatus): Promise<{ data: SupportTicket[] }> => {
    const tenantId = getTenantId();
    if (!tenantId) {
      throw new Error('Tenant ID not found');
    }
    const params = status ? `?status=${status}` : '';
    return apiFetch<{ data: SupportTicket[] }>(
      `/support/tickets/tenant/${tenantId}${params}`
    );
  },

  /**
   * Get a single ticket by ID
   */
  getTicket: async (ticketId: string): Promise<SupportTicket> => {
    return apiFetch<SupportTicket>(`/support/tickets/${ticketId}`);
  },

  /**
   * Create a new support ticket
   */
  createTicket: async (data: {
    subject: string;
    description: string;
    category?: TicketCategory;
    priority?: TicketPriority;
    createdByName: string;
    createdByEmail?: string;
  }): Promise<SupportTicket> => {
    const tenantId = getTenantId();
    if (!tenantId) {
      throw new Error('Tenant ID not found');
    }
    return apiFetch<SupportTicket>('/support/tickets', {
      method: 'POST',
      body: JSON.stringify({
        ...data,
        tenantId,
        category: data.category || 'general',
        priority: data.priority || 'medium',
      }),
    });
  },

  /**
   * Get comments for a ticket
   */
  getComments: async (ticketId: string): Promise<TicketComment[]> => {
    const result = await apiFetch<{ data: TicketComment[] }>(
      `/support/tickets/${ticketId}/comments?includeInternal=false`
    );
    return result.data || [];
  },

  /**
   * Add a comment to a ticket
   */
  addComment: async (
    ticketId: string,
    content: string,
    authorName: string
  ): Promise<TicketComment> => {
    return apiFetch<TicketComment>(
      `/support/tickets/${ticketId}/comments`,
      {
        method: 'POST',
        body: JSON.stringify({ content, authorName, isInternal: false }),
      }
    );
  },

  /**
   * Submit satisfaction rating for a resolved ticket
   */
  submitRating: async (
    ticketId: string,
    rating: number,
    feedback?: string
  ): Promise<void> => {
    return apiFetch<void>(
      `/support/tickets/${ticketId}/satisfaction`,
      {
        method: 'POST',
        body: JSON.stringify({ rating, feedback }),
      }
    );
  },
};
