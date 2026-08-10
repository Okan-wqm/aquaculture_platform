// MOB-MEDIUM-003 — the "Weekly Sentiment" badge must show real analytics.
//
// ChannelSettingsPage previously rendered a hardcoded 'neutral' badge to
// TENANT_ADMIN whenever AI analysis was on — mock data presented as truth.
// This hook binds the badge to the real `sentimentTrends` weekly aggregates
// (messaging subgraph, TENANT_ADMIN-gated): the latest week's avgScore maps to
// the badge level, and "no analysis rows yet" is an explicit null so the page
// renders nothing instead of a fake verdict.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { useSentimentTrends } from '../useSentimentTrends';

const mockGraphqlRequest = vi.fn();
vi.mock('@/services/authenticated-fetch', () => ({
  graphqlRequest: (...args: unknown[]): unknown => mockGraphqlRequest(...args),
}));

vi.mock('../useAuth', () => ({
  useAuth: (): { tenantId: string } => ({ tenantId: 'tenant-1' }),
}));

function row(
  overrides: Partial<{ weekStart: string; avgScore: number; messageCount: number; trend: string }>,
): {
  channelId: string;
  weekStart: string;
  avgScore: number;
  messageCount: number;
  trend: string;
} {
  return {
    channelId: 'chan-1',
    weekStart: '2026-07-06T00:00:00.000Z',
    avgScore: 0.5,
    messageCount: 12,
    trend: 'stable',
    ...overrides,
  };
}

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }): ReactElement {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe('useSentimentTrends (MOB-MEDIUM-003)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  });

  it('maps a high latest avgScore to a positive badge', async () => {
    mockGraphqlRequest.mockResolvedValue({ sentimentTrends: [row({ avgScore: 0.8 })] });

    const { result } = renderHook(() => useSentimentTrends('chan-1', true), { wrapper });

    await waitFor(() => expect(result.current.latest).not.toBeNull());
    expect(result.current.latest?.badge).toBe('positive');
    expect(result.current.latest?.messageCount).toBe(12);
  });

  it('maps mid and low scores to neutral and negative', async () => {
    mockGraphqlRequest.mockResolvedValue({ sentimentTrends: [row({ avgScore: 0.5 })] });
    const mid = renderHook(() => useSentimentTrends('chan-1', true), { wrapper });
    await waitFor(() => expect(mid.result.current.latest).not.toBeNull());
    expect(mid.result.current.latest?.badge).toBe('neutral');

    queryClient.clear();
    mockGraphqlRequest.mockResolvedValue({ sentimentTrends: [row({ avgScore: 0.2 })] });
    const low = renderHook(() => useSentimentTrends('chan-1', true), { wrapper });
    await waitFor(() => expect(low.result.current.latest).not.toBeNull());
    expect(low.result.current.latest?.badge).toBe('negative');
  });

  it('picks the most recent week even if rows arrive unordered', async () => {
    mockGraphqlRequest.mockResolvedValue({
      sentimentTrends: [
        row({ weekStart: '2026-06-22T00:00:00.000Z', avgScore: 0.9 }),
        row({ weekStart: '2026-07-06T00:00:00.000Z', avgScore: 0.1 }),
        row({ weekStart: '2026-06-29T00:00:00.000Z', avgScore: 0.9 }),
      ],
    });

    const { result } = renderHook(() => useSentimentTrends('chan-1', true), { wrapper });

    await waitFor(() => expect(result.current.latest).not.toBeNull());
    expect(result.current.latest?.badge).toBe('negative');
    expect(result.current.latest?.weekStart).toBe('2026-07-06T00:00:00.000Z');
  });

  it('returns null when no analysis rows exist — never a fake verdict', async () => {
    mockGraphqlRequest.mockResolvedValue({ sentimentTrends: [] });

    const { result } = renderHook(() => useSentimentTrends('chan-1', true), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.latest).toBeNull();
  });

  it('does not fetch when disabled (non-admin / AI off / no consent)', async () => {
    const { result } = renderHook(() => useSentimentTrends('chan-1', false), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
    expect(result.current.latest).toBeNull();
  });

  it('scopes the query cache key by tenant (FE-CRITICAL-014 discipline)', async () => {
    mockGraphqlRequest.mockResolvedValue({ sentimentTrends: [row({})] });

    const { result } = renderHook(() => useSentimentTrends('chan-1', true), { wrapper });
    await waitFor(() => expect(result.current.latest).not.toBeNull());

    const keys = queryClient
      .getQueryCache()
      .getAll()
      .map((q) => q.queryKey);
    expect(keys).toHaveLength(1);
    expect(keys[0]?.slice(0, 2)).toEqual(['tenant', 'tenant-1']);
  });
});
