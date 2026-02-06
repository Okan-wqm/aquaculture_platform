import { useState, useEffect, useCallback, useRef } from 'react';

const GRAPHQL_URL = '/graphql';

const getAuthToken = (): string | null => {
  return localStorage.getItem('access_token');
};

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

/**
 * Hook for polling edge device data at regular intervals
 */
export function useDevicePolling(deviceId: string, intervalMs = 5000) {
  const [device, setDevice] = useState<EdgeDevice | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchDevice = useCallback(async () => {
    const token = getAuthToken();
    if (!token || !deviceId) return;

    try {
      const response = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          query: EDGE_DEVICE_QUERY,
          variables: { id: deviceId },
        }),
      });

      const result = await response.json();

      if (result.errors) {
        setError(result.errors[0]?.message || 'GraphQL error');
        return;
      }

      setDevice(result.data?.edgeDevice || null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch device');
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  // Initial fetch
  useEffect(() => {
    setLoading(true);
    fetchDevice();
  }, [fetchDevice]);

  // Polling
  useEffect(() => {
    if (!deviceId) return;

    if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }

    intervalRef.current = setInterval(fetchDevice, intervalMs);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [fetchDevice, intervalMs]);

  const refetch = useCallback(() => {
    setLoading(true);
    fetchDevice();
  }, [fetchDevice]);

  return { device, loading, error, refetch };
}

export type { EdgeDevice };
