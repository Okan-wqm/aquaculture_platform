/**
 * useScadaLiveData Hook
 *
 * Multi-device live data subscription for SCADA widgets.
 * Extends the useEdgeIoSocket pattern for multiple simultaneous device subscriptions.
 *
 * NATS -> Gateway -> Socket.IO -> This hook
 */

import { useEffect, useRef, useMemo, useCallback, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { getSocket, releaseSocket } from './socketFactory';
import { getTenantId, onTenantChange, registerLogoutCleanup } from '@aquaculture/shared-ui';
import type { IoTagValue, IoAlarmEvent } from './useEdgeIoSocket';

export type { IoTagValue, IoAlarmEvent };

const WS_URL =
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_WS_URL) ||
  (typeof window !== 'undefined' && (window as any).__RUNTIME_CONFIG__?.WS_URL) ||
  '/sensors';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

export interface ScadaLiveDataOptions {
  deviceCodes: string[];
  tagNames?: string[];
  enabled?: boolean;
  debounceMs?: number;
}

export interface ScadaLiveDataResult {
  values: Record<string, Record<string, any>>;
  alarms: Record<string, IoAlarmEvent[]>;
  isConnected: boolean;
  connectionStatus: ConnectionStatus;
  lastUpdate: Date | null;
  getTagValue: (deviceCode: string, tagName: string) => any;
}

/**
 * Get or create the shared socket via the pool factory.
 * Token refresh on reconnect is handled by the factory itself.
 */
function getOrCreateScadaSocket(): Socket | null {
  return getSocket(WS_URL);
}

/**
 * SECURITY: Composite key for tenant-partitioned SCADA live data.
 *
 * WHY: the inbound `edgeIoData`/`edgeAlarm` payloads carry only `deviceCode`
 * (no tenantId), and deviceCodes can overlap across tenants. Keying the
 * in-memory value/alarm maps by `${tenantId}:${deviceCode}` makes it
 * structurally impossible for a previous tenant's live values to surface under
 * the current tenant's view after an impersonation / tenant switch. The socket
 * here is the current tenant's pooled `/sensors` connection (socketFactory keys
 * the pool by `${url}::${tenantId}`), so the active tenant owns every payload it
 * receives. Mirrors the tenant-scoped store keys in useSensorSocket.
 */
function tenantScopedKey(tenantId: string, deviceCode: string): string {
  return `${tenantId}:${deviceCode}`;
}

