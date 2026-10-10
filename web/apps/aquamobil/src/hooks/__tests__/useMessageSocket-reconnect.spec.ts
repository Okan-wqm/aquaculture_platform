/**
 * useMessageSocket reconnect reconciliation — Wave-6 M3.
 *
 * When the socket drops and reconnects, messages that arrived during the gap
 * are not replayed by Socket.IO. M3 closes that gap: on RECONNECT (not the
 * first connect) the hook fetches the multi-channel `allMessagesSince` delta,
 * patches the per-channel message caches, and reconciles the badges.
 *
 * These tests drive the captured Socket.IO 'connect' handler directly:
 *   - first connect  → NO delta fetch (initial queries already loaded state)
 *   - reconnect      → allMessagesSince delta + cache upsert + badge invalidation
 */

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// --------------------------------------------------------------------------
// Controllable fake Socket.IO socket — captures registered event handlers.
// --------------------------------------------------------------------------
type Handler = (...args: unknown[]) => void;
const handlers = new Map<string, Handler>();
const emitted: Array<{ event: string; args: unknown[] }> = [];

const fakeSocket = {
  connected: true,
  connect: vi.fn(),
  disconnect: vi.fn(),
  on: (event: string, handler: Handler) => handlers.set(event, handler),
  off: vi.fn(),
  emit: (event: string, ...args: unknown[]) => emitted.push({ event, args }),
  auth: {} as Record<string, unknown>,
};

const mockIo = vi.fn(() => fakeSocket);
vi.mock('socket.io-client', () => ({ io: mockIo }));

// --------------------------------------------------------------------------
// Dependency mocks
// --------------------------------------------------------------------------
const mockSetQueryData = vi.fn();
const mockInvalidateQueries = vi.fn();
const mockGetQueriesData = vi.fn<(filters: unknown) => unknown[]>();
// MSG-HIGH-064: the first-connect watermark is the newest SERVER createdAt in the
// cached channel list — this timestamp, NOT a client `new Date()`.
const SERVER_WATERMARK = '2026-06-13T11:00:00.000Z';
// Typed so the mocked graphqlRequest returns Promise<unknown> (not any) — keeps
// the mock factory + .mock.calls destructuring free of no-unsafe-* lint.
const mockGraphqlRequest = vi.fn<(...args: unknown[]) => Promise<unknown>>();

vi.mock('../useAuth', () => ({
  useAuth: () => ({
    accessToken: 'token-1',
    isAuthenticated: true,
    tenantId: 'tenant-1',
    // MSG-CRITICAL-055: the message cache key is user-scoped, so the reconcile
    // upsert must carry user.id. The assertion below pins the full key.
    user: { id: 'user-1' },
    refreshAuth: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('@tanstack/react-query', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query');
  return {
    ...actual,
    useQueryClient: () => ({
      setQueryData: mockSetQueryData,
      invalidateQueries: mockInvalidateQueries,
      getQueriesData: mockGetQueriesData,
    }),
  };
});

vi.mock('@/services/authenticated-fetch', () => ({
  graphqlRequest: (...args: unknown[]) => mockGraphqlRequest(...args),
  authenticatedFetch: vi.fn(),
  syncAuthStore: vi.fn(),
}));

// Import after mocks.
import { useMessageSocket } from '../useMessageSocket';

import { ALL_MESSAGES_SINCE } from '@/graphql/messaging-operations';

async function fireConnect(): Promise<void> {
  const connect = handlers.get('connect');
  expect(connect).toBeDefined();
  await act(async () => {
    connect?.();
    // Let the async reconcile microtasks settle.
    await Promise.resolve();
  });
}

describe('useMessageSocket — Wave-6 M3 reconnect reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
    emitted.length = 0;
    fakeSocket.connected = true;
    // Channels cache holds one channel whose newest message is SERVER_WATERMARK,
    // so the first-connect watermark is seeded from server truth (MSG-HIGH-064).
    mockGetQueriesData.mockReturnValue([
      [
        ['tenant', 'tenant-1', 'messaging', 'channels', 'user-1', 0],
        { items: [{ id: 'chan-7', lastMessage: { createdAt: SERVER_WATERMARK } }], total: 1 },
      ],
    ]);
    mockGraphqlRequest.mockResolvedValue({
      allMessagesSince: {
        messages: [
          {
            id: 'missed-1',
            channelId: 'chan-7',
            senderId: 'other-user',
            content: 'sent while you were offline',
            // S1-CODEGEN: wire contentType is the UPPERCASE GraphQL enum NAME.
            contentType: 'TEXT',
            createdAt: '2026-06-13T12:00:00.000Z',
          },
        ],
        hasMore: false,
        syncToken: null,
      },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('does NOT fetch the delta on the FIRST connect', async () => {
    renderHook(() => useMessageSocket());
    await waitFor(() => expect(handlers.get('connect')).toBeDefined());

    await fireConnect();

    expect(mockGraphqlRequest).not.toHaveBeenCalled();
  });

  it('fetches allMessagesSince and reconciles caches + badges on RECONNECT', async () => {
    renderHook(() => useMessageSocket());
    await waitFor(() => expect(handlers.get('connect')).toBeDefined());

    // First connect establishes the watermark; reconnect triggers reconcile.
    await fireConnect();
    await fireConnect();

    // Wait for the FINAL async step (badge invalidation) so the reconcile's
    // graphql fetch + cache upsert are guaranteed complete before asserting.
    await waitFor(() =>
      expect(mockInvalidateQueries).toHaveBeenCalledWith({
        queryKey: ['tenant', 'tenant-1', 'messaging', 'unreadCount'],
      }),
    );

    const [query, variables] = mockGraphqlRequest.mock.calls[0];
    expect(query).toBe(ALL_MESSAGES_SINCE);
    // MSG-HIGH-064: `since` is the SERVER-derived watermark from the channels
    // cache, not a client `new Date()` — so a skewed local clock cannot skip
    // messages whose server createdAt falls in the skew window.
    expect(variables).toMatchObject({ since: SERVER_WATERMARK, limit: 100, syncToken: null });

    // Missed message upserted into its channel's cache — under the user-scoped
    // key the reader (useMessages) actually reads (MSG-CRITICAL-055): the user.id
    // segment sits between 'messages' and the channelId.
    expect(mockSetQueryData).toHaveBeenCalledWith(
      ['tenant', 'tenant-1', 'messaging', 'messages', 'user-1', 'chan-7'],
      expect.any(Function),
    );

    // Channel-list badge also reconciled.
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ['tenant', 'tenant-1', 'messaging', 'channels'],
    });
  });

  it('skips badge invalidation when the reconnect delta is empty', async () => {
    mockGraphqlRequest.mockResolvedValue({
      allMessagesSince: { messages: [], hasMore: false, syncToken: null },
    });

    renderHook(() => useMessageSocket());
    await waitFor(() => expect(handlers.get('connect')).toBeDefined());

    await fireConnect();
    await fireConnect();

    await waitFor(() => expect(mockGraphqlRequest).toHaveBeenCalled());
    expect(mockInvalidateQueries).not.toHaveBeenCalled();
  });
});
