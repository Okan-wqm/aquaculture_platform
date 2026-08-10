/**
 * useFarmRealtimeStream
 *
 * Connects once per farm-module mount to the gateway-api `/farms` Socket.IO
 * namespace, listens for domain events, and invalidates the matching React
 * Query caches so the UI re-renders with fresh data without a manual refresh.
 *
 * # Why a hook (not a component)
 *
 * This is module-level infrastructure — exactly ONE instance should live
 * for the lifetime of the farm-module mount. A component would either
 * require careful Provider placement or risk double-mounting the socket
 * in React strict mode. A hook called from `FarmModule.tsx` is the
 * simplest correct placement.
 *
 * # Cache invalidation strategy
 *
 * We do NOT try to patch individual query caches with the event payload —
 * that would couple the hook to the exact shape of every list/detail
 * query and would drift the moment a query adds a new field. Instead we
 * invalidate the relevant cache PREFIXES so React Query re-fetches the
 * authoritative data from the backend. This is slightly less optimal in
 * network terms but much more robust: the backend remains the single
 * source of truth.
 *
 * The invalidation prefixes map to the actual query keys used in
 * `useBatches.ts`, `useTanks.ts`, etc. If those keys change, this hook
 * must be updated — the drift is caught by types at build time (the
 * prefix-match pattern is tolerant) but verify after any hook rename.
 *
 * # Connection lifecycle
 *
 * The Socket.IO client is created with `reconnection: true` so transient
 * network blips are handled automatically. The token is passed once at
 * connect time via `auth: { token }`; the `reconnect_attempt` listener
 * updates it from the current auth state before each retry.
 *
 * Cleanup on unmount disconnects the socket cleanly so the backend
 * closes the room membership.
 *
 * @see Phase C of farm domain real-time visibility plan.
 */

import React, { useEffect } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth, createTenantInvalidationKey } from '@aquaculture/shared-ui';

// Runtime config is injected onto `window` by the deploy entrypoint (a
// non-VITE fallback for the WS URL when the bundle was built without it).
declare global {
  interface Window {
    __RUNTIME_CONFIG__?: { WS_URL?: string };
  }
}

// ─── Configuration ──────────────────────────────────────────────────

/**
 * Gateway URL for the farm domain namespace. Resolution order:
 *   1. `VITE_WS_URL` — explicit override at build time (preferred in prod)
 *   2. `window.__RUNTIME_CONFIG__.WS_URL` — runtime config injected by shell
 *   3. Empty string — Socket.IO defaults to current origin (dev mode)
 *
 * The `/farms` suffix is the Socket.IO namespace exposed by `FarmGateway`.
 */
function resolveFarmSocketUrl(): string {
  const viteWsUrl: string | undefined = import.meta.env.VITE_WS_URL;
  const runtimeWsUrl = window.__RUNTIME_CONFIG__?.WS_URL;

  const baseUrl = viteWsUrl || runtimeWsUrl || '';
  return `${baseUrl}/farms`;
}

/**
 * Event → React Query key prefix invalidation map (domain segments only).
 *
 * SECURITY: These are the domain-specific segments only. The tenant prefix
 * is prepended at invalidation time via createTenantQueryKey, ensuring all
 * invalidations are scoped to the active tenant (FE-CRITICAL-016).
 */
const INVALIDATION_MAP = {
  batchCreated: [
    ['batches', 'list'],
    ['tanks', 'list'],
  ],
  batchHarvested: [
    ['batches', 'list'],
    ['batches', 'detail'],
    ['tanks', 'list'],
    ['harvestPlans'],
    ['harvestRecords'],
  ],
  batchTransferred: [
    ['batches', 'list'],
    ['batches', 'detail'],
    ['tanks', 'list'],
  ],
  batchStatusChanged: [
    ['batches', 'list'],
    ['batches', 'detail'],
  ],
  batchClosed: [
    ['batches', 'list'],
    ['batches', 'detail'],
    ['tanks', 'list'],
  ],
  batchAllocatedToTank: [
    ['batches', 'detail'],
    ['tanks', 'list'],
  ],
  mortalityRecorded: [
    ['batches', 'list'],
    ['batches', 'detail'],
    ['tanks', 'list'],
    ['mortalityRecords'],
    ['batchOperations'],
  ],
  cullRecorded: [
    ['batches', 'list'],
    ['batches', 'detail'],
    ['tanks', 'list'],
    ['batchOperations'],
  ],
  feedingRecorded: [
    ['feeding', 'daily-executions'],
    ['batches', 'detail'],
    ['tanks', 'list'],
  ],
  feedInventoryLow: [
    ['storage', 'inventory'],
    ['feeds', 'inventory'],
  ],
  // Storage-ledger low-stock sink (successor of feedInventoryLow): every
  // stock-reducing writer emits it, so storage + feed views refresh live.
  lowStockDetected: [
    ['storage', 'inventory'],
    ['storage', 'overview'],
    ['feeds', 'inventory'],
  ],
  siteCreated: [['sites']],
  siteUpdated: [['sites']],
  siteDeleted: [['sites'], ['departments'], ['systems'], ['equipment'], ['tanks']],
  siteContactsChanged: [['sites']],
  departmentCreated: [['departments'], ['sites']],
  departmentUpdated: [['departments'], ['sites']],
  departmentDeleted: [['departments'], ['sites'], ['systems'], ['equipment'], ['tanks']],
  systemCreated: [['systems'], ['sites'], ['departments']],
  systemUpdated: [['systems'], ['sites'], ['departments']],
  systemDeleted: [['systems'], ['sites'], ['departments'], ['equipment']],
  tankCreated: [['tanks'], ['equipment'], ['sites'], ['departments']],
  tankUpdated: [['tanks'], ['equipment'], ['sites'], ['departments']],
  tankStatusChanged: [['tanks'], ['equipment'], ['sites'], ['departments']],
  tankDeleted: [['tanks'], ['equipment'], ['sites'], ['departments']],
  equipmentCreated: [['equipment'], ['sites'], ['departments'], ['systems']],
  equipmentUpdated: [['equipment'], ['sites'], ['departments'], ['systems']],
  equipmentDeleted: [['equipment'], ['sites'], ['departments'], ['systems']],
  subEquipmentCreated: [['equipment'], ['subEquipment']],
  subEquipmentUpdated: [['equipment'], ['subEquipment']],
  subEquipmentDeleted: [['equipment'], ['subEquipment']],
  supplierApprovedSitesChanged: [['suppliers'], ['sites']],
  feederCalibrationsSaved: [['feederSetup'], ['equipment']],
  // Öğün motoru v2 (C-2): MealBoard + atama görünümleri canlı tazelenir.
  mealFed: [['feeding-day-plans'], ['tanks', 'list']],
  mealSkipped: [['feeding-day-plans']],
  mealMissed: [['feeding-day-plans']],
  mealUnderfed: [['feeding-day-plans']],
  feedTypeTransitioned: [['feeding-day-plans'], ['protocol-assignments'], ['tanks', 'list']],
  unfedUnitDetected: [['feeding-day-plans'], ['protocol-assignments']],
} as const satisfies Record<string, readonly (readonly unknown[])[]>;

