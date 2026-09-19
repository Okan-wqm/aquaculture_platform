/**
 * useMessagingSocket specs — FAZ 3 DoD.
 *
 * Pins the FAZ 3 contract of the panel socket:
 *  - channel-room decision: connect (re)joins EVERY cached channel with a
 *    consumed ack; channels arriving later join too;
 *  - amplification: newMessage/messageUpdated/messageDeleted/readReceipt are
 *    pure cache mutations (NO invalidation, NO extra GraphQL round trip);
 *    messageSyncHint/channelEvent/channelMemberRemoved keep the invalidation
 *    recovery path;
 *  - resilience: reAuth answers with refreshAuth + reAuthResponse; 401/4401
 *    connect_error STOPS the reconnect loop and recovers the session; the
 *    reconnect loop itself is jittered, /health/live-gated, bounded, and
 *    revived by visibilitychange (2s debounce).
 */
import type { WsMessage } from '@aquaculture/shared-ui';
import { createTenantInvalidationKey, createTenantQueryKey } from '@aquaculture/shared-ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelMessagesPage } from '../../lib/messageCache';
import {
  ackLastEmit,
  fireSocketEvent,
  getMockSocket,
  ioSpy,
  resetSocketMock,
  socketConnectSpy,
  socketDisconnectSpy,
  socketEmitSpy,
} from '../../__tests__/mockSocketIo';
import {
  getAccessTokenMock,
  refreshAuthMock,
  requestMock,
  TEST_TENANT_ID,
  TEST_USER_ID,
} from '../../__tests__/sharedUiMock';
import type { Channel, Message } from '../../types/messaging';
import { useMessagingSocket } from '../useMessagingSocket';

vi.mock('@aquaculture/shared-ui', async () =>
  (await import('../../__tests__/sharedUiMock')).createSharedUiMock(),
);
vi.mock('socket.io-client', async () =>
  (await import('../../__tests__/mockSocketIo')).socketIoModuleMock(),
);

const ACTIVE_CHANNEL = 'cccccccc-3333-4444-8555-666666666666';
const OTHER_CHANNEL = 'dddddddd-4444-4555-8666-777777777777';

function newQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function makeWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }): React.ReactElement {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function makeMessage(id: string, createdAt: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    channelId: ACTIVE_CHANNEL,
    senderId: 'u2',
    content: `content-${id}`,
    contentType: 'TEXT',
    isDeleted: false,
    isAiGenerated: false,
    createdAt,
    editedAt: null,
    metadata: null,
    sender: null,
    ...overrides,
  };
}

function makeWsMessage(overrides: Partial<WsMessage> = {}): WsMessage {
  return {
    id: 'ws-1',
    channelId: ACTIVE_CHANNEL,
    senderId: 'u2',
    content: 'live hello',
    contentType: 'TEXT',
    parentId: null,
    forwardedFrom: null,
    isDeleted: false,
    createdAt: '2026-09-16T10:30:00Z',
    editedAt: null,
    metadata: null,
    sender: { id: 'u2' },
    ...overrides,
  };
}

function makeChannel(id: string, overrides: Partial<Channel> = {}): Channel {
  return {
    id,
    type: 'DIRECT',
    name: null,
    description: null,
    avatarUrl: null,
    isArchived: false,
    aiPersona: null,
    unreadCount: 0,
    memberCount: 2,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    lastMessage: null,
    members: [
      {
        id: 'm1',
        userId: TEST_USER_ID,
        role: 'MEMBER',
        user: { id: TEST_USER_ID, firstName: 'Panel', lastName: 'Operator', profileImageUrl: null },
      },
      {
        id: 'm2',
        userId: 'u2',
        role: 'MEMBER',
        user: { id: 'u2', firstName: 'Mehmet', lastName: 'Demir', profileImageUrl: null },
      },
    ],
    ...overrides,
  };
}

function channelsKey(): readonly unknown[] {
  return createTenantQueryKey(TEST_TENANT_ID, 'messaging', 'channels');
}
function messagesKey(channelId: string): readonly unknown[] {
  return createTenantQueryKey(TEST_TENANT_ID, 'messaging', 'messages', channelId);
}

