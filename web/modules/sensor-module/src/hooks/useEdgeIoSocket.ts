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
 */

import { useEffect, useRef } from 'react';
import type { Socket } from 'socket.io-client';
import { create } from 'zustand';
import { getSocket, releaseSocket } from './socketFactory';

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

interface EdgeIoState {
  /** Map of deviceCode -> tag values */
  devices: Map<string, Record<string, IoTagValue>>;
  /** Map of deviceCode -> recent alarm events */
  alarms: Map<string, IoAlarmEvent[]>;
  /** Connection status */
  isConnected: boolean;
  /** Update tags for a device */
  updateTags: (deviceCode: string, tags: Record<string, IoTagValue>) => void;
  /** Add alarm events */
  addAlarms: (deviceCode: string, alarms: IoAlarmEvent[]) => void;
  /** Set connection status */
  setConnected: (connected: boolean) => void;
}

// Global store for edge I/O data - shared across all component instances
export const useEdgeIoStore = create<EdgeIoState>((set) => ({
  devices: new Map(),
  alarms: new Map(),
  isConnected: false,
  updateTags: (deviceCode, tags) =>
    set((state) => {
      const newDevices = new Map(state.devices);
      newDevices.set(deviceCode, tags);
      return { devices: newDevices };
    }),
  addAlarms: (deviceCode, newAlarms) =>
    set((state) => {
      const alarmsMap = new Map(state.alarms);
      const existing = alarmsMap.get(deviceCode) ?? [];
      // Keep last 100 alarms per device
      const combined = [...newAlarms, ...existing].slice(0, 100);
      alarmsMap.set(deviceCode, combined);
      return { alarms: alarmsMap };
    }),
  setConnected: (connected) => set({ isConnected: connected }),
}));

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
 * @param deviceCode - Edge device code to subscribe to (undefined/null = no subscription)
 * @returns { tags, alarms, isConnected }
 */
export function useEdgeIoSocket(deviceCode?: string | null) {
  const { devices, alarms, isConnected, updateTags, addAlarms, setConnected } =
    useEdgeIoStore();
  const subscribedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!deviceCode) return;

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
        updateTags(data.deviceCode, data.tags);
      }
    };

    const handleAlarm = (data: {
      deviceCode: string;
      alarms: IoAlarmEvent[];
      timestamp: string;
    }) => {
      if (data.deviceCode === deviceCode) {
        addAlarms(data.deviceCode, data.alarms);
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

      // Release our reference so the pool can clean up when no consumers remain
      releaseSocket(WS_URL);
      edgeListenersAttached = false;
    };
  }, [deviceCode, updateTags, addAlarms, setConnected]);

  const tags = deviceCode ? devices.get(deviceCode) ?? null : null;
  const deviceAlarms = deviceCode ? alarms.get(deviceCode) ?? [] : [];

  return { tags, alarms: deviceAlarms, isConnected };
}

export default useEdgeIoSocket;
