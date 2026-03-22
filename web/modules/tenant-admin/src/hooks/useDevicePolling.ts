import { useState, useEffect, useCallback, useRef } from 'react';
import { graphqlRequest } from '../services/tenant-api.service';
import { EDGE_DEVICE_QUERY } from '../graphql';

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

/**
 * Hook for polling edge device data at regular intervals.
 *
 * PERF-003: Uses isInitialLoad ref so the loading spinner only shows on the
 * first fetch, not on every subsequent poll tick, avoiding full re-renders
 * of the component tree every 5 seconds.
 */
export function useDevicePolling(deviceId: string, intervalMs = 5000) {
  const [device, setDevice] = useState<EdgeDevice | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isInitialLoad = useRef(true);

  const fetchDevice = useCallback(async () => {
    if (!deviceId) return;

    // Only show full loading state on the initial load (PERF-003)
    if (isInitialLoad.current) {
      setLoading(true);
    }

    try {
      const result = await graphqlRequest<{ edgeDevice: EdgeDevice | null }>(
        EDGE_DEVICE_QUERY,
        { id: deviceId },
      );
      setDevice(result.edgeDevice || null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch device');
    } finally {
      if (isInitialLoad.current) {
        setLoading(false);
        isInitialLoad.current = false;
      }
    }
  }, [deviceId]);

  // Initial fetch
  useEffect(() => {
    isInitialLoad.current = true;
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
    // Manual refetch always shows loading indicator
    isInitialLoad.current = true;
    fetchDevice();
  }, [fetchDevice]);

  return { device, loading, error, refetch };
}

export type { EdgeDevice };
