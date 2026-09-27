/**
 * useChannelMessages specs — FAZ 3.3 DoD: cursor pagination via
 * useInfiniteQuery (getNextPageParam rides hasMore+cursor), the single-point
 * flatten, NO placeholderData across channel switches (zero-pixel bleed), and
 * the error surface the room's banner keys on.
 */
import { createTenantQueryKey } from '@aquaculture/shared-ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { routeGraphql } from '../../__tests__/mockGraphqlClient';
import { requestMock, TEST_TENANT_ID } from '../../__tests__/sharedUiMock';
import type { Message } from '../../types/messaging';
import { flattenChannelMessages, useChannelMessages } from '../useMessagingData';

vi.mock('@aquaculture/shared-ui', async () =>
  (await import('../../__tests__/sharedUiMock')).createSharedUiMock(),
);

const CHANNEL_A = 'cccccccc-3333-4444-8555-666666666666';
const CHANNEL_B = 'dddddddd-4444-4555-8666-777777777777';

function makeMessage(id: string, createdAt: string, channelId = CHANNEL_A): Message {
  return {
    id,
    channelId,
    senderId: 'u2',
    content: `content-${id}`,
    contentType: 'TEXT',
    isDeleted: false,
    isAiGenerated: false,
    createdAt,
    editedAt: null,
    metadata: null,
    sender: null,
  };
}

/**
 * A 50-item server page with a cursor. SERVER ORDER: items newest-first
 * (items[0] = p<n>-49 = newest, items[49] = p<n>-0 = oldest), cursor = the
 * opaque next-older pointer, hasMore as configured. Higher suffix = newer.
 */
