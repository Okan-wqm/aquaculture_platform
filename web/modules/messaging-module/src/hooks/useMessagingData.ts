/**
 * Panel messaging data hooks — channels, messages, send.
 *
 * Uses the useTenantQuery / useTenantMutation SSoT (tenant-scoped keys +
 * invalidation) + the shared graphqlClient. Channels + messages are per-tenant.
 */
import {
  useTenantQuery,
  useTenantMutation,
  graphqlClient,
} from '@aquaculture/shared-ui';
import type { UseQueryResult, UseMutationResult } from '@tanstack/react-query';

import {
  MY_CHANNELS_QUERY,
  CHANNEL_MESSAGES_QUERY,
  SEND_MESSAGE_MUTATION,
} from '../graphql/messaging-operations';
import type { Channel, Message } from '../types/messaging';

interface MyChannelsResult {
  myChannels: { total: number; items: Channel[] };
}
interface ChannelMessagesResult {
  messages: { hasMore: boolean; cursor: string | null; items: Message[] };
}
interface SendMessageResult {
  sendMessage: Message;
}

export function useChannels(): UseQueryResult<Channel[], Error> {
  return useTenantQuery<Channel[]>(['messaging', 'channels'], async () => {
    const data = await graphqlClient.request<MyChannelsResult>(MY_CHANNELS_QUERY, {
      filter: { limit: 100, offset: 0 },
    });
    return data.myChannels.items;
  });
}

export function useChannelMessages(
  channelId: string | undefined,
): UseQueryResult<Message[], Error> {
  return useTenantQuery<Message[]>(
    ['messaging', 'messages', channelId ?? ''],
    async () => {
      const data = await graphqlClient.request<ChannelMessagesResult>(
        CHANNEL_MESSAGES_QUERY,
        { channelId, filter: { limit: 50 } },
      );
      // The subgraph returns newest-first; render oldest-first.
      return [...data.messages.items].reverse();
    },
    { enabled: !!channelId },
  );
}

export function useSendMessage(
  channelId: string | undefined,
): UseMutationResult<Message, Error, string> {
  return useTenantMutation<Message, Error, string>(
    async (content: string) => {
      const data = await graphqlClient.request<SendMessageResult>(SEND_MESSAGE_MUTATION, {
        input: { channelId, content, contentType: 'TEXT' },
      });
      return data.sendMessage;
    },
    // Refetch the thread + the channel list (last-message/unread) after sending.
    { invalidate: [['messaging', 'messages', channelId ?? ''], ['messaging', 'channels']] },
  );
}
