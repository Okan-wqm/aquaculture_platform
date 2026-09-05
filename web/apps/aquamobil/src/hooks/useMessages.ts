// ============================================================================
// useMessages — Paginated messages hook with cursor-based infinite scroll
// ============================================================================

/**
 * WHY: Provides cursor-based infinite scroll for a channel's message history.
 * Uses TanStack Query's useInfiniteQuery so that scrolling up loads older
 * messages without losing the current scroll position. Includes IndexedDB
 * cache per channel for offline scenarios and Socket.IO-driven optimistic
 * inserts when new messages arrive.
 *
 * @param channelId - The channel whose messages to fetch
 * @returns messages — flat array of all loaded messages (newest last)
 * @returns isLoading — true during initial fetch
 * @returns fetchNextPage — load older messages on scroll-up
 * @returns hasNextPage — whether older messages exist
 * @returns isFetchingNextPage — true while loading older messages
 */

import { useInfiniteQuery, type UseInfiniteQueryResult, type InfiniteData } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useAuth } from './useAuth';

import { GET_MESSAGES } from '@/graphql/messaging-operations';
import { cacheUserData, getCachedUserData } from '@/pwa/offline-queue';
import { graphqlRequest } from '@/services/authenticated-fetch';
import type { Message, MessagePage } from '@/types/messaging';
import { logger } from '@/utils/logger';
import { messagesQueryKey } from '@/utils/messaging-query-keys';
import { userScopedCacheKey } from '@/utils/user-scoped-cache-key';

/** Messages per page (cursor-based). */
const PAGE_SIZE = 40;

/** IndexedDB cache key prefix per channel. */
const CACHE_KEY_PREFIX = 'messaging_messages_';

/** Cache TTL: 1 hour for offline fallback. */
const CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Fetches a page of messages for a channel using cursor-based pagination.
 *
 * @param channelId - Target channel UUID
 * @param cursor - Opaque pagination cursor (null for latest messages)
 * @returns MessagePage with items, hasMore, and next cursor
 */
async function fetchMessages(
  channelId: string,
  cursor: string | null,
): Promise<MessagePage> {
  const filter: Record<string, unknown> = { limit: PAGE_SIZE };
  if (cursor) {
    filter.cursor = cursor;
  }

  const result = await graphqlRequest(
    GET_MESSAGES,
    { channelId, filter },
  );

  if (!result.messages) {
    throw new Error('Invalid response: no messages data');
  }

  return result.messages;
}

/** Socket.IO surface kept for API compatibility (no longer used here). */
type MessagesSocketLike = {
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  off: (event: string, handler: (...args: unknown[]) => void) => void;
};

/** Return shape of {@link useMessages}. */
export interface UseMessagesReturn {
  /** All loaded messages, oldest-first (empty until loaded). */
  messages: Message[];
  /** True during the initial fetch. */
  isLoading: boolean;
  /** GraphQL or network error, or null. */
  error: Error | null;
  /** Load the next (older) page of messages. */
  fetchNextPage: UseInfiniteQueryResult<InfiniteData<MessagePage>, Error>['fetchNextPage'];
  /** Whether older messages exist. */
  hasNextPage: boolean;
  /** True while loading older messages. */
  isFetchingNextPage: boolean;
}

/**
 * Messages hook with cursor-based infinite scroll and offline cache.
 *
 * WHY no Socket.IO subscription here: useMessageSocket already subscribes to
 * 'newMessage' events and updates the query cache directly (C3 fix). Having
 * both hooks subscribe to the same event causes duplicate message inserts.
 * This hook only handles data fetching; real-time updates are the sole
 * responsibility of useMessageSocket.
 *
 * @param channelId - The channel to fetch messages for. Pass undefined to disable.
 * @param _socketRef - Kept for API compatibility but no longer used for subscriptions.
 */
export function useMessages(
  channelId: string | undefined,
  _socketRef?: React.RefObject<MessagesSocketLike | null>,
): UseMessagesReturn {
  const { isAuthenticated, tenantId, user } = useAuth();

  const query = useInfiniteQuery({
    // WHY 2026-04-29: message pages participate in tenant-switch cleanup and
    // offline-sync invalidation, so their keys must live under the tenant prefix.
    // MT-CRITICAL-051: channel messages are membership-scoped, so user.id is part
    // of both the React Query key and the IndexedDB cache namespace below.
    // MSG-CRITICAL-055: the read key and every live/optimistic write key are now
    // the SAME `messagesQueryKey` SSoT (fixed arity forces the user.id segment on
    // both sides), so live messages/edits/deletes/receipts land where this query
    // reads. `messagesQueryKey` wraps createTenantQueryKey, keeping the tenant
    // prefix — and thus the no-bare-tenant-query-key discipline — by construction.
    queryKey: messagesQueryKey(tenantId, user?.id, channelId),
    queryFn: async ({ pageParam }: { pageParam: string | null }) => {
      const userId = user?.id;
      // WHY guard-throw: `enabled` gates execution on channelId but does not
      // narrow its type. An explicit throw narrows it without a non-null assertion.
      if (!channelId) throw new Error('useMessages: channelId is required');
      try {
        const page = await fetchMessages(channelId, pageParam);
        // Cache first page in IndexedDB for offline. MT-CRITICAL-051: the cache
        // namespace embeds user.id — the offline fallback below serves cached
        // messages WITHOUT re-checking channel membership, so a tenant+channel
        // key would let user B deep-link channel X offline and read user A's
        // cached messages on a shared device. cacheUserData keeps tenant isolation.
        if (!pageParam && tenantId && userId) {
          const cacheKey = userScopedCacheKey(userId, `${CACHE_KEY_PREFIX}${channelId}`);
          await cacheUserData(tenantId, cacheKey, page, CACHE_TTL_MS).catch((error: unknown) => {
            logger.error('[useMessages] failed to cache message page for offline fallback', error);
          });
        }
        return page;
      } catch (error) {
        // On first page, fall back to the per-user IndexedDB cache.
        if (!pageParam && tenantId && userId) {
          const cacheKey = userScopedCacheKey(userId, `${CACHE_KEY_PREFIX}${channelId}`);
          const cached = await getCachedUserData<MessagePage>(tenantId, cacheKey);
          if (cached) return cached;
        }
        throw error;
      }
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage: MessagePage) =>
      lastPage.hasMore ? lastPage.cursor : undefined,
    enabled: isAuthenticated && !!tenantId && !!channelId && !!user?.id,
    staleTime: 15_000, // 15 seconds — messages update frequently
    gcTime: 5 * 60 * 1000, // 5 min in-memory
    refetchOnWindowFocus: false, // Socket.IO handles updates via useMessageSocket
  });

  // Flatten all pages into a single messages array (oldest first)
  const messages = useMemo(() => {
    if (!query.data?.pages) return [];

    // Pages are in reverse order (first page = newest), so we reverse
    // to get oldest-first ordering for the chat view.
    const allMessages: Message[] = [];
    for (let i = query.data.pages.length - 1; i >= 0; i--) {
      const page = query.data.pages[i];
      if (page) {
        allMessages.push(...page.items);
      }
    }
    return allMessages;
  }, [query.data?.pages]);

  return {
    messages,
    isLoading: query.isLoading,
    error: query.error,
    fetchNextPage: query.fetchNextPage,
    hasNextPage: !!query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
  };
}
