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

import { useEffect, useMemo } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from './useAuth';
import { graphqlRequest } from '@/services/authenticated-fetch';
import { cacheData, getCachedData } from '@/pwa/offline-queue';
import { GET_MESSAGES } from '@/graphql/messaging-operations';
import type { Message, MessagePage } from '@/types/messaging';

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

  const result = await graphqlRequest<{ messages: MessagePage }>(
    GET_MESSAGES,
    { channelId, filter },
  );

  if (!result.messages) {
    throw new Error('Invalid response: no messages data');
  }

  return result.messages;
}

/**
 * Messages hook with cursor-based infinite scroll, offline cache, and
 * real-time integration.
 *
 * @param channelId - The channel to fetch messages for. Pass undefined to disable.
 * @param socketRef - Optional ref to a Socket.IO socket for subscribing to
 *                    newMessage events for this channel.
 */
export function useMessages(
  channelId: string | undefined,
  socketRef?: React.RefObject<{
    on: (event: string, handler: (...args: unknown[]) => void) => void;
    off: (event: string, handler: (...args: unknown[]) => void) => void;
  } | null>,
) {
  const { isAuthenticated, tenantId } = useAuth();
  const queryClient = useQueryClient();

  const queryKey = ['messaging', 'messages', channelId, tenantId];

  const query = useInfiniteQuery({
    queryKey,
    queryFn: async ({ pageParam }: { pageParam: string | null }) => {
      try {
        const page = await fetchMessages(channelId!, pageParam);
        // Cache first page in IndexedDB for offline
        if (!pageParam) {
          await cacheData(
            `${CACHE_KEY_PREFIX}${channelId}`,
            page,
            CACHE_TTL_MS,
          ).catch(() => {});
        }
        return page;
      } catch (error) {
        // On first page, try IndexedDB cache
        if (!pageParam) {
          const cached = await getCachedData<MessagePage>(
            `${CACHE_KEY_PREFIX}${channelId}`,
          );
          if (cached) return cached;
        }
        throw error;
      }
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage: MessagePage) =>
      lastPage.hasMore ? lastPage.cursor : undefined,
    enabled: isAuthenticated && !!tenantId && !!channelId,
    staleTime: 15_000, // 15 seconds — messages update frequently
    gcTime: 5 * 60 * 1000, // 5 min in-memory
    refetchOnWindowFocus: false, // Socket.IO handles updates
  });

  // Subscribe to newMessage Socket.IO events for this channel
  useEffect(() => {
    const socket = socketRef?.current;
    if (!socket || !channelId) return;

    const handleNewMessage = (...args: unknown[]) => {
      const event = args[0] as { channelId: string; message: Message } | undefined;
      if (!event || event.channelId !== channelId) return;

      // Optimistically add the new message to the first page of the cache
      queryClient.setQueryData(queryKey, (old: typeof query.data) => {
        if (!old?.pages?.length) return old;

        const firstPage = old.pages[0];
        if (!firstPage) return old;

        // Deduplicate — the message might already exist from an optimistic send
        const alreadyExists = firstPage.items.some(
          (m: Message) => m.id === event.message.id,
        );
        if (alreadyExists) {
          // Replace optimistic message with server version
          return {
            ...old,
            pages: old.pages.map((page: MessagePage, idx: number) =>
              idx === 0
                ? {
                    ...page,
                    items: page.items.map((m: Message) =>
                      m.id === event.message.id ? event.message : m,
                    ),
                  }
                : page,
            ),
          };
        }

        // Append new message to first page (newest messages)
        return {
          ...old,
          pages: [
            { ...firstPage, items: [...firstPage.items, event.message] },
            ...old.pages.slice(1),
          ],
        };
      });
    };

    socket.on('newMessage', handleNewMessage);
    return () => {
      socket.off('newMessage', handleNewMessage);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socketRef, channelId, queryClient]);

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
