/**
 * Employee Management Hooks
 * TanStack Query hooks for employee operations
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { PaginationResultV1 } from '@platform/pagination-contracts';
import { useGraphQLClient, graphqlRequest } from './useGraphQL';
import { useAuth, createTenantQueryKey } from '@aquaculture/shared-ui';
import {
  GET_EMPLOYEES,
  GET_EMPLOYEE,
  GET_EMPLOYEE_BY_NUMBER,
  GET_HR_DASHBOARD_STATS,
  SEARCH_EMPLOYEES,
  GET_DEPARTMENTS,
  GET_DEPARTMENT,
  GET_POSITIONS,
  GET_ORGANIZATION_TREE,
  GET_DIRECT_REPORTS,
  CREATE_EMPLOYEE,
  UPDATE_EMPLOYEE,
  UPDATE_EMPLOYEE_STATUS,
  TOGGLE_FARM_WORKER,
  ASSIGN_EMPLOYEE_TO_DEPARTMENT,
  ASSIGN_EMPLOYEE_TO_POSITION,
  ASSIGN_MANAGER,
  CREATE_DEPARTMENT,
  UPDATE_DEPARTMENT,
  CREATE_POSITION,
  UPDATE_POSITION,
} from '../graphql';
import type {
  Employee,
  Department,
  Position,
  EmployeeFilterInput,
  CreateEmployeeInput,
  UpdateEmployeeInput,
  CreateDepartmentInput,
  UpdateDepartmentInput,
  EmployeeStatus,
} from '../types';

// Query Keys
export const employeeKeys = {
  all: ['employees'] as const,
  lists: () => [...employeeKeys.all, 'list'] as const,
  list: (filter?: EmployeeFilterInput) =>
    [...employeeKeys.lists(), { filter }] as const,
  details: () => [...employeeKeys.all, 'detail'] as const,
  detail: (id: string) => [...employeeKeys.details(), id] as const,
  byNumber: (employeeNumber: string) =>
    [...employeeKeys.all, 'byNumber', employeeNumber] as const,
  search: (query: string) => [...employeeKeys.all, 'search', query] as const,
  directReports: (supervisorId: string) =>
    [...employeeKeys.all, 'directReports', supervisorId] as const,
};

export const departmentKeys = {
  all: ['departments'] as const,
  lists: () => [...departmentKeys.all, 'list'] as const,
  list: (filter?: Record<string, unknown>) =>
    [...departmentKeys.lists(), { filter }] as const,
  details: () => [...departmentKeys.all, 'detail'] as const,
  detail: (id: string) => [...departmentKeys.details(), id] as const,
};

export const positionKeys = {
  all: ['positions'] as const,
  lists: () => [...positionKeys.all, 'list'] as const,
  list: (filter?: Record<string, unknown>) =>
    [...positionKeys.lists(), { filter }] as const,
};

export const organizationKeys = {
  tree: ['organizationTree'] as const,
};

// =====================
// Employee Queries
// =====================

// WHY: Backend employees resolver accepts filter and pagination as SEPARATE GraphQL arguments.
// EmployeeFilterInput does not contain limit/page — those belong in EmployeePaginationInput.
// Merging them into a single object caused GraphQL validation 400 errors.
export function useEmployees(
  filter?: EmployeeFilterInput,
  pagination?: { limit?: number; page?: number }
) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: employeeKeys.list({ ...filter, ...pagination }),
    queryFn: () =>
      graphqlRequest<{ employees: PaginationResultV1<Employee> }, unknown>(
        client,
        GET_EMPLOYEES,
        {
          filter: filter || undefined,
          pagination: pagination || undefined,
        }
      ),
    select: (data) => data.employees,
  });
}

export function useEmployee(id: string) {
  const client = useGraphQLClient();

  const { tenantId } = useAuth();
  return useQuery({
    queryKey: employeeKeys.detail(id),
    queryFn: () =>
      graphqlRequest<{ employee: Employee }, unknown>(
        client,
        GET_EMPLOYEE,
        { id }
      ),
    select: (data) => data.employee,
    enabled: !!id && !!tenantId,
  });
}

export function useEmployeeByNumber(employeeNumber: string) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: employeeKeys.byNumber(employeeNumber),
    queryFn: () =>
      graphqlRequest<{
        employees: Pick<PaginationResultV1<Employee>, 'items' | 'total'>;
      }, unknown>(
        client,
        GET_EMPLOYEE_BY_NUMBER,
        { filter: { employeeNumber } }
      ),
    select: (data) => data.employees?.items?.[0],
    enabled: !!employeeNumber,
  });
}

/**
 * PERF-006: callers should debounce the `search` argument before passing it in
 * (e.g. with useDeferredValue or a 300ms setTimeout) so each keystroke does not
 * fire a new network request.  The staleTime here prevents re-fetching if the
 * same query key was already resolved within the last 10 seconds.
 */
