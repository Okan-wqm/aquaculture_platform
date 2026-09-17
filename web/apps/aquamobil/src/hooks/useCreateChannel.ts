// ============================================================================
// useCreateChannel — Channel creation mutations (DM and group)
// ============================================================================

/**
 * WHY: Provides mutations for creating new messaging channels. Supports two
 * flows: (1) getOrCreate a DM channel with another user via the DIRECT_CHANNEL
 * query, and (2) create a new group channel via the CREATE_CHANNEL mutation.
 * Both flows invalidate the channel list cache on success and return the new
 * channel ID for immediate navigation.
 *
 * @returns createDM — get-or-create a direct message channel with a user
 * @returns createGroup — create a new group channel with a name and member IDs
 * @returns isCreating — true while either mutation is in flight
 * @returns error — last mutation error, if any
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';

import { useAuth } from './useAuth';

import { DIRECT_CHANNEL, CREATE_CHANNEL } from '@/graphql/messaging-operations';
import { graphqlRequest } from '@/services/authenticated-fetch';
import type { Channel, CreateChannelInput } from '@/types/messaging';
import { toWireChannelType } from '@/utils/channel-type-wire';
import { createTenantQueryKey } from '@/utils/tenant-query-keys';

/** Return shape of {@link useCreateChannel}. */
export interface UseCreateChannelReturn {
  /** Get-or-create a direct message channel; resolves to the channel ID. */
  createDM: (userId: string) => Promise<string>;
  /** Create a group channel; resolves to the new channel ID. */
  createGroup: (name: string, memberIds: string[]) => Promise<string>;
  /** Create an AI channel; resolves to the new channel ID. */
  createAiChannel: (aiPersona?: string, name?: string) => Promise<string>;
  /** True while any creation mutation is in flight. */
  isCreating: boolean;
  /** Last mutation error, or null. */
  error: Error | null;
}

/**
 * Channel creation hook for DM and group channel flows.
 */
export function useCreateChannel(): UseCreateChannelReturn {
  const { isAuthenticated, tenantId } = useAuth();
  const queryClient = useQueryClient();
  const [error, setError] = useState<Error | null>(null);

  const dmMutation = useMutation({
    mutationFn: async (userId: string) => {
      const result = await graphqlRequest<{ directChannel: Channel }>(DIRECT_CHANNEL, { userId });
      if (!result.directChannel?.id) {
        throw new Error('Failed to create or retrieve DM channel');
      }
      return result.directChannel;
    },
    onSuccess: () => {
      // WHY void: invalidation is fire-and-forget (React Query owns the refetch).
      void queryClient.invalidateQueries({
        queryKey: createTenantQueryKey(tenantId, 'messaging', 'channels'),
      });
      setError(null);
    },
    onError: (err: Error) => {
      setError(err);
    },
  });

  const groupMutation = useMutation({
    mutationFn: async (params: { name: string; memberIds: string[] }) => {
      const input: CreateChannelInput = {
        type: toWireChannelType('group'),
        name: params.name,
        memberIds: params.memberIds,
      };
      const result = await graphqlRequest<{ createChannel: Channel }>(CREATE_CHANNEL, { input });
      if (!result.createChannel?.id) {
        throw new Error('Failed to create group channel');
      }
      return result.createChannel;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: createTenantQueryKey(tenantId, 'messaging', 'channels'),
      });
      setError(null);
    },
    onError: (err: Error) => {
      setError(err);
    },
  });

  const aiMutation = useMutation({
    mutationFn: async (params: { aiPersona?: string; name?: string }) => {
      const input: CreateChannelInput = {
        type: toWireChannelType('ai'),
        name: params.name,
        memberIds: [], // Creator auto-added on backend
        aiPersona: params.aiPersona,
      };
      const result = await graphqlRequest<{ createChannel: Channel }>(CREATE_CHANNEL, { input });
      if (!result.createChannel?.id) {
        throw new Error('Failed to create AI channel');
      }
      return result.createChannel;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: createTenantQueryKey(tenantId, 'messaging', 'channels'),
      });
      setError(null);
    },
    onError: (err: Error) => {
      setError(err);
    },
  });

  /**
   * Get or create a DM channel with another user.
   *
   * @param userId - The other user's ID
   * @returns The channel ID for navigation
   */
  const createDM = useCallback(
    async (userId: string): Promise<string> => {
      if (!isAuthenticated) throw new Error('Not authenticated');
      const channel = await dmMutation.mutateAsync(userId);
      return channel.id;
    },
    [isAuthenticated, dmMutation],
  );

  /**
   * Create a new group channel.
   *
   * @param name - The group channel name
   * @param memberIds - Array of user IDs to add as members
   * @returns The channel ID for navigation
   */
  const createGroup = useCallback(
    async (name: string, memberIds: string[]): Promise<string> => {
      if (!isAuthenticated) throw new Error('Not authenticated');
      const channel = await groupMutation.mutateAsync({ name, memberIds });
      return channel.id;
    },
    [isAuthenticated, groupMutation],
  );

  /**
   * Create a new AI channel with an optional persona.
   *
   * @param aiPersona - AI persona ID (e.g. 'expert-v1'). Omit for general assistant.
   * @param name - Optional display name for the channel
   * @returns The channel ID for navigation
   */
  const createAiChannel = useCallback(
    async (aiPersona?: string, name?: string): Promise<string> => {
      if (!isAuthenticated) throw new Error('Not authenticated');
      const channel = await aiMutation.mutateAsync({ aiPersona, name });
      return channel.id;
    },
    [isAuthenticated, aiMutation],
  );

  return {
    createDM,
    createGroup,
    createAiChannel,
    isCreating: dmMutation.isPending || groupMutation.isPending || aiMutation.isPending,
    error,
  };
}
