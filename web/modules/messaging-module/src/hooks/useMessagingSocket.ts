/**
 * useMessagingSocket — Socket.IO client for the `/messaging` namespace.
 *
 * The gateway MessagingGateway streams `newMessage` / `messageUpdated` as
 * members send. Rather than merge partial payloads, we invalidate the affected
 * tenant-scoped queries so react-query refetches the authoritative thread — the
 * same correctness-over-cleverness choice the mobile client converged on.
 * Joins only the active channel; the socket lives only while a channel is open.
 */
import {
  useAuth,
  createTenantInvalidationKey,
  getTenantId,
} from '@aquaculture/shared-ui';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { io, type Socket } from 'socket.io-client';

interface NewMessageEnvelope {
  channelId: string;
}

export function useMessagingSocket(activeChannelId: string | undefined): void {
  const { token, isAuthenticated } = useAuth();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!activeChannelId || !isAuthenticated || !token) return;

    const invalidate = (...segments: unknown[]): void => {
      void queryClient.invalidateQueries({
        queryKey: createTenantInvalidationKey(getTenantId(), ...segments),
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

    socket.on('connect', () => socket.emit('joinChannel', { channelId: activeChannelId }));

    const refetch = (env: NewMessageEnvelope): void => {
      if (env?.channelId) invalidate('messaging', 'messages', env.channelId);
      invalidate('messaging', 'channels');
    };
    socket.on('newMessage', refetch);
    socket.on('messageUpdated', refetch);

    return () => {
      socket.emit('leaveChannel', { channelId: activeChannelId });
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, [activeChannelId, isAuthenticated, token, queryClient]);
}
