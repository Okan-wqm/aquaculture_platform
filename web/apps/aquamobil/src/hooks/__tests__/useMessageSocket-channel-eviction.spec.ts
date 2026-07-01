/**
 * useMessageSocket channel eviction + lifecycle refresh
 * (MSG-HIGH-068 membership-removal eviction, MSG-MEDIUM-062 channelEvent SSoT).
 *
 * When the current user is removed from a channel the gateway removes our socket
 * from the room AND emits `channelMemberRemoved` to our user room; the client must
 * evict that channel's caches so a kicked-while-in-room user stops seeing it and
 * it drops from the list. Channel lifecycle changes (rename / member add-remove /
 * archive) ride the gateway's `channelEvent` name (the client used to listen for a
 * `channelUpdated` name that is never emitted). These tests drive the captured
 * socket handlers directly and assert the cache eviction / invalidation.
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

type Handler = (...args: unknown[]) => void;
const handlers = new Map<string, Handler>();

const fakeSocket = {
  connected: true,
  connect: vi.fn(),
  disconnect: vi.fn(),
  on: (event: string, handler: Handler) => handlers.set(event, handler),
  off: vi.fn(),
  emit: vi.fn(),
  auth: {} as Record<string, unknown>,
};
const mockIo = vi.fn(() => fakeSocket);
vi.mock('socket.io-client', () => ({ io: mockIo }));

const mockSetQueryData = vi.fn();
const mockInvalidateQueries = vi.fn();
const mockRemoveQueries = vi.fn();
const mockGetQueryData = vi.fn<(key: unknown) => unknown>();

vi.mock('../useAuth', () => ({
  useAuth: () => ({
    accessToken: 'token-1',
    isAuthenticated: true,
    tenantId: 'tenant-1',
    user: { id: 'user-1' },
    refreshAuth: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('@tanstack/react-query', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-query')>(
    '@tanstack/react-query',
  );
  return {
    ...actual,
    useQueryClient: () => ({
      setQueryData: mockSetQueryData,
      invalidateQueries: mockInvalidateQueries,
      removeQueries: mockRemoveQueries,
      getQueryData: mockGetQueryData,
    }),
  };
});

vi.mock('@/services/authenticated-fetch', () => ({
  graphqlRequest: vi.fn(),
  authenticatedFetch: vi.fn(),
  syncAuthStore: vi.fn(),
}));

import { useMessageSocket } from '../useMessageSocket';

const CHANNEL = 'chan-7';
const MESSAGES_KEY = ['tenant', 'tenant-1', 'messaging', 'messages', 'user-1', CHANNEL];
const CHANNELS_KEY = ['tenant', 'tenant-1', 'messaging', 'channels'];
const MEMBERS_KEY = ['tenant', 'tenant-1', 'messaging', 'channelMembers', CHANNEL];

function fire(event: string, data: unknown): void {
  const handler = handlers.get(event);
  if (!handler) throw new Error(`socket handler '${event}' not registered`);
  act(() => handler(data));
}

function calledWithKey(mock: ReturnType<typeof vi.fn>, key: unknown[]): boolean {
  return mock.mock.calls.some(
    (c) => JSON.stringify((c[0] as { queryKey?: unknown })?.queryKey) === JSON.stringify(key),
  );
}

describe('useMessageSocket — channel eviction + lifecycle (MSG-HIGH-068 / MSG-MEDIUM-062)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
    mockGetQueryData.mockReturnValue(undefined);
  });
  afterEach(() => cleanup());

  it('evicts the channel caches when the current user is removed (channelMemberRemoved)', async () => {
    renderHook(() => useMessageSocket());
    await waitFor(() => expect(handlers.get('channelMemberRemoved')).toBeDefined());

    fire('channelMemberRemoved', { channelId: CHANNEL, tenantId: 'tenant-1', userId: 'user-1' });

    // Messages cache for the channel is removed under the user-scoped key.
    expect(calledWithKey(mockRemoveQueries, MESSAGES_KEY)).toBe(true);
    // Members + detail for the channel are removed (prefix keys).
    expect(calledWithKey(mockRemoveQueries, MEMBERS_KEY)).toBe(true);
    // Channel list is invalidated so the channel drops out.
    expect(calledWithKey(mockInvalidateQueries, CHANNELS_KEY)).toBe(true);
  });

  it('ignores a channelMemberRemoved without a channelId', async () => {
    renderHook(() => useMessageSocket());
    await waitFor(() => expect(handlers.get('channelMemberRemoved')).toBeDefined());

    fire('channelMemberRemoved', { tenantId: 'tenant-1', userId: 'user-1' });

    expect(mockRemoveQueries).not.toHaveBeenCalled();
  });

  it('refreshes the channel list + members on a channelEvent (lifecycle change)', async () => {
    renderHook(() => useMessageSocket());
    await waitFor(() => expect(handlers.get('channelEvent')).toBeDefined());

    fire('channelEvent', { channelId: CHANNEL, eventType: 'ChannelMemberAdded', userId: 'user-2' });

    expect(calledWithKey(mockInvalidateQueries, CHANNELS_KEY)).toBe(true);
    expect(calledWithKey(mockInvalidateQueries, MEMBERS_KEY)).toBe(true);
  });

  it('invalidates the channel messages on a messageSyncHint so a dropped live message is refetched (MSG-HIGH-063)', async () => {
    renderHook(() => useMessageSocket());
    await waitFor(() => expect(handlers.get('messageSyncHint')).toBeDefined());

    fire('messageSyncHint', { channelId: CHANNEL });

    // Messages for the channel are invalidated under the user-scoped key → refetch.
    expect(calledWithKey(mockInvalidateQueries, MESSAGES_KEY)).toBe(true);
    expect(calledWithKey(mockInvalidateQueries, CHANNELS_KEY)).toBe(true);
  });

  it('ignores a messageSyncHint without a channelId', async () => {
    renderHook(() => useMessageSocket());
    await waitFor(() => expect(handlers.get('messageSyncHint')).toBeDefined());

    mockInvalidateQueries.mockClear();
    fire('messageSyncHint', {});

    expect(mockInvalidateQueries).not.toHaveBeenCalled();
  });
});
