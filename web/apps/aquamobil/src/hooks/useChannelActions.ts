// ============================================================================
// useChannelActions — Channel management mutations (leave, archive, notifications)
// ============================================================================

/**
 * WHY: Provides imperative channel management actions as mutations. Separates
 * data-fetching (useChannelDetail) from side-effects (leave, archive, update
 * notification preferences). Each action invalidates the relevant cache keys
 * on success.
 *
 * @param channelId - The channel to manage. Pass undefined to disable.
 * @returns updateNotificationPref — change notification preference
 * @returns leaveChannel — leave the channel (removes current user)
 * @returns archiveChannel — archive/delete the channel (owner only)
 * @returns isLoading — true while any mutation is in flight
 */

import { useCallback, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from './useAuth';
import { graphqlRequest } from '@/services/authenticated-fetch';
import {
  UPDATE_NOTIFICATION_PREFERENCE,
  REMOVE_CHANNEL_MEMBER,
  ARCHIVE_CHANNEL,
  ADD_CHANNEL_MEMBER,
} from '@/graphql/messaging-operations';
import type { NotificationPreference, ChannelMemberRole } from '@/types/messaging';

/**
 * Channel management actions hook.
 *
 * @param channelId - Target channel UUID. Pass undefined to disable.
 */
export function useChannelActions(channelId: string | undefined) {
  const { user, isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  const [error, setError] = useState<Error | null>(null);

  const notifMutation = useMutation({
    mutationFn: async (preference: NotificationPreference) => {
      await graphqlRequest(UPDATE_NOTIFICATION_PREFERENCE, {
        channelId,
        preference,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['messaging', 'channel', channelId],
      });
      queryClient.invalidateQueries({
        queryKey: ['messaging', 'channels'],
      });
      setError(null);
    },
    onError: (err: Error) => setError(err),
  });

  const leaveMutation = useMutation({
    mutationFn: async () => {
      if (!user?.id) throw new Error('Not authenticated');
      await graphqlRequest(REMOVE_CHANNEL_MEMBER, {
        channelId,
        userId: user.id,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['messaging', 'channels'],
      });
      queryClient.removeQueries({
        queryKey: ['messaging', 'channel', channelId],
      });
      setError(null);
    },
    onError: (err: Error) => setError(err),
  });

  const archiveMutation = useMutation({
    mutationFn: async () => {
      await graphqlRequest(ARCHIVE_CHANNEL, { id: channelId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['messaging', 'channels'],
      });
      queryClient.removeQueries({
        queryKey: ['messaging', 'channel', channelId],
      });
      setError(null);
    },
    onError: (err: Error) => setError(err),
  });

  const addMemberMutation = useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role?: ChannelMemberRole }) => {
      await graphqlRequest(ADD_CHANNEL_MEMBER, {
        channelId,
        userId,
        role: role ?? 'member',
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['messaging', 'channel', channelId],
      });
      queryClient.invalidateQueries({
        queryKey: ['messaging', 'channels'],
      });
      setError(null);
    },
    onError: (err: Error) => setError(err),
  });

  /**
   * Update the notification preference for this channel.
   *
   * @param pref - New notification preference ('all' | 'mentions' | 'none')
   */
  const updateNotificationPref = useCallback(
    async (pref: NotificationPreference) => {
      if (!isAuthenticated || !channelId) return;
      await notifMutation.mutateAsync(pref);
    },
    [isAuthenticated, channelId, notifMutation],
  );

  /**
   * Leave the channel (removes current user from membership).
   */
  const leaveChannel = useCallback(async () => {
    if (!isAuthenticated || !channelId) return;
    await leaveMutation.mutateAsync();
  }, [isAuthenticated, channelId, leaveMutation]);

  /**
   * Archive (soft-delete) the channel. Owner-only action.
   */
  const archiveChannel = useCallback(async () => {
    if (!isAuthenticated || !channelId) return;
    await archiveMutation.mutateAsync();
  }, [isAuthenticated, channelId, archiveMutation]);

  /**
   * Add a member to the channel.
   *
   * @param userId - User UUID to add
   * @param role - Optional role (defaults to 'member')
   */
  const addMember = useCallback(
    async (userId: string, role?: ChannelMemberRole) => {
      if (!isAuthenticated || !channelId) return;
      await addMemberMutation.mutateAsync({ userId, role });
    },
    [isAuthenticated, channelId, addMemberMutation],
  );

  return {
    updateNotificationPref,
    leaveChannel,
    archiveChannel,
    addMember,
    isLoading:
      notifMutation.isPending ||
      leaveMutation.isPending ||
      archiveMutation.isPending ||
      addMemberMutation.isPending,
    error,
  };
}
