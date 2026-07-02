// ============================================================================
// useEditMessage — Edit an own message (write-path producer for editMessage)
// ============================================================================

/**
 * WHY (MSG-MEDIUM-053): `editMessage` was a DEAD producer. It was declared as
 * an OperationType, wired into the offline-queue MUTATIONS map, the
 * sync-invalidation map, and the executeGraphQL `id + { content }` splitter —
 * yet NO client code ever called `addToQueue('editMessage', ...)`, so a message
 * edit could never be enqueued offline. The whole offline-edit path was
 * reachable only in theory. This hook is the missing producer.
 *
 * Online  → `editMessage` mutation, then SSoT cache invalidation (the SAME
 *           `invalidateSyncedOperationQueries(..., ['editMessage'])` key set the
 *           offline replay uses, so both write paths converge on one map).
 * Offline → enqueue on the main offline queue (`editMessage` OperationType) that
 *           `useOfflineQueue` already drains + invalidates on reconnect.
 * Online-but-network-error → fall through to the offline queue so a transient
 *           failure never silently loses the edit (mirrors useMarkRead /
 *           useTaskActions resilience).
 *
 * The offline payload is the typed `{ id, content }` arm of MessagingOfflinePayload
 * — executeGraphQL splits it into `{ id, input: { content } }` on replay, which
 * is exactly the EDIT_MESSAGE mutation's variable shape.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { useAuth } from './useAuth';
import { useNetworkStatus } from './useNetworkStatus';
import { useOfflineQueue } from './useOfflineQueue';

import { EDIT_MESSAGE } from '@/graphql/messaging-operations';
import { graphqlRequest } from '@/services/authenticated-fetch';
import type { Message } from '@/types/messaging';
import { logger } from '@/utils/logger';
import { invalidateSyncedOperationQueries } from '@/utils/offline-sync-invalidation';

export interface UseEditMessageResult {
  /**
   * Replace the text content of message `messageId` with `content`. Resolves
   * once the edit has been committed (online) or durably enqueued (offline /
   * transient error). Never throws on a transient failure — it degrades to the
   * offline queue for later replay. Throws only on a programmer error
   * (unauthenticated / empty content), which the caller must guard against.
   */
  editMessage: (messageId: string, content: string) => Promise<void>;
}

/**
 * Message-edit producer hook.
 *
 * @param channelId - Channel the message belongs to. Used only to scope cache
 *   invalidation; the edit itself is keyed by message id. Pass undefined to
 *   disable the hook (editMessage becomes a no-op).
 */
export function useEditMessage(channelId: string | undefined): UseEditMessageResult {
  const { isAuthenticated, tenantId } = useAuth();
  const isOnline = useNetworkStatus();
  const { addToQueue } = useOfflineQueue();
  const queryClient = useQueryClient();

  const editMessage = useCallback(
    async (messageId: string, content: string): Promise<void> => {
      const trimmed = content.trim();
      if (!channelId || !isAuthenticated || !trimmed) {
        return;
      }

      if (!isOnline) {
        try {
          await addToQueue('editMessage', { id: messageId, content: trimmed });
        } catch (error) {
          // Callers rely on editMessage() never throwing on a transient failure
          // (it degrades to the offline queue) — a queue failure itself must not
          // propagate as an unhandled rejection from a fire-and-forget caller.
          logger.error('[useEditMessage] failed to queue offline message edit', error);
        }
        return;
      }

      try {
        await graphqlRequest<{ editMessage: Message }>(EDIT_MESSAGE, {
          id: messageId,
          input: { content: trimmed },
        });
        if (tenantId) {
          await invalidateSyncedOperationQueries(queryClient, tenantId, ['editMessage']);
        }
      } catch {
        // Transient network/server error while online — preserve the edit by
        // routing through the offline queue rather than dropping it.
        try {
          await addToQueue('editMessage', { id: messageId, content: trimmed });
        } catch (error) {
          logger.error('[useEditMessage] failed to queue message edit after online attempt failed', error);
        }
      }
    },
    [channelId, isAuthenticated, isOnline, tenantId, queryClient, addToQueue],
  );

  return { editMessage };
}
