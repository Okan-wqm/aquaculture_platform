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
 * @returns emitMarkRead — emit a mark-as-read event
 * @returns socketRef — ref to the underlying socket instance for use by other hooks
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from './useAuth';
import type {
  NewMessageEvent,
  MessageUpdatedEvent,
  MessageDeletedEvent,
  ReadReceiptEvent,
  Message,
  MessagePage,
} from '@/types/messaging';

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

export function useMessageSocket() {
  const { accessToken, isAuthenticated, tenantId, refreshAuth } = useAuth();
  const queryClient = useQueryClient();
  const [isConnected, setIsConnected] = useState(false);
  const socketRef = useRef<SocketInstance | null>(null);
  const joinedChannelsRef = useRef<Set<string>>(new Set());
  // WHY: Ref tracks the latest accessToken for use inside the reAuth callback.
  // refreshAuth() updates React state, but the callback needs the new token
  // in the same tick without waiting for a re-render.
  const accessTokenRef = useRef(accessToken);
  accessTokenRef.current = accessToken;

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

    const connect = async () => {
      const io = await getIo();
      if (!io || !mounted) return;

      socket = io('/messaging', {
        auth: { token: accessToken },
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 30000,
        reconnectionAttempts: Infinity,
        forceNew: false,
      });

      socketRef.current = socket;

      // --- Connection events ---
      socket.on('connect', () => {
        if (!mounted) return;
        setIsConnected(true);
        // Rejoin all previously joined channels
        for (const channelId of joinedChannelsRef.current) {
          socket!.emit('joinChannel', { channelId });
        }
      });

      socket.on('disconnect', () => {
        if (mounted) setIsConnected(false);
      });

      // --- Domain events ---

      socket.on('newMessage', (data: unknown) => {
        const event = data as NewMessageEvent;
        // Update messages cache for this channel
        queryClient.setQueryData(
          ['messaging', 'messages', event.channelId, tenantId],
          (old: { pages: MessagePage[]; pageParams: (string | null)[] } | undefined) => {
            if (!old?.pages?.length) return old;
            const firstPage = old.pages[0];
            if (!firstPage) return old;
            const exists = firstPage.items.some((m: Message) => m.id === event.message.id);
            if (exists) {
              return {
                ...old,
                pages: old.pages.map((page: MessagePage, i: number) =>
                  i === 0
                    ? {
                        ...page,
                        items: page.items.map((m: Message) =>
                          m.id === event.message.id ? event.message : m,
                        ),
                      }
                    : page,
                ),
              };
            }
            return {
              ...old,
              pages: [
                { ...firstPage, items: [...firstPage.items, event.message] },
                ...old.pages.slice(1),
              ],
            };
          },
        );
        // Invalidate channel list to update lastMessage / unread counts
        queryClient.invalidateQueries({ queryKey: ['messaging', 'channels'] });
        // Increment unread count
        queryClient.invalidateQueries({ queryKey: ['messaging', 'unreadCount'] });
      });

      socket.on('messageUpdated', (data: unknown) => {
        const event = data as MessageUpdatedEvent;
        queryClient.setQueryData(
          ['messaging', 'messages', event.channelId, tenantId],
          (old: { pages: MessagePage[]; pageParams: (string | null)[] } | undefined) => {
            if (!old?.pages) return old;
            return {
              ...old,
              pages: old.pages.map((page: MessagePage) => ({
                ...page,
                items: page.items.map((m: Message) =>
                  m.id === event.message.id ? { ...m, ...event.message } : m,
                ),
              })),
            };
          },
        );
      });

      socket.on('messageDeleted', (data: unknown) => {
        const event = data as MessageDeletedEvent;
        queryClient.setQueryData(
          ['messaging', 'messages', event.channelId, tenantId],
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

      socket.on('readReceipt', (data: unknown) => {
        const event = data as ReadReceiptEvent;
        // Invalidate unread count
        queryClient.invalidateQueries({ queryKey: ['messaging', 'unreadCount'] });
        // Update receipt in message cache
        queryClient.setQueryData(
          ['messaging', 'messages', event.channelId, tenantId],
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

      // --- reAuth: server requests fresh token ---
      // WHY: When the server detects an expired JWT, it emits 'reAuth'.
      // refreshAuth() obtains a new token via httpOnly cookie and updates
      // React state + module-level authStore synchronously. We read the
      // new token from our accessTokenRef (updated on every render) and
      // also update socket.auth so reconnections use the fresh token.
      socket.on('reAuth', async () => {
        try {
          await refreshAuth();
          const newToken = accessTokenRef.current;
          if (socketRef.current && newToken) {
            socketRef.current.auth = { token: newToken };
            socketRef.current.emit('reAuthResponse', { token: newToken });
          }
        } catch {
          // Auth refresh failed — socket will likely disconnect
        }
      });
    };

    connect();

    return () => {
      mounted = false;
      if (socket) {
        socket.disconnect();
      }
      socketRef.current = null;
      setIsConnected(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, accessToken, tenantId]);

  // ------------------------------------------------------------------
  // Imperative channel room management
  // ------------------------------------------------------------------

  const joinChannel = useCallback((channelId: string) => {
    joinedChannelsRef.current.add(channelId);
    if (socketRef.current?.connected) {
      socketRef.current.emit('joinChannel', { channelId });
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

  const emitMarkRead = useCallback((channelId: string, messageId: string) => {
    if (socketRef.current?.connected) {
      socketRef.current.emit('markRead', { channelId, messageId });
    }
  }, []);

  return {
    isConnected,
    joinChannel,
    leaveChannel,
    emitTyping,
    emitMarkRead,
    socketRef,
  };
}
