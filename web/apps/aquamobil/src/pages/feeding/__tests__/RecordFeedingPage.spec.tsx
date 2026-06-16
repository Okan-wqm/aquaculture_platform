/**
 * RecordFeedingPage offline-cache tests — FE-MEDIUM-054.
 *
 * Before the fix, useTodaysFeedingPlan gated its query with `&& isOnline`, so
 * offline the feeding plan rendered EMPTY. The fix:
 *   - removes isOnline from the enabled gate,
 *   - write-throughs the executions to the encrypted tenant-scoped cache on every
 *     successful online fetch (cacheData),
 *   - seeds the query from getCachedData on mount so the last-known plan renders
 *     offline, with an explicit "offline — last-synced plan" banner.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock state
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => ({
  isOnline: true,
  graphqlRequest: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  cacheData: vi.fn<(...args: unknown[]) => Promise<void>>(),
  getCachedData: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  addToQueue: vi.fn(),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ accessToken: 'token', tenantId: 'tenant-1', isAuthenticated: true }),
}));

vi.mock('@/hooks/useTanks', () => ({
  useTanks: () => ({ data: [] }),
}));

vi.mock('@/hooks/useOfflineQueue', () => ({
  useOfflineQueue: () => ({ addToQueue: h.addToQueue, isOnline: h.isOnline }),
}));

vi.mock('@/services/authenticated-fetch', () => ({
  graphqlRequest: (...args: unknown[]) => h.graphqlRequest(...args),
}));

vi.mock('@/pwa/offline-queue', () => ({
  cacheData: (...args: unknown[]) => h.cacheData(...args),
  getCachedData: (...args: unknown[]) => h.getCachedData(...args),
}));

import { RecordFeedingPage } from '../RecordFeedingPage';

const exec = {
  id: 'exec-1',
  equipmentId: 'tank-1',
  equipmentName: 'Tank 1',
  equipmentCode: 'T1',
  calculations: { plannedFeedKg: 5, activeFeedCode: 'F1', biomassKg: 100, feedingRatePercent: 5 },
  plannedFeedKg: 5,
  actualFeedKg: null,
  status: 'PENDING',
  hasTransitionWarning: false,
};

function wrapper(client: QueryClient): ({ children }: { children: ReactNode }) => ReactNode {
  function Wrapper({ children }: { children: ReactNode }): ReactNode {
    return createElement(QueryClientProvider, { client }, children);
  }
  return Wrapper;
}

describe('RecordFeedingPage — offline feeding-plan cache (FE-MEDIUM-054)', () => {
  let client: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    h.isOnline = true;
    h.getCachedData.mockResolvedValue(null);
    client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  });

  afterEach(() => {
    cleanup();
    client.clear();
  });

  it('write-throughs the fetched plan to the encrypted cache on a successful online fetch', async () => {
    h.graphqlRequest.mockResolvedValue({ dailyFeedingExecutions: [exec] });

    render(createElement(RecordFeedingPage), { wrapper: wrapper(client) });

    await waitFor(() => expect(h.cacheData).toHaveBeenCalled());
    const [tenantId, key, value] = h.cacheData.mock.calls[0] ?? [];
    expect(tenantId).toBe('tenant-1');
    expect(String(key)).toMatch(/^feedingPlan_/);
    expect(value).toEqual([exec]);
  });

  it('renders the last-synced plan + offline banner when offline with a cached seed', async () => {
    h.isOnline = false;
    h.getCachedData.mockResolvedValue([exec]);
    // Offline: the query still mounts (no isOnline gate) but the fetch fails; the
    // cached seed renders via placeholderData.
    h.graphqlRequest.mockRejectedValue(new Error('offline'));

    render(createElement(RecordFeedingPage), { wrapper: wrapper(client) });

    await waitFor(() =>
      expect(screen.getByText(/showing last-synced plan/i)).toBeTruthy(),
    );
  });
});
