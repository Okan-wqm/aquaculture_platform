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
 *
 * FAZ 3.2 (channel-room decision): the socket joins ALL myChannels at
 * (re)connect, so the channel list is live through WS cache mutations — the
 * 60s refetchInterval backstop is REMOVED (no poll amplification).
 *
 * FAZ 3.3: useChannelMessages is an INFINITE query. Pages keep the server's
 * native order (newest-first items, pages[0] = newest window); the render
 * order (oldest-first) is established ONLY in flattenChannelMessagesPages
 * (single reversal point). No placeholderData: switching channels must not
 * render one pixel of the previous thread (bleed gate).
 */
import {
  useTenantQuery,
  useTenantMutation,
  graphqlClient,
  useAuth,
  createTenantInvalidationKey,
  createTenantQueryKey,
} from '@aquaculture/shared-ui';
import {
  useInfiniteQuery,
  useQueryClient,
  type InfiniteData,
  type UseInfiniteQueryResult,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import {
  MY_CHANNELS_QUERY,
  CHANNEL_MESSAGES_QUERY,
  SEND_MESSAGE_MUTATION,
  MARK_MESSAGES_READ_MUTATION,
} from '../graphql/messaging-operations';
import {
  insertMessageIntoPage,
  capPageItems,
  flattenChannelMessagesPages,
  type ChannelMessagesPage,
} from '../lib/messageCache';
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
 * FAZ 3.2: NO refetchInterval. Liveness of the list (unread badges,
 * last-message previews, new channels) comes from the socket — connect joins
 * every cached channel (ack-confirmed), newMessage bumps unreadCount/
 * lastMessage locally, channelEvent invalidates. A 60s poll would put a floor
 * under the request amplification the FAZ 3 acceptance caps.
 */
export function useChannels(): UseQueryResult<Channel[], Error> {
  return useTenantQuery<Channel[]>(
    ['messaging', 'channels'],
    async () => {
      const data = await graphqlClient.request<MyChannelsResult>(MY_CHANNELS_QUERY, {
        filter: { limit: 100, offset: 0 },
      });
      return data.myChannels.items;
    },
  );
}

/** Messages page size for the initial window and each older-page fetch. */
const MESSAGES_PAGE_SIZE = 50;

/**
 * Cursor-paginated thread. `getNextPageParam` rides the server cursor while
 * hasMore; the flatten helper is the ONLY place page order is reversed.
 * enable gate mirrors useTenantQuery's authenticated-tenant rule.
 */
export function useChannelMessages(
  channelId: string | undefined,
): UseInfiniteQueryResult<InfiniteData<ChannelMessagesPage, string | null>, Error> {
  const { token, tenantId } = useAuth();
  return useInfiniteQuery<
    ChannelMessagesPage,
    Error,
    InfiniteData<ChannelMessagesPage, string | null>,
    readonly unknown[],
    string | null
  >({
    // Inline factory call: the repo's no-bare-tenant-query-key lint gate
    // requires queryKey values statically traceable to the factory.
    queryKey: createTenantQueryKey(tenantId, 'messaging', 'messages', channelId ?? ''),
    queryFn: async ({ pageParam }) => {
      const data = await graphqlClient.request<ChannelMessagesResult>(
        CHANNEL_MESSAGES_QUERY,
        {
          channelId,
          filter: pageParam
            ? { limit: MESSAGES_PAGE_SIZE, cursor: pageParam }
            : { limit: MESSAGES_PAGE_SIZE },
        },
      );
      // Items stay in SERVER order (newest-first); reversal happens once, in
      // flattenChannelMessagesPages.
      return {
        items: [...data.messages.items],
        hasMore: data.messages.hasMore,
        cursor: data.messages.cursor,
      };
    },
    initialPageParam: null,
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.cursor : undefined),
    enabled: !!token && !!tenantId && !!channelId,
    // FAZ 3.3 bleed gate: NO placeholderData — a channel switch renders the
    // loading state, never the previous channel's rows.
  });
}

/** Flatten the infinite pages into the oldest-first render array (single reversal point). */
export function flattenChannelMessages(
  data: InfiniteData<ChannelMessagesPage, string | null> | undefined,
): Message[] {
  return flattenChannelMessagesPages(data?.pages);
}

/** One logical send: the content plus the at-most-once idempotency key. */
export interface SendMessageVariables {
  content: string;
  idempotencyKey: string;
}

/** Per-mutation cache context for rollback / temp-row replacement. */
interface SendMutationContext {
  previousThreads: Array<[readonly unknown[], InfiniteData<ChannelMessagesPage> | undefined]>;
  tempId: string;
}

/**
 * Append the optimistic row to the thread snapshot. Page 0 is newest-first, so
 * the pending message lands at its createdAt position (in practice: the front).
 * `senderId: myId` is what the row's "mine" styling keys on.
 */
function withOptimisticMessage(
  data: InfiniteData<ChannelMessagesPage>,
  channelId: string,
  variables: SendMessageVariables,
  myId: string | undefined,
  tempId: string,
): InfiniteData<ChannelMessagesPage> {
  const optimistic: Message = {
    id: tempId,
    channelId,
    senderId: myId ?? 'me',
    content: variables.content,
    contentType: 'TEXT',
    isDeleted: false,
    isAiGenerated: false,
    metadata: null,
    createdAt: new Date().toISOString(),
    editedAt: null,
    sender: null,
  };
  return {
    ...data,
    pages: data.pages.map((page, index) =>
      index === 0
        ? { ...page, items: capPageItems(insertMessageIntoPage(page.items, optimistic)) }
        : page,
    ),
  };
}

/**
 * Replace the temp row with the server's message, deduping by id: an
 * idempotent REPLAY returns the previously created message, which may already
 * be in the thread (socket echo / prior send) — filtering both ids on every
 * page before the page-0 insert guarantees it appears exactly once.
 */
function withServerMessage(
  data: InfiniteData<ChannelMessagesPage>,
  tempId: string,
  real: Message,
): InfiniteData<ChannelMessagesPage> {
  return {
    ...data,
    pages: data.pages.map((page, index) =>
      index === 0
        ? {
            ...page,
            items: capPageItems(
              insertMessageIntoPage(
                page.items.filter((m) => m.id !== tempId && m.id !== real.id),
                real,
              ),
            ),
          }
        : { ...page, items: page.items.filter((m) => m.id !== tempId && m.id !== real.id) },
    ),
  };
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
        const previousThreads = queryClient.getQueriesData<InfiniteData<ChannelMessagesPage> | undefined>({
          queryKey: createTenantInvalidationKey(tenantId, 'messaging', 'messages', channelId ?? ''),
        });
        queryClient.setQueriesData<InfiniteData<ChannelMessagesPage> | undefined>(
          { queryKey: createTenantInvalidationKey(tenantId, 'messaging', 'messages', channelId ?? '') },
          (old) =>
            old && old.pages.length > 0
              ? withOptimisticMessage(old, channelId ?? '', variables, myId, tempId)
              : old,
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
        queryClient.setQueriesData<InfiniteData<ChannelMessagesPage> | undefined>(
          { queryKey: createTenantInvalidationKey(tenantId, 'messaging', 'messages', channelId ?? '') },
          (old) => (old && old.pages.length > 0 ? withServerMessage(old, ctx.tempId, realMessage) : old),
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