/** Read the primed infinite messages cache, flattened (oldest-first). */
function threadOf(queryClient: QueryClient, channelId: string): Message[] {
  const data = queryClient.getQueryData<{ pages: ChannelMessagesPage[] }>(messagesKey(channelId));
  const pages = data?.pages ?? [];
  const out: Message[] = [];
  for (let i = pages.length - 1; i >= 0; i -= 1) {
    const page = pages[i];
    if (!page) continue;
    for (let j = page.items.length - 1; j >= 0; j -= 1) out.push(page.items[j] as Message);
  }
  return out;
}

function primeThread(queryClient: QueryClient, channelId: string, items: Message[]): void {
  queryClient.setQueryData(messagesKey(channelId), {
    pages: [{ items: [...items].reverse(), hasMore: false, cursor: null }],
    pageParams: [null],
  });
}

function primeChannels(queryClient: QueryClient, channels: Channel[]): void {
  queryClient.setQueryData(channelsKey(), channels);
}

function channelsOf(queryClient: QueryClient): Channel[] {
  const data = queryClient.getQueryData<Channel[]>(channelsKey());
  if (!data) throw new Error('channels cache missing');
  return data;
}

/** Route MyChannels so the hook's own useChannels() subscription resolves. */
function routeChannels(channels: Channel[]): void {
  requestMock.mockImplementation((query: string) => {
    if (String(query).includes('query MyChannels')) {
      return Promise.resolve({ myChannels: { total: channels.length, items: channels } });
    }
    return Promise.reject(new Error(`Unrouted GraphQL operation: ${String(query).slice(0, 60)}`));
  });
}

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setImmediate(resolve));
};

