// ============================================================================
// useLatestReadings — live water values for a tank (MOB-MEDIUM-008)
// ============================================================================
//
// Tank screens previously showed only batch metrics — no temperature, DO or pH
// existed anywhere on mobile, so a worker standing AT the tank had to guess or
// find a desktop. This hook:
//   1. resolves the tank's sensors via the resolver-level join
//      (`sensorRawList(tankId:)` on the indexed sensor.tank_id column),
//   2. batches their latest readings in ONE round-trip (latestReadingsBatch),
//   3. flattens them into per-metric values, each carrying its OWN origin
//      timestamp — the input the DataFreshness stamp needs (a value without an
//      age is not actionable),
//   4. polls while mounted, and serves the last-known snapshot from the
//      encrypted tenant cache when offline (with its honest, stale timestamps)
//      instead of rendering an empty card that reads as "no problem".

import { useQuery } from '@tanstack/react-query';

import { useAuth } from './useAuth';

import { MOBILE_LATEST_READINGS_BATCH, MOBILE_TANK_SENSORS } from '@/graphql/sensor-operations';
import { cacheData, getCachedData } from '@/pwa/offline-queue';
import { graphqlRequest } from '@/services/authenticated-fetch';
import { createTenantQueryKey } from '@/utils/tenant-query-keys';

/** Metric keys mirror the SensorReadings selection — one entry per non-null value. */
export type ReadingMetricKey =
  | 'temperature'
  | 'ph'
  | 'dissolvedOxygen'
  | 'salinity'
  | 'ammonia'
  | 'nitrite'
  | 'nitrate'
  | 'turbidity'
  | 'waterLevel';

export interface LiveMetric {
  key: ReadingMetricKey;
  label: string;
  value: number;
  unit: string;
  /** Origin timestamp of THIS value — feeds the DataFreshness stamp. */
  readingAt: string;
}

interface ReadingsSnapshot {
  metrics: LiveMetric[];
  hasSensors: boolean;
}

export interface UseLatestReadingsResult {
  metrics: LiveMetric[];
  /** false = no sensors registered for this tank (distinct from "no data"). */
  hasSensors: boolean;
  isLoading: boolean;
  error: string | null;
}

const METRIC_PRESENTATION: Record<ReadingMetricKey, { label: string; unit: string }> = {
  temperature: { label: 'Temp', unit: '°C' },
  ph: { label: 'pH', unit: '' },
  dissolvedOxygen: { label: 'DO', unit: 'mg/L' },
  salinity: { label: 'Salinity', unit: 'ppt' },
  ammonia: { label: 'NH₃', unit: 'mg/L' },
  nitrite: { label: 'NO₂', unit: 'mg/L' },
  nitrate: { label: 'NO₃', unit: 'mg/L' },
  turbidity: { label: 'Turbidity', unit: 'NTU' },
  waterLevel: { label: 'Level', unit: 'm' },
};

const METRIC_KEYS = Object.keys(METRIC_PRESENTATION) as readonly ReadingMetricKey[];

/** Poll cadence while a tank screen is open. */
const READINGS_REFETCH_INTERVAL_MS = 45_000;
/** Offline snapshot TTL — past a shift, stale values are hidden entirely. */
const READINGS_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

interface ReadingRow {
  sensorId: string;
  timestamp: string;
  readings: Partial<Record<ReadingMetricKey, number | null>>;
}

/** Newest non-null value per metric across all of the tank's sensors. */
function flattenToMetrics(rows: readonly ReadingRow[]): LiveMetric[] {
  const best = new Map<ReadingMetricKey, { value: number; readingAt: string }>();
  for (const row of rows) {
    for (const key of METRIC_KEYS) {
      const value = row.readings[key];
      if (value === null || value === undefined) continue;
      const current = best.get(key);
      if (!current || row.timestamp > current.readingAt) {
        best.set(key, { value, readingAt: row.timestamp });
      }
    }
  }
  return METRIC_KEYS.filter((key) => best.has(key)).map((key) => {
    const hit = best.get(key);
    return {
      key,
      label: METRIC_PRESENTATION[key].label,
      unit: METRIC_PRESENTATION[key].unit,
      value: hit?.value ?? 0,
      readingAt: hit?.readingAt ?? '',
    };
  });
}

export function useLatestReadings(tankId: string | undefined): UseLatestReadingsResult {
  const { tenantId } = useAuth();
  const offlineCacheKey = `readings_${tankId ?? 'none'}`;

  const query = useQuery({
    queryKey: createTenantQueryKey(tenantId, 'live-readings', tankId ?? 'none'),
    enabled: Boolean(tenantId) && Boolean(tankId),
    refetchInterval: READINGS_REFETCH_INTERVAL_MS,
    queryFn: async (): Promise<ReadingsSnapshot> => {
      if (!tenantId || !tankId) return { metrics: [], hasSensors: false };
      try {
        const sensorsData = await graphqlRequest(MOBILE_TANK_SENSORS, { tankId });
        const sensors = sensorsData.sensorRawList;
        if (sensors.length === 0) {
          const snapshot: ReadingsSnapshot = { metrics: [], hasSensors: false };
          await cacheData(tenantId, offlineCacheKey, snapshot, READINGS_CACHE_TTL_MS);
          return snapshot;
        }

        const readingsData = await graphqlRequest(MOBILE_LATEST_READINGS_BATCH, {
          sensorIds: sensors.map((sensor) => sensor.id),
        });
        const snapshot: ReadingsSnapshot = {
          metrics: flattenToMetrics(readingsData.latestReadingsBatch),
          hasSensors: true,
        };
        await cacheData(tenantId, offlineCacheKey, snapshot, READINGS_CACHE_TTL_MS);
        return snapshot;
      } catch (error) {
        // Offline: the last-known snapshot (with its honest, old timestamps —
        // DataFreshness will show them red) beats an empty card that reads as
        // "nothing to worry about".
        const cached = await getCachedData<ReadingsSnapshot>(tenantId, offlineCacheKey);
        if (cached) return cached;
        throw error;
      }
    },
  });

  return {
    metrics: query.data?.metrics ?? [],
    hasSensors: query.data?.hasSensors ?? false,
    isLoading: query.isLoading && query.fetchStatus !== 'idle',
    error: query.error instanceof Error ? query.error.message : null,
  };
}
