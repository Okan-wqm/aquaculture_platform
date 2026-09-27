/**
 * useMessagingSocket — Socket.IO client for the `/messaging` namespace.
 *
 * FAZ 3 architecture (contract: agent-workspace/ws-event-contract.md):
 *
 * CHANNEL ROOM DECISION (3.2, blocking prerequisite): the socket connects for
 * the whole authenticated messaging session (NOT only while a channel is
 * open) and joins EVERY channel of myChannels — ack-confirmed
 * (emitJoinChannelWithAck, mobile MSG-HIGH-065 pattern). The list is then
 * live through WS events alone: unread badges and last-message previews are
 * bumped by LOCAL cache mutation (no refetch), so the ChannelListPage 60s
 * poll was removed. Practical bound: ≤100 channels per tenant (myChannels
 * filter limit), each join one membership-verified room join.
 *
 * AMPLIFICATION (3.2): every event handler mutates the cache instead of
 * invalidating — newMessage merges into the active thread (enriched sender,
 * id-dedupe, comparative sort, 200-item page cap) and bumps the inactive
 * channels' unread/lastMessage; messageUpdated updates in place;
 * messageDeleted marks isDeleted; readReceipt zeroes OWN unread only. The ONE
 * exception is messageSyncHint (and channelEvent/channelMemberRemoved, which
 * are structural): invalidation stays because the wire carries no content to
 * merge — refetch IS the recovery.
 *
 * RESILIENCE (3.1): custom conditional reconnect — jittered bounded backoff
 * (≤30s, ≤20 attempts), a /health/live gate that keeps waiting while the
 * gateway is down, a hard stop on 401/4401/4403-class failures (session
 * recovery via refreshAuth instead), and a visibilitychange-triggered retry
 * (2s debounce). reAuth is answered with refreshAuth() + reAuthResponse.
 */
import {
  createTenantInvalidationKey,
  createTenantQueryKey,
  getAccessToken,
  useAuth,
  type ChannelMemberRemovedEnvelope,
  type MessageDeletedEnvelope,
  type MessageEnvelope,
  type MessageUpdatedEnvelope,
  type ReadReceiptEnvelope,
  type MessageSyncHintEnvelope,
  type SocketIoErrorEnvelope,
} from '@aquaculture/shared-ui';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';

import {
  applyIncomingMessageToChannels,
  applyMessageDeletedToChannels,
  applyMessageUpdatedToChannels,
  markMessageDeletedInPages,
  updateMessageInPages,
  upsertMessageIntoPages,
  zeroUnreadForChannel,
  type ChannelMessagesPage,
} from '../lib/messageCache';
import {
  gatewayHealthy,
  isAuthDisconnectError,
  jitteredBackoffDelay,
  HEALTH_RETRY_INTERVAL_MS,
  RECONNECT_MAX_ATTEMPTS,
  VISIBILITY_RECONNECT_DEBOUNCE_MS,
} from '../lib/socketReconnect';
import { enrichWsSenderFromChannels, projectWsMessage } from '../lib/wsProjection';
import type { Channel, Message } from '../types/messaging';

import { useChannels } from './useMessagingData';

export interface MessagingSocketState {
  /** False until the first connect and during any disconnect/connect_error gap. */
  isConnected: boolean;
}

/** joinChannel ack-retry bounds (mobile MSG-HIGH-065 pattern). */
const JOIN_ACK_MAX_RETRIES = 3;
const JOIN_ACK_RETRY_BASE_MS = 500;

type JoinChannelAck = { success?: boolean; reason?: string } | undefined;

/**
 * Emit `joinChannel` and CONSUME the server ack: the gateway returns
 * {success:false} when its NATS membership-verify times out (or the user
 * genuinely is not a member) and does NOT add the socket to the room. A
 * confirmed join is a no-op; an unconfirmed one retries with bounded backoff;
 * on exhaustion the channel leaves the intent set (and lands in the exhausted
 * set) so the client stops implying live delivery for a room it never entered.
 */
