// ============================================================================
// useUnreadCount — Total unread message count with polling and real-time updates
// ============================================================================

/**
 * WHY: Provides the total unread message count across all channels for the
 * messaging tab badge. Uses a lightweight GraphQL query with 60-second
 * polling as fallback. Socket.IO events (newMessage, readReceipt) trigger
 * immediate cache invalidation via the useMessageSocket hook, so the
 * polling interval is generous — it's a safety net, not the primary
 * update mechanism.
 *
 * @returns unreadCount — total unread messages across all channels
 * @returns isLoading — true during initial fetch
 */

import { useQuery } from '@tanstack/react-query';

import { useAuth } from './useAuth';

import { TOTAL_UNREAD_MESSAGE_COUNT } from '@/graphql/messaging-operations';
import { graphqlRequest } from '@/services/authenticated-fetch';
import { createTenantQueryKey } from '@/utils/tenant-query-keys';

/** Polling interval as fallback when Socket.IO events are not available. */
const POLL_INTERVAL_MS = 60_000; // 60 seconds

/**
 * Total unread message count hook.
 *
 * WHY lightweight polling: The main update path is through Socket.IO events
 * (newMessage increments, readReceipt decrements) which invalidate this query
 * via useMessageSocket. The 60-second poll is a fallback for when Socket.IO
 * is disconnected (e.g., backgrounded PWA) to ensure the badge eventually
 * catches up.
 */
/** Return shape of {@link useUnreadCount}. */
export interface UseUnreadCountReturn {
  /** Total unread messages across all channels (0 until loaded). */
  unreadCount: number;
  /** True during the initial fetch. */
  isLoading: boolean;
  /** ORPHAN-HIGH-595: a swallowed error makes the badge read "0 unread"
   *  when it means "we could not ask". Carried out so callers can tell. */
  isError: boolean;
}

export function useUnreadCount(): UseUnreadCountReturn {
  const { isAuthenticated, tenantId } = useAuth();

  const query = useQuery({
    queryKey: createTenantQueryKey(tenantId, 'messaging', 'unreadCount', tenantId),
    queryFn: async () => {
      const result = await graphqlRequest<{ totalUnreadMessageCount: number }>(
        TOTAL_UNREAD_MESSAGE_COUNT,
      );

      if (typeof result.totalUnreadMessageCount !== 'number') {
        return 0;
      }

      return result.totalUnreadMessageCount;
    },
    enabled: isAuthenticated && !!tenantId,
    staleTime: 30_000, // 30 seconds
    gcTime: 5 * 60 * 1000, // 5 min in-memory
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: false, // Don't poll when tab is hidden
    refetchOnWindowFocus: true,
  });

  return {
    unreadCount: query.data ?? 0,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
