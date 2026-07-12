// MOB-MEDIUM-008 — live sensor values for the tank the worker is standing at.
//
// Tank screens showed only batch metrics; no temperature/DO/pH existed
// anywhere on mobile. This hook joins sensors to the tank at the RESOLVER
// level (sensorRawList(tankId:) on the indexed sensor.tank_id column), batches
// the latest readings in one round-trip, and returns per-metric values each
// carrying its own origin timestamp — the DataFreshness stamp's input. Offline,
// the last known readings serve from the encrypted tenant cache rather than
// rendering an empty (all-clear-looking) card.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { useLatestReadings } from '../useLatestReadings';

const mockGraphqlRequest = vi.fn();
vi.mock('@/services/authenticated-fetch', () => ({
  graphqlRequest: (...args: unknown[]): unknown => mockGraphqlRequest(...args),
}));

vi.mock('../useAuth', () => ({
  useAuth: (): { tenantId: string } => ({ tenantId: 'tenant-1' }),
}));

const mockCacheData = vi.fn();
const mockGetCachedData = vi.fn();
vi.mock('@/pwa/offline-queue', () => ({
  cacheData: (...args: unknown[]): unknown => mockCacheData(...args),
  getCachedData: (...args: unknown[]): unknown => mockGetCachedData(...args),
}));

function sensorsResponse(): unknown {
  return {
    sensorRawList: [
      { id: 's-temp', name: 'Tank 1 Temp', type: 'TEMPERATURE', status: 'ACTIVE', unit: '°C', lastSeenAt: null },
      { id: 's-do', name: 'Tank 1 DO', type: 'DISSOLVED_OXYGEN', status: 'ACTIVE', unit: 'mg/L', lastSeenAt: null },
    ],
  };
}

function readingsResponse(): unknown {
  return {
    latestReadingsBatch: [
      {
        id: 'r1',
        sensorId: 's-temp',
        timestamp: '2026-07-12T11:59:00.000Z',
        readings: { temperature: 18.4, ph: null, dissolvedOxygen: null, salinity: null, ammonia: null, nitrite: null, nitrate: null, turbidity: null, waterLevel: null },
      },
      {
        id: 'r2',
        sensorId: 's-do',
        timestamp: '2026-07-12T11:58:00.000Z',
        readings: { temperature: null, ph: 7.8, dissolvedOxygen: 6.9, salinity: null, ammonia: null, nitrite: null, nitrate: null, turbidity: null, waterLevel: null },
      },
    ],
  };
}

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }): ReactElement {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe('useLatestReadings (MOB-MEDIUM-008)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCachedData.mockResolvedValue(null);
    mockCacheData.mockResolvedValue(undefined);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  it('returns per-metric values with their own origin timestamps', async () => {
    mockGraphqlRequest
      .mockResolvedValueOnce(sensorsResponse())
      .mockResolvedValueOnce(readingsResponse());

    const { result } = renderHook(() => useLatestReadings('tank-1'), { wrapper });

    await waitFor(() => expect(result.current.metrics.length).toBeGreaterThan(0));
    const byKey = new Map(result.current.metrics.map((m) => [m.key, m]));
    expect(byKey.get('temperature')?.value).toBe(18.4);
    expect(byKey.get('temperature')?.readingAt).toBe('2026-07-12T11:59:00.000Z');
    expect(byKey.get('dissolvedOxygen')?.value).toBe(6.9);
    expect(byKey.get('ph')?.value).toBe(7.8);
    expect(byKey.get('ph')?.readingAt).toBe('2026-07-12T11:58:00.000Z');
  });

  it('keeps the NEWEST value when two sensors report the same metric', async () => {
    mockGraphqlRequest
      .mockResolvedValueOnce(sensorsResponse())
      .mockResolvedValueOnce({
        latestReadingsBatch: [
          { id: 'r1', sensorId: 's-temp', timestamp: '2026-07-12T11:00:00.000Z', readings: { temperature: 17.0, ph: null, dissolvedOxygen: null, salinity: null, ammonia: null, nitrite: null, nitrate: null, turbidity: null, waterLevel: null } },
          { id: 'r2', sensorId: 's-do', timestamp: '2026-07-12T11:30:00.000Z', readings: { temperature: 18.1, ph: null, dissolvedOxygen: null, salinity: null, ammonia: null, nitrite: null, nitrate: null, turbidity: null, waterLevel: null } },
        ],
      });

    const { result } = renderHook(() => useLatestReadings('tank-1'), { wrapper });

    await waitFor(() => expect(result.current.metrics.length).toBe(1));
    expect(result.current.metrics[0]?.value).toBe(18.1);
    expect(result.current.metrics[0]?.readingAt).toBe('2026-07-12T11:30:00.000Z');
  });

  it('reports hasSensors=false (not an empty all-clear) when no sensors are registered', async () => {
    mockGraphqlRequest.mockResolvedValueOnce({ sensorRawList: [] });

    const { result } = renderHook(() => useLatestReadings('tank-1'), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.hasSensors).toBe(false);
    expect(result.current.metrics).toEqual([]);
    // No readings batch round-trip for zero sensors.
    expect(mockGraphqlRequest).toHaveBeenCalledTimes(1);
  });

  it('serves last-known readings from the encrypted cache when offline', async () => {
    mockGraphqlRequest.mockRejectedValue(new Error('Failed to fetch'));
    mockGetCachedData.mockResolvedValue({
      metrics: [
        { key: 'temperature', label: 'Temp', value: 17.2, unit: '°C', readingAt: '2026-07-12T09:00:00.000Z' },
      ],
      hasSensors: true,
    });

    const { result } = renderHook(() => useLatestReadings('tank-1'), { wrapper });

    await waitFor(() => expect(result.current.metrics).toHaveLength(1));
    expect(result.current.metrics[0]?.value).toBe(17.2);
    // The stale origin timestamp survives so DataFreshness shows honest age.
    expect(result.current.metrics[0]?.readingAt).toBe('2026-07-12T09:00:00.000Z');
  });

  it('does not fetch without a tankId and scopes keys by tenant', async () => {
    const { result } = renderHook(() => useLatestReadings(undefined), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mockGraphqlRequest).not.toHaveBeenCalled();

    mockGraphqlRequest.mockResolvedValueOnce(sensorsResponse()).mockResolvedValueOnce(readingsResponse());
    const { result: withTank } = renderHook(() => useLatestReadings('tank-1'), { wrapper });
    await waitFor(() => expect(withTank.current.metrics.length).toBeGreaterThan(0));
    for (const key of queryClient.getQueryCache().getAll().map((q) => q.queryKey)) {
      expect(key.slice(0, 2)).toEqual(['tenant', 'tenant-1']);
    }
  });
});
