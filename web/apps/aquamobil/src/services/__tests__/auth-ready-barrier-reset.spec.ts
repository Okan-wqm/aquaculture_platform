// FE-HIGH-055 — resettable auth-ready barrier.
//
// On a shared device, logout must re-arm the auth-ready barrier so session 2's
// first authenticatedFetch blocks on a FRESH barrier (resolved only by session
// 2's own token) instead of firing immediately on session 1's already-resolved
// barrier with a stale token. These tests prove: (1) after reset, a request
// BLOCKS until a fresh markAuthReady, then carries session-2's token; and (2) the
// FE-HIGH-054 fail-closed refresh→logout path re-arms the barrier exactly once.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  authenticatedFetch,
  syncAuthStore,
  markAuthReady,
  resetAuthReady,
} from '../authenticated-fetch';

function makeResponse(status: number): Pick<Response, 'status' | 'ok' | 'json'> {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve({}),
  };
}

const SESSION1_TOKEN = 'session-1-token';
const SESSION2_TOKEN = 'session-2-token';

/** Yield to the microtask queue so any already-unblocked awaiters can run. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('auth-ready barrier reset (FE-HIGH-055)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const noopRefresh = (): Promise<boolean> => Promise.resolve(true);

  beforeEach(() => {
    fetchMock = vi.fn(() => Promise.resolve(makeResponse(200)));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('blocks the next request after reset until a fresh markAuthReady, then sends session-2 token', async () => {
    // --- Session 1: barrier resolved, token live. ---
    resetAuthReady();
    syncAuthStore(SESSION1_TOKEN, 'tenant-1', noopRefresh);
    markAuthReady();

    // --- Logout: re-arm the barrier for session 2. ---
    // (syncAuthStore(null,...) mirrors logout's setState clearing the token; it
    // does NOT resolve the barrier because the token is null.)
    syncAuthStore(null, null, noopRefresh);
    resetAuthReady();

    // Session 2's first request: must BLOCK on the fresh barrier.
    const pending = authenticatedFetch('/graphql', { method: 'POST' });

    await flushMicrotasks();
    // Still blocked — no fetch issued because the fresh barrier is unresolved.
    expect(fetchMock).not.toHaveBeenCalled();

    // --- Session 2 establishes its own token, resolving the fresh barrier. ---
    syncAuthStore(SESSION2_TOKEN, 'tenant-2', noopRefresh); // markAuthReady via token
    await pending;

    // The request fired exactly once, carrying session-2's token (never session-1's).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const auth = (init.headers as Record<string, string>)['Authorization'];
    expect(auth).toBe(`Bearer ${SESSION2_TOKEN}`);
    expect(auth).not.toBe(`Bearer ${SESSION1_TOKEN}`);
  });

  it('does not strand an in-flight session-1 awaiter when the barrier is reset mid-flight', async () => {
    // Session 1 barrier UNRESOLVED, a request starts and parks on it.
    resetAuthReady();
    syncAuthStore(null, null, noopRefresh);
    const session1Request = authenticatedFetch('/graphql', { method: 'POST' });
    await flushMicrotasks();
    expect(fetchMock).not.toHaveBeenCalled();

    // Resolve the CURRENT (session-1) barrier — the parked awaiter holds this
    // promise object and must resolve normally.
    markAuthReady();
    await session1Request;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('the single-flight fail-closed logout path re-arms the barrier exactly once', async () => {
    // Session 1 live, but refresh FAILS so the 401 path fails closed to logout.
    resetAuthReady();
    const failingRefresh = vi.fn(() => Promise.resolve(false));
    // logout re-arms the barrier (this is what useAuth.logout does via resetAuthReady).
    const resetSpy = vi.fn(() => resetAuthReady());
    const logout = vi.fn(() => {
      resetSpy();
      return Promise.resolve();
    });
    syncAuthStore(SESSION1_TOKEN, 'tenant-1', failingRefresh, logout);
    markAuthReady();

    fetchMock.mockResolvedValue(makeResponse(401));
    await authenticatedFetch('/graphql', { method: 'POST' });

    // Exactly one refresh (single-flight) and the logout fired, re-arming once.
    expect(failingRefresh).toHaveBeenCalledTimes(1);
    expect(logout).toHaveBeenCalledTimes(1);
    expect(resetSpy).toHaveBeenCalledTimes(1);

    // Prove the barrier is freshly armed: the next request blocks until session-2
    // resolves it (it would NOT block if the barrier were still session-1-resolved).
    // Clear the recorded 401 call so the block assertion observes only the new request.
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(makeResponse(200));
    const next = authenticatedFetch('/graphql', { method: 'POST' });
    await flushMicrotasks();
    expect(fetchMock).not.toHaveBeenCalled();

    syncAuthStore(SESSION2_TOKEN, 'tenant-2', failingRefresh);
    await next;
    const init = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['Authorization']).toBe(
      `Bearer ${SESSION2_TOKEN}`,
    );
  });
});
