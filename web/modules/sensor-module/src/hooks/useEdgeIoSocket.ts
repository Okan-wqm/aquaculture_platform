/**
 * useEdgeIoSocket Hook
 *
 * Manages WebSocket subscription for real-time edge device I/O data and alarms.
 * Uses Zustand store (like useSensorSocket) for cross-component state sharing.
 *
 * NATS -> Gateway -> Socket.IO -> This hook
 *
 * Events:
 *   subscribeEdgeIo({ deviceCode }) -> edgeIoData({ deviceCode, tags, timestamp })
 *   edgeAlarm({ deviceCode, alarms, timestamp })
 *
 * SECURITY: All store keys are tenant-scoped (`${tenantId}:${deviceCode}`) to
 * prevent cross-tenant SCADA/IO data leaks during impersonation or tenant switch.
 */

import { useEffect, useRef } from 'react';
import type { Socket } from 'socket.io-client';
import { create } from 'zustand';
import { getSocket, releaseSocket } from './socketFactory';
import { getTenantId, registerLogoutCleanup, onTenantChange } from '@aquaculture/shared-ui';

// Same WS_URL resolution as useSensorSocket
const WS_URL =
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_WS_URL) ||
  (typeof window !== 'undefined' && (window as any).__RUNTIME_CONFIG__?.WS_URL) ||
  '/sensors';

/** Single tag value from edge device I/O data */
export interface IoTagValue {
  value: number | boolean | string;
  quality?: 'good' | 'uncertain' | 'bad' | 'comm_failure' | 'not_initialized';
  timestamp?: string;
}

/** Alarm event from edge device */
export interface IoAlarmEvent {
  tag: string;
  type: string;
  priority: string;
  state: string;
  value: number;
  setpoint: number;
  message: string;
}

/** Legacy alarm type alias for backward compatibility */
export type EdgeAlarm = IoAlarmEvent;

/**
 * SECURITY: Composite key for tenant-partitioned edge I/O data.
 * Prevents cross-tenant data leaks when overlapping deviceCodes exist
 * across tenants (e.g., during admin impersonation / tenant switch).
 */
function tenantScopedKey(tenantId: string, deviceCode: string): string {
  return `${tenantId}:${deviceCode}`;
}

interface EdgeIoState {
  /** SECURITY: Keys are `${tenantId}:${deviceCode}` — never bare deviceCode */
  devices: Map<string, Record<string, IoTagValue>>;
  /** SECURITY: Keys are `${tenantId}:${deviceCode}` — never bare deviceCode */
  alarms: Map<string, IoAlarmEvent[]>;
  /** Connection status */
  isConnected: boolean;
  /** Update tags for a device (tenant-scoped) */
  updateTags: (tenantId: string, deviceCode: string, tags: Record<string, IoTagValue>) => void;
  /** Add alarm events (tenant-scoped) */
  addAlarms: (tenantId: string, deviceCode: string, alarms: IoAlarmEvent[]) => void;
  /** Set connection status */
  setConnected: (connected: boolean) => void;
  /**
   * SECURITY: Remove all cached data for a specific tenant.
   * Must be called on tenant switch and logout to prevent data leaks.
   */
  clearTenant: (tenantId: string) => void;
  /** SECURITY: Remove ALL cached data across all tenants (used on logout). */
  clearAll: () => void;
}

// Global store for edge I/O data - shared across all component instances
export const useEdgeIoStore = create<EdgeIoState>((set) => ({
  devices: new Map(),
  alarms: new Map(),
  isConnected: false,
  updateTags: (tenantId, deviceCode, tags) =>
    set((state) => {
      const key = tenantScopedKey(tenantId, deviceCode);
      const newDevices = new Map(state.devices);
      newDevices.set(key, tags);
      return { devices: newDevices };
    }),
  addAlarms: (tenantId, deviceCode, newAlarms) =>
    set((state) => {
      const key = tenantScopedKey(tenantId, deviceCode);
      const alarmsMap = new Map(state.alarms);
      const existing = alarmsMap.get(key) ?? [];
      // Keep last 100 alarms per device
      const combined = [...newAlarms, ...existing].slice(0, 100);
      alarmsMap.set(key, combined);
      return { alarms: alarmsMap };
    }),
  setConnected: (connected) => set({ isConnected: connected }),
  clearTenant: (tenantIdToClear) =>
    set((state) => {
      const prefix = `${tenantIdToClear}:`;

      // SECURITY: Purge all device data belonging to the cleared tenant
      const newDevices = new Map(state.devices);
      for (const key of state.devices.keys()) {
        if (key.startsWith(prefix)) {
          newDevices.delete(key);
        }
      }

      // SECURITY: Purge all alarm data belonging to the cleared tenant
      const newAlarms = new Map(state.alarms);
      for (const key of state.alarms.keys()) {
        if (key.startsWith(prefix)) {
          newAlarms.delete(key);
        }
      }

      return { devices: newDevices, alarms: newAlarms };
    }),
  clearAll: () =>
    set({ devices: new Map(), alarms: new Map() }),
}));

