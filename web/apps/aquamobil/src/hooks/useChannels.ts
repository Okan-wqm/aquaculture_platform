// ============================================================================
// useChannels — Channel list hook with pagination, offline cache, and real-time
// ============================================================================

/**
 * WHY: Provides the paginated list of channels the current user belongs to,
 * with IndexedDB cache fallback for offline scenarios and Socket.IO-driven
 * refetch when channel data changes server-side. Uses TanStack Query for
 * stale-while-revalidate caching and automatic background refetching.
 *
 * @returns channels — the current page of channels
 * @returns isLoading — true during initial fetch
 * @returns error — GraphQL or network error, if any
 * @returns refetch — manually trigger a refetch
 * @returns hasMore — whether more channels exist beyond current page
 * @returns fetchMore — load the next page of channels
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useAuth } from './useAuth';

import { MY_CHANNELS } from '@/graphql/messaging-operations';
import { cacheUserData, getCachedUserData } from '@/pwa/offline-queue';
import { graphqlRequest } from '@/services/authenticated-fetch';
import type { ChannelPage } from '@/types/messaging';
import { normalizeChannelType } from '@/utils/channel-type-wire';
import { createTenantQueryKey } from '@/utils/tenant-query-keys';
import { userScopedCacheKey } from '@/utils/user-scoped-cache-key';

/** Number of channels per page. */
const PAGE_SIZE = 30;

/** IndexedDB cache key for channels. */
const CACHE_KEY = 'messaging_channels';

/** Cache TTL: 2 hours for offline fallback. */
const CACHE_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * Fetches the paginated channel list for the current user.
 *
 * @param limit - Maximum channels to fetch
 * @param offset - Pagination offset
 * @returns ChannelPage with items and total count
 */
async function fetchChannels(limit: number, offset: number): Promise<ChannelPage> {
  const result = await graphqlRequest<{ myChannels: ChannelPage }>(
    MY_CHANNELS,
    { filter: { limit, offset } },
  );

  if (!result.myChannels?.items) {
    throw new Error('Invalid response: no channel data');
  }

  // MSG-HIGH-054 (read half): the messaging subgraph registers `ChannelType`
  // without a valuesMap, so graphql-js SERIALIZES the stored lowercase value
  // back to the wire KEY (`'group'` -> `'GROUP'`). Normalize at this single read
  // boundary so every downstream `channel.type === 'group'` comparison stays
  // correct and the wire casing never leaks into the UI or the offline cache.
  return {
    ...result.myChannels,
    items: result.myChannels.items.map(normalizeChannelType),
  };
}

/**
 * Channel list hook with offline-first caching and real-time updates.
 *
 * @param socketRef - Optional ref to a Socket.IO socket for subscribing to
 *                    channelUpdated events. If not provided, real-time updates
 *                    are skipped and polling is the only refresh mechanism.
 */
export function useChannels(socketRef?: React.RefObject<{ on: (event: string, handler: () => void) => void; off: (event: string, handler: () => void) => void } | null>) {
  const { isAuthenticated, tenantId, user } = useAuth();
  const queryClient = useQueryClient();
  const [offset, setOffset] = useState(0);

  const accumulatedChannelsRef = useRef<ChannelPage['items']>([]);

  // MT-CRITICAL-051: `myChannels` is membership-scoped — it returns the CURRENT
  // USER's channels — so user.id is part of BOTH the React Query key (this line)
  // AND the IndexedDB cache namespace (userScopedCacheKey below). Without the
  // user dimension, user A's channel list (sender names, unread state) is served
  // to user B on the same tenant/device after a logout→login. WHY 2026-04-29: the
  // tenant factory keeps tenant switches and sync invalidation on one cache tree.
  const queryKey = createTenantQueryKey(tenantId, 'messaging', 'channels', user?.id, offset);

  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const userId = user?.id;
      try {
        const page = await fetchChannels(PAGE_SIZE, offset);
        // Write to IndexedDB as offline fallback (only first page). The cache key
        // embeds user.id via userScopedCacheKey, so the namespace is per-user, not
        // per-tenant (MT-CRITICAL-051) — and tenant-isolated by cacheUserData.
        if (offset === 0 && tenantId && userId) {
          const cacheKey = userScopedCacheKey(userId, CACHE_KEY);
          await cacheUserData(tenantId, cacheKey, page, CACHE_TTL_MS).catch(() => undefined);
        }
        return page;
      } catch (error) {
        // Network failed — return IndexedDB cached data if available (per-user).
        if (offset === 0 && tenantId && userId) {
          const cacheKey = userScopedCacheKey(userId, CACHE_KEY);
          const cached = await getCachedUserData<ChannelPage>(tenantId, cacheKey);
          if (cached) return cached;
        }
        throw error;
      }
    },
    enabled: isAuthenticated && !!tenantId && !!user?.id,
    staleTime: 30_000, // 30 seconds — channels change infrequently
    gcTime: 10 * 60 * 1000, // 10 min in-memory
    refetchOnWindowFocus: true,
  });

  // Subscribe to channelUpdated Socket.IO events for real-time refresh
  useEffect(() => {
    const socket = socketRef?.current;
    if (!socket) return;

    const handleChannelUpdated = () => {
      queryClient.invalidateQueries({ queryKey: createTenantQueryKey(tenantId, 'messaging', 'channels') });
    };

    socket.on('channelUpdated', handleChannelUpdated);
    return () => {
      socket.off('channelUpdated', handleChannelUpdated);
    };
  }, [socketRef, queryClient, tenantId]);

  const hasMore = (query.data?.total ?? 0) > offset + PAGE_SIZE;

  const fetchMore = useCallback(() => {
    if (hasMore) {
      setOffset((prev) => prev + PAGE_SIZE);
    }
  }, [hasMore]);

  // Accumulate page results for progressive loading
  useEffect(() => {
    if (query.data?.items) {
      if (offset === 0) {
        accumulatedChannelsRef.current = query.data.items;
      } else {
        const existingIds = new Set(accumulatedChannelsRef.current.map((c) => c.id));
        const newItems = query.data.items.filter((c) => !existingIds.has(c.id));
        accumulatedChannelsRef.current = [...accumulatedChannelsRef.current, ...newItems];
      }
    }
  }, [query.data?.items, offset]);

  return {
    channels: accumulatedChannelsRef.current.length > 0
      ? accumulatedChannelsRef.current
      : (query.data?.items ?? []),
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
    hasMore,
    fetchMore,
  };
}
