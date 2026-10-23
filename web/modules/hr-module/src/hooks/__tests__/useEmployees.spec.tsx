/**
 * useEmployees / useDepartments — the module scope of the reader reaches both the
 * request and the cache key.
 *
 * A module workspace (Production, Greenhouse, Control & sensors) lists that
 * module's people and departments; the Company workspace lists everyone. The
 * scope is resolved ONCE per hook (useModuleScope) and that one value is sent as
 * `moduleCode` and put in the tenant-scoped query key, so two workspaces can never
 * share a cache entry and the mutation invalidations still find the lists.
 */
import { WorkforceScopeProvider, createTenantInvalidationKey } from '@aquaculture/shared-ui';
import type { HrModuleCode } from '@platform/shared-ui/generated/graphql-types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GET_DEPARTMENTS, GET_EMPLOYEES } from '../../graphql';
import { attendanceKeys } from '../useAttendance';
import {
  departmentKeys,
  employeeKeys,
  useAssignEmployeeToDepartment,
  useCreateDepartment,
  useCreateEmployee,
  useDepartments,
  useEmployees,
  useUpdateDepartment,
  useUpdateEmployee,
  useUpdateEmployeeStatus,
} from '../useEmployees';
import { leaveKeys } from '../useLeaves';
import { schedulingKeys } from '../useScheduling';

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

vi.mock('@aquaculture/shared-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aquaculture/shared-ui')>();
  const { useMutation } = await import('@tanstack/react-query');
  return {
    ...actual,
    // The toast provider is not under test; the wrapper only forwards to useMutation.
    useFeedbackMutation: ({
      feedback: _feedback,
      ...options
    }: Parameters<typeof useMutation>[0] & { feedback: unknown }) => useMutation(options),
  };
});

interface Harness {
  queryClient: QueryClient;
  wrapper: (props: { children: ReactNode }) => ReactNode;
}

