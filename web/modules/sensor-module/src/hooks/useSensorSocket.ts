/**
 * useSensorSocket Hook
 *
 * Manages WebSocket connection for real-time sensor data updates.
 * Provides automatic reconnection, authentication, and sensor subscription.
 *
 * SECURITY: All store keys are tenant-scoped (`${tenantId}:${sensorId}`) to
 * prevent cross-tenant SCADA data leaks during impersonation or tenant switch.
 */

import { isDuplicateReading } from './reading-dedup';
import { useEffect, useRef, useCallback, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { create } from 'zustand';
import { getSocket, releaseSocket } from './socketFactory';
import { getTenantId, registerLogoutCleanup, onTenantChange } from '@aquaculture/shared-ui';

// WebSocket server URL — BUG-021 / SEC-003: use runtime/env config, not hardcoded localhost
const WS_URL =
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_WS_URL) ||
  (typeof window !== 'undefined' && (window as any).__RUNTIME_CONFIG__?.WS_URL) ||
  '/sensors';

export interface SensorReading {
  /** Deterministic source identity (Task 1.4); older payloads omit it. */
  eventId?: string;
  sensorId: string;
  sensorName: string;
  tenantId: string;
  readings: Record<string, number>;
  timestamp: string;
}

/**
 * SECURITY: Composite key for tenant-partitioned sensor data.
 * Prevents cross-tenant data leaks when overlapping sensorIds exist
 * across tenants (e.g., during admin impersonation / tenant switch).
 */
function tenantScopedKey(tenantId: string, sensorId: string): string {
  return `${tenantId}:${sensorId}`;
}

interface SensorSocketState {
  isConnected: boolean;
  /** SECURITY: Keys are `${tenantId}:${sensorId}` — never bare sensorId */
  lastReading: Map<string, SensorReading>;
  subscribers: Map<string, Set<(reading: SensorReading) => void>>;

  setConnected: (connected: boolean) => void;
  updateReading: (reading: SensorReading) => void;
  subscribe: (sensorId: string, callback: (reading: SensorReading) => void) => () => void;
  /**
   * SECURITY: Remove all cached data for a specific tenant.
   * Must be called on tenant switch and logout to prevent data leaks.
   */
  clearTenant: (tenantId: string) => void;
  /** SECURITY: Remove ALL cached data across all tenants (used on logout). */
  clearAll: () => void;
}

// Global store for sensor readings - shared across all widget instances
export const useSensorStore = create<SensorSocketState>((set, get) => ({
  isConnected: false,
  lastReading: new Map(),
  subscribers: new Map(),

  setConnected: (connected) => set({ isConnected: connected }),

  updateReading: (reading) => {
    const { lastReading, subscribers } = get();
    const key = tenantScopedKey(reading.tenantId, reading.sensorId);

    // SECURITY: Update reading under tenant-scoped key
    const newLastReading = new Map(lastReading);
    newLastReading.set(key, reading);
    set({ lastReading: newLastReading });

    // Notify subscribers (subscribers use tenant-scoped keys)
    const sensorSubscribers = subscribers.get(key);
    if (sensorSubscribers) {
      sensorSubscribers.forEach((callback) => callback(reading));
    }
  },

  subscribe: (sensorId, callback) => {
    // SECURITY: Scope subscription key by current tenant
    const currentTenantId = getTenantId();
    if (!currentTenantId) return () => {};

    const key = tenantScopedKey(currentTenantId, sensorId);
    const { subscribers } = get();

    if (!subscribers.has(key)) {
      subscribers.set(key, new Set());
    }
    subscribers.get(key)!.add(callback);

    // Return unsubscribe function
    return () => {
      const subs = subscribers.get(key);
      if (subs) {
        subs.delete(callback);
        if (subs.size === 0) {
          subscribers.delete(key);
        }
      }
    };
  },

  clearTenant: (tenantIdToClear) => {
    const { lastReading, subscribers } = get();
    const prefix = `${tenantIdToClear}:`;

    // SECURITY: Purge all readings belonging to the cleared tenant
    const newLastReading = new Map(lastReading);
    for (const key of lastReading.keys()) {
      if (key.startsWith(prefix)) {
        newLastReading.delete(key);
      }
    }

    // SECURITY: Purge all subscriber entries for the cleared tenant
    const newSubscribers = new Map(subscribers);
    for (const key of subscribers.keys()) {
      if (key.startsWith(prefix)) {
        newSubscribers.delete(key);
      }
    }

    set({ lastReading: newLastReading, subscribers: newSubscribers });
  },

  clearAll: () => {
    set({ lastReading: new Map(), subscribers: new Map() });
  },
}));

// SECURITY: Register store cleanup for logout — ensures no SCADA data persists after logout
registerLogoutCleanup(() => useSensorStore.getState().clearAll());