function emitJoinChannelWithAck(
  socket: Socket,
  channelId: string,
  joinedChannels: Set<string>,
  exhaustedChannels: Set<string>,
  attempt = 0,
): void {
  socket.emit('joinChannel', { channelId }, (ack: JoinChannelAck) => {
    if (ack?.success) {
      exhaustedChannels.delete(channelId);
      return;
    }
    if (attempt < JOIN_ACK_MAX_RETRIES && joinedChannels.has(channelId)) {
      const delay = JOIN_ACK_RETRY_BASE_MS * 2 ** attempt;
      setTimeout(() => {
        if (socket.connected && joinedChannels.has(channelId)) {
          emitJoinChannelWithAck(socket, channelId, joinedChannels, exhaustedChannels, attempt + 1);
        }
      }, delay);
    } else {
      joinedChannels.delete(channelId);
      exhaustedChannels.add(channelId);
    }
  });
}

/** Read the (current-epoch) channels cache entry. */
function readChannels(qc: QueryClient, tenantId: string): Channel[] | undefined {
  return qc.getQueryData<Channel[]>(
    createTenantQueryKey(tenantId, 'messaging', 'channels'),
  );
}

export function useMessagingSocket(activeChannelId?: string): MessagingSocketState {
  const { token, tenantId, isAuthenticated, user, refreshAuth } = useAuth();
  const myId = user?.id;
  const queryClient = useQueryClient();
  const [isConnected, setIsConnected] = useState(false);

  // Latest-value refs: socket handlers are registered once per socket
  // lifecycle; the lifecycle is keyed on AUTH IDENTITY, not on transient
  // values (channel switches / token rotations must not tear the socket down
  // — mobile FE-MEDIUM-052 lesson).
  const socketRef = useRef<Socket | null>(null);
  const joinedChannelsRef = useRef<Set<string>>(new Set());
  /**
   * Channels whose join ack was denied until retry exhaustion. Skipped by the
   * join effect (stop implying live delivery) — EXCEPT when the user opens
   * the room, which is explicit intent worth one fresh join cycle.
   */
  const exhaustedChannelsRef = useRef<Set<string>>(new Set());
  const activeChannelRef = useRef(activeChannelId);
  activeChannelRef.current = activeChannelId;
  const myIdRef = useRef(myId);
  myIdRef.current = myId;
  const queryClientRef = useRef(queryClient);
  queryClientRef.current = queryClient;
  const refreshAuthRef = useRef(refreshAuth);
  refreshAuthRef.current = refreshAuth;
  const getAccessTokenRef = useRef(getAccessToken);
  getAccessTokenRef.current = getAccessToken;

  // Join-all source (channel-room decision): the channels query drives which
  // rooms exist; the join effect below runs whenever the list (or the
  // connection) changes.
  const { data: channels } = useChannels();

  useEffect(() => {
    if (!isAuthenticated || !token || !tenantId) return;

    let disposed = false;
    let reconnectAttempt = 0;
    let authStopped = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let healthTimer: ReturnType<typeof setTimeout> | null = null;
    let visibilityTimer: ReturnType<typeof setTimeout> | null = null;

    const invalidate = (...segments: unknown[]): void => {
      void queryClientRef.current.invalidateQueries({
        queryKey: createTenantInvalidationKey(tenantId, ...segments),
      });
    };

    const writeMessages = (
      channelId: string,
      updater: (pages: readonly ChannelMessagesPage[]) => ChannelMessagesPage[],
    ): void => {
      queryClientRef.current.setQueriesData<
        { pages: ChannelMessagesPage[]; pageParams: unknown[] } | undefined
      >(
        { queryKey: createTenantInvalidationKey(tenantId, 'messaging', 'messages', channelId) },
        (old) => (old && old.pages.length > 0 ? { ...old, pages: updater(old.pages) } : old),
      );
    };

    const readMessagesPages = (
      channelId: string,
    ): readonly ChannelMessagesPage[] | undefined => {
      const entries = queryClientRef.current.getQueriesData<{
        pages: ChannelMessagesPage[];
        pageParams: unknown[];
      }>({ queryKey: createTenantInvalidationKey(tenantId, 'messaging', 'messages', channelId) });
      for (const [, data] of entries) {
        if (data?.pages?.length) return data.pages;
      }
      return undefined;
    };

    const writeChannels = (updater: (channels: Channel[]) => Channel[]): void => {
      queryClientRef.current.setQueriesData<Channel[] | undefined>(
        { queryKey: createTenantInvalidationKey(tenantId, 'messaging', 'channels') },
        (old) => (old ? updater(old) : old),
      );
    };

    const clearTimers = (): void => {
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      if (healthTimer !== null) clearTimeout(healthTimer);
      reconnectTimer = null;
      healthTimer = null;
    };

    // ------------------------------------------------------------------
    // Conditional reconnect loop (FAZ 3.1): socket.io reconnection is OFF;
    // every retry goes through this jittered, health-gated, bounded scheduler.
    // ------------------------------------------------------------------
    const scheduleReconnect = (): void => {
      if (disposed || authStopped) return;
      if (reconnectAttempt >= RECONNECT_MAX_ATTEMPTS) return;
      const delay = jitteredBackoffDelay(reconnectAttempt);
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(() => {
        void attemptReconnect();
      }, delay);
    };

    const attemptReconnect = async (): Promise<void> => {
      if (disposed || authStopped) return;
      const socket = socketRef.current;
      if (!socket || socket.connected) return;
      const healthy = await gatewayHealthy();
      if (disposed || authStopped) return;
      if (!healthy) {
        // Gateway still down: keep WAITING at the probe cadence — this probe
        // does not burn a backoff attempt, so the retry budget survives an
        // outage that outlasts the exponential ladder.
        healthTimer = setTimeout(() => {
          void attemptReconnect();
        }, HEALTH_RETRY_INTERVAL_MS);
        return;
      }
      socket.connect();
    };

    /** 401/4401-class stop: refresh the session once; retry with the new token. */
    const recoverSession = async (): Promise<void> => {
      try {
        await refreshAuthRef.current();
        const freshToken = getAccessTokenRef.current();
        if (disposed || !freshToken) return;
        const socket = socketRef.current;
        if (!socket) return;
        authStopped = false;
        reconnectAttempt = 0;
        socket.auth = { token: freshToken };
        socket.connect();
      } catch {
        // Refresh failed: the auth context owns the login redirect; the
        // socket stays down (visibility can retry later).
      }
    };

    const stopForAuth = (): void => {
      authStopped = true;
      clearTimers();
      void recoverSession();
    };

    // ------------------------------------------------------------------
    // Socket lifecycle
    // ------------------------------------------------------------------
    const socket: Socket = io('/messaging', {
      auth: { token },
      transports: ['websocket', 'polling'],
      // Custom conditional loop replaces the built-in auto-reconnect.
      reconnection: false,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      if (disposed) return;
      reconnectAttempt = 0;
      setIsConnected(true);
      // Rejoin every intended room — ack-confirmed. Snapshot the set: the ack
      // callback may delete from it on exhaustion.
      for (const channelId of [...joinedChannelsRef.current]) {
        emitJoinChannelWithAck(socket, channelId, joinedChannelsRef.current, exhaustedChannelsRef.current);
      }
      // Catch-up: a (re)connect may follow a gap during which events were
      // dropped — refetch the active thread + the list instead of trusting
      // the cache. React-query dedupes this with any in-flight refetch.
      const active = activeChannelRef.current;
      if (active) invalidate('messaging', 'messages', active);
      invalidate('messaging', 'channels');
    });

    socket.on('disconnect', (reason: string) => {
      if (disposed) return;
      setIsConnected(false);
      // 'io client disconnect' = WE closed it (unmount) — never loop after
      // our own teardown. Server/network closes go through the gate.
      if (reason !== 'io client disconnect') scheduleReconnect();
    });

    socket.on('connect_error', (err: Error) => {
      if (disposed) return;
      setIsConnected(false);
      if (isAuthDisconnectError(err)) {
        stopForAuth();
        return;
      }
      scheduleReconnect();
    });

    // In-band gateway errors (handshake auth, 4401 re-auth exhausted, 4403
    // suspended) arrive as the 'error' envelope, not connect_error.
    socket.on('error', (env: unknown) => {
      if (disposed) return;
      const envelope = env as SocketIoErrorEnvelope | undefined;
      if (envelope && isAuthDisconnectError(envelope)) stopForAuth();
    });

    // ------------------------------------------------------------------
    // Domain events — cache mutations, not invalidations (FAZ 3.2)
    // ------------------------------------------------------------------
    socket.on('newMessage', (raw: unknown) => {
      const envelope = raw as MessageEnvelope;
      if (!envelope?.channelId || !envelope.message?.id) return;
      const qc = queryClientRef.current;
      const message: Message = projectWsMessage(
        enrichWsSenderFromChannels(readChannels(qc, tenantId), envelope.message),
      );
      const isActiveChannel = envelope.channelId === activeChannelRef.current;
      if (isActiveChannel) {
        writeMessages(envelope.channelId, (pages) => upsertMessageIntoPages(pages, message));
      }
      writeChannels((current) =>
        applyIncomingMessageToChannels(current, message, {
          isActiveChannel,
          myUserId: myIdRef.current,
        }),
      );
    });

    socket.on('messageUpdated', (raw: unknown) => {
      const envelope = raw as MessageUpdatedEnvelope;
      if (!envelope?.channelId || !envelope.message?.id) return;
      const qc = queryClientRef.current;
      // Enrich BEFORE the spread: the edit envelope's sender is id-only, and
      // an un-enriched spread would wipe the cached display name.
      const message: Message = projectWsMessage(
        enrichWsSenderFromChannels(readChannels(qc, tenantId), envelope.message),
      );
      writeMessages(envelope.channelId, (pages) => updateMessageInPages(pages, message));
      writeChannels((current) => applyMessageUpdatedToChannels(current, message));
    });

    socket.on('messageDeleted', (raw: unknown) => {
      const envelope = raw as MessageDeletedEnvelope;
      if (!envelope?.channelId || !envelope.messageId) return;
      const channelId = envelope.channelId;
      writeMessages(channelId, (pages) => markMessageDeletedInPages(pages, envelope.messageId));
      writeChannels((current) =>
        applyMessageDeletedToChannels(current, channelId, envelope.messageId, () =>
          readMessagesPages(channelId),
        ),
      );
    });

    socket.on('readReceipt', (raw: unknown) => {
      const envelope = raw as ReadReceiptEnvelope;
      if (!envelope?.channelId) return;
      // Another user's cursor does not change MY unread badge and the panel
      // renders no per-message read state — nothing to write, nothing to
      // refetch. My own receipt confirms the optimistic zero; snap it in case
      // the optimistic path never ran (e.g. list opened straight to a DM).
      if (envelope.userId === myIdRef.current) {
        writeChannels((current) => zeroUnreadForChannel(current, envelope.channelId));
      }
    });

    // RECOVERY EXCEPTION (MSG-HIGH-063): the gateway could not hydrate a live
    // message and sends this content-free hint instead — the wire has nothing
    // to merge, so invalidation (refetch) IS the recovery path.
    socket.on('messageSyncHint', (raw: unknown) => {
      const envelope = raw as MessageSyncHintEnvelope;
      if (envelope?.channelId) invalidate('messaging', 'messages', envelope.channelId);
      invalidate('messaging', 'channels');
    });

    // Structural channel lifecycle: nothing mergeable on the wire — converge
    // the list (new/renamed channels, membership changes) on server truth.
    socket.on('channelEvent', () => {
      invalidate('messaging', 'channels');
    });

    // I was removed from a channel: the gateway already pulled this socket
    // out of the room. Drop the caches so the list loses the channel and an
    // open room refetches into the honest FORBIDDEN error banner.
    socket.on('channelMemberRemoved', (raw: unknown) => {
      const envelope = raw as ChannelMemberRemovedEnvelope;
      if (!envelope?.channelId || envelope.userId !== myIdRef.current) return;
      joinedChannelsRef.current.delete(envelope.channelId);
      queryClientRef.current.removeQueries({
        queryKey: createTenantInvalidationKey(
          tenantId,
          'messaging',
          'messages',
          envelope.channelId,
        ),
      });
      invalidate('messaging', 'channels');
    });

    // ------------------------------------------------------------------
    // reAuth: the server requests a fresh token mid-connection (mobile
    // pattern) — refresh, update socket.auth, answer with reAuthResponse.
    // ------------------------------------------------------------------
    socket.on('reAuth', () => {
      void refreshAuthRef
        .current()
        .then(() => {
          const freshToken = getAccessTokenRef.current();
          const current = socketRef.current;
          if (!freshToken || !current) return;
          current.auth = { token: freshToken };
          current.emit('reAuthResponse', { token: freshToken });
        })
        .catch(() => {
          // Refresh failed — the gateway disconnects after 3 failures and the
          // auth context surfaces the login redirect.
        });
    });

    // ------------------------------------------------------------------
    // visibilitychange-triggered reconnect (2s debounce): the user coming
    // back is an explicit signal worth a FRESH retry budget — it also revives
    // a loop that exhausted its attempts or stopped on auth (the token may
    // have been refreshed by the tab-visibility token lifecycle meanwhile).
    // ------------------------------------------------------------------
    const onVisibilityChange = (): void => {
      if (disposed) return;
      if (document.visibilityState !== 'visible') {
        if (visibilityTimer !== null) clearTimeout(visibilityTimer);
        visibilityTimer = null;
        return;
      }
      const current = socketRef.current;
      if (!current || current.connected) return;
      if (visibilityTimer !== null) clearTimeout(visibilityTimer);
      visibilityTimer = setTimeout(() => {
        visibilityTimer = null;
        if (disposed) return;
        authStopped = false;
        reconnectAttempt = 0;
        void attemptReconnect();
      }, VISIBILITY_RECONNECT_DEBOUNCE_MS);
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (visibilityTimer !== null) clearTimeout(visibilityTimer);
      clearTimers();
      socket.removeAllListeners();
      socket.disconnect(); // reason 'io client disconnect' — no reconnect loop
      if (socketRef.current === socket) socketRef.current = null;
      setIsConnected(false);
    };
    // Intentionally NOT keyed on `token`/`activeChannelId`: rotations reach
    // the live socket via reAuth, channel switches via activeChannelRef. The
    // lifecycle follows AUTH IDENTITY only (isAuthenticated, tenantId).
  }, [isAuthenticated, tenantId, token]);

  // ------------------------------------------------------------------
  // Join-all (channel-room decision): whenever the channels cache or the
  // connection changes, join any cached channel that is not yet joined.
  // ≤100 rooms (myChannels filter limit); membership is verified per join by
  // the gateway, so a stale cache entry is rejected through the ack path.
  // ------------------------------------------------------------------
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket?.connected) return;
    for (const channel of channels ?? []) {
      if (joinedChannelsRef.current.has(channel.id)) continue;
      // A channel denied until exhaustion is NOT re-joined on list churn
      // alone — opening the room re-arms it (explicit user intent).
      const isExhausted = exhaustedChannelsRef.current.has(channel.id);
      if (isExhausted && channel.id !== activeChannelRef.current) continue;
      exhaustedChannelsRef.current.delete(channel.id);
      joinedChannelsRef.current.add(channel.id);
      emitJoinChannelWithAck(socket, channel.id, joinedChannelsRef.current, exhaustedChannelsRef.current);
    }
  }, [channels, isConnected]);

  return { isConnected };
}
