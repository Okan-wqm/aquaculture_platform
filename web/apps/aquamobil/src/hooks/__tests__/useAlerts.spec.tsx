// MOB-HIGH-006 — the mobile alarm surface must reflect alert-engine truth and
// acknowledge offline-first.
//
// Desktop has the full alarm stack (sensor-module AlertsPage/useAlerts); the
// field worker had NOTHING on the device that is actually with them at the
// tank. This hook binds alertHistory + acknowledgeAlert to mobile with the
// platform's offline discipline: reads fall back to the encrypted tenant cache
// when the network is down, and acks ride the offline queue (queue-first, like
// every mobile write) with an optimistic cache update so the banner/badge
// clears immediately.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { useAlerts } from '../useAlerts';

const mockGraphqlRequest = vi.fn();
vi.mock('@/services/authenticated-fetch', () => ({
  graphqlRequest: (...args: unknown[]): unknown => mockGraphqlRequest(...args),
}));

vi.mock('../useAuth', () => ({
  useAuth: (): { tenantId: string } => ({ tenantId: 'tenant-1' }),
}));

const mockAddToQueue = vi.fn();
vi.mock('../useOfflineQueue', () => ({
  useOfflineQueue: (): { addToQueue: typeof mockAddToQueue; isOnline: boolean } => ({
    addToQueue: mockAddToQueue,
    isOnline: true,
  }),
}));

const mockCacheData = vi.fn();
const mockGetCachedData = vi.fn();
vi.mock('@/pwa/offline-queue', () => ({
  cacheData: (...args: unknown[]): unknown => mockCacheData(...args),
  getCachedData: (...args: unknown[]): unknown => mockGetCachedData(...args),
}));

interface AlertRow {
  id: string;
  ruleId: string;
  ruleName: string;
  farmId: string | null;
  pondId: string | null;
  sensorId: string | null;
  severity: string;
  message: string;
  triggeredAt: string;
  acknowledged: boolean;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  acknowledgementNote: string | null;
  resolved: boolean;
  resolvedAt: string | null;
  createdAt: string;
}

function alertRow(overrides: Partial<AlertRow>): AlertRow {
  return {
    id: 'alert-1',
    ruleId: 'rule-1',
    ruleName: 'Low DO',
    farmId: null,
    pondId: 'tank-1',
    sensorId: 'sensor-1',
    severity: 'WARNING',
    message: 'Dissolved oxygen below threshold',
    triggeredAt: '2026-07-12T10:00:00.000Z',
    acknowledged: false,
    acknowledgedAt: null,
    acknowledgedBy: null,
    acknowledgementNote: null,
    resolved: false,
    resolvedAt: null,
    createdAt: '2026-07-12T10:00:00.000Z',
    ...overrides,
  };
}

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }): ReactElement {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe('useAlerts (MOB-HIGH-006)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCachedData.mockResolvedValue(null);
    mockCacheData.mockResolvedValue(undefined);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  it('sorts unacknowledged first, newest first within each group', async () => {
    mockGraphqlRequest.mockResolvedValue({
      alertHistory: [
        alertRow({ id: 'old-acked', acknowledged: true, triggeredAt: '2026-07-12T08:00:00.000Z' }),
        alertRow({ id: 'old-unacked', triggeredAt: '2026-07-12T09:00:00.000Z' }),
        alertRow({ id: 'new-unacked', triggeredAt: '2026-07-12T11:00:00.000Z' }),
      ],
    });

    const { result } = renderHook(() => useAlerts(), { wrapper });

    await waitFor(() => expect(result.current.alerts).toHaveLength(3));
    expect(result.current.alerts.map((a) => a.id)).toEqual(['new-unacked', 'old-unacked', 'old-acked']);
  });

  it('computes unacknowledgedCount and the critical-unacked subset', async () => {
    mockGraphqlRequest.mockResolvedValue({
      alertHistory: [
        alertRow({ id: 'c1', severity: 'CRITICAL' }),
        alertRow({ id: 'w1', severity: 'WARNING' }),
        alertRow({ id: 'c2', severity: 'CRITICAL', acknowledged: true }),
      ],
    });

    const { result } = renderHook(() => useAlerts(), { wrapper });

    await waitFor(() => expect(result.current.alerts).toHaveLength(3));
    expect(result.current.unacknowledgedCount).toBe(2);
    expect(result.current.criticalUnacknowledged.map((a) => a.id)).toEqual(['c1']);
  });

  it('acknowledge() enqueues offline-first and optimistically marks the alert acked', async () => {
    mockGraphqlRequest.mockResolvedValue({
      alertHistory: [alertRow({ id: 'c1', severity: 'CRITICAL' })],
    });
    mockAddToQueue.mockResolvedValue({ status: 'queued', id: 'op-1' });

    const { result } = renderHook(() => useAlerts(), { wrapper });
    await waitFor(() => expect(result.current.alerts).toHaveLength(1));

    await act(async () => {
      await result.current.acknowledge('c1', 'checked the aerator');
    });

    expect(mockAddToQueue).toHaveBeenCalledWith('acknowledgeAlert', {
      alertId: 'c1',
      note: 'checked the aerator',
    });
    // Optimistic: the local cache flips without any refetch (graphqlRequest is
    // never called again); the observer notification lands on the next tick.
    await waitFor(() => expect(result.current.alerts[0]?.acknowledged).toBe(true));
    expect(mockGraphqlRequest).toHaveBeenCalledTimes(1);
    expect(result.current.unacknowledgedCount).toBe(0);
    expect(result.current.criticalUnacknowledged).toHaveLength(0);
  });

  it('serves the encrypted tenant cache when the fetch fails offline', async () => {
    mockGraphqlRequest.mockRejectedValue(new Error('Failed to fetch'));
    mockGetCachedData.mockResolvedValue([alertRow({ id: 'cached-1' })]);

    const { result } = renderHook(() => useAlerts(), { wrapper });

    await waitFor(() => expect(result.current.alerts).toHaveLength(1));
    expect(result.current.alerts[0]?.id).toBe('cached-1');
  });

  it('caches fresh results into the encrypted tenant store for offline reads', async () => {
    mockGraphqlRequest.mockResolvedValue({ alertHistory: [alertRow({ id: 'a1' })] });

    const { result } = renderHook(() => useAlerts(), { wrapper });

    await waitFor(() => expect(result.current.alerts).toHaveLength(1));
    expect(mockCacheData).toHaveBeenCalledWith(
      'tenant-1',
      expect.stringContaining('alerts'),
      expect.any(Array),
      expect.any(Number),
    );
  });

  it('scopes the query cache key by tenant (FE-CRITICAL-014 discipline)', async () => {
    mockGraphqlRequest.mockResolvedValue({ alertHistory: [] });

    const { result } = renderHook(() => useAlerts(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const keys = queryClient.getQueryCache().getAll().map((q) => q.queryKey);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key.slice(0, 2)).toEqual(['tenant', 'tenant-1']);
    }
  });
});