// SECURITY: On tenant switch, clear the previous tenant's cached readings
onTenantChange((oldTenantId) => useSensorStore.getState().clearTenant(oldTenantId));

// Module-level flag to track whether event listeners have been bound
let listenersAttached = false;
let connectionAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

/**
 * Get or create the shared socket instance via the pool factory
 * and attach sensor-specific event listeners once.
 */
function getSensorSocket(): Socket | null {
  const socket = getSocket(WS_URL);
  if (!socket) return null;

  // Attach domain-specific listeners only once per socket lifetime
  if (!listenersAttached) {
    listenersAttached = true;

    socket.on('connect', () => {
      connectionAttempts = 0;
      useSensorStore.getState().setConnected(true);
    });

    socket.on('disconnect', (_reason) => {
      useSensorStore.getState().setConnected(false);
    });

    socket.on('connect_error', (error) => {
      console.warn('[SensorSocket] Connection error:', error.message);
      connectionAttempts++;

      if (connectionAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.error('[SensorSocket] Max reconnection attempts reached');
      }
    });

    socket.on('sensorReading', (reading: SensorReading) => {
      // Task 1.5: the reconnect window re-broadcasts the backlog — collapse
      // re-deliveries of the same logical reading by its deterministic id.
      if (isDuplicateReading(reading)) {
        return;
      }
      useSensorStore.getState().updateReading(reading);
    });

    socket.on('error', (error: { message: string }) => {
      console.error('[SensorSocket] Error:', error.message);
    });
  }

  return socket;
}

/**
 * Subscribe to specific sensors via WebSocket
 */
function subscribeToSensors(sensorIds: string[]): void {
  const socket = getSensorSocket();
  if (!socket || !socket.connected) {
    console.warn('[SensorSocket] Cannot subscribe - not connected');
    return;
  }

  socket.emit('subscribe', { sensorIds });
}

/**
 * Unsubscribe from sensors via WebSocket
 */
function unsubscribeFromSensors(sensorIds: string[]): void {
  const socket = getSensorSocket();
  if (!socket || !socket.connected) return;

  socket.emit('unsubscribe', { sensorIds });
}

/**
 * Hook for using real-time sensor data.
 *
 * SECURITY: All store reads are scoped by the current tenantId to prevent
 * cross-tenant data leaks during impersonation or tenant switch.
 */
export function useSensorSocket(sensorIds: string[] = []) {
  const { isConnected, lastReading, subscribe } = useSensorStore();
  const [readings, setReadings] = useState<Map<string, SensorReading>>(new Map());
  const subscribedRef = useRef<Set<string>>(new Set());

  // SECURITY: Read tenant ID on every render so tenant switches are reflected
  const currentTenantId = getTenantId();

  // Initialize socket on first use
  useEffect(() => {
    const socket = getSensorSocket();

    return () => {
      // Cleanup: unsubscribe from sensors when component unmounts
      if (subscribedRef.current.size > 0) {
        unsubscribeFromSensors(Array.from(subscribedRef.current));
      }
      // Release our reference (by socket identity) so the pool can clean up when no
      // consumers remain — immune to a tenant switch between acquire and release.
      releaseSocket(socket);
      listenersAttached = false;
    };
  }, []);

  // Subscribe to sensors
  useEffect(() => {
    if (sensorIds.length === 0 || !currentTenantId) return;

    const newSensorIds = sensorIds.filter((id) => !subscribedRef.current.has(id));

    if (newSensorIds.length > 0 && isConnected) {
      subscribeToSensors(newSensorIds);
      newSensorIds.forEach((id) => subscribedRef.current.add(id));
    }

    // Subscribe to store updates for each sensor (subscribe internally scopes by tenant)
    const unsubscribes = sensorIds.map((sensorId) =>
      subscribe(sensorId, (reading) => {
        setReadings((prev) => {
          const next = new Map(prev);
          next.set(sensorId, reading);
          return next;
        });
      }),
    );

    return () => {
      unsubscribes.forEach((unsub) => unsub());
    };
  }, [sensorIds.join(','), isConnected, subscribe, currentTenantId]);

  // SECURITY: Get latest reading scoped by current tenant
  const getLatestReading = useCallback(
    (sensorId: string): SensorReading | undefined => {
      if (!currentTenantId) return undefined;
      const key = tenantScopedKey(currentTenantId, sensorId);
      return readings.get(sensorId) || lastReading.get(key);
    },
    [readings, lastReading, currentTenantId],
  );

  return {
    isConnected,
    readings,
    getLatestReading,
  };
}

/**
 * Hook for a single sensor's real-time data
 */
export function useSingleSensorSocket(sensorId: string) {
  const { isConnected, readings, getLatestReading } = useSensorSocket(sensorId ? [sensorId] : []);

  return {
    isConnected,
    reading: getLatestReading(sensorId),
  };
}

export default useSensorSocket;
