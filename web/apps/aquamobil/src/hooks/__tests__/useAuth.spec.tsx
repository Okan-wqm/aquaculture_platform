/**
 * useAuth sessionStorage token persistence — MOB-MEDIUM-025.
 *
 * The access token used to live only in React state, so every hard navigation
 * (page refresh, direct URL entry — the water-quality / storage / sync E2E
 * failures) bounced an authenticated field worker back to the login screen.
 * These tests prove the persistence contract end to end, through the REAL
 * authenticated-fetch module (so syncAuthStore's persist funnel is the code
 * under test, not a mock):
 *   - login (password path AND pre-obtained token path) writes the token to
 *     sessionStorage under the single storage key;
 *   - a remount with a persisted, identity-decodable JWT restores the session
 *     immediately — WITHOUT any server round-trip (offline-capable), and the
 *     httpOnly-cookie refresh failing afterwards leaves that session intact;
 *   - the silent-refresh upgrade path ROTATES the persisted copy;
 *   - a garbage persisted token is dropped instead of restoring a session;
 *   - logout and a failed refreshAuth both wipe the persisted token
 *     (fail-closed: an unrecoverable token never survives to the next mount).
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, waitFor } from '@testing-library/react';
import { ReactNode, ReactElement } from 'react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

// --------------------------------------------------------------------------
// Mocks — only the wipe collaborators. authenticated-fetch is deliberately NOT
// mocked: its syncAuthStore persist funnel is part of the behavior under test.
// --------------------------------------------------------------------------
const clearAllOperations = vi.fn((): Promise<void> => Promise.resolve());
const clearCache = vi.fn((): Promise<void> => Promise.resolve());
vi.mock('@/pwa/offline-queue', () => ({
  clearAllOperations: (): Promise<void> => clearAllOperations(),
  clearCache: (): Promise<void> => clearCache(),
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

vi.mock('idb-keyval', () => ({
  del: vi.fn(() => Promise.resolve()),
}));

import { AuthProvider, useAuth } from '../useAuth';

const STORAGE_KEY = 'aquamobil_access_token';

// --------------------------------------------------------------------------
// JWT builder — the shape the auth service actually signs (base64url, three
// segments; sub + role are the claims the restore fails closed on).
// --------------------------------------------------------------------------
function b64url(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function makeJwt(payload: Record<string, unknown>): string {
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.signature`;
}

const TOKEN = makeJwt({
  sub: 'user-123',
  email: 'field@worker.no',
  role: 'MODULE_USER',
  tenantId: 'tenant-xyz',
});

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
  email: 'field@worker.no',
  firstName: 'Field',
  lastName: 'Worker',
  role: 'MODULE_USER',
  tenantId: 'tenant-xyz',
};

/** GraphQL body for a failed/absent silent refresh — the phase-2 no-op. */
const NO_REFRESH = { json: () => Promise.resolve({ data: null }) };

beforeEach(() => {
  vi.clearAllMocks();
  captured = null;
  sessionStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(NO_REFRESH)),
  );
  vi.stubGlobal('caches', { delete: vi.fn(() => Promise.resolve(true)) });
  vi.stubGlobal('navigator', { ...globalThis.navigator });
});

