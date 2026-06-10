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
