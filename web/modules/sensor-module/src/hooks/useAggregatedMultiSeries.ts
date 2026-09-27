/**
 * Multi-parameter aggregated series for a sensor (PR-6).
 *
 * Feeds the tiered `aggregatedReadings` query (raw <=1h, metrics_1min <=24h,
 * metrics_1hour <=30d — the backend picks the tier) and maps each bucket to
 * per-channel series keyed by channelKey, ready for TrendChart custom mode.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { graphqlFetch } from '../config/api';
import {
  GET_AGGREGATED_READINGS_QUERY,
  extractAggregatedValueByChannelKey,
  type AggregatedDataPoint,
} from '../graphql/aggregatedReadings';

export interface MultiSeriesPoint {
  timestamp: number; // unix ms
  value: number;
}

export interface UseAggregatedMultiSeriesResult {
  /** channelKey -> ordered points (buckets without a value are skipped). */
  series: Record<string, MultiSeriesPoint[]>;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

interface AggregatedResponse {
  aggregatedReadings: {
    data: AggregatedDataPoint[];
  } | null;
}

function toIso(date: Date): string {
  return date.toISOString();
}

export function useAggregatedMultiSeries(
  sensorId: string | null,
  channelKeys: readonly string[],
  rangeMs: number,
): UseAggregatedMultiSeriesResult {
  const [points, setPoints] = useState<AggregatedDataPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const keys = useMemo(() => [...channelKeys], [channelKeys]);

  const refetch = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  useEffect(() => {
    if (!sensorId) {
      setPoints([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);

    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - rangeMs);

    graphqlFetch<AggregatedResponse>(GET_AGGREGATED_READINGS_QUERY, {
      sensorId,
      startTime: toIso(startTime),
      endTime: toIso(endTime),
    })
      .then((result) => {
        if (cancelled) return;
        setPoints(result.aggregatedReadings?.data ?? []);
      })
      .catch((fetchError: unknown) => {
        if (cancelled) return;
        setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
        setPoints([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [sensorId, rangeMs, reloadToken]);

  const series = useMemo(() => {
    const result: Record<string, MultiSeriesPoint[]> = {};
    for (const key of keys) result[key] = [];
    for (const point of points) {
      const timestamp = new Date(point.bucket).getTime();
      for (const key of keys) {
        const value = extractAggregatedValueByChannelKey(point, key);
        if (value !== null && Number.isFinite(timestamp)) {
          result[key]?.push({ timestamp, value });
        }
      }
    }
    return result;
  }, [points, keys]);

  return { series, loading, error, refetch };
}
