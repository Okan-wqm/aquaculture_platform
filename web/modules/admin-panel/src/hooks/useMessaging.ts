/**
 * Messaging Hooks
 *
 * React hooks for admin-to-tenant support messaging (threads & messages).
 * Communicates with auth-service via the Apollo Federation gateway using the
 * shared-ui graphqlClient and useGraphQL hooks.
 *
 * APA-213 (messaging slice): support messaging is consolidated onto the
 * auth.message_threads / auth.messages SSoT. These hooks replace the old
 * REST-based supportApi messaging functions; the admin-panel reads/writes
 * support threads exclusively through the auth-service GraphQL lane here.
 */

import { useGraphQLQuery, useGraphQLMutation } from '@aquaculture/shared-ui';

import {
  ADMIN_GET_THREADS,
  ADMIN_GET_THREAD_MESSAGES,
  ADMIN_GET_MESSAGING_STATS,
  ADMIN_CREATE_THREAD,
  ADMIN_SEND_MESSAGE,
  ADMIN_CLOSE_THREAD,
  ADMIN_REOPEN_THREAD,
  ADMIN_ARCHIVE_THREAD,
  ADMIN_SEND_BULK_MESSAGE,
} from '../graphql/messaging-operations';

// ============================================================================
// Enum unions — match the auth-service enum VALUES over the wire (lowercase).
// ============================================================================

export type ThreadStatus = 'open' | 'closed' | 'archived';
export type MessageSenderType = 'super_admin' | 'tenant_admin' | 'system';
export type MessageStatus = 'sent' | 'delivered' | 'read';

// ============================================================================
// GraphQL response types (the view types the messaging page renders).
// ============================================================================

/** Attachment as exposed by the auth SupportMessage / MessageAttachment. */
export interface SupportMessageAttachment {
  id: string;
  filename: string;
  url: string;
  size: number;
  mimeType: string;
}

/** ThreadListItem returned by the mySupportThreads query (list surface). */
export interface ThreadSummary {
  id: string;
  tenantId: string;
  tenantName: string;
  subject: string;
  lastMessage: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
  messageCount: number;
  status: ThreadStatus;
  createdAt: string;
  updatedAt: string;
}

