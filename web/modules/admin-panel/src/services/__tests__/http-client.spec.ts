import {
  getAccessToken,
  getTenantId,
  tokenLifecycle,
} from '@aquaculture/shared-ui';
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
  new Response(JSON.stringify({ success: true, data: { ok: true } }), {
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

/**
 * ADR-0014. This client retries 502/503/504 three times, and admin-api maps a
 * billing NATS timeout to 502 — so before the key existed the browser itself
 * re-submitted refunds as brand-new requests, and billing had no way to tell.
 */
describe('admin-panel apiFetch idempotency contract', () => {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

  const headersOf = (call: FetchCall): Record<string, string> => {
    const headers = call[1]?.headers;
    if (!headers || headers instanceof Headers || Array.isArray(headers)) {
      throw new Error('apiFetch must pass a plain header record to fetch');
    }
    return headers;
  };

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(getAccessToken).mockReturnValue('access-token');
    vi.mocked(getTenantId).mockReturnValue('tenant-canonical');
    vi.mocked(tokenLifecycle.waitForReady).mockResolvedValue(undefined);
  });

  it('sends one Idempotency-Key per mutation', async () => {
    fetchMock.mockResolvedValue(okResponse());

    await apiFetch('/billing/payments/p1/refund', { method: 'POST' });

    const key = getHeaderValue(headersOf(fetchMock.mock.calls[0]!), 'Idempotency-Key');
    expect(key).toBeTruthy();
  });

  it('repeats the SAME key across its own gateway retries', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(okResponse());

    await apiFetch(
      '/billing/payments/p1/refund',
      { method: 'POST' },
      { maxRetries: 2, baseDelay: 0, maxDelay: 0 },
    );

    expect(fetchMock.mock.calls).toHaveLength(2);
    const [first, second] = fetchMock.mock.calls.map((call) =>
      getHeaderValue(headersOf(call), 'Idempotency-Key'),
    );
    expect(first).toBeTruthy();
    // A key regenerated per attempt is no key at all — that is exactly what
    // X-Request-ID does, and why it could not serve as the idempotency anchor.
    expect(second).toBe(first);
    const requestIds = fetchMock.mock.calls.map((call) =>
      getHeaderValue(headersOf(call), 'X-Request-ID'),
    );
    expect(requestIds[1]).not.toBe(requestIds[0]);
  });

  it('sends no key on a read, which has nothing to make idempotent', async () => {
    fetchMock.mockResolvedValue(okResponse());

    await apiFetch('/security/events');

    expect(getHeaderValue(headersOf(fetchMock.mock.calls[0]!), 'Idempotency-Key')).toBeUndefined();
  });

  it('lets a caller supply its own key when several requests are one operation', async () => {
    fetchMock.mockResolvedValue(okResponse());

    await apiFetch('/billing/invoices', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'operator-chosen' },
    });

    expect(getHeaderValue(headersOf(fetchMock.mock.calls[0]!), 'Idempotency-Key')).toBe(
      'operator-chosen',
    );
  });
});