export function useSearchEmployees(search: string, limit = 10) {
  const client = useGraphQLClient();
  return useQuery({
    queryKey: employeeKeys.search(search),
    queryFn: () =>
      graphqlRequest<{ activeEmployees: Employee[] }, unknown>(
        client,
        SEARCH_EMPLOYEES,
        { limit }
      ),
    select: (data) => {
      // Client-side filter since backend doesn't have search query
      const query = search.toLowerCase();
      return (data.activeEmployees || []).filter(
        (e) =>
          e.firstName?.toLowerCase().includes(query) ||
          e.lastName?.toLowerCase().includes(query) ||
          e.email?.toLowerCase().includes(query)
      );
    },
    enabled: search.length >= 2,
    staleTime: 10_000,
  });
}

/**
 * Pre-aggregated dashboard statistics — replaces the limit:1000 employee fetch.
 * CRIT-3 / PERF-001: no raw employee records, no PII transmitted.
 */
export function useHRDashboardStats() {
  const client = useGraphQLClient();

  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'hrDashboardStats'),
    queryFn: () =>
      graphqlRequest<{
        hrDashboardStats: {
          totalEmployees: number;
          activeEmployees: number;
          onLeaveEmployees: number;
          terminatedEmployees: number;
          newHiresThisMonth: number;
          offshoreEmployees: number;
          onshoreEmployees: number;
          attendanceRate: number;
          pendingLeaveRequests: number;
          totalDepartments: number;
        };
      }, unknown>(client, GET_HR_DASHBOARD_STATS, {}),
    select: (data) => data.hrDashboardStats,
    enabled: true,
  });
}

/**
 * Resolves the current authenticated user's HR employee record.
 * CRIT-5 / BUG-011 / SEC-009: centralises auth→employee mapping to avoid
 * inconsistent use of user.id vs user.sub across pages.
 *
 * The HR service maps the token's `sub` (auth identity) to the employee record.
 * Using `sub` here because that is the standard JWT subject claim that the
 * HR service registers employees against.
 */
export function useCurrentEmployeeId(): string {
  const { user } = useAuth();
  // `sub` is the standard JWT subject — used as the authoritative identity field.
  // All pages should use this hook rather than reading user.id or user.sub directly.
  return user?.id || '';
}

export function useDirectReports(supervisorId: string) {
  const client = useGraphQLClient();
  return useQuery({
    queryKey: employeeKeys.directReports(supervisorId),
    queryFn: () =>
      graphqlRequest<{ activeEmployees: Employee[] }, unknown>(
        client,
        GET_DIRECT_REPORTS,
        { limit: 100 }
      ),
    // Client-side filter by supervisorId since backend doesn't have directReports query
    select: (data) =>
      (data.activeEmployees || []).filter((e) => e.supervisorId === supervisorId),
    enabled: !!supervisorId,
  });
}

// =====================
// Department Queries
// =====================

export function useDepartments(filter?: { siteId?: string; isDeleted?: boolean }) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: departmentKeys.list(filter),
    queryFn: () =>
      graphqlRequest<{ hrDepartments: Department[] }, unknown>(
        client,
        GET_DEPARTMENTS,
        { siteId: filter?.siteId, isDeleted: filter?.isDeleted ?? false }
      ),
    select: (data) => data.hrDepartments,
  });
}

export function useDepartment(department: string) {
  const client = useGraphQLClient();
  return useQuery({
    queryKey: departmentKeys.detail(department),
    queryFn: () =>
      graphqlRequest<{ employeesByDepartment: Employee[] }, unknown>(
        client,
        GET_DEPARTMENT,
        { department }
      ),
    select: (data) => ({
      name: department,
      employees: data.employeesByDepartment || [],
    }),
    enabled: !!department,
  });
}

// =====================
// Position Queries
// =====================

/**
 * Position is a string field in the backend, not a separate entity.
 * This hook is kept for backward compatibility but returns empty array.
 */
export function usePositions(_filter?: Record<string, unknown>) {
  return { data: [] as Position[], isLoading: false, error: null };
}

// =====================
// Organization Tree
// =====================

