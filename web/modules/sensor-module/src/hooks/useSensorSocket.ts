/**
 * useSensorSocket Hook
 *
 * Manages WebSocket connection for real-time sensor data updates.
 * Provides automatic reconnection, authentication, and sensor subscription.
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { create } from 'zustand';

// WebSocket server URL - uses same host as API
const WS_URL = 'http://localhost:3000/sensors';

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

// Singleton socket instance
let socketInstance: Socket | null = null;
let connectionAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

/**
 * Initialize WebSocket connection
 */
function initializeSocket(): Socket | null {
  const token = localStorage.getItem('access_token');

  if (!token) {
    console.warn('[SensorSocket] No access token found, skipping connection');
    return null;
  }

  if (socketInstance && socketInstance.connected) {
    return socketInstance;
  }

  console.log('[SensorSocket] Initializing WebSocket connection');

  socketInstance = io(WS_URL, {
    auth: { token },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: MAX_RECONNECT_ATTEMPTS,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
  });

  socketInstance.on('connect', () => {
    console.log('[SensorSocket] Connected');
    connectionAttempts = 0;
    useSensorStore.getState().setConnected(true);
  });

  socketInstance.on('disconnect', (reason) => {
    console.log('[SensorSocket] Disconnected:', reason);
    useSensorStore.getState().setConnected(false);
  });

  socketInstance.on('connect_error', (error) => {
    console.warn('[SensorSocket] Connection error:', error.message);
    connectionAttempts++;

    if (connectionAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error('[SensorSocket] Max reconnection attempts reached');
    }
  });

  socketInstance.on('sensorReading', (reading: SensorReading) => {
    console.debug('[SensorSocket] Received reading:', reading.sensorId);
    useSensorStore.getState().updateReading(reading);
  });

  socketInstance.on('error', (error: { message: string }) => {
    console.error('[SensorSocket] Error:', error.message);
  });

  return socketInstance;
}

/**
 * Get or create socket instance
 */
function getSocket(): Socket | null {
  if (!socketInstance || !socketInstance.connected) {
    return initializeSocket();
  }
  return socketInstance;
}

/**
 * Subscribe to specific sensors via WebSocket
 */
function subscribeToSensors(sensorIds: string[]): void {
  const socket = getSocket();
  if (!socket || !socket.connected) {
    console.warn('[SensorSocket] Cannot subscribe - not connected');
    return;
  }

  socket.emit('subscribe', { sensorIds }, (response: { success: boolean; subscribedTo: string[] }) => {
    if (response.success) {
      console.log('[SensorSocket] Subscribed to sensors:', response.subscribedTo);
    }
  });
}

/**
 * Unsubscribe from sensors via WebSocket
 */
function unsubscribeFromSensors(sensorIds: string[]): void {
  const socket = getSocket();
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
    const socket = getSocket();

    return () => {
      // Cleanup: unsubscribe from sensors when component unmounts
      if (subscribedRef.current.size > 0) {
        unsubscribeFromSensors(Array.from(subscribedRef.current));
      }
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
