/**
 * The app's offline cache scope follows the signed token (MOB-MEDIUM-031, PKG-42).
 *
 * useOfflineCacheScope derives tenant + user + grants from the current access token, so every
 * cached read is keyed by the grants the server last signed. useRetainOfflineCacheScope keeps
 * only that scope on the device: when a token arrives whose moduleAccess differs — a grant
 * revoked or added — every entry written under the old grants is purged, and a token re-minted
 * with the same grants purges nothing.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useOfflineCacheScope, useRetainOfflineCacheScope } from '../useOfflineCacheScope';

const h = vi.hoisted(() => ({
  accessToken: null as string | null,
  retainOnlyCacheScope: vi.fn<(scope: { keyPrefix: string }) => Promise<void>>(() =>
    Promise.resolve(),
  ),
}));

vi.mock('../useAuth', () => ({
  useAuth: () => ({ accessToken: h.accessToken, tenantId: 'tenant-1' }),
}));

vi.mock('@/pwa/offline-cache', () => ({
  retainOnlyCacheScope: (scope: { keyPrefix: string }) => h.retainOnlyCacheScope(scope),
}));

function tokenWith(claims: unknown): string {
  const payload = btoa(JSON.stringify(claims))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `eyJhbGciOiJSUzI1NiJ9.${payload}.signature`;
}

const FARM_USER = tokenWith({
  sub: 'user-1',
  tenantId: 'tenant-1',
  moduleAccess: { farm: 'MODULE_USER' },
  iat: 1,
});
const FARM_USER_REMINTED = tokenWith({
  sub: 'user-1',
  tenantId: 'tenant-1',
  moduleAccess: { farm: 'MODULE_USER' },
  iat: 2,
});
const FARM_REVOKED = tokenWith({ sub: 'user-1', tenantId: 'tenant-1', moduleAccess: {}, iat: 3 });

describe('useOfflineCacheScope', () => {
  beforeEach(() => {
    h.retainOnlyCacheScope.mockClear();
  });

  it('has no scope, so nothing is cached, before a token arrives', () => {
    h.accessToken = null;
    const { result } = renderHook(() => useOfflineCacheScope());
    expect(result.current).toBeNull();
  });

  it('derives the scope of the signed token', () => {
    h.accessToken = FARM_USER;
    const { result } = renderHook(() => useOfflineCacheScope());
    expect(result.current?.tenantId).toBe('tenant-1');
    expect(result.current?.userId).toBe('user-1');
  });
});

describe('useRetainOfflineCacheScope', () => {
  beforeEach(() => {
    h.retainOnlyCacheScope.mockClear();
  });

  it('keeps only the current scope once the session has a token', async () => {
    h.accessToken = FARM_USER;
    renderHook(() => useRetainOfflineCacheScope());
    await waitFor(() => expect(h.retainOnlyCacheScope).toHaveBeenCalledTimes(1));
  });

  it('purges the old grants’ entries when a token with other grants arrives, and not on a re-mint', async () => {
    h.accessToken = FARM_USER;
    const { rerender } = renderHook(() => useRetainOfflineCacheScope());
    await waitFor(() => expect(h.retainOnlyCacheScope).toHaveBeenCalledTimes(1));
    const first = h.retainOnlyCacheScope.mock.calls[0]?.[0];

    h.accessToken = FARM_USER_REMINTED;
    rerender();
    expect(h.retainOnlyCacheScope).toHaveBeenCalledTimes(1);

    h.accessToken = FARM_REVOKED;
    rerender();
    await waitFor(() => expect(h.retainOnlyCacheScope).toHaveBeenCalledTimes(2));
    expect(h.retainOnlyCacheScope.mock.calls[1]?.[0].keyPrefix).not.toBe(first?.keyPrefix);
  });

  it('does nothing without a scope (the logout wipe owns that moment)', () => {
    h.accessToken = null;
    renderHook(() => useRetainOfflineCacheScope());
    expect(h.retainOnlyCacheScope).not.toHaveBeenCalled();
  });
});