describe('useAuth — sessionStorage token persistence (MOB-MEDIUM-025)', () => {
  it('password login persists the access token to sessionStorage', async () => {
    const client = new QueryClient();
    renderAuth(client);
    await waitFor(() => expect(captured).not.toBeNull());

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      json: () =>
        Promise.resolve({
          data: {
            login: { accessToken: 'tok-from-password', user: TEST_USER },
          },
        }),
    });
    await act(async () => {
      await ctx().login('field@worker.no', 'secret');
    });

    await waitFor(() => expect(ctx().isAuthenticated).toBe(true));
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe('tok-from-password');
  });

  it('loginWithToken persists the access token to sessionStorage', async () => {
    const client = new QueryClient();
    renderAuth(client);
    await waitFor(() => expect(captured).not.toBeNull());

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      json: () => Promise.resolve({ data: { getMyMobileSettings: { isMobileEnabled: true } } }),
    });
    await act(async () => {
      await ctx().loginWithToken('tok-from-webauthn', TEST_USER);
    });

    await waitFor(() => expect(ctx().isAuthenticated).toBe(true));
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe('tok-from-webauthn');
  });

  it('a remount with a persisted JWT restores the session WITHOUT a server round-trip', async () => {
    // Hard-navigation simulation: the token was persisted by the PREVIOUS
    // render of this tab; the app mounts fresh. The refresh endpoint yields
    // NOTHING (default fetch mock) — the restore must not depend on it.
    sessionStorage.setItem(STORAGE_KEY, TOKEN);

    const client = new QueryClient();
    renderAuth(client);

    await waitFor(() => expect(ctx().isAuthenticated).toBe(true));
    expect(ctx().accessToken).toBe(TOKEN);
    expect(ctx().user?.id).toBe('user-123');
    expect(ctx().user?.tenantId).toBe('tenant-xyz');
    expect(ctx().user?.role).toBe('MODULE_USER');
    expect(ctx().tenantId).toBe('tenant-xyz');
    // Loading resolved — the login form is skipped, protected routing proceeds.
    await waitFor(() => expect(ctx().isLoading).toBe(false));
    // The phase-2 refresh failing left the restored session intact.
    expect(ctx().isAuthenticated).toBe(true);
  });

  it('a persisted JWT without an email claim still restores, with the sub as name', async () => {
    sessionStorage.setItem(
      STORAGE_KEY,
      makeJwt({ sub: 'user-9', role: 'TENANT_ADMIN', tenantId: null }),
    );

    const client = new QueryClient();
    renderAuth(client);

    await waitFor(() => expect(ctx().isAuthenticated).toBe(true));
    expect(ctx().user?.id).toBe('user-9');
    expect(ctx().user?.name).toBe('user-9');
    expect(ctx().user?.email).toBe('');
    // Rol KENDİ claim'inden gelir (fail-closed MODULE_USER değil) — bu pin,
    // identity decode'un role alanını döndürmeyi unutmasını yakalar.
    expect(ctx().user?.role).toBe('TENANT_ADMIN');
  });

  it('drops a garbage persisted token instead of restoring a session', async () => {
    sessionStorage.setItem(STORAGE_KEY, 'not-a-jwt');

    const client = new QueryClient();
    renderAuth(client);

    await waitFor(() => expect(ctx().isLoading).toBe(false));
    expect(ctx().isAuthenticated).toBe(false);
    expect(ctx().accessToken).toBeNull();
    // Fail-closed hygiene: the garbage value is removed, not left for the next mount.
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('the silent-refresh upgrade ROTATES the persisted token', async () => {
    // The httpOnly-cookie refresh succeeds from the very start: phase 1
    // restores synchronously from the persisted token, then the phase-2
    // refresh upgrades both the in-memory token AND the persisted copy.
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      json: () =>
        Promise.resolve({
          data: {
            refreshToken: { accessToken: 'tok-fresh', user: TEST_USER },
          },
        }),
    });
    sessionStorage.setItem(STORAGE_KEY, TOKEN);

    const client = new QueryClient();
    renderAuth(client);

    await waitFor(() => expect(ctx().accessToken).toBe('tok-fresh'));
    await waitFor(() => expect(sessionStorage.getItem(STORAGE_KEY)).toBe('tok-fresh'));
    // The server's full profile replaces the phase-1 identity stub.
    expect(ctx().user?.name).toBe('Field Worker');
  });

  it('logout wipes the persisted token along with the session', async () => {
    const client = new QueryClient();
    renderAuth(client);
    await waitFor(() => expect(captured).not.toBeNull());

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      json: () => Promise.resolve({ data: { getMyMobileSettings: { isMobileEnabled: true } } }),
    });
    await act(async () => {
      await ctx().loginWithToken('tok-logout-me', TEST_USER);
    });
    await waitFor(() => expect(ctx().isAuthenticated).toBe(true));
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe('tok-logout-me');

    await act(async () => {
      await ctx().logout();
    });

    expect(ctx().isAuthenticated).toBe(false);
    // MOB-MEDIUM-025: the next hard navigation on this shared device must land
    // on the login screen, not restore the prior user's session.
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('a FAILED refreshAuth wipes the persisted token (fail-closed token expiry)', async () => {
    const client = new QueryClient();
    renderAuth(client);
    await waitFor(() => expect(captured).not.toBeNull());

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      json: () => Promise.resolve({ data: { getMyMobileSettings: { isMobileEnabled: true } } }),
    });
    await act(async () => {
      await ctx().loginWithToken('tok-expiring', TEST_USER);
    });
    await waitFor(() => expect(ctx().isAuthenticated).toBe(true));

    // Token expiry: the silent refresh now answers "no session" — the same
    // outcome the 401 → single-flight refresh → fail-closed logout lane hits.
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(NO_REFRESH);
    await act(async () => {
      await ctx().refreshAuth();
    });

    await waitFor(() => expect(ctx().isAuthenticated).toBe(false));
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
