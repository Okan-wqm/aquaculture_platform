/**
 * Channel READ-boundary wire-casing tests — MSG-HIGH-054 (read half).
 *
 * The messaging subgraph registers `ChannelType` WITHOUT a valuesMap, so
 * graphql-js not only rejects the lowercase value on writes — it also
 * SERIALIZES the stored lowercase value back to its enum KEY on reads
 * (`'group'` -> `'GROUP'`). The mobile UI compares the internal lowercase form
 * (`channel.type === 'group'`), so an un-normalized read silently mismatches
 * every avatar/branch decision.
 *
 * These tests pin the READ boundary: `useChannels` and `useChannelDetail` must
 * normalize the wire KEY back to the internal lowercase value via
 * {@link normalizeChannelType} before the data ever reaches the UI.
 */

import { renderHook } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

// --------------------------------------------------------------------------
// Mocks — declared before imports (hoisted by vitest)
//
// WHY useQuery is mocked to capture and run its `queryFn`: the monorepo has
// duplicated React instances which breaks renderHook with a real
// QueryClientProvider (same constraint as useCreateChannel.spec.ts). We
// intercept useQuery, capture the in-flight queryFn promise in a module-level
// handle, and await it directly — exercising the exact read path that maps the
// wire response through normalizeChannelType. The hook's own return shape is
// irrelevant; we assert on the resolved queryFn output.
// --------------------------------------------------------------------------

interface QueryConfig<T> {
  queryFn: () => Promise<T>;
  enabled?: boolean;
}

const mockGraphqlRequest = vi.fn<(...args: unknown[]) => Promise<unknown>>();

// The most recent in-flight queryFn promise captured by the useQuery mock.
let capturedQueryPromise: Promise<unknown> | null = null;

vi.mock('../useAuth', () => ({
  // MT-CRITICAL-051: useChannels now gates on user.id (the channel list is
  // membership-scoped, so its cache is user-partitioned), so the mock supplies a
  // user id — without it `enabled` is false and the queryFn never runs.
  useAuth: () => ({ isAuthenticated: true, tenantId: 'tenant-1', user: { id: 'user-1' } }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: <T>(config: QueryConfig<T>) => {
    capturedQueryPromise = config.enabled === false ? Promise.resolve(undefined) : config.queryFn();
    return { data: undefined, error: null, isLoading: true, refetch: vi.fn() };
  },
}));

vi.mock('@/pwa/offline-queue', () => ({
  // useChannelDetail still uses the tenant-scoped helpers; useChannels now uses
  // the user-scoped ones (MT-CRITICAL-051) — provide both so neither hook's
  // queryFn hits an undefined import.
  cacheData: vi.fn().mockResolvedValue(undefined),
  getCachedData: vi.fn().mockResolvedValue(null),
  cacheUserData: vi.fn().mockResolvedValue(undefined),
  getCachedUserData: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/services/authenticated-fetch', () => ({
  graphqlRequest: (...args: unknown[]) => mockGraphqlRequest(...args),
  authenticatedFetch: vi.fn(),
  syncAuthStore: vi.fn(),
}));

// Import after mocks.
import { useChannelDetail } from '../useChannelDetail';
import { useChannels } from '../useChannels';

/** Await the queryFn promise the useQuery mock captured for the last render. */
async function settleQuery<T>(): Promise<T> {
  if (!capturedQueryPromise) throw new Error('no queryFn was captured');
  return capturedQueryPromise as Promise<T>;
}

describe('channel read boundary — wire-casing the ChannelType enum (MSG-HIGH-054 read half)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedQueryPromise = null;
  });

  it('useChannels normalizes the wire KEY GROUP back to lowercase group', async () => {
    mockGraphqlRequest.mockResolvedValue({
      myChannels: {
        items: [
          { id: 'c1', type: 'GROUP', name: 'Ops', members: [] },
          { id: 'c2', type: 'DIRECT', name: null, members: [] },
          { id: 'c3', type: 'AI', name: 'Assistant', members: [] },
        ],
        total: 3,
      },
    });

    renderHook(() => useChannels());
    const page = await settleQuery<{ items: Array<{ type: string }> }>();

    expect(page.items.map((c) => c.type)).toEqual(['group', 'direct', 'ai']);
    // The wire casing must never leak through.
    expect(page.items.some((c) => c.type === 'GROUP')).toBe(false);
  });

  it('useChannelDetail normalizes the wire KEY back to the internal lowercase value', async () => {
    mockGraphqlRequest.mockResolvedValue({
      channel: { id: 'c1', type: 'GROUP', name: 'Ops', members: [] },
    });

    renderHook(() => useChannelDetail('c1'));
    const channel = await settleQuery<{ type: string }>();

    expect(channel.type).toBe('group');
    expect(channel.type).not.toBe('GROUP');
  });

  it('useChannels tolerates a legacy already-lowercase cache value (no throw)', async () => {
    // An older build cached the internal lowercase form; the read boundary must
    // round-trip it unchanged rather than reject it.
    mockGraphqlRequest.mockResolvedValue({
      myChannels: {
        items: [{ id: 'c1', type: 'group', name: 'Ops', members: [] }],
        total: 1,
      },
    });

    renderHook(() => useChannels());
    const page = await settleQuery<{ items: Array<{ type: string }> }>();

    expect(page.items[0].type).toBe('group');
  });
});
