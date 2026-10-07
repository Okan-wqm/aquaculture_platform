/**
 * Channel-generic reading hooks (SENSOR-HIGH-138) — the data behind
 * /sensor/readings and the trend cards. Both go through useTenantQuery, so the
 * cache key carries the authenticated tenant and a tenant switch can never
 * show the previous tenant's values.
 */
import { useMemo } from 'react';
import {
  resolveTimeRange,
  timeRangeToParams,
  type TimeRangeSpec,
} from '@aquaculture/shared-contracts';
import { useTenantQuery } from '@aquaculture/shared-ui';

import { graphqlFetch } from '../config/api';
import {
  CHANNEL_DATA_BOUNDS_QUERY,
  CHANNEL_LATEST_VALUES_QUERY,
  CHANNEL_SERIES_QUERY,
  SERIES_DISPLAY_TIME_ZONE_QUERY,
  type ChannelDataBounds,
  type ChannelDataBoundsResult,
  type ChannelLatestValue,
  type ChannelLatestValuesResult,
  type ChannelSeriesResponse,
  type ChannelSeriesResult,
  type SeriesDisplayTimeZone,
  type SeriesDisplayTimeZoneResult,
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
 * History of every channel of one sensor over a range. A preset ("last 24
 * hours") is re-anchored at now on every fetch and refreshed; a fixed window
 * is fetched once — nothing new arrives in the past.
 */
export function useChannelSeries(
  sensorId: string | null,
  range: TimeRangeSpec,
  refreshMs: number | false = 60_000,
): UseChannelSeriesResult {
  const rangeKey = JSON.stringify(timeRangeToParams(range));
  const query = useTenantQuery(
    ['sensor', 'channel-series', sensorId, rangeKey],
    async () => {
      const window = resolveTimeRange(range, Date.now());
      if (!window.ok) {
        // The page validates ranges before they reach here (URL parse,
        // picker); an invalid one is a programming error, said loudly.
        throw new Error(`Invalid series range: ${window.error}`);
      }
      const result = await graphqlFetch<ChannelSeriesResult>(CHANNEL_SERIES_QUERY, {
        sensorId,
        startTime: new Date(window.startMs).toISOString(),
        endTime: new Date(window.endMs).toISOString(),
      });
      return result.channelSeries;
    },
    {
      enabled: sensorId !== null,
      refetchInterval: range.kind === 'relative' ? refreshMs : false,
      staleTime: 30_000,
    },
  );

  return {
    series: query.data ?? null,
    loading: query.isLoading,
    error: query.error ? query.error.message : null,
  };
}

export interface UseSeriesDisplayTimeZoneResult {
  zone: SeriesDisplayTimeZone | null;
  loading: boolean;
}

/** The one zone a page of these sensors' charts is shown and picked in (server rule). */
export function useSeriesDisplayTimeZone(
  sensorIds: readonly string[],
): UseSeriesDisplayTimeZoneResult {
  const ids = useMemo(() => [...sensorIds].sort().slice(0, LATEST_VALUES_BATCH), [sensorIds]);
  const query = useTenantQuery(
    ['sensor', 'series-display-time-zone', ids.join(',')],
    async () => {
      const result = await graphqlFetch<SeriesDisplayTimeZoneResult>(
        SERIES_DISPLAY_TIME_ZONE_QUERY,
        { sensorIds: ids },
      );
      return result.seriesDisplayTimeZone;
    },
    { enabled: ids.length > 0, staleTime: 5 * 60_000 },
  );
  return { zone: query.data ?? null, loading: query.isLoading };
}

/** First and last stored sample of each channel of the sensors, by channel id. */
export function useChannelDataBounds(
  sensorIds: readonly string[],
): ReadonlyMap<string, ChannelDataBounds> {
  const ids = useMemo(() => [...sensorIds].sort().slice(0, LATEST_VALUES_BATCH), [sensorIds]);
  const query = useTenantQuery(
    ['sensor', 'channel-data-bounds', ids.join(',')],
    async () => {
      const result = await graphqlFetch<ChannelDataBoundsResult>(CHANNEL_DATA_BOUNDS_QUERY, {
        sensorIds: ids,
      });
      return result.channelDataBounds;
    },
    { enabled: ids.length > 0, staleTime: 60_000 },
  );
  return useMemo(
    () => new Map((query.data ?? []).map((bounds) => [bounds.channelId, bounds])),
    [query.data],
  );
}
