import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  token: 'token-a' as string | null,
  tenantId: 'tenant-A' as string | null,
}));
const graphqlRequestMock = vi.hoisted(() => vi.fn());
const logErrorMock = vi.hoisted(() => vi.fn());

vi.mock('../../../../../shared-ui/src/hooks/useAuth', () => ({
  useAuth: () => ({ token: auth.token, tenantId: auth.tenantId }),
}));

vi.mock('@aquaculture/shared-ui', async () => {
  const actual =
    await vi.importActual<typeof import('@aquaculture/shared-ui')>('@aquaculture/shared-ui');
  const { useTenantQuery } = await import('../../../../../shared-ui/src/hooks/useTenantQuery');

  return {
    ...actual,
    useAuth: () => ({ token: auth.token, tenantId: auth.tenantId }),
    useTenantQuery,
  };
});

vi.mock('../../services/tenant-api.service', () => ({
  graphqlRequest: graphqlRequestMock,
}));

vi.mock('../../utils/error-handling', () => ({
  logError: logErrorMock,
}));

import { bumpSessionEpoch } from '../../../../../shared-ui/src/utils/session-epoch';
import { auditLogKeys, useTenantAuditLog, type AuditLogPage } from '../useTenantAuditLog';

function createAuditPage(label: string): AuditLogPage {
  return {
    total: 1,
    data: [
      {
        id: `${label}-id`,
        performedBy: `${label}-user`,
        performedByEmail: `${label}@example.test`,
        action: `${label}-action`,
        entityType: 'farm',
        entityId: `${label}-farm`,
        details: { private: label },
        severity: 'info',
        ipAddress: '192.0.2.1',
        userAgent: 'test',
        createdAt: '2026-08-01T00:00:00.000Z',
      },
    ],
  };
}

function pendingAuditPage(): Promise<{ tenantAuditLogs: AuditLogPage }> {
  return new Promise(() => undefined);
}

function makeWrapper(client: QueryClient) {
  return function AuditLogQueryWrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client }, children);
  };
}

describe('useTenantAuditLog tenant-session boundary', () => {
  let queryClient: QueryClient;
  const createObjectUrlMock = vi.fn(() => 'blob:audit-log');
  const revokeObjectUrlMock = vi.fn();

  beforeEach(() => {
    auth.token = 'token-a';
    auth.tenantId = 'tenant-A';
    graphqlRequestMock.mockReset();
    logErrorMock.mockReset();
    createObjectUrlMock.mockClear();
    revokeObjectUrlMock.mockClear();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectUrlMock,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectUrlMock,
    });
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
  });

  afterEach(() => {
    queryClient.clear();
  });

  it('clears tenant A rows and disables CSV export immediately on an A to B transition', async () => {
    graphqlRequestMock
      .mockResolvedValueOnce({ tenantAuditLogs: createAuditPage('tenant-a') })
      .mockImplementationOnce(pendingAuditPage);
    const rendered = renderHook(() => useTenantAuditLog(), {
      wrapper: makeWrapper(queryClient),
    });

    await waitFor(() => expect(rendered.result.current.entries[0]?.id).toBe('tenant-a-id'));

    auth.tenantId = 'tenant-B';
    rendered.rerender();

    expect(rendered.result.current.entries).toEqual([]);
    expect(rendered.result.current.total).toBe(0);
    rendered.result.current.exportCsv();
    expect(createObjectUrlMock).not.toHaveBeenCalled();
    await waitFor(() => expect(graphqlRequestMock).toHaveBeenCalledTimes(2));
  });

  it('clears private rows on logout and does not dispatch an anonymous fetch', async () => {
    graphqlRequestMock.mockResolvedValueOnce({ tenantAuditLogs: createAuditPage('tenant-a') });
    const rendered = renderHook(() => useTenantAuditLog(), {
      wrapper: makeWrapper(queryClient),
    });

    await waitFor(() => expect(rendered.result.current.entries).toHaveLength(1));

    auth.token = null;
    auth.tenantId = null;
    rendered.rerender();

    expect(rendered.result.current.entries).toEqual([]);
    rendered.result.current.exportCsv();
    expect(createObjectUrlMock).not.toHaveBeenCalled();
    expect(graphqlRequestMock).toHaveBeenCalledTimes(1);
  });

  it('clears prior-principal rows when only the session epoch changes', async () => {
    graphqlRequestMock
      .mockResolvedValueOnce({ tenantAuditLogs: createAuditPage('previous-session') })
      .mockImplementationOnce(pendingAuditPage);
    const rendered = renderHook(() => useTenantAuditLog(), {
      wrapper: makeWrapper(queryClient),
    });

    await waitFor(() => expect(rendered.result.current.entries[0]?.id).toBe('previous-session-id'));

    bumpSessionEpoch();
    rendered.rerender();

    expect(rendered.result.current.entries).toEqual([]);
    expect(rendered.result.current.total).toBe(0);
    rendered.result.current.exportCsv();
    expect(createObjectUrlMock).not.toHaveBeenCalled();
    await waitFor(() => expect(graphqlRequestMock).toHaveBeenCalledTimes(2));
  });

  it('keeps the last successful page while pagination changes within one session', async () => {
    graphqlRequestMock
      .mockResolvedValueOnce({ tenantAuditLogs: createAuditPage('page-one') })
      .mockImplementationOnce(pendingAuditPage);
    const rendered = renderHook(() => useTenantAuditLog(), {
      wrapper: makeWrapper(queryClient),
    });

    await waitFor(() => expect(rendered.result.current.entries[0]?.id).toBe('page-one-id'));

    act(() => rendered.result.current.nextPage());

    expect(rendered.result.current.page).toBe(2);
    expect(rendered.result.current.entries[0]?.id).toBe('page-one-id');
    expect(rendered.result.current.isFetching).toBe(true);
    await waitFor(() => expect(graphqlRequestMock).toHaveBeenCalledTimes(2));
  });

  it('refreshes with the active tenant epoch-less invalidation prefix', async () => {
    graphqlRequestMock
      .mockResolvedValueOnce({ tenantAuditLogs: createAuditPage('first') })
      .mockResolvedValueOnce({ tenantAuditLogs: createAuditPage('refreshed') });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const rendered = renderHook(() => useTenantAuditLog(), {
      wrapper: makeWrapper(queryClient),
    });

    await waitFor(() => expect(rendered.result.current.entries[0]?.id).toBe('first-id'));
    await act(async () => await rendered.result.current.refresh());

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: auditLogKeys.all('tenant-A'),
    });
    expect(auditLogKeys.all('tenant-A')).toEqual(['tenant', 'tenant-A', 'tenant-audit-log']);
    await waitFor(() => expect(rendered.result.current.entries[0]?.id).toBe('refreshed-id'));
  });
});
