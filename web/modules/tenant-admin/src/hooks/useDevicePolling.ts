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
        unit
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

/**
 * Hook for polling edge device data at regular intervals.
 *
 * Uses TanStack Query's refetchInterval instead of manual setInterval.
 * PERF-003: TanStack Query handles initial vs. background fetches natively --
 * isLoading is true only for the first fetch, isFetching is true for refetches.
 */
export function useDevicePolling(deviceId: string, intervalMs = 5000) {
  const query = useQuery({
    queryKey: ['edgeDevice', deviceId],
    queryFn: () => fetchDeviceData(deviceId),
    enabled: !!deviceId,
    refetchInterval: intervalMs,
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
