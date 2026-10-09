/**
 * useTrendData — Query and cache historical tag data from IDataProvider.
 *
 * Features:
 *  - Converts ChartTimeRange presets ('last1h', 'last8h', …) to Date ranges
 *    with the durations of the shared time-range table.
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
import { onTenantChange, registerLogoutCleanup } from '@aquaculture/shared-ui';
import { scadaRangeDurationMs } from '@aquaculture/shared-contracts';

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
/*  Module-scope query cache                                            */
/* ------------------------------------------------------------------ */

/** Finished query results shared across hook instances. */
const resultCache = new Map<string, Record<string, HistoricalDataPoint[]>>();

// SECURITY (ADMIN-HIGH-105's gate, same class as the sensor stores below/above):
// this cache is module-scoped, so it outlives every component that reads it and
// would hand one tenant's historical sensor series to the next principal on the
// same tab. It joins the two authorities the rest of this module already uses —
// `logoutCleanup()` drains the logout registry, and `onTenantChange` fires on a
// tenant switch that does not log out.
registerLogoutCleanup(() => resultCache.clear());
onTenantChange(() => resultCache.clear());

/** In-flight promises so concurrent hooks with the same query share one fetch. */
const inflightPromises = new Map<
  string,
  Promise<Record<string, HistoricalDataPoint[]>>
>();

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

/** The window a trend range covers: a fixed pair as given, a token ending now. */
export function resolveTrendTimeRange(range: TrendTimeRange): { from: Date; to: Date } {
  if (typeof range === 'object') {
    return range;
  }
  const to = new Date();
  return { from: new Date(to.getTime() - scadaRangeDurationMs(range)), to };
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

    const resolved = resolveTrendTimeRange(timeRange);

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
