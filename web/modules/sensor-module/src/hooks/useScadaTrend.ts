/**
 * useScadaTrend Hook
 *
 * Historical trend data for SCADA chart widgets.
 * Uses GraphQL query (currently returns mock data, real query structure ready).
 * Features auto-resolution selection and 60s caching.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';

export type TrendResolution = 'raw' | '1m' | '5m' | '15m' | '1h' | '1d';

export interface TrendPoint {
  timestamp: string;
  value: number;
  quality?: 'good' | 'uncertain' | 'bad';
}

export interface TrendQuery {
  deviceCode: string;
  tagNames: string[];
  startTime: Date;
  endTime: Date;
  resolution?: TrendResolution;
}

export interface TrendResult {
  data: Record<string, TrendPoint[]>;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  data: Record<string, TrendPoint[]>;
  timestamp: number;
}

const trendCache = new Map<string, CacheEntry>();

function buildCacheKey(query: TrendQuery, resolution: TrendResolution): string {
  return `${query.deviceCode}:${query.tagNames.sort().join(',')}:${query.startTime.getTime()}:${query.endTime.getTime()}:${resolution}`;
}

function autoSelectResolution(startTime: Date, endTime: Date): TrendResolution {
  const durationMs = endTime.getTime() - startTime.getTime();
  const oneHour = 3_600_000;
  const oneDay = 86_400_000;

  if (durationMs <= oneHour) return 'raw';
  if (durationMs <= 6 * oneHour) return '1m';
  if (durationMs <= oneDay) return '5m';
  if (durationMs <= 7 * oneDay) return '15m';
  if (durationMs <= 30 * oneDay) return '1h';
  return '1d';
}

function generateMockData(query: TrendQuery, resolution: TrendResolution): Record<string, TrendPoint[]> {
  const result: Record<string, TrendPoint[]> = {};
  const startMs = query.startTime.getTime();
  const endMs = query.endTime.getTime();

  const intervalMs: Record<TrendResolution, number> = {
    raw: 1_000,
    '1m': 60_000,
    '5m': 300_000,
    '15m': 900_000,
    '1h': 3_600_000,
    '1d': 86_400_000,
  };

  const step = intervalMs[resolution];
  const maxPoints = 500;
  const actualStep = Math.max(step, (endMs - startMs) / maxPoints);

  for (const tagName of query.tagNames) {
    const points: TrendPoint[] = [];
    let baseValue = 20 + Math.random() * 30;

    for (let t = startMs; t <= endMs; t += actualStep) {
      baseValue += (Math.random() - 0.5) * 2;
      points.push({
        timestamp: new Date(t).toISOString(),
        value: Math.round(baseValue * 100) / 100,
        quality: 'good',
      });
    }
    result[tagName] = points;
  }

  return result;
}

// GraphQL query template (ready for real backend integration)
const _TREND_QUERY = /* GraphQL */ `
  query GetTrendData(
    $deviceCode: String!
    $tagNames: [String!]!
    $startTime: DateTime!
    $endTime: DateTime!
    $resolution: String!
  ) {
    trendData(
      deviceCode: $deviceCode
      tagNames: $tagNames
      startTime: $startTime
      endTime: $endTime
      resolution: $resolution
    ) {
      tagName
      points {
        timestamp
        value
        quality
      }
    }
  }
`;

export function useScadaTrend(query: TrendQuery | null): TrendResult {
  const [data, setData] = useState<Record<string, TrendPoint[]>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetchIdRef = useRef(0);

  const resolution = useMemo(() => {
    if (!query) return 'raw' as TrendResolution;
    return query.resolution ?? autoSelectResolution(query.startTime, query.endTime);
  }, [query?.resolution, query?.startTime?.getTime(), query?.endTime?.getTime()]);

  const queryKey = useMemo(() => {
    if (!query) return '';
    return buildCacheKey(query, resolution);
  }, [query?.deviceCode, query?.tagNames?.join(','), query?.startTime?.getTime(), query?.endTime?.getTime(), resolution]);

  const fetchData = useCallback(async () => {
    if (!query || query.tagNames.length === 0) {
      setData({});
      return;
    }

    // Check cache
    const cached = trendCache.get(queryKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      setData(cached.data);
      return;
    }

    const fetchId = ++fetchIdRef.current;
    setLoading(true);
    setError(null);

    try {
      // TODO: Replace with real GraphQL call when backend is ready
      // const result = await graphqlClient.query({ query: TREND_QUERY, variables: { ... } });
      await new Promise((resolve) => setTimeout(resolve, 200 + Math.random() * 300));
      const mockData = generateMockData(query, resolution);

      if (fetchId !== fetchIdRef.current) return; // Stale request

      trendCache.set(queryKey, { data: mockData, timestamp: Date.now() });
      setData(mockData);
    } catch (err: any) {
      if (fetchId !== fetchIdRef.current) return;
      setError(err.message ?? 'Trend verisi alinamadi');
    } finally {
      if (fetchId === fetchIdRef.current) {
        setLoading(false);
      }
    }
  }, [query, queryKey, resolution]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Cleanup stale cache entries periodically
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of trendCache.entries()) {
        if (now - entry.timestamp > CACHE_TTL_MS * 2) {
          trendCache.delete(key);
        }
      }
    }, CACHE_TTL_MS);

    return () => clearInterval(interval);
  }, []);

  return { data, loading, error, refetch: fetchData };
}

export default useScadaTrend;
