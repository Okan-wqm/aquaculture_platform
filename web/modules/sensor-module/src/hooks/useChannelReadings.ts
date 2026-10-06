/**
 * Channel-generic reading hooks (SENSOR-HIGH-138) — the data behind
 * /sensor/readings and the trend cards. Both go through useTenantQuery, so the
 * cache key carries the authenticated tenant and a tenant switch can never
 * show the previous tenant's values.
 */
import { useMemo } from 'react';
import { useTenantQuery } from '@aquaculture/shared-ui';

import { graphqlFetch } from '../config/api';
import {
  CHANNEL_LATEST_VALUES_QUERY,
  CHANNEL_SERIES_QUERY,
  type ChannelLatestValue,
  type ChannelLatestValuesResult,
  type ChannelSeriesResponse,
  type ChannelSeriesResult,
} from '../graphql/channelReadings';

/** The backend caps a latest-values batch at 100 sensors. */
const LATEST_VALUES_BATCH = 100;

export interface UseChannelLatestValuesResult {
  /** sensorId → its enabled channels in display order. */
  bySensor: ReadonlyMap<string, ChannelLatestValue[]>;
  loading: boolean;
  error: string | null;
  /** When the values were last fetched (ms), null before the first answer. */
  fetchedAt: number | null;
  refetch: () => void;
}

export function useChannelLatestValues(
  sensorIds: readonly string[],
  refreshMs: number | false = 30_000,
): UseChannelLatestValuesResult {
  const ids = useMemo(() => [...new Set(sensorIds)].sort(), [sensorIds]);

  const query = useTenantQuery(
    ['sensor', 'channel-latest-values', ids],
    async () => {
      const batches: string[][] = [];
      for (let index = 0; index < ids.length; index += LATEST_VALUES_BATCH) {
        batches.push(ids.slice(index, index + LATEST_VALUES_BATCH));
      }
      const results = await Promise.all(
        batches.map((batch) =>
          graphqlFetch<ChannelLatestValuesResult>(CHANNEL_LATEST_VALUES_QUERY, {
            sensorIds: batch,
          }),
        ),
      );
      return results.flatMap((result) => result.channelLatestValues);
    },
    { enabled: ids.length > 0, refetchInterval: refreshMs, staleTime: 10_000 },
  );

  const bySensor = useMemo(() => {
    const grouped = new Map<string, ChannelLatestValue[]>();
    for (const value of query.data ?? []) {
      grouped.set(value.sensorId, [...(grouped.get(value.sensorId) ?? []), value]);
    }
    return grouped;
  }, [query.data]);

  return {
    bySensor,
    loading: query.isLoading,
    error: query.error ? query.error.message : null,
    fetchedAt: query.dataUpdatedAt > 0 ? query.dataUpdatedAt : null,
    refetch: () => {
      void query.refetch();
    },
  };
}

export interface UseChannelSeriesResult {
  series: ChannelSeriesResponse | null;
  loading: boolean;
  error: string | null;
}

/**
 * History of every enabled channel of one sensor over the last `rangeMs`.
 * The window end is re-anchored on every refetch, so an auto-refreshing
 * chart keeps sliding forward.
 */
export function useChannelSeries(
  sensorId: string | null,
  rangeMs: number,
  refreshMs: number | false = 60_000,
): UseChannelSeriesResult {
  const query = useTenantQuery(
    ['sensor', 'channel-series', sensorId, rangeMs],
    async () => {
      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - rangeMs);
      const result = await graphqlFetch<ChannelSeriesResult>(CHANNEL_SERIES_QUERY, {
        sensorId,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
      });
      return result.channelSeries;
    },
    { enabled: sensorId !== null, refetchInterval: refreshMs, staleTime: 30_000 },
  );

  return {
    series: query.data ?? null,
    loading: query.isLoading,
    error: query.error ? query.error.message : null,
  };
}
