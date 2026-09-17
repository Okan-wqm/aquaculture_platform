/**
 * Panel messaging data hooks — channels, messages, send, mark-read.
 *
 * Uses the useTenantQuery / useTenantMutation SSoT (tenant-scoped keys +
 * invalidation) + the shared graphqlClient. Channels + messages are per-tenant.
 *
 * FAZ 1: sendMessage is OPTIMISTIC (temp message → rollback on error, replace
 * + id-dedupe on success, including idempotent replays where the server
 * returns the PREVIOUS message) and carries a caller-computed idempotencyKey
 * so react-query retries stay at-most-once. markMessagesRead optimistically
 * zeroes the active channel's unread badge and snaps to server truth on
 * success.
 */
import {
  useTenantQuery,
  useTenantMutation,
  graphqlClient,
  useAuth,
  createTenantInvalidationKey,
} from '@aquaculture/shared-ui';
import type { UseQueryResult, UseMutationResult } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';

import {
  MY_CHANNELS_QUERY,
  CHANNEL_MESSAGES_QUERY,
  SEND_MESSAGE_MUTATION,
  MARK_MESSAGES_READ_MUTATION,
} from '../graphql/messaging-operations';
import { releaseIdempotencyKey } from '../lib/messageIdempotency';
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
interface MarkMessagesReadResult {
  markMessagesRead: boolean;
}

/**
 * Channel-list polling: a lightweight liveness backstop while the socket only
 * joins the ACTIVE channel (FAZ 3.2 decides the list-level socket story).
 * 60s, foreground-only — cheap enough not to matter, fresh enough to move
 * last-message previews and unread badges of non-open channels.
 */
const CHANNELS_REFETCH_INTERVAL_MS = 60_000;