/** Message item returned by the supportThreadMessages query. */
export interface MessageItem {
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

/** Messaging statistics from the supportMessagingStats query. */
export interface MessagingStats {
  totalThreads: number;
  activeThreads: number;
  closedThreads: number;
  totalMessages: number;
  unreadMessages: number;
  avgResponseTimeMinutes: number;
}

// ============================================================================
// Mutation input types (match the auth-service GraphQL input DTOs)
// ============================================================================

/** Input for creating a new support thread (SuperAdmin supplies tenantId). */
export interface CreateThreadInput {
  subject: string;
  initialMessage: string;
  tenantId?: string;
}

/** Input for sending a support message into an existing thread. */
export interface SupportSendMessageInput {
  threadId: string;
  content: string;
  isInternal: boolean;
}

/** Input for a bulk support message to every active tenant (SuperAdmin only). */
export interface BulkMessageInput {
  subject: string;
  content: string;
  sendEmailNotification: boolean;
}

// ============================================================================
// Query Hooks
// ============================================================================

/**
 * Fetch every support thread visible to the current user. For a SUPER_ADMIN
 * this is the platform-wide queue; status/unread/search filtering is applied
 * client-side by the consuming page.
 */
export function useAdminThreads(): {
  data: ThreadSummary[] | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
} {
  const result = useGraphQLQuery<{ mySupportThreads: ThreadSummary[] }>(
    'AdminThreads',
    ADMIN_GET_THREADS,
    { enabled: true },
  );

  return {
    data: result.data?.mySupportThreads ?? null,
    isLoading: result.isLoading,
    error: result.error ? result.error.message || 'Failed to load threads' : null,
    refetch: result.refetch,
  };
}

/**
 * Fetch messages for a specific thread (skips until a thread is selected).
 * The auth `supportThreadMessages` query marks the reader's incoming messages
 * as read server-side, so no separate mark-as-read call is needed.
 */
export function useAdminThreadMessages(threadId: string | null): {
  data: MessageItem[] | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
} {
  const result = useGraphQLQuery<
    { supportThreadMessages: MessageItem[] },
    { threadId: string }
  >('AdminThreadMessages', ADMIN_GET_THREAD_MESSAGES, {
    variables: { threadId: threadId ?? '' },
    enabled: !!threadId,
  });

  return {
    data: result.data?.supportThreadMessages ?? null,
    isLoading: result.isLoading,
    error: result.error ? result.error.message || 'Failed to load messages' : null,
    refetch: result.refetch,
  };
}

/**
 * Fetch messaging statistics.
 */
export function useMessagingStats(): {
  data: MessagingStats | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
} {
  const result = useGraphQLQuery<{ supportMessagingStats: MessagingStats }>(
    'AdminMessagingStats',
    ADMIN_GET_MESSAGING_STATS,
    { enabled: true },
  );

  return {
    data: result.data?.supportMessagingStats ?? null,
    isLoading: result.isLoading,
    error: result.error ? result.error.message || 'Failed to load stats' : null,
    refetch: result.refetch,
  };
}

// ============================================================================
// Mutation Hooks
// ============================================================================

/**
 * Create a new support thread.
 */
export function useCreateThread(): {
  mutate: (params: { input: CreateThreadInput }) => Promise<unknown>;
  isLoading: boolean;
  error: string | null;
} {
  const { mutate, isLoading, error } = useGraphQLMutation<
    { createSupportThread: { id: string } },
    { input: CreateThreadInput }
  >(ADMIN_CREATE_THREAD);

  return {
    mutate: (params: { input: CreateThreadInput }) => mutate(params),
    isLoading,
    error: error ? error.message || 'Failed to create thread' : null,
  };
}

/**
 * Send a message in an existing thread.
 */
export function useSendMessage(): {
  mutate: (params: { input: SupportSendMessageInput }) => Promise<unknown>;
  isLoading: boolean;
  error: string | null;
} {
  const { mutate, isLoading, error } = useGraphQLMutation<
    { sendSupportMessage: { id: string } },
    { input: SupportSendMessageInput }
  >(ADMIN_SEND_MESSAGE);

  return {
    mutate: (params: { input: SupportSendMessageInput }) => mutate(params),
    isLoading,
    error: error ? error.message || 'Failed to send message' : null,
  };
}

/**
 * Close a thread.
 */
export function useCloseThread(): {
  mutate: (params: { threadId: string }) => Promise<unknown>;
  isLoading: boolean;
  error: string | null;
} {
  const { mutate, isLoading, error } = useGraphQLMutation<
    { closeSupportThread: { id: string } },
    { threadId: string }
  >(ADMIN_CLOSE_THREAD);

  return {
    mutate: (params: { threadId: string }) => mutate(params),
    isLoading,
    error: error ? error.message || 'Failed to close thread' : null,
  };
}

/**
 * Reopen a closed thread.
 */
export function useReopenThread(): {
  mutate: (params: { threadId: string }) => Promise<unknown>;
  isLoading: boolean;
  error: string | null;
} {
  const { mutate, isLoading, error } = useGraphQLMutation<
    { reopenSupportThread: { id: string } },
    { threadId: string }
  >(ADMIN_REOPEN_THREAD);

  return {
    mutate: (params: { threadId: string }) => mutate(params),
    isLoading,
    error: error ? error.message || 'Failed to reopen thread' : null,
  };
}

/**
 * Archive a thread (SuperAdmin only).
 */
export function useArchiveThread(): {
  mutate: (params: { threadId: string }) => Promise<unknown>;
  isLoading: boolean;
  error: string | null;
} {
  const { mutate, isLoading, error } = useGraphQLMutation<
    { archiveSupportThread: { id: string } },
    { threadId: string }
  >(ADMIN_ARCHIVE_THREAD);

  return {
    mutate: (params: { threadId: string }) => mutate(params),
    isLoading,
    error: error ? error.message || 'Failed to archive thread' : null,
  };
}

/**
 * Open a support thread for every active tenant (SuperAdmin only).
 */
export function useSendBulkMessage(): {
  mutate: (params: { input: BulkMessageInput }) => Promise<unknown>;
  isLoading: boolean;
  error: string | null;
} {
  const { mutate, isLoading, error } = useGraphQLMutation<
    { sendBulkSupportMessage: { sent: number; failed: number } },
    { input: BulkMessageInput }
  >(ADMIN_SEND_BULK_MESSAGE);

  return {
    mutate: (params: { input: BulkMessageInput }) => mutate(params),
    isLoading,
    error: error ? error.message || 'Failed to send bulk message' : null,
  };
}