function inWorkspace(moduleCode: HrModuleCode | null): Harness {
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

/** The variables of the most recent request that ran `document`. */
function lastVariables(document: unknown): Record<string, unknown> {
  const call = [...mocks.request.mock.calls].reverse().find(([, doc]) => doc === document);
  if (!call) throw new Error('the document was never requested');
  return call[2];
}

describe('hr hooks module scope', () => {
  beforeEach(() => {
    mocks.request.mockReset();
    mocks.request.mockImplementation(async (_client: unknown, document: unknown) =>
      document === GET_DEPARTMENTS ? { hrDepartments: [] } : { employees: { items: [], total: 0 } },
    );
  });

  describe('useEmployees', () => {
    it("shows nothing — not the previous workspace's people — while another workspace loads", async () => {
      let scope: HrModuleCode | null = 'FARM';
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const wrapper = ({ children }: { children: ReactNode }): ReactNode => (
        <QueryClientProvider client={queryClient}>
          <WorkforceScopeProvider moduleCode={scope}>{children}</WorkforceScopeProvider>
        </QueryClientProvider>
      );
      mocks.request.mockResolvedValueOnce({
        employees: { items: [{ id: 'farm-person' }], total: 1 },
      });
      const { result, rerender } = renderHook(() => useEmployees(), { wrapper });
      await waitFor(() => expect(result.current.data?.items).toHaveLength(1));

      // The Greenhouse request never settles during this assertion.
      mocks.request.mockImplementationOnce(() => new Promise(() => undefined));
      scope = 'HYDROPONICS';
      rerender();

      await waitFor(() => expect(result.current.isFetching).toBe(true));
      expect(result.current.data).toBeUndefined();
    });

    it('lists the workspace module when the caller names none', async () => {
      const { wrapper } = inWorkspace('FARM');
      const { result } = renderHook(
        () => useEmployees({ seaWorthy: true }, { limit: 20, page: 1 }),
        { wrapper },
      );

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(lastVariables(GET_EMPLOYEES)).toEqual({
        filter: { seaWorthy: true, moduleCode: 'FARM' },
        pagination: { limit: 20, page: 1 },
      });
    });

    it('lists every module in the Company workspace', async () => {
      const { wrapper } = inWorkspace(null);
      const { result } = renderHook(() => useEmployees(), { wrapper });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(lastVariables(GET_EMPLOYEES).filter).toEqual({ moduleCode: undefined });
    });

    it('lets a caller narrow to one module explicitly', async () => {
      const { wrapper } = inWorkspace(null);
      const { result } = renderHook(() => useEmployees({ moduleCode: 'SENSOR' }), { wrapper });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(lastVariables(GET_EMPLOYEES).filter).toEqual({ moduleCode: 'SENSOR' });
    });

    it('keys the cache by tenant and module, so two workspaces never share an entry', async () => {
      const farm = inWorkspace('FARM');
      const company = inWorkspace(null);
      renderHook(() => useEmployees(), { wrapper: farm.wrapper });
      renderHook(() => useEmployees(), { wrapper: company.wrapper });

      await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2));

      const [farmKey] = farm.queryClient
        .getQueryCache()
        .getAll()
        .map((query) => query.queryKey);
      const [companyKey] = company.queryClient
        .getQueryCache()
        .getAll()
        .map((query) => query.queryKey);
      expect(farmKey?.slice(0, 2)).toEqual(['tenant', 'tenant-1']);
      expect(JSON.stringify(farmKey)).toContain('"moduleCode":"FARM"');
      expect(JSON.stringify(companyKey)).not.toContain('FARM');
    });
  });

  describe('useDepartments', () => {
    it('lists the workspace module as the moduleCode variable', async () => {
      const { wrapper } = inWorkspace('HYDROPONICS');
      const { result } = renderHook(() => useDepartments(), { wrapper });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(lastVariables(GET_DEPARTMENTS)).toEqual({
        siteId: undefined,
        isDeleted: false,
        moduleCode: 'HYDROPONICS',
      });
    });

    it('lists every department in the Company workspace and lets a caller narrow explicitly', async () => {
      const { wrapper } = inWorkspace(null);
      const all = renderHook(() => useDepartments(), { wrapper });
      await waitFor(() => expect(all.result.current.isSuccess).toBe(true));
      expect(lastVariables(GET_DEPARTMENTS).moduleCode).toBeUndefined();

      const narrowed = renderHook(() => useDepartments({ moduleCode: 'FARM' }), { wrapper });
      await waitFor(() => expect(narrowed.result.current.isSuccess).toBe(true));
      expect(lastVariables(GET_DEPARTMENTS).moduleCode).toBe('FARM');
    });
  });

  describe('mutations', () => {
    it('refetch the department lists of the same tenant after a department is created', async () => {
      const { wrapper } = inWorkspace('FARM');
      const { result } = renderHook(
        () => ({ list: useDepartments(), create: useCreateDepartment() }),
        { wrapper },
      );
      await waitFor(() => expect(result.current.list.isSuccess).toBe(true));
      mocks.request.mockClear();

      await act(async () => {
        await result.current.create.mutateAsync({
          name: 'Feeding',
          code: 'FEED',
          moduleCode: 'FARM',
        });
      });

      await waitFor(() =>
        expect(mocks.request.mock.calls.filter(([, doc]) => doc === GET_DEPARTMENTS)).toHaveLength(
          1,
        ),
      );
    });

    it('places an employee by departmentHrId, and null removes the placement', async () => {
      const { wrapper } = inWorkspace(null);
      const { result } = renderHook(() => useAssignEmployeeToDepartment(), { wrapper });

      await act(async () => {
        await result.current.mutateAsync({ employeeId: 'emp-1', departmentHrId: null });
      });

      const [, , variables] = mocks.request.mock.calls[0] ?? [];
      expect(variables).toEqual({ input: { id: 'emp-1', departmentHrId: null } });
    });
  });

  describe('what a change refreshes', () => {
    // WHY: a placement, hire, status change or department edit changes who stands in
    // each module's Team areas, each department's head count and the tenant-wide
    // statistics — not only the employee list.
    const refreshed = [
      employeeKeys.all,
      departmentKeys.all,
      ['hrDashboardStats'],
      attendanceKeys.all,
      leaveKeys.all,
      schedulingKeys.all,
    ];

    it.each([
      ['hiring an employee', () => useCreateEmployee(), { firstName: 'Ada' }],
      ['editing an employee', () => useUpdateEmployee(), { id: 'emp-1' }],
      [
        'changing an employee status',
        () => useUpdateEmployeeStatus(),
        { id: 'emp-1', status: 'terminated' },
      ],
      [
        'placing an employee in a department',
        () => useAssignEmployeeToDepartment(),
        { employeeId: 'emp-1', departmentHrId: 'dep-1' },
      ],
      ['creating a department', () => useCreateDepartment(), { name: 'Feeding', code: 'FEED' }],
      [
        'moving a department to another module',
        () => useUpdateDepartment(),
        { id: 'dep-1', moduleCode: 'FARM' },
      ],
    ] as const)('%s refreshes every read it can change', async (_what, useMutationHook, input) => {
      mocks.request.mockResolvedValue({
        createEmployee: { id: 'emp-1' },
        updateEmployee: { id: 'emp-1' },
      });
      const { queryClient, wrapper } = inWorkspace(null);
      const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
      const { result } = renderHook(
        () => useMutationHook() as { mutateAsync: (variables: unknown) => Promise<unknown> },
        { wrapper },
      );

      await act(async () => {
        await result.current.mutateAsync(input);
      });

      const invalidated = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
      for (const prefix of refreshed) {
        expect(invalidated).toContainEqual(createTenantInvalidationKey('tenant-1', ...prefix));
      }
    });
  });
});