export function useChannels(): UseQueryResult<Channel[], Error> {
  return useTenantQuery<Channel[]>(
    ['messaging', 'channels'],
    async () => {
      const data = await graphqlClient.request<MyChannelsResult>(MY_CHANNELS_QUERY, {
        filter: { limit: 100, offset: 0 },
      });
      return data.myChannels.items;
    },
    {
      refetchInterval: CHANNELS_REFETCH_INTERVAL_MS,
      refetchIntervalInBackground: false,
    },
  );
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

/** One logical send: the content plus the at-most-once idempotency key. */
export interface SendMessageVariables {
  content: string;
  idempotencyKey: string;
}

/** Per-mutation cache context for rollback / temp-row replacement. */
interface SendMutationContext {
  previousThreads: Array<[readonly unknown[], Message[] | undefined]>;
  tempId: string;
}

/**
 * Append the optimistic row to a thread snapshot. The thread renders
 * oldest-first, so the pending message goes LAST; `senderId: myId` is what the
 * row's "mine" styling keys on (sender sub-object is only read for others).
 */
function withOptimisticMessage(
  thread: Message[],
  channelId: string,
  variables: SendMessageVariables,
  myId: string | undefined,
  tempId: string,
): Message[] {
  const optimistic: Message = {
    id: tempId,
    channelId,
    senderId: myId ?? 'me',
    content: variables.content,
    contentType: 'TEXT',
    isDeleted: false,
    isAiGenerated: false,
    createdAt: new Date().toISOString(),
    editedAt: null,
    sender: null,
  };
  return [...thread, optimistic];
}

/**
 * Replace the temp row with the server's message, deduping by id: an
 * idempotent REPLAY returns the previously created message, which may already
 * be in the thread (socket echo / prior send) — filtering both ids before the
 * append guarantees it appears exactly once.
 */
function withServerMessage(thread: Message[], tempId: string, real: Message): Message[] {
  return [...thread.filter((m) => m.id !== tempId && m.id !== real.id), real];
}

export function useSendMessage(
  channelId: string | undefined,
): UseMutationResult<Message, Error, SendMessageVariables> {
  const { tenantId, user } = useAuth();
  const myId = user?.id;
  const queryClient = useQueryClient();

  return useTenantMutation<Message, Error, SendMessageVariables>(
    async (variables) => {
      const data = await graphqlClient.request<SendMessageResult>(SEND_MESSAGE_MUTATION, {
        input: {
          channelId,
          content: variables.content,
          contentType: 'TEXT',
          idempotencyKey: variables.idempotencyKey,
        },
      });
      return data.sendMessage;
    },
    {
      // Refetch the thread + the channel list (last-message/unread) after sending.
      invalidate: [['messaging', 'messages', channelId ?? ''], ['messaging', 'channels']],
      // NOTE: the queryKey expressions below inline createTenantInvalidationKey
      // (epoch-less prefix, matching the invalidation RULE) — the repo's
      // no-bare-tenant-query-key lint gate requires the factory call inline.
      onMutate: async (variables) => {
        // Stop in-flight thread refetches so they cannot clobber the temp row.
        await queryClient.cancelQueries({
          queryKey: createTenantInvalidationKey(tenantId, 'messaging', 'messages', channelId ?? ''),
        });
        const tempId = `temp-${variables.idempotencyKey}`;
        // Snapshot BEFORE writing: setQueriesData returns the UPDATED values,
        // not the previous ones — the rollback source must be getQueriesData.
        const previousThreads = queryClient.getQueriesData<Message[] | undefined>({
          queryKey: createTenantInvalidationKey(tenantId, 'messaging', 'messages', channelId ?? ''),
        });
        queryClient.setQueriesData<Message[] | undefined>(
          { queryKey: createTenantInvalidationKey(tenantId, 'messaging', 'messages', channelId ?? '') },
          (old) => (old ? withOptimisticMessage(old, channelId ?? '', variables, myId, tempId) : old),
        );
        return { previousThreads, tempId } satisfies SendMutationContext;
      },
      onError: (_error, _variables, context) => {
        // Roll the thread back so the failed send does not linger as a
        // delivered-looking bubble; the page surfaces the error banner.
        // (useTenantMutation's SSoT signature does not carry TContext, so the
        // onMutate-built context is narrowed here — the shape is ours.)
        const ctx = context as SendMutationContext | undefined;
        for (const [key, previous] of ctx?.previousThreads ?? []) {
          queryClient.setQueryData(key, previous);
        }
        // V1 MAJOR-2: a socket-driven refetch may have landed while the send
        // was in flight; the snapshot rollback above wipes those rows out of
        // the cache, and useTenantMutation only auto-invalidates on success —
        // without this the wiped messages stay invisible until the next
        // unrelated event. Re-invalidate so the thread converges on server
        // truth immediately.
        void queryClient.invalidateQueries({
          queryKey: createTenantInvalidationKey(tenantId, 'messaging', 'messages', channelId ?? ''),
        });
        void queryClient.invalidateQueries({
          queryKey: createTenantInvalidationKey(tenantId, 'messaging', 'channels'),
        });
      },
      onSuccess: (realMessage, variables, context) => {
        // V1 MAJOR-1: the send SUCCEEDED — release the memoised key so an
        // identical text sent again ("ok", "+1") becomes a NEW logical send.
        // Failure paths intentionally keep the memo (retry/reload dedupe).
        releaseIdempotencyKey(channelId ?? '', variables.content);
        const ctx = context as SendMutationContext | undefined;
        if (!ctx) return;
        queryClient.setQueriesData<Message[] | undefined>(
          { queryKey: createTenantInvalidationKey(tenantId, 'messaging', 'messages', channelId ?? '') },
          (old) => (old ? withServerMessage(old, ctx.tempId, realMessage) : old),
        );
      },
    },
  );
}

/** Per-mutation cache context for the unread rollback. */
interface MarkReadContext {
  previousChannels: Array<[readonly unknown[], Channel[] | undefined]>;
}

export function useMarkMessagesRead(
  channelId: string | undefined,
): UseMutationResult<boolean, Error, string> {
  const { tenantId } = useAuth();
  const queryClient = useQueryClient();

  return useTenantMutation<boolean, Error, string>(
    async (messageId: string) => {
      const data = await graphqlClient.request<MarkMessagesReadResult>(
        MARK_MESSAGES_READ_MUTATION,
        { input: { channelId, messageId } },
      );
      return data.markMessagesRead;
    },
    {
      // Snap the optimistic zero to the server's unread truth.
      invalidate: [['messaging', 'channels']],
      // (queryKey expressions inline createTenantInvalidationKey — the
      // no-bare-tenant-query-key lint gate requires the factory call inline.)
      onMutate: () => {
        // Optimistic unread: the caller is LOOKING at this channel, so its
        // badge drops immediately; only THIS channel is touched. Snapshot
        // first — setQueriesData returns updated values, not previous ones.
        const previousChannels = queryClient.getQueriesData<Channel[] | undefined>({
          queryKey: createTenantInvalidationKey(tenantId, 'messaging', 'channels'),
        });
        queryClient.setQueriesData<Channel[] | undefined>(
          { queryKey: createTenantInvalidationKey(tenantId, 'messaging', 'channels') },
          (old) =>
            old
              ? old.map((channel) =>
                  channel.id === channelId ? { ...channel, unreadCount: 0 } : channel,
                )
              : old,
        );
        return { previousChannels } satisfies MarkReadContext;
      },
      onError: (_error, _variables, context) => {
        // (context narrowed — see useSendMessage's onError note)
        const ctx = context as MarkReadContext | undefined;
        for (const [key, previous] of ctx?.previousChannels ?? []) {
          queryClient.setQueryData(key, previous);
        }
        // Same convergence concern as useSendMessage's onError: a rollback
        // can wipe newer socket-driven channel data — re-invalidate.
        void queryClient.invalidateQueries({
          queryKey: createTenantInvalidationKey(tenantId, 'messaging', 'channels'),
        });
      },
    },
  );
}
