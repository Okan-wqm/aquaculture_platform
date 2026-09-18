/**
 * useSendMessage specs — FAZ 1 Görev 1 (FAZ 3.3 cache-shape update).
 *
 * Pins the three properties the panel's send path must hold:
 *  1. the GraphQL input carries the caller's idempotencyKey (backend ID!);
 *  2. the send is OPTIMISTIC — a temp row appears before the server answers,
 *     is replaced (id-deduped) on success and rolled back on error;
 *  3. the success invalidation cannot duplicate the message even when the
 *     refetch races the optimistic replacement (socket echo scenario).
 *
 * FAZ 3.3: the thread cache is an INFINITE query ({pages} in server order —
 * newest-first items, pages[0] = newest window). Priming reads/writes go
 * through the same flatten/invert convention the hook uses.
 */
import { createTenantInvalidationKey, createTenantQueryKey } from '@aquaculture/shared-ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelMessagesPage } from '../../lib/messageCache';
import { routeGraphql } from '../../test-utils/mockGraphqlClient';
import { requestMock, TEST_TENANT_ID, TEST_USER_ID } from '../../test-utils/sharedUiMock';
import type { Message } from '../../types/messaging';
import { flattenChannelMessages, useChannelMessages, useSendMessage } from '../useMessagingData';

vi.mock('@aquaculture/shared-ui', async () =>
  (await import('../../test-utils/sharedUiMock')).createSharedUiMock(),
);

const CHANNEL = 'cccccccc-3333-4444-8555-666666666666';
const IDEMPOTENCY_KEY = 'dddddddd-4444-4555-8666-777777777777';

function makeMessage(
  id: string,
  content: string,
  senderId = 'someone-else',
  createdAt = '2026-09-16T10:00:00Z',
): Message {
  return {
    id,
    channelId: CHANNEL,
    senderId,
    content,
    contentType: 'TEXT',
    metadata: null,
    isDeleted: false,
    isAiGenerated: false,
    createdAt,
    editedAt: null,
    sender: null,
  };
}

function makeThreadCacheKey(): readonly unknown[] {
  return createTenantQueryKey(TEST_TENANT_ID, 'messaging', 'messages', CHANNEL);
}

/**
 * Read the cached thread (oldest-first, like the page renders) or fail loudly
 * — no silent undefined in assertions.
 */
function threadData(queryClient: QueryClient): Message[] {
  const data = queryClient.getQueryData<{ pages: ChannelMessagesPage[]; pageParams: (string | null)[] }>(
    makeThreadCacheKey(),
  );
  if (!data) throw new Error('thread cache missing under the tenant-scoped key');
  return flattenChannelMessages(data);
}

/** Prime the infinite thread cache from an oldest-first array (test-friendly). */
function primeThread(queryClient: QueryClient, oldestFirst: Message[]): void {
  queryClient.setQueryData(makeThreadCacheKey(), {
    pages: [{ items: [...oldestFirst].reverse(), hasMore: false, cursor: null }],
    pageParams: [null],
  });
}

