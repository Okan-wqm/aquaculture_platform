/**
 * Socket.IO Connection Pool Factory
 *
 * Maintains a single Socket.IO connection per (URL, tenant) pair, shared across
 * all hooks (useSensorSocket, useEdgeIoSocket, useScadaLiveData, useAlarmRuntime).
 *
 * SECURITY: The pool key is scoped by tenant (`${url}::${tenantId}`), NOT by URL
 * alone. A CONNECTED socket keeps the `auth` it was opened with until it
 * disconnects, so keying by URL only would hand a still-open tenant-A socket to a
 * tenant-B session after logout → re-login in the same browser — bleeding tenant
 * A's realtime events (sensor readings, alarms, edge I/O, SCADA live data) to
 * tenant B. Tenant-scoping the key makes that cross-tenant reuse impossible.
 *
 * Reference-counted: the underlying socket is only disconnected when
 * all consumers have called releaseSocket().
 *
 * On logout, a registered cleanup callback (registerLogoutCleanup) disconnects
 * every pooled socket and clears the pool, severing all realtime connections
 * before a different user can log in.
 */

import { io, type Socket } from 'socket.io-client';
import {
  getAccessToken,
  getTenantId,
  onTenantChange,
  registerLogoutCleanup,
} from '@aquaculture/shared-ui';

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
 * Build the tenant-scoped pool key for a URL. Keeping this in one place keeps
 * the get/set/release/teardown paths byte-for-byte consistent so refcounting
 * stays balanced.
 */
function poolKey(url: string, tenantId: string): string {
  return `${url}::${tenantId}`;
}

/**
 * Get or create a shared Socket.IO connection for the given URL, scoped to the
 * current tenant. Each call increments the reference count.
 *
 * The auth token is always read fresh from getAccessToken() so that
 * reconnect attempts use the latest credentials.
 *
 * Returns null when there is no token OR no tenant context — we never open a
 * tenant-scoped realtime socket without a tenant to bind it to.
 */
export function getSocket(
  url: string,
  options?: Record<string, unknown>,
): Socket | null {
  const token = getAccessToken();
  if (!token) return null;

  const tenantId = getTenantId();
  if (!tenantId) return null;

  const key = poolKey(url, tenantId);
  const existing = pool.get(key);

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

  pool.set(key, { socket, refCount: 1 });
  return socket;
}

/**
 * Decrement the reference count for the given URL in the current tenant scope.
 * When the count reaches 0 the socket is disconnected and removed from the pool.
 */
export function releaseSocket(url: string): void {
  const tenantId = getTenantId();
  if (!tenantId) return;

  const key = poolKey(url, tenantId);
  const entry = pool.get(key);
  if (!entry) return;

  entry.refCount--;

  if (entry.refCount <= 0) {
    entry.socket.removeAllListeners();
    entry.socket.disconnect();
    pool.delete(key);
  }
}

/**
 * Disconnect every pooled socket and clear the pool.
 *
 * SECURITY: Runs on logout (via registerLogoutCleanup) so a logout fully severs
 * all realtime connections — across every tenant scope — before a different user
 * can log in on the same browser.
 */
function teardownAllSockets(): void {
  for (const entry of pool.values()) {
    entry.socket.removeAllListeners();
    entry.socket.disconnect();
  }
  pool.clear();
}

/**
 * Disconnect + evict every pooled socket bound to a SPECIFIC tenant.
 *
 * SECURITY: Runs on a tenant switch (onTenantChange) so tenant A's realtime sockets
 * are severed the instant the active tenant changes — they must NOT linger
 * (refcounted) in the pool until the next logout, where they would keep delivering
 * tenant-A events (sensor readings, alarms, edge I/O) into the tenant-B session that
 * reuses the same browser. Mirrors the logout teardown, scoped to one tenant. The
 * `::${tenantId}` suffix is the tenant half of poolKey(), so endsWith targets exactly
 * the leaving tenant's entries.
 */
function teardownTenantSockets(oldTenantId: string): void {
  const suffix = `::${oldTenantId}`;
  for (const [key, entry] of pool) {
    if (key.endsWith(suffix)) {
      entry.socket.removeAllListeners();
      entry.socket.disconnect();
      pool.delete(key);
    }
  }
}

// Register the logout + tenant-switch teardowns exactly once at module load. The
// guard prevents a double-registration if this module is ever re-evaluated
// (HMR / federation).
let teardownRegistered = false;
if (!teardownRegistered) {
  teardownRegistered = true;
  registerLogoutCleanup(teardownAllSockets);
  onTenantChange(teardownTenantSockets);
}
