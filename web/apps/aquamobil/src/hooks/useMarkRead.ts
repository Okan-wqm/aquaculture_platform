// ============================================================================
// useMarkRead — Advance the read cursor for a channel (read-path SSoT client)
// ============================================================================

/**
 * WHY: The read-state single-source-of-truth lives server-side in
 * `mark-read.handler` — it advances `channel_members.lastReadAt`, writes a
 * `message_receipts` row, and emits the `MessageRead` outbox event in ONE
 * transaction; the receipt is then broadcast outbox → NATS → messaging bridge.
 * The mobile client's only job is to TRIGGER that handler via the
 * `markMessagesRead` GraphQL mutation when the user has actually seen a
 * message. Until this hook existed there was NO client trigger at all, so the
 * unread badge never cleared on mobile (Wave-6 M2, CRITICAL).
 *
 * IMPORTANT: the previous socket path (`emitMarkRead` → server
 * `@SubscribeMessage('markRead')`) was a GHOST contract — the server handler
 * persisted nothing and unconditionally broadcast a fabricated read receipt
 * (Wave-6 G1). That server handler was deleted; the mutation path here is the
 * ONLY supported way to advance read state.
 *
 * Online  → `markMessagesRead` mutation, then SSoT cache invalidation.
 * Offline → enqueue on the SAME offline queue (`markMessagesRead` OperationType)
 *           that `useOfflineQueue` already drains + invalidates on reconnect.
 * Online-but-network-error → fall through to the offline queue so a transient
 *           failure never silently loses the read advance (mirrors
 *           useTaskActions resilience).
 *
 * The online invalidation reuses `invalidateSyncedOperationQueries(...,
 * ['markMessagesRead'])` — the EXACT same query-key set the offline replay
 * uses — so both write paths converge on one invalidation map (SSoT).
 */

import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { useAuth } from './useAuth';
import { useNetworkStatus } from './useNetworkStatus';
import { useOfflineQueue } from './useOfflineQueue';

import { MARK_MESSAGES_READ } from '@/graphql/messaging-operations';
import { graphqlRequest } from '@/services/authenticated-fetch';
import { logger } from '@/utils/logger';
import { invalidateSyncedOperationQueries } from '@/utils/offline-sync-invalidation';

export interface UseMarkReadResult {
  /**
   * Advance the current user's read cursor in `channelId` up to `messageId`.
   * Idempotent on the server (skips when `lastReadAt >= message.createdAt`),
   * so callers may invoke it freely on view/scroll/focus changes. Never throws
   * — failures degrade to the offline queue for later replay.
   */
  markRead: (messageId: string) => Promise<void>;
}

/**
 * Read-cursor advance hook.
 *
 * @param channelId - Target channel UUID. Pass undefined to disable the hook
 *   (markRead becomes a no-op).
 */
export function useMarkRead(channelId: string | undefined): UseMarkReadResult {
  const { isAuthenticated, tenantId } = useAuth();
  const isOnline = useNetworkStatus();
  const { addToQueue } = useOfflineQueue();
  const queryClient = useQueryClient();

  const markRead = useCallback(
    async (messageId: string): Promise<void> => {
      if (!channelId || !isAuthenticated) {
        return;
      }
      // After the guard above, control-flow analysis narrows `channelId` to
      // `string` for the rest of this scope — no assertion needed.

      if (!isOnline) {
        try {
          await addToQueue('markMessagesRead', { channelId, messageId });
        } catch (error) {
          // Callers rely on markRead() never throwing (it degrades to the
          // offline queue) — a queue failure (e.g. no active tenant) must not
          // propagate as an unhandled rejection from a fire-and-forget caller.
          logger.error('[useMarkRead] failed to queue offline read-cursor advance', error);
        }
        return;
      }

      try {
        await graphqlRequest<{ markMessagesRead: boolean }>(MARK_MESSAGES_READ, {
          input: { channelId, messageId },
        });
        if (tenantId) {
          await invalidateSyncedOperationQueries(queryClient, tenantId, ['markMessagesRead']);
        }
      } catch {
        // Transient network/server error while online — preserve the read
        // advance by routing through the offline queue rather than dropping it.
        try {
          await addToQueue('markMessagesRead', { channelId, messageId });
        } catch (error) {
          logger.error(
            '[useMarkRead] failed to queue read-cursor advance after online attempt failed',
            error,
          );
        }
      }
    },
    [channelId, isAuthenticated, isOnline, tenantId, queryClient, addToQueue],
  );

  return { markRead };
}
