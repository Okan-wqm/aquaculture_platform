import { getAccessToken, getTenantId, tokenLifecycle } from '@aquaculture/shared-ui';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { apiFetch } from '../http-client';

vi.mock('@aquaculture/shared-ui', () => ({
  getAccessToken: vi.fn(),
  getTenantId: vi.fn(),
  tokenLifecycle: {
    waitForReady: vi.fn(),
  },
  silentRefresh: vi.fn(),
  clearSession: vi.fn(),
}));

const okResponse = (): Response =>
  new Response(
    JSON.stringify({
      success: true,
      data: { ok: true },
      meta: { timestamp: '2026-08-15T00:00:00.000Z' },
    }),
    {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    },
  );

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const getHeaderValue = (headers: Record<string, string>, name: string): string | undefined =>
  Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];

type FetchCall = [input: RequestInfo | URL, init?: RequestInit];

function sentHeaderRecord(calls: FetchCall[]): Record<string, string> {
  const [, init] = calls[0] ?? [];
  const headers = init?.headers;
  if (!headers || headers instanceof Headers || Array.isArray(headers)) {
    throw new Error('apiFetch must pass a plain header record to fetch');
  }
  return headers;
}

describe('admin-panel apiFetch header security contract', () => {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(getAccessToken).mockReturnValue('access-token');
    vi.mocked(getTenantId).mockReturnValue('tenant-canonical');
    vi.mocked(tokenLifecycle.waitForReady).mockResolvedValue(undefined);
  });

  it('does not send a stale tenant header by default', async () => {
    await apiFetch('/security/events');

    const headers = sentHeaderRecord(fetchMock.mock.calls);
    expect(headers.Authorization).toBe('Bearer access-token');
    expect(headers['X-Tenant-Id']).toBeUndefined();
  });

  it('does not allow platform-scope callers to override X-Tenant-Id', async () => {
    await apiFetch('/security/events', {
      tenantScope: 'platform',
      headers: { 'X-Tenant-Id': 'evil-tenant' },
    });

    const headers = sentHeaderRecord(fetchMock.mock.calls);
    expect(headers['X-Tenant-Id']).toBeUndefined();
  });

  it('uses canonical tenant scope and blocks caller security-header overrides', async () => {
    await apiFetch('/tenant/modules', {
      tenantScope: 'tenant',
      headers: new Headers([
        ['X-Tenant-Id', 'evil-tenant'],
        ['Authorization', 'Bearer evil'],
        ['Idempotency-Key', 'idem-1'],
      ]),
    });

    const headers = sentHeaderRecord(fetchMock.mock.calls);
    expect(headers.Authorization).toBe('Bearer access-token');
    expect(headers['X-Tenant-Id']).toBe('tenant-canonical');
    expect(getHeaderValue(headers, 'Idempotency-Key')).toBe('idem-1');
  });

  it('fails closed before fetch for invalid runtime tenant scope values', async () => {
    await expect(
      apiFetch('/security/events', { tenantScope: 'invalid' as 'platform' }),
    ).rejects.toMatchObject({ code: 'INVALID_TENANT_SCOPE' });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves non-reserved caller headers from tuple arrays', async () => {
    await apiFetch('/tenant/modules', {
      headers: [['Idempotency-Key', 'idem-2']],
    });

    const headers = sentHeaderRecord(fetchMock.mock.calls);
    expect(getHeaderValue(headers, 'Idempotency-Key')).toBe('idem-2');
  });
});