/** Deferred for controlling a mutation/query resolution from the test body. */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}
function deferred<T>(): Deferred<T> {
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

beforeEach(() => {
  requestMock.mockReset();
});

describe('useSendMessage', () => {
  it('sends channelId, contentType and the caller idempotencyKey in the GraphQL input', async () => {
    routeGraphql([
      { match: 'mutation SendMessage', result: { sendMessage: makeMessage('srv-1', 'hello') } },
    ]);
    const queryClient = newQueryClient();

    const { result } = renderHook(() => useSendMessage(CHANNEL), {
      wrapper: makeWrapper(queryClient),
    });
    await result.current.mutateAsync({ content: 'hello', idempotencyKey: IDEMPOTENCY_KEY });

    const sendCall = requestMock.mock.calls.find(([query]) =>
      String(query).includes('mutation SendMessage'),
    );
    expect(sendCall).toBeDefined();
    expect(sendCall?.[1]).toEqual({
      input: {
        channelId: CHANNEL,
        content: 'hello',
        contentType: 'TEXT',
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    });
  });

  it('optimistically appends a temp row (sender = me) and replaces it with the server row on success', async () => {
    const pending = deferred<Record<string, unknown>>();
    routeGraphql([
      { match: 'mutation SendMessage', result: () => pending.promise },
    ]);
    const queryClient = newQueryClient();
    primeThread(queryClient, [makeMessage('srv-0', 'earlier')]);

    const { result } = renderHook(() => useSendMessage(CHANNEL), {
      wrapper: makeWrapper(queryClient),
    });
    const sent = result.current.mutateAsync({ content: 'optimistic!', idempotencyKey: IDEMPOTENCY_KEY });

    // Before the server answers: the temp row is already in the thread.
    await waitFor(() => {
      expect(threadData(queryClient)).toHaveLength(2);
    });
    const tempRow = threadData(queryClient).find(
      (m) => m.id === `temp-${IDEMPOTENCY_KEY}`,
    );
    expect(tempRow).toMatchObject({
      channelId: CHANNEL,
      senderId: TEST_USER_ID,
      content: 'optimistic!',
      isDeleted: false,
    });

    pending.resolve({
      sendMessage: makeMessage('srv-1', 'optimistic!', TEST_USER_ID, '2026-09-16T10:05:00Z'),
    });
    await sent;

    const thread = threadData(queryClient);
    expect(thread.map((m) => m.id)).toEqual(['srv-0', 'srv-1']);
    expect(thread.filter((m) => m.id === 'srv-1')).toHaveLength(1);
  });

  it('rolls the thread back when the send fails (no lingering delivered-looking bubble)', async () => {
    const failure = deferred<Record<string, unknown>>();
    routeGraphql([{ match: 'mutation SendMessage', result: () => failure.promise }]);
    const queryClient = newQueryClient();
    primeThread(queryClient, [makeMessage('srv-0', 'earlier')]);

    const { result } = renderHook(() => useSendMessage(CHANNEL), {
      wrapper: makeWrapper(queryClient),
    });
    const sent = result.current.mutateAsync({ content: 'will fail', idempotencyKey: IDEMPOTENCY_KEY });
    await waitFor(() => {
      expect(threadData(queryClient)).toHaveLength(2);
    });

    failure.reject(new Error('boom'));
    await expect(sent).rejects.toThrow('boom');

    // onError restored the snapshot exactly — temp row gone, original intact.
    expect(threadData(queryClient).map((m) => m.id)).toEqual(['srv-0']);
  });

  it('dedupes an idempotent replay: server returns the PREVIOUS message, thread keeps it exactly once', async () => {
    // The user re-sent the same draft after a failure; the backend replays the
    // first send's message (same id) instead of creating a new row.
    routeGraphql([
      { match: 'mutation SendMessage', result: { sendMessage: makeMessage('srv-0', 'earlier') } },
    ]);
    const queryClient = newQueryClient();
    primeThread(queryClient, [makeMessage('srv-0', 'earlier')]);

    const { result } = renderHook(() => useSendMessage(CHANNEL), {
      wrapper: makeWrapper(queryClient),
    });
    await result.current.mutateAsync({ content: 'earlier', idempotencyKey: 'eeeeeeee-5555-4666-8777-888888888888' });

    const thread = threadData(queryClient);
    expect(thread.filter((m) => m.id === 'srv-0')).toHaveLength(1);
    expect(thread.some((m) => String(m.id).startsWith('temp-'))).toBe(false);
  });

  it('invalidates the thread and the channel list on success (tenant-scoped keys)', async () => {
    routeGraphql([
      { match: 'mutation SendMessage', result: { sendMessage: makeMessage('srv-1', 'hello') } },
    ]);
    const queryClient = newQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useSendMessage(CHANNEL), {
      wrapper: makeWrapper(queryClient),
    });
    await result.current.mutateAsync({ content: 'hello', idempotencyKey: IDEMPOTENCY_KEY });

    const invalidatedKeys = invalidateSpy.mock.calls.map(([arg]) => arg?.queryKey);
    expect(invalidatedKeys).toContainEqual(
      createTenantInvalidationKey(TEST_TENANT_ID, 'messaging', 'messages', CHANNEL),
    );
    expect(invalidatedKeys).toContainEqual(
      createTenantInvalidationKey(TEST_TENANT_ID, 'messaging', 'channels'),
    );
  });

  it('success invalidation + refetch race (socket echo) cannot duplicate the message', async () => {
    // Mount the real thread query so the success invalidation triggers an
    // ACTIVE refetch, exactly like the socket newMessage handler does — then
    // assert the message settles in the cache exactly once.
    const sendDeferred = deferred<Record<string, unknown>>();
    let refetchCount = 0;
    routeGraphql([
      {
        match: 'query ChannelMessages',
        result: () => {
          refetchCount += 1;
          // Newest-first from the subgraph; the flatten reverses to oldest-first.
          const items = refetchCount === 1 ? [makeMessage('srv-0', 'earlier')] : [
            makeMessage('srv-1', 'fresh', TEST_USER_ID),
            makeMessage('srv-0', 'earlier'),
          ];
          return { messages: { hasMore: false, cursor: null, items } };
        },
      },
      { match: 'mutation SendMessage', result: () => sendDeferred.promise },
    ]);
    const queryClient = newQueryClient();

    const { result } = renderHook(
      () => ({ send: useSendMessage(CHANNEL), thread: useChannelMessages(CHANNEL) }),
      { wrapper: makeWrapper(queryClient) },
    );
    await waitFor(() =>
      expect(flattenChannelMessages(result.current.thread.data)).toEqual([
        makeMessage('srv-0', 'earlier'),
      ]),
    );

    const sent = result.current.send.mutateAsync({
      content: 'fresh',
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    await waitFor(() =>
      expect(
        flattenChannelMessages(result.current.thread.data)?.some(
          (m) => m.id === `temp-${IDEMPOTENCY_KEY}`,
        ),
      ).toBe(true),
    );
    sendDeferred.resolve({ sendMessage: makeMessage('srv-1', 'fresh', TEST_USER_ID) });
    await sent;

    // The invalidation refetch (active observer) lands with the server truth;
    // the final thread contains each message exactly once.
    await waitFor(() => {
      expect(refetchCount).toBeGreaterThanOrEqual(2);
      const ids = flattenChannelMessages(result.current.thread.data).map((m) => m.id) ?? [];
      expect(ids).toEqual(['srv-0', 'srv-1']);
      expect(ids.filter((id) => id === 'srv-1')).toHaveLength(1);
    });
  });

  it('error-side rollback re-invalidates: a socket-refetched message is not stranded (V1 MAJOR-2)', async () => {
    // While the send is in flight, the socket handler's refetch lands a NEW
    // server message in the cache. The failed send's snapshot rollback wipes
    // it — onError must re-invalidate so the active observer converges back
    // to server truth instead of hiding that message until the next event.
    const sendDeferred = deferred<Record<string, unknown>>();
    let refetchCount = 0;
    routeGraphql([
      {
        match: 'query ChannelMessages',
        result: () => {
          refetchCount += 1;
          // First fetch: baseline. Later fetches: a message arrived from
          // someone else while our send was in flight (socket-driven refetch).
          const items =
            refetchCount === 1
              ? [makeMessage('srv-0', 'earlier')]
              : [
                  makeMessage('srv-9', 'from someone else'),
                  makeMessage('srv-0', 'earlier'),
                ];
          return { messages: { hasMore: false, cursor: null, items } };
        },
      },
      { match: 'mutation SendMessage', result: () => sendDeferred.promise },
    ]);
    const queryClient = newQueryClient();

    const { result } = renderHook(
      () => ({ send: useSendMessage(CHANNEL), thread: useChannelMessages(CHANNEL) }),
      { wrapper: makeWrapper(queryClient) },
    );
    await waitFor(() =>
      expect(flattenChannelMessages(result.current.thread.data)).toEqual([
        makeMessage('srv-0', 'earlier'),
      ]),
    );

    const sent = result.current.send.mutateAsync({
      content: 'will fail',
      idempotencyKey: IDEMPOTENCY_KEY,
    });
    await waitFor(() =>
      expect(
        flattenChannelMessages(result.current.thread.data)?.some(
          (m) => m.id === `temp-${IDEMPOTENCY_KEY}`,
        ),
      ).toBe(true),
    );

    // The socket-driven refetch lands mid-flight (active observer refresh).
    sendDeferred.reject(new Error('boom'));
    await expect(sent).rejects.toThrow('boom');

    await waitFor(() => {
      expect(refetchCount).toBeGreaterThanOrEqual(2);
      const ids = flattenChannelMessages(result.current.thread.data).map((m) => m.id);
      // The stranded message is back (re-invalidated), the temp row is gone.
      expect(ids).toContain('srv-9');
      expect(ids.some((id) => id.startsWith('temp-'))).toBe(false);
    });
  });
});
