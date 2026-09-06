// ============================================================================
// useMessageSocket — Socket.IO connection manager for /messaging namespace
// ============================================================================

/**
 * WHY: Manages the Socket.IO connection to the /messaging namespace for
 * real-time message delivery, typing indicators, presence updates, and
 * read receipts. Uses JWT token in the auth handshake and supports
 * reconnection with exponential backoff. Provides imperative methods
 * for joining/leaving channel rooms and emitting typing/read events.
 *
 * @returns isConnected — whether the socket is currently connected
 * @returns joinChannel — join a channel room to receive its events
 * @returns leaveChannel — leave a channel room
 * @returns emitTyping — emit a typing indicator event
 * @returns socketRef — ref to the underlying socket instance for use by other hooks
 *
 * Read receipts are NOT emitted over the socket: the server `markRead` socket
 * handler was a ghost (persisted nothing, broadcast a fabricated receipt) and
 * was removed (Wave-6 G1). Read state is advanced exclusively through the
 * `markMessagesRead` GraphQL mutation (see `useMarkRead`).
 */

import { useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';

import { useAuth } from './useAuth';

import { ALL_MESSAGES_SINCE } from '@/graphql/messaging-operations';
import { graphqlRequest } from '@/services/authenticated-fetch';
import type {
  AllMessagesSinceResponse,
  NewMessageEvent,
  MessageUpdatedEvent,
  MessageDeletedEvent,
  ReadReceiptEvent,
  Message,
  MessagePage,
  ChannelMember,
  ChannelPage,
} from '@/types/messaging';
import { messagesQueryKey } from '@/utils/messaging-query-keys';
import { createTenantQueryKey } from '@/utils/tenant-query-keys';

/** Shape of the per-channel infinite-message-list react-query cache entry. */
type MessagesQueryData = {
  pages: MessagePage[];
  pageParams: (string | null)[];
};

/** Page size for draining the multi-channel reconnect delta. */
const RECONNECT_SYNC_PAGE_LIMIT = 100;

/**
 * Upsert a single message into a channel's infinite-query cache: replace it in
 * place on the newest page if already present (an optimistic/echo dup),
 * otherwise append it to the newest page. Shared by the live `newMessage`
 * socket handler and the M3 reconnect reconciliation so both paths mutate the
 * cache identically (single source of truth for cache shape).
 */
function upsertMessageIntoChannelCache(
  qc: QueryClient,
  tenantId: string,
  userId: string | null | undefined,
  channelId: string,
  message: Message,
): void {
  qc.setQueryData(
    // MSG-CRITICAL-055: the SAME key the reader (useMessages) reads, incl. the
    // user.id segment. `userId` is a required parameter of this helper, so the
    // live + reconnect callers below cannot silently drop it (tier-1).
    messagesQueryKey(tenantId, userId, channelId),
    (old: MessagesQueryData | undefined): MessagesQueryData | undefined => {
      if (!old?.pages?.length) return old;
      const firstPage = old.pages[0];
      if (!firstPage) return old;
      const exists = firstPage.items.some((m: Message) => m.id === message.id);
      if (exists) {
        return {
          ...old,
          pages: old.pages.map((page: MessagePage, i: number) =>
            i === 0
              ? {
                  ...page,
                  items: page.items.map((m: Message) =>
                    m.id === message.id ? message : m,
                  ),
                }
              : page,
          ),
        };
      }
      return {
        ...old,
        pages: [
          { ...firstPage, items: [...firstPage.items, message] },
          ...old.pages.slice(1),
        ],
      };
    },
  );
}


/**
 * WHY (MSG-MEDIUM-052, WS-half): the live WS envelope carries `sender: { id }`
 * only — the gateway never broadcasts display PII to channel members (no-PII
 * oracle; `getMessageForBroadcast` returns `sender:{id}` exclusively). The client
 * enriches the sender's display fields from the channelMembers cache, which IS
 * authorized to hold them (federation-resolved firstName/lastName/profileImageUrl
 * via GET_CHANNEL → CHANNEL_FIELDS.members.user). Without this, a live message —
 * and a live edit, whose `messageUpdated` handler spreads the WS sender over the
 * cached one — renders "Unknown" until the next GraphQL refetch.
 *
 * No-op when the message already carries a display name (a GraphQL-fetched M3
 * reconnect message, whose sender is federation-resolved) or when the member is
 * not in cache (channel never opened) — the message still renders, and the
 * eventual GraphQL fetch supplies the name. This keeps the WS path PII-free while
 * making live names correct: the display name is decoupled from the wire payload.
 */
function enrichSenderFromMembers(
  qc: QueryClient,
  tenantId: string,
  channelId: string,
  message: Message,
): Message {
  if (message.sender?.firstName || message.sender?.lastName) {
    return message;
  }
  const members = qc.getQueryData<ChannelMember[]>(
    createTenantQueryKey(tenantId, 'messaging', 'channelMembers', channelId, tenantId),
  );
  const member = members?.find((m) => m.userId === message.senderId);
  if (!member?.user) return message;
  return { ...message, sender: { ...member.user, id: message.senderId } };
}

// WHY: io is dynamically imported from socket.io-client. If the package is not
// installed, the hook gracefully degrades to a disconnected state. The import
// is lazy to avoid blocking initial bundle load for users who haven't activated
// the messaging feature.
type SocketInstance = {
  connected: boolean;
  connect: () => void;
  disconnect: () => void;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  off: (event: string, handler: (...args: unknown[]) => void) => void;
  emit: (event: string, ...args: unknown[]) => void;
  auth: Record<string, unknown>;
};

let ioFactory: ((url: string, opts: Record<string, unknown>) => SocketInstance) | null = null;

export interface ResolvedNotificationRef {
  channelId: string;
  messageId: string;
  messageCreatedAt: string;
}

interface ResolveNotificationRefAck extends Partial<ResolvedNotificationRef> {
  success: boolean;
  reason?: string;
}

interface UseMessageSocketResult {
  isConnected: boolean;
  joinChannel: (channelId: string) => void;
  leaveChannel: (channelId: string) => void;
  emitTyping: (channelId: string, isTyping: boolean) => void;
  resolveNotificationRef: (
    notificationRef: string,
  ) => Promise<ResolvedNotificationRef | null>;
  socketRef: MutableRefObject<SocketInstance | null>;
}

const NOTIFICATION_REF_TIMEOUT_MS = 5_000;

async function getIo(): Promise<typeof ioFactory> {
  if (ioFactory) return ioFactory;
  try {
    const mod = await import('socket.io-client');
    ioFactory = mod.io as unknown as typeof ioFactory;
    return ioFactory;
  } catch {
    return null;
  }
}

/** joinChannel ack-retry bounds (MSG-HIGH-065). */
const JOIN_ACK_MAX_RETRIES = 3;
const JOIN_ACK_RETRY_BASE_MS = 500;

type JoinChannelAck = { success?: boolean; reason?: string } | undefined;

/**
 * Emit `joinChannel` and CONSUME the server ack (MSG-HIGH-065).
 *
 * `joinChannel` was fire-and-forget: the gateway returns `{success:false}` when a
 * NATS membership-verify times out (or the user genuinely is not a member) and
 * does NOT add the socket to the channel room, but the client discarded that ack,
 * kept the channel in its "joined" set, and showed a connected socket receiving
 * ZERO live events for that channel with no error — a flaky NATS window could
 * leave whole channels permanently live-dead. Now the ack is consumed: a
 * confirmed join is a no-op; an unconfirmed one is retried with bounded backoff,
 * and on exhaustion the channel is dropped from the intent set so the client
 * stops implying live delivery for a room it never entered.
 */
function emitJoinChannelWithAck(
  socket: SocketInstance,
  channelId: string,
  joinedChannels: Set<string>,
  attempt = 0,
): void {
  socket.emit('joinChannel', { channelId }, (ack: JoinChannelAck) => {
    if (ack?.success) return;
    if (attempt < JOIN_ACK_MAX_RETRIES && joinedChannels.has(channelId)) {
      const delay = JOIN_ACK_RETRY_BASE_MS * 2 ** attempt;
      setTimeout(() => {
        if (socket.connected && joinedChannels.has(channelId)) {
          emitJoinChannelWithAck(socket, channelId, joinedChannels, attempt + 1);
        }
      }, delay);
    } else {
      joinedChannels.delete(channelId);
    }
  });
}

/**
 * The newest SERVER-authoritative message timestamp the client already holds —
 * the max `lastMessage.createdAt` across every cached channel-list page. Used to
 * seed the reconnect watermark from server truth instead of the client clock
 * (MSG-HIGH-064): a skewed local clock otherwise makes the next reconnect's
 * `allMessagesSince(since)` skip messages whose server createdAt falls in the skew
 * window. Returns null when no channel has a lastMessage (nothing to reconcile).
 */
function newestServerCreatedAt(qc: QueryClient, tenantId: string): string | null {
  const entries = qc.getQueriesData<ChannelPage>({
    queryKey: createTenantQueryKey(tenantId, 'messaging', 'channels'),
  });
  let newest: string | null = null;
  for (const [, page] of entries) {
    for (const channel of page?.items ?? []) {
      const ts = channel.lastMessage?.createdAt;
      if (ts && (!newest || ts > newest)) {
        newest = ts;
      }
    }
  }
  return newest;
}

export function useMessageSocket(): UseMessageSocketResult {
  const { accessToken, isAuthenticated, tenantId, user, refreshAuth } = useAuth();
  const queryClient = useQueryClient();
  const [isConnected, setIsConnected] = useState(false);
  const socketRef = useRef<SocketInstance | null>(null);
  const joinedChannelsRef = useRef<Set<string>>(new Set());
  // MSG-CRITICAL-055: the message cache key is user-scoped (MT-CRITICAL-051), so
  // every socket cache write must carry the current user.id. Held in a ref —
  // mirroring queryClientRef/accessTokenRef — so the socket-lifecycle effect
  // stays keyed on auth identity and never re-subscribes just to see a new id.
  const userIdRef = useRef<string | null | undefined>(user?.id);
  userIdRef.current = user?.id;
  // WHY: Ref tracks the latest accessToken for use inside the reAuth callback.
  // refreshAuth() updates React state, but the callback needs the new token
  // in the same tick without waiting for a re-render.
  const accessTokenRef = useRef(accessToken);
  accessTokenRef.current = accessToken;
  const queryClientRef = useRef(queryClient);
  queryClientRef.current = queryClient;
  const refreshAuthRef = useRef(refreshAuth);
  refreshAuthRef.current = refreshAuth;

  // M3 reconnect reconciliation state. lastSyncAtRef is the watermark of the
  // newest message we are known to be in sync with; on reconnect we fetch the
  // multi-channel delta since this point. hasConnectedRef distinguishes the
  // first connect (no gap — initial queries already loaded fresh state) from a
  // reconnect. isReconcilingRef guards against overlapping reconciliations.
  const lastSyncAtRef = useRef<string | null>(null);
  const hasConnectedRef = useRef(false);
  const isReconcilingRef = useRef(false);

  // ------------------------------------------------------------------
  // Reconnect reconciliation (M3): fetch the messages that arrived while the
  // socket was down and converge caches + badges on server truth.
  // ------------------------------------------------------------------
  const reconcileMissedMessages = useCallback(
    async (since: string): Promise<void> => {
      const tid = tenantId;
      if (!tid || isReconcilingRef.current) return;
      isReconcilingRef.current = true;
      const qc = queryClientRef.current;
      try {
        let cursor: string | null = null;
        const touchedChannels = new Set<string>();
        // Track the newest SERVER createdAt we actually fetched, so the watermark
        // advances on server truth, never the client clock (MSG-HIGH-064).
        let maxCreatedAt: string | null = null;
        // Drain the delta in pages so a long offline window can't silently
        // drop messages past a single page limit.
        for (;;) {
          const response = await graphqlRequest(ALL_MESSAGES_SINCE, {
            since,
            limit: RECONNECT_SYNC_PAGE_LIMIT,
            syncToken: cursor,
          });
          const page: AllMessagesSinceResponse = response.allMessagesSince;
          for (const message of page.messages) {
            touchedChannels.add(message.channelId);
            upsertMessageIntoChannelCache(qc, tid, userIdRef.current, message.channelId, message);
            // ISO-8601 timestamps compare chronologically as strings.
            if (!maxCreatedAt || message.createdAt > maxCreatedAt) {
              maxCreatedAt = message.createdAt;
            }
          }
          if (!page.hasMore || !page.syncToken) break;
          cursor = page.syncToken;
        }
        if (touchedChannels.size > 0) {
          // Reconcile badges (channel list lastMessage/unread + global unread)
          // to authoritative server state, mirroring the live newMessage path.
          await Promise.all([
            qc.invalidateQueries({
              queryKey: createTenantQueryKey(tid, 'messaging', 'channels'),
            }),
            qc.invalidateQueries({
              queryKey: createTenantQueryKey(tid, 'messaging', 'unreadCount'),
            }),
          ]);
        }
        // MSG-HIGH-064: advance the watermark to the newest fetched message's
        // SERVER createdAt — not `new Date()` (client clock). On an empty delta,
        // keep the prior watermark so the next reconnect retries from the same
        // point instead of jumping the window forward on a skewed local clock.
        if (maxCreatedAt) {
          lastSyncAtRef.current = maxCreatedAt;
        }
      } catch {
        // Reconciliation failed (server/network). The live newMessage stream is
        // already restored and lastSyncAtRef is unchanged, so the NEXT reconnect
        // retries the delta from the same watermark — nothing is lost.
      } finally {
        isReconcilingRef.current = false;
      }
    },
    [tenantId],
  );
  // Hold the latest reconcile callback in a ref so the connect handler (inside
  // the lifecycle effect, which intentionally depends only on auth identity)
  // always calls the current version without re-subscribing the socket.
  const reconcileRef = useRef(reconcileMissedMessages);
  reconcileRef.current = reconcileMissedMessages;

  // ------------------------------------------------------------------
  // Connect / disconnect lifecycle
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!isAuthenticated || !accessToken || !tenantId) {
      // Disconnect if we lose auth
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
        setIsConnected(false);
      }
      return;
    }

    let mounted = true;
    let socket: SocketInstance | null = null;

    const connect = async (): Promise<void> => {
      const io = await getIo();
      if (!io || !mounted) return;

      const nextSocket = io('/messaging', {
        auth: { token: accessToken },
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 30000,
        // Bounded, not Infinity: during a full gateway outage (502) an unbounded
        // retry storms the dead upstream forever. ~20 attempts at up to 30s backoff
        // covers transient blips without amplifying an outage.
        reconnectionAttempts: 20,
        forceNew: false,
      });

      socket = nextSocket;
      socketRef.current = nextSocket;

      // --- Connection events ---
      nextSocket.on('connect', () => {
        if (!mounted) return;
        setIsConnected(true);
        // Rejoin all previously joined channels — ack-confirmed (MSG-HIGH-065).
        // Snapshot the set: the ack callback may delete from it on exhaustion.
        for (const channelId of [...joinedChannelsRef.current]) {
          emitJoinChannelWithAck(nextSocket, channelId, joinedChannelsRef.current);
        }
        // M3 / MSG-HIGH-064: watermark is always SERVER-authoritative, never the
        // client clock.
        if (hasConnectedRef.current) {
          // RECONNECT: reconcile the gap. Use the tracked watermark, or — if no
          // live message advanced it since first connect — derive it from server
          // truth (newest cached message createdAt).
          const since = lastSyncAtRef.current ?? newestServerCreatedAt(queryClientRef.current, tenantId);
          if (since) {
            void reconcileRef.current(since);
          }
        } else {
          // FIRST connect: initial queries already loaded fresh state — seed the
          // watermark from server truth (newest cached message createdAt) so the
          // next reconnect's delta cannot be skewed by a fast/slow local clock.
          lastSyncAtRef.current = newestServerCreatedAt(queryClientRef.current, tenantId);
        }
        hasConnectedRef.current = true;
      });

      nextSocket.on('disconnect', () => {
        if (mounted) setIsConnected(false);
      });

      // --- Domain events ---

      nextSocket.on('newMessage', (data: unknown) => {
        const event = data as NewMessageEvent;
        const qc = queryClientRef.current;
        // Update messages cache for this channel — shared upsert, identical to
        // the M3 reconnect reconciliation path. Enrich the id-only WS sender
        // from the channelMembers cache first (no-PII oracle; MSG-MEDIUM-052).
        const incoming = enrichSenderFromMembers(qc, tenantId, event.channelId, event.message);
        upsertMessageIntoChannelCache(qc, tenantId, userIdRef.current, event.channelId, incoming);
        // Invalidate channel list to update lastMessage / unread counts
        void qc.invalidateQueries({ queryKey: createTenantQueryKey(tenantId, 'messaging', 'channels') });
        // Increment unread count
        void qc.invalidateQueries({ queryKey: createTenantQueryKey(tenantId, 'messaging', 'unreadCount') });
        // FE-MEDIUM-053: nudge the in-app notification bell in the SAME tick so the
        // bell and the message badge converge on one cadence instead of drifting
        // up to ~5 minutes apart.
        void qc.invalidateQueries({ queryKey: createTenantQueryKey(tenantId, 'notifications', 'unreadCount') });
        // M3: advance the reconnect watermark to the newest message we've seen
        // so a later reconnect fetches a tight delta (ISO-8601 timestamps
        // compare chronologically as strings).
        const ts = event.message.createdAt;
        if (!lastSyncAtRef.current || ts > lastSyncAtRef.current) {
          lastSyncAtRef.current = ts;
        }
      });

      nextSocket.on('messageUpdated', (data: unknown) => {
        const event = data as MessageUpdatedEvent;
        const qc = queryClientRef.current;
        // The WS edit envelope carries sender:{id}; enrich it before the spread
        // below, otherwise `{ ...m, ...incoming }` would overwrite the cached
        // message's federation-resolved sender with the id-only one and the name
        // would vanish on every edit (no-PII oracle; MSG-MEDIUM-052).
        const incoming = enrichSenderFromMembers(qc, tenantId, event.channelId, event.message);
        qc.setQueryData(
          messagesQueryKey(tenantId, userIdRef.current, event.channelId),
          (old: { pages: MessagePage[]; pageParams: (string | null)[] } | undefined) => {
            if (!old?.pages) return old;
            return {
              ...old,
              pages: old.pages.map((page: MessagePage) => ({
                ...page,
                items: page.items.map((m: Message) =>
                  m.id === incoming.id ? { ...m, ...incoming } : m,
                ),
              })),
            };
          },
        );
      });

      nextSocket.on('messageDeleted', (data: unknown) => {
        const event = data as MessageDeletedEvent;
        queryClientRef.current.setQueryData(
          messagesQueryKey(tenantId, userIdRef.current, event.channelId),
          (old: { pages: MessagePage[]; pageParams: (string | null)[] } | undefined) => {
            if (!old?.pages) return old;
            return {
              ...old,
              pages: old.pages.map((page: MessagePage) => ({
                ...page,
                items: page.items.map((m: Message) =>
                  m.id === event.messageId ? { ...m, isDeleted: true, content: null } : m,
                ),
              })),
            };
          },
        );
      });

      nextSocket.on('readReceipt', (data: unknown) => {
        const event = data as ReadReceiptEvent;
        const qc = queryClientRef.current;
        // Invalidate unread count
        void qc.invalidateQueries({ queryKey: createTenantQueryKey(tenantId, 'messaging', 'unreadCount') });
        // FE-MEDIUM-053: converge the in-app notification bell on the same tick.
        void qc.invalidateQueries({ queryKey: createTenantQueryKey(tenantId, 'notifications', 'unreadCount') });
        // Update receipt in message cache
        qc.setQueryData(
          messagesQueryKey(tenantId, userIdRef.current, event.channelId),
          (old: { pages: MessagePage[]; pageParams: (string | null)[] } | undefined) => {
            if (!old?.pages) return old;
            return {
              ...old,
              pages: old.pages.map((page: MessagePage) => ({
                ...page,
                items: page.items.map((m: Message) => {
                  if (m.id !== event.messageId) return m;
                  const existingReceipts = m.receipts ?? [];
                  const updated = existingReceipts.map((r) =>
                    r.userId === event.userId
                      ? { ...r, status: 'read' as const, readAt: event.readAt }
                      : r,
                  );
                  const hasUser = existingReceipts.some((r) => r.userId === event.userId);
                  if (!hasUser) {
                    updated.push({
                      userId: event.userId,
                      status: 'read',
                      deliveredAt: event.readAt,
                      readAt: event.readAt,
                    });
                  }
                  return { ...m, receipts: updated };
                }),
              })),
            };
          },
        );
      });

      // MSG-HIGH-063: the gateway could not hydrate a live message (NATS hydration
      // timeout / empty) and would otherwise have DROPPED it with no redelivery,
      // leaving it permanently absent from the open chat. Instead it sends this
      // content-free hint; invalidate the channel's messages (+ list/badge) so a
      // refetch converges on server truth — recoverable, not lost.
      nextSocket.on('messageSyncHint', (data: unknown) => {
        const event = data as { channelId?: string };
        if (!event.channelId) return;
        const qc = queryClientRef.current;
        void qc.invalidateQueries({
          queryKey: messagesQueryKey(tenantId, userIdRef.current, event.channelId),
        });
        void qc.invalidateQueries({ queryKey: createTenantQueryKey(tenantId, 'messaging', 'channels') });
        void qc.invalidateQueries({ queryKey: createTenantQueryKey(tenantId, 'messaging', 'unreadCount') });
      });

      // MSG-HIGH-068: the current user was removed from (or left) this channel.
      // The gateway sends this to our user room AND has already removed our socket
      // from the channel room. Evict the channel's client caches so the open
      // ChatRoom stops rendering a channel we no longer belong to and the channel
      // drops out of the list — access revocation must reach the read model.
      nextSocket.on('channelMemberRemoved', (data: unknown) => {
        const event = data as { channelId?: string };
        const channelId = event.channelId;
        if (!channelId) return;
        const qc = queryClientRef.current;
        joinedChannelsRef.current.delete(channelId);
        qc.removeQueries({ queryKey: messagesQueryKey(tenantId, userIdRef.current, channelId) });
        qc.removeQueries({ queryKey: createTenantQueryKey(tenantId, 'messaging', 'channelMembers', channelId) });
        qc.removeQueries({ queryKey: createTenantQueryKey(tenantId, 'messaging', 'channel', channelId) });
        void qc.invalidateQueries({ queryKey: createTenantQueryKey(tenantId, 'messaging', 'channels') });
        void qc.invalidateQueries({ queryKey: createTenantQueryKey(tenantId, 'messaging', 'unreadCount') });
      });

      // MSG-MEDIUM-062: channel lifecycle (create / rename / member add-remove /
      // archive) rides the gateway's `channelEvent` SSoT name. The client used to
      // listen for a `channelUpdated` name the gateway never emits, so the list
      // never refreshed live on structural changes. Converge the list + this
      // channel's members/detail on server truth.
      nextSocket.on('channelEvent', (data: unknown) => {
        const event = data as { channelId?: string };
        const qc = queryClientRef.current;
        void qc.invalidateQueries({ queryKey: createTenantQueryKey(tenantId, 'messaging', 'channels') });
        if (event.channelId) {
          void qc.invalidateQueries({ queryKey: createTenantQueryKey(tenantId, 'messaging', 'channelMembers', event.channelId) });
          void qc.invalidateQueries({ queryKey: createTenantQueryKey(tenantId, 'messaging', 'channel', event.channelId) });
        }
      });

      // --- reAuth: server requests fresh token ---
      // WHY: When the server detects an expired JWT, it emits 'reAuth'.
      // refreshAuth() obtains a new token via httpOnly cookie and updates
      // React state + module-level authStore synchronously. We read the
      // new token from our accessTokenRef (updated on every render) and
      // also update socket.auth so reconnections use the fresh token.
      nextSocket.on('reAuth', () => {
        void refreshAuthRef.current().then(() => {
          const newToken = accessTokenRef.current;
          if (socketRef.current && newToken) {
            socketRef.current.auth = { token: newToken };
            socketRef.current.emit('reAuthResponse', { token: newToken });
          }
        }).catch(() => {
          // Auth refresh failed — socket will likely disconnect
        });
      });
    };

    void connect();

    return () => {
      mounted = false;
      if (socket) {
        socket.disconnect();
      }
      socketRef.current = null;
      setIsConnected(false);
    };
    // FE-MEDIUM-052: accessToken is INTENTIONALLY omitted from the dependency
    // array. A ~5-minute token rotation must NOT tear down and rebuild the socket
    // — that full disconnect/reconnect raced the in-band `reAuth` handshake and
    // dropped live delivery for a window every rotation. The socket lifecycle is
    // keyed only by AUTH IDENTITY: (isAuthenticated, tenantId). The rotated token
    // reaches the live socket via two existing paths that need no reconnect:
    //   1. accessTokenRef (updated every render, line ~205) — read at handshake
    //      AND inside the `reAuth` handler when the server requests a fresh token.
    //   2. the in-band `reAuth` handler (refreshAuthRef + socket.auth update +
    //      reAuthResponse emit) — the server-driven mid-connection re-auth.
    // The first connect still guards on `accessToken` presence, and isAuthenticated
    // only flips true once a token exists, so the initial connect always has a
    // valid token. A genuine auth loss (isAuthenticated → false) still hits the
    // early-return disconnect, and a tenant switch (tenantId change) still rebuilds
    // (room/tenant scoping must change). exhaustive-deps is configured as 'warn'
    // (non-blocking), so the intentional omission is documented HERE rather than
    // silenced with a banned lint-suppression directive.
  }, [isAuthenticated, tenantId]);

  // ------------------------------------------------------------------
  // Imperative channel room management
  // ------------------------------------------------------------------

  const joinChannel = useCallback((channelId: string) => {
    joinedChannelsRef.current.add(channelId);
    if (socketRef.current?.connected) {
      emitJoinChannelWithAck(socketRef.current, channelId, joinedChannelsRef.current);
    }
  }, []);

  const leaveChannel = useCallback((channelId: string) => {
    joinedChannelsRef.current.delete(channelId);
    if (socketRef.current?.connected) {
      socketRef.current.emit('leaveChannel', { channelId });
    }
  }, []);

  const emitTyping = useCallback((channelId: string, isTyping: boolean) => {
    if (socketRef.current?.connected) {
      socketRef.current.emit('typing', { channelId, isTyping });
    }
  }, []);

  const resolveNotificationRef = useCallback(
    (notificationRef: string): Promise<ResolvedNotificationRef | null> =>
      new Promise((resolve) => {
        const socket = socketRef.current;
        if (!socket?.connected) {
          resolve(null);
          return;
        }

        const timeoutId = window.setTimeout(() => {
          resolve(null);
        }, NOTIFICATION_REF_TIMEOUT_MS);

        socket.emit(
          'resolveNotificationRef',
          { notificationRef },
          (response: ResolveNotificationRefAck) => {
            window.clearTimeout(timeoutId);
            if (
              response?.success &&
              response.channelId &&
              response.messageId &&
              response.messageCreatedAt
            ) {
              resolve({
                channelId: response.channelId,
                messageId: response.messageId,
                messageCreatedAt: response.messageCreatedAt,
              });
              return;
            }
            resolve(null);
          },
        );
      }),
    [],
  );

  return {
    isConnected,
    joinChannel,
    leaveChannel,
    emitTyping,
    resolveNotificationRef,
    socketRef,
  };
}
