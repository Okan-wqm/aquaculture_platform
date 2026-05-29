// ============================================================================
// useChannelMembers — Channel member list with online status enrichment
// ============================================================================

/**
 * WHY: Provides the member list for a specific channel, enriched with online
 * status from Socket.IO presence events. Uses TanStack Query for caching
 * and automatic refetching. The onlineCount is derived from the presence
 * data rather than a separate query, avoiding an extra round-trip.
 *
 * @param channelId - The channel whose members to fetch
 * @returns members — array of channel members with user details
 * @returns isLoading — true during initial fetch
 * @returns onlineCount — number of currently online members
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { messagingQueryKeys } from '@/utils/messaging-query-keys';
import { useAuth } from './useAuth';
import { graphqlRequest } from '@/services/authenticated-fetch';
import { GET_CHANNEL } from '@/graphql/messaging-operations';
import type { Channel, ChannelMember } from '@/types/messaging';

/**
 * Fetches a channel by ID and extracts its member list.
 *
 * @param channelId - Target channel UUID
 * @returns Array of active (non-left) channel members
 */
async function fetchChannelMembers(channelId: string): Promise<ChannelMember[]> {
  const result = await graphqlRequest<{ channel: Channel }>(
    GET_CHANNEL,
    { id: channelId },
  );

  if (!result.channel?.members) {
    throw new Error('Invalid response: no channel members data');
  }

  // Filter out members who have left (leftAt is set)
  return result.channel.members.filter((m) => m.leftAt === null);
}

/**
 * Channel members hook with online status enrichment.
 *
 * @param channelId - The channel to fetch members for. Pass undefined to disable.
 * @param onlineUserIds - Optional set of user IDs known to be online (from
 *                        useMessageSocket presence tracking). Used to enrich
 *                        the member list without a separate presence query.
 */
export function useChannelMembers(
  channelId: string | undefined,
  onlineUserIds?: Set<string>,
) {
  const { isAuthenticated, tenantId } = useAuth();

  const query = useQuery({
    queryKey: messagingQueryKeys.channelMembers(tenantId, channelId),
    queryFn: () => fetchChannelMembers(channelId!),
    enabled: isAuthenticated && !!tenantId && !!channelId,
    staleTime: 60_000, // 1 minute — member list changes infrequently
    gcTime: 10 * 60 * 1000, // 10 min in-memory
    refetchOnWindowFocus: true,
  });

  // Enrich members with online status from presence data
  const members = useMemo(() => {
    if (!query.data) return [];
    if (!onlineUserIds || onlineUserIds.size === 0) return query.data;

    return query.data.map((member) => ({
      ...member,
      user: member.user
        ? { ...member.user, isOnline: onlineUserIds.has(member.userId) }
        : { id: member.userId, isOnline: onlineUserIds.has(member.userId) },
    }));
  }, [query.data, onlineUserIds]);

  const onlineCount = useMemo(() => {
    if (!onlineUserIds) return 0;
    const memberUserIds = (query.data ?? []).map((m) => m.userId);
    return memberUserIds.filter((uid) => onlineUserIds.has(uid)).length;
  }, [query.data, onlineUserIds]);

  return {
    members,
    isLoading: query.isLoading,
    error: query.error,
    onlineCount,
  };
}
