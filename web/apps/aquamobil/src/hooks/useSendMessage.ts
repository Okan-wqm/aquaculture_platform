// ============================================================================
// useSendMessage — Send message mutation with optimistic updates and offline queue
// ============================================================================

/**
 * WHY: Provides a mutation hook for sending messages to a channel. Generates a
 * client-side idempotencyKey (UUID) to prevent duplicate sends on retry.
 * Implements optimistic updates: the message appears in the chat immediately
 * with a 'pending' status, is replaced with the server response on success,
 * and marked as 'failed' with retry capability on error. Falls back to
 * IndexedDB offline queue if the network is unavailable.
 *
 * @param channelId - The channel to send messages to
 * @returns sendMessage — function to send a new message
 * @returns isSending — true while the mutation is in flight
 * @returns error — mutation error, if any
 */

import { useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from './useAuth';
import { useNetworkStatus } from './useNetworkStatus';
import { graphqlRequest } from '@/services/authenticated-fetch';
import { cacheData, getCachedData } from '@/pwa/offline-queue';
import { SEND_MESSAGE } from '@/graphql/messaging-operations';
import type { Message, MessagePage, MessageContentType } from '@/types/messaging';

/** IndexedDB key for the offline send queue. */
const OFFLINE_QUEUE_KEY = 'messaging_offline_sends';

/** Maximum pending offline messages. */
const MAX_OFFLINE_QUEUE = 50;

interface SendMessageParams {
  content: string | null;
  contentType?: MessageContentType;
  parentId?: string;
  attachmentKeys?: string[];
  metadata?: Record<string, unknown>;
}

interface OfflineQueuedMessage {
  idempotencyKey: string;
  channelId: string;
  params: SendMessageParams;
  createdAt: string;
}

/**
 * Generate a UUID v4 using the Web Crypto API.
 */
function generateIdempotencyKey(): string {
  return crypto.randomUUID();
}

/**
 * Send message mutation hook with optimistic updates and offline fallback.
 *
 * @param channelId - Target channel UUID. Pass undefined to disable the hook.
 */
export function useSendMessage(channelId: string | undefined) {
  const { user, tenantId, isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  const isOnline = useNetworkStatus();

  const messageQueryKey = ['messaging', 'messages', channelId, tenantId];

  const mutation = useMutation({
    mutationFn: async (params: SendMessageParams & { _idempotencyKey: string }) => {
      const { _idempotencyKey, ...sendParams } = params;

      const input = {
        channelId,
        content: sendParams.content,
        contentType: sendParams.contentType ?? 'text',
        idempotencyKey: _idempotencyKey,
        parentId: sendParams.parentId ?? null,
        attachmentKeys: sendParams.attachmentKeys ?? [],
        metadata: sendParams.metadata ?? null,
      };

      const result = await graphqlRequest<{ sendMessage: Message }>(
        SEND_MESSAGE,
        { input },
      );

      return result.sendMessage;
    },

    // Optimistic update: insert a pending message immediately
    onMutate: async (params: SendMessageParams & { _idempotencyKey: string }) => {
      // Cancel any outgoing refetches to avoid overwriting optimistic update
      await queryClient.cancelQueries({ queryKey: messageQueryKey });

      // Snapshot previous data for rollback
      const previousData = queryClient.getQueryData(messageQueryKey);

      const optimisticMessage: Message = {
        id: params._idempotencyKey, // Temporary ID — replaced by server response
        channelId: channelId!,
        senderId: user?.id ?? '',
        content: params.content,
        contentType: params.contentType ?? 'text',
        parentId: params.parentId ?? null,
        forwardedFrom: null,
        isDeleted: false,
        createdAt: new Date().toISOString(),
        editedAt: null,
        metadata: params.metadata ?? null,
        sender: user
          ? {
              id: user.id,
              firstName: user.name?.split(' ')[0] ?? null,
              lastName: user.name?.split(' ').slice(1).join(' ') ?? null,
              email: user.email,
            }
          : undefined,
        _status: 'pending',
        _idempotencyKey: params._idempotencyKey,
      };

      // Append optimistic message to the first page (newest messages)
      queryClient.setQueryData(
        messageQueryKey,
        (old: { pages: MessagePage[]; pageParams: (string | null)[] } | undefined) => {
          if (!old?.pages?.length) {
            return {
              pages: [{ items: [optimisticMessage], hasMore: false, cursor: null }],
              pageParams: [null],
            };
          }
          const firstPage = old.pages[0]!;
          return {
            ...old,
            pages: [
              { ...firstPage, items: [...firstPage.items, optimisticMessage] },
              ...old.pages.slice(1),
            ],
          };
        },
      );

      return { previousData };
    },

    // On success: replace optimistic message with server response
    onSuccess: (serverMessage: Message, params) => {
      queryClient.setQueryData(
        messageQueryKey,
        (old: { pages: MessagePage[]; pageParams: (string | null)[] } | undefined) => {
          if (!old?.pages) return old;
          return {
            ...old,
            pages: old.pages.map((page: MessagePage) => ({
              ...page,
              items: page.items.map((m: Message) =>
                m._idempotencyKey === params._idempotencyKey
                  ? { ...serverMessage, _status: 'sent' as const }
                  : m,
              ),
            })),
          };
        },
      );
      // Invalidate channel list to update lastMessage
      queryClient.invalidateQueries({ queryKey: ['messaging', 'channels'] });
    },

    // On error: mark optimistic message as failed
    onError: (_error, params, context) => {
      if (context?.previousData) {
        // Mark the optimistic message as failed instead of rolling back entirely
        queryClient.setQueryData(
          messageQueryKey,
          (old: { pages: MessagePage[]; pageParams: (string | null)[] } | undefined) => {
            if (!old?.pages) return context.previousData;
            return {
              ...old,
              pages: old.pages.map((page: MessagePage) => ({
                ...page,
                items: page.items.map((m: Message) =>
                  m._idempotencyKey === params._idempotencyKey
                    ? { ...m, _status: 'failed' as const }
                    : m,
                ),
              })),
            };
          },
        );
      }
    },
  });

  /**
   * Queue a message in IndexedDB when offline.
   */
  const queueOffline = useCallback(
    async (params: SendMessageParams, idempotencyKey: string) => {
      const queue =
        (await getCachedData<OfflineQueuedMessage[]>(OFFLINE_QUEUE_KEY)) ?? [];
      if (queue.length >= MAX_OFFLINE_QUEUE) {
        throw new Error('Offline message queue is full. Please sync when online.');
      }
      queue.push({
        idempotencyKey,
        channelId: channelId!,
        params,
        createdAt: new Date().toISOString(),
      });
      await cacheData(OFFLINE_QUEUE_KEY, queue, 7 * 24 * 60 * 60 * 1000); // 7 day TTL
    },
    [channelId],
  );

  /**
   * Send a message — online path uses mutation, offline path queues in IndexedDB.
   */
  const sendMessage = useCallback(
    async (params: SendMessageParams) => {
      if (!channelId || !isAuthenticated) {
        throw new Error('Not authenticated or no channel selected');
      }

      const idempotencyKey = generateIdempotencyKey();

      if (!isOnline) {
        await queueOffline(params, idempotencyKey);
        return;
      }

      mutation.mutate({ ...params, _idempotencyKey: idempotencyKey });
    },
    [channelId, isAuthenticated, isOnline, mutation, queueOffline],
  );

  return {
    sendMessage,
    isSending: mutation.isPending,
    error: mutation.error,
  };
}
