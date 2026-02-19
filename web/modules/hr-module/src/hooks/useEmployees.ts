/**
 * Employee Management Hooks
 * TanStack Query hooks for employee operations
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useGraphQLClient, graphqlRequest } from './useGraphQL';
import { useAuth } from '@aquaculture/shared-ui';
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
  EmployeeStatus,
  PaginationInput,
  PaginatedResponse,
} from '../types';

// Query Keys
export const employeeKeys = {
  all: ['employees'] as const,
  lists: () => [...employeeKeys.all, 'list'] as const,
  list: (filter?: EmployeeFilterInput, pagination?: PaginationInput) =>
    [...employeeKeys.lists(), { filter, pagination }] as const,
  details: () => [...employeeKeys.all, 'detail'] as const,
  detail: (id: string) => [...employeeKeys.details(), id] as const,
  byNumber: (employeeNumber: string) =>
    [...employeeKeys.all, 'byNumber', employeeNumber] as const,
  search: (query: string) => [...employeeKeys.all, 'search', query] as const,
  directReports: (managerId: string) =>
    [...employeeKeys.all, 'directReports', managerId] as const,
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

export function useEmployees(
  filter?: EmployeeFilterInput,
  pagination?: PaginationInput
) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: employeeKeys.list(filter, pagination),
    queryFn: () =>
      graphqlRequest<{ employees: PaginatedResponse<Employee> }, unknown>(
        client,
        GET_EMPLOYEES,
        { filter, pagination }
      ),
    select: (data) => data.employees,
  });
}

export function useEmployee(id: string) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: employeeKeys.detail(id),
    queryFn: () =>
      graphqlRequest<{ employee: Employee }, unknown>(
        client,
        GET_EMPLOYEE,
        { id }
      ),
    select: (data) => data.employee,
    enabled: !!id,
  });
}

export function useEmployeeByNumber(employeeNumber: string) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: employeeKeys.byNumber(employeeNumber),
    queryFn: () =>
      graphqlRequest<{ employeeByNumber: Employee }, unknown>(
        client,
        GET_EMPLOYEE_BY_NUMBER,
        { employeeNumber }
      ),
    select: (data) => data.employeeByNumber,
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
      graphqlRequest<{ searchEmployees: Employee[] }, unknown>(
        client,
        SEARCH_EMPLOYEES,
        { search, limit }
      ),
    select: (data) => data.searchEmployees,
    enabled: search.length >= 2,
    staleTime: 10_000, // avoid re-fetching the same query within 10s
  });
}

/**
 * Pre-aggregated dashboard statistics — replaces the limit:1000 employee fetch.
 * CRIT-3 / PERF-001: no raw employee records, no PII transmitted.
 */
export function useHRDashboardStats() {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: ['hrDashboardStats'],
    queryFn: () =>
      graphqlRequest<{
        hrDashboardStats: {
          totalEmployees: number;
          activeEmployees: number;
          onLeaveCount: number;
          offshoreCount: number;
          onshoreCount: number;
          seaWorthyCount: number;
          departmentCount: number;
        };
      }, unknown>(client, GET_HR_DASHBOARD_STATS, {}),
    select: (data) => data.hrDashboardStats,
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
  return user?.sub || user?.id || '';
}

export function useDirectReports(managerId: string) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: employeeKeys.directReports(managerId),
    queryFn: () =>
      graphqlRequest<{ directReports: Employee[] }, unknown>(
        client,
        GET_DIRECT_REPORTS,
        { managerId }
      ),
    select: (data) => data.directReports,
    enabled: !!managerId,
  });
}

// =====================
// Department Queries
// =====================

export function useDepartments(filter?: Record<string, unknown>) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: departmentKeys.list(filter),
    queryFn: () =>
      graphqlRequest<{ departments: Department[] }, unknown>(
        client,
        GET_DEPARTMENTS,
        { filter }
      ),
    select: (data) => data.departments,
  });
}

export function useDepartment(id: string) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: departmentKeys.detail(id),
    queryFn: () =>
      graphqlRequest<{ department: Department & { employees: Employee[] } }, unknown>(
        client,
        GET_DEPARTMENT,
        { id }
      ),
    select: (data) => data.department,
    enabled: !!id,
  });
}

// =====================
// Position Queries
// =====================

export function usePositions(filter?: Record<string, unknown>) {
  const client = useGraphQLClient();

  return useQuery({
    queryKey: positionKeys.list(filter),
    queryFn: () =>
      graphqlRequest<{ positions: Position[] }, unknown>(
        client,
        GET_POSITIONS,
        { filter }
      ),
    select: (data) => data.positions,
  });
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
        organizationTree: {
          departments: Department[];
          employees: Employee[];
        };
      }, unknown>(client, GET_ORGANIZATION_TREE, {}),
    select: (data) => data.organizationTree,
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
      reason,
    }: {
      id: string;
      status: EmployeeStatus;
      reason?: string;
    }) =>
      graphqlRequest<{ updateEmployeeStatus: Employee }, unknown>(
        client,
        UPDATE_EMPLOYEE_STATUS,
        { id, status, reason }
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
    mutationFn: ({ employeeId, departmentId }: { employeeId: string; departmentId: string }) =>
      graphqlRequest<{ assignEmployeeToDepartment: Employee }, unknown>(
        client,
        ASSIGN_EMPLOYEE_TO_DEPARTMENT,
        { employeeId, departmentId }
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
    mutationFn: ({ employeeId, positionId }: { employeeId: string; positionId: string }) =>
      graphqlRequest<{ assignEmployeeToPosition: Employee }, unknown>(
        client,
        ASSIGN_EMPLOYEE_TO_POSITION,
        { employeeId, positionId }
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
    mutationFn: ({ employeeId, managerId }: { employeeId: string; managerId: string }) =>
      graphqlRequest<{ assignManager: Employee }, unknown>(
        client,
        ASSIGN_MANAGER,
        { employeeId, managerId }
      ),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: employeeKeys.detail(variables.employeeId) });
      queryClient.invalidateQueries({ queryKey: employeeKeys.directReports(variables.managerId) });
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
    mutationFn: (input: { code: string; name: string; description?: string; managerId?: string; parentDepartmentId?: string; colorCode?: string }) =>
      graphqlRequest<{ createDepartment: Department }, unknown>(
        client,
        CREATE_DEPARTMENT,
        { input }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: departmentKeys.all });
      queryClient.invalidateQueries({ queryKey: organizationKeys.tree });
    },
  });
}

export function useUpdateDepartment() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { id: string; name?: string; description?: string; managerId?: string; colorCode?: string; isActive?: boolean }) =>
      graphqlRequest<{ updateDepartment: Department }, unknown>(
        client,
        UPDATE_DEPARTMENT,
        { input }
      ),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: departmentKeys.all });
      queryClient.setQueryData(
        departmentKeys.detail(data.updateDepartment.id),
        data.updateDepartment
      );
    },
  });
}

// =====================
// Position Mutations
// =====================

export function useCreatePosition() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { code: string; title: string; description?: string; departmentId?: string; minSalary?: number; maxSalary?: number }) =>
      graphqlRequest<{ createPosition: Position }, unknown>(
        client,
        CREATE_POSITION,
        { input }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: positionKeys.all });
    },
  });
}

export function useUpdatePosition() {
  const client = useGraphQLClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { id: string; title?: string; description?: string; minSalary?: number; maxSalary?: number; isActive?: boolean }) =>
      graphqlRequest<{ updatePosition: Position }, unknown>(
        client,
        UPDATE_POSITION,
        { input }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: positionKeys.all });
    },
  });
}
