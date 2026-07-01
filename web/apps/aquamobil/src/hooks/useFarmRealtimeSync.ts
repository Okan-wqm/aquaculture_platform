// useFarmRealtimeSync — subscribes to the gateway `/farms` Socket.IO namespace
// and invalidates the affected React Query caches when a farm domain event
// arrives, so a change made anywhere (this app, another mobile user, or the web
// tenant panel) reflects here within ~1s without a manual refresh.
//
// WHY: the backend already broadcasts 23+ farm events to the tenant room
// (command → outbox → NATS → FarmGateway), but nothing on the frontend listened
// — tank counts stayed stale until the 1-min staleTime or a manual refetch (the
// 719-vs-900 divergence class). This mirrors the messaging `useMessageSocket`
// connection + reconnect-reconcile pattern; the farm gateway auto-joins the
// authenticated client to `tenant:{tenantId}`, so no explicit room join is
// needed.
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';

import { useAuth } from './useAuth';

import {
  FARM_REALTIME_INVALIDATION_SEGMENTS,
  invalidateAllFarmQueries,
  invalidateFarmEventQueries,
} from '@/utils/farm-realtime-invalidation';

export function useFarmRealtimeSync(): { isConnected: boolean } {
  const { accessToken, isAuthenticated, tenantId } = useAuth();
  const queryClient = useQueryClient();
  const [isConnected, setIsConnected] = useState(false);
  const accessTokenRef = useRef(accessToken);
  accessTokenRef.current = accessToken;

  useEffect(() => {
    if (!isAuthenticated || !accessToken || !tenantId) {
      return;
    }

    let cancelled = false;
    let socket: Socket | null = null;
    let hasConnectedOnce = false;

    void (async () => {
      const mod = await import('socket.io-client');
      if (cancelled) return;

      const nextSocket = mod.io('/farms', {
        auth: { token: accessTokenRef.current },
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 30000,
        reconnectionAttempts: 20,
      });
      socket = nextSocket;

      nextSocket.on('connect', () => {
        setIsConnected(true);
        // On a RECONNECT (not the first connect), events fired while the socket
        // was down were missed — invalidate the whole farm namespace to catch
        // up (initial connect already loaded fresh state, so skip it).
        if (hasConnectedOnce) {
          void invalidateAllFarmQueries(queryClient, tenantId);
        }
        hasConnectedOnce = true;
      });

      nextSocket.on('disconnect', () => {
        setIsConnected(false);
      });

      // Invalidate the mapped read models for every known farm event.
      for (const eventName of Object.keys(FARM_REALTIME_INVALIDATION_SEGMENTS)) {
        nextSocket.on(eventName, () => {
          void invalidateFarmEventQueries(queryClient, tenantId, eventName);
        });
      }
    })();

    return () => {
      cancelled = true;
      socket?.disconnect();
      setIsConnected(false);
    };
  }, [isAuthenticated, accessToken, tenantId, queryClient]);

  return { isConnected };
}