beforeEach(() => {
  resetSocketMock();
  requestMock.mockReset();
  refreshAuthMock.mockReset();
  refreshAuthMock.mockResolvedValue(undefined);
  getAccessTokenMock.mockReset();
  getAccessTokenMock.mockReturnValue(null);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useMessagingSocket — connection + channel-room decision (join-all)', () => {
  it('connects with the auth token and custom reconnection OFF (conditional loop owns retries)', async () => {
    const queryClient = newQueryClient();
    routeChannels([]);
    renderHook(() => useMessagingSocket(ACTIVE_CHANNEL), { wrapper: makeWrapper(queryClient) });
    await waitFor(() => expect(ioSpy).toHaveBeenCalled());

    expect(ioSpy.mock.calls[0][0]).toBe('/messaging');
    expect(ioSpy.mock.calls[0][1]).toMatchObject({
      auth: { token: 'jwt' },
      reconnection: false,
      transports: ['websocket', 'polling'],
    });
  });

  it('join-all: (re)connect joins EVERY cached channel with a consumed ack', async () => {
    const queryClient = newQueryClient();
    routeChannels([makeChannel(ACTIVE_CHANNEL), makeChannel(OTHER_CHANNEL)]);
    primeChannels(queryClient, [makeChannel(ACTIVE_CHANNEL), makeChannel(OTHER_CHANNEL)]);
    const { result } = renderHook(() => useMessagingSocket(ACTIVE_CHANNEL), {
      wrapper: makeWrapper(queryClient),
    });
    await waitFor(() => expect(ioSpy).toHaveBeenCalled());

    act(() => fireSocketEvent('connect'));
    expect(result.current.isConnected).toBe(true);

    const joinCalls = socketEmitSpy.mock.calls.filter(([event]) => event === 'joinChannel');
    expect(joinCalls).toHaveLength(2);
    for (const call of joinCalls as unknown[][]) {
      expect(call[2]).toEqual(expect.any(Function)); // ack consumed
    }
    const joinedIds = joinCalls.map((call) => (call[1] as { channelId: string }).channelId);
    expect(joinedIds).toEqual(expect.arrayContaining([ACTIVE_CHANNEL, OTHER_CHANNEL]));

    // Reconnect: the whole joined set is re-joined (snapshot).
    act(() => fireSocketEvent('disconnect'));
    socketEmitSpy.mockClear();
    act(() => fireSocketEvent('connect'));
    const rejoined = socketEmitSpy.mock.calls
      .filter(([event]) => event === 'joinChannel')
      .map((call) => (call[1] as { channelId: string }).channelId);
    expect(rejoined).toEqual(expect.arrayContaining([ACTIVE_CHANNEL, OTHER_CHANNEL]));
  });

  it('channels arriving AFTER connect join through the channels-cache effect', async () => {
    const queryClient = newQueryClient();
    routeChannels([makeChannel(ACTIVE_CHANNEL)]);
    renderHook(() => useMessagingSocket(undefined), { wrapper: makeWrapper(queryClient) });
    await waitFor(() => expect(ioSpy).toHaveBeenCalled());
    act(() => fireSocketEvent('connect'));

    // Wait for the initial channel's join to land, then a NEW channel appears
    // in the cache (e.g. a channelEvent invalidation refetch).
    const joinedIds = (): string[] =>
      socketEmitSpy.mock.calls
        .filter(([event]) => event === 'joinChannel')
        .map((call) => (call[1] as { channelId: string }).channelId);
    await waitFor(() => expect(joinedIds()).toContain(ACTIVE_CHANNEL));
    socketEmitSpy.mockClear();

    const withNew = [makeChannel(ACTIVE_CHANNEL), makeChannel(OTHER_CHANNEL)];
    routeChannels(withNew);
    act(() => {
      queryClient.setQueryData(channelsKey(), withNew);
    });

    await waitFor(() => expect(joinedIds()).toContain(OTHER_CHANNEL));
  });

  it('a DENIED join ack is retried with bounded backoff, then dropped from the intent set', async () => {
    vi.useFakeTimers();
    const queryClient = newQueryClient();
    const both = [makeChannel(ACTIVE_CHANNEL), makeChannel(OTHER_CHANNEL)];
    routeChannels(both);
    primeChannels(queryClient, both);
    renderHook(() => useMessagingSocket(ACTIVE_CHANNEL), { wrapper: makeWrapper(queryClient) });
    await vi.advanceTimersByTimeAsync(0);
    act(() => fireSocketEvent('connect'));

    // The ACTIVE channel's join acks OK; the OTHER channel's every ack answers
    // {success:false} (e.g. NATS membership verify timeout). Answer only NEW
    // emits (a cursor) — re-invoking an old ack would schedule extra retries.
    let otherAttempts = 0;
    let answeredUpTo = 0;
    const answerAcks = (): void => {
      const calls = socketEmitSpy.mock.calls.filter(([e]) => e === 'joinChannel');
      for (; answeredUpTo < calls.length; answeredUpTo += 1) {
        const call = calls[answeredUpTo] as unknown[];
        const channelId = (call[1] as { channelId: string }).channelId;
        const cb = call[call.length - 1] as (result: unknown) => void;
        if (channelId === OTHER_CHANNEL) {
          cb({ success: false, reason: 'Not a member of this channel' });
          otherAttempts += 1;
        } else {
          cb({ success: true });
        }
      }
    };
    answerAcks();
    // Retries at 500ms, 1000ms, 2000ms → then exhaustion (4 total attempts).
    await vi.advanceTimersByTimeAsync(500);
    answerAcks();
    await vi.advanceTimersByTimeAsync(1000);
    answerAcks();
    await vi.advanceTimersByTimeAsync(2000);
    answerAcks();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(otherAttempts).toBe(4); // 1 + 3 bounded retries

    // Exhausted: a reconnect re-joins only the healthy room — the dead
    // channel stays out of the intent set (opening it re-arms it, by design).
    socketEmitSpy.mockClear();
    act(() => fireSocketEvent('disconnect'));
    act(() => fireSocketEvent('connect'));
    const rejoined = socketEmitSpy.mock.calls
      .filter(([e]) => e === 'joinChannel')
      .map((call) => (call[1] as { channelId: string }).channelId);
    expect(rejoined).toEqual([ACTIVE_CHANNEL]);
    expect(rejoined).not.toContain(OTHER_CHANNEL);
  });

  it('an ACKED join settles without retries', async () => {
    vi.useFakeTimers();
    const queryClient = newQueryClient();
    routeChannels([makeChannel(ACTIVE_CHANNEL)]);
    primeChannels(queryClient, [makeChannel(ACTIVE_CHANNEL)]);
    renderHook(() => useMessagingSocket(ACTIVE_CHANNEL), { wrapper: makeWrapper(queryClient) });
    await vi.advanceTimersByTimeAsync(0);
    act(() => fireSocketEvent('connect'));

    ackLastEmit({ success: true });
    await vi.advanceTimersByTimeAsync(5000);
    expect(socketEmitSpy.mock.calls.filter(([e]) => e === 'joinChannel')).toHaveLength(1);
  });

  it('unmount disconnects the socket with no dangling listeners', async () => {
    const queryClient = newQueryClient();
    routeChannels([]);
    const { unmount } = renderHook(() => useMessagingSocket(ACTIVE_CHANNEL), {
      wrapper: makeWrapper(queryClient),
    });
    await waitFor(() => expect(ioSpy).toHaveBeenCalled());
    unmount();
    expect(socketDisconnectSpy).toHaveBeenCalled();
  });
});

