/**
 * useSensorSocket Hook
 *
 * Manages WebSocket connection for real-time sensor data updates.
 * Provides automatic reconnection, authentication, and sensor subscription.
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import type { Socket } from 'socket.io-client';
import { create } from 'zustand';
import { getSocket, releaseSocket } from './socketFactory';

// WebSocket server URL — BUG-021 / SEC-003: use runtime/env config, not hardcoded localhost
const WS_URL =
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_WS_URL) ||
  (typeof window !== 'undefined' && (window as any).__RUNTIME_CONFIG__?.WS_URL) ||
  '/sensors';

export interface SensorReading {
  sensorId: string;
  sensorName: string;
  tenantId: string;
  readings: Record<string, number>;
  timestamp: string;
}

interface SensorSocketState {
  isConnected: boolean;
  lastReading: Map<string, SensorReading>;
  subscribers: Map<string, Set<(reading: SensorReading) => void>>;

  setConnected: (connected: boolean) => void;
  updateReading: (reading: SensorReading) => void;
  subscribe: (sensorId: string, callback: (reading: SensorReading) => void) => () => void;
}

// Global store for sensor readings - shared across all widget instances
export const useSensorStore = create<SensorSocketState>((set, get) => ({
  isConnected: false,
  lastReading: new Map(),
  subscribers: new Map(),

  setConnected: (connected) => set({ isConnected: connected }),

  updateReading: (reading) => {
    const { lastReading, subscribers } = get();

    // Update reading in store
    const newLastReading = new Map(lastReading);
    newLastReading.set(reading.sensorId, reading);
    set({ lastReading: newLastReading });

    // Notify subscribers
    const sensorSubscribers = subscribers.get(reading.sensorId);
    if (sensorSubscribers) {
      sensorSubscribers.forEach((callback) => callback(reading));
    }
  },

  subscribe: (sensorId, callback) => {
    const { subscribers } = get();

    if (!subscribers.has(sensorId)) {
      subscribers.set(sensorId, new Set());
    }
    subscribers.get(sensorId)!.add(callback);

    // Return unsubscribe function
    return () => {
      const subs = subscribers.get(sensorId);
      if (subs) {
        subs.delete(callback);
        if (subs.size === 0) {
          subscribers.delete(sensorId);
        }
      }
    };
  },
}));

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
 * Hook for using real-time sensor data
 */
export function useSensorSocket(sensorIds: string[] = []) {
  const { isConnected, lastReading, subscribe } = useSensorStore();
  const [readings, setReadings] = useState<Map<string, SensorReading>>(new Map());
  const subscribedRef = useRef<Set<string>>(new Set());

  // Initialize socket on first use
  useEffect(() => {
    const socket = getSensorSocket();

    return () => {
      // Cleanup: unsubscribe from sensors when component unmounts
      if (subscribedRef.current.size > 0) {
        unsubscribeFromSensors(Array.from(subscribedRef.current));
      }
      // Release our reference so the pool can clean up when no consumers remain
      releaseSocket(WS_URL);
      listenersAttached = false;
    };
  }, []);

  // Subscribe to sensors
  useEffect(() => {
    if (sensorIds.length === 0) return;

    const newSensorIds = sensorIds.filter((id) => !subscribedRef.current.has(id));

    if (newSensorIds.length > 0 && isConnected) {
      subscribeToSensors(newSensorIds);
      newSensorIds.forEach((id) => subscribedRef.current.add(id));
    }

    // Subscribe to store updates for each sensor
    const unsubscribes = sensorIds.map((sensorId) =>
      subscribe(sensorId, (reading) => {
        setReadings((prev) => {
          const next = new Map(prev);
          next.set(sensorId, reading);
          return next;
        });
      })
    );

    return () => {
      unsubscribes.forEach((unsub) => unsub());
    };
  }, [sensorIds.join(','), isConnected, subscribe]);

  // Get latest reading for a specific sensor
  const getLatestReading = useCallback(
    (sensorId: string): SensorReading | undefined => {
      return readings.get(sensorId) || lastReading.get(sensorId);
    },
    [readings, lastReading]
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
  const { isConnected, readings, getLatestReading } = useSensorSocket(
    sensorId ? [sensorId] : []
  );

  return {
    isConnected,
    reading: getLatestReading(sensorId),
  };
}

export default useSensorSocket;