describe('admin-panel apiFetch pagination contract', () => {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(getAccessToken).mockReturnValue('access-token');
    vi.mocked(getTenantId).mockReturnValue(null);
    vi.mocked(tokenLifecycle.waitForReady).mockResolvedValue(undefined);
  });

  it('decodes canonical envelope metadata into the browser projection', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        success: true,
        data: [{ id: 'tenant-1' }],
        meta: {
          total: 3,
          page: 1,
          limit: 1,
          totalPages: 3,
          hasNextPage: true,
          hasPreviousPage: false,
          timestamp: '2026-08-15T00:00:00.000Z',
        },
      }),
    );

    await expect(apiFetch('/tenants')).resolves.toEqual({
      data: [{ id: 'tenant-1' }],
      total: 3,
      page: 1,
      limit: 1,
      totalPages: 3,
      hasNextPage: true,
      hasPreviousPage: false,
    });
  });

  it('fails closed when redundant pagination metadata disagrees', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        success: true,
        data: [],
        meta: {
          total: 3,
          page: 1,
          limit: 1,
          totalPages: 99,
          hasNextPage: true,
          hasPreviousPage: false,
        },
      }),
    );

    await expect(apiFetch('/tenants')).rejects.toMatchObject({
      code: 'INVALID_PAGINATION_CONTRACT',
      status: 502,
    });
  });

  it('fails closed when canonical pagination metadata accompanies non-array data', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        success: true,
        data: { id: 'not-a-page' },
        meta: {
          total: 1,
          page: 1,
          limit: 20,
          totalPages: 1,
          hasNextPage: false,
          hasPreviousPage: false,
        },
      }),
    );

    await expect(apiFetch('/tenants')).rejects.toMatchObject({
      code: 'INVALID_PAGINATION_CONTRACT',
      status: 502,
    });
  });

  it.each([null, [], 'invalid'])('rejects malformed envelope metadata (%j)', async (meta) => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: [], meta }));

    await expect(apiFetch('/tenants')).rejects.toMatchObject({
      code: 'INVALID_API_ENVELOPE',
      status: 502,
    });
  });

  it.each([false, 'true', 1])('rejects invalid success discriminator (%j)', async (success) => {
    fetchMock.mockResolvedValue(jsonResponse({ success, data: [], meta: {} }));

    await expect(apiFetch('/tenants')).rejects.toMatchObject({
      code: 'INVALID_API_ENVELOPE',
      status: 502,
    });
  });

  it.each([
    { ok: true },
    { success: true },
    { data: [] },
  ])('rejects non-envelope successful JSON (%j)', async (body) => {
    fetchMock.mockResolvedValue(jsonResponse(body));

    await expect(apiFetch('/tenants')).rejects.toMatchObject({
      code: 'INVALID_API_ENVELOPE',
      status: 502,
    });
  });

  it('accepts raw JSON only through an explicit response contract', async () => {
    const rawHealth = { success: true, name: 'admin', state: 'closed' };
    fetchMock.mockResolvedValue(jsonResponse(rawHealth));

    await expect(
      apiFetch('/health/circuit-breakers/admin', { responseContract: 'raw-json' }),
    ).resolves.toEqual(rawHealth);
  });

  it('maps an explicit 204 response to void instead of fabricating an object', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(apiFetch<void>('/tenants/tenant-1', { method: 'DELETE' })).resolves.toBeUndefined();
  });

  it('does not retain a mutable reference to decoded page data', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        success: true,
        data: [{ id: 'tenant-1' }],
        meta: {
          total: 1,
          page: 1,
          limit: 20,
          totalPages: 1,
          hasNextPage: false,
          hasPreviousPage: false,
        },
      }),
    );

    const page = await apiFetch<{ readonly data: readonly { readonly id: string }[] }>('/tenants');
    expect(Object.isFrozen(page.data)).toBe(true);
  });
});

describe('admin-panel apiFetch transport contract', () => {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(getAccessToken).mockReturnValue('access-token');
    vi.mocked(getTenantId).mockReturnValue(null);
    vi.mocked(tokenLifecycle.waitForReady).mockResolvedValue(undefined);
  });

  it('surfaces ValidationPipe message arrays without flattening them to HTTP 400', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ message: ['page must not be less than 1', 'limit must be 100'] }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(apiFetch('/tenants')).rejects.toMatchObject({
      message: 'page must not be less than 1; limit must be 100',
      status: 400,
    });
  });

  it('rejects a successful HTML edge fallback as a typed transport failure', async () => {
    fetchMock.mockResolvedValue(
      new Response('<!doctype html><title>admin panel</title>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
    );

    await expect(apiFetch('/tenants')).rejects.toMatchObject({
      code: 'NON_JSON_RESPONSE',
      status: 502,
      details: { contentType: 'text/html' },
    });
  });

  it('rejects malformed JSON under a JSON media type with a stable error code', async () => {
    fetchMock.mockResolvedValue(
      new Response('{not-json', {
        status: 200,
        headers: { 'Content-Type': 'application/problem+json; charset=utf-8' },
      }),
    );

    await expect(apiFetch('/tenants')).rejects.toMatchObject({
      code: 'INVALID_JSON_RESPONSE',
      status: 502,
    });
  });
});
