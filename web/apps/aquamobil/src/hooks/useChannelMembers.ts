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

import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';


import { useAuth } from './useAuth';

import { GET_CHANNEL } from '@/graphql/messaging-operations';
import { graphqlRequest } from '@/services/authenticated-fetch';
import type { ChannelMember } from '@/types/messaging';
import { createTenantQueryKey } from '@/utils/tenant-query-keys';

/**
 * Fetches a channel by ID and extracts its member list.
 *
 * @param channelId - Target channel UUID
 * @returns Array of active (non-left) channel members
 */
async function fetchChannelMembers(channelId: string): Promise<ChannelMember[]> {
  const result = await graphqlRequest(
    GET_CHANNEL,
    { id: channelId },
  );

  if (!result.channel?.members) {
    throw new Error('Invalid response: no channel members data');
  }

  // Filter out members who have left (leftAt is set)
  return result.channel.members.filter((m) => m.leftAt === null);
}

/** Return shape of {@link useChannelMembers}. */
export interface UseChannelMembersReturn {
  /** Active members, enriched with online status (empty until loaded). */
  members: ChannelMember[];
  /** True during the initial fetch. */
  isLoading: boolean;
  /** GraphQL or network error, or null. */
  error: Error | null;
  /** Number of members currently online. */
  onlineCount: number;
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
): UseChannelMembersReturn {
  const { isAuthenticated, tenantId } = useAuth();

  const query = useQuery({
    queryKey: createTenantQueryKey(tenantId, 'messaging', 'channelMembers', channelId, tenantId),
    // WHY guard-throw instead of `channelId!`: `enabled` gates execution on
    // channelId but does not narrow the type. An explicit throw narrows it
    // without a non-null assertion (the branch is unreachable while enabled).
    queryFn: () => {
      if (!channelId) throw new Error('useChannelMembers: channelId is required');
      return fetchChannelMembers(channelId);
    },
    enabled: isAuthenticated && !!tenantId && !!channelId,
    staleTime: 60_000, // 1 minute — member list changes infrequently
    gcTime: 10 * 60 * 1000, // 10 min in-memory
    refetchOnWindowFocus: true,
  });

  // Enrich members with online status from presence data
  const members = useMemo(() => {
    if (!query.data) return [];
    if (!onlineUserIds || onlineUserIds.size === 0) return query.data;

    // A member without a federated profile stays profile-less: presence is a
    // property OF the profile shape, not a substitute for it (MOB-HIGH-019).
    return query.data.map((member) => ({
      ...member,
      user: member.user ? { ...member.user, isOnline: onlineUserIds.has(member.userId) } : null,
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