export function useScadaLiveData(options: ScadaLiveDataOptions): ScadaLiveDataResult {
  const { deviceCodes, tagNames, enabled = true, debounceMs = 300 } = options;

  // SECURITY: read the active tenant on every render so a tenant switch re-runs
  // the subscription effect (currentTenantId is in its dep array) and the
  // value/alarm maps are read/written under the new tenant's partition.
  const currentTenantId = getTenantId();

  // SECURITY: maps are keyed by `${tenantId}:${deviceCode}` (see tenantScopedKey),
  // never bare deviceCode, so overlapping deviceCodes across tenants cannot collide.
  const valuesRef = useRef<Record<string, Record<string, any>>>({});
  const alarmsRef = useRef<Record<string, IoAlarmEvent[]>>({});
  const subscribedCodesRef = useRef<Set<string>>(new Set());
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectionStatusRef = useRef<ConnectionStatus>('disconnected');
  const lastUpdateRef = useRef<Date | null>(null);

  // Force re-render trigger
  const [, setTick] = useState(0);
  const forceUpdate = useCallback(() => setTick((t) => t + 1), []);

  // Stable device codes key for dependency tracking
  const deviceCodesKey = useMemo(() => [...deviceCodes].sort().join(','), [deviceCodes]);
  const tagNamesKey = useMemo(() => (tagNames ? [...tagNames].sort().join(',') : ''), [tagNames]);

  useEffect(() => {
    if (!enabled || deviceCodes.length === 0) {
      connectionStatusRef.current = 'disconnected';
      forceUpdate();
      return;
    }

    const socket = getOrCreateScadaSocket();
    if (!socket) {
      connectionStatusRef.current = 'disconnected';
      forceUpdate();
      return;
    }

    const targetCodes = new Set(deviceCodes);
    const tagFilter = tagNames && tagNames.length > 0 ? new Set(tagNames) : null;

    // Debounced subscription management
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = setTimeout(() => {
      // Unsubscribe from devices no longer needed
      for (const code of subscribedCodesRef.current) {
        if (!targetCodes.has(code) && socket.connected) {
          socket.emit('unsubscribeEdgeIo', { deviceCode: code });
        }
      }

      // Subscribe to new devices
      for (const code of targetCodes) {
        if (!subscribedCodesRef.current.has(code) && socket.connected) {
          socket.emit('subscribeEdgeIo', { deviceCode: code });
        }
      }

      subscribedCodesRef.current = targetCodes;
    }, debounceMs);

    // Connection status handlers
    const handleConnect = () => {
      connectionStatusRef.current = 'connected';
      forceUpdate();
      // Re-subscribe all after reconnect
      for (const code of subscribedCodesRef.current) {
        socket.emit('subscribeEdgeIo', { deviceCode: code });
      }
    };

    const handleDisconnect = () => {
      connectionStatusRef.current = 'disconnected';
      forceUpdate();
    };

    const handleReconnectAttempt = () => {
      connectionStatusRef.current = 'reconnecting';
      forceUpdate();
    };

    const handleConnectError = () => {
      if (connectionStatusRef.current !== 'reconnecting') {
        connectionStatusRef.current = 'connecting';
      }
      forceUpdate();
    };

    // Data handlers
    const handleIoData = (data: {
      deviceCode: string;
      tags: Record<string, IoTagValue>;
      timestamp: string;
    }) => {
      if (!subscribedCodesRef.current.has(data.deviceCode)) return;

      let filteredTags: Record<string, any>;
      if (tagFilter) {
        filteredTags = {};
        for (const [key, val] of Object.entries(data.tags)) {
          if (tagFilter.has(key)) {
            filteredTags[key] = val;
          }
        }
      } else {
        filteredTags = data.tags;
      }

      // SECURITY: store under the tenant-scoped key. currentTenantId is captured
      // from the effect run (it is in the dep array), so it matches the tenant
      // whose pooled socket delivered this payload.
      if (!currentTenantId) return;
      const valueKey = tenantScopedKey(currentTenantId, data.deviceCode);
      valuesRef.current = {
        ...valuesRef.current,
        [valueKey]: {
          ...valuesRef.current[valueKey],
          ...filteredTags,
        },
      };
      lastUpdateRef.current = new Date();
      forceUpdate();
    };

    const handleAlarm = (data: {
      deviceCode: string;
      alarms: IoAlarmEvent[];
      timestamp: string;
    }) => {
      if (!subscribedCodesRef.current.has(data.deviceCode)) return;

      // SECURITY: alarms partitioned by the same tenant-scoped key as values.
      if (!currentTenantId) return;
      const alarmKey = tenantScopedKey(currentTenantId, data.deviceCode);
      const existing = alarmsRef.current[alarmKey] ?? [];
      alarmsRef.current = {
        ...alarmsRef.current,
        [alarmKey]: [...data.alarms, ...existing].slice(0, 100),
      };
      forceUpdate();
    };

    // Set initial connection status
    if (socket.connected) {
      connectionStatusRef.current = 'connected';
    } else {
      connectionStatusRef.current = 'connecting';
    }
    forceUpdate();

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('reconnect_attempt', handleReconnectAttempt);
    socket.on('connect_error', handleConnectError);
    socket.on('edgeIoData', handleIoData);
    socket.on('edgeAlarm', handleAlarm);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }

      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('reconnect_attempt', handleReconnectAttempt);
      socket.off('connect_error', handleConnectError);
      socket.off('edgeIoData', handleIoData);
      socket.off('edgeAlarm', handleAlarm);

      // Unsubscribe all
      for (const code of subscribedCodesRef.current) {
        if (socket.connected) {
          socket.emit('unsubscribeEdgeIo', { deviceCode: code });
        }
      }
      subscribedCodesRef.current = new Set();

      // Release our reference so the pool can clean up when no consumers remain.
      // Release by the socket INSTANCE we acquired (ORPHAN-MEDIUM-213) — never by
      // WS_URL+ambient tenant, which would mis-target after a tenant switch.
      releaseSocket(socket);
    };
    // SECURITY: currentTenantId is a dependency so a tenant switch tears down the
    // previous tenant's subscription/listeners and re-binds against the new
    // tenant's pooled socket.
  }, [deviceCodesKey, tagNamesKey, enabled, debounceMs, forceUpdate, currentTenantId]);

  // SECURITY: purge a departing tenant's cached values/alarms on tenant switch,
  // and wipe everything on logout, so no SCADA live data outlives its tenant
  // session (defense-in-depth atop the tenant-scoped keys; mirrors the
  // useSensorStore clearTenant / clearAll contract).
  useEffect(() => {
    const purgeTenant = (tenantIdToClear: string): void => {
      const prefix = `${tenantIdToClear}:`;
      for (const key of Object.keys(valuesRef.current)) {
        if (key.startsWith(prefix)) delete valuesRef.current[key];
      }
      for (const key of Object.keys(alarmsRef.current)) {
        if (key.startsWith(prefix)) delete alarmsRef.current[key];
      }
      forceUpdate();
    };
    const unregisterTenantChange = onTenantChange(purgeTenant);
    const unregisterLogout = registerLogoutCleanup(() => {
      valuesRef.current = {};
      alarmsRef.current = {};
      forceUpdate();
    });
    return () => {
      unregisterTenantChange();
      unregisterLogout();
    };
  }, [forceUpdate]);

  const getTagValue = useCallback(
    (deviceCode: string, tagName: string): any => {
      // SECURITY: read only the current tenant's partition.
      const tenant = getTenantId();
      if (!tenant) return undefined;
      const deviceValues = valuesRef.current[tenantScopedKey(tenant, deviceCode)];
      if (!deviceValues) return undefined;
      const tag = deviceValues[tagName];
      if (!tag) return undefined;
      return typeof tag === 'object' && 'value' in tag ? tag.value : tag;
    },
    []
  );

  // SECURITY: expose only the current tenant's slice, projected back to bare
  // deviceCode keys so the public contract (values[deviceCode] / alarms[deviceCode])
  // is unchanged while storage stays tenant-partitioned.
  const tenantPrefix = currentTenantId ? `${currentTenantId}:` : null;
  const values: Record<string, Record<string, any>> = {};
  const alarms: Record<string, IoAlarmEvent[]> = {};
  if (tenantPrefix) {
    for (const [key, val] of Object.entries(valuesRef.current)) {
      if (key.startsWith(tenantPrefix)) values[key.slice(tenantPrefix.length)] = val;
    }
    for (const [key, val] of Object.entries(alarmsRef.current)) {
      if (key.startsWith(tenantPrefix)) alarms[key.slice(tenantPrefix.length)] = val;
    }
  }

  return {
    values,
    alarms,
    isConnected: connectionStatusRef.current === 'connected',
    connectionStatus: connectionStatusRef.current,
    lastUpdate: lastUpdateRef.current,
    getTagValue,
  };
}

export default useScadaLiveData;