function serverPage(
  prefix: string,
  hasMore: boolean,
  cursor: string | null,
): {
  items: Message[];
  hasMore: boolean;
  cursor: string | null;
} {
  const items = Array.from({ length: 50 }, (_, i) =>
    makeMessage(`${prefix}-${49 - i}`, `2026-09-16T10:00:${String(i).padStart(2, '0')}:00Z`),
  );
  return { items, hasMore, cursor };
}

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }): React.ReactElement {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function newQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

beforeEach(() => {
  requestMock.mockReset();
});

describe('useChannelMessages (infinite query)', () => {
  it('fetches the first page with limit 50 and NO cursor, flattening oldest-first', async () => {
    routeGraphql([
      {
        match: 'query ChannelMessages',
        result: () => ({
          messages: serverPage('p0', false, null),
        }),
      },
    ]);
    const queryClient = newQueryClient();

    const { result } = renderHook(() => useChannelMessages(CHANNEL_A), {
      wrapper: makeWrapper(queryClient),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const [query, variables] = requestMock.mock.calls[0] as [
      string,
      { channelId: string; filter: { limit: number; cursor?: string } },
    ];
    expect(String(query)).toContain('query ChannelMessages');
    expect(variables).toEqual({ channelId: CHANNEL_A, filter: { limit: 50 } });

    const thread = flattenChannelMessages(result.current.data);
    expect(thread).toHaveLength(50);
    // Oldest-first: the oldest row (createdAt 00) leads.
    expect(thread[0]?.id).toBe('p0-0');
    expect(thread[49]?.id).toBe('p0-49');
    expect(result.current.hasNextPage).toBe(false);
  });

  it('fetchNextPage passes the server cursor and PREPENDS the older page in flatten order', async () => {
    routeGraphql([
      {
        match: 'query ChannelMessages',
        result: (variables) => {
          const filter = (variables as { filter?: { cursor?: string } }).filter;
          if (!filter?.cursor) {
            return { messages: serverPage('new', true, 'cursor-old-window') };
          }
          expect(filter.cursor).toBe('cursor-old-window');
          return { messages: serverPage('old', false, null) };
        },
      },
    ]);
    const queryClient = newQueryClient();

    const { result } = renderHook(() => useChannelMessages(CHANNEL_A), {
      wrapper: makeWrapper(queryClient),
    });
    await waitFor(() => expect(result.current.hasNextPage).toBe(true));

    await result.current.fetchNextPage();
    await waitFor(() => expect(result.current.data?.pages.length).toBe(2));

    const thread = flattenChannelMessages(result.current.data);
    expect(thread).toHaveLength(100);
    // The OLDER page's rows come first in the flattened (oldest-first) array.
    expect(thread[0]?.id).toBe('old-0');
    expect(thread[99]?.id).toBe('new-49');
    expect(result.current.hasNextPage).toBe(false);
  });

  it('hasNextPage is false without a cursor even when hasMore was true (no param → no loop)', async () => {
    routeGraphql([
      {
        match: 'query ChannelMessages',
        result: () => ({ messages: serverPage('p0', true, null) }),
      },
    ]);
    const queryClient = newQueryClient();
    const { result } = renderHook(() => useChannelMessages(CHANNEL_A), {
      wrapper: makeWrapper(queryClient),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.hasNextPage).toBe(false);
  });

  it('channel switch renders NOTHING of the previous thread (no placeholderData — bleed gate)', async () => {
    let switchToB = false;
    let bResolved = false;
    const bSettlable: { resolve: ((value: unknown) => void) | null } = { resolve: null };
    routeGraphql([
      {
        match: 'query ChannelMessages',
        // async: every branch resolves to a record, including the one the
        // test settles later (the route table's settle-later variant).
        result: async (): Promise<Record<string, unknown>> => {
          if (!switchToB) return { messages: serverPage('a', false, null) };
          if (!bResolved) {
            return new Promise<Record<string, unknown>>((resolve) => {
              bSettlable.resolve = (value) => {
                bResolved = true;
                resolve(value as Record<string, unknown>);
              };
            });
          }
          return { messages: serverPage('b', false, null) };
        },
      },
    ]);
    const queryClient = newQueryClient();

    const { result, rerender } = renderHook(
      ({ channelId }: { channelId: string | undefined }) => useChannelMessages(channelId),
      {
        wrapper: makeWrapper(queryClient),
        initialProps: { channelId: CHANNEL_A },
      },
    );
    await waitFor(() =>
      expect(flattenChannelMessages(result.current.data).some((m) => m.id === 'a-49')).toBe(true),
    );

    switchToB = true;
    rerender({ channelId: CHANNEL_B });

    // While B loads, the cache under B's key holds ZERO of A's rows.
    await waitFor(() => expect(result.current.isLoading).toBe(true));
    expect(flattenChannelMessages(result.current.data)).toEqual([]);

    bSettlable.resolve?.({ messages: serverPage('b', false, null) });
    await waitFor(() =>
      expect(flattenChannelMessages(result.current.data).some((m) => m.id === 'b-49')).toBe(true),
    );
  });

  it('a failed fetch surfaces isError for the room banner', async () => {
    routeGraphql([
      {
        match: 'query ChannelMessages',
        result: () => {
          throw new Error('upstream refused');
        },
      },
    ]);
    const queryClient = newQueryClient();
    const { result } = renderHook(() => useChannelMessages(CHANNEL_A), {
      wrapper: makeWrapper(queryClient),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(Error);
  });

  it('caches per channel under the tenant-scoped key (isolation by channelId segment)', async () => {
    routeGraphql([
      {
        match: 'query ChannelMessages',
        result: () => ({ messages: serverPage('p0', false, null) }),
      },
    ]);
    const queryClient = newQueryClient();
    const { result } = renderHook(() => useChannelMessages(CHANNEL_A), {
      wrapper: makeWrapper(queryClient),
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(
      queryClient.getQueryData(
        createTenantQueryKey(TEST_TENANT_ID, 'messaging', 'messages', CHANNEL_A),
      ),
    ).toBeDefined();
    expect(
      queryClient.getQueryData(
        createTenantQueryKey(TEST_TENANT_ID, 'messaging', 'messages', CHANNEL_B),
      ),
    ).toBeUndefined();
  });
});
