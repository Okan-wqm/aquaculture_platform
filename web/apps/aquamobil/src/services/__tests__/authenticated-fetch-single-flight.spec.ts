// FE-HIGH-054 — single-flight token refresh.
//
// When several requests 401 at once, only ONE refresh must run: N parallel
// refreshes rotate the refresh token N times and trip server-side reuse
// detection → random logouts. These tests fire 5 concurrent authenticatedFetch
// calls against a 401-then-200 backend and assert exactly one refresh, all
// retries carrying the rotated token, and that a fresh 401 after settle starts a
// new refresh (the in-flight promise is not cached past its window).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  authenticatedFetch,
  syncAuthStore,
  markAuthReady,
  resetAuthReady,
} from '../authenticated-fetch';

/** Build a minimal Response-like object the interceptor inspects (status + json). */
function makeResponse(
  status: number,
  body: unknown = {},
): Pick<Response, 'status' | 'ok' | 'json'> {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
  };
}

const OLD_TOKEN = 'old-token';
const NEW_TOKEN = 'new-token';

describe('authenticatedFetch single-flight refresh (FE-HIGH-054)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let refreshAuth: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Start each test from a fresh, resolved barrier with a registered session so
    // authenticatedFetch does not block on the readiness barrier.
    resetAuthReady();

    refreshAuth = vi.fn(() => {
      // A successful refresh rotates the in-memory token, exactly as
      // refreshAuthForInterceptor does via syncAuthStore.
      syncAuthStore(NEW_TOKEN, 'tenant-1', refreshAuth);
      return Promise.resolve(true);
    });

    // Register the session: a valid token (resolves the barrier) + the refresh fn.
    syncAuthStore(OLD_TOKEN, 'tenant-1', refreshAuth);
    markAuthReady();

    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('runs exactly ONE refresh for N concurrent 401s and retries all with the new token', async () => {
    // Every initial request 401s; every retry (carrying NEW_TOKEN) 200s.
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.['Authorization'];
      if (auth === `Bearer ${NEW_TOKEN}`) {
        return Promise.resolve(makeResponse(200, { ok: true }));
      }
      return Promise.resolve(makeResponse(401));
    });

    const results = await Promise.all(
      Array.from({ length: 5 }, () => authenticatedFetch('/graphql', { method: 'POST' })),
    );

    // THE load-bearing invariant: exactly one refresh despite 5 concurrent 401s
    // (N parallel refreshes would have rotated the token N times → reuse logout).
    expect(refreshAuth).toHaveBeenCalledTimes(1);

    // All five requests recovered to 200 — none was left on a 401.
    for (const res of results) {
      expect(res.status).toBe(200);
    }

    // Every 200 came from a request that carried the rotated token: no successful
    // request ever used the stale OLD_TOKEN.
    const successfulOnNewToken = fetchMock.mock.calls.filter(
      ([, init]) =>
        ((init as RequestInit | undefined)?.headers as Record<string, string> | undefined)?.[
          'Authorization'
        ] === `Bearer ${NEW_TOKEN}`,
    );
    expect(successfulOnNewToken.length).toBeGreaterThanOrEqual(5);
  });

  it('starts a NEW refresh on a fresh 401 after the in-flight window settles', async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.['Authorization'];
      if (auth === `Bearer ${NEW_TOKEN}`) {
        return Promise.resolve(makeResponse(200, { ok: true }));
      }
      return Promise.resolve(makeResponse(401));
    });

    await authenticatedFetch('/graphql', { method: 'POST' });
    expect(refreshAuth).toHaveBeenCalledTimes(1);

    // Re-register the OLD token so the next request 401s again, proving the
    // single-flight promise was cleared (not cached) after the first settle.
    syncAuthStore(OLD_TOKEN, 'tenant-1', refreshAuth);

    await authenticatedFetch('/graphql', { method: 'POST' });
    expect(refreshAuth).toHaveBeenCalledTimes(2);
  });

  it('fails closed via logout when the shared refresh returns false', async () => {
    const logout = vi.fn(() => Promise.resolve());
    // Refresh fails for this session.
    const failingRefresh = vi.fn(() => Promise.resolve(false));
    syncAuthStore(OLD_TOKEN, 'tenant-1', failingRefresh, logout);
    markAuthReady();

    fetchMock.mockResolvedValue(makeResponse(401));

    const results = await Promise.all(
      Array.from({ length: 3 }, () => authenticatedFetch('/graphql', { method: 'POST' })),
    );

    // One shared refresh for all three coalesced 401s.
    expect(failingRefresh).toHaveBeenCalledTimes(1);
    // Fail-closed logout fires EXACTLY ONCE across all coalesced 401s (not once per
    // caller) — a single rotation failure is a single logout() + barrier re-arm.
    expect(logout).toHaveBeenCalledTimes(1);
    for (const res of results) {
      expect(res.status).toBe(401);
    }
  });
});
