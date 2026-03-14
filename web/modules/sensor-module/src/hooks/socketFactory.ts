/**
 * Socket.IO Connection Pool Factory
 *
 * Maintains a single Socket.IO connection per URL, shared across all hooks
 * (useSensorSocket, useEdgeIoSocket, useScadaLiveData).
 *
 * Reference-counted: the underlying socket is only disconnected when
 * all consumers have called releaseSocket().
 */

import { io, type Socket } from 'socket.io-client';
import { getAccessToken } from '@aquaculture/shared-ui';

interface PoolEntry {
  socket: Socket;
  refCount: number;
}

const pool = new Map<string, PoolEntry>();

const DEFAULT_OPTIONS = {
  transports: ['websocket', 'polling'] as string[],
  reconnection: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
};

/**
 * Get or create a shared Socket.IO connection for the given URL.
 * Each call increments the reference count.
 *
 * The auth token is always read fresh from getAccessToken() so that
 * reconnect attempts use the latest credentials.
 */
export function getSocket(
  url: string,
  options?: Record<string, unknown>,
): Socket | null {
  const token = getAccessToken();
  if (!token) return null;

  const existing = pool.get(url);

  if (existing) {
    existing.refCount++;

    // If the existing socket got disconnected externally, reconnect it
    if (existing.socket.disconnected) {
      // Update auth token before reconnecting
      (existing.socket as any).auth = { token };
      existing.socket.connect();
    }

    return existing.socket;
  }

  // Create a brand-new socket
  const socket = io(url, {
    ...DEFAULT_OPTIONS,
    ...options,
    auth: { token },
  });

  // Refresh token on every reconnect attempt
  socket.on('reconnect_attempt', () => {
    const freshToken = getAccessToken();
    if (freshToken) {
      (socket as any).auth = { token: freshToken };
    }
  });

  pool.set(url, { socket, refCount: 1 });
  return socket;
}

/**
 * Decrement the reference count for the given URL.
 * When the count reaches 0 the socket is disconnected and removed from the pool.
 */
export function releaseSocket(url: string): void {
  const entry = pool.get(url);
  if (!entry) return;

  entry.refCount--;

  if (entry.refCount <= 0) {
    entry.socket.removeAllListeners();
    entry.socket.disconnect();
    pool.delete(url);
  }
}
