// ============================================================================
// useChannelDetail — Single channel detail query with member enrichment
// ============================================================================

/**
 * WHY: Provides the full detail view for a single channel, including its
 * member list, notification preferences, and metadata. Uses the GET_CHANNEL
 * GraphQL query and TanStack Query for caching. This is the primary data
 * hook for ChannelSettingsPage and the ChatRoomPage header.
 *
 * @param channelId - The channel to fetch. Pass undefined to disable.
 * @returns channel — full channel detail with members
 * @returns isLoading — true during initial fetch
 * @returns error — GraphQL or network error
 * @returns refetch — manually trigger a refetch
 */

import { useQuery } from '@tanstack/react-query';

import { useAuth } from './useAuth';

import { GET_CHANNEL } from '@/graphql/messaging-operations';
import { graphqlRequest } from '@/services/authenticated-fetch';
import type { Channel } from '@/types/messaging';
import { normalizeChannelType } from '@/utils/channel-type-wire';
import { createTenantQueryKey } from '@/utils/tenant-query-keys';

/**
 * Fetches a single channel by ID.
 *
 * @param channelId - Target channel UUID
 * @returns Full channel object with members array
 */
async function fetchChannel(channelId: string): Promise<Channel> {
  const result = await graphqlRequest<{ channel: Channel }>(
    GET_CHANNEL,
    { id: channelId },
  );

  if (!result.channel) {
    throw new Error('Channel not found');
  }

  // MSG-HIGH-054 (read half): the messaging subgraph serializes the stored
  // lowercase `ChannelType` back to its wire KEY (`'group'` -> `'GROUP'`).
  // Normalize at this single read boundary so the ChannelSettingsPage and
  // ChatRoomPage header comparisons (`channel.type === 'group'`) stay correct.
  return normalizeChannelType(result.channel);
}

/**
 * Single channel detail hook for settings and header display.
 *
 * @param channelId - The channel ID to query. Pass undefined to disable the query.
 */
export function useChannelDetail(channelId: string | undefined) {
  const { isAuthenticated, tenantId } = useAuth();

  const query = useQuery({
    queryKey: createTenantQueryKey(tenantId, 'messaging', 'channel', channelId, tenantId),
    queryFn: () => fetchChannel(channelId!),
    enabled: isAuthenticated && !!tenantId && !!channelId,
    staleTime: 30_000,
    gcTime: 10 * 60 * 1000,
    refetchOnWindowFocus: true,
  });

  return {
    channel: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}
