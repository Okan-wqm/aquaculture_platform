/**
 * useMessageSocket joinChannel ack consumption (MSG-HIGH-065).
 *
 * joinChannel was fire-and-forget: the gateway returns {success:false} when a
 * membership-verify times out (NATS blip) and does not add the socket to the
 * channel room, but the client discarded the ack and pretended it was joined —
 * receiving zero live events with no error. The client now consumes the ack: a
 * confirmed join is a no-op; an unconfirmed one is retried with bounded backoff
 * and then abandoned. These tests drive the join path with a controllable ack.
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

type Handler = (...args: unknown[]) => void;
const handlers = new Map<string, Handler>();

// Controllable ack: the emit mock invokes the last-arg callback with `ackValue`.
let ackValue: { success?: boolean; reason?: string } | undefined;
const emitSpy = vi.fn((event: string, ...args: unknown[]) => {
  const cb = args[args.length - 1];
  if (event === 'joinChannel' && typeof cb === 'function') {
    (cb as (ack: unknown) => void)(ackValue);
  }
});

const fakeSocket = {
  connected: true,
  connect: vi.fn(),
  disconnect: vi.fn(),
  on: (event: string, handler: Handler) => handlers.set(event, handler),
  off: vi.fn(),
  emit: emitSpy,
  auth: {} as Record<string, unknown>,
};
vi.mock('socket.io-client', () => ({ io: vi.fn(() => fakeSocket) }));

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
  const actual =
    await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query');
  return {
    ...actual,
    useQueryClient: () => ({
      setQueryData: vi.fn(),
      invalidateQueries: vi.fn(),
      removeQueries: vi.fn(),
      getQueryData: vi.fn(),
    }),
  };
});

vi.mock('@/services/authenticated-fetch', () => ({
  graphqlRequest: vi.fn(),
  authenticatedFetch: vi.fn(),
  syncAuthStore: vi.fn(),
}));

import { useMessageSocket } from '../useMessageSocket';

function joinCalls(): unknown[][] {
  return emitSpy.mock.calls.filter((c) => c[0] === 'joinChannel');
}

describe('useMessageSocket — joinChannel ack consumption (MSG-HIGH-065)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
    fakeSocket.connected = true;
    ackValue = { success: true };
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('emits joinChannel WITH an ack callback (not fire-and-forget)', async () => {
    const { result } = renderHook(() => useMessageSocket());
    await waitFor(() => expect(handlers.get('connect')).toBeDefined());

    act(() => result.current.joinChannel('chan-7'));

    const calls = joinCalls();
    expect(calls).toHaveLength(1);
    // last arg is the ack callback
    expect(typeof calls[0][calls[0].length - 1]).toBe('function');
  });

  it('does NOT retry when the join is ack-confirmed', async () => {
    ackValue = { success: true };
    const { result } = renderHook(() => useMessageSocket());
    await waitFor(() => expect(handlers.get('connect')).toBeDefined());

    vi.useFakeTimers();
    act(() => result.current.joinChannel('chan-7'));
    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    expect(joinCalls()).toHaveLength(1); // no retry
  });

  it('retries with bounded backoff then abandons an unconfirmed join', async () => {
    ackValue = { success: false, reason: 'Not a member of this channel' };
    const { result } = renderHook(() => useMessageSocket());
    await waitFor(() => expect(handlers.get('connect')).toBeDefined());

    vi.useFakeTimers();
    act(() => result.current.joinChannel('chan-7'));
    // Initial attempt fired synchronously.
    expect(joinCalls()).toHaveLength(1);

    // Drain the bounded retry schedule (500 + 1000 + 2000 ms).
    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    // 1 initial + JOIN_ACK_MAX_RETRIES(3) = 4 total, then it stops (bounded).
    expect(joinCalls()).toHaveLength(4);
  });
});
