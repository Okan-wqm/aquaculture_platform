// X-Tenant-Id SSoT (2026-09-17 field finding): boot-time queries reached the
// subgraphs with no tenant ("Tenant ID is required") because the header was read
// from the auth store's tenantId copy, which can lag the token or arrive null.
// The header is now decided in one place from the signed token's tenantId claim,
// with the stored id only filling in for a token that carries no claim — on the
// first request AND on the 401 retry.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  authenticatedFetch,
  markAuthReady,
  resetAuthReady,
  syncAuthStore,
} from '../authenticated-fetch';

function tokenWith(claims: Record<string, unknown>): string {
  const payload = btoa(JSON.stringify(claims))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `eyJhbGciOiJSUzI1NiJ9.${payload}.signature`;
}

function makeResponse(status: number): Pick<Response, 'status' | 'ok' | 'json'> {
  return { status, ok: status >= 200 && status < 300, json: () => Promise.resolve({}) };
}

/**
 * X-Tenant-Id values in send order, captured AT CALL TIME: the interceptor
 * reuses one headers object for its 401 retry, so reading the recorded call
 * arguments afterwards would show the retry's value for both calls.
 */
let sentTenantHeaders: Array<string | undefined>;

function recordingFetch(
  statuses: readonly number[],
): (url: string, init?: RequestInit) => Promise<Pick<Response, 'status' | 'ok' | 'json'>> {
  let call = 0;
  return (_url, init) => {
    sentTenantHeaders.push((init?.headers as Record<string, string> | undefined)?.['X-Tenant-Id']);
    const status = statuses[Math.min(call, statuses.length - 1)];
    call += 1;
    return Promise.resolve(makeResponse(status));
  };
}

describe('authenticatedFetch X-Tenant-Id comes from the token claim', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const refreshAuth = vi.fn(() => Promise.resolve(true));

  beforeEach(() => {
    resetAuthReady();
    sentTenantHeaders = [];
    fetchMock = vi.fn(recordingFetch([200]));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sends the claim while the stored tenant id has not arrived yet', async () => {
    syncAuthStore(tokenWith({ tenantId: 'tenant-claim' }), null, refreshAuth);
    markAuthReady();

    await authenticatedFetch('/graphql', { method: 'POST' });

    expect(sentTenantHeaders).toEqual(['tenant-claim']);
  });

  it('sends the claim when the stored copy disagrees with the token', async () => {
    syncAuthStore(tokenWith({ tenantId: 'tenant-claim' }), 'tenant-stale', refreshAuth);
    markAuthReady();

    await authenticatedFetch('/graphql', { method: 'POST' });

    expect(sentTenantHeaders).toEqual(['tenant-claim']);
  });

  it('falls back to the stored id for a token without a tenant claim', async () => {
    syncAuthStore('opaque-token', 'tenant-stored', refreshAuth);
    markAuthReady();

    await authenticatedFetch('/graphql', { method: 'POST' });

    expect(sentTenantHeaders).toEqual(['tenant-stored']);
  });

  it('sends no tenant header when neither the token nor the store has one', async () => {
    syncAuthStore('opaque-token', null, refreshAuth);
    markAuthReady();

    await authenticatedFetch('/graphql', { method: 'POST' });

    expect(sentTenantHeaders).toEqual([undefined]);
  });

  it('re-reads the claim from the rotated token on the 401 retry', async () => {
    const rotated = tokenWith({ tenantId: 'tenant-rotated' });
    const rotatingRefresh = vi.fn(() => {
      // The refreshed session's store copy has not caught up: only the token has.
      syncAuthStore(rotated, null, rotatingRefresh);
      return Promise.resolve(true);
    });
    syncAuthStore(tokenWith({ tenantId: 'tenant-old' }), 'tenant-old', rotatingRefresh);
    markAuthReady();
    fetchMock.mockImplementation(recordingFetch([401, 200]));

    const response = await authenticatedFetch('/graphql', { method: 'POST' });

    expect(response.status).toBe(200);
    expect(sentTenantHeaders).toEqual(['tenant-old', 'tenant-rotated']);
  });
});
