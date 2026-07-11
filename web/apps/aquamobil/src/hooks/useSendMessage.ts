// ============================================================================
// useSendMessage — Send message mutation with optimistic updates and offline queue
// ============================================================================

/**
 * WHY: Provides a mutation hook for sending messages to a channel. Generates a
 * client-side idempotencyKey (UUID) to prevent duplicate sends on retry.
 * Implements optimistic updates: the message appears in the chat immediately
 * with a 'pending' status, is replaced with the server response on success,
 * and marked as 'failed' with retry capability on error. Falls back to the
 * main offline queue (useOfflineQueue / addToQueue) when offline, ensuring all
 * offline operations are synced by the single syncAllOperations() flow.
 *
 * IMPORTANT: Previous implementation used a SEPARATE IndexedDB cache key
 * ('messaging_offline_sends') that was NEVER drained on reconnect. This has
 * been consolidated into the main offline queue which supports 'sendMessage'
 * as a first-class OperationType with automatic sync on reconnect.
 *
 * @param channelId - The channel to send messages to
 * @returns sendMessage — function to send a new message
 * @returns isSending — true while the mutation is in flight
 * @returns error — mutation error, if any
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';


import { useAuth } from './useAuth';
import { useNetworkStatus } from './useNetworkStatus';
import { useOfflineQueue } from './useOfflineQueue';

import { SEND_MESSAGE } from '@/graphql/messaging-operations';
import { graphqlRequest } from '@/services/authenticated-fetch';
import type { Message, MessagePage, MessageContentType } from '@/types/messaging';
import { messagesQueryKey } from '@/utils/messaging-query-keys';
import { invalidateSyncedOperationQueries } from '@/utils/offline-sync-invalidation';

interface SendMessageParams {
  content: string | null;
  contentType?: MessageContentType;
  parentId?: string;
  attachmentKeys?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * Generate a UUID v4 using the Web Crypto API.
 */
function generateIdempotencyKey(): string {
  return crypto.randomUUID();
}

/** Return shape of {@link useSendMessage}. */
export interface UseSendMessageReturn {
  /** Send a message (online mutation, or offline queue when disconnected). */
  sendMessage: (params: SendMessageParams) => Promise<void>;
  /** True while the send mutation is in flight. */
  isSending: boolean;
  /** Last mutation error, or null. */
  error: Error | null;
}

/**
 * Send message mutation hook with optimistic updates and offline fallback.
 *
 * @param channelId - Target channel UUID. Pass undefined to disable the hook.
 */
export function useSendMessage(channelId: string | undefined): UseSendMessageReturn {
  const { user, tenantId, isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  const isOnline = useNetworkStatus();
  const { addToQueue } = useOfflineQueue();

  // MSG-CRITICAL-055: useMessages reads this EXACT key (incl. the user.id
  // segment). Optimistic writes, cancellation, rollback, and setQueryData must
  // target the same cache entry via the shared `messagesQueryKey` SSoT — a
  // user.id-less key here is precisely why optimistic bubbles never rendered.
  const messageQueryKey = messagesQueryKey(tenantId, user?.id, channelId);

  const mutation = useMutation({
    mutationFn: async (params: SendMessageParams & { _idempotencyKey: string }) => {
      const { _idempotencyKey, ...sendParams } = params;

      const input = {
        channelId,
        content: sendParams.content,
        // S1-CODEGEN: MessageContentType wire form is the UPPERCASE GraphQL enum NAME.
        contentType: sendParams.contentType ?? 'TEXT',
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
      // WHY guard-throw: the mutation is only ever invoked from `sendMessage`,
      // which already rejects a missing channelId — but the type is not narrowed
      // here. Throwing narrows channelId to `string` so the optimistic message
      // needs no non-null assertion, and the impossible branch fails loudly.
      if (!channelId) throw new Error('useSendMessage: channelId is required');
      // Cancel any outgoing refetches to avoid overwriting the optimistic update.
      // Uses the SAME `messagesQueryKey` SSoT as the reader and the setQueryData
      // calls below, so the cancel targets the cache entry actually in flight
      // (MSG-CRITICAL-055). `messagesQueryKey` wraps createTenantQueryKey, keeping
      // the tenant-prefix discipline the no-bare-tenant-query-key rule protects.
      await queryClient.cancelQueries({
        queryKey: messagesQueryKey(tenantId, user?.id, channelId),
      });

      // Snapshot previous data for rollback
      const previousData = queryClient.getQueryData(messageQueryKey);

      const optimisticMessage: Message = {
        id: params._idempotencyKey, // Client-side optimistic ID — overwritten by server response on settle
        channelId,
        senderId: user?.id ?? '',
        content: params.content,
        contentType: params.contentType ?? 'TEXT',
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
          const firstPage = old.pages[0];
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
    onSuccess: async (serverMessage: Message, params) => {
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
      if (tenantId) {
        await invalidateSyncedOperationQueries(queryClient, tenantId, ['sendMessage']);
      }
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
   * Send a message — online path uses mutation, offline path routes through
   * the main offline queue via addToQueue('sendMessage', payload).
   *
   * WHY no separate cache: The previous 'messaging_offline_sends' IndexedDB
   * cache was NEVER drained by syncAllOperations(), causing silent message
   * loss. The main queue already supports 'sendMessage' as an OperationType
   * with proper sync, retry, and dedup (by idempotencyKey).
   */
  const sendMessage = useCallback(
    async (params: SendMessageParams) => {
      if (!channelId || !isAuthenticated) {
        throw new Error('Not authenticated or no channel selected');
      }

      const idempotencyKey = generateIdempotencyKey();

      // The durable queue payload for this logical send. Identical for the
      // offline-first path and the online-failure fallback (MSG-HIGH-061), so a
      // transient online failure replays the SAME send — same idempotencyKey,
      // same attachmentKeys (durable storageKey, no re-upload). idempotencyKey is
      // ALSO threaded as the clientCommandId (3rd arg, FARM-HIGH-057) so an
      // online-fail-then-queue retry is one at-most-once command the server dedups.
      const queuePayload = {
        channelId,
        content: params.content,
        contentType: params.contentType ?? 'TEXT',
        idempotencyKey,
        parentId: params.parentId ?? undefined,
        attachmentKeys: params.attachmentKeys ?? [],
        metadata: params.metadata ?? undefined,
      };

      if (!isOnline) {
        // Route through the main offline queue — syncAllOperations() will
        // drain this when connectivity returns, using the 'sendMessage'
        // GraphQL mutation defined in useOfflineQueue MUTATIONS map.
        await addToQueue('sendMessage', queuePayload, idempotencyKey);
        return;
      }

      try {
        await mutation.mutateAsync({ ...params, _idempotencyKey: idempotencyKey });
      } catch {
        // MSG-HIGH-061: an online send that fails transiently (5xx / dropped
        // socket / gateway 429) must NOT be silently dropped, nor left as a
        // perpetual "pending" bubble with no retry. Durably queue the identical
        // send so it replays on reconnect; the server ledger dedups against the
        // threaded idempotencyKey. Parity with useEditMessage / useMarkRead,
        // which already fall through to the queue on an online error. onMutate
        // already inserted the optimistic bubble and onError marked it failed;
        // the queued replay reconciles it to the server message on next sync.
        await addToQueue('sendMessage', queuePayload, idempotencyKey);
      }
    },
    [channelId, isAuthenticated, isOnline, mutation, addToQueue],
  );

  return {
    sendMessage,
    isSending: mutation.isPending,
    error: mutation.error,
  };
}