// SECURITY: Register store cleanup for logout — ensures no edge I/O data persists after logout
registerLogoutCleanup(() => useEdgeIoStore.getState().clearAll());

// SECURITY: On tenant switch, clear the previous tenant's cached edge I/O data
onTenantChange((oldTenantId) => useEdgeIoStore.getState().clearTenant(oldTenantId));

let edgeListenersAttached = false;
let connectionAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

function getOrCreateSocket(): Socket | null {
  const socket = getSocket(WS_URL);
  if (!socket) return null;

  // Attach edge-specific connection listeners only once
  if (!edgeListenersAttached) {
    edgeListenersAttached = true;

    socket.on('connect', () => {
      connectionAttempts = 0;
      useEdgeIoStore.getState().setConnected(true);
    });

    socket.on('disconnect', () => {
      useEdgeIoStore.getState().setConnected(false);
    });

    socket.on('connect_error', (error) => {
      console.warn('[EdgeIoSocket] Connection error:', error.message);
      connectionAttempts++;
      if (connectionAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.error('[EdgeIoSocket] Max reconnection attempts reached');
      }
    });
  }

  return socket;
}

/**
 * Hook for subscribing to live I/O data from an edge device.
 *
 * Uses the same Socket.IO namespace (/sensors) as useSensorSocket.
 * State is stored in a Zustand store shared across all component instances.
 *
 * SECURITY: All store reads/writes are tenant-scoped to prevent cross-tenant
 * data leaks during admin impersonation or tenant switch.
 *
 * @param deviceCode - Edge device code to subscribe to (undefined/null = no subscription)
 * @returns { tags, alarms, isConnected }
 */
export function useEdgeIoSocket(deviceCode?: string | null) {
  const { devices, alarms, isConnected, updateTags, addAlarms, setConnected } =
    useEdgeIoStore();
  const subscribedRef = useRef<string | null>(null);

  // SECURITY: Read tenant ID on every render so tenant switches are reflected
  const currentTenantId = getTenantId();

  useEffect(() => {
    if (!deviceCode || !currentTenantId) return;

    const socket = getOrCreateSocket();
    if (!socket) return;

    // Subscribe to this device's I/O room
    if (socket.connected) {
      socket.emit('subscribeEdgeIo', { deviceCode });
    }
    subscribedRef.current = deviceCode;

    const handleIoData = (data: {
      deviceCode: string;
      tags: Record<string, IoTagValue>;
      timestamp: string;
    }) => {
      if (data.deviceCode === deviceCode) {
        // SECURITY: Store under tenant-scoped key using the current tenant
        const tid = getTenantId();
        if (tid) {
          updateTags(tid, data.deviceCode, data.tags);
        }
      }
    };

    const handleAlarm = (data: {
      deviceCode: string;
      alarms: IoAlarmEvent[];
      timestamp: string;
    }) => {
      if (data.deviceCode === deviceCode) {
        // SECURITY: Store under tenant-scoped key using the current tenant
        const tid = getTenantId();
        if (tid) {
          addAlarms(tid, data.deviceCode, data.alarms);
        }
      }
    };

    const handleConnect = () => {
      setConnected(true);
      // Re-subscribe after reconnect
      if (subscribedRef.current) {
        socket.emit('subscribeEdgeIo', { deviceCode: subscribedRef.current });
      }
    };

    socket.on('edgeIoData', handleIoData);
    socket.on('edgeAlarm', handleAlarm);
    socket.on('connect', handleConnect);

    return () => {
      socket.off('edgeIoData', handleIoData);
      socket.off('edgeAlarm', handleAlarm);
      socket.off('connect', handleConnect);

      if (subscribedRef.current && socket.connected) {
        socket.emit('unsubscribeEdgeIo', { deviceCode: subscribedRef.current });
      }
      subscribedRef.current = null;

      // Release our reference (by socket identity) so the pool can clean up when no
      // consumers remain — immune to a tenant switch between acquire and release.
      releaseSocket(socket);
      edgeListenersAttached = false;
    };
  }, [deviceCode, currentTenantId, updateTags, addAlarms, setConnected]);

  // SECURITY: Read from tenant-scoped key only
  const key = (currentTenantId && deviceCode) ? tenantScopedKey(currentTenantId, deviceCode) : null;
  const tags = key ? devices.get(key) ?? null : null;
  const deviceAlarms = key ? alarms.get(key) ?? [] : [];

  return { tags, alarms: deviceAlarms, isConnected };
}

export default useEdgeIoSocket;
