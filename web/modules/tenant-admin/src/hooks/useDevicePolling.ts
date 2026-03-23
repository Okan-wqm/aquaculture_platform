import { useQuery } from '@tanstack/react-query';
import { getEdgeDevice, type EdgeDeviceDetail } from '../lib/api';

type EdgeDevice = EdgeDeviceDetail;

async function fetchDeviceData(deviceId: string): Promise<EdgeDevice | null> {
  return getEdgeDevice(deviceId);
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