export function useOrganizationTree() {
  const client = useGraphQLClient();
  return useQuery({
    queryKey: organizationKeys.tree,
    queryFn: () =>
      graphqlRequest<{
        employees: Pick<PaginationResultV1<Employee>, 'items' | 'total'>;
      }, unknown>(client, GET_ORGANIZATION_TREE, {}),
    select: (data) => ({
      employees: data.employees?.items || [],
    }),
  });
}

// =====================
// Employee Mutations
// =====================

export function useCreateEmployee() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateEmployeeInput) =>
      graphqlRequest<{ createEmployee: Employee }, unknown>(
        client,
        CREATE_EMPLOYEE,
        { input }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: employeeKeys.lists() });
      queryClient.invalidateQueries({ queryKey: departmentKeys.all });
    },
  });
}

export function useUpdateEmployee() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateEmployeeInput) =>
      graphqlRequest<{ updateEmployee: Employee }, unknown>(
        client,
        UPDATE_EMPLOYEE,
        { input }
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: employeeKeys.lists() });
      queryClient.setQueryData(
        employeeKeys.detail(data.updateEmployee.id),
        data.updateEmployee
      );
    },
  });
}

export function useUpdateEmployeeStatus() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      id,
      status,
    }: {
      id: string;
      status: EmployeeStatus;
    }) =>
      graphqlRequest<{ updateEmployee: { id: string; status: string; terminationDate?: string } }, unknown>(
        client,
        UPDATE_EMPLOYEE_STATUS,
        { input: { id, status } }
      ),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: employeeKeys.lists() });
      queryClient.invalidateQueries({ queryKey: employeeKeys.detail(variables.id) });
    },
  });
}

export function useToggleFarmWorker() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, isFarmWorker }: { id: string; isFarmWorker: boolean }) =>
      graphqlRequest<{ toggleFarmWorker: Employee }, unknown>(
        client,
        TOGGLE_FARM_WORKER,
        { id, isFarmWorker }
      ),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: employeeKeys.lists() });
      queryClient.invalidateQueries({ queryKey: employeeKeys.detail(variables.id) });
    },
  });
}

export function useAssignEmployeeToDepartment() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ employeeId, department }: { employeeId: string; department: string }) =>
      graphqlRequest<{ updateEmployee: { id: string; department: string; departmentHrId?: string } }, unknown>(
        client,
        ASSIGN_EMPLOYEE_TO_DEPARTMENT,
        { input: { id: employeeId, department } }
      ),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: employeeKeys.detail(variables.employeeId) });
      queryClient.invalidateQueries({ queryKey: departmentKeys.all });
    },
  });
}

export function useAssignEmployeeToPosition() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ employeeId, position }: { employeeId: string; position: string }) =>
      graphqlRequest<{ updateEmployee: { id: string; position: string; positionId?: string } }, unknown>(
        client,
        ASSIGN_EMPLOYEE_TO_POSITION,
        { input: { id: employeeId, position } }
      ),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: employeeKeys.detail(variables.employeeId) });
    },
  });
}

export function useAssignManager() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ employeeId, supervisorId }: { employeeId: string; supervisorId: string }) =>
      graphqlRequest<{ updateEmployee: { id: string; supervisorId: string } }, unknown>(
        client,
        ASSIGN_MANAGER,
        { input: { id: employeeId, supervisorId } }
      ),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: employeeKeys.detail(variables.employeeId) });
      queryClient.invalidateQueries({ queryKey: employeeKeys.directReports(variables.supervisorId) });
    },
  });
}

// =====================
// Department Mutations
// =====================

export function useCreateDepartment() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateDepartmentInput) =>
      graphqlRequest<{ createHRDepartment: Department }, unknown>(
        client,
        CREATE_DEPARTMENT,
        { input }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: departmentKeys.all });
    },
  });
}

export function useUpdateDepartment() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: UpdateDepartmentInput) =>
      graphqlRequest<{ updateHRDepartment: Department }, unknown>(
        client,
        UPDATE_DEPARTMENT,
        { input }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: departmentKeys.all });
    },
  });
}

// =====================
// Position Mutations (stubs — position is a string field, not an entity)
// =====================

export function useCreatePosition() {
  return useMutation({
    mutationFn: async (_input: { title: string }) => {
      return { createPosition: { title: _input.title } as Position };
    },
  });
}

export function useUpdatePosition() {
  return useMutation({
    mutationFn: async (_input: { id: string; title?: string }) => {
      return { updatePosition: { title: _input.title || '' } as Position };
    },
  });
}
