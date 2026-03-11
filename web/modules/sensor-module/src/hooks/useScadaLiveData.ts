/**
 * useScadaLiveData Hook
 *
 * Multi-device live data subscription for SCADA widgets.
 * Extends the useEdgeIoSocket pattern for multiple simultaneous device subscriptions.
 *
 * NATS -> Gateway -> Socket.IO -> This hook
 */

import { useEffect, useRef, useMemo, useCallback, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { getAccessToken } from '@aquaculture/shared-ui';
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

const MAX_RECONNECT_ATTEMPTS = 10;

// Singleton socket for SCADA live data (reuses same /sensors namespace)
let scadaSocket: Socket | null = null;
let socketRefCount = 0;

function getOrCreateScadaSocket(): Socket | null {
  const token = getAccessToken();
  if (!token) return null;

  if (scadaSocket && scadaSocket.connected) {
    return scadaSocket;
  }

  // If there's a disconnected socket, clean it up
  if (scadaSocket) {
    scadaSocket.removeAllListeners();
    scadaSocket.disconnect();
    scadaSocket = null;
  }

  scadaSocket = io(WS_URL, {
    auth: { token },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: MAX_RECONNECT_ATTEMPTS,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
  });

  // Refresh token on reconnect attempts
  scadaSocket.on('reconnect_attempt', () => {
    const freshToken = getAccessToken();
    if (freshToken && scadaSocket) {
      (scadaSocket as any).auth = { token: freshToken };
    }
  });

  return scadaSocket;
}

export function useScadaLiveData(options: ScadaLiveDataOptions): ScadaLiveDataResult {
  const { deviceCodes, tagNames, enabled = true, debounceMs = 300 } = options;

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

    socketRefCount++;

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

      valuesRef.current = {
        ...valuesRef.current,
        [data.deviceCode]: {
          ...valuesRef.current[data.deviceCode],
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

      const existing = alarmsRef.current[data.deviceCode] ?? [];
      alarmsRef.current = {
        ...alarmsRef.current,
        [data.deviceCode]: [...data.alarms, ...existing].slice(0, 100),
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

      // Disconnect singleton when no consumers remain
      socketRefCount--;
      if (socketRefCount === 0 && scadaSocket) {
        scadaSocket.disconnect();
        scadaSocket = null;
      }
    };
  }, [deviceCodesKey, tagNamesKey, enabled, debounceMs, forceUpdate]);

  const getTagValue = useCallback(
    (deviceCode: string, tagName: string): any => {
      const deviceValues = valuesRef.current[deviceCode];
      if (!deviceValues) return undefined;
      const tag = deviceValues[tagName];
      if (!tag) return undefined;
      return typeof tag === 'object' && 'value' in tag ? tag.value : tag;
    },
    []
  );

  return {
    values: valuesRef.current,
    alarms: alarmsRef.current,
    isConnected: connectionStatusRef.current === 'connected',
    connectionStatus: connectionStatusRef.current,
    lastUpdate: lastUpdateRef.current,
    getTagValue,
  };
}

export default useScadaLiveData;
