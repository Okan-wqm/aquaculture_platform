import { useRef, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getEdgeDevice, type EdgeDeviceDetail } from '../lib/api';

type EdgeDevice = EdgeDeviceDetail;

async function fetchDeviceData(deviceId: string): Promise<EdgeDevice | null> {
  return getEdgeDevice(deviceId);
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
  const { user } = useAuthContext();
  const tenantId = user?.tenantId;
  const consecutiveErrors = useRef(0);

  const getBackoffInterval = useCallback((): number => {
    if (consecutiveErrors.current === 0) return intervalMs;
    const backoff = intervalMs * Math.pow(2, consecutiveErrors.current);
    return Math.min(backoff, MAX_BACKOFF_MS);
  }, [intervalMs]);

  const query = useQuery({
    queryKey: createTenantQueryKey(tenantId, 'edgeDevice', tenantId, deviceId),
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
