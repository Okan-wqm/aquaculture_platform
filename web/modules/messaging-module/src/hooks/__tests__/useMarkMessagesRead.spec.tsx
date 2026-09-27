/**
 * useMarkMessagesRead specs — FAZ 1 Görev 2.
 *
 * Pins the optimistic-unread contract: calling the mutation zeroes ONLY the
 * active channel's unreadCount in the channels cache before the server
 * confirms, rolls it back on failure, sends the backend's MarkReadInput
 * ({ channelId, messageId }), and invalidates the channel list on success so
 * the counter snaps to server truth.
 */
import { createTenantInvalidationKey, createTenantQueryKey } from '@aquaculture/shared-ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { routeGraphql } from '../../__tests__/mockGraphqlClient';
import { requestMock, TEST_TENANT_ID } from '../../__tests__/sharedUiMock';
import type { Channel } from '../../types/messaging';
import { useMarkMessagesRead } from '../useMessagingData';

vi.mock('@aquaculture/shared-ui', async () =>
  (await import('../../__tests__/sharedUiMock')).createSharedUiMock(),
);

const ACTIVE_CHANNEL = 'cccccccc-3333-4444-8555-666666666666';
const OTHER_CHANNEL = 'dddddddd-4444-4555-8666-777777777777';

function makeChannel(id: string, unreadCount: number): Channel {
  return {
    id,
    type: 'DIRECT',
    name: null,
    description: null,
    avatarUrl: null,
    isArchived: false,
    aiPersona: null,
    unreadCount,
    memberCount: 2,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    lastMessage: null,
    members: null,
  };
}

function channelsCacheKey(): readonly unknown[] {
  return createTenantQueryKey(TEST_TENANT_ID, 'messaging', 'channels');
}

/** Read the cached channel list or fail loudly (no silent undefined). */
function channelsData(queryClient: QueryClient): Channel[] {
  const data = queryClient.getQueryData<Channel[]>(channelsCacheKey());
  if (!data) throw new Error('channels cache missing under the tenant-scoped key');
  return data;
}

function unreadOf(queryClient: QueryClient, channelId: string): number | null {
  return channelsData(queryClient).find((c) => c.id === channelId)?.unreadCount ?? null;
}

interface SettlablePromise<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}
function settlable<T>(): SettlablePromise<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }): React.ReactElement {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function newQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function seedChannels(queryClient: QueryClient): void {
  queryClient.setQueryData(channelsCacheKey(), [
    makeChannel(ACTIVE_CHANNEL, 3),
    makeChannel(OTHER_CHANNEL, 5),
  ]);
}

beforeEach(() => {
  requestMock.mockReset();
});

describe('useMarkMessagesRead', () => {
  it('sends the backend MarkReadInput shape { channelId, messageId }', async () => {
    routeGraphql([{ match: 'mutation MarkMessagesRead', result: { markMessagesRead: true } }]);
    const queryClient = newQueryClient();

    const { result } = renderHook(() => useMarkMessagesRead(ACTIVE_CHANNEL), {
      wrapper: makeWrapper(queryClient),
    });
    await result.current.mutateAsync('mmmmmmmm-9999-4000-8111-222222222222');

    const call = requestMock.mock.calls.find(([query]) =>
      String(query).includes('mutation MarkMessagesRead'),
    );
    expect(call?.[1]).toEqual({
      input: { channelId: ACTIVE_CHANNEL, messageId: 'mmmmmmmm-9999-4000-8111-222222222222' },
    });
  });

  it('optimistically zeroes ONLY the active channel unread before the server confirms', async () => {
    const pending = settlable<Record<string, unknown>>();
    routeGraphql([{ match: 'mutation MarkMessagesRead', result: () => pending.promise }]);
    const queryClient = newQueryClient();
    seedChannels(queryClient);

    const { result } = renderHook(() => useMarkMessagesRead(ACTIVE_CHANNEL), {
      wrapper: makeWrapper(queryClient),
    });
    const sent = result.current.mutateAsync('m-1');

    await waitFor(() => {
      expect(unreadOf(queryClient, ACTIVE_CHANNEL)).toBe(0);
    });
    // Other channels are untouched.
    expect(unreadOf(queryClient, OTHER_CHANNEL)).toBe(5);

    pending.resolve({ markMessagesRead: true });
    await sent;
  });

  it('rolls the unread back when the mutation fails', async () => {
    const failure = settlable<Record<string, unknown>>();
    routeGraphql([{ match: 'mutation MarkMessagesRead', result: () => failure.promise }]);
    const queryClient = newQueryClient();
    seedChannels(queryClient);

    const { result } = renderHook(() => useMarkMessagesRead(ACTIVE_CHANNEL), {
      wrapper: makeWrapper(queryClient),
    });
    const sent = result.current.mutateAsync('m-1');
    await waitFor(() => {
      expect(unreadOf(queryClient, ACTIVE_CHANNEL)).toBe(0);
    });

    failure.reject(new Error('boom'));
    await expect(sent).rejects.toThrow('boom');

    expect(unreadOf(queryClient, ACTIVE_CHANNEL)).toBe(3);
  });

  it('invalidates the tenant-scoped channels list on success', async () => {
    routeGraphql([{ match: 'mutation MarkMessagesRead', result: { markMessagesRead: true } }]);
    const queryClient = newQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useMarkMessagesRead(ACTIVE_CHANNEL), {
      wrapper: makeWrapper(queryClient),
    });
    await result.current.mutateAsync('m-1');

    const invalidatedKeys = invalidateSpy.mock.calls.map(([arg]) => arg?.queryKey);
    expect(invalidatedKeys).toContainEqual(
      createTenantInvalidationKey(TEST_TENANT_ID, 'messaging', 'channels'),
    );
  });
});
