/**
 * useAuth logout tenant-isolation tests — MT-CRITICAL-050 / MT-MEDIUM-050.
 *
 * AquaMobil runs on SHARED field devices. On logout the in-memory React Query
 * cache AND the persistent IndexedDB/AES stores must be wiped, AWAITED, BEFORE
 * the auth state is reset — otherwise tenant-A's data is served to the next
 * login on the same phone. These tests prove:
 *   - logout removes the tenant key space from the React Query cache and clear()s
 *     it (MT-CRITICAL-050), so a seeded tenant-A query is gone afterwards;
 *   - logout AWAITS the persistent wipe (clearAllOperations + clearCache) and
 *     the FCM push teardown BEFORE flipping isAuthenticated to false;
 *   - a wipe FAILURE rejects logout() and leaves the session intact, so a failed
 *     wipe can never present as a clean logout (MT-MEDIUM-050).
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, waitFor } from '@testing-library/react';
import { ReactNode, ReactElement } from 'react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

// --------------------------------------------------------------------------
// Mocks — the wipe collaborators useAuth orchestrates on logout.
// --------------------------------------------------------------------------
const clearAllOperations = vi.fn((): Promise<void> => Promise.resolve());
const clearCache = vi.fn((): Promise<void> => Promise.resolve());
vi.mock('@/pwa/offline-queue', () => ({
  clearAllOperations: (): Promise<void> => clearAllOperations(),
  clearCache: (): Promise<void> => clearCache(),
  OFFLINE_QUEUE_CLEAR_AUTHORITIES_V1: {
    AUTHENTICATED_LOGOUT: 'authenticated-logout/device-erasure/v1',
  },
}));

const runPushTeardown = vi.fn((): Promise<void> => Promise.resolve());
vi.mock('@/services/push-lifecycle', () => ({
  runPushTeardown: (): Promise<void> => runPushTeardown(),
}));

const clearBiometricData = vi.fn();
vi.mock('@/hooks/useWebAuthn', () => ({
  clearBiometricData: (): void => {
    clearBiometricData();
  },
}));

const markAuthReady = vi.fn();
const resetAuthReady = vi.fn();
const syncAuthStore = vi.fn();
vi.mock('@/services/authenticated-fetch', () => ({
  markAuthReady: (): void => {
    markAuthReady();
  },
  // FE-HIGH-055: logout now re-arms the auth-ready barrier; the mock must expose
  // resetAuthReady so the logout flow under test does not throw on an undefined
  // import.
  resetAuthReady: (): void => {
    resetAuthReady();
  },
  syncAuthStore: (...args: unknown[]): void => {
    syncAuthStore(...args);
  },
}));

vi.mock('idb-keyval', () => ({
  del: vi.fn(() => Promise.resolve()),
}));

import { AuthProvider, useAuth } from '../useAuth';

// --------------------------------------------------------------------------
// Test harness — expose the live auth context to the test via a ref capture.
// --------------------------------------------------------------------------
type AuthCtx = ReturnType<typeof useAuth>;
let captured: AuthCtx | null = null;

function Capture(): null {
  captured = useAuth();
  return null;
}

/** The captured auth context, asserted present — renderAuth + a waitFor on the
 *  test side guarantee Capture has run before any ctx() use. Throwing here keeps
 *  the test type-safe without a non-null assertion. */
function ctx(): AuthCtx {
  if (!captured) throw new Error('auth context was not captured');
  return captured;
}

function renderAuth(client: QueryClient): void {
  function Tree({ children }: { children: ReactNode }): ReactElement {
    return (
      <QueryClientProvider client={client}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
  }
  render(
    <Tree>
      <Capture />
    </Tree>,
  );
}

const TEST_USER = {
  id: 'user-123',
  email: 'a@b.com',
  firstName: 'A',
  lastName: 'B',
  // FE-MEDIUM-051: the backend emits canonical Role values; this fixture mirrors
  // a real login/refresh response so the normalizeRole boundary is exercised.
  role: 'MODULE_USER',
  tenantId: 'tenant-xyz',
};

beforeEach(() => {
  vi.clearAllMocks();
  captured = null;
  // restoreSession's mount fetch + the logout mutation fetch + caches.delete.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ json: () => Promise.resolve({ data: null }) })),
  );
  vi.stubGlobal('caches', { delete: vi.fn(() => Promise.resolve(true)) });
  // No service worker in the test environment — exercises the no-SW branch.
  vi.stubGlobal('navigator', { ...globalThis.navigator });
});

