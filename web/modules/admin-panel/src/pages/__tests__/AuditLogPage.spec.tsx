/**
 * AuditLogPage — the first page on the admin data layer (ADMIN-HIGH-105).
 *
 * This is the pattern-setting migration, so the spec pins the four properties
 * the move is FOR, not just that the table renders:
 *
 *   1. the read goes through `useAdminQuery`, so it lands in the shell's
 *      `QueryClient` — the cache `logoutCleanup()` clears and a mutation can
 *      invalidate;
 *   2. a filter change is a DIFFERENT cache key, not an overwrite of the same
 *      one. The statistics query is the sharp case: its old key named only
 *      `tenantId`, so moving a date bound re-fetched into the same entry and
 *      the header cards kept showing the previous range's numbers;
 *   3. cancellation reaches the client. React Query aborts the signal on
 *      unmount and on every key change; before this the fetchers took no
 *      signal at all, so superseded requests ran to completion;
 *   4. the total comes from settled data. The old fetcher called
 *      `pagination.setTotal()` from inside itself, so a request that lost its
 *      race still wrote its page count into the controller.
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import AuditLogPage from '../AuditLogPage';
import { auditApi, tenantsApi } from '../../services/adminApi';
import type { AuditLog, AuditLogStats, PaginatedResult, Tenant } from '../../services/adminApi';

vi.mock('../../services/adminApi', () => ({
  auditApi: { query: vi.fn(), getStatistics: vi.fn() },
  tenantsApi: { list: vi.fn() },
  TenantTier: {
    FREE: 'FREE',
    STARTER: 'STARTER',
    PROFESSIONAL: 'PROFESSIONAL',
    ENTERPRISE: 'ENTERPRISE',
  },
  TenantStatus: { ACTIVE: 'ACTIVE', SUSPENDED: 'SUSPENDED', INACTIVE: 'INACTIVE' },
}));

const queryMock = vi.mocked(auditApi.query);
const statsMock = vi.mocked(auditApi.getStatistics);
const tenantListMock = vi.mocked(tenantsApi.list);

function auditLog(overrides: Partial<AuditLog> = {}): AuditLog {
  return {
    id: 'log-1',
    action: 'TENANT_SUSPENDED',
    entityType: 'Tenant',
    entityId: 'tenant-1',
    performedBy: 'user-1',
    performedByEmail: 'operator@example.com',
    severity: 'critical',
    ipAddress: '203.0.113.4',
    createdAt: '2026-09-08T10:00:00.000Z',
    ...overrides,
  } as AuditLog;
}

function logPage(total: number, rows: AuditLog[]): PaginatedResult<AuditLog> {
  return { data: rows, total, page: 1, limit: 20 } as PaginatedResult<AuditLog>;
}

function renderPage(): { client: QueryClient } {
  // `retry: false` so an assertion about a failure does not wait out the
  // shell's exponential backoff; everything else is the shell's own default.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <AuditLogPage />
      </BrowserRouter>
    </QueryClientProvider>,
  );
  return { client };
}

describe('AuditLogPage on the admin data layer (ADMIN-HIGH-105)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/');
    queryMock.mockResolvedValue(logPage(137, [auditLog()]));
    statsMock.mockResolvedValue({ totalLogs: 137, last24Hours: 4 } as AuditLogStats);
    tenantListMock.mockResolvedValue({
      data: [{ id: 'tenant-1', name: 'Reference Farm' } as Tenant],
      total: 1,
      page: 1,
      limit: 100,
    } as PaginatedResult<Tenant>);
  });

  it('renders logs from the query cache and takes the row count from settled data', async () => {
    renderPage();

    expect(await screen.findByText('operator@example.com')).toBeInTheDocument();
    // 137 is the server's total, reaching the controller only after the query
    // settled — never from inside the fetcher.
    // The header and the pagination footer both render it, so assert on the
    // count rather than on a single node.
    await waitFor(() => expect(screen.getAllByText(/137 records/).length).toBeGreaterThan(0));
  });

  it('forwards the abort signal React Query hands the fetcher', async () => {
    renderPage();

    await waitFor(() => expect(queryMock).toHaveBeenCalled());
    // Second argument is the signal; without it a superseded request runs to
    // completion and decodes into a page that has already moved on.
    expect(queryMock.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);

    await waitFor(() => expect(statsMock).toHaveBeenCalled());
    expect(statsMock.mock.calls[0]?.[3]).toBeInstanceOf(AbortSignal);

    await waitFor(() => expect(tenantListMock).toHaveBeenCalled());
    expect(tenantListMock.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
  });

  it('caches the list under a key carrying the page and every active filter', async () => {
    const { client } = renderPage();

    await waitFor(() => expect(queryMock).toHaveBeenCalled());
    await waitFor(() => {
      const listKeys = client
        .getQueryCache()
        .getAll()
        .map((entry) => entry.queryKey)
        .filter((key) => key[1] === 'security' && key[2] === 'audit');
      expect(listKeys).toHaveLength(1);
      // The params object IS the discriminator — page and limit at minimum, and
      // any active filter alongside them.
      expect(listKeys[0]?.[3]).toMatchObject({ page: '1', limit: '20' });
    });
  });

  it('keys the statistics query on every bound it is filtered by, not just the tenant', async () => {
    const { client } = renderPage();

    await waitFor(() => expect(statsMock).toHaveBeenCalled());
    const statsKey = client
      .getQueryCache()
      .getAll()
      .map((entry) => entry.queryKey)
      .find((key) => key[2] === 'audit-stats');

    // The regression this guards: a key of just the tenant meant a changed date
    // range re-fetched into the same entry and the cards kept the old numbers.
    expect(statsKey?.[3]).toEqual({
      tenantId: undefined,
      startDate: undefined,
      endDate: undefined,
    });
  });

  it('surfaces a failed query as an error state rather than an empty table', async () => {
    queryMock.mockRejectedValue(new Error('audit-logs unavailable'));
    renderPage();

    expect(await screen.findByText('audit-logs unavailable')).toBeInTheDocument();
  });
});
