/**
 * useTrendData — Query and cache historical tag data from IDataProvider.
 *
 * Features:
 *  - Converts ChartTimeRange presets ('last1h', 'last8h', …) to Date ranges.
 *  - Deduplicates concurrent in-flight queries (same tagIds + time window).
 *  - Caches results keyed by a stable query hash so rapid re-mounts are free.
 *  - Optional auto-refresh via refreshIntervalMs option.
 *  - Exposes a manual refresh() callback.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useDataProvider } from '../providers';
import type {
  ChartTimeRange,
  DaqAggregation,
  HistoricalDataPoint,
} from '../types/scada-runtime.types';

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

export type TrendTimeRange = ChartTimeRange | { from: Date; to: Date };

export interface TrendOptions {
  aggregation?: DaqAggregation;
  refreshIntervalMs?: number;
}

export interface TrendDataResult {
  data: Record<string, HistoricalDataPoint[]>;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

/* ------------------------------------------------------------------ */
/*  Constants — preset → milliseconds                                   */
/* ------------------------------------------------------------------ */

const PRESET_MS: Record<ChartTimeRange, number | null> = {
  last1h:  1 * 60 * 60 * 1000,
  last8h:  8 * 60 * 60 * 1000,
  last1d: 24 * 60 * 60 * 1000,
  last3d:  3 * 24 * 60 * 60 * 1000,
  last1w:  7 * 24 * 60 * 60 * 1000,
  last1m: 30 * 24 * 60 * 60 * 1000,
  custom:  null, // caller must supply a {from, to} object
};

/* ------------------------------------------------------------------ */
/*  Module-scope query cache                                            */
/* ------------------------------------------------------------------ */

/** Finished query results shared across hook instances. */
const resultCache = new Map<string, Record<string, HistoricalDataPoint[]>>();

/** In-flight promises so concurrent hooks with the same query share one fetch. */
const inflightPromises = new Map<
  string,
  Promise<Record<string, HistoricalDataPoint[]>>
>();

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

function resolveTimeRange(range: TrendTimeRange): { from: Date; to: Date } | null {
  if (typeof range === 'object' && 'from' in range) {
    return range;
  }
  const ms = PRESET_MS[range as ChartTimeRange];
  if (ms === null) return null; // 'custom' without an explicit range
  const to = new Date();
  const from = new Date(to.getTime() - ms);
  return { from, to };
}

function buildCacheKey(
  tagIds: string[],
  from: Date,
  to: Date,
  aggregation?: DaqAggregation,
): string {
  const tags = [...tagIds].sort().join('\0');
  const agg = aggregation ? `${aggregation.function}:${aggregation.interval}` : '';
  // Round timestamps to the nearest 5 seconds so near-identical queries share
  // cache entries instead of creating cache thrash.
  const fromBucket = Math.round(from.getTime() / 5000) * 5000;
  const toBucket   = Math.round(to.getTime()   / 5000) * 5000;
  return `${tags}|${fromBucket}|${toBucket}|${agg}`;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                                */
/* ------------------------------------------------------------------ */

export function useTrendData(
  tagIds: string[],
  timeRange: TrendTimeRange,
  options: TrendOptions = {},
): TrendDataResult {
  const { aggregation, refreshIntervalMs } = options;
  const provider = useDataProvider();

  const [data, setData] = useState<Record<string, HistoricalDataPoint[]>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stable keys for change detection without object identity issues.
  const tagIdsKey = useMemo(() => [...tagIds].sort().join('\0'), [tagIds]);
  const rangeKey = useMemo(() => {
    if (typeof timeRange === 'object' && 'from' in timeRange) {
      return `${timeRange.from.getTime()}-${timeRange.to.getTime()}`;
    }
    return timeRange as string;
  }, [timeRange]);
  const aggKey = useMemo(
    () => (aggregation ? `${aggregation.function}:${aggregation.interval}` : ''),
    [aggregation],
  );

  // Ref to the latest fetch so the interval always calls the newest version.
  const fetchRef = useRef<(() => Promise<void>) | undefined>(undefined);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const fetch = useCallback(async () => {
    const currentTagIds = tagIdsKey ? tagIdsKey.split('\0') : [];
    if (currentTagIds.length === 0) return;

    const resolved = resolveTimeRange(timeRange);
    if (!resolved) {
      setError('useTrendData: timeRange is "custom" but no {from, to} object was provided');
      return;
    }

    const cacheKey = buildCacheKey(currentTagIds, resolved.from, resolved.to, aggregation);

    // Return cached result immediately (still show it while refreshing).
    const cached = resultCache.get(cacheKey);
    if (cached) {
      setData(cached);
      setError(null);
    }

    // Deduplicate: if an identical fetch is already in flight, reuse it.
    let promise = inflightPromises.get(cacheKey);
    if (!promise) {
      setIsLoading(true);
      promise = provider
        .queryHistory(currentTagIds, resolved.from, resolved.to)
        .then((result) => {
          resultCache.set(cacheKey, result.data);
          return result.data;
        })
        .finally(() => {
          inflightPromises.delete(cacheKey);
        });
      inflightPromises.set(cacheKey, promise);
    }

    try {
      const result = await promise;
      if (!mountedRef.current) return;
      setData(result);
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
   
  }, [tagIdsKey, rangeKey, aggKey, provider]);

  fetchRef.current = fetch;

  // Run fetch whenever the query inputs change.
  useEffect(() => {
    fetchRef.current?.();
  }, [tagIdsKey, rangeKey, aggKey, provider]);

  // Optional auto-refresh.
  useEffect(() => {
    if (!refreshIntervalMs || refreshIntervalMs <= 0) return;

    const handle = setInterval(() => {
      fetchRef.current?.();
    }, refreshIntervalMs);

    return () => clearInterval(handle);
  }, [refreshIntervalMs]);

  const refresh = useCallback(() => {
    fetchRef.current?.();
  }, []);

  return { data, isLoading, error, refresh };
}
