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
import { createTenantQueryKey, useAuth, useTenantQuery } from '@aquaculture/shared-ui';
import { useQueries } from '@tanstack/react-query';

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
  /** No answer yet for this sensor. */
  loading: boolean;
  /** A request is in flight — the series shown may be for the previous range. */
  fetching: boolean;
  error: string | null;
}

/**
 * History of the channels of one sensor over a range — every channel, or only
 * `channelKeys` (the server narrows it, so a water-chemistry tile charting one
 * bound channel does not fetch the sensor's others). A preset ("last 24
 * hours") is re-anchored at now on every fetch and refreshed; a fixed window
 * is fetched once — nothing new arrives in the past.
 */
export function useChannelSeries(
  sensorId: string | null,
  range: TimeRangeSpec,
  refreshMs: number | false = 60_000,
  channelKeys: readonly string[] | null = null,
): UseChannelSeriesResult {
  const rangeKey = JSON.stringify(timeRangeToParams(range));
  const query = useTenantQuery(
    ['sensor', 'channel-series', sensorId, rangeKey, channelKeys],
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
        channelKeys,
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
    fetching: query.isFetching,
    error: query.error ? query.error.message : null,
  };
}

export interface SensorSeriesRequest {
  readonly sensorId: string;
  /** The channels of the sensor to chart (the server narrows the series to them). */
  readonly channelKeys: readonly string[];
}

/**
 * The series of several sensors at once, each narrowed to the channels asked
 * for it — one request per sensor, however many tiles chart its channels.
 * Keyed and gated like useChannelSeries (tenant prefix, authenticated only).
 */
export function useChannelSeriesBySensor(
  requests: readonly SensorSeriesRequest[],
  range: TimeRangeSpec,
  refreshMs: number | false = 60_000,
): ReadonlyMap<string, ChannelSeriesResponse> {
  const { token, tenantId } = useAuth();
  const authenticatedTenantId = token && tenantId ? tenantId : null;
  const rangeKey = JSON.stringify(timeRangeToParams(range));
  return useQueries({
    queries: requests.map((request) => ({
      queryKey: createTenantQueryKey(
        authenticatedTenantId,
        'sensor',
        'channel-series',
        request.sensorId,
        rangeKey,
        request.channelKeys,
      ),
      queryFn: async (): Promise<ChannelSeriesResponse> => {
        const window = resolveTimeRange(range, Date.now());
        if (!window.ok) throw new Error(`Invalid series range: ${window.error}`);
        const result = await graphqlFetch<ChannelSeriesResult>(CHANNEL_SERIES_QUERY, {
          sensorId: request.sensorId,
          startTime: new Date(window.startMs).toISOString(),
          endTime: new Date(window.endMs).toISOString(),
          channelKeys: request.channelKeys,
        });
        return result.channelSeries;
      },
      enabled: authenticatedTenantId !== null,
      refetchInterval: range.kind === 'relative' ? refreshMs : false,
      staleTime: 30_000,
    })),
    combine: seriesBySensor,
  });
}

/** Stable (module-level) so react-query keeps the combined map while the answers are unchanged. */
function seriesBySensor(
  results: ReadonlyArray<{ data?: ChannelSeriesResponse }>,
): ReadonlyMap<string, ChannelSeriesResponse> {
  const bySensor = new Map<string, ChannelSeriesResponse>();
  for (const result of results) {
    if (result.data !== undefined) bySensor.set(result.data.sensorId, result.data);
  }
  return bySensor;
}

export interface UseSeriesDisplayTimeZoneResult {
  zone: SeriesDisplayTimeZone | null;
  loading: boolean;
  error: string | null;
}

/** The server answers the page zone for up to this many sensors at once. */
const DISPLAY_ZONE_BATCH = 1_000;

/** The one zone a page of these sensors' charts is shown and picked in (server rule). */
export function useSeriesDisplayTimeZone(
  sensorIds: readonly string[],
): UseSeriesDisplayTimeZoneResult {
  const ids = useMemo(() => [...sensorIds].sort().slice(0, DISPLAY_ZONE_BATCH), [sensorIds]);
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
  return {
    zone: query.data ?? null,
    loading: query.isLoading,
    error: query.error ? query.error.message : null,
  };
}

/** First and last stored sample of each channel of the sensors, by channel id. */
export function useChannelDataBounds(
  sensorIds: readonly string[],
): ReadonlyMap<string, ChannelDataBounds> {
  const ids = useMemo(() => [...sensorIds].sort(), [sensorIds]);
  const query = useTenantQuery(
    ['sensor', 'channel-data-bounds', ids.join(',')],
    async () => {
      // The backend caps one request at 100 sensors; a larger page asks in batches.
      const batches: string[][] = [];
      for (let index = 0; index < ids.length; index += LATEST_VALUES_BATCH) {
        batches.push(ids.slice(index, index + LATEST_VALUES_BATCH));
      }
      const results = await Promise.all(
        batches.map(async (batch) => {
          const result = await graphqlFetch<ChannelDataBoundsResult>(CHANNEL_DATA_BOUNDS_QUERY, {
            sensorIds: batch,
          });
          return result;
        }),
      );
      return results.flatMap((result) => result.channelDataBounds);
    },
    { enabled: ids.length > 0, staleTime: 60_000 },
  );
  return useMemo(
    () => new Map((query.data ?? []).map((bounds) => [bounds.channelId, bounds])),
    [query.data],
  );
}