describe('useMessagingSocket — amplification (cache mutations, no refetch)', () => {
  it('newMessage for the ACTIVE channel merges into the thread cache — ZERO GraphQL / invalidation', async () => {
    const queryClient = newQueryClient();
    routeChannels([makeChannel(ACTIVE_CHANNEL)]);
    primeChannels(queryClient, [makeChannel(ACTIVE_CHANNEL)]);
    primeThread(queryClient, ACTIVE_CHANNEL, [makeMessage('srv-0', '2026-09-16T10:00:00Z')]);
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    renderHook(() => useMessagingSocket(ACTIVE_CHANNEL), { wrapper: makeWrapper(queryClient) });
    await waitFor(() => expect(ioSpy).toHaveBeenCalled());
    act(() => fireSocketEvent('connect'));
    await flush(); // let the connect-time catch-up invalidations drain

    invalidateSpy.mockClear();
    requestMock.mockClear();

    act(() =>
      fireSocketEvent('newMessage', {
        channelId: ACTIVE_CHANNEL,
        message: makeWsMessage({ id: 'ws-new', createdAt: '2026-09-16T10:31:00Z' }),
      }),
    );

    // Positive: the merged row is in the cache, enriched from channel members.
    const thread = threadOf(queryClient, ACTIVE_CHANNEL);
    expect(thread.map((m) => m.id)).toEqual(['srv-0', 'ws-new']);
    expect(thread[1]?.sender).toMatchObject({ id: 'u2', firstName: 'Mehmet' });

    // Negative: the mutation path never refetched (FAZ 3 acceptance: ≤2
    // messages requests per message — here ZERO).
    await flush();
    expect(requestMock).not.toHaveBeenCalled();
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('newMessage for an INACTIVE channel bumps unread + lastMessage locally — no messages refetch', async () => {
    const queryClient = newQueryClient();
    const channels = [makeChannel(ACTIVE_CHANNEL), makeChannel(OTHER_CHANNEL, { unreadCount: 2 })];
    routeChannels(channels);
    primeChannels(queryClient, channels);
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    renderHook(() => useMessagingSocket(ACTIVE_CHANNEL), { wrapper: makeWrapper(queryClient) });
    await waitFor(() => expect(ioSpy).toHaveBeenCalled());
    act(() => fireSocketEvent('connect'));
    await flush();
    invalidateSpy.mockClear();

    act(() =>
      fireSocketEvent('newMessage', {
        channelId: OTHER_CHANNEL,
        message: makeWsMessage({
          id: 'ws-other',
          channelId: OTHER_CHANNEL,
          createdAt: '2026-09-16T10:32:00Z',
        }),
      }),
    );

    const other = channelsOf(queryClient).find((c) => c.id === OTHER_CHANNEL);
    expect(other?.unreadCount).toBe(3); // 2 + 1, locally
    expect(other?.lastMessage?.id).toBe('ws-other');
    // The inactive channel's thread cache was NOT created by the event.
    expect(queryClient.getQueryData(messagesKey(OTHER_CHANNEL))).toBeUndefined();
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('messageUpdated updates the row in place (spread keeps the enriched sender)', async () => {
    const queryClient = newQueryClient();
    routeChannels([makeChannel(ACTIVE_CHANNEL)]);
    primeChannels(queryClient, [makeChannel(ACTIVE_CHANNEL)]);
    primeThread(queryClient, ACTIVE_CHANNEL, [
      makeMessage('srv-0', '2026-09-16T10:00:00Z', {
        sender: { id: 'u2', firstName: 'Mehmet', lastName: 'Demir', profileImageUrl: null },
      }),
      makeMessage('srv-1', '2026-09-16T10:05:00Z'),
    ]);
    renderHook(() => useMessagingSocket(ACTIVE_CHANNEL), { wrapper: makeWrapper(queryClient) });
    await waitFor(() => expect(ioSpy).toHaveBeenCalled());
    act(() => fireSocketEvent('connect'));
    await flush();

    act(() =>
      fireSocketEvent('messageUpdated', {
        channelId: ACTIVE_CHANNEL,
        message: makeWsMessage({
          id: 'srv-0',
          content: 'edited live',
          createdAt: '2026-09-16T10:00:00Z',
          editedAt: '2026-09-16T10:33:00Z',
        }),
      }),
    );

    const thread = threadOf(queryClient, ACTIVE_CHANNEL);
    expect(thread).toHaveLength(2);
    expect(thread[0]).toMatchObject({ id: 'srv-0', content: 'edited live' });
    // The id-only wire sender did not wipe the cached display name.
    expect(thread[0]?.sender?.firstName).toBe('Mehmet');
  });

  it('messageDeleted marks isDeleted + content:null and fixes the channel preview', async () => {
    const queryClient = newQueryClient();
    const channels = [
      makeChannel(ACTIVE_CHANNEL, { lastMessage: makeMessage('srv-1', '2026-09-16T10:05:00Z') }),
    ];
    routeChannels(channels);
    primeChannels(queryClient, channels);
    primeThread(queryClient, ACTIVE_CHANNEL, [
      makeMessage('srv-0', '2026-09-16T10:00:00Z'),
      makeMessage('srv-1', '2026-09-16T10:05:00Z'),
    ]);
    renderHook(() => useMessagingSocket(ACTIVE_CHANNEL), { wrapper: makeWrapper(queryClient) });
    await waitFor(() => expect(ioSpy).toHaveBeenCalled());
    act(() => fireSocketEvent('connect'));
    await flush();

    act(() => fireSocketEvent('messageDeleted', { channelId: ACTIVE_CHANNEL, messageId: 'srv-1' }));

    const thread = threadOf(queryClient, ACTIVE_CHANNEL);
    expect(thread[1]).toMatchObject({ id: 'srv-1', isDeleted: true, content: null });
    // The preview fell back to the newest remaining row (srv-0).
    expect(channelsOf(queryClient)[0]?.lastMessage?.id).toBe('srv-0');
  });

  it('readReceipt: MY receipt zeroes my unread; ANOTHER user receipt writes nothing', async () => {
    const queryClient = newQueryClient();
    const channels = [
      makeChannel(ACTIVE_CHANNEL, { unreadCount: 4 }),
      makeChannel(OTHER_CHANNEL, { unreadCount: 7 }),
    ];
    routeChannels(channels);
    primeChannels(queryClient, channels);
    renderHook(() => useMessagingSocket(ACTIVE_CHANNEL), { wrapper: makeWrapper(queryClient) });
    await waitFor(() => expect(ioSpy).toHaveBeenCalled());
    act(() => fireSocketEvent('connect'));
    await flush();

    act(() =>
      fireSocketEvent('readReceipt', {
        channelId: ACTIVE_CHANNEL,
        userId: 'someone-else',
        messageId: 'srv-1',
        readAt: '2026-09-16T10:40:00Z',
      }),
    );
    expect(channelsOf(queryClient)[0]?.unreadCount).toBe(4); // untouched

    act(() =>
      fireSocketEvent('readReceipt', {
        channelId: ACTIVE_CHANNEL,
        userId: TEST_USER_ID,
        messageId: 'srv-1',
        readAt: '2026-09-16T10:40:00Z',
      }),
    );
    expect(channelsOf(queryClient)[0]?.unreadCount).toBe(0);
    expect(channelsOf(queryClient)[1]?.unreadCount).toBe(7);
  });
});

describe('useMessagingSocket — recovery/structural events keep invalidation', () => {
  it('messageSyncHint invalidates the hinted thread + channels (MSG-HIGH-063 recovery path)', async () => {
    const queryClient = newQueryClient();
    routeChannels([makeChannel(ACTIVE_CHANNEL)]);
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    renderHook(() => useMessagingSocket(ACTIVE_CHANNEL), { wrapper: makeWrapper(queryClient) });
    await waitFor(() => expect(ioSpy).toHaveBeenCalled());
    invalidateSpy.mockClear();

    act(() => fireSocketEvent('messageSyncHint', { channelId: ACTIVE_CHANNEL }));

    const invalidatedKeys = invalidateSpy.mock.calls.map(([arg]) => arg?.queryKey);
    expect(invalidatedKeys).toContainEqual(
      createTenantInvalidationKey(TEST_TENANT_ID, 'messaging', 'messages', ACTIVE_CHANNEL),
    );
    expect(invalidatedKeys).toContainEqual(
      createTenantInvalidationKey(TEST_TENANT_ID, 'messaging', 'channels'),
    );
  });

  it('channelEvent invalidates the channel list (structural convergence)', async () => {
    const queryClient = newQueryClient();
    routeChannels([makeChannel(ACTIVE_CHANNEL)]);
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    renderHook(() => useMessagingSocket(ACTIVE_CHANNEL), { wrapper: makeWrapper(queryClient) });
    await waitFor(() => expect(ioSpy).toHaveBeenCalled());
    invalidateSpy.mockClear();

    act(() =>
      fireSocketEvent('channelEvent', { channelId: ACTIVE_CHANNEL, eventType: 'MEMBER_ADDED' }),
    );

    expect(invalidateSpy.mock.calls.map(([arg]) => arg?.queryKey)).toContainEqual(
      createTenantInvalidationKey(TEST_TENANT_ID, 'messaging', 'channels'),
    );
  });

  it('channelMemberRemoved (own user) removes the thread cache and refreshes the list', async () => {
    const queryClient = newQueryClient();
    routeChannels([makeChannel(ACTIVE_CHANNEL), makeChannel(OTHER_CHANNEL)]);
    primeChannels(queryClient, [makeChannel(ACTIVE_CHANNEL), makeChannel(OTHER_CHANNEL)]);
    primeThread(queryClient, ACTIVE_CHANNEL, [makeMessage('srv-0', '2026-09-16T10:00:00Z')]);
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    renderHook(() => useMessagingSocket(ACTIVE_CHANNEL), { wrapper: makeWrapper(queryClient) });
    await waitFor(() => expect(ioSpy).toHaveBeenCalled());
    act(() => fireSocketEvent('connect'));
    await flush();
    invalidateSpy.mockClear();

    act(() =>
      fireSocketEvent('channelMemberRemoved', {
        tenantId: TEST_TENANT_ID,
        channelId: ACTIVE_CHANNEL,
        userId: TEST_USER_ID,
        timestamp: '2026-09-16T10:45:00Z',
      }),
    );

    expect(queryClient.getQueryData(messagesKey(ACTIVE_CHANNEL))).toBeUndefined();
    expect(invalidateSpy.mock.calls.map(([arg]) => arg?.queryKey)).toContainEqual(
      createTenantInvalidationKey(TEST_TENANT_ID, 'messaging', 'channels'),
    );
  });

  it('channelMemberRemoved for ANOTHER user is ignored', async () => {
    const queryClient = newQueryClient();
    routeChannels([makeChannel(ACTIVE_CHANNEL)]);
    primeThread(queryClient, ACTIVE_CHANNEL, [makeMessage('srv-0', '2026-09-16T10:00:00Z')]);
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    renderHook(() => useMessagingSocket(ACTIVE_CHANNEL), { wrapper: makeWrapper(queryClient) });
    await waitFor(() => expect(ioSpy).toHaveBeenCalled());
    invalidateSpy.mockClear();

    act(() =>
      fireSocketEvent('channelMemberRemoved', {
        tenantId: TEST_TENANT_ID,
        channelId: ACTIVE_CHANNEL,
        userId: 'someone-else',
        timestamp: '2026-09-16T10:45:00Z',
      }),
    );

    expect(queryClient.getQueryData(messagesKey(ACTIVE_CHANNEL))).toBeDefined();
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('reconnect catch-up: connect invalidates the active thread + channels', async () => {
    const queryClient = newQueryClient();
    routeChannels([makeChannel(ACTIVE_CHANNEL)]);
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    renderHook(() => useMessagingSocket(ACTIVE_CHANNEL), { wrapper: makeWrapper(queryClient) });
    await waitFor(() => expect(ioSpy).toHaveBeenCalled());
    act(() => fireSocketEvent('connect'));
    await flush();
    invalidateSpy.mockClear();

    // A reconnect after a gap: same catch-up invalidation.
    act(() => fireSocketEvent('disconnect'));
    act(() => fireSocketEvent('connect'));

    const invalidatedKeys = invalidateSpy.mock.calls.map(([arg]) => arg?.queryKey);
    expect(invalidatedKeys).toContainEqual(
      createTenantInvalidationKey(TEST_TENANT_ID, 'messaging', 'messages', ACTIVE_CHANNEL),
    );
    expect(invalidatedKeys).toContainEqual(
      createTenantInvalidationKey(TEST_TENANT_ID, 'messaging', 'channels'),
    );
  });
});

describe('useMessagingSocket — reAuth + conditional reconnect (FAZ 3.1)', () => {
  it('reAuth: refreshAuth runs, socket.auth is updated, reAuthResponse carries the FRESH token', async () => {
    const queryClient = newQueryClient();
    routeChannels([makeChannel(ACTIVE_CHANNEL)]);
    getAccessTokenMock.mockReturnValue('fresh-jwt');
    renderHook(() => useMessagingSocket(ACTIVE_CHANNEL), { wrapper: makeWrapper(queryClient) });
    await waitFor(() => expect(ioSpy).toHaveBeenCalled());
    act(() => fireSocketEvent('connect'));

    act(() => fireSocketEvent('reAuth', { message: 'Token refresh required', timestamp: 't' }));
    await flush();

    expect(refreshAuthMock).toHaveBeenCalled();
    expect(getMockSocket().auth).toEqual({ token: 'fresh-jwt' });
    expect(socketEmitSpy).toHaveBeenCalledWith('reAuthResponse', { token: 'fresh-jwt' });
  });

  it('connect_error 401 STOPS the reconnect loop and runs session recovery (no probe storm)', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const queryClient = newQueryClient();
    routeChannels([]);
    getAccessTokenMock.mockReturnValue(null); // refresh yields no token → stay down
    const { result } = renderHook(() => useMessagingSocket(ACTIVE_CHANNEL), {
      wrapper: makeWrapper(queryClient),
    });
    await vi.advanceTimersByTimeAsync(0);
    act(() => fireSocketEvent('connect'));

    act(() => fireSocketEvent('connect_error', new Error('handshake unauthorized 401')));
    expect(result.current.isConnected).toBe(false);

    await vi.advanceTimersByTimeAsync(120_000); // way past the whole ladder
    expect(refreshAuthMock).toHaveBeenCalled(); // recovery attempted once
    expect(socketConnectSpy).not.toHaveBeenCalled(); // loop STOPPED
    expect(fetchMock).not.toHaveBeenCalled(); // no health probes either
  });

  it('session recovery with a FRESH token reconnects through the health gate', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const queryClient = newQueryClient();
    routeChannels([]);
    getAccessTokenMock.mockReturnValue('fresh-jwt');
    renderHook(() => useMessagingSocket(ACTIVE_CHANNEL), { wrapper: makeWrapper(queryClient) });
    await vi.advanceTimersByTimeAsync(0);

    act(() => fireSocketEvent('connect_error', new Error('invalid token 401')));
    await vi.advanceTimersByTimeAsync(1000);

    expect(refreshAuthMock).toHaveBeenCalled();
    expect(socketConnectSpy).toHaveBeenCalled(); // reconnected with the fresh token
    expect(getMockSocket().auth).toEqual({ token: 'fresh-jwt' });
  });

  it('disconnect schedules a jittered, /health/live-GATED reconnect (unhealthy → keep waiting)', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => new Response('gateway down', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const queryClient = newQueryClient();
    routeChannels([]);
    const { result } = renderHook(() => useMessagingSocket(ACTIVE_CHANNEL), {
      wrapper: makeWrapper(queryClient),
    });
    await vi.advanceTimersByTimeAsync(0);
    act(() => fireSocketEvent('connect'));
    expect(result.current.isConnected).toBe(true);

    act(() => fireSocketEvent('disconnect', 'transport close'));
    expect(result.current.isConnected).toBe(false);

    // One ladder step (≤1s) → probe → unhealthy → NO connect; the probe keeps
    // waiting on its own cadence without burning attempts.
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(socketConnectSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMock).toHaveBeenCalledTimes(2); // probe cadence, still gated
    expect(socketConnectSpy).not.toHaveBeenCalled();
  });

  it('reconnect proceeds once /health/live answers 200', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const queryClient = newQueryClient();
    routeChannels([]);
    renderHook(() => useMessagingSocket(ACTIVE_CHANNEL), { wrapper: makeWrapper(queryClient) });
    await vi.advanceTimersByTimeAsync(0);

    act(() => fireSocketEvent('disconnect', 'transport close'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(socketConnectSpy).toHaveBeenCalledTimes(1);
  });

  it('the retry budget is bounded: 20 failed attempts, then silence until visibility revives it', async () => {
    vi.useFakeTimers();
    // Healthy gateway, but every connect attempt fails again (connect_error).
    const fetchMock = vi.fn(() => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const queryClient = newQueryClient();
    routeChannels([]);
    renderHook(() => useMessagingSocket(ACTIVE_CHANNEL), {
      wrapper: makeWrapper(queryClient),
    });
    await vi.advanceTimersByTimeAsync(0);
    act(() => fireSocketEvent('connect'));

    act(() => fireSocketEvent('disconnect', 'transport close'));
    let connectErrors = 0;
    for (let i = 0; i < 40; i += 1) {
      await vi.advanceTimersByTimeAsync(35_000); // past the cap for every attempt
      if (
        getMockSocket().connected === false &&
        socketConnectSpy.mock.calls.length > connectErrors
      ) {
        connectErrors = socketConnectSpy.mock.calls.length;
        act(() => fireSocketEvent('connect_error', new Error('xhr poll error')));
      }
    }
    expect(socketConnectSpy.mock.calls.length).toBeLessThanOrEqual(20);

    // Visibility revive: user returns → 2s debounce → fresh budget reconnect.
    const before = socketConnectSpy.mock.calls.length;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await vi.advanceTimersByTimeAsync(2200);
    expect(socketConnectSpy.mock.calls.length).toBeGreaterThan(before);
  });

  it('visibilitychange while connected does nothing', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const queryClient = newQueryClient();
    routeChannels([]);
    renderHook(() => useMessagingSocket(ACTIVE_CHANNEL), { wrapper: makeWrapper(queryClient) });
    await vi.advanceTimersByTimeAsync(0);
    act(() => fireSocketEvent('connect'));

    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(socketConnectSpy).not.toHaveBeenCalled();
  });

  it('reports isConnected=false across disconnect/connect_error', async () => {
    const queryClient = newQueryClient();
    routeChannels([]);
    const { result } = renderHook(() => useMessagingSocket(ACTIVE_CHANNEL), {
      wrapper: makeWrapper(queryClient),
    });
    await waitFor(() => expect(ioSpy).toHaveBeenCalled());

    expect(result.current.isConnected).toBe(false);
    act(() => fireSocketEvent('connect'));
    expect(result.current.isConnected).toBe(true);
    act(() => fireSocketEvent('disconnect'));
    expect(result.current.isConnected).toBe(false);
    act(() => fireSocketEvent('connect'));
    act(() => fireSocketEvent('connect_error', new Error('xhr poll error')));
    expect(result.current.isConnected).toBe(false);
  });
});
