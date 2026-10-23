/**
 * useOrganizationChart — the chart's data: the departments of the reader's
 * workspace, each with the head count and manager name the server derived.
 *
 * The browser reads no roster to add people up. The module scope reaches the
 * request and the cache key (so two workspaces share no entry); the people placed
 * in no department are asked for only in the Company view; and the cache key sits
 * under `departmentKeys.all` so department and employee mutations refresh it.
 */
import { WorkforceScopeProvider, createTenantInvalidationKey } from '@aquaculture/shared-ui';
import type { HrModuleCode } from '@platform/shared-ui/generated/graphql-types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GET_HR_DASHBOARD_STATS, GET_ORGANIZATION_DEPARTMENTS } from '../../graphql';
import type { OrganizationDepartment } from '../../types';
import { departmentKeys } from '../useEmployees';
import { useOrganizationChart } from '../useOrganizationChart';

const mocks = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock('../useGraphQL', () => ({
  useGraphQLClient: () => ({ client: true }),
  graphqlRequest: mocks.request,
}));

// WHY: useTenantQuery reads the session through shared-ui's own useAuth module, so the
// session is faked at that module — a partial mock of the package index cannot reach it.
vi.mock('@shared-ui/hooks/useAuth', () => ({
  useAuth: () => ({ token: 'token', tenantId: 'tenant-1', user: null }),
}));

const operations: OrganizationDepartment = {
  id: 'dept-ops',
  name: 'Operations',
  code: 'OPS',
  moduleCode: 'FARM',
  managerId: 'emp-1',
  managerName: 'Ada Lovelace',
  headCount: 240,
  isActive: true,
  sortOrder: 1,
};

function serve({ unplaced = 0 }: { unplaced?: number } = {}): void {
  mocks.request.mockImplementation(async (_client: unknown, document: unknown) => {
    if (document === GET_ORGANIZATION_DEPARTMENTS) return { hrDepartments: [operations] };
    if (document === GET_HR_DASHBOARD_STATS) {
      return { hrDashboardStats: { unplacedEmployees: unplaced } };
    }
    throw new Error('unexpected document');
  });
}

function requestsFor(document: unknown): unknown[][] {
  return mocks.request.mock.calls.filter(([, requested]) => requested === document);
}

function inWorkspace(moduleCode: HrModuleCode | null): {
  queryClient: QueryClient;
  wrapper: (props: { children: ReactNode }) => ReactNode;
} {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    queryClient,
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>
        <WorkforceScopeProvider moduleCode={moduleCode}>{children}</WorkforceScopeProvider>
      </QueryClientProvider>
    ),
  };
}

describe('useOrganizationChart', () => {
  beforeEach(() => {
    mocks.request.mockReset();
  });

  it("draws the server's head counts and manager names, reading no roster", async () => {
    serve();
    const { wrapper } = inWorkspace(null);

    const { result } = renderHook(() => useOrganizationChart(), { wrapper });
    await waitFor(() => expect(result.current.tree).toBeDefined());

    const node = result.current.tree?.roots[0];
    expect(node?.directHeadCount).toBe(240);
    expect(node?.manager).toEqual({ id: 'emp-1', name: 'Ada Lovelace' });
    expect(requestsFor(GET_ORGANIZATION_DEPARTMENTS)).toHaveLength(1);
  });

  it('asks for the people placed in no department in the Company view', async () => {
    serve({ unplaced: 10 });
    const { wrapper } = inWorkspace(null);

    const { result } = renderHook(() => useOrganizationChart(), { wrapper });
    await waitFor(() => expect(result.current.unplacedHeadCount).toBe(10));

    expect(requestsFor(GET_HR_DASHBOARD_STATS)).toHaveLength(1);
  });

  it('does not ask for them inside a module workspace, which holds only placed people', async () => {
    serve({ unplaced: 10 });
    const { wrapper } = inWorkspace('FARM');

    const { result } = renderHook(() => useOrganizationChart(), { wrapper });
    await waitFor(() => expect(result.current.tree).toBeDefined());

    expect(requestsFor(GET_HR_DASHBOARD_STATS)).toHaveLength(0);
    expect(result.current.unplacedHeadCount).toBe(0);
    expect(result.current.isLoading).toBe(false);
  });

  it('asks for the workspace module in the request and in the cache key', async () => {
    serve();
    const { queryClient, wrapper } = inWorkspace('FARM');

    const { result } = renderHook(() => useOrganizationChart(), { wrapper });
    await waitFor(() => expect(result.current.tree).toBeDefined());

    expect(requestsFor(GET_ORGANIZATION_DEPARTMENTS)[0]?.[2]).toEqual({ moduleCode: 'FARM' });
    const keys = queryClient
      .getQueryCache()
      .findAll({
        queryKey: createTenantInvalidationKey('tenant-1', ...departmentKeys.all),
      })
      .map((query) => query.queryKey);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContainEqual({ moduleCode: 'FARM' });
  });

  it('shares no cache entry between two workspaces', async () => {
    serve();
    const farm = inWorkspace('FARM');
    const companyWrapper = ({ children }: { children: ReactNode }): ReactNode => (
      <QueryClientProvider client={farm.queryClient}>
        <WorkforceScopeProvider moduleCode={null}>{children}</WorkforceScopeProvider>
      </QueryClientProvider>
    );

    // Same client, two scopes: the Company render must not reuse the Production chart.
    const production = renderHook(() => useOrganizationChart(), { wrapper: farm.wrapper });
    await waitFor(() => expect(production.result.current.tree).toBeDefined());
    const company = renderHook(() => useOrganizationChart(), { wrapper: companyWrapper });
    await waitFor(() => expect(company.result.current.tree).toBeDefined());

    expect(requestsFor(GET_ORGANIZATION_DEPARTMENTS).map(([, , variables]) => variables)).toEqual([
      { moduleCode: 'FARM' },
      { moduleCode: undefined },
    ]);
  });

  it('reports a failed request instead of drawing a partial chart', async () => {
    mocks.request.mockImplementation(async (_client: unknown, document: unknown) => {
      if (document === GET_HR_DASHBOARD_STATS)
        return { hrDashboardStats: { unplacedEmployees: 0 } };
      throw new Error('departments unavailable');
    });
    const { wrapper } = inWorkspace(null);

    const { result } = renderHook(() => useOrganizationChart(), { wrapper });
    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));

    expect(result.current.error?.message).toBe('departments unavailable');
    expect(result.current.tree).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
  });
});
