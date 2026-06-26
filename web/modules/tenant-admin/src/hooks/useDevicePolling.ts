import { useRef, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { graphqlRequest } from '../services/tenant-api.service';

interface EdgeDevice {
  id: string;
  tenantId: string;
  siteId?: string;
  deviceCode: string;
  deviceName: string;
  deviceModel: string;
  serialNumber?: string;
  description?: string;
  lifecycleState: string;
  mqttClientId?: string;
  agentVersion?: string;
  lastSeenAt?: string;
  isOnline: boolean;
  ipAddress?: string;
  firmwareVersion?: string;
  cpuUsage?: number;
  memoryUsage?: number;
  storageUsage?: number;
  temperatureCelsius?: number;
  uptimeSeconds?: number;
  connectionQuality?: number;
  config?: Record<string, unknown>;
  capabilities?: Record<string, boolean>;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
  sensorCount?: number;
  programCount?: number;
  activeAlarmCount?: number;
  ioConfig?: Array<{
    id: string;
    tagName: string;
    ioType: string;
    dataType: string;
    unit?: string;
    isActive: boolean;
  }>;
}

const EDGE_DEVICE_QUERY = `
  query EdgeDevice($id: ID!) {
    edgeDevice(id: $id) {
      id
      tenantId
      siteId
      deviceCode
      deviceName
      deviceModel
      serialNumber
      description
      lifecycleState
      mqttClientId
      agentVersion
      lastSeenAt
      isOnline
      ipAddress
      firmwareVersion
      cpuUsage
      memoryUsage
      storageUsage
      temperatureCelsius
      uptimeSeconds
      connectionQuality
      config
      capabilities
      tags
      createdAt
      updatedAt
      sensorCount
      programCount
      activeAlarmCount
      ioConfig {
        id
        tagName
        ioType
        dataType
        isActive
      }
    }
  }
`;

async function fetchDeviceData(deviceId: string): Promise<EdgeDevice | null> {
  const result = await graphqlRequest<{ edgeDevice: EdgeDevice | null }>(
    EDGE_DEVICE_QUERY,
    { id: deviceId },
  );
  return result.edgeDevice ?? null;
}

/** Maximum backoff cap: 60 seconds. */
const MAX_BACKOFF_MS = 60_000;

/**
 * Hook for polling edge device data at regular intervals.
 *
 * Uses TanStack Query's refetchInterval instead of manual setInterval.
 * PERF-003: TanStack Query handles initial vs. background fetches natively --
 * isLoading is true only for the first fetch, isFetching is true for refetches.
 *
 * LOW-08: Exponential backoff on error -- consecutive failures double the
 * polling interval (capped at MAX_BACKOFF_MS). A successful fetch resets
 * the interval back to the base value.
 */
export function useDevicePolling(deviceId: string, intervalMs = 5000) {
  const consecutiveErrors = useRef(0);

  const getBackoffInterval = useCallback((): number => {
    if (consecutiveErrors.current === 0) return intervalMs;
    const backoff = intervalMs * Math.pow(2, consecutiveErrors.current);
    return Math.min(backoff, MAX_BACKOFF_MS);
  }, [intervalMs]);

  const query = useQuery({
    queryKey: ['edgeDevice', deviceId],
    queryFn: async () => {
      try {
        const result = await fetchDeviceData(deviceId);
        // Success: reset error counter
        consecutiveErrors.current = 0;
        return result;
      } catch (err) {
        consecutiveErrors.current += 1;
        throw err;
      }
    },
    enabled: !!deviceId,
    refetchInterval: () => (deviceId ? getBackoffInterval() : false),
    refetchIntervalInBackground: false,
  });

  return {
    device: query.data ?? null,
    loading: query.isLoading,
    error: query.error ? (query.error as Error).message : null,
    refetch: query.refetch,
  };
}

export type { EdgeDevice };
