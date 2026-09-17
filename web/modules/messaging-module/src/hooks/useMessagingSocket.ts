/**
 * useMessagingSocket — Socket.IO client for the `/messaging` namespace.
 *
 * The gateway MessagingGateway streams `newMessage` / `messageUpdated` /
 * `messageSyncHint` as members send. Rather than merge partial payloads, we
 * invalidate the affected tenant-scoped queries so react-query refetches the
 * authoritative thread — the same correctness-over-cleverness choice the
 * mobile client converged on. Joins only the active channel; the socket lives
 * only while a channel is open.
 *
 * FAZ 1: also tracks connection liveness (`{ isConnected }`) so the room can
 * surface a Reconnecting… indicator, and invalidates on (re)connect to catch
 * up on anything missed while the socket was down.
 */
import {
  useAuth,
  createTenantInvalidationKey,
} from '@aquaculture/shared-ui';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { io, type Socket } from 'socket.io-client';

interface NewMessageEnvelope {
  channelId: string;
}

export interface MessagingSocketState {
  /** False until the first connect and during any disconnect/connect_error gap. */
  isConnected: boolean;
}

export function useMessagingSocket(activeChannelId: string | undefined): MessagingSocketState {
  const { token, tenantId, isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    if (!activeChannelId || !isAuthenticated || !token) return;

    const invalidate = (...segments: unknown[]): void => {
      void queryClient.invalidateQueries({
        queryKey: createTenantInvalidationKey(tenantId, ...segments),
      });
    };

    const socket: Socket = io('/messaging', {
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30000,
      reconnectionAttempts: 10,
    });

    socket.on('connect', () => {
      setIsConnected(true);
      socket.emit('joinChannel', { channelId: activeChannelId });
      // Catch-up: a fresh (re)connect may follow a gap during which the server
      // dropped events we never saw — refetch instead of trusting the cache.
      // React-query dedupes this with any in-flight mutation invalidation.
      invalidate('messaging', 'messages', activeChannelId);
      invalidate('messaging', 'channels');
    });

    socket.on('disconnect', () => setIsConnected(false));
    socket.on('connect_error', () => setIsConnected(false));

    const refetch = (env: NewMessageEnvelope): void => {
      // FAZ 3.2 branch point: when the gateway starts emitting to the user's
      // full channel set (not just the joined/active one), split here on
      //   env.channelId === activeChannelId
      //     → this invalidation IS the mark-read flow (the room refetches, its
      //       last-message effect calls markMessagesRead while visible)
      //     → else bump that channel's unreadCount in the channels cache
      //       (local +1) instead of a per-channel messages refetch.
      // Today the socket only joins the active channel, so every envelope is
      // the active channel and the invalidation path below covers both.
      if (env?.channelId) invalidate('messaging', 'messages', env.channelId);
      invalidate('messaging', 'channels');
    };
    socket.on('newMessage', refetch);
    socket.on('messageUpdated', refetch);

    // MSG-HIGH-063 parity with mobile: the gateway could not hydrate a live
    // message and sends this content-free hint instead — invalidate the
    // channel's thread (+ list/badge) so a refetch converges on server truth.
    socket.on('messageSyncHint', (env: unknown) => {
      const { channelId: hintedChannelId } = (env ?? {}) as Partial<NewMessageEnvelope>;
      if (hintedChannelId) invalidate('messaging', 'messages', hintedChannelId);
      invalidate('messaging', 'channels');
    });

    return () => {
      socket.emit('leaveChannel', { channelId: activeChannelId });
      socket.removeAllListeners();
      socket.disconnect();
      setIsConnected(false);
    };
  }, [activeChannelId, isAuthenticated, token, tenantId, queryClient]);

  return { isConnected };
}
