/**
 * Messaging Hooks
 *
 * React hooks for messaging operations (threads & messages).
 * Communicates with auth-service via the Apollo Federation gateway
 * using the shared-ui graphqlClient and useGraphQL hooks.
 *
 * Replaces the old REST-based hooks that called supportApi.
 */

import { useCallback } from 'react';
import { useGraphQLQuery, useGraphQLMutation, graphqlClient } from '@aquaculture/shared-ui';
import {
  ADMIN_GET_THREADS,
  ADMIN_GET_THREAD,
  ADMIN_GET_THREAD_MESSAGES,
  ADMIN_GET_MESSAGING_STATS,
  ADMIN_CREATE_THREAD,
  ADMIN_SEND_MESSAGE,
  ADMIN_CLOSE_THREAD,
  ADMIN_REOPEN_THREAD,
  ADMIN_ARCHIVE_THREAD,
} from '../graphql/messaging-operations';
import type {
  MessageThread,
  SupportMessage,
  ThreadStatus,
  MessageSenderType,
  MessageStatus as MsgStatus,
  SupportMessageAttachment,
} from '../services/types/support';

// ============================================================================
// GraphQL response types
// ============================================================================

/** ThreadListItem returned by the mySupportThreads query */
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

/** Full thread returned by the thread query */
interface GqlMessageThread {
  id: string;
  tenantId: string;
  tenantName: string | null;
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

/** Message item returned by the supportThreadMessages query */
interface GqlMessageItem {
  id: string;
  threadId: string;
  senderId: string;
  senderType: MessageSenderType;
  senderName: string;
  content: string;
  status: MsgStatus;
  isInternal: boolean;
  attachments: SupportMessageAttachment[] | null;
  readAt: string | null;
  createdAt: string;
}

/** Messaging statistics */
export interface MessagingStats {
  totalThreads: number;
  activeThreads: number;
  closedThreads: number;
  totalMessages: number;
  unreadMessages: number;
  avgResponseTimeMinutes: number;
}

/** Input for creating a new thread */
interface CreateThreadInput {
  subject: string;
  initialMessage: string;
  tenantId?: string;
}

/** Input for sending an admin support message */
interface SupportSendMessageInput {
  threadId: string;
  content: string;
  isInternal?: boolean;
}

// ============================================================================
// Query Hooks
// ============================================================================

/**
 * Fetch messaging threads for the current user.
 * Supports optional status filter and search text.
 */
export function useAdminThreads(
  status?: ThreadStatus,
  search?: string,
) {
  const result = useGraphQLQuery<
    { mySupportThreads: ThreadSummary[] },
    { status?: ThreadStatus; search?: string }
  >('AdminThreads', ADMIN_GET_THREADS, {
    variables: {
      ...(status ? { status } : {}),
      ...(search ? { search } : {}),
    },
    enabled: true,
  });

  return {
    data: result.data?.mySupportThreads ?? null,
    isLoading: result.isLoading,
    error: result.error ? (result.error.message || 'Failed to load threads') : null,
    refetch: result.refetch,
  };
}

/**
 * Fetch messages for a specific thread.
 */
export function useAdminThreadMessages(threadId: string | null) {
  const result = useGraphQLQuery<
    { supportThreadMessages: GqlMessageItem[] },
    { threadId: string }
  >('AdminThreadMessages', ADMIN_GET_THREAD_MESSAGES, {
    variables: { threadId: threadId ?? '' },
    enabled: !!threadId,
  });

  return {
    data: result.data?.supportThreadMessages ?? null,
    isLoading: result.isLoading,
    error: result.error ? (result.error.message || 'Failed to load messages') : null,
    refetch: result.refetch,
  };
}

/**
 * Fetch a single thread by ID.
 */
export function useAdminThread(threadId: string | null) {
  const result = useGraphQLQuery<
    { supportThread: GqlMessageThread },
    { id: string }
  >('AdminThread', ADMIN_GET_THREAD, {
    variables: { id: threadId ?? '' },
    enabled: !!threadId,
  });

  return {
    data: result.data?.supportThread ?? null,
    isLoading: result.isLoading,
    error: result.error ? (result.error.message || 'Failed to load thread') : null,
    refetch: result.refetch,
  };
}

/**
 * Fetch messaging statistics.
 */
export function useMessagingStats() {
  const result = useGraphQLQuery<
    { supportMessagingStats: MessagingStats }
  >('AdminMessagingStats', ADMIN_GET_MESSAGING_STATS, {
    enabled: true,
  });

  return {
    data: result.data?.supportMessagingStats ?? null,
    isLoading: result.isLoading,
    error: result.error ? (result.error.message || 'Failed to load stats') : null,
    refetch: result.refetch,
  };
}

// ============================================================================
// Mutation Hooks
// ============================================================================

/**
 * Create a new messaging thread.
 */
export function useCreateThread() {
  const { mutate, isLoading, error, data } = useGraphQLMutation<
    { createSupportThread: MessageThread },
    { input: CreateThreadInput }
  >(ADMIN_CREATE_THREAD);

  return {
    mutate: (params: { input: CreateThreadInput }) => mutate(params),
    isLoading,
    error: error ? (error.message || 'Failed to create thread') : null,
    data: data?.createSupportThread ?? null,
  };
}

/**
 * Send a message in an existing thread.
 */
export function useSendMessage() {
  const { mutate, isLoading, error, data } = useGraphQLMutation<
    { sendSupportMessage: SupportMessage },
    { input: SupportSendMessageInput }
  >(ADMIN_SEND_MESSAGE);

  return {
    mutate: (params: { input: SupportSendMessageInput }) => mutate(params),
    isLoading,
    error: error ? (error.message || 'Failed to send message') : null,
    data: data?.sendSupportMessage ?? null,
  };
}

/**
 * Close a thread.
 */
export function useCloseThread() {
  const { mutate, isLoading, error } = useGraphQLMutation<
    { closeSupportThread: Pick<MessageThread, 'id' | 'status' | 'updatedAt'> },
    { threadId: string }
  >(ADMIN_CLOSE_THREAD);

  return {
    mutate: (params: { threadId: string }) => mutate(params),
    isLoading,
    error: error ? (error.message || 'Failed to close thread') : null,
  };
}

/**
 * Reopen a closed thread.
 */
export function useReopenThread() {
  const { mutate, isLoading, error } = useGraphQLMutation<
    { reopenSupportThread: Pick<MessageThread, 'id' | 'status' | 'updatedAt'> },
    { threadId: string }
  >(ADMIN_REOPEN_THREAD);

  return {
    mutate: (params: { threadId: string }) => mutate(params),
    isLoading,
    error: error ? (error.message || 'Failed to reopen thread') : null,
  };
}

/**
 * Archive a thread (SuperAdmin only).
 */
export function useArchiveThread() {
  const { mutate, isLoading, error } = useGraphQLMutation<
    { archiveSupportThread: Pick<MessageThread, 'id' | 'status' | 'updatedAt'> },
    { threadId: string }
  >(ADMIN_ARCHIVE_THREAD);

  return {
    mutate: (params: { threadId: string }) => mutate(params),
    isLoading,
    error: error ? (error.message || 'Failed to archive thread') : null,
  };
}

/**
 * Mark a thread as read.
 *
 * NOTE: The auth-service messaging resolver does not yet expose a dedicated
 * markAsRead mutation. This hook is kept as a placeholder that uses the
 * REST fallback. It will be migrated once the resolver adds the mutation.
 * Until then it performs a noop to maintain the export signature.
 */
export function useMarkAsRead() {
  const mutate = useCallback(
    async (_params: { threadId: string }) => {
      // TODO: Replace with GraphQL mutation when auth-service exposes markAsRead
      // Placeholder noop to preserve the exported API until the resolver exists
    },
    [],
  );

  return {
    mutate,
    isLoading: false,
    error: null,
  };
}

// ============================================================================
// Direct graphqlClient helpers (imperative, non-hook usage)
// ============================================================================

/**
 * Imperative helper for fetching thread messages outside React components.
 */
export async function fetchThreadMessages(threadId: string): Promise<GqlMessageItem[]> {
  const result = await graphqlClient.request<{ supportThreadMessages: GqlMessageItem[] }>(
    ADMIN_GET_THREAD_MESSAGES,
    { threadId },
  );
  return result?.supportThreadMessages ?? [];
}

/**
 * Imperative helper for fetching messaging stats.
 */
export async function fetchMessagingStats(): Promise<MessagingStats | null> {
  const result = await graphqlClient.request<{ supportMessagingStats: MessagingStats }>(
    ADMIN_GET_MESSAGING_STATS,
  );
  return result?.supportMessagingStats ?? null;
}