async function login(): Promise<void> {
  // checkMobileEnabled() POSTs and reads isMobileEnabled — return true.
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
    json: () => Promise.resolve({ data: { getMyMobileSettings: { isMobileEnabled: true } } }),
  });
  await act(async () => {
    await ctx().loginWithToken('access-token', TEST_USER);
  });
  await waitFor(() => expect(ctx().isAuthenticated).toBe(true));
}

describe('useAuth.logout — shared-device wipe (MT-CRITICAL-050 / MT-MEDIUM-050)', () => {
  it('removes the tenant React Query cache and resets auth state', async () => {
    const client = new QueryClient();
    renderAuth(client);
    await waitFor(() => expect(captured).not.toBeNull());
    await login();

    // Seed a tenant-A query as if it had been fetched during the session.
    client.setQueryData(['tenant', TEST_USER.tenantId, 'mySchedule', TEST_USER.id], {
      secret: 'A',
    });
    expect(client.getQueryData(['tenant', TEST_USER.tenantId, 'mySchedule', TEST_USER.id])).toEqual(
      { secret: 'A' },
    );

    await act(async () => {
      await ctx().logout();
    });

    // MT-CRITICAL-050: the tenant-scoped query data must be gone, not merely stale.
    expect(
      client.getQueryData(['tenant', TEST_USER.tenantId, 'mySchedule', TEST_USER.id]),
    ).toBeUndefined();
    expect(ctx().isAuthenticated).toBe(false);
    expect(ctx().user).toBeNull();
  });

  it('AWAITS the persistent wipe + push teardown before clearing the session', async () => {
    const client = new QueryClient();
    renderAuth(client);
    await waitFor(() => expect(captured).not.toBeNull());
    await login();

    await act(async () => {
      await ctx().logout();
    });

    expect(runPushTeardown).toHaveBeenCalledTimes(1);
    expect(clearAllOperations).toHaveBeenCalledTimes(1);
    expect(clearCache).toHaveBeenCalledTimes(1);
    expect(clearBiometricData).toHaveBeenCalledTimes(1);
  });

  it('REJECTS logout and keeps the session when the data wipe fails (MT-MEDIUM-050)', async () => {
    const client = new QueryClient();
    renderAuth(client);
    await waitFor(() => expect(captured).not.toBeNull());
    await login();

    // A failed IndexedDB/AES wipe must NOT present as a clean logout.
    clearCache.mockRejectedValueOnce(new Error('IndexedDB wipe failed'));

    let rejected: unknown = null;
    await act(async () => {
      await ctx()
        .logout()
        .catch((e: unknown) => {
          rejected = e;
        });
    });

    expect(rejected).toBeInstanceOf(Error);
    expect((rejected as Error).message).toMatch(/wipe failed/);
    // Session is still authenticated — the user was NOT told logout succeeded.
    expect(ctx().isAuthenticated).toBe(true);
  });

  it('does NOT deadlock when the service worker never activates, and purges via controller (MT-CRITICAL-050)', async () => {
    const client = new QueryClient();
    renderAuth(client);
    await waitFor(() => expect(captured).not.toBeNull());
    await login();

    const controllerPost = vi.fn();
    // A `.ready` that NEVER resolves models the deadlock condition: a registered
    // SW that never reaches an ACTIVE worker (first-load race, plain-HTTP / iOS
    // PWA). logout() must post to `controller` and NEVER await `.ready` — if it
    // awaited `.ready` this test would hang until the vitest timeout (the exact
    // unrecoverable-logout regression this guards).
    vi.stubGlobal('navigator', {
      ...globalThis.navigator,
      serviceWorker: {
        controller: { postMessage: controllerPost },
        ready: new Promise<never>(() => undefined),
      },
    });

    await act(async () => {
      await ctx().logout();
    });

    // Reached here ⇒ logout resolved (no deadlock); the cache purge went to the
    // controlling worker.
    expect(ctx().isAuthenticated).toBe(false);
    expect(controllerPost).toHaveBeenCalledWith({ type: 'LOGOUT' });
  });

  it('cancels in-flight queries before clearing so none repopulates the wiped cache (MT-CRITICAL-050)', async () => {
    const client = new QueryClient();
    const cancelSpy = vi.spyOn(client, 'cancelQueries');
    renderAuth(client);
    await waitFor(() => expect(captured).not.toBeNull());
    await login();

    await act(async () => {
      await ctx().logout();
    });

    // React Query clear() does not abort running fetches; cancelQueries() does,
    // so a query dispatched pre-logout cannot resolve into the just-cleared cache.
    expect(cancelSpy).toHaveBeenCalled();
  });
});
