/**
 * Real-time refresh for the channel-reading queries.
 *
 * /sensor/readings used to learn about a new reading only at the next 30 s
 * poll. The platform already pushes every persisted reading (MQTT ingest →
 * `SensorReading` on NATS → gateway-api's Socket.IO `/sensors` namespace), so
 * the page can react the moment data arrives. The push is a SIGNAL, not a
 * value source: channelLatestValues / channelSeries stay the single source of
 * truth for what is shown (calibrated values, quality codes, alert levels,
 * bucketing), so an arrival invalidates those queries and React Query
 * refetches them. The hooks' own poll intervals remain as the fallback while
 * the socket is down.
 *
 * Bursts are collapsed: a sonde reporting five channels emits five pushes in
 * one breath, and invalidating per event would refetch five times. Invalidation
 * runs at most once per ARRIVAL_SIGNAL_MS — new values still reach the screen
 * in seconds, not poll intervals.
 */
import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createTenantInvalidationKey, useAuth } from '@aquaculture/shared-ui';

import { useSensorSocket } from './useSensorSocket';

/** Minimum spacing between push-triggered refetch rounds. */
const ARRIVAL_SIGNAL_MS = 2_000;

/**
 * Subscribe to the sensors' reading pushes and invalidate the channel-reading
 * queries as data arrives. Returns the socket's connection state so callers
 * can say whether live updates are flowing (the poll remains as fallback).
 */
export function useChannelReadingsRealtime(sensorIds: readonly string[]): boolean {
  const queryClient = useQueryClient();
  const { tenantId } = useAuth();
  const ids = [...sensorIds];
  const { isConnected, readings } = useSensorSocket(ids);
  const lastInvalidationRef = useRef(0);

  useEffect(() => {
    if (readings.size === 0 || tenantId === null) return;
    const now = Date.now();
    if (now - lastInvalidationRef.current < ARRIVAL_SIGNAL_MS) return;
    lastInvalidationRef.current = now;

    // Invalidation keys are domain prefixes (no session epoch) so every
    // stored key under the segment matches — see createTenantInvalidationKey.
    void queryClient.invalidateQueries({
      queryKey: createTenantInvalidationKey(tenantId, 'sensor', 'channel-latest-values'),
    });
    void queryClient.invalidateQueries({
      queryKey: createTenantInvalidationKey(tenantId, 'sensor', 'channel-series'),
    });
    void queryClient.invalidateQueries({
      queryKey: createTenantInvalidationKey(tenantId, 'sensor', 'channel-data-bounds'),
    });
  }, [readings, queryClient, tenantId]);

  return isConnected;
}