type FarmEventName = keyof typeof INVALIDATION_MAP;

/**
 * Hook-level state is limited to the React effect — there is no
 * component-visible return value. Callers mount the hook and trust it
 * to keep caches fresh in the background.
 */
export function useFarmRealtimeStream(): void {
  const queryClient = useQueryClient();
  const { tenantId, token } = useAuth();

  // FE-MEDIUM-032: Hold a ref to the active socket so token changes can
  // patch auth.token in-place without tearing down the entire connection.
  const socketRef = React.useRef<Socket | null>(null);

  // FE-MEDIUM-032: Keep latest token in a ref so the reconnect_attempt
  // handler always uses the freshest token without the effect re-running.
  const tokenRef = React.useRef(token);
  tokenRef.current = token;

  // FE-MEDIUM-032: When the token changes but the socket is still connected,
  // update auth.token in-place instead of recreating the connection.
  React.useEffect(() => {
    if (socketRef.current && token && socketRef.current.connected) {
      socketRef.current.auth = { token };
    }
  }, [token]);

  useEffect(() => {
    // Gate: only connect after auth is established. Without a token the
    // socket handshake would be rejected by FarmGateway (401) and the
    // client would keep reconnecting uselessly.
    if (!token || !tenantId) return;

    // FE-MEDIUM-032: If a socket already exists and is connected, skip
    // recreation. The token-only effect above patches auth.token in-place.
    // Only recreate when tenantId changes (which implies a different room).
    if (socketRef.current && socketRef.current.connected) {
      return;
    }

    const url = resolveFarmSocketUrl();

    const socket: Socket = io(url, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      auth: { token },
    });

    // FE-MEDIUM-032: Store socket ref so the token-only effect above can
    // patch auth.token in-place without tearing down the connection.
    socketRef.current = socket;

    // FE-MEDIUM-032: Update auth.token in-place on reconnect attempts.
    // Uses tokenRef to always read the latest token from the ref, so the
    // handler closure doesn't go stale when the token refreshes.
    socket.on('reconnect_attempt', () => {
      const currentToken = tokenRef.current;
      if (currentToken) {
        socket.auth = { token: currentToken };
      }
    });

    /**
     * Generic handler factory: invalidates the mapped prefixes for this
     * event type. Each domain prefix is scoped to the current tenant via
     * createTenantQueryKey, ensuring invalidations never cross tenant
     * boundaries (FE-CRITICAL-016).
     *
     * React Query's `invalidateQueries` with a partial key matches every
     * query whose key starts with the given prefix, so we re-fetch the
     * batch list, detail, tank list, etc. in one pass.
     */
    const handlers: Array<{ event: FarmEventName; fn: () => void }> = (
      Object.keys(INVALIDATION_MAP) as FarmEventName[]
    ).map((event) => ({
      event,
      fn: () => {
        const prefixes = INVALIDATION_MAP[event];
        for (const prefix of prefixes) {
          // SECURITY: Prepend tenant prefix to ensure invalidation is
          // scoped to the active tenant's cache entries only.
          // Use the epoch-LESS invalidation builder: createTenantQueryKey
          // appends {__sessionEpoch} last, which (as a left-prefix filter)
          // lands where stored keys hold their args and makes the realtime
          // invalidation miss any args-bearing list query across generations.
          const tenantScopedKey = createTenantInvalidationKey(tenantId!, ...prefix);
          void queryClient.invalidateQueries({ queryKey: tenantScopedKey });
        }
      },
    }));

    for (const { event, fn } of handlers) {
      socket.on(event, fn);
    }

    return () => {
      socketRef.current = null;
      for (const { event, fn } of handlers) {
        socket.off(event, fn);
      }
      socket.disconnect();
    };
  }, [queryClient, tenantId, token]);
}
